import { afterEach, beforeEach, expect, sleep, test } from "./support/testing.ts";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  ObjectInfoCacheWriteError,
  ObjectInfoFetchError,
  ensureObjectInfoCache,
  getObjectInfo,
  objectInfoCachePath,
  readStaleCache,
} from "../src/comfy/objectInfo.ts";

/**
 * No test in this file may contact a real ComfyUI, and none may read or write
 * the operator's real `~/.cache`: every call passes an explicit `cacheDir`
 * under a fresh temp directory, and every fetch goes to a hermetic server on an
 * ephemeral port.
 */
const FIXTURE = join(import.meta.dirname, "fixtures", "object_info.sample.json");
const PAYLOAD = readFileSync(FIXTURE, "utf8");

type Handler = (request: Request) => Response | Promise<Response>;

/**
 * A `{port, stop}` pair wrapping the raw `Deno.HttpServer`, so callers get a
 * bound port number without reaching into `Deno.serve`'s return shape.
 * `stop(true)` (this file only ever forces) aborts the `signal` the server
 * was created with rather than calling `.shutdown()`, which matters for a
 * handler that never resolves — the "a server that never answers" tests
 * below install exactly one. Measured directly: `.shutdown()` awaits every
 * in-flight request and hangs forever against such a handler, while
 * aborting via `signal` resolves `.finished` immediately and frees the port
 * for the next test's `serve()`.
 */
interface TestServer {
  readonly port: number;
  stop(force?: boolean): Promise<void>;
}

let cacheDir: string;
let server: TestServer | null = null;
let requests: string[] = [];

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "mcp-comfyui-objectinfo-"));
  requests = [];
});

afterEach(async () => {
  await server?.stop(true); // force: a hung handler must not keep the suite open
  server = null;
  rmSync(cacheDir, { recursive: true, force: true });
});

function denoServe(handler: Handler, hostname: string): TestServer {
  const ac = new AbortController();
  const inner = Deno.serve({ hostname, port: 0, signal: ac.signal, onListen: () => {} }, handler);
  const port = (inner.addr as Deno.NetAddr).port;
  return {
    port,
    stop: async () => {
      ac.abort();
      await inner.finished;
    },
  };
}

/** Start a loopback server on an ephemeral port and hand back that port. */
function serve(handler: Handler = () => json(PAYLOAD), hostname = "127.0.0.1"): number {
  server = denoServe((request) => {
    requests.push(new URL(request.url).pathname);
    return handler(request);
  }, hostname);
  return portOf(server);
}

function portOf(bound: TestServer): number {
  const { port } = bound;
  if (port === undefined) throw new Error("test server did not bind a port");
  return port;
}

function json(body: string): Response {
  return new Response(body, { headers: { "content-type": "application/json" } });
}

/** A port nothing is listening on: bind one, then give it back. */
async function closedPort(): Promise<number> {
  const throwaway = denoServe(() => new Response(""), "127.0.0.1");
  const port = portOf(throwaway);
  await throwaway.stop(true);
  return port;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected getObjectInfo to reject, but it resolved");
}

/** Backdate the cache file so it reads as `ageMs` old. */
function age(path: string, ageMs: number): void {
  const when = new Date(Date.now() - ageMs);
  utimesSync(path, when, when);
}

test("fetches and returns the parsed payload", async () => {
  const port = serve();
  const info = await getObjectInfo({ port, cacheDir });

  expect(info["KSampler"]).toBeDefined();
  expect(info["EmptyLatentImage"]).toBeDefined();
  expect(requests).toEqual(["/object_info"]);
});

test("creates the cache directory on first run", async () => {
  // `~/.cache/mcp-comfyui` does not exist on a fresh machine.
  const port = serve();
  const fresh = join(cacheDir, "nested", "dir");
  const info = await getObjectInfo({ port, cacheDir: fresh });

  expect(info["KSampler"]).toBeDefined();
  expect(existsSync(objectInfoCachePath({ port, cacheDir: fresh }))).toBe(true);
});

