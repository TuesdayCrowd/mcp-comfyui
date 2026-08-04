import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
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

/**
 * `tmpdir()` is shared across every concurrently-running test **file**, and
 * `TEMP_PREFIX` names only which module made a directory (`setSlots.ts`), not
 * which test run made it. Scanning the whole of `tmpdir()` for that prefix —
 * as this file, `tests/run.test.ts` and `tests/server.test.ts` all did —
 * therefore does not scope to "what this test leaked": it also matches a
 * prepared copy a *sibling file* is using at that exact instant, under a
 * concurrent `bun test`. Each file's own `afterEach` then deleted every
 * match, reaping a directory another file was still reading mid-CLI-call —
 * measured as the intermittent, previously-unreproducible failure this
 * comment exists to explain. `run.test.ts` and `server.test.ts` are already
 * scoped; this is the third and last.
 *
 * The fix is a snapshot: `preexistingTempDirs` is taken at the end of every
 * `beforeEach`, so it holds whatever the rest of the suite already has in
 * flight the moment this test starts, and {@link leakedTempDirs} reports only
 * what is new since then — this test's own directories, and nothing a
 * sibling file made before or during it.
 */
let preexistingTempDirs = new Set<string>();

function snapshotTempDirs(): Set<string> {
  return new Set(readdirSync(tmpdir()).filter((name) => name.startsWith(TEMP_PREFIX)));
}

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
  // Last, so it captures anything a sibling file created while this file's
  // own fixtures above were being set up, not just what existed before
  // `beforeEach` began.
  preexistingTempDirs = snapshotTempDirs();
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

/**
 * Temp directories THIS TEST created and did not clean up — never a sibling
 * file's. See {@link preexistingTempDirs} for why the scoping matters.
 */
