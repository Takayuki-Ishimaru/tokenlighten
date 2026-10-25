/**
 * entryHeldout2.ts — structure-map ENTRY held-out set #2 (2026-10-24): the BLIND
 * check of the entry-vocabulary change (see requestFacets.heldout9.spec.ts and
 * structureMapEntry.heldout2.spec.ts for the result).
 *
 * Written AFTER the rules were final (structureMap.ts `asksForStructureMap`,
 * requestFacets.ts `isCallOrderClause` / FLOW_JA_RE), in a different voice and
 * domain mix from entryHeldout1.ts (game engine, ML training, fintech, media,
 * mobile, compilers, IoT, HR, healthcare; none of set #1's class or concern
 * names and nothing of the audit's OrderOrchestrator wording), and scored ONCE,
 * recorded as is. 107 items (58 EN, 49 JA):
 *   - 37 entry positives (b-*, h-*, mix-*): a short or map-shaped answer about a
 *     class AND the order / sequence / flow of its calls. 9 are deliberately
 *     phrased beyond any vocabulary an author would add: "the elevator version",
 *     "which stage it calls first" (active verb, no do-support), "which does it
 *     check first" (a verb that is no call word), "nothing exhaustive", "end to
 *     end … in that sequence", "the sequence in which it checks …", "phases and
 *     their order", 「どっちが先？」, 「どのあたりで入る？」.
 *   - 6 short-answer controls without a flow (m-*), 6 order-of-calls controls
 *     without a brevity word (f-*), 8 explain-in-full requests (x-*: a flow whose
 *     answer is asked in MORE detail, two of them with a NEGATED brevity word:
 *     "Don't summarize", 「要約せずに」),
 *   - 50 negatives: the business noun "order" (work order, order of magnitude,
 *     market order, purchase order, 発注の順番待ち, 注文日順に, 優先順位), brevity
 *     words in their other senses (`short` type, quick-start, Shortlist, a
 *     `--brief` option, QuickActions, SummaryCard, Map<K, V>, heatmap, the
 *     `overview` prop, short-term, dataflow, a GitHub gist, a cheat code, JA 簡単に
 *     差し替えられる / まとめて出力 / 要約テーブル / 地図タイル / 概要欄 / 短縮URL /
 *     ポイント還元 …), and change requests that mention an order of calls.
 * Labels (map / flow) are the author's reading of the REQUEST, written down
 * before the item was scored.
 */
import type { EntryHeldOutItem } from "./entryHeldout.js";

