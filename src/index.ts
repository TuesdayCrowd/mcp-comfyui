#!/usr/bin/env bun

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, isJSONRPCErrorResponse, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
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
 *
 * ## Hardening the transport
 *
 * Two defects in how `@modelcontextprotocol/sdk` 1.30.0's `StdioServerTransport`
 * behaves by default are patched here rather than left to the SDK:
 *
 * 1. **A oversized line kills the connection with nothing anywhere saying
 *    why.** `ReadBuffer.append()` (`dist/esm/shared/stdio.js`) throws once
 *    buffered bytes exceed its `maxBufferSize` — *before* it has looked for a
 *    newline, so a single huge line (or a client that never terminates one)
 *    cannot grow the buffer without bound. `StdioServerTransport`'s own
 *    `_ondata` catches that throw, calls `this.onerror?.(...)` — a no-op
 *    unless something sets it — and then `close()`s, which removes the stdin
 *    listener and pauses stdin. With no other open handle, the event loop
 *    drains and the process exits 0: a client sees the connection simply
 *    stop. {@link MAX_BUFFER_SIZE} raises the ceiling past this server's own
 *    measured maxima, and the `onerror` assignment below makes whatever still
 *    crosses it loud on stderr instead of silent. The overflow-closes-the-
 *    connection behaviour itself is the SDK's; it cannot be made recoverable
 *    without wrapping the transport's read side, which is a larger change
 *    than this file makes.
 *
 * 2. **A malformed request reads as a claim that this server is broken.**
 *    `Protocol.setRequestHandler`'s wrapper (`dist/esm/shared/protocol.js`)
 *    runs `parseWithCompat` (`dist/esm/server/zod-json-schema-compat.js`)
 *    against every incoming request *before* any handler — including the one
 *    `Server.setRequestHandler` installs specifically to map a bad
 *    `tools/call` to `InvalidParams` — ever runs, and throws the raw Zod
 *    result on failure rather than a schema-shaped one. The generic
 *    per-request catch then reports it as `ErrorCode.InternalError` with
 *    `.message` set to the `ZodError`'s own `.message`, which for zod 4 is
 *    `JSON.stringify(issues, null, 2)`: a caller sees `-32603` — "this server
 *    has a bug" — and a JSON dump of zod internals, for what is in every
 *    reproduced case its own malformed request. Neither a `fallbackRequestHandler`
 *    nor the SDK's `onerror` sees this response before it is sent — it is
 *    built and handed straight to `transport.send()` inside `_onrequest`'s
 *    promise chain — so {@link remapValidationError} is applied by wrapping
 *    `transport.send` itself, which is the only seam available without
 *    reimplementing the SDK's request dispatch.
 */

/**
 * The largest single line this transport will buffer before refusing it.
 *
 * The SDK's own default (`STDIO_DEFAULT_MAX_BUFFER_SIZE` in
 * `dist/esm/shared/stdio.js`) is 10 MiB. Rather than keep that round number,
 * this is sized against this server's own two largest legitimate JSON-RPC
 * frames, measured directly (see the report for the harness):
 *
 * - `describe_workflow` on `tests/fixtures/slots.6key.json` — a real,
 *   captured 210-slot, 11 node-type, 122KB video workflow — produced a
 *   70,407-byte frame.
 * - `list_workflows` over a directory of 20,000 workflow files (roughly 900x
 *   this deployment's real 22, per `docs/comfy-cli-ground-truth.md`) produced
 *   a 6,180,258-byte frame.
 *
 * `maxBufferSize` only gates the *read* side (stdin, client → server); it has
 * no effect on this server's own outgoing responses, which `send()` writes to
 * stdout unbounded regardless of this setting. The 20,000-file measurement —
 * the more extreme of the two, and already far beyond anything this
 * deployment's real workflow directory would ever hold — is used as the best
 * available evidence of what a large-but-legitimate message on this pipe
 * looks like. 16 MiB keeps roughly 2.7x headroom above that measurement (and
 * comfortably clears the ~11.5MB payload that originally reproduced this
 * finding), while still refusing an unbounded flood.
 */
export const MAX_BUFFER_SIZE = 16 * 1024 * 1024; // 16 MiB

/** One issue from a Zod validation failure, as far as this module needs its shape. */
interface ZodIssueShape {
  readonly message: string;
  readonly path?: ReadonlyArray<string | number>;
}

function isZodIssueShape(value: unknown): value is ZodIssueShape {
  return (
    typeof value === "object" && value !== null && typeof (value as { message?: unknown }).message === "string"
  );
}

/**
 * The SDK's raw `JSON.stringify(issues, null, 2)` dump, reduced to one
 * semicolon-joined line naming the field and the problem — or `null` when
 * `message` is not that dump, so {@link remapValidationError} can leave every
 * other error exactly as the SDK produced it.
 *
 * Recognised structurally (a non-empty JSON array whose entries all carry a
 * `message`), not by which request method produced it: `parseWithCompat` runs
 * ahead of every registered handler, not just `tools/call`'s, so the same raw
 * dump is what a malformed `tools/list`, `initialize` or any other request
 * produces too.
 */
