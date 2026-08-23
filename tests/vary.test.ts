import { afterEach, beforeEach, expect, test } from "./support/testing.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComfyCliError } from "../src/comfy/exec.ts";
import { SlotValueError } from "../src/workflows/setSlots.ts";
import { VariantSetParseError, VaryListError, varyWorkflow } from "../src/workflows/vary.ts";

/** No test here may invoke a real `comfy`: COMFY_BIN points at the sh fixture. */
const FAKE_COMFY = join(import.meta.dirname, "fixtures", "fake-comfy");

/**
 * A workflow whose bytes carry an integer JavaScript cannot hold. The fixture
 * byte-copies it into every variant, so a test can prove the digits survived a
 * round trip that never parsed the graph.
 */
const HUGE_SEED = "18446744073709551615";

let workdir: string;
let source: string;
let outDir: string;
let argvOut: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "mcp-comfyui-vary-"));
  source = join(workdir, "flow.json");
  writeFileSync(source, `{"last_node_id": 9, "nodes": [], "seed": ${HUGE_SEED}}`);
  outDir = join(workdir, "out");
  mkdirSync(outDir);
  argvOut = join(workdir, "argv");
  process.env.COMFY_BIN = FAKE_COMFY;
  process.env.FAKE_COMFY_MODE = "vary";
  process.env.FAKE_COMFY_ARGV_OUT = argvOut;
});

afterEach(() => {
  delete process.env.COMFY_BIN;
  delete process.env.FAKE_COMFY_MODE;
  delete process.env.FAKE_COMFY_ARGV_OUT;
  delete process.env.FAKE_COMFY_VARY_WARNINGS;
  delete process.env.FAKE_COMFY_VARY_STALE;
  delete process.env.FAKE_COMFY_VARY_VARIANTS_FILE;
  delete process.env.FAKE_COMFY_DATA_FILE;
  delete process.env.FAKE_COMFY_ERROR_CODE;
  delete process.env.FAKE_COMFY_ERROR_MESSAGE;
  rmSync(workdir, { recursive: true, force: true });
});

/** The fixture records `$*`, space-joined; no argv in these tests holds a space. */
function readArgv(): string[] {
  return readFileSync(argvOut, "utf8").trim().split(" ");
}

/** Whether the CLI was invoked at all. The fixture writes this file on entry. */
function invoked(): boolean {
  return existsSync(argvOut);
}

function serveFailure(code: string, message: string): void {
  process.env.FAKE_COMFY_MODE = "fail_code";
  process.env.FAKE_COMFY_ERROR_CODE = code;
  process.env.FAKE_COMFY_ERROR_MESSAGE = message;
}

/** Serve a payload of our own, for the shapes the `vary` mode cannot produce. */
function servePayload(data: unknown): void {
  const path = join(workdir, "payload.json");
  writeFileSync(path, JSON.stringify(data));
  process.env.FAKE_COMFY_MODE = "data_file";
  process.env.FAKE_COMFY_DATA_FILE = path;
}

