/**
 * evaluation0929.descriptorModifierEligibility.spec.ts — orchestrator
 * addition to WP-C4 (eval-0929 §8, small, same ruling as brief-wp-c3.md): a
 * MODIFIER of a facet descriptor is part of the descriptor. Blind-set leak:
 * a bullet "- direct callers" (under "…enqueue_message. Who calls it?")
 * certified `request-item-absent:direct` — "direct" is an adjective
 * modifying the descriptor "callers" (rule 2(a)/(b) of the WP-C3 ruling),
 * never a subject of its own.
 *
 * Fixed POSITIONALLY (requestItems.ts's `addNounPhrase`, inside
 * `enSegmentTopicWords`): a small, closed set of SCOPE/COMPLETENESS
 * adjectives (direct/indirect/possible/main/primary/secondary —
 * `NP_DESCRIPTOR_SCOPE_ADJECTIVES_EN`) is excluded from a noun-phrase run
 * ONLY when that SAME run's own head is a facet descriptor
 * (`requestFacets.ts` `isFacetDescriptorTerm`) — never a blanket
 * reclassification, so "the direct database connection" (no descriptor
 * head) is entirely unaffected and "the redis cache invalidation
 * IMPLEMENTATION" (WP-C3's own kept case) still keeps "redis"/"invalidation"
 * eligible despite sitting right before the descriptor head
 * "implementation". The Japanese mirror ("直接的な呼び出し元",
 * "すべての呼び出し元") needed NO code change at all — `jaTopicNounPhrase`'s
 * existing な-attributive-predicate test and の-segment descriptor trim
 * already exclude both, independently verified below.
 *
 * R2-T2 (2026-09-30, review-0929 P1-2 → P0, orchestrator RULING) generalises
 * the head-gated rule: an ADJECTIVE is a descriptor before any head
 * (requestItems.ts `isAdjectiveShaped`), so "direct" in "the direct database
 * connection" is no longer eligible either — the phrase's nouns still are
 * (section 1b below; the old recall control is rewritten there).
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { isLiteralEligibleTerm, jaTopicNounPhrase, topicNounPhraseWords } from "../features/task-pack/requestItems.js";
import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { startDevServer, followNextToEnd, collectDisclosureTexts, finalDecisionKind, type ServerHandle } from "./helpers/qualityFirstScenarios.js";

// ---------------------------------------------------------------------------
// 1. Unit: a scope adjective pre-modifying a descriptor head is never eligible.
// ---------------------------------------------------------------------------

describe("addNounPhrase / isLiteralEligibleTerm — a scope adjective modifying a facet-descriptor head is part of the descriptor (EN)", () => {
  const neverEligible: ReadonlyArray<readonly [string, string]> = [
    ["direct", "direct callers"],
    ["indirect", "indirect callers"],
    ["possible", "possible values"],
    ["main", "main condition"],
    ["primary", "primary callers"],
    ["secondary", "secondary conditions"],
  ];
  for (const [word, clause] of neverEligible) {
    it(`${JSON.stringify(word)} in ${JSON.stringify(clause)} is never eligible for absence`, () => {
      expect(isLiteralEligibleTerm(word, clause)).toBe(false);
    });
  }

  it("the descriptor head itself stays non-eligible too (rule 2(a), unchanged)", () => {
    expect(isLiteralEligibleTerm("callers", "direct callers")).toBe(false);
  });

  // R2-T2 (2026-09-30, orchestrator RULING on review-0929 P1-2) supersedes the
  // head-gated reading this recall control used to pin ("direct" eligible
  // before a domain head): an adjective is a descriptor before ANY head, so
  // "direct" is never eligible; the phrase's nouns still are.
  it("R2-T2 ruling: an adjective is a descriptor before any head; the noun compound's nouns stay eligible", () => {
    expect(isLiteralEligibleTerm("direct", "the direct database connection")).toBe(false);
    expect(topicNounPhraseWords("the direct database connection").has("direct")).toBe(false);
    expect(isLiteralEligibleTerm("database", "the direct database connection")).toBe(true);
    expect(isLiteralEligibleTerm("connection", "the direct database connection")).toBe(true);
  });

  it("recall control: WP-C3's own kept case — a distinguishing word before a descriptor head stays eligible when it is not a scope adjective", () => {
    expect(isLiteralEligibleTerm("redis", "the redis cache invalidation implementation")).toBe(true);
    expect(isLiteralEligibleTerm("invalidation", "the redis cache invalidation implementation")).toBe(true);
    expect(isLiteralEligibleTerm("database", "the database implementation")).toBe(true);
  });

  it("recall control: 'all'/'other' (already NP_DETERMINERS) keep their pre-existing non-eligible status", () => {
    expect(isLiteralEligibleTerm("all", "all callers")).toBe(false);
    expect(isLiteralEligibleTerm("other", "other callers")).toBe(false);
  });
});

describe("jaTopicNounPhrase — the JA mirror needed no code change: な-attributive and の-segment descriptor trimming already exclude a scope modifier", () => {
  it("直接的な呼び出し元 (direct callers) is never eligible — already caught by the na-attributive-predicate test", () => {
    expect(jaTopicNounPhrase("直接的な呼び出し元")).toBeUndefined();
    expect(isLiteralEligibleTerm("直接的な呼び出し元", "直接的な呼び出し元")).toBe(false);
  });
  it("間接的な呼び出し元 (indirect callers) is never eligible", () => {
    expect(jaTopicNounPhrase("間接的な呼び出し元")).toBeUndefined();
  });
  it("すべての呼び出し元 (all callers) is never eligible — the の-segment descriptor trim already reduces it past the whole-run identity check", () => {
    expect(jaTopicNounPhrase("すべての呼び出し元")).not.toBe("すべての呼び出し元");
    expect(isLiteralEligibleTerm("すべての呼び出し元", "すべての呼び出し元")).toBe(false);
  });
  it("recall control: an unrelated JA noun phrase with no descriptor is unaffected", () => {
    expect(jaTopicNounPhrase("キャッシュの有効期限")).toBe("キャッシュの有効期限");
  });
});

// ---------------------------------------------------------------------------
// 1b. R2-T2 (2026-09-30, review-0929 P1-2 → P0, orchestrator RULING): in an
//     identifier-free topic clause only the noun phrase's NOUNS are
//     absence-eligible — an adjective is a descriptor, whatever head follows.
// ---------------------------------------------------------------------------

describe("R2-T2: an adjective in an identifier-free topic clause is a descriptor, never absence-eligible (EN)", () => {
  const cases: ReadonlyArray<{ clause: string; never: readonly string[]; eligible: readonly string[]; shape: string }> = [
    { shape: "-ent adjective before a plain head", clause: "why intermittent failures are retried.", never: ["intermittent"], eligible: ["failures"] },
    { shape: "basic adjective in a first-person context clause", clause: "I'm debugging slow requests.", never: ["slow", "debugging", "i'm", "i"], eligible: [] },
    { shape: "adjective before a descriptor head: no subject at all", clause: "why transient errors are retried", never: ["transient", "errors"], eligible: [] },
    { shape: "-y basic adjective", clause: "how flaky upstreams are handled", never: ["flaky"], eligible: ["upstreams"] },
    { shape: "-ous adjective", clause: "the dangerous migration", never: ["dangerous"], eligible: ["migration"] },
    { shape: "hyphenated compound modifier", clause: "how long-running jobs are cancelled", never: ["long-running"], eligible: ["jobs"] },
    { shape: "negated adjective", clause: "the unstable connection pool", never: ["unstable"], eligible: ["connection", "pool"] },
    { shape: "adjective object of a verb is no noun compound", clause: "how the scheduler assigns urgent jobs", never: ["urgent", "jobs"], eligible: ["scheduler"] },
  ];
  for (const { shape, clause, never, eligible } of cases) {
    it(`${shape}: ${JSON.stringify(clause)}`, () => {
      for (const word of never) expect(isLiteralEligibleTerm(word, clause), `${word} must never be eligible`).toBe(false);
      for (const word of eligible) expect(isLiteralEligibleTerm(word, clause), `${word} must stay eligible`).toBe(true);
    });
  }

  it("recall control: the nouns of a noun compound stay eligible (first noun and head alike)", () => {
    for (const [clause, words] of [
      ["how the rate limiter throttles clients", ["rate", "limiter"]],
      ["whether the circuit breaker trips after repeated failures", ["circuit", "breaker"]],
      ["how is quantum teleportation implemented?", ["quantum", "teleportation"]],
      ["the cache constant value", ["cache", "constant"]],
      ["the constant pool", ["constant", "pool"]],
      ["the event loop", ["loop"]],
    ] as const) {
      for (const word of words) expect(isLiteralEligibleTerm(word, clause), `${word} in ${clause}`).toBe(true);
    }
  });

  it("recall control: a word shaped like an adjective stays eligible as the HEAD of its phrase (position wins)", () => {
    expect(isLiteralEligibleTerm("constant", "Explain the retry constant")).toBe(true);
    expect(isLiteralEligibleTerm("total", "Compute the invoice total")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. End-to-end: a bulleted "direct callers" point never certifies "direct" absent.
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

function workspace(files: Record<string, string>): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, ".tl-e0929-descmod-"));
  tmpDirs.push(ws);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), content, "utf8");
  }
  return ws;
}

describe("end-to-end: a bulleted 'direct callers' point never certifies the modifier absent", () => {
  it("'…enqueueMessage. Who calls it?\\n- direct callers' never discloses request-item-absent:direct", async () => {
    const ws = workspace({
      "src/queue/enqueueMessage.ts": ["export function enqueueMessage(id: string): void {", "  console.log(id);", "}", ""].join("\n"),
      "src/queue/dispatcher.ts": [
        "import { enqueueMessage } from \"./enqueueMessage.js\";",
        "export function dispatch(id: string): void { enqueueMessage(id); }",
        "",
      ].join("\n"),
    });
    const server = startDevServer(ws, "default");
    servers.push(server);
    await server.initialize();
    const query = "Explain enqueueMessage. Who calls it?\n- direct callers";
    const chain = await followNextToEnd(
      server,
      { tool: "tl_read_file", arguments: { query, cwd: ws, task: { epoch: "new", profile: "answer" } } },
      { cwd: ws, hopCap: 6 },
    );
    const disclosures = collectDisclosureTexts(chain);
    const directAbsence = disclosures.filter((d) => /request-item-absent[^)]*\bdirect\b/iu.test(d));
    expect(directAbsence, JSON.stringify(disclosures)).toEqual([]);
    expect(finalDecisionKind(chain)).not.toBe("await_input");
  }, 60_000);
});
