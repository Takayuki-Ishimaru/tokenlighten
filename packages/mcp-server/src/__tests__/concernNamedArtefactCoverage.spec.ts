/**
 * concernNamedArtefactCoverage.spec.ts — GATE-B (v0.14.3 improvement-plan fix
 * wave, 2026-09-21).
 *
 * THE REGRESSION THIS GUARDS. CONFIRMED by the orchestrator (in-process
 * probe, tree vs clean HEAD `03002d8c`), fixture = a single `calc.ts` (a
 * header comment naming the file, then several tiny arithmetic helpers using
 * `sum`/`diff`):
 *   `read_file {query:"Explain what calc.ts does and how its operations
 *    combine sum and diff.", targets:[{path:"calc.ts"}], content:"auto",
 *    task:{epoch:"new",profile:"answer"}, budget:{bytes:60000}}`
 *   clean HEAD -> `act.answer` (no `request-item:*` obligation at all: HEAD's
 *     `isIndependentQuestionClause` never treats an `Explain`-led clause as
 *     an independent question, so the request-item mechanism never engages
 *     clause 1 in the first place — see the FIX-B/H-4 note below).
 *   tree (post FIX-B's H-4 widening, pre GATE-B) -> `discover`,
 *     `gaps:[{code:"missing-evidence", refs:["request-item:ri-1"]}]`, even
 *     though `calc.ts` was served WHOLE.
 * ROOT CAUSE (confirmed by reading `readCodeTaskPack.ts`): FIX-B's own H-4
 * widening (`headIsWhAfterReadLead`, already landed, out of this file's
 * scope) makes clause 1 ("Explain what calc.ts does") an INDEPENDENT
 * QUESTION for the first time, so it now becomes a BLOCKING obligation
 * (`buildRequestItemReadiness`'s all-topic H-2 loop). Its own topic term,
 * after light-verb/stopword filtering, is exactly `"calc"` — the file's own
 * basename stem (`concernTopicTerms`/`salientWords` never keeps the `.ts`
 * suffix: `SALIENT_WORD_RE` requires 4+ word characters, and `ts` alone is
 * two). THE POLICY (`concernCoveredByServedEvidence`) required either two
 * distinct topic terms whose CONTENT (not path) is evidenced, or the lone
 * term to be ANCHORED (a code-position match, or 2+ occurrences in the
 * served text) — and "calc" occurs in `calc.ts` only ONCE, inside the header
 * comment, never in actual code. A path-name match is deliberately not an
 * anchor (FIX-C2's own "session renewal" false-anchor finding), so the
 * concern stayed `open` although the file it names was served WHOLE.
 *
 * THE FIX (`readCodeTaskPack.ts`, `concernNamesServedPath` /
 * `pathServedWholeFile` / `concernNamesDeclaredSymbol`, wired into
 * `concernCoveredByServedEvidence`'s per-surface loop as `namedArtefactCovered`).
 * A concern that NAMES a served artefact — by that surface's own full
 * relative path or its basename WITH EXTENSION (never a bare directory name
 * or an extension-less word that merely equals a path segment — FIX-C2's
 * `src/auth/…` false anchor stays closed), or by a symbol AST-declared in
 * it — is covered by serving that artefact: when the named path's served
 * spans leave no real remainder (whole file), or when some OTHER topic term
 * of the SAME concern is content-evidenced even over a partial serve, or
 * (for a symbol) when its declaration's range lies inside the served range.
 * Because every call site funnels through this ONE policy function, the fix
 * is automatic for the H-2 blocking loop, the mixed-kind loop, and the
 * `analysis-source` reconciliation alike — no per-path patch.
 *
 * EMPIRICAL VERIFICATION (ad hoc, in-process probes against both this tree
 * and clean HEAD, deleted after use — not part of this file): the exact
 * calc.ts shape above now reaches `act.answer` on this tree, matching clean
 * HEAD's outward decision kind; temporary instrumentation confirmed
 * `namedArtefactCovered` is `true` only for "Explain what calc.ts does"
 * (against `calc.ts`) and `false` for every directory-name/extension-less
 * probe below — their own `act.answer` comes from a DIFFERENT, pre-existing
 * `proveUnbindableRequestItem` fallback ("every literal-find candidate for
 * this point is served" / "served evidence contradicts absence of …"),
 * confirmed via this file's own `TL_TRACE` assertions (`REASON_*` below),
 * which this fix never touches.
 *
 * WHAT THIS FILE SWEEPS: a topic term naming a served artefact by basename,
 * by full relative path, by a declared symbol; two required recall controls
 * (a bare directory name, an extension-less word that merely equals a path
 * segment) that must never newly anchor; whole-file vs genuinely partial
 * serves (a real `content_completeness:"partial"` surface, not a caller-
 * ranged "exactly what was asked for" slice, which the pre-existing
 * `candidateFullyServed` already treats as settled for unrelated reasons);
 * a compound concern paired with an implemented and with a genuinely absent
 * second concern. Both default and VS Code config for the confirmed
 * regression shape; default only elsewhere (resource-bounded per this wave's
 * common brief — the policy function is config-independent).
 */
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { getTracePath, setTraceEnabledForTest } from "../util/trace.js";
import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();

