# Workflow creation from the template gallery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an MCP client find a workflow for a task in comfy-cli's 574-template gallery and materialise it as a local file the existing `describe_workflow` → `run_workflow` pipeline reads unchanged.

**Architecture:** One new module, `src/comfy/templates.ts`, wraps `comfy templates ls` and `comfy templates fetch` and decodes their envelopes. `src/config.ts` gains a created-workflows directory appended last to `workflowRoots()`. `src/tools.ts` registers two tools. Nothing reads or writes a workflow graph: the CLI fetches the file, the existing pipeline reads it.

**Tech Stack:** Deno 2 (tests, bundle), TypeScript, zod 4, `@modelcontextprotocol/sdk` 1.30.0, `node:child_process` via `src/comfy/exec.ts`. Tests run under `deno task test` against `tests/fixtures/fake-comfy`, a dependency-free POSIX `sh` script.

**Design doc:** `docs/plans/2026-08-07-workflow-creation-design.md`. Read it first; it carries the measurements behind every decision here.

## Global Constraints

- **Never let JS parse or re-serialise a workflow graph.** No code in this plan opens a workflow file. Assertions about fetched bytes use a digest or `grep`, never `JSON.parse`.
- **Every registry from the CLI is an open string.** `type`, `category`, `tag`, `output_type` are `z.string()`, never a zod enum. Payload schemas are `z.looseObject`, so undeclared fields survive.
- **Branch on the envelope, never the exit code.** Decode through `runComfy`; never inspect exit status.
- **Global flags precede the subcommand.** `comfy --json templates ls …`. `--skip-prompt` is prepended by `runComfy` — do not add it.
- **stdout is the MCP protocol.** No `console.log` anywhere. Diagnostics go to stderr.
- **`comfy templates` takes no `--host`/`--port`.** Neither tool accepts a `host` argument, and neither calls `ensureRunning`.
- **Never run two `deno test` invocations at once.** They contend, budgets blow, and you will diagnose your own contention as a defect.
- **Fixture modes in `tests/fixtures/fake-comfy` are append-only.** Add new `case` arms; never edit an existing one.
- Commit with `but commit -b <branch> -m "…"`, never `git commit`. The branch for this work is `workflow-creation`.

## Review findings folded into this plan

The design doc is sound but leaves five things unspecified that would bite an implementer. Each is closed by a task below.

| Gap | Where it bites | Closed in |
|---|---|---|
| `as` is called a "filename stem" but never validated. `as: "../../../evil"` escapes the created root. | Task 6 | `assertPlainStem` |
| `template` reaches the CLI as a **positional**. A value starting with `-` is parsed as a flag — this repo has already hit that class of bug live (`promptIdArgument`, `encodePair`). | Task 5 | `assertNotFlag` |
| `limit` is described as "caps rows returned" without saying where. Applied locally it saves no bytes — the 199 KB still crosses the pipe. | Task 1 | `--limit` in argv |
| No payload schema is specified, so nothing enforces non-negotiable #2. | Task 1 | `z.looseObject` schemas |
| Tests would write to the operator's real `~/.local/share/mcp-comfyui/workflows`. | Tasks 3, 6 | `MCP_COMFYUI_CREATED_DIR` into a temp dir |

One correction to the design doc: it says "No new arms in `toolResult.ts`." That is right about `kind`s — no new one is needed — but `TemplatesPayloadError` must be added to the existing `contract_violation` union at `src/toolResult.ts:382-386`, which is one line. Task 1 does it.

---

## Task 1: `templates.ts` — the search wrapper

**Files:**
- Create: `src/comfy/templates.ts`
- Modify: `src/toolResult.ts` (import + one line in the `contract_violation` union at 382-386)
- Modify: `tests/fixtures/fake-comfy` (append one mode)
- Test: `tests/templates.test.ts`

**Interfaces:**
- Consumes: `runComfy` from `src/comfy/exec.ts`; `snippet` from `src/comfy/envelope.ts`.
- Produces: `searchTemplates(filters: TemplateFilters): Promise<TemplateListing>`, `TemplateFilters`, `TemplateRow`, `TemplateListing`, `TemplatesPayloadError`, `MAX_TEMPLATE_LIMIT`, `DEFAULT_TEMPLATE_LIMIT`.

- [ ] **Step 1: Append the `templates_ls` fixture mode**

In `tests/fixtures/fake-comfy`, add to the header comment block:

```sh
#   $FAKE_COMFY_TEMPLATES_FILE     templates_ls: JSON file served as data
```

Then append a new `case` arm immediately **before** the final `*)` default arm:

```sh
  templates_ls)
    # `comfy templates ls`, serving a captured gallery response as data.
    # Modelled on data_file rather than on jobs: `templates` needs no
    # subcommand dispatch here, because only `ls` is served by this mode.
    printf '{"schema":"envelope/1","type":"envelope","ok":true,"command":"templates","version":"0.0.0","where":null,"data":'
    cat "$FAKE_COMFY_TEMPLATES_FILE"
    printf ',"error":null}\n'
    exit 0 ;;
```

- [ ] **Step 2: Capture the fixture payload**

```bash
mkdir -p tests/fixtures
comfy --json --skip-prompt templates ls --type video --limit 5 \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(JSON.parse(s).data,null,1)))' \
  > tests/fixtures/templates.video-limit5.json
```

Verify it holds `total_in_gallery`, `matched`, `shown`, `filters`, `rows` and that `rows` has 5 entries. This is a real capture, not a hand-written one.

Then hand-build the degenerate case the mutation test needs — real fixtures cannot reach it:

```bash
node -e '
const fs=require("fs");
const d=JSON.parse(fs.readFileSync("tests/fixtures/templates.video-limit5.json","utf8"));
// matched === limit === shown: the ONLY case where `matched > shown` and
// `rows.length >= limit` disagree. Correct rule -> false, mutant -> true.
d.matched = 5;
fs.writeFileSync("tests/fixtures/templates.exact-limit.json", JSON.stringify(d,null,1));
'
```

- [ ] **Step 3: Write the failing tests**

Create `tests/templates.test.ts`:

```ts
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
  const listing = await searchTemplates({ type: "hologram" });
  expect(listing.rows.length).toBeGreaterThan(0);
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
  const listing = await searchTemplates({ type: "video", limit: 5 });
  for (const row of listing.rows) {
    if (row.description !== null) expect(row.description.length).toBeLessThanOrEqual(201);
  }
});
```

- [ ] **Step 4: Run the tests and verify they fail**

Run: `deno task test:one tests/templates.test.ts`
Expected: FAIL — `Module not found "…/src/comfy/templates.ts"`.

- [ ] **Step 5: Write `src/comfy/templates.ts`**

