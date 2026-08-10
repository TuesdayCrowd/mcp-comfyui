import { afterEach, beforeEach, expect, test } from "./support/testing.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerTools, resolveSlotTypes, type ToolConfig } from "../src/tools.ts";
import { describeError } from "../src/toolResult.ts";
import { objectInfoCachePath } from "../src/comfy/objectInfo.ts";

/**
 * Unit-level coverage for `src/tools.ts`'s own logic, below the level of the
 * full build-and-spawn-`dist/index.js`-under-`node` stdio harness
 * `tests/server.test.ts` uses for the MCP surface end to end. Two things are
 * covered here that have no other home:
 *
 * - **`resolveSlotTypes`** (finding 1's wiring): the gate that decides
 *   whether `run_workflow` is worth a `workflow slots` round trip before
 *   `set-slot`, and its best-effort fallback. Tested directly, against
 *   `tests/fixtures/fake-comfy`, with no MCP transport involved at all.
 * - **The input-schema rejections** (finding 2's earlier, cleaner error):
 *   `promptIdArgument` and `inputsArgument` both refuse a leading `-` before
 *   a tool handler ever runs. Tested through a real `McpServer` +
 *   `InMemoryTransport` pair, built directly from `registerTools` — never
 *   through `src/server.ts` or `src/index.ts`, which belong to other work in
 *   flight on this branch. Every case here is rejected at the schema layer,
 *   before any `comfy` invocation, so none of it needs a running instance.
 *
 * No test in this file may invoke a real `comfy` or reach a real ComfyUI:
 * `COMFY_BIN` points at the sh fixture for every one of them.
 */
const FAKE_COMFY = join(import.meta.dirname, "fixtures", "fake-comfy");
const SLOTS_SAMPLE = join(import.meta.dirname, "fixtures", "slots.default_image_gen.json");
const LIMIT5 = join(import.meta.dirname, "fixtures", "templates.video-limit5.json");
/** A frontend-format workflow carrying a 2^64-1 value, for the fetch tests below. */
const BIGSEED = join(import.meta.dirname, "fixtures", "template.bigseed.json");

let workdir: string;
let argvOut: string;
/** A port nothing is listening on, freshly reserved for each test. */
let deadPort: number;
/** Loopback fixtures started by a `launch_comfyui` wiring test, stopped after it. */
let launchServers: TestServer[] = [];

/**
 * A `{port, stop}` pair wrapping the raw `Deno.HttpServer`, matching
 * `tests/objectInfo.test.ts`: `stop(true)` aborts the creating `signal`
 * rather than awaiting `.shutdown()`, which — unlike `.shutdown()` —
 * resolves immediately even against a handler that never returns (measured
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

/**
 * A port bound and immediately released. `detectInstance`'s probe (used by
 * `ensureRunning`, which `get_job`/`cancel_job`/`run_workflow` all reach
 * through) targets `host`/`port` from `ToolConfig` directly — and this
 * server's own **default** host/port is `127.0.0.1:8188`, which the ground
 * truth doc for this task says a real ComfyUI Desktop is genuinely listening
 * on, on the machine these tests run on. `baseConfig` below must never leave
 * `host`/`port` at that default, or a schema-layer test could accidentally
 * reach across into the handler and a real network probe — silently making
 * two different code paths (the schema refine, and `setSlots.ts`'s own
 * `encodePair` guard) indistinguishable from outside, since both produce a
 * message containing "cannot start with".
 */
async function closedPort(): Promise<number> {
  const throwaway = denoServe(() => new Response(""));
  const { port } = throwaway;
  await throwaway.stop(true);
  return port;
}

beforeEach(async () => {
  workdir = mkdtempSync(join(tmpdir(), "mcp-comfyui-tools-"));
  argvOut = join(workdir, "argv");
  deadPort = await closedPort();
  launchServers = [];
  process.env.COMFY_BIN = FAKE_COMFY;
  process.env.FAKE_COMFY_ARGV_OUT = argvOut;
});

afterEach(async () => {
  for (const bound of launchServers) await bound.stop(true); // force: a hung handler must not hold the suite
  delete process.env.COMFY_BIN;
  delete process.env.FAKE_COMFY_MODE;
  delete process.env.FAKE_COMFY_ARGV_OUT;
  delete process.env.FAKE_COMFY_DATA_FILE;
  delete process.env.FAKE_COMFY_ERROR_CODE;
  delete process.env.FAKE_COMFY_ERROR_MESSAGE;
  delete process.env.FAKE_COMFY_TEMPLATES_FILE;
  delete process.env.FAKE_COMFY_TEMPLATE_FILE;
  delete process.env.FAKE_COMFY_TEMPLATE_NAME;
  rmSync(workdir, { recursive: true, force: true });
});

function baseConfig(overrides: Partial<ToolConfig> = {}): ToolConfig {
  return {
    host: "127.0.0.1",
    port: deadPort,
    cacheDir: undefined,
    workspace: undefined,
    autoLaunch: false,
    allowLaunch: false,
    // `MCP_COMFYUI_HOSTS_FILE` is pointed inside this test's own directory
    // even though no test here writes one: without it every handler would
    // read whichever real `~/.config/mcp-comfyui/hosts.json` the machine
    // running the suite happens to have, and a developer with two hosts
    // registered would see failures nobody else could reproduce.
    env: { MCP_COMFYUI_HOSTS_FILE: join(workdir, "hosts.json") },
    ...overrides,
  };
}

