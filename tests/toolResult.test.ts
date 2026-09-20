import { expect, test } from "./support/testing.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describeError } from "../src/toolResult.ts";

const REPO_ROOT = join(import.meta.dirname, "..");

/**
 * `binary.ts`'s `isExecutable` now rethrows `NotCapable` instead of
 * swallowing it (ground truth: the auto-discovery live-verification entry in
 * CLAUDE.md), and `instance.ts`'s `isVerdict` now treats it as terminal
 * during a launch -- both changes depend on this classification arm existing
 * and staying accurate, and nothing pinned it before this test: no test file
 * imported from `toolResult.ts` at all.
 *
 * Same shape as `server.test.ts`'s `SERVER_VERSION`-vs-manifest test: read
 * the real `deno.json`, and assert the code agrees with it, so the advice
 * string cannot silently drift from the grant it is describing.
 */
test("a NotCapable error classifies as permission_denied and names every token deno.json's compile task grants", () => {
  const notCapable = new Error('Requires sys access to "uid", run again with the --allow-sys flag');
  notCapable.name = "NotCapable";

  const body = describeError(notCapable);
  expect(body.kind).toBe("permission_denied");

  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "deno.json"), "utf8")) as {
    tasks: Record<string, string>;
  };
  const compileTask = manifest.tasks.compile;
  const match = compileTask?.match(/--allow-sys=(\S+)/);
  if (match === undefined || match === null) {
    throw new Error("deno.json's compile task has no --allow-sys flag to compare against");
  }
  const grantedTokens = match[1]!.split(",");
  expect(grantedTokens.length).toBeGreaterThan(0); // the split itself is not vacuously true

  for (const token of grantedTokens) {
    expect(body.message).toContain(token);
  }
});

test("a non-NotCapable error is not misclassified as permission_denied", () => {
  const ordinary = new Error("something else went wrong");
  const body = describeError(ordinary);
  expect(body.kind).not.toBe("permission_denied");
});
