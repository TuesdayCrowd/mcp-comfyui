import { afterEach, beforeEach, expect, test } from "./support/testing.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import {
  classifyOutputs,
  resolveArtifactPath,
  resolveArtifactPaths,
  type ArtifactLocation,
} from "../src/comfy/outputs.ts";

/**
 * Turning a `/view` URL back into a file on this machine.
 *
 * Nothing here contacts a ComfyUI or invokes `comfy`: the resolver is pure
 * arithmetic over a URL, two directory names and the filesystem, and the
 * directories are real temp ones this file creates. The instance is a plain
 * object because that is all the resolver is ever given — `RunningInstance`
 * satisfies {@link ArtifactLocation} structurally.
 */

let workdir: string;
let outputDir: string;
let inputDir: string;
let instance: ArtifactLocation;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "mcp-comfyui-outputs-"));
  outputDir = join(workdir, "output");
  inputDir = join(workdir, "input");
  mkdirSync(outputDir);
  mkdirSync(inputDir);
  instance = {
    host: "127.0.0.1",
    port: 8188,
    outputDirectory: outputDir,
    inputDirectory: inputDir,
  };
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

/** A `/view` URL exactly as ComfyUI builds them, on the instance's own address. */
function viewUrl(
  query: Record<string, string>,
  at: { host?: string; port?: number; path?: string } = {},
): string {
  const authority = `${at.host ?? "127.0.0.1"}:${at.port ?? 8188}`;
  return `http://${authority}${at.path ?? "/view"}?${new URLSearchParams(query).toString()}`;
}

/** Create a file, and hand back the absolute path it landed at. */
function makeFile(...parts: string[]): string {
  const path = join(...parts);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "not really a png");
  return path;
}

// --- the resolution that works -------------------------------------------

test("a /view URL naming a file in the instance's output directory resolves to it", async () => {
  const path = makeFile(outputDir, "mcp-e2e_00001_.png");

  expect(
    resolveArtifactPath(
      viewUrl({ filename: "mcp-e2e_00001_.png", subfolder: "", type: "output" }),
      instance,
    ),
  ).toBe(path);
});

test("a subfolder is part of the path, not decoration", async () => {
  const path = makeFile(outputDir, "batch-7", "grid_00002_.png");

  expect(
    resolveArtifactPath(
      viewUrl({ filename: "grid_00002_.png", subfolder: "batch-7", type: "output" }),
      instance,
    ),
  ).toBe(path);
});

test("type=input resolves against the input directory, not the output one", async () => {
  // Both directories hold a file of this name, so a resolver that reached for
  // the wrong root would still return something that exists — and would return
  // the wrong image.
  makeFile(outputDir, "same.png");
  const uploaded = makeFile(inputDir, "same.png");

  expect(
    resolveArtifactPath(viewUrl({ filename: "same.png", subfolder: "", type: "input" }), instance),
  ).toBe(uploaded);
});

// --- the refusals --------------------------------------------------------

test("a URL whose file is not on disk resolves to nothing", async () => {
  // The whole point of the existence check: a path a caller would open and
  // fail on is worse than no path at all.
  expect(
    resolveArtifactPath(
      viewUrl({ filename: "never_rendered.png", subfolder: "", type: "output" }),
      instance,
    ),
  ).toBeNull();
});

test("a subfolder that climbs out of the root is refused even though the file exists", async () => {
  // `subfolder` comes from the server's response, so it is not this server's to
  // trust. The file below is real, and containment is the only thing between a
  // caller and it.
  makeFile(workdir, "secret.png");

  expect(
    resolveArtifactPath(
      viewUrl({ filename: "secret.png", subfolder: "..", type: "output" }),
      instance,
    ),
  ).toBeNull();
  expect(
    resolveArtifactPath(
      viewUrl({ filename: "../secret.png", subfolder: "", type: "output" }),
      instance,
    ),
  ).toBeNull();
});

test("a subfolder resolving into a sibling directory that shares the root's name as a prefix is refused", async () => {
  // Pins the `+ sep` half of `candidate.startsWith(base + sep)`. A root of
  // `.../output` and a real sibling `.../output-secret` are a prefix match
  // without it: `"output-secret".startsWith("output")` is true even though the
  // directory is not inside `output` at all. Both `root` and the sibling are
  // real, existing directories (the auditor's own trap: a relative or
  // nonexistent root would fail on the existence check and never reach the
  // containment check this test exists to pin).
  const sibling = `${outputDir}-secret`;
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(sibling, "leak.png"), "not really a png");

  expect(
    resolveArtifactPath(
      viewUrl({ filename: "leak.png", subfolder: "../output-secret", type: "output" }),
      instance,
    ),
  ).toBeNull();
});

test("a type the instance has no root for resolves to nothing", async () => {
  // `temp` is a real ComfyUI directory that `/system_stats` never names, and an
  // unknown type is whatever a later ComfyUI adds. Both must decline rather
  // than fall back to the output directory, which holds this exact filename.
  makeFile(outputDir, "scratch.png");

  for (const type of ["temp", "wobble", ""]) {
    expect(
      resolveArtifactPath(viewUrl({ filename: "scratch.png", subfolder: "", type }), instance),
    ).toBeNull();
  }
});

