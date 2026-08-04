import { z } from "zod";
import { AUTO_LAUNCH_ENV, WORKSPACE_ENV } from "../config.ts";
import { snippet } from "./envelope.ts";
import { ComfyCliError, ComfyUnavailableError, runComfy } from "./exec.ts";
import { DEFAULT_PORT, authority, resolveHost } from "./target.ts";

/**
 * Is a ComfyUI answering, and — only when nothing is — may we start one.
 *
 * The order matters more than either half. This user runs ComfyUI Desktop,
 * which manages its own process and is **not** a comfy-cli workspace, so
 * `comfy launch` here would start a *second, competing* instance: two servers
 * bidding for port 8188, for the same 48GB of unified memory, and for the same
 * shared model directory. Detection is therefore the primary job of this module
 * and launching is the fallback, guarded by it (landmine #8).
 *
 * `/system_stats` is the probe because it is cheap, unauthenticated, and
 * present in every ComfyUI this server could talk to. Its body is parsed
 * defensively: the shape below was captured from a live 0.29.0 Desktop, and
 * every field inside it is optional because older and newer builds report
 * different sets. A missing field degrades one value, never the detection.
 */

/**
 * Short, because every operation probes first: an address that black-holes
 * packets must not stall a tool call. A refused connection on loopback returns
 * far inside this, so the budget only bites on a firewall drop or an instance
 * whose event loop is wedged.
 */
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

/**
 * How long to wait for a launched ComfyUI to answer.
 *
 * Five minutes, raised from two when launching became something this server does
 * on its own initiative rather than only on an explicit request. A cold start
 * imports torch, initialises MPS and scans every model and custom node on disk,
 * and on this machine's shared model directory that is comfortably a minute
 * before anything binds a port; a machine with many custom nodes is worse.
 *
 * The cost of being generous is bounded and the cost of being mean is not. A
 * failure the CLI has *diagnosed* — `not_in_workspace`, `port_in_use`, a missing
 * binary — aborts this wait immediately (see {@link isVerdict}), so the full
 * budget is only ever spent on a ComfyUI that really is starting. Cutting it
 * short would report a failure for a server that was thirty seconds away, and
 * leave it running afterwards for good measure.
 */
const DEFAULT_READY_TIMEOUT_MS = 300_000;

/** Between readiness probes. Short enough to feel immediate, idle otherwise. */
const DEFAULT_POLL_INTERVAL_MS = 500;

/**
 * The root-level JSON mode flag. Piped stdout would select JSON anyway, but
 * behaviour must never depend on TTY detection (landmine #2), and it is a Typer
 * *root* flag so it precedes the subcommand (landmine #3).
 */
const JSON_MODE = "--json";

/**
 * `comfy launch` runs ComfyUI in the **foreground** by default, which for this
 * server would mean holding a pipe to a process that lives for hours and dies
 * with us. `--background` re-invokes the CLI detached and answers with a single
 * envelope instead. Its own readiness signal is a log scrape for the literal
 * string `"To see the GUI go to:"` (landmine #9); that is deliberately not
 * relied on here — see {@link launchInstance}.
 */
const BACKGROUND = "--background";

/**
 * Everything after a bare `--` is a trailing positional, which is how the CLI
 * receives ComfyUI's own startup arguments. **There is no `--extra-args` flag**;
 * `launch(extra: list[str] = typer.Argument(None))` is the whole contract.
 */
const SEPARATOR = "--";

/**
 * The workspace flag, and a **Typer root flag** — so it precedes the subcommand
 * (landmine #3): `comfy launch --workspace <p>` fails where
 * `comfy --workspace <p> launch` works.
 *
 * It matters more than it looks. comfy-cli resolves its workspace from its own
 * config (`default_workspace`, then `recent_workspace`) and falls back to
 * `~/Documents/comfy/ComfyUI` — a path that need not exist, and on a machine
 * whose config names neither, does not. A bare `comfy launch` there fails
 * `not_in_workspace` before it starts anything.
 */
const WORKSPACE_FLAG = "--workspace";

