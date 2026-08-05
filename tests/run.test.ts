import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvelopeParseError } from "../src/comfy/envelope";
import { ComfyCliError, ComfyTimeoutError } from "../src/comfy/exec";
import { RunContractError, RunFailedError, runWorkflow } from "../src/workflows/run";
import { applySlots, type PreparedWorkflow } from "../src/workflows/setSlots";

/**
 * No test in this file may invoke a real `comfy`, reach a real ComfyUI, or run
 * a real workflow: `COMFY_BIN` points at the sh fixture for every one of them,
 * and every byte of NDJSON these tests decode is written by the test itself.
 */
const FAKE_COMFY = join(import.meta.dir, "fixtures", "fake-comfy");

/** How `workflows/setSlots.ts` names the temp directories it creates. */
const TEMP_PREFIX = "mcp-comfyui-apply-";

const PROMPT_ID = "9b1c7d2e-0000-4000-8000-000000000001";

/**
 * 2^64−1, the largest seed ComfyUI accepts, and the value `JSON.parse` cannot
 * hold: it arrives as `ROUNDED_SEED` instead. It is in these fixtures because
 * `comfy run --json` really does hand the whole graph back on every run.
 */
const HUGE_SEED = "18446744073709551615";
const ROUNDED_SEED = "18446744073709552000";

/**
 * The two forms `outputs[]` takes. A loopback run with a resolvable workspace
 * emits absolute paths; anything else emits `/view?...` URLs
 * (`run/execution.py`, and `docs/json-output.md:253`).
 */
const OUTPUT_PATH = "/Users/lawls/ComfyUI/output/banana_00001_.png";
const OUTPUT_URL =
  "http://127.0.0.1:8188/view?filename=banana_00002_.png&subfolder=&type=output";

let workdir: string;
let argvOut: string;
let source: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "mcp-comfyui-run-"));
  argvOut = join(workdir, "argv");
  source = join(workdir, "flow.json");
  writeFileSync(source, `{"nodes":[{"id":3,"type":"KSampler"}],"links":[]}`);
  process.env.COMFY_BIN = FAKE_COMFY;
  process.env.FAKE_COMFY_ARGV_OUT = argvOut;
  preexistingTempDirs = snapshotTempDirs();
});

afterEach(() => {
  delete process.env.COMFY_BIN;
  delete process.env.FAKE_COMFY_MODE;
  delete process.env.FAKE_COMFY_ARGV_OUT;
  delete process.env.FAKE_COMFY_STREAM_FILE;
  delete process.env.FAKE_COMFY_STDERR;
  delete process.env.FAKE_COMFY_EXIT;
  delete process.env.FAKE_COMFY_HANG;
  rmSync(workdir, { recursive: true, force: true });
  for (const name of leakedTempDirs()) {
    rmSync(join(tmpdir(), name), { recursive: true, force: true });
  }
});

/** Prepare-step temp directories that existed before this test began. */
let preexistingTempDirs = new Set<string>();

function snapshotTempDirs(): Set<string> {
  return new Set(readdirSync(tmpdir()).filter((name) => name.startsWith(TEMP_PREFIX)));
}

/**
 * Temp directories THIS test created and nobody cleaned up.
 *
 * Scoped against a `beforeEach` snapshot rather than sweeping the whole prefix:
 * `tmpdir()` is shared, bun runs test files concurrently, and two other test
 * files create directories under this same prefix. An unscoped sweep deletes a
 * sibling file's live fixtures mid-test, which surfaces as a transient ENOENT
 * that never reproduces when either file is run alone.
 */
function leakedTempDirs(): string[] {
  return readdirSync(tmpdir()).filter(
    (name) => name.startsWith(TEMP_PREFIX) && !preexistingTempDirs.has(name),
  );
}

/** The argv the fake was invoked with, flattened as the sibling suites do. */
function argv(): string[] {
  return readFileSync(argvOut, "utf8").trim().split(" ");
}

/**
 * A workflow ready to run. `applySlots` with no inputs never spawns the CLI, so
 * this is a real {@link PreparedWorkflow} — temp copy, `dispose` and all — with
 * nothing of the fake's behaviour mixed into the run under test.
 */
function prepare(): Promise<PreparedWorkflow> {
  return applySlots(source);
}

/** Serve exact bytes as `comfy run --json`'s stdout. */
function serveStream(stdout: string, opts: { stderr?: string; exit?: number } = {}): void {
  const path = join(workdir, "stream.ndjson");
  writeFileSync(path, stdout);
  process.env.FAKE_COMFY_MODE = "run_stream";
  process.env.FAKE_COMFY_STREAM_FILE = path;
  if (opts.stderr !== undefined) process.env.FAKE_COMFY_STDERR = opts.stderr;
  if (opts.exit !== undefined) process.env.FAKE_COMFY_EXIT = String(opts.exit);
}

/** One `event/1` line. */
function event(type: string, fields: Record<string, unknown> = {}): string {
  return JSON.stringify({ schema: "event/1", type, ...fields });
}

/** The final `envelope/1` line of a successful run. */
function envelopeLine(data: unknown): string {
  return JSON.stringify({
    schema: "envelope/1",
    type: "envelope",
    ok: true,
    command: "run",
    version: "0.0.0",
    where: "local",
    data,
    error: null,
  });
}

/** The final `envelope/1` line of a failed run. */
function failureLine(error: {
  code: string;
  message: string;
  hint?: string | null;
  details?: unknown;
}): string {
  return JSON.stringify({
    schema: "envelope/1",
    type: "envelope",
    ok: false,
    command: "run",
    version: "0.0.0",
    where: "local",
    data: null,
    error: { hint: null, details: null, ...error },
  });
}

