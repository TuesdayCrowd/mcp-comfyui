import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_PORT,
  MAX_PORT,
  MIN_PORT,
  authority,
  isLocalAddress,
  isPort,
  parseAddress,
  resolveHost,
  type InterfaceAddresses,
} from "./comfy/target.ts";
import { AUTO_LAUNCH_ENV, HOST_ENV, PORT_ENV, flag, setting, type Environment } from "./config.ts";

/**
 * Which ComfyUI, chosen per call.
 *
 * This server used to talk to one instance, fixed when the process started.
 * This module is what replaced that: a small registry of named hosts, read from
 * a JSON file, plus the one function that turns whatever a caller wrote — a
 * name, a raw address, or nothing at all — into an address to connect to.
 *
 * ## Why the format lives here and not in `config.ts`
 *
 * `config.ts` says of itself that nothing there should grow a file format, a
 * schema or a merge order "until something actually needs one". Eight hosts
 * carrying per-host policy is that moment. Keeping the format in its own module
 * leaves `config.ts` exactly what it advertises — pure functions over an
 * environment record — and gives the one file this server *writes* a single
 * owner, which matters because `manage_hosts` has to repair a file it could not
 * read.
 *
 * ## Three properties this module is built around
 *
 * **A broken file must not reroute a job.** A missing comma is a plausible
 * accident. Answering it by quietly sending every call to `127.0.0.1` would run
 * a video workflow on the laptop because of a typo, and the operator would have
 * no way to tell. So a file that cannot be read leaves the *default* host
 * working — that address comes from the environment, not from the file — and
 * fails every **named** resolution loudly, naming the parse error and the path.
 *
 * **Malformed and invalid are different, and only one is repairable.** A
 * trailing comma is malformed: the intent is unambiguous and a machine can fix
 * it, so the file is read tolerantly and the repair is offered. `auto_launch:
 * true` on an address belonging to another machine is well-formed JSON that
 * this server cannot honour — `comfy launch` has no `--host` — and "fixing" it
 * means deciding what the operator meant. That one is reported and neutralised,
 * never silently rewritten.
 *
 * **Unknown keys survive every rewrite.** The same reasoning that keeps the
 * CLI's registries open (non-negotiable #2), turned on our own file: closing the
 * shape would silently delete whatever an operator, or a later version of this
 * server, had added to it.
 */

/** Where the registry lives, when the default is not wanted. */
export const HOSTS_FILE_ENV = "MCP_COMFYUI_HOSTS_FILE";

/**
 * The name of the host every call uses when it names none.
 *
 * Also the name of the entry this module synthesises when there is no file at
 * all, which is what makes an installation that predates the registry — one
 * that sets only `MCP_COMFYUI_HOST` and `MCP_COMFYUI_PORT`, or nothing — behave
 * exactly as it always did.
 */
export const DEFAULT_HOST_NAME = "default";

/** How a mutation names the copy it took before writing. */
const BACKUP_INFIX = ".bak-";

/**
 * One host the registry knows about.
 *
 * `local` is resolved at load rather than at use, so that every consumer sees
 * one answer to "is this address mine to launch?" and `os.networkInterfaces()`
 * is read once per load rather than once per artifact.
 */
export interface HostEntry {
  name: string;
  /** The connect address, already through `resolveHost` — never a wildcard bind address. */
  host: string;
  port: number;
  /**
   * Whether this server may start ComfyUI for this host when nothing answers.
   * **Always false for an address that is not on this machine**, whatever the
   * file said — see {@link RegistryWarning}'s `auto_launch_not_local`.
   */
  autoLaunch: boolean;
  /**
   * What the file said before locality was applied to it, or `null` when it
   * said nothing.
   *
   * Kept apart from {@link autoLaunch} so that a **repair** — which re-writes
   * the whole document — cannot quietly turn a neutralised `auto_launch: true`
   * into a recorded `false`. A repair fixes syntax; erasing what the operator
   * asked for, even something this server refuses to honour, is not syntax.
   */
  autoLaunchDeclared: boolean | null;
  /** The operator's own label for the box. */
  note: string | null;
  /** Whether this address is one of this machine's. */
  local: boolean;
  /** Every key of this entry the server does not know, kept so a rewrite cannot delete it. */
  extra: Record<string, unknown>;
}

/**
 * Something wrong with the file that did not stop it being read.
 *
 * `code` is an open string on the same reasoning as every registry the CLI
 * publishes: a caller branches on the ones it knows and shows the rest.
 */
export interface RegistryWarning {
  code: string;
  message: string;
  /** The entry it concerns, where it concerns one. */
  host?: string;
}

/** Where a parse gave up, when the runtime said. */
export interface RegistryProblem {
  message: string;
  /** 1-based, or `null` when the parser did not report a position. */
  line: number | null;
  column: number | null;
  /** The offending line, so the fix does not need the file reopened. */
  text: string | null;
}

