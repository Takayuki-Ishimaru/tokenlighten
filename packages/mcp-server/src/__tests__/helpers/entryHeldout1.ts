/**
 * entryHeldout1.ts — structure-map ENTRY held-out set #1 (2026-10-24): the
 * DEVELOPMENT set of the entry-vocabulary change (see
 * requestFacets.heldout8.spec.ts and structureMapEntry.heldout1.spec.ts for the
 * results and the rules it shaped).
 *
 * Written BEFORE any rule was changed, from the generality audit's finding
 * (fable-analysis-r16/generality-audit.md §3.3.3, §2.5): of 16 paraphrases of a
 * map-shaped order-of-calls question, 1 EN and 0 JA satisfied both entry
 * detectors. 172 items:
 *   - 16 AUDIT positives (a-*: the audit's own paraphrases, which the rule design
 *     started from, so they are not blind),
 *   - 49 FRESH positives (p-*: a short or map-shaped answer about a class AND the
 *     order / sequence / flow of its calls; varied registers, class names and
 *     domains; some deliberately phrased beyond any vocabulary an author would
 *     add: "without going into detail", "before or after", "don't go too deep"),
 *   - 8 map-only controls (m-*: a short answer, no flow) and 8 flow-only controls
 *     (f-*: an order-of-calls question without any brevity word) plus 10
 *     explain-in-full items (x-*: an order-of-calls question that asks for MORE
 *     detail, so it must not be map-shaped),
 *   - 81 NEGATIVES (n-*, s-*): the business noun "order" (purchase order, order
 *     status, orders table, sort order, in order to, ORDER BY, ordered list,
 *     注文の順番, 順番待ち) and "order" as a modifier of a service next to a call
 *     verb; change requests that mention an order of calls; "short" / "quick" /
 *     "summary" / "overview" / "brief" / "map" / "step" / "flow" / "tldr" in
 *     their other senses (short-circuit, shortcut, short-lived, short int, in
 *     short supply, quick fix, quickSort, how quickly, shorten, `summary.total`,
 *     `Overview`, `HashMap`, `map()`, `step()`, `Flow<T>`, a `brief` flag);
 *     ease rather than brevity (簡単に直せますか, 簡単にできる), 「まとめて」 as
 *     "all at once" (まとめて削除), 短く as "shorten" (短くしたい).
 * Labels (map / flow) are the author's reading of the REQUEST, written down
 * before the item was scored. The author knew the existing vocabulary, so the
 * set is not independent of it; entryHeldout2.ts is the later, blind check.
 */
import type { EntryHeldOutItem } from "./entryHeldout.js";