/** The one launch failure this module says more about than the CLI does. */
const NOT_IN_WORKSPACE = "not_in_workspace";

/** ComfyUI startup flags whose value this module reads back out of an argv. */
const LISTEN_FLAG = "--listen";
const PORT_FLAG = "--port";
const OUTPUT_DIRECTORY_FLAG = "--output-directory";
const INPUT_DIRECTORY_FLAG = "--input-directory";

/**
 * C0 controls and DEL. No ComfyUI startup flag or path anyone has contains one,
 * they can smuggle two arguments into what reads as one, and they corrupt every
 * diagnostic that quotes a command line.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** The TCP port range, inclusive. */
const MIN_PORT = 1;
const MAX_PORT = 65535;

/**
 * One accelerator, as `/system_stats` reports it. Loose because the payload
 * carries `torch_vram_*` alongside these and may carry more; nullable because a
 * CPU-only build reports a device with no VRAM figures at all.
 */
const DeviceSchema = z.looseObject({
  name: z.string().optional(),
  type: z.string().optional(),
  vram_total: z.number().nullable().optional(),
  vram_free: z.number().nullable().optional(),
});

/**
 * Every field optional on purpose. `comfyui_version` and `argv` are the two
 * worth having and neither is guaranteed: `argv` in particular is the only
 * place an instance says how it was started, and a build that omits it must
 * still detect.
 */
const SystemSchema = z.looseObject({
  os: z.string().optional(),
  comfyui_version: z.string().optional(),
  python_version: z.string().optional(),
  pytorch_version: z.string().optional(),
  /** `local-desktop2-standalone` on a Desktop-managed process. Open string. */
  deploy_environment: z.string().optional(),
  argv: z.array(z.string()).optional(),
  ram_total: z.number().nullable().optional(),
  ram_free: z.number().nullable().optional(),
});

/**
 * Both members are optional so a build reporting only one of them still
 * detects, but at least one must be **present** — see {@link parseSystemStats}.
 * Their types are enforced where their contents are not: a `system` that is a
 * string is a contract break, not a version difference.
 */
const SystemStatsSchema = z.looseObject({
  system: SystemSchema.optional(),
  devices: z.array(DeviceSchema).optional(),
});

/** One accelerator, flattened, with absent figures made explicit. */
export interface InstanceDevice {
  name: string | null;
  type: string | null;
  vramTotal: number | null;
  vramFree: number | null;
}

/** A ComfyUI answered at this address. */
export interface RunningInstance {
  running: true;
  /** The `/system_stats` URL that was probed. */
  url: string;
  /** The resolved connect host — never a wildcard bind address. */
  host: string;
  port: number;
  /** `system.comfyui_version`, or null on a build that does not report one. */
  version: string | null;
  devices: InstanceDevice[];
  /** How the running instance was started. Null where it does not say. */
  argv: string[] | null;
  /** `system.deploy_environment` verbatim, so a spelling we do not know survives. */
  deployEnvironment: string | null;
  /**
   * Whether this process is managed by ComfyUI Desktop — and therefore not
   * ours to stop, restart, or launch alongside.
   *
   * **Three-valued.** `null` means the instance did not say, which is not the
   * same as "no": every ComfyUI predating `deploy_environment` reports nothing,
   * and answering `false` there would be a claim this server cannot support
   * about the one question that decides whether it may manage the process.
   */
  desktopManaged: boolean | null;
  /** Recovered from {@link argv}; null when it was not started with the flag. */
  outputDirectory: string | null;
  inputDirectory: string | null;
}

/** Nothing usable answered. The normal state of a machine, not a fault. */
export interface AbsentInstance {
  running: false;
  url: string;
  host: string;
  port: number;
  /** Why the probe did not yield an instance, in the operator's terms. */
  reason: string;
}

export type InstanceDetection = RunningInstance | AbsentInstance;

export interface DetectOptions {
  /** Defaults to `127.0.0.1`; the wildcards `0.0.0.0` and `::` rewrite to it. */
  host?: string;
  /** Defaults to `8188`. */
  port?: number;
  /** Budget for the probe. Defaults to 2 seconds. */
  timeoutMs?: number;
}

