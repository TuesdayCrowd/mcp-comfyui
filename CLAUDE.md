# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An MCP server that exposes ComfyUI workflows to MCP clients, driving [comfy-cli](https://github.com/Comfy-Org/comfy-cli) rather than ComfyUI's HTTP API directly. See `README.md` for the user-facing picture.

## Commands

```bash
deno task test                              # full suite
deno task test:one tests/describe.test.ts   # one file (see below — a bare `deno test <file>` fails)
deno task typecheck                   # tsc --noEmit, via node — see "Toolchain" below
deno task build                       # -> dist/index.js, runnable under plain `node`
deno task compile                     # -> dist/mcp-comfyui (self-contained binary, optional)
deno task release patch|minor|major   # bump the version in all THREE places it lives
```

**Use `deno task release`, not `deno bump-version`.** The version number lives in
three files — `deno.json`, `SERVER_VERSION` in `src/server.ts` (a deliberate
literal, not an import of the manifest), and the CHANGELOG's `[Unreleased]`
heading, which a release turns into a dated section. `deno bump-version` rewrites
only the first, and `SERVER_VERSION` drifted from the manifest for four releases
before `tests/server.test.ts` started pinning them together. `scripts/release.mjs`
edits all three and re-reads them at the end rather than trusting its own edits;
it deliberately does **not** commit, push or publish, since JSR refuses to
republish a version number and a spent one is spent. Two design docs under
`docs/plans/` predate this script and still say "leave the version bump to
`deno bump-version`" — they are dated records, and this is the current answer.

**No per-test `--filter` for a file that uses `beforeEach`/`afterEach`/`beforeAll`.** Every test in this project's `tests/support/testing.ts` shim is registered through `@std/testing/bdd`'s `it` (aliased `test`); a file with hooks becomes one wrapping `Deno.test` named `"global"` with each `test()` as a *step*, and `deno test --filter` matches only top-level test names — it cannot reach into steps. `deno test --filter "…" tests/exec.test.ts` therefore runs either the whole file or nothing, never a single case inside it. The file itself is the practical unit (`deno test tests/foo.test.ts`); to isolate one test inside a hooked file, add `test.only(...)` at that call site temporarily (bdd's `it.only`, re-exported through the same shim) and remove it before committing. Files with no hooks at all (`target.test.ts`, `envelope.test.ts`, `index.test.ts`, `describe.test.ts`) register as ordinary top-level tests, and `--filter` reaches them by name.

**A bare `deno test <file>` does not work here** and has not for some time: it type-checks by default, and Deno's bundled TypeScript is a full major behind this project's own — enough to reject `import.meta.dirname` in `tests/describe.test.ts` and the SDK's handler signatures in `src/tools.ts`. Measured against the released 0.5.0 as well, so it is not a regression. `deno task test:one <file>` carries the same `--no-check` and the same permissions as `deno task test`; the authoritative compile gate remains `deno task typecheck`.

There is no lint step and no formatter config; match the surrounding style.

## Toolchain

Deno 2 runs the test suite and builds `dist/index.js` (via `deno bundle`). That artifact targets **Node** (`engines.node >= 18`) and backs the from-source install and `deno task compile`; Deno never appears at runtime. `src/comfy/exec.ts` deliberately still spawns `comfy` through `node:child_process`, not `Deno.Command`, because that is what keeps `dist/index.js` runtime-agnostic; do not "modernize" it to a Deno-only API. Bun is not part of the toolchain, but it remains a supported *runtime*: `bun dist/index.js` runs the server, and nothing here should say otherwise.

**Distribution is JSR only. This is a decision, not a gap — do not "fix" it by publishing to npm.**

| Channel | State |
|---|---|
| JSR `@tuesdaycrowd/mcp-comfyui` | published — `deno run -A jsr:@tuesdaycrowd/mcp-comfyui` |
| npm `mcp-comfyui` | **not published, and will not be** (registry returns 404) |

So `npx -y mcp-comfyui` and `bunx mcp-comfyui` do not resolve and never will. Do not write them into a doc, a README, or an install instruction.

**A freshly published version is not immediately installable, by design.** Deno enforces a **minimum dependency age** — 24 hours by default — so for a day after a release `deno run -A jsr:@tuesdaycrowd/mcp-comfyui` still resolves to the *previous* version, and naming the new one explicitly fails with *"Could not find version … that matches specified version constraint"* plus a hint about the policy. Measured 2026-08-26, minutes after 0.8.0 published: the bare specifier ran 0.7.0 and the pinned `@0.8.0` refused. Nothing is broken when this happens, and **it reads exactly like a failed publish** — a green `Publish to JSR` step and an install that serves the old version. `https://jsr.io/@tuesdaycrowd/mcp-comfyui/meta.json` is the authority; pass `--min-dep-age 0` to verify a release inside that window.

**`deno.json` is the only manifest. There is no `package.json`** — it was deleted in 0.6.0, once measurement showed only two things in it were load-bearing and both had better homes. `typescript` and `@types/node` are now `npm:` entries in `deno.json`'s own `imports`, which `nodeModulesDir: "auto"` materialises into `node_modules` for `tsc` — verified from a clean room, with `node_modules` and `deno.lock` both deleted. Everything else it held (`bin`, `files`, `prepublishOnly`, `scripts`, `description`, `repository`, `keywords`) was npm-registry metadata for a channel this project does not use, and the duplicate `version` field had already caused two silent desyncs.

Two things that came out of that and must not be undone:

- **The SDK is mapped bare, not by prefix.** `"@modelcontextprotocol/sdk": "npm:@modelcontextprotocol/sdk@1.30.0"`, so subpaths like `@modelcontextprotocol/sdk/types.js` resolve through the package's own `exports`. The old trailing-slash prefix mapping (`"…/sdk/": "npm:…@1.30.0/"`) only ever worked because `package.json` listed the SDK as a dependency and Deno resolved it through `node_modules` instead; with the manifest gone it fails outright with "could not be URL-parsed relative to the URL prefix".
- **`scripts/build.mjs` writes `dist/package.json` holding `{"type":"module"}`.** Node decides whether a `.js` file is ESM from the *nearest* `package.json`, and `dist/index.js` no longer has one above it. Node 22.7+ detects module syntax by itself so this is invisible there; **Node 18 and 20 fail** with `Cannot use import statement outside a module`. `tests/server.test.ts` pins both the file and a real `node --no-experimental-detect-module` run.

Node and Bun are still supported, via JSR's npm-compat mirror: `npx jsr add @tuesdaycrowd/mcp-comfyui` installs `@jsr/tuesdaycrowd__mcp-comfyui`, which carries `bin: null` — `deno.json` has no `bin` field to translate — so it provides no command and must be run by explicit path (`node node_modules/@tuesdaycrowd/mcp-comfyui/src/index.js`, verified under both node and bun). That indirection is permanent; treat it as the Node/Bun story rather than a workaround awaiting a fix.

`deno.json`'s own type-check (`deno check` / `deno test`'s default checking) has a known false-positive gap against this project's `@modelcontextprotocol/sdk` + zod 4 combination — Deno 2.9.4 bundles TypeScript 6.0.3, and this project's own `typescript` devDependency is a full major ahead. `deno task test` therefore runs with `--no-check`, and so does the publish workflow's `npx jsr publish --no-check`; the authoritative compile gate for what ships is `deno task typecheck`, which is `tsc --noEmit` under `node`, using this project's own pinned TypeScript, and passes with zero errors. Re-run it (not `deno check`) before trusting a "compiles" claim about `src/`.

