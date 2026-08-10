import { expect, test } from "./support/testing.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ObjectInfo } from "../src/comfy/objectInfo.ts";
import type { InertInput } from "../src/workflows/discover.ts";
import type { Slot } from "../src/workflows/slots.ts";
import { describeSlots, type InputSchema, type WorkflowDescription } from "../src/workflows/describe.ts";

/**
 * Every fixture here is a real capture from ComfyUI 0.29.0, not a hand-written
 * approximation: the join this module performs is the server's whole value-add,
 * and a synthetic `object_info` would only ever prove that the code agrees with
 * the author's memory of the format.
 */
function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8")) as T;
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

/**
 * An `object_info` with a single node and a single input, for the degenerate
 * shapes two healthy captures cannot reach. Every rule this module states is
 * about data like this, so the rules have to be pinned against data like this.
 */
function oneNode(spec: unknown, bucket: "required" | "optional" = "required"): ObjectInfo {
  return { SomeCustomNode: { input: { [bucket]: { foo: spec } } } };
}

/**
 * A node entry that is not a node. The cast is the point: this module is
 * documented as pure over caller-supplied data, the cache file it is normally
 * fed from is public and hand-editable, and a truncated or hand-built one is
 * exactly what must not take the process down.
 */
function brokenObjectInfo(entry: unknown): ObjectInfo {
  return { SomeCustomNode: entry } as ObjectInfo;
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
});

test("a workflow value off the node's step grid is kept beside multipleOf", () => {
  // The node's own anchors (16, 16384, 512) prove multipleOf 8, so the keyword
  // is sound. The workflow holds 740, which ComfyUI silently floors to 736 —
  // and saying so is the point: the caller learns the stored value will be
  // adjusted. This is the disagreement `enum` already tolerates in 36 of the
  // 6key capture's 210 properties, and `default` is an annotation either way.
  const grid = oneNode(["INT", { min: 16, max: 16384, step: 8, default: 512 }]);
  const offGrid = customSlot({ type: "INT", current_value: 740 });

  const property = propertyAt(describeSlots([offGrid], grid), "99.foo");

  expect(property.multipleOf).toBe(8);
  expect(property.default).toBe(740);
  expect(rejects(740, 8)).toBe(true); // the two really do disagree
});

test("a step of 1 on an integer is not emitted as a vacuous multipleOf", () => {
  const slot = customSlot({ type: "INT", current_value: 5 });
  const property = propertyAt(
    describeSlots([slot], oneNode(["INT", { min: 0, max: 10, step: 1 }])),
    "99.foo",
  );

  expect(property).not.toHaveProperty("multipleOf");
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
  // `default: null` would tell a caller that null is a legal value for an
  // integer input. Resolved against a real node so this runs the joined path
  // rather than the degraded one.
  const unset = customSlot({ type: "INT", current_value: null });

  const property = propertyAt(describeSlots([unset], oneNode(["INT", { min: 1 }])), "99.foo");

  expect(property).not.toHaveProperty("default");
  expect(property.minimum).toBe(1); // it really did resolve
});

test("a null current value emits no default on the degraded path either", () => {
  const unset = customSlot({ current_value: null });

  expect(describeSlots([unset], {}).schema.properties["99.foo"]).not.toHaveProperty("default");
});

