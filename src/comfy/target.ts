/**
 * Where a ComfyUI instance lives, and how to say so consistently.
 *
 * Every module that talks to an instance — the object_info cache, the workflow
 * wrappers, instance detection — needs the same defaults and the same wildcard
 * handling. Three copies of that had already started to drift (one stripped
 * IPv6 brackets before the wildcard check and one did not, so `[::]` resolved
 * correctly in one module and leaked through in the other), which is what this
 * module exists to prevent.
 */

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8188;

/**
 * A wildcard bind address is not a connect address (landmine #10). An operator
 * who launched ComfyUI with `--listen 0.0.0.0` will hand us back that same
 * string, and `--listen ::` is the IPv6 spelling of the same mistake.
 */
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::"]);

/**
 * The address to connect to, unbracketed: `[::1]` and `::1` are one host, and
 * the brackets must come off before the wildcard check or `[::]` slips through.
 */
export function resolveHost(host: string | undefined): string {
  if (host === undefined) return DEFAULT_HOST;
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return WILDCARD_HOSTS.has(bare) ? DEFAULT_HOST : bare;
}

/**
 * `host:port` for a URL. An IPv6 literal has to be bracketed, or `fetch`
 * rejects the whole string as invalid before a single packet moves.
 */
export function authority(host: string, port: number): string {
  return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}
