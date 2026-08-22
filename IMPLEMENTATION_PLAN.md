# Artifact Local Paths Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every artifact a caller is told about has a location on this disk, without the caller having to know to ask for one.

**Architecture:** A remote run's `/view` URLs resolve to no local path, by design. This adds a *trigger* — not new network code — so that a remote host's artifacts are copied here automatically when they are small enough, using the `fetchArtifacts` machinery that already exists. A per-artifact ceiling keeps the "don't copy a video across a tailnet unasked" rule intact, and `fetch_outputs: true` becomes the explicit override that ignores it.

**Tech Stack:** Deno 2 (test runner), TypeScript via `tsc` (authoritative typecheck), `@std/testing/bdd` through `tests/support/testing.ts`, `Deno.serve({port:0})` HTTP fakes, `tests/fixtures/fake-comfy` for the CLI.

**Spec:** `docs/plans/2026-08-22-artifact-local-paths-design.md` — read it first; this plan argues from it.

## Status — 2026-08-22

**Tasks 1-4 are COMPLETE.** `deno task test` → 156 passed (676 steps), 0 failed. `deno task typecheck` → 0 errors. `node scripts/build.mjs` → clean. Every mutant named below was constructed, confirmed to kill its test, and restored by checksum: four in `fetchOutputs.ts` (no-precheck, skip-as-failure, no-streaming-cap, no-reuse) and four in `tools.ts` (no-locality-gate, no-not-fetched, ceiling-on-explicit, no-probe).

The `no-probe` run is worth keeping: the suite took **1m8s instead of 10s**, stopped by `AUTO_FETCH_TIMEOUT_MS` rather than by anything the remote did — the stall the probe exists to prevent, demonstrated rather than argued.

**Task 5 (live verification) remains BLOCKED** on a host being up, and is the only thing outstanding. Do not delete this file until it is done and the work has merged.

## Global Constraints

- **Never `git commit`.** GitButler only: `but commit -b <branch> -m "..." <ids>`. Never `but land`. PRs required.
- **`deno task test`** for the suite; **`deno task test:one <file>`** for one file. A bare `deno test <file>` type-checks with a Deno-bundled TypeScript a major version behind this project's and fails.
- **Never run two `deno test` invocations concurrently** — they contend and you will diagnose your own contention as a defect.
- **`deno task typecheck`** (`tsc --noEmit`) is the authoritative compile gate. `deno check` has known false positives here.
- **Wrap long runs in `caffeinate -i`** — this machine sleeps and kills work mid-run.
- **Fixture modes in `tests/fixtures/fake-comfy` are append-only.** Never change an existing one.
- **Write command output to a file and read the file.** Never pipe `deno test` or `but status` through `grep`.
- **Mutation testing is the standard.** For each new test, construct the named mutant, confirm the test dies, restore by checksum.
- **`AUTO_FETCH_MAX_BYTES = 16 * 1024 * 1024`** (16 MiB) and **`AUTO_FETCH_TIMEOUT_MS = 60_000`** — exact values.
- **Naming trap:** in the `run_workflow` handler `resolved` is a **`ResolvedWorkflow`**. The `ResolvedHost` is `target` there, and `decided.target` in `get_job`.
- **Use the fixtures that exist.** `REMOTE_ADDRESS` (`tests/server.test.ts:2832`, `"192.0.2.1"`) for a remote host; `deadPort` (set in `beforeEach` from `closedPort()`) for a port nothing listens on. Do not hardcode either.
- **`tests/` is never type-checked.** `tsconfig.json`'s `include` is `["src/**/*.ts"]` and the suite runs `--no-check`, so a type error in a test surfaces only as a runtime failure. Do not rely on `deno task typecheck` to catch test-code mistakes.
- **An unroutable address never fails on its own.** Measured 2026-08-22: a `fetch` to `192.0.2.1` ran a full 30 s and stopped only because the caller aborted it. A closed loopback port refuses in 0 ms and is NOT a guide to this case.

---

## File Structure

| file | responsibility after this change |
|---|---|
| `src/comfy/fetchOutputs.ts` | copying one artifact here, and the three outcomes that can have: fetched, failed, deliberately skipped. Owns the byte ceiling mechanism, not the policy. |
| `src/tools.ts` | the *policy*: which artifacts get a fetch attempted at all, and at what ceiling. Owns `AUTO_FETCH_MAX_BYTES` and the wire shape. |
| `tests/fetchOutputs.test.ts` | unit-level: ceiling, pre-check, reuse, refusals |
| `tests/server.test.ts` | end-to-end: the policy through a real tool call |
| `docs/comfy-cli-ground-truth.md` | the `comfy preview` facts measured during design |
| `CHANGELOG.md` | `[Unreleased]` |

`comfy/outputs.ts` is **not** changed. Its locality refusal is the reason this design exists.

---

### Task 1: Three outcomes, and a ceiling that can be lowered per call

**Files:**
- Modify: `src/comfy/fetchOutputs.ts`
- Modify: `src/tools.ts` (the one `outputsBody` consumer must keep compiling)
- Test: `tests/fetchOutputs.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type FetchedArtifact = {url, outcome:"fetched", path:string} | {url, outcome:"failed", problem:string} | {url, outcome:"skipped", reason:string}`
  - `FetchOutputsOptions.maxBytes?: number` (defaults to `MAX_ARTIFACT_BYTES`)

- [ ] **Step 1: Write the failing tests**

Add to `tests/fetchOutputs.test.ts`:

