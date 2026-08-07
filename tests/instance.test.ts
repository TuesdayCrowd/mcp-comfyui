import { afterEach, beforeEach, expect, sleep, test } from "./support/testing.ts";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComfyCliError, ComfyUnavailableError } from "../src/comfy/exec.ts";
import {
  InstanceUnavailableError,
  LaunchArgumentError,
  LaunchFailedError,
  LaunchTimeoutError,
  detectInstance,
  ensureInstance,
  launchInstance,
  type InstanceDetection,
  type RunningInstance,
} from "../src/comfy/instance.ts";

/**
 * No test in this file may contact a real ComfyUI, invoke the real `comfy`, or
 * leave a long-lived process behind. Every HTTP probe goes to a hermetic
 * `Deno.serve` on an ephemeral port, and every CLI invocation goes to
 * `tests/fixtures/fake-comfy` via `COMFY_BIN`.
 */

/** The live capture from ComfyUI 0.29.0 Desktop, verbatim. */
const SYSTEM_STATS = {
  system: {
    os: "darwin",
    ram_total: 51539607552,
    ram_free: 11459395584,
    comfyui_version: "0.29.0",
    python_version: "3.13.12 (main, Jan  1 2026, 00:00:00) [Clang 17.0.0]",
    pytorch_version: "2.13.0",
    embedded_python: false,
    deploy_environment: "local-desktop2-standalone",
    argv: [
      "ComfyUI/main.py",
      "--enable-manager",
      "--extra-model-paths-config",
      "/Users/lawls/Library/Application Support/ComfyUI/shared_model_paths.yaml",
      "--input-directory",
      "/Users/lawls/ComfyUI-Shared/input",
      "--output-directory",
      "/Users/lawls/ComfyUI-Shared/output",
    ],
  },
  devices: [
    {
      name: "mps",
      type: "mps",
      index: null,
      vram_total: 51539607552,
      vram_free: 11458723840,
      torch_vram_total: 51539607552,
      torch_vram_free: 11458723840,
    },
  ],
};

/** No test may reach a real `comfy`; every invocation goes to this fake. */
const FAKE_COMFY = join(import.meta.dirname, "fixtures", "fake-comfy");

/**
 * The same fake behind a wrapper that APPENDS every invocation to a log.
 * `$FAKE_COMFY_ARGV_OUT` is overwritten per call and so cannot answer "how many
 * times was the CLI run", which is the whole question a deduplication test asks.
 */
const FAKE_COMFY_LOGGING = join(import.meta.dirname, "fixtures", "fake-comfy-dispatch");

type Handler = (request: Request) => Response | Promise<Response>;

/**
 * A `{port, stop}` pair wrapping the raw `Deno.HttpServer`, matching
 * `tests/objectInfo.test.ts`: `stop(true)` aborts the creating `signal`
 * rather than awaiting `.shutdown()`, which — unlike `.shutdown()` —
 * resolves immediately even against a handler that never returns (measured
 * directly; several tests below install exactly one such handler).
 */
interface TestServer {
  readonly port: number;
  stop(force?: boolean): Promise<void>;
}

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

let servers: TestServer[] = [];
let requests: string[] = [];
let workdir: string;

beforeEach(() => {
  servers = [];
  requests = [];
  workdir = mkdtempSync(join(tmpdir(), "mcp-comfyui-instance-"));
  process.env.COMFY_BIN = FAKE_COMFY;
});

afterEach(async () => {
  // force: a hung handler must not keep the suite open
  for (const bound of servers) await bound.stop(true);
  servers = [];
  delete process.env.COMFY_BIN;
  delete process.env.FAKE_COMFY_MODE;
  delete process.env.FAKE_COMFY_ARGV_OUT;
  delete process.env.FAKE_COMFY_PID_OUT;
  delete process.env.FAKE_COMFY_ERROR_CODE;
  delete process.env.FAKE_COMFY_ERROR_MESSAGE;
  delete process.env.FAKE_COMFY_DISPATCH_LOG;
  rmSync(workdir, { recursive: true, force: true });
});

/**
 * Point the CLI at the appending wrapper and hand back the log's path.
 * Every invocation lands on its own line, so a count is a line count.
 */
function countingCli(mode: string): string {
  const log = join(workdir, "invocations");
  process.env.COMFY_BIN = FAKE_COMFY_LOGGING;
  process.env.FAKE_COMFY_MODE = mode;
  process.env.FAKE_COMFY_DISPATCH_LOG = log;
  return log;
}

/** How many times the CLI was invoked. Zero when it never was. */
function invocations(log: string): number {
  if (!existsSync(log)) return 0;
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "").length;
}

/**
 * The invocation count, once it has stopped moving.
 *
 * A launch deliberately does not wait for the CLI — readiness is the HTTP
 * probe's to decide (landmine #9) — so `launchInstance` returns while the spawn
 * is still starting. Counting immediately would read zero for a launch that did
 * happen. Waiting for `expected` and then pausing again is what makes "exactly
 * one" mean it: the second pause is the window a duplicate would appear in.
 */
async function settledInvocations(log: string, expected: number, timeoutMs = 5_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (invocations(log) < expected && Date.now() < deadline) await sleep(5);
  await sleep(60);
  return invocations(log);
}

/** Start a loopback server on an ephemeral port and hand back that port. */
function serve(handler: Handler = () => stats(), hostname = "127.0.0.1"): number {
  const bound = denoServe((request) => {
    requests.push(new URL(request.url).pathname);
    return handler(request);
  }, hostname);
  servers.push(bound);
  return portOf(bound);
}

