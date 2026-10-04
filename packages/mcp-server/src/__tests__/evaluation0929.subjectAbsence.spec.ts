/**
 * evaluation0929.subjectAbsence.spec.ts — WP-C3 (eval-0929 §6/§8, orchestrator
 * RULING): `request-item-absent:<term>` is certified for a clause's SUBJECT and
 * never for its DESCRIPTORS.
 *
 *   1. Eligible: (a) a code-shaped identifier, (b) a quoted string, (c) the
 *      term an existence question checks, (d) in a clause with NO identifier
 *      and NO quoted string, the words of its topic noun phrase — a
 *      determiner/possessive/topic-marked noun phrase, a multi-word noun
 *      compound, a capitalised proper noun — after removing descriptors.
 *   2. Never eligible: (a) the facet vocabulary (requestFacets.ts
 *      `isFacetDescriptorTerm`, the one shared source), (b) predicates —
 *      decided by position, (c) any plain word of a clause that names an
 *      identifier or a quoted string, (d) any word of a clause whose facet
 *      resolved a focal.
 *   3. Composite terms are decomposed. 4. A non-eligible point is never
 *      silently dropped: covered, facet-owned, or `request-item-undetermined`.
 *
 * Unit tests on the predicate (EN/JA, each category), then end-to-end cases
 * against a spawned dev server on an INVENTED fixture (common brief rule 5:
 * no eval/fixture vocabulary) with the eval §8 metamorphic variants — sentence
 * vs bullets, EN vs JA, a file path in the question, an unrelated same-name
 * function, a small budget — and the recall controls (rule 10).
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  clauseNamesCodeShapedOrQuotedTerm,
  isCodeShapedTerm,
  isLiteralEligibleTerm,
  jaTopicNounPhrase,
  topicNounPhraseWords,
} from "../features/task-pack/requestItems.js";
import { isFacetDescriptorTerm } from "../features/task-pack/requestFacets.js";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import {
  startDevServer,
  followNextToEnd,
  collectDisclosureTexts,
  finalDecisionKind,
  type ChainResult,
  type ServerHandle,
} from "./helpers/qualityFirstScenarios.js";

// ---------------------------------------------------------------------------
// 1. Unit: the shared descriptor vocabulary (rule 2(a)).
// ---------------------------------------------------------------------------

describe("isFacetDescriptorTerm — the facet detectors' own nouns plus the answer-kind nouns (one shared source)", () => {
  const descriptors: readonly string[] = [
    "conditions", "criteria", "rules", // condition facet
    "callers", "usages", "dependents", "subscribers", // callers facet
    "values", "defaults", "thresholds", "maximum", "codes", "statuses", "headers", // value facet
    "lifecycle", // flow facet
    "implementation", "logic", "behaviour", "flow", "path", "list", "steps", "points", // answer-kind
    "条件", "呼び出し元", "既定値", "値", "ステータスコード", "処理経路", "実装", "一覧", "仕組み",
  ];
  for (const term of descriptors) {
    it(`${JSON.stringify(term)} is a descriptor`, () => {
      expect(isFacetDescriptorTerm(term)).toBe(true);
    });
  }
  const subjects: readonly string[] = [
    "quorblex", "gearbox", "redis", "entryway", "constant", "invalidation", "changelog", "capacitor",
    "キャッシュ", "マイグレーション", "ドキュメント", "クォーブレックス",
  ];
  for (const term of subjects) {
    it(`${JSON.stringify(term)} (a subject noun) is never a descriptor`, () => {
      expect(isFacetDescriptorTerm(term)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Unit: the eligibility predicate.
// ---------------------------------------------------------------------------

interface EligibilityCase {
  readonly clause: string;
  readonly eligible: readonly string[];
  readonly ineligible: readonly string[];
}

const SUBJECT_CASES: readonly EligibilityCase[] = [
  // 1(d) — the subject noun phrase of an identifier-free clause.
  { clause: "how does the quorblex gearbox spin?", eligible: ["quorblex", "gearbox"], ineligible: ["spin"] },
  { clause: "how is quorblex teleportation implemented?", eligible: ["quorblex", "teleportation"], ineligible: ["implemented"] },
  { clause: "how quorblex ledgers are reconciled", eligible: ["quorblex", "ledgers"], ineligible: ["reconciled"] },
  { clause: "How is the quorblex vault sealed?", eligible: ["quorblex", "vault"], ineligible: ["sealed"] },
  { clause: "the quorblex cache invalidation implementation", eligible: ["quorblex", "invalidation"], ineligible: ["implementation"] },
  { clause: "and update the quorblex changelog.", eligible: ["quorblex", "changelog"], ineligible: ["update"] },
  { clause: "Walk me through how Quorblex caching works", eligible: ["Quorblex", "caching"], ineligible: ["works", "Walk"] },
  { clause: "Tell me about the quorblex audit trail", eligible: ["quorblex", "audit", "trail"], ineligible: ["Tell"] },
  { clause: "Is there a quorblex registry anywhere in this codebase?", eligible: ["quorblex", "registry"], ineligible: ["codebase", "anywhere"] },
  // 2(b) — predicates, by position.
  { clause: "under which conditions does it give up", eligible: [], ineligible: ["conditions", "give"] },
  { clause: "what happens when the quorblex payment fails", eligible: ["quorblex", "payment"], ineligible: ["happens", "fails"] },
  { clause: "which inputs cause a quorblex rejection", eligible: ["quorblex", "rejection"], ineligible: ["inputs", "cause"] },
  { clause: "a quorblex user is denied access", eligible: ["quorblex", "user"], ineligible: ["denied", "access"] },
  { clause: "what happens if the quorblex token is missing", eligible: ["quorblex", "token"], ineligible: ["happens", "missing"] },
  { clause: "how the scheduler assigns quorblex", eligible: ["scheduler"], ineligible: ["assigns"] },
  { clause: "Compute the quorblex total", eligible: ["quorblex", "total"], ineligible: ["Compute"] },
  { clause: "Quorblex retry failed batches", eligible: ["Quorblex", "batches"], ineligible: ["failed"] }, // a verbless list fragment
  // 2(a) — descriptors never, even inside the subject noun phrase.
  // R2-T2 follow-up (2026-09-30, orchestrator ruling on the round-2 combined
  // run) supersedes this row's former `eligible: ["quorblex"]`: a word inside
  // a prepositional adjunct of a facet-framed clause (the callers facet) is
  // never the subject — neither as a head nor as a compound's first noun.
  { clause: "the callers during the quorblex sequence", eligible: [], ineligible: ["quorblex", "callers", "during", "sequence"] },
  { clause: "Explain the quorblex constant value", eligible: ["quorblex", "constant"], ineligible: ["value"] },
  // 2(c) — a clause naming an identifier or a quoted string: only that.
  { clause: "the callers of quorblex_checksum in production code", eligible: ["quorblex_checksum"], ineligible: ["callers", "production", "code"] },
  { clause: "what happens if the QuorblexKey is missing", eligible: ["QuorblexKey"], ineligible: ["happens", "missing"] },
  { clause: "Explain Quorblex.get and the gearbox layer", eligible: ["Quorblex.get"], ineligible: ["gearbox", "layer"] },
  { clause: "Explain how the parser treats `quorblex` markers", eligible: ["quorblex"], ineligible: ["parser", "markers"] },
];

describe("isLiteralEligibleTerm — subject kept, descriptor/predicate never (EN)", () => {
  for (const { clause, eligible, ineligible } of SUBJECT_CASES) {
    it(JSON.stringify(clause), () => {
      for (const word of eligible) expect(isLiteralEligibleTerm(word, clause), `${word} should be eligible`).toBe(true);
      for (const word of ineligible) expect(isLiteralEligibleTerm(word, clause), `${word} should never be eligible`).toBe(false);
    });
  }

  it("composite decomposition: of a slash-joinable union, only the subject parts survive (payment/fails → payment)", () => {
    const clause = "what happens when the payment fails";
    expect(["payment", "fails"].filter((word) => isLiteralEligibleTerm(word, clause))).toEqual(["payment"]);
  });

  it("a bare capitalized word is a proper noun, not a code-shaped identifier (it never makes its clause identifier-bearing)", () => {
    expect(isCodeShapedTerm("Quorblex")).toBe(false);
    expect(clauseNamesCodeShapedOrQuotedTerm("Explain the Quorblex cache invalidation")).toBe(false);
    expect(isLiteralEligibleTerm("Quorblex", "Explain the Quorblex cache invalidation")).toBe(true);
    // A prose acronym is not a name either.
    expect(isCodeShapedTerm("HTTP")).toBe(false);
    expect(clauseNamesCodeShapedOrQuotedTerm("Explain the HTTP client")).toBe(false);
    // A real identifier still is.
    expect(clauseNamesCodeShapedOrQuotedTerm("Explain what quorblexLimit returns")).toBe(true);
  });

  it("an apostrophe inside a word never opens a quoted span", () => {
    expect(clauseNamesCodeShapedOrQuotedTerm("Explain the user's and the admin's quorblex roles")).toBe(false);
  });

  it("topicNounPhraseWords: sentence vs bullet fragment carry the same subject", () => {
    expect([...topicNounPhraseWords("how the quorblex gearbox spins")]).toEqual(["quorblex", "gearbox"]);
    expect([...topicNounPhraseWords("Quorblex gearbox spin rate")]).toEqual(["quorblex", "gearbox", "spin", "rate"]);
  });
});

describe("jaTopicNounPhrase / isLiteralEligibleTerm — Japanese noun phrase kept, clause and descriptor never (JA)", () => {
  const cases: ReadonlyArray<readonly [string, string | undefined]> = [
    ["クォーブレックスの仕組み", "クォーブレックス"], // descriptor tail removed
    ["クォーブレックス戦略の種類", "クォーブレックス戦略"],
    ["キャッシュの有効期限", "キャッシュの有効期限"], // a pure noun phrase stays whole
    ["クォーブレックスについて", "クォーブレックス"], // topic marker
    ["ドキュメント", "ドキュメント"],
    ["各ロールが返すステータスコードの一覧", undefined], // a clause
    ["完全再同期が代わりにトリガーされる条件", undefined],
    ["無効化する処理", undefined], // a relative clause
    ["条件", undefined], // nothing but a descriptor
    ["触れて", undefined], // a verb
  ];
  for (const [run, expected] of cases) {
    it(`${run} → ${expected ?? "(not a noun phrase)"}`, () => {
      expect(jaTopicNounPhrase(run)).toBe(expected);
    });
  }

  it("a whole noun phrase is eligible in an identifier-free clause; a clause-shaped run never is", () => {
    expect(isLiteralEligibleTerm("ドキュメント", "ドキュメントを更新してください。")).toBe(true);
    expect(isLiteralEligibleTerm("キャッシュの有効期限", "キャッシュの有効期限を説明してください")).toBe(true);
    expect(isLiteralEligibleTerm("キャッシュが期限切れの場合の処理", "キャッシュが期限切れの場合の処理と")).toBe(false);
    // descriptor-bearing: only its trimmed form is (the callers verify it before disclosing).
    expect(isLiteralEligibleTerm("クォーブレックスの仕組み", "クォーブレックスの仕組みを説明してください")).toBe(false);
    expect(isLiteralEligibleTerm("クォーブレックス", "クォーブレックスの仕組みを説明してください")).toBe(true);
    // 2(c): beside an identifier, a JA noun is that identifier's prose.
    expect(isLiteralEligibleTerm("キャッシュ", "quorblexLimit のキャッシュを説明してください")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. End-to-end on an invented fixture.
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

function sprocketFiles(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "src/sprocketHub.ts": [
      "export const SPROCKET_QUOTA = 5381;",
      "export const RESEND_SIGNALS = new Set([461, 473, 587]);",
      "export function sprocketQuota(): number { return SPROCKET_QUOTA; }",
      "export function mayResend(signal: number, attempt: number): boolean { return RESEND_SIGNALS.has(signal) && attempt < 2; }",
      "export function sendSprocket(signal: number): boolean { return mayResend(signal, 0); }",
      "",
    ].join("\n"),
    "src/sprocketPump.ts": [
      "import { sendSprocket } from \"./sprocketHub.js\";",
      "export function pumpSprockets(): boolean { return sendSprocket(587); }",
      "",
    ].join("\n"),
    ...extra,
  };
}

function workspace(files: Record<string, string>): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, ".tl-e0929-subj-"));
  tmpDirs.push(ws);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), content, "utf8");
  }
  return ws;
}

async function ask(ws: string, query: string, extraArgs: Record<string, unknown> = {}): Promise<{ chain: ChainResult; disclosures: string[] }> {
  const server = startDevServer(ws, "default");
  servers.push(server);
  await server.initialize();
  const chain = await followNextToEnd(
    server,
    { tool: "tl_read_file", arguments: { query, cwd: ws, task: { epoch: "new", profile: "answer" }, ...extraArgs } },
    { cwd: ws, hopCap: 12 },
  );
  return { chain, disclosures: collectDisclosureTexts(chain) };
}

/** Every VERIFIED-absence disclosure (both wire shapes: the certificate string and the discover gap's refs). */
function absences(disclosures: readonly string[]): string[] {
  return disclosures.filter((d) => /request-item-absent/u.test(d));
}

