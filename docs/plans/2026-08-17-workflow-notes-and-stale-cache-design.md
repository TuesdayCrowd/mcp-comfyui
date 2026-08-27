# Telling a stuck caller what to do next

**Status:** implemented on 2026-08-18 — merged in PR #22 (`638165c`), released in
0.6.11, with follow-ups in 0.7.0 (`a064ce6`). This document is kept as the record
of the decisions and the ground truth behind them, not as a description of the
code; where the two differ, the code, `CLAUDE.md` and
`docs/comfy-cli-ground-truth.md` are current.
**Date:** 2026-08-17

**An audit against the shipped code found no corrected measurements.** Every
figure in the ground-truth sections below became `docs/comfy-cli-ground-truth.md`
#32–#34, and nothing since amends them. **Four places where the implementation
went a different way**, none of which disturbs the reasoning here:

- **`WorkflowNote` drops `pos` and `size`.** Shipped as `{id, type, title, text,
  subgraph}` (`notes.ts:63-70`). The CLI still sends all seven keys and ground
  truth #32 still records that — canvas coordinates simply mean nothing to an
  MCP caller, so zod strips them.
- **`notes_count` is a wire key this document never proposes.** It arrived three
  days after the release, in `a064ce6`/0.7.0, so that a caller can tell how many
  notes were withheld: `notes_count - notes.length`.
- **The caps are the implementation's own numbers.** `MAX_NOTES = 24` and
  `MAX_NOTE_TEXT = 8_000` (`notes.ts:36-37`); this document asked only that the
  payload be capped and the truncation made visible, giving no figures.
- **`NOTES_TIMEOUT_MS = 15_000` is a post-design bugfix** (`tools.ts:145`), not
  something anticipated here. The first landing let a hung `workflow notes` hold
  the whole `describe_workflow` response for `runComfy`'s full default.

One paragraph below is **stale within this document itself**, and is marked where
it sits.

`validate_workflow` can already tell you that seven of a workflow's inputs name
a model this host does not have. It cannot tell you where to get them, and on a
machine whose ComfyUI is stopped and whose cache has aged past a day, it cannot
tell you anything at all.

This document is the design for closing those two gaps. It is small on purpose,
and it is smaller than the brief it came from: the survey behind it began as
three new tools — workflow notes, node introspection, model discovery — and
measurement removed two of them, because `validate_workflow` already answers
what they were meant to answer. What is left is one new capability, one
behavioural floor, and two sentences of tool description.

It has also been through one adversarial review, which found a blocking defect
in §2 and a wrong figure in Ground Truth §1. Both are fixed below, and §2
records the mistake rather than quietly correcting it, because the wrong
approach looked obviously right.

## Which comfy produced these numbers

Behavioural claims below were executed on **2026-08-17** against the installed
`comfy`; source claims were read at this repo's working tree.

```
installed : ~/.local/bin/comfy
          → ~/.local/share/uv/tools/comfy-cli/bin/comfy
version   : 0.0.0   (upstream's own placeholder; substituted only by
            comfy-cli's release pipeline, so every non-pipeline build ships
            it verbatim — not evidence of a broken install)
built from: ~/Development/TuesdayCrowd/Projects/ComfyUI/comfy-cli
            git describe → v1.15.0-1-g220f99a
installed : 2026-08-02; checkout has moved since (pyproject mtime 2026-08-09),
            so subcommands added upstream after 2026-08-02 are not in this build
```

No ComfyUI was running for any measurement (`curl 127.0.0.1:8188/system_stats`
→ connection refused), which is the state the whole design is about.

## Ground truth

### 1. A workflow can be seven models short and look clean

`describe_workflow` against this machine's own cached node definitions, on the
gallery template `video_wan2_2_14B_i2v` that `create_workflow_from_template`
wrote here:

```
slots: 58   unresolved: 0   inert: 14   properties: 44
```

Which reproduces CLAUDE.md's own "Verified end to end" record for this exact
workflow — 44 settable, 14 inert, 0 unresolved — from an independent run.

