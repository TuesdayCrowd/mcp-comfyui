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
 * leave one behind. Cancelling the read side is what unblocks us.
 */
function drain(stream: ReadableStream<Uint8Array>): { text: Promise<string>; cancel: () => void } {
  const reader = stream.getReader();
  const text = (async () => {
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  })();
  return { text, cancel: () => void reader.cancel().catch(() => {}) };
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

  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(argv, {
      cwd: opts.cwd,
      // Passed explicitly: Bun otherwise hands the child the environment as it
      // stood at startup, so anything set after boot — PATH, COMFYUI_* — would
      // be invisible to `comfy`.
      env: process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (cause) {
    // Bun throws this synchronously, before any of the handling below applies.
    throw new ComfyUnavailableError(binary, opts.cwd, cause);
  }

  // Both pipes are drained concurrently: reading them in sequence deadlocks as
  // soon as the other one fills its buffer.
  const out = drain(proc.stdout);
  const err = drain(proc.stderr);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    // SIGKILL rather than SIGTERM: the point of the timeout is that this child
    // has stopped behaving, so it gets no say in whether it dies.
    proc.kill("SIGKILL");
    // ...and killing it is not enough. Descendants hold the same write end, so
    // without cancelling the reads this call would go on waiting for them.
    out.cancel();
    err.cancel();
  }, timeoutMs);

  let stdout: string;
  let stderr: string;
  try {
    [stdout, stderr] = await Promise.all([out.text, err.text]);
    await proc.exited;
  } catch (cause) {
    // A failed drain must not leave the child running: `finally` is about to
    // clear the only timer that would have killed it. Cancel the reads too —
    // a SIGKILL alone leaves any descendant holding the write end, and the
    // surviving reader would then pend forever with nobody awaiting it.
    proc.kill("SIGKILL");
    out.cancel();
    err.cancel();
    throw cause;
  } finally {
    clearTimeout(timer);
  }

  if (timedOut) throw new ComfyTimeoutError(commandLine, timeoutMs, stdout, stderr);

  return { stdout, stderr, exitCode: proc.exitCode, commandLine };
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
