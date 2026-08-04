import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { snippet } from "./envelope.ts";
import { DEFAULT_PORT, authority, resolveHost } from "./target.ts";

/**
 * ComfyUI's `/object_info` is the only source of input constraints: `comfy
 * workflow slots` reports a slot's type and current value but never its allowed
 * values or bounds. Task 2.3 joins the two; this module is the fetch and cache
 * layer under it.
 *
 * The on-disk copy is not merely a speed-up. `comfy workflow slots` and
 * `set-slot` accept `--input <object_info.json>`, so the cached file is what
 * lets workflow introspection work with no server running for up to the TTL
 * (landmine #7) — which is why {@link objectInfoCachePath} is public and why the
 * file on disk is plain, unmodified JSON. Callers that need the path *and* a
 * guarantee the contents are current want {@link ensureObjectInfoCache}.
 */

/**
 * 24 hours. The payload only changes when custom nodes or models are installed,
 * both of which require a ComfyUI restart to take effect, so a day-old copy is
 * normally identical to a fresh one. `refresh: true` is the escape hatch for
 * the operator who just installed something.
 */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Generous because the response is ~1.7MB and a just-started instance answers
 * slowly, but bounded: an MCP tool call that hangs forever is worse than one
 * that says the server is not answering.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * How far into the future a cache file may be dated before it is treated as
 * misdated rather than fresh. Not zero: `Date.now()` floors to whole
 * milliseconds while `mtimeMs` keeps sub-millisecond precision, so a file
 * written *this instant* reads as up to 1ms ahead, and coarse or network
 * filesystems are worse. A minute ahead is not precision noise — it is a clock
 * change or a restored archive, and those must not pin a cache forever.
 */
const FUTURE_TOLERANCE_MS = 60_000;

const UNREACHABLE_HINT = "Is ComfyUI running and reachable at that address?";
const SLOW_HINT = "Raise timeoutMs if this instance needs longer to become ready.";

/**
 * One node type's entry, deliberately untyped past this point. Across 1031 node
 * types plus whatever custom nodes are installed the shapes vary too much to
 * validate here; Task 2.3 reads `input.required` defensively instead.
 */
export type NodeSchema = Record<string, unknown>;

/** Every node type the instance knows, keyed by node type name. */
export type ObjectInfo = Record<string, NodeSchema>;

export interface ObjectInfoOptions {
  /** Defaults to `127.0.0.1`; the wildcards `0.0.0.0` and `::` rewrite to it. */
  host?: string;
  /** Defaults to `8188`. */
  port?: number;
  /** Bypass the cache and refetch. Never joins a fetch already in flight. */
  refresh?: boolean;
  /** Defaults to `~/.cache/mcp-comfyui`. */
  cacheDir?: string;
  /** How old a cache file may be before it is refetched. Defaults to 24 hours. */
  ttlMs?: number;
  /** Budget for the HTTP request. Defaults to 30 seconds. */
  timeoutMs?: number;
}

/** Just enough to name the cache file; TTL and refresh do not affect its path. */
export type ObjectInfoLocation = Pick<ObjectInfoOptions, "host" | "port" | "cacheDir">;

/**
 * `/object_info` did not yield usable node definitions — refused, timed out,
 * answered with an error status, or answered with something that is not a node
 * dictionary (a proxy's HTML error page being the classic). The URL is on the
 * error because host and port are the two things the operator can actually fix,
 * and the cache path because an intact earlier copy may be sitting there: this
 * call will not serve it, but `comfy workflow slots --input` still can.
 */
export class ObjectInfoFetchError extends Error {
  override readonly name = "ObjectInfoFetchError";
  readonly url: string;
  readonly cachePath: string;
  /** The HTTP status, or null when the request never got one. */
  readonly status: number | null;

  constructor(
    details: {
      url: string;
      cachePath: string;
      status: number | null;
      reason: string;
      hint: string;
    },
    options?: { cause?: unknown },
  ) {
    super(
      `could not read node definitions from ${details.url}: ${details.reason}\n` +
        `${details.hint}\n` +
        `  any cached copy is at: ${details.cachePath}`,
      options,
    );
    this.url = details.url;
    this.cachePath = details.cachePath;
    this.status = details.status;
  }
}

/**
 * The payload arrived but could not be cached. Names the cache path rather than
 * the temp file it was actually writing: the temp name is an implementation
 * detail the operator has never seen and cannot act on.
 */
