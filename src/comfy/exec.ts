import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import {
  EnvelopeParseError,
  parseEnvelope,
  snippet,
  type ComfyError,
  type ParsedEnvelope,
} from "./envelope.ts";

/**
 * The one place this server spawns `comfy`. Everything above it asks for a
 * command and gets back the `data` payload of a success envelope, or a typed
 * error.
 */

/**
 * A root-level Typer flag, so it must precede the subcommand: `comfy workflow
 * slots --skip-prompt` fails where `comfy --skip-prompt workflow slots` works.
 * Prepending it unconditionally also stops the CLI from blocking on an
 * interactive prompt no MCP client can answer.
 */
const SKIP_PROMPT = "--skip-prompt";

const DEFAULT_TIMEOUT_MS = 120_000;

export interface RunOptions {
  timeoutMs?: number;
  cwd?: string;
}

/** One finished `comfy` invocation, undecoded. */
export interface ComfyRun {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** The invocation as it was spelled, for diagnostics. */
  commandLine: string;
}

/**
 * A failure the CLI reported in an `ok:false` envelope. Callers branch on
 * {@link code}; the code registry is append-only, so an unrecognised code means
 * "pass the message through", never "crash".
 */
export class ComfyCliError extends Error {
  override readonly name = "ComfyCliError";
  /** The failing command as the CLI named it, e.g. `"workflow slots"`. */
  readonly command: string;
  readonly code: string;
  readonly hint: string | null;
  /** The CLI's local-vs-cloud routing target, unrecoverable once dropped. */
  readonly where: string | null;
  readonly details: unknown;

  constructor(command: string, where: string | null, error: ComfyError) {
    super(`comfy ${command} failed (${error.code}): ${error.message}`);
    this.command = command;
    this.code = error.code;
    this.hint = error.hint ?? null;
    this.where = where;
    this.details = error.details ?? null;
  }
}

/**
 * The `comfy` binary could not be started at all — the likeliest first-run
 * failure of this whole server, and one the operator can only fix if we name
 * what we tried to run.
 */
export class ComfyUnavailableError extends Error {
  override readonly name = "ComfyUnavailableError";
  readonly binary: string;
  readonly cwd: string | undefined;

  constructor(binary: string, cwd: string | undefined, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      // Name the cwd too: a missing working directory surfaces as ENOENT
      // quoting the BINARY, so blaming the install alone sends the operator to
      // reinstall a tool that was never broken.
      `could not start the comfy CLI at \`${binary}\`${cwd ? ` (cwd: ${cwd})` : ""}: ${reason}\n` +
        `Install comfy-cli and put it on PATH, or set COMFY_BIN to the binary's full path.`,
      { cause },
    );
    this.binary = binary;
    this.cwd = cwd;
  }
}

/** The child outlived its budget and was killed. */
export class ComfyTimeoutError extends Error {
  override readonly name = "ComfyTimeoutError";
  readonly commandLine: string;
  readonly timeoutMs: number;
  /** Whatever had been read when the budget ran out. */
  readonly stdout: string;
  readonly stderr: string;

