import type { NodeSchema, ObjectInfo } from "../comfy/objectInfo.ts";
import type { InertInput, InertUpstream } from "./discover.ts";
import type { Slot } from "./slots.ts";

/**
 * The join this whole server exists for.
 *
 * `comfy workflow slots` reports a slot's type and current value but never its
 * allowed values or its bounds (landmine #6), and a bare `COMBO` is useless to a
 * model: it cannot know that `sampler_name` takes `euler` and not `Euler`.
 * ComfyUI's `/object_info` has that information and nothing upstream joins the
 * two. This module does, and turns the result into JSON Schema so an MCP client
 * can validate a call before it costs a GPU minute.
 *
 * It is a pure function over data someone else already fetched. It never
 * spawns, fetches or reads a file, so the caller keeps every decision about
 * caching, offline operation and staleness.
 *
 * ## What it will not say
 *
 * Every rule here is one-sided in the same direction: a constraint is emitted
 * only when the node's own metadata proves it holds, and dropped otherwise.
 * A missing `maximum` costs a caller nothing — the server still runs, and
 * ComfyUI still validates. A *wrong* `maximum` costs the caller the one thing
 * this schema is for, because it makes a legal call look illegal and the model
 * has no way to tell that the schema is the thing that is wrong.
 *
 * `default` is the exception, and deliberately: JSON Schema calls it an
 * annotation rather than a constraint, and it is the only channel through which
 * a caller learns what the workflow currently holds.
 */

/** The JSON Schema types a ComfyUI widget value can take. */
export type JsonSchemaType = "integer" | "number" | "string" | "boolean";

/** One settable input, as JSON Schema. Absent keywords are unknown, not false. */
export interface InputSchema {
  /**
   * `<node_type>.<name>`, so a property body says what it describes without
   * being joined back to its key. Measured on the 210-slot capture: only 18
   * properties carry a `description`, and the bodies collapse to 45 distinct
   * shapes — `140/67.length` through `144/67.length` are byte-identical, as are
   * the high-noise and low-noise UNET loaders. The key alone is a
   * subgraph-qualified id that appears nowhere else in the document, so a model
   * asked to change "the second sampler" has nothing to join against.
   */
  title?: string;
  type?: JsonSchemaType;
  /**
   * Carried from `/object_info` verbatim. Typed as `unknown[]` because the
   * values are the node's to choose — filenames, sampler names, occasionally
   * numbers — and narrowing them here would mean dropping whatever did not fit.
   */
  enum?: unknown[];
  description?: string;
  minimum?: number;
  maximum?: number;
  multipleOf?: number;
  default?: unknown;
}

/**
 * The settable inputs of one workflow, keyed by slot address.
 *
 * `additionalProperties: false` is load-bearing: `comfy workflow set-slot`
 * ignores an address it does not recognise, so without it a typo like `3.step`
 * would run the workflow unmodified and report success. Rejecting it at the
 * schema turns a silent wrong result into an error the caller can fix.
 *
 * There is no `required` array. Every input already has a value in the workflow
 * file, so supplying one is always an override and never an obligation.
 */
export interface WorkflowInputSchema {
  type: "object";
  properties: Record<string, InputSchema>;
  additionalProperties: false;
}

/**
 * Why a slot's constraints could not be recovered.
 *
 * The first three are join failures. The fourth is not: the join succeeded and
 * produced nothing usable, which widens this list from "the join failed" to
 * "the join produced no allowed values" — deliberately, because both leave the
 * caller in the same place and both are things the operator can fix.
 */
export type UnresolvedReason =
  /** No such node type, or an entry that is not a node. Usually a custom node. */
  | "unknown_node_type"
  /** The node exists but declares no input by that name, in either map. */
  | "unknown_input"
  /** The input exists but its spec is not the `[type, config?]` tuple. */
  | "unreadable_spec"
  /**
   * A `COMBO` that resolved to no allowed values — an empty list, or options
   * that are widget descriptors rather than values (`SaveVideo.codec`). A COMBO
   * is the one widget type that promises a list, and a caller who does not get
   * one guesses `Euler` for `euler`. The operator's fix is usually to install
   * the models the list would have been drawn from.
   */
  | "no_values";

/** A slot that still has a schema entry, but an unconstrained one. */
export interface UnresolvedSlot {
  address: string;
  name: string;
  node_type: string;
  reason: UnresolvedReason;
}