/** The `data` of a `--wait` run that finished, per `schema.run.json`. */
function completedPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workflow: "flow",
    status: "completed",
    prompt_id: PROMPT_ID,
    client_id: "b7f0e1c2",
    outputs: [OUTPUT_PATH, OUTPUT_URL],
    outputs_by_node: { "9": [OUTPUT_PATH] },
    outputs_by_item: {},
    elapsed_seconds: 4.25,
    host: "127.0.0.1",
    port: 8188,
    ...over,
  };
}

/** The `data` of the default async submit, per `schema.run.json`. */
function queuedPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workflow: "flow",
    status: "queued",
    prompt_id: PROMPT_ID,
    client_id: "b7f0e1c2",
    outputs: [],
    elapsed_seconds: null,
    host: "127.0.0.1",
    port: 8188,
    ...over,
  };
}

/** The event lines a real `--wait` run emits before its envelope. */
function completedEvents(): string[] {
  return [
    event("queued", { prompt_id: PROMPT_ID, client_id: "b7f0e1c2" }),
    event("executing", {
      node: "3",
      title: "KSampler",
      class_type: "KSampler",
      prompt_id: PROMPT_ID,
    }),
    event("progress", { node: "3", completed: 4, total: 20, prompt_id: PROMPT_ID }),
    event("execution_cached", { node: "4", title: "Load Checkpoint", prompt_id: PROMPT_ID }),
    event("executed", { node: "9", title: "Save Image", prompt_id: PROMPT_ID }),
    event("output", { url: OUTPUT_URL, prompt_id: PROMPT_ID }),
  ];
}

/** A complete, well-formed `--wait` stream: events, then the final envelope. */
function completedStream(): string {
  return `${[...completedEvents(), envelopeLine(completedPayload())].join("\n")}\n`;
}

