import { afterEach, beforeAll, beforeEach, expect, sleep, test } from "./support/testing.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, SERVER_VERSION } from "../src/server.ts";
import { toolConfig } from "../src/tools.ts";
import { clearJobLedger } from "../src/jobLedger.ts";
import { objectInfoCachePath } from "../src/comfy/objectInfo.ts";

/**
 * The MCP surface, exercised through a real client over a real transport.
 *
 * No test here may contact a ComfyUI, invoke the real `comfy`, or leave a
 * process behind. Every CLI invocation goes to `tests/fixtures/fake-comfy` (via
 * the dispatcher, since one tool call can make two CLI calls with different
 * subcommands), and every HTTP probe goes to a hermetic `Deno.serve` on an
 * ephemeral port. The instance address is never left at its 8188 default, so an
 * accidental probe cannot reach the ComfyUI that may well be running on this
 * machine — and auto-launch is OFF unless a test turns it on, so nothing here
 * can start one.
 */

const FIXTURES = join(import.meta.dirname, "fixtures");
const FAKE_COMFY = join(FIXTURES, "fake-comfy-dispatch");
const OBJECT_INFO_SAMPLE = join(FIXTURES, "object_info.sample.json");
const SLOTS_SAMPLE = join(FIXTURES, "slots.default_image_gen.json");
/** A frontend-format workflow with one settable slot, from Task 5's fetch tests. */
const SLOTS_CAPABLE_TEMPLATE = join(FIXTURES, "template.bigseed.json");
/** A minimal `comfy validate` payload — one clean, zero-diagnostic result. */
const VALIDATE_SAMPLE = join(FIXTURES, "validate.sample.json");

const REPO_ROOT = join(import.meta.dirname, "..");
/**
 * The Node-runnable bundle a real MCP client actually runs — `npx -y
 * mcp-comfyui` and `claude mcp add ... -- npx -y mcp-comfyui` both resolve to
 * this file. Finding 1's tests used to drive a `bun build --compile` standalone
 * binary instead; that binary is no longer this project's primary shipped
 * artifact (a `deno compile` binary is now the *optional* one — see
 * `deno.json`'s `compile` task), so those tests now exercise `dist/index.js`
 * under `node` directly, which is both the more faithful target and the one
 * this migration's own definition of done independently proves runs correctly
 * over stdio.
 */
const DIST_ENTRY = join(REPO_ROOT, "dist", "index.js");

/**
 * Build the real `dist/index.js` fresh, so Finding 1's tests exercise the
 * exact artifact a user runs rather than a source file executed in dev mode.
 * Runs the project's own build script (`node scripts/build.mjs`, which shells
 * out to `deno bundle`) exactly as `npm run build` / `prepublishOnly` would.
 */
