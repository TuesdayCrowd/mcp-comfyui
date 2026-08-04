# mcp-comfyui Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** An MCP server that lets Claude discover ComfyUI workflow files, learn each one's settable inputs as a typed JSON Schema, and execute them with supplied values — driving everything through the `comfy` CLI.

**Architecture:** Thin orchestrator. The server never parses or rewrites workflow graphs itself; it shells out to `comfy` and parses the stable `envelope/1` JSON contract. All graph work (UI→API conversion, subgraph expansion, reroute chains, bypass tracing, widget de-skewing) stays in `comfy`, which is tested upstream and already correct. The server's own value-add is the **`slots` × `object_info` join** that turns untyped slot listings into constrained JSON Schema, plus instance lifecycle and job handling.

**Tech Stack:** TypeScript, Bun 1.3.14, `@modelcontextprotocol/sdk` 1.30.0, `zod` 4.4.3 (SDK accepts `^3.25 || ^4.0`), stdio transport, `bun test`.

---

## Verified Ground Truth

Everything below was executed against a live ComfyUI Desktop (v0.29.0, `127.0.0.1:8188`) on 2026-08-02. Do not re-derive; do not assume anything not listed here.

**Environment**
- `comfy` installed via `uv tool install --python 3.13 --from <local comfy-cli tree> comfy-cli` → `~/.local/bin/comfy` (already on fish PATH via `config.fish:78`).
- Local comfy-cli tree is `v1.13.0-59-g95d7897`, newer than PyPI 1.13.0. It reports `"version": "0.0.0"` in envelopes because the tree leaves version stamping to CI. **Do not version-gate on this field.**
- Workflow files: `/Users/lawls/ComfyUI-Shared/user/default/workflows` (22 files, all UI/frontend format).
- ComfyUI Desktop owns the running process. It is **not** a comfy-cli workspace.

**The envelope contract** — every `comfy` command in JSON mode emits:
```json
{"schema":"envelope/1","type":"envelope","ok":true,"command":"...","version":"...",
 "where":null,"data":{...},"error":null}
```
On failure `ok:false` and `error:{code,message,hint,details}`.

**Commands this server depends on** (all verified working):

| Command | Returns |
|---|---|
| `comfy --skip-prompt workflow slots <file> --host H --port P` | `data.slots[]` — `{address,name,type,current_value,instance_id,node_type}` |
| `comfy --skip-prompt workflow set-slot <file> ADDR=VAL... --stdout --host H --port P` | `data.workflow_json` (modified graph), `data.applied`, `data.warnings` |
| `comfy --skip-prompt run --workflow <file> --wait --json` | NDJSON `event/1` lines, then final `envelope/1` |
| `comfy --skip-prompt discover` | Full CLI surface, schemas, error-code registry (~221KB) |
| `comfy --skip-prompt launch -- <comfyui args>` | Starts ComfyUI with passthrough startup args |

**Landmines — every one of these was verified and will silently break naive code:**

