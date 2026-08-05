#!/usr/bin/env node
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

/**
 * Produce the Node-runnable artifact this package ships: `dist/index.js`, the
 * file `bin.mcp-comfyui` points at and the thing `npx -y mcp-comfyui` (and
 * `npm publish`'s own `prepublishOnly`) actually run.
 *
 * `bun build --target=node` is the bundler — it is only ever used as a build
 * tool here, never as the runtime the shipped file depends on — but its
 * output cannot be shipped unmodified. See `src/index.ts`'s `isMainModule`
 * doc comment for why: the bundler rewrites `import.meta.main` into a
 * `__require.main == __require.module` expression that references a binding
 * `--target=node`'s own ESM output never defines, which is why the source
 * uses a hand-written equivalent instead. What this script still has to fix
 * is the shebang: the bundler carries the *source* file's shebang
 * (`#!/usr/bin/env bun`) through verbatim regardless of `--target`, and a
 * `bun`-shebang'd file is exactly the thing this whole task exists to stop
 * requiring.
 */

const OUTFILE = "dist/index.js";
const SHEBANG = "#!/usr/bin/env node\n";

mkdirSync("dist", { recursive: true });

const build = spawnSync(
  "bun",
  ["build", "src/index.ts", "--target=node", "--format=esm", "--outfile", OUTFILE],
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
