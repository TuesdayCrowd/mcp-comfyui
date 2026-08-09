import { afterEach, beforeEach, expect, test } from "./support/testing.ts";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createdWorkflowDir, DEFAULT_WORKFLOW_DIR, workflowRoots } from "../src/config.ts";
import {
  type WorkflowFile,
  type WorkflowListing,
  discoverWorkflows,
  inertInputsOf,
  inertInputsOfFile,
} from "../src/workflows/discover.ts";

/**
 * No test in this file may read the operator's real workflow directory or
 * contact a server: every scanned root is a fresh temp directory written by
 * the test itself.
 *
 * Most tests hand `discoverWorkflows` an explicit `roots` array, which
 * bypasses `workflowRoots`/the environment entirely — nothing to guard there.
 * The "config" section below calls `workflowRoots` directly to inspect its
 * *return value*, never to scan anything, so an env that omits
 * `MCP_COMFYUI_CREATED_DIR` there cannot read a real directory either. The one
 * call that must set it is `discoverWorkflows({ env })`: `workflowRoots`
 * always appends {@link createdWorkflowDir}'s result as a live scan root, and
 * an env that leaves `MCP_COMFYUI_CREATED_DIR` unset resolves that to the
 * operator's real `~/.local/share/mcp-comfyui/workflows` — silently correct
 * only while nothing has ever written there. Every such call must pin it to a
 * temp directory too, on the same reasoning as `MCP_COMFYUI_WORKFLOW_DIRS`.
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

test("a JSON Schema that describes class_type is not a workflow", async () => {
  // Found in live use: comfy-cli's own published run_event.json has
  // `properties.class_type = {"type": ["string","null"]}`, and a rule that only
  // checked the key's presence classified it `api` with one node — offering a
  // schema document to a caller as something runnable. In a real API node
  // `class_type` is the node's class NAME, so it is always a string.
  const root = mkdtempSync(join(tmpdir(), "mcp-comfyui-discover-schema-"));
  try {
    writeFileSync(
      join(root, "schema.json"),
      JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { class_type: { type: ["string", "null"] } },
      }),
    );
    const listing = await discoverWorkflows({ roots: [root] });
    expect(listing.workflows).toHaveLength(1);
    expect(listing.workflows[0]?.format).toBe("invalid");
    expect(listing.workflows[0]?.node_count).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
  // workflowRoots() also appends the created-workflows directory, last — see
  // config.test.ts for that guarantee in isolation; here it is just accounted
  // for, never reordered away.
  expect(workflowRoots({})).toEqual([DEFAULT_WORKFLOW_DIR, createdWorkflowDir({})]);
  expect(DEFAULT_WORKFLOW_DIR).toBe("/Users/lawls/ComfyUI-Shared/user/default/workflows");
});

test("MCP_COMFYUI_WORKFLOW_DIRS overrides the default", () => {
  expect(workflowRoots({ MCP_COMFYUI_WORKFLOW_DIRS: "/a/one" })).toEqual([
    "/a/one",
    createdWorkflowDir({}),
  ]);
});

test("MCP_COMFYUI_WORKFLOW_DIRS splits on colons, like PATH", () => {
  expect(workflowRoots({ MCP_COMFYUI_WORKFLOW_DIRS: "/a/one:/b/two:/c/three" })).toEqual([
    "/a/one",
    "/b/two",
    "/c/three",
    createdWorkflowDir({}),
  ]);
});

test("configured order is preserved", () => {
  // It is the precedence that decides which of two colliding names is bare.
  expect(workflowRoots({ MCP_COMFYUI_WORKFLOW_DIRS: "/z/last:/a/first" })).toEqual([
    "/z/last",
    "/a/first",
    createdWorkflowDir({}),
  ]);
});

test("empty and blank segments are dropped", () => {
  // A trailing colon is the classic. An empty segment meaning "the current
  // directory" is a PATH footgun worth not inheriting.
  expect(workflowRoots({ MCP_COMFYUI_WORKFLOW_DIRS: "/a/one::/b/two:" })).toEqual([
    "/a/one",
    "/b/two",
    createdWorkflowDir({}),
  ]);
});

test("a duplicated root is listed once", () => {
  expect(workflowRoots({ MCP_COMFYUI_WORKFLOW_DIRS: "/a/one:/a/one:/b/two" })).toEqual([
    "/a/one",
    "/b/two",
    createdWorkflowDir({}),
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
  expect(workflowRoots({ MCP_COMFYUI_WORKFLOW_DIRS: "" })).toEqual([DEFAULT_WORKFLOW_DIR, createdWorkflowDir({})]);
  expect(workflowRoots({ MCP_COMFYUI_WORKFLOW_DIRS: "   " })).toEqual([
    DEFAULT_WORKFLOW_DIR,
    createdWorkflowDir({}),
  ]);
  expect(workflowRoots({ MCP_COMFYUI_WORKFLOW_DIRS: ":::" })).toEqual([
    DEFAULT_WORKFLOW_DIR,
    createdWorkflowDir({}),
  ]);
});

test("discoverWorkflows falls back to the configured roots", async () => {
  // Called with no roots at all it must consult the environment rather than
  // scanning nothing. Pointed at a temp dir so the real one is never read —
  // and MCP_COMFYUI_CREATED_DIR is pinned to a second temp dir for the same
  // reason: workflowRoots() appends createdWorkflowDir(env) unconditionally,
  // and leaving it unset here would make this call scan this developer's
  // real ~/.local/share/mcp-comfyui/workflows once anything (e.g. Task 6)
  // ever writes a fetched template there.
  const root = makeRoot();
  write(root, "graph.json", frontend());
  const created = makeRoot();

  const listing = await discoverWorkflows({
    env: { MCP_COMFYUI_WORKFLOW_DIRS: root, MCP_COMFYUI_CREATED_DIR: created },
  });

  expect(names(listing)).toEqual(["graph"]);
});

// --- has_subgraphs: informational only, never a refusal --------------------
//
// A first diagnosis of this feature concluded a subgraph-controlled workflow
// could not be run through comfy-cli at all, and this field was meant to back
// a hard refusal in describe_workflow/run_workflow. That diagnosis was wrong
// — measured directly against a live run, the conversion resolves a
// subgraph's own inputs correctly; what it gets wrong is which *inner*
// addresses are decoys (see the "inert inputs" section below), which is an
// orthogonal, per-slot fact. `has_subgraphs` survives only as a cheap,
// informational signal for list_workflows.

test("a workflow with a non-empty definitions.subgraphs is flagged has_subgraphs", async () => {
  const root = makeRoot();
  write(
    root,
    "graph.json",
    JSON.stringify({
      nodes: [{ id: 1 }],
      links: [],
      definitions: { subgraphs: [{ id: "sg-1", nodes: [] }] },
    }),
  );

  const listing = await discoverWorkflows({ roots: [root] });

  expect(byName(listing, "graph").has_subgraphs).toBe(true);
});

test("an empty definitions.subgraphs array is not flagged", async () => {
  const root = makeRoot();
  write(
    root,
    "graph.json",
    JSON.stringify({ nodes: [{ id: 1 }], links: [], definitions: { subgraphs: [] } }),
  );

  const listing = await discoverWorkflows({ roots: [root] });

  expect(byName(listing, "graph").has_subgraphs).toBe(false);
});

test("an empty definitions object does not slip through as having subgraphs", async () => {
  // Mutation guard: a check narrowed to merely "does `definitions` exist"
  // would wrongly flag this. `definitions: {}` carries no subgraphs at all.
  const root = makeRoot();
  write(root, "graph.json", JSON.stringify({ nodes: [{ id: 1 }], links: [], definitions: {} }));

  const listing = await discoverWorkflows({ roots: [root] });

  expect(byName(listing, "graph").has_subgraphs).toBe(false);
});

test("no definitions key at all is not flagged", async () => {
  const root = makeRoot();
  write(root, "graph.json", frontend());

  const listing = await discoverWorkflows({ roots: [root] });

  expect(byName(listing, "graph").has_subgraphs).toBe(false);
});

test("has_subgraphs is null for an invalid file, unknowable rather than false", async () => {
  // Same reasoning as node_count: null is a claim this could not be checked,
  // not a claim the file has no subgraphs.
  const root = makeRoot();
  write(root, "broken.json", "{ not json");

  const listing = await discoverWorkflows({ roots: [root] });

  expect(byName(listing, "broken").has_subgraphs).toBeNull();
});

test("has_subgraphs is reported on the real, measured subgraph workflow", async () => {
  const root = makeRoot();
  const real = readFileSync(join(import.meta.dirname, "fixtures", "audio_stable_audio_3_medium.json"), "utf8");
  write(root, "audio.json", real);

  const listing = await discoverWorkflows({ roots: [root] });

  expect(byName(listing, "audio").format).toBe("frontend"); // still fully usable
  expect(byName(listing, "audio").has_subgraphs).toBe(true);
});

// --- inert inputs: a widget a link overrides at execution time -------------
//
// The corrected diagnosis: a subgraph's own inputs convert correctly.
// What is actually broken is narrower and NOT specific to subgraphs at all —
// any widget-backed input that is fed by a link from a real, computing node
// has its stored value overridden at execution time, so setting it through
// `set-slot` does nothing. The one exception is a link whose origin is the
// subgraph's own input boundary (a negative `origin_id`, `-10` measured),
// which is not a "real node" and leaves the widget authoritative.

/** A node with zero or more widget-backed inputs, each optionally linked. */
function node(
  id: number,
  type: string,
  inputs: Array<{ name: string; link?: number | null; widget?: boolean }> = [],
): Record<string, unknown> {
  return {
    id,
    type,
    inputs: inputs.map((i) => ({
      name: i.name,
      link: i.link ?? null,
      ...(i.widget === false ? {} : { widget: { name: i.name } }),
    })),
  };
}

