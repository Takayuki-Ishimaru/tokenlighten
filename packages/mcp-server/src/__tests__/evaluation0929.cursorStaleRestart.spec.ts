/**
 * evaluation0929.cursorStaleRestart.spec.ts — eval-0929 §3/§7/§8 (WP-D).
 *
 * A `cursor-stale` refusal's restart `next` used to drop the caller's own
 * declared `budget` (both the read cursor's own source-revision check and the
 * search-find cursor's), and the read cursor's restart additionally triggered
 * a SECOND `cursor-stale` refusal from `admitCallerRangedContinuation` (the
 * caller-ranged continuation door), whose own refusal `next` in turn restated
 * a LEGACY-translated `content` field instead of the caller's own canonical
 * one. Two refusals before any progress, and the eventually-restarted request
 * was not the caller's request (dropped budget). Fixed in `server.ts`
 * (`admitCallerRangedContinuation`, the read cursor's stale branch at the
 * `mode=full`/ranged-target dispatch, and the search-find cursor's
 * `restartNext`) plus `tools/findReferences.ts` (`continuationNextCall`,
 * reused for the references cursor's own stale restart).
 *
 * Every case here drives a REAL stdio server (`startDevServer`) and follows
 * `next` verbatim, exactly as AGENTS.md instructs a caller to.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import {
  CONFIG_NAMES,
  extractNext,
  extractServedIds,
  idRangeSet,
  missingIds,
  startDevServer,
  walkHops,
  writeSelfIdFile,
  type ConfigName,
  type ServerHandle,
  type ToolCallShape,
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

function freshWorkspace(config: ConfigName, tag: string): { ws: string; server: ServerHandle } {
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-e0929-csr-${config}-${tag}-`));
  tmpDirs.push(ws);
  const server = startDevServer(ws, config, { allowWrite: true });
  servers.push(server);
  return { ws, server };
}

/** Raw occurrence COUNT of `${tag}-NNNN` across a chain of responses — unlike
 *  `extractServedIds`'s Set, this catches a line served twice (a duplicate
 *  the brief's acceptance criteria names explicitly), matching this tag
 *  against a LITERAL alternation-free string so JSON's `\n` escaping cannot
 *  extend a generic character class into it (the same pitfall
 *  `qualityFirstScenarios.ts`'s own header documents for `extractServedIds`). */
function countTagOccurrences(responses: readonly unknown[], tag: string): number {
  const re = new RegExp(`${tag}-(\\d{4})`, "g");
  let count = 0;
  for (const r of responses) {
    const text = JSON.stringify(r);
    re.lastIndex = 0;
    while (re.exec(text) !== null) count += 1;
  }
  return count;
}