```ts
import { z } from "zod";
import { snippet } from "./envelope.ts";
import { runComfy, type RunOptions } from "./exec.ts";

/**
 * `comfy templates`, the curated workflow gallery — 574 entries at the time of
 * writing, and the only workflow-creation surface in comfy-cli whose output
 * this server can actually use. `templates fetch` writes **frontend format**,
 * which is what `comfy workflow slots` reads, so a fetched template is an
 * ordinary local workflow and needs no new pipeline.
 *
 * Two things shape this module.
 *
 * - **A filter is mandatory, and `--limit` is not optional either.** The
 *   unfiltered listing is 199,382 bytes over 574 rows. An MCP tool result goes
 *   into a context window, so the cap belongs in the argv, not in a `.slice()`
 *   after the bytes have already crossed the pipe. `--limit 5` measures 2,072
 *   bytes for the same query.
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
```

- [ ] **Step 6: Classify the new error**

In `src/toolResult.ts`, add the import alongside the other comfy imports:

```ts
import { TemplatesPayloadError } from "./comfy/templates.ts";
```

and add one line to the existing union at 382-386, keeping alphabetical-by-nothing insertion order consistent with its neighbours:

```ts
    err instanceof JobPayloadError ||
    err instanceof TemplatesPayloadError
  ) {
    return { kind: "contract_violation", message: err.message };
  }
```

- [ ] **Step 7: Run the tests and verify they pass**

Run: `deno task test:one tests/templates.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 8: Type-check**

Run: `deno task typecheck`
Expected: zero errors. This is the authoritative compile gate; `deno check` has a known false-positive gap here.

- [ ] **Step 9: Kill the mutants**

Apply each mutation, confirm the named test fails, then restore:

1. In `listArgs`, drop the `--limit` push entirely → "an absent limit sends the default" must fail.
2. In `searchTemplates`, change `truncated` to `rows.length >= clampLimit(filters.limit)` → "truncated is matched > shown" must fail.
3. Change `TemplateRowSchema`'s `output_type` to `z.enum(["image","video","audio","3d"])` → the open-string test must fail.

Restore by checksum afterwards. An interrupted mutation run that leaves a mutant applied has happened in this repo.

- [ ] **Step 10: Commit**

```bash
but commit -b workflow-creation -m "feat(templates): wrap comfy templates ls

Filters and a mandatory --limit go to the CLI, not to a local slice: the
unfiltered listing is 199,382 bytes and --limit 5 is 2,072. --query is never
passed; the CLI advertises a CQL grammar and returns cql_query_invalid.

Payload schemas are looseObject with open-string registries per
non-negotiable #2."
```

---

## Task 2: `search_templates` tool

**Files:**
- Modify: `src/tools.ts` (imports; one `server.registerTool` block)
- Test: `tests/tools.test.ts` (append)

**Interfaces:**
- Consumes: `searchTemplates`, `TemplateFilters`, `DEFAULT_TEMPLATE_LIMIT`, `MAX_TEMPLATE_LIMIT` from Task 1.
- Produces: the `search_templates` MCP tool. No exported symbols.

- [ ] **Step 1: Write the failing tests**

Append to `tests/tools.test.ts`. That file already has the two helpers these need — `connect(config: ToolConfig): Promise<Client>` and `textOf(result: CallToolResult): string` — and `baseConfig(overrides)` to build the config. Use them; do not add new ones. Add `LIMIT5` as a module constant beside `SLOTS_SAMPLE`.

Note the two different failure shapes in this codebase: a **schema** rejection sets `result.isError` and puts the SDK's own message in the text, while a **handler** throw goes through `toolAnswer` → `toolFailure` and puts `{"error": {"kind": …}}` in the text with `isError` also set. `requireOneFilter` throws in the handler, so these assert the second shape.

```ts
test("search_templates refuses a call with no filter, without spawning", async () => {
  const client = await connect(baseConfig());
  const result = (await client.callTool({
    name: "search_templates",
    arguments: {},
  })) as CallToolResult;

  const body = JSON.parse(textOf(result));
  expect(body.error.kind).toBe("invalid_input");
  expect(body.error.message).toContain("at least one");
  // The refusal must beat the subprocess: the fixture never ran, so it never
  // wrote its argv file. This is the assertion the whole guard exists for.
  expect(existsSync(argvOut)).toBe(false);
});

test("search_templates passes one filter through and reports the true match count", async () => {
  process.env.FAKE_COMFY_MODE = "templates_ls";
  process.env.FAKE_COMFY_TEMPLATES_FILE = LIMIT5;
  const client = await connect(baseConfig());

  const result = (await client.callTool({
    name: "search_templates",
    arguments: { type: "video", limit: 5 },
  })) as CallToolResult;

  const body = JSON.parse(textOf(result));
  expect(body.matched).toBe(156);
  expect(body.templates).toHaveLength(5);
  expect(body.truncated).toBe(true);
});

test("search_templates is annotated read-only and takes no host", async () => {
  const client = await connect(baseConfig());
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === "search_templates");
  expect(tool?.annotations?.readOnlyHint).toBe(true);
  expect(Object.keys(tool?.inputSchema.properties ?? {})).not.toContain("host");
});
```

If this file's `beforeEach` does not already set `COMFY_BIN`/`FAKE_COMFY_ARGV_OUT` and delete the `FAKE_COMFY_*` keys afterwards, add `FAKE_COMFY_TEMPLATES_FILE` to whatever cleanup list it uses, so a mode set by one test cannot leak into the next.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `deno task test:one tests/tools.test.ts`
Expected: FAIL — `Tool search_templates not found`.

- [ ] **Step 3: Register the tool**

Add to `src/tools.ts`'s imports:

```ts
import {
  DEFAULT_TEMPLATE_LIMIT,
  MAX_TEMPLATE_LIMIT,
  searchTemplates,
  type TemplateFilters,
} from "./comfy/templates.ts";
```

Add these argument definitions beside `hostArgument`:

```ts
/**
 * One gallery filter.
 *
 * Not an enum, on any of them. `templates ls --help` names four output kinds
 * today, and non-negotiable #2 says every registry the CLI publishes is
 * append-only — a closed enum here refuses a value that works the day upstream
 * adds one.
 */
function filterArgument(description: string) {
  return z.string().min(1).optional().describe(description);
}

const templateLimitArgument = z
  .number()
  .int()
  .min(1)
  .max(MAX_TEMPLATE_LIMIT)
  .default(DEFAULT_TEMPLATE_LIMIT)
  .describe(
    `How many templates to return, at most ${MAX_TEMPLATE_LIMIT}. The answer still reports ` +
      "`matched`, the true number the filters selected, so a capped result says so rather than " +
      "looking complete.",
  );
