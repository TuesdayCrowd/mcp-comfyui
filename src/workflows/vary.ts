import { z } from "zod";
import { snippet } from "../comfy/envelope.ts";
import { runComfy } from "../comfy/exec.ts";
import { DEFAULT_PORT, resolveHost } from "../comfy/target.ts";
import { SlotValueError, type SlotValue } from "./setSlots.ts";

/**
 * `comfy workflow vary` zips per-slot value lists into N workflow variants.
 * This module is the typed wrapper over that command, and the single place in
 * this codebase that must never touch a variant's graph.
 *
 * ## Why `--out-dir` is not optional
 *
 * The command has two output modes and only one of them is safe. Measured
 * 2026-08-22 against the installed CLI:
 *
 * - **Without `--out-dir`**, `data.variants` carries whole frontend graphs —
 *   `nodes`, `links`, `last_node_id`, the lot — at 84,918 bytes each for a real
 *   template. Decoding that envelope is `JSON.parse` over a graph, which is
 *   non-negotiable #1 exactly: JavaScript rounds integers above 2^53, and a
 *   seed reaches 2^64−1. A seed sweep is the one workflow where the seeds are
 *   the entire point, so this would corrupt precisely what the caller asked to
 *   vary.
 * - **With `--out-dir`**, the graphs go to disk and the envelope reports
 *   `written` — a list of file paths — with `variants` present and set to
 *   `null`. Nothing graph-shaped is parsed, and `run_sweep` submits each path
 *   the way `run_workflow` submits a prepared copy.
 *
 * So {@link VaryOptions.outDir} is **required**, not defaulted: a caller cannot
 * reach the unsafe mode from here, and {@link VaryPayloadSchema} deliberately
 * does not declare `variants` at all, so a future CLI that started returning
 * graphs under `--out-dir` anyway would still have them stripped here rather
 * than carried to a caller.
 *
 * The CLI's own write is exact: verified with `--slot '3.seed=[18446744073709551615,1]'`,
 * the written variant contains those digits and not the rounded
 * `18446744073709552000`. Python's arbitrary-precision `int` carries it, the
 * same way it does for `set-slot`.
 *
 * ## Zipped, not crossed
 *
 * Two lists of three produce **three** variants, not nine — the CLI's own help
 * says every `--slot` must carry the same length. A caller expecting a cross
 * product gets a quarter of the runs they wanted and no error, so the lengths
 * are checked here, before a process is spawned, where the message can name
 * both addresses and both lengths.
 */

/**
 * A `vary` warning: an out-of-range value, an enum value missing from the
 * catalog, a stale `object_info` cache. They never fail the operation.
 *
 * Deliberately a twin of `setSlots.ts`'s `SetSlotWarningSchema` rather than a
 * shared export, on the same reasoning `slots.ts` and `notes.ts` duplicate
 * `schemaSourceArgs`: the two commands emit the same shape today by
 * coincidence of the CLI's surface, not by contract.
 *
 * `code` is an **open string** — non-negotiable #2. `object_info_stale` is the
 * one measured here, and upstream's registry is append-only.
 */
export const VaryWarningSchema = z.looseObject({
  code: z.string(),
  message: z.string(),
});

export type VaryWarning = z.infer<typeof VaryWarningSchema>;

/**
 * The payload of a successful `workflow vary --out-dir`.
 *
 * **`variants` is deliberately not declared**, and this is the load-bearing
 * line of the module. Zod strips what it does not declare, so a graph cannot
 * reach a caller through this schema even if a future CLI sends one under
 * `--out-dir`; and a reader looking for the variants finds only `written`,
 * which is the address of the answer rather than the answer itself. Declaring
 * it — even as `z.unknown()` — would invite the next reader to use it.
 */
const VaryPayloadSchema = z.object({
  workflow: z.string(),
  count: z.number().int(),
  out_dir: z.string(),
  written: z.array(z.string()),
  warnings: z.array(VaryWarningSchema),
  /** Whether the node definitions came from a cache the CLI could not refresh. */
  stale: z.boolean(),
});

