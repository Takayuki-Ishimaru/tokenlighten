/**
 * evaluation0929.goSiblingsAndCjsRename.spec.ts — R2-T3 (eval-0929 final
 * review, findings P0-4 and P1-4).
 *
 * P0-4 (reviewer repro cases-final goSib{2,4,8}direct / goSib2chain): a Go
 * package `poll/{a.go,b.go,limits.go,step.go}` whose `PollStep` returns the
 * sibling-file constant `StepBaseMs` certified `act.answer` with
 * `explicit-gap:request-item-empty:value:PollStep` (direct read) or with
 * `step.go` only and NO gap (a same-file alias `const stepRefMs = StepBaseMs`)
 * — 7310 never served. ROOT CAUSE (readCodeTaskPack.ts
 * `findGoPackageConstantWindow`): the sibling scan stopped after
 * MAX_IMPORT_RESOLVED_FILES_PER_FOCAL (2) files IN DIRECTORY ORDER, and a
 * PascalCase/camelCase name never reaches a disclosure
 * (`isUnresolvableConstantName` needs CONST_CASE), so the miss was silent.
 * RULING: a same-package constant is found by a declaration-shaped scan of
 * EVERY non-test `.go` file of the package directory, bounded only by BYTES
 * read; when that bound is really hit before the declaration is found the
 * requirement is disclosed undetermined (never empty, never covered). The
 * same "a cap never becomes a silent empty/covered" rule holds for the
 * import-resolved file cap other languages share (barrel / star-import / local
 * include chases) and for the two other silent Go bounds found on the way (a
 * grouped `const (` block searched only 40 lines deep, and a 40-file prefix of
 * the WHOLE subtree standing in for the package directory).
 *
 * P1-4 (reviewer repro cases-values3 cjsRenameDirect + cjsRename*, cases-values4
 * cjsRenameMixed): `const { RAW_TTL: TTL } = require("./consts")` → false
 * `request-item-empty`; through an object → covered WITHOUT the literal; mixed
 * `{ RAW_TTL: TTL, OTHER }` → only OTHER chased. The CJS rename BINDING itself
 * (WP-A's `ImportSpecifier.exportedName`) was already delivered; the
 * reproduced failure is that the LOCAL alias `TTL` is a member of
 * `concernRecovery.ts`'s PROSE_ACRONYMS (a list about English words in a
 * QUESTION), which `looksLikeConstantReference` applied to SOURCE identifiers:
 * a module constant named `TTL` (`export const TTL = 9314`, no CJS, no rename)
 * was never even looked up. Fixed there, plus the shapes that really were
 * unbound: `const B = require("./x").A` (served the require line as the
 * value), a rename/plain default (`{ A: B = 1 }`, `{ A = 1 }`), and a
 * prettier-wrapped multi-line destructure/import list (ESM, CJS, Python
 * `from m import (…)`), which bound NOTHING and — for a non-CONST_CASE name —
 * was never disclosed either.
 *
 * Every fixture uses names/values never used by the evaluator's own fixtures
 * or the orchestrator's metamorphic matrix. Servers are shared only where every
 * case starts its own epoch (one function per case, unique names).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { followNextToEnd, startDevServer, type ChainResult, type ServerHandle } from "./helpers/qualityFirstScenarios.js";
import {
  constantLikeReferencesIn,
  findModuleConstantWindow,
  importSpecifiersNaming,
  isRequireMemberInitializer,
} from "../features/task-pack/evidenceClosure.js";
import { FileReadCache, findGoPackageConstantWindow, MAX_GO_PACKAGE_SCAN_BYTES } from "../features/task-pack/readCodeTaskPack.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const tmpDirs: string[] = [];
const servers: ServerHandle[] = [];

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
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-e0929gs-${tag}-`));
  tmpDirs.push(ws);
  return ws;
}

function writeFile(ws: string, rel: string, content: string): void {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function writeFiles(ws: string, files: Readonly<Record<string, string>>): void {
  for (const [rel, content] of Object.entries(files)) writeFile(ws, rel, content);
}

interface Shared {
  readonly ws: string;
  readonly ask: (query: string, opts?: { budgetBytes?: number }) => Promise<Outcome>;
}

interface Outcome {
  readonly chain: ChainResult;
  /** Every evidence body served anywhere in the chain. */
  readonly bodies: string;
  /** Every `why` of every evidence row served in the chain. */
  readonly whys: string[];
  /** Every gap ref/string the chain's decisions carried. */
  readonly gaps: string[];
  readonly decisionKind: string | undefined;
  readonly firstHopBytes: number;
}

function decisionOf(response: unknown): any {
  return (response as any)?.decision ?? {};
}

function gapsOfResponse(response: unknown): string[] {
  const d = decisionOf(response);
  const gaps = d.certificate?.gaps ?? d.gaps ?? [];
  const out: string[] = [];
  for (const g of gaps) {
    if (typeof g === "string") out.push(g);
    else if (Array.isArray(g?.refs)) out.push(...g.refs);
    else if (g && typeof g === "object") out.push(JSON.stringify(g));
  }
  return out;
}

function summarize(chain: ChainResult): Outcome {
  const bodies: string[] = [];
  const whys: string[] = [];
  const gaps: string[] = [];
  for (const hop of chain.hops) {
    for (const e of ((hop.response as any)?.evidence ?? []) as any[]) {
      if (typeof e?.body === "string") bodies.push(e.body);
      if (typeof e?.why === "string") whys.push(e.why);
    }
    gaps.push(...gapsOfResponse(hop.response));
  }
  return {
    chain,
    bodies: bodies.join("\n"),
    whys,
    gaps,
    decisionKind: decisionOf(chain.final).kind,
    firstHopBytes: chain.hops[0]?.textBytes ?? 0,
  };
}

/** One shared server over one workspace: every `ask` starts its own epoch (one function per case). */
async function startShared(ws: string): Promise<Shared> {
  const server = startDevServer(ws, "default");
  servers.push(server);
  await server.initialize();
  return {
    ws,
    async ask(query, opts = {}) {
      const args: Record<string, unknown> = { query, task: { epoch: "new", profile: "answer" }, cwd: ws };
      if (opts.budgetBytes !== undefined) args["budget"] = { bytes: opts.budgetBytes };
      return summarize(await followNextToEnd(server, { tool: "tl_read_file", arguments: args }, { cwd: ws, hopCap: 20 }));
    },
  };
}

/** The value reached the client through the facet closure (a `closure:` row), and no `request-item-empty` was claimed on the way. */
function expectServedByClosure(o: Outcome, marker: string): void {
  expect(o.bodies, `expected "${marker}" in the served evidence (whys=${JSON.stringify(o.whys)}, gaps=${JSON.stringify(o.gaps)})`).toContain(marker);
  expect(o.whys.some((w) => w.startsWith("closure:")), `expected a closure: row (whys=${JSON.stringify(o.whys)})`).toBe(true);
  expect(o.gaps.filter((g) => g.includes("request-item-empty")), "a served value must never ride a verified-empty gap").toEqual([]);
}

