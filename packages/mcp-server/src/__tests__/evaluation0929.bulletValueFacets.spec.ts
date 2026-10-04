/**
 * evaluation0929.bulletValueFacets.spec.ts — WP-C4 item 1 (eval-0929 §8,
 * matrix rows "bullets"/"ja_bullets"): a bulleted point whose value noun (statuses,
 * codes, values, limits, settings, ...) only carries a leading which/what/
 * allowed FRAME elsewhere in requestFacets.ts never fired bare, so a bullet
 * shaped "<value noun> <passive verb> by <agent>" ("Retry statuses checked
 * by canRetry") named NO facet at all — the point silently vanished from
 * `extractFacetRequirements`'s output. Separately, the cuts-based clause
 * splitter glued a residual list-marker fragment ("\n-", a leading JA "・")
 * onto a clause's edge because the generic delimiter trim has no entry for
 * a bullet/number/circled-numeral marker character.
 *
 * Unit tests on the pure `extractFacetRequirements` (fs-free, no server),
 * then one end-to-end check that the resolved value facet actually serves
 * the named constant/callable through a spawned dev server.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { extractFacetRequirements } from "../features/task-pack/requestFacets.js";
import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { startDevServer, followNextToEnd, finalDecisionKind, type ServerHandle } from "./helpers/qualityFirstScenarios.js";

// ---------------------------------------------------------------------------
// 1. Unit: bullet clauses each get their own, clean facet requirement.
// ---------------------------------------------------------------------------

describe("extractFacetRequirements — a bulleted value noun fired only inside a which/what/allowed frame elsewhere now also fires via a passive/possessive owner", () => {
  it("EN bullets: every bullet gets its own facet, with no residual marker on the clause", () => {
    const reqs = extractFacetRequirements(
      "Explain the job client:\n- Default limit returned by fetchLimit\n- Retry statuses checked by canRetry\n- Callers of dispatchJob",
    );
    const byFacet = (facet: string) => reqs.filter((r) => r.facet === facet);
    expect(byFacet("value").map((r) => r.subjectIdentifiers[0]).sort()).toEqual(["canRetry", "fetchLimit"]);
    expect(byFacet("callers").map((r) => r.subjectIdentifiers[0])).toEqual(["dispatchJob"]);
    // No clause carries a leftover "\n-"/"\n*"/digit-marker fragment at either edge.
    for (const r of reqs) {
      expect(r.clause, JSON.stringify(r.clause)).not.toMatch(/\n[ \t]*[-*•][ \t]*$/u);
      expect(r.clause, JSON.stringify(r.clause)).not.toMatch(/^[ \t]*[-*•・][ \t]*/u);
    }
  });

  it("EN bullets, snake_case identifiers (Python-shaped)", () => {
    const reqs = extractFacetRequirements(
      "Explain the job client:\n- Default limit returned by fetch_limit\n- Retry statuses checked by can_retry\n- Callers of dispatch_job",
    );
    expect(reqs.some((r) => r.facet === "value" && r.subjectIdentifiers.includes("can_retry"))).toBe(true);
    expect(reqs.some((r) => r.facet === "value" && r.subjectIdentifiers.includes("fetch_limit"))).toBe(true);
    expect(reqs.some((r) => r.facet === "callers" && r.subjectIdentifiers.includes("dispatch_job"))).toBe(true);
  });

  it("JA bullets (・ marker): both value bullets resolve despite the leading marker", () => {
    const reqs = extractFacetRequirements(
      "ジョブクライアントについて説明してください。\n・fetchLimit が返す既定の上限値\n・canRetry が判定する再試行ステータス\n・dispatchJob の呼び出し元",
    );
    // The leading "・" is deliberately LEFT on the clause (not stripped) so
    // this module's own `clause` stays textually identical to
    // requestItems.ts's own `item.text` for the SAME bullet -- stripping it
    // here broke `facetClauseMatchesItem`'s one-directional substring match
    // in facetGate.ts (see `stripListMarkerEdges`'s own doc comment); it
    // does not interfere with facet detection or identifier extraction
    // either way, which is what this test actually guards.
    expect(reqs.some((r) => r.facet === "value" && r.subjectIdentifiers.includes("canRetry"))).toBe(true);
    expect(reqs.some((r) => r.facet === "callers" && r.subjectIdentifiers.includes("dispatchJob"))).toBe(true);
  });

  it("the possessive owner shape ('f's X') also yields a value facet, generalizing past 'checked by'", () => {
    const reqs = extractFacetRequirements("Explain canRetry's retry statuses and the config's request limits.");
    expect(reqs.some((r) => r.facet === "value" && r.subjectIdentifiers.includes("canRetry"))).toBe(true);
  });

  it("recall control: the ordinary sentence form (no bullets) is unaffected", () => {
    const reqs = extractFacetRequirements("What retry statuses does canRetry check?");
    expect(reqs.some((r) => r.facet === "value" && r.subjectIdentifiers.includes("canRetry"))).toBe(true);
  });

  it("recall control: a bare mention of 'status'/'code' with no owning agent still never fires a spurious value facet", () => {
    const reqs = extractFacetRequirements("Explain how the HTTP status code is logged for observability.");
    expect(reqs.some((r) => r.facet === "value")).toBe(false);
  });

  it("recall control: 'default branch'/'value objects' negative guards still hold beside a passive-agent phrase", () => {
    const reqs = extractFacetRequirements("Explain the default branch checked by mergeGate.");
    // "default branch" is a guarded compound; VALUE_NOUN_CLASS has no "branch"
    // member either, so this must not manufacture a value facet.
    expect(reqs.some((r) => r.facet === "value")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. End-to-end: the bulleted value point actually resolves to real evidence.
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
  const ws = fs.realpathSync(shortTmpDir(HOME, ".tl-e0929-bullets-"));
  tmpDirs.push(ws);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), content, "utf8");
  }
  return ws;
}

describe("end-to-end: a bulleted 'checked by' value point serves the real evidence", () => {
  it("the retry-statuses bullet resolves to the module the constant is read from", async () => {
    const ws = workspace({
      "src/limits.py": "BASE_LIMIT = 8641\nRETRY_STATUSES = {419, 432, 598}\n",
      "src/rules.py": "from src.limits import RETRY_STATUSES\n\n\ndef can_retry(status, attempt):\n    return status in RETRY_STATUSES and attempt < 3\n",
      "src/api.py": "from src.limits import BASE_LIMIT\nfrom src.rules import can_retry\n\n\ndef fetch_limit():\n    return BASE_LIMIT\n\n\ndef dispatch_job(status):\n    return can_retry(status, 0)\n",
    });
    const server = startDevServer(ws, "default");
    servers.push(server);
    await server.initialize();
    const query = "Explain the job client:\n- Default limit returned by fetch_limit\n- Retry statuses checked by can_retry\n- Callers of dispatch_job";
    const chain = await followNextToEnd(
      server,
      { tool: "tl_read_file", arguments: { query, cwd: ws, task: { epoch: "new", profile: "answer" } } },
      { cwd: ws, hopCap: 6 },
    );
    expect(finalDecisionKind(chain)).toBe("act.answer");
    const servedText = JSON.stringify(chain.hops.map((h) => h.response));
    expect(servedText, servedText).toMatch(/RETRY_STATUSES/u);
  }, 60_000);
});
