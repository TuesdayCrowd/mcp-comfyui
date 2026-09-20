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