/** Never `request-item-empty`, the literal never served, and an undetermined gap naming `name`. */
function expectDisclosedUndetermined(o: Outcome, marker: string, name: string): void {
  expect(o.bodies, `"${marker}" must not be served here`).not.toContain(marker);
  expect(o.gaps.filter((g) => g.includes("request-item-empty")), `a cap/unresolvable read must never be verified-empty (gaps=${JSON.stringify(o.gaps)})`).toEqual([]);
  expect(
    o.gaps.some((g) => g.includes("request-item-undetermined") && g.includes(name)),
    `expected an undetermined gap naming ${name} (gaps=${JSON.stringify(o.gaps)})`,
  ).toBe(true);
}

// ===========================================================================
// UNIT — the pure helpers
// ===========================================================================
describe("unit: importSpecifiersNaming — CJS destructure/member/wrapped shapes bind like ESM `import { A as B }`", () => {
  const req = (lines: string[], name: string) => importSpecifiersNaming(lines, name, false, "lib/svc.js");

  it("a rename binds the LOCAL name to the module's own key", () => {
    expect(req(["const { RAW_TTL: TTL } = require('./consts');"], "TTL")).toEqual([
      { specifier: "./consts", relative: true, wildcard: false, packageEligible: true, exportedName: "RAW_TTL" },
    ]);
    expect(req(["const { RAW_TTL: TTL } = require('./consts');"], "RAW_TTL")).toEqual([]);
  });

  it("a plain member names the same export (no exportedName)", () => {
    expect(req(["const { RAW_TTL } = require('./consts');"], "RAW_TTL")).toEqual([
      { specifier: "./consts", relative: true, wildcard: false, packageEligible: true },
    ]);
  });

  it("a mixed list binds every member, renamed or not", () => {
    const line = ["const { RAW_TTL: TTL, OTHER, third: T3 } = require('./consts');"];
    expect(req(line, "TTL")[0]?.exportedName).toBe("RAW_TTL");
    expect(req(line, "OTHER")[0]?.exportedName).toBeUndefined();
    expect(req(line, "OTHER")).toHaveLength(1);
    expect(req(line, "T3")[0]?.exportedName).toBe("third");
  });

  it("defaults never change which export is read: `{ A: B = 1 }`, `{ A = 1 }`, `{ A: B = f(1, 2) }`", () => {
    expect(req(["const { RAW_TTL: TTL_MS = 5 } = require('./consts');"], "TTL_MS")[0]?.exportedName).toBe("RAW_TTL");
    expect(req(["const { RAW_TTL = 5 } = require('./consts');"], "RAW_TTL")).toHaveLength(1);
    expect(req(["const { RAW_TTL: TTL_MS = pick(1, 2), OTHER = 0 } = require('./consts');"], "TTL_MS")[0]?.exportedName).toBe("RAW_TTL");
    expect(req(["const { RAW_TTL: TTL_MS = pick(1, 2), OTHER = 0 } = require('./consts');"], "OTHER")).toHaveLength(1);
  });

  it("a nested pattern binds each inner local to the OUTER key that carries it", () => {
    const line = ["const { limits: { ttl: ttlMs, retries }, name } = require('./consts');"];
    expect(req(line, "ttlMs")[0]?.exportedName).toBe("limits");
    expect(req(line, "retries")[0]?.exportedName).toBe("limits");
    expect(req(line, "name")[0]?.exportedName).toBeUndefined();
  });

  it("the member form `const B = require(...).A` binds B to the export A (also through a longer chain)", () => {
    expect(req(["const TTL_MS = require('./consts').RAW_TTL;"], "TTL_MS")).toEqual([
      { specifier: "./consts", relative: true, wildcard: false, packageEligible: true, exportedName: "RAW_TTL" },
    ]);
    expect(req(["const ttl = require('./consts').limits.ttl;"], "ttl")[0]?.exportedName).toBe("limits");
    // the bare MODULE alias names no export
    expect(req(["const consts = require('./consts');"], "consts")).toEqual([]);
    // a fallback expression is not a pure member binding
    expect(req(["const ttl = require('./consts').RAW_TTL || 5;"], "ttl")).toEqual([]);
  });

  it("a prettier-wrapped destructure reads exactly like the one-line spelling (comments dropped)", () => {
    const wrapped = ["const {", "  RAW_TTL: TTL_MS, // base", "  OTHER,", "} = require('./consts');", "function f() {}"];
    expect(req(wrapped, "TTL_MS")).toEqual(req(["const { RAW_TTL: TTL_MS, OTHER } = require('./consts');"], "TTL_MS"));
    expect(req(wrapped, "OTHER")).toHaveLength(1);
    expect(req(wrapped, "f")).toEqual([]);
  });

  it("a wrapped ES import list (with and without a default binding) binds its names", () => {
    const es = (lines: string[], name: string) => importSpecifiersNaming(lines, name, false, "src/svc.ts");
    const wrapped = ["import {", "  RAW_TTL as TTL_MS,", "  otherMs,", "} from './consts.js';"];
    expect(es(wrapped, "TTL_MS")[0]?.exportedName).toBe("RAW_TTL");
    expect(es(wrapped, "otherMs")).toHaveLength(1);
    expect(es(["import cfg, { gapMs } from './consts.js';"], "gapMs")).toHaveLength(1);
    expect(es(["import cfg, { gapMs } from './consts.js';"], "cfg")).toHaveLength(1);
    // an object LITERAL that merely starts with `export` is not an import list
    expect(es(["export default {", "  gapMs: 1,", "};"], "gapMs")).toEqual([]);
  });

  it("a Python parenthesised import (one line or wrapped, with `as`) binds its names", () => {
    const py = (lines: string[], name: string) => importSpecifiersNaming(lines, name, true, "app/svc.py");
    expect(py(["from .limits import (", "    raw_gap_ms as gap_ms,", "    other_ms,", ")"], "gap_ms")[0]?.exportedName).toBe("raw_gap_ms");
    expect(py(["from .limits import (", "    raw_gap_ms as gap_ms,", "    other_ms,", ")"], "other_ms")).toHaveLength(1);
    expect(py(["from .limits import (gap_ms, other_ms)  # both"], "other_ms")).toHaveLength(1);
  });

  it("a wrapped list that never closes within its bound is left alone (never swallows the file)", () => {
    const lines = ["const {", ...Array.from({ length: 200 }, (_, i) => `  m${i},`)];
    expect(req(lines, "m3")).toEqual([]);
  });
});

describe("unit: constantLikeReferencesIn — a prose-acronym NAME is a binding a source body reads", () => {
  it("`return TTL;`, `API + '/v1'` and `URL.canParse(x)` keep the acronym as a lookup candidate", () => {
    expect(constantLikeReferencesIn(["  return TTL * 2;"], false, "ttlFor")).toContain("TTL");
    expect(constantLikeReferencesIn(["  return API + '/v1';"], false, "endpoint")).toContain("API");
    expect(constantLikeReferencesIn(["  if (URL.canParse(u)) return 1;"], false, "f")).toContain("URL");
  });

  it("the operand of `new` is a TYPE, never a constant (the original acronym rule survives there)", () => {
    expect(constantLikeReferencesIn(["  const req = new HTTP.Request(url);"], false, "f")).not.toContain("HTTP");
    expect(constantLikeReferencesIn(["  return new URL(s).host;"], false, "hostOf")).not.toContain("URL");
    // ...but one bare read anywhere brings it back
    expect(constantLikeReferencesIn(["  const u = new URL(s);", "  return TTL + URL;"], false, "f")).toContain("URL");
  });
});

