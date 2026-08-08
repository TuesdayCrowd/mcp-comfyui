import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { EnvelopeParseError } from "./comfy/envelope.ts";
import { ComfyCliError, ComfyTimeoutError, ComfyUnavailableError } from "./comfy/exec.ts";
import {
  InstanceUnavailableError,
  LaunchArgumentError,
  LaunchFailedError,
  LaunchTimeoutError,
  RemoteLaunchRefusedError,
} from "./comfy/instance.ts";
import { JobPayloadError } from "./comfy/jobs.ts";
import { ObjectInfoCacheWriteError, ObjectInfoFetchError } from "./comfy/objectInfo.ts";
import { TemplatesPayloadError } from "./comfy/templates.ts";
import { UserdataError } from "./comfy/userdata.ts";
import {
  HostNotLocalError,
  RegistryInvalidError,
  RemoteHostUnavailableError,
  UnknownHostError,
} from "./hosts.ts";
import { JobHostUnknownError } from "./jobLedger.ts";
import type { InertUpstream } from "./workflows/discover.ts";
import { RunContractError, RunFailedError, type RunEvent } from "./workflows/run.ts";
import { SetSlotContractError, SlotValueError, WorkflowFileError } from "./workflows/setSlots.ts";
import { SlotListingParseError } from "./workflows/slots.ts";

/**
 * How a tool answers.
 *
 * Every tool in this server returns JSON in a single text block, and every
 * failure returns *structured* JSON rather than a bare sentence. That second
 * half is the whole reason this module exists.
 *
 * ## Why the errors are classified here rather than left to throw
 *
 * The SDK's own fallback for a handler that throws is
 * `{content:[{type:"text",text:error.message}], isError:true}` — the message and
 * nothing else. Every one of this codebase's error types carries fields a caller
 * can act on and that `.message` does not have: `ComfyCliError.code` is drawn
 * from an append-only registry a model can branch on, `RunFailedError.events`
 * carries the server's traceback, `ObjectInfoFetchError.cachePath` names the
 * file an operator can inspect. Letting them throw discards all of it.
 *
 * ## Why this is not the blanket catch it superficially resembles
 *
 * {@link toolFailure} does catch everything, because a tool that crashes the
 * transport is worse than one that reports a fault. What it does *not* do is
 * flatten: the classification below is a table of `instanceof` arms, each one
 * emitting exactly the fields its own type knows, and the fallback arm is
 * `internal_error` — a distinct kind that says "this server has a bug", not a
 * verdict about the caller's request. Nothing is collapsed into a string.
 *
 * ## Ordering is load-bearing
 *
 * `RunFailedError extends ComfyCliError`, so the specific arm must precede the
 * general one or a failed run silently loses its events and is reported under
 * the wrong kind. Same for `EnvelopeParseError`, which several contract errors
 * carry as a `cause` but which is also thrown in its own right.
 */

/**
 * The vocabulary a caller branches on. Coarser than the error types beneath it
 * on purpose: a model needs to know whether to fix its arguments, retry, tell
 * the user to start ComfyUI, or give up, and those are the distinctions here.
 * Finer detail travels in `code` and in the kind-specific fields.
 */