function portOf(bound: TestServer): number {
  return bound.port;
}

function stats(body: unknown = SYSTEM_STATS): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

/** A port nothing is listening on: bind one, then give it back. */
async function closedPort(): Promise<number> {
  const throwaway = denoServe(() => new Response(""), "127.0.0.1");
  const port = portOf(throwaway);
  await throwaway.stop(true);
  return port;
}

/**
 * A server that refuses until it has been probed `failures` times, which is
 * what a ComfyUI still loading models looks like from the outside. Its counter
 * is its own, so two of these in one test do not interfere.
 */
function serveReadyAfter(failures: number, hostname = "127.0.0.1"): number {
  let seen = 0;
  const handler = () => (seen++ < failures ? new Response("starting", { status: 503 }) : stats());
  return serve(handler, hostname);
}

/** Point the fake CLI at a mode and capture the argv it is invoked with. */
function armCli(mode: string): string {
  const argvOut = join(workdir, "argv");
  process.env.FAKE_COMFY_MODE = mode;
  process.env.FAKE_COMFY_ARGV_OUT = argvOut;
  return argvOut;
}

/**
 * Wait for the fake CLI to write a file, then hand its path back.
 *
 * A launch deliberately does not wait for the CLI — readiness is decided by the
 * HTTP probe, so `launchInstance` can and does return while the spawn is still
 * starting up. Any assertion about what the CLI was invoked with therefore has
 * to catch up with it rather than assume it has already run.
 */
async function written(path: string, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`the fake comfy never wrote ${path}`);
    await sleep(5);
  }
  return path;
}

/** The argv the fake recorded. No path in these tests contains a space. */
async function argvOf(path: string): Promise<string[]> {
  return readFileSync(await written(path), "utf8").trim().split(" ");
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected launchInstance to reject, but it resolved");
}

/** Narrow to the running arm, reporting the refusal reason when it is not. */
function running(detection: InstanceDetection): RunningInstance {
  if (!detection.running) {
    throw new Error(`expected a running instance, got running:false (${detection.reason})`);
  }
  return detection;
}

test("detects a running instance and reports its version, devices and argv", async () => {
  const port = serve();
  const detection = running(await detectInstance({ port }));

  expect(detection.version).toBe("0.29.0");
  expect(detection.devices).toEqual([
    { name: "mps", type: "mps", vramTotal: 51539607552, vramFree: 11458723840 },
  ]);
  expect(detection.argv).toEqual(SYSTEM_STATS.system.argv);
  expect(requests).toEqual(["/system_stats"]);
});

test("reports the address it probed", async () => {
  const port = serve();
  const detection = await detectInstance({ port });

  expect(detection.url).toBe(`http://127.0.0.1:${port}/system_stats`);
  expect(detection.host).toBe("127.0.0.1");
  expect(detection.port).toBe(port);
});

test("a refused connection is running:false, not a thrown error", async () => {
  // Nothing running is the normal state of this machine, not a fault: every
  // operation probes first, and a throw here would make "ComfyUI is not
  // running" indistinguishable from "this server is broken".
  const port = await closedPort();
  const detection = await detectInstance({ port });

  expect(detection.running).toBe(false);
  expect(detection.url).toBe(`http://127.0.0.1:${port}/system_stats`);
});

test("a refused connection says why it could not connect", async () => {
  const port = await closedPort();
  const detection = await detectInstance({ port });

  if (detection.running) throw new Error("expected running:false");
  expect(detection.reason).not.toBe("");
});

test("a malformed body is running:false rather than a throw or a half-read instance", async () => {
  // A proxy's HTML error page on the port ComfyUI usually holds.
  const port = serve(
    () =>
      new Response("<html><body>502 Bad Gateway</body></html>", {
        headers: { "content-type": "text/html" },
      }),
  );
  const detection = await detectInstance({ port });

  expect(detection.running).toBe(false);
  if (detection.running) return;
  expect(detection.reason).toContain("502 Bad Gateway"); // quotes what actually arrived
});

test("valid JSON that is not /system_stats is running:false", async () => {
  // Something else answering on this port is not a ComfyUI, and reporting it as
  // one would have every later call fail with a confusing error instead.
  const port = serve(() => stats({ hello: "world" }));
  const detection = await detectInstance({ port });

  expect(detection.running).toBe(false);
});

test("a body missing every optional field still detects as running", async () => {
  // Older and newer ComfyUI report different fields; a missing one must degrade
  // that one value, never the detection.
  const port = serve(() => stats({ system: {}, devices: [] }));
  const detection = running(await detectInstance({ port }));

  expect(detection.version).toBeNull();
  expect(detection.argv).toBeNull();
  expect(detection.devices).toEqual([]);
  expect(detection.deployEnvironment).toBeNull();
});

test("a device missing its vram fields still lists the device", async () => {
  const port = serve(() => stats({ system: {}, devices: [{ name: "cuda:0", type: "cuda" }] }));
  const detection = running(await detectInstance({ port }));

  expect(detection.devices).toEqual([
    { name: "cuda:0", type: "cuda", vramTotal: null, vramFree: null },
  ]);
});

test("a non-200 response is running:false and names the status", async () => {
  const port = serve(() => new Response("nope", { status: 503 }));
  const detection = await detectInstance({ port });

  expect(detection.running).toBe(false);
  if (detection.running) return;
  expect(detection.reason).toContain("503");
});

