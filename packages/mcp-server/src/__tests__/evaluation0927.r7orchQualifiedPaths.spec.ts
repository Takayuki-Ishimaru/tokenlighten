/**
 * evaluation0927.r7orchQualifiedPaths.spec.ts — orchestrator checks on the
 * round-7 value follow-up (2026-09-28).
 *
 * 1. A `::`-qualified member stays a bare candidate: excluding it silently
 *    dropped `self::MAX` (PHP), `Client::MAX` inside `Client` (C++),
 *    `ns::MAX` for a C++ namespace and `crate::config::MAX` (Rust), so a
 *    value facet could be certified on an inline literal with the constant
 *    neither served nor disclosed. A primitive/standard-library path
 *    (`u32::MAX`) is a language constant and stays out.
 * 2. A Rust module is resolved from its `use` path (grouped, multi-line,
 *    aliased), never by picking a same-named `config.rs` elsewhere: with
 *    `crate::config` and `crate::net::config` both present, the value of
 *    `use crate::net::config;` comes from `src/net/config.rs`.
 * 3. A constant imported through a non-relative specifier this scan does
 *    not resolve is disclosed naming the package, never as "declared outside
 *    the workspace" (a monorepo package or a path alias is inside it).
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
import { constantLikeReferencesIn, rustUseBindings } from "../features/task-pack/evidenceClosure.js";

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
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-r7oq-${tag}-`));
  tmpDirs.push(ws);
  return ws;
}

function writeFile(ws: string, rel: string, content: string): void {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

async function ask(ws: string, query: string): Promise<ChainResult> {
  const s = startDevServer(ws, "default");
  servers.push(s);
  await s.initialize();
  return followNextToEnd(
    s,
    { tool: "tl_read_file", arguments: { query, task: { epoch: "new", profile: "answer" }, cwd: ws } },
    { cwd: ws, hopCap: 14 },
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

function servedBodies(chain: ChainResult): string {
  let all = "";
  for (const hop of chain.hops) {
    for (const e of ((hop.response as any)?.evidence ?? []) as any[]) if (typeof e?.body === "string") all += `${e.body}\n`;
  }
  return all;
}

/** Every certification either already served `marker` or discloses an undetermined value facet. */
function assertHonestValueCompletion(chain: ChainResult, marker: string): void {
  let cumulative = "";
  for (const hop of chain.hops) {
    for (const e of ((hop.response as any)?.evidence ?? []) as any[]) if (typeof e?.body === "string") cumulative += `${e.body}\n`;
    const kind = decisionOf(hop.response).kind;
    if (kind !== "act.answer" && kind !== "act.edit") continue;
    if (cumulative.includes(marker)) continue;
    const gaps = gapRefs(hop.response);
    expect(
      gaps.some((g) => g.includes("request-item-undetermined") && g.includes("value")),
      `certified "${kind}" with neither "${marker}" served nor an honest value gap (gaps: ${JSON.stringify(gaps)})`,
    ).toBe(true);
  }
}

const CARGO = "[package]\nname = \"r7oq\"\nversion = \"0.1.0\"\nedition = \"2021\"\n";
const rustBody = (fnName: string, expr: string): string =>
  `pub fn ${fnName}(job: &str) -> Option<String> {\n    for _attempt in 0..3 {\n        let limit = ${expr};\n        if limit > 0 {\n            return Some(job.to_string());\n        }\n    }\n    None\n}\n`;

describe("rustUseBindings: bound name -> the full module path", () => {
  it("plain, aliased, grouped, nested, self and multi-line use trees", () => {
    const lines = [
      "use crate::net::limits;",
      "use crate::store::quota as q;",
      "use super::{alpha, beta::gamma as g, delta::{self}};",
      "pub(crate) use self::inner::{",
      "    epsilon,",
      "    zeta,",
      "};",
      "use std::collections::*;",
      "use crate::ignored as _;",
      "mod local_cfg;",
    ];
    const bindings = rustUseBindings(lines, false);
    expect(bindings.get("limits")).toEqual(["crate", "net", "limits"]);
    expect(bindings.get("q")).toEqual(["crate", "store", "quota"]);
    expect(bindings.get("alpha")).toEqual(["super", "alpha"]);
    expect(bindings.get("g")).toEqual(["super", "beta", "gamma"]);
    expect(bindings.get("delta")).toEqual(["super", "delta"]);
    expect(bindings.get("epsilon")).toEqual(["self", "inner", "epsilon"]);
    expect(bindings.get("zeta")).toEqual(["self", "inner", "zeta"]);
    expect(bindings.get("local_cfg")).toEqual(["self", "local_cfg"]);
    expect(bindings.has("_")).toBe(false);
    expect(bindings.has("ignored")).toBe(false);
    expect([...bindings.keys()].some((k) => k === "collections" || k === "*")).toBe(false);
  });

  it("a PHP `use App\\Config;` and a JS \"use strict\" bind nothing", () => {
    expect(rustUseBindings(["use App\\Models\\Config;", "\"use strict\";", "use = 3"], false).size).toBe(0);
  });
});

