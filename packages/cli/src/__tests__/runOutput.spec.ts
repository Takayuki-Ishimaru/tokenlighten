/**
 * runOutput.spec.ts — the `tl run` compressor and runner (2026-11-03).
 *
 * Real runner-shaped outputs (vitest, jest, pytest, tsc, go test), passing
 * and failing: every failure block survives the byte budget, passing lines
 * never displace an error line, the summary and the log path are always
 * there, and the runner itself preserves the exit code and writes the log.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compressRunOutput, detectRunner, looksLikeFailure, stripAnsi, type RunnerId } from "../runOutput.js";
import { exitCodeFor, joinCommandTokens, parseRunArgs, powershellScript, runCommandCaptured, runRun, selectShell, shellArguments, writeRunLog } from "../commands/run.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * The real `npm test` → `node --test --test-reporter=spec` output of a
 * 41-test package with one failure (live check, 2026-11-03: `tl run` ranked
 * it as unknown and printed 1,511 B without the `✖` line, the assertion
 * message or `ℹ fail 1`), and the same package under `--test-reporter=tap`.
 */
const NODE_TEST_SPEC = readFileSync(join(HERE, "fixtures", "node-test-spec-reporter.txt"), "utf8");
const NODE_TEST_TAP = readFileSync(join(HERE, "fixtures", "node-test-tap-reporter.txt"), "utf8");