/** The variants one `vary` call produced, as files. */
export interface VariantSet {
  /** The source workflow as the CLI resolved it — absolute, whatever was passed. */
  workflow: string;
  /**
   * How many variants were written. Cross-checked against `written.length`
   * rather than trusted: see {@link VariantSetParseError}.
   */
  count: number;
  /** The variant files, in variant order. This is the whole answer. */
  written: string[];
  /** Advisory notes; the variants were written regardless. */
  warnings: VaryWarning[];
  /** Whether the node definitions the CLI validated against were stale. */
  stale: boolean;
}

export interface VaryOptions {
  /**
   * Where the variants are written. **Required** — see the module doc: it is
   * the flag that keeps a graph out of this process, so there is no default
   * and no way to omit it.
   */
  outDir: string;
  /** ComfyUI's address, defaulting to `127.0.0.1`. Ignored with `objectInfoPath`. */
  host?: string;
  /** Defaults to `8188`. Ignored with `objectInfoPath`. */
  port?: number;
  /**
   * A saved `/object_info` document, which lets the CLI resolve node schemas
   * with no server running. **Takes precedence over `host`/`port`**.
   */
  objectInfoPath?: string;
  /** Budget for the CLI call. Defaults to `runComfy`'s 120 seconds. */
  timeoutMs?: number;
}

/**
 * The caller's value lists could not be used as a sweep. Thrown before
 * anything is spawned, so nothing needs cleaning up.
 *
 * Separate from {@link SlotValueError}, which names ONE address at fault: a
 * length mismatch is a fact about several lists at once, and a caller with
 * twenty of them cannot act on a message that names a single one.
 */
export class VaryListError extends Error {
  override readonly name = "VaryListError";
}

/**
 * The CLI answered, but with something this server cannot read as a variant
 * set. Distinct from `ComfyCliError` on the same reasoning as
 * `SlotListingParseError`: that is the CLI reporting a failure it understood,
 * this is the contract itself not holding.
 */
export class VariantSetParseError extends Error {
  override readonly name = "VariantSetParseError";
  readonly workflowPath: string;

  constructor(workflowPath: string, detail: string, options?: { cause?: unknown }) {
    super(
      `comfy workflow vary returned a payload this server could not read for ${workflowPath}\n${detail}`,
      options,
    );
    this.workflowPath = workflowPath;
  }
}

/** The payload came from `JSON.parse`, so it cannot be cyclic. */
function describe(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

/**
 * Where the CLI is to get node schemas from. The two sources are alternatives,
 * so exactly one is sent; the cache wins because a caller who supplied one is
 * asking for a deterministic, offline answer.
 *
 * A twin of the same function in `setSlots.ts` and `slots.ts`, deliberately not
 * shared — see {@link VaryWarningSchema} for the reasoning. `target.ts` already
 * holds the part that must not diverge.
 */
function schemaSourceArgs(opts: VaryOptions): string[] {
  if (opts.objectInfoPath !== undefined) return ["--input", opts.objectInfoPath];
  return ["--host", resolveHost(opts.host), "--port", String(opts.port ?? DEFAULT_PORT)];
}

/**
 * A digit string, which is the documented way to spell an integer JavaScript
 * cannot hold. Sent to the CLI **unquoted**, so `json.loads` reads it back as
 * a Python `int` of arbitrary precision — the same escape hatch `setSlots.ts`
 * keeps open for a single run, and the reason `18446744073709551615` survives
 * a sweep at all.
 *
 * A leading `-` is allowed inside the array: unlike an address, an element is
 * never at the head of an argv token, so it cannot be read as a flag.
 */
const DIGITS = /^-?[0-9]+$/;

/** What arrived, for a message about why it was not usable. */
function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

/**
 * One element of a value list, as it will appear inside the JSON array.
 *
 * **The string rule here is the opposite of `setSlots.ts`'s**, and the
 * difference is the encoding, not a change of mind. There a string is the
 * whole right-hand side of `ADDR=VALUE` and is sent raw unless the slot's type
 * is known; here it is one element of a list the CLI parses with `json.loads`,
 * so an unquoted `a cat` makes the entire array unparseable — the CLI's own
 * hint spells the correct form, `--slot '6.text=["a cat","a dog"]'`. Quoting is
 * therefore unconditional, with one exception: a string of digits, which is
 * the exact-integer escape hatch above and must stay unquoted to remain one.
 *
 * The cost of that exception is that a COMBO option spelled entirely in digits
 * cannot be sent as a string through this path. `run_workflow` is where a
 * single such value belongs; a sweep over them is not a case that has come up,
 * and the alternative — dropping the exception — would corrupt every large
 * seed, which is this feature's whole subject.
 */
function encodeElement(address: string, value: SlotValue): string {
  switch (typeof value) {
    case "string":
      return DIGITS.test(value) ? value : JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new SlotValueError(
          address,
          `${String(value)} is not a finite number. Python's JSON reader accepts NaN and ` +
            `Infinity, so this would be written into the workflow and only fail later, inside ComfyUI.`,
        );
      }
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
        throw new SlotValueError(
          address,
          `${value} is not exact. JavaScript numbers lose whole digits above ` +
            `${Number.MAX_SAFE_INTEGER} (2^53−1), so this value was already rounded before ` +
            `this server saw it — the digits shown are not the ones that were sent.\n` +
            `Pass it as a string of digits instead, e.g. "${BigInt(value)}". A string of digits ` +
            `travels inside the JSON array unquoted and is read by Python, whose integers are ` +
            `arbitrary precision, so it is written exactly.`,
        );
      }
      return String(value);
    default:
      // Reachable: these values cross an MCP boundary as untyped JSON.
      throw new SlotValueError(
        address,
        `${describeType(value)} is not a value a widget can hold; pass a string, number or boolean`,
      );
  }
}

