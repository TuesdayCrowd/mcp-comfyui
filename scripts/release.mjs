#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Bump the version everywhere it lives, in one step.
 *
 * `deno bump-version` rewrites `deno.json` and nothing else, but this package
 * carries the same number in two other places: `SERVER_VERSION` in
 * `src/server.ts` — a deliberate literal rather than an import of the manifest,
 * for the three-channel reason spelled out above it there — and the CHANGELOG's
 * `[Unreleased]` heading, which a release turns into a dated section.
 *
 * Forgetting the second one is not hypothetical: `SERVER_VERSION` and the
 * manifest drifted apart for four releases before `tests/server.test.ts` started
 * pinning them together. This script exists so the three cannot disagree in the
 * first place, and it re-reads all three at the end rather than trusting its own
 * edits.
 *
 * It edits files and stops. It does not commit, push, or publish — JSR refuses
 * to republish a version number, so a spent one is spent, and the diff is worth
 * a human's eyes before it becomes a tag. The next steps are printed at the end.
 *
 * Usage:  deno task release patch | minor | major | prepatch | preminor | premajor | prerelease
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(ROOT, "deno.json");
const SERVER = join(ROOT, "src", "server.ts");
const CHANGELOG = join(ROOT, "CHANGELOG.md");

/**
 * The increments `deno bump-version` accepts. Closed deliberately, unlike this
 * project's CLI-facing registries: these are this script's own argument, not a
 * vocabulary upstream can extend behind our back, and a typo that reached
 * `bump-version` unchecked would land in the conventional-commits mode below.
 */
const INCREMENTS = ["major", "minor", "patch", "premajor", "preminor", "prepatch", "prerelease"];

const UNRELEASED = "## [Unreleased]";

