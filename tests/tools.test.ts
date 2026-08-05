import { afterEach, beforeEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerTools, resolveSlotTypes, type ToolConfig } from "../src/tools";

/**
 * Unit-level coverage for `src/tools.ts`'s own logic, below the level of the
 * full `bun build --compile` + stdio harness `tests/server.test.ts` uses for
 * the MCP surface end to end. Two things are covered here that have no other
 * home:
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
const FAKE_COMFY = join(import.meta.dir, "fixtures", "fake-comfy");
const SLOTS_SAMPLE = join(import.meta.dir, "fixtures", "slots.default_image_gen.json");

let workdir: string;
let argvOut: string;
/** A port nothing is listening on, freshly reserved for each test. */
let deadPort: number;
/** Loopback fixtures started by a `launch_comfyui` wiring test, stopped after it. */
let launchServers: ReturnType<typeof Bun.serve>[] = [];

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
function closedPort(): number {
  const throwaway = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const { port } = throwaway;
  throwaway.stop(true);
  if (port === undefined) throw new Error("test server did not bind a port");
  return port;
}

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "mcp-comfyui-tools-"));
  argvOut = join(workdir, "argv");
  deadPort = closedPort();
  launchServers = [];
  process.env.COMFY_BIN = FAKE_COMFY;
  process.env.FAKE_COMFY_ARGV_OUT = argvOut;
});

afterEach(() => {
  for (const bound of launchServers) bound.stop(true); // force: a hung handler must not hold the suite
  delete process.env.COMFY_BIN;
  delete process.env.FAKE_COMFY_MODE;
  delete process.env.FAKE_COMFY_ARGV_OUT;
  delete process.env.FAKE_COMFY_DATA_FILE;
  delete process.env.FAKE_COMFY_ERROR_CODE;
  delete process.env.FAKE_COMFY_ERROR_MESSAGE;
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
    env: {},
    ...overrides,
  };
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
  const types = await resolveSlotTypes("flow.json", {}, baseConfig());
  expect(types).toEqual({});
  expect(existsSync(argvOut)).toBe(false);
});

test("resolveSlotTypes never spawns the CLI when inputs is undefined", async () => {
  const types = await resolveSlotTypes("flow.json", undefined, baseConfig());
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
    baseConfig(),
  );
  expect(types).toEqual({});
  expect(existsSync(argvOut)).toBe(false);
});

test("resolveSlotTypes fetches the listing when a value looks like a JSON boolean", async () => {
  serveSlots();
  const types = await resolveSlotTypes("flow.json", { "9.filename_prefix": "true" }, baseConfig());
  expect(existsSync(argvOut)).toBe(true); // the round trip was made
  expect(types["9.filename_prefix"]).toBe("STRING");
  expect(types["4.ckpt_name"]).toBe("COMBO");
  expect(types["3.seed"]).toBe("INT");
});

test("resolveSlotTypes fetches the listing when a value looks like a JSON integer", async () => {
  serveSlots();
  const types = await resolveSlotTypes("flow.json", { "9.filename_prefix": "42" }, baseConfig());
  expect(types["9.filename_prefix"]).toBe("STRING");
});

test("resolveSlotTypes fetches the listing when a value looks like JSON null", async () => {
  serveSlots();
  const types = await resolveSlotTypes("flow.json", { "9.filename_prefix": "null" }, baseConfig());
  expect(types["9.filename_prefix"]).toBe("STRING");
});

test("resolveSlotTypes fetches the listing when a value looks like a JSON array", async () => {
  serveSlots();
  const types = await resolveSlotTypes("flow.json", { "9.filename_prefix": '["a","b"]' }, baseConfig());
  expect(types["9.filename_prefix"]).toBe("STRING");
});

test("resolveSlotTypes fetches the listing when just one of several values is ambiguous", async () => {
  serveSlots();
  const types = await resolveSlotTypes(
    "flow.json",
    { "6.text": "a photo of a cat", "9.filename_prefix": "true" },
    baseConfig(),
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
  const types = await resolveSlotTypes("flow.json", { "3.seed": "18446744073709551615" }, baseConfig());
  expect(existsSync(argvOut)).toBe(true);
  expect(types["3.seed"]).toBe("INT");
});

test("resolveSlotTypes falls back to {} rather than failing the run when the listing cannot be fetched", async () => {
  // Best-effort: a listing failure here does not fail resolveSlotTypes, and
  // an address absent from the map is exactly how `applySlots` already
  // treated every address before finding 1 was fixed — not a new failure
  // mode, only a missed improvement for this one call.
  serveFailure("server_not_running", "no server");
  const types = await resolveSlotTypes("flow.json", { "9.filename_prefix": "true" }, baseConfig());
  expect(types).toEqual({});
});

test("resolveSlotTypes falls back to {} when the CLI's payload is not a slot listing", async () => {
  process.env.FAKE_COMFY_MODE = "data_file";
  const badPayload = join(workdir, "bad.json");
  writeFileSync(badPayload, JSON.stringify({ not: "a slot listing" }));
  process.env.FAKE_COMFY_DATA_FILE = badPayload;

  const types = await resolveSlotTypes("flow.json", { "9.filename_prefix": "true" }, baseConfig());
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
function fakeInstance(): ReturnType<typeof Bun.serve> {
  const bound = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(JSON.stringify({ system: {}, devices: [] }), {
        headers: { "content-type": "application/json" },
      }),
  });
  launchServers.push(bound);
  return bound;
}

/** Refuses until probed `failures` times, then answers like `fakeInstance`. */
function fakeInstanceReadyAfter(failures: number): ReturnType<typeof Bun.serve> {
  let seen = 0;
  const bound = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      seen++ < failures
        ? new Response("starting", { status: 503 })
        : new Response(JSON.stringify({ system: {}, devices: [] }), {
            headers: { "content-type": "application/json" },
          }),
  });
  launchServers.push(bound);
  return bound;
}

function portOf(bound: ReturnType<typeof Bun.serve>): number {
  const { port } = bound;
  if (port === undefined) throw new Error("test server did not bind a port");
  return port;
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
