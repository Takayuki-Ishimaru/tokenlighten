/**
 * requestItemGateChain.spec.ts — R-B1 (2026-09-21, review B2 / B3 / held 1-2).
 *
 * Class-level regressions for the request-item COMPLETION GATE, taken from the
 * R-B1 attack matrix (leads x joiners x second-concern state x EN/JA x
 * workspace shape x {follow `next` to the end, then a bare `{qref}` re-pack}).
 * One cell per CLASS, both configs, spawned dev server:
 *
 *  - WINDOW (B2): an open concern whose body sits in the UNSERVED part of a
 *    partly served file is continued by a query-bearing read of the window
 *    where its wording occurs — never a bare `tl_search_files tree`/`find`, and
 *    never the hull of every unserved line.
 *  - SLIVER (held 1/2): a concern is never certified off a served slice (an
 *    interface line) while the function that answers it is unserved, and it
 *    is never certified ABSENT on the strength of that slice either.
 *  - UNREADABLE: a concern whose only candidate is undecodable terminates (no
 *    oscillation, no bare tree) and is named, never "absent; scope complete".
 *  - JA CLAUSE (B3): a clause whose subject is served at a code position is
 *    never disclosed absent beside that body.
 *  - RECALL: a whole small file served through an explicit full-length range
 *    still covers both concerns in one call.
 *
 * Neutral generated fixtures; nothing in the product keys on any identifier,
 * path or phrase used here (brief-common.md rule 5).
 */
import { afterAll, describe, expect, it } from "vitest";
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

const REFUNDS = [
  "export interface RefundRequest { orderId: string; amountCents: number; reason: string; }",
  "export function processRefund(request: RefundRequest, ledger: Map<string, number>): number {",
  "  const paid = ledger.get(request.orderId) ?? 0;",
  "  const granted = Math.min(paid, request.amountCents);",
  "  ledger.set(request.orderId, paid - granted);",
  "  return granted;",
  "}",
  "",
].join("\n");
const INVENTORY = [
  "export interface StockLevel { sku: string; onHand: number; reorderPoint: number; }",
  "export function replenishInventory(level: StockLevel, batchSize: number): StockLevel {",
  "  if (level.onHand > level.reorderPoint) return level;",
  "  return { ...level, onHand: level.onHand + batchSize };",
  "}",
  "",
].join("\n");
const EN_QUERY = "Explain how refunds are processed and how inventory is replenished.";

function write(root: string, rel: string, content: string | Buffer): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** One large file: a header, the refund function, 400 filler lines, then (optionally) the stock function. */
function largeStore(withInventory: boolean): string {
  const filler = Array.from({ length: 400 }, (_, i) => `  // bookkeeping note ${i + 1}: totals are reconciled nightly`).join("\n");
  const header = withInventory
    ? "/**\n * Store module. Handles refunds and inventory replenishment.\n */\n"
    : "/**\n * Store module. Handles refunds.\n */\n";
  return `${header}${REFUNDS}export function noop(): void {\n${filler}\n}\n${withInventory ? INVENTORY : "export const STORE_VERSION = 3;\n"}`;
}

