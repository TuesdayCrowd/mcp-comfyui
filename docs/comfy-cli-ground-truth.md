# comfy-cli ground truth

> Extracted from the implementation plan when that plan was retired. Every claim
> below was executed and measured against a live ComfyUI Desktop 0.29.0 and the
> comfy-cli source, not inferred. Several were discovered only after a bug they
> caused. **Read this before changing anything that touches the CLI.**


Everything below was executed against a live ComfyUI Desktop (v0.29.0, `127.0.0.1:8188`) on 2026-08-02. Do not re-derive; do not assume anything not listed here.

**Environment**
- `comfy` installed via `uv tool install --python 3.13 --from <local comfy-cli tree> comfy-cli` → `~/.local/bin/comfy` (already on fish PATH via `config.fish:78`).
- Local comfy-cli tree is `v1.13.0-59-g95d7897`, newer than PyPI 1.13.0. It reports `"version": "0.0.0"` in envelopes because the tree leaves version stamping to CI. **Do not version-gate on this field.**
- Workflow files: `/Users/lawls/ComfyUI-Shared/user/default/workflows` (22 files, all UI/frontend format).
- ComfyUI Desktop owns the running process. It is **not** a comfy-cli workspace.

**The envelope contract** — every `comfy` command in JSON mode emits:
```json
{"schema":"envelope/1","type":"envelope","ok":true,"command":"...","version":"...",
 "where":null,"data":{...},"error":null}
```
On failure `ok:false` and `error:{code,message,hint,details}`.

**Commands this server depends on** (all verified working):

| Command | Returns |
|---|---|
| `comfy --skip-prompt workflow slots <file> --host H --port P` | `data.slots[]` — `{address,name,type,current_value,instance_id,node_type}` |
| `comfy --skip-prompt workflow set-slot <copy> ADDR=VAL... --in-place --host H --port P` | edits the file; `data.applied`, `data.warnings`, `data.wrote`. **Use in-place on a temp copy — see landmines #11/#12; `--stdout` corrupts the graph.** |
| `comfy --skip-prompt run --workflow <file> --wait --json` | NDJSON `event/1` lines, then final `envelope/1` |
| `comfy --skip-prompt discover` | Full CLI surface, schemas, error-code registry (~221KB) |
| `comfy --skip-prompt launch -- <comfyui args>` | Starts ComfyUI with passthrough startup args |

**Landmines — every one of these was verified and will silently break naive code:**

1. **`--set` cannot be combined with `--workflow`.** `cmdline.py:945` rejects it: *"--prompt/--set apply to the bundled default workflow and cannot be combined with --workflow"*. Parameterizing a workflow file is **always** two steps: `set-slot` then `run`.
2. **Piped stdout auto-selects JSON mode.** From `set-slot --help`: *"Redirecting stdout selects JSON mode."* An MCP server always pipes, so JSON is implied — but **always pass the mode flag explicitly** so behavior never depends on TTY detection.
3. **Global flags must precede the subcommand.** `--skip-prompt`, `--json-stream`, `--workspace`, `--here`, `--recent` live on the Typer root. `comfy workflow slots --skip-prompt` fails; `comfy --skip-prompt workflow slots` works.
4. **Exit code 1 is overloaded.** Missing file, bad JSON, server down, HTTP 4xx/5xx, conversion failure, validation failure, execution error — all exit 1. **Branch on `error.code` from the envelope, never on exit code.** Exit 130 = cancelled.
5. **Error codes are append-only.** Treat unknown codes as forward-compat (pass through the message), never as a parse failure.
6. **`slots` returns bare `COMBO` with no allowed values** and no min/max on numerics. Constraints come only from `/object_info`. This join is the server's core job.
7. **`--input <object_info.json>` makes `slots`/`set-slot` work offline.** Cache `/object_info` and workflow introspection no longer needs a live server.
8. **Never `comfy launch` onto an address something is already answering on.** Desktop owns 8188; a second instance there fights over VRAM and the shared model dir. Launching onto a *different, free* port is permitted by deliberate decision — the contention is real, so the caller is warned rather than blocked.
9. **`comfy launch --background` readiness is a log scrape** for the literal string `"To see the GUI go to:"`. Fragile — prefer polling `/system_stats`.
10. **`comfy launch --background` CRASHES rather than reporting a bad workspace.** With an unresolvable workspace it exits 1, writes **zero bytes to stdout**, and dumps an uncaught `FileNotFoundError` traceback to stderr — it does *not* emit the `not_in_workspace` envelope that JSON mode implies. Measured:
   ```
   $ comfy --skip-prompt --json launch --background -- --port 8189
   exit 1 | stdout: 0 bytes
   stderr: Traceback … FileNotFoundError: [Errno 2] No such file or directory:
           '/Users/lawls/Documents/comfy/ComfyUI'
   ```
   So a failed launch arrives as "no usable envelope", not a classified verdict. **Anything waiting for readiness must treat a non-zero exit with no envelope as terminal**, or it waits out the whole budget for a child that died in under a second.