/** Await a promise that must reject, and hand back what it rejected with. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected runWorkflow to reject, but it resolved");
}

// --- the invocation ------------------------------------------------------

test("runs the prepared copy in JSON mode and never the caller's own file", async () => {
  serveStream(completedStream());
  const prepared = await prepare();
  const temp = prepared.path;

  await runWorkflow(prepared);

  const captured = argv();
  // Landmine #3: the Typer root flags must precede the subcommand.
  expect(captured.slice(0, 5)).toEqual(["--skip-prompt", "run", "--workflow", temp, "--json"]);
  expect(captured.filter((arg) => arg === "--skip-prompt")).toHaveLength(1);
  // The user's own file is never handed to `run`; the copy carrying their
  // values is (landmine #1: parameterising is always set-slot then run).
  expect(captured).not.toContain(source);
});

test("submits without --wait by default, which is the CLI's own default", async () => {
  serveStream(`${envelopeLine(queuedPayload())}\n`);
  await runWorkflow(await prepare());
  expect(argv()).not.toContain("--wait");
});

test("blocks with --wait when asked", async () => {
  serveStream(completedStream());
  await runWorkflow(await prepare(), { wait: true });
  expect(argv()).toContain("--wait");
});

test("states the server address rather than leaving it to workspace config", async () => {
  serveStream(completedStream());
  await runWorkflow(await prepare());
  expect(argv()[argv().indexOf("--host") + 1]).toBe("127.0.0.1");
  expect(argv()[argv().indexOf("--port") + 1]).toBe("8188");
});

test("rewrites a wildcard bind address to a connect address", async () => {
  serveStream(completedStream());
  await runWorkflow(await prepare(), { host: "0.0.0.0", port: 9000 });
  expect(argv()[argv().indexOf("--host") + 1]).toBe("127.0.0.1"); // landmine #10
  expect(argv()[argv().indexOf("--port") + 1]).toBe("9000");
});

// --- NDJSON decoding -----------------------------------------------------

test("decodes the stream a line at a time, which whole-buffer parsing cannot", async () => {
  const stdout = completedStream();
  // The landmine itself, asserted rather than described: `comfy run --json`
  // emits NDJSON, so JSON.parse over the whole of stdout throws. A run that
  // resolves from this stdout can only have been parsed line by line.
  expect(() => JSON.parse(stdout)).toThrow();

  serveStream(stdout);
  const result = await runWorkflow(await prepare(), { wait: true });

  expect(result.status).toBe("completed");
  expect(result.events.map((e) => e.type)).toEqual([
    "queued",
    "executing",
    "progress",
    "execution_cached",
    "executed",
    "output",
  ]);
});

test("blank lines and a trailing newline are tolerated", async () => {
  const lines = [...completedEvents(), envelopeLine(completedPayload())];
  // Leading, interleaved, whitespace-only and trailing — NDJSON terminates
  // every line with \n, so the final split always yields an empty one.
  serveStream(`\n${lines.join("\n\n")}\n   \n\n`);

  const result = await runWorkflow(await prepare(), { wait: true });

  expect(result.status).toBe("completed");
  expect(result.events).toHaveLength(6);
  expect(result.unrecognisedLines).toEqual([]);
});

test("an event type absent from the published enum is carried, not fatal", async () => {
  // `prompt_preview` and `converted` are emitted by comfy-cli today and are
  // absent from schema.run_event.json's enum. New types will ship; one must
  // never fail a run that produced images.
  serveStream(
    `${[
      event("converted", { prompt_id: null }),
      event("prompt_preview", { prompt_id: null }),
      event("some_future_event", { node: "3" }),
      ...completedEvents(),
      envelopeLine(completedPayload()),
    ].join("\n")}\n`,
  );

  const result = await runWorkflow(await prepare(), { wait: true });

  expect(result.status).toBe("completed");
  expect(result.events.map((e) => e.type).slice(0, 3)).toEqual([
    "converted",
    "prompt_preview",
    "some_future_event",
  ]);
  expect(result.unrecognisedLines).toEqual([]);
});

test("fields the event contract never declared survive on the event", async () => {
  // `queued` carries `validation_warnings` and `nodes`, neither of which
  // run_event.json declares, and the run then completes normally. Stripping
  // unknown keys would keep the envelope and throw away everything the CLI
  // took the trouble to say.
  serveStream(
    `${[
      event("queued", {
        prompt_id: PROMPT_ID,
        validation_warnings: [{ node_id: "7", message: "input will be ignored" }],
      }),
      envelopeLine(completedPayload()),
    ].join("\n")}\n`,
  );

  const result = await runWorkflow(await prepare(), { wait: true });

  expect(result.events[0]?.validation_warnings).toEqual([
    { node_id: "7", message: "input will be ignored" },
  ]);
});

test("a line that is not JSON is kept as a diagnostic and does not fail the run", async () => {
  serveStream(
    `${[
      "Traceback (most recent call last):",
      ...completedEvents(),
      envelopeLine(completedPayload()),
    ].join("\n")}\n`,
  );

  const result = await runWorkflow(await prepare(), { wait: true });

  expect(result.status).toBe("completed"); // the images exist; report them
  expect(result.unrecognisedLines).toEqual(["Traceback (most recent call last):"]);
});

test("JSON that is neither an event nor an envelope is kept as a diagnostic", async () => {
  serveStream(
    `${[
      JSON.stringify({ nothing: "shaped like an event" }),
      JSON.stringify([1, 2, 3]),
      envelopeLine(completedPayload()),
    ].join("\n")}\n`,
  );

  const result = await runWorkflow(await prepare(), { wait: true });

  expect(result.unrecognisedLines).toHaveLength(2);
  expect(result.events).toEqual([]);
});

test("the diagnostic list is bounded rather than mirroring a flood of stdout", async () => {
  const noise = Array.from({ length: 40 }, (_, i) => `garbage line ${i}`);
  serveStream(`${[...noise, envelopeLine(completedPayload())].join("\n")}\n`);

  const result = await runWorkflow(await prepare(), { wait: true });

  expect(result.status).toBe("completed");
  expect(result.unrecognisedLines.length).toBeLessThanOrEqual(10);
});

// --- the graph must never come back through our JS (landmine #12) ---------

test("the workflow graph on prompt_preview is dropped, digits and all", async () => {
  // `renderer.event("prompt_preview", prompt=workflow)` is unconditional in
  // stream mode, so every run hands the whole graph back — and `JSON.parse` has
  // already rounded every integer in it past 2^53 before this module sees it:
  //
  //   emitted by comfy : 18446744073709551615
  //   after JSON.parse : 18446744073709552000
  //
  // `setSlots.ts` is a byte-copy architecture built to keep our JS away from
  // the graph. Surfacing this field would undo it one layer up: comfy did the
  // submit, so the images are right, and the *report* is wrong. A
  // reproduce-this-render loop reads its seed from that report.
  const graph = `{"3":{"class_type":"KSampler","inputs":{"seed":${HUGE_SEED},"steps":20}}}`;
  serveStream(
    `${[
      `{"schema":"event/1","type":"prompt_preview","prompt":${graph},"prompt_id":null}`,
      ...completedEvents(),
      envelopeLine(completedPayload()),
    ].join("\n")}\n`,
  );

  const result = await runWorkflow(await prepare(), { wait: true });

  const wire = JSON.stringify(result);
  // The corrupted digits must not appear anywhere in what the caller receives.
  expect(wire).not.toContain(ROUNDED_SEED);
  // Nor may the graph be carried "intact" — our JS cannot do that, so the only
  // correct answer is absence, said out loud rather than silently. Asserted on
  // `inputs`, which only a graph has: `class_type` is a declared field of the
  // `executing` event and is legitimately present.
  expect(wire).not.toContain('"inputs"');
  expect(result.events[0]?.type).toBe("prompt_preview");
  expect(result.events[0]?.prompt).toContain("dropped");
  expect(result.events[0]?.prompt).toContain("workflow file");
});

test("a graph arriving under a name nobody has reserved is dropped for its size", async () => {
  // The named drop covers `prompt`; this is the general defence behind it. A
  // field big enough to be a graph cannot be carried into an MCP response
  // whatever it is called, and being dropped is also what keeps its digits out.
  const big = JSON.stringify(
    Object.fromEntries(
      Array.from({ length: 400 }, (_, i) => [String(i), { class_type: "KSampler", seed: HUGE_SEED }]),
    ),
  );
  serveStream(
    `${[
      `{"schema":"event/1","type":"some_future_preview","converted_graph":${big}}`,
      envelopeLine(completedPayload()),
    ].join("\n")}\n`,
  );

  const result = await runWorkflow(await prepare(), { wait: true });

  expect(result.events[0]?.converted_graph).toMatch(/^<dropped: \d+ bytes>$/);
  expect(JSON.stringify(result)).not.toContain("class_type");
});

test("an ordinary undeclared field is still carried whole", async () => {
  // The size rule must not become a reason to lose the traceback: bounding is
  // for graphs, not for the diagnosis.
  serveStream(
    `${[
      event("execution_error", { details: { traceback: "x".repeat(2_000) } }),
      envelopeLine(completedPayload()),
    ].join("\n")}\n`,
  );

  const result = await runWorkflow(await prepare(), { wait: true });

  expect((result.events[0]?.details as { traceback: string }).traceback).toHaveLength(2_000);
});

test("the event list is capped, and says so, rather than mirroring a long run", async () => {
  // Measured before this bound existed: a 400-step run plus one prompt_preview
  // produced 107KB of result JSON, all of it destined for an MCP response.
  const chatty = Array.from({ length: 900 }, (_, i) =>
    event("progress", { node: "3", completed: i, total: 900, prompt_id: PROMPT_ID }),
  );
  serveStream(`${[...chatty, envelopeLine(completedPayload())].join("\n")}\n`);

  const result = await runWorkflow(await prepare(), { wait: true });

  expect(result.eventsTruncated).toBe(true);
  expect(result.events.length).toBeLessThanOrEqual(200);
  // The LAST events are kept. `execution_error` carries the server's traceback
  // and arrives at the end of the run it explains, where the early events are
  // recoverable from the envelope's own payload.
  expect(result.events.at(-1)?.completed).toBe(899);
  expect(JSON.stringify(result).length).toBeLessThan(60_000);
});

test("a short run is not marked truncated", async () => {
  serveStream(completedStream());
  const result = await runWorkflow(await prepare(), { wait: true });
  expect(result.eventsTruncated).toBe(false);
  expect(result.events).toHaveLength(6);
});

test("a truncated run can still be found, because the handle is kept before the cap", async () => {
  // The `queued` event names the job and arrives first, so a naive cap would
  // throw away the one thing a caller needs to recover a run this server can no
  // longer report on.
  const chatty = Array.from({ length: 900 }, () => event("progress", { node: "3" }));
  serveStream(`${[event("queued", { prompt_id: PROMPT_ID }), ...chatty].join("\n")}\n`, {
    exit: 1,
  });

  const err = await rejection(runWorkflow(await prepare(), { wait: true }));

  expect(err).toBeInstanceOf(RunContractError);
  expect((err as Error).message).toContain(PROMPT_ID);
});

// --- outputs -------------------------------------------------------------

test("filesystem paths and http(s) URLs are returned apart, never merged", async () => {
  serveStream(completedStream());

  const result = await runWorkflow(await prepare(), { wait: true });

  // Per docs/json-output.md:253, any non-http(s) value is a filesystem path.
  // A caller that cannot tell them apart cannot open either with confidence.
  expect(result.outputs.files).toEqual([OUTPUT_PATH]);
  expect(result.outputs.urls).toEqual([OUTPUT_URL]);
});

test("https and an uppercase scheme are URLs; anything else is a path", async () => {
  serveStream(
    `${envelopeLine(
      completedPayload({
        outputs: [
          "https://cloud.comfy.org/view/abc.png",
          "HTTP://127.0.0.1:8188/view?filename=x.png",
          "/var/folders/tmp/relative/../out.png",
          "output/banana_00003_.png",
        ],
      }),
    )}\n`,
  );

  const result = await runWorkflow(await prepare(), { wait: true });

  expect(result.outputs.urls).toEqual([
    "https://cloud.comfy.org/view/abc.png",
    "HTTP://127.0.0.1:8188/view?filename=x.png",
  ]);
  expect(result.outputs.files).toEqual([
    "/var/folders/tmp/relative/../out.png",
    "output/banana_00003_.png",
  ]);
});

test("a run with no outputs reports two empty lists, not a missing field", async () => {
  serveStream(`${envelopeLine(completedPayload({ outputs: undefined }))}\n`);
  const result = await runWorkflow(await prepare(), { wait: true });
  expect(result.outputs).toEqual({ files: [], urls: [] });
});

// --- the two modes -------------------------------------------------------

test("a run says whether it is over, using the same rule a later poll will", async () => {
  // `get_job` derives `terminal` from `comfy`'s own TERMINAL_STATUSES. A run
  // and a poll of the same job disagreeing about whether it had finished would
  // be a difference nothing could explain.
  serveStream(completedStream());
  expect((await runWorkflow(await prepare(), { wait: true })).terminal).toBe(true);

  serveStream(`${envelopeLine(queuedPayload())}\n`);
  expect((await runWorkflow(await prepare())).terminal).toBe(false);

  serveStream(`${envelopeLine(completedPayload({ status: "cancelled" }))}\n`);
  expect((await runWorkflow(await prepare(), { wait: true })).terminal).toBe(true);
});

test("the default async submit returns the prompt id as the job handle", async () => {
  serveStream(`${[event("queued", { prompt_id: PROMPT_ID }), envelopeLine(queuedPayload())].join("\n")}\n`);

  const result = await runWorkflow(await prepare());

  expect(result.status).toBe("queued");
  expect(result.promptId).toBe(PROMPT_ID);
  expect(result.outputs).toEqual({ files: [], urls: [] }); // nothing has run yet
  expect(result.elapsedSeconds).toBeNull();
});

test("a --wait run reports elapsed seconds and the prompt id alongside outputs", async () => {
  serveStream(completedStream());
  const result = await runWorkflow(await prepare(), { wait: true });
  expect(result.promptId).toBe(PROMPT_ID);
  expect(result.elapsedSeconds).toBe(4.25);
  expect(result.source).toBe(source); // the caller's file, not the deleted copy
});

test("a queued run with no prompt id is refused, because nothing could poll it", async () => {
  serveStream(`${envelopeLine(queuedPayload({ prompt_id: null }))}\n`);

  const err = await rejection(runWorkflow(await prepare()));

  expect(err).toBeInstanceOf(RunContractError);
  expect((err as Error).message).toContain("queued");
});

test("a status nobody has heard of passes through rather than failing the run", async () => {
  // schema.run.json's status enum is upstream's, and upstream's registries are
  // append-only; `jobs` already knows seven statuses to run's three.
  serveStream(`${envelopeLine(completedPayload({ status: "partially_completed" }))}\n`);

  const result = await runWorkflow(await prepare(), { wait: true });

  expect(result.status).toBe("partially_completed");
  expect(result.outputs.files).toEqual([OUTPUT_PATH]);
});

test("warnings reach the caller with their undeclared fields intact", async () => {
  serveStream(
    `${envelopeLine(
      completedPayload({
        warnings: [
          {
            code: "partial_execution",
            message: "submitted 2 output node(s) but only 1 returned outputs",
            submitted_output_nodes: 2,
            returned_output_nodes: 1,
          },
        ],
      }),
    )}\n`,
  );

  const result = await runWorkflow(await prepare(), { wait: true });

  expect(result.warnings).toHaveLength(1);
  expect(result.warnings[0]?.code).toBe("partial_execution");
  expect(result.warnings[0]?.submitted_output_nodes).toBe(2);
});

test("a run with no warnings reports an empty list", async () => {
  serveStream(completedStream());
  const result = await runWorkflow(await prepare(), { wait: true });
  expect(result.warnings).toEqual([]);
});

// --- failures ------------------------------------------------------------

test("a failure envelope becomes a ComfyCliError carrying the CLI's own code", async () => {
  serveStream(
    `${[
      event("execution_error", {
        prompt_id: PROMPT_ID,
        details: {
          node_id: "3",
          exception_message: "Allocation on device 0 would exceed allowed memory",
          exception_type: "torch.OutOfMemoryError",
          traceback: ['  File "nodes.py", line 1461, in sample\n'],
        },
      }),
      failureLine({
        code: "execution_error",
        message: "Node 3 (KSampler) raised: CUDA out of memory",
        hint: "lower the batch size",
      }),
    ].join("\n")}\n`,
    { exit: 1 },
  );

  const err = await rejection(runWorkflow(await prepare(), { wait: true }));

  expect(err).toBeInstanceOf(RunFailedError);
  expect(err).toBeInstanceOf(ComfyCliError); // callers still branch on `.code`
  const cli = err as RunFailedError;
  expect(cli.code).toBe("execution_error");
  expect(cli.hint).toBe("lower the batch size");
  expect(cli.message).toContain("CUDA out of memory");

  // The half of the diagnosis the envelope does not carry. Upstream is explicit
  // that the event keeps the full server payload while the envelope carries the
  // classified one-line verdict, so decoding the events and then dropping them
  // would leave the caller with the line they could already guess.
  expect(cli.events).toHaveLength(1);
  expect(cli.events[0]?.type).toBe("execution_error");
  expect(cli.events[0]?.details).toMatchObject({
    node_id: "3",
    exception_message: "Allocation on device 0 would exceed allowed memory",
    traceback: ["  File \"nodes.py\", line 1461, in sample\n"],
  });
});

test("a cancelled run surfaces as the CLI's cancelled code, not as exit 130", async () => {
  // Local cancellation is an ok:false envelope with code `cancelled` and exit
  // 130. The envelope is what says so; the exit code is a lossy echo of it.
  serveStream(
    `${failureLine({ code: "cancelled", message: "Workflow execution was interrupted" })}\n`,
    { exit: 130 },
  );

  const err = await rejection(runWorkflow(await prepare(), { wait: true }));

  expect((err as ComfyCliError).code).toBe("cancelled");
});

test("the envelope decides the outcome, not the exit code", async () => {
  // Landmine #4, in both directions. Exit 1 is overloaded upstream — missing
  // file, downed server, HTTP error, failed conversion and failed execution
  // all map to it — so a run that succeeded must still be reported as success.
  serveStream(completedStream(), { exit: 1 });
  const succeeded = await runWorkflow(await prepare(), { wait: true });
  expect(succeeded.status).toBe("completed");
  expect(succeeded.outputs.files).toEqual([OUTPUT_PATH]);

  // ...and a run that failed must still be reported as a failure at exit 0.
  serveStream(`${failureLine({ code: "server_unreachable", message: "connection refused" })}\n`, {
    exit: 0,
  });
  const err = await rejection(runWorkflow(await prepare(), { wait: true }));
  expect(err).toBeInstanceOf(ComfyCliError);
  expect((err as ComfyCliError).code).toBe("server_unreachable");
});

test("no final envelope is an error naming the exit code and quoting both streams", async () => {
  serveStream(`${completedEvents().join("\n")}\n`, {
    stderr: "RuntimeError: the watcher died before writing a verdict",
    exit: 1,
  });

  const err = await rejection(runWorkflow(await prepare(), { wait: true }));

  expect(err).toBeInstanceOf(RunContractError);
  const message = (err as Error).message;
  expect(message).toContain(source); // which workflow
  expect(message).toContain("exit code: 1");
  expect(message).toContain('"type":"executing"'); // a bounded look at stdout
  // stderr is never parsed, but it is where the CLI's human explanation lives,
  // so a diagnostic that omitted it would hide the only account of the failure.
  expect(message).toContain("the watcher died");
  expect(message).toContain(PROMPT_ID); // and the run may still be executing
});

test("empty stdout is the same error rather than an empty success", async () => {
  serveStream("\n \n", { stderr: "Killed: 9", exit: 137 });

  const err = await rejection(runWorkflow(await prepare(), { wait: true }));

  expect(err).toBeInstanceOf(RunContractError);
  expect((err as Error).message).toContain("exit code: 137");
  expect((err as Error).message).toContain("Killed: 9");
});

test("the snippets of both streams are bounded", async () => {
  serveStream(`${"x".repeat(10_000)}\n`, { stderr: "y".repeat(10_000), exit: 1 });

  const err = await rejection(runWorkflow(await prepare(), { wait: true }));

  const message = (err as Error).message;
  expect(message).toContain("xxx");
  expect(message).toContain("yyy");
  expect(message).toContain("…");
  expect(message.length).toBeLessThan(2_000);
});

test("stderr is never read as data, however envelope-shaped it looks", async () => {
  // stdout carries the whole contract; stderr carries human text (docs
  // json-output.md:28-42). Anything that parses stderr resolves here instead
  // of failing, and reports a run that never happened.
  serveStream(`${completedEvents().join("\n")}\n`, {
    stderr: envelopeLine(completedPayload({ status: "completed" })),
    exit: 0,
  });

  const err = await rejection(runWorkflow(await prepare(), { wait: true }));

  expect(err).toBeInstanceOf(RunContractError);
});

test("stderr noise alongside a good stream changes nothing", async () => {
  serveStream(completedStream(), {
    stderr: "WARNING: torch not compiled with CUDA enabled",
  });

  const result = await runWorkflow(await prepare(), { wait: true });

  expect(result.status).toBe("completed");
  expect(result.outputs.urls).toEqual([OUTPUT_URL]);
});

test("a timeout names the job it started, instead of ending the trail", async () => {
  // The likeliest failure of this tool: a `--wait` run outlasting its budget.
  // The CLI is killed and ComfyUI is not, so the run goes on — and the handle
  // needed to follow it is already in the partial stdout that was read.
  serveStream(`${[event("queued", { prompt_id: PROMPT_ID }), event("executing", { node: "3" })].join("\n")}\n`);
  process.env.FAKE_COMFY_HANG = "1";

  const err = await rejection(runWorkflow(await prepare(), { wait: true, timeoutMs: 400 }));

  expect(err).toBeInstanceOf(ComfyTimeoutError);
  const message = (err as Error).message;
  expect(message).toContain("400ms"); // still says what it always said
  expect(message).toContain(PROMPT_ID); // ...and now says where the run went
  expect(message).toContain("get_job"); // named for a model, which cannot use a shell
  expect(message).toContain("comfy jobs status"); // and for an operator, who can
});

test("a timeout with nothing decodable still explains itself", async () => {
  serveStream("not ndjson at all\n");
  process.env.FAKE_COMFY_HANG = "1";

  const err = await rejection(runWorkflow(await prepare(), { wait: true, timeoutMs: 400 }));

  expect(err).toBeInstanceOf(ComfyTimeoutError);
  expect((err as Error).message).toContain("comfy jobs ls");
});

test("a timeout still disposes the prepared copy", async () => {
  serveStream("");
  process.env.FAKE_COMFY_HANG = "1";
  const prepared = await prepare();

  await rejection(runWorkflow(prepared, { wait: true, timeoutMs: 400 }));

  expect(existsSync(prepared.path)).toBe(false);
  expect(leakedTempDirs()).toEqual([]);
});

// --- contract violations in the stream -----------------------------------

test("a second envelope is refused rather than one verdict being picked", async () => {
  serveStream(
    `${[
      ...completedEvents(),
      envelopeLine(completedPayload()),
      failureLine({ code: "execution_error", message: "and yet it failed" }),
    ].join("\n")}\n`,
  );

  const err = await rejection(runWorkflow(await prepare(), { wait: true }));

  expect(err).toBeInstanceOf(RunContractError);
  const message = (err as Error).message;
  expect(message).toContain("more than one"); // two verdicts, no rule to choose
  expect(message).toContain(PROMPT_ID); // and where to go to settle it
});

test("an event after the envelope is refused, because the envelope was not final", async () => {
  serveStream(
    `${[
      ...completedEvents(),
      envelopeLine(completedPayload()),
      event("output", { url: OUTPUT_URL, prompt_id: PROMPT_ID }),
    ].join("\n")}\n`,
  );

  const err = await rejection(runWorkflow(await prepare(), { wait: true }));

  expect(err).toBeInstanceOf(RunContractError);
  expect((err as Error).message).toContain("after the envelope");
});

test("an envelope-shaped line that breaks the contract is reported as such", async () => {
  // Binning this as an unrecognised line would report "no envelope at all" for
  // a stream whose only fault is one changed field.
  serveStream(
    `${JSON.stringify({
      schema: "envelope/1",
      type: "envelope",
      ok: true,
      command: "run",
      version: "0.0.0",
      where: "local",
      data: completedPayload(),
      // `error` is required by envelope/1, present-and-null on success.
    })}\n`,
  );

  const err = await rejection(runWorkflow(await prepare(), { wait: true }));

  expect(err).toBeInstanceOf(EnvelopeParseError);
  expect((err as Error).message).toContain("error");
});

test("a line calling itself an envelope is treated as one even without `schema`", async () => {
  // Both identifiers are checked because either one alone marks a line as the
  // *result* arriving malformed. Recognising this only by `schema` would let it
  // decode as an event — its `type` is a string, so the event contract accepts
  // it — and the run would then be reported as having produced no verdict at
  // all, sending the operator to look for missing output rather than at the
  // envelope whose one changed field caused it.
  serveStream(
    `${JSON.stringify({
      type: "envelope",
      ok: true,
      command: "run",
      version: "0.0.0",
      where: "local",
      data: completedPayload(),
      error: null,
    })}\n`,
  );

  const err = await rejection(runWorkflow(await prepare(), { wait: true }));

  expect(err).toBeInstanceOf(EnvelopeParseError);
  expect(err).not.toBeInstanceOf(RunContractError);
  expect((err as Error).message).toContain("schema");
});

test("a payload that is not a run result is refused with the payload quoted", async () => {
  serveStream(`${envelopeLine({ workflow: "flow" })}\n`); // no `status`

  const err = await rejection(runWorkflow(await prepare(), { wait: true }));

  expect(err).toBeInstanceOf(RunContractError);
  const message = (err as Error).message;
  expect(message).toContain("status");
  expect(message).toContain(`{"workflow":"flow"}`);
});

// --- the temp copy's lifetime --------------------------------------------

test("the prepared copy is removed once the run has been submitted", async () => {
  serveStream(`${envelopeLine(queuedPayload())}\n`);
  const prepared = await prepare();

  await runWorkflow(prepared);

  // `comfy run` reads the file at submit time and never again, so the copy is
  // finished with even on the async path.
  expect(existsSync(prepared.path)).toBe(false);
  expect(leakedTempDirs()).toEqual([]);
});

test("the prepared copy is removed when the run fails", async () => {
  serveStream(`${failureLine({ code: "server_unreachable", message: "connection refused" })}\n`, {
    exit: 1,
  });
  const prepared = await prepare();

  await rejection(runWorkflow(prepared));

  expect(existsSync(prepared.path)).toBe(false);
  expect(leakedTempDirs()).toEqual([]);
});

test("the source workflow is untouched by a run", async () => {
  const before = readFileSync(source, "utf8");
  serveStream(completedStream());
  await runWorkflow(await prepare(), { wait: true });
  expect(readFileSync(source, "utf8")).toBe(before);
});

// --- effective parameters: what was actually submitted ---------------------
//
// `applied` (from `set-slot`) is only an echo of the addresses requested —
// `workflow.py:313` is literally `list(overrides_dict.keys())` — and proves
// nothing about the submitted graph. This is the check that would have
// caught the benchmark bug landmine #15 describes in one call instead of a
// whole run: `set-slot` reported `52/6.text` "applied" while the submitted
// graph never carried it at all.
//
// Constraint that must hold throughout (landmine #14): the submitted graph
// must never reach a caller whole, and an integer at or above 2^53 in it must
// never round-trip through a JS number.

/** One node's worth of an API-format prompt, as `prompt_preview` emits it. */
function promptNode(classType: string, inputs: Record<string, unknown>): Record<string, unknown> {
  return { class_type: classType, inputs };
}

