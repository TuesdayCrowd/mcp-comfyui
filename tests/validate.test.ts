import { afterEach, beforeEach, expect, test } from "./support/testing.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComfyCliError } from "../src/comfy/exec.ts";
import { validateWorkflow, ValidatePayloadError } from "../src/comfy/validate.ts";

/**
 * `comfy validate` breaks the envelope contract every other command follows, and
 * this module exists to absorb that. The shapes below are real captures from
 * comfy-cli v1.13.0-59-g95d7897 against a live ComfyUI 0.30.2 on 2026-08-09 —
 * an invalid workflow really does answer `ok:false` with `error:null`, and a
 * *valid* one really does carry 19 warnings.
 */
const FAKE_COMFY = join(import.meta.dirname, "fixtures", "fake-comfy");

const FIXTURE_ENV = ["COMFY_BIN", "FAKE_COMFY_MODE", "FAKE_COMFY_VALIDATE_FILE", "FAKE_COMFY_VALIDATE_OK", "FAKE_COMFY_ARGV_OUT", "FAKE_COMFY_ERROR_CODE", "FAKE_COMFY_ERROR_MESSAGE"];

let workdir: string;
let argvOut: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "mcp-comfyui-validate-"));
  argvOut = join(workdir, "argv");
  process.env.COMFY_BIN = FAKE_COMFY;
  process.env.FAKE_COMFY_MODE = "validate";
  process.env.FAKE_COMFY_ARGV_OUT = argvOut;
});

afterEach(() => {
  for (const key of FIXTURE_ENV) delete process.env[key];
  rmSync(workdir, { recursive: true, force: true });
});

/** Serve a payload, choosing the envelope's `ok` independently of it. */
function serve(payload: unknown, ok = true): void {
  const path = join(workdir, "payload.json");
  writeFileSync(path, JSON.stringify(payload));
  process.env.FAKE_COMFY_VALIDATE_FILE = path;
  process.env.FAKE_COMFY_VALIDATE_OK = String(ok);
}

const options = () => ({ objectInfoPath: join(workdir, "object_info.json") });

test("a valid workflow reports valid, with the CLI's own counts", async () => {
  serve({ valid: true, error_count: 0, warning_count: 0, errors: [], warnings: [] });

  const report = await validateWorkflow("/w/flow.json", options());

  expect(report.valid).toBe(true);
  expect(report.error_count).toBe(0);
});

test("an INVALID workflow is an answer, not a thrown error", async () => {
  // The measured shape: ok:false, error:null, data populated. `runComfy` throws
  // EnvelopeParseError on exactly this (verified directly against the real CLI),
  // which is why this module decodes the raw envelope itself.
  serve({
    valid: false,
    error_count: 2,
    warning_count: 0,
    errors: [
      { node_id: "97", field: "image", code: "unknown_enum_value", message: "'nope.png' not in 4 known options", suggestions: ["card_front_3.png"], valid_options: ["card_front_3.png"] },
      { node_id: "5", field: "width", code: "above_max", message: "width=999999 above catalog max 16384" },
    ],
    warnings: [],
  }, false);

  const report = await validateWorkflow("/w/flow.json", options());

  expect(report.valid).toBe(false);
  expect(report.error_count).toBe(2);
  expect(report.errors[0]?.code).toBe("unknown_enum_value");
});

test("a diagnostic keeps the fields its own code carries, and no others are invented", async () => {
  // Measured: the record shape is not uniform. `unknown_enum_value` carries
  // suggestions and valid_options; `above_max` carries neither; a whole-node
  // `unknown_class_type` carries no `field` at all. `looseObject` preserves
  // whichever arrive rather than flattening them to a common shape.
  serve({
    valid: false,
    error_count: 1,
    errors: [{ code: "unknown_class_type", message: "class_type 'Nope' not found", node_id: "4", suggestions: [] }],
    warnings: [],
  }, false);

  const report = await validateWorkflow("/w/flow.json", options());

  const first = report.errors[0] as Record<string, unknown>;
  expect(first["suggestions"]).toEqual([]);
  expect(Object.hasOwn(first, "field")).toBe(false);
});

test("warnings are capped while warning_count stays the true total", async () => {
  // A workflow that validates CLEAN still carried 19 of these, nearly all
  // edge_type_mismatch from one ComfySwitchNode. Returning them all would crowd
  // out the errors that matter.
  const warnings = Array.from({ length: 19 }, (_, i) => ({
    code: "edge_type_mismatch",
    message: `input ${i} expects MODEL but ComfySwitchNode[0] produces COMFY_MATCHTYPE_V3`,
  }));
  serve({ valid: true, error_count: 0, warning_count: 19, errors: [], warnings });

  const report = await validateWorkflow("/w/flow.json", options());

  expect(report.warning_count).toBe(19);
  expect(report.warnings).toHaveLength(5);
  expect(report.warnings_truncated).toBe(true);
});

test("a diagnostic code absent from today's vocabulary is carried, not refused", async () => {
  // The 13 codes this command emits appear in NONE of comfy-cli's published
  // error_codes registry. Closing the set would break on the fourteenth.
  serve({ valid: false, error_count: 1, errors: [{ code: "a_code_from_the_future", message: "…" }], warnings: [] }, false);

  const report = await validateWorkflow("/w/flow.json", options());

  expect(report.errors[0]?.code).toBe("a_code_from_the_future");
});

test("a real CLI failure still throws, with its code", async () => {
  process.env.FAKE_COMFY_MODE = "fail_code";
  process.env.FAKE_COMFY_ERROR_CODE = "cql_no_graph";
  process.env.FAKE_COMFY_ERROR_MESSAGE = "cannot read object_info";

  await expect(validateWorkflow("/w/flow.json", options())).rejects.toBeInstanceOf(ComfyCliError);
});

test("a payload that is not a validation report is refused rather than guessed at", async () => {
  serve({ something: "else" });

  await expect(validateWorkflow("/w/flow.json", options())).rejects.toBeInstanceOf(ValidatePayloadError);
});

test("global flags precede the subcommand and the cache is passed with --input", async () => {
  serve({ valid: true, errors: [], warnings: [] });

  await validateWorkflow("/w/flow.json", options());

  const argv = readFileSync(argvOut, "utf8").trim().split(/\s+/);
  expect(argv.indexOf("--json")).toBeLessThan(argv.indexOf("validate"));
  expect(argv.slice(argv.indexOf("validate"))).toEqual([
    "validate", "--workflow", "/w/flow.json", "--input", options().objectInfoPath,
  ]);
});