test("a server that never answers times out fast and names the budget", async () => {
  // This probe runs before every operation, so an unreachable-but-not-refusing
  // address must not stall the whole call.
  const port = serve(() => new Promise<Response>(() => {}));
  const started = Date.now();
  const detection = await detectInstance({ port, timeoutMs: 150 });
  const elapsed = Date.now() - started;

  expect(detection.running).toBe(false);
  if (detection.running) return;
  expect(detection.reason).toContain("150ms");
  expect(elapsed).toBeLessThan(2_000);
});

test("0.0.0.0 is rewritten to 127.0.0.1 before it is used as a connect address", async () => {
  const port = serve();
  const detection = running(await detectInstance({ host: "0.0.0.0", port }));

  expect(detection.host).toBe("127.0.0.1");
  expect(detection.url).toBe(`http://127.0.0.1:${port}/system_stats`);
});

test("the IPv6 wildcard is rewritten like 0.0.0.0", async () => {
  const port = serve();
  const detection = running(await detectInstance({ host: "::", port }));

  expect(detection.url).toBe(`http://127.0.0.1:${port}/system_stats`);
});

test("an IPv6 host is bracketed in the probe URL", async () => {
  // `http://::1:8188/system_stats` is rejected by fetch before a packet moves.
  const port = serve(() => stats(), "::1");
  const detection = running(await detectInstance({ host: "::1", port }));

  expect(detection.url).toBe(`http://[::1]:${port}/system_stats`);
  expect(detection.version).toBe("0.29.0");
});

test("a Desktop-managed instance is reported as such", async () => {
  // Desktop owns its own ComfyUI process; this is what tells a caller that this
  // server may report on the instance but must never manage it.
  const port = serve();
  const detection = running(await detectInstance({ port }));

  expect(detection.deployEnvironment).toBe("local-desktop2-standalone");
  expect(detection.desktopManaged).toBe(true);
});

test("a non-Desktop deploy environment is reported as not Desktop-managed", async () => {
  const port = serve(() => stats({ system: { deploy_environment: "local-cli" }, devices: [] }));
  const detection = running(await detectInstance({ port }));

  expect(detection.desktopManaged).toBe(false);
});

test("an instance that does not say how it was deployed is unknown, not 'not Desktop'", async () => {
  // Older ComfyUI has no deploy_environment. Answering `false` there would be a
  // claim we cannot support, and the claim's whole purpose is to decide whether
  // this server may manage the process.
  const port = serve(() => stats({ system: { comfyui_version: "0.3.0" }, devices: [] }));
  const detection = running(await detectInstance({ port }));

  expect(detection.desktopManaged).toBeNull();
});

test("the output and input directories are recovered from argv", async () => {
  const port = serve();
  const detection = running(await detectInstance({ port }));

  expect(detection.outputDirectory).toBe("/Users/lawls/ComfyUI-Shared/output");
  expect(detection.inputDirectory).toBe("/Users/lawls/ComfyUI-Shared/input");
});

test("the --flag=value spelling of a directory argument is recovered too", async () => {
  const argv = ["main.py", "--output-directory=/tmp/out", "--input-directory=/tmp/in"];
  const port = serve(() => stats({ system: { argv }, devices: [] }));
  const detection = running(await detectInstance({ port }));

  expect(detection.outputDirectory).toBe("/tmp/out");
  expect(detection.inputDirectory).toBe("/tmp/in");
});

test("an instance started without directory flags reports them as unknown", async () => {
  const port = serve(() => stats({ system: { argv: ["main.py"] }, devices: [] }));
  const detection = running(await detectInstance({ port }));

  expect(detection.outputDirectory).toBeNull();
  expect(detection.inputDirectory).toBeNull();
});

test("refuses to launch when an instance is already running, and invokes nothing", async () => {
  // The single most important behaviour in this module. ComfyUI Desktop owns
  // the running process; a second instance would fight it for the port, for
  // unified memory and for the shared model directory (landmine #8).
  const port = serve();
  const argvOut = armCli("launch");

  const result = await launchInstance({ port });

  expect(result.outcome).toBe("already_running");
  expect(result.instance.version).toBe("0.29.0");
  expect(result.instance.desktopManaged).toBe(true);
  // Not "invoked and ignored" — the CLI never ran at all.
  expect(existsSync(argvOut)).toBe(false);
});

test("refuses when an instance is running on the port the arguments name", async () => {
  // The guard is about the machine, not just the default address: a second
  // ComfyUI on another port still competes for the same VRAM and model dir.
  const detectPort = await closedPort();
  const targetPort = serve();
  const argvOut = armCli("launch");

  const result = await launchInstance({ port: detectPort, args: { port: targetPort } });

  expect(result.outcome).toBe("already_running");
  expect(result.instance.port).toBe(targetPort);
  expect(existsSync(argvOut)).toBe(false);
});

test("a launch targeting a free port proceeds while another instance runs elsewhere", async () => {
  // The bug this task exists to fix: `launch_comfyui {port: 8189}` used to be
  // refused with `already_running` for the instance on 8188 even though 8189
  // was free. The refusal must be scoped to the address the request names.
  const elsewherePort = serve(); // e.g. ComfyUI Desktop, on the configured/default address
  const targetPort = serveReadyAfter(1);
  const argvOut = armCli("launch");

  const result = await launchInstance({
    port: elsewherePort,
    args: { port: targetPort },
    pollIntervalMs: 10,
  });

  expect(result.outcome).toBe("launched");
  expect(result.instance.port).toBe(targetPort);
  // The CLI really ran this time — awaited, since `launchInstance` does not
  // wait for the (fire-and-forget) spawn, so a synchronous check here would
  // race it.
  await written(argvOut);
});

