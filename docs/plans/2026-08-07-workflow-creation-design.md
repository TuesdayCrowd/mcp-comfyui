# Creating workflows

**Status:** implemented and released in 0.6.5 on 2026-08-08 — see `CHANGELOG.md`
and PRs #8, #9, #11 and #12. This document is kept as the record of the
decisions and the ground truth behind them, not as a description of the code;
where the two differ, the code and `CLAUDE.md` are current.

Two things the live trial changed after this was written. The "Error handling"
section's network-failure shape was **not** measured at design time and now is
(`template_fetch_failed`, in a clean envelope). And running a fetched template
on a *remote* host exposed two bugs this design did not anticipate, both since
fixed and recorded as ground truth #24 and #25 — neither is a defect in the
design below, but a reader mining this for "what works" should read those first.
**Date:** 2026-08-07

This server can find, describe, parameterise and run a workflow that already
exists. It cannot produce one. A caller who wants something the local library
does not cover — image-to-video, an upscale pass, audio — has no move except to
open ComfyUI and build a graph by hand.

The obvious reading of "add workflow creation" is that this server should author
a graph. It should not, and it does not have to. comfy-cli already ships three
separate creation engines, and the design work is choosing between them rather
than building one.

## Why not author a graph here

Non-negotiable #1 forbids it in spirit: JavaScript rounds integers above 2^53
and a ComfyUI seed reaches 2^64−1, so this server never parses or re-serialises
a workflow graph. A *newly authored* graph looks exempt — there is no
pre-existing value to corrupt — but the exemption evaporates the moment a caller
asks for a specific large seed, which is the ordinary case for reproducing a
render.

The measurement that settles it is elsewhere, though. See "compose" below: the
engine that would have been the vehicle produces a format this server can run
but can never describe, and the hazard recurs in its introspection command
anyway.

## Ground truth

Everything here was executed on 2026-08-07 against comfy-cli
`v1.13.0-59-g95d7897`. ComfyUI was **down** for all of it except the two
`templates fetch` calls, which need the network; that is the point of most of
these numbers.

### The gallery

```
$ comfy --json --skip-prompt templates ls                      # 199,382 bytes
$ comfy --json --skip-prompt templates ls --type video --limit 5  # 2,072 bytes
  -> {"total_in_gallery": 574, "matched": 156, "shown": 5, "filters": {...}, "rows": [...]}
```

574 templates. `--limit` caps `rows` while `matched` still reports the true
count, so a capped answer is honest rather than silently truncated. Each row is
`{name, title, output_type, category_title, tags[], models[], providers[],
description}`.

Filters are `--type`, `--category` (exact title), `--tag` (case-insensitive
exact), `--model` (substring), `--provider` (substring), `--name` (substring).
`--type video --tag "Image to Video"` with **no `--limit`** matched 53 of 574
and returned all 53 in 18,690 bytes — so the CLI applies no default cap of its
own, and the tool's default of 20 is this server's choice rather than a mirror
of the CLI's.

**`--query` is advertised and does not work.** `templates ls --help` documents a
CQL grammar; invoking it returns:

```json
{"ok": false, "error": {"code": "cql_query_invalid",
 "message": "CQL grammar queries are not available. Use flag-based filtering instead.",
 "hint": "comfy templates ls --type image --tag API --model Flux"}}
```

Do not expose it. Do not mention it in a tool description.

### Fetching

```
$ comfy --json --skip-prompt templates fetch video_wan2_2_14B_i2v -o wf.json
  -> ok:true, 84,289 bytes written
```

The fetched file is **frontend format** — `nodes[]` and `links[]` both arrays —
which is the format `comfy workflow slots` reads and the only format this
server's pipeline accepts. Five top-level nodes plus one subgraph definition.

`-o` creates missing parent directories, verified two levels deep.

A bad name fails cleanly:

```json
{"ok": false, "error": {"code": "template_not_found",
 "message": "no template named 'definitely_not_a_template' in the gallery",
 "hint": "try `comfy templates ls --name <substring>` to search"}}
```

