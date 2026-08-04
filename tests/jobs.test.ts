import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComfyCliError } from "../src/comfy/exec";
import { JobPayloadError, cancelJob, getJobStatus, listJobs } from "../src/comfy/jobs";

/**
 * No test in this file may invoke a real `comfy`, reach a real ComfyUI, or
 * cancel a real job: `COMFY_BIN` points at the sh fixture for every one of
 * them, and every payload these tests decode is written by the test itself.
 */
const FAKE_COMFY = join(import.meta.dir, "fixtures", "fake-comfy");

const PROMPT_ID = "9b1c7d2e-0000-4000-8000-000000000001";
const OTHER_ID = "9b1c7d2e-0000-4000-8000-000000000002";

/**
 * `jobs status` builds its output entries as `/view` URLs against the host it
 * queried (`_snapshot` in comfy_cli/command/jobs.py), so this is the form a
 * live-server status reports.
 */
const OUTPUT_URL = "http://127.0.0.1:8188/view?filename=banana_00001_.png&subfolder=&type=output";

type Subcommand = "status" | "ls" | "cancel";

let workdir: string;
let argvOut: string;
let argvLog: string;

const FIXTURE_ENV = [
  "COMFY_BIN",
  "FAKE_COMFY_MODE",
  "FAKE_COMFY_ARGV_OUT",
  "FAKE_COMFY_ARGV_LOG",
  "FAKE_COMFY_JOBS_STATUS_FILE",
  "FAKE_COMFY_JOBS_STATUS_ERROR",
  "FAKE_COMFY_JOBS_LS_FILE",
  "FAKE_COMFY_JOBS_LS_ERROR",
  "FAKE_COMFY_JOBS_CANCEL_FILE",
  "FAKE_COMFY_JOBS_CANCEL_ERROR",
];

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "mcp-comfyui-jobs-"));
  argvOut = join(workdir, "argv");
  argvLog = join(workdir, "argv.log");
  process.env.COMFY_BIN = FAKE_COMFY;
  process.env.FAKE_COMFY_MODE = "jobs";
  process.env.FAKE_COMFY_ARGV_OUT = argvOut;
  process.env.FAKE_COMFY_ARGV_LOG = argvLog;
});

afterEach(() => {
  for (const key of FIXTURE_ENV) delete process.env[key];
  rmSync(workdir, { recursive: true, force: true });
});

/** Arm one subcommand of the fake with the `data` it is to answer with. */
function serve(sub: Subcommand, data: unknown): void {
  const path = join(workdir, `${sub}.json`);
  writeFileSync(path, JSON.stringify(data));
  process.env[`FAKE_COMFY_JOBS_${sub.toUpperCase()}_FILE`] = path;
}

/** Arm one subcommand of the fake with a failure envelope carrying `code`. */
function serveError(sub: Subcommand, code: string): void {
  process.env[`FAKE_COMFY_JOBS_${sub.toUpperCase()}_ERROR`] = code;
}

/** The argv of the last invocation, flattened as the sibling suites do. */
function argv(): string[] {
  return readFileSync(argvOut, "utf8").trim().split(" ");
}

/** Every invocation's argv, in order — a cancel makes more than one. */
function invocations(): string[][] {
  if (!existsSync(argvLog)) return [];
  return readFileSync(argvLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => line.split(" "));
}

/** The `comfy jobs <sub>` each invocation carried. */
function subcommands(): string[] {
  return invocations().map((args) => args[args.indexOf("jobs") + 1] ?? "");
}

/** `_snapshot`'s queue branch: the prompt the server is executing right now. */
function runningStatus(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prompt_id: PROMPT_ID,
    status: "running",
    workflow_size: 12,
    outputs: [],
    outputs_by_node: {},
    outputs_by_item: {},
    host: "127.0.0.1",
    port: 8188,
    ...over,
  };
}

/** `_snapshot`'s history branch: a finished prompt and its artifacts. */
function completedStatus(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prompt_id: PROMPT_ID,
    status: "completed",
    workflow_size: null,
    outputs: [OUTPUT_URL],
    outputs_by_node: { "9": [OUTPUT_URL] },
    outputs_by_item: {},
    error: null,
    host: "127.0.0.1",
    port: 8188,
    ...over,
  };
}

/**
 * One row of `jobs ls`. Note `outputs`: on a row it is a **count**, where the
 * same key on a `jobs status` payload is the artifact list. `_row_to_dict` also
 * emits `where`, `workflow_path` and `updated_at`, none of which the copied
 * schema declares.
 */
function jobRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prompt_id: PROMPT_ID,
    status: "running",
    queue_position: null,
    workflow_size: 12,
    outputs: 0,
    where: "local",
    workflow_path: "/Users/lawls/ComfyUI-Shared/user/default/workflows/flow.json",
    updated_at: "2026-08-02T12:00:00",
    ...over,
  };
}

/** `ls_cmd`'s payload: the state-file rows merged with the server's own. */
function listing(
  jobs: Record<string, unknown>[],
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    host: "127.0.0.1",
    port: 8188,
    where: "local",
    scope: "local",
    count: jobs.length,
    jobs,
    ...over,
  };
}

/** `_local_cancel`'s payload. It carries no `status`, which is the whole problem. */
function cancelled(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prompt_id: PROMPT_ID,
    where: "local",
    host: "127.0.0.1",
    port: 8188,
    found: true,
    queue_delete_ok: true,
    interrupt_ok: true,
    ...over,
  };
}

/** Await a promise that must reject, and hand back what it rejected with. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to reject, but it resolved");
}

// --- status --------------------------------------------------------------

test("a running job reports its status and nothing it has not produced yet", async () => {
  serve("status", runningStatus());

  const job = await getJobStatus(PROMPT_ID);

  expect(job.promptId).toBe(PROMPT_ID);
  expect(job.status).toBe("running");
  expect(job.terminal).toBe(false);
  expect(job.outputs).toEqual([]);
  expect(job.workflowSize).toBe(12);
  // `jobs status` never emits one — only `jobs ls` rows carry a queue position.
  expect(job.queuePosition).toBeNull();
  expect(job.error).toBeNull();
});

test("a completed job carries its outputs and reads as terminal", async () => {
  serve("status", completedStatus());

  const job = await getJobStatus(PROMPT_ID);

  expect(job.status).toBe("completed");
  expect(job.terminal).toBe(true);
  expect(job.outputs).toEqual([OUTPUT_URL]);
  expect(job.host).toBe("127.0.0.1");
  expect(job.port).toBe(8188);
});

test("a failed job keeps the server's own diagnosis rather than a bare status", async () => {
  serve(
    "status",
    completedStatus({
      status: "error",
      outputs: [],
      error: { node_id: "3", exception_message: "CUDA out of memory" },
    }),
  );

  const job = await getJobStatus(PROMPT_ID);

  expect(job.status).toBe("error");
  expect(job.terminal).toBe(true);
  expect(job.error).toEqual({ node_id: "3", exception_message: "CUDA out of memory" });
});

test("an unknown id is the CLI's own prompt_not_found, not a resolved absence", async () => {
  serveError("status", "prompt_not_found");

  const err = await rejection(getJobStatus(PROMPT_ID));

  // `getJobStatus` asks one question and this is the CLI's answer to it, with
  // its own hint about pruned history attached. Only `cancelJob` reclassifies
  // this code, and only because an idempotent cancel must not read as failure.
  expect(err).toBeInstanceOf(ComfyCliError);
  expect((err as ComfyCliError).code).toBe("prompt_not_found");
});

test("a downed server is not softened into a missing job", async () => {
  serveError("status", "server_not_running");

  const err = await rejection(getJobStatus(PROMPT_ID));

  expect(err).toBeInstanceOf(ComfyCliError);
  expect((err as ComfyCliError).code).toBe("server_not_running");
});

test("a payload that is not a job status is refused with the payload quoted", async () => {
  serve("status", { host: "127.0.0.1", port: 8188 }); // no prompt_id, no status

  const err = await rejection(getJobStatus(PROMPT_ID));

  expect(err).toBeInstanceOf(JobPayloadError);
  const message = (err as Error).message;
  expect(message).toContain("prompt_id");
  expect(message).toContain("status");
  expect(message).toContain(`{"host":"127.0.0.1","port":8188}`);
});

// --- the status registry is append-only ----------------------------------

test("a status nobody has published parses, and counts as still running", async () => {
  // `allocated` and `executing` are both named in JobRow's own docstring and
  // neither is in schema.jobs.json's enum. An unrecognised status must degrade
  // to "not known to be finished", never fail the call.
  serve("status", runningStatus({ status: "allocated" }));

  const job = await getJobStatus(PROMPT_ID);

  expect(job.status).toBe("allocated");
  expect(job.terminal).toBe(false);
});

test("cancelled is terminal even though the published enum omits it", async () => {
  serve("status", completedStatus({ status: "cancelled", outputs: [] }));

  const job = await getJobStatus(PROMPT_ID);

  expect(job.status).toBe("cancelled");
  expect(job.terminal).toBe(true);
});

// --- listing --------------------------------------------------------------

test("an empty listing is an empty array and a zero count, not a missing field", async () => {
  serve("ls", listing([]));

  const result = await listJobs();

  expect(result.jobs).toEqual([]);
  expect(result.count).toBe(0);
  expect(result.scope).toBe("local");
});

test("several jobs come back in the order the CLI merged them", async () => {
  serve(
    "ls",
    listing([
      jobRow({ status: "running" }),
      jobRow({ prompt_id: OTHER_ID, status: "pending", queue_position: 1, outputs: 0 }),
      jobRow({ prompt_id: "aaa", status: "completed", outputs: 2, workflow_size: 7 }),
      // A job started in the ComfyUI web UI: the server knows it, no state file
      // does, so it has neither a workflow path nor an update time.
      jobRow({ prompt_id: "bbb", status: "error", workflow_path: null, updated_at: null }),
    ]),
  );

  const result = await listJobs();

  expect(result.count).toBe(4);
  expect(result.jobs.map((job) => job.promptId)).toEqual([PROMPT_ID, OTHER_ID, "aaa", "bbb"]);
  expect(result.jobs.map((job) => job.status)).toEqual([
    "running",
    "pending",
    "completed",
    "error",
  ]);
  expect(result.jobs.map((job) => job.terminal)).toEqual([false, false, true, true]);
  expect(result.jobs[1]?.queuePosition).toBe(1);
  expect(result.jobs[3]?.workflowPath).toBeNull();
});

test("a row's `outputs` is a count, and is named so it cannot be read as the artifacts", async () => {
  // The same key is an array of URLs on a `jobs status` payload. Carrying both
  // through under one name is how a caller ends up iterating the number 2.
  serve("ls", listing([jobRow({ outputs: 2 })]));

  const result = await listJobs();

  expect(result.jobs[0]?.outputCount).toBe(2);
});

test("the count is derived from the array, so the two cannot disagree", async () => {
  serve("ls", listing([jobRow(), jobRow({ prompt_id: OTHER_ID })], { count: 99 }));

  const result = await listJobs();

  expect(result.count).toBe(2);
});

test("a listing that is not a listing is refused", async () => {
  serve("ls", { host: "127.0.0.1", port: 8188, count: 0 }); // no `jobs`

  const err = await rejection(listJobs());

  expect(err).toBeInstanceOf(JobPayloadError);
  expect((err as Error).message).toContain("jobs");
});

test("a row missing its status is refused rather than listed as undefined", async () => {
  serve("ls", listing([{ prompt_id: PROMPT_ID }]));

  const err = await rejection(listJobs());

  expect(err).toBeInstanceOf(JobPayloadError);
  expect((err as Error).message).toContain("status");
});

// --- cancellation ---------------------------------------------------------

test("cancelling a running job reports that it was stopped", async () => {
  serve("status", runningStatus());
  serve("cancel", cancelled());

  const result = await cancelJob(PROMPT_ID);

  expect(result.outcome).toBe("cancelled");
  if (result.outcome !== "cancelled") throw new Error("unreachable");
  expect(result.promptId).toBe(PROMPT_ID);
  expect(result.previousStatus).toBe("running");
  expect(subcommands()).toEqual(["status", "cancel"]);
});

test("cancelling a finished job is not an error, and does not claim to have stopped it", async () => {
  serve("status", completedStatus());
  serve("cancel", cancelled());

  const result = await cancelJob(PROMPT_ID);

  // The CLI is idempotent for known jobs, so this succeeds either way — which
  // is exactly why the outcome has to say which of the two happened.
  expect(result.outcome).toBe("already_finished");
  if (result.outcome !== "already_finished") throw new Error("unreachable");
  expect(result.previousStatus).toBe("completed");
  // ...and nothing was sent: there is no execution to interrupt and no queue
  // entry to delete, so the cancel would have been a round trip of no-ops.
  expect(subcommands()).toEqual(["status"]);
});

test("cancelling an already-cancelled job says so instead of cancelling it twice", async () => {
  serve("status", completedStatus({ status: "cancelled", outputs: [] }));
  serve("cancel", cancelled());

  const result = await cancelJob(PROMPT_ID);

  expect(result.outcome).toBe("already_finished");
  if (result.outcome !== "already_finished") throw new Error("unreachable");
  expect(result.previousStatus).toBe("cancelled");
});

test("an id the CLI has never heard of is reported as unknown, not as a cancel", async () => {
  serveError("status", "prompt_not_found");
  serveError("cancel", "prompt_not_found");

  const result = await cancelJob(PROMPT_ID);

  expect(result.outcome).toBe("not_found");
  if (result.outcome !== "not_found") throw new Error("unreachable");
  // The CLI's own diagnosis survives the reclassification: code, message, hint,
  // `where` and details are all still there for whoever has to act on it.
  expect(result.error).toBeInstanceOf(ComfyCliError);
  expect(result.error.code).toBe("prompt_not_found");
  expect(subcommands()).toEqual(["status", "cancel"]);
});

test("a job the server has forgotten but the CLI still tracks is cancelled, not unknown", async () => {
  // `jobs status` reads the server's queue and history alone; `jobs cancel`
  // also counts a local state file as proof the job exists. So the probe's
  // absence verdict is not authoritative and only the cancel's is.
  serveError("status", "prompt_not_found");
  serve("cancel", cancelled());

  const result = await cancelJob(PROMPT_ID);

  expect(result.outcome).toBe("cancelled");
  if (result.outcome !== "cancelled") throw new Error("unreachable");
  expect(result.previousStatus).toBeNull();
});

test("a status nobody has published is cancelled rather than assumed finished", async () => {
  serve("status", runningStatus({ status: "some_future_state" }));
  serve("cancel", cancelled());

  const result = await cancelJob(PROMPT_ID);

  expect(result.outcome).toBe("cancelled");
  expect(subcommands()).toEqual(["status", "cancel"]);
});

test("a cancel that genuinely failed still throws", async () => {
  serve("status", runningStatus());
  serveError("cancel", "cancel_failed");

  const err = await rejection(cancelJob(PROMPT_ID));

  expect(err).toBeInstanceOf(ComfyCliError);
  expect((err as ComfyCliError).code).toBe("cancel_failed");
});

test("a downed server is not swallowed by the status probe", async () => {
  serveError("status", "server_not_running");
  serve("cancel", cancelled());

  const err = await rejection(cancelJob(PROMPT_ID));

  // Only `prompt_not_found` is reclassified. `jobs cancel` refuses outright
  // when the server is down, so softening this would report a cancel that
  // could not possibly have happened.
  expect(err).toBeInstanceOf(ComfyCliError);
  expect((err as ComfyCliError).code).toBe("server_not_running");
  expect(subcommands()).toEqual(["status"]);
});

test("a cancel payload that is not a cancel payload is refused", async () => {
  serve("status", runningStatus());
  serve("cancel", { where: "local" }); // no prompt_id

  const err = await rejection(cancelJob(PROMPT_ID));

  expect(err).toBeInstanceOf(JobPayloadError);
  expect((err as Error).message).toContain("prompt_id");
});

// --- the invocation -------------------------------------------------------

test("global flags precede the subcommand on every jobs call", async () => {
  serve("status", runningStatus());
  await getJobStatus(PROMPT_ID);
  // Landmine #3: `--skip-prompt` and `--json` are Typer root flags, so
  // `comfy jobs status --json` fails where this works. Landmine #2: the mode
  // flag is stated rather than left to stdout auto-detection.
  expect(argv().slice(0, 5)).toEqual(["--skip-prompt", "--json", "jobs", "status", PROMPT_ID]);

  serve("ls", listing([]));
  await listJobs();
  expect(argv().slice(0, 4)).toEqual(["--skip-prompt", "--json", "jobs", "ls"]);

  serve("cancel", cancelled());
  await cancelJob(PROMPT_ID);
  expect(argv().slice(0, 5)).toEqual(["--skip-prompt", "--json", "jobs", "cancel", PROMPT_ID]);
  for (const args of invocations()) {
    expect(args.filter((arg) => arg === "--skip-prompt")).toHaveLength(1);
    expect(args.indexOf("--json")).toBeLessThan(args.indexOf("jobs"));
  }
});

test("the server address is stated rather than left to workspace config", async () => {
  serve("status", runningStatus());
  await getJobStatus(PROMPT_ID);
  expect(argv()[argv().indexOf("--host") + 1]).toBe("127.0.0.1");
  expect(argv()[argv().indexOf("--port") + 1]).toBe("8188");
});

test("the listing size is stated too, so it cannot shift under an upstream default", async () => {
  serve("ls", listing([]));
  await listJobs();
  expect(argv()[argv().indexOf("--limit") + 1]).toBe("10");

  await listJobs({ limit: 50 });
  expect(argv()[argv().indexOf("--limit") + 1]).toBe("50");
});

test("a wildcard bind address is rewritten to a connect address", async () => {
  serve("status", runningStatus());
  await getJobStatus(PROMPT_ID, { host: "0.0.0.0", port: 9000 });
  expect(argv()[argv().indexOf("--host") + 1]).toBe("127.0.0.1"); // landmine #10
  expect(argv()[argv().indexOf("--port") + 1]).toBe("9000");
});

test("the IPv6 wildcard is rewritten too, brackets and all", async () => {
  serve("ls", listing([]));
  await listJobs({ host: "[::]" });
  expect(argv()[argv().indexOf("--host") + 1]).toBe("127.0.0.1");
});

test("both calls a cancel makes are aimed at the same rewritten address", async () => {
  serve("status", runningStatus());
  serve("cancel", cancelled());

  await cancelJob(PROMPT_ID, { host: "0.0.0.0", port: 9000 });

  const targets = invocations().map((args) => args[args.indexOf("--host") + 1]);
  // A probe aimed somewhere other than the cancel would classify one job and
  // stop another.
  expect(targets).toEqual(["127.0.0.1", "127.0.0.1"]);
});

test("a non-default host is passed through untouched", async () => {
  serve("status", runningStatus());
  await getJobStatus(PROMPT_ID, { host: "gpu-box.local", port: 8189 });
  expect(argv()[argv().indexOf("--host") + 1]).toBe("gpu-box.local");
  expect(argv()[argv().indexOf("--port") + 1]).toBe("8189");
});

// --- the fixtures are the real contract -----------------------------------

/** The subset of JSON Schema the copied contracts use. */
interface JsonSchema {
  type?: string | string[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
}

const JOBS_SCHEMA = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "schema.jobs.json"), "utf8"),
) as JsonSchema;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return false;
  }
}

