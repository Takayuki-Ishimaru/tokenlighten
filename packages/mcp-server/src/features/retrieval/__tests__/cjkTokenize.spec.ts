// cjkTokenize.spec.ts — field-report fix (2026-08-27): every extraction
// pattern in retrieval/tokenize.ts was ASCII-only, so a Japanese-heavy query
// (or Japanese source content: doc comments, string literals, markdown
// prose) collapsed to just its incidental embedded ASCII identifiers,
// starving BM25F. See tokenize.ts's own CJK span extraction block comment
// for the design. This suite covers: (1) tokenizer unit cases directly on
// tokenizeText/tokenizeQuery/normalizeQuery, and (2) an end-to-end ranking
// case proving query-side and content-side tokenization stay symmetric by
// construction (both route through the SAME tokenizeText units.ts already
// uses for doc/body/markdown/config fields — no change to units.ts or
// bm25f.ts was needed).

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { tokenizeText, tokenizeQuery, normalizeQuery, MAX_CJK_TOKENS } from "../tokenize.js";
import { Bm25fIndex } from "../bm25f.js";
import { buildSymbolUnits } from "../units.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

function mkWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-cjk-tokenize-"));
  tmpDirs.push(dir);
  return dir;
}

function writeFile(workspace: string, rel: string, content: string): void {
  const abs = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

describe("tokenizeText — CJK (Han/Hiragana/Katakana) span extraction", () => {
  it("extracts a Han run as its own whole-run token", () => {
    const tokens = tokenizeText("健全性状態を確認する");
    expect(tokens).toContain("健全性状態");
  });

  it("emits per-character Han unigrams (length floor 1 — a single kanji is meaningful)", () => {
    const tokens = tokenizeText("健全性状態");
    for (const ch of "健全性状態") expect(tokens).toContain(ch);
  });

  it("emits overlapping Han bigrams", () => {
    const tokens = tokenizeText("健全性状態");
    expect(tokens).toEqual(expect.arrayContaining(["健全", "全性", "性状", "状態"]));
  });

  it("extracts a katakana run as its own whole-run token plus bigrams", () => {
    const tokens = tokenizeText("テレメトリの状態");
    expect(tokens).toContain("テレメトリ");
    expect(tokens).toEqual(expect.arrayContaining(["テレ", "レメ", "メト", "トリ"]));
  });

  it("does NOT emit katakana unigrams (a lone kana character is a particle, not a content word)", () => {
    const tokens = tokenizeText("テレメトリ");
    expect(tokens).not.toContain("テ");
    expect(tokens).not.toContain("レ");
  });

  it("a script transition always ends a run — katakana then hiragana never fuse into one run", () => {
    const tokens = tokenizeText("テレメトリの");
    expect(tokens).toContain("テレメトリ");
    expect(tokens).toContain("の");
    expect(tokens).not.toContain("テレメトリの");
  });

  it("filters a Japanese stopword when it is the WHOLE kana run", () => {
    const tokens = tokenizeText("確認する");
    expect(tokens).not.toContain("する");
  });

  it("filters a Japanese stopword appearing as a bigram inside a longer run", () => {
    const tokens = tokenizeText("することができる");
    expect(tokens).not.toContain("する");
    expect(tokens).not.toContain("こと");
  });

  it("keeps stopwords when keepStopWords is set, mirroring the existing ASCII opt", () => {
    const tokens = tokenizeText("確認する", { keepStopWords: true });
    expect(tokens).toContain("する");
  });

  it("a stopword-only kana run degenerates to zero tokens from that run", () => {
    expect(tokenizeText("これ")).toEqual([]);
  });

  it("a mixed Japanese/English sentence keeps its decomposed ASCII identifier AND its CJK tokens — no longer an all-or-nothing choice", () => {
    const tokens = tokenizeText("getTelemetryHealthState はテレメトリの健全性状態を取得する");
    expect(tokens).toEqual(expect.arrayContaining(["telemetry", "health", "state"]));
    expect(tokens).toContain("テレメトリ");
    expect(tokens).toContain("健全性状態");
  });

  it("ASCII-only input is byte-identical to the pre-CJK tokenizer (extractCjkTokens contributes zero tokens)", () => {
    const tokens = tokenizeText("investigate contentSufficiency regression");
    expect(tokens).toEqual(["investigate", "content", "sufficiency", "regression"]);
  });

  it("bounds CJK-derived tokens per call at MAX_CJK_TOKENS, even for one huge single-character-repeated Han run", () => {
    const huge = "文".repeat(2000);
    const tokens = tokenizeText(huge);
    expect(tokens.length).toBeLessThanOrEqual(MAX_CJK_TOKENS);
    expect(tokens.length).toBeGreaterThan(0);
  });
});

describe("tokenizeQuery / normalizeQuery — CJK-aware query tokenization", () => {
  it("a pure Japanese prose query, previously tokenized to nothing at all, now yields a non-empty token set", () => {
    const tokens = tokenizeQuery("テレメトリの健全性状態を取得している処理はどこですか");
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens).toContain("テレメトリ");
    expect(tokens).toContain("健全性状態");
  });

  it("dedupes a repeated CJK token", () => {
    const tokens = tokenizeQuery("状態 状態 状態");
    expect(tokens.filter((t) => t === "状態")).toHaveLength(1);
  });

  it("normalizeQuery.allTokens/identifierTokens carry CJK tokens ALONGSIDE a single embedded ASCII identifier — the query no longer collapses to identifier-only signal", () => {
    const norm = normalizeQuery("reserveStockLevel の在庫更新でテレメトリの健全性状態を確認したい");
    // the embedded ASCII identifier's decomposed parts are still present...
    expect(norm.allTokens).toEqual(expect.arrayContaining(["reserve", "stock", "level"]));
    // ...but CJK content tokens now ride alongside it in the very same
    // bucket a BM25F ranker reads — this is the collapse this fix closes.
    expect(norm.allTokens).toEqual(expect.arrayContaining(["テレメトリ", "健全性状態"]));
    expect(norm.identifierTokens).toEqual(expect.arrayContaining(["テレメトリ", "健全性状態"]));
  });

  it("a Japanese query with no path/error-code shape still yields empty pathTokens/errorCodeTokens — CJK tokens flow only into identifierTokens/allTokens", () => {
    const norm = normalizeQuery("テレメトリの健全性状態を確認したい");
    expect(norm.pathTokens).toEqual([]);
    expect(norm.errorCodeTokens).toEqual([]);
    expect(norm.identifierTokens.length).toBeGreaterThan(0);
  });
});