describe("unit: findModuleConstantWindow — a Go grouped block is searched to its real end", () => {
  const block = (members: number, target: string): string[] => [
    "package poll",
    "",
    "const (",
    ...Array.from({ length: members }, (_, i) => `\tFill${i} = ${i}`),
    `\t${target} = 6293`,
    ")",
    "",
    "func Use() int { return 1 }",
  ];

  it.each([10, 39, 45, 400, 2500])("a member %i lines into a `const (` block is found", (members) => {
    const lines = block(members, "GapBaseMs");
    const window = findModuleConstantWindow(lines, "GapBaseMs", false);
    expect(window?.start).toBe(3 + members + 1);
    expect(lines[(window?.start ?? 1) - 1]).toContain("GapBaseMs = 6293");
  });

  it("a member's own multi-line call does not end the block early", () => {
    const lines = [
      "package poll",
      "",
      "var (",
      "\tpollEvery = time.Duration(",
      "\t\tenvInt(\"POLL_MS\", 250),",
      "\t) * time.Millisecond",
      "\tmaxTries = 5",
      ")",
    ];
    expect(findModuleConstantWindow(lines, "maxTries", false)?.start).toBe(7);
  });

  it("a member after the block's closing paren is not a member; a block that never closes stops at the next top-level declaration", () => {
    expect(findModuleConstantWindow(["const (", "\tA = 1", ")", "\tGapBaseMs = 3"], "GapBaseMs", false)).toBeUndefined();
    const open = ["const (", "\tA = 1", "\tB = 2", "func f() {", "\tGapBaseMs = 3", "}"];
    expect(findModuleConstantWindow(open, "B", false)?.start).toBe(3);
    expect(findModuleConstantWindow(open, "GapBaseMs", false)).toBeUndefined();
  });

  it("a C# top-level tuple deconstruction is not a grouped block (an indented `gapMs = 5;` below it is a local)", () => {
    expect(findModuleConstantWindow(["var (a, b) = Pair();", "void M() {", "\tgapMs = 5;", "}"], "gapMs", false)).toBeUndefined();
  });
});

describe("unit: isRequireMemberInitializer", () => {
  it("is true only for a bare `require(...)` member chain", () => {
    expect(isRequireMemberInitializer(["const TTL_MS = require('./consts').RAW_TTL;"], false)).toBe(true);
    expect(isRequireMemberInitializer(["const ttl = require('./consts').limits.ttl;"], false)).toBe(true);
    expect(isRequireMemberInitializer(["const ttl = require('./consts')", "  .RAW_TTL;"], false)).toBe(true);
    expect(isRequireMemberInitializer(["const consts = require('./consts');"], false)).toBe(false);
    expect(isRequireMemberInitializer(["const ttl = require('./consts').RAW_TTL || 5;"], false)).toBe(false);
    expect(isRequireMemberInitializer(["const ttl = require('./consts').build();"], false)).toBe(false);
    expect(isRequireMemberInitializer(["const ttl = 5;"], false)).toBe(false);
  });
});

describe("unit: findGoPackageConstantWindow — every package file, bounded by bytes only", () => {
  let ws = "";
  const write = (rel: string, body: string): void => writeFile(ws, rel, body);
  const find = (owner: string, name: string, opts: Parameters<typeof findGoPackageConstantWindow>[4] = {}) =>
    findGoPackageConstantWindow(owner, name, ws, new FileReadCache(), opts);

  beforeAll(() => {
    ws = makeWorkspace("unit-go");
    // 30 siblings sorting BEFORE the declaring file, plus files after it.
    for (let i = 0; i < 30; i++) write(`pkg/a${String(i).padStart(2, "0")}.go`, `package pace\n\nfunc Noop${i}() int { return ${i} }\n`);
    write("pkg/gap.go", "package pace\n\nfunc NextGap() int {\n\treturn RetryGapMs\n}\n");
    write("pkg/limits.go", "package pace\n\n// RetryGapMs is the base gap.\nconst RetryGapMs = 4487\n");
    write("pkg/zz.go", "package pace\n\nfunc Last() int { return 0 }\n");
    // a test file declaring a decoy, sorting first; an ignore-tagged generator in another package
    write("pkg/a00_test.go", "package pace\n\nconst TestOnlyMs = 1\nconst RetryGapMs = 1111\n");
    write("pkg/a01_gen.go", "//go:build ignore\n\npackage main\n\nconst GenOnlyMs = 2\nconst RetryGapMs = 2222\n");
    // a nested directory sorting before every sibling must not crowd them out
    for (let i = 0; i < 45; i++) write(`pkg/a/n${String(i).padStart(2, "0")}.go`, `package a\n\nfunc N${i}() int { return ${i} }\n`);
  });

  it("finds the declaration in the 32nd file, ignoring the test decoy and the other-package decoy", async () => {
    const found = await find("pkg/gap.go", "RetryGapMs");
    expect(found).toEqual({ path: "pkg/limits.go", start: 4, end: 4, truncated: false });
  });

  it("an owner that IS a test file may read a test-file constant", async () => {
    write("pkg/gap_test.go", "package pace\n\nfunc TestGap() int { return TestOnlyMs }\n");
    expect((await find("pkg/gap_test.go", "TestOnlyMs"))?.path).toBe("pkg/a00_test.go");
    expect(await find("pkg/gap.go", "TestOnlyMs")).toBeUndefined();
  });

  it("a package-mate declaring another package is invisible (`//go:build ignore` generator)", async () => {
    expect(await find("pkg/gap.go", "GenOnlyMs")).toBeUndefined();
  });

  it("a miss over the WHOLE package is absence: no bound is reported", async () => {
    let bounded = 0;
    expect(await find("pkg/gap.go", "NoSuchNameMs", { onBounded: () => { bounded += 1; } })).toBeUndefined();
    expect(bounded).toBe(0);
  });

  it("a byte budget hit before the declaration reports the miss as BOUNDED (never as absence); a hit never does", async () => {
    let bounded = 0;
    const onBounded = (): void => { bounded += 1; };
    expect(await find("pkg/gap.go", "RetryGapMs", { byteBudget: 200, onBounded })).toBeUndefined();
    expect(bounded).toBe(1);
    expect(await find("pkg/gap.go", "RetryGapMs", { onBounded })).toBeDefined();
    expect(bounded).toBe(1);
  });

  it("an unreadable package-mate also makes a miss bounded", async () => {
    write("unreadable/a.go", "package pace\n\nfunc A() {}\n");
    fs.writeFileSync(path.join(ws, "unreadable/b.go"), Buffer.alloc(6000));
    write("unreadable/c.go", "package pace\n\nfunc NextGap() int { return SomeMs }\n");
    let bounded = 0;
    expect(await find("unreadable/c.go", "SomeMs", { onBounded: () => { bounded += 1; } })).toBeUndefined();
    expect(bounded).toBe(1);
  });

  it("a non-Go owner is never scanned", async () => {
    write("pkg/other.ts", "export const RetryGapMs = 1;\n");
    expect(await find("pkg/other.ts", "RetryGapMs")).toBeUndefined();
  });

  it("the default byte budget is far above an ordinary package", () => {
    expect(MAX_GO_PACKAGE_SCAN_BYTES).toBeGreaterThanOrEqual(4 * 1024 * 1024);
  });
});

