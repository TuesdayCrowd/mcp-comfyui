import { basename, dirname } from "node:path";

/**
 * What a path that came out of `comfy` means.
 *
 * Two rules live here, and both are here for the same reason: more than one
 * module has to agree about them, and a copy of either that drifts is a bug
 * nobody sees. `comfy/target.ts` exists because exactly that already happened
 * once with host resolution.
 *
 * - **Artifact paths versus artifact URLs.** `workflows/run.ts` and
 *   `comfy/jobs.ts` both hand back the artifacts of a run, and a caller that
 *   asks `run_workflow` and then `get_job` about the same job must not be told
 *   the same two strings mean different things.
 * - **Which workflow paths are this server's own temp copies.** `run` submits a
 *   copy and deletes it; `jobs` then reports that dead path back as the job's
 *   workflow.
 */

/**
 * `http` and `https`, case-insensitively — a URI scheme is case-insensitive,
 * and nothing else counts. This is the CLI's own rule, not an inference:
 * `docs/json-output.md:253` says to treat any non-`http(s)` value as a
 * filesystem path, because on a loopback host with a resolvable workspace the
 * CLI emits absolute paths and otherwise emits `/view?...` URLs.
 *
 * Deliberately not `new URL()`: that parses a Windows path like `C:\out.png` as
 * a URL with protocol `c:` and would file it as something to fetch.
 */
const HTTP_URL = /^https?:\/\//i;

/**
 * The artifacts of a run, kept apart by kind. One merged list would leave every
 * caller re-deriving the rule above, and getting it wrong means either opening a
 * URL as a file or fetching a path over HTTP.
 */
export interface ClassifiedOutputs {
  /** Artifacts on this machine's filesystem, openable directly. */
  files: string[];
  /** Artifacts behind `http(s)`, which have to be fetched. */
  urls: string[];
}

/** Whether an artifact has to be fetched rather than opened. */
export function isArtifactUrl(value: string): boolean {
  return HTTP_URL.test(value);
}

/** Split one `outputs[]` array into the two kinds it mixes. */
export function classifyOutputs(outputs: readonly string[]): ClassifiedOutputs {
  const files: string[] = [];
  const urls: string[] = [];
  for (const output of outputs) {
    (isArtifactUrl(output) ? urls : files).push(output);
  }
  return { files, urls };
}

/**
 * How `workflows/setSlots.ts` names the private directory it copies a workflow
 * into. Exported so that the one module that creates these paths and the one
 * that has to recognise them cannot disagree about the spelling.
 */
export const PREPARED_COPY_PREFIX = "mcp-comfyui-apply-";

/**
 * Whether a path is one of this server's own prepared copies.
 *
 * It matters because the copy does not outlive the run. `comfy run` records the
 * absolute path it was handed as the job's workflow (`run/loader.py` resolves
 * it, `run/__init__.py` writes it to the state file), `comfy jobs` reports it
 * back, and `runWorkflow` deletes it in its `finally`. So for exactly the jobs
 * this server submitted — and only those — the recorded path is a UUID
 * directory that is already gone.
 *
 * Matched on the parent directory rather than the file, because the copy keeps
 * the original workflow's filename; the directory is the part this server named.
 */
export function isPreparedCopy(path: string): boolean {
  return basename(dirname(path)).startsWith(PREPARED_COPY_PREFIX);
}