```

Add the registration, placed after `list_workflows` so the tool list reads in call order:

```ts
  server.registerTool(
    "search_templates",
    {
      title: "Search the workflow template gallery",
      description:
        "Search the Comfy workflow-template gallery — hundreds of ready-made workflows covering " +
        "text-to-image, image-to-video, upscaling, audio and more. Use this when list_workflows " +
        "has nothing that fits: pick a template here, then create_workflow_from_template turns it " +
        "into an ordinary local workflow that describe_workflow and run_workflow read normally. " +
        "AT LEAST ONE FILTER IS REQUIRED — the whole gallery is far too large to return, and a " +
        "call with no filter is refused rather than truncated. `type` is the output kind " +
        "(`image`, `video`, `audio`, `3d`), `tag` is an exact tag such as \"Image to Video\", and " +
        "`model`, `provider` and `name` are substring matches. `matched` reports how many " +
        "templates the filters really selected, so `truncated: true` means narrow the filters or " +
        "raise `limit`. This reads a gallery index, not a ComfyUI: it takes no `host`, never " +
        "starts anything, and says nothing about whether a template's models are installed — " +
        "describe_workflow answers that, per host, after you create the workflow. Note that a " +
        "template's `output_type` is inherited from its gallery category rather than derived " +
        "from the workflow, so it is occasionally wrong; `tags` are the more reliable signal.",
      inputSchema: {
        type: filterArgument("Output kind, e.g. \"video\". An open string — new kinds appear upstream."),
        category: filterArgument("Exact category title, e.g. \"Video\"."),
        tag: filterArgument("Exact tag, case-insensitive, e.g. \"Image to Video\"."),
        model: filterArgument("Substring of a model name, e.g. \"Flux\"."),
        provider: filterArgument("Substring of a provider name, e.g. \"Black Forest Labs\"."),
        name: filterArgument("Substring of the template's own name, e.g. \"wan\"."),
        limit: templateLimitArgument,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ type, category, tag, model, provider, name, limit }) =>
      toolAnswer(async () => {
        const filters: TemplateFilters = { type, category, tag, model, provider, name, limit };
        requireOneFilter(filters);
        const listing = await searchTemplates(filters);
        return {
          total_in_gallery: listing.total_in_gallery,
          matched: listing.matched,
          shown: listing.shown,
          truncated: listing.truncated,
          filters: { type, category, tag, model, provider, name },
          templates: listing.rows,
        };
      }),
  );
```

Add the guard beside `refuseInertInputs`:

```ts
/**
 * At least one filter, refused here rather than in the schema.
 *
 * A schema-level `.refine()` would work, but its rejection is caught by the
 * SDK's own `McpError` path and returned as a bare `{content:[{type:"text"}]}`
 * — the shape `toolResult.ts` exists to avoid. `manage_hosts`'s `mutationOf`
 * made the same call for the same reason: a `ToolArgumentError` reaches the
 * caller as `kind: "invalid_input"` like every other refusal here.
 *
 * `limit` is deliberately not a filter. Passing only a limit still asks for
 * the whole gallery, just less of it, and the cost this guard exists to avoid
 * is the gallery-wide scan, not the row count.
 */