export type ToolErrorKind =
  /** ComfyUI or the CLI said no, with a code from the append-only registry. */
  | "comfy_cli"
  /** A run executed and failed. A `comfy_cli` failure with the events attached. */
  | "run_failed"
  /** The CLI outlived its budget and was killed. The run itself may go on. */
  | "timeout"
  /** The `comfy` binary could not be started at all — an install problem. */
  | "comfy_unavailable"
  /** The CLI answered with something that is not the contract. Not the caller's fault. */
  | "contract_violation"
  /** The caller's own arguments could not be used. The caller can fix this. */
  | "invalid_input"
  /** No workflow by that name or path. Carries the names that do exist. */
  | "workflow_not_found"
  /**
   * The caller set an address whose value ComfyUI's own graph execution
   * overrides from a link to another node — a decoy `describe_workflow`
   * excludes from its schema for the same reason. The caller can fix this by
   * choosing a different address, so it is caller-actionable like
   * `invalid_input`, but it gets its own kind because the fix is "use a
   * different address, named below" rather than "adjust this value" — and
   * because there may be several offending addresses in one call, not one.
   */
  | "inert_slot"
  /** The workflow file could not be read: missing, unreadable, a directory. */
  | "workflow_file"
  /** `/object_info` could not be read, so no constraints could be recovered. */
  | "object_info_unavailable"
  /** The node definitions were fetched but could not be cached. */
  | "object_info_cache_unwritable"
  /** `comfy launch` ran but no ComfyUI answered inside the budget. */
  | "launch_timeout"
  /**
   * `comfy launch` exited before producing a usable server or a verdict the
   * CLI diagnosed — an uncaught crash, not a timeout. Distinct from
   * `launch_timeout` on purpose: waiting longer would not have helped, since
   * the process was already gone.
   */
  | "launch_failed"
  /**
   * Nothing is answering and this server may not start anything. Distinct from
   * `comfy_cli`, because nothing was attempted and no CLI was consulted — the
   * fix is a configuration choice or a hand-started ComfyUI, not a retry.
   */
  | "comfyui_not_running"
  /** No host by that name. Carries the names that would have worked. */
  | "unknown_host"
  /**
   * A host on another machine is not answering. Distinct from
   * `comfyui_not_running`, whose message offers the two fixes an operator of a
   * *local* instance has; neither applies to a box that is asleep elsewhere.
   */
  | "host_unreachable"
  /**
   * Something only a local address can do was asked of a remote one — a launch,
   * or `auto_launch` in the registry. Not `invalid_input`: the argument is a
   * perfectly good address, and the fix is on the other machine.
   */
  | "host_not_local"
  /** The host registry could not be read, and a named host needed it. */
  | "registry_invalid"
  /** Which ComfyUI a job is on could not be established, and guessing is worse. */
  | "job_host_unknown"
  /**
   * The runtime refused this process a capability it needs. Deno only — Node
   * and Bun have no permission system — and always an operator's to fix, by
   * adding a flag.
   */
  | "permission_denied"
  /** A fault in this server. Reported as such rather than blamed on the caller. */
  | "internal_error";

/**
 * The body of a failed tool result, under an `error` key.
 *
 * Every field is optional except `kind` and `message` because every field is
 * emitted only by the arms that can actually know it — an absent `code` means
 * this failure has no code, not that one was dropped.
 */
export interface ToolErrorBody {
  kind: ToolErrorKind;
  message: string;
  /** The CLI's own error code. Append-only: an unrecognised one is not a fault. */
  code?: string;
  /** The CLI's suggested fix, where it offered one. */
  hint?: string;
  /** The CLI's local-vs-cloud routing target. */
  where?: string;
  /** Whatever structured detail the CLI attached to the failure. */
  details?: unknown;
  /** `run_failed`: the events that explain it, most recent last. */
  events?: RunEvent[];
  /** `run_failed`: whether older events were dropped. */
  events_truncated?: boolean;
  /** `timeout`, `launch_timeout`: the budget that was exceeded, in milliseconds. */
  timeout_ms?: number;
  /** `comfy_unavailable`: the binary path that could not be started. */
  binary?: string;
  /** `invalid_input`: the slot address at fault, when one input of many was. */
  address?: string;
  /** `workflow_file`: the caller's own path, exactly as it was passed. */
  workflow_path?: string;
  /** `workflow_not_found`: the handles `list_workflows` would return. */
  known_workflows?: string[];
  /** `inert_slot`: every address requested that would be silently ignored, and what supplies it instead. */
  inert_addresses?: Array<{ address: string; upstream: InertUpstream | null }>;
  /** `object_info_*`, `launch_timeout`, `launch_failed`: the address or file at fault. */
  url?: string;
  cache_path?: string;
  /** `object_info_unavailable`: the HTTP status, where the request got one. */
  status?: number | null;
  /** `unknown_host`, `job_host_unknown`: every host name that would have worked. */
  known_hosts?: string[];
  /** `unknown_host`, `registry_invalid`: the registry file, so it can be opened. */
  registry_path?: string;
  /** `registry_invalid`: where the parse gave up, when the runtime said. */
  line?: number | null;
  column?: number | null;
  /** `host_not_local`, `host_unreachable`: the address or host name at fault. */
  host?: string;
  /** `job_host_unknown`: the job nobody could place. */
  prompt_id?: string;
  /** `internal_error`: the constructor name, since the kind cannot say. */
  error_name?: string;
}

/**
 * How many of a failed run's events to report.
 *
 * `workflows/run.ts` already caps at 200 and bounds each undeclared field at
 * 8KB, which is the right bound for a *library* result but still admits 200
 * progress lines in front of the one event anybody reads. `execution_error`
 * arrives at the end of the run it explains, so the last few are the diagnosis
 * and everything before them is the sampler counting.
 */
