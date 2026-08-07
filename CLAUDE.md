# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An MCP server that exposes ComfyUI workflows to MCP clients, driving [comfy-cli](https://github.com/Comfy-Org/comfy-cli) rather than ComfyUI's HTTP API directly. See `README.md` for the user-facing picture.

## Commands

```bash
deno task test                        # full suite
deno test tests/describe.test.ts      # one file
deno task typecheck                   # tsc --noEmit, via node — see "Toolchain" below
deno task build                       # -> dist/index.js, runnable under plain `node`
deno task compile                     # -> dist/mcp-comfyui (self-contained binary, optional)
```

**No per-test `--filter` for a file that uses `beforeEach`/`afterEach`/`beforeAll`.** Every test in this project's `tests/support/testing.ts` shim is registered through `@std/testing/bdd`'s `it` (aliased `test`); a file with hooks becomes one wrapping `Deno.test` named `"global"` with each `test()` as a *step*, and `deno test --filter` matches only top-level test names — it cannot reach into steps. `deno test --filter "…" tests/exec.test.ts` therefore runs either the whole file or nothing, never a single case inside it. The file itself is the practical unit (`deno test tests/foo.test.ts`); to isolate one test inside a hooked file, add `test.only(...)` at that call site temporarily (bdd's `it.only`, re-exported through the same shim) and remove it before committing. Files with no hooks at all (`target.test.ts`, `envelope.test.ts`, `index.test.ts`, `describe.test.ts`) register as ordinary top-level tests, and `--filter` reaches them by name.

There is no lint step and no formatter config; match the surrounding style.

## Toolchain

Deno 2 runs the test suite and builds `dist/index.js` (via `deno bundle`). That artifact targets **Node** (`engines.node >= 18`) and backs the from-source install and `deno task compile`; Deno never appears at runtime. `src/comfy/exec.ts` deliberately still spawns `comfy` through `node:child_process`, not `Deno.Command`, because that is what keeps `dist/index.js` runtime-agnostic; do not "modernize" it to a Deno-only API. Bun is not part of the toolchain, but it remains a supported *runtime*: `bun dist/index.js` runs the server, and nothing here should say otherwise.

**Distribution is JSR only. This is a decision, not a gap — do not "fix" it by publishing to npm.**

| Channel | State |
|---|---|
| JSR `@tuesdaycrowd/mcp-comfyui` | published — `deno run -A jsr:@tuesdaycrowd/mcp-comfyui` |
| npm `mcp-comfyui` | **not published, and will not be** (registry returns 404) |

So `npx -y mcp-comfyui` and `bunx mcp-comfyui` do not resolve and never will. Do not write them into a doc, a README, or an install instruction. `deno.json` is the manifest that ships; `package.json` survives only to pin devDependencies for `tsc` and to give Deno's `nodeModulesDir: "auto"` something to resolve `npm:` specifiers against — its `bin`/`files`/`prepublishOnly` fields are inert leftovers of the npm channel, not an intent to use it.

Node and Bun are still supported, via JSR's npm-compat mirror: `npx jsr add @tuesdaycrowd/mcp-comfyui` installs `@jsr/tuesdaycrowd__mcp-comfyui`, which carries `bin: null` — `deno.json` has no `bin` field to translate — so it provides no command and must be run by explicit path (`node node_modules/@tuesdaycrowd/mcp-comfyui/src/index.js`, verified under both node and bun). That indirection is permanent; treat it as the Node/Bun story rather than a workaround awaiting a fix.

`deno.json`'s own type-check (`deno check` / `deno test`'s default checking) has a known false-positive gap against this project's `@modelcontextprotocol/sdk` + zod 4 combination — Deno 2.9.4 bundles TypeScript 6.0.3, and this project's own `typescript` devDependency is a full major ahead. `deno task test` therefore runs with `--no-check`; the authoritative compile gate for what ships is `deno task typecheck`, which is `tsc --noEmit` under `node`, using this project's own pinned TypeScript, and passes with zero errors. Re-run it (not `deno check`) before trusting a "compiles" claim about `src/`.

## Architecture

A thin orchestrator. **The server never parses or rewrites a workflow graph.** It shells out to `comfy` and parses that CLI's stable `envelope/1` JSON contract.