const roots: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "tl-run-"));
  mkdirSync(join(root, ".git"));
  roots.push(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

const VITEST_FAIL = `
 RUN  v4.1.11 C:/repo

 ❯ packages/cli/src/__tests__/a.spec.ts (3 tests | 1 failed) 42ms
   ✓ group > passes one 3ms
   × group > compares totals 5ms
     → expected 1 to be 2 // Object.is equality
   ✓ group > passes two 1ms
 ✓ packages/cli/src/__tests__/b.spec.ts (2 tests) 11ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  packages/cli/src/__tests__/a.spec.ts > group > compares totals
AssertionError: expected 1 to be 2 // Object.is equality

- Expected
+ Received

- 2
+ 1

 ❯ packages/cli/src/__tests__/a.spec.ts:12:15
     10|   it("compares totals", () => {
     11|     const total = 1;
     12|     expect(total).toBe(2);
       |                   ^
     13|   });
 ❯ file:///C:/repo/node_modules/@vitest/runner/dist/chunk.js:1:1
 ❯ file:///C:/repo/node_modules/@vitest/runner/dist/chunk.js:2:2
 ❯ file:///C:/repo/node_modules/@vitest/runner/dist/chunk.js:3:3

⎯⎯⎯⎯⎯⎯⎯[1/1]⎯⎯⎯⎯⎯⎯⎯

 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 4 passed (5)
   Start at  10:15:00
   Duration  1.23s (transform 50ms, setup 0ms, collect 120ms, tests 53ms)
`;

const VITEST_PASS = `
 RUN  v4.1.11 C:/repo

 ✓ packages/cli/src/__tests__/a.spec.ts (3 tests) 42ms
 ✓ packages/cli/src/__tests__/b.spec.ts (2 tests) 11ms

 Test Files  2 passed (2)
      Tests  5 passed (5)
   Start at  10:15:00
   Duration  0.98s (transform 50ms, setup 0ms, collect 120ms, tests 53ms)
`;

const JEST_FAIL = `
 FAIL  src/sum.test.js
  ● sum › adds numbers

    expect(received).toBe(expected) // Object.is equality

    Expected: 3
    Received: 4

       8 |   it("adds numbers", () => {
    >  9 |     expect(sum(2, 2)).toBe(3);
         |                       ^
      10 |   });

      at Object.<anonymous> (src/sum.test.js:9:23)
      at Promise.then.completed (node_modules/jest-circus/build/utils.js:298:28)

 PASS  src/other.test.js
  ✓ other works (2 ms)

Test Suites: 1 failed, 1 passed, 2 total
Tests:       1 failed, 1 passed, 2 total
Snapshots:   0 total
Time:        1.512 s
Ran all test suites.
`;

const JEST_PASS = `
 PASS  src/sum.test.js
 PASS  src/other.test.js

Test Suites: 2 passed, 2 total
Tests:       2 passed, 2 total
Snapshots:   0 total
Time:        0.9 s
Ran all test suites.
`;

const PYTEST_FAIL = `
============================= test session starts ==============================
platform win32 -- Python 3.12.1, pytest-8.3.2, pluggy-1.5.0
collected 3 items

tests/test_math.py .F.                                                   [100%]

=================================== FAILURES ===================================
__________________________________ test_total __________________________________

    def test_total():
        total = 1
>       assert total == 2
E       assert 1 == 2

tests/test_math.py:7: AssertionError
=========================== short test summary info ============================
FAILED tests/test_math.py::test_total - assert 1 == 2
========================= 1 failed, 2 passed in 0.04s ==========================
`;

const PYTEST_PASS = `
============================= test session starts ==============================
collected 3 items

tests/test_math.py ...                                                   [100%]

============================== 3 passed in 0.03s ===============================
`;

const TSC_FAIL = `
src/a.ts(12,7): error TS2322: Type 'string' is not assignable to type 'number'.
src/b.ts(3,1): error TS2304: Cannot find name 'foo'.

Found 2 errors in 2 files.

Errors  Files
     1  src/a.ts:12
     1  src/b.ts:3
`;

const GO_FAIL = `
=== RUN   TestAdd
--- PASS: TestAdd (0.00s)
=== RUN   TestTotal
    math_test.go:14: total = 1, want 2
--- FAIL: TestTotal (0.00s)
FAIL
FAIL	example.com/pkg	0.004s
ok  	example.com/other	0.002s
`;

const GO_PASS = `
ok  	example.com/pkg	0.004s
ok  	example.com/other	0.002s
`;

function summary(output: string, command: string, exitCode: number, limitBytes?: number, runner?: RunnerId): string {
  return compressRunOutput({
    command, output, exitCode, logPath: ".tokenlighten/.runtime/run/x.log", durationMs: 1234,
    ...(limitBytes !== undefined ? { limitBytes } : {}),
    ...(runner !== undefined ? { runner } : {}),
  });
}

describe("compressRunOutput — runner reports", () => {
  it("detects every supported runner from its output, not the command", () => {
    expect(detectRunner("npm test", VITEST_FAIL)).toBe("vitest");
    expect(detectRunner("npm test", JEST_FAIL)).toBe("jest");
    expect(detectRunner("make check", PYTEST_FAIL)).toBe("pytest");
    expect(detectRunner("npm run build", TSC_FAIL)).toBe("tsc");
    expect(detectRunner("make", GO_FAIL)).toBe("go");
    expect(detectRunner("cargo test", "")).toBe("cargo");
    expect(detectRunner("./scripts/x.sh", "hello")).toBe("unknown");
  });

  it("keeps the vitest failure block, assertion diff and stack head, drops code frames and passing lines", () => {
    const text = summary(VITEST_FAIL, "npx vitest run packages/cli", 1);
    expect(text).toContain("FAIL  packages/cli/src/__tests__/a.spec.ts > group > compares totals");
    expect(text).toContain("AssertionError: expected 1 to be 2");
    expect(text).toContain("- Expected");
    expect(text).toContain("+ 1");
    expect(text).toContain("❯ packages/cli/src/__tests__/a.spec.ts:12:15");
    expect(text).not.toContain("12|     expect(total).toBe(2);");
    expect(text).not.toContain("✓ group > passes one");
    expect(text).toContain("Test Files  1 failed | 1 passed (2)");
    expect(text).toContain("full log: .tokenlighten/.runtime/run/x.log");
    expect(text.startsWith("tl run: exit 1 after 1.2s (vitest)\nfull log: ")).toBe(true);
    expect(text).not.toContain("npx vitest run packages/cli");
    expect(bytes(text)).toBeLessThanOrEqual(4096);
  });

  it("on success keeps the vitest summary and tail with the log path", () => {
    const text = summary(VITEST_PASS, "npx vitest run", 0);
    expect(text).toContain("tl run: exit 0");
    expect(text).toContain("Test Files  2 passed (2)");
    expect(text).toContain("Duration  0.98s");
    expect(text).toContain("full log:");
    expect(bytes(text)).toBeLessThan(bytes(VITEST_PASS) + 300);
  });

  it("keeps jest bullets, expected/received and the first frames; drops PASS files", () => {
    const text = summary(JEST_FAIL, "npx jest", 1);
    expect(text).toContain("FAIL  src/sum.test.js");
    expect(text).toContain("● sum › adds numbers");
    expect(text).toContain("Expected: 3");
    expect(text).toContain("Received: 4");
    expect(text).toContain("at Object.<anonymous> (src/sum.test.js:9:23)");
    expect(text).not.toContain(">  9 |");
    expect(text).not.toContain("PASS  src/other.test.js");
    expect(text).toContain("Tests:       1 failed, 1 passed, 2 total");
    const pass = summary(JEST_PASS, "npx jest", 0);
    expect(pass).toContain("Test Suites: 2 passed, 2 total");
  });

  it("keeps the pytest traceback, E lines, FAILED line and final count", () => {
    const text = summary(PYTEST_FAIL, "python -m pytest", 1);
    expect(text).toContain("__ test_total __");
    expect(text).toContain(">       assert total == 2");
    expect(text).toContain("E       assert 1 == 2");
    expect(text).toContain("tests/test_math.py:7: AssertionError");
    expect(text).toContain("FAILED tests/test_math.py::test_total - assert 1 == 2");
    expect(text).toContain("1 failed, 2 passed in 0.04s");
    const pass = summary(PYTEST_PASS, "pytest", 0);
    expect(pass).toContain("3 passed in 0.03s");
    expect(pass).toContain("collected 3 items");
  });

  it("keeps every tsc error line and the Found line", () => {
    const text = summary(TSC_FAIL, "npx tsc --noEmit", 2);
    expect(text).toContain("src/a.ts(12,7): error TS2322");
    expect(text).toContain("src/b.ts(3,1): error TS2304");
    expect(text).toContain("Found 2 errors in 2 files.");
    expect(text).toContain("tl run: exit 2");
  });

  it("keeps go --- FAIL blocks and package FAIL/ok lines, drops === RUN noise", () => {
    const text = summary(GO_FAIL, "go test ./...", 1);
    expect(text).toContain("--- FAIL: TestTotal (0.00s)");
    expect(text).toContain("math_test.go:14: total = 1, want 2");
    expect(text).toContain("FAIL\texample.com/pkg\t0.004s");
    expect(text).toContain("ok  \texample.com/other");
    expect(text).not.toContain("=== RUN   TestAdd");
    const pass = summary(GO_PASS, "go test ./...", 0);
    expect(pass).toContain("ok  \texample.com/pkg");
  });

  it("never drops a failure header for passing lines, and says how many it had to leave out", () => {
    const failures = Array.from({ length: 60 }, (_, i) =>
      ` FAIL  src/f${i}.spec.ts > case ${i}\nAssertionError: expected ${i} to be ${i + 1}\n ❯ src/f${i}.spec.ts:${i + 1}:3\n`).join("\n");
    const passes = Array.from({ length: 200 }, (_, i) => ` ✓ src/p${i}.spec.ts (1 test) 1ms`).join("\n");
    const output = `${passes}\n\n⎯⎯⎯⎯ Failed Tests 60 ⎯⎯⎯⎯\n\n${failures}\n Test Files  60 failed | 200 passed (260)\n      Tests  60 failed | 200 passed (260)\n   Duration  3s\n`;
    const text = summary(output, "npx vitest run", 1, 2048);
    expect(bytes(text)).toBeLessThanOrEqual(2048);
    expect(text).not.toContain("✓ src/p");
    const kept = (text.match(/^ FAIL  src\/f\d+\.spec\.ts/gm) ?? []).length;
    expect(kept).toBeGreaterThan(10);
    expect(text).toMatch(/… \d+ more failure lines in the log/);
    // The lowest-ranked lines (details, summary, tail) give way before any FAIL header.
    expect(kept + Number(/… (\d+) more failure lines/.exec(text)![1])).toBe(60);
  });

  it("falls back to head + tail + log path for an unknown runner, within the limit", () => {
    const output = Array.from({ length: 500 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
    const text = summary(output, "./scripts/deploy.sh", 0, 1024);
    expect(bytes(text)).toBeLessThanOrEqual(1024);
    expect(text).toContain("line 0 ");
    expect(text).toContain("line 499 ");
    expect(text).toContain("…");
    expect(text).toContain("full log:");
  });

  it("node --test (spec reporter, real output): the ✖ line, its AssertionError and ℹ fail 1 survive; the noise lines do not displace them", () => {
    expect(detectRunner("npm test", NODE_TEST_SPEC)).toBe("node-test");
    const text = summary(NODE_TEST_SPEC, "npm test", 1, 1536);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(1536);
    expect(text).toContain("✖ adds two numbers (0.7077ms)");
    expect(text).toContain("AssertionError [ERR_ASSERTION]: EXPECTED_FAILURE_MARKER sum is wrong");
    expect(text).toContain("2 !== 3");
    expect(text).toContain("at TestContext.<anonymous>");
    expect(text).toContain("code: 'ERR_ASSERTION'");
    expect(text).toContain("ℹ fail 1");
    expect(text).toContain("ℹ pass 40");
    expect(text).not.toContain("noise line for case");
    expect(text).not.toContain("✔ passing case");
    // The failing test is printed twice (inline and under `✖ failing tests:`); it counts once.
    expect(text).toContain("1 failure header)");
    // A whole-budget run keeps the same essentials, nothing passing.
    const roomy = summary(NODE_TEST_SPEC, "node --test --test-reporter=spec", 1);
    expect(roomy).toContain("EXPECTED_FAILURE_MARKER");
    expect(roomy).not.toContain("✔ passing case 39");
    // A quarter of the default budget still keeps the name, the message and the count, never a noise line.
    const tight = summary(NODE_TEST_SPEC, "npm test", 1, 1024);
    expect(bytes(tight)).toBeLessThanOrEqual(1024);
    for (const needle of ["✖ adds two numbers (0.7077ms)", "EXPECTED_FAILURE_MARKER sum is wrong", "ℹ fail 1"]) expect(tight).toContain(needle);
    expect(tight).not.toContain("noise line");
    // A passing node:test run keeps its counts.
    const passing = NODE_TEST_SPEC.split("\n").filter((line) => !/✖|EXPECTED_FAILURE|ERR_ASSERTION|^\s+at |^test at|^\s+\{|^\s+\}|^\s+(generatedMessage|actual|expected|operator|diff):|2 !== 3/.test(line)).join("\n").replace("ℹ fail 1", "ℹ fail 0").replace("ℹ pass 40", "ℹ pass 41");
    const ok = summary(passing, "npm test", 0);
    expect(ok).toContain("ℹ pass 41");
    expect(ok).toContain("ℹ fail 0");
  });

  it("node --test (TAP reporter, real output): not ok with its YAML block and # fail survive; # noise diagnostics do not", () => {
    expect(detectRunner("npm test", NODE_TEST_TAP)).toBe("node-test");
    const text = summary(NODE_TEST_TAP, "npm test", 1, 1536);
    expect(bytes(text)).toBeLessThanOrEqual(1536);
    expect(text).toContain("not ok 41 - adds two numbers");
    expect(text).toContain("EXPECTED_FAILURE_MARKER sum is wrong");
    expect(text).toContain("2 !== 3");
    expect(text).toContain("code: 'ERR_ASSERTION'");
    expect(text).toContain("expected: 3");
    expect(text).toContain("# fail 1");
    expect(text).toContain("# pass 40");
    expect(text).not.toContain("ok 1 - passing case 0");
    expect(text).not.toContain("# Subtest: passing");
    expect(text).not.toContain("noise line for case");
    // At the 512-byte floor the YAML bookkeeping (`duration_ms`, `type`, the long `location`) gives way to the error.
    const tight = summary(NODE_TEST_TAP, "npm test", 1, 512);
    expect(bytes(tight)).toBeLessThanOrEqual(512);
    for (const needle of ["not ok 41 - adds two numbers", "EXPECTED_FAILURE_MARKER sum is wrong"]) expect(tight).toContain(needle);
    expect(tight).not.toContain("duration_ms: 0.825");
    // Nested subtests: the inner `not ok` keeps its deeper YAML, a sibling `ok` ends the block.
    const nested = [
      "TAP version 13",
      "# Subtest: math",
      "    # Subtest: adds",
      "    not ok 1 - adds",
      "      ---",
      "      error: 'EXPECTED_FAILURE_MARKER nested'",
      "      ...",
      "    # Subtest: subtracts",
      "    ok 2 - subtracts",
      "      ---",
      "      duration_ms: 0.1",
      "      ...",
      "not ok 1 - math",
      "# fail 1",
    ].join("\n");
    const nestedText = summary(nested, "node --test", 1);
    expect(nestedText).toContain("not ok 1 - adds");
    expect(nestedText).toContain("error: 'EXPECTED_FAILURE_MARKER nested'");
    expect(nestedText).not.toContain("ok 2 - subtracts");
    expect(nestedText).not.toContain("duration_ms: 0.1");
  });

  it("safety net, real output: the node --test report ranked as an unknown runner (the live failure) keeps the ✖ line, the message and ℹ fail 1 over head and tail", () => {
    for (const limit of [1024, 1536, 4096]) {
      const text = summary(NODE_TEST_SPEC, "npm test", 1, limit, "unknown");
      expect(text).toContain("(unknown)");
      expect(bytes(text)).toBeLessThanOrEqual(limit);
      expect(text).toContain("✖ adds two numbers (0.7077ms)");
      expect(text).toContain("AssertionError [ERR_ASSERTION]: EXPECTED_FAILURE_MARKER sum is wrong");
      expect(text).toContain("ℹ fail 1");
    }
    // Noise lines get only the room the failure lines left: none at 1 KB.
    expect(summary(NODE_TEST_SPEC, "npm test", 1, 1024, "unknown")).not.toContain("noise line for case");
  });

  it("safety net: every listed failure marker is recognised, ordinary lines are not", () => {
    for (const line of [
      "✖ adds two numbers (0.7ms)", "not ok 3 - parses", "FAIL src/a.spec.ts", "--- FAIL: TestParse (0.00s)", "FAILED tests/test_a.py::test_b",
      "> Task :test FAILED", "Error: boom", "    TypeError: x is not a function", "  AssertionError [ERR_ASSERTION]: sum",
      "Uncaught AssertionError: expected", "src/a.ts(3,7): error TS2322: Type 'string'", "code: 'ERR_MODULE_NOT_FOUND'",
      "panic: runtime error: index out of range", "Traceback (most recent call last):", "[ERROR] Tests run: 3, Failures: 1",
      "error[E0308]: mismatched types", "src/main.c:12:5: error: expected ';'",
    ]) expect(looksLikeFailure(line), line).toBe(true);
    for (const line of [
      "noise line for case 0: xxx", "✔ passing case 1 (0.1ms)", "ok 1 - passes", "ℹ fail 0", "all errors handled", "0 failed",
      "console.error is quiet here", "ERROR_CODES loaded", "Failures: none",
    ]) expect(looksLikeFailure(line), line).toBe(false);
  });

  it("safety net: in an unknown runner's output, failure-looking lines and their indented detail outrank head and tail", () => {
    const noise = (n: number, from = 0): string => Array.from({ length: n }, (_, i) => `noise line ${from + i}: ${"x".repeat(60)}`).join("\n");
    const output = `${noise(300)}\nFAILED: widget renders\n    Error: EXPECTED_FAILURE_MARKER widget broke\n        at render (src/widget.js:12:3)\n    code: 'ERR_WIDGET'\n${noise(200, 300)}\nDone with 1 failure.\n`;
    expect(detectRunner("./scripts/check.sh", output)).toBe("unknown");
    const text = summary(output, "./scripts/check.sh", 1, 1024);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(1024);
    expect(text).toContain("FAILED: widget renders");
    expect(text).toContain("Error: EXPECTED_FAILURE_MARKER widget broke");
    expect(text).toContain("at render (src/widget.js:12:3)");
    expect(text).toContain("code: 'ERR_WIDGET'");
    expect(text).toContain("Done with 1 failure.");
    expect((text.match(/noise line/g) ?? []).length).toBeLessThan(10);
    // A long stack does not use up the detail run: frames past the first three
    // are skipped, so the message lines after them still come along.
    const deep = `${noise(50)}\nError: EXPECTED_FAILURE_MARKER deep\n${Array.from({ length: 20 }, (_, i) => `    at f${i} (src/f.js:${i}:1)`).join("\n")}\n    code: 'ERR_DEEP'\n${noise(50, 50)}\n`;
    const deepText = summary(deep, "./scripts/check.sh", 1, 1024);
    expect(deepText).toContain("at f2 (src/f.js:2:1)");
    expect(deepText).not.toContain("at f3 (src/f.js:3:1)");
    expect(deepText).toContain("code: 'ERR_DEEP'");
    // The same output through a recognised runner's ranker keeps its own tiers for ranked lines
    // and still rescues an unranked Error line.
    const vitestish = ` RUN  v4.1.11\n ✓ a.spec.ts (1 test) 1ms\nError: EXPECTED_FAILURE_MARKER from a console.error in a test\n    at x (src/x.ts:1:1)\n Test Files  1 passed (1)\n      Tests  1 passed (1)\n   Duration  1s\n`;
    const rescued = summary(vitestish, "npx vitest run", 1, 1024);
    expect(rescued).toContain("Error: EXPECTED_FAILURE_MARKER from a console.error");
    expect(rescued).toContain("at x (src/x.ts:1:1)");
  });

  it("safety net, recognised runner: error-looking console output of passing tests never displaces the runner's own failure block or summary", () => {
    // The real node:test report with every noise line turned into an `Error:` line, as a test
    // that exercises error handling and logs it would print.
    const flood = NODE_TEST_SPEC.replace(/noise line for case (\d+)/g, "Error: expected console noise $1");
    expect(detectRunner("npm test", flood)).toBe("node-test");
    const text = summary(flood, "npm test", 1, 1536);
    expect(bytes(text)).toBeLessThanOrEqual(1536);
    expect(text).toContain("✖ adds two numbers (0.7077ms)");
    expect(text).toContain("EXPECTED_FAILURE_MARKER sum is wrong");
    expect(text).toContain("ℹ fail 1");
    // With room to spare the rescued console lines come along too.
    expect(summary(flood, "npm test", 1, 8192)).toContain("Error: expected console noise 0");
  });

  it("does not take mocha's `✔ name (12ms)` lines for node:test, and closes up gaps of blank lines without a marker", () => {
    expect(detectRunner("npm test", "  math\n    ✔ adds (12ms)\n    1) subtracts\n\n  1 passing (20ms)\n  1 failing\n")).toBe("unknown");
    const text = summary("FAIL one\n\n\n  detail\nok\nFAIL two\n", "./check.sh", 1, 4096, "unknown");
    expect(text).toContain("FAIL one\n  detail\n");
  });

  it("safety net: in an unknown runner's output, failure-looking lines and their indented detail outrank head and tail", () => {
    const noise = (n: number, from = 0): string => Array.from({ length: n }, (_, i) => `noise line ${from + i}: ${"x".repeat(60)}`).join("\n");
    const output = `${noise(300)}\nFAILED: widget renders\n    Error: EXPECTED_FAILURE_MARKER widget broke\n        at render (src/widget.js:12:3)\n    code: 'ERR_WIDGET'\n${noise(200, 300)}\nDone with 1 failure.\n`;
    expect(detectRunner("./scripts/check.sh", output)).toBe("unknown");
    const text = summary(output, "./scripts/check.sh", 1, 1024);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(1024);
    expect(text).toContain("FAILED: widget renders");
    expect(text).toContain("Error: EXPECTED_FAILURE_MARKER widget broke");
    expect(text).toContain("at render (src/widget.js:12:3)");
    expect(text).toContain("code: 'ERR_WIDGET'");
    expect(text).toContain("Done with 1 failure.");
    expect((text.match(/noise line/g) ?? []).length).toBeLessThan(10);
    // The same output through a recognised runner's ranker keeps its own tiers for ranked lines
    // and still rescues an unranked Error line.
    const vitestish = ` RUN  v4.1.11\n ✓ a.spec.ts (1 test) 1ms\nError: EXPECTED_FAILURE_MARKER from a console.error in a test\n    at x (src/x.ts:1:1)\n Test Files  1 passed (1)\n      Tests  1 passed (1)\n   Duration  1s\n`;
    const rescued = summary(vitestish, "npx vitest run", 1, 1024);
    expect(rescued).toContain("Error: EXPECTED_FAILURE_MARKER from a console.error");
    expect(rescued).toContain("at x (src/x.ts:1:1)");
  });

  it("strips colour escapes before ranking", () => {
    expect(stripAnsi("\u001b[31m FAIL \u001b[39m x\r\n")).toBe(" FAIL  x\n");
    const text = summary(VITEST_FAIL.replace("AssertionError", "\u001b[1mAssertionError\u001b[22m"), "npx vitest run", 1);
    expect(text).toContain("AssertionError: expected 1 to be 2");
    expect(text).not.toContain("\u001b");
  });
});

describe("tl run — runner", () => {
  const node = process.execPath.replace(/\\/g, "/");

  it("preserves the exit code and captures stdout and stderr in order", async () => {
    const shell = selectShell();
    const run = await runCommandCaptured(`"${node}" -e "console.log('first out');console.error('then err');console.log('last out');process.exit(3)"`, { cwd: fixture(), shell });
    expect(run.exitCode).toBe(3);
    expect(exitCodeFor(run)).toBe(3);
    expect(run.output).toContain("first out");
    expect(run.output).toContain("then err");
    expect(run.output.indexOf("first out")).toBeLessThan(run.output.indexOf("then err"));
    expect(exitCodeFor({ exitCode: null, signal: "SIGTERM" })).toBe(143);
    expect(exitCodeFor({ exitCode: null, signal: null })).toBe(1);
  });

  it("writes the full log under .tokenlighten/.runtime/run and prunes nothing young", () => {
    const root = fixture();
    const path = writeRunLog(root, "npm test", root, { exitCode: 1, signal: null, output: "FAIL everything\n", durationMs: 5 });
    expect(path.startsWith(join(root, ".tokenlighten", ".runtime", "run"))).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("FAIL everything");
    expect(readFileSync(path, "utf8")).toContain("# tl run: npm test");
    expect(readFileSync(join(root, ".tokenlighten", ".gitignore"), "utf8")).toContain("*");
    expect(readdirSync(join(root, ".tokenlighten", ".runtime", "run"))).toHaveLength(1);
  });

  it("parses its own arguments and joins several tokens with quoting", () => {
    expect(parseRunArgs(["--", "npm test"])).toEqual({ commandLine: "npm test" });
    expect(parseRunArgs(["--limit-bytes", "2048", "--", "npx", "vitest", "run", "-t", "my test"]))
      .toEqual({ commandLine: 'npx vitest run -t "my test"', limitBytes: 2048 });
    expect(parseRunArgs(["npm", "test"])).toEqual({ commandLine: "npm test" });
    expect(parseRunArgs(["--limit-bytes", "nope", "--", "x"])).toEqual({ error: "--limit-bytes needs a positive number" });
    expect(parseRunArgs(["--"])).toEqual({ error: "no command given" });
    expect(parseRunArgs(["--shell", "powershell", "--", "npm", "test"])).toEqual({ commandLine: "npm test", shell: "powershell" });
    expect(parseRunArgs(["--shell", "fish", "--", "npm", "test"])).toEqual({ error: expect.stringContaining("--shell expects") });
    expect(joinCommandTokens(["echo", 'say "hi"'])).toBe('echo "say \\"hi\\""');
  });

  it("hands the command line to each shell family in the form it parses", () => {
    expect(shellArguments({ command: "/bin/bash", args: ["-c"], mode: "argument" }, "npm test")).toEqual(["-c", "npm test"]);
    expect(shellArguments({ command: "cmd.exe", args: ["/d", "/s", "/c"], mode: "cmd" }, "npm test")).toEqual(["/d", "/s", "/c", '"npm test"']);
    const encoded = shellArguments({ command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-EncodedCommand"], mode: "powershell" }, "npm test");
    expect(encoded.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    expect(Buffer.from(encoded[3]!, "base64").toString("utf16le")).toBe(powershellScript("npm test"));
    expect(powershellScript("npm test")).toContain("exit $LASTEXITCODE");
    // An explicitly requested shell that this machine lacks falls back to the default choice.
    expect(selectShell({ PATH: "" }, "linux", "powershell").mode).toBe("argument");
    expect(selectShell({ PATH: "", ComSpec: "C:\\Windows\\System32\\cmd.exe" }, "win32", "cmd")).toEqual({ command: "C:\\Windows\\System32\\cmd.exe", args: ["/d", "/s", "/c"], mode: "cmd" });
  });

  it.skipIf(process.platform !== "win32")("--shell powershell runs the command in PowerShell and forwards its exit code", async () => {
    const root = fixture();
    const previous = process.exitCode;
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await runRun(["--root", root, "--shell", "powershell", "--", "node", "-e", "console.log('from powershell'); process.exit(5)"]);
      expect(process.exitCode).toBe(5);
    } finally {
      stdout.mockRestore();
      process.exitCode = previous;
    }
    const logs = readdirSync(join(root, ".tokenlighten", ".runtime", "run"));
    expect(readFileSync(join(root, ".tokenlighten", ".runtime", "run", logs[0]!), "utf8")).toContain("from powershell");
  }, 60000);

  it("runs end to end: compressed stdout, log on disk, the command's exit code", async () => {
    const root = fixture();
    let printed = "";
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => { printed += String(chunk); return true; });
    const previous = process.exitCode;
    try {
      const script = "for (let i = 0; i < 300; i++) console.log('line ' + i); console.error('boom'); process.exit(7)";
      await runRun(["--root", root, "--limit-bytes", "1024", "--", `"${node}" -e "${script}"`]);
      expect(process.exitCode).toBe(7);
    } finally {
      stdout.mockRestore();
      process.exitCode = previous;
    }
    expect(printed).toContain("tl run: exit 7");
    expect(printed).toContain("full log:");
    expect(printed).toContain("boom");
    expect(bytes(printed)).toBeLessThanOrEqual(1024);
    const logs = readdirSync(join(root, ".tokenlighten", ".runtime", "run"));
    expect(logs).toHaveLength(1);
    expect(readFileSync(join(root, ".tokenlighten", ".runtime", "run", logs[0]!), "utf8")).toContain("line 299");
    expect(existsSync(join(root, ".tokenlighten", ".gitignore"))).toBe(true);
  });
});
