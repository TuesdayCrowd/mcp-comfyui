# Find comfy-cli, and give it an environment it can work in

**Status:** designed, not implemented. Written 2026-09-19.
**Date:** 2026-09-19

> **Paths below are redacted placeholders.** This file is public. Home
> directories appear as `~/`; a scratch directory appears as `/tmp/…`. Only
> identifying values were substituted — every measured behaviour, flag, argv
> and error string is exactly as observed.

This server currently requires the client that launches it to have already
solved two environment problems on its behalf: where comfy-cli lives, and what
`PATH` its child processes need. A GUI-launched MCP client solves neither, so
the server fails in a way that looks like a ComfyUI fault and is not one.

The goal is narrow and stated as a rule: **anything this server needs in order
to invoke its own dependency is this server's problem, not its caller's.**
Configuring ComfyUI itself remains out of scope, deliberately — see §5.

## Which comfy produced these numbers

comfy-cli installed by `uv tool` at `~/.local/bin/comfy` (absolute shebang into
`~/.local/share/uv/tools/comfy-cli/bin/python`), driving ComfyUI **0.30.2** on
an Apple M3 Max. All measurements 2026-09-19, through `dist/index.js` and
`dist/mcp-comfyui` over real stdio, under a simulated GUI-client environment:
`PATH=/usr/bin:/bin:/usr/sbin:/sbin`, nothing inherited from a shell.

## 1. The three measurements this design rests on

**1.1 `COMFY_BIN` is not sufficient, and the failure is not where it looks.**
With `COMFY_BIN` set to comfy-cli's correct absolute path and `PATH` bare,
every ordinary subcommand worked and `launch` died in about a second:

```
comfy_cli/command/launch.py:463  subprocess.Popen(cmd, …)
FileNotFoundError: [Errno 2] No such file or directory: 'comfy'
```

`comfy launch --background` re-execs **itself** by the bare name `comfy`,
resolved through `PATH`. `COMFY_BIN` is this server's variable; comfy-cli has
never heard of it. Prepending the binary's own directory to `PATH` made the
identical command succeed (`ok:true`, `{background: true, port: 8188, pid: …}`).
Recorded as ground truth #52.

**Why this stayed hidden:** every subcommand except `launch` invokes exactly one
comfy. Only `launch` spawns a second. So a configuration that sets `COMFY_BIN`
alone tests green everywhere except the one path that matters, and no test in
this suite has ever asserted anything about a child process's environment.

**1.2 `--output-directory` after `--` does reach `main.py`.** Measured directly.
Launching with `comfy --skip-prompt --json launch --background -- --output-directory /tmp/measured-output`
produced, from the live instance's own `/system_stats`:

```
argv: ['main.py', '--output-directory', '/tmp/measured-output',
       '--enable-manager', '--enable-manager']
```

Space-separated — the form `flagValue` already parses — and ahead of comfy-cli's
own appended flags. `comfy_status` then reported
`output_directory: "/tmp/measured-output"` where it had reported `null` for
every previous launch. That is the whole of what `resolveArtifactPath` needs.

**1.3 Every test wires the fake CLI through `COMFY_BIN`.** Eleven test files.
This is not incidental — it decides a semantic below.

## 2. What already works, and is not being changed

Discovered while designing; recording it because it shrinks the work and
corrects an assumption made earlier in the same session.

- **`LaunchArgs` already carries `outputDirectory`**, and `comfyuiArgs` already
  emits `--output-directory <value>`. The plumbing exists; nothing populates it.
  The same is true of `inputDirectory` and `extraModelPathsConfig`.
- **`extraArgs` is appended last, and last-wins is argparse's rule.** A
  caller-supplied `--output-directory` therefore already overrides a curated
  one, by construction. An earlier draft of this design proposed an explicit
  "never override the caller" check; it would have been redundant code
  restating a property the argument order already guarantees. A test should pin
  the property; no code should re-implement it.
- `flagValue` parses both `--flag value` and `--flag=value`.
- `exec.ts` remains the only place this project spawns a process. This design
  does not add a second one.

## 3. The design

### 3.1 `src/comfy/binary.ts` — one question, fully injectable

```ts
export type BinarySource = "COMFY_BIN" | "PATH" | "discovered";

export interface ResolvedBinary {
  /** What to spawn. */
  path: string;
  /** How it was found. Reported by comfy_status; never used for control flow. */
  source: BinarySource;
  /** Repaired PATH for the child. Absent means pass the parent's through. */
  childPath?: string;
  /** Directories tried, set only when discovery ran and found nothing. */
  searched?: string[];
}

export function resolveComfyBinary(deps: {
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
  isExecutable: (path: string) => boolean;
}): ResolvedBinary;
```

