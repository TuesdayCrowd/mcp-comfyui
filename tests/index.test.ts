import { expect, test } from "./support/testing.ts";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { MAX_BUFFER_SIZE, describeValidationFailure, remapValidationError } from "../src/index.ts";

/**
 * The pure logic behind Findings 1 and 2, tested in isolation from real stdio.
 *
 * `src/index.ts` is the stdio entrypoint and normally runs `main()` as a side
 * effect of being executed directly (`node dist/index.js`, the built
 * artifact), which is why every other test that exercises it
 * (`tests/server.test.ts`'s "stdio landmine" section) spawns it as a
 * subprocess rather than importing it. The exports this file imports are
 * guarded behind `isMainModule()` (this project's `import.meta.main`
 * equivalent — see its doc comment in `src/index.ts`), so importing this
 * module here does not attach real stdin/stdout listeners or start a server —
 * only the transport-hardening logic itself is under test.
 */

// --- Finding 1: sizing the buffer limit against a measurement, not a guess -

/** `STDIO_DEFAULT_MAX_BUFFER_SIZE` in `@modelcontextprotocol/sdk`'s own `dist/esm/shared/stdio.js`. */
const SDK_DEFAULT_MAX_BUFFER_SIZE = 10 * 1024 * 1024;

/**
 * The largest legitimate JSON-RPC frame measured for this server's own tools:
 * `list_workflows` over a directory of 20,000 workflow files (roughly 900x
 * this deployment's real 22) came to 6,180,258 bytes; `describe_workflow` on
 * the real 210-slot `slots.6key.json` fixture came to 70,407 bytes. See the
 * measurement note on `MAX_BUFFER_SIZE` in `src/index.ts`.
 */
const MEASURED_LARGEST_LEGITIMATE_FRAME_BYTES = 6_180_258;

test("MAX_BUFFER_SIZE is larger than the SDK's own default", () => {
  // A mutant that reverts to the SDK default (by dropping the option
  // entirely, or passing `undefined`) must fail this.
  expect(MAX_BUFFER_SIZE).toBeGreaterThan(SDK_DEFAULT_MAX_BUFFER_SIZE);
});

test("MAX_BUFFER_SIZE comfortably exceeds the largest measured legitimate payload", () => {
  expect(MAX_BUFFER_SIZE).toBeGreaterThan(MEASURED_LARGEST_LEGITIMATE_FRAME_BYTES);
});

// --- Finding 2: turning the SDK's raw Zod dump into an actionable error ----

/**
 * A byte-exact capture of what SDK 1.30.0 actually sends for
 * `tools/call {arguments: null}` -- reproduced live over real stdio against
 * this server (see the report). `Protocol.setRequestHandler`'s wrapper
 * (`dist/esm/shared/protocol.js`) runs `parseWithCompat` against the whole
 * request *before* any handler -- including the one that would map a bad
 * `tools/call` to `InvalidParams` -- ever runs, and throws the raw Zod result
 * on failure. The generic per-request catch then reports it as
 * `ErrorCode.InternalError` with `.message` set to the ZodError's own
 * `.message`, which for zod 4 is `JSON.stringify(issues, null, 2)`.
 */
const RAW_ZOD_DUMP_MESSAGE =
  '[\n  {\n    "expected": "record",\n    "code": "invalid_type",\n    "path": [\n      "params",\n      "arguments"\n    ],\n    "message": "Invalid input: expected record, received null"\n  }\n]';

test("describeValidationFailure turns the SDK's raw Zod dump into one line per issue", () => {
  expect(describeValidationFailure(RAW_ZOD_DUMP_MESSAGE)).toBe(
    "params.arguments: Invalid input: expected record, received null",
  );
});

test("describeValidationFailure joins multiple issues", () => {
  const message = JSON.stringify([
    { code: "invalid_type", path: ["params", "name"], message: "Invalid input: expected string, received undefined" },
    { code: "invalid_type", path: ["params", "arguments"], message: "Invalid input: expected record, received number" },
  ]);

  expect(describeValidationFailure(message)).toBe(
    "params.name: Invalid input: expected string, received undefined; " +
      "params.arguments: Invalid input: expected record, received number",
  );
});

