import { z } from "zod";
import {
  parseEnvelopeValue,
  snippet,
  type ComfyError,
  type ParsedEnvelope,
} from "../comfy/envelope.ts";
import { ComfyCliError, ComfyTimeoutError, runComfyRaw, type ComfyRun } from "../comfy/exec.ts";
import { isTerminal } from "../comfy/jobs.ts";
import { classifyOutputs, type ClassifiedOutputs } from "../comfy/outputs.ts";
import { DEFAULT_PORT, resolveHost } from "../comfy/target.ts";
import type { PreparedWorkflow } from "./setSlots.ts";

/**
 * Execute a prepared workflow and collect what it produced.
 *
 * `comfy run --json` is the one command in this CLI that does not answer with a
 * single envelope. Its stdout is NDJSON: zero or more `event/1` lines as the
 * run progresses, then a final `envelope/1` carrying the verdict. So this
 * module builds on {@link runComfyRaw} and decodes **line by line** —
 * `JSON.parse` over the whole of stdout throws on the second line and would
 * fail every run that emitted a single event.
 *
 * Four properties of the CLI shape everything below:
 *
 * - **The envelope is the outcome, never the exit code.** Upstream returns 1
 *   for a missing file, a downed server, an HTTP error, a failed conversion and
 *   a failed execution alike, and 130 for a cancellation (landmine #4).
 * - **stdout is the entire contract; stderr is human text** and is never parsed
 *   (`docs/json-output.md:28-42`). It is still quoted in every diagnostic,
 *   because the CLI's own account of a failure lives there and nowhere else.
 * - **Submitting is the default; `--wait` blocks.** Without it the command
 *   returns as soon as the graph is queued, with a `prompt_id` and a detached
 *   watcher keeping the job's state file up to date.
 * - **The stream hands the whole workflow graph back to us**, unconditionally,
 *   on the `prompt_preview` event. That is landmine #12, and it is why
 *   {@link sanitiseEvent} exists — see {@link GRAPH_FIELD}.
 */

/** The status of a run that was submitted but not waited for. */
const QUEUED = "queued";

/** `envelope/1`'s own identifiers, used only to tell a line's kind apart. */
const ENVELOPE_SCHEMA = "envelope/1";
const ENVELOPE_TYPE = "envelope";

/**
 * How many undecodable stdout lines to carry back. Bounded because the list
 * ends up in an MCP response: a CLI that floods stdout with non-NDJSON is a
 * fault to report, not a log to mirror.
 */
const MAX_UNRECOGNISED_LINES = 10;

/**
 * How many events to carry back, and how large one undeclared field may be
 * before it is dropped.
 *
 * Both bounds exist because this result is an MCP response. A 400-step run
 * emits an event per step per node and every key the CLI sent is retained;
 * unbounded, one measured run produced 107KB of result JSON.
 *
 * The **last** events are kept rather than the first. The early ones are
 * recoverable elsewhere — the envelope's payload carries the `prompt_id`, and
 * {@link DecodedStream.promptId} is captured before any truncation — while the
 * late ones are not: `execution_error` carries the server's whole traceback and
 * arrives at the end of the run it explains.
 */
const MAX_EVENTS = 200;
const MAX_EVENT_FIELD_BYTES = 8_192;

/**
 * The field of `prompt_preview` that carries the entire workflow graph.
 *
 * `renderer.event("prompt_preview", prompt=workflow)` is unconditional in
 * stream mode — not gated on `--print-prompt` — so every run hands the graph
 * back to us, and `JSON.parse` has already rounded every integer in it past
 * 2^53 by the time this module sees it. Measured, on a real seed:
 *
 * ```
 * emitted by comfy : 18446744073709551615
 * after JSON.parse : 18446744073709552000
 * ```
 *
 * `workflows/setSlots.ts` is an entire byte-copy architecture built to keep
 * this server's JS away from the graph, and surfacing this field would undo it
 * one layer up. The images would still be right, because `comfy` did the
 * submit; the *report* would be wrong. A reproduce-this-render loop reads its
 * seed from that report, re-runs with a rounded value, gets a different image,
 * and nothing errors (landmine #11, recurring as #12).
 *
 * So it is dropped, unconditionally and by name. Nothing is lost: the graph is
 * the caller's own file, which they already have. If an audit trail is ever
 * wanted, carry the raw line **text** — never the parsed object.
 */
