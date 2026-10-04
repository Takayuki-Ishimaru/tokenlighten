/**
 * evaluation0929.sameNameExplain.spec.ts — WP-O (eval-0929 §8, 2026-09-29).
 *
 * DEFECT (pre-existing in v0.14.4, byte-identical on the wave's working tree
 * before this fix): an explain / behaviour question about an explicitly named
 * function X that is declared in TWO files (the real one plus an unrelated
 * same-name copy) and called from many files ended in `act.answer` certified
 * from X's CALL SITES only — `identifier:X` (+ `analysis-source` /
 * `behavior-body`) proved, no gap, and neither declaration's body ever reached
 * the client. The first pack gave up on X's definition owner (definition-shaped
 * hits in two files — or in one file plus a caller line carrying `const`) and
 * fell back to the locator's call-site candidates; the re-pack of those call
 * sites then proved `identifier:X` by a mere occurrence.
 *
 * RULES (brief WP-O):
 *  1. For a question whose subject is X, `act.answer` needs X's OWN
 *     declaration on the wire (served in that response, or resident from an
 *     earlier hop of the same task).
 *  2. X declared in >= 2 files: an explicit path wins, then the import relation
 *     of X's callers, then the same file as another subject; when nothing binds,
 *     every declaration (<= 4) is served and the ambiguity is disclosed by name
 *     (X + the declaring files) — never call sites as the answer.
 *  3. A call site or mention never proves X for such a question; usage-only
 *     questions ("who calls X") keep their call-site evidence.
 *  4. X declared once, or a usage-only question: unchanged.
 *
 * Fresh names and values (never the evaluation's or the repro's). Every chain
 * follows the server's own `next` to the end (hop cap 8). One spawned dev server
 * per chain, killed in `afterEach`; workspaces under a short HOME dir, removed in
 * `afterAll`.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import {
  startDevServer,
  followNextToEnd,
  finalDecisionKind,
  type ChainResult,
  type Hop,
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

// ---------------------------------------------------------------------------
// Fixtures: `settleInvoice` in src/billing.ts (the real one, with the overdue
// check), an unrelated same-name copy elsewhere, and route files calling it.
// ---------------------------------------------------------------------------

const X = "settleInvoice";
/** A string only the REAL declaration's body holds. */
const REAL_MARKER = "overdue-4817";
const REAL_SIGNATURE = `export function ${X}(invoice: Invoice, now: number)`;

function realBilling(): string {
  const helpers: string[] = [];
  for (let i = 1; i <= 18; i++) helpers.push(`export function formatLine${i}(value: string): string {`, `  return value.trim() + "#${i}";`, "}", "");
  return [
    "export interface Invoice { id: string; dueAt: number; paid: boolean }",
    "",
    ...helpers,
    `${REAL_SIGNATURE} {`,
    `  if (invoice.paid) { return { settled: true, reason: "paid" }; }`,
    `  if (invoice.dueAt <= now) { return { settled: false, reason: "${REAL_MARKER}" }; }`,
    "  return { settled: false, reason: \"open\" };",
    "}",
    "",
  ].join("\n");
}

function decoyBilling(tag: string, oneLine = false): string {
  return oneLine
    ? `export function ${X}(invoice: { id: string }): { settled: boolean } { return { settled: true }; }\n`
    : [`export function ${X}(invoice: { id: string }, now: number) {`, `  // ${tag}: every invoice counts as settled`, "  return { settled: true };", "}", ""].join("\n");
}

interface CallerGroup {
  readonly from: string;
  readonly count: number;
  readonly start?: number;
  readonly style?: "return" | "const";
  readonly alias?: boolean;
}

function routes(files: Record<string, string>, group: CallerGroup): void {
  const start = group.start ?? 1;
  for (let i = start; i < start + group.count; i++) {
    const local = group.alias ? "settleAlias" : X;
    const lines = [group.alias ? `import { ${X} as settleAlias } from "${group.from}";` : `import { ${X} } from "${group.from}";`, ""];
    for (let k = 0; k < 8; k++) lines.push(`export function route${i}_${k}(input: string): string { return input + "${i}-${k}"; }`);
    lines.push(
      "",
      group.style === "const"
        ? `export function charge${i}(invoice: any, now: number): boolean {\n  const verdict = ${local}(invoice, now);\n  return verdict.settled;\n}`
        : `export function charge${i}(invoice: any, now: number): boolean { return ${local}(invoice, now).settled; }`,
      "",
    );
    files[`src/routes/r${i}.ts`] = lines.join("\n");
  }
}