/** A top-level link, in the `[id, origin_id, origin_slot, target_id, target_slot, type]` array form. */
function arrayLink(id: number, originId: number, targetId: number): unknown[] {
  return [id, originId, 0, targetId, 0, "*"];
}

/** A subgraph-interior link, in the `{id, origin_id, ...}` object form. */
function objectLink(id: number, originId: number, targetId: number): Record<string, unknown> {
  return { id, origin_id: originId, origin_slot: 0, target_id: targetId, target_slot: 0, type: "*" };
}

const REAL_SUBGRAPH_FIXTURE = join(import.meta.dirname, "fixtures", "audio_stable_audio_3_medium.json");

test("the real subgraph workflow: measured decoys are flagged, measured effective controls are not", async () => {
  // Ground truth from a live run, not inference: setting 52/6.text and
  // 52/11.seconds produced 150s of stock tropical house regardless (the
  // widgets are decoys); setting 52/31.value, 52/36.value and 52/3.seed
  // produced exactly the requested 60s of black metal (the widgets are the
  // real controls).
  const inert = await inertInputsOfFile(REAL_SUBGRAPH_FIXTURE);

  expect(inert.has("52/6.text")).toBe(true);
  expect(inert.has("52/11.seconds")).toBe(true);
  expect(inert.has("52/31.value")).toBe(false);
  expect(inert.has("52/36.value")).toBe(false);
  expect(inert.has("52/3.seed")).toBe(false);
});