async function buildDist(): Promise<void> {
  const build = new Deno.Command("node", {
    args: ["scripts/build.mjs"],
    cwd: REPO_ROOT,
    env: process.env as Record<string, string>,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await build.output();
  if (!output.success) {
    throw new Error(
      `build failed with exit code ${output.code}: ${new TextDecoder().decode(output.stderr)}`,
    );
  }
}

/** Spawn the built `dist/index.js` under `node`, wired for a raw stdio conversation. */
function spawnDist(env: NodeJS.ProcessEnv = process.env): Deno.ChildProcess {
  const command = new Deno.Command("node", {
    args: [DIST_ENTRY],
    env: env as Record<string, string>,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  return command.spawn();
}

/**
 * Write text to a child's stdin. The writer is released (not closed) after
 * each write rather than held across calls: `Deno.ChildProcess`'s stdin is a
 * `WritableStream`, whose writer must be released before another
 * `getWriter()` call can succeed, and several tests below write more than
 * once to the same child, interleaved with reads.
 */
async function writeStdin(child: Deno.ChildProcess, text: string): Promise<void> {
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(text));
  writer.releaseLock();
}

/**
 * Tear down a raw-stdio child: stop it if it is still running, release both
 * output streams, and wait for it to be collected.
 *
 * The `catch` is the whole point. Deno reaps an exited child on a background
 * task, and `ChildProcess.kill()` throws `TypeError: Child process has
 * already terminated` once that has happened — measured at ~2ms after exit,
 * whether or not `child.status` has been awaited. Several children here are
 * *expected* to exit on their own (the overflow test's whole claim is that
 * the transport dies loudly), so teardown reaching a dead child is the normal
 * case, not a fault; for the children that should still be alive, a `kill()`
 * that throws would replace a real assertion failure with a confusing
 * teardown error at the same line. Either way the child is already gone,
 * which is all `kill()` was ever for.
 *
 * Not written as `if (stillRunning) kill()`: there is no such check that
 * isn't itself racing the same background reap. Attempting the kill and
 * treating "already terminated" as success is the only race-free form.
 *
 * Narrow on purpose. A `TypeError` from anything else — a locked stream, a
 * bad signal name — is rethrown, and so is this one if Deno ever rewords it,
 * which fails loudly rather than quietly skipping the kill.
 */
async function terminate(child: Deno.ChildProcess): Promise<void> {
  try {
    child.kill("SIGKILL");
  } catch (err) {
    if (!(err instanceof TypeError && err.message.includes("already terminated"))) throw err;
  }
  child.stdout.cancel();
  child.stderr.cancel();
  await child.status;
}

/** How `workflows/setSlots.ts` names the temp directories it creates. */
const TEMP_PREFIX = "mcp-comfyui-apply-";

const PROMPT_ID = "9b1c7d2e-0000-4000-8000-000000000001";

/** 2^64−1: the largest seed ComfyUI accepts, and one JSON numbers cannot hold. */
const HUGE_SEED = "18446744073709551615";

/** The live capture from ComfyUI 0.29.0 Desktop, trimmed to what is asserted. */
const SYSTEM_STATS = {
  system: {
    comfyui_version: "0.29.0",
    deploy_environment: "local-desktop2-standalone",
    argv: ["ComfyUI/main.py", "--output-directory", "/Users/you/ComfyUI-Shared/output"],
  },
  devices: [{ name: "mps", type: "mps", vram_total: 51539607552, vram_free: 11458723840 }],
};

/**
 * A `{port, stop}` pair wrapping the raw `Deno.HttpServer`. `stop(true)`
 * (this file only ever forces) aborts the creating `signal` instead of
 * calling `.shutdown()`, which — unlike `.shutdown()` — resolves
 * immediately even against a handler that never returns (measured
 * directly).
 */
interface TestServer {
  readonly port: number;
  stop(force?: boolean): Promise<void>;
}

function denoServe(handler: (request: Request) => Response | Promise<Response>): TestServer {
  const ac = new AbortController();
  const inner = Deno.serve({ hostname: "127.0.0.1", port: 0, signal: ac.signal, onListen: () => {} }, handler);
  const port = (inner.addr as Deno.NetAddr).port;
  return {
    port,
    stop: async () => {
      ac.abort();
      await inner.finished;
    },
  };
}

let workdir: string;
let roots: string;
/** Where `MCP_COMFYUI_CREATED_DIR` points this run, unwritten — `workflowRoots()` still reports it. */
let createdDir: string;
let cacheDir: string;
let argvOut: string;
let servers: TestServer[] = [];
let open: Array<() => Promise<void>> = [];
/** The port every tool talks to unless a test says otherwise; nothing listens. */
let deadPort: number;
/** How many times `/object_info` was asked for, across every served instance. */
let objectInfoRequests = 0;

const MANAGED_ENV = [
  "COMFY_BIN",
  "FAKE_COMFY_MODE",
  "FAKE_COMFY_ARGV_OUT",
  "FAKE_COMFY_ARGV_LOG",
  "FAKE_COMFY_DATA_FILE",
  "FAKE_COMFY_ERROR_CODE",
  "FAKE_COMFY_ERROR_MESSAGE",
  "FAKE_COMFY_STREAM_FILE",
  "FAKE_COMFY_STDERR",
  "FAKE_COMFY_EXIT",
  "FAKE_COMFY_HANG",
  "FAKE_COMFY_WARNINGS",
  "FAKE_COMFY_SET_SLOT_MODE",
  "FAKE_COMFY_LAUNCH_MODE",
  "FAKE_COMFY_RUN_MODE",
  "FAKE_COMFY_JOBS_MODE",
  "FAKE_COMFY_JOBS_STATUS_FILE",
  "FAKE_COMFY_JOBS_STATUS_ERROR",
  "FAKE_COMFY_JOBS_CANCEL_FILE",
  "FAKE_COMFY_JOBS_CANCEL_ERROR",
  "FAKE_COMFY_DISPATCH_LOG",
  "FAKE_COMFY_WORKFLOW_COPY",
  "FAKE_COMFY_NOTES_FILE",
  "FAKE_COMFY_NOTES_MODE",
  "FAKE_COMFY_VALIDATE_FILE",
  "FAKE_COMFY_VALIDATE_OK",
  "MCP_COMFYUI_WORKFLOW_DIRS",
  "MCP_COMFYUI_CREATED_DIR",
  "MCP_COMFYUI_CACHE_DIR",
  "MCP_COMFYUI_HOST",
  "MCP_COMFYUI_PORT",
  "MCP_COMFYUI_ALLOW_LAUNCH",
  "MCP_COMFYUI_AUTO_LAUNCH",
  "MCP_COMFYUI_WORKSPACE",
  "MCP_COMFYUI_HOSTS_FILE",
];

beforeEach(async () => {
  workdir = mkdtempSync(join(tmpdir(), "mcp-comfyui-server-"));
  roots = join(workdir, "workflows");
  cacheDir = join(workdir, "cache");
  argvOut = join(workdir, "argv");
  mkdirSync(roots);
  mkdirSync(cacheDir);
  servers = [];
  open = [];
  objectInfoRequests = 0;
  deadPort = await closedPort();

  process.env.COMFY_BIN = FAKE_COMFY;
  process.env.FAKE_COMFY_ARGV_OUT = argvOut;
  process.env.MCP_COMFYUI_WORKFLOW_DIRS = roots;
  // Pointed inside this test's own directory, unwritten, so an exact `roots`
  // or listing assertion here is deterministic rather than depending on this
  // developer's real home directory, which `workflowRoots()` would otherwise
  // append.
  createdDir = join(workdir, "created");
  process.env.MCP_COMFYUI_CREATED_DIR = createdDir;
  process.env.MCP_COMFYUI_CACHE_DIR = cacheDir;
  // Pointed inside this test's own directory even though nothing writes one:
  // otherwise every test here would read whoever's real
  // `~/.config/mcp-comfyui/hosts.json` happens to be on the machine running
  // the suite, and a developer with two hosts registered would see failures
  // nobody else could reproduce.
  process.env.MCP_COMFYUI_HOSTS_FILE = join(workdir, "hosts.json");
  // The job ledger is module state and outlives a test. Every test in this
  // file polls the same `PROMPT_ID`, so without this a later test inherits an
  // earlier run's host and port — which is exactly right in production, where
  // a prompt_id is a UUID belonging to one run, and exactly wrong here.
  clearJobLedger();
  // A ComfyUI is answering by default, because that is the state every tool
  // that needs one is written for. Tests about the other state call
  // `nothingRunning()`; tests about starting one turn auto-launch back on.
  serveInstance();
  process.env.MCP_COMFYUI_AUTO_LAUNCH = "0";
  preexistingTempDirs = prepareTempDirs();
});

afterEach(async () => {
  for (const close of open) await close();
  for (const bound of servers) await bound.stop(true); // force: a hung handler must not hold the suite
  for (const name of MANAGED_ENV) delete process.env[name];
  rmSync(workdir, { recursive: true, force: true });
  for (const name of leakedTempDirs()) rmSync(join(tmpdir(), name), { recursive: true, force: true });
});

/** Prepare-step temp directories that existed before this test began. */
let preexistingTempDirs = new Set<string>();

function prepareTempDirs(): Set<string> {
  return new Set(readdirSync(tmpdir()).filter((name) => name.startsWith(TEMP_PREFIX)));
}

/**
 * Temp directories THIS test created and nobody cleaned up.
 *
 * Scoped to the difference against a snapshot taken in `beforeEach`, never the
 * whole prefix: `tmpdir()` is shared, and `tests/setSlots.test.ts` creates
 * directories under the same prefix. Reaping every match deleted another
 * file's live fixtures mid-test, which showed up as a transient ENOENT that
 * never reproduced when either file was run alone — under Bun, which ran test
 * files concurrently by default. `deno test` (see `tests/setSlots.test.ts` for
 * the full account) runs files sequentially unless `--parallel` is passed,
 * which this project's `deno task test` does not do, so the race itself
 * cannot currently happen — the scoping stays anyway.
 */
function leakedTempDirs(): string[] {
  return readdirSync(tmpdir()).filter(
    (name) => name.startsWith(TEMP_PREFIX) && !preexistingTempDirs.has(name),
  );
}

function portOf(bound: TestServer): number {
  return bound.port;
}

/** A port nothing is listening on: bind one, then give it back. */
async function closedPort(): Promise<number> {
  const throwaway = denoServe(() => new Response(""));
  const port = portOf(throwaway);
  await throwaway.stop(true);
  return port;
}

/**
 * Stand up a loopback ComfyUI and point the server's target at it.
 *
 * Only `/system_stats` is answered. `/object_info` deliberately 404s: this fake
 * is a *reachable instance*, not a complete ComfyUI, and a describe that needs
 * node definitions must be given a seeded cache rather than quietly reading a
 * system-stats body as a node dictionary.
 */
function serveInstance(body: unknown = SYSTEM_STATS): number {
  const bound = denoServe((request) => {
    const path = new URL(request.url).pathname;
    if (path === "/object_info") objectInfoRequests += 1;
    return path === "/system_stats"
      ? new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
      : new Response("not found", { status: 404 });
  });
  servers.push(bound);
  const port = portOf(bound);
  process.env.MCP_COMFYUI_PORT = String(port);
  return port;
}

/**
 * Unlike `serveInstance`, this one's `/object_info` actually answers — with the
 * real sample payload by default, or with the given HTTP status when a test
 * needs the request to be observably ATTEMPTED (via `objectInfoRequests`) and
 * to fail anyway. `serveInstance`'s deliberate 404 already proves "unreachable
 * schema"; this exists for the stale-cache floor's tests, which need either a
 * live instance whose definitions are fetchable, or one that answers but still
 * fails — as opposed to a dead port, against which a request COUNT proves
 * nothing (a dead port increments no counter whether it was tried once, twice
 * or never).
 */
function serveObjectInfo(opts: { status?: number } = {}): { port: number } {
  const bound = denoServe((request) => {
    const path = new URL(request.url).pathname;
    if (path === "/object_info") {
      objectInfoRequests += 1;
      return opts.status !== undefined
        ? new Response("error", { status: opts.status })
        : new Response(readFileSync(OBJECT_INFO_SAMPLE, "utf8"), {
            headers: { "content-type": "application/json" },
          });
    }
    return path === "/system_stats"
      ? new Response(JSON.stringify(SYSTEM_STATS), { headers: { "content-type": "application/json" } })
      : new Response("not found", { status: 404 });
  });
  servers.push(bound);
  const port = portOf(bound);
  process.env.MCP_COMFYUI_PORT = String(port);
  return { port };
}

/**
 * A ComfyUI whose `argv` names directories this test owns, so a `/view` URL it
 * emits can be resolved back to a real file without touching this machine's own
 * ComfyUI-Shared directory.
 */
function serveInstanceWritingTo(directories: { output?: string; input?: string }): number {
  const argv = ["ComfyUI/main.py"];
  if (directories.output !== undefined) argv.push("--output-directory", directories.output);
  if (directories.input !== undefined) argv.push("--input-directory", directories.input);
  return serveInstance({ ...SYSTEM_STATS, system: { ...SYSTEM_STATS.system, argv } });
}

/** A `/view` URL of the kind a completed run reports, on a given instance. */
function viewUrl(port: number, query: Record<string, string>): string {
  return `http://127.0.0.1:${port}/view?${new URLSearchParams(query).toString()}`;
}

/** A directory under the test's workdir, created. */
function makeDir(name: string): string {
  const path = join(workdir, name);
  mkdirSync(path, { recursive: true });
  return path;
}

/** Point the server's target at an address nothing answers on. */
function nothingRunning(): number {
  process.env.MCP_COMFYUI_PORT = String(deadPort);
  return deadPort;
}

/**
 * A ComfyUI that refuses until it has been probed `failures` times — what a
 * cold start looks like from outside — with auto-launch turned on.
 */
function launchable(failures: number): number {
  let seen = 0;
  const bound = denoServe((request) => {
    if (new URL(request.url).pathname !== "/system_stats") return new Response("nf", { status: 404 });
    return seen++ < failures
      ? new Response("starting", { status: 503 })
      : new Response(JSON.stringify(SYSTEM_STATS), { headers: { "content-type": "application/json" } });
  });
  servers.push(bound);
  const port = portOf(bound);
  process.env.MCP_COMFYUI_PORT = String(port);
  process.env.MCP_COMFYUI_AUTO_LAUNCH = "1";
  return port;
}

/** One workflow file in the configured root, in the frontend format. */
function writeWorkflow(name: string, body = `{"nodes":[{"id":3,"type":"KSampler"}],"links":[]}`): string {
  const path = join(roots, `${name}.json`);
  writeFileSync(path, body);
  return path;
}

/**
 * A fresh `/object_info` cache for the address the server is configured with,
 * so `describe_workflow` resolves node schemas without a fetch. Written under
 * the name `comfy/objectInfo.ts` derives, which is host and port dependent.
 */
function seedObjectInfoCache(): string {
  const port = process.env.MCP_COMFYUI_PORT;
  const path = join(cacheDir, `object_info-127.0.0.1-${port}.json`);
  copyFileSync(OBJECT_INFO_SAMPLE, path);
  return path;
}

/** Put a usable object_info on disk for a host, dated `ageMs` in the past. */
function cacheAged(host: string, port: number, ageMs: number): string {
  const path = objectInfoCachePath({ host, port, cacheDir });
  copyFileSync(OBJECT_INFO_SAMPLE, path);
  const when = new Date(Date.now() - ageMs);
  utimesSync(path, when, when);
  return path;
}

const TWO_WEEKS = 14 * 24 * 60 * 60 * 1000;

/** Serve a captured payload as the envelope's `data`. */
function serveData(value: unknown): void {
  const path = join(workdir, "data.json");
  writeFileSync(path, JSON.stringify(value));
  process.env.FAKE_COMFY_MODE = "data_file";
  process.env.FAKE_COMFY_DATA_FILE = path;
}

/** Serve the captured 13-slot listing of `default_image_gen`. */
function serveSlots(): void {
  process.env.FAKE_COMFY_MODE = "data_file";
  process.env.FAKE_COMFY_DATA_FILE = SLOTS_SAMPLE;
}

/** Arm the `workflow notes` call with a listing of this test's choosing. */
function serveNotes(notes: unknown[]): void {
  const path = join(workdir, "notes.json");
  writeFileSync(path, JSON.stringify({ workflow: "/w/wf.json", notes }));
  process.env.FAKE_COMFY_NOTES_FILE = path;
}

/** Serve exact bytes as `comfy run --json`'s stdout. */
function serveStream(stdout: string, opts: { stderr?: string; exit?: number } = {}): void {
  const path = join(workdir, "stream.ndjson");
  writeFileSync(path, stdout);
  process.env.FAKE_COMFY_MODE = "run_stream";
  process.env.FAKE_COMFY_RUN_MODE = "run_stream";
  process.env.FAKE_COMFY_STREAM_FILE = path;
  if (opts.stderr !== undefined) process.env.FAKE_COMFY_STDERR = opts.stderr;
  if (opts.exit !== undefined) process.env.FAKE_COMFY_EXIT = String(opts.exit);
}

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

function failureLine(error: { code: string; message: string; hint?: string | null }): string {
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

function event(type: string, fields: Record<string, unknown> = {}): string {
  return JSON.stringify({ schema: "event/1", type, ...fields });
}

function queuedPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { workflow: "flow", status: "queued", prompt_id: PROMPT_ID, outputs: [], ...over };
}

function completedPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workflow: "flow",
    status: "completed",
    prompt_id: PROMPT_ID,
    outputs: [
      "/Users/you/ComfyUI/output/banana_00001_.png",
      "http://127.0.0.1:8188/view?filename=b.png",
    ],
    elapsed_seconds: 4.25,
    ...over,
  };
}

/**
 * The argv the fake recorded. No path in these tests contains a space.
 *
 * Only for a tool call that makes ONE CLI call, or several in sequence where
 * the last is the one being asserted about. `loggedArgv` is the answer for
 * anything concurrent — see the reasoning there.
 */
function argv(): string[] {
  return readFileSync(argvOut, "utf8").trim().split(" ");
}

/**
 * The argv of the first logged invocation whose subcommand is `subcommand`.
 *
 * `argv()` cannot answer this for a tool call that runs the CLI concurrently.
 * $FAKE_COMFY_ARGV_OUT is truncate-written (`fake-comfy:45`), and
 * describe_workflow issues its `slots` and `notes` calls together (the
 * `Promise.all` in `src/tools.ts`), so the two writers overwrite each other in
 * place: both open the file, then the shorter `notes` line lands over the
 * longer `slots` line and leaves its tail behind. The result is two lines, and
 * `argv()`'s whole-file `split(" ")` yields an argument glued to a newline
 * (`".../flow.json\n--input"`) whenever the race falls that way — measured
 * here at roughly 1 run in 3.
 *
 * The dispatch log is APPENDED to instead, one line per invocation, so it must
 * be read line by line and never split as a whole. Matching the subcommand as
 * a whole argument rather than as a substring keeps this immune to how many
 * other invocations were logged and in what order.
 */
function loggedArgv(log: string, subcommand: string): string[] {
  const lines = readFileSync(log, "utf8").split("\n").filter((line) => line.length > 0);
  const line = lines.find((invocation) => invocation.split(" ").includes(subcommand));
  if (line === undefined) {
    throw new Error(`no \`${subcommand}\` invocation in the dispatch log: ${JSON.stringify(lines)}`);
  }
  return line.split(" ");
}

/** A client wired to a freshly built server over a linked in-memory pair. */
async function connect(): Promise<Client> {
  const server = createServer();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "server-test", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  open.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

async function tools(client: Client): Promise<Tool[]> {
  return (await client.listTools()).tools;
}

async function toolNames(client: Client): Promise<string[]> {
  return (await tools(client)).map((tool) => tool.name).sort();
}

function toolNamed(list: Tool[], name: string): Tool {
  const found = list.find((tool) => tool.name === name);
  if (found === undefined) throw new Error(`no tool named ${name} (have: ${list.map((t) => t.name)})`);
  return found;
}

/** The text block of a tool result — the one channel every MCP client renders. */
function textOf(result: CallToolResult): string {
  const block = result.content[0];
  if (block === undefined || block.type !== "text") {
    throw new Error(`expected a text content block, got ${JSON.stringify(result.content)}`);
  }
  return block.text;
}

interface Called {
  result: CallToolResult;
  body: Record<string, unknown>;
}

/** Call a tool and decode its JSON body, whether it succeeded or failed. */
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Called> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { result, body: JSON.parse(textOf(result)) as Record<string, unknown> };
}

/** Call a tool that must succeed, and hand back its body. */
async function ok(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const { result, body } = await call(client, name, args);
  if (result.isError === true) throw new Error(`${name} failed unexpectedly: ${textOf(result)}`);
  return body;
}

/** Call a tool that must fail, and hand back the `error` object it reported. */
async function failure(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const { result, body } = await call(client, name, args);
  if (result.isError !== true) throw new Error(`${name} succeeded unexpectedly: ${textOf(result)}`);
  const error = body["error"];
  if (typeof error !== "object" || error === null) {
    throw new Error(`expected an \`error\` object, got ${textOf(result)}`);
  }
  return error as Record<string, unknown>;
}

// --- registration --------------------------------------------------------

test("registers exactly the eleven default tools", async () => {
  expect(await toolNames(await connect())).toEqual([
    "cancel_job",
    "comfy_status",
    "create_workflow_from_template",
    "describe_workflow",
    "get_job",
    "list_hosts",
    "list_workflows",
    "manage_hosts",
    "run_workflow",
    "search_templates",
    "validate_workflow",
  ]);
});

test("the read-only tools are annotated read-only", async () => {
  const list = await tools(await connect());
  for (const name of ["comfy_status", "list_workflows", "describe_workflow", "get_job"]) {
    expect(toolNamed(list, name).annotations?.readOnlyHint).toBe(true);
  }
});

test("the three tools that change something are annotated not read-only", async () => {
  // A client that hides or auto-approves read-only tools must not auto-approve
  // a GPU render, the interruption of one, or a fetch that writes a new
  // workflow file to disk.
  const list = await tools(await connect());
  expect(toolNamed(list, "run_workflow").annotations?.readOnlyHint).toBe(false);
  expect(toolNamed(list, "cancel_job").annotations?.readOnlyHint).toBe(false);
  expect(toolNamed(list, "create_workflow_from_template").annotations?.readOnlyHint).toBe(false);
});

test("cancel_job is annotated destructive and idempotent", async () => {
  const cancel = toolNamed(await tools(await connect()), "cancel_job");
  expect(cancel.annotations?.destructiveHint).toBe(true);
  expect(cancel.annotations?.idempotentHint).toBe(true);
});

test("every tool carries a description", async () => {
  for (const tool of await tools(await connect())) {
    expect(tool.description ?? "").not.toBe("");
  }
});

test("launch_comfyui is absent by default", async () => {
  // Starting a GPU process is not something a model should do on inference
  // alone, so the tool is not even offered unless an operator opted in.
  expect(await toolNames(await connect())).not.toContain("launch_comfyui");
});

test("launch_comfyui appears when the operator opts in", async () => {
  process.env.MCP_COMFYUI_ALLOW_LAUNCH = "1";
  const list = await tools(await connect());
  expect(list.map((tool) => tool.name)).toContain("launch_comfyui");
  expect(toolNamed(list, "launch_comfyui").annotations?.readOnlyHint).toBe(false);
});

test("a setting spelled off keeps launch_comfyui unregistered", async () => {
  for (const value of ["0", "false", "no", "off", "OFF", ""]) {
    process.env.MCP_COMFYUI_ALLOW_LAUNCH = value;
    expect(await toolNames(await connect())).not.toContain("launch_comfyui");
  }
});

test("a setting spelled on registers launch_comfyui", async () => {
  for (const value of ["1", "true", "yes", "on", "ON", " true "]) {
    process.env.MCP_COMFYUI_ALLOW_LAUNCH = value;
    expect(await toolNames(await connect())).toContain("launch_comfyui");
  }
});

test("a setting that is neither is refused at startup rather than guessed at", async () => {
  // Silently reading `maybe` as off is how an operator ends up believing they
  // enabled something they did not.
  expect(() => createServer({ MCP_COMFYUI_ALLOW_LAUNCH: "maybe" })).toThrow(
    /MCP_COMFYUI_ALLOW_LAUNCH/,
  );
  expect(() => createServer({ MCP_COMFYUI_AUTO_LAUNCH: "sometimes" })).toThrow(
    /MCP_COMFYUI_AUTO_LAUNCH/,
  );
});

// --- the descriptions a model plans from ---------------------------------

test("run_workflow's description sends the caller to describe_workflow first", async () => {
  const description = toolNamed(await tools(await connect()), "run_workflow").description ?? "";
  expect(description).toContain("describe_workflow");
  expect(description).toContain("3.seed");
});

test("run_workflow's description says what the default does and how to finish the job", async () => {
  const description = toolNamed(await tools(await connect()), "run_workflow").description ?? "";
  expect(description).toContain("get_job");
  expect(description).toContain("wait");
});

test("describe_workflow's description names the address form its keys take", async () => {
  const description = toolNamed(await tools(await connect()), "describe_workflow").description ?? "";
  expect(description).toContain("run_workflow");
  expect(description).toContain("3.seed");
});

test("describe_workflow's description points at validate_workflow and frames notes", async () => {
  const description = toolNamed(await tools(await connect()), "describe_workflow").description ?? "";
  expect(description).toContain("validate_workflow");
  expect(description).toContain("notes");
});

test("both tools' descriptions explain what a stale answer means", async () => {
  const list = await tools(await connect());

  for (const name of ["describe_workflow", "validate_workflow"]) {
    const description = toolNamed(list, name).description ?? "";
    expect(description).toContain("stale");
    expect(description).toContain("age_hours");
  }
});

test("search_templates' description names the video tag a caller cannot guess", async () => {
  // Ground truth #28/#29: `type: "video"` matches none of the 47 `Use Cases`
  // templates that produce video, and `--tag` has no substring matching — so a
  // caller who does not already know the literal string "FLF2V" cannot reach
  // those 11 templates by any query they would think to write. This assertion
  // dies if the description is trimmed back to a generic caveat, which is the
  // regression that matters. The 47 is deliberately NOT pinned: the gallery
  // grows, and a test that fails when upstream adds a template gets deleted.
  const description = toolNamed(await tools(await connect()), "search_templates").description ?? "";
  expect(description).toContain("FLF2V");
});

// --- input schemas -------------------------------------------------------

test("run_workflow accepts a slot value as a string, a number or a boolean", async () => {
  const schema = toolNamed(await tools(await connect()), "run_workflow").inputSchema;
  const inputs = (schema.properties as Record<string, { additionalProperties?: unknown }>)["inputs"];
  const value = JSON.stringify(inputs?.additionalProperties);
  expect(value).toContain("string");
  expect(value).toContain("number");
  expect(value).toContain("boolean");
});

test("the inputs schema documents the string form as the exact-integer escape hatch", async () => {
  // Landmines #11/#12: a JSON number loses whole digits above 2^53, so a seed
  // passed as a number is silently a different seed. A model can only avoid
  // that if the schema it plans from says so.
  const schema = toolNamed(await tools(await connect()), "run_workflow").inputSchema;
  const inputs = (schema.properties as Record<string, { description?: string }>)["inputs"];
  expect(inputs?.description ?? "").toContain("string");
  expect(inputs?.description ?? "").toContain("9007199254740991");
});

test("slot addresses are not enumerated statically", async () => {
  // They are per-workflow and come from describe_workflow; an enum here would
  // be a claim about a workflow this schema has never seen.
  const schema = toolNamed(await tools(await connect()), "run_workflow").inputSchema;
  expect(JSON.stringify(schema)).not.toContain("enum");
});

test("a prompt id is required and must be a non-empty string", async () => {
  const client = await connect();
  for (const name of ["get_job", "cancel_job"]) {
    const schema = toolNamed(await tools(client), name).inputSchema;
    expect(schema.required).toEqual(["prompt_id"]);
    const property = (schema.properties as Record<string, { type?: string }>)["prompt_id"];
    expect(property?.type).toBe("string");
  }
});

test("an argument of the wrong type is rejected before any subprocess runs", async () => {
  const client = await connect();
  const result = (await client.callTool({
    name: "get_job",
    arguments: { prompt_id: 42 },
  })) as CallToolResult;

  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("prompt_id");
});

// --- comfy_status --------------------------------------------------------

test("comfy_status reports a running instance", async () => {
  const body = await ok(await connect(), "comfy_status");

  expect(body["running"]).toBe(true);
  expect(body["version"]).toBe("0.29.0");
  expect(body["desktop_managed"]).toBe(true);
  expect(body["output_directory"]).toBe("/Users/you/ComfyUI-Shared/output");
  expect(body["devices"]).toEqual([
    { name: "mps", type: "mps", vram_total: 51539607552, vram_free: 11458723840 },
  ]);
});

test("nothing running is a successful answer, not a tool error", async () => {
  // Every other tool probes first; reporting the normal state of a machine as
  // a failure would train a caller to ignore failures.
  nothingRunning();
  const { result, body } = await call(await connect(), "comfy_status");

  expect(result.isError).toBeFalsy();
  expect(body["running"]).toBe(false);
  expect(String(body["reason"] ?? "")).not.toBe("");
  expect(body["port"]).toBe(deadPort);
});

// --- list_workflows ------------------------------------------------------

test("list_workflows enumerates the configured root and names the handles", async () => {
  writeWorkflow("flow");
  writeWorkflow("other");

  const body = await ok(await connect(), "list_workflows");

  expect(body["count"]).toBe(2);
  const workflows = body["workflows"] as Array<Record<string, unknown>>;
  expect(workflows.map((entry) => entry["name"])).toEqual(["flow", "other"]);
  expect(workflows[0]?.["format"]).toBe("frontend");
  expect(workflows[0]?.["path"]).toBe(join(roots, "flow.json"));
  // `workflowRoots()` always appends the created-workflows directory, last —
  // see config.test.ts for that guarantee in isolation.
  expect(body["roots"]).toEqual([roots, createdDir]);
});

test("a corrupt workflow is listed with its problem rather than failing the listing", async () => {
  writeWorkflow("good");
  writeFileSync(join(roots, "broken.json"), "{ not json");

  const body = await ok(await connect(), "list_workflows");

  const workflows = body["workflows"] as Array<Record<string, unknown>>;
  expect(workflows.map((entry) => entry["name"])).toEqual(["broken", "good"]);
  expect(workflows[0]?.["format"]).toBe("invalid");
  expect(String(workflows[0]?.["problem"] ?? "")).toContain("JSON");
});

test("list_workflows reports has_subgraphs, informationally — never a refusal", async () => {
  writeFileSync(join(roots, "audio.json"), readFileSync(join(FIXTURES, "audio_stable_audio_3_medium.json"), "utf8"));

  const body = await ok(await connect(), "list_workflows");

  const workflows = body["workflows"] as Array<Record<string, unknown>>;
  const audio = workflows.find((entry) => entry["name"] === "audio");
  expect(audio?.["has_subgraphs"]).toBe(true);
  expect(audio?.["format"]).toBe("frontend"); // still fully usable, not refused
});

// --- describe_workflow ---------------------------------------------------

test("describe_workflow returns a JSON Schema keyed by slot address", async () => {
  writeWorkflow("flow");
  seedObjectInfoCache();
  serveSlots();

  const body = await ok(await connect(), "describe_workflow", { workflow: "flow" });

  const schema = body["schema"] as { type: string; properties: Record<string, unknown>; additionalProperties: boolean };
  expect(schema.type).toBe("object");
  expect(schema.additionalProperties).toBe(false);
  expect(Object.keys(schema.properties)).toContain("3.seed");
  expect(body["slot_count"]).toBe(13);
});

test("describe_workflow recovers enums and bounds from the node definitions", async () => {
  // The join this whole server exists for: `slots` reports a bare COMBO with no
  // allowed values, and only /object_info knows that sampler_name takes `euler`.
  writeWorkflow("flow");
  seedObjectInfoCache();
  serveSlots();

  const body = await ok(await connect(), "describe_workflow", { workflow: "flow" });

  const properties = (body["schema"] as { properties: Record<string, Record<string, unknown>> }).properties;
  expect(properties["3.sampler_name"]?.["enum"]).toContain("euler");
  expect(properties["3.steps"]).toMatchObject({ type: "integer", minimum: 1 });
});

test("describe_workflow returns the unresolved list alongside the schema", async () => {
  // An unconstrained property means one of two very different things, and only
  // this list distinguishes "takes anything" from "we could not find out".
  writeWorkflow("flow");
  seedObjectInfoCache();
  serveData({
    workflow: "flow",
    id: "flow",
    slots: [
      {
        address: "99.wobble",
        name: "wobble",
        type: "COMBO",
        current_value: "a",
        instance_id: "99",
        node_type: "SomeUninstalledCustomNode",
      },
    ],
  });

  const body = await ok(await connect(), "describe_workflow", { workflow: "flow" });

  expect(body["unresolved"]).toEqual([
    {
      address: "99.wobble",
      name: "wobble",
      node_type: "SomeUninstalledCustomNode",
      reason: "unknown_node_type",
    },
  ]);
});

test("describe_workflow works with the server down, from the cached node definitions", async () => {
  // Landmine #7: the cached /object_info feeds `slots --input`, so workflow
  // introspection does not need a live server. Nothing is listening on the
  // configured port in this test.
  writeWorkflow("flow");
  const cachePath = seedObjectInfoCache();
  serveSlots();
  // `argv()` alone is not enough here: describe_workflow now issues its
  // `slots` and `notes` calls concurrently (Task 3), and each overwrites the
  // same $FAKE_COMFY_ARGV_OUT, so whichever finishes last would decide what
  // `argv()` sees. The append-only dispatch log lets this test pick out the
  // `slots` invocation specifically, regardless of arrival order.
  const log = join(workdir, "dispatch.log");
  process.env.FAKE_COMFY_DISPATCH_LOG = log;

  const body = await ok(await connect(), "describe_workflow", { workflow: "flow" });

  expect(body["slot_count"]).toBe(13);
  const slots = loggedArgv(log, "slots");
  expect(slots).toContain("--input");
  expect(slots).toContain(cachePath);
});

test("describe_workflow resolves a workflow by the name list_workflows gave", async () => {
  const path = writeWorkflow("flow");
  seedObjectInfoCache();
  serveSlots();
  // Not `argv()`: the concurrent `slots` and `notes` calls race to truncate
  // $FAKE_COMFY_ARGV_OUT, which made this assertion fail about 1 run in 3 with
  // the resolved path glued to the next line's first argument.
  const log = join(workdir, "dispatch.log");
  process.env.FAKE_COMFY_DISPATCH_LOG = log;

  const body = await ok(await connect(), "describe_workflow", { workflow: "flow" });

  expect((body["workflow"] as Record<string, unknown>)["name"]).toBe("flow");
  expect((body["workflow"] as Record<string, unknown>)["path"]).toBe(path);
  expect(loggedArgv(log, "slots")).toContain(path);
});

test("a logged invocation is found whatever order the concurrent calls landed in", () => {
  // The regression guard for the flake above, made deterministic: the two
  // orderings are written by hand, because the real ones cannot be forced.
  // Reading the log as one string instead of line by line fails the second
  // case, which is the bug this pins.
  const log = join(workdir, "dispatch.log");
  const flow = join(roots, "flow.json");
  const cache = join(cacheDir, "object_info-127.0.0.1-8188.json");
  const slots = `--skip-prompt workflow slots ${flow} --input ${cache}`;
  const notes = `--skip-prompt workflow notes ${flow}`;

  for (const order of [[slots, notes], [notes, slots]]) {
    writeFileSync(log, `${order.join("\n")}\n`);
    expect(loggedArgv(log, "slots")).toContain(flow);
    expect(loggedArgv(log, "slots")).toContain(cache);
    expect(loggedArgv(log, "notes")).toEqual(["--skip-prompt", "workflow", "notes", flow]);
  }
});

test("describe_workflow resolves a workflow by absolute path too", async () => {
  const path = writeWorkflow("flow");
  seedObjectInfoCache();
  serveSlots();

  const body = await ok(await connect(), "describe_workflow", { workflow: path });

  expect((body["workflow"] as Record<string, unknown>)["name"]).toBe("flow");
});

test("an unknown name is refused with the names that do exist", async () => {
  // The likeliest mistake, and the one a model can fix on its own — but only if
  // the refusal says what the alternatives are.
  writeWorkflow("default_image_gen");
  writeWorkflow("video_wan");

  const error = await failure(await connect(), "describe_workflow", { workflow: "default_image_gn" });

  expect(error["kind"]).toBe("workflow_not_found");
  expect(JSON.stringify(error["known_workflows"])).toContain("default_image_gen");
  expect(String(error["message"])).toContain("list_workflows");
});

test("an absolute path outside the configured roots is still accepted", async () => {
  // An operator pointing at a file they have not added to the roots is asking a
  // clear question; refusing it would be this server inventing a restriction.
  const outside = join(workdir, "elsewhere.json");
  writeFileSync(outside, `{"nodes":[],"links":[]}`);
  seedObjectInfoCache();
  serveSlots();

  const body = await ok(await connect(), "describe_workflow", { workflow: outside });

  expect((body["workflow"] as Record<string, unknown>)["path"]).toBe(outside);
});

test("describe_workflow returns the workflow's own notes", async () => {
  // The whole point: validate says which model is missing, the note says
  // where to get it.
  writeWorkflow("default_image_gen");
  seedObjectInfoCache();
  serveSlots();
  serveNotes([{
    id: 66,
    type: "MarkdownNote",
    title: "Model Links",
    text: "- [wan2.2_vae.safetensors](https://huggingface.co/x)",
    subgraph: null,
  }]);

  const body = await ok(await connect(), "describe_workflow", { workflow: "default_image_gen" });

  const notes = body.notes as Array<Record<string, unknown>>;
  expect(notes).toHaveLength(1);
  expect(notes[0]!.title).toBe("Model Links");
  expect(String(notes[0]!.text)).toContain("huggingface.co");
  expect(body.notes_unreadable).toBeUndefined();
});

test("a workflow with no notes describes cleanly, with no unreadable marker", async () => {
  // The default path for every test written before notes existed.
  writeWorkflow("default_image_gen");
  seedObjectInfoCache();
  serveSlots();

  const body = await ok(await connect(), "describe_workflow", { workflow: "default_image_gen" });

  expect(body.notes).toEqual([]);
  expect(body.notes_unreadable).toBeUndefined();
});

test("an oversized note is capped, and the response says the list was cut", async () => {
  // The cap is what stops a stranger's markdown from filling the caller's
  // context, so the marker that discloses it needs a test of its own: without
  // this, `notes_truncated` could be deleted, hardcoded false or inverted and
  // the whole suite would still pass.
  //
  // Mutant: drop the `notes_truncated` spread from describe_workflow's body.
  // This test dies on the undefined.
  writeWorkflow("default_image_gen");
  seedObjectInfoCache();
  serveSlots();
  serveNotes([{
    id: 66,
    type: "MarkdownNote",
    title: "Model Links",
    text: "x".repeat(50_000), // MAX_NOTE_TEXT is 8,000
    subgraph: null,
  }]);

  const body = await ok(await connect(), "describe_workflow", { workflow: "default_image_gen" });

  expect(body.notes_truncated).toBe(true);
  const notes = body.notes as Array<Record<string, unknown>>;
  expect(String(notes[0]!.text).length).toBe(8_000);
});

test("a note that fits carries no truncation marker at all", async () => {
  // The other half, and the reason the assertion above cannot be satisfied by
  // hardcoding `true`: absence is the signal here, as everywhere else in this
  // response.
  writeWorkflow("default_image_gen");
  seedObjectInfoCache();
  serveSlots();
  serveNotes([{ id: 66, type: "MarkdownNote", title: "Short", text: "fits", subgraph: null }]);

  const body = await ok(await connect(), "describe_workflow", { workflow: "default_image_gen" });

  expect(body.notes_truncated).toBeUndefined();
  // Present even with nothing cut: a total that only appears when it disagrees
  // with the array would make its absence ambiguous.
  expect(body.notes_count).toBe(1);
});

test("when notes are DROPPED, the count still reports how many the workflow really has", async () => {
  // The reason `NoteListing.count` disagrees with its own array on purpose.
  // `notes_truncated: true` says something was left out; without a true total
  // the caller cannot learn how much, and the difference is the whole answer —
  // here, six notes it is not looking at.
  //
  // Mutant A: drop the `notes_count` spread from describe_workflow's body.
  // This test dies on the undefined.
  //
  // Mutant B: wire it to `notes.length` rather than `count` — the redundant
  // shape `event_count` already has, where the count merely restates the array
  // beside it. This test dies on 24 !== 30. Note that the text-trimming case
  // above CANNOT kill mutant B: it caps one note's body, so the true total and
  // the array length are both 1 and the two implementations agree. Dropping
  // notes is the only case that separates them.
  writeWorkflow("default_image_gen");
  seedObjectInfoCache();
  serveSlots();
  serveNotes(
    Array.from({ length: 30 }, (_unused, index) => ({
      id: index,
      type: "MarkdownNote",
      title: `Note ${index}`,
      text: "fits",
      subgraph: null,
    })),
  );

  const body = await ok(await connect(), "describe_workflow", { workflow: "default_image_gen" });

  expect(body.notes_count).toBe(30); // MAX_NOTES is 24
  expect(body.notes as unknown[]).toHaveLength(24);
  expect(body.notes_truncated).toBe(true);
});

test("a notes failure does not cost the description", async () => {
  // describe.ts's philosophy: nothing here is fatal. A caller who wanted the
  // schema must still get the schema.
  writeWorkflow("default_image_gen");
  seedObjectInfoCache();
  serveSlots();
  process.env.FAKE_COMFY_NOTES_MODE = "fail_code";
  process.env.FAKE_COMFY_ERROR_CODE = "workflow_read_error";
  process.env.FAKE_COMFY_ERROR_MESSAGE = "permission denied";

  const body = await ok(await connect(), "describe_workflow", { workflow: "default_image_gen" });

  expect(body.schema).toBeDefined();
  expect(body.notes).toEqual([]);
  expect(typeof body.notes_unreadable).toBe("string");
  // No count either: `notes: []` here means "could not look", and a
  // `notes_count: 0` beside it would assert something about the workflow that
  // this call never established.
  expect(body.notes_count).toBeUndefined();
});

// --- describe_workflow: decoy addresses (a link overrides the widget) ----

/**
 * A minimal, non-subgraph workflow whose `3.seed` is a decoy: the widget's
 * own link comes from node 99 (a clean `PrimitiveInt`), so at execution time
 * ComfyUI reads 99's output, never 3's stored widget value. Deliberately NOT
 * a subgraph, to exercise the general rule rather than the specific fixture —
 * `tests/discover.test.ts` and the real `audio_stable_audio_3_medium.json`
 * fixture cover the subgraph case precisely.
 */
function decoyWorkflowBody(): string {
  return JSON.stringify({
    nodes: [
      { id: 3, type: "KSampler", inputs: [{ name: "seed", widget: { name: "seed" }, link: 10 }] },
      { id: 99, type: "PrimitiveInt", inputs: [{ name: "value", widget: { name: "value" }, link: null }] },
    ],
    links: [[10, 99, 0, 3, 0, "INT"]],
  });
}

test("describe_workflow excludes a decoy address from schema.properties and lists it under inert", async () => {
  writeWorkflow("flow", decoyWorkflowBody());
  seedObjectInfoCache();
  // A listing that matches the graph above, rather than the unrelated 13-slot
  // sample. `describe_workflow` now resolves a decoy's candidate against the
  // listing — the vocabulary `set-slot` actually accepts — so a fixture whose
  // listing and graph describe different files would test a mismatch that
  // cannot occur in production, where both come from the same workflow.
  const listing = join(workdir, "decoy-slots.json");
  writeFileSync(
    listing,
    JSON.stringify({
      workflow: join(workdir, "workflows", "flow.json"),
      id: "flow",
      slots: [
        { address: "3.seed", name: "seed", type: "INT", current_value: 0, instance_id: "3", node_type: "KSampler" },
        { address: "99.value", name: "value", type: "INT", current_value: 5, instance_id: "99", node_type: "PrimitiveInt" },
      ],
    }),
  );
  process.env.FAKE_COMFY_MODE = "data_file";
  process.env.FAKE_COMFY_DATA_FILE = listing;

  const body = await ok(await connect(), "describe_workflow", { workflow: "flow" });

  const schema = body["schema"] as { properties: Record<string, unknown> };
  expect(Object.hasOwn(schema.properties, "3.seed")).toBe(false);
  expect(body["inert"]).toContainEqual({
    address: "3.seed",
    name: "seed",
    node_type: "KSampler",
    upstream: { node_id: "99", node_type: "PrimitiveInt", candidate_addresses: ["99.value"] },
  });
});

test("describe_workflow's other addresses are unaffected by one decoy", async () => {
  writeWorkflow("flow", decoyWorkflowBody());
  seedObjectInfoCache();
  serveSlots();

  const body = await ok(await connect(), "describe_workflow", { workflow: "flow" });

  const schema = body["schema"] as { properties: Record<string, unknown> };
  expect(Object.hasOwn(schema.properties, "6.text")).toBe(true); // untouched
  expect(body["slot_count"]).toBe(13); // still the full listing's own count
});

// --- run_workflow --------------------------------------------------------

test("run_workflow submits without --wait by default and returns the job handle", async () => {
  writeWorkflow("flow");
  serveStream(`${[event("queued", { prompt_id: PROMPT_ID }), envelopeLine(queuedPayload())].join("\n")}\n`);

  const body = await ok(await connect(), "run_workflow", { workflow: "flow" });

  expect(body["status"]).toBe("queued");
  expect(body["terminal"]).toBe(false);
  expect(body["prompt_id"]).toBe(PROMPT_ID);
  expect(argv()).not.toContain("--wait");
  // A submit the caller cannot follow is a receipt for nothing.
  expect(String(body["next_step"] ?? "")).toContain("get_job");
});

test("run_workflow blocks and reports classified outputs when asked to wait", async () => {
  writeWorkflow("flow");
  serveStream(`${envelopeLine(completedPayload())}\n`);

  const body = await ok(await connect(), "run_workflow", { workflow: "flow", wait: true });

  expect(argv()).toContain("--wait");
  expect(body["status"]).toBe("completed");
  expect(body["terminal"]).toBe(true);
  expect(body["elapsed_seconds"]).toBe(4.25);
  expect(body["outputs"]).toEqual({
    files: ["/Users/you/ComfyUI/output/banana_00001_.png"],
    urls: ["http://127.0.0.1:8188/view?filename=b.png"],
    // Port 8188 is not the instance these tests talk to, so nothing resolves.
    local_paths: {},
  });
});

test("run_workflow applies inputs to a copy and never to the caller's own file", async () => {
  const path = writeWorkflow("flow");
  const before = readFileSync(path, "utf8");
  serveStream(`${envelopeLine(queuedPayload())}\n`);

  const body = await ok(await connect(), "run_workflow", {
    workflow: "flow",
    inputs: { "3.seed": 42, "6.text": "a photo of a cat", "3.add_noise": true },
  });

  expect(body["applied"]).toEqual(["3.seed", "6.text", "3.add_noise"]);
  expect(readFileSync(path, "utf8")).toBe(before);
  expect(argv()).not.toContain(path);
});

test("a slot value above 2^53 travels exactly when it is passed as a string", async () => {
  // The documented escape hatch, asserted on the bytes the CLI received: an
  // ADDR=VALUE pair is command-line text and never becomes a JS number.
  const path = writeWorkflow("flow");
  serveStream(`${envelopeLine(queuedPayload())}\n`);
  // One tool call makes two CLI calls and $FAKE_COMFY_ARGV_OUT keeps only the
  // last, which is the `run`; the set-slot invocation is in the log.
  const log = join(workdir, "dispatch.log");
  process.env.FAKE_COMFY_DISPATCH_LOG = log;

  const body = await ok(await connect(), "run_workflow", {
    workflow: "flow",
    inputs: { "3.seed": HUGE_SEED },
  });

  const setSlot = readFileSync(log, "utf8")
    .split("\n")
    .find((line) => line.includes("set-slot"));
  expect(setSlot).toContain(`3.seed=${HUGE_SEED}`);
  // The digits `JSON.parse` would have produced must appear nowhere at all.
  expect(setSlot).not.toContain("18446744073709552000");
  expect(JSON.stringify(body)).not.toContain("18446744073709552000");
  expect(readFileSync(path, "utf8")).not.toContain(HUGE_SEED); // the user's file is untouched
});

test("an integer too large to be exact is refused with the escape hatch named", async () => {
  writeWorkflow("flow");
  serveStream(`${envelopeLine(queuedPayload())}\n`);

  const error = await failure(await connect(), "run_workflow", {
    workflow: "flow",
    inputs: { "3.seed": 18446744073709551615 },
  });

  expect(error["kind"]).toBe("invalid_input");
  expect(error["address"]).toBe("3.seed");
  expect(String(error["message"])).toContain("string of digits");
});

test("run_workflow surfaces set-slot warnings alongside the run's own", async () => {
  writeWorkflow("flow");
  process.env.FAKE_COMFY_WARNINGS =
    '[{"code":"value_out_of_range","message":"steps 500 exceeds the catalog maximum","field":"steps"}]';
  serveStream(
    `${envelopeLine(
      completedPayload({
        warnings: [{ code: "partial_execution", message: "1 of 2 output nodes returned outputs" }],
      }),
    )}\n`,
  );

  const body = await ok(await connect(), "run_workflow", {
    workflow: "flow",
    inputs: { "3.steps": 500 },
    wait: true,
  });

  const warnings = body["warnings"] as Array<Record<string, unknown>>;
  expect(warnings.map((warning) => warning["code"])).toEqual(["value_out_of_range", "partial_execution"]);
  // Which half of the operation warned is the first thing a reader needs.
  expect(warnings.map((warning) => warning["source"])).toEqual(["set_slot", "run"]);
  // ...and the undeclared fields of a warning are the useful part of it.
  expect(warnings[0]?.["field"]).toBe("steps");
});

// --- effective_parameters: what was actually submitted (landmine #14/#15) --

test("run_workflow reports effective_parameters: what the submitted graph actually holds", async () => {
  writeWorkflow("flow");
  serveStream(
    `${[
      event("prompt_preview", {
        prompt: { "3": { class_type: "KSampler", inputs: { seed: 42 } } },
        prompt_id: null,
      }),
      envelopeLine(completedPayload()),
    ].join("\n")}\n`,
  );

  const body = await ok(await connect(), "run_workflow", {
    workflow: "flow",
    inputs: { "3.seed": 42 },
    wait: true,
  });

  expect(body["effective_parameters"]).toEqual([
    { address: "3.seed", status: "confirmed", requested: 42, submitted: 42 },
  ]);
});

test("a missing effective parameter produces a loud warning nobody can miss", async () => {
  // The exact shape of landmine #15's failure: `applied` would still say
  // "3.seed" was set, but the submitted graph never carried it at all.
  writeWorkflow("flow");
  serveStream(
    `${[
      event("prompt_preview", {
        prompt: { "3": { class_type: "KSampler", inputs: { steps: 20 } } }, // no seed at all
        prompt_id: null,
      }),
      envelopeLine(completedPayload()),
    ].join("\n")}\n`,
  );

  const body = await ok(await connect(), "run_workflow", {
    workflow: "flow",
    inputs: { "3.seed": 42 },
    wait: true,
  });

  expect(body["applied"]).toContain("3.seed"); // set-slot's echo still claims success
  expect(body["effective_parameters"]).toEqual([{ address: "3.seed", status: "missing", requested: 42 }]);
  const warnings = body["warnings"] as Array<Record<string, unknown>>;
  const effectiveWarning = warnings.find((w) => w["source"] === "effective_parameters");
  expect(effectiveWarning).toBeDefined();
  expect(String(effectiveWarning?.["message"])).toContain("3.seed");
});

test("a mismatched effective parameter also produces a loud warning", async () => {
  writeWorkflow("flow");
  serveStream(
    `${[
      event("prompt_preview", {
        prompt: { "3": { class_type: "KSampler", inputs: { seed: 999 } } }, // not the 42 requested
        prompt_id: null,
      }),
      envelopeLine(completedPayload()),
    ].join("\n")}\n`,
  );

  const body = await ok(await connect(), "run_workflow", {
    workflow: "flow",
    inputs: { "3.seed": 42 },
    wait: true,
  });

  expect(body["effective_parameters"]).toEqual([
    { address: "3.seed", status: "mismatch", requested: 42, submitted: 999 },
  ]);
  const warnings = body["warnings"] as Array<Record<string, unknown>>;
  expect(warnings.some((w) => w["source"] === "effective_parameters")).toBe(true);
});

test("a confirmed effective parameter produces no extra warning", async () => {
  writeWorkflow("flow");
  serveStream(
    `${[
      event("prompt_preview", {
        prompt: { "3": { class_type: "KSampler", inputs: { seed: 42 } } },
        prompt_id: null,
      }),
      envelopeLine(completedPayload()),
    ].join("\n")}\n`,
  );

  const body = await ok(await connect(), "run_workflow", {
    workflow: "flow",
    inputs: { "3.seed": 42 },
    wait: true,
  });

  expect(body["warnings"]).toEqual([]);
});

test("effective_parameters is reported for a submit-only run too, not just wait:true", async () => {
  // Landmine #14: prompt_preview is unconditional in stream mode, not gated
  // on --wait.
  writeWorkflow("flow");
  serveStream(
    `${[
      event("prompt_preview", {
        prompt: { "3": { class_type: "KSampler", inputs: { seed: 42 } } },
        prompt_id: null,
      }),
      event("queued", { prompt_id: PROMPT_ID }),
      envelopeLine(queuedPayload()),
    ].join("\n")}\n`,
  );

  const body = await ok(await connect(), "run_workflow", {
    workflow: "flow",
    inputs: { "3.seed": 42 },
  });

  expect(body["effective_parameters"]).toEqual([
    { address: "3.seed", status: "confirmed", requested: 42, submitted: 42 },
  ]);
});

test("nothing requested yields an empty effective_parameters list", async () => {
  writeWorkflow("flow");
  serveStream(`${envelopeLine(queuedPayload())}\n`);

  const body = await ok(await connect(), "run_workflow", { workflow: "flow" });

  expect(body["effective_parameters"]).toEqual([]);
});

test("a successful run does not mirror its progress events back", async () => {
  // Measured upstream: a 400-step run produced 107KB of events, all of it
  // destined for a model's context and none of it about the outputs.
  writeWorkflow("flow");
  const chatty = Array.from({ length: 300 }, (_, i) => event("progress", { node: "3", completed: i }));
  serveStream(`${[...chatty, envelopeLine(completedPayload())].join("\n")}\n`);

  const { result, body } = await call(await connect(), "run_workflow", { workflow: "flow", wait: true });

  expect(body["event_count"]).toBe(200);
  expect(body["events_truncated"]).toBe(true);
  expect(body["events"]).toBeUndefined();
  expect(textOf(result).length).toBeLessThan(4_000);
});

test("run_workflow leaves no prepared copy behind, on success or on failure", async () => {
  writeWorkflow("flow");
  serveStream(`${envelopeLine(queuedPayload())}\n`);
  const client = await connect();
  await ok(client, "run_workflow", { workflow: "flow" });
  expect(leakedTempDirs()).toEqual([]);

  serveStream(`${failureLine({ code: "server_unreachable", message: "connection refused" })}\n`, { exit: 1 });
  await failure(client, "run_workflow", { workflow: "flow" });
  expect(leakedTempDirs()).toEqual([]);
});

test("a workflow that cannot be read is refused before anything is spawned", async () => {
  const missing = join(workdir, "gone.json");

  const error = await failure(await connect(), "run_workflow", { workflow: missing });

  expect(error["kind"]).toBe("workflow_file");
  expect(error["code"]).toBe("ENOENT");
  expect(error["workflow_path"]).toBe(missing);
});

// --- run_workflow: decoy addresses are refused, before anything is spawned -

test("run_workflow refuses a call that sets a decoy address, before spawning anything", async () => {
  writeWorkflow("flow", decoyWorkflowBody());

  const error = await failure(await connect(), "run_workflow", {
    workflow: "flow",
    inputs: { "3.seed": 42 },
  });

  expect(error["kind"]).toBe("inert_slot");
  expect(String(error["message"])).toContain("3.seed");
  expect(String(error["message"])).toContain("99.value");
  expect(error["inert_addresses"]).toEqual([
    {
      address: "3.seed",
      upstream: { node_id: "99", node_type: "PrimitiveInt", candidate_addresses: ["99.value"] },
    },
  ]);
  // The CLI was never invoked at all: not even set-slot, let alone run — the
  // argv file the fake writes on every invocation was never created.
  expect(existsSync(argvOut)).toBe(false);
});

test("run_workflow names every decoy address requested, not just the first", async () => {
  writeWorkflow(
    "flow",
    JSON.stringify({
      nodes: [
        { id: 3, type: "KSampler", inputs: [{ name: "seed", widget: { name: "seed" }, link: 10 }] },
        { id: 6, type: "CLIPTextEncode", inputs: [{ name: "text", widget: { name: "text" }, link: 11 }] },
        { id: 99, type: "PrimitiveInt", inputs: [{ name: "value", widget: { name: "value" }, link: null }] },
        { id: 98, type: "PrimitiveString", inputs: [{ name: "value", widget: { name: "value" }, link: null }] },
      ],
      links: [
        [10, 99, 0, 3, 0, "INT"],
        [11, 98, 0, 6, 0, "STRING"],
      ],
    }),
  );

  const error = await failure(await connect(), "run_workflow", {
    workflow: "flow",
    inputs: { "3.seed": 42, "6.text": "hello" },
  });

  expect(error["kind"]).toBe("inert_slot");
  const addresses = (error["inert_addresses"] as Array<Record<string, unknown>>)
    .map((entry) => entry["address"])
    .sort();
  expect(addresses).toEqual(["3.seed", "6.text"]);
});

test("run_workflow allows setting the effective address that actually supplies a decoy", async () => {
  writeWorkflow("flow", decoyWorkflowBody());
  serveStream(`${envelopeLine(queuedPayload())}\n`);

  const body = await ok(await connect(), "run_workflow", {
    workflow: "flow",
    inputs: { "99.value": 7 },
  });

  expect(body["status"]).toBe("queued");
});

test("run_workflow proceeds normally with no inputs, even when the workflow has decoys", async () => {
  writeWorkflow("flow", decoyWorkflowBody());
  serveStream(`${envelopeLine(queuedPayload())}\n`);

  const body = await ok(await connect(), "run_workflow", { workflow: "flow" });

  expect(body["status"]).toBe("queued");
});

test("run_workflow refuses on the real measured decoy address of the ground-truth workflow", async () => {
  // The exact benchmark that motivated this feature: setting 52/6.text
  // produced 150s of stock tropical house regardless of what was asked for.
  const path = join(workdir, "audio.json");
  writeFileSync(path, readFileSync(join(FIXTURES, "audio_stable_audio_3_medium.json"), "utf8"));

  const error = await failure(await connect(), "run_workflow", {
    workflow: path,
    inputs: { "52/6.text": "black metal" },
  });

  expect(error["kind"]).toBe("inert_slot");
  expect(String(error["message"])).toContain("52/6.text");
});

test("run_workflow accepts the real measured effective addresses of the ground-truth workflow", async () => {
  // The corrected fix: the SAME workflow, set through its real controls.
  const path = join(workdir, "audio.json");
  writeFileSync(path, readFileSync(join(FIXTURES, "audio_stable_audio_3_medium.json"), "utf8"));
  serveStream(`${envelopeLine(queuedPayload())}\n`);

  const body = await ok(await connect(), "run_workflow", {
    workflow: path,
    inputs: { "52/31.value": "black metal", "52/36.value": 60, "52/3.seed": 42 },
  });

  expect(body["status"]).toBe("queued");
});

// --- errors become actionable results, not opaque transport faults -------

test("a failure the CLI diagnosed keeps its code, hint and routing target", async () => {
  // The whole point of the mapping: `.code` is what a model branches on, and an
  // uncaught throw would flatten it into an opaque transport error.
  writeWorkflow("flow");
  serveStream(
    `${failureLine({
      code: "server_unreachable",
      message: "connection refused",
      hint: "is ComfyUI running?",
    })}\n`,
    { exit: 1 },
  );

  const error = await failure(await connect(), "run_workflow", { workflow: "flow" });

  expect(error["kind"]).toBe("run_failed");
  expect(error["code"]).toBe("server_unreachable");
  expect(error["hint"]).toBe("is ComfyUI running?");
  expect(error["where"]).toBe("local");
  expect(String(error["message"])).toContain("connection refused");
});

test("a failed run carries the events that explain it, not just the one-line verdict", async () => {
  // Upstream splits the diagnosis: the envelope carries the classified verdict
  // and the event carries the server's whole traceback.
  writeWorkflow("flow");
  serveStream(
    `${[
      event("execution_error", {
        prompt_id: PROMPT_ID,
        details: { node_id: "3", exception_type: "torch.OutOfMemoryError" },
      }),
      failureLine({ code: "execution_error", message: "Node 3 (KSampler) raised: CUDA out of memory" }),
    ].join("\n")}\n`,
    { exit: 1 },
  );

  const error = await failure(await connect(), "run_workflow", { workflow: "flow" });

  expect(error["kind"]).toBe("run_failed");
  expect(error["code"]).toBe("execution_error");
  const events = error["events"] as Array<Record<string, unknown>>;
  expect(events).toHaveLength(1);
  expect(events[0]?.["details"]).toMatchObject({ exception_type: "torch.OutOfMemoryError" });
});

test("a run failure is not classified as a plain CLI failure", async () => {
  // RunFailedError extends ComfyCliError, so an `instanceof` chain in the wrong
  // order silently drops the events and reports the generic kind.
  writeWorkflow("flow");
  serveStream(`${failureLine({ code: "execution_error", message: "boom" })}\n`, { exit: 1 });

  const error = await failure(await connect(), "run_workflow", { workflow: "flow" });

  expect(error["kind"]).not.toBe("comfy_cli");
  expect(error).toHaveProperty("events");
});

test("a plain CLI failure is classified as one", async () => {
  process.env.FAKE_COMFY_MODE = "fail_code";
  process.env.FAKE_COMFY_JOBS_MODE = "fail_code";
  process.env.FAKE_COMFY_ERROR_CODE = "prompt_not_found";
  process.env.FAKE_COMFY_ERROR_MESSAGE = "no such prompt";

  const error = await failure(await connect(), "get_job", { prompt_id: PROMPT_ID });

  expect(error["kind"]).toBe("comfy_cli");
  expect(error["code"]).toBe("prompt_not_found");
});

test("a missing comfy binary says what to install and where it looked", async () => {
  process.env.COMFY_BIN = join(workdir, "definitely-not-installed");
  writeWorkflow("flow");

  const error = await failure(await connect(), "run_workflow", { workflow: "flow" });

  expect(error["kind"]).toBe("comfy_unavailable");
  expect(String(error["message"])).toContain("COMFY_BIN");
  expect(error["binary"]).toBe(join(workdir, "definitely-not-installed"));
});

test("a timeout is its own kind and still names the job it started", async () => {
  writeWorkflow("flow");
  serveStream(`${event("queued", { prompt_id: PROMPT_ID })}\n`);
  process.env.FAKE_COMFY_HANG = "1";

  const error = await failure(await connect(), "run_workflow", { workflow: "flow", timeout_seconds: 1 });

  expect(error["kind"]).toBe("timeout");
  expect(String(error["message"])).toContain(PROMPT_ID);
  expect(String(error["message"])).toContain("get_job");
});

test("a payload the CLI contract does not allow is a contract violation, not a CLI failure", async () => {
  // The difference an operator can act on: one is ComfyUI saying no, the other
  // is the CLI's own output changing shape under us.
  writeWorkflow("flow");
  seedObjectInfoCache();
  serveData({ workflow: "flow", id: "flow" }); // no `slots`

  const error = await failure(await connect(), "describe_workflow", { workflow: "flow" });

  expect(error["kind"]).toBe("contract_violation");
  expect(String(error["message"])).toContain("slots");
});

test("node definitions that cannot be fetched name the address and the cache path", async () => {
  writeWorkflow("flow");
  nothingRunning();
  serveSlots(); // nothing seeds the cache, and nothing answers on the port

  const error = await failure(await connect(), "describe_workflow", { workflow: "flow" });

  expect(error["kind"]).toBe("object_info_unavailable");
  expect(String(error["url"])).toContain(String(deadPort));
  expect(String(error["cache_path"])).toContain("object_info-");
});

test("an error result is never flattened to a bare message", async () => {
  // The SDK's own fallback turns a thrown error into `{content:[text]}` with
  // nothing but `error.message` in it, which is exactly what a model cannot act
  // on. Every failure here is structured JSON with a kind.
  process.env.FAKE_COMFY_MODE = "fail_code";
  process.env.FAKE_COMFY_JOBS_MODE = "fail_code";
  process.env.FAKE_COMFY_ERROR_CODE = "server_not_running";
  process.env.FAKE_COMFY_ERROR_MESSAGE = "no server";

  const { result, body } = await call(await connect(), "get_job", { prompt_id: PROMPT_ID });

  expect(result.isError).toBe(true);
  expect(Object.keys(body)).toEqual(["error"]);
  expect(body["error"]).toMatchObject({ kind: "comfy_cli", code: "server_not_running" });
});

// --- jobs ----------------------------------------------------------------

test("get_job reports a job's status and its classified outputs", async () => {
  const statusFile = join(workdir, "status.json");
  writeFileSync(
    statusFile,
    JSON.stringify({
      prompt_id: PROMPT_ID,
      status: "completed",
      outputs: ["/out/a.png", "http://127.0.0.1:8188/view?filename=b.png"],
      host: "127.0.0.1",
      port: 8188,
    }),
  );
  process.env.FAKE_COMFY_MODE = "jobs";
  process.env.FAKE_COMFY_JOBS_STATUS_FILE = statusFile;

  const body = await ok(await connect(), "get_job", { prompt_id: PROMPT_ID });

  expect(body["prompt_id"]).toBe(PROMPT_ID);
  expect(body["status"]).toBe("completed");
  expect(body["terminal"]).toBe(true);
  expect(body["outputs"]).toEqual({
    files: ["/out/a.png"],
    urls: ["http://127.0.0.1:8188/view?filename=b.png"],
    local_paths: {},
  });
});

// --- the local path behind a /view URL -----------------------------------

test("run_workflow reports the local file a /view URL names", async () => {
  // The point of the whole feature: a model that has just rendered an image can
  // look at it, instead of holding a URL it would have to fetch.
  writeWorkflow("flow");
  const outputDir = makeDir("comfy-output");
  writeFileSync(join(outputDir, "mcp-e2e_00001_.png"), "png bytes");
  const port = serveInstanceWritingTo({ output: outputDir });
  const url = viewUrl(port, { filename: "mcp-e2e_00001_.png", subfolder: "", type: "output" });
  serveStream(`${envelopeLine(completedPayload({ outputs: [url] }))}\n`);

  const body = await ok(await connect(), "run_workflow", { workflow: "flow", wait: true });

  expect(body["outputs"]).toEqual({
    files: [],
    urls: [url],
    local_paths: { [url]: join(outputDir, "mcp-e2e_00001_.png") },
  });
});

test("the URL stays even once its local path is known", async () => {
  // Resolving is additive. A caller that fetches the URL — a different machine's
  // MCP client, say — must not find the artifact has become a path it cannot
  // reach, so the URL is never replaced.
  writeWorkflow("flow");
  const outputDir = makeDir("comfy-output");
  writeFileSync(join(outputDir, "kept.png"), "png bytes");
  const port = serveInstanceWritingTo({ output: outputDir });
  const url = viewUrl(port, { filename: "kept.png", subfolder: "", type: "output" });
  serveStream(`${envelopeLine(completedPayload({ outputs: [url] }))}\n`);

  const body = await ok(await connect(), "run_workflow", { workflow: "flow", wait: true });

  expect((body["outputs"] as Record<string, unknown>)["urls"]).toEqual([url]);
});

test("get_job reports the local file too, from the same instance's directories", async () => {
  const outputDir = makeDir("comfy-output");
  writeFileSync(join(outputDir, "polled_00007_.png"), "png bytes");
  const port = serveInstanceWritingTo({ output: outputDir });
  const url = viewUrl(port, { filename: "polled_00007_.png", subfolder: "", type: "output" });
  const statusFile = join(workdir, "status.json");
  writeFileSync(
    statusFile,
    JSON.stringify({ prompt_id: PROMPT_ID, status: "completed", outputs: [url] }),
  );
  process.env.FAKE_COMFY_MODE = "jobs";
  process.env.FAKE_COMFY_JOBS_STATUS_FILE = statusFile;

  const body = await ok(await connect(), "get_job", { prompt_id: PROMPT_ID });

  expect(body["outputs"]).toEqual({
    files: [],
    urls: [url],
    local_paths: { [url]: join(outputDir, "polled_00007_.png") },
  });
});

test("a URL whose file is not on disk comes back as a URL and nothing more", async () => {
  // Never fabricate: a path a caller would open and fail on is worse than the
  // URL it replaced.
  const outputDir = makeDir("comfy-output");
  const port = serveInstanceWritingTo({ output: outputDir });
  const url = viewUrl(port, { filename: "never_rendered.png", subfolder: "", type: "output" });
  const statusFile = join(workdir, "status.json");
  writeFileSync(
    statusFile,
    JSON.stringify({ prompt_id: PROMPT_ID, status: "completed", outputs: [url] }),
  );
  process.env.FAKE_COMFY_MODE = "jobs";
  process.env.FAKE_COMFY_JOBS_STATUS_FILE = statusFile;

  const body = await ok(await connect(), "get_job", { prompt_id: PROMPT_ID });

  expect(body["outputs"]).toEqual({ files: [], urls: [url], local_paths: {} });
});

test("resolving a job's outputs never starts a ComfyUI", async () => {
  // get_job stays a probe. The instance it needs is the one that ran the job,
  // and a freshly launched one would neither know the job nor have written the
  // file — so an unreachable server is answered, not started.
  const statusFile = join(workdir, "status.json");
  writeFileSync(
    statusFile,
    JSON.stringify({
      prompt_id: PROMPT_ID,
      status: "completed",
      outputs: ["http://127.0.0.1:8188/view?filename=b.png&type=output"],
    }),
  );
  process.env.FAKE_COMFY_MODE = "jobs";
  process.env.FAKE_COMFY_JOBS_STATUS_FILE = statusFile;
  nothingRunning();
  process.env.MCP_COMFYUI_AUTO_LAUNCH = "1";
  const log = cliLog();

  const body = await ok(await connect(), "get_job", { prompt_id: PROMPT_ID });

  expect((body["outputs"] as Record<string, unknown>)["local_paths"]).toEqual({});
  expect(await settledInvocationsOf(log, "launch", 0)).toEqual([]);
});

test("get_job's description says where the local path is and that it may be absent", async () => {
  const description = toolNamed(await tools(await connect()), "get_job").description ?? "";
  expect(description).toContain("local_paths");
});

test("run_workflow's description says where the local path is", async () => {
  const description = toolNamed(await tools(await connect()), "run_workflow").description ?? "";
  expect(description).toContain("local_paths");
});

test("cancel_job says which of the three things it did", async () => {
  const statusFile = join(workdir, "status.json");
  const cancelFile = join(workdir, "cancel.json");
  writeFileSync(statusFile, JSON.stringify({ prompt_id: PROMPT_ID, status: "running" }));
  writeFileSync(cancelFile, JSON.stringify({ prompt_id: PROMPT_ID, found: true }));
  process.env.FAKE_COMFY_MODE = "jobs";
  process.env.FAKE_COMFY_JOBS_STATUS_FILE = statusFile;
  process.env.FAKE_COMFY_JOBS_CANCEL_FILE = cancelFile;

  const body = await ok(await connect(), "cancel_job", { prompt_id: PROMPT_ID });

  expect(body["outcome"]).toBe("cancelled");
  expect(body["previous_status"]).toBe("running");
});

test("cancelling a finished job is a successful answer, not a failure", async () => {
  // `comfy jobs cancel` is idempotent for known jobs; reporting that as an
  // error would train a caller to ignore errors.
  const statusFile = join(workdir, "status.json");
  writeFileSync(statusFile, JSON.stringify({ prompt_id: PROMPT_ID, status: "completed" }));
  process.env.FAKE_COMFY_MODE = "jobs";
  process.env.FAKE_COMFY_JOBS_STATUS_FILE = statusFile;

  const { result, body } = await call(await connect(), "cancel_job", { prompt_id: PROMPT_ID });

  expect(result.isError).toBeFalsy();
  expect(body["outcome"]).toBe("already_finished");
  expect(body["previous_status"]).toBe("completed");
});

test("an id that names no job is answered, not thrown", async () => {
  process.env.FAKE_COMFY_MODE = "jobs";
  process.env.FAKE_COMFY_JOBS_STATUS_ERROR = "prompt_not_found";
  process.env.FAKE_COMFY_JOBS_CANCEL_ERROR = "prompt_not_found";

  const { result, body } = await call(await connect(), "cancel_job", { prompt_id: PROMPT_ID });

  expect(result.isError).toBeFalsy();
  expect(body["outcome"]).toBe("not_found");
  expect((body["error"] as Record<string, unknown>)["code"]).toBe("prompt_not_found");
});

// --- launch_comfyui ------------------------------------------------------

test("launch_comfyui refuses when an instance is already answering", async () => {
  // Landmine #8: a second instance fights the first for the port, for VRAM and
  // for the shared model directory.
  process.env.MCP_COMFYUI_ALLOW_LAUNCH = "1";
  process.env.FAKE_COMFY_MODE = "launch";

  const body = await ok(await connect(), "launch_comfyui");

  expect(body["outcome"]).toBe("already_running");
  expect((body["instance"] as Record<string, unknown>)["desktop_managed"]).toBe(true);
  // Not "invoked and ignored" — the CLI never ran at all.
  expect(() => readFileSync(argvOut, "utf8")).toThrow();
});

test("launch_comfyui refuses an empty listen address at the schema", async () => {
  // `resolveHost("")` throws a bare TypeError deep inside the library, which
  // would surface as an internal error for what is plainly a bad argument.
  process.env.MCP_COMFYUI_ALLOW_LAUNCH = "1";
  const client = await connect();

  const result = (await client.callTool({
    name: "launch_comfyui",
    arguments: { listen: "" },
  })) as CallToolResult;

  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("listen");
});

// --- configuration -------------------------------------------------------

test("a port that is not a port is refused at startup rather than at first use", () => {
  expect(() => createServer({ MCP_COMFYUI_PORT: "not-a-number" })).toThrow(/MCP_COMFYUI_PORT/);
  expect(() => createServer({ MCP_COMFYUI_PORT: "70000" })).toThrow(/MCP_COMFYUI_PORT/);
  expect(() => createServer({ MCP_COMFYUI_PORT: "0" })).toThrow(/MCP_COMFYUI_PORT/);
});

test("an empty address setting means unset, as an exported-but-unset shell variable does", () => {
  // A shell that exports a variable it never assigned produces "", and that
  // means the operator said nothing — not that ComfyUI lives at the empty host,
  // which `resolveHost` would reject with a bare TypeError.
  expect(toolConfig({ MCP_COMFYUI_HOST: "", MCP_COMFYUI_PORT: "  " })).toMatchObject({
    host: undefined,
    port: undefined,
  });
  expect(toolConfig({ MCP_COMFYUI_HOST: "10.0.0.4", MCP_COMFYUI_PORT: "8189" })).toMatchObject({
    host: "10.0.0.4",
    port: 8189,
  });
});

test("the configured address is the one every tool talks to", async () => {
  const port = Number(process.env.MCP_COMFYUI_PORT);
  const body = await ok(await connect(), "comfy_status");
  expect(body["port"]).toBe(port);
  expect(body["url"]).toBe(`http://127.0.0.1:${port}/system_stats`);
});

// --- the stdio landmine --------------------------------------------------

test("the server writes nothing to stdout but JSON-RPC frames", async () => {
  // stdout IS the protocol. One stray console.log corrupts the stream in a way
  // that is close to undiagnosable from the client side, so this runs the real
  // entrypoint over real pipes and reads every byte it produced.
  writeWorkflow("flow");
  process.env.FAKE_COMFY_MODE = "fail_code";
  process.env.FAKE_COMFY_JOBS_MODE = "fail_code";
  process.env.FAKE_COMFY_ERROR_CODE = "server_not_running";
  process.env.FAKE_COMFY_ERROR_MESSAGE = "no server";

  const child = spawnDist();

  const requests = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "raw", version: "0.0.0" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_workflows", arguments: {} } },
    // ...and a call that fails, since a debug print is likeliest on an error path.
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "get_job", arguments: { prompt_id: PROMPT_ID } },
    },
  ];
  await writeStdin(child, requests.map((request) => `${JSON.stringify(request)}\n`).join(""));

  const stdout = await readUntil(child.stdout, 4, 10_000);
  await terminate(child);

  const lines = stdout.split("\n").filter((line) => line.trim() !== "");
  expect(lines.length).toBeGreaterThanOrEqual(4);
  const messages = lines.map((line) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`stdout carried a line that is not a JSON-RPC frame: ${JSON.stringify(line)}`);
    }
    expect(value).toMatchObject({ jsonrpc: "2.0" });
    return value as Record<string, unknown>;
  });

  const byId = new Map(messages.filter((m) => m["id"] !== undefined).map((m) => [m["id"], m]));
  expect(byId.get(1)).toHaveProperty("result");
  const listed = byId.get(3)?.["result"] as { content: Array<{ text: string }> };
  expect(JSON.parse(listed.content[0]!.text)).toMatchObject({ count: 1 });
  const failed = byId.get(4)?.["result"] as { isError: boolean; content: Array<{ text: string }> };
  expect(failed.isError).toBe(true);
  expect(JSON.parse(failed.content[0]!.text)).toMatchObject({
    error: { kind: "comfy_cli", code: "server_not_running" },
  });
});