test("already_running never substitutes an instance from a different address", async () => {
  // A caller asking for one port must never receive a different port's
  // instance labelled a success. Both addresses are running here, so the old
  // "refuse on either" policy would have handed back the configured
  // instance — the wrong one — instead of refusing with the one requested.
  const configuredPort = serve();
  const targetPort = serve();
  const argvOut = armCli("launch");

  const result = await launchInstance({ port: configuredPort, args: { port: targetPort } });

  expect(result.outcome).toBe("already_running");
  expect(result.instance.port).toBe(targetPort);
  expect(result.instance.port).not.toBe(configuredPort);
  expect(existsSync(argvOut)).toBe(false);
});

test("the contention warning appears when another instance is running elsewhere", async () => {
  // Launching a second ComfyUI is allowed when it was asked for, but the two
  // compete for VRAM and the shared model directory — the caller is told.
  const elsewherePort = serve();
  const targetPort = serveReadyAfter(1);
  armCli("launch");

  const result = await launchInstance({
    port: elsewherePort,
    args: { port: targetPort },
    pollIntervalMs: 10,
  });

  expect(result.outcome).toBe("launched");
  if (result.outcome !== "launched") return;
  expect(result.warnings.length).toBeGreaterThan(0);
  expect(result.warnings.join("\n")).toContain(String(elsewherePort));
});

test("no contention warning when nothing else is running", async () => {
  const configuredPort = await closedPort(); // nothing is running at the configured address
  const targetPort = serveReadyAfter(1);
  armCli("launch");

  const result = await launchInstance({
    port: configuredPort,
    args: { port: targetPort },
    pollIntervalMs: 10,
  });

  expect(result.outcome).toBe("launched");
  if (result.outcome !== "launched") return;
  expect(result.warnings).toEqual([]);
});

test("no contention warning when the target is the configured address itself", async () => {
  const port = serveReadyAfter(1);
  armCli("launch");

  const result = await launchInstance({ port, pollIntervalMs: 10 });

  expect(result.outcome).toBe("launched");
  if (result.outcome !== "launched") return;
  expect(result.warnings).toEqual([]);
});

test("the ComfyUI arguments follow a bare -- separator", async () => {
  // Extra arguments are trailing positionals; there is no --extra-args flag,
  // and without the separator Typer parses --lowvram as an option of its own.
  const port = serveReadyAfter(1);
  const argvOut = armCli("launch");

  const result = await launchInstance({ port, args: { lowvram: true }, pollIntervalMs: 10 });

  expect(result.outcome).toBe("launched");
  const argv = await argvOf(argvOut);
  expect(argv).toEqual(["--skip-prompt", "--json", "launch", "--background", "--", "--lowvram"]);
  expect(argv.indexOf("--")).toBeLessThan(argv.indexOf("--lowvram"));
});

test("root flags precede the subcommand", async () => {
  // `comfy launch --json` fails where `comfy --json launch` works (landmine #3).
  const port = serveReadyAfter(1);
  const argvOut = armCli("launch");
  await launchInstance({ port, pollIntervalMs: 10 });

  const argv = await argvOf(argvOut);
  expect(argv[0]).toBe("--skip-prompt");
  expect(argv.indexOf("--json")).toBeLessThan(argv.indexOf("launch"));
});

test("no startup arguments means no separator with nothing to separate", async () => {
  const port = serveReadyAfter(1);
  const argvOut = armCli("launch");
  await launchInstance({ port, pollIntervalMs: 10 });

  expect(await argvOf(argvOut)).toEqual(["--skip-prompt", "--json", "launch", "--background"]);
});

test("the curated startup arguments are spelled the way ComfyUI expects", async () => {
  const port = serveReadyAfter(1);
  const argvOut = armCli("launch");

  await launchInstance({
    port,
    args: {
      listen: "127.0.0.1",
      port,
      lowvram: true,
      cpu: true,
      outputDirectory: "/tmp/out",
      inputDirectory: "/tmp/in",
      extraModelPathsConfig: "/tmp/paths.yaml",
      disableAutoLaunch: true,
      verbose: true,
    },
    extraArgs: ["--fast"],
    pollIntervalMs: 10,
  });

  expect(await argvOf(argvOut)).toEqual([
    "--skip-prompt",
    "--json",
    "launch",
    "--background",
    "--",
    "--listen",
    "127.0.0.1",
    "--port",
    String(port),
    "--lowvram",
    "--cpu",
    "--output-directory",
    "/tmp/out",
    "--input-directory",
    "/tmp/in",
    "--extra-model-paths-config",
    "/tmp/paths.yaml",
    "--disable-auto-launch",
    "--verbose",
    "--fast",
  ]);
});

test("a flag that was not asked for is not sent", async () => {
  const port = serveReadyAfter(1);
  const argvOut = armCli("launch");
  await launchInstance({ port, args: { lowvram: false, cpu: true }, pollIntervalMs: 10 });

  expect(await argvOf(argvOut)).not.toContain("--lowvram");
});

test("readiness is polled until the instance answers, not decided by one probe", async () => {
  // A cold ComfyUI imports torch and scans models before it binds. Deciding on
  // the first probe would report every successful launch as a failure.
  const port = serveReadyAfter(3);
  armCli("launch");

  const result = await launchInstance({ port, pollIntervalMs: 10 });

  expect(result.outcome).toBe("launched");
  expect(result.instance.version).toBe("0.29.0");
  expect(requests.length).toBeGreaterThanOrEqual(4); // one guard probe, then polling
});