const GRAPH_FIELD = "prompt";

/** What replaces a dropped graph, so the drop is never silent. */
const DROPPED_GRAPH = "<dropped: workflow graph; read it from the workflow file>";

/**
 * The fields `schema.run_event.json` declares. All of them are scalars, so all
 * of them are safe to carry whole; everything else is undeclared and bounded by
 * {@link MAX_EVENT_FIELD_BYTES}.
 */
const DECLARED_EVENT_FIELDS = new Set([
  "schema",
  "type",
  "node",
  "title",
  "class_type",
  "completed",
  "total",
  "prompt_id",
  "url",
]);

/**
 * One NDJSON progress event.
 *
 * `type` is an **open string**, not the enum `schema.run_event.json` publishes.
 * That enum is already incomplete: comfy-cli's run path emits `converted` and
 * `prompt_preview`, neither of which appears in it. Closing the set would make
 * the next event type upstream ships fail a run that produced images — the same
 * append-only reasoning that keeps `error.code` open in `comfy/envelope.ts`.
 *
 * `looseObject` for the same reason one level down, and it matters more here
 * than anywhere else in this codebase: the payload of an `execution_error` is
 * its undeclared `details` field, which carries the server's whole traceback,
 * and `executed` carries an undeclared `outputs` array of structured file
 * records. Stripping unknown keys would throw away the diagnosis and keep the
 * envelope. What passing them through would otherwise cost is handled by
 * {@link sanitiseEvent}.
 *
 * `schema` is likewise decoded as an open string. A future `event/2` renames or
 * retypes fields, all of which are optional here, so the line still decodes to
 * whatever survived and the version travels with it for a caller who cares.
 */
export const RunEventSchema = z.looseObject({
  schema: z.string().optional(),
  type: z.string(),
  /** The node id, always stringified by the CLI even for a numeric graph key. */
  node: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  class_type: z.string().nullable().optional(),
  /** `progress` only: steps done and steps total for the executing node. */
  completed: z.number().int().nullable().optional(),
  total: z.number().int().nullable().optional(),
  prompt_id: z.string().nullable().optional(),
  /** `output` only: one artifact, in either of the two forms below. */
  url: z.string().nullable().optional(),
});

export type RunEvent = z.infer<typeof RunEventSchema>;

/**
 * A non-fatal note about the run. Deliberately a twin of `set-slot`'s warning
 * schema rather than a shared export: the two commands happen to describe a
 * warning the same way today, and `comfy/outputs.ts` and `comfy/target.ts`
 * already hold the parts that genuinely must not diverge.
 */
export const RunWarningSchema = z.looseObject({
  code: z.string(),
  message: z.string(),
});

export type RunWarning = z.infer<typeof RunWarningSchema>;

/**
 * `schema.run.json`, narrowed to the fields this server surfaces.
 *
 * `status` is an open string for the same reason `type` is: three values are
 * published for `run` where `jobs` already knows seven, and a fourth must not
 * turn a finished run into a parse failure. `workflow` and `status` are the
 * contract's required fields and stay required — a payload missing either is
 * not a run result, whatever else it may be.
 *
 * `outputs_by_node` and `outputs_by_item` are deliberately not declared: both
 * are cloud-`--wait`-only groupings of the same artifacts, and cloud routing is
 * out of scope for this server. `looseObject` passes them through untouched
 * rather than rejecting a payload that carries them.
 */
const RunPayloadSchema = z.looseObject({
  workflow: z.string(),
  status: z.string(),
  prompt_id: z.string().nullable().optional(),
  outputs: z.array(z.string()).optional(),
  warnings: z.array(RunWarningSchema).optional(),
  elapsed_seconds: z.number().nullable().optional(),
});

