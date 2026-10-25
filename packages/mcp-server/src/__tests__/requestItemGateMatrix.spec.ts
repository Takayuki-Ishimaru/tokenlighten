/**
 * R-B3 (2026-09-21) — the request-item COMPLETION GATE attack matrix, made
 * permanent.
 *
 * Built by R-B1 as a scratch harness (204 cells x 2 configs) and used through
 * four review rounds to cut the failing cells from 153/149 (clean HEAD,
 * default/VS Code) to the residual inventory below. Every cell: a neutral
 * workspace + a composite request of two concerns, followed verbatim along
 * `next` to the end, then re-packed by a bare `{qref}`, and judged by three
 * oracles that are properties of the WIRE, never of an implementation detail:
 *
 *  (a) no certified `act.answer` unless every implemented concern's own body
 *      was served (by the chains) and every non-implemented concern is
 *      disclosed;
 *  (b) no disclosure calls a concern absent while serving its body in the
 *      SAME response, and none calls an implemented concern absent at all;
 *      an absence over an unreadable file never claims "scope complete";
 *  (c) every response to a SERVER-MINTED call carries a decision or an
 *      executable `next`, and every chain reaches a terminal decision
 *      (`act.answer` / `act.edit` / `await_input` / `done`) within 6 hops.
 *
 * Axes: {12 leads incl. non-read imperatives} x {and / and also / as well as /
 * plus / along with / "; also" / newline / numbered} x {2nd concern
 * implemented | absent | unreadable} x {EN, JA particle compound, JA 「また」}
 * x {one small file, one large file, five files, a multi-package tree with a
 * WORD COLLISION (`inventory_files` in unrelated budget code)} plus the B3
 * cache queries on an expiry-named and a TTL-only cache. The default run
 * takes a SEEDED subset: every "anchor" cell (one per failure class this
 * matrix has ever found) plus a fixed-seed sample of the rest, both configs.
 * `TL_GATE_MATRIX_FULL=1` (test-only; no product code reads it) runs all 204
 * cells per config.
 *
 * `KNOWN_FAILURES` is the honest-residual inventory: a listed cell must still
 * fail with a subset of its listed classes (a NEW class fails the test), and a
 * listed cell that starts passing fails too, so the inventory can only shrink
 * by someone deleting its entry.
 */
import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { CONFIG_NAMES, startDevServer, type ConfigName, type ServerHandle } from "./helpers/qualityFirstScenarios.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const FULL = process.env["TL_GATE_MATRIX_FULL"] === "1";

// ---------------------------------------------------------------------------
// Fixtures (neutral, generated)
// ---------------------------------------------------------------------------

const REFUNDS_TS = [
  "export interface RefundRequest { orderId: string; amountCents: number; reason: string; }",
  "export function processRefund(request: RefundRequest, ledger: Map<string, number>): number {",
  "  const paid = ledger.get(request.orderId) ?? 0;",
  "  const granted = Math.min(paid, request.amountCents);",
  "  ledger.set(request.orderId, paid - granted);",
  "  return granted;",
  "}",
  "",
].join("\n");
const INVENTORY_TS = [
  "export interface StockLevel { sku: string; onHand: number; reorderPoint: number; }",
  "export function replenishInventory(level: StockLevel, batchSize: number): StockLevel {",
  "  if (level.onHand > level.reorderPoint) return level;",
  "  return { ...level, onHand: level.onHand + batchSize };",
  "}",
  "",
].join("\n");
const FORMAT_TS = "export function formatCents(cents: number): string {\n  return (cents / 100).toFixed(2);\n}\n";
function binaryBytes(): Buffer {
  const b = Buffer.alloc(900);
  for (let i = 0; i < b.length; i++) b[i] = (i * 37 + 11) % 256;
  b[0] = 0; b[1] = 0xff; b[2] = 0xfe; b[3] = 0;
  return b;
}
const CACHE_TTL_TS = [
  "export class Cache {",
  "  private m = new Map<string, { v: string; t: number }>();",
  "  constructor(private ttlMs: number) {}",
  "  get(k: string): string | undefined {",
  "    const e = this.m.get(k);",
  "    if (!e) return undefined;",
  "    if (Date.now() - e.t > this.ttlMs) { this.m.delete(k); return undefined; }",
  "    return e.v;",
  "  }",
  "  invalidate(k: string): void { this.m.delete(k); }",
  "}",
  "",
].join("\n");
const CACHE_TS = [
  "export class Cache<V> {",
  "  private readonly entries = new Map<string, { value: V; expiresAt: number }>();",
  "  constructor(private readonly ttlMs: number) {}",
  "  get(key: string): V | undefined {",
  "    const entry = this.entries.get(key);",
  "    if (!entry) return undefined;",
  "    if (entry.expiresAt <= Date.now()) { this.entries.delete(key); return undefined; }",
  "    return entry.value;",
  "  }",
  "  set(key: string, value: V): void { this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs }); }",
  "  invalidate(key: string): void { this.entries.delete(key); }",
  "}",
  "",
].join("\n");
/** Unrelated budget code whose only link to "inventory" is a field NAME — the word-collision shape. */
const WIRE_BUDGET_TS = [
  "export interface WireReport { inventory_files: number; served_bytes: number; }",
  "export function summarizeWire(report: WireReport): string {",
  "  const inventory_files = report.inventory_files;",
  "  return `${inventory_files} files, ${report.served_bytes} bytes`;",
  "}",
  "export function shedLargest(sizes: readonly number[], limit: number): number[] {",
  "  return [...sizes].sort((a, b) => b - a).filter((size) => size <= limit);",
  "}",
  "",
].join("\n");
const CODEC_TS = [
  "export function encodeFrame(payload: string): string {",
  "  return `${payload.length}:${payload}`;",
  "}",
  "export function decodeFrame(frame: string): string {",
  "  const colon = frame.indexOf(\":\");",
  "  return frame.slice(colon + 1);",
  "}",
  "",
].join("\n");

