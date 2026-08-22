import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Operator-facing configuration.
 *
 * Deliberately not a framework. It is a handful of pure functions over an
 * environment record, because every setting this server has so far is one an
 * operator sets once in an MCP client's config block and never touches again.
 * Later tasks add to it; nothing here should grow a file format, a schema or a
 * merge order until something actually needs one.
 *
 * Every function takes the environment as an argument rather than reading
 * `process.env` at module scope. That keeps them testable without mutating
 * global state, and it is the same reason `comfy/exec.ts` passes `env`
 * explicitly to every spawn (landmine #13).
 */

/** What `process.env` is, without depending on `@types/node` globals at a call site. */
export type Environment = Record<string, string | undefined>;

/**
 * Where ComfyUI Desktop keeps the current user's saved workflows.
 *
 * Derived from `homedir()` rather than written out. It used to be an absolute
 * path with the developer's own username in it, which was two bugs wearing one
 * coat: it published that username to a public registry, and it made the
 * default point at a directory that exists on exactly one machine — so every
 * other install of this package silently scanned nothing. The README has
 * always documented the default as `~/ComfyUI-Shared/…`; this is the code
 * finally agreeing with it.
 *
 * `homedir()` is read once at module load, which is the same lifetime the
 * literal had. Nothing here consults `$HOME` directly, so a test that wants a
 * different root sets {@link WORKFLOW_DIRS_ENV} instead.
 */
export const DEFAULT_WORKFLOW_DIR = join(homedir(), "ComfyUI-Shared", "user", "default", "workflows");

/** Colon-separated, ordered, like `PATH`. */
export const WORKFLOW_DIRS_ENV = "MCP_COMFYUI_WORKFLOW_DIRS";

/**
 * Where a workflow this server creates is written.
 *
 * Its own directory rather than one of the operator's, because the two have
 * different owners: the roots in {@link WORKFLOW_DIRS_ENV} hold files a person
 * made, and one of them is a directory ComfyUI Desktop manages. Fetched
 * templates are this server's, disposable, and must never be mistaken for
 * either.
 */
export const CREATED_DIR_ENV = "MCP_COMFYUI_CREATED_DIR";

/**
 * Every setting this server has, named in one place.
 *
 * They live here rather than beside the code that reads them because the names
 * are the operator's interface: they are what goes in an MCP client's config
 * block, what the documentation tabulates, and what an error message has to
 * quote to be actionable. `comfy/instance.ts` needs {@link WORKSPACE_ENV} for
 * exactly that last reason, and a second copy of the spelling is how the error
 * message and the reader would eventually disagree.
 */
/** Where ComfyUI is. Absent means the library default, `127.0.0.1`. */
export const HOST_ENV = "MCP_COMFYUI_HOST";
export const PORT_ENV = "MCP_COMFYUI_PORT";
/** Where the `/object_info` cache lives. Absent means `~/.cache/mcp-comfyui`. */
export const CACHE_DIR_ENV = "MCP_COMFYUI_CACHE_DIR";
/**
 * The ComfyUI directory `comfy launch` should start from, passed as the Typer
 * root flag `--workspace`. Absent lets comfy resolve its own default or recent
 * workspace, which is what a user who has run `comfy install` will want.
 */
export const WORKSPACE_ENV = "MCP_COMFYUI_WORKSPACE";
/** May this server start ComfyUI when a tool needs one? Default: yes. */
export const AUTO_LAUNCH_ENV = "MCP_COMFYUI_AUTO_LAUNCH";
/** May a *model* start one, with startup flags of its own? Default: no. */
export const ALLOW_LAUNCH_ENV = "MCP_COMFYUI_ALLOW_LAUNCH";

/** The spellings of yes and no, so no two settings disagree about them. */
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

/**
 * One operator setting, or `undefined` when they said nothing.
 *
 * An empty or all-blank value reads as unset, exactly as an empty
 * {@link WORKFLOW_DIRS_ENV} does: a shell that exports a variable it never
 * assigned produces `""`, and that means silence rather than an instruction. It
 * is also what keeps an empty host out of `resolveHost`, which would otherwise
 * throw a bare `TypeError` from deep inside the library.
 */
export function setting(env: Environment, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/**
 * A boolean setting.
 *
 * Unrecognised values are **refused**, not read as false. A setting is only
 * worth having if an operator can tell whether it took effect, and silently
 * treating `MCP_COMFYUI_AUTO_LAUNCH=maybe` as off is precisely how someone ends
 * up believing they configured something they did not. Same fail-fast reasoning
 * as the port check.
 *
 * @throws {Error} the value is neither a yes nor a no.
 */
export function flag(env: Environment, name: string, fallback: boolean): boolean {
  const value = setting(env, name)?.toLowerCase();
  if (value === undefined) return fallback;
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  throw new Error(
    `${name}=${JSON.stringify(env[name])} is not a yes or a no ` +
      `(accepted: ${[...TRUE_VALUES].join(", ")}, ${[...FALSE_VALUES].join(", ")}).`,
  );
}

/**
 * The directories to scan for workflow files: the operator's own configured
 * roots, in their given order, followed unconditionally by this server's own
 * {@link createdWorkflowDir} — appended regardless of what the operator
 * configured, not merely when they configured nothing.
 *
 * Order is preserved and load-bearing: `workflows/discover.ts` gives the first
 * root's copy of a colliding filename the bare, unqualified name, so this list
 * is a precedence order rather than a set. The created directory is placed
 * last within that order for the same reason — see the comment on its
 * `uniqueRoots` call below.
 *
 * Paths are resolved to absolute so that a relative entry cannot make a
 * reported workflow path depend on the working directory an MCP client happened
 * to spawn the server in. Resolution is lexical — `realpath` is deliberately not
 * used, because it would resolve `/var` to `/private/var` on macOS and hand the
 * operator back a path that is not the one they configured.
 *
 * Duplicates are dropped. A root repeated in the config would otherwise list
 * every workflow in it twice and then force name disambiguation onto two
 * entries that are the very same file.
 *
 * An unset, empty or all-blank value falls back to the default. A shell that
 * exports an unset variable produces `""`, and that means the operator said
 * nothing — not that they want no directory searched at all, which would leave
 * the server with nothing to do and no message saying why.
 */
export function workflowRoots(env: Environment = process.env): string[] {
  const configured = env[WORKFLOW_DIRS_ENV] ?? "";
  // Segments are trimmed so `"/a : /b"` behaves, at the cost of not supporting a
  // directory whose name begins or ends with a space. That trade is worth
  // making once and writing down: the first is a plausible typo in a JSON
  // config block, the second is not a directory anyone has.
  const segments = configured
    .split(":")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  // The created directory goes LAST, and that placement is the whole guarantee
  // that a fetched `portrait.json` cannot displace an operator's own. Order
  // here is a precedence order (see the doc comment above): `discover.ts` gives
  // the first root's copy of a colliding filename the bare, unqualified name.
  // `uniqueRoots` drops it if the operator already listed it, keeping their
  // position rather than this one.
  return uniqueRoots([
    ...(segments.length > 0 ? segments : [DEFAULT_WORKFLOW_DIR]),
    createdWorkflowDir(env),
  ]);
}

/**
 * The directory created workflows are written to, absolute.
 *
 * `~/.local/share` rather than the cache directory: a fetched workflow is
 * something a caller may go on to parameterise and rerun, so losing it to a
 * cache sweep would lose work. Nothing creates this directory — the first
 * write does, so a server that never creates a workflow leaves nothing behind.
 */
export function createdWorkflowDir(env: Environment = process.env): string {
  return resolve(setting(env, CREATED_DIR_ENV) ?? join(homedir(), ".local", "share", "mcp-comfyui", "workflows"));
}

/** Resolve to absolute and drop repeats, keeping first-seen order. */
export function uniqueRoots(roots: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const root of roots) {
    const absolute = resolve(root);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    ordered.push(absolute);
  }
  return ordered;
}