test("a launch that never answers times out, naming how long it waited", async () => {
  const port = serveReadyAfter(Number.MAX_SAFE_INTEGER); // never becomes ready
  armCli("launch");

  const err = await rejection(launchInstance({ port, timeoutMs: 400, pollIntervalMs: 25 }));

  expect(err).toBeInstanceOf(LaunchTimeoutError);
  expect((err as LaunchTimeoutError).timeoutMs).toBe(400);
  const message = (err as Error).message;
  expect(message).toContain("400ms");
  expect(message).toContain(`http://127.0.0.1:${port}/system_stats`);
  expect(message).toContain("503"); // the last probe's own reason, not just silence
});

test("readiness is polled on the port the startup arguments name", async () => {
  // Getting this wrong reports a successful launch as a timeout.
  const detectPort = await closedPort();
  const targetPort = serveReadyAfter(1);
  armCli("launch");

  const result = await launchInstance({
    port: detectPort,
    args: { port: targetPort },
    timeoutMs: 2_000,
    pollIntervalMs: 10,
  });

  expect(result.outcome).toBe("launched");
  expect(result.instance.port).toBe(targetPort);
  expect(result.instance.url).toBe(`http://127.0.0.1:${targetPort}/system_stats`);
});

test("the --port=N spelling in extraArgs is honoured by the poller too", async () => {
  // comfy-cli's own background launcher reads both spellings; a poller that
  // read only one would wait out the whole budget on a server that came up.
  const detectPort = await closedPort();
  const targetPort = serveReadyAfter(1);
  armCli("launch");

  const result = await launchInstance({
    port: detectPort,
    extraArgs: [`--port=${targetPort}`],
    timeoutMs: 2_000,
    pollIntervalMs: 10,
  });

  expect(result.instance.port).toBe(targetPort);
});

test("readiness follows --listen to the address ComfyUI will bind", async () => {
  const detectPort = await closedPort();
  const targetPort = serveReadyAfter(1, "::1");
  armCli("launch");

  const result = await launchInstance({
    port: detectPort,
    args: { listen: "::1", port: targetPort },
    timeoutMs: 2_000,
    pollIntervalMs: 10,
  });

  expect(result.instance.url).toBe(`http://[::1]:${targetPort}/system_stats`);
});

test("a wildcard --listen is rewritten before readiness is polled", async () => {
  // `--listen 0.0.0.0` is a bind address, not a connect address (landmine #10).
  const port = serveReadyAfter(1);
  armCli("launch");

  const result = await launchInstance({
    port,
    args: { listen: "0.0.0.0" },
    timeoutMs: 2_000,
    pollIntervalMs: 10,
  });

  expect(result.instance.host).toBe("127.0.0.1");
  expect(result.instance.url).not.toContain("0.0.0.0");
});

test("a CLI that never returns does not delay a ComfyUI that is already up", async () => {
  // `comfy launch --background` blocks until it scrapes "To see the GUI go to:"
  // out of a logfile. Waiting on that would make this server's readiness depend
  // on a log string upstream can change (landmine #9); the HTTP probe is the
  // authority, so a CLI still blocked must not hold up a ready instance.
  process.env.FAKE_COMFY_MODE = "hang";
  const pidOut = join(workdir, "pid");
  process.env.FAKE_COMFY_PID_OUT = pidOut;
  const port = serveReadyAfter(1);

  const started = Date.now();
  const result = await launchInstance({ port, timeoutMs: 2_000, pollIntervalMs: 10 });
  const elapsed = Date.now() - started;

  // Reaped here so a regression cannot leak the sleeper for its full lifetime.
  try {
    expect(result.outcome).toBe("launched");
    expect(elapsed).toBeLessThan(1_500); // not the CLI's own lifetime
  } finally {
    process.kill(Number(readFileSync(await written(pidOut), "utf8").trim()), "SIGKILL");
  }
});

test("a failure the CLI diagnosed aborts the wait instead of polling to the budget", async () => {
  // `not_in_workspace` is what this user's machine answers: ComfyUI Desktop is
  // not a comfy-cli workspace, so there is nothing to launch and no point
  // waiting two minutes to find out.
  process.env.FAKE_COMFY_MODE = "launch_fail";
  process.env.FAKE_COMFY_ERROR_CODE = "not_in_workspace";
  process.env.FAKE_COMFY_ERROR_MESSAGE = "ComfyUI is not available.";
  const port = serveReadyAfter(Number.MAX_SAFE_INTEGER);

  const started = Date.now();
  const err = await rejection(launchInstance({ port, timeoutMs: 10_000, pollIntervalMs: 10 }));
  const elapsed = Date.now() - started;

  expect(err).toBeInstanceOf(ComfyCliError);
  expect((err as ComfyCliError).code).toBe("not_in_workspace");
  expect(elapsed).toBeLessThan(3_000); // nowhere near the readiness budget
});

