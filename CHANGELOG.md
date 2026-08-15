# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **`search_templates` said "occasionally wrong" about a field that is wrong for
  46% of a category.** A template's `output_type` is not merely *inherited from*
  its gallery category — measured against the live gallery, it **is** the
  category restated: grouping all 578 rows by `category_title` gives
  `output_type` cardinality exactly 1 in every category, with no
  counterexamples, and five of the eight categories collapse to `image`. So
  `type` is only meaningful for `video`, `audio` and `3d`. **47 of the 103 `Use
  Cases` templates produce video while typed `image`**, and `type: "video"`
  matches none of them — not degraded, structurally incapable. The old wording
  sent a caller to a filter that returns zero of what they asked for. The
  description now says the measured thing and names the video tag vocabulary,
  because `tag` is exact and case-insensitive with **no substring matching**
  (`--tag "Vid"` matches nothing) and one of the eight tags is `FLF2V` —
  first-last-frame-to-video, which carries no substring a caller would guess and
  which 11 `Use Cases` templates are unreachable without. Tags are the better
  signal but not a perfect one: they recover 43 of the 47 (91.5%), and they are
  wrong in both directions.

### Notes

- **The gallery measurements are in the ground-truth register now, as entries
  #28–#31.** Every template fact this project holds lived only in a plan
  document until now, which is how a second-hand "28 of 103" — a figure whose
  method was never recorded, and which is really 47 — survived four days of
  being cited. All four entries were re-run on implementation rather than
  transcribed, and the two that were pure source claims (`comfy nodes path` does
  not anchor on its source type; the four saved-workflow verbs take no
  `--host`/`--port`) are now recorded with line numbers for **both** the
  installed build and the checkout, which differ by 20–40 lines and would
  otherwise read as a rotten citation after an upgrade. Ground truth #27 gains
  the same treatment: its diagnostic vocabulary is 13 codes on the installed
  comfy-cli and 14 upstream, the addition being `no_options_available`, and all
  14 remain absent from `error_codes.py`.
- **Documentation accuracy sweep**, since the measurements above falsified
  claims elsewhere. The README now says to filter templates by `tag` rather than
  `type` and names the vocabulary, which is where a reader would otherwise hit
  the same trap the tool description used to set. `comfy/templates.ts` said the
  gallery held 574 entries in 199,382 bytes; it is 578 in 200,675, and the
  module now records *why* the coarse `output_type` is echoed rather than
  derived, so the next reader does not rediscover the two reasons and try to fix
  it. (`--limit 5` is still exactly 2,072 bytes — re-measured, unchanged across
  that growth, because the cap binds before the rows do.) Dated verification
  records that cite 574 were left alone: they say what was true when they were
  written, which is the whole point of a dated record.
- **`comfy validate`'s open-string enum earned its keep.** `validate.ts` warned
  that closing the code enum "would break this server on a release that adds a
  fourteenth". That release exists — comfy-cli `v1.15.0-1-g220f99a` emits 14,
  adding `no_options_available` — and this server needed no change to absorb it,
  because the enum was never closed. The comment and CLAUDE.md now record it as
  a measured fact rather than a hypothetical.
- No behaviour changed. One tool description, one register, a documentation
  sweep, and a superseded bullet annotated rather than edited in the 2026-08-07
  design document.

## [0.6.9] — 2026-08-09

### Added

- **`overwrite` on `create_workflow_from_template`.** Re-fetching a template the
  gallery has updated needed a new filename before this, which was the thing
  actually driving the created directory to accumulate files. Off by default: a
  workflow you fetched earlier may have been parameterised since.

### Fixed

- **The existence check is now atomic.** It was an `existsSync` separated from
  the write by an `await`, so two calls for the same name could both see nothing
  and both write. It is now a create-exclusive write, and the kernel decides.
  A failed fetch removes the placeholder rather than leaving a zero-byte file
  that `list_workflows` would report as an `invalid` workflow nobody created.

## [0.6.8] — 2026-08-09

### Added

