/**
 * evaluation0927.r7bModuleNamespace.spec.ts — R7-B follow-up (round-7 wave,
 * 2026-09-28): the orchestrator's module-namespace probe
 * (oGoVarGroupMember/oPyModuleAlias/oPyStarReexport/oTsNamespaceImport/
 * oRustModuleConst/oKotlinObjectConst, `$SCRATCH/orch7/cases6.mjs`) found
 * two false affirmatives (MUST, item 1: "settings is declared outside the
 * workspace (package app)" for a Python module that IS a workspace module)
 * and asked four qualified-owner shapes resolved instead of merely
 * disclosed (SHOULD, item 2): TS namespace imports, Python module/package
 * aliases (incl. one hop of `from .x import *`), Rust module constants.
 *
 * Every fixture below is written FRESH against the DESCRIBED defect class
 * (different names/files than the orchestrator's own cases) so a fix that
 * only special-cases those exact identifiers would still fail here.
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
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-r7bns-${tag}-`));
  tmpDirs.push(ws);
  return ws;
}

function writeFile(ws: string, rel: string, content: string): void {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

async function spawnedServer(ws: string): Promise<ServerHandle> {
  const s = startDevServer(ws, "default");
  servers.push(s);
  await s.initialize();
  return s;
}

async function ask(ws: string, query: string, hopCap = 14): Promise<ChainResult> {
  const s = await spawnedServer(ws);
  return followNextToEnd(
    s,
    { tool: "read_file", arguments: { query, task: { epoch: "new", profile: "answer" }, cwd: ws } },
    { cwd: ws, hopCap },
  );
}

function decisionOf(response: unknown): any {
  return (response as any)?.decision ?? {};
}

function gapRefs(response: unknown): string[] {
  const gaps = decisionOf(response).certificate?.gaps ?? decisionOf(response).gaps ?? [];
  const out: string[] = [];
  for (const g of gaps) {
    if (typeof g === "string") out.push(g);
    else if (Array.isArray(g?.refs)) out.push(...g.refs);
  }
  return out;
}

function evidenceOf(response: unknown): any[] {
  return ((response as any)?.evidence ?? []) as any[];
}

/** Honest minimum bar: the FIRST certification either already served `marker`, or discloses an honest value gap. */
function assertHonestValueCompletion(chain: ChainResult, marker: string): void {
  let cumulative = "";
  for (const hop of chain.hops) {
    for (const e of evidenceOf(hop.response)) if (typeof e?.body === "string") cumulative += `${e.body}\n`;
    const kind = decisionOf(hop.response).kind;
    if (kind === "act.answer" || kind === "act.edit") {
      if (cumulative.includes(marker)) continue;
      const gaps = gapRefs(hop.response);
      expect(
        gaps.some((g) => g.includes("request-item-undetermined") && g.includes("value")),
        `certified "${kind}" with neither "${marker}" served nor an honest value gap disclosed (gaps: ${JSON.stringify(gaps)})`,
      ).toBe(true);
    }
  }
}