test("a launch whose CLI exits non-zero with no envelope fails fast, not after the full budget", async () => {
  // Measured against the real CLI: an unresolvable workspace crashes `comfy
  // launch --background` uncaught — no envelope, a non-zero exit, a traceback
  // on stderr — contrary to what the ground-truth doc claimed for
  // `--background`. That surfaces as an EnvelopeParseError, not a
  // ComfyCliError, so `isVerdict` alone never sees it and the poll loop would
  // otherwise burn the whole readiness budget on a child that is already dead.
  process.env.FAKE_COMFY_MODE = "garbage"; // non-zero exit, unparseable stdout, stderr traceback
  const port = await closedPort(); // nothing ever answers; only the crash should end the wait

  const started = Date.now();
  const err = await rejection(launchInstance({ port, timeoutMs: 15_000, pollIntervalMs: 50 }));
  const elapsed = Date.now() - started;

  expect(err).toBeInstanceOf(LaunchFailedError);
  expect(err).not.toBeInstanceOf(LaunchTimeoutError);
  expect(elapsed).toBeLessThan(3_000); // nowhere near the 15s budget
  const message = (err as Error).message;
  expect(message).toContain(`http://127.0.0.1:${port}/system_stats`); // the address being polled
  expect(message).toContain("MCP_COMFYUI_WORKSPACE"); // the actual fix, surfaced
  expect(message).toContain("RuntimeError: boom"); // the traceback survives, not just a verdict
});

test("a missing comfy binary aborts the wait rather than polling to the budget", async () => {
  process.env.COMFY_BIN = join(workdir, "definitely-not-installed");
  const port = serveReadyAfter(Number.MAX_SAFE_INTEGER);

  const started = Date.now();
  const err = await rejection(launchInstance({ port, timeoutMs: 10_000, pollIntervalMs: 10 }));
  const elapsed = Date.now() - started;

  expect(err).toBeInstanceOf(ComfyUnavailableError);
  expect(elapsed).toBeLessThan(3_000);
});

test("an extra argument of `--` is refused, because it breaks the separator", async () => {
  // A second separator makes the boundary between our `--` and the caller's
  // arguments unreadable in every diagnostic that quotes the command line.
  const port = await closedPort();
  const argvOut = armCli("launch");

  const err = await rejection(launchInstance({ port, extraArgs: ["--"] }));

  expect(err).toBeInstanceOf(LaunchArgumentError);
  expect(existsSync(argvOut)).toBe(false); // refused before anything was spawned
  expect(requests).toEqual([]); // and before anything was probed
});

test("an empty extra argument is refused", async () => {
  const port = await closedPort();
  const argvOut = armCli("launch");

  const err = await rejection(launchInstance({ port, extraArgs: ["--fast", ""] }));

  expect(err).toBeInstanceOf(LaunchArgumentError);
  expect(existsSync(argvOut)).toBe(false);
});

test("an extra argument carrying a control character is refused", async () => {
  // Two flags smuggled into one argument, and a newline that would corrupt the
  // fixture's argv capture and every command line this server ever quotes.
  const port = await closedPort();
  const argvOut = armCli("launch");

  const err = await rejection(launchInstance({ port, extraArgs: ["--fast\n--listen 0.0.0.0"] }));

  expect(err).toBeInstanceOf(LaunchArgumentError);
  expect((err as Error).message).toContain("--fast");
  expect(existsSync(argvOut)).toBe(false);
});

test("a port outside the TCP range is refused before anything is spawned", async () => {
  // Otherwise the poller waits out its whole budget on a port that could never
  // have been bound.
  const port = await closedPort();
  const argvOut = armCli("launch");

  const err = await rejection(launchInstance({ port, args: { port: 70_000 } }));

  expect(err).toBeInstanceOf(LaunchArgumentError);
  expect((err as Error).message).toContain("70000");
  expect(existsSync(argvOut)).toBe(false);
});

// --- launching is only ever ours to do on this machine ---------------------

/**
 * `comfy launch` has no --host: it starts a process HERE. Attempting one for a
 * remote address starts a ComfyUI on this machine, polls the remote until the
 * readiness budget expires, reports a timeout, and leaves the process running,
 * because --background already detached it.
 *
 * Addresses below are RFC 5737 TEST-NET-1, reserved for documentation, so no
 * ComfyUI can answer them and this file's "never contact a real instance" rule
 * holds. Budgets are small on purpose: run against the unfixed code these cases
 * poll for the full five-minute default, which is how the defect was confirmed.
 */
const REMOTE_HOST = "192.0.2.90";

test("a launch aimed at another machine's address is refused, not attempted", async () => {
  const argvOut = armCli("launch");

  const err = await rejection(
    launchInstance({ host: REMOTE_HOST, port: 8189, timeoutMs: 500, pollIntervalMs: 25 }),
  );

  expect(err).toBeInstanceOf(LaunchArgumentError);
  expect((err as Error).message).toContain(REMOTE_HOST);
  expect(existsSync(argvOut)).toBe(false); // refused before anything was spawned
  expect(requests).toEqual([]); // and before anything was probed
});

test("a --listen naming another machine is refused too, since that is the real target", async () => {
  // launchTarget reads the address out of the assembled argv, so --listen wins
  // over opts.host. A gate that only checked opts.host would miss exactly the
  // argument that decides where the server binds.
  const port = await closedPort();
  const argvOut = armCli("launch");

  const err = await rejection(
    launchInstance({ port, args: { listen: REMOTE_HOST }, timeoutMs: 500, pollIntervalMs: 25 }),
  );

  expect(err).toBeInstanceOf(LaunchArgumentError);
  expect(existsSync(argvOut)).toBe(false);
});

