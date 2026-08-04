import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ObjectInfo } from "../src/comfy/objectInfo";
import type { Slot } from "../src/workflows/slots";
import { describeSlots, type InputSchema, type WorkflowDescription } from "../src/workflows/describe";

/**
 * Every fixture here is a real capture from ComfyUI 0.29.0, not a hand-written
 * approximation: the join this module performs is the server's whole value-add,
 * and a synthetic `object_info` would only ever prove that the code agrees with
 * the author's memory of the format.
 */
function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(import.meta.dir, "fixtures", name), "utf8")) as T;
}

const objectInfo = fixture<ObjectInfo>("object_info.sample.json");

interface SlotsPayload {
  slots: Slot[];
}

/** 13 slots, a plain text-to-image graph. */
const imageGen = fixture<SlotsPayload>("slots.default_image_gen.json").slots;
/** 210 slots over 11 node types, 97 of them COMBO. A real 122KB video workflow. */
const sixKey = fixture<SlotsPayload>("slots.6key.json").slots;

/**
 * The raw `[type, config?]` tuple as the capture holds it, so a test can assert
 * against what ComfyUI actually said rather than against a copy of it.
 */
function declaredSpec(nodeType: string, name: string): [unknown, Record<string, unknown>?] {
  const node = objectInfo[nodeType] as {
    input: { required: Record<string, [unknown, Record<string, unknown>?]> };
  };
  const spec = node.input.required[name];
  if (spec === undefined) throw new Error(`the fixture declares no ${nodeType}.${name}`);
  return spec;
}

/** A slot for a node this instance has never heard of. */
function customSlot(over: Partial<Slot> = {}): Slot {
  return {
    address: "99.foo",
    name: "foo",
    type: "STRING",
    current_value: "bar",
    instance_id: "99",
    node_type: "SomeCustomNode",
    ...over,
  };
}

/** The schema for one address, failing loudly rather than yielding `undefined`. */
function propertyAt(described: WorkflowDescription, address: string): InputSchema {
  const schema = described.schema.properties[address];
  if (schema === undefined) {
    throw new Error(`no schema was produced for ${address}`);
  }
  return schema;
}

function describeAt(slots: Slot[], address: string): InputSchema {
  return propertyAt(describeSlots(slots, objectInfo), address);
}

/**
 * Would `multipleOf` reject `value`?
 *
 * JSON Schema defines the check as division — `value / multipleOf` must be an
 * integer — but real validators are split between that and a modulo test, and
 * for a step that has no exact binary representation the two disagree: `8 / 0.1`
 * is exactly `80`, while `8 % 0.1` is `0.09999999999999956`. A constraint this
 * server emits has to survive whichever one the client happens to run.
 */
function rejects(value: number, multipleOf: number): boolean {
  return !Number.isInteger(value / multipleOf) || value % multipleOf !== 0;
}

// ---------------------------------------------------------------------------
// The join itself
// ---------------------------------------------------------------------------

test("a COMBO becomes the enum of values object_info declares for it", () => {
  const samplerName = describeAt(imageGen, "3.sampler_name");

  expect(samplerName.enum).toContain("euler");
  expect(samplerName.enum).toContain("dpmpp_2m");
  expect(samplerName.enum).toHaveLength(44);
});

test("an enum carries object_info's values verbatim, in order", () => {
  const declared = declaredSpec("KSampler", "sampler_name")[0];

  expect(describeAt(imageGen, "3.sampler_name").enum).toEqual(declared as unknown[]);
});

test("an INT carries its bounds", () => {
  expect(describeAt(imageGen, "3.steps")).toMatchObject({
    type: "integer",
    minimum: 1,
    maximum: 10000,
  });
});

test("a FLOAT becomes a number, not an integer", () => {
  expect(describeAt(imageGen, "3.cfg").type).toBe("number");
});

test("a STRING becomes a string", () => {
  expect(describeAt(imageGen, "9.filename_prefix").type).toBe("string");
});

test("a tooltip becomes the description", () => {
  expect(describeAt(imageGen, "3.cfg").description).toContain("Classifier-Free Guidance");
});

test("bounds are dropped, not invented, when object_info declares none", () => {
  const text = describeAt(imageGen, "6.text");

  expect(text.type).toBe("string");
  expect(text).not.toHaveProperty("minimum");
  expect(text).not.toHaveProperty("maximum");
});

// ---------------------------------------------------------------------------
// step -> multipleOf, only where it is provably safe
// ---------------------------------------------------------------------------