/** A `prompt_preview` event line carrying `graph` as the literal, unparsed JSON text of `prompt`. */
function promptPreviewLine(graphJson: string): string {
  return `{"schema":"event/1","type":"prompt_preview","prompt":${graphJson},"prompt_id":null}`;
}

test("an ordinary value is confirmed when the submitted graph carries it unchanged", async () => {
  const graph = JSON.stringify({ "6": promptNode("CLIPTextEncode", { text: "black metal" }) });
  serveStream(
    `${[promptPreviewLine(graph), ...completedEvents(), envelopeLine(completedPayload())].join("\n")}\n`,
  );

  const result = await runWorkflow(await prepare(), {
    wait: true,
    requestedValues: { "6.text": "black metal" },
  });

  expect(result.effectiveParameters).toEqual([
    { address: "6.text", status: "confirmed", requested: "black metal", submitted: "black metal" },
  ]);
});

test("a 2^64-1 seed is reported byte-exact, never rounded, when confirmed", async () => {
  // The landmine itself: `comfy` emits the bare, unquoted digits, and ordinary
  // `JSON.parse` would round them to ROUNDED_SEED before this module ever saw
  // the value. The digit-preserving guard is what this test pins.
  const graph = `{"3":{"class_type":"KSampler","inputs":{"seed":${HUGE_SEED},"steps":20}}}`;
  serveStream(
    `${[promptPreviewLine(graph), ...completedEvents(), envelopeLine(completedPayload())].join("\n")}\n`,
  );

  const result = await runWorkflow(await prepare(), {
    wait: true,
    requestedValues: { "3.seed": HUGE_SEED },
  });

  expect(result.effectiveParameters).toEqual([
    { address: "3.seed", status: "confirmed", requested: HUGE_SEED, submitted: HUGE_SEED },
  ]);
  const wire = JSON.stringify(result);
  expect(wire).toContain(HUGE_SEED);
  expect(wire).not.toContain(ROUNDED_SEED);
});