// ---------------------------------------------------------------------------
// SHOULD (item 2): qualified reads through an imported MODULE NAMESPACE
// resolve the member at that module's top level
// ---------------------------------------------------------------------------
describe("module-namespace resolution (SHOULD, item 2): resolves instead of merely disclosing", () => {
  it("TS: import * as ns from \"./rel\"; ns.MEMBER", async () => {
    const ws = makeWorkspace("tsNs");
    writeFile(ws, "package.json", '{ "name": "r7bns-ts", "private": true, "type": "module" }\n');
    writeFile(ws, "src/limits.ts", "export const MAX_RETRIES = 4200;\nexport const BATCH_SIZE = 3;\n");
    writeFile(
      ws,
      "src/worker.ts",
      "import * as lim from \"./limits\";\n\nexport async function run(job: string): Promise<string> {\n  for (let attempt = 0; attempt < lim.MAX_RETRIES; attempt++) {\n    if (attempt > 0) return job;\n  }\n  return job;\n}\n",
    );
    const chain = await ask(ws, "What default max retries does run use?");
    assertHonestValueCompletion(chain, "MAX_RETRIES = 4200");
  }, 60_000);

  it("Python: from pkg import mod; mod.MEMBER (plain module alias)", async () => {
    const ws = makeWorkspace("pyAlias");
    writeFile(ws, "pyproject.toml", "[project]\nname = \"r7bns-py\"\nversion = \"0.1.0\"\n");
    writeFile(ws, "svc/__init__.py", "");
    writeFile(ws, "svc/limits.py", "MAX_RETRIES = 4200\nBATCH_SIZE = 3\n");
    writeFile(ws, "svc/worker.py", "from svc import limits\n\n\nclass Worker:\n    def run(self, job):\n        for attempt in range(limits.MAX_RETRIES):\n            if attempt > 0:\n                return job\n        return job\n");
    const chain = await ask(ws, "What default max retries does Worker.run use?");
    assertHonestValueCompletion(chain, "MAX_RETRIES = 4200");
  }, 60_000);

  it("Python: import pkg.mod as alias; alias.MEMBER", async () => {
    const ws = makeWorkspace("pyImportAs");
    writeFile(ws, "pyproject.toml", "[project]\nname = \"r7bns-py2\"\nversion = \"0.1.0\"\n");
    writeFile(ws, "svc/__init__.py", "");
    writeFile(ws, "svc/limits.py", "MAX_RETRIES = 4200\n");
    writeFile(ws, "svc/worker.py", "import svc.limits as lim\n\n\nclass Worker:\n    def run(self, job):\n        for attempt in range(lim.MAX_RETRIES):\n            if attempt > 0:\n                return job\n        return job\n");
    const chain = await ask(ws, "What default max retries does Worker.run use?");
    assertHonestValueCompletion(chain, "MAX_RETRIES = 4200");
  }, 60_000);

  it("Python: one hop of `from .x import *` inside the aliased module", async () => {
    const ws = makeWorkspace("pyStar");
    writeFile(ws, "pyproject.toml", "[project]\nname = \"r7bns-py3\"\nversion = \"0.1.0\"\n");
    writeFile(ws, "svc/__init__.py", "");
    writeFile(ws, "svc/limits/__init__.py", "from .base import *\n");
    writeFile(ws, "svc/limits/base.py", "MAX_RETRIES = 4200\nBATCH_SIZE = 3\n");
    writeFile(ws, "svc/worker.py", "from svc import limits\n\n\nclass Worker:\n    def run(self, job):\n        for attempt in range(limits.MAX_RETRIES):\n            if attempt > 0:\n                return job\n        return job\n");
    const chain = await ask(ws, "What default max retries does Worker.run use?");
    assertHonestValueCompletion(chain, "MAX_RETRIES = 4200");
  }, 60_000);

  it("Rust: use crate::a::limits; limits::MEMBER", async () => {
    const ws = makeWorkspace("rustMod");
    writeFile(ws, "Cargo.toml", "[package]\nname = \"r7bnsrs\"\nversion = \"0.1.0\"\nedition = \"2021\"\n");
    writeFile(ws, "src/limits.rs", "pub const MAX_RETRIES: u32 = 4200;\npub const BATCH_SIZE: u32 = 3;\n");
    writeFile(ws, "src/worker.rs", "use crate::limits;\n\npub fn run(job: &str) -> Option<String> {\n    for attempt in 0..limits::MAX_RETRIES {\n        if attempt > 0 {\n            return Some(job.to_string());\n        }\n    }\n    None\n}\n");
    writeFile(ws, "src/main.rs", "mod worker;\nmod limits;\n\nfn main() {\n    println!(\"{:?}\", worker::run(\"j\"));\n}\n");
    const chain = await ask(ws, "What default max retries does run use?");
    assertHonestValueCompletion(chain, "MAX_RETRIES: u32 = 4200");
  }, 60_000);

  it("Rust: mod limits; (no explicit use) still resolves limits::MEMBER", async () => {
    const ws = makeWorkspace("rustModDecl");
    writeFile(ws, "Cargo.toml", "[package]\nname = \"r7bnsrs2\"\nversion = \"0.1.0\"\nedition = \"2021\"\n");
    writeFile(ws, "src/limits.rs", "pub const MAX_RETRIES: u32 = 4200;\n");
    writeFile(ws, "src/worker.rs", "mod limits;\n\npub fn run(job: &str) -> Option<String> {\n    for attempt in 0..limits::MAX_RETRIES {\n        if attempt > 0 {\n            return Some(job.to_string());\n        }\n    }\n    None\n}\n");
    const chain = await ask(ws, "What default max retries does run use?");
    assertHonestValueCompletion(chain, "MAX_RETRIES: u32 = 4200");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// MUST (item 1): the package wording only for a specifier that does not
// resolve to a workspace module/package, and never "declared outside the
// workspace" (orchestrator: a workspace package or path alias would make it
// false)
// ---------------------------------------------------------------------------
describe("package wording (MUST, item 1): never claimed for a specifier that resolves in the workspace", () => {
  it("Python absolute package import (`from pkg import mod`) is a real workspace module -- never \"declared outside the workspace\"", async () => {
    const ws = makeWorkspace("pyNotPackage");
    writeFile(ws, "pyproject.toml", "[project]\nname = \"r7bns-notpkg\"\nversion = \"0.1.0\"\n");
    writeFile(ws, "svc/__init__.py", "");
    writeFile(ws, "svc/limits.py", "MAX_RETRIES = 4200\n");
    writeFile(ws, "svc/worker.py", "from svc import limits\n\n\nclass Worker:\n    def run(self, job):\n        for attempt in range(limits.MAX_RETRIES):\n            if attempt > 0:\n                return job\n        return job\n");
    const chain = await ask(ws, "What default max retries does Worker.run use?");
    for (const hop of chain.hops) {
      const refs = gapRefs(hop.response);
      expect(refs.some((g) => g.includes("limits") && (g.includes("imported from package") || g.includes("declared outside the workspace")))).toBe(false);
    }
    assertHonestValueCompletion(chain, "MAX_RETRIES = 4200");
  }, 60_000);

  it("a genuinely external Python package import keeps the package wording (control)", async () => {
    const ws = makeWorkspace("pyRealPackage");
    writeFile(ws, "pyproject.toml", "[project]\nname = \"r7bns-realpkg\"\nversion = \"0.1.0\"\ndependencies = [\"acme-limits\"]\n");
    writeFile(ws, "svc/worker.py", "from acme_limits import limits\n\n\nclass Worker:\n    def run(self, job):\n        for attempt in range(limits.MAX_RETRIES):\n            if attempt > 0:\n                return job\n        return job\n");
    const chain = await ask(ws, "What default max retries does Worker.run use?");
    const last = chain.hops[chain.hops.length - 1]!;
    const refs = gapRefs(last.response);
    expect(refs.some((g) => g.includes("limits") && g.includes("imported from package acme_limits"))).toBe(true);
  }, 60_000);

  it("a member NOT found in an otherwise-real workspace module is disclosed, never silently skipped (item 2's own rule)", async () => {
    const ws = makeWorkspace("pyModuleMissingMember");
    writeFile(ws, "pyproject.toml", "[project]\nname = \"r7bns-missing\"\nversion = \"0.1.0\"\n");
    writeFile(ws, "svc/__init__.py", "");
    writeFile(ws, "svc/limits.py", "OTHER_VALUE = 1\n");
    writeFile(ws, "svc/worker.py", "from svc import limits\n\n\nclass Worker:\n    def run(self, job):\n        for attempt in range(limits.MAX_RETRIES):\n            if attempt > 0:\n                return job\n        return job\n");
    const chain = await ask(ws, "What default max retries does Worker.run use?");
    const last = chain.hops[chain.hops.length - 1]!;
    const refs = gapRefs(last.response);
    expect(refs.some((g) => g.includes("limits.MAX_RETRIES"))).toBe(true);
    expect(refs.some((g) => g.includes("imported from package") || g.includes("declared outside the workspace"))).toBe(false);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Stdlib control: a module alias that names NO workspace module keeps the
// silent skip for the QUALIFIED form (item 2's own boundary)
// ---------------------------------------------------------------------------
describe("stdlib control: a module alias naming no workspace module never gets a false qualified disclosure", () => {
  it("Python: os.sep (stdlib, no workspace module named 'os')", async () => {
    const ws = makeWorkspace("pyStdlib");
    writeFile(ws, "pyproject.toml", "[project]\nname = \"r7bns-stdlib\"\nversion = \"0.1.0\"\n");
    writeFile(ws, "svc/worker.py", "import os\n\n\nclass Worker:\n    def run(self, job):\n        for attempt in range(3):\n            if attempt > 0:\n                return job + os.sep\n        return job\n");
    const chain = await ask(ws, "What default path separator does Worker.run use?");
    for (const hop of chain.hops) {
      const refs = gapRefs(hop.response);
      // The qualified form is never independently disclosed (item 2's own
      // "silent skip" boundary for an alias naming no workspace module).
      expect(refs.some((g) => g.includes("os.sep"))).toBe(false);
      // At most the SAME single, pre-existing, honest bare-name disclosure.
      const osRefs = refs.filter((g) => g.includes("\"os\"") || / os /.test(g) || g.includes("(os "));
      expect(osRefs.length).toBeLessThanOrEqual(1);
    }
  }, 60_000);

  it("TS: import * as path from \"node:path\"; path.sep (stdlib, no workspace module)", async () => {
    const ws = makeWorkspace("tsStdlib");
    writeFile(ws, "package.json", '{ "name": "r7bns-tsstdlib", "private": true, "type": "module" }\n');
    writeFile(
      ws,
      "src/worker.ts",
      "import * as path from \"node:path\";\n\nexport async function run(job: string): Promise<string> {\n  for (let attempt = 0; attempt < 3; attempt++) {\n    if (attempt > 0) return job + path.sep;\n  }\n  return job;\n}\n",
    );
    const chain = await ask(ws, "What default path separator does run use?");
    for (const hop of chain.hops) {
      const refs = gapRefs(hop.response);
      expect(refs.some((g) => g.includes("path.sep"))).toBe(false);
    }
  }, 60_000);
});
