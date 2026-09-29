// nodeTestRunnability.spec.ts — the pure "can `npm test` run without installing anything?" classifier
// (external v0.14.3 evaluation 2026-09-27 §6.2: a zero-dependency `node --test` suite was reported as
// "dependencies not installed — verify by diff review" although it runs and passes).
import { describe, expect, it } from "vitest";

import {
  classifyNodeTestRunnability,
  scriptExecutables,
  type NodePackageManifestLike,
} from "../util/nodeTestRunnability.js";

const FIXTURE = {
  name: "http-fixture",
  private: true,
  type: "module",
  scripts: { test: "node --test tests/runtime.test.mjs" },
} as NodePackageManifestLike;

const withTest = (test: unknown, extra: NodePackageManifestLike = {}): NodePackageManifestLike => ({ ...extra, scripts: { test } });

describe("classifyNodeTestRunnability", () => {
  it("a zero-dependency node --test suite runs without node_modules", () => {
    expect(classifyNodeTestRunnability(FIXTURE, false)).toEqual({ runnable: true, reason: "no-install-needed" });
  });

  it("declared devDependencies without node_modules are not runnable (honesty control)", () => {
    expect(classifyNodeTestRunnability({ ...FIXTURE, devDependencies: { vitest: "^2" } }, false))
      .toEqual({ runnable: false, reason: "dependencies-not-installed" });
  });

  it("a reachable node_modules wins over declared dependencies", () => {
    expect(classifyNodeTestRunnability({ ...FIXTURE, devDependencies: { vitest: "^2" } }, true))
      .toEqual({ runnable: true, reason: "node-modules-present" });
  });

  it("a non-builtin executable with zero dependencies is not runnable", () => {
    expect(classifyNodeTestRunnability(withTest("vitest run"), false))
      .toEqual({ runnable: false, reason: "dependencies-not-installed" });
  });

  it("npx is never builtin, but a reachable node_modules wins", () => {
    expect(classifyNodeTestRunnability(withTest("npx vitest"), false).runnable).toBe(false);
    expect(classifyNodeTestRunnability(withTest("npx vitest"), true))
      .toEqual({ runnable: true, reason: "node-modules-present" });
  });

  it("leading NAME=value assignments are stripped", () => {
    expect(classifyNodeTestRunnability(withTest("NODE_OPTIONS=--no-warnings node --test"), false).runnable).toBe(true);
  });

  it("npm is builtin only for script-running subcommands", () => {
    expect(classifyNodeTestRunnability({ scripts: { test: "npm run build && node --test", build: "echo done" } }, false).runnable).toBe(true);
    expect(classifyNodeTestRunnability(withTest("npm ci && node --test"), false).runnable).toBe(false);
    expect(classifyNodeTestRunnability(withTest("npm install && node --test"), false).runnable).toBe(false);
  });

  // External v0.14.3 evaluation 2026-09-27 §6.2, finding #18(a): `npm run <x>` was treated as builtin
  // UNCONDITIONALLY, without checking what `<x>` actually runs.
  describe("script-chain resolution (npm run / yarn / pnpm)", () => {
    it("resolves npm run to its target script and only counts as builtin if the target is", () => {
      expect(classifyNodeTestRunnability({ scripts: { test: "npm run unit", unit: "node --test" } }, false))
        .toEqual({ runnable: true, reason: "no-install-needed" });
      expect(classifyNodeTestRunnability({ scripts: { test: "npm run unit", unit: "vitest run" } }, false))
        .toEqual({ runnable: false, reason: "dependencies-not-installed" });
    });

    it("npm test/t chain to the test script itself", () => {
      expect(classifyNodeTestRunnability({ scripts: { test: "npm run pretest && npm test", pretest: "node --version" } }, false).runnable).toBe(false);
    });

    it("resolves yarn <script> and yarn run <script>, but never a non-script yarn subcommand", () => {
      expect(classifyNodeTestRunnability({ scripts: { test: "yarn unit", unit: "node --test" } }, false))
        .toEqual({ runnable: true, reason: "no-install-needed" });
      expect(classifyNodeTestRunnability({ scripts: { test: "yarn run unit", unit: "node --test" } }, false).runnable).toBe(true);
      expect(classifyNodeTestRunnability({ scripts: { test: "yarn install && node --test" } }, false).runnable).toBe(false);
    });

    it("resolves pnpm <script> and pnpm run <script> the same way", () => {
      expect(classifyNodeTestRunnability({ scripts: { test: "pnpm unit", unit: "node --test" } }, false).runnable).toBe(true);
      expect(classifyNodeTestRunnability({ scripts: { test: "pnpm run unit", unit: "node --test" } }, false).runnable).toBe(true);
    });

    it("an undeclared chain target is never builtin (it would fail with 'missing script' at runtime)", () => {
      expect(classifyNodeTestRunnability({ scripts: { test: "npm run nonexistent" } }, false).runnable).toBe(false);
      expect(classifyNodeTestRunnability({ scripts: { test: "yarn nonexistent" } }, false).runnable).toBe(false);
    });

    it("a self-referencing chain never infinite-loops and is conservatively non-builtin", () => {
      expect(classifyNodeTestRunnability({ scripts: { test: "npm test" } }, false))
        .toEqual({ runnable: false, reason: "dependencies-not-installed" });
      expect(classifyNodeTestRunnability({ scripts: { test: "npm run a", a: "npm run b", b: "npm run a" } }, false).runnable).toBe(false);
    });

    it("a long acyclic chain of all-builtin scripts still resolves", () => {
      const scripts: Record<string, string> = { test: "npm run s0", s7: "node --test" };
      for (let i = 0; i < 7; i++) scripts[`s${i}`] = `npm run s${i + 1}`;
      expect(classifyNodeTestRunnability({ scripts }, false).runnable).toBe(true);
    });
  });

  // External v0.14.3 evaluation 2026-09-27 §6.2, finding #18(d): shell grouping's closing brace/paren was
  // reported as an "executable" (`}`/`)`), pushing an otherwise all-builtin script to "not installed".
  describe("shell grouping never yields a bracket as an executable", () => {
    it("a `{ …; }` group with a zero-dependency script is runnable", () => {
      expect(classifyNodeTestRunnability(withTest("{ node --test; }"), false))
        .toEqual({ runnable: true, reason: "no-install-needed" });
    });

    it("a `( … )` subshell with a zero-dependency script is runnable", () => {
      expect(classifyNodeTestRunnability(withTest("(node --test)"), false).runnable).toBe(true);
    });

    it("scriptExecutables never lists a bare grouping character", () => {
      expect(scriptExecutables("{ node --test; }")).toEqual(["node"]);
      expect(scriptExecutables("( node --test )")).toEqual(["node"]);
      expect(scriptExecutables("{ node --test && npm run x; }")).toEqual(["node", "npm"]);
    });
  });

  // External v0.14.3 evaluation 2026-09-27 §6.2, finding #18(c): a monorepo member opened directly as the
  // workspace root hides its install one level above a boundary this module never sees past.
  describe("the third parameter (ambiguousAboveWorkspaceRoot)", () => {
    it("downgrades an otherwise-negative verdict to not-determinable", () => {
      expect(classifyNodeTestRunnability({ devDependencies: { vitest: "^2" }, scripts: { test: "vitest run" } }, false, true))
        .toEqual({ runnable: false, reason: "not-determinable" });
    });

    it("never overrides a positive verdict (reachable node_modules, or a builtin-only script)", () => {
      expect(classifyNodeTestRunnability({ devDependencies: { vitest: "^2" }, scripts: { test: "vitest run" } }, true, true).reason)
        .toBe("node-modules-present");
      expect(classifyNodeTestRunnability(FIXTURE, false, true))
        .toEqual({ runnable: true, reason: "no-install-needed" });
    });

    it("defaults to false, so the pre-existing two-argument call site is unaffected", () => {
      expect(classifyNodeTestRunnability({ devDependencies: { vitest: "^2" }, scripts: { test: "vitest run" } }, false))
        .toEqual({ runnable: false, reason: "dependencies-not-installed" });
    });
  });

  it("env counts only when the wrapped command is builtin", () => {
    expect(classifyNodeTestRunnability(withTest("env CI=1 node --test"), false).runnable).toBe(true);
    expect(classifyNodeTestRunnability(withTest("env CI=1 jest"), false).runnable).toBe(false);
  });

  it("executables are compared by basename without extension", () => {
    expect(classifyNodeTestRunnability(withTest("/usr/local/bin/node --test"), false).runnable).toBe(true);
    expect(classifyNodeTestRunnability(withTest("node.exe --test"), false).runnable).toBe(true);
    expect(classifyNodeTestRunnability(withTest("./scripts/run.sh"), false).runnable).toBe(false);
    expect(classifyNodeTestRunnability(withTest("./node_modules/.bin/vitest"), false).runnable).toBe(false);
  });

  it("grouping characters before a command word are ignored", () => {
    expect(classifyNodeTestRunnability(withTest("(node --test)"), false).runnable).toBe(true);
    expect(classifyNodeTestRunnability(withTest("( node --test )"), false).runnable).toBe(true);
  });

  it("a pipe into a non-builtin keeps the conservative verdict", () => {
    expect(classifyNodeTestRunnability(withTest("node --test | tee out.txt"), false).runnable).toBe(false);
  });

  it("missing, blank or non-string scripts.test is no-test-script", () => {
    expect(classifyNodeTestRunnability({}, false)).toEqual({ runnable: false, reason: "no-test-script" });
    expect(classifyNodeTestRunnability(withTest(42), false).reason).toBe("no-test-script");
    expect(classifyNodeTestRunnability(withTest("   "), false).reason).toBe("no-test-script");
  });

  it("a non-object dependencies value counts as empty", () => {
    const manifest = { dependencies: "not-an-object", scripts: { test: "node --test" } } as unknown as NodePackageManifestLike;
    expect(classifyNodeTestRunnability(manifest, false).runnable).toBe(true);
  });
});

describe("scriptExecutables", () => {
  it("keeps a quoted separator inside one segment", () => {
    expect(scriptExecutables('node -e "process.exit(0) && 1"')).toEqual(["node"]);
  });

  it("lists every segment's executable in order, env wrappers unwrapped", () => {
    expect(scriptExecutables("A=1 node --test; npm run lint || env CI=1 -i jest | tee x")).toEqual(["node", "npm", "jest", "tee"]);
  });

  it("never throws on odd input", () => {
    for (const input of ["", "&&", "'unterminated", "A=1", "=x node", '"', "\\", "|| ;;|", "(", "'a\\", "a\"b'c"]) {
      const result = scriptExecutables(input);
      expect(Array.isArray(result)).toBe(true);
      for (const item of result) expect(typeof item).toBe("string");
    }
  });
});
