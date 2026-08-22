import { afterEach, beforeEach, expect, test } from "./support/testing.ts";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactFilename, fetchArtifacts, type FetchBudget } from "../src/comfy/fetchOutputs.ts";

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

  expect(fetched).toEqual([{ url, outcome: "fetched", path: join(workdir, "made_00001_.png") }]);
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

  expect(fetched[0]).toMatchObject({ url: good, outcome: "fetched" });
  expect(fetched[1]).toMatchObject({ url: gone, outcome: "failed" });
  expect(String((fetched[1] as { problem?: string }).problem)).toContain("404");
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

  // A ceiling is a limit, not a fault: exceeding one is something this server
  // DECLINED to do, and the caller's next move differs from a fetch that broke.
  expect(fetched[0]?.outcome).toBe("skipped");
  expect(String((fetched[0] as { reason?: string }).reason)).toContain("limit");
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

  expect(fetched[0]?.outcome).toBe("failed");
  // Not even the destination directory: the refusal happens before anything is
  // created.
  expect(existsSync(join(workdir, "inner"))).toBe(false);
  expect(existsSync(join(workdir, "escaped.png"))).toBe(false);
});

test("something that is not an http URL is refused without a request", async () => {
  const fetched = await fetchArtifacts(["/Users/me/output/a.png"], { destination: workdir });

  expect(fetched[0]).toMatchObject({ outcome: "failed" });
  expect(readdirSync(workdir)).toEqual([]);
});

test("an artifact already on disk is not downloaded again", async () => {
  // `get_job` on a COMPLETED job is callable any number of times, and once
  // fetching is automatic that makes ten polls ten downloads of bytes already
  // here. Reuse is safe on two invariants this module already maintains: the
  // destination is keyed by prompt_id AND filename, so an existing file is
  // this artifact rather than a namesake; and a partial file never survives,
  // because every failure path removes what it wrote — so anything on disk is
  // a complete previous fetch.
  //
  // Mutant: delete the `stat` reuse. This test dies on requests === 2.
  let requests = 0;
  const port = serve(() => {
    requests += 1;
    return new Response("png bytes", { headers: { "content-type": "image/png" } });
  });
  const url = viewUrl(port, "made_00001_.png");

  const first = await fetchArtifacts([url], { destination: workdir });
  const second = await fetchArtifacts([url], { destination: workdir });

  expect(requests).toBe(1);
  expect(first[0]?.outcome).toBe("fetched");
  expect(second[0]?.outcome).toBe("fetched");
  expect((second[0] as { path: string }).path).toBe(join(workdir, "made_00001_.png"));
  expect(readFileSync(join(workdir, "made_00001_.png"), "utf8")).toBe("png bytes");
});

test("an artifact larger than this call's ceiling is skipped before a byte is written", async () => {
  // The ceiling exists so an automatic fetch never drags a video across a
  // tailnet. Discovering the size by DOWNLOADING it would defeat that: the
  // point is to not move the bytes. `content-length` is checked first and the
  // body abandoned unread. (Measured: `Deno.serve` does set `content-length`
  // for a fixed-string body, so the pre-check really is what fires here.)
  //
  // Mutant: drop the content-length pre-check and rely on the streaming cap.
  //
  // What kills that mutant is the REASON STRING, not the empty directory.
  // Measured: both the correct code and that mutant leave `workdir` empty,
  // because the streaming-cap path also removes its partial file. Only the
  // pre-check's message carries the declared size. Do not "simplify" the 5000
  // assertion away — it is the entire discriminator.
  const port = serve(() => new Response("x".repeat(5_000), { headers: { "content-type": "image/png" } }));

  const fetched = await fetchArtifacts([viewUrl(port, "big.png")], { destination: workdir, maxBytes: 100 });

  expect(fetched[0]?.outcome).toBe("skipped");
  expect(String((fetched[0] as { reason?: string }).reason)).toContain("5000");
  expect(readdirSync(workdir)).toEqual([]);
});

test("a ceiling is a limit, not a failure: a skip is not reported as a problem", async () => {
  // A deliberate skip and a fetch that broke are different facts, and this
  // codebase does not report them alike — the caller's next move differs.
  //
  // Mutant: return a `failed` outcome for the oversize case. Dies here.
  const port = serve(() => new Response("x".repeat(5_000)));

  const fetched = await fetchArtifacts([viewUrl(port, "big.png")], { destination: workdir, maxBytes: 100 });

  expect(fetched[0]?.outcome).not.toBe("failed");
});