function die(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

/**
 * `spawnSync` reports a binary that could not be started in `error`, not in
 * `status` — which is `null` in that case, and `stderr` is never populated
 * because there was no child to capture anything from. A bare `status !== 0`
 * test therefore catches the failure but has nothing to say about it, and
 * exiting on it prints nothing at all. That is the one failure mode this script
 * exists to prevent, so it is worth the four lines.
 */
function ranOrDie(what, result) {
  if (result.error) {
    die(`could not run \`${what}\`: ${result.error.code ?? result.error.message}`);
  }
  return result;
}

/**
 * An explicit increment is required, and this is the reason rather than mere
 * strictness: `deno bump-version` with no increment switches to
 * conventional-commits mode, where it derives the bump from git history AND
 * prepends a release note to `Releases.md` — a file this project does not use
 * and whose appearance would go unnoticed. Refusing the bare form keeps that
 * mode unreachable from here.
 */
const increment = process.argv[2];
if (increment === undefined) {
  die(`an increment is required: ${INCREMENTS.join(" | ")}\n` +
    "  A bare `deno bump-version` would derive one from git history and write Releases.md,\n" +
    "  which this project does not use.");
}
if (!INCREMENTS.includes(increment)) {
  die(`unknown increment ${JSON.stringify(increment)}; expected one of ${INCREMENTS.join(", ")}`);
}

/**
 * Only the three files this script edits are checked, not the whole tree. A
 * blanket clean-tree requirement would refuse to run on a working copy holding
 * any unrelated edit, which is the normal state of this repo; what actually
 * matters is that the release commit is not mixed with a half-finished change to
 * the same files.
 */
const dirty = ranOrDie("git status", spawnSync(
  "git",
  ["status", "--porcelain", "--", "deno.json", "src/server.ts", "CHANGELOG.md"],
  { cwd: ROOT, encoding: "utf8" },
));
if (dirty.status !== 0) {
  die(`git status exited ${dirty.status}: ${dirty.stderr?.trim() || "no output"}`);
}
if (dirty.stdout.trim() !== "") {
  die("these files have uncommitted changes; commit or discard them first so the\n" +
    "  release edits stand alone:\n" +
    dirty.stdout.trimEnd().split("\n").map((line) => `    ${line.trim()}`).join("\n"));
}

/**
 * A release with no notes is a release nobody can read. This project's
 * convention is to log each change to `[Unreleased]` as it lands, so a missing
 * section means nothing was logged rather than that nothing changed — worth
 * stopping for. There is deliberately no override: an intentional no-notes
 * release can add an empty section by hand, which is a decision someone made on
 * purpose rather than a flag that gets pasted into muscle memory.
 */
const changelogBefore = readFileSync(CHANGELOG, "utf8");
const unreleasedCount = changelogBefore.split("\n").filter((l) => l.trim() === UNRELEASED).length;
if (unreleasedCount === 0) {
  die(`CHANGELOG.md has no "${UNRELEASED}" section.\n` +
    "  Log what this release contains under that heading first — the convention here is\n" +
    "  to write the entry as each change lands, not at release time.");
}
if (unreleasedCount > 1) {
  die(`CHANGELOG.md has ${unreleasedCount} "${UNRELEASED}" headings; expected exactly one.`);
}

const versionBefore = JSON.parse(readFileSync(MANIFEST, "utf8")).version;

const bump = ranOrDie(
  `deno bump-version ${increment}`,
  spawnSync("deno", ["bump-version", increment], { cwd: ROOT, stdio: "inherit" }),
);
if (bump.status !== 0) {
  // Its own output went straight to the terminal via `stdio: "inherit"`, so
  // repeating it here would only be noise — but say that nothing was written.
  die(`deno bump-version exited ${bump.status}; no files were changed`);
}

/**
 * The new version is read back from the manifest rather than parsed out of
 * `bump-version`'s stdout. Its output is prose, it prints an experimental-command
 * warning alongside it, and the file it just wrote is the authority anyway.
 */
const version = JSON.parse(readFileSync(MANIFEST, "utf8")).version;
if (typeof version !== "string" || version === "") {
  die("deno.json has no usable version after the bump");
}
if (version === versionBefore) {
  die(`deno.json still reads ${versionBefore} after the bump; nothing was changed`);
}

/** Anchored on the exact declaration so a version-looking string elsewhere cannot match. */
const SERVER_VERSION_RE = /^(export const SERVER_VERSION = ")([^"]*)(";)$/m;
const serverBefore = readFileSync(SERVER, "utf8");
if (!SERVER_VERSION_RE.test(serverBefore)) {
  die(`could not find \`export const SERVER_VERSION = "…";\` in src/server.ts.\n` +
    "  deno.json has already been bumped — revert it, or fix that declaration, before retrying.");
}
writeFileSync(SERVER, serverBefore.replace(SERVER_VERSION_RE, `$1${version}$3`));

/**
 * The **local** date, not `toISOString`'s UTC one, in the ISO shape the existing
 * headings use (`## [0.6.10] — 2026-08-15`, em dash included).
 *
 * Measured while testing this script: run at 19:40 US Central it dated the
 * release `2026-08-20`, because UTC had already rolled over. A changelog date is
 * a human record of the day someone cut the release, so an evening release in
 * the Americas being stamped tomorrow is simply wrong. `en-CA` is the locale
 * whose short date already *is* `YYYY-MM-DD`.
 */
const released = new Date().toLocaleDateString("en-CA");
const heading = `## [${version}] — ${released}`;
writeFileSync(CHANGELOG, changelogBefore.replace(UNRELEASED, heading));

/**
 * Re-read everything from disk. The point of this script is that the three
 * cannot disagree, and trusting the writes above to have done what they were
 * told is exactly the assumption that let them drift for four releases.
 */
const checks = [
  ["deno.json", JSON.parse(readFileSync(MANIFEST, "utf8")).version],
  ["src/server.ts", readFileSync(SERVER, "utf8").match(SERVER_VERSION_RE)?.[2]],
  // Searched for as the exact string this run wrote, rather than "whichever
  // `## [x] — ` heading comes first". Those are the same thing only because
  // `[Unreleased]` conventionally sits at the top of the file; matching the
  // literal removes the assumption instead of relying on it.
  ["CHANGELOG.md", readFileSync(CHANGELOG, "utf8").includes(heading) ? version : "no heading for this release"],
];
const disagree = checks.filter(([, found]) => found !== version);
if (disagree.length > 0) {
  die("the three did not end up in step — nothing here is committed, so fix and retry:\n" +
    checks.map(([file, found]) => `    ${file}: ${found ?? "not found"}`).join("\n") +
    `\n  expected ${version} everywhere`);
}

console.log(`
released ${versionBefore} -> ${version}

  deno.json       "version": "${version}"
  src/server.ts   SERVER_VERSION = "${version}"
  CHANGELOG.md    ## [${version}] — ${released}

Next:
  but diff                              # review the three files
  but commit -b release-${version} -m "chore: release ${version}" <ids>
  but pr new release-${version} -t
  gh run list --workflow=publish.yml    # a green merge is not a published release
`);
