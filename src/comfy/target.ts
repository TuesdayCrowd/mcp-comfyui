/**
 * Where a ComfyUI instance lives, and how to say so consistently.
 *
 * Every module that talks to an instance needs the same defaults and the same
 * wildcard handling. Two copies of that had already diverged before this module
 * existed — `comfy/objectInfo.ts` stripped IPv6 brackets before the wildcard
 * check and `workflows/slots.ts` did not, so `[::]` resolved to loopback in one
 * and leaked through as a literal host in the other. This is the one place that
 * logic lives now.
 */

import { networkInterfaces } from "node:os";

const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8188;

/** The TCP port range, inclusive. */
export const MIN_PORT = 1;
export const MAX_PORT = 65535;

/**
 * A wildcard bind address is not a connect address (landmine #10). An operator
 * who launched ComfyUI with `--listen 0.0.0.0` will hand us back that same
 * string, and `--listen ::` is the IPv6 spelling of the same mistake.
 */
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::"]);

function unbracket(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/**
 * The address to connect to, always unbracketed: `[::1]` and `::1` are one
 * host, and the brackets must come off before the wildcard check or `[::]`
 * slips through.
 *
 * @throws {TypeError} the host is present but empty — a misconfiguration that
 * would otherwise build `http://:8188/` and be reported as an unreachable
 * server, sending the operator to check a server that is running fine.
 */
export function resolveHost(host: string | undefined): string {
  if (host === undefined) return DEFAULT_HOST;
  if (host.trim() === "") {
    throw new TypeError("host is empty; omit it to use the default, or give an address");
  }
  const bare = unbracket(host);
  return WILDCARD_HOSTS.has(bare) ? DEFAULT_HOST : bare;
}

/**
 * The `host:port` authority for a URL. An IPv6 literal has to be bracketed or
 * `fetch` rejects the whole string before a single packet moves — and bracketed
 * exactly once, so this tolerates a host that arrives already bracketed rather
 * than producing `[[::1]]`.
 */
export function authority(host: string, port: number): string {
  const bare = unbracket(host);
  return `${bare.includes(":") ? `[${bare}]` : bare}:${port}`;
}

/** Whether a number is usable as a TCP port. */
export function isPort(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT;
}

/** A dotted quad. Not a validity check on each octet — `resolveHost` does not claim one either. */
const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** One address a caller typed, split into the two parts everything here takes. */
export interface Address {
  host: string;
  port: number;
}

/**
 * An address a caller wrote by hand — `198.51.100.10:8189`, `[::1]:8189`,
 * `localhost` — or `null` when the text is not one.
 *
 * ## Why a bare hostname is *not* an address
 *
 * Anything is a syntactically valid hostname, including `rtx-vidoe`. If this
 * accepted one, a mistyped registry name would stop being a mistyped name and
 * become a DNS lookup, and the caller would be told the host was unreachable
 * rather than that they had misspelled `rtx-video` — with the correct spelling
 * sitting right there in the registry, unmentioned. So an address must prove
 * itself: an IP literal, or `localhost`, or anything at all that carries an
 * explicit `:port`. Every raw address a person actually types to reach another
 * machine satisfies one of those, and a name that satisfies none of them is
 * reported as an unknown name, with the names that would have worked.
 *
 * The bracket rule follows RFC 3986 and `fetch`: a bare IPv6 literal is
 * recognised (`::1`), but pairing one with a port requires brackets
 * (`[::1]:8189`), because `::1:8189` is itself a valid IPv6 address and nothing
 * can tell the two readings apart.
 *
 * A missing port means {@link DEFAULT_PORT}, so `198.51.100.10` reaches 8188 —
 * the same default every other entry point here applies.
 */
export function parseAddress(text: string): Address | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;

  if (trimmed.startsWith("[")) {
    const close = trimmed.indexOf("]");
    if (close === -1) return null;
    const host = trimmed.slice(1, close);
    const rest = trimmed.slice(close + 1);
    if (host === "") return null;
    if (rest === "") return { host, port: DEFAULT_PORT };
    if (!rest.startsWith(":")) return null;
    return withPort(host, rest.slice(1));
  }

  const colons = trimmed.split(":").length - 1;
  // More than one colon and no brackets: an IPv6 literal, which cannot also be
  // carrying a port — see the doc comment.
  if (colons > 1) return { host: trimmed, port: DEFAULT_PORT };
  if (colons === 1) {
    const separator = trimmed.indexOf(":");
    const host = trimmed.slice(0, separator);
    if (host === "") return null;
    return withPort(host, trimmed.slice(separator + 1));
  }

  // No port, so the host has to be self-evidently an address.
  const bare = trimmed.toLowerCase();
  if (bare === "localhost" || IPV4.test(trimmed)) return { host: trimmed, port: DEFAULT_PORT };
  return null;
}

/** The `host:port` arm, refusing anything that is not a port rather than defaulting it. */
function withPort(host: string, portText: string): Address | null {
  // `Number("")` is 0 and `Number(" 8 ")` is 8; neither is a port anyone typed,
  // so the digits are checked as text before they are read as a number.
  if (!/^\d+$/.test(portText)) return null;
  const port = Number(portText);
  return isPort(port) ? { host, port } : null;
}

/** Only what this module needs of `os.networkInterfaces()`, so tests can fake it. */
export type InterfaceAddresses = Record<string, readonly { address: string }[] | undefined>;

/** `fe80::1%en0` names an interface, not a different host. */
function unzone(host: string): string {
  const zone = host.indexOf("%");
  return zone === -1 ? host : host.slice(0, zone);
}

/** The whole 127.0.0.0/8 range is loopback, not only `127.0.0.1`. */
const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * Whether this address is one of **this machine's** — the question that decides
 * if a launch is ours to perform.
 *
 * `comfy launch` takes no `--host` and no `--port`: it starts a process on the
 * machine running `comfy`, full stop. So an address belonging to some other box
 * can never be satisfied by launching here, and attempting it is worse than
 * refusing — measured, the attempt starts a ComfyUI on *this* machine's default
 * port, polls the remote address until the readiness budget expires, reports a
 * timeout, and leaves the process running, because `--background` detached it
 * long before anyone noticed.
 *
 * **Fails closed.** A name this cannot verify — anything but `localhost` — is
 * reported non-local rather than resolved through DNS. The asymmetry is
 * deliberate: a wrong `false` refuses a launch and says exactly why, while a
 * wrong `true` recreates the orphan above. An operator naming their own machine
 * should use an IP address or `localhost`.
 *
 * Interfaces are injected for the same reason `config.ts` takes an environment
 * rather than reading `process.env`: the alternative is a test that passes or
 * fails on which NICs the machine running it happens to have.
 */
export function isLocalAddress(
  host: string,
  interfaces: InterfaceAddresses = networkInterfaces(),
): boolean {
  const bare = unzone(unbracket(host.trim())).toLowerCase();
  if (bare === "localhost") return true;
  if (bare === "::1") return true;
  if (LOOPBACK_V4.test(bare)) return true;

  for (const addresses of Object.values(interfaces)) {
    for (const { address } of addresses ?? []) {
      if (unzone(address).toLowerCase() === bare) return true;
    }
  }
  return false;
}