test("the streaming cap enforces the ceiling when no content-length is declared", async () => {
  // A streamed response declares no length, so the header cannot be the
  // guarantee — the in-loop check is.
  //
  // Deliberately NOT named "a lying content-length": measured, that case
  // cannot be built here at all. A `Deno.serve` response understating the
  // length makes the client throw and receive nothing; a raw-socket one makes
  // `fetch` silently truncate to the declared count. `written` can therefore
  // never exceed a declared header, and only an OVERSTATED header is
  // reachable — whose failure mode is a false skip, disclosed, never a corrupt
  // file.
  //
  // The body is FINITE and larger than the ceiling, on purpose. An endless
  // always-ready stream starves the event loop: measured, with the cap removed
  // the read/write loop ran 6-8s and 935MB without ever observing an
  // `AbortSignal.timeout`, so the mutant would HANG the suite rather than fail
  // it. A finite body ends, the file lands, and the assertion fails cleanly.
  //
  // Mutant: delete the `written > maxBytes` check. Dies on the file existing.
  const chunk = new Uint8Array(1024);
  const port = serve(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (let i = 0; i < 16; i++) controller.enqueue(chunk); // 16 KiB total
            controller.close();
          },
        }),
        { headers: { "content-type": "image/png" } },
      ),
  );

  const fetched = await fetchArtifacts([viewUrl(port, "streamed.png")], {
    destination: workdir,
    maxBytes: 4096,
  });

  expect(fetched[0]?.outcome).toBe("skipped");
  expect(readdirSync(workdir)).toEqual([]);
});

// --- the shared copy budget ----------------------------------------------

/**
 * A server whose `/view` returns exactly `size` bytes, declaring the length
 * honestly — which is what the pre-check reads to decline a copy without
 * moving it. Measured: 75 MiB over loopback costs about 50ms, so exercising a
 * real 64 MiB allowance with real bytes is cheap.
 */
function serveSized(sizes: Record<string, number>): number {
  const chunk = new Uint8Array(64 * 1024);
  return serve((request) => {
    const size = sizes[new URL(request.url).searchParams.get("filename") ?? ""];
    if (size === undefined) return new Response("", { status: 404 });
    let sent = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (sent >= size) return void controller.close();
        const take = Math.min(chunk.byteLength, size - sent);
        sent += take;
        controller.enqueue(chunk.subarray(0, take));
      },
    });
    return new Response(body, {
      headers: { "content-length": String(size), "content-type": "image/png" },
    });
  });
}

/** A server that sends `size` bytes and declares no length at all. */
function serveUndeclared(size: number): number {
  const chunk = new Uint8Array(64 * 1024);
  return serve(() => {
    let sent = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (sent >= size) return void controller.close();
        const take = Math.min(chunk.byteLength, size - sent);
        sent += take;
        controller.enqueue(chunk.subarray(0, take));
      },
    });
    return new Response(body, { headers: { "content-type": "image/png" } });
  });
}

const MiB = 1024 * 1024;

function budgetOf(total: number): FetchBudget {
  return { remaining: total, total };
}

test("a shared budget is spent across calls, not reset by each one", async () => {
  // The whole point of the type. `run_sweep` calls `fetchArtifacts` once per
  // variant, and the ceiling that matters is the one across all of them —
  // sixteen variants of 3 MB each is nearly 50 MB from a call that asked for
  // none of it, and every single artifact is inside the per-artifact ceiling.
  //
  // Mutant: make the budget per call rather than shared. Dies because the
  // fourth artifact comes across.
  const port = serveSized({ "a.png": 4 * MiB, "b.png": 4 * MiB, "c.png": 4 * MiB, "d.png": 4 * MiB });
  const budget = budgetOf(10 * MiB);

  const outcomes = [];
  for (const name of ["a.png", "b.png", "c.png", "d.png"]) {
    const [one] = await fetchArtifacts([viewUrl(port, name)], { destination: workdir, budget });
    outcomes.push(one?.outcome);
  }

  // Two fit, the third would not, and everything after it is refused outright.
  expect(outcomes).toEqual(["fetched", "fetched", "skipped", "skipped"]);
  expect(readdirSync(workdir).sort()).toEqual(["a.png", "b.png"]);
});

test("artifacts are spent in the order they are asked for", async () => {
  // Which artifacts came across has to be deterministic — a caller comparing
  // sixteen variants needs to know it was the first four, not four of them.
  const port = serveSized({ "a.png": 6 * MiB, "b.png": 6 * MiB, "c.png": 6 * MiB });
  const budget = budgetOf(13 * MiB);

  const fetched = await fetchArtifacts(
    ["a.png", "b.png", "c.png"].map((name) => viewUrl(port, name)),
    { destination: workdir, budget },
  );

  expect(fetched.map((one) => one.outcome)).toEqual(["fetched", "fetched", "skipped"]);
});