test("a cache newer than the TTL is used without a second fetch", async () => {
  const port = serve();
  const first = await getObjectInfo({ port, cacheDir });
  const second = await getObjectInfo({ port, cacheDir });

  expect(requests).toHaveLength(1); // the second call never reached the server
  expect(second).toEqual(first);
});

test("refresh refetches even with a warm cache", async () => {
  const port = serve();
  await getObjectInfo({ port, cacheDir });
  const refreshed = await getObjectInfo({ port, cacheDir, refresh: true });

  expect(requests).toHaveLength(2);
  expect(refreshed["KSampler"]).toBeDefined();
});

test("a cache older than the TTL refetches", async () => {
  const port = serve();
  await getObjectInfo({ port, cacheDir, ttlMs: 60_000 });
  age(objectInfoCachePath({ port, cacheDir }), 2 * 60 * 60 * 1000);
  await getObjectInfo({ port, cacheDir, ttlMs: 60_000 });

  expect(requests).toHaveLength(2);
});

test("the default TTL expires a day-old cache", async () => {
  // Node sets only change when custom nodes or models are installed, so the
  // default is deliberately long — but it is not forever.
  const port = serve();
  await getObjectInfo({ port, cacheDir });
  age(objectInfoCachePath({ port, cacheDir }), 48 * 60 * 60 * 1000);
  await getObjectInfo({ port, cacheDir });

  expect(requests).toHaveLength(2);
});

test("a corrupt cache file is discarded and refetched, not thrown from", async () => {
  // The realistic state after a crash mid-write of a 1.7MB payload.
  const port = serve();
  const path = objectInfoCachePath({ port, cacheDir });
  writeFileSync(path, "{ not json");

  const info = await getObjectInfo({ port, cacheDir });

  expect(info["KSampler"]).toBeDefined();
  expect(requests).toHaveLength(1);
  expect(JSON.parse(readFileSync(path, "utf8"))["KSampler"]).toBeDefined(); // repaired
});

test("a cache file holding a JSON array is discarded, not returned", async () => {
  const port = serve();
  const path = objectInfoCachePath({ port, cacheDir });
  writeFileSync(path, "[]");

  const info = await getObjectInfo({ port, cacheDir });

  expect(info["KSampler"]).toBeDefined();
  expect(requests).toHaveLength(1);
});

test("a cache file dated in the future is refetched, not trusted forever", async () => {
  // A clock change or a restored archive makes the age negative, which a plain
  // `age >= ttlMs` test reads as permanently fresh.
  const port = serve();
  await getObjectInfo({ port, cacheDir });
  age(objectInfoCachePath({ port, cacheDir }), -365 * 24 * 60 * 60 * 1000);
  await getObjectInfo({ port, cacheDir });

  expect(requests).toHaveLength(2);
});

test("0.0.0.0 is rewritten to 127.0.0.1 in the fetch URL", async () => {
  // A wildcard bind address is not a connect address. Asserting on the error
  // text pins the rewrite even on platforms where connecting to 0.0.0.0 happens
  // to reach loopback anyway.
  const port = await closedPort();
  const err = await rejection(getObjectInfo({ host: "0.0.0.0", port, cacheDir }));

  expect(err).toBeInstanceOf(ObjectInfoFetchError);
  expect((err as ObjectInfoFetchError).url).toBe(`http://127.0.0.1:${port}/object_info`);
  expect((err as Error).message).not.toContain("0.0.0.0");
});

test("0.0.0.0 and 127.0.0.1 share one cache entry", async () => {
  const port = serve();
  expect(objectInfoCachePath({ host: "0.0.0.0", port, cacheDir })).toBe(
    objectInfoCachePath({ host: "127.0.0.1", port, cacheDir }),
  );

  await getObjectInfo({ host: "0.0.0.0", port, cacheDir });
  await getObjectInfo({ host: "127.0.0.1", port, cacheDir });

  expect(requests).toHaveLength(1); // the same instance, so the same cache
});

