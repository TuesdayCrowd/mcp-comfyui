import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import { snippet } from "../comfy/envelope.ts";
import { runComfy } from "../comfy/exec.ts";
import { PREPARED_COPY_PREFIX } from "../comfy/outputs.ts";
import { DEFAULT_PORT, resolveHost } from "../comfy/target.ts";

/**
 * Apply a caller's slot values to a workflow, producing a file ready to run.
 *
 * The shape of this is load-bearing and was measured, not chosen:
 *
 * ```
 * cp <workflow> <temp>                        # a byte copy, never parsed here
 * comfy workflow set-slot <temp> ADDR=VAL...  # in place, on the copy
 * comfy run --workflow <temp>                 # Task 3.2
 * ```
 *
 * The alternative — `set-slot --stdout` and write `data.workflow_json` out
 * ourselves — corrupts graphs. With a seed of `18446744073709551615` in the
 * file, setting an *unrelated* slot returns the correct digits in the envelope
 * text, but `JSON.parse` in `comfy/exec.ts` turns that untouched seed into
 * `18446744073709552000`, and re-serialising persists the damage. Every integer
 * above 2^53 anywhere in the graph is affected, including ones the caller never
 * mentioned. `comfy` itself is exact end to end — Python's `int` is arbitrary
 * precision — so the loss is entirely ours, and it disappears the moment our JS
 * stops handling the graph JSON (landmine #11).
 *
 * The copy is also what keeps the promise that the user's own workflow files
 * are never modified. `set-slot` edits in place; it edits our copy.
 */

/**
 * What a caller may set an input to. These are exactly the JSON scalars a
 * ComfyUI widget holds, and each one is spelled as its JSON literal on the
 * command line — a number unquoted, a string raw.
 *
 * A string of digits is not a workaround: it is the documented way to set a
 * value above 2^53 exactly. See {@link SlotValueError}.
 */
export type SlotValue = string | number | boolean;

/** The addresses a caller wants set, keyed by slot address, e.g. `"3.seed"`. */
export type SlotInputs = Record<string, SlotValue>;

/**
 * `set-slot`'s advisory notes: an out-of-range number, an enum value missing
 * from the catalog, a stale `object_info` cache. They never fail the operation
 * — the value is applied regardless — but they are the only warning a caller
 * gets before a run that may not do what they meant.
 *
 * `looseObject` because the useful part of a warning is usually the fields this
 * server has never heard of: `field`, `valid_options`, the catalog bound that
 * was exceeded. `code` and `message` are required because every warning the CLI
 * constructs carries both, and a warning that carries neither is a contract
 * change worth hearing about rather than something to drop on the floor.
 */
export const SetSlotWarningSchema = z.looseObject({
  code: z.string(),
  message: z.string(),
});

export type SetSlotWarning = z.infer<typeof SetSlotWarningSchema>;

/**
 * The payload of a successful in-place `workflow set-slot`.
 *
 * `applied` is, in the CLI as it stands, an echo of the addresses it was handed
 * rather than a record of what it changed — so it can confirm nothing on its
 * own. It is still checked against the request, because the field's *contract*
 * is "what was applied", and the day the CLI narrows it is the day a typo would
 * otherwise be reported as a successful run.
 *
 * `wrote` is the file the result went to, or `null` when `--stdout` returned it
 * instead. `null` here means the copy this server is about to run has none of
 * the caller's values in it.
 */
const SetSlotPayloadSchema = z.object({
  workflow: z.string(),
  applied: z.array(z.string()),
  warnings: z.array(SetSlotWarningSchema),
  wrote: z.string().nullable(),
});

/**
 * A workflow file with the caller's values in it, ready to run.
 *
 * `path` is a copy in a private temp directory, never the caller's own file.
 * **The recipient owns its lifetime**: whoever holds one of these must call
 * {@link PreparedWorkflow.dispose} when the run is over, normally from a
 * `finally`. `applySlots` cleans up only on the paths where it throws, because
 * nobody else can — no handle was ever returned.
 */
export interface PreparedWorkflow {
  /** The temp copy carrying the caller's values. This is what Task 3.2 runs. */
  path: string;
  /** The caller's own file, which this operation did not touch. */
  source: string;
  /** The addresses set, as the CLI reported them back. */
  applied: string[];
  /** Advisory notes from the CLI; the values were applied anyway. */
  warnings: SetSlotWarning[];
  /**
   * Remove the temp copy. Idempotent, and never throws: it is written to be
   * safe in a `finally`, where a failure of its own would mask the error that
   * sent us there.
   */
  dispose: () => void;
}

