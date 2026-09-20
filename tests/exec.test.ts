import { afterEach, beforeEach, expect, sleep, test } from "./support/testing.ts";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { EnvelopeParseError } from "../src/comfy/envelope.ts";
import {
  ComfyCliError,
  ComfyTimeoutError,
  ComfyUnavailableError,
  runComfy,
  runComfyRaw,
} from "../src/comfy/exec.ts";

/** No test in this file may touch a real `comfy` or a real ComfyUI server. */
const FAKE_COMFY = join(import.meta.dirname, "fixtures", "fake-comfy");

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "mcp-comfyui-exec-"));
  process.env.COMFY_BIN = FAKE_COMFY;
});

afterEach(() => {
  delete process.env.COMFY_BIN;
  delete process.env.FAKE_COMFY_MODE;
  delete process.env.FAKE_COMFY_ARGV_OUT;
  delete process.env.FAKE_COMFY_PID_OUT;
  delete process.env.FAKE_COMFY_ORPHAN_OUT;
  delete process.env.FAKE_COMFY_PROBE;
  rmSync(workdir, { recursive: true, force: true });
});

let savedPath: string | undefined;
let savedHome: string | undefined;

beforeEach(() => {
  savedPath = process.env.PATH;
  savedHome = process.env.HOME;
});

afterEach(() => {
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  // HOME too: `homedir()` follows it, and discovery's first root is
  // `<home>/.local/bin`. Without this, a discovery test reads the developer's
  // real install and the suite shells out to a real comfy-cli.
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  delete process.env.FAKE_COMFY_PATH_OUT;
});

/** Await a promise that must reject, and hand back what it rejected with. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected runComfy to reject, but it resolved");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `pid` is confirmed dead within `timeoutMs`, polling rather than
 * checking once. Measured directly under `deno test`: Deno's `node:child_process`
 * compat resolves the child's `exit` event (and so `runComfy`'s own timeout
 * rejection) a few milliseconds before `process.kill(pid, 0)` — a raw,
 * un-mediated syscall — agrees the pid is gone; consistently under 10ms
 * across repeated trials, never the kind of gap a stuck process would leave.
 * A single immediate check does not survive that gap; this does, without
 * weakening what the assertion actually pins (the child dies from the
 * timeout's kill, not from something else, eventually).
 */
async function deadWithin(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(5);
  }
  return true;
}

function pidFrom(file: string): number {
  const pid = Number(readFileSync(file, "utf8").trim());
  expect(Number.isInteger(pid)).toBe(true);
  return pid;
}

test("resolves with the data payload of a success envelope", async () => {
  expect(await runComfy(["workflow", "slots", "flow.json"])).toEqual({ slots: [] });
});

test("rejects an ok:false envelope with a ComfyCliError carrying code and hint", async () => {
  process.env.FAKE_COMFY_MODE = "fail";
  const err = await rejection(runComfy(["run", "--workflow", "flow.json"]));
  expect(err).toBeInstanceOf(ComfyCliError);
  const cli = err as ComfyCliError;
  expect(cli.code).toBe("server_unreachable");
  expect(cli.hint).toBe("is ComfyUI running?");
  expect(cli.message).toContain("connection refused");
  expect(cli.command).toBe("run"); // the envelope's command, not our argv
});

test("keeps where and details from the failing envelope", async () => {
  process.env.FAKE_COMFY_MODE = "fail_rich";
  const err = await rejection(runComfy(["run"]));
  const cli = err as ComfyCliError;
  expect(cli.code).toBe("workflow_not_found");
  expect(cli.where).toBe("cloud");
  expect(cli.details).toEqual({ tried: ["a.json", "b.json"] });
});

test("rejects non-JSON stdout with a diagnostic naming the command, not a SyntaxError", async () => {
  process.env.FAKE_COMFY_MODE = "garbage";
  const err = await rejection(runComfy(["workflow", "slots", "flow.json"]));
  expect(err).toBeInstanceOf(EnvelopeParseError);
  expect(err).not.toBeInstanceOf(SyntaxError);
  const message = (err as Error).message;
  expect(message).toContain("workflow slots flow.json");
  expect(message).toContain("code 1"); // the exit code
  expect(message).toContain("not json at all"); // stdout snippet
  expect(message).toContain("RuntimeError: boom"); // stderr snippet
});