test("cfg's step of 0.1 never yields a multipleOf that rejects its own default", () => {
  const cfg = describeAt(imageGen, "3.cfg");

  // 0.1 has no exact binary representation, so the grid it describes is not the
  // grid a validator computes: 149 of cfg's own legal values fail JSON Schema's
  // division rule, and the node's default of 8.0 fails the modulo rule.
  expect(cfg).not.toHaveProperty("multipleOf");
  expect(cfg.multipleOf === undefined || !rejects(8.0, cfg.multipleOf)).toBe(true);
});

test("an integer step that is anchored at zero becomes multipleOf", () => {
  // EmptyLatentImage.width: min 16, max 16384, step 8, default 512 — every
  // anchor is a multiple of 8, so the constraint is real and safe to state.
  expect(describeAt(imageGen, "5.width").multipleOf).toBe(8);
});

test("an integer step whose grid is offset from zero is dropped", () => {
  // WanFirstLastFrameToVideo.length: min 1, step 4, default 81. The legal values
  // are 1, 5, 9, ... 81 — a grid multipleOf cannot express, and multipleOf 4
  // would reject the node's own default.
  const length = describeAt(sixKey, "140/67.length");

  expect(length).not.toHaveProperty("multipleOf");
  expect(length).toMatchObject({ type: "integer", minimum: 1, maximum: 16384 });
});

test("a float step is dropped even when it looks whole", () => {
  // CreateVideo.fps is a FLOAT with step 1.0. ComfyUI validates min and max
  // server-side but never step, so 29.97 fps is accepted by the backend and
  // multipleOf 1 would be this server inventing a rejection of its own.
  const fps = describeAt(sixKey, "140/60.fps");

  expect(fps.type).toBe("number");
  expect(fps).not.toHaveProperty("multipleOf");
});

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

test("the workflow's current value wins over object_info's default", () => {
  // The workflow holds cfg 3.5; the node declares 8.0. A caller who sets
  // nothing gets 3.5, so 3.5 is what `default` has to say.
  expect(describeAt(imageGen, "3.cfg").default).toBe(3.5);
});

test("the default describes what the workflow renders, not what the node ships", () => {
  // The trap this pins: EmptyLatentImage declares 512x512, this workflow holds
  // 736x1024. Advertising 512 would tell a model the workflow renders square,
  // and a model trying to *preserve* current behaviour would read 512, pass it
  // explicitly, and silently change the output — the exact opposite of what
  // this schema exists for.
  expect(describeAt(imageGen, "5.width").default).toBe(736);
  expect(describeAt(imageGen, "5.height").default).toBe(1024);
});

test("a seed the workflow chose is not replaced by the node's zero", () => {
  expect(describeAt(imageGen, "3.seed").default).toBe(94109865029533);
});

test("a slot the node declares no default for still gets one", () => {
  // KSampler.sampler_name declares only a tooltip, so what the workflow author
  // chose is the only default there is.
  expect(describeAt(imageGen, "3.sampler_name").default).toBe("euler");
});

test("object_info's default fills in where the workflow leaves the widget unset", () => {
  // CreateVideo.bit_depth has current_value null, and this is the one direction
  // the node's own default is the operative value: nothing overrides it.
  expect(describeAt(sixKey, "140/60.bit_depth").default).toBe(8);
});

test("a null current value emits no default at all", () => {
  // CreateVideo.bit_depth is unset in this workflow. `default: null` would tell
  // a caller that null is a legal value for an integer input.
  const unset = customSlot({ node_type: "SomeCustomNode", current_value: null });

  expect(describeSlots([unset], {}).schema.properties["99.foo"]).not.toHaveProperty("default");
});

// ---------------------------------------------------------------------------
// Both input maps
// ---------------------------------------------------------------------------

test("an input declared only in input.optional resolves", () => {
  // CreateVideo declares bit_depth under `optional` — and an input found only
  // there is exactly the kind whose current_value is null.
  const described = describeSlots(sixKey, objectInfo);

  expect(propertyAt(described, "140/60.bit_depth")).toMatchObject({
    type: "integer",
    minimum: 8,
    maximum: 10,
    default: 8,
  });
  expect(described.unresolved).toHaveLength(0);
});

test("an optional COMBO resolves to its enum", () => {
  // CLIPLoader.device lives in `optional` too.
  expect(describeAt(sixKey, "140/38.device").enum).toEqual(["default", "cpu"]);
});

