/**
 * evaluation0929.nearMissIdentifier.spec.ts — WP-N (eval-0929 §8, 2026-09-29).
 *
 * DEFECT (pre-existing in v0.14.4, byte-identical on the wave's working tree
 * before this fix): a query naming an identifier X that exists only inside a
 * LONGER identifier (`X_V2`, `X_MS`, `APP_X`, `XLimit`) certified `act.answer`
 * with `identifier:X` and X's value facet proved and NO gap. Two false arms on
 * the measured repro (two prose docs saying only `X_V2`): the seeded re-pack's
 * verified-absence scan proved `identifier:X` with nothing on the certificate
 * to say so, and the value facet resolved its focal through X's own words
 * (`MAX_QUOTA_UNITS` → "quota" → `checkQuota`) and certified an unrelated body
 * as the value. Near-miss matchers fed several more arms (a mention site to
 * read, a definition owner to inject, a callable that "reads" X, an anchor
 * line, a request-item candidate).
 *
 * RULES (brief WP-N):
 *  1. An explicit identifier is evidenced only by a WHOLE-identifier occurrence
 *     (boundaries outside `[A-Za-z0-9_$]`); a near-miss is never evidence, a
 *     declaration or a value.
 *  2. With no whole occurrence, `act.answer` discloses
 *     `explicit-gap:request-item-absent:X`, its value/condition/callers facets
 *     are disclosed (never covered), no hop claims a value, and the rest of the
 *     question is still answered with its body.
 *  3. When X DOES occur whole, nothing changes (controls below).
 *
 * Fresh names and values (never the evaluation's or the repro's). One spawned
 * dev server per chain, killed in `afterEach`; workspaces under a short HOME
 * dir, removed in `afterAll`.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  containsWholeIdentifier,
  nearMissIdentifiersIn,
  wholeIdentifierOffsets,
} from "../features/task-pack/wholeIdentifier.js";
import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import {
  startDevServer,
  followNextToEnd,
  extractNext,
  finalDecisionKind,
  type ChainResult,
  type Hop,
  type ServerHandle,
} from "./helpers/qualityFirstScenarios.js";

// ---------------------------------------------------------------------------
// 1. Unit: the one definition of an occurrence (wholeIdentifier.ts).
// ---------------------------------------------------------------------------

const NAME = "LEDGER_FLUSH_LIMIT";

describe("wholeIdentifier — a whole occurrence in every language and file kind", () => {
  const whole: ReadonlyArray<readonly [string, string]> = [
    ["TypeScript const", `export const ${NAME} = 2963;`],
    ["TypeScript use", `  return ${NAME} - used;`],
    ["Python", `${NAME} = 2963`],
    ["Go const", `const ${NAME} = 2963`],
    ["Go qualified use", `budget := limits.${NAME} - used`],
    ["Java", `static final int ${NAME} = 2963;`],
    ["Kotlin", `const val ${NAME} = 2963`],
    ["C#", `public const int ${NAME} = 2963;`],
    ["Rust", `pub const ${NAME}: u32 = 2963;`],
    ["C/C++ macro", `#define ${NAME} 2963`],
    ["YAML key", `${NAME}: 2963`],
    ["env file", `${NAME}=2963`],
    ["shell reference", `echo "$${NAME}"`],
    ["shell braced reference", `echo "\${${NAME}}"`],
    ["prose", `Raise the ${NAME} knob only during a drain.`],
    ["string key", `const key = "${NAME}";`],
  ];
  for (const [label, text] of whole) {
    it(`${label}: ${JSON.stringify(text)} names ${NAME}`, () => {
      expect(containsWholeIdentifier(text, NAME)).toBe(true);
    });
  }

  const nearMiss: ReadonlyArray<readonly [string, string, string]> = [
    ["suffix _V2", `export const ${NAME}_V2 = 5827;`, `${NAME}_V2`],
    ["suffix _MS", `${NAME}_MS = 5827`, `${NAME}_MS`],
    ["prefix APP_", `const APP_${NAME} = 5827`, `APP_${NAME}`],
    ["digit suffix", `#define ${NAME}2 5827`, `${NAME}2`],
    ["glued $ (a$X)", `var a$${NAME} = 1;`, `a$${NAME}`],
    ["trailing $ (X$)", `const ${NAME}$ = stream;`, `${NAME}$`],
  ];
  for (const [label, text, longer] of nearMiss) {
    it(`${label}: ${JSON.stringify(text)} is a near-miss, never ${NAME}`, () => {
      expect(containsWholeIdentifier(text, NAME)).toBe(false);
      expect(nearMissIdentifiersIn(text, NAME)).toEqual([longer]);
    });
  }

  it("camelCase humps are no boundary for an explicit identifier (XLimit, maxX)", () => {
    expect(containsWholeIdentifier("const flushLimitOverride = 5827;", "flushLimit")).toBe(false);
    expect(containsWholeIdentifier("return maxFlushLimit;", "FlushLimit")).toBe(false);
    expect(nearMissIdentifiersIn("const flushLimitOverride = 5827;", "flushLimit")).toEqual(["flushLimitOverride"]);
  });

  it("a line holding both: the whole occurrence is found even after a near-miss", () => {
    const line = `export const ${NAME}_V2 = ${NAME} + 1;`;
    expect(containsWholeIdentifier(line, NAME)).toBe(true);
    expect(wholeIdentifierOffsets(line, NAME)).toEqual([line.lastIndexOf(NAME)]);
    expect(nearMissIdentifiersIn(line, NAME)).toEqual([`${NAME}_V2`]);
  });

  it("case-insensitive option keeps the boundaries (a prose heading may spell the name in any case)", () => {
    expect(containsWholeIdentifier("# Ledger flush contract", "CONTRACT", { caseInsensitive: true })).toBe(true);
    expect(containsWholeIdentifier("# Ledger flush contracts", "CONTRACT", { caseInsensitive: true })).toBe(false);
    expect(containsWholeIdentifier("# Ledger flush contract", "CONTRACT")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. End to end on a spawned dev server.
// ---------------------------------------------------------------------------

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

type Shape = "docs" | "code" | "comment" | "docsCode" | "exact" | "both" | "docsExact" | "alias";

interface FixtureOptions {
  readonly shape: Shape;
  readonly id?: string;
  readonly near?: string;
  /** An unrelated same-name `validateLease` in another file (eval §8's decoy variant). */
  readonly decoy?: boolean;
}

