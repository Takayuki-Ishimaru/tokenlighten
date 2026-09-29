/**
 * concernStatusPolicyMatrix.spec.ts — FIX-C2 (2026-09-21).
 *
 * The attack matrix for the ONE concern-status policy
 * (`readCodeTaskPack.ts`'s `concernCoveredByServedEvidence` /
 * `decideConcernStatus`): every request-item path must decide a concern's
 * status by the same rule, and the four invariants must hold on every cell.
 *
 *   {EN read-lead enumeration, EN "and how", EN numbered list,
 *    JA particle compound, JA 「また」 two-question, JA numbered}
 *   x {2, 4 concerns}
 *   x {all implemented; one absent (known terms); one absent (coined,
 *      unbridgeable concept); one implemented only under a derived name;
 *      one named ONLY in README prose; every clause reduced to ONE topic word}
 *   x chain shapes {follow `next` to the end; then a bare `{qref}` re-pack;
 *      then the same query restated}
 *   x {default, vscode}
 *
 * INVARIANTS CHECKED PER CELL
 *   (i)   covered => never absent in the SAME response: no hop may both serve
 *         a concern's implementing marker and disclose that concern's own
 *         topic wording as absent.
 *   (ii)  a re-pack in the same epoch never makes a covered concern
 *         un-covered: the final `decision.kind` is identical after the
 *         bare-`{qref}` re-pack and after the same query restated.
 *   (iii) certified `act.answer` <=> every concern is covered or
 *         absent-and-disclosed: a certifying chain must have served every
 *         IMPLEMENTED concern's own module and must have disclosed every
 *         genuinely ABSENT concern; a non-certifying chain must name
 *         something unresolved rather than stop silently.
 *   (iv)  the chain terminates: never capped, and no `next` whose execution
 *         only ever produces a bodyless receipt (an oscillation).
 *
 * The fixtures are neutral and generated: no identifier, path or phrase here
 * comes from a benchmark fixture or from the improvement plan, and nothing in
 * the product keys on any of them (brief-common.md rule 5).
 *
 * Runtime: ONE spawned server per (config, concern-count, fixture variant) —
 * 24 servers, each driving 6 phrasings — rather than one per cell, since a
 * cell's own state lives entirely in its `task.epoch:"new"` chain.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import {
  CONFIG_NAMES,
  followNextToEnd,
  startDevServer,
  type ChainResult,
  type ConfigName,
  type ServerHandle,
} from "./helpers/qualityFirstScenarios.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();

// ---------------------------------------------------------------------------
// Neutral concern catalogue
// ---------------------------------------------------------------------------

interface ConcernSpec {
  key: string;
  /** Full EN clause body, used after a "how" ("how the discount rate is computed"). */
  en: string;
  /** EN clause body under a DERIVED name only (the `derived-name` variant). */
  enDerived: string;
  /** Single EN topic word (the `one-topic-word` variant). */
  enWord: string;
  /** JA clause body ("割引率の算出"). */
  ja: string;
  relPath: string;
  /** The declared symbol that proves this concern's own body was served. */
  marker: string;
  source: string;
  /**
   * Lowercase fragments a disclosure naming THIS concern would contain — every
   * topic word of the concern's own clause. R-B3 (2026-09-21, rulings 1-2):
   * a disclosure names the concern by the word that is provably absent, and
   * a README-only concern whose name and file DO occur (in prose) is
   * disclosed by the clause word that occurs nowhere ("tokens",
   * "resolved"), so the predicate/second-noun stems are listed too.
   */
  disclosureHints: readonly string[];
}