/** What one execution of a workflow produced. */
export interface WorkflowRun {
  /**
   * The caller's own workflow file. The copy that was executed is deleted by
   * the time this returns, so reporting the path the CLI echoed back would hand
   * the caller a path that no longer exists.
   */
  source: string;
  /**
   * `queued` for the default async submit, `completed` for a `--wait` run that
   * finished, `cancelled` for one that was stopped. An open string: see
   * {@link RunPayloadSchema}.
   */
  status: string;
  /**
   * Whether {@link status} is one `comfy` treats as finished. Derived with the
   * same `isTerminal` `comfy/jobs.ts` uses, so a run and a later poll of the
   * same job can never disagree about whether it is over.
   */
  terminal: boolean;
  /**
   * The job handle, for the `get_job` and `cancel_job` tools. Always present
   * when `status` is `queued`; `null` only where the CLI omitted it on a run
   * that had already finished, where the outputs are what the caller wanted.
   */
  promptId: string | null;
  outputs: ClassifiedOutputs;
  /** Advisory notes; the run happened regardless. */
  warnings: RunWarning[];
  /** Wall-clock duration of a `--wait` run; `null` for a submit. */
  elapsedSeconds: number | null;
  /**
   * The events, in the order they arrived, sanitised by {@link sanitiseEvent}
   * and capped at the most recent {@link MAX_EVENTS}.
   *
   * Buffered, not streamed. {@link runComfyRaw} hands back whole streams, so
   * nothing can reach a caller before the child exits; an `onEvent` callback
   * would be this same array replayed under a name that promises progress. The
   * plan rules out a streaming API, so the array is the honest shape.
   */
  events: RunEvent[];
  /** Whether older events were dropped to keep {@link events} bounded. */
  eventsTruncated: boolean;
  /**
   * stdout lines that were neither an event nor an envelope, snippetted and
   * bounded. Always empty against a CLI honouring the contract. They do not
   * fail the run — a stray print does not change what the run produced — but
   * dropping them silently would hide the drift that produced them.
   */
  unrecognisedLines: string[];
}

export interface RunWorkflowOptions {
  /** ComfyUI's address, defaulting to `127.0.0.1`. */
  host?: string;
  /** Defaults to `8188`. */
  port?: number;
  /**
   * Block until the run finishes and return its outputs. Defaults to `false`,
   * which is the CLI's own default: submit, return a `prompt_id`, and leave a
   * detached watcher to follow the job.
   */
  wait?: boolean;
  /**
   * Budget for the whole call, defaulting to `runComfyRaw`'s 120 seconds. A
   * `--wait` run needs a budget matching the workflow; a submit does not.
   */
  timeoutMs?: number;
}

/**
 * The CLI answered, but not with something this server can act on: a stream
 * with no verdict in it, two verdicts, or a payload that is not a run result.
 *
 * Distinct from {@link ComfyCliError}, which is the CLI reporting a failure it
 * understood and diagnosed. This is the more dangerous case, because the
 * alternative to raising it is guessing — and a guess here is a guess about
 * whether the caller's images exist.
 */
export class RunContractError extends Error {
  override readonly name = "RunContractError";
  /** The caller's own workflow file. */
  readonly workflowPath: string;

  constructor(workflowPath: string, detail: string, options?: { cause?: unknown }) {
    super(
      `comfy run did not produce a result this server can act on for ${workflowPath}\n${detail}`,
      options,
    );
    this.workflowPath = workflowPath;
  }
}

/**
 * The run itself failed, with the events that explain it attached.
 *
 * A {@link ComfyCliError} — every caller branching on `.code` keeps working —
 * carrying the half of the diagnosis the envelope does not have. Upstream is
 * explicit about the split:
 *
 * ```python
 * # execution.py:559-561
 * # The event keeps the full server payload (incl. complete traceback);
 * # the error envelope carries the classified one-line verdict.
 * ```
 *
 * So the envelope says `execution_error: Node 3 raised`, while the traceback,
 * the failing node's inputs and the exception type are on the `execution_error`
 * event and nowhere else. Decoding those and dropping them would leave the
 * caller with the one line they could already guess.
 */
export class RunFailedError extends ComfyCliError {
  /** The failed run's events, sanitised and capped as on {@link WorkflowRun}. */
  readonly events: RunEvent[];
  readonly eventsTruncated: boolean;