test("describeValidationFailure uses the bare message when an issue carries no path", () => {
  const message = JSON.stringify([{ code: "custom", path: [], message: "top-level failure" }]);
  expect(describeValidationFailure(message)).toBe("top-level failure");
});

test("describeValidationFailure returns null for a message that is not JSON", () => {
  expect(describeValidationFailure("connection refused")).toBeNull();
});

test("describeValidationFailure returns null for a JSON value that is not an array of issues", () => {
  expect(describeValidationFailure(JSON.stringify({ oops: true }))).toBeNull();
  expect(describeValidationFailure(JSON.stringify([]))).toBeNull();
  expect(describeValidationFailure(JSON.stringify([1, 2, 3]))).toBeNull();
  expect(describeValidationFailure(JSON.stringify(["just a string"]))).toBeNull();
});

test("remapValidationError rewrites the exact shape SDK 1.30.0 sends for a malformed tools/call", () => {
  const original = {
    jsonrpc: "2.0" as const,
    id: 2,
    error: { code: ErrorCode.InternalError, message: RAW_ZOD_DUMP_MESSAGE },
  };

  const remapped = remapValidationError(original);

  expect(remapped).not.toBe(original); // the original message object is untouched
  if (!("error" in remapped)) throw new Error("expected an error response");
  expect(remapped.error.code).toBe(ErrorCode.InvalidParams);
  expect(remapped.error.message).toContain("params.arguments");
  expect(remapped.error.message).toContain("expected record, received null");
  expect(remapped.jsonrpc).toBe("2.0");
  expect(remapped.id).toBe(2);
});

test("remapValidationError leaves a successful result untouched", () => {
  const result = { jsonrpc: "2.0" as const, id: 1, result: { ok: true } };
  expect(remapValidationError(result)).toBe(result);
});

test("remapValidationError leaves a non-InternalError error untouched", () => {
  const notFound = {
    jsonrpc: "2.0" as const,
    id: 5,
    error: { code: ErrorCode.MethodNotFound, message: "Method not found" },
  };
  expect(remapValidationError(notFound)).toBe(notFound);
});

test("remapValidationError leaves a genuine internal error (a plain message) untouched", () => {
  // Not every InternalError is the SDK's own pre-handler Zod dump: a bug in
  // this server's own code that reaches the protocol layer must still say
  // "internal error", not be relabelled as the caller's mistake.
  const genuine = {
    jsonrpc: "2.0" as const,
    id: 7,
    error: { code: ErrorCode.InternalError, message: "Cannot read properties of undefined (reading 'foo')" },
  };
  expect(remapValidationError(genuine)).toBe(genuine);
});

test("remapValidationError leaves a non-InternalError error untouched even when its message happens to be issue-shaped JSON", () => {
  // Distinct from the "non-InternalError" test above: that one's message
  // fails describeValidationFailure's own JSON check regardless of the code
  // guard, so it cannot by itself prove the code check does anything. This
  // pairs a zod-issue-shaped message with a code that is not InternalError,
  // which only the code check can refuse.
  const wrongCodeButIssueShaped = {
    jsonrpc: "2.0" as const,
    id: 9,
    error: { code: ErrorCode.InvalidRequest, message: RAW_ZOD_DUMP_MESSAGE },
  };
  expect(remapValidationError(wrongCodeButIssueShaped)).toBe(wrongCodeButIssueShaped);
});

test("remapValidationError leaves an InternalError whose message is JSON but not issue-shaped untouched", () => {
  const notIssues = {
    jsonrpc: "2.0" as const,
    id: 8,
    error: { code: ErrorCode.InternalError, message: JSON.stringify([{ oops: "no message field" }]) },
  };
  expect(remapValidationError(notIssues)).toBe(notIssues);
});