/**
 * A slot whose stored value is a decoy: ComfyUI's own graph execution
 * overrides it from a link to another node, so nothing `run_workflow` writes
 * there is ever read. See `discover.ts`'s `inertInputsOf` for the rule and
 * the measured example this exists to fix — a benchmark request for "black
 * metal, 60 seconds" against `audio_stable_audio_3_medium.json` that produced
 * 150 seconds of stock tropical house, because the two addresses set were
 * exactly this kind of decoy.
 */
export interface InertSlot {
  address: string;
  name: string;
  node_type: string;
  /** What actually supplies the value instead, when this server could identify it one hop upstream. */
  upstream: InertUpstream | null;
}

/**
 * The schema, the slots it could not constrain, and the slots it refused to
 * offer at all.
 *
 * Three siblings rather than any of them nested, because they have three
 * different audiences and one document cannot serve all of them undecorated.
 * `schema` goes to an MCP client as-is, so it has to be a standalone JSON
 * Schema document with nothing bolted onto it — an `x-unresolved` or
 * `x-inert` key inside it would travel into every tool listing and mean
 * nothing to the validator that reads it. `unresolved` is for the operator,
 * who is the only one who can install a missing custom node, and who
 * otherwise has no way to distinguish "this input takes anything" from "this
 * server could not find out what this input takes". `inert` is for whoever
 * is about to call `run_workflow`: every address here would be silently
 * ignored if set, which is why none of them appear in `schema.properties` at
 * all — offering an address that does nothing is worse than not offering it,
 * matching the same reasoning that already puts `additionalProperties: false`
 * on the schema.
 */
export interface WorkflowDescription {
  schema: WorkflowInputSchema;
  unresolved: UnresolvedSlot[];
  inert: InertSlot[];
}

/**
 * The widget types with a JSON Schema equivalent. Anything else — `MODEL`,
 * `IMAGE`, a custom node's own widget type — is left without a `type` rather
 * than forced into one of these.
 */
const SCALAR_TYPES: Record<string, JsonSchemaType> = {
  INT: "integer",
  FLOAT: "number",
  STRING: "string",
  BOOLEAN: "boolean",
};

/**
 * ComfyUI splits a node's inputs across two maps and custom nodes commonly use
 * `optional`; those are exactly the slots whose `current_value` is `null`.
 * Searched in this order, which is also the order ComfyUI resolves them in.
 */
const INPUT_BUCKETS = ["required", "optional"] as const;

type Config = Record<string, unknown>;

function asRecord(value: unknown): Config | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Config;
}

/** What a slot value, an enum member and a `default` may all be. */
function isScalar(value: unknown): boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/**
 * The spec for one input, or `undefined` if the name is in neither map.
 *
 * The `{spec}` wrapper is load-bearing here, unlike the one on
 * {@link defaultValue}: an input declared as a literal `undefined` has to read
 * as present-but-unreadable, and a bare `unknown` return could not tell that
 * apart from "not declared".
 */
function findInputSpec(node: NodeSchema, name: string): { spec: unknown } | undefined {
  const input = asRecord(node["input"]);
  if (input === undefined) return undefined;
  for (const bucket of INPUT_BUCKETS) {
    const map = asRecord(input[bucket]);
    // `hasOwn` rather than a truthiness test: an input legitimately declared as
    // `null` is unreadable, which is a different answer from "not declared".
    if (map !== undefined && Object.hasOwn(map, name)) return { spec: map[name] };
  }
  return undefined;
}

/**
 * `[type, config]`, where the tuple may be length 1 — plenty of inputs carry no
 * config at all — and `type` is either a type name or the array of allowed
 * values that *is* the COMBO's enum.
 */
function readTuple(spec: unknown): { type: unknown; config: Config } | undefined {
  if (!Array.isArray(spec) || spec.length === 0) return undefined;
  return { type: spec[0], config: asRecord(spec[1]) ?? {} };
}

/**
 * The allowed values, from either shape ComfyUI emits: the classic array in the
 * type position, or the V3 form `["COMBO", {options: [...]}]` that newer nodes
 * such as `SaveVideo.format` use.
 *
 * An empty list is treated as no list. `enum: []` rejects every value including
 * the one the workflow already holds, and an empty combo is a routine state — a
 * ComfyUI install with no LoRAs reports exactly that. Either way the slot is
 * reported as {@link UnresolvedReason} `no_values` rather than passing for
 * unconstrained.
 *
 * Both shapes are filtered to scalars, and identically. `COMFY_DYNAMICCOMBO_V3`
 * puts `{key, inputs}` objects under `options`, and an object is not something
 * `set-slot` could carry on a command line from either position — listing one
 * would offer the caller a value it cannot send.
 */