/**
 * The curated startup arguments, as typed options.
 *
 * Every one of these is passed to **ComfyUI**, not to `comfy`, and lands after
 * the `--` separator. Anything not listed goes through
 * {@link LaunchOptions.extraArgs}.
 */
export interface LaunchArgs {
  /** ComfyUI's bind address. `0.0.0.0` binds every interface. */
  listen?: string;
  /** ComfyUI's port. Readiness is polled here, not on the detection port. */
  port?: number;
  lowvram?: boolean;
  novram?: boolean;
  highvram?: boolean;
  cpu?: boolean;
  outputDirectory?: string;
  inputDirectory?: string;
  extraModelPathsConfig?: string;
  /** Stop ComfyUI opening a browser window on a machine nobody is looking at. */
  disableAutoLaunch?: boolean;
  verbose?: boolean;
}

export interface LaunchOptions {
  /** The address checked before launching, and polled unless the args override it. */
  host?: string;
  port?: number;
  /**
   * The ComfyUI directory to launch from — the one holding `main.py` — sent as
   * the root flag `--workspace`. Omit to let comfy resolve its own default or
   * recent workspace, which is what a user who has run `comfy install` wants.
   */
  workspace?: string;
  args?: LaunchArgs;
  /**
   * Startup arguments the allowlist does not cover, passed through verbatim
   * after the same `--`. Validated — see {@link LaunchArgumentError}.
   */
  extraArgs?: string[];
  /** How long to wait for the launched instance to answer. Defaults to 2 minutes. */
  timeoutMs?: number;
  /** Budget for each individual probe. Defaults to 2 seconds. */
  probeTimeoutMs?: number;
  /** Gap between readiness probes. Defaults to 500ms. */
  pollIntervalMs?: number;
}

/**
 * What a launch attempt did.
 *
 * A returned union rather than a thrown refusal, on the same reasoning as
 * `comfy/jobs.ts`'s `CancelResult`: on this machine `already_running` is the
 * *expected* outcome, not a fault, and an exception would force a try/catch
 * around the common path and be reported to a model as an error worth
 * retrying. Both arms carry the same instance details, so a caller that only
 * wants to know about the instance reads `.instance` either way.
 *
 * Genuine faults still throw: {@link LaunchArgumentError} for arguments this
 * server will not send, {@link ComfyCliError} for a failure the CLI diagnosed
 * (`not_in_workspace`, `port_in_use`), {@link ComfyUnavailableError} for a
 * binary that could not be started, and {@link LaunchTimeoutError} for a server
 * that never answered.
 */
export type LaunchResult =
  | { outcome: "already_running"; instance: RunningInstance }
  | { outcome: "launched"; instance: RunningInstance };

/**
 * An argument this server refuses to send. Thrown before anything is probed or
 * spawned, so a rejected launch has no side effects at all.
 */
export class LaunchArgumentError extends Error {
  override readonly name = "LaunchArgumentError";
}

/**
 * Nothing is answering and this server is not permitted to start anything.
 *
 * Its own type rather than a bare failure because it is the one launch-adjacent
 * outcome with a fix the *operator* holds: every other failure here is about a
 * launch that was attempted, and this one is about a launch that was declined.
 * The message names both ways out — start ComfyUI, or let this server do it —
 * because which is appropriate depends on a preference only they have.
 */
export class InstanceUnavailableError extends Error {
  override readonly name = "InstanceUnavailableError";
  /** The address that was probed. */
  readonly url: string;
  /** The probe's own account of why nothing answered. */
  readonly reason: string;

  constructor(absent: AbsentInstance) {
    super(
      `no ComfyUI is answering at ${absent.url}: ${absent.reason}\n` +
        `Start ComfyUI yourself, or set ${AUTO_LAUNCH_ENV}=1 to let this server start one ` +
        `when a tool needs it.`,
    );
    this.url = absent.url;
    this.reason = absent.reason;
  }
}

/**
 * The CLI was invoked but no ComfyUI answered inside the budget. Names the
 * budget and the address, the two things an operator can change, and carries
 * the last probe's own reason so a silent wait is never the whole diagnosis.
 */
