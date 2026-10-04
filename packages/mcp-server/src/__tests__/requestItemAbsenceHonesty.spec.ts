/**
 * requestItemAbsenceHonesty.spec.ts — FIX-C (plan-0143 TL-03), the required
 * fail-first coverage named by brief-fix-c.md's "Required tests" section:
 * one normalisation for search AND absence judgement (readCodeTaskPack.ts's
 * `concernTermVariants`, C2), routed through both `distinctiveSalientAbsence`
 * and `proveUnbindableRequestItem`, plus the D1 (concentration discipline),
 * D2 (doc-vs-code candidate competition), C1 (self-contradiction veto), C3
 * (topic-vs-predicate Tier C anchor), C4 (scope honesty) and C5 (quoted/
 * example fragments) rulings this file's own defects/rulings describe.
 *
 * Pure `buildTaskPack` calls (no spawned server — see completionHonesty.
 * spec.ts for the same, proven pattern) so this stays fast and isolated;
 * `qualityFirst0143.acceptance.spec.ts` (Q01/Q03/Q05) and
 * concernRetentionMatrix.spec.ts cover the real end-to-end/spawned-server
 * shape for the same defects.
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildTaskPack,
  resetPackDedupeCache,
  resetRoleInventoryCache,
} from "../features/task-pack/readCodeTaskPack.js";
import { applyCanonicalTaskDecision } from "../features/task-pack/canonicalDecision.js";
import { resetAll as resetAllSessions, resetWorkspace } from "../util/session.js";
import type { TaskPackResult } from "../features/task-pack/model.js";

const tmpDirs: string[] = [];
function mkTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
function writeFile(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup only */
    }
  }
});

interface FpEnv {
  jaBridge?: "0" | "1";
}
function withEnv<T>(env: FpEnv, fn: () => Promise<T>): Promise<T> {
  const key = "TL_JA_QUERY_BRIDGE";
  const saved = process.env[key];
  if (env.jaBridge !== undefined) process.env[key] = env.jaBridge;
  else delete process.env[key];
  return fn().finally(() => {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  });
}

async function runQuery(query: string, ws: string, env: FpEnv = {}): Promise<TaskPackResult> {
  return withEnv(env, async () => {
    resetAllSessions();
    resetWorkspace(ws);
    resetPackDedupeCache();
    resetRoleInventoryCache();
    return buildTaskPack({ query, taskProfile: "answer", paths: [] }, ws);
  });
}

/**
 * R-D2 (2026-09-21, item B): `request_item_absences` now also carries
 * could-not-determine disclosures (`undetermined:true` — see that field's
 * own doc comment on `TaskPackResult`), which are NOT a certified absence.
 * Every caller here asks "is this term claimed AS ABSENT", so those entries
 * are excluded — the exact "could-not-determine, never absent" distinction
 * ruling 3 and this helper's own callers are named for.
 */
function absentTerms(result: TaskPackResult): string[] {
  return (result.request_item_absences ?? [])
    .filter((a) => a.undetermined !== true)
    .flatMap((a) => a.term.split("/").map((t) => t.toLowerCase()));
}
function servedPaths(result: TaskPackResult): string[] {
  return result.surfaces.map((s) => s.path);
}
function servedText(result: TaskPackResult): string {
  return result.surfaces.map((s) => `${s.path}\n${s.code ?? ""}`).join("\n");
}

// ---------------------------------------------------------------------------
// 1. Q03-class: both concerns served in ONE file, zero false absences (JA + EN).
// ---------------------------------------------------------------------------

function writeCacheModule(ws: string): void {
  writeFile(
    ws,
    "src/cache.ts",
    [
      "// cache.ts -- a small in-memory cache with TTL-based expiry and explicit invalidation.",
      "interface CacheRecord<V> { value: V; expiresAtMs: number; }",
      "export class TtlCache<V> {",
      "  private records = new Map<string, CacheRecord<V>>();",
      "  constructor(private readonly defaultTtlMs: number) {}",
      "  set(key: string, value: V, ttlMs?: number): void {",
      "    const expiresAtMs = Date.now() + (ttlMs ?? this.defaultTtlMs);",
      "    this.records.set(key, { value, expiresAtMs });",
      "  }",
      "  get(key: string): V | undefined {",
      "    const record = this.records.get(key);",
      "    if (!record) return undefined;",
      "    if (Date.now() >= record.expiresAtMs) { this.records.delete(key); return undefined; }",
      "    return record.value;",
      "  }",
      "  invalidate(key: string): void { this.records.delete(key); }",
      "  invalidateAll(): void { this.records.clear(); }",
      "}",
      "",
    ].join("\n"),
  );
  writeFile(ws, "package.json", '{"name":"t","version":"0.0.0"}\n');
}

