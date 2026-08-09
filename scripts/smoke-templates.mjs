#!/usr/bin/env node
// Drives the built server over real stdio, the way an MCP client does.
//
// Requires network for search_templates and create_workflow_from_template,
// both of which talk to the real comfy-cli template gallery rather than to
// any ComfyUI. describe_workflow is a different story: it needs a *reachable
// ComfyUI* for /object_info, which this script does not assume exists.
//
// Two things keep a run of this script safe on a machine with no ComfyUI and
// no wish to start one:
//
//   - MCP_COMFYUI_AUTO_LAUNCH is forced to "0", so describe_workflow's own
//     object_info fetch, on failing, is never allowed to fall back to
//     launching ComfyUI (see tools.ts's withObjectInfo) — it just reports the
//     failure.
//   - MCP_COMFYUI_CREATED_DIR is pointed at a fresh, unique temp directory
//     rather than left at its real default (~/.local/share/mcp-comfyui) or a
//     fixed shared path, so nothing this script fetches ever lands on a
//     developer's real machine or collides with a concurrent run.
//
// If describe_workflow cannot reach an instance, that is reported plainly and
// this script exits non-zero — it does not throw an unhandled rejection by
// reaching into a `schema` that an error body never has.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const createdDir = mkdtempSync(join(tmpdir(), "mcp-comfyui-smoke-"));

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: {
    ...process.env,
    MCP_COMFYUI_CREATED_DIR: createdDir,
    MCP_COMFYUI_AUTO_LAUNCH: "0",
  },
});
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  const body = JSON.parse(result.content.map((c) => c.text).join("\n"));
  return { body, isError: result.isError === true };
};

let exitCode = 0;

const { body: found } = await call("search_templates", { type: "video", tag: "Image to Video", limit: 5 });
console.error(`matched ${found.matched}, showing ${found.shown}`);

const { body: made } = await call("create_workflow_from_template", { template: "video_wan2_2_14B_i2v" });
console.error(`wrote ${made.path} (${made.bytes} bytes)`);

const { body: described, isError } = await call("describe_workflow", { workflow: "video_wan2_2_14B_i2v" });
if (isError) {
  console.error(
    `describe_workflow could not run: ${described.error?.kind ?? "unknown"}: ` +
      `${described.error?.message ?? JSON.stringify(described)}`,
  );
  console.error(
    "This step needs a reachable ComfyUI for /object_info; none was reachable, and " +
      "MCP_COMFYUI_AUTO_LAUNCH=0 means this script never tried to start one. Outstanding.",
  );
  exitCode = 1;
} else {
  console.error(`settable: ${Object.keys(described.schema.properties).length}`);
  console.error(`inert:    ${described.inert.length}`);
  console.error(`inert addresses: ${described.inert.map((i) => i.address).join(", ")}`);
}

await client.close();
process.exit(exitCode);
