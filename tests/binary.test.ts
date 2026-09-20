import { expect, test } from "./support/testing.ts";
import { delimiter, join } from "node:path";
import {
  COMFY_BINARY_NAME,
  resolveComfyBinary,
  type BinaryDeps,
} from "../src/comfy/binary.ts";

const HOME = "/home/someone";

/** A deps bag where only the listed paths are executable files. */
function deps(
  env: NodeJS.ProcessEnv,
  executables: string[] = [],
  home = HOME,
): BinaryDeps {
  const set = new Set(executables);
  return { env, home, isExecutable: (p) => set.has(p) };
}

test("COMFY_BIN wins outright, and is not checked for existence", () => {
  const r = resolveComfyBinary(deps({ COMFY_BIN: "/opt/custom/comfy", PATH: "/usr/bin" }));
  expect(r.path).toBe("/opt/custom/comfy");
  expect(r.source).toBe("COMFY_BIN");
});

test("COMFY_BIN never falls back to discovery, even pointing at nothing", () => {
  // An operator who named a binary has expressed an intent. Substituting a
  // different one silently would override it -- and eleven test files depend
  // on COMFY_BIN meaning exactly what it says.
  const r = resolveComfyBinary(
    deps({ COMFY_BIN: "/nope/comfy" }, [join(HOME, ".local/bin", COMFY_BINARY_NAME)]),
  );
  expect(r.path).toBe("/nope/comfy");
  expect(r.source).toBe("COMFY_BIN");
  expect(r.searched).toBeUndefined();
});

test("COMFY_BIN still gets its directory prepended to the child PATH", () => {
  // The measured failure: a correct COMFY_BIN and a PATH that could not
  // satisfy comfy-cli's own re-exec of itself.
  const r = resolveComfyBinary(deps({ COMFY_BIN: "/opt/custom/comfy", PATH: "/usr/bin" }));
  expect(r.childPath).toBe(`/opt/custom${delimiter}/usr/bin`);
});

test("a comfy already on PATH is used bare, and nothing is repaired", () => {
  const r = resolveComfyBinary(
    deps({ PATH: `/usr/bin${delimiter}/opt/tools` }, [join("/opt/tools", COMFY_BINARY_NAME)]),
  );
  expect(r.path).toBe(COMFY_BINARY_NAME);
  expect(r.source).toBe("PATH");
  expect(r.childPath).toBeUndefined();
});

test("a later PATH entry still counts, so the scan does not stop at the first miss", () => {
  // Deliberately NOT "first hit wins": rule 2 discards the winning directory
  // (it returns the bare name), so which entry matched is unobservable in
  // ResolvedBinary and a test asserting order could not fail. What IS
  // observable, and worth pinning, is that a non-matching earlier entry does
  // not abort the scan and fall through to discovery.
  const r = resolveComfyBinary(
    deps({ PATH: `/empty${delimiter}/b` }, [join("/b", COMFY_BINARY_NAME)]),
  );
  expect(r.source).toBe("PATH");
  expect(r.childPath).toBeUndefined();
});

test("discovery finds ~/.local/bin when PATH has nothing", () => {
  const found = join(HOME, ".local/bin", COMFY_BINARY_NAME);
  const r = resolveComfyBinary(deps({ PATH: "/usr/bin" }, [found]));
  expect(r.path).toBe(found);
  expect(r.source).toBe("discovered");
  expect(r.childPath).toBe(`${join(HOME, ".local/bin")}${delimiter}/usr/bin`);
});

test("discovery prefers ~/.local/bin over Homebrew", () => {
  const local = join(HOME, ".local/bin", COMFY_BINARY_NAME);
  const brew = join("/opt/homebrew/bin", COMFY_BINARY_NAME);
  const r = resolveComfyBinary(deps({ PATH: "/usr/bin" }, [brew, local]));
  expect(r.path).toBe(local);
});

test("discovery falls through to Homebrew when the home roots are empty", () => {
  const brew = join("/opt/homebrew/bin", COMFY_BINARY_NAME);
  const r = resolveComfyBinary(deps({ PATH: "/usr/bin" }, [brew]));
  expect(r.path).toBe(brew);
  expect(r.source).toBe("discovered");
});

test("nothing anywhere is not_found, and names every candidate tried", () => {
  const r = resolveComfyBinary(deps({ PATH: "/usr/bin" }, []));
  expect(r.source).toBe("not_found");
  expect(r.path).toBe(COMFY_BINARY_NAME); // still what we will attempt
  expect(r.searched).toEqual([
    join(HOME, ".local/bin", COMFY_BINARY_NAME),
    join(HOME, ".local/share/uv/tools/comfy-cli/bin", COMFY_BINARY_NAME),
    join("/opt/homebrew/bin", COMFY_BINARY_NAME),
    join("/usr/local/bin", COMFY_BINARY_NAME),
  ]);
  expect(r.childPath).toBeUndefined();
});

test("an undefined PATH is not a crash, and discovery still runs", () => {
  const found = join(HOME, ".local/bin", COMFY_BINARY_NAME);
  const r = resolveComfyBinary(deps({}, [found]));
  expect(r.source).toBe("discovered");
  expect(r.childPath).toBe(join(HOME, ".local/bin"));
});

test("a directory already on PATH is not prepended again", () => {
  const found = join("/opt/tools", COMFY_BINARY_NAME);
  const r = resolveComfyBinary(
    deps({ COMFY_BIN: found, PATH: `/usr/bin${delimiter}/opt/tools` }),
  );
  expect(r.childPath).toBeUndefined();
});

test("the directory is PREPENDED, never appended", () => {
  // comfy-cli re-execs the bare name `comfy`. Prepending is what guarantees
  // that re-exec finds the binary we just resolved; appending would let a
  // different, earlier comfy win it.
  const r = resolveComfyBinary(deps({ COMFY_BIN: "/opt/custom/comfy", PATH: "/usr/bin" }));
  expect(r.childPath?.startsWith("/opt/custom")).toBe(true);
});

test("a relative COMFY_BIN is left alone rather than guessed at", () => {
  const r = resolveComfyBinary(deps({ COMFY_BIN: "comfy", PATH: "/usr/bin" }));
  expect(r.path).toBe("comfy");
  expect(r.childPath).toBeUndefined();
});
