# One call, N variants

**Status:** designed 2026-08-22. Not started.
**Date:** 2026-08-22

Comparing four seeds today is four `run_workflow` calls and four polling loops.
The CLI already has both halves of the answer — `comfy workflow vary` zips
per-slot value lists into N workflow files, and `comfy jobs wait` blocks on many
`prompt_id`s at once — and both are envelope-clean and take file paths, so both
fit the thin-orchestrator model without this server ever touching a graph.

This is the design for `run_sweep`.

## Which comfy produced these numbers

Behavioural claims below were executed on **2026-08-22** against the installed
`comfy`, with no ComfyUI running (`127.0.0.1:8188` refused), against a real
28-workflow directory.

---

## 1. The measurement that decides the architecture

**`comfy workflow vary` returns whole workflow graphs in its envelope.**
Measured: `data.variants` is a list of frontend graphs — `nodes`, `links`,
`last_node_id`, `last_link_id`, `groups`, `config`, `extra`, `version` — at
**6,489 bytes each** for a 3-variant sweep of a small workflow.

That is **non-negotiable #1**, exactly: *never let JS parse or re-serialise a
workflow graph*, because seeds reach 2^64−1 and JavaScript rounds above 2^53.
Decoding that envelope naively would corrupt every large seed in every variant —
and a seed sweep is the one workflow where seeds are the entire point.

**`--out-dir` removes the hazard at the source.** Measured: with `--out-dir`
set, `data.variants` is **absent** from the envelope entirely. What comes back
instead is `written`, a list of file paths, plus `out_dir`, `count`, `warnings`
and `stale`. The graphs go to disk and never enter this process.

**And the CLI's own write is byte-exact.** Measured with
`--slot '3.seed=[18446744073709551615,1]'`: the written variant contains
`18446744073709551615`, not the rounded `18446744073709552000`. Python's
arbitrary-precision integers carry it intact.

So the whole chain is safe **as long as this server never parses a variant**:
`vary --out-dir` writes files → `run_sweep` submits each file by path →
`workflows/run.ts` already drops the graph it gets echoed back. `run_sweep`
therefore reads `written` and nothing else from that payload.

**This is the design.** Everything below follows from it.

## 2. What else was measured

- **Values are JSON arrays, not comma lists.** `--slot '3.seed=1,2,3'` is
  refused with `workflow_slot_invalid`: *"value must be a JSON array (got
  str)"*, and the hint names the correct form,
  `--slot '6.text=["a cat","a dog"]'`. `--slot '3.seed=[1,2,3]'` succeeds.
- **Lists are zipped, not crossed.** Two `--slot` arguments of length 3 produce
  **3** variants, not 9, and `--help` states every `--slot` must carry the same
  length. A caller expecting a cross-product gets a quarter of the runs it
  wanted and no error, so `run_sweep`'s description must say *zipped* in its
  first sentence.
- **`vary` consults `/object_info`** and accepts `--input`, `--host`, `--port`.
  With nothing running it emitted a `warnings` entry, `object_info_stale`, and
  still succeeded — the same stale-cache posture this server already has, and
  it means a sweep can be *built* with no GPU up.
- **`written` names the files**, `<out-dir>/<stem>_000.json` upward, zero-padded
  to three digits.
- **`comfy jobs wait [prompt_ids…]`** blocks until all are terminal, with
  `--all` for every tracked job, `--poll-interval` (default 5.0 s) and
  `--timeout` (default 1800 s).