test("an IPv6 host is bracketed in the fetch URL", async () => {
  // `http://::1:8188/object_info` is rejected by fetch as an invalid URL.
  const port = serve(() => json(PAYLOAD), "::1");
  const info = await getObjectInfo({ host: "::1", port, cacheDir });

  expect(info["KSampler"]).toBeDefined();
  expect(requests).toHaveLength(1);
});

test("the IPv6 wildcard is rewritten like 0.0.0.0", async () => {
  const port = serve();
  expect(objectInfoCachePath({ host: "[::]", port, cacheDir })).toBe(
    objectInfoCachePath({ host: "127.0.0.1", port, cacheDir }),
  );

  const info = await getObjectInfo({ host: "::", port, cacheDir });

  expect(info["KSampler"]).toBeDefined(); // reached the loopback server, not `::`
});

test("a refused connection throws a typed error naming the URL and the cache path", async () => {
  const port = await closedPort();
  const err = await rejection(getObjectInfo({ port, cacheDir }));

  expect(err).toBeInstanceOf(ObjectInfoFetchError);
  expect((err as Error).message).toContain(`http://127.0.0.1:${port}/object_info`);
  // An intact earlier copy may be sitting there: this call will not serve it,
  // but `comfy workflow slots --input` still can.
  expect((err as ObjectInfoFetchError).cachePath).toBe(objectInfoCachePath({ port, cacheDir }));
  expect((err as Error).message).toContain(objectInfoCachePath({ port, cacheDir }));
});

test("a failed fetch does not poison later calls for the same instance", async () => {
  // The in-flight entry has to be cleared on failure too, or one bad fetch
  // wedges this instance until the process restarts.
  let calls = 0;
  const port = serve(() => (++calls === 1 ? new Response("boom", { status: 503 }) : json(PAYLOAD)));

  await rejection(getObjectInfo({ port, cacheDir }));

  expect((await getObjectInfo({ port, cacheDir }))["KSampler"]).toBeDefined();
});

test("a non-200 response throws a typed error including the status code", async () => {
  const port = serve(() => new Response("nope", { status: 503 }));
  const err = await rejection(getObjectInfo({ port, cacheDir }));

  expect(err).toBeInstanceOf(ObjectInfoFetchError);
  expect((err as ObjectInfoFetchError).status).toBe(503);
  expect((err as Error).message).toContain("503");
  expect((err as Error).message).toContain(`http://127.0.0.1:${port}/object_info`);
});

test("an HTML error page is rejected rather than cached as if valid", async () => {
  const port = serve(
    () =>
      new Response("<html><body>502 Bad Gateway</body></html>", {
        headers: { "content-type": "text/html" },
      }),
  );
  const err = await rejection(getObjectInfo({ port, cacheDir }));

  expect(err).toBeInstanceOf(ObjectInfoFetchError);
  expect(existsSync(objectInfoCachePath({ port, cacheDir }))).toBe(false);
});

test("a JSON array is rejected rather than cached as if valid", async () => {
  const port = serve(() => json("[]"));
  const err = await rejection(getObjectInfo({ port, cacheDir }));

  expect(err).toBeInstanceOf(ObjectInfoFetchError);
  expect(existsSync(objectInfoCachePath({ port, cacheDir }))).toBe(false);
});

test("an empty node set is rejected rather than cached as if valid", async () => {
  // A server that answers with no node types is broken or still booting;
  // caching that for a day would poison offline introspection.
  const port = serve(() => json("{}"));
  const err = await rejection(getObjectInfo({ port, cacheDir }));

  expect(err).toBeInstanceOf(ObjectInfoFetchError);
  expect(existsSync(objectInfoCachePath({ port, cacheDir }))).toBe(false);
});

test("a server that never answers times out with a typed error", async () => {
  const port = serve(() => new Promise<Response>(() => {}));
  const err = await rejection(getObjectInfo({ port, cacheDir, timeoutMs: 100 }));

  expect(err).toBeInstanceOf(ObjectInfoFetchError);
  expect((err as Error).message).toContain(`http://127.0.0.1:${port}/object_info`);
});

