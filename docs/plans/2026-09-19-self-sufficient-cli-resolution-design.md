# Find comfy-cli, and give it an environment it can work in

**Status:** implemented on 2026-09-19 in PR #NN. Kept as the record of the
decisions and the ground truth behind them, not as a description of the code;
where the two differ, the code, `CLAUDE.md` and
`docs/comfy-cli-ground-truth.md` are current.
**Date:** 2026-09-19

> **Paths below are redacted placeholders.** This file is public. Home
> directories appear as `~/`; scratch directories appear as `/tmp/…`. Only
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

## 1. The measurements this design rests on

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

**1.2 `--output-directory` after `--` does reach `main.py`.** Measured directly:

```
argv: ['main.py', '--output-directory', '/tmp/measured-output',
       '--enable-manager', '--enable-manager']
```

Space-separated — the form `flagValue` already parses — and ahead of comfy-cli's
own appended flags. `comfy_status` then reported
`output_directory: "/tmp/measured-output"` where it had reported `null` for
every previous launch. That is the whole of what `resolveArtifactPath` needs.
To be recorded as ground truth **#54**.

**1.3 `comfy which` succeeds even for a workspace that does not exist. [rev]**
Measured during review, and it invalidates the first draft's safety argument:

```
comfy --skip-prompt --json which
  -> ok:true  {workspace_path: "<abs path>", workspace_type: "recent"}

comfy --workspace /tmp/nonexistent-ws-xyz --skip-prompt --json which
  -> ok:true  {workspace_path: "/tmp/nonexistent-ws-xyz", workspace_type: "specified"}
```

`which` does **not** fail for a bad workspace. The first draft said "any failure
skips the flag", which never fires for the most likely bad input — so §3.5 now
requires an explicit existence check rather than relying on a thrown error.
`workspace_type` is a further open-string registry under non-negotiable #2 and
must not be enumerated. To be recorded as ground truth **#55**.

**1.4 Every test wires the fake CLI through `COMFY_BIN`.** Exactly eleven files:
`exec`, `validate`, `vary`, `templates`, `jobs`, `run`, `instance`, `setSlots`,
`notes`, `slots`, `server`. The two that do **not** are `tools.test.ts` and
`index.test.ts` — which matters, because an unguarded discovery test in
`tools.test.ts` would run against the developer's real machine. See §4.

## 2. What already works, and is not being changed

- **`LaunchArgs` already carries `outputDirectory`** (`instance.ts:218-240`), and
  `comfyuiArgs` (`instance.ts:554-576`) already emits `--output-directory
  <value>`. The plumbing exists; nothing populates it.
- **`extraArgs` is appended last, and last-wins is argparse's rule.** A
  caller-supplied `--output-directory` therefore already overrides a curated one,
  by construction. The first draft proposed an explicit "never override the
  caller" check; it would have been code restating a property the argument order
  already guarantees. A test pins the property; no code re-implements it.
- `flagValue` (`instance.ts:452-465`) parses both `--flag value` and `--flag=value`.
- `exec.ts` remains the only place this project spawns a process.

## 3. The design

### 3.1 `src/comfy/binary.ts` — one question, fully injectable

```ts
/** How the binary was found. `not_found` is a real outcome, not an error. */
export type BinarySource = "COMFY_BIN" | "PATH" | "discovered" | "not_found";

export interface ResolvedBinary {
  /**
   * What to spawn. On `not_found` this is the bare name `"comfy"` — the thing
   * we will still attempt, and the thing ComfyUnavailableError must name.
   */
  path: string;
  source: BinarySource;
  /** Repaired PATH for the child. Absent means pass the parent's through. */
  childPath?: string;
  /** Candidate FILE paths tried, set only when `source === "not_found"`. */
  searched?: string[];
}

export interface BinaryDeps {
  env: NodeJS.ProcessEnv;
  home: string;
  isExecutable: (path: string) => boolean;
}

/** Real-filesystem dependencies. The only place binary.ts touches node:fs/os. */
export function defaultBinaryDeps(): BinaryDeps;

export function resolveComfyBinary(deps: BinaryDeps): ResolvedBinary;
```

