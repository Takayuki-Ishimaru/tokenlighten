/**
 * evaluation0927.r6aMentionGuardScope.spec.ts — R6-A (round-6 wave,
 * 2026-09-28): regression coverage for review-findings-fable-r5.md's P0-1
 * (the mention guard's blanket import/export-line skip swallowed aliased
 * specifiers, a default-export rebind and an unrelated value-export whose
 * initializer merely references the member), P1-4 (`.vue`/`.svelte`/
 * `.astro` single-file components were never scanned at all) and P2-6 (a
 * C++ out-of-line member definition the site-detection loop itself judged a
 * DECLARATION was re-examined and misclassified as an unclassified mention
 * by the guard's own weaker, independent check, costing an extra hop).
 *
 * Every fixture below is written FRESH against the DESCRIBED defect class —
 * different identifiers, different file names, different shapes than the
 * reviewer's own cases5.mjs/cases4.mjs fixtures (`brief-round5.md`'s own
 * convention for this style of regression spec) — so a fix that only
 * special-cases the reviewer's exact names would still fail here.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import {
  followNextToEnd,
  startDevServer,
  type ChainResult,
  type ServerHandle,
} from "./helpers/qualityFirstScenarios.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const tmpDirs: string[] = [];
const servers: ServerHandle[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.kill();
});
afterAll(async () => {
  for (const server of servers.splice(0)) await server.kill();
  for (const dir of tmpDirs.splice(0)) {
    try {
      await rmDirWithRetry(dir);
    } catch {
      /* best-effort cleanup */
    }
  }
});