describe("Bm25fIndex ranking — a Japanese prose query ranks the topically-relevant file first (end-to-end symmetry)", () => {
  it("ranks the file whose Japanese doc-comment/string actually discusses the query's topic above an unrelated decoy — content built via units.ts's own buildSymbolUnits (real tokenizeText call), query via tokenizeQuery (the same shared tokenizer)", async () => {
    const ws = mkWorkspace();
    writeFile(
      ws,
      "src/telemetryHealth.ts",
      [
        "/**",
        " * テレメトリの健全性状態を取得して監視ダッシュボードへ送信する。異常検知のための重要な指標。",
        " */",
        "export function getTelemetryHealthState(): string {",
        "  return \"健全性状態は正常です\";",
        "}",
        "",
      ].join("\n"),
    );
    writeFile(
      ws,
      "src/paymentRetry.ts",
      [
        "/**",
        " * 支払い処理のリトライ間隔を設定してキューに登録する。決済失敗時の再送制御。",
        " */",
        "export function schedulePaymentRetry(): string {",
        "  return \"再試行の設定を更新しました\";",
        "}",
        "",
      ].join("\n"),
    );

    const { units } = await buildSymbolUnits(ws, ["src/telemetryHealth.ts", "src/paymentRetry.ts"]);
    expect(units.length).toBeGreaterThan(0);
    const index = new Bm25fIndex(units);

    const query = "テレメトリの健全性状態を取得している処理はどこですか";
    const queryTokens = tokenizeQuery(query);
    // Pre-fix this was []: an all-Japanese query with zero ASCII content
    // tokenized to nothing, so Bm25fIndex.score short-circuited to []
    // regardless of file content (bm25f.ts: queryTokens.length === 0).
    expect(queryTokens.length).toBeGreaterThan(0);

    const hits = index.score(queryTokens);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.unit.path).toBe("src/telemetryHealth.ts");

    const byPath = new Map(hits.map((h) => [h.unit.path, h.score]));
    expect(byPath.get("src/telemetryHealth.ts")!).toBeGreaterThan(byPath.get("src/paymentRetry.ts") ?? 0);
  });
});