**[rev] `platform` was removed.** The first draft injected it and no section ever
read it: the search roots are POSIX, the repair keys on the literal `PATH`, and
§3.4 explicitly declines platform branching. Where platform-awareness is
genuinely needed — splitting `PATH` — `node:path`'s `delimiter` already provides
it. A parameter no code reads would not survive review here.

**[rev] `searched` holds candidate *file* paths**, not directories. The first
draft's comment said "Directories tried" while its table listed paths ending in
`/comfy`. File paths are what the error message should print: "I looked for a
file here" is actionable, "I looked in this directory" is not.

`defaultBinaryDeps`'s `isExecutable` must reject a **directory** named `comfy`:

```ts
isExecutable: (p) => {
  try {
    return statSync(p).isFile() && (accessSync(p, constants.X_OK), true);
  } catch {
    return false;
  }
}
```

`accessSync(X_OK)` alone returns true for a directory, so the `isFile()` guard is
required, not decorative.

### 3.2 Resolution order — four outcomes, strict precedence

1. **`COMFY_BIN` is set → use it verbatim, `source: "COMFY_BIN"`, and never fall
   back to discovery.** If the operator named a binary and it is wrong, that is
   an error, not permission to go hunting. This preserves
   `instance.test.ts`'s "a missing comfy binary aborts the wait" case and
   structurally insulates all eleven `COMFY_BIN` test files (§1.4).
2. **Else `comfy` resolves on `PATH` → `path: "comfy"`, `source: "PATH"`**, child
   `PATH` untouched. **[rev] The mechanism, which the first draft left unstated:**
   split `deps.env.PATH` on `node:path`'s `delimiter`, discard empty segments,
   and return the first `dir` for which `isExecutable(join(dir, "comfy"))`. An
   undefined or empty `PATH` yields no match and falls through to rule 3.
3. **Else search known install roots**, first executable hit wins,
   `source: "discovered"`.
4. **[rev] Else `source: "not_found"`**, `path: "comfy"`, `searched` populated
   with every candidate tried. The spawn then fails exactly as it does today,
   and `ComfyUnavailableError` gains the list.

Search roots, in order, **all derived from `deps.home` — never written as
literals.** A hardcoded username in `DEFAULT_WORKFLOW_DIR` is how this repo
earned its PII rule, and it was a correctness bug as much as a disclosure one:

| candidate | why |
|---|---|
| `<home>/.local/bin/comfy` | pipx, `uv tool`, `pip --user` all symlink here |
| `<home>/.local/share/uv/tools/comfy-cli/bin/comfy` | `uv tool` internals, if the symlink is absent |
| `/opt/homebrew/bin/comfy` | Homebrew on Apple Silicon |
| `/usr/local/bin/comfy` | Homebrew on Intel; manual installs |

### 3.3 The `PATH` repair, and why it prepends

When the resolved path is absolute, its directory is **prepended** to the child's
`PATH` unless that directory already appears **anywhere** in `PATH` (not merely
first — if it is present at all the lookup already succeeds, so there is nothing
to repair).

Prepending is a correctness choice. comfy-cli re-execs the bare name `comfy`;
prepending guarantees that re-exec finds *the binary we just resolved*. Appending
would let a different, earlier `comfy` win the re-exec — the same class of bug as
§1.1, harder to see because it would half-work.

This applies **even when `COMFY_BIN` is set**, because that is exactly the
measured failure. If `PATH` is unset entirely, it is set to the directory alone.

**[rev] This changes behaviour in every existing test, and that must be stated.**
All eleven `COMFY_BIN` files point it at an absolute fixture path, so each now
gets `tests/fixtures` prepended to the child's `PATH`. That directory contains
`fake-comfy` and `fake-comfy-dispatch` but **no file named `comfy`**, so nothing
resolves differently — but it is a silent global change and the plan owes it an
explicit assertion. The case to watch is `exec.test.ts:293-305`, which deletes
`COMFY_BIN` and sets `PATH` to a workdir holding a symlink named `comfy`: under
rule 2 that resolves on `PATH`, so **no repair happens** and the test must keep
passing for that reason rather than by luck.

