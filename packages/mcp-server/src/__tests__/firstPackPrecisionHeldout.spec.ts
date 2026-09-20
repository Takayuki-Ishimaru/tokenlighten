/**
 * HELD-OUT first-pack precision check for the two (S) supported first-pack
 * flags (TL_JA_QUERY_BRIDGE, TL_CONCERN_RECOVERY), DEFAULT ON by USER ruling
 * 2026-09-19 (shipped v0.14.3); explicit "0" on either remains the rollback
 * path.
 *
 * firstPackPrecisionEval.spec.ts is the DEVELOPMENT set: the agents that built
 * the Japanese bridge and the concern recovery ran it while they worked, so a
 * gain measured there can be vocabulary the implementer happened to cover.
 * The queries below were written by the reviewer AFTER the glossary and the
 * phonetic rules were frozen, were never shown to the implementers, and use
 * topics the development set does not touch (authentication, session tokens,
 * password reset, invoices, shipping cost, error-code catalogue, feature
 * flags, reorder policy, warehouse sync, reports, SMS, event tracking).
 *
 * Corpus: the synthetic workspace WITHOUT Japanese comments, so every
 * Japanese query is a pure cross-lingual case (no JA<->JA comment overlap).
 *
 * Assertions are deliberately one-sided: a flag may fail to help, but shipping
 * it DEFAULT ON must never make any held-out query worse than explicitly
 * rolling it back to "0". The measured table is printed and, when
 * TL_EVAL_OUT_DIR is set, written there.
 */
import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildTaskPack,
  resetPackDedupeCache,
  resetRoleInventoryCache,
} from "../features/task-pack/readCodeTaskPack.js";
import { resetAll as resetAllSessions, resetWorkspace } from "../util/session.js";
import { applyCanonicalTaskDecision } from "../features/task-pack/canonicalDecision.js";
import {
  writeSyntheticCorpus,
  evaluateResult,
  errorMetrics,
  type EvalQuery,
  type QueryMetrics,
} from "./helpers/firstPackPrecisionCorpus.js";

