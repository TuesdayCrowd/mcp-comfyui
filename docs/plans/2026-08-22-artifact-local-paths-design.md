# Give every artifact a place on this disk

**Status:** designed 2026-08-22. Not started.
**Date:** 2026-08-22

A run on the Windows box finishes, and the answer says the image is at
`http://100.86.199.90:8189/view?filename=ComfyUI_00013_.png&type=output`. That
is a true statement and a useless one: the caller is a model on this Mac, it
cannot reach that tailnet address itself, and the file it just asked for is on
a machine it will never touch. `outputs.local_paths` is `{}`, honestly, because
there is nothing here to name.

This document is the design for making that row disappear — for every artifact
a caller is told about to have a location on **this** disk, without the caller
having to know to ask for one.

It is much smaller than the brief it came from, and the shrinking is the
interesting part. It began as "return artifacts as MCP image content blocks",
and two findings removed that idea entirely: one measured, one architectural.
Both are recorded in §6 rather than quietly dropped, because the rejected
approach is the one a future session will think of first.

## Which comfy produced these numbers

Behavioural claims below were executed on **2026-08-22** against the installed
`comfy`; source claims were read at this repo's working tree at `e87ffd1`.

```
installed : /Users/lawls/.local/bin/comfy
ffmpeg    : /opt/homebrew/bin/ffmpeg, /opt/homebrew/bin/ffprobe (both present)
hosts     : default 127.0.0.1:8188 (down), xinde-win-64 100.86.199.90:8189 (down)
```

Neither ComfyUI answered during this design pass, so **nothing here is claimed
against a live instance.** Every artifact-shaped claim comes from the captured
fixtures and from this repo's own source, and the two places that would need a
live host to settle are named as such in §7.

---

## 1. What already works, and is not being changed

Half of this feature already shipped, and finding that out is what made the
rest small.

**A local run already gives on-disk locations.** `outputs.local_paths` maps
each `/view` URL to an absolute path, resolved against the running instance's
own reported `outputDirectory` and checked for existence. For a local host the
goal of this document is today's behaviour. Nothing in §2 touches it.

**Artifact URLs are absolute, not bare paths.** `parseArtifactUrl` builds them
with `new URL(value)`, which only succeeds on an absolute URL, and
`isSameInstance` reads `url.hostname` and `url.port`. The captured shape is

```
http://127.0.0.1:8188/view?filename=b.png&subfolder=&type=output
```

so a caller that *can* reach the host has everything it needs already. That is
why §6 rejects fetching as a correctness fix: it is an ergonomics fix.

**The copying machinery exists and is careful.** `comfy/fetchOutputs.ts`
already streams an artifact to disk, and this design adds no new network code.
Its existing guarantees, all read from source:

- streams via `getReader()`, never buffering the file in memory
- caps at `MAX_ARTIFACT_BYTES` (1 GiB) mid-stream
- 300 s timeout per artifact
- never throws — one artifact that will not come across must not deny the
  caller the other nine; each failure lands on its own entry
- removes a partial file on failure, because "a partial file that looks
  finished is the one outcome worse than none"
- takes the filename from the *remote's* own `filename` parameter, reduces it
  to a single path segment, and refuses a value that cannot be rather than
  sanitising it into something adjacent
- writes under `<cacheDir>/fetched/<prompt_id>/`, keyed per `prompt_id`
  **because ComfyUI reuses filenames** — its counter restarts per output-node
  prefix, so two runs would otherwise overwrite each other

Default `cacheDir` is `~/.cache/mcp-comfyui`, via `MCP_COMFYUI_CACHE_DIR`.

---

## 2. The design

**The rule, in one sentence:** when an artifact has no local path and the host
that produced it is on another machine, copy it here, unless it is too big to
copy without being asked.

### 2.1 Auto-fetch, gated on the host being remote

The trigger is the resolved **host**'s `.local` being false — not
`instance === null`.

Those are not the same predicate and the difference matters. `instance` is
`null` both for a remote host *and* for a local host this server could not
probe. In the second case the files really are on this disk — the server just
could not resolve them this second — and fetching them would mean asking a
ComfyUI that is not answering for files that are already here. Gating on the
host's locality skips that pointless round trip and keeps the failure honest:
a local instance that is down reports as an unresolvable path, which is what it
is, rather than as a download failure.