/** Read the child's stdout until it holds `count` complete lines, or time out. */
async function readUntil(
  stream: ReadableStream<Uint8Array>,
  count: number,
  timeoutMs: number,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let text = "";
  try {
    while (text.split("\n").filter((line) => line.trim() !== "").length < count) {
      if (Date.now() >= deadline) {
        throw new Error(`the server produced only ${JSON.stringify(text)} within ${timeoutMs}ms`);
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (value) text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return text;
}

/**
 * Like {@link readUntil}, but never blocks past `timeoutMs` even when a
 * single `reader.read()` call itself would hang forever — which is exactly
 * what "no response ever arrives" (Finding 1's overflow case) looks like from
 * this side. `readUntil` only re-checks its deadline *between* reads, so it
 * cannot be used to prove a negative; this races every read against the
 * remaining budget instead.
 */
async function readUntilSafely(
  stream: ReadableStream<Uint8Array>,
  count: number,
  timeoutMs: number,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  const timedOut = Symbol("timed-out");
  let text = "";
  try {
    while (text.split("\n").filter((line) => line.trim() !== "").length < count) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`the server produced only ${JSON.stringify(text)} within ${timeoutMs}ms`);
      }
      const outcome = await Promise.race([reader.read(), sleep(remaining).then(() => timedOut)]);
      if (typeof outcome === "symbol") continue; // let the loop re-check the deadline
      const { done, value } = outcome;
      if (done) {
        // The stream closed with fewer than `count` lines produced: no more
        // are coming, ever, which is exactly what a transport that died
        // mid-response looks like from this side. That is a failure to
        // report, not a silent partial success.
        throw new Error(`the stream closed after only ${JSON.stringify(text)} (wanted ${count} lines)`);
      }
      if (value) text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return text;
}

/** Whatever a stream produces within `timeoutMs`. Never throws, on a timeout or on closing. */
async function readFor(stream: ReadableStream<Uint8Array>, timeoutMs: number): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  const timedOut = Symbol("timed-out");
  let text = "";
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const outcome = await Promise.race([reader.read(), sleep(remaining).then(() => timedOut)]);
      if (typeof outcome === "symbol") break;
      const { done, value } = outcome;
      if (done) break;
      if (value) text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return text;
}

/**
 * A `tools/call` line, padded with a `prompt_id` filler so its total byte
 * length (line + trailing newline) is exactly `totalBytes`. `get_job`'s
 * `prompt_id` is schema-checked only for "non-empty string", so an oversized
 * one is a well-formed, schema-valid request — the payload is *large*, not
 * malformed, which is exactly Finding 1's "(a) legitimate" case.
 */
function paddedToolCallLine(id: number, totalBytes: number): string {
  const skeleton = {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "get_job", arguments: { prompt_id: "" } },
  };
  const overhead = Buffer.byteLength(JSON.stringify(skeleton), "utf8") + 1; // +1 for the trailing \n
  const padding = "x".repeat(Math.max(0, totalBytes - overhead));
  skeleton.params.arguments.prompt_id = padding;
  return `${JSON.stringify(skeleton)}\n`;
}

