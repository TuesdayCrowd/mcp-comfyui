import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { type Environment, uniqueRoots, workflowRoots } from "../config.ts";

/**
 * What workflows exist — the question every other tool depends on being able to
 * answer first. `describe_workflow` and `run_workflow` both take a workflow
 * handle, and this module is where those handles come from.
 *
 * It is the one part of the introspection path that does not go through
 * `comfy`. The CLI reads a workflow it is pointed at; it does not enumerate a
 * directory, and it rejects a non-frontend file with an error rather than a
 * classification. Sending a caller into a CLI round trip per file just to find
 * out which files are usable would cost 22 process spawns to answer a question
 * a directory read answers.
 *
 * ## Nothing here is fatal
 *
 * Every failure degrades one entry, or one root, and the rest of the listing
 * survives. This is the module's central promise, and the reason is arithmetic:
 * a listing is all-or-nothing to its caller, so one corrupt file that threw
 * would deny them the other 21 workflows — every one of which is perfectly
 * runnable. A caller who can see 21 workflows and one marked `invalid` can act;
 * a caller holding an exception cannot.
 *
 * ## Why a full parse, measured rather than assumed
 *
 * The implementation plan suggested classifying "cheaply, without a full parse".
 * Measured against the real 22-file directory (647 KiB), per listing:
 *
 * ```
 *   stat() only, the irreducible floor        0.035 ms
 *   stat + read, no parse                     0.453 ms
 *   stat + read + full JSON.parse             1.845 ms   <- chosen
 *   stat + 4 KiB prefix read, no parse        0.294 ms
 *   stat + warm mtime-cache hit               0.028 ms
 * ```
 *
 * A full parse of the entire directory costs **1.8 ms**, about 350 MiB/s. That
 * is far below the latency of the MCP round trip that asked for it, and below
 * the cost of the single `comfy` spawn any follow-up call makes. The two
 * alternatives were rejected on evidence, not taste:
 *
 * - **A prefix scan is not merely incomplete, it is wrong.** The string
 *   `"links"` appears in the first 4 KiB of all 22 real files — but never as the
 *   top-level key. It is the `links` array *inside* a node's own `outputs`
 *   (measured: first occurrence at byte 415 of `default_image_gen.json`, inside
 *   `"type":"IMAGE","slot_index":0,"links":[9]`), while the real top-level
 *   `links` sits between 82% and 99% of the way through the file, after the
 *   whole `nodes` array. Any substring or prefix test would therefore classify
 *   on a coincidence and be right only by luck. `node_count` needs the full
 *   `nodes` array counted regardless, so there is nothing left to save.
 * - **An mtime cache saves 1.8 ms and buys an invalidation bug.** Caching would
 *   have to be keyed on mtime, whose granularity is one second on some
 *   filesystems and coarser over a network mount — so a workflow edited and
 *   re-read within the same tick would serve a stale classification, and the
 *   stale answer would be the one deciding whether the file is runnable. Paying
 *   1.8 ms to make that class of bug impossible is the right trade at this size.
 *
 * If a future operator points this at a directory of thousands of files, the
 * numbers above are the ones to re-measure — the conclusion is scale-dependent,
 * and the throughput figure is the input to redoing the arithmetic.
 */

/**
 * How a file is shaped, decided **only** by reading it.
 *
 * Never by its name. `image_chroma1_radiance_text_to_image_api.json` is a real
 * file in this user's directory and is frontend format — the `_api` refers to
 * API *nodes*, a kind of node that calls a hosted model, not to the file's
 * serialisation. A name-based rule would misclassify it and send the caller
 * away from a workflow that runs perfectly well.
 */
export type WorkflowFormat =
  /** The UI graph the ComfyUI editor saves: `nodes` and `links`. The only format `comfy workflow slots` reads. */
  | "frontend"
  /** The prompt graph `Export (API)` writes: node ids mapping to objects with `class_type`. */
  | "api"
  /** Unparseable, unreadable, or parseable but neither shape. */
  | "invalid";

/** One discovered file. */
export interface WorkflowFile {
  /**
   * The handle a caller passes to later tools. Unique within a listing; see
   * {@link discoverWorkflows} for how a collision between roots is resolved.
   */
  name: string;
  /** Absolute, and lexically resolved rather than `realpath`-ed. */
  path: string;
  format: WorkflowFormat;
  /**
   * Nodes in the top-level graph, or `null` when the file could not be read as
   * one.
   *
   * `null` rather than `0`, because zero nodes is a claim about a graph that was
   * successfully read, and an invalid file was not. A caller filtering for
   * "empty workflows" must not be handed corrupt ones.
   *
   * For `frontend` this is `nodes.length`, and it counts the **top-level graph
   * only**. A file using subgraphs holds far more than this once expanded:
   * measured on `templates-6-key-frames.json`, 17 top-level nodes enclose 80
   * more inside `definitions.subgraphs`, and the expanded graph is what yields
   * its 210 settable slots. This number is a size hint for a human scanning a
   * list; it is not a slot count and must not be presented as one.
   */
  node_count: number | null;
  size_bytes: number;
  /** ISO 8601, from the file's mtime. */
  modified: string;
  /**
   * Why an `invalid` file is invalid — absent on everything else. Both a corrupt
   * file and an unreadable one are `invalid`, but their fixes are not the same
   * (repair the file versus fix a permission bit), and the enum has no room to
   * say which.
   */
  problem?: string;
}

