import { statSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { authority, isLocalAddress, type InterfaceAddresses } from "./target.ts";

/**
 * What a path that came out of `comfy` means.
 *
 * Three rules live here, and all three are here for the same reason: more than
 * one module has to agree about them, and a copy of any of them that drifts is
 * a bug nobody sees. `comfy/target.ts` exists because exactly that already
 * happened once with host resolution.
 *
 * - **Artifact paths versus artifact URLs.** `workflows/run.ts` and
 *   `comfy/jobs.ts` both hand back the artifacts of a run, and a caller that
 *   asks `run_workflow` and then `get_job` about the same job must not be told
 *   the same two strings mean different things.
 * - **When a `/view` URL also names a file on this machine.** Both of those
 *   modules report URLs a caller would otherwise have to fetch to look at.
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

// --- /view URLs that are also files on this machine ----------------------

/**
 * The only path a ComfyUI artifact URL takes. Matched exactly: `/api/view` is
 * the frontend's own prefix and is not what the CLI emits, and a URL this
 * server does not recognise must be left as a URL rather than guessed at.
 */
const VIEW_PATH = "/view";

/** `?type=` values, and the directory each one names. */
const OUTPUT_TYPE = "output";
const INPUT_TYPE = "input";

/**
 * Enough of a running ComfyUI to say where its artifacts live.
 *
 * A structural subset of `comfy/instance.ts`'s `RunningInstance`, which
 * satisfies it as written. Declared here rather than imported so that this
 * module — which `workflows/run.ts` and `comfy/jobs.ts` both depend on — does
 * not acquire a dependency on instance detection for the sake of four fields.
 */
export interface ArtifactLocation {
  /** The resolved connect host, as `detectInstance` reports it. */
  host: string;
  port: number;
  /**
   * Where this instance writes finished artifacts, recovered from its own
   * `argv`. `null` when it was not started with `--output-directory`, in which
   * case nothing here can say where its files are.
   */
  outputDirectory: string | null;
  /** Where it reads uploads from. `null` on the same terms. */
  inputDirectory: string | null;
}

/**
 * The local file a `/view` URL names, or `null` when there demonstrably is not
 * one.
 *
 * ## Why this exists when `comfy` has its own version of it
 *
 * comfy-cli already tries (`execution.py:352-371`) and cannot succeed here. It
 * resolves against the **workspace's** output directory, and this machine's
 * running ComfyUI is Desktop-managed: it writes to
 * `/Users/lawls/ComfyUI-Shared/output` while any workspace's own output
 * directory is `<install>/output`. Two genuinely different directories, so
 * `comfy --workspace <install> run … --json` returns a URL no matter what the
 * workspace is set to. This resolves against the directory the instance that
 * *actually ran the job* reported in `/system_stats`, which is strictly better
 * information than a workspace's assumption — and is why nothing here reads
 * `MCP_COMFYUI_WORKSPACE`.
 *
 * ## What it refuses, and why each refusal is not caution but correctness
 *
 * - **An instance on another machine** — the load-bearing one. `outputDirectory`
 *   is a path in *that* machine's filesystem, and this function's last step is
 *   to ask whether the file is really there, on *this* one. Two Unix boxes
 *   sharing a layout — `/home/me/ComfyUI/output` on both — would therefore hand
 *   back a local path naming a completely different image, or one that does not
 *   exist as far as the caller is concerned. Measured against the live remote,
 *   the accident that hides this is Windows: `F:\Dev\ComfyUI\output` is not
 *   `isAbsolute` under POSIX, so the containment check below declines it for
 *   the wrong reason. `isLocalAddress` is the right one, and it is checked
 *   first. See `comfy/target.ts` for why it fails closed.
 * - **Not this instance's address** — only the instance that ran the job knows
 *   where it writes. A `/view` URL on another host names a directory this
 *   server has never seen.
 * - **A `type` with no root** — `output` and `input` are the two directories
 *   `/system_stats` reports. `temp`, an unknown type, and an absent one all
 *   decline: falling back to the output directory would name a real file that
 *   is not the artifact, which is the one failure mode worse than a URL.
 * - **A candidate outside its root** — `subfolder` arrives in the *server's*
 *   response, not from this server, so a `..` in it is not ours to trust. The
 *   containment check mirrors comfy-cli's own (`candidate === root ||
 *   candidate.startsWith(root + sep)`) after normalising.
 * - **A path that is not a file on disk** — a fabricated path is worse than no
 *   path: a caller opens it and fails somewhere with nothing to explain it.
 *
 * **This never throws.** A malformed URL, a missing directory, a permission
 * error — every one of them is an unresolved artifact, and the URL stands.
 */
export function resolveArtifactPath(
  artifact: string,
  location: ArtifactLocation,
  interfaces: InterfaceAddresses = networkInterfaces(),
): string | null {
  if (!isLocalAddress(location.host, interfaces)) return null;

  const url = parseArtifactUrl(artifact);
  if (url === null) return null;
  if (url.pathname !== VIEW_PATH) return null;
  if (!isSameInstance(url, location)) return null;

  const root = artifactRoot(url.searchParams.get("type"), location);
  if (root === null) return null;

  const filename = url.searchParams.get("filename");
  if (filename === null || filename === "") return null;

  return containedFile(root, url.searchParams.get("subfolder") ?? "", filename);
}

/**
 * Every artifact that also exists as a local file, keyed by the URL it came
 * from.
 *
 * A map rather than a list, because the question a caller has is about one
 * artifact at a time: *is there a local path for this URL?* An absent key is
 * the answer "no", and it cannot be confused with a positional gap in a
 * parallel array. Entries that did not resolve are simply not present, so the
 * map is never a claim about a file nobody checked.
 *
 * Safe to hand any artifact string: one already classified as a file is not a
 * URL, does not resolve, and is returned to nobody.
 */
export function resolveArtifactPaths(
  artifacts: readonly string[],
  location: ArtifactLocation,
  // Read once here rather than once per artifact: `networkInterfaces()` is a
  // syscall, and a run with twenty outputs would otherwise make twenty of them
  // to answer the same question twenty times.
  interfaces: InterfaceAddresses = networkInterfaces(),
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const artifact of artifacts) {
    const path = resolveArtifactPath(artifact, location, interfaces);
    if (path !== null) resolved[artifact] = path;
  }
  return resolved;
}

