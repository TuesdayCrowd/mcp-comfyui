import { afterEach, beforeEach, expect, test } from "bun:test";
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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/server";
import { toolConfig } from "../src/tools";

/**
 * The MCP surface, exercised through a real client over a real transport.
 *
 * No test here may contact a ComfyUI, invoke the real `comfy`, or leave a
 * process behind. Every CLI invocation goes to `tests/fixtures/fake-comfy` (via
 * the dispatcher, since one tool call can make two CLI calls with different
 * subcommands), and every HTTP probe goes to a hermetic `Bun.serve` on an
 * ephemeral port. The instance address is never left at its 8188 default, so an
 * accidental probe cannot reach the ComfyUI that may well be running on this
 * machine — and auto-launch is OFF unless a test turns it on, so nothing here
 * can start one.
 */

const FIXTURES = join(import.meta.dir, "fixtures");
const FAKE_COMFY = join(FIXTURES, "fake-comfy-dispatch");
const OBJECT_INFO_SAMPLE = join(FIXTURES, "object_info.sample.json");
const SLOTS_SAMPLE = join(FIXTURES, "slots.default_image_gen.json");

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
    argv: ["ComfyUI/main.py", "--output-directory", "/Users/lawls/ComfyUI-Shared/output"],
  },
  devices: [{ name: "mps", type: "mps", vram_total: 51539607552, vram_free: 11458723840 }],
};

type TestServer = ReturnType<typeof Bun.serve>;

let workdir: string;
let roots: string;
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
  "FAKE_COMFY_DATA_FILE",
  "FAKE_COMFY_ERROR_CODE",
  "FAKE_COMFY_ERROR_MESSAGE",
  "FAKE_COMFY_STREAM_FILE",
  "FAKE_COMFY_STDERR",
  "FAKE_COMFY_EXIT",
  "FAKE_COMFY_HANG",
  "FAKE_COMFY_WARNINGS",
  "FAKE_COMFY_SET_SLOT_MODE",
  "FAKE_COMFY_RUN_MODE",
  "FAKE_COMFY_JOBS_MODE",
  "FAKE_COMFY_JOBS_STATUS_FILE",
  "FAKE_COMFY_JOBS_STATUS_ERROR",
  "FAKE_COMFY_JOBS_CANCEL_FILE",
  "FAKE_COMFY_JOBS_CANCEL_ERROR",
  "FAKE_COMFY_DISPATCH_LOG",
  "MCP_COMFYUI_WORKFLOW_DIRS",
  "MCP_COMFYUI_CACHE_DIR",
  "MCP_COMFYUI_HOST",
  "MCP_COMFYUI_PORT",
  "MCP_COMFYUI_ALLOW_LAUNCH",
  "MCP_COMFYUI_AUTO_LAUNCH",
  "MCP_COMFYUI_WORKSPACE",
];

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "mcp-comfyui-server-"));
  roots = join(workdir, "workflows");
  cacheDir = join(workdir, "cache");
  argvOut = join(workdir, "argv");
  mkdirSync(roots);
  mkdirSync(cacheDir);
  servers = [];
  open = [];
  objectInfoRequests = 0;
  deadPort = closedPort();

  process.env.COMFY_BIN = FAKE_COMFY;
  process.env.FAKE_COMFY_ARGV_OUT = argvOut;
  process.env.MCP_COMFYUI_WORKFLOW_DIRS = roots;
  process.env.MCP_COMFYUI_CACHE_DIR = cacheDir;
  // A ComfyUI is answering by default, because that is the state every tool
  // that needs one is written for. Tests about the other state call
  // `nothingRunning()`; tests about starting one turn auto-launch back on.
  serveInstance();
  process.env.MCP_COMFYUI_AUTO_LAUNCH = "0";
});

afterEach(async () => {
  for (const close of open) await close();
  for (const bound of servers) bound.stop(true); // force: a hung handler must not hold the suite
  for (const name of MANAGED_ENV) delete process.env[name];
  rmSync(workdir, { recursive: true, force: true });
  for (const name of leakedTempDirs()) rmSync(join(tmpdir(), name), { recursive: true, force: true });
});