const CONCERNS: readonly ConcernSpec[] = [
  {
    key: "discount",
    en: "the discount rate is computed",
    enDerived: "discount computation is performed",
    enWord: "discount",
    ja: "割引率の算出",
    relPath: "src/discountRate.ts",
    marker: "computeDiscountRate",
    source: [
      "export interface TierRates { gold: number; silver: number; }",
      "export function computeDiscountRate(tier: string, rates: TierRates): number {",
      '  if (tier === "gold") return rates.gold;',
      '  if (tier === "silver") return rates.silver;',
      "  return 0;",
      "}",
      "",
    ].join("\n"),
    disclosureHints: ["discount", "割引", "comput"],
  },
  {
    key: "renewal",
    en: "session tokens are renewed",
    enDerived: "session renewal is carried out",
    enWord: "renewal",
    ja: "セッショントークンの更新",
    relPath: "src/sessionRenewal.ts",
    marker: "renewSessionToken",
    source: [
      "export interface SessionToken { value: string; issuedAtMs: number; }",
      "export function renewSessionToken(token: SessionToken, nowMs: number): SessionToken {",
      "  return { value: `${token.value}.${nowMs}`, issuedAtMs: nowMs };",
      "}",
      "",
    ].join("\n"),
    disclosureHints: ["renew", "session", "token", "セッション"],
  },
  {
    key: "enqueue",
    en: "jobs are enqueued",
    enDerived: "job enqueueing is handled",
    enWord: "enqueue",
    ja: "ジョブの登録",
    relPath: "src/jobQueue.ts",
    marker: "enqueueJob",
    source: [
      "export interface Job { id: string; payload: string; }",
      "const pending: Job[] = [];",
      "export function enqueueJob(job: Job): number {",
      "  pending.push(job);",
      "  return pending.length;",
      "}",
      "",
    ].join("\n"),
    disclosureHints: ["enqueue", "job", "ジョブ"],
  },
  {
    key: "locale",
    en: "the locale tag is resolved",
    enDerived: "locale resolution is applied",
    enWord: "locale",
    ja: "ロケールタグの解決",
    relPath: "src/localeTag.ts",
    marker: "resolveLocaleTag",
    source: [
      "export function resolveLocaleTag(requested: string, supported: readonly string[]): string {",
      "  const exact = supported.find((tag) => tag === requested);",
      '  return exact ?? supported[0] ?? "und";',
      "}",
      "",
    ].join("\n"),
    disclosureHints: ["locale", "ロケール", "resolv"],
  },
];

/** A coined concept no glossary or inflection rule can reach — the "unknown concept" column. */
const COINED = {
  en: "the vantrel handoff is arbitrated",
  enWord: "vantrel",
  ja: "ヴァントレル調停",
  disclosureHints: ["vantrel", "ヴァントレル"],
} as const;

type VariantId =
  | "all-implemented"
  | "absent-known"
  | "absent-coined"
  | "derived-name"
  | "readme-only"
  | "one-topic-word";

const VARIANTS: readonly VariantId[] = [
  "all-implemented",
  "absent-known",
  "absent-coined",
  "derived-name",
  "readme-only",
  "one-topic-word",
];

type PhrasingId = "en-read-lead" | "en-and-how" | "en-numbered" | "ja-particle" | "ja-mata" | "ja-numbered";

const PHRASINGS: readonly PhrasingId[] = ["en-read-lead", "en-and-how", "en-numbered", "ja-particle", "ja-mata", "ja-numbered"];

/**
 * Whether this phrasing's clauses are INDEPENDENT QUESTIONS — the only shape
 * the design lets a request item BLOCK on. `readCodeTaskPack.ts`'s all-topic
 * branch deliberately mints no blocking obligation for ordinary multi-clause
 * prose (invariant (iv), guarding replay `d12a` / the "observed directory
 * task_pack" case): it DISCLOSES an absence there but never demands evidence.
 * A JA 「…と、…について説明してください」 enumeration is exactly that prose
 * shape (`headIsWhAfterReadLead` is false for each clause), so a certifying
 * chain is allowed to answer from whatever the ranker selected. Every other
 * phrasing here is wh-headed and DOES block, so for those a certificate must
 * be backed by each implemented concern's own served body.
 */
const PHRASING_BLOCKS_ON_CONCERNS: Readonly<Record<PhrasingId, boolean>> = {
  "en-read-lead": true,
  "en-and-how": true,
  "en-numbered": true,
  "ja-particle": false,
  "ja-mata": true,
  "ja-numbered": true,
};

// ---------------------------------------------------------------------------
// Fixture + query generation
// ---------------------------------------------------------------------------

/** Which concerns this cell's workspace actually implements, and under which clause wording. */
interface Cell {
  concerns: readonly ConcernSpec[];
  /** Index (into `concerns`) of the concern that is NOT implemented, or -1. */
  absentIndex: number;
  variant: VariantId;
}