type Shape = "one-small" | "one-large" | "five" | "real" | "cache-one" | "cache-five" | "cachettl-one" | "cachettl-five";
type State = "implemented" | "absent" | "unreadable";

function write(root: string, rel: string, content: string | Buffer): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function buildWorkspace(shape: Shape, state: State, dir: string): void {
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  const manifest = (name: string): string => JSON.stringify({ name, version: "0.0.0", private: true }, null, 2) + "\n";
  switch (shape) {
    case "one-small":
      write(dir, "src/store.ts", state === "implemented" ? REFUNDS_TS + INVENTORY_TS : REFUNDS_TS);
      return;
    case "one-large": {
      const filler = Array.from({ length: 400 }, (_, i) => `  // bookkeeping note ${i + 1}: totals are reconciled nightly`).join("\n");
      const header = state === "implemented"
        ? "/**\n * Store module. Handles refunds and inventory replenishment.\n */\n"
        : "/**\n * Store module. Handles refunds.\n */\n";
      const tail = state === "implemented" ? INVENTORY_TS : "export const STORE_VERSION = 3;\n";
      write(dir, "src/store.ts", `${header}${REFUNDS_TS}export function noop(): void {\n${filler}\n}\n${tail}`);
      return;
    }
    case "five":
      write(dir, "src/refunds.ts", REFUNDS_TS);
      if (state === "implemented") write(dir, "src/inventory.ts", INVENTORY_TS);
      if (state === "unreadable") write(dir, "src/inventory.ts", binaryBytes());
      write(dir, "src/format.ts", FORMAT_TS);
      write(dir, "README.md", "# Shop fixture\n\nA small generated fixture.\n");
      write(dir, "package.json", manifest("shop-fixture"));
      return;
    case "real":
      write(dir, "package.json", JSON.stringify({ name: "mono", private: true, workspaces: ["packages/*"] }, null, 2) + "\n");
      write(dir, "packages/codec/src/frame.ts", CODEC_TS);
      write(dir, "packages/codec/package.json", manifest("@mono/codec"));
      write(dir, "packages/budget/src/wireBudget.ts", WIRE_BUDGET_TS);
      write(dir, "packages/budget/package.json", manifest("@mono/budget"));
      write(dir, "packages/orders/src/refunds.ts", REFUNDS_TS);
      write(dir, "packages/orders/package.json", manifest("@mono/orders"));
      if (state === "implemented") write(dir, "packages/stock/src/inventory.ts", INVENTORY_TS);
      if (state === "unreadable") write(dir, "packages/stock/src/inventory.ts", binaryBytes());
      if (state !== "absent") write(dir, "packages/stock/package.json", manifest("@mono/stock"));
      write(dir, "README.md", "# mono\n\nA trimmed multi-package tree.\n");
      return;
    case "cache-one":
      write(dir, "src/cache.ts", CACHE_TS);
      return;
    case "cachettl-one":
      write(dir, "src/cache.ts", CACHE_TTL_TS);
      return;
    case "cache-five":
    case "cachettl-five":
      write(dir, "src/cache.ts", shape === "cache-five" ? CACHE_TS : CACHE_TTL_TS);
      write(dir, "src/format.ts", FORMAT_TS);
      write(dir, "src/clock.ts", "export function nowMs(): number {\n  return Date.now();\n}\n");
      write(dir, "README.md", "# Cache fixture\n\nA small generated fixture.\n");
      write(dir, "package.json", manifest("cache-fixture"));
      return;
  }
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

const LEADS = ["Explain", "Describe", "Tell me", "Clarify", "Trace", "Walk me through", "I want to understand", "Outline", "Document", "Give me an overview of", "Show me", "Summarize"] as const;
const JOINERS = ["and", "and also", "as well as", "plus", "along with", "; also", "newline", "numbered"] as const;
const A_EN = "how refunds are processed";
const B_EN = "how inventory is replenished";
function enQuery(lead: string, joiner: string): string {
  switch (joiner) {
    case "; also": return `${lead} ${A_EN}; also ${B_EN}.`;
    case "newline": return `${lead} ${A_EN}.\nHow is inventory replenished?`;
    case "numbered": return `${lead}:\n1. ${A_EN}\n2. ${B_EN}`;
    default: return `${lead} ${A_EN} ${joiner} ${B_EN}.`;
  }
}
const JA_QUERIES: Readonly<Record<string, string>> = {
  "ja-particle": "返金の処理と、在庫の補充を説明してください",
  "ja-mata": "返金はどのように処理されますか。また、在庫はどのように補充されますか。",
};
const CACHE_QUERIES: Readonly<Record<string, string>> = {
  "ja-cache-1": "キャッシュが期限切れの場合の処理と、無効化する処理を説明してください",
  "ja-cache-2": "Cache の invalidate 処理と、期限切れ判定を説明してください",
  "en-cache": "Explain how expired cache entries are handled and how entries are invalidated.",
};

interface Concern { key: string; marker: string; hints: readonly string[] }
const SHOP_CONCERNS: readonly Concern[] = [
  { key: "A", marker: "processRefund", hints: ["refund", "返金"] },
  { key: "B", marker: "replenishInventory", hints: ["inventory", "replenish", "在庫", "補充"] },
];
const CACHE_CONCERNS: readonly Concern[] = [
  { key: "expiry", marker: "entry.expiresAt <= Date.now()", hints: ["期限", "expir"] },
  { key: "invalidate", marker: "invalidate(key: string)", hints: ["無効", "invalidat"] },
];
const CACHE_TTL_CONCERNS: readonly Concern[] = [
  { key: "expiry", marker: "Date.now() - e.t > this.ttlMs", hints: ["期限", "expir"] },
  { key: "invalidate", marker: "invalidate(k: string)", hints: ["無効", "invalidat"] },
];

interface Cell { id: string; query: string; shape: Shape; state: State; concerns: readonly Concern[]; allTopicJa: boolean }

function allCells(): Cell[] {
  const out: Cell[] = [];
  const en = (lead: string, joiner: string, state: State, shape: Shape): void => {
    out.push({ id: `en|${lead}|${joiner}|${state}|${shape}`, query: enQuery(lead, joiner), shape, state, concerns: SHOP_CONCERNS, allTopicJa: false });
  };
  for (const lead of LEADS) for (const joiner of JOINERS) en(lead, joiner, "absent", "five");
  for (const lead of ["Explain", "Trace", "Give me an overview of"]) for (const joiner of JOINERS) for (const state of ["implemented", "unreadable"] as const) en(lead, joiner, state, "five");
  for (const shape of ["one-small", "one-large", "real"] as const) for (const state of ["implemented", "absent", "unreadable"] as const) {
    if (state === "unreadable" && shape.startsWith("one")) continue;
    for (const lead of ["Explain", "Walk me through"]) for (const joiner of ["and", "numbered"]) en(lead, joiner, state, shape);
  }
  for (const ja of Object.keys(JA_QUERIES)) for (const shape of ["one-small", "one-large", "five", "real"] as const) for (const state of ["implemented", "absent", "unreadable"] as const) {
    if (state === "unreadable" && shape.startsWith("one")) continue;
    out.push({ id: `${ja}|${state}|${shape}`, query: JA_QUERIES[ja]!, shape, state, concerns: SHOP_CONCERNS, allTopicJa: ja === "ja-particle" });
  }
  for (const cq of Object.keys(CACHE_QUERIES)) for (const shape of ["cache-one", "cache-five", "cachettl-one", "cachettl-five"] as const) {
    out.push({
      id: `${cq}|${shape}`,
      query: CACHE_QUERIES[cq]!,
      shape,
      state: "implemented",
      concerns: shape.startsWith("cachettl") ? CACHE_TTL_CONCERNS : CACHE_CONCERNS,
      allTopicJa: cq.startsWith("ja"),
    });
  }
  return out;
}

/**
 * One cell per failure class this matrix has ever found, so the seeded run
 * always exercises every class: lead generalisation + joiner coverage, the
 * word collision (ruling 1), content predicates (ruling 2), the B3 TTL-only
 * cache in both shapes and both JA queries (ruling 3), the fully served
 * candidate list whose re-read could only be a receipt (ruling 4), the lead
 * verb that became a search term (ruling 6), unreadable second concerns, a
 * large file whose answer sits in its unserved remainder, and the JA
 * phrasings.
 */
const ANCHORS: readonly string[] = [
  "en|Explain|and|absent|five",
  "en|Walk me through|plus|absent|five",
  "en|I want to understand|; also|absent|five",
  "en|Trace|numbered|implemented|five",
  "en|Explain|and|unreadable|five",
  "en|Explain|and|absent|real",
  "en|Walk me through|numbered|absent|real",
  "en|Explain|and|implemented|real",
  "en|Walk me through|and|absent|one-small",
  "en|Explain|and|implemented|one-large",
  "en|Explain|and|absent|one-large",
  "ja-particle|absent|five",
  "ja-mata|absent|five",
  "ja-mata|implemented|one-small",
  "ja-cache-1|cachettl-one",
  "ja-cache-1|cachettl-five",
  "ja-cache-2|cachettl-one",
  "ja-cache-2|cachettl-five",
  "en-cache|cachettl-one",
  "en-cache|cache-five",
];
const SEEDED_EXTRA = 4;
const SEED = 0x5eed_2109;

function seededSubset(cells: readonly Cell[]): Cell[] {
  const byId = new Map(cells.map((cell) => [cell.id, cell]));
  const picked = ANCHORS.map((id) => {
    const cell = byId.get(id);
    if (cell === undefined) throw new Error(`anchor ${id} is not a matrix cell`);
    return cell;
  });
  const rest = cells.filter((cell) => !ANCHORS.includes(cell.id));
  let state = SEED >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  for (let i = 0; i < SEEDED_EXTRA && rest.length > 0; i++) {
    picked.push(rest.splice(Math.floor(next() * rest.length), 1)[0]!);
  }
  return picked;
}

// ---------------------------------------------------------------------------
// Chain + oracle
// ---------------------------------------------------------------------------

function pick(obj: unknown, keyPath: string): any {
  return keyPath.split(".").reduce((acc: any, key) => (acc == null ? undefined : acc[key]), obj);
}
function extractNext(body: any): { tool: string; arguments: Record<string, unknown> } | undefined {
  const decisionNext = pick(body, "decision.next_call") ?? pick(body, "decision.next");
  if (decisionNext && typeof decisionNext.tool === "string") return decisionNext;
  if (body?.next && typeof body.next.tool === "string") return body.next;
  const limitNext = pick(body, "limit.next");
  if (limitNext && typeof limitNext.tool === "string") return limitNext;
  if (Array.isArray(body?.entries)) for (const entry of body.entries) if (entry?.next && typeof entry.next.tool === "string") return entry.next;
  return undefined;
}
function disclosures(body: any): string[] {
  const out: string[] = [];
  for (const source of [pick(body, "decision.certificate.gaps"), pick(body, "decision.gaps"), pick(body, "decision.unresolved")]) {
    if (!Array.isArray(source)) continue;
    for (const entry of source) {
      if (typeof entry === "string") out.push(entry);
      else if (entry && typeof entry === "object") {
        const refs = Array.isArray(entry.refs) ? entry.refs.filter((v: unknown) => typeof v === "string") : [];
        out.push([entry.code, entry.kind, entry.id, entry.reason, ...refs].filter((v) => typeof v === "string").join(" "));
      }
    }
  }
  return out;
}
function bodies(body: any): string[] {
  const out: string[] = [];
  if (Array.isArray(body?.evidence)) for (const e of body.evidence) if (typeof e?.body === "string") out.push(e.body);
  if (typeof body?.body === "string") out.push(body.body);
  if (typeof body?.text === "string") out.push(body.text);
  if (Array.isArray(body?.entries)) for (const e of body.entries) {
    if (typeof e?.body === "string") out.push(e.body);
    if (typeof e?.text === "string") out.push(e.text);
  }
  return out;
}
const servesMarker = (body: any, marker: string): boolean => bodies(body).some((text) => text.includes(marker));
const mentions = (texts: readonly string[], hints: readonly string[]): boolean =>
  texts.some((text) => hints.some((hint) => text.toLowerCase().includes(hint.toLowerCase())));
const ABSENCE_RE = /absent|not (?:found|located)|no occurrence/i;
const TERMINAL = new Set(["act.answer", "act.edit", "await_input", "done"]);
const HOP_CAP = 8;

interface Hop { tool: string; body: any }
interface Chain { hops: Hop[]; capped: boolean }

async function follow(server: ServerHandle, first: { tool: string; arguments: Record<string, unknown> }, cwd: string): Promise<Chain> {
  const hops: Hop[] = [];
  let next: typeof first | undefined = first;
  while (next !== undefined) {
    if (hops.length >= HOP_CAP) return { hops, capped: true };
    const args = { ...next.arguments };
    if (args["cwd"] === undefined) args["cwd"] = cwd;
    const { body } = await server.callTool(next.tool, args);
    hops.push({ tool: next.tool, body });
    next = extractNext(body);
  }
  return { hops, capped: false };
}

function audit(cell: Cell, chains: Record<string, Chain | undefined>, served: ReadonlySet<string>): string[] {
  const failures = new Set<string>();
  const states: State[] = cell.concerns.map((_, i) => (i === 0 || cell.shape.startsWith("cache") ? "implemented" : cell.state));
  for (const [label, chain] of Object.entries(chains)) {
    if (chain === undefined) continue;
    chain.hops.forEach((hop, i) => {
      if (i > 0 && typeof pick(hop.body, "decision.kind") !== "string" && extractNext(hop.body) === undefined) {
        failures.add(`c-dead-end(${label})`);
      }
    });
    const decisions = chain.hops.map((hop) => pick(hop.body, "decision.kind")).filter((kind): kind is string => typeof kind === "string");
    const terminalAt = chain.hops.findIndex((hop) => TERMINAL.has(pick(hop.body, "decision.kind") ?? ""));
    if (chain.capped) failures.add(`c-capped(${label})`);
    else if (terminalAt < 0) failures.add(`c-no-decision(${label})`);
    else if (terminalAt >= 6) failures.add(`c-slow(${label})`);
    chain.hops.forEach((hop) => {
      const absenceTexts = disclosures(hop.body).filter((text) => ABSENCE_RE.test(text));
      cell.concerns.forEach((concern, ci) => {
        if (states[ci] === "implemented" && mentions(absenceTexts, concern.hints)) {
          failures.add(servesMarker(hop.body, concern.marker) ? `b-same-response(${label})` : `b-false-absence(${label})`);
        }
        if (states[ci] === "unreadable" && absenceTexts.some((t) => mentions([t], concern.hints) && /scope complete/i.test(t))) {
          failures.add(`b-scope(${label})`);
        }
      });
    });
    const final = decisions[decisions.length - 1];
    if (final === "act.answer") {
      const finalHop = [...chain.hops].reverse().find((hop) => typeof pick(hop.body, "decision.kind") === "string");
      cell.concerns.forEach((concern, ci) => {
        if (states[ci] === "implemented") {
          if (!served.has(concern.marker)) failures.add(cell.allTopicJa ? `a-unserved-alltopic(${label})` : `a-unserved(${label})`);
        } else if (!mentions(disclosures(finalHop?.body), concern.hints)) {
          failures.add(`a-silent(${label})`);
        }
      });
    }
  }
  return [...failures].sort();
}

// ---------------------------------------------------------------------------
// Honest residuals (both chains of a cell; class names are `<class>(<chain>)`)
// ---------------------------------------------------------------------------

/**
 * R-B3's residual inventory (2026-09-21), taken from one full run
 * (`TL_GATE_MATRIX_FULL=1`, 408 cells: 19 default + 14 VS Code residuals).
 * None of these is a request-item gate path; each is reported upward with its
 * chain. Reasons:
 *  - REBUILD (RESOLVED for 10 of 12 cells, R-D2 2026-09-21 — see JA-NO-CANDIDATE
 *    for the 2 that remain): a bare `{qref}`/`task.handle` re-pack whose
 *    record predates later progress is REBUILT (FIX-D's
 *    `recordPredatesAdditionalServedEvidence`); the rebuilt pathless pack used
 *    to read only its OWN fresh surfaces for `surface-content` /
 *    `behavior-body`, missing carried-forward evidence from the rest of the
 *    epoch and falling to the no-dead-end guard's generic `tl_search_files`
 *    fallback (a decision-less response). Fixed two ways, both in
 *    `readCodeTaskPack.ts`: (1) `buildReadinessObligations`'s
 *    `surface-content`/`behavior-body` (and its pre-existing `identifier:*`
 *    obligation) now share ONE `servedWithCarried` evidence set built from
 *    `epochServedEvidence` — MUST CHECK BOTH STORES (the cumulative log and
 *    the WP-S11 read-only view), exactly as `recordPredatesAdditionalServedEvidence`'s
 *    own comment requires, because which store a hop's surfaces land in
 *    depends on THAT hop's own (possibly "inferred", not "explicit")
 *    `profile_binding.source` — plus a narrow reconciliation of the coarse,
 *    non-epoch-aware `result.missing`/`coverage_reason:"missing-roles"`
 *    signal a call with zero surfaces of its own still stamps; and (2)
 *    `tryServeSupersedingCertifiedRecord`: when the declined pathless seed's
 *    OWN task already reached a certified `act.answer`/`act.edit` via a
 *    differently-shaped call (explicit targets, a different fingerprint —
 *    the reviewed "a pathless re-ask must not collapse into a seeded record"
 *    constraint stays intact, since this is a NEW, explicit fallback, never a
 *    widened match), a `qref`/`task.handle` CONTINUATION now restates that
 *    certificate instead of rebuilding, re-validated by the identical
 *    staleness gates `tryServeCachedPack`/`tryServeSemanticDuplicatePack` use.
 *  - JA-NO-CANDIDATE (residual, both configs, `ja-mata|absent|one-small` only —
 *    CONFIRMED, not fixed by R-D2): the one REBUILD-shaped cell the two fixes
 *    above do not reach. `ri-1` (refunds) is now correctly carried forward and
 *    covered on every hop (`TL_TRACE` confirms `ri-1: covered` from the second
 *    hop on); `ri-2` (在庫, a JA term with `TL_JA_QUERY_BRIDGE` disabled) has
 *    NO confirmed search candidate on ANY hop, hop 1 included — hop 1 itself
 *    correctly ends `await_input`/`ambiguous-target` with no `next` (nothing
 *    safe to search for). That is not a certified `act.answer`/`act.edit`, so
 *    `tryServeSupersedingCertifiedRecord` has no certificate to restate; the
 *    rebuild's own (uncertified) fallback instead proposes a generic
 *    multi-term JA `tl_search_files find` that dead-ends. The fix belongs to
 *    whichever candidate-fallback mints that generic find becoming
 *    epoch/evidence-aware of hop 1's own "no safe candidate" verdict for the
 *    SAME unresolved concern — out of this wave's two mechanisms.
 *  - PLAIN-READ: a server-minted plain zoom (`{handle, range}`) or bare
 *    `find` is answered by a decision-less `read.text` / `search.matches`
 *    by design; the chain stops there without a terminal decision.
 *  - UNREAD: an undecodable second-concern file; the chain ends in a
 *    guard-minted read with no decision (and, in the particle phrasing, the
 *    re-pack certifies without naming the unreadable point).
 *  - JA-CND (RESOLVED for the `five` shape, R-D2 2026-09-21 item B — the
 *    `real` shape's residual is reclassified into JA-COLLISION below): ruling
 *    3 — a kanji-only concern (在庫の補充) whose glossary expansions are not
 *    in the workspace is "could not determine", never absent; the ALL-TOPIC
 *    branch mints no blocking obligation (invariant (iv)), and — before this
 *    fix — the wire had no could-not-determine disclosure at all, so the
 *    answer certified without naming it anywhere (plan §5: 「…見つからない
 *    こと、または未確定であることを必ず示す」). Fixed by threading
 *    `decideConcernStatus`'s own could-not-determine verdict (previously
 *    discarded by `requestItemProofFromVerdict`'s `RequestItemProof`
 *    adapter whenever no `absentTerm` was set — the exact "how 'could not
 *    determine' has always reached the wire from here [nowhere]" case its
 *    own doc comment named) through a new `RequestItemProof.
 *    undeterminedTerm` / `ConcernVerdict.undeterminedTerm` field into the
 *    EXISTING `certificate.gaps` string array (`TaskPackResult.
 *    request_item_absences`, tagged `undetermined:true`) with a NEW code
 *    word, `explicit-gap:request-item-undetermined:<term> (<why>)` — no new
 *    field, no new `kind` (`decisionWire.ts`'s `projectCertificate`
 *    branches on the tag before the scope-complete wording that does not
 *    apply to an indeterminate verdict; `buildCapabilityGaps`, the
 *    DISCOVER-side `TaskCapabilityGap` reader, skips a tagged entry rather
 *    than mis-rendering it as `request-item-absent`, since the ruling scopes
 *    the new code word to the certificate string array only).
 *  - JA-COLLISION: 在庫 bridges (glossary) to "inventory", which occurs only
 *    as the `inventory_files` field in unrelated budget code — the JA analog
 *    of ruling 1's word collision, which is predicate-structural (English)
 *    and does not reach a bridged JA anchor. Confirmed (R-D2) to also be the
 *    `real`-shape residual of the JA-CND class above: the bridged literal
 *    scan for 在庫/在庫の補充 matches the `inventory_files` field name in
 *    `packages/budget/src/wireBudget.ts`, so the concern is treated as
 *    occurring (neither absent nor could-not-determine) and stays silent —
 *    a collision fix, not an undetermined-disclosure fix, so out of item B's
 *    scope.
 *  - JA-UNSERVED: the JA phrasings certify with refunds covered off its
 *    interface line while `processRefund` is never served.
 */
const KNOWN_FAILURES: Readonly<Record<string, readonly string[]>> = {
  // JA-NO-CANDIDATE (see the class comment above — the REBUILD survivor)
  "default|ja-mata|absent|one-small": ["c-dead-end(repack)", "c-no-decision(repack)"],
  "vscode|ja-mata|absent|one-small": ["c-dead-end(repack)", "c-no-decision(repack)"],
  // PLAIN-READ
  "default|ja-mata|absent|one-large": ["c-dead-end(follow)", "c-dead-end(repack)", "c-no-decision(follow)", "c-no-decision(repack)"],
  "default|ja-mata|implemented|real": ["c-dead-end(follow)", "c-no-decision(follow)"],
  "default|ja-particle|absent|one-large": ["c-dead-end(follow)", "c-no-decision(follow)"],
  "default|ja-particle|absent|one-small": ["c-dead-end(follow)", "c-no-decision(follow)"],
  "default|ja-particle|implemented|real": ["c-dead-end(follow)", "c-no-decision(follow)"],
  "vscode|ja-mata|absent|one-large": ["c-dead-end(follow)", "c-dead-end(repack)", "c-no-decision(follow)", "c-no-decision(repack)"],
  "vscode|ja-particle|absent|one-large": ["c-dead-end(follow)", "c-no-decision(follow)"],
  "vscode|ja-particle|absent|one-small": ["c-dead-end(follow)", "c-no-decision(follow)"],
  // UNREAD
  // 2026-10-22 (v0.16.0 release verification, T16): `default|ja-particle|unreadable|five`
  // no longer fails on this tree (an improvement from the v0.16.0 follow-up
  // changes; one cause was not isolated). The cell passed on three consecutive
  // runs, so its entry is deleted, as the check below asks.
  "default|ja-mata|unreadable|real": ["c-dead-end(follow)", "c-dead-end(repack)", "c-no-decision(follow)", "c-no-decision(repack)"],
  "default|ja-particle|unreadable|real": ["a-silent(repack)", "c-dead-end(follow)", "c-no-decision(follow)"],
  "vscode|ja-mata|unreadable|real": ["c-dead-end(repack)", "c-no-decision(repack)"],
  "vscode|ja-particle|unreadable|real": ["a-silent(repack)", "c-dead-end(follow)", "c-no-decision(follow)"],
  // JA-COLLISION (includes the JA-CND `real`-shape residual — see the class comment above)
  "default|ja-particle|absent|real": ["a-silent(follow)", "a-silent(repack)"],
  "vscode|ja-particle|absent|real": ["a-silent(follow)", "a-silent(repack)"],
  "default|ja-mata|absent|real": ["a-silent(follow)", "a-silent(repack)"],
  "vscode|ja-mata|absent|real": ["a-silent(follow)", "a-silent(repack)"],
  // JA-UNSERVED
  "default|ja-mata|implemented|five": ["a-unserved(follow)", "a-unserved(repack)"],
  "default|ja-particle|implemented|five": ["a-unserved-alltopic(follow)", "a-unserved-alltopic(repack)"],
};

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];
const servers: ServerHandle[] = [];

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