/** The registry as one load produced it. */
export interface HostRegistry {
  /** The file this was read from — reported whether or not it exists. */
  path: string;
  /** Whether a file was actually found. */
  present: boolean;
  /** Whether the file needed the tolerant parse, so a repair is worth offering. */
  repairable: boolean;
  /** The name a call with no `host` resolves to. Always names an entry in {@link hosts}. */
  defaultName: string;
  hosts: HostEntry[];
  warnings: RegistryWarning[];
  /**
   * Non-null when the file could not be read as a registry at all. The default
   * host still works — it comes from the environment — and every *named*
   * resolution fails with {@link RegistryInvalidError}.
   */
  problem: RegistryProblem | null;
}

/** One host a call resolved to. */
export interface ResolvedHost {
  /** The registry name, or `null` when the caller wrote a raw address. */
  name: string | null;
  host: string;
  port: number;
  autoLaunch: boolean;
  local: boolean;
  /** How to refer to this host in a message: its name, or its address. */
  label: string;
}

/** A caller named a host the registry does not have. */
export class UnknownHostError extends Error {
  override readonly name = "UnknownHostError";
  readonly requested: string;
  /** Every name that would have worked. */
  readonly known: string[];
  readonly registryPath: string;

  constructor(requested: string, registry: HostRegistry) {
    super(
      `no host named ${JSON.stringify(requested)}\n` +
        (registry.hosts.length === 0
          ? `The registry at ${registry.path} has no entries.`
          : `Known hosts: ${registry.hosts.map((entry) => entry.name).join(", ")}.`) +
        `\nCall list_hosts for the registry, or give an address directly — an address needs an ` +
        `explicit port unless it is an IP literal or localhost, e.g. "100.86.199.90:8189".`,
    );
    this.requested = requested;
    this.known = registry.hosts.map((entry) => entry.name);
    this.registryPath = registry.path;
  }
}

/**
 * A host was named, and the file that would have said where it is could not be
 * read.
 *
 * Thrown rather than absorbed because the alternative is routing the call to
 * the default host — which is to say, running the job on whichever machine
 * happens to be the fallback because a comma was missing.
 */
export class RegistryInvalidError extends Error {
  override readonly name = "RegistryInvalidError";
  readonly registryPath: string;
  readonly problem: RegistryProblem;

  /**
   * @param attempt what could not be done, as a clause — "cannot resolve the
   * host \"rtx-video\"".
   * @param guidance what to do about it. Given by the caller rather than fixed
   * here because the answer genuinely differs: a failed *resolution* can be
   * repaired, and a failed *repair* cannot be repaired again.
   */
  constructor(attempt: string, registry: HostRegistry, problem: RegistryProblem, guidance: string) {
    super(
      `${attempt}: the host registry at ${registry.path} could not be read\n` +
        `  ${problem.message}` +
        (problem.line === null ? "" : `\n  line ${problem.line}, column ${problem.column ?? 1}`) +
        (problem.text === null ? "" : `\n  ${problem.text}`) +
        `\n${guidance}`,
    );
    this.registryPath = registry.path;
    this.problem = problem;
  }
}

/** The guidance a failed *resolution* carries: the default still works, and a repair may fix it. */
function resolutionGuidance(): string {
  return (
    `The default host still works, because its address comes from ${HOST_ENV}/${PORT_ENV} rather ` +
    `than from this file. Fix the file, or — if the only problem is a comment or a trailing ` +
    `comma — call manage_hosts with action "repair".`
  );
}

/**
 * An address that is not on this machine was asked to do something only a local
 * address can do — be launched, or be recorded with `auto_launch: true`.
 *
 * The same fact `comfy/instance.ts`'s `refuseRemoteTarget` enforces at launch
 * time, enforced here at *write* time as well, so an operator finds out while
 * they are editing the registry rather than at 3am when a box is asleep.
 */
export class HostNotLocalError extends Error {
  override readonly name = "HostNotLocalError";
  readonly address: string;

  constructor(address: string, what: string) {
    super(
      `${address} is not an address on this machine, so ${what}. \`comfy launch\` has no --host: ` +
        `it starts ComfyUI on whichever machine runs \`comfy\`, so a remote instance can only be ` +
        `started on that machine.\n` +
        `Any name but localhost that is not literally an address on a local interface is treated ` +
        `as remote rather than resolved through DNS — a wrong refusal explains itself, where a ` +
        `wrong acceptance starts a ComfyUI here and polls a machine that will never answer.`,
    );
    this.address = address;
  }
}

/**
 * Nothing answered at a host on another machine, and nothing could be done
 * about it from here.
 *
 * Its own type rather than `InstanceUnavailableError`, whose message offers the
 * two fixes an operator of a *local* instance has: start ComfyUI yourself, or
 * let this server start one. Neither applies to a box that is asleep on the
 * other side of the network, and telling somebody to set
 * `MCP_COMFYUI_AUTO_LAUNCH=1` for a host this server can never launch would
 * send them to change a setting that cannot help.
 */
export class RemoteHostUnavailableError extends Error {
  override readonly name = "RemoteHostUnavailableError";
  readonly url: string;
  readonly host: string;