```ts
test("an artifact larger than this call's ceiling is skipped before a byte is written", async () => {
  // The ceiling exists so an automatic fetch never drags a video across a
  // tailnet. Discovering the size by DOWNLOADING it would defeat that: the
  // point is to not move the bytes. `content-length` is checked first and the
  // body abandoned unread. (Measured: `Deno.serve` DOES set content-length
  // automatically for a fixed-string body, so the pre-check really fires here.)
  //
  // Mutant: drop the content-length pre-check and rely on the streaming cap.
  //
  // What kills that mutant is the REASON STRING, not the empty directory —
  // measured, both the correct code and the mutant leave `workdir` empty,
  // because the streaming-cap failure path also `rm`s its partial file. The
  // pre-check's message carries the declared size ("5000 bytes exceeds..."),
  // the streaming cap's does not ("larger than this call's..."). Do not
  // "simplify" the 5000 assertion away; it is the whole discriminator.
  const port = serve(() => new Response("x".repeat(5_000), { headers: { "content-type": "image/png" } }));

  const fetched = await fetchArtifacts([viewUrl(port, "big.png")], { destination: workdir, maxBytes: 100 });

  expect(fetched[0]?.outcome).toBe("skipped");
  expect(String((fetched[0] as { reason?: string }).reason)).toContain("5000");
  expect(readdirSync(workdir)).toEqual([]);
});

test("a ceiling is a limit, not a failure: a skip is not reported as a problem", async () => {
  // A deliberate skip and a fetch that broke are different facts and this
  // codebase does not report them alike — the caller's next move differs.
  //
  // Mutant: return `{outcome: "failed"}` for the oversize case. Dies here.
  const port = serve(() => new Response("x".repeat(5_000)));

  const fetched = await fetchArtifacts([viewUrl(port, "big.png")], { destination: workdir, maxBytes: 100 });

  expect(fetched[0]?.outcome).not.toBe("failed");
});

test("the streaming cap enforces the ceiling when no content-length is declared", async () => {
  // A streamed response declares no length, so the header cannot be the
  // guarantee — the in-loop check is. Deliberately NOT named "a lying
  // content-length": measured, that case cannot be built here at all. A
  // Deno.serve response understating the length makes the client throw and
  // receive nothing; a raw-socket one makes `fetch` silently truncate to the
  // declared count. `written` can therefore never exceed a declared header,
  // and only an OVERSTATED one is reachable — whose failure mode is a false
  // skip, disclosed, never a corrupt file.
  //
  // The body is FINITE and larger than the ceiling, on purpose. An endless
  // always-ready stream starves the event loop: measured, with the cap removed
  // the read/write loop ran 6-8s and 935MB without ever observing an
  // AbortSignal.timeout, so the mutant would HANG the suite instead of failing
  // it. A finite body ends, the file lands, and the assertion fails cleanly.
  //
  // Mutant: delete the `written > maxBytes` check. Dies on the file existing.
  const chunk = new Uint8Array(1024);
  const port = serve(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (let i = 0; i < 16; i++) controller.enqueue(chunk); // 16 KiB total
            controller.close();
          },
        }),
        { headers: { "content-type": "image/png" } },
      ),
  );

  const fetched = await fetchArtifacts([viewUrl(port, "streamed.png")], {
    destination: workdir,
    maxBytes: 4096,
  });

  expect(fetched[0]?.outcome).toBe("skipped");
  expect(readdirSync(workdir)).toEqual([]);
});
```

**Also update the existing test the plan previously missed** —
`"one artifact that will not come across does not deny the others"`
(`tests/fetchOutputs.test.ts:81-82`). Measured against the pinned
`@std/expect@1.0.20`: `toMatchObject({problem: null})` FAILS when the actual
object has no `problem` key, and likewise for `path`. Under the union the
`"fetched"` variant has no `problem` and the `"failed"` variant has no `path`,
so both lines break:

```ts
  expect(fetched[0]).toMatchObject({ url: good, outcome: "fetched" });
  expect(fetched[1]).toMatchObject({ url: gone, outcome: "failed" });
  expect(String((fetched[1] as { problem?: string }).problem)).toContain("404"); // line 83, still valid
```

Then update the stale assertions in the existing tests. **There are 7 of them across 5 tests, not two** — an earlier draft of this plan undercounted, and following it would have left the file failing at Step 4. The full inventory: line 63, lines 81-82, lines 106-107, line 136, line 146.

In `"an artifact is written under the destination and reported by URL"`, `fetched[0]?.path` becomes valid only on the `"fetched"` variant — read it as:

```ts
expect(fetched[0]?.outcome).toBe("fetched");
expect((fetched[0] as { path: string }).path).toBe(join(workdir, "made_00001_.png"));
```

And the existing 1 GiB endless-stream test changes verdict, because exceeding a ceiling is now a skip everywhere rather than only in the new path:

```ts
  expect(fetched[0]?.outcome).toBe("skipped");
  expect(String((fetched[0] as { reason?: string }).reason)).toContain("limit");
  expect(existsSync(join(workdir, "endless.png"))).toBe(false);
  expect(readdirSync(workdir)).toEqual([]);
```

The refusal tests (`not an http URL`, traversing filename) assert `path: null` today; they become:

```ts
expect(fetched[0]?.outcome).toBe("failed");
```

- [ ] **Step 2: Run the tests to verify they fail**

```
caffeinate -i deno task test:one tests/fetchOutputs.test.ts > /tmp/t1.log 2>&1; echo $?
```