// ---------------------------------------------------------------------------
// Shapes object_info actually emits
// ---------------------------------------------------------------------------

test("a one-element spec with no config resolves", () => {
  // CLIPLoader.clip_name is `[[...names]]` — no config object at all.
  const clipName = describeAt(sixKey, "140/38.clip_name");

  expect(clipName.enum).toEqual([
    "qwen3.5_2b_bf16.safetensors",
    "qwen_2.5_vl_7b_fp8_scaled.safetensors",
    "qwen_3_4b.safetensors",
    "t5gemma_b_b_ul2.safetensors",
    "t5xxl_fp8_e4m3fn_scaled.safetensors",
  ]);
  // The workflow's own value is not among them — this capture came from an
  // instance where that model is not installed — and it is kept all the same.
  expect(clipName.default).toBe("umt5_xxl_fp8_e4m3fn_scaled.safetensors");
});

test("a V3 COMBO carrying its values under config.options resolves", () => {
  // SaveVideo.format is `["COMBO", {options: ["auto","mp4"], ...}]` — the values
  // are in the config, not in the type position.
  expect(describeAt(sixKey, "146.format")).toMatchObject({
    enum: ["auto", "mp4"],
    default: "auto",
  });
});

// ---------------------------------------------------------------------------
// Degradation
// ---------------------------------------------------------------------------

test("a node_type absent from object_info degrades to the slot's bare type", () => {
  const described = describeSlots([customSlot()], {});

  expect(propertyAt(described, "99.foo")).toMatchObject({ type: "string", default: "bar" });
});

test("an unknown node_type is reported as unresolved rather than thrown", () => {
  const described = describeSlots([customSlot()], {});

  expect(described.unresolved).toEqual([
    { address: "99.foo", name: "foo", node_type: "SomeCustomNode", reason: "unknown_node_type" },
  ]);
});

test("an input name in neither map is reported against the node that lacks it", () => {
  const stray = customSlot({ address: "3.nonesuch", name: "nonesuch", node_type: "KSampler" });

  expect(describeSlots([stray], objectInfo).unresolved).toEqual([
    { address: "3.nonesuch", name: "nonesuch", node_type: "KSampler", reason: "unknown_input" },
  ]);
});

test("a spec that is not a tuple degrades instead of throwing", () => {
  const broken: ObjectInfo = { Odd: { input: { required: { foo: "STRING" } } } };
  const slot = customSlot({ node_type: "Odd" });

  const described = describeSlots([slot], broken);

  expect(propertyAt(described, "99.foo").type).toBe("string");
  expect(described.unresolved[0]).toMatchObject({ reason: "unreadable_spec" });
});

test("an unresolved COMBO falls back to the type of the value it holds", () => {
  const combo = customSlot({ type: "COMBO", current_value: "some-model.safetensors" });

  expect(describeSlots([combo], {}).schema.properties["99.foo"]).toMatchObject({
    type: "string",
    default: "some-model.safetensors",
  });
});

test("a slot with nothing left to say about it gets no type", () => {
  const opaque = customSlot({ type: "WEIRD_CUSTOM_WIDGET", current_value: null });

  expect(describeSlots([opaque], {}).schema.properties["99.foo"]).toEqual({});
});

