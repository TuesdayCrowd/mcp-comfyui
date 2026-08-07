import { z } from "zod";
import { snippet } from "./envelope.ts";
import { authority } from "./target.ts";

/**
 * A remote ComfyUI's own saved workflows, over its HTTP API.
 *
 * `comfy` cannot help here. It reads a workflow file it is pointed at; it does
 * not enumerate another machine's, and there is no share to read one through.
 * ComfyUI itself does publish them, under `/api/userdata`, and that is the only
 * way in — which is why this is the one module in the project that fetches
 * something other than `/system_stats` or `/object_info`.
 *
 * ## The contract, from ComfyUI's own source
 *
 * Read out of `app/user_manager.py` (ComfyUI 0.30.2) and confirmed against a
 * live instance, because the alternative is the guessing this project has been
 * wrong about roughly half the time:
 *
 * - `GET /api/userdata?dir=<d>&recurse=true&full_info=true` answers with a JSON
 *   array of `{path, size, modified, created}`. `path` is relative to the
 *   user's own root and always uses `/`, because the handler does
 *   `os.path.relpath(...).replace(os.sep, '/')` — so a **Windows** host still
 *   reports `workflows/a.json`. Measured against the live Windows remote:
 *   `dir=.` returned `[{"path": "comfy.settings.json", "size": 126,
 *   "modified": 1786069244638, "created": 1786064269557}]`.
 * - A directory that is not there is a 404; a missing `dir` is a 400.
 * - `GET /api/userdata/{file}` is a **single aiohttp path segment**, so a
 *   nested path has to be percent-encoded — and the handler only calls
 *   `unquote` when the name contains a `%`, so encoding is required rather
 *   than merely tolerated.
 * - That route answers with `web.FileResponse`: the file's **raw bytes**, with
 *   `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`.
 *   Measured: the 126-byte settings file arrived as exactly 126 bytes.
 * - The v2 listing is `/api/v2/userdata`, **not** `/api/userdata/v2` — the
 *   latter 404s. v1 with `full_info=true` is used here because it carries size
 *   and mtime in one call and is present in every build this has seen.
 *
 * ## Why the bytes are never parsed
 *
 * Landmine #1, one layer further out. A ComfyUI seed reaches 2^64−1 and
 * JavaScript rounds above 2^53, so a graph that goes through `JSON.parse` here
 * comes out the other side with a *different* seed — including seeds nobody
 * asked to change. The fetch therefore hands back a `Uint8Array` and
 * `workflows/setSlots.ts` writes those bytes straight into the temp copy it
 * already makes for a local file. The bytes are never text, never a value,
 * never re-serialised.
 *
 * ## The trust boundary
 *
 * This is the one place in the server where bytes from an HTTP server become a
 * file that `comfy` is then asked to run. Everything else it fetches is
 * consumed as data and discarded. So the checks below — a size cap, a
 * content-type check, and a containment check on every path the *listing*
 * supplies — belong here and nowhere else.
 */

/** The workflows directory, in a ComfyUI user's own data root. */
const WORKFLOWS_DIR = "workflows";

const JSON_EXTENSION = ".json";

/**
 * The largest workflow this will fetch.
 *
 * 8 MiB, against a measured largest-on-this-machine of 122 KB
 * (`templates-6-key-frames.json`, in a directory of 27). Two orders of
 * magnitude of headroom, and still far under the 16 MiB stdin budget an answer
 * carrying it would have to fit through. The cap exists because the response
 * is another machine's to decide the length of, and streaming an unbounded body
 * into memory on its say-so is the one failure that takes the whole server
 * with it rather than one call.
 */
const MAX_WORKFLOW_BYTES = 8 * 1024 * 1024;

/** Budget for a listing or a fetch. Generous for a workflow over a tailnet. */
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Content types a workflow may arrive as.
 *
 * ComfyUI answers `application/json` for a `.json` file, from `mimetypes`. The
 * `octet-stream` arm is not laxity: the same handler substitutes it for
 * anything `is_dangerous_content_type` flags, and a build whose mimetypes
 * database is thin would answer it for a perfectly ordinary workflow. What is
 * actually being excluded is `text/html` — a proxy's login page or error page,
 * which is the realistic way a fetch "succeeds" with something that is not a
 * workflow at all. The same reasoning as `comfy/objectInfo.ts`'s parse guard.
 */