/** `baseConfig` with extra env, keeping the hosts-file redirect it sets. */
function configWithEnv(extra: Record<string, string>): ToolConfig {
  return baseConfig({ env: { MCP_COMFYUI_HOSTS_FILE: join(workdir, "hosts.json"), ...extra } });
}

/**
 * The address `resolveSlotTypes` is pointed at — a port nothing answers on, so
 * a test that expects no CLI call cannot accidentally reach the real ComfyUI
 * this machine may well be running. See {@link closedPort}.
 */
function testAddress(): { host: string; port: number } {
  return { host: "127.0.0.1", port: deadPort };
}

/** Serve the captured 13-slot listing of `default_image_gen` as `workflow slots`'s data. */
function serveSlots(): void {
  process.env.FAKE_COMFY_MODE = "data_file";
  process.env.FAKE_COMFY_DATA_FILE = SLOTS_SAMPLE;
}

function serveFailure(code: string, message: string): void {
  process.env.FAKE_COMFY_MODE = "fail_code";
  process.env.FAKE_COMFY_ERROR_CODE = code;
  process.env.FAKE_COMFY_ERROR_MESSAGE = message;
}

// --- resolveSlotTypes: the gate --------------------------------------------

test("resolveSlotTypes never spawns the CLI when inputs is empty", async () => {
  const types = await resolveSlotTypes("flow.json", {}, testAddress());
  expect(types).toEqual({});
  expect(existsSync(argvOut)).toBe(false);
});

test("resolveSlotTypes never spawns the CLI when inputs is undefined", async () => {
  const types = await resolveSlotTypes("flow.json", undefined, testAddress());
  expect(types).toEqual({});
  expect(existsSync(argvOut)).toBe(false);
});

test("resolveSlotTypes never spawns the CLI for ordinary, unambiguous values", async () => {
  // A plain sentence, a number and a native boolean: none of them is valid
  // JSON on its own (the sentence) or a string at all (the other two), so
  // none of them is at risk from comfy-cli's own JSON-decode-then-typecheck,
  // and the round trip this function exists to sometimes pay for is skipped.
  const types = await resolveSlotTypes(
    "flow.json",
    { "3.seed": 42, "6.text": "a photo of a cat", "3.add_noise": true },
    testAddress(),
  );
  expect(types).toEqual({});
  expect(existsSync(argvOut)).toBe(false);
});

test("resolveSlotTypes fetches the listing when a value looks like a JSON boolean", async () => {
  serveSlots();
  const types = await resolveSlotTypes("flow.json", { "9.filename_prefix": "true" }, testAddress());
  expect(existsSync(argvOut)).toBe(true); // the round trip was made
  expect(types["9.filename_prefix"]).toBe("STRING");
  expect(types["4.ckpt_name"]).toBe("COMBO");
  expect(types["3.seed"]).toBe("INT");
});

test("resolveSlotTypes fetches the listing when a value looks like a JSON integer", async () => {
  serveSlots();
  const types = await resolveSlotTypes("flow.json", { "9.filename_prefix": "42" }, testAddress());
  expect(types["9.filename_prefix"]).toBe("STRING");
});

test("resolveSlotTypes fetches the listing when a value looks like JSON null", async () => {
  serveSlots();
  const types = await resolveSlotTypes("flow.json", { "9.filename_prefix": "null" }, testAddress());
  expect(types["9.filename_prefix"]).toBe("STRING");
});

test("resolveSlotTypes fetches the listing when a value looks like a JSON array", async () => {
  serveSlots();
  const types = await resolveSlotTypes("flow.json", { "9.filename_prefix": '["a","b"]' }, testAddress());
  expect(types["9.filename_prefix"]).toBe("STRING");
});

test("resolveSlotTypes fetches the listing when just one of several values is ambiguous", async () => {
  serveSlots();
  const types = await resolveSlotTypes(
    "flow.json",
    { "6.text": "a photo of a cat", "9.filename_prefix": "true" },
    testAddress(),
  );
  expect(existsSync(argvOut)).toBe(true);
  expect(types["9.filename_prefix"]).toBe("STRING");
});

test("resolveSlotTypes does not treat the digit-string seed hatch itself as needing no lookup", async () => {
  // A digit string IS valid JSON (a number), so it IS ambiguous by this
  // function's own gate — the lookup happens, and it is `encodeString` in
  // `setSlots.ts`, not this gate, that keeps a *known-numeric* type raw. This
  // asserts the gate's half of that: the round trip is made at all.
  serveSlots();
  const types = await resolveSlotTypes("flow.json", { "3.seed": "18446744073709551615" }, testAddress());
  expect(existsSync(argvOut)).toBe(true);
  expect(types["3.seed"]).toBe("INT");
});

test("resolveSlotTypes falls back to {} rather than failing the run when the listing cannot be fetched", async () => {
  // Best-effort: a listing failure here does not fail resolveSlotTypes, and
  // an address absent from the map is exactly how `applySlots` already
  // treated every address before finding 1 was fixed — not a new failure
  // mode, only a missed improvement for this one call.
  serveFailure("server_not_running", "no server");
  const types = await resolveSlotTypes("flow.json", { "9.filename_prefix": "true" }, testAddress());
  expect(types).toEqual({});
});