Nothing is unresolved, because the enums are not *empty* — they are *wrong*.
Seven of those 44 properties hold a `default` that is absent from their own
`enum`, and none of the seven is among the fourteen decoys:

```
97.image          wants video_wan2_2_14B_i2v_input_image.jpg   (9 files here, not that one)
129/90.vae_name   wants wan_2.1_vae.safetensors                (3 here)
129/84.clip_name  wants umt5_xxl_fp8_e4m3fn_scaled.safetensors (5 here)
129/96.unet_name  wants wan2.2_i2v_low_noise_14B_fp8_scaled…   (4 here)
129/95.unet_name  wants wan2.2_i2v_high_noise_14B_fp8_scaled…  (4 here)
129/102.lora_name wants wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise…  (1 here)
129/101.lora_name wants wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise… (1 here)
```

This is `describe.ts:376-383` behaving exactly as documented — a `default` that
disagrees with its enum is kept deliberately, because "the workflow's stored
model is precisely what a no-input run will try to load, missing or not."

### 2. `validate_workflow` already reports all seven

```
comfy --json validate --workflow video_wan2_2_14B_i2v.json --input <this host's object_info>
→ ok:false, error_count 7, warning_count 19
  {"node_id":"129:95","field":"unet_name","code":"unknown_enum_value",
   "message":"'wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors' not in 4 known options for unet_name",
   "hint":"valid options include: Chroma1-Radiance…, qwen_image_fp8…"}
```

Same seven addresses, per-host, with the installed alternatives in the hint.
**This is the per-host model inventory, delivered in context.** It is why the
node-introspection and model-discovery tools this design started with were cut
(see Non-goals).

### 3. Nothing says where to get them — except the workflow itself

`comfy --json workflow notes <file>` on that same file:

```json
{"ok": true, "command": "workflow notes",
 "data": {"workflow": "…/video_wan2_2_14B_i2v.json", "count": 2,
          "notes": [{"id": 105, "type": "MarkdownNote", "title": "VRAM Usage",
                     "text": "## GPU:RTX4090D 24GB\n\n| Model | Size | VRAM Usage | …",
                     "pos": [-560, 400], "size": [479.98, 259.98], "subgraph": null},
                    {"id": 66, "type": "MarkdownNote", "title": "Model Links",
                     "text": "[Tutorial](https://docs.comfy.org/…)\n\n**Diffusion Model**\n- [wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors](https://huggingface.co/…)…"}]}}
```

The "Model Links" note carries a HuggingFace URL for **exactly the files
validate reported missing**. The "VRAM Usage" note carries the other thing a
caller cannot otherwise learn: this workflow is ≈536s on a 4090, or ≈97s with
the 4-step LoRA.

Measured properties of the command:

- **No server, no host, no object_info.** It is a local frontend-JSON parser.
  Ran successfully with nothing listening anywhere. Takes no `--host`/`--port`/
  `--where`/`--input` flags at all (`comfy --help-json`).
- **0.33s** wall clock, three runs (0.33 / 0.32 / 0.32), against an 84KB file.
  The floor is Python/Typer start-up, not payload — `nodes ls` against a 1.4MB
  input measured 0.37s.
- Payload is `{workflow, count, notes[]}`. Note is exactly seven keys:
  `{id, type, title, text, pos, size, subgraph}`. **There is no `id` field on
  the payload** — unlike the `slots` payload, which has both `workflow` and
  `id`. Do not assume parity between the two.
- `text` is exactly the raw node's `widgets_values[0]`; `flags`, `order`,
  `mode`, `properties`, `color`, `bgcolor` are stripped by the CLI.
- Zero notes is `{count: 0, notes: []}`, exit 0 — not an error.
- Two error codes, both exit 1: `workflow_not_found` and
  `workflow_not_frontend_format`. The latter fires identically for an
  API-format workflow and for JSON that is not a workflow at all — the CLI does
  not distinguish them, and its own message already names the fix.