Every dependency is injected, so the resolver is testable without touching the
real filesystem, the real `$HOME`, or the real `PATH`.

### 3.2 Resolution order — three rules, strict precedence

1. **`COMFY_BIN` is set → use it verbatim, and never fall back to discovery.**
   If the operator named a binary and it is wrong, that is an error, not
   permission to go hunting. This preserves `instance.test.ts`'s
   "a missing comfy binary aborts the wait" case, and it is what structurally
   insulates all eleven `COMFY_BIN`-based test files from discovery (§1.3).
2. **Else `comfy` resolves on `PATH` → use the bare name**, `source: "PATH"`,
   child `PATH` untouched. Nothing is broken, so nothing is repaired.
3. **Else search known install roots**, first executable hit wins,
   `source: "discovered"`.

Search roots, in order, **all derived from `homedir()` — never written as
literals.** A hardcoded username in `DEFAULT_WORKFLOW_DIR` is how this repo
earned its PII rule, and it was a correctness bug as much as a disclosure one:

| root | why |
|---|---|
| `~/.local/bin/comfy` | pipx, `uv tool`, `pip --user` all symlink here |
| `~/.local/share/uv/tools/comfy-cli/bin/comfy` | `uv tool` internals, if the symlink is absent |
| `/opt/homebrew/bin/comfy` | Homebrew on Apple Silicon |
| `/usr/local/bin/comfy` | Homebrew on Intel; manual installs |

Executability is checked with `X_OK`, not mere existence: a stale,
non-executable file must not beat a working binary further down the list.

### 3.3 The `PATH` repair, and why it prepends

When the resolved path is absolute, its directory is **prepended** to the
child's `PATH` unless that directory already appears **anywhere** in `PATH`
(not merely as the first entry — if it is present at all, the lookup already
succeeds and there is nothing to repair).

Prepending is a correctness choice, not a stylistic one. comfy-cli re-execs the
bare name `comfy`; prepending guarantees that re-exec finds *the binary we just
resolved*. Appending would let a different, earlier `comfy` win the re-exec —
the same class of bug as §1.1, harder to see because it would half-work.

This applies **even when `COMFY_BIN` is set**, because that is exactly the
measured failure: a correct `COMFY_BIN` and a `PATH` that could not satisfy
comfy-cli's own lookup.

If `PATH` is unset entirely, it is set to the directory alone.

### 3.4 `exec.ts` — the single integration point

```ts
const resolved = resolveComfyBinary({ env: process.env, home: homedir(), … });
const child = spawn(resolved.path, [SKIP_PROMPT, ...args], {
  cwd: opts.cwd,
  env: resolved.childPath === undefined
    ? process.env
    : { ...process.env, PATH: resolved.childPath },
  stdio: ["ignore", "pipe", "pipe"],
});
```