export interface ApplySlotsOptions {
  /** ComfyUI's address, defaulting to `127.0.0.1`. Ignored with `objectInfoPath`. */
  host?: string;
  /** Defaults to `8188`. Ignored with `objectInfoPath`. */
  port?: number;
  /**
   * A saved `/object_info` document, which lets the CLI resolve node schemas
   * with no server running (landmine #7). **Takes precedence over `host`/`port`**.
   */
  objectInfoPath?: string;
  /** Budget for the CLI call. Defaults to `runComfy`'s 120 seconds. */
  timeoutMs?: number;
}

/**
 * The caller's own input could not be turned into an `ADDR=VALUE` pair. Thrown
 * before anything is spawned or created, so nothing needs cleaning up, and
 * always naming the address at fault — a caller passing twenty inputs cannot
 * act on "a value was invalid".
 */
export class SlotValueError extends Error {
  override readonly name = "SlotValueError";
  readonly address: string;

  constructor(address: string, reason: string) {
    super(`cannot set ${address}: ${reason}`);
    this.address = address;
  }
}

/**
 * The caller's workflow file could not be read.
 *
 * A separate type because it is the likeliest user error of the whole server —
 * a wrong name, a moved file, a directory the process cannot read — and because
 * the alternative is what `copyFileSync` raises on its own: a bare `Error` named
 * `Error`, whose message quotes the destination as well as the source, so the
 * operator is shown a temp path with a UUID in it that they never chose and
 * cannot act on.
 *
 * The source path is named on its own here, and the OS's reason is kept whole.
 */
export class WorkflowFileError extends Error {
  override readonly name = "WorkflowFileError";
  /** The caller's own path, exactly as it was passed. */
  readonly workflowPath: string;
  /** The OS error code, e.g. `ENOENT` or `EACCES`, where there was one. */
  readonly code: string | null;

  constructor(workflowPath: string, cause: unknown) {
    const code = errorCode(cause);
    super(
      // The OS reason is deliberately NOT quoted for a code we recognise:
      // `copyfile`'s own message names the destination as well as the source,
      // so passing it through is what puts a temp directory nobody chose in
      // front of the operator. Nothing is lost — the raw error is the `cause`.
      `cannot read the workflow file ${workflowPath}: ${KNOWN_FILE_ERRORS[code ?? ""] ?? describeCause(cause)}\n` +
        (code === "ENOENT"
          ? `The list_workflows tool enumerates the workflows this server can see; ` +
            `paths are absolute and case-sensitive.`
          : `Check that the path is a readable file this process has permission to open.`),
      { cause },
    );
    this.workflowPath = workflowPath;
    this.code = code;
  }
}

/**
 * The errno values a workflow path realistically fails with, spelled without
 * the paths the OS embeds. Anything outside this set falls back to the raw
 * message: for an unexpected failure, too much detail beats too little.
 */
const KNOWN_FILE_ERRORS: Record<string, string> = {
  ENOENT: "no such file",
  EACCES: "permission denied",
  EISDIR: "that path is a directory, not a workflow file",
};

