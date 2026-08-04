import type { NodeSchema, ObjectInfo } from "../comfy/objectInfo.ts";
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

/** Why a slot could not be joined against `/object_info`. */
export type UnresolvedReason =
  /** No such node type. Almost always a custom node this instance lacks. */
  | "unknown_node_type"
  /** The node exists but declares no input by that name, in either map. */
  | "unknown_input"
  /** The input exists but its spec is not the `[type, config?]` tuple. */
  | "unreadable_spec";

/** A slot that still has a schema entry, but an unconstrained one. */
export interface UnresolvedSlot {
  address: string;
  name: string;
  node_type: string;
  reason: UnresolvedReason;
}

/**
 * The schema, and the slots it could not constrain.
 *
 * The two are siblings rather than one nested in the other because they have
 * different audiences. `schema` goes to an MCP client as-is (Task 5), so it has
 * to be a standalone JSON Schema document with nothing bolted onto it — an
 * `x-unresolved` key inside it would travel into every tool listing and mean
 * nothing to the validator that reads it. `unresolved` is for the operator, who
 * is the only one who can install the missing custom node, and who otherwise
 * has no way to distinguish "this input takes anything" from "this server could
 * not find out what this input takes".
 */
export interface WorkflowDescription {
  schema: WorkflowInputSchema;
  unresolved: UnresolvedSlot[];
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

/** The spec for one input, or `undefined` if the name is in neither map. */
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
 * ComfyUI install with no LoRAs reports exactly that.
 *
 * The type position is carried verbatim; `options` is taken only when every
 * member is a scalar, because `COMFY_DYNAMICCOMBO_V3` puts `{key, inputs}`
 * objects there and those describe a widget, not a set of values.
 */
function enumValues(type: unknown, config: Config): unknown[] | undefined {
  if (Array.isArray(type)) return type.length > 0 ? [...type] : undefined;

  const options = config["options"];
  if (Array.isArray(options) && options.length > 0 && options.every(isScalar)) return [...options];
  return undefined;
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
 * modulo rule that other validators use instead. Beyond the arithmetic, ComfyUI
 * validates `min` and `max` server-side but never `step`, so on a `FLOAT` the
 * step is a UI increment and 29.97 fps is a value the backend accepts —
 * `multipleOf: 1` there would be this server inventing a rejection.
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

/** The unconstrained answer: everything that can be said from the slot alone. */
function fromSlotAlone(slot: Slot): InputSchema {
  const schema: InputSchema = {};
  const type = bareType(slot);
  if (type !== undefined) schema.type = type;
  if (slot.current_value !== null) schema.default = slot.current_value;
  return schema;
}

function fromSpec(slot: Slot, type: unknown, config: Config): InputSchema {
  const schema: InputSchema = {};

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
  if (minimum !== undefined) schema.minimum = minimum;
  const maximum = bound(config, "max", schema.type);
  if (maximum !== undefined) schema.maximum = maximum;

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
  const node = objectInfo[slot.node_type];
  // Custom nodes are normal, and an instance that has since dropped one is
  // normal too. Neither may cost the caller the other 209 slots.
  if (node === undefined) return { schema: fromSlotAlone(slot), reason: "unknown_node_type" };

  const found = findInputSpec(node, slot.name);
  if (found === undefined) return { schema: fromSlotAlone(slot), reason: "unknown_input" };

  const tuple = readTuple(found.spec);
  if (tuple === undefined) return { schema: fromSlotAlone(slot), reason: "unreadable_spec" };

  return { schema: fromSpec(slot, tuple.type, tuple.config) };
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
 */
export function describeSlots(slots: Slot[], objectInfo: ObjectInfo): WorkflowDescription {
  const properties: Record<string, InputSchema> = {};
  const unresolved: UnresolvedSlot[] = [];

  for (const slot of slots) {
    const { schema, reason } = describeSlot(slot, objectInfo);
    // Addresses are unique within a listing — they are the keys `set-slot`
    // takes, so the CLI could not accept a duplicate either.
    properties[slot.address] = schema;
    if (reason !== undefined) {
      unresolved.push({
        address: slot.address,
        name: slot.name,
        node_type: slot.node_type,
        reason,
      });
    }
  }

  return { schema: { type: "object", properties, additionalProperties: false }, unresolved };
}