```
src/comfy/          the CLI and instance layer
  envelope.ts       decodes envelope/1; the single decode point
  exec.ts           the ONLY place this project spawns a process
  target.ts         host/port resolution, shared so it cannot diverge
  objectInfo.ts     /object_info fetch + disk cache (also feeds --input)
  outputs.ts        artifact path-vs-URL rule, shared by run and jobs
  jobs.ts           jobs status | ls | cancel
  instance.ts       detection and guarded launch
src/workflows/
  discover.ts       find workflow files, classify by CONTENT not filename
  slots.ts          comfy workflow slots -> typed Slot[]
  describe.ts       slots × object_info -> JSON Schema   ← the value-add
  setSlots.ts       byte-copy + set-slot in place
  run.ts            comfy run --json, NDJSON decoded line by line
src/config.ts       workflow roots and env-var vocabulary
src/index.ts        stdio entrypoint — the ONLY place that touches stdio
src/server.ts       assembles the McpServer; delegates registration to tools.ts
src/tools.ts        the MCP surface: every tool's schema, description, annotations
src/toolResult.ts   throw -> classified tool result; the error-mapping table
```

Dependency direction is one-way: `workflows/` may import `comfy/`, never the reverse.

## Non-negotiables

These are not style preferences. Each was measured, and each has a test pinning it.

**1. Never let JS parse or re-serialise a workflow graph.** ComfyUI seeds reach 2^64−1; JavaScript rounds above 2^53. Measured: `set-slot --stdout` on a graph holding `18446744073709551615` returned the exact digits, and our `JSON.parse` corrupted that *untouched* seed to `18446744073709552000`. Hence the byte-copy in `setSlots.ts` and the graph-dropping in `run.ts` (`comfy run --json` echoes the whole graph as a `prompt_preview` event on every run). **Assume this recurs anywhere a comfy payload can contain a graph.**

**2. Every registry from the CLI is an open string** — `error.code`, slot `type`, job `status`, run `event.type`. Upstream documents error codes as append-only, and its published schemas are already behind its own source. Closing an enum breaks the server on the next CLI release. Tests assert the published enums are incomplete, so the argument stays checkable.

**3. Branch on the envelope, never on the exit code.** Exit 1 covers missing file, downed server, HTTP error, conversion failure, validation failure, and execution error alike.

**4. Global flags precede the subcommand.** `--skip-prompt`, `--json` and the workspace flags are Typer *root* options. `comfy jobs ls --json` fails; `comfy --json jobs ls` works.

**5. stdout is the MCP protocol.** Nothing may `console.log`. Diagnostics go to stderr.

**6. Never launch a second ComfyUI, and never launch for another machine.** Detect first, on both the detection target and the address the startup args name. Auto-launch is on by default, so this fires from ordinary tool handlers — hence the in-flight launch map in `instance.ts`, keyed by resolved `host:port` **per address, not globally**: two launches for the same address are one piece of work and collapse, while two for different addresses are both legitimate and must both proceed. `comfy_status` never launches. A tool that may launch cannot be annotated `readOnlyHint: true`.

