import { z } from "zod";
import { snippet } from "./envelope.ts";
import { runComfy, type RunOptions } from "./exec.ts";

/**
 * `comfy templates`, the curated workflow gallery — 578 entries as of
 * 2026-08-12, and the only workflow-creation surface in comfy-cli whose output
 * this server can actually use. `templates fetch` writes **frontend format**,
 * which is what `comfy workflow slots` reads, so a fetched template is an
 * ordinary local workflow and needs no new pipeline.
 *
 * Three things shape this module.
 *
 * - **A filter is mandatory, and `--limit` is not optional either.** The
 *   unfiltered listing is 200,675 bytes over 578 rows (199,382 over 574 when
 *   this was written — the gallery grows, so treat the figure as a magnitude).
 *   An MCP tool result goes into a context window, so the cap belongs in the
 *   argv, not in a `.slice()` after the bytes have already crossed the pipe.
 *   `--limit 5` measures 2,072 bytes for the same query, unchanged across that
 *   growth because the cap binds before the rows do.
 * - **`output_type` is `category_title` restated, and this module must not try
 *   to fix that.** Cardinality is exactly 1 within every category and five of
 *   the eight collapse to `image`, so 47 of the 103 `Use Cases` templates are
 *   typed `image` while producing video. Deriving the real answer means reading
 *   each workflow's output nodes, which is a separate network fetch per
 *   template — 578 downloads to answer one filtered query — and at fetch time,
 *   where the graph is already on disk, it would mean `JSON.parse` on a
 *   workflow graph inside this server, which non-negotiable #1 forbids. The
 *   field is echoed unchanged and the tool description says what it really is.
 *   See ground truth #28/#29.
 * - **`--query` is advertised and does not work.** `templates ls --help`
 *   documents a CQL grammar; invoking it returns `cql_query_invalid`, "CQL
 *   grammar queries are not available." It is never passed, and no caller is
 *   offered it.
 *
 * `templates` accepts no `--host`/`--port`: the gallery is not a property of
 * any ComfyUI. Nothing here contacts an instance or starts one.
 */

const JSON_MODE = "--json";

/** What a caller may ask for. Every field optional; the tool layer requires one. */
export interface TemplateFilters {
  type?: string;
  category?: string;
  tag?: string;
  model?: string;
  provider?: string;
  name?: string;
  limit?: number;
}

export const DEFAULT_TEMPLATE_LIMIT = 20;
/**
 * The ceiling. 50 rows of the real gallery measures well under 20 KB, and the
 * cap exists so a caller cannot ask for the 199 KB answer one row at a time.
 */
export const MAX_TEMPLATE_LIMIT = 50;

/** How much of a description survives. Full text is one `templates show` away. */
const MAX_DESCRIPTION = 200;

export interface TemplateRow {
  name: string;
  title: string | null;
  output_type: string | null;
  category_title: string | null;
  tags: string[];
  models: string[];
  description: string | null;
}

export interface TemplateListing {
  total_in_gallery: number | null;
  matched: number | null;
  shown: number;
  /** Whether the gallery matched more than this answer carries. */
  truncated: boolean;
  rows: TemplateRow[];
}

/**
 * Every field but `name` is optional and nullable, and the object is loose.
 * Non-negotiable #2: these registries are append-only upstream, and a schema
 * that closes one breaks this server on the next CLI release rather than
 * carrying a field it does not yet know about.
 */
const TemplateRowSchema = z.looseObject({
  name: z.string(),
  title: z.string().nullable().optional(),
  output_type: z.string().nullable().optional(),
  category_title: z.string().nullable().optional(),
  tags: z.array(z.string()).nullable().optional(),
  models: z.array(z.string()).nullable().optional(),
  description: z.string().nullable().optional(),
});

const TemplateListPayloadSchema = z.looseObject({
  rows: z.array(TemplateRowSchema),
  total_in_gallery: z.number().int().nullable().optional(),
  matched: z.number().int().nullable().optional(),
  shown: z.number().int().nullable().optional(),
});

/**
 * The CLI answered, but not with its own contract — distinct from the CLI
 * saying no, because the fixes differ. Modelled on `jobs.ts`'s
 * `JobPayloadError`, and classified the same way.
 */
export class TemplatesPayloadError extends Error {
  override readonly name = "TemplatesPayloadError";
  /** The failing command as the CLI names it, e.g. `"templates ls"`. */
  readonly command: string;

  constructor(command: string, data: unknown, cause: z.ZodError) {
    super(
      `comfy ${command} returned a payload this server could not read\n` +
        `  received: ${snippet(JSON.stringify(data) ?? String(data))}\n${z.prettifyError(cause)}`,
      { cause },
    );
    this.command = command;
  }
}

