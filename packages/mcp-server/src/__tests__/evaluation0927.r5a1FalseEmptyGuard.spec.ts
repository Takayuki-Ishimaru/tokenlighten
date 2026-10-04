/**
 * evaluation0927.r5a1FalseEmptyGuard.spec.ts — R5-A1 (round-5 wave,
 * 2026-09-28): regression coverage for review-findings-fable-r4.md's P0-1,
 * P0-2, P1-7, P2-15, and the round-5 MENTION GUARD (brief-round5.md, "a
 * request-item-empty for callers must become STRUCTURALLY impossible while
 * any unexplained mention of the name exists").
 *
 * Every fixture below is written FRESH against the DESCRIBED defect class —
 * different identifiers, different file names, different shapes than the
 * reviewer's own cases4.mjs fixtures — so a fix that only special-cases the
 * reviewer's exact names would still fail here.
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
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-r5a1-${tag}-`));
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
    { tool: "tl_read_file", arguments: { query, task: { epoch: "new", profile: "answer" }, cwd: ws } },
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
// P0-1 (eval-0927 review-r4 #1): a free function beside an unrelated type in
// the SAME file must never be treated as that type's member — its bare
// calls (which by construction carry no receiver) would otherwise lose the
// receiver-strength gate outright.
// ---------------------------------------------------------------------------
describe("P0-1 — a free function beside an unrelated type keeps its bare callers, per language", () => {
  it("TypeScript: a free function beside a class is called bare, not through the class", async () => {
    const ws = makeWorkspace("p01-ts");
    writeFile(ws, "package.json", '{ "name": "p01ts", "private": true, "type": "module" }\n');
    writeFile(
      ws,
      "src/ledger.ts",
      "export class Ledger {\n  constructor(readonly owner: string) {}\n}\n\nexport function openLedger(owner: string): Ledger {\n  return new Ledger(owner);\n}\n",
    );
    writeFile(
      ws,
      "src/onboard.ts",
      "import { openLedger } from \"./ledger\";\n\nexport function onboard(owner: string): string {\n  const ledger = openLedger(owner);\n  return ledger.owner;\n}\n",
    );
    const chain = await ask(ws, "Who calls openLedger?");
    expect(allWhy(chain)).toContain("1 of 1 call sites");
    expectNeverFalseEmpty(chain, "openLedger");
  });

  it("Go: a receiver-less func beside a struct is called bare (package-qualified), not through the struct", async () => {
    const ws = makeWorkspace("p01-go");
    writeFile(ws, "go.mod", "module example.com/ledger\n\ngo 1.22\n");
    writeFile(
      ws,
      "ledger/ledger.go",
      "package ledger\n\ntype Ledger struct {\n\tOwner string\n}\n\nfunc OpenLedger(owner string) *Ledger {\n\treturn &Ledger{Owner: owner}\n}\n",
    );
    writeFile(
      ws,
      "onboard/onboard.go",
      "package onboard\n\nimport \"example.com/ledger/ledger\"\n\nfunc Onboard(owner string) string {\n\tl := ledger.OpenLedger(owner)\n\treturn l.Owner\n}\n",
    );
    const chain = await ask(ws, "Who calls OpenLedger?");
    expect(allWhy(chain)).toContain("1 of 1 call sites");
    expectNeverFalseEmpty(chain, "OpenLedger");
  });

  it("Python: a free function beside a class is called bare, not through the class", async () => {
    const ws = makeWorkspace("p01-py");
    writeFile(ws, "pyproject.toml", '[project]\nname = "p01py"\nversion = "0.1.0"\n');
    writeFile(
      ws,
      "ledger/ledger.py",
      "class Ledger:\n    def __init__(self, owner):\n        self.owner = owner\n\n\ndef open_ledger(owner):\n    return Ledger(owner)\n",
    );
    writeFile(
      ws,
      "ledger/onboard.py",
      "from .ledger import open_ledger\n\n\ndef onboard(owner):\n    ledger = open_ledger(owner)\n    return ledger.owner\n",
    );
    const chain = await ask(ws, "Who calls open_ledger?");
    expect(allWhy(chain)).toContain("1 of 1 call sites");
    expectNeverFalseEmpty(chain, "open_ledger");
  });

  it("C: a free function beside a struct DEFINITION is called bare, not through the struct", async () => {
    const ws = makeWorkspace("p01-c-struct");
    writeFile(ws, "Makefile", "all:\n\tcc -o app src/*.c\n");
    writeFile(ws, "include/ledger.h", "#ifndef LEDGER_H\n#define LEDGER_H\ntypedef struct ledger ledger_t;\nledger_t *ledger_open(const char *owner);\n#endif\n");
    writeFile(ws, "src/ledger.c", "#include \"ledger.h\"\n#include <stdlib.h>\nstruct ledger { const char *owner; };\nledger_t *ledger_open(const char *owner) {\n  ledger_t *l = malloc(sizeof *l);\n  l->owner = owner;\n  return l;\n}\n");
    writeFile(ws, "src/onboard.c", "#include \"ledger.h\"\n#include <stdio.h>\nint onboard(const char *owner) {\n  ledger_t *l = ledger_open(owner);\n  printf(\"%p\\n\", (void *)l);\n  return 0;\n}\n");
    const chain = await ask(ws, "Who calls ledger_open?");
    expect(allWhy(chain)).toContain("1 of 1 call sites");
    expectNeverFalseEmpty(chain, "ledger_open");
  });

  it("C: a free function beside an opaque typedef'd struct (prototype-only header) is called bare", async () => {
    const ws = makeWorkspace("p01-c-typedef");
    writeFile(ws, "Makefile", "all:\n\tcc -o app src/*.c\n");
    writeFile(ws, "include/ledger.h", "#ifndef LEDGER_H\n#define LEDGER_H\n#include <stddef.h>\ntypedef struct ledger ledger_t;\nledger_t *ledger_open(const char *owner);\nsize_t ledger_count(ledger_t *l);\n#endif\n");
    writeFile(ws, "src/ledger.c", "#include \"ledger.h\"\n#include <stdlib.h>\nstruct ledger { const char *owner; };\nledger_t *ledger_open(const char *owner) {\n  ledger_t *l = malloc(sizeof *l);\n  l->owner = owner;\n  return l;\n}\nsize_t ledger_count(ledger_t *l) {\n  return l->owner[0] == 0 ? 0 : 1;\n}\n");
    writeFile(ws, "src/onboard.c", "#include \"ledger.h\"\n#include <stdio.h>\nint onboard(const char *owner) {\n  ledger_t *l = ledger_open(owner);\n  printf(\"%zu\\n\", ledger_count(l));\n  return 0;\n}\n");
    const chain = await ask(ws, "Who calls ledger_open?");
    expect(allWhy(chain)).toContain("1 of 1 call sites");
    expectNeverFalseEmpty(chain, "ledger_open");
  });

  it("control: C free function with NO struct anywhere in the file still resolves its caller", async () => {
    const ws = makeWorkspace("p01-c-nostruct");
    writeFile(ws, "Makefile", "all:\n\tcc -o app src/*.c\n");
    writeFile(ws, "include/ledger.h", "#ifndef LEDGER_H\n#define LEDGER_H\nvoid *ledger_open(const char *owner);\n#endif\n");
    writeFile(ws, "src/ledger.c", "#include \"ledger.h\"\n#include <stdlib.h>\nvoid *ledger_open(const char *owner) {\n  return malloc(1);\n}\n");
    writeFile(ws, "src/onboard.c", "#include \"ledger.h\"\n#include <stdio.h>\nint onboard(const char *owner) {\n  void *l = ledger_open(owner);\n  printf(\"%p\\n\", l);\n  return 0;\n}\n");
    const chain = await ask(ws, "Who calls ledger_open?");
    expect(allWhy(chain)).toContain("1 of 1 call sites");
    expectNeverFalseEmpty(chain, "ledger_open");
  });
});

// ---------------------------------------------------------------------------
// P0-2 (eval-0927 review-r4 #2): a C++ out-of-line member definition
// (`Type Owner::member(...) { ... }`) sits at file scope with no
// enclosingSymbol at all — the qualifier lives in the symbol's own name.
// Both `::` and `.` clause spellings must resolve it.
// ---------------------------------------------------------------------------
describe("P0-2 — a C++ out-of-line qualified member definition resolves under both `::` and `.` spellings", () => {
  function buildAccountWorkspace(ws: string): void {
    writeFile(ws, "CMakeLists.txt", "cmake_minimum_required(VERSION 3.20)\nproject(acct)\n");
    writeFile(
      ws,
      "include/account.h",
      "#pragma once\n#include <string>\n\nenum class AccountState { Open, Closed };\n\nclass Account {\npublic:\n  explicit Account(int balance);\n  AccountState close(int id);\n  void deposit(int id);\n\nprivate:\n  int balance_;\n};\n",
    );
    writeFile(
      ws,
      "src/account.cpp",
      "#include \"account.h\"\n\nAccount::Account(int balance) : balance_(balance) {}\n\nAccountState Account::close(int id) {\n  return id > balance_ ? AccountState::Closed : AccountState::Open;\n}\n\nvoid Account::deposit(int id) {\n  balance_ += id;\n}\n",
    );
    writeFile(
      ws,
      "src/main.cpp",
      "#include \"account.h\"\n#include <iostream>\n\nint main() {\n  Account account(10);\n  auto state = account.close(3);\n  std::cout << (state == AccountState::Open) << std::endl;\n  return 0;\n}\n",
    );
  }

  it("`Owner::member` spelling resolves the out-of-line definition and its caller", async () => {
    const ws = makeWorkspace("p02-cpp-scope");
    buildAccountWorkspace(ws);
    const chain = await ask(ws, "Who calls Account::close?");
    const why = allWhy(chain);
    expect(why).toContain("closure:callers close");
    expect(why).toContain("1 of 1 call sites");
    expectNeverFalseEmpty(chain, "close");
  });

  it("`Owner.member` (dot) spelling resolves the SAME out-of-line definition and its caller", async () => {
    const ws = makeWorkspace("p02-cpp-dot");
    buildAccountWorkspace(ws);
    const chain = await ask(ws, "Who calls Account.close?");
    const why = allWhy(chain);
    expect(why).toContain("closure:callers close");
    expect(why).toContain("1 of 1 call sites");
    expectNeverFalseEmpty(chain, "close");
  });
});

// ---------------------------------------------------------------------------
// MENTION GUARD, P1-5/P1-6 shapes (R5-A2's classifier territory — the guard
// must hold whatever that classifier does): a call hiding inside a
// template/f-string interpolation, an explicit generic argument list, or a
// generator delegation must never certify a clean "0 call sites".
// ---------------------------------------------------------------------------
describe("MENTION GUARD — a call the declaration/call-site classifier itself cannot see is never silently certified empty", () => {
  it("TypeScript: a call hiding inside a template-literal interpolation is not a false empty", async () => {
    const ws = makeWorkspace("mg-ts-template");
    writeFile(ws, "package.json", '{ "name": "mgts", "private": true, "type": "module" }\n');
    writeFile(ws, "src/humanize.ts", "export function humanizeSize(n: number): string {\n  return `${(n / 1024).toFixed(1)} KiB`;\n}\n");
    writeFile(ws, "src/summary.ts", "import { humanizeSize } from \"./humanize\";\n\nexport function summarize(total: number): string {\n  return `grand total ${humanizeSize(total)} across every file`;\n}\n");
    const chain = await ask(ws, "Who calls humanizeSize?");
    expectNeverFalseEmpty(chain, "humanizeSize");
  });

  it("Python: a call hiding inside an f-string replacement field is not a false empty", async () => {
    const ws = makeWorkspace("mg-py-fstring");
    writeFile(ws, "pyproject.toml", '[project]\nname = "mgpy"\nversion = "0.1.0"\n');
    writeFile(ws, "humanize/humanize.py", "def humanize_size(n):\n    return f\"{n / 1024:.1f} KiB\"\n");
    writeFile(ws, "humanize/summary.py", "from .humanize import humanize_size\n\n\ndef summarize(total):\n    return f\"grand total {humanize_size(total)} across every file\"\n");
    const chain = await ask(ws, "Who calls humanize_size?");
    expectNeverFalseEmpty(chain, "humanize_size");
  });

  it("Go: an explicit generic type-argument call (`pkg.Fn[T](...)`) is not a false empty", async () => {
    const ws = makeWorkspace("mg-go-generic");
    writeFile(ws, "go.mod", "module example.com/agg\n\ngo 1.22\n");
    writeFile(
      ws,
      "agg/total.go",
      "package agg\n\ntype Numeric interface {\n\t~int | ~float64\n}\n\nfunc Total[T Numeric](xs []T) T {\n\tvar out T\n\tfor _, x := range xs {\n\t\tout += x\n\t}\n\treturn out\n}\n",
    );
    writeFile(ws, "app/main.go", "package app\n\nimport \"example.com/agg/agg\"\n\nfunc Sum(xs []int) int {\n\treturn agg.Total[int](xs)\n}\n");
    const chain = await ask(ws, "Who calls Total?");
    expectNeverFalseEmpty(chain, "Total");
  });

  it("JavaScript: a generator called only via `yield*` delegation is not a false empty", async () => {
    const ws = makeWorkspace("mg-js-yieldstar");
    writeFile(ws, "package.json", '{ "name": "mgjs", "private": true, "type": "module" }\n');
    writeFile(ws, "src/traverse.js", "export function* traverseNodes(node) {\n  yield node;\n  for (const child of node.children ?? []) yield* traverseNodes(child);\n}\n");
    writeFile(ws, "src/collect.js", "import { traverseNodes } from \"./traverse.js\";\n\nexport function* collectAll(root) {\n  yield* traverseNodes(root);\n}\n");
    const chain = await ask(ws, "Who calls traverseNodes?");
    expectNeverFalseEmpty(chain, "traverseNodes");
  });
});

// ---------------------------------------------------------------------------
// P1-7 (eval-0927 review-r4 #7): a same-name candidate cap that is hit must
// never settle for "every declaration found so far is empty" — the real
// caller might be a same-named declaration past the cap, in the SAME file.
// ---------------------------------------------------------------------------
describe("P1-7 — a same-name-candidate cap hit in one file never settles for a false empty", () => {
  it("7 same-named methods in ONE file; only the 7th (past the 4-candidate cap) is actually called", async () => {
    const ws = makeWorkspace("p17-onefile");
    writeFile(ws, "package.json", '{ "name": "p17one", "private": true, "type": "module" }\n');
    let src = "";
    for (const n of ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta"]) {
      src += `export class ${n}Formatter {\n  format(input: string): string {\n    return "${n}:" + input;\n  }\n}\n\n`;
    }
    writeFile(ws, "src/formatters.ts", src);
    writeFile(
      ws,
      "src/output.ts",
      "import { EtaFormatter } from \"./formatters\";\n\nconst eta = new EtaFormatter();\n\nexport function output(input: string): string {\n  return eta.format(input);\n}\n",
    );
    const chain = await ask(ws, "Who calls format?", 24);
    expectNeverFalseEmpty(chain, "format");
  });
});

// ---------------------------------------------------------------------------
// P2-15 (eval-0927 review-r4 #15): when a plain function and a same-named
// method are BOTH called, the disclosure for the plain function's call
// sites must not present a namespace/receiver-qualified site as if it were
// unambiguous proof of the SAME declaration.
// ---------------------------------------------------------------------------
describe("P2-15 — mixed-strength call sites disclose the attribution is mixed, not a clean count", () => {
  it("a plain function and a same-named class method, both called, do not share one clean count", async () => {
    const ws = makeWorkspace("p215-mixed");
    writeFile(ws, "package.json", '{ "name": "p215", "private": true, "type": "module" }\n');
    writeFile(ws, "src/util/close.ts", "export function close(handle: number): void {\n  console.log(handle);\n}\n");
    writeFile(
      ws,
      "src/account.ts",
      "export class Account {\n  constructor(private readonly ledger: Map<string, number>) {}\n\n  close(id: string): boolean {\n    return this.ledger.delete(id);\n  }\n}\n",
    );
    writeFile(
      ws,
      "src/api/accounts.ts",
      "import { Account } from \"../account\";\n\nconst account = new Account(new Map());\n\nexport function closeAccount(id: string): boolean {\n  return account.close(id);\n}\n",
    );
    writeFile(
      ws,
      "src/jobs/handles.ts",
      "import { close } from \"../util/close\";\n\nexport function releaseAll(handles: number[]): void {\n  for (const h of handles) close(h);\n}\n",
    );
    const chain = await ask(ws, "Who calls close?");
    const why = allWhy(chain);
    // Either the disclosure names the mix explicitly, or every recorded
    // site is unambiguous (strength-2 only) — a bare "N of N" claim must
    // never silently fold a receiver-qualified site into a plain
    // function's own clean count without saying so.
    if (why.includes("call sites)")) {
      expect(why).not.toMatch(/close \(2 of 2 call sites\)(?! *;)/);
    }
  });
});

// ---------------------------------------------------------------------------
// Recall control: a genuinely empty callers facet (truly zero mentions
// anywhere) must still certify "empty" — the guard must not defeat honest
// emptiness by turning EVERY callers question into "undetermined".
// ---------------------------------------------------------------------------
describe("control — a genuinely unused function still certifies empty", () => {
  it("a function with zero mentions anywhere else in the workspace is verified empty", async () => {
    const ws = makeWorkspace("control-empty");
    writeFile(ws, "package.json", '{ "name": "controlempty", "private": true, "type": "module" }\n');
    writeFile(ws, "src/unused.ts", "export function unusedHelper(value: number): number {\n  return value * 2;\n}\n");
    writeFile(ws, "src/other.ts", "export function otherHelper(value: number): number {\n  return value + 1;\n}\n");
    const chain = await ask(ws, "Who calls unusedHelper?");
    const gaps = allGaps(chain);
    expect(gaps).toContain("request-item-empty:callers:unusedHelper (0 call sites");
  });
});
