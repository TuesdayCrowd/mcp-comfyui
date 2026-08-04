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
8. **Never `comfy launch` when something is already reachable.** Desktop owns port 8188; a second instance fights over VRAM and the shared model dir.
9. **`comfy launch --background` readiness is a log scrape** for the literal string `"To see the GUI go to:"`. Fragile — prefer polling `/system_stats`.
10. **Host `0.0.0.0` must be rewritten to `127.0.0.1`** before use as a connect address.
11. **A ComfyUI seed cannot round-trip through JSON as an f64.** `KSampler.seed` declares `max: 18446744073709552000` — which is itself already the lossy f64 rendering of 2^64−1. Anything that reaches us via `JSON.parse` (every envelope, every slot listing) has already lost precision above 2^53. The fix is architectural and is specified in Task 3.1: **never let our JS parse or re-serialise the graph.** Copy the workflow file and let `comfy` edit the copy in place. Measured proof that the alternative fails: `set-slot 5.width=512 --stdout` on a file holding seed `18446744073709551615` returns the exact digits in the envelope, and our `JSON.parse` corrupts that untouched seed to `18446744073709552000`. Scanned all 22 of this user's workflows losslessly: zero true integer literals above 2^53 today, so this is latent rather than active — but it is silent when it fires.
12. **`comfy run --json` emits the ENTIRE workflow graph back at you, on every run.** `run/__init__.py:259` calls `renderer.event("prompt_preview", prompt=workflow)` unconditionally in stream mode — not only under `--print-prompt`. So the graph re-enters our JS through `JSON.parse` even though Task 3.1 was architected to keep it out, and every integer above 2^53 in it is rounded (measured: `18446744073709551615` → `18446744073709552000`). The submitted graph and the images are unaffected — comfy did the submit — but the **report** is wrong, and the reproduce-a-render loop reads its seed from exactly that report. Never hand a parsed `prompt` back to a caller; drop it during decode, or carry the raw line text so no JS number touches it. **This is landmine #11 recurring in a sibling module: assume it will recur again anywhere a comfy payload can contain a graph.**
13. **Killing a child does NOT end a pipe read.** EOF requires every holder of the pipe's write end to close it, and `Bun.spawn` hands that write end to the child *and every descendant*. `proc.kill()` signals one pid, so a surviving grandchild pins the read open indefinitely — measured at 30s against an 800ms timeout. A timeout must cancel the **read side** (hold the reader, call `reader.cancel()`), not merely signal the child. `Bun.spawn({timeout, killSignal})` does not fix this, and `proc.stdout.cancel()` throws because `new Response(stream)` locks the stream. Do **not** fix it with `detached` + process-group kill: that would also kill the intentional long-lived server in Task 4.2.
14. **`Bun.spawn` does not give the child runtime mutations of `process.env`.** It hands over the environment as captured at process start unless `env` is passed explicitly. Verified directly: with `process.env.PROBE` set at runtime, the child sees `default=[]` but `explicit=[hello]` when spawned with `env: process.env`. This is not cosmetic — during Task 1.3 it caused a test fixture to be bypassed and the **real `comfy` binary to be invoked** by the suite. Every spawn in this project must pass `env: process.env`.

---