export class LaunchTimeoutError extends Error {
  override readonly name = "LaunchTimeoutError";
  readonly url: string;
  readonly timeoutMs: number;

  constructor(url: string, timeoutMs: number, lastReason: string, cliFailure: string | null) {
    super(
      `ComfyUI did not answer at ${url} within ${timeoutMs}ms of \`comfy launch\`\n` +
        `  last probe: ${lastReason}` +
        // Only when the CLI itself also failed: a launch that never started is
        // a different problem from one that started and is still loading.
        (cliFailure === null ? "" : `\n  comfy launch: ${cliFailure}`),
    );
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}

/** The `/system_stats` URL for one instance. */
function statsUrl(host: string, port: number): string {
  // `authority` brackets an IPv6 literal; without it `fetch` rejects the whole
  // string before a packet moves.
  return `http://${authority(host, port)}/system_stats`;
}

/**
 * The payload, or null if this is not a ComfyUI answering. Requiring one of the
 * two documented top-level keys is what keeps "something else is listening on
 * 8188" from reading as an instance; requiring nothing of either field's
 * *contents* is what keeps a version difference from reading as an absence.
 */
function parseSystemStats(body: string): z.infer<typeof SystemStatsSchema> | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  const result = SystemStatsSchema.safeParse(value);
  if (!result.success) return null;
  if (result.data.system === undefined && result.data.devices === undefined) return null;
  return result.data;
}

/**
 * The value of a ComfyUI startup flag within an argv, in either spelling:
 * `--flag value` and `--flag=value` are both current, and comfy-cli's own
 * background launcher reads both. Last occurrence wins, as argparse does.
 */
function flagValue(argv: readonly string[], flag: string): string | null {
  const prefix = `${flag}=`;
  let found: string | null = null;
  for (const [index, token] of argv.entries()) {
    if (token === flag) {
      const next = argv[index + 1];
      // A trailing `--port` with another flag after it carries no value.
      if (next !== undefined && !next.startsWith("-")) found = next;
    } else if (token.startsWith(prefix)) {
      found = token.slice(prefix.length);
    }
  }
  return found;
}

/**
 * Desktop manages its own ComfyUI process. `deploy_environment` is the only
 * field that names a manager, and matching a substring rather than the whole
 * string is deliberate: this user's build reports `local-desktop2-standalone`,
 * so the exact value is already versioned.
 */
function isDesktopManaged(deployEnvironment: string | null): boolean | null {
  if (deployEnvironment === null) return null;
  return /desktop/i.test(deployEnvironment);
}

function describeProbeFailure(cause: unknown, timeoutMs: number): string {
  // A timeout is not a refusal: something may well be there and merely busy, so
  // it says so rather than sending the operator to check a running server.
  if (cause instanceof Error && cause.name === "TimeoutError") {
    return `no response within ${timeoutMs}ms`;
  }
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Whether a ComfyUI is answering at an address, and what it is.
 *
 * **A refused connection resolves with `running: false`; it does not throw.**
 * Nothing running is the normal state of a machine, and every operation in this
 * server probes before it acts — a throw would make "ComfyUI is not running"
 * indistinguishable from "this server is broken", and would push a try/catch
 * into every caller for the ordinary case.
 *
 * @throws {TypeError} `host` was present but empty — a misconfiguration that
 * would otherwise be reported as an unreachable server.
 */
export async function detectInstance(opts: DetectOptions = {}): Promise<InstanceDetection> {
  const host = resolveHost(opts.host); // landmine #10: a bind address is not a connect one
  const port = opts.port ?? DEFAULT_PORT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const url = statsUrl(host, port);
  const absent = (reason: string): AbsentInstance => ({ running: false, url, host, port, reason });

  let response: Response;
  let body: string;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    body = await response.text();
  } catch (cause) {
    return absent(describeProbeFailure(cause, timeoutMs));
  }

  if (!response.ok) {
    return absent(`HTTP ${response.status} ${response.statusText} (${snippet(body)})`);
  }

  const payload = parseSystemStats(body);
  if (payload === null) {
    // Absent rather than an error: from a caller's point of view a port
    // answering with something that is not ComfyUI is a port with no ComfyUI on
    // it, and the reason quotes what did arrive.
    return absent(`the response was not ComfyUI's /system_stats (received: ${snippet(body)})`);
  }

  const system = payload.system ?? {};
  const argv = system.argv ?? null;
  const deployEnvironment = system.deploy_environment ?? null;

  return {
    running: true,
    url,
    host,
    port,
    version: system.comfyui_version ?? null,
    devices: (payload.devices ?? []).map((device) => ({
      name: device.name ?? null,
      type: device.type ?? null,
      vramTotal: device.vram_total ?? null,
      vramFree: device.vram_free ?? null,
    })),
    argv,
    deployEnvironment,
    desktopManaged: isDesktopManaged(deployEnvironment),
    outputDirectory: argv === null ? null : flagValue(argv, OUTPUT_DIRECTORY_FLAG),
    inputDirectory: argv === null ? null : flagValue(argv, INPUT_DIRECTORY_FLAG),
  };
}