/** `src/lease.ts` (padded; `validateLease` is the real symbol), 12 route files calling it, and the near-miss/exact name in the shape's place. */
function leaseFiles(opts: FixtureOptions): Record<string, string> {
  const id = opts.id ?? NAME;
  const near = opts.near ?? `${id}_V2`;
  const files: Record<string, string> = { "package.json": "{\n  \"name\": \"lease\",\n  \"private\": true,\n  \"type\": \"module\"\n}\n" };
  const helpers: string[] = [];
  for (let i = 1; i <= 16; i++) helpers.push(`export function leaseHelper${i}(input: string): string {`, `  return input.trim() + "-${i}";`, "}", "");
  files["src/lease.ts"] = [
    "export interface Lease { holder: string; expiresAt: number }",
    "",
    ...helpers,
    "export function validateLease(lease: Lease, now: number): boolean {",
    "  if (typeof lease.expiresAt !== \"number\") { return false; }",
    "  if (lease.expiresAt <= now) { return false; }",
    "  return lease.holder.length > 0;",
    "}",
    "",
  ].join("\n");
  for (let i = 1; i <= 12; i++) {
    files[`src/routes/r${i}.ts`] = [
      "import { validateLease, type Lease } from \"../lease.js\";",
      "",
      ...Array.from({ length: 6 }, (_, k) => `export function route${i}_${k}(x: string): string { return x + "${i}${k}"; }`),
      "",
      `export function guard${i}(lease: Lease, now: number): boolean { return validateLease(lease, now); }`,
      "",
    ].join("\n");
  }
  // Doc prose deliberately carries no facet vocabulary ("value", "limit"…):
  // this file is about the IDENTIFIER, not WP-C3's descriptor candidates.
  const docName = opts.shape === "docsExact" ? id : near;
  if (opts.shape === "docs" || opts.shape === "docsCode" || opts.shape === "docsExact") {
    files["docs/runbook.md"] = ["# Runbook", "", `Raise ${docName} only during a backlog drain; see the retro.`, ""].join("\n");
    files["docs/retro.md"] = ["# Retro", "", `We lowered ${docName} after the second incident.`, ""].join("\n");
  }
  if (opts.shape === "code" || opts.shape === "docsCode") {
    files["src/flush.ts"] = [`export const ${near} = 5827;`, `export function flushBudget(used: number): number { return ${near} - used; }`, ""].join("\n");
  }
  if (opts.shape === "comment") {
    files["src/flush.ts"] = [`// ${near} bounds a flush batch (documented here only).`, "export function flushBudget(used: number): number { return 5827 - used; }", ""].join("\n");
  }
  if (opts.shape === "exact") {
    files["src/flush.ts"] = [`export const ${id} = 2963;`, `export function flushBudget(used: number): number { return ${id} - used; }`, ""].join("\n");
  }
  if (opts.shape === "both") {
    files["src/flush.ts"] = [`export const ${near} = 5827;`, `export const ${id} = 2963;`, `export function flushBudget(used: number): number { return ${id} - used; }`, ""].join("\n");
  }
  if (opts.shape === "alias") {
    // X exists WHOLE, but only as the local alias of X_V2 (eval §8: "import 名を as で別名にする").
    files["src/limits.ts"] = [`export const ${near} = 5827;`, ""].join("\n");
    files["src/flush.ts"] = [`import { ${near} as ${id} } from "./limits.js";`, `export function flushBudget(used: number): number { return ${id} - used; }`, ""].join("\n");
  }
  if (opts.decoy === true) {
    files["src/legacy/lease.ts"] = ["export function validateLease(): boolean {", "  return true;", "}", ""].join("\n");
  }
  return files;
}

