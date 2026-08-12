# Template metadata, and the three blocks upstream

**Status:** designed, not implemented. Stages below are all `Not Started`.
**Date:** 2026-08-11

The 2026-08-07 workflow-creation design shipped in 0.6.5 and left four things
open behind it: one **accepted hazard** (`output_type` is coarse) and three
items **out of scope** because comfy-cli could not support them. All four were
re-measured on 2026-08-11. Three came back unchanged. The fourth came back
roughly twice as bad as recorded, and with a mechanism sharper than the one the
design doc describes.

This document records those measurements and the decisions they force. It is
small on purpose: the honest outcome is that almost nothing should be built, and
the work is to stop under-stating a number in a tool description and to move
four measurements out of a plan document into the ground-truth register where
they can be trusted.

## Ground truth

Everything below was executed on 2026-08-11. Behavioural claims were run against
the **installed** `comfy`; source claims were read at the **checkout HEAD**; each
is labelled where it matters.

The gallery figures, the category-cardinality result, the 47-of-103 count, the
tag-emptiness count and the two "silent case" node inspections were each run
twice, by independent scripts, and agree exactly. The CLI and source findings for
the three upstream blocks were run once.

### Which comfy-cli produced these numbers

This has to come first, because it decides what everything else is evidence for.

```
installed : /Users/lawls/.local/bin/comfy  (uv tool install, 2026-08-02)
            /Users/lawls/.local/share/uv/tools/comfy-cli/lib/python3.13/site-packages/comfy_cli
checkout  : /Users/lawls/Development/TuesdayCrowd/Projects/ComfyUI/comfy-cli
            remote git@github.com:Comfy-Org/comfy-cli.git — upstream, not a fork
            HEAD 220f99a = v1.15.0-1-g220f99a
```

`comfy --version` reports `0.0.0` and cannot identify the build. `diff -rq` can:
`diff -rq --exclude=__pycache__` against a worktree at `5704b55` shows the
installed package tree is **byte-identical to it**, the only two lines of output
being `bench/out` and `bench/README.md`, dev files `uv tool install` never ships.
The exclusion is load-bearing — a bare `diff -rq` prints 16 lines, 14 of them
`__pycache__` directories.

`5704b55` matters because **`v1.13.0-59-g95d7897` — the build every earlier
measurement in this project cites — has a zero tree diff from it.** Both resolve
to tree `bc415cc2`; `95d7897` is a GitButler workspace wrapper commit, which
regenerates on every `but` operation while reusing a stale author timestamp.
`220f99a` is the same kind of wrapper over its real parent `a6a62cf`.

Two consequences, and they point in opposite directions:

- **No measurement recorded in this project against comfy-cli is stale.** The
  installed CLI has not moved since they were taken. A "re-measurement" against
  it is a reproduction, not an update.
- **The source is 43 non-merge commits ahead**, so the interesting question is
  not "did this change?" but "would upgrading change it?" The real content range
  is `5704b55..a6a62cf`. All three blocks below were checked at both ends.

### The gallery, re-measured

```
$ comfy --json --skip-prompt templates ls      # 200,675 bytes
  -> total_in_gallery: 578, matched: 578, shown: 578
```

578 templates, against 574 on 2026-08-07 — the gallery has grown by four.

**`output_type` is not "sometimes wrong". It is `category_title`, restated.**
Grouping all 578 rows by category and taking the set of distinct `output_type`
values per group gives cardinality **exactly 1** in every category, with no
counterexamples:

| `category_title` | n | `output_type` |
|---|---:|---|
| Image | 156 | `image` |
| **Use Cases** | **103** | **`image`** |
| **Utility** | **72** | **`image`** |
| **LLM** | **17** | **`image`** |
| **Node Basics** | **7** | **`image`** |
| Video | 160 | `video` |
| Audio | 30 | `audio` |
| 3D Model | 33 | `3d` |

Five of eight categories — **355 of 578 templates** — collapse to `image`. The
field carries no information `category_title` does not already carry, so the
design doc's "inherited from the parent gallery category" is right about the
mechanism and understates it as a tendency rather than an identity.