/** Every way `value` departs from `schema`, as readable strings. */
function violations(schema: JsonSchema, value: unknown, path = "$"): string[] {
  const errors: string[] = [];
  const types =
    schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length > 0 && !types.some((type) => matchesType(type, value))) {
    return [`${path}: expected ${types.join("|")}, got ${JSON.stringify(value)}`];
  }
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: expected ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${schema.enum.join(", ")}`);
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, i) => errors.push(...violations(schema.items!, item, `${path}[${i}]`)));
  }
  if (isRecord(value)) {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}: missing required ${key}`);
    }
    for (const [key, sub] of Object.entries(properties)) {
      if (key in value) errors.push(...violations(sub, value[key], `${path}.${key}`));
    }
    const extra = schema.additionalProperties;
    if (isRecord(extra)) {
      for (const [key, sub] of Object.entries(value)) {
        if (!(key in properties)) errors.push(...violations(extra, sub, `${path}.${key}`));
      }
    }
  }
  return errors;
}

test("the status payloads these tests serve are valid jobs.json payloads", () => {
  expect(violations(JOBS_SCHEMA, runningStatus())).toEqual([]);
  expect(violations(JOBS_SCHEMA, completedStatus())).toEqual([]);
});

test("the listings these tests serve are valid jobs.json payloads", () => {
  expect(violations(JOBS_SCHEMA, listing([]))).toEqual([]);
  expect(violations(JOBS_SCHEMA, listing([jobRow(), jobRow({ outputs: 2 })]))).toEqual([]);
});