11. **comfy-cli's own `server_already_running` is global, not per-port.** It fires from `ConfigManager().background` — comfy-cli's single-slot record of a background process *it* started — checked before the target port is even parsed (`launch.py:270`). `port_in_use` (`launch.py:321`) *is* per-port, probing `/history` on the resolved port. Consequence: an instance started by ComfyUI Desktop is invisible to `server_already_running`, but once *this server* has launched one via comfy-cli, a second launch on any other port is refused until `comfy stop` clears the slot.
12. **Host `0.0.0.0` must be rewritten to `127.0.0.1`** before use as a connect address.
13. **A ComfyUI seed cannot round-trip through JSON as an f64.** `KSampler.seed` declares `max: 18446744073709552000` — which is itself already the lossy f64 rendering of 2^64−1. Anything that reaches us via `JSON.parse` (every envelope, every slot listing) has already lost precision above 2^53. The fix is architectural and is specified in Task 3.1: **never let our JS parse or re-serialise the graph.** Copy the workflow file and let `comfy` edit the copy in place. Measured proof that the alternative fails: `set-slot 5.width=512 --stdout` on a file holding seed `18446744073709551615` returns the exact digits in the envelope, and our `JSON.parse` corrupts that untouched seed to `18446744073709552000`. Scanned all 22 of this user's workflows losslessly: zero true integer literals above 2^53 today, so this is latent rather than active — but it is silent when it fires.
14. **`comfy run --json` emits the ENTIRE workflow graph back at you, on every run.** `run/__init__.py:259` calls `renderer.event("prompt_preview", prompt=workflow)` unconditionally in stream mode — not only under `--print-prompt`. So the graph re-enters our JS through `JSON.parse` even though Task 3.1 was architected to keep it out, and every integer above 2^53 in it is rounded (measured: `18446744073709551615` → `18446744073709552000`). The submitted graph and the images are unaffected — comfy did the submit — but the **report** is wrong, and the reproduce-a-render loop reads its seed from exactly that report. Never hand a parsed `prompt` back to a caller; drop it during decode, or carry the raw line text so no JS number touches it. **This is landmine #11 recurring in a sibling module: assume it will recur again anywhere a comfy payload can contain a graph.**
15. **`slots` lists inert addresses beside effective ones, indistinguishably.** An input fed by a link **from another node in the same scope** is reported as a settable slot, but its value is resolved from that upstream node during API conversion, so anything written there is discarded. `set-slot` still reports it `applied`. Nothing anywhere signals the value was ignored.

    **"Link-fed" alone is not the test — the link's ORIGIN is.** An input fed from the subgraph *boundary* sentinel (`origin_id` < 0) is also link-fed and is **not** inert: it is the only address that works. See #26, which was found by getting this exactly backwards. `classifyInput` in `src/workflows/discover.ts` draws that distinction, and it is the whole rule.

    Measured on `audio_stable_audio_3_medium.json`. `52/6.text` (`CLIPTextEncode.text`) and `52/11.seconds` (`EmptyLatentAudio.seconds`) are link-fed and inert — setting them changed nothing, and the submitted graph carried `EmptyLatentAudio` with only `batch_size`. The **effective** controls are the upstream primitives that feed those links, and `slots` lists them too: `52/31.value` (`PrimitiveStringMultiline`), `52/36.value` (`PrimitiveFloat`), `52/3.seed` (`KSampler`).

    Setting the inert pair produced **150 seconds of tropical house** — the inner primitives' stock values — for a request of "black metal, 60 seconds". Setting the effective trio produced exactly 60.000s of the requested prompt, with `PrimitiveFloat {"value": 60}` and the seed visible in the submitted graph. **Subgraph workflows are fully usable; the hazard is address selection, not capability.** Prefer the address whose node actually holds the widget; treat any slot whose input carries a `link` and no `widget` marker as a decoy.