**47 of 103.** Every one of the 103 `Use Cases` rows was fetched
(`templates fetch <name> -o …`, all 103 exit 0) and its graph inspected for a
video-producing node — matching `SaveVideo`, `SaveWEBM`, `SaveAnimated*`,
`VHS_VideoCombine` or `CreateVideo` against frontend `nodes[].type`. **47 rows
(45.6%)** carry one while typed `output_type: "image"`.

Counted by **row** rather than by node, `SaveVideo` appears in 38 of them,
`VHS_VideoCombine` in 12 and `CreateVideo` in 9. Those exceed 47 because the
three overlap heavily; they are not a partition and must not be added.
`SaveWEBM` and `SaveAnimated*` were in the search set and occur in none.

The design doc's inherited figure was **28 of 103**. That figure could be
neither reproduced nor refuted byte-for-byte — the doc does not record the
method behind it, and the gallery has since moved 574 → 578, although the
`Use Cases` subtotal is still coincidentally 103. Today's 47 is a fresh
measurement on fresh data, not a replay. Every rule tried lands above 28,
including the most conservative one (tag-substring only, 42).

**The type filter recovers none of them.**

```
$ comfy --json --skip-prompt templates ls --category "Use Cases" --type video
  -> matched: 0          # 0 of 47
```

Not degraded — structurally incapable, and implied by cardinality 1.

**Tags are better, with a measured ceiling.** Zero of 578 gallery rows have an
empty `tags[]` (lengths run 1–5, mode 2), so the failure mode where the
documented workaround has nothing to work with does not occur today.

**True recall is 43 of 47 (91.5%), and the obvious way to compute it is wrong.**
Querying the video tag vocabulary selects 44 `Use Cases` rows, and comparing that
44 against the 47 gives a flattering 93.6% — but the two sets are not nested.
The 44 contains one row that is not video at all, and misses four that are. Take
the intersection, not the sizes. This is the specific arithmetic to redo rather
than transcribe when this measurement is refreshed.

What breaks the workaround is inaccuracy, not absence:

- `templates_mjm_airt_machIne` — tags `['FLF2V', 'Text to Image']`, typed
  `image`. Its graph holds six active `SaveVideo`/`VHS_VideoCombine` nodes and
  five `CreateVideo`. Tagged **"Text to Image"** while being predominantly a
  video workflow.
- **The four a tag query misses entirely** are `templates-led_billboard`,
  `template_image_speech_to_video`, `template_ltx2_3_lora_video_outpainting` and
  `template_purz_nb2_single_image_sprite_sheet`. The worst is
  `templates-led_billboard` — tags `['API', 'Brand Design']`, title "LED
  Billboard Message", no video signal in tags, title or name, and an active
  `SaveVideo` at node 23. The other three carry the word in their *title* only
  ("Generate UGC Video With Voice Clone", "LTX2.3 LoRA: Video Outpainting",
  "Single Image to Animated Sprite Sheet"), which `--tag` cannot reach — the
  filters are per-field, so a title signal is worth nothing to a tag query.
- `template_contact_sheet-step_2.app` — tagged **`Video`**, and genuinely
  image-only: 8× `SaveImage`, zero video nodes. Wrong in the other direction, so
  a tag filter has false positives as well as false negatives. It appears to
  describe the row's place in a three-step series whose *third* step produces
  video.

Both "silent" cases were checked for the obvious objection: their video nodes
are `mode: 0` (active), not `2` (mute) or `4` (bypass). The graphs really do save
video.

The `Use Cases` video vocabulary, by frequency, is seven tags carrying the
literal substring — `Video` (24), `Image to Video` (19), `Video Edit` (8),
`Reference to Video` (2), `Audio to Video` (1), `Text to Video` (1),
`Video to Video` (1) — plus **`FLF2V` (11)**, which is first-last-frame-to-video
and carries no substring at all. A caller cannot find that eighth one by
guessing, and `--tag` is exact and case-insensitive with **no substring support**
(`--tag "Vid"` → `matched: 0`), so the vocabulary must be known in advance. Per
non-negotiable #2 it is also open and undocumented.