// prettier-ignore
export const ENTRY_HELDOUT_1: readonly EntryHeldOutItem[] = [
  // --- the audit's 16 paraphrases (generality-audit.md §3.3.3; scratchpad/ga2/tools/phrase.mjs) ---
  { id: "a-en-01", lang: "en", source: "audit", category: "audit", map: true, flow: true, text: "Give me a quick overview of OrderOrchestrator and the order it calls payment / inventory / shipping in." },
  { id: "a-en-02", lang: "en", source: "audit", category: "audit", map: true, flow: true, text: "Explain the OrderOrchestrator class briefly: what order does it call payment / inventory / shipping in?" },
  { id: "a-en-03", lang: "en", source: "audit", category: "audit", map: true, flow: true, text: "Short explanation of OrderOrchestrator please, and in which order it calls payment / inventory / shipping." },
  { id: "a-en-04", lang: "en", source: "audit", category: "audit", map: true, flow: true, text: "TL;DR of what OrderOrchestrator does and the sequence of payment / inventory / shipping calls." },
  { id: "a-en-05", lang: "en", source: "audit", category: "audit", map: true, flow: true, text: "Summarize OrderOrchestrator: how does a request flow through payment / inventory / shipping?" },
  { id: "a-en-06", lang: "en", source: "audit", category: "audit", map: true, flow: true, text: "High-level map of OrderOrchestrator, focusing on when payment / inventory / shipping get called." },
  { id: "a-en-07", lang: "en", source: "audit", category: "audit", map: true, flow: true, text: "Describe OrderOrchestrator at a glance; which of payment / inventory / shipping runs first?" },
  { id: "a-en-08", lang: "en", source: "audit", category: "audit", map: true, flow: true, text: "What does OrderOrchestrator do? Keep it short. Walk me through how it calls payment / inventory / shipping step by step." },
  { id: "a-ja-01", lang: "ja", source: "audit", category: "audit", map: true, flow: true, text: "OrderOrchestrator の概要と、payment / inventory / shipping を呼ぶ順番を教えて。" },
  { id: "a-ja-02", lang: "ja", source: "audit", category: "audit", map: true, flow: true, text: "OrderOrchestrator をざっと説明して。payment / inventory / shipping はどの順で呼ばれる？" },
  { id: "a-ja-03", lang: "ja", source: "audit", category: "audit", map: true, flow: true, text: "OrderOrchestrator について簡単に。payment / inventory / shipping の呼び出し順序も。" },
  { id: "a-ja-04", lang: "ja", source: "audit", category: "audit", map: true, flow: true, text: "OrderOrchestrator の要点を短く。payment / inventory / shipping がどう呼ばれるか。" },
  { id: "a-ja-05", lang: "ja", source: "audit", category: "audit", map: true, flow: true, text: "OrderOrchestrator が payment / inventory / shipping をどういう流れで呼ぶのか、全体像をください。" },
  { id: "a-ja-06", lang: "ja", source: "audit", category: "audit", map: true, flow: true, text: "OrderOrchestrator の処理の流れを、payment / inventory / shipping を中心にまとめて。" },
  { id: "a-ja-07", lang: "ja", source: "audit", category: "audit", map: true, flow: true, text: "OrderOrchestrator は何をするクラス？ payment / inventory / shipping の順番は？ 簡潔にお願いします。" },
  { id: "a-ja-08", lang: "ja", source: "audit", category: "audit", map: true, flow: true, text: "OrderOrchestrator クラスの説明をお願いします（payment / inventory / shipping の呼び出し順を含めて、できれば30行くらいで）。" },

  // --- fresh positives, EN: a short / map-shaped answer about a class + the order / sequence / flow of its calls ---
  { id: "p-en-01", lang: "en", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "TL;DR on `SessionManager`: in which order does it call refresh, validate and persist?" },
  { id: "p-en-02", lang: "en", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "Short version of what `ImportJob` does, please, plus the order in which it runs parse, validate and write." },
  { id: "p-en-03", lang: "en", source: "fresh", category: "first-next", map: true, flow: true, text: "Quick rundown of the `ReportGenerator` class - what gets called first, and what comes after?" },
  { id: "p-en-04", lang: "en", source: "fresh", category: "sequence-of-calls", map: true, flow: true, text: "In a nutshell, what does `MigrationRunner` do? I mostly care about the sequence it invokes the up/down hooks in." },
  { id: "p-en-05", lang: "en", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "Could you sketch `TaskDispatcher` at a high level and tell me the order it calls the retry and dead-letter handlers in?" },
  { id: "p-en-06", lang: "en", source: "fresh", category: "flow-other", map: true, flow: true, text: "Please keep it brief: how does `UploadManager` sequence validate, scan and store?" },
  { id: "p-en-07", lang: "en", source: "fresh", category: "first-next", map: true, flow: true, text: "Summarize `PipelineRunner` in a few sentences, and say which of extract / transform / load it executes first." },
  { id: "p-en-08", lang: "en", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "At a glance, what does `RequestRouter` do, and what order are authenticate / rateLimit / dispatch called in?" },
  { id: "p-en-09", lang: "en", source: "fresh", category: "oblique", map: true, flow: true, text: "Without going into detail: what is `CacheWarmer` for, and when do its load and refresh steps get called?" },
  { id: "p-en-10", lang: "en", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "A concise description of `NotificationCenter` please, with the call order of send, retry and log." },
  { id: "p-en-11", lang: "en", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "Outline `BillingEngine` for me - just the big picture and the order it invokes proration, discounts and invoicing." },
  { id: "p-en-12", lang: "en", source: "fresh", category: "sequence-of-calls", map: true, flow: true, text: "Can you give a short summary of how `AuthGateway` handles a login and the sequence of calls it makes to the token, session and audit services?" },
  { id: "p-en-13", lang: "en", source: "fresh", category: "first-next", map: true, flow: true, text: "Explain `JobScheduler` in a few lines. Which of enqueue, lock and dispatch runs first?" },
  { id: "p-en-14", lang: "en", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "Brief overview of `FulfillmentService` -- what is the call order for PaymentGateway, InventoryClient and ShippingClient?" },
  { id: "p-en-15", lang: "en", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "I need a bird's-eye view of `WorkflowEngine`: what it calls and in what order, step by step." },
  { id: "p-en-16", lang: "en", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "Walk me through `DeployPipeline` quickly - in which order do build, test and publish get invoked?" },
  { id: "p-en-17", lang: "en", source: "fresh", category: "flow-other", map: true, flow: true, text: "Short overview of `EventBus`: how does an event travel from publish to the subscribers?" },
  { id: "p-en-18", lang: "en", source: "fresh", category: "flow-other", map: true, flow: true, text: "Give me the gist of `CrawlerService` - the lifecycle of a crawl from queue to storage." },
  { id: "p-en-19", lang: "en", source: "fresh", category: "flow-other", map: true, flow: true, text: "What does `ConfigLoader` do? Keep it short. Trace what happens from reading the file to merging overrides." },
  { id: "p-en-20", lang: "en", source: "fresh", category: "flow-other", map: true, flow: true, text: "TL;DR the control flow of `RetryPolicy`." },
  { id: "p-en-21", lang: "en", source: "fresh", category: "before-after", map: true, flow: true, text: "Quick overview of `Checkout` in src/shop/checkout.ts: what does it call, and does it hit tax before or after pricing?" },
  { id: "p-en-22", lang: "en", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "Give me a compact overview of the `InvoiceBatch` class and the order its steps run in." },
  { id: "p-en-23", lang: "en", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "Briefly describe `LedgerService`, in particular the order in which it posts, reconciles and closes." },
  { id: "p-en-24", lang: "en", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "Short answer: in what order does `Bootstrapper` initialise logging, config and the DB pool?" },
  { id: "p-en-25", lang: "en", source: "fresh", category: "oblique", map: true, flow: true, text: "Don't go too deep - I just need to know what `PaymentRetrier` does and the order it calls the gateway and the fallback in." },

  // --- fresh positives, JA ---
  { id: "p-ja-01", lang: "ja", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "SessionManager をざっくり説明して。refresh → validate → persist の順に呼んでる？" },
  { id: "p-ja-02", lang: "ja", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "ImportJob の概要を教えて。parse、validate、write はどの順番で実行されますか？" },
  { id: "p-ja-03", lang: "ja", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "ReportGenerator を簡単に説明して。fetch / aggregate / render を呼び出す順番も知りたい。" },
  { id: "p-ja-04", lang: "ja", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "MigrationRunner の要点だけ教えて。up と down のフックはどんな順番で呼ばれる？" },
  { id: "p-ja-05", lang: "ja", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "TaskDispatcher を一言でいうと何？ retry handler と dead-letter handler を呼ぶ順序も。" },
  { id: "p-ja-06", lang: "ja", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "PipelineRunner の全体像を手短に。extract / transform / load の実行順序を中心に。" },
  { id: "p-ja-07", lang: "ja", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "RequestRouter について、ざっと流れを教えて。authenticate、rateLimit、dispatch が呼ばれる順番はどうなっていますか？" },
  { id: "p-ja-08", lang: "ja", source: "fresh", category: "when-called", map: true, flow: true, text: "CacheWarmer の役割を簡潔に。load と refresh はどのタイミングで呼ばれるの？" },
  { id: "p-ja-09", lang: "ja", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "NotificationCenter の動きを3行でまとめて。send → retry → log の順に叩いてる？" },
  { id: "p-ja-10", lang: "ja", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "BillingEngine を短く説明してください。日割り計算・割引・請求書発行をどの順番で呼び出しているか知りたいです。" },
  { id: "p-ja-11", lang: "ja", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "AuthGateway の概略と、token / session / audit の各サービスを呼び出す順番を教えてください。" },
  { id: "p-ja-12", lang: "ja", source: "fresh", category: "first-next", map: true, flow: true, text: "JobScheduler の挙動をざっくり。enqueue / lock / dispatch のうち最初に実行されるのはどれ？" },
  { id: "p-ja-13", lang: "ja", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "FulfillmentService のまとめを簡単にお願いします。PaymentGateway、InventoryClient、ShippingClient の呼び出し順は？" },
  { id: "p-ja-14", lang: "ja", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "WorkflowEngine を俯瞰して教えて。build → test → publish の処理の順番が知りたい。" },
  { id: "p-ja-15", lang: "ja", source: "fresh", category: "flow-other", map: true, flow: true, text: "EventBus の概要。publish からサブスクライバーに届くまでの流れを簡潔に。" },
  { id: "p-ja-16", lang: "ja", source: "fresh", category: "flow-other", map: true, flow: true, text: "CrawlerService のライフサイクルをざっと説明して。" },
  { id: "p-ja-17", lang: "ja", source: "fresh", category: "flow-other", map: true, flow: true, text: "ConfigLoader が何をするか短く。ファイル読み込みから override マージまでを順番に追ってほしい。" },
  { id: "p-ja-18", lang: "ja", source: "fresh", category: "flow-other", map: true, flow: true, text: "RetryPolicy の制御フローをかいつまんで教えて。" },
  { id: "p-ja-19", lang: "ja", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "`InvoiceBatch` クラスをコンパクトに説明して。各ステップが走る順序も。" },
  { id: "p-ja-20", lang: "ja", source: "fresh", category: "oblique", map: true, flow: true, text: "Bootstrapper の初期化処理を大まかに教えて。logging、config、DB プールはどういう順番で立ち上げてる？" },
  { id: "p-ja-21", lang: "ja", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "LedgerService の仕組みを短くまとめて。post → reconcile → close を呼ぶ順番は固定ですか？" },
  { id: "p-ja-22", lang: "ja", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "OrderSaga を要約すると？ 補償処理が呼ばれる順番も教えて。" },
  { id: "p-ja-23", lang: "ja", source: "fresh", category: "order-of-calls", map: true, flow: true, text: "CheckoutService の全体像を簡潔に説明して、pricing → tax → payment の呼び出し順序を明示してほしい。" },
  { id: "p-ja-24", lang: "ja", source: "fresh", category: "before-after", map: true, flow: true, text: "CartService をざっくり。割引計算が呼ばれるのは在庫確認の前？後？" },

  // --- controls: a short answer without a flow (map only) ---
  { id: "m-en-01", lang: "en", source: "fresh", category: "map-only", map: true, flow: false, text: "Short summary of `PricingService`: which discounts can stack?" },
  { id: "m-en-02", lang: "en", source: "fresh", category: "map-only", map: true, flow: false, text: "TL;DR: what does `UserRepository` do?" },
  { id: "m-en-03", lang: "en", source: "fresh", category: "map-only", map: true, flow: false, text: "Give me a quick overview of the public methods on `CartService`." },
  { id: "m-en-04", lang: "en", source: "fresh", category: "map-only", map: true, flow: false, text: "Can you keep it brief and explain what `TaxCalculator` is responsible for?" },
  { id: "m-ja-01", lang: "ja", source: "fresh", category: "map-only", map: true, flow: false, text: "CartService をざっくり説明して。" },
  { id: "m-ja-02", lang: "ja", source: "fresh", category: "map-only", map: true, flow: false, text: "`TaxCalculator` の役割を簡単に説明して。" },
  { id: "m-ja-03", lang: "ja", source: "fresh", category: "map-only", map: true, flow: false, text: "UserRepository の要点だけ教えて。" },
  { id: "m-ja-04", lang: "ja", source: "fresh", category: "map-only", map: true, flow: false, text: "PricingService の概要を短くまとめて。" },

  // --- controls: an order-of-calls question without any brevity word (flow only) ---
  { id: "f-en-01", lang: "en", source: "fresh", category: "flow-only", map: false, flow: true, text: "In which order does `ImportJob` call parse, validate and write?" },
  { id: "f-en-02", lang: "en", source: "fresh", category: "flow-only", map: false, flow: true, text: "What order does `CheckoutService` call pricing, tax and payment in?" },
  { id: "f-en-03", lang: "en", source: "fresh", category: "flow-only", map: false, flow: true, text: "Which one is called first in `RequestRouter`, `authenticate` or `rateLimit`?" },
  { id: "f-en-04", lang: "en", source: "fresh", category: "flow-only", map: false, flow: true, text: "What's the sequence of calls `BillingEngine` makes during invoicing?" },
  { id: "f-ja-01", lang: "ja", source: "fresh", category: "flow-only", map: false, flow: true, text: "ImportJob が parse / validate / write を呼ぶ順番を教えて。" },
  { id: "f-ja-02", lang: "ja", source: "fresh", category: "flow-only", map: false, flow: true, text: "RequestRouter では authenticate と rateLimit はどちらが先に呼ばれる？" },
  { id: "f-ja-03", lang: "ja", source: "fresh", category: "flow-only", map: false, flow: true, text: "CheckoutService の呼び出し順序を教えてください。" },
  { id: "f-ja-04", lang: "ja", source: "fresh", category: "flow-only", map: false, flow: true, text: "BillingEngine の各ステップが実行される順番は？" },

  // --- an order-of-calls question that asks for MORE detail: flow, but never map-shaped ---
  { id: "x-en-01", lang: "en", source: "fresh", category: "explain-in-full", map: false, flow: true, text: "Explain in detail how `CheckoutService` calls pricing, tax and payment, and in which order." },
  { id: "x-en-02", lang: "en", source: "fresh", category: "explain-in-full", map: false, flow: true, text: "Walk me through `ImportJob` step by step, including the order it runs parse, validate and write. Don't skip anything." },
  { id: "x-en-03", lang: "en", source: "fresh", category: "explain-in-full", map: false, flow: true, text: "I need a thorough explanation of `SessionManager`: what order does it call refresh, validate and persist in?" },
  { id: "x-en-04", lang: "en", source: "fresh", category: "explain-in-full", map: false, flow: true, text: "Give me the complete call order of `BillingEngine`, every step, nothing omitted." },
  { id: "x-en-05", lang: "en", source: "fresh", category: "explain-in-full", map: false, flow: true, text: "How quickly does `JobScheduler` call dispatch after enqueue, and in what order are queued jobs run?" },
  { id: "x-en-06", lang: "en", source: "fresh", category: "explain-in-full", map: false, flow: true, text: "Describe in depth how `Bootstrapper` initialises logging, config and the DB pool, in which order and why." },
  { id: "x-ja-01", lang: "ja", source: "fresh", category: "explain-in-full", map: false, flow: true, text: "`CheckoutService` が pricing / tax / payment を呼ぶ順番を、詳しく説明してください。" },
  { id: "x-ja-02", lang: "ja", source: "fresh", category: "explain-in-full", map: false, flow: true, text: "ImportJob の処理を一行ずつ丁寧に追って、parse → validate → write の実行順序を教えて。" },
  { id: "x-ja-03", lang: "ja", source: "fresh", category: "explain-in-full", map: false, flow: true, text: "SessionManager の呼び出し順を、省略せずすべて挙げてください。" },
  { id: "x-ja-04", lang: "ja", source: "fresh", category: "explain-in-full", map: false, flow: true, text: "簡単にはいかないと思うけど、`BillingEngine` が日割り計算・割引・請求書発行を呼ぶ順番を詳しく知りたい。" },

  // --- negatives: the business noun "order", and "order" next to a call verb as a modifier ---
  { id: "n-en-01", lang: "en", source: "fresh", category: "order-sense", map: true, flow: false, text: "Give me a quick overview of the `Order` entity and how the orders table is laid out." },
  { id: "n-en-02", lang: "en", source: "fresh", category: "order-sense", map: false, flow: false, text: "What are the possible order statuses in `OrderStatus`?" },
  { id: "n-en-03", lang: "en", source: "fresh", category: "order-sense", map: false, flow: false, text: "Where do we call the payment API when an order is cancelled?" },
  { id: "n-en-04", lang: "en", source: "fresh", category: "order-modifier", map: false, flow: false, text: "How does the order service call the inventory service?" },
  { id: "n-en-05", lang: "en", source: "fresh", category: "order-sense", map: false, flow: false, text: "In order to understand `CheckoutService`, which file should I start with?" },
  { id: "n-en-06", lang: "en", source: "fresh", category: "order-sense", map: true, flow: false, text: "Summarize the ORDER BY clauses used in `ReportQueries`." },
  { id: "n-en-07", lang: "en", source: "fresh", category: "order-sense", map: false, flow: false, text: "Why does the ordered list in `renderChangelog` start at 0?" },
  { id: "n-en-08", lang: "en", source: "fresh", category: "order-sense", map: true, flow: false, text: "Briefly, what is the sort order of the results from `listInvoices`?" },
  { id: "n-en-09", lang: "en", source: "fresh", category: "order-sense", map: false, flow: false, text: "Which handler runs when a purchase order is approved?" },
  { id: "n-en-10", lang: "en", source: "fresh", category: "order-sense", map: true, flow: false, text: "Short summary of the orders table: which columns are indexed?" },
  { id: "n-en-11", lang: "en", source: "fresh", category: "order-sense", map: false, flow: false, text: "What's the maximum order quantity a customer can place?" },
  { id: "n-en-12", lang: "en", source: "fresh", category: "order-sense", map: false, flow: false, text: "Who calls `cancelOrder`, and what order status does it set?" },
  { id: "n-en-13", lang: "en", source: "fresh", category: "order-sense", map: false, flow: false, text: "Is the orders table partitioned by order date?" },
  { id: "n-en-14", lang: "en", source: "fresh", category: "order-sense", map: false, flow: false, text: "What order types does `ExchangeClient` support?" },
  { id: "n-en-15", lang: "en", source: "fresh", category: "order-sense", map: false, flow: false, text: "What does the `order` parameter of `listUsers` accept?" },
  { id: "n-en-16", lang: "en", source: "fresh", category: "order-sense", map: false, flow: false, text: "In which order are the columns defined in the orders migration?" },
  { id: "n-en-17", lang: "en", source: "fresh", category: "order-sense", map: false, flow: false, text: "Which order does `findLatest` return, newest first?" },
  { id: "n-en-18", lang: "en", source: "fresh", category: "order-modifier", map: false, flow: false, text: "How does the order handler call `PaymentGateway.charge` when the order total is zero?" },
  { id: "n-en-19", lang: "en", source: "fresh", category: "order-modifier", map: false, flow: false, text: "What does `OrderClient` call when the order is not found?" },
  { id: "n-en-20", lang: "en", source: "fresh", category: "order-modifier", map: false, flow: false, text: "Which order service endpoints does the mobile client call on startup?" },
  { id: "n-en-21", lang: "en", source: "fresh", category: "order-modifier", map: true, flow: false, text: "Quick overview of how `OrderRepository` runs its queries - which order table does it hit?" },
  { id: "n-en-22", lang: "en", source: "fresh", category: "order-modifier", map: false, flow: false, text: "Which order does `Reconciler` call `refund` for when a payment is split?" },
  { id: "n-en-23", lang: "en", source: "fresh", category: "order-modifier", map: false, flow: false, text: "Run the order import first, then the product import." },

  // --- negatives: change requests that mention an order of calls ---
  { id: "n-en-24", lang: "en", source: "fresh", category: "change", map: false, flow: false, text: "Move the order validation into its own class and keep the call order the same." },
  { id: "n-en-25", lang: "en", source: "fresh", category: "change", map: false, flow: false, text: "Implement retries in `HttpClient` in the order: backoff, jitter, give-up." },
  { id: "n-en-26", lang: "en", source: "fresh", category: "change", map: false, flow: false, text: "Change `CheckoutService` so it calls tax before pricing." },
  { id: "n-en-27", lang: "en", source: "fresh", category: "change", map: false, flow: false, text: "Reorder the calls in `submit()` so inventory runs before payment." },
  { id: "n-en-28", lang: "en", source: "fresh", category: "change", map: false, flow: false, text: "Please update `ImportJob` so that it runs validate first and then parse, in that order." },
  { id: "n-en-29", lang: "en", source: "fresh", category: "change", map: false, flow: false, text: "Add a summary line to the log in `ReportJob` after each step runs." },
  { id: "n-en-30", lang: "en", source: "fresh", category: "change", map: true, flow: false, text: "Run the tests first, then summarize `BillingEngine` for me." },
  { id: "n-en-31", lang: "en", source: "fresh", category: "change", map: false, flow: false, text: "Rename `callOrder` to `invocationOrder` across the module." },

  // --- negatives: "short" / "quick" / "summary" / "overview" / "brief" / "map" / "step" / "flow" / "tldr" in other senses ---
  { id: "s-en-01", lang: "en", source: "fresh", category: "short-sense", map: false, flow: false, text: "Why does the short-circuit evaluation in `isEligible` skip the second check?" },
  { id: "s-en-02", lang: "en", source: "fresh", category: "short-sense", map: false, flow: false, text: "Where is the shortcut key for 'save' registered?" },
  { id: "s-en-03", lang: "en", source: "fresh", category: "short-sense", map: false, flow: false, text: "Is the token in `SessionStore` short-lived or persisted across restarts?" },
  { id: "s-en-04", lang: "en", source: "fresh", category: "short-sense", map: false, flow: false, text: "Why is `short` used for the port number in `NetConfig` instead of `int`?" },
  { id: "s-en-05", lang: "en", source: "fresh", category: "short-sense", map: false, flow: false, text: "Does `CapacityPlanner` log a warning when threads are in short supply?" },
  { id: "s-en-06", lang: "en", source: "fresh", category: "quick-sense", map: false, flow: false, text: "Is there a quick fix for the flaky test in `UploadManagerTest`?" },
  { id: "s-en-07", lang: "en", source: "fresh", category: "quick-sense", map: false, flow: false, text: "Add a quick fix for the null check in `parseHeader`." },
  { id: "s-en-08", lang: "en", source: "fresh", category: "quick-sense", map: false, flow: false, text: "Why is `quickSort` slower than `mergeSort` on sorted input in `Sorter`?" },
  { id: "s-en-09", lang: "en", source: "fresh", category: "quick-sense", map: false, flow: false, text: "How quickly does `RateLimiter` refill tokens after a burst?" },
  { id: "s-en-10", lang: "en", source: "fresh", category: "quick-sense", map: false, flow: false, text: "Does the retry in `HttpClient` back off quickly enough?" },
  { id: "s-en-11", lang: "en", source: "fresh", category: "short-sense", map: false, flow: false, text: "Shorten the timeout in `HttpClient` to 5 seconds." },
  { id: "s-en-12", lang: "en", source: "fresh", category: "short-sense", map: false, flow: false, text: "What's the shortest path algorithm used in `RouteFinder`?" },
  { id: "s-en-13", lang: "en", source: "fresh", category: "short-sense", map: false, flow: false, text: "Where is the `ShortUrl` model defined?" },
  { id: "s-en-14", lang: "en", source: "fresh", category: "short-sense", map: false, flow: false, text: "Make the log messages shorter in `AuditTrail`." },
  { id: "s-en-15", lang: "en", source: "fresh", category: "code-name", map: false, flow: false, text: "Why is the summary field null in `ReportRow`?" },
  { id: "s-en-16", lang: "en", source: "fresh", category: "code-name", map: false, flow: false, text: "Show me the usages of `summary.total` in the report builder." },
  { id: "s-en-17", lang: "en", source: "fresh", category: "code-name", map: false, flow: false, text: "Where is the `Overview` component imported in the dashboard?" },
  { id: "s-en-18", lang: "en", source: "fresh", category: "code-name", map: false, flow: false, text: "What does `summaryRow` hold in `ReportTable`?" },
  { id: "s-en-19", lang: "en", source: "fresh", category: "code-name", map: false, flow: false, text: "Where is the `HashMap` populated in `SessionCache`?" },
  { id: "s-en-20", lang: "en", source: "fresh", category: "code-name", map: false, flow: false, text: "How does `map()` transform the stream in `EventPipeline`?" },
  { id: "s-en-21", lang: "en", source: "fresh", category: "code-name", map: false, flow: false, text: "Where is `step()` called in the training loop of `Trainer`?" },
  { id: "s-en-22", lang: "en", source: "fresh", category: "code-name", map: false, flow: false, text: "Which classes implement `Flow<T>`?" },
  { id: "s-en-23", lang: "en", source: "fresh", category: "code-name", map: false, flow: false, text: "Where is the `flow` variable reassigned in `ControlGraph`?" },
  { id: "s-en-24", lang: "en", source: "fresh", category: "code-name", map: false, flow: false, text: "Where is the `tldr` command registered in the CLI?" },
  { id: "s-en-25", lang: "en", source: "fresh", category: "code-name", map: false, flow: false, text: "What does the `brief` flag do in `ReportCli`?" },
  { id: "s-en-26", lang: "en", source: "fresh", category: "short-sense", map: false, flow: false, text: "Where is the design brief for the new checkout stored in docs/?" },

  // --- negatives, JA ---
  { id: "n-ja-01", lang: "ja", source: "fresh", category: "order-sense", map: false, flow: false, text: "注文の順番を入れ替える API はどこ？" },
  { id: "n-ja-02", lang: "ja", source: "fresh", category: "order-sense", map: false, flow: false, text: "順番待ちのキューは何件まで保持できますか？" },
  { id: "n-ja-03", lang: "ja", source: "fresh", category: "order-sense", map: true, flow: false, text: "注文テーブルのスキーマを簡単に教えて。" },
  { id: "n-ja-04", lang: "ja", source: "fresh", category: "order-sense", map: false, flow: false, text: "注文が表示される順番が入れ替わるのはなぜ？" },
  { id: "n-ja-05", lang: "ja", source: "fresh", category: "order-sense", map: false, flow: false, text: "発注処理を呼び出している箇所はどこですか？" },
  { id: "n-ja-06", lang: "ja", source: "fresh", category: "order-sense", map: false, flow: false, text: "並び順を変更するにはどうすればいい？" },
  { id: "n-ja-07", lang: "ja", source: "fresh", category: "ease", map: false, flow: false, text: "`parseHeader` の null チェックの不具合、簡単に直せますか？" },
  { id: "n-ja-08", lang: "ja", source: "fresh", category: "ease", map: false, flow: false, text: "このバグ、簡単に再現できる？" },
  { id: "n-ja-09", lang: "ja", source: "fresh", category: "ease", map: false, flow: false, text: "簡単にできる方法はある？ `UploadManager` のリトライを無効にしたい。" },
  { id: "n-ja-10", lang: "ja", source: "fresh", category: "bulk", map: false, flow: false, text: "ファイルをまとめて削除する API はどこにある？" },
  { id: "n-ja-11", lang: "ja", source: "fresh", category: "bulk", map: false, flow: false, text: "複数のジョブをまとめて実行する処理を `JobScheduler` に追加して。" },
  { id: "n-ja-12", lang: "ja", source: "fresh", category: "short-sense", map: false, flow: false, text: "タイムアウトを短くしたい。`HttpClient` のどこを変えればいい？" },
  { id: "n-ja-13", lang: "ja", source: "fresh", category: "short-sense", map: false, flow: false, text: "ショートカットキーの登録処理はどこ？" },
  { id: "n-ja-14", lang: "ja", source: "fresh", category: "short-sense", map: false, flow: false, text: "有効期間が短いトークンの発行処理はどこ？" },
  { id: "n-ja-15", lang: "ja", source: "fresh", category: "code-name", map: false, flow: false, text: "サマリー画面のレイアウトを変更して。" },
  { id: "n-ja-16", lang: "ja", source: "fresh", category: "code-name", map: false, flow: false, text: "Overview 画面はどこで定義されている？" },
  { id: "n-ja-17", lang: "ja", source: "fresh", category: "code-name", map: false, flow: false, text: "概要欄の文字数上限はいくつ？" },
  { id: "n-ja-18", lang: "ja", source: "fresh", category: "change", map: false, flow: false, text: "注文の処理順を変更したい。" },
  { id: "n-ja-19", lang: "ja", source: "fresh", category: "order-sense", map: false, flow: false, text: "ユーザーを登録順に並べるクエリはどこ？" },
  { id: "n-ja-20", lang: "ja", source: "fresh", category: "change", map: false, flow: false, text: "バッチ処理を短くまとめて書き直して。" },
  { id: "n-ja-21", lang: "ja", source: "fresh", category: "order-sense", map: false, flow: false, text: "バックアップを実行する順番待ちの仕組みは？" },
  { id: "n-ja-22", lang: "ja", source: "fresh", category: "order-sense", map: false, flow: false, text: "処理待ちのジョブ数を取得する API は？" },
  { id: "n-ja-23", lang: "ja", source: "fresh", category: "bulk", map: false, flow: false, text: "呼び出し元の一覧をまとめて出力するスクリプトを作って。" },
  { id: "n-ja-24", lang: "ja", source: "fresh", category: "change", map: false, flow: false, text: "`callOrder` という変数名を `invocationOrder` に変えて。" },
];