test("resolveSlotTypes falls back to {} when the CLI's payload is not a slot listing", async () => {
  process.env.FAKE_COMFY_MODE = "data_file";
  const badPayload = join(workdir, "bad.json");
  writeFileSync(badPayload, JSON.stringify({ not: "a slot listing" }));
  process.env.FAKE_COMFY_DATA_FILE = badPayload;

  const types = await resolveSlotTypes("flow.json", { "9.filename_prefix": "true" }, testAddress());
  expect(types).toEqual({});
});

// --- schema-level rejection (finding 2) ------------------------------------

function textOf(result: CallToolResult): string {
  return result.content
    .filter((entry): entry is { type: "text"; text: string } => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
}

async function connect(config: ToolConfig): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerTools(server, config);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

test("get_job rejects a leading-dash prompt_id at the schema layer, before any subprocess runs", async () => {
  const client = await connect(baseConfig());

  const result = (await client.callTool({
    name: "get_job",
    arguments: { prompt_id: "--host" },
  })) as CallToolResult;

  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("prompt_id");
  expect(existsSync(argvOut)).toBe(false); // rejected before anything was spawned
});

test("cancel_job rejects a leading-dash prompt_id at the schema layer too", async () => {
  const client = await connect(baseConfig());

  const result = (await client.callTool({
    name: "cancel_job",
    arguments: { prompt_id: "-x" },
  })) as CallToolResult;

  expect(result.isError).toBe(true);
  expect(existsSync(argvOut)).toBe(false);
});

test("a well-formed UUID prompt_id is not rejected by the new schema guard", async () => {
  // The refusal is specific to a leading `-`, not to schema validation being
  // broken outright — this call still reaches the handler and fails for the
  // ordinary reason (nothing armed a jobs response), not a schema error.
  process.env.FAKE_COMFY_MODE = "fail_code";
  process.env.FAKE_COMFY_ERROR_CODE = "prompt_not_found";
  process.env.FAKE_COMFY_ERROR_MESSAGE = "no such prompt";
  const client = await connect(baseConfig());

  const result = (await client.callTool({
    name: "get_job",
    arguments: { prompt_id: "9b1c7d2e-0000-4000-8000-000000000001" },
  })) as CallToolResult;

  expect(result.isError).toBe(true); // still fails, but for the CLI's reason
  expect(textOf(result)).not.toContain("cannot start with"); // not the schema guard's message
  expect(existsSync(argvOut)).toBe(true); // the call actually reached the CLI
});

test("run_workflow rejects a leading-dash slot address at the schema layer", async () => {
  const roots = mkdtempSync(join(tmpdir(), "mcp-comfyui-tools-roots-"));
  const workflowPath = join(roots, "flow.json");
  writeFileSync(workflowPath, `{"nodes":[{"id":3,"type":"KSampler"}],"links":[]}`);
  const client = await connect(baseConfig());

  const result = (await client.callTool({
    name: "run_workflow",
    arguments: { workflow: workflowPath, inputs: { "--input": "/tmp/evil_object_info.json" } },
  })) as CallToolResult;

  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("cannot start with");
  expect(existsSync(argvOut)).toBe(false); // rejected before anything was spawned
  rmSync(roots, { recursive: true, force: true });
});

test("run_workflow's ordinary inputs are unaffected by the new schema guard", async () => {
  const schema = (await (await connect(baseConfig())).listTools()).tools.find(
    (tool) => tool.name === "run_workflow",
  )?.inputSchema;
  const inputs = (schema?.properties as Record<string, { additionalProperties?: unknown }>)["inputs"];
  // The refine wraps the record but must not hide its shape from a model
  // planning a call: the union of value types must still be visible.
  const value = JSON.stringify(inputs);
  expect(value).toContain("string");
  expect(value).toContain("number");
  expect(value).toContain("boolean");
});

// --- launch_comfyui wiring ---------------------------------------------------

/** A loopback `/system_stats` fixture, cleaned up by `afterEach`. */
function fakeInstance(): TestServer {
  const bound = denoServe(
    () =>
      new Response(JSON.stringify({ system: {}, devices: [] }), {
        headers: { "content-type": "application/json" },
      }),
  );
  launchServers.push(bound);
  return bound;
}

/** Refuses until probed `failures` times, then answers like `fakeInstance`. */
function fakeInstanceReadyAfter(failures: number): TestServer {
  let seen = 0;
  const bound = denoServe(() =>
    seen++ < failures
      ? new Response("starting", { status: 503 })
      : new Response(JSON.stringify({ system: {}, devices: [] }), {
          headers: { "content-type": "application/json" },
        }),
  );
  launchServers.push(bound);
  return bound;
}

function portOf(bound: TestServer): number {
  return bound.port;
}

test("launch_comfyui's instance is the one at the requested port, never the configured one", async () => {
  process.env.FAKE_COMFY_MODE = "launch";
  const configured = fakeInstance(); // something else is answering at the configured address too
  const target = fakeInstance(); // AND at the exact address requested
  const client = await connect(baseConfig({ port: portOf(configured), allowLaunch: true }));

  const result = (await client.callTool({
    name: "launch_comfyui",
    arguments: { port: portOf(target) },
  })) as CallToolResult;

  const body = JSON.parse(textOf(result)) as Record<string, unknown>;
  expect(body["outcome"]).toBe("already_running");
  expect((body["instance"] as Record<string, unknown>)["port"]).toBe(portOf(target));
});

test("launch_comfyui reports launch_failed, not launch_timeout, when the CLI dies without an envelope", async () => {
  // An unresolvable workspace crashes `comfy launch --background` uncaught —
  // no envelope, non-zero exit — which must not read as a five-minute timeout.
  process.env.FAKE_COMFY_MODE = "garbage";
  const client = await connect(baseConfig({ port: deadPort, allowLaunch: true }));

  const result = (await client.callTool({ name: "launch_comfyui", arguments: {} })) as CallToolResult;

  expect(result.isError).toBe(true);
  const body = JSON.parse(textOf(result)) as Record<string, unknown>;
  const error = body["error"] as Record<string, unknown>;
  expect(error["kind"]).toBe("launch_failed");
  expect(typeof error["url"]).toBe("string");
  expect(String(error["message"])).toContain("MCP_COMFYUI_WORKSPACE");
});

test("launch_comfyui surfaces a contention warning when it proceeds alongside a running instance", async () => {
  process.env.FAKE_COMFY_MODE = "launch";
  const configured = fakeInstance(); // running at the address this server talks to
  const target = fakeInstanceReadyAfter(1); // free, so the launch proceeds here
  const client = await connect(baseConfig({ port: portOf(configured), allowLaunch: true }));

  const result = (await client.callTool({
    name: "launch_comfyui",
    arguments: { port: portOf(target) },
  })) as CallToolResult;

  const body = JSON.parse(textOf(result)) as Record<string, unknown>;
  expect(body["outcome"]).toBe("launched");
  expect(Array.isArray(body["warnings"])).toBe(true);
  expect((body["warnings"] as unknown[]).length).toBeGreaterThan(0);
});

test("a missing Deno permission is an operator's to fix, not reported as a server bug", () => {
  // Measured: a server started without `--allow-sys` answers `list_hosts` with
  // this the first time it looks for its own configuration directory. Reporting
  // it as `internal_error` says "this server has a bug", which is false and
  // sends the operator to the wrong place — the runtime's own message already
  // names the flag.
  //
  // Mutant: delete the `NotCapable` arm in `describeError`. This test dies.
  const denied = new Error('Requires sys access to "homedir", run again with the --allow-sys flag');
  denied.name = "NotCapable";

  const body = describeError(denied);

  expect(body.kind).toBe("permission_denied");
  expect(body.message).toContain("--allow-sys");
  expect(body.error_name).toBe("NotCapable");
});

test("an ordinary error is still reported as this server's own fault", () => {
  // The asymmetry matters: an unrecognised error must NOT be relabelled as the
  // caller's or the operator's problem, or a genuine bug here sends someone
  // round a retry loop they can never win.
  expect(describeError(new TypeError("boom")).kind).toBe("internal_error");
});

// --- search_templates -------------------------------------------------------

test("search_templates refuses a call with no filter, without spawning", async () => {
  const client = await connect(baseConfig());
  const result = (await client.callTool({
    name: "search_templates",
    arguments: {},
  })) as CallToolResult;

  // Checked BEFORE the body: this is the property the guard exists for, and
  // asserting it first is what lets the test tell "no guard" apart from "guard
  // ran too late". Both produce the same error kind.
  expect(existsSync(argvOut)).toBe(false);

  const body = JSON.parse(textOf(result));
  expect(body.error.kind).toBe("invalid_input");
  expect(body.error.message).toContain("at least one");
});

test("search_templates passes one filter through and reports the true match count", async () => {
  process.env.FAKE_COMFY_MODE = "templates_ls";
  process.env.FAKE_COMFY_TEMPLATES_FILE = LIMIT5;
  const client = await connect(baseConfig());

  const result = (await client.callTool({
    name: "search_templates",
    arguments: { type: "video", limit: 5 },
  })) as CallToolResult;

  const body = JSON.parse(textOf(result));
  expect(body.matched).toBe(156);
  expect(body.templates).toHaveLength(5);
  expect(body.truncated).toBe(true);
});

test("search_templates is annotated read-only and takes no host", async () => {
  const client = await connect(baseConfig());
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === "search_templates");
  expect(tool?.annotations?.readOnlyHint).toBe(true);
  expect(Object.keys(tool?.inputSchema.properties ?? {})).not.toContain("host");
});