test("a decoy names the upstream node, and a clean candidate one hop away when there is one", async () => {
  // 52/11.seconds is fed by node 36 (PrimitiveFloat); node 36's own `value`
  // input is itself clean — its link originates at the subgraph boundary
  // (-10), not at another real node — so it is a usable candidate.
  const inert = await inertInputsOfFile(REAL_SUBGRAPH_FIXTURE);

  expect(inert.get("52/11.seconds")).toEqual({
    address: "52/11.seconds",
    upstream: { node_id: "36", node_type: "PrimitiveFloat", candidate_addresses: ["52/36.value"] },
  });
});

test("a decoy chained through another decoy names the node but invents no candidate", async () => {
  // 52/6.text is fed by node 34 (ComfySwitchNode). Node 34's own addressable
  // input (`switch`) is ITSELF fed by a link from a real node (35), so no
  // clean address is even one hop away — and none is guessed at.
  const inert = await inertInputsOfFile(REAL_SUBGRAPH_FIXTURE);

  expect(inert.get("52/6.text")).toEqual({
    address: "52/6.text",
    upstream: { node_id: "34", node_type: "ComfySwitchNode", candidate_addresses: [] },
  });
});

test("a widget input with no link at all is effective, no subgraph involved", () => {
  const graph = { nodes: [node(1, "KSampler", [{ name: "seed" }])], links: [] };

  expect(inertInputsOf(graph).size).toBe(0);
});