// ===========================================================================
// E2E Go — same-package constants past the second sibling
// ===========================================================================
describe("E2E Go: a same-package constant is found however many other files the package has", () => {
  const GO_MOD = "module example.com/svc\n\ngo 1.22\n";
  let shared: Shared;

  interface GoPackage {
    readonly dir: string;
    readonly fn: string;
    readonly value: number;
  }
  const packages: GoPackage[] = [];
  let nextValue = 4400;

  /** `dir/{gap.go,limits.go}` + `siblings` other files named `<prefix>NN.go`; `chain` reads the constant through a same-file alias. */
  function goPackage(ws: string, id: string, opts: { siblings: number; prefix?: string; chain?: boolean }): GoPackage {
    // letters only in every identifier: a 2+-digit suffix (`NextGap02`) is a different, already-fixed
    // defect (digit-suffixed names read as literals) that would mask the one under test
    const dir = `pace_${id}`;
    const fn = `NextGap${id.charAt(0).toUpperCase()}${id.slice(1)}`;
    const value = (nextValue += 1);
    const prefix = opts.prefix ?? "a";
    writeFile(ws, `${dir}/limits.go`, `package pace\n\n// RetryGapMs is the base retry gap.\nconst RetryGapMs = ${value}\n`);
    writeFile(
      ws,
      `${dir}/gap.go`,
      opts.chain === true
        ? `package pace\n\nconst gapRefMs = RetryGapMs\n\nfunc ${fn}() int {\n\treturn gapRefMs\n}\n`
        : `package pace\n\nfunc ${fn}() int {\n\treturn RetryGapMs\n}\n`,
    );
    for (let i = 0; i < opts.siblings; i++) {
      writeFile(ws, `${dir}/${prefix}${String(i).padStart(2, "0")}.go`, `package pace\n\nfunc Noop${id}${prefix}${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}() int { return ${i} }\n`);
    }
    const made = { dir, fn, value };
    packages.push(made);
    return made;
  }

  const layout: Record<string, GoPackage> = {};

  beforeAll(async () => {
    const ws = makeWorkspace("go");
    writeFile(ws, "go.mod", GO_MOD);
    // controls (already worked): 0 and 1 sibling, and siblings sorting AFTER limits.go
    layout["d0"] = goPackage(ws, "zero", { siblings: 0 });
    layout["d1"] = goPackage(ws, "one", { siblings: 1 });
    layout["after4"] = goPackage(ws, "afterFour", { siblings: 4, prefix: "z" });
    // the defect: siblings sorting BEFORE limits.go, direct read
    layout["d2"] = goPackage(ws, "two", { siblings: 2 });
    layout["d4"] = goPackage(ws, "four", { siblings: 4 });
    layout["d8"] = goPackage(ws, "eight", { siblings: 8 });
    layout["d30"] = goPackage(ws, "thirty", { siblings: 30 });
    // the defect: through a same-file alias (the served `covered` with the literal missing)
    layout["c2"] = goPackage(ws, "chainTwo", { siblings: 2, chain: true });
    layout["c4"] = goPackage(ws, "chainFour", { siblings: 4, chain: true });
    layout["c8"] = goPackage(ws, "chainEight", { siblings: 8, chain: true });
    layout["c30"] = goPackage(ws, "chainThirty", { siblings: 30, chain: true });
    // a same-name decoy function in another package directory (path-named query only: two same-named declarations bare is WP-F's ambiguity)
    layout["dd"] = goPackage(ws, "decoyFour", { siblings: 4 });
    writeFile(ws, "decoy_decoyFour/gap.go", `package pace\n\nfunc ${layout["dd"]!.fn}() int { return -1 }\n`);
    // a nested directory sorting before every sibling must not crowd the siblings out
    layout["nested"] = goPackage(ws, "nested", { siblings: 3 });
    for (let i = 0; i < 45; i++) writeFile(ws, `${layout["nested"]!.dir}/a/n${String(i).padStart(2, "0")}.go`, `package a\n\nfunc N${i}() int { return ${i} }\n`);
    // a test-file decoy sorting first + a generator in another package
    layout["decoys"] = goPackage(ws, "decoys", { siblings: 4 });
    writeFile(ws, `${layout["decoys"]!.dir}/a00_test.go`, "package pace\n\nconst RetryGapMs = 1111\n");
    writeFile(ws, `${layout["decoys"]!.dir}/a01_gen.go`, "//go:build ignore\n\npackage main\n\nconst RetryGapMs = 2222\n");
    // an owner that IS a test file reads a constant declared in a sibling `_test.go` (behind 5 other files)
    const testValue = (nextValue += 1);
    for (let i = 0; i < 5; i++) writeFile(ws, `pace_testfocal/a0${i}.go`, `package pace\n\nfunc NoopTestFocal${String.fromCharCode(97 + i)}() int { return ${i} }\n`);
    writeFile(ws, "pace_testfocal/b_helpers_test.go", `package pace\n\nconst TestOnlyGapMs = ${testValue}\n`);
    writeFile(ws, "pace_testfocal/gap_test.go", 'package pace\n\nimport "testing"\n\nfunc TestGapValue(t *testing.T) {\n\tif TestOnlyGapMs < 0 {\n\t\tt.Fatal("neg")\n\t}\n}\n');
    layout["testFocal"] = { dir: "pace_testfocal", fn: "TestGapValue", value: testValue };
    // the callee sits in a late sibling; the constant behind it in another
    const callee = `NextGapCallee`;
    const calleeValue = (nextValue += 1);
    writeFile(ws, "pace_callee/gap.go", `package pace\n\nfunc ${callee}() int {\n\treturn gapBase()\n}\n`);
    for (let i = 0; i < 6; i++) writeFile(ws, `pace_callee/a${i}.go`, `package pace\n\nfunc NoopCallee${i}() int { return ${i} }\n`);
    writeFile(ws, "pace_callee/helpers.go", "package pace\n\nfunc gapBase() int {\n\treturn RetryGapMs * 1\n}\n");
    writeFile(ws, "pace_callee/limits.go", `package pace\n\nconst RetryGapMs = ${calleeValue}\n`);
    layout["callee"] = { dir: "pace_callee", fn: callee, value: calleeValue };
    // a constant far down a grouped `const (` block
    for (const [id, members] of [["blockFortyFive", 45], ["blockFourHundred", 400]] as const) {
      const fn = `NextGap${id.charAt(0).toUpperCase()}${id.slice(1)}`;
      const value = (nextValue += 1);
      const lines = ["package pace", "", "const (", ...Array.from({ length: members }, (_, i) => `\tFill${i} = ${i}`), `\tRetryGapMs = ${value}`, ")"];
      writeFile(ws, `pace_${id}/limits.go`, lines.join("\n") + "\n");
      writeFile(ws, `pace_${id}/gap.go`, `package pace\n\nfunc ${fn}() int {\n\treturn RetryGapMs\n}\n`);
      layout[id] = { dir: `pace_${id}`, fn, value };
    }
    shared = await startShared(ws);
  }, 120_000);

  const Q = (fn: string): string => `What default value does ${fn} return?`;
  const others = (own: GoPackage): number[] => [...packages, layout["callee"]!, layout["testFocal"]!, layout["blockFortyFive"]!, layout["blockFourHundred"]!].map((p) => p.value).filter((v) => v !== own.value);

  /** The FIRST pack already certified `act.answer` with the value in its own evidence (no follow-up hop needed). */
  const expectFirstPackAnswers = (o: Outcome, marker: string): void => {
    const first = o.chain.hops[0]!.response;
    expect(decisionOf(first).kind).toBe("act.answer");
    const firstBodies = (((first as any).evidence ?? []) as any[]).map((e) => (typeof e?.body === "string" ? e.body : "")).join("\n");
    expect(firstBodies, "the value must be in the first pack's own evidence").toContain(marker);
  };

  it.each(["d0", "d1", "after4"])("control %s: served (worked before the fix, must stay identical in kind and hops)", async (key) => {
    const p = layout[key]!;
    const o = await shared.ask(Q(p.fn));
    expectServedByClosure(o, String(p.value));
    expectFirstPackAnswers(o, String(p.value));
  }, 120_000);

  it.each(["d2", "d4", "d8", "d30"])("direct read, package %s: the constant is served, never verified-empty", async (key) => {
    const p = layout[key]!;
    const o = await shared.ask(Q(p.fn));
    expectServedByClosure(o, String(p.value));
    expectFirstPackAnswers(o, String(p.value));
    for (const other of others(p)) expect(o.bodies).not.toContain(String(other));
  }, 120_000);

  it.each(["c2", "c4", "c8", "c30"])("read through a same-file alias, package %s: the literal behind the alias is served", async (key) => {
    const p = layout[key]!;
    const o = await shared.ask(Q(p.fn));
    expectServedByClosure(o, String(p.value));
    expectFirstPackAnswers(o, String(p.value));
    expect(o.bodies).toContain("gapRefMs");
  }, 120_000);

  it("recall control: 1 sibling vs 8 siblings answer identically (decision kind, hop count, bytes within 5%)", async () => {
    const one = await shared.ask(Q(layout["d1"]!.fn));
    const eight = await shared.ask(Q(layout["d8"]!.fn));
    expect(eight.decisionKind).toBe(one.decisionKind);
    expect(eight.chain.hops).toHaveLength(one.chain.hops.length);
    expect(Math.abs(eight.firstHopBytes - one.firstHopBytes) / one.firstHopBytes).toBeLessThan(0.05);
  }, 120_000);

  describe("metamorphic variants of the 4-sibling direct read", () => {
    it("path-named question", async () => {
      const p = layout["d4"]!;
      expectServedByClosure(await shared.ask(`In ${p.dir}/gap.go, what default value does ${p.fn} return?`), String(p.value));
    }, 120_000);

    it("path-named question with a same-name decoy function in another directory", async () => {
      const p = layout["dd"]!;
      expectServedByClosure(await shared.ask(`In ${p.dir}/gap.go, what default value does ${p.fn} return?`), String(p.value));
    }, 120_000);

    it("Japanese phrasing", async () => {
      const p = layout["c4"]!;
      const o = await shared.ask(`${p.dir}/gap.go の ${p.fn} が返す既定値を説明してください。`);
      expect(o.bodies).toContain(String(p.value));
      expect(o.gaps.filter((g) => g.includes("request-item-empty"))).toEqual([]);
    }, 120_000);

    it("bullet-list phrasing", async () => {
      const p = layout["d4"]!;
      const o = await shared.ask(`Explain the pacer in ${p.dir}/gap.go:\n- Default value returned by ${p.fn}\n- Any retry behaviour`);
      expect(o.bodies).toContain(String(p.value));
      expect(o.gaps.filter((g) => g.includes("request-item-empty") && g.includes(p.fn))).toEqual([]);
    }, 120_000);

    it("a small budget with continuation still reaches the value", async () => {
      const p = layout["d8"]!;
      const o = await shared.ask(Q(p.fn), { budgetBytes: 6144 });
      expect(o.bodies).toContain(String(p.value));
      expect(o.gaps.filter((g) => g.includes("request-item-empty"))).toEqual([]);
    }, 120_000);
  });

  it("a nested directory sorting before every sibling does not crowd the siblings out (45 nested files)", async () => {
    const p = layout["nested"]!;
    expectServedByClosure(await shared.ask(Q(p.fn)), String(p.value));
  }, 120_000);

  it("a `_test.go` sibling and a `package main` generator declaring the same name are not this package's constant", async () => {
    const p = layout["decoys"]!;
    const o = await shared.ask(Q(p.fn));
    expectServedByClosure(o, String(p.value));
    expect(o.bodies).not.toContain("1111");
    expect(o.bodies).not.toContain("2222");
  }, 120_000);

  it("a test-file owner reads a constant declared in a sibling _test.go past the second file", async () => {
    const p = layout["testFocal"]!;
    const o = await shared.ask(`What value does ${p.fn} compare against?`);
    expect(o.bodies).toContain(String(p.value));
    expect(o.whys.some((w) => w.startsWith("closure:"))).toBe(true);
    expect(o.gaps.filter((g) => g.includes("request-item-empty"))).toEqual([]);
  }, 120_000);

  it("a callee declared in a late sibling is followed and the constant behind it is served", async () => {
    const p = layout["callee"]!;
    expectServedByClosure(await shared.ask(Q(p.fn)), String(p.value));
  }, 120_000);

  it.each(["blockFortyFive", "blockFourHundred"])("a constant deep in a grouped const block (%s) is found (the block scan used to stop 40 lines in)", async (key) => {
    const p = layout[key]!;
    expectServedByClosure(await shared.ask(Q(p.fn)), String(p.value));
  }, 120_000);
});

