import { afterEach, beforeEach, expect, test } from "./support/testing.ts";
import {
  UserdataError,
  fetchRemoteWorkflow,
  isMissingWorkflow,
  listRemoteWorkflows,
  safeRelativePath,
} from "../src/comfy/userdata.ts";

/**
 * A remote ComfyUI's own saved workflows, over its HTTP API.
 *
 * The fixture answers ComfyUI's real routes, in ComfyUI's real shapes — both
 * taken from `app/user_manager.py` and confirmed against a live 0.30.2 instance
 * (see `docs/comfy-cli-ground-truth.md` #22). Two of them matter enough to
 * restate:
 *
 * - the listing's `path` is relative and always `/`-separated, even on Windows,
 *   because the handler does `relpath(...).replace(os.sep, '/')`;
 * - `/userdata/{file}` is ONE aiohttp path segment, so a nested path arrives
 *   percent-encoded — and the handler unquotes only when it sees a `%`.
 *
 * Nothing here contacts a real ComfyUI. `Deno.serve` on an ephemeral loopback
 * port is the whole world.
 */

interface TestServer {
  readonly port: number;
  stop(): Promise<void>;
}

function denoServe(handler: (request: Request) => Response | Promise<Response>): TestServer {
  const ac = new AbortController();
  const inner = Deno.serve({ hostname: "127.0.0.1", port: 0, signal: ac.signal, onListen: () => {} }, handler);
  return {
    port: (inner.addr as Deno.NetAddr).port,
    stop: async () => {
      ac.abort();
      await inner.finished;
    },
  };
}

let servers: TestServer[] = [];

/** The raw request paths the fixture saw, so a test can assert on the encoding. */
let seen: string[] = [];

beforeEach(() => {
  servers = [];
  seen = [];
});

afterEach(async () => {
  for (const server of servers) await server.stop();
});

function serve(handler: (request: Request) => Response | Promise<Response>): { host: string; port: number } {
  const bound = denoServe((request) => {
    // `request.url` is already decoded by the URL parser; the raw target is
    // what proves the encoding, so it is reconstructed from the original.
    seen.push(new URL(request.url).pathname + new URL(request.url).search);
    return handler(request);
  });
  servers.push(bound);
  return { host: "127.0.0.1", port: bound.port };
}

/** A ComfyUI holding exactly these files, answering both userdata routes. */
function serveLibrary(files: Record<string, string>, opts: { listing?: unknown } = {}) {
  return serve((request) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/userdata") {
      const listing =
        opts.listing ??
        Object.entries(files).map(([path, body]) => ({
          path,
          size: new TextEncoder().encode(body).byteLength,
          modified: 1786069244638,
          created: 1786064269557,
        }));
      return Response.json(listing);
    }
    if (url.pathname.startsWith("/api/userdata/")) {
      // Exactly what aiohttp does: one path segment, decoded once.
      const name = decodeURIComponent(url.pathname.slice("/api/userdata/".length));
      const body = files[name];
      if (body === undefined) return new Response("", { status: 404 });
      return new Response(body, {
        headers: { "content-type": "application/json", "content-disposition": "attachment" },
      });
    }
    return new Response("nf", { status: 404 });
  });
}

// --- the listing ---------------------------------------------------------

test("a listing reports each workflow's path, stem, size and mtime", async () => {
  const target = serveLibrary({ "workflows/portrait.json": `{"nodes":[],"links":[]}` });
  const found = await listRemoteWorkflows(target);

  expect(found).toEqual([
    {
      path: "workflows/portrait.json",
      stem: "portrait",
      sizeBytes: 23,
      modified: new Date(1786069244638).toISOString(),
    },
  ]);
  expect(seen[0]).toContain("dir=workflows");
  expect(seen[0]).toContain("full_info=true");
  expect(seen[0]).toContain("recurse=true");
});

test("a listing is ordered by path, not by whatever the remote filesystem returned", async () => {
  const target = serveLibrary({
    "workflows/zebra.json": "{}",
    "workflows/alpha.json": "{}",
    "workflows/nested/mid.json": "{}",
  });

  expect((await listRemoteWorkflows(target)).map((workflow) => workflow.path)).toEqual([
    "workflows/alpha.json",
    "workflows/nested/mid.json",
    "workflows/zebra.json",
  ]);
});

test("a fresh install with no workflows directory is an empty library, not a failure", async () => {
  // Measured: the live remote answers 404 for a `dir` that is not there, and it
  // genuinely has no saved workflows. A fresh install is not a fault.
  const target = serve(() => new Response("Directory not found", { status: 404 }));

  expect(await listRemoteWorkflows(target)).toEqual([]);
});

test("a listing drops entries this server would not fetch", async () => {
  const target = serveLibrary(
    {},
    {
      listing: [
        { path: "workflows/good.json", size: 2, modified: 1 },
        { path: "workflows/../../etc/passwd.json", size: 2, modified: 1 }, // climbs out
        { path: "/etc/hosts.json", size: 2, modified: 1 }, // absolute
        { path: "C:\\Windows\\a.json", size: 2, modified: 1 }, // drive letter and backslashes
        { path: "workflows/notes.txt", size: 2, modified: 1 }, // not a workflow
      ],
    },
  );

  // The listing is the REMOTE's data. ComfyUI guards its own filesystem with
  // `commonpath`; that protects its disk, not ours, and this server is about to
  // turn whatever it says into a URL and then a filename.
  expect((await listRemoteWorkflows(target)).map((workflow) => workflow.path)).toEqual([
    "workflows/good.json",
  ]);
});

