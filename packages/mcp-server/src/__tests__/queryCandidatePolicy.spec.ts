import { describe, expect, it } from "vitest";
import { boundedQueryCandidates, hasConfirmedQueryCandidateAnchor, hasQueryCodeAnchor, needsQueryCandidateSelection, QUERY_CANDIDATE_BYTES, QUERY_CANDIDATE_LIMIT } from "../features/task-pack/queryCandidatePolicy.js";
import type { LocateOutput } from "@tokenlighten/types";

describe("unanchored query safety boundary", () => {
  it.each([
    "How does Flask decide which error handler to use?",
    "Flaskは例外時にどのエラーハンドラを選びますか？",
    "How does requests change the method and strip authentication on redirects?",
    "Add a Flask configuration key, with config docs and tests.",
    "How does TokenLighten choose a continuation?",
    "Explain the behavior. Include tests.",
    "Explain the service behavior, e.g. its results.",
    "Explain the behavior at https://flask.palletsprojects.com/en/stable/",
    "How does Flask choose a handler? Explain the order. Mention the default.",
  ])("requires candidate selection for prose: %s", (query) => {
    expect(needsQueryCandidateSelection({ query }, { namedFile: false, artifact: false })).toBe(true);
  });

  it.each(["Explain _find_error_handler", "Explain rebuildMethod", "Explain Session.rebuild_auth", "Explain dispatch()", 'Where does the "Redirecting to" message come from?', "Fix the help so count options show [default: (unlimited)]"])("recognizes explicit code syntax: %s", (query) => {
    expect(hasQueryCodeAnchor(query)).toBe(true);
  });

  it("preserves exact caller targets and actual artifacts", () => {
    const args = { query: "Explain the matching rules" };
    expect(needsQueryCandidateSelection(args, { namedFile: true, artifact: false })).toBe(false);
    expect(needsQueryCandidateSelection(args, { namedFile: false, artifact: true })).toBe(false);
    expect(needsQueryCandidateSelection({ ...args, symbol: "dispatch" }, { namedFile: false, artifact: false })).toBe(false);
  });

  it("bounds metadata and never copies locator code, handles or confidence into evidence", () => {
    const located = {
      hit: true, primary: Array.from({ length: 100 }, (_, i) => ({ path: `src/file${i}.ts`, line: i + 1, range: `${i + 1}-${i + 2}`, symbol: `fn${i}`, handle: "unserved", code: "UNRELATED_BODY", confidence: 1, surface: "api" })), related: [],
    } as unknown as LocateOutput;
    const candidates = boundedQueryCandidates(located);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThanOrEqual(QUERY_CANDIDATE_LIMIT);
    expect(Buffer.byteLength(JSON.stringify(candidates))).toBeLessThanOrEqual(QUERY_CANDIDATE_BYTES);
    expect(JSON.stringify(candidates)).not.toMatch(/UNRELATED_BODY|unserved|confidence/);
    for (const candidate of candidates) expect(candidate.range).toMatch(/^\d+-\d+$/);
    const oneLine = boundedQueryCandidates(located, () => 1);
    expect(oneLine).toEqual([{ path: "src/file0.ts", line: 1, range: "1-1", symbol: "fn0", kind: "api" }]);
  });
});


describe("confirmation of request-spelled candidate identities", () => {
  it("requires an exact declaration, not locator labels, case folding, or a longer name", async () => {
    const located = { hit: true, primary: [{ path: "src/retry.ts", symbol: "retry", line: 1 }], related: [] } as unknown as LocateOutput;
    expect(await hasConfirmedQueryCandidateAnchor(located, ["retry"], async () => ["Retry", "retryDelay"])).toBe(false);
    expect(await hasConfirmedQueryCandidateAnchor(located, ["retry"], async () => ["retry"])).toBe(true);
    expect(await hasConfirmedQueryCandidateAnchor(located, [], async () => { throw new Error("no request-spelled identity"); })).toBe(false);
  });

  it("does not widen beyond the bounded unique locator files to find a convenient declaration", async () => {
    const files = Array.from({ length: QUERY_CANDIDATE_LIMIT + 1 }, (_, i) => ({ path: `src/file${i}.ts`, line: 1 }));
    const located = { hit: false, candidateDetails: [files[0], files[0], ...files.slice(1)], candidates: files } as unknown as LocateOutput;
    const read: string[] = [];
    expect(await hasConfirmedQueryCandidateAnchor(located, ["RequestedType"], async path => {
      read.push(path);
      return path === files.at(-1)!.path ? ["RequestedType"] : [];
    })).toBe(false);
    expect(read).toEqual(files.slice(0, QUERY_CANDIDATE_LIMIT).map(row => row.path));
  });
});