**What this measurement cannot establish.** Static node-type inspection is a
lower bound: it cannot see a third-party node that saves video under a
nonstandard class name. It also flattens genuinely mixed workflows —
`templates-sprite_sheet` and `templates-car_product` hold many `SaveImage`
*and* several `SaveVideo`, and no single `output_type` value serves those
regardless of how it is derived. One heuristic false positive was rejected on
inspection: `template_eric_seedance_5_subject_and_outfit_combine` matched a
"seedance" keyword but uses `ByteDanceSeedreamNodeV2` — **Seedream**, an image
model — and its `output_type: "image"` is correct. A brand-name collision, not a
miscategorisation.

### `comfy nodes path` — the defect, located

Still broken, byte-for-byte as recorded. `nodes path MODEL IMAGE --input <cache>`
returns 10 single-step paths, every `from_type` empty, `EmptyImage` among them.
But the 2026-08-07 reading — "it lists nodes that output the target type" — is
the *symptom*, and the mechanism is narrower and more fixable than it implies.

The command does route. `CLIP → CONDITIONING` returns `CLIPTextEncode` and nine
variants, each carrying a real `from_type: "CLIP"`. The defect is in
`comfy_cli/cql/engine.py:217-233`:

```python
def required_link_types(self) -> list[str]:
    ...                                  # only inputs where p.is_link and p.required
def can_apply(self, available: set[str]) -> bool:
    return all(t in available for t in self.required_link_types())
```

`all()` over an empty list is vacuously `True`. Any node whose required inputs
are **all widgets** — `EmptyImage`, the ByteDance/Gemini API nodes — satisfies
`can_apply` for *any* `available` set, including one sharing nothing with it.
The blank `from_type` is the same cause: the representative-type loop at
`engine.py:676-680` iterates `required_link_types()` and never executes.

Proof the source type is ignored entirely: **`LATENT → IMAGE` returns the
identical 10 nodes in the identical order as `MODEL → IMAGE`.**
`MODEL → LATENT` shows the same shape with `Empty*Latent` nodes, none of which
takes a MODEL. `IMAGE → IMAGE` returns `count: 0` from a separate deliberate
short-circuit (`engine.py:618`, `:656`: `if from_type == to_type: return []`),
which also means legitimate one-hop nodes like `ImageScale` are never found — a
smaller, separate gap.

Upstream's own suite cannot catch this. `test_exact_paths_model_to_image`
(`tests/comfy_cli/cql/test_engine.py:346`) asserts only `p["from"] == "MODEL"`
and `p["to"] == "IMAGE"` at lines 350-351 — payload constants, true by
construction — plus, at line 354, that each step's node exists. Its fixture's sole
IMAGE producer is `VAEDecode`, which has real required link inputs, so the
vacuous-truth case never fires.

Unchanged across the range: zero commits touch `can_apply`, `exact_paths` or
`required_link_types` since `64c9883` (2026-06-21) introduced them, itself an
ancestor of v1.13.0. Installed and HEAD carry byte-identical logic.

### `comfy workflow save|list|get|delete` — the gap, located

Still no `--host`/`--port`, and now precisely bounded.

```
$ comfy --json --skip-prompt --host 127.0.0.1 --port 8188 workflow list   # No such option: --host, exit 2
$ comfy --json --skip-prompt workflow --host 127.0.0.1 --port 8188 list   # same, exit 2
$ comfy --json --skip-prompt workflow list --host 127.0.0.1 --port 8188   # same, exit 2
```

