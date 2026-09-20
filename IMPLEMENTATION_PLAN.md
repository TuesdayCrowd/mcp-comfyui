# Self-Sufficient comfy-cli Resolution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the server find comfy-cli itself and hand its children a working `PATH`, so a GUI-launched MCP client needs no `COMFY_BIN` and no `PATH` in its config — and so a launched ComfyUI reports an output directory that artifact URLs can resolve against.

**Architecture:** A new injectable `src/comfy/binary.ts` answers "which comfy, and what `PATH` should its child get?". `src/comfy/exec.ts` — already the only place this project spawns a process — consults it. Separately, `performLaunch` defaults `--output-directory` from the workspace so `outputs.ts` can resolve artifacts.

**Tech Stack:** Deno 2 (tests, bundling), TypeScript targeting Node ≥18, zod 4, `@std/testing/bdd` + `@std/expect` via `tests/support/testing.ts`.

**Spec:** `docs/plans/2026-09-19-self-sufficient-cli-resolution-design.md` (read it — this plan argues from it)

## Global Constraints

- **Version control is GitButler.** `but commit -b <branch> -m "…"`. **Never** `git commit`, `git checkout`, `git rebase`, `git merge`. Never `but land`. All work lands on one branch: `self-sufficient-cli-resolution`.
- **Commit message footer, every commit:** `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- **Tests:** `deno task test` (all), `deno task test:one tests/<file>.ts` (one file). A bare `deno test <file>` does not work here. `--filter` cannot reach inside a file that uses `beforeEach`.
- **Compile gate:** `deno task typecheck` (`tsc --noEmit` under node). Not `deno check`.
- **Never `console.log`.** stdout is the MCP protocol; diagnostics go to stderr.
- **Fixture modes are append-only.** Never change an existing mode in `tests/fixtures/fake-comfy`. Add new ones.
- **Never close an enum** that comes from the CLI. Use `z.looseObject` and `z.string()`, never `z.enum`.
- **Never `JSON.parse` a payload that can contain a workflow graph** (seeds exceed 2^53).
- **PII: this repo is public.** No usernames, no real home paths, no tailnet/private IPs in any tracked file. Derive home from `homedir()`, never a literal.
- **Only one process-spawn point.** Do not add a second `spawn` call anywhere.
- **Run tests one at a time.** Never two `deno task test` invocations concurrently — they contend and blow the 5-second budgets.
- Write test output to a file and read the file. Never pipe `deno test` through `grep`.
- **Discovery opens a new route to a real comfy-cli, and the suite's oldest rule is that no test may reach one.** Before this work an unset `COMFY_BIN` could only find a real binary through `PATH`; afterwards it also reaches `~/.local/bin`, uv's tool directory and the two Homebrew prefixes. Any test that exercises resolution without `COMFY_BIN` set **must also fake `$HOME`** (`homedir()` honours it) and point `PATH` somewhere empty. `tests/tools.test.ts` and `tests/index.test.ts` are the two files that never set `COMFY_BIN`; today neither calls `runComfy`, so nothing breaks — but that is an accident, not a guard.

---

### Task 1: `binary.ts` — resolution and PATH repair, standalone

**Files:**
- Create: `src/comfy/binary.ts`
- Create: `tests/binary.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `resolveComfyBinary(deps: BinaryDeps): ResolvedBinary`, `defaultBinaryDeps(): BinaryDeps`, types `BinarySource = "COMFY_BIN" | "PATH" | "discovered" | "not_found"`, `ResolvedBinary { path: string; source: BinarySource; childPath?: string; searched?: string[] }`, `BinaryDeps { env: NodeJS.ProcessEnv; home: string; isExecutable: (p: string) => boolean }`, and the constant `COMFY_BINARY_NAME = "comfy"`. Task 2 consumes all of these; Task 6 consumes `ResolvedBinary` and `defaultBinaryDeps`.

- [ ] **Step 1: Write the failing test file**

Create `tests/binary.test.ts`:

```ts
import { expect, test } from "./support/testing.ts";
import { delimiter, join } from "node:path";
import {
  COMFY_BINARY_NAME,
  resolveComfyBinary,
  type BinaryDeps,
} from "../src/comfy/binary.ts";

const HOME = "/home/someone";

/** A deps bag where only the listed paths are executable files. */
function deps(
  env: NodeJS.ProcessEnv,
  executables: string[] = [],
  home = HOME,
): BinaryDeps {
  const set = new Set(executables);
  return { env, home, isExecutable: (p) => set.has(p) };
}

test("COMFY_BIN wins outright, and is not checked for existence", () => {
  const r = resolveComfyBinary(deps({ COMFY_BIN: "/opt/custom/comfy", PATH: "/usr/bin" }));
  expect(r.path).toBe("/opt/custom/comfy");
  expect(r.source).toBe("COMFY_BIN");
});

test("COMFY_BIN never falls back to discovery, even pointing at nothing", () => {
  // An operator who named a binary has expressed an intent. Substituting a
  // different one silently would override it -- and eleven test files depend
  // on COMFY_BIN meaning exactly what it says.
  const r = resolveComfyBinary(
    deps({ COMFY_BIN: "/nope/comfy" }, [join(HOME, ".local/bin", COMFY_BINARY_NAME)]),
  );
  expect(r.path).toBe("/nope/comfy");
  expect(r.source).toBe("COMFY_BIN");
  expect(r.searched).toBeUndefined();
});

test("COMFY_BIN still gets its directory prepended to the child PATH", () => {
  // The measured failure: a correct COMFY_BIN and a PATH that could not
  // satisfy comfy-cli's own re-exec of itself.
  const r = resolveComfyBinary(deps({ COMFY_BIN: "/opt/custom/comfy", PATH: "/usr/bin" }));
  expect(r.childPath).toBe(`/opt/custom${delimiter}/usr/bin`);
});

test("a comfy already on PATH is used bare, and nothing is repaired", () => {
  const r = resolveComfyBinary(
    deps({ PATH: `/usr/bin${delimiter}/opt/tools` }, [join("/opt/tools", COMFY_BINARY_NAME)]),
  );
  expect(r.path).toBe(COMFY_BINARY_NAME);
  expect(r.source).toBe("PATH");
  expect(r.childPath).toBeUndefined();
});

test("a later PATH entry still counts, so the scan does not stop at the first miss", () => {
  // Deliberately NOT "first hit wins": rule 2 discards the winning directory
  // (it returns the bare name), so which entry matched is unobservable in
  // ResolvedBinary and a test asserting order could not fail. What IS
  // observable, and worth pinning, is that a non-matching earlier entry does
  // not abort the scan and fall through to discovery.
  const r = resolveComfyBinary(
    deps({ PATH: `/empty${delimiter}/b` }, [join("/b", COMFY_BINARY_NAME)]),
  );
  expect(r.source).toBe("PATH");
  expect(r.childPath).toBeUndefined();
});

test("discovery finds ~/.local/bin when PATH has nothing", () => {
  const found = join(HOME, ".local/bin", COMFY_BINARY_NAME);
  const r = resolveComfyBinary(deps({ PATH: "/usr/bin" }, [found]));
  expect(r.path).toBe(found);
  expect(r.source).toBe("discovered");
  expect(r.childPath).toBe(`${join(HOME, ".local/bin")}${delimiter}/usr/bin`);
});

test("discovery prefers ~/.local/bin over Homebrew", () => {
  const local = join(HOME, ".local/bin", COMFY_BINARY_NAME);
  const brew = join("/opt/homebrew/bin", COMFY_BINARY_NAME);
  const r = resolveComfyBinary(deps({ PATH: "/usr/bin" }, [brew, local]));
  expect(r.path).toBe(local);
});

test("discovery falls through to Homebrew when the home roots are empty", () => {
  const brew = join("/opt/homebrew/bin", COMFY_BINARY_NAME);
  const r = resolveComfyBinary(deps({ PATH: "/usr/bin" }, [brew]));
  expect(r.path).toBe(brew);
  expect(r.source).toBe("discovered");
});

test("nothing anywhere is not_found, and names every candidate tried", () => {
  const r = resolveComfyBinary(deps({ PATH: "/usr/bin" }, []));
  expect(r.source).toBe("not_found");
  expect(r.path).toBe(COMFY_BINARY_NAME); // still what we will attempt
  expect(r.searched).toEqual([
    join(HOME, ".local/bin", COMFY_BINARY_NAME),
    join(HOME, ".local/share/uv/tools/comfy-cli/bin", COMFY_BINARY_NAME),
    join("/opt/homebrew/bin", COMFY_BINARY_NAME),
    join("/usr/local/bin", COMFY_BINARY_NAME),
  ]);
  expect(r.childPath).toBeUndefined();
});

test("an undefined PATH is not a crash, and discovery still runs", () => {
  const found = join(HOME, ".local/bin", COMFY_BINARY_NAME);
  const r = resolveComfyBinary(deps({}, [found]));
  expect(r.source).toBe("discovered");
  expect(r.childPath).toBe(join(HOME, ".local/bin"));
});

test("a directory already on PATH is not prepended again", () => {
  const found = join("/opt/tools", COMFY_BINARY_NAME);
  const r = resolveComfyBinary(
    deps({ COMFY_BIN: found, PATH: `/usr/bin${delimiter}/opt/tools` }),
  );
  expect(r.childPath).toBeUndefined();
});

test("the directory is PREPENDED, never appended", () => {
  // comfy-cli re-execs the bare name `comfy`. Prepending is what guarantees
  // that re-exec finds the binary we just resolved; appending would let a
  // different, earlier comfy win it.
  const r = resolveComfyBinary(deps({ COMFY_BIN: "/opt/custom/comfy", PATH: "/usr/bin" }));
  expect(r.childPath?.startsWith("/opt/custom")).toBe(true);
});

test("a relative COMFY_BIN is left alone rather than guessed at", () => {
  const r = resolveComfyBinary(deps({ COMFY_BIN: "comfy", PATH: "/usr/bin" }));
  expect(r.path).toBe("comfy");
  expect(r.childPath).toBeUndefined();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno task test:one tests/binary.test.ts > /tmp/red.log 2>&1; tail -20 /tmp/red.log`