test("a value the submitted graph disagrees with is a mismatch, not silently confirmed", async () => {
  // The mutation this pins: a comparison that always reports "confirmed"
  // regardless of what the graph actually holds.
  const graph = JSON.stringify({ "3": promptNode("KSampler", { seed: 222 }) });
  serveStream(
    `${[promptPreviewLine(graph), ...completedEvents(), envelopeLine(completedPayload())].join("\n")}\n`,
  );

  const result = await runWorkflow(await prepare(), {
    wait: true,
    requestedValues: { "3.seed": "111" },
  });

  expect(result.effectiveParameters).toEqual([
    { address: "3.seed", status: "mismatch", requested: "111", submitted: 222 },
  ]);
});

test("an address absent from the submitted graph is reported missing, not silently confirmed", async () => {
  // Landmine #15's actual failure mode: `set-slot` can report an address
  // `applied` that the submitted graph never carries at all.
  const graph = JSON.stringify({ "3": promptNode("KSampler", { steps: 20 }) }); // no `seed` at all
  serveStream(
    `${[promptPreviewLine(graph), ...completedEvents(), envelopeLine(completedPayload())].join("\n")}\n`,
  );

  const result = await runWorkflow(await prepare(), {
    wait: true,
    requestedValues: { "3.seed": 42 },
  });

  expect(result.effectiveParameters).toEqual([{ address: "3.seed", status: "missing", requested: 42 }]);
});