test("the rule generalises past subgraphs: an ordinary top-level link to a real node is a decoy", () => {
  // Not keyed on definitions.subgraphs at all: any workflow where a widget
  // was converted to an input and wired to a producing node has this shape.
  const graph = {
    nodes: [
      node(1, "KSampler", [{ name: "seed", link: 10 }]),
      node(2, "PrimitiveInt", [{ name: "value" }]), // no link -> clean
    ],
    links: [arrayLink(10, 2, 1)],
  };

  const inert = inertInputsOf(graph);

  expect(inert.get("1.seed")).toEqual({
    address: "1.seed",
    upstream: { node_id: "2", node_type: "PrimitiveInt", candidate_addresses: ["2.value"] },
  });
});

test("a link id with no matching entry is treated as effective, not decoy — the safe direction", () => {
  const graph = { nodes: [node(1, "KSampler", [{ name: "seed", link: 999 }])], links: [] };

  expect(inertInputsOf(graph).size).toBe(0);
});

test("any negative origin id is treated as the subgraph boundary, not just -10", () => {
  // Only -10 has been directly measured. Treating every negative id as the
  // boundary is the safe direction: a false decoy label would hide a working
  // control, which is worse than this function missing one.
  const graph = { nodes: [node(1, "KSampler", [{ name: "seed", link: 10 }])], links: [arrayLink(10, -99, 1)] };

  expect(inertInputsOf(graph).size).toBe(0);
});

test("an input with no widget marker is never treated as a settable slot at all", () => {
  const graph = {
    nodes: [node(2, "SomeSource", []), node(1, "Save", [{ name: "audio", link: 10, widget: false }])],
    links: [arrayLink(10, 2, 1)],
  };

  expect(inertInputsOf(graph).size).toBe(0);
});

test("more than one clean candidate one hop upstream are all listed", () => {
  const graph = {
    nodes: [
      node(1, "Multiplex", [{ name: "a" }, { name: "b" }]),
      node(2, "Consumer", [{ name: "in", link: 5 }]),
    ],
    links: [arrayLink(5, 1, 2)],
  };

  const inert = inertInputsOf(graph);

  expect(inert.get("2.in")?.upstream?.candidate_addresses.slice().sort()).toEqual(["1.a", "1.b"]);
});

test("a decoy inside a doubly-nested subgraph gets the full slash-joined address", () => {
  const graph = {
    nodes: [node(1, "outer-sg", [])],
    links: [],
    definitions: {
      subgraphs: [
        { id: "outer-sg", nodes: [node(2, "inner-sg", [])], links: [] },
        {
          id: "inner-sg",
          nodes: [node(3, "KSampler", [{ name: "seed", link: 20 }]), node(4, "PrimitiveInt", [{ name: "value" }])],
          links: [objectLink(20, 4, 3)],
        },
      ],
    },
  };

  const inert = inertInputsOf(graph);

  expect(inert.get("1/2/3.seed")).toEqual({
    address: "1/2/3.seed",
    upstream: { node_id: "4", node_type: "PrimitiveInt", candidate_addresses: ["1/2/4.value"] },
  });
});