- **`validate_workflow`** — would ComfyUI accept this graph, without submitting it?
  Answers in well under a second against the cached node definitions, so it
  normally works with ComfyUI stopped, and catches what would otherwise fail
  after the queue, the model load and part of a render. A workflow being invalid
  is a normal answer, not an error: `valid: false` arrives with the node, the
  field and, for a bad dropdown, the values that would have worked. `valid: true`
  is a **structural** guarantee — nodes exist, required inputs present, values in
  range, edges wired — not a semantic one.

### Notes

- `comfy validate` breaks the envelope contract every other command follows: an
  invalid workflow answers `ok:false` with `error:null` and a fully populated
  `data`, which this project's envelope decoder treats as a contract violation
  and throws on. Measured, and recorded as ground truth #27; `src/comfy/validate.ts`
  decodes the envelope itself for exactly this reason.

## [0.6.7] — 2026-08-09

### Fixed

- **`describe_workflow` now says what to set instead of a decoy.** It named the
  upstream node supplying the value but could offer a replacement address only 5
  times in 14 on a real gallery template; it is now 14 of 14. Two causes: the
  graph-only resolver reads a node's `inputs[]` array, where a widget appears
  only once it has been *converted* to an input — so an ordinary widget was
  invisible to it — and the rest needed a second hop through a switch bank fed by
  one boolean. Resolution now runs against the CLI's own slot listing, which is
  the vocabulary `set-slot` accepts, scoped so that two subgraphs each holding a
  node `162` stay distinct.

## [0.6.6] — 2026-08-09

### Fixed

- **Documentation accuracy pass.** `MCP_COMFYUI_CREATED_DIR` reached the tool
  descriptions in 0.6.5 but not the README configuration table, which is the
  canonical list of every setting this server has — it was the one variable in
  `config.ts` missing from it.
- **Ground truth #15 over-generalised, and CLAUDE.md repeated it.** Both said an
  input that is *link-fed* is inert. An input fed from a subgraph *boundary* is
  link-fed and is the only address that works; the real test is the link's
  origin, which `classifyInput` has always implemented. Stating it loosely is
  what produced the backwards diagnosis #26 records.

## [0.6.5] — 2026-08-08

### Added

- `search_templates` and `create_workflow_from_template`: find a workflow in
  comfy-cli's template gallery and materialise it locally. A fetched template is
  frontend format, so `describe_workflow` and `run_workflow` read it with no
  change to the pipeline — verified on 2026-08-08 against a live remote ComfyUI
  0.30.2, where `video_wan2_2_14B_i2v` described as 44 settable inputs, 14
  decoys correctly refused, and **zero unresolved**, with every enum drawn from
  that box's own models.
- `MCP_COMFYUI_CREATED_DIR`, appended **last** to the workflow roots so a fetched
  workflow can never shadow one you made. Entries under it list as
  `origin: "template"`.

### Notes

- Workflow *authoring* is deliberately not built. `comfy workflow compose` works,
  but emits API format, which `comfy workflow slots` hard-rejects and which no
  API→UI conversion anywhere in comfy-cli can undo — a composed workflow could be
  run and never described. `comfy nodes path` does not route. Both measured; see
  `docs/plans/2026-08-07-workflow-creation-design.md`.

### Fixed

- **`run_workflow` with `inputs` could not work against any remote host.**
  comfy-cli refuses to fetch `/object_info` from a non-loopback address in local
  mode — "potential SSRF" — so pointing `set-slot` at the live server, which is
  right for a local host, made every remote run with an override fail
  `cql_no_graph`. Remote targets now use this server's own per-host cache, and
  fill it first when it is cold. The fetch happens only when there is an
  override to apply: `applySlots` never spawns `comfy` for a defaults-only run,
  and fetching node definitions for one made the commonest remote call depend on
  an endpoint nothing downstream reads. The 2026-08-07 multi-host verification
  covered `comfy_status`, `describe_workflow` and `list_workflows` against a
  remote, but never a run with inputs, so this path had no coverage at all.
- **Every subgraph-interior address was reported `missing` after a run, even
  when its value had been applied correctly.** Subgraph interiors are renamed
  `outer:inner` with a colon during API conversion, while `comfy workflow slots`
  addresses them `outer/inner` with a slash, so the lookup that verifies a
  submitted value could never match. The address is now translated before the
  lookup. This was a false negative in the report only — the values themselves
  were reaching ComfyUI. Confirmed against a live remote: five overrides,
  including a subgraph-interior one, all read back `confirmed`.