Rejected at root, at the group and at the subcommand alike. `--help-json`
confirms exhaustively — including flags `--help` would hide — that root's 13
params carry no host or port, and that these four verbs declare only `--where`
(plus `save`'s `--name`/`--description`, `list`'s `--name`/`--limit`/`--sort`/
`--order`, `get`'s `--out`). The address comes from the process-wide env var
alone:

```
$ COMFY_LOCAL_URL=http://127.0.0.1:19999 comfy --json --skip-prompt --where local workflow list
  -> {"error":{"code":"server_not_running","message":"could not reach local ComfyUI during list: …"}}
```

**The plumbing already exists.** In the same file, `slots_cmd` and `set_slot_cmd`
declare `host: Annotated[str | None, typer.Option(show_default=False)] = None`
and pass it through — `--help-json` shows `--host`/`--port` on both. And
`comfy_cli/target.py`'s `resolve_target(*, where, host=None, port=None, config=None)`
already accepts and threads them, with precedence
`flag > COMFY_LOCAL_URL > 127.0.0.1:8188`. The only thing standing in the way is
that `_resolve_where_target(where)` calls `resolve_target(where=where)` and drops
them on the floor.

Unchanged across the range. `workflow.py` saw real churn (a shared cloud-error
handler, `atomic_write_text`, output-sanitisation hardening) but
`_resolve_where_target` is textually identical at both ends, and no commit adds
host/port to these four verbs.

**The bypass is mapped.** comfy-cli's own `_local_save`/`_local_delete`
(`command/workflow.py:1019` and `:1096`, running to `list_cmd` at `:1114`) use
`POST /api/userdata/{encodeURIComponent(path)}?overwrite=true&full_info=true`
with the raw workflow bytes as the body, returning the same `{path, size,
modified}` FileInfo shape the listing rows already use, and
`DELETE /api/userdata/{encodeURIComponent(path)}`, status-only. That is
structurally symmetric with the `GET` calls `src/comfy/userdata.ts` already
makes, down to the URL-building idiom.

**Mark this one as weaker evidence than the rest of this document.** The
POST/DELETE shape is read from comfy-cli's request-construction code. It was
**not** exercised against a live ComfyUI, unlike the GET side, which `userdata.ts`
records as verified against a live 0.30.2. Do not build on it without measuring
it first.

### API→UI conversion — the wall, re-confirmed

Every leg of the 2026-08-07 finding reproduced, and the search was widened.

Eleven identifiers (`api_to_ui`, `convert_api_to_ui`, `to_ui_format`,
`ui_format`, `to_frontend`, `api_to_frontend`, `frontend_format`, `denormalize`,
`un_api`, `graph_to_ui`, `litegraph`) across all 117 `.py` modules, `.py`-only and
whole-tree: **no identifier by any of those names exists.** The one qualification
is `litegraph`, which does appear as an English word in a comment and a docstring
describing the *format* — nothing defines or calls it. The single conversion module,
`comfy_cli/workflow_to_api.py`, states its direction in its own first docstring
line — *"Convert ComfyUI UI-format workflows to API ('prompt') format"* — and its
three callers (`validate`, `run`, `decompose`) are all UI→API. Its `^def`
surface gained no new exported symbol in the range.

`_is_frontend_format` has **exactly one commit in its entire history**
(`64c98838`, 2026-06-21, the commit that added it); `git log -L 49,52` shows
nothing since. `comfy_cli/fragments.py` likewise has exactly one commit, ever.
`slots_cmd`, `set_slot_cmd` and `vary_cmd` each call `_load_workflow_or_fail`
immediately after `renderer = get_renderer()`, which it takes as an argument
(`comfy_cli/command/workflow.py:175-176`, `:249-250`) — so the gate is still the
first thing that touches the file, pre-mutation, with no auto-convert branch.

The round trip was run end to end rather than reasoned about — this is new, and
was not in the original measurement. Composing a blueprint produced genuine API
JSON (`{"108": {"inputs": {…}, "class_type": "VAEDecode", …}, …}`, `ok: true`),
and feeding that exact file back to `workflow slots` on the same binary gave:

```json
{"error": {"code": "workflow_not_frontend_format",
 "message": "`comfy workflow` requires the frontend-format workflow (with `nodes[]` / `links[]`)."}}
```

exit 1. The compose→re-edit cycle is concretely broken, not theoretically.

Landmine #14 also reproduced byte-exact on `workflow fragment show`:

```
raw bytes in envelope : "default": 18446744073709551615
after JSON.parse      : 18446744073709552000     <- corrupted
```

**Why this one is genuinely hard, unlike the other two.** The existing forward
converter is ~1400 lines and needed real litegraph knowledge — subgraph proxy
sentinels, mode/bypass bits, control-after-generate stripping, dynamic combo
sub-inputs — and the forward direction has strictly *more* information than the
reverse. API format carries no canvas positions, no group boxes, no
Note/MarkdownNote text, and none of the virtual nodes (Reroute, Primitive,
Get/Set) that forward conversion elides. A reverse pass must **synthesise** all
of that. It is a design problem (auto-layout heuristic, placeholder metadata),
not a mechanical inverse.

### Other measured facts, recorded so they are not re-derived

- **`comfy validate`'s diagnostic vocabulary is 13 codes on the installed build
  and 14 at HEAD.** `no_options_available` was added in `6366c7c`: a COMBO field
  whose `object_info` declares an explicitly empty option list is now a hard
  validation error rather than silently skipped. Ground truth #27's count is
  correct today and must say 14 the day the installed copy is upgraded. Its
  central claim survives — all 14 appear in **none** of `error_codes.py`, so the
  two vocabularies remain disjoint.
- **`error_codes.py` moved +6/−1** in the range: gained `port_not_listening`,
  `unverified_process`, `no_checkpoint_available`, `gallery_cache_write_failed`,
  `host_flag_cloud`, `update_custom_nodes_failed`; lost `oauth_cancelled` to dead-code
  removal. Non-negotiable #2 exists for exactly this, and nothing here reaches
  `toolResult.ts`, which classifies on `instanceof` and never on a code string.
- **A near-miss on non-negotiable #1 at HEAD.** Commit `e36fdd3` makes
  `templates fetch` embed the entire fetched graph inline as `data.workflow` —
  but only `if not out:`. `fetchTemplate()` in `src/comfy/templates.ts` always
  passes `-o destination`, so it never fires, and `FetchPayloadSchema` is
  `looseObject` and would ignore it anyway. The hazard recurred exactly where
  CLAUDE.md predicts it will keep recurring, and an existing invariant caught it
  rather than luck.
- **`jobs status` gains a state-file fallback at HEAD** (`5798668`) but preserves
  ground truth #7: on a host/port mismatch the envelope is unchanged byte for
  byte. `jobs.ts` only gets more correct from it — a cancel of an
  already-finished job reports `already_finished` instead of `not_found` after a
  restart.
- **`docs/comfy-cli-ground-truth.md` currently contains zero template entries.**
  Every measurement about the gallery lives only in the 2026-08-07 plan document,
  which the project treats as a historical record rather than a current one.
  That is how a second-hand "28 of 103" survived four days of being cited.

## Decisions

1. **Do not derive `output_type` at search time.** Deriving it means reading a
   workflow's output nodes, and the workflow JSON is a separate network fetch per
   template. Answering one filtered query over 578 rows would cost 578
   downloads. The index has what it has; this is arithmetic, not preference.

2. **Do not derive it at fetch time either, where it would be cheap.**
   `create_workflow_from_template` has the graph on disk and could inspect it.
   It will not: that means `JSON.parse` on a workflow graph inside this server,
   which is what non-negotiable #1 exists to forbid. The measured hazard is
   parse-*then-emit* and a read-only inspection is arguably outside it — but
   that argument has to be won explicitly, in its own change, with the mutant
   that proves the seed survives. It is not worth winning to improve one echoed
   field.

3. **Keep echoing `output_type` on `create_workflow_from_template`.** Dropping
   it was considered. It is a wire-shape change that removes the key correlating
   a created workflow back to the search result that found it, in exchange for
   suppressing a value whose meaning is documented. Not worth it. The truth about
   the workflow arrives one call later from `describe_workflow`, which reads the
   real graph against the real host.

4. **Say the measured thing in the description.** "Occasionally wrong" is not a
   defensible summary of a field that is constant within a category and wrong for
   46% of a 103-row one. The caveat is the correct mitigation; it is the wording
   that is off by an order of magnitude. Name the tag vocabulary too, because
   `--tag` is exact-match and a caller who cannot guess `FLF2V` cannot reach 11
   `Use Cases` templates.

5. **Move the template measurements into `docs/comfy-cli-ground-truth.md`.** The
   register is the file this project trusts; a plan document is not. Four new
   entries, numbered from #28.

6. **The three upstream items stay out of scope for this repository's code**, and
   two of them are now known to be small — but small *upstream*. Neither
   `nodes path` nor `workflow save --host` is work that can happen in `src/`.
   Recording their cost is the deliverable here, not paying it.

7. **If writing into a named host's library is ever wanted, the route is
   `userdata.ts`, not upstream.** A POST path there is under this project's
   control and does not wait on a merge. It is a separate design, and it is
   blocked on measuring the POST/DELETE shape against a live ComfyUI — which this
   investigation deliberately did not do.

## What changes

Three files, no behaviour.

**`src/tools.ts`** — the closing clause of `search_templates`'s description.
Currently:

> Note that a template's `output_type` is inherited from its gallery category
> rather than derived from the workflow, so it is occasionally wrong; `tags` are
> the more reliable signal.

The replacement must carry four things the current text does not: that the field
*is* the category rather than merely deriving from it; that `type` is therefore
only meaningful for `Video`, `Audio` and `3D Model`; that `tag` is exact-match
with no substring; and enough of the video tag vocabulary to be usable. Roughly:

> A template's `output_type` is its gallery category restated — every category
> maps to exactly one value, and five of the eight map to `image`, so `type` is
> only meaningful for `video`, `audio` and `3d`. Measured 2026-08-11: 47 of the
> 103 `Use Cases` templates produce video while typed `image`, and
> `type: "video"` matches none of them. Filter by `tag` instead — it is exact
> and case-insensitive with no substring matching, so use a whole tag:
> "Image to Video", "Text to Video", "Video Edit", "Reference to Video",
> "Audio to Video", "Video to Video", "Video", or "FLF2V" (first-last-frame to
> video, which the word "video" will not find).

This is longer than what it replaces, and the description register is paid on
every tool listing. It is worth it: the shorter text sends a caller to a filter
that returns zero of the results they wanted, and the tag vocabulary is not
guessable.

**`docs/comfy-cli-ground-truth.md`** — four entries, following the existing
format (claim in bold, measurement, then the consequence for this server):

- **#28** `output_type` is `category_title` restated — the cardinality table, the
  47-of-103 count with its method, and `--type video` returning 0 inside a
  non-`Video` category.
- **#29** `--tag` is exact and case-insensitive with no substring support, over an
  open vocabulary — `--tag "Vid"` → 0, `FLF2V` unreachable by the word "video",
  and tags wrong in both directions (`templates_mjm_airt_machIne` typed
  "Text to Image"; `template_contact_sheet-step_2.app` tagged `Video` while
  image-only).
- **#30** `comfy nodes path` does not anchor on the source type — the vacuous
  `all()` in `can_apply`, the `LATENT → IMAGE` = `MODEL → IMAGE` proof, and the
  `from_type == to_type` short-circuit.
- **#31** `comfy workflow save|list|get|delete` take no `--host`/`--port` at any
  flag position, while `slots`/`set-slot` in the same file do — with the note that
  this is why `userdata.ts` is not redundant, and that its write side is
  read-source-confirmed only.

**`CHANGELOG.md`** — one entry under `### Fixed` or `### Notes` for the
description, and one under `### Notes` recording that the register gained the
template measurements. Per the project's workflow, log the change as it lands and
leave the version bump to `deno bump-version`.

## Testing

**There is no mutant here, and inventing one would be ceremony.** Stage 1 changes
prose and Stage 2 changes a document; neither has behaviour to mutate. This
follows the precedent the 2026-08-07 design set for its own Stage 4 — *"Whatever
description assertions the suite already carries; otherwise review against the
existing register."*

What the suite does support is the house pattern already used in
`tests/server.test.ts`, where a load-bearing token in a description is pinned by
`toContain` (`local_paths`, `3.seed`, `9007199254740991`). The load-bearing token
in the new text is the tag vocabulary a caller cannot guess:

```ts
expect(description).toContain("FLF2V");
```

That is the one assertion worth adding. It dies if someone trims the description
back to a generic caveat, which is the regression that actually matters. Pinning
the count (`47`) instead would be worse: the gallery moves, and a test that fails
when upstream adds a template is a test that gets deleted.

Nothing else needs a test. `output_type` is already pinned as an open string by
`tests/templates.test.ts:93` — the hand-built `"hologram"` fixture — and that
test is about non-negotiable #2, not about coarseness. It stays as it is.

## Staged plan

```markdown
## Stage 1: search_templates says what was measured
**Goal**: Replace the "occasionally wrong" clause with the measured claim, the
  three categories where `type` is meaningful, and the video tag vocabulary
  including FLF2V.
**Success Criteria**: A caller reading only the description knows that
  `type: "video"` will miss `Use Cases` videos, and knows a whole tag string to
  use instead. No behaviour changes; no argv changes.
**Tests**: `expect(description).toContain("FLF2V")` in the existing
  server.test.ts description block. Existing description assertions still pass.
**Status**: Not Started

## Stage 2: the measurements enter the register
**Goal**: Ground-truth entries #28-#31, and a note on #27 that its count becomes
  14 (`no_options_available`) when the installed comfy-cli is upgraded.
**Success Criteria**: `docs/comfy-cli-ground-truth.md` gains its first template
  entries; each carries the command that produced it, so it is checkable without
  re-deriving. The 2026-08-07 design doc's "28 of 103" hazard bullet is annotated
  as superseded rather than edited — the correction is the point, per the
  precedent that document already sets for its own candidate_addresses note.
  **Recompute the per-node-type breakdown and the tag recall rather than
  transcribing them from this document.** A draft of this document got both
  wrong — the breakdown by guessing, and the recall by comparing set sizes
  (44 vs 47) instead of intersecting (43 of 47) — and the register is the one
  file in this project that must not carry an unrun number.
**Tests**: None. Documentation.
**Status**: Not Started

## Stage 3: CHANGELOG
**Goal**: Record both, per the project's log-as-it-lands convention.
**Success Criteria**: An entry a reader can act on without opening this document.
  Version bump left to `deno bump-version`.
**Tests**: None.
**Status**: Not Started
```

Stages 1 and 2 are independent and either can ship alone. Stage 3 follows
whichever lands.

## Hazards carried forward

- **The 47-of-103 count is a lower bound and it will drift.** Static node-type
  inspection cannot see a third-party node saving video under a nonstandard
  class name, and the gallery grew by four templates in four days. The count is
  written into the description with its measurement date for exactly this reason;
  treat a future mismatch as drift, not as a defect.
- **Mixed-output templates are unserved by any single `output_type`.**
  `templates-sprite_sheet` and `templates-car_product` genuinely produce both.
  No derivation strategy fixes this — the field's cardinality is the problem, not
  its accuracy.
- **The tag vocabulary is open and undocumented** (non-negotiable #2), so the
  list written into the description is a snapshot. A new video tag upstream will
  be missing from it, and the description cannot self-update.
- **`FLF2V` is domain jargon in a user-facing string.** It is included because
  omitting it makes 11 `Use Cases` templates unreachable by any tag query a
  caller would think to write, but it is the one term in the description that
  needs its expansion carried alongside it.

## Out of scope

- **compose / decompose / fragment authoring.** Re-confirmed blocked on
  2026-08-11 at both the installed build and v1.15.0: no API→UI conversion
  exists, the gate is unchanged since the day it was written, and the round trip
  fails concretely. Unblocking means a ~1400-line lossy inverse that must
  synthesise layout the API format does not carry — a design problem, not an
  implementation one. **This is the one of the three that is genuinely hard.**
- **Node-by-node authoring.** `comfy nodes path` still does not anchor on the
  source type. Now known to be one vacuously-true `all()` in `can_apply`, fixable
  with a single guard in `exact_paths` — but the fix is upstream, and a
  maintainer has to decide whether zero-required-link producers should be
  reported as steps at all or only used to grow `available`. Nothing in `src/`
  can do this.
- **Writing into a named host's own library.** Still no `--host`/`--port` on the
  four saved-workflow verbs. Upstream the fix is two mechanical edits (copy the
  Typer option pattern from `slots_cmd` in the same file; forward host/port into
  `resolve_target`, which already accepts them). In this repository the route is
  a POST path in `src/comfy/userdata.ts`, symmetric with the read side — see
  decision 7, and measure the shape against a live ComfyUI before designing it.
- **Upgrading the installed comfy-cli.** Out of scope here, but it is the event
  that makes ground truth #27 say 14 instead of 13, and it should be done
  deliberately rather than as a side effect of something else.