function workspace(files: Record<string, string>): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, ".tl-e0929-nearmiss-"));
  tmpDirs.push(ws);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), content, "utf8");
  }
  return ws;
}

async function server(ws: string): Promise<ServerHandle> {
  const handle = startDevServer(ws, "default");
  servers.push(handle);
  await handle.initialize();
  return handle;
}

/** Follows the SERVER's own `next` only (no harness-level qref re-pack), hop cap 8. */
async function chain(ws: string, query: string, extra: Record<string, unknown> = {}): Promise<ChainResult> {
  const srv = await server(ws);
  return followNextToEnd(
    srv,
    { tool: "tl_read_file", arguments: { query, cwd: ws, task: { epoch: "new", profile: "answer" }, ...extra } },
    { cwd: ws, hopCap: 8, maxQrefRepacks: 0 },
  );
}

const EN2 = (id: string): string => `Explain how validateLease decides a lease has expired. Also, what is the value of ${id}?`;
const JA2 = (id: string): string => `validateLease が期限切れを判定する仕組みを説明してください。${id} の値も教えてください。`;

function certificateOf(hop: Hop): { obligations: string[]; gaps: string[] } {
  const certificate = hop.response?.decision?.certificate ?? {};
  return { obligations: certificate.obligations ?? [], gaps: certificate.gaps ?? [] };
}

function servedBodies(result: ChainResult): string {
  return result.hops.flatMap((hop) => (hop.response?.evidence ?? []).map((row: { body?: string }) => row.body ?? "")).join("\n");
}

/** Every hop's call, minus its per-hop routing fields, is unique: no `next` repeats. */
function assertTerminatesWithoutRepeat(result: ChainResult): void {
  expect(result.capped, `chain did not settle within 8 hops: ${JSON.stringify(result.hops.map((hop) => hop.call))}`).toBe(false);
  const seen = new Set<string>();
  for (const hop of result.hops) {
    const { cwd: _cwd, task: _task, ...rest } = hop.call.arguments;
    const signature = JSON.stringify({ tool: hop.call.tool, arguments: rest });
    expect(seen.has(signature), `a later hop repeated an earlier call: ${signature}`).toBe(false);
    seen.add(signature);
  }
}