test("auto-launch does not fire for a remote host that is simply not answering", async () => {
  // The path that actually bites: a tool handler calls ensureInstance, the box
  // is asleep, and nothing before this fix asked whose address it was.
  const argvOut = armCli("launch");

  const err = await rejection(
    ensureInstance({
      host: REMOTE_HOST,
      port: 8188,
      probeTimeoutMs: 50,
      timeoutMs: 500,
      pollIntervalMs: 25,
    }),
  );

  expect(err).toBeInstanceOf(LaunchArgumentError);
  expect(existsSync(argvOut)).toBe(false);
});

test("a loopback launch is untouched by the locality gate", async () => {
  // The guard must refuse a foreign address without costing the ordinary case
  // anything — every existing launch in this file goes through it.
  const detectPort = await closedPort();
  const targetPort = serveReadyAfter(1);
  armCli("launch");

  const result = await launchInstance({
    port: detectPort,
    args: { port: targetPort },
    timeoutMs: 2_000,
    pollIntervalMs: 10,
  });

  expect(result.outcome).toBe("launched");
});

// --- the workspace comfy launches from ------------------------------------

test("a configured workspace is a root flag, before the subcommand", async () => {
  // Landmine #3: `--workspace` lives on the Typer root, so `comfy launch
  // --workspace <p>` fails where `comfy --workspace <p> launch` works. On this
  // machine comfy resolves to a default workspace that is not on disk, so this
  // flag is the difference between launching and `not_in_workspace`.
  const port = serveReadyAfter(1);
  const argvOut = armCli("launch");

  await launchInstance({ port, workspace: "/Users/lawls/ComfyUI-Installs/ComfyUI/ComfyUI", pollIntervalMs: 10 });

  const argv = await argvOf(argvOut);
  expect(argv).toContain("--workspace");
  expect(argv[argv.indexOf("--workspace") + 1]).toBe("/Users/lawls/ComfyUI-Installs/ComfyUI/ComfyUI");
  expect(argv.indexOf("--workspace")).toBeLessThan(argv.indexOf("launch"));
  expect(argv[0]).toBe("--skip-prompt");
});

test("no configured workspace sends no --workspace at all", async () => {
  // Letting comfy resolve on its own is what keeps a user who has run
  // `comfy install` on their recorded default or recent workspace.
  const port = serveReadyAfter(1);
  const argvOut = armCli("launch");

  await launchInstance({ port, pollIntervalMs: 10 });

  expect(await argvOf(argvOut)).not.toContain("--workspace");
});

test("not_in_workspace is answered with the setting that fixes it", async () => {
  // The expected first-run failure on a machine whose comfy-cli config names no
  // workspace: comfy resolves to a directory that does not exist. The code alone
  // says nothing a user can act on.
  process.env.FAKE_COMFY_MODE = "launch_fail";
  process.env.FAKE_COMFY_ERROR_CODE = "not_in_workspace";
  process.env.FAKE_COMFY_ERROR_MESSAGE = "ComfyUI is not available.";
  const port = serveReadyAfter(Number.MAX_SAFE_INTEGER);

  const err = await rejection(launchInstance({ port, timeoutMs: 5_000, pollIntervalMs: 10 }));

  expect(err).toBeInstanceOf(ComfyCliError);
  expect((err as ComfyCliError).code).toBe("not_in_workspace");
  const message = (err as Error).message;
  expect(message).toContain("MCP_COMFYUI_WORKSPACE");
  expect(message).toContain("comfy install");
  expect(message).toContain("does not exist");
  // This machine's two installs are its own accident, not a general fact.
  expect(message).not.toContain("ComfyUI-Installs");
});

test("not_in_workspace names the workspace this server actually passed", async () => {
  process.env.FAKE_COMFY_MODE = "launch_fail";
  process.env.FAKE_COMFY_ERROR_CODE = "not_in_workspace";
  process.env.FAKE_COMFY_ERROR_MESSAGE = "ComfyUI is not available.";
  const port = serveReadyAfter(Number.MAX_SAFE_INTEGER);

  const err = await rejection(
    launchInstance({ port, workspace: "/tmp/not-a-workspace", timeoutMs: 5_000, pollIntervalMs: 10 }),
  );

  // Without this the user re-reads a setting they have already set correctly.
  expect((err as Error).message).toContain("/tmp/not-a-workspace");
});

test("a failure that is not not_in_workspace is passed through unembellished", async () => {
  process.env.FAKE_COMFY_MODE = "launch_fail";
  process.env.FAKE_COMFY_ERROR_CODE = "port_in_use";
  process.env.FAKE_COMFY_ERROR_MESSAGE = "port 8188 is already bound";
  const port = serveReadyAfter(Number.MAX_SAFE_INTEGER);

  const err = await rejection(launchInstance({ port, timeoutMs: 5_000, pollIntervalMs: 10 }));

  expect((err as ComfyCliError).code).toBe("port_in_use");
  expect((err as Error).message).not.toContain("MCP_COMFYUI_WORKSPACE");
});

// --- ensureInstance -------------------------------------------------------

test("ensureInstance returns a running instance and invokes nothing", async () => {
  // The guard, reached through the new door. Auto-launch must not become a way
  // round the one rule this module exists to enforce (landmine #8).
  const port = serve();
  const log = countingCli("launch");

  const ensured = await ensureInstance({ port, autoLaunch: true });

  expect(ensured.outcome).toBe("already_running");
  expect(ensured.instance.version).toBe("0.29.0");
  expect(await settledInvocations(log, 0)).toBe(0);
});