const INITIALIZE_LINE = `${JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0.0.0" } },
})}\n${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`;

// --- Finding 1: an oversized message must not kill the server silently ----

beforeAll(async () => {
  await buildDist();
});

test("a legitimate large payload does not kill the server", async () => {
  // The original repro was ~11.5MB and the SDK's own default buffer is 10MB;
  // this line is deliberately sized in between, and well under this server's
  // own MAX_BUFFER_SIZE. Driven against the real compiled binary, since that
  // is what was actually observed dying silently.
  process.env.FAKE_COMFY_MODE = "fail_code";
  process.env.FAKE_COMFY_JOBS_MODE = "fail_code";
  process.env.FAKE_COMFY_ERROR_CODE = "server_not_running";
  process.env.FAKE_COMFY_ERROR_MESSAGE = "no server";

  const child = spawnDist();
  const followUp = `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} })}\n`;

  await writeStdin(child, INITIALIZE_LINE);
  await writeStdin(child, paddedToolCallLine(2, 11_500_000));
  await writeStdin(child, followUp);

  const stdout = await readUntilSafely(child.stdout, 3, 20_000);
  await terminate(child);

  const lines = stdout.split("\n").filter((line) => line.trim() !== "");
  const messages = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const byId = new Map(messages.filter((m) => m["id"] !== undefined).map((m) => [m["id"], m]));

  expect(byId.get(1)).toHaveProperty("result"); // initialize succeeded
  expect(byId.get(2)).toBeDefined(); // the 11.5MB request got a real response
  expect(byId.get(3)).toHaveProperty("result"); // and the connection survived to serve a follow-up
});

