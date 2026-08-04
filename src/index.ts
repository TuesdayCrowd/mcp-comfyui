#!/usr/bin/env bun

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.ts";

/**
 * The stdio entrypoint.
 *
 * **stdout carries the JSON-RPC protocol and nothing else.** Every diagnostic
 * below goes to `console.error`; there is no `console.log` in this file, and
 * there must not be one anywhere else in `src/` either — see `server.ts`.
 *
 * A failure here is fatal and silent to the client by necessity: the transport
 * is what would have carried an error message, and it is the thing that did not
 * come up. So the reason goes to stderr, where the MCP client's own log will
 * pick it up, and the exit code says the server did not start.
 */
async function main(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

try {
  await main();
} catch (err) {
  console.error("[mcp-comfyui] failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
}
