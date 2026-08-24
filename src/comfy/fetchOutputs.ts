import { mkdir, open, rm, stat } from "node:fs/promises";
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

/**
 * What a fetch attempt did, per artifact.
 *
 * Three outcomes, discriminated rather than inferred from which fields happen
 * to be null. A **skip** is not a failure: it is something this server decided
 * not to do, and the caller's next move — ask explicitly — is different from
 * the next move for a fetch that broke. Encoding it as a `problem` whose text
 * mentions a ceiling would leave the tool layer one string-match away from
 * reporting a deliberate policy as a fault.
 */
export type FetchedArtifact =
  | { readonly url: string; readonly outcome: "fetched"; readonly path: string }
  | { readonly url: string; readonly outcome: "failed"; readonly problem: string }
  | { readonly url: string; readonly outcome: "skipped"; readonly reason: string };

/**
 * A copy allowance shared across several {@link fetchArtifacts} calls.
 *
 * The per-artifact ceiling bounds ONE file; nothing bounds a run of them. A
 * sixteen-variant sweep whose images are each comfortably under the ceiling
 * still copies a few hundred megabytes from a call that asked for none of it,
 * so `run_sweep` hands one of these down its variants and the artifacts are
 * copied in variant order until it is spent.
 *
 * **Mutable on purpose.** The budget is a running total across calls that do
 * not otherwise know about each other, and threading a return value through
 * every one of them would put the arithmetic in the caller — which is where it
 * would drift from the bytes that actually landed.
 */
export interface FetchBudget {
  /** Bytes still available. Decremented by what each artifact actually wrote. */
  remaining: number;
  /** What it started at, so a refusal can say which budget it was. */
  readonly total: number;
}

export interface FetchOutputsOptions {
  /** The directory to write into. Created if need be. */
  destination: string;
  timeoutMs?: number;
  /**
   * Refuse an artifact larger than this, reporting it `skipped`.
   *
   * Defaults to {@link MAX_ARTIFACT_BYTES}, so an explicit `fetch_outputs`
   * behaves exactly as it always has. The automatic path passes a far lower
   * one — see `AUTO_FETCH_MAX_BYTES` in `tools.ts` for the policy and the
   * measurement behind its value.
   */
  maxBytes?: number;
  /**
   * A shared allowance across this whole tool call — see {@link FetchBudget}.
   *
   * Enforced at the same point the per-artifact ceiling is: against the
   * remote's declared `content-length`, before any bytes move. Where the
   * remote sends no `content-length` there is nothing to check in advance, so
   * that artifact is fetched under the per-artifact ceiling and the budget is
   * charged what landed — which can overshoot, by at most one ceiling's worth.
   * Bounded and stated, rather than paid for with a second streaming cap whose
   * skip message could not say which of the two limits bit.
   */
  budget?: FetchBudget;
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
  const failed = (problem: string): FetchedArtifact => ({ url, outcome: "failed", problem });
  const skipped = (reason: string): FetchedArtifact => ({ url, outcome: "skipped", reason });
  const maxBytes = opts.maxBytes ?? MAX_ARTIFACT_BYTES;

  if (!isArtifactUrl(url)) return failed("not an http(s) URL");
  const name = artifactFilename(url);
  if (name === null) return failed("the URL names no filename this server would write");
  const path = join(opts.destination, name);

  // Already here: hand it back without a request. Safe on two invariants this
  // module maintains rather than assumes — a partial file never survives,
  // because every failure path below removes what it wrote, so anything on
  // disk is a COMPLETE previous fetch; and the destination is keyed by
  // `prompt_id` as well as filename, so it is a previous fetch of THIS
  // artifact and not of a namesake from another run.
  const existing = await stat(path).catch(() => null);
  if (existing !== null && existing.isFile()) return { url, outcome: "fetched", path };

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) });
  } catch (cause) {
    return failed(cause instanceof Error ? cause.message : String(cause));
  }
  if (!response.ok) return failed(`HTTP ${response.status} ${response.statusText}`);
  if (response.body === null) return failed("the response carried no body");

  // Ask before moving the bytes. `content-length` is optional and a remote may
  // overstate it, so this is an optimisation and the streaming cap below is
  // the guarantee — but when the header IS present it is the difference
  // between declining a 200MB video and downloading the ceiling's worth of one
  // to discover the same thing.
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body.cancel().catch(() => {});
    return skipped(`${declared} bytes exceeds this call's ${maxBytes}-byte limit`);
  }
  // The shared allowance, checked at the same point and on the same number.
  // Two messages rather than one, because the two limits have different fixes:
  // a single artifact past the ceiling is a big file, a sweep past its budget
  // is a lot of ordinary ones and the earlier variants already came across.
  const budget = opts.budget;
  if (budget !== undefined) {
    if (budget.remaining <= 0) {
      await response.body.cancel().catch(() => {});
      return skipped(`this call's ${budget.total}-byte copy budget was already spent`);
    }
    if (Number.isFinite(declared) && declared > budget.remaining) {
      await response.body.cancel().catch(() => {});
      return skipped(
        `${declared} bytes exceeds the ${budget.remaining} bytes left of this call's ` +
          `${budget.total}-byte copy budget`,
      );
    }
  }

  try {
    await mkdir(opts.destination, { recursive: true });
  } catch (cause) {
    return failed(`could not create ${opts.destination}: ${describe(cause)}`);
  }

  const handle = await open(path, "w").catch(() => null);
  if (handle === null) return failed(`could not write ${path}`);

  let written = 0;
  // Distinguishes the two ways out of the loop below: exceeding the ceiling is
  // a skip, everything else is a failure. Both share the cleanup.
  let oversize = false;
  // `getReader()` rather than `for await (… of response.body)`. Async iteration
  // over a `ReadableStream` is a comparatively recent addition and this bundle
  // targets Node 18 upward as well as Deno and Bun (`engines.node >= 18`); the
  // reader API is the one spelling that exists everywhere `fetch` does. The
  // same runtime-agnostic discipline that keeps `comfy/exec.ts` on
  // `node:child_process` rather than `Deno.Command`.
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      written += value.byteLength;
      if (written > maxBytes) {
        oversize = true;
        throw new Error(`larger than this call's ${maxBytes}-byte limit`);
      }
      await handle.write(value);
    }
  } catch (cause) {
    await reader.cancel().catch(() => {});
    await handle.close().catch(() => {});
    // A partial file that looks finished is the one outcome worse than none.
    await rm(path, { force: true }).catch(() => {});
    return oversize ? skipped(describe(cause)) : failed(describe(cause));
  }
  await handle.close().catch(() => {});

  // Charged what actually landed, not what was declared: a remote may overstate
  // its length, and the budget's job is to bound the bytes this call brings
  // here. A file served with no `content-length` is the only case that can push
  // `remaining` negative, which the check above reads as "spent".
  if (budget !== undefined) budget.remaining -= written;

  return { url, outcome: "fetched", path };
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
