# Batch and Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One call produces N workflow variants, submits them all, and optionally blocks on all of them.

**Architecture:** `comfy workflow vary --out-dir` writes each variant to a file and — measured — omits the graphs from its envelope entirely. This server reads only the returned file paths and submits each by path, so no workflow graph ever enters JS. `comfy jobs wait` joins them in one call.

**Tech Stack:** Deno 2 (tests), `tsc` (authoritative typecheck), `@std/testing/bdd` via `tests/support/testing.ts`, `tests/fixtures/fake-comfy` for the CLI, `Deno.serve({port:0})` for HTTP.

**Spec:** `docs/plans/2026-08-22-batch-and-sweep-design.md` — read it first, especially §1.

## Global Constraints

- **NEVER let JS parse a variant graph.** Always pass `--out-dir`; read `written` only. Measured: without `--out-dir`, `data.variants` carries whole 6.5 KB graphs, and a 2^64−1 seed would round to `18446744073709552000`. This is non-negotiable #1 and it is the reason the design has the shape it does.
- **`--slot` values are JSON arrays.** `--slot '3.seed=[1,2,3]'`. A comma list is refused with `workflow_slot_invalid`.
- **Lists are ZIPPED, not crossed.** Two lists of 3 give 3 variants, not 9.
- **Global flags precede the subcommand** (non-negotiable #4): `comfy --json --skip-prompt workflow vary …`.
- **Branch on the envelope, never the exit code** (non-negotiable #3).
- **Never `git commit`.** GitButler only: `but commit -b <branch> -m "…" <ids>`. PRs required; never `but land`.
- **`deno task test`** for the suite, **`deno task test:one <file>`** for one file; a bare `deno test <file>` fails.
- **Never run two `deno test` invocations at once.**
- **`caffeinate -i`** around long runs — this machine sleeps.
- **Fixture modes in `tests/fixtures/fake-comfy` are append-only.**
- **Mutation testing is the standard**: construct each named mutant, confirm the test dies, restore by checksum.
- **No personally identifying markers** in any tracked file — see the global privacy rule. Use `~/`, `rtx-video`, `198.51.100.10`.
- **`SWEEP_FETCH_BUDGET_BYTES = 64 * 1024 * 1024`**; per-artifact ceiling stays `AUTO_FETCH_MAX_BYTES` (16 MiB).

---

## File Structure

| file | responsibility |
|---|---|
| `src/workflows/vary.ts` | **new** — wraps `comfy workflow vary --out-dir`, decodes its envelope, returns the written file paths and nothing else. The single place that must not touch `variants`. |
| `src/comfy/jobs.ts` | gains `waitForJobs(ids, target, timeoutMs)` over `comfy jobs wait`. |
| `src/tools.ts` | registers `run_sweep`; the sweep-wide copy budget; the response shape. |
| `tests/vary.test.ts` | **new** — envelope decoding, the no-graph guarantee, error codes |
| `tests/server.test.ts` | `run_sweep` end to end through the MCP surface |
| `tests/fixtures/fake-comfy` | a new append-only `vary` case |

---

### Task 1: `vary.ts` — variants as files, never as graphs

**Files:** Create `src/workflows/vary.ts`, `tests/vary.test.ts`; modify `tests/fixtures/fake-comfy`.

**Interfaces:**
- Produces: `varyWorkflow(file: string, lists: Record<string, unknown[]>, opts: {host?, port?, objectInfoPath?, outDir: string, timeoutMs?}): Promise<{count: number, written: string[], warnings: Array<{code: string, message: string}>, stale: boolean}>`

- [ ] **Step 1: Add the fake-comfy case** (append-only — do not edit existing modes)

In `tests/fixtures/fake-comfy`, add a `workflow vary` case driven by a new `$FAKE_COMFY_VARY_MODE`, defaulting to writing `$3/<stem>_000.json …` files and emitting an `envelope/1` whose `data` carries `{workflow, count, warnings: [], out_dir, written, stale: false}` — **and no `variants` key**, matching the real CLI's behaviour under `--out-dir`.

- [ ] **Step 2: Write the failing tests**

```ts
test("a variant's graph never enters this process", async () => {
  // THE constraint. Measured 2026-08-22: without --out-dir the real CLI
  // returns `data.variants` as whole frontend graphs, 6,489 bytes each, and
  // parsing one would round every seed above 2^53 — which is the exact value a
  // seed sweep exists to vary. `--out-dir` makes `variants` absent; this test
  // pins that we depend on the file path and would notice if a future version
  // started returning graphs anyway.
  //
  // Mutant: have vary.ts read `data.variants` instead of `data.written`.
  // This test dies, because the fixture emits no `variants` at all.
  const out = makeDir("vary-out");
  const result = await varyWorkflow(WORKFLOW, { "3.seed": [1, 2, 3] }, { outDir: out });

  expect(result.count).toBe(3);
  expect(result.written).toHaveLength(3);
  for (const path of result.written) expect(existsSync(path)).toBe(true);
  // Nothing graph-shaped on the returned object, at any depth.
  expect(JSON.stringify(result)).not.toContain("last_node_id");
  expect(JSON.stringify(result)).not.toContain("\"nodes\"");
});

test("--out-dir is always passed, even when the caller did not think to", async () => {
  // The no-graph guarantee is only as good as the flag that produces it.
  //
  // Mutant: drop `--out-dir` from the argv. This test dies on the missing flag.
  const log = argvLog();
  const out = makeDir("vary-out");

  await varyWorkflow(WORKFLOW, { "3.seed": [1, 2] }, { outDir: out });

  const argv = readArgv(log);
  expect(argv).toContain("--out-dir");
  // And the global flags precede the subcommand — non-negotiable #4.
  expect(argv.indexOf("--json")).toBeLessThan(argv.indexOf("workflow"));
});

test("each slot's values are sent as a JSON array", async () => {
  // Measured: `--slot '3.seed=1,2,3'` is refused with `workflow_slot_invalid`,
  // "value must be a JSON array (got str)". A comma-joined list is the obvious
  // wrong thing to build and the CLI catches it, but only after a round trip.
  //
  // Mutant: join with commas instead of JSON.stringify. Dies here.
  const log = argvLog();
  await varyWorkflow(WORKFLOW, { "3.seed": [1, 2] }, { outDir: makeDir("vary-out") });

  expect(readArgv(log)).toContain(`3.seed=[1,2]`);
});

test("a huge seed is passed as digits, not as a rounded JS number", async () => {
  // 2^64−1 is what ComfyUI accepts and what JavaScript cannot hold. A caller
  // passing it as a STRING must see those digits reach the CLI untouched — the
  // same rule `setSlots.ts` follows for a single run, now for a list.
  //
  // Mutant: `Number(value)` anywhere in the argv construction. Dies on the
  // rounded 18446744073709552000.
  const log = argvLog();
  await varyWorkflow(WORKFLOW, { "3.seed": ["18446744073709551615", 1] }, {
    outDir: makeDir("vary-out"),
  });

  const argv = readArgv(log);
  expect(argv).toContain("18446744073709551615");
  expect(argv).not.toContain("18446744073709552000");
});

test("mismatched list lengths are refused before any CLI call", async () => {
  // The CLI zips, so lists of 3 and 2 silently produce 2 variants — valid
  // output of the wrong size, which is worse than an error. Caught here, where
  // the message can name both lengths, and without spending a round trip.
  //
  // Mutant: drop the length check. Dies because the CLI is invoked at all.
  const log = argvLog();

  await expect(
    varyWorkflow(WORKFLOW, { "3.seed": [1, 2, 3], "6.text": ["a", "b"] }, {
      outDir: makeDir("vary-out"),
    }),
  ).rejects.toThrow(/same length/);

  expect(invocationsOf(log)).toHaveLength(0);
});
```

- [ ] **Step 3: Run to verify they fail**

`caffeinate -i deno task test:one tests/vary.test.ts` → FAIL (`varyWorkflow` undefined).

- [ ] **Step 4: Implement `src/workflows/vary.ts`**

Model it on `src/workflows/notes.ts` (envelope decode, its own timeout, `looseObject` for undeclared fields). The payload schema declares `workflow`, `count`, `out_dir`, `written`, `warnings`, `stale` — and **deliberately does not declare `variants`**, with a comment saying why: declaring it would invite a future reader to use it.

Validate list lengths first, then build argv:

```
--json --skip-prompt workflow vary <file> --slot 'ADDR=<JSON>' … --out-dir <dir> [--input <cache>] [--host …] [--port …]
```

Values go through `JSON.stringify` on the array, with a string element emitted as-is when it is all digits — the `setSlots.ts` rule for values JS cannot hold.

- [ ] **Step 5: Run to verify they pass**, then `deno task typecheck`.

- [ ] **Step 6: Confirm the five mutants**, restoring by checksum each time.

- [ ] **Step 7: Commit** — `but commit -b batch-and-sweep -m "feat(vary): variants as files, never as graphs" <ids>`

---

### Task 2: `waitForJobs` — one call, N jobs

**Files:** Modify `src/comfy/jobs.ts`, `tests/jobs.test.ts`; append a `jobs wait` case to `tests/fixtures/fake-comfy`.

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `waitForJobs(promptIds: readonly string[], target: {host, port}, opts?: {timeoutMs?: number}): Promise<JobStatus[]>`

- [ ] **Step 1: Write the failing tests**

```ts
test("waiting on several jobs is ONE cli invocation, not one per id", async () => {
  // The entire reason this primitive is worth using: a five-variant sweep is
  // one blocking call, not five polling loops.
  //
  // Mutant: loop `getJobStatus` per id. Dies on five invocations.
  const log = argvLog();
  serveJobsWait([completed("a"), completed("b"), completed("c")]);

  const statuses = await waitForJobs(["a", "b", "c"], TARGET);

  expect(statuses).toHaveLength(3);
  expect(invocationsOf(log, "jobs")).toHaveLength(1);
});

test("the timeout reaches the CLI rather than being enforced here", async () => {
  // `jobs wait` has its own --timeout, and a second timer on this side would
  // race it and report the wrong thing.
  //
  // Mutant: drop --timeout from the argv. Dies on the missing flag.
  const log = argvLog();
  serveJobsWait([completed("a")]);

  await waitForJobs(["a"], TARGET, { timeoutMs: 90_000 });

  const argv = readArgv(log);
  expect(argv).toContain("--timeout");
  expect(argv).toContain("90");   // seconds, not milliseconds
});

test("a wait that times out is an answer about the jobs, not a thrown error", async () => {
  // A sweep that outlasts its budget has still submitted every job, and the
  // prompt_ids are the valuable part. Same posture as run_workflow's own
  // timeout: the error names what survived.
  //
  // Mutant: let the CLI error propagate unclassified. Dies on the kind.
  serveJobsWaitTimeout();

  const error = await failureOf(() => waitForJobs(["a", "b"], TARGET, { timeoutMs: 1_000 }));

  expect(error.kind).toBe("comfy_timeout");
  expect(String(error.message)).toContain("a");
});
```

- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement** on the model of `getJobStatus` in the same file — same envelope decode, same open-string `status` (non-negotiable #2), `--timeout` in **seconds**.
- [ ] **Step 4: Run to verify they pass**; `deno task typecheck`.
- [ ] **Step 5: Confirm the three mutants.**
- [ ] **Step 6: Commit** — `but commit -b batch-and-sweep -m "feat(jobs): wait on many jobs in one call" <ids>`

---

### Task 3: The `run_sweep` tool

**Files:** Modify `src/tools.ts`, `tests/server.test.ts`, `CHANGELOG.md`, `README.md`.

**Interfaces:**
- Consumes: `varyWorkflow` (Task 1), `waitForJobs` (Task 2), plus the existing `runWorkflow`, `recordJobHost`, `fetchIfAsked`, `outputsBody`.
- Produces: the `run_sweep` MCP tool.

- [ ] **Step 1: Write the failing tests**

```ts
test("a sweep submits one run per variant and returns every prompt_id", async () => {
  // Mutant: submit only the first variant. Dies on the count.
  writeWorkflow("default_image_gen");
  serveVary(3);
  serveRunSequence(["p-0", "p-1", "p-2"]);

  const body = await ok(await connect(), "run_sweep", {
    workflow: "default_image_gen",
    inputs: { "3.seed": [1, 2, 3] },
  });

  expect(body["variant_count"]).toBe(3);
  const runs = body["runs"] as Array<Record<string, unknown>>;
  expect(runs.map((r) => r["prompt_id"])).toEqual(["p-0", "p-1", "p-2"]);
});

test("every variant's prompt_id is attributed to the host that ran it", async () => {
  // A sweep of five is five ledger entries, so `get_job` on any of them works
  // with no `host` argument — the whole point of jobLedger.ts, at N.
  //
  // Mutant: record only the last prompt_id. Dies on the middle one.
  writeWorkflow("default_image_gen");
  serveVary(3);
  serveRunSequence(["p-0", "p-1", "p-2"]);

  await ok(await connect(), "run_sweep", {
    workflow: "default_image_gen",
    inputs: { "3.seed": [1, 2, 3] },
  });
  const body = await ok(await connect(), "get_job", { prompt_id: "p-1" });

  expect(body["prompt_id"]).toBe("p-1");
});

test("one variant that will not submit does not deny the others", async () => {
  // The rule fetchArtifacts already follows. Four good runs are the answer;
  // the fifth's failure is reported beside them.
  //
  // Mutant: let a submit failure throw out of the sweep. Dies on the missing
  // prompt_ids.
  writeWorkflow("default_image_gen");
  serveVary(3);
  serveRunSequence(["p-0", { error: "prompt_rejected" }, "p-2"]);

  const body = await ok(await connect(), "run_sweep", {
    workflow: "default_image_gen",
    inputs: { "3.seed": [1, 2, 3] },
  });

  expect((body["runs"] as unknown[])).toHaveLength(2);
  const failed = body["failed"] as Array<Record<string, unknown>>;
  expect(failed).toHaveLength(1);
  expect(failed[0]?.["code"]).toBe("prompt_rejected");
});

test("mismatched list lengths are refused with both lengths named", async () => {
  // Zipped, not crossed — the error a caller is most likely to need.
  //
  // Mutant: pass the lists through unchecked. Dies because the call succeeds.
  writeWorkflow("default_image_gen");

  const error = await failure(await connect(), "run_sweep", {
    workflow: "default_image_gen",
    inputs: { "3.seed": [1, 2, 3], "6.text": ["a", "b"] },
  });

  expect(String(error["message"])).toContain("3");
  expect(String(error["message"])).toContain("2");
});

test("a sweep past the copy budget discloses the rest rather than copying them", async () => {
  // Sixteen variants at a few MB each is tens of megabytes from one call that
  // asked for none of it. The per-artifact ceiling does not bound a SWEEP.
  //
  // Mutant: drop the sweep budget and keep only the per-artifact ceiling.
  // Dies because everything is fetched.
  writeWorkflow("default_image_gen");
  remoteHost();
  serveVary(3);
  serveRunSequenceWithLargeOutputs(["p-0", "p-1", "p-2"], 40 * 1024 * 1024);

  const body = await ok(await connect(), "run_sweep", {
    workflow: "default_image_gen",
    inputs: { "3.seed": [1, 2, 3] },
    host: "far",
  });

  const runs = body["runs"] as Array<Record<string, Record<string, unknown>>>;
  const skipped = runs.flatMap((r) => (r["outputs"]?.["not_fetched"] as unknown[]) ?? []);
  expect(skipped.length).toBeGreaterThan(0);
  expect(JSON.stringify(skipped)).toContain("budget");
});

test("the temp directory the variants were written to does not outlive the call", async () => {
  // `setSlots.ts`'s rule: this server's own scratch is disposed on every path.
  // Disposal happens after ALL submissions, because a submitted file must
  // outlive its own submit.
  //
  // Mutant: dispose per variant, inside the loop. Dies because variant 2's
  // file is gone before it is submitted.
  writeWorkflow("default_image_gen");
  serveVary(3);
  serveRunSequence(["p-0", "p-1", "p-2"]);

  await ok(await connect(), "run_sweep", {
    workflow: "default_image_gen",
    inputs: { "3.seed": [1, 2, 3] },
  });

  expect(leakedTempDirs()).toEqual([]);
});
```

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement.** Add `SWEEP_FETCH_BUDGET_BYTES = 64 * 1024 * 1024` beside `AUTO_FETCH_MAX_BYTES`, with the same measurement-first docstring style. Register `run_sweep` with `annotations: { readOnlyHint: false, openWorldHint: true }` — it launches nothing itself but does submit work, so it must not claim to be read-only.

The description's **first sentence** says lists are zipped and gives the array form, because that is the error a caller is most likely to make.

- [ ] **Step 4: Run the full suite and `deno task typecheck`.**
- [ ] **Step 5: Confirm the six mutants.**
- [ ] **Step 6: Update `README.md`** (the tool table and one worked example) and `CHANGELOG.md` under `[Unreleased]`.
- [ ] **Step 7: Commit** — `but commit -b batch-and-sweep -m "feat: run_sweep" <ids>`

---

### Task 4: Live verification

**Files:** possibly `scripts/smoke-remote-artifacts.mjs`'s sibling; `CLAUDE.md`.

- [ ] **Step 1:** With a host up, run a 3-seed sweep through `dist/index.js` under `node` over real stdio. Confirm three `prompt_id`s, three distinct images, `get_job` answering for each with no `host`, and — the one that matters — **a 2^64−1 seed reaching the submitted graph byte-exact**, which no fixture can prove.
- [ ] **Step 2:** Record the result in CLAUDE.md's "Verified end to end", using the redacted placeholders (`rtx-video`, `198.51.100.10`).
- [ ] **Step 3: Commit.**

---

## Ground truth to add once implementation confirms it

Measured 2026-08-22, currently written only in the design doc:

- `comfy workflow vary` returns **whole frontend graphs** in `data.variants` (6,489 bytes each) — and `--out-dir` makes that key **absent**. This is landmine #1 in a third module; the `--out-dir` form is the only safe one.
- `vary` preserves 2^64−1 byte-exact in the file it writes.
- `--slot` values must be **JSON arrays**; a comma list is `workflow_slot_invalid`.
- Lists are **zipped**: two lists of 3 give 3 variants, not 9.
- `vary` consults `/object_info`, accepts `--input`/`--host`/`--port`, and warns `object_info_stale` while still succeeding with nothing running.

**Remove this file when all four tasks are done and the work has merged.**
