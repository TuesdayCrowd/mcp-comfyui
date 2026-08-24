#!/usr/bin/env node
// Drives the built server over real stdio against a REAL ComfyUI, to verify the
// one thing no fixture can prove about `run_sweep`: that a 2^64−1 seed reaches
// the SUBMITTED GRAPH byte-exact.
//
// Why the suite cannot. Every test in this repo fakes `comfy`, so the whole
// chain that carries those digits — argv text → Python's arbitrary-precision
// `int` → the variant file → the API-format prompt ComfyUI stores — is stubbed
// out at its first link. The fixtures pin that this server never parses a
// graph; only a live run pins that the value survives everything downstream of
// it. That is non-negotiable #1 end to end.
//
// The check reads ComfyUI's own `/history/<prompt_id>`, which holds the prompt
// exactly as it was submitted, and greps the RAW TEXT for the digits. It never
// calls JSON.parse on that body — doing so in this script would reintroduce the
// very rounding it exists to detect, and would report a corrupted seed as
// intact.
//
// Usage:  node scripts/smoke-sweep.mjs <host:port> [workflow] [seed-address]
//
// MCP_COMFYUI_AUTO_LAUNCH is forced to "0" so nothing is ever started on THIS
// machine while aiming at another one.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const host = process.argv[2];
const wanted = process.argv[3] ?? null;
const wantedAddress = process.argv[4] ?? null;
if (host === undefined) {
  console.error("usage: node scripts/smoke-sweep.mjs <host:port> [workflow] [seed-address]");
  process.exit(2);
}

/** 2^64−1: what ComfyUI accepts and what JavaScript cannot hold. */
const HUGE_SEED = "18446744073709551615";
/** What a JS number turns it into. Its presence anywhere is the failure. */
const ROUNDED = "18446744073709552000";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, MCP_COMFYUI_AUTO_LAUNCH: "0" },
});
const client = new Client({ name: "smoke-sweep", version: "0.0.0" });
await client.connect(transport);

const call = async (name, args, timeout = 900_000) => {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout });
  const text = result.content.map((c) => c.text).join("\n");
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { unparsed: text };
  }
  return { body, isError: result.isError === true };
};

const show = (label, value) => console.error(`  ${label.padEnd(24)} ${value}`);
let failures = 0;
const check = (ok, label, detail) => {
  console.error(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : ` — ${detail}`}`);
  if (!ok) failures += 1;
};

// --- 1. the host answers --------------------------------------------------
console.error("\n[1] comfy_status");
const { body: status, isError: statusErr } = await call("comfy_status", { host });
if (statusErr) {
  console.error("  unreachable:", JSON.stringify(status).slice(0, 300));
  process.exit(1);
}
show("running", status.running);
show("version", status.version ?? "(unreported)");
show("target.local", status.target?.local);

// --- 2. a workflow with a seed --------------------------------------------
console.error("\n[2] list_workflows / describe_workflow");
const { body: listed } = await call("list_workflows", { host });
const names = (listed.workflows ?? []).map((w) => w.name);
show("count", names.length);
const name = wanted ?? names[0];
if (name === undefined) {
  console.error("  no workflow to sweep");
  process.exit(1);
}
show("workflow", name);

const { body: described, isError: describeErr } = await call("describe_workflow", {
  workflow: name,
  host,
});
if (describeErr) {
  console.error("  describe failed:", JSON.stringify(described).slice(0, 400));
  process.exit(1);
}
const properties = described.schema?.properties ?? {};
// A settable INT address whose name says seed. `describe_workflow` has already
// excluded every inert one, so anything here is an address `set-slot` can
// really reach — which is the distinction ground truth #15/#26 exist for.
const seedAddress =
  wantedAddress ??
  Object.keys(properties).find((address) => /(^|\.)(noise_)?seed$/.test(address));
if (seedAddress === undefined) {
  console.error(`  no settable seed address among: ${Object.keys(properties).join(", ")}`);
  process.exit(1);
}
show("seed address", seedAddress);
show("settable slots", Object.keys(properties).length);
show("inert slots", (described.inert ?? []).length);

// --- 3. the sweep ---------------------------------------------------------
// Three variants, the first carrying 2^64−1 as a STRING of digits — the
// documented way to spell an integer above 2^53 — and two ordinary seeds
// beside it, so the run also proves the list is zipped rather than crossed.
console.error("\n[3] run_sweep");
const { body: sweep, isError: sweepErr } = await call("run_sweep", {
  workflow: name,
  host,
  inputs: { [seedAddress]: [HUGE_SEED, 12345, 67890] },
});
if (sweepErr) {
  console.error("  sweep failed:", JSON.stringify(sweep).slice(0, 800));
  process.exit(1);
}
show("variant_count", sweep.variant_count);
show("runs", (sweep.runs ?? []).length);
show("failed", (sweep.failed ?? []).length);
for (const run of sweep.runs ?? []) {
  show(`  variant ${run.variant}`, `${run.prompt_id}  ${JSON.stringify(run.values)}`);
}
if ((sweep.failed ?? []).length > 0) {
  console.error("  failures:", JSON.stringify(sweep.failed).slice(0, 600));
}
check(sweep.variant_count === 3, "three variants were produced (zipped, not crossed)");
check((sweep.runs ?? []).length === 3, "three runs were submitted");

const ids = (sweep.runs ?? []).map((run) => run.prompt_id);
check(new Set(ids).size === ids.length, "every variant got its own prompt_id");

// The response must not carry the rounded value anywhere, at any depth.
check(!JSON.stringify(sweep).includes(ROUNDED), "no rounded seed anywhere in the answer");
check(JSON.stringify(sweep).includes(HUGE_SEED), "the exact digits are echoed back in `values`");

// --- 4. THE check: the submitted graph, read as raw text ------------------
// ComfyUI's /history holds the prompt as submitted. Read as TEXT and searched
// as text: parsing it here would round the very value under test.
console.error("\n[4] the submitted graph on the host");
const base = `http://${host}`;
const first = ids[0];
let historyText = "";
for (let attempt = 0; attempt < 90 && historyText.length < 10; attempt += 1) {
  const response = await fetch(`${base}/history/${first}`);
  historyText = await response.text();
  if (historyText.length > 10 && historyText !== "{}") break;
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}
show("history bytes", historyText.length);
check(historyText.includes(HUGE_SEED), `${HUGE_SEED} is in the submitted graph, byte-exact`);
check(!historyText.includes(ROUNDED), `${ROUNDED} appears nowhere`);

// --- 5. the ledger placed every id, with no host argument ----------------
console.error("\n[5] get_job with no host");
for (const id of ids) {
  const { body: job, isError } = await call("get_job", { prompt_id: id });
  check(!isError && job.prompt_id === id, `get_job ${id} answered without being told the host`, job.host_source);
}

console.error(`\n${failures === 0 ? "OK" : `${failures} FAILURE(S)`}`);
await client.close();
process.exit(failures === 0 ? 0 : 1);
