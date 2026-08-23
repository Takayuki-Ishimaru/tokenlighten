// V11-02 Task-aware Weighted RRF v2 — end-to-end applyHybridRetrieval specs:
// flag-off byte identity, hard floors under adversarial weights (including
// every shipped named profile), the weak-retriever quality gate, and trace
// attribution (weightsVersion / profile / retriever_weights).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { applyHybridRetrieval } from "../index.js";
import { setTraceEnabledForTest, getTracePath } from "../../../util/trace.js";
import { TASK_PROFILES, NEUTRAL_WEIGHTS } from "../profiles.js";
import type { Candidate } from "../../locator/locateTaskContext.js";
import type { FoundFile, WalkOptions } from "../../../tools/walkRepo.js";

const tmpDirs: string[] = [];

function mkWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-profile-fusion-"));
  tmpDirs.push(dir);
  return dir;
}

function writeFile(workspace: string, rel: string, content: string): void {
  const abs = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

const emptyWalkCache = { get: (_opts: WalkOptions): FoundFile[] => [] };

let savedRrf: string | undefined;
let savedProfiles: string | undefined;
let savedBm25f: string | undefined;
let savedHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
  savedRrf = process.env["TL_RRF_FUSION"];
  savedProfiles = process.env["TL_RRF_PROFILES"];
  savedBm25f = process.env["TL_BM25F_CANDIDATE"];
  savedHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tl-profile-fusion-home-"));
  process.env.HOME = tmpHome;
  setTraceEnabledForTest(false);
});