**The publish step in particular must keep `--no-check`.** `npx jsr publish` downloads its *own* Deno rather than the version `setup-deno` pinned, so leaving the check on makes an irreversible step depend on whichever TypeScript that download happens to carry: 0.5.0 published cleanly and 0.6.0 failed with 21 of these false positives, on the same class of code. The `tsc` gate runs first in the same job, so nothing publishes without a real type-check.

## Architecture

A thin orchestrator. **The server never parses or rewrites a workflow graph.** It shells out to `comfy` and parses that CLI's stable `envelope/1` JSON contract.

```
src/comfy/          the CLI and instance layer
  envelope.ts       decodes envelope/1; the single decode point
  exec.ts           the ONLY place this project spawns a process
  target.ts         host/port resolution and address parsing, so they cannot diverge
  objectInfo.ts     /object_info fetch + disk cache (also feeds --input), per host
  outputs.ts        artifact path-vs-URL rule, shared by run and jobs
  userdata.ts       a REMOTE instance's own saved workflows, over its HTTP API
  fetchOutputs.ts   copy a remote run's artifacts here, on request only
  jobs.ts           jobs status | ls | cancel | wait (many ids, one call)
  instance.ts       detection and guarded launch
  templates.ts      the gallery: search and fetch. No host — it is not a ComfyUI.
  validate.ts       comfy validate; decodes its own envelope (landmine #27)
src/workflows/
  discover.ts       find workflow files, classify by CONTENT not filename
  slots.ts          comfy workflow slots -> typed Slot[]
  describe.ts       slots × object_info -> JSON Schema   ← the value-add
  setSlots.ts       byte-copy (or byte-write) + set-slot in place
  notes.ts          comfy workflow notes -> the author's canvas notes, capped
  vary.ts           comfy workflow vary --out-dir; reads the FILE PATHS only
  run.ts            comfy run --json, NDJSON decoded line by line
src/config.ts       workflow roots and env-var vocabulary
src/hosts.ts        the host registry: load, validate, resolve, repair, write
src/jobLedger.ts    prompt_id -> the host it was submitted to
src/index.ts        stdio entrypoint — the ONLY place that touches stdio
src/server.ts       assembles the McpServer; delegates registration to tools.ts
src/tools.ts        the MCP surface: every tool's schema, description, annotations
src/toolResult.ts   throw -> classified tool result; the error-mapping table
```

Dependency direction is one-way: `workflows/` may import `comfy/`, never the reverse. `hosts.ts` and `jobLedger.ts` sit beside `config.ts` and import `comfy/target.ts` for the one authoritative answer about addresses; nothing in `comfy/` imports either of them.

**Which ComfyUI is decided per call, not at startup.** `tools.ts` reads the registry on every tool call and resolves the call's `host` against it (`resolveTarget`). The file is a few hundred bytes against calls that already read whole workflow files, and reading it per call is what lets `manage_hosts` take effect immediately with no shared mutable state to invalidate. `ToolConfig` still carries `host`/`port`: they describe the *default* host, and they are the whole configuration of an installation with no registry file.

