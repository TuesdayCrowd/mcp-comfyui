# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] — 2026-08-06

### Changed

- **Toolchain moved from Bun to Deno 2.** Deno runs the test suite and builds
  `dist/index.js` via `deno bundle`. What ships is unaffected: the artifact still
  targets Node (`engines.node >= 18`) and still spawns `comfy` through
  `node:child_process` rather than `Deno.Command`, which is exactly what keeps it
  runtime-agnostic. Bun remains a supported runtime — `bun dist/index.js` runs the
  server — it is simply no longer part of the build.
- **Distribution is JSR only, by decision.** npm publication is declined rather
  than pending. `package.json` is marked `private` and now exists only to pin
  devDependencies for `tsc` and to give Deno's `nodeModulesDir: "auto"` something
  to resolve `npm:` specifiers against; its `bin`/`files`/`prepublishOnly` fields
  are inert leftovers of a channel this project does not use.

### Fixed

- **Install instructions that did not work.** The README advertised
  `npx -y mcp-comfyui` and `bunx mcp-comfyui`. Neither resolves — the package has
  never been published to npm, so both return a registry 404. The documented path
  is now `deno run -A jsr:@tuesdaycrowd/mcp-comfyui`. Node and Bun install through
  JSR's npm-compatibility registry (`npx jsr add …`) and invoke the module by
  explicit path, because a JSR package declares no executable for that registry to
  translate into a command.

### Note

- 0.2.0 through 0.4.0 were never released. 0.1.0 is the only prior published
  version.

## [0.1.0] — 2026-08-05

Initial release.

### Added

- **MCP tool surface over stdio** — `comfy_status`, `list_workflows`,
  `describe_workflow`, `run_workflow`, `get_job` and `cancel_job`. A seventh tool,
  `launch_comfyui`, is registered only when the operator opts in: a model plans
  from the tool list, so a tool that is absent cannot be chosen, and starting a GPU
  process is not a decision to leave to inference.
- **Typed input schemas for arbitrary workflows.** `describe_workflow` joins a
  workflow's slots against the running instance's `/object_info` to emit JSON
  Schema carrying real bounds, enums and defaults. This is the server's reason to
  exist: `comfy workflow slots` alone reports bare `COMBO` types with no allowed
  values and no numeric ranges.
- **Workflow discovery by content rather than filename** — frontend and API graphs
  are told apart by inspecting their structure.
- **Job control** — `run_workflow` decodes the NDJSON event stream from
  `comfy run --json` line by line; `get_job` and `cancel_job` manage submitted
  prompts.
- **Artifact path resolution.** `comfy run` reports outputs as `/view?…` URLs.
  These are resolved against the running instance's own `outputDirectory`, which is
  more accurate than comfy-cli's workspace guess because it reflects the
  configuration of the instance that actually ran the job. A local path appears
  only when the file existed when the answer was built.
- **Guarded auto-launch.** ComfyUI starts on demand when nothing answers, probing
  both the detection target and the address the startup arguments name, so a second
  instance is never launched onto an address something already owns.
- **Decoy slot addresses excluded from generated schemas.** An input that is
  link-fed rather than widget-backed is listed by `comfy workflow slots` and
  reported `applied` by `set-slot`, but its value is resolved from upstream during
  conversion and silently discarded. Such addresses are now reported separately as
  `inert` instead of being offered as settable alongside the effective ones.
- **Precision-safe graph handling.** ComfyUI seeds reach 2^64−1 and JavaScript
  rounds above 2^53, so this server never parses or re-serialises a workflow graph:
  slot edits are applied by byte-copying the file and letting `comfy` edit the copy
  in place, and the whole-graph echo that `comfy run` emits as `prompt_preview` is
  dropped during decode rather than handed back to callers.