  constructor(
    command: string,
    where: string | null,
    error: ComfyError,
    events: RunEvent[],
    eventsTruncated: boolean,
  ) {
    super(command, where, error);
    // `ComfyCliError` declares `name` as a `readonly` field, which TypeScript
    // narrows to the literal `"ComfyCliError"` — so no subclass can redeclare
    // it. Assigned instead, which is what a field declaration compiles to
    // anyway, and which keeps the property's attributes as the base set them.
    Object.assign(this, { name: "RunFailedError" });
    this.events = events;
    this.eventsTruncated = eventsTruncated;
  }
}

/**
 * The invocation. `--json` is passed explicitly even though piped stdout would
 * select it anyway (landmine #2), and `--host`/`--port` are sent even at their
 * defaults so the target never depends on whatever workspace config the CLI
 * happens to find. `--skip-prompt` is `runComfyRaw`'s to prepend.
 */
function runArgs(path: string, opts: RunWorkflowOptions): string[] {
  const args = ["run", "--workflow", path, "--json"];
  if (opts.wait === true) args.push("--wait");
  args.push("--host", resolveHost(opts.host), "--port", String(opts.port ?? DEFAULT_PORT));
  return args;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a line is trying to be the final envelope.
 *
 * Either identifier is enough on purpose. A line claiming to be an envelope and
 * failing the contract is the *result* arriving malformed, and saying so beats
 * binning it as unreadable and then reporting that the run produced no verdict
 * at all — one of those sends the operator to look at the envelope, the other
 * sends them looking for output that was never missing.
 */
function looksLikeEnvelope(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.schema === ENVELOPE_SCHEMA || value.type === ENVELOPE_TYPE;
}

/** The serialised size of a value, for deciding whether it can be carried. */
function measure(value: unknown): number {
  try {
    return (JSON.stringify(value) ?? "").length;
  } catch {
    // Not reachable from `JSON.parse` output, which cannot be cyclic. Treated
    // as oversized rather than thrown from: an event must never fail a run.
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Strip an event of what must not travel out of this module.
 *
 * Two rules, for two different reasons. The workflow graph goes because this
 * server's JS has already corrupted it (see {@link GRAPH_FIELD}); that is a
 * correctness rule and applies at any size. Any *other* undeclared field goes
 * when it is oversized, which is a budget rule: the result is an MCP response.
 *
 * The size rule is also the general defence behind the named one. A graph
 * arriving under a field nobody has named yet is caught by being huge; a small
 * graph is caught by being called `prompt`. Neither mechanism covers the other,
 * which is why both are here.
 *
 * Dropped, never truncated: a truncated graph is still a graph with rounded
 * digits in it, and half a JSON object reads as data rather than as the marker
 * it is. The replacement says what happened, so no drop is silent.
 */
function sanitiseEvent(event: RunEvent): RunEvent {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (DECLARED_EVENT_FIELDS.has(key)) {
      clean[key] = value;
      continue;
    }
    if (key === GRAPH_FIELD) {
      clean[key] = DROPPED_GRAPH;
      continue;
    }
    const size = measure(value);
    clean[key] = size > MAX_EVENT_FIELD_BYTES ? `<dropped: ${size} bytes>` : value;
  }
  return clean as RunEvent;
}

/** The exit code and a bounded look at both streams. */
function streamDiagnostics(run: ComfyRun): string {
  return (
    `  exit code: ${run.exitCode}\n` +
    `  stdout: ${snippet(run.stdout)}\n` +
    // Never parsed, always quoted: a run that fails outside the JSON contract —
    // an uncaught Python exception, a library warning, a kill — explains itself
    // only here.
    `  stderr: ${snippet(run.stderr)}`
  );
}

/**
 * Where to go when this server cannot say how the run ended.
 *
 * Both an MCP tool and the shell command behind it are named where both exist:
 * a model calling this server can use the first and cannot run the second, and
 * an operator reading a log is in the opposite position.
 */
function whereToLook(promptId: string | null): string {
  if (promptId === null) {
    return `  The run's outcome is unknown; \`comfy jobs ls\` in a shell lists the jobs the CLI recorded.`;
  }
  return (
    `  The run was submitted as prompt ${promptId} and may still be executing; ` +
    `the get_job tool — or \`comfy jobs status ${promptId}\` in a shell — will say.`
  );
}

/** The payload came from `JSON.parse`, so it cannot be cyclic. */
function describe(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

interface DecodedStream {
  /** Sanitised, and capped to the most recent {@link MAX_EVENTS}. */
  events: RunEvent[];
  eventsTruncated: boolean;
  /** The run's verdict, or `null` if the stream never carried one. */
  envelope: ParsedEnvelope | null;
  unrecognised: string[];
  /**
   * The first `prompt_id` seen on any event, captured **before** truncation so
   * that a run chatty enough to lose its `queued` event can still be found.
   */
  promptId: string | null;
}

/**
 * Split stdout into lines and decode each.
 *
 * Leniency runs one way only. A line this server cannot read does not change
 * what the run produced, so it is collected and the run is still reported — the
 * alternative loses a completed run's images over a stray print. A *second*
 * envelope, or an event after the envelope, is not like that: the first says
 * there are two verdicts for one run with no rule for choosing between them,
 * and the second says the line taken as final was not, so the verdict about to
 * be returned is not known to describe the finished run. Both are refused, with
 * the job named so the caller can settle it themselves.
 */
function decodeStream(workflowPath: string, stdout: string): DecodedStream {
  const all: RunEvent[] = [];
  const unrecognised: string[] = [];
  let envelope: ParsedEnvelope | null = null;
  let promptId: string | null = null;

  const remember = (line: string): void => {
    if (unrecognised.length < MAX_UNRECOGNISED_LINES) unrecognised.push(snippet(line));
  };

  for (const line of stdout.split("\n")) {
    // Not a violation, and not rare: NDJSON terminates every line with `\n`, so
    // the final split always yields an empty one, and a killed run yields
    // nothing but blank lines.
    if (line.trim() === "") continue;

    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      remember(line);
      continue;
    }

    if (looksLikeEnvelope(value)) {
      if (envelope !== null) {
        throw new RunContractError(
          workflowPath,
          `  stdout carried more than one envelope/1 line, so the run has two verdicts and ` +
            `there is no rule for choosing between them.\n` +
            `  second envelope: ${snippet(line)}\n` +
            whereToLook(promptId),
        );
      }
      // Uncaught on purpose: an envelope that violates envelope/1 is the result
      // itself arriving malformed, and EnvelopeParseError names the offending
      // field where this module could only say "unreadable line".
      envelope = parseEnvelopeValue(value);
      continue;
    }

    const event = RunEventSchema.safeParse(value);
    if (!event.success) {
      remember(line);
      continue;
    }
    if (envelope !== null) {
      throw new RunContractError(
        workflowPath,
        `  an event arrived after the envelope, so the envelope was not the final line and ` +
          `the run's reported outcome is not known to be its last.\n` +
          `  trailing event: ${snippet(line)}\n` +
          whereToLook(promptId),
      );
    }
    if (promptId === null && typeof event.data.prompt_id === "string") {
      promptId = event.data.prompt_id;
    }
    all.push(sanitiseEvent(event.data));
  }

  const eventsTruncated = all.length > MAX_EVENTS;
  return {
    events: eventsTruncated ? all.slice(-MAX_EVENTS) : all,
    eventsTruncated,
    envelope,
    unrecognised,
    promptId,
  };
}

/**
 * Name the job on the one error that otherwise cannot.
 *
 * A `--wait` run exceeding its budget is the likeliest failure of this tool, and
 * the run is unaffected by it — the CLI was killed, ComfyUI was not. The partial
 * stdout carried on the error holds the `queued` event and with it the handle,
 * so the difference between a dead end and a recoverable state is decoding what
 * has already been read.
 */
function nameTheJob(workflowPath: string, err: ComfyTimeoutError): ComfyTimeoutError {
  let guidance: string;
  try {
    guidance = whereToLook(decodeStream(workflowPath, err.stdout).promptId);
  } catch {
    // A stream cut mid-flight is exactly where a contract violation is expected,
    // and it is not the error worth reporting: the timeout is.
    guidance = whereToLook(null);
  }
  // Mutated rather than rebuilt, as `workflows/slots.ts` does and for the same
  // reason: the message is assembled in the constructor, and re-deriving it here
  // would duplicate that. Safe because `runComfyRaw` throws this error and it is
  // caught here with nothing in between — nothing has read `.stack`, whose first
  // read memoizes the `Name: message` header.
  err.message = `${err.message}\n${guidance}`;
  return err;
}

/**
 * Run a prepared workflow.
 *
 * **Takes ownership of `prepared`.** The temp copy is removed before this
 * returns, on every path: `comfy run` reads the file when it submits and never
 * again, so the copy is finished with even on the async path, and making the
 * run own the disposal means no caller can leak one.
 *
 * The two modes are one command differing by a flag, and answer with the same
 * `run.json` payload, so they are one function: splitting them would duplicate
 * the NDJSON decode, the classification and the diagnostics for nothing, and
 * the MCP tool takes `wait` as an argument regardless. `status` is what tells
 * them apart, and it is an open string rather than a discriminated union — see
 * {@link RunPayloadSchema}.
 *
 * @throws {RunContractError} the stream carried no verdict, more than one, or a
 * payload that is not a run result.
 * @throws {RunFailedError} the CLI reported a failure — `execution_error` for a
 * node that raised, `cancelled` for an interrupted run — with the CLI's own
 * diagnosis and the events that explain it attached. A {@link ComfyCliError}.
 * @throws {EnvelopeParseError} a line claiming to be the envelope was not one.
 * @throws {ComfyTimeoutError} the call exceeded `timeoutMs`. The run itself is
 * unaffected and goes on executing; the message names the job to poll.
 * @throws {ComfyUnavailableError} the `comfy` binary could not be started.
 * @throws {TypeError} `host` was given as an empty string, which would build
 * `http://:8188/` and be reported as an unreachable server.
 */
export async function runWorkflow(
  prepared: PreparedWorkflow,
  opts: RunWorkflowOptions = {},
): Promise<WorkflowRun> {
  try {
    let run: ComfyRun;
    try {
      run = await runComfyRaw(runArgs(prepared.path, opts), { timeoutMs: opts.timeoutMs });
    } catch (err) {
      if (err instanceof ComfyTimeoutError) throw nameTheJob(prepared.source, err);
      throw err;
    }

    // Diagnostics name the caller's own file: the copy is about to be deleted,
    // and its path means nothing to whoever has to act on the message.
    const stream = decodeStream(prepared.source, run.stdout);

    if (stream.envelope === null) {
      throw new RunContractError(
        prepared.source,
        `  the NDJSON stream ended with no envelope/1 line, so the CLI never reported an outcome.\n` +
          `${streamDiagnostics(run)}\n` +
          `${whereToLook(stream.promptId)}`,
      );
    }
    if (!stream.envelope.ok) {
      throw new RunFailedError(
        stream.envelope.command,
        stream.envelope.where,
        stream.envelope.error,
        stream.events,
        stream.eventsTruncated,
      );
    }

    const result = RunPayloadSchema.safeParse(stream.envelope.data);
    if (!result.success) {
      throw new RunContractError(
        prepared.source,
        `  received: ${snippet(describe(stream.envelope.data))}\n${z.prettifyError(result.error)}`,
        { cause: result.error },
      );
    }

    const payload = result.data;
    const promptId = payload.prompt_id ?? null;
    if (payload.status === QUEUED && promptId === null) {
      // The whole point of an async submit is the handle. Returning one without
      // it would report a running job that nothing can poll, cancel or find.
      throw new RunContractError(
        prepared.source,
        `  the CLI reported status "${QUEUED}" with no prompt_id, so the run it started ` +
          `cannot be polled or cancelled.\n` +
          `  \`comfy jobs ls\` in a shell lists the jobs the CLI recorded.`,
      );
    }

    return {
      source: prepared.source,
      status: payload.status,
      terminal: isTerminal(payload.status),
      promptId,
      outputs: classifyOutputs(payload.outputs ?? []),
      warnings: payload.warnings ?? [],
      elapsedSeconds: payload.elapsed_seconds ?? null,
      events: stream.events,
      eventsTruncated: stream.eventsTruncated,
      unrecognisedLines: stream.unrecognised,
    };
  } finally {
    prepared.dispose();
  }
}
