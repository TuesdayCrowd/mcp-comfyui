import { afterEach, beforeEach, expect, test } from "./support/testing.ts";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComfyCliError } from "../src/comfy/exec.ts";
import { NoteListingParseError, listNotes } from "../src/workflows/notes.ts";

/** No test here may invoke a real `comfy`: COMFY_BIN points at the sh fixture. */
const FAKE_COMFY = join(import.meta.dirname, "fixtures", "fake-comfy");

/** Real captured `data` from `comfy workflow notes` against a real workflow. */
const CAPTURED = join(import.meta.dirname, "fixtures", "notes.video_wan2_2_14B_i2v.json");

let workdir: string;
let argvOut: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "mcp-comfyui-notes-"));
  argvOut = join(workdir, "argv");
  process.env.COMFY_BIN = FAKE_COMFY;
  process.env.FAKE_COMFY_ARGV_OUT = argvOut;
  servePayloadFile(CAPTURED);
});

afterEach(() => {
  delete process.env.COMFY_BIN;
  delete process.env.FAKE_COMFY_MODE;
  delete process.env.FAKE_COMFY_ARGV_OUT;
  delete process.env.FAKE_COMFY_DATA_FILE;
  delete process.env.FAKE_COMFY_ERROR_CODE;
  delete process.env.FAKE_COMFY_ERROR_MESSAGE;
  delete process.env.FAKE_COMFY_NOTES_FILE;
  delete process.env.FAKE_COMFY_NOTES_MODE;
  rmSync(workdir, { recursive: true, force: true });
});

function servePayloadFile(path: string): void {
  process.env.FAKE_COMFY_MODE = "data_file";
  process.env.FAKE_COMFY_DATA_FILE = path;
}

function servePayload(data: unknown): void {
  const path = join(workdir, "payload.json");
  writeFileSync(path, JSON.stringify(data));
  servePayloadFile(path);
}

function serveFailure(code: string, message: string): void {
  process.env.FAKE_COMFY_MODE = "fail_code";
  process.env.FAKE_COMFY_ERROR_CODE = code;
  process.env.FAKE_COMFY_ERROR_MESSAGE = message;
}

/** One note, with every field overridable. */
function note(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 1, type: "MarkdownNote", title: "T", text: "body", subgraph: null, ...over };
}

test("decodes a real capture, keeping the markdown byte-exact", async () => {
  const listing = await listNotes("/w/flow.json");
  const captured = JSON.parse(readFileSync(CAPTURED, "utf8"));

  expect(listing.count).toBe(captured.notes.length);
  expect(listing.truncated).toBe(false);
  expect(listing.notes.length).toBe(captured.notes.length);
  // The text is what the whole feature exists to carry. Byte-exact, newlines
  // and markdown tables included.
  expect(listing.notes[0]?.text).toBe(captured.notes[0].text);
  expect(listing.notes.some((n) => n.text.includes("huggingface.co"))).toBe(true);
});

test("a note type absent from today's vocabulary is carried, not refused", async () => {
  // Non-negotiable #2. The CLI's own help documents a plain `Note` node this
  // machine has no example of, and upstream may add more. A closed enum here
  // breaks the server on the release that adds one. Hand-built, because a
  // healthy install cannot produce a type that has not shipped yet.
  servePayload({ workflow: "/w/flow.json", count: 1, notes: [note({ type: "HoloNote" })] });

  const listing = await listNotes("/w/flow.json");

  expect(listing.notes[0]?.type).toBe("HoloNote");
});

test("a note that carries no subgraph key at all is decoded, not refused", async () => {
  // Non-negotiable #2 again, for a field rather than a value. `subgraph` is
  // typed permissively BECAUSE its populated shape has never been observed —
  // but `z.unknown()` is permissive about the value and strict about the KEY,
  // so a CLI release that stops emitting it would turn every workflow's notes
  // into `notes_unreadable`. Hand-built, because today's build always sends it.
  //
  // Mutant: drop `.optional()` from `NoteSchema.subgraph`. This test dies with
  // "expected nonoptional, received undefined".
  const bare = { id: 7, type: "MarkdownNote", title: "T", text: "body" };
  servePayload({ workflow: "/w/flow.json", count: 1, notes: [bare] });

  const listing = await listNotes("/w/flow.json");

  expect(listing.notes[0]?.title).toBe("T");
  expect(listing.notes[0]?.subgraph).toBeUndefined();
});

