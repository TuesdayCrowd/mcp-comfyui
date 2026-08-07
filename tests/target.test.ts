import { expect, test } from "./support/testing.ts";
import { DEFAULT_PORT, authority, isLocalAddress, resolveHost } from "../src/comfy/target.ts";

/**
 * `target.ts` is shared by every module that addresses an instance, so its two
 * pure functions are pinned directly rather than incidentally through consumers.
 * The bracket cases are the reason it exists: two consumers had already
 * disagreed about them.
 *
 * `test.each` has no equivalent under `@std/testing/bdd` (see
 * `tests/support/testing.ts`), so each case below is its own `test()`.
 */

test("resolveHost(undefined) === 127.0.0.1 — no host given falls back to the default", () => {
  expect(resolveHost(undefined)).toBe("127.0.0.1");
});

test("resolveHost(127.0.0.1) === 127.0.0.1 — a loopback address is left alone", () => {
  expect(resolveHost("127.0.0.1")).toBe("127.0.0.1");
});

test("resolveHost(192.168.1.50) === 192.168.1.50 — a LAN address is left alone", () => {
  expect(resolveHost("192.168.1.50")).toBe("192.168.1.50");
});

test("resolveHost(0.0.0.0) === 127.0.0.1 — the IPv4 wildcard is not a connect address", () => {
  expect(resolveHost("0.0.0.0")).toBe("127.0.0.1");
});

test("resolveHost(::) === 127.0.0.1 — the IPv6 wildcard is not a connect address", () => {
  expect(resolveHost("::")).toBe("127.0.0.1");
});

test("resolveHost([::]) === 127.0.0.1 — the bracketed IPv6 wildcard is still a wildcard", () => {
  expect(resolveHost("[::]")).toBe("127.0.0.1");
});

test("resolveHost(::1) === ::1 — an IPv6 loopback is kept, unbracketed", () => {
  expect(resolveHost("::1")).toBe("::1");
});

test("resolveHost([::1]) === ::1 — a bracketed IPv6 host is unbracketed", () => {
  expect(resolveHost("[::1]")).toBe("::1");
});

test("an empty host is a misconfiguration, not a default", () => {
  // Returning "" would build `http://:8188/`, which fetch rejects — surfacing
  // as "is the server reachable?" and sending the operator to check a server
  // that is running perfectly well.
  expect(() => resolveHost("")).toThrow(TypeError);
  expect(() => resolveHost("   ")).toThrow(TypeError);
});

test("authority(127.0.0.1) === 127.0.0.1:8188 — an IPv4 host needs no brackets", () => {
  expect(authority("127.0.0.1", 8188)).toBe("127.0.0.1:8188");
});

test("authority(::1) === [::1]:8188 — an IPv6 host must be bracketed or fetch rejects the URL", () => {
  expect(authority("::1", 8188)).toBe("[::1]:8188");
});

test("authority([::1]) === [::1]:8188 — an already-bracketed host is not double-bracketed", () => {
  expect(authority("[::1]", 8188)).toBe("[::1]:8188");
});

test("a resolved IPv6 host produces a URL the platform will accept", () => {
  // The end-to-end property the bracketing exists for: `[[::1]]` parses as
  // nothing at all, and the failure arrives before any packet moves.
  const url = `http://${authority(resolveHost("[::1]"), DEFAULT_PORT)}/object_info`;
  expect(url).toBe("http://[::1]:8188/object_info");
  expect(() => new URL(url)).not.toThrow();
});

/**
 * `isLocalAddress` answers the question nothing owned before: may this machine
 * start a ComfyUI for this address? Getting it wrong in one direction refuses a
 * legitimate launch; in the other it spawns a server that can never answer the
 * poll, which is the defect it exists to close.
 *
 * The interface table is injected so these cases pin behaviour rather than
 * whatever NICs the machine running the suite happens to have.
 */
const INTERFACES = {
  lo0: [{ address: "127.0.0.1" }, { address: "::1" }],
  en0: [{ address: "192.168.1.50" }, { address: "fe80::1c3f:5aff:fe22:1" }],
  utun4: [{ address: "100.86.199.77" }],
  awdl0: undefined,
};

test("isLocalAddress(127.0.0.1) — loopback is this machine without consulting an interface", () => {
  expect(isLocalAddress("127.0.0.1", {})).toBe(true);
});

test("isLocalAddress(127.0.0.53) — the whole 127/8 range is loopback, not just .1", () => {
  expect(isLocalAddress("127.0.0.53", {})).toBe(true);
});

test("isLocalAddress(localhost) — the name every operator writes must stay launchable", () => {
  expect(isLocalAddress("localhost", {})).toBe(true);
});

test("isLocalAddress(::1) — the IPv6 loopback is the same machine as 127.0.0.1", () => {
  expect(isLocalAddress("::1", {})).toBe(true);
});

test("isLocalAddress([::1]) — a bracketed host is unwrapped first, as everywhere else here", () => {
  expect(isLocalAddress("[::1]", {})).toBe(true);
});

test("isLocalAddress(192.168.1.50) — an address bound on one of this machine's NICs", () => {
  expect(isLocalAddress("192.168.1.50", INTERFACES)).toBe(true);
});

test("isLocalAddress(100.86.199.77) — this machine's own Tailscale address is still this machine", () => {
  expect(isLocalAddress("100.86.199.77", INTERFACES)).toBe(true);
});

test("isLocalAddress(100.86.199.90) — another box on the same tailnet is NOT this machine", () => {
  // The measured RTX host. Launching for this address is the defect being closed.
  expect(isLocalAddress("100.86.199.90", INTERFACES)).toBe(false);
});

test("isLocalAddress(fe80::1c3f:5aff:fe22:1%en0) — a zone suffix names an interface, not a host", () => {
  expect(isLocalAddress("fe80::1c3f:5aff:fe22:1%en0", INTERFACES)).toBe(true);
});

test("isLocalAddress(comfy.local) — an unresolvable name fails closed rather than guessing", () => {
  expect(isLocalAddress("comfy.local", INTERFACES)).toBe(false);
});

test("isLocalAddress is case-insensitive about LOCALHOST", () => {
  expect(isLocalAddress("LOCALHOST", {})).toBe(true);
});
