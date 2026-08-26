# Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:executing-plans (or
> superpowers:subagent-driven-development) to work this file stage by stage. Steps use
> checkbox (`- [ ]`) syntax. Update `Status` as you go; delete a stage's detail once it
> lands and the CHANGELOG carries it.

**Where things stand:** `run_sweep` shipped. PR #33 merged to `main` as `72bdb8b` on
2026-08-23, so the batch-and-sweep feature itself is done — four commits, 157 test files /
737 steps green, `deno task typecheck` clean, and verified live against a real ComfyUI.
What is left is paperwork and a release.

**Repo version:** `deno.json` says `0.7.0`; `CHANGELOG.md` has an `[Unreleased]` section
holding `run_sweep` and the sweep-wide copy budget.

---

## Stage 1: Close the batch-and-sweep paper trail

**Goal**: The design doc and this file stop claiming work that is finished is pending.
**Success Criteria**: `docs/plans/2026-08-22-batch-and-sweep-design.md` reports the feature
as implemented and names the PR; this file is gone.
**Tests**: None — documentation only. `deno task test` must still pass, since nothing in
`src/` or `tests/` is touched.
**Status**: Complete — 157 files / 737 steps green, typecheck clean, on this tree.

- [x] **Step 1.** `docs/plans/2026-08-22-batch-and-sweep-design.md` line 3 still reads
      `**Status:** designed 2026-08-22. Not started.` Change it to record that it shipped
      in PR #33 on 2026-08-23, and add a short note that **three of its measurements were
      corrected during implementation** — the design is otherwise accurate and worth
      keeping as the reasoning behind the shape of the code:

      - §1 says `--out-dir` makes `data.variants` **absent**. It is present and **`null`**.
        (ground truth #44)
      - §5 assumes `comfy jobs wait` fails only on a timeout. It answers `ok:false`
        whenever **any** job failed, was cancelled, or timed out, with the same summary
        moved into `error.details`. (ground truth #48)
      - §2 says `vary` warns `object_info_stale`; it does, but only on the live-fetch
        path. With `--input` there is **no `stale` key at all**, which is every remote
        sweep. (ground truth #51)

- [x] **Step 2.** Commit on a named virtual branch and open a PR. Never commit to `main`;
      never `but land`.

      **Done beyond the three.** An audit of the whole doc against
      `docs/comfy-cli-ground-truth.md` and the shipped `src/` found **three further**
      places where the implementation went a different way, each verified against the
      named source line and marked inline: the per-variant response entry is
      `{variant, values, prompt_id, status, terminal, outputs, error?}` with no
      `applied` (`tools.ts:2354`); the budget disclosure is deliberately **two**
      messages, not one reused (`fetchOutputs.ts:167,177`); and §1's "reads `written`
      and nothing else" also reads `count` and `warnings` (`tools.ts:2368,2375`),
      though the safety property it states does hold. One candidate was checked and
      **rejected**: the doc's `timeout_seconds: 1800` example is not a claim about the
      default, which is 300 s (`WAIT_TIMEOUT_MS`), with 1800 the ceiling
      (`MAX_TIMEOUT_SECONDS`) — and the tool's own schema description states it.

**Do not delete this file here** — Stage 2 lives in it. It goes when Stage 3 says so.

---

## Stage 2: Release

**Goal**: The `run_sweep` work reaches JSR under a version number.
**Success Criteria**: `deno.json`, `src/server.ts` and `CHANGELOG.md` all carry the same
new version; the publish workflow succeeds; `deno run -A jsr:@tuesdaycrowd/mcp-comfyui`
serves the new build.
**Tests**: `deno task test` and `deno task typecheck` before the bump; CI's own run after.
**Status**: Blocked on the user — **the user runs the bump.** Both gates have already
been run on this tree and pass: `deno task test` 157 files / 737 steps, 0 failed;
`deno task typecheck` exit 0, zero errors.

- [x] **Step 1.** Confirm `[Unreleased]` in `CHANGELOG.md` reads the way it should ship.
      Read and confirmed: it holds `run_sweep` (with the zipped-not-crossed statement and
      the no-graph guarantee), the 64 MiB sweep-wide copy budget, and the `jobs wait`
      partial-success fix. No edit needed.
- [ ] **Step 2.** `run_sweep` is a new tool, so this is a **minor** bump — `0.8.0`, not
      `0.7.1`. `scripts/release.mjs` keeps `deno.json`, `src/server.ts` and the CHANGELOG
      heading in step; do not edit any of the three by hand, and do not add a `version` to
      a second manifest (there is no `package.json` — see CLAUDE.md's Toolchain section).
- [ ] **Step 3.** The user runs `deno bump-version`. Do not run it unasked.

---

## Stage 3: Retire this file

**Goal**: No stale plan is left in the repo.
**Success Criteria**: `IMPLEMENTATION_PLAN.md` is gone and every stage above has landed.
**Tests**: None.
**Status**: Not Started — **blocked on Stages 1 and 2.**

- [ ] Delete this file, on a branch, with a PR. Everything worth keeping is already in
      `CHANGELOG.md`, `docs/comfy-cli-ground-truth.md` (#43–#51) and CLAUDE.md's "Verified
      end to end" — **except the "Carry-forward context" section below.** Read it before
      deleting and move anything still true into CLAUDE.md rather than losing it.

---

## Carry-forward context

Things a fresh session would otherwise have to rediscover. None of these is a task.

**The sweep budget has one line no test can reach, and that is by construction.**
`tools.ts` passes a shared `FetchBudget` to `fetchIfAsked`; removing it passes the entire
suite. A sweep-wide allowance only bites on a host that is both *remote* (or the copy never
happens) and *reachable* (or the runs never submit), and `comfy/target.ts`'s
`isLocalAddress` calls every address the suite can bind local. The limitation is stated at
the code site; the budget's arithmetic is pinned in `tests/fetchOutputs.test.ts` against a
real `FetchBudget`, and the end-to-end behaviour was measured by hand. **Do not "fix" this
by widening `--allow-net`** — every address the suite can serve on is on a local interface,
so there is nothing to widen it to.

**`scripts/smoke-sweep.mjs` is the harness for anything a fixture cannot prove.** It drives
`dist/index.js` under `node` over real stdio against a live host and checks that a 2^64−1
seed reaches the *submitted graph* byte-exact, by searching ComfyUI's own
`/history/<prompt_id>` response as **raw text**. Never `JSON.parse` that body in the
checker: doing so reintroduces the exact rounding under test and reports a corrupted seed
as intact. Run it as
`node scripts/smoke-sweep.mjs <host:port> <workflow> [seed-address]`; `dist/` must be
rebuilt (`deno task build`) first, or it tests the previous build.

**The live run earned its place.** It found a defect that all 157 test files missed —
`vary`'s `stale` key is absent whenever the schema source is `--input`, which is the normal
path for every remote sweep, so a required field failed 100% of remote sweeps while the
suite stayed green. A fixture encodes the shape you *observed*; the bug lives in the shape
you did not. Prefer a live check for anything whose failure mode is "the CLI omits a field
in a state my fixture never produced".

**Do not "correct" the dated entries in CLAUDE.md's "Verified end to end".** They record
what was measured on the day, and the header says so explicitly. The remote box was at port
`8189` with `D:\ComfyUI\output` in August 2026 and reports `8188` with `F:\Dev\ComfyUI\output`
now; the paragraph at the end of the 2026-08-22 entry already records that change. Editing
an older entry to match today turns a measurement into a fiction — which is the specific
failure the redaction note at the head of that section warns about. **Add a new dated line
instead.**

**The registry entry for the remote box is current**, as of 2026-08-24: its port and its
note were both corrected through `manage_hosts` (which backs the old file up first), and
`comfy_status` confirms ComfyUI 0.33.3 on the RTX 4070. The registry lives outside the
repo, in `~/.config/mcp-comfyui/hosts.json`; run `list_hosts` to see it rather than
recording its contents here, since a host's real name and address are exactly what must not
enter a tracked file.

---

## Deliberately not built

From the design doc's §6, recorded so nobody re-litigates them:

- **No cross-product.** The CLI zips. A `mode: "cross"` argument that expands to zipped
  lists before the CLI sees them is the shape it would take if it is ever wanted.
- **No `--where cloud`.** It breaks the locality model `refuseRemoteTarget` and
  `resolveArtifactPath` are built on.
- **No `wait_for_jobs` tool.** `comfy jobs wait --all` is tempting, but a tool that waits
  on jobs it did not submit has no ledger entry for them and no way to attribute a host.
- **No progress streaming.** A sweep either returns ids immediately or blocks; partial
  progress is what polling `get_job` is for.

---

## Standing constraints

These apply to every stage and are not specific to this plan. The full set is in CLAUDE.md.

- **Never `git commit`.** GitButler only: `but commit -b <branch> -m "…" <ids>`. PRs are
  required; never `but land`.
- **`deno task test`** for the suite, **`deno task test:one <file>`** for one file; a bare
  `deno test <file>` fails. Never run two `deno test` invocations at once.
- **`deno task typecheck` is the authoritative compile gate**, not `deno check`.
- **`caffeinate -i`** around long runs — this machine sleeps mid-run and disguises it as a
  watchdog stall.
- **Mutation testing is the standard**, not an extra: construct the named mutant, confirm
  the test dies, restore by checksum. A survivor is either a test gap or a mutant that
  changes nothing — say which.
- **Fixture modes in `tests/fixtures/fake-comfy` are append-only.**
- **No personally identifying markers in any tracked file.** The repo is public and `src/`
  ships to JSR. Use `~/`, `rtx-video`, `198.51.100.10`. Sweep everything, not just `*.md`:
  `git ls-files | xargs grep -InE '<markers>'`.
- **Never assert what you have not run.** In this project every claim that was measured
  held up, and roughly half of what was inferred about comfy-cli was wrong.
