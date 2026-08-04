import { z } from "zod";
import { parseEnvelopeValue, snippet, type ParsedEnvelope } from "../comfy/envelope.ts";
import { ComfyCliError, runComfyRaw, type ComfyRun } from "../comfy/exec.ts";
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
 * Three properties of the CLI shape everything below:
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

/** `http` and `https`, case-insensitively — a URI scheme is case-insensitive. */
const HTTP_URL = /^https?:\/\//i;

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
 * envelope.
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
 * warning the same way today, and `comfy/target.ts` already holds the part that
 * genuinely must not diverge.
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

/**
 * The artifacts a run produced, kept apart by kind.
 *
 * On a loopback host with a resolvable workspace the CLI emits absolute
 * filesystem paths; otherwise it emits `/view?...` URLs, and per
 * `docs/json-output.md:253` any non-`http(s)` value is a path. One merged list
 * would leave every caller re-deriving that rule, and getting it wrong means
 * either opening a URL as a file or fetching a path as a URL.
 */
export interface RunOutputs {
  /** Artifacts on this machine's filesystem, openable directly. */
  files: string[];
  /** Artifacts behind `http(s)`, which have to be fetched. */
  urls: string[];
}

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
   * The job handle, for `comfy jobs status`/`cancel`. Always present when
   * `status` is `queued`; `null` only where the CLI omitted it on a run that
   * had already finished, where the outputs are what the caller wanted.
   */
  promptId: string | null;
  outputs: RunOutputs;
  /** Advisory notes; the run happened regardless. */
  warnings: RunWarning[];
  /** Wall-clock duration of a `--wait` run; `null` for a submit. */
  elapsedSeconds: number | null;
  /**
   * Every event line, in the order it arrived.
   *
   * Buffered, not streamed. {@link runComfyRaw} hands back whole streams, so
   * nothing can reach a caller before the child exits; an `onEvent` callback
   * would be this same array replayed under a name that promises progress. The
   * plan rules out a streaming API, so the array is the honest shape.
   */
  events: RunEvent[];
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
 * Where to go when this server cannot say how the run ended. The events carry
 * the `prompt_id` from the moment the graph is queued, so even a stream that
 * never reached its envelope usually names the job that is still running.
 */
function whereToLook(events: RunEvent[]): string {
  const promptId = events.find((event) => typeof event.prompt_id === "string")?.prompt_id;
  if (typeof promptId !== "string") {
    return `  The run's outcome is unknown; \`comfy jobs ls\` lists the jobs the CLI recorded.`;
  }
  return (
    `  The run was submitted as prompt ${promptId} and may still be executing; ` +
    `\`comfy jobs status ${promptId}\` will say.`
  );
}

/** The payload came from `JSON.parse`, so it cannot be cyclic. */
function describe(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

interface DecodedStream {
  events: RunEvent[];
  /** The run's verdict, or `null` if the stream never carried one. */
  envelope: ParsedEnvelope | null;
  unrecognised: string[];
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
function decodeStream(workflowPath: string, run: ComfyRun): DecodedStream {
  const events: RunEvent[] = [];
  const unrecognised: string[] = [];
  let envelope: ParsedEnvelope | null = null;

  const remember = (line: string): void => {
    if (unrecognised.length < MAX_UNRECOGNISED_LINES) unrecognised.push(snippet(line));
  };

  for (const line of run.stdout.split("\n")) {
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
            whereToLook(events),
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
          whereToLook(events),
      );
    }
    events.push(event.data);
  }

  return { events, envelope, unrecognised };
}

function classifyOutputs(outputs: string[]): RunOutputs {
  const files: string[] = [];
  const urls: string[] = [];
  for (const output of outputs) {
    (HTTP_URL.test(output) ? urls : files).push(output);
  }
  return { files, urls };
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
 * @throws {ComfyCliError} the CLI reported a failure — `execution_error` for a
 * node that raised, `cancelled` for an interrupted run, with its own diagnosis
 * attached.
 * @throws {EnvelopeParseError} a line claiming to be the envelope was not one.
 * @throws {ComfyTimeoutError} the call exceeded `timeoutMs`. The run itself is
 * unaffected and continues on the server; the partial stdout carried on the
 * error holds the `queued` event, and with it the job's `prompt_id`.
 * @throws {ComfyUnavailableError} the `comfy` binary could not be started.
 */
export async function runWorkflow(
  prepared: PreparedWorkflow,
  opts: RunWorkflowOptions = {},
): Promise<WorkflowRun> {
  try {
    const run = await runComfyRaw(runArgs(prepared.path, opts), { timeoutMs: opts.timeoutMs });
    // Diagnostics name the caller's own file: the copy is about to be deleted,
    // and its path means nothing to whoever has to act on the message.
    const stream = decodeStream(prepared.source, run);

    if (stream.envelope === null) {
      throw new RunContractError(
        prepared.source,
        `  the NDJSON stream ended with no envelope/1 line, so the CLI never reported an outcome.\n` +
          `${streamDiagnostics(run)}\n` +
          `${whereToLook(stream.events)}`,
      );
    }
    if (!stream.envelope.ok) {
      throw new ComfyCliError(
        stream.envelope.command,
        stream.envelope.where,
        stream.envelope.error,
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
          `  \`comfy jobs ls\` lists the jobs the CLI recorded.`,
      );
    }

    return {
      source: prepared.source,
      status: payload.status,
      promptId,
      outputs: classifyOutputs(payload.outputs ?? []),
      warnings: payload.warnings ?? [],
      elapsedSeconds: payload.elapsed_seconds ?? null,
      events: stream.events,
      unrecognisedLines: stream.unrecognised,
    };
  } finally {
    prepared.dispose();
  }
}