function leakedTempDirs(): string[] {
  return readdirSync(tmpdir()).filter(
    (name) => name.startsWith(TEMP_PREFIX) && !preexistingTempDirs.has(name),
  );
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

test("finding 3: a workflow path that is a directory is reported cleanly, whatever errno the platform used", async () => {
  // Measured on this machine: Bun's copyFileSync throws ENOTSUP for a
  // directory source (`ENOTSUP: operation not supported on socket, copyfile
  // '<dir>' -> '<temp path>'`), not the EISDIR this class already mapped —
  // and the raw message quotes the destination, i.e. exactly the UUID temp
  // path WorkflowFileError exists to hide. The fix checks the filesystem fact
  // directly rather than the OS's own errno spelling for it, so this holds
  // regardless of which errno this platform happens to report.
  const dir = join(workdir, "adir.json");
  mkdirSync(dir);

  const err = await rejection(applySlots(dir, { "3.steps": 7 }));

  expect(err).toBeInstanceOf(WorkflowFileError);
  expect((err as WorkflowFileError).code).toBe("EISDIR");
  const message = (err as Error).message;
  expect(message).toContain(dir); // the caller's own path
  expect(message).toContain("directory");
  expect(message).not.toContain(TEMP_PREFIX); // never the UUID temp path
  expect(existsSync(argvOut)).toBe(false);
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

// --- finding 1: a JSON-literal-shaped string stops being a string --------
//
// comfy-cli JSON-decodes the right-hand side of ADDR=VALUE before
// typechecking it, so an unquoted "true"/"42"/"null"/"[...]" silently stops
// being the string the caller wrote the moment it happens to parse as a JSON
// literal. Every case below was verified against the live CLI on a copy of
// default_image_gen.json before being written as a test — see the design
// note above `NUMERIC_SLOT_TYPES` and `encodeString`.

test("a STRING-typed slot quotes a value that looks like a JSON boolean", async () => {
  const prepared = await applySlots(
    source,
    { "9.filename_prefix": "true" },
    { slotTypes: { "9.filename_prefix": "STRING" } },
  );
  // Live: unquoted, this was rejected `expected STRING (string), got bool`.
  expect(pairsSent(prepared)).toEqual(['9.filename_prefix="true"']);
  prepared.dispose();
});

test("a STRING-typed slot quotes a value that looks like a JSON integer", async () => {
  const prepared = await applySlots(
    source,
    { "9.filename_prefix": "42" },
    { slotTypes: { "9.filename_prefix": "STRING" } },
  );
  // Live: unquoted, this was rejected `expected STRING (string), got int`.
  expect(pairsSent(prepared)).toEqual(['9.filename_prefix="42"']);
  prepared.dispose();
});

test("a STRING-typed slot quotes a value that looks like JSON null", async () => {
  const prepared = await applySlots(
    source,
    { "9.filename_prefix": "null" },
    { slotTypes: { "9.filename_prefix": "STRING" } },
  );
  // Live: unquoted, this was rejected `expected STRING (string), got NoneType`.
  expect(pairsSent(prepared)).toEqual(['9.filename_prefix="null"']);
  prepared.dispose();
});

test("a STRING-typed slot quotes a value that looks like a JSON array", async () => {
  const prepared = await applySlots(
    source,
    { "9.filename_prefix": '["a","b"]' },
    { slotTypes: { "9.filename_prefix": "STRING" } },
  );
  // Live: unquoted, this was rejected `expected STRING (string), got list`.
  expect(pairsSent(prepared)).toEqual(['9.filename_prefix="[\\"a\\",\\"b\\"]"']);
  prepared.dispose();
});

test("a STRING-typed slot quotes ordinary prose too, unconditionally", async () => {
  // Quoting is decided by the type alone, not by whether this particular
  // value happens to look like JSON: a plain sentence quotes to the same
  // string it already was (verified live), so there is no ambiguity-gating
  // inside `encodeString` itself — only in the caller that decides whether to
  // spend the round trip to learn the type at all (see `tools.ts`).
  const prepared = await applySlots(
    source,
    { "6.text": "a plain sentence" },
    { slotTypes: { "6.text": "STRING" } },
  );
  expect(pairsSent(prepared)).toEqual(['6.text="a plain sentence"']);
  prepared.dispose();
});

test("a COMBO-typed slot quotes a digit string, closing the silent-retype gap", async () => {
  // The worse of the two bugs: COMBO accepts str|int|float, so an unquoted
  // numeric-looking enum value is not rejected, it is silently retyped.
  // Verified live: unquoted, the CLI's own warning named the value bare
  // (`123 not in ...`, an int); quoted, it named it in quotes (`'123' not in
  // ...`, a string) — proof the type actually changed.
  const prepared = await applySlots(
    source,
    { "4.ckpt_name": "123" },
    { slotTypes: { "4.ckpt_name": "COMBO" } },
  );
  expect(pairsSent(prepared)).toEqual(['4.ckpt_name="123"']);
  prepared.dispose();
});

test("a BOOLEAN-typed slot quotes a string value rather than letting it become a bool", async () => {
  const prepared = await applySlots(
    source,
    { "2.add_noise": "true" },
    { slotTypes: { "2.add_noise": "BOOLEAN" } },
  );
  expect(pairsSent(prepared)).toEqual(['2.add_noise="true"']);
  prepared.dispose();
});

test("an unrecognised custom widget type is treated as non-numeric and quoted", async () => {
  // `type` is an open string (custom nodes declare their own); the only types
  // exempted from quoting are the two enumerated numeric ones.
  const prepared = await applySlots(
    source,
    { "9.filename_prefix": "42" },
    { slotTypes: { "9.filename_prefix": "SOME_CUSTOM_WIDGET" } },
  );
  expect(pairsSent(prepared)).toEqual(['9.filename_prefix="42"']);
  prepared.dispose();
});

test("an INT-typed slot leaves a digit string raw, preserving the seed escape hatch", async () => {
  // The tension finding 1 names explicitly: this must keep working even
  // though the STRING/COMBO cases above now quote. Verified live: unquoted
  // `18446744073709551615` against an INT slot applies exactly.
  const prepared = await applySlots(
    source,
    { "3.seed": HUGE_SEED },
    { slotTypes: { "3.seed": "INT" } },
  );
  expect(pairsSent(prepared)).toEqual([`3.seed=${HUGE_SEED}`]);
  prepared.dispose();
});

test("a FLOAT-typed slot leaves a digit string raw too", async () => {
  // Verified live: unquoted `3.5` against a FLOAT slot (3.cfg) applies as the
  // Python float it spells.
  const prepared = await applySlots(source, { "3.cfg": "3.5" }, { slotTypes: { "3.cfg": "FLOAT" } });
  expect(pairsSent(prepared)).toEqual(["3.cfg=3.5"]);
  prepared.dispose();
});

test("an address absent from slotTypes falls back to the legacy unquoted behaviour", async () => {
  // slotTypes is supplied, but does not mention this address — distinct from
  // the option being omitted entirely, and must behave the same way: raw.
  const prepared = await applySlots(
    source,
    { "9.filename_prefix": "true" },
    { slotTypes: { "3.seed": "INT" } }, // a different address
  );
  expect(pairsSent(prepared)).toEqual(["9.filename_prefix=true"]);
  prepared.dispose();
});

test("no slotTypes option at all is the same as an empty one: raw, as this module always sent it", async () => {
  const prepared = await applySlots(source, { "9.filename_prefix": "true" });
  expect(pairsSent(prepared)).toEqual(["9.filename_prefix=true"]);
  prepared.dispose();
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

// --- finding 2: leading-dash argument injection --------------------------

test("an address starting with - is refused, mirroring the = guard", async () => {
  // Reproduced live against the real CLI: applySlots(wf, {"97.ckpt_name":"x",
  // "--input":"/tmp/evil_object_info.json"}) had the injected --input HONOURED
  // — set-slot used the attacker's object_info instead of the live server's.
  // `--input=<path>` is one ADDR=VALUE token, but a token beginning with `-`
  // is read by the CLI's argument parser as another flag, not a positional.
  const err = await rejection(
    applySlots(source, { "97.ckpt_name": "x", "--input": "/tmp/evil_object_info.json" }),
  );

  expect(err).toBeInstanceOf(SlotValueError);
  expect((err as Error).message).toContain("--input");
  expect(existsSync(argvOut)).toBe(false); // refused before anything was spawned
  expect(leakedTempDirs()).toEqual([]); // and before anything was created
});

test("a single-dash address is refused too", async () => {
  const err = await rejection(applySlots(source, { "-x": 5 }));
  expect(err).toBeInstanceOf(SlotValueError);
  expect((err as Error).message).toContain("-x");
  expect(existsSync(argvOut)).toBe(false);
});

test("one poisoned address among otherwise-valid ones still refuses the whole call", async () => {
  // Every pair is encoded before anything is spawned (see the comment above
  // `applySlots`), so a caller cannot smuggle one bad address past a batch of
  // good ones by hoping only the good ones get sent.
  const err = await rejection(
    applySlots(source, { "3.steps": 7, "6.text": "a cat", "--host": "evil.example" }),
  );

  expect(err).toBeInstanceOf(SlotValueError);
  expect((err as Error).message).toContain("--host");
  expect(existsSync(argvOut)).toBe(false);
  expect(leakedTempDirs()).toEqual([]);
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