/**
 * ComfyUI's own argument vector, in a fixed order: the allowlist first, the
 * caller's escape hatch last. Last-wins is argparse's rule and comfy-cli's, so
 * an `extraArgs` entry deliberately overrides the typed option of the same name
 * rather than silently losing to it.
 */
function comfyuiArgs(args: LaunchArgs, extraArgs: readonly string[]): string[] {
  const argv: string[] = [];
  if (args.listen !== undefined) argv.push(LISTEN_FLAG, args.listen);
  if (args.port !== undefined) argv.push(PORT_FLAG, String(args.port));
  if (args.lowvram) argv.push("--lowvram");
  if (args.novram) argv.push("--novram");
  if (args.highvram) argv.push("--highvram");
  if (args.cpu) argv.push("--cpu");
  if (args.outputDirectory !== undefined) argv.push(OUTPUT_DIRECTORY_FLAG, args.outputDirectory);
  if (args.inputDirectory !== undefined) argv.push(INPUT_DIRECTORY_FLAG, args.inputDirectory);
  if (args.extraModelPathsConfig !== undefined) {
    argv.push("--extra-model-paths-config", args.extraModelPathsConfig);
  }
  if (args.disableAutoLaunch) argv.push("--disable-auto-launch");
  if (args.verbose) argv.push("--verbose");
  return [...argv, ...extraArgs];
}

/**
 * Every token this server would put after the `--`, validated as one list so
 * that a curated option's value and a free-form `extraArgs` entry are held to
 * the same rules — the escape hatch is the thing most likely to carry a
 * caller's mistake, but a directory path is no safer for having a typed field.
 *
 * @throws {LaunchArgumentError} for an empty token, a token holding a control
 * character, or a second `--`.
 */
function validateComfyuiArgs(argv: readonly string[]): void {
  for (const token of argv) {
    if (token === "") {
      throw new LaunchArgumentError(
        "refusing to launch: a startup argument is empty. ComfyUI reads it as an unrecognised " +
          "positional and fails, and it is invisible in every command line that quotes it.",
      );
    }
    if (token === SEPARATOR) {
      throw new LaunchArgumentError(
        "refusing to launch: `--` cannot be a startup argument. One `--` already separates " +
          "ComfyUI's arguments from comfy's own, and a second makes that boundary unreadable.",
      );
    }
    if (CONTROL_CHARACTERS.test(token)) {
      throw new LaunchArgumentError(
        `refusing to launch: startup argument ${JSON.stringify(token)} holds a control ` +
          "character. No ComfyUI flag or path contains one, it can smuggle two arguments into " +
          "what reads as one, and it corrupts every command line that quotes it.",
      );
    }
  }
}

/**
 * The address the launched instance will actually listen on — which is the
 * address readiness must be polled at. Reading it back out of the assembled
 * argv rather than off `LaunchArgs` is what makes an `extraArgs` `--port=9000`
 * count too; polling the detection port instead would report a successful
 * launch as a timeout.
 *
 * @throws {LaunchArgumentError} the port is not a TCP port. Caught here rather
 * than left to the CLI because the alternative is waiting out the whole
 * readiness budget on a port nothing could ever have bound.
 */
