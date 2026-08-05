import { expect, test } from "./support/testing.ts";
import { EnvelopeParseError, parseEnvelope, parseEnvelopeValue } from "../src/comfy/envelope.ts";

/** A well-formed envelope, overridable field by field. */
function envelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: "envelope/1", type: "envelope", ok: true,
    command: "workflow slots", version: "0.0.0", where: null,
    data: { slots: [] }, error: null,
    ...overrides,
  });
}

test("parses a success envelope", () => {
  const raw = JSON.stringify({
    schema: "envelope/1", type: "envelope", ok: true,
    command: "workflow slots", version: "0.0.0", where: null,
    data: { slots: [] }, error: null,
  });
  const env = parseEnvelope(raw);
  expect(env.ok).toBe(true);
  expect(env.command).toBe("workflow slots");
});

test("returns the data payload of a success envelope", () => {
  const data = { slots: [{ id: "prompt", type: "string" }], prompt_id: "abc-123" };
  const env = parseEnvelope(envelope({ command: "workflow slots", data }));
  expect(env.ok).toBe(true);
  if (env.ok) expect(env.data).toEqual(data);
});

test("parses a failure envelope and keeps the error code", () => {
  const raw = JSON.stringify({
    schema: "envelope/1", type: "envelope", ok: false,
    command: "run", version: "0.0.0", where: null, data: null,
    error: { code: "workflow_not_found", message: "no such file", hint: "check the path", details: null },
  });
  const env = parseEnvelope(raw);
  expect(env.ok).toBe(false);
  if (!env.ok) expect(env.error.code).toBe("workflow_not_found");
});

test("accepts an unrecognised error code (registry is append-only)", () => {
  const raw = JSON.stringify({
    schema: "envelope/1", type: "envelope", ok: false, command: "run",
    version: "0.0.0", where: null, data: null,
    error: { code: "some_future_code", message: "m", hint: null, details: null },
  });
  const env = parseEnvelope(raw);
  expect(env.ok).toBe(false);
  if (!env.ok) expect(env.error.code).toBe("some_future_code");
});

test("keeps hint and details intact", () => {
  const details = { path: "/w/flow.json", tried: ["a", "b"] };
  const env = parseEnvelope(envelope({
    ok: false, command: "run", data: null,
    error: { code: "workflow_not_found", message: "no such file", hint: "check the path", details },
  }));
  expect(env.ok).toBe(false);
  if (!env.ok) {
    expect(env.error.hint).toBe("check the path");
    expect(env.error.details).toEqual(details);
  }
});

test("rejects a hint that is not a string", () => {
  const raw = envelope({
    ok: false, command: "run", data: null,
    error: { code: "workflow_not_found", message: "m", hint: 42 },
  });
  expect(() => parseEnvelope(raw)).toThrow(EnvelopeParseError);
});

test("accepts an error object with only code and message", () => {
  const env = parseEnvelope(envelope({
    ok: false, command: "run", data: null,
    error: { code: "invalid_slot_value", message: "m" },
  }));
  expect(env.ok).toBe(false);
  if (!env.ok) expect(env.error.code).toBe("invalid_slot_value");
});

test("preserves unknown keys added to the error object", () => {
  const env = parseEnvelope(envelope({
    ok: false, command: "run", data: null,
    error: { code: "server_unreachable", message: "m", retryable: true, exit_code: 7 },
  }));
  expect(env.ok).toBe(false);
  if (!env.ok) {
    expect(env.error.retryable).toBe(true);
    expect(env.error.exit_code).toBe(7);
  }
});

test("preserves where on the failure arm", () => {
  const env = parseEnvelope(envelope({
    ok: false, command: "run", where: "cloud", data: null,
    error: { code: "server_unreachable", message: "m" },
  }));
  expect(env.ok).toBe(false);
  if (!env.ok) expect(env.where).toBe("cloud");
});

test("names the problem when the input is not valid JSON", () => {
  const raw = "{ this is not json";
  let caught: unknown;
  try {
    parseEnvelope(raw);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(EnvelopeParseError);
  expect((caught as Error).message).toMatch(/not valid JSON/);
  expect((caught as Error).message).toContain(raw);
});

test("truncates the offending input in the malformed-JSON error", () => {
  expect(() => parseEnvelope("x".repeat(1000))).toThrow(/…/);
});

test("rejects valid JSON that is not an envelope", () => {
  const raw = '{"foo":1}';
  let caught: unknown;
  try {
    parseEnvelope(raw);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(EnvelopeParseError);
  expect((caught as Error).message).toMatch(/comfy/);
  expect((caught as Error).message).toContain(raw);
  expect((caught as EnvelopeParseError).raw).toBe(raw);
});

test("rejects a future envelope schema version", () => {
  expect(() => parseEnvelope(envelope({ schema: "envelope/2" }))).toThrow(EnvelopeParseError);
});

test("rejects an object whose type is not envelope", () => {
  expect(() => parseEnvelope(envelope({ type: "event" }))).toThrow(EnvelopeParseError);
});

// `test.each` has no equivalent under `@std/testing/bdd` (see
// `tests/support/testing.ts`), so each case is its own `test()`.
test("rejects non-object JSON (null)", () => {
  expect(() => parseEnvelope("null")).toThrow(EnvelopeParseError);
});

test("rejects non-object JSON (array)", () => {
  expect(() => parseEnvelope("[]")).toThrow(EnvelopeParseError);
});

test("rejects non-object JSON (number)", () => {
  expect(() => parseEnvelope("42")).toThrow(EnvelopeParseError);
});

function expectNoOutput(raw: string): void {
  let caught: unknown;
  try {
    parseEnvelope(raw);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(EnvelopeParseError);
  expect((caught as Error).message).toMatch(/no output/);
  expect((caught as EnvelopeParseError).raw).toBe(raw);
}

test("reports no output for empty stdout", () => {
  expectNoOutput("");
});

test("reports no output for whitespace stdout", () => {
  expectNoOutput("  \n\t ");
});

test("rejects an ok:false envelope that carries no error object", () => {
  const raw = envelope({ ok: false, command: "run", data: null, error: null });
  expect(() => parseEnvelope(raw)).toThrow(EnvelopeParseError);
  expect(() => parseEnvelope(raw)).toThrow(/ok:false/);
});

test("round-trips a large data payload unchanged", () => {
  const data = {
    images: Array.from({ length: 2000 }, (_, i) => ({
      filename: `ComfyUI_${String(i).padStart(5, "0")}_.png`,
      subfolder: "",
      type: "output",
      note: "y".repeat(80),
    })),
  };
  const raw = envelope({ command: "run", data });
  expect(raw.length).toBeGreaterThan(200_000);
  const env = parseEnvelope(raw);
  expect(env.ok).toBe(true);
  if (env.ok) expect(env.data).toEqual(data);
});

test("parseEnvelopeValue decodes an already-parsed value", () => {
  const value = {
    schema: "envelope/1", type: "envelope", ok: true, command: "run",
    version: "0.0.0", where: "local", data: { prompt_id: "p1" }, error: null,
  };
  const env = parseEnvelopeValue(value);
  expect(env.ok).toBe(true);
  if (env.ok) expect(env.data).toEqual({ prompt_id: "p1" });
});

test("parseEnvelopeValue rejects a value that is not an envelope", () => {
  let caught: unknown;
  try {
    parseEnvelopeValue({ foo: 1 });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(EnvelopeParseError);
  // Pins the JSON.stringify branch of describe(): a String(value) fallback
  // would degrade this to "[object Object]" and lose the diagnostic.
  expect((caught as EnvelopeParseError).raw).toBe('{"foo":1}');
});