// --- origin: "template" on list_workflows -----------------------------------

test("list_workflows tags an entry under the created root, and only that entry", async () => {
  const roots = join(workdir, "origin-roots");
  const created = join(workdir, "origin-created");
  mkdirSync(roots, { recursive: true });
  mkdirSync(created, { recursive: true });
  const graph = JSON.stringify({ nodes: [], links: [] });
  writeFileSync(join(roots, "mine.json"), graph);
  writeFileSync(join(created, "fetched.json"), graph);

  const client = await connect(configWithEnv({
    MCP_COMFYUI_WORKFLOW_DIRS: roots,
    MCP_COMFYUI_CREATED_DIR: created,
  }));
  const result = (await client.callTool({
    name: "list_workflows",
    arguments: {},
  })) as CallToolResult;
  const body = JSON.parse(textOf(result));

  const mine = body.workflows.find((w: { name: string }) => w.name === "mine");
  const fetched = body.workflows.find((w: { name: string }) => w.name === "fetched");
  expect(fetched.origin).toBe("template");
  expect(mine.origin).toBeUndefined();
});

test("a created workflow colliding with an operator's does not take the bare name", async () => {
  const roots = join(workdir, "collide-roots");
  const created = join(workdir, "collide-created");
  mkdirSync(roots, { recursive: true });
  mkdirSync(created, { recursive: true });
  const graph = JSON.stringify({ nodes: [], links: [] });
  writeFileSync(join(roots, "portrait.json"), graph);
  writeFileSync(join(created, "portrait.json"), graph);

  const client = await connect(configWithEnv({
    MCP_COMFYUI_WORKFLOW_DIRS: roots,
    MCP_COMFYUI_CREATED_DIR: created,
  }));
  const result = (await client.callTool({
    name: "list_workflows",
    arguments: {},
  })) as CallToolResult;
  const body = JSON.parse(textOf(result));

  // The bare name belongs to the operator's copy. The fetched one is still
  // listed and still reachable, but under a disambiguated name — this is the
  // whole point of appending the created root last.
  const bare = body.workflows.find((w: { name: string }) => w.name === "portrait");
  expect(bare.path.startsWith(roots)).toBe(true);
  expect(bare.origin).toBeUndefined();
  expect(body.workflows.filter((w: { origin?: string }) => w.origin === "template")).toHaveLength(1);
});