`resolvingInstance` already applies exactly this test —
`if (urls.length === 0 || !resolved.local) return null;` — so the predicate is
not new, only newly reused.

**Name the variable carefully.** `fetchIfAsked` currently takes no host, and
the `ResolvedHost` it needs is spelled differently at its two call sites:

| tool | the `ResolvedHost` | note |
|---|---|---|
| `run_workflow` | `target` | **`resolved` here is the `ResolvedWorkflow`**, not the host |
| `get_job` | `decided.target` | — |

The collision is a live trap: writing `resolved.local` inside the
`run_workflow` handler reads the *workflow* object, which has no such field.
Both call sites already have the right value in scope immediately above the
`fetchIfAsked` call, so this is a parameter to thread, not a lookup to add.

**The locality gate applies to the automatic path only.** An explicit
`fetch_outputs: true` keeps today's behaviour exactly, including for a local
host, where it copies into the cache directory as it does now. Some caller may
be relying on that; nothing about §2.4 narrows it.

**A fetch that fails never costs the caller the run.** `fetchArtifacts` does
not throw, and this design does not make it throw: an unreachable remote yields
`fetch_problems` entries beside a complete, successful run result. The run is
the answer; copying is a convenience on top of it.

### 2.2 A per-artifact ceiling of 16 MiB

`AUTO_FETCH_MAX_BYTES = 16 * 1024 * 1024`.

The number is chosen against what artifacts actually are, measured on
2026-08-22:

| artifact | bytes |
|---|---|
| `example.png`, 768×768, flat synthetic content | 8,589 |
| random-noise PNG, 1024×1024 (worst case for PNG) | 2,955,268 |
| random-noise PNG, 2048×2048 (worst case for PNG) | 11,799,806 |

Random noise is the worst case for PNG compression, so a real render of the
same dimensions is smaller — typically 3–8 MB at 2048². 16 MiB therefore
auto-fetches **any still image, including an oversized one**, and never a
video, whose files run to hundreds of megabytes. That is the intended split:
seeing the picture you just generated should be free; moving a video across a
tailnet should require saying so.

This ceiling is a stricter limit layered *under* the existing 1 GiB one, not a
replacement for it: 1 GiB remains the absolute bound on what any fetch may
write, and 16 MiB is what the automatic path additionally refuses.
`FetchOutputsOptions` gains an optional `maxBytes` defaulting to
`MAX_ARTIFACT_BYTES`, so the explicit path (§2.4) is unchanged.

**Check `Content-Length` before writing, and keep the streaming cap anyway.**
Today `fetchOne` discovers an oversize file only by downloading it: it counts
bytes as they arrive and throws past the cap. With a 1 GiB cap that is nearly
always academic; with a 16 MiB one it would mean pulling 16 MiB of a 200 MB
video across a tailnet before giving up, on every call. So the ceiling is
checked against `response.headers.get("content-length")` first and the fetch
abandoned before a byte is written. The streaming cap stays as the backstop,
because the header is optional and a remote may lie about it — the header is an
optimisation, never the guarantee.

### 2.3 Idempotence

`fetchOne` opens with `"w"` and re-downloads unconditionally. Auto-fetch makes
that visible: `get_job` on a *completed* job is callable any number of times,
and without this, ten calls would mean ten downloads of the same bytes.

Before fetching, `stat` the destination; if a file is already there, return it
with no request. The invariant that makes this safe is one the module already
maintains — **a partial file never survives**, since every failure path `rm`s
what it wrote — so an existing file is necessarily a complete previous fetch.
Combined with the per-`prompt_id` destination, a name collision across runs
cannot happen either.

Polling a *running* job is already free: a job with no outputs has no artifact
URLs, so there is nothing to fetch until it finishes.

### 2.4 `fetch_outputs: true` keeps its name and gains a meaning

It becomes **"fetch everything, ignore the ceiling"** — the explicit ask that
gets you the 200 MB video. Every existing call that passes it keeps working and
keeps getting everything; the only change is that callers who pass nothing now
get their images too.

Its description in `tools.ts` must be rewritten. The current wording —
"Off by default, and deliberately: a run on this machine already has its files
here" — describes behaviour this design replaces, and a stale parameter
description is worse than none.

### 2.5 Disclosure: say why there is no path