function cellFor(concernCount: number, variant: VariantId): Cell {
  const concerns = CONCERNS.slice(0, concernCount);
  const absentIndex = variant === "absent-known" || variant === "absent-coined" || variant === "readme-only"
    ? concerns.length - 1
    : -1;
  return { concerns, absentIndex, variant };
}

function buildMatrixWorkspace(root: string, cell: Cell): void {
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  for (let index = 0; index < cell.concerns.length; index += 1) {
    if (index === cell.absentIndex) continue;
    const concern = cell.concerns[index]!;
    fs.writeFileSync(path.join(root, concern.relPath), concern.source, "utf8");
  }
  // Ordinary repository furniture, present in every cell.
  fs.writeFileSync(
    path.join(root, "src", "textWidth.ts"),
    "export function textWidth(value: string): number {\n  return [...value].length;\n}\n",
    "utf8",
  );
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "matrix-fixture", version: "0.0.0", private: true }, null, 2) + "\n", "utf8");
  const readmeLines = ["# Matrix fixture", ""];
  if (cell.variant === "readme-only") {
    const missing = cell.concerns[cell.absentIndex]!;
    readmeLines.push(`This project documents ${missing.enWord} handling in \`${missing.relPath}\`, which is not part of this checkout.`, "");
  }
  readmeLines.push("Generated fixture for the concern-status policy matrix.", "");
  fs.writeFileSync(path.join(root, "README.md"), readmeLines.join("\n"), "utf8");
}

/** The clause body for concern `index` under this cell's variant. */
function clauseEn(cell: Cell, index: number): string {
  const concern = cell.concerns[index]!;
  if (index === cell.absentIndex && cell.variant === "absent-coined") return COINED.en;
  if (cell.variant === "one-topic-word") return `${concern.enWord} works`;
  if (cell.variant === "derived-name") return concern.enDerived;
  return concern.en;
}

function clauseJa(cell: Cell, index: number): string {
  const concern = cell.concerns[index]!;
  if (index === cell.absentIndex && cell.variant === "absent-coined") return COINED.ja;
  return concern.ja;
}

function buildQuery(cell: Cell, phrasing: PhrasingId): string {
  const n = cell.concerns.length;
  const en = Array.from({ length: n }, (_, i) => clauseEn(cell, i));
  const ja = Array.from({ length: n }, (_, i) => clauseJa(cell, i));
  switch (phrasing) {
    case "en-read-lead":
      return `Explain how ${en.map((clause, i) => (i === n - 1 && n > 1 ? `and how ${clause}` : `how ${clause}`)).join(", ").replace(/^how /, "")}.`;
    case "en-and-how":
      return `Explain how ${en.join(" and how ")}.`;
    case "en-numbered":
      return en.map((clause, i) => `${i + 1}. How ${clause}?`).join("\n");
    case "ja-particle":
      return `${ja.join("と、")}について説明してください。`;
    case "ja-mata":
      return ja.map((clause, i) => (i === 0 ? `${clause}はどのように行われますか。` : `また、${clause}はどのように行われますか。`)).join("");
    case "ja-numbered":
    default:
      return ja.map((clause, i) => `${i + 1}. ${clause}はどのように行われますか。`).join("\n");
  }
}

// ---------------------------------------------------------------------------
// Oracle
// ---------------------------------------------------------------------------

function pick(obj: unknown, keyPath: string): any {
  return keyPath.split(".").reduce((acc: any, key) => (acc == null ? undefined : acc[key]), obj);
}

function disclosureTextsOf(response: any): string[] {
  const out: string[] = [];
  for (const source of [pick(response, "decision.certificate.gaps"), pick(response, "decision.gaps"), pick(response, "decision.unresolved")]) {
    if (!Array.isArray(source)) continue;
    for (const entry of source) {
      if (typeof entry === "string") out.push(entry);
      else if (entry && typeof entry === "object") {
        const obj = entry as Record<string, unknown>;
        const refs = Array.isArray(obj["refs"]) ? (obj["refs"] as unknown[]).filter((v) => typeof v === "string") : [];
        out.push([obj["code"], obj["kind"], obj["id"], obj["reason"], ...refs].filter((v) => typeof v === "string").join(" "));
      }
    }
  }
  return out;
}