Expected: FAIL — module `../src/comfy/binary.ts` not found.

- [ ] **Step 3: Write `src/comfy/binary.ts`**

```ts
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";

/**
 * The name comfy-cli is invoked by, and — critically — the name it re-execs
 * ITSELF by. `comfy launch --background` shells out to this bare string
 * through PATH (ground truth #52), which is why resolving an absolute path is
 * not on its own enough to make a launch work.
 */
export const COMFY_BINARY_NAME = "comfy";

/** How the binary was found. `not_found` is a real outcome, not an error. */
export type BinarySource = "COMFY_BIN" | "PATH" | "discovered" | "not_found";

export interface ResolvedBinary {
  /**
   * What to spawn. On `not_found` this is the bare name: the thing we will
   * still attempt, and the thing `ComfyUnavailableError` must name.
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

/**
 * Where comfy-cli lands, in preference order. Derived from `home` rather than
 * written as literals: a hardcoded home path is how this repo earned its PII
 * rule, and it was a correctness bug as much as a disclosure one — a path that
 * only exists on one machine silently disables the feature everywhere else.
 */
function searchRoots(home: string): string[] {
  return [
    join(home, ".local", "bin"),
    join(home, ".local", "share", "uv", "tools", "comfy-cli", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
}

/**
 * Real-filesystem dependencies. The only place this module touches node:fs or
 * node:os, so every rule above it is testable without a filesystem.
 */
export function defaultBinaryDeps(): BinaryDeps {
  return {
    env: process.env,
    home: homedir(),
    isExecutable: (path) => {
      try {
        // `isFile()` is required, not decorative: accessSync(X_OK) returns
        // true for a DIRECTORY named `comfy`, which would then be "found" and
        // fail at spawn with a confusing EACCES.
        if (!statSync(path).isFile()) return false;
        accessSync(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Is `dir` already reachable from this PATH? Then there is nothing to repair.
 *
 * Keyed on the exact name `PATH`. Windows treats the variable name
 * case-insensitively (`Path` vs `PATH`) and Node does not normalise it, so on
 * Windows this may add a second entry rather than extend the existing one.
 * Harmless, inelegant, and deliberately not branched on: no measurement here
 * covers Windows, and speculative platform code would be inference presented
 * as fact.
 */
function onPath(env: NodeJS.ProcessEnv, dir: string): boolean {
  return (env.PATH ?? "").split(delimiter).filter(Boolean).includes(dir);
}

/**
 * Prepend, never append.
 *
 * comfy-cli re-execs the bare name `comfy`; prepending guarantees that re-exec
 * finds the binary we just resolved. Appending would let a different, earlier
 * `comfy` win the lookup — the same class of bug as ground truth #52, and
 * harder to see because it would half-work.
 */
function repairedPath(env: NodeJS.ProcessEnv, binaryPath: string): string | undefined {
  if (!isAbsolute(binaryPath)) return undefined;
  const dir = dirname(binaryPath);
  if (onPath(env, dir)) return undefined;
  const existing = env.PATH ?? "";
  return existing === "" ? dir : `${dir}${delimiter}${existing}`;
}

/**
 * Which comfy to spawn, and what PATH its child needs.
 *
 * Re-evaluated per call rather than memoised: two env reads, plus a short stat
 * loop only when discovery is reached. That also means installing comfy-cli
 * mid-session works without restarting this server.
 */
export function resolveComfyBinary(deps: BinaryDeps): ResolvedBinary {
  const explicit = deps.env.COMFY_BIN;
  if (explicit !== undefined && explicit !== "") {
    // Deliberately unchecked and with no fallback. If the operator named a
    // binary and it is wrong, that is an error to report, not an invitation to
    // substitute a different one.
    return withRepair({ path: explicit, source: "COMFY_BIN" }, deps.env);
  }

  for (const dir of (deps.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    if (deps.isExecutable(join(dir, COMFY_BINARY_NAME))) {
      // Already reachable by name: nothing to resolve, nothing to repair.
      return { path: COMFY_BINARY_NAME, source: "PATH" };
    }
  }

  const searched: string[] = [];
  for (const root of searchRoots(deps.home)) {
    const candidate = join(root, COMFY_BINARY_NAME);
    searched.push(candidate);
    if (deps.isExecutable(candidate)) {
      return withRepair({ path: candidate, source: "discovered" }, deps.env);
    }
  }

  return { path: COMFY_BINARY_NAME, source: "not_found", searched };
}

function withRepair(base: ResolvedBinary, env: NodeJS.ProcessEnv): ResolvedBinary {
  const childPath = repairedPath(env, base.path);
  return childPath === undefined ? base : { ...base, childPath };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `deno task test:one tests/binary.test.ts > /tmp/green.log 2>&1; tail -6 /tmp/green.log`
Expected: PASS — the runner prints `13 passed | 0 failed`. `binary.test.ts` has no `beforeEach`/`afterEach`, so under this project's bdd shim these register as **top-level tests, not steps**.

- [ ] **Step 5: Typecheck**

Run: `deno task typecheck`
Expected: zero errors.

- [ ] **Step 6: Mutation-test the two rules that matter**

The repo's standard is that a behaviour change is confirmed by a mutant that kills a test. Apply each, confirm the named test fails, then restore:

1. In `resolveComfyBinary`, move the `COMFY_BIN` branch *below* the discovery loop → "COMFY_BIN never falls back to discovery" must fail.
2. In `repairedPath`, return `${existing}${delimiter}${dir}` → "the directory is PREPENDED, never appended" must fail.
3. In `defaultBinaryDeps`, drop the `isFile()` guard → no unit test covers it (it is filesystem-bound); note this in the commit body rather than pretending it is pinned.

Restore the file exactly afterwards and re-run Step 4.

- [ ] **Step 7: Commit**

```bash
but commit -b self-sufficient-cli-resolution -m "feat: resolve the comfy binary and repair the child PATH