### 3.4 `exec.ts` — the single integration point

Replacing `exec.ts:169`, `:171`, `:174` and `:184`:

```ts
const resolved = resolveComfyBinary(defaultBinaryDeps());
const binary = resolved.path;
const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
const argv = [binary, SKIP_PROMPT, ...args];
const commandLine = argv.join(" ");

const child = spawn(binary, [SKIP_PROMPT, ...args], {
  cwd: opts.cwd,
  env: resolved.childPath === undefined
    ? process.env
    : { ...process.env, PATH: resolved.childPath },
  stdio: ["ignore", "pipe", "pipe"],
});
```

**[rev] Line 171 must be kept and re-pointed.** `const argv = [binary, …]` is a
*separate* array from what `spawn` receives; it exists only to build
`commandLine`, which every diagnostic quotes and `exec.test.ts:315` asserts on.
The first draft's snippet silently dropped it — leaving it stale would make every
error message describe a command that was not run.

`ComfyUnavailableError` (defined in **`exec.ts:71-89`**, not `instance.ts` —
**[rev]**, the first draft filed this under the wrong file) gains an optional
`searched` field and appends one line when it is present:

```
Searched: <path>, <path>, <path>, <path>
```

The existing two sentences are unchanged; `exec.test.ts:272` and
`server.test.ts:1722` assert on them.

Applied to **every** comfy invocation, not only `launch`. Resolution is
re-evaluated per call and deliberately not memoised: two `env` reads, plus a
short `stat` loop only in the discovery case.

**Known limitation:** Windows treats the variable name case-insensitively
(`Path` vs `PATH`) and Node does not normalise it. The repair keys on `PATH`, so
on Windows it may add a second entry rather than extend the existing one.
Harmless, inelegant, not exercised here — a code comment, not speculative
branching.

### 3.5 `instance.ts` — default the output directory

**[rev] Placement is specified, because ten tests count CLI invocations.** The
derivation goes inside `performLaunch` (`instance.ts:951-991`), **after** the
`here.running` early return and **before** `startLaunch(...)`:

```ts
const here = await detectInstance({ ...target, timeoutMs: probeTimeoutMs });
if (here.running) return { outcome: "already_running", instance: here };

const warnings = await contentionWarnings(opts, target, probeTimeoutMs);

const launchArgs = await withDefaultOutputDirectory(argv, opts);   // <-- new
const cli = startLaunch(launchArgv(launchArgs, opts.workspace), timeoutMs);
```

Placing it after the early return is what keeps every `settledInvocations(log, 0)`
assertion at zero: a launch that never happens costs no extra call. The launching
cases gain exactly one invocation each, and those assertions change — see §8.

`withDefaultOutputDirectory` returns `argv` unchanged when any of these hold:

1. `argv` already contains `--output-directory` (typed option or `extraArgs`) —
   checked with the existing `flagValue`, so no `comfy which` call is made.
2. The workspace cannot be determined.
3. **[rev]** The determined workspace directory **does not exist**. Required
   because `comfy which` returns `ok:true` for a nonexistent workspace (§1.3), so
   a try/catch alone would happily pass `--output-directory <nonexistent>/output`.

Otherwise it appends `OUTPUT_DIRECTORY_FLAG, join(workspace, "output")`.

**[rev] Determining the workspace**, with the details the first draft omitted:

- When `opts.workspace !== undefined`, use it directly and make **no** CLI call.
  (The first draft said "when `MCP_COMFYUI_WORKSPACE` is set" — a condition
  `instance.ts` cannot evaluate; it only ever sees `opts.workspace`, which
  `tools.ts:272` populates from that variable.)