  constructor(target: ResolvedHost, url: string, reason: string) {
    super(
      `no ComfyUI is answering at ${url}${target.name === null ? "" : ` (${target.name})`}: ${reason}\n` +
        `${authority(target.host, target.port)} is not an address on this machine, so this server ` +
        `cannot start ComfyUI there — \`comfy launch\` has no --host. Start ComfyUI on that ` +
        `machine, or name a different host.`,
    );
    this.url = url;
    this.host = target.label;
  }
}

// --- where the file is ---------------------------------------------------

/**
 * The registry file's path, whether or not anything is there.
 *
 * `~/.config/mcp-comfyui/hosts.json`, and {@link HOSTS_FILE_ENV} overrides it
 * outright. `XDG_CONFIG_HOME` is deliberately not consulted: the override
 * already covers anyone who has moved their config, and honouring one XDG
 * variable here while `comfy/objectInfo.ts` ignores `XDG_CACHE_HOME` would be
 * a difference nobody could predict from the outside.
 */
export function hostsFilePath(env: Environment = process.env): string {
  return setting(env, HOSTS_FILE_ENV) ?? join(homedir(), ".config", "mcp-comfyui", "hosts.json");
}

// --- the tolerant parse --------------------------------------------------

/**
 * The same text with comments and trailing commas replaced by spaces.
 *
 * Spaces rather than deletions, so every byte keeps its offset and a position
 * reported against the relaxed text points at the same character of the file
 * the operator will open.
 *
 * String-aware, which is the whole difficulty: `"note": "http://box:8189"`
 * holds a `//` that is not a comment, and `"a\\"` ends where it looks like it
 * does not. This tracks quoting and escaping rather than pattern-matching, so
 * neither case is misread.
 */
function relaxJson(text: string): { relaxed: string; changed: boolean } {
  const out = [...text];
  let changed = false;
  let index = 0;
  let inString = false;
  /** Offsets of commas that may yet turn out to be trailing. */
  const pendingCommas: number[] = [];

  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i += 1) if (out[i] !== "\n") out[i] = " ";
    changed = true;
  };

  while (index < text.length) {
    const char = text[index] as string;

    if (inString) {
      if (char === "\\") index += 2;
      else {
        if (char === '"') inString = false;
        index += 1;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      pendingCommas.length = 0;
      index += 1;
      continue;
    }

    if (char === "/" && text[index + 1] === "/") {
      const end = text.indexOf("\n", index);
      blank(index, end === -1 ? text.length : end);
      index = end === -1 ? text.length : end;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(index, stop);
      index = stop;
      continue;
    }

    if (char === ",") {
      pendingCommas.push(index);
    } else if (char === "}" || char === "]") {
      // Everything still pending is a comma with nothing but whitespace and
      // comments between it and this closing bracket — which is what a trailing
      // comma is. More than one can be pending for `[1,,]`, and both go.
      for (const comma of pendingCommas) blank(comma, comma + 1);
      pendingCommas.length = 0;
    } else if (!/\s/.test(char)) {
      pendingCommas.length = 0;
    }
    index += 1;
  }

  return { relaxed: out.join(""), changed };
}

/**
 * Where a `JSON.parse` failure happened, as a line and column of the original
 * text.
 *
 * The offset is taken from the runtime's own message rather than computed,
 * because only the runtime knows it — and it is *optional*, because the wording
 * of that message is not a contract. V8 has changed it more than once. A
 * position that cannot be recovered degrades to `null`, which costs the
 * operator a line number and nothing else.
 */
function locate(text: string, cause: unknown): RegistryProblem {
  const message = cause instanceof Error ? cause.message : String(cause);
  const at = /position (\d+)/.exec(message);
  if (at === null) return { message, line: null, column: null, text: null };

  const offset = Math.min(Number(at[1]), text.length);
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  const column = offset - (before.lastIndexOf("\n") + 1) + 1;
  return { message, line, column, text: text.split("\n")[line - 1]?.trim() ?? null };
}

// --- loading -------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** The keys this server understands on one entry; everything else is `extra`. */
const KNOWN_ENTRY_KEYS = new Set(["host", "port", "auto_launch", "note"]);
/** The keys this server understands at the top level. */
const KNOWN_TOP_KEYS = new Set(["default", "hosts"]);

function extrasOf(record: Record<string, unknown>, known: Set<string>): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!known.has(key)) extra[key] = value;
  }
  return extra;
}

/**
 * The entry the environment describes — the whole registry on an installation
 * that has no file, and the surviving default on one whose file will not parse.
 */
function environmentEntry(
  env: Environment,
  interfaces: InterfaceAddresses | undefined,
  autoLaunchDefault: boolean,
  override: { host?: string; port?: number } | undefined,
): HostEntry {
  const host = resolveHost(override?.host ?? setting(env, HOST_ENV));
  const rawPort = setting(env, PORT_ENV);
  const port = override?.port ?? (rawPort === undefined ? DEFAULT_PORT : Number(rawPort));
  const local = isLocal(host, interfaces);
  return {
    name: DEFAULT_HOST_NAME,
    host,
    // A bad port is `toolConfig`'s to refuse, at construction, with a message
    // naming the variable. Falling back here keeps a load from throwing a
    // second, worse-worded version of the same complaint.
    port: isPort(port) ? port : DEFAULT_PORT,
    autoLaunch: autoLaunchDefault && local,
    autoLaunchDeclared: null,
    note: null,
    local,
    extra: {},
  };
}

