import { expect, test } from "./support/testing.ts";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  CREATED_DIR_ENV,
  createdWorkflowDir,
  DEFAULT_WORKFLOW_DIR,
  WORKFLOW_DIRS_ENV,
  workflowRoots,
} from "../src/config.ts";

test("the created directory is the last root, so it cannot shadow an operator's workflow", () => {
  const roots = workflowRoots({ [WORKFLOW_DIRS_ENV]: "/a:/b" });
  expect(roots).toEqual(["/a", "/b", createdWorkflowDir({})]);
});

test("the created directory is last even when no roots are configured", () => {
  const roots = workflowRoots({});
  expect(roots).toEqual([DEFAULT_WORKFLOW_DIR, createdWorkflowDir({})]);
});

test("the operator can move the created directory", () => {
  expect(createdWorkflowDir({ [CREATED_DIR_ENV]: "/tmp/created" })).toBe("/tmp/created");
});

test("an unset created directory falls back under the home directory", () => {
  expect(createdWorkflowDir({})).toBe(join(homedir(), ".local", "share", "mcp-comfyui", "workflows"));
});

test("a created directory the operator also listed explicitly appears once", () => {
  // uniqueRoots drops repeats; the explicit entry keeps its earlier position,
  // which is the operator's stated precedence and must win.
  const roots = workflowRoots({
    [WORKFLOW_DIRS_ENV]: "/tmp/created:/b",
    [CREATED_DIR_ENV]: "/tmp/created",
  });
  expect(roots).toEqual(["/tmp/created", "/b"]);
});

test("a relative created directory is resolved to absolute like every other root", () => {
  const roots = workflowRoots({ [CREATED_DIR_ENV]: "created" });
  expect(roots[roots.length - 1]?.startsWith("/")).toBe(true);
});