test("the published status enum already excludes a status the CLI emits", () => {
  // Not a defect in the fixture — a defect in treating the enum as closed.
  // `_snapshot` returns "cancelled" for an interrupted prompt and `_row_to_dict`
  // passes state-file statuses like "allocated" straight through; neither is in
  // the enum. This is what makes the open-string decision checkable.
  expect(violations(JOBS_SCHEMA, completedStatus({ status: "cancelled" }))).not.toEqual([]);
  expect(violations(JOBS_SCHEMA, runningStatus({ status: "allocated" }))).not.toEqual([]);
  // ...and the validator is not simply rejecting everything.
  expect(violations(JOBS_SCHEMA, runningStatus())).toEqual([]);
});

test("the copied schema does not describe `jobs cancel` at all", () => {
  // Its own title says "ls, status, and watch". A cancel payload carries no
  // `status` at all, and the cloud arm carries no `host`/`port` either, so
  // nothing about cancel can be validated against this file — which is why
  // cancel gets its own zod schema written from comfy_cli/command/jobs.py.
  expect(Object.keys(JOBS_SCHEMA.properties ?? {})).not.toContain("found");
  const cloudCancel = { prompt_id: PROMPT_ID, where: "cloud", base_url: "https://api.comfy.org" };
  expect(violations(JOBS_SCHEMA, cloudCancel)).toEqual([
    "$: missing required host",
    "$: missing required port",
  ]);
});