afterEach(() => {
  if (savedRrf === undefined) delete process.env["TL_RRF_FUSION"];
  else process.env["TL_RRF_FUSION"] = savedRrf;
  if (savedProfiles === undefined) delete process.env["TL_RRF_PROFILES"];
  else process.env["TL_RRF_PROFILES"] = savedProfiles;
  if (savedBm25f === undefined) delete process.env["TL_BM25F_CANDIDATE"];
  else process.env["TL_BM25F_CANDIDATE"] = savedBm25f;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  setTraceEnabledForTest(false);
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

function buildWorkspace(): string {
  const ws = mkWorkspace();
  writeFile(ws, "src/util.ts", "export function realSymbol(): number {\n  return 1;\n}\n");
  return ws;
}

function floorAndNonFloorCandidates(): Candidate[] {
  return [
    { path: "src/exact.ts", line: 1, kind: "text", why: "exact-text", score: 1.2 },
    { path: "src/util.ts", line: 1, endLine: 3, symbol: "realSymbol", kind: "symbol", why: "exact-symbol", score: 2.0 },
    { path: "src/ref.ts", line: 1, kind: "reference", why: "reference", score: 0.6 },
    { path: "src/nonfloor.ts", line: 1, kind: "structural", why: "structural-guess", score: 5.0 },
  ];
}

describe("applyHybridRetrieval — V11-02 flag-off byte identity", () => {
  it("with TL_RRF_PROFILES unset, profileContext/retrieverWeights inputs are inert — output matches the same call without them", async () => {
    delete process.env["TL_RRF_PROFILES"];
    process.env["TL_RRF_FUSION"] = "1";
    delete process.env["TL_BM25F_CANDIDATE"];
    const ws = buildWorkspace();

    const withoutProfileFields = floorAndNonFloorCandidates();
    await applyHybridRetrieval(
      { workspace: ws, query: "realSymbol", codeFiles: [], walkCache: emptyWalkCache },
      withoutProfileFields,
    );

    const withProfileFields = floorAndNonFloorCandidates();
    await applyHybridRetrieval(
      {
        workspace: ws,
        query: "realSymbol",
        codeFiles: [],
        walkCache: emptyWalkCache,
        profileContext: { explicitPath: "src/util.ts" },
        retrieverWeights: { exact: 99, symbol: 0, reference: 0, bm25f: 0 },
      },
      withProfileFields,
    );

    expect(withProfileFields.map((c) => c.path)).toEqual(withoutProfileFields.map((c) => c.path));
  });
});

describe("applyHybridRetrieval — V11-02 hard floors hold under adversarial weights", () => {
  it("an all-zero retrieverWeights vector (every named retriever muted) still keeps every floor candidate ahead of every non-floor candidate", async () => {
    process.env["TL_RRF_FUSION"] = "1";
    process.env["TL_RRF_PROFILES"] = "1";
    delete process.env["TL_BM25F_CANDIDATE"];
    const ws = buildWorkspace();
    const candidates = floorAndNonFloorCandidates();

    await applyHybridRetrieval(
      {
        workspace: ws,
        query: "realSymbol",
        codeFiles: [],
        walkCache: emptyWalkCache,
        retrieverWeights: { exact: 0, symbol: 0, reference: 0, bm25f: 0 },
      },
      candidates,
    );

    const order = candidates.map((c) => c.path);
    const lastFloorIndex = Math.max(
      order.indexOf("src/exact.ts"),
      order.indexOf("src/util.ts"),
      order.indexOf("src/ref.ts"),
    );
    const nonFloorIndex = order.indexOf("src/nonfloor.ts");
    expect(lastFloorIndex, JSON.stringify(order)).toBeLessThan(nonFloorIndex);
  });

  it("holds under every shipped named profile's weight vector, not just an adversarial one", async () => {
    process.env["TL_RRF_FUSION"] = "1";
    process.env["TL_RRF_PROFILES"] = "1";
    delete process.env["TL_BM25F_CANDIDATE"];

    for (const profile of Object.values(TASK_PROFILES)) {
      const ws = buildWorkspace();
      const candidates = floorAndNonFloorCandidates();
      await applyHybridRetrieval(
        {
          workspace: ws,
          query: "realSymbol",
          codeFiles: [],
          walkCache: emptyWalkCache,
          retrieverWeights: profile.weights,
        },
        candidates,
      );
      const order = candidates.map((c) => c.path);
      const lastFloorIndex = Math.max(
        order.indexOf("src/exact.ts"),
        order.indexOf("src/util.ts"),
        order.indexOf("src/ref.ts"),
      );
      const nonFloorIndex = order.indexOf("src/nonfloor.ts");
      expect(lastFloorIndex, `${profile.id}: ${JSON.stringify(order)}`).toBeLessThan(nonFloorIndex);
    }
  });
});

describe("applyHybridRetrieval — V11-02 weak-retriever quality gate", () => {
  it("a flat (all-tied) heuristic score distribution is gated out of fusion and recorded with a reason, via the trace", async () => {
    process.env["TL_RRF_FUSION"] = "1";
    process.env["TL_RRF_PROFILES"] = "1";
    delete process.env["TL_BM25F_CANDIDATE"];
    setTraceEnabledForTest(true);
    const ws = buildWorkspace();
    const candidates: Candidate[] = [
      { path: "src/a.ts", line: 1, kind: "structural", why: "guess", score: 0.5 },
      { path: "src/b.ts", line: 1, kind: "structural", why: "guess", score: 0.5 },
      { path: "src/c.ts", line: 1, kind: "structural", why: "guess", score: 0.5 },
    ];

    await applyHybridRetrieval(
      { workspace: ws, query: "nothing in particular", codeFiles: [], walkCache: emptyWalkCache },
      candidates,
    );

    const lines = fs.readFileSync(getTracePath(ws), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const record = lines.filter((r) => r.event === "hybrid_retrieval_applied").at(-1);
    expect(record, JSON.stringify(lines)).toBeDefined();
    expect(record.gated_retrievers).toEqual(
      expect.arrayContaining([expect.objectContaining({ retriever: "heuristic", passed: false, reason: "degenerate-scores" })]),
    );
  });
});

describe("applyHybridRetrieval — V11-02 trace attribution", () => {
  it("weightsVersion, profile, and retriever_weights are present in the trace when profiles are active", async () => {
    process.env["TL_RRF_FUSION"] = "1";
    process.env["TL_RRF_PROFILES"] = "1";
    delete process.env["TL_BM25F_CANDIDATE"];
    setTraceEnabledForTest(true);
    const ws = buildWorkspace();
    const candidates = floorAndNonFloorCandidates();

    await applyHybridRetrieval(
      {
        workspace: ws,
        query: "src/util.ts",
        codeFiles: [],
        walkCache: emptyWalkCache,
        profileContext: { explicitPath: "src/util.ts" },
      },
      candidates,
    );

    const lines = fs.readFileSync(getTracePath(ws), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const record = lines.filter((r) => r.event === "hybrid_retrieval_applied").at(-1);
    expect(record.weights_version).toBeTruthy();
    expect(record.profile).toBe("known-local");
    expect(record.retriever_weights_source).toBe("inferred");
    expect(record.retriever_weights).toBeDefined();
  });

  it("a query with no structural signal resolves to the general profile (neutral weights) in the trace", async () => {
    process.env["TL_RRF_FUSION"] = "1";
    process.env["TL_RRF_PROFILES"] = "1";
    delete process.env["TL_BM25F_CANDIDATE"];
    setTraceEnabledForTest(true);
    const ws = buildWorkspace();
    const candidates = floorAndNonFloorCandidates();

    await applyHybridRetrieval(
      { workspace: ws, query: "reserve stock for a new order", codeFiles: [], walkCache: emptyWalkCache },
      candidates,
    );

    const lines = fs.readFileSync(getTracePath(ws), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const record = lines.filter((r) => r.event === "hybrid_retrieval_applied").at(-1);
    expect(record.profile).toBe("general");
    expect(record.retriever_weights).toEqual(NEUTRAL_WEIGHTS);
  });

  it("a tuner-style retrieverWeights override is labeled 'override', not 'inferred', and reports no profile field", async () => {
    process.env["TL_RRF_FUSION"] = "1";
    process.env["TL_RRF_PROFILES"] = "1";
    delete process.env["TL_BM25F_CANDIDATE"];
    setTraceEnabledForTest(true);
    const ws = buildWorkspace();
    const candidates = floorAndNonFloorCandidates();

    await applyHybridRetrieval(
      { workspace: ws, query: "realSymbol", codeFiles: [], walkCache: emptyWalkCache, retrieverWeights: { exact: 2 } },
      candidates,
    );

    const lines = fs.readFileSync(getTracePath(ws), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const record = lines.filter((r) => r.event === "hybrid_retrieval_applied").at(-1);
    expect(record.retriever_weights_source).toBe("override");
    expect(record.profile).toBeUndefined();
    expect(record.retriever_weights.exact).toBe(2);
  });
});

describe("applyHybridRetrieval — V11-02 no-gold false-positive discipline", () => {
  // V11-02 acceptance: "no-gold false positive増加なし" — a query with
  // nothing relevant in the workspace must not GAIN candidates just because
  // profiles are active. Profiles only ever reweight/reorder the existing
  // pool (see profiles.ts's own doc comment); they never add a candidate on
  // their own — bm25fOn's own candidate additions are gated by bm25fOn, not
  // by profilesOn. This proves that structural claim holds for every
  // shipped profile, using a genuinely irrelevant no-gold-shaped query
  // (mirrors the holdout corpus's own no-gold queries, e.g.
  // "rotate the database encryption keys" against a fixture with none of
  // those words anywhere).
  it("candidate pool size for a no-gold query is identical with profiles off vs. on, for every shipped profile", async () => {
    process.env["TL_BM25F_CANDIDATE"] = "1";
    process.env["TL_RRF_FUSION"] = "1";
    const noGoldQuery = "rotate the database encryption keys immediately";

    delete process.env["TL_RRF_PROFILES"];
    const wsOff = buildWorkspace();
    const poolOff = floorAndNonFloorCandidates();
    await applyHybridRetrieval(
      { workspace: wsOff, query: noGoldQuery, codeFiles: [], walkCache: emptyWalkCache },
      poolOff,
    );

    process.env["TL_RRF_PROFILES"] = "1";
    for (const profile of Object.values(TASK_PROFILES)) {
      const wsOn = buildWorkspace();
      const poolOn = floorAndNonFloorCandidates();
      await applyHybridRetrieval(
        { workspace: wsOn, query: noGoldQuery, codeFiles: [], walkCache: emptyWalkCache, retrieverWeights: profile.weights },
        poolOn,
      );
      expect(poolOn.length, `${profile.id}: pool grew from ${poolOff.length} to ${poolOn.length}`).toBe(poolOff.length);
    }
  });
});