const HELD_OUT: EvalQuery[] = [
  {
    id: "HJ1",
    corpus: "synthetic_no_ja_comments",
    cls: "ja_single_xling",
    query: "ログイン時のユーザー認証はどこで行われますか?",
    concerns: [{
      label: "user authentication",
      files: ["src/auth/loginService.ts", "src/auth/authMiddleware.ts"],
      mustContain: ["authenticateUser", "requireAuth"],
    }],
  },
  {
    id: "HJ2",
    corpus: "synthetic_no_ja_comments",
    cls: "ja_single_xling",
    query: "セッショントークンの発行と有効期限の判定はどのファイルですか?",
    concerns: [{
      label: "session token issuance / expiry",
      files: ["src/auth/sessionToken.ts"],
      mustContain: ["issueSessionToken", "isSessionExpired"],
    }],
  },
  {
    id: "HJ3",
    corpus: "synthetic_no_ja_comments",
    cls: "ja_single_xling",
    query: "パスワードのリセット処理はどこに実装されていますか?",
    concerns: [{
      label: "password reset",
      files: ["src/auth/passwordReset.ts"],
      mustContain: ["requestPasswordReset", "resetPasswordWithToken"],
    }],
  },
  {
    id: "HJ4",
    corpus: "synthetic_no_ja_comments",
    cls: "ja_single_xling",
    query: "送料の計算はどこで行われていますか?",
    concerns: [{
      label: "shipping cost",
      files: ["src/order/shippingCalculator.ts"],
      mustContain: ["calculateShippingCost"],
    }],
  },
  {
    id: "HJ5",
    corpus: "synthetic_no_ja_comments",
    cls: "ja_single_xling",
    query: "請求書の作成はどのファイルにありますか?",
    concerns: [{
      label: "invoice building",
      files: ["src/payment/invoiceBuilder.ts"],
      mustContain: ["buildInvoice"],
    }],
  },
  {
    id: "HJ6",
    corpus: "synthetic_no_ja_comments",
    cls: "ja_single_xling",
    query: "エラーコードの一覧はどこに定義されていますか?",
    concerns: [{
      label: "error code catalogue",
      files: ["src/common/errorCodes.ts"],
      mustContain: ["ERROR_CODES"],
    }],
  },
  {
    id: "HJ7",
    corpus: "synthetic_no_ja_comments",
    cls: "ja_single_xling",
    query: "機能フラグの有効判定はどこですか?",
    concerns: [{
      label: "feature flags",
      files: ["src/common/featureFlags.ts"],
      mustContain: ["isFeatureEnabled"],
    }],
  },
  {
    id: "HJ8",
    corpus: "synthetic_no_ja_comments",
    cls: "ja_single_xling",
    query: "在庫の補充発注の判定はどこに実装されていますか?",
    concerns: [{
      label: "reorder policy",
      files: ["src/inventory/reorder_policy.py"],
      mustContain: ["should_reorder"],
    }],
  },
  {
    id: "HJ9",
    corpus: "synthetic_no_ja_comments",
    cls: "ja_multi_xling",
    query: "倉庫との同期処理と、日次レポートの作成はそれぞれどこにありますか?",
    concerns: [
      { label: "warehouse sync", files: ["src/inventory/warehouse_sync.py"], mustContain: ["sync_warehouse_levels"] },
      { label: "daily report", files: ["src/analytics/reportBuilder.ts"], mustContain: ["buildDailyReport"] },
    ],
  },
  {
    id: "HJ10",
    corpus: "synthetic_no_ja_comments",
    cls: "ja_multi_xling",
    query: "SMS通知の送信と、イベントの追跡はどのファイルで行われますか?",
    concerns: [
      { label: "sms sending", files: ["src/notification/smsNotifier.ts"], mustContain: ["sendSms"] },
      { label: "event tracking", files: ["src/analytics/eventTracker.ts"], mustContain: ["trackEvent"] },
    ],
  },
  {
    id: "HJ11",
    corpus: "synthetic_no_ja_comments",
    cls: "ja_single_xling",
    query: "カードの決済処理はどこですか?",
    concerns: [{
      label: "card charge",
      files: ["src/payment/paymentGateway.ts"],
      mustContain: ["chargeCard"],
    }],
  },
  {
    id: "HJ12",
    corpus: "synthetic_no_ja_comments",
    cls: "ja_single_xling",
    query: "ユーザープロフィールの更新はどこで行われますか?",
    concerns: [{
      label: "profile update",
      files: ["src/user/user_profile.py"],
      mustContain: ["update_profile"],
    }],
  },
  {
    id: "HE1",
    corpus: "synthetic_no_ja_comments",
    cls: "en_multi",
    query: "How are password resets requested, and where is the daily report built?",
    concerns: [
      { label: "password reset", files: ["src/auth/passwordReset.ts"], mustContain: ["requestPasswordReset"] },
      { label: "daily report", files: ["src/analytics/reportBuilder.ts"], mustContain: ["buildDailyReport"] },
    ],
  },
  {
    id: "HE2",
    corpus: "synthetic_no_ja_comments",
    cls: "en_multi",
    query: "Where is the shipping cost calculated and how are invoices built?",
    concerns: [
      { label: "shipping cost", files: ["src/order/shippingCalculator.ts"], mustContain: ["calculateShippingCost"] },
      { label: "invoice building", files: ["src/payment/invoiceBuilder.ts"], mustContain: ["buildInvoice"] },
    ],
  },
  {
    id: "HE3",
    corpus: "synthetic_no_ja_comments",
    cls: "en_multi",
    query: "How does warehouse synchronization work, and where are feature flags evaluated?",
    concerns: [
      { label: "warehouse sync", files: ["src/inventory/warehouse_sync.py"], mustContain: ["sync_warehouse_levels"] },
      { label: "feature flags", files: ["src/common/featureFlags.ts"], mustContain: ["isFeatureEnabled"] },
    ],
  },
  {
    id: "HE4",
    corpus: "synthetic_no_ja_comments",
    cls: "en_multi",
    query: "Where is a card charged, and how is user authentication performed?",
    concerns: [
      { label: "card charge", files: ["src/payment/paymentGateway.ts"], mustContain: ["chargeCard"] },
      {
        label: "user authentication",
        files: ["src/auth/loginService.ts", "src/auth/authMiddleware.ts"],
        mustContain: ["authenticateUser", "requireAuth"],
      },
    ],
  },
];

interface Variant {
  name: string;
  env: Record<string, string>;
}

// baseline_defaults leaves both env vars unset (see runQuery's delete loop
// below), which is now the BOTH-ON measurement (default true). The other
// three variants flip one or both explicitly to "0", the rollback path.
const VARIANTS: Variant[] = [
  { name: "baseline_defaults", env: {} },
  { name: "ja_bridge_off", env: { TL_JA_QUERY_BRIDGE: "0" } },
  { name: "concern_recovery_off", env: { TL_CONCERN_RECOVERY: "0" } },
  { name: "fp_off", env: { TL_CONCERN_RECOVERY: "0", TL_JA_QUERY_BRIDGE: "0" } },
];