/** Files that hold the near-miss but never the name itself — never a place to read for X (rule 1). */
function nearMissOnlyFiles(files: Record<string, string>, id: string, near: string): string[] {
  return Object.entries(files)
    .filter(([, content]) => content.includes(near) && !containsWholeIdentifier(content, id))
    .map(([rel]) => rel);
}

type NameFacet = "value" | "condition" | "callers";

function assertNearMissDisclosed(
  result: ChainResult,
  files: Record<string, string>,
  id: string,
  near: string,
  focalAsked: boolean,
  /** The facets these questions ask OF X (a facet of the real symbol is legitimately covered). */
  nameFacets: readonly NameFacet[] = ["value"],
): void {
  assertTerminatesWithoutRepeat(result);
  expect(finalDecisionKind(result), JSON.stringify(result.final).slice(0, 1500)).toBe("act.answer");
  const acts = result.hops.filter((hop) => hop.response?.decision?.kind === "act.answer");
  for (const hop of acts) {
    const { obligations, gaps } = certificateOf(hop);
    // Rule 2: the absent name is disclosed on every certified hop …
    expect(gaps.some((gap) => gap.startsWith(`explicit-gap:request-item-absent:${id} `)), JSON.stringify(gaps)).toBe(true);
    // … every facet asked OF X is disclosed naming X — never covered, never
    // "verified empty" (an absent subject has no value to be empty and no
    // call sites to count). A facet of the real symbol ("判定する" /
    // "decides" → condition) is legitimately covered and not checked here.
    for (const facet of nameFacets) {
      if (!obligations.some((obligation) => new RegExp(`^request-item:facet-\\d+:${facet}$`, "u").test(obligation))) continue;
      expect(
        gaps.some((gap) => new RegExp(`^explicit-gap:request-item-(undetermined|absent):${facet}:`, "u").test(gap) && gap.includes(id)),
        `X's ${facet} facet certified without a disclosure naming ${id}: ${JSON.stringify(gaps)}`,
      ).toBe(true);
      expect(gaps.some((gap) => gap.startsWith(`explicit-gap:request-item-empty:${facet}:`) && gap.includes(id)), JSON.stringify(gaps)).toBe(false);
    }
    // … and the near-miss is advisory at most: never an obligation, never the disclosed name.
    expect(obligations).not.toContain(`identifier:${near}`);
    expect(gaps.some((gap) => gap.includes(`request-item-absent:${near}`))).toBe(false);
  }
  // Rule 1: no hop is sent to read a file that holds only the near-miss.
  const forbidden = nearMissOnlyFiles(files, id, near);
  for (const hop of result.hops.slice(1)) {
    const text = JSON.stringify(hop.call.arguments);
    for (const rel of forbidden) expect(text, `hop ${hop.hopIndex} reads near-miss-only ${rel}`).not.toContain(rel);
  }
  // The rest of the question is still answered with its body.
  if (focalAsked) expect(servedBodies(result)).toContain("function validateLease(");
}