/**
 * The URL, or `null` if this is not one. Guarded by {@link isArtifactUrl} so
 * that a Windows path never reaches `new URL`, which would read `C:\out.png` as
 * a URL with protocol `c:`; the `try` covers everything else, because a URL
 * this server cannot parse is an unresolved artifact and not a fault.
 */
function parseArtifactUrl(value: string): URL | null {
  if (!isArtifactUrl(value)) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Whether the URL points at the instance that reported these directories.
 *
 * Compared through `authority` so that the bracketing of an IPv6 literal is
 * decided in one place — `url.hostname` brackets `[::1]` and a detected host
 * does not, and the two spellings are one address.
 */
function isSameInstance(url: URL, location: ArtifactLocation): boolean {
  const port = url.port === "" ? defaultPort(url.protocol) : Number(url.port);
  return (
    authority(url.hostname, port).toLowerCase() ===
    authority(location.host, location.port).toLowerCase()
  );
}

/** What an omitted port means, per scheme. */
function defaultPort(protocol: string): number {
  return protocol.toLowerCase() === "https:" ? 443 : 80;
}

/** The directory a `?type=` names, or `null` if this instance has no such root. */
function artifactRoot(type: string | null, location: ArtifactLocation): string | null {
  if (type === OUTPUT_TYPE) return location.outputDirectory;
  if (type === INPUT_TYPE) return location.inputDirectory;
  return null;
}

/**
 * The file at `root/subfolder/filename`, if it is inside `root` and is really
 * there.
 *
 * The root must be absolute. A relative `--output-directory` is relative to
 * ComfyUI's working directory, which this server does not know; resolving it
 * against its own would name a file nobody asked about.
 */
function containedFile(root: string, subfolder: string, filename: string): string | null {
  if (!isAbsolute(root)) return null;

  const base = resolve(root);
  const candidate = resolve(base, subfolder, filename);
  if (candidate !== base && !candidate.startsWith(base + sep)) return null;

  return isFile(candidate) ? candidate : null;
}

/** Whether a path is a file right now. A missing directory is not an error. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
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