const MAX_REPORTED_EVENTS = 20;

/**
 * No workflow answers to that handle.
 *
 * Raised by this layer rather than by any library module, because resolving a
 * name to a path is a thing only the tool surface does — `list_workflows` is
 * where names come from and nothing below it has ever heard of one.
 */
export class WorkflowNotFoundError extends Error {
  override readonly name = "WorkflowNotFoundError";
  /** Every handle that would have worked, so the fix is in the message. */
  readonly known: string[];

  constructor(requested: string, known: string[]) {
    super(
      `no workflow named ${JSON.stringify(requested)}\n` +
        `Call list_workflows for the handles this server can see, or pass an absolute ` +
        `path to a workflow file. Names are case-sensitive and carry no .json extension.`,
    );
    this.known = known;
  }
}

/**
 * An argument this layer could not use, where the schema could not have said
 * so.
 *
 * `manage_hosts` is the case: `name` is required for four of its five actions
 * and `host` for one, and expressing that in the schema would mean a
 * discriminated union of five shapes — harder for a model to fill in than one
 * flat object, in exchange for a check whose message can simply name the
 * missing field.
 */
export class ToolArgumentError extends Error {
  override readonly name = "ToolArgumentError";
}

/** One address `run_workflow` refused, and what actually supplies its value. */
export interface InertSlotErrorEntry {
  address: string;
  upstream: InertUpstream | null;
}

/**
 * The caller set an address `discover.ts`'s `inertInputsOf` found to be a
 * decoy: ComfyUI's own graph execution feeds that node's input from a link to
 * another node, so the widget `set-slot` writes to is never read once the
 * graph runs.
 *
 * Raised by this layer rather than any library module, on the same reasoning
 * as {@link WorkflowNotFoundError}: refusing the call is a decision only the
 * tool surface makes, and it is made **before anything is spawned** — the
 * measured cost of not catching this is a request for "black metal, 60
 * seconds" silently producing 150 seconds of stock tropical house, with
 * `applied: [...]` reporting success the entire time. A caller who sets even
 * one decoy address gets none of their edits applied: this server cannot know
 * which of several requested addresses the caller would still want set once
 * they learn one of them does nothing, so the honest answer is to run nothing
 * and let them decide.
 */
export class InertSlotError extends Error {
  override readonly name = "InertSlotError";
  readonly entries: InertSlotErrorEntry[];

  constructor(workflowName: string, entries: InertSlotErrorEntry[]) {
    super(
      `${entries.length} of the address${entries.length === 1 ? "" : "es"} requested for ` +
        `${JSON.stringify(workflowName)} would be silently ignored — ComfyUI's own graph execution ` +
        `overrides the widget there with a value from a link to another node, so nothing was run:\n` +
        entries.map(describeInertEntry).join("\n") +
        `\ndescribe_workflow lists every inert address for this workflow under \`inert\`, alongside ` +
        `whatever upstream node and candidate address this server could identify for each.`,
    );
    this.entries = entries;
  }
}

function describeInertEntry(entry: InertSlotErrorEntry): string {
  const { address, upstream } = entry;
  if (upstream === null) {
    return `  ${address}: fed by a link this server could not trace to any node in the graph.`;
  }
  const node = `node ${upstream.node_id} (${upstream.node_type || "unknown type"})`;
  const suggestion =
    upstream.candidate_addresses.length > 0
      ? ` Try ${upstream.candidate_addresses.map((a) => JSON.stringify(a)).join(" or ")} instead.`
      : ` No settable address one hop upstream of ${node} could be identified automatically.`;
  return `  ${address}: fed by a link from ${node}, not by its own widget.${suggestion}`;
}

/** A successful tool result: one text block holding the answer as JSON. */
export function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: stringify(value) }] };
}

/**
 * Indented on purpose. This is read by a model and, when something has gone
 * wrong, by a person; the extra bytes buy line-oriented diffs and legible
 * nesting in both cases.
 */
function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** The most recent events, and whether that meant dropping older ones. */
function reportedEvents(
  events: RunEvent[],
  alreadyTruncated: boolean,
): { events: RunEvent[]; events_truncated: boolean } {
  const truncated = events.length > MAX_REPORTED_EVENTS;
  return {
    events: truncated ? events.slice(-MAX_REPORTED_EVENTS) : events,
    events_truncated: truncated || alreadyTruncated,
  };
}