Expected: FAIL. The new tests fail because `maxBytes` is not an option and `outcome` does not exist; the edited existing ones fail on `outcome` being `undefined`.

- [ ] **Step 3: Implement**

In `src/comfy/fetchOutputs.ts`, replace the `FetchedArtifact` interface:

```ts
/**
 * What a fetch attempt did, per artifact.
 *
 * Three outcomes, discriminated rather than inferred from which fields are
 * null. A **skip** is not a failure: the caller asked for something this call
 * declined to do, and their next move — pass `fetch_outputs: true` — is
 * different from the next move for a fetch that broke. Encoding it as a
 * `problem` whose text happens to mention a ceiling would leave `tools.ts` one
 * string-match away from reporting a deliberate policy as a fault.
 */
export type FetchedArtifact =
  | { readonly url: string; readonly outcome: "fetched"; readonly path: string }
  | { readonly url: string; readonly outcome: "failed"; readonly problem: string }
  | { readonly url: string; readonly outcome: "skipped"; readonly reason: string };
```

Add to `FetchOutputsOptions`:

```ts
  /**
   * Refuse an artifact larger than this, reporting it as `skipped`.
   *
   * Defaults to {@link MAX_ARTIFACT_BYTES}, so an explicit `fetch_outputs`
   * behaves exactly as it always has. The automatic path passes a far lower
   * one; see `AUTO_FETCH_MAX_BYTES` in `tools.ts` for the policy and the
   * measurement behind its value.
   */
  maxBytes?: number;
```

Rewrite `fetchOne`'s head and cap handling:

```ts
async function fetchOne(url: string, opts: FetchOutputsOptions): Promise<FetchedArtifact> {
  const failed = (problem: string): FetchedArtifact => ({ url, outcome: "failed", problem });
  const skipped = (reason: string): FetchedArtifact => ({ url, outcome: "skipped", reason });
  const maxBytes = opts.maxBytes ?? MAX_ARTIFACT_BYTES;

  if (!isArtifactUrl(url)) return failed("not an http(s) URL");
  const name = artifactFilename(url);
  if (name === null) return failed("the URL names no filename this server would write");
  const path = join(opts.destination, name);

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) });
  } catch (cause) {
    return failed(cause instanceof Error ? cause.message : String(cause));
  }
  if (!response.ok) return failed(`HTTP ${response.status} ${response.statusText}`);
  if (response.body === null) return failed("the response carried no body");

  // Ask before moving the bytes. `content-length` is optional and a remote may
  // be wrong about it, so this is an optimisation and the streaming cap below
  // is the guarantee — but when it IS present it is the difference between
  // declining a 200MB video and downloading 16MiB of one to find out.
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body.cancel().catch(() => {});
    return skipped(`${declared} bytes exceeds this call's ${maxBytes}-byte limit`);
  }

  try {
    await mkdir(opts.destination, { recursive: true });
  } catch (cause) {
    return failed(`could not create ${opts.destination}: ${describe(cause)}`);
  }

  const handle = await open(path, "w").catch(() => null);
  if (handle === null) return failed(`could not write ${path}`);

  let written = 0;
  let oversize = false;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      written += value.byteLength;
      if (written > maxBytes) {
        oversize = true;
        throw new Error(`larger than this call's ${maxBytes}-byte limit`);
      }
      await handle.write(value);
    }
  } catch (cause) {
    await reader.cancel().catch(() => {});
    await handle.close().catch(() => {});
    // A partial file that looks finished is the one outcome worse than none.
    await rm(path, { force: true }).catch(() => {});
    return oversize ? skipped(describe(cause)) : failed(describe(cause));
  }
  await handle.close().catch(() => {});

  return { url, outcome: "fetched", path };
}
```

In `src/tools.ts`, `outputsBody`'s two `filter` calls read fields that now exist on only one variant. Use `flatMap`, which narrows correctly where `filter` does not:

```ts
          fetched: Object.fromEntries(
            fetched.flatMap((one) => (one.outcome === "fetched" ? [[one.url, one.path] as const] : [])),
          ),
          fetch_problems: fetched.flatMap((one) =>
            one.outcome === "failed" ? [{ url: one.url, problem: one.problem }] : []
          ),