## Non-negotiables

These are not style preferences. Each was measured, and each has a test pinning it.

**1. Never let JS parse or re-serialise a workflow graph.** ComfyUI seeds reach 2^64−1; JavaScript rounds above 2^53. Measured: `set-slot --stdout` on a graph holding `18446744073709551615` returned the exact digits, and our `JSON.parse` corrupted that *untouched* seed to `18446744073709552000`. Hence the byte-copy in `setSlots.ts` and the graph-dropping in `run.ts` (`comfy run --json` echoes the whole graph as a `prompt_preview` event on every run). **Assume this recurs anywhere a comfy payload can contain a graph.**

It has now recurred a third time. `comfy workflow vary` returns whole frontend graphs in `data.variants` — 84,918 bytes each on a real template, measured 2026-08-22 — and `--out-dir` is what stops it: the graphs go to disk and the envelope reports `written`, a list of paths, with `variants` present and **null**. `src/workflows/vary.ts` therefore requires `outDir` rather than defaulting it, and its payload schema deliberately does not declare `variants`, so a future CLI that returned graphs under `--out-dir` anyway would still have them stripped. Ground truth #43–#45.

**2. Every registry from the CLI is an open string** — `error.code`, slot `type`, job `status`, run `event.type`. Upstream documents error codes as append-only, and its published schemas are already behind its own source. Closing an enum breaks the server on the next CLI release. Tests assert the published enums are incomplete, so the argument stays checkable.

`comfy validate`'s diagnostic codes (`unknown_enum_value`, `required_input_missing`,
`dangling_edge`, …) appear in NONE of comfy-cli's published `error_codes.py` registry — a
second, wholly undocumented open-string vocabulary. Measured 2026-08-07, re-counted
2026-08-12: **13 on the installed build and 14 upstream**, the addition being
`no_options_available`. The prediction this rule exists to guard against has already come
true once, and cost nothing because the enum was never closed. Ground truth #27.

The template gallery is a third such registry, and the coarsest: `output_type` is
`category_title` restated, not a property of the workflow, so 47 of the 103 `Use Cases`
templates are typed `image` while producing video and `--type video` matches none of them.
Ground truth #28–#29; do not try to "fix" the field by deriving it — see the reasoning in
`templates.ts`.

**3. Branch on the envelope, never on the exit code.** Exit 1 covers missing file, downed server, HTTP error, conversion failure, validation failure, and execution error alike.

**4. Global flags precede the subcommand.** `--skip-prompt`, `--json` and the workspace flags are Typer *root* options. `comfy jobs ls --json` fails; `comfy --json jobs ls` works.

**5. stdout is the MCP protocol.** Nothing may `console.log`. Diagnostics go to stderr.

**6. Never launch a second ComfyUI, never launch for another machine, and never claim another machine's file is here.** Detect first, on both the detection target and the address the startup args name. Auto-launch is on by default, so this fires from ordinary tool handlers — hence the in-flight launch map in `instance.ts`, keyed by resolved `host:port` **per address, not globally**: two launches for the same address are one piece of work and collapse, while two for different addresses are both legitimate and must both proceed. `comfy_status` never launches. A tool that may launch cannot be annotated `readOnlyHint: true`.