test("bounds the stdout and stderr snippets in the no-envelope diagnostic", async () => {
  process.env.FAKE_COMFY_MODE = "flood";
  const err = await rejection(runComfy(["run"]));
  const message = (err as Error).message;
  expect(message).toContain("xxx"); // stdout is represented
  expect(message).toContain("yyy"); // and so is stderr
  expect(message).toContain("…"); // both were truncated
  expect(message.length).toBeLessThan(1500); // 10_000 bytes each, bounded
});

test("global flags precede the subcommand", async () => {
  const argvOut = join(workdir, "argv");
  process.env.FAKE_COMFY_ARGV_OUT = argvOut;
  await runComfy(["workflow", "slots", "flow.json"]);

  const argv = readFileSync(argvOut, "utf8").trim().split(" ");
  // Landmine: `comfy workflow slots --skip-prompt` fails; the Typer root flags
  // must come first.
  expect(argv[0]).toBe("--skip-prompt");
  expect(argv.indexOf("--skip-prompt")).toBeLessThan(argv.indexOf("workflow"));
  expect(argv).toEqual(["--skip-prompt", "workflow", "slots", "flow.json"]);
});

test("kills the child and rejects when the timeout expires", async () => {
  process.env.FAKE_COMFY_MODE = "hang";
  const pidOut = join(workdir, "pid");
  process.env.FAKE_COMFY_PID_OUT = pidOut;

  const started = Date.now();
  const err = await rejection(runComfy(["run"], { timeoutMs: 250 }));
  const elapsed = Date.now() - started;

  expect(err).toBeInstanceOf(ComfyTimeoutError);
  expect((err as Error).message).toContain("250ms");
  expect(elapsed).toBeLessThan(1_500); // the budget bounds the call, near enough
  expect(await deadWithin(pidFrom(pidOut), 500)).toBe(true); // actually dead, not merely abandoned
});

test("the timeout kill signal is specifically SIGKILL, not SIGTERM", async () => {
  // A plain `sleep 30` dies to either signal, so it cannot tell them apart —
  // this fixture mode traps and ignores SIGTERM before exec'ing the sleeper,
  // so only SIGKILL (unblockable) can actually end it. A regression that
  // downgrades the kill signal would leave this one alive for its full 30s.
  process.env.FAKE_COMFY_MODE = "hang_ignore_sigterm";
  const pidOut = join(workdir, "pid");
  process.env.FAKE_COMFY_PID_OUT = pidOut;

  const started = Date.now();
  const err = await rejection(runComfy(["run"], { timeoutMs: 250 }));
  const elapsed = Date.now() - started;

  expect(err).toBeInstanceOf(ComfyTimeoutError);
  expect(elapsed).toBeLessThan(1_500);
  expect(await deadWithin(pidFrom(pidOut), 500)).toBe(true);
});

test("a timeout that leaves a descendant holding stdout still ends on time", async () => {
  // `comfy launch` exits while leaving a ComfyUI server running, and that
  // server inherits the stdout write end. Killing the child's pid does nothing
  // for the pipe, so only cancelling the read side can end the call.
  process.env.FAKE_COMFY_MODE = "orphan";
  const orphanOut = join(workdir, "orphan");
  process.env.FAKE_COMFY_ORPHAN_OUT = orphanOut;

  const started = Date.now();
  const err = await rejection(runComfy(["launch"], { timeoutMs: 250 }));
  const elapsed = Date.now() - started;

  // Reaped in `finally` so a regression that fails the assertions below does
  // not also leak the descendant for its full 30s lifetime.
  const orphan = pidFrom(orphanOut);
  try {
    expect(err).toBeInstanceOf(ComfyTimeoutError);
    expect(elapsed).toBeLessThan(1_500); // not the descendant's 30s lifetime
    expect(isAlive(orphan)).toBe(true); // deliberately survives; we only stop reading
  } finally {
    process.kill(orphan, "SIGKILL");
  }
});

test("a non-executable binary is reported as ComfyUnavailableError", async () => {
  const notExecutable = join(workdir, "not-executable");
  writeFileSync(notExecutable, "#!/bin/sh\necho hi\n");
  chmodSync(notExecutable, 0o644);
  process.env.COMFY_BIN = notExecutable;

  const err = await rejection(runComfy(["run"]));
  expect(err).toBeInstanceOf(ComfyUnavailableError);
  expect((err as ComfyUnavailableError).binary).toBe(notExecutable);
});

