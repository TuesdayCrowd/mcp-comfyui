import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DEFAULT_WORKFLOW_DIR, workflowRoots } from "../src/config";
import {
  type WorkflowFile,
  type WorkflowListing,
  discoverWorkflows,
} from "../src/workflows/discover";

/**
 * No test in this file may read the operator's real workflow directory or
 * contact a server: every root is a fresh temp directory written by the test
 * itself, and every `workflowRoots` call is passed an explicit environment.
 */

let roots: string[] = [];
/** Directories chmod-ed during a test, restored in `afterEach` so cleanup works. */
let locked: string[] = [];

beforeEach(() => {
  roots = [];
  locked = [];
});

afterEach(() => {
  for (const path of locked) chmodSync(path, 0o755);
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mcp-comfyui-discover-"));
  roots.push(root);
  return root;
}

function write(root: string, name: string, body: string): string {
  const path = join(root, name);
  writeFileSync(path, body);
  return path;
}

/** The frontend/UI format the ComfyUI editor saves: `nodes` plus `links`. */
function frontend(nodeCount = 2): string {
  return JSON.stringify({
    id: "abc",
    last_node_id: nodeCount,
    nodes: Array.from({ length: nodeCount }, (_, i) => ({ id: i + 1, type: "KSampler" })),
    links: [[1, 1, 0, 2, 0, "MODEL"]],
    version: 0.4,
  });
}

/** API (prompt) format: node ids mapping to objects that carry `class_type`. */
function api(nodeCount = 3): string {
  const graph: Record<string, unknown> = {};
  for (let i = 1; i <= nodeCount; i++) {
    graph[String(i)] = { class_type: "KSampler", inputs: { steps: 20 } };
  }
  return JSON.stringify(graph);
}

function names(listing: WorkflowListing): string[] {
  return listing.workflows.map((w) => w.name);
}

function byName(listing: WorkflowListing, name: string): WorkflowFile {
  const found = listing.workflows.find((w) => w.name === name);
  if (found === undefined) throw new Error(`no workflow named ${name} in ${names(listing)}`);
  return found;
}

// --- classification ---------------------------------------------------------

test("a frontend/UI workflow is classified frontend", async () => {
  const root = makeRoot();
  write(root, "graph.json", frontend(4));

  const listing = await discoverWorkflows({ roots: [root] });

  expect(byName(listing, "graph").format).toBe("frontend");
  expect(byName(listing, "graph").node_count).toBe(4);
});

test("an API-format workflow is classified api", async () => {
  // `comfy workflow slots` rejects these with `workflow_not_frontend_format`,
  // so the caller has to be able to tell before spending a CLI round trip.
  const root = makeRoot();
  write(root, "prompt.json", api(3));

  const listing = await discoverWorkflows({ roots: [root] });

  expect(byName(listing, "prompt").format).toBe("api");
  expect(byName(listing, "prompt").node_count).toBe(3);
});

test("a .app.json carrying definitions is still frontend", async () => {
  // Measured on the real directory: 8 of 22 files carry a top-level
  // `definitions` with subgraphs, and only one of them is named `.app.json`.
  const root = makeRoot();
  const body = JSON.stringify({
    nodes: [{ id: 1 }, { id: 2 }, { id: 3 }],
    links: [],
    definitions: { subgraphs: [{ id: "s1", nodes: [{ id: 9 }] }] },
  });
  write(root, "template_qwen.app.json", body);

  const listing = await discoverWorkflows({ roots: [root] });

  expect(byName(listing, "template_qwen.app").format).toBe("frontend");
  // The top-level graph only. Subgraph interiors are `comfy`'s to expand.
  expect(byName(listing, "template_qwen.app").node_count).toBe(3);
});

test("a file named _api whose content is frontend is classified frontend", async () => {
  // `image_chroma1_radiance_text_to_image_api.json` is a real file and is
  // frontend format — the `_api` names API *nodes*, not the file format.
  // Classification is by content, never by name.
  const root = makeRoot();
  write(root, "image_chroma1_radiance_text_to_image_api.json", frontend(5));

  const listing = await discoverWorkflows({ roots: [root] });

  expect(byName(listing, "image_chroma1_radiance_text_to_image_api").format).toBe("frontend");
});

test("a file named like a graph whose content is API format is classified api", async () => {
  // The mirror of the case above: the name must not rescue it either.
  const root = makeRoot();
  write(root, "default_image_gen.json", api(2));

  const listing = await discoverWorkflows({ roots: [root] });

  expect(byName(listing, "default_image_gen").format).toBe("api");
});

test("JSON that is neither shape is classified invalid", async () => {
  const root = makeRoot();
  write(root, "settings.json", JSON.stringify({ theme: "dark", zoom: 1.5 }));
  write(root, "list.json", JSON.stringify([1, 2, 3]));
  write(root, "scalar.json", JSON.stringify("hello"));

  const listing = await discoverWorkflows({ roots: [root] });

  expect(byName(listing, "settings").format).toBe("invalid");
  expect(byName(listing, "list").format).toBe("invalid");
  expect(byName(listing, "scalar").format).toBe("invalid");
});

test("a partial frontend graph missing links is not classified frontend", async () => {
  // Both keys are required, and both must be arrays: `comfy workflow slots`
  // reads the pair, and claiming frontend on half of one would send the caller
  // into a CLI failure this listing exists to predict.
  const root = makeRoot();
  write(root, "no-links.json", JSON.stringify({ nodes: [{ id: 1 }] }));
  write(root, "links-not-array.json", JSON.stringify({ nodes: [], links: {} }));

  const listing = await discoverWorkflows({ roots: [root] });

  expect(byName(listing, "no-links").format).toBe("invalid");
  expect(byName(listing, "links-not-array").format).toBe("invalid");
});

// --- the critical resilience case -------------------------------------------

test("a malformed file is reported invalid without denying the caller the rest", async () => {
  // The single most important behaviour in this module. One corrupt file among
  // 22 must cost the caller that one file, never the listing.
  const root = makeRoot();
  write(root, "good-a.json", frontend(2));
  write(root, "broken.json", '{"nodes": [{"id": 1},');
  write(root, "good-b.json", api(1));
  write(root, "empty.json", "");

  const listing = await discoverWorkflows({ roots: [root] });

  expect(names(listing)).toEqual(["broken", "empty", "good-a", "good-b"]);
  expect(byName(listing, "broken").format).toBe("invalid");
  expect(byName(listing, "empty").format).toBe("invalid");
  expect(byName(listing, "good-a").format).toBe("frontend");
  expect(byName(listing, "good-b").format).toBe("api");
});

test("node_count is null for an invalid file", async () => {
  // Not 0: zero nodes is a claim about a graph that was read, and this one
  // was not. A caller sorting by size must not see a corrupt file as empty.
  const root = makeRoot();
  write(root, "broken.json", "{ not json");

  const listing = await discoverWorkflows({ roots: [root] });

  expect(byName(listing, "broken").node_count).toBeNull();
});

test("an unreadable file is reported invalid, not thrown from", async () => {
  const root = makeRoot();
  write(root, "readable.json", frontend(2));
  const secret = write(root, "secret.json", frontend(2));
  chmodSync(secret, 0o000);

  try {
    const listing = await discoverWorkflows({ roots: [root] });

    expect(byName(listing, "secret").format).toBe("invalid");
    expect(byName(listing, "readable").format).toBe("frontend"); // still listed
  } finally {
    chmodSync(secret, 0o644);
  }
});

test("an invalid entry says why, distinguishing corrupt from unreadable", async () => {
  // Both are `invalid`, but the fixes are not the same: one is a broken file,
  // the other a permission bit. Collapsing them leaves the operator guessing.
  const root = makeRoot();
  write(root, "corrupt.json", "{ not json");
  const secret = write(root, "secret.json", frontend());
  chmodSync(secret, 0o000);

  try {
    const listing = await discoverWorkflows({ roots: [root] });

    expect(byName(listing, "secret").problem).toContain("EACCES");
    // A parse failure must not be dressed up as a read failure. The two have
    // different fixes, and a `catch` wide enough to blur them would also
    // relabel a bug in this module as the operator's permission problem.
    expect(byName(listing, "corrupt").problem).toContain("JSON");
    expect(byName(listing, "corrupt").problem).not.toContain("could not be read");
  } finally {
    chmodSync(secret, 0o644);
  }
});

test("a valid workflow carries no problem", async () => {
  const root = makeRoot();
  write(root, "graph.json", frontend());

  const listing = await discoverWorkflows({ roots: [root] });

  expect(byName(listing, "graph").problem).toBeUndefined();
});

// --- what is scanned --------------------------------------------------------

test("non-JSON files are ignored", async () => {
  const root = makeRoot();
  write(root, "graph.json", frontend());
  write(root, "notes.txt", "not a workflow");
  write(root, "image.png", "\x89PNG");
  write(root, "json", "{}"); // no extension at all
  write(root, "archive.json.bak", frontend());
  write(root, ".json", frontend()); // extension but no stem

  const listing = await discoverWorkflows({ roots: [root] });

  expect(names(listing)).toEqual(["graph"]);
});

test("the .json match is case-insensitive", async () => {
  // macOS filesystems are case-insensitive by default, so a `.JSON` file is a
  // thing an operator can easily end up with.
  const root = makeRoot();
  write(root, "shouty.JSON", frontend(2));

  const listing = await discoverWorkflows({ roots: [root] });

  expect(byName(listing, "shouty").format).toBe("frontend");
});

test("subdirectories are not descended into", async () => {
  // ComfyUI writes workflows flat. Recursing would drag in whatever an operator
  // keeps beside them — node_modules in a checked-out template repo, say.
  const root = makeRoot();
  write(root, "top.json", frontend());
  mkdirSync(join(root, "nested"));
  write(join(root, "nested"), "deep.json", frontend());

  const listing = await discoverWorkflows({ roots: [root] });

  expect(names(listing)).toEqual(["top"]);
});

test("a directory whose own name ends in .json is not listed as a workflow", async () => {
  // Without an explicit directory guard this would be listed, then fail to read
  // with EISDIR, and appear to the caller as a corrupt workflow that never was.
  const root = makeRoot();
  write(root, "real.json", frontend());
  mkdirSync(join(root, "bundle.json"));

  const listing = await discoverWorkflows({ roots: [root] });

  expect(names(listing)).toEqual(["real"]);
});

test("an empty directory yields an empty listing", async () => {
  const root = makeRoot();

  const listing = await discoverWorkflows({ roots: [root] });

  expect(listing.workflows).toEqual([]);
  expect(listing.unreadable).toEqual([]);
});

// --- roots ------------------------------------------------------------------

test("a root that does not exist is skipped quietly", async () => {
  // An operator may configure several machines' paths in one config.
  const root = makeRoot();
  write(root, "graph.json", frontend());

  const listing = await discoverWorkflows({ roots: [join(root, "nope"), root] });

  expect(names(listing)).toEqual(["graph"]);
  expect(listing.unreadable).toEqual([]);
});

test("every configured root missing is an empty listing, not an error", async () => {
  const root = makeRoot();

  const listing = await discoverWorkflows({ roots: [join(root, "a"), join(root, "b")] });

  expect(listing.workflows).toEqual([]);
  expect(listing.unreadable).toEqual([]);
});

test("a root that exists but cannot be read is surfaced", async () => {
  // Distinct from a missing root on purpose. The operator meant this directory
  // to be scanned and it is there; reporting zero workflows would be
  // indistinguishable from "it is empty" and send them hunting for the wrong
  // thing. It still must not deny them the roots that did work.
  const root = makeRoot();
  write(root, "visible.json", frontend());
  const shut = join(root, "shut");
  mkdirSync(shut);
  write(shut, "hidden.json", frontend());
  chmodSync(shut, 0o000);
  locked.push(shut);

  const listing = await discoverWorkflows({ roots: [shut, root] });

  expect(names(listing)).toEqual(["visible"]);
  expect(listing.unreadable).toHaveLength(1);
  expect(listing.unreadable[0]!.root).toBe(shut);
  expect(listing.unreadable[0]!.reason).toContain("EACCES");
});

test("a root that is a file rather than a directory is surfaced", async () => {
  // A misconfiguration that points at the workflow instead of its directory.
  const root = makeRoot();
  const file = write(root, "graph.json", frontend());

  const listing = await discoverWorkflows({ roots: [file] });

  expect(listing.workflows).toEqual([]);
  expect(listing.unreadable).toHaveLength(1);
  expect(listing.unreadable[0]!.root).toBe(file);
  expect(listing.unreadable[0]!.reason).toContain("ENOTDIR");
});

test("two roots holding the same filename both appear under distinct names", async () => {
  const first = makeRoot();
  const second = makeRoot();
  write(first, "shared.json", frontend(2));
  write(second, "shared.json", api(5));

  const listing = await discoverWorkflows({ roots: [first, second] });

  expect(listing.workflows).toHaveLength(2);
  expect(new Set(names(listing)).size).toBe(2); // never two handles for one name
  // The first configured root keeps the bare name; the collision is qualified
  // by its own root's directory name — not by the whole absolute path, which
  // would be an unusable handle for a caller to type back.
  expect(names(listing)).toContain("shared");
  const qualified = listing.workflows.find((w) => w.name !== "shared");
  expect(qualified!.name).toBe(`${basename(second)}/shared`);
  expect(qualified!.path).toBe(join(second, "shared.json"));
});

test("root order decides which colliding file keeps the bare name", async () => {
  // Reversing the configured order must reverse which one is qualified;
  // otherwise precedence is coming from the filesystem, not the operator.
  const first = makeRoot();
  const second = makeRoot();
  write(first, "shared.json", frontend(2));
  write(second, "shared.json", frontend(2));

  const forward = await discoverWorkflows({ roots: [first, second] });
  const reverse = await discoverWorkflows({ roots: [second, first] });

  expect(byName(forward, "shared").path).toBe(join(first, "shared.json"));
  expect(byName(reverse, "shared").path).toBe(join(second, "shared.json"));
});

test("a name collision does not merge or drop either file", async () => {
  const first = makeRoot();
  const second = makeRoot();
  write(first, "shared.json", frontend(2));
  write(second, "shared.json", api(5));

  const listing = await discoverWorkflows({ roots: [first, second] });
  const paths = listing.workflows.map((w) => w.path).sort();

  expect(paths).toEqual([join(first, "shared.json"), join(second, "shared.json")].sort());
  expect(listing.workflows.map((w) => w.format).sort()).toEqual(["api", "frontend"]);
});

test("the same root listed twice yields each workflow once", async () => {
  // Otherwise a duplicated config entry doubles the listing and then forces
  // disambiguation onto names that describe the very same file.
  const root = makeRoot();
  write(root, "graph.json", frontend());

  const listing = await discoverWorkflows({ roots: [root, root] });

  expect(names(listing)).toEqual(["graph"]);
});

// --- reported fields --------------------------------------------------------

test("each entry carries an absolute path, size and modification time", async () => {
  const root = makeRoot();
  const path = write(root, "graph.json", frontend(3));
  const stats = statSync(path);

  const listing = await discoverWorkflows({ roots: [root] });
  const entry = byName(listing, "graph");

  expect(entry.path).toBe(path);
  expect(entry.size_bytes).toBe(stats.size);
  expect(entry.modified).toBe(new Date(stats.mtimeMs).toISOString());
});

test("a relative root is resolved to absolute paths", async () => {
  const root = makeRoot();
  write(root, "graph.json", frontend());

  const listing = await discoverWorkflows({ roots: [root] });

  expect(byName(listing, "graph").path.startsWith("/")).toBe(true);
});

test("the name drops only the .json extension, keeping inner dots", async () => {
  // `template_qwen_image_illustration_lora.app.json` is a real filename.
  const root = makeRoot();
  write(root, "a.b.c.json", frontend());

  const listing = await discoverWorkflows({ roots: [root] });

  expect(names(listing)).toEqual(["a.b.c"]);
});

// --- ordering ---------------------------------------------------------------

test("results are ordered by name, not by filesystem order", async () => {
  const root = makeRoot();
  // Written in an order that is neither sorted nor reversed.
  for (const name of ["mid.json", "zeta.json", "alpha.json", "beta.json"]) {
    write(root, name, frontend());
  }

  const listing = await discoverWorkflows({ roots: [root] });

  expect(names(listing)).toEqual(["alpha", "beta", "mid", "zeta"]);
});

test("ordering is stable across calls and independent of mtime", async () => {
  // Ordering by mtime would reshuffle the whole listing every time any single
  // file was touched, which is the opposite of a stable handle list.
  const root = makeRoot();
  write(root, "alpha.json", frontend());
  write(root, "beta.json", frontend());
  write(root, "gamma.json", frontend());

  const before = names(await discoverWorkflows({ roots: [root] }));
  write(root, "alpha.json", frontend(9)); // newest file, still sorts first
  const after = names(await discoverWorkflows({ roots: [root] }));

  expect(before).toEqual(["alpha", "beta", "gamma"]);
  expect(after).toEqual(before);
});

test("ordering spans roots rather than concatenating them", async () => {
  const first = makeRoot();
  const second = makeRoot();
  write(first, "mango.json", frontend());
  write(second, "apple.json", frontend());

  const listing = await discoverWorkflows({ roots: [first, second] });

  expect(names(listing)).toEqual(["apple", "mango"]);
});

test("ordering does not depend on the ambient locale", async () => {
  // `localeCompare` orders differently depending on ICU data and LANG, which
  // would make the listing differ between machines.
  const root = makeRoot();
  for (const name of ["Zeta.json", "alpha.json", "Beta.json"]) write(root, name, frontend());

  const listing = await discoverWorkflows({ roots: [root] });

  expect(names(listing)).toEqual(["Beta", "Zeta", "alpha"]); // code-unit order
});

// --- config -----------------------------------------------------------------

test("the default root is the user's ComfyUI workflow directory", () => {
  expect(workflowRoots({})).toEqual([DEFAULT_WORKFLOW_DIR]);
  expect(DEFAULT_WORKFLOW_DIR).toBe("/Users/lawls/ComfyUI-Shared/user/default/workflows");
});

test("MCP_COMFYUI_WORKFLOW_DIRS overrides the default", () => {
  expect(workflowRoots({ MCP_COMFYUI_WORKFLOW_DIRS: "/a/one" })).toEqual(["/a/one"]);
});

test("MCP_COMFYUI_WORKFLOW_DIRS splits on colons, like PATH", () => {
  expect(workflowRoots({ MCP_COMFYUI_WORKFLOW_DIRS: "/a/one:/b/two:/c/three" })).toEqual([
    "/a/one",
    "/b/two",
    "/c/three",
  ]);
});

test("configured order is preserved", () => {
  // It is the precedence that decides which of two colliding names is bare.
  expect(workflowRoots({ MCP_COMFYUI_WORKFLOW_DIRS: "/z/last:/a/first" })).toEqual([
    "/z/last",
    "/a/first",
  ]);
});

test("empty and blank segments are dropped", () => {
  // A trailing colon is the classic. An empty segment meaning "the current
  // directory" is a PATH footgun worth not inheriting.
  expect(workflowRoots({ MCP_COMFYUI_WORKFLOW_DIRS: "/a/one::/b/two:" })).toEqual([
    "/a/one",
    "/b/two",
  ]);
});

test("a duplicated root is listed once", () => {
  expect(workflowRoots({ MCP_COMFYUI_WORKFLOW_DIRS: "/a/one:/a/one:/b/two" })).toEqual([
    "/a/one",
    "/b/two",
  ]);
});

test("a relative root is resolved against the working directory", () => {
  const [only] = workflowRoots({ MCP_COMFYUI_WORKFLOW_DIRS: "some/where" });

  expect(only!.startsWith("/")).toBe(true);
  expect(only!.endsWith("some/where")).toBe(true);
});

test("an empty or blank override falls back to the default", () => {
  // A shell that exports an unset variable yields "", which means the operator
  // said nothing — not that they want no directories searched at all.
  expect(workflowRoots({ MCP_COMFYUI_WORKFLOW_DIRS: "" })).toEqual([DEFAULT_WORKFLOW_DIR]);
  expect(workflowRoots({ MCP_COMFYUI_WORKFLOW_DIRS: "   " })).toEqual([DEFAULT_WORKFLOW_DIR]);
  expect(workflowRoots({ MCP_COMFYUI_WORKFLOW_DIRS: ":::" })).toEqual([DEFAULT_WORKFLOW_DIR]);
});

test("discoverWorkflows falls back to the configured roots", async () => {
  // Called with no roots at all it must consult the environment rather than
  // scanning nothing. Pointed at a temp dir so the real one is never read.
  const root = makeRoot();
  write(root, "graph.json", frontend());

  const listing = await discoverWorkflows({ env: { MCP_COMFYUI_WORKFLOW_DIRS: root } });

  expect(names(listing)).toEqual(["graph"]);
});