test("an artifact that will not fit is declined without moving a byte", async () => {
  // The budget is enforced where the per-artifact ceiling already is: against
  // the remote's declared content-length, before the body is read. A 15 MiB
  // file against 4 MiB of remaining allowance must cost nothing at all.
  //
  // Mutant: check the budget only after streaming. Dies on the partial file,
  // which would exist and then be removed — but the bytes would have moved.
  const port = serveSized({ "big.png": 15 * MiB });
  const budget = budgetOf(4 * MiB);

  const [one] = await fetchArtifacts([viewUrl(port, "big.png")], { destination: workdir, budget });

  expect(one?.outcome).toBe("skipped");
  expect(existsSync(join(workdir, "big.png"))).toBe(false);
  // Nothing was spent, so a smaller artifact after it still comes across.
  expect(budget.remaining).toBe(4 * MiB);
});

test("the two limits are told apart in the reason they give", async () => {
  // A single artifact past the ceiling is a big file; a run of them past the
  // budget is a lot of ordinary ones, and the earlier ones already arrived.
  // The next move differs, so the message has to.
  const port = serveSized({ "big.png": 15 * MiB, "small.png": 1 * MiB });

  const [ceiling] = await fetchArtifacts([viewUrl(port, "big.png")], {
    destination: workdir,
    maxBytes: 2 * MiB,
    budget: budgetOf(64 * MiB),
  });
  const [spent] = await fetchArtifacts([viewUrl(port, "small.png")], {
    destination: workdir,
    budget: { remaining: 0, total: 64 * MiB },
  });

  expect(ceiling?.outcome === "skipped" && ceiling.reason).toContain("limit");
  expect(spent?.outcome === "skipped" && spent.reason).toContain("budget");
  expect(spent?.outcome === "skipped" && spent.reason).toContain(String(64 * MiB));
});

test("the budget is charged what landed, not what was declared", async () => {
  // A remote may overstate its length, and the budget's job is to bound the
  // bytes this call actually brings here.
  //
  // Mutant: subtract the declared length. Dies on the remaining count.
  const port = serveSized({ "a.png": 3 * MiB });
  const budget = budgetOf(10 * MiB);

  await fetchArtifacts([viewUrl(port, "a.png")], { destination: workdir, budget });

  expect(budget.remaining).toBe(7 * MiB);
});

test("an artifact with no declared length is charged after the fact", async () => {
  // `content-length` is optional. With none there is nothing to check in
  // advance, so the artifact is fetched under the per-artifact ceiling and the
  // budget is charged what landed — which can overshoot, by at most one
  // ceiling's worth, and is then read as spent.
  const port = serveUndeclared(3 * MiB);
  const budget = budgetOf(1 * MiB);

  const [one] = await fetchArtifacts([viewUrl(port, "a.png")], { destination: workdir, budget });

  expect(one?.outcome).toBe("fetched");
  expect(budget.remaining).toBeLessThan(0);
  // ...and the overshoot stops the next one rather than compounding.
  const [next] = await fetchArtifacts([viewUrl(port, "b.png")], { destination: workdir, budget });
  expect(next?.outcome).toBe("skipped");
});

test("no budget at all leaves every existing call behaving exactly as it did", async () => {
  // `budget` is optional, and a single run passes none: the per-artifact
  // ceiling is the only bound there, and adding a second one silently would
  // change what `run_workflow` and `get_job` have always done.
  const port = serveSized({ "a.png": 20 * MiB });

  const [one] = await fetchArtifacts([viewUrl(port, "a.png")], { destination: workdir });

  expect(one?.outcome).toBe("fetched");
});

test("an artifact already on disk is handed back without spending the budget", async () => {
  // A reuse moves no bytes. Charging for it would let a sweep polled twice
  // exhaust an allowance it never actually used.
  const port = serveSized({ "a.png": 3 * MiB });
  const budget = budgetOf(10 * MiB);

  await fetchArtifacts([viewUrl(port, "a.png")], { destination: workdir, budget });
  const spentOnce = budget.remaining;
  const [again] = await fetchArtifacts([viewUrl(port, "a.png")], { destination: workdir, budget });

  expect(again?.outcome).toBe("fetched");
  expect(budget.remaining).toBe(spentOnce);
});