test("an entry with no size or mtime degrades to nulls rather than being dropped", async () => {
  const target = serveLibrary({}, { listing: [{ path: "workflows/bare.json" }] });

  expect(await listRemoteWorkflows(target)).toEqual([
    { path: "workflows/bare.json", stem: "bare", sizeBytes: null, modified: null },
  ]);
});

test("something that is not ComfyUI answering is reported as such", async () => {
  const target = serve(() => new Response("<html>login</html>", { status: 200 }));

  await expect(listRemoteWorkflows(target)).rejects.toThrow(/not JSON/);
});

test("a listing that is not a listing is reported rather than half-read", async () => {
  const target = serve(() => Response.json({ workflows: [] }));

  await expect(listRemoteWorkflows(target)).rejects.toThrow(/not a userdata listing/);
});

test("a refused connection names the address rather than the stack", async () => {
  const bound = denoServe(() => new Response(""));
  const port = bound.port;
  await bound.stop();

  const error = (await listRemoteWorkflows({ host: "127.0.0.1", port }).catch((err) => err)) as UserdataError;
  expect(error).toBeInstanceOf(UserdataError);
  expect(error.message).toContain(`127.0.0.1:${port}`);
  expect(error.status).toBeNull();
});

// --- fetching ------------------------------------------------------------

test("a fetched workflow is byte-exact, including a 2^64-1 seed", async () => {
  // Landmine #1 on new ground. The local path is a byte copy and is already
  // pinned; this is the first time a graph reaches `comfy` over HTTP, and a
  // `JSON.parse` anywhere on that route would turn 18446744073709551615 into
  // 18446744073709552000 — silently, and for seeds nobody asked to change.
  const graph = `{"nodes":[{"id":3,"widgets_values":[18446744073709551615]}],"links":[]}`;
  const target = serveLibrary({ "workflows/seeded.json": graph });

  const bytes = await fetchRemoteWorkflow("workflows/seeded.json", target);

  expect(new TextDecoder().decode(bytes)).toBe(graph);
  expect(bytes.byteLength).toBe(new TextEncoder().encode(graph).byteLength);
});

test("the path travels as one percent-encoded segment", async () => {
  // `/userdata/{file}` is a single aiohttp path segment, and the handler
  // unquotes only when the name holds a `%` — so the encoding is required, not
  // merely tolerated.
  const target = serveLibrary({ "workflows/a b.json": "{}" });

  await fetchRemoteWorkflow("workflows/a b.json", target);

  const request = seen.find((path) => path.startsWith("/api/userdata/")) as string;
  expect(request).toBe("/api/userdata/workflows%2Fa%20b.json");
  expect(request).not.toContain("/api/userdata/workflows/");
});

test("a workflow the host does not have is distinguishable from a host that is down", async () => {
  const target = serveLibrary({ "workflows/real.json": "{}" });

  const error = await fetchRemoteWorkflow("workflows/ghost.json", target).catch((err) => err);
  expect(isMissingWorkflow(error)).toBe(true);
  expect((error as Error).message).toContain("no workflow at workflows/ghost.json");
});

test("a path that climbs out is refused before a request is made", async () => {
  const target = serveLibrary({});

  await expect(fetchRemoteWorkflow("../../etc/passwd", target)).rejects.toThrow(/relative path/);
  expect(seen).toEqual([]);
});

test("a response that is not a workflow is refused rather than run", async () => {
  // The realistic failure: a proxy or an SSO page answering in ComfyUI's place
  // with a 200 and some HTML. These bytes would otherwise become a file that
  // `comfy` is asked to run.
  const target = serve(
    () => new Response("<html>sign in</html>", { headers: { "content-type": "text/html" } }),
  );

  await expect(fetchRemoteWorkflow("workflows/a.json", target)).rejects.toThrow(/text\/html/);
});

test("an oversized workflow is refused rather than read into memory unbounded", async () => {
  // The measured largest workflow on this machine is 122 KB, against an 8 MiB
  // cap; this serves 8 MiB + 1. The *declared*-length pre-check cannot be
  // exercised from here — Deno computes `content-length` from the real body and
  // will not let a `Response` lie about it — so what is pinned is the check
  // that always fires, on the bytes that actually arrived.
  const oversized = "x".repeat(8 * 1024 * 1024 + 1);
  const target = serve(
    () => new Response(oversized, { headers: { "content-type": "application/json" } }),
  );

  await expect(fetchRemoteWorkflow("workflows/huge.json", target)).rejects.toThrow(/limit/);
});

// --- the path rule -------------------------------------------------------

test("safeRelativePath accepts a relative path and refuses everything else", () => {
  expect(safeRelativePath("workflows/a.json")).toBe("workflows/a.json");
  expect(safeRelativePath("  workflows/a.json  ")).toBe("workflows/a.json");
  expect(safeRelativePath("a.json")).toBe("a.json");

  expect(safeRelativePath("")).toBeNull();
  expect(safeRelativePath("/etc/passwd")).toBeNull();
  expect(safeRelativePath("C:/Windows/a.json")).toBeNull();
  expect(safeRelativePath("workflows\\a.json")).toBeNull();
  expect(safeRelativePath("workflows/../a.json")).toBeNull();
  expect(safeRelativePath("./a.json")).toBeNull();
  expect(safeRelativePath("workflows//a.json")).toBeNull();
  expect(safeRelativePath("a\0.json")).toBeNull();
});