test("a missing cwd names the directory, not just the binary", async () => {
  // A bad cwd surfaces as ENOENT quoting the BINARY (e.g. "spawn /bin/echo
  // ENOENT"), not the missing directory — measured directly under both Node
  // and Deno — so a message that blames only the install sends the operator
  // to reinstall a working tool.
  const missing = join(workdir, "no-such-dir");
  const err = await rejection(runComfy(["run"], { cwd: missing }));
  expect(err).toBeInstanceOf(ComfyUnavailableError);
  expect((err as ComfyUnavailableError).message).toContain(missing);
});

test("a timeout keeps the stderr it managed to read", async () => {
  process.env.FAKE_COMFY_MODE = "hang";
  process.env.FAKE_COMFY_PID_OUT = join(workdir, "pid");
  const err = await rejection(runComfy(["run"], { timeoutMs: 250 }));
  const timeout = err as ComfyTimeoutError;
  // On a timeout stderr is usually the only evidence of what went wrong.
  expect(timeout.stderr).toContain("loading model checkpoint");
  expect(timeout.message).toContain("loading model checkpoint");
  expect(timeout.stdout).toBe("");
});

test("a timeout error is neither a CLI error nor a contract violation", async () => {
  process.env.FAKE_COMFY_MODE = "hang";
  process.env.FAKE_COMFY_PID_OUT = join(workdir, "pid");
  const err = await rejection(runComfy(["run"], { timeoutMs: 250 }));
  expect(err).not.toBeInstanceOf(ComfyCliError);
  expect(err).not.toBeInstanceOf(EnvelopeParseError);
});

test("stderr never contaminates parsing", async () => {
  process.env.FAKE_COMFY_MODE = "stderr_noise";
  expect(await runComfy(["workflow", "slots", "flow.json"])).toEqual({ slots: [] });
});

test("a valid ok:true envelope wins over a non-zero exit code", async () => {
  process.env.FAKE_COMFY_MODE = "exit1_ok";
  expect(await runComfy(["workflow", "slots", "flow.json"])).toEqual({ slots: [] });
});

test("a CLI error is distinguishable from a contract violation", async () => {
  process.env.FAKE_COMFY_MODE = "fail";
  const cliError = await rejection(runComfy(["run"]));
  expect(cliError).toBeInstanceOf(ComfyCliError);
  expect(cliError).not.toBeInstanceOf(EnvelopeParseError);

  process.env.FAKE_COMFY_MODE = "garbage";
  const parseError = await rejection(runComfy(["run"]));
  expect(parseError).toBeInstanceOf(EnvelopeParseError);
  expect(parseError).not.toBeInstanceOf(ComfyCliError);
});

test("a missing binary is reported as ComfyUnavailableError, not posix_spawn", async () => {
  process.env.COMFY_BIN = join(workdir, "definitely-not-installed");
  const err = await rejection(runComfy(["run"]));
  expect(err).toBeInstanceOf(ComfyUnavailableError);
  const message = (err as Error).message;
  expect(message).toContain("definitely-not-installed"); // the resolved binary
  expect(message).toContain("COMFY_BIN"); // and how to point us at the real one
  expect(message).toContain("PATH");
});

test("runs the child in the requested cwd", async () => {
  process.env.FAKE_COMFY_MODE = "cwd";
  const data = await runComfy(["run"], { cwd: workdir });
  expect(data).toEqual({ cwd: realpathSync(workdir) });
});

test("environment set after startup reaches the child", async () => {
  // `runComfyRaw` passes `env: process.env` explicitly (src/comfy/exec.ts)
  // rather than relying on a runtime's default forwarding behaviour, so a
  // COMFYUI_* var an operator sets stays forwarded even if that default
  // ever changes upstream. This asserts the explicit pass captures the
  // current environment, not a snapshot taken earlier.
  process.env.FAKE_COMFY_MODE = "echo_env";
  process.env.FAKE_COMFY_PROBE = "set-at-runtime";
  expect(await runComfy(["run"])).toEqual({ probe: "set-at-runtime" });
});

test("falls back to `comfy` on PATH when COMFY_BIN is unset", async () => {
  // PATH is replaced with a directory holding only the fake, so this can never
  // reach a real `comfy` installation.
  symlinkSync(FAKE_COMFY, join(workdir, "comfy"));
  const path = process.env.PATH;
  delete process.env.COMFY_BIN;
  process.env.PATH = workdir;
  try {
    expect(await runComfy(["workflow", "slots"])).toEqual({ slots: [] });
  } finally {
    process.env.PATH = path;
  }
});