New src/comfy/binary.ts answers which comfy to spawn and what PATH its
child needs. COMFY_BIN wins outright and never falls back to discovery;
otherwise PATH is searched, then four known install roots derived from
homedir(). The binary's directory is PREPENDED to the child PATH because
comfy-cli re-execs itself by bare name (ground truth #52) and appending
would let a different comfy win that lookup.

Not wired in yet -- exec.ts consumes this in the next commit.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Wire the resolver into `exec.ts`, and prove the PATH reaches the child

**Files:**
- Modify: `src/comfy/exec.ts:1-9` (imports), `:168-188` (runComfyRaw)
- Modify: `tests/fixtures/fake-comfy` (one new append-only mode)
- Modify: `tests/exec.test.ts`

**Interfaces:**
- Consumes: `resolveComfyBinary`, `defaultBinaryDeps` from Task 1.
- Produces: no new exports. `runComfyRaw` now spawns `resolved.path` with a possibly-repaired `PATH`.

- [ ] **Step 1: Add the fixture mode**

In `tests/fixtures/fake-comfy`, add to the header comment block:

```
#   $FAKE_COMFY_PATH_OUT   file to record the child's own $PATH in, so a test can
#                          prove the repaired PATH actually reached the process
```

and add a new case immediately after the `garbage_self_exec)` block (append-only — do not touch any existing mode):

```sh
  echo_path)
    # Report the PATH this process was actually given. Nothing else in this
    # suite has ever asserted on a child's environment, which is exactly why
    # the re-exec bug (ground truth #52) was invisible to 157 tests.
    [ -n "$FAKE_COMFY_PATH_OUT" ] && printf '%s\n' "$PATH" > "$FAKE_COMFY_PATH_OUT"
    echo "$OK"
    exit 0 ;;
```

- [ ] **Step 2: Write the failing tests**

Append to `tests/exec.test.ts` (and add `FAKE_COMFY_PATH_OUT` to the `afterEach` delete list):

```ts
test("the resolved binary's directory reaches the child's PATH", async () => {
  // The bug this whole feature exists for: comfy-cli re-execs itself by bare
  // name, so an absolute COMFY_BIN alone is not enough.
  const pathOut = join(workdir, "child-path");
  process.env.FAKE_COMFY_MODE = "echo_path";
  process.env.FAKE_COMFY_PATH_OUT = pathOut;
  process.env.PATH = "/usr/bin";

  await runComfy(["workflow", "slots"]);

  const childPath = readFileSync(pathOut, "utf8").trim();
  expect(childPath.split(delimiter)[0]).toBe(dirname(FAKE_COMFY));
  expect(childPath.endsWith("/usr/bin")).toBe(true);
});

test("a comfy already on PATH leaves the child's PATH untouched", async () => {
  const pathOut = join(workdir, "child-path");
  const link = join(workdir, "comfy");
  symlinkSync(FAKE_COMFY, link);
  delete process.env.COMFY_BIN;
  process.env.PATH = workdir;
  process.env.FAKE_COMFY_MODE = "echo_path";
  process.env.FAKE_COMFY_PATH_OUT = pathOut;

  await runComfy(["workflow", "slots"]);

  // Resolved by rule 2, so there was nothing to repair -- and this must pass
  // for that reason, not by accident.
  expect(readFileSync(pathOut, "utf8").trim()).toBe(workdir);
});

test("the quoted command line names the resolved binary, not a stale one", async () => {
  process.env.FAKE_COMFY_MODE = "echo_path";
  process.env.FAKE_COMFY_PATH_OUT = join(workdir, "child-path");
  const run = await runComfyRaw(["workflow", "slots"]);
  expect(run.commandLine).toBe(`${FAKE_COMFY} --skip-prompt workflow slots`);
});
```

Add to the import block of `tests/exec.test.ts`:

```ts
import { delimiter, dirname, join } from "node:path";
```

(replacing the existing `import { join } from "node:path";`)

Save and restore `PATH` around these tests by adding to the existing hooks:

```ts
let savedPath: string | undefined;
let savedHome: string | undefined;

beforeEach(() => {
  savedPath = process.env.PATH;
  savedHome = process.env.HOME;
});

afterEach(() => {
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  // HOME too: `homedir()` follows it, and discovery's first root is
  // `<home>/.local/bin`. Without this, a discovery test reads the developer's
  // real install and the suite shells out to a real comfy-cli.
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  delete process.env.FAKE_COMFY_PATH_OUT;
});
```

**On multiple hooks in one file:** `@std/testing/bdd` composes several
module-level `beforeEach`/`afterEach` registrations in registration order. If
the implementer finds otherwise, fold these four lines into the file's existing
hooks rather than working around it.

- [ ] **Step 3: Run to verify they fail**

Run: `deno task test:one tests/exec.test.ts > /tmp/red2.log 2>&1; tail -20 /tmp/red2.log`
Expected: the first test FAILS — the child's PATH is still `/usr/bin`, because `exec.ts` passes `process.env` through unchanged.

- [ ] **Step 4: Change `exec.ts`**

Add to the import block (`exec.ts:1-9`):

```ts
import { defaultBinaryDeps, resolveComfyBinary } from "./binary.ts";
```

Replace `exec.ts:169-188` — **through and including the `});` that closes the `spawn` call.** Verified: `:186` is `env: process.env,`, `:187` is `stdio: [...],`, `:188` is `});`. Stopping at 186 duplicates the last two lines and will not parse. Note line 171's `argv` is a **separate** array from what `spawn` receives, existing only to build `commandLine`; it must be re-pointed at `resolved.path`, not dropped:

```ts
  const resolved = resolveComfyBinary(defaultBinaryDeps());
  const binary = resolved.path;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const argv = [binary, SKIP_PROMPT, ...args];
  const commandLine = argv.join(" ");

  const child = spawn(binary, [SKIP_PROMPT, ...args], {
    cwd: opts.cwd,
    // Passed explicitly, on principle: Node already forwards live
    // `process.env` to a spawned child by default (verified directly), so
    // this is defensive rather than required — every spawn in this project
    // passes `env` anyway so the behaviour cannot regress if that default
    // ever changes upstream. Historically load-bearing under this project's
    // former Bun toolchain (landmine #17): Bun's spawn captured the
    // environment only at process start and ignored runtime mutations
    // unless `env` was passed explicitly.
    //
    // The PATH override is the part that is not defensive. comfy-cli's
    // `launch --background` re-execs ITSELF by bare name, so a child whose
    // PATH cannot find `comfy` dies with FileNotFoundError even when this
    // server invoked it by absolute path (ground truth #52).
    env: resolved.childPath === undefined
      ? process.env
      : { ...process.env, PATH: resolved.childPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
```

- [ ] **Step 5: Run the file's tests to verify they pass**

Run: `deno task test:one tests/exec.test.ts > /tmp/green2.log 2>&1; tail -6 /tmp/green2.log`
Expected: PASS.

- [ ] **Step 6: Run the FULL suite — this change touches every test**

Run: `deno task test > /tmp/full2.log 2>&1; tail -6 /tmp/full2.log`
Expected: **170 passed**, 0 failed. (The measured baseline before this work is `157 passed (738 steps)`; Task 1 added 13 top-level tests. An engineer expecting 157 here stops to investigate a non-problem.) Every one of the eleven `COMFY_BIN` files now gets `tests/fixtures` prepended to its child `PATH`; that directory holds `fake-comfy` and `fake-comfy-dispatch` but no file named `comfy`, so nothing resolves differently. **If any test fails here, stop and read it** — it means the repair changed a resolution somewhere, which the design says it must not.

- [ ] **Step 7: Typecheck and commit**

Run: `deno task typecheck`

```bash
but commit -b self-sufficient-cli-resolution -m "feat: spawn comfy with a repaired PATH

runComfyRaw now resolves the binary through binary.ts and hands the child
a PATH that can find it. Applied to every invocation, not only launch:
one rule is easier to reason about than two.

New append-only fixture mode echo_path records the child's own \$PATH, so
a test can assert the repair actually reached the process. Nothing in this
suite had ever asserted on a child's environment, which is precisely why
the re-exec bug was invisible to all 157 tests.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Report what was searched when nothing is found

**Files:**
- Modify: `src/comfy/exec.ts:66-89` (`ComfyUnavailableError`), `:207` and `:215` (construction sites)
- Modify: `src/toolResult.ts:377-379`
- Modify: `tests/exec.test.ts`

**Interfaces:**
- Consumes: `ResolvedBinary.searched` from Task 1; the resolver call added in Task 2.
- Produces: `ComfyUnavailableError` gains `readonly searched: string[] | undefined` and a fourth constructor parameter `searched?: string[]`. The `comfy_unavailable` tool result gains an optional `searched` key.

- [ ] **Step 1: Write the failing tests**

Append to `tests/exec.test.ts`:

```ts
test("a comfy that is nowhere names every candidate that was tried", async () => {
  delete process.env.COMFY_BIN;
  process.env.PATH = join(workdir, "empty"); // exists but holds no comfy
  // HOME too, and this is not belt-and-braces: discovery's FIRST root is
  // `<home>/.local/bin`, which on a developer machine really does hold
  // comfy-cli. Without this the test does not fail cleanly -- it shells out to
  // the real CLI, breaking "tests never invoke the real `comfy`".
  process.env.HOME = workdir;

  const err = await rejection(runComfy(["workflow", "slots"]));

  expect(err).toBeInstanceOf(ComfyUnavailableError);
  const searched = (err as ComfyUnavailableError).searched;
  expect(searched).toBeDefined();
  // Not a length: /opt/homebrew/bin/comfy and /usr/local/bin/comfy may exist on
  // the machine running this. The home-derived root is the one we control.
  expect(searched).toContain(join(workdir, ".local", "bin", "comfy"));
  expect((err as Error).message).toContain("Searched:");
  // The existing two sentences must survive -- other tests assert on them.
  expect((err as Error).message).toContain("set COMFY_BIN to the binary's full path");
});

test("an explicit COMFY_BIN that is missing reports no search at all", async () => {
  // Nothing was searched, because naming a binary suppresses discovery.
  process.env.COMFY_BIN = join(workdir, "definitely-not-installed");
  const err = await rejection(runComfy(["workflow", "slots"]));
  expect(err).toBeInstanceOf(ComfyUnavailableError);
  expect((err as ComfyUnavailableError).searched).toBeUndefined();
  expect((err as Error).message).not.toContain("Searched:");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `deno task test:one tests/exec.test.ts > /tmp/red3.log 2>&1; tail -20 /tmp/red3.log`
Expected: FAIL — `searched` is not a property of `ComfyUnavailableError`.

- [ ] **Step 3: Extend the error class**

Replace `ComfyUnavailableError`'s fields and constructor in `src/comfy/exec.ts`:

```ts
export class ComfyUnavailableError extends Error {
  override readonly name = "ComfyUnavailableError";
  readonly binary: string;
  readonly cwd: string | undefined;
  /**
   * Candidate paths discovery tried, when it ran and found nothing. Undefined
   * when `COMFY_BIN` named a binary — nothing was searched, and saying
   * otherwise would send the operator looking in the wrong place.
   */
  readonly searched: string[] | undefined;

  constructor(binary: string, cwd: string | undefined, cause: unknown, searched?: string[]) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      // Name the cwd too: a missing working directory surfaces as ENOENT
      // quoting the BINARY, so blaming the install alone sends the operator to
      // reinstall a tool that was never broken.
      `could not start the comfy CLI at \`${binary}\`${cwd ? ` (cwd: ${cwd})` : ""}: ${reason}\n` +
        `Install comfy-cli and put it on PATH, or set COMFY_BIN to the binary's full path.` +
        (searched === undefined ? "" : `\nSearched: ${searched.join(", ")}`),
      { cause },
    );
    this.binary = binary;
    this.cwd = cwd;
    this.searched = searched;
  }
}
```

- [ ] **Step 4: Pass `searched` at both construction sites**

In `runComfyRaw`, the two `new ComfyUnavailableError(...)` calls (around `:207` and `:215`) each gain a fourth argument:

```ts
      reject(new ComfyUnavailableError(binary, opts.cwd, cause, resolved.searched));