test("one unknown node does not stop the others from resolving", () => {
  const described = describeSlots([...imageGen, customSlot()], objectInfo);

  expect(propertyAt(described, "3.steps").maximum).toBe(10000);
  expect(described.unresolved).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// Seed precision (landmine #11)
// ---------------------------------------------------------------------------

test("a bound beyond f64's integer range is clamped to what JSON round-trips", () => {
  const declared = declaredSpec("KSampler", "seed")[1]?.["max"];
  // 18446744073709551615 was already mangled to 2^64 by JSON.parse before this
  // module ever saw it, so the declared bound is both wrong and unreachable.
  expect(declared).toBe(18446744073709552000);
  expect(Number.isSafeInteger(declared)).toBe(false);

  const seed = describeAt(imageGen, "3.seed");

  expect(seed.minimum).toBe(0);
  expect(seed.maximum).toBe(Number.MAX_SAFE_INTEGER);
  expect(Number.isSafeInteger(seed.maximum!)).toBe(true);
});

test("a bound already inside f64's integer range is untouched", () => {
  expect(describeAt(imageGen, "3.steps").maximum).toBe(10000);
});

// ---------------------------------------------------------------------------
// Scale: the real 210-slot video workflow
// ---------------------------------------------------------------------------

test("every slot of a 210-slot workflow produces a schema entry", () => {
  const described = describeSlots(sixKey, objectInfo);

  expect(Object.keys(described.schema.properties)).toHaveLength(210);
  for (const slot of sixKey) {
    // `hasOwn`, not `toHaveProperty`: an address such as `140/38.clip_name`
    // contains a dot, which that matcher reads as a path separator.
    expect(Object.hasOwn(described.schema.properties, slot.address), slot.address).toBe(true);
  }
});

test("nothing in the 210-slot workflow is left unresolved", () => {
  expect(describeSlots(sixKey, objectInfo).unresolved).toEqual([]);
});

test("the 210-slot workflow's 97 COMBOs all become enums", () => {
  const described = describeSlots(sixKey, objectInfo);
  const combos = sixKey.filter((s) => s.type === "COMBO");

  expect(combos).toHaveLength(97);
  for (const slot of combos) {
    expect(propertyAt(described, slot.address).enum).toBeArray();
  }
});

test("the 210-slot workflow describes as valid JSON Schema", () => {
  assertValidJsonSchema(describeSlots(sixKey, objectInfo));
});

test("the 13-slot workflow describes as valid JSON Schema", () => {
  assertValidJsonSchema(describeSlots(imageGen, objectInfo));
});

test("the envelope is an object schema that rejects addresses the workflow lacks", () => {
  const { schema } = describeSlots(imageGen, objectInfo);

  expect(schema.type).toBe("object");
  expect(schema.additionalProperties).toBe(false);
});

/**
 * Structural validation, in place of a validator dependency. It checks the two
 * things that matter downstream: that the document survives serialisation to a
 * client at all, and that no constraint it states contradicts another.
 */
function assertValidJsonSchema(described: WorkflowDescription): void {
  const { schema } = described;

  // A key holding `undefined` vanishes on the way to a client; NaN and Infinity
  // become `null`. Either way what the client validates is not what was built.
  expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);

  const allowed = new Set([
    "type",
    "enum",
    "description",
    "minimum",
    "maximum",
    "multipleOf",
    "default",
  ]);
  const types = new Set(["integer", "number", "string", "boolean"]);

  for (const [address, property] of Object.entries(schema.properties)) {
    const where = `${address}: ${JSON.stringify(property)}`;

    for (const key of Object.keys(property)) {
      expect(allowed.has(key), `${where} has unknown keyword ${key}`).toBe(true);
    }
    if (property.type !== undefined) {
      expect(types.has(property.type), `${where} has a non-JSON-Schema type`).toBe(true);
    }
    if (property.enum !== undefined) {
      expect(Array.isArray(property.enum), `${where} enum is not an array`).toBe(true);
      expect(property.enum.length, `${where} enum is empty`).toBeGreaterThan(0);
    }
    for (const bound of [property.minimum, property.maximum]) {
      if (bound === undefined) continue;
      expect(Number.isFinite(bound), `${where} bound is not finite`).toBe(true);
      // An integer past 2^53 cannot round-trip through JSON, so a bound stated
      // there means something other than what it says. Only checked on integer
      // inputs: a FLOAT maximum of sys.float_info.max is an ordinary f64.
      if (property.type === "integer") {
        expect(Number.isSafeInteger(bound), `${where} bound is an unsafe integer`).toBe(true);
      }
    }
    if (property.minimum !== undefined && property.maximum !== undefined) {
      expect(property.minimum, `${where} minimum exceeds maximum`).toBeLessThanOrEqual(
        property.maximum,
      );
    }
    if (property.multipleOf !== undefined) {
      expect(property.multipleOf, `${where} multipleOf is not positive`).toBeGreaterThan(0);
      // Every value the schema itself names must survive the constraint, or the
      // constraint is provably rejecting legal input.
      for (const value of [property.minimum, property.maximum, property.default]) {
        if (typeof value !== "number") continue;
        expect(rejects(value, property.multipleOf), `${where} multipleOf rejects ${value}`).toBe(
          false,
        );
      }
    }
    if (property.type === "integer" && typeof property.default === "number") {
      expect(Number.isInteger(property.default), `${where} integer default is fractional`).toBe(
        true,
      );
    }
    if (property.description !== undefined) {
      expect(typeof property.description, `${where} description is not a string`).toBe("string");
    }
  }
}