const CELLS = FULL ? allCells() : seededSubset(allCells());

for (const config of CONFIG_NAMES as readonly ConfigName[]) {
  describe(`request-item gate matrix (config=${config}, ${FULL ? "full" : "seeded"})`, () => {
    for (const cell of CELLS) {
      const knownKey = `${config}|${cell.id}`;
      it(`${cell.id}`, async () => {
        const ws = fs.realpathSync(shortTmpDir(HOME, ".tl-rigm-"));
        tmpDirs.push(ws);
        buildWorkspace(cell.shape, cell.state, ws);
        const server = startDevServer(ws, config);
        servers.push(server);
        try {
          await server.initialize();
          const followed = await follow(server, { tool: "tl_read_file", arguments: { query: cell.query, task: { epoch: "new", profile: "answer" } } }, ws);
          const qref = [...followed.hops].reverse().map((hop) => hop.body?.qref).find((value) => typeof value === "string");
          const repacked = typeof qref === "string" ? await follow(server, { tool: "tl_read_file", arguments: { qref } }, ws) : undefined;
          const served = new Set<string>();
          for (const chain of [followed, repacked]) {
            if (chain === undefined) continue;
            for (const hop of chain.hops) for (const concern of cell.concerns) if (servesMarker(hop.body, concern.marker)) served.add(concern.marker);
          }
          const failures = audit(cell, { follow: followed, repack: repacked }, served);
          const known = KNOWN_FAILURES[knownKey];
          if (known === undefined) {
            expect(failures, `${knownKey}: ${JSON.stringify(failures)}`).toEqual([]);
          } else {
            expect(failures.length, `${knownKey} is a KNOWN failure that now passes — delete its KNOWN_FAILURES entry`).toBeGreaterThan(0);
            expect(failures.filter((failure) => !known.includes(failure)), `${knownKey}: a class outside its known residual`).toEqual([]);
          }
        } finally {
          await server.kill();
        }
      }, 120_000);
    }
  });
}

