import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Environment } from "./config.ts";
import { registerTools, toolConfig } from "./tools.ts";

/**
 * The MCP server, assembled but not connected.
 *
 * Construction is kept separate from the transport so that the whole surface —
 * which tools exist, what they are annotated with, what they answer — can be
 * exercised over an in-memory transport pair with no process, no pipes and no
 * ComfyUI. `index.ts` is the only place that reaches for stdio.
 *
 * ## Nothing here may write to stdout
 *
 * Over stdio, **stdout is the JSON-RPC stream**. A single stray `console.log`
 * anywhere in this process — here, in a library module, in a debug line left
 * behind — puts a non-frame line into that stream and breaks the connection in a
 * way that is close to undiagnosable from the client's side. Diagnostics go to
 * `console.error`, which is stderr, or nowhere. `tests/server.test.ts` runs the
 * real entrypoint over real pipes and reads every byte it produces, which is the
 * only check that actually holds this.
 */

/** Identity as it appears in a client's server list. */
const SERVER_INFO = {
  name: "mcp-comfyui",
  version: "0.1.0",
  title: "ComfyUI",
} as const;

/**
 * Build the server for one environment.
 *
 * @param env  defaults to `process.env`; taken as an argument so the surface can
 * be built for a given configuration without mutating global state, the same
 * reasoning `config.ts` gives for `workflowRoots`.
 * @throws {Error} the configuration is unusable — see `toolConfig`. Deliberately
 * fatal at construction: a server that starts and then fails every call with a
 * message about an address is a much longer road to the same one-line fix.
 */
export function createServer(env: Environment = process.env): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      "Drives a local ComfyUI. The order is list_workflows -> describe_workflow -> run_workflow: " +
      "describe_workflow is the only source of the slot addresses (`3.seed`, `6.text`) that " +
      "run_workflow's inputs are keyed by. A run submitted without `wait: true` returns a " +
      "prompt_id to poll with get_job.",
  });

  registerTools(server, toolConfig(env));
  return server;
}