test("an address on a node absent from the submitted graph entirely is also missing", async () => {
  const graph = JSON.stringify({ "9": promptNode("SaveImage", {}) }); // node 3 never submitted
  serveStream(
    `${[promptPreviewLine(graph), ...completedEvents(), envelopeLine(completedPayload())].join("\n")}\n`,
  );

  const result = await runWorkflow(await prepare(), {
    wait: true,
    requestedValues: { "3.seed": 42 },
  });

  expect(result.effectiveParameters).toEqual([{ address: "3.seed", status: "missing", requested: 42 }]);
});

test("no prompt_preview event at all leaves every requested address unconfirmed", async () => {
  // Not the same claim as "missing": this is "could not be checked", not
  // "checked and it is not there".
  serveStream(`${[...completedEvents(), envelopeLine(completedPayload())].join("\n")}\n`);

  const result = await runWorkflow(await prepare(), {
    wait: true,
    requestedValues: { "3.seed": 42 },
  });

  expect(result.effectiveParameters).toEqual([{ address: "3.seed", status: "unconfirmed", requested: 42 }]);
});

test("nothing requested yields an empty report", async () => {
  serveStream(completedStream());
  const result = await runWorkflow(await prepare(), { wait: true });
  expect(result.effectiveParameters).toEqual([]);
});

