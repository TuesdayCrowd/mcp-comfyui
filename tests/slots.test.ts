import { afterEach, beforeEach, expect, test } from "./support/testing.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComfyCliError, ComfyTimeoutError } from "../src/comfy/exec.ts";
import { SlotListingParseError, listSlots, type Slot, type SlotListing } from "../src/workflows/slots.ts";

/**
 * No test in this file may invoke a real `comfy` or reach a real ComfyUI:
 * `COMFY_BIN` points at the sh fixture for every one of them, and the payload
 * comes from a file the test controls.
 */
const FAKE_COMFY = join(import.meta.dirname, "fixtures", "fake-comfy");

/** Real captured `data` from `comfy workflow slots` against a live instance. */
const CAPTURED = join(import.meta.dirname, "fixtures", "slots.default_image_gen.json");

let workdir: string;
let argvOut: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "mcp-comfyui-slots-"));
  argvOut = join(workdir, "argv");
  process.env.COMFY_BIN = FAKE_COMFY;
  process.env.FAKE_COMFY_ARGV_OUT = argvOut;
  servePayloadFile(CAPTURED); // the real capture unless a test says otherwise
});

afterEach(() => {
  delete process.env.COMFY_BIN;
  delete process.env.FAKE_COMFY_MODE;
  delete process.env.FAKE_COMFY_ARGV_OUT;
  delete process.env.FAKE_COMFY_DATA_FILE;
  delete process.env.FAKE_COMFY_ERROR_CODE;
  delete process.env.FAKE_COMFY_ERROR_MESSAGE;
  delete process.env.FAKE_COMFY_PID_OUT;
  rmSync(workdir, { recursive: true, force: true });
});

/** Serve an existing JSON file as the envelope's `data`. */
function servePayloadFile(path: string): void {
  process.env.FAKE_COMFY_MODE = "data_file";
  process.env.FAKE_COMFY_DATA_FILE = path;
}

/** Serve an arbitrary value as the envelope's `data`. */
function servePayload(data: unknown): void {
  const path = join(workdir, "payload.json");
  writeFileSync(path, JSON.stringify(data));
  servePayloadFile(path);
}

/** Make the fake fail with a chosen error code. */
function serveFailure(code: string, message: string): void {
  process.env.FAKE_COMFY_MODE = "fail_code";
  process.env.FAKE_COMFY_ERROR_CODE = code;
  process.env.FAKE_COMFY_ERROR_MESSAGE = message;
}

/** The argv the fake was invoked with, as the CLI would have received it. */
function argv(): string[] {
  return readFileSync(argvOut, "utf8").trim().split(" ");
}

