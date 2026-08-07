/**
 * Flat re-exports over `@std/testing/bdd` and `@std/expect`, so a test file
 * needs to change only its import line, not every call site.
 *
 * `it` (aliased `test`) with module-level `beforeEach`/`afterEach`/`beforeAll`
 * — no `describe` wrapper — gives every test file flat semantics: the hooks
 * apply to every `test()` in the same file, verified directly (see the
 * migration report). `@std/testing/bdd` nests the whole file under one
 * synthetic "global" `Deno.test`, with each `test()` a step of it; `deno
 * test`'s summary line counts steps separately from top-level tests, and the
 * per-file step counts are what add up to the suite total.
 *
 * `test.each` has no equivalent here — `@std/testing/bdd` does not provide
 * one — so the handful of call sites that used it are expanded into explicit
 * cases instead of growing a bespoke table-test helper.
 */
export { afterAll, afterEach, beforeAll, beforeEach, it as test } from "@std/testing/bdd";
export { expect } from "@std/expect";
export { delay as sleep } from "@std/async/delay";