test("booleans compare directly and a numeric string matches the graph's own number", async () => {
  const graph = JSON.stringify({ "3": promptNode("KSampler", { add_noise: true, steps: 20 }) });
  serveStream(
    `${[promptPreviewLine(graph), ...completedEvents(), envelopeLine(completedPayload())].join("\n")}\n`,
  );

  const result = await runWorkflow(await prepare(), {
    wait: true,
    // "20", a string, for a value the graph holds as the JS number 20 —
    // exactly what `encodeString` sends unquoted for a slot known numeric.
    requestedValues: { "3.add_noise": true, "3.steps": "20" },
  });

  expect(result.effectiveParameters).toEqual([
    { address: "3.add_noise", status: "confirmed", requested: true, submitted: true },
    { address: "3.steps", status: "confirmed", requested: "20", submitted: 20 },
  ]);
});

test("a boolean requested does not falsely match a differently-typed submitted value", async () => {
  const graph = JSON.stringify({ "3": promptNode("KSampler", { add_noise: "true" }) }); // a STRING, not a bool
  serveStream(
    `${[promptPreviewLine(graph), ...completedEvents(), envelopeLine(completedPayload())].join("\n")}\n`,
  );

  const result = await runWorkflow(await prepare(), {
    wait: true,
    requestedValues: { "3.add_noise": true },
  });

  expect(result.effectiveParameters[0]?.status).toBe("mismatch");
});