```

- [ ] **Step 4: Run the tests to verify they pass**

```
caffeinate -i deno task test:one tests/fetchOutputs.test.ts > /tmp/t1.log 2>&1; echo $?
caffeinate -i deno task typecheck > /tmp/tc1.log 2>&1; echo $?
```

Expected: both exit 0.

- [ ] **Step 5: Confirm the mutants**

For each of the three named mutants above: apply it, run the file, confirm the named test dies, restore by `shasum -a 256` comparison against a copy taken before mutating.

**One hazard, measured.** The PRE-EXISTING 1 GiB endless-stream test uses an always-ready infinite `ReadableStream`. Under the `written > maxBytes` mutant that loop starves the event loop — 6-8 s and 935 MB with the abort signal never observed — and Deno's runner has no default per-test timeout, so the suite **hangs rather than fails**. Run that particular mutation under `timeout 60 deno task test:one tests/fetchOutputs.test.ts` and treat the *hang* as the kill signal. The new streaming test above is deliberately finite so it does not share this hazard; the pre-existing one is left alone because a finite body larger than 1 GiB is not a reasonable fixture.

- [ ] **Step 6: Commit**

```
but commit -b artifact-local-paths -m "feat(fetch): a per-call byte ceiling, and a skip that is not a failure" <ids>
```

---

### Task 2: Fetching the same artifact twice downloads it once

**Files:**
- Modify: `src/comfy/fetchOutputs.ts`
- Test: `tests/fetchOutputs.test.ts`

**Interfaces:**
- Consumes: Task 1's `FetchedArtifact` union.
- Produces: no signature change. Behaviour only.

- [ ] **Step 1: Write the failing test**

```ts
test("an artifact already on disk is not downloaded again", async () => {
  // `get_job` on a COMPLETED job is callable any number of times, and once
  // fetching is automatic that means ten polls would be ten downloads of bytes
  // already here. The destination is keyed by prompt_id and filename, so an
  // existing file is this artifact; and a partial one cannot exist, because
  // every failure path removes what it wrote.
  //
  // Mutant: delete the `stat` reuse. This test dies on requests === 2.
  let requests = 0;
  const port = serve(() => {
    requests += 1;
    return new Response("png bytes", { headers: { "content-type": "image/png" } });
  });
  const url = viewUrl(port, "made_00001_.png");

  const first = await fetchArtifacts([url], { destination: workdir });
  const second = await fetchArtifacts([url], { destination: workdir });

  expect(requests).toBe(1);
  expect(first[0]?.outcome).toBe("fetched");
  expect(second[0]?.outcome).toBe("fetched");
  expect((second[0] as { path: string }).path).toBe(join(workdir, "made_00001_.png"));
  expect(readFileSync(join(workdir, "made_00001_.png"), "utf8")).toBe("png bytes");
});
```

- [ ] **Step 2: Run the test to verify it fails**

```
caffeinate -i deno task test:one tests/fetchOutputs.test.ts > /tmp/t2.log 2>&1; echo $?
```

Expected: FAIL with `requests` being 2.

- [ ] **Step 3: Implement**

Add `stat` to the `node:fs/promises` import, and insert immediately after `const path = join(opts.destination, name);`:

```ts
  // Already here: return it without a request. Safe because a partial file
  // never survives — every failure path below `rm`s what it wrote — so an
  // existing file is necessarily a complete previous fetch, and the
  // per-`prompt_id` destination means it is a previous fetch OF THIS ARTIFACT.
  const existing = await stat(path).catch(() => null);
  if (existing !== null && existing.isFile()) return { url, outcome: "fetched", path };
```

- [ ] **Step 4: Run the test to verify it passes**

```
caffeinate -i deno task test:one tests/fetchOutputs.test.ts > /tmp/t2.log 2>&1; echo $?
```

Expected: exit 0.

- [ ] **Step 5: Confirm the mutant**

Delete the reuse block, confirm the test dies on `requests === 2`, restore by checksum.

- [ ] **Step 6: Commit**

```
but commit -b artifact-local-paths -m "feat(fetch): reuse an artifact already on disk" <ids>
```

---

### Task 3: A remote run's images arrive without being asked for

**Files:**
- Modify: `src/tools.ts` (`AUTO_FETCH_MAX_BYTES`, `fetchIfAsked` → policy, `outputsBody`, `fetchOutputsArgument`, both call sites)
- Modify: `CHANGELOG.md`
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: Task 1's `maxBytes` and `outcome`; Task 2's reuse.
- Produces: `outputs.not_fetched: Array<{url: string, reason: string}>`, present only when something was skipped.

- [ ] **Step 1: Write the failing tests**

Add to `tests/server.test.ts`, near the existing `fetch_outputs` tests:

```ts
test("a REMOTE run's artifacts are copied here without being asked for", async () => {
  // The whole feature. A run on another box reports a /view URL this caller
  // cannot reach, and `local_paths` is empty because there is honestly nothing
  // here to name. Now there is.
  //
  // The registered host is 192.0.2.1 (RFC 5737, on no interface anywhere) so
  // that `resolved.local` is false, while the artifact URL points at the
  // loopback test server — the suite grants no second local address, and the
  // policy under test keys on the HOST, not on where the URL happens to point.
  //
  // Mutant: gate on `instance === null` instead of the host's locality. Passes
  // here but dies in the local-instance-unreachable case; see the sibling.
  const outputDir = makeDir("comfy-output");
  const port = serveArtifactInstance(outputDir, { "made_00001_.png": "png bytes" });
  const url = viewUrl(port, { filename: "made_00001_.png", subfolder: "", type: "output" });
  writeHosts({ default: "far", hosts: { far: { host: REMOTE_ADDRESS, port: 8189 } } });
  const statusFile = join(workdir, "status.json");
  writeFileSync(statusFile, JSON.stringify({ prompt_id: PROMPT_ID, status: "completed", outputs: [url] }));
  process.env.FAKE_COMFY_MODE = "jobs";
  process.env.FAKE_COMFY_JOBS_STATUS_FILE = statusFile;

  const body = await ok(await connect(), "get_job", { prompt_id: PROMPT_ID, host: "far" });

  const outputs = body["outputs"] as Record<string, Record<string, string>>;
  const landed = outputs["fetched"]?.[url] as string;
  expect(landed).toContain(PROMPT_ID);
  expect(readFileSync(landed, "utf8")).toBe("png bytes");
  // Still no local path: the file here is a COPY, and `local_paths` means
  // "the instance's own file", which remains on the other machine.
  expect(outputs["local_paths"]).toEqual({});
});

