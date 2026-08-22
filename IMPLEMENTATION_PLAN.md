# Implementation Plan — after PR #22

**For a session picking this up cold:** the previous work is done and pushed.
Read "Where things stand" first; it is the whole handoff. Stage 1 is done and
released; **Stage 2 is the live one**, and its item 6 is the thing most worth
doing. Stages 3-4 need a decision from the user before any code is written.

---

## Where things stand

**Shipped and released.** PR [#22](https://github.com/TuesdayCrowd/mcp-comfyui/pull/22)
merged the work as `638165c`; PR [#23](https://github.com/TuesdayCrowd/mcp-comfyui/pull/23)
released it as `d2c54f4`. **`@tuesdaycrowd/mcp-comfyui@0.6.11` is live on JSR.**
`deno.json` and `src/server.ts`'s `SERVER_VERSION` both read `0.6.11`, and the
CHANGELOG's `[Unreleased]` section became `[0.6.11] — 2026-08-18`.

Release note for next time — **superseded by PR #25, do not hand-edit versions
any more.** `deno task release patch` (or `minor`/`major`) now rewrites all
three places the number lives: `deno.json`, `SERVER_VERSION` in `src/server.ts`,
and the CHANGELOG's `[Unreleased]` heading. It edits and stops — no commit, no
push, no publish — because JSR will not republish a spent version number.

The advice this replaces said to update `SERVER_VERSION` by hand and to avoid a
bare `deno bump-version` (which runs in conventional-commits mode and prepends
to a `Releases.md` this repo does not use). Both still describe `bump-version`
correctly; they are simply no longer the route to take.

It shipped two things:

1. **`describe_workflow` returns the workflow's own canvas notes** — the
   `Note`/`MarkdownNote` text its author wrote, which is where the download URL
   for every model `validate_workflow` reports missing actually lives, plus the
   VRAM/time cost. `src/workflows/notes.ts` wraps `comfy workflow notes`;
   `describe_workflow` issues it concurrently with the slots and decoy reads,
   pre-caught so it degrades to `notes_unreadable` rather than failing the call.
2. **A stale-cache floor** — with ComfyUI stopped and the `/object_info` cache
   older than its 24h TTL, both diagnostic tools used to throw (or start a GPU
   to rebuild what was on disk). `readStaleCache` is now the last resort after
   fresh → fetch → launch+refetch, disclosing `age_hours`.

Design doc, which is the binding authority for anything that touches this:
`docs/plans/2026-08-17-workflow-notes-and-stale-cache-design.md`

Verified at the branch head: `deno task test` → 156 passed (663 steps), 0
failed. `deno task typecheck` → 0 errors. Ground truth gained entries #32-#34.

### A flaky test gated publishing — FIXED 2026-08-22, and the recorded hypothesis was wrong

**Resolved.** Cause and fix are in the CHANGELOG's `[Unreleased]` entry. Two
things worth carrying forward:

- **The hypothesis recorded below (a too-short `readFor` window) was wrong**, and
  the evidence that falsified it was already in the CI log: the test failed in
  **723ms**, far short of the 5s+4s+1s a timeout theory needs. A flake that fails
  *fast* is not a timeout. The actual error named the line —
  `TypeError: Child process has already terminated` at `child.kill("SIGKILL")` —
  and the real cause was teardown killing a child whose death is the thing the
  test asserts. Reading `gh run view <id> --log-failed` first would have cost one
  turn and saved the whole hypothesis.
- **A Mac cannot reproduce this one.** Measured: the unguarded teardown passes
  15/15 even under 32 CPU burners on 16 cores, so a contention run here has no
  detection power and green proves nothing. The regression test therefore does
  not try to reproduce the race — it forces the reaped state with
  `await child.status`, so it fails 100% against the unguarded teardown on any
  platform. When a flake will not reproduce locally, pin the *state* the race
  produces rather than chasing the race.

The original note is kept below, since the publish-gating hazard it describes is
still real for the next flake.

### A flaky test gates publishing — read this before the next release

`tests/server.test.ts:2161`, "a payload beyond the buffer limit is reported on
stderr rather than dying silently", is **nondeterministic on `ubuntu-latest`**.
It is pre-existing, not from the notes/stale-cache work.

Why it matters more than an ordinary flake: `.github/workflows/publish.yml`
runs on every push to `main` and the publish step is gated behind the test step,
so a flake means **a merge to `main` silently publishes nothing**. That already
happened — the run for PR #22's merge failed on exactly this test
(`155 passed (662 steps) | 1 failed`, run `32149609864`, 2026-08-18), so the
feature work never published. 0.6.11 reached JSR only because PR #23 came along
behind it and its run happened to pass (`32150534611`).

**Check the publish run after every merge to `main` until this is fixed** —
`gh run list --workflow=publish.yml --limit 3`. A green merge is not a
published release.

### Environment gotcha that cost ~70 minutes

**This machine sleeps, and sleep kills background agents mid-run.** Four
consecutive subagent dispatches died to it, reported as generic 600s watchdog
stalls; one full test run timed out at 10 minutes that otherwise takes 19
seconds. `caffeinate -i` fixes it completely. Wrap long runs
(`caffeinate -i deno task test`) and arm a window before dispatching background
agents (`caffeinate -i -t 5400 &`).

### Conventions that bit during this work

- `deno task test:one <file>`, never a bare `deno test <file>` — it type-checks
  with a Deno-bundled TypeScript a major version behind the project's own.
- Never run two `deno test` invocations concurrently; they contend and you will
  diagnose your own contention as a defect.
- GitButler only: `but commit -b <branch> -m "..." <ids>`, never `git commit`.
- Fixture modes in `tests/fixtures/fake-comfy` and cases in `fake-comfy-dispatch`
  are append-only.

---

## Stage 1: Close out PR #22

**Goal**: the notes and stale-cache work released.
**Success Criteria**: `deno bump-version` run; CHANGELOG `[Unreleased]` becomes a
numbered release; the package is live on JSR.
**Tests**: `deno task test` green on `main`; `deno task typecheck` clean.
**Status**: Complete — 0.6.11 on JSR as of 2026-08-18.

Nothing remains here. Kept for the release note recorded above, which the next
release needs.

---

## Stage 2: Hardening follow-ups from the reviews

**Goal**: clear the four residual items the whole-branch and fix-wave reviews
raised but that were judged non-blocking, plus one Minor finding that was
verified as still outstanding.
**Success Criteria**: each item either fixed with a test that dies against the
current code, or explicitly closed with a recorded reason. For item 6
specifically: the cause identified by measurement, and the test green across a
run of repeats under contention — not one green CI run.
**Tests**: named per item below.
**Status**: **Complete — 2026-08-22.** `deno task test` → 156 passed (666
steps), 0 failed. `deno task typecheck` → 0 errors.

How each item was closed:

1. **`notes_count` is emitted** — the true pre-cap total, absent when the notes
   were unreadable. Two tests: dropped notes (30 in, 24 out) and the
   already-present untruncated case. The dropped-notes case is the one that
   matters — the existing text-trimming test caps one note's *body*, so total
   and array length are both 1 there and it cannot tell a correct
   implementation from one wired to `notes.length`. Both mutants verified dead.
   Worth noting for the `events` precedent this cites: `event_count` is
   `run.events.length` *after* the cap, so it restates its own array and the
   real total is discarded there too. `notes_count` is the better-designed of
   the two, not merely the consistent one.
2. **Both catches stay unqualified** — reviewed as a pair, decision recorded in
   `withObjectInfo`. Measured, not argued: adding
   `if (name === "ComfyUnavailableError") throw launchFailed` leaves the whole
   suite green and the caller getting the identical `comfy_unavailable` verdict
   with the identical path, because both call sites shell out to `comfy`
   immediately afterwards. Narrowing buys nothing observable and costs the
   floor's rule that every route out of the launch arrow reaches it. Pinned by
   a new test.
3. **Done** — `cliLog()` + `settledInvocationsOf(log, "launch", 1)` added, so
   the test can now tell "the floor is behind the launch" from "the floor
   replaced the launch".
4. **Both figures corrected to what the 0.32-0.34s measurement supports** —
   "four hundred times" → "over 350x", "roughly forty times" → "44-47x".
5. **Done, and the class swept rather than the instance.** `FAKE_COMFY_ARGV_LOG`
   added to `MANAGED_ENV`; an audit of every `process.env.X =` assignment in the
   file against `MANAGED_ENV` now shows 32 assigned, 0 uncleaned. (The first
   version of that audit was itself wrong — its pattern required the value on
   the same line and missed the two-line assignment at 1296. A grep-based audit
   needs its own negative control.)
6. **Fixed** — see the section above.

1. **`NoteListing.count` is computed and then discarded** (`src/tools.ts:1628`).
   `src/workflows/notes.ts` computes the true pre-cap total and its docstring
   argues at length that a capped listing "has to be able to say how much it
   left out" — but the response carries `notes`, `notes_truncated` and
   `notes_unreadable` and no count, so a caller seeing `notes_truncated: true`
   cannot learn how many were dropped. The `events` precedent it cites *does*
   surface `event_count`. Either emit `notes_count`, or drop `count` from
   `NoteListing` and delete the paragraph justifying it. Low urgency: `MAX_NOTES`
   is 24 and real workflows carry 0-2 notes.
   *Test*: extend the existing `notes_truncated` present/absent pair.

2. **The `catch (launchFailed)` at `src/tools.ts:962` is unqualified**, unlike
   the outer catch which narrows on `ObjectInfoFetchError`. So a programming
   error inside `ensureInstance`, or `ComfyUnavailableError` when the `comfy`
   binary is missing entirely, is swallowed whenever a stale cache exists. In
   practice both call sites shell out to `comfy` immediately afterwards, so a
   missing binary still surfaces from the next call — and the pre-existing
   `afterLaunch` catch is equally unqualified. Decide whether to narrow both or
   neither; do not narrow one.
   *Test*: a missing-binary case with a stale cache present, asserting which
   error the caller is told.

3. **`validate_workflow survives a failed launch the same way`
   (`tests/server.test.ts`) does not assert the launch was attempted.** It dies
   against pre-fix code so it is a real mutant-killer, but its assertions are
   equally satisfied by falling straight through to the floor without launching.
   Its sibling has the `cliLog()` + `settledInvocationsOf(log, "launch", 1)`
   pair; two lines would make this one as strong.

4. **Two rounded figures in comments** — `src/workflows/notes.ts:98` says the
   120s default is "four hundred times this command's measured cost"
   (120000/330 ≈ 364) and `src/tools.ts:129` says 15s is "roughly forty times"
   (15000/330 ≈ 45). Both round in the flattering direction. This repo's own
   rule is that a number in a comment is a measurement.

5. **Pre-existing, not from this work**: `FAKE_COMFY_ARGV_LOG` is set at
   `tests/server.test.ts:2870` but is missing from `MANAGED_ENV`, so it is not
   cleaned up in `afterEach`. Leaked env vars in this file have caused real
   hard-to-reproduce failures before.

6. **The flaky publish-gating test — the highest-value item here.**
   `tests/server.test.ts:2161` fails intermittently on `ubuntu-latest` and, per
   the section above, a failure means a merge to `main` publishes nothing. Fix
   this before it eats another release.

   *Evidence*: failed on run `32149609864` (PR #22's merge), passed on
   `32150534611` (PR #23's merge) nine minutes later, same test, same runner
   image. Passes consistently on this Mac.

   *Hypothesis, NOT verified — measure before acting on it*: the test is
   timing-sensitive by construction. It spawns the real `dist/index.js` under
   `node`, streams a 20MB line into it, and then reads stderr for a fixed
   `readFor(child.stderr, 1_000)` window before asserting the output is
   non-empty. On a slower or more contended runner the child's stderr write can
   plausibly land after that 1s window closes, leaving `stderr.trim()` empty and
   failing the assertion — while the behaviour under test (the transport dies
   loudly rather than silently) is actually correct. The surrounding 5s and 4s
   windows are candidates too. The honest first step is to reproduce it, not to
   widen a timeout on a guess: run the file in a loop under CPU contention, or
   add a temporary diagnostic to the CI step, and find out which window is
   losing.

   *Do not*: simply raise the timeouts until CI goes green. That converts a
   visible flake into a slow one and this repo has already paid for a flaky test
   that never reproduced in isolation (see `CLAUDE.md`, "Fixed, recorded so it is
   not reintroduced").

Deferred cosmetics, listed so they are not rediscovered as findings: a header
comment line ~4 columns out of alignment in `tests/fixtures/fake-comfy`; the
description test asserting `toContain("notes")` rather than the specific
untrusted-text framing; `ageMs` computed after the read+parse rather than
immediately after `stat` (sub-ms skew against ages measured in hours); and the
`objectInfo.test.ts` case named "unreadable cache" that exercises malformed
JSON. All judged fine to leave.

---

## Stage 3: Return the picture, not the path — NEEDS A DECISION

**Goal**: `run_workflow` and `get_job` return generated artifacts as MCP image
content blocks rather than filesystem paths in text.
**Success Criteria**: a completed local run puts the image in the conversation
with no separate read; a video/audio artifact returns a `comfy preview` contact
sheet or waveform plus duration/fps/has-audio.
**Tests**: a local artifact returns an image block; a remote artifact (no local
path) does not, and says why; an oversized artifact is handled rather than
blowing the response budget.
**Status**: Not Started — do not begin without the user's go-ahead.

Why it is worth considering, from the earlier analysis of the `comfy-relay`
skill: that skill's central rule is "the image is the message — text about the
image is not," and it is *structurally unavailable* through this server today.
Measured: `src/toolResult.ts:297` emits `{type: "text"}` and nothing else, ever.
MCP supports image content blocks. `run_workflow {wait: true}` already resolves
`outputs.local_paths` to files verified to exist on this machine, so the hard
part is done. `comfy preview` (installed, verified) turns video → contact sheet,
audio → waveform, image → thumbnail, and reports duration/fps/has_audio.

This is the one thing this server can do that the CLI skill cannot: put the
result in the conversation with no filesystem round-trip. It also changes the
response contract, which is why it deserves its own design pass rather than
being bolted on.

Constraint already known: only local artifacts qualify. A remote host's outputs
have no local path (see the locality rules in `CLAUDE.md`), so this sits behind
the existing `fetch_outputs` argument.

---

## Stage 4: Batch and sweep — NEEDS A DECISION

**Goal**: expose the CLI's existing batch primitives so a seed/prompt sweep is
not N round trips.
**Success Criteria**: one call produces N variants; one call waits on N jobs.
**Tests**: to be designed.
**Status**: Not Started — do not begin without the user's go-ahead.

Measured facts already established, so a future session need not re-derive them:

- `comfy workflow vary` zips per-slot value lists into N workflow variants.
- `comfy jobs wait <id> <id> ...` blocks on all of them with one call, with
  `--timeout` and `--all`.
- Both are envelope-clean and take file paths, so both fit the thin-orchestrator
  model this server already follows.

Today `run_workflow` is one run and `get_job` is one id, so a 5-seed sweep is 5
submits and 5 polling loops.

**Explicitly out of scope** unless the user says otherwise, with reasons already
measured: cloud routing (`--where cloud`) breaks the locality model that
`refuseRemoteTarget`/`resolveArtifactPath` are built on; `comfy generate` is a
non-graph proxy call that spends credits and whose spend gate has no MCP
analogue; and node/model discovery tools were cut during the last design pass
because `validate_workflow` already answers that question per-host and in
context, while `comfy models` is entirely non-functional without a running
server (ground truth #34).

---

**Remove this file when Stages 1 and 2 are done and 3-4 are either started
under their own plan or declined** — per `CLAUDE.md`, a plan does not outlive
its work.