const ACCEPTED_TYPES = [/^application\/json\b/i, /^application\/octet-stream\b/i, /\+json\b/i];

/** One entry of the listing, as ComfyUI's `get_file_info` builds it. */
const FileInfoSchema = z.looseObject({
  path: z.string(),
  size: z.number().nullable().optional(),
  /** Epoch milliseconds. */
  modified: z.number().nullable().optional(),
  created: z.number().nullable().optional(),
});

const ListingSchema = z.array(FileInfoSchema);

/** One workflow file on a remote instance. */
export interface RemoteWorkflow {
  /** Relative to the user data root, always `/`-separated, e.g. `workflows/a.json`. */
  path: string;
  /** The filename's stem — the memorable half of a handle. */
  stem: string;
  /** `null` when the instance did not report one. */
  sizeBytes: number | null;
  /** ISO 8601, or `null` when the instance did not report an mtime. */
  modified: string | null;
}

/** Where to ask, and how long to wait. */
export interface UserdataOptions {
  host: string;
  port: number;
  timeoutMs?: number;
}

/**
 * A remote instance could not answer for its own workflows.
 *
 * One type for the listing and the fetch, because the operator's question is
 * the same either way — which instance, and what did it say — and the
 * `status` is what separates "that host is down" from "that host has no such
 * workflow".
 */
export class UserdataError extends Error {
  override readonly name = "UserdataError";
  readonly url: string;
  /** The HTTP status, or `null` when the request never got one. */
  readonly status: number | null;

  constructor(url: string, status: number | null, reason: string, guidance: string) {
    super(`${reason}\n  ${url}\n${guidance}`, undefined);
    this.url = url;
    this.status = status;
  }
}

/** Whether a 404 from the fetch means "no such workflow" rather than "no such host". */
export function isMissingWorkflow(err: unknown): boolean {
  return err instanceof UserdataError && err.status === 404;
}

function base(opts: UserdataOptions): string {
  return `http://${authority(opts.host, opts.port)}`;
}

