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
