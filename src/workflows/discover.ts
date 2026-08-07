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
   * Whether the file's own JSON declares a subgraph — `definitions.subgraphs`
   * non-empty — or `null` when the file could not be read or parsed, on the
   * same reasoning as {@link node_count}: this is a claim about a graph that
   * was successfully read.
   *
   * Informational only. An earlier diagnosis of this workflow shape concluded
   * a subgraph's controls could not be parameterised through comfy-cli at all
   * and this field was meant to drive a hard refusal in `describe_workflow`/
   * `run_workflow`. That diagnosis was wrong — measured directly against a
   * live run, `convert_ui_to_api` resolves a subgraph's own inputs correctly.
   * What it gets wrong is narrower, is not specific to subgraphs, and is
   * reported per-slot instead: see {@link inertInputsOf}. This field survives
   * only as a cheap heads-up for a human scanning `list_workflows` — "this one
   * has a subgraph, its settable addresses may run deeper than two segments" —
   * and must never gate whether a workflow can be described or run.
   */
  has_subgraphs: boolean | null;
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

type Classification = Pick<WorkflowFile, "format" | "node_count" | "has_subgraphs" | "problem">;

function invalid(problem: string): Classification {
  return { format: "invalid", node_count: null, has_subgraphs: null, problem };
}

/**
 * Whether a parsed workflow's own JSON declares a non-empty
 * `definitions.subgraphs` array. An empty `definitions` object, or an empty
 * `subgraphs` array, does not count — both are the ordinary shape of a
 * workflow with no subgraph in it at all.
 */
function declaresSubgraphs(graph: Record<string, unknown>): boolean {
  const definitions = asRecord(graph["definitions"]);
  if (definitions === undefined) return false;
  const subgraphs = definitions["subgraphs"];
  return Array.isArray(subgraphs) && subgraphs.length > 0;
}

/**
 * How many top-level entries are nodes, or `undefined` if none are.
 *
 * Counts only the values that actually carry `class_type`, because an API export
 * may hold non-node keys beside the graph — reporting those as nodes would
 * inflate the count with metadata.
 *
 * `class_type` must be a **string**: in a real API node it is the node's class
 * name. Merely testing that the key exists misreads any JSON Schema that
 * *describes* a `class_type` property as a workflow — comfy-cli's own published
 * `run_event.json` has `properties.class_type = {"type": ["string","null"]}` and
 * was classified `api` with one node until this check was tightened.
 */
