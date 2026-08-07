# Multi-host implementation

Implements `docs/plans/2026-08-06-multi-host-design.md`. That document is the
spec; this one is the order of work and the record of what is done.

## Measured before starting

Re-measured on 2026-08-07, because half of what this project ever *inferred*
about its dependencies was wrong (CLAUDE.md, "Never assert what you have not
run"). Every number below came from a command, not a memory.

- **The local ComfyUI is down and the remote is up.** `127.0.0.1:8188` refuses;
  `100.86.199.90:8189` answers `/system_stats` with ComfyUI **0.30.2** on
  `win32`, started `--listen 100.86.199.90,127.0.0.1 --port 8189`, output
  directory `F:\Dev\ComfyUI\output`. So the development machine is, right now,
  exactly the topology this work exists for.
- **`--listen` can carry a comma-separated list.** `100.86.199.90,127.0.0.1` is
  a real, live value. `instance.ts`'s `flagValue`/`resolveHost` would hand that
  whole string on as a hostname. Not reachable through this server today (it
  only reads its *own* launch argv), but it is the shape `launchTarget` parses.
- **A remote's artifact root is a Windows path.** `F:\Dev\ComfyUI\output` is not
  `isAbsolute` under POSIX, so `outputs.ts` declines it by accident today. A
  remote *Linux* box would not be declined: `/home/x/ComfyUI/output` is absolute
  here too, and `statSync` would then be asked whether **this** machine has that
  file. That is the locality gate's real motive, and it is a live defect, not a
  hypothetical one.
- **ComfyUI's userdata API, from its own source** (`app/user_manager.py` in
  `~/ComfyUI-Installs/ComfyUI Latest`), confirmed against the live remote:
  - `GET /api/userdata?dir=<d>&recurse=true&full_info=true` → a JSON array of
    `{path, size, modified, created}`. `path` is relative to the user root with
    `os.sep` replaced by `/`, so a Windows host still reports `workflows/a.json`.
    Measured: `dir=.` returned `[{"path": "comfy.settings.json", "size": 126,
    "modified": 1786069244638, "created": 1786064269557}]`.
  - `GET /api/userdata/{file}` is **one aiohttp path segment**, so a nested path
    must be percent-encoded. The handler unquotes only when the name contains a
    `%` (`user_manager.py:94-96`). It answers with `web.FileResponse` — raw
    bytes, `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`.
    Measured: the 126-byte settings file came back as exactly 126 bytes,
    `content-type: application/json`.
  - A missing file is a bare **404 with an empty body**.
  - The v2 listing is `/api/v2/userdata?path=…`, **not** `/api/userdata/v2` —
    the latter 404s. v1 with `full_info=true` is what this server uses, because
    it carries size and mtime in one call and exists in every build here.
- **`--host`/`--port` follow the subcommand.** `comfy workflow slots --help`,
  `comfy jobs ls --help` both list them as options of the subcommand, where
  `--json` and `--workspace` are Typer *root* flags. Both orderings therefore
  appear in one argv (non-negotiable #4).
- **The largest workflow on this machine is 122 KB** (`templates-6-key-frames.json`,
  27 files in the directory). The remote-fetch size cap is set from that.

## Stage 1: The host registry

**Goal**: `src/hosts.ts` — load, validate, and resolve `hosts.json`; the error
types and `ToolErrorKind` arms that go with it. Nothing else changes yet.
**Success criteria**: a name, a raw address and an omitted host all resolve; a
malformed file leaves the default working and fails named resolution;
unknown keys survive a round trip.
**Tests**: `tests/hosts.test.ts` — hand-built adversarial registries (duplicate
names, port out of range, `auto_launch: true` on a remote, unknown keys, a name
spelled like an address, a trailing comma, a file that is not an object).
**Status**: Not Started

## Stage 2: Targets resolved per call

**Goal**: `ToolConfig` carries the registry instead of a frozen `{host, port}`;
every existing tool gains an optional `host`; `list_hosts` is added; the
locality gate lands on artifact resolution and on auto-launch.
**Success criteria**: today's calls behave identically with no registry file;
`comfy_status {host: "rtx-video"}` probes the registry's address; a remote
instance never yields a `local_paths` entry; a remote that is asleep is
reported `host_unreachable`, never launched.
**Tests**: `tests/tools.test.ts`, `tests/outputs.test.ts`, `tests/server.test.ts`.
**Status**: Not Started

## Stage 3: Remote workflows

**Goal**: `src/comfy/userdata.ts`; `list_workflows` tags entries `local` or
`remote:<name>`; `describe_workflow`/`run_workflow` accept a remote handle and
feed its bytes to the existing byte-copy path; `fetch_outputs` downloads
artifacts on request.
**Success criteria**: a 2^64−1 seed survives the fetch byte-exactly; argv carries
`--json` before the subcommand and `--host` after it; an oversized or
wrong-typed body is refused before it reaches `comfy`.
**Tests**: `tests/userdata.test.ts`, plus a remote-run case in `tests/server.test.ts`.
**Status**: Not Started

## Stage 4: Job attribution

**Goal**: `src/jobLedger.ts`; `run_workflow` records `prompt_id → host`;
`get_job`/`cancel_job` resolve it when `host` is omitted.
**Success criteria**: a ledger miss with more than one host is an error naming
the candidates, never a guess; an explicit `host` that contradicts the ledger is
honoured and said so.
**Tests**: `tests/jobLedger.test.ts`, `tests/tools.test.ts`.
**Status**: Not Started

## Stage 5: Registry writes, and the documentation

**Goal**: `manage_hosts` (add, update, remove, set_default, repair); README,
CLAUDE.md, CHANGELOG, and the design document's status line.
**Success criteria**: every mutation backs up, writes through a temp file and
`rename`, returns the backup path and a diff, and re-reads from disk; a
`auto_launch: true` on a non-local address is refused at write time.
**Tests**: `tests/hosts.test.ts` (write path), `tests/server.test.ts` (the tool).
**Status**: Not Started

## Mutants to construct (design § Testing)

1. Delete the locality gate in the launch path — a test must fail.
2. Make the `get_job` ledger fall back to the default host on a miss — a test
   must fail.
3. Send a `18446744073709551615` seed through the remote fetch path — it must
   stay byte-exact.

Plus, from this document's own measurements:

4. Drop the locality gate in `outputs.ts` and point a fake remote instance at a
   directory that exists on this machine — a test must fail, because that mutant
   hands back a local path for a file the remote wrote.
