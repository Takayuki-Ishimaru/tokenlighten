/**
 * owedRowsLanguages.spec.ts — the rows of an owed member in a language the effects were not written for
 * (2026-10-24, the generality audit), end to end: a spawned dev server, a map-shaped question about a
 * C# and a Python `OrderDesk` (helpers/owedRowsDeskLanguages.ts) under the Copilot CLI ceiling. The
 * first page holds the first steps whole; every later step is owed, and — as in owedRowsFit.spec.ts, for
 * the Java desk — as its rows when they fit one continuation page. What those rows must hold in C# is a
 * file written (`File.WriteAllText`), a directory created, a property and an element written and the
 * `try` / `catch` of the bill; in Python a file written in a `with`, a `session.commit()`, an attribute
 * and an element written and the `try` / `except`: none of which the vocabulary of 2026-10-23 (`.setX(`,
 * `save(`, `*Repository`, "audit", a `try` that calls a concern or an injected field) found. The
 * arithmetic between them is no row. The rules per statement are memberRows.spec.ts.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { startDevServer, type ServerHandle } from "./helpers/qualityFirstScenarios.js";
import { csharpDesk, isFillerLine, LANGUAGE_DESK_QUERY, pythonDesk, writeLanguageDesk, type LanguageDesk, type LanguageDeskStep } from "./helpers/owedRowsDeskLanguages.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const CEILING = 18_432;
const COPILOT_ENV = { TOKENLIGHTEN_CLIENT_ID: "copilot-cli", TOKENLIGHTEN_CLIENT: "copilot-cli", TOKENLIGHTEN_TOOL_SURFACE: "full", TL_LEGACY_INPUT: "refuse" };
const TASK = { epoch: "new", profile: "answer" };

const tmpDirs: string[] = [];
const servers: ServerHandle[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.kill();
});
afterAll(async () => {
  for (const server of servers.splice(0)) await server.kill();
  for (const dir of tmpDirs.splice(0)) {
    try { await rmDirWithRetry(dir); } catch { /* best-effort cleanup */ }
  }
});

interface Reply { readonly body: any; readonly bytes: number }

/** The desk asked for its map and followed from the first call to the act.answer; the lines the replies carry, by number. */
async function run(desk: LanguageDesk, extraEnv: Record<string, string>, limit = 12): Promise<{ replies: Reply[]; served: Map<number, string> }> {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(HOME, ".tl-owedlang-")));
  tmpDirs.push(ws);
  writeLanguageDesk(ws, desk);
  const server = startDevServer(ws, "default", { toolSurface: "full", allowWrite: true, extraEnv });
  servers.push(server);
  await server.initialize();
  const replies: Reply[] = [];
  let call: { tool: string; arguments: Record<string, unknown> } = { tool: "tl_read_file", arguments: { cwd: ws, query: LANGUAGE_DESK_QUERY, task: TASK } };
  for (let step = 0; step < limit; step++) {
    const { body, textBytes } = await server.callTool(call.tool, call.arguments.cwd === undefined ? { cwd: ws, ...call.arguments } : call.arguments);
    replies.push({ body, bytes: textBytes });
    const decision = body?.decision ?? {};
    if (decision.kind !== "discover") break;
    call = Array.isArray(decision.next) ? decision.next[0] : decision.next;
  }
  const served = new Map<number, string>();
  for (const { body } of replies) {
    for (const row of (body?.evidence ?? []) as any[]) {
      if (typeof row?.body !== "string" || row.path !== desk.file) continue;
      const window = /^(\d+)-(\d+)$/u.exec(String(row.range ?? ""));
      row.body.split("\n").forEach((text: string, index: number) => {
        const gutter = /^(\d+)\|(.*)$/u.exec(text);
        if (gutter) served.set(Number(gutter[1]), gutter[2]!);
        else if (window && Number(window[1]) + index <= Number(window[2])) served.set(Number(window[1]) + index, text);
      });
    }
  }
  return { replies, served };
}

const holds = (desk: LanguageDesk, served: Map<number, string>, line: number): boolean => served.get(line) === desk.lines[line - 1];

describe.each([
  // C#'s question ends in `await_input` today, with or without these rows: the facet gate finds no callable evidence for billing / stock /
  // delivery in a C# type (the same on the snapshot of 2026-10-24, before the rows changed). The rows are what this spec reads there.
  ["C#", () => csharpDesk(16), undefined],
  ["Python", () => pythonDesk(16), "act.answer"],
] as const)("%s: a map owes its members as rows, and the rows hold the saves, the writes and the failure handling", (_name, make, ending) => {
  it("under the Copilot CLI ceiling: one cursor, the effects and the handlers served, the arithmetic not", async () => {
    const desk = make();
    const { replies, served } = await run(desk, COPILOT_ENV);
    const kinds = replies.map(reply => reply.body.decision.kind);
    expect(kinds[0], JSON.stringify(replies.map(reply => reply.bytes))).toBe("discover");
    expect(kinds.length).toBe(2);
    if (ending !== undefined) expect(kinds[1]).toBe(ending);
    for (const reply of replies) expect(reply.bytes).toBeLessThanOrEqual(CEILING);
    expect(Array.isArray(replies[0]!.body.decision.next), "no sibling cursors").toBe(false);
    const allRows = (step: LanguageDeskStep): boolean => step.rows.every(row => holds(desk, served, row.line));
    const rowSteps = desk.steps.filter(step => allRows(step) && step.filler.every(line => !served.has(line)));
    const wholeSteps = desk.steps.filter(step => allRows(step) && step.filler.every(line => holds(desk, served, line)));
    // The first page holds the first steps whole; every later one is owed as its rows (and at most one is cut by the page).
    expect(rowSteps.length, "owed steps served as rows").toBeGreaterThanOrEqual(5);
    expect(wholeSteps.length, "steps on the page").toBeGreaterThanOrEqual(3);
    expect(desk.steps.filter(step => !allRows(step)).map(step => step.name), "every step serves at least its rows").toEqual([]);
    // What a row holds, line for line, in the last owed step: the try with both calls, the handler whole, the writes, the saves, the dispatch.
    const last = rowSteps.at(-1)!;
    for (const row of last.rows) expect(served.get(row.line), `${last.name}: ${row.text}`).toBe(desk.lines[row.line - 1]);
    for (const line of last.filler) expect(isFillerLine(served.get(line) ?? ""), `${last.name}: line ${line} is arithmetic`).toBe(false);
  }, 240_000);
});
