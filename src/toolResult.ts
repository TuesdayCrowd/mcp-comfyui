import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { EnvelopeParseError } from "./comfy/envelope.ts";
import { ComfyCliError, ComfyTimeoutError, ComfyUnavailableError } from "./comfy/exec.ts";
import { LaunchArgumentError, LaunchTimeoutError } from "./comfy/instance.ts";
import { JobPayloadError } from "./comfy/jobs.ts";
import { ObjectInfoCacheWriteError, ObjectInfoFetchError } from "./comfy/objectInfo.ts";
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
  /** The workflow file could not be read: missing, unreadable, a directory. */
  | "workflow_file"
  /** `/object_info` could not be read, so no constraints could be recovered. */
  | "object_info_unavailable"
  /** The node definitions were fetched but could not be cached. */
  | "object_info_cache_unwritable"
  /** `comfy launch` ran but no ComfyUI answered inside the budget. */
  | "launch_timeout"
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
  /** `object_info_*`, `launch_timeout`: the address or file at fault. */
  url?: string;
  cache_path?: string;
  /** `object_info_unavailable`: the HTTP status, where the request got one. */
  status?: number | null;
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
    err instanceof JobPayloadError
  ) {
    return { kind: "contract_violation", message: err.message };
  }

  if (err instanceof SlotValueError) {
    return { kind: "invalid_input", message: err.message, address: err.address };
  }
  if (err instanceof LaunchArgumentError) {
    return { kind: "invalid_input", message: err.message };
  }
  if (err instanceof WorkflowNotFoundError) {
    return { kind: "workflow_not_found", message: err.message, known_workflows: err.known };
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
  if (err instanceof LaunchTimeoutError) {
    return {
      kind: "launch_timeout",
      message: err.message,
      url: err.url,
      timeout_ms: err.timeoutMs,
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