describe("WP-N end to end: a name that exists only inside a longer identifier is disclosed absent, never certified", () => {
  const cases: ReadonlyArray<{ name: string; fx: FixtureOptions; query: string; focal: boolean; extra?: Record<string, unknown>; nameFacets?: readonly NameFacet[] }> = [
    { name: "docs only, X_V2, EN", fx: { shape: "docs" }, query: EN2(NAME), focal: true },
    { name: "docs only, X_V2, JA", fx: { shape: "docs" }, query: JA2(NAME), focal: true },
    { name: "docs only, APP_X prefix, EN", fx: { shape: "docs", near: `APP_${NAME}` }, query: EN2(NAME), focal: true },
    { name: "code only, X_V2, EN", fx: { shape: "code" }, query: EN2(NAME), focal: true },
    { name: "code only, X_MS suffix, EN", fx: { shape: "code", near: `${NAME}_MS` }, query: EN2(NAME), focal: true },
    { name: "code only, APP_X prefix, JA", fx: { shape: "code", near: `APP_${NAME}` }, query: JA2(NAME), focal: true },
    { name: "code comment only, X_V2, EN", fx: { shape: "comment" }, query: EN2(NAME), focal: true },
    { name: "code comment only, APP_X, EN", fx: { shape: "comment", near: `APP_${NAME}` }, query: EN2(NAME), focal: true },
    { name: "docs + code, X_V2, EN", fx: { shape: "docsCode" }, query: EN2(NAME), focal: true },
    { name: "docs + code, X_MS, JA", fx: { shape: "docsCode", near: `${NAME}_MS` }, query: JA2(NAME), focal: true },
    { name: "camelCase XLimit near-miss, EN", fx: { shape: "code", id: "flushLimit", near: "flushLimitOverride" }, query: EN2("flushLimit"), focal: true },
    { name: "asked alone (no second symbol), code, EN", fx: { shape: "code" }, query: `What is the value of ${NAME}?`, focal: false },
    { name: "asked alone (no second symbol), docs, JA", fx: { shape: "docs" }, query: `${NAME} の値を教えてください。`, focal: false },
    { name: "a file path in the question, code, EN", fx: { shape: "code" }, query: `In src/lease.ts, explain how validateLease decides a lease has expired, and give the value of ${NAME}.`, focal: true },
    { name: "bullets, code, EN", fx: { shape: "code" }, query: `Explain the lease module:\n- How validateLease decides a lease has expired\n- The value of ${NAME}`, focal: true },
    { name: "small budget with continuation, code, EN", fx: { shape: "code" }, query: EN2(NAME), focal: true, extra: { budget: { bytes: 6144 } } },
    // An unrelated same-name `validateLease` elsewhere: X's disclosure must not
    // depend on which declaration of the OTHER symbol the pack settles on.
    // (`focal: false` — whether a same-name decoy leaves validateLease's own
    // body on the wire is a separate, pre-existing question, reported outside
    // this package; this case pins only the X invariants.)
    { name: "an unrelated same-name function added, code, EN", fx: { shape: "code", decoy: true }, query: EN2(NAME), focal: false },
    // Rule 2's other facets: callers / condition asked of the absent name.
    { name: "callers facet of the absent name, code, EN", fx: { shape: "code" }, query: `Who calls ${NAME}? Also explain how validateLease decides a lease has expired.`, focal: true, nameFacets: ["callers"] },
    { name: "callers facet of the absent name, docs, JA", fx: { shape: "docs" }, query: `${NAME} の呼び出し元と、validateLease の期限切れ判定を説明してください。`, focal: true, nameFacets: ["callers"] },
    { name: "condition facet of the absent name, code, EN", fx: { shape: "code" }, query: `Under which conditions is ${NAME} applied, and how does validateLease decide expiry?`, focal: true, nameFacets: ["condition"] },
  ];
  for (const testCase of cases) {
    it(testCase.name, async () => {
      const id = testCase.fx.id ?? NAME;
      const near = testCase.fx.near ?? `${id}_V2`;
      const files = leaseFiles(testCase.fx);
      const ws = workspace(files);
      const result = await chain(ws, testCase.query, testCase.extra ?? {});
      assertNearMissDisclosed(result, files, id, near, testCase.focal, testCase.nameFacets ?? ["value"]);
    }, 60_000);
  }
});