async function get(url: string, opts: UserdataOptions, accept: string): Promise<Response> {
  try {
    return await fetch(url, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      headers: { accept },
    });
  } catch (cause) {
    const timedOut = cause instanceof Error && cause.name === "TimeoutError";
    throw new UserdataError(
      url,
      null,
      timedOut
        ? `no response within ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
        : cause instanceof Error
          ? cause.message
          : String(cause),
      "Is that ComfyUI running and reachable? comfy_status reports what answered.",
    );
  }
}

/**
 * The workflow files a remote instance has saved.
 *
 * Only `.json` files are reported, and only ones whose path this server would
 * be willing to fetch — see {@link safeRelativePath}. An entry that fails that
 * check is dropped rather than listed, because listing a handle that
 * `describe_workflow` would then refuse is worse than not offering it.
 *
 * @throws {UserdataError} the instance did not answer, or answered with
 * something that is not a listing. A 404 means it has no `workflows` directory
 * at all, which is reported as an empty listing rather than an error: a fresh
 * install genuinely has none, and that is not a fault.
 */
export async function listRemoteWorkflows(opts: UserdataOptions): Promise<RemoteWorkflow[]> {
  const url =
    `${base(opts)}/api/userdata?` +
    `dir=${encodeURIComponent(WORKFLOWS_DIR)}&recurse=true&full_info=true`;
  const response = await get(url, opts, "application/json");

  // A fresh install has no `workflows` directory, and ComfyUI answers 404 for
  // one that is not there. That is an empty library, not a failure — the live
  // remote this was measured against is in exactly that state.
  if (response.status === 404) return [];

  const body = await response.text();
  if (!response.ok) {
    throw new UserdataError(
      url,
      response.status,
      `HTTP ${response.status} ${response.statusText} (${snippet(body)})`,
      "That instance refused to list its workflows.",
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (cause) {
    throw new UserdataError(
      url,
      response.status,
      `the response was not JSON (received: ${snippet(body)})`,
      "Something other than ComfyUI may be answering at that address.",
    );
  }

  const parsed = ListingSchema.safeParse(value);
  if (!parsed.success) {
    throw new UserdataError(
      url,
      response.status,
      `the response was not a userdata listing (received: ${snippet(body)})`,
      "This server asks for `full_info=true`, which ComfyUI answers with a list of " +
        "{path, size, modified}.",
    );
  }

  const workflows: RemoteWorkflow[] = [];
  for (const entry of parsed.data) {
    const path = safeRelativePath(entry.path);
    if (path === null) continue;
    if (!path.toLowerCase().endsWith(JSON_EXTENSION)) continue;
    const name = path.slice(path.lastIndexOf("/") + 1);
    workflows.push({
      path,
      stem: name.slice(0, -JSON_EXTENSION.length),
      sizeBytes: entry.size ?? null,
      modified: entry.modified == null ? null : new Date(entry.modified).toISOString(),
    });
  }
  // By path, in code-unit order, for the same reason `workflows/discover.ts`
  // sorts its own listing: an order a caller can predict, and one that does not
  // depend on the remote filesystem's traversal.
  workflows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return workflows;
}

/**
 * A path from the listing, normalised, or `null` if it is not one this server
 * will follow.
 *
 * The listing is the *remote's* data, not ours. It is normally
 * `os.path.relpath` output and perfectly tame, but this server is about to turn
 * whatever it says into a URL and then into a filename, so a `..` segment, an
 * absolute path, a Windows drive letter, a backslash or a NUL is refused here
 * rather than reasoned about later. ComfyUI guards its own side with
 * `os.path.commonpath`; that protects the remote's filesystem, not this one's.
 */
export function safeRelativePath(raw: string): string | null {
  const path = raw.trim();
  if (path === "") return null;
  if (path.includes("\0") || path.includes("\\")) return null;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return null;
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return null;
  return path;
}

/**
 * One remote workflow's exact bytes.
 *
 * Never decoded, never parsed — see the module doc. The caller writes them, as
 * they are, into the private copy `applySlots` was going to make anyway.
 *
 * @throws {UserdataError} the instance did not answer; answered 404 (no such
 * workflow — {@link isMissingWorkflow} recognises it); answered with a
 * content type that is not a workflow's; or answered with a body over
 * {@link MAX_WORKFLOW_BYTES}.
 */
export async function fetchRemoteWorkflow(
  path: string,
  opts: UserdataOptions,
): Promise<Uint8Array> {
  const safe = safeRelativePath(path);
  if (safe === null) {
    throw new UserdataError(
      `${base(opts)}/api/userdata/…`,
      null,
      `${JSON.stringify(path)} is not a relative path inside that instance's user data`,
      "A remote workflow path comes from list_workflows and looks like `workflows/name.json`.",
    );
  }

  // One aiohttp path segment, so the whole relative path is encoded — including
  // its separators. See the module doc: the handler unquotes only when it sees
  // a `%`, so this is required, not merely accepted.
  const url = `${base(opts)}/api/userdata/${encodeURIComponent(safe)}`;
  const response = await get(url, opts, "application/json, application/octet-stream");

  if (!response.ok) {
    throw new UserdataError(
      url,
      response.status,
      response.status === 404
        ? `that instance has no workflow at ${safe}`
        : `HTTP ${response.status} ${response.statusText}`,
      response.status === 404
        ? "Call list_workflows with the same `host` for the workflows it does have."
        : "That instance refused to serve the file.",
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType !== "" && !ACCEPTED_TYPES.some((pattern) => pattern.test(contentType))) {
    throw new UserdataError(
      url,
      response.status,
      `the response is ${JSON.stringify(contentType)}, not a workflow`,
      "A proxy or a login page answering in ComfyUI's place is the usual cause.",
    );
  }

  // Checked before reading, where the server declared a length, and again after
  // — a `content-length` is the remote's claim, and a chunked response makes no
  // claim at all.
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_WORKFLOW_BYTES) {
    throw new UserdataError(url, response.status, tooLarge(declared), CAP_GUIDANCE);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_WORKFLOW_BYTES) {
    throw new UserdataError(url, response.status, tooLarge(bytes.byteLength), CAP_GUIDANCE);
  }
  return bytes;
}

const CAP_GUIDANCE =
  "This server caps a fetched workflow rather than reading a body whose length another " +
  "machine decides. Copy the file across by hand if it is genuinely that large.";

function tooLarge(bytes: number): string {
  return `the workflow is ${bytes} bytes, over this server's ${MAX_WORKFLOW_BYTES}-byte limit`;
}
