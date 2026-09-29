/**
 * requestFacets.spec.ts — FIX-C1 (eval-0927 P0-2). Unit coverage for
 * requestFacets.ts: EN vocabulary, JA vocabulary, negatives (change
 * requests, documentation-existence, guarded compounds), and EN/JA parity
 * (V01's English query and V03's Japanese query must yield the same
 * (facet, subjectIdentifiers) set — brief-fix-c1.md Deliverable 1).
 *
 * The held-out precision/recall table lives in its own file
 * (requestFacets.heldout.spec.ts) so this file stays a fast, hand-authored
 * regression suite independent of that generated set.
 */
import { describe, expect, it } from "vitest";

import { extractFacetRequirements, type RequestFacet } from "../features/task-pack/requestFacets.js";

function facetsOf(query: string): RequestFacet[] {
  return extractFacetRequirements(query).map((r) => r.facet);
}

describe("extractFacetRequirements: EN positives", () => {
  const cases: ReadonlyArray<readonly [string, RequestFacet]> = [
    ["What is the default timeout for the HTTP client?", "value"],
    ["Which status codes trigger a retry in the fetch wrapper?", "value"],
    ["What are the allowed values for the status field?", "value"],
    ["What is the maximum number of retries configured?", "value"],
    ["What is the initial value of the isProcessing state?", "value"],
    ["What is the configured limit for concurrent connections?", "value"],
    ["What are the valid error types thrown by DatabaseConnection?", "value"],
    ["When does the cache invalidate an entry?", "condition"],
    ["Under what conditions does the rate limiter block a request?", "condition"],
    ["Show me the criteria for a user to be considered active.", "condition"],
    ["Under which conditions is the cache bypassed?", "condition"],
    ["Who calls the processPayment method?", "callers"],
    ["Where is the AuthMiddleware used?", "callers"],
    ["Which components depend on the useAuth hook?", "callers"],
    ["Which modules import src/utils/logger.ts?", "callers"],
    ["Who checks it before granting access?", "callers"],
    ["Walk me through the request path from the API handler to the database.", "flow"],
    ["Explain the lifecycle of a file upload from the client to S3.", "flow"],
    ["Trace the execution flow of a login request.", "flow"],
    ["Describe the sequence of events when a feature flag is toggled.", "flow"],
  ];
  for (const [query, facet] of cases) {
    it(`"${query}" -> ${facet}`, () => {
      expect(facetsOf(query)).toContain(facet);
    });
  }
});

describe("extractFacetRequirements: JA positives", () => {
  const cases: ReadonlyArray<readonly [string, RequestFacet]> = [
    ["HTTPクライアントのデフォルトのタイムアウト値は何ですか？", "value"],
    ["どのステータスコードで再試行が発生しますか？", "value"],
    ["Userモデルのstatusフィールドに設定可能な値は何ですか？", "value"],
    ["同時接続数の設定上限はいくつですか？", "value"],
    ["キャッシュが無効化される条件を教えてください。", "condition"],
    ["レートリミッターがリクエストをブロックする条件は何ですか？", "condition"],
    ["キューが失敗したジョブを再試行するのはどのような場合ですか？", "condition"],
    ["`processPayment`メソッドの呼び出し元はどこですか？", "callers"],
    ["`AuthMiddleware`はどの箇所で使用されていますか？", "callers"],
    ["`useAuth`フックに依存しているコンポーネントはどれですか？", "callers"],
    ["`src/utils/logger.ts`をインポートしているモジュールはどれですか？", "callers"],
    ["`API_KEY`環境変数はどこでアクセスされていますか？", "callers"],
    ["APIハンドラーからデータベースまでのリクエストの処理の流れを説明してください。", "flow"],
    ["クライアントからS3へのファイルアップロードのライフサイクルを説明してください。", "flow"],
    ["ログインリクエストの実行フローを追跡してください。", "flow"],
    ["フォーム送信からAPIへのデータフローを説明してください。", "flow"],
  ];
  for (const [query, facet] of cases) {
    it(`"${query}" -> ${facet}`, () => {
      expect(facetsOf(query)).toContain(facet);
    });
  }
});

describe("extractFacetRequirements: negatives", () => {
  const negatives: readonly string[] = [
    "What does the default export of index.ts contain?",
    "Rename the `callers` variable in utils.ts",
    "Explain the value object pattern used in Money",
    "Is there a document that shows the processing flow as a diagram?",
    "Refactor the conditionals in the processOrder function to reduce complexity.",
    "Add a default value to the timeout option in config.ts.",
    "What is the return value of parseProxy?",
    "Explain the default case of the switch in reducer.ts.",
    "Fix the retry conditions in shouldRetry so 500 is retried too.",
    "`index.ts` のデフォルトエクスポートの内容は？",
    "`utils.ts` の callers 変数の名前を変更してください。",
    "Money の値オブジェクトパターンを説明してください。",
    "処理の流れを図にしたドキュメントはありますか？",
    "条件分岐を減らすリファクタリング案を出してください。",
    "`shouldRetry` の再試行条件を修正してください。",
    "`parseProxy` の戻り値の型を教えてください。",
    "ステータスコード 404 のときのエラーメッセージを追加してください。",
  ];
  for (const query of negatives) {
    it(`"${query}" -> no requirement`, () => {
      expect(extractFacetRequirements(query)).toEqual([]);
    });
  }
});