function scalarValues(candidates: unknown[]): unknown[] | undefined {
  // `filter` also copies, which matters: one `/object_info` describes every
  // workflow on the instance, and an emitted enum that aliased it would let a
  // caller's edit corrupt the next description.
  const values = candidates.filter(isScalar);
  return values.length > 0 ? values : undefined;
}

function enumValues(type: unknown, config: Config): unknown[] | undefined {
  if (Array.isArray(type)) return scalarValues(type);

  const options = config["options"];
  return Array.isArray(options) ? scalarValues(options) : undefined;
}

/**
 * The type to fall back on when `/object_info` cannot supply one — an uninstalled
 * custom node, or a widget type this mapping does not know.
 *
 * A bare `COMBO` says nothing on its own, so the stored value is the only
 * evidence left. It is good evidence: it is what the workflow runs with today
 * and what `set-slot` will round-trip. Numbers degrade to `number` rather than
 * `integer` — a custom float widget holding `1.0` is indistinguishable from an
 * integer one here, and `number` accepts both.
 */
function bareType(slot: Slot): JsonSchemaType | undefined {
  const declared = SCALAR_TYPES[slot.type];
  if (declared !== undefined) return declared;

  switch (typeof slot.current_value) {
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    case "number":
      return "number";
    default:
      return undefined;
  }
}

/**
 * Integers past 2^53 do not survive JSON. `KSampler.seed` declares
 * `max: 18446744073709551615`, and by the time any of it reaches this server it
 * has already been rounded to 18446744073709552000 — a number that is both
 * larger than the true bound and not itself a legal seed.
 *
 * Of the three options — emit it, drop it, or clamp it — clamping to
 * `Number.MAX_SAFE_INTEGER` is the only one that leaves the schema *true*.
 * Emitting the mangled figure advertises a maximum that is wrong in both
 * directions: it names a value ComfyUI would reject, and every integer a caller
 * could pick above 2^53 is silently a different integer by the time `set-slot`
 * sees it (landmine #11). Dropping the bound throws away the useful half of the
 * fact, and leaves a caller unable to tell a bounded input from an unbounded
 * one. Clamping narrows the advertised range to exactly the values that survive
 * every hop of this system, so anything the schema admits is a value the caller
 * will actually get. The cost is real but small: seeds above 2^53 become
 * unreachable through this server, and one arbitrary nonce out of 9 quadrillion
 * is as good as another.
 *
 * Applied to integer bounds only. A `FLOAT` maximum of `sys.float_info.max` is
 * an ordinary f64 that round-trips exactly, and clamping it would delete most
 * of a legitimate range.
 */