describe("constantLikeReferencesIn keeps `::` members, drops primitive/std paths", () => {
  it("self::, Class::, namespace:: and crate:: members are candidates", () => {
    const body = [
      "  return self::TIMEOUT_MS + Client::RETRIES + cfg::BATCH_SIZE + crate::config::MAX_JOBS;",
    ];
    const names = constantLikeReferencesIn(body, false, "request");
    for (const name of ["TIMEOUT_MS", "RETRIES", "BATCH_SIZE", "MAX_JOBS"]) expect(names).toContain(name);
  });

  it("u32::MAX, i64::MIN and std::f64::consts::PI are language constants", () => {
    const body = ["    let a = u32::MAX; let b = i64::MIN; let c = std::f64::consts::PI; let d = core::u8::MAX;"];
    const names = constantLikeReferencesIn(body, false, "request");
    for (const name of ["MAX", "MIN", "PI"]) expect(names).not.toContain(name);
  });
});

describe("a `::`-qualified constant is served or disclosed, never silently dropped", () => {
  it("C++ namespace constant in the same file is served", async () => {
    const ws = makeWorkspace("cppNs");
    writeFile(
      ws,
      "src/queue.cpp",
      "#include <string>\n\nnamespace limits {\nconstexpr int MAX_DEPTH = 4200;\n}\n\nint drain(const std::string& name) {\n  for (int pass = 0; pass < 3; ++pass) {\n    if (!name.empty()) return limits::MAX_DEPTH;\n  }\n  return 0;\n}\n",
    );
    const chain = await ask(ws, "What default max depth does drain use?");
    assertHonestValueCompletion(chain, "MAX_DEPTH = 4200");
  }, 60_000);

  it("PHP self:: class constant is never certified without being served or disclosed", async () => {
    const ws = makeWorkspace("phpSelf");
    writeFile(
      ws,
      "src/Queue.php",
      "<?php\n\nclass Queue\n{\n    const MAX_DEPTH = 4200;\n\n    public function drain(string $name): int\n    {\n        for ($pass = 0; $pass < 3; $pass++) {\n            if ($name !== '') {\n                return self::MAX_DEPTH;\n            }\n        }\n        return 0;\n    }\n}\n",
    );
    const chain = await ask(ws, "What default max depth does Queue.drain use?");
    assertHonestValueCompletion(chain, "MAX_DEPTH = 4200");
  }, 60_000);

  it("Rust crate:: path constant is never certified without being served or disclosed", async () => {
    const ws = makeWorkspace("rsCratePath");
    writeFile(ws, "Cargo.toml", CARGO);
    writeFile(ws, "src/main.rs", "mod queue;\nmod limits;\n\nfn main() {}\n");
    writeFile(ws, "src/limits.rs", "pub const MAX_DEPTH: u32 = 4200;\n");
    writeFile(ws, "src/queue.rs", rustBody("drain", "crate::limits::MAX_DEPTH"));
    const chain = await ask(ws, "What default max depth does drain use?");
    assertHonestValueCompletion(chain, "MAX_DEPTH: u32 = 4200");
  }, 60_000);
});

