import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { isArtifactUrl } from "./outputs.ts";

/**
 * Bring a remote run's artifacts to this machine, when — and only when — a
 * caller asks.
 *
 * ## Why this is opt-in
 *
 * A run on another box writes its files on that box. `comfy/outputs.ts` will
 * not pretend otherwise: a `/view` URL from a remote instance resolves to no
 * local path, because the only honest answer is that there is not one. That
 * leaves the URL, which is a perfectly good way in for anything that speaks
 * HTTP — and a poor one for a person who wants to look at their image.
 *
 * So this exists, and it is a parameter rather than a default. A video workflow
 * produces files in the hundreds of megabytes; copying them across a tailnet
 * because somebody polled a job is not a thing to do without being asked.
 *
 * ## What it will not do
 *
 * - **Never overwrite outside its own directory.** The filename comes from the
 *   URL's own `filename` query parameter, which is the *remote's* data; it is
 *   reduced to a single path segment here, and a value that cannot be is
 *   refused rather than sanitised into something adjacent.
 * - **Never buffer the whole file.** The body is streamed to disk a chunk at a
 *   time and stopped the moment it passes the cap, so a remote that lies about
 *   its length costs a bounded amount of disk rather than the process.
 * - **Never leave half a file behind.** A fetch that fails removes what it
 *   wrote, on the same reasoning as `objectInfo.ts`'s cache write: a truncated
 *   artifact that looks like a finished one is worse than no artifact.
 */

/**
 * The largest artifact this will copy: 1 GiB.
 *
 * Chosen against what the artifacts actually are rather than against comfort —
 * an image is a megabyte and a long video is hundreds — so the cap only ever
 * bites on something that has gone wrong. It is not a memory bound (nothing
 * here holds the file in memory); it is a bound on how much disk one tool call
 * can consume on a remote's say-so.
 */
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;

/** Per artifact. A large video over a tailnet is slow, and giving up early is worse. */
const DEFAULT_TIMEOUT_MS = 300_000;

/** What a fetch attempt did, per artifact. */
export interface FetchedArtifact {
  url: string;
  /** The file written, or `null` when this one could not be fetched. */
  path: string | null;
  /** Why it could not be, in the operator's terms. `null` on success. */
  problem: string | null;
}

export interface FetchOutputsOptions {
  /** The directory to write into. Created if need be. */
  destination: string;
  timeoutMs?: number;
}

/**
 * Copy every artifact URL to {@link FetchOutputsOptions.destination}.
 *
 * **Never throws.** One artifact that will not come across must not deny a
 * caller the other nine, and this runs after a run has already succeeded — the
 * run is the answer, and this is a convenience on top of it. Each failure is
 * reported on its own entry.
 */
export async function fetchArtifacts(
  urls: readonly string[],
  opts: FetchOutputsOptions,
): Promise<FetchedArtifact[]> {
  const fetched: FetchedArtifact[] = [];
  for (const url of urls) {
    fetched.push(await fetchOne(url, opts));
  }
  return fetched;
}

async function fetchOne(url: string, opts: FetchOutputsOptions): Promise<FetchedArtifact> {
  const failed = (problem: string): FetchedArtifact => ({ url, path: null, problem });

  if (!isArtifactUrl(url)) return failed("not an http(s) URL");
  const name = artifactFilename(url);
  if (name === null) return failed("the URL names no filename this server would write");

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) });
  } catch (cause) {
    return failed(cause instanceof Error ? cause.message : String(cause));
  }
  if (!response.ok) return failed(`HTTP ${response.status} ${response.statusText}`);
  if (response.body === null) return failed("the response carried no body");

  const path = join(opts.destination, name);
  try {
    await mkdir(opts.destination, { recursive: true });
  } catch (cause) {
    return failed(`could not create ${opts.destination}: ${describe(cause)}`);
  }

  const handle = await open(path, "w").catch(() => null);
  if (handle === null) return failed(`could not write ${path}`);

  let written = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      written += chunk.byteLength;
      if (written > MAX_ARTIFACT_BYTES) {
        throw new Error(`larger than this server's ${MAX_ARTIFACT_BYTES}-byte limit`);
      }
      await handle.write(chunk);
    }
  } catch (cause) {
    await handle.close().catch(() => {});
    // A partial file that looks finished is the one outcome worse than none.
    await rm(path, { force: true }).catch(() => {});
    return failed(describe(cause));
  }
  await handle.close().catch(() => {});

  return { url, path, problem: null };
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The single filename an artifact URL names, or `null`.
 *
 * `filename` is the remote's own string. Anything with a path separator, a
 * `..`, a NUL or a drive letter is refused outright rather than stripped: a
 * sanitised name is a name the caller did not ask for, written somewhere they
 * cannot predict, and a refusal they can read is better than a file they
 * cannot find.
 */
export function artifactFilename(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const name = parsed.searchParams.get("filename");
  if (name === null || name === "" || name === "." || name === "..") return null;
  if (/[/\\\0]/.test(name) || /^[A-Za-z]:/.test(name)) return null;
  return name;
}