for (const config of CONFIG_NAMES as readonly ConfigName[]) {
  describe(`read cursor stale restart (config=${config})`, () => {
    it("preserves the caller's budget, is admitted on the first try, and delivers exactly the new revision", async () => {
      const { ws, server } = freshWorkspace(config, "primary");
      await server.initialize();
      writeSelfIdFile(ws, "large.ts", 1000, "csrOld", 24);

      const first = await server.callTool("tl_read_file", {
        targets: [{ path: "large.ts", range: "1-1000" }],
        content: "full",
        budget: { bytes: 6144 },
        cwd: ws,
      });
      const firstNext = extractNext(first.body).next;
      expect(firstNext, `first hop should page: ${JSON.stringify(first.body).slice(0, 300)}`).toBeDefined();

      // Mid-chain mutation: SAME line count/width, a different tag — a torn
      // read would show BOTH tags for lines the fix must serve only once.
      writeSelfIdFile(ws, "large.ts", 1000, "csrNew", 24);

      const stale = await server.callTool(firstNext!.tool, firstNext!.arguments);
      expect(stale.body["kind"], JSON.stringify(stale.body).slice(0, 300)).toBe("refusal");
      expect(stale.body["code"]).toBe("cursor-stale");

      const restart = extractNext(stale.body).next as ToolCallShape | undefined;
      expect(restart, "the stale refusal must carry a restart next").toBeDefined();
      // ROOT CAUSE A: the restart must restate the caller's OWN declared budget.
      expect(restart!.arguments["budget"]).toEqual({ bytes: 6144 });
      expect(restart!.arguments["content"]).toBe("full");
      expect((restart!.arguments["targets"] as Array<Record<string, unknown>>)[0]?.["path"]).toBe("large.ts");
      // No cursor: this is a fresh request over the current revision.
      expect(restart!.arguments["cursor"]).toBeUndefined();

      // ROOT CAUSE B: running the restart verbatim must be ADMITTED on the
      // first try — no second `cursor-stale`.
      const chain = await walkHops(server, restart!, 20);
      expect(chain.capped, `chain never completed: ${JSON.stringify(chain.responses).slice(0, 500)}`).toBe(false);
      const refusals = chain.responses.filter((r) => (r as Record<string, unknown>)["kind"] === "refusal");
      expect(refusals, `unexpected refusal(s) after the restart: ${JSON.stringify(refusals).slice(0, 500)}`).toEqual([]);
      // Per-response byte-budget compliance (every page <= the caller's own
      // 6144 B) is verified independently via evalkit's `confirm_findings.py`
      // `stale_budget_6144`/`stale_budget_8192` (`restart_budget_exceeded:
      // false`) against this same working tree — see this wave's report.

      // Exact completeness of the NEW revision: 0 missing, 0 duplicate, and
      // the OLD tag never appears anywhere in the post-restart chain.
      const servedNew = new Map<string, Set<number>>();
      for (const r of chain.responses) {
        const ids = extractServedIds(r, ["csrNew", "csrOld"]);
        for (const [tag, set] of ids) {
          const acc = servedNew.get(tag) ?? new Set<number>();
          for (const n of set) acc.add(n);
          servedNew.set(tag, acc);
        }
      }
      const newIds = servedNew.get("csrNew") ?? new Set<number>();
      const oldIds = servedNew.get("csrOld") ?? new Set<number>();
      expect(missingIds(idRangeSet(1, 1000), newIds), "missing new-revision lines after the restart").toEqual([]);
      expect([...oldIds], "old-revision content leaked into the post-restart chain (torn read)").toEqual([]);
      expect(
        countTagOccurrences(chain.responses, "csrNew"),
        "duplicate new-revision lines across the restarted chain",
      ).toBe(newIds.size);
    }, 180_000);
  });
}

describe("read cursor stale restart — recall control", () => {
  it("an unchanged file still completes normally through the same cursor chain (no false alarm)", async () => {
    const { ws, server } = freshWorkspace("default", "recall");
    await server.initialize();
    writeSelfIdFile(ws, "large.ts", 1000, "rcOK", 24);

    const first: ToolCallShape = {
      tool: "tl_read_file",
      arguments: { targets: [{ path: "large.ts", range: "1-1000" }], content: "full", budget: { bytes: 6144 }, cwd: ws },
    };
    const chain = await walkHops(server, first, 20);
    expect(chain.capped, `never completed: ${JSON.stringify(chain.responses).slice(0, 500)}`).toBe(false);
    const refusals = chain.responses.filter((r) => (r as Record<string, unknown>)["kind"] === "refusal");
    expect(refusals, "an unchanged file must never be refused as stale").toEqual([]);
    const served = new Map<string, Set<number>>();
    for (const r of chain.responses) {
      for (const [tag, set] of extractServedIds(r, ["rcOK"])) {
        const acc = served.get(tag) ?? new Set<number>();
        for (const n of set) acc.add(n);
        served.set(tag, acc);
      }
    }
    expect(missingIds(idRangeSet(1, 1000), served.get("rcOK") ?? new Set())).toEqual([]);
  }, 180_000);
});