test("runComfyRaw hands back both streams undecoded", async () => {
  // Task 3.2 runs `comfy run --json`, whose stdout is NDJSON and cannot be
  // whole-buffer parsed; it needs the streams, not an envelope.
  process.env.FAKE_COMFY_MODE = "garbage";
  const raw = await runComfyRaw(["workflow", "slots"]);
  expect(raw.stdout).toContain("not json at all");
  expect(raw.stderr).toContain("RuntimeError: boom");
  expect(raw.exitCode).toBe(1);
  expect(raw.commandLine).toContain("--skip-prompt workflow slots");
});

test("the resolved binary's directory reaches the child's PATH", async () => {
  // The bug this whole feature exists for: comfy-cli re-execs itself by bare
  // name, so an absolute COMFY_BIN alone is not enough.
  const pathOut = join(workdir, "child-path");
  process.env.FAKE_COMFY_MODE = "echo_path";
  process.env.FAKE_COMFY_PATH_OUT = pathOut;
  process.env.PATH = "/usr/bin";

  await runComfy(["workflow", "slots"]);

  const childPath = readFileSync(pathOut, "utf8").trim();
  expect(childPath.split(delimiter)[0]).toBe(dirname(FAKE_COMFY));
  expect(childPath.endsWith("/usr/bin")).toBe(true);
});

test("a comfy already on PATH leaves the child's PATH untouched", async () => {
  const pathOut = join(workdir, "child-path");
  const link = join(workdir, "comfy");
  symlinkSync(FAKE_COMFY, link);
  delete process.env.COMFY_BIN;
  process.env.PATH = workdir;
  process.env.FAKE_COMFY_MODE = "echo_path";
  process.env.FAKE_COMFY_PATH_OUT = pathOut;

  await runComfy(["workflow", "slots"]);

  // Rule 2 resolved this on PATH, so no repair was owed and none happened.
  // This test passed before the resolver was wired in too -- it cannot, and
  // does not, prove that rule 2 fired. It is a REGRESSION GUARD: it dies if
  // the repair is ever made unconditional, prepending a directory to a child
  // whose PATH already worked.
  expect(readFileSync(pathOut, "utf8").trim()).toBe(workdir);
});

test("the quoted command line names the resolved binary, not a stale one", async () => {
  // Also passed before the resolver was wired in: with COMFY_BIN set, the old
  // `process.env.COMFY_BIN ?? "comfy"` and the new `resolved.path` are the same
  // string. It guards the separate `argv` array that builds `commandLine` --
  // against being dropped or left pointing at a stale binary.
  process.env.FAKE_COMFY_MODE = "echo_path";
  process.env.FAKE_COMFY_PATH_OUT = join(workdir, "child-path");
  const run = await runComfyRaw(["workflow", "slots"]);
  expect(run.commandLine).toBe(`${FAKE_COMFY} --skip-prompt workflow slots`);
});

test("a comfy that is nowhere names every candidate that was tried", async () => {
  delete process.env.COMFY_BIN;
  process.env.PATH = join(workdir, "empty"); // exists but holds no comfy
  // HOME too, and this is not belt-and-braces: discovery's FIRST root is
  // `<home>/.local/bin`, which on a developer machine really does hold
  // comfy-cli. Without this the test does not fail cleanly -- it shells out to
  // the real CLI, breaking "tests never invoke the real `comfy`".
  process.env.HOME = workdir;

  const err = await rejection(runComfy(["workflow", "slots"]));

  expect(err).toBeInstanceOf(ComfyUnavailableError);
  const searched = (err as ComfyUnavailableError).searched;
  expect(searched).toBeDefined();
  // Not a length: /opt/homebrew/bin/comfy and /usr/local/bin/comfy may exist on
  // the machine running this. The home-derived root is the one we control.
  expect(searched).toContain(join(workdir, ".local", "bin", "comfy"));
  expect((err as Error).message).toContain("Searched:");
  // The existing two sentences must survive -- other tests assert on them.
  expect((err as Error).message).toContain("set COMFY_BIN to the binary's full path");
});

test("an explicit COMFY_BIN that is missing reports no search at all", async () => {
  // Nothing was searched, because naming a binary suppresses discovery.
  process.env.COMFY_BIN = join(workdir, "definitely-not-installed");
  const err = await rejection(runComfy(["workflow", "slots"]));
  expect(err).toBeInstanceOf(ComfyUnavailableError);
  expect((err as ComfyUnavailableError).searched).toBeUndefined();
  expect((err as Error).message).not.toContain("Searched:");
});