test("a sibling directory sharing the created prefix is not tagged", async () => {
  const created = mkdtempSync(join(tmpdir(), "mcp-comfyui-prefix-"));
  const sibling = `${created}-other`;
  mkdirSync(sibling);
  writeFileSync(join(sibling, "decoy.json"), JSON.stringify({ nodes: [], links: [] }));

  const client = await connect(configWithEnv({
    MCP_COMFYUI_WORKFLOW_DIRS: sibling,
    MCP_COMFYUI_CREATED_DIR: created,
  }));
  const result = (await client.callTool({
    name: "list_workflows",
    arguments: {},
  })) as CallToolResult;
  const body = JSON.parse(textOf(result));
  expect(body.workflows.find((w: { name: string }) => w.name === "decoy").origin).toBeUndefined();

  rmSync(created, { recursive: true, force: true });
  rmSync(sibling, { recursive: true, force: true });
});

// --- create_workflow_from_template ------------------------------------------

/** Point the fixture at a frontend-format workflow carrying a 2^64-1 value. */
function useFetchMode(): void {
  process.env.FAKE_COMFY_MODE = "templates_fetch";
  process.env.FAKE_COMFY_TEMPLATE_FILE = BIGSEED;
  process.env.FAKE_COMFY_TEMPLATE_NAME = "fixture_template";
}

test("create_workflow_from_template writes into the created directory and returns the path", async () => {
  useFetchMode();
  const created = join(workdir, "created");
  const client = await connect(configWithEnv({ MCP_COMFYUI_CREATED_DIR: created }));
  const result = (await client.callTool({
    name: "create_workflow_from_template",
    arguments: { template: "fixture_template" },
  })) as CallToolResult;
  const body = JSON.parse(textOf(result));
  expect(body.path).toBe(join(created, "fixture_template.json"));
  expect(existsSync(body.path)).toBe(true);
});

test("an existing target is refused and the existing file is untouched", async () => {
  useFetchMode();
  const created = join(workdir, "created2");
  mkdirSync(created, { recursive: true });
  const target = join(created, "fixture_template.json");
  writeFileSync(target, "ORIGINAL");

  const client = await connect(configWithEnv({ MCP_COMFYUI_CREATED_DIR: created }));
  const result = (await client.callTool({
    name: "create_workflow_from_template",
    arguments: { template: "fixture_template" },
  })) as CallToolResult;
  const body = JSON.parse(textOf(result));
  expect(body.error.kind).toBe("invalid_input");
  // A substring as loose as "as" also matches "Pass" — assert the existing
  // path instead, which only this message names.
  expect(body.error.message).toContain(target);
  expect(readFileSync(target, "utf8")).toBe("ORIGINAL");
});

test("`as` cannot climb out of the created directory", async () => {
  useFetchMode();
  const created = join(workdir, "created3");
  const client = await connect(configWithEnv({ MCP_COMFYUI_CREATED_DIR: created }));
  for (const bad of ["../escape", "sub/dir", "..", ".", "/absolute", "a b"]) {
    const result = (await client.callTool({
      name: "create_workflow_from_template",
      arguments: { template: "fixture_template", as: bad },
    })) as CallToolResult;
    const body = JSON.parse(textOf(result));
    expect(body.error.kind).toBe("invalid_input");
  }
  expect(existsSync(join(workdir, "escape.json"))).toBe(false);
});

test("`as` names the file when it is a plain stem", async () => {
  useFetchMode();
  const created = join(workdir, "created4");
  const client = await connect(configWithEnv({ MCP_COMFYUI_CREATED_DIR: created }));
  const result = (await client.callTool({
    name: "create_workflow_from_template",
    arguments: { template: "fixture_template", as: "my-video" },
  })) as CallToolResult;
  const body = JSON.parse(textOf(result));
  expect(body.path).toBe(join(created, "my-video.json"));
});