test("the full submitted graph never reaches the caller, even through effective-parameter extraction", async () => {
  // The general defence behind the named `prompt` drop in `sanitiseEvent`,
  // proven again here: a huge graph is scanned only for the ONE address asked
  // about, and nothing else in it — other nodes, other class_types, other
  // huge integers nobody requested — is ever carried into the result.
  const big: Record<string, unknown> = {};
  for (let i = 0; i < 400; i++) {
    big[String(i)] = promptNode("KSampler", { seed: HUGE_SEED, steps: i });
  }
  big["3"] = promptNode("KSampler", { seed: 42 });
  const graph = JSON.stringify(big);
  serveStream(
    `${[promptPreviewLine(graph), ...completedEvents(), envelopeLine(completedPayload())].join("\n")}\n`,
  );

  const result = await runWorkflow(await prepare(), {
    wait: true,
    requestedValues: { "3.seed": 42 },
  });

  expect(result.effectiveParameters).toEqual([
    { address: "3.seed", status: "confirmed", requested: 42, submitted: 42 },
  ]);
  // Scoped to effectiveParameters alone: `result.events` legitimately carries
  // its own, unrelated "KSampler" in the `executing` event's declared
  // `class_type` field, which is not what this test is pinning.
  const params = JSON.stringify(result.effectiveParameters);
  expect(params).not.toContain(ROUNDED_SEED);
  expect(params).not.toContain(HUGE_SEED); // no OTHER node's huge seed leaked either
  expect(params).not.toContain("KSampler"); // no class_type reached the caller via this path
  expect(params.length).toBeLessThan(200); // nowhere near the ~15KB raw graph
});

test("an address this server cannot parse (no dot) is unconfirmed rather than guessed at", async () => {
  const graph = JSON.stringify({ "3": promptNode("KSampler", { seed: 42 }) });
  serveStream(
    `${[promptPreviewLine(graph), ...completedEvents(), envelopeLine(completedPayload())].join("\n")}\n`,
  );

  const result = await runWorkflow(await prepare(), {
    wait: true,
    requestedValues: { malformed: 42 },
  });

  expect(result.effectiveParameters).toEqual([{ address: "malformed", status: "unconfirmed", requested: 42 }]);
});

// --- the fixtures are the real contract ----------------------------------

/** The subset of JSON Schema the two copied contracts use. */
interface JsonSchema {
  type?: string | string[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
}

function loadSchema(name: string): JsonSchema {
  return JSON.parse(readFileSync(join(import.meta.dir, "fixtures", name), "utf8")) as JsonSchema;
}

const RUN_SCHEMA = loadSchema("schema.run.json");
const RUN_EVENT_SCHEMA = loadSchema("schema.run_event.json");

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

test("the completed payload these tests serve is a valid run.json payload", () => {
  expect(violations(RUN_SCHEMA, completedPayload())).toEqual([]);
});

test("the queued payload these tests serve is a valid run.json payload", () => {
  expect(violations(RUN_SCHEMA, queuedPayload())).toEqual([]);
});

test("every event these tests serve is a valid run_event.json event", () => {
  for (const line of completedEvents()) {
    expect(violations(RUN_EVENT_SCHEMA, JSON.parse(line))).toEqual([]);
  }
});

test("the published event enum already excludes types the CLI emits", () => {
  // Not a defect in the fixture — a defect in treating the enum as closed.
  // `converted` and `prompt_preview` are emitted by comfy-cli's own run path
  // and are absent from the enum, which is why `type` is decoded as an open
  // string. This test is what makes that argument checkable rather than
  // asserted.
  const emitted = JSON.parse(event("prompt_preview"));
  expect(violations(RUN_EVENT_SCHEMA, emitted)).not.toEqual([]);
  expect(violations(RUN_EVENT_SCHEMA, JSON.parse(event("converted")))).not.toEqual([]);
  // ...and the validator is not simply rejecting everything.
  expect(violations(RUN_EVENT_SCHEMA, JSON.parse(event("executing", { node: "3" })))).toEqual([]);
});