A skip is not a failure, and this codebase does not report them alike. The
response gains one field beside the two that exist:

```jsonc
outputs: {
  files: [...],
  urls: [...],
  local_paths: { "<url>": "/abs/path" },   // unchanged
  fetched: { "<url>": "/abs/path" },       // existing
  fetch_problems: [ { url, problem } ],    // existing: we tried and could not
  not_fetched: [ { url, reason } ]         // NEW: we deliberately did not
}
```

`not_fetched` carries a reason a caller can act on, naming both the ceiling and
the observed size, and the argument that would override it:

```jsonc
{ "url": "http://…/view?filename=out.mp4&type=output",
  "reason": "214.7 MB exceeds the 16 MiB auto-fetch ceiling; pass fetch_outputs: true to copy it anyway" }
```

Structural absence is kept, on the rule `local_paths` and `notes_count` already
follow: `not_fetched` is absent when nothing was skipped, rather than `[]`.

`fetched` and `fetch_problems` keep their existing rule — absent unless a fetch
was attempted — which now means a **local** run's `outputs` is byte-identical
to today's, and a remote run's carries the new keys. That is the whole
observable contract change.

---

## 3. What changes, by file

| file | change |
|---|---|
| `comfy/fetchOutputs.ts` | `maxBytes` option (defaults to today's 1 GiB); `Content-Length` pre-check; reuse an existing complete file; a distinguishable "skipped" outcome so `not_fetched` is not inferred from a message string |
| `tools.ts` | `fetchIfAsked` gains the remote/ceiling policy; `outputsBody` emits `not_fetched`; `fetchOutputsArgument` description rewritten |
| `tools.ts` (descriptions) | `run_workflow` and `get_job` say that a remote run's images are copied here automatically and where they land |
| `CHANGELOG.md` | `[Unreleased]`, under Added and Changed |

`FetchedArtifact` currently expresses two outcomes in three fields (`path`
and `problem`, one of them null). A skip is a third outcome and must not be
encoded as a `problem` whose text happens to mention a ceiling — `toolResult.ts`
would then be one string-match away from misreporting it. The type gains an
explicit discriminator rather than a fourth nullable field.

**Not changed:** `comfy/outputs.ts`. Its locality refusal is correct and is the
reason this design exists; `resolveArtifactPath` returning `null` for a remote
host stays exactly as it is.

---

## 4. Testing

No new test infrastructure. Artifact fetching is already faked with
`Deno.serve({ port: 0 })`, and `192.0.2.1` is already granted for the
unreachable-remote case.

Cases, each with the mutant it kills:

1. **A remote run copies its image and reports the path.** Mutant: gate on
   `instance === null` instead of `resolved.local` — dies when a *local*
   instance that failed to probe starts fetching from itself.
2. **A local run is untouched.** `outputs` byte-identical to today, no
   `fetched` key. Mutant: auto-fetch unconditionally.
3. **An artifact past the ceiling is skipped, not failed.** Asserts
   `not_fetched` present with the size in the reason, `fetch_problems` absent,
   and the URL still in `urls`. Mutant: report it as a `fetch_problem`.
4. **`Content-Length` past the ceiling writes zero bytes.** Asserts the
   destination directory is empty. Mutant: drop the pre-check — the test dies
   on a partially written file, which is the waste this exists to stop.
5. **A lying `Content-Length` is still caught mid-stream.** Header says 1 KB,
   body is larger. Mutant: trust the header and drop the streaming cap.
6. **A second call does not re-download.** Two `get_job` calls, one served
   artifact; asserts the fake server saw exactly one request. Mutant: remove
   the `stat` reuse.
7. **`fetch_outputs: true` ignores the ceiling.** The 200 MB case comes across.
   Mutant: apply the auto ceiling to the explicit path.

Per this repo's standard each mutant is to be constructed and confirmed to kill
its test, and restored by checksum afterwards.

---

## 5. What this deliberately does not do

- **No inline image content blocks.** See §6.1.
- **No `comfy preview`.** A fetched video is a path a client cannot render, and
  a contact sheet would fix that — still a path, not bytes. It is left out to
  keep this change to one idea. §7 records what was measured about it so a
  follow-up need not re-derive it.
- **No change to the local path.** It already works.
- **No new configuration.** The ceiling is a constant. If it turns out to need
  an env var, that is evidence, not a guess.

---

## 6. Rejected, with the measurement that rejected it

### 6.1 MCP image content blocks

The original Stage 3 brief. `toolResult.ts:296` emits one `{type: "text"}`
block and MCP supports image blocks, so embedding the picture is possible.

**Rejected on the architecture, not the cost.** A base64 block is only useful
to a client that renders it; a path is useful to a client that renders it, to a
client that does not (a human opens it), and to a second model handed the path.
The weaker-looking option strictly dominates. `comfy preview` makes the same
assumption in its own output — its envelope's `hint` field literally reads
`"open/Read <path> to see it"` — so a path is the idiom the surrounding tooling
already speaks.

The cost argument pointed the same way. Measured, an embedded preview runs
0.1–0.9 MB of base64 apiece and ~0.5 s to generate, which forces a count cap, a
byte budget, and a fidelity-versus-size decision — three questions that all
evaporate once nothing is embedded.

### 6.2 `comfy preview` as a size reducer for images

Measured on 2026-08-22, source → preview:

| source | source | preview | ratio |
|---|---|---|---|
| 768×768 flat | 8,589 B | 31,556 B | **3.67× larger** |
| 1024×1024 noise | 2,955,268 B | 693,995 B | 0.23× |
| 2048×2048 noise | 11,799,806 B | 649,734 B | 0.06× |

Preview converges to ~650–700 KB regardless of input, so it bounds a large
artifact well and **inflates a small one**. "Always preview to keep it small"
is therefore wrong as a general rule. Moot under this design, which embeds
nothing — recorded so it is not rediscovered.

### 6.3 Asking the remote to downscale (`/view?preview=webp`)

ComfyUI's `/view` is *believed* to accept a `preview=` parameter that
re-encodes server-side, which would make remote image previews nearly free.
**Unverified — both hosts were down during this design pass**, and this repo's
first rule is not to assert what has not been run. It is also unnecessary here:
at a 16 MiB ceiling a still image transfers whole without complaint. Kept as a
possible later optimisation if remote fetching ever feels expensive, and it
would need §7's measurement first.

### 6.4 Auto-fetching everything

Rejected by `fetchOutputs.ts`'s own reasoning, which is worth keeping intact:
*"copying them across a tailnet because somebody polled a job is not a thing to
do without being asked."* The ceiling is what lets auto-fetch exist without
contradicting that.

---

## 7. Ground truth gained, and what is still unmeasured

Candidates for `docs/comfy-cli-ground-truth.md` once implementation confirms
them:

1. **`comfy preview` emits `envelope/1` without `--json`.** Unlike every other
   command this server drives, the envelope is the default output. Verified
   2026-08-22.
2. **`comfy preview`'s `width`/`height` are the SOURCE's, not the preview's.**
   A 768×768 input rendered to a 480×480 preview reports `768`/`768`. Reading
   them as the produced image's dimensions would be wrong.
3. **`comfy preview` reports `fps: 25.0` for a static PNG.** A default, not a
   measurement, and a decoy in the same family as ground truth #15's inert slot
   addresses. `duration` is correctly `null` for the same file.
4. **`comfy preview` fails through the envelope with two undocumented codes**,
   `preview_input_not_found` and `preview_failed`, neither in comfy-cli's
   published `error_codes.py` — a fourth open-string vocabulary, per
   non-negotiable #2.
5. **`comfy preview` requires ffmpeg/ffprobe**, including for images: the
   failure on a non-media file is an ffmpeg probe error
   (`Invalid data found when processing input`).

Still unmeasured, and needing a live host:

- Whether ComfyUI's `/view` honours a `preview=` parameter (§6.3).
- Whether a real ComfyUI run's artifact URLs carry a `subfolder`, which
  `artifactFilename` reduces to a single segment. The fixtures capture
  `subfolder=` empty.

---

## 8. Success criteria

- A run on `xinde-win-64` returns `outputs.fetched` with a path under
  `~/.cache/mcp-comfyui/fetched/<prompt_id>/`, with no argument passed.
- A local run's `outputs` is unchanged.
- An artifact past the ceiling appears in `not_fetched` with its size and the
  override, and in `urls`, and not in `fetch_problems`.
- Calling `get_job` twice downloads once.
- `deno task test` and `deno task typecheck` clean; every mutant in §4 confirmed
  to kill its test.