interface Target {
  host: string;
  port: number;
}

function launchTarget(opts: LaunchOptions, argv: readonly string[]): Target {
  const listen = flagValue(argv, LISTEN_FLAG);
  const port = flagValue(argv, PORT_FLAG);

  return {
    // A wildcard `--listen` is a bind address, not a connect address; the same
    // rewrite as everywhere else in this server (landmine #10).
    host: resolveHost(listen ?? opts.host),
    port: port === null ? (opts.port ?? DEFAULT_PORT) : parsePort(port),
  };
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new LaunchArgumentError(
      `refusing to launch: --port ${value} is not a TCP port (expected ${MIN_PORT}-${MAX_PORT}).`,
    );
  }
  return port;
}

/**
 * The CLI invocation. Root flags first (landmine #3), then the subcommand, then
 * `--background`, then the separator — and the separator only when there is
 * something to separate, since a trailing bare `--` is noise in every
 * diagnostic. `--skip-prompt` is `runComfy`'s to prepend.
 */
function launchArgv(argv: readonly string[], workspace: string | undefined): string[] {
  // `--workspace` joins `--json` ahead of the subcommand, because both are Typer
  // root flags. Putting it after `launch` is not a style difference: Typer
  // rejects it there, and the launch fails for a reason that has nothing to do
  // with the workspace.
  const root = workspace === undefined ? [JSON_MODE] : [WORKSPACE_FLAG, workspace, JSON_MODE];
  const invocation = [...root, "launch", BACKGROUND];
  return argv.length === 0 ? invocation : [...invocation, SEPARATOR, ...argv];
}

/**
 * Say what an operator can do about a workspace comfy could not find.
 *
 * This is the expected first failure on a machine whose comfy-cli config records
 * neither a default nor a recent workspace: the CLI falls back to a path under
 * `~/Documents` that need not exist, and reports only `not_in_workspace`. The
 * code alone sends nobody anywhere.
 *
 * Deliberately generic about *which* directory to name. Whatever installs
 * happen to be on one machine is that machine's accident, and a message that
 * guessed between two of them would eventually point at the wrong ComfyUI —
 * which, pointed at the same shared model directory, is a mistake nobody would
 * see until the output was wrong.
 */
function workspaceGuidance(workspace: string | undefined): string {
  const passed =
    workspace === undefined
      ? `This server sent no ${WORKSPACE_FLAG}, so comfy resolved one of its own.`
      : `This server sent ${WORKSPACE_FLAG} ${workspace}; check that that directory exists ` +
        `and holds main.py.`;
  return (
    `${passed}\n` +
    `comfy-cli takes its workspace from its own config (default_workspace, then ` +
    `recent_workspace) and otherwise falls back to a path under ~/Documents that does not ` +
    `exist unless something created it.\n` +
    `Set ${WORKSPACE_ENV} to the ComfyUI directory to launch — the one holding main.py — or ` +
    `run \`comfy install\` once to create a workspace and record it.`
  );
}

/**
 * Enrich the one verdict whose fix is not visible from its code.
 *
 * Rewritten in place rather than re-thrown as a new error, exactly as
 * `workflows/slots.ts` does and for the same reason: `ComfyCliError` keeps only
 * its formatted message, so re-constructing would double-prefix, and callers
 * branching on `.code` must go on working.
 *
 * INVARIANT: nothing may read `err.stack` between `runComfy` rejecting and this
 * line. A JSC stack embeds the `Name: message` header and memoizes on first
 * read, so a logger added in that window would freeze the pre-enrichment text
 * into `.stack` while `.message` carried the guidance, with nothing to explain
 * the disagreement.
 */
function explainVerdict(failure: unknown, workspace: string | undefined): unknown {
  if (failure instanceof ComfyCliError && failure.code === NOT_IN_WORKSPACE) {
    failure.message = `${failure.message}\n${workspaceGuidance(workspace)}`;
  }
  return failure;
}