function errorCode(cause: unknown): string | null {
  if (typeof cause !== "object" || cause === null) return null;
  const code = (cause as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The CLI answered, but with something that cannot be reconciled with what was
 * asked. Distinct from `ComfyCliError`, which is the CLI reporting a failure it
 * understood: this is the CLI reporting *success* over an answer that does not
 * add up, which is the more dangerous of the two because the next step would
 * otherwise run a graph nobody has checked.
 */
export class SetSlotContractError extends Error {
  override readonly name = "SetSlotContractError";
  readonly workflowPath: string;

  constructor(workflowPath: string, detail: string, options?: { cause?: unknown }) {
    super(
      `comfy workflow set-slot reported success but not the result asked for, for ${workflowPath}\n` +
        `${detail}\n` +
        `Nothing was run and the temp copy was discarded.`,
      options,
    );
    this.workflowPath = workflowPath;
  }
}

/**
 * Where the CLI is to get node schemas from. The two sources are alternatives,
 * so exactly one is sent; the cache wins because a caller who supplied one is
 * asking for a deterministic, offline answer. Deliberately a twin of the same
 * function in `slots.ts` rather than a shared export: the two commands take the
 * same flags today by coincidence of the CLI's surface, not by contract, and
 * `target.ts` already holds the part that must not diverge.
 */
function schemaSourceArgs(opts: ApplySlotsOptions): string[] {
  if (opts.objectInfoPath !== undefined) return ["--input", opts.objectInfoPath];
  return ["--host", resolveHost(opts.host), "--port", String(opts.port ?? DEFAULT_PORT)];
}

/** What arrived, for a message about why it was not usable. */
function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

/**
 * A number as command-line text, or a refusal.
 *
 * The refusal that matters is the integer beyond 2^53. By the time it reaches
 * this function it has already been rounded — it arrived through `JSON.parse`
 * at the MCP boundary — so the only honest thing to do is say so and name the
 * exact alternative, rather than write a seed the caller did not choose.
 */
function encodeNumber(address: string, value: number): string {
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
        `Pass it as a string of digits instead, e.g. "${BigInt(value)}". A string travels ` +
        `to the CLI as command-line text and is read by Python, whose integers are ` +
        `arbitrary precision, so it is written exactly.`,
    );
  }
  // `String` never adds separators and never picks an exponent for a value in
  // the ordinary range; anything it would render as `1e+21` is an integer too
  // large to have got this far.
  return String(value);
}

/** One `ADDR=VALUE` positional, exactly as the CLI will receive it in argv. */
function encodePair(address: string, value: SlotValue): string {
  if (address.trim() === "") {
    throw new SlotValueError(
      JSON.stringify(address),
      "a slot address is required; run describe_workflow to list them",
    );
  }
  if (address.includes("=")) {
    throw new SlotValueError(
      address,
      "a slot address cannot contain `=`: the CLI splits an ADDR=VALUE pair on the " +
        "FIRST `=`, so this would silently set a different input to part of this one's value.",
    );
  }

  switch (typeof value) {
    case "string":
      // Raw, unquoted and unescaped. These are argv entries, not a shell
      // command line, so quoting would put the quotes into the value — and
      // JSON-quoting would break the string-of-digits escape hatch above by
      // turning an exact integer into a string the node then rejects.
      return `${address}=${value}`;
    case "number":
      return `${address}=${encodeNumber(address, value)}`;
    case "boolean":
      return `${address}=${value ? "true" : "false"}`;
    default:
      // Reachable: these values cross an MCP boundary as untyped JSON.
      throw new SlotValueError(
        address,
        `${describeType(value)} is not a value a widget can hold; pass a string, number or boolean`,
      );
  }
}

/** A private directory for one prepared workflow, and a way to remove it. */
function makeTempDir(): { dir: string; dispose: () => void } {
  // A UUID, not a counter or the workflow's name: two runs of the same workflow
  // are the normal case, and a shared path would have the second overwrite the
  // first's graph while it was still being executed. `mkdirSync` without
  // `recursive` so a collision would be loud rather than a silent clobber. The
  // prefix is shared with `comfy/outputs.ts`, which has to recognise these paths
  // coming back from `comfy jobs` after this directory is gone.
  const dir = join(tmpdir(), `${PREPARED_COPY_PREFIX}${randomUUID()}`);
  mkdirSync(dir);

  return {
    dir,
    // Idempotent without a flag to make it so: `force: true` is documented to
    // ignore a path that does not exist, and the catch covers what is left.
    dispose: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Deliberately swallowed, and the only place in this module that is.
        // dispose() runs in a `finally`; a temp file this server failed to
        // remove is the OS's problem at next boot, whereas throwing here would
        // replace whatever error sent us into that `finally`.
      }
    },
  };
}

/**
 * Check the CLI's answer against what was asked. `applied` is compared as a set
 * both ways round: a missing address means a value the caller believes is set
 * is not, and an extra one means the graph was changed in a way nobody asked
 * for. Either makes the prepared file unsafe to run.
 */