function clampIntegerBound(value: number): number {
  if (value > Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
  if (value < Number.MIN_SAFE_INTEGER) return Number.MIN_SAFE_INTEGER;
  return value;
}

function bound(config: Config, key: "min" | "max", type: JsonSchemaType | undefined): number | undefined {
  const value = config[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return type === "integer" ? clampIntegerBound(value) : value;
}

/**
 * `step` as `multipleOf`, in the narrow case where the two mean the same thing.
 *
 * They usually do not. ComfyUI's `step` is the increment its spinner walks from
 * `min`, while `multipleOf` is divisibility by zero — so an input like
 * `WanFirstLastFrameToVideo.length` (min 1, step 4, default 81) has legal values
 * 1, 5, 9, … which no `multipleOf` describes, and `multipleOf: 4` would reject
 * the node's own default. Requiring every anchor the node declares to sit on the
 * grid is what rules that out.
 *
 * Float steps are dropped outright. `KSampler.cfg` declares `step: 0.1`, and
 * 0.1 has no exact binary representation: 149 of cfg's own legal values fail
 * JSON Schema's division rule under f64, and its default of 8.0 fails the
 * modulo rule that other validators use instead.
 *
 * The asymmetry between `INT` and `FLOAT` is not merely that ComfyUI validates
 * `min` and `max` server-side but never `step` — that argues equally against
 * both. It is that an off-grid *integer* is silently **rounded**:
 * `EmptyLatentImage` floors to the 8-pixel latent grid, so `width: 740` renders
 * 736 and nothing says so. On an integer, `multipleOf` warns the caller that a
 * value will be adjusted underneath them, which is precisely what this schema
 * exists to prevent. A `FLOAT` has no such grid — `fps: 29.97` is used exactly
 * — so `multipleOf: 1` there would be this server inventing a rejection.
 *
 * A step of 1 on an integer is dropped as vacuous: it is true of every integer,
 * and a keyword that excludes nothing is noise in a prompt.
 */
function multipleOf(config: Config, type: JsonSchemaType | undefined): number | undefined {
  if (type !== "integer") return undefined;

  const step = config["step"];
  if (typeof step !== "number" || !Number.isSafeInteger(step) || step <= 1) return undefined;

  for (const key of ["min", "max", "default"]) {
    const anchor = config[key];
    if (anchor === undefined) continue;
    if (typeof anchor !== "number" || !Number.isSafeInteger(anchor)) return undefined;
    if (anchor % step !== 0) return undefined;
  }
  return step;
}

/**
 * What this input takes if the caller says nothing.
 *
 * The workflow's `current_value` wins. `/object_info`'s `default` is the
 * fallback, used only where the widget is unset.
 *
 * **Do not flip this back on the reasoning that `/object_info` is more
 * authoritative.** It is authoritative about the *node*; the workflow is
 * authoritative about the *run*, and `default` documents the run. A caller who
 * sets nothing gets the workflow's value, so those are the only values this
 * keyword may name. Four of `default_image_gen`'s thirteen slots disagree, and
 * `5.width` shows the damage: the node ships 512 and the workflow holds 736.
 * Advertising 512 would tell a model the workflow renders square when it
 * renders 736x1024 — and worse, a model trying to *preserve* current behaviour
 * would read 512, pass it explicitly, and silently change the output. A schema
 * that misleads a caller into breaking the thing they were trying to keep is
 * worse than one that says nothing.
 *
 * The fallback direction is not the mirror image. A `null` `current_value` means
 * the widget is unset — `CreateVideo.bit_depth` is the case in the captures —
 * and an unset widget is precisely where the node's own default *is* the
 * operative value, because nothing overrides it.
 *
 * `null` is never emitted: `default: null` would tell a caller that null is a
 * legal value for an integer input. Non-scalar defaults are skipped for the same
 * reason — a slot value has to be something `set-slot` can carry on a command
 * line.
 *
 * A default may disagree with the schema around it. 37 of the 210 slots in the
 * `6key` capture hold a model file that is not in the enum, because the workflow
 * was authored on a machine with different models installed. It is kept anyway,
 * and the precedence above only sharpens that: `default` is an annotation rather
 * than a constraint, and the workflow's stored model is precisely what a
 * no-input run will try to load, missing or not. Hiding it would leave the
 * caller unable to see why the run is about to fail.
 */
// The `{value}` wrapper is only for readability — `undefined` is not a value
// this can return, so a bare `unknown` would do. Contrast `findInputSpec`,
// where the wrapper carries information a bare return could not.
function defaultValue(config: Config, slot: Slot): { value: unknown } | undefined {
  if (slot.current_value !== null) return { value: slot.current_value };
  const declared = config["default"];
  if (isScalar(declared)) return { value: declared };
  return undefined;
}

function description(config: Config): string | undefined {
  const tooltip = config["tooltip"];
  return typeof tooltip === "string" && tooltip.length > 0 ? tooltip : undefined;
}

/**
 * The unconstrained answer: everything that can be said from the slot alone.
 *
 * Expressed as the degenerate case of {@link fromSpec} rather than restated,
 * because it is exactly that — a spec with no type and no config leaves every
 * config-driven rule a no-op and falls through to the slot. Restating it would
 * mean maintaining the `default` and `title` rules in two places, and the two
 * would drift the first time either changed.
 */
function fromSlotAlone(slot: Slot): InputSchema {
  return fromSpec(slot, undefined, {});
}

function fromSpec(slot: Slot, type: unknown, config: Config): InputSchema {
  // Named before anything else: a body a reader cannot attribute to a node is
  // a body they cannot act on, and 210 of these arrive at once.
  const schema: InputSchema = { title: `${slot.node_type}.${slot.name}` };

  const values = enumValues(type, config);
  if (values !== undefined) {
    // An enum is a stronger statement than a type, and every member of it
    // already carries its own.
    schema.enum = values;
  } else {
    // `type` may name something with no JSON Schema equivalent — `MODEL` on a
    // node whose widget was converted to a link, or a custom widget type — in
    // which case the slot's own type is the better witness.
    const declared = typeof type === "string" ? SCALAR_TYPES[type] : undefined;
    const resolved = declared ?? bareType(slot);
    if (resolved !== undefined) schema.type = resolved;
  }

  const text = description(config);
  if (text !== undefined) schema.description = text;

  const minimum = bound(config, "min", schema.type);
  const maximum = bound(config, "max", schema.type);
  // A node declaring min > max has proved one of the two wrong without saying
  // which, so neither is proven. Emitting both would produce a schema no value
  // satisfies — including the value the workflow already runs with, which is
  // the one thing this document must never call illegal.
  if (minimum === undefined || maximum === undefined || minimum <= maximum) {
    if (minimum !== undefined) schema.minimum = minimum;
    if (maximum !== undefined) schema.maximum = maximum;
  }

  const step = multipleOf(config, schema.type);
  if (step !== undefined) schema.multipleOf = step;

  const fallback = defaultValue(config, slot);
  if (fallback !== undefined) schema.default = fallback.value;

  return schema;
}

/** One slot's schema, plus why it is unconstrained when it is. */
function describeSlot(
  slot: Slot,
  objectInfo: ObjectInfo,
): { schema: InputSchema; reason?: UnresolvedReason } {
  // `asRecord`, not `!== undefined`: an entry that is null, a string or an array
  // is not a node definition, and letting one through both breaks the never-throw
  // contract (`null["input"]`) and misreports the *input* name when the node
  // definition is what is broken.
  const node = asRecord(objectInfo[slot.node_type]);
  // Custom nodes are normal, and an instance that has since dropped one is
  // normal too. Neither may cost the caller the other 209 slots.
  if (node === undefined) return { schema: fromSlotAlone(slot), reason: "unknown_node_type" };

  const found = findInputSpec(node, slot.name);
  if (found === undefined) return { schema: fromSlotAlone(slot), reason: "unknown_input" };

  const tuple = readTuple(found.spec);
  if (tuple === undefined) return { schema: fromSlotAlone(slot), reason: "unreadable_spec" };

  const schema = fromSpec(slot, tuple.type, tuple.config);
  // A resolved COMBO with nothing to choose from is no more usable than an
  // unresolved one, and the operator can act on it. Ranked below the join
  // failures above because their fixes differ: install the node, not the models.
  if (slot.type === "COMBO" && schema.enum === undefined) return { schema, reason: "no_values" };

  return { schema };
}

/**
 * Describe a workflow's settable inputs as JSON Schema.
 *
 * Total: every slot gets an entry, and a slot that cannot be joined against
 * `/object_info` degrades to what its own listing says rather than throwing or
 * being dropped. Nothing here is fatal, because the alternative is that one
 * uninstalled custom node makes a 210-slot workflow undescribable.
 *
 * @param slots  from `listSlots`, in the order the CLI reported them.
 * @param objectInfo  from `getObjectInfo`, for the same instance the slots came
 * from. Passing `{}` is legal and yields the fully degraded description.
 * @param inertInputs  from `discover.ts`'s `inertInputsOf`/`inertInputsOfFile`,
 * keyed by address exactly as `slots` carries them. A slot found here is
 * reported under {@link WorkflowDescription.inert} instead of
 * `schema.properties`, and never reaches {@link describeSlot} at all — a
 * decoy's own bounds and enum are true facts about the node, but stating them
 * would still invite a caller to set a value nothing reads. Omitted or empty
 * behaves exactly as this function did before decoy detection existed.
 */
/**
 * How far {@link resolveCandidates} will chase a decoy chain.
 *
 * `discover.ts` stops at one hop deliberately, and for the data it has that is
 * the only honest answer — it can only see a widget that the graph has
 * *converted to an input*, so a clean widget one hop away is often invisible to
 * it and a second hop would compound a guess. Here the CLI's own listing names
 * every settable address, so a hop lands on evidence rather than on inference.
 *
 * Four rather than unbounded: measured chains in real workflows are one or two
 * hops (a switch bank fed by one boolean is the deepest seen), and a bound is
 * what keeps a malformed or hostile listing from walking forever. The `seen`
 * set already stops a cycle; this stops a long chain that is not a cycle.
 */
const MAX_CANDIDATE_HOPS = 4;

/**
 * The address(es) a caller should set instead of a decoy, found in the CLI's own
 * slot listing rather than in the graph.
 *
 * Breadth-first from the decoy's upstream node, taking the first hop that yields
 * any address the listing offers and this description has not itself called
 * inert. Returning every clean address on that node rather than picking one is
 * deliberate: `PrimitiveInt` has a single `value` and the choice is obvious, but
 * a multi-widget upstream genuinely offers several and this module has no basis
 * for preferring one — naming them all is honest where guessing would not be.
 *
 * **Scope is part of a node's identity.** A slot's `instance_id` carries the
 * whole path (`129/162`), while a decoy's upstream is a bare local id (`162`),
 * so the id is resolved against the decoy's own scope. Two subgraphs each
 * holding a node `162` are two different nodes, and offering the wrong one would
 * be worse than offering none — it would look right.
 *
 * Returns an empty array rather than inventing anything when the chain runs out,
 * exceeds {@link MAX_CANDIDATE_HOPS}, or leaves the listing entirely.
 */
function resolveCandidates(
  decoy: Slot,
  upstream: InertUpstream,
  byInstance: ReadonlyMap<string, Slot[]>,
  inertInputs: ReadonlyMap<string, InertInput>,
): string[] {
  // Everything up to and including the last `/`, or "" for a top-level node.
  const scope = decoy.instance_id.slice(0, decoy.instance_id.lastIndexOf("/") + 1);
  const visited = new Set<string>();
  let frontier = [upstream.node_id];

  for (let hop = 0; hop < MAX_CANDIDATE_HOPS && frontier.length > 0; hop++) {
    const clean: string[] = [];
    const next: string[] = [];

    for (const nodeId of frontier) {
      const instance = `${scope}${nodeId}`;
      if (visited.has(instance)) continue;
      visited.add(instance);

      for (const candidate of byInstance.get(instance) ?? []) {
        const decoyed = inertInputs.get(candidate.address);
        if (decoyed === undefined) {
          clean.push(candidate.address);
          continue;
        }
        // Another decoy: its own upstream is the next place to look.
        if (decoyed.upstream !== null) next.push(decoyed.upstream.node_id);
      }
    }

    if (clean.length > 0) return clean;
    frontier = next;
  }

  return [];
}

export function describeSlots(
  slots: Slot[],
  objectInfo: ObjectInfo,
  inertInputs: ReadonlyMap<string, InertInput> = new Map(),
): WorkflowDescription {
  // Built once, not per decoy: a 210-slot listing with a dozen decoys would
  // otherwise rescan the whole array a dozen times.
  const byInstance = new Map<string, Slot[]>();
  for (const slot of slots) {
    const group = byInstance.get(slot.instance_id);
    if (group === undefined) byInstance.set(slot.instance_id, [slot]);
    else group.push(slot);
  }

  // A Map, then `Object.fromEntries`: assigning `properties[slot.address]` sets
  // the prototype rather than an own property when the address is `__proto__`,
  // which would leave `Object.keys` empty and the serialised `properties` `{}`
  // while `unresolved` still described an entry that was not there.
  const properties = new Map<string, InputSchema>();
  const unresolved: UnresolvedSlot[] = [];
  const inert: InertSlot[] = [];
  // Every address already accounted for, across BOTH outputs — a slot decided
  // to be a decoy must never also be visited for `properties`/`unresolved`,
  // and a duplicate of either kind must still resolve only once.
  const seen = new Set<string>();

  for (const slot of slots) {
    // Addresses are unique within a listing — they are the keys `set-slot`
    // takes, so the CLI could not accept a duplicate either. If one arrives
    // anyway, the first wins for every output; last-wins on `properties` while
    // `unresolved`/`inert` collected every slot would let them disagree about
    // what the document contains.
    if (seen.has(slot.address)) continue;
    seen.add(slot.address);

    const decoy = inertInputs.get(slot.address);
    if (decoy !== undefined) {
      inert.push({
        address: slot.address,
        name: slot.name,
        node_type: slot.node_type,
        // `discover.ts`'s own candidates are replaced rather than merged. Its
        // list is a strict subset of what the listing can prove — it sees only
        // widgets the graph converted to inputs — and carrying both would mean
        // publishing two answers to one question with no rule for which wins.
        // Its version remains the right answer for `run_workflow`, which
        // refuses a decoy without ever holding a listing.
        upstream: decoy.upstream === null ? null : {
          ...decoy.upstream,
          candidate_addresses: resolveCandidates(slot, decoy.upstream, byInstance, inertInputs),
        },
      });
      continue;
    }

    const { schema, reason } = describeSlot(slot, objectInfo);
    properties.set(slot.address, schema);
    if (reason !== undefined) {
      unresolved.push({
        address: slot.address,
        name: slot.name,
        node_type: slot.node_type,
        reason,
      });
    }
  }

  return {
    schema: {
      type: "object",
      properties: Object.fromEntries(properties),
      additionalProperties: false,
    },
    unresolved,
    inert,
  };
}