/**
 * A failure the CLI has *diagnosed*, as opposed to one it merely suffered.
 *
 * Only these two abort the readiness wait. `not_in_workspace` (what this user's
 * machine answers, since ComfyUI Desktop is not a comfy-cli workspace),
 * `port_in_use` and `server_already_running` are verdicts: no ComfyUI is coming,
 * and waiting two minutes to discover that helps nobody. A timeout or an
 * unreadable envelope is not a verdict — the CLI may simply have failed to tell
 * us about a server that is starting anyway, and the HTTP probe is the
 * authority on that.
 */
function isVerdict(failure: unknown): boolean {
  return failure instanceof ComfyCliError || failure instanceof ComfyUnavailableError;
}

/**
 * Start the CLI without waiting for it, and hand back a view of how it fared.
 *
 * Not awaiting is the whole point. `comfy launch --background` does not return
 * when ComfyUI is ready — it returns when it has scraped `"To see the GUI go
 * to:"` out of a logfile, and if upstream ever changes that string it does not
 * return at all until the server exits. Awaiting it would make this server's
 * readiness depend on that log line by the back door (landmine #9).
 *
 * Nothing awaits the returned promise, so the rejection handler is what keeps a
 * late failure from surfacing as an unhandled rejection. The budget is passed
 * through as a backstop: it is what eventually reaps a monitor that never saw
 * its marker.
 */
function startLaunch(argv: string[], timeoutMs: number): { failure: () => unknown } {
  let failure: unknown = null;
  void runComfy(argv, { timeoutMs }).catch((cause: unknown) => {
    failure = cause;
  });
  return { failure: () => failure };
}

function describeFailure(failure: unknown): string | null {
  if (failure === null) return null;
  return failure instanceof Error ? failure.message : String(failure);
}

/**
 * Start ComfyUI, but only if nothing is already there.
 *
 * 1. **Detect first, and refuse if anything answers.** Both the address this
 *    server talks to and the address the startup arguments name are checked,
 *    because a second instance on another port still competes for the same
 *    unified memory and the same shared model directory — the port collision is
 *    only the most visible of the three.
 * 2. Otherwise invoke `comfy --json launch --background -- <ComfyUI args>`.
 * 3. **Poll `/system_stats` until it answers**, rather than trusting the CLI's
 *    log scrape or its exit. The probe is the only evidence that survives an
 *    upstream change to either.
 *
 * @throws {LaunchArgumentError} an argument this server will not send. Thrown
 * before anything is probed or spawned.
 * @throws {ComfyCliError} the CLI diagnosed a failure — `not_in_workspace` when
 * there is no comfy-cli workspace to launch from, `port_in_use`,
 * `server_already_running`.
 * @throws {ComfyUnavailableError} the `comfy` binary could not be started.
 * @throws {LaunchTimeoutError} nothing answered inside the budget.
 */
export async function launchInstance(opts: LaunchOptions = {}): Promise<LaunchResult> {
  // Validated OUTSIDE the shared region below, and first: a caller's own bad
  // argument is theirs alone, and must neither fail a launch somebody else
  // asked for nor be silently discarded by joining one.
  const argv = comfyuiArgs(opts.args ?? {}, opts.extraArgs ?? []);
  validateComfyuiArgs(argv);

  const running = inFlightLaunch;
  if (running !== null) return running;

  const pending = performLaunch(opts, argv);
  inFlightLaunch = pending;
  try {
    return await pending;
  } finally {
    // By identity, so a launch started after this one finished is not cleared
    // out from under its own callers. Runs on failure too, or one bad launch
    // would wedge this process until it restarts.
    if (inFlightLaunch === pending) inFlightLaunch = null;
  }
}