interface Fixture {
  readonly files: Record<string, string>;
  /** Declaring files, the real one first. */
  readonly declarations: readonly string[];
}

function tsFixture(opts: {
  decoys?: ReadonlyArray<{ path: string; oneLine?: boolean }>;
  callers?: readonly CallerGroup[];
} = {}): Fixture {
  const files: Record<string, string> = {
    "package.json": "{\n  \"name\": \"billing\",\n  \"private\": true,\n  \"type\": \"module\"\n}\n",
    "src/billing.ts": realBilling(),
  };
  for (const decoy of opts.decoys ?? []) files[decoy.path] = decoyBilling(path.basename(path.dirname(decoy.path)), decoy.oneLine === true);
  for (const group of opts.callers ?? [{ from: "../billing.js", count: 30 }]) routes(files, group);
  return { files, declarations: ["src/billing.ts", ...(opts.decoys ?? []).map((decoy) => decoy.path)] };
}

function workspace(files: Record<string, string>): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, ".tl-e0929-samename-"));
  tmpDirs.push(ws);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), content, "utf8");
  }
  return ws;
}

async function chain(files: Record<string, string>, query: string, extra: Record<string, unknown> = {}): Promise<ChainResult> {
  const ws = workspace(files);
  const srv = startDevServer(ws, "default");
  servers.push(srv);
  await srv.initialize();
  return followNextToEnd(
    srv,
    { tool: "tl_read_file", arguments: { query, cwd: ws, task: { epoch: "new" }, ...extra } },
    { cwd: ws, hopCap: 8, maxQrefRepacks: 0 },
  );
}

// ---------------------------------------------------------------------------
// Invariants.
// ---------------------------------------------------------------------------

function bodiesUpTo(result: ChainResult, lastHop: number): string {
  return result.hops
    .slice(0, lastHop + 1)
    .flatMap((hop) => (hop.response?.evidence ?? []).map((row: { body?: string }) => row.body ?? ""))
    .join("\n");
}

function gapsOf(hop: Hop): string[] {
  return hop.response?.decision?.certificate?.gaps ?? [];
}

function actHops(result: ChainResult): Hop[] {
  return result.hops.filter((hop) => hop.response?.decision?.kind === "act.answer");
}

function assertTerminates(result: ChainResult): void {
  expect(result.capped, `chain did not settle within 8 hops: ${JSON.stringify(result.hops.map((hop) => hop.call))}`).toBe(false);
  const seen = new Set<string>();
  for (const hop of result.hops) {
    const { cwd: _cwd, task: _task, ...rest } = hop.call.arguments;
    const signature = JSON.stringify({ tool: hop.call.tool, arguments: rest });
    expect(seen.has(signature), `a later hop repeated an earlier call: ${signature}`).toBe(false);
    seen.add(signature);
  }
}

/** Rule 1: every certified hop stands on the declaration(s) it needs — served in that hop or earlier in the task. */
function assertCertifiedOnDeclarations(result: ChainResult, declarationLines: readonly string[]): void {
  assertTerminates(result);
  expect(finalDecisionKind(result), JSON.stringify(result.final).slice(0, 1500)).toBe("act.answer");
  for (const hop of actHops(result)) {
    const served = bodiesUpTo(result, hop.hopIndex);
    for (const line of declarationLines) {
      expect(served, `hop ${hop.hopIndex} certified ${X} without ${JSON.stringify(line)} on the wire`).toContain(line);
    }
  }
}

/** Rule 2 (bound): the question's own declaration answers it; no ambiguity is claimed. */
function assertBoundToReal(result: ChainResult): void {
  assertCertifiedOnDeclarations(result, [REAL_SIGNATURE, REAL_MARKER]);
  for (const hop of actHops(result)) {
    expect(gapsOf(hop).some((gap) => gap.includes(`${X} is declared in`)), JSON.stringify(gapsOf(hop))).toBe(false);
  }
}