/** Temp directories the prepare step created and nobody cleaned up. */
function leakedTempDirs(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith(TEMP_PREFIX));
}

function portOf(bound: TestServer): number {
  const { port } = bound;
  if (port === undefined) throw new Error("test server did not bind a port");
  return port;
}

/** A port nothing is listening on: bind one, then give it back. */
function closedPort(): number {
  const throwaway = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = portOf(throwaway);
  throwaway.stop(true);
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
  const bound = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/object_info") objectInfoRequests += 1;
      return path === "/system_stats"
        ? new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
        : new Response("not found", { status: 404 });
    },
  });
  servers.push(bound);
  const port = portOf(bound);
  process.env.MCP_COMFYUI_PORT = String(port);
  return port;
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
  const bound = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      if (new URL(request.url).pathname !== "/system_stats") return new Response("nf", { status: 404 });
      return seen++ < failures
        ? new Response("starting", { status: 503 })
        : new Response(JSON.stringify(SYSTEM_STATS), { headers: { "content-type": "application/json" } });
    },
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
      "/Users/lawls/ComfyUI/output/banana_00001_.png",
      "http://127.0.0.1:8188/view?filename=b.png",
    ],
    elapsed_seconds: 4.25,
    ...over,
  };
}

/** The argv the fake recorded. No path in these tests contains a space. */
function argv(): string[] {
  return readFileSync(argvOut, "utf8").trim().split(" ");
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

test("registers exactly the six default tools", async () => {
  expect(await toolNames(await connect())).toEqual([
    "cancel_job",
    "comfy_status",
    "describe_workflow",
    "get_job",
    "list_workflows",
    "run_workflow",
  ]);
});

test("the read-only tools are annotated read-only", async () => {
  const list = await tools(await connect());
  for (const name of ["comfy_status", "list_workflows", "describe_workflow", "get_job"]) {
    expect(toolNamed(list, name).annotations?.readOnlyHint).toBe(true);
  }
});

test("the two tools that change something are annotated not read-only", async () => {
  // A client that hides or auto-approves read-only tools must not auto-approve
  // a GPU render or the interruption of one.
  const list = await tools(await connect());
  expect(toolNamed(list, "run_workflow").annotations?.readOnlyHint).toBe(false);
  expect(toolNamed(list, "cancel_job").annotations?.readOnlyHint).toBe(false);
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
  expect(body["output_directory"]).toBe("/Users/lawls/ComfyUI-Shared/output");
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
  expect(body["roots"]).toEqual([roots]);
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

  const body = await ok(await connect(), "describe_workflow", { workflow: "flow" });

  expect(body["slot_count"]).toBe(13);
  expect(argv()).toContain("--input");
  expect(argv()).toContain(cachePath);
});

test("describe_workflow resolves a workflow by the name list_workflows gave", async () => {
  const path = writeWorkflow("flow");
  seedObjectInfoCache();
  serveSlots();

  const body = await ok(await connect(), "describe_workflow", { workflow: "flow" });

  expect((body["workflow"] as Record<string, unknown>)["name"]).toBe("flow");
  expect((body["workflow"] as Record<string, unknown>)["path"]).toBe(path);
  expect(argv()).toContain(path);
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
    files: ["/Users/lawls/ComfyUI/output/banana_00001_.png"],
    urls: ["http://127.0.0.1:8188/view?filename=b.png"],
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
  });
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

  const child = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "index.ts")], {
    env: process.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

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
  child.stdin.write(requests.map((request) => `${JSON.stringify(request)}\n`).join(""));
  await child.stdin.flush();

  const stdout = await readUntil(child.stdout, 4, 10_000);
  child.kill("SIGKILL");
  child.stdout.cancel();
  child.stderr.cancel();
  await child.exited;

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
  while (invocationsOf(log, matching).length < expected && Date.now() < deadline) await Bun.sleep(5);
  await Bun.sleep(60);
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
  servers.push(
    Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("{}"),
    }),
  );
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

test("the configured workspace reaches comfy launch as a root flag", async () => {
  writeWorkflow("flow");
  launchable(2);
  const log = cliLog();
  process.env.MCP_COMFYUI_WORKSPACE = "/Users/lawls/ComfyUI-Installs/ComfyUI/ComfyUI";
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