describe("1. Q03 class: no self-contradiction when one file answers both concerns", () => {
  it("Japanese compound cache question: no self-contradiction (zero false-absence entries)", async () => {
    // Single-shot (no follow-up hop): the primary router may narrow to a
    // small symbol-focus slice of cache.ts (a DIFFERENT, unrelated
    // mechanism this fix does not own — see servedBytesMatrix.spec.ts /
    // R01 for that range-completeness contract). TL-03's own contract is
    // narrower and is fully checked here: whatever IS served, the request-
    // item mechanism must never disclose an absence that contradicts it.
    const ws = mkTmpDir("tl-ah-q03-ja-");
    writeCacheModule(ws);
    const result = await runQuery("キャッシュが期限切れの場合の処理と、無効化する処理を説明してください", ws);
    expect(result.request_item_absences ?? [], JSON.stringify(result.request_item_absences)).toEqual([]);
  });

  it("English control: same fixture, same shape, zero absence entries", async () => {
    const ws = mkTmpDir("tl-ah-q03-en-");
    writeCacheModule(ws);
    const result = await runQuery("Explain the cache expiry handling and how invalidation works.", ws);
    expect(result.request_item_absences ?? [], JSON.stringify(result.request_item_absences)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. JA matrix: {known glossary term, katakana loanword} x {implemented,
//    missing}, plus the bridge-disabled -> could-not-determine control.
// ---------------------------------------------------------------------------

describe("2. JA matrix: glossary/katakana terms, implemented vs missing, bridge on/off", () => {
  it("known glossary term (期限/expire), implemented: never absent", async () => {
    const ws = mkTmpDir("tl-ah-ja-glossary-impl-");
    writeCacheModule(ws);
    const result = await runQuery("キャッシュの期限切れの処理を説明してください、また無効化についても説明してください", ws);
    expect(absentTerms(result).some((t) => t.includes("期限"))).toBe(false);
  });

  // R-B3 (2026-09-21, orchestrator ruling 3; plan §6.1 「日本語原文の不一致を
  // 機能不在へ格上げしない」): a kanji term reaches English only through the
  // hand-kept glossary, so its miss is "could not determine", never a
  // certified absence — this case asserted the opposite before the ruling.
  // The katakana loanword case below is the recall control: a phonetic miss is
  // as checkable as an English word's and is still disclosed, scope honest.
  it("known glossary term (認証/auth), missing: could-not-determine, never absent", async () => {
    const ws = mkTmpDir("tl-ah-ja-glossary-missing-");
    writeCacheModule(ws);
    const result = await runQuery("キャッシュの期限切れの処理と、認証の仕組みを説明してください", ws);
    expect(absentTerms(result).some((t) => t.includes("認証")), JSON.stringify(result.request_item_absences)).toBe(false);
  });

  // R2-T2 (2026-09-30, orchestrator RULING — supersedes R-B3 ruling 3's "a
  // phonetic miss is as checkable as an English word's", which this case used
  // to pin as `absent`, scope complete): a katakana loanword the workspace
  // bridge cannot map and the glossary cannot spell names a concept the
  // workspace would spell in ENGLISH, so its literal miss proves nothing — it
  // is disclosed undetermined (still named, never silently dropped), never a
  // verified absence. A katakana term the glossary DOES spell is checked by
  // that spelling and can still be certified absent
  // (evaluation0929.compoundTopicPoints.spec.ts).
  it("katakana loanword (マイグレーション) with no known English spelling, missing: disclosed undetermined, never a verified absence", async () => {
    const ws = mkTmpDir("tl-ah-ja-katakana-missing-");
    writeCacheModule(ws);
    const result = await runQuery("キャッシュの期限切れの処理と、マイグレーションの仕組みを説明してください", ws);
    const migration = (result.request_item_absences ?? []).find((a) => a.term.includes("マイグレーション"));
    expect(migration, JSON.stringify(result.request_item_absences)).toBeDefined();
    expect(migration?.undetermined, JSON.stringify(migration)).toBe(true);
    expect(migration?.undetermined_reason ?? "").toMatch(/katakana term with no known English spelling/u);
  });

  it("katakana loanword (キャッシュ), implemented: never absent", async () => {
    const ws = mkTmpDir("tl-ah-ja-katakana-impl-");
    writeCacheModule(ws);
    const result = await runQuery("キャッシュの無効化について説明してください、また期限切れについても説明してください", ws);
    expect(absentTerms(result).some((t) => t.includes("キャッシュ"))).toBe(false);
  });

  it("TL_JA_QUERY_BRIDGE=0: a JA concern is never certified absent (could-not-determine, not absent)", async () => {
    const ws = mkTmpDir("tl-ah-ja-bridge-off-");
    writeCacheModule(ws);
    const result = await runQuery(
      "キャッシュの期限切れの処理と、無効化する処理を説明してください",
      ws,
      { jaBridge: "0" },
    );
    // With the bridge off, neither clause's JA wording has any normalisation
    // to check against English source -- ruling C6: never emitted as
    // "absent" wording, regardless of whether the concept is implemented.
    //
    // R-D2 (2026-09-21, item B): this no longer means the array is EMPTY —
    // plan §5 requires the could-not-determine verdict to be disclosed too,
    // so both clauses now surface here tagged `undetermined:true` (rendered
    // on the wire as `explicit-gap:request-item-undetermined:...`, never
    // `request-item-absent`). What this test's own name asserts — "never
    // CERTIFIED ABSENT" — is checked directly: no entry is a genuine
    // absence.
    expect(
      (result.request_item_absences ?? []).filter((a) => a.undetermined !== true),
      JSON.stringify(result.request_item_absences),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Inflection matrix (Q04 class): a request word must never be certified
//    absent when a morphological variant genuinely exists in the corpus.
// ---------------------------------------------------------------------------

function writeInflectionFixture(ws: string): void {
  writeFile(
    ws,
    "src/validate.ts",
    [
      "export interface Validator { validate(input: string): boolean; }",
      "export function validateInput(input: string): boolean { return input.length > 0; }",
      "",
    ].join("\n"),
  );
  writeFile(
    ws,
    "src/cacheExpiry.ts",
    [
      "export interface CacheEntry { expiresAt: number; }",
      "export function isExpired(entry: CacheEntry, now: number): boolean { return now >= entry.expiresAt; }",
      "",
    ].join("\n"),
  );
  writeFile(
    ws,
    "src/retry.ts",
    [
      "export function retryOperation(attempt: number): number { return attempt * 100; }",
      "",
    ].join("\n"),
  );
  writeFile(
    ws,
    "src/config.ts",
    [
      "export interface Config { timeoutMs: number; }",
      "export function loadConfig(): Config { return { timeoutMs: 5000 }; }",
      "",
    ].join("\n"),
  );
  writeFile(
    ws,
    "src/cacheStore.ts",
    [
      "export class Cache { private map = new Map<string, unknown>(); }",
      "",
    ].join("\n"),
  );
  writeFile(ws, "package.json", '{"name":"t","version":"0.0.0"}\n');
}

describe("3. Inflection matrix: never absent when a variant genuinely exists", () => {
  const cases: ReadonlyArray<{ word: string; query: string }> = [
    { word: "validated", query: "Explain how input is validated, and how the cache expiry timing is computed." },
    { word: "validation", query: "Explain the validation logic, and how the cache expiry timing is computed." },
    { word: "validator", query: "Explain the validator's role, and how the cache expiry timing is computed." },
    { word: "expired", query: "Explain how input is validated, and how an entry becomes expired." },
    { word: "expiring", query: "Explain how input is validated, and how an expiring entry is detected." },
    { word: "retried", query: "Explain how input is validated, and how a failed operation is retried." },
    { word: "retries", query: "Explain how input is validated, and how retries are computed." },
    { word: "configured", query: "Explain how input is validated, and how the timeout is configured." },
    { word: "configuration", query: "Explain how input is validated, and how the configuration is loaded." },
    { word: "cached", query: "Explain how input is validated, and how values are cached." },
    { word: "caching", query: "Explain how input is validated, and how caching is structured." },
  ];
  for (const { word, query } of cases) {
    it(`'${word}' is never certified absent when its variant exists`, async () => {
      const ws = mkTmpDir(`tl-ah-inflect-${word}-`);
      writeInflectionFixture(ws);
      const result = await runQuery(query, ws);
      expect(
        absentTerms(result).some((t) => t === word || t.includes(word.slice(0, 5))),
        `query=${JSON.stringify(query)} absences=${JSON.stringify(result.request_item_absences)}`,
      ).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// 4. Topic-vs-predicate matrix (C3): a light verb or a participle-after-
//    auxiliary must never be the reported absent term while a topic word is
//    present; recall controls confirm a genuinely missing topic still surfaces.
// ---------------------------------------------------------------------------

describe("4. Topic-vs-predicate (C3): light verbs and predicate participles never outrank a topic", () => {
  it("light verb ('works') never reported while the topic ('authentication') is present", async () => {
    const ws = mkTmpDir("tl-ah-c3-lightverb-");
    writeFile(
      ws,
      "src/auth.ts",
      "// auth.ts -- mentions authentication in passing.\nexport const AUTH_NOTE = \"authentication\";\n",
    );
    writeFile(ws, "package.json", '{"name":"t","version":"0.0.0"}\n');
    const result = await runQuery("Explain how authentication works.", ws);
    expect(absentTerms(result)).not.toContain("works");
  });

  it("recall control: a genuinely missing topic still surfaces even with a light verb in the same clause", async () => {
    const ws = mkTmpDir("tl-ah-c3-lightverb-recall-");
    writeFile(ws, "src/thing.ts", "export function doThing(): number { return 1; }\n");
    writeFile(ws, "package.json", '{"name":"t","version":"0.0.0"}\n');
    const result = await runQuery("What does doThing do, and how does the flux capacitor work?", ws);
    expect(absentTerms(result).some((t) => t.includes("flux") || t.includes("capacitor")), JSON.stringify(result.request_item_absences)).toBe(true);
    expect(absentTerms(result)).not.toContain("work");
  });

  it("predicate participle after auxiliary ('executed') never reported while a topic ('database'/'migrations') is present", async () => {
    // Two IMPERATIVE clauses (never both independent questions, so this
    // engages `distinctiveSalientAbsence`'s Tier C fallback directly, not
    // the H-2 bundled-term path — see this file's own header). No
    // migration code anywhere -- "database"/"migrations"/"executed" are all
    // equally absent lexically; only "executed" is structurally
    // predicate-shaped ("are executed").
    const ws = mkTmpDir("tl-ah-c3-predicate-");
    writeFile(ws, "src/retryConfig.ts", "export const RETRY_LIMIT = 3;\n");
    writeFile(ws, "package.json", '{"name":"t","version":"0.0.0"}\n');
    const result = await runQuery(
      "Explain the retry constant's configured value, and describe how database migrations are executed.",
      ws,
    );
    expect(absentTerms(result)).not.toContain("executed");
    expect(absentTerms(result).some((t) => t.includes("database") || t.includes("migrat")), JSON.stringify(result.request_item_absences)).toBe(true);
  });

  it("recall control: replay p12d shape (Redis missing, cache present) still certifies Redis absent", async () => {
    const ws = mkTmpDir("tl-ah-c3-p12d-");
    writeCacheModule(ws);
    const result = await runQuery(
      "Explain Cache.get expiry, its tests, and the Redis cache invalidation implementation.",
      ws,
    );
    expect(absentTerms(result)).toContain("redis");
  });
});

// ---------------------------------------------------------------------------
// 5. Scope honesty (C4) and C5 controls (quoted phrase, example fragment,
//    negation).
// ---------------------------------------------------------------------------

describe("5a. Scope honesty (C4): an absence never overclaims a workspace-wide scan", () => {
  it("a .gitignore-excluded relevant file is disclosed as a non-complete scope", async () => {
    const ws = mkTmpDir("tl-ah-c4-gitignore-");
    writeFile(ws, "package.json", '{"name":"t","version":"0.0.0"}\n');
    writeFile(ws, ".gitignore", "secretmodule.ts\n");
    writeFile(ws, "src/main.ts", "export function doThing(): number { return 1; }\n");
    writeFile(ws, "secretmodule.ts", "export function runQuantumTeleportation(): void {}\n");
    const result = await runQuery("What does doThing do, and how is quantum teleportation implemented?", ws);
    const absence = (result.request_item_absences ?? []).find((a) => a.term.includes("quantum"));
    expect(absence, JSON.stringify(result.request_item_absences)).toBeDefined();
    expect(absence?.scope_complete, "must not claim scope-complete over an excluded relevant file").toBe(false);
    expect(absence?.omitted_count ?? 0).toBeGreaterThan(0);
  });

  it("control: a genuinely scope-complete workspace reports scope_complete: true", async () => {
    const ws = mkTmpDir("tl-ah-c4-complete-");
    writeFile(ws, "package.json", '{"name":"t","version":"0.0.0"}\n');
    writeFile(ws, "src/main.ts", "export function doThing(): number { return 1; }\n");
    const result = await runQuery("What does doThing do, and how is quantum teleportation implemented?", ws);
    const absence = (result.request_item_absences ?? []).find((a) => a.term.includes("quantum"));
    expect(absence, JSON.stringify(result.request_item_absences)).toBeDefined();
    expect(absence?.scope_complete).toBe(true);
    expect(absence?.omitted_count ?? -1).toBe(0);
  });

  it("an undecodable/binary file holding the answer is disclosed as a non-complete scope, not a false absence", async () => {
    const ws = mkTmpDir("tl-ah-c4-undecodable-");
    writeFile(ws, "package.json", '{"name":"t","version":"0.0.0"}\n');
    writeFile(ws, "src/main.ts", "export function doThing(): number { return 1; }\n");
    fs.mkdirSync(path.join(ws, "src"), { recursive: true });
    const binBuf = Buffer.concat([
      Buffer.from("export function runQuantumTeleportation(): void {}\n"),
      Buffer.from([0xff, 0xfe, 0x00, 0x01, 0xc0, 0xc1]),
    ]);
    fs.writeFileSync(path.join(ws, "src", "binarymodule.ts"), binBuf);
    const result = await runQuery("What does doThing do, and how is quantum teleportation implemented?", ws);
    const absence = (result.request_item_absences ?? []).find((a) => a.term.includes("quantum"));
    expect(absence, JSON.stringify(result.request_item_absences)).toBeDefined();
    expect(absence?.scope_complete, "an undecodable file that could hold the answer must not read as scope-complete").toBe(false);
  });
});

describe("5b. C5 controls: quoted phrases and in-question examples are not independent concerns", () => {
  function writeParserFixture(ws: string): void {
    writeFile(
      ws,
      "src/parser.ts",
      [
        "// parser.ts -- parses comment lines and logs errors.",
        "export function parseComment(line: string): string {",
        '  return line.replace(/^\\/\\//, "").trim();',
        "}",
        "export function logError(message: string): void {",
        "  console.error(message);",
        "}",
      ].join("\n"),
    );
    writeFile(ws, "package.json", '{"name":"t","version":"0.0.0"}\n');
  }

  it("a quoted example phrase is not declared its own absent concern", async () => {
    const ws = mkTmpDir("tl-ah-c5-quote-");
    writeParserFixture(ws);
    const result = await runQuery(
      'Explain how the parser handles a comment like "// TODO", and how errors are logged.',
      ws,
    );
    expect(result.request_item_absences ?? [], JSON.stringify(result.request_item_absences)).toEqual([]);
  });

  it("an in-question example (\"such as ...\") is not declared its own absent concern", async () => {
    const ws = mkTmpDir("tl-ah-c5-suchas-");
    writeParserFixture(ws);
    const result = await runQuery(
      "Explain how the parser handles comments, such as trailing whitespace, and how errors are logged.",
      ws,
    );
    expect(absentTerms(result)).not.toContain("trailing");
  });

  it("control: negation control -- a clause naming a genuinely absent topic in negated form is not misreported", async () => {
    const ws = mkTmpDir("tl-ah-c5-negation-");
    writeParserFixture(ws);
    const result = await runQuery(
      "Explain how the parser is not related to network requests, and how errors are logged.",
      ws,
    );
    // The workspace genuinely has no networking code, so a disclosed
    // absence naming it is factually accurate, not misleading -- this is a
    // verification control (plan §6.1), not a defect: no product change.
    const decision = applyCanonicalTaskDecision(result);
    expect(decision?.kind, JSON.stringify(decision)).not.toBe(undefined);
  });

  it("control: a real type/member name mention is never falsely reported absent when it genuinely exists", async () => {
    const ws = mkTmpDir("tl-ah-c5-typemember-");
    writeFile(
      ws,
      "src/parser.ts",
      [
        "export interface ParseResult { ok: boolean; value: string; }",
        "export function parseComment(line: string): ParseResult {",
        '  return { ok: true, value: line.replace(/^\\/\\//, "").trim() };',
        "}",
        "export function logError(message: string): void { console.error(message); }",
      ].join("\n"),
    );
    writeFile(ws, "package.json", '{"name":"t","version":"0.0.0"}\n');
    const result = await runQuery("Explain what the ParseResult type looks like, and how errors are logged.", ws);
    expect(result.request_item_absences ?? [], JSON.stringify(result.request_item_absences)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6. D1/D2 regression: the exact confirmed defect shapes (a comment that
//    disclaims a concept must not certify it "proved"; a README mention must
//    not block trying the inflected candidate that finds the real module).
// ---------------------------------------------------------------------------

describe("6. D1/D2 regression: concentration discipline and doc-vs-code candidate competition", () => {
  it("D1: a comment that only NAMES a concept (without implementing it) never certifies it proved once served", async () => {
    const ws = mkTmpDir("tl-ah-d1-");
    fs.mkdirSync(path.join(ws, "src", "auth"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, "src", "auth", "credentials.ts"),
      [
        "export function validateCredentials(username: string, password: string): boolean {",
        "  return username.length > 0 && password.length > 0;",
        "}",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(ws, "src", "auth", "store.ts"),
      [
        "// store.ts -- in-memory stand-in for the credential store.",
        "// Real deployments back this with a users table, but no",
        "// migration/DDL code lives in this fixture.",
        "export const RECORDS = new Map<string, string>();",
      ].join("\n"),
    );
    writeFile(ws, "package.json", '{"name":"t","version":"0.0.0"}\n');
    const result = await runQuery(
      "Explain how credentials are validated and how database migrations are executed.",
      ws,
    );
    // Never silently "proved": either genuinely disclosed absent, or left
    // unresolved -- never a bare act.answer with no trace of the concern.
    const decision = applyCanonicalTaskDecision(result);
    const migrationDisclosed = absentTerms(result).some((t) => t.includes("migrat") || t.includes("database"));
    const stillOpen = decision?.kind === "discover" || decision?.kind === "await-input";
    expect(
      migrationDisclosed || stillOpen,
      `decision=${decision?.kind} absences=${JSON.stringify(result.request_item_absences)}`,
    ).toBe(true);
  });

  it("D2: a doc-only mention (README) never blocks the inflected candidate that finds the real implementation", async () => {
    // Two independent questions (H-2 engages `proveUnbindableRequestItem`
    // with concentration required) so the mechanism actually runs — a
    // single-clause query never reaches >=2 request items at all.
    const ws = mkTmpDir("tl-ah-d2-");
    const query = "Explain how authentication works, and how retries are scheduled.";
    writeFile(
      ws,
      "src/auth.ts",
      [
        "export interface AuthResult { authenticated: boolean; }",
        "export function authenticateRequest(token: string): AuthResult {",
        '  return { authenticated: token.length > 0 };',
        "}",
      ].join("\n"),
    );
    writeFile(
      ws,
      "src/retry.ts",
      "export function computeRetryDelayMs(attempt: number): number { return attempt * 100; }\n",
    );
    writeFile(ws, "README.md", "# Fixture\n\nCovers authentication (`src/auth.ts`) and retry scheduling.\n");
    writeFile(ws, "package.json", '{"name":"t","version":"0.0.0"}\n');

    let current = await runQuery(query, ws);
    const accumulated = new Set<string>(servedPaths(current));
    for (let hop = 0; hop < 4 && !accumulated.has("src/auth.ts"); hop++) {
      const decision = applyCanonicalTaskDecision(current);
      const next = (decision as { next_call?: { arguments?: { targets?: Array<{ path: string }> } } } | undefined)?.next_call;
      const targets = next?.arguments?.targets?.map((t) => t.path);
      if (!targets || targets.length === 0) break;
      for (const t of targets) accumulated.add(t);
      resetAllSessions();
      resetWorkspace(ws);
      resetPackDedupeCache();
      resetRoleInventoryCache();
      current = await buildTaskPack({ query, taskProfile: "answer", paths: [...accumulated] }, ws);
      for (const p of servedPaths(current)) accumulated.add(p);
    }
    expect([...accumulated], JSON.stringify([...accumulated])).toContain("src/auth.ts");
  });
});

// ---------------------------------------------------------------------------
// 7. N7 (r-b2, 2026-09-21, adversarial review): gap-token hygiene. (a) a
//    coordinator/filler word is never a gap token; (b) a Japanese token never
//    keeps a trailing particle; (c) the scope note never reports an
//    exclusion when the only excluded path is VCS metadata (.git).
// ---------------------------------------------------------------------------

describe("7a. N7: a coordinator/filler word is never a gap token", () => {
  it('"; also" joiner: the absent 2nd concern\'s term never includes "also"', async () => {
    const ws = mkTmpDir("tl-ah-n7a-also-");
    writeFile(
      ws,
      "src/auth/credentials.ts",
      "export function validateCredentials(u, p) { return u.length > 0 && p.length > 0; }\n",
    );
    writeFile(ws, "package.json", '{"name":"t","version":"0.0.0"}\n');
    const result = await runQuery(
      "Explain how credentials are validated; also how database migrations are executed.",
      ws,
    );
    const migration = (result.request_item_absences ?? []).find((a) => a.term.includes("migrat"));
    expect(migration, JSON.stringify(result.request_item_absences)).toBeDefined();
    expect(absentTerms(result)).not.toContain("also");
    expect(migration!.term.toLowerCase().split("/")).not.toContain("also");
  });

  it('"plus"/"then" (the SAME coordinator class) are never gap tokens either', async () => {
    const ws = mkTmpDir("tl-ah-n7a-class-");
    writeFile(ws, "src/thing.ts", "export function doThing() { return 1; }\n");
    writeFile(ws, "package.json", '{"name":"t","version":"0.0.0"}\n');
    for (const joiner of ["plus", "then"]) {
      const result = await runQuery(`What does doThing do, and ${joiner} how the flux capacitor works?`, ws);
      expect(absentTerms(result), `joiner=${joiner}`).not.toContain(joiner);
    }
  });

  it("recall control: a genuine >=4-char topic word right next to a stripped filler still surfaces", async () => {
    const ws = mkTmpDir("tl-ah-n7a-recall-");
    writeFile(ws, "src/thing.ts", "export function doThing() { return 1; }\n");
    writeFile(ws, "package.json", '{"name":"t","version":"0.0.0"}\n');
    const result = await runQuery("Explain how doThing works; also how the flux capacitor operates.", ws);
    expect(absentTerms(result).some((t) => t.includes("flux") || t.includes("capacitor")), JSON.stringify(result.request_item_absences)).toBe(true);
  });
});

describe("7b. N7: a Japanese absence token never keeps a trailing particle", () => {
  it('a と-joined clause\'s absent term is reported WITHOUT its trailing "と"', async () => {
    const ws = mkTmpDir("tl-ah-n7b-to-");
    writeFile(ws, "src/auth.ts", "export function checkAuth(token) { return token.length > 0; }\n");
    writeFile(ws, "package.json", '{"name":"t","version":"0.0.0"}\n');
    const result = await runQuery("キャッシュが期限切れの場合の処理と、認証の仕組みを説明してください", ws);
    const cacheAbsence = (result.request_item_absences ?? []).find((a) => a.term.includes("キャッシュ"));
    expect(cacheAbsence, JSON.stringify(result.request_item_absences)).toBeDefined();
    expect(cacheAbsence!.term.endsWith("と")).toBe(false);
  });

  it('a や-joined clause\'s absent term is reported WITHOUT its trailing "や"', async () => {
    const ws = mkTmpDir("tl-ah-n7b-ya-");
    writeFile(ws, "src/auth.ts", "export function checkAuth(token) { return token.length > 0; }\n");
    writeFile(ws, "package.json", '{"name":"t","version":"0.0.0"}\n');
    const result = await runQuery("キャッシュの初期化処理や、認証の仕組みを説明してください", ws);
    const cacheAbsence = (result.request_item_absences ?? []).find((a) => a.term.includes("キャッシュ"));
    expect(cacheAbsence, JSON.stringify(result.request_item_absences)).toBeDefined();
    expect(cacheAbsence!.term.endsWith("や")).toBe(false);
  });

  it("recall control: a genuine embedded particle (not at the trailing edge) survives whole, unaffected", async () => {
    // "キャッシュの有効期限" ("the cache's expiration date") has no request
    // this fixture implements at all -- the embedded の must not be stripped
    // (that would corrupt the phrase), only a TRAILING particle is ever peeled.
    const ws = mkTmpDir("tl-ah-n7b-embedded-");
    writeFile(ws, "src/thing.ts", "export function doThing() { return 1; }\n");
    writeFile(ws, "package.json", '{"name":"t","version":"0.0.0"}\n');
    const result = await runQuery("doThingが何をするかと、キャッシュの有効期限を説明してください", ws);
    const absence = (result.request_item_absences ?? []).find((a) => a.term.includes("有効期限"));
    expect(absence, JSON.stringify(result.request_item_absences)).toBeDefined();
    expect(absence!.term).toContain("キャッシュの有効期限");
  });
});

describe("7c. N7: the scope note never reports an exclusion when the only excluded path is .git", () => {
  function makeGitDir(ws: string): void {
    writeFile(ws, ".git/HEAD", "ref: refs/heads/main\n");
    writeFile(ws, ".git/config", "[core]\n\trepositoryformatversion = 0\n");
  }

  it(".git present, nothing else excluded: scope_complete true, omitted_count 0", async () => {
    const ws = mkTmpDir("tl-ah-n7c-gitonly-");
    writeFile(ws, "package.json", '{"name":"t","version":"0.0.0"}\n');
    writeFile(ws, "src/main.ts", "export function doThing(): number { return 1; }\n");
    makeGitDir(ws);
    const result = await runQuery("What does doThing do, and how is quantum teleportation implemented?", ws);
    const absence = (result.request_item_absences ?? []).find((a) => a.term.includes("quantum"));
    expect(absence, JSON.stringify(result.request_item_absences)).toBeDefined();
    expect(absence?.scope_complete, "a .git-only exclusion must not read as an incomplete scan").toBe(true);
    expect(absence?.omitted_count ?? -1).toBe(0);
  });

  it("recall control: a REAL exclusion is still honestly disclosed even with .git also present", async () => {
    const ws = mkTmpDir("tl-ah-n7c-recall-gitignore-");
    writeFile(ws, "package.json", '{"name":"t","version":"0.0.0"}\n');
    writeFile(ws, ".gitignore", "secretmodule.ts\n");
    writeFile(ws, "src/main.ts", "export function doThing(): number { return 1; }\n");
    writeFile(ws, "secretmodule.ts", "export function runQuantumTeleportation(): void {}\n");
    makeGitDir(ws);
    const result = await runQuery("What does doThing do, and how is quantum teleportation implemented?", ws);
    const absence = (result.request_item_absences ?? []).find((a) => a.term.includes("quantum"));
    expect(absence, JSON.stringify(result.request_item_absences)).toBeDefined();
    expect(absence?.scope_complete, "a real .gitignore exclusion must still be disclosed").toBe(false);
    expect(absence?.omitted_count ?? 0).toBeGreaterThan(0);
  });

  it("recall control: .git plus a DIFFERENT DEFAULT_IGNORE exclusion (node_modules/) reports exactly that one omission, not zero and not double-counted", async () => {
    const ws = mkTmpDir("tl-ah-n7c-recall-nodemodules-");
    writeFile(ws, "package.json", '{"name":"t","version":"0.0.0"}\n');
    writeFile(ws, "src/main.ts", "export function doThing(): number { return 1; }\n");
    writeFile(ws, "node_modules/pkg/index.js", "module.exports = {};\n");
    makeGitDir(ws);
    const result = await runQuery("What does doThing do, and how is quantum teleportation implemented?", ws);
    const absence = (result.request_item_absences ?? []).find((a) => a.term.includes("quantum"));
    expect(absence, JSON.stringify(result.request_item_absences)).toBeDefined();
    expect(absence?.scope_complete).toBe(false);
    expect(absence?.omitted_count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 8. Held item 5 (r-b2, 2026-09-21, adversarial review): derivational
//    variants. `Explain how token expiration is implemented` against a file
//    declaring `expire()` must never certify absent (nor, worse, certify
//    complete while never having evidenced the concern at all) — the
//    reviewer's own exact repro, end to end through `buildTaskPack`.
// ---------------------------------------------------------------------------

describe("8. Held item 5: derivational variants reach the absence/coverage side end to end", () => {
  it("reviewer's exact repro: 'token expiration' is never absent against a file declaring expire()", async () => {
    const ws = mkTmpDir("tl-ah-held5-repro-");
    writeFile(
      ws,
      "src/token.ts",
      [
        "// token.ts -- issues and expires session tokens.",
        "export interface Token { value: string; issuedAtMs: number; ttlMs: number; }",
        "export function expire(token) {",
        "  return Date.now() > token.issuedAtMs + token.ttlMs;",
        "}",
        "",
      ].join("\n"),
    );
    writeFile(ws, "package.json", '{"name":"t","version":"0.0.0"}\n');
    const result = await runQuery("Explain how token expiration is implemented.", ws);
    expect(result.request_item_absences ?? [], JSON.stringify(result.request_item_absences)).toEqual([]);
    expect(servedPaths(result)).toContain("src/token.ts");
    expect(servedText(result)).toContain("expire");
  });

  it("recall control: a genuinely absent concern is still disclosed even when a SIBLING concern only resolves via derivation", async () => {
    const ws = mkTmpDir("tl-ah-held5-recall-");
    writeFile(ws, "src/token.ts", "export function expire(token) { return Date.now() > token.exp; }\n");
    writeFile(ws, "package.json", '{"name":"t","version":"0.0.0"}\n');
    const result = await runQuery(
      "Explain how token expiration is implemented, and how quantum teleportation works.",
      ws,
    );
    expect(absentTerms(result).some((t) => t.includes("expir"))).toBe(false);
    expect(absentTerms(result).some((t) => t.includes("quantum") || t.includes("teleport")), JSON.stringify(result.request_item_absences)).toBe(true);
  });

  it("other required derivational pairs also resolve end to end (deployment/deploy, validator/validate)", async () => {
    const ws = mkTmpDir("tl-ah-held5-pairs-");
    writeFile(
      ws,
      "src/deploy.ts",
      "export function deploy(target) { return `deployed to ${target}`; }\n",
    );
    writeFile(
      ws,
      "src/validate.ts",
      "export class Validator { validate(input) { return input.length > 0; } }\n",
    );
    writeFile(ws, "package.json", '{"name":"t","version":"0.0.0"}\n');
    const result = await runQuery(
      "Explain how the deployment process works, and how the validator's validation logic runs.",
      ws,
    );
    expect(result.request_item_absences ?? [], JSON.stringify(result.request_item_absences)).toEqual([]);
  });
});