export class ObjectInfoCacheWriteError extends Error {
  override readonly name = "ObjectInfoCacheWriteError";
  readonly cachePath: string;

  constructor(cachePath: string, cause: unknown) {
    super(
      `could not write the node definition cache at ${cachePath}: ${describeCause(cause)}\n` +
        `Check that the directory is writable, or pass a different cacheDir.`,
      { cause },
    );
    this.cachePath = cachePath;
  }
}

/**
 * Prefer the errno: an fs message quotes the temp path this module invented,
 * which would put a filename the operator has never seen in front of them.
 */
function describeCause(cause: unknown): string {
  const code = cause instanceof Error ? (cause as NodeJS.ErrnoException).code : undefined;
  if (typeof code === "string") return code;
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Permissive by design. Rejecting an HTML page, a JSON array or an empty node
 * set is worth doing; validating node schemas is not, because one unfamiliar
 * custom node would then reject the whole install's 1.7MB payload. The nested
 * record goes exactly one level deep — enough to make {@link ObjectInfo} true
 * without an unchecked cast, and no further.
 */
const ObjectInfoSchema = z.record(z.string(), z.record(z.string(), z.unknown()));

/**
 * Fetches in progress, keyed by cache path. Two tools describing two workflows
 * at once must not both pull 1.7MB and race to write the same file. Refreshing
 * callers get their own entry, so more than one may be live for a path.
 */
const inFlight = new Map<string, Promise<ObjectInfo>>();

function defaultCacheDir(): string {
  return join(homedir(), ".cache", "mcp-comfyui");
}

/**
 * Hostnames may legally contain nothing exotic, but an operator's config can,
 * and this string becomes a filename: an IPv6 host is full of colons, and a
 * mistyped one could otherwise carry path separators.
 */
function forFilename(host: string): string {
  return host.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Where the cached `/object_info` for one instance lives. Pure: it neither
 * fetches nor checks freshness, so a stale or absent file yields a path all the
 * same. Callers about to hand this to `comfy workflow slots --input` want
 * {@link ensureObjectInfoCache} instead.
 */
export function objectInfoCachePath(opts: ObjectInfoLocation = {}): string {
  const host = forFilename(resolveHost(opts.host));
  const port = opts.port ?? DEFAULT_PORT;
  return join(opts.cacheDir ?? defaultCacheDir(), `object_info-${host}-${port}.json`);
}

function objectInfoUrl(host: string, port: number): string {
  return `http://${authority(host, port)}/object_info`;
}

function parse(text: string): ObjectInfo {
  const value: unknown = JSON.parse(text); // throws SyntaxError; callers translate
  const result = ObjectInfoSchema.safeParse(value);
  if (!result.success) {
    throw new TypeError(
      `not a node-type dictionary (received: ${snippet(text)})\n${z.prettifyError(result.error)}`,
    );
  }
  if (Object.keys(result.data).length === 0) {
    // An instance that reports no node types is broken or still booting.
    throw new TypeError("node-type dictionary is empty");
  }
  return result.data;
}

/**
 * The cached copy, or null if there is nothing usable. Every failure is a miss:
 * a file truncated mid-write by a crash is a realistic state and must cost a
 * refetch, never an exception — the caller asked for node definitions, not for
 * an audit of the cache.
 */
async function readCache(path: string, ttlMs: number): Promise<ObjectInfo | null> {
  try {
    const { mtimeMs } = await stat(path);
    const age = Date.now() - mtimeMs;
    // A file dated in the future has a negative age, which a plain
    // `age >= ttlMs` test reads as permanently fresh.
    if (age < -FUTURE_TOLERANCE_MS || age >= ttlMs) return null;
    return parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Write via a temp file and rename, so a crash or a concurrent writer can never
 * leave a half-written payload where `--input` will read it. The bytes are the
 * server's own, unreserialized.
 *
 * @throws {ObjectInfoCacheWriteError} on any failure, with the temp file
 * removed first so a failing cache directory does not accumulate 1.7MB of
 * litter per attempt.
 */
async function writeCache(path: string, body: string): Promise<void> {
  // A UUID, not pid+timestamp: two writers for one path in the same process and
  // the same millisecond would otherwise share a temp file and rename each
  // other's half of it into place — a corrupt cache produced by the very
  // mechanism meant to prevent one.
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temp, body);
    await rename(temp, path);
  } catch (cause) {
    await rm(temp, { force: true }).catch(() => {}); // best effort; already failing
    throw new ObjectInfoCacheWriteError(path, cause);
  }
}

/** Fetch and validate, returning both the value and the bytes worth caching. */
async function fetchObjectInfo(
  url: string,
  cachePath: string,
  timeoutMs: number,
): Promise<{ info: ObjectInfo; body: string }> {
  let response: Response;
  let body: string;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    body = await response.text();
  } catch (cause) {
    // A timeout is not unreachability. The likeliest cause is an instance that
    // would have answered eventually because it is still loading models, and
    // asking that operator whether ComfyUI is running sends them the wrong way.
    const timedOut = cause instanceof Error && cause.name === "TimeoutError";
    const reason = timedOut
      ? `no response within ${timeoutMs}ms — the server may still be loading models`
      : cause instanceof Error
        ? cause.message
        : String(cause);
    throw new ObjectInfoFetchError(
      { url, cachePath, status: null, reason, hint: timedOut ? SLOW_HINT : UNREACHABLE_HINT },
      { cause },
    );
  }

  if (!response.ok) {
    throw new ObjectInfoFetchError({
      url,
      cachePath,
      status: response.status,
      reason: `HTTP ${response.status} ${response.statusText} (${snippet(body)})`,
      hint: UNREACHABLE_HINT,
    });
  }

  try {
    return { info: parse(body), body };
  } catch (cause) {
    throw new ObjectInfoFetchError(
      {
        url,
        cachePath,
        status: response.status,
        reason: cause instanceof Error ? cause.message : String(cause),
        hint: UNREACHABLE_HINT,
      },
      { cause },
    );
  }
}

/**
 * Every node type the instance knows, from cache when it is fresh enough.
 *
 * A caller that joins a fetch already in flight inherits the leader's timeout
 * budget rather than its own `timeoutMs`; `refresh: true` never joins, so a
 * caller that needs its own deadline honoured can always ask for one.
 *
 * @throws {ObjectInfoFetchError} the instance could not be reached, or answered
 * with something that is not a node dictionary.
 * @throws {ObjectInfoCacheWriteError} the payload was fetched but could not be
 * cached. Deliberately fatal, and deliberately asymmetric with reads — a bad
 * cache file is discarded in silence because a fresh copy is one fetch away,
 * whereas a cache that cannot be *written* silently degrades every later call
 * into another 1.7MB fetch and leaves `--input` with nothing to read. An
 * unwritable cache directory is an operator problem with an operator fix, so it
 * is reported rather than absorbed.
 */
export async function getObjectInfo(opts: ObjectInfoOptions = {}): Promise<ObjectInfo> {
  const host = resolveHost(opts.host);
  const port = opts.port ?? DEFAULT_PORT;
  const cachePath = objectInfoCachePath({ host, port, cacheDir: opts.cacheDir });

  if (!opts.refresh) {
    const cached = await readCache(cachePath, opts.ttlMs ?? DEFAULT_TTL_MS);
    if (cached) return cached;
  }

  // Joining would hand a refreshing caller exactly the copy it asked to bypass,
  // and would silently substitute the leader's timeout for its own.
  const running = opts.refresh ? undefined : inFlight.get(cachePath);
  if (running) return running;

  const pending = (async () => {
    const { info, body } = await fetchObjectInfo(
      objectInfoUrl(host, port),
      cachePath,
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    await writeCache(cachePath, body);
    return info;
  })();

  inFlight.set(cachePath, pending);
  try {
    return await pending;
  } finally {
    // By identity, not by key: a refreshing caller may have replaced this entry
    // while it ran, and deleting that one would strand the callers waiting on
    // it. Runs on failure too, or one bad fetch would wedge this instance until
    // the process restarts.
    if (inFlight.get(cachePath) === pending) inFlight.delete(cachePath);
  }
}

/**
 * Bring the cache up to date and return its path, for `comfy workflow slots
 * --input`. Prefer this over {@link objectInfoCachePath} whenever the contents
 * matter: a year-old file feeds `--input` as happily as a current one, and the
 * sampler list Task 2.3 synthesises from it would be a year out of date with
 * nothing to say so.
 *
 * @throws {ObjectInfoFetchError} as {@link getObjectInfo}.
 * @throws {ObjectInfoCacheWriteError} as {@link getObjectInfo}.
 */
export async function ensureObjectInfoCache(opts: ObjectInfoOptions = {}): Promise<string> {
  await getObjectInfo(opts);
  return objectInfoCachePath(opts);
}
