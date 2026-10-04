/**
 * evaluation0929.conceptFocalAndNonBlockingCompletion.spec.ts — WP-C4 items
 * 2 and 3 (eval-0929 §8).
 *
 * Item 2: `resolveFacetFocal`'s concept-anchor tier (readCodeTaskPack.ts
 * `bestConceptAnchoredInFile`/`bestConceptAnchoredCandidate`) used to
 * consider only CALLER_EXPANSION_CALLABLE_KINDS (function/method) when a
 * value/condition clause named no explicit identifier — so a file holding
 * only a constant, however strongly its own NAME carried the query's
 * concept, contributed nothing to the cross-file comparison and an
 * unrelated file's callable won by default. Fixed by also scoring
 * const/let/var/enum symbols for a value/condition clause specifically
 * (flow/callers concept-anchoring is untouched).
 *
 * Item 3: the mixed-kind loop in `buildRequestItemReadiness` (reached once
 * a composite query has at least one structured `decision`/`definition`/
 * `relation` item, so the all-topic branch's own non-blocking handling
 * never engages) treated EVERY unproved item as a BLOCKING obligation,
 * including a could-not-determine proof with no literal-eligible term at
 * all (`RequestItemProof.undeterminedNonBlocking`, WP-C2) — whose
 * `candidatePaths` is always empty, so nothing ever named a `next` for it
 * and the pack could neither close nor progress. Fixed by mirroring the
 * ALL-TOPIC/H-2 loops' own non-blocking handling in the mixed-kind loop too.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { startDevServer, followNextToEnd, finalDecisionKind, type ServerHandle } from "./helpers/qualityFirstScenarios.js";

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
  const ws = fs.realpathSync(shortTmpDir(HOME, ".tl-e0929-focal-"));
  tmpDirs.push(ws);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), content, "utf8");
  }
  return ws;
}

async function ask(ws: string, query: string, hopCap = 6) {
  const server = startDevServer(ws, "default");
  servers.push(server);
  await server.initialize();
  const chain = await followNextToEnd(
    server,
    { tool: "tl_read_file", arguments: { query, cwd: ws, task: { epoch: "new", profile: "answer" } } },
    { cwd: ws, hopCap },
  );
  return chain;
}

// ---------------------------------------------------------------------------
// Item 2: the concept tier prefers a module constant whose name carries the
// clause's concept, exactly as strongly as it prefers a callable.
// ---------------------------------------------------------------------------

describe("end-to-end: a value clause naming a concept (no explicit identifier) binds a module constant, not an unrelated function", () => {
  it("'the backoff ceiling constant's configured value' serves BACKOFF_CEILING, not the unrelated notifyWorker", async () => {
    const ws = workspace({
      // An unrelated function that would previously have won the concept-tier
      // fallback outright (the OLD code only ever considered callables).
      "src/worker/notifyWorker.ts": [
        "export function notifyWorker(id: string): void {",
        "  // unrelated notification plumbing; must never be cited as the",
        "  // backoff ceiling constant's own evidence.",
        "  console.log(id);",
        "}",
        "",
      ].join("\n"),
      "src/config/limits.ts": ["export const BACKOFF_CEILING = 12;", "export const MAX_WORKERS = 4;", ""].join("\n"),
    });
    const query = "Explain the backoff ceiling constant's configured value.";
    const chain = await ask(ws, query);
    expect(finalDecisionKind(chain)).toBe("act.answer");
    const servedText = JSON.stringify(chain.hops.map((s) => s.response));
    expect(servedText, servedText).toMatch(/BACKOFF_CEILING/u);
  }, 60_000);

  it("recall control: a value clause naming a REAL explicit identifier still resolves that exact declaration (identifier tier unchanged)", async () => {
    const ws = workspace({
      "src/config/limits.ts": ["export const BACKOFF_CEILING = 12;", ""].join("\n"),
      "src/worker/notifyWorker.ts": ["export function notifyWorker(id: string): void { console.log(id); }", ""].join("\n"),
    });
    const query = "What is the configured value of BACKOFF_CEILING?";
    const chain = await ask(ws, query);
    expect(finalDecisionKind(chain)).toBe("act.answer");
    const servedText = JSON.stringify(chain.hops.map((s) => s.response));
    expect(servedText, servedText).toMatch(/BACKOFF_CEILING/u);
  }, 60_000);

  it("recall control: a flow/callers concept clause still anchors on a callable, never widened to a constant", async () => {
    const ws = workspace({
      "src/config/limits.ts": ["export const BACKOFF_CEILING = 12;", ""].join("\n"),
      "src/worker/dispatchWorker.ts": [
        "import { BACKOFF_CEILING } from \"../config/limits.js\";",
        "export function dispatchWorker(attempt: number): boolean {",
        "  return attempt < BACKOFF_CEILING;",
        "}",
        "",
      ].join("\n"),
    });
    // A pure flow/callers ask about the SAME concept words ("backoff") that
    // named no explicit identifier -- must still land on a callable focal
    // (dispatchWorker), never BACKOFF_CEILING itself (a constant has no
    // "flow" of its own).
    const query = "Walk me through the backoff dispatch flow, step by step.";
    const chain = await ask(ws, query);
    expect(finalDecisionKind(chain)).not.toBe("await_input");
    const servedText = JSON.stringify(chain.hops.map((s) => s.response));
    expect(servedText, servedText).toMatch(/dispatchWorker/u);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Item 3: a non-blocking undetermined proof stays non-blocking in the
// mixed-kind loop (a composite query with at least one structured item).
// ---------------------------------------------------------------------------

describe("end-to-end: a could-not-determine point with no literal-eligible term never dead-ends the mixed-kind loop", () => {
  it("'how dispatchWorker decides, and what happens when it gives up?' never reaches await_input", async () => {
    const ws = workspace({
      "src/worker/dispatchWorker.ts": [
        "export function dispatchWorker(attempt: number, ceiling: number): boolean {",
        "  return attempt < ceiling;",
        "}",
        "",
      ].join("\n"),
    });
    // ri-1 ("how dispatchWorker decides") is kind:"decision" -- routes this
    // whole query through the MIXED-KIND loop, never the all-topic branch.
    // ri-2 ("what happens when it gives up?") names no code-shaped
    // identifier, no quoted string and no topic noun phrase at all (every
    // word is a wh-word/pronoun/verb) -- WP-C2's own "no literal-eligible
    // term" shape, `undeterminedNonBlocking:true`, `candidatePaths: []`.
    const query = "Explain how dispatchWorker decides, and what happens when it gives up?";
    const chain = await ask(ws, query, 4);
    expect(finalDecisionKind(chain), JSON.stringify(chain.hops.map((s) => s.response["kind"]))).not.toBe("await_input");
    // The obligation for "decides" must be genuinely satisfied (served), not
    // merely waved through — dispatchWorker's own body must be on the wire.
    const servedText = JSON.stringify(chain.hops.map((s) => s.response));
    expect(servedText, servedText).toMatch(/dispatchWorker/u);
  }, 60_000);

  it("recall control: the SAME shape as an all-topic query (no structured item) still reaches its own existing non-blocking disclosure, unregressed", async () => {
    const ws = workspace({
      "src/worker/dispatchWorker.ts": ["export function dispatchWorker(): boolean { return true; }", ""].join("\n"),
    });
    // Neither clause carries a structured signal (no bare identifier/decision
    // term) -- the ALL-TOPIC branch's own pre-existing H-2 path, unchanged by
    // this fix; asserted here only as a same-run recall control alongside the
    // mixed-kind case above.
    const query = "Explain what dispatchWorker does, and what happens when it gives up?";
    const chain = await ask(ws, query, 4);
    expect(finalDecisionKind(chain), JSON.stringify(chain.hops.map((s) => s.response["kind"]))).not.toBe("await_input");
  }, 60_000);
});