function requireOneFilter(filters: TemplateFilters): void {
  const { type, category, tag, model, provider, name } = filters;
  if ([type, category, tag, model, provider, name].some((value) => value !== undefined)) return;
  throw new ToolArgumentError(
    "search_templates needs at least one of `type`, `category`, `tag`, `model`, `provider` or " +
      "`name`. The gallery holds hundreds of templates and returning all of them would not fit " +
      "in a useful answer. Try {type: \"video\"} or {name: \"flux\"}.",
  );
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `deno task test:one tests/tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check and run the full suite once**

Run: `deno task typecheck && deno task test`
Expected: zero type errors; whole suite green. Run these sequentially — never two `deno test` at once.

- [ ] **Step 6: Kill the mutant**

Make `requireOneFilter` return unconditionally. The "refuses a call with no filter, without spawning" test must fail on the `existsSync(argvOut)` assertion specifically, not only on the error kind — that is what proves the refusal beats the subprocess. Restore.

- [ ] **Step 7: Commit**

```bash
but commit -b workflow-creation -m "feat(tools): add search_templates

At least one filter is required, refused in the handler with
ToolArgumentError rather than by a schema refine, so it arrives as
kind: invalid_input like every other refusal here — the manage_hosts
precedent. The guard runs before any subprocess is spawned."
```

---

## Task 3: the created-workflows directory

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config.test.ts` (create if absent; otherwise append)

**Interfaces:**
- Consumes: nothing from earlier tasks. This task is independent of Tasks 1–2 and may be done first.
- Produces: `CREATED_DIR_ENV`, `createdWorkflowDir(env: Environment): string`. `workflowRoots(env)` now returns the created directory as its last element.

- [ ] **Step 1: Write the failing tests**

```ts
import { expect, test } from "./support/testing.ts";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  CREATED_DIR_ENV,
  createdWorkflowDir,
  DEFAULT_WORKFLOW_DIR,
  WORKFLOW_DIRS_ENV,
  workflowRoots,
} from "../src/config.ts";

test("the created directory is the last root, so it cannot shadow an operator's workflow", () => {
  const roots = workflowRoots({ [WORKFLOW_DIRS_ENV]: "/a:/b" });
  expect(roots).toEqual(["/a", "/b", createdWorkflowDir({})]);
});

test("the created directory is last even when no roots are configured", () => {
  const roots = workflowRoots({});
  expect(roots).toEqual([DEFAULT_WORKFLOW_DIR, createdWorkflowDir({})]);
});

test("the operator can move the created directory", () => {
  expect(createdWorkflowDir({ [CREATED_DIR_ENV]: "/tmp/created" })).toBe("/tmp/created");
});

test("an unset created directory falls back under the home directory", () => {
  expect(createdWorkflowDir({})).toBe(join(homedir(), ".local", "share", "mcp-comfyui", "workflows"));
});

test("a created directory the operator also listed explicitly appears once", () => {
  // uniqueRoots drops repeats; the explicit entry keeps its earlier position,
  // which is the operator's stated precedence and must win.
  const roots = workflowRoots({
    [WORKFLOW_DIRS_ENV]: "/tmp/created:/b",
    [CREATED_DIR_ENV]: "/tmp/created",
  });
  expect(roots).toEqual(["/tmp/created", "/b"]);
});

test("a relative created directory is resolved to absolute like every other root", () => {
  const roots = workflowRoots({ [CREATED_DIR_ENV]: "created" });
  expect(roots[roots.length - 1]?.startsWith("/")).toBe(true);
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `deno task test:one tests/config.test.ts`
Expected: FAIL — `CREATED_DIR_ENV` and `createdWorkflowDir` are not exported.

- [ ] **Step 3: Implement**

In `src/config.ts`, extend the import:

```ts
import { homedir } from "node:os";
import { join, resolve } from "node:path";
```

Add beside the other env-var declarations:

```ts
/**
 * Where a workflow this server creates is written.
 *
 * Its own directory rather than one of the operator's, because the two have
 * different owners: the roots in {@link WORKFLOW_DIRS_ENV} hold files a person
 * made, and one of them is a directory ComfyUI Desktop manages. Fetched
 * templates are this server's, disposable, and must never be mistaken for
 * either.
 */
export const CREATED_DIR_ENV = "MCP_COMFYUI_CREATED_DIR";
```

Add the resolver:

```ts
/**
 * The directory created workflows are written to, absolute.
 *
 * `~/.local/share` rather than the cache directory: a fetched workflow is
 * something a caller may go on to parameterise and rerun, so losing it to a
 * cache sweep would lose work. Nothing creates this directory — the first
 * write does, so a server that never creates a workflow leaves nothing behind.
 */
export function createdWorkflowDir(env: Environment = process.env): string {
  return resolve(setting(env, CREATED_DIR_ENV) ?? join(homedir(), ".local", "share", "mcp-comfyui", "workflows"));
}
```

Change the return of `workflowRoots` — the body above it is unchanged:

```ts
  // The created directory goes LAST, and that placement is the whole guarantee
  // that a fetched `portrait.json` cannot displace an operator's own. Order
  // here is a precedence order (see the doc comment above): `discover.ts` gives
  // the first root's copy of a colliding filename the bare, unqualified name.
  // `uniqueRoots` drops it if the operator already listed it, keeping their
  // position rather than this one.
  return uniqueRoots([
    ...(segments.length > 0 ? segments : [DEFAULT_WORKFLOW_DIR]),
    createdWorkflowDir(env),
  ]);
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `deno task test:one tests/config.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Run the full suite**

Run: `deno task test`
Expected: green. `workflowRoots` is read by `discover.ts` and by `list_workflows`, so a test elsewhere asserting an exact root list will fail here — fix it by appending the created directory to its expectation, never by reordering the roots.

- [ ] **Step 6: Kill the mutant**

Put `createdWorkflowDir(env)` **first** in the `uniqueRoots` array instead of last. "the created directory is the last root" must fail. Restore.

- [ ] **Step 7: Commit**

```bash
but commit -b workflow-creation -m "feat(config): add the created-workflows directory

MCP_COMFYUI_CREATED_DIR, defaulting under ~/.local/share, appended LAST to
workflowRoots(). Last is load-bearing: discover.ts gives the first root's copy
of a colliding filename the bare name, so appending is what stops a fetched
workflow shadowing one the operator made."
```

---

## Task 4: `origin` on `list_workflows`

**Files:**
- Modify: `src/tools.ts` (the `list_workflows` handler and its description)
- Test: `tests/tools.test.ts` (append)

**Interfaces:**
- Consumes: `createdWorkflowDir` from Task 3.
- Produces: an `origin: "template"` field on local workflow entries under the created root. No exported symbols.

- [ ] **Step 1: Write the failing tests**

`baseConfig({ env })` **replaces** the whole env record, so every override must carry `MCP_COMFYUI_HOSTS_FILE` forward — without it the handler reads whichever real `~/.config/mcp-comfyui/hosts.json` the machine has, and the test fails only on a developer who happens to have two hosts registered. Add this helper next to `baseConfig`:

```ts
/** `baseConfig` with extra env, keeping the hosts-file redirect it sets. */
function configWithEnv(extra: Record<string, string>): ToolConfig {
  return baseConfig({ env: { MCP_COMFYUI_HOSTS_FILE: join(workdir, "hosts.json"), ...extra } });
}
```

```ts
test("list_workflows tags an entry under the created root, and only that entry", async () => {
  const roots = join(workdir, "origin-roots");
  const created = join(workdir, "origin-created");
  mkdirSync(roots, { recursive: true });
  mkdirSync(created, { recursive: true });
  const graph = JSON.stringify({ nodes: [], links: [] });
  writeFileSync(join(roots, "mine.json"), graph);
  writeFileSync(join(created, "fetched.json"), graph);

  const client = await connect(configWithEnv({
    MCP_COMFYUI_WORKFLOW_DIRS: roots,
    MCP_COMFYUI_CREATED_DIR: created,
  }));
  const result = (await client.callTool({
    name: "list_workflows",
    arguments: {},
  })) as CallToolResult;
  const body = JSON.parse(textOf(result));

  const mine = body.workflows.find((w: { name: string }) => w.name === "mine");
  const fetched = body.workflows.find((w: { name: string }) => w.name === "fetched");
  expect(fetched.origin).toBe("template");
  expect(mine.origin).toBeUndefined();
});

test("a created workflow colliding with an operator's does not take the bare name", async () => {
  const roots = join(workdir, "collide-roots");
  const created = join(workdir, "collide-created");
  mkdirSync(roots, { recursive: true });
  mkdirSync(created, { recursive: true });
  const graph = JSON.stringify({ nodes: [], links: [] });
  writeFileSync(join(roots, "portrait.json"), graph);
  writeFileSync(join(created, "portrait.json"), graph);

  const client = await connect(configWithEnv({
    MCP_COMFYUI_WORKFLOW_DIRS: roots,
    MCP_COMFYUI_CREATED_DIR: created,
  }));
  const result = (await client.callTool({
    name: "list_workflows",
    arguments: {},
  })) as CallToolResult;
  const body = JSON.parse(textOf(result));

  // The bare name belongs to the operator's copy. The fetched one is still
  // listed and still reachable, but under a disambiguated name — this is the
  // whole point of appending the created root last.
  const bare = body.workflows.find((w: { name: string }) => w.name === "portrait");
  expect(bare.path.startsWith(roots)).toBe(true);
  expect(bare.origin).toBeUndefined();
  expect(body.workflows.filter((w: { origin?: string }) => w.origin === "template")).toHaveLength(1);
});
```

Both use `workdir`, which `afterEach` already removes, so neither needs its own cleanup.

Confirm the disambiguated name `discover.ts` gives the second `portrait.json` before asserting on it — read `claimName` and match its real spelling rather than guessing one.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `deno task test:one tests/tools.test.ts`
Expected: FAIL — `expect(fetched.origin).toBe("template")` gets `undefined`.

- [ ] **Step 3: Implement**

In `src/tools.ts`, import `createdWorkflowDir` from `./config.ts` alongside `workflowRoots`, then change the `local` mapping inside the `list_workflows` handler:

```ts
        const listing = await discoverWorkflows({ env: config.env });
        // Provenance is decided here, not in discover.ts: that module is a pure
        // content classifier and has no business knowing which root belongs to
        // this server. Every entry already carries an absolute `path`, so a
        // prefix comparison is the whole implementation.
        const created = createdWorkflowDir(config.env);
        const local = listing.workflows.map((workflow) => ({
          ...workflow,
          source: "local",
          // Absent rather than `origin: null` on an operator's own file: a key
          // that is only ever one value carries its meaning by being there.
          ...(workflow.path.startsWith(`${created}${sep}`) ? { origin: "template" } : {}),
        }));
```

Add `sep` to the `node:path` import at the top of `src/tools.ts`:

```ts
import { basename, isAbsolute, join, sep } from "node:path";
```

Extend the `list_workflows` description, appended before the final sentence about `source`:

```
"An entry tagged `origin: \"template\"` was fetched from the gallery by " +
"create_workflow_from_template rather than written by hand; it behaves like any other " +
"local workflow. "
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `deno task test:one tests/tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Kill the mutant**

Change the prefix test to `workflow.path.startsWith(created)` — dropping the trailing separator. Add a sibling directory named `<created>-other` holding a workflow and confirm it is now wrongly tagged. Write that case as a permanent test rather than only as a mutation:

```ts
test("a sibling directory sharing the created prefix is not tagged", async () => {
  const created = mkdtempSync(join(tmpdir(), "mcp-comfyui-prefix-"));
  const sibling = `${created}-other`;
  mkdirSync(sibling);
  writeFileSync(join(sibling, "decoy.json"), JSON.stringify({ nodes: [], links: [] }));

  const client = await connect(configWithEnv({
    MCP_COMFYUI_WORKFLOW_DIRS: sibling,
    MCP_COMFYUI_CREATED_DIR: created,
  }));
  const result = (await client.callTool({
    name: "list_workflows",
    arguments: {},
  })) as CallToolResult;
  const body = JSON.parse(textOf(result));
  expect(body.workflows.find((w: { name: string }) => w.name === "decoy").origin).toBeUndefined();

  rmSync(created, { recursive: true, force: true });
  rmSync(sibling, { recursive: true, force: true });
});
```

Restore the `sep` version and confirm all three pass.

- [ ] **Step 6: Commit**

```bash
but commit -b workflow-creation -m "feat(tools): tag fetched workflows with origin

list_workflows marks entries under the created root origin: template. Decided
at the tool layer by prefix, so discover.ts stays a pure content classifier
that knows nothing about provenance. The trailing separator in the prefix test
is load-bearing: without it a sibling directory sharing the prefix is tagged."
```

---

## Task 5: `templates.ts` — the fetch wrapper

**Files:**
- Modify: `src/comfy/templates.ts`
- Modify: `tests/fixtures/fake-comfy` (append one mode)
- Test: `tests/templates.test.ts` (append)

**Interfaces:**
- Consumes: `runComfy`, `TemplatesPayloadError` from Task 1.
- Produces: `fetchTemplate(template: string, destination: string, opts?: RunOptions): Promise<FetchedTemplate>`, `FetchedTemplate`, `assertNotFlag`.

- [ ] **Step 1: Append the `templates_fetch` fixture mode**

Add to the fixture's header comment:

```sh
#   $FAKE_COMFY_TEMPLATE_FILE      templates_fetch: file copied to the -o path
```

Append a new arm before the default:

```sh
  templates_fetch)
    # `comfy templates fetch <name> -o <path>`, copying a fixture workflow to
    # the requested destination. Modelled on run_capture's argv walk. The copy
    # is a byte copy: nothing here may reformat the JSON, because the test that
    # matters asserts a 2^64-1 widget value survives (non-negotiable #1).
    take=0
    dest=
    for arg in "$@"; do
      if [ "$take" = 1 ]; then dest="$arg"; break; fi
      [ "$arg" = "-o" ] && take=1
    done
    if [ -n "$dest" ] && [ -n "$FAKE_COMFY_TEMPLATE_FILE" ]; then
      mkdir -p "$(dirname "$dest")"
      cp "$FAKE_COMFY_TEMPLATE_FILE" "$dest"
    fi
    size=0
    [ -n "$dest" ] && [ -f "$dest" ] && size=$(wc -c < "$dest" | tr -d ' ')
    printf '{"schema":"envelope/1","type":"envelope","ok":true,"command":"templates fetch","version":"0.0.0","where":null,"data":{"name":"%s","title":"Fixture Template","output_type":"video","bytes":%s},"error":null}\n' "$FAKE_COMFY_TEMPLATE_NAME" "$size"
    exit 0 ;;
