# Multi-host support

**Status:** design agreed, not implemented
**Date:** 2026-08-06

The server talks to one ComfyUI, chosen when the process starts. It must talk to
any of several — a local Desktop instance plus remote boxes reached over
Tailscale — chosen per call.

## Why now

A session asked this server to list the workflows at `http://100.86.199.90:8189/`.
It could not. `comfy_status` reported `127.0.0.1:8188`, because `toolConfig(env)`
runs once (`src/tools.ts:113`, called from `src/server.ts:50`) and every handler
closes over that frozen `{host, port}` pair (`src/tools.ts:85-89`) for the life of
the process. No tool schema has a host field. Retargeting means editing the MCP
client's env block and restarting.

## Ground truth

Every fact below was measured in this session. Commands are recorded so the next
reader pays for them once, as `docs/comfy-cli-ground-truth.md` intends.

**comfy-cli targets a remote host, per subcommand.** `--host` and `--port` appear
in `comfy run --help`, `comfy workflow slots --help`, `comfy workflow set-slot
--help`, and `comfy jobs ls|status|cancel --help`. They follow the subcommand,
unlike `--json` and `--skip-prompt`, which precede it (non-negotiable #4). Both
orderings now appear in one argv.

`comfy --json jobs ls --host 100.86.199.90 --port 8189 --limit 3` returned three
jobs from the remote box. A control against a black-holed address,
`--host 10.255.254.1`, hung until `timeout 15` killed it, proving the flag drives a
real outbound call rather than being ignored.

**`comfy launch` accepts no `--host` or `--port`.** It starts a process on the
machine running `comfy`. Launching a remote ComfyUI is not a comfy-cli capability
and never will be from here.

**comfy-cli does not attribute jobs to hosts.** Job records carry
`[outputs, prompt_id, queue_position, status, updated_at, where, workflow_path,
workflow_size]`. The `host` and `port` in the envelope's `data` echo the flag
passed on the command line: with no flag, `jobs ls` reports `127.0.0.1:8188`; with
`--host 100.86.199.90`, it reports that instead, over the same 39 records.

**Asking the wrong host about a real job answers `prompt_not_found`.**
`comfy --json jobs status 25e9540a-… --host 100.86.199.90 --port 8189` returned
that error confidently. The job is real; this server submitted it against local
`8188`, and its `workflow_path` still points at a `mcp-comfyui-apply-<uuid>` temp
directory. A wrong guess is indistinguishable from a missing job.

**`jobs cancel` short-circuits on comfy-cli's own local records.** It returns
`no local job with id '…'`, where `jobs status` returns `No prompt with id '…' on
100.86.199.90:8189`. Two different failures, and a caller must not confuse them.

**ComfyUI's userdata API streams raw file bytes.** `GET /api/userdata/<file>` on
the remote returned exactly the 126 bytes the listing declared, preserving four
Windows `\r\n` sequences and the original indentation. A JSON round-trip on the
server could preserve neither. A remote workflow can therefore be fetched
byte-exactly, and landmine #1's 2^64−1 seed survives the transfer.

**The remote at `100.86.199.90:8189` holds no saved workflows.** Both
`/api/userdata?dir=workflows&recurse=true` and the v2 endpoint returned `[]`, while
the same request against a running local instance returned a non-empty list. Its
`comfy.settings.json` is 126 bytes. It is a fresh install.

**`objectInfo.ts` already keys its cache per host.** Line 183 builds
`object_info-${host}-${port}.json`. Per-host node definitions are correct today; the
RTX box's model lists could never have contaminated the Mac's.

## Two defects found while designing

**A remote host that does not answer makes this machine launch ComfyUI.**
`performLaunch` (`src/comfy/instance.ts:842-882`) performs one refusal check —
`detectInstance` against the target address (`:850`) — then spawns `comfy launch`
locally and unconditionally (`:855`). Nothing asks whether `target.host` is this
machine. Point the server at a sleeping remote and it probes the remote, starts a
local ComfyUI on `8188`, polls `100.86.199.90:8189` until the budget expires,
throws `LaunchTimeoutError`, and leaves the local process running — `--background`
detached it already.

Each piece is correct alone. `launchTarget` reads the real listen address so
readiness is polled where the server will bind; the address-keyed guard correctly
lets two different addresses launch at once. The defect lives at the seam, where
nothing owns the question *is this address mine to launch?* Multi-host does not
create it. Multi-host makes it routine: today it takes a deliberate
misconfiguration, afterward it takes a box being asleep.

**CLAUDE.md contradicts the code it documents.** It describes "the single global
in-flight launch in `instance.ts`, deliberately *not* keyed by address."
`instance.ts:772` keys the map by `authority(target.host, target.port)`, and the
comment at `:790-810` argues for that: "One per address, not one globally." The
code is right. Fix the doc.

## Decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Host selection | Named registry, optional `host` per call, raw address accepted |
| 2 | Workflow sources | Local library **and** each host's own files |
| 3 | Registry location | JSON config file |
| 4 | Auto-launch rule | Launch only an address proven to be on this machine |
| 5 | Job attribution | Server records `prompt_id → host`; explicit `host` overrides |
| 6 | Remote artifacts | URLs by default; download only when asked |
| 7 | Registry writes | One `manage_hosts` tool: add, update, remove, set_default, repair |
| 8 | Malformed file | Tolerant read plus an explicit repair action |

## Architecture

Host resolution moves from process start to each call. That single change carries
the rest.

One new module, `src/hosts.ts`, sits beside `config.ts` and below `comfy/`.
Dependency direction stays one-way. It owns four jobs:

1. Load, validate, and **write** `hosts.json` — the only place a file format lives.
2. Resolve a name or a raw address to a `Target`.
3. Answer whether an address belongs to this machine, via `os.networkInterfaces()`.
4. Repair a file it could not strictly parse.

`config.ts` does not grow this. Its own comment says nothing there should grow a
file format "until something actually needs one" (`src/config.ts:9-10`); eight hosts
carrying per-host policy is that moment, and isolating the format in `hosts.ts`
keeps `config.ts` what it advertises — pure functions over an environment record.
`MCP_COMFYUI_HOST` and `MCP_COMFYUI_PORT` still set the default host's address, so
every existing configuration keeps working.

The locality helper earns its own home because two callers need it for unrelated
reasons: the launch guard asks whether it may spawn a process, and `outputs.ts` asks
whether it may stat a path. `src/comfy/target.ts:2-10` records what happens
otherwise — two copies of host logic in this repo diverged once already, over IPv6
bracket stripping.

`ToolConfig`'s flat `host`/`port` pair becomes a registry plus a default name. Each
handler resolves its target when it runs.

## The registry file

`~/.config/mcp-comfyui/hosts.json`, overridable by `MCP_COMFYUI_HOSTS_FILE`.

```json
{
  "default": "mac-local",
  "hosts": {
    "mac-local": {
      "host": "127.0.0.1", "port": 8188,
      "auto_launch": true,
      "note": "Desktop, MPS 48GB"
    },
    "rtx-video": {
      "host": "100.86.199.90", "port": 8189,
      "auto_launch": false,
      "note": "Windows, RTX 4070 12GB, video"
    }
  }
}
```

Unknown keys survive every rewrite. Closing the shape would break whoever extended
it — non-negotiable #2's reasoning, applied to our own file.

## Tool surface

Seven tools become nine. Every existing tool gains an optional `host`; omitting it
uses the default, so today's calls keep working.

| Tool | Change |
|---|---|
| `comfy_status` | `+host?`; still never launches |
| `list_workflows` | `+host?`; entries tagged `source: "local"` or `"remote:<name>"` |
| `describe_workflow` | `+host?`; local slots against that host's `object_info` |
| `run_workflow` | `+host?`, `+fetch_outputs?`; records the ledger entry |
| `get_job`, `cancel_job` | `+host?`; the ledger resolves it when omitted |
| `launch_comfyui` | `+host?`, and refuses any address that is not this machine |
| `list_hosts` | new; read-only |
| `manage_hosts` | new; writes |

`manage_hosts` reads the file path rather than a loaded registry, because the one
tool that repairs `hosts.json` cannot require `hosts.json` to have loaded.

Every mutation backs the original up to `hosts.json.bak-<timestamp>`, writes through
a temp file and `rename()`, returns the backup path and a diff, and re-derives the
in-memory registry from what reached the disk. A repair that guesses wrong is undone
with `mv`.

The write path enforces decision 4 at write time: `auto_launch: true` on an address
that is not local is refused with an explanation, rather than accepted and failed at
load, when nobody is watching.

## Running a workflow that exists only on a remote

1. Resolve `"rtx-video"` to `Target{100.86.199.90, 8189}`.
2. `GET /api/userdata/workflows%2Fx.json` — raw bytes.
3. Write those bytes into the existing `mcp-comfyui-apply-<uuid>/` temp directory.
4. `comfy --json workflow set-slot <file> --host 100.86.199.90 --port 8189 …`
5. `comfy --json run <file> --host … --port … --wait`, decoded line by line.
6. Drop the `prompt_preview` graph before any `JSON.parse` (landmines #1 and #12).
7. Record `prompt_id → rtx-video` in the ledger.
8. Gate outputs on locality: URLs alone, plus `fetched` paths when asked.

Step 2 is the one new trust boundary. Bytes from a remote HTTP server now reach
`comfy` as a workflow file, so the size cap and content-type check belong there.

Step 4's argv carries `--json` before the subcommand and `--host` after it. Tests
must assert flag *position*, not merely presence; `fake-comfy` already captures argv
to `$FAKE_COMFY_ARGV_OUT`.

## Error handling

New arms on `ToolErrorKind` (`src/toolResult.ts:57-104`), appended rather than
closed: `unknown_host`, `host_unreachable`, `host_not_local`, `registry_invalid`,
`job_host_unknown`.

A malformed `hosts.json` leaves the default host working, fails every *named*
resolution with `registry_invalid` quoting the parse error and the file path, and
leads `list_hosts` with the breakage. Routing everything to `127.0.0.1` instead
would send a video job to the Mac because a comma was missing.

Loading tries a strict parse first. When that fails and a tolerant parse succeeds —
comments, trailing commas — the server keeps running and warns, naming the line and
the repair call. When both fail, `registry_invalid` carries line, column, and the
offending text.

Malformed and invalid stay separate. A trailing comma is malformed: the intent is
unambiguous and a machine can fix it. `auto_launch: true` on `100.86.199.90` is
well-formed JSON that is invalid for this server, and fixing it means deciding what
the operator meant. One repair path must never silently change routing.

`get_job` names the host it queried in every `prompt_not_found`, and says so when an
explicit `host` contradicts the ledger. `cancel_job` keeps comfy-cli's
`no local job` distinct from `status`'s remote `No prompt … on host:port`.

## Boundaries

State these in the docs and in the tool descriptions. They do not degrade
gracefully; they simply do not exist.

- **Launching a remote is impossible.** It would take SSH or an agent on that box.
  `launch_comfyui` refuses rather than pretending.
- **Artifacts stay on the machine that produced them** unless `fetch_outputs` moves
  them. `local_paths` keeps one meaning: the file the producing instance wrote.
- **A remote's workflows are visible only through its HTTP API.**
- **A job this machine never submitted may resist `cancel_job`,** because comfy-cli
  checks its own local records first.

The known gap where a timed-out probe reads as `running: false` grows more likely
with eight hosts, though decision 4's locality gate defuses its worst consequence.

## Testing

`fake-comfy` selects a response from `$FAKE_COMFY_MODE` alone, blind to the `--host`
it captures. Add a **new** mode — modes are append-only — that reads `--host` from
argv, so two hosts can answer differently in one test. `tests/tools.test.ts:56` and
`tests/server.test.ts:131` hardcode `hostname: "127.0.0.1"`; parameterize that before
standing up two fake instances.

Hand-build adversarial registries: duplicate names, a port outside 1-65535,
`auto_launch: true` on a remote address, unknown keys that must survive a rewrite, a
name spelled like a raw address. Real fixtures come from healthy installs and cannot
reach these.

Construct these mutants and confirm the test dies:

1. **Delete the locality gate in `performLaunch`.** A test must fail, proving a
   remote host never spawns a local process. This mutant is today's behavior, which
   is the strongest argument the test could have.
2. **Make the `get_job` ledger fall back to the default host on a miss.** A test
   must fail, because that mutant returns a confident wrong answer instead of an
   error.
3. **Send a `18446744073709551615` seed through the remote fetch path.** It must stay
   byte-exact. Landmine #1 is pinned across the local byte-copy only; the fetch is
   new ground.

## Out of scope

- Launching, installing, or managing ComfyUI on a remote machine.
- Mounting or syncing remote filesystems. Where a share exists, the operator mounts
  it; the server does not manage it.
- Failing a run over to another host automatically. Host choice stays the caller's.