describe("E2E Go: a package too large to read whole is disclosed undetermined, never empty and never covered", () => {
  const filler = (bytes: number): string => "package pace\n\n" + ("// " + "x".repeat(96) + "\n").repeat(Math.ceil(bytes / 100));
  // each filler stays under the walk's own 1 MB per-file ceiling
  const FILLER_BYTES = 950_000;

  it("the byte bound is hit before limits.go: undetermined naming the constant; one file fewer and it is served", async () => {
    const overBudget = Math.ceil(MAX_GO_PACKAGE_SCAN_BYTES / FILLER_BYTES) + 1;
    const underBudget = Math.floor(MAX_GO_PACKAGE_SCAN_BYTES / FILLER_BYTES) - 1;

    const big = makeWorkspace("go-big");
    writeFile(big, "go.mod", "module example.com/svc\n\ngo 1.22\n");
    for (let i = 0; i < overBudget; i++) writeFile(big, `pace/a${String(i).padStart(2, "0")}.go`, filler(FILLER_BYTES));
    writeFile(big, "pace/gap.go", "package pace\n\nfunc NextGap() int {\n\treturn RetryGapMs\n}\n");
    writeFile(big, "pace/limits.go", "package pace\n\nconst RetryGapMs = 4907\n");
    writeFile(big, "pace/gap_chain.go", "package pace\n\nconst gapRefMs = RetryGapMs\n\nfunc NextGapChain() int {\n\treturn gapRefMs\n}\n");
    const bigShared = await startShared(big);
    const bounded = await bigShared.ask("What default value does NextGap return?");
    expectDisclosedUndetermined(bounded, "4907", "RetryGapMs");
    // the same bound behind a same-file alias: the dependency of the served `gapRefMs` window is disclosed too
    expectDisclosedUndetermined(await bigShared.ask("What default value does NextGapChain return?"), "4907", "RetryGapMs");

    const ok = makeWorkspace("go-ok");
    writeFile(ok, "go.mod", "module example.com/svc\n\ngo 1.22\n");
    for (let i = 0; i < underBudget; i++) writeFile(ok, `pace/a${String(i).padStart(2, "0")}.go`, filler(FILLER_BYTES));
    writeFile(ok, "pace/gap.go", "package pace\n\nfunc NextGap() int {\n\treturn RetryGapMs\n}\n");
    writeFile(ok, "pace/limits.go", "package pace\n\nconst RetryGapMs = 4907\n");
    const okShared = await startShared(ok);
    expectServedByClosure(await okShared.ask("What default value does NextGap return?"), "4907");
  }, 240_000);
});

