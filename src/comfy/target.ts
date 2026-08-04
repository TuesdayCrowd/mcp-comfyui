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
