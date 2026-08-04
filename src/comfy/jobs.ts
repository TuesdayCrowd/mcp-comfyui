import { z } from "zod";
import { snippet } from "./envelope.ts";
import { ComfyCliError, runComfy } from "./exec.ts";
import { classifyOutputs, isPreparedCopy, type ClassifiedOutputs } from "./outputs.ts";
import { DEFAULT_PORT, resolveHost } from "./target.ts";

/**
 * `comfy jobs`, which is what makes an async submit useful: `workflows/run.ts`
 * returns a `prompt_id` and returns immediately, and without a way to observe
 * or stop that job the handle is a receipt for something nobody can reach.
 *
 * Three subcommands are wrapped — `status`, `ls` and `cancel`. `wait` and
 * `watch` are deliberately absent: blocking is already `run --wait`, and
 * live-tailing needs a streaming API this server does not have.
 *
 * Two things about the CLI shape everything below.
 *
 * - **`ls` merges two sources.** Locally-tracked submits (state files this CLI
 *   wrote) are merged with the server's own `/queue` and `/history`, so a job
 *   this server submitted and a job someone started in the ComfyUI web UI both
 *   appear, and either source alone can be the only one that knows a job.
 * - **`cancel` is idempotent for known jobs**; only an id that is nowhere
 *   errors, with `prompt_not_found`. Cancelling a finished job therefore
 *   succeeds, which is correct and also useless on its own: the caller cannot
 *   tell it from having stopped a running one. See {@link cancelJob}.
 */

/** The one error code this module reclassifies, and only in {@link cancelJob}. */
const PROMPT_NOT_FOUND = "prompt_not_found";

/**
 * The statuses `comfy` itself treats as terminal — `jobs_state.py`'s
 * `TERMINAL_STATUSES`, copied because it is a decision upstream has made and
 * this server must agree with rather than invent.
 *
 * This set is closed where {@link JobStatus.status} is an open string, and the
 * asymmetry is deliberate: a status we do not recognise is one we cannot claim
 * has finished, so it reads as non-terminal and {@link cancelJob} tries to stop
 * it. The alternative direction would silently decline to cancel a running job
 * the day upstream adds a status.
 */
const TERMINAL_STATUSES = new Set(["completed", "error", "cancelled"]);

/**
 * How many rows `jobs ls` returns. The CLI's own default is 10; stating it
 * means a listing's size never depends on a default this server does not
 * control, the same reason `--host`/`--port` are always sent.
 */
const DEFAULT_LIMIT = 10;

/**
 * The root-level JSON mode flag. Piped stdout would select JSON anyway, but
 * behaviour must never depend on TTY detection (landmine #2) — and this is a
 * Typer *root* flag, so it goes before the subcommand (landmine #3):
 * `comfy jobs ls --json` fails where `comfy --json jobs ls` works. `run` is the
 * exception in this codebase; its `--json` is a subcommand flag selecting
 * NDJSON, and `jobs` has no such flag of its own.
 */
const JSON_MODE = "--json";

/**
 * One settable field of the status/listing payloads is decoded as an open
 * string on purpose. `schema.jobs.json` publishes an enum of seven statuses and
 * it is already incomplete: `_snapshot` returns `cancelled` for an interrupted
 * prompt, and `jobs ls` passes state-file statuses such as `allocated` straight
 * through. The same append-only reasoning keeps `error.code` open in
 * `envelope.ts` and `event.type` open in `workflows/run.ts`.
 */
const JobStatusPayloadSchema = z.looseObject({
  prompt_id: z.string(),
  status: z.string(),
  /**
   * Declared by the schema at top level but emitted by no subcommand today —
   * `jobs status` never reports one. Optional so it costs nothing if it starts.
   */
  queue_position: z.number().int().nullable().optional(),
  workflow_size: z.number().int().nullable().optional(),
  /** Artifacts. On a `jobs ls` row the same key is a *count* — see below. */
  outputs: z.array(z.string()).optional(),
  /**
   * The server's own account of a failure: the decoded `execution_error`
   * payload from `/history`, or a state file's `{code,message,hint}`. Undeclared
   * shape on purpose — it is the diagnosis, and narrowing it would discard the
   * traceback that is the only reason anyone reads it.
   */
  error: z.unknown().optional(),
  /**
   * The CLI's own resolution of the target, which is not simply what we sent:
   * `resolve_host_port` brackets a bare IPv6 literal. Absent on the cloud arm,
   * which is why the copied schema's `required: [host, port]` is not honoured
   * here as written.
   */
  host: z.string().nullable().optional(),
  port: z.number().int().nullable().optional(),
});