`fetch` needs the network. The index is cached for 24h; the workflow JSON is
pulled from `Comfy-Org/workflow_templates` on each call.

### The existing pipeline reads a fetched template unchanged

This is the claim the whole design rests on, so it was run end to end, offline:

```
$ comfy --json --skip-prompt workflow slots wf.json --input ~/.cache/mcp-comfyui/object_info-127.0.0.1-8188.json
  -> ok:true, 58 slots   (55 of them subgraph-nested, e.g. `129/98.width`)

> inertInputsOfFile("wf.json")
  -> 14 inert, all nested
     129/98.length  <- ComfyMathExpression (node 163)
     129/94.fps     <- PrimitiveFloat      (node 162)
     129/86.steps   <- ComfySwitchNode     (node 119)
     ...
  -> 44 settable remain
```

That matters more than it looks. Landmine #15 — the one where a request for 60
seconds of black metal produced 150 seconds of tropical house — is exactly the
"link-fed input reported as settable" hazard, and gallery templates are far more
nested than the single workflow that detection was built against. It holds. The
decoys it caught are the *right* ones (video length, fps, sampler steps and
cfg), and the effective upstream controls are present in the settable set:

```
129/163.expression  (ComfyMathExpression)   settable
129/162.value       (PrimitiveFloat)        settable
129/131.value       (PrimitiveBoolean)      settable — gates all five switches
```

**Note which address is the settable one.** `129/119.switch` is *not* — it is
itself one of the 14 decoys, as are `129/116`, `129/117`, `129/120` and
`129/125`. All five are fed by the same `PrimitiveBoolean`, node 131, and
`129/131.value` is the one address that moves them. Being listed by `slots` and
being settable are different properties, and an earlier draft of this document
confused them — which is landmine #15 reproduced inside the argument that it is
handled. Anything reasoning about these addresses must read `inert`, not the
slot listing.

The resolution gap, pre-existing and not caused by this feature, is narrower
than it first appears. Five of the 14 decoys **do** resolve — each switch
reports `candidate_addresses: ["129/131.value"]`. The other nine report `[]`,
including cases where the working address is in the same listing:
`129/94.fps` names `PrimitiveFloat` node 162 but not `129/162.value`. So
single-hop resolution works and the rest does not. See "Out of scope".