/**
 * One `--slot ADDR=[…]` pair, exactly as the CLI will receive it in argv.
 *
 * The address guards are `setSlots.ts`'s, at a second call site and for the
 * same measured reasons: a token beginning with `-` is read by the CLI's
 * argument parser as another flag (verified live there — an address of
 * `--input` smuggled in a caller-chosen schema source), and the CLI splits an
 * `ADDR=VALUE` pair on the FIRST `=`, so an address containing one would
 * silently set a different input to part of this one's value.
 */
function encodePair(address: string, values: readonly SlotValue[]): string {
  if (address.trim() === "") {
    throw new SlotValueError(
      JSON.stringify(address),
      "a slot address is required; run describe_workflow to list them",
    );
  }
  if (address.startsWith("-")) {
    throw new SlotValueError(
      address,
      "a slot address cannot start with `-`: the CLI's argument parser reads a token " +
        "beginning with `-` as another flag rather than part of an ADDR=VALUE pair. A real slot " +
        'address is `<instance_id>.<name>` (e.g. "3.seed") and never starts with `-`.',
    );
  }
  if (address.includes("=")) {
    throw new SlotValueError(
      address,
      "a slot address cannot contain `=`: the CLI splits an ADDR=VALUE pair on the " +
        "FIRST `=`, so this would silently set a different input to part of this one's value.",
    );
  }
  // Built by hand rather than with `JSON.stringify` over the array: a digit
  // string must land unquoted, and `JSON.stringify` would quote it.
  return `${address}=[${values.map((value) => encodeElement(address, value)).join(",")}]`;
}

/**
 * Refuse a set of lists that cannot describe a sweep, before anything is
 * spawned.
 *
 * All three refusals exist because the CLI's answer to them is worse than an
 * error. Mismatched lengths zip to the SHORTER one and report a cheerful
 * success — valid output of the wrong size, which a benchmark cannot detect.
 * An empty list zips to zero variants. No lists at all hits a required
 * `--slot` option and produces a Typer usage error on stderr rather than an
 * envelope.
 *
 * @returns the agreed length, which is the variant count the CLI should report.
 */