describe("Rust modules resolve from the use path, never from a same-named file elsewhere", () => {
  it("use crate::net::limits; with crate::limits also present serves src/net/limits.rs", async () => {
    const ws = makeWorkspace("rsTwo");
    writeFile(ws, "Cargo.toml", CARGO);
    writeFile(ws, "src/main.rs", "mod queue;\nmod limits;\nmod net;\n\nfn main() {}\n");
    writeFile(ws, "src/limits.rs", "pub const MAX_DEPTH: u32 = 1111;\n");
    writeFile(ws, "src/net/mod.rs", "pub mod limits;\n");
    writeFile(ws, "src/net/limits.rs", "pub const MAX_DEPTH: u32 = 4200;\n");
    writeFile(ws, "src/queue.rs", "use crate::net::limits;\n\n" + rustBody("drain", "limits::MAX_DEPTH"));
    const chain = await ask(ws, "What default max depth does drain use?");
    assertHonestValueCompletion(chain, "MAX_DEPTH: u32 = 4200");
    expect(servedBodies(chain)).not.toContain("MAX_DEPTH: u32 = 1111");
  }, 60_000);

  it("a grouped multi-line use resolves the module", async () => {
    const ws = makeWorkspace("rsGrouped");
    writeFile(ws, "Cargo.toml", CARGO);
    writeFile(ws, "src/main.rs", "mod queue;\nmod limits;\nmod util;\n\nfn main() {}\n");
    writeFile(ws, "src/limits.rs", "pub const MAX_DEPTH: u32 = 4200;\n");
    writeFile(ws, "src/util.rs", "pub fn noop() {}\n");
    writeFile(ws, "src/queue.rs", "use crate::{\n    limits,\n    util,\n};\n\n" + rustBody("drain", "limits::MAX_DEPTH"));
    const chain = await ask(ws, "What default max depth does drain use?");
    expect(servedBodies(chain)).toContain("MAX_DEPTH: u32 = 4200");
    assertHonestValueCompletion(chain, "MAX_DEPTH: u32 = 4200");
  }, 60_000);

  it("a crate module with no file (inline) is disclosed by its qualified name, lower-case member included", async () => {
    const ws = makeWorkspace("rsInline");
    writeFile(ws, "Cargo.toml", CARGO);
    writeFile(ws, "src/main.rs", "mod queue;\npub mod net {\n    pub mod limits {\n        pub const default_depth: u32 = 4200;\n    }\n}\n\nfn main() {}\n");
    writeFile(ws, "src/queue.rs", "use crate::net::limits;\n\n" + rustBody("drain", "limits::default_depth"));
    const chain = await ask(ws, "What default depth does drain use?");
    const last = chain.hops[chain.hops.length - 1]!;
    const served = servedBodies(chain).includes("default_depth: u32 = 4200");
    expect(served || gapRefs(last.response).some((g) => g.includes("limits.default_depth"))).toBe(true);
  }, 60_000);

  it("u32::MAX next to a resolved module constant adds no disclosure", async () => {
    const ws = makeWorkspace("rsPrimitive");
    writeFile(ws, "Cargo.toml", CARGO);
    writeFile(ws, "src/main.rs", "mod queue;\nmod limits;\n\nfn main() {}\n");
    writeFile(ws, "src/limits.rs", "pub const MAX_DEPTH: u32 = 4200;\n");
    writeFile(ws, "src/queue.rs", "use crate::limits;\n\n" + rustBody("drain", "limits::MAX_DEPTH.min(u32::MAX)"));
    const chain = await ask(ws, "What default max depth does drain use?");
    const last = chain.hops[chain.hops.length - 1]!;
    expect(servedBodies(chain)).toContain("MAX_DEPTH: u32 = 4200");
    expect(gapRefs(last.response).some((g) => /\bMAX\b/.test(g.replace(/MAX_DEPTH/g, "")))).toBe(false);
  }, 60_000);
});

describe("package wording never claims a location it did not prove", () => {
  it("a monorepo workspace package is named, never \"declared outside the workspace\"", async () => {
    const ws = makeWorkspace("monorepo");
    writeFile(ws, "package.json", '{ "name": "r7oq-mono", "private": true, "workspaces": ["packages/*"] }\n');
    writeFile(ws, "packages/limits/package.json", '{ "name": "@r7oq/limits", "version": "1.0.0", "type": "module", "main": "src/index.ts" }\n');
    writeFile(ws, "packages/limits/src/index.ts", "export const MAX_DEPTH = 4200;\n");
    writeFile(ws, "packages/queue/package.json", '{ "name": "@r7oq/queue", "version": "1.0.0", "type": "module", "dependencies": { "@r7oq/limits": "workspace:*" } }\n');
    writeFile(
      ws,
      "packages/queue/src/drain.ts",
      "import { MAX_DEPTH } from \"@r7oq/limits\";\n\nexport function drain(name: string): number {\n  for (let pass = 0; pass < 3; pass++) {\n    if (name) return MAX_DEPTH;\n  }\n  return 0;\n}\n",
    );
    const chain = await ask(ws, "What default max depth does drain use?");
    assertHonestValueCompletion(chain, "MAX_DEPTH = 4200");
    for (const hop of chain.hops) {
      expect(gapRefs(hop.response).some((g) => g.includes("declared outside the workspace"))).toBe(false);
    }
    const last = chain.hops[chain.hops.length - 1]!;
    if (!servedBodies(chain).includes("MAX_DEPTH = 4200")) {
      expect(gapRefs(last.response).some((g) => g.includes("imported from package @r7oq/limits"))).toBe(true);
    }
  }, 60_000);
});
