import { z } from "zod";

/**
 * The `comfy` CLI prints exactly one `envelope/1` object per command in JSON
 * mode. This module is the single place that contract is decoded; every other
 * module consumes the discriminated union returned by {@link parseEnvelope}.
 */

/**
 * Thrown for every way the CLI can fail to hand us an envelope: no output,
 * unparseable output, or output that violates the contract. Callers can tell a
 * contract violation from a bug in their own code by checking for this type.
 */
export class EnvelopeParseError extends Error {
  override readonly name = "EnvelopeParseError";

  constructor(
    message: string,
    readonly raw: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export const ComfyErrorSchema = z.looseObject({
  code: z.string(), // NOT an enum — the CLI's code registry is append-only.
  message: z.string(),
  hint: z.string().nullable().optional(),
  // Inert at runtime: `unknown` rejects nothing and looseObject passes
  // undeclared keys through anyway, so no test can pin this line. It stays as
  // documentation of the contract and to keep the field available to schema
  // composition (.pick / .extend / .partial). Do not delete it as dead weight.
  details: z.unknown().nullable().optional(),
});

export const EnvelopeSchema = z.object({
  schema: z.literal("envelope/1"),
  type: z.literal("envelope"),
  ok: z.boolean(),
  command: z.string(),
  version: z.string(), // "0.0.0" is legitimate for a source-tree install.
  where: z.string().nullable(),
  data: z.unknown().nullable(),
  error: ComfyErrorSchema.nullable(),
});

export type Envelope = z.infer<typeof EnvelopeSchema>;
export type ComfyError = z.infer<typeof ComfyErrorSchema>;

export type ParsedEnvelope =
  | { ok: true; command: string; data: unknown }
  | { ok: false; command: string; where: string | null; error: ComfyError };

/** How much of an offending payload to quote back in an error message. */
const SNIPPET_LIMIT = 200;

export function snippet(raw: string): string {
  return raw.length <= SNIPPET_LIMIT ? raw : `${raw.slice(0, SNIPPET_LIMIT)}…`;
}

function describe(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new EnvelopeParseError(
      `comfy CLI output was not valid JSON: ${reason} (received: ${snippet(raw)})`,
      raw,
      { cause },
    );
  }
}

/**
 * Decode a value expected to be an envelope. `raw` is the text the value came
 * from; it is quoted back in error messages so the operator sees exactly what
 * the CLI emitted.
 */
function decode(value: unknown, raw: string): ParsedEnvelope {
  const result = EnvelopeSchema.safeParse(value);
  if (!result.success) {
    throw new EnvelopeParseError(
      `comfy CLI output did not match the envelope/1 contract ` +
        `(received: ${snippet(raw)}):\n${z.prettifyError(result.error)}`,
      raw,
      { cause: result.error },
    );
  }

  const env = result.data;
  if (env.ok) return { ok: true, command: env.command, data: env.data };
  if (!env.error) {
    throw new EnvelopeParseError(
      // Quotes `raw` like every sibling message: without it this is the one
      // EnvelopeParseError whose text never shows what arrived.
      `envelope ok:false with no error object (command: ${env.command}) ` +
        `(received: ${snippet(raw)})`,
      raw,
    );
  }
  return { ok: false, command: env.command, where: env.where, error: env.error };
}

/** Decode an already-parsed JSON value, e.g. one line of an NDJSON stream. */
export function parseEnvelopeValue(value: unknown): ParsedEnvelope {
  return decode(value, describe(value));
}

/** Decode the complete stdout of one `comfy` command in JSON mode. */
export function parseEnvelope(raw: string): ParsedEnvelope {
  if (raw.trim() === "") {
    throw new EnvelopeParseError("comfy CLI produced no output", raw);
  }
  return decode(parseJson(raw), raw);
}
