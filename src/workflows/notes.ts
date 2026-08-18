import { z } from "zod";
import { snippet } from "../comfy/envelope.ts";
import { ComfyCliError, runComfy } from "../comfy/exec.ts";

/**
 * `comfy workflow notes` lists the documentation a workflow carries on its own
 * canvas — the `Note` and `MarkdownNote` nodes its author wrote. This module is
 * the typed wrapper over that command.
 *
 * It is the answer to the question `validate_workflow` cannot answer. Validate
 * reports that a workflow names a model this host does not have; the author's
 * own note is what says where to download it, and what it will cost to run.
 *
 * Unlike `slots.ts`, this command needs no schema source: it reads the workflow
 * file and nothing else, so there is no host, no port, no `--input`, and no
 * fourth copy of `schemaSourceArgs`. Measured 2026-08-17 with no ComfyUI
 * running anywhere.
 */

/** The one error code this module says more about than the CLI does. */
const NOT_FRONTEND_FORMAT = "workflow_not_frontend_format";

/**
 * How many notes may be returned, and how much text each may carry.
 *
 * Note text is free-form markdown written by whoever authored the workflow —
 * for a gallery template, a stranger — and nothing in the file format or the
 * CLI bounds it. The largest payload measured on a real workflow is ~2.9KB
 * total, so these leave better than an order of magnitude of headroom while
 * still refusing to hand a caller an unbounded document.
 *
 * The same treatment `run.ts` gives CLI events (`MAX_EVENTS`), and for the same
 * reason: an unbounded third-party payload in a tool result floods the context
 * of whatever reads it.
 */
const MAX_NOTES = 24;
const MAX_NOTE_TEXT = 8_000;

/**
 * One canvas note.
 *
 * `type` is an open string, not an enum. `MarkdownNote` is the only value
 * observed, but the CLI's own help documents plain `Note` too, and upstream may
 * add more — the same append-only reasoning that keeps `error.code` an open
 * string in `comfy/envelope.ts`.
 *
 * `pos` and `size` are deliberately absent: the CLI sends them, zod strips
 * them, and canvas coordinates mean nothing to an MCP caller.
 *
 * `subgraph` is typed `unknown` because its populated shape has never been
 * observed. Every note measured carries `null`, and no workflow on hand has a
 * note inside a subgraph, so committing to a string id or a nested object would
 * be a guess. Carrying it opaquely costs nothing and cannot be wrong.
 */
export const NoteSchema = z.object({
  id: z.number(),
  type: z.string(),
  title: z.string(),
  /** The note's body, raw. Nothing is extracted from it — see the module doc. */
  text: z.string(),
  subgraph: z.unknown(),
});

export type Note = z.infer<typeof NoteSchema>;

const NotesPayloadSchema = z.object({
  workflow: z.string(),
  notes: z.array(NoteSchema),
});

export interface NoteListing {
  /** The workflow file as the CLI resolved it — absolute, whatever was passed. */
  workflow: string;
  /**
   * How many notes the workflow carries, BEFORE the cap.
   *
   * Deliberately unlike `SlotListing.count`, which is derived from the array it
   * returns. A capped listing has to be able to say how much it left out, and a
   * count that agreed with the array could not.
   */
  count: number;
  /** Whether the cap dropped a note or trimmed one's text. */
  truncated: boolean;
  notes: Note[];
}

export interface ListNotesOptions {
  /** Budget for the CLI call. Defaults to `runComfy`'s 120 seconds. */
  timeoutMs?: number;
}

/**
 * The CLI answered, but with something this server cannot read as a note
 * listing. Distinct from {@link ComfyCliError} on purpose, on the same
 * reasoning as `SlotListingParseError`: that is the CLI reporting a failure it
 * understood, this is a contract mismatch.
 */
export class NoteListingParseError extends Error {
  override readonly name = "NoteListingParseError";
  readonly workflowPath: string;

  constructor(workflowPath: string, data: unknown, cause: z.ZodError) {
    super(
      `comfy workflow notes returned a payload this server could not read for ${workflowPath}\n` +
        `  received: ${snippet(describe(data))}\n${z.prettifyError(cause)}`,
      { cause },
    );
    this.workflowPath = workflowPath;
  }
}

/** The payload came from `JSON.parse`, so it cannot be cyclic. */
function describe(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

/**
 * Word for word `slots.ts`'s guidance, because the CLI's own message is
 * generic — it says `comfy workflow`, not `comfy workflow slots` — and the fix
 * is identical. Duplicated rather than shared: the two modules are twins by
 * coincidence of the CLI's surface, not by contract, exactly as
 * `schemaSourceArgs` already is.
 */
function apiFormatGuidance(workflowPath: string): string {
  return (
    `${workflowPath} appears to be in API (prompt) format; \`comfy workflow notes\` reads only ` +
    `the frontend/UI format the ComfyUI editor saves — a graph with \`nodes\` and \`links\`.\n` +
    `In ComfyUI use Workflow → Export (not Export (API)), or point at the editor's own copy ` +
    `under user/default/workflows.`
  );
}

async function fetchPayload(workflowPath: string, opts: ListNotesOptions): Promise<unknown> {
  // No schema source: this command takes no --host/--port/--input at all.
  // `--skip-prompt` is runComfy's to prepend; adding it here would repeat it.
  const args = ["workflow", "notes", workflowPath];
  try {
    return await runComfy(args, { timeoutMs: opts.timeoutMs });
  } catch (err) {
    if (err instanceof ComfyCliError && err.code === NOT_FRONTEND_FORMAT) {
      // Rewritten in place rather than re-thrown, and under the same invariant
      // `slots.ts` documents: nothing may read `err.stack` between `runComfy`
      // throwing and this line.
      err.message = `${err.message}\n${apiFormatGuidance(workflowPath)}`;
    }
    throw err;
  }
}

/** Apply both caps, reporting whether either bit. */
function cap(notes: Note[]): { notes: Note[]; truncated: boolean } {
  const kept = notes.slice(0, MAX_NOTES);
  let truncated = kept.length < notes.length;
  const trimmed = kept.map((note) => {
    if (note.text.length <= MAX_NOTE_TEXT) return note;
    truncated = true;
    return { ...note, text: note.text.slice(0, MAX_NOTE_TEXT) };
  });
  return { notes: trimmed, truncated };
}

/**
 * The documentation one workflow carries on its canvas.
 *
 * @param workflowPath  the workflow file, in ComfyUI's frontend/UI format.
 * @throws {NoteListingParseError} the CLI's payload was not a note listing.
 * @throws {ComfyCliError} the CLI reported a failure; `workflow_not_frontend_format`
 * carries added guidance, every other code passes through as the CLI wrote it.
 * @throws {ComfyTimeoutError} the call exceeded `timeoutMs`.
 * @throws {ComfyUnavailableError} the `comfy` binary could not be started.
 */
export async function listNotes(
  workflowPath: string,
  opts: ListNotesOptions = {},
): Promise<NoteListing> {
  const data = await fetchPayload(workflowPath, opts);

  const result = NotesPayloadSchema.safeParse(data);
  if (!result.success) throw new NoteListingParseError(workflowPath, data, result.error);

  // The payload's own `count` is ignored in favour of the array's length, then
  // the cap is applied on top. The CLI's tally has never disagreed with its
  // array, but a caller iterating `notes` must not be able to see a different
  // number than `count` claims was there.
  const { notes, truncated } = cap(result.data.notes);
  return { workflow: result.data.workflow, count: result.data.notes.length, truncated, notes };
}
