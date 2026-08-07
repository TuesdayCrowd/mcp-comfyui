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
15. **`slots` lists inert addresses beside effective ones, indistinguishably.** An input that is **link-fed** rather than widget-backed is reported as a settable slot, but its value is resolved from upstream during API conversion, so anything written there is discarded. `set-slot` still reports it `applied`. Nothing anywhere signals the value was ignored.

    Measured on `audio_stable_audio_3_medium.json`. `52/6.text` (`CLIPTextEncode.text`) and `52/11.seconds` (`EmptyLatentAudio.seconds`) are link-fed and inert — setting them changed nothing, and the submitted graph carried `EmptyLatentAudio` with only `batch_size`. The **effective** controls are the upstream primitives that feed those links, and `slots` lists them too: `52/31.value` (`PrimitiveStringMultiline`), `52/36.value` (`PrimitiveFloat`), `52/3.seed` (`KSampler`).

    Setting the inert pair produced **150 seconds of tropical house** — the inner primitives' stock values — for a request of "black metal, 60 seconds". Setting the effective trio produced exactly 60.000s of the requested prompt, with `PrimitiveFloat {"value": 60}` and the seed visible in the submitted graph. **Subgraph workflows are fully usable; the hazard is address selection, not capability.** Prefer the address whose node actually holds the widget; treat any slot whose input carries a `link` and no `widget` marker as a decoy.

16. **Killing a child does NOT end a pipe read.** EOF requires every holder of the pipe's write end to close it, and spawning hands that write end to the child *and every descendant it starts*. Killing signals one pid, so a surviving grandchild pins the read open indefinitely — measured at 30s against an 800ms timeout. `comfy launch` exists precisely to leave such a descendant behind, so this is a live path, not a hypothetical.

    A timeout must therefore close **our own end of the pipe**, not merely signal the child. `src/comfy/exec.ts`'s `drain()` does this with `stream.destroy()`, which drops this process's read descriptor outright; the `orphan` fixture in `tests/exec.test.ts` pins it, asserting both that the call ends on time *and* that the descendant survives.

    Do **not** "fix" this with `detached` + a process-group kill: that would also kill the intentional long-lived ComfyUI a launch just started. Historical origin, for anyone reading old commits: this was found under Bun, where the equivalent was holding the reader and calling `reader.cancel()`, and where neither `Bun.spawn({timeout, killSignal})` nor `proc.stdout.cancel()` solved it — the latter throwing because `new Response(stream)` locks the stream. The underlying cause is POSIX file-descriptor inheritance and is not specific to any runtime.
17. **Pass `env` explicitly to every spawned child — do not rely on a runtime's default env-forwarding behaviour.** Historical origin: `Bun.spawn`, this project's spawn API before the Deno migration, did not give the child runtime mutations of `process.env`; it captured the environment as it stood at process start unless `env` was passed explicitly. Verified directly at the time: with `process.env.PROBE` set at runtime, the child saw `default=[]` but `explicit=[hello]` when spawned with `env: process.env`. This was not cosmetic — during Task 1.3 it caused a test fixture to be bypassed and the **real `comfy` binary to be invoked** by the suite. `node:child_process.spawn`, this project's spawn API now, already forwards live `process.env` by default (also verified directly), so that particular failure mode no longer reproduces — but every spawn in this project still passes `env: process.env` explicitly, on principle, so behaviour cannot regress if a runtime's default ever changes upstream.

---