```

```ts
    throw new ComfyUnavailableError(
      binary,
      opts.cwd,
      new Error("child produced no stdio pipes"),
      resolved.searched,
    );
```

- [ ] **Step 5: Carry it to the wire**

In `src/toolResult.ts`, first declare the field on `ToolErrorBody` beside the
existing `binary?: string` (around `:166`) — the conditional spread below
compiles without it because TypeScript exempts spreads from excess-property
checking, which would leave the key on the wire but absent from the one
interface documenting every other optional key:

```ts
  /** `comfy_unavailable`: the binary path that could not be started. */
  binary?: string;
  /** `comfy_unavailable`: candidate paths discovery tried, when it ran. */
  searched?: string[];
```

Then replace the `comfy_unavailable` mapping:

```ts
  if (err instanceof ComfyUnavailableError) {
    return {
      kind: "comfy_unavailable",
      message: err.message,
      binary: err.binary,
      // Only when discovery ran. Absent is meaningful: it says the operator
      // named the binary, so the fix is that name, not the search path.
      ...(err.searched === undefined ? {} : { searched: err.searched }),
    };
  }
```

- [ ] **Step 6: Run tests and typecheck**

Run: `deno task test > /tmp/full3.log 2>&1; tail -6 /tmp/full3.log`
Expected: **170 passed**, 0 failed (Task 3 adds steps to an existing hooked file, so the top-level count does not move).
Run: `deno task typecheck` → zero errors.

- [ ] **Step 7: Commit**

```bash
but commit -b self-sufficient-cli-resolution -m "feat: name the searched paths when comfy is nowhere

ComfyUnavailableError gains a searched field and one extra message line,
and toolResult carries it to the wire -- without which a caller could not
see that discovery had run at all. Absent when COMFY_BIN named a binary:
nothing was searched, and saying otherwise sends the operator to the
wrong place.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Default `--output-directory` from the workspace

**Files:**
- Modify: `src/comfy/instance.ts` (new `withDefaultOutputDirectory`, `whichWorkspace`, and the `performLaunch` call site at `:951-991`)
- Modify: `tests/fixtures/fake-comfy` (one new append-only mode)
- Modify: `tests/fixtures/fake-comfy-dispatch` (a `which` arm)
- Modify: `tests/instance.test.ts`

**Interfaces:**
- Consumes: `LaunchOptions.workspace`, `comfyuiArgs`'s output array, `flagValue`, `OUTPUT_DIRECTORY_FLAG`, `JSON_MODE`, all already in `instance.ts`.
- Produces: module-private `withDefaultOutputDirectory(argv: string[], opts: LaunchOptions): Promise<string[]>`. Nothing outside `instance.ts` consumes it.

- [ ] **Step 1: Add the fixture mode**

In `tests/fixtures/fake-comfy`, add to the header comment:

```
#   $FAKE_COMFY_WHICH_PATH  workspace_path reported by the `which` mode. No
#                           default: an unset value reports null, so a launch
#                           that has not armed it derives no output directory.
#                           A fixed path under the shared /tmp would silently
#                           change every dispatcher-driven launch the moment
#                           anything created it -- this repo has already lost a
#                           session to a shared-tmpdir collision.
```

and a new case after `echo_path)`:

```sh
  which)
    # `comfy which`. Measured shape (ground truth #55): ok:true with
    # workspace_path and workspace_type -- and it succeeds even for a
    # workspace that does not exist, which is why the caller checks.
    if [ -n "$FAKE_COMFY_WHICH_PATH" ]; then
      printf '{"schema":"envelope/1","type":"envelope","ok":true,"command":"which","version":"0.0.0","where":null,"data":{"workspace_path":"%s","workspace_type":"recent"},"error":null}\n' "$FAKE_COMFY_WHICH_PATH"
    else
      echo '{"schema":"envelope/1","type":"envelope","ok":true,"command":"which","version":"0.0.0","where":null,"data":{"workspace_path":null,"workspace_type":"recent"},"error":null}'
    fi
    exit 0 ;;
```

- [ ] **Step 2: Add the dispatcher arm**

In `tests/fixtures/fake-comfy-dispatch`, add to the header comment:

```
#   $FAKE_COMFY_WHICH_MODE     mode for a `which` call (default: which)
```

and a case inside the `for arg` loop, after the `vary)` case:

```sh
    # `performLaunch` asks `comfy which` for the workspace so it can default
    # --output-directory. Defaulted like `notes` and `vary` rather than opt-in
    # like `launch`: nothing written before this call existed can make it, so
    # there is no earlier behaviour for a default to disturb.
    which)    FAKE_COMFY_MODE="${FAKE_COMFY_WHICH_MODE:-which}"; break ;;
```

- [ ] **Step 3: Write the failing tests**

Append to `tests/instance.test.ts` (add `FAKE_COMFY_WHICH_PATH` and `FAKE_COMFY_WHICH_MODE` to the `afterEach` delete list):

**Two things every test below depends on — get these wrong and the tests pass vacuously:**

1. **`serveReadyAfter(1)`, never `(0)`.** `serveReadyAfter(n)` 503s for the first `n` probes (`tests/instance.test.ts:191-195`). With `0`, `performLaunch`'s guard probe succeeds immediately and it returns `already_running` **before any CLI call** — so nothing launches and every assertion here is dead. Every existing launching test in the file uses `1` or more.
2. **`launchArgvOf`, never `argvOf`/`readFileSync`.** The fixture truncate-writes `$FAKE_COMFY_ARGV_OUT` on *every* invocation, and the new `which` call is awaited while `startLaunch` is fire-and-forget — so at the moment `launchInstance` returns, that file holds the **which** argv. `launchArgvOf` (added in Step 5a) polls for the line that actually names `launch`.