test("a LOCAL run is untouched by automatic fetching", async () => {
  // Auto-fetch is for artifacts that are not already here. A local instance
  // that this server merely could not probe still has its files on this disk,
  // and asking a ComfyUI that is not answering to send them back would be both
  // pointless and a new way to fail.
  //
  // Mutant: gate on `instance === null` rather than the host's locality. This
  // test dies — `instance` is null here (nothing is running to probe) while the
  // host is local, so the mutant starts fetching.
  const url = viewUrl(deadPort, { filename: "made_00001_.png", subfolder: "", type: "output" });
  const statusFile = join(workdir, "status.json");
  writeFileSync(statusFile, JSON.stringify({ prompt_id: PROMPT_ID, status: "completed", outputs: [url] }));
  process.env.FAKE_COMFY_MODE = "jobs";
  process.env.FAKE_COMFY_JOBS_STATUS_FILE = statusFile;

  const body = await ok(await connect(), "get_job", { prompt_id: PROMPT_ID });

  const outputs = body["outputs"] as Record<string, unknown>;
  // Absent, not empty: nothing was attempted.
  expect(outputs["fetched"]).toBeUndefined();
  expect(outputs["fetch_problems"]).toBeUndefined();
  expect(outputs["not_fetched"]).toBeUndefined();
});

test("an artifact past the auto ceiling is disclosed, not silently missing", async () => {
  // `not_fetched` is the answer to "why is there no path for this one", and it
  // names the override. Without it a caller sees an artifact in `urls`, no
  // entry in `fetched`, and no way to tell a policy from a bug.
  //
  // Mutant: drop the `not_fetched` spread from `outputsBody`. Dies on the
  // undefined.
  const outputDir = makeDir("comfy-output");
  // 17 MiB: past AUTO_FETCH_MAX_BYTES. Never transferred — the content-length
  // pre-check declines it before a byte moves.
  const huge = "x".repeat(17 * 1024 * 1024);
  const port = serveArtifactInstance(outputDir, { "big.mp4": huge });
  const url = viewUrl(port, { filename: "big.mp4", subfolder: "", type: "output" });
  writeHosts({ default: "far", hosts: { far: { host: REMOTE_ADDRESS, port: 8189 } } });
  const statusFile = join(workdir, "status.json");
  writeFileSync(statusFile, JSON.stringify({ prompt_id: PROMPT_ID, status: "completed", outputs: [url] }));
  process.env.FAKE_COMFY_MODE = "jobs";
  process.env.FAKE_COMFY_JOBS_STATUS_FILE = statusFile;

  const body = await ok(await connect(), "get_job", { prompt_id: PROMPT_ID, host: "far" });

  const outputs = body["outputs"] as Record<string, unknown>;
  const skipped = outputs["not_fetched"] as Array<Record<string, string>>;
  expect(skipped).toHaveLength(1);
  expect(skipped[0]?.url).toBe(url);
  expect(skipped[0]?.reason).toContain("fetch_outputs");
  // A skip is not a failure, and the location is still reported.
  expect(outputs["fetch_problems"]).toEqual([]);
  expect(outputs["urls"]).toEqual([url]);
});

test("fetch_outputs true ignores the auto ceiling", async () => {
  // The explicit ask is what gets you the video. Same fixture as above, one
  // argument different.
  //
  // Mutant: apply AUTO_FETCH_MAX_BYTES to the explicit path too. Dies here.
  const outputDir = makeDir("comfy-output");
  const huge = "x".repeat(17 * 1024 * 1024);
  const port = serveArtifactInstance(outputDir, { "big.mp4": huge });
  const url = viewUrl(port, { filename: "big.mp4", subfolder: "", type: "output" });
  writeHosts({ default: "far", hosts: { far: { host: REMOTE_ADDRESS, port: 8189 } } });
  const statusFile = join(workdir, "status.json");
  writeFileSync(statusFile, JSON.stringify({ prompt_id: PROMPT_ID, status: "completed", outputs: [url] }));
  process.env.FAKE_COMFY_MODE = "jobs";
  process.env.FAKE_COMFY_JOBS_STATUS_FILE = statusFile;

  const body = await ok(await connect(), "get_job", {
    prompt_id: PROMPT_ID,
    host: "far",
    fetch_outputs: true,
  });

  const outputs = body["outputs"] as Record<string, Record<string, string>>;
  expect(outputs["fetched"]?.[url]).toBeDefined();
  expect(outputs["not_fetched"]).toBeUndefined();
});

test("a remote that does not answer is skipped in seconds, not minutes", async () => {
  // The defect this nearly shipped with. Measured 2026-08-22: a fetch to an
  // unroutable address NEVER fails on its own — it ran a full 30s and stopped
  // only because the probe aborted it — so at the 300s default this would have
  // stalled get_job for five minutes on a copy nobody asked for. The artifact
  // URL points at `deadPort` here, so the probe fails fast and nothing is
  // fetched.
  //
  // Mutant: delete the probe from `fetchIfAsked`. This test dies on elapsed
  // time (it would run to AUTO_FETCH_TIMEOUT_MS) and on the reason text.
  const url = viewUrl(deadPort, { filename: "made_00001_.png", subfolder: "", type: "output" });
  writeHosts({ default: "far", hosts: { far: { host: REMOTE_ADDRESS, port: 8189 } } });
  const statusFile = join(workdir, "status.json");
  writeFileSync(statusFile, JSON.stringify({ prompt_id: PROMPT_ID, status: "completed", outputs: [url] }));
  process.env.FAKE_COMFY_MODE = "jobs";
  process.env.FAKE_COMFY_JOBS_STATUS_FILE = statusFile;

  const started = Date.now();
  const body = await ok(await connect(), "get_job", { prompt_id: PROMPT_ID, host: "far" });
  const elapsed = Date.now() - started;

  const outputs = body["outputs"] as Record<string, unknown>;
  const skipped = outputs["not_fetched"] as Array<Record<string, string>>;
  expect(skipped?.[0]?.reason).toContain("did not answer");
  expect(Object.keys(outputs["fetched"] as Record<string, string>)).toEqual([]);
  // Generous, because a budget assertion that is tight is a flake. The point
  // is minutes-vs-seconds, not a precise figure.
  expect(elapsed).toBeLessThan(20_000);
});