function isLocal(host: string, interfaces: InterfaceAddresses | undefined): boolean {
  return interfaces === undefined ? isLocalAddress(host) : isLocalAddress(host, interfaces);
}

export interface LoadRegistryOptions {
  /** Defaults to `process.env`, as everything configuration-shaped here does. */
  env?: Environment;
  /** Injected so a test does not pass or fail on which NICs the machine has. */
  interfaces?: InterfaceAddresses;
  /** Overrides {@link hostsFilePath}, for tests and for `manage_hosts`. */
  path?: string;
  /**
   * The default host's address, when the caller has already read it.
   *
   * `tools.ts` validates `MCP_COMFYUI_PORT` at construction and refuses a bad
   * one there, with a message naming the variable; passing the result back in
   * is what keeps this module from doing that reading — and that complaining —
   * a second time, in different words.
   */
  defaultAddress?: { host?: string; port?: number };
}

/**
 * Read the registry.
 *
 * **Never throws for anything about the file.** A missing file, an unreadable
 * one, a corrupt one and one holding nonsense all produce a registry — the
 * first two silently, because a machine with no registry is the ordinary case
 * and is exactly what every installation predating this module looks like.
 *
 * Read per call rather than once at startup. The file is a few hundred bytes
 * and every tool call already reads more than that; in exchange an operator who
 * edits it, or a `manage_hosts` call that rewrites it, takes effect on the next
 * call instead of on the next restart of their MCP client.
 *
 * @throws {Error} only from {@link flag}, when `MCP_COMFYUI_AUTO_LAUNCH` is
 * neither a yes nor a no — a configuration fault that must be loud wherever it
 * is noticed.
 */
export async function loadHostRegistry(opts: LoadRegistryOptions = {}): Promise<HostRegistry> {
  const env = opts.env ?? process.env;
  const path = opts.path ?? hostsFilePath(env);
  const autoLaunchDefault = flag(env, AUTO_LAUNCH_ENV, true);
  const fallback = environmentEntry(env, opts.interfaces, autoLaunchDefault, opts.defaultAddress);

  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    const missing = (cause as NodeJS.ErrnoException | null)?.code === "ENOENT";
    return {
      path,
      present: false,
      repairable: false,
      defaultName: fallback.name,
      hosts: [fallback],
      // A file that exists and will not open is the operator's to fix and must
      // be said out loud; a file that was never there is the normal state of a
      // machine and says nothing.
      warnings: missing
        ? []
        : [{ code: "registry_unreadable", message: `${path} could not be read: ${reasonOf(cause)}` }],
      problem: null,
    };
  }

  return interpret(text, path, env, opts.interfaces, autoLaunchDefault, fallback);
}

function reasonOf(cause: unknown): string {
  const code = cause instanceof Error ? (cause as NodeJS.ErrnoException).code : undefined;
  if (typeof code === "string") return code;
  return cause instanceof Error ? cause.message : String(cause);
}

function interpret(
  text: string,
  path: string,
  env: Environment,
  interfaces: InterfaceAddresses | undefined,
  autoLaunchDefault: boolean,
  fallback: HostEntry,
): HostRegistry {
  const warnings: RegistryWarning[] = [];

  let document: unknown;
  let repairable = false;
  try {
    document = JSON.parse(text);
  } catch (strict) {
    const { relaxed, changed } = relaxJson(text);
    let recovered = false;
    if (changed) {
      try {
        document = JSON.parse(relaxed);
        recovered = true;
      } catch {
        // Both parses failed; the strict error is the one worth reporting,
        // because it is the one describing the file as written.
      }
    }
    if (!recovered) {
      return {
        path,
        present: true,
        repairable: false,
        defaultName: fallback.name,
        hosts: [fallback],
        warnings,
        problem: locate(text, strict),
      };
    }
    repairable = true;
    const where = locate(text, strict);
    warnings.push({
      code: "registry_malformed",
      message:
        `${path} is not strict JSON and was read tolerantly — comments and trailing commas were ` +
        `ignored` +
        (where.line === null ? "" : `, first at line ${where.line}`) +
        `. Call manage_hosts with action "repair" to rewrite it as strict JSON; nothing about ` +
        `which host is which will change.`,
    });
  }

  const top = asRecord(document);
  if (top === undefined) {
    return {
      path,
      present: true,
      repairable,
      defaultName: fallback.name,
      hosts: [fallback],
      warnings,
      problem: {
        message: "the registry is not a JSON object holding `default` and `hosts`",
        line: null,
        column: null,
        text: null,
      },
    };
  }

  const hosts = readEntries(top, interfaces, autoLaunchDefault, warnings);

  if (hosts.length === 0) {
    warnings.push({
      code: "registry_empty",
      message:
        `${path} names no usable hosts, so the default host is the only one available. Its ` +
        `address comes from ${HOST_ENV}/${PORT_ENV}.`,
    });
    hosts.push(fallback);
  } else if (setting(env, HOST_ENV) !== undefined || setting(env, PORT_ENV) !== undefined) {
    // Not an override, in either direction: the file is authoritative for the
    // hosts it lists, and saying so is better than silently preferring one of
    // two configurations the operator wrote.
    warnings.push({
      code: "environment_ignored",
      message:
        `${HOST_ENV}/${PORT_ENV} are set but ${path} lists hosts, so the file decides every ` +
        `address. Those variables only describe the default host when there is no registry file.`,
    });
  }

  return {
    path,
    present: true,
    repairable,
    defaultName: readDefaultName(top, hosts, path, warnings),
    hosts,
    warnings,
    problem: null,
  };
}