function makeWorkspace(tag: string): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-r6a-${tag}-`));
  tmpDirs.push(ws);
  return ws;
}

function writeFile(ws: string, rel: string, content: string): void {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

async function spawnedServer(ws: string, config: "default" | "vscode" = "default"): Promise<ServerHandle> {
  const s = startDevServer(ws, config);
  servers.push(s);
  await s.initialize();
  return s;
}

async function ask(ws: string, query: string, hopCap = 20, config: "default" | "vscode" = "default"): Promise<ChainResult> {
  const s = await spawnedServer(ws, config);
  return followNextToEnd(
    s,
    { tool: "read_file", arguments: { query, task: { epoch: "new", profile: "answer" }, cwd: ws } },
    { cwd: ws, hopCap },
  );
}

function allWhy(chain: ChainResult): string {
  return chain.hops
    .flatMap((h) => (h.response?.["evidence"] as Array<Record<string, unknown>> | undefined) ?? [])
    .map((e) => String(e["why"] ?? ""))
    .join(" | ");
}

function allGaps(chain: ChainResult): string {
  return chain.hops
    .map((h) => JSON.stringify((h.response?.["decision"] as Record<string, unknown> | undefined)?.["certificate"] ?? {}))
    .join(" | ");
}

function finalDecisionKind(chain: ChainResult): unknown {
  const finalHop = chain.hops[chain.hops.length - 1]!;
  return (finalHop.response?.["decision"] as Record<string, unknown> | undefined)?.["kind"];
}

/** Common assertion for every false-empty-shape case: the chain must never certify a plain "0 call sites" verdict for `name`, whatever else it does (act.answer with real evidence, or an honest discover/undetermined disclosure naming the mention it could not classify). */
function expectNeverFalseEmpty(chain: ChainResult, name: string): void {
  const gaps = allGaps(chain);
  expect(gaps).not.toContain(`request-item-empty:callers:${name} (0 call sites`);
  expect(["act.answer", "discover"]).toContain(finalDecisionKind(chain));
}

// ---------------------------------------------------------------------------
// P0-1 (eval-0927 review-r5 #1): an ALIASED import/export/destructure
// specifier, a default-export rebind, or an ordinary value-export whose
// initializer merely references the member must never be silently
// "explained" by the import/export-line shortcut — a real call through the
// alias is invisible to the literal member scan, so dropping the ONE
// remaining textual trace left the facet falsely certified `empty`.
// ---------------------------------------------------------------------------
function pricingWorkspace(ws: string, extra: (ws: string) => void): void {
  writeFile(ws, "package.json", '{ "name": "pricing-guard", "private": true, "type": "module" }\n');
  writeFile(
    ws,
    "src/pricing.ts",
    "export function computeTotal(amount: number): number {\n  return amount * 2;\n}\n\nexport function unrelatedHelper(x: number): number {\n  return x + 1;\n}\n",
  );
  extra(ws);
}

describe("P0-1 — an aliased or rebound reference is never silently explained away", () => {
  it("TypeScript: an aliased named import (`X as Y`) is not a false empty", async () => {
    const ws = makeWorkspace("p01-alias-import");
    pricingWorkspace(ws, (root) =>
      writeFile(
        root,
        "src/checkout.ts",
        "import { computeTotal as calcTotal } from \"./pricing\";\n\nexport function checkout(amount: number): number {\n  return calcTotal(amount);\n}\n",
      ));
    const chain = await ask(ws, "Who calls computeTotal?");
    expectNeverFalseEmpty(chain, "computeTotal");
  });

  it("TypeScript: an aliased re-export (`export { X as Y } from`) is not a false empty", async () => {
    const ws = makeWorkspace("p01-alias-reexport");
    pricingWorkspace(ws, (root) => {
      writeFile(root, "src/index.ts", "export { computeTotal as calcTotal } from \"./pricing\";\n");
      writeFile(
        root,
        "src/checkout.ts",
        "import { calcTotal } from \"./index\";\n\nexport function checkout(amount: number): number {\n  return calcTotal(amount);\n}\n",
      );
    });
    const chain = await ask(ws, "Who calls computeTotal?");
    expectNeverFalseEmpty(chain, "computeTotal");
  });

  it("Python: an aliased import (`import X as Y`) is not a false empty", async () => {
    const ws = makeWorkspace("p01-alias-py");
    writeFile(ws, "pyproject.toml", '[project]\nname = "pricingguard"\nversion = "0.1.0"\n');
    writeFile(ws, "pricing/core.py", "def compute_total(amount):\n    return amount * 2\n");
    writeFile(
      ws,
      "pricing/checkout.py",
      "from .core import compute_total as calc_total\n\n\ndef checkout(amount):\n    return calc_total(amount)\n",
    );
    const chain = await ask(ws, "Who calls compute_total?");
    expectNeverFalseEmpty(chain, "compute_total");
  });

  it("TypeScript: `export default X;` (a default-export rebind) is not a false empty", async () => {
    const ws = makeWorkspace("p01-default-rebind");
    pricingWorkspace(ws, (root) => {
      writeFile(root, "src/handler.ts", "import { computeTotal } from \"./pricing\";\n\nexport default computeTotal;\n");
      writeFile(
        root,
        "src/main.ts",
        "import calcTotal from \"./handler\";\n\nexport function main(): number {\n  return calcTotal(5);\n}\n",
      );
    });
    const chain = await ask(ws, "Who calls computeTotal?");
    expectNeverFalseEmpty(chain, "computeTotal");
  });

  it("TypeScript: `export const x = f(X, ...)` (X merely referenced, not imported/re-exported) is not a false empty", async () => {
    const ws = makeWorkspace("p01-export-const-ref");
    pricingWorkspace(ws, (root) => {
      writeFile(
        root,
        "src/throttle.ts",
        "export function throttle<T extends (...args: never[]) => unknown>(fn: T, ms: number): T {\n  let timer: ReturnType<typeof setTimeout> | undefined;\n  return ((...args: Parameters<T>) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); }) as T;\n}\n",
      );
      writeFile(
        root,
        "src/scheduler.ts",
        "import { throttle } from \"./throttle\";\nimport { computeTotal } from \"./pricing\";\n\nexport const throttledCompute = throttle(computeTotal, 50);\n",
      );
    });
    const chain = await ask(ws, "Who calls computeTotal?");
    expectNeverFalseEmpty(chain, "computeTotal");
  });

  it("CommonJS: a destructure-rename (`const { X: Y } = require(...)`) is not a false empty", async () => {
    const ws = makeWorkspace("p01-cjs-destructure");
    writeFile(ws, "package.json", '{ "name": "cjspricing", "private": true }\n');
    writeFile(
      ws,
      "src/pricing.js",
      "function computeTotal(amount) {\n  return amount * 2;\n}\nmodule.exports = { computeTotal };\n",
    );
    writeFile(
      ws,
      "src/checkout.js",
      "const { computeTotal: calcTotal } = require(\"./pricing.js\");\n\nfunction checkout(amount) {\n  return calcTotal(amount);\n}\nmodule.exports = { checkout };\n",
    );
    const chain = await ask(ws, "Who calls computeTotal?");
    expectNeverFalseEmpty(chain, "computeTotal");
  });

  it("control: a PLAIN (non-aliased) named import still resolves fully — the fix must not over-correct into blanket undetermined", async () => {
    const ws = makeWorkspace("p01-plain-control");
    pricingWorkspace(ws, (root) =>
      writeFile(
        root,
        "src/checkout.ts",
        "import { computeTotal } from \"./pricing\";\n\nexport function checkout(amount: number): number {\n  return computeTotal(amount);\n}\n",
      ));
    const chain = await ask(ws, "Who calls computeTotal?");
    expect(allWhy(chain)).toContain("1 of 1 call sites");
    expectNeverFalseEmpty(chain, "computeTotal");
  });

  it("control: a genuine `export function X` declaration is still recognized as a declaration, not a phantom mention of itself", async () => {
    const ws = makeWorkspace("p01-decl-control");
    writeFile(ws, "package.json", '{ "name": "declcontrol", "private": true, "type": "module" }\n');
    writeFile(ws, "src/pricing.ts", "export function computeTotal(amount: number): number {\n  return amount * 2;\n}\n");
    writeFile(
      ws,
      "src/checkout.ts",
      "import { computeTotal } from \"./pricing\";\n\nexport function checkout(amount: number): number {\n  return computeTotal(amount);\n}\n",
    );
    const chain = await ask(ws, "Who calls computeTotal?");
    // The declaration line itself (`export function computeTotal(...)`) must
    // never surface as an "unclassified mention" -- only the real call site.
    expect(allGaps(chain)).not.toContain("could not classify");
    expect(allWhy(chain)).toContain("1 of 1 call sites");
  });
});

// ---------------------------------------------------------------------------
// P1-4 (eval-0927 review-r5 #4): the facet caller/mention scan never opened
// `.vue`/`.svelte`/`.astro` files at all -- their `<script>` blocks are
// ordinary JS/TS lines once opened. Covered here with `.svelte` and
// `.astro` (the reviewer's own case used `.vue`).
// ---------------------------------------------------------------------------
describe("P1-4 — untracked single-file-component extensions are scanned for callers", () => {
  it("a Svelte component's <script> block is a real call site", async () => {
    const ws = makeWorkspace("p14-svelte");
    pricingWorkspace(ws, (root) =>
      writeFile(
        root,
        "src/Total.svelte",
        "<script lang=\"ts\">\n  import { computeTotal } from \"./pricing\";\n  export let amount: number;\n  const total = computeTotal(amount);\n</script>\n\n<p>{total}</p>\n",
      ));
    const chain = await ask(ws, "Who calls computeTotal?");
    expect(allWhy(chain)).toContain("1 of 1 call sites");
    expectNeverFalseEmpty(chain, "computeTotal");
  });

  it("an Astro component's frontmatter is a real call site", async () => {
    const ws = makeWorkspace("p14-astro");
    pricingWorkspace(ws, (root) =>
      writeFile(
        root,
        "src/Total.astro",
        "---\nimport { computeTotal } from \"./pricing\";\nconst total = computeTotal(4);\n---\n\n<p>{total}</p>\n",
      ));
    const chain = await ask(ws, "Who calls computeTotal?");
    expect(allWhy(chain)).toContain("1 of 1 call sites");
    expectNeverFalseEmpty(chain, "computeTotal");
  });
});

// ---------------------------------------------------------------------------
// P2-6 (eval-0927 review-r5 #6): a C++ out-of-line member definition with a
// trailing qualifier (`const`/`noexcept`) is a DECLARATION the site-
// detection loop itself already recognizes -- it must never additionally
// surface as an unclassified mention (an extra required window / hop).
// ---------------------------------------------------------------------------
describe("P2-6 — an out-of-line C++ member definition is never re-flagged as a mention", () => {
  it("`Owner::member(...) const`/`noexcept` definitions never cost an extra 'could not classify' hop", async () => {
    const ws = makeWorkspace("p26-cpp-outofline");
    writeFile(ws, "CMakeLists.txt", "cmake_minimum_required(VERSION 3.20)\nproject(gw)\n");
    writeFile(
      ws,
      "include/gateway.hpp",
      "#pragma once\n\nstruct Result { int code; };\n\nclass Gateway {\npublic:\n  Result dispatch(int id) const;\n  Result dispatch(int id, bool retry) noexcept;\n};\n",
    );
    writeFile(
      ws,
      "src/gateway.cpp",
      "#include \"gateway.hpp\"\n\nResult Gateway::dispatch(int id) const {\n  return Result{id};\n}\n\nResult Gateway::dispatch(int id, bool retry) noexcept {\n  return Result{retry ? id : 0};\n}\n",
    );
    writeFile(
      ws,
      "src/main.cpp",
      "#include \"gateway.hpp\"\n#include <iostream>\n\nint main() {\n  Gateway gateway;\n  std::cout << gateway.dispatch(9).code << std::endl;\n  return 0;\n}\n",
    );
    const chain = await ask(ws, "Who calls Gateway::dispatch?");
    expect(allGaps(chain)).not.toContain("could not classify");
    expect(allWhy(chain)).toContain("1 of 1 call sites");
    expectNeverFalseEmpty(chain, "dispatch");
  });
});