/** Root flags first (landmine #3). `--skip-prompt` is `runComfy`'s to prepend. */
function listArgs(filters: TemplateFilters): string[] {
  const args = [JSON_MODE, "templates", "ls"];
  // Order is fixed rather than driven by Object.keys so a test can assert on
  // the whole tail rather than on membership.
  const pairs: ReadonlyArray<readonly [string, string | undefined]> = [
    ["--type", filters.type],
    ["--category", filters.category],
    ["--tag", filters.tag],
    ["--model", filters.model],
    ["--provider", filters.provider],
    ["--name", filters.name],
  ];
  for (const [flag, value] of pairs) {
    if (value !== undefined) args.push(flag, value);
  }
  args.push("--limit", String(clampLimit(filters.limit)));
  return args;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_TEMPLATE_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_TEMPLATE_LIMIT);
}

function truncate(text: string | null | undefined): string | null {
  if (text === undefined || text === null) return null;
  return text.length <= MAX_DESCRIPTION ? text : `${text.slice(0, MAX_DESCRIPTION)}…`;
}

/**
 * Search the gallery.
 *
 * @throws {TemplatesPayloadError} the CLI's payload was not a template listing.
 * @throws {ComfyCliError} the CLI reported a failure envelope.
 */
export async function searchTemplates(
  filters: TemplateFilters,
  opts: RunOptions = {},
): Promise<TemplateListing> {
  const data = await runComfy(listArgs(filters), opts);
  const result = TemplateListPayloadSchema.safeParse(data);
  if (!result.success) throw new TemplatesPayloadError("templates ls", data, result.error);

  const rows = result.data.rows.map((row): TemplateRow => ({
    name: row.name,
    title: row.title ?? null,
    output_type: row.output_type ?? null,
    category_title: row.category_title ?? null,
    tags: row.tags ?? [],
    models: row.models ?? [],
    description: truncate(row.description),
  }));

  const matched = result.data.matched ?? null;
  const shown = result.data.shown ?? rows.length;
  return {
    total_in_gallery: result.data.total_in_gallery ?? null,
    matched,
    shown,
    // `matched` is the CLI's own pre-cap count, so this is a fact rather than
    // an inference. Deriving it from `rows.length >= limit` instead is wrong
    // exactly when matched equals the limit — see the fixture built for it.
    truncated: matched !== null && matched > shown,
    rows,
  };
}

/** What `templates fetch` reports about what it wrote. */
export interface FetchedTemplate {
  name: string;
  title: string | null;
  output_type: string | null;
  bytes: number | null;
  path: string;
}

const FetchPayloadSchema = z.looseObject({
  name: z.string().optional(),
  title: z.string().nullable().optional(),
  output_type: z.string().nullable().optional(),
  bytes: z.number().int().nullable().optional(),
});

/**
 * Refuse a value that would be read as a flag.
 *
 * The template name travels as a **positional** argument, ahead of `-o`. A
 * value starting with `-` is taken by the CLI's own parser as an option
 * instead — measured in this project before, where a slot address of
 * `--input` smuggled in a caller-chosen file. `promptIdArgument` and
 * `encodePair` guard the same hazard in their own modules; this is the third.
 *
 * @throws {Error} the value would be parsed as a flag.
 */
export function assertNotFlag(what: string, value: string): void {
  if (value.startsWith("-")) {
    throw new Error(
      `a ${what} cannot start with \`-\` (${JSON.stringify(value)}): it is passed to comfy as a ` +
        "positional argument and would be read as a flag.",
    );
  }
}

/**
 * Fetch one gallery template to `destination`, which must be absolute.
 *
 * The bytes are never read here. `comfy` writes the file and the existing
 * pipeline reads it; this function only reports what was written.
 *
 * @throws {Error} the template name would be read as a flag.
 * @throws {TemplatesPayloadError} the CLI's payload was not a fetch report.
 * @throws {ComfyCliError} the CLI reported a failure envelope, e.g. `template_not_found`.
 */
export async function fetchTemplate(
  template: string,
  destination: string,
  opts: RunOptions = {},
): Promise<FetchedTemplate> {
  assertNotFlag("template name", template);
  const data = await runComfy(
    [JSON_MODE, "templates", "fetch", template, "-o", destination],
    opts,
  );
  const result = FetchPayloadSchema.safeParse(data);
  if (!result.success) throw new TemplatesPayloadError("templates fetch", data, result.error);
  return {
    name: result.data.name ?? template,
    title: result.data.title ?? null,
    output_type: result.data.output_type ?? null,
    bytes: result.data.bytes ?? null,
    path: destination,
  };
}