- **On any failure the envelope's `command` collapses from `"workflow notes"`
  to `"workflow"`.** Measured for `workflow slots` too, so this is a
  `comfy workflow` group behaviour. Never branch on it; branch on `error.code`,
  as `slots.ts:165` already does.
- Global flags still precede the subcommand: `comfy workflow notes --json <f>`
  fails exit 2 "No such option: --json". Non-negotiable #4 holds for this
  brand-new subcommand with no exception.

Of four real frontend workflows tested, two carry notes; of the four notes
found, two carry model-download URLs, one is a pure VRAM/timing table, one is
prose. One URL-bearing note also embeds GitHub issue links alongside the model
links, so a naive "first URL wins" extraction would sometimes surface a bug
tracker. **This design extracts nothing — it carries the text.**

### 4. Both diagnostic tools fail on a stopped machine after 24 hours

```
cache on disk: 1449222 bytes, 13.4 days old
getObjectInfo THREW: ObjectInfoFetchError —
  could not read node definitions from http://127.0.0.1:8188/object_info: fetch failed
```

`readCache` returns `null` whenever `age >= ttlMs`, default 24h
(`objectInfo.ts:223-235`, `DEFAULT_TTL_MS` at `:23-29`). Past that, a complete
and almost certainly correct 1.4MB per-host copy on disk is treated as absent.
`describe_workflow` and `validate_workflow` then either throw, or — with
auto-launch on — start a GPU process to rebuild what the disk already holds.

The counter-argument is written in `objectInfo.ts` itself: "The payload only
changes when custom nodes or models are installed … so a day-old copy is
normally identical to a fresh one." That reasoning does not stop at 24 hours.
The opposing argument is written there too, on `ensureObjectInfoCache:371-377`:
"a year-old file feeds `--input` as happily as a current one … with nothing to
say so." Both are right, and together they specify the fix: **serve it, and say
how old it is.**

## Non-goals

Recorded because they were proposed, investigated, and cut on evidence.

**Node introspection (`nodes show` / `search` / `ls`).** Cut. Per-host
divergence is real — the two hosts here differ by 828 vs 825 classes, seven
local-only, four remote-only, with disjoint checkpoint enums — but for a
*diagnostic* caller `validate_workflow` already reports a missing class, and
close-matching is the wrong medicine for this population: workflow files are
written by ComfyUI, so their class names are real, just not installed here.
Measured accordingly — `nodes show NoSuchNodeXYZ` returns an **empty**
`close_matches`; only a hand-typed near-miss (`KSamplerr`) populates it.

Two hazards would have come with it, noted so a future attempt does not
rediscover them: `nodes show KSampler` returns `options.max:
18446744073709551615`, which `JSON.parse` rounds to `…552000` — landmine #1 in
a fourth place, requiring the same `clampIntegerBound` treatment
`describe.ts:294` already applies. And `nodes ls` unfiltered is 133KB / 828
rows with **no CLI-side default limit** (`upstream` 266 rows, `downstream` 208,
`categories` 201; only `search` self-caps, at 20).

**Model discovery.** Cut. `comfy models` is 100% non-functional without a
running server — `list-folders`, `list-folder`, and `search` all return
`server_not_running`, and `show` returns `models_show_local_unsupported`
because it is cloud-only. The cache alternative would have to hardcode an
unverifiable `ckpt_name → checkpoints/` convention that exists nowhere in the
data. And it would restate, out of context, what validate's `hint` already
lists in context. On a single host — the scope chosen for this work — "which
checkpoints exist" when the enum is empty answers "none, which is why it is
unresolved."

**Cross-host comparison.** Out of scope by decision. Every tool keeps the
existing single-`host` semantics.

**Duplicating validate's enum check inside `describe.ts`.** Rejected on house
style. `describe.ts:620` states the rule: two answers to one question with no
rule for which wins. `validate` is the authority; `describe` points at it.

## §1 — `notes` on `describe_workflow`

### New module: `src/workflows/notes.ts`

Mirrors `slots.ts`, and is simpler than it, because the CLI needs no schema
source:

