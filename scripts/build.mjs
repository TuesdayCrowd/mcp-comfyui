#!/usr/bin/env node
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

/**
 * Produce the Node-runnable artifact this package ships: `dist/index.js`, the
 * file `bin.mcp-comfyui` points at and the thing `npx -y mcp-comfyui` (and
 * `npm publish`'s own `prepublishOnly`) actually run.
 *
 * `deno bundle` is the bundler — it is only ever used as a build tool here,
 * never as the runtime the shipped file depends on. Measured directly:
 * `deno bundle --platform=deno` (the only platform choices are `browser` and
 * `deno` — there is no `node` target, and none is needed) produces a plain
 * ESM file that runs correctly under `node`, because nothing in `src/` uses a
 * Deno-only global; every runtime touchpoint goes through `node:*` imports
 * (see `src/comfy/exec.ts`) or web-standard APIs (`fetch`, `URL`,
 * `AbortSignal`) available in both.
 *
 * This script still has to fix the shebang, exactly as it did under Bun:
 * `deno bundle` carries the *source* file's shebang through verbatim
 * regardless of `--platform` (measured directly — a `--platform=deno` bundle
 * of a file shebang'd `#!/usr/bin/env bun` still starts with that same
 * line), so the shebang this project ships has to be rewritten same as
 * before.
 */

const OUTFILE = "dist/index.js";
const SHEBANG = "#!/usr/bin/env node\n";

mkdirSync("dist", { recursive: true });

const build = spawnSync(
  "deno",
  ["bundle", "--platform=deno", "--format=esm", "--no-check", "-o", OUTFILE, "src/index.ts"],
  { stdio: "inherit" },
);
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const built = readFileSync(OUTFILE, "utf8");
const firstNewline = built.indexOf("\n");
const body = built.startsWith("#!") && firstNewline !== -1 ? built.slice(firstNewline + 1) : built;
writeFileSync(OUTFILE, SHEBANG + body);
// npm makes `bin` entries executable on install, but the file must already be
// runnable directly (`./dist/index.js`) and for `tests/server.test.ts`-style
// checks that stat it before any `npm install` has touched it.
chmodSync(OUTFILE, 0o755);

console.log(`built ${OUTFILE}`);
