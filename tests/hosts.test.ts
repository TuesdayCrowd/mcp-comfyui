import { afterEach, beforeEach, expect, test } from "./support/testing.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_HOST_NAME,
  HOSTS_FILE_ENV,
  HostNotLocalError,
  RegistryInvalidError,
  UnknownHostError,
  hostsFilePath,
  loadHostRegistry,
  mutateHostRegistry,
  resolveHostRef,
  type HostRegistry,
} from "../src/hosts.ts";
import type { InterfaceAddresses } from "../src/comfy/target.ts";

/**
 * The host registry: what it reads, what it refuses, and what it will not
 * destroy.
 *
 * Nothing here touches the network, spawns a process, or reads the real
 * `~/.config/mcp-comfyui/hosts.json` — every test points {@link HOSTS_FILE_ENV}
 * at its own temp directory, and every one passes `interfaces` explicitly so a
 * result never depends on which NICs the machine running the suite has.
 *
 * Real fixtures cannot reach any of this. A registry only ever comes from an
 * operator's own editor, so every degenerate case below — the trailing comma,
 * the port of 70000, the name spelled like an address — is hand-built, exactly
 * as CLAUDE.md says rule-shaped code demands.
 */

let workdir: string;
let hostsPath: string;

/** This machine, as far as every test here is concerned. */
const INTERFACES: InterfaceAddresses = {
  lo0: [{ address: "127.0.0.1" }, { address: "::1" }],
  en0: [{ address: "192.168.1.50" }],
};

/** Documentation-range addresses (RFC 5737), which are on no interface anywhere. */
const REMOTE = "192.0.2.10";

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "mcp-comfyui-hosts-"));
  hostsPath = join(workdir, "hosts.json");
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function write(document: string): void {
  writeFileSync(hostsPath, document);
}

function load(env: Record<string, string | undefined> = {}): Promise<HostRegistry> {
  return loadHostRegistry({ env, path: hostsPath, interfaces: INTERFACES });
}

function codes(registry: HostRegistry): string[] {
  return registry.warnings.map((warning) => warning.code);
}

function named(registry: HostRegistry, name: string) {
  const entry = registry.hosts.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`no host named ${name} in ${codes(registry).join(", ")}`);
  return entry;
}

const TWO_HOSTS = JSON.stringify(
  {
    default: "mac-local",
    hosts: {
      "mac-local": { host: "127.0.0.1", port: 8188, auto_launch: true, note: "Desktop" },
      "rtx-video": { host: REMOTE, port: 8189, auto_launch: false, note: "Windows, RTX 4070" },
    },
  },
  null,
  2,
);

// --- where the file is ---------------------------------------------------

test("the registry path defaults under ~/.config and the env var overrides it", () => {
  expect(hostsFilePath({})).toMatch(/\.config[/\\]mcp-comfyui[/\\]hosts\.json$/);
  expect(hostsFilePath({ [HOSTS_FILE_ENV]: "/somewhere/else.json" })).toBe("/somewhere/else.json");
  // An exported-but-unassigned shell variable is silence, not an instruction —
  // the same rule `config.ts`'s `setting` applies to every other one.
  expect(hostsFilePath({ [HOSTS_FILE_ENV]: "   " })).toMatch(/hosts\.json$/);
});

// --- no file at all ------------------------------------------------------

test("no registry file yields exactly the environment's single host", async () => {
  const registry = await load();

  expect(registry.present).toBe(false);
  expect(registry.problem).toBeNull();
  expect(registry.warnings).toEqual([]);
  expect(registry.defaultName).toBe(DEFAULT_HOST_NAME);
  expect(registry.hosts).toHaveLength(1);
  expect(named(registry, DEFAULT_HOST_NAME)).toMatchObject({ host: "127.0.0.1", port: 8188, local: true });
});

test("MCP_COMFYUI_HOST and MCP_COMFYUI_PORT still describe the default host", async () => {
  const registry = await load({ MCP_COMFYUI_HOST: "::1", MCP_COMFYUI_PORT: "9001" });

  expect(named(registry, DEFAULT_HOST_NAME)).toMatchObject({ host: "::1", port: 9001, local: true });
});

test("a wildcard MCP_COMFYUI_HOST becomes a connect address, not a bind one", async () => {
  // Landmine #10, applied to the registry: `0.0.0.0` is where a server listens,
  // never where a client connects.
  const registry = await load({ MCP_COMFYUI_HOST: "0.0.0.0" });

  expect(named(registry, DEFAULT_HOST_NAME).host).toBe("127.0.0.1");
});

