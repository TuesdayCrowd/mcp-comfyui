import { z } from "zod";
import { EnvelopeSchema, snippet } from "./envelope.ts";
import { ComfyCliError, runComfyRaw, type RunOptions } from "./exec.ts";

/**
 * `comfy validate`, which answers "would ComfyUI accept this graph?" without
 * submitting it — offline, against a cached `/object_info`, in well under a
 * second. A workflow that fails here would otherwise fail after the queue, the
 * model load and however much of a render ComfyUI got through first.
 *
 * Two measured facts shape this module, and both are why it does not simply
 * call `runComfy` like every sibling.
 *
 * **An invalid workflow is `ok:false` with `error:null`.** Measured against
 * comfy-cli v1.13.0-59-g95d7897 on 2026-08-09: a graph with a bad enum and an
 * out-of-range integer returned exit 1, `ok:false`, `error:null`, and a fully
 * populated `data` carrying the diagnostics. That is not the envelope contract
 * this project reads everywhere else — `envelope.ts` treats `ok:false` with no
 * error object as a contract violation and throws, which is right for every
 * other command and wrong for this one. Verified directly: `runComfy(["--json",
 * "validate", …])` on that file threw `EnvelopeParseError`, so a caller asking
 * a perfectly ordinary question ("is this workflow valid?") would have been
 * told this server and the CLI disagree about the shape of an answer. Hence
 * {@link runComfyRaw} and a decode that reads `data` on both branches.
 *
 * **A valid workflow still carries warnings, and plenty.** The same
 * `video_wan2_2_14B_i2v` that validates clean reports **19** of them, nearly all
 * `edge_type_mismatch` from a `ComfySwitchNode` whose output type ComfyUI's own
 * catalogue cannot express. Warnings are therefore capped in the answer while
 * `warning_count` keeps reporting the true total: a caller needs to know they
 * exist without nineteen near-identical records crowding out the errors that
 * matter.
 */

/** How many warnings travel back. The count is always the true one. */
const MAX_WARNINGS = 5;

/**
 * One diagnostic, as loosely typed as the CLI really is.
 *
 * The record shape is **not uniform across codes** — measured: a whole-node
 * `unknown_class_type` carries no `field`; `unknown_enum_value` carries
 * `suggestions` and `valid_options`; `above_max` carries neither. Only `code`
 * and `message` were present on every diagnostic seen, so only those are
 * required, and `looseObject` keeps whatever else arrives.
 *
 * `code` is `z.string()` and never an enum. The 13 codes this command emits
 * appear in NONE of comfy-cli's published `error_codes.py` registry — a second,
 * wholly undocumented vocabulary — so closing it would break this server on a
 * release that adds a fourteenth.
 */
const DiagnosticSchema = z.looseObject({
  code: z.string(),
  message: z.string(),
  node_id: z.string().nullable().optional(),
  field: z.string().nullable().optional(),
  hint: z.string().nullable().optional(),
});

const ValidatePayloadSchema = z.looseObject({
  valid: z.boolean(),
  error_count: z.number().int().nullable().optional(),
  warning_count: z.number().int().nullable().optional(),
  errors: z.array(DiagnosticSchema).nullable().optional(),
  warnings: z.array(DiagnosticSchema).nullable().optional(),
  spends_credits: z.boolean().nullable().optional(),
  converted_from_ui: z.boolean().nullable().optional(),
});

export type Diagnostic = z.infer<typeof DiagnosticSchema>;

export interface ValidationReport {
  valid: boolean;
  error_count: number;
  warning_count: number;
  /** Every error. There are few, and each one is the reason a run would fail. */
  errors: Diagnostic[];
  /** At most {@link MAX_WARNINGS}; `warning_count` is the true total. */
  warnings: Diagnostic[];
  warnings_truncated: boolean;
  /** Whether the CLI converted a UI-format workflow before checking it. */
  converted_from_ui: boolean;
  /** Whether running this graph would spend Comfy credits on partner nodes. */
  spends_credits: boolean;
}

/** The CLI answered, but not with a validation report. */
export class ValidatePayloadError extends Error {
  override readonly name = "ValidatePayloadError";

  constructor(data: unknown, cause: z.ZodError) {
    super(
      `comfy validate returned a payload this server could not read\n` +
        `  received: ${snippet(JSON.stringify(data) ?? String(data))}\n${z.prettifyError(cause)}`,
      { cause },
    );
  }
}

export interface ValidateOptions extends RunOptions {
  /**
   * A cached `/object_info` to check against, which is what makes this work
   * with ComfyUI stopped — and the only thing that works for a host that is not
   * on this machine, since the CLI refuses a non-loopback fetch as potential
   * SSRF (ground truth #24).
   */
  objectInfoPath: string;
}

/** Root flags first (landmine #3). `--skip-prompt` is `runComfyRaw`'s to prepend. */
function validateArgs(workflowPath: string, opts: ValidateOptions): string[] {
  return ["--json", "validate", "--workflow", workflowPath, "--input", opts.objectInfoPath];
}

/**
 * Check one workflow without submitting it.
 *
 * A workflow being invalid is a **successful answer**, not a failure: it comes
 * back as `valid: false` with the diagnostics, never as a thrown error. Only a
 * genuine CLI failure — an unreadable file, an unusable `--input` — throws.
 *
 * @throws {ComfyCliError} the CLI reported a real failure envelope.
 * @throws {ValidatePayloadError} the CLI's payload was not a validation report.
 * @throws {EnvelopeParseError} the CLI's output was not an envelope at all.
 */
export async function validateWorkflow(
  workflowPath: string,
  opts: ValidateOptions,
): Promise<ValidationReport> {
  const run = await runComfyRaw(validateArgs(workflowPath, opts), opts);
  const envelope = EnvelopeSchema.parse(JSON.parse(run.stdout));

  // The whole reason this module exists. `ok:false` means either "the workflow
  // is invalid" (error is null, data holds the report) or "the command failed"
  // (error is populated). Only the second is an error here.
  if (!envelope.ok && envelope.error) {
    throw new ComfyCliError(envelope.command, envelope.where, envelope.error);
  }

  const parsed = ValidatePayloadSchema.safeParse(envelope.data);
  if (!parsed.success) throw new ValidatePayloadError(envelope.data, parsed.error);

  const errors = parsed.data.errors ?? [];
  const warnings = parsed.data.warnings ?? [];
  return {
    valid: parsed.data.valid,
    // The CLI's own counts where it gives them, so a capped `warnings` array
    // never makes the total look smaller than it is.
    error_count: parsed.data.error_count ?? errors.length,
    warning_count: parsed.data.warning_count ?? warnings.length,
    errors,
    warnings: warnings.slice(0, MAX_WARNINGS),
    warnings_truncated: warnings.length > MAX_WARNINGS,
    converted_from_ui: parsed.data.converted_from_ui ?? false,
    spends_credits: parsed.data.spends_credits ?? false,
  };
}