async function failureOf(work: () => Promise<unknown>): Promise<Error> {
  try {
    await work();
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected a failure, but the call succeeded");
}

test("a variant's graph never enters this process", async () => {
  // THE constraint. Measured 2026-08-22 against the installed CLI: WITHOUT
  // --out-dir, `data.variants` carries whole frontend graphs — 84,918 bytes
  // each for a real template — and parsing one would round every seed above
  // 2^53, which is the exact value a seed sweep exists to vary. With --out-dir
  // the same key comes back `null` and `written` names files instead.
  //
  // Mutant: have vary.ts read `data.variants` instead of `data.written`. It
  // dies on `written`, which is where the answer is.
  const result = await varyWorkflow(source, { "3.seed": [1, 2, 3] }, { outDir });

  expect(result.count).toBe(3);
  expect(result.written).toHaveLength(3);
  for (const path of result.written) expect(existsSync(path)).toBe(true);
  // Nothing graph-shaped on the returned object, at any depth.
  expect(JSON.stringify(result)).not.toContain("last_node_id");
  expect(JSON.stringify(result)).not.toContain('"nodes"');
});

test("a CLI that returned graphs anyway would still not get one parsed here", async () => {
  // The measurement above says today's CLI sends `variants: null` under
  // --out-dir. That is a property of one release, not a contract — so this
  // arms the fixture with the graphs a future one might send back regardless,
  // and pins that none of it reaches the caller. `variants` is deliberately
  // absent from the payload schema, which is what strips it here.
  //
  // Mutant: declare `variants` on VaryPayloadSchema and carry it. Dies on both
  // assertions, because the graph then survives into the result.
  const variants = join(workdir, "variants.json");
  writeFileSync(variants, `[{"last_node_id": 9, "nodes": [], "seed": ${HUGE_SEED}}]`);
  process.env.FAKE_COMFY_VARY_VARIANTS_FILE = variants;

  const result = await varyWorkflow(source, { "3.seed": [1] }, { outDir });

  expect(result.count).toBe(1);
  expect(JSON.stringify(result)).not.toContain("last_node_id");
  expect(JSON.stringify(result)).not.toContain('"nodes"');
});

test("the written variant keeps a 2^64-1 seed byte-exact", async () => {
  // The other half of the same constraint, on the side this server does not
  // control: the CLI writes the file, and Python's arbitrary-precision int is
  // what carries the digits. Verified on the real CLI 2026-08-22; pinned here
  // so a fixture that started re-serialising the graph would be caught.
  const result = await varyWorkflow(source, { "3.seed": [1] }, { outDir });

  const written = readFileSync(result.written[0] as string, "utf8");
  expect(written).toContain(HUGE_SEED);
  expect(written).not.toContain("18446744073709552000");
});

test("--out-dir is always passed, even when the caller did not think to", async () => {
  // The no-graph guarantee is only as good as the flag that produces it.
  //
  // Mutant: drop `--out-dir` from the argv. This test dies on the missing flag.
  await varyWorkflow(source, { "3.seed": [1, 2] }, { outDir });

  const argv = readArgv();
  expect(argv).toContain("--out-dir");
  expect(argv[argv.indexOf("--out-dir") + 1]).toBe(outDir);
  // And the global flags precede the subcommand — non-negotiable #4.
  expect(argv.indexOf("--json")).toBeLessThan(argv.indexOf("workflow"));
  expect(argv.indexOf("--skip-prompt")).toBeLessThan(argv.indexOf("workflow"));
});

test("each slot's values are sent as a JSON array", async () => {
  // Measured: `--slot '3.seed=1,2,3'` is refused with `workflow_slot_invalid`,
  // "value must be a JSON array (got str)". A comma-joined list is the obvious
  // wrong thing to build and the CLI catches it, but only after a round trip.
  //
  // Mutant: join with commas instead of building the array. Dies here.
  await varyWorkflow(source, { "3.seed": [1, 2] }, { outDir });

  expect(readArgv()).toContain("3.seed=[1,2]");
});

test("a huge seed is passed as digits, not as a rounded JS number", async () => {
  // 2^64-1 is what ComfyUI accepts and what JavaScript cannot hold. A caller
  // passing it as a STRING must see those digits reach the CLI untouched — the
  // same rule `setSlots.ts` follows for a single run, now for a list. Inside a
  // JSON array the digits must be UNQUOTED, or Python reads back the string
  // "18446744073709551615" and the widget gets text where it wanted an int.
  //
  // Mutant: `Number(value)` anywhere in the argv construction, or
  // `JSON.stringify` over the whole array. Dies on the rounded value or on the
  // quotes.
  await varyWorkflow(source, { "3.seed": [HUGE_SEED, 1] }, { outDir });

  const argv = readArgv();
  expect(argv).toContain(`3.seed=[${HUGE_SEED},1]`);
  expect(argv).not.toContain("18446744073709552000");
});

test("a number too large for JavaScript is refused rather than quietly rounded", async () => {
  // The companion refusal. By the time a JSON number reaches this process it
  // has already been rounded at the MCP boundary, so the digits shown are not
  // the digits sent — `setSlots.ts` refuses one for exactly this reason and
  // names the string form as the fix.
  //
  // Mutant: drop the safe-integer check. Dies because the call succeeds.
  const error = await failureOf(() =>
    varyWorkflow(source, { "3.seed": [1, 18446744073709551615] }, { outDir })
  );

  expect(error).toBeInstanceOf(SlotValueError);
  expect(error.message).toContain("3.seed");
  expect(invoked()).toBe(false);
});

test("a string that is not digits is JSON-quoted, so the array stays valid JSON", async () => {
  // The rule that differs from `setSlots.ts`. There a bare string is sent raw
  // because it is the whole right-hand side; here it is one element of an
  // array the CLI parses with `json.loads`, and an unquoted `a cat` makes the
  // entire list unparseable — measured hint from the CLI itself:
  // `--slot '6.text=["a cat","a dog"]'`.
  //
  // Mutant: send prompt strings raw. Dies on the missing quotes.
  await varyWorkflow(source, { "6.text": ["cat", "dog"] }, { outDir });

  expect(readArgv()).toContain('6.text=["cat","dog"]');
});

test("mismatched list lengths are refused before any CLI call", async () => {
  // The CLI zips, so lists of 3 and 2 silently produce 2 variants — valid
  // output of the wrong size, which is worse than an error. Caught here, where
  // the message can name both lengths, and without spending a round trip.
  //
  // Mutant: drop the length check. Dies because the CLI is invoked at all.
  const error = await failureOf(() =>
    varyWorkflow(source, { "3.seed": [1, 2, 3], "6.text": ["a", "b"] }, { outDir })
  );

  expect(error).toBeInstanceOf(VaryListError);
  expect(error.message).toMatch(/same length/);
  // Both lengths named, and both addresses: a caller with twenty lists cannot
  // act on "the lengths disagree".
  expect(error.message).toContain("3.seed");
  expect(error.message).toContain("6.text");
  expect(error.message).toContain("3");
  expect(error.message).toContain("2");
  expect(invoked()).toBe(false);
});

test("a sweep of nothing is refused before any CLI call", async () => {
  // An empty list zips to zero variants, which the CLI reports as a cheerful
  // success with `written: []`. Nothing downstream can act on that, and a
  // caller who sent it meant something else.
  //
  // Mutant: allow an empty list. Dies because the CLI is invoked.
  const error = await failureOf(() => varyWorkflow(source, { "3.seed": [] }, { outDir }));

  expect(error).toBeInstanceOf(VaryListError);
  expect(invoked()).toBe(false);
});

test("no lists at all is refused before any CLI call", async () => {
  // `--slot` is a REQUIRED option on this command, so an empty map produces a
  // Typer usage error on stderr rather than an envelope — the same reason
  // `applySlots` short-circuits on empty inputs instead of calling the CLI.
  const error = await failureOf(() => varyWorkflow(source, {}, { outDir }));

  expect(error).toBeInstanceOf(VaryListError);
  expect(invoked()).toBe(false);
});

test("an address that would be read as a flag is refused before any CLI call", async () => {
  // `setSlots.ts`'s finding 2, at a second call site. An address beginning
  // with `-` is not read as part of the `ADDR=VALUE` pair by the CLI's
  // argument parser — verified live there, where `--input` smuggled in a
  // caller-chosen schema source. A real address is `<instance_id>.<name>`.
  //
  // Mutant: drop the address guard. Dies because the call reaches the CLI.
  const error = await failureOf(() => varyWorkflow(source, { "--input": [1] }, { outDir }));

  expect(error).toBeInstanceOf(SlotValueError);
  expect(invoked()).toBe(false);
});

test("an address carrying `=` is refused before any CLI call", async () => {
  // The CLI splits on the FIRST `=`, so `a=b` as an address would silently set
  // a different input to part of this one's value.
  const error = await failureOf(() => varyWorkflow(source, { "3.seed=x": [1] }, { outDir }));

  expect(error).toBeInstanceOf(SlotValueError);
  expect(invoked()).toBe(false);
});

test("the schema source is the cache when one is given, and the host when it is not", async () => {
  // `vary` consults /object_info exactly as `set-slot` does, and the two
  // sources are alternatives — a caller who supplied a cache is asking for a
  // deterministic, offline answer.
  //
  // Mutant: send both. Dies on the host appearing beside the cache.
  await varyWorkflow(source, { "3.seed": [1] }, { outDir, objectInfoPath: "/tmp/oi.json" });
  expect(readArgv()).toContain("--input");
  expect(readArgv()).not.toContain("--host");

  await varyWorkflow(source, { "3.seed": [1] }, { outDir, host: "rtx-video", port: 8189 });
  const argv = readArgv();
  expect(argv).not.toContain("--input");
  expect(argv[argv.indexOf("--host") + 1]).toBe("rtx-video");
  expect(argv[argv.indexOf("--port") + 1]).toBe("8189");
});

test("a stale object_info cache warns but still produces the variants", async () => {
  // Measured 2026-08-22 with nothing listening on 127.0.0.1:8188: `vary` came
  // back ok:true, `stale: true`, and one warning — `object_info_stale`,
  // "served from cache ...: Connection refused". So a sweep can be BUILT with
  // no GPU up, which is the same stale-cache posture this server already has.
  //
  // Mutant: treat `stale` as a failure. Dies because the variants are refused.
  process.env.FAKE_COMFY_VARY_STALE = "true";
  process.env.FAKE_COMFY_VARY_WARNINGS =
    '[{"code":"object_info_stale","message":"served from cache: Connection refused"}]';

  const result = await varyWorkflow(source, { "3.seed": [1, 2] }, { outDir });

  expect(result.count).toBe(2);
  expect(result.stale).toBe(true);
  expect(result.warnings[0]?.code).toBe("object_info_stale");
});

test("a payload with no `stale` at all reads as not stale", async () => {
  // The shape a REMOTE sweep always gets, and the one this module got wrong
  // first — found by a live run, not by a fixture. Measured 2026-08-22, the
  // same command twice: pointed at a host with nothing listening it emits
  // `stale: true`; pointed at a cache with `--input` it emits **no `stale`
  // key**. comfy-cli refuses to fetch /object_info from a non-loopback address
  // as potential SSRF, so `--input` is the only source that works for another
  // machine and this server always uses it there. A required `stale` therefore
  // failed every remote sweep with a `contract_violation` — and passed the
  // whole suite, because the fixture always emitted the key.
  //
  // Mutant: make `stale` required again. Dies here.
  servePayload({
    workflow: source,
    count: 2,
    warnings: [],
    out_dir: outDir,
    written: [join(outDir, "flow_000.json"), join(outDir, "flow_001.json")],
    variants: null,
  });

  const result = await varyWorkflow(source, { "3.seed": [1, 2] }, { outDir });

  expect(result.count).toBe(2);
  expect(result.stale).toBe(false);
});

test("a warning code this server has never heard of is carried, not refused", async () => {
  // Non-negotiable #2: every registry from the CLI is an open string, and
  // upstream documents its codes as append-only.
  process.env.FAKE_COMFY_VARY_WARNINGS = '[{"code":"a_code_from_2027","message":"hello"}]';

  const result = await varyWorkflow(source, { "3.seed": [1] }, { outDir });

  expect(result.warnings[0]?.code).toBe("a_code_from_2027");
});

test("the CLI's own refusal of a bad address passes through with its code", async () => {
  // `workflow_slot_invalid` is the CLI's verdict on an address no node
  // answers to — measured: "node 3 not found in workflow". This server adds
  // nothing to it; the code is what a caller branches on.
  serveFailure("workflow_slot_invalid", "node 3 not found in workflow");

  const error = await failureOf(() => varyWorkflow(source, { "3.seed": [1] }, { outDir }));

  expect(error).toBeInstanceOf(ComfyCliError);
  expect((error as ComfyCliError).code).toBe("workflow_slot_invalid");
});

test("a payload that is not a variant set is a contract violation, not a crash", async () => {
  // The same distinction `slots.ts` and `notes.ts` keep: the CLI reporting a
  // failure it understood is one thing, the contract not holding is another.
  servePayload({ workflow: source, count: 2 });

  const error = await failureOf(() => varyWorkflow(source, { "3.seed": [1, 2] }, { outDir }));

  expect(error).toBeInstanceOf(VariantSetParseError);
});

test("a count that disagrees with the files written is refused", async () => {
  // `count` and `written` are two accounts of the same thing, and a sweep
  // submits one run per entry in `written`. If they ever disagree, the honest
  // answer is to say so rather than to pick one — a caller who asked for three
  // variants and silently got two has a benchmark that means nothing.
  //
  // Mutant: trust `count` and ignore the array's length. Dies here.
  servePayload({
    workflow: source,
    count: 3,
    warnings: [],
    out_dir: outDir,
    written: [join(outDir, "flow_000.json"), join(outDir, "flow_001.json")],
    variants: null,
    stale: false,
  });

  const error = await failureOf(() => varyWorkflow(source, { "3.seed": [1, 2, 3] }, { outDir }));

  expect(error).toBeInstanceOf(VariantSetParseError);
  expect(error.message).toContain("3");
  expect(error.message).toContain("2");
});