```ts
export interface WorkflowNote {
  id: number;
  /** Open string. `MarkdownNote` is all that has been observed; the CLI's own
   *  help documents plain `Note` too. Never a closed enum. */
  type: string;
  title: string;
  /** Raw markdown, verbatim. Nothing is extracted from it. */
  text: string;
  pos: readonly [number, number];
  size: readonly [number, number];
  /** Null on every note measured. Its populated shape is UNMEASURED — see Risks. */
  subgraph: unknown;
}

export async function listNotes(workflowPath: string): Promise<{
  count: number;
  notes: WorkflowNote[];
}>;
```

Implementation is `runComfy(["workflow", "notes", workflowPath])` plus a zod
payload schema `{workflow: string, count: number, notes: NoteSchema[]}`.
`count` is recomputed from the array, as `slots.ts:202` already does for slots,
rather than trusted from the field.

No `host`, no `port`, no `objectInfoPath`, and therefore **no fourth copy of
`schemaSourceArgs`** — which resolves one of the survey's open questions in the
comfortable direction.

### Error handling

Nothing new is required:

- `workflow_not_found` is already a first-class `ToolErrorKind`
  (`toolResult.ts:82`, mapped at `:440` and `:465`).
- `workflow_not_frontend_format` already has enrichment in
  `slots.ts:144-151` (`apiFormatGuidance`), whose text applies word for word —
  the CLI's own message says `comfy workflow` generically, not `slots`.

### Where it lands

A fourth flat sibling on `WorkflowDescription` and on `describe_workflow`'s
response, beside `schema` / `unresolved` / `inert`. `describe.ts:128-146`
justifies those three as siblings because they serve three audiences; notes are
a fourth — someone trying to understand what the workflow is *for*, and what it
needs, before looking at a single slot. It must not nest inside `schema`, which
is handed to a validator as a standalone JSON Schema document.

Adding a top-level key is additive: an existing consumer reading `target`,
`workflow`, `slot_count`, `schema`, `unresolved`, `inert` by name cannot break.

### Failure is not fatal

A notes failure degrades to `notes: []` plus `notes_unreadable`, a string
carrying the reason. Following the `remote_unreadable` precedent in
`list_workflows` (`tools.ts:1275`), that key is **absent on success** — not
empty, not null. Absence is structural, exactly as with `outputs.local_paths`.

It lives on the tool response only, not on `WorkflowDescription`. `describeSlots`
is a pure function over data the caller already fetched and has no business
holding a subprocess's failure; `notes` itself lands on both, because it is
part of the description.

This matches `describe.ts`'s stated philosophy — "Nothing here is fatal, because
the alternative is that one uninstalled custom node makes a 210-slot workflow
undescribable." In practice the call cannot fail for format reasons: `listSlots`
would already have rejected a non-frontend file.

### Bounded, like `events`

`notes[].text` is free-form markdown authored by whoever wrote the workflow,
arriving from a public gallery through `create_workflow_from_template`. Nothing
in the CLI or the file format bounds it. The largest payload measured on this
machine is ~2.9KB total (the 84KB `video_wan2_2_14B_i2v`; ~1.8KB on the 121KB
`templates-6-key-frames`), but that is a sample of well-behaved templates, not
a bound.

So it is capped, with the truncation made visible — the same treatment
`run_workflow` already gives CLI events (`MAX_EVENTS = 200` at `run.ts:68`,
surfaced as `events_truncated` at `tools.ts:897`). `count` remains the true
total, and `notes_truncated` says the list was cut.

### Cost: concurrent, not additive

`listNotes`, `listSlots` and `inertInputsOfFile` all take only the resolved file
path, and none consumes another's output. Run sequentially, notes would roughly
double `describe_workflow`'s wall clock — measured on the same 84KB fixture,
`workflow notes` is 0.32-0.34s and `workflow slots --input` is 0.35-0.36s, both
dominated by Python start-up. Run concurrently they overlap almost entirely, so
the added cost is close to zero.