// ---------------------------------------------------------------------------
// R-B3 ruling 5: a served-but-only-mentioned-in-passing absence never claims
// "no occurrence" (the term DOES occur — in a served comment).
// ---------------------------------------------------------------------------

for (const config of CONFIG_NAMES as readonly ConfigName[]) {
  describe(`request-item absence wording (config=${config})`, () => {
    it("an incidental mention in a served file is disclosed as such, never as \"no occurrence\"", async () => {
      const ws = fs.realpathSync(shortTmpDir(HOME, ".tl-rigm-"));
      tmpDirs.push(ws);
      fs.mkdirSync(path.join(ws, ".git"), { recursive: true });
      write(ws, "src/refunds.ts", REFUNDS_TS);
      // ONE topic word in a comment: an incidental mention. (A comment naming
      // BOTH words meets the two-term bar once doc-comment wording counts as
      // served — TL_IDENTIFIER_GROUNDING's reviewed widening — which is a
      // coverage question, not this wording check.)
      write(ws, "src/notes.ts", "// Inventory counts are reconciled by another service.\nexport const NOTES_VERSION = 1;\n");
      const server = startDevServer(ws, config);
      servers.push(server);
      try {
        await server.initialize();
        const chain = await follow(server, { tool: "tl_read_file", arguments: { query: "1. How are refunds processed?\n2. How is inventory replenished?", task: { epoch: "new", profile: "answer" } } }, ws);
        const texts = chain.hops.flatMap((hop) => disclosures(hop.body)).filter((text) => /inventory|replenish/i.test(text) && ABSENCE_RE.test(text));
        expect(texts.length, JSON.stringify(chain.hops.map((hop) => hop.body?.decision))).toBeGreaterThan(0);
        expect(texts.filter((text) => /no occurrence/i.test(text)), JSON.stringify(texts)).toEqual([]);
        expect(texts.some((text) => /incidental/i.test(text)), JSON.stringify(texts)).toBe(true);
      } finally {
        await server.kill();
      }
    }, 120_000);
  });
}