/** A configured root that exists but could not be listed. */
export interface UnreadableRoot {
  root: string;
  /** The errno where there is one — `EACCES`, `ENOTDIR` — else the message. */
  reason: string;
}

/**
 * The listing, and the roots that could not contribute to it.
 *
 * Siblings rather than one nested inside the other, following the same split as
 * `describe.ts`'s `{schema, unresolved}`: `workflows` is the answer, and
 * `unreadable` is for the operator, who is the only person who can fix a
 * permission bit and who otherwise cannot tell a root that is empty from a root
 * that would not open.
 */
export interface WorkflowListing {
  workflows: WorkflowFile[];
  unreadable: UnreadableRoot[];
}

export interface DiscoverOptions {
  /** Overrides configuration entirely. Resolved and de-duplicated like the configured list. */
  roots?: string[];
  /** Consulted only when `roots` is absent. Defaults to `process.env`. */
  env?: Environment;
}

const JSON_EXTENSION = ".json";

/**
 * Ordering with no dependence on the ambient locale.
 *
 * `localeCompare` varies with ICU data and `LANG`, so the same directory would
 * list in a different order on two machines, and a caller diffing two listings
 * would see phantom churn. Code-unit order is boring, total and reproducible.
 */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A `.json` file with something in front of the extension. Case-insensitive
 * because macOS filesystems are, so `Graph.JSON` is a file an operator can
 * easily end up with, and a bare `.json` is excluded because its stem is empty
 * and an empty handle is not addressable.
 */
function isWorkflowFilename(name: string): boolean {
  return name.length > JSON_EXTENSION.length && name.toLowerCase().endsWith(JSON_EXTENSION);
}

/**
 * The filename without its extension.
 *
 * Only the final `.json` comes off. Real filenames carry dots beyond the
 * extension — `template_qwen_image_illustration_lora.app.json` — and truncating
 * at the *first* dot would collapse it to `template_qwen_image_illustration_lora`,
 * silently colliding with any sibling that shares that prefix.
 */