They are therefore issued together. Not `Promise.all`, which would let a notes
rejection take the whole description down and defeat the degradation above:
notes is awaited with its failure already caught, so the group settles on the
slots/inert result regardless. No `notes: boolean` knob — YAGNI, and a caller
cannot choose well.

### Remote workflows come free

`describe_workflow` already stages a host's own saved workflow to a temp file
(`stageWorkflow`, `tools.ts:1503`), and `listNotes` takes a path. Notes work on
remote workflows with no extra code.

### Cost

+330ms per `describe_workflow` call, unconditionally, on a call that already
spawns `comfy workflow slots` and may fetch 1.4MB. No `notes: boolean` knob —
YAGNI, and a caller cannot choose well.
**[Stale, and superseded inside this document by "Cost: concurrent, not additive"
above. What shipped is concurrent: `tools.ts:1857` joins `listSlots`,
`inertInputsOfFile` and `listNotes` in one `Promise.all`, so the three overlap
instead of adding and the measured cost is close to zero. Read the concurrent
figure, not this one. The `notes: boolean` decision itself stands.]**

## §2 — A stale-cache floor

### It needs a cache-only read, which does not exist yet

An earlier draft of this design proposed reaching for `ttlMs: Infinity`, since
`ObjectInfoOptions` already carries `ttlMs` and `readCache`'s test is
`age >= ttlMs`. **That is wrong, and it is worth recording why**, because the
option looks sufficient and is not.

`getObjectInfo` (`objectInfo.ts:334-369`) is not a cache read. When `readCache`
misses — file absent, truncated, unparseable, future-dated — it falls straight
through to a live HTTP fetch, whatever `ttlMs` said. So the retry would:

- perform a **second** 30-second fetch against the address that just failed,
  before re-throwing — doubling the failure latency for the cold-start caller,
  and contradicting `withObjectInfo`'s own documented reasoning that re-fetching
  "would just produce the same error a second time";
- and, if that second fetch happened to succeed, report `stale: true` with
  `age_hours` near zero, because `writeCache` had just refreshed the mtime.

What §2 needs is a primitive the module does not have: a read that consults the
disk and **never** fetches.

```ts
/** Whatever is on disk, at any age. Never fetches. `null` if there is nothing
 *  usable — the same every-failure-is-a-miss contract as `readCache`. */
export async function readStaleCache(
  location: ObjectInfoLocation,
): Promise<{ objectInfo: ObjectInfo; path: string; ageMs: number } | null>;
```

It returns the **path** as well as the definitions, which is what closes the
second half of the gap below.

### The order

Stale is the **last** resort, so nothing regresses:

```
fresh cache  →  live fetch  →  launch + refetch (auto-launch, local host only)  →  stale cache
```

Today that final arrow is `throw`. Auto-launch keeps its present meaning
exactly; freshness still wins whenever a GPU is available; the only change is
that the failure case now answers instead of failing.

Which error survives when everything fails is stated explicitly, because the
existing code already makes this choice once and the fallback must not
silently reverse it: if the post-launch refetch throws, **that** error is the
one preserved, not the pre-launch one. It reflects a confirmed-running instance
and is the better diagnosis, by the same standard `withObjectInfo`'s
`already_running` branch already applies.

### Changes

1. `objectInfo.ts` gains `readStaleCache` as specified above. `readCache`,
   `getObjectInfo` and the TTL logic are untouched, and `DEFAULT_TTL_MS` keeps
   its present meaning for every existing caller.
2. `tools.ts`'s `withObjectInfo` (`:921-939`) grows a final fallback: on a
   surviving `ObjectInfoFetchError`, call `readStaleCache(location)`. A hit
   returns the definitions, the path, and the age. A miss re-throws the
   surviving error immediately, with **no** further network attempt.
   `withObjectInfo`'s return type widens from `ObjectInfo` to
   `{ objectInfo, stale?: { ageMs, path } }`.
