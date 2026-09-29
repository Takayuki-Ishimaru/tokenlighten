/**
 * concernRetentionMatrix.spec.ts — FIX-B (plan-0143 TL-02 P0 / TL-04)
 * spawned-server, end-to-end acceptance matrix for compound-request
 * retention and the completion gate (`headIsWhAfterReadLead`/H-2 in
 * requestItems.ts + readCodeTaskPack.ts, the B3 bracket/quote guard, the B5
 * doc-role coverage guard in concernRecovery.ts, and the B5-adjacent
 * doc-noise candidate filter in readCodeTaskPack.ts's request-item gap ->
 * next-target selection). See `headWhAfterReadLead.spec.ts` for the pure,
 * no-server unit layer this file's oracle depends on holding.
 *
 * Reuses the SHARED harness (`startDevServer`/`followNextToEnd`/disclosure
 * helpers) from `./helpers/qualityFirstScenarios.js` — the same module
 * `qualityFirst0143.acceptance.spec.ts` and `scripts/tl-quality-eval.mjs`
 * use — but every fixture/query below is this file's OWN (never edits that
 * shared module; brief-fix-b.md: "flip ONLY ids Q01 and Q05" there).
 *
 * A KNOWN, SEPARATELY-REPORTED wire quirk this file works AROUND rather than
 * assumes away (see the wave report / arch-map-b.md "Chip 2"): a chain that
 * reaches a genuine `act.answer` and is then followed further via a bare
 * `{qref, cwd}` re-pack can regress to an earlier `discover` state and never
 * present a fresh `act.answer` again within `followNextToEnd`'s bounded
 * re-pack budget — so this file's own oracle (`reachedAnswerWithCoverage`)
 * looks for the FIRST hop that reached `act.answer`, and checks coverage
 * using only the hops up to and including it, rather than trusting
 * `finalDecisionKind` on a chain that may have been followed past its own
 * legitimate answer. This is a wire/delivery-layer quirk, not a
 * request-item retention defect — see this file's own header comment on
 * `reachedAnswerWithCoverage` and the wave report for the full writeup.
 *
 * Every fixture's implementation comment DELIBERATELY restates the query's
 * own salient wording verbatim (e.g. "database migrations are executed",
 * not "schema migrations run") — confirmed by hand that a synonym-only
 * comment can trip the ABSENCE side of a completely different, already
 * reported mechanism (`proveUnbindableRequestItem`'s literal/inflection
 * scan, owned by FIX-C/TL-03) and falsely disclose a concern that WAS
 * served as "absent" in the same response. That is TL-03's mechanism, not
 * this file's; wording fixtures to avoid tripping it keeps this file's own
 * oracle isolated to what THIS fix (retention + the completion gate) is
 * responsible for.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import {
  CONFIG_NAMES,
  startDevServer,
  followNextToEnd,
  anyEvidenceContains,
  collectDisclosureTexts,
  anyDisclosureMatches,
  servedEvidencePaths,
  type ChainResult,
  type ConfigName,
  type Hop,
  type ServerHandle,
} from "./helpers/qualityFirstScenarios.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();

const tmpDirs: string[] = [];
const servers: ServerHandle[] = [];

// Every server is started inside one test (the `server()` factory below is
// called fresh per `it`, never shared); stop it when that test ends so the
// many MATRIX-A/A2/B/JA/server-level-control cells never hold all their
// servers alive at once.
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
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-fixb-${tag}-`));
  tmpDirs.push(ws);
  return ws;
}

function writeFile(ws: string, rel: string, content: string): void {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

async function server(ws: string, config: ConfigName): Promise<ServerHandle> {
  const s = startDevServer(ws, config);
  servers.push(s);
  await s.initialize();
  return s;
}

/**
 * See this file's own header: looks for the FIRST hop reaching
 * `decision.kind === "act.answer"` and checks required evidence using only
 * the hops up to and including it — never `finalDecisionKind` on the raw
 * chain, which a bare-qref-repack regression (Chip 2, out of this fix's
 * scope) can carry PAST a legitimate answer into a later, non-terminal
 * `discover`/`read.receipt`.
 */
function firstAnswerHopIndex(chain: ChainResult): number | undefined {
  const idx = chain.hops.findIndex((hop: Hop) => hop.response?.decision?.kind === "act.answer");
  return idx >= 0 ? idx : undefined;
}