16. **Killing a child does NOT end a pipe read.** EOF requires every holder of the pipe's write end to close it, and spawning hands that write end to the child *and every descendant it starts*. Killing signals one pid, so a surviving grandchild pins the read open indefinitely — measured at 30s against an 800ms timeout. `comfy launch` exists precisely to leave such a descendant behind, so this is a live path, not a hypothetical.

    A timeout must therefore close **our own end of the pipe**, not merely signal the child. `src/comfy/exec.ts`'s `drain()` does this with `stream.destroy()`, which drops this process's read descriptor outright; the `orphan` fixture in `tests/exec.test.ts` pins it, asserting both that the call ends on time *and* that the descendant survives.

    Do **not** "fix" this with `detached` + a process-group kill: that would also kill the intentional long-lived ComfyUI a launch just started. Historical origin, for anyone reading old commits: this was found under Bun, where the equivalent was holding the reader and calling `reader.cancel()`, and where neither `Bun.spawn({timeout, killSignal})` nor `proc.stdout.cancel()` solved it — the latter throwing because `new Response(stream)` locks the stream. The underlying cause is POSIX file-descriptor inheritance and is not specific to any runtime.
17. **Pass `env` explicitly to every spawned child — do not rely on a runtime's default env-forwarding behaviour.** Historical origin: `Bun.spawn`, this project's spawn API before the Deno migration, did not give the child runtime mutations of `process.env`; it captured the environment as it stood at process start unless `env` was passed explicitly. Verified directly at the time: with `process.env.PROBE` set at runtime, the child saw `default=[]` but `explicit=[hello]` when spawned with `env: process.env`. This was not cosmetic — during Task 1.3 it caused a test fixture to be bypassed and the **real `comfy` binary to be invoked** by the suite. `node:child_process.spawn`, this project's spawn API now, already forwards live `process.env` by default (also verified directly), so that particular failure mode no longer reproduces — but every spawn in this project still passes `env: process.env` explicitly, on principle, so behaviour cannot regress if a runtime's default ever changes upstream.
18. **`--host`/`--port` follow the subcommand, where `--json` and `--workspace` precede it.** Verified against the installed CLI: `comfy workflow slots --help`, `comfy workflow set-slot --help`, `comfy run --help` and `comfy jobs ls|status|cancel --help` all list `--host`/`--port` as *subcommand* options, while `--json`, `--skip-prompt` and `--workspace` are Typer **root** options (landmine #3). So both orderings now appear in one argv, and a test that asserts a flag is merely *present* is not asserting the thing that breaks: `comfy --json jobs ls --host H --port P` works, `comfy jobs ls --json` does not.

    Measured live: `comfy --json jobs ls --host 100.86.199.90 --port 8189 --limit 3` returned three jobs from a remote box, and the same command against a black-holed address hung until `timeout 15` killed it — proving the flag drives a real outbound call rather than being ignored.

19. **`comfy launch` accepts no `--host` and no `--port`.** It starts a process on whichever machine runs `comfy`. Launching a remote ComfyUI is not a comfy-cli capability, so any code that "handles" a remote launch is handling something that cannot happen — see landmine #21 for what attempting it actually costs.

20. **comfy-cli does not attribute a job to a host.** A job record carries `[outputs, prompt_id, queue_position, status, updated_at, where, workflow_path, workflow_size]`. The `host` and `port` in the envelope's `data` echo the flag passed on the command line: with no flag `jobs ls` reports `127.0.0.1:8188`; with `--host 100.86.199.90` it reports that instead, over the **same 39 records**.

    Worse, asking the wrong host about a real job is not a recognisable error. Measured: `comfy --json jobs status 25e9540a-… --host 100.86.199.90 --port 8189` returned `prompt_not_found`, confidently — for a job that exists, that this server submitted to local `8188`. That is byte-identical to the answer for an id that never existed, so **a guess about which host a job is on produces a confidently wrong answer, not a detectable one.** Hence `src/jobLedger.ts`.

    `jobs cancel` fails differently again: it short-circuits on comfy-cli's own *local* records and returns `no local job with id '…'`, where `jobs status` returns `No prompt with id '…' on 100.86.199.90:8189`. Two different failures; a caller must not merge them.

21. **Pointing this server at a sleeping remote used to start a ComfyUI here.** Not a comfy-cli fact but the consequence of #19, recorded because the cost is not obvious: the launch path probed the remote, spawned `comfy launch` **locally and unconditionally**, polled the remote address for the full five-minute readiness budget, threw a timeout — and left the local process running, because `--background` had already detached it. Nothing owned the question *is this address mine to launch?* It is now asked twice: `launchInstance` refuses a non-local target, and `tools.ts` never reaches it for a remote host at all.

22. **ComfyUI's userdata API, from `app/user_manager.py` (0.30.2) and confirmed live.** This is how a remote instance's own saved workflows are reachable; `comfy` cannot enumerate another machine's.

    - `GET /api/userdata?dir=<d>&recurse=true&full_info=true` → a JSON array of `{path, size, modified, created}`. `path` is relative to the user's data root and **always `/`-separated**, because the handler does `os.path.relpath(...).replace(os.sep, '/')` — so a *Windows* host still reports `workflows/a.json`. Measured against the live Windows remote: `dir=.` returned `[{"path": "comfy.settings.json", "size": 126, "modified": 1786069244638, "created": 1786064269557}]`. A `dir` that is not there is a **404**, which for `workflows` means a fresh install rather than a fault. A missing `dir` is a 400.
    - `GET /api/userdata/{file}` is **one aiohttp path segment**, so a nested path must be percent-encoded — and the handler calls `unquote` only when the name contains a `%` (`user_manager.py:94-96`), so encoding is required rather than merely tolerated.
    - That route answers with `web.FileResponse`: the file's **raw bytes**, `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, content type from `mimetypes` (downgraded to `application/octet-stream` for anything `is_dangerous_content_type` flags). Measured: the 126-byte settings file arrived as exactly 126 bytes with four Windows `\r\n` sequences and its original indentation intact. **A workflow can therefore be fetched byte-exactly, so landmine #13's 2^64−1 seed survives the transfer** — provided nothing on this side parses it.
    - A missing file is a bare 404 with an empty body.
    - The v2 listing is `/api/v2/userdata?path=…`, **not** `/api/userdata/v2`, which 404s. This project uses v1 with `full_info=true`: it carries size and mtime in one call and is present in every build seen.

23. **A remote instance's `outputDirectory` is a path in *its* filesystem.** Measured: the live remote reports `F:\Dev\ComfyUI\output` and `--listen 100.86.199.90,127.0.0.1` (a comma-separated list — a shape `--listen` really does carry). Resolving a `/view` URL against that directory and then asking whether the file exists **here** is a category error that a Windows path only hides by accident, since it is not `isAbsolute` under POSIX. Two Unix machines sharing a layout would produce a local path naming a different image entirely. Locality must be decided on the address, not on whether the path happens to resolve.

---

*Measured 2026-08-08, against comfy-cli `v1.13.0-59-g95d7897` and a live ComfyUI **0.30.2** at `100.86.199.90:8189`.*

24. **The CLI refuses to fetch `/object_info` from a non-loopback address in local mode.** Measured, running a workflow with inputs against a remote host:

    ```
    cql_no_graph: Refusing to fetch object_info from non-loopback host
    '100.86.199.90' in local mode (potential SSRF). Use --where cloud for remote targets.
    ```

    So any command that needs node definitions for a remote — `workflow slots`, `set-slot` — must be given `--input <cached object_info>`; there is no address it will fetch from. `describe_workflow` was unaffected only because it already passed `--input`. The run path did not, and `run_workflow` with `inputs` was broken against every remote host until this was found. **The cache is the only schema source that works off-box.**

25. **A subgraph's interior nodes are renamed `outer:inner` — with a COLON — during API conversion, while `workflow slots` addresses them `outer/inner` with a SLASH.** `workflow_to_api.py:369` does `expanded["id"] = f"{outer_id}:{inner.get('id')}"`, and `run/__init__.py:213,259` echoes exactly that object as `prompt_preview`. So a caller's address `129/93.text` and the submitted graph's key `129:93` never match, and any code comparing one against the other reports **every** subgraph-interior address as absent, unconditionally — a false negative that looks exactly like a value that failed to apply. This server's `run.ts` had that bug: it reported `status: "missing"` for an address whose value had in fact been applied correctly. Chained nesting keeps chaining colons, so translation is `replaceAll("/", ":")`, not a single split.

26. **`set-slot` cannot address a subgraph instance's own widget, and says so identically for a real widget name and for garbage.** On a ComfyUI 0.30.2 workflow, `set-slot '129.text=…'` fails:

    ```
    workflow_slot_invalid: no proxyWidget mapping for 129.text; address an
    interior input directly, e.g. 129/<innerId>.<input>
    ```

    `129.unet_name`, `129.value` and the invented `129.not_a_thing` all return the byte-identical shape, so "rejected" carries no information about whether the name was real. Cause: `cql/engine.py:1710,1874` read only `instance.properties.proxyWidgets`, the **older** subgraph scheme; 0.30.2 puts the curated parameter list on the subgraph *definition* as `sg["inputs"][].linkIds`, which comfy-cli never reads. The in-source comment anticipates a *stale* `proxyWidgets`, not an *absent* one — this reads as an unhandled schema version rather than a decision.

    **The interior address is the effective one**, and the instance's own widget value is dead. Proven by a three-way `convert_ui_to_api` comparison: pristine → default text; `set-slot 129/93.text=MARKER` → `MARKER` survives conversion; mutating node 129's own `widgets_values[0]` → converted output **unchanged**. `_rewrite_internal_input` severs an interior link whose origin is the boundary sentinel `-10` and never re-attaches the outer node's widget in its place. So a boundary-fed interior input is **not** a decoy — treating it as one would refuse the only address that works.

27. **`comfy validate` breaks the envelope contract: an invalid workflow is `ok:false` with `error:null` and a fully populated `data`.** Every other command in this CLI answers `ok:false` with an `error` object, and `src/comfy/envelope.ts` treats the combination of `ok:false` and no error as a contract violation — correctly, for all of them. Measured 2026-08-09 on a graph with a bad enum and an out-of-range integer:

    ```
    exit 1 | ok:false | error:null
    data: {"valid":false,"error_count":2,"warning_count":19,"errors":[…],"warnings":[…]}
    ```

    Verified through this project's own code: `runComfy(["--json","validate",…])` on that file threw `EnvelopeParseError`, so the ordinary question "is this workflow valid?" came back as "this server and the CLI disagree about the shape of an answer". Anything wrapping `validate` must therefore use `runComfyRaw` and decode the envelope itself, treating `ok:false` **with** an error as a failure and `ok:false` **without** one as a negative answer. `src/comfy/validate.ts` does exactly that.

    Two further shapes worth knowing before designing around this command. **A workflow that validates clean still carries warnings** — `video_wan2_2_14B_i2v` reports 19, nearly all `edge_type_mismatch` from one `ComfySwitchNode` whose output type ComfyUI's catalogue cannot express — so warnings are noise to be capped, not a signal to surface whole. And **`valid: true` is structural, not semantic**: it means every node exists, every required input is present, every value is in range and every edge is wired. It does not mean the graph does what was asked. Landmine #15 is the standing proof of that difference.