// prettier-ignore
export const ENTRY_HELDOUT_2: readonly EntryHeldOutItem[] = [
  // --- entry positives, EN ---
  { id: "b-en-01", lang: "en", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "Can you give me the elevator version of `TrainingLoop`? I mostly want to know the order it calls forward, loss and backward." },
  { id: "b-en-02", lang: "en", source: "fresh", category: "first-next", map: true, flow: true, text: "Rough overview of `PhysicsWorld.step` please - which runs first, broadphase or narrowphase?" },
  { id: "b-en-03", lang: "en", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "Brief description of `InvoiceMailer` and what it calls in what order: render, attach, send." },
  { id: "b-en-04", lang: "en", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "I just need the big picture of `ReplicaSync` and the order in which it invokes snapshot, ship and apply." },
  { id: "b-en-05", lang: "en", source: "fresh", category: "first-next", map: true, flow: true, text: "Short summary of `ClaimProcessor`, then tell me which of validate / adjudicate / pay it runs last." },
  { id: "b-en-06", lang: "en", source: "fresh", category: "when-called", map: true, flow: true, text: "give me a quick tour of `LevelStreamer` and when each loader gets called" },
  { id: "b-en-07", lang: "en", source: "fresh", category: "sequence-of-calls", map: true, flow: true, text: "TL;DR for `ArtifactUploader`: in what sequence does it call sign, chunk and commit?" },
  { id: "b-en-08", lang: "en", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "Walk me through `PayrollRun` at a high level, step by step, including the order it calls tax and deductions." },
  { id: "b-en-09", lang: "en", source: "fresh", category: "first-next", map: true, flow: true, text: "Summarize `AudioMixer` in 5 lines and say which stage it calls first." },
  { id: "b-en-10", lang: "en", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "Could you describe `RoutePlanner` briefly, and the order it hits the traffic, weather and fuel services?" },
  { id: "b-en-11", lang: "en", source: "fresh", category: "flow-other", map: true, flow: true, text: "At a high level, how does `OAuthClient` sequence authorize, token and refresh? Keep it short." },
  { id: "b-en-12", lang: "en", source: "fresh", category: "first-next", map: true, flow: true, text: "Please summarise `CrashReporter` in a nutshell: what gets triggered first when the app dies?" },
  { id: "b-en-13", lang: "en", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "Short and sweet: what does `Scheduler` do and what's its call order for plan, reserve and commit?" },
  { id: "b-en-14", lang: "en", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "A succinct explanation of `WebhookRelay` would be great, including the order it fires its retries and notifications." },
  { id: "b-en-15", lang: "en", source: "fresh", category: "oblique", map: true, flow: true, text: "What does `TokenBucket` do, in a sentence? And which does it check first, the burst limit or the refill?" },
  { id: "b-en-16", lang: "en", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "Give me the cliff notes on `CacheInvalidator` and the order it calls purge, warm and notify." },
  { id: "h-en-01", lang: "en", source: "fresh", category: "oblique", map: true, flow: true, text: "Could you sketch how `ModelServer` handles a request end to end, in a paragraph or so, and where the batching happens in that sequence?" },
  { id: "h-en-02", lang: "en", source: "fresh", category: "flow-other", map: true, flow: true, text: "Just the main flow of `RenderPipeline`, nothing exhaustive - pass order is what I care about." },
  { id: "h-en-03", lang: "en", source: "fresh", category: "oblique", map: true, flow: true, text: "Overview of `AuthMiddleware` please, specifically the sequence in which it checks token, session and role." },
  { id: "h-en-04", lang: "en", source: "fresh", category: "oblique", map: true, flow: true, text: "Concise explanation: when `Compiler.compile` runs, what are the phases and their order?" },

  // --- entry positives, JA ---
  { id: "b-ja-01", lang: "ja", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "`TrainingLoop` をざっくり説明してください。forward → loss → backward の順に呼んでいますか？" },
  { id: "b-ja-02", lang: "ja", source: "fresh", category: "first-next", map: true, flow: true, text: "PhysicsWorld の概要を簡潔に。broadphase と narrowphase はどちらが先に実行されますか？" },
  { id: "b-ja-03", lang: "ja", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "ClaimProcessor の全体像を手短に教えてください。検証・審査・支払いを呼び出す順序も含めて。" },
  { id: "b-ja-04", lang: "ja", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "LevelStreamer について、要点だけ。ローダーが呼ばれる順番はどうなってる？" },
  { id: "b-ja-05", lang: "ja", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "ArtifactUploader を一言で言うと何ですか。sign / chunk / commit を叩く順番も教えて。" },
  { id: "b-ja-06", lang: "ja", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "PayrollRun をさらっと説明してください。税計算と控除はどの順番で処理されますか？" },
  { id: "b-ja-07", lang: "ja", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "AudioMixer のアウトラインと、ステージを実行する順序をお願いします。" },
  { id: "b-ja-08", lang: "ja", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "ReplicaSync の仕組みを短めに。snapshot, ship, apply が走る順番だけ知りたいです。" },
  { id: "b-ja-09", lang: "ja", source: "fresh", category: "flow-other", map: true, flow: true, text: "RoutePlanner を簡単に紹介して。traffic / weather / fuel を呼び出す流れをステップバイステップで。" },
  { id: "b-ja-10", lang: "ja", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "WebhookRelay の概略を教えて。再試行と通知はどういう順番で発火しますか？" },
  { id: "b-ja-11", lang: "ja", source: "fresh", category: "first-next", map: true, flow: true, text: "CrashReporter をコンパクトに説明して。アプリが落ちたとき最初に呼ばれるのはどれ？" },
  { id: "b-ja-12", lang: "ja", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "Scheduler のポイントだけ教えて。plan → reserve → commit の呼び出し順は固定？" },
  { id: "b-ja-13", lang: "ja", source: "fresh", category: "oblique", map: true, flow: true, text: "TokenBucket をかいつまんで。burst の判定と refill はどっちが先？" },
  { id: "b-ja-14", lang: "ja", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "InvoiceMailer の動きをダイジェストで。render, attach, send の実行順を明示してほしい。" },
  { id: "h-ja-01", lang: "ja", source: "fresh", category: "oblique", map: true, flow: true, text: "`ModelServer` のリクエスト処理を大づかみに。バッチングはどのあたりで入る？" },
  { id: "h-ja-02", lang: "ja", source: "fresh", category: "flow-other", map: true, flow: true, text: "RenderPipeline のパスを順番に、ざっと並べて。" },
  { id: "mix-01", lang: "ja", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "`Scheduler` の TL;DR と、plan / reserve / commit の呼び出し順を教えて。" },

  // --- controls: a short answer without a flow ---
  { id: "m-en-01", lang: "en", source: "fresh", category: "map-only", map: true, flow: false, text: "TL;DR: what is `RateGate` for?" },
  { id: "m-en-02", lang: "en", source: "fresh", category: "map-only", map: true, flow: false, text: "Quick rundown of the fields on `UserProfile`." },
  { id: "m-en-03", lang: "en", source: "fresh", category: "map-only", map: true, flow: false, text: "Give me the gist of `ThemeProvider`." },
  { id: "m-ja-01", lang: "ja", source: "fresh", category: "map-only", map: true, flow: false, text: "`ThemeProvider` をざっと説明して。" },
  { id: "m-ja-02", lang: "ja", source: "fresh", category: "map-only", map: true, flow: false, text: "CartItem の役割を一言で。" },
  { id: "m-ja-03", lang: "ja", source: "fresh", category: "map-only", map: true, flow: false, text: "`UserProfile` のフィールドを簡潔に一覧して。" },

  // --- controls: an order-of-calls question without any brevity word ---
  { id: "f-en-01", lang: "en", source: "fresh", category: "flow-only", map: false, flow: true, text: "In what order does `Bootstrapper` call config, logger and db?" },
  { id: "f-en-02", lang: "en", source: "fresh", category: "flow-only", map: false, flow: true, text: "What's the invocation order of the middleware in `ServerPipeline`?" },
  { id: "f-en-03", lang: "en", source: "fresh", category: "flow-only", map: false, flow: true, text: "Which runs first in `FormValidator`, sync or async validation?" },
  { id: "f-ja-01", lang: "ja", source: "fresh", category: "flow-only", map: false, flow: true, text: "`Bootstrapper` が config / logger / db を呼ぶ順番は？" },
  { id: "f-ja-02", lang: "ja", source: "fresh", category: "flow-only", map: false, flow: true, text: "ServerPipeline の middleware の実行順序を教えて。" },
  { id: "f-ja-03", lang: "ja", source: "fresh", category: "flow-only", map: false, flow: true, text: "FormValidator では同期と非同期のどちらが最初に実行される？" },

  // --- an order-of-calls question that asks for MORE detail: flow, never map-shaped ---
  { id: "x-en-01", lang: "en", source: "fresh", category: "explain-in-full", map: false, flow: true, text: "Walk me through every step `CampaignSender` takes, in full detail, and the exact order it calls the segment, template and delivery services." },
  { id: "x-en-02", lang: "en", source: "fresh", category: "explain-in-full", map: false, flow: true, text: "I want an exhaustive explanation of `LedgerPoster`: what order does it call validate, post and reconcile in, and why?" },
  { id: "x-en-03", lang: "en", source: "fresh", category: "explain-in-full", map: false, flow: true, text: "Go line by line through `GatewayRouter` and tell me the order in which it invokes each handler." },
  { id: "x-en-04", lang: "en", source: "fresh", category: "explain-in-full-negated", map: false, flow: true, text: "Don't summarize - go through `GatewayRouter` line by line and tell me the order in which it invokes each handler." },
  { id: "x-ja-01", lang: "ja", source: "fresh", category: "explain-in-full", map: false, flow: true, text: "`CampaignSender` が segment / template / delivery を呼ぶ順番を、省略せず一つずつ詳しく解説してください。" },
  { id: "x-ja-02", lang: "ja", source: "fresh", category: "explain-in-full", map: false, flow: true, text: "LedgerPoster の呼び出し順を、理由も含めて徹底的に説明して。" },
  { id: "x-ja-03", lang: "ja", source: "fresh", category: "explain-in-full", map: false, flow: true, text: "GatewayRouter がハンドラを実行する順序を一行ずつ追って、全部書き出して。" },
  { id: "x-ja-04", lang: "ja", source: "fresh", category: "explain-in-full-negated", map: false, flow: true, text: "要約せずに、GatewayRouter がハンドラを実行する順序を一行ずつ追って。" },

  // --- negatives: the business noun "order" and "order" as a modifier ---
  { id: "n-en-01", lang: "en", source: "fresh", category: "order-sense", map: false, flow: false, text: "Show me where work orders are created and which status they start in." },
  { id: "n-en-02", lang: "en", source: "fresh", category: "order-sense", map: false, flow: false, text: "What is the order of magnitude of the retry delay in `Backoff`?" },
  { id: "n-en-03", lang: "en", source: "fresh", category: "order-sense", map: false, flow: false, text: "How does the checkout page handle an order that has been partially refunded?" },
  { id: "n-en-04", lang: "en", source: "fresh", category: "order-sense", map: false, flow: false, text: "Which fields are in an order confirmation email, and in what order do they appear?" },
  { id: "n-en-05", lang: "en", source: "fresh", category: "order-sense", map: false, flow: false, text: "Cancel the order if the payment call times out." },
  { id: "n-en-06", lang: "en", source: "fresh", category: "order-sense", map: false, flow: false, text: "What's in `OrderLine` and how are lines sorted when an order is printed?" },
  { id: "n-en-07", lang: "en", source: "fresh", category: "order-sense", map: false, flow: false, text: "Does the trading engine reject a market order outside of hours? Look at the call in `OrderGateway`." },
  { id: "n-en-08", lang: "en", source: "fresh", category: "order-sense", map: false, flow: false, text: "Which orders does `ReportJob` call `archive` on after a purchase order is closed?" },
  { id: "n-en-09", lang: "en", source: "fresh", category: "order-sense", map: false, flow: false, text: "In order to reproduce the crash, which service do I start first?" },
  { id: "n-en-10", lang: "en", source: "fresh", category: "order-sense", map: false, flow: false, text: "Sort the invoices by order date and then by customer." },
  { id: "n-ja-01", lang: "ja", source: "fresh", category: "order-sense", map: false, flow: false, text: "発注の順番待ちが長いときはどこでタイムアウトしますか？" },
  { id: "n-ja-02", lang: "ja", source: "fresh", category: "order-sense", map: false, flow: false, text: "受注テーブルを注文日順に並べる SQL はどこ？" },
  { id: "n-ja-03", lang: "ja", source: "fresh", category: "order-sense", map: false, flow: false, text: "ユーザーの表示順番を変更する API は？" },
  { id: "n-ja-04", lang: "ja", source: "fresh", category: "order-sense", map: false, flow: false, text: "オーダーの優先順位はどこで決まりますか？" },
  { id: "n-ja-05", lang: "ja", source: "fresh", category: "order-sense", map: false, flow: false, text: "処理待ちの注文を一覧にするクエリはどれ？" },
  { id: "n-ja-06", lang: "ja", source: "fresh", category: "order-sense", map: false, flow: false, text: "バッチの実行順位を教えて。" },

  // --- negatives: brevity words in their other senses ---
  { id: "s-en-01", lang: "en", source: "fresh", category: "short-sense", map: false, flow: false, text: "Why does `TypeInfo` store the field as a `short` and not an int?" },
  { id: "s-en-02", lang: "en", source: "fresh", category: "quick-sense", map: false, flow: false, text: "Is the quick-start guide in `docs/` still accurate for the CLI?" },
  { id: "s-en-03", lang: "en", source: "fresh", category: "short-sense", map: false, flow: false, text: "Does `Shortlist` get rebuilt when a candidate is added?" },
  { id: "s-en-04", lang: "en", source: "fresh", category: "code-name", map: false, flow: false, text: "What does the `--brief` option do in `git-log-wrapper`?" },
  { id: "s-en-05", lang: "en", source: "fresh", category: "quick-sense", map: false, flow: false, text: "Why does `QuickActions` re-render the toolbar on every keystroke?" },
  { id: "s-en-06", lang: "en", source: "fresh", category: "code-name", map: false, flow: false, text: "Where does `SummaryCard` get its data from?" },
  { id: "s-en-07", lang: "en", source: "fresh", category: "code-name", map: false, flow: false, text: "Which module defines the `Map<String, List<Order>>` used in `Index`?" },
  { id: "s-en-08", lang: "en", source: "fresh", category: "code-name", map: false, flow: false, text: "Why is the heatmap colour scale wrong in `Dashboard`?" },
  { id: "s-en-09", lang: "en", source: "fresh", category: "code-name", map: false, flow: false, text: "What does the `overview` prop on `Tabs` control?" },
  { id: "s-en-10", lang: "en", source: "fresh", category: "short-sense", map: false, flow: false, text: "Fix the short-term cache TTL in `Config`." },
  { id: "s-en-11", lang: "en", source: "fresh", category: "code-name", map: false, flow: false, text: "Check whether `step` is reset between runs in `Trainer`." },
  { id: "s-en-12", lang: "en", source: "fresh", category: "code-name", map: false, flow: false, text: "Why is the dataflow graph acyclic in `Planner`?" },
  { id: "s-en-13", lang: "en", source: "fresh", category: "code-name", map: false, flow: false, text: "Where is the workflow engine's `Flow` base class declared?" },
  { id: "s-en-14", lang: "en", source: "fresh", category: "code-name", map: false, flow: false, text: "Open a gist with the failing test." },
  { id: "s-en-15", lang: "en", source: "fresh", category: "code-name", map: false, flow: false, text: "Add a cheat code to skip the tutorial in `GameState`." },
  { id: "s-ja-01", lang: "ja", source: "fresh", category: "ease", map: false, flow: false, text: "このモジュール、簡単に差し替えられる設計になってる？" },
  { id: "s-ja-02", lang: "ja", source: "fresh", category: "ease", map: false, flow: false, text: "テストを簡単に書けるようにしたい。" },
  { id: "s-ja-03", lang: "ja", source: "fresh", category: "bulk", map: false, flow: false, text: "ログをまとめて出力するクラスはどれ？" },
  { id: "s-ja-04", lang: "ja", source: "fresh", category: "code-name", map: false, flow: false, text: "要約テーブルを更新するバッチはどこ？" },
  { id: "s-ja-05", lang: "ja", source: "fresh", category: "code-name", map: false, flow: false, text: "地図タイルのキャッシュ戦略を教えて。" },
  { id: "s-ja-06", lang: "ja", source: "fresh", category: "code-name", map: false, flow: false, text: "概要欄に入力できる最大文字数は？" },
  { id: "s-ja-07", lang: "ja", source: "fresh", category: "short-sense", map: false, flow: false, text: "ショートカット機能の実装場所は？" },
  { id: "s-ja-08", lang: "ja", source: "fresh", category: "short-sense", map: false, flow: false, text: "短縮URLを生成する処理はどこですか？" },
  { id: "s-ja-09", lang: "ja", source: "fresh", category: "short-sense", map: false, flow: false, text: "処理を短くしたいので、重複している部分を探して。" },
  { id: "s-ja-10", lang: "ja", source: "fresh", category: "ease", map: false, flow: false, text: "簡単に説明されているドキュメントはどこ？" },
  { id: "s-ja-11", lang: "ja", source: "fresh", category: "ease", map: false, flow: false, text: "軽く動かして確認してほしい。" },
  { id: "s-ja-12", lang: "ja", source: "fresh", category: "code-name", map: false, flow: false, text: "ポイント還元の計算式はどこ？" },
  { id: "s-ja-13", lang: "ja", source: "fresh", category: "code-name", map: false, flow: false, text: "要点をまとめたドキュメントを更新して。" },

  // --- negatives: change requests that mention an order of calls ---
  { id: "c-en-01", lang: "en", source: "fresh", category: "change", map: false, flow: false, text: "Reorder the hooks in `Plugin` so teardown runs before init." },
  { id: "c-en-02", lang: "en", source: "fresh", category: "change", map: false, flow: false, text: "Make `Bootstrapper` call config first and then the logger." },
  { id: "c-en-03", lang: "en", source: "fresh", category: "change", map: false, flow: false, text: "Rename the call order enum to `InvocationOrder`." },
  { id: "c-ja-01", lang: "ja", source: "fresh", category: "change", map: false, flow: false, text: "`Bootstrapper` が config を先に呼ぶように変更して。" },
  { id: "c-ja-02", lang: "ja", source: "fresh", category: "change", map: false, flow: false, text: "実行順序を入れ替えるリファクタリングをお願いします。" },
  { id: "c-ja-03", lang: "ja", source: "fresh", category: "change", map: false, flow: false, text: "処理の順番を入れ替えたい。" },
];