  constructor(commandLine: string, timeoutMs: number, stdout: string, stderr: string) {
    // stderr is quoted because on a timeout it is usually the only evidence of
    // what the CLI was doing: a traceback, a stalled model load, a CUDA message.
    super(
      `${commandLine} timed out after ${timeoutMs}ms and was killed\n` +
        `  stderr: ${snippet(stderr)}`,
    );
    this.commandLine = commandLine;
    this.timeoutMs = timeoutMs;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/**
 * Drain a pipe to text, with a handle to abandon the read. Killing the child is
 * not enough to end a read: every descendant inherits the pipe's write end, so
 * EOF waits on the slowest grandchild — and `comfy launch` exists precisely to
 * leave one behind. `cancel()` destroys *our* end of the pipe instead: Node's
 * `stream.destroy()` closes this process's read descriptor outright, which
 * needs no cooperation from whichever descendant is still holding the write
 * end open.
 */
function drain(stream: Readable): { text: Promise<string>; cancel: () => void } {
  const chunks: Buffer[] = [];
  let settled = false;
  let resolveText!: (value: string) => void;
  let rejectText!: (cause: unknown) => void;
  const text = new Promise<string>((resolve, reject) => {
    resolveText = resolve;
    rejectText = reject;
  });
  const finish = () => {
    if (settled) return;
    settled = true;
    resolveText(Buffer.concat(chunks).toString("utf8"));
  };
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  // `end` is the natural EOF; `close` also fires once `cancel()` destroys the
  // stream ourselves, which is exactly the case a descendant is still holding
  // the write end open and no `end` is ever coming.
  stream.on("end", finish);
  stream.on("close", finish);
  stream.on("error", (cause: unknown) => {
    if (settled) return;
    settled = true;
    rejectText(cause);
  });
  return { text, cancel: () => void stream.destroy() };
}

/** Resolve once the child has actually exited, reported by Node's `exit` event. */
function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

/**
 * Run one `comfy` command under a timeout and hand back its raw streams.
 *
 * Callers that expect a single whole-buffer envelope want {@link runComfy};
 * this exists for `comfy run --json`, whose stdout is NDJSON and has to be
 * decoded a line at a time.
 *
 * @param args  the subcommand and its flags; `--skip-prompt` is prepended.
 * @throws {ComfyUnavailableError} the binary could not be started.
 * @throws {ComfyTimeoutError} the child exceeded `timeoutMs` and was killed.
 */
export async function runComfyRaw(args: string[], opts: RunOptions = {}): Promise<ComfyRun> {
  const binary = process.env.COMFY_BIN ?? "comfy";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const argv = [binary, SKIP_PROMPT, ...args];
  const commandLine = argv.join(" ");

  const child = spawn(binary, [SKIP_PROMPT, ...args], {
    cwd: opts.cwd,
    // Passed explicitly, on principle: Node already forwards live
    // `process.env` to a spawned child by default (verified directly), so
    // this is defensive rather than required — every spawn in this project
    // passes `env` anyway so the behaviour cannot regress if that default
    // ever changes upstream. Historically load-bearing under this project's
    // former Bun toolchain (landmine #17): Bun's spawn captured the
    // environment only at process start and ignored runtime mutations
    // unless `env` was passed explicitly.
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Node reports a spawn failure only asynchronously via an `error` event —
  // there is no synchronous throw to catch here. `spawn` is the
  // complementary success signal (fired once the OS call has actually gone
  // through), so racing the two turns Node's async report back into the same
  // fails-before-anything-else contract this module already promised its
  // callers.
  let startedSettled = false;
  const started = new Promise<void>((resolve, reject) => {
    child.once("spawn", () => {
      startedSettled = true;
      resolve();
    });
    // A persistent listener, not `.once`: Node throws (crashing this process)
    // when an `error` event has no listener at all, and this one must go on
    // swallowing a *later* error — e.g. one after the child has already
    // spawned — once the initial race above has already settled.
    child.on("error", (cause: unknown) => {
      if (startedSettled) return;
      startedSettled = true;
      reject(new ComfyUnavailableError(binary, opts.cwd, cause));
    });
  });
  await started;

  if (child.stdout === null || child.stderr === null) {
    // Unreachable with `stdio: ["ignore", "pipe", "pipe"]`; keeps the types
    // honest without a non-null assertion.
    throw new ComfyUnavailableError(binary, opts.cwd, new Error("child produced no stdio pipes"));
  }

  // Both pipes are drained concurrently: reading them in sequence deadlocks as
  // soon as the other one fills its buffer.
  const out = drain(child.stdout);
  const err = drain(child.stderr);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    // SIGKILL rather than SIGTERM: the point of the timeout is that this child
    // has stopped behaving, so it gets no say in whether it dies.
    child.kill("SIGKILL");
    // ...and killing it is not enough. Descendants hold the same write end, so
    // without cancelling the reads this call would go on waiting for them.
    out.cancel();
    err.cancel();
  }, timeoutMs);

  let stdout: string;
  let stderr: string;
  try {
    [stdout, stderr] = await Promise.all([out.text, err.text]);
    await exited(child);
  } catch (cause) {
    // A failed drain must not leave the child running: `finally` is about to
    // clear the only timer that would have killed it. Cancel the reads too —
    // a SIGKILL alone leaves any descendant holding the write end, and the
    // surviving reader would then pend forever with nobody awaiting it.
    child.kill("SIGKILL");
    out.cancel();
    err.cancel();
    throw cause;
  } finally {
    clearTimeout(timer);
  }

  if (timedOut) throw new ComfyTimeoutError(commandLine, timeoutMs, stdout, stderr);

  return { stdout, stderr, exitCode: child.exitCode, commandLine };
}

/**
 * Decode stdout, or explain why it could not be decoded. The exit code alone is
 * useless — upstream returns 1 for a missing file, a downed server, an HTTP
 * error and a failed run alike — so the diagnostic carries the invocation and
 * both streams. stderr is quoted here but never parsed: it holds human text.
 */
function decodeStdout(run: ComfyRun): ParsedEnvelope {
  try {
    return parseEnvelope(run.stdout);
  } catch (cause) {
    if (!(cause instanceof EnvelopeParseError)) throw cause;
    throw new EnvelopeParseError(
      `${run.commandLine} exited with code ${run.exitCode} and produced no usable envelope/1 on stdout\n` +
        // The reason quotes stdout already; only stderr still needs saying.
        `  reason: ${cause.message}\n` +
        `  stderr: ${snippet(run.stderr)}`,
      run.stdout,
      { cause },
    );
  }
}

/**
 * Run one `comfy` command and resolve with the `data` of its success envelope.
 *
 * @param args  the subcommand and its flags; `--skip-prompt` is prepended.
 * @throws {ComfyUnavailableError} the binary could not be started.
 * @throws {ComfyTimeoutError} the child exceeded `timeoutMs` and was killed.
 * @throws {ComfyCliError} the CLI reported a failure envelope.
 * @throws {EnvelopeParseError} stdout was not a usable `envelope/1`.
 */
export async function runComfy(args: string[], opts: RunOptions = {}): Promise<unknown> {
  const run = await runComfyRaw(args, opts);
  const envelope = decodeStdout(run);
  if (!envelope.ok) throw new ComfyCliError(envelope.command, envelope.where, envelope.error);
  return envelope.data;
}