1. **`--set` cannot be combined with `--workflow`.** `cmdline.py:945` rejects it: *"--prompt/--set apply to the bundled default workflow and cannot be combined with --workflow"*. Parameterizing a workflow file is **always** two steps: `set-slot` then `run`.
2. **Piped stdout auto-selects JSON mode.** From `set-slot --help`: *"Redirecting stdout selects JSON mode."* An MCP server always pipes, so JSON is implied — but **always pass the mode flag explicitly** so behavior never depends on TTY detection.
3. **Global flags must precede the subcommand.** `--skip-prompt`, `--json-stream`, `--workspace`, `--here`, `--recent` live on the Typer root. `comfy workflow slots --skip-prompt` fails; `comfy --skip-prompt workflow slots` works.
4. **Exit code 1 is overloaded.** Missing file, bad JSON, server down, HTTP 4xx/5xx, conversion failure, validation failure, execution error — all exit 1. **Branch on `error.code` from the envelope, never on exit code.** Exit 130 = cancelled.
5. **Error codes are append-only.** Treat unknown codes as forward-compat (pass through the message), never as a parse failure.
6. **`slots` returns bare `COMBO` with no allowed values** and no min/max on numerics. Constraints come only from `/object_info`. This join is the server's core job.
7. **`--input <object_info.json>` makes `slots`/`set-slot` work offline.** Cache `/object_info` and workflow introspection no longer needs a live server.
8. **Never `comfy launch` when something is already reachable.** Desktop owns port 8188; a second instance fights over VRAM and the shared model dir.
9. **`comfy launch --background` readiness is a log scrape** for the literal string `"To see the GUI go to:"`. Fragile — prefer polling `/system_stats`.
10. **Host `0.0.0.0` must be rewritten to `127.0.0.1`** before use as a connect address.
11. **Killing a child does NOT end a pipe read.** EOF requires every holder of the pipe's write end to close it, and `Bun.spawn` hands that write end to the child *and every descendant*. `proc.kill()` signals one pid, so a surviving grandchild pins the read open indefinitely — measured at 30s against an 800ms timeout. A timeout must cancel the **read side** (hold the reader, call `reader.cancel()`), not merely signal the child. `Bun.spawn({timeout, killSignal})` does not fix this, and `proc.stdout.cancel()` throws because `new Response(stream)` locks the stream. Do **not** fix it with `detached` + process-group kill: that would also kill the intentional long-lived server in Task 4.2.
12. **`Bun.spawn` does not give the child runtime mutations of `process.env`.** It hands over the environment as captured at process start unless `env` is passed explicitly. Verified directly: with `process.env.PROBE` set at runtime, the child sees `default=[]` but `explicit=[hello]` when spawned with `env: process.env`. This is not cosmetic — during Task 1.3 it caused a test fixture to be bypassed and the **real `comfy` binary to be invoked** by the suite. Every spawn in this project must pass `env: process.env`.

---

## Stage 1: Foundation — envelope executor

**Goal**: A tested `runComfy()` that spawns `comfy`, parses `envelope/1`, and maps errors — the substrate everything else sits on.
**Success Criteria**: Executor returns typed success data or a typed error; tests pass without a real ComfyUI or a real `comfy` binary.
**Status**: Not Started

### Task 1.1: Scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore` (exists — verify `dist/` covered), `src/index.ts`

```bash
cd /Users/lawls/Development/TuesdayCrowd/Projects/mcp-comfyui
bun init -y
bun add @modelcontextprotocol/sdk@1.30.0 zod@4.4.3
bun add -d @types/bun typescript
```

`package.json` must include:
```json
{
  "name": "mcp-comfyui",
  "type": "module",
  "bin": { "mcp-comfyui": "./dist/mcp-comfyui" },
  "scripts": {
    "test": "bun test",
    "build": "bun build src/index.ts --compile --outfile dist/mcp-comfyui",
    "typecheck": "tsc --noEmit"
  }
}
```

`--compile` produces a self-contained executable, satisfying the standing rule that JavaScript projects ship as runnable executables.

**Commit:** `chore: scaffold bun + typescript project`

### Task 1.2: Envelope schemas (TDD)

**Files:**
- Create: `src/comfy/envelope.ts`
- Test: `tests/envelope.test.ts`

**Step 1 — failing test:**
```ts
import { expect, test } from "bun:test";
import { parseEnvelope } from "../src/comfy/envelope";

test("parses a success envelope", () => {
  const raw = JSON.stringify({
    schema: "envelope/1", type: "envelope", ok: true,
    command: "workflow slots", version: "0.0.0", where: null,
    data: { slots: [] }, error: null,
  });
  const env = parseEnvelope(raw);
  expect(env.ok).toBe(true);
  expect(env.command).toBe("workflow slots");
});

test("parses a failure envelope and keeps the error code", () => {
  const raw = JSON.stringify({
    schema: "envelope/1", type: "envelope", ok: false,
    command: "run", version: "0.0.0", where: null, data: null,
    error: { code: "workflow_not_found", message: "no such file", hint: "check the path", details: null },
  });
  const env = parseEnvelope(raw);
  expect(env.ok).toBe(false);
  if (!env.ok) expect(env.error.code).toBe("workflow_not_found");
});

test("accepts an unrecognised error code (registry is append-only)", () => {
  const raw = JSON.stringify({
    schema: "envelope/1", type: "envelope", ok: false, command: "run",
    version: "0.0.0", where: null, data: null,
    error: { code: "some_future_code", message: "m", hint: null, details: null },
  });
  expect(() => parseEnvelope(raw)).not.toThrow();
});
```