const VSCODE_ENV: Readonly<Record<string, string>> = {
  TOKENLIGHTEN_CLIENT: "vscode",
  TOKENLIGHTEN_CLIENT_ID: "vscode",
  TL_TURN_ECONOMY: "1",
  TOKENLIGHTEN_TASK_PACK_MAX_BYTES: "0",
};

async function withEnv<T>(overrides: Readonly<Record<string, string>>, fn: () => Promise<T>): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) previous[key] = process.env[key];
  Object.assign(process.env, overrides);
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

interface ToolResult { content: Array<{ text: string }> }

async function callWire(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { callTool } = (await import("../server.js")) as unknown as {
    callTool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  };
  const response = await callTool(tool, args);
  return JSON.parse(response.content[0]!.text) as Record<string, unknown>;
}

const roots: string[] = [];

function mkWs(tag: string): string {
  const dir = fs.realpathSync(shortTmpDir(HOME, `.tl-gateb-${tag}-`));
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  roots.push(dir);
  return dir;
}

function writeFile(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

afterEach(async () => {
  setTraceEnabledForTest(undefined);
  for (const root of roots.splice(0)) {
    try { await rmDirWithRetry(root); } catch { /* best-effort */ }
  }
});

function readTraceRecords(root: string): Array<Record<string, unknown>> {
  const tracePath = getTracePath(root);
  if (!fs.existsSync(tracePath)) return [];
  return fs.readFileSync(tracePath, "utf8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The LAST (final, post-reconciliation) `request_item_status` record whose clause starts with `clausePrefix`. */
function finalStatusFor(root: string, clausePrefix: string): Record<string, unknown> | undefined {
  const matches = readTraceRecords(root).filter(
    (r) => r["event"] === "request_item_status" && typeof r["clause"] === "string" && (r["clause"] as string).startsWith(clausePrefix),
  );
  return matches[matches.length - 1];
}

function pick(obj: unknown, keyPath: string): unknown {
  return keyPath.split(".").reduce<unknown>((acc, key) => (acc == null ? undefined : (acc as Record<string, unknown>)[key]), obj);
}

/** calc.ts: a header comment naming the file, then `count` tiny arithmetic helpers combining sum/diff. */
function calcTsSource(count = 20): string {
  const lines = ["// calc.ts -- tiny arithmetic helpers"];
  for (let i = 0; i < count; i += 1) {
    lines.push(
      `export function op${i}(a: number, b: number): number {`,
      "  const sum = a + b;",
      "  const diff = a - b;",
      "  const combined = sum + diff;",
      "  return combined;",
      "}",
    );
  }
  return lines.join("\n") + "\n";
}

const CONFIGS: readonly { name: string; env: Readonly<Record<string, string>> }[] = [
  { name: "default", env: {} },
  { name: "vscode", env: VSCODE_ENV },
];

describe("GATE-B — a concern that names a served artefact is covered by serving it", () => {
  // ---------------------------------------------------------------------
  // 1. The confirmed regression: basename-named, whole file served,
  //    compound with an implemented second concern. Both configs.
  // ---------------------------------------------------------------------
  for (const config of CONFIGS) {
    it(`calc.ts named by basename, whole file served -> act.answer (${config.name})`, async () => {
      const ws = mkWs(`calc-${config.name}`);
      writeFile(ws, "calc.ts", calcTsSource());
      writeFile(ws, "package.json", JSON.stringify({ name: "fixture", version: "0.0.0" }) + "\n");

      const body = await withEnv(config.env, () =>
        callWire("read_file", {
          query: "Explain what calc.ts does and how its operations combine sum and diff.",
          targets: [{ path: "calc.ts" }],
          content: "auto",
          task: { epoch: "new", profile: "answer" },
          budget: { bytes: 60000 },
          cwd: ws,
        }),
      );

      expect(pick(body, "decision.kind"), JSON.stringify(body)).toBe("act.answer");
      const evidence = (body["evidence"] as Array<Record<string, unknown>>) ?? [];
      const surface = evidence.find((e) => e["path"] === "calc.ts");
      expect(surface, "expected calc.ts evidence").toBeDefined();
      expect(surface?.["remaining"], "calc.ts should be served whole, no remaining").toBeUndefined();
    });
  }

  // ---------------------------------------------------------------------
  // 2. Compound with a genuinely absent second concern: concern 1 (naming)
  //    covered silently; concern 2 disclosed absent; still act.answer.
  // ---------------------------------------------------------------------
  it("calc.ts named by basename, paired with a genuinely absent second concern", async () => {
    const ws = mkWs("calc-absent");
    writeFile(ws, "calc.ts", calcTsSource());
    writeFile(ws, "package.json", JSON.stringify({ name: "fixture", version: "0.0.0" }) + "\n");

    const body = await callWire("read_file", {
      query: "Explain what calc.ts does and how the invoice tax surcharge is rounded.",
      targets: [{ path: "calc.ts" }],
      content: "auto",
      task: { epoch: "new", profile: "answer" },
      budget: { bytes: 60000 },
      cwd: ws,
    });

    expect(pick(body, "decision.kind"), JSON.stringify(body)).toBe("act.answer");
    const gaps = (pick(body, "decision.certificate.gaps") as string[] | undefined) ?? [];
    expect(gaps.some((g) => /invoice|surcharge|rounded/i.test(g)), JSON.stringify(gaps)).toBe(true);
    // Invariant (i): the naming concern's own words never show up in an
    // absence disclosure alongside the file that answers it.
    expect(gaps.some((g) => /\bcalc\b/i.test(g)), JSON.stringify(gaps)).toBe(false);
  });

  // ---------------------------------------------------------------------
  // 3. Full relative path naming (nested file), paired with a symbol in the
  //    same file for the second (implemented) concern.
  // ---------------------------------------------------------------------
  it("a nested file named by its full relative path, whole file served", async () => {
    const ws = mkWs("fullpath");
    writeFile(
      ws,
      "src/util/mathHelpers.ts",
      [
        "// mathHelpers.ts -- shared numeric helpers",
        "export function averageOf(values: number[]): number {",
        "  const total = values.reduce((acc, v) => acc + v, 0);",
        "  return total / values.length;",
        "}",
        "export function clampValue(value: number, min: number, max: number): number {",
        "  if (value < min) return min;",
        "  if (value > max) return max;",
        "  return value;",
        "}",
        "",
      ].join("\n"),
    );
    writeFile(ws, "package.json", JSON.stringify({ name: "fixture", version: "0.0.0" }) + "\n");

    const body = await callWire("read_file", {
      query: "Explain what src/util/mathHelpers.ts does and how clampValue restricts a value.",
      targets: [{ path: "src/util/mathHelpers.ts" }],
      content: "auto",
      task: { epoch: "new", profile: "answer" },
      budget: { bytes: 60000 },
      cwd: ws,
    });

    expect(pick(body, "decision.kind"), JSON.stringify(body)).toBe("act.answer");
    const evidence = (body["evidence"] as Array<Record<string, unknown>>) ?? [];
    expect(evidence.some((e) => e["path"] === "src/util/mathHelpers.ts" && e["remaining"] === undefined)).toBe(true);
  });

  // ---------------------------------------------------------------------
  // 4. Symbol-declared naming: a declared symbol as the concern's own topic
  //    term, whole file served.
  // ---------------------------------------------------------------------
  it("a declared symbol named as the concern's own topic term, whole file served", async () => {
    const ws = mkWs("symbol");
    writeFile(
      ws,
      "src/pricing.ts",
      [
        "// pricing.ts -- discount helpers",
        "export interface TierRates { gold: number; silver: number; }",
        "export function computeDiscountRate(tier: string, rates: TierRates): number {",
        '  if (tier === "gold") return rates.gold;',
        '  if (tier === "silver") return rates.silver;',
        "  return 0;",
        "}",
        "export function applyDiscount(amount: number, rate: number): number {",
        "  return amount - amount * rate;",
        "}",
        "",
      ].join("\n"),
    );
    writeFile(ws, "package.json", JSON.stringify({ name: "fixture", version: "0.0.0" }) + "\n");

    const body = await callWire("read_file", {
      query: "Explain what computeDiscountRate does and how applyDiscount reduces amount.",
      targets: [{ path: "src/pricing.ts" }],
      content: "auto",
      task: { epoch: "new", profile: "answer" },
      budget: { bytes: 60000 },
      cwd: ws,
    });

    expect(pick(body, "decision.kind"), JSON.stringify(body)).toBe("act.answer");
  });

  // ---------------------------------------------------------------------
  // 5. GENUINELY partial serve — a real `content_completeness:"partial"`
  //    surface with non-empty `remaining` (a caller-ranged request the
  //    budget could not fully honor), never the "explicit range delivered
  //    in full" shape that `proveUnbindableRequestItem`'s OWN pre-existing
  //    `candidateFullyServed` shortcut already treats as settled for
  //    unrelated reasons (verified empirically: an untrimmed explicit-range
  //    slice, however narrow, lets that DIFFERENT, pre-existing mechanism
  //    independently reach "proved" via its own absence-veto side effect —
  //    confirmed via this file's own TL_TRACE reason strings while proving
  //    this test out, so it is not a usable oracle for THIS fix). Here the
  //    requested 700-900 window does not fit the byte budget, so its tail
  //    (831-900 on 2026-09-27) is genuinely undelivered. (It used to be
  //    700-850; once the pack's fixed metadata shrank, that whole window fit
  //    the same budget and the partial shape this case needs was gone.) The naming concern also carries a
  //    DISTINCT topic term ("ledger") whose content — repeated, non-code
  //    comment mentions, never a code-position occurrence, so the
  //    pre-existing anchor's `literalCodeAnchor` route does not apply
  //    either — IS evidenced in the delivered part of the window ->
  //    request-item:ri-1 is covered even though bigModule.ts is not served
  //    whole. The OVERALL decision still legitimately asks for the missing
  //    tail (a separate, unrelated delivery-completeness gap this
  //    fix does not touch), so the oracle here is the request-item STATUS
  //    itself (TL_TRACE), not `decision.kind`.
  // ---------------------------------------------------------------------
  it("named file served only PARTLY, but another topic term of the SAME concern is content-evidenced -> the concern itself is covered", async () => {
    const ws = mkWs("partial-covered");
    const lines: string[] = ["// bigModule.ts -- a large module with many independent sections"];
    for (let i = 0; i < 800; i += 1) lines.push(`const padding${i} = ${i};`);
    lines.push(
      "// This section walks the ledger once per batch.",
      "// The ledger totals are reconciled here, one entry at a time.",
      "function internalHelper42(x: number): number {",
      "  return x + 1;",
      "}",
    );
    for (let i = 800; i < 1000; i += 1) lines.push(`const tailPadding${i} = ${i};`);
    writeFile(ws, "bigModule.ts", lines.join("\n") + "\n");
    writeFile(ws, "package.json", JSON.stringify({ name: "fixture", version: "0.0.0" }) + "\n");

    setTraceEnabledForTest(true);
    const body = await callWire("read_file", {
      query: "Explain what bigModule.ts's ledger handling does and how internalHelper42 returns its result.",
      targets: [{ path: "bigModule.ts", range: "700-900" }],
      content: "auto",
      task: { epoch: "new", profile: "answer" },
      budget: { bytes: 6200 },
      cwd: ws,
    });

    const evidence = (body["evidence"] as Array<Record<string, unknown>>) ?? [];
    const surface = evidence.find((e) => e["path"] === "bigModule.ts");
    expect(surface, JSON.stringify(body)).toBeDefined();
    // Confirms this really is the genuinely-partial shape the comment above
    // requires, not an untrimmed "exactly what was asked for" slice.
    expect(surface?.["remaining"], JSON.stringify(surface)).toBeDefined();
    expect(typeof surface?.["body"]).toBe("string");
    expect((surface?.["body"] as string).includes("ledger")).toBe(true);

    const status = finalStatusFor(ws, "Explain what bigModule.ts's ledger handling does");
    expect(status, JSON.stringify(readTraceRecords(ws))).toBeDefined();
    expect(status?.["status"]).toBe("covered");
  });

  // ---------------------------------------------------------------------
  // 6. Genuine partial serve, naming term ONLY (no other topic term's
  //    content anywhere in the workspace, so nothing else can concentrate)
  //    -> stays OPEN, with a `next`/remaining aimed at this same file.
  // ---------------------------------------------------------------------
  it("named file served only PARTLY with nothing else to concentrate on -> stays open, never falsely covered", async () => {
    const ws = mkWs("partial-open");
    const lines: string[] = ["// bigModuleB.ts -- a large module with many independent sections"];
    for (let i = 0; i < 1000; i += 1) lines.push(`const padding${i} = ${i};`);
    writeFile(ws, "bigModuleB.ts", lines.join("\n") + "\n");
    writeFile(ws, "calc2.ts", ["// calc2.ts -- one helper", "export function addTwo(a: number, b: number): number {", "  return a + b;", "}", ""].join("\n"));
    writeFile(ws, "package.json", JSON.stringify({ name: "fixture", version: "0.0.0" }) + "\n");

    setTraceEnabledForTest(true);
    const body = await callWire("read_file", {
      query: "Explain what bigModuleB.ts's ledger handling does and how addTwo combines two numbers.",
      targets: [{ path: "bigModuleB.ts" }, { path: "calc2.ts" }],
      content: "auto",
      task: { epoch: "new", profile: "answer" },
      budget: { bytes: 6200 },
      cwd: ws,
    });

    // Never a false certification: no fabricated "covered" for a concern
    // whose named file was only partly served with nothing else to answer
    // it — the overall pack must not reach act.answer on the strength of a
    // naming-only match against an incomplete serve.
    expect(pick(body, "decision.kind"), JSON.stringify(body)).not.toBe("act.answer");
    const status = finalStatusFor(ws, "Explain what bigModuleB.ts");
    expect(status, JSON.stringify(readTraceRecords(ws))).toBeDefined();
    expect(status?.["status"]).toBe("open");
    expect(String(status?.["reason"])).toMatch(/only partly served/);
  });

  // ---------------------------------------------------------------------
  // 7 & 8. Recall controls: FIX-C2's closed false anchor must stay closed.
  // A bare directory name, and an extension-less word that merely equals a
  // path's own stem, must never be treated as NAMING that surface by this
  // fix's own policy route — whatever a DIFFERENT, pre-existing
  // `proveUnbindableRequestItem` fallback separately does with them (an
  // unrelated code path this fix does not touch) is asserted here only to
  // confirm this fix contributes nothing to it (a distinct, non-"covered"
  // TL_TRACE reason).
  // ---------------------------------------------------------------------
  it("a bare directory name is NOT treated as naming a file inside it", async () => {
    const ws = mkWs("dirname");
    writeFile(
      ws,
      "src/auth/tokenCheck.ts",
      ["// tokenCheck.ts -- verifies a bearer token", "export function checkToken(value: string): boolean {", "  return value.length > 0;", "}", ""].join("\n"),
    );
    writeFile(ws, "package.json", JSON.stringify({ name: "fixture", version: "0.0.0" }) + "\n");

    setTraceEnabledForTest(true);
    await callWire("read_file", {
      query: "Explain what auth does and how checkToken validates a value.",
      targets: [{ path: "src/auth/tokenCheck.ts" }],
      content: "auto",
      task: { epoch: "new", profile: "answer" },
      budget: { bytes: 60000 },
      cwd: ws,
    });

    const status = finalStatusFor(ws, "Explain what auth does");
    expect(status, JSON.stringify(readTraceRecords(ws))).toBeDefined();
    // Never THIS fix's own coverage reason (the anchor / named-artefact
    // route) — whatever status it lands on comes from a different mechanism.
    expect(String(status?.["reason"])).not.toMatch(/served surface (?:carries|already contains)/);
  });

  it("an extension-less word that merely equals a file's own basename stem is NOT treated as naming it", async () => {
    const ws = mkWs("extless");
    writeFile(
      ws,
      "src/pricing.ts",
      [
        "// pricing.ts -- discount helpers",
        "export interface TierRates { gold: number; silver: number; }",
        "export function computeDiscountRate(tier: string, rates: TierRates): number {",
        '  if (tier === "gold") return rates.gold;',
        '  if (tier === "silver") return rates.silver;',
        "  return 0;",
        "}",
        "export function applyDiscount(amount: number, rate: number): number {",
        "  return amount - amount * rate;",
        "}",
        "",
      ].join("\n"),
    );
    writeFile(ws, "package.json", JSON.stringify({ name: "fixture", version: "0.0.0" }) + "\n");

    setTraceEnabledForTest(true);
    await callWire("read_file", {
      query: "Explain what pricing does and how applyDiscount reduces amount.",
      targets: [{ path: "src/pricing.ts" }],
      content: "auto",
      task: { epoch: "new", profile: "answer" },
      budget: { bytes: 60000 },
      cwd: ws,
    });

    const status = finalStatusFor(ws, "Explain what pricing does");
    expect(status, JSON.stringify(readTraceRecords(ws))).toBeDefined();
    expect(String(status?.["reason"])).not.toMatch(/served surface (?:carries|already contains)/);
  });
});