function reachedAnswerWithCoverage(chain: ChainResult, evidenceGroups: readonly (readonly string[])[]): boolean {
  const idx = firstAnswerHopIndex(chain);
  if (idx === undefined) return false;
  const prefix: ChainResult = { hops: chain.hops.slice(0, idx + 1), final: chain.hops[idx]!.response, capped: false };
  return evidenceGroups.every((markers) => anyEvidenceContains(prefix, markers));
}

/** Every request-item obligation id (`request-item:ri-N`) named anywhere in
 *  the chain's disclosures/gaps — used to confirm a concern was at least
 *  TRACKED (never silently absent from the whole conversation), even on a
 *  cell where the chain never reaches a clean terminal answer. */
function anyRequestItemGapNamed(chain: ChainResult): boolean {
  // Two observed wire spellings: an `act.answer` certificate's plain-string
  // `explicit-gap:request-item-absent:ri-N (...)`, and a `discover`/
  // `await_input`'s structured `{kind:"request-item-absent", id:"ri-N", ...}`
  // (stringified by `collectDisclosureTexts` as space-joined fields) — both
  // contain a bare `ri-<N>` token, which is the one thing they share.
  return collectDisclosureTexts(chain).some((t) => /\bri-\d+\b/u.test(t));
}

// ---------------------------------------------------------------------------
// Concern pool — six clean, mutually non-colliding concerns (own vocabulary,
// no shared words across concerns, none matching DEFINITION_KEYWORDS_RE/
// DECISION_KEYWORDS_RE, so a query built from any subset stays "topic"-kind
// end to end and no concern's own module mentions another's wording).
// ---------------------------------------------------------------------------

interface Concern {
  readonly phrase: string;
  readonly relPath: string;
  readonly evidence: readonly string[];
  readonly content: string;
}

const CONCERN_POOL: readonly Concern[] = [
  {
    phrase: "credentials are validated",
    relPath: "src/auth/credentials.ts",
    evidence: ["validateCredentials"],
    content: [
      "// credentials.ts -- checks that supplied login credentials are validated against the stored record.",
      "export function validateCredentials(username: string, password: string): boolean {",
      "  return username.length > 0 && password.length > 0;",
      "}",
      "",
    ].join("\n"),
  },
  {
    phrase: "database migrations are executed",
    relPath: "src/migrations/runner.ts",
    evidence: ["runPendingMigrations"],
    content: [
      "// runner.ts -- this module ensures pending database migrations are executed in order at startup.",
      "export function runPendingMigrations(names: readonly string[]): void {",
      "  for (const n of names) {",
      "    // apply migration n",
      "  }",
      "}",
      "",
    ].join("\n"),
  },
  {
    phrase: "cache entries expire",
    relPath: "src/cache.ts",
    evidence: ["expiresAtMs", "TtlCache"],
    content: [
      "// cache.ts -- tracks how long cache entries stay valid before they expire.",
      "interface Entry<V> { value: V; expiresAtMs: number; }",
      "export class TtlCache<V> {",
      "  private entries = new Map<string, Entry<V>>();",
      "  get(key: string): V | undefined {",
      "    const entry = this.entries.get(key);",
      "    if (!entry) return undefined;",
      "    if (Date.now() >= entry.expiresAtMs) { this.entries.delete(key); return undefined; }",
      "    return entry.value;",
      "  }",
      "}",
      "",
    ].join("\n"),
  },
  {
    phrase: "retry attempts are scheduled",
    relPath: "src/retry.ts",
    evidence: ["computeRetryDelayMs"],
    content: [
      "// retry.ts -- decides how retry attempts are scheduled using exponential backoff.",
      "export function computeRetryDelayMs(baseMs: number, attempt: number): number {",
      "  return baseMs * Math.pow(2, attempt);",
      "}",
      "",
    ].join("\n"),
  },
  {
    phrase: "webhook payloads are signed",
    relPath: "src/webhooks/signer.ts",
    evidence: ["signPayload"],
    content: [
      "// signer.ts -- ensures outbound webhook payloads are signed with an HMAC secret before delivery.",
      "export function signPayload(body: string, secret: string): string {",
      "  return `${body}.${secret.length}`;",
      "}",
      "",
    ].join("\n"),
  },
  {
    phrase: "search results are ranked",
    relPath: "src/search/ranker.ts",
    evidence: ["rankResults"],
    content: [
      "// ranker.ts -- determines how search results are ranked before being returned to the caller.",
      "export function rankResults(items: readonly string[]): string[] {",
      "  return [...items].sort();",
      "}",
      "",
    ].join("\n"),
  },
];

