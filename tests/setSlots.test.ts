import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ComfyCliError, ComfyTimeoutError } from "../src/comfy/exec";
import {
  SetSlotContractError,
  SlotValueError,
  WorkflowFileError,
  applySlots,
  type PreparedWorkflow,
} from "../src/workflows/setSlots";

/**
 * No test in this file may invoke a real `comfy` or reach a real ComfyUI:
 * `COMFY_BIN` points at the sh fixture for every one of them.
 */
const FAKE_COMFY = join(import.meta.dir, "fixtures", "fake-comfy");

/**
 * 2^64−1, the largest seed ComfyUI accepts, and 2^53+ so it cannot survive a JS
 * `JSON.parse`. It sits in the source workflow of every test — untouched by any
 * override — because the whole architecture of this module exists to keep it
 * intact (landmine #11).
 */
const HUGE_SEED = "18446744073709551615";

/** How the temp directories this module creates are named. */
const TEMP_PREFIX = "mcp-comfyui-apply-";

let workdir: string;
let argvOut: string;
let source: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "mcp-comfyui-setslots-"));
  argvOut = join(workdir, "argv");
  source = join(workdir, "flow.json");
  writeFileSync(
    source,
    `{"nodes":[{"id":3,"type":"KSampler","widgets_values":[${HUGE_SEED},20]}],"links":[]}`,
  );
  process.env.COMFY_BIN = FAKE_COMFY;
  process.env.FAKE_COMFY_ARGV_OUT = argvOut;
  process.env.FAKE_COMFY_MODE = "set_slot";
});

afterEach(() => {
  delete process.env.COMFY_BIN;
  delete process.env.FAKE_COMFY_MODE;
  delete process.env.FAKE_COMFY_ARGV_OUT;
  delete process.env.FAKE_COMFY_APPLIED;
  delete process.env.FAKE_COMFY_WARNINGS;
  delete process.env.FAKE_COMFY_WROTE_NULL;
  delete process.env.FAKE_COMFY_DATA_FILE;
  delete process.env.FAKE_COMFY_ERROR_CODE;
  delete process.env.FAKE_COMFY_ERROR_MESSAGE;
  rmSync(workdir, { recursive: true, force: true });
  for (const name of leakedTempDirs()) {
    rmSync(join(tmpdir(), name), { recursive: true, force: true });
  }
});

/** Temp directories this module created and did not clean up. */
function leakedTempDirs(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith(TEMP_PREFIX));
}

/** The argv the fake was invoked with, flattened as the slots suite does. */
function argv(): string[] {
  return readFileSync(argvOut, "utf8").trim().split(" ");
}

/**
 * The `ADDR=VALUE` positionals the fake actually received, recovered verbatim
 * from the markers it appended to the file it was handed. Read from the file
 * rather than `argv()` because a value may hold spaces, `=` or newlines, all
 * three of which the space-joined argv capture destroys.
 */