function verifyApplied(
  workflowPath: string,
  requested: string[],
  payload: z.infer<typeof SetSlotPayloadSchema>,
): void {
  if (payload.wrote === null) {
    throw new SetSlotContractError(
      workflowPath,
      `  the CLI reported \`wrote: null\`, meaning it returned the modified graph instead of ` +
        `writing it. The prepared copy would carry none of the requested values.`,
    );
  }

  const applied = new Set(payload.applied);
  const missing = requested.filter((address) => !applied.has(address));
  const unexpected = payload.applied.filter((address) => !requested.includes(address));
  if (missing.length === 0 && unexpected.length === 0) return;

  const lines: string[] = [];
  if (missing.length > 0) {
    lines.push(
      `  requested but not applied: ${missing.join(", ")}\n` +
        `    Check the address against describe_workflow — an address the CLI does not ` +
        `recognise is not a value that was set.`,
    );
  }
  if (unexpected.length > 0) {
    lines.push(`  applied but never requested: ${unexpected.join(", ")}`);
  }
  throw new SetSlotContractError(workflowPath, lines.join("\n"));
}

/** The payload came from `JSON.parse`, so it cannot be cyclic. */
function describe(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

/**
 * Copy `workflowPath` and apply `inputs` to the copy.
 *
 * An empty `inputs` is a normal call — running a workflow with no overrides is
 * — and takes the copy without invoking the CLI at all: `set-slot`'s
 * `ADDR=VALUE...` argument is required, and calling it with none produces a
 * Typer usage error on stderr rather than an envelope.
 *
 * @param workflowPath  the workflow file, in ComfyUI's frontend/UI format. Not
 * modified: the copy is what gets edited.
 * @returns a {@link PreparedWorkflow} whose `dispose` the **caller** must call.
 * @throws {SlotValueError} an input could not be encoded; nothing was spawned.
 * @throws {WorkflowFileError} `workflowPath` could not be read — a wrong name
 * or a moved file, the likeliest user error here.
 * @throws {SetSlotContractError} the CLI's answer did not match the request.
 * @throws {ComfyCliError} the CLI rejected the edit — `workflow_slot_invalid`
 * for an address or value it could not use, with its own diagnosis attached.
 * @throws {ComfyTimeoutError} the call exceeded `timeoutMs`.
 * @throws {ComfyUnavailableError} the `comfy` binary could not be started.
 * @throws {TypeError} `host` was given as an empty string, which would build
 * `http://:8188/` and be reported as an unreachable server.
 */
export async function applySlots(
  workflowPath: string,
  inputs: SlotInputs = {},
  opts: ApplySlotsOptions = {},
): Promise<PreparedWorkflow> {
  // Encoded first, before a directory exists or a process is spawned, so a
  // caller's typo costs nothing and leaves nothing behind.
  const requested = Object.keys(inputs);
  const pairs = requested.map((address) => encodePair(address, inputs[address] as SlotValue));

  const temp = makeTempDir();
  try {
    // The whole point of the module: bytes, not a parse and a re-serialise.
    // Keeping the original filename makes the copy recognisable in a process
    // list and preserves anything downstream that reads the file's stem.
    const path = join(temp.dir, basename(workflowPath));
    try {
      copyFileSync(workflowPath, path);
    } catch (cause) {
      // Wrapped rather than propagated: the raw error is named `Error`, is in
      // none of this function's documented failures, and quotes the temp
      // destination alongside the source — so the operator is shown a UUID path
      // they never chose next to the one they got wrong.
      throw new WorkflowFileError(workflowPath, cause);
    }

    if (pairs.length === 0) {
      return { path, source: workflowPath, applied: [], warnings: [], dispose: temp.dispose };
    }

    // `--in-place` is the default, and is passed anyway: it is the one flag on
    // this command whose absence would silently reintroduce the precision loss
    // this module exists to avoid, so the call site says which mode it wants
    // rather than depending on a default staying put (landmine #2's lesson).
    const data = await runComfy(
      ["workflow", "set-slot", path, ...pairs, "--in-place", ...schemaSourceArgs(opts)],
      { timeoutMs: opts.timeoutMs },
    );

    const result = SetSlotPayloadSchema.safeParse(data);
    if (!result.success) {
      throw new SetSlotContractError(
        workflowPath,
        `  received: ${snippet(describe(data))}\n${z.prettifyError(result.error)}`,
        { cause: result.error },
      );
    }
    verifyApplied(workflowPath, requested, result.data);

    return {
      path,
      source: workflowPath,
      applied: result.data.applied,
      warnings: result.data.warnings,
      dispose: temp.dispose,
    };
  } catch (err) {
    // No handle ever reached the caller on this path, so this is the only
    // chance to remove the directory.
    temp.dispose();
    throw err;
  }
}