describe("extractFacetRequirements: multi-facet composite clauses", () => {
  it("V01 EN: value + condition + callers, one clause each, with their own identifiers", () => {
    const reqs = extractFacetRequirements(
      "Explain the default HTTP_TIMEOUT_MS value, the shouldRetry conditions, and the callers of fetchWithRetry.",
    );
    expect(reqs.map((r) => r.facet)).toEqual(["value", "condition", "callers"]);
    expect(reqs[0]!.subjectIdentifiers).toEqual(["HTTP_TIMEOUT_MS"]);
    expect(reqs[0]!.inheritedFromLead).toBe(false);
    expect(reqs[1]!.subjectIdentifiers).toEqual(["shouldRetry"]);
    expect(reqs[2]!.subjectIdentifiers).toEqual(["fetchWithRetry"]);
  });

  it("held-out en-41: a colon-introduced list splits into value/callers/condition", () => {
    const reqs = extractFacetRequirements("Walk me through the upload code: limits, who calls it, and the retry rules.");
    expect(reqs.map((r) => r.facet)).toEqual(["value", "callers", "condition"]);
  });

  it("held-out en-47: bare ' and ' splits two facet-bearing clauses with no comma", () => {
    const reqs = extractFacetRequirements("What is the default timeout and when does it retry?");
    expect(reqs.map((r) => r.facet)).toEqual(["value", "condition"]);
  });

  it('"when is X called" is callers, not condition', () => {
    expect(facetsOf("When is the onError callback invoked?")).toEqual(["callers"]);
  });
});

describe("extractFacetRequirements: facet-only clause inherits the lead clause's subject", () => {
  it("既定値 alone carries no identifier of its own and inherits the lead's", () => {
    const reqs = extractFacetRequirements(
      "HTTPリクエストのタイムアウトと再試行の仕組みを説明してください。既定値、リクエストの処理経路、再試行するHTTPステータスコードを確認してください。",
    );
    expect(reqs.length).toBeGreaterThanOrEqual(2);
    for (const r of reqs) {
      expect(r.inheritedFromLead).toBe(true);
      expect(r.subjectIdentifiers).toEqual([]);
    }
    // The lead's own concept terms (timeout/retry/request) survive the
    // inheritance union even though the clause itself also names its own.
    const flowReq = reqs.find((r) => r.facet === "flow");
    expect(flowReq).toBeDefined();
    expect(flowReq!.subjectTerms).toEqual(expect.arrayContaining(["timeout", "retry"]));
  });

  it('"the callers" (no named identifier) inherits an explicit lead identifier', () => {
    const reqs = extractFacetRequirements("Explain fetchWithRetry end to end. Who are the callers?");
    const callersReq = reqs.find((r) => r.facet === "callers");
    expect(callersReq).toBeDefined();
    expect(callersReq!.inheritedFromLead).toBe(true);
    expect(callersReq!.subjectIdentifiers).toEqual(["fetchWithRetry"]);
  });
});

describe("EN/JA parity (brief-fix-c1.md Deliverable 1)", () => {
  it("V01 (EN) and V03 (JA) yield the same (facet, subjectIdentifiers) set", () => {
    const en = extractFacetRequirements(
      "Explain the default HTTP_TIMEOUT_MS value, the shouldRetry conditions, and the callers of fetchWithRetry.",
    );
    const ja = extractFacetRequirements(
      "HTTP_TIMEOUT_MS の既定値、shouldRetry の再試行条件、fetchWithRetry の呼び出し元を説明してください。",
    );
    const shape = (reqs: typeof en) => reqs.map((r) => `${r.facet}:${r.subjectIdentifiers.join(",")}`).sort();
    expect(shape(ja)).toEqual(shape(en));
  });
});

describe("negative-guard compounds never fire the word they contain", () => {
  const guarded: ReadonlyArray<readonly [string, RequestFacet]> = [
    ["What does the default export of index.ts contain?", "value"],
    ["Explain the default branch of this switch statement.", "value"],
    ["Explain the default case of the switch in reducer.ts.", "value"],
    ["What does the default constructor initialize?", "value"],
    ["Explain the value object pattern used in Money.", "value"],
    ["What is the return value of parseProxy?", "value"],
  ];
  for (const [query, facet] of guarded) {
    it(`"${query}" never fires ${facet}`, () => {
      expect(facetsOf(query)).not.toContain(facet);
    });
  }
  it("a guarded compound does not suppress an UNRELATED positive trigger elsewhere in the same clause", () => {
    // "default export" is guarded, but "conditions" in the SAME clause must
    // still fire -- the guard blanks only the matched span, never the clause.
    expect(facetsOf("Explain the default export and the retry conditions.")).toEqual(
      expect.arrayContaining(["condition"]),
    );
  });
});

describe("change-request gate is per-clause, not per-query", () => {
  it("a change clause does not suppress a genuinely separate question in the same query", () => {
    const reqs = extractFacetRequirements("Fix the timeout bug. What is the default retry limit?");
    expect(reqs.map((r) => r.facet)).toContain("value");
  });
});