- **Redirecting `vary`'s stdout selects JSON mode**, so `> out.ndjson` needs an
  explicit `--no-json` (ground truth #42). Irrelevant here — this server always
  wants the envelope — but recorded so nobody "fixes" it.

## 3. The tool

`run_sweep`, a new tool rather than an overload of `run_workflow`.

`run_workflow` keeps one contract and one return shape. A sweep's zip semantics
— *all lists must be the same length* — are a rule the caller has to know, and
burying them inside an existing `inputs` argument means an array passed by
accident silently becomes a sweep. A separate tool states the rule in its own
description and cannot be entered unintentionally.

```jsonc
run_sweep {
  workflow: "default_image_gen",
  host: "rtx-video",              // optional, as everywhere else
  inputs: { "3.seed": [1, 2, 3] },  // per-slot LISTS, zipped
  fixed:  { "6.text": "a cat" },    // optional: same on every variant
  wait: false,                      // default; true blocks on all of them
  timeout_seconds: 1800,
  fetch_outputs: false
}
```

`inputs` values are arrays and every array must be the same length; `fixed` is
an ordinary slot map applied to all variants. Splitting them is what lets the
tool reject a length mismatch *before* spending a CLI call, and what keeps
"vary this" visually distinct from "set this".

**Response**: the sweep's own summary plus one entry per variant, each carrying
what `run_workflow` returns for a single run — `prompt_id`, `status`,
`applied`, `outputs`. Plus `variant_count`, and `failed` for variants that could
not be submitted at all.

## 4. Artifacts: the per-artifact ceiling, plus a sweep-wide budget

The 16 MiB per-artifact ceiling from the artifact-local-paths work applies
unchanged. A sweep adds a **total budget across all variants**, because sixteen
variants at a few megabytes each is tens of megabytes copied from one call that
never asked for any of it.

`SWEEP_FETCH_BUDGET_BYTES = 64 * 1024 * 1024` — four full-size images at the
per-artifact ceiling, or many more at realistic sizes. Artifacts are copied in
variant order until the budget is spent; the rest land in `not_fetched` with
`the sweep's NN MB copy budget was already spent`, reusing the disclosure that
already exists rather than inventing a second one.

`fetch_outputs: true` lifts both bounds, exactly as it lifts the per-artifact
one today.

## 5. Submission and waiting

**Submit sequentially, in variant order.** ComfyUI executes one prompt at a
time regardless, so concurrency buys nothing at the GPU and costs determinism in
the ledger and the response ordering. Each submit records its `prompt_id`
against the host in `jobLedger.ts`, exactly as `run_workflow` does — a sweep of
five is five ledger entries, and `get_job` on any of them keeps working with no
`host` argument.

**A variant that fails to submit does not stop the sweep.** The same rule
`fetchArtifacts` follows: one bad variant must not deny the caller the other
four. It lands in `failed` with its error, and the run continues.

**`wait: true` uses `comfy jobs wait` with every id in one call** — that
primitive is the whole reason this is one round trip instead of N. Its
`--timeout` takes the tool's `timeout_seconds`.

**Temp directory ownership.** `vary --out-dir` writes into a directory this
server creates and owns, and disposes in a `finally` on every path, on the same
model as `setSlots.ts`'s prepared copies. The submitted file must outlive the
submit call, so disposal happens after all submissions, not per variant.

## 6. What this deliberately does not do

- **No cross-product.** The CLI zips; inventing a cross-product here would mean
  generating the value lists in JS and is a different feature. If it is wanted
  later, it is a `mode: "cross"` argument that expands to zipped lists before
  the CLI ever sees them.
- **No `--where cloud`.** It breaks the locality model `refuseRemoteTarget` and
  `resolveArtifactPath` are built on (measured previously; unchanged).
- **No new `wait_for_jobs` tool.** `comfy jobs wait --all` is tempting, but a
  tool that waits on jobs it did not submit has no ledger entry for them and no
  way to attribute a host. `get_job` already covers the single-id case.
- **No progress streaming.** A sweep either returns ids immediately or blocks;
  partial progress is what polling `get_job` is for.

## 7. Risks

- **Zip-not-cross is the likely user error**, and it fails silently in the sense
  that it produces valid output of the wrong size. Mitigated by stating it in
  the description's first sentence, by rejecting mismatched lengths before the
  CLI call, and by echoing `variant_count` in the response.
- **A sweep is N GPU runs.** `wait: true` on sixteen video variants is hours.
  The description must say so; `timeout_seconds` is the guard.
- **`vary` needs `/object_info`** and warns when it is stale. A sweep built
  against a stale cache can name a value the host no longer has, which surfaces
  as a per-variant submit failure rather than a sweep failure — acceptable, and
  visible in `failed`.

## 8. Success criteria

- `run_sweep {inputs: {"3.seed": [1,2,3]}}` returns three `prompt_id`s, and
  `get_job` answers for each with no `host` argument.
- A 2^64−1 seed in a sweep list reaches the submitted graph byte-exact.
- Mismatched list lengths are refused before any CLI call.
- A sweep past the copy budget discloses the rest in `not_fetched`.
- One variant failing to submit leaves the others' `prompt_id`s intact.
- `deno task test` and `deno task typecheck` clean; every mutant confirmed.