test("a workflow with no notes is an empty listing, not a failure", async () => {
  servePayload({ workflow: "/w/flow.json", count: 0, notes: [] });

  const listing = await listNotes("/w/flow.json");

  expect(listing.count).toBe(0);
  expect(listing.notes).toEqual([]);
  expect(listing.truncated).toBe(false);
});

test("too many notes are capped, and count still reports the true total", async () => {
  const many = Array.from({ length: 25 }, (_, i) => note({ id: i })); // MAX_NOTES is 24
  servePayload({ workflow: "/w/flow.json", count: many.length, notes: many });

  const listing = await listNotes("/w/flow.json");

  // The exact boundary, not merely "fewer": `toBeLessThan` survives a
  // `MAX_NOTES = 5` mutant, and the cap is a promise about how much a caller's
  // context can be filled.
  expect(listing.notes.length).toBe(24);
  expect(listing.count).toBe(many.length);
  expect(listing.truncated).toBe(true);
});

test("an oversized note's text is trimmed, and the listing says so", async () => {
  servePayload({
    workflow: "/w/flow.json",
    count: 1,
    notes: [note({ text: "x".repeat(50_000) })],
  });

  const listing = await listNotes("/w/flow.json");

  // MAX_NOTE_TEXT exactly, for the same reason as the note count above.
  expect(listing.notes[0]!.text.length).toBe(8_000);
  expect(listing.truncated).toBe(true);
});

test("api-format guidance is added to workflow_not_frontend_format", async () => {
  serveFailure("workflow_not_frontend_format", "not a frontend workflow");

  const err = await listNotes("/w/api.json").catch((e) => e);

  expect(err).toBeInstanceOf(ComfyCliError);
  expect((err as ComfyCliError).code).toBe("workflow_not_frontend_format");
  expect((err as Error).message).toContain("Export (API)");
});

test("every other CLI code passes through untouched", async () => {
  serveFailure("workflow_not_found", "no such file");

  const err = await listNotes("/w/missing.json").catch((e) => e);

  expect(err).toBeInstanceOf(ComfyCliError);
  expect((err as ComfyCliError).code).toBe("workflow_not_found");
});

test("a payload that is not a note listing throws a parse error naming the file", async () => {
  servePayload({ workflow: "/w/flow.json", count: 1, notes: [{ id: "not-a-number" }] });

  const err = await listNotes("/w/flow.json").catch((e) => e);

  expect(err).toBeInstanceOf(NoteListingParseError);
  expect((err as Error).message).toContain("/w/flow.json");
});

test("global flags precede the subcommand, and no schema source is sent", async () => {
  await listNotes("/w/flow.json");

  const argv = readFileSync(argvOut, "utf8").trim();
  expect(argv).toBe("--skip-prompt workflow notes /w/flow.json");
});

test("the dispatcher answers a notes call from its own file, not the slots one", async () => {
  // describe_workflow makes both calls in one tool call. The dispatcher picks
  // the mode per subcommand; notes needs its own file variable so it cannot
  // collide with the $FAKE_COMFY_DATA_FILE that `slots` is armed with.
  const notesFile = join(workdir, "notes.json");
  writeFileSync(notesFile, JSON.stringify({ workflow: "/w/f.json", notes: [note({ title: "N" })] }));
  process.env.COMFY_BIN = join(import.meta.dirname, "fixtures", "fake-comfy-dispatch");
  process.env.FAKE_COMFY_NOTES_FILE = notesFile;
  servePayloadFile(CAPTURED); // `slots` would still get the capture, via data_file

  const listing = await listNotes("/w/f.json");

  expect(listing.count).toBe(1);
  expect(listing.notes[0]?.title).toBe("N");
});

test("an unarmed notes call is an empty listing, not a fixture error", async () => {
  // The default has to be a state a real workflow can be in. A workflow with
  // no notes is ordinary; a `fixture_missing` failure would make every
  // existing describe_workflow test start reporting notes_unreadable.
  process.env.COMFY_BIN = join(import.meta.dirname, "fixtures", "fake-comfy-dispatch");
  delete process.env.FAKE_COMFY_NOTES_FILE;

  const listing = await listNotes("/w/f.json");

  expect(listing.count).toBe(0);
  expect(listing.notes).toEqual([]);
});
