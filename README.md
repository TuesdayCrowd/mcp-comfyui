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

- [Node.js](https://nodejs.org) 18 or later — verified working on 18, 20, 22, 24 and 26. Bun and Deno run it too (`bunx mcp-comfyui`, `deno run -A npm:mcp-comfyui`), since the server uses only `node:` builtins.
- `comfy` on your PATH — `uv tool install comfy-cli` (do **not** use the Homebrew tap; it pins 0.0.29, which predates every command this server needs)
- A ComfyUI instance, running or launchable

## Install

```bash
claude mcp add comfyui -- npx -y mcp-comfyui
```

That's it — `npx` fetches and runs the package, no separate build step. Verify Claude can see it:

```bash
claude mcp list
```

### From source

Building from a checkout instead (e.g. to test a change) still needs [Bun](https://bun.sh) 1.3+ to run the test suite and the bundler, but the artifact it produces (`dist/index.js`) is a plain Node script — Bun is a build-time tool here, not a runtime dependency of what ships:

```bash
bun install
bun run build           # -> dist/index.js, runnable under plain `node`
claude mcp add comfyui /absolute/path/to/dist/index.js
```

A `bun run compile` script is also available if a self-contained platform binary (no `node` on PATH required) is preferable to the npm path for a given deployment; it produces `dist/mcp-comfyui`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `MCP_COMFYUI_WORKFLOW_DIRS` | `~/ComfyUI-Shared/user/default/workflows` | Colon-separated roots to scan, like `PATH` |
| `MCP_COMFYUI_AUTO_LAUNCH` | **on** | May the server start ComfyUI when a tool needs one and nothing answers? |
| `MCP_COMFYUI_ALLOW_LAUNCH` | off | May a *model* start one, with startup flags of its own? Registers `launch_comfyui` |
| `MCP_COMFYUI_WORKSPACE` | unset | ComfyUI directory to launch from |
| `MCP_COMFYUI_HOST` / `_PORT` | `127.0.0.1` / `8188` | Where ComfyUI is |
| `MCP_COMFYUI_CACHE_DIR` | `~/.cache/mcp-comfyui` | `/object_info` cache |
| `COMFY_BIN` | `comfy` | Path to the `comfy` binary |

Booleans accept `1/true/yes/on` and `0/false/no/off`; anything else is refused at startup rather than read as off.

The two launch switches answer different questions and are deliberately separate. `AUTO_LAUNCH` governs launches **the server decides to make** on your behalf. `ALLOW_LAUNCH` governs whether **a model may ask for one** with `--cpu`, `--listen` and a free-form argument list — strictly more powerful, so it stays opt-in.

### Set `MCP_COMFYUI_WORKSPACE` if you don't already use comfy-cli

Auto-launch runs `comfy launch`, which needs a comfy-cli *workspace*. ComfyUI Desktop is not one. If comfy-cli has never been configured it resolves to `~/Documents/comfy/ComfyUI`, which usually doesn't exist, and you'll get an error naming this variable:

```bash
MCP_COMFYUI_WORKSPACE=/path/to/ComfyUI     # the directory containing main.py
```

There is deliberately no auto-discovery. Picking between several installs by name is exactly how you end up launching the wrong ComfyUI against the right models.

This setting affects **launching only**. It does not change how artifacts are reported — see below.

## Where your images are

`comfy run` reports artifacts as `/view?…` URLs, never filesystem paths, unless the file happens to sit under a resolvable comfy-cli workspace's own `output/` directory — which it does not on a Desktop install. So the server resolves them itself, using the output directory the running instance actually reported:

```json
"outputs": {
  "files": [],
  "urls":  ["http://127.0.0.1:8188/view?filename=out_00001_.png&subfolder=&type=output"],
  "local_paths": {
    "http://127.0.0.1:8188/view?filename=out_00001_.png&subfolder=&type=output":
      "/Users/you/ComfyUI-Shared/output/out_00001_.png"
  }
}
```

Every artifact appears exactly once in `files` or `urls`. For a URL, look it up in `local_paths`: the value is an absolute path to a file that existed when the answer was built, and **no key means there is no local path** — fetch the URL instead. The path is never guessed; the file must exist and must lie inside its output root.

## Tools

| Tool | Read-only | What it does |
|---|---|---|
| `comfy_status` | ✓ | Is ComfyUI reachable? Version, device, directories |
| `list_workflows` | ✓ | Every workflow found, classified by content |
| `describe_workflow` | ✓ | JSON Schema of that workflow's settable inputs |
| `run_workflow` | | Apply inputs and execute |
| `get_job` | ✓ | Poll a job by `prompt_id` |
| `cancel_job` | | Stop a running job |
| `launch_comfyui` | | Start ComfyUI with explicit flags — only when `MCP_COMFYUI_ALLOW_LAUNCH=1` |

The intended order is `list_workflows` → `describe_workflow` → `run_workflow`. Inputs are keyed by slot address (`3.seed`, `6.text`), which `describe_workflow` gives you.

`describe_workflow` is read-only only when auto-launch is off — with it on, the tool may start ComfyUI if it has no cached `/object_info`, and `readOnlyHint` has to say so. `comfy_status` never launches under any setting; it's the tool you call to ask whether anything is running.

## Design notes

Three decisions that are not obvious and are load-bearing.

**It never parses your workflow graph.** To apply inputs it byte-copies the file to a temp path and has `comfy` edit the copy in place. This is not stylistic. ComfyUI seeds go up to 2^64−1, and JavaScript rounds any integer above 2^53 — so parsing and re-serialising a graph silently corrupts seeds, including ones you never touched. Measured: setting `5.width` via `set-slot --stdout` turned an untouched seed of `18446744073709551615` into `18446744073709552000`. Python's integers are arbitrary-precision, so `comfy` is exact; the loss was entirely ours, and it disappears once our JS stops handling the graph.

The same problem recurs on the way back: `comfy run --json` echoes the whole graph as a `prompt_preview` event on every run. The server drops it during decode.

**It starts ComfyUI when one is needed, and never starts a second.** A tool that needs a live server detects first; if nothing answers it launches one, and if anything is already answering — on the detection target *or* on the address the startup arguments name — it uses that instead. Concurrent calls arriving while ComfyUI is down share a single launch, because what a second launch collides with is the machine's accelerator and its shared model directory, and those are singular however many addresses are involved.

**Every registry from the CLI is an open string.** Error codes, slot types, job statuses, run event types. Upstream documents its error codes as append-only, and its *published* schemas are already behind its own source — `comfy jobs`' status enum omits `cancelled`, which the CLI demonstrably emits, and the run-event enum omits `converted` and `prompt_preview`. A server that closes those enums breaks on the next release.

## Development

```bash
bun test                       # full suite
bun test tests/describe.test.ts
bun run typecheck
bun run build
```

Tests never contact a real ComfyUI and never invoke the real `comfy`. The CLI is faked by `tests/fixtures/fake-comfy`, a dependency-free POSIX `sh` script driven by `$FAKE_COMFY_MODE`; HTTP is faked with `Bun.serve({port: 0})`.

Fixtures under `tests/fixtures/` are real captures from a live ComfyUI 0.29.0, not hand-written approximations — including `slots.6key.json`, a 210-slot listing from a 122KB video workflow, and comfy-cli's own published JSON Schemas.

`tests/fixtures/workflow.smoke.json` is an `EmptyImage` → `SaveImage` graph that needs no checkpoint, for end-to-end verification on any install.

## Licence

Public domain — see [UNLICENSE](UNLICENSE).
