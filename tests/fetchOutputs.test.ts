import { afterEach, beforeEach, expect, test } from "./support/testing.ts";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactFilename, fetchArtifacts } from "../src/comfy/fetchOutputs.ts";

/**
 * Copying a run's artifacts from the machine that made them.
 *
 * This is the second place bytes from an HTTP server become a file here — the
 * first is `comfy/userdata.ts` — so what is tested is mostly what it refuses.
 * Every fixture is a `Deno.serve` on an ephemeral loopback port; nothing
 * contacts a ComfyUI.
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

let workdir: string;
let servers: TestServer[] = [];

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "mcp-comfyui-fetched-"));
  servers = [];
});

afterEach(async () => {
  for (const server of servers) await server.stop();
  rmSync(workdir, { recursive: true, force: true });
});

function serve(handler: (request: Request) => Response | Promise<Response>): number {
  const bound = denoServe(handler);
  servers.push(bound);
  return bound.port;
}

/** A `/view` URL of the kind a completed run reports. */
function viewUrl(port: number, filename: string): string {
  return `http://127.0.0.1:${port}/view?filename=${encodeURIComponent(filename)}&subfolder=&type=output`;
}

test("an artifact is written under the destination and reported by URL", async () => {
  const port = serve(() => new Response("png bytes", { headers: { "content-type": "image/png" } }));
  const url = viewUrl(port, "made_00001_.png");

  const fetched = await fetchArtifacts([url], { destination: workdir });

  expect(fetched).toEqual([{ url, path: join(workdir, "made_00001_.png"), problem: null }]);
  expect(readFileSync(join(workdir, "made_00001_.png"), "utf8")).toBe("png bytes");
});

test("one artifact that will not come across does not deny the others", async () => {
  // This runs after a run has already succeeded — the run is the answer, and
  // this is a convenience on top of it — so a single failure must never be
  // allowed to throw away the rest.
  const port = serve((request) =>
    new URL(request.url).searchParams.get("filename") === "good.png"
      ? new Response("good")
      : new Response("", { status: 404 }),
  );
  const good = viewUrl(port, "good.png");
  const gone = viewUrl(port, "gone.png");

  const fetched = await fetchArtifacts([good, gone], { destination: workdir });

  expect(fetched[0]).toMatchObject({ url: good, problem: null });
  expect(fetched[1]).toMatchObject({ url: gone, path: null });
  expect(String(fetched[1]?.problem)).toContain("404");
});

test("an oversized artifact is stopped mid-stream and leaves no partial file", async () => {
  // The cap is on how much disk one tool call may consume on a remote's say-so,
  // and it has to bite while the body is arriving — a `content-length` is the
  // remote's own claim, and a chunked response makes none at all. This fixture
  // streams past the 1 GiB cap without ever declaring a length.
  const chunk = new Uint8Array(1024 * 1024); // 1 MiB of zeroes, sent repeatedly
  const port = serve(
    () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(chunk);
          },
        }),
        { headers: { "content-type": "image/png" } },
      ),
  );

  const fetched = await fetchArtifacts([viewUrl(port, "endless.png")], { destination: workdir });

  expect(fetched[0]?.path).toBeNull();
  expect(String(fetched[0]?.problem)).toContain("limit");
  // A partial file that looks finished is the one outcome worse than none.
  expect(existsSync(join(workdir, "endless.png"))).toBe(false);
  expect(readdirSync(workdir)).toEqual([]);
});

test("a filename that would escape the destination is refused, not sanitised", () => {
  // `filename` is the REMOTE's own string, and this turns it into a path here.
  // A sanitised name is a name the caller did not ask for, written somewhere
  // they cannot predict; a refusal they can read is better than a file they
  // cannot find.
  expect(artifactFilename("http://h/view?filename=ok.png")).toBe("ok.png");
  expect(artifactFilename("http://h/view?filename=" + encodeURIComponent("../../etc/passwd"))).toBeNull();
  expect(artifactFilename("http://h/view?filename=" + encodeURIComponent("a/b.png"))).toBeNull();
  expect(artifactFilename("http://h/view?filename=" + encodeURIComponent("a\\b.png"))).toBeNull();
  expect(artifactFilename("http://h/view?filename=" + encodeURIComponent("C:\\a.png"))).toBeNull();
  expect(artifactFilename("http://h/view?filename=" + encodeURIComponent(".."))).toBeNull();
  expect(artifactFilename("http://h/view?filename=" + encodeURIComponent("a\0.png"))).toBeNull();
  expect(artifactFilename("http://h/view?filename=")).toBeNull();
  expect(artifactFilename("http://h/view")).toBeNull();
  expect(artifactFilename("not a url")).toBeNull();
});

test("a traversing filename writes nothing at all", async () => {
  const port = serve(() => new Response("owned"));
  const url = `http://127.0.0.1:${port}/view?filename=${encodeURIComponent("../escaped.png")}&type=output`;

  const fetched = await fetchArtifacts([url], { destination: join(workdir, "inner") });

  expect(fetched[0]?.path).toBeNull();
  // Not even the destination directory: the refusal happens before anything is
  // created.
  expect(existsSync(join(workdir, "inner"))).toBe(false);
  expect(existsSync(join(workdir, "escaped.png"))).toBe(false);
});

test("something that is not an http URL is refused without a request", async () => {
  const fetched = await fetchArtifacts(["/Users/me/output/a.png"], { destination: workdir });

  expect(fetched[0]).toMatchObject({ path: null });
  expect(readdirSync(workdir)).toEqual([]);
});