test("create_workflow_from_template rejects a leading-dash template at the schema layer, before any subprocess runs or directory is created", async () => {
  // Final review, finding 1 + finding 5. Before the `template` schema gained
  // its own `.refine()`, this reached `fetchTemplate`'s internal
  // `assertNotFlag`, which throws a bare `Error` that `describeError` cannot
  // classify — reported as `internal_error`, blaming this server for bad
  // caller input. It also ran `mkdir` on the created directory first, so a
  // refused call still left an empty directory behind. Both are closed by
  // rejecting at the schema layer: the handler — and therefore `mkdir` — is
  // never entered at all. Like `promptIdArgument`'s own schema rejection
  // (above), the SDK's own `McpError` path answers this one, not
  // `toolAnswer`/`describeError` — so the body is a bare string, not
  // `ToolErrorBody` JSON, and must not be parsed as such.
  const created = join(workdir, "created-dash");
  const client = await connect(configWithEnv({ MCP_COMFYUI_CREATED_DIR: created }));

  const result = (await client.callTool({
    name: "create_workflow_from_template",
    arguments: { template: "--gallery" },
  })) as CallToolResult;

  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("template");
  expect(existsSync(argvOut)).toBe(false); // rejected before anything was spawned
  expect(existsSync(created)).toBe(false); // and before the created directory exists
});

test("create_workflow_from_template is not read-only and takes no host", async () => {
  const client = await connect(baseConfig());
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === "create_workflow_from_template");
  expect(tool?.annotations?.readOnlyHint).toBe(false);
  expect(tool?.annotations?.destructiveHint).toBe(false);
  expect(Object.keys(tool?.inputSchema.properties ?? {})).not.toContain("host");
});