test("a payload beyond the buffer limit is reported on stderr rather than dying silently", async () => {
  // Sized comfortably above MAX_BUFFER_SIZE. The SDK's own ReadBuffer.append()
  // (dist/esm/shared/stdio.js) still throws and closes the transport on
  // overflow — that part cannot be made recoverable without wrapping the
  // transport (see the report) — but the failure must now be visible.
  const child = spawnDist({ ...process.env, COMFY_BIN: FAKE_COMFY });

  await writeStdin(child, INITIALIZE_LINE);
  await readUntilSafely(child.stdout, 1, 5_000); // the initialize response

  // The write of the 20MB line can itself fail with a broken pipe: the
  // server exits once `ReadBuffer.append()` throws on overflow (see
  // `src/index.ts`'s doc comment on Finding 1), and streaming 20MB takes
  // long enough that the child can already be gone before the write
  // completes. Measured directly: Deno's stdin writer rejects with
  // `Deno.errors.BrokenPipe` when that race is lost. That IS the failure
  // this test exists to prove (the transport died), not a different one, so
  // it is tolerated here rather than propagated.
  try {
    await writeStdin(child, paddedToolCallLine(2, 20_000_000));
  } catch (err) {
    if (!(err instanceof Deno.errors.BrokenPipe)) throw err;
  }

  // No response for the oversized request ever arrives.
  await expect(readUntilSafely(child.stdout, 2, 4_000)).rejects.toThrow();

  const stderr = await readFor(child.stderr, 1_000);
  await terminate(child);

  expect(stderr.trim()).not.toBe("");
});