test("a node default that is not a scalar is not emitted", () => {
  // `default: null`, `default: {}` and `default: []` all appear in the wild on
  // multiselect and dynamic widgets. None of them is something `set-slot` can
  // carry on a command line.
  const unset = customSlot({ current_value: null });

  for (const declared of [null, {}, [], ["a"]]) {
    const described = describeSlots([unset], oneNode(["STRING", { default: declared }]));

    expect(described.schema.properties["99.foo"], JSON.stringify(declared)).not.toHaveProperty(
      "default",
    );
  }
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

test("a node entry that is not an object reports the node, not the input", () => {
  // `null` used to reach `node["input"]` and throw, against this module's own
  // never-throw contract. A string or an array entry misreported the *input*
  // name when the node definition is what is broken.
  for (const entry of [null, [], "STRING", 42, ["INT", {}]]) {
    const described = describeSlots([customSlot()], brokenObjectInfo(entry));

    expect(described.unresolved, JSON.stringify(entry)).toEqual([
      { address: "99.foo", name: "foo", node_type: "SomeCustomNode", reason: "unknown_node_type" },
    ]);
    expect(propertyAt(described, "99.foo").type).toBe("string");
  }
});

test("an input declared as null reads as unreadable, not as absent", () => {
  // Present-but-unreadable and not-declared are different answers, and only the
  // first stops the search: falling through to `optional` here would resolve the
  // slot against a spec the node did not mean for it.
  const both: ObjectInfo = {
    SomeCustomNode: {
      input: { required: { foo: null }, optional: { foo: ["INT", { min: 1, max: 9 }] } },
    },
  };

  const described = describeSlots([customSlot()], both);

  expect(described.unresolved[0]).toMatchObject({ reason: "unreadable_spec" });
  expect(propertyAt(described, "99.foo")).not.toHaveProperty("minimum");
});

test("required wins over optional when both declare the same name", () => {
  const both: ObjectInfo = {
    SomeCustomNode: {
      input: {
        required: { foo: ["INT", { min: 1, max: 9 }] },
        optional: { foo: ["STRING", { tooltip: "the optional one" }] },
      },
    },
  };

  const property = propertyAt(describeSlots([customSlot({ type: "INT" })], both), "99.foo");

  expect(property.type).toBe("integer");
  expect(property).not.toHaveProperty("description");
});

test("an empty tuple is unreadable rather than an unconstrained resolve", () => {
  const described = describeSlots([customSlot()], oneNode([]));

  expect(described.unresolved[0]).toMatchObject({ reason: "unreadable_spec" });
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

  expect(describeSlots([opaque], {}).schema.properties["99.foo"]).toEqual({
    title: "SomeCustomNode.foo",
  });
});

test("one unknown node does not stop the others from resolving", () => {
  const described = describeSlots([...imageGen, customSlot()], objectInfo);

  expect(propertyAt(described, "3.steps").maximum).toBe(10000);
  expect(described.unresolved).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------

test("a property body identifies its node type and input without the key", () => {
  // Only 18 of the 6key capture's 210 properties carry a description, and the
  // bodies collapse to a handful of distinct shapes: `140/67.length` through
  // `144/67.length` are byte-identical without this, and so are the high-noise
  // and low-noise UNET loaders. A body a model cannot attribute is a body it
  // cannot plan from.
  const described = describeSlots(sixKey, objectInfo);

  for (const slot of sixKey) {
    expect(propertyAt(described, slot.address).title).toBe(`${slot.node_type}.${slot.name}`);
  }
});

test("a degraded property is titled too", () => {
  expect(describeSlots([customSlot()], {}).schema.properties["99.foo"]?.title).toBe(
    "SomeCustomNode.foo",
  );
});

// ---------------------------------------------------------------------------
// A COMBO that resolves to nothing
// ---------------------------------------------------------------------------

test("a COMBO that resolves without allowed values is reported", () => {
  // `SaveVideo.codec`'s shape: the options are widget descriptors, not values,
  // so the join succeeds and still yields nothing a caller could send. This is
  // exactly where a model guesses `Euler` for `euler`.
  const dynamic = oneNode(["COMFY_DYNAMICCOMBO_V3", { options: [{ key: "auto" }, { key: "h264" }] }]);

  const described = describeSlots([customSlot({ type: "COMBO" })], dynamic);

  expect(described.unresolved).toEqual([
    { address: "99.foo", name: "foo", node_type: "SomeCustomNode", reason: "no_values" },
  ]);
  expect(propertyAt(described, "99.foo")).not.toHaveProperty("enum");
});

test("an empty combo is reported as having no values", () => {
  // An install with no LoRAs reports exactly this, and the operator's fix is to
  // install one — which is what `unresolved` is for.
  const described = describeSlots([customSlot({ type: "COMBO" })], oneNode([[]]));

  expect(described.unresolved[0]?.reason).toBe("no_values");
  expect(propertyAt(described, "99.foo")).not.toHaveProperty("enum");
});

test("an input declared as [null] is reported rather than silently unconstrained", () => {
  const described = describeSlots([customSlot({ type: "COMBO" })], oneNode([null]));

  expect(described.unresolved[0]?.reason).toBe("no_values");
});

test("a non-COMBO with no enum is not reported", () => {
  // A STRING is unconstrained by nature. Only a COMBO promises a list, so only
  // a COMBO can fail to deliver one.
  expect(describeSlots([customSlot()], oneNode(["STRING", {}])).unresolved).toEqual([]);
});

test("a join failure outranks no_values for a COMBO", () => {
  // The operator's fix differs — install the node, not the models — so the more
  // specific reason is the one worth reporting.
  const described = describeSlots([customSlot({ type: "COMBO" })], {});

  expect(described.unresolved[0]?.reason).toBe("unknown_node_type");
});

// ---------------------------------------------------------------------------
// Constraints that would contradict each other
// ---------------------------------------------------------------------------

test("bounds that contradict each other are both dropped", () => {
  // min > max proves one of the two wrong without saying which, so neither is
  // proven. Emitting both yields a schema no value satisfies — including the
  // one the workflow already runs with.
  const impossible = oneNode(["INT", { min: 100, max: 1, default: 5 }]);

  const property = propertyAt(
    describeSlots([customSlot({ type: "INT", current_value: 5 })], impossible),
    "99.foo",
  );

  expect(property).not.toHaveProperty("minimum");
  expect(property).not.toHaveProperty("maximum");
  expect(property.default).toBe(5);
});

test("a bound below f64's integer range is clamped too", () => {
  const slot = customSlot({ type: "INT", current_value: 5 });
  const property = propertyAt(
    describeSlots([slot], oneNode(["INT", { min: -1e21, max: 10 }])),
    "99.foo",
  );

  expect(property.minimum).toBe(Number.MIN_SAFE_INTEGER);
});

test("a non-finite bound is dropped rather than serialised as null", () => {
  // JSON cannot express these, but this module's input is whatever the caller
  // hands it, and `JSON.stringify` turns each into `null` — a bound that reads
  // as deliberate and means nothing.
  //
  // One at a time, and never NaN against a finite bound: `NaN <= max` is false,
  // so a pair would be dropped by the contradictory-bounds guard instead and
  // this would pass while proving nothing.
  const slot = customSlot({ type: "INT", current_value: 5 });

  for (const config of [{ min: NaN }, { max: NaN }, { min: -Infinity }, { max: Infinity }]) {
    const described = describeSlots([slot], oneNode(["INT", config]));
    const property = propertyAt(described, "99.foo");
    const label = JSON.stringify(config); // NaN and Infinity both print as null

    expect(property, label).not.toHaveProperty("minimum");
    expect(property, label).not.toHaveProperty("maximum");
    expect(JSON.parse(JSON.stringify(property)), label).toEqual(property);
  }
});

test("an empty tooltip is not emitted as an empty description", () => {
  const property = propertyAt(
    describeSlots([customSlot()], oneNode(["STRING", { tooltip: "" }])),
    "99.foo",
  );

  expect(property).not.toHaveProperty("description");
});

// ---------------------------------------------------------------------------
// Enum values
// ---------------------------------------------------------------------------

test("an enum carries no redundant type keyword", () => {
  // The members already carry their own types, and a wrong one would narrow the
  // enum rather than describe it.
  expect(describeAt(imageGen, "3.sampler_name")).not.toHaveProperty("type");
});

test("values a caller could not send are filtered out of an enum", () => {
  const mixed = oneNode([["euler", { key: "widget" }, "heun", null]]);

  expect(propertyAt(describeSlots([customSlot({ type: "COMBO" })], mixed), "99.foo").enum).toEqual([
    "euler",
    "heun",
  ]);
});

test("the emitted enum does not alias the shared object_info", () => {
  // One `object_info` describes every workflow on the instance. A caller who
  // edits the enum it was handed must not corrupt the next description.
  const values = ["a", "b"];
  const shared: ObjectInfo = { SomeCustomNode: { input: { required: { foo: [values] } } } };

  const property = propertyAt(describeSlots([customSlot({ type: "COMBO" })], shared), "99.foo");
  property.enum?.push("c");

  expect(values).toEqual(["a", "b"]);
});

// ---------------------------------------------------------------------------
// Keys that are not ordinary keys
// ---------------------------------------------------------------------------

test("an address of __proto__ becomes an own property", () => {
  // Assignment would set the prototype instead: `Object.keys` empty, the
  // serialised `properties` `{}`, and an `unresolved` entry pointing at a
  // property that is not there.
  const { schema } = describeSlots([customSlot({ address: "__proto__" })], {});

  expect(Object.keys(schema.properties)).toEqual(["__proto__"]);
  expect(JSON.parse(JSON.stringify(schema)).properties).toHaveProperty("__proto__");
});

test("a repeated address yields one property and one report", () => {
  const described = describeSlots([customSlot(), customSlot()], {});

  expect(Object.keys(described.schema.properties)).toHaveLength(1);
  expect(described.unresolved).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// Inert inputs: a decoy is excluded from the schema and reported separately
// ---------------------------------------------------------------------------

/** A decoy entry as `discover.ts`'s `inertInputsOf` would produce it. */
function decoy(address: string, upstream: InertInput["upstream"] = null): [string, InertInput] {
  return [address, { address, upstream }];
}

test("a decoy address is excluded from schema.properties", () => {
  const inert = new Map([decoy("3.seed")]);

  const described = describeSlots(imageGen, objectInfo, inert);

  // `Object.hasOwn`, not `toHaveProperty`: the address contains a `.`, which
  // that matcher reads as a path separator rather than as part of the key.
  expect(Object.hasOwn(described.schema.properties, "3.seed")).toBe(false);
});

test("a decoy address is listed in `inert` instead, with its name and node type", () => {
  // The graph's own candidate is deliberately NOT passed through. This mock
  // claims node 7 offers `7.value`; in this real listing node 7 is a
  // `CLIPTextEncode` whose settable address is `7.text`, and that is what comes
  // back. The listing is the authority, because it is the vocabulary `set-slot`
  // actually accepts — an address this description cannot vouch for is worse
  // than none, since a caller would set it and watch the value vanish, which is
  // the whole failure `inert` exists to prevent.
  //
  // `node_id` and `node_type` still come from the graph untouched: they say
  // which node supplies the value, which the listing does not know.
  const inert = new Map([
    decoy("3.seed", { node_id: "7", node_type: "PrimitiveInt", candidate_addresses: ["7.value"] }),
  ]);

  const described = describeSlots(imageGen, objectInfo, inert);

  expect(described.inert).toEqual([
    {
      address: "3.seed",
      name: "seed",
      node_type: "KSampler",
      upstream: { node_id: "7", node_type: "PrimitiveInt", candidate_addresses: ["7.text"] },
    },
  ]);
});

test("a decoy with no identifiable upstream is still listed, with upstream null", () => {
  const inert = new Map([decoy("3.seed", null)]);

  const described = describeSlots(imageGen, objectInfo, inert);

  expect(described.inert[0]?.upstream).toBeNull();
});

test("a decoy is never also reported unresolved — it never reaches that check at all", () => {
  const inert = new Map([decoy("3.seed")]);

  const described = describeSlots(imageGen, objectInfo, inert);

  expect(described.unresolved.some((u) => u.address === "3.seed")).toBe(false);
});

test("an address absent from the inert map is described exactly as before", () => {
  // Regression: every other slot of a real 13-slot capture is untouched by
  // passing a (mostly empty) inert map alongside it.
  const inert = new Map([decoy("3.seed")]);

  const withInert = describeSlots(imageGen, objectInfo, inert);
  const without = describeSlots(imageGen, objectInfo);

  const otherAddress = "3.sampler_name";
  expect(withInert.schema.properties[otherAddress]).toEqual(without.schema.properties[otherAddress]);
});

test("omitting the inert map entirely behaves exactly as it did before this feature existed", () => {
  // Backward compatible by construction: every call site written before this
  // parameter existed passes exactly two arguments.
  expect(describeSlots(imageGen, objectInfo)).toEqual(describeSlots(imageGen, objectInfo, new Map()));
});

test("a decoy that never appears in the slot listing at all contributes nothing", () => {
  // The inert map may know about addresses the slots listing does not carry
  // (a different workflow, a stale cache) — those are simply never visited.
  const inert = new Map([decoy("999.nonexistent")]);

  const described = describeSlots(imageGen, objectInfo, inert);

  expect(described.inert).toEqual([]);
  expect(Object.keys(described.schema.properties)).toHaveLength(imageGen.length);
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

test("the 210-slot workflow's COMBOs are exactly the properties that get enums", () => {
  // A relation between input and output rather than a count of the fixture:
  // every COMBO gets values, and nothing else acquires them.
  const described = describeSlots(sixKey, objectInfo);
  const withEnum = Object.entries(described.schema.properties)
    .filter(([, property]) => property.enum !== undefined)
    .map(([address]) => address);

  expect(withEnum).toEqual(sixKey.filter((s) => s.type === "COMBO").map((s) => s.address));
  expect(withEnum.length).toBeGreaterThan(90); // 97 in this capture

  for (const address of withEnum) {
    const values = propertyAt(described, address).enum ?? [];
    expect(values.length, address).toBeGreaterThan(0);
    for (const value of values) {
      expect(["string", "number", "boolean"], `${address} member ${String(value)}`).toContain(
        typeof value,
      );
    }
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
    "title",
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
      // The bounds are the node's own anchors, and they are what prove the
      // constraint sound. `default` is deliberately excluded: it comes from the
      // workflow, not the node, and it is allowed to disagree — the same
      // disagreement `enum` tolerates in 36 of these 210 properties. Asserting
      // agreement here would encode a rule the design rejects.
      for (const value of [property.minimum, property.maximum]) {
        if (typeof value !== "number") continue;
        expect(rejects(value, property.multipleOf), `${where} multipleOf rejects ${value}`).toBe(
          false,
        );
      }
    }
    if (property.description !== undefined) {
      expect(typeof property.description, `${where} description is not a string`).toBe("string");
    }
  }
}

// ---------------------------------------------------------------------------
// Candidate resolution: what to set INSTEAD of a decoy
// ---------------------------------------------------------------------------
//
// `discover.ts` names a decoy's upstream node but resolves an address for it
// only when that node's own widget appears in the graph's `inputs[]` array —
// which happens only once a widget has been *converted to an input*. An
// ordinary widget lives in `widgets_values` and the node-type schema, so the
// graph-only resolver is blind to exactly the clean addresses it should
// recommend. Measured on `video_wan2_2_14B_i2v`: 9 of 14 decoys came back with
// no candidate, two because of that blindness and seven because the answer was
// one hop further than a single hop.
//
// `describeSlots` has what the graph does not: the CLI's own slot listing,
// which names every settable address in its own vocabulary. These pin the
// resolution done there.

/** A slot as `comfy workflow slots` reports one. */
function slotAt(address: string, nodeType: string, name = address.split(".")[1]!): Slot {
  return {
    address,
    name,
    type: "INT",
    current_value: 0,
    instance_id: address.slice(0, address.lastIndexOf(".")),
    node_type: nodeType,
  };
}

test("a candidate is found on the upstream node even when the graph could not name one", () => {
  // Cause A: `129/94.fps` is fed by PrimitiveFloat 162, whose `value` widget is
  // not in the graph's `inputs[]` at all — so `inertInputsOf` reported the node
  // and an empty candidate list. The listing knows `129/162.value` exists.
  const slots = [slotAt("129/94.fps", "CreateVideo"), slotAt("129/162.value", "PrimitiveFloat")];
  const inert = new Map([
    decoy("129/94.fps", { node_id: "162", node_type: "PrimitiveFloat", candidate_addresses: [] }),
  ]);

  const described = describeSlots(slots, objectInfo, inert);

  expect(described.inert[0]?.upstream?.candidate_addresses).toEqual(["129/162.value"]);
});

test("a candidate one hop further is found when the upstream's own widget is itself a decoy", () => {
  // Cause B: `129/86.steps` <- ComfySwitchNode 119, whose `switch` widget is
  // itself link-fed from PrimitiveBoolean 131. One hop lands on another decoy;
  // the answer is `129/131.value`.
  const slots = [
    slotAt("129/86.steps", "KSamplerAdvanced"),
    slotAt("129/119.switch", "ComfySwitchNode"),
    slotAt("129/131.value", "PrimitiveBoolean"),
  ];
  const inert = new Map([
    decoy("129/86.steps", { node_id: "119", node_type: "ComfySwitchNode", candidate_addresses: [] }),
    decoy("129/119.switch", { node_id: "131", node_type: "PrimitiveBoolean", candidate_addresses: [] }),
  ]);

  const described = describeSlots(slots, objectInfo, inert);

  const steps = described.inert.find((entry) => entry.address === "129/86.steps");
  expect(steps?.upstream?.candidate_addresses).toEqual(["129/131.value"]);
});

test("a node id repeated in another subgraph is never offered across scopes", () => {
  // `instance_id` carries the whole path, so `129/162` and `200/162` are two
  // different nodes that happen to share a local id. Matching on the bare id
  // would offer the wrong subgraph's address — which would be worse than
  // offering none, because it looks right.
  const slots = [slotAt("129/94.fps", "CreateVideo"), slotAt("200/162.value", "PrimitiveFloat")];
  const inert = new Map([
    decoy("129/94.fps", { node_id: "162", node_type: "PrimitiveFloat", candidate_addresses: [] }),
  ]);

  const described = describeSlots(slots, objectInfo, inert);

  expect(described.inert[0]?.upstream?.candidate_addresses).toEqual([]);
});

test("a decoy chain that loops back on itself terminates instead of hanging", () => {
  // Constructed, not observed: a graph cannot really cycle, but this function
  // walks caller-supplied data and must not depend on that.
  const slots = [slotAt("1.a", "N"), slotAt("2.b", "N"), slotAt("3.c", "N")];
  const inert = new Map([
    decoy("1.a", { node_id: "2", node_type: "N", candidate_addresses: [] }),
    decoy("2.b", { node_id: "3", node_type: "N", candidate_addresses: [] }),
    decoy("3.c", { node_id: "2", node_type: "N", candidate_addresses: [] }),
  ]);

  const described = describeSlots(slots, objectInfo, inert);

  expect(described.inert.find((e) => e.address === "1.a")?.upstream?.candidate_addresses).toEqual([]);
});

test("an upstream node absent from the listing yields no candidate rather than a guess", () => {
  const slots = [slotAt("129/94.fps", "CreateVideo")];
  const inert = new Map([
    decoy("129/94.fps", { node_id: "162", node_type: "PrimitiveFloat", candidate_addresses: [] }),
  ]);

  const described = describeSlots(slots, objectInfo, inert);

  expect(described.inert[0]?.upstream?.candidate_addresses).toEqual([]);
});

test("a node reached by two paths at once contributes its address once, not twice", () => {
  // The `visited` set is not about termination — MAX_CANDIDATE_HOPS already
  // bounds that, and the cycle test above passes with or without it. It is
  // about a frontier that holds the same node twice: node 5 here is reached
  // through both 2 and 3 in a single hop, and scanning it twice would report
  // `5.value` twice. A duplicated candidate is a small wrongness that reads as
  // two options where there is one.
  // `1.a` -> node 2. Node 2 has TWO decoy widgets, `2.b` and `2.d`, and both are
  // fed from node 5 — so one hop puts 5 in the frontier twice.
  const slots = [slotAt("1.a", "N"), slotAt("2.b", "N"), slotAt("2.d", "N"), slotAt("5.value", "PrimitiveInt")];
  const inert = new Map([
    decoy("1.a", { node_id: "2", node_type: "N", candidate_addresses: [] }),
    decoy("2.b", { node_id: "5", node_type: "PrimitiveInt", candidate_addresses: [] }),
    decoy("2.d", { node_id: "5", node_type: "PrimitiveInt", candidate_addresses: [] }),
  ]);

  const described = describeSlots(slots, objectInfo, inert);

  const first = described.inert.find((entry) => entry.address === "1.a");
  expect(first?.upstream?.candidate_addresses).toEqual(["5.value"]);
});