export function describeValidationFailure(message: string): string | null {
  let issues: unknown;
  try {
    issues = JSON.parse(message);
  } catch {
    return null;
  }
  if (!Array.isArray(issues) || issues.length === 0 || !issues.every(isZodIssueShape)) {
    return null;
  }
  return issues
    .map((issue) => {
      const path = issue.path !== undefined && issue.path.length > 0 ? issue.path.join(".") : null;
      return path === null ? issue.message : `${path}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * Reclassify the SDK's `InternalError`-for-a-malformed-request as what it
 * actually is: a bad request from the caller, not a fault in this server.
 * `-32603` is a claim that this server has a bug; a `null` or non-object
 * `arguments`, a missing `name`, or an omitted `params` is the caller's own
 * mistake and should say so with `-32602` (`InvalidParams`) and a message a
 * caller can act on instead of a Zod internals dump.
 *
 * Only rewrites the specific shape {@link describeValidationFailure}
 * recognises. Every other error — including a genuine internal error whose
 * message happens to be unrelated JSON — is returned unchanged, because an
 * `InternalError` this function does not recognise might really mean this
 * server has a bug, and relabelling that as the caller's mistake would send a
 * caller round a retry loop it can never win.
 */
export function remapValidationError(message: JSONRPCMessage): JSONRPCMessage {
  if (!isJSONRPCErrorResponse(message) || message.error.code !== ErrorCode.InternalError) {
    return message;
  }
  const friendly = describeValidationFailure(message.error.message);
  if (friendly === null) return message;
  return {
    ...message,
    error: { ...message.error, code: ErrorCode.InvalidParams, message: `Invalid request: ${friendly}` },
  };
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport(undefined, undefined, { maxBufferSize: MAX_BUFFER_SIZE });

  // See "Hardening the transport" (1) above: without this, a transport-level
  // failure is a no-op followed by a silent close.
  transport.onerror = (error) => {
    console.error("[mcp-comfyui] transport error, connection closing:", error.message);
  };

  // See "Hardening the transport" (2) above: rewrite only the specific
  // outgoing shape the SDK produces for a pre-handler validation failure.
  // `StdioServerTransport.send` itself takes no `options` (stdio has no
  // resumption tokens to carry); `_options` exists only so this wrapper still
  // satisfies `Transport.send`'s two-parameter signature.
  const rawSend = transport.send.bind(transport);
  transport.send = (message: JSONRPCMessage, _options?: TransportSendOptions) =>
    rawSend(remapValidationError(message));

  await server.connect(transport);
}

/**
 * Whether this module is the one `node`/`bun` was actually asked to run, as
 * opposed to merely imported — the same question `import.meta.main` answers
 * natively on both runtimes (verified directly: true when run, false when
 * imported, on Node v26.5.1 and on Bun, including through the shebang'd,
 * symlinked file npm's `bin` mechanism installs). It is reimplemented here
 * rather than used directly because `bun build --target=node` — the tool that
 * produces the artifact this project ships — rewrites `import.meta.main` into
 * `__require.main == __require.module`, referencing a `__require` binding
 * `--target=node`'s own ESM output never defines; every real invocation of
 * the built bundle would throw a `ReferenceError` before it could even reach
 * `main()`. `import.meta.url` and `node:fs`/`node:url` are ordinary runtime
 * values the bundler has no special-cased rewrite for, so this survives the
 * same build unchanged (checked directly against the built `dist/index.js`).
 *
 * `realpathSync` on `process.argv[1]` matters as much as `import.meta.url`
 * itself: Node resolves the entry module's URL through any symlink, but
 * leaves `process.argv[1]` as the literal path the shell invoked — exactly
 * npm's own `bin` symlink — so a strict-equality comparison without it would
 * read a normal `npx`/global install as "merely imported" and never start.
 *
 * The `catch` matters too, and for a different runtime this project also has
 * to support: `tests/server.test.ts` exercises the real entrypoint by
 * compiling it with `bun build --compile`, and inside that standalone binary
 * both `import.meta.url` and `process.argv[1]` are a virtual path —
 * `/$bunfs/root/<name>` — that is not a real file on disk at all, so
 * `realpathSync` throws `ENOENT` on it (verified directly). There is nothing
 * to resolve in that case; the two virtual paths already match textually.
 */
function isMainModule(): boolean {
  if (process.argv[1] === undefined) return false;
  const here = fileURLToPath(import.meta.url);
  try {
    return here === realpathSync(process.argv[1]);
  } catch {
    return here === process.argv[1];
  }
}

// Guarded so this module can be imported for its pure exports (as
// `tests/index.test.ts` does) without attaching real stdin/stdout listeners.
if (isMainModule()) {
  try {
    await main();
  } catch (err) {
    console.error("[mcp-comfyui] failed to start:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