function agreedLength(lists: Record<string, readonly SlotValue[]>): number {
  const entries = Object.entries(lists);
  if (entries.length === 0) {
    throw new VaryListError(
      `a sweep needs at least one slot to vary, each with a list of values — ` +
        `e.g. {"3.seed": [1, 2, 3]}. Call describe_workflow for the addresses this workflow takes.`,
    );
  }

  const lengths = entries.map(([address, values]) => `${address} (${values.length})`);
  const first = entries[0] as [string, readonly SlotValue[]];
  const length = first[1].length;
  if (length === 0) {
    throw new VaryListError(
      `every slot's value list must hold at least one value, and ${lengths.join(", ")} ` +
        `would produce no variants at all.`,
    );
  }
  if (entries.some(([, values]) => values.length !== length)) {
    throw new VaryListError(
      `every slot's value list must be the same length: the lists are ZIPPED, not crossed, so ` +
        `two lists of three produce three variants and not nine. Got ${lengths.join(", ")}.\n` +
        `Pad the shorter lists, or move a value that should be the same on every variant into ` +
        `\`fixed\` instead.`,
    );
  }
  return length;
}

/**
 * Write N variants of `workflowPath` to `opts.outDir` and return their paths.
 *
 * The variants are files and only files: nothing about their contents enters
 * this process. See the module doc for the measurement that decides that.
 *
 * @param workflowPath  the workflow file, in ComfyUI's frontend/UI format.
 * Not modified — the CLI reads it and writes elsewhere.
 * @param lists  per-slot value lists, keyed by slot address. **Zipped**: every
 * list must be the same non-zero length.
 * @throws {VaryListError} the lists could not describe a sweep; nothing was spawned.
 * @throws {SlotValueError} one value or address could not be encoded; nothing was spawned.
 * @throws {VariantSetParseError} the CLI's payload was not a variant set, or its
 * own `count` disagreed with the files it named.
 * @throws {ComfyCliError} the CLI reported a failure — `workflow_slot_invalid`
 * for an address or value it could not use, with its own diagnosis attached.
 * @throws {ComfyTimeoutError} the call exceeded `timeoutMs`.
 * @throws {ComfyUnavailableError} the `comfy` binary could not be started.
 * @throws {TypeError} `host` was given as an empty string, which would build
 * `http://:8188/` and be reported as an unreachable server.
 */
export async function varyWorkflow(
  workflowPath: string,
  lists: Record<string, readonly SlotValue[]>,
  opts: VaryOptions,
): Promise<VariantSet> {
  // Both checks before a process exists, so a caller's mistake costs nothing
  // and leaves nothing behind — `applySlots`'s rule, for the same reason.
  const expected = agreedLength(lists);
  const pairs = Object.entries(lists).flatMap(([address, values]) => [
    "--slot",
    encodePair(address, values),
  ]);

  // Root flags first (non-negotiable #4): `comfy workflow vary --json` fails
  // where `comfy --json workflow vary` works. `--skip-prompt` is `runComfy`'s
  // to prepend; adding it here would repeat it.
  const data = await runComfy(
    ["--json", "workflow", "vary", workflowPath, ...pairs, "--out-dir", opts.outDir, ...schemaSourceArgs(opts)],
    { timeoutMs: opts.timeoutMs },
  );

  const result = VaryPayloadSchema.safeParse(data);
  if (!result.success) {
    throw new VariantSetParseError(
      workflowPath,
      `  received: ${snippet(describe(data))}\n${z.prettifyError(result.error)}`,
      { cause: result.error },
    );
  }

  const payload = result.data;
  // Two accounts of the same thing, and a sweep submits one run per entry in
  // `written` — so a disagreement means the caller would silently get a
  // different number of runs than they asked for. Checked against the
  // requested length too, not only against itself: the CLI zips, and a list
  // this server mis-encoded could produce a shorter sweep that is internally
  // consistent and still wrong.
  if (payload.count !== payload.written.length || payload.written.length !== expected) {
    throw new VariantSetParseError(
      workflowPath,
      `  ${expected} variants were requested, the CLI reported \`count: ${payload.count}\`, and it ` +
        `named ${payload.written.length} file${payload.written.length === 1 ? "" : "s"}. ` +
        `These must agree: a sweep submits one run per file, so nothing was run.`,
    );
  }

  return {
    workflow: payload.workflow,
    count: payload.written.length,
    written: payload.written,
    warnings: payload.warnings,
    stale: payload.stale,
  };
}