```

Add `$FAKE_COMFY_TEMPLATE_NAME` to the header comment too.

- [ ] **Step 2: Build the fixture workflow**

A tiny frontend-format graph carrying a value above 2^53, so the byte-exactness assertion is load-bearing rather than decorative:

```bash
cat > tests/fixtures/template.bigseed.json <<'EOF'
{
  "nodes": [
    {"id": 3, "type": "KSampler", "widgets_values": [18446744073709551615, "randomize", 20, 8, "euler", "normal", 1]}
  ],
  "links": [],
  "last_node_id": 3,
  "last_link_id": 0
}
EOF
grep -c 18446744073709551615 tests/fixtures/template.bigseed.json
```

Expected: `1`.

- [ ] **Step 3: Write the failing tests**

Append to `tests/templates.test.ts`:

```ts
import { createHash } from "node:crypto";
import { fetchTemplate } from "../src/comfy/templates.ts";

const BIGSEED = join(import.meta.dirname, "fixtures", "template.bigseed.json");

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Switch the shared fixture over to fetch mode for one test. */
function useFetchMode(): void {
  process.env.FAKE_COMFY_MODE = "templates_fetch";
  process.env.FAKE_COMFY_TEMPLATE_FILE = BIGSEED;
  process.env.FAKE_COMFY_TEMPLATE_NAME = "fixture_template";
}

test("the fetched file is byte-identical, so a 2^64-1 widget value survives", async () => {
  useFetchMode();
  const dest = join(workdir, "out.json");
  await fetchTemplate("fixture_template", dest);
  // Digest, never JSON.parse — non-negotiable #1. A round trip through JS
  // would render this seed 18446744073709552000, and a test that compared
  // parsed objects would go on passing.
  expect(digest(dest)).toBe(digest(BIGSEED));
  expect(readFileSync(dest, "utf8")).toContain("18446744073709551615");
});

test("the template name and destination reach the CLI in the right order", async () => {
  useFetchMode();
  const dest = join(workdir, "out.json");
  await fetchTemplate("fixture_template", dest);
  const argv = readFileSync(argvOut, "utf8").trim().split(/\s+/);
  expect(argv.indexOf("--json")).toBeLessThan(argv.indexOf("templates"));
  expect(argv.slice(argv.indexOf("templates"))).toEqual([
    "templates", "fetch", "fixture_template", "-o", dest,
  ]);
});