/** The entries, in file order, dropping — loudly — every one that cannot be used. */
function readEntries(
  top: Record<string, unknown>,
  interfaces: InterfaceAddresses | undefined,
  autoLaunchDefault: boolean,
  warnings: RegistryWarning[],
): HostEntry[] {
  const raw = top["hosts"];
  if (raw === undefined) return [];
  const table = asRecord(raw);
  if (table === undefined) {
    warnings.push({
      code: "hosts_not_an_object",
      message: "`hosts` is not an object mapping a name to `{host, port}`; no hosts were read.",
    });
    return [];
  }

  const entries: HostEntry[] = [];
  const addresses = new Map<string, string>();

  for (const [name, value] of Object.entries(table)) {
    const entry = readEntry(name, value, interfaces, autoLaunchDefault, warnings);
    if (entry === null) continue;

    const key = authority(entry.host, entry.port).toLowerCase();
    const first = addresses.get(key);
    if (first === undefined) addresses.set(key, entry.name);
    else {
      // Legal, and occasionally deliberate — two names for one box — but it is
      // also what a copy-pasted entry looks like, and a job sent to the wrong
      // one of two identical addresses is indistinguishable from a job sent to
      // the right one.
      warnings.push({
        code: "duplicate_address",
        host: entry.name,
        message: `${entry.name} and ${first} are both ${key}; they name the same instance.`,
      });
    }
    entries.push(entry);
  }
  return entries;
}

function readEntry(
  name: string,
  value: unknown,
  interfaces: InterfaceAddresses | undefined,
  autoLaunchDefault: boolean,
  warnings: RegistryWarning[],
): HostEntry | null {
  const drop = (message: string): null => {
    warnings.push({ code: "host_dropped", host: name, message: `${name}: ${message}` });
    return null;
  };

  if (name.trim() === "" || name.trim() !== name) {
    return drop("a host name cannot be empty or carry surrounding whitespace.");
  }
  const record = asRecord(value);
  if (record === undefined) return drop("is not an object holding `host` and `port`.");

  const host = record["host"];
  if (typeof host !== "string" || host.trim() === "") {
    return drop("has no `host` string, so there is no address to connect to.");
  }

  const rawPort = record["port"];
  let port = DEFAULT_PORT;
  if (rawPort !== undefined) {
    if (typeof rawPort !== "number" || !isPort(rawPort)) {
      return drop(
        `\`port\` is ${JSON.stringify(rawPort)}, which is not a TCP port ` +
          `(expected ${MIN_PORT}-${MAX_PORT}).`,
      );
    }
    port = rawPort;
  }

  // The same rewrite as everywhere else: a wildcard is a bind address, and
  // nothing can connect to it (landmine #10).
  const connect = resolveHost(host);
  const local = isLocal(connect, interfaces);

  const rawAutoLaunch = record["auto_launch"];
  if (rawAutoLaunch !== undefined && typeof rawAutoLaunch !== "boolean") {
    return drop(`\`auto_launch\` is ${JSON.stringify(rawAutoLaunch)}, which is not true or false.`);
  }
  let autoLaunch = rawAutoLaunch ?? (autoLaunchDefault && local);
  if (autoLaunch && !local) {
    // Neutralised rather than dropped, and never rewritten: the entry's address
    // is still perfectly usable, and what the operator *meant* by asking for a
    // launch there is not something this server can guess.
    autoLaunch = false;
    warnings.push({
      code: "auto_launch_not_local",
      host: name,
      message:
        `${name} has \`auto_launch: true\` but ${authority(connect, port)} is not an address on ` +
        `this machine, so it was ignored. \`comfy launch\` has no --host; start ComfyUI on that ` +
        `machine instead.`,
    });
  }

  const note = record["note"];
  if (note !== undefined && note !== null && typeof note !== "string") {
    return drop(`\`note\` is ${JSON.stringify(note)}, which is not a string.`);
  }

  if (parseAddress(name) !== null) {
    // Names win over addresses in `resolveHostRef`, so this one shadows the
    // address it is spelled like, and nobody would guess that from the file.
    warnings.push({
      code: "name_looks_like_address",
      host: name,
      message:
        `${name} is spelled like a raw address, and a name wins over one, so a call naming ` +
        `${JSON.stringify(name)} reaches ${authority(connect, port)} rather than that address.`,
    });
  }
  if (name.includes("/")) {
    warnings.push({
      code: "name_holds_slash",
      host: name,
      message:
        `${name} contains "/", which is also the separator in a remote workflow handle ` +
        `(\`<host>/<workflow>\`); a handle naming this host is ambiguous.`,
    });
  }

  return {
    name,
    host: connect,
    port,
    autoLaunch,
    autoLaunchDeclared: rawAutoLaunch ?? null,
    note: note ?? null,
    local,
    extra: extrasOf(record, KNOWN_ENTRY_KEYS),
  };
}