/**
 * One row of `jobs ls`.
 *
 * `where`, `workflow_path` and `updated_at` are emitted by `_row_to_dict` and
 * declared by nothing; they are the only way to tell a job this server
 * submitted from one started in the web UI, so they are decoded rather than
 * left to be stripped.
 */
const JobRowSchema = z.looseObject({
  prompt_id: z.string(),
  status: z.string(),
  queue_position: z.number().int().nullable().optional(),
  workflow_size: z.number().int().nullable().optional(),
  /**
   * **A count, not the artifacts.** `jobs status` uses this same key for the
   * list of output URLs. Surfaced under a different name below so no caller can
   * iterate the number 2.
   */
  outputs: z.number().int().nullable().optional(),
  where: z.string().nullable().optional(),
  workflow_path: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
});

const JobListPayloadSchema = z.looseObject({
  jobs: z.array(JobRowSchema),
  /** Which state-file rows the listing included: the target, or `all`. */
  scope: z.string().nullable().optional(),
  host: z.string().nullable().optional(),
  port: z.number().int().nullable().optional(),
});

/**
 * `_local_cancel`'s payload. **Not covered by `schema.jobs.json`**, whose own
 * title is "ls, status, and watch", so this is written from
 * `comfy_cli/command/jobs.py` directly.
 *
 * Note what is not here: a `status`. The payload says the cancel was accepted
 * and nothing about what the job was doing, which is the whole reason
 * {@link cancelJob} has to look before it acts.
 */
const CancelPayloadSchema = z.looseObject({
  prompt_id: z.string(),
  where: z.string().nullable().optional(),
  /** Whether the CLI could prove the job existed before mutating anything. */
  found: z.boolean().optional(),
  queue_delete_ok: z.boolean().optional(),
  interrupt_ok: z.boolean().optional(),
});

/** A snapshot of one job. */
export interface JobStatus {
  promptId: string;
  /**
   * `running`, `pending`, `queued`, `completed`, `error`, `cancelled` — and
   * whatever upstream adds next. An **open string**: see
   * {@link JobStatusPayloadSchema}.
   */
  status: string;
  /**
   * Whether {@link status} is one `comfy` treats as finished. Derived here so
   * that no caller has to keep its own copy of the terminal set — the mistake
   * `comfy/target.ts` exists to have stopped happening twice.
   */
  terminal: boolean;
  /** `null` from `jobs status`, which never reports one. */
  queuePosition: number | null;
  /** Node count of the submitted graph, where the CLI knew it. */
  workflowSize: number | null;
  /**
   * The artifacts, split by kind. A live-server status reports `/view?...`
   * URLs; a status served from a state file after the server stopped can hold
   * the absolute paths `run` recorded — so both forms reach a caller through
   * this one field, and `comfy/outputs.ts` holds the rule that tells them
   * apart. Split the same way `run_workflow` splits them, because a caller that
   * runs a workflow and then polls the same job must not be handed the same two
   * strings in two shapes.
   */
  outputs: ClassifiedOutputs;
  /** The server's diagnosis of a failure, or `null`. */
  error: unknown;
  /** The CLI's own resolution of the target. */
  host: string | null;
  port: number | null;
}

/** One row of a listing. */
export interface JobSummary {
  promptId: string;
  /** An open string, and `terminal` is derived from it — see {@link JobStatus}. */
  status: string;
  terminal: boolean;
  queuePosition: number | null;
  workflowSize: number | null;
  /** How many artifacts the job produced. `jobs ls` reports a count, not paths. */
  outputCount: number | null;
  /** `local` or `cloud`, as the CLI recorded the job's routing target. */
  where: string | null;
  /**
   * The workflow file the job was submitted from, where that path is still
   * usable — so in practice, a job somebody else submitted.
   *
   * `null` for every job **this** server submitted, and that is not a gap: the
   * CLI records the absolute path it was handed, `run_workflow` hands it a
   * private copy, and that copy is deleted the moment the run returns. Reporting
   * it would name a UUID directory that no longer exists and invite a caller to
   * open it. The run's own result carries `source`, the caller's real file,
   * which is the answer this field cannot give.
   */
  workflowPath: string | null;
  updatedAt: string | null;
}

export interface JobListing {
  /**
   * How many rows this listing carries. Derived from the array rather than read
   * from the payload's own tally, so it cannot disagree with what a caller
   * iterating `jobs` will see.
   */
  count: number;
  jobs: JobSummary[];
  /** Which state-file rows were included: the resolved target, or `all`. */
  scope: string | null;
  host: string | null;
  port: number | null;
}