- Otherwise `runComfy([JSON_MODE, "which"], { timeoutMs: WHICH_TIMEOUT_MS })`.
  Root flag leads, per landmine #4, matching `launchArgv`'s own ordering.
  `WHICH_TIMEOUT_MS = 10_000` — `RunOptions` defaults to 120 s, and blocking a
  launch for two minutes on a call measured as instant would be wrong.
- Decode with a zod schema in `binary.ts`'s sibling style:
  `z.looseObject({ workspace_path: z.string().nullable().optional() })`.
  `looseObject` because `workspace_type` is an open registry (§1.3) that must not
  be enumerated or required.
- **Any throw is swallowed and the flag is skipped.** This is legibility, never a
  precondition: it must not convert a working launch into a failed one.

Files land where ComfyUI would have written them anyway — `<workspace>/output` is
the default. The change is that the path now appears in `argv`, which is the only
reason `outputs.ts` could not resolve it. Nothing moves for anyone.

### 3.6 `comfy_status` — report the inference

**[rev] Placement and shape, which the first draft left as a bare fragment.** The
handler (`tools.ts:1482-1498`) returns a `target` key spread with one of two
arms. `cli` is a **top-level key present in both arms**, placed after the spread:

```ts
return {
  target: targetBody(resolved),
  ...(detection.running ? instanceBody(detection) : { running: false, … }),
  cli: cliBody(resolveComfyBinary(defaultBinaryDeps())),
};
```

Both arms, deliberately: `running: false` is precisely when an operator most
needs to know which binary was found.

```json
"cli": { "path": "/absolute/path/to/comfy", "source": "discovered", "path_repaired": true }
```

**[rev]** `path` is the **absolute** path, not tilde-abbreviated — the first
draft's example showed `~/…`, which would have changed the test assertion.
`path_repaired` is derived as `childPath !== undefined`; it is not a field on
`ResolvedBinary`. When `source` is `"not_found"`, `cliBody` also emits
`searched`.

Every other inference this server makes is reported alongside its answer —
`host_source`, `object_info.stale`, `target.local`. Auto-discovery should not be
the exception.

## 4. What changes, by file

| file | change |
|---|---|
| `src/comfy/binary.ts` | **new** — `resolveComfyBinary`, `defaultBinaryDeps`, roots, repair |
| `src/comfy/exec.ts` | consult the resolver; repaired env to `spawn`; keep line 171; `searched` on `ComfyUnavailableError` **[rev — was filed under instance.ts]** |
| `src/comfy/instance.ts` | `withDefaultOutputDirectory` in `performLaunch`; the `comfy which` decode; **[rev]** update `launchDiagnosis`'s now-stale PATH advice |
| `src/toolResult.ts` | **[rev, was missing]** `:377-379` — carry `searched` into the `comfy_unavailable` result, or success criterion 2 is unreachable |
| `src/tools.ts` | `cliBody` + the `cli` key in `comfy_status` |
| `tests/binary.test.ts` | **new** — precedence, all four outcomes, search order, repair arithmetic |
| `tests/fixtures/fake-comfy` | **[rev]** TWO new append-only modes: one echoing `$PATH`, one for `which` |
| `tests/fixtures/fake-comfy-dispatch` | **[rev, was missing]** a `which` arm, defaulted so existing launch tests keep working |
| `tests/exec.test.ts` | the repaired `PATH` really reaches the child; `commandLine` still correct |
| `tests/instance.test.ts` | `outputDirectory` defaulting; `extraArgs` still wins; skip cases; **[rev]** the ~6 launching invocation counts; the `launchDiagnosis` assertions |
| `tests/server.test.ts` | **[rev, retargeted from tools.test.ts]** the `cli` block — `tools.test.ts` has zero `comfy_status` coverage and does not set `COMFY_BIN`, so a discovery test there would hit the real machine |
| `README.md` | `COMFY_BIN` becomes an override, not a requirement; document discovery order |
| `CLAUDE.md` | `binary.ts` in the architecture map |
| `CHANGELOG.md` | `[Unreleased]`; **[rev]** revise the PR #39 entry's now-superseded advice |
| `docs/comfy-cli-ground-truth.md` | **#54** (`--output-directory` forwarding), **#55** (`comfy which` shape and its non-failure) |

