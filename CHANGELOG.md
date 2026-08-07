# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **ComfyUI is never launched for an address that is not this machine.** The
  launch path made one refusal check — is the target address already occupied —
  and then spawned `comfy launch` locally and unconditionally. Nothing asked whose
  address the target was. Pointing the server at a remote instance that was not
  answering therefore probed the remote, started a ComfyUI *here* on the default
  port, polled the remote address until the five-minute readiness budget expired,
  reported a timeout, and left the local process running, because `--background`
  had already detached it. `launchInstance` now refuses any target that is not an
  address on this machine, before anything is probed or spawned. The check reads
  the target out of the assembled arguments, so a `--listen` naming another
  machine is refused too, not only an explicitly configured host. It fails closed:
  any name but `localhost` that is not literally an address on a local interface
  is refused rather than resolved through DNS, because a wrong refusal explains
  itself while a wrong acceptance recreates the orphaned process. `comfy launch`
  accepts no `--host` and no `--port` — it starts a process wherever `comfy` runs
  — so launching a remote instance was never possible, only expensive to discover.

### Changed

- **`deno task test` and `deno task compile` now grant
  `--allow-sys=networkInterfaces`.** The locality check above reads this machine's
  interface list, which Deno gates behind `--allow-sys`. Anyone compiling their own
  binary needs this flag; without it the first gated launch throws `NotCapable`.
  Node and Bun have no permission system and are unaffected, as is
  `deno run -A jsr:@tuesdaycrowd/mcp-comfyui`.

### Note

- Multi-host support — reaching several ComfyUI instances chosen per call, rather
  than one fixed at startup — is designed and agreed but **not implemented**. See
  `docs/plans/2026-08-06-multi-host-design.md`. The launch fix above was pulled out
  of that work and shipped on its own, because the defect is reachable today by
  setting `MCP_COMFYUI_HOST` to a remote address.

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