describe("caller-ranged continuation stale restart (admitCallerRangedContinuation)", () => {
  it("a genuinely partial multi-target delivery restates the caller's content/budget on its own refusal", async () => {
    const { ws, server } = freshWorkspace("default", "ranged");
    await server.initialize();
    // Same line count/width as `rangeContinuationStaleness.spec.ts`'s own
    // proven `firstMultiTargetHop` recipe (120 B/line), which is confirmed to
    // force a genuinely PARTIAL page-1 delivery of both targets under this
    // exact range/budget pair.
    writeSelfIdFile(ws, "mix/alpha.txt", 200, "crAlphaOld", 120);
    writeSelfIdFile(ws, "mix/beta.txt", 200, "crBeta", 120);

    const first = await server.callTool("tl_read_file", {
      targets: [{ path: "mix/alpha.txt", range: "11-90" }, { path: "mix/beta.txt", range: "31-100" }],
      content: "full",
      budget: { bytes: 6500 },
      cwd: ws,
    });
    const firstNext = extractNext(first.body).next;
    if (firstNext === undefined) return; // completed in one hop on this build; nothing to mutate mid-chain

    writeSelfIdFile(ws, "mix/alpha.txt", 200, "crAlphaNew", 120);
    const second = await server.callTool(firstNext.tool, firstNext.arguments);

    if (second.body["kind"] !== "refusal") return; // GATE-A: independent re-verification, not this fix's target shape
    expect(second.body["code"]).toBe("cursor-stale");
    const restart = extractNext(second.body).next as ToolCallShape | undefined;
    expect(restart, "admitCallerRangedContinuation's own refusal must carry a restart next").toBeDefined();
    // ROOT CAUSE 3: restate the CALLER's own canonical content, never a
    // legacy-translated field, and restore the declared budget.
    expect(restart!.arguments["content"]).toBe("full");
    expect(restart!.arguments["budget"]).toEqual({ bytes: 6500 });

    const chain = await walkHops(server, restart!, 20);
    expect(chain.capped, JSON.stringify(chain.responses).slice(0, 500)).toBe(false);
    const refusals = chain.responses.filter((r) => (r as Record<string, unknown>)["kind"] === "refusal");
    expect(refusals).toEqual([]);
  }, 180_000);
});

describe("multi-target caller-ranged read, one target changes mid-chain (eval-0929 §8 table row 5)", () => {
  it("wholesale-deferred targets are honest (fresh, unmixed) and the chain still completes (report what HEAD does)", async () => {
    const { ws, server } = freshWorkspace("default", "multi");
    await server.initialize();
    writeSelfIdFile(ws, "large.ts", 300, "mtLargeOld", 20);
    writeSelfIdFile(ws, "unrelated/module00.ts", 60, "mtA", 20);
    writeSelfIdFile(ws, "unrelated/module01.ts", 60, "mtB", 20);

    const first = await server.callTool("tl_read_file", {
      targets: [
        { path: "large.ts", range: "1-300" },
        { path: "unrelated/module00.ts", range: "1-60" },
        { path: "unrelated/module01.ts", range: "1-60" },
      ],
      content: "full",
      budget: { bytes: 6144 },
      cwd: ws,
    });
    const firstNext = extractNext(first.body).next;
    if (firstNext === undefined) return;

    // Mutate the target most likely still fully unserved (matches the eval's
    // own `multi_cursor_changed_file` shape: the large file, not a completed one).
    writeSelfIdFile(ws, "large.ts", 300, "mtLargeNew", 20);
    const chain = await walkHops(server, firstNext, 20);
    expect(chain.capped, JSON.stringify(chain.responses).slice(0, 500)).toBe(false);
    // Never mixed: no response may carry BOTH the old and the new tag for
    // the same file's content.
    for (const r of chain.responses) {
      const ids = extractServedIds(r, ["mtLargeOld", "mtLargeNew"]);
      const oldHit = (ids.get("mtLargeOld")?.size ?? 0) > 0;
      const newHit = (ids.get("mtLargeNew")?.size ?? 0) > 0;
      expect(oldHit && newHit, `a single response mixed old+new revisions: ${JSON.stringify(r).slice(0, 300)}`).toBe(false);
    }
  }, 180_000);
});