test("a URL with no type at all resolves to nothing", async () => {
  // ComfyUI's own /view defaults the parameter, but this server does not: the
  // cost of guessing wrong is a path to a real file that is not the artifact.
  makeFile(outputDir, "untyped.png");

  expect(resolveArtifactPath(viewUrl({ filename: "untyped.png" }), instance)).toBeNull();
});

test("an instance that reported no output directory resolves nothing", async () => {
  // `/system_stats` only names the directory when ComfyUI was started with the
  // flag; every other instance leaves it null and gets its URLs back unchanged.
  makeFile(outputDir, "orphan.png");
  const unreported = { ...instance, outputDirectory: null };

  expect(
    resolveArtifactPath(
      viewUrl({ filename: "orphan.png", subfolder: "", type: "output" }),
      unreported,
    ),
  ).toBeNull();
});

test("a URL pointing at another host or port is left alone", async () => {
  // Only the instance that ran the job knows where it writes. A /view URL on
  // any other address names a file in a directory this server has never seen.
  makeFile(outputDir, "elsewhere.png");
  const query = { filename: "elsewhere.png", subfolder: "", type: "output" };

  expect(resolveArtifactPath(viewUrl(query, { host: "127.0.0.2" }), instance)).toBeNull();
  expect(resolveArtifactPath(viewUrl(query, { port: 8189 }), instance)).toBeNull();
  expect(resolveArtifactPath(viewUrl(query, { host: "cloud.comfy.org" }), instance)).toBeNull();
});

test("a URL that is not a /view URL is left alone", async () => {
  makeFile(outputDir, "history.png");

  expect(
    resolveArtifactPath(
      viewUrl({ filename: "history.png", type: "output" }, { path: "/api/view" }),
      instance,
    ),
  ).toBeNull();
});

test("a malformed URL resolves to nothing rather than throwing", async () => {
  for (const malformed of ["http://[oops/view?filename=x.png&type=output", "https://", "http://"]) {
    expect(resolveArtifactPath(malformed, instance)).toBeNull();
  }
});

test("an entry that is already a filesystem path is not touched", async () => {
  // `classifyOutputs` has already filed these under `files`; they need no
  // resolution, and `new URL` reads a Windows path as a URL with protocol `c:`.
  const path = makeFile(outputDir, "already.png");

  expect(resolveArtifactPath(path, instance)).toBeNull();
  expect(resolveArtifactPath("C:\\out\\already.png", instance)).toBeNull();
  expect(resolveArtifactPath("output/already.png", instance)).toBeNull();
});

test("a root that is not absolute resolves nothing, even when it would have worked", async () => {
  // A relative --output-directory is relative to ComfyUI's working directory,
  // which this server does not know. Its own is whatever the MCP client
  // happened to spawn it in — nothing the caller chose and nothing they can see
  // — so a path that comes out right when resolved against it comes out right
  // by accident. The root below names this test's real output directory
  // relative to *here*, so resolving it would succeed; refusing it is the point.
  makeFile(outputDir, "relative.png");
  const fromHere = relative(process.cwd(), outputDir);
  expect(isAbsolute(fromHere)).toBe(false);

  expect(
    resolveArtifactPath(viewUrl({ filename: "relative.png", subfolder: "", type: "output" }), {
      ...instance,
      outputDirectory: fromHere,
    }),
  ).toBeNull();
});

test("a root directory that does not exist resolves nothing rather than throwing", async () => {
  const gone = { ...instance, outputDirectory: join(workdir, "no-such-directory") };

  expect(
    resolveArtifactPath(viewUrl({ filename: "x.png", subfolder: "", type: "output" }), gone),
  ).toBeNull();
});

test("a directory is not an artifact", async () => {
  mkdirSync(join(outputDir, "batch-7"), { recursive: true });

  expect(
    resolveArtifactPath(viewUrl({ filename: "batch-7", subfolder: "", type: "output" }), instance),
  ).toBeNull();
  expect(
    resolveArtifactPath(viewUrl({ filename: "", subfolder: "", type: "output" }), instance),
  ).toBeNull();
});

// --- the batch form ------------------------------------------------------

test("resolveArtifactPaths keys the paths it found by the URL it found them from", async () => {
  const path = makeFile(outputDir, "found.png");
  const found = viewUrl({ filename: "found.png", subfolder: "", type: "output" });
  const missing = viewUrl({ filename: "missing.png", subfolder: "", type: "output" });

  const resolved = resolveArtifactPaths([found, missing], instance);

  // An absent key is how "there is no local path for this URL" is said. The
  // alternative — a null value, or a parallel array — makes a caller count.
  expect(resolved).toEqual({ [found]: path });
  expect(Object.hasOwn(resolved, missing)).toBe(false);
});

test("nothing to resolve is an empty map, not a missing one", async () => {
  expect(resolveArtifactPaths([], instance)).toEqual({});
  expect(resolveArtifactPaths(classifyOutputs(["/out/a.png"]).urls, instance)).toEqual({});
});