```ts
test("a launch defaults --output-directory to the workspace's own output dir", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mcp-comfyui-ws-"));
  const argvOut = join(workdir, "argv");
  process.env.COMFY_BIN = FAKE_COMFY_LOGGING;
  process.env.FAKE_COMFY_MODE = "launch";
  process.env.FAKE_COMFY_WHICH_PATH = ws;
  process.env.FAKE_COMFY_ARGV_OUT = argvOut;
  const port = serveReadyAfter(1);

  await launchInstance({ port, timeoutMs: 5_000, pollIntervalMs: 10 });

  const argv = await launchArgvOf(argvOut);
  expect(argv).toContain("--output-directory");
  expect(argv[argv.indexOf("--output-directory") + 1]).toBe(join(ws, "output"));
  rmSync(ws, { recursive: true, force: true });
});

test("an explicit workspace needs no `which` call", async () => {
  // opts.workspace is already the answer, so asking the CLI would be a
  // pointless extra invocation on a path that already takes seconds.
  const ws = mkdtempSync(join(tmpdir(), "mcp-comfyui-ws-"));
  const log = countingCli("launch");
  const port = serveReadyAfter(1);

  await launchInstance({ port, workspace: ws, timeoutMs: 5_000, pollIntervalMs: 10 });

  expect(await settledInvocations(log, 1)).toBe(1); // launch only
  rmSync(ws, { recursive: true, force: true });
});

test("a caller's own --output-directory suppresses the default entirely", async () => {
  const log = countingCli("launch");
  const port = serveReadyAfter(1);

  await launchInstance({
    port,
    args: { outputDirectory: join(workdir, "caller-chose-this") },
    timeoutMs: 5_000,
    pollIntervalMs: 10,
  });

  // No `which` call: the flag is already present, so there is nothing to derive.
  expect(await settledInvocations(log, 1)).toBe(1);
});

test("an extraArgs --output-directory also suppresses the default", async () => {
  // The design argues `extraArgs` wins by argument order rather than by a
  // check. That is a claim about a DIFFERENT code path from the typed option
  // above -- comfyuiArgs emits typed options first and extraArgs last -- so it
  // needs its own test or the property is unpinned.
  const log = countingCli("launch");
  const port = serveReadyAfter(1);

  await launchInstance({
    port,
    extraArgs: ["--output-directory", join(workdir, "via-extra-args")],
    timeoutMs: 5_000,
    pollIntervalMs: 10,
  });

  expect(await settledInvocations(log, 1)).toBe(1);
});

test("the --output-directory=value spelling is recognised too", async () => {
  // flagValue parses both forms; a check that only understood the
  // space-separated one would append a second, conflicting flag.
  const log = countingCli("launch");
  const port = serveReadyAfter(1);

  await launchInstance({
    port,
    extraArgs: [`--output-directory=${join(workdir, "equals-form")}`],
    timeoutMs: 5_000,
    pollIntervalMs: 10,
  });

  expect(await settledInvocations(log, 1)).toBe(1);
});

test("a workspace that does not exist is not turned into an output directory", async () => {
  // `comfy which` returns ok:true for a nonexistent workspace (ground truth
  // #55), so a try/catch alone would happily pass --output-directory
  // <nonexistent>/output. The existence check is what catches it.
  const argvOut = join(workdir, "argv");
  process.env.COMFY_BIN = FAKE_COMFY_LOGGING;
  process.env.FAKE_COMFY_MODE = "launch";
  process.env.FAKE_COMFY_WHICH_PATH = join(workdir, "no-such-workspace");
  process.env.FAKE_COMFY_ARGV_OUT = argvOut;
  const port = serveReadyAfter(1);

  await launchInstance({ port, timeoutMs: 5_000, pollIntervalMs: 10 });

  // launchArgvOf, not readFileSync: asserting `not.toContain` against the
  // which argv would pass no matter what the launch did.
  expect(await launchArgvOf(argvOut)).not.toContain("--output-directory");
});

test("a failing `which` leaves the launch untouched", async () => {
  const argvOut = join(workdir, "argv");
  process.env.COMFY_BIN = FAKE_COMFY_LOGGING;
  process.env.FAKE_COMFY_MODE = "launch";
  process.env.FAKE_COMFY_WHICH_MODE = "fail";
  process.env.FAKE_COMFY_ARGV_OUT = argvOut;
  const port = serveReadyAfter(1);

  // Legibility, never a precondition: this must not become a failed launch.
  const result = await launchInstance({ port, timeoutMs: 5_000, pollIntervalMs: 10 });

  expect(result.outcome).toBe("launched");
  expect(await launchArgvOf(argvOut)).not.toContain("--output-directory");
});

test("an already-running instance costs no `which` call", async () => {
  // The derivation sits after the early return, which is what keeps every
  // settledInvocations(log, 0) assertion in this file at zero.
  const log = countingCli("launch");
  const port = serveReadyAfter(1);

  await launchInstance({ port, timeoutMs: 5_000, pollIntervalMs: 10 });
  const after = await settledInvocations(log, 2);
  expect(after).toBe(2); // which + launch -- fail loudly if the baseline moved

  // The port now answers, so this second call short-circuits before any CLI.
  await launchInstance({ port, timeoutMs: 5_000, pollIntervalMs: 10 });

  expect(await settledInvocations(log, after)).toBe(after);
});
```

- [ ] **Step 3a: Add `launchArgvOf`, and re-point the existing launch-argv assertions**

This is not optional cleanup — without it, adding the `which` call **breaks
pre-existing tests in a way Step 6 would tell you to ignore.**

`tests/fixtures/fake-comfy:62` truncate-writes `$FAKE_COMFY_ARGV_OUT`
unconditionally, *above* the mode dispatch, so every invocation clobbers it.
The new `comfy which` call is awaited and `startLaunch` is fire-and-forget, so
when `launchInstance` returns the file holds the **which** argv. The file's
existing `written()` helper polls only `existsSync`, a guarantee the wrong call
now satisfies. Concretely: `tests/instance.test.ts:573`'s exact `toEqual` fails,
`:564-565`'s ordering check becomes `1 < -1` and fails, and `:477`, `:626`,
`:986` start passing **vacuously**.

Add beside `argvOf` (around `:220`):

```ts
/**
 * The argv of the LAUNCH invocation specifically.
 *
 * `performLaunch` now makes a `comfy which` call first, and the fixture
 * truncate-writes $FAKE_COMFY_ARGV_OUT on EVERY invocation — so the file
 * merely existing no longer proves the launch ran, and reading it too early
 * yields the which argv. Poll for the line that actually names `launch`.
 */
async function launchArgvOf(path: string, timeoutMs = 5_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(path)) {
      const argv = readFileSync(path, "utf8").trim().split(" ");
      if (argv.includes("launch")) return argv;
    }
    if (Date.now() >= deadline) {
      throw new Error(`the fake comfy never recorded a launch in ${path}`);
    }
    await sleep(5);
  }
}
```

Then re-point every launch-argv assertion from `argvOf(argvOut)` / `written(argvOut)`
to `launchArgvOf(argvOut)`. The sites, verified: **`:477`, `:552-553`, `:563-565`,
`:573`, `:597`, `:626`, `:971`, `:986`.**

Confirm the line numbers before editing — earlier steps in this task may have
shifted them. Search for `argvOf(` and `written(` rather than trusting the list.

- [ ] **Step 4: Run to verify they fail**

Run: `deno task test:one tests/instance.test.ts > /tmp/red4.log 2>&1; tail -30 /tmp/red4.log`
Expected: the defaulting tests FAIL — no `--output-directory` appears. The
re-pointed pre-existing assertions must still PASS at this point, since
`launchArgvOf` is strictly more precise than what it replaced.

- [ ] **Step 5: Implement in `instance.ts`**

Add near the other constants:

```ts
/**
 * Budget for the `comfy which` call that derives the output directory.
 *
 * `RunOptions` defaults to 120 s. Blocking a launch for two minutes on a call
 * measured as effectively instant would be wrong, and this call is optional —
 * failing fast and skipping the flag is strictly better than waiting.
 */
const WHICH_TIMEOUT_MS = 10_000;

/**
 * `comfy which`'s payload. `looseObject` and no enum on purpose:
 * `workspace_type` is a further open-string registry (non-negotiable #2), and
 * nothing here needs to read it.
 */
const WhichPayloadSchema = z.looseObject({
  workspace_path: z.string().nullable().optional(),
});
```

Add the two functions above `performLaunch`:

```ts
/**
 * The workspace to derive an output directory from, or undefined.
 *
 * `opts.workspace` short-circuits the CLI call: it is already the answer, and
 * asking anyway would add an invocation to every launch for nothing.
 */
async function whichWorkspace(opts: LaunchOptions): Promise<string | undefined> {
  if (opts.workspace !== undefined) return opts.workspace;
  try {
    const payload = WhichPayloadSchema.parse(
      await runComfy([JSON_MODE, "which"], { timeoutMs: WHICH_TIMEOUT_MS }),
    );
    return payload.workspace_path ?? undefined;
  } catch {
    // Every failure is survivable here — see withDefaultOutputDirectory.
    return undefined;
  }
}

/**
 * Give ComfyUI an explicit `--output-directory`, so the path it writes to
 * appears in its own `system.argv` and `outputs.ts` can resolve artifact URLs
 * against it (ground truth #54). Without it the flag is absent, `argv` says
 * nothing, and every local artifact comes back with no `local_paths` entry.
 *
 * The value is the directory ComfyUI would have used anyway, so nothing moves
 * for anyone — this makes an existing default legible, it does not relocate it.
 *
 * Skipped, silently and without a CLI call where possible, in three cases:
 * the caller already named one; no workspace could be determined; or the
 * workspace does not exist. The last is not hypothetical — `comfy which`
 * returns ok:true for a nonexistent workspace (ground truth #55), so a
 * try/catch alone would pass `--output-directory <nonexistent>/output`.
 *
 * This is legibility, never a precondition: it must never convert a launch
 * that would have worked into one that fails.
 *
 * One invariant is now narrower than its documentation: `validateComfyuiArgs`
 * runs in `launchInstance` BEFORE `performLaunch`, so the pair appended here
 * is never validated. `join(workspace, "output")` cannot be empty and the flag
 * is a literal, so nothing reachable is affected — but a future caller of this
 * function must not assume validation covers what it adds.
 */
async function withDefaultOutputDirectory(
  argv: string[],
  opts: LaunchOptions,
): Promise<string[]> {
  if (flagValue(argv, OUTPUT_DIRECTORY_FLAG) !== null) return argv;

  const workspace = await whichWorkspace(opts);
  if (workspace === undefined) return argv;
  if (!existsSync(workspace)) return argv;

  return [...argv, OUTPUT_DIRECTORY_FLAG, join(workspace, "output")];
}
```

Add the imports `instance.ts` needs: `import { existsSync } from "node:fs";` and
`import { join } from "node:path";`. **Do not touch the `./exec.ts` import** —
`instance.ts:5` already reads
`import { ComfyCliError, ComfyUnavailableError, runComfy } from "./exec.ts";`,
and adding `runComfy` again is a duplicate identifier. `z` is likewise already
imported at `:2`.

Then change the one line in `performLaunch` (after `contentionWarnings`, before `startLaunch`):

```ts
  const warnings = await contentionWarnings(opts, target, probeTimeoutMs);

  const launchArgs = await withDefaultOutputDirectory(argv, opts);
  const cli = startLaunch(launchArgv(launchArgs, opts.workspace), timeoutMs);
```

- [ ] **Step 6: Run the file, then update the invocation counts**

Run: `deno task test:one tests/instance.test.ts > /tmp/green4.log 2>&1; tail -40 /tmp/green4.log`

**First, fix the one pre-existing test that now stalls.** `tests/instance.test.ts:722`
("a CLI that never returns does not delay a ComfyUI that is already up") arms
`FAKE_COMFY_MODE = "hang"` (`exec sleep 30`) against the **raw** fixture, because
the file's `beforeEach` sets `COMFY_BIN = FAKE_COMFY`. The dispatcher's new
`which)` arm therefore never fires for it, the awaited `which` call lands in
`hang`, and it blocks the full `WHICH_TIMEOUT_MS = 10_000` against that test's
`expect(elapsed).toBeLessThan(1_500)`. `performLaunch` computes its deadline
*after* that call, so `timeoutMs: 2_000` cannot cut it short.

Insert immediately above that test's existing `process.env.FAKE_COMFY_MODE = "hang";`:

```ts
  // Point at the dispatcher so the new `which` call resolves to the instant
  // `which` mode. The `launch)` arm is opt-in and still falls through to
  // `hang`, which is what this test is about. This also stops the which child
  // overwriting $FAKE_COMFY_PID_OUT and making the kill target the wrong pid.
  process.env.COMFY_BIN = FAKE_COMFY_LOGGING;
```

Do **not** instead lower `WHICH_TIMEOUT_MS` — the fixture would still sleep.

**Then update the counts. Two classes of pre-existing test move, and only two:**

1. **The `settledInvocations` counts.** A launch that proceeds now makes two
   calls (`which`, then `launch`) instead of one.
2. **The launch-argv assertions** already re-pointed in Step 3a.

**Anything else that fails is a regression.** Stop and read it.

**Change BOTH arguments, not just the expected value.** `settledInvocations(log, expected)`
uses its first argument as the *wait target* (`tests/instance.test.ts:151-156`:
`while (invocations(log) < expected) await sleep(5); await sleep(60);`). Leaving
it at `1` satisfies the wait on the `which` line alone and then leans on a 60 ms
pause to catch the launch spawn — turning seven deterministic assertions into
flaky ones. So:

```ts
expect(await settledInvocations(log, 1)).toBe(1);   // before
expect(await settledInvocations(log, 2)).toBe(2);   // after -- BOTH numbers
```

**The rules, in precedence order:**

- Every `settledInvocations(log, 0)).toBe(0)` stays **0**. If one does not, the
  derivation is on the wrong side of the early return — fix the code, not the test.
- A launch where `opts.workspace` is set, or where `--output-directory` is
  already present, still makes **one** call: both short-circuit before the CLI.
  Do not blanket-increment.
- Every other launching assertion gains exactly one call per launch that
  proceeds: `1` → `2`, and `2` → `4` where two launches occur.

Derive each value from what that specific test does rather than applying a
blanket rule — the design doc's "~6" is imprecise; the real number is **7**, and
which 7 depends on the two short-circuits above.

Give each changed assertion a trailing comment:

```ts
  // +1: performLaunch asks `comfy which` to default --output-directory.
```

Re-run until green.

- [ ] **Step 7: Full suite and typecheck**

Run: `deno task test > /tmp/full4.log 2>&1; tail -6 /tmp/full4.log`
Expected: 0 failed. **Any failure outside `instance.test.ts` is a regression, not a count to update.**
Run: `deno task typecheck` → zero errors.

- [ ] **Step 8: Commit**

```bash
but commit -b self-sufficient-cli-resolution -m "feat: default --output-directory so local artifacts resolve

performLaunch now derives <workspace>/output and passes it explicitly, so
the path appears in ComfyUI's own system.argv and outputs.ts can resolve
/view URLs against it. Files land where ComfyUI would have written them
anyway -- this makes an existing default legible, it does not move it.

Skipped without a CLI call when the caller named a directory or set a
workspace; skipped after the call when the workspace does not exist,
because comfy which returns ok:true for a nonexistent one (ground truth
#55) and a try/catch alone would not catch it.

Placed after performLaunch's already-running early return, so a launch
that never happens costs no extra invocation -- every
settledInvocations(log, 0) assertion is unchanged. The launching ones
each gain exactly one call.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Supersede the now-stale PATH advice

**Files:**
- Modify: `src/comfy/instance.ts` — `launchDiagnosis`'s self-exec arm (locate it by searching for `re-execs itself`; earlier tasks in this plan shift the line numbers)
- Modify: `tests/instance.test.ts` — the single self-exec test at ~`:786-817`. **Not** `~1003-1033`: those are the `not_in_workspace`/`port_in_use` message tests, which never reach `launchDiagnosis`'s self-exec arm at all.
- Modify: `CHANGELOG.md` (the `[Unreleased]` entry added by PR #39)

**Interfaces:**
- Consumes: nothing new.
- Produces: no signature change; message text only.

- [ ] **Step 1: Update the message**

`launchDiagnosis` currently ends its self-exec arm by telling the operator to set `PATH` in their MCP client's entry. That is now this server's job. Replace that final sentence with:

```ts
      `This server prepends the resolved binary's own directory to the child's PATH, so ` +
      `reaching this message means the repair did not help: the re-exec looked for ` +
      `\`${missing}\` and a directory containing it was not found. Check that the name ` +
      `comfy-cli re-execs matches the binary COMFY_BIN names.`
```

Keep every earlier sentence — the `FileNotFoundError` line, the explanation of the re-exec, and the note that `COMFY_BIN` cannot fix comfy-cli's own lookup — unchanged.

- [ ] **Step 2: Pin the new wording — nothing currently does**

Verified: the PR #39 test at `tests/instance.test.ts:786-817` asserts only
`toContain("PATH")`, `toContain("re-exec")`,
`toContain("No such file or directory: 'comfy'")`, `toContain("COMFY_BIN")`,
and two negatives. **All six still hold against the new wording**, so no
assertion needs changing — and that means the new sentence would ship pinned by
nothing. Add one:

```ts
  // The advice is no longer "set PATH yourself" -- the server does that now,
  // so reaching this message means the repair was tried and did not help.
  expect(message).toContain("prepends the resolved binary's own directory");