/**
 * The launch this process is currently performing, if any.
 *
 * **One, globally — not one per address.** `comfy/objectInfo.ts` keys its
 * in-flight map by cache path because two different payloads really are two
 * independent pieces of work. Launching is not like that: what a second launch
 * would collide with is not a port, it is the machine's accelerator and its
 * shared model directory (landmine #8), and those are singular however many
 * addresses are involved. A map keyed by target address would happily start a
 * second ComfyUI on 8189 alongside the first on 8188 — which is exactly the
 * thing the guard exists to prevent.
 *
 * This became reachable when auto-launch started firing from tool handlers:
 * before, a launch took a deliberate call, and two of them at once took two.
 *
 * A joiner gets the leader's result, which is the truth about what is now
 * running. Its own startup arguments are **not** applied — the leader's ComfyUI
 * is the one that exists — and that is the right trade against starting a second
 * server to honour them.
 */
let inFlightLaunch: Promise<LaunchResult> | null = null;

/** The launch itself, once it has been established that this caller leads it. */
async function performLaunch(opts: LaunchOptions, argv: string[]): Promise<LaunchResult> {
  const target = launchTarget(opts, argv);

  const probeTimeoutMs = opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

  const probe = { host: opts.host, port: opts.port, timeoutMs: probeTimeoutMs };
  const here = await detectInstance(probe);
  if (here.running) return { outcome: "already_running", instance: here };

  const targetUrl = statsUrl(target.host, target.port);
  if (targetUrl !== here.url) {
    const there = await detectInstance({ ...target, timeoutMs: probeTimeoutMs });
    if (there.running) return { outcome: "already_running", instance: there };
  }

  const cli = startLaunch(launchArgv(argv, opts.workspace), timeoutMs);

  const deadline = Date.now() + timeoutMs;
  let lastReason = "no probe completed";
  for (;;) {
    const detection = await detectInstance({ ...target, timeoutMs: probeTimeoutMs });
    if (detection.running) return { outcome: "launched", instance: detection };
    lastReason = detection.reason;

    // Checked after the probe, not before it: if a ComfyUI is answering, it is
    // running whatever the CLI thinks, and reality outranks the CLI's opinion.
    const failure = cli.failure();
    if (isVerdict(failure)) throw explainVerdict(failure, opts.workspace);

    if (Date.now() >= deadline) break;
    await Bun.sleep(opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  }

  throw new LaunchTimeoutError(targetUrl, timeoutMs, lastReason, describeFailure(cli.failure()));
}

/** What {@link ensureInstance} had to do to produce an instance. */
export interface EnsureResult {
  /** `launched` means this call started the ComfyUI it is handing back. */
  outcome: "already_running" | "launched";
  instance: RunningInstance;
}

export interface EnsureOptions extends LaunchOptions {
  /**
   * Whether a launch is permitted when nothing answers. Defaults to `true`,
   * matching the function's name: `ensureInstance` that could only ever report
   * an absence would not be ensuring anything.
   */
  autoLaunch?: boolean;
}

/**
 * A running ComfyUI, starting one if that is permitted and necessary.
 *
 * The order is the whole point, and it is the same order {@link launchInstance}
 * already enforces rather than a second copy of it: **detect, and only launch
 * when nothing answered**. The probe here is not redundant with the one inside
 * `launchInstance` — it is what keeps the overwhelmingly common case (ComfyUI is
 * already up) off the launch path entirely, and what makes a refusal possible
 * without going near the CLI when auto-launch is off.
 *
 * @throws {InstanceUnavailableError} nothing answered and launching is not
 * permitted. Actionable on purpose: it is the operator, not the model, who
 * decides which of the two fixes applies.
 * @throws {ComfyCliError} the CLI diagnosed a failure. `not_in_workspace`
 * carries added guidance; every other code passes through as the CLI wrote it.
 * @throws {LaunchTimeoutError} a launch was started but nothing answered.
 * @throws {ComfyUnavailableError} the `comfy` binary could not be started.
 */
export async function ensureInstance(opts: EnsureOptions = {}): Promise<EnsureResult> {
  const detection = await detectInstance({
    host: opts.host,
    port: opts.port,
    timeoutMs: opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
  });
  if (detection.running) return { outcome: "already_running", instance: detection };

  if (opts.autoLaunch === false) throw new InstanceUnavailableError(detection);

  return launchInstance(opts);
}