**Step 2:** `bun test tests/envelope.test.ts` → FAIL, module not found.

**Step 3 — implement:**
```ts
import { z } from "zod";

export const ComfyErrorSchema = z.object({
  code: z.string(),                    // NOT an enum — registry is append-only
  message: z.string(),
  hint: z.string().nullable().optional(),
  details: z.unknown().nullable().optional(),
});

export const EnvelopeSchema = z.object({
  schema: z.literal("envelope/1"),
  type: z.literal("envelope"),
  ok: z.boolean(),
  command: z.string(),
  version: z.string(),
  where: z.string().nullable(),
  data: z.unknown().nullable(),
  error: ComfyErrorSchema.nullable(),
});

export type Envelope = z.infer<typeof EnvelopeSchema>;
export type ComfyError = z.infer<typeof ComfyErrorSchema>;
export type ParsedEnvelope =
  | { ok: true; command: string; data: unknown }
  | { ok: false; command: string; where: string | null; error: ComfyError };

export function parseEnvelope(raw: string): ParsedEnvelope { /* see amendments */ }
export function parseEnvelopeValue(value: unknown): ParsedEnvelope { /* see amendments */ }
```

**Amendments (post-review, 2026-08-03).** Code review mutation-tested the first implementation and found four surviving mutants; these changes were adjudicated and are binding:

1. **`EnvelopeParseError`** — an exported error class carrying the raw output, thrown at *every* failure site in the module. Without it, Task 1.3's executor can only blanket-catch, which swallows its own bugs and misreports them to the user as CLI contract violations.
2. **`where` is preserved on the failure arm** (shown above). It is the CLI's local-vs-cloud routing target, unrecoverable once dropped, and this stage exists to make diagnostics good.
3. **`ComfyErrorSchema` uses `z.looseObject`** so upstream error-field additions survive rather than being silently stripped. Same append-only reasoning as the open `code` string. Top-level envelope stripping stays as-is.
4. **Empty/whitespace stdout gets its own guard** — a killed or timed-out `comfy` is a common real failure and "not valid JSON (received: )" misdirects the reader.
5. **`parseEnvelopeValue(value: unknown)`** is exported alongside the string entry point. Task 3.2 parses NDJSON line by line and will already hold a parsed value; without this it would re-serialize to call a string-only API.

**Mutation testing is a required gate for this module.** These four mutants must each turn the suite red: success path returning `data: null`; `hint`/`details` removed from `ComfyErrorSchema`; `schema` literal weakened to `z.string()`; `type` literal weakened to `z.string()`.

**Step 4:** `bun test tests/envelope.test.ts` → PASS.
**Step 5 — commit:** `feat: parse comfy envelope/1 contract`

### Task 1.3: Subprocess executor with a fake `comfy` (TDD)

Tests must never require a real ComfyUI. Use a fake binary fixture.

**Files:**
- Create: `src/comfy/exec.ts`, `tests/fixtures/fake-comfy`
- Test: `tests/exec.test.ts`

**Fake binary** (`tests/fixtures/fake-comfy`, `chmod +x`): echoes a canned envelope chosen by `$FAKE_COMFY_MODE`, and writes its argv to `$FAKE_COMFY_ARGV_OUT` so tests can assert on flag ordering.

```sh
#!/bin/sh
[ -n "$FAKE_COMFY_ARGV_OUT" ] && printf '%s\n' "$*" > "$FAKE_COMFY_ARGV_OUT"
case "$FAKE_COMFY_MODE" in
  fail) echo '{"schema":"envelope/1","type":"envelope","ok":false,"command":"run","version":"0.0.0","where":null,"data":null,"error":{"code":"server_unreachable","message":"connection refused","hint":"is ComfyUI running?","details":null}}'; exit 1 ;;
  garbage) echo 'not json at all'; exit 1 ;;
  *) echo '{"schema":"envelope/1","type":"envelope","ok":true,"command":"workflow slots","version":"0.0.0","where":null,"data":{"slots":[]},"error":null}'; exit 0 ;;
esac
```