test("tearing down a child that has already exited is not itself a failure", async () => {
  // The test above ends holding a child that has exited BY DESIGN: the
  // transport dies on overflow, which is the very thing it asserts. Deno
  // reaps an exited child on a background task — measured here at ~2ms after
  // exit — and `ChildProcess.kill()` on a reaped child throws
  // `TypeError: Child process has already terminated`. An unguarded teardown
  // therefore passes only while every remaining step lands inside that ~2ms
  // window, which on this machine they all do, in a single tick.
  //
  // Measured, by injecting a delay before teardown and changing nothing else:
  // 0ms passes, 5ms fails with that exact TypeError. `ubuntu-latest` supplied
  // the delay for real on run 32149609864 (2026-08-18) — failing PR #22's
  // merge and, because publish.yml gates publishing on the test step,
  // publishing nothing.
  //
  // `await child.status` below removes the race from THIS test rather than
  // reproducing it: the child is guaranteed already reaped, so teardown meets
  // the hostile case every time instead of one run in a hundred.
  const child = new Deno.Command("node", {
    args: ["-e", "process.exit(0)"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  await child.status;

  const outcome = await terminate(child).then(
    () => "torn down",
    (err: unknown) => `threw ${err instanceof Error ? err.message : String(err)}`,
  );
  expect(outcome).toBe("torn down");
});

// --- Finding 2: a malformed tools/call must not read as a server bug ------

test("a malformed tools/call is refused as an invalid request, not reported as an internal error", async () => {
  const child = spawnDist({ ...process.env, COMFY_BIN: FAKE_COMFY });

  const malformed = [
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_workflows", arguments: null } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_workflows", arguments: [] } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_workflows", arguments: 42 } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { arguments: {} } }, // missing name
    { jsonrpc: "2.0", id: 6, method: "tools/call" }, // omitted params
  ];
  await writeStdin(child, INITIALIZE_LINE);
  await writeStdin(child, malformed.map((request) => `${JSON.stringify(request)}\n`).join(""));

  const stdout = await readUntilSafely(child.stdout, 1 + malformed.length, 10_000);
  await terminate(child);

  const lines = stdout.split("\n").filter((line) => line.trim() !== "");
  const messages = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const byId = new Map(messages.filter((m) => m["id"] !== undefined).map((m) => [m["id"], m]));

  for (const { id } of malformed) {
    const response = byId.get(id) as { error?: { code: number; message: string } } | undefined;
    expect(response?.error).toBeDefined();
    // -32602 (Invalid params): the caller's request was wrong. Not -32603
    // (Internal error), which is a claim that this server has a bug.
    expect(response?.error?.code).toBe(-32602);
    expect(response?.error?.message).not.toContain('"code": "invalid_type"');
    expect(response?.error?.message.length ?? 0).toBeGreaterThan(0);
  }
});

// --- auto-launch ---------------------------------------------------------

/** Count CLI invocations: $FAKE_COMFY_ARGV_OUT keeps only the last one. */
function cliLog(): string {
  const log = join(workdir, "invocations");
  process.env.FAKE_COMFY_DISPATCH_LOG = log;
  return log;
}

function invocationsOf(log: string, matching: string): string[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.includes(matching));
}

/**
 * The matching invocations, once they have stopped arriving. A launch does not
 * wait for the CLI, so a tool call can return before the spawn has recorded
 * itself; the trailing pause is the window a duplicate would appear in.
 */
async function settledInvocationsOf(log: string, matching: string, expected: number): Promise<string[]> {
  const deadline = Date.now() + 5_000;
  while (invocationsOf(log, matching).length < expected && Date.now() < deadline) await sleep(5);
  await sleep(60);
  return invocationsOf(log, matching);
}

test("auto-launch is on by default", async () => {
  // The user's requirement: if ComfyUI is not running, the server starts it.
  expect(toolConfig({})).toMatchObject({ autoLaunch: true });
});

test("the explicit launch tool stays opt-in even though auto-launch is not", async () => {
  // The two settings answer different questions: may this server start ComfyUI
  // when it needs one, and may a MODEL start one with startup flags of its own.
  expect(toolConfig({})).toMatchObject({ autoLaunch: true, allowLaunch: false });
});

test("run_workflow starts ComfyUI when nothing is answering", async () => {
  writeWorkflow("flow");
  launchable(2);
  const log = cliLog();
  process.env.FAKE_COMFY_RUN_MODE = "run_stream";
  serveStream(`${envelopeLine(queuedPayload())}\n`);

  const body = await ok(await connect(), "run_workflow", { workflow: "flow" });

  expect(body["status"]).toBe("queued");
  expect(await settledInvocationsOf(log, "launch", 1)).toHaveLength(1);
});

test("run_workflow does not start a second ComfyUI when one is answering", async () => {
  // The guard, reached through the auto-launch door rather than the tool.
  writeWorkflow("flow");
  process.env.MCP_COMFYUI_AUTO_LAUNCH = "1";
  const log = cliLog();
  serveStream(`${envelopeLine(queuedPayload())}\n`);

  await ok(await connect(), "run_workflow", { workflow: "flow" });

  expect(await settledInvocationsOf(log, "launch", 0)).toEqual([]);
});

test("two concurrent run_workflow calls start exactly one ComfyUI", async () => {
  writeWorkflow("flow");
  launchable(4);
  const log = cliLog();
  serveStream(`${envelopeLine(queuedPayload())}\n`);
  const client = await connect();

  const [first, second] = await Promise.all([
    call(client, "run_workflow", { workflow: "flow" }),
    call(client, "run_workflow", { workflow: "flow" }),
  ]);

  expect(first.result.isError).toBeFalsy();
  expect(second.result.isError).toBeFalsy();
  expect(await settledInvocationsOf(log, "launch", 1)).toHaveLength(1);
});

test("run_workflow refuses actionably when auto-launch is off and nothing runs", async () => {
  writeWorkflow("flow");
  nothingRunning();
  const log = cliLog();

  const error = await failure(await connect(), "run_workflow", { workflow: "flow" });

  expect(error["kind"]).toBe("comfyui_not_running");
  expect(String(error["message"])).toContain("MCP_COMFYUI_AUTO_LAUNCH");
  expect(await settledInvocationsOf(log, "launch", 0)).toEqual([]);
});

test("comfy_status never launches, whatever the setting says", async () => {
  // It is the tool you call to ask whether anything is running; a status query
  // that starts a GPU process is indefensible.
  nothingRunning();
  process.env.MCP_COMFYUI_AUTO_LAUNCH = "1";
  const log = cliLog();

  const body = await ok(await connect(), "comfy_status");

  expect(body["running"]).toBe(false);
  expect(await settledInvocationsOf(log, "launch", 0)).toEqual([]);
});

test("get_job does not launch, because a fresh server would not know the job", async () => {
  nothingRunning();
  process.env.MCP_COMFYUI_AUTO_LAUNCH = "1";
  const log = cliLog();
  process.env.FAKE_COMFY_JOBS_MODE = "fail_code";
  process.env.FAKE_COMFY_MODE = "fail_code";
  process.env.FAKE_COMFY_ERROR_CODE = "server_not_running";
  process.env.FAKE_COMFY_ERROR_MESSAGE = "no server";

  await failure(await connect(), "get_job", { prompt_id: PROMPT_ID });

  expect(await settledInvocationsOf(log, "launch", 0)).toEqual([]);
});

test("describe_workflow serves a fresh cache without starting anything", async () => {
  // Landmine #7 is the whole reason the cache exists: introspection must not
  // need a server, and must therefore not start one.
  writeWorkflow("flow");
  nothingRunning();
  process.env.MCP_COMFYUI_AUTO_LAUNCH = "1";
  const log = cliLog();
  seedObjectInfoCache();
  serveSlots();

  const body = await ok(await connect(), "describe_workflow", { workflow: "flow" });

  expect(body["slot_count"]).toBe(13);
  expect(await settledInvocationsOf(log, "launch", 0)).toEqual([]);
});

test("describe_workflow starts ComfyUI when it has no usable cache", async () => {
  writeWorkflow("flow");
  const port = launchable(2);
  const log = cliLog();
  // The launched instance serves object_info once it is up.
  servers.push(denoServe(() => new Response("{}")));
  process.env.FAKE_COMFY_MODE = "data_file";
  process.env.FAKE_COMFY_DATA_FILE = SLOTS_SAMPLE;

  // No cache is seeded, so the first fetch fails and the launch path is taken.
  const error = await failure(await connect(), "describe_workflow", { workflow: "flow" });

  // The launch happened; the instance simply has no /object_info to give.
  expect(await settledInvocationsOf(log, "launch", 1)).toHaveLength(1);
  expect(error["kind"]).toBe("object_info_unavailable");
  expect(String(error["url"])).toContain(String(port));
});

test("a fetch that failed against a running ComfyUI is not retried", async () => {
  // ensureInstance answering `already_running` means the address was never the
  // problem, so refetching would spend a second 1.7MB round trip to produce the
  // same failure — and report the retry's error in place of the original.
  writeWorkflow("flow");
  process.env.MCP_COMFYUI_AUTO_LAUNCH = "1";
  const log = cliLog();
  serveSlots(); // no cache is seeded, and this instance 404s /object_info

  const error = await failure(await connect(), "describe_workflow", { workflow: "flow" });

  expect(error["kind"]).toBe("object_info_unavailable");
  expect(objectInfoRequests).toBe(1);
  expect(await settledInvocationsOf(log, "launch", 0)).toEqual([]);
});

// --- the stale-cache floor -------------------------------------------------

test("describe_workflow answers from a cache older than the TTL, and says so", async () => {
  // Nothing is listening on `deadPort`, so the live fetch fails and the floor
  // is the only thing that can answer.
  writeWorkflow("default_image_gen");
  cacheAged("127.0.0.1", deadPort, TWO_WEEKS);
  serveSlots();

  const body = await ok(await connect(), "describe_workflow", {
    workflow: "default_image_gen",
    host: `127.0.0.1:${deadPort}`,
  });

  const info = body["object_info"] as Record<string, unknown>;
  expect(body["schema"]).toBeDefined();
  expect(info["stale"]).toBe(true);
  expect(info["age_hours"] as number).toBeGreaterThan(300);
});

test("validate_workflow answers from a stale cache too", async () => {
  // The test that would have caught the defect this design shipped with on its
  // first pass. validate takes a SECOND, independent trip through
  // ensureObjectInfoCache to get the --input path; patching withObjectInfo
  // alone leaves that trip re-running the 24h check and throwing.
  writeWorkflow("default_image_gen");
  cacheAged("127.0.0.1", deadPort, TWO_WEEKS);
  process.env.FAKE_COMFY_MODE = "validate";
  process.env.FAKE_COMFY_VALIDATE_FILE = VALIDATE_SAMPLE;

  const body = await ok(await connect(), "validate_workflow", {
    workflow: "default_image_gen",
    host: `127.0.0.1:${deadPort}`,
  });

  expect(body["valid"]).toBeDefined();
  expect((body["object_info"] as Record<string, unknown>)["stale"]).toBe(true);
});

test("a fresh cache carries no staleness block at all", async () => {
  // Absence is the signal. A `stale: false` would make every caller check a
  // field that is almost always the same.
  writeWorkflow("default_image_gen");
  cacheAged("127.0.0.1", deadPort, 60_000);
  serveSlots();

  const body = await ok(await connect(), "describe_workflow", {
    workflow: "default_image_gen",
    host: `127.0.0.1:${deadPort}`,
  });

  expect(body["object_info"]).toBeUndefined();
});

test("no cache at all still fails, without a second fetch", async () => {
  // Asserted by request COUNT, not by the error: the error is identical
  // whether or not a pointless second full-timeout fetch happened first, so
  // only the counter can tell the two apart.
  //
  // The instance must ANSWER (with a failure) rather than be a dead port — a
  // dead port increments no counter, so asserting 0 against one would pass
  // whether the code fetched once, twice, or never, and prove nothing.
  writeWorkflow("default_image_gen");
  const failing = serveObjectInfo({ status: 500 });
  serveSlots();

  const error = await failure(await connect(), "describe_workflow", {
    workflow: "default_image_gen",
    host: `127.0.0.1:${failing.port}`,
  });

  expect(error["kind"]).toBe("object_info_unavailable");
  expect(objectInfoRequests).toBe(1); // one attempt, no stale retry behind it
});

test("a live fetch wins over the stale cache, before any launch is needed", async () => {
  // The first arrow of the order, on its own: a stale copy on disk must not
  // short-circuit an instance that is answering. This one never reaches the
  // launch branch and is not meant to — `withObjectInfo`'s first
  // `getObjectInfo` succeeds, so the whole `catch` is skipped. It would catch
  // a "check staleness before fetching" inversion; the test below covers the
  // launch arrow.
  writeWorkflow("default_image_gen");
  const live = serveObjectInfo(); // an instance that answers, from this file's helpers
  cacheAged("127.0.0.1", live.port, TWO_WEEKS);
  process.env.MCP_COMFYUI_AUTO_LAUNCH = "1";
  serveSlots();

  const body = await ok(await connect(), "describe_workflow", {
    workflow: "default_image_gen",
    host: `127.0.0.1:${live.port}`,
  });

  // It answered from the live instance, so there is nothing stale to disclose.
  expect(body["object_info"]).toBeUndefined();
});

test("launching still wins over the stale cache", async () => {
  // The order must not invert. With auto-launch on and a launchable local
  // host, the launch and its refetch are taken BEFORE the floor; the stale
  // copy is the last resort, not a shortcut past it.
  //
  // Reaching that branch at all requires the FIRST /object_info to fail —
  // otherwise `withObjectInfo` returns from its `try` and `config.autoLaunch`
  // is never consulted. So this instance is one that is genuinely down and
  // then comes up: /system_stats refuses until it has been probed twice (a
  // cold start, as `launchable` models it) and /object_info refuses once,
  // serving the real definitions from then on. A stale cache sits on disk
  // throughout, and must lose.
  writeWorkflow("default_image_gen");
  let statsProbes = 0;
  let objectInfoAttempts = 0;
  const bound = denoServe((request) => {
    const path = new URL(request.url).pathname;
    if (path === "/system_stats") {
      return statsProbes++ < 2
        ? new Response("starting", { status: 503 })
        : new Response(JSON.stringify(SYSTEM_STATS), {
            headers: { "content-type": "application/json" },
          });
    }
    if (path === "/object_info") {
      objectInfoRequests += 1;
      return objectInfoAttempts++ === 0
        ? new Response("starting", { status: 503 })
        : new Response(readFileSync(OBJECT_INFO_SAMPLE, "utf8"), {
            headers: { "content-type": "application/json" },
          });
    }
    return new Response("not found", { status: 404 });
  });
  servers.push(bound);
  const port = portOf(bound);
  process.env.MCP_COMFYUI_PORT = String(port);
  process.env.MCP_COMFYUI_AUTO_LAUNCH = "1";
  const log = cliLog();
  cacheAged("127.0.0.1", port, TWO_WEEKS);
  serveSlots();

  const body = await ok(await connect(), "describe_workflow", { workflow: "default_image_gen" });

  // The launch branch really was entered — `comfy launch` was invoked — and
  // the answer came from the refetch behind it: the two /object_info attempts
  // are the failure that opened the branch and the fetch that closed it, and a
  // stale answer would have disclosed its age.
  expect(await settledInvocationsOf(log, "launch", 1)).toHaveLength(1);
  expect(objectInfoAttempts).toBe(2);
  expect(body["slot_count"]).toBe(13);
  expect(body["object_info"]).toBeUndefined();
});

/**
 * Arm a launch that fails with the CLI's own verdict, leaving whatever else
 * the tool call spawns answering normally.
 *
 * Pinned through the dispatch wrapper's own `launch` case rather than through
 * `$FAKE_COMFY_MODE`: a tool that auto-launches makes two CLI calls for one
 * tool call, and the other one still has to answer.
 */
function launchFails(code: string, message: string): void {
  process.env.FAKE_COMFY_LAUNCH_MODE = "launch_fail";
  process.env.FAKE_COMFY_ERROR_CODE = code;
  process.env.FAKE_COMFY_ERROR_MESSAGE = message;
}

test("a launch that FAILS still falls through to the stale cache", async () => {
  // The floor's own motivating case, on the DEFAULT path: auto-launch is on,
  // the host is local, ComfyUI is stopped and the cache has aged out. The
  // launch attempt is not a detour around the floor — it is what stands
  // between the caller and it, and before this the whole call hard-failed with
  // a complete usable answer sitting on the disk.
  //
  // Mutant: revert `withObjectInfo`'s launch call to a bare `await
  // ensureRunning(...)`. This test dies with `not_in_workspace` reaching the
  // caller instead of a description.
  writeWorkflow("default_image_gen");
  const port = nothingRunning();
  cacheAged("127.0.0.1", port, TWO_WEEKS);
  process.env.MCP_COMFYUI_AUTO_LAUNCH = "1";
  const log = cliLog();
  serveSlots();
  launchFails("not_in_workspace", "ComfyUI is not available.");

  const body = await ok(await connect(), "describe_workflow", { workflow: "default_image_gen" });

  // The launch really was attempted — the floor is behind it, not instead of
  // it — and the answer still came back, disclosed as stale.
  expect(await settledInvocationsOf(log, "launch", 1)).toHaveLength(1);
  expect(body["schema"]).toBeDefined();
  const info = body["object_info"] as Record<string, unknown>;
  expect(info["stale"]).toBe(true);
  expect(info["age_hours"] as number).toBeGreaterThan(300);
});

test("validate_workflow survives a failed launch the same way", async () => {
  // The second call site, for the same reason it needed its own test the first
  // time: validate takes an independent trip for the `--input` path, and a
  // floor that only describe_workflow can reach is half a floor.
  writeWorkflow("default_image_gen");
  const port = nothingRunning();
  cacheAged("127.0.0.1", port, TWO_WEEKS);
  process.env.MCP_COMFYUI_AUTO_LAUNCH = "1";
  const log = cliLog();
  launchFails("port_in_use", "port 8188 is already bound");
  process.env.FAKE_COMFY_MODE = "validate";
  process.env.FAKE_COMFY_VALIDATE_FILE = VALIDATE_SAMPLE;

  const body = await ok(await connect(), "validate_workflow", { workflow: "default_image_gen" });

  // Asserting the launch was ATTEMPTED, not just that an answer arrived: every
  // assertion below is equally satisfied by falling straight through to the
  // floor without ever launching, which is a different (and weaker) behaviour
  // than the one this test is named for. Its sibling above already pins the
  // pair; without it this test cannot tell "the floor is behind the launch"
  // from "the floor replaced the launch".
  expect(await settledInvocationsOf(log, "launch", 1)).toHaveLength(1);
  expect(body["valid"]).toBeDefined();
  expect((body["object_info"] as Record<string, unknown>)["stale"]).toBe(true);
});

test("with nothing on disk either, the LAUNCH failure is what the caller is told", async () => {
  // The precedence decision, pinned. Two errors are live when the floor misses
  // after a failed launch: the pre-launch fetch ("fetch failed") and the launch
  // verdict. The launch verdict wins, on the same rule `withObjectInfo`'s
  // `already_running` branch already applies — keep the error that reflects the
  // most recently established fact about the machine. A launch ATTEMPT
  // establishes one, and `not_in_workspace` names a fix where "fetch failed"
  // only restates what the launch failure already implies.
  writeWorkflow("default_image_gen");
  nothingRunning(); // and no cache written for it at all
  process.env.MCP_COMFYUI_AUTO_LAUNCH = "1";
  serveSlots();
  launchFails("not_in_workspace", "ComfyUI is not available.");

  const error = await failure(await connect(), "describe_workflow", { workflow: "default_image_gen" });

  expect(error["code"]).toBe("not_in_workspace");
  expect(error["kind"]).not.toBe("object_info_unavailable");
});

test("a missing binary is still reported even when the stale floor absorbs the launch failure", async () => {
  // `withObjectInfo`'s `catch (launchFailed)` is deliberately unqualified, so
  // it swallows a MISSING BINARY too whenever a stale cache exists — the one
  // case where that catch is doing something other than what it was written
  // for. This pins what the caller is actually told, so the decision to leave
  // it unqualified stays checkable rather than assumed.
  //
  // Measured answer: the floor absorbs the launch failure, and then the very
  // next thing describe_workflow does is shell out to `comfy workflow slots`,
  // which cannot start either. The missing binary reaches the caller from
  // there, named, with the path it looked at — one call later than a narrowed
  // catch would have produced, and with the same verdict. That is why the
  // catch stays unqualified: narrowing it would buy a marginally earlier
  // report of an error that arrives anyway, at the cost of the floor's own
  // rule that EVERY route out of the launch arrow reaches it.
  writeWorkflow("default_image_gen");
  const port = nothingRunning();
  cacheAged("127.0.0.1", port, TWO_WEEKS);
  process.env.MCP_COMFYUI_AUTO_LAUNCH = "1";
  process.env.COMFY_BIN = join(workdir, "definitely-not-installed");

  const error = await failure(await connect(), "describe_workflow", { workflow: "default_image_gen" });

  expect(error["kind"]).toBe("comfy_unavailable");
  expect(error["binary"]).toBe(join(workdir, "definitely-not-installed"));
});

test("the configured workspace reaches comfy launch as a root flag", async () => {
  writeWorkflow("flow");
  launchable(2);
  const log = cliLog();
  process.env.MCP_COMFYUI_WORKSPACE = "/Users/you/ComfyUI-Installs/ComfyUI/ComfyUI";
  serveStream(`${envelopeLine(queuedPayload())}\n`);

  await ok(await connect(), "run_workflow", { workflow: "flow" });

  const launch = (await settledInvocationsOf(log, "launch", 1))[0] ?? "";
  const argv = launch.trim().split(" ");
  expect(argv).toContain("--workspace");
  expect(argv.indexOf("--workspace")).toBeLessThan(argv.indexOf("launch"));
});

// --- annotations must not lie about launching ----------------------------

test("describe_workflow is not read-only when it may start ComfyUI", async () => {
  // readOnlyHint means the tool does not modify its environment. Starting a GPU
  // process plainly does, and a client that auto-approves read-only tools would
  // be auto-approving that.
  process.env.MCP_COMFYUI_AUTO_LAUNCH = "1";
  const describe = toolNamed(await tools(await connect()), "describe_workflow");
  expect(describe.annotations?.readOnlyHint).toBe(false);
  expect(describe.description ?? "").toContain("start ComfyUI");
});

test("describe_workflow is read-only when it cannot start anything", async () => {
  process.env.MCP_COMFYUI_AUTO_LAUNCH = "0";
  const describe = toolNamed(await tools(await connect()), "describe_workflow");
  expect(describe.annotations?.readOnlyHint).toBe(true);
});

test("the tools that never launch stay read-only either way", async () => {
  for (const value of ["0", "1"]) {
    process.env.MCP_COMFYUI_AUTO_LAUNCH = value;
    const list = await tools(await connect());
    for (const name of ["comfy_status", "list_workflows", "get_job"]) {
      expect(toolNamed(list, name).annotations?.readOnlyHint).toBe(true);
    }
  }
});

test("run_workflow's description warns that the first call may start ComfyUI", async () => {
  process.env.MCP_COMFYUI_AUTO_LAUNCH = "1";
  const description = toolNamed(await tools(await connect()), "run_workflow").description ?? "";
  expect(description).toContain("start ComfyUI");
  expect(description).toContain("minute");
});

// --- multi-host ------------------------------------------------------------

/**
 * Which ComfyUI a call reaches, chosen per call rather than at process start.
 *
 * Two constraints shape every test here. `deno task test` grants
 * `--allow-net=127.0.0.1,[::1],192.0.2.1`, so two *different* hosts have to be
 * two ports on loopback — and the one genuinely non-local address available is
 * `192.0.2.1`, an RFC 5737 documentation address that is on no interface
 * anywhere and answers nothing. That is exactly what a sleeping remote is, so
 * it is the right fixture for the case this whole feature was built around.
 */

/** RFC 5737 TEST-NET-1: routable-looking, on no interface, answering nothing. */
const REMOTE_ADDRESS = "192.0.2.1";

/** The registry file every test in this file is pointed at. */
function hostsFile(): string {
  return process.env.MCP_COMFYUI_HOSTS_FILE as string;
}

function writeHosts(document: unknown): void {
  writeFileSync(hostsFile(), JSON.stringify(document, null, 2));
}

/**
 * A second loopback ComfyUI, deliberately NOT pointed at by
 * `MCP_COMFYUI_PORT`: the whole question these tests ask is whether a call
 * reaches a host the environment never named.
 */
function serveOtherInstance(): number {
  const bound = denoServe((request) =>
    new URL(request.url).pathname === "/system_stats"
      ? new Response(JSON.stringify(SYSTEM_STATS), { headers: { "content-type": "application/json" } })
      : new Response("not found", { status: 404 }),
  );
  servers.push(bound);
  return portOf(bound);
}

test("list_hosts reports the environment's single host when there is no registry", async () => {
  const body = await ok(await connect(), "list_hosts");

  expect(body["count"]).toBe(1);
  expect(body["default"]).toBe("default");
  expect(body["problem"]).toBeNull();
  expect((body["registry"] as Record<string, unknown>)["present"]).toBe(false);
  expect((body["hosts"] as Record<string, unknown>[])[0]).toMatchObject({
    name: "default",
    host: "127.0.0.1",
    local: true,
    is_default: true,
  });
});

test("list_hosts reports a registry, and leads with what is wrong with it", async () => {
  writeHosts({
    default: "mac",
    hosts: {
      mac: { host: "127.0.0.1", port: 8188 },
      far: { host: REMOTE_ADDRESS, port: 8189, auto_launch: true, note: "RTX" },
    },
  });
  const body = await ok(await connect(), "list_hosts");

  expect(body["count"]).toBe(2);
  expect(Object.keys(body)[0]).toBe("problem"); // the breakage comes first, or nobody reads it
  const warnings = body["warnings"] as Record<string, unknown>[];
  expect(warnings.map((warning) => warning["code"])).toContain("auto_launch_not_local");
  const far = (body["hosts"] as Record<string, unknown>[]).find((entry) => entry["name"] === "far");
  // Neutralised, not dropped: the address is still perfectly usable.
  expect(far).toMatchObject({ local: false, auto_launch: false, port: 8189, note: "RTX" });
});

test("a tool naming a host that is not registered is refused, with the names that would have worked", async () => {
  writeHosts({ hosts: { mac: { host: "127.0.0.1", port: 8188 } } });
  const error = await failure(await connect(), "comfy_status", { host: "rtx-vidoe" });

  expect(error["kind"]).toBe("unknown_host");
  expect(error["known_hosts"]).toEqual(["mac"]);
  // Nothing was spawned to find that out.
  expect(existsSync(argvOut)).toBe(false);
});

test("comfy_status talks to the host it is named, not to the configured default", async () => {
  const other = serveOtherInstance();
  const configured = Number(process.env.MCP_COMFYUI_PORT);
  writeHosts({
    default: "configured",
    hosts: {
      configured: { host: "127.0.0.1", port: configured },
      other: { host: "127.0.0.1", port: other },
    },
  });
  const client = await connect();

  expect(await ok(client, "comfy_status")).toMatchObject({
    running: true,
    port: configured,
    target: { name: "configured" },
  });
  expect(await ok(client, "comfy_status", { host: "other" })).toMatchObject({
    running: true,
    port: other,
    target: { name: "other", local: true },
  });
});

test("a raw address reaches an instance the registry has never heard of", async () => {
  const other = serveOtherInstance();
  const body = await ok(await connect(), "comfy_status", { host: `127.0.0.1:${other}` });

  expect(body).toMatchObject({
    running: true,
    port: other,
    target: { name: null, address: `127.0.0.1:${other}` },
  });
});

test("a sleeping host on another machine is reported, and nothing is launched for it", async () => {
  // The defect this feature was designed around. Before the locality gate, a
  // remote that did not answer made this machine start a ComfyUI on its own
  // default port, poll the remote for the full readiness budget, report a
  // timeout, and leave the local process running — `--background` had already
  // detached it. `comfy launch` has no --host, so no launch here could ever
  // have produced a server at that address.
  //
  // Mutant: drop the `!resolved.local` branch in `ensureRunning` and let
  // `ensureInstance` handle it. This test dies on the argv assertion, because
  // the CLI is spawned.
  process.env.MCP_COMFYUI_AUTO_LAUNCH = "1";
  writeHosts({ default: "far", hosts: { far: { host: REMOTE_ADDRESS, port: 8189 } } });
  writeWorkflow("smoke");

  const error = await failure(await connect(), "run_workflow", { workflow: "smoke" });

  expect(error["kind"]).toBe("host_unreachable");
  expect(error["host"]).toBe("far");
  expect(String(error["message"])).toContain("comfy launch");
  // The load-bearing assertion: no `comfy` process was started at all.
  expect(existsSync(argvOut)).toBe(false);
});

test("a remote host's artifacts are never reported as files on this machine", async () => {
  // A remote instance's `outputDirectory` is a path in ITS filesystem. Two Unix
  // boxes sharing a layout would otherwise have this hand back a local path
  // naming a different image entirely — so the check is on the address, not on
  // whether the path happens to resolve here.
  //
  // Mutant: drop the `isLocalAddress` guard at the top of
  // `resolveArtifactPath`. This test dies, because the directory below really
  // does exist on this machine and really does hold that file.
  const outputDir = makeDir("comfy-output");
  writeFileSync(join(outputDir, "remote_00001_.png"), "png bytes");
  const url = `http://${REMOTE_ADDRESS}:8189/view?filename=remote_00001_.png&subfolder=&type=output`;
  const statusFile = join(workdir, "status.json");
  writeFileSync(
    statusFile,
    JSON.stringify({ prompt_id: PROMPT_ID, status: "completed", outputs: [url] }),
  );
  process.env.FAKE_COMFY_MODE = "jobs";
  process.env.FAKE_COMFY_JOBS_STATUS_FILE = statusFile;
  writeHosts({ default: "far", hosts: { far: { host: REMOTE_ADDRESS, port: 8189 } } });

  const body = await ok(await connect(), "get_job", { prompt_id: PROMPT_ID });

  // `toMatchObject`, not `toEqual`: auto-fetch now adds sibling keys for a
  // remote host (here it skips, because REMOTE_ADDRESS answers nothing). The
  // assertion that matters is untouched — `local_paths` stays EMPTY, because a
  // copy in this server's cache is not the instance's own file, and that is
  // what kills the `isLocalAddress` mutant this test exists for. Do not
  // "tidy" this back to an exact match by deleting local_paths.
  expect(body["outputs"]).toMatchObject({ files: [], urls: [url], local_paths: {} });
  expect(body["host_source"]).toBe("only");
});

test("get_job finds a run's host without being told, and says how it knew", async () => {
  const other = serveOtherInstance();
  const configured = Number(process.env.MCP_COMFYUI_PORT);
  writeHosts({
    default: "configured",
    hosts: {
      configured: { host: "127.0.0.1", port: configured },
      other: { host: "127.0.0.1", port: other },
    },
  });
  writeWorkflow("smoke");
  serveStream(`${envelopeLine(queuedPayload())}\n`);
  const statusFile = join(workdir, "status.json");
  writeFileSync(statusFile, JSON.stringify({ prompt_id: PROMPT_ID, status: "running" }));
  process.env.FAKE_COMFY_JOBS_STATUS_FILE = statusFile;
  process.env.FAKE_COMFY_ARGV_LOG = join(workdir, "argv.log");
  const client = await connect();

  const run = await ok(client, "run_workflow", { workflow: "smoke", host: "other" });
  expect(run["target"]).toMatchObject({ name: "other" });

  const job = await ok(client, "get_job", { prompt_id: run["prompt_id"] as string });
  expect(job["host_source"]).toBe("ledger");
  expect(job["target"]).toMatchObject({ name: "other", address: `127.0.0.1:${other}` });
  // And the CLI really was pointed there: `--host`/`--port` follow the
  // subcommand, where `--json` precedes it.
  const invocation = readFileSync(join(workdir, "argv.log"), "utf8").trim().split("\n").pop() as string;
  const argv = invocation.split(" ");
  expect(argv.indexOf("--json")).toBeLessThan(argv.indexOf("jobs"));
  expect(argv.indexOf("jobs")).toBeLessThan(argv.indexOf("--port"));
  expect(argv[argv.indexOf("--port") + 1]).toBe(String(other));
});

test("get_job refuses to guess a host it was never told and never recorded", async () => {
  // Mutant: make this fall back to the default host. The test dies — and the
  // reason it must is that the fallback would not fail loudly, it would answer
  // `prompt_not_found`, which is byte-identical to the answer for a job that
  // never existed.
  writeHosts({
    default: "mac",
    hosts: { mac: { host: "127.0.0.1", port: 8188 }, far: { host: REMOTE_ADDRESS, port: 8189 } },
  });
  const error = await failure(await connect(), "get_job", { prompt_id: PROMPT_ID });

  expect(error["kind"]).toBe("job_host_unknown");
  expect(error["known_hosts"]).toEqual(["mac", "far"]);
  expect(existsSync(argvOut)).toBe(false);
});

test("an explicit host overrides the ledger, and the disagreement is reported", async () => {
  const other = serveOtherInstance();
  const configured = Number(process.env.MCP_COMFYUI_PORT);
  writeHosts({
    default: "configured",
    hosts: {
      configured: { host: "127.0.0.1", port: configured },
      other: { host: "127.0.0.1", port: other },
    },
  });
  writeWorkflow("smoke");
  serveStream(`${envelopeLine(queuedPayload())}\n`);
  const statusFile = join(workdir, "status.json");
  writeFileSync(statusFile, JSON.stringify({ prompt_id: PROMPT_ID, status: "running" }));
  process.env.FAKE_COMFY_JOBS_STATUS_FILE = statusFile;
  const client = await connect();

  const run = await ok(client, "run_workflow", { workflow: "smoke", host: "other" });
  const job = await ok(client, "get_job", {
    prompt_id: run["prompt_id"] as string,
    host: "configured",
  });

  expect(job["host_source"]).toBe("explicit");
  expect(job["target"]).toMatchObject({ name: "configured" });
  const warnings = job["warnings"] as Record<string, unknown>[];
  expect(warnings[0]).toMatchObject({ code: "host_contradicts_ledger" });
});

test("a registry that will not parse leaves the default working and refuses names", async () => {
  writeFileSync(hostsFile(), `{"hosts": {"mac": {"host": "127.0.0.1" "port": 8188}}}`);
  const client = await connect();

  // The default host's address comes from the environment, not from the file,
  // so it survives the file being unreadable. Routing a video job to the laptop
  // because a comma was missing is the failure this arrangement prevents.
  expect(await ok(client, "comfy_status")).toMatchObject({ running: true });

  const error = await failure(client, "comfy_status", { host: "mac" });
  expect(error["kind"]).toBe("registry_invalid");
  expect(error["registry_path"]).toBe(hostsFile());
  expect(error["line"]).toBe(1);
});

/**
 * A ComfyUI that also serves its own saved workflows, the way a remote does.
 *
 * `/api/userdata` and `/api/userdata/{file}` are answered exactly as ComfyUI
 * answers them — see `tests/userdata.test.ts` for where that shape comes from —
 * so a test can exercise the whole path from `list_workflows` through a run
 * without a real instance anywhere.
 */
function serveLibraryInstance(files: Record<string, string>): number {
  const bound = denoServe((request) => {
    const url = new URL(request.url);
    if (url.pathname === "/system_stats") {
      return new Response(JSON.stringify(SYSTEM_STATS), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/api/userdata") {
      return Response.json(
        Object.entries(files).map(([path, body]) => ({
          path,
          size: new TextEncoder().encode(body).byteLength,
          modified: 1786069244638,
        })),
      );
    }
    if (url.pathname.startsWith("/api/userdata/")) {
      const name = decodeURIComponent(url.pathname.slice("/api/userdata/".length));
      const body = files[name];
      return body === undefined
        ? new Response("", { status: 404 })
        : new Response(body, { headers: { "content-type": "application/json" } });
    }
    return new Response("nf", { status: 404 });
  });
  servers.push(bound);
  return portOf(bound);
}

test("list_workflows shows a host's own library beside the local one, tagged", async () => {
  writeWorkflow("local_only");
  const port = serveLibraryInstance({ "workflows/portrait.json": `{"nodes":[],"links":[]}` });
  writeHosts({ default: "box", hosts: { box: { host: "127.0.0.1", port } } });

  const bare = await ok(await connect(), "list_workflows");
  expect((bare["workflows"] as Record<string, unknown>[]).map((w) => w["name"])).toEqual(["local_only"]);
  // No host named, no remote call: the default host is usually this machine,
  // whose workflows directory is very likely already a configured root.
  expect(bare["host"]).toBeUndefined();

  const both = await ok(await connect(), "list_workflows", { host: "box" });
  const entries = both["workflows"] as Record<string, unknown>[];
  expect(entries.map((entry) => entry["name"])).toEqual(["local_only", "box/portrait"]);
  expect(entries[0]).toMatchObject({ source: "local", format: "frontend" });
  expect(entries[1]).toMatchObject({
    source: "remote:box",
    path: "workflows/portrait.json",
    format: "unknown",
    size_bytes: 23,
  });
  expect(both["count"]).toBe(2);
});

test("list_workflows still lists the local library when the host cannot be asked", async () => {
  // `workflows/discover.ts`'s promise, one layer out: denying somebody their
  // local workflows because a remote box is asleep is the wrong trade.
  writeWorkflow("local_only");
  writeHosts({ default: "box", hosts: { box: { host: "127.0.0.1", port: deadPort } } });

  const body = await ok(await connect(), "list_workflows", { host: "box" });

  expect((body["workflows"] as unknown[]).length).toBe(1);
  expect(body["remote_unreadable"]).toMatchObject({ host: "box" });
});

test("a workflow that exists only on a host runs there, byte-exact", async () => {
  // Landmine #1 over HTTP. The local path is a byte copy and has been pinned
  // since the beginning; this is the first route where a graph arrives from a
  // network. `run_capture` keeps the file `comfy run` was handed, because the
  // prepared copy is deleted the moment the run returns — so there would
  // otherwise be nothing left to compare against.
  //
  // Mutant: make `resolveRemoteWorkflow` hand back
  // `JSON.parse`-then-`JSON.stringify` of the fetched bytes instead of the
  // bytes. This test dies on the exact digits.
  const graph = `{"nodes":[{"id":3,"type":"KSampler","widgets_values":[${HUGE_SEED}]}],"links":[]}`;
  const port = serveLibraryInstance({ "workflows/seeded.json": graph });
  writeHosts({ default: "box", hosts: { box: { host: "127.0.0.1", port } } });
  serveStream(`${envelopeLine(queuedPayload())}\n`);
  const copy = join(workdir, "submitted.json");
  const log = join(workdir, "dispatch.log");
  process.env.FAKE_COMFY_RUN_MODE = "run_capture";
  process.env.FAKE_COMFY_WORKFLOW_COPY = copy;
  process.env.FAKE_COMFY_DISPATCH_LOG = log;

  const body = await ok(await connect(), "run_workflow", {
    workflow: "box/seeded",
    inputs: { "3.cfg": 7 },
  });

  expect(body["workflow"]).toMatchObject({ name: "box/seeded", source: "remote" });
  // The graph that reached the CLI still opens with the exact bytes the host
  // served. (The fake `set-slot` appends its markers after them.)
  expect(readFileSync(copy, "utf8").startsWith(graph)).toBe(true);
  expect(readFileSync(copy, "utf8")).toContain(HUGE_SEED);
  expect(readFileSync(copy, "utf8")).not.toContain("18446744073709552000");

  // Flag POSITION, not merely presence: `--json` is a Typer root flag and
  // precedes the subcommand, while `--host` is the subcommand's own and
  // follows it. Both orderings now appear in one argv.
  const setSlot = loggedArgv(log, "set-slot");
  expect(setSlot.indexOf("--json")).toBe(-1); // set-slot is not a --json command
  expect(setSlot.indexOf("set-slot")).toBeLessThan(setSlot.indexOf("--host"));
  const run = loggedArgv(log, "run");
  expect(run.indexOf("--json")).toBeGreaterThan(run.indexOf("run"));
  expect(run.indexOf("run")).toBeLessThan(run.indexOf("--host"));
  expect(run[run.indexOf("--port") + 1]).toBe(String(port));
});

test("a local workflow is still run without a copy of anything being fetched", async () => {
  // The ordinary case, and the one `host` is mostly for: the workflow comes
  // from the local library and is RUN on another instance.
  const path = writeWorkflow("flow");
  const port = serveLibraryInstance({ "workflows/other.json": "{}" });
  writeHosts({ default: "box", hosts: { box: { host: "127.0.0.1", port } } });
  serveStream(`${envelopeLine(queuedPayload())}\n`);

  const body = await ok(await connect(), "run_workflow", { workflow: "flow", host: "box" });

  expect(body["workflow"]).toMatchObject({ name: "flow", path, source: "local" });
  expect(body["target"]).toMatchObject({ name: "box" });
});

test("describe_workflow reads a host's own workflow without leaving a temp copy behind", async () => {
  const graph = `{"nodes":[{"id":3,"type":"KSampler"}],"links":[]}`;
  const port = serveLibraryInstance({ "workflows/remote_flow.json": graph });
  writeHosts({ default: "box", hosts: { box: { host: "127.0.0.1", port } } });
  serveSlots();
  // Per host and port, which is the whole point of the cache being keyed that
  // way: two ComfyUIs with different models installed must never answer for
  // each other. The library instance is on its own port, so its cache is its
  // own file.
  copyFileSync(OBJECT_INFO_SAMPLE, join(cacheDir, `object_info-127.0.0.1-${port}.json`));

  const body = await ok(await connect(), "describe_workflow", { workflow: "box/remote_flow" });

  expect(body["workflow"]).toMatchObject({ name: "box/remote_flow", source: "remote" });
  expect(body["slot_count"]).toBeGreaterThan(0);
  // The staged copy is the caller's to delete, and describe_workflow is the
  // caller. `leakedTempDirs` is checked in afterEach for every test here.
  expect(leakedTempDirs()).toEqual([]);
});

test("notes are read from the staged copy of a host's own workflow", async () => {
  // "Remote workflows come free" is a claim, so it gets a test: describe
  // stages a host-held workflow to a temp file, and listNotes takes a path,
  // so the notes must come back from that staged file with no extra code.
  const graph = `{"nodes":[{"id":3,"type":"KSampler"}],"links":[]}`;
  const port = serveLibraryInstance({ "workflows/portrait.json": graph });
  writeHosts({ default: "box", hosts: { box: { host: "127.0.0.1", port } } });
  serveSlots();
  copyFileSync(OBJECT_INFO_SAMPLE, join(cacheDir, `object_info-127.0.0.1-${port}.json`));
  serveNotes([{ id: 1, type: "MarkdownNote", title: "Remote", text: "staged", subgraph: null }]);
  // The title alone proves nothing: the fake CLI ignores its path argument and
  // serves $FAKE_COMFY_NOTES_FILE whatever it is asked about, so that assertion
  // would pass against a build that handed `listNotes` a path that does not
  // exist. What has to be pinned is the ARGUMENT — the same reason this test's
  // sibling above switched to the dispatch log.
  const log = cliLog();

  const body = await ok(await connect(), "describe_workflow", { workflow: "box/portrait" });

  expect((body.notes as Array<Record<string, unknown>>)[0]!.title).toBe("Remote");
  const notes = loggedArgv(log, "notes");
  const file = notes[notes.length - 1] as string;
  // A staged copy under this run's own temp prefix — not the `box/portrait`
  // handle and not the host's `workflows/portrait.json`, neither of which is a
  // file on this machine. (It is gone by now: describe_workflow disposes the
  // staging directory before it returns, which `leakedTempDirs()` also checks.)
  expect(file.startsWith(join(tmpdir(), TEMP_PREFIX))).toBe(true);
  expect(file).not.toContain("box/portrait");
});

/**
 * An instance that both reports an output directory and serves the files in it
 * over `/view` — which `serveInstanceWritingTo` deliberately does not, because
 * every test before this one only ever asked whether a URL resolved to a path,
 * never fetched one.
 */
function serveArtifactInstance(outputDir: string, files: Record<string, string>): number {
  const bound = denoServe((request) => {
    const url = new URL(request.url);
    if (url.pathname === "/system_stats") {
      const argv = ["ComfyUI/main.py", "--output-directory", outputDir];
      return new Response(JSON.stringify({ ...SYSTEM_STATS, system: { ...SYSTEM_STATS.system, argv } }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/view") {
      const body = files[url.searchParams.get("filename") ?? ""];
      return body === undefined
        ? new Response("", { status: 404 })
        : new Response(body, { headers: { "content-type": "image/png" } });
    }
    return new Response("nf", { status: 404 });
  });
  servers.push(bound);
  const port = portOf(bound);
  process.env.MCP_COMFYUI_PORT = String(port);
  return port;
}

test("fetch_outputs brings a run's artifacts here, and says where each one landed", async () => {
  const outputDir = makeDir("comfy-output");
  writeFileSync(join(outputDir, "made_00001_.png"), "png bytes");
  const port = serveArtifactInstance(outputDir, { "made_00001_.png": "png bytes" });
  const url = viewUrl(port, { filename: "made_00001_.png", subfolder: "", type: "output" });
  const statusFile = join(workdir, "status.json");
  writeFileSync(
    statusFile,
    JSON.stringify({ prompt_id: PROMPT_ID, status: "completed", outputs: [url] }),
  );
  process.env.FAKE_COMFY_MODE = "jobs";
  process.env.FAKE_COMFY_JOBS_STATUS_FILE = statusFile;

  const off = await ok(await connect(), "get_job", { prompt_id: PROMPT_ID });
  // Absent unless asked for, so an empty `fetched` can only ever mean "asked
  // for, and none came across".
  expect((off["outputs"] as Record<string, unknown>)["fetched"]).toBeUndefined();

  const on = await ok(await connect(), "get_job", { prompt_id: PROMPT_ID, fetch_outputs: true });
  const outputs = on["outputs"] as Record<string, Record<string, string>>;
  expect(outputs["fetch_problems"]).toEqual([]);
  const landed = outputs["fetched"]?.[url] as string;
  expect(landed).toContain(PROMPT_ID);
  expect(readFileSync(landed, "utf8")).toBe("png bytes");
});

test("an artifact that will not come across is reported without denying the others", async () => {
  const outputDir = makeDir("comfy-output");
  writeFileSync(join(outputDir, "good.png"), "good bytes");
  const port = serveArtifactInstance(outputDir, { "good.png": "good bytes" });
  const good = viewUrl(port, { filename: "good.png", subfolder: "", type: "output" });
  const gone = viewUrl(port, { filename: "gone.png", subfolder: "", type: "output" });
  const statusFile = join(workdir, "status.json");
  writeFileSync(
    statusFile,
    JSON.stringify({ prompt_id: PROMPT_ID, status: "completed", outputs: [good, gone] }),
  );
  process.env.FAKE_COMFY_MODE = "jobs";
  process.env.FAKE_COMFY_JOBS_STATUS_FILE = statusFile;

  const body = await ok(await connect(), "get_job", { prompt_id: PROMPT_ID, fetch_outputs: true });

  const outputs = body["outputs"] as Record<string, unknown>;
  expect(Object.keys(outputs["fetched"] as Record<string, string>)).toEqual([good]);
  expect((outputs["fetch_problems"] as Record<string, unknown>[])[0]).toMatchObject({ url: gone });
});

/**
 * A completed job on `host`, whose outputs are exactly `urls`. The CLI is
 * faked, so no ComfyUI is contacted to learn this.
 */
function completedJobWith(urls: string[]): void {
  const statusFile = join(workdir, "status.json");
  writeFileSync(statusFile, JSON.stringify({ prompt_id: PROMPT_ID, status: "completed", outputs: urls }));
  process.env.FAKE_COMFY_MODE = "jobs";
  process.env.FAKE_COMFY_JOBS_STATUS_FILE = statusFile;
}

/** The registry pointed at a host that is not this machine. */
function remoteHost(): void {
  writeHosts({ default: "far", hosts: { far: { host: REMOTE_ADDRESS, port: 8189 } } });
}

test("a REMOTE run's artifacts are copied here without being asked for", async () => {
  // The whole feature. A run on another box reports a /view URL this caller
  // cannot reach, and `local_paths` is empty because there is honestly nothing
  // here to name. Now there is a copy, and a path to it.
  //
  // The registered host is REMOTE_ADDRESS so `resolved.local` is false, while
  // the artifact URL points at a loopback fixture. That split is forced: the
  // suite can serve only loopback, and every address it can serve on is local,
  // so a host that is both remote and reachable cannot be built here. It is
  // also why the probe keys on the URL's own authority — the address the fetch
  // will actually use — rather than on the registry entry.
  //
  // Mutant: gate auto-fetch on `instance === null` instead of `host.local`.
  // Passes here; dies in the LOCAL sibling below.
  const outputDir = makeDir("comfy-output");
  const port = serveArtifactInstance(outputDir, { "made_00001_.png": "png bytes" });
  const url = viewUrl(port, { filename: "made_00001_.png", subfolder: "", type: "output" });
  remoteHost();
  completedJobWith([url]);

  const body = await ok(await connect(), "get_job", { prompt_id: PROMPT_ID, host: "far" });

  const outputs = body["outputs"] as Record<string, Record<string, string>>;
  const landed = outputs["fetched"]?.[url] as string;
  expect(landed).toContain(PROMPT_ID);
  expect(readFileSync(landed, "utf8")).toBe("png bytes");
  // Still no local path: what is here is a COPY, while `local_paths` means the
  // instance's own file, which remains on the other machine.
  expect(outputs["local_paths"]).toEqual({});
});

test("a LOCAL run is untouched by automatic fetching", async () => {
  // Auto-fetch is for artifacts that are not already here. A local instance
  // this server merely could not probe still has its files on this disk, and
  // asking a ComfyUI that is not answering to send them back would be both
  // pointless and a new way to fail.
  //
  // Mutant: gate on `instance === null` rather than `host.local`. This test
  // dies — `instance` is null here (nothing is listening on `deadPort`) while
  // the host IS local, so the mutant starts fetching and the keys appear.
  const url = viewUrl(deadPort, { filename: "made_00001_.png", subfolder: "", type: "output" });
  completedJobWith([url]);

  const body = await ok(await connect(), "get_job", { prompt_id: PROMPT_ID });

  const outputs = body["outputs"] as Record<string, unknown>;
  // Absent, not empty: nothing was attempted.
  expect(outputs["fetched"]).toBeUndefined();
  expect(outputs["fetch_problems"]).toBeUndefined();
  expect(outputs["not_fetched"]).toBeUndefined();
});

test("an artifact past the auto ceiling is disclosed, not silently missing", async () => {
  // `not_fetched` answers "why is there no path for this one", and names the
  // override. Without it a caller sees an artifact in `urls`, no entry in
  // `fetched`, and no way to tell a policy from a bug.
  //
  // 17 MiB is past AUTO_FETCH_MAX_BYTES and is never transferred: the
  // content-length pre-check declines it before a byte moves.
  //
  // Mutant: drop the `not_fetched` spread from `outputsBody`. Dies here.
  const outputDir = makeDir("comfy-output");
  const huge = "x".repeat(17 * 1024 * 1024);
  const port = serveArtifactInstance(outputDir, { "big.mp4": huge });
  const url = viewUrl(port, { filename: "big.mp4", subfolder: "", type: "output" });
  remoteHost();
  completedJobWith([url]);

  const body = await ok(await connect(), "get_job", { prompt_id: PROMPT_ID, host: "far" });

  const outputs = body["outputs"] as Record<string, unknown>;
  const skipped = outputs["not_fetched"] as Array<Record<string, string>>;
  expect(skipped).toHaveLength(1);
  expect(skipped[0]?.url).toBe(url);
  expect(skipped[0]?.reason).toContain("fetch_outputs");
  // A skip is not a failure, and the location is still reported either way.
  expect(outputs["fetch_problems"]).toEqual([]);
  expect(outputs["urls"]).toEqual([url]);
});

test("fetch_outputs true ignores the auto ceiling", async () => {
  // The explicit ask is what gets you the video. Same fixture as above, one
  // argument different.
  //
  // Mutant: apply AUTO_FETCH_MAX_BYTES to the explicit path too. Dies here.
  const outputDir = makeDir("comfy-output");
  const huge = "x".repeat(17 * 1024 * 1024);
  const port = serveArtifactInstance(outputDir, { "big.mp4": huge });
  const url = viewUrl(port, { filename: "big.mp4", subfolder: "", type: "output" });
  remoteHost();
  completedJobWith([url]);

  const body = await ok(await connect(), "get_job", {
    prompt_id: PROMPT_ID,
    host: "far",
    fetch_outputs: true,
  });

  const outputs = body["outputs"] as Record<string, Record<string, string>>;
  expect(outputs["fetched"]?.[url]).toBeDefined();
  expect(outputs["not_fetched"]).toBeUndefined();
});

test("a remote that does not answer is skipped in seconds, not minutes", async () => {
  // The defect this feature nearly shipped with. Measured 2026-08-22: a fetch
  // to an unroutable address NEVER fails on its own — it ran a full 30s and
  // stopped only because the probe aborted it — so at `fetchOutputs.ts`'s 300s
  // default this would have stalled `get_job` for five minutes on a copy
  // nobody asked for. NOTES_TIMEOUT_MS' lesson, one module over.
  //
  // Mutant: delete the probe from `fetchIfAsked`. The reason text changes from
  // the probe's verdict to a transport error, and the call slows to
  // AUTO_FETCH_TIMEOUT_MS.
  const url = viewUrl(deadPort, { filename: "made_00001_.png", subfolder: "", type: "output" });
  remoteHost();
  completedJobWith([url]);

  const started = Date.now();
  const body = await ok(await connect(), "get_job", { prompt_id: PROMPT_ID, host: "far" });
  const elapsed = Date.now() - started;

  const outputs = body["outputs"] as Record<string, unknown>;
  const skipped = outputs["not_fetched"] as Array<Record<string, string>>;
  expect(skipped?.[0]?.reason).toContain("did not answer");
  expect(Object.keys(outputs["fetched"] as Record<string, string>)).toEqual([]);
  // Deliberately generous: a tight budget assertion is a flake, and the claim
  // being pinned is minutes-versus-seconds, not a precise figure.
  expect(elapsed).toBeLessThan(20_000);
});

test("polling a completed job twice downloads its artifacts once", async () => {
  // The idempotence criterion at the layer that motivates it. `get_job` on a
  // completed job is callable any number of times, and auto-fetch is what
  // would otherwise make each poll a fresh download.
  //
  // Mutant: remove the `stat` reuse from `fetchOne`. Dies on views === 2.
  const outputDir = makeDir("comfy-output");
  let views = 0;
  const bound = denoServe((request) => {
    const url = new URL(request.url);
    if (url.pathname === "/system_stats") {
      const argv = ["ComfyUI/main.py", "--output-directory", outputDir];
      return new Response(JSON.stringify({ ...SYSTEM_STATS, system: { ...SYSTEM_STATS.system, argv } }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/view") {
      views += 1;
      return new Response("png bytes", { headers: { "content-type": "image/png" } });
    }
    return new Response("nf", { status: 404 });
  });
  servers.push(bound);
  const url = viewUrl(portOf(bound), { filename: "made_00001_.png", subfolder: "", type: "output" });
  remoteHost();
  completedJobWith([url]);

  await ok(await connect(), "get_job", { prompt_id: PROMPT_ID, host: "far" });
  await ok(await connect(), "get_job", { prompt_id: PROMPT_ID, host: "far" });

  expect(views).toBe(1);
});

test("manage_hosts adds a host, backs the file up, and reports what the next call will see", async () => {
  writeHosts({ default: "mac", hosts: { mac: { host: "127.0.0.1", port: 8188 } } });
  const client = await connect();

  const body = await ok(client, "manage_hosts", {
    action: "add",
    name: "rtx-video",
    host: REMOTE_ADDRESS,
    port: 8189,
    note: "Windows, RTX 4070",
  });

  expect(body["backup_path"]).toContain(".bak-");
  expect(readFileSync(body["backup_path"] as string, "utf8")).toContain("8188");
  expect(body["changes"]).toContainEqual({
    host: "rtx-video",
    field: "port",
    from: null,
    to: 8189,
  });
  // Re-read from disk, so the answer is what the next call will see rather than
  // what this call believed it wrote.
  const registry = body["registry"] as Record<string, unknown>;
  expect((registry["hosts"] as Record<string, unknown>[]).map((entry) => entry["name"])).toEqual([
    "mac",
    "rtx-video",
  ]);
  expect(await ok(client, "list_hosts")).toMatchObject({ count: 2, default: "mac" });
});

test("manage_hosts refuses auto_launch for another machine, and writes nothing", async () => {
  const before = { default: "mac", hosts: { mac: { host: "127.0.0.1", port: 8188 } } };
  writeHosts(before);

  const error = await failure(await connect(), "manage_hosts", {
    action: "add",
    name: "far",
    host: REMOTE_ADDRESS,
    auto_launch: true,
  });

  expect(error["kind"]).toBe("host_not_local");
  expect(JSON.parse(readFileSync(hostsFile(), "utf8"))).toEqual(before);
});

test("manage_hosts repairs a file's syntax without touching a single address", async () => {
  writeFileSync(
    hostsFile(),
    `{
  // the laptop
  "default": "mac",
  "hosts": {
    "mac": { "host": "127.0.0.1", "port": 8188, "vram_gb": 48 },
  },
}
`,
  );
  const body = await ok(await connect(), "manage_hosts", { action: "repair" });

  // Empty `changes` IS the guarantee: a repair fixes syntax, and one that
  // quietly re-pointed a host would be indistinguishable from one that did not.
  expect(body["changes"]).toEqual([]);
  expect(body["reformatted"]).toBe(true);
  const written = JSON.parse(readFileSync(hostsFile(), "utf8"));
  expect(written.hosts.mac).toMatchObject({ host: "127.0.0.1", port: 8188, vram_gb: 48 });
});

test("manage_hosts will not 'repair' a file it could not read", async () => {
  // The dangerous case. Neither parse read this, so the registry held only the
  // environment's default — rewriting it would replace the operator's hosts
  // with that one entry and leave the real ones in a .bak- file nobody was told
  // to look for.
  const broken = `{"hosts": {"mac": {"host": "127.0.0.1" "port": 8188}}}`;
  writeFileSync(hostsFile(), broken);

  const error = await failure(await connect(), "manage_hosts", { action: "repair" });

  expect(error["kind"]).toBe("registry_invalid");
  expect(readFileSync(hostsFile(), "utf8")).toBe(broken);
});

test("manage_hosts names the argument it needs rather than failing obscurely", async () => {
  const error = await failure(await connect(), "manage_hosts", { action: "add", name: "x" });

  expect(error["kind"]).toBe("invalid_input");
  expect(String(error["message"])).toContain("host");
});

test("manage_hosts set_default changes which host an unqualified call reaches", async () => {
  const other = serveOtherInstance();
  const configured = Number(process.env.MCP_COMFYUI_PORT);
  writeHosts({
    default: "configured",
    hosts: {
      configured: { host: "127.0.0.1", port: configured },
      other: { host: "127.0.0.1", port: other },
    },
  });
  const client = await connect();

  await ok(client, "manage_hosts", { action: "set_default", name: "other" });

  // The registry is read per call, so this takes effect immediately — no
  // restart, and no shared state to invalidate.
  expect(await ok(client, "comfy_status")).toMatchObject({
    port: other,
    target: { name: "other" },
  });
});

test("a workflow name nothing answers to is a missing workflow, not a network error", async () => {
  // Found live, against a stopped local ComfyUI: a mistyped workflow name fell
  // through to the default host's own library, could not reach it, and came
  // back as `fetch failed` about /api/userdata — a true statement about
  // something the caller never asked about, in place of the names that would
  // have worked. A host consulted only as a fallback must not become the story.
  writeWorkflow("real_one");
  writeHosts({ default: "box", hosts: { box: { host: "127.0.0.1", port: deadPort } } });

  const error = await failure(await connect(), "run_workflow", { workflow: "reel_one" });

  expect(error["kind"]).toBe("workflow_not_found");
  expect(error["known_workflows"]).toEqual(["real_one"]);
});

test("a host the caller named, that cannot be asked, is reported as the host", async () => {
  // The other half of the same rule. Here the caller DID name a host, so its
  // being unreachable is the answer to their question rather than an aside.
  writeWorkflow("real_one");
  writeHosts({ default: "box", hosts: { box: { host: "127.0.0.1", port: deadPort } } });

  const error = await failure(await connect(), "run_workflow", {
    workflow: "box/whatever",
    host: "box",
  });

  expect(error["kind"]).toBe("host_unreachable");
  expect(String(error["url"])).toContain("/api/userdata");
});

test("a workflow a named host does not have is a missing workflow", async () => {
  const port = serveLibraryInstance({ "workflows/here.json": "{}" });
  writeHosts({ default: "box", hosts: { box: { host: "127.0.0.1", port } } });
  writeWorkflow("local_one");

  const error = await failure(await connect(), "describe_workflow", {
    workflow: "box/absent",
    host: "box",
  });

  expect(error["kind"]).toBe("workflow_not_found");
});

test("a host-qualified workflow handle routes itself, without repeating the host", async () => {
  // list_workflows publishes a remote workflow as `box/portrait`, and a handle
  // that carries a host's name reads as self-describing — a model will pass it
  // on its own. If it did not route, the call would resolve against the
  // DEFAULT host, look for `box/portrait` in that machine's library, and report
  // a workflow that plainly exists as missing.
  const graph = `{"nodes":[{"id":3,"type":"KSampler"}],"links":[]}`;
  const port = serveLibraryInstance({ "workflows/portrait.json": graph });
  const configured = Number(process.env.MCP_COMFYUI_PORT);
  writeHosts({
    default: "configured",
    hosts: {
      configured: { host: "127.0.0.1", port: configured },
      box: { host: "127.0.0.1", port },
    },
  });
  serveStream(`${envelopeLine(queuedPayload())}\n`);

  const body = await ok(await connect(), "run_workflow", { workflow: "box/portrait" });

  expect(body["target"]).toMatchObject({ name: "box" });
  expect(body["workflow"]).toMatchObject({ name: "box/portrait", source: "remote" });
});

test("a local workflow whose name merely contains a slash is not read as a host", async () => {
  // `workflows/discover.ts` qualifies a colliding name with its own directory,
  // so `templates/portrait` is a perfectly ordinary LOCAL handle. Only a prefix
  // the registry really has is treated as a host.
  const configured = Number(process.env.MCP_COMFYUI_PORT);
  writeHosts({ default: "configured", hosts: { configured: { host: "127.0.0.1", port: configured } } });
  const second = join(workdir, "templates");
  mkdirSync(second);
  writeFileSync(join(second, "portrait.json"), `{"nodes":[],"links":[]}`);
  writeWorkflow("portrait");
  process.env.MCP_COMFYUI_WORKFLOW_DIRS = `${roots}:${second}`;
  serveStream(`${envelopeLine(queuedPayload())}\n`);

  const body = await ok(await connect(), "run_workflow", { workflow: "templates/portrait" });

  expect(body["workflow"]).toMatchObject({ name: "templates/portrait", source: "local" });
  expect(body["target"]).toMatchObject({ name: "configured" });
});

test("launch_comfyui refuses a host on another machine, and spawns nothing", async () => {
  // The locality gate, through the tool a model can actually reach. Its own
  // error subclass exists so this is reported as host_not_local rather than
  // invalid_input: the fix is on the other machine, not in the argument.
  //
  // Mutant: make `refuseRemoteTarget` throw a plain LaunchArgumentError. This
  // test dies on the kind.
  process.env.MCP_COMFYUI_ALLOW_LAUNCH = "1";
  writeHosts({ default: "far", hosts: { far: { host: REMOTE_ADDRESS, port: 8189 } } });

  const error = await failure(await connect(), "launch_comfyui", { host: "far" });

  expect(error["kind"]).toBe("host_not_local");
  expect(error["host"]).toBe(`${REMOTE_ADDRESS}:8189`);
  expect(String(error["message"])).toContain("--host");
  expect(existsSync(argvOut)).toBe(false);
});

test("launch_comfyui refuses a --listen naming another machine, whatever the host is", async () => {
  // `launchTarget` reads the address out of the ASSEMBLED argv, so a gate
  // checking only the configured host would miss the very argument that decides
  // where the server binds.
  process.env.MCP_COMFYUI_ALLOW_LAUNCH = "1";

  const error = await failure(await connect(), "launch_comfyui", { listen: REMOTE_ADDRESS });

  expect(error["kind"]).toBe("host_not_local");
  expect(existsSync(argvOut)).toBe(false);
});

test("a host that agrees with the ledger is reported without a contradiction", async () => {
  const other = serveOtherInstance();
  const configured = Number(process.env.MCP_COMFYUI_PORT);
  writeHosts({
    default: "configured",
    hosts: {
      configured: { host: "127.0.0.1", port: configured },
      other: { host: "127.0.0.1", port: other },
    },
  });
  writeWorkflow("smoke");
  serveStream(`${envelopeLine(queuedPayload())}\n`);
  const statusFile = join(workdir, "status.json");
  writeFileSync(statusFile, JSON.stringify({ prompt_id: PROMPT_ID, status: "running" }));
  process.env.FAKE_COMFY_JOBS_STATUS_FILE = statusFile;
  const client = await connect();

  const run = await ok(client, "run_workflow", { workflow: "smoke", host: "other" });
  const job = await ok(client, "get_job", { prompt_id: run["prompt_id"] as string, host: "other" });

  expect(job["host_source"]).toBe("explicit");
  // The equality check is what keeps a caller who simply repeated the right
  // host from being told they disagreed with this server.
  expect(job["warnings"]).toBeUndefined();
});

test("the only registered host is used for an unknown job, and said to be an assumption", async () => {
  // Not a guess between candidates — there is one host — but still an
  // assumption, because a run can be submitted to a raw address that is in no
  // registry, and the wrong ComfyUI answers `prompt_not_found` in exactly the
  // words a job that never existed gets.
  const statusFile = join(workdir, "status.json");
  writeFileSync(statusFile, JSON.stringify({ prompt_id: PROMPT_ID, status: "running" }));
  process.env.FAKE_COMFY_MODE = "jobs";
  process.env.FAKE_COMFY_JOBS_STATUS_FILE = statusFile;

  const body = await ok(await connect(), "get_job", { prompt_id: PROMPT_ID });

  expect(body["host_source"]).toBe("only");
  expect((body["warnings"] as Record<string, unknown>[])[0]).toMatchObject({ code: "host_assumed" });
});

test("a decoy address in a REMOTE workflow is refused before anything is spawned", async () => {
  // The decoy analysis reads the fetched bytes rather than a file, so it still
  // happens before any temp directory exists. Without it, a remote workflow
  // would lose the one refusal that stopped a request for "black metal, 60s"
  // from silently producing 150 seconds of tropical house.
  //
  // Mutant: drop the `resolved.contents` arm of `refuseInertInputs`. This test
  // dies, because `inertInputsOfFile` cannot read `workflows/decoy.json`.
  const graph = JSON.stringify({
    nodes: [
      { id: 3, type: "CLIPTextEncode", inputs: [{ name: "text", widget: { name: "text" }, link: 7 }] },
      { id: 9, type: "PrimitiveStringMultiline", inputs: [{ name: "value", widget: { name: "value" }, link: null }] },
    ],
    links: [[7, 9, 0, 3, 0, "STRING"]],
  });
  const port = serveLibraryInstance({ "workflows/decoy.json": graph });
  writeHosts({ default: "box", hosts: { box: { host: "127.0.0.1", port } } });

  const error = await failure(await connect(), "run_workflow", {
    workflow: "box/decoy",
    inputs: { "3.text": "black metal" },
  });

  expect(error["kind"]).toBe("inert_slot");
  const addresses = error["inert_addresses"] as Record<string, unknown>[];
  expect(addresses[0]).toMatchObject({ address: "3.text" });
  expect(existsSync(argvOut)).toBe(false);
  expect(leakedTempDirs()).toEqual([]);
});

test("the version reported to clients is the version this package ships", async () => {
  // `SERVER_INFO.version` had drifted to 0.1.0 while the package was at 0.5.0 —
  // for four releases, because nothing checked. It is a literal rather than an
  // import of the manifest (see `src/server.ts`'s SERVER_VERSION for why the
  // import, which does work, is not used), so this test is what keeps the two
  // in step: `deno bump-version` only knows about deno.json.
  //
  // Mutant: change either number. This test dies.
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "deno.json"), "utf8"));
  expect(SERVER_VERSION).toBe(manifest.version);

  // And it really is what a client is told, not merely a constant that agrees
  // with the manifest in private.
  const client = await connect();
  expect(client.getServerVersion()).toMatchObject({
    name: "mcp-comfyui",
    version: manifest.version,
  });
});

test("the build makes dist/ describe its own module format", async () => {
  // `dist/index.js` is ESM, and Node decides whether a `.js` file is ESM from
  // the NEAREST package.json. This project has none at its root any more, so
  // without the one the build writes, `node dist/index.js` fails on Node 18
  // and 20 with `Cannot use import statement outside a module` — while working
  // fine on 22.7 and later, which detect module syntax on their own. A defect
  // visible only on the older half of the supported range is exactly the kind
  // that ships.
  //
  // Mutant: delete the `writeFileSync(MANIFEST, …)` line in scripts/build.mjs.
  // This test dies.
  await buildDist();

  const manifest = join(REPO_ROOT, "dist", "package.json");
  expect(existsSync(manifest)).toBe(true);
  expect(JSON.parse(readFileSync(manifest, "utf8"))).toEqual({ type: "module" });

  // And the artifact really does run under a Node that will not guess.
  //
  // `--no-experimental-detect-module` turns off the syntax detection Node 22.7
  // and later do by default, which is what would otherwise mask a missing
  // manifest. A Node old enough not to recognise the flag has no detection to
  // disable, so a plain run is already the strict test there — that fallback is
  // what keeps this meaningful across the whole supported range rather than
  // failing on the CI runner's Node purely over a flag name.
  const run = async (args: string[]) => {
    const child = new Deno.Command("node", { args, stdin: "null", stdout: "piped", stderr: "piped" })
      .spawn();
    const { code, stderr } = await child.output();
    return { code, stderr: new TextDecoder().decode(stderr) };
  };

  let result = await run(["--no-experimental-detect-module", DIST_ENTRY]);
  if (result.stderr.includes("bad option")) result = await run([DIST_ENTRY]);

  expect(result.stderr).not.toContain("outside a module");
  expect(result.code).toBe(0);
});

// --- template creation needs no new pipeline ------------------------------

test("a fetched template is describable by the existing pipeline, unchanged", async () => {
  // The whole design rests on this: `templates fetch` writes frontend format,
  // so describe_workflow reads it with no conversion step. If this fails, the
  // feature does not work, however green the unit tests are. Driven over real
  // stdio against the real dist/index.js, on this file's own pattern for that
  // (see the stdio-landmine tests above), because that is the path a real MCP
  // client actually takes — connect()'s in-memory transport never touches it.
  const child = spawnDist({
    ...process.env,
    FAKE_COMFY_MODE: "templates_fetch",
    FAKE_COMFY_TEMPLATE_FILE: SLOTS_CAPABLE_TEMPLATE,
    FAKE_COMFY_TEMPLATE_NAME: "fixture_template",
  });

  // Two round trips, not one pipelined write: the SDK dispatches incoming
  // requests as they arrive rather than queueing them, so a list_workflows
  // sent before create_workflow_from_template's response has come back could
  // race its async file write and see a directory that does not have the new
  // file in it yet — a flake that would have nothing to do with the wiring
  // this test exists to prove.
  await writeStdin(child, INITIALIZE_LINE);
  await writeStdin(
    child,
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "create_workflow_from_template", arguments: { template: "fixture_template" } },
    })}\n`,
  );
  const afterCreate = await readUntil(child.stdout, 2, 10_000); // the initialize response, then this one

  await writeStdin(
    child,
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list_workflows", arguments: {} },
    })}\n`,
  );
  const afterList = await readUntil(child.stdout, 1, 10_000); // one more line, on the same stream

  await terminate(child);

  const lines = `${afterCreate}${afterList}`.split("\n").filter((line) => line.trim() !== "");
  const messages = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const byId = new Map(messages.filter((m) => m["id"] !== undefined).map((m) => [m["id"], m]));

  const created = byId.get(2)?.["result"] as { content: Array<{ text: string }> };
  const createdBody = JSON.parse(created.content[0]!.text) as Record<string, unknown>;
  expect(createdBody["path"]).toBe(join(createdDir, "fixture_template.json"));

  const listed = byId.get(3)?.["result"] as { content: Array<{ text: string }> };
  const listedBody = JSON.parse(listed.content[0]!.text) as Record<string, unknown>;
  const entry = (listedBody["workflows"] as Array<Record<string, unknown>>).find(
    (workflow) => workflow["name"] === "fixture_template",
  );
  expect(entry?.["origin"]).toBe("template");
  expect(entry?.["format"]).toBe("frontend");
});
