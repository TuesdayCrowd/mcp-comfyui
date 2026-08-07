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
 * This script still has to fix the shebang: `deno bundle` carries the
 * *source* file's own shebang through verbatim regardless of `--platform`
 * (measured directly — a `--platform=deno` bundle of `src/index.ts`, whose
 * own shebang is `#!/usr/bin/env -S deno run ...`, still starts with that
 * same line), so the shebang this project ships has to be rewritten to
 * `#!/usr/bin/env node` before publish. This project's former Bun bundler
 * had the identical behaviour and needed the identical fix; the step
 * survived the migration to `deno bundle` unchanged.
 */

const OUTFILE = "dist/index.js";
const SHEBANG = "#!/usr/bin/env node\n";

/**
 * `dist/` describes its own module format.
 *
 * `dist/index.js` is ESM, and Node decides whether a `.js` file is ESM from the
 * **nearest** `package.json` — so without this it depends on a manifest two
 * directories up that is never shipped beside it. That worked while the repo
 * root had one; it stopped being true the moment this project consolidated on
 * `deno.json`, and it was always fragile for anyone copying the file elsewhere.
 *
 * Measured, and the reason this is not merely tidiness: Node 22.7 and later
 * detect module syntax on their own, so the missing manifest is invisible
 * there — `node dist/index.js` simply works. Node 18 and 20, which
 * `engines.node` has always claimed, do not: they fail with
 * `SyntaxError: Cannot use import statement outside a module`. A defect that
 * only appears on the older half of the supported range is exactly the kind
 * that ships.
 */
const MANIFEST = "dist/package.json";

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

writeFileSync(MANIFEST, `${JSON.stringify({ type: "module" }, null, 2)}\n`);

console.log(`built ${OUTFILE}`);
