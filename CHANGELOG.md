# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Several ComfyUI instances, chosen per call.** The server used to talk to one
  address, fixed when the process started; retargeting meant editing an MCP
  client's config block and restarting. Every tool now takes an optional `host`
  — a name from a registry, or a raw address such as `100.86.199.90:8189` —
  and omitting it uses the default, so every existing configuration and every
  existing call behaves exactly as it did. Two new tools: `list_hosts` reads
  the registry, `manage_hosts` writes it.
- **A host registry at `~/.config/mcp-comfyui/hosts.json`**, overridable with
  `MCP_COMFYUI_HOSTS_FILE`. It records each host's address, a note, and whether
  this server may start it. `MCP_COMFYUI_HOST`/`_PORT` still describe the
  default host and are the whole configuration when there is no file. Keys the
  server does not recognise survive every rewrite, on the same append-only
  reasoning that keeps the CLI's own registries open. A file that will not parse
  leaves the default host working — its address comes from the environment, not
  the file — and fails every *named* resolution loudly, because routing a video
  job to the laptop over a missing comma is worse than refusing.
- **A host's own saved workflows.** `list_workflows` with a `host` also lists
  what that ComfyUI has saved, over its userdata HTTP API, tagged
  `remote:<name>`. `describe_workflow` and `run_workflow` accept those handles:
  the file's exact bytes are fetched and handed to `comfy` unparsed, so a 2^64−1
  seed survives the trip for the same reason it survives the local byte-copy.
  Your local library still runs on any host, which remains the ordinary case.
- **`fetch_outputs`** on `run_workflow` and `get_job`, which copies a run's
  artifacts to this machine and reports where each landed. Off by default: a run
  here already has its files here, and a video workflow's outputs can be
  hundreds of megabytes to move. Artifacts stream to disk with a cap, and a
  filename that would escape the destination is refused rather than sanitised.
- **A host-qualified workflow handle routes itself.** `list_workflows` publishes
  a remote workflow as `rtx-video/portrait`, which reads as self-describing, so
  passing it alone reaches that host without repeating `host`. Only a prefix
  that is really a registered host counts — a local `templates/portrait`, which
  is how `workflows/discover.ts` disambiguates a colliding name, stays local.
  An explicit `host` still wins, which is what keeps `{workflow: "portrait",
  host: "rtx-video"}` meaning "run my local workflow there".

### Fixed

- **A remote instance's artifacts are no longer reported as files on this
  machine.** `local_paths` resolved a `/view` URL against the output directory
  the running instance reported, and then asked whether that path existed —
  *here*. Two Unix machines sharing a layout (`/home/me/ComfyUI/output` on both)
  would therefore have handed back a local path naming a completely different
  image. The live remote this was found against hid it by accident, being
  Windows: `F:\Dev\ComfyUI\output` is not an absolute path under POSIX, so the
  containment check declined it for the wrong reason. Resolution now requires
  the instance to be on this machine.
- **A host on another machine is never launched for.** Auto-launch aimed at a
  remote that is not answering now reports it. This completes the locality gate
  below: that one refused a launch once the address was known, and this stops
  the attempt being made at all, with a message that does not offer
  `MCP_COMFYUI_AUTO_LAUNCH=1` as a fix for something that setting cannot fix.
- **`deno task compile` and `deno task test` now grant `--allow-sys=homedir`.**
  Pre-existing, and unrelated to multi-host except that the registry surfaced
  it: `comfy/objectInfo.ts` has called `homedir()` for its default cache
  directory since long before this, so a self-compiled binary run without
  `MCP_COMFYUI_CACHE_DIR` would have thrown `NotCapable` on its first
  `describe_workflow`.

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
