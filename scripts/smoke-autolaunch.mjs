// Prove the server finds comfy-cli and launches ComfyUI with NOTHING supplied.
//
// Unlike every other harness here, this one leaves MCP_COMFYUI_AUTO_LAUNCH at
// its default (on) -- it exists to test auto-launch, so disabling it would
// test nothing. It WILL start a GPU process. Run `deno task build && deno task
// compile` first, or you are testing the previous build.
//
// Usage: node scripts/smoke-autolaunch.mjs [workflow]
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "dist", "mcp-comfyui");
const WORKFLOW = process.argv[2] ?? "image_z_image_turbo";

// The whole point: a GUI client's bare launchd PATH, no COMFY_BIN.
const ENV = { HOME: homedir(), PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

const proc = spawn(BIN, [], { stdio: ["pipe", "pipe", "pipe"], env: ENV });
proc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

let buf = "";
let nextId = 1;
const pending = new Map();
proc.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    const r = pending.get(m.id);
    if (r) { pending.delete(m.id); r(m); }
  }
});
const rpc = (method, params) =>
  new Promise((res) => {
    const id = nextId++;
    pending.set(id, res);
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
const call = async (name, args) => {
  const m = await rpc("tools/call", { name, arguments: args });
  const text = m.result?.content?.[0]?.text ?? "";
  try { return { isError: m.result?.isError ?? false, data: JSON.parse(text) }; }
  catch { return { isError: true, data: { raw: text } }; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "smoke-autolaunch", version: "0" },
});

// Criterion 4: the resolution is reported, and it came from discovery.
const status = await call("comfy_status", {});
check("comfy_status reports a cli block", status.data.cli !== undefined);
check("the binary was discovered, not configured", status.data.cli?.source === "discovered",
  `source=${status.data.cli?.source}`);
check("the child PATH was repaired", status.data.cli?.path_repaired === true);
check("nothing is running yet", status.data.running === false,
  "stop ComfyUI first -- `comfy stop` -- or this proves nothing");

// Criterion 1: a cold auto-launch with an empty env.
const started = Date.now();
const run = await call("run_workflow", { workflow: WORKFLOW, wait: false });
check("run_workflow was accepted", !run.isError, JSON.stringify(run.data).slice(0, 300));
const promptId = run.data.prompt_id;
check("a prompt_id came back", typeof promptId === "string");
if (promptId === undefined) { proc.kill(); process.exit(1); }

let job;
for (let n = 0; n < 120; n++) {
  await sleep(5000);
  job = await call("get_job", { prompt_id: promptId });
  if (job.data.terminal === true) break;
}
const elapsed = ((Date.now() - started) / 1000).toFixed(1);
check("the job completed", job?.data.status === "completed", `status=${job?.data.status} in ${elapsed}s`);

// Criterion 3: local_paths is populated and the file really exists.
const localPaths = job?.data.outputs?.local_paths ?? {};
const paths = Object.values(localPaths);
check("local_paths is populated", paths.length > 0, JSON.stringify(localPaths).slice(0, 300));
for (const p of paths) {
  check(`the artifact exists: ${p}`, existsSync(p) && statSync(p).size > 0);
}

proc.kill();
console.log(failures.length === 0 ? "\nAll checks passed." : `\n${failures.length} FAILED`);
process.exit(failures.length === 0 ? 0 : 1);
