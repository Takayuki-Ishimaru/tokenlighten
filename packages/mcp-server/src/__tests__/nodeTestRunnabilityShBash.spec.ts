// nodeTestRunnabilityShBash.spec.ts — regression for round-2 evaluation finding P2-14: `sh`/`bash` were
// unconditional BUILTIN entries in nodeTestRunnability.ts, so ANY `sh`/`bash` invocation — including one
// wrapping an uninstalled package binary, or executing an opaque script file — was certified
// "no-install-needed". `sh -c "<cmd>"` / `bash -c "<cmd>"` must classify the inner command; `sh <script>`,
// `bash <script>` and a bare `./x.sh` must report "not-determinable" (this module never reads file
// contents), never "no-install-needed" and never a confident "dependencies-not-installed".
import { describe, expect, it } from "vitest";

import { classifyNodeTestRunnability, type NodePackageManifestLike } from "../util/nodeTestRunnability.js";

const withTest = (test: unknown, extra: NodePackageManifestLike = {}): NodePackageManifestLike => ({ ...extra, scripts: { test } });

describe("classifyNodeTestRunnability — sh/bash", () => {
  it("`sh -c \"<cmd>\"` classifies the inner command as not-builtin when it needs an uninstalled package", () => {
    expect(classifyNodeTestRunnability(withTest('sh -c "vitest run"'), false))
      .toEqual({ runnable: false, reason: "dependencies-not-installed" });
  });

  it("`bash -c \"<cmd>\"` classifies the inner command as builtin when it is zero-dependency", () => {
    expect(classifyNodeTestRunnability(withTest('bash -c "node --test"'), false))
      .toEqual({ runnable: true, reason: "no-install-needed" });
  });

  it("`sh -c` recurses into an npm/yarn/pnpm script-chain target inside the quoted command", () => {
    expect(classifyNodeTestRunnability({ scripts: { test: 'sh -c "npm run unit"', unit: "node --test" } }, false))
      .toEqual({ runnable: true, reason: "no-install-needed" });
    expect(classifyNodeTestRunnability({ scripts: { test: 'sh -c "npm run unit"', unit: "vitest run" } }, false))
      .toEqual({ runnable: false, reason: "dependencies-not-installed" });
  });

  it("`bash scripts/test.sh` (no -c) is not-determinable — file contents are unknown", () => {
    expect(classifyNodeTestRunnability(withTest("bash scripts/test.sh"), false))
      .toEqual({ runnable: false, reason: "not-determinable" });
  });

  it("`sh build.sh` (no -c) is not-determinable, matching `bash`", () => {
    expect(classifyNodeTestRunnability(withTest("sh build.sh"), false))
      .toEqual({ runnable: false, reason: "not-determinable" });
  });

  it("a bare `./x.sh` invoked directly (no sh/bash wrapper) is also not-determinable", () => {
    expect(classifyNodeTestRunnability(withTest("./x.sh"), false))
      .toEqual({ runnable: false, reason: "not-determinable" });
  });

  it("a relative shell script with a leading dir keeps the not-determinable verdict", () => {
    expect(classifyNodeTestRunnability(withTest("scripts/test.sh --ci"), false))
      .toEqual({ runnable: false, reason: "not-determinable" });
  });

  it("bare `sh`/`bash` with no arguments at all (nothing to classify) is not-determinable", () => {
    expect(classifyNodeTestRunnability(withTest("sh"), false))
      .toEqual({ runnable: false, reason: "not-determinable" });
  });

  it("reachable node_modules wins over an indeterminate sh/bash script", () => {
    expect(classifyNodeTestRunnability(withTest("bash scripts/test.sh"), true))
      .toEqual({ runnable: true, reason: "node-modules-present" });
  });

  it("an indeterminate segment inside a larger chain still yields not-determinable, never a false negative", () => {
    expect(classifyNodeTestRunnability(withTest("node --test && bash scripts/extra.sh"), false))
      .toEqual({ runnable: false, reason: "not-determinable" });
  });

  it("`sh -c` with a non-.sh command basename inside is unaffected (regression control)", () => {
    expect(classifyNodeTestRunnability(withTest('sh -c "node --version"'), false))
      .toEqual({ runnable: true, reason: "no-install-needed" });
  });
});