const tmpDirs: string[] = [];

async function runQuery(q: EvalQuery, variant: Variant): Promise<QueryMetrics> {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tl-heldout-"));
  tmpDirs.push(ws);
  writeSyntheticCorpus(ws, { japaneseComments: false });

  resetAllSessions();
  resetWorkspace(ws);
  resetPackDedupeCache();
  resetRoleInventoryCache();

  const saved: Record<string, string | undefined> = {};
  for (const key of ["TL_JA_QUERY_BRIDGE", "TL_CONCERN_RECOVERY"]) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(variant.env)) process.env[key] = value;
  const startedAt = performance.now();
  try {
    const result = await buildTaskPack({ query: q.query, taskProfile: "answer", paths: [] }, ws);
    const wallClockMs = performance.now() - startedAt;
    let decisionKind = "unknown";
    let decisionReason: string | undefined;
    try {
      const decision = applyCanonicalTaskDecision(result);
      decisionKind = decision?.kind ?? "undefined";
      decisionReason = decision?.reason;
    } catch (err) {
      decisionKind = `decision-error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 120);
    }
    return evaluateResult(q, variant.name, result, decisionKind, decisionReason, wallClockMs);
  } catch (err) {
    return errorMetrics(q, variant.name, err, performance.now() - startedAt);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("first-pack precision -- held-out queries (never shown to the implementers)", () => {
  it(
    "no held-out query gets worse under any first-pack flag, and the measured table is reported",
    async () => {
      const rows: QueryMetrics[] = [];
      for (const variant of VARIANTS) {
        for (const q of HELD_OUT) rows.push(await runQuery(q, variant));
      }
      expect(rows.filter((row) => row.error !== undefined).map((row) => `${row.queryId}/${row.variant}: ${row.error}`)).toEqual([]);

      const byKey = new Map(rows.map((row) => [`${row.queryId}\0${row.variant}`, row]));
      const lines: string[] = ["| query | class | " + VARIANTS.map((v) => v.name).join(" | ") + " |", "|---|---|" + VARIANTS.map(() => "---").join("|") + "|"];
      const regressions: string[] = [];
      for (const q of HELD_OUT) {
        // "base" is baseline_defaults (both FP flags on, the shipped default).
        // Each other variant is an explicit-"0" rollback; the regression floor
        // is now inverted from the pre-2026-09-19 shape: DEFAULT must not score
        // BELOW any rollback variant on any held-out query.
        const base = byKey.get(`${q.id}\0baseline_defaults`)!;
        const cells = VARIANTS.map((variant) => {
          const row = byKey.get(`${q.id}\0${variant.name}`)!;
          if (variant.name !== "baseline_defaults") {
            if (base.concernsHitStrict < row.concernsHitStrict) {
              regressions.push(`${q.id}/baseline_defaults: strict ${row.concernsHitStrict} -> ${base.concernsHitStrict} (below ${variant.name})`);
            }
            // Fewer files is a collapse only while a concern is still unserved;
            // every concern hit with fewer files is a precision gain.
            if (base.filesWithBody < row.filesWithBody && base.concernsHitStrict < base.concernsTotal) {
              regressions.push(`${q.id}/baseline_defaults: filesWithBody ${row.filesWithBody} -> ${base.filesWithBody} (below ${variant.name})`);
            }
          }
          return `${row.concernsHitStrict}/${row.concernsTotal} (${row.filesWithBody}f, ${Math.round(row.wallClockMs)}ms, ${row.decisionKind})`;
        });
        lines.push(`| ${q.id} | ${q.cls} | ${cells.join(" | ")} |`);
      }
      const totals = VARIANTS.map((variant) => {
        const mine = rows.filter((row) => row.variant === variant.name);
        const hit = mine.reduce((sum, row) => sum + row.concernsHitStrict, 0);
        const total = mine.reduce((sum, row) => sum + row.concernsTotal, 0);
        return `${hit}/${total} (${((100 * hit) / total).toFixed(1)}%)`;
      });
      lines.push(`| **all** | | ${totals.join(" | ")} |`);
      const table = lines.join("\n");
      console.log(`\nHELD-OUT first-pack precision (strict concern hits)\n${table}\n`);
      const outDir = process.env["TL_EVAL_OUT_DIR"];
      if (outDir) {
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, "heldout.md"), table + "\n");
        fs.writeFileSync(path.join(outDir, "heldout.json"), JSON.stringify(rows, null, 2));
      }
      expect(regressions).toEqual([]);
    },
    300000,
  );
});
