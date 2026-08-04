import { resolve } from "node:path";

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
 * Where ComfyUI Desktop keeps this user's saved workflows. The 22 files there
 * are what every measurement in the implementation plan was taken against.
 */
export const DEFAULT_WORKFLOW_DIR = "/Users/lawls/ComfyUI-Shared/user/default/workflows";

/** Colon-separated, ordered, like `PATH`. */
export const WORKFLOW_DIRS_ENV = "MCP_COMFYUI_WORKFLOW_DIRS";

/**
 * The directories to scan for workflow files, in the operator's own order.
 *
 * Order is preserved and load-bearing: `workflows/discover.ts` gives the first
 * root's copy of a colliding filename the bare, unqualified name, so this list
 * is a precedence order rather than a set.
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

  return uniqueRoots(segments.length > 0 ? segments : [DEFAULT_WORKFLOW_DIR]);
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