test("a timeout says the server is slow, not that it is unreachable", async () => {
  // On a timeout ComfyUI *is* running and reachable — it is loading models.
  // Naming the budget is also what tells the operator timeoutMs exists.
  const port = serve(() => new Promise<Response>(() => {}));
  const err = await rejection(getObjectInfo({ port, cacheDir, timeoutMs: 100 }));
  const message = (err as Error).message;

  expect(message).toContain("100ms");
  expect(message).toContain("loading models");
  expect(message).not.toContain("Is ComfyUI running");
});

test("a cache that cannot be written fails loudly and leaves no temp file", async () => {
  const port = serve();
  const readOnly = join(cacheDir, "read-only");
  mkdirSync(readOnly);
  chmodSync(readOnly, 0o555);

  try {
    const err = await rejection(getObjectInfo({ port, cacheDir: readOnly }));

    expect(err).toBeInstanceOf(ObjectInfoCacheWriteError);
    // The cache path the operator can act on, never the temp name this module
    // invented and they have never seen.
    expect((err as Error).message).toContain(objectInfoCachePath({ port, cacheDir: readOnly }));
    expect((err as Error).message).not.toContain(".tmp");
    expect(readdirSync(readOnly)).toEqual([]);
  } finally {
    chmodSync(readOnly, 0o755); // or the suite cannot clean up after itself
  }
});