test("auto-launch is off for the default host when the environment says so", async () => {
  const registry = await load({ MCP_COMFYUI_AUTO_LAUNCH: "false" });

  expect(named(registry, DEFAULT_HOST_NAME).autoLaunch).toBe(false);
});

test("auto-launch is off for a default host that is not this machine", async () => {
  // The environment can point this server at a remote box, and did so before
  // the locality gate existed. Auto-launch must be off there whatever the
  // global setting says: `comfy launch` has no --host.
  const registry = await load({ MCP_COMFYUI_HOST: REMOTE, MCP_COMFYUI_AUTO_LAUNCH: "true" });

  expect(named(registry, DEFAULT_HOST_NAME)).toMatchObject({ local: false, autoLaunch: false });
});

// --- an ordinary registry ------------------------------------------------

test("a registry names its hosts and its default", async () => {
  write(TWO_HOSTS);
  const registry = await load();

  expect(registry.present).toBe(true);
  expect(registry.problem).toBeNull();
  expect(registry.warnings).toEqual([]);
  expect(registry.defaultName).toBe("mac-local");
  expect(registry.hosts.map((entry) => entry.name)).toEqual(["mac-local", "rtx-video"]);
  expect(named(registry, "rtx-video")).toMatchObject({
    host: REMOTE,
    port: 8189,
    autoLaunch: false,
    local: false,
    note: "Windows, RTX 4070",
  });
});

test("a port left out of an entry means ComfyUI's own default", async () => {
  write(JSON.stringify({ hosts: { box: { host: "127.0.0.1" } } }));

  expect(named(await load(), "box").port).toBe(8188);
});

test("the file decides every address, and says so when the environment disagrees", async () => {
  write(TWO_HOSTS);
  const registry = await load({ MCP_COMFYUI_HOST: "10.0.0.9" });

  expect(codes(registry)).toContain("environment_ignored");
  expect(registry.hosts.some((entry) => entry.host === "10.0.0.9")).toBe(false);
});

// --- what the file gets wrong -------------------------------------------

test("an entry with an impossible port is dropped and the rest of the registry survives", async () => {
  write(
    JSON.stringify({
      hosts: { good: { host: "127.0.0.1", port: 8188 }, bad: { host: "127.0.0.1", port: 70000 } },
    }),
  );
  const registry = await load();

  expect(registry.hosts.map((entry) => entry.name)).toEqual(["good"]);
  expect(registry.warnings.find((warning) => warning.host === "bad")?.message).toContain("70000");
});

test("an entry with no host string is dropped", async () => {
  write(JSON.stringify({ hosts: { nameless: { port: 8188 } } }));
  const registry = await load();

  expect(codes(registry)).toContain("host_dropped");
  // The registry still works: the environment's host is put back so the server
  // has somewhere to talk to.
  expect(registry.hosts.map((entry) => entry.name)).toEqual([DEFAULT_HOST_NAME]);
  expect(codes(registry)).toContain("registry_empty");
});

test("auto_launch on a remote address is neutralised, loudly, and the host still works", async () => {
  write(JSON.stringify({ hosts: { far: { host: REMOTE, port: 8189, auto_launch: true } } }));
  const registry = await load();

  const entry = named(registry, "far");
  expect(entry.autoLaunch).toBe(false);
  expect(entry.autoLaunchDeclared).toBe(true);
  expect(codes(registry)).toContain("auto_launch_not_local");
  // Neutralised, never dropped: the address is perfectly usable.
  expect(entry.port).toBe(8189);
});

test("two names for one address are reported", async () => {
  write(
    JSON.stringify({
      hosts: { a: { host: "127.0.0.1", port: 8188 }, b: { host: "127.0.0.1", port: 8188 } },
    }),
  );

  expect(codes(await load())).toContain("duplicate_address");
});

test("a name spelled like an address is reported, because the name wins", async () => {
  write(JSON.stringify({ hosts: { "10.0.0.1:8188": { host: "127.0.0.1", port: 9999 } } }));
  const registry = await load();

  expect(codes(registry)).toContain("name_looks_like_address");
  // And it really does win — that is the whole reason the warning exists.
  expect(resolveHostRef(registry, "10.0.0.1:8188", INTERFACES)).toMatchObject({
    host: "127.0.0.1",
    port: 9999,
  });
});

test("a name holding a slash is reported, because a remote workflow handle uses one", async () => {
  write(JSON.stringify({ hosts: { "a/b": { host: "127.0.0.1" } } }));

  expect(codes(await load())).toContain("name_holds_slash");
});

