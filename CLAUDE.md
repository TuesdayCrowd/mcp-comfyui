# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An MCP server that exposes ComfyUI workflows to MCP clients, driving [comfy-cli](https://github.com/Comfy-Org/comfy-cli) rather than ComfyUI's HTTP API directly. See `README.md` for the user-facing picture.

## Commands

```bash
bun test                          # full suite
bun test tests/describe.test.ts   # one file
bun test --test-name-pattern "…"  # one test by name
bun run typecheck                 # tsc --noEmit
bun run build                     # -> dist/mcp-comfyui (self-contained executable)
```

There is no lint step and no formatter config; match the surrounding style.

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

**6. Never launch a second ComfyUI.** Detect first, on both the detection target and the address the startup args name. Auto-launch is on by default, so this fires from ordinary tool handlers — hence the single global in-flight launch in `instance.ts`, deliberately *not* keyed by address. `comfy_status` never launches. A tool that may launch cannot be annotated `readOnlyHint: true`.

The full list of verified landmines — each with the measurement behind it — is in [`docs/comfy-cli-ground-truth.md`](docs/comfy-cli-ground-truth.md). **Read it before changing anything that touches the CLI.** Several were found only after the bug they caused; none is inferred.

**Subgraph workflows are not usable through comfy-cli** (ground truth #15). `convert_ui_to_api` drops the subgraph's input widget values and submits the inner nodes' stale ones, so `describe_workflow` will offer addresses that are inert and `run_workflow` will report success on a graph nobody configured. Until that is fixed upstream, treat a workflow containing `definitions.subgraphs` as unsupported rather than silently mis-running it.

## Testing

Tests never contact a real ComfyUI and never invoke the real `comfy`. The CLI is faked by `tests/fixtures/fake-comfy` (dependency-free POSIX `sh`, driven by `$FAKE_COMFY_MODE`, argv captured to `$FAKE_COMFY_ARGV_OUT`); HTTP is faked with `Bun.serve({port: 0})`. Fixture modes are append-only — never change an existing one.

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

**Fixed, recorded so it is not reintroduced:** the "unreproducible transient test failure" was a shared-temp-directory collision. `tmpdir()` is shared, bun runs test files concurrently, and three files swept every `mcp-comfyui-apply-*` directory — deleting siblings' live fixtures, and failing `setSlots.test.ts`'s six emptiness assertions. It never reproduced in isolation because running one file removes the other party. All three now diff against a `beforeEach` snapshot. **Never broaden one of those sweeps back to the whole prefix.**

## Artifact paths

`comfy run` reports artifacts as `/view?…` URLs, and **`MCP_COMFYUI_WORKSPACE` does not change that** — tested: `comfy --workspace <install> run … --wait --json` still returns URLs. `execution.py:352-371` emits a path only when the file sits under the *workspace's own* `output/` dir, and a Desktop instance writes to its own configured directory instead. Two genuinely different places; no workspace setting fixes it. Anything documenting otherwise is wrong.

`src/comfy/outputs.ts` resolves them instead, using the running instance's actual `outputDirectory` (which `detectInstance` parses from `system.argv`) — better than comfy-cli's workspace guess, because it uses the configuration of the instance that really ran the job. Wired in at the tool layer, since `run.ts`/`jobs.ts` have no instance.

The wire shape is `outputs: {files, urls, local_paths}`. Every artifact appears exactly once in `files` or `urls`; `local_paths` maps a URL to an absolute path **that existed when the answer was built**, and a missing key means there is no local path. Absence is structural, not inferred. Resolution requires the file to exist and refuses a `subfolder` that climbs out of its root — a fabricated path is worse than none.