test("a write that fails after the temp file exists does not litter the cache dir", async () => {
  // The read-only case never gets as far as creating a temp. This one does:
  // the payload is written, and only the swap into place fails. A SIGKILL in
  // the same window is what orphans 1.7MB with nobody to sweep it.
  const port = serve();
  mkdirSync(objectInfoCachePath({ port, cacheDir })); // a directory where the file goes

  const err = await rejection(getObjectInfo({ port, cacheDir }));

  expect(err).toBeInstanceOf(ObjectInfoCacheWriteError);
  expect(readdirSync(cacheDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

test("the cache file is valid JSON that round-trips, so it can feed --input", async () => {
  const port = serve();
  const info = await getObjectInfo({ port, cacheDir });
  const path = objectInfoCachePath({ port, cacheDir });

  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(info);
});

test("ensureObjectInfoCache returns a path whose contents are current", async () => {
  // `objectInfoCachePath` alone would hand back the path of a year-old file.
  const port = serve();
  const path = objectInfoCachePath({ port, cacheDir });
  writeFileSync(path, "{ not json");

  const ensured = await ensureObjectInfoCache({ port, cacheDir });

  expect(ensured).toBe(path);
  expect(JSON.parse(readFileSync(ensured, "utf8"))["KSampler"]).toBeDefined();
});

test("the cache is swapped into place, never rewritten where a reader can see it", async () => {
  // The cached file is handed to `comfy workflow slots --input`, so another
  // process may be reading it at any moment. Rewriting 1.7MB in place would let
  // that reader see a truncated payload; a temp file plus a rename cannot. The
  // observable consequence is that a rewrite lands on a new inode.
  const port = serve();
  const path = objectInfoCachePath({ port, cacheDir });
  await getObjectInfo({ port, cacheDir });
  const before = statSync(path).ino;

  await getObjectInfo({ port, cacheDir, refresh: true });

  expect(statSync(path).ino).not.toBe(before);
  // And the swap leaves nothing behind: an orphaned temp is 1.7MB nobody sweeps.
  expect(readdirSync(cacheDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

test("the cache path is stable and derived from host and port", async () => {
  const path = objectInfoCachePath({ host: "127.0.0.1", port: 8188, cacheDir });

  expect(path).toBe(objectInfoCachePath({ host: "127.0.0.1", port: 8188, cacheDir }));
  expect(basename(path)).toContain("127.0.0.1");
  expect(basename(path)).toContain("8188");
  expect(path).not.toBe(objectInfoCachePath({ host: "127.0.0.1", port: 8189, cacheDir }));
  expect(path).not.toBe(objectInfoCachePath({ host: "10.0.0.5", port: 8188, cacheDir }));
});

test("host and port default to 127.0.0.1:8188", () => {
  expect(objectInfoCachePath({ cacheDir })).toBe(
    objectInfoCachePath({ host: "127.0.0.1", port: 8188, cacheDir }),
  );
});

test("a host is sanitised before it becomes a filename", () => {
  // The host is operator-supplied and lands in a path.
  const path = objectInfoCachePath({ host: "../../../etc/passwd", port: 8188, cacheDir });

  expect(dirname(path)).toBe(cacheDir);
  expect(basename(path)).toBe("object_info-.._.._.._etc_passwd-8188.json");
});

test("concurrent cold-cache calls fetch once", async () => {
  const port = serve();
  const [a, b] = await Promise.all([
    getObjectInfo({ port, cacheDir }),
    getObjectInfo({ port, cacheDir }),
  ]);

  expect(requests).toHaveLength(1); // one fetch of 1.7MB, not two
  expect(a).toEqual(b);
});

test("refresh never joins a fetch already in flight", async () => {
  // Joining would hand the refreshing caller the very copy it asked to bypass,
  // and would silently substitute the leader's timeout for its own.
  const port = serve(async () => {
    await sleep(60);
    return json(PAYLOAD);
  });
  const leader = getObjectInfo({ port, cacheDir });
  await sleep(10);
  const refreshing = getObjectInfo({ port, cacheDir, refresh: true });
  await Promise.all([leader, refreshing]);

  expect(requests).toHaveLength(2);
});

test("readStaleCache serves a file older than any TTL, and reports its age", async () => {
  // The whole point of the floor: the diagnostic tools are needed exactly when
  // ComfyUI is down, which is exactly when the cache has had time to age out.
  const path = objectInfoCachePath({ port: 8188, cacheDir });
  writeFileSync(path, JSON.stringify({ KSampler: { input: {} } }));
  age(path, 14 * 24 * 60 * 60 * 1000);

  const hit = await readStaleCache({ port: 8188, cacheDir });

  expect(hit).not.toBeNull();
  expect(hit!.path).toBe(path);
  expect(hit!.objectInfo["KSampler"]).toBeDefined();
  expect(hit!.ageMs).toBeGreaterThan(13 * 24 * 60 * 60 * 1000);
});

test("readStaleCache never fetches — no cache file means null, not a request", async () => {
  // The defect this replaces: getObjectInfo is not a cache read. On a miss it
  // falls through to a live fetch whatever the TTL said, so using it as the
  // fallback would mean a second 30-second wait before re-throwing.
  const port = serve();

  const hit = await readStaleCache({ port, cacheDir });

  expect(hit).toBeNull();
  expect(requests).toHaveLength(0);
});

test("readStaleCache treats an unreadable cache as a miss, not a throw", async () => {
  const path = objectInfoCachePath({ port: 8188, cacheDir });
  writeFileSync(path, "{ truncated mid-wr");

  expect(await readStaleCache({ port: 8188, cacheDir })).toBeNull();
});

test("a finished fetch does not evict another that is still running", async () => {
  // Two entries can be live for one path once refresh stops joining, so the
  // in-flight entry must be cleared by identity: deleting by key lets whoever
  // finishes first strand the callers waiting on the other one.
  let calls = 0;
  const port = serve(async () => {
    calls += 1;
    if (calls === 1) {
      await sleep(60); // the leader: fails, but only after the refresh starts
      return new Response("boom", { status: 503 });
    }
    await sleep(250); // the refresh: still running when the leader cleans up
    return json(PAYLOAD);
  });

  const leader = getObjectInfo({ port, cacheDir });
  await sleep(10); // the leader is registered
  const refreshing = getObjectInfo({ port, cacheDir, refresh: true }); // replaces the entry
  await rejection(leader); // its cleanup must leave the refresh's entry alone

  const joiner = getObjectInfo({ port, cacheDir }); // cache still cold: must join
  await Promise.all([refreshing, joiner]);

  expect(requests).toHaveLength(2); // not three
});