function responseServesMarker(response: unknown, marker: string): boolean {
  const evidence = (response as any)?.evidence;
  if (!Array.isArray(evidence)) return false;
  return evidence.some((entry: any) => typeof entry?.body === "string" && entry.body.includes(marker));
}

function chainServesMarker(chain: ChainResult, marker: string): boolean {
  return chain.hops.some((hop) => responseServesMarker(hop.response, marker));
}

function mentionsAny(texts: readonly string[], hints: readonly string[]): boolean {
  return texts.some((text) => {
    const lower = text.toLowerCase();
    return hints.some((hint) => lower.includes(hint.toLowerCase()));
  });
}

function finalKindOf(chain: ChainResult): string {
  for (let i = chain.hops.length - 1; i >= 0; i -= 1) {
    const kind = pick(chain.hops[i]!.response, "decision.kind");
    if (typeof kind === "string") return kind;
  }
  return "none";
}

interface CellFailure {
  invariant: string;
  detail: string;
}

/**
 * `servedSoFar` is the CUMULATIVE set of concern markers this cell has seen
 * on the wire across every chain shape it has run so far. A same-epoch
 * re-pack legitimately serves no bodies at all (the caller already holds
 * them — that is the whole point of the dedup/receipt contract), so
 * "certification implies the evidence was served" can only be judged against
 * what the CALLER holds for this task, never against one chain's own hops.
 */