/** Drop the keys whose value is `null` from the CLI's optional diagnostics. */
function present<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

/**
 * The `comfy_cli` arm's payload, shared with `run_failed` because the latter is
 * the former plus events — it is a subclass, and reproducing these five fields
 * twice is how the two would drift.
 */
function cliFields(err: ComfyCliError): Partial<ToolErrorBody> {
  return {
    code: err.code,
    message: err.message,
    hint: present(err.hint),
    where: present(err.where),
    details: present(err.details),
  };
}

/**
 * Classify one thrown value.
 *
 * The arms are ordered most-specific-first, and two of those orderings are not
 * stylistic: `RunFailedError` must precede `ComfyCliError` (it is a subclass),
 * and every named type must precede the `Error` fallback.
 *
 * `TypeError` is deliberately **not** given an arm of its own. The only one this
 * codebase raises on purpose is `resolveHost`'s empty-host guard, and that path
 * is closed at the tool schemas instead — an address argument is constrained to
 * be non-empty before it can reach the library. Claiming every `TypeError` is
 * the caller's bad input would relabel a genuine bug in this server as their
 * mistake and send a model round a retry loop it can never win, so an
 * unrecognised error is reported as what it is.
 */
export function describeError(err: unknown): ToolErrorBody {
  // Before ComfyCliError: it is a subclass, and the events are the half of the
  // diagnosis the envelope does not carry.
  if (err instanceof RunFailedError) {
    return {
      kind: "run_failed",
      ...cliFields(err),
      ...reportedEvents(err.events, err.eventsTruncated),
    } as ToolErrorBody;
  }
  if (err instanceof ComfyCliError) {
    return { kind: "comfy_cli", ...cliFields(err) } as ToolErrorBody;
  }

  if (err instanceof ComfyTimeoutError) {
    // The message already names the job to poll where one could be recovered
    // from the partial stream, which is the only thing that makes a timed-out
    // run recoverable rather than a dead end.
    return { kind: "timeout", message: err.message, timeout_ms: err.timeoutMs };
  }
  if (err instanceof ComfyUnavailableError) {
    return { kind: "comfy_unavailable", message: err.message, binary: err.binary };
  }

  // The CLI answered, but not with its own contract. Distinct from a CLI
  // failure because the fixes are different: one is ComfyUI saying no, the other
  // is this server and the CLI disagreeing about the shape of an answer.
  if (
    err instanceof EnvelopeParseError ||
    err instanceof RunContractError ||
    err instanceof SetSlotContractError ||
    err instanceof SlotListingParseError ||
    err instanceof JobPayloadError ||
    err instanceof TemplatesPayloadError
  ) {
    return { kind: "contract_violation", message: err.message };
  }

  if (err instanceof SlotValueError) {
    return { kind: "invalid_input", message: err.message, address: err.address };
  }
  // Before LaunchArgumentError, which it subclasses. The distinction is the
  // whole point: one says "correct this argument", the other says "that machine
  // is not this one, and no argument here can change that".
  if (err instanceof RemoteLaunchRefusedError) {
    return { kind: "host_not_local", message: err.message, host: err.address };
  }
  if (err instanceof LaunchArgumentError || err instanceof ToolArgumentError) {
    return { kind: "invalid_input", message: err.message };
  }

  if (err instanceof UnknownHostError) {
    return {
      kind: "unknown_host",
      message: err.message,
      known_hosts: err.known,
      registry_path: err.registryPath,
    };
  }
  if (err instanceof RegistryInvalidError) {
    return {
      kind: "registry_invalid",
      message: err.message,
      registry_path: err.registryPath,
      line: err.problem.line,
      column: err.problem.column,
    };
  }
  if (err instanceof HostNotLocalError) {
    return { kind: "host_not_local", message: err.message, host: err.address };
  }
  if (err instanceof RemoteHostUnavailableError) {
    return { kind: "host_unreachable", message: err.message, url: err.url, host: err.host };
  }
  if (err instanceof JobHostUnknownError) {
    return {
      kind: "job_host_unknown",
      message: err.message,
      prompt_id: err.promptId,
      known_hosts: err.candidates,
    };
  }
  if (err instanceof WorkflowNotFoundError) {
    return { kind: "workflow_not_found", message: err.message, known_workflows: err.known };
  }
  if (err instanceof InertSlotError) {
    return { kind: "inert_slot", message: err.message, inert_addresses: err.entries };
  }
  if (err instanceof WorkflowFileError) {
    // The errno is the actionable part: ENOENT is a wrong name, EACCES is a
    // permission bit, and only one of those is the caller's to fix.
    return {
      kind: "workflow_file",
      message: err.message,
      code: present(err.code),
      workflow_path: err.workflowPath,
    };
  }

  // A remote instance's own workflow library. Three different failures wear one
  // type here because the operator's question is the same — which instance, and
  // what did it say — and `status` is what tells them apart: nothing answered,
  // the file is not there, or it answered with something unusable.
  if (err instanceof UserdataError) {
    if (err.status === null) {
      return { kind: "host_unreachable", message: err.message, url: err.url };
    }
    if (err.status === 404) {
      return { kind: "workflow_not_found", message: err.message };
    }
    return { kind: "workflow_file", message: err.message, workflow_path: err.url };
  }

  if (err instanceof ObjectInfoFetchError) {
    return {
      kind: "object_info_unavailable",
      message: err.message,
      url: err.url,
      cache_path: err.cachePath,
      status: err.status,
    };
  }
  if (err instanceof ObjectInfoCacheWriteError) {
    return {
      kind: "object_info_cache_unwritable",
      message: err.message,
      cache_path: err.cachePath,
    };
  }
  // Before LaunchTimeoutError, and distinct from it on purpose: a timeout means
  // "still waiting, budget spent", while this means "the child is gone and
  // nothing will ever answer". Collapsing them would tell an operator to raise
  // a budget that was never the problem.
  if (err instanceof LaunchFailedError) {
    return { kind: "launch_failed", message: err.message, url: err.url };
  }
  if (err instanceof LaunchTimeoutError) {
    return {
      kind: "launch_timeout",
      message: err.message,
      url: err.url,
      timeout_ms: err.timeoutMs,
    };
  }
  if (err instanceof InstanceUnavailableError) {
    return { kind: "comfyui_not_running", message: err.message, url: err.url };
  }

  // Before the fallback, and the reason it is worth an arm of its own: a missing
  // `--allow-*` flag is an operator's to fix — the runtime's own message even
  // names the flag — and `internal_error` would report it as "this server has a
  // bug", which is both false and the wrong place to send anyone. Measured: a
  // server started without `--allow-sys` answers `list_hosts` this way the
  // first time it looks for its own configuration directory.
  //
  // Matched on the NAME, not with `instanceof Deno.errors.NotCapable`: this
  // bundle runs under Node and Bun too, where the `Deno` global does not exist
  // and the reference would throw while classifying somebody else's error.
  if (err instanceof Error && err.name === "NotCapable") {
    return {
      kind: "permission_denied",
      message:
        `${err.message}\n` +
        `This server is running under Deno without a permission it needs. The full set is ` +
        `--allow-run --allow-read --allow-write --allow-net --allow-env ` +
        `--allow-sys=homedir,networkInterfaces, or -A for all of them.`,
      error_name: err.name,
    };
  }

  return {
    kind: "internal_error",
    message: err instanceof Error ? err.message : String(err),
    error_name: err instanceof Error ? err.name : typeof err,
  };
}

/**
 * A failed tool result carrying the classified error.
 *
 * `isError: true` rather than a thrown exception: the MCP contract makes a tool
 * error part of the conversation, where a protocol-level error is a fault the
 * model never sees the body of.
 *
 * An `internal_error` — and only an `internal_error` — is also written to
 * **stderr**, with its stack. stdout is the JSON-RPC stream and nothing may be
 * printed there, but a bug in this server is the one failure whose stack nobody
 * else will ever see, and stderr is where an operator is already looking.
 */
export function toolFailure(err: unknown): CallToolResult {
  const error = describeError(err);
  if (error.kind === "internal_error") {
    console.error("[mcp-comfyui] unclassified tool failure:", err);
  }
  return { content: [{ type: "text", text: stringify({ error }) }], isError: true };
}

/**
 * Run a tool's work and answer with its result, or with a classified failure.
 *
 * Every handler goes through this, so no tool can accidentally let an exception
 * reach the transport and become an opaque fault.
 */
export async function toolAnswer(work: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return jsonResult(await work());
  } catch (err) {
    return toolFailure(err);
  }
}