// ===========================================================================
// E2E CJS / ESM / Python / C — bindings and the shared import-file cap
//
// One shared server over one workspace: every case gets its OWN marker value
// (5700 + index) so a value can only reach the client through that case's own
// chain -- another case's constants file, surfaced by a word match, never
// counts.
// ===========================================================================
describe("E2E: renamed/defaulted/member/wrapped imports bind, and an unresolvable one is disclosed", () => {
  interface Case {
    readonly id: string;
    /** the function the question asks about */
    readonly fn: string;
    /** the files of this case, given the case's own marker value */
    readonly build: (m: string) => Record<string, string>;
    /** the served/undisclosed value's role: "served" (default), "undetermined" (must be disclosed naming `name`) or "noise" (no gap may mention `name`) */
    readonly kind?: "served" | "undetermined" | "noise";
    readonly name?: string;
    readonly question?: (fn: string) => string;
  }
  const ttlQ = (fn: string): string => `What ttl value does ${fn} return?`;
  /** `lib/consts.js` of a CJS case: the export the case reads, another export, and an object export */
  const constsJs = (m: string): string => `exports.RAW_TTL = ${m};\nexports.OTHER = 1;\nexports.limits = { ttl: ${m} };\n`;
  const cjs = (id: string, fn: string, svc: string, consts?: (m: string) => string): Case["build"] => (m) => ({
    [`${id}/lib/consts.js`]: (consts ?? constsJs)(m),
    [`${id}/lib/svc.js`]: `${svc}\nmodule.exports = { ${fn} };\n`,
  });

  const cases: Case[] = [
    // -- the reviewer's repros (alias `TTL` is a prose-acronym word) ------------
    { id: "acrDirect", fn: "ttlForAcrDirect", build: cjs("acrDirect", "ttlForAcrDirect", "const { RAW_TTL: TTL } = require('./consts');\nfunction ttlForAcrDirect() { return TTL; }") },
    { id: "acrObject", fn: "ttlForAcrObject", build: cjs("acrObject", "ttlForAcrObject", "const { RAW_TTL: TTL } = require('./consts');\nconst CFG = { ttl: TTL, retries: 2 };\nfunction ttlForAcrObject() { return CFG.ttl; }") },
    { id: "acrMixed", fn: "ttlForAcrMixed", build: cjs("acrMixed", "ttlForAcrMixed", "const { RAW_TTL: TTL, OTHER } = require('./consts');\nfunction ttlForAcrMixed() { return TTL + OTHER; }") },
    // -- other renames / defaults / member forms ---------------------------------
    { id: "renamePlain", fn: "ttlForRenamePlain", build: cjs("renamePlain", "ttlForRenamePlain", "const { RAW_TTL: ttlMs } = require('./consts');\nfunction ttlForRenamePlain() { return ttlMs; }") },
    { id: "renameDefault", fn: "ttlForRenameDefault", build: cjs("renameDefault", "ttlForRenameDefault", "const { RAW_TTL: ttlMs = 5 } = require('./consts');\nfunction ttlForRenameDefault() { return ttlMs; }") },
    { id: "plainDefault", fn: "ttlForPlainDefault", build: cjs("plainDefault", "ttlForPlainDefault", "const { RAW_TTL = 5 } = require('./consts');\nfunction ttlForPlainDefault() { return RAW_TTL; }") },
    { id: "member", fn: "ttlForMember", build: cjs("member", "ttlForMember", "const ttlMs = require('./consts').RAW_TTL;\nfunction ttlForMember() { return ttlMs; }") },
    { id: "memberAcr", fn: "ttlForMemberAcr", build: cjs("memberAcr", "ttlForMemberAcr", "const TTL = require('./consts').RAW_TTL;\nfunction ttlForMemberAcr() { return TTL; }") },
    { id: "memberChain", fn: "ttlForMemberChain", build: cjs("memberChain", "ttlForMemberChain", "const ttlMs = require('./consts').limits.ttl;\nfunction ttlForMemberChain() { return ttlMs; }") },
    { id: "wrapped", fn: "ttlForWrapped", build: cjs("wrapped", "ttlForWrapped", "const {\n  RAW_TTL: ttlMs,\n  OTHER,\n} = require('./consts');\nfunction ttlForWrapped() { return ttlMs + OTHER; }") },
    { id: "nested", fn: "ttlForNested", build: cjs("nested", "ttlForNested", "const { limits: { ttl: ttlMs } } = require('./consts');\nfunction ttlForNested() { return ttlMs; }") },
    // -- a module constant that merely SPELLS like an acronym (no CJS, no rename) --
    { id: "tsAcronym", fn: "ttlForTsAcronym", build: (m) => ({ "tsAcronym/src/consts.ts": `export const TTL = ${m};\n`, "tsAcronym/src/svc.ts": "import { TTL } from './consts.js';\nexport function ttlForTsAcronym(): number { return TTL; }\n" }) },
    { id: "tsAcronymRename", fn: "ttlForTsAcronymRename", build: (m) => ({ "tsAcronymRename/src/base.ts": `export const RAW_TTL = ${m};\n`, "tsAcronymRename/src/index.ts": "export { RAW_TTL as TTL } from './base.js';\n", "tsAcronymRename/src/svc.ts": "import { TTL } from './index.js';\nexport function ttlForTsAcronymRename(): number { return TTL; }\n" }) },
    { id: "pyAcronym", fn: "ttl_for_py_acronym", question: ttlQ, build: (m) => ({ "pyAcronym/app/__init__.py": "", "pyAcronym/app/limits.py": `TTL = ${m}\n`, "pyAcronym/app/svc.py": "from .limits import TTL\n\n\ndef ttl_for_py_acronym():\n    return TTL\n" }) },
    // -- the same acronym-named constant in other language families (the constant lives in ANOTHER file, so the closure must fetch it) --
    { id: "kotlinAcronym", fn: "ttlForKotlinAcronym", question: (fn) => `What value does ${fn} return?`, build: (m) => ({ "kotlinAcronym/src/Limits.kt": `package app\n\nconst val TTL = ${m}\n`, "kotlinAcronym/src/Cache.kt": "package app\n\nfun ttlForKotlinAcronym(): Int {\n    return TTL * 2\n}\n" }) },
    { id: "cAcronym", fn: "ttl_for_c_acronym", question: (fn) => `What value does ${fn} return?`, build: (m) => ({ "cAcronym/src/limits.h": `#define TTL ${m}\n`, "cAcronym/src/cache.c": '#include "limits.h"\n\nint ttl_for_c_acronym(void) {\n  return TTL * 2;\n}\n' }) },
    { id: "goAcronym", fn: "TtlForGoAcronym", question: (fn) => `What value does ${fn} return?`, build: (m) => ({ "goAcronym/cache/limits.go": `package cache\n\nconst TTL = ${m}\n`, "goAcronym/cache/ttl.go": "package cache\n\nfunc TtlForGoAcronym() int {\n\treturn TTL * 2\n}\n" }) },
    // -- wrapped / default+named ESM, Python parenthesised ------------------------
    { id: "esmWrapped", fn: "ttlForEsmWrapped", build: (m) => ({ "esmWrapped/src/consts.ts": `export const rawTtl = ${m};\nexport const otherMs = 1;\n`, "esmWrapped/src/svc.ts": "import {\n  rawTtl as ttlMs,\n  otherMs,\n} from './consts.js';\nexport function ttlForEsmWrapped(): number { return ttlMs + otherMs; }\n" }) },
    { id: "esmDefaultNamed", fn: "ttlForEsmDefaultNamed", build: (m) => ({ "esmDefaultNamed/src/consts.ts": `export const ttlMs = ${m};\nexport default {};\n`, "esmDefaultNamed/src/svc.ts": "import cfg, { ttlMs } from './consts.js';\nexport const keep = cfg;\nexport function ttlForEsmDefaultNamed(): number { return ttlMs; }\n" }) },
    { id: "pyParen", fn: "ttl_for_py_paren", question: ttlQ, build: (m) => ({ "pyParen/app/__init__.py": "", "pyParen/app/limits.py": `raw_ttl_ms = ${m}\nother_ms = 1\n`, "pyParen/app/svc.py": "from .limits import (\n    raw_ttl_ms as ttl_ms,\n    other_ms,\n)\n\n\ndef ttl_for_py_paren():\n    return ttl_ms + other_ms\n" }) },
    { id: "pyParenOneLine", fn: "ttl_for_py_paren_one", question: ttlQ, build: (m) => ({ "pyParenOneLine/app/__init__.py": "", "pyParenOneLine/app/limits.py": `ttl_ms = ${m}\nother_ms = 1\n`, "pyParenOneLine/app/svc.py": "from .limits import (ttl_ms, other_ms)\n\n\ndef ttl_for_py_paren_one():\n    return ttl_ms + other_ms\n" }) },
    // -- unresolvable: disclosed, never empty and never covered -------------------
    { id: "unresolvedRel", fn: "ttlForUnresolvedRel", kind: "undetermined", name: "TTL", build: cjs("unresolvedRel", "ttlForUnresolvedRel", "const { RAW_TTL: TTL } = require('./missing-consts');\nfunction ttlForUnresolvedRel() { return TTL; }") },
    { id: "unresolvedCamel", fn: "ttlForUnresolvedCamel", kind: "undetermined", name: "ttlMs", build: cjs("unresolvedCamel", "ttlForUnresolvedCamel", "const { RAW_TTL: ttlMs } = require('./missing-consts');\nfunction ttlForUnresolvedCamel() { return ttlMs; }") },
    { id: "missingMember", fn: "ttlForMissingMember", kind: "undetermined", name: "ttlMs", build: cjs("missingMember", "ttlForMissingMember", "const { RAW_TTL: ttlMs } = require('./consts');\nfunction ttlForMissingMember() { return ttlMs; }", () => "exports.OTHER = 1;\n") },
    { id: "missingMemberForm", fn: "ttlForMissingMemberForm", kind: "undetermined", name: "ttlMs", build: cjs("missingMemberForm", "ttlForMissingMemberForm", "const ttlMs = require('./consts').RAW_TTL;\nfunction ttlForMissingMemberForm() { return ttlMs; }", () => "exports.OTHER = 1;\n") },
    { id: "unresolvedWrapped", fn: "ttlForUnresolvedWrapped", kind: "undetermined", name: "ttlMs", build: cjs("unresolvedWrapped", "ttlForUnresolvedWrapped", "const {\n  RAW_TTL: ttlMs,\n} = require('./missing-consts');\nfunction ttlForUnresolvedWrapped() { return ttlMs; }") },
    // -- noise control: a platform global named like an acronym, imported from a PACKAGE ------
    { id: "urlGlobal", fn: "hostOfUrlGlobal", kind: "noise", name: "URL", question: (fn) => `What value does ${fn} return?`, build: () => ({ "urlGlobal/lib/svc.js": "const { URL } = require('node:url');\nfunction hostOfUrlGlobal(s) { return new URL(s).host; }\nmodule.exports = { hostOfUrlGlobal };\n" }) },
    { id: "jsonGlobal", fn: "encodeJsonGlobal", kind: "noise", name: "JSON", question: (fn) => `What value does ${fn} return?`, build: () => ({ "jsonGlobal/lib/svc.js": "function encodeJsonGlobal(x) { return JSON.stringify(x); }\nmodule.exports = { encodeJsonGlobal };\n" }) },
    { id: "apiUndeclared", fn: "urlOfApiUndeclared", kind: "noise", name: "API", question: (fn) => `What value does ${fn} return?`, build: () => ({ "apiUndeclared/lib/svc.js": "function urlOfApiUndeclared() { return API + '/v1'; }\nmodule.exports = { urlOfApiUndeclared };\n" }) },
    { id: "urlGlobalEsm", fn: "hostOfUrlGlobalEsm", kind: "noise", name: "URL", question: (fn) => `What value does ${fn} return?`, build: () => ({ "urlGlobalEsm/src/svc.ts": "import { URL } from 'node:url';\nexport function hostOfUrlGlobalEsm(s: string): string { return URL.canParse(s) ? new URL(s).host : ''; }\n" }) },
  ];
  const markerOf = (index: number): string => String(5700 + index);

  let shared: Shared;

  beforeAll(async () => {
    const ws = makeWorkspace("cjs");
    writeFile(ws, "package.json", '{"name":"x","private":true}\n');
    cases.forEach((c, i) => writeFiles(ws, c.build(markerOf(i))));
    shared = await startShared(ws);
  }, 120_000);

  const ids = (kind: "served" | "undetermined" | "noise"): Array<readonly [string]> =>
    cases.filter((c) => (c.kind ?? "served") === kind).map((c) => [c.id] as const);
  const ask = (id: string): Promise<{ o: Outcome; c: Case; marker: string }> => {
    const index = cases.findIndex((x) => x.id === id);
    const c = cases[index]!;
    return shared.ask((c.question ?? ttlQ)(c.fn)).then((o) => ({ o, c, marker: markerOf(index) }));
  };

  it.each(ids("served"))("%s: the value behind the binding is served", async (id) => {
    const { o, marker } = await ask(id);
    expectServedByClosure(o, marker);
  }, 120_000);

  it.each(ids("undetermined"))("%s: unresolvable is disclosed undetermined, never empty and never covered", async (id) => {
    const { o, c, marker } = await ask(id);
    expectDisclosedUndetermined(o, marker, c.name!);
  }, 120_000);

  it.each(ids("noise"))("%s: an acronym-named global (imported from a package, or not declared at all) stays silent (no noise gap)", async (id) => {
    const { o, c } = await ask(id);
    expect(o.gaps.filter((g) => g.includes(c.name!)), `noise gap (gaps=${JSON.stringify(o.gaps)})`).toEqual([]);
  }, 120_000);

  it("metamorphic: the reviewer's renamed binding with a file path, in Japanese and as a bullet list", async () => {
    const index = cases.findIndex((x) => x.id === "acrDirect");
    const c = cases[index]!;
    const marker = markerOf(index);
    for (const query of [
      `In acrDirect/lib/svc.js, what ttl value does ${c.fn} return?`,
      `acrDirect/lib/svc.js の ${c.fn} が返す ttl の値を説明してください。`,
      `Explain acrDirect/lib/svc.js:\n- The ttl value ${c.fn} returns\n- Nothing else`,
    ]) {
      const o = await shared.ask(query);
      expect(o.bodies, query).toContain(marker);
      expect(o.gaps.filter((g) => g.includes("request-item-empty") && g.includes(c.fn)), query).toEqual([]);
    }
  }, 240_000);
});

