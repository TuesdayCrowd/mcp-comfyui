# mcp-comfyui

An MCP server that lets Claude find your ComfyUI workflows, learn what each one's inputs actually are, and run them.

It drives [comfy-cli](https://github.com/Comfy-Org/comfy-cli) rather than talking to ComfyUI directly. All graph work — UI→API conversion, subgraph expansion, reroute chains, bypass tracing, widget de-skewing — stays in `comfy`, which is tested upstream and already correct.

## What it adds

`comfy workflow slots` tells you a workflow has a `sampler_name` of type `COMBO` currently set to `euler`. It does not tell you the other 43 legal values, and it does not tell you `steps` must be between 1 and 10000. That information lives in ComfyUI's `/object_info`. Nothing upstream joins the two.

This server does. `describe_workflow` returns a real JSON Schema:

```json
"3.sampler_name": {
  "title": "KSampler.sampler_name",
  "enum": ["euler", "euler_ancestral", "heun", "dpmpp_2m", … 44 values],
  "default": "euler"
},
"3.steps": {
  "title": "KSampler.steps",
  "type": "integer", "minimum": 1, "maximum": 10000, "default": 20,
  "description": "The number of steps used in the denoising process."
}
```

That is the difference between a model guessing `Euler` and a model knowing the workflow.

## Requirements

- [Bun](https://bun.sh) 1.3+
- `comfy` on your PATH — `uv tool install comfy-cli` (do **not** use the Homebrew tap; it pins 0.0.29, which predates every command this server needs)
- A ComfyUI instance, running or launchable

## Install

```bash
bun install
bun run build          # -> dist/mcp-comfyui, a self-contained executable
claude mcp add comfyui /absolute/path/to/dist/mcp-comfyui
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `MCP_COMFYUI_WORKFLOW_DIRS` | `~/ComfyUI-Shared/user/default/workflows` | Colon-separated roots to scan, like `PATH` |
| `MCP_COMFYUI_ALLOW_LAUNCH` | unset | Set to `1` to expose the `launch_comfyui` tool |
| `COMFY_BIN` | `comfy` | Path to the `comfy` binary |

`launch_comfyui` is off by default on purpose. Starting a GPU process is not something a model should be able to do on inference alone.

## Tools

| Tool | Read-only | What it does |
|---|---|---|
| `comfy_status` | ✓ | Is ComfyUI reachable? Version, device, directories |
| `list_workflows` | ✓ | Every workflow found, classified by content |
| `describe_workflow` | ✓ | JSON Schema of that workflow's settable inputs |
| `run_workflow` | | Apply inputs and execute |
| `get_job` | ✓ | Poll a job by `prompt_id` |
| `cancel_job` | | Stop a running job |
| `launch_comfyui` | | Start ComfyUI — only when `MCP_COMFYUI_ALLOW_LAUNCH=1` |

The intended order is `list_workflows` → `describe_workflow` → `run_workflow`. Inputs are keyed by slot address (`3.seed`, `6.text`), which `describe_workflow` gives you.

## Design notes

Three decisions that are not obvious and are load-bearing.

**It never parses your workflow graph.** To apply inputs it byte-copies the file to a temp path and has `comfy` edit the copy in place. This is not stylistic. ComfyUI seeds go up to 2^64−1, and JavaScript rounds any integer above 2^53 — so parsing and re-serialising a graph silently corrupts seeds, including ones you never touched. Measured: setting `5.width` via `set-slot --stdout` turned an untouched seed of `18446744073709551615` into `18446744073709552000`. Python's integers are arbitrary-precision, so `comfy` is exact; the loss was entirely ours, and it disappears once our JS stops handling the graph.

The same problem recurs on the way back: `comfy run --json` echoes the whole graph as a `prompt_preview` event on every run. The server drops it during decode.

**It refuses to start a second ComfyUI.** If anything is already answering — on the detection target *or* on the address your startup arguments name — `launch_comfyui` returns `already_running` and spawns nothing. ComfyUI Desktop manages its own process and is not a comfy-cli workspace; a second instance would fight it for the port, for VRAM, and for the shared model directory.

**Every registry from the CLI is an open string.** Error codes, slot types, job statuses, run event types. Upstream documents its error codes as append-only, and its *published* schemas are already behind its own source — `comfy jobs`' status enum omits `cancelled`, which the CLI demonstrably emits, and the run-event enum omits `converted` and `prompt_preview`. A server that closes those enums breaks on the next release.

## Development

```bash
bun test                       # 371 tests
bun test tests/describe.test.ts
bun run typecheck
bun run build
```

Tests never contact a real ComfyUI and never invoke the real `comfy`. The CLI is faked by `tests/fixtures/fake-comfy`, a dependency-free POSIX `sh` script driven by `$FAKE_COMFY_MODE`; HTTP is faked with `Bun.serve({port: 0})`.

Fixtures under `tests/fixtures/` are real captures from a live ComfyUI 0.29.0, not hand-written approximations — including `slots.6key.json`, a 210-slot listing from a 122KB video workflow, and comfy-cli's own published JSON Schemas.

`tests/fixtures/workflow.smoke.json` is an `EmptyImage` → `SaveImage` graph that needs no checkpoint, for end-to-end verification on any install.

## Licence

Public domain — see [UNLICENSE](UNLICENSE).