function pairsSent(prepared: PreparedWorkflow): string[] {
  const text = readFileSync(prepared.path, "utf8");
  return [...text.matchAll(/<<<PAIR\n([\s\S]*?)\nPAIR>>>/g)].map((match) => match[1] ?? "");
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Make the fake fail with a chosen error code. */
function serveFailure(code: string, message: string): void {
  process.env.FAKE_COMFY_MODE = "fail_code";
  process.env.FAKE_COMFY_ERROR_CODE = code;
  process.env.FAKE_COMFY_ERROR_MESSAGE = message;
}

/** Serve an arbitrary value as the envelope's `data`. */
function servePayload(data: unknown): void {
  const path = join(workdir, "payload.json");
  writeFileSync(path, JSON.stringify(data));
  process.env.FAKE_COMFY_MODE = "data_file";
  process.env.FAKE_COMFY_DATA_FILE = path;
}

/** Await a promise that must reject, and hand back what it rejected with. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected applySlots to reject, but it resolved");
}

// --- the copy ------------------------------------------------------------

test("edits a temp copy under the OS temp dir and leaves the source untouched", async () => {
  const before = sha256(source);

  const prepared = await applySlots(source, { "3.steps": 7 });

  expect(prepared.path).not.toBe(source);
  expect(dirname(prepared.path)).toStartWith(join(tmpdir(), TEMP_PREFIX));
  expect(prepared.source).toBe(source);
  expect(existsSync(prepared.path)).toBe(true);
  // The copy keeps the original's filename. comfy-cli displays
  // `Path(workflow_path).name` and keys template schemas off `.stem`, so a
  // fixed or generated name would rename the user's workflow in every place
  // the CLI reports it.
  expect(basename(prepared.path)).toBe(basename(source));
  // The user's own file is never what gets edited — the reason for the copy.
  expect(sha256(source)).toBe(before);

  prepared.dispose();
});

test("empty inputs copy the file and never spawn the CLI", async () => {
  // `run_workflow` with no overrides is a legitimate call, and `set-slot`'s
  // ADDR=VALUE argument is required — invoking it with none is a usage error
  // that never reaches an envelope.
  const prepared = await applySlots(source, {});

  expect(existsSync(argvOut)).toBe(false);
  expect(prepared.applied).toEqual([]);
  expect(prepared.warnings).toEqual([]);
  expect(sha256(prepared.path)).toBe(sha256(source)); // a byte copy, nothing more

  prepared.dispose();
});

test("inputs default to none at all", async () => {
  const prepared = await applySlots(source);
  expect(existsSync(argvOut)).toBe(false);
  expect(sha256(prepared.path)).toBe(sha256(source));
  prepared.dispose();
});

test("a byte copy preserves an integer JSON.parse would round, which --stdout could not", () => {
  // This is why the module copies the file instead of taking `data.workflow_json`
  // back through JS. `comfy` itself is exact — Python ints are arbitrary
  // precision — so the loss is entirely ours, and only avoiding the round trip
  // avoids it. Delete this test and someone will "simplify" the copy away.
  const raw = readFileSync(source, "utf8");
  expect(raw).toContain(HUGE_SEED);

  const roundTripped = JSON.stringify(JSON.parse(raw));
  expect(roundTripped).not.toContain(HUGE_SEED);
  expect(roundTripped).toContain("18446744073709552000"); // silently, and for a seed nobody set
});

test("the temp copy keeps an out-of-range integer the caller never mentioned", async () => {
  const prepared = await applySlots(source, { "3.steps": 7 });

  // The override is elsewhere in the graph; the seed must still be byte-exact.
  expect(readFileSync(prepared.path, "utf8")).toContain(HUGE_SEED);

  prepared.dispose();
});

test("a workflow file that is not there is named as such, not as a temp path", async () => {
  // The likeliest user error of the whole server. Unwrapped, `copyFileSync`
  // raises a bare `Error` named `Error` whose message quotes the destination
  // too — so the operator is shown a UUID directory they never chose, next to
  // the path they actually got wrong.
  const missing = join(workdir, "does-not-exist.json");

  const err = await rejection(applySlots(missing, { "3.steps": 7 }));

  expect(err).toBeInstanceOf(WorkflowFileError);
  expect((err as WorkflowFileError).code).toBe("ENOENT");
  const message = (err as Error).message;
  expect(message).toContain(missing); // the caller's path
  expect(message).not.toContain(TEMP_PREFIX); // and not ours
  expect(message).toContain("list_workflows"); // named as the tool a model has
  expect(existsSync(argvOut)).toBe(false); // nothing was spawned
  expect(leakedTempDirs()).toEqual([]); // and nothing was left behind
});

test("an unreadable workflow file is reported without guessing why", async () => {
  const unreadable = join(workdir, "unreadable.json");
  writeFileSync(unreadable, "{}");
  chmodSync(unreadable, 0o000);

  const err = await rejection(applySlots(unreadable, { "3.steps": 7 }));

  expect(err).toBeInstanceOf(WorkflowFileError);
  expect((err as WorkflowFileError).code).toBe("EACCES");
  expect((err as Error).message).toContain(unreadable);
  expect(leakedTempDirs()).toEqual([]);
});

// --- the invocation ------------------------------------------------------

test("sets the copy in place, and never asks for the graph back on stdout", async () => {
  const prepared = await applySlots(source, { "3.steps": 7 });

  expect(argv()).toContain("--in-place");
  expect(argv()).not.toContain("--stdout");
  expect(argv()).toContain(prepared.path);
  expect(argv()).not.toContain(source);

  prepared.dispose();
});

test("global flags precede the subcommand and --skip-prompt is not duplicated", async () => {
  const prepared = await applySlots(source, { "3.steps": 7 });

  const captured = argv();
  expect(captured.slice(0, 3)).toEqual(["--skip-prompt", "workflow", "set-slot"]);
  expect(captured[3]).toBe(prepared.path); // the file is the first positional
  expect(captured.filter((arg) => arg === "--skip-prompt")).toHaveLength(1);

  prepared.dispose();
});

test("passes --input for offline application and no server address", async () => {
  const cache = join(workdir, "object_info.json");
  const prepared = await applySlots(source, { "3.steps": 7 }, { objectInfoPath: cache });

  expect(argv()[argv().indexOf("--input") + 1]).toBe(cache);
  expect(argv()).not.toContain("--host");
  expect(argv()).not.toContain("--port");

  prepared.dispose();
});

test("defaults the server address rather than leaving it implicit", async () => {
  const prepared = await applySlots(source, { "3.steps": 7 });
  expect(argv()[argv().indexOf("--host") + 1]).toBe("127.0.0.1");
  expect(argv()[argv().indexOf("--port") + 1]).toBe("8188");
  prepared.dispose();
});

test("rewrites a wildcard bind address to a connect address", async () => {
  const prepared = await applySlots(source, { "3.steps": 7 }, { host: "0.0.0.0" });
  expect(argv()[argv().indexOf("--host") + 1]).toBe("127.0.0.1");
  prepared.dispose();
});

// --- value encoding ------------------------------------------------------

test("each input becomes one ADDR=VALUE positional", async () => {
  const prepared = await applySlots(source, { "3.steps": 7, "6.text": "a cat" });
  expect(pairsSent(prepared)).toEqual(["3.steps=7", "6.text=a cat"]);
  prepared.dispose();
});

test("a value containing = survives whole", async () => {
  // `set-slot` splits on the FIRST `=`, so everything after the first one is
  // value. Nothing here may pre-split, escape or quote it.
  const prepared = await applySlots(source, { "6.text": "weight=1.2, style=noir" });
  expect(pairsSent(prepared)).toEqual(["6.text=weight=1.2, style=noir"]);
  prepared.dispose();
});

test("a multi-line prompt survives verbatim", async () => {
  const prompt = "a photo of a cat\n\nnegative: blurry, low quality\n  indented tail";
  const prepared = await applySlots(source, { "6.text": prompt });

  expect(pairsSent(prepared)).toEqual([`6.text=${prompt}`]);

  prepared.dispose();
});

test("quotes and unicode reach the CLI unescaped", async () => {
  // argv entries, not a shell command line: adding quoting would put the quotes
  // themselves into the prompt.
  const prompt = `she said "café" — 90% 'done' \\ $HOME \`x\``;
  const prepared = await applySlots(source, { "6.text": prompt });
  expect(pairsSent(prepared)).toEqual([`6.text=${prompt}`]);
  prepared.dispose();
});

test("numbers carry no formatting", async () => {
  const prepared = await applySlots(source, {
    "5.width": 1000000,
    "3.cfg": 3.5,
    "3.denoise": 0.0001,
    "3.seed": 9007199254740991, // Number.MAX_SAFE_INTEGER is still exact
  });

  expect(pairsSent(prepared)).toEqual([
    "5.width=1000000", // no thousands separator
    "3.cfg=3.5",
    "3.denoise=0.0001", // and no exponent for an ordinary decimal
    "3.seed=9007199254740991",
  ]);

  prepared.dispose();
});

test("booleans encode as JSON literals", async () => {
  const prepared = await applySlots(source, { "2.add_noise": true, "2.disable": false });
  expect(pairsSent(prepared)).toEqual(["2.add_noise=true", "2.disable=false"]);
  prepared.dispose();
});

// --- seed precision (landmine #11) --------------------------------------

test("an integer beyond 2^53 is refused with the escape hatch in the message", async () => {
  const err = await rejection(applySlots(source, { "3.seed": 18446744073709551615 }));

  expect(err).toBeInstanceOf(SlotValueError);
  const message = (err as Error).message;
  expect(message).toContain("3.seed"); // which input
  expect(message).toContain("18446744073709552000"); // the value, as it already arrived
  expect(message).toContain("9007199254740991"); // where exactness ends
  expect(message).toContain("string"); // and what to do instead
  expect(existsSync(argvOut)).toBe(false); // refused before anything was spawned
  expect(leakedTempDirs()).toEqual([]); // and before anything was created
});

test("a string of digits is the exact escape hatch and travels as text", async () => {
  // Verified against the real CLI: an ADDR=VALUE positional is parsed by
  // Python, whose ints are arbitrary precision, so the digits are written
  // exactly. Coercing this to a JS number would round it here instead.
  const prepared = await applySlots(source, { "3.seed": HUGE_SEED });

  expect(pairsSent(prepared)).toEqual([`3.seed=${HUGE_SEED}`]);

  prepared.dispose();
});

test("an ordinary float is not caught by the safe-integer guard", async () => {
  const prepared = await applySlots(source, { "3.cfg": 0.30000000000000004, "3.d": -2.5 });
  expect(pairsSent(prepared)).toEqual(["3.cfg=0.30000000000000004", "3.d=-2.5"]);
  prepared.dispose();
});

test("a non-finite number is refused rather than written as NaN", async () => {
  // Python's json.loads accepts `NaN` and `Infinity`, so this would land in the
  // workflow file and only fail later, inside ComfyUI.
  const err = await rejection(applySlots(source, { "3.cfg": Number.NaN }));
  expect(err).toBeInstanceOf(SlotValueError);
  expect((err as Error).message).toContain("3.cfg");
  expect(existsSync(argvOut)).toBe(false);
});

test("a value that is not a string, number or boolean is refused", async () => {
  const err = await rejection(
    applySlots(source, { "6.text": null as unknown as string }),
  );
  expect(err).toBeInstanceOf(SlotValueError);
  expect((err as Error).message).toContain("6.text");
  expect(existsSync(argvOut)).toBe(false);
});

// --- address encoding ----------------------------------------------------

test("an address containing = is refused, because the CLI would mis-split it", async () => {
  // `3.a=b` + `=` + `5` is `3.a=b=5`, which the CLI splits on the FIRST `=`
  // into address `3.a` and value `b=5` — a value silently applied to the wrong
  // input. Nothing downstream can detect that, so it is refused here.
  const err = await rejection(applySlots(source, { "3.a=b": 5 }));

  expect(err).toBeInstanceOf(SlotValueError);
  expect((err as Error).message).toContain("3.a=b");
  expect(existsSync(argvOut)).toBe(false);
  expect(leakedTempDirs()).toEqual([]);
});

test("a blank address is refused", async () => {
  const err = await rejection(applySlots(source, { "   ": 5 }));
  expect(err).toBeInstanceOf(SlotValueError);
  expect(existsSync(argvOut)).toBe(false);
});

// --- what the CLI reported back -----------------------------------------

test("warnings from the envelope are surfaced with their detail intact", async () => {
  process.env.FAKE_COMFY_WARNINGS = JSON.stringify([
    {
      code: "unknown_enum_value",
      field: "sampler_name",
      message: "'eulerr' not in 44 known options for sampler_name",
      valid_options: ["euler", "dpmpp_2m"],
    },
  ]);

  const prepared = await applySlots(source, { "3.sampler_name": "eulerr" });

  expect(prepared.warnings).toHaveLength(1);
  expect(prepared.warnings[0]?.code).toBe("unknown_enum_value");
  expect(prepared.warnings[0]?.message).toContain("not in 44 known options");
  // Fields this server has never heard of are the useful part of a warning.
  expect(prepared.warnings[0]?.valid_options).toEqual(["euler", "dpmpp_2m"]);

  prepared.dispose();
});

test("an address the CLI did not apply fails loudly instead of reporting success", async () => {
  // The single most important behaviour here. `data.applied` is the CLI's echo
  // of the addresses it was handed, so a caller who typoed `3.step` must never
  // be told their run succeeded with that value applied.
  process.env.FAKE_COMFY_APPLIED = JSON.stringify(["3.steps"]);

  const err = await rejection(applySlots(source, { "3.steps": 7, "3.step": 7 }));

  expect(err).toBeInstanceOf(SetSlotContractError);
  const message = (err as Error).message;
  expect(message).toContain("3.step"); // the one that went missing
  expect(message).toContain(source); // on which workflow
  expect(leakedTempDirs()).toEqual([]); // and nothing left behind to be run
});

test("an address the CLI applied but nobody asked for also fails loudly", async () => {
  process.env.FAKE_COMFY_APPLIED = JSON.stringify(["3.steps", "3.seed"]);

  const err = await rejection(applySlots(source, { "3.steps": 7 }));

  expect(err).toBeInstanceOf(SetSlotContractError);
  expect((err as Error).message).toContain("3.seed");
});

test("a report of having written nothing fails rather than yielding an unedited copy", async () => {
  // `wrote: null` is what `--stdout` answers. Returning then would hand Task 3.2
  // a copy with none of the caller's values in it and call that a success.
  process.env.FAKE_COMFY_WROTE_NULL = "1";

  const err = await rejection(applySlots(source, { "3.steps": 7 }));

  expect(err).toBeInstanceOf(SetSlotContractError);
  expect((err as Error).message).toContain("wrote");
  expect(leakedTempDirs()).toEqual([]);
});

test("a payload that is not a set-slot result is rejected with the payload quoted", async () => {
  servePayload({ workflow: "/x.json", warnings: [] });

  const err = await rejection(applySlots(source, { "3.steps": 7 }));

  expect(err).toBeInstanceOf(SetSlotContractError);
  const message = (err as Error).message;
  expect(message).toContain("Invalid input: expected array, received undefined");
  expect(message).toContain("→ at applied");
  expect(message).toContain(`received: {"workflow":"/x.json","warnings":[]}`);
  expect(leakedTempDirs()).toEqual([]);
});

test("a warning shaped unlike the contract is reported, not silently dropped", async () => {
  process.env.FAKE_COMFY_WARNINGS = JSON.stringify(["just a string"]);

  const err = await rejection(applySlots(source, { "3.steps": 7 }));
  expect(err).toBeInstanceOf(SetSlotContractError);
});

// --- CLI failures --------------------------------------------------------

test("a rejected address propagates the CLI's own diagnosis and leaves nothing behind", async () => {
  serveFailure(
    "workflow_slot_invalid",
    "widget 'step' not found on KSampler; available widgets: seed, steps, cfg",
  );

  const err = await rejection(applySlots(source, { "3.step": 7 }));

  expect(err).toBeInstanceOf(ComfyCliError);
  expect((err as ComfyCliError).code).toBe("workflow_slot_invalid");
  expect((err as Error).message).toContain("available widgets");
  expect(leakedTempDirs()).toEqual([]);
});

test("a timeout propagates as a timeout, on the caller's budget", async () => {
  process.env.FAKE_COMFY_MODE = "hang";

  const started = Date.now();
  const err = await rejection(applySlots(source, { "3.steps": 7 }, { timeoutMs: 250 }));

  expect(err).toBeInstanceOf(ComfyTimeoutError);
  expect(Date.now() - started).toBeLessThan(1_500);
  expect(leakedTempDirs()).toEqual([]);
});

// --- temp file lifetime --------------------------------------------------

test("two applications of the same workflow do not collide", async () => {
  const first = await applySlots(source, { "3.steps": 7 });
  const second = await applySlots(source, { "3.steps": 99 });

  expect(second.path).not.toBe(first.path);
  // Not merely different names: the first copy must still hold its own value.
  expect(pairsSent(first)).toEqual(["3.steps=7"]);
  expect(pairsSent(second)).toEqual(["3.steps=99"]);

  first.dispose();
  second.dispose();
});

test("dispose removes the temp copy and is safe to repeat", async () => {
  const prepared = await applySlots(source, { "3.steps": 7 });
  const dir = dirname(prepared.path);

  prepared.dispose();
  expect(existsSync(prepared.path)).toBe(false);
  expect(existsSync(dir)).toBe(false);

  expect(() => prepared.dispose()).not.toThrow(); // a `finally` may run twice
  expect(sha256(source)).toBeString(); // and the source is still there
});

test("disposing does not disturb the source workflow", async () => {
  const before = sha256(source);
  const prepared = await applySlots(source, { "3.steps": 7 });
  prepared.dispose();
  expect(sha256(source)).toBe(before);
});