`launchInstance` also refuses any target that is not an address on this machine (`refuseRemoteTarget`, using `target.ts`'s `isLocalAddress`). `comfy launch` has no `--host`: it starts a process wherever `comfy` runs. Before that gate existed, aiming the server at a sleeping remote started a ComfyUI *here*, polled the remote for the full five-minute readiness budget, reported a timeout, and left the local process orphaned — `--background` had already detached it. The check fails closed: any host but `localhost` that is not literally an address on a local interface is refused rather than resolved through DNS, because a wrong refusal prints an explanation and a wrong acceptance recreates the orphan.

The full list of verified landmines — each with the measurement behind it — is in [`docs/comfy-cli-ground-truth.md`](docs/comfy-cli-ground-truth.md). **Read it before changing anything that touches the CLI.** Several were found only after the bug they caused; none is inferred.

**Some slot addresses are decoys** (ground truth #15). An input that is link-fed rather than widget-backed is listed by `slots` and reported `applied` by `set-slot`, but its value is resolved from upstream during conversion and silently discarded. Setting the inert pair on `audio_stable_audio_3_medium.json` produced 150s of tropical house for a request of "black metal, 60s"; setting the upstream primitives that feed those links produced exactly 60.000s of the requested prompt. Subgraph workflows are fully usable — the hazard is picking the wrong address, so the server must mark the inert ones rather than offering both alike.

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

Fixtures are real captures from a live ComfyUI 0.29.0, plus comfy-cli's own published JSON Schemas.

**Mutation testing is the standard here, not an extra.** Every module was developed against constructed mutants, and several real defects were found only that way — a suite can be thorough and still be unable to express the failure that matters. When you change behaviour, construct the mutant that would break it and confirm your test dies. Restore by checksum afterwards; an interrupted mutation run that leaves a mutant applied has happened.

Rule-shaped code (when to drop a constraint, which source wins) needs hand-built adversarial inputs. Real fixtures come from a healthy install and cannot reach the degenerate cases.

## Version control

GitButler. Use the `gitbutler` skill and `but commit`, never `git commit`.

**Project override:** this repo lands virtual branches directly onto `main` with `but land <branch>` instead of opening pull requests. Work is still committed to a named virtual branch first — land the branch, don't commit to `main` directly. Landing pushes to `origin/main` immediately and `but undo` cannot un-push it.

## Verified end to end

Against a live ComfyUI 0.29.0 through the compiled binary over stdio: `describe_workflow` returned bounds for all five slots of `workflow.smoke` with zero unresolved, and `run_workflow {1.width:128, 1.height:96} wait:true` produced a 128×96 PNG. `get_job` reported an earlier submit `completed` with its output. `applySlots` was separately verified to keep a 2^64−1 seed byte-exact.

A real run also confirmed three things previously known only from source: `converted` and `prompt_preview` **are** emitted and are absent from comfy-cli's published event enum; `prompt_preview` carries the whole graph (landmine #12); and `queued`/`executed` carry undeclared fields (`validation_warnings`, `nodes`, structured `outputs`) that `looseObject` preserves.

## Known gaps

- **A detection probe that times out reads as `running: false`**, so a ComfyUI wedged mid-sampling could pass the launch guard onto a different port. Deliberate: treating timeouts as "refuse" would block every launch behind a flaky probe.
- **The oversized-message failure is mitigated, not eliminated.** The stdin buffer is raised to a measured 16 MiB and a transport error now reaches stderr, but the SDK closes the connection on overflow and that is not recoverable from `src/` without reimplementing its buffered line reader.

**Fixed, recorded so it is not reintroduced:** the "unreproducible transient test failure" was a shared-temp-directory collision. `tmpdir()` is shared, Bun ran test files concurrently by default, and three files swept every `mcp-comfyui-apply-*` directory — deleting siblings' live fixtures, and failing `setSlots.test.ts`'s six emptiness assertions. It never reproduced in isolation because running one file removes the other party. All three now diff against a `beforeEach` snapshot. **Never broaden one of those sweeps back to the whole prefix** — even though `deno test` (this project's runner since the Bun migration) runs files sequentially unless `--parallel` is passed, which `deno task test` does not do, so the specific race is currently dormant rather than impossible.

## Artifact paths

`comfy run` reports artifacts as `/view?…` URLs, and **`MCP_COMFYUI_WORKSPACE` does not change that** — tested: `comfy --workspace <install> run … --wait --json` still returns URLs. `execution.py:352-371` emits a path only when the file sits under the *workspace's own* `output/` dir, and a Desktop instance writes to its own configured directory instead. Two genuinely different places; no workspace setting fixes it. Anything documenting otherwise is wrong.

`src/comfy/outputs.ts` resolves them instead, using the running instance's actual `outputDirectory` (which `detectInstance` parses from `system.argv`) — better than comfy-cli's workspace guess, because it uses the configuration of the instance that really ran the job. Wired in at the tool layer, since `run.ts`/`jobs.ts` have no instance.

The wire shape is `outputs: {files, urls, local_paths}`. Every artifact appears exactly once in `files` or `urls`; `local_paths` maps a URL to an absolute path **that existed when the answer was built**, and a missing key means there is no local path. Absence is structural, not inferred. Resolution requires the file to exist and refuses a `subfolder` that climbs out of its root — a fabricated path is worse than none.