describe("E2E: the import-resolved file cap never becomes a silent empty", () => {
  let shared: Shared;
  const q = (fn: string): string => `What value does ${fn} return?`;

  beforeAll(async () => {
    const ws = makeWorkspace("cap");
    writeFile(ws, "package.json", '{"name":"x","private":true,"type":"module"}\n');
    // TS barrel: N wildcard re-exports, the constant in the LAST module, read through a named import
    for (const [n, value] of [[4, 4661], [9, 4662]] as const) {
      const lines: string[] = [];
      for (let i = 0; i < n; i++) {
        writeFile(ws, `barrel${n}/core/m${i}.ts`, `export const other${i} = ${i};\n`);
        lines.push(`export * from './m${i}.js';`);
      }
      writeFile(ws, `barrel${n}/core/limits.ts`, `export const gapMs = ${value};\n`);
      lines.push("export * from './limits.js';");
      writeFile(ws, `barrel${n}/core/index.ts`, lines.join("\n") + "\n");
      writeFile(ws, `barrel${n}/svc.ts`, `import { gapMs } from './core/index.js';\nexport function nextGapBarrel${n}(): number { return gapMs; }\n`);
    }
    // Python: N star imports; `limits` FIRST in source order (the last-wins rule tries the LAST star first)
    for (const [n, value] of [[3, 4663], [9, 4664]] as const) {
      writeFile(ws, `star${n}/app/__init__.py`, "");
      for (let i = 0; i < n; i++) writeFile(ws, `star${n}/app/m${i}.py`, `M${i} = ${i}\n`);
      writeFile(ws, `star${n}/app/limits.py`, `gap_ms = ${value}\n`);
      writeFile(ws, `star${n}/app/svc.py`, "from .limits import *\n" + Array.from({ length: n }, (_, i) => `from .m${i} import *`).join("\n") + `\n\n\ndef next_gap_star${n}():\n    return gap_ms\n`);
    }
    // C: three local includes, the constant in the third; and a deep include graph where a stdlib name (NULL) must stay silent
    writeFile(ws, "inc3/src/a.h", "#define A 1\n");
    writeFile(ws, "inc3/src/b.h", "#define B 2\n");
    writeFile(ws, "inc3/src/limits.h", "static const int kGapMs = 4665;\n");
    writeFile(ws, "inc3/src/svc.c", '#include "a.h"\n#include "b.h"\n#include "limits.h"\n\nint next_gap_inc3(void) { return kGapMs; }\n');
    for (let i = 0; i < 11; i++) writeFile(ws, `incdeep/src/h${i}.h`, `#include "h${i + 1}.h"\nstatic const int k${i} = ${i};\n`);
    writeFile(ws, "incdeep/src/h11.h", "static const int k11 = 11;\n");
    writeFile(ws, "incdeep/src/limits.h", "static const int kGapMs = 4666;\n");
    writeFile(ws, "incdeep/src/svc.c", '#include "limits.h"\n' + Array.from({ length: 11 }, (_, i) => `#include "h${i}.h"`).join("\n") + "\n\nint next_gap_incdeep(char *p) {\n  if (p == NULL) return -1;\n  return kGapMs;\n}\n");
    shared = await startShared(ws);
  }, 120_000);

  it("TS barrel with 4 wildcard re-exports: the constant in the 5th module is served (used to stop at the second)", async () => {
    expectServedByClosure(await shared.ask(q("nextGapBarrel4")), "4661");
  }, 120_000);

  it("TS barrel with 9 wildcard re-exports (past the file budget): undetermined naming the constant, never empty", async () => {
    expectDisclosedUndetermined(await shared.ask(q("nextGapBarrel9")), "4662", "gapMs");
  }, 120_000);

  it("Python module with 3 star imports: the constant behind the third is served", async () => {
    expectServedByClosure(await shared.ask(q("next_gap_star3")), "4663");
  }, 120_000);

  it("Python module with 9 star imports (past the file budget): undetermined naming the name, never empty", async () => {
    expectDisclosedUndetermined(await shared.ask(q("next_gap_star9")), "4664", "gap_ms");
  }, 120_000);

  it("C file with three local includes: the constant in the third header is served", async () => {
    expectServedByClosure(await shared.ask(q("next_gap_inc3")), "4665");
  }, 120_000);

  it("C file with a deep include graph: the constant is served and `NULL` never becomes a noise gap", async () => {
    const o = await shared.ask(q("next_gap_incdeep"));
    expectServedByClosure(o, "4666");
    expect(o.gaps.filter((g) => g.includes("NULL")), `noise gap (gaps=${JSON.stringify(o.gaps)})`).toEqual([]);
    expect(o.decisionKind).toBe("act.answer");
  }, 120_000);
});