const PREDICATE_OR_DESCRIPTOR_RE = /\b(?:spin|spins|overflows?|happens|rebalanced|conditions?|callers?|values?|codes|statuses)\b|仕組み|条件|呼び出し元|既定値/iu;

describe("end-to-end: a subject the workspace lacks is certified absent (the 2026-09-08 Tier C behaviour, kept) — metamorphic variants", () => {
  const variants: ReadonlyArray<{ name: string; files?: Record<string, string>; query: string; want: RegExp; extra?: Record<string, unknown> }> = [
    { name: "EN sentence", query: "What does sprocketQuota return, and how does the quorblex gearbox spin?", want: /quorblex|gearbox/iu },
    { name: "EN with a file path", query: "In src/sprocketHub.ts, what does sprocketQuota return, and how does the quorblex gearbox spin?", want: /quorblex|gearbox/iu },
    { name: "EN bullets", query: "Explain the sprocket hub:\n- The quota returned by sprocketQuota\n- How the quorblex gearbox spins", want: /quorblex|gearbox/iu },
    { name: "EN, unrelated same-name function", files: sprocketFiles({ "src/legacyHub.ts": "export function sprocketQuota(): number { return 0; }\n" }), query: "What does sprocketQuota return, and how does the quorblex gearbox spin?", want: /quorblex|gearbox/iu },
    { name: "EN, small budget with continuation", query: "What does sprocketQuota return, and how does the quorblex gearbox spin?", want: /quorblex|gearbox/iu, extra: { budget: { bytes: 6144 } } },
    // The JA (coined katakana) variant moved to its own test below: R2-T2's
    // 2026-09-30 orchestrator ruling makes an unmapped katakana term
    // undetermined, never a certified absence.
  ];
  for (const variant of variants) {
    it(`${variant.name}: the missing subject is disclosed absent, never a predicate or descriptor`, async () => {
      const ws = workspace(variant.files ?? sprocketFiles());
      const { chain, disclosures } = await ask(ws, variant.query, variant.extra ?? {});
      const verified = absences(disclosures);
      expect(verified.some((d) => variant.want.test(d)), `no subject absence among: ${JSON.stringify(disclosures)}`).toBe(true);
      expect(verified.filter((d) => PREDICATE_OR_DESCRIPTOR_RE.test(d)), JSON.stringify(verified)).toEqual([]);
      expect(finalDecisionKind(chain)).toBe("act.answer");
    }, 60_000);
  }

  // R2-T2 (2026-09-30, orchestrator RULING — supersedes R-B3 ruling 3's "an
  // unresolved loanword is a checkable miss", which this variant used to pin as
  // a certified absence): a katakana loanword that neither the workspace bridge
  // nor the glossary can spell in English proves nothing by its literal miss —
  // the point is disclosed undetermined, by its subject (descriptor tail
  // removed), never certified absent and never a dead end.
  it("JA (coined katakana loanword, descriptor tail removed): the subject is disclosed undetermined, never certified absent", async () => {
    const ws = workspace(sprocketFiles());
    const { chain, disclosures } = await ask(ws, "sprocketQuota が返す値と、クォーブレックスの仕組みを説明してください。");
    expect(absences(disclosures), JSON.stringify(disclosures)).toEqual([]);
    expect(disclosures.some((d) => /request-item-undetermined:クォーブレックス[ (]/u.test(d)), JSON.stringify(disclosures)).toBe(true);
    expect(disclosures.filter((d) => /request-item-undetermined:[^ ]*仕組み/u.test(d)), JSON.stringify(disclosures)).toEqual([]);
    expect(finalDecisionKind(chain)).toBe("act.answer");
  }, 60_000);
});

describe("end-to-end: descriptors, predicates and prose beside an identifier are never certified absent", () => {
  it("facet descriptors of identifier-bearing clauses (EN sentence, EN bullets, JA)", async () => {
    for (const query of [
      "Explain the default value returned by sprocketQuota, the conditions of mayResend, and the callers of sendSprocket.",
      "Explain the sprocket hub:\n- Default value returned by sprocketQuota\n- Conditions checked by mayResend\n- Callers of sendSprocket",
      "sprocketQuota の既定値、mayResend の条件、sendSprocket の呼び出し元を説明してください。",
    ]) {
      const ws = workspace(sprocketFiles());
      const { disclosures } = await ask(ws, query);
      expect(absences(disclosures), `${query}: ${JSON.stringify(disclosures)}`).toEqual([]);
    }
  }, 120_000);

  it("a predicate is never the disclosed term; the subject beside it may be", async () => {
    const ws = workspace(sprocketFiles());
    const { disclosures } = await ask(ws, "What does sprocketQuota return, and what happens when the quorblex vault overflows?");
    const verified = absences(disclosures);
    expect(verified.filter((d) => /overflows?|happens/iu.test(d)), JSON.stringify(verified)).toEqual([]);
    expect(verified.some((d) => /quorblex/iu.test(d)), JSON.stringify(disclosures)).toBe(true);
  }, 60_000);

  it("a content predicate on a present subject is disclosed undetermined, never absent (collision shape)", async () => {
    const ws = workspace(sprocketFiles());
    const { disclosures } = await ask(ws, "What does sprocketQuota return, and how is the sprocket hub rebalanced?");
    expect(absences(disclosures).filter((d) => /rebalanced/iu.test(d)), JSON.stringify(disclosures)).toEqual([]);
  }, 60_000);

  it("plain words beside an identifier are never disclosed (only the identifier is the subject)", async () => {
    const ws = workspace(sprocketFiles());
    const { disclosures } = await ask(ws, "Explain the callers of sendSprocket in production code, and what sprocketQuota returns.");
    expect(absences(disclosures), JSON.stringify(disclosures)).toEqual([]);
  }, 60_000);
});

describe("end-to-end: a concern named only in README prose is never silently dropped (rule 4)", () => {
  it("follow, bare-qref re-pack and restated query all name the missing concern whenever they certify", async () => {
    const ws = workspace(sprocketFiles({
      "README.md": "# Sprockets\n\nThis project documents quorblex handling in `src/quorblexVault.ts`, which is not part of this checkout.\n",
    }));
    const query = "1. How is the sprocket quota computed?\n2. How are quorblex vaults sealed?";
    const server = startDevServer(ws, "default");
    servers.push(server);
    await server.initialize();
    const follow = await followNextToEnd(server, { tool: "tl_read_file", arguments: { query, cwd: ws, task: { epoch: "new", profile: "answer" } } }, { cwd: ws, hopCap: 12 });
    const qref = [...follow.hops].reverse().map((hop) => hop.response?.qref).find((value) => typeof value === "string");
    const repack = typeof qref === "string"
      ? await followNextToEnd(server, { tool: "tl_read_file", arguments: { qref, cwd: ws } }, { cwd: ws, hopCap: 8, maxQrefRepacks: 0 })
      : undefined;
    const restate = await followNextToEnd(server, { tool: "tl_read_file", arguments: { query, cwd: ws } }, { cwd: ws, hopCap: 8, maxQrefRepacks: 0 });
    for (const [label, chain] of [["follow", follow], ["repack", repack], ["restate", restate]] as const) {
      if (chain === undefined || finalDecisionKind(chain) !== "act.answer") continue;
      const disclosures = collectDisclosureTexts(chain);
      expect(disclosures.some((d) => /quorblex|vault/iu.test(d)), `${label}: certified without naming the missing concern: ${JSON.stringify(disclosures)}`).toBe(true);
    }
  }, 120_000);
});

describe("end-to-end recall controls (rule 10): unchanged decisions where nothing is missing, literal checks still verified", () => {
  it("an implemented second concern: act.answer, no absence at all", async () => {
    const ws = workspace(sprocketFiles());
    const { chain, disclosures } = await ask(ws, "What does sprocketQuota return, and how does sendSprocket resend a signal?");
    expect(absences(disclosures), JSON.stringify(disclosures)).toEqual([]);
    expect(finalDecisionKind(chain)).toBe("act.answer");
  }, 60_000);

  it("a quoted, genuinely absent identifier is still certified absent", async () => {
    const ws = workspace(sprocketFiles());
    const { disclosures } = await ask(ws, "What does sprocketQuota return, and is `QUORBLEX_SEAL_7730` defined anywhere?");
    expect(absences(disclosures).some((d) => d.includes("QUORBLEX_SEAL_7730")), JSON.stringify(disclosures)).toBe(true);
  }, 60_000);
});