**Tests to write (each its own `test()`):**
1. Success envelope → resolves with `data`.
2. `ok:false` → rejects with a `ComfyCliError` carrying `.code === "server_unreachable"` and the hint.
3. Non-JSON stdout → rejects with a diagnostic naming the command, **not** a raw `SyntaxError`.
4. **Global flags precede the subcommand** — assert the captured argv starts with `--skip-prompt` before `workflow`. This encodes landmine #3 as a regression test.

**Implementation notes for `runComfy()`:**
- Signature: `runComfy(args: string[], opts?: {timeoutMs?: number; cwd?: string}): Promise<unknown>`
- Always prepend `--skip-prompt`; binary path from `COMFY_BIN` env, default `comfy`.
- Parse **stdout only**. Per `docs/json-output.md:28-42`, stderr carries human text and must never be parsed.
- On non-zero exit **with** a parseable `ok:false` envelope, throw `ComfyCliError` from the envelope — the envelope is more informative than the exit code (landmine #4).
- Enforce `timeoutMs` (default 120_000) and kill the child on expiry.

**Commit:** `feat: comfy subprocess executor with typed errors`

---

## Stage 2: Introspection — the slots × object_info join

**Goal**: `describe_workflow` produces a JSON Schema with real enums and bounds.
**Success Criteria**: For `default_image_gen.json`, `sampler_name` is an enum of ~44 samplers and `steps` carries `minimum:1, maximum:10000`.
**Status**: Not Started

### Task 2.1: object_info cache

**Files:** Create `src/comfy/objectInfo.ts`; Test `tests/objectInfo.test.ts`

Fetch `GET http://{host}:{port}/object_info`, cache to disk (`~/.cache/mcp-comfyui/object_info-{host}-{port}.json`) with a TTL, expose `getObjectInfo({host,port,refresh})`. The on-disk copy is what feeds `--input` for offline `slots`/`set-slot` (landmine #7).

Tests use a fixture JSON, not the network. Include a test that a corrupt cache file is discarded rather than thrown from.

**Commit:** `feat: cache ComfyUI object_info`

### Task 2.2: Slot listing

**Files:** Create `src/workflows/slots.ts`; Test `tests/slots.test.ts`

`listSlots(file, {host, port, objectInfoPath})` → `runComfy(["workflow","slots",file,...])` → validate `data.slots[]` with zod → typed `Slot[]`.

**Commit:** `feat: list workflow slots`

### Task 2.3: Schema synthesis — the core value-add

**Files:** Create `src/workflows/describe.ts`; Test `tests/describe.test.ts`

Join each slot against `objectInfo[node_type].input.required[name]` (fall back to `.optional`). The object_info input spec is a 2-tuple `[type, config]` where `type` is either a string (`"INT"`) or an **array of allowed values** (the COMBO case).

**Step 1 — failing test** (use a real captured `object_info` fixture for `KSampler`):
```ts
test("COMBO slots become enums", () => {
  const schema = describeSlots(slots, objectInfo);
  expect(schema.properties["3.sampler_name"].enum).toContain("euler");
  expect(schema.properties["3.sampler_name"].enum).toContain("dpmpp_2m");
});

test("INT slots carry bounds and defaults from object_info", () => {
  const schema = describeSlots(slots, objectInfo);
  expect(schema.properties["3.steps"]).toMatchObject({
    type: "integer", minimum: 1, maximum: 10000,
  });
});

test("tooltips become descriptions", () => {
  const schema = describeSlots(slots, objectInfo);
  expect(schema.properties["3.cfg"].description).toContain("Classifier-Free Guidance");
});

test("a slot whose node_type is absent from object_info degrades to bare type", () => {
  const schema = describeSlots([customSlot], {});
  expect(schema.properties["99.foo"]).toMatchObject({ type: "string" });
  // must NOT throw — custom nodes are normal
});
```

Type mapping: `INT`→`integer`, `FLOAT`→`number`, `STRING`→`string`, `BOOLEAN`→`boolean`, array-of-values→`enum`. Carry through `min`→`minimum`, `max`→`maximum`, `step`→`multipleOf` (only when it divides the range cleanly), `default`→`default`, `tooltip`→`description`. Always set `current_value` as the schema `default` when object_info has none — it is what the workflow author chose.

**Commit:** `feat: synthesise JSON Schema from slots and object_info`

### Task 2.4: Workflow discovery

**Files:** Create `src/workflows/discover.ts`, `src/config.ts`; Test `tests/discover.test.ts`

Scan configured roots (default `/Users/lawls/ComfyUI-Shared/user/default/workflows`, override via `MCP_COMFYUI_WORKFLOW_DIRS`, colon-separated) for `*.json`. For each, cheaply classify **without** a full parse where possible: frontend format has `nodes` + `links`; API format has a value containing `class_type`. Report `{name, path, format, node_count, size_bytes, modified}`.

Test with fixtures covering: frontend, API-format, `.app.json` with `definitions`, and a malformed JSON file (must be reported as `format: "invalid"`, not crash the listing).

**Commit:** `feat: discover workflow files`

---

## Stage 3: Execution

**Goal**: `run_workflow(name, inputs)` executes and returns output paths.
**Success Criteria**: A real 4-step run against the live Desktop instance produces an image on disk.
**Status**: Not Started

### Task 3.1: Apply inputs

**Files:** Create `src/workflows/setSlots.ts`; Test `tests/setSlots.test.ts`

`applySlots(file, inputs)` → `comfy workflow set-slot <file> ADDR=VAL... --stdout` → return `data.workflow_json`, surfacing `data.warnings`.

**Never pass `--in-place`** — the user's workflow files are inputs, not scratch space. Write the returned graph to a temp file under the scratch dir.

Value encoding matters: numbers unquoted, strings raw (`6.text=a photo of a cat`). Test that a value containing `=` survives (split on the **first** `=` only) and that a multiline prompt round-trips.

**Commit:** `feat: apply slot overrides to a workflow`

### Task 3.2: Execute and collect outputs

**Files:** Create `src/workflows/run.ts`; Test `tests/run.test.ts`

`comfy --skip-prompt run --workflow <tmpfile> --wait --json`. In `--json` mode stdout is NDJSON: zero or more `event/1` lines, then the final `envelope/1`. Parse **line by line**; the last envelope line is the result. Do not `JSON.parse` the whole stdout.

Completed payload keys (verified in `run/__init__.py:359-445`): `outputs`, `outputs_by_node`, `outputs_by_item`, `cached_node_ids`, `executed_node_ids`, `elapsed_seconds`, `prompt_id`.

Per `run/execution.py:352-375`: on a loopback host with a resolvable workspace, `outputs[]` entries are **absolute filesystem paths**; otherwise they are `/view?...` URLs. Per `docs/json-output.md:253`, treat any non-`http(s)` value as a filesystem path. Return both forms distinctly so the caller is never guessing.

**Commit:** `feat: execute workflows and collect outputs`

### Task 3.3: Job tools

**Files:** Create `src/comfy/jobs.ts`; Test `tests/jobs.test.ts`

Wrap `comfy jobs ls` / job watching and `comfy` cancellation. Async submit (no `--wait`) is `comfy run`'s **default**, returning `prompt_id` with `status:"queued"` — expose that as the job handle.

**Commit:** `feat: job status and cancellation`

---

## Stage 4: Instance lifecycle

**Goal**: Detect a running ComfyUI; only launch one when nothing is reachable.
**Success Criteria**: With Desktop running, `comfy_status` reports it and `launch_comfyui` refuses with a clear message rather than starting a competing process.
**Status**: Not Started

### Task 4.1: Detection

**Files:** Create `src/comfy/instance.ts`; Test `tests/instance.test.ts`

`detectInstance({host,port})` → `GET /system_stats` with a short timeout. Returns `{running, comfyui_version, device, argv, output_directory, input_directory}` parsed from the response. Rewrite `0.0.0.0`→`127.0.0.1` (landmine #10).

Verified live shape: `system.comfyui_version`, `system.argv`, `devices[0].{name,type,vram_total,vram_free}`.

Include a test that a connection refusal yields `{running:false}` rather than a thrown error.

**Commit:** `feat: detect running ComfyUI instance`

### Task 4.2: Guarded launch

**Files:** Modify `src/comfy/instance.ts`; Test `tests/instance.test.ts`

`launchInstance({args, background})`:
1. `detectInstance()` first. **If running, refuse** and return the existing instance's details. This is the guard against fighting Desktop (landmine #8).
2. Otherwise `comfy --skip-prompt launch -- <args>`. Startup args are trailing positionals after a bare `--`; there is **no** `--extra-args` flag.
3. Poll `/system_stats` for readiness rather than scraping logs for `"To see the GUI go to:"` (landmine #9).

Expose a curated allowlist of common startup args (`--listen`, `--port`, `--lowvram`, `--novram`, `--highvram`, `--cpu`, `--output-directory`, `--input-directory`, `--extra-model-paths-config`, `--disable-auto-launch`, `--verbose`) plus a free-form `extra_args: string[]` escape hatch.

**Commit:** `feat: guarded ComfyUI launch with startup args`

---

## Stage 5: MCP surface and packaging

**Goal**: Working stdio server, registered and documented.
**Success Criteria**: `claude mcp add` connects; `list_workflows` → `describe_workflow` → `run_workflow` succeeds end to end.
**Status**: Not Started

### Task 5.1: Tool registration

**Files:** Create `src/server.ts`; Modify `src/index.ts`

Six tools, per the small-surface one-tool-per-action pattern:

| Tool | Annotation | Purpose |
|---|---|---|
| `comfy_status` | readOnly | Instance reachable? version, device, dirs |
| `list_workflows` | readOnly | Enumerate discovered workflow files |
| `describe_workflow` | readOnly | JSON Schema of that workflow's settable inputs |
| `run_workflow` | **not** readOnly | Apply inputs and execute |
| `get_job` | readOnly | Poll an async run |
| `cancel_job` | **not** readOnly | Interrupt a run |

`launch_comfyui` is deliberately **omitted from the default tool list** — starting a GPU process is not something Claude should do unprompted. Gate it behind `MCP_COMFYUI_ALLOW_LAUNCH=1`.

Tool descriptions must state the two-step reality: *"Call `describe_workflow` first to learn valid input addresses and value constraints; `run_workflow` inputs are keyed by slot address such as `3.seed`."*

**Commit:** `feat: register MCP tools over stdio`

### Task 5.2: Build, register, document

```bash
bun run build          # -> dist/mcp-comfyui, self-contained
claude mcp add comfyui /Users/lawls/Development/TuesdayCrowd/Projects/mcp-comfyui/dist/mcp-comfyui
```

Rewrite `README.md` (currently one line) and replace the "unscaffolded" section of `CLAUDE.md` with real build/test/run commands and the landmine list above.

**Commit:** `docs: usage, configuration, and architecture`

---

## Out of Scope

Deliberately excluded; revisit only on request:
- Cloud routing (`--where cloud`) and Comfy Cloud auth
- `comfy workflow fragment` composition and `vary`
- Model/custom-node installation (`comfy model`, `comfy node`)
- Building workflows from scratch — this server runs and parameterizes existing ones
- MCP app widgets / elicitation

## Risks

| Risk | Mitigation |
|---|---|
| comfy-cli changes its CLI surface | `comfy discover` is a stable machine contract with upstream regression tests written for MCP consumers; pin a known-good version and assert the envelope schema at startup |
| Local tree reports `version: "0.0.0"` | Never version-gate on it; if needed, switch to PyPI 1.13.0 |
| `object_info` is large (multi-MB) | Cache on disk with TTL; reuse via `--input` |
| Long video workflows exceed timeouts | Default to async submit + `get_job` polling for anything not explicitly `wait:true` |
| Desktop restarts on a different port | Detect per call rather than caching the instance address |