/**
 * Set #2b (2026-10-24): 29 items written AFTER set #2 was scored and AFTER the
 * two classes it exposed were fixed (a NEGATED brevity word — "Don't summarize",
 * 「要約せずに」 — became an entry false positive once the order-of-calls vocabulary
 * gave such a request a flow; and "the exact order it calls …"), as the blind
 * check of those fixes: 13 entry positives (c-*, d-en-04, incl. "the precise
 * order", "the actual order its plugins get called in", "Why not a short
 * summary …"), 5 explain-in-full requests whose brevity word is NEGATED
 * ("Don't give me a summary", "Not a quick overview", "Rather than a high-level
 * outline", 「概要ではなく」, 「簡潔にせず」) and 11 negatives, among them 「ざっと見た
 * 感じ、何行くらい？」 (ざっと as "roughly", a trap of the new word). Scored once,
 * after the fixes.
 */
// prettier-ignore
export const ENTRY_HELDOUT_2B: readonly EntryHeldOutItem[] = [
  { id: "c-en-01", lang: "en", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "Quick overview of `ShardRouter`, and the precise order it calls lookup, route and fallback." },
  { id: "c-en-02", lang: "en", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "Briefly: what is `SnapshotWriter` for, and in which order does it invoke flush, fsync and rename?" },
  { id: "c-en-03", lang: "en", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "TL;DR of `PluginHost` including the actual order its plugins get called in." },
  { id: "c-en-04", lang: "en", source: "fresh", category: "first-next", map: true, flow: true, text: "Short version please: what does `QueueDrainer` do and which of ack, retry and dead-letter runs first?" },
  { id: "c-en-05", lang: "en", source: "fresh", category: "sequence-of-calls", map: true, flow: true, text: "Give me a high-level map of `BuildGraph` and the call sequence during an incremental build." },
  { id: "c-en-06", lang: "en", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "In a few sentences, explain `DeltaEncoder` and the order it hits compress, diff and pack." },
  { id: "d-en-04", lang: "en", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "Why not a short summary of `QueueDrainer` and the order it calls ack and retry in?" },
  { id: "c-ja-01", lang: "ja", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "`ShardRouter` をざっと説明して。lookup / route / fallback を呼ぶ順番も。" },
  { id: "c-ja-02", lang: "ja", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "SnapshotWriter の要点を簡潔に。flush・fsync・rename の実行順序を知りたい。" },
  { id: "c-ja-03", lang: "ja", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "PluginHost を手短に。プラグインが呼び出される順番は？" },
  { id: "c-ja-04", lang: "ja", source: "fresh", category: "first-next", map: true, flow: true, text: "QueueDrainer の全体像と、ack / retry / dead-letter のうち最初に実行されるものを短く教えて。" },
  { id: "c-ja-05", lang: "ja", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "BuildGraph のアウトラインを。インクリメンタルビルド時の呼び出し順だけでいいです。" },
  { id: "c-ja-06", lang: "ja", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "DeltaEncoder を一言でまとめて。compress → diff → pack の順に叩いてる？" },

  { id: "d-en-01", lang: "en", source: "fresh", category: "explain-in-full-negated", map: false, flow: true, text: "Please don't give me a summary of `SnapshotWriter` - walk through it in detail, including the order in which it calls flush and fsync." },
  { id: "d-en-02", lang: "en", source: "fresh", category: "explain-in-full-negated", map: false, flow: true, text: "Not a quick overview: I need a thorough explanation of `ShardRouter` and the exact order it calls lookup, route and fallback." },
  { id: "d-en-03", lang: "en", source: "fresh", category: "explain-in-full-negated", map: false, flow: true, text: "Rather than a high-level outline, give me the full call order inside `PluginHost`." },
  { id: "d-ja-01", lang: "ja", source: "fresh", category: "explain-in-full-negated", map: false, flow: true, text: "概要ではなく、PluginHost がプラグインを呼び出す順番を詳細に教えて。" },
  { id: "d-ja-02", lang: "ja", source: "fresh", category: "explain-in-full-negated", map: false, flow: true, text: "簡潔にせず、DeltaEncoder の実行順序を一つずつ全部説明して。" },

  { id: "e-en-01", lang: "en", source: "fresh", category: "code-name", map: false, flow: false, text: "Where does `SummaryCard` read the order total from?" },
  { id: "e-en-02", lang: "en", source: "fresh", category: "quick-sense", map: false, flow: false, text: "Is the `quick_start` flag read before `Config.load` finishes?" },
  { id: "e-en-03", lang: "en", source: "fresh", category: "change", map: false, flow: false, text: "Change `ShardRouter` so lookup is called before fallback." },
  { id: "e-en-04", lang: "en", source: "fresh", category: "order-modifier", map: false, flow: false, text: "Which order does `Exporter` call `send` for in a batch of mixed orders?" },
  { id: "e-en-05", lang: "en", source: "fresh", category: "short-sense", map: false, flow: false, text: "What's the shortest way to call `SnapshotWriter` from the CLI?" },
  { id: "e-ja-01", lang: "ja", source: "fresh", category: "bulk", map: false, flow: false, text: "テーブルをまとめて更新するジョブはどれ？" },
  { id: "e-ja-02", lang: "ja", source: "fresh", category: "ease", map: false, flow: false, text: "簡単に使えるAPIにしたい。" },
  { id: "e-ja-03", lang: "ja", source: "fresh", category: "order-sense", map: false, flow: false, text: "注文の順番を管理するキューはどこ？" },
  { id: "e-ja-04", lang: "ja", source: "fresh", category: "code-name", map: false, flow: false, text: "概要欄が空のときの表示はどこで決めている？" },
  { id: "e-ja-05", lang: "ja", source: "fresh", category: "short-sense", map: false, flow: false, text: "ざっと見た感じ、`ShardRouter` は何行くらいありますか？" },
  { id: "e-ja-06", lang: "ja", source: "fresh", category: "code-name", map: false, flow: false, text: "ポイント制の割引ロジックを教えて。" },
];