function stemOf(filename: string): string {
  return filename.slice(0, -JSON_EXTENSION.length);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** Prefer the errno: `EACCES` is what the operator can act on, the path they already know. */
function reasonOf(cause: unknown): string {
  const code = cause instanceof Error ? (cause as NodeJS.ErrnoException).code : undefined;
  if (typeof code === "string") return code;
  return cause instanceof Error ? cause.message : String(cause);
}

function isMissing(cause: unknown): boolean {
  return (cause as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

type Classification = Pick<WorkflowFile, "format" | "node_count" | "problem">;

function invalid(problem: string): Classification {
  return { format: "invalid", node_count: null, problem };
}

/**
 * How many top-level entries are nodes, or `undefined` if none are.
 *
 * Counts only the values that actually carry `class_type`, because an API export
 * may hold non-node keys beside the graph — reporting those as nodes would
 * inflate the count with metadata.
 */
function apiNodeCount(graph: Record<string, unknown>): number | undefined {
  let count = 0;
  for (const value of Object.values(graph)) {
    const node = asRecord(value);
    if (node !== undefined && Object.hasOwn(node, "class_type")) count += 1;
  }
  return count > 0 ? count : undefined;
}

/**
 * Classify one file's contents.
 *
 * Frontend is tested first because it is the more specific claim — two named
 * keys that must both be arrays, versus "some value somewhere looks like a
 * node" — and because it is the format every one of this user's 22 files is in.
 *
 * Both `nodes` and `links` are required, and both must be arrays. Half a match
 * is not a frontend graph: `comfy workflow slots` reads the pair, so claiming
 * `frontend` on a file carrying only `nodes` would send the caller into exactly
 * the `workflow_not_frontend_format` failure this listing exists to predict.
 */
function classify(text: string): Classification {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    return invalid(`not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  const graph = asRecord(value);
  if (graph === undefined) {
    return invalid("not a JSON object, so it holds neither a frontend graph nor an API prompt");
  }

  const nodes = graph["nodes"];
  if (Array.isArray(nodes) && Array.isArray(graph["links"])) {
    return { format: "frontend", node_count: nodes.length };
  }

  const apiNodes = apiNodeCount(graph);
  if (apiNodes !== undefined) return { format: "api", node_count: apiNodes };

  return invalid(
    "no `nodes` and `links` arrays (frontend format) and no values carrying `class_type` (API format)",
  );
}

/**
 * Everything reportable about one file, or `undefined` if it vanished.
 *
 * A file deleted between the directory read and this call is a real race, and
 * the honest response is to omit it: an entry needs a size and a modification
 * time, and inventing either would put a workflow in the listing that is not
 * there. A file that merely cannot be *opened* is different — it exists, it has
 * a size, and the caller should see it — so it is listed as `invalid`.
 *
 * Each `try` wraps exactly the one call that is expected to fail, and
 * {@link classify} is deliberately outside all of them. It is total by
 * construction — every failure inside it is already a returned `invalid` — so
 * anything it threw would be a bug in this module, and a `catch` wide enough to
 * cover it would relabel that bug as "could not be read" and hand the operator
 * a permission-shaped message for a parser fault. Same reasoning as the
 * `EnvelopeParseError` amendment in `comfy/envelope.ts`: a blanket catch
 * swallows its author's own mistakes and misreports them as someone else's.
 */
async function inspect(path: string): Promise<Omit<WorkflowFile, "name"> | undefined> {
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(path);
  } catch {
    return undefined;
  }

  const found = {
    path,
    size_bytes: stats.size,
    modified: new Date(stats.mtimeMs).toISOString(),
  };

  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    return { ...found, ...invalid(`could not be read: ${reasonOf(cause)}`) };
  }

  return { ...found, ...classify(text) };
}

/**
 * The unique handle for one file.
 *
 * Tried in order: the bare stem, then the stem qualified by the root's own
 * directory name, then the absolute path — which is unique by construction,
 * since duplicate paths are dropped before this runs.
 *
 * The first file to ask for a name keeps the bare one, and callers are walked in
 * configured root order, so precedence follows the operator's own ordering
 * rather than whatever order the filesystem returned. The consequence worth
 * naming: adding a colliding file to a *later* root leaves the earlier root's
 * handle untouched, which is the direction that matters — the established name
 * is the one already written into somebody's saved prompt.
 */
function claimName(root: string, filename: string, taken: Set<string>, path: string): string {
  const stem = stemOf(filename);
  for (const candidate of [stem, `${basename(root)}/${stem}`, path]) {
    if (taken.has(candidate)) continue;
    taken.add(candidate);
    return candidate;
  }
  taken.add(path);
  return path;
}

/** The `.json` files in one root, sorted, or a reason the root could not be listed. */
async function scanRoot(root: string): Promise<{ filenames: string[] } | { reason: string }> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return {
      filenames: entries
        // ComfyUI writes workflows flat, and recursing would drag in whatever an
        // operator keeps beside them.
        .filter((entry) => !entry.isDirectory() && isWorkflowFilename(entry.name))
        .map((entry) => entry.name)
        // So that name precedence within a root never depends on the order the
        // filesystem happened to return.
        .sort(compare),
    };
  } catch (cause) {
    // A configured root that is simply not on this machine is skipped in
    // silence: one config is meant to work on several machines, and an operator
    // who lists their laptop's path and their workstation's path should not get
    // a warning about the other one on every single call. A root that *is*
    // there and will not open is the opposite — they meant it to be scanned, it
    // exists, and silently reporting nothing from it is indistinguishable from
    // it being empty, which sends them looking for missing workflows instead of
    // at a permission bit.
    if (isMissing(cause)) return { filenames: [] };
    return { reason: reasonOf(cause) };
  }
}

/**
 * Every workflow file across the configured roots.
 *
 * Ordered by `name`, ascending, in code-unit order — one sequence spanning all
 * roots rather than the roots concatenated. Name order is the only one a caller
 * can predict, since `name` is what they see and what they pass back; directory
 * order varies by filesystem, and mtime order would reshuffle the entire listing
 * every time any single file was touched.
 *
 * Never throws for anything about the files or directories it finds. A corrupt
 * file becomes one `invalid` entry, an unopenable root becomes one
 * {@link UnreadableRoot}, and a missing root is skipped.
 */
export async function discoverWorkflows(opts: DiscoverOptions = {}): Promise<WorkflowListing> {
  const roots = opts.roots === undefined ? workflowRoots(opts.env) : uniqueRoots(opts.roots);

  const unreadable: UnreadableRoot[] = [];
  const taken = new Set<string>();
  const seenPaths = new Set<string>();
  const pending: Promise<WorkflowFile | undefined>[] = [];

  // Roots in configured order, so name precedence is the operator's to decide.
  for (const root of roots) {
    const scanned = await scanRoot(root);
    if ("reason" in scanned) {
      unreadable.push({ root, reason: scanned.reason });
      continue;
    }

    for (const filename of scanned.filenames) {
      const path = join(root, filename);
      // Two roots where one is a symlink to the other reach the same file twice;
      // it is one workflow and deserves one handle.
      if (seenPaths.has(path)) continue;
      seenPaths.add(path);

      // Names are claimed synchronously, in traversal order, so the assignment
      // cannot depend on which file's `stat` happened to resolve first.
      const name = claimName(root, filename, taken, path);
      pending.push(inspect(path).then((found) => (found ? { name, ...found } : undefined)));
    }
  }

  const workflows = (await Promise.all(pending)).filter((found) => found !== undefined);
  workflows.sort((a, b) => compare(a.name, b.name));

  return { workflows, unreadable };
}