function readDefaultName(
  top: Record<string, unknown>,
  hosts: HostEntry[],
  path: string,
  warnings: RegistryWarning[],
): string {
  const first = hosts[0] as HostEntry; // readEntries never returns an empty list to here
  const declared = top["default"];
  if (declared === undefined) {
    if (hosts.length > 1) {
      warnings.push({
        code: "default_unset",
        message:
          `${path} names no \`default\`, so calls that do not name a host use ${first.name}, the ` +
          `first entry. Set \`default\` to say which one you meant.`,
      });
    }
    return first.name;
  }
  if (typeof declared !== "string" || !hosts.some((entry) => entry.name === declared)) {
    warnings.push({
      code: "default_unknown",
      message:
        `\`default\` is ${JSON.stringify(declared)}, which is not a host in this registry; calls ` +
        `that do not name a host use ${first.name} instead.`,
    });
    return first.name;
  }
  return declared;
}

// --- resolution ----------------------------------------------------------

/**
 * The host a call meant.
 *
 * The order is load-bearing and is the same one `tools.ts`'s `resolveWorkflow`
 * already uses for workflow handles: **the name this server published wins**.
 * A registry name that happens to be spelled like an address must reach the
 * host the operator registered under it, or the registry would be a set of
 * suggestions rather than a mapping. `readEntry` warns when a name is spelled
 * that way, so the shadowing is visible rather than surprising.
 *
 * @throws {UnknownHostError} the text is neither a registered name nor an
 * address — including a bare hostname with no port, which is refused precisely
 * so a mistyped name is reported as one. See `comfy/target.ts`'s
 * `parseAddress`.
 * @throws {RegistryInvalidError} a name was given and the file could not be
 * read. Never for a call that named no host, and never for a raw address: both
 * of those are answerable without the file.
 */
export function resolveHostRef(
  registry: HostRegistry,
  requested?: string,
  // Injected for the same reason `isLocalAddress` allows it: the alternative is
  // a test that passes or fails on which NICs the machine running it has.
  interfaces?: InterfaceAddresses,
): ResolvedHost {
  if (requested === undefined || requested.trim() === "") {
    const entry =
      registry.hosts.find((candidate) => candidate.name === registry.defaultName) ??
      (registry.hosts[0] as HostEntry);
    return fromEntry(entry);
  }

  const named = registry.hosts.find((entry) => entry.name === requested);
  if (named !== undefined) return fromEntry(named);

  const address = parseAddress(requested);
  if (address !== null) {
    const host = resolveHost(address.host);
    const local = isLocal(host, interfaces);
    return {
      name: null,
      host,
      port: address.port,
      // An ad-hoc address carries no per-host policy, so it inherits the one
      // rule that is not a preference: only a local address is ours to launch.
      autoLaunch: local,
      local,
      label: authority(host, address.port),
    };
  }

  if (registry.problem !== null) {
    throw new RegistryInvalidError(
      `cannot resolve the host ${JSON.stringify(requested)}`,
      registry,
      registry.problem,
      resolutionGuidance(),
    );
  }
  throw new UnknownHostError(requested, registry);
}

function fromEntry(entry: HostEntry): ResolvedHost {
  return {
    name: entry.name,
    host: entry.host,
    port: entry.port,
    autoLaunch: entry.autoLaunch,
    local: entry.local,
    label: entry.name,
  };
}

// --- writing -------------------------------------------------------------

/** One field a mutation changed, as data rather than as diff text. */
export interface HostChange {
  /** The entry, or `"default"` for the top-level pointer. */
  host: string;
  field: string;
  from: unknown;
  to: unknown;
}

export type HostMutation =
  | { action: "add"; name: string; host: string; port?: number; autoLaunch?: boolean; note?: string | null }
  | { action: "update"; name: string; host?: string; port?: number; autoLaunch?: boolean; note?: string | null }
  | { action: "remove"; name: string }
  | { action: "set_default"; name: string }
  | { action: "repair" };

export interface HostMutationResult {
  path: string;
  /** Where the previous bytes were copied, or `null` when there was no file to copy. */
  backupPath: string | null;
  /** What changed about the registry's meaning. Empty for a pure reformat. */
  changes: HostChange[];
  /** Whether the file's *text* changed beyond those fields — a repair, or a first write. */
  rewritten: boolean;
  /** Re-read from disk, so what is reported is what actually landed. */
  registry: HostRegistry;
}