test("polling a completed job twice downloads its artifacts once", async () => {
  // Spec §8 names this at the TOOL layer, and the unit test in Task 2 covers
  // only `fetchArtifacts` directly. Auto-fetch makes it matter: `get_job` on a
  // completed job is callable any number of times.
  //
  // Mutant: remove the `stat` reuse from Task 2. Dies on requests === 2.
  const outputDir = makeDir("comfy-output");
  let views = 0;
  const bound = denoServe((request) => {
    const url = new URL(request.url);
    if (url.pathname === "/system_stats") {
      const argv = ["ComfyUI/main.py", "--output-directory", outputDir];
      return new Response(JSON.stringify({ ...SYSTEM_STATS, system: { ...SYSTEM_STATS.system, argv } }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/view") {
      views += 1;
      return new Response("png bytes", { headers: { "content-type": "image/png" } });
    }
    return new Response("nf", { status: 404 });
  });
  servers.push(bound);
  const url = viewUrl(portOf(bound), { filename: "made_00001_.png", subfolder: "", type: "output" });
  writeHosts({ default: "far", hosts: { far: { host: REMOTE_ADDRESS, port: 8189 } } });
  const statusFile = join(workdir, "status.json");
  writeFileSync(statusFile, JSON.stringify({ prompt_id: PROMPT_ID, status: "completed", outputs: [url] }));
  process.env.FAKE_COMFY_MODE = "jobs";
  process.env.FAKE_COMFY_JOBS_STATUS_FILE = statusFile;

  await ok(await connect(), "get_job", { prompt_id: PROMPT_ID, host: "far" });
  await ok(await connect(), "get_job", { prompt_id: PROMPT_ID, host: "far" });

  expect(views).toBe(1);
});
```

**And update the one existing test this feature's contract change reaches.** `tests/server.test.ts`'s remote-outputs test (search for `host_source"]).toBe("only")`) currently asserts an exact shape:

```ts
  expect(body["outputs"]).toEqual({ files: [], urls: [url], local_paths: {} });
```

Its host is `REMOTE_ADDRESS` with no `fetch_outputs`, so auto-fetch now runs and adds sibling keys. Its purpose — the mutant-killer for `resolveArtifactPath`'s `isLocalAddress` guard — is untouched, because `local_paths` stays `{}`: a copy in this server's cache is not the instance's own file. Only the exactness changes:

```ts
  expect(body["outputs"]).toMatchObject({ files: [], urls: [url], local_paths: {} });
```

**Do not drop the `local_paths: {}` assertion** — it is the entire point of that test. The artifact URL there points at `REMOTE_ADDRESS`, which answers nothing, so the probe skips and the call stays fast.

- [ ] **Step 2: Run the tests to verify they fail**

```
caffeinate -i deno task test:one tests/server.test.ts > /tmp/t3.log 2>&1; echo $?
```

Expected: FAIL — the remote case reports no `fetched`, and `not_fetched` is undefined.

- [ ] **Step 3: Implement**

First, export the origin rule from `src/comfy/outputs.ts` — the module that already owns every rule about what a path or URL out of `comfy` means. `parseArtifactUrl` is module-private and stays that way; this is a narrow public answer built on it:

```ts
/**
 * The address a `/view` URL names, or `null` if it names none.
 *
 * Here rather than at the call site for the reason this whole module exists:
 * more than one place now has to agree about what an artifact URL points at,
 * and a second copy of that rule is a bug nobody sees. `fetchOutputs.ts`
 * requests the URL as reported, so this is the address whose reachability
 * decides whether that request can succeed.
 *
 * The port is explicit because `detectInstance` needs one: an http URL with no
 * port means 80, and `defaultPort` already encodes that for `isSameInstance`.
 */
export function artifactOrigin(url: string): { host: string; port: number } | null {
  const parsed = parseArtifactUrl(url);
  if (parsed === null) return null;
  return {
    host: parsed.hostname,
    port: parsed.port === "" ? defaultPort(parsed.protocol) : Number(parsed.port),
  };
}
```

Then add the policy constants beside `NOTES_TIMEOUT_MS` in `src/tools.ts`:

```ts
/**
 * The largest artifact copied here WITHOUT the caller asking.
 *
 * Sized against what artifacts are, measured 2026-08-22: a 2048x2048 PNG of
 * random noise — the worst case for PNG compression, so an upper bound on a
 * real render of that size — is 11.8 MB, and a 1024x1024 one is 3.0 MB. So
 * 16 MiB copies any still image, including an oversized one, and never a
 * video, whose files run to hundreds of megabytes.
 *
 * That split is the point. Seeing the picture you just generated should be
 * free; moving a video across a tailnet should require saying so, which is
 * what `fetch_outputs` is for. `fetchOutputs.ts`'s own 1 GiB cap stays
 * underneath as the absolute bound on any fetch.
 */
const AUTO_FETCH_MAX_BYTES = 16 * 1024 * 1024;
```

Replace `fetchIfAsked` with the policy (keep the doc comment's existing reasoning and extend it):

```ts
/**
 * Copy a run's artifacts here, when the caller asked OR when they are on
 * another machine and small enough to bring without asking.
 *
 * The automatic half keys on the **host's** locality, not on whether a local
 * path could be resolved. Those differ: `resolvingInstance` returns null both
 * for a remote host and for a local one this server could not probe, and in the
 * second case the files really are on this disk — fetching them would mean
 * asking a ComfyUI that is not answering for bytes that are already here.
 *
 * Per `prompt_id`, under this server's own cache directory, so two runs cannot
 * overwrite each other's files even when ComfyUI reuses a filename — which it
 * does, because its counter restarts per output-node prefix.
 */
async function fetchIfAsked(
  urls: readonly string[],
  promptId: string | null,
  config: ToolConfig,
  host: ResolvedHost,
  explicit: boolean,
): Promise<FetchedArtifact[] | null> {
  // Nothing to bring: the files are already on this machine.
  if (!explicit && host.local) return null;
  // `[]` for an explicit ask means "attempted, none came across"; `null` for
  // the automatic path means "never attempted", which is what keeps a local
  // run's `outputs` byte-identical to what it was before this existed.
  if (urls.length === 0 || promptId === null) return explicit ? [] : null;

  // A sleeping remote must not hold the answer. Measured: a fetch to an
  // unroutable address NEVER fails on its own — it black-holes, and at the
  // 300s default that is a five-minute stall on a copy nobody asked for. So
  // the automatic path asks the cheap question first, exactly as
  // `comfy_status` does, and skips with a reason rather than hanging. The
  // explicit path keeps the full budget: a caller who asked for a 200MB video
  // has said it is worth waiting for.
  if (!explicit) {
    // The URL's own authority, not `host` — `fetchArtifacts` requests the URL
    // exactly as the CLI reported it, so that is the address whose
    // reachability decides the outcome. Identical in production; consistent
    // with what the fetch will do if they ever diverge. Once per call, not per
    // artifact.
    const origin = artifactOrigin(urls[0] as string);
    const detection = origin === null ? { running: false } : await detectInstance(origin);
    if (!detection.running) {
      return urls.map((url) => ({
        url,
        outcome: "skipped" as const,
        reason: "the host did not answer",
      }));
    }
  }

  return await fetchArtifacts(urls, {
    destination: join(cacheRoot(config.cacheDir), "fetched", promptId),
    ...(explicit ? {} : { maxBytes: AUTO_FETCH_MAX_BYTES, timeoutMs: AUTO_FETCH_TIMEOUT_MS }),
  });
}
```

And the second bound, beside `AUTO_FETCH_MAX_BYTES`:

```ts
/**
 * Budget for one automatic artifact copy, and deliberately far shorter than
 * `fetchOutputs.ts`'s 300s default.
 *
 * The probe above catches a host that is not there; this catches one that
 * answers and then stalls mid-body, which would otherwise reinstate the same
 * five-minute hang one layer down. 60s is ample for a 16 MiB ceiling over a
 * tailnet and caps the pathological case at a minute. Same reasoning as
 * {@link NOTES_TIMEOUT_MS}: a convenience issued beside a load-bearing answer
 * must not be able to hold it for the default budget.
 */
const AUTO_FETCH_TIMEOUT_MS = 60_000;
```

`detectInstance` and `address` are already imported in `tools.ts` (used by `resolvingInstance` directly above).

Add `not_fetched` to `outputsBody`, inside the same `fetched === null ? {} : {...}` branch, after `fetch_problems`:

```ts
          // Absent when nothing was skipped, on the structural-absence rule
          // `local_paths` and `notes_count` already follow. A skip is not a
          // failure and does not belong in `fetch_problems`: the caller's next
          // move is `fetch_outputs: true`, not a bug report.
          ...(fetched.some((one) => one.outcome === "skipped")
            ? {
                not_fetched: fetched.flatMap((one) =>
                  one.outcome === "skipped"
                    ? [{
                      url: one.url,
                      reason: `${one.reason}; pass fetch_outputs: true to copy it anyway`,
                    }]
                    : []
                ),
              }
            : {}),
```

Update both call sites — note the naming trap in Global Constraints:

```ts
// run_workflow (`target` is the ResolvedHost; `resolved` is the workflow)
const fetched = await fetchIfAsked(run.outputs.urls, run.promptId, config, target, fetch_outputs);

// get_job
const fetched = await fetchIfAsked(job.outputs.urls, job.promptId, config, decided.target, fetch_outputs);
```

Rewrite `fetchOutputsArgument`'s description — the current wording describes behaviour this replaces:

```ts
const fetchOutputsArgument = z
  .boolean()
  .default(false)
  .describe(
    "Copy this run's artifacts here even when they are large. A run on ANOTHER host already has " +
      "its artifacts copied here automatically, up to 16 MiB each, reported under `outputs.fetched`; " +
      "anything past that is listed in `outputs.not_fetched` with its size. This turns that ceiling " +
      "off, which is what a video needs. A run on this machine already has its files here " +
      "(`outputs.local_paths`) and is unaffected unless you set this.",
  );
```

**Update both tool descriptions** — spec §3 lists this as its own row and an earlier draft of this plan only rewrote the argument description. `run_workflow` and `get_job` each carry a `description:` string; neither currently mentions artifact copying. Add one sentence to each, in their existing voice:

> A run on another host has its artifacts copied here automatically when they are small enough, reported as absolute paths under `outputs.fetched`; anything skipped is listed in `outputs.not_fetched` with the reason.

Add to `CHANGELOG.md` under `[Unreleased]`.

- [ ] **Step 4: Run the tests to verify they pass**

```
caffeinate -i deno task test > /tmp/t3full.log 2>&1; echo $?
caffeinate -i deno task typecheck > /tmp/tc3.log 2>&1; echo $?
```

Expected: both exit 0. The two pre-existing `fetch_outputs` tests use a local host with the flag set, so they exercise the explicit path and must still pass unchanged.

- [ ] **Step 5: Confirm the mutants**

Four, each named in its test above: gate on `instance === null`; drop `not_fetched`; apply the auto ceiling to the explicit path; report a skip as a `fetch_problem`.

- [ ] **Step 6: Commit**

```
but commit -b artifact-local-paths -m "feat: copy a remote run's images here automatically" <ids>
```

---

### Task 4: Record what was measured

**Files:**
- Modify: `docs/comfy-cli-ground-truth.md`

**Interfaces:** none.

- [ ] **Step 1: Append the entries**

Five facts about `comfy preview`, all measured 2026-08-22 and all currently written nowhere. Numbering continues from the file's existing last entry:

1. `comfy preview` emits `envelope/1` **without `--json`** — unlike every other command this server drives, the envelope is the default output.
2. Its `width`/`height` are the **source's**, not the preview's: a 768×768 input rendered to a 480×480 preview reports `768`/`768`.
3. It reports `fps: 25.0` for a **static PNG** — a default, not a measurement, in the same family as ground truth #15's inert slot addresses. `duration` is correctly `null` for the same file.
4. It fails through the envelope with `preview_input_not_found` and `preview_failed`, **neither in comfy-cli's published `error_codes.py`** — a fourth open-string vocabulary, per non-negotiable #2.
5. It requires `ffmpeg`/`ffprobe`, **including for images**: the failure on a non-media file is an ffmpeg probe error (`Invalid data found when processing input`).

Also record the size finding, since it is the reason this feature embeds nothing: `comfy preview` converges to ~650–700 KB regardless of input size, which **inflates** a small PNG (8,589 B → 31,556 B, 3.67×) while bounding a large one (11,799,806 B → 649,734 B, 0.06×).

- [ ] **Step 2: Commit**

```
but commit -b artifact-local-paths -m "docs: ground truth for comfy preview" <ids>
```

---

## Task 5: Live verification — BLOCKED, do not mark this plan done without it

Spec §8's first criterion is a real run on `xinde-win-64` returning `outputs.fetched` with a path under `~/.cache/mcp-comfyui/fetched/<prompt_id>/`, with no argument passed. **Both hosts were down for the whole design and planning pass**, so this could not be done and has no step above.

It matters more than usual here, because of a limit the suite cannot work around: **the happy path is not fully constructible in tests.** `deno task test` grants only loopback plus `192.0.2.1`, and any address it can serve on is `local` — so a host that is both *remote* and *reachable* does not exist in the fixtures. The tests above split that pair: the policy gate is exercised against `REMOTE_ADDRESS`, and the probe-and-fetch against a loopback fixture. Only a live remote exercises them joined.

When a host is up, run `dist/index.js` under `node` over real stdio against it and confirm: a completed job's `outputs.fetched` names a file that exists here, `local_paths` is still `{}`, and a video-sized output lands in `not_fetched` naming `fetch_outputs`. Record the result in CLAUDE.md's "Verified end to end" section, as every previous feature here did.

---

## Deferred, with the measurements already taken

Kept so a future session need not re-derive them. **Neither is approved work.**

- **Video contact sheets.** A fetched `.mp4` is a path a client cannot render; `comfy preview` on it would produce a PNG that a client can, still as a path rather than bytes. ~0.5 s per artifact. Left out to keep this change to one idea.
- **Batch and sweep** (the old Stage 4, never started). `comfy workflow vary` zips per-slot value lists into N workflow variants; `comfy jobs wait <id> <id> …` blocks on all of them with one call, with `--timeout` and `--all`. Both are envelope-clean and take file paths, so both fit the thin-orchestrator model. Today a 5-seed sweep is 5 submits and 5 polling loops. Explicitly out of scope, with reasons already measured: cloud routing (`--where cloud`) breaks the locality model `refuseRemoteTarget`/`resolveArtifactPath` are built on; `comfy generate` is a non-graph proxy call that spends credits with no MCP analogue for its spend gate; node/model discovery was cut because `validate_workflow` already answers it per-host and `comfy models` is non-functional without a running server (ground truth #34).
- **`/view?preview=webp`.** Unverified — both hosts were down on 2026-08-22. Would make remote image previews nearly free if real. Unnecessary at a 16 MiB ceiling.

## Release note

`deno task release patch` (or `minor`/`major`) rewrites all three places the version lives: `deno.json`, `SERVER_VERSION` in `src/server.ts`, and the CHANGELOG's `[Unreleased]` heading. It edits and stops — no commit, no push, no publish, because JSR will not reissue a spent version number. Do **not** hand-edit `SERVER_VERSION`, and do not use a bare `deno bump-version`.

**Remove this file when all four tasks are done and the work has merged** — per CLAUDE.md, a plan does not outlive its work.