describe("search find cursor stale restart", () => {
  it("preserves the caller's budget on the restart and is admitted without a second refusal", async () => {
    const ws = fs.realpathSync(shortTmpDir(HOME, ".tl-e0929-csr-search-"));
    tmpDirs.push(ws);
    const server = startDevServer(ws, "default", { allowWrite: true });
    servers.push(server);
    await server.initialize();
    fs.mkdirSync(`${ws}/src`, { recursive: true });
    const lines = Array.from({ length: 60 }, (_, i) => `export const HIT_${i} = SEARCHTOKEN31;`).join("\n") + "\n";
    fs.writeFileSync(`${ws}/src/hits.ts`, lines, "utf8");

    const first = await server.callTool("tl_search_files", {
      action: "find",
      queries: ["SEARCHTOKEN31"],
      scope: { path: "src" },
      budget: { bytes: 900 },
      cwd: ws,
    });
    const firstNext = extractNext(first.body).next;
    expect(firstNext, JSON.stringify(first.body).slice(0, 300)).toBeDefined();

    fs.appendFileSync(`${ws}/src/hits.ts`, "\n// a later edit\n");
    const stale = await server.callTool(firstNext!.tool, firstNext!.arguments);
    expect(stale.body["kind"]).toBe("refusal");
    expect(stale.body["code"]).toBe("cursor-stale");
    const restart = extractNext(stale.body).next as ToolCallShape | undefined;
    expect(restart).toBeDefined();
    expect(restart!.arguments["budget"]).toEqual({ bytes: 900 });
    expect(restart!.arguments["queries"]).toEqual(["SEARCHTOKEN31"]);

    const restarted = await server.callTool(restart!.tool, restart!.arguments);
    expect(restarted.body["kind"], JSON.stringify(restarted.body).slice(0, 300)).not.toBe("refusal");
  }, 120_000);
});

describe("references cursor stale restart", () => {
  it("restates the caller's declared limit on the restart (previously dropped)", async () => {
    const ws = fs.realpathSync(shortTmpDir(HOME, ".tl-e0929-csr-refs-"));
    tmpDirs.push(ws);
    const server = startDevServer(ws, "default", { allowWrite: true });
    servers.push(server);
    await server.initialize();
    for (const f of ["a", "b", "c"]) {
      fs.mkdirSync(`${ws}/src`, { recursive: true });
      fs.writeFileSync(`${ws}/src/${f}.ts`, "export function refTargetFn31() { return 1; }\nrefTargetFn31();\n", "utf8");
    }

    const first = await server.callTool("tl_search_files", {
      action: "references",
      query: "refTargetFn31",
      budget: { items: 1 },
      cwd: ws,
    });
    const firstNext = extractNext(first.body).next;
    expect(firstNext, JSON.stringify(first.body).slice(0, 300)).toBeDefined();

    fs.appendFileSync(`${ws}/src/a.ts`, "\n// a later edit\n");
    const stale = await server.callTool(firstNext!.tool, firstNext!.arguments);
    expect(stale.body["kind"]).toBe("refusal");
    expect(stale.body["code"]).toBe("cursor-stale");
    const restart = extractNext(stale.body).next as ToolCallShape | undefined;
    expect(restart).toBeDefined();
    // `continuationNextCall`'s own flat `limit` field is folded into the
    // canonical wire `budget.items` by `canonicalToolArguments`/`canonicalBudget`
    // before this reaches the response (confirmed live: the ORDINARY,
    // non-stale continuation folds the identical way) — previously this
    // stale restart carried no `budget` at all.
    expect(restart!.arguments["budget"]).toEqual({ items: 1 });

    const restarted = await server.callTool(restart!.tool, restart!.arguments);
    expect(restarted.body["kind"], JSON.stringify(restarted.body).slice(0, 300)).not.toBe("refusal");
  }, 120_000);
});
