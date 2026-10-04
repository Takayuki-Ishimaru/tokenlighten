/**
 * copilotRetest1003r7.spec.ts — Copilot retest r7 (2026-10-03).
 *
 * r7's small task (MAI flash, no tool_search): in one of two TokenLighten runs
 * MAI called tl_search_files, received backoff.ts, config.ts and worker.ts
 * whole (TL_FIND_SMALL_BODIES), then re-read all three with read_file before
 * answering — three rounds, the native count. Nothing in the reply said the
 * text was whole: `context` also carries the dominant-edit window, a slice of
 * a larger file, and `range` "1-N" does not say N is the last line. So a whole
 * entry now says `whole: true` (before its `context`) and the reply's `hint`
 * says no read is needed (findText.ts `attachSmallFileContexts`).
 */
import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  attachSmallFileContexts,
  SMALL_FIND_BODY_MAX_LINES,
  SMALL_FIND_WHOLE_HINT,
} from "../features/search/find/findText.js";
import { startDevServer, type ServerHandle } from "./helpers/qualityFirstScenarios.js";
import { COPILOT_RETRY_FILES } from "./helpers/copilotCheckoutFixture.js";
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
  const ws = fs.realpathSync(shortTmpDir(HOME, ".tl-cp1003r7-"));
  dirs.push(ws);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), content, "utf8");
  }
  return ws;
}

async function start(ws: string, extraEnv: Readonly<Record<string, string>> = {}): Promise<ServerHandle> {
  const server = startDevServer(ws, "vscode", { toolSurface: "full", extraEnv });
  servers.push(server);
  await server.initialize();
  return server;
}

type FileEntry = { path: string; lines: number[]; snippets?: string[]; range?: string; context?: string; whole?: boolean };

function matchesOf(body: Record<string, any>): { files: FileEntry[]; hint?: string } {
  expect(body["kind"], JSON.stringify(body).slice(0, 400)).toBe("search.matches");
  return body["matches"] as { files: FileEntry[]; hint?: string };
}

/** The file's own text with its final newline dropped: what `context` carries. */
function wholeText(content: string): string {
  return content.replace(/\r?\n$/u, "");
}

// r7's exact first TokenLighten call (paired-updated-repeat-small, round 1),
// with the evaluator's absolute workspace path replaced by this workspace's.
const r7Call = (ws: string): Record<string, unknown> => ({
  action: "find",
  queries: ["retrySchedule|RETRY|backoff"],
  scope: { path: path.join(ws, "src"), regex: true },
});

describe("r7 — a find reply says which small files it carries whole", () => {
  it("r7's exact search marks all three files whole, ahead of their text, and its hint says no read is needed", async () => {
    const ws = workspace(COPILOT_RETRY_FILES);
    const server = await start(ws);
    const matches = matchesOf((await server.callTool("tl_search_files", r7Call(ws))).body);
    expect(matches.files.map((file) => file.path).sort()).toEqual(["src/backoff.ts", "src/config.ts", "src/worker.ts"]);
    for (const file of matches.files) {
      expect(file.whole, file.path).toBe(true);
      expect(file.context, file.path).toBe(wholeText(COPILOT_RETRY_FILES[file.path]!));
      const wire = JSON.stringify(file);
      expect(wire.indexOf('"whole":true'), file.path).toBeGreaterThan(-1);
      expect(wire.indexOf('"whole":true'), `${file.path}: whole reads before the text`).toBeLessThan(wire.indexOf('"context"'));
    }
    expect(matches.hint).toBe(SMALL_FIND_WHOLE_HINT);
  }, 90_000);

  it("TL_FIND_SMALL_BODIES=0 marks nothing whole and adds no hint", async () => {
    const ws = workspace(COPILOT_RETRY_FILES);
    const server = await start(ws, { TL_FIND_SMALL_BODIES: "0" });
    const matches = matchesOf((await server.callTool("tl_search_files", r7Call(ws))).body);
    expect(matches.files.length).toBe(3);
    for (const file of matches.files) {
      expect(file.whole, file.path).toBeUndefined();
      expect(file.context, file.path).toBeUndefined();
    }
    expect(String(matches.hint ?? "")).not.toContain(SMALL_FIND_WHOLE_HINT);
  }, 90_000);

  it("only an entry given its whole text is whole; a longer file keeps its snippets and stays unmarked", () => {
    const long = ["export const RETRY_NOTE = 1;", ...Array.from({ length: SMALL_FIND_BODY_MAX_LINES }, (_, i) => `// filler ${i}`)].join("\n") + "\n";
    const ws = workspace({ ...COPILOT_RETRY_FILES, "src/long.ts": long });
    const body: Record<string, unknown> = {
      files: [
        { path: "src/config.ts", lines: [1], snippets: ["export const RETRY_LIMIT = 3;"] },
        { path: "src/long.ts", lines: [1], snippets: ["export const RETRY_NOTE = 1;"] },
      ],
      total_files: 2,
    };
    attachSmallFileContexts(body, ws, false);
    const [config, longEntry] = body["files"] as FileEntry[];
    expect(config!.whole).toBe(true);
    expect(config!.context).toBe(wholeText(COPILOT_RETRY_FILES["src/config.ts"]!));
    expect(longEntry!.whole).toBeUndefined();
    expect(longEntry!.context).toBeUndefined();
    expect(longEntry!.snippets).toEqual(["export const RETRY_NOTE = 1;"]);
    expect(body["hint"]).toBe(SMALL_FIND_WHOLE_HINT);
  });

  it("a hint the reply already had keeps its place, and the whole-file hint follows it", () => {
    const ws = workspace(COPILOT_RETRY_FILES);
    const body: Record<string, unknown> = {
      files: [{ path: "src/config.ts", lines: [1] }],
      total_files: 1,
      hint: "src/worker.ts 1-5 handle=h1 is context to read from here",
    };
    attachSmallFileContexts(body, ws, false);
    expect(body["hint"]).toBe(`src/worker.ts 1-5 handle=h1 is context to read from here | ${SMALL_FIND_WHOLE_HINT}`);
  });

  it("adds no hint and marks nothing when nothing was attached: a dominant-edit window, a declared budget, or a capped result", () => {
    const ws = workspace(COPILOT_RETRY_FILES);
    // A dominant-edit window is a slice: left alone, never called whole.
    const windowed: Record<string, unknown> = {
      files: [{ path: "src/worker.ts", lines: [3, 4], range: "3-4", context: "export function retrySchedule(): number[] {\n  return Array.from({length: RETRY_LIMIT}, (_, i) => backoff(i));" }],
      total_files: 1,
      hint: "existing",
    };
    attachSmallFileContexts(windowed, ws, false);
    expect((windowed["files"] as FileEntry[])[0]!.whole).toBeUndefined();
    expect(windowed["hint"]).toBe("existing");

    const budgeted: Record<string, unknown> = { files: [{ path: "src/config.ts", lines: [1] }], total_files: 1 };
    attachSmallFileContexts(budgeted, ws, true);
    expect((budgeted["files"] as FileEntry[])[0]!.whole).toBeUndefined();
    expect(budgeted["hint"]).toBeUndefined();

    // total_files larger than files[]: the listing is not the whole result.
    const capped: Record<string, unknown> = { files: [{ path: "src/config.ts", lines: [1] }], total_files: 2 };
    attachSmallFileContexts(capped, ws, false);
    expect((capped["files"] as FileEntry[])[0]!.whole).toBeUndefined();
    expect(capped["hint"]).toBeUndefined();
  });
});