Applied to **every** comfy invocation, not only `launch`. Only `launch` needs it
today, but one rule is easier to reason about than two, and a future subcommand
that shells out to a sibling gets it for free. The existing comment explaining
why `env` is passed explicitly stays — it documents a real Bun landmine (#17).

Resolution is re-evaluated per call and deliberately not memoised: two `env`
reads, plus a short `stat` loop only in the discovery case. Cheap enough, and it
means installing comfy-cli mid-session works without a restart.

**Known limitation, stated rather than papered over:** Windows treats the
variable name case-insensitively (`Path` vs `PATH`) and Node does not normalise
it. The repair keys on `PATH`, so on Windows it may add a second entry rather
than extend the existing one. Harmless, inelegant, and not exercised here — it
belongs in a code comment, not in speculative platform branching.

### 3.5 `instance.ts` — default the output directory

At launch, when `args.outputDirectory` is not already set, derive it:

1. Use `opts.workspace` when `MCP_COMFYUI_WORKSPACE` is set.
2. Otherwise ask `comfy which` and read `data.workspace_path`.
3. Set `outputDirectory` to `<workspace>/output`.

**Any failure skips the flag and launches exactly as before.** If `comfy which`
errors, or returns a null workspace, the launch proceeds unchanged and
`local_paths` stays empty as it does today. This is legibility, never a
precondition: it must not convert a working launch into a failed one.

Files land where ComfyUI would have written them anyway — `<workspace>/output`
is the default. The change is that the path now appears in `argv`, which is the
only reason `outputs.ts` could not resolve it. Nothing moves for anyone.

Cost: one extra CLI call per launch, against a launch already measured in
seconds. `comfy which` returns effectively instantly.

### 3.6 `comfy_status` — report the inference

```json
"cli": { "path": "~/.local/bin/comfy", "source": "discovered", "path_repaired": true }
```

Every other inference this server makes is reported alongside its answer —
`host_source`, `object_info.stale`, `target.local`. Auto-discovery should not be
the exception. This is the difference between magic and diagnosable magic.

## 4. What changes, by file

| file | change |
|---|---|
| `src/comfy/binary.ts` | **new** — `resolveComfyBinary`, the search roots, the repair |
| `src/comfy/exec.ts` | consult the resolver; pass the repaired env to `spawn` |
| `src/comfy/instance.ts` | default `outputDirectory` from the workspace; extend `ComfyUnavailableError` with the searched roots |
| `src/tools.ts` | the `cli` block in `comfy_status` |
| `tests/binary.test.ts` | **new** — precedence, search order, repair arithmetic |
| `tests/fixtures/fake-comfy` | **new append-only mode** that echoes its own `$PATH` |
| `tests/exec.test.ts` | the repaired `PATH` really reaches the child |
| `tests/instance.test.ts` | `outputDirectory` defaulting; `extraArgs` still wins; `comfy which` failure is survivable |
| `tests/tools.test.ts` | the `cli` block |
| `README.md` | `COMFY_BIN` becomes an override, not a requirement; document discovery order |
| `CLAUDE.md` | `binary.ts` in the architecture map |
| `CHANGELOG.md` | `[Unreleased]` |
| `docs/comfy-cli-ground-truth.md` | cross-reference #52; add the `--output-directory` measurement |

## 5. What this deliberately does not do

**It does not write `extra_model_paths.yaml`, or any other file inside a ComfyUI
installation.** A bare comfy-cli workspace cannot see a model library kept
elsewhere, and this server could in principle fix that. It should not.

Two reasons. First, it mutates an application this server does not own, which is
a different kind of act from configuring its own subprocess — the line this
whole design is drawn along. Second, the failure mode is silent and severe: a
wrong mapping does not error, it changes which model a render resolves, and the
user gets a plausible image from the wrong weights.

Detecting and *reporting* the condition is legitimate and cheap — the instance's
`/object_info` already says how many VAEs it can see — but it is not part of
this design and should be proposed separately if wanted.

**It does not add a "disable discovery" switch.** Setting `COMFY_BIN` already is
one, and rule 1 makes it absolute.

**It does not memoise resolution.** See §3.4.

## 6. Rejected, with the reason

### 6.1 Resolve once at startup and inject through `ToolConfig`
More orthodox dependency injection, which this project's guidelines favour in
general. Rejected because `exec.ts` is called from a dozen modules that need no
config at all, so threading it through is invasive for no gain in testability —
`binary.ts` is already fully injectable. It would also make a comfy-cli
installed after boot invisible until restart.

### 6.2 Repair only the launch path
Smallest and safest. Rejected because it delivers only the `PATH` fix:
`COMFY_BIN` stays mandatory and discovery never happens, which is not what was
asked for.

### 6.3 Launch into a server-managed output directory
Maximally self-contained and always resolvable. Rejected because it **relocates**
renders away from where ComfyUI normally writes them, so the same machine's
ComfyUI GUI would stop showing images made through this server. Passing the
workspace's own `output/` achieves resolvability with no behavioural change.

### 6.4 Falling back to discovery when `COMFY_BIN` points at nothing
Rejected on semantics and on evidence. An operator who named a binary has
expressed an intent that a silent substitution would override, and eleven test
files depend on `COMFY_BIN` meaning exactly what it says.

## 7. Ground truth gained, and what is still unmeasured

**Gained** (2026-09-19): #52, comfy-cli's self re-exec through `PATH`; #53, the
head-vs-tail truncation rule that hid it; and §1.2 above, `--output-directory`
forwarding through the `--` separator into `system.argv`.

**Still unmeasured, and to be measured during implementation:**

- Discovery against a machine where comfy-cli is **not** at `~/.local/bin` —
  every measurement here comes from one install shape.
- Whether any real install puts comfy-cli somewhere none of the four roots
  covers. The failure is graceful (`ComfyUnavailableError` naming what was
  tried), but the root list is inference, not measurement.
- The Windows `Path` casing behaviour in §3.4 — asserted from documentation,
  not run.

## 8. Success criteria

1. With **no** `COMFY_BIN` and **no** `PATH` entry for comfy-cli, a cold
   `run_workflow` auto-launches ComfyUI and returns a completed render. This is
   the whole point: the configuration that failed today must succeed with an
   empty `env`.
2. With `COMFY_BIN` pointing at a nonexistent path, the call still fails with
   `ComfyUnavailableError` naming that path — no discovery rescue.
3. `get_job` on a local completed run returns a populated `local_paths`.
4. `comfy_status` reports which binary was used and how it was found.
5. A test fails if the repaired `PATH` stops reaching the child process.
6. `deno task test` and `deno task typecheck` both clean; the existing 157 tests
   unchanged in behaviour.