/** Await a promise that must reject, and hand back what it rejected with. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected listSlots to reject, but it resolved");
}

function slotAt(listing: SlotListing, address: string): Slot {
  const found = listing.slots.find((slot) => slot.address === address);
  if (!found) {
    throw new Error(`no slot ${address}; got ${listing.slots.map((s) => s.address).join(", ")}`);
  }
  return found;
}

test("parses the real captured payload into typed slots", async () => {
  const listing = await listSlots("/workflows/default_image_gen.json");

  expect(listing.id).toBe("default_image_gen");
  expect(listing.workflow).toBe("/Users/lawls/ComfyUI-Shared/user/default/workflows/default_image_gen.json");
  expect(listing.count).toBe(13);
  expect(listing.slots).toHaveLength(13);

  expect(slotAt(listing, "3.seed")).toEqual({
    address: "3.seed",
    name: "seed",
    type: "INT",
    current_value: 94109865029533,
    instance_id: "3",
    node_type: "KSampler",
  });
  // Numbers stay numbers: Task 3.1 has to re-emit these as CLI values.
  expect(typeof slotAt(listing, "3.seed").current_value).toBe("number");

  const sampler = slotAt(listing, "3.sampler_name");
  expect(sampler.type).toBe("COMBO");
  expect(sampler.current_value).toBe("euler");
  expect(sampler.node_type).toBe("KSampler"); // the object_info key Task 2.3 joins on
});

test("keeps string and float slots as their JSON types", async () => {
  const listing = await listSlots("/workflows/default_image_gen.json");
  expect(slotAt(listing, "3.cfg").current_value).toBe(3.5);
  expect(slotAt(listing, "6.text").current_value).toContain("Art Deco style");
});

test("passes --input for offline listing and no server address", async () => {
  const cache = join(workdir, "object_info.json");
  await listSlots("/workflows/flow.json", { objectInfoPath: cache });

  expect(argv()).toContain("--input");
  expect(argv()[argv().indexOf("--input") + 1]).toBe(cache);
  expect(argv()).not.toContain("--host");
  expect(argv()).not.toContain("--port");
});

test("passes --host and --port when there is no cached object_info", async () => {
  await listSlots("/workflows/flow.json", { host: "10.0.0.5", port: 9999 });

  expect(argv()).toContain("--host");
  expect(argv()[argv().indexOf("--host") + 1]).toBe("10.0.0.5");
  expect(argv()[argv().indexOf("--port") + 1]).toBe("9999");
  expect(argv()).not.toContain("--input");
});

test("defaults the server address to the ComfyUI default rather than leaving it implicit", async () => {
  await listSlots("/workflows/flow.json");
  expect(argv()[argv().indexOf("--host") + 1]).toBe("127.0.0.1");
  expect(argv()[argv().indexOf("--port") + 1]).toBe("8188");
});

test("--input wins when a cache path and a server address are both supplied", async () => {
  // Documented precedence: the two are alternative sources of the same node
  // schemas, and sending both would leave the CLI to arbitrate.
  await listSlots("/workflows/flow.json", {
    objectInfoPath: join(workdir, "object_info.json"),
    host: "10.0.0.5",
    port: 9999,
  });

  expect(argv()).toContain("--input");
  expect(argv()).not.toContain("--host");
  expect(argv()).not.toContain("--port");
  expect(argv()).not.toContain("10.0.0.5");
});

test("rewrites a wildcard bind address to a connect address", async () => {
  // Landmine #10: an operator who launched with `--listen 0.0.0.0` hands us
  // that same string, and it is not somewhere a client can connect to.
  await listSlots("/workflows/flow.json", { host: "0.0.0.0" });
  expect(argv()[argv().indexOf("--host") + 1]).toBe("127.0.0.1");
});

test("rewrites a bracketed IPv6 wildcard too", async () => {
  // `--listen ::` is the IPv6 spelling of the same mistake, and it reaches us
  // bracketed from anything that formatted it for a URL. This module and the
  // object_info cache once disagreed here — one stripped brackets before the
  // wildcard check and one did not — which is why both now share target.ts.
  await listSlots("/workflows/flow.json", { host: "[::]" });
  expect(argv()[argv().indexOf("--host") + 1]).toBe("127.0.0.1");
});

test("global flags precede the subcommand and --skip-prompt is not duplicated", async () => {
  await listSlots("/workflows/flow.json", { host: "127.0.0.1", port: 8188 });

  const captured = argv();
  // `comfy workflow slots --skip-prompt` fails; the Typer root flags come first
  // (landmine #3) — and runComfy already prepends it, so adding our own would
  // send the CLI a repeated flag.
  expect(captured.slice(0, 4)).toEqual(["--skip-prompt", "workflow", "slots", "/workflows/flow.json"]);
  expect(captured.filter((arg) => arg === "--skip-prompt")).toHaveLength(1);
});

test("an unrecognised slot type parses rather than failing the listing", async () => {
  // The type registry is append-only, exactly like the CLI's error codes: a
  // custom node may report anything, and one of them must not sink the listing.
  servePayload({
    workflow: "/workflows/custom.json",
    id: "custom",
    count: 1,
    slots: [
      {
        address: "12.strength",
        name: "strength",
        type: "MY_CUSTOM_WIDGET",
        current_value: 0.5,
        instance_id: "12",
        node_type: "SomeCustomNode",
      },
    ],
  });

  const listing = await listSlots("/workflows/custom.json");
  expect(listing.slots[0]?.type).toBe("MY_CUSTOM_WIDGET");
});

test("a boolean current_value survives", async () => {
  servePayload({
    workflow: "/workflows/flow.json",
    id: "flow",
    count: 1,
    slots: [
      {
        address: "2.add_noise",
        name: "add_noise",
        type: "BOOLEAN",
        current_value: true,
        instance_id: "2",
        node_type: "KSamplerAdvanced",
      },
    ],
  });

  expect((await listSlots("/workflows/flow.json")).slots[0]?.current_value).toBe(true);
});

test("a null current_value survives as null", async () => {
  // An unset optional widget is representable, and Task 2.3 reads null as "no
  // default" — which it can only do if the value arrives neither coerced into
  // some other type nor dropped along with its slot.
  servePayload({
    workflow: "/workflows/flow.json",
    id: "flow",
    count: 1,
    slots: [
      {
        address: "14.lora_name",
        name: "lora_name",
        type: "COMBO",
        current_value: null,
        instance_id: "14",
        node_type: "LoraLoader",
      },
    ],
  });

  const listing = await listSlots("/workflows/flow.json");
  expect(listing.slots).toHaveLength(1); // the slot is not dropped
  expect(listing.slots[0]?.current_value).toBeNull(); // and the value is not coerced
});

test("an unfamiliar slot field is stripped, not rejected", async () => {
  // Strip-not-reject is deliberate: upstream adds fields, and one unfamiliar
  // key must neither sink the listing nor appear on a Slot, whose type says it
  // cannot be there.
  servePayload({
    workflow: "/workflows/flow.json",
    id: "flow",
    count: 1,
    slots: [
      {
        address: "3.seed",
        name: "seed",
        type: "INT",
        current_value: 1,
        instance_id: "3",
        node_type: "KSampler",
        tooltip: "a field this server has never heard of",
      },
    ],
  });

  const listing = await listSlots("/workflows/flow.json");
  expect(listing.slots[0]?.address).toBe("3.seed"); // parsed, not rejected
  expect(listing.slots[0]).not.toHaveProperty("tooltip"); // and not passed through
});

test("a subgraph address with more than two segments is preserved verbatim", async () => {
  // Addresses inside an expanded subgraph carry the enclosing instance too, so
  // an address is opaque and authoritative — never `instance_id` + `.` + `name`.
  servePayload({
    workflow: "/workflows/nested.json",
    id: "nested",
    count: 1,
    slots: [
      {
        address: "8.3.seed",
        name: "seed",
        type: "INT",
        current_value: 42,
        instance_id: "3",
        node_type: "KSampler",
      },
    ],
  });

  const listing = await listSlots("/workflows/nested.json");
  expect(listing.slots[0]?.address).toBe("8.3.seed");
  expect(listing.slots[0]?.instance_id).toBe("3"); // and the parts are untouched
});

test("count reports the slots actually parsed, not the payload's tally", async () => {
  servePayload({
    workflow: "/workflows/flow.json",
    id: "flow",
    count: 99,
    slots: [
      {
        address: "3.seed",
        name: "seed",
        type: "INT",
        current_value: 1,
        instance_id: "3",
        node_type: "KSampler",
      },
    ],
  });

  const listing = await listSlots("/workflows/flow.json");
  expect(listing.count).toBe(1);
  expect(listing.count).toBe(listing.slots.length);
});

test("an API-format workflow is reported with the fix, not just the code", async () => {
  serveFailure("workflow_not_frontend_format", "workflow is not in frontend format");

  const err = await rejection(listSlots("/workflows/api_format.json"));

  // Still the CLI's own error: the code registry stays the branching surface.
  expect(err).toBeInstanceOf(ComfyCliError);
  expect((err as ComfyCliError).code).toBe("workflow_not_frontend_format");

  const message = (err as Error).message;
  expect(message).toContain("/workflows/api_format.json"); // which file
  expect(message).toContain("API"); // the format it is in
  expect(message).toContain("frontend"); // the format it needs
  expect(message).toContain("Export"); // and what to actually do about it
  expect(message).toContain("workflow is not in frontend format"); // CLI text kept
});

test("an unrelated CLI failure propagates untouched", async () => {
  serveFailure("workflow_not_found", "no such file");

  const err = await rejection(listSlots("/workflows/missing.json"));
  expect(err).toBeInstanceOf(ComfyCliError);
  expect((err as Error).message).toBe(
    "comfy workflow slots failed (workflow_not_found): no such file",
  );
});

test("a timeout propagates as a timeout, on the caller's budget", async () => {
  process.env.FAKE_COMFY_MODE = "hang";

  const started = Date.now();
  const err = await rejection(listSlots("/workflows/flow.json", { timeoutMs: 250 }));

  expect(err).toBeInstanceOf(ComfyTimeoutError);
  expect(Date.now() - started).toBeLessThan(1_500); // ours, not the 120s default
});

test("a payload with no slots array is rejected with a description of the payload", async () => {
  servePayload({ workflow: "/workflows/flow.json", id: "flow", count: 0 });

  const err = await rejection(listSlots("/workflows/flow.json"));
  expect(err).toBeInstanceOf(SlotListingParseError);
  expect(err).not.toBeInstanceOf(ComfyCliError);

  const message = (err as Error).message;
  // Deliberately past the constant prefix, which already contains both the word
  // "slots" and the workflow path and so can satisfy a naive assertion on its
  // own. What makes this message worth reading is the zod detail...
  expect(message).toContain("Invalid input: expected array, received undefined");
  expect(message).toContain("→ at slots"); // which field, and where
  // ...and the payload itself, which is the only record of what actually came
  // back once the process has exited.
  expect(message).toContain(`received: {"workflow":"/workflows/flow.json","id":"flow","count":0}`);
});

test("a slot missing its address is rejected rather than half-typed", async () => {
  servePayload({
    workflow: "/workflows/flow.json",
    id: "flow",
    count: 1,
    slots: [
      { name: "seed", type: "INT", current_value: 1, instance_id: "3", node_type: "KSampler" },
    ],
  });

  const err = await rejection(listSlots("/workflows/flow.json"));
  expect(err).toBeInstanceOf(SlotListingParseError);
  const message = (err as Error).message;
  expect(message).toContain("address"); // names the offending field
  expect(message).toContain("slots[0]"); // and where it was
});

test("a null data payload is rejected, not returned as an empty listing", async () => {
  servePayload(null);
  const err = await rejection(listSlots("/workflows/flow.json"));
  expect(err).toBeInstanceOf(SlotListingParseError);
});