function auditChain(cell: Cell, chain: ChainResult, label: string, servedSoFar: ReadonlySet<string>, blocksOnConcerns: boolean): CellFailure[] {
  const failures: CellFailure[] = [];
  // (iv) termination.
  if (chain.capped) failures.push({ invariant: "iv", detail: `${label}: chain hit the hop cap (oscillation or no progress)` });

  // (i) no hop may serve a concern's implementation AND call it absent.
  for (let index = 0; index < cell.concerns.length; index += 1) {
    if (index === cell.absentIndex) continue;
    const concern = cell.concerns[index]!;
    for (const hop of chain.hops) {
      if (!responseServesMarker(hop.response, concern.marker)) continue;
      const texts = disclosureTextsOf(hop.response).filter((t) => /absent|not (?:found|located)|no occurrence/i.test(t));
      if (mentionsAny(texts, concern.disclosureHints)) {
        failures.push({ invariant: "i", detail: `${label}: hop ${hop.hopIndex} serves ${concern.marker} and calls ${concern.key} absent: ${JSON.stringify(texts)}` });
      }
    }
  }

  const finalKind = finalKindOf(chain);
  const finalResponse = chain.hops[chain.hops.length - 1]?.response;

  if (finalKind === "act.answer") {
    // (iii) certification implies every implemented concern's own body is served.
    for (let index = 0; blocksOnConcerns && index < cell.concerns.length; index += 1) {
      if (index === cell.absentIndex) continue;
      const concern = cell.concerns[index]!;
      if (!servedSoFar.has(concern.marker)) {
        failures.push({ invariant: "iii", detail: `${label}: certified act.answer without ever serving ${concern.marker} (${concern.key})` });
      }
    }
    // (iii) certification implies a genuinely absent concern is disclosed.
    // Judged over THIS chain's own disclosures: a certificate that claims
    // completeness must carry the disclosure itself, not rely on an earlier
    // hop of a different chain having mentioned it.
    if (cell.absentIndex >= 0) {
      const hints = cell.variant === "absent-coined"
        ? COINED.disclosureHints
        : cell.concerns[cell.absentIndex]!.disclosureHints;
      const allTexts = chain.hops.flatMap((hop) => disclosureTextsOf(hop.response));
      if (!mentionsAny(allTexts, hints)) {
        failures.push({ invariant: "iii", detail: `${label}: certified act.answer without disclosing the absent concern; disclosures=${JSON.stringify(allTexts)}` });
      }
    }
  } else if (finalKind === "await_input" || finalKind === "await-input") {
    // (iii) an await_input must NAME what is unresolved — never stop silently.
    const unresolved = pick(finalResponse, "decision.unresolved");
    if (!Array.isArray(unresolved) || unresolved.length === 0) {
      failures.push({ invariant: "iii", detail: `${label}: await_input names nothing unresolved` });
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];
const servers: ServerHandle[] = [];

// One server per `it` (never shared across cells — see header): stop it
// when that test ends so the 24 (config x concernCount x variant) cells
// never hold all their servers alive at once.
afterEach(async () => {
  for (const server of servers.splice(0)) await server.kill();
});

afterAll(async () => {
  for (const server of servers.splice(0)) await server.kill();
  for (const dir of tmpDirs.splice(0)) {
    try {
      await rmDirWithRetry(dir);
    } catch {
      /* best-effort */
    }
  }
});

async function runCell(server: ServerHandle, ws: string, cell: Cell, phrasing: PhrasingId): Promise<CellFailure[]> {
  const query = buildQuery(cell, phrasing);
  const blocksOnConcerns = PHRASING_BLOCKS_ON_CONCERNS[phrasing];
  const failures: CellFailure[] = [];

  const served = new Set<string>();
  const recordServed = (chain: ChainResult): void => {
    for (const concern of cell.concerns) {
      if (chainServesMarker(chain, concern.marker)) served.add(concern.marker);
    }
  };

  const followed = await followNextToEnd(
    server,
    { tool: "read_file", arguments: { query, task: { epoch: "new", profile: "answer" }, cwd: ws } },
    { cwd: ws, hopCap: 12 },
  );
  recordServed(followed);
  failures.push(...auditChain(cell, followed, "follow", served, blocksOnConcerns));

  const qref = [...followed.hops].reverse().map((hop) => hop.response?.qref).find((value) => typeof value === "string");
  const followedKind = finalKindOf(followed);

  if (typeof qref === "string") {
    const repacked = await followNextToEnd(server, { tool: "read_file", arguments: { qref, cwd: ws } }, { cwd: ws, hopCap: 8, maxQrefRepacks: 0 });
    recordServed(repacked);
    failures.push(...auditChain(cell, repacked, "repack", served, blocksOnConcerns));
    const repackedKind = finalKindOf(repacked);
    // (ii) a same-epoch re-pack never returns a LESS complete decision.
    if (followedKind === "act.answer" && repackedKind !== "act.answer") {
      failures.push({ invariant: "ii", detail: `bare-qref re-pack regressed act.answer -> ${repackedKind}` });
    }
  }

  const restated = await followNextToEnd(
    server,
    { tool: "read_file", arguments: { query, cwd: ws } },
    { cwd: ws, hopCap: 8, maxQrefRepacks: 0 },
  );
  recordServed(restated);
  failures.push(...auditChain(cell, restated, "restate", served, blocksOnConcerns));
  const restatedKind = finalKindOf(restated);
  if (followedKind === "act.answer" && restatedKind !== "act.answer" && restatedKind !== "none") {
    failures.push({ invariant: "ii", detail: `restated query regressed act.answer -> ${restatedKind}` });
  }
  return failures;
}

for (const config of CONFIG_NAMES as readonly ConfigName[]) {
  describe(`concern-status policy matrix (config=${config})`, () => {
    for (const concernCount of [2, 4] as const) {
      for (const variant of VARIANTS) {
        // R-B1 (2026-09-21, held item 1): the former KNOWN LIMIT here — the
        // `derived-name` column at 4 concerns, where a passive-voice point
        // routed through the mixed-kind branch fell to `proveUnbindable-
        // RequestItem`'s "every literal-find candidate is served" close and
        // certified off ONE served line (`src/sessionRenewal.ts:1-1`) — is
        // closed: the mixed-kind fallbacks now pass `partialServeFrontier`, so
        // a partly served candidate keeps the point open with its unserved
        // window as the continuation. Every cell is a plain `it` again.
        it(
          `${concernCount} concerns / ${variant} — every phrasing holds invariants (i)-(iv)`,
          async () => {
            const cell = cellFor(concernCount, variant);
            const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-csm-${config}-${concernCount}-${variant.slice(0, 6)}-`));
            tmpDirs.push(ws);
            buildMatrixWorkspace(ws, cell);
            const server = startDevServer(ws, config);
            servers.push(server);
            await server.initialize();

            const failures: Array<{ phrasing: PhrasingId; failures: CellFailure[] }> = [];
            for (const phrasing of PHRASINGS) {
              const cellFailures = await runCell(server, ws, cell, phrasing);
              if (cellFailures.length > 0) failures.push({ phrasing, failures: cellFailures });
            }
            expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
          },
          180_000,
        );
      }
    }
  });
}