## 5. What this deliberately does not do

**It does not write `extra_model_paths.yaml`, or any other file inside a ComfyUI
installation.** A bare comfy-cli workspace cannot see a model library kept
elsewhere, and this server could in principle fix that. It should not.

Two reasons. First, it mutates an application this server does not own, which is
a different kind of act from configuring its own subprocess — the line this whole
design is drawn along. Second, the failure mode is silent and severe: a wrong
mapping does not error, it changes which model a render resolves, and the user
gets a plausible image from the wrong weights.

Detecting and *reporting* the condition is legitimate and cheap, but it is not
part of this design.

**It does not add a "disable discovery" switch.** Setting `COMFY_BIN` already is
one, and rule 1 makes it absolute.

**It does not memoise resolution.** See §3.4.

## 6. Rejected, with the reason

### 6.1 Resolve once at startup and inject through `ToolConfig`
Rejected because `exec.ts` is called from a dozen modules that need no config at
all, so threading it through is invasive for no gain in testability — `binary.ts`
is already fully injectable. It would also make a comfy-cli installed after boot
invisible until restart.

### 6.2 Repair only the launch path
Delivers only the `PATH` fix: `COMFY_BIN` stays mandatory and discovery never
happens. Not what was asked for.

### 6.3 Launch into a server-managed output directory
Rejected because it **relocates** renders away from where ComfyUI normally writes
them, so the same machine's ComfyUI GUI would stop showing images made through
this server.

### 6.4 Falling back to discovery when `COMFY_BIN` points at nothing
Rejected on semantics and evidence: an operator who named a binary has expressed
an intent a silent substitution would override, and eleven test files depend on
`COMFY_BIN` meaning exactly what it says.

### 6.5 **[rev]** Avoiding the `comfy which` call to protect the invocation counts
Considered once review showed ten assertions count CLI invocations. Rejected:
without it, `--output-directory` could only be defaulted when the operator had
already set `MCP_COMFYUI_WORKSPACE`, which most installs do not, so C would
almost never fire. One extra fast call on a path that already takes seconds is
the right trade; the assertions are updated instead.

## 7. Ground truth gained, and what is still unmeasured

**Gained** (2026-09-19): #52, comfy-cli's self re-exec through `PATH`; #53, the
head-vs-tail truncation rule that hid it; **#54**, `--output-directory` forwarding
through the `--` separator into `system.argv`; **#55**, `comfy which`'s payload
shape and its refusal to fail on a nonexistent workspace.

**Still unmeasured, to be measured during implementation:**

- Discovery against a machine where comfy-cli is **not** at `~/.local/bin` —
  every measurement here comes from one install shape.
- Whether `workspace_path` can ever be null or absent. The schema tolerates it;
  no observation confirms it happens.
- The Windows `Path` casing behaviour in §3.4 — asserted from documentation.

## 8. Success criteria

1. With **no** `COMFY_BIN` and **no** `PATH` entry for comfy-cli, a cold
   `run_workflow` auto-launches ComfyUI and returns a completed render. The
   configuration that failed today must succeed with an empty `env`.
2. With `COMFY_BIN` pointing at a nonexistent path, the call still fails with
   `ComfyUnavailableError` naming that path — no discovery rescue.
3. `get_job` on a local completed run returns a populated `local_paths`.
4. `comfy_status` reports which binary was used and how it was found, in both the
   running and not-running arms.
5. A test fails if the repaired `PATH` stops reaching the child process.
6. **[rev]** `deno task test` and `deno task typecheck` both clean. The first
   draft claimed "the existing 157 tests unchanged in behaviour"; that is **false**
   and was the review's sharpest finding. `performLaunch` gains one CLI
   invocation on every path that actually launches, so the ~6 launching
   assertions in `tests/instance.test.ts` change value. Every
   `settledInvocations(log, 0)` case stays at 0 (§3.5), and no test changes for
   any reason other than that one added call — any other diff is a regression.