test("a template name starting with a dash is refused before spawning", async () => {
  // The name is a POSITIONAL. `--gallery` in this position is read by the CLI's
  // own parser as a flag, which is how a caller-chosen file once got smuggled
  // into an unrelated command in this project (see encodePair, promptIdArgument).
  useFetchMode();
  await expect(fetchTemplate("--gallery", join(workdir, "out.json")))
    .rejects.toThrow(/cannot start with/);
  expect(existsSync(argvOut)).toBe(false);
});

test("the CLI's own template_not_found survives as a ComfyCliError", async () => {
  process.env.FAKE_COMFY_MODE = "fail_code";
  process.env.FAKE_COMFY_ERROR_CODE = "template_not_found";
  process.env.FAKE_COMFY_ERROR_MESSAGE = "no template named 'nope' in the gallery";
  await expect(fetchTemplate("nope", join(workdir, "out.json")))
    .rejects.toMatchObject({ code: "template_not_found" });
});
```

Add `existsSync` to the `node:fs` import, and extend `FIXTURE_ENV` so a mode cannot leak between tests:

```ts
const FIXTURE_ENV = [
  "COMFY_BIN",
  "FAKE_COMFY_MODE",
  "FAKE_COMFY_TEMPLATES_FILE",
  "FAKE_COMFY_TEMPLATE_FILE",
  "FAKE_COMFY_TEMPLATE_NAME",
  "FAKE_COMFY_ERROR_CODE",
  "FAKE_COMFY_ERROR_MESSAGE",
  "FAKE_COMFY_ARGV_OUT",
];
```

- [ ] **Step 4: Run the tests and verify they fail**

Run: `deno task test:one tests/templates.test.ts`
Expected: FAIL — `fetchTemplate` is not exported.

- [ ] **Step 5: Implement**

Append to `src/comfy/templates.ts`:

```ts
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
```

- [ ] **Step 6: Run the tests and verify they pass**

Run: `deno task test:one tests/templates.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 7: Measure the unmeasured failure mode**

The design doc flags this as the one thing it never measured. Do it now, with the network down:

```bash
sudo ifconfig en0 down 2>/dev/null || echo "turn wifi off by hand, then rerun"
comfy --json --skip-prompt templates fetch video_wan2_2_14B_i2v -o /tmp/netfail.json; echo "exit=$?"
sudo ifconfig en0 up 2>/dev/null || echo "turn wifi back on"
```

If the output is a well-formed `ok:false` envelope, nothing more is needed — it lands in the existing `ComfyCliError` arm. If it is a traceback or empty, add a note to the tool description saying the call needs network access, and record the finding in `docs/comfy-cli-ground-truth.md` as a new numbered landmine. Either way, write down what happened.

- [ ] **Step 8: Kill the mutants**

1. Remove the `assertNotFlag` call → "a template name starting with a dash is refused" must fail.
2. Change the fixture copy to `node -e 'JSON.parse/stringify'` instead of `cp` → the digest test must fail while a naive parsed-object comparison would still pass. This is the mutant that proves the digest assertion earns its place.

Restore both.

- [ ] **Step 9: Commit**

```bash
but commit -b workflow-creation -m "feat(templates): wrap comfy templates fetch

The template name is a positional, so a leading dash is refused before the
spawn — the third instance of this guard in the project after promptIdArgument
and encodePair. The fixture copies bytes rather than re-serialising, and the
test digests them, so a 2^64-1 widget value proves the copy is byte-exact."
```

---

## Task 6: `create_workflow_from_template` tool

**Files:**
- Modify: `src/tools.ts`
- Test: `tests/tools.test.ts` (append)

**Interfaces:**
- Consumes: `fetchTemplate` from Task 5 (which applies `assertNotFlag` itself — this task does not call it); `createdWorkflowDir` from Task 3.
- Produces: the `create_workflow_from_template` MCP tool. No exported symbols.

- [ ] **Step 1: Write the failing tests**

These reuse `connect`, `textOf` and `baseConfig` — all already in `tests/tools.test.ts` — plus the `configWithEnv` helper added in Task 4. Add `mkdirSync` to the `node:fs` import and `BIGSEED` as a module constant beside `SLOTS_SAMPLE`. The fixture mode goes through `process.env` rather than `ToolConfig`, because the spawned `sh` fixture reads the process environment, not this server's config:

```ts
/** Point the fixture at a frontend-format workflow carrying a 2^64-1 value. */
function useFetchMode(): void {
  process.env.FAKE_COMFY_MODE = "templates_fetch";
  process.env.FAKE_COMFY_TEMPLATE_FILE = BIGSEED;
  process.env.FAKE_COMFY_TEMPLATE_NAME = "fixture_template";
}
```

A NUL byte in a path makes `node:fs` throw a bare `TypeError` rather than returning an error, so `assertPlainStem` must reject it *before* `existsSync` is reached. That is why the NUL check lives in the guard and not in a `try`/`catch` around the filesystem call.

```ts
test("create_workflow_from_template writes into the created directory and returns the path", async () => {
  useFetchMode();
  const created = join(workdir, "created");
  const client = await connect(configWithEnv({ MCP_COMFYUI_CREATED_DIR: created }));
  const result = (await client.callTool({
    name: "create_workflow_from_template",
    arguments: { template: "fixture_template" },
  })) as CallToolResult;
  const body = JSON.parse(textOf(result));
  expect(body.path).toBe(join(created, "fixture_template.json"));
  expect(existsSync(body.path)).toBe(true);
});

test("an existing target is refused and the existing file is untouched", async () => {
  useFetchMode();
  const created = join(workdir, "created2");
  mkdirSync(created, { recursive: true });
  const target = join(created, "fixture_template.json");
  writeFileSync(target, "ORIGINAL");

  const client = await connect(configWithEnv({ MCP_COMFYUI_CREATED_DIR: created }));
  const result = (await client.callTool({
    name: "create_workflow_from_template",
    arguments: { template: "fixture_template" },
  })) as CallToolResult;
  const body = JSON.parse(textOf(result));
  expect(body.error.kind).toBe("invalid_input");
  expect(body.error.message).toContain("as");
  expect(readFileSync(target, "utf8")).toBe("ORIGINAL");
});

test("`as` cannot climb out of the created directory", async () => {
  useFetchMode();
  const created = join(workdir, "created3");
  const client = await connect(configWithEnv({ MCP_COMFYUI_CREATED_DIR: created }));
  for (const bad of ["../escape", "sub/dir", "..", ".", "/absolute", "a\u0000b"]) {
    const result = await client.callTool({
      name: "create_workflow_from_template",
      arguments: { template: "fixture_template", as: bad },
    }) as CallToolResult;
    const body = JSON.parse(textOf(result));
    expect(body.error.kind).toBe("invalid_input");
  }
  expect(existsSync(join(workdir, "escape.json"))).toBe(false);
});

test("`as` names the file when it is a plain stem", async () => {
  useFetchMode();
  const created = join(workdir, "created4");
  const client = await connect(configWithEnv({ MCP_COMFYUI_CREATED_DIR: created }));
  const result = await client.callTool({
    name: "create_workflow_from_template",
    arguments: { template: "fixture_template", as: "my-video" },
  }) as CallToolResult;
  const body = JSON.parse(textOf(result));
  expect(body.path).toBe(join(created, "my-video.json"));
});

test("create_workflow_from_template is not read-only and takes no host", async () => {
  const client = await connect(baseConfig());
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === "create_workflow_from_template");
  expect(tool?.annotations?.readOnlyHint).toBe(false);
  expect(tool?.annotations?.destructiveHint).toBe(false);
  expect(Object.keys(tool?.inputSchema.properties ?? {})).not.toContain("host");
});
```