/** The document as it will be written: known keys in a fixed order, then whatever else was there. */
function serialise(registry: HostRegistry, top: Record<string, unknown>): string {
  const hosts: Record<string, unknown> = {};
  for (const entry of registry.hosts) {
    hosts[entry.name] = {
      host: entry.host,
      port: entry.port,
      // What the operator wrote, not what locality left of it — see
      // `HostEntry.autoLaunchDeclared`.
      auto_launch: entry.autoLaunchDeclared ?? entry.autoLaunch,
      ...(entry.note === null ? {} : { note: entry.note }),
      ...entry.extra,
    };
  }
  return `${JSON.stringify({ default: registry.defaultName, hosts, ...top }, null, 2)}\n`;
}

/**
 * Apply one change to the registry file.
 *
 * Every mutation follows the same four steps, and each one exists because the
 * alternative is unrecoverable:
 *
 * 1. **Copy the current bytes aside** as `hosts.json.bak-<timestamp>`. A repair
 *    that guesses wrong is then undone with `mv`.
 * 2. **Write through a temp file and `rename`**, so an interrupted write cannot
 *    leave half a registry where the next call will read it — the same
 *    reasoning, and the same shape, as `comfy/objectInfo.ts`'s cache write.
 * 3. **Refuse what cannot be honoured**, before writing: `auto_launch: true` on
 *    an address that is not this machine's is rejected here rather than
 *    accepted and neutralised at load, because at write time there is somebody
 *    watching who can fix it.
 * 4. **Re-read from disk** and report that. What is returned is then what the
 *    next call will see, not what this call believed it wrote.
 *
 * @throws {HostNotLocalError} `autoLaunch` was asked for on a remote address.
 * @throws {UnknownHostError} `update`, `remove` or `set_default` named a host
 * that is not in the registry.
 * @throws {Error} `add` named one that already is, or the file could not be
 * written.
 */
export async function mutateHostRegistry(
  mutation: HostMutation,
  opts: LoadRegistryOptions = {},
): Promise<HostMutationResult> {
  const env = opts.env ?? process.env;
  const path = opts.path ?? hostsFilePath(env);
  const before = await loadHostRegistry({ ...opts, env, path });

  // **Including `repair`.** A file neither parse could read yielded no entries
  // at all — `loadHostRegistry` fell back to the single environment host — so
  // rewriting it here would not repair the registry, it would replace it with
  // one entry and back the operator's real hosts into a `.bak-` file they have
  // not been told to look for. `repair` exists for the file the *tolerant*
  // parse rescued, which is the one whose entries are all still here.
  if (before.problem !== null) {
    throw new RegistryInvalidError(
      mutation.action === "repair"
        ? `cannot repair ${path}`
        : `cannot ${mutation.action.replace("_", " ")} ${JSON.stringify(describeMutation(mutation))}`,
      before,
      before.problem,
      mutation.action === "repair"
        ? `Repair rewrites a registry this server could read; it cannot reconstruct one it could ` +
            `not. Nothing was written. Fix the syntax above by hand — the entries are all still ` +
            `in the file — and the next call will pick them up.`
        : resolutionGuidance(),
    );
  }

  const hosts = before.hosts.map((entry) => ({ ...entry, extra: { ...entry.extra } }));
  const changes: HostChange[] = [];
  let defaultName = before.defaultName;

  switch (mutation.action) {
    case "add": {
      if (hosts.some((entry) => entry.name === mutation.name)) {
        throw new Error(
          `a host named ${JSON.stringify(mutation.name)} is already in ${path}; use action ` +
            `"update" to change it, or "remove" first.`,
        );
      }
      const entry = buildEntry(mutation.name, mutation, opts.interfaces);
      hosts.push(entry);
      changes.push({ host: entry.name, field: "host", from: null, to: entry.host });
      changes.push({ host: entry.name, field: "port", from: null, to: entry.port });
      // The default is deliberately NOT re-pointed at the new host, even when
      // this is the first `add` on a machine with no registry file. Registering
      // a remote box must not silently start sending every unqualified call to
      // it; what was reaching the local Desktop a moment ago must keep reaching
      // it. Writing the file materialises the previously-implicit `default`
      // entry alongside the new one, which is what preserves that — and
      // `set_default` is one call away when re-pointing really is the intent.
      if (hosts.length === 1) {
        changes.push({ host: "default", field: "default", from: defaultName, to: entry.name });
        defaultName = entry.name;
      }
      break;
    }
    case "update": {
      const entry = hosts.find((candidate) => candidate.name === mutation.name);
      if (entry === undefined) throw new UnknownHostError(mutation.name, before);
      applyUpdate(entry, mutation, opts.interfaces, changes);
      break;
    }
    case "remove": {
      const index = hosts.findIndex((candidate) => candidate.name === mutation.name);
      if (index === -1) throw new UnknownHostError(mutation.name, before);
      const [removed] = hosts.splice(index, 1) as [HostEntry];
      changes.push({ host: removed.name, field: "entry", from: authority(removed.host, removed.port), to: null });
      if (defaultName === removed.name && hosts.length > 0) {
        const next = (hosts[0] as HostEntry).name;
        changes.push({ host: "default", field: "default", from: removed.name, to: next });
        defaultName = next;
      }
      break;
    }
    case "set_default": {
      if (!hosts.some((entry) => entry.name === mutation.name)) {
        throw new UnknownHostError(mutation.name, before);
      }
      if (defaultName !== mutation.name) {
        changes.push({ host: "default", field: "default", from: defaultName, to: mutation.name });
        defaultName = mutation.name;
      }
      break;
    }
    case "repair":
      // Nothing to change. The write itself is the repair: the document is
      // re-serialised from what was read, which is what drops the comments and
      // trailing commas that made it unreadable — and, deliberately, changes no
      // address, no port and no default along the way.
      break;
  }

  const top = await topLevelExtras(path, before);
  const document = serialise({ ...before, hosts, defaultName }, top);
  const previous = await readOrNull(path);
  const backupPath = previous === null ? null : await backup(path, previous);
  await writeAtomically(path, document);

  return {
    path,
    backupPath,
    changes,
    rewritten: previous !== document,
    registry: await loadHostRegistry({ ...opts, env, path }),
  };
}