/** Tiny fixed-seed LCG (mulberry32) — deterministic, reproducible fixture
 *  selection (brief-fix-b.md: "generated with a fixed seed"), never a
 *  source of flakiness across runs/machines. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEED = 0x0143_fb02; // fixed, arbitrary — plan-0143, fix-b, wave 02
const rng = mulberry32(SEED);

function buildConcernWorkspace(concerns: readonly Concern[]): string {
  const ws = makeWorkspace(`concerns${concerns.length}-${Math.floor(rng() * 1e9).toString(36)}`);
  for (const c of concerns) writeFile(ws, c.relPath, c.content);
  writeFile(ws, "package.json", `${JSON.stringify({ name: "concern-fixture", version: "0.0.0", private: true }, null, 2)}\n`);
  return ws;
}

function buildCompoundQuery(lead: string, concerns: readonly Concern[]): string {
  const phrases = concerns.map((c) => `how ${c.phrase}`);
  if (phrases.length === 1) return `${lead} ${phrases[0]}.`;
  const head = phrases.slice(0, -1).join(", ");
  return `${lead} ${head}, and ${phrases[phrases.length - 1]}.`;
}

// ---------------------------------------------------------------------------
// MATRIX-B: concern count (2, 3, 4, 6) x presence (all present / one absent)
// ---------------------------------------------------------------------------

describe("concern retention — MATRIX-B: concern count x presence", () => {
  for (const config of CONFIG_NAMES as readonly ConfigName[]) {
    describe(`config=${config}`, () => {
      for (const count of [2, 3, 4, 6] as const) {
        it(`${count} concerns, all present`, async () => {
          const concerns = CONCERN_POOL.slice(0, count);
          const ws = buildConcernWorkspace(concerns);
          const query = buildCompoundQuery("Explain", concerns);
          const s = await server(ws, config);
          const chain = await followNextToEnd(s, { tool: "read_file", arguments: { query, task: { epoch: "new", profile: "answer" }, cwd: ws } }, { cwd: ws, hopCap: 24 });
          const ok = reachedAnswerWithCoverage(chain, concerns.map((c) => c.evidence));
          expect(
            ok,
            `query=${JSON.stringify(query)} evidence=${JSON.stringify(concerns.map((c) => anyEvidenceContains(chain, c.evidence)))} hops=${chain.hops.length}`,
          ).toBe(true);
        }, 60_000);

        it(`${count} concerns, one absent (never silently dropped: served, disclosed absent, or named unresolved)`, async () => {
          const present = CONCERN_POOL.slice(0, count - 1);
          const absent = CONCERN_POOL[count - 1]!; // never written to disk, never mentioned by any other fixture file
          const concerns = [...present, absent];
          const ws = buildConcernWorkspace(present); // the absent concern's own file is NEVER created
          const query = buildCompoundQuery("Explain", concerns);
          const s = await server(ws, config);
          const chain = await followNextToEnd(s, { tool: "read_file", arguments: { query, task: { epoch: "new", profile: "answer" }, cwd: ws } }, { cwd: ws, hopCap: 24 });

          for (const c of present) {
            expect(anyEvidenceContains(chain, c.evidence), `present concern ${c.phrase} must be served somewhere in the chain`).toBe(true);
          }
          // The absent concern must NEVER be silently missing from the whole
          // conversation: either (a) its own evidence markers somehow exist
          // (impossible here — its file was never written, but guarded for
          // fixture-bug safety), (b) it is disclosed absent (a gap/certificate
          // entry naming its own wording), or (c) it is named `unresolved`.
          // "No trace of it anywhere" is the ONE forbidden outcome (silent drop).
          const disclosures = collectDisclosureTexts(chain);
          const absentWords = absent.phrase.split(/\s+/u).filter((w) => w.length >= 4);
          const disclosedAbsent = anyDisclosureMatches(disclosures, absentWords);
          const namedUnresolved = anyRequestItemGapNamed(chain);
          const spuriouslyServed = anyEvidenceContains(chain, absent.evidence);
          expect(
            disclosedAbsent || namedUnresolved || spuriouslyServed,
            `the absent concern (${absent.phrase}) left NO trace at all -- silent drop. disclosures=${JSON.stringify(disclosures)}`,
          ).toBe(true);
          // Never a noise file (another concern's own module, or package.json)
          // reported as satisfying the absent concern.
          const servedPaths = [...servedEvidencePaths(chain)];
          expect(servedPaths).not.toContain(absent.relPath);
        }, 60_000);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// MATRIX-A (server-level sample): every lead once, every joiner once,
// paired round-robin (7 leads > 6 joiners) so the SAME pairing set the pure
// layer (headWhAfterReadLead.spec.ts) proves exhaustively is also confirmed
// through the real end-to-end pipeline, at bounded cost (both configs).
// ---------------------------------------------------------------------------

// r-b2 (2026-09-21, review finding B4): widened past fix-b's original 7
// read-verb leads to the reviewer's own >=12-lead axis, INCLUDING non-read
// imperatives that carry no lead verb from the closed `READ_VERB_LEAD_EN_RE`
// vocabulary at all — proving the generalised rule end-to-end through the
// real server, not only at the pure-predicate layer
// (headWhAfterReadLead.spec.ts).
const SAMPLE_LEADS = [
  "Explain", "Describe", "Tell me", "Clarify", "Show me", "Please explain", "Can you explain",
  "Trace", "Walk me through", "I want to understand", "Outline", "Document", "Give me an overview of",
] as const;
const SAMPLE_JOINERS: ReadonlyArray<(a: string, b: string) => string> = [
  (a, b) => `how ${a} and how ${b}`,
  (a, b) => `how ${a}, and how ${b}`,
  (a, b) => `how ${a}; also how ${b}`,
  (a, b) => `how ${a} as well as how ${b}`,
  (a, _b) => `how ${a}`, // paired with a second bulleted line below
  (a, _b) => `how ${a}`, // paired with a second numbered line below
  (a, b) => `how ${a} plus how ${b}`,
  (a, b) => `how ${a} along with how ${b}`,
];
const SAMPLE_JOINER_NAMES = [
  " and how", ", and how", "; also", " as well as how", "bullet list", "numbered list",
  " plus how", " along with how",
] as const;

function buildSampleQuery(lead: string, joinerIndex: number, a: string, b: string): string {
  const body = SAMPLE_JOINERS[joinerIndex]!(a, b);
  if (SAMPLE_JOINER_NAMES[joinerIndex] === "bullet list") return `- ${lead} ${body}.\n- how ${b}.`;
  if (SAMPLE_JOINER_NAMES[joinerIndex] === "numbered list") return `1. ${lead} ${body}.\n2. how ${b}.`;
  const suffix = lead === "Can you explain" ? "?" : ".";
  return `${lead} ${body}${suffix}`;
}

describe("concern retention — MATRIX-A sample: every lead once, every joiner once (round-robin)", () => {
  for (const config of CONFIG_NAMES as readonly ConfigName[]) {
    describe(`config=${config}`, () => {
      SAMPLE_LEADS.forEach((lead, i) => {
        const joinerIndex = i % SAMPLE_JOINER_NAMES.length;
        const joinerName = SAMPLE_JOINER_NAMES[joinerIndex]!;
        it(`${lead} / ${joinerName}`, async () => {
          const [a, b] = [CONCERN_POOL[0]!, CONCERN_POOL[1]!];
          const ws = buildConcernWorkspace([a, b]);
          const query = buildSampleQuery(lead, joinerIndex, a.phrase, b.phrase);
          const s = await server(ws, config);
          const chain = await followNextToEnd(s, { tool: "read_file", arguments: { query, task: { epoch: "new", profile: "answer" }, cwd: ws } }, { cwd: ws, hopCap: 20 });
          expect(
            reachedAnswerWithCoverage(chain, [a.evidence, b.evidence]),
            `query=${JSON.stringify(query)} evidenceA=${anyEvidenceContains(chain, a.evidence)} evidenceB=${anyEvidenceContains(chain, b.evidence)}`,
          ).toBe(true);
        }, 60_000);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// MATRIX-A2 (r-b2, 2026-09-21, review finding B4): the SAME widened lead x
// joiner round-robin, but the 2nd concern is ABSENT from the workspace —
// MATRIX-B above already proves this axis exhaustively for "Explain"; this
// bounded sample (round-robin, not a full cross product, to keep spawned-
// server cost down) proves the widened leads/joiners ALSO disclose rather
// than silently certify when paired with a genuinely missing concern —
// oracle: never a bare `act.answer` that omits all trace of the absent
// concern (same "disclosed OR named unresolved OR served" oracle MATRIX-B
// uses, via `anyDisclosureMatches`/`anyRequestItemGapNamed`).
// ---------------------------------------------------------------------------

const ABSENT_SAMPLE_LEADS = ["Trace", "Walk me through", "Outline", "Give me an overview of"] as const;
const ABSENT_SAMPLE_JOINER_NAMES = [" and how", " plus how", " along with how", "; also"] as const;

describe("concern retention — MATRIX-A2 sample: widened lead x joiner, 2nd concern ABSENT (round-robin)", () => {
  for (const config of CONFIG_NAMES as readonly ConfigName[]) {
    describe(`config=${config}`, () => {
      ABSENT_SAMPLE_LEADS.forEach((lead, i) => {
        const joinerName = ABSENT_SAMPLE_JOINER_NAMES[i % ABSENT_SAMPLE_JOINER_NAMES.length]!;
        const joinerIndex = SAMPLE_JOINER_NAMES.indexOf(joinerName);
        it(`${lead} / ${joinerName}`, async () => {
          const present = CONCERN_POOL[0]!;
          const absent = CONCERN_POOL[1]!; // never written to disk
          const ws = buildConcernWorkspace([present]);
          const query = buildSampleQuery(lead, joinerIndex, present.phrase, absent.phrase);
          const s = await server(ws, config);
          const chain = await followNextToEnd(s, { tool: "read_file", arguments: { query, task: { epoch: "new", profile: "answer" }, cwd: ws } }, { cwd: ws, hopCap: 24 });
          expect(anyEvidenceContains(chain, present.evidence), `present concern must be served: ${JSON.stringify(query)}`).toBe(true);
          const disclosures = collectDisclosureTexts(chain);
          const absentWords = absent.phrase.split(/\s+/u).filter((w) => w.length >= 4);
          const disclosedAbsent = anyDisclosureMatches(disclosures, absentWords);
          const namedUnresolved = anyRequestItemGapNamed(chain);
          const spuriouslyServed = anyEvidenceContains(chain, absent.evidence);
          expect(
            disclosedAbsent || namedUnresolved || spuriouslyServed,
            `absent concern (${absent.phrase}) left no trace: query=${JSON.stringify(query)} disclosures=${JSON.stringify(disclosures)}`,
          ).toBe(true);
        }, 60_000);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Japanese, end to end
// ---------------------------------------------------------------------------

describe("concern retention — Japanese", () => {
  function buildJaWorkspace(): string {
    const ws = makeWorkspace("ja");
    writeFile(ws, "src/auth/credentials.ts", CONCERN_POOL[0]!.content);
    writeFile(ws, "src/migrations/runner.ts", CONCERN_POOL[1]!.content);
    writeFile(ws, "package.json", `${JSON.stringify({ name: "ja-fixture" }, null, 2)}\n`);
    return ws;
  }

  for (const config of CONFIG_NAMES as readonly ConfigName[]) {
    it(`config=${config}: two real JA questions ("...か。また、...か。") are BOTH retained (tracked), never silently dropped`, async () => {
      // This is the retention half of TL-02, which is this fix's own
      // mandate: confirms `headIsWhAfterReadLead`/H-2 correctly splits and
      // tracks BOTH JA clauses as independent questions (see this file's own
      // header + headWhAfterReadLead.spec.ts's JA describe block for the
      // JA_QUESTION_END_RE "か。" fix this depends on).
      //
      // FIX-C update (2026-09-21, TL-03 landed): a clause the JA vocabulary
      // bridge can resolve (see the cell just below, now flipped to
      // passing) typically PROVES OUTRIGHT — real evidence served — rather
      // than ever becoming a disclosed gap, because a proved obligation has
      // nothing left to disclose. "Tracked, never silently dropped" now
      // means EITHER named in a disclosure (still-open) OR its own real
      // evidence is somewhere on the wire — matching MATRIX-B's own
      // "never silently dropped" oracle just above. "No trace anywhere" —
      // neither named nor served — is the one forbidden outcome.
      const ws = buildJaWorkspace();
      const query = "認証情報はどこで検証されますか。また、データベースのマイグレーションはどのように実行されますか。";
      const s = await server(ws, config);
      const chain = await followNextToEnd(s, { tool: "read_file", arguments: { query, task: { epoch: "new", profile: "answer" }, cwd: ws } }, { cwd: ws, hopCap: 20 });
      const disclosures = collectDisclosureTexts(chain);
      const credentialTracked = disclosures.some((t) => /ri-1/u.test(t)) || anyEvidenceContains(chain, CONCERN_POOL[0]!.evidence);
      const migrationTracked = disclosures.some((t) => /ri-2/u.test(t)) || anyEvidenceContains(chain, CONCERN_POOL[1]!.evidence);
      expect(
        credentialTracked,
        `ri-1 (credential concern) neither named nor served; disclosures=${JSON.stringify(disclosures)}`,
      ).toBe(true);
      expect(
        migrationTracked,
        `ri-2 (migration concern) neither named nor served; disclosures=${JSON.stringify(disclosures)}`,
      ).toBe(true);
    }, 60_000);

    // FIXED (fix-c, 2026-09-21, TL-03): was a CONFIRMED, SEPARATE,
    // FIX-C-owned defect, registered per brief-fix-b.md's own instruction
    // ("if a cell fails ONLY because of a false absence, mark it pending
    // for TL-03") and left as `it.fails` for FIX-C to resolve.
    // `distinctiveSalientAbsence`/`proveUnbindableRequestItem`
    // (readCodeTaskPack.ts) used `salientWords()` over the JA clause
    // verbatim (a whole unsegmented JA clause reduces to ONE token per
    // arch-map-b.md's own TL-03 finding) and never consulted
    // `jaBridgeExpansionTokens`/the JA glossary the absence side depends
    // on — so a literal scan against the ENGLISH source always missed, and
    // BOTH concerns were certified "request-item-absent" even though both
    // `validateCredentials`/`runPendingMigrations` genuinely exist. Both
    // scanners now route every candidate word through ONE normalised-variant
    // generator (`concernTermVariants`, C2) that includes the SAME
    // workspace-vocabulary-gated JA bridge retrieval uses, so a served
    // surface's own bridged vocabulary now correctly answers the clause —
    // this cell now reaches a genuine `act.answer` with both concerns'
    // real evidence served, verified below. Flipped from `it.fails` to
    // `it()` per this file's/`replayCorpus.spec.ts`'s own convention: an
    // `it.fails` that starts passing must never stay registered "for
    // safety".
    it(`config=${config}: JA absence proof now uses the vocabulary bridge, so both concerns resolve to real evidence`, async () => {
      const ws = buildJaWorkspace();
      const query = "認証情報はどこで検証されますか。また、データベースのマイグレーションはどのように実行されますか。";
      const s = await server(ws, config);
      const chain = await followNextToEnd(s, { tool: "read_file", arguments: { query, task: { epoch: "new", profile: "answer" }, cwd: ws } }, { cwd: ws, hopCap: 20 });
      expect(
        reachedAnswerWithCoverage(chain, [CONCERN_POOL[0]!.evidence, CONCERN_POOL[1]!.evidence]),
        `evidenceA=${anyEvidenceContains(chain, CONCERN_POOL[0]!.evidence)} evidenceB=${anyEvidenceContains(chain, CONCERN_POOL[1]!.evidence)}`,
      ).toBe(true);
    }, 60_000);

    // KNOWN LIMIT (documented, not fixed by this change — see
    // headWhAfterReadLead.spec.ts's own JA describe block and arch-map-b.md
    // open question 1): a JA read-lead compound phrased as two NOUN-PHRASE
    // objects of one trailing "説明してください" (no embedded か-question in
    // either half) is not recognized as 2 independent questions by this
    // fix's own predicate. Retention (the item count staying 2, so the
    // mechanism at least ENGAGES) is unaffected and asserted directly at the
    // pure layer; this server-level cell is registered `it.fails` so a
    // regression that makes it WORSE (e.g. drops back to 1 item) is caught,
    // while a future fix that makes it pass is a visible, expected signal.
    it.fails(`config=${config}: KNOWN LIMIT — JA read-lead compound noun-phrase object (open question, not H-2-blocking)`, async () => {
      const ws = buildJaWorkspace();
      const query = "認証情報の検証方法と、データベースマイグレーションの実行方法を説明してください。";
      const s = await server(ws, config);
      const chain = await followNextToEnd(s, { tool: "read_file", arguments: { query, task: { epoch: "new", profile: "answer" }, cwd: ws } }, { cwd: ws, hopCap: 20 });
      expect(reachedAnswerWithCoverage(chain, [CONCERN_POOL[0]!.evidence, CONCERN_POOL[1]!.evidence])).toBe(true);
    }, 60_000);
  }
});

// ---------------------------------------------------------------------------
// Server-level controls
// ---------------------------------------------------------------------------

describe("concern retention — server-level controls", () => {
  for (const config of CONFIG_NAMES as readonly ConfigName[]) {
    it(`config=${config}: a single-concern question reaches act.answer with no request-item gap at all`, async () => {
      const ws = buildConcernWorkspace([CONCERN_POOL[0]!]);
      const query = `Explain how ${CONCERN_POOL[0]!.phrase}.`;
      const s = await server(ws, config);
      const chain = await followNextToEnd(s, { tool: "read_file", arguments: { query, task: { epoch: "new", profile: "answer" }, cwd: ws } }, { cwd: ws, hopCap: 10 });
      const idx = firstAnswerHopIndex(chain);
      expect(idx, `chain never reached act.answer: ${JSON.stringify(chain.hops.map((h) => h.response?.decision?.kind))}`).toBeDefined();
      expect(anyRequestItemGapNamed(chain)).toBe(false);
    }, 60_000);

    it(`config=${config}: an edit request containing ' and how ' is untouched -- generic profile, routing unchanged`, async () => {
      const ws = makeWorkspace("edit-and-how");
      writeFile(
        ws,
        "src/retry.ts",
        [
          "export const MAX_RETRIES = 3;",
          "export function computeRetryDelayMs(base: number, attempt: number): number {",
          "  return base * Math.pow(2, attempt);",
          "}",
          "",
        ].join("\n"),
      );
      const query = "Change MAX_RETRIES to 5 in src/retry.ts and how backoff works.";
      const s = await server(ws, config);
      const chain = await followNextToEnd(s, { tool: "read_file", arguments: { query, task: { epoch: "new", profile: "generic" }, cwd: ws } }, { cwd: ws, hopCap: 10 });
      // Routing must still be able to reach an edit-ready state over
      // src/retry.ts -- this fix's own predicate is read-lead-only and never
      // engages for a mutation-verb-led clause, so a bare "and how" tail must
      // not change which file(s) an edit-profile request can write.
      const decisionKinds = chain.hops.map((h) => h.response?.decision?.kind).filter((k) => k !== undefined);
      expect(decisionKinds.some((k) => k === "act.edit" || k === "discover" || k === "await_input"), JSON.stringify(decisionKinds)).toBe(true);
    }, 60_000);

    it(`config=${config}: recall control -- a clause that really asks about docs IS covered by the README (B5)`, async () => {
      const ws = makeWorkspace("doc-recall");
      writeFile(ws, CONCERN_POOL[0]!.relPath, CONCERN_POOL[0]!.content);
      writeFile(
        ws,
        "README.md",
        "# doc-recall fixture\n\nRelease process documentation: tag the commit, run the publish script, then update the changelog.\n",
      );
      const query = `Explain how ${CONCERN_POOL[0]!.phrase} and what the README documentation says about the release process.`;
      const s = await server(ws, config);
      const chain = await followNextToEnd(s, { tool: "read_file", arguments: { query, task: { epoch: "new", profile: "answer" }, cwd: ws } }, { cwd: ws, hopCap: 10 });
      expect(anyEvidenceContains(chain, ["Release process"])).toBe(true);
    }, 60_000);
  }
});
