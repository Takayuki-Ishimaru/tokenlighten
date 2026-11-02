/**
 * answerEvidenceLowValueDocPenalty.spec.ts — 2026-10-29 first-hop field report.
 *
 * `answerEvidencePathPenalty` (readCodeTaskPack.ts) used to demote only tests,
 * fixtures and `changelog.*` / `changes.*`. A `History.md` or a `docs/` page
 * mentions an identifier on some line as often as the code that defines it, so
 * a lexical ranker put the changelog ahead of the implementation of a behaviour
 * question. These pin the +3 for a low-value document the question does not
 * name, through the exported ranker, using two files with IDENTICAL text so
 * the only difference between the candidates is the path.
 */
import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ImpactCandidate } from "@tokenlighten/types";

import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { shortTmpDir } from "./helpers/shortTmpDir.js";
import {
  FileReadCache,
  rankAnswerEvidenceCandidates,
} from "../features/task-pack/readCodeTaskPack.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const tmpDirs: string[] = [];
afterAll(async () => {
  for (const dir of tmpDirs.splice(0)) {
    try { await rmDirWithRetry(dir); } catch { /* best-effort cleanup */ }
  }
});

const SOURCE = [
  "function redirect(url) {",
  "  const address = encode(url);",
  "  return respond(302, address);",
  "}",
  "",
  "function encode(url) {",
  "  return String(url);",
  "}",
  "",
].join("\n");

function workspace(rels: readonly string[]): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, ".tl-lowvalue-"));
  tmpDirs.push(ws);
  for (const rel of rels) {
    const abs = path.join(ws, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, SOURCE, "utf8");
  }
  return ws;
}

const candidate = (file: string): ImpactCandidate => ({ path: file, line: 1, surface: "domain", confidence: 0.8, why: "definition" });

async function scoreOf(ws: string, file: string, query: string): Promise<number> {
  const ranked = await rankAnswerEvidenceCandidates([candidate(file)], query, ws, new FileReadCache());
  expect(ranked.length).toBe(1);
  return ranked[0]!.score;
}

describe("answerEvidencePathPenalty — low-value documents on a behaviour question", () => {
  it("demotes a docs/ page by 3 against identical code under lib/", async () => {
    const ws = workspace(["lib/redirect.js", "docs/redirect.js"]);
    const query = "How does redirect work?";
    const implementation = await scoreOf(ws, "lib/redirect.js", query);
    const documented = await scoreOf(ws, "docs/redirect.js", query);
    expect(implementation - documented).toBe(3);
  });

  it("demotes a change-log by name, wherever it lives", async () => {
    const ws = workspace(["lib/redirect.js", "notes/History.js.txt", "NEWS.txt"]);
    const query = "How does redirect work?";
    const implementation = await scoreOf(ws, "lib/redirect.js", query);
    expect(implementation - await scoreOf(ws, "NEWS.txt", query)).toBe(3);
    expect(implementation - await scoreOf(ws, "notes/History.js.txt", query)).toBe(3);
  });

  it("does not demote when the question names the document", async () => {
    const ws = workspace(["lib/redirect.js", "docs/redirect.js"]);
    const query = "How does redirect work according to docs/redirect.js?";
    const implementation = await scoreOf(ws, "lib/redirect.js", query);
    const documented = await scoreOf(ws, "docs/redirect.js", query);
    expect(implementation - documented).not.toBe(3);
  });

  it("does not demote when the question is not about behaviour or an answer", async () => {
    const ws = workspace(["lib/redirect.js", "docs/redirect.js"]);
    const query = "Rename redirect to sendRedirect";
    const implementation = await scoreOf(ws, "lib/redirect.js", query);
    const documented = await scoreOf(ws, "docs/redirect.js", query);
    expect(implementation - documented).toBe(0);
  });

  it("keeps the existing 3-point penalty for a test file, and does not stack the two", async () => {
    const ws = workspace(["lib/redirect.js", "lib/redirect.spec.js", "docs/redirect.spec.js"]);
    const query = "How does redirect work?";
    const implementation = await scoreOf(ws, "lib/redirect.js", query);
    expect(implementation - await scoreOf(ws, "lib/redirect.spec.js", query)).toBe(3);
    expect(implementation - await scoreOf(ws, "docs/redirect.spec.js", query)).toBe(3);
  });
});
