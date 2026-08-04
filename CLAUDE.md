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
src/config.ts       workflow roots
src/server.ts       MCP tool registration (stdio)
```

Dependency direction is one-way: `workflows/` may import `comfy/`, never the reverse.

## Non-negotiables

These are not style preferences. Each was measured, and each has a test pinning it.

**1. Never let JS parse or re-serialise a workflow graph.** ComfyUI seeds reach 2^64−1; JavaScript rounds above 2^53. Measured: `set-slot --stdout` on a graph holding `18446744073709551615` returned the exact digits, and our `JSON.parse` corrupted that *untouched* seed to `18446744073709552000`. Hence the byte-copy in `setSlots.ts` and the graph-dropping in `run.ts` (`comfy run --json` echoes the whole graph as a `prompt_preview` event on every run). **Assume this recurs anywhere a comfy payload can contain a graph.**

**2. Every registry from the CLI is an open string** — `error.code`, slot `type`, job `status`, run `event.type`. Upstream documents error codes as append-only, and its published schemas are already behind its own source. Closing an enum breaks the server on the next CLI release. Tests assert the published enums are incomplete, so the argument stays checkable.

**3. Branch on the envelope, never on the exit code.** Exit 1 covers missing file, downed server, HTTP error, conversion failure, validation failure, and execution error alike.

**4. Global flags precede the subcommand.** `--skip-prompt`, `--json` and the workspace flags are Typer *root* options. `comfy jobs ls --json` fails; `comfy --json jobs ls` works.

**5. stdout is the MCP protocol.** Nothing may `console.log`. Diagnostics go to stderr.

**6. Never launch a second ComfyUI.** Detect first, on both the detection target and the address the startup args name.

The full list of 14 verified landmines — each with the measurement behind it — is in [`docs/comfy-cli-ground-truth.md`](docs/comfy-cli-ground-truth.md). **Read it before changing anything that touches the CLI.** Several were found only after the bug they caused; none is inferred.

## Testing

Tests never contact a real ComfyUI and never invoke the real `comfy`. The CLI is faked by `tests/fixtures/fake-comfy` (dependency-free POSIX `sh`, driven by `$FAKE_COMFY_MODE`, argv captured to `$FAKE_COMFY_ARGV_OUT`); HTTP is faked with `Bun.serve({port: 0})`. Fixture modes are append-only — never change an existing one.

Fixtures are real captures from a live ComfyUI 0.29.0, plus comfy-cli's own published JSON Schemas.

**Mutation testing is the standard here, not an extra.** Every module was developed against constructed mutants, and several real defects were found only that way — a suite can be thorough and still be unable to express the failure that matters. When you change behaviour, construct the mutant that would break it and confirm your test dies. Restore by checksum afterwards; an interrupted mutation run that leaves a mutant applied has happened.

Rule-shaped code (when to drop a constraint, which source wins) needs hand-built adversarial inputs. Real fixtures come from a healthy install and cannot reach the degenerate cases.

## Version control

GitButler. Use the `gitbutler` skill and `but commit`, never `git commit`.

**Project override:** this repo lands virtual branches directly onto `main` with `but land <branch>` instead of opening pull requests. Work is still committed to a named virtual branch first — land the branch, don't commit to `main` directly. Landing pushes to `origin/main` immediately and `but undo` cannot un-push it.

## Known gaps

- **No real end-to-end run has been executed.** `applySlots` was verified against the real CLI (a 2^64−1 seed survives byte-exact), but `runWorkflow` and the job wrappers are tested only against the fake. `tests/fixtures/workflow.smoke.json` needs no checkpoint and exists to close this — run it against a live instance.
- **A detection probe that times out reads as `running: false`**, so a ComfyUI wedged mid-sampling could pass the launch guard onto a different port. Deliberate: treating timeouts as "refuse" would block every launch behind a flaky probe.
- **One unreproduced transient test failure** was observed once at verified-pristine checksums and has not recurred across many runs.