Add `mkdirSync` to the `node:fs` import in `tests/tools.test.ts`, and `BIGSEED` as a module constant.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `deno task test:one tests/tools.test.ts`
Expected: FAIL — `Tool create_workflow_from_template not found`.

- [ ] **Step 3: Implement**

Add to `src/tools.ts`'s imports:

```ts
import { fetchTemplate } from "./comfy/templates.ts";
import { createdWorkflowDir } from "./config.ts";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
```

Add the stem guard beside `requireOneFilter`:

```ts
/**
 * A filename stem, and nothing else.
 *
 * `as` decides a path this server writes to, so it is refused unless it is a
 * bare name: no separator, no `..`, no absolute path, no NUL. `outputs.ts`
 * already refuses a `subfolder` that climbs out of its root for the same
 * reason — a fabricated path is worse than none — and this is the write-side
 * twin of that check. Refusing outright rather than sanitising is deliberate:
 * a silently rewritten name is a file the caller cannot find again.
 *
 * @throws {ToolArgumentError} the stem would name something other than a file
 *   directly inside the created directory.
 */
function assertPlainStem(stem: string): void {
  const bad = stem.length === 0 ||
    stem === "." ||
    stem === ".." ||
    stem.includes("/") ||
    stem.includes("\\") ||
    stem.includes("\0") ||
    isAbsolute(stem);
  if (bad) {
    throw new ToolArgumentError(
      `\`as\` must be a plain filename with no directory part (got ${JSON.stringify(stem)}). ` +
        "Try {as: \"my-video\"}.",
    );
  }
}
```

Register the tool immediately after `search_templates`:

```ts
  server.registerTool(
    "create_workflow_from_template",
    {
      title: "Create a workflow from a gallery template",
      description:
        "Create a new local workflow from a gallery template found with search_templates. The " +
        "result is an ordinary workflow file: call describe_workflow on the returned `path` (or " +
        "on its `name`) to see its inputs, then run_workflow to run it — nothing about it is " +
        "special afterwards. The file belongs to this server, not to ComfyUI, so it will NOT " +
        "appear in the ComfyUI editor; list_workflows shows it tagged `origin: \"template\"`. " +
        "Pass `as` to choose the filename when you want something more memorable than the " +
        "template's own name, or when a workflow of that name already exists — an existing file " +
        "is never overwritten. This takes no `host`: the gallery is not part of any ComfyUI and " +
        "nothing is started or contacted on your machine. It does need network access, because " +
        "the workflow itself is downloaded even though the gallery index is cached. Whether the " +
        "template's models are installed is a separate question, and describe_workflow answers " +
        "it per host on the next call.",
      inputSchema: {
        template: z
          .string()
          .min(1)
          .describe("The `name` of a template from search_templates, e.g. \"video_wan2_2_14B_i2v\"."),
        as: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Filename to save under, without the .json extension and with no directory part. " +
              "Defaults to the template's own name.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ template, as }) =>
      toolAnswer(async () => {
        const stem = as ?? template;
        assertPlainStem(stem);
        const directory = createdWorkflowDir(config.env);
        const path = join(directory, `${stem}.json`);
        // Checked before the directory is created, so a refused call leaves
        // nothing behind on a machine that has never fetched anything.
        if (existsSync(path)) {
          throw new ToolArgumentError(
            `a workflow already exists at ${path}. Pass \`as\` to save under a different name — ` +
              "this tool never overwrites, because that file may already have been parameterised.",
          );
        }
        // Created only now: a server that never creates a workflow leaves no
        // directory behind. `comfy templates fetch -o` also creates parents,
        // but relying on that would make the refusal above depend on the CLI.
        await mkdir(directory, { recursive: true });
        const fetched = await fetchTemplate(template, path);
        return {
          name: fetched.name,
          title: fetched.title,
          output_type: fetched.output_type,
          path: fetched.path,
          bytes: fetched.bytes,
          next: "describe_workflow",
        };
      }),
  );
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `deno task test:one tests/tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check and run the full suite**

Run: `deno task typecheck && deno task test`
Expected: zero type errors; suite green.

- [ ] **Step 6: Kill the mutants**

1. Delete the `assertPlainStem` call → the `as` traversal test must fail, and specifically the `existsSync(join(workdir, "escape.json"))` assertion must catch a file written outside the created directory.
2. Replace the `existsSync` refusal with an unconditional fetch → "an existing target is refused" must fail on the `ORIGINAL` content assertion.

Restore both.

- [ ] **Step 7: Commit**

```bash
but commit -b workflow-creation -m "feat(tools): add create_workflow_from_template

Fetches one gallery template into the created directory and hands the path to
the existing pipeline. `as` is refused unless it is a plain stem — it decides a
path this server writes to, and outputs.ts already refuses a subfolder that
climbs out of its root for the same reason. An existing target is never
overwritten."
```

---

## Task 7: wiring, end-to-end proof, and honesty

**Files:**
- Modify: `src/server.ts` (the instructions string)
- Modify: `CHANGELOG.md`
- Modify: `CLAUDE.md` (the architecture map)
- Test: `tests/server.test.ts` (append one end-to-end case)

**Interfaces:**
- Consumes: everything from Tasks 1–6.
- Produces: nothing. This task is documentation and one integration test.

- [ ] **Step 1: Write the failing end-to-end test**

The point of this feature is that a fetched template needs no new pipeline. Nothing so far proves it — every test above stops at the returned path. Append to `tests/server.test.ts`, following that file's existing pattern of spawning `dist/index.js` under real `node` over stdio:

```ts
test("a fetched template is describable by the existing pipeline, unchanged", async () => {
  // The whole design rests on this: `templates fetch` writes frontend format,
  // so describe_workflow reads it with no conversion step. If this fails, the
  // feature does not work, however green the unit tests are.
  const created = join(workdir, "created");
  const client = await startServer({
    MCP_COMFYUI_CREATED_DIR: created,
    FAKE_COMFY_MODE: "templates_fetch",
    FAKE_COMFY_TEMPLATE_FILE: SLOTS_CAPABLE_TEMPLATE,
    FAKE_COMFY_TEMPLATE_NAME: "fixture_template",
  });

  const created_result = await callTool(client, "create_workflow_from_template", {
    template: "fixture_template",
  });
  expect(created_result.path).toBe(join(created, "fixture_template.json"));

  const listed = await callTool(client, "list_workflows", {});
  const entry = listed.workflows.find((w: { name: string }) => w.name === "fixture_template");
  expect(entry.origin).toBe("template");
  expect(entry.format).toBe("frontend");
});
```

`SLOTS_CAPABLE_TEMPLATE` is `tests/fixtures/template.bigseed.json` from Task 5 — it is frontend format, which is exactly what this asserts.

- [ ] **Step 2: Run it and verify it fails, then passes**

Run: `deno task test:one tests/server.test.ts`
It should fail only if the wiring is wrong. If it passes immediately, that is the correct outcome for an integration test over already-built parts — confirm by temporarily setting `MCP_COMFYUI_CREATED_DIR` to a directory outside `workflowRoots()` and watching `entry` become `undefined`.

- [ ] **Step 3: Extend the server instructions**

In `src/server.ts`, add one clause to the instructions string, after the sentence naming `list_workflows` as the starting point:

```
"When list_workflows has nothing that fits the task, search_templates finds a ready-made " +
"workflow in the Comfy gallery and create_workflow_from_template turns it into a local one. "
```

- [ ] **Step 4: Update `CLAUDE.md`**

Add one line to the architecture map, under `src/comfy/`:

```
  templates.ts      the gallery: search and fetch. No host — it is not a ComfyUI.
```

And append to the non-negotiables section, under #2:

```
`comfy validate`'s 13 diagnostic codes (`unknown_enum_value`, `required_input_missing`,
`dangling_edge`, …) appear in NONE of comfy-cli's published `error_codes.py` registry — a
second, wholly undocumented open-string vocabulary. Measured 2026-08-07.
```

- [ ] **Step 5: Update `CHANGELOG.md`**

Add under an `## Unreleased` heading, following the file's existing voice — log the change as it lands; the version bump is the maintainer's to run at the end:

```markdown
### Added

- `search_templates` and `create_workflow_from_template`: find a workflow in
  comfy-cli's template gallery and materialise it locally. A fetched template is
  frontend format, so `describe_workflow` and `run_workflow` read it with no
  change to the pipeline — verified end to end on `video_wan2_2_14B_i2v`, whose
  58 slots include 14 decoys the existing inert detection correctly refuses.
- `MCP_COMFYUI_CREATED_DIR`, appended **last** to the workflow roots so a fetched
  workflow can never shadow one you made. Entries under it list as
  `origin: "template"`.

### Notes

- Workflow *authoring* is deliberately not built. `comfy workflow compose` works,
  but emits API format, which `comfy workflow slots` hard-rejects and which no
  API→UI conversion anywhere in comfy-cli can undo — a composed workflow could be
  run and never described. `comfy nodes path` does not route. Both measured; see
  `docs/plans/2026-08-07-workflow-creation-design.md`.
```

- [ ] **Step 6: Full verification**

Run these sequentially, never concurrently:

```bash
deno task typecheck
deno task test
deno task build
```

Expected: zero type errors, whole suite green, `dist/index.js` written.

- [ ] **Step 7: Prove it against the real gallery, once**

Unit tests never touch the real CLI, so one manual run is what turns "the fixtures agree" into "the feature works". Write this to `scripts/smoke-templates.mjs` — a file, not an inline heredoc, per this project's shell discipline:

```js
// Drives the built server over real stdio, the way an MCP client does.
// Requires network (templates fetch) and a reachable ComfyUI (describe_workflow).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, MCP_COMFYUI_CREATED_DIR: "/tmp/mcp-created" },
});
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  return JSON.parse(result.content.map((c) => c.text).join("\n"));
};

const found = await call("search_templates", { type: "video", tag: "Image to Video", limit: 5 });
console.error(`matched ${found.matched}, showing ${found.shown}`);

const made = await call("create_workflow_from_template", { template: "video_wan2_2_14B_i2v" });
console.error(`wrote ${made.path} (${made.bytes} bytes)`);

const described = await call("describe_workflow", { workflow: "video_wan2_2_14B_i2v" });
console.error(`settable: ${Object.keys(described.schema.properties).length}`);
console.error(`inert:    ${described.inert.length}`);
console.error(`inert addresses: ${described.inert.map((i) => i.address).join(", ")}`);

await client.close();
```

Run it:

```bash
deno task build && node scripts/smoke-templates.mjs
```

Expected: 44 settable addresses and 14 under `inert`, with `129/98.length` and `129/94.fps` among the inert ones. Those are the numbers measured on 2026-08-07; a different count means either the gallery template changed upstream or the inert detection regressed, and the two are worth telling apart before shipping.

Record the result in `CLAUDE.md`'s "Verified end to end" section, in the voice already used there.

- [ ] **Step 8: Commit, push, open a PR**

```bash
but commit -b workflow-creation -m "docs: wire up template creation and record what it does not do"
but push workflow-creation
but pr new workflow-creation -t
```

- [ ] **Step 9: Delete this file**

`IMPLEMENTATION_PLAN.md` is removed when all stages are done. The design doc in `docs/plans/` stays as the record of why.

```bash
rm IMPLEMENTATION_PLAN.md
but commit -b workflow-creation -m "chore: remove the implementation plan, all stages done"
```

---

## Deliberately not in this plan

- **`validate_workflow`.** `comfy validate` works offline and catches real errors, but nothing here produces an invalid workflow — gallery templates are valid by construction — so it would be a tool with no caller. Revisit if authoring ever ships.
- **compose / decompose / fragment authoring.** Blocked upstream: no API→UI conversion exists, and `fragment show` corrupts integers above 2^53 on decode.
- **An `overwrite` flag.** Refusal plus `as` covers it. If the pair becomes annoying, the opt-in-flag pattern (`wait`, `fetch_outputs`) is the established shape.
- **Garbage-collecting the created directory.** Files accumulate. Accepted for v1 and disclosed in the changelog.
- **Finishing `candidate_addresses`.** `inertInputsOf` resolves the single-hop case and leaves nine of fourteen empty on the measured template. Real, pre-existing, and its own change — it would improve every subgraph workflow, not just fetched ones.