export interface JobsOptions {
  /** ComfyUI's address, defaulting to `127.0.0.1`. */
  host?: string;
  /** Defaults to `8188`. */
  port?: number;
  /** Budget for the CLI call. Defaults to `runComfy`'s 120 seconds. */
  timeoutMs?: number;
}

export interface ListJobsOptions extends JobsOptions {
  /** How many rows to return. Defaults to the CLI's own 10. */
  limit?: number;
}

/**
 * What a cancel actually did.
 *
 * A discriminated union rather than a boolean or a bare success, because
 * `comfy jobs cancel` answers all three of these the same way and the
 * difference is the only thing the caller asked about:
 *
 * - `cancelled` — the job was live when this call looked, and the cancel was
 *   sent. `previousStatus` is `null` where the job could not be observed first.
 * - `already_finished` — the job had reached a terminal state, so there was
 *   nothing to stop. **Not an error**: the CLI is idempotent for known jobs,
 *   and reporting this as a failure would train a caller to ignore failures.
 * - `not_found` — no such job anywhere the CLI can see. The CLI's own
 *   `prompt_not_found` diagnosis is carried whole rather than flattened to a
 *   boolean, so its message, hint, `where` and details survive.
 *
 * The union shape is what makes each arm carry exactly what it can know:
 * `already_finished` always has the terminal status, `not_found` always has the
 * error, and neither can be read off the wrong arm.
 */
export type CancelResult =
  | { outcome: "cancelled"; promptId: string; previousStatus: string | null }
  | { outcome: "already_finished"; promptId: string; previousStatus: string }
  | { outcome: "not_found"; promptId: string; error: JobError };

/**
 * The CLI's diagnosis, as plain data.
 *
 * **Not the `ComfyCliError` object**, and the difference is not cosmetic. This
 * is the one error in this codebase returned as a *value* rather than thrown,
 * so it is the one that gets serialised on its way to an MCP client — and
 * `Error.prototype.message` is non-enumerable, so `JSON.stringify` of an
 * `Error` silently drops the very field that says what went wrong. Every own
 * property here is enumerable, so what a caller reads is what a caller sends.
 */
export interface JobError {
  /** The CLI's error code, from an append-only registry. */
  code: string;
  message: string;
  hint: string | null;
  /** The CLI's local-vs-cloud routing target. */
  where: string | null;
  details: unknown;
}

/**
 * A `prompt_id` could not be used as one: it starts with `-`.
 *
 * Thrown before anything is spawned. A `prompt_id` travels as a bare CLI
 * positional (`jobs status <prompt_id>`, `jobs cancel <prompt_id>`), placed by
 * {@link jobsArgs} ahead of this module's own `--host`/`--port` — and a token
 * beginning with `-` is not read as a positional by the CLI's argument
 * parser, it is read as another flag. Verified live, twice: `jobs status
 * --host` (this module's own construction for `getJobStatus("--host", {host:
 * "127.0.0.1", port: 9})`) reported `"ComfyUI not running on --host:9"` — the
 * caller's `"--host"` consumed this module's real `--host 127.0.0.1` as that
 * flag's own value, and the real host and port never took effect. A real
 * `prompt_id` is a UUID and never starts with `-`.
 */
export class InvalidPromptIdError extends Error {
  override readonly name = "InvalidPromptIdError";
  readonly promptId: string;

  constructor(promptId: string) {
    super(
      `cannot use ${JSON.stringify(promptId)} as a prompt_id: it starts with \`-\`, which the ` +
        `CLI's argument parser reads as another flag rather than the job id — verified live, this ` +
        `can override --host/--port instead of naming a job. A real prompt_id is a UUID and never ` +
        `starts with \`-\`; get one from run_workflow or jobs ls.`,
    );
    this.promptId = promptId;
  }
}

/**
 * Refuse a `prompt_id` before it is spawned as a CLI positional. See
 * {@link InvalidPromptIdError}.
 */
function validatePromptId(promptId: string): void {
  if (promptId.startsWith("-")) throw new InvalidPromptIdError(promptId);
}

/** Flatten a thrown CLI error into something that survives serialisation. */
function toJobError(err: ComfyCliError): JobError {
  return {
    code: err.code,
    message: err.message,
    hint: err.hint,
    where: err.where,
    details: err.details,
  };
}

/**
 * The CLI answered, but with something this server cannot read as a job.
 *
 * Distinct from {@link ComfyCliError} on purpose, exactly as
 * `workflows/slots.ts` keeps them apart: that is the CLI reporting a failure it
 * understood and diagnosed, this is the contract itself not holding, and an
 * operator can only act on the difference if it is kept.
 */
