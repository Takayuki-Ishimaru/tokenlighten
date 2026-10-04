/**
 * copilotRetest1002r4.citationGaps.spec.ts — Copilot retest r4 (2026-10-02).
 *
 * The retest's only remaining false gap: the evaluator's exact r3 call, served
 * every file it needs and certified `act.answer`, still carried
 *
 *   request-item-absent:source (no occurrence in scanned workspace files; scope complete)
 *
 * because "Need source line numbers; read relevant checkout source files" forms
 * clauses with no identifier in them, so their nouns were read as the subject of
 * a request item. The same shape certified line / lines / files / snippets /
 * sources / excerpts / evidence (and "cite", read as a noun) in a workspace that
 * never spells them. These words say how the ANSWER should cite the workspace;
 * every workspace has sources, files, lines and snippets, so the literal absence
 * of the word says nothing about this one (readCodeTaskPack.ts
 * GENERIC_SOFTWARE_ABSENCE_WORDS), and "cite"/"quote"/"read"/"include"/"point"
 * lead such a clause like "show"/"list" (requestItems.ts topicLeadVerbs). With
 * the words out of the absence candidates the same clauses fell through to
 * `request-item-undetermined:read/relevant/...`, so a citation clause that names
 * nothing unserved is no point at all (`citationClauseNamesOnlyServedThings`):
 * neither absent nor undetermined.
 *
 * Recall controls: a genuinely absent subject is still disclosed, in a clause of
 * its own and beside a citation instruction in the same clause.
 */
import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { startDevServer, followNextToEnd, collectDisclosureTexts, type ServerHandle } from "./helpers/qualityFirstScenarios.js";
import { COPILOT_CHECKOUT_FILES, COPILOT_RETRY_FILES } from "./helpers/copilotCheckoutFixture.js";
import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";

const HOME = os.homedir();
const dirs: string[] = [];
const servers: ServerHandle[] = [];

afterAll(async () => {
  for (const server of servers) await server.kill();
  for (const dir of dirs) rmDirWithRetry(dir);
});

function workspace(files: Readonly<Record<string, string>>): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, ".tl-cp1002r4g-"));
  dirs.push(ws);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), content, "utf8");
  }
  return ws;
}

async function ask(ws: string, query: string, profile: "answer" | undefined = "answer") {
  const server = startDevServer(ws, "vscode", { toolSurface: "full" });
  servers.push(server);
  await server.initialize();
  const task: Record<string, unknown> = { epoch: "new" };
  if (profile !== undefined) task["profile"] = profile;
  const chain = await followNextToEnd(server, { tool: "tl_read_file", arguments: { query, task, cwd: ws } }, { cwd: ws, hopCap: 6 });
  const disclosures = collectDisclosureTexts(chain);
  return { chain, absent: absentTerms(disclosures), requestItemGaps: disclosures.filter((text) => /request-item-(?:absent|undetermined)/u.test(text)) };
}

/** Every term a `request-item-absent:<term>` disclosure names. */
function absentTerms(disclosures: readonly string[]): string[] {
  const out = new Set<string>();
  for (const text of disclosures) for (const m of text.matchAll(/request-item-absent:([^\s(]+)/gu)) out.add(m[1]!);
  return [...out];
}

describe("Copilot retest r4 — the evaluator's call names no citation word absent", () => {
  it("the exact r3 call with the profile omitted: act.answer, the nine checkout files, no `source` gap", async () => {
    const ws = workspace(COPILOT_CHECKOUT_FILES);
    const { chain, absent, requestItemGaps } = await ask(
      ws,
      "Inspect src/checkout and calculate exact quote() results for carts A, B, and C. Trace quote(), product prices and giftcard handling, member/coupon/points discount order, shipping eligibility and region/method pricing, tax, and rounding. Need source line numbers; read relevant checkout source files.",
      undefined,
    );
    const first = chain.hops[0]?.response as Record<string, any> | undefined;
    expect(first?.["decision"]?.["kind"], JSON.stringify(first?.["decision"])).toBe("act.answer");
    const served = new Set(((first?.["evidence"] ?? []) as Array<{ path?: string }>).map((row) => row.path));
    for (const name of ["quote", "lines", "catalog", "membership", "coupons", "points", "shipping", "tax", "constants"]) {
      expect(served.has(`src/checkout/${name}.ts`), name).toBe(true);
    }
    expect(absent).not.toContain("source");
    expect(absent).not.toContain("line");
    expect(requestItemGaps, "no absent or undetermined point for a citation clause").toEqual([]);
  }, 90_000);
});

describe("Copilot retest r4 — citation clauses certify nothing absent or undetermined", () => {
  const CASES: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["Explain retrySchedule(); include line numbers.", ["line", "numbers", "include"]],
    ["Explain retrySchedule(), quoting the exact lines.", ["lines", "quoting"]],
    ["Explain retrySchedule(); read the relevant files.", ["files", "read"]],
    ["Explain retrySchedule(); show code snippets.", ["snippets"]],
    ["Explain retrySchedule(); give file paths and line ranges.", ["line", "ranges"]],
    ["Explain retrySchedule(); cite file names.", ["cite"]],
    ["Explain retrySchedule(); quote the source lines.", ["source", "quote", "lines"]],
    ["Explain retrySchedule(); read the source files first.", ["source", "read", "files"]],
    ["Explain retrySchedule(); list your sources.", ["sources"]],
    ["Explain retrySchedule(); include short excerpts.", ["excerpts", "include"]],
    ["Explain retrySchedule(); give line-numbered evidence.", ["evidence"]],
    ["Explain retrySchedule(); point to exact locations.", ["point", "locations"]],
  ];
  for (const [query, words] of CASES) {
    it(query, async () => {
      const { absent, requestItemGaps } = await ask(workspace(COPILOT_RETRY_FILES), query);
      for (const word of words) expect(absent, `${word}: ${JSON.stringify(absent)}`).not.toContain(word);
      expect(requestItemGaps, "a citation clause is no point: neither absent nor undetermined").toEqual([]);
    }, 90_000);
  }
});

describe("Copilot retest r4 — recall controls: an absent subject in its own clause is still disclosed", () => {
  const CONTROLS: ReadonlyArray<readonly [string, RegExp, readonly string[]]> = [
    ["Explain retrySchedule(); describe the refund ledger.", /^refund$|^ledger$/u, []],
    ["Explain retrySchedule(); cite the refund ledger source lines.", /^refund$|^ledger$/u, ["source", "lines", "cite"]],
    ["Explain retrySchedule(); read the refund ledger files.", /^refund$|^ledger$/u, ["files", "read"]],
    ["Explain retrySchedule(); list the sources of jitter.", /^jitter$/u, ["sources"]],
    ["Explain retrySchedule(); quote the webhook source.", /^webhook$/u, ["source", "quote"]],
  ];
  for (const [query, absentSubject, notAbsent] of CONTROLS) {
    it(query, async () => {
      const { absent } = await ask(workspace(COPILOT_RETRY_FILES), query);
      expect(absent.some((term) => absentSubject.test(term)), JSON.stringify(absent)).toBe(true);
      for (const word of notAbsent) expect(absent, `${word}: ${JSON.stringify(absent)}`).not.toContain(word);
    }, 90_000);
  }
});