// --- run_workflow: object_info source for a non-local host -----------------
//
// comfy-cli refuses to fetch `/object_info` from a non-loopback address in
// local mode ("potential SSRF") — measured 2026-08-08 against a live remote —
// so `run_workflow`'s handler points `set-slot` at this server's own per-host
// cache (`objectInfoCachePath`) instead of the live `--host`/`--port` for a
// non-local target. That decision is made entirely inline in the handler
// closure — it is not `resolveSlotTypes` (whose own signature only widened to
// *accept* an `objectInfoPath`; its body already forwarded whatever `location`
// it was given, before and after, so calling it directly cannot tell the fix
// apart from its absence) and there is no other exported seam for it.
//
// Reaching it through a real tool call requires `ensureRunning`'s remote
// branch to observe a *running* instance at a non-local address. This suite's
// `--allow-net=127.0.0.1,[::1],192.0.2.1` makes that impossible to satisfy
// honestly: 127.0.0.1/[::1] are always `local` (`isLocalAddress`), and
// 192.0.2.1 (RFC 5737 TEST-NET-1) is on no interface anywhere and answers
// nothing — confirmed by `tests/server.test.ts`'s own `run_workflow` test
// against that exact address, whose load-bearing assertion is
// `existsSync(argvOut) === false`: `ensureRunning` throws before `comfy` is
// even spawned, for every call this suite can make against a "remote" host.
// `Deno.serve` cannot bind `192.0.2.1` either, so there is no way to stand up
// a real "reachable, non-local" fixture the way `serveOtherInstance()` does
// with two loopback ports.
//
// The one remaining seam is `detectInstance`'s own `fetch` call
// (`comfy/instance.ts`) for `/system_stats`. Faking just that one response
// lets `ensureRunning` see the remote as running and the call proceed into
// the fixed code with `target.local === false`, without touching the real
// network at all — nothing else on this path uses raw `fetch`:
// `resolveSlotTypes`, `applySlots` and `runWorkflow` all go through the fake
// `comfy` CLI fixture, not HTTP.
//
// A second concern, found while adding this test: a bare `objectInfoCachePath`
// only *names* the cache file, it never checks the file is actually there.
// Measured directly against the real CLI: `comfy workflow slots --input
// <a path that does not exist>` fails `cql_no_graph`, "cannot read
// object_info: ...: No such file or directory" — so a remote `run_workflow`
// call for a workflow nobody had `describe_workflow`d yet (nothing had ever
// populated the cache) would fail this way, leaking this server's own cache
// path and recommending two things this tool cannot act on. `run_workflow`
// now calls `ensureObjectInfoCache` instead, which fetches and writes the
// cache itself when it is missing or stale. The test below keeps a warm
// cache (the ordinary case, once `describe_workflow` has run once) so it
// stays about the `--input` argv shape and not about the fetch; the cold
// case — an empty `cacheDir`, and the cache file actually appearing on disk
// afterward — is `run_workflow fills a cold object_info cache ...`, right
// after it.
test("run_workflow points set-slot at the per-host object_info cache for a non-local host, not --host/--port", async () => {
  const remoteHost = "192.0.2.1"; // RFC 5737 TEST-NET-1: on no interface, answers nothing for real
  const remotePort = 8189;
  const cacheDir = join(workdir, "cache");

  const roots = mkdtempSync(join(tmpdir(), "mcp-comfyui-tools-remote-"));
  const workflowPath = join(roots, "flow.json");
  // A widget-backed node with no incoming link on `text`, so
  // `refuseInertInputs` — which runs before `ensureRunning`, straight off the
  // file — does not refuse the call before this test ever reaches the fetch
  // patch or the code under test.
  writeFileSync(workflowPath, JSON.stringify({ nodes: [{ id: 6, type: "CLIPTextEncode" }], links: [] }));

  // A warm cache, so `ensureObjectInfoCache` (below) reads it straight from
  // disk and this test stays about the `--input` argv shape, not the fetch —
  // the cold case has its own test, right after this one.
  mkdirSync(cacheDir, { recursive: true });
  const expectedCachePath = objectInfoCachePath({ host: remoteHost, port: remotePort, cacheDir });
  writeFileSync(expectedCachePath, JSON.stringify({ CLIPTextEncode: { input: { required: {} } } }));

  const probeUrl = `http://${remoteHost}:${remotePort}/system_stats`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === probeUrl) {
      return new Response(JSON.stringify({ system: {}, devices: [] }), {
        headers: { "content-type": "application/json" },
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  try {
    // set-slot fails deliberately. `applySlots` then throws, so
    // `runWorkflow`'s own `comfy run` is never spawned and never overwrites
    // `argvOut` — the single-shot `$FAKE_COMFY_ARGV_OUT` capture then holds
    // EXACTLY the `set-slot` invocation this test is about.
    // `$FAKE_COMFY_ARGV_LOG` only accumulates in the fixture's `jobs` mode
    // (append-only fixture — not extended here), so this is the only way to
    // isolate one call's argv out of run_workflow's several without touching
    // it.
    serveFailure("workflow_slot_invalid", "boom");

    const client = await connect(baseConfig({ cacheDir }));
    const result = (await client.callTool({
      name: "run_workflow",
      arguments: {
        workflow: workflowPath,
        host: `${remoteHost}:${remotePort}`,
        // No JSON-parseable value, so `resolveSlotTypes` skips its own CLI
        // round trip entirely (see "never spawns the CLI for ordinary,
        // unambiguous values" above) — the only comfy invocation this call
        // makes is `applySlots`'s `set-slot`.
        inputs: { "6.text": "hello" },
      },
    })) as CallToolResult;

    expect(result.isError).toBe(true); // the forced set-slot failure
    expect(existsSync(argvOut)).toBe(true); // and something WAS spawned
    const argv = readFileSync(argvOut, "utf8").trim().split(" ");

    const inputIndex = argv.indexOf("--input");
    expect(inputIndex).toBeGreaterThanOrEqual(0); // -1 without the fix: no --input at all
    expect(argv[inputIndex + 1]).toBe(expectedCachePath);
    // Without the fix, set-slot is pointed at the live server instead, and
    // comfy-cli refuses that outright as potential SSRF against a non-loopback
    // host — measured 2026-08-08 against a live remote — which is the bug
    // this fix closes.
    expect(argv).not.toContain("--host");
    expect(argv).not.toContain("--port");
  } finally {
    globalThis.fetch = realFetch;
    rmSync(roots, { recursive: true, force: true });
  }
});

test("run_workflow fills a cold object_info cache for a non-local host before pointing set-slot at it", async () => {
  const remoteHost = "192.0.2.1"; // RFC 5737 TEST-NET-1: on no interface, answers nothing for real
  const remotePort = 8189;
  const cacheDir = join(workdir, "cache"); // fresh — nothing has ever written here

  const roots = mkdtempSync(join(tmpdir(), "mcp-comfyui-tools-remote-cold-"));
  const workflowPath = join(roots, "flow.json");
  writeFileSync(workflowPath, JSON.stringify({ nodes: [{ id: 6, type: "CLIPTextEncode" }], links: [] }));

  const expectedCachePath = objectInfoCachePath({ host: remoteHost, port: remotePort, cacheDir });
  expect(existsSync(expectedCachePath)).toBe(false); // the premise: genuinely cold

  const servedObjectInfo = { CLIPTextEncode: { input: { required: {} } } };
  const systemStatsUrl = `http://${remoteHost}:${remotePort}/system_stats`;
  const objectInfoUrl = `http://${remoteHost}:${remotePort}/object_info`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === systemStatsUrl) {
      return new Response(JSON.stringify({ system: {}, devices: [] }), {
        headers: { "content-type": "application/json" },
      });
    }
    // The behaviour under test: without it, nothing here ever fetches
    // `/object_info` at all, and a real, non-mocked request to a TEST-NET-1
    // address would either hang for this module's own 30s fetch timeout or
    // fall through to `realFetch` and try the real network — neither of
    // which this suite may do.
    if (url === objectInfoUrl) {
      return new Response(JSON.stringify(servedObjectInfo), {
        headers: { "content-type": "application/json" },
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  try {
    // set-slot fails deliberately, same reasoning as the test above: it keeps
    // `argvOut` holding exactly the `set-slot` invocation this test checks,
    // and it happens well after the cache-fill this test is really about.
    serveFailure("workflow_slot_invalid", "boom");

    const client = await connect(baseConfig({ cacheDir }));
    const result = (await client.callTool({
      name: "run_workflow",
      arguments: {
        workflow: workflowPath,
        host: `${remoteHost}:${remotePort}`,
        inputs: { "6.text": "hello" },
      },
    })) as CallToolResult;

    expect(result.isError).toBe(true); // the forced set-slot failure

    // The load-bearing assertion: the cold cache is no longer cold. Without
    // the fix (a bare `objectInfoCachePath`, never fetching), this file is
    // never written and `set-slot` would have been pointed at a path that
    // does not exist — which the real CLI fails outright, `cql_no_graph`,
    // "cannot read object_info: ...: No such file or directory" (measured
    // directly against the installed comfy-cli).
    expect(existsSync(expectedCachePath)).toBe(true);
    expect(JSON.parse(readFileSync(expectedCachePath, "utf8"))).toEqual(servedObjectInfo);

    expect(existsSync(argvOut)).toBe(true);
    const argv = readFileSync(argvOut, "utf8").trim().split(" ");
    const inputIndex = argv.indexOf("--input");
    expect(inputIndex).toBeGreaterThanOrEqual(0);
    expect(argv[inputIndex + 1]).toBe(expectedCachePath);
  } finally {
    globalThis.fetch = realFetch;
    rmSync(roots, { recursive: true, force: true });
  }
});

test("run_workflow with no inputs never fetches object_info, even for a non-local host", async () => {
  // `applySlots` short-circuits on empty inputs and never spawns `comfy`, so the
  // node definitions are not needed. Fetching them anyway made the commonest
  // remote call — run it with its defaults — depend on an endpoint nothing
  // downstream reads: with `/system_stats` answering and `/object_info` down,
  // the whole run failed with `object_info_unavailable` and a message claiming
  // the instance was unreachable, which it was not.
  const remoteHost = "192.0.2.1"; // RFC 5737 TEST-NET-1
  const remotePort = 8189;
  const cacheDir = join(workdir, "cache-no-inputs");

  const roots = mkdtempSync(join(tmpdir(), "mcp-comfyui-tools-remote-noinputs-"));
  const workflowPath = join(roots, "flow.json");
  writeFileSync(workflowPath, JSON.stringify({ nodes: [{ id: 6, type: "CLIPTextEncode" }], links: [] }));

  const systemStatsUrl = `http://${remoteHost}:${remotePort}/system_stats`;
  const objectInfoUrl = `http://${remoteHost}:${remotePort}/object_info`;
  let objectInfoRequested = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === systemStatsUrl) {
      return new Response(JSON.stringify({ system: {}, devices: [] }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url === objectInfoUrl) {
      // Answering 500 rather than never being called is deliberate: it makes
      // the regression fail loudly here instead of silently succeeding on a
      // warm cache somewhere else.
      objectInfoRequested = true;
      return new Response("boom", { status: 500 });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  try {
    // `run` fails, so nothing submits — this test is about what happened before it.
    process.env.FAKE_COMFY_MODE = "fail";

    const client = await connect(baseConfig({ cacheDir }));
    const result = (await client.callTool({
      name: "run_workflow",
      arguments: { workflow: workflowPath, host: `${remoteHost}:${remotePort}` },
    })) as CallToolResult;

    // The assertion that matters: /object_info was never asked for.
    expect(objectInfoRequested).toBe(false);
    // And the failure the caller sees is the run's own, not a fabricated
    // "node definitions unavailable" about an endpoint it never needed.
    const body = JSON.parse(textOf(result));
    expect(body.error.kind).not.toBe("object_info_unavailable");
  } finally {
    globalThis.fetch = realFetch;
    rmSync(roots, { recursive: true, force: true });
  }
});

test("overwrite: true replaces an existing workflow", async () => {
  useFetchMode();
  const created = join(workdir, "created-ow");
  mkdirSync(created, { recursive: true });
  const target = join(created, "fixture_template.json");
  writeFileSync(target, "ORIGINAL");

  const client = await connect(configWithEnv({ MCP_COMFYUI_CREATED_DIR: created }));
  const result = (await client.callTool({
    name: "create_workflow_from_template",
    arguments: { template: "fixture_template", overwrite: true },
  })) as CallToolResult;

  const body = JSON.parse(textOf(result));
  expect(body.path).toBe(target);
  expect(readFileSync(target, "utf8")).not.toBe("ORIGINAL");
});

test("the refusal names overwrite as the way through, and leaves the file alone", async () => {
  useFetchMode();
  const created = join(workdir, "created-ow2");
  mkdirSync(created, { recursive: true });
  const target = join(created, "fixture_template.json");
  writeFileSync(target, "ORIGINAL");

  const client = await connect(configWithEnv({ MCP_COMFYUI_CREATED_DIR: created }));
  const result = (await client.callTool({
    name: "create_workflow_from_template",
    arguments: { template: "fixture_template" },
  })) as CallToolResult;

  const body = JSON.parse(textOf(result));
  expect(body.error.kind).toBe("invalid_input");
  expect(body.error.message).toContain("overwrite: true");
  expect(readFileSync(target, "utf8")).toBe("ORIGINAL");
});

test("a failed fetch leaves no empty placeholder behind", async () => {
  // The exclusive-create guard writes a zero-byte file before the CLI runs. If
  // the fetch then fails, that file must go: `list_workflows` classifies by
  // CONTENT, so an empty one would be reported as a workflow that is `invalid`
  // — a phantom the caller never asked to create and cannot explain.
  process.env.FAKE_COMFY_MODE = "fail_code";
  process.env.FAKE_COMFY_ERROR_CODE = "template_not_found";
  process.env.FAKE_COMFY_ERROR_MESSAGE = "no such template";
  const created = join(workdir, "created-ow3");

  const client = await connect(configWithEnv({ MCP_COMFYUI_CREATED_DIR: created }));
  const result = (await client.callTool({
    name: "create_workflow_from_template",
    arguments: { template: "nope" },
  })) as CallToolResult;

  expect(result.isError).toBe(true);
  expect(existsSync(join(created, "nope.json"))).toBe(false);
});

// NO TEST for the concurrent case, deliberately. The guard is `writeFileSync`
// with the `wx` flag — create-exclusive, so the kernel decides which of two
// callers wins rather than a check that another call can slip past. It replaced
// an `existsSync` check separated from the write by an `await`, which was a real
// window.
//
// It is not tested here because it cannot be: this suite drives the server over
// InMemoryTransport, which serialises tool calls, so two "concurrent" calls run
// strictly one after the other and a check-then-write passes just as cleanly.
// Verified — a faithful revert to the pre-fix shape kills no test in this file.
// A test asserting atomicity here would pass for a reason unrelated to what it
// claims, which is worse than no test at all.