```

Add it to that same test rather than creating a new one; it is an assertion
about the same message.

- [ ] **Step 3: Revise the CHANGELOG entry**

PR #39's `[Unreleased]` entry describes setting `PATH` in the client config as the fix. Append one sentence to that entry rather than rewriting it:

```markdown
  **Superseded in the same release:** the server now repairs the child's `PATH`
  itself (see the auto-discovery entry below), so this diagnosis should be
  unreachable in normal use — and if it does fire, it now says that the repair
  was attempted and did not help, which is a different and more useful fact.
```

- [ ] **Step 4: Run and commit**

Run: `deno task test:one tests/instance.test.ts > /tmp/g5.log 2>&1; tail -6 /tmp/g5.log`
Run: `deno task typecheck`

```bash
but commit -b self-sufficient-cli-resolution -m "docs: supersede the manual PATH advice PR #39 added

PR #39 told operators to set PATH in their MCP client's entry. The server
now does that itself, so reaching that message means the repair was tried
and did not help -- a different and more useful fact than the original
wording conveyed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Report the resolution in `comfy_status`

**Files:**
- Modify: `src/tools.ts` (a `cliBody` helper and the `comfy_status` handler at `:1482-1498`)
- Modify: `tests/server.test.ts`

**Interfaces:**
- Consumes: `resolveComfyBinary`, `defaultBinaryDeps`, `ResolvedBinary` from Task 1.
- Produces: a top-level `cli` key on `comfy_status`'s answer: `{ path: string, source: BinarySource, path_repaired: boolean, searched?: string[] }`.

**Note on placement:** this test goes in `tests/server.test.ts`, **not** `tests/tools.test.ts`. `tools.test.ts` has zero `comfy_status` coverage and is one of only two test files that does not set `COMFY_BIN` — a discovery assertion there would run against the developer's real machine.

- [ ] **Step 1: Write the failing test**

Add to `tests/server.test.ts`, alongside the existing `comfy_status` block:

```ts
test("comfy_status reports which comfy it resolved, and how", async () => {
  const body = await ok(await connect(), "comfy_status");

  const cli = body["cli"] as Record<string, unknown>;
  // The suite points COMFY_BIN at the fixture, so this is the explicit arm.
  expect(cli["source"]).toBe("COMFY_BIN");
  expect(typeof cli["path"]).toBe("string");
  expect(typeof cli["path_repaired"]).toBe("boolean");
  // Nothing was searched, because naming a binary suppresses discovery.
  expect(cli["searched"]).toBeUndefined();
});

test("comfy_status reports the cli block even when nothing is running", async () => {
  // This is exactly when an operator most needs to know which binary was found.
  nothingRunning();
  const body = await ok(await connect(), "comfy_status");

  expect(body["running"]).toBe(false);
  expect((body["cli"] as Record<string, unknown>)["source"]).toBe("COMFY_BIN");
});
```

Both use this file's existing conventions: `ok(await connect(), "comfy_status")`, bracket-notation body access, and the `nothingRunning()` helper already used by "nothing running is a successful answer, not a tool error". Do not introduce a new down-host fixture — `nothingRunning()` is the established one.

- [ ] **Step 2: Run to verify it fails**

Run: `deno task test:one tests/server.test.ts > /tmp/red6.log 2>&1; tail -20 /tmp/red6.log`
Expected: FAIL — `answer.cli` is undefined.

- [ ] **Step 3: Add `cliBody` and the key**

In `src/tools.ts`, add near the other `*Body` helpers:

```ts
/**
 * Which comfy this server resolved, and how it got there.
 *
 * Reported because every other inference this server makes is reported beside
 * its answer — `host_source`, `object_info.stale`, `target.local`. Discovery
 * should not be the one piece of magic a caller cannot see.
 */
function cliBody(resolved: ResolvedBinary): Record<string, unknown> {
  return {
    path: resolved.path,
    source: resolved.source,
    path_repaired: resolved.childPath !== undefined,
    ...(resolved.searched === undefined ? {} : { searched: resolved.searched }),
  };
}
```

and add the key to the handler, after the spread so it is top-level in both arms:

```ts
        return {
          target: targetBody(resolved),
          ...(detection.running
            ? instanceBody(detection)
            : {
                running: false,
                url: detection.url,
                host: detection.host,
                port: detection.port,
                reason: detection.reason,
              }),
          cli: cliBody(resolveComfyBinary(defaultBinaryDeps())),
        };
```

Add to `tools.ts`'s imports:

```ts
import { defaultBinaryDeps, resolveComfyBinary, type ResolvedBinary } from "./comfy/binary.ts";
```

- [ ] **Step 4: Update the tool description**

`comfy_status`'s description lists what it reports. Add one clause so the surface stays documented:

> "…and the output and input directories it was started with, plus which `comfy` binary this server resolved and how it found it."

- [ ] **Step 5: Run, typecheck, commit**

Run: `deno task test > /tmp/full6.log 2>&1; tail -6 /tmp/full6.log`
Run: `deno task typecheck`

```bash
but commit -b self-sufficient-cli-resolution -m "feat: report the resolved comfy binary in comfy_status

A top-level cli block naming the path, how it was found, and whether the
child PATH was repaired -- in both the running and not-running arms,
since a down instance is exactly when knowing which binary was found
matters most.

Tested in server.test.ts rather than tools.test.ts: the latter has no
comfy_status coverage and is one of two files that does not set
COMFY_BIN, so a discovery assertion there would read the real machine.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Documentation

**Files:**
- Modify: `README.md` (the environment-variable table)
- Modify: `CLAUDE.md` (the `src/comfy/` architecture map)
- Modify: `CHANGELOG.md` (`[Unreleased]`)
- Modify: `docs/comfy-cli-ground-truth.md` (entries #54 and #55)
- Modify: `docs/plans/2026-09-19-self-sufficient-cli-resolution-design.md` (status line)

- [ ] **Step 1: README — `COMFY_BIN` becomes an override**

Change its row to say it is optional, and add a short paragraph under the table:

```markdown
`COMFY_BIN` is an **override, not a requirement.** With it unset the server
looks for `comfy` on `PATH`, then in `~/.local/bin`, uv's tool directory,
`/opt/homebrew/bin` and `/usr/local/bin`. Setting it wins absolutely and
disables that search — a named binary that is missing is reported as an error
rather than quietly replaced.

The server also **prepends the resolved binary's directory to the `PATH` it
gives its children**, because `comfy launch --background` re-execs itself by
bare name. A GUI-launched MCP client inherits a minimal `PATH`, so without this
auto-launch fails there even though every other command works.
```

- [ ] **Step 2: CLAUDE.md — the architecture map**

Add one line in the `src/comfy/` block, before `envelope.ts`:

```
  binary.ts         which comfy to spawn, and the PATH its child needs
```

- [ ] **Step 3: CHANGELOG — the `[Unreleased]` entry**

```markdown
- **The server finds comfy-cli itself, and repairs the `PATH` its children get.**
  `COMFY_BIN` is now an override rather than a requirement: with it unset the
  server checks `PATH`, then `~/.local/bin`, uv's tool directory, and the two
  Homebrew prefixes. Set, it wins absolutely and never falls back — a named
  binary that is missing is an error, not an invitation to substitute one.

  The `PATH` repair is the part that fixes a real failure. `comfy launch
  --background` re-execs *itself* by bare name, so a GUI-launched MCP client —
  which inherits `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else — could set
  `COMFY_BIN` correctly and still have every auto-launch die with
  `FileNotFoundError: … 'comfy'`, while every other subcommand worked. The
  binary's directory is *prepended*, so comfy-cli's re-exec finds the binary
  this server resolved rather than some other one earlier on the path.

  A launch now also passes `--output-directory <workspace>/output`, which is
  where ComfyUI would have written anyway — the point is that the path appears
  in its `system.argv`, so `outputs.ts` can resolve `/view` URLs and
  `local_paths` stops coming back empty for local runs. `comfy_status` gained a
  `cli` block reporting which binary was resolved and how.
```

- [ ] **Step 4: Ground truth #54 and #55**

Append to `docs/comfy-cli-ground-truth.md`:

```markdown
54. **`--output-directory` passed after the `--` separator reaches `main.py` and appears in `system.argv`.** Measured 2026-09-19 against ComfyUI 0.30.2. `comfy --skip-prompt --json launch --background -- --output-directory /tmp/measured-output` produced, from the instance's own `/system_stats`, `argv: ['main.py', '--output-directory', '/tmp/measured-output', '--enable-manager', '--enable-manager']` — space-separated, the form `flagValue` parses, and ahead of comfy-cli's own appended flags. `comfy_status` then reported that directory where it had reported `null` for every previous launch. This is the whole mechanism by which `resolveArtifactPath` can turn a `/view` URL into a file path for a locally launched instance.

55. **`comfy which` succeeds for a workspace that does not exist.** Measured 2026-09-19. Bare, it returns `ok:true` with `data: {workspace_path: "<abs path>", workspace_type: "recent"}`. With `--workspace /tmp/nonexistent-ws-xyz` it **still** returns `ok:true`, with `{workspace_path: "/tmp/nonexistent-ws-xyz", workspace_type: "specified"}`. So a caller deriving a path from `which` cannot rely on a thrown error to catch a bad workspace and must check the directory exists itself — `src/comfy/instance.ts`'s `withDefaultOutputDirectory` does. `workspace_type` is a further **open string registry** under non-negotiable #2: two values are observed here, the set is not published, and nothing should enumerate it.
```

- [ ] **Step 5: Flip the design doc's status line**

```markdown
**Status:** implemented on 2026-09-19 in PR #NN. Kept as the record of the
decisions and the ground truth behind them, not as a description of the code;
where the two differ, the code, `CLAUDE.md` and
`docs/comfy-cli-ground-truth.md` are current.
```

- [ ] **Step 6: PII sweep — this repo is public**

Run:

```bash
git ls-files | xargs grep -InE '/Users/[a-z]|/home/[a-z]|100\.(6[4-9]|[7-9][0-9]|1[0-2][0-9])\.' | grep -v '100\.64\.0\.1'
```

Expected: no output. Sweep every tracked file, never just `*.md` — the 2026-08-22 sweep missed a tailnet address in a `.ts` file for exactly that reason.

- [ ] **Step 7: Commit**

```bash
but commit -b self-sufficient-cli-resolution -m "docs: record discovery, PATH repair, and ground truth #54-#55

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Verify against a live ComfyUI, then open the PR

The suite fakes `comfy` at its first link, so no test in this repo can prove the success criteria that matter. These must be measured.

**Prerequisite:** `deno task build` first, or the harnesses test the previous build.

- [ ] **Step 1: Rebuild both artifacts**

```bash
deno task build && deno task compile
```

**Two facts this task relies on were measured on 2026-09-19 and need no re-checking:**
`comfy stop` exists and works (`{"ok":true,"command":"stop",…,"stopped":true}`),
and `image_z_image_turbo` is a real local workflow that renders a 1024×1024 PNG
on this machine in about 70 s from a cold start. Every other live harness in
this repo uses `image_chroma1_radiance_text_to_image`; that one renders on the
*remote* box and is slower here.

- [ ] **Step 2: Create the harness — no existing one can do this**

All three existing harnesses force `MCP_COMFYUI_AUTO_LAUNCH=0` (CLAUDE.md,
Testing), so none can test a criterion whose entire point is auto-launch. This
one deliberately leaves auto-launch **on**, which makes it the only harness here
that can start a GPU process. Say so at the top of the file.

Create `scripts/smoke-autolaunch.mjs`:

```js
// Prove the server finds comfy-cli and launches ComfyUI with NOTHING supplied.
//
// Unlike every other harness here, this one leaves MCP_COMFYUI_AUTO_LAUNCH at
// its default (on) -- it exists to test auto-launch, so disabling it would
// test nothing. It WILL start a GPU process. Run `deno task build && deno task
// compile` first, or you are testing the previous build.
//
// Usage: node scripts/smoke-autolaunch.mjs [workflow]
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "dist", "mcp-comfyui");
const WORKFLOW = process.argv[2] ?? "image_z_image_turbo";

// The whole point: a GUI client's bare launchd PATH, no COMFY_BIN.
const ENV = { HOME: homedir(), PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

const proc = spawn(BIN, [], { stdio: ["pipe", "pipe", "pipe"], env: ENV });
proc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

let buf = "";
let nextId = 1;
const pending = new Map();
proc.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    const r = pending.get(m.id);
    if (r) { pending.delete(m.id); r(m); }
  }
});
const rpc = (method, params) =>
  new Promise((res) => {
    const id = nextId++;
    pending.set(id, res);
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
const call = async (name, args) => {
  const m = await rpc("tools/call", { name, arguments: args });
  const text = m.result?.content?.[0]?.text ?? "";
  try { return { isError: m.result?.isError ?? false, data: JSON.parse(text) }; }
  catch { return { isError: true, data: { raw: text } }; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "smoke-autolaunch", version: "0" },
});

// Criterion 4: the resolution is reported, and it came from discovery.
const status = await call("comfy_status", {});
check("comfy_status reports a cli block", status.data.cli !== undefined);
check("the binary was discovered, not configured", status.data.cli?.source === "discovered",
  `source=${status.data.cli?.source}`);
check("the child PATH was repaired", status.data.cli?.path_repaired === true);
check("nothing is running yet", status.data.running === false,
  "stop ComfyUI first -- `comfy stop` -- or this proves nothing");

// Criterion 1: a cold auto-launch with an empty env.
const started = Date.now();
const run = await call("run_workflow", { workflow: WORKFLOW, wait: false });
check("run_workflow was accepted", !run.isError, JSON.stringify(run.data).slice(0, 300));
const promptId = run.data.prompt_id;
check("a prompt_id came back", typeof promptId === "string");
if (promptId === undefined) { proc.kill(); process.exit(1); }

let job;
for (let n = 0; n < 120; n++) {
  await sleep(5000);
  job = await call("get_job", { prompt_id: promptId });
  if (job.data.terminal === true) break;
}
const elapsed = ((Date.now() - started) / 1000).toFixed(1);
check("the job completed", job?.data.status === "completed", `status=${job?.data.status} in ${elapsed}s`);

// Criterion 3: local_paths is populated and the file really exists.
const localPaths = job?.data.outputs?.local_paths ?? {};
const paths = Object.values(localPaths);
check("local_paths is populated", paths.length > 0, JSON.stringify(localPaths).slice(0, 300));
for (const p of paths) {
  check(`the artifact exists: ${p}`, existsSync(p) && statSync(p).size > 0);
}

proc.kill();
console.log(failures.length === 0 ? "\nAll checks passed." : `\n${failures.length} FAILED`);
process.exit(failures.length === 0 ? 0 : 1);
```

- [ ] **Step 3: Stop ComfyUI, then run it (criteria 1, 3 and 4)**

```bash
comfy --skip-prompt --json stop
node scripts/smoke-autolaunch.mjs
```

Expected: every check passes. `cli.source` must be `discovered` — if it reports
`COMFY_BIN` or `PATH`, the harness leaked an environment variable and is not
testing what it claims.

This is the configuration that failed before this work. It must now succeed with
nothing supplied.

- [ ] **Step 4: Criterion 2 — an explicit bad `COMFY_BIN` still fails**

With `COMFY_BIN=/nope/comfy`, any tool that shells out must fail `comfy_unavailable` naming `/nope/comfy`, with **no** `searched` key. Discovery must not rescue it.

Criterion 4 is already covered by Step 3's harness (`cli.source`, `cli.path`,
`cli.path_repaired`) and, for the not-running arm, by Task 6's fixture test.

- [ ] **Step 5: Record the results**

Add a **new dated entry** to CLAUDE.md's "Verified end to end" section stating what was run and what was observed — the timings, the `cli.source`, the artifact path and its size. Redact home paths to `~/`.

**Do not edit an older entry.** Dated entries are measurements; rewriting one turns a record into a fiction, which is the same failure the redaction rule exists to prevent.

- [ ] **Step 6: Delete this plan file, then commit**

Per the project workflow, `IMPLEMENTATION_PLAN.md` is removed once all stages are done. Delete it **before** the final commit — the previous ordering committed first and then deleted, which shipped the plan file in the PR.

```bash
rm IMPLEMENTATION_PLAN.md
but commit -b self-sufficient-cli-resolution -m "docs: record the live verification of auto-discovery

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7: Hand back to the main session for push and PR — do not do this yourself**

**If you are a subagent executing this plan, stop here and report.** The standing project rule is that sub-agents may commit locally but never push or open pull requests; that stays with the main session.

The main session then runs:

```bash
but push self-sufficient-cli-resolution
but pr new self-sufficient-cli-resolution -F <a file you write with the PR body>
```

`but pr new` takes the title from the file's **first line** and the body from the rest; it also pushes first, so no separate `but push` is strictly needed. The PR body must state which success criteria were measured **live** and which are covered only by fixtures. **Do not use `but land`** — it pushes straight to `origin/main`, skipping review and CI, and `but undo` cannot un-push it.