test("a missing default is only worth mentioning when there is a choice to make", async () => {
  write(JSON.stringify({ hosts: { only: { host: "127.0.0.1" } } }));
  const one = await load();
  expect(one.defaultName).toBe("only");
  expect(codes(one)).not.toContain("default_unset");

  write(JSON.stringify({ hosts: { first: { host: "127.0.0.1" }, second: { host: "::1" } } }));
  const two = await load();
  expect(two.defaultName).toBe("first");
  expect(codes(two)).toContain("default_unset");
});

test("a default naming a host that is not there falls back and says so", async () => {
  write(JSON.stringify({ default: "ghost", hosts: { real: { host: "127.0.0.1" } } }));
  const registry = await load();

  expect(registry.defaultName).toBe("real");
  expect(codes(registry)).toContain("default_unknown");
});

test("`hosts` that is not an object leaves the default host working", async () => {
  write(JSON.stringify({ hosts: ["mac-local"] }));
  const registry = await load();

  expect(codes(registry)).toContain("hosts_not_an_object");
  expect(registry.hosts.map((entry) => entry.name)).toEqual([DEFAULT_HOST_NAME]);
});

test("a file that exists and will not open is reported, where a missing one is not", async () => {
  // A directory where the file should be: it exists, it is not readable as a
  // file, and the operator is the only one who can fix that.
  mkdirSync(hostsPath);
  const registry = await load();

  expect(codes(registry)).toContain("registry_unreadable");
  expect(registry.hosts.map((entry) => entry.name)).toEqual([DEFAULT_HOST_NAME]);
});

// --- malformed versus invalid -------------------------------------------

test("comments and a trailing comma are read tolerantly and offered a repair", async () => {
  write(`{
  // the laptop
  "default": "mac-local",
  "hosts": {
    "mac-local": { "host": "127.0.0.1", "port": 8188 }, /* and nothing else */
  },
}
`);
  const registry = await load();

  expect(registry.problem).toBeNull();
  expect(registry.repairable).toBe(true);
  expect(codes(registry)).toContain("registry_malformed");
  expect(named(registry, "mac-local").port).toBe(8188);
});

test("a `//` inside a string is not a comment", async () => {
  write(`{"hosts": {"box": {"host": "127.0.0.1", "note": "see http://wiki/box, // not a comment"}}}`);
  const registry = await load();

  expect(registry.problem).toBeNull();
  expect(named(registry, "box").note).toBe("see http://wiki/box, // not a comment");
});

test("a file neither parse can read fails named resolution and nothing else", async () => {
  write(`{"hosts": {"mac-local": {"host": "127.0.0.1" "port": 8188}}}`);
  const registry = await load();

  expect(registry.problem).not.toBeNull();
  expect(registry.problem?.line).toBe(1);
  expect(registry.hosts.map((entry) => entry.name)).toEqual([DEFAULT_HOST_NAME]);

  // The default still works. Routing every call to 127.0.0.1 *because a comma
  // was missing* is the failure this whole arrangement exists to avoid, so the
  // one address that does not come from the file is the one that survives.
  expect(resolveHostRef(registry, undefined, INTERFACES).host).toBe("127.0.0.1");
  // And so does a raw address, which needs nothing from the file.
  expect(resolveHostRef(registry, "10.0.0.4:8189", INTERFACES)).toMatchObject({ host: "10.0.0.4" });
  // A name does not.
  expect(() => resolveHostRef(registry, "mac-local", INTERFACES)).toThrow(RegistryInvalidError);
});

test("a registry that is not an object at all is a problem, not a crash", async () => {
  write(`["mac-local"]`);
  const registry = await load();

  expect(registry.problem?.message).toContain("not a JSON object");
  expect(registry.hosts.map((entry) => entry.name)).toEqual([DEFAULT_HOST_NAME]);
});

// --- resolution ----------------------------------------------------------

test("an omitted host is the default, and a named one is itself", async () => {
  write(TWO_HOSTS);
  const registry = await load();

  expect(resolveHostRef(registry, undefined, INTERFACES)).toMatchObject({
    name: "mac-local",
    host: "127.0.0.1",
    port: 8188,
    local: true,
    autoLaunch: true,
  });
  expect(resolveHostRef(registry, "rtx-video", INTERFACES)).toMatchObject({
    name: "rtx-video",
    host: REMOTE,
    port: 8189,
    local: false,
    autoLaunch: false,
    label: "rtx-video",
  });
});