test("ensureInstance launches when nothing is answering", async () => {
  const port = serveReadyAfter(2);
  const log = countingCli("launch");

  const ensured = await ensureInstance({ port, autoLaunch: true, pollIntervalMs: 10 });

  expect(ensured.outcome).toBe("launched");
  expect(ensured.instance.version).toBe("0.29.0");
  expect(await settledInvocations(log, 1)).toBe(1);
});

test("a ComfyUI that appears between the two probes is not raced", async () => {
  // ensureInstance probes, sees nothing, and hands over to launchInstance —
  // which probes AGAIN before spawning. That second probe is the guard proper,
  // and this is the window it exists for: something came up in between, and a
  // launch now would be the second instance landmine #8 forbids.
  const port = serveReadyAfter(1);
  const log = countingCli("launch");

  const ensured = await ensureInstance({ port, autoLaunch: true, pollIntervalMs: 10 });

  expect(ensured.outcome).toBe("already_running");
  expect(await settledInvocations(log, 0)).toBe(0);
});

test("ensureInstance launches at the configured address, not at an instance running elsewhere", async () => {
  // ensureInstance keeps its current meaning: if the configured address is
  // answering, use it; if not, launch there. Auto-launch must not start an
  // instance on some other port just because one happens to be reachable.
  const elsewherePort = serve(); // running, but not the configured address
  const configuredPort = serveReadyAfter(2);
  const log = countingCli("launch");

  const ensured = await ensureInstance({ port: configuredPort, autoLaunch: true, pollIntervalMs: 10 });

  expect(ensured.outcome).toBe("launched");
  expect(ensured.instance.port).toBe(configuredPort);
  expect(ensured.instance.port).not.toBe(elsewherePort);
  expect(await settledInvocations(log, 1)).toBe(1);
});

test("ensureInstance refuses actionably when auto-launch is off", async () => {
  const port = await closedPort();
  const log = countingCli("launch");

  const err = await rejection(ensureInstance({ port, autoLaunch: false }));

  expect(err).toBeInstanceOf(InstanceUnavailableError);
  const message = (err as Error).message;
  expect(message).toContain(String(port)); // the address that was probed
  expect(message).toContain("MCP_COMFYUI_AUTO_LAUNCH"); // and how to change the answer
  expect(await settledInvocations(log, 0)).toBe(0);
});

test("concurrent ensures start exactly one ComfyUI", async () => {
  // The failure the whole guard exists to prevent, now reachable because
  // auto-launch fires from tool handlers rather than from one explicit call.
  const port = serveReadyAfter(4);
  const log = countingCli("launch");

  const ensured = await Promise.all([
    ensureInstance({ port, autoLaunch: true, pollIntervalMs: 10 }),
    ensureInstance({ port, autoLaunch: true, pollIntervalMs: 10 }),
    ensureInstance({ port, autoLaunch: true, pollIntervalMs: 10 }),
  ]);

  expect(await settledInvocations(log, 1)).toBe(1);
  for (const result of ensured) expect(result.instance.version).toBe("0.29.0");
});

test("a launch already in flight is joined rather than started again", async () => {
  const port = serveReadyAfter(4);
  const log = countingCli("launch");

  const [first, second] = await Promise.all([
    launchInstance({ port, pollIntervalMs: 10 }),
    launchInstance({ port, pollIntervalMs: 10 }),
  ]);

  expect(await settledInvocations(log, 1)).toBe(1);
  expect(first.instance.url).toBe(second.instance.url);
});

test("concurrent launches for different targets do not share an in-flight launch", async () => {
  // One in-flight launch per resolved target address, not one globally: two
  // launches for two different ports are legitimate and must both proceed.
  const configured = await closedPort(); // never touched: both calls target elsewhere
  const portA = serveReadyAfter(2);
  const portB = serveReadyAfter(2);
  const log = countingCli("launch");

  const [a, b] = await Promise.all([
    launchInstance({ port: configured, args: { port: portA }, pollIntervalMs: 10 }),
    launchInstance({ port: configured, args: { port: portB }, pollIntervalMs: 10 }),
  ]);

  expect(await settledInvocations(log, 2)).toBe(2);
  expect(a.instance.port).toBe(portA);
  expect(b.instance.port).toBe(portB);
});

test("a later launch runs again, because the in-flight entry is released", async () => {
  // Cleanup has to happen on the failure path too, or one bad launch wedges
  // this process until it restarts.
  const closed = await closedPort();
  process.env.FAKE_COMFY_MODE = "launch_fail";
  process.env.FAKE_COMFY_ERROR_CODE = "port_in_use";
  process.env.FAKE_COMFY_ERROR_MESSAGE = "bound";
  const log = countingCli("launch_fail");

  await rejection(launchInstance({ port: closed, timeoutMs: 3_000, pollIntervalMs: 10 }));
  await rejection(launchInstance({ port: closed, timeoutMs: 3_000, pollIntervalMs: 10 }));

  expect(await settledInvocations(log, 2)).toBe(2);
});

test("a caller's bad argument fails only that caller", async () => {
  // Validation happens before the shared region: one caller's typo must not
  // fail a launch somebody else asked for.
  const port = serveReadyAfter(2);
  const log = countingCli("launch");

  const [bad, good] = await Promise.all([
    rejection(launchInstance({ port, extraArgs: ["--"], pollIntervalMs: 10 })),
    launchInstance({ port, pollIntervalMs: 10 }),
  ]);

  expect(bad).toBeInstanceOf(LaunchArgumentError);
  expect(good.outcome).toBe("launched");
  expect(await settledInvocations(log, 1)).toBe(1);
});