/** Rule 2 (nothing binds): every declaration is served and the ambiguity names X and each declaring file. */
function assertAmbiguityDisclosed(result: ChainResult, declarations: readonly string[], atLeast = false): void {
  assertTerminates(result);
  expect(finalDecisionKind(result), JSON.stringify(result.final).slice(0, 1500)).toBe("act.answer");
  const final = result.hops[result.hops.length - 1]!;
  // The identifier's own disclosure, or — when a value/condition facet of the
  // same subject already discloses it in the same words — the facet's.
  const disclosure = gapsOf(final).find((gap) => gap.startsWith("explicit-gap:request-item-undetermined:") && gap.includes(`(${X} is declared in`));
  expect(disclosure, JSON.stringify(gapsOf(final))).toBeDefined();
  expect(gapsOf(final).filter((gap) => gap.includes(`(${X} is declared in`)), "one disclosure per ambiguity").toHaveLength(1);
  expect(disclosure).toContain(atLeast ? `${X} is declared in at least ${declarations.length} files` : `${X} is declared in ${declarations.length} files`);
  for (const declaration of declarations) expect(disclosure).toContain(declaration);
  const served = bodiesUpTo(result, final.hopIndex);
  expect(served).toContain(REAL_MARKER);
  expect(served.match(new RegExp(`export function ${X}\\(`, "gu"))?.length ?? 0).toBeGreaterThanOrEqual(declarations.length);
}

// ---------------------------------------------------------------------------
// 1. The import relation of X's callers binds the real declaration (rules 1–3).
// ---------------------------------------------------------------------------