2b. **`validate_workflow` must consume that same result.** It currently calls
   `withObjectInfo` and then, on the next line, `ensureObjectInfoCache(location)`
   to get the path for `--input` (`tools.ts:1564-1565`). That second call carries
   no `ttlMs`, re-runs the identical 24h freshness check, re-fetches, and throws —
   so patching only `withObjectInfo` would leave `validate_workflow` broken in
   exactly the scenario Ground Truth §4 describes. It takes the path from
   `withObjectInfo`'s result when that result is stale, and calls
   `ensureObjectInfoCache` only when it is not. **This is the whole reason
   `readStaleCache` returns a path.**
3. `describe_workflow` and `validate_workflow` gain an `object_info` block in
   their response **only when served stale**:

   ```json
   "object_info": {"stale": true, "age_hours": 321.6,
                   "path": "~/.cache/mcp-comfyui/object_info-127.0.0.1-8188.json"}
   ```

   Absence means fresh. Structural, not inferred — the same convention
   `outputs.local_paths` already uses.

### Annotations

No change. Both tools keep `readOnlyHint: !config.autoLaunch`: the launch
branch still precedes the stale fallback, so the tool can still start ComfyUI.

### What staleness is biased toward, said out loud

This is the design's real cost and the spec should not bury it. `/object_info`
changes when something is **installed**. So a stale copy under-reports what
exists: it can hide an addition, and it essentially cannot invent one. The
characteristic wrong answer is therefore *"that model is missing"* about a
model that is in fact present — and that lands on precisely the caller this
feature is for, someone who put a file in `models/` and has no ComfyUI running
to confirm it.

That is a worse *kind* of wrong than the hard error it replaces: a hard error
misleads nobody, while a confident false "invalid" can send an agent off to
re-download a model it already has. The judgement is that a bounded, disclosed
wrong answer beats a blanket refusal — most stale reads are correct, the
`age_hours` figure is right there, and the alternative leaves the tool useless
in its own motivating scenario. But it is a judgement, not a free win, and it
is why the disclosure is mandatory rather than decorative: both tools'
descriptions must tell the calling model what a stale block implies — that a
model installed within `age_hours` will not appear, and that re-running once
ComfyUI is reachable is what confirms it.

## §3 — Two sentences of tool description

Tool-description changes only, but they are load-bearing, and the codebase
already asserts description text in tests (`server.test.ts:2195, 2217-2218`).

**`describe_workflow` points at `validate_workflow`.** A clean answer is not a
promise the run will work: a `default` may name a model this host does not
have, `describe` reports it as an ordinary property with a value, and
`validate_workflow` is what says so. Ground truth §1 is the worked example —
44 properties, 0 unresolved, 7 that will fail.

**`describe_workflow` says what `notes` is.** The text comes from whoever
authored the workflow — for a gallery template, a stranger on the internet. It
is reference material, not instruction: it may contain URLs and imperative
prose, and neither this server nor its caller should act on it as direction.
The server already surfaces third-party strings (template titles and
descriptions), but notes are a markedly larger and more instruction-shaped
surface, which is why it is named rather than assumed.

## Testing

Per the house standard, each behaviour gets a constructed mutant and the test
must die on it.

**§1**
- `tests/fixtures/fake-comfy` gains an **append-only** mode for
  `workflow notes` — existing modes are never edited.
- A captured-fixture test: two `MarkdownNote`s decode with all seven fields,
  text byte-exact including embedded newlines and markdown tables.
- A hand-built adversarial fixture: a note whose `type` is a value absent from
  today's vocabulary is **carried, not refused** — mirroring
  `templates.test.ts:93-104` and `validate.test.ts:112-120`. Rule-shaped
  behaviour needs constructed input; a healthy install cannot produce it.
- A zero-notes workflow yields `notes: []` and is not an error.
- `workflow_not_frontend_format` reaches the caller enriched, not as
  `internal_error` — the `UserdataError` regression this repo already paid for
  once.
- Failure of notes does not fail `describe_workflow`: the response still
  carries `schema`, with `notes_unreadable` set — and `notes_unreadable` is
  **absent** on the success path.
- An oversized constructed fixture is capped, `notes_truncated` is set, and
  `count` still reports the true total.