describe("WP-N recall controls (rule 3): a name that occurs WHOLE keeps today's behaviour", () => {
  for (const [label, query] of [["EN", EN2(NAME)], ["JA", JA2(NAME)]] as const) {
    it(`X declared in code (${label}): its own value is served and the value facet is covered, nothing disclosed absent`, async () => {
      const ws = workspace(leaseFiles({ shape: "exact" }));
      const result = await chain(ws, query);
      assertTerminatesWithoutRepeat(result);
      expect(finalDecisionKind(result)).toBe("act.answer");
      const { gaps } = certificateOf(result.hops[result.hops.length - 1]!);
      expect(gaps.some((gap) => gap.includes(`request-item-absent:${NAME}`)), JSON.stringify(gaps)).toBe(false);
      expect(gaps.some((gap) => /request-item-(undetermined|empty):value/u.test(gap)), JSON.stringify(gaps)).toBe(false);
      expect(servedBodies(result)).toContain(`${NAME} = 2963`);
      expect(servedBodies(result)).toContain("function validateLease(");
    }, 60_000);

    it(`X and X_V2 both declared (${label}): X's own value is served — the certificate never rests on X_V2 alone`, async () => {
      const ws = workspace(leaseFiles({ shape: "both" }));
      const result = await chain(ws, query);
      assertTerminatesWithoutRepeat(result);
      expect(finalDecisionKind(result)).toBe("act.answer");
      const { gaps } = certificateOf(result.hops[result.hops.length - 1]!);
      expect(gaps.some((gap) => gap.includes(`request-item-absent:${NAME}`)), JSON.stringify(gaps)).toBe(false);
      expect(servedBodies(result)).toMatch(new RegExp(`(?<![A-Za-z0-9_$])${NAME} = 2963`, "u"));
    }, 60_000);
  }

  it("X exists whole only as an `as` alias of X_V2: never certified absent, and the aliased value is served or its facet disclosed", async () => {
    const ws = workspace(leaseFiles({ shape: "alias" }));
    const result = await chain(ws, EN2(NAME));
    assertTerminatesWithoutRepeat(result);
    const everything = JSON.stringify(result.hops.map((hop) => hop.response));
    expect(everything).not.toContain(`request-item-absent:${NAME}`);
    if (finalDecisionKind(result) === "act.answer") {
      const { gaps } = certificateOf(result.hops[result.hops.length - 1]!);
      const disclosed = gaps.some((gap) => /^explicit-gap:request-item-undetermined:value:/u.test(gap));
      expect(disclosed || servedBodies(result).includes(`${NAME}_V2 = 5827`), JSON.stringify(gaps)).toBe(true);
    }
  }, 60_000);

  it("X written whole only in prose docs: never certified absent (it occurs), and the chain still terminates", async () => {
    const ws = workspace(leaseFiles({ shape: "docsExact" }));
    const result = await chain(ws, EN2(NAME));
    assertTerminatesWithoutRepeat(result);
    expect(JSON.stringify(result.hops.map((hop) => hop.response))).not.toContain(`request-item-absent:${NAME}`);
  }, 60_000);
});

describe("WP-N mid-chain edit (the WP-M chip shape): a mention rewritten to the near-miss never certifies the name", () => {
  it("one of two whole mentions is edited to X_V2 before it is read: the other still names X, so X is never absent — and never certified", async () => {
    const ws = workspace(leaseFiles({ shape: "docsExact" }));
    const srv = await server(ws);
    const hops: unknown[] = [];
    let call: { tool: string; arguments: Record<string, unknown> } | undefined = {
      tool: "tl_read_file",
      arguments: { query: JA2(NAME), cwd: ws, task: { epoch: "new", profile: "answer" } },
    };
    let mutated = false;
    for (let hop = 0; hop < 8 && call !== undefined; hop++) {
      const target = (call.arguments["targets"] as Array<{ path?: string }> | undefined)?.[0]?.path;
      if (!mutated && typeof target === "string" && target.startsWith("docs/")) {
        const abs = path.join(ws, target);
        fs.writeFileSync(abs, fs.readFileSync(abs, "utf8").replace(NAME, `${NAME}_V2`));
        mutated = true;
      }
      const { body } = await srv.callTool(call.tool, call.arguments);
      hops.push(body);
      call = extractNext(body).next;
    }
    expect(call, "chain did not settle within 8 hops").toBeUndefined();
    const text = JSON.stringify(hops);
    expect(text).not.toContain(`request-item-absent:${NAME}`);
    // X still occurs whole, but only in prose: no served surface can PROVE it
    // (a mention is not a declaration) and it is not absent — so no certified
    // hop may list `identifier:X` as satisfied. Before the fix the seeded
    // re-pack of the edited doc did exactly that, off a code-only substring
    // scan that never looked at the other doc.
    for (const body of hops as Array<{ decision?: { kind?: string; certificate?: { obligations?: string[] } } }>) {
      if (body.decision?.kind !== "act.answer") continue;
      expect(body.decision.certificate?.obligations ?? [], JSON.stringify(body.decision)).not.toContain(`identifier:${NAME}`);
    }
  }, 60_000);
});
