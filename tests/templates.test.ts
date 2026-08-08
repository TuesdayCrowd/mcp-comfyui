import { afterEach, beforeEach, expect, test } from "./support/testing.ts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_TEMPLATE_LIMIT,
  MAX_TEMPLATE_LIMIT,
  searchTemplates,
} from "../src/comfy/templates.ts";

const FAKE_COMFY = join(import.meta.dirname, "fixtures", "fake-comfy");
const LIMIT5 = join(import.meta.dirname, "fixtures", "templates.video-limit5.json");
const EXACT = join(import.meta.dirname, "fixtures", "templates.exact-limit.json");
const EXOTIC_TYPE = join(import.meta.dirname, "fixtures", "templates.exotic-output-type.json");
const LONG_DESCRIPTION = join(import.meta.dirname, "fixtures", "templates.long-description.json");

/**
 * `RunOptions` is `{timeoutMs?, cwd?}` — there is no `env` option, because
 * `exec.ts` passes `process.env` to every spawn explicitly (landmine #17).
 * So the fixture is selected by mutating `process.env` and cleaning up after,
 * exactly as `tests/jobs.test.ts` does.
 */
const FIXTURE_ENV = [
  "COMFY_BIN",
  "FAKE_COMFY_MODE",
  "FAKE_COMFY_TEMPLATES_FILE",
  "FAKE_COMFY_ARGV_OUT",
];

let workdir: string;
let argvOut: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "mcp-comfyui-templates-"));
  argvOut = join(workdir, "argv");
  process.env.COMFY_BIN = FAKE_COMFY;
  process.env.FAKE_COMFY_MODE = "templates_ls";
  process.env.FAKE_COMFY_TEMPLATES_FILE = LIMIT5;
  process.env.FAKE_COMFY_ARGV_OUT = argvOut;
});

afterEach(() => {
  for (const key of FIXTURE_ENV) delete process.env[key];
  rmSync(workdir, { recursive: true, force: true });
});

test("global flags precede the subcommand and --limit reaches the CLI", async () => {
  await searchTemplates({ type: "video", limit: 5 });
  const argv = readFileSync(argvOut, "utf8").trim().split(/\s+/);
  expect(argv.indexOf("--json")).toBeLessThan(argv.indexOf("templates"));
  expect(argv.slice(argv.indexOf("templates"))).toEqual([
    "templates", "ls", "--type", "video", "--limit", "5",
  ]);
});

test("--query is never passed: the CLI advertises it and it does not work", async () => {
  await searchTemplates({ name: "wan", limit: 3 });
  expect(readFileSync(argvOut, "utf8")).not.toContain("--query");
});

test("an omitted filter contributes no flag", async () => {
  await searchTemplates({ type: "video" });
  const argv = readFileSync(argvOut, "utf8");
  for (const flag of ["--category", "--tag", "--model", "--provider", "--name"]) {
    expect(argv).not.toContain(flag);
  }
});

test("truncated is matched > shown, not rows.length >= limit", async () => {
  // The degenerate fixture: matched === shown === limit === 5. The correct
  // rule says false; the mutant `rows.length >= limit` says true.
  process.env.FAKE_COMFY_TEMPLATES_FILE = EXACT;
  const listing = await searchTemplates({ type: "video", limit: 5 });
  expect(listing.matched).toBe(5);
  expect(listing.shown).toBe(5);
  expect(listing.truncated).toBe(false);
});

test("truncated is true when the gallery matched more than it showed", async () => {
  const listing = await searchTemplates({ type: "video", limit: 5 });
  expect(listing.matched).toBe(156);
  expect(listing.shown).toBe(5);
  expect(listing.truncated).toBe(true);
});

test("an output_type absent from today's vocabulary is carried, not refused", async () => {
  // Non-negotiable #2: the CLI's registries are append-only. A zod enum here
  // would break this server on the release that adds a fifth output kind.
  // The gallery itself never emits a row like this today, so the fixture is
  // hand-built rather than captured — the same reasoning as the exact-limit
  // fixture: a real capture cannot reach a degenerate case that has not
  // shipped yet.
  process.env.FAKE_COMFY_TEMPLATES_FILE = EXOTIC_TYPE;
  const listing = await searchTemplates({ type: "video" });
  expect(listing.rows.length).toBeGreaterThan(0);
  expect(listing.rows[0]?.output_type).toBe("hologram");
});

test("limit is clamped to MAX_TEMPLATE_LIMIT", async () => {
  await searchTemplates({ type: "video", limit: 9999 });
  expect(readFileSync(argvOut, "utf8")).toContain(`--limit ${MAX_TEMPLATE_LIMIT}`);
});

test("an absent limit sends the default rather than no flag", async () => {
  await searchTemplates({ type: "video" });
  expect(readFileSync(argvOut, "utf8")).toContain(`--limit ${DEFAULT_TEMPLATE_LIMIT}`);
});

test("descriptions are truncated so 574 rows cannot fill a context window", async () => {
  // The real gallery's descriptions are short (120 chars in every captured
  // fixture), so no real capture reaches the 200-char cap — this fixture is
  // hand-built, on the same reasoning as exact-limit.json and
  // exotic-output-type.json: rule-shaped code needs an adversarial input a
  // healthy install cannot produce.
  process.env.FAKE_COMFY_TEMPLATES_FILE = LONG_DESCRIPTION;
  const listing = await searchTemplates({ type: "video", limit: 5 });

  // Over the cap: cut to exactly 200 chars plus one ellipsis character.
  const over = listing.rows[0]?.description;
  expect(over).not.toBeNull();
  expect(over?.length).toBe(201);
  expect(over?.endsWith("…")).toBe(true);

  // At the cap, exactly: untouched, and no ellipsis appended. This is the
  // boundary an off-by-one in `text.length <= MAX_DESCRIPTION` would miss.
  const atCap = listing.rows[1]?.description;
  expect(atCap).toBe("y".repeat(200));
  expect(atCap?.length).toBe(200);
  expect(atCap?.endsWith("…")).toBe(false);
});