> **Superseded in 0.6.7.** The framing above ("single-hop works, deeper does
> not") was wrong: two of the nine failed because the graph-only resolver cannot
> see a widget that has not been *converted to an input*, which has nothing to do
> with hop count. Resolution now runs against the CLI's slot listing and reaches
> 14 of 14 on this template. Kept as written because it records what was believed
> at the time, and the correction is the point.

### compose — why it is not the vehicle

`comfy workflow compose` builds an API-format graph from a YAML blueprint of
fragments. It works, and it works well: fully offline, real cross-fragment
wiring, `foreach` substitution, and a 2^64−1 seed survives
decompose → compose → decompose byte-exact. Its envelopes carry only counts and
port names, never node bodies.

It is still the wrong choice here, for two measured reasons.

**Its output can never be described.** `comfy workflow slots` and `set-slot`
hard-reject API format:

```json
{"error": {"code": "workflow_not_frontend_format",
 "message": "`comfy workflow` requires the frontend-format workflow (with `nodes[]` / `links[]`)."}}
```

The check is `_is_frontend_format()` in `command/workflow.py`, and it runs before
any mutation. A grep for `api_to_ui|convert_api_to_ui|to_ui_format` across the
whole comfy-cli tree returns **zero hits** — there is no reverse conversion
anywhere. So a composed workflow is permanently run-only: this server could
submit it but never offer `describe_workflow` on it, which is the server's
entire value-add.

**Its one introspection command reintroduces landmine #14.** `comfy workflow
fragment show` echoes a fragment's numeric `default` into its envelope:

```
raw bytes in envelope : 18446744073709551615
after JSON.parse      : 18446744073709552000   <- corrupted
```

Any `describe_fragment` tool would route that through `envelope.ts`'s single
`JSON.parse` and silently corrupt it. Not unfixable — return the field as raw
text, or omit it — but it is a third recurrence of a hazard CLAUDE.md already
warns will keep recurring, and it is not worth paying for a capability whose
output cannot be described anyway.

### author-from-scratch — no working primitive

`comfy nodes path` is the routing aid an authoring tool would lean on. It does
not route:

```
$ comfy --json --skip-prompt nodes path MODEL IMAGE --input <cache>
  -> 10 "paths", every one a single step with "from_type": ""
     ByteDanceImageNode, ByteDanceSeedreamNode, EmptyImage, Flux2MaxImageNode, ...
```

`EmptyImage` takes no MODEL; it emits a blank image. This is a list of nodes
that output IMAGE, not a path from MODEL to IMAGE. Whatever else would be needed
to author a graph, the navigation is not there.

### Other measured facts, recorded so they are not re-derived

- `comfy validate` accepts **both** formats despite its help text saying
  API-only — it detects UI shape and converts first — and works fully offline
  with `--input`. Diagnostics are non-uniform across codes: `unknown_class_type`
  carries no `field`; `unknown_enum_value` carries `suggestions` and
  `valid_options`; `above_max` carries neither.
- Its 13 diagnostic codes appear in **none** of comfy-cli's published
  `error_codes.py` registry. A second undocumented open-string vocabulary —
  non-negotiable #2 applies to it.
- `comfy run` accepts both formats but has **no `--input`**, so its UI→API
  conversion is online-only.
- `comfy workflow save|list|get|delete` declare **no `--host`/`--port`** — only
  `--where`, plus the process-wide `COMFY_LOCAL_URL`. They cannot target an
  arbitrary registered host per call, so they are not a route to writing into a
  named host's library, and `src/comfy/userdata.ts` is not redundant with them.
- `discover.ts` classifies a composed API file as `format: "api"`, node count
  correct, `_meta` provenance block excluded without breaking classification.

## Decisions

1. **Creation means fetching a curated template.** It is the only one of the
   three engines whose output this server can describe, parameterise and run
   with no pipeline change.
2. **The server never authors a graph**, and this design adds no code that reads
   or writes graph structure. `templates.ts` handles envelopes and file paths.
3. **A search with no filter is refused**, before anything is spawned. An
   unfiltered listing is 199,382 bytes.
4. **`--query` is never passed.** It is documented upstream and does not work.
5. **`type` is an open string, not an enum.** `templates ls --help` names four
   values today; non-negotiable #2 says every registry from the CLI is
   append-only and closing one breaks on the next release.
6. **Fetched workflows land in their own directory, appended last to
   `workflowRoots()`.** They are rediscoverable across sessions and can never
   shadow a workflow the operator made.
7. **Creation takes no `host`.** Fetching is a gallery operation. The host enters
   at the next call, `describe_workflow`, which is where per-host constraints
   belong.

## Architecture

```
src/comfy/templates.ts    NEW.  drives `comfy templates ls|fetch`, decodes the
                                envelope, returns typed rows and a written path.
                                In comfy/ because it is a CLI call, like jobs.ts.
src/config.ts             +2.   CREATED_DIR_ENV and its default; workflowRoots()
                                appends the created root LAST.
src/tools.ts              +2.   search_templates, create_workflow_from_template;
                                list_workflows gains an `origin` field.
```

Nothing else changes. `describe.ts`, `setSlots.ts`, `run.ts`, `discover.ts`,
`objectInfo.ts`, `hosts.ts` and `jobLedger.ts` are untouched.

Dependency direction is unchanged. `templates.ts` imports only `exec.ts` and
`envelope.ts` — fewer than `jobs.ts`'s five, not because it is written more
tightly but because it has less to do: the gallery takes no `host`, so there is
no `target.ts`, and it returns a path rather than artifacts, so there is no
`outputs.ts`. It does not import `config.ts`; the created directory is resolved
at the tool layer and passed in, the same way `run.ts` is handed a prepared path
rather than resolving one itself.

### The created directory

```ts
/** Where a fetched template is written. Absent means the platform default. */
export const CREATED_DIR_ENV = "MCP_COMFYUI_CREATED_DIR";
export const DEFAULT_CREATED_DIR = join(homedir(), ".local/share/mcp-comfyui/workflows");
```

`workflowRoots()` appends it after the operator's own roots. That ordering is
already load-bearing — `config.ts:99` documents that the first root's copy of a
colliding filename gets the bare unqualified name — so appending last is what
guarantees a fetched `portrait.json` cannot displace one the operator wrote.

The directory is created on first write, not at startup. A server that never
fetches anything should not leave a directory behind.

### `origin` is computed at the tool layer

`list_workflows` tags an entry `origin: "template"` when its absolute `path`
sits under the created root, and omits the field otherwise. `discover.ts` stays
a pure content classifier and learns nothing about provenance; it already
returns `path` on every entry, so this is a prefix comparison in `tools.ts` and
nothing more.

## Tool surface

### `search_templates`

```
title:       Search the workflow template gallery
annotations: readOnlyHint: true, openWorldHint: true
```

Read-only, contacts no ComfyUI, never launches anything, so `readOnlyHint` is
unconditionally true — unlike `describe_workflow`, whose annotation is
`!config.autoLaunch` because it may start an instance.

| field | type | notes |
|---|---|---|
| `type` | string, optional | Output kind. Open string — today `image`, `video`, `audio`, `3d`. |
| `category` | string, optional | Exact category title, e.g. `"Video"`. |
| `tag` | string, optional | Case-insensitive exact match. |
| `model` | string, optional | Substring, e.g. `"Flux"`. |
| `provider` | string, optional | Substring. |
| `name` | string, optional | Substring on the template name. |
| `limit` | int 1–50, default 20 | Caps rows returned. |

**At least one of the six filters is required**, and the refusal happens before
any process is spawned. The message says why: the full gallery is 574 templates
and 199,382 bytes, which is not a usable tool result.

Enforce it with a **manual check in the handler** throwing `ToolArgumentError`,
not a schema-level `.refine()`. This project already made that choice once, for
`manage_hosts`'s per-action required fields (`mutationOf`, `src/tools.ts:1573`),
and the reason generalises: `ToolArgumentError` is mapped at
`src/toolResult.ts:400` to `kind: "invalid_input"` and travels through
`toolAnswer` like every other refusal, whereas a schema rejection is caught by
the SDK's own `McpError` path and returned as `{content:[{type:"text",…}],
isError:true}` — a bare string with none of `ToolErrorBody`'s structure. That
bare shape is precisely what `toolResult.ts`'s own header comment says
`toolAnswer` exists to avoid. A schema `.refine()` does work mechanically under
this project's pinned zod 4 (it keeps the shape, so `tools/list` still advertises
all six fields), so this is a consistency decision rather than a capability one —
but it is the difference between one refusal in the server that looks like
nothing else and one that looks like all the others.

Keep the six fields in the flat `inputSchema: { field: schema, … }` raw-shape
form every other tool here uses.

Answer shape:

```json
{"total_in_gallery": 574, "matched": 156, "shown": 5, "truncated": true,
 "filters": {"type": "video", "category": null, ...},
 "templates": [{"name": "...", "title": "...", "output_type": "video",
                "category_title": "Video", "tags": [...], "models": [...],
                "description": "..."}]}
```

`matched` comes from the CLI and is the true count before the cap, so
`truncated` is a fact rather than an inference. `providers` is dropped — not
because it is empty (226 of 574 rows carry one, including two of the five in
the sample above) but because a caller filters by it rather than reads it.
`description` is truncated to 200 characters with an ellipsis; full text is one
`templates show` away and 574 untruncated descriptions is most of the 199 KB.

### `create_workflow_from_template`

```
title:       Create a workflow from a gallery template
annotations: readOnlyHint: false, destructiveHint: false,
             idempotentHint: false, openWorldHint: true
```

`readOnlyHint: false` because it writes a file. `destructiveHint: false` because
it refuses to overwrite rather than replacing anything. `idempotentHint: false`
because a second call with the same name and no `as` produces a second file.

| field | type | notes |
|---|---|---|
| `template` | string, required | A `name` from `search_templates`. |
| `as` | string, optional | Filename stem to save under. Defaults to the template name. |

No `host`. Fetching is a gallery operation and needs no ComfyUI.

Answer shape:

```json
{"name": "video_wan2_2_14B_i2v", "title": "Wan 2.2 14B Image to Video",
 "output_type": "video", "path": "/Users/.../mcp-comfyui/workflows/video_wan2_2_14B_i2v.json",
 "bytes": 84289, "next": "describe_workflow"}
```

The path is absolute and `resolveWorkflow` already accepts one
(`src/tools.ts:425`), so it works as a `workflow` argument immediately, and the
bare `name` works too once `list_workflows` picks it up from the created root.

**Overwrite is refused.** If the target exists, the tool fails with the existing
path and suggests `as`. Overwriting a workflow a caller may have already
parameterised is a destructive act, and the whole point of a separate directory
is that nothing in it was hand-made and worth silently replacing.

### Description register

Both descriptions follow the existing style: what it is for, what to call before
and after, and the one thing that will otherwise be got wrong. For
`search_templates` that last part is that a filter is mandatory. For
`create_workflow_from_template` it is that the result is an ordinary local
workflow — `describe_workflow` next, then `run_workflow` — and that the file is
this server's, not ComfyUI's, so it will not appear in the ComfyUI editor.

`server.ts`'s instructions string gains one clause: when `list_workflows` has
nothing suitable, try `search_templates`.

## Error handling

No new arms in `toolResult.ts`. `template_not_found` is a `ComfyCliError` and
falls through the generic arm at `src/toolResult.ts:364`, arriving as
`kind: "comfy_cli"` with the CLI's own code, message and hint — including the
hint that names `templates ls --name <substring>` as the way to search, which is
exactly the recovery a caller needs.

Three failures need thought:

- **Network failure on `fetch`.** The gallery index is cached; the workflow JSON
  is not. Measured 2026-08-08, behind an RFC 5737 blackhole proxy: `templates
  fetch` still returns a clean `envelope/1`, `ok:false`,
  `error.code: "template_fetch_failed"`, exit 1, after roughly 16s — comfy's own
  `urlopen` timeout. It lands on the existing `ComfyCliError` path above, same as
  `template_not_found`, so no new arm was needed.
- **Target exists.** A refusal from this server, not the CLI, so it is a
  `ToolArgumentError` with the existing path in the message. There is
  deliberately no `overwrite` flag, which means a caller wanting a freshly
  updated copy of a template they already fetched must pass a new `as` — and
  that feeds the "never garbage-collected" hazard below. Both are accepted for
  v1; if the pair becomes annoying in practice, an explicit opt-in flag is the
  established pattern here (`wait`, `fetch_outputs`), not silent replacement.
- **Created directory not writable.** Fails on first write with the resolved
  path and `MCP_COMFYUI_CREATED_DIR` named, matching how `config.ts` errors
  elsewhere quote the setting that would fix them.

## Non-negotiables

1. **Never parse or re-serialise a graph.** Complied with, but state the reason
   precisely rather than claiming more than is true. Adding the created root to
   `workflowRoots()` means `list_workflows` *does* open every fetched template:
   `discover.ts:273` calls `JSON.parse` on each file it classifies, and
   `inertInputsOfText` does the same at `discover.ts:771` for
   `describe_workflow` and `run_workflow`. Both are pre-existing and both are
   safe, because each reads shape only — `classify()` reports `format`,
   `node_count` and `has_subgraphs`, `inertInputsOf` reports addresses and
   upstream node identities — and neither writes the parsed value back to disk.
   The rule forbids the **round trip**, and nothing here
   round-trips: `templates fetch` writes the file, `comfy workflow slots` and
   `set-slot` read and edit it in the CLI, and this server's own copy path stays
   byte-for-byte. No new code in this design reads a workflow file at all.

   The one place a big integer could leak into an envelope — `fragment show` —
   belongs to compose, which this design does not build.
2. **Every registry is an open string.** `type`, `category` and `tag` are open
   strings. The four `type` values in the CLI's help are not enumerated in the
   schema.
3. **Branch on the envelope, never the exit code.** `templates.ts` decodes
   through `envelope.ts` like every other module.
4. **Global flags precede the subcommand.** `comfy --json --skip-prompt
   templates ls --type video --limit 5`. `templates` takes no `--host`/`--port`,
   so the split-ordering problem of landmine #18 does not arise.
5. **stdout is the protocol.** No `console.log` added.
6. **Never launch a second ComfyUI.** Neither tool contacts a ComfyUI or calls
   `ensureRunning`. Not applicable by construction, which is why
   `search_templates` can be `readOnlyHint: true` unconditionally.
7. **A job belongs to the host that ran it.** Untouched — no job is submitted.

## Testing

Tests never contact a real ComfyUI and never invoke the real `comfy`. Two new
`fake-comfy` modes, **appended** to the existing `case "$FAKE_COMFY_MODE"`
dispatch:

- `templates_ls` — serves `$FAKE_COMFY_TEMPLATES_FILE` as `data`, following the
  `data_file` pattern of a caller-supplied JSON file. (`data_file` is the
  standalone precedent; `jobs` is a single mode that sub-dispatches on the
  subcommand, which these two do not need.)
- `templates_fetch` — copies `$FAKE_COMFY_TEMPLATE_FILE` to the path named by
  `-o`, following `run_capture`'s file-copy pattern, and reports the row.

What the tests must pin:

- `argv` never contains `--query`, and global flags precede `templates`.
- A no-filter call is refused **without spawning** — assert `$FAKE_COMFY_ARGV_OUT`
  was never written.
- `limit` defaults to 20, is capped at 50, and `truncated` is derived from
  `matched > shown` rather than from the row count.
- `type`/`category`/`tag` accept a value absent from today's vocabulary — the
  test that keeps non-negotiable #2 checkable.
- The fetched file's bytes are **identical** to the fixture, compared by digest
  or `grep`, never by `JSON.parse`. The fixture embeds a widget value of
  `18446744073709551615` so the byte-exactness is load-bearing rather than
  decorative.
- An existing target is refused and the existing file is unmodified.
- `origin: "template"` appears only for entries under the created root, and a
  colliding name resolves to the operator's copy, not the fetched one.

Fixtures come from real captures: the `templates ls --type video --limit 5`
response and the `video_wan2_2_14B_i2v` workflow are both already on disk from
this investigation.

**One fixture must be hand-built.** Neither real capture separates
`truncated = matched > shown` from the mutant `rows.length >= limit`: on the
`--limit 5` capture, `matched` is 156 and `shown` is 5, so both rules say
`true`. Only `matched == limit` exactly makes them disagree — correct rule
`false`, mutant `true`. Construct that case by hand. This is the project's own
rule about rule-shaped code: real fixtures come from a healthy install and
cannot reach the degenerate cases.

**Mutants to construct**, per the project standard:

- Move the created root to the *front* of `workflowRoots()` — the collision test
  must die.
- Make the no-filter guard permissive — the no-spawn assertion must die.
- Replace the byte-copy with a `JSON.parse`/`stringify` round-trip — the
  big-integer assertion must die.
- Derive `truncated` from `rows.length >= limit` — the case where `matched`
  equals `limit` exactly must die.

## Staged plan

```markdown
## Stage 1: search_templates
**Goal**: Read-only gallery search. No writes, no host, no ComfyUI.
**Success Criteria**: A filtered call returns capped, well-formed rows with an
  honest `matched`/`truncated`; an unfiltered call is refused before any process
  is spawned; `--query` never reaches argv.
**Tests**: `templates_ls` fake-comfy mode; argv assertions; no-spawn assertion;
  limit default/cap; open-string acceptance for type/category/tag.
**Status**: Not Started

## Stage 2: the created directory
**Goal**: CREATED_DIR_ENV, its default, and `workflowRoots()` appending it last;
  `origin: "template"` on `list_workflows`.
**Success Criteria**: A file placed in the created root is listed and tagged; a
  name colliding with an operator workflow resolves to the operator's; the
  directory is not created until something is written.
**Tests**: config unit tests for ordering and dedup; a discover/list test with a
  deliberate collision. No CLI involvement — this stage is pure local logic and
  ships independently of Stage 3.
**Status**: Not Started

## Stage 3: create_workflow_from_template
**Goal**: Fetch one named template into the created root, byte-exact, and hand
  the path to the existing pipeline.
**Success Criteria**: The written bytes equal the fixture's; the returned path
  resolves through `resolveWorkflow`'s absolute-path branch with no new
  resolution code; an existing target is refused with the existing path;
  `template_not_found` surfaces through the generic ComfyCliError arm with no
  new error arm.
**Tests**: `templates_fetch` fake-comfy mode with a 2^64-1 widget value;
  digest comparison, never JSON.parse; overwrite refusal; an integration test
  threading the returned path through a real `describe_workflow` call.
**Status**: Not Started

## Stage 4: wiring and honesty
**Goal**: `server.ts` instructions name the search→create→describe→run path;
  tool descriptions disclose the measured caveats.
**Success Criteria**: `search_templates`'s description states that `output_type`
  is inherited from the parent gallery category and is sometimes wrong;
  `create_workflow_from_template`'s states that the file is this server's and
  will not appear in the ComfyUI editor; the network dependency of `fetch` is
  stated in both.
**Tests**: Whatever description assertions the suite already carries; otherwise
  review against the existing register.
**Status**: Not Started
```

Stages 1 and 2 are independent of each other and of Stage 3; either can ship
alone.

## Hazards carried forward

Accepted rather than solved. Each is disclosed in a tool description.

- **`output_type` is inherited from the parent gallery category, not derived per
  template**, so it is sometimes wrong. Reported by the investigation as 28 of
  103 "Use Cases" rows typed `image` when they are video; not independently
  re-measured. The filter is still worth having, and re-ranking client-side
  would mean this server maintaining an opinion about upstream's gallery schema.

  > **SUPERSEDED — left in place rather than edited, because the correction is
  > the point.** Re-measured 2026-08-11 and again 2026-08-12: the count is **47
  > of 103**, not 28, and the mechanism is stronger than "inherited". Grouping
  > all 578 gallery rows by category gives `output_type` cardinality *exactly 1*
  > in every category, so the field **is** `category_title` restated, and five of
  > the eight categories collapse to `image`. The 28 could be neither reproduced
  > nor refuted — this document does not record the method behind it — so 47 is a
  > fresh measurement rather than a replay; every rule tried lands above 28,
  > including the most conservative. "Sometimes wrong" also understates it: a tag
  > query recovers 43 of the 47 (91.5%), and `--type video` recovers **none**.
  > A second-hand number survived four days of being cited because it lived only
  > in a plan document; it now lives in `docs/comfy-cli-ground-truth.md` as
  > entries #28 and #29, which is the file this project trusts.
- **`fetch` has no offline fallback.** An air-gapped machine gets a failure here
  even when its own ComfyUI is reachable.
- **The created directory is never garbage-collected.** Files accumulate.
- **A fetched template may reference models the target host lacks.** That is
  what `describe_workflow`'s per-host `enum` and `unresolved` already report, and
  the caller sees it on the next call. This design does not pre-validate.
- **`comfy validate` is not adopted here.** It would catch a class of error
  earlier and works offline, but nothing in this design produces an invalid
  workflow — the gallery's are valid by construction — so it would be a tool
  looking for a caller. Revisit if authoring ever ships.

## Out of scope

- **compose / decompose / fragment authoring.** Blocked on an API→UI conversion
  that does not exist upstream, and its `fragment show` introspection corrupts
  large integers. Not unfixable; not now.
- **Node-by-node authoring.** `nodes path` does not route.
- **Writing into a named host's own library.** `comfy workflow save` has no
  `--host`/`--port`, and `src/comfy/userdata.ts` is read-only. Doing this means
  a POST path in `userdata.ts`, which is its own design.
- **~~Finishing `candidate_addresses`~~ — done in 0.6.7.** `describe_workflow` now
  resolves a replacement address against the CLI's slot listing rather than the
  graph alone, taking the measured template from 5 of 14 to 14 of 14.