- A `host`ed workflow staged to a temp file reports notes read from that file,
  pinning the "remote workflows come free" claim.

**§2**
- A cache file back-dated past the TTL, with no server reachable, is served —
  and the response carries `stale: true` with a plausible `age_hours`.
- A fresh cache is served with **no** `object_info` block (absence means fresh).
- Ordering: with auto-launch on and a launchable local host, the launch path is
  still taken before the stale fallback.
- **`validate_workflow` specifically** — not just `describe_workflow` — answers
  from a back-dated cache. This is the test that would have caught the
  `ensureObjectInfoCache` gap, and it must fail against a build that patches
  only `withObjectInfo`.
- When the cache is absent entirely and the fetch fails, the surviving
  `ObjectInfoFetchError` is thrown **and no second fetch is attempted** —
  asserted by argv capture / request count, not by the error alone, since the
  error is identical either way.
- Tests keep pointing `MCP_COMFYUI_HOSTS_FILE` and the cache dir inside their
  own temp directories, and diff against a `beforeEach` snapshot rather than
  sweeping a shared prefix.

**§3**
- `describe_workflow`'s registered description mentions `validate_workflow`,
  and says notes are the workflow author's text rather than instruction —
  `expect(description).toContain(...)`, the pattern already used at
  `server.test.ts:2195` and `:2217-2218`.
- Both tools' descriptions explain what a stale `object_info` block implies.

## Risks and open questions

1. **`notes[].subgraph` has never been observed populated.** Every note
   measured is `subgraph: null`, and the one subgraph definition inspected (30
   nodes) contains no note. Its populated shape — string id, nested object,
   path-like address — is unknown. The field is therefore typed permissively and
   passed through rather than parsed. Closing it later is additive; guessing now
   is a landmine. This is the one genuinely unmeasured thing in the design.
2. **Plain `Note` nodes are unobserved.** The CLI's help documents them; no
   file here has one. `type` stays `z.string()`.
3. **Serving arbitrarily old definitions trades a safe failure for an
   unsafe-looking success.** Accepted deliberately, argued in §2's "What
   staleness is biased toward" — the wrong answer it can produce is "missing"
   about a model that is present, which is exactly the caller it was built for.
   Mitigated by the disclosure, by being the last resort, and by the fact that
   the alternative is a tool that refuses to work at all. Revisit if a real
   caller is ever misled by it; a staleness ceiling is the fallback, at the cost
   of reinstating the hard error past that age.
4. **A note is untrusted text from a workflow file**, and the risk is not to
   this server — it is to the model reading the response. Nothing here acts on a
   note's contents, which is why no URL extraction is proposed. But the text
   lands in the caller's context on one of the most-used tools, it arrives from
   a public gallery, and it is far more instruction-shaped than the template
   titles this server already surfaces. Hence the §3 description sentence
   naming it as reference material, and the cap in §1 bounding how much of it
   can arrive at once. Neither eliminates the concern; both make it legible.
5. **The installed `comfy` is a week behind its checkout** (built 2026-08-02,
   checkout moved 2026-08-09). Re-verify `workflow notes`' payload against the
   build that ships before trusting this document's shape.

## Staging

Detailed steps belong in the implementation plan; the boundaries are:

1. **`notes.ts` + fake-comfy mode + its tests** — self-contained, no other
   module changes, green before anything else moves.
2. **Wire into `describe_workflow`** — `WorkflowDescription`'s fourth field,
   the response key, the cap, the concurrent issue alongside slots/inert, the
   degradation path, and §3's description sentences.
3. **Stale-cache floor** — `readStaleCache`, the `withObjectInfo` fallback and
   its widened return type, **`validate_workflow`'s second call site**, the
   `object_info` response block, both tools' tests.

Stage 3's `validate_workflow` step is called out because it is the one this
design got wrong on the first pass: patching `withObjectInfo` alone leaves
`validate_workflow` throwing in the exact scenario the stage exists to fix, and
nothing in a `describe_workflow`-only test would notice.

Each stage compiles under `deno task typecheck` and passes `deno task test`
before the next begins.
