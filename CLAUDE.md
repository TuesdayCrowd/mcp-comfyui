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
```

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
  jobs.ts           jobs status | ls | cancel
  instance.ts       detection and guarded launch
  templates.ts      the gallery: search and fetch. No host — it is not a ComfyUI.
  validate.ts       comfy validate; decodes its own envelope (landmine #27)
src/workflows/
  discover.ts       find workflow files, classify by CONTENT not filename
  slots.ts          comfy workflow slots -> typed Slot[]
  describe.ts       slots × object_info -> JSON Schema   ← the value-add
  setSlots.ts       byte-copy (or byte-write) + set-slot in place
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

The same locality question decides artifact paths. `comfy/outputs.ts` resolves a `/view` URL against the output directory the running instance reported and then checks the file exists — **on this machine**. A remote Linux box with `/home/x/ComfyUI/output` would pass that check against a completely different image; the live Windows remote hid this by accident, since `F:\Dev\ComfyUI\output` is not `isAbsolute` under POSIX. `resolveArtifactPath` now refuses a non-local instance first, before any of the other checks.

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

Fixtures are real captures from a live ComfyUI 0.29.0 and 0.30.2, plus comfy-cli's own published JSON Schemas.

**Two hosts in one test are two ports on loopback.** `deno task test` grants `--allow-net=127.0.0.1,[::1],192.0.2.1`, so a second *address* is not available — except `192.0.2.1`, an RFC 5737 documentation address that is on no interface anywhere and answers nothing, which is exactly what a sleeping remote is and is the fixture the launch-refusal tests use. Its probe costs the 2-second budget; that is deliberate, and it buys the test that pins the defect this whole feature was designed around.

**The job ledger is module state and outlives a test.** `tests/server.test.ts` calls `clearJobLedger()` in `beforeEach` because every test there polls the same `PROMPT_ID` constant, and without it a later test inherits an earlier run's host and port. That is correct in production, where a `prompt_id` belongs to exactly one run. Tests also point `MCP_COMFYUI_HOSTS_FILE` inside their own temp directory, or they would read whichever real `~/.config/mcp-comfyui/hosts.json` the machine running the suite happens to have.

**Mutation testing is the standard here, not an extra.** Every module was developed against constructed mutants, and several real defects were found only that way — a suite can be thorough and still be unable to express the failure that matters. When you change behaviour, construct the mutant that would break it and confirm your test dies. Restore by checksum afterwards; an interrupted mutation run that leaves a mutant applied has happened.

Rule-shaped code (when to drop a constraint, which source wins) needs hand-built adversarial inputs. Real fixtures come from a healthy install and cannot reach the degenerate cases.

## Version control

GitButler. Use the `gitbutler` skill and `but commit`, never `git commit`.

**Pull requests are required.** Commit to a named virtual branch, `but push <branch>`, then open a PR (`but pr new`, or `gh pr create` — `gh` is authenticated with `repo` scope here even when GitButler's forge auth is not). Never commit to `main`, and **do not use `but land`**: it pushes straight to `origin/main`, skipping review and CI, and `but undo` cannot un-push it. This repo previously did land directly; that override was retired on 2026-08-07.

## Verified end to end

Against a live ComfyUI 0.29.0 through the compiled binary over stdio: `describe_workflow` returned bounds for all five slots of `workflow.smoke` with zero unresolved, and `run_workflow {1.width:128, 1.height:96} wait:true` produced a 128×96 PNG. `get_job` reported an earlier submit `completed` with its output. `applySlots` was separately verified to keep a 2^64−1 seed byte-exact.

**Multi-host, verified on 2026-08-07** through `dist/index.js` under `node` over real stdio, against a live ComfyUI **0.30.2** on a Windows RTX 4070 at `100.86.199.90:8189` while this machine's own ComfyUI was stopped:

- `comfy_status {host: "rtx-video"}` and the same call with the raw address `100.86.199.90:8189` both returned that instance, reporting `local: false`, `output_directory: "F:\\Dev\\ComfyUI\\output"` and `--listen 100.86.199.90,127.0.0.1`.
- `comfy_status` with no `host` reported the default as down, in the same session — two hosts, two answers, one process.
- `describe_workflow {workflow: "default_image_gen", host: "rtx-video"}` returned all 13 slots with zero unresolved, and `4.ckpt_name`'s enum was `["ltx-2.3-22b-dev-fp8.safetensors"]` — **the checkpoints installed on the Windows box, not on this Mac**. That is the whole value of per-host node definitions, and the cache landed at `object_info-100.86.199.90-8189.json`.
- `list_workflows {host: "rtx-video"}` returned this machine's 27 local workflows tagged `local` and no remote ones, the remote being a fresh install with an empty `workflows` directory — which its userdata API reports as a 404, read here as an empty library rather than a fault.
- Two defects were found by this run and fixed: `UserdataError` reached the tool layer unclassified and was reported as `internal_error`; and a *mistyped workflow name* fell through to the default host's library, failed to reach it, and came back as `fetch failed` about `/api/userdata` instead of `workflow_not_found` with the 27 names that would have worked. A host consulted only as a fallback must not become the story; one the caller named still is.

A real run also confirmed three things previously known only from source: `converted` and `prompt_preview` **are** emitted and are absent from comfy-cli's published event enum; `prompt_preview` carries the whole graph (landmine #12); and `queued`/`executed` carry undeclared fields (`validation_warnings`, `nodes`, structured `outputs`) that `looseObject` preserves.

**Template creation against the real gallery, verified on 2026-08-08** through `dist/index.js` under `node` over real stdio (`scripts/smoke-templates.mjs`), with `MCP_COMFYUI_AUTO_LAUNCH=0` and `MCP_COMFYUI_CREATED_DIR` pointed at an isolated temp directory rather than the real default:

- `search_templates {type: "video", tag: "Image to Video", limit: 5}` matched 53 templates in the live gallery and returned the 5 requested.
- `create_workflow_from_template {template: "video_wan2_2_14B_i2v"}` fetched the real workflow and wrote 84289 bytes — a genuine frontend graph (`nodes`, `last_node_id: 164`, `last_link_id: 292`), matching the design doc's own capture of this same template.
- `describe_workflow` on the result was not exercised in that run: no instance was reachable on this machine, and `MCP_COMFYUI_AUTO_LAUNCH=0` meant the call never tried to start one. It failed with `object_info_unavailable` and the script exited 1 — the graceful-degradation path this script exists to prove, working as designed.

**The remaining step, closed on 2026-08-08** against the live Windows box at `100.86.199.90:8189` (ComfyUI **0.30.2**, registered as `xinde-win-64`), through `dist/index.js` under `node` over real stdio, with `MCP_COMFYUI_AUTO_LAUNCH=0` throughout and the **real** created-workflows directory rather than a temp one:

- `search_templates {type: "video", tag: "Image to Video", limit: 5}` matched 53 of 574 and returned 5, `truncated: true`.
- `create_workflow_from_template {template: "video_wan2_2_14B_i2v"}` wrote 84289 bytes to `~/.local/share/mcp-comfyui/workflows/`, and `list_workflows` then reported it `origin: "template"`, `format: "frontend"` — the created root is discovered, classified and tagged with no further argument.
- `describe_workflow {workflow: "video_wan2_2_14B_i2v", host: "xinde-win-64"}` returned **44 settable, 14 inert, 0 unresolved** — matching the design-phase measurement exactly, at a nesting depth where 55 of 58 addresses are inside a subgraph. The inert set is the same fourteen: `129/98.length` (fed by `ComfyMathExpression`), `129/94.fps` (`PrimitiveFloat`), and the twelve sampler/switch addresses.
- **The enums came from the Windows box, not this Mac.** `129/90.vae_name` offered `wan2.2_vae.safetensors`, `129/102.lora_name` offered `wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors`, and `97.image` listed that machine's own input directory. Zero unresolved means every node in a gallery template resolved against a host this server had never described before — which is the whole point of joining slots to per-host `/object_info`.

**Automatic artifact copying, verified on 2026-08-22** through `dist/index.js` under `node` over real stdio (`scripts/smoke-remote-artifacts.mjs`), against a live ComfyUI **0.33.3** on the Windows RTX 4070, reached over Tailscale at `100.86.199.90:8188`, with `MCP_COMFYUI_AUTO_LAUNCH=0` throughout:

- `run_workflow {workflow: "image_chroma1_radiance_text_to_image", host: "100.86.199.90:8188", wait: true}` — **passing no `fetch_outputs`** — completed in 31.3s and returned `outputs.fetched` naming `~/.cache/mcp-comfyui/fetched/<prompt_id>/Chroma-Radiance_00005_.png`, which really existed at 1,559,836 bytes and is a genuine 1024×1024 8-bit RGB PNG.
- **`local_paths` stayed `{}`**, correctly: the copy here is not the instance's own file, which is still on `F:\Dev\ComfyUI\output`.
- A second `get_job` on the same `prompt_id` left the file's mtime unchanged — the copy was reused, not refetched.
- **The per-`prompt_id` directory earned itself.** Two separate runs both produced `Chroma-Radiance_00005_.png`, byte-identical in size, because ComfyUI's counter restarts per output-node prefix. They sit in different directories rather than one overwriting the other.
- **The ceiling and its disclosure**, with `AUTO_FETCH_MAX_BYTES` temporarily lowered to 1 MiB and an isolated `MCP_COMFYUI_CACHE_DIR`: that same image came back in `outputs.not_fetched` as `1559836 bytes exceeds this call's 1048576-byte limit; pass fetch_outputs: true to copy it anyway`, with `fetch_problems: []` — and `fetch_outputs: true` then brought it across. The byte count is the remote's own `Content-Length` (ground truth #41), so the pre-check declines a large artifact without moving it.

Two things this run corrected. The registry's `xinde-win-64` entry pointed at port **8189**; the box now serves **8188**, and `comfy_status` reports `target.local` — on `target`, beside the address it describes, not at the top level. And `run_workflow {wait: true}` against a real render outlasts the **MCP client's own 60s default request timeout**, which is a property of the client rather than of this server: the run is not lost, it carries on and its artifacts are still fetched. A harness waiting on a real generation must raise that timeout.

## Known gaps

- **A detection probe that times out reads as `running: false`**, so a ComfyUI wedged mid-sampling could pass the launch guard onto a different port. Deliberate: treating timeouts as "refuse" would block every launch behind a flaky probe.
- **The oversized-message failure is mitigated, not eliminated.** The stdin buffer is raised to a measured 16 MiB and a transport error now reaches stderr, but the SDK closes the connection on overflow and that is not recoverable from `src/` without reimplementing its buffered line reader.

**Fixed, recorded so it is not reintroduced:** the "unreproducible transient test failure" was a shared-temp-directory collision. `tmpdir()` is shared, Bun ran test files concurrently by default, and three files swept every `mcp-comfyui-apply-*` directory — deleting siblings' live fixtures, and failing `setSlots.test.ts`'s six emptiness assertions. It never reproduced in isolation because running one file removes the other party. All three now diff against a `beforeEach` snapshot. **Never broaden one of those sweeps back to the whole prefix** — even though `deno test` (this project's runner since the Bun migration) runs files sequentially unless `--parallel` is passed, which `deno task test` does not do, so the specific race is currently dormant rather than impossible.

## Artifact paths

`comfy run` reports artifacts as `/view?…` URLs, and **`MCP_COMFYUI_WORKSPACE` does not change that** — tested: `comfy --workspace <install> run … --wait --json` still returns URLs. `execution.py:352-371` emits a path only when the file sits under the *workspace's own* `output/` dir, and a Desktop instance writes to its own configured directory instead. Two genuinely different places; no workspace setting fixes it. Anything documenting otherwise is wrong.

`src/comfy/outputs.ts` resolves them instead, using the running instance's actual `outputDirectory` (which `detectInstance` parses from `system.argv`) — better than comfy-cli's workspace guess, because it uses the configuration of the instance that really ran the job. Wired in at the tool layer, since `run.ts`/`jobs.ts` have no instance.

The wire shape is `outputs: {files, urls, local_paths}`. Every artifact appears exactly once in `files` or `urls`; `local_paths` maps a URL to an absolute path **that existed when the answer was built**, and a missing key means there is no local path. Absence is structural, not inferred. Resolution requires the file to exist and refuses a `subfolder` that climbs out of its root — a fabricated path is worse than none.