- **The publish workflow type-checked with the wrong TypeScript.** `npx jsr
  publish` downloads its own Deno rather than the version `setup-deno` pins, so
  the publish step's type-check ran on whichever TypeScript that download
  carried — and Deno's bundled TypeScript has a known false-positive gap
  against this project's `@modelcontextprotocol/sdk` + zod 4 combination,
  reporting the SDK's own handler parameters as implicit `any`. 0.5.0 published
  cleanly and 0.6.0 failed with 21 of them, on the same class of code. The step
  now passes `--no-check`, which is the decision `deno task test` already makes
  for the same measured reason; `deno task typecheck` — `tsc` on this project's
  own TypeScript, zero errors — runs first in the same job and remains the
  authoritative gate.

## [0.6.0] — 2026-08-07

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
- **`package.json` is gone; `deno.json` is the only manifest.** Measurement
  found exactly two load-bearing things in it, and both have better homes.
  `typescript` and `@types/node` are now `npm:` entries in `deno.json`'s own
  `imports`, which `nodeModulesDir: "auto"` materialises for `tsc` — verified
  from a clean room with `node_modules` and `deno.lock` both deleted. And
  `scripts/build.mjs` now writes `dist/package.json` holding
  `{"type": "module"}`, which is strictly better than depending on a manifest
  two directories up that never shipped beside the artifact: Node decides
  whether a `.js` file is ESM from the *nearest* `package.json`, and without
  one `node dist/index.js` fails on **Node 18 and 20** with `Cannot use import
  statement outside a module` while working fine on 22.7+, which detect module
  syntax on their own. Everything else the file held — `bin`, `files`,
  `prepublishOnly`, `scripts`, and the npm-registry metadata — served a channel
  this project does not publish to, and its duplicate `version` field had
  already caused two silent desyncs.
  `package-lock.json` went with it — a lockfile for a manifest that no longer
  exists, still recording version `0.1.0` — and the publish workflow's `npm ci`
  step became `deno install`, which reads the same dependencies from
  `deno.json`. Left as it was, CI would have failed on the first push to `main`
  after this release.
- **The MCP SDK is mapped bare rather than by prefix.** The old
  `"@modelcontextprotocol/sdk/": "npm:…@1.30.0/"` only ever resolved because
  `package.json` listed the SDK and Deno went through `node_modules`; without
  it, subpath imports fail with "could not be URL-parsed relative to the URL
  prefix". A bare `"@modelcontextprotocol/sdk": "npm:…@1.30.0"` resolves them
  through the package's own `exports`.
- **The version this server reports to clients is the version it ships.**
  `SERVER_INFO.version` had said `0.1.0` since the beginning — through four
  releases — because nothing checked it. It now matches `deno.json`, and a test
  fails if the two ever disagree again. `deno bump-version` only knows about the
  manifest, so a release bumps both.
- **A missing Deno permission is no longer reported as a bug in this server.**
  A `NotCapable` error reached the tool layer unclassified and came back as
  `internal_error`, which says "this server has a bug" — false, and the wrong
  place to send anyone, since the runtime's own message already names the flag.
  It is now `permission_denied` and carries the full flag list. Deno only; Node
  and Bun have no permission system.
- **The README's own permission list was wrong**, and had been: it omitted
  `--allow-sys`. Measured — a server started with exactly the documented flags
  dies with `NotCapable` on the first call that looks for its configuration
  directory. It also still claimed concurrent launches "share a single launch
  … however many addresses are involved", which the code has not done for some
  time: the in-flight map is keyed by address, so two different addresses both
  proceed.
- **`deno task test:one <file>` runs a single test file.** A bare
  `deno test <file>`, which both the README and CLAUDE.md documented, type-checks
  by default and fails — Deno's bundled TypeScript is a full major behind this
  project's own, enough to reject `import.meta.dirname` and the MCP SDK's
  handler signatures. Verified against the released 0.5.0 too, so this is a
  documentation defect rather than a regression.
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