function describeMutation(mutation: HostMutation): string {
  return "name" in mutation ? mutation.name : mutation.action;
}

function buildEntry(
  name: string,
  fields: { host: string; port?: number; autoLaunch?: boolean; note?: string | null },
  interfaces: InterfaceAddresses | undefined,
): HostEntry {
  if (name.trim() === "" || name.trim() !== name) {
    throw new Error("a host name cannot be empty or carry surrounding whitespace.");
  }
  const host = resolveHost(fields.host);
  const port = fields.port ?? DEFAULT_PORT;
  if (!isPort(port)) {
    throw new Error(`port ${port} is not a TCP port (expected ${MIN_PORT}-${MAX_PORT}).`);
  }
  const local = isLocal(host, interfaces);
  if (fields.autoLaunch === true && !local) {
    throw new HostNotLocalError(authority(host, port), "auto_launch cannot be set for it");
  }
  const autoLaunch = fields.autoLaunch ?? local;
  return {
    name,
    host,
    port,
    autoLaunch,
    // Equal by construction on a write: the one combination where they could
    // differ — `true` on a remote address — was refused two lines above.
    autoLaunchDeclared: autoLaunch,
    note: fields.note ?? null,
    local,
    extra: {},
  };
}

function applyUpdate(
  entry: HostEntry,
  fields: { host?: string; port?: number; autoLaunch?: boolean; note?: string | null },
  interfaces: InterfaceAddresses | undefined,
  changes: HostChange[],
): void {
  const host = fields.host === undefined ? entry.host : resolveHost(fields.host);
  const port = fields.port ?? entry.port;
  if (!isPort(port)) {
    throw new Error(`port ${port} is not a TCP port (expected ${MIN_PORT}-${MAX_PORT}).`);
  }
  const local = isLocal(host, interfaces);
  const autoLaunch = fields.autoLaunch ?? (entry.autoLaunch && local);
  if (autoLaunch && !local) {
    throw new HostNotLocalError(authority(host, port), "auto_launch cannot be set for it");
  }

  const record = (field: string, from: unknown, to: unknown) => {
    if (from !== to) changes.push({ host: entry.name, field, from, to });
  };
  record("host", entry.host, host);
  record("port", entry.port, port);
  record("auto_launch", entry.autoLaunch, autoLaunch);
  if (fields.note !== undefined) record("note", entry.note, fields.note);

  entry.host = host;
  entry.port = port;
  entry.autoLaunch = autoLaunch;
  entry.autoLaunchDeclared = autoLaunch;
  entry.local = local;
  if (fields.note !== undefined) entry.note = fields.note;
}

/**
 * The top-level keys this server does not know, read from the file as it stands.
 *
 * Read again rather than carried on {@link HostRegistry}, because they are of no
 * interest to anything but a rewrite — and a registry type that carried them
 * would invite a reader to treat them as configuration this server honours.
 */
async function topLevelExtras(path: string, registry: HostRegistry): Promise<Record<string, unknown>> {
  if (!registry.present || registry.problem !== null) return {};
  const text = await readOrNull(path);
  if (text === null) return {};
  try {
    const top = asRecord(JSON.parse(relaxJson(text).relaxed));
    return top === undefined ? {} : extrasOf(top, KNOWN_TOP_KEYS);
  } catch {
    return {};
  }
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * The previous bytes, kept where `mv` can put them back.
 *
 * Colons are stripped from the timestamp: they are legal in a POSIX filename
 * and are not on Windows, and a backup nobody can copy off the machine is not
 * much of a backup.
 */
async function backup(path: string, previous: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${path}${BACKUP_INFIX}${stamp}`;
  await writeFile(backupPath, previous);
  return backupPath;
}

/** Temp file plus `rename`, so no reader can ever see half a registry. */
async function writeAtomically(path: string, document: string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temp, document);
    await rename(temp, path);
  } catch (cause) {
    await rm(temp, { force: true }).catch(() => {}); // best effort; already failing
    throw new Error(`could not write the host registry at ${path}: ${reasonOf(cause)}`, { cause });
  }
}

/** Exported for `manage_hosts`, which reports where a backup went. */
export function isBackupPath(path: string): boolean {
  return path.includes(BACKUP_INFIX);
}