describe("WP-O: an explain question about a same-name function is answered from the declaration its callers import", () => {
  const legacy = [{ path: "src/legacy/billing.ts" }];
  const cases: ReadonlyArray<{ name: string; fx: Fixture; query: string; extra?: Record<string, unknown> }> = [
    { name: "EN explain", fx: tsFixture({ decoys: legacy }), query: `Explain ${X}'s overdue check.` },
    { name: "EN how", fx: tsFixture({ decoys: legacy }), query: `How does ${X} decide that an invoice is overdue?` },
    { name: "EN what does X do", fx: tsFixture({ decoys: legacy }), query: `What does ${X} do?` },
    { name: "JA", fx: tsFixture({ decoys: legacy }), query: `${X} の期限切れ判定を説明してください。` },
    { name: "bullets", fx: tsFixture({ decoys: legacy }), query: `Explain the billing module:\n- ${X}'s overdue check\n- what it returns for a paid invoice` },
    { name: "decoy is a one-liner", fx: tsFixture({ decoys: [{ path: "src/legacy/billing.ts", oneLine: true }] }), query: `Explain ${X}'s overdue check.` },
    { name: "decoy sorts first", fx: tsFixture({ decoys: [{ path: "src/aa/billing.ts" }] }), query: `Explain ${X}'s overdue check.` },
    { name: "decoy in another top-level dir", fx: tsFixture({ decoys: [{ path: "lib/compat/billing.ts" }] }), query: `Explain ${X}'s overdue check.` },
    { name: "callers bind the result to a const", fx: tsFixture({ decoys: legacy, callers: [{ from: "../billing.js", count: 30, style: "const" }] }), query: `Explain ${X}'s overdue check.` },
    { name: "callers import it under an alias", fx: tsFixture({ decoys: legacy, callers: [{ from: "../billing.js", count: 30, alias: true }] }), query: `Explain ${X}'s overdue check.` },
    { name: "three declarations, one in a file named after a query word", fx: tsFixture({ decoys: [{ path: "src/legacy/billing.ts" }, { path: "src/compat/invoice.ts" }] }), query: `Explain ${X}'s overdue check.` },
    { name: "four declarations", fx: tsFixture({ decoys: [{ path: "src/legacy/billing.ts" }, { path: "src/compat/invoice.ts" }, { path: "src/v1/invoice.ts" }] }), query: `Explain ${X}'s overdue check.` },
    { name: "small budget with continuation", fx: tsFixture({ decoys: legacy }), query: `Explain ${X}'s overdue check.`, extra: { budget: { bytes: 6144 } } },
  ];
  for (const testCase of cases) {
    it(testCase.name, async () => {
      const result = await chain(testCase.fx.files, testCase.query, testCase.extra ?? {});
      assertBoundToReal(result);
    }, 60_000);
  }

  it("the first pack already serves the bound declaration (no call-site candidate round trip)", async () => {
    const result = await chain(tsFixture({ decoys: legacy }).files, `Explain ${X}'s overdue check.`);
    assertBoundToReal(result);
    expect(result.hops).toHaveLength(1);
    const rows = (result.hops[0]!.response?.evidence ?? []) as Array<{ path: string; why?: string }>;
    expect(rows[0]?.path).toBe("src/billing.ts");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 2. An explicit path in the question wins (WP-I / eval §5: path = focus).
// ---------------------------------------------------------------------------

describe("WP-O: a path named in the question binds that declaration", () => {
  it("naming the same-name copy's file answers from that copy, with no ambiguity claimed", async () => {
    const fx = tsFixture({ decoys: [{ path: "src/legacy/billing.ts" }] });
    const result = await chain(fx.files, `In src/legacy/billing.ts, explain ${X}'s overdue check.`);
    assertCertifiedOnDeclarations(result, ["every invoice counts as settled"]);
    for (const hop of actHops(result)) expect(gapsOf(hop).some((gap) => gap.includes(`${X} is declared in`))).toBe(false);
  }, 60_000);

  it("naming the real file answers from it (path as a suffix)", async () => {
    const fx = tsFixture({ decoys: [{ path: "src/legacy/billing.ts" }] });
    assertBoundToReal(await chain(fx.files, `Explain ${X}'s overdue check in src/billing.ts.`));
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 3. Nothing binds: every declaration served, the ambiguity disclosed by name.
// ---------------------------------------------------------------------------

describe("WP-O: when nothing binds, every declaration is served and the ambiguity is disclosed", () => {
  it("callers of both declarations (EN)", async () => {
    const fx = tsFixture({
      decoys: [{ path: "src/legacy/billing.ts" }],
      callers: [{ from: "../billing.js", count: 20 }, { from: "../legacy/billing.js", count: 6, start: 21 }],
    });
    assertAmbiguityDisclosed(await chain(fx.files, `Explain ${X}'s overdue check.`), fx.declarations);
  }, 60_000);

  it("callers of both declarations (JA)", async () => {
    const fx = tsFixture({
      decoys: [{ path: "src/legacy/billing.ts" }],
      callers: [{ from: "../billing.js", count: 20 }, { from: "../legacy/billing.js", count: 6, start: 21 }],
    });
    assertAmbiguityDisclosed(await chain(fx.files, `${X} の期限切れ判定を説明してください。`), fx.declarations);
  }, 60_000);

  it("two unrelated declarations and no callers at all", async () => {
    const fx = tsFixture({ decoys: [{ path: "src/legacy/billing.ts" }], callers: [] });
    assertAmbiguityDisclosed(await chain(fx.files, `Explain ${X}'s overdue check.`), fx.declarations);
  }, 60_000);

  it("five declaring files: four are served and the disclosure says 'at least 4'", async () => {
    const fx = tsFixture({
      decoys: [{ path: "src/legacy/billing.ts" }, { path: "src/v1/billing.ts" }, { path: "src/v2/billing.ts" }, { path: "src/v3/billing.ts" }],
      callers: [{ from: "../billing.js", count: 12 }, { from: "../legacy/billing.js", count: 4, start: 13 }],
    });
    const result = await chain(fx.files, `Explain ${X}'s overdue check.`);
    const final = result.hops[result.hops.length - 1]!;
    const disclosure = gapsOf(final).find((gap) => gap.startsWith(`explicit-gap:request-item-undetermined:${X} (`));
    expect(disclosure, JSON.stringify(gapsOf(final))).toContain(`${X} is declared in at least 4 files`);
    assertTerminates(result);
    expect(bodiesUpTo(result, final.hopIndex).match(new RegExp(`export function ${X}\\(`, "gu"))?.length ?? 0).toBeGreaterThanOrEqual(4);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 3b. A value/condition FACET asked of the subject binds the same declaration.
// ---------------------------------------------------------------------------

describe("WP-O: a condition facet asked of a same-name subject settles on the declaration the identifier binds", () => {
  const conditionQuery = `What conditions does ${X} check before it reports an invoice as overdue?`;

  it("callers import one declaration: the facet is covered from it, no ambiguity is claimed", async () => {
    const result = await chain(tsFixture({ decoys: [{ path: "src/legacy/billing.ts" }] }).files, conditionQuery);
    assertBoundToReal(result);
    for (const hop of actHops(result)) {
      expect(gapsOf(hop).some((gap) => /^explicit-gap:request-item-(undetermined|empty):condition:/u.test(gap)), JSON.stringify(gapsOf(hop))).toBe(false);
    }
  }, 60_000);

  it("callers of both declarations: both are served and the ambiguity is disclosed", async () => {
    const fx = tsFixture({
      decoys: [{ path: "src/legacy/billing.ts" }],
      callers: [{ from: "../billing.js", count: 20 }, { from: "../legacy/billing.js", count: 6, start: 21 }],
    });
    assertAmbiguityDisclosed(await chain(fx.files, conditionQuery), fx.declarations);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 4. A caller-supplied call-site re-pack never certifies the explain question.
// ---------------------------------------------------------------------------

describe("WP-O: call sites handed in as targets are never X's proof", () => {
  it("targets = call sites of a same-name X: the chain reads the bound declaration before certifying", async () => {
    const fx = tsFixture({ decoys: [{ path: "src/legacy/billing.ts" }] });
    const result = await chain(fx.files, `Explain ${X}'s overdue check.`, {
      targets: [{ path: "src/routes/r1.ts" }, { path: "src/routes/r2.ts" }, { path: "src/routes/r3.ts" }],
    });
    assertBoundToReal(result);
    expect(result.hops[0]!.response?.decision?.kind).not.toBe("act.answer");
  }, 60_000);

  it("targets = one caller of each declaration: both declarations are read and the ambiguity disclosed", async () => {
    const fx = tsFixture({
      decoys: [{ path: "src/legacy/billing.ts" }],
      callers: [{ from: "../billing.js", count: 20 }, { from: "../legacy/billing.js", count: 6, start: 21 }],
    });
    const result = await chain(fx.files, `Explain ${X}'s overdue check.`, {
      targets: [{ path: "src/routes/r1.ts" }, { path: "src/routes/r21.ts" }],
    });
    assertAmbiguityDisclosed(result, fx.declarations);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 5. Other languages (the rule reads parsed symbols and import relations).
// ---------------------------------------------------------------------------

describe("WP-O: other languages", () => {
  it("Python: `from billing import settle_invoice` binds billing.py", async () => {
    const files: Record<string, string> = {
      "billing.py": ["def format_line(value):", "    return value.strip()", "", "", "def settle_invoice(invoice, now):", "    if invoice[\"paid\"]:", "        return {\"settled\": True}", "    if invoice[\"due_at\"] <= now:", `        return {"settled": False, "reason": "${REAL_MARKER}"}`, "    return {\"settled\": False}", ""].join("\n"),
      "legacy_billing.py": ["def settle_invoice(invoice, now):", "    # legacy: every invoice counts as settled", "    return {\"settled\": True}", ""].join("\n"),
    };
    for (let i = 1; i <= 10; i++) files[`routes/r${i}.py`] = ["from billing import settle_invoice", "", `def charge${i}(invoice, now):`, "    return settle_invoice(invoice, now)[\"settled\"]", ""].join("\n");
    const result = await chain(files, "Explain settle_invoice's overdue check.");
    assertCertifiedOnDeclarations(result, ["def settle_invoice(invoice, now):", REAL_MARKER]);
    for (const hop of actHops(result)) expect(gapsOf(hop).some((gap) => gap.includes("is declared in"))).toBe(false);
  }, 60_000);

  it("Go: a package-qualified call binds the imported package's declaration", async () => {
    const files: Record<string, string> = {
      "go.mod": "module example.com/shop\n\ngo 1.22\n",
      "internal/billing/settle.go": ["package billing", "", "type Invoice struct{ DueAt int64; Paid bool }", "", "func SettleInvoice(inv Invoice, now int64) string {", "\tif inv.Paid {", "\t\treturn \"paid\"", "\t}", "\tif inv.DueAt <= now {", `\t\treturn "${REAL_MARKER}"`, "\t}", "\treturn \"open\"", "}", ""].join("\n"),
      "internal/legacy/settle.go": ["package legacy", "", "type Invoice struct{ DueAt int64 }", "", "func SettleInvoice(inv Invoice, now int64) string {", "\t// legacy: every invoice counts as settled", "\treturn \"settled\"", "}", ""].join("\n"),
    };
    for (let i = 1; i <= 6; i++) files[`cmd/r${i}/main.go`] = ["package main", "", "import \"example.com/shop/internal/billing\"", "", `func charge${i}(inv billing.Invoice, now int64) string {`, "\treturn billing.SettleInvoice(inv, now)", "}", ""].join("\n");
    const result = await chain(files, "Explain SettleInvoice's overdue check.");
    assertCertifiedOnDeclarations(result, ["func SettleInvoice(inv Invoice, now int64) string {", REAL_MARKER]);
  }, 60_000);

  it("Java: receiver calls cannot attribute a declaration — both are served and the ambiguity disclosed", async () => {
    const files: Record<string, string> = {
      "src/main/java/shop/billing/InvoiceSettler.java": ["package shop.billing;", "", "public class InvoiceSettler {", "  public String settleInvoice(long dueAt, long now) {", `    if (dueAt <= now) { return "${REAL_MARKER}"; }`, "    return \"open\";", "  }", "}", ""].join("\n"),
      "src/main/java/shop/legacy/LegacySettler.java": ["package shop.legacy;", "", "public class LegacySettler {", "  public String settleInvoice(long dueAt, long now) {", "    // legacy: every invoice counts as settled", "    return \"settled\";", "  }", "}", ""].join("\n"),
    };
    for (let i = 1; i <= 6; i++) files[`src/main/java/shop/web/Route${i}.java`] = ["package shop.web;", "", "import shop.billing.InvoiceSettler;", "", `public class Route${i} {`, "  private final InvoiceSettler settler = new InvoiceSettler();", `  public String charge${i}(long dueAt, long now) { return settler.settleInvoice(dueAt, now); }`, "}", ""].join("\n");
    const result = await chain(files, `Explain ${X}'s overdue check.`);
    assertTerminates(result);
    expect(finalDecisionKind(result)).toBe("act.answer");
    const final = result.hops[result.hops.length - 1]!;
    const disclosure = gapsOf(final).find((gap) => gap.startsWith(`explicit-gap:request-item-undetermined:${X} (`));
    expect(disclosure, JSON.stringify(gapsOf(final))).toBeDefined();
    expect(disclosure).toContain("InvoiceSettler.java");
    expect(disclosure).toContain("LegacySettler.java");
    const served = bodiesUpTo(result, final.hopIndex);
    expect(served).toContain(REAL_MARKER);
    expect(served).toContain("every invoice counts as settled");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 6. Recall controls (rule 4): a single declaration and usage-only questions.
// ---------------------------------------------------------------------------

describe("WP-O recall controls", () => {
  it("X declared once: the first pack serves its declaration (one hop, no disclosure)", async () => {
    const result = await chain(tsFixture().files, `Explain ${X}'s overdue check.`);
    assertBoundToReal(result);
    expect(result.hops).toHaveLength(1);
  }, 60_000);

  it("X declared once, callers bind its result to a const: still its declaration, never the call sites", async () => {
    const result = await chain(tsFixture({ callers: [{ from: "../billing.js", count: 30, style: "const" }] }).files, `Explain ${X}'s overdue check.`);
    assertBoundToReal(result);
    expect(result.hops).toHaveLength(1);
  }, 60_000);

  for (const [label, query] of [
    ["who calls", `Who calls ${X}?`],
    ["where is it used", `Where is ${X} used?`],
    ["JA callers", `${X} の呼び出し元を教えてください。`],
  ] as const) {
    it(`usage-only question (${label}) with a same-name copy: call sites stay its evidence, nothing is bound or disclosed`, async () => {
      const result = await chain(tsFixture({ decoys: [{ path: "src/legacy/billing.ts" }] }).files, query);
      const text = JSON.stringify(result.hops.map((hop) => hop.response));
      expect(text).not.toContain(`${X} is declared in`);
      for (const hop of result.hops) {
        for (const row of (hop.response?.evidence ?? []) as Array<{ why?: string }>) {
          expect(row.why ?? "").not.toBe("answer-explicit-identifier-recovery");
        }
      }
    }, 60_000);
  }
});