function apiNodeCount(graph: Record<string, unknown>): number | undefined {
  let count = 0;
  for (const value of Object.values(graph)) {
    const node = asRecord(value);
    if (node !== undefined && typeof node["class_type"] === "string") count += 1;
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

  const hasSubgraphs = declaresSubgraphs(graph);

  const nodes = graph["nodes"];
  if (Array.isArray(nodes) && Array.isArray(graph["links"])) {
    return { format: "frontend", node_count: nodes.length, has_subgraphs: hasSubgraphs };
  }

  const apiNodes = apiNodeCount(graph);
  if (apiNodes !== undefined) return { format: "api", node_count: apiNodes, has_subgraphs: hasSubgraphs };

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

/**
 * Inert inputs: a widget-backed slot whose stored value ComfyUI's own graph
 * execution overrides from a link to another node.
 *
 * ## The bug this replaces
 *
 * The original diagnosis of `audio_stable_audio_3_medium.json` concluded that
 * a subgraph's own controls could not be parameterised through comfy-cli at
 * all, because setting the addresses `comfy workflow slots` listed for it
 * produced no change in the output. That diagnosis was wrong. Measured
 * directly: `convert_ui_to_api` resolves a subgraph's own exposed inputs
 * correctly — setting `52/31.value`, `52/36.value` and `52/3.seed` (the
 * addresses this module identifies as effective, below) produced exactly the
 * requested 60 seconds of black metal. What actually happened is that two
 * *specific* addresses among the ones listed — `52/6.text` and
 * `52/11.seconds` — are decoys: their nodes' widgets are wired to links from
 * other real nodes inside the subgraph, so whatever value `set-slot` writes
 * there is never read once the graph executes.
 *
 * ## The rule, and why it is not about subgraphs at all
 *
 * A ComfyUI node input can be widget-backed (editable directly) and linked
 * (connected to another node's output) at the same time — the UI keeps the
 * widget as a fallback for when the link is removed. When both are present,
 * execution always uses the link, never the widget. That is completely
 * ordinary graph semantics and has nothing to do with subgraphs: ANY
 * workflow where a widget was converted to an input and then wired to a real
 * producing node has this exact shape, at any nesting depth including zero.
 * So this function is keyed on link topology, never on
 * `definitions.subgraphs` — see the top-level generalisation test in
 * `discover.test.ts`.
 *
 * The one link origin that does NOT make an input a decoy is the subgraph's
 * own input boundary — a synthetic pseudo-node ComfyUI gives a negative id
 * (`-10`, measured; see {@link isBoundaryOrigin}). A link from there means
 * "this widget's value is the subgraph instance's own exposed input, passed
 * straight through," which is exactly the case that already works.
 *
 * ## What is reported
 *
 * For each decoy address, the immediate upstream node (one hop, never chased
 * further — see {@link cleanCandidatesOf}) and, when that upstream node has
 * its own clean (non-decoy) widget input(s), the address(es) a caller might
 * want to set instead. Both `describe_workflow` (which excludes a decoy from
 * its schema and lists it separately) and `run_workflow` (which refuses a
 * call that sets one) are built on this.
 */

/** `52/6.text`-shaped: prefixed by every enclosing subgraph instance's own id, slash-joined. */
export interface InertUpstream {
  node_id: string;
  node_type: string;
  /**
   * Addresses on the upstream node whose own widget is authoritative — found
   * exactly one hop away, never chased through a further decoy (see
   * {@link cleanCandidatesOf}). Empty when none could be identified; never
   * invented.
   */
  candidate_addresses: string[];
}

/** One decoy address, and what actually supplies its value instead. */
export interface InertInput {
  address: string;
  /** `null` when the link's origin node could not be resolved at all. */
  upstream: InertUpstream | null;
}

function isNodeRecord(value: unknown): value is Record<string, unknown> {
  return asRecord(value) !== undefined;
}

/** The `id` field of a node or a subgraph, as the string every address segment uses. */
function idOf(record: Record<string, unknown>): string | undefined {
  const id = record["id"];
  if (typeof id === "number" || typeof id === "string") return String(id);
  return undefined;
}

function typeOf(record: Record<string, unknown>): string {
  const type = record["type"];
  return typeof type === "string" ? type : "";
}

/**
 * `link_id -> origin_id`, from either shape this codebase has measured: the
 * top-level frontend format's array-of-arrays
 * `[id, origin_id, origin_slot, target_id, target_slot, type]`, or a
 * subgraph's own `links`, an array of `{id, origin_id, ...}` objects.
 * `discover.ts` already carries prior art for exactly this kind of format
 * variance (`classify`'s frontend/API split); this is the same shape of
 * problem one level down, inside `definitions.subgraphs`.
 */
function linkOriginsOf(raw: unknown): Map<number, number> {
  const origins = new Map<number, number>();
  if (!Array.isArray(raw)) return origins;
  for (const entry of raw) {
    if (Array.isArray(entry)) {
      const [id, originId] = entry as unknown[];
      if (typeof id === "number" && typeof originId === "number") origins.set(id, originId);
      continue;
    }
    const record = asRecord(entry);
    if (record === undefined) continue;
    const id = record["id"];
    const originId = record["origin_id"];
    if (typeof id === "number" && typeof originId === "number") origins.set(id, originId);
  }
  return origins;
}

/**
 * Whether a link origin id is the subgraph input boundary rather than a real,
 * computing node. Only `-10` has actually been measured. Every other
 * negative id is still treated as the boundary — the safe direction, per this
 * module's doc comment: a false decoy label hides a working control, which is
 * worse than this function occasionally missing one. A non-negative id is
 * always a real node.
 */
function isBoundaryOrigin(originId: number): boolean {
  return originId < 0;
}

/** One widget-backed input, with the raw `link` field ComfyUI stored for it. */
interface WidgetInput {
  name: string;
  link: number | null;
}

/**
 * The widget-backed inputs of one node — the only inputs `comfy workflow
 * slots` ever addresses. An input with no `widget` marker is a pure graph
 * connection with no stored value of its own, so it is never a candidate
 * here at all, decoy or otherwise.
 */
function widgetInputsOf(node: Record<string, unknown>): WidgetInput[] {
  const inputs = node["inputs"];
  if (!Array.isArray(inputs)) return [];
  const found: WidgetInput[] = [];
  for (const entry of inputs) {
    const input = asRecord(entry);
    if (input === undefined || asRecord(input["widget"]) === undefined) continue;
    const name = input["name"];
    if (typeof name !== "string") continue;
    const link = input["link"];
    found.push({ name, link: typeof link === "number" ? link : null });
  }
  return found;
}

type InputStatus =
  | { kind: "effective" }
  | { kind: "decoy"; originId: number };

/** Effective (no link, or a link from the subgraph boundary) or a decoy (a link from a real node). */
function classifyInput(input: WidgetInput, links: Map<number, number>): InputStatus {
  if (input.link === null) return { kind: "effective" };
  const originId = links.get(input.link);
  // Unresolvable — a link id `links` has no entry for — is treated the same
  // safe direction as an unrecognised negative origin: this function must
  // never manufacture a decoy label from data it could not actually read.
  if (originId === undefined || isBoundaryOrigin(originId)) return { kind: "effective" };
  return { kind: "decoy", originId };
}

/**
 * Addresses on `origin` whose own widget is authoritative — found by
 * classifying `origin`'s own widget inputs against the SAME scope's `links`,
 * exactly once. Deliberately not recursive: chasing a decoy's decoy back to
 * whatever eventually IS authoritative is an unbounded graph walk for a
 * feature that exists to answer one question ("what do I set instead") with
 * one hop's worth of evidence. Where that hop lands on another decoy, this
 * returns no candidates rather than a wrong one, and the caller still has the
 * upstream node's identity to keep tracing by hand.
 */
function cleanCandidatesOf(
  origin: Record<string, unknown>,
  originId: string,
  prefix: string,
  links: Map<number, number>,
): string[] {
  const candidates: string[] = [];
  for (const input of widgetInputsOf(origin)) {
    if (classifyInput(input, links).kind === "decoy") continue;
    candidates.push(`${prefix}${originId}.${input.name}`);
  }
  return candidates;
}

/** One subgraph definition, indexed and normalised for {@link analyseScope}. */
interface SubgraphDef {
  nodes: Record<string, unknown>[];
  links: Map<number, number>;
}

/** `definitions.subgraphs`, keyed by the subgraph's own `id` — the string a referencing node's `type` carries. */
function indexSubgraphs(root: Record<string, unknown>): Map<string, SubgraphDef> {
  const index = new Map<string, SubgraphDef>();
  const definitions = asRecord(root["definitions"]);
  const subgraphs = definitions?.["subgraphs"];
  if (!Array.isArray(subgraphs)) return index;
  for (const entry of subgraphs) {
    const subgraph = asRecord(entry);
    if (subgraph === undefined) continue;
    const id = subgraph["id"];
    if (typeof id !== "string") continue;
    const rawNodes = subgraph["nodes"];
    const nodes = Array.isArray(rawNodes) ? rawNodes.filter(isNodeRecord) : [];
    index.set(id, { nodes, links: linkOriginsOf(subgraph["links"]) });
  }
  return index;
}

/**
 * Walk one scope — the top-level graph, or one subgraph's interior — and
 * record every decoy address found in it. Recurses into any node that is
 * itself an instance of a known subgraph (`node.type` matching a subgraph's
 * own `id`), prefixing that subgraph's addresses with `<node id>/`, which is
 * what produces `52/6.text` from top-level node `52` and inner node `6`, or a
 * longer slash-joined path for deeper nesting.
 *
 * A decoy's upstream candidate is always resolved against `nodesById`/`links`
 * from THIS SAME call — a link can only ever connect two nodes in the same
 * scope (the boundary sentinel is the one exception, and it is not a real
 * node to look up at all) — so no cross-scope bookkeeping is needed.
 */
function analyseScope(
  nodes: readonly Record<string, unknown>[],
  links: Map<number, number>,
  prefix: string,
  subgraphsByType: Map<string, SubgraphDef>,
  results: Map<string, InertInput>,
): void {
  const nodesById = new Map<string, Record<string, unknown>>();
  for (const node of nodes) {
    const id = idOf(node);
    if (id !== undefined) nodesById.set(id, node);
  }

  for (const node of nodes) {
    const id = idOf(node);
    if (id === undefined) continue;
    const subgraph = subgraphsByType.get(typeOf(node));
    if (subgraph !== undefined) {
      analyseScope(subgraph.nodes, subgraph.links, `${prefix}${id}/`, subgraphsByType, results);
    }
  }

  for (const node of nodes) {
    const id = idOf(node);
    if (id === undefined) continue;
    for (const input of widgetInputsOf(node)) {
      const status = classifyInput(input, links);
      if (status.kind !== "decoy") continue;

      const address = `${prefix}${id}.${input.name}`;
      const originNode = nodesById.get(String(status.originId));
      results.set(address, {
        address,
        upstream:
          originNode === undefined
            ? null
            : {
                node_id: String(status.originId),
                node_type: typeOf(originNode),
                candidate_addresses: cleanCandidatesOf(originNode, String(status.originId), prefix, links),
              },
      });
    }
  }
}

/**
 * Every decoy address in a parsed workflow graph, keyed by address exactly as
 * `comfy workflow slots` reports it.
 *
 * Pure and total: given any object, including one with no `nodes`,
 * `definitions` or either, this returns an empty map rather than throwing.
 * The graph is not modified or copied beyond the small per-scope index this
 * needs.
 */
export function inertInputsOf(graph: Record<string, unknown>): Map<string, InertInput> {
  const results = new Map<string, InertInput>();
  const rawNodes = graph["nodes"];
  const topNodes = Array.isArray(rawNodes) ? rawNodes.filter(isNodeRecord) : [];
  analyseScope(topNodes, linkOriginsOf(graph["links"]), "", indexSubgraphs(graph), results);
  return results;
}

/**
 * {@link inertInputsOf}, reading and parsing the workflow file itself.
 *
 * Independent of {@link discoverWorkflows}: `describe_workflow` and
 * `run_workflow` both accept an absolute path outside every configured root
 * (see `resolveWorkflow` in `tools.ts`), where no listing exists to consult,
 * and this has to work for that case too.
 *
 * Never throws. A file this cannot read or parse yields an empty map rather
 * than a decoy list — this function only ever ADDS a refusal reason to
 * `run_workflow`; the very next step (`comfy workflow set-slot`) reads the
 * same file and is what actually diagnoses a missing or corrupt one.
 */
export async function inertInputsOfFile(path: string): Promise<Map<string, InertInput>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return new Map();
  }
  return inertInputsOfText(text);
}

/**
 * {@link inertInputsOf} over a workflow's text, for a graph that never became a
 * file on this machine — one fetched from a remote instance's own library.
 *
 * The `JSON.parse` here is **not** landmine #1. That landmine is about parsing
 * a graph and then writing it back out, which rounds every integer above 2^53
 * on the way through; this reads the link topology and throws the parsed object
 * away. The bytes that reach `comfy` are the bytes that arrived, untouched —
 * see `workflows/setSlots.ts`'s `contents`.
 *
 * Never throws, on the same terms as {@link inertInputsOfFile}: this only ever
 * ADDS a refusal reason, and the CLI call right after it is what diagnoses a
 * graph that is not one.
 */
export function inertInputsOfText(text: string): Map<string, InertInput> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return new Map();
  }
  const graph = asRecord(value);
  return graph === undefined ? new Map() : inertInputsOf(graph);
}