export class JobPayloadError extends Error {
  override readonly name = "JobPayloadError";
  /** The failing command as the CLI names it, e.g. `"jobs status"`. */
  readonly command: string;

  constructor(command: string, data: unknown, cause: z.ZodError) {
    super(
      `comfy ${command} returned a payload this server could not read\n` +
        `  received: ${snippet(describe(data))}\n${z.prettifyError(cause)}`,
      { cause },
    );
    this.command = command;
  }
}

/** The payload came from `JSON.parse`, so it cannot be cyclic. */
function describe(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

/**
 * The invocation. Root flags first (landmine #3), then the subcommand, then the
 * target — always sent, even at its defaults, so it never depends on whatever
 * workspace config the CLI happens to find. `--skip-prompt` is `runComfy`'s to
 * prepend; adding it here would repeat it.
 */
function jobsArgs(sub: string, rest: string[], opts: JobsOptions): string[] {
  return [
    JSON_MODE,
    "jobs",
    sub,
    ...rest,
    "--host",
    resolveHost(opts.host), // landmine #10: a bind address is not a connect one
    "--port",
    String(opts.port ?? DEFAULT_PORT),
  ];
}

/**
 * Whether a status is one `comfy` treats as finished.
 *
 * Exported because `workflows/run.ts` reports a status too, and a run that says
 * it is over while a poll of the same job says it is not would be a difference
 * nothing could explain. One set, one predicate.
 */
export function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * A workflow path a caller could actually open, or `null`.
 *
 * See {@link JobSummary.workflowPath}: for jobs this server submitted, the
 * recorded path is a temp copy that `runWorkflow` has already deleted.
 */
function usableWorkflowPath(path: string | null | undefined): string | null {
  if (path === undefined || path === null) return null;
  return isPreparedCopy(path) ? null : path;
}

/**
 * The status of one job.
 *
 * `prompt_not_found` is **thrown**, not returned: this call asks one question
 * and that error is the CLI's answer to it, carrying its own hint about pruned
 * history. Only {@link cancelJob} reclassifies the code, and only because an
 * idempotent cancel must not read as a failure.
 *
 * @throws {JobPayloadError} the CLI's payload was not a job status.
 * @throws {ComfyCliError} the CLI reported a failure — `prompt_not_found` for
 * an id the server does not know, `server_not_running` for a downed server.
 * @throws {ComfyTimeoutError} the call exceeded `timeoutMs`.
 * @throws {ComfyUnavailableError} the `comfy` binary could not be started.
 * @throws {TypeError} `host` was given as an empty string, which would build
 * `http://:8188/` and be reported as an unreachable server.
 * @throws {InvalidPromptIdError} `promptId` starts with `-` and would be read
 * as a flag rather than a positional — see {@link InvalidPromptIdError}.
 */
export async function getJobStatus(promptId: string, opts: JobsOptions = {}): Promise<JobStatus> {
  validatePromptId(promptId);
  const data = await runComfy(jobsArgs("status", [promptId], opts), { timeoutMs: opts.timeoutMs });

  const result = JobStatusPayloadSchema.safeParse(data);
  if (!result.success) throw new JobPayloadError("jobs status", data, result.error);

  const payload = result.data;
  return {
    promptId: payload.prompt_id,
    status: payload.status,
    terminal: isTerminal(payload.status),
    queuePosition: payload.queue_position ?? null,
    workflowSize: payload.workflow_size ?? null,
    outputs: classifyOutputs(payload.outputs ?? []),
    error: payload.error ?? null,
    host: payload.host ?? null,
    port: payload.port ?? null,
  };
}

/**
 * Every job the CLI can see: the submits it tracks on disk, merged with the
 * server's queue and history. A job started in the ComfyUI web UI appears here
 * alongside one this server submitted; `where` and `workflowPath` are what tell
 * them apart.
 *
 * @throws {JobPayloadError} the CLI's payload was not a listing.
 * @throws {ComfyCliError} the CLI reported a failure.
 * @throws {ComfyTimeoutError} the call exceeded `timeoutMs`.
 * @throws {ComfyUnavailableError} the `comfy` binary could not be started.
 * @throws {TypeError} `host` was given as an empty string, which would build
 * `http://:8188/` and be reported as an unreachable server.
 */
export async function listJobs(opts: ListJobsOptions = {}): Promise<JobListing> {
  const limit = String(opts.limit ?? DEFAULT_LIMIT);
  const data = await runComfy(jobsArgs("ls", ["--limit", limit], opts), {
    timeoutMs: opts.timeoutMs,
  });

  const result = JobListPayloadSchema.safeParse(data);
  if (!result.success) throw new JobPayloadError("jobs ls", data, result.error);

  const payload = result.data;
  return {
    count: payload.jobs.length,
    jobs: payload.jobs.map((row) => ({
      promptId: row.prompt_id,
      status: row.status,
      terminal: isTerminal(row.status),
      queuePosition: row.queue_position ?? null,
      workflowSize: row.workflow_size ?? null,
      outputCount: row.outputs ?? null,
      where: row.where ?? null,
      workflowPath: usableWorkflowPath(row.workflow_path),
      updatedAt: row.updated_at ?? null,
    })),
    scope: payload.scope ?? null,
    host: payload.host ?? null,
    port: payload.port ?? null,
  };
}

/**
 * The job's status, or `null` if the CLI has no record of it.
 *
 * This is the **only** place a `ComfyCliError` is swallowed in this module, and
 * only this one code. `jobs status` reads the server's queue and history alone,
 * while `jobs cancel` also counts a local state file as proof the job exists —
 * so a job whose history the server has pruned is absent to one and present to
 * the other. The probe's "no such job" is therefore not authoritative and must
 * not decide the outcome; only the cancel's is. Every other code, including
 * `server_not_running`, propagates: the cancel could not have succeeded either.
 */
async function probeStatus(promptId: string, opts: JobsOptions): Promise<JobStatus | null> {
  try {
    return await getJobStatus(promptId, opts);
  } catch (err) {
    if (err instanceof ComfyCliError && err.code === PROMPT_NOT_FOUND) return null;
    throw err;
  }
}

/**
 * Stop a job, and say which of the three things that meant.
 *
 * Two CLI calls, because one cannot answer the question. `comfy jobs cancel`
 * is idempotent for every job it knows, and its payload carries no status, so a
 * cancel that stopped a running job and a cancel that found a completed one are
 * byte-identical. The job is therefore observed first, and the observation is
 * what classifies the outcome.
 *
 * A job already in a terminal state is **not** cancelled: there is no execution
 * to interrupt and no queue entry to delete, so the call would be a round trip
 * of no-ops against a job whose recorded outcome the CLI deliberately leaves
 * alone. Skipping it also keeps the answer honest when the server has since
 * stopped — the state file still knows the job finished, where a cancel would
 * only be able to report that the server is down.
 *
 * The residual race is a job that finishes between the probe and the cancel: it
 * is reported `cancelled` when nothing was stopped. Unavoidable across two
 * calls, and benign — the cancel is a no-op on a finished job either way.
 *
 * @throws {JobPayloadError} the CLI's payload was not a cancel result.
 * @throws {ComfyCliError} any failure other than `prompt_not_found`, which is
 * returned as the `not_found` arm instead.
 * @throws {ComfyTimeoutError} the call exceeded `timeoutMs`.
 * @throws {ComfyUnavailableError} the `comfy` binary could not be started.
 * @throws {TypeError} `host` was given as an empty string, which would build
 * `http://:8188/` and be reported as an unreachable server.
 * @throws {InvalidPromptIdError} `promptId` starts with `-` and would be read
 * as a flag rather than a positional — see {@link InvalidPromptIdError}.
 * Checked here too, not only transitively through {@link getJobStatus}: this
 * function's own second CLI call (`jobs cancel`) takes the same positional,
 * and the guard must not depend on the probe running first.
 */
export async function cancelJob(promptId: string, opts: JobsOptions = {}): Promise<CancelResult> {
  validatePromptId(promptId);
  const observed = await probeStatus(promptId, opts);
  if (observed !== null && observed.terminal) {
    return { outcome: "already_finished", promptId, previousStatus: observed.status };
  }

  let data: unknown;
  try {
    data = await runComfy(jobsArgs("cancel", [promptId], opts), { timeoutMs: opts.timeoutMs });
  } catch (err) {
    // The second and last reclassification: an id that names no job is an
    // answer to the caller's question, not a fault, and the CLI's own error is
    // carried whole on the arm rather than being flattened away.
    if (err instanceof ComfyCliError && err.code === PROMPT_NOT_FOUND) {
      // Flattened, not carried as the Error object: this arm is returned rather
      // than thrown, so it will be serialised, and an Error's `message` is
      // non-enumerable — see {@link JobError}.
      return { outcome: "not_found", promptId, error: toJobError(err) };
    }
    throw err;
  }

  const result = CancelPayloadSchema.safeParse(data);
  if (!result.success) throw new JobPayloadError("jobs cancel", data, result.error);

  return { outcome: "cancelled", promptId, previousStatus: observed?.status ?? null };
}