`launchInstance` also refuses any target that is not an address on this machine (`refuseRemoteTarget`, using `target.ts`'s `isLocalAddress`). `comfy launch` has no `--host`: it starts a process wherever `comfy` runs. Before that gate existed, aiming the server at a sleeping remote started a ComfyUI *here*, polled the remote for the full five-minute readiness budget, reported a timeout, and left the local process orphaned — `--background` had already detached it. The check fails closed: any host but `localhost` that is not literally an address on a local interface is refused rather than resolved through DNS, because a wrong refusal prints an explanation and a wrong acceptance recreates the orphan.

That gate is now enforced twice, at two different distances. `launchInstance` refuses a non-local target outright (`RemoteLaunchRefusedError`, reported as `host_not_local`); and `tools.ts`'s `ensureRunning` never reaches it for a remote host at all — it probes, and reports `host_unreachable` if nothing answers. The second exists because the first's message would be the wrong one: `InstanceUnavailableError` offers `MCP_COMFYUI_AUTO_LAUNCH=1` as the fix, and for a box on another network that setting cannot help.

The same locality question decides artifact paths. `comfy/outputs.ts` resolves a `/view` URL against the output directory the running instance reported and then checks the file exists — **on this machine**. A remote Linux box with `/home/x/ComfyUI/output` would pass that check against a completely different image; the live Windows remote hid this by accident, since `D:\ComfyUI\output` is not `isAbsolute` under POSIX. `resolveArtifactPath` now refuses a non-local instance first, before any of the other checks.

**7. A job belongs to the host that ran it, and a guess is not detectable.** comfy-cli does not attribute jobs to hosts: the `host`/`port` in a job payload echo the flag the caller passed. Measured, asking the wrong host about a real job answers `prompt_not_found` — byte-identical to the answer for an id that never existed. So `src/jobLedger.ts` records where each run was sent, and `get_job`/`cancel_job` refuse rather than guess: a miss falls through to the only host when the registry holds exactly one (there is nothing to get wrong), and otherwise names the candidates. The ledger is in memory and bounded; attribution deliberately does not survive a restart, because persisting it means a second file format for a case whose workaround is one argument.

The full list of verified landmines — each with the measurement behind it — is in [`docs/comfy-cli-ground-truth.md`](docs/comfy-cli-ground-truth.md). **Read it before changing anything that touches the CLI.** Several were found only after the bug they caused; none is inferred.

**Some slot addresses are decoys** (ground truth #15). An input fed by a link **from another node in the same scope** is listed by `slots` and reported `applied` by `set-slot`, but its value is resolved from that upstream node during conversion and silently discarded. Setting the inert pair on `audio_stable_audio_3_medium.json` produced 150s of tropical house for a request of "black metal, 60s"; setting the upstream primitives that feed those links produced exactly 60.000s of the requested prompt. Subgraph workflows are fully usable — the hazard is picking the wrong address, so the server must mark the inert ones rather than offering both alike.

**Being link-fed is not the test; the link's origin is** (ground truth #26). An input fed from the subgraph *boundary* sentinel (`origin_id` < 0) is link-fed and is **not** a decoy — it is the only address that works, because `set-slot` cannot address the parent instance's own widget at all and that widget has no effect on the submitted graph. This was got backwards once, on `video_wan2_2_14B_i2v`'s `129/93.text`, and the fix nearly shipped as "refuse it" — which would have blocked the sole working address on every gallery subgraph template. `classifyInput` in `discover.ts` is where the distinction lives.

## Working here without wasting turns

Rules earned by getting each of these wrong in this repo, usually more than once. They are about tool use, not about ComfyUI.

**Never assert what you have not run.** In this project every claim that was *measured* held up, and roughly half of what was *inferred* about comfy-cli was wrong — the `age < 0` mtime guard would have disabled the object_info cache entirely; "set-slot silently ignores a bad address" was backwards (it hard-fails); "`MCP_COMFYUI_WORKSPACE` fixes artifact paths" is impossible by construction. Before a factual claim about the CLI goes into a task brief, a doc, or a commit message, run the command. `docs/comfy-cli-ground-truth.md` exists so this only has to be paid once per fact.

**Verify the effect before measuring the cost.** A benchmark of a run that did the wrong thing is worse than no benchmark. Check the submitted graph, the output file, the actual dimensions — *then* time it.

**Shell discipline.** Every one of these cost a wasted turn:

- More than one pipe, or any heredoc → **write a script file and run the file.** Inlining is where backtick interpolation and quoting failures come from.
- **Never post-process `but status` or `deno test` through `grep`/`awk`.** `but status -fv` prints box-drawing characters that become garbage "IDs"; a piped `deno test | grep -A` buffers and gets backgrounded. Write output to a file, then read the file.
- **Pass data to a child process explicitly**, never through an ambient shell variable — `FOO=x deno eval '…Deno.env.get("FOO")…'` in one compound command does not do what it looks like.
- **Never run two `deno test` invocations at once.** They contend, 5-second budgets blow, and you will diagnose your own contention as a defect.
- Check a command exists before scripting around it (`but mark` does not).

## Testing

Tests never contact a real ComfyUI and never invoke the real `comfy`. The CLI is faked by `tests/fixtures/fake-comfy` (dependency-free POSIX `sh`, driven by `$FAKE_COMFY_MODE`, argv captured to `$FAKE_COMFY_ARGV_OUT`); HTTP is faked with `Deno.serve({port: 0})`. Fixture modes are append-only — never change an existing one.

**One tool call can be several CLI calls, and `$FAKE_COMFY_MODE` names only one of them.** `run_workflow` shells out twice — `workflow set-slot`, then `run` — so `tests/fixtures/fake-comfy-dispatch` sits in front of the fixture, picks a mode from the *subcommand* and `exec`s it. That keeps every mode written before this existed behaving exactly as it did. Its vocabulary, all optional:

| variable | applies to | default |
|---|---|---|
| `FAKE_COMFY_SET_SLOT_MODE` | `workflow set-slot` | `set_slot` |
| `FAKE_COMFY_RUN_MODE` | `run` | `run_stream` |
| `FAKE_COMFY_JOBS_MODE` | `jobs` | `jobs` |
| `FAKE_COMFY_NOTES_MODE` | `workflow notes` | `notes_file` |
| `FAKE_COMFY_VARY_MODE` | `workflow vary` | `vary` |
| `FAKE_COMFY_SLOTS_MODE` | `workflow slots` | *opt-in — no default* |
| `FAKE_COMFY_LAUNCH_MODE` | `launch` | *opt-in — no default* |
| `FAKE_COMFY_DISPATCH_LOG` | every call; argv **appended** | unset |

The last three are the ones worth knowing. `SLOTS_MODE` and `LAUNCH_MODE` are deliberately undefaulted so that tests predating those call sites are untouched, and `DISPATCH_LOG` exists because the fixture's own `$FAKE_COMFY_ARGV_OUT` is *overwritten* per call — it therefore holds only the last of the two, which is never the `set-slot` one. Anything the dispatcher does not recognise falls through to `$FAKE_COMFY_MODE`, so a single-command test can still arm the fixture directly.

Fixtures are real captures from a live ComfyUI 0.29.0 and 0.30.2, plus comfy-cli's own published JSON Schemas.

**Two hosts in one test are two ports on loopback.** `deno task test` grants `--allow-net=127.0.0.1,[::1],192.0.2.1`, so a second *address* is not available — except `192.0.2.1`, an RFC 5737 documentation address that is on no interface anywhere and answers nothing, which is exactly what a sleeping remote is and is the fixture the launch-refusal tests use. Its probe costs the 2-second budget; that is deliberate, and it buys the test that pins the defect this whole feature was designed around.

**One line in the sweep path is unreachable by any test here, and that is by construction.** `tools.ts` passes a shared `FetchBudget` to `fetchIfAsked`; removing it passes the entire suite. A sweep-wide allowance only bites on a host that is both *remote* (or the copy never happens) and *reachable* (or the runs never submit), and `comfy/target.ts`'s `isLocalAddress` calls every address the suite can bind local. **Do not "fix" this by widening `--allow-net`** — every address the suite can serve on is on a local interface, so there is nothing to widen it to. The limitation is stated at the code site, the budget's arithmetic is pinned in `tests/fetchOutputs.test.ts` against a real `FetchBudget`, and the end-to-end behaviour was measured by hand.

**A fixture encodes the shape you observed; the bug lives in the shape you did not.** The `run_sweep` live run found a defect the whole suite could not, because the fixture always emitted a key the real CLI omits under `--input` — ground truth #51, recorded in full under "Verified end to end" below. Prefer a live check for anything whose failure mode is "the CLI omits a field in a state my fixture never produced". **`scripts/smoke-sweep.mjs` is the harness for that**, run as `node scripts/smoke-sweep.mjs <host:port> [workflow] [seed-address]` against a live host — rebuild `dist/` with `deno task build` first, or it tests the previous build. It reads ComfyUI's own `/history/<prompt_id>` as **raw text**; **never `JSON.parse` that body in the checker**, or you reintroduce the exact rounding under test and a corrupted seed reports as intact.

**Three such harnesses exist.** Each drives `dist/index.js` over real stdio the way an MCP client does, so **`deno task build` first** or you are testing the previous build. Each forces `MCP_COMFYUI_AUTO_LAUNCH=0`, so none of them can start a GPU process while you are aiming at another machine.

| harness | proves the thing no fixture can | needs |
|---|---|---|
| `node scripts/smoke-templates.mjs` | a real gallery template fetches and lands as an ordinary local workflow | network; **no** ComfyUI (it exits 1 on `object_info_unavailable` — that path is the point) |
| `node scripts/smoke-remote-artifacts.mjs <host:port> [workflow]` | a run on another machine has its artifacts copied here | a live **remote** ComfyUI |
| `node scripts/smoke-sweep.mjs <host:port> [workflow] [seed-address]` | a 2^64−1 seed reaches the **submitted graph** byte-exact | a live ComfyUI |

The last two need a host that is both remote and reachable, which `deno task test` structurally cannot provide — see the `FetchBudget` note above for why.

**The job ledger is module state and outlives a test.** `tests/server.test.ts` calls `clearJobLedger()` in `beforeEach` because every test there polls the same `PROMPT_ID` constant, and without it a later test inherits an earlier run's host and port. That is correct in production, where a `prompt_id` belongs to exactly one run. Tests also point `MCP_COMFYUI_HOSTS_FILE` inside their own temp directory, or they would read whichever real `~/.config/mcp-comfyui/hosts.json` the machine running the suite happens to have. That registry lives outside the repo on purpose: run `list_hosts` to see what it holds rather than recording its contents anywhere tracked, because a host's real name and address are exactly what must not enter a public file.

**Mutation testing is the standard here, not an extra.** Every module was developed against constructed mutants, and several real defects were found only that way — a suite can be thorough and still be unable to express the failure that matters. When you change behaviour, construct the mutant that would break it and confirm your test dies. Restore by checksum afterwards; an interrupted mutation run that leaves a mutant applied has happened.

Rule-shaped code (when to drop a constraint, which source wins) needs hand-built adversarial inputs. Real fixtures come from a healthy install and cannot reach the degenerate cases.

## Version control

GitButler. Use the `gitbutler` skill and `but commit`, never `git commit`.

**Pull requests are required.** Commit to a named virtual branch, `but push <branch>`, then open a PR (`but pr new`, or `gh pr create` — `gh` is authenticated with `repo` scope here even when GitButler's forge auth is not). Never commit to `main`, and **do not use `but land`**: it pushes straight to `origin/main`, skipping review and CI, and `but undo` cannot un-push it. This repo previously did land directly; that override was retired on 2026-08-07.

## Releasing

There is exactly one automated gate — `.github/workflows/publish.yml` — and it is
the same job on a pull request and on a push to `main`. Only the final step is
conditional, so a PR runs the identical steps, on the identical pinned Deno
(2.9.4) and Node (20), that will gate the release. That symmetry is deliberate:
until 2026-08-22 the gate ran *only* on the push that publishes, so a test that
failed just on `ubuntu-latest` stayed invisible until it blocked a release, and
one did — 0.6.11 reached JSR only because a later PR happened to pass behind it.

The order, and why each step is where it is:

1. **Log the change in `CHANGELOG.md` under `[Unreleased]` as it lands**, not at
   release time — the entry is written while the reasoning is still to hand.
2. `deno task release patch|minor|major` — rewrites the three version sites and
   dates the heading. It stops there on purpose; the diff is worth a human's eyes
   before it becomes a release, because **JSR refuses to republish a version
   number, so a spent one is spent.**
3. Commit, push, and open a PR like any other change. The PR runs `deno task test`
   and `deno task typecheck` and does **not** reach the publish step, which is
   guarded on the event rather than the branch so `workflow_dispatch` keeps working.
4. Merge. The push to `main` re-runs both gates and then `npx jsr publish
   --no-check`. **A green merge is not a published release** — check
   `gh run list --workflow=publish.yml`. Publishing is a no-op when `deno.json`'s
   version is already on JSR, so pushing to `main` without a bump is safe and silent.
5. **Do not treat the first 24 hours as a failed publish.** Deno's minimum
   dependency age means `deno run -A jsr:@tuesdaycrowd/mcp-comfyui` still resolves
   to the *previous* version for a day, and naming the new one explicitly fails
   outright. `https://jsr.io/@tuesdaycrowd/mcp-comfyui/meta.json` is the authority;
   `--min-dep-age 0` verifies a release inside that window.

## Verified end to end

> **Addresses, hostnames and home paths below are redacted placeholders.**
> This file is public. A remote host appears as `198.51.100.10` (RFC 5737
> TEST-NET-2, reserved for documentation and routable nowhere) and as
> `rtx-video`; home directories appear as `~/`. Only the identifying values
> were substituted — every measured behaviour, byte count, error code and
> path *shape* is exactly as observed.
>
> **These entries are dated because they are measurements, not descriptions.**
> Do not edit an older one to match today's reality: that turns a measurement
> into a fiction, which is the same failure the redaction note above exists to
> prevent. The remote box was at port `8189` with `D:\ComfyUI\output` in early
> August 2026, and reports a different port and a different output directory now
> — recorded as a **new line** at the foot of the 2026-08-22 entry, not as an edit
> to the older ones. Add a new dated entry.


Against a live ComfyUI 0.29.0 through the compiled binary over stdio: `describe_workflow` returned bounds for all five slots of `workflow.smoke` with zero unresolved, and `run_workflow {1.width:128, 1.height:96} wait:true` produced a 128×96 PNG. `get_job` reported an earlier submit `completed` with its output. `applySlots` was separately verified to keep a 2^64−1 seed byte-exact.

**Multi-host, verified on 2026-08-07** through `dist/index.js` under `node` over real stdio, against a live ComfyUI **0.30.2** on a Windows RTX 4070 at `198.51.100.10:8189` while this machine's own ComfyUI was stopped:

- `comfy_status {host: "rtx-video"}` and the same call with the raw address `198.51.100.10:8189` both returned that instance, reporting `local: false`, `output_directory: "D:\\ComfyUI\\output"` and `--listen 198.51.100.10,127.0.0.1`.
- `comfy_status` with no `host` reported the default as down, in the same session — two hosts, two answers, one process.
- `describe_workflow {workflow: "default_image_gen", host: "rtx-video"}` returned all 13 slots with zero unresolved, and `4.ckpt_name`'s enum was `["ltx-2.3-22b-dev-fp8.safetensors"]` — **the checkpoints installed on the Windows box, not on this Mac**. That is the whole value of per-host node definitions, and the cache landed at `object_info-198.51.100.10-8189.json`.
- `list_workflows {host: "rtx-video"}` returned this machine's 27 local workflows tagged `local` and no remote ones, the remote being a fresh install with an empty `workflows` directory — which its userdata API reports as a 404, read here as an empty library rather than a fault.
- Two defects were found by this run and fixed: `UserdataError` reached the tool layer unclassified and was reported as `internal_error`; and a *mistyped workflow name* fell through to the default host's library, failed to reach it, and came back as `fetch failed` about `/api/userdata` instead of `workflow_not_found` with the 27 names that would have worked. A host consulted only as a fallback must not become the story; one the caller named still is.

A real run also confirmed three things previously known only from source: `converted` and `prompt_preview` **are** emitted and are absent from comfy-cli's published event enum; `prompt_preview` carries the whole graph (landmine #12); and `queued`/`executed` carry undeclared fields (`validation_warnings`, `nodes`, structured `outputs`) that `looseObject` preserves.

**Template creation against the real gallery, verified on 2026-08-08** through `dist/index.js` under `node` over real stdio (`scripts/smoke-templates.mjs`), with `MCP_COMFYUI_AUTO_LAUNCH=0` and `MCP_COMFYUI_CREATED_DIR` pointed at an isolated temp directory rather than the real default:

- `search_templates {type: "video", tag: "Image to Video", limit: 5}` matched 53 templates in the live gallery and returned the 5 requested.
- `create_workflow_from_template {template: "video_wan2_2_14B_i2v"}` fetched the real workflow and wrote 84289 bytes — a genuine frontend graph (`nodes`, `last_node_id: 164`, `last_link_id: 292`), matching the design doc's own capture of this same template.
- `describe_workflow` on the result was not exercised in that run: no instance was reachable on this machine, and `MCP_COMFYUI_AUTO_LAUNCH=0` meant the call never tried to start one. It failed with `object_info_unavailable` and the script exited 1 — the graceful-degradation path this script exists to prove, working as designed.

**The remaining step, closed on 2026-08-08** against the live Windows box at `198.51.100.10:8189` (ComfyUI **0.30.2**, registered as `rtx-video`), through `dist/index.js` under `node` over real stdio, with `MCP_COMFYUI_AUTO_LAUNCH=0` throughout and the **real** created-workflows directory rather than a temp one:

- `search_templates {type: "video", tag: "Image to Video", limit: 5}` matched 53 of 574 and returned 5, `truncated: true`.
- `create_workflow_from_template {template: "video_wan2_2_14B_i2v"}` wrote 84289 bytes to `~/.local/share/mcp-comfyui/workflows/`, and `list_workflows` then reported it `origin: "template"`, `format: "frontend"` — the created root is discovered, classified and tagged with no further argument.
- `describe_workflow {workflow: "video_wan2_2_14B_i2v", host: "rtx-video"}` returned **44 settable, 14 inert, 0 unresolved** — matching the design-phase measurement exactly, at a nesting depth where 55 of 58 addresses are inside a subgraph. The inert set is the same fourteen: `129/98.length` (fed by `ComfyMathExpression`), `129/94.fps` (`PrimitiveFloat`), and the twelve sampler/switch addresses.
- **The enums came from the Windows box, not this Mac.** `129/90.vae_name` offered `wan2.2_vae.safetensors`, `129/102.lora_name` offered `wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors`, and `97.image` listed that machine's own input directory. Zero unresolved means every node in a gallery template resolved against a host this server had never described before — which is the whole point of joining slots to per-host `/object_info`.

**Automatic artifact copying, verified on 2026-08-22** through `dist/index.js` under `node` over real stdio (`scripts/smoke-remote-artifacts.mjs`), against a live ComfyUI **0.33.3** on the Windows RTX 4070, reached over Tailscale at `198.51.100.10:8188`, with `MCP_COMFYUI_AUTO_LAUNCH=0` throughout:

- `run_workflow {workflow: "image_chroma1_radiance_text_to_image", host: "198.51.100.10:8188", wait: true}` — **passing no `fetch_outputs`** — completed in 31.3s and returned `outputs.fetched` naming `~/.cache/mcp-comfyui/fetched/<prompt_id>/Chroma-Radiance_00005_.png`, which really existed at 1,559,836 bytes and is a genuine 1024×1024 8-bit RGB PNG.
- **`local_paths` stayed `{}`**, correctly: the copy here is not the instance's own file, which is still on `D:\ComfyUI\output`.
- A second `get_job` on the same `prompt_id` left the file's mtime unchanged — the copy was reused, not refetched.
- **The per-`prompt_id` directory earned itself.** Two separate runs both produced `Chroma-Radiance_00005_.png`, byte-identical in size, because ComfyUI's counter restarts per output-node prefix. They sit in different directories rather than one overwriting the other.
- **The ceiling and its disclosure**, with `AUTO_FETCH_MAX_BYTES` temporarily lowered to 1 MiB and an isolated `MCP_COMFYUI_CACHE_DIR`: that same image came back in `outputs.not_fetched` as `1559836 bytes exceeds this call's 1048576-byte limit; pass fetch_outputs: true to copy it anyway`, with `fetch_problems: []` — and `fetch_outputs: true` then brought it across. The byte count is the remote's own `Content-Length` (ground truth #41), so the pre-check declines a large artifact without moving it.

Two things this run corrected. The registry's `rtx-video` entry pointed at port **8189**; the box now serves **8188**, and `comfy_status` reports `target.local` — on `target`, beside the address it describes, not at the top level. And `run_workflow {wait: true}` against a real render outlasts the **MCP client's own 60s default request timeout**, which is a property of the client rather than of this server: the run is not lost, it carries on and its artifacts are still fetched. A harness waiting on a real generation must raise that timeout.

**`run_sweep`, verified on 2026-08-22** through `dist/index.js` under `node` over real stdio (`scripts/smoke-sweep.mjs`), against the live ComfyUI **0.33.3** on the Windows RTX 4070, reached at `198.51.100.10:8188`, with `MCP_COMFYUI_AUTO_LAUNCH=0` throughout:

- `run_sweep {workflow: "image_chroma1_radiance_text_to_image", host: "198.51.100.10:8188", inputs: {"778.noise_seed": ["18446744073709551615", 12345, 67890]}}` returned `variant_count: 3` and three distinct `prompt_id`s, with `failed: []`. Three lists' worth of values in one list of three — **zipped, not crossed**.
- **The 2^64−1 seed reached the submitted graph byte-exact.** ComfyUI's own `/history/<prompt_id>` for variant 0 carries `"noise_seed": 18446744073709551615`, and the rounded `18446744073709552000` appears nowhere in it — checked by searching the raw response **text**, never `JSON.parse`, since parsing it in the checker would reintroduce the very rounding under test. This is the one thing no fixture can prove: every test in this repo fakes `comfy`, so the chain that carries those digits is stubbed out at its first link.
- All three completed in 160 s and produced three **different** images — `Chroma-Radiance_00006_.png`, `_00007_`, `_00008_` — from seeds `18446744073709551615`, `12345`, `67890`. One sweep, three renders, three seeds that are each what was asked for.
- `get_job` answered for all three `prompt_id`s **with no `host` argument**, each reporting `host_source: "ledger"`. A sweep of N is N ledger entries.

**This run found a defect the whole test suite could not.** `vary`'s `stale` key is emitted only when the CLI consulted a live `/object_info` and fell back to a cache; given `--input <cache>` it is **absent entirely**. That is the normal shape for every remote sweep — comfy-cli refuses a non-loopback `/object_info` fetch as potential SSRF, so `--input` is the only source that works there — and a schema requiring `stale` failed every remote sweep with a `contract_violation` while passing all 157 tests, because the fixture always emitted the key. Fixed, measured, and pinned by a test; ground truth #51.

**Documentation audit, 2026-08-27.** No ComfyUI was reachable — the local one was stopped and the remote sits behind a Tailscale that was down — so this verified the toolchain and the MCP surface rather than a render. Everything below was run, not read:

- **`deno task test`: 157 passed (737 steps), 0 failed, 34 s. `deno task typecheck`: zero errors.** The suite's own count is what CLAUDE.md claims elsewhere, so that number is current rather than inherited.
- **`deno task build` → `dist/index.js` (1,365,243 bytes, 249 modules) plus `dist/package.json` holding exactly `{"type":"module"}`**, and `node --no-experimental-detect-module -e "import('./dist/index.js')"` resolved. That is the Node 18/20 guarantee from the Toolchain section, exercised rather than assumed.
- **The tool surface, over real stdio, matches the README table in both configurations.** With `MCP_COMFYUI_ALLOW_LAUNCH=1` the server lists **13** tools; with it off, **12** — `launch_comfyui` is simply absent. And `describe_workflow`/`validate_workflow` really do flip `readOnlyHint` with `MCP_COMFYUI_AUTO_LAUNCH`: `true` with it off, `false` with it on. Since auto-launch is **on by default**, a default install answers `readOnlyHint: false` for both, which the README's table now marks rather than merely explaining two paragraphs later.
- **`bun dist/index.js` served the same 12 tools as `node`** (bun 1.3.14), so the Toolchain section's "Bun remains a supported runtime" is measured on this build, not carried forward.
- **The three version sites agree at 0.8.0** — `deno.json`, `SERVER_VERSION`, the CHANGELOG heading — and `https://jsr.io/@tuesdaycrowd/mcp-comfyui/meta.json` reports `latest: 0.8.0`. The minimum-dependency-age window recorded on 2026-08-26 has since passed, exactly as that entry predicted; nothing was broken then.
- **The template gallery has grown 578 → 603, and every structural claim built on it survived.** Re-running the full 2026-08-12 procedure — all 603 rows grouped by category, all 103 `Use Cases` templates re-fetched and their nodes re-matched — reproduced the video counts *exactly*, template names included. Recorded in ground truth #28–#29 as dated paragraphs beside the originals. The counts in the README were the stale part and are now dated.
- **`comfy validate`'s diagnostic vocabulary is still 13 on the installed build**, still disjoint from `error_codes.py`. Ground truth #27 asks to be re-counted and says what to change if the installed copy is ever upgraded; it has not been.

Three documentation defects came out of this and are fixed: `src/workflows/notes.ts` was missing from the Architecture map, `deno task release` was documented nowhere despite being the only correct way to bump a version, and `tests/fixtures/fake-comfy-dispatch` — a second fixture with its own seven-variable vocabulary — was unmentioned in the Testing section.

## Known gaps

- **A detection probe that times out reads as `running: false`**, so a ComfyUI wedged mid-sampling could pass the launch guard onto a different port. Deliberate: treating timeouts as "refuse" would block every launch behind a flaky probe.
- **The oversized-message failure is mitigated, not eliminated.** The stdin buffer is raised to a measured 16 MiB and a transport error now reaches stderr, but the SDK closes the connection on overflow and that is not recoverable from `src/` without reimplementing its buffered line reader.

**Fixed, recorded so it is not reintroduced:** the "unreproducible transient test failure" was a shared-temp-directory collision. `tmpdir()` is shared, Bun ran test files concurrently by default, and three files swept every `mcp-comfyui-apply-*` directory — deleting siblings' live fixtures, and failing `setSlots.test.ts`'s six emptiness assertions. It never reproduced in isolation because running one file removes the other party. All three now diff against a `beforeEach` snapshot. **Never broaden one of those sweeps back to the whole prefix** — even though `deno test` (this project's runner since the Bun migration) runs files sequentially unless `--parallel` is passed, which `deno task test` does not do, so the specific race is currently dormant rather than impossible.

## Artifact paths

`comfy run` reports artifacts as `/view?…` URLs, and **`MCP_COMFYUI_WORKSPACE` does not change that** — tested: `comfy --workspace <install> run … --wait --json` still returns URLs. `execution.py:352-371` emits a path only when the file sits under the *workspace's own* `output/` dir, and a Desktop instance writes to its own configured directory instead. Two genuinely different places; no workspace setting fixes it. Anything documenting otherwise is wrong.

`src/comfy/outputs.ts` resolves them instead, using the running instance's actual `outputDirectory` (which `detectInstance` parses from `system.argv`) — better than comfy-cli's workspace guess, because it uses the configuration of the instance that really ran the job. Wired in at the tool layer, since `run.ts`/`jobs.ts` have no instance.

The wire shape is `outputs: {files, urls, local_paths}`. Every artifact appears exactly once in `files` or `urls`; `local_paths` maps a URL to an absolute path **that existed when the answer was built**, and a missing key means there is no local path. Absence is structural, not inferred. Resolution requires the file to exist and refuses a `subfolder` that climbs out of its root — a fabricated path is worse than none.