test("a raw address resolves without the registry, and carries its own locality", async () => {
  const registry = await load();

  expect(resolveHostRef(registry, "10.0.0.4:8189", INTERFACES)).toMatchObject({
    name: null,
    host: "10.0.0.4",
    port: 8189,
    local: false,
    autoLaunch: false,
    label: "10.0.0.4:8189",
  });
  expect(resolveHostRef(registry, "[::1]:9000", INTERFACES)).toMatchObject({ host: "::1", port: 9000 });
  expect(resolveHostRef(registry, "::1", INTERFACES)).toMatchObject({ host: "::1", port: 8188 });
  expect(resolveHostRef(registry, "localhost", INTERFACES)).toMatchObject({
    host: "localhost",
    port: 8188,
    local: true,
    autoLaunch: true,
  });
  // An address on one of this machine's own interfaces is this machine.
  expect(resolveHostRef(registry, "192.168.1.50:8188", INTERFACES).local).toBe(true);
});

test("a mistyped host name is reported as one, with the names that would have worked", async () => {
  write(TWO_HOSTS);
  const registry = await load();

  // The point of refusing a bare hostname: `rtx-vidoe` is a perfectly legal
  // hostname, and accepting it would turn a typo into a DNS lookup and then
  // into "unreachable", with the correct spelling sitting unmentioned in the
  // registry the caller was already talking to.
  let thrown: unknown;
  try {
    resolveHostRef(registry, "rtx-vidoe", INTERFACES);
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(UnknownHostError);
  expect((thrown as UnknownHostError).known).toEqual(["mac-local", "rtx-video"]);
  expect((thrown as Error).message).toContain("rtx-video");
});

test("a bare hostname carrying an explicit port is an address", async () => {
  const registry = await load();

  expect(resolveHostRef(registry, "workstation.lan:8189", INTERFACES)).toMatchObject({
    host: "workstation.lan",
    port: 8189,
    local: false,
  });
});

// --- writing -------------------------------------------------------------

function backups(): string[] {
  return readdirSync(workdir).filter((name) => name.includes(".bak-"));
}

function temporaries(): string[] {
  return readdirSync(workdir).filter((name) => name.endsWith(".tmp"));
}

function mutate(mutation: Parameters<typeof mutateHostRegistry>[0]) {
  return mutateHostRegistry(mutation, { env: {}, path: hostsPath, interfaces: INTERFACES });
}

test("adding the first host creates the file and makes it the default", async () => {
  const result = await mutate({ action: "add", name: "mac-local", host: "127.0.0.1", port: 8188 });

  expect(result.backupPath).toBeNull(); // nothing existed to back up
  expect(temporaries()).toEqual([]);
  expect(result.registry.defaultName).toBe("mac-local");
  expect(result.changes).toContainEqual({ host: "default", field: "default", from: DEFAULT_HOST_NAME, to: "mac-local" });
  // Re-read from disk, so what is reported is what the next call will see.
  expect(named(await load(), "mac-local")).toMatchObject({ host: "127.0.0.1", port: 8188 });
});

test("adding a second host leaves the default alone and backs the file up", async () => {
  write(TWO_HOSTS);
  const result = await mutate({ action: "add", name: "spare", host: "127.0.0.1", port: 8190 });

  expect(result.backupPath).not.toBeNull();
  expect(readFileSync(result.backupPath as string, "utf8")).toBe(TWO_HOSTS);
  expect(backups()).toHaveLength(1);
  expect(result.registry.defaultName).toBe("mac-local");
  expect(result.registry.hosts.map((entry) => entry.name)).toEqual(["mac-local", "rtx-video", "spare"]);
});

test("adding a name that is already there is refused rather than merged", async () => {
  write(TWO_HOSTS);

  await expect(mutate({ action: "add", name: "rtx-video", host: "127.0.0.1" })).rejects.toThrow(/already/);
  expect(readFileSync(hostsPath, "utf8")).toBe(TWO_HOSTS);
});

test("auto_launch on a remote address is refused at write time, before anything is written", async () => {
  write(TWO_HOSTS);

  await expect(
    mutate({ action: "add", name: "far", host: REMOTE, port: 8189, autoLaunch: true }),
  ).rejects.toThrow(HostNotLocalError);
  expect(readFileSync(hostsPath, "utf8")).toBe(TWO_HOSTS);
  expect(backups()).toEqual([]);
});

test("updating reports every field it changed and nothing it did not", async () => {
  write(TWO_HOSTS);
  const result = await mutate({ action: "update", name: "rtx-video", port: 8200 });

  expect(result.changes).toEqual([{ host: "rtx-video", field: "port", from: 8189, to: 8200 }]);
  expect(named(result.registry, "rtx-video").port).toBe(8200);
  expect(named(result.registry, "rtx-video").note).toBe("Windows, RTX 4070");
});

test("removing the default moves it rather than leaving it dangling", async () => {
  write(TWO_HOSTS);
  const result = await mutate({ action: "remove", name: "mac-local" });

  expect(result.registry.hosts.map((entry) => entry.name)).toEqual(["rtx-video"]);
  expect(result.registry.defaultName).toBe("rtx-video");
  expect(codes(result.registry)).not.toContain("default_unknown");
});

test("set_default and remove refuse a name the registry does not have", async () => {
  write(TWO_HOSTS);

  await expect(mutate({ action: "set_default", name: "ghost" })).rejects.toThrow(UnknownHostError);
  await expect(mutate({ action: "remove", name: "ghost" })).rejects.toThrow(UnknownHostError);
  expect(readFileSync(hostsPath, "utf8")).toBe(TWO_HOSTS);
});

test("a repair rewrites the syntax and changes nothing about the routing", async () => {
  write(`{
  // the laptop
  "default": "mac-local",
  "hosts": {
    "mac-local": { "host": "127.0.0.1", "port": 8188, "auto_launch": true },
    "rtx-video": { "host": "${REMOTE}", "port": 8189, "auto_launch": true, "vram_gb": 12 },
  },
  "schema_note": "kept",
}
`);
  const result = await mutate({ action: "repair" });

  expect(result.changes).toEqual([]);
  expect(result.rewritten).toBe(true);
  expect(result.registry.repairable).toBe(false);
  expect(result.registry.problem).toBeNull();

  const written = JSON.parse(readFileSync(hostsPath, "utf8"));
  expect(written.default).toBe("mac-local");
  expect(written.hosts["mac-local"]).toMatchObject({ host: "127.0.0.1", port: 8188 });
  // Unknown keys survive, at both levels — closing the shape would silently
  // delete whatever an operator or a later version put there.
  expect(written.hosts["rtx-video"].vram_gb).toBe(12);
  expect(written.schema_note).toBe("kept");
  // And the flag this server refuses to honour is still recorded as asked for,
  // rather than quietly rewritten to the value it was neutralised to.
  expect(written.hosts["rtx-video"].auto_launch).toBe(true);
  expect(codes(result.registry)).toContain("auto_launch_not_local");
});

test("a repair of a file no parse could read is refused, and the file is left alone", async () => {
  // The dangerous case. A file neither parse can read produced no entries, so
  // rewriting it would replace the operator's hosts with the environment's one
  // default and leave the real ones only in a `.bak-` file nobody was told
  // about. Repair fixes a file that was *read*; it cannot reconstruct one.
  const broken = `{"hosts": {"mac-local": {"host": "127.0.0.1" "port": 8188}}}`;
  write(broken);

  await expect(mutate({ action: "repair" })).rejects.toThrow(RegistryInvalidError);
  expect(readFileSync(hostsPath, "utf8")).toBe(broken);
  expect(backups()).toEqual([]);
  expect(temporaries()).toEqual([]);
});

test("every other mutation is refused against a registry that would not parse", async () => {
  const broken = `{"hosts": {"mac-local": {"host": "127.0.0.1",,}}}}`;
  write(broken);

  await expect(mutate({ action: "add", name: "spare", host: "127.0.0.1" })).rejects.toThrow(
    RegistryInvalidError,
  );
  expect(readFileSync(hostsPath, "utf8")).toBe(broken);
});

test("a written registry is strict JSON that reloads to the same hosts", async () => {
  write(TWO_HOSTS);
  const result = await mutate({ action: "set_default", name: "rtx-video" });

  const text = readFileSync(hostsPath, "utf8");
  expect(() => JSON.parse(text)).not.toThrow();
  expect(text.endsWith("\n")).toBe(true);
  const reloaded = await load();
  expect(reloaded.defaultName).toBe("rtx-video");
  expect(reloaded.hosts.map((entry) => entry.name)).toEqual(result.registry.hosts.map((entry) => entry.name));
});

test("nothing is left behind in the registry's directory", async () => {
  write(TWO_HOSTS);
  await mutate({ action: "update", name: "mac-local", note: "renamed" });

  expect(temporaries()).toEqual([]);
  expect(existsSync(hostsPath)).toBe(true);
  expect(backups()).toHaveLength(1);
});