function pick(obj: unknown, keyPath: string): any {
  return keyPath.split(".").reduce((acc: any, key) => (acc == null ? undefined : acc[key]), obj);
}
function bodies(response: any): string[] {
  const out: string[] = [];
  for (const entry of Array.isArray(response?.evidence) ? response.evidence : []) if (typeof entry?.body === "string") out.push(entry.body);
  if (typeof response?.body === "string") out.push(response.body);
  return out;
}
function served(chain: ChainResult, marker: string): boolean {
  return chain.hops.some((hop) => bodies(hop.response).some((body) => body.includes(marker)));
}
function disclosures(response: any): string[] {
  const out: string[] = [];
  for (const source of [pick(response, "decision.certificate.gaps"), pick(response, "decision.gaps"), pick(response, "decision.unresolved")]) {
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
const ABSENCE_RE = /absent|no occurrence/iu;
function absencesNaming(chain: ChainResult, hints: readonly string[]): string[] {
  return chain.hops.flatMap((hop) => disclosures(hop.response))
    .filter((text) => ABSENCE_RE.test(text) && hints.some((hint) => text.toLowerCase().includes(hint.toLowerCase())));
}
function finalKind(chain: ChainResult): string {
  for (let i = chain.hops.length - 1; i >= 0; i -= 1) {
    const kind = pick(chain.hops[i]!.response, "decision.kind");
    if (typeof kind === "string") return kind;
  }
  return "none";
}
/** A response to a server-minted call that carries neither a decision nor a `next` and delivered no body. */
function strandedHops(chain: ChainResult): string[] {
  return chain.hops.slice(1)
    .filter((hop) => typeof pick(hop.response, "decision.kind") !== "string" && hop.nextSource === "none" && bodies(hop.response).length === 0)
    .map((hop) => `${hop.call.tool} -> ${String(hop.response?.kind)}`);
}
function treeHops(chain: ChainResult): number {
  return chain.hops.filter((hop) => hop.call.tool === "tl_search_files" && hop.call.arguments["action"] === "tree").length;
}

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

async function withWorkspace(
  config: ConfigName,
  tag: string,
  build: (root: string) => void,
  body: (server: ServerHandle, ws: string) => Promise<void>,
): Promise<void> {
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-rigc-${config.slice(0, 1)}-${tag}-`));
  tmpDirs.push(ws);
  fs.mkdirSync(path.join(ws, ".git"), { recursive: true });
  build(ws);
  const server = startDevServer(ws, config);
  servers.push(server);
  try {
    await server.initialize();
    await body(server, ws);
  } finally {
    await server.kill();
  }
}

async function chainWithRepack(server: ServerHandle, ws: string, first: Record<string, unknown>): Promise<{ follow: ChainResult; repack?: ChainResult }> {
  const follow = await followNextToEnd(server, { tool: "tl_read_file", arguments: { ...first, cwd: ws } }, { cwd: ws, hopCap: 8, maxQrefRepacks: 0 });
  const qref = [...follow.hops].reverse().map((hop) => hop.response?.qref).find((value) => typeof value === "string");
  const repack = typeof qref === "string"
    ? await followNextToEnd(server, { tool: "tl_read_file", arguments: { qref, cwd: ws } }, { cwd: ws, hopCap: 8, maxQrefRepacks: 0 })
    : undefined;
  return { follow, ...(repack !== undefined ? { repack } : {}) };
}

for (const config of CONFIG_NAMES) {
  describe(`request-item completion gate — chain classes (config=${config})`, () => {
    it("WINDOW: the unserved body of a partly served file is read through its own window, never a bare tree", async () => {
      await withWorkspace(config, "win", (ws) => write(ws, "src/store.ts", largeStore(true)), async (server, ws) => {
        const { follow } = await chainWithRepack(server, ws, { query: EN_QUERY, task: { epoch: "new", profile: "answer" } });
        expect(follow.capped).toBe(false);
        expect(treeHops(follow), JSON.stringify(follow.hops.map((h) => h.call))).toBe(0);
        expect(strandedHops(follow)).toEqual([]);
        expect(finalKind(follow)).toBe("act.answer");
        expect(follow.hops.length).toBeLessThanOrEqual(3);
        expect(served(follow, "processRefund")).toBe(true);
        expect(served(follow, "replenishInventory")).toBe(true);
        expect(absencesNaming(follow, ["refund", "inventory", "replenish"])).toEqual([]);
        // Bounded: never the 400-line filler hull.
        const bytes = follow.hops.reduce((sum, hop) => sum + hop.textBytes, 0);
        expect(bytes).toBeLessThan(9000);
      });
    }, 180_000);

    it("SLIVER: never certified off a served interface line, never certified absent from it", async () => {
      await withWorkspace(config, "slv", (ws) => write(ws, "src/store.ts", largeStore(false)), async (server, ws) => {
        const { follow, repack } = await chainWithRepack(server, ws, { query: EN_QUERY, task: { epoch: "new", profile: "answer" } });
        for (const chain of [follow, repack].filter((c): c is ChainResult => c !== undefined)) {
          expect(absencesNaming(chain, ["refund"]), "the implemented concern must never be called absent").toEqual([]);
          if (finalKind(chain) === "act.answer") expect(served(follow, "processRefund") || served(chain, "processRefund")).toBe(true);
        }
        expect(finalKind(follow)).toBe("act.answer");
        expect(absencesNaming(follow, ["inventory", "replenish"]).length).toBeGreaterThan(0);
      });
    }, 180_000);

    it("UNREADABLE: a concern whose only candidate is undecodable terminates and is named, never absent-in-scope", async () => {
      const binary = Buffer.alloc(900);
      for (let i = 0; i < binary.length; i += 1) binary[i] = (i * 37 + 11) % 256;
      binary[0] = 0; binary[1] = 0xff; binary[2] = 0xfe; binary[3] = 0;
      await withWorkspace(config, "unr", (ws) => {
        write(ws, "src/refunds.ts", REFUNDS);
        write(ws, "src/inventory.ts", binary);
        write(ws, "src/format.ts", "export function formatCents(cents: number): string {\n  return (cents / 100).toFixed(2);\n}\n");
        write(ws, "README.md", "# Shop fixture\n\nA small generated fixture.\n");
      }, async (server, ws) => {
        const { follow, repack } = await chainWithRepack(server, ws, { query: EN_QUERY, task: { epoch: "new", profile: "answer" } });
        expect(follow.capped).toBe(false);
        expect(repack?.capped ?? false).toBe(false);
        for (const chain of [follow, repack].filter((c): c is ChainResult => c !== undefined)) {
          expect(treeHops(chain)).toBe(0);
          expect(absencesNaming(chain, ["inventory"]).filter((text) => /scope complete/iu.test(text))).toEqual([]);
        }
        const terminal = [repack, follow].filter((c): c is ChainResult => c !== undefined).map(finalKind);
        expect(terminal.some((kind) => kind === "await_input" || kind === "act.answer")).toBe(true);
        const named = [follow, repack].filter((c): c is ChainResult => c !== undefined)
          .flatMap((chain) => chain.hops.flatMap((hop) => disclosures(hop.response)))
          .some((text) => /inventory|ri-2|request-item/iu.test(text));
        expect(named).toBe(true);
      });
    }, 180_000);

    it("JA CLAUSE: a clause whose subject is served at a code position is never disclosed absent beside that body", async () => {
      await withWorkspace(config, "jac", (ws) => write(ws, "src/cache.ts", [
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
      ].join("\n")), async (server, ws) => {
        const { follow } = await chainWithRepack(server, ws, { query: "キャッシュが期限切れの場合の処理と、無効化する処理を説明してください", task: { epoch: "new", profile: "answer" } });
        expect(finalKind(follow)).toBe("act.answer");
        expect(served(follow, "class Cache")).toBe(true);
        expect(absencesNaming(follow, ["キャッシュ", "期限"])).toEqual([]);
      });
    }, 180_000);

    it("RECALL: a whole small file served through an explicit full-length range covers both concerns in one call", async () => {
      await withWorkspace(config, "rec", (ws) => write(ws, "src/store.ts", REFUNDS + INVENTORY), async (server, ws) => {
        const total = (REFUNDS + INVENTORY).split("\n").length - 1;
        const { body } = await server.callTool("tl_read_file", {
          query: EN_QUERY,
          targets: [{ path: "src/store.ts", range: `1-${total}` }],
          task: { epoch: "new", profile: "answer" },
          cwd: ws,
        });
        expect(pick(body, "decision.kind")).toBe("act.answer");
        expect(bodies(body).some((text) => text.includes("processRefund") && text.includes("replenishInventory"))).toBe(true);
        expect(disclosures(body).filter((text) => ABSENCE_RE.test(text))).toEqual([]);
      });
    }, 180_000);
  });
}
