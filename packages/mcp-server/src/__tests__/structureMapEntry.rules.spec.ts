/**
 * structureMapEntry.rules.spec.ts — the structure map's ENTRY vocabulary, rule by
 * rule (2026-10-24). structureMapEntry.heldout{1,2}.spec.ts and
 * requestFacets.heldout{8,9}.spec.ts score the two detectors on hundreds of
 * requests; THIS spec pins the exact request of every rule family and of every
 * trap found while writing them, so a regression names its rule.
 *
 * Two detectors, one entry: the map is served only to a request that
 * `asksForStructureMap` (structureMap.ts: brevity words about the size of the
 * answer, none of their other senses, none negated) AND that has a `flow` facet
 * (requestFacets.ts `isCallOrderClause` / FLOW_JA_RE: the order of calls anchored
 * to a call or execution verb or noun, never to the bare word "order" / 順番).
 */
import { describe, expect, it } from "vitest";

import { extractFacetRequirements } from "../features/task-pack/requestFacets.js";
import { asksForStructureMap } from "../features/task-pack/structureMap.js";

const hasFlow = (query: string): boolean => extractFacetRequirements(query).some((requirement) => requirement.facet === "flow");

describe("asksForStructureMap — brevity words about the size of the answer", () => {
  it.each([
    // a size adjective on an answer noun
    "Short version of what `ImportJob` does, please.",
    "Quick rundown of the `ReportGenerator` class.",
    "Give me a brief description of `InvoiceMailer`.",
    "A one-line description of `PluginHost`.",
    "Give me the 30-second version of `AssetLoader`.",
    "A compact overview of the `InvoiceBatch` class.",
    "A rough sketch of `SceneGraph`, please.",
    "A succinct explanation of `WebhookRelay` would be great.",
    // an instruction about the answer
    "Keep it short.",
    "What does `Scheduler` do? Keep the answer brief.",
    "Please be brief and tell me what `BillingEngine` does.",
    "Explain `Router` as short as possible.",
    "Short and sweet: what does `Scheduler` do?",
    // brevity words by themselves
    "TL;DR of what `OrderOrchestrator` does.",
    "tldr: what does `UserRepository` do?",
    "Explain `SessionStore` in a nutshell.",
    "Describe `RequestRouter` at a glance.",
    "Give me the gist of `ThemeProvider`.",
    "Give me the cliff notes on `CacheInvalidator`.",
    "Explain `JobScheduler` in a few lines.",
    "Explain `TokenBucket` in two sentences.",
    "What does `TokenBucket` do, in a sentence?",
    "Explain `SessionStore` in short",
    "In short, what does `SessionStore` do?",
    "In short - what does `SessionStore` do?",
    "Without going into detail: what is `CacheWarmer` for?",
    "Skip the details: what does `Parser` do?",
    "Don't go too deep - I just need to know what `PaymentRetrier` does.",
    "Just the highlights of `Compiler`, please.",
    "Quickly summarize `Compiler`.",
    "Explain `Compiler` quickly.",
    "Walk me through `DeployPipeline` quickly.",
    "Why not a short summary of `QueueDrainer`?",
    "Do not modify files and give me a short overview of `Foo`.",
    // JA
    "OrderOrchestrator をざっと説明して。",
    "SessionManager をさらっと説明して。",
    "SessionManager をサクッと教えて。",
    "PayrollRun を手早く説明して。",
    "ReplicaSync の仕組みを短めに。",
    "WebhookRelay の概略を教えて。",
    "LevelStreamer について、要点だけ。",
    "OrderSaga を端的に説明して。",
    "TaskDispatcher を一言で言うと何？",
    "TaskDispatcher を一言でいうと何？",
    "NotificationCenter の動きを3行でまとめて。",
    "ClaimProcessor を30行で。",
    "ReportGenerator を簡単に説明して。",
    "OrderOrchestrator について簡単に。",
    "Router のことを簡単に教えて。",
    "Router を簡単にいうと何？",
    "Router を簡単にご紹介ください。",
    "Router を軽く説明して。",
    "OrderOrchestrator の処理の流れを、payment / inventory / shipping を中心にまとめて。",
    "Router の動きをまとめてください。",
    "CrashReporter をコンパクトに説明して。",
    "Scheduler のポイントだけ教えて。",
    "AudioMixer のアウトラインをお願いします。",
    "InvoiceMailer の動きをダイジェストで。",
  ])("map-shaped: %s", (query) => {
    expect(asksForStructureMap(query)).toBe(true);
  });

  it.each([
    // "short" / "quick" / "brief" / "tl;dr" in another sense
    "Why does the short-circuit evaluation in `isEligible` skip the second check?",
    "Where is the shortcut key for 'save' registered?",
    "Is the token in `SessionStore` short-lived or persisted across restarts?",
    "Why is `short` used for the port number in `NetConfig` instead of `int`?",
    "Does `CapacityPlanner` log a warning when threads are in short supply?",
    "The cache sends data in short bursts.",
    "Why does the loop treat a short read as EOF?",
    "Is there a quick fix for the flaky test in `UploadManagerTest`?",
    "Why is `quickSort` slower than `mergeSort` on sorted input?",
    "How quickly does `RateLimiter` refill tokens after a burst?",
    "Walk me through how the cache quickly refreshes.",
    "Shorten the timeout in `HttpClient` to 5 seconds.",
    "What's the shortest path algorithm used in `RouteFinder`?",
    "Where is the `ShortUrl` model defined?",
    "What does the `brief` flag do in `ReportCli`?",
    "Where is the design brief for the new checkout stored in docs/?",
    "Why must the key be short?",
    "Can this be done in a few lines of code?",
    "Open a gist with the failing test.",
    "Add a cheat code to skip the tutorial in `GameState`.",
    "Where is the tldr command registered in the CLI?",
    "Is the quick-start guide in `docs/` still accurate?",
    "Does `Shortlist` get rebuilt when a candidate is added?",
    // a name that carries a brevity word
    "Why is the summary field null in `ReportRow`?",
    "Show me the usages of `summary.total` in the report builder.",
    "Where is `summarize()` called?",
    "Where is the `Overview` component imported in the dashboard?",
    "What does the `overview` prop on `Tabs` control?",
    "Where is summary.json written?",
    "Why is the heatmap colour scale wrong in `Dashboard`?",
    "Which module defines the `Map<String, List<Order>>` used in `Index`?",
    // JA: ease, "all at once", "shorten", "roughly", a name
    "`parseHeader` の null チェックの不具合、簡単に直せますか？",
    "このバグ、簡単に再現できる？",
    "簡単にはいかないと思うけど、詳しく知りたい。",
    "簡単に説明されているドキュメントはどこ？",
    "ファイルをまとめて削除する API はどこにある？",
    "複数のジョブをまとめて実行する処理を追加して。",
    "ファイルを両方まとめて教えて。",
    "HTTPie に独立した小さな改善を3件まとめてお願いします。",
    "タイムアウトを短くしたい。`HttpClient` のどこを変えればいい？",
    "ざっと見た感じ、`ShardRouter` は何行くらいありますか？",
    "Dは30〜113行である",
    "この処理は一行で書かれている。",
    "概要欄に入力できる最大文字数は？",
    "要約テーブルを更新するバッチはどこ？",
    "要点をまとめたドキュメントを更新して。",
    "Overview 画面はどこで定義されている？",
    "地図タイルのキャッシュ戦略を教えて。",
    "ポイント還元の計算式はどこ？",
    "短縮URLを生成する処理はどこですか？",
    "ショートカット機能の実装場所は？",
  ])("not map-shaped: %s", (query) => {
    expect(asksForStructureMap(query)).toBe(false);
  });

  it.each([
    // a NEGATED brevity word asks for the opposite
    "Don't summarize - go through `GatewayRouter` line by line.",
    "Please don't give me a summary of `SnapshotWriter` - walk through it in detail.",
    "Not just a summary: I need the full flow of `PluginHost`.",
    "Not a quick overview: a thorough explanation of `ShardRouter`, please.",
    "Rather than a high-level outline, give me the full call order inside `PluginHost`.",
    "Without a summary, walk me through `Compiler`.",
    "要約せずに、GatewayRouter がハンドラを実行する順序を一行ずつ追って。",
    "概要ではなく、PluginHost の詳細を教えて。",
    "簡潔にせず、DeltaEncoder を全部説明して。",
    "要約は不要です。Compiler を詳しく説明して。",
  ])("negated, so not map-shaped: %s", (query) => {
    expect(asksForStructureMap(query)).toBe(false);
  });

  it.each([
    // a negation of something ELSE, or too far away to reach it, leaves the brevity word standing
    "No code changes. Give me a brief overview of `Foo`.",
    "Don't edit anything and just give me a quick overview of `Foo`.",
    "No worries - a quick overview of `Foo` please.",
    "No problem give me a quick overview of `Foo`.",
    "Without changing anything, give me a brief overview of `Foo`.",
    "Why not give me a quick overview of `Foo`?",
    "コード変更は不要。Foo をざっと説明して。",
  ])("a negation that does not reach it: %s", (query) => {
    expect(asksForStructureMap(query)).toBe(true);
  });
});

describe("the flow facet — the ORDER OF CALLS, anchored to a call or execution word", () => {
  it.each([
    // "the order it calls …", "the order in which …", one adjective, "the order its steps run in"
    "Give me a quick overview of `OrderOrchestrator` and the order it calls payment / inventory / shipping in.",
    "I just need the big picture of `ReplicaSync` and the order in which it invokes snapshot, ship and apply.",
    "Quick overview of `ShardRouter`, and the precise order it calls lookup, route and fallback.",
    "TL;DR of `PluginHost` including the actual order its plugins get called in.",
    "Give me a compact overview of the `InvoiceBatch` class and the order its steps run in.",
    "Walk me through every step `CampaignSender` takes, and the exact order it calls the segment, template and delivery services.",
    // "what order does …", "in which order …", also after a cut at "and" / ","
    "Explain the `OrderOrchestrator` class briefly: what order does it call payment / inventory / shipping in?",
    "Short explanation of `OrderOrchestrator` please, and in which order it calls payment / inventory / shipping.",
    "Explain in detail how `CheckoutService` calls pricing, tax and payment, and in which order.",
    "Walk me through `DeployPipeline` - in which order do build, test and publish get invoked?",
    "In which order does `ImportJob` call parse, validate and write?",
    "What order should I call the setup functions in?",
    "Which order do I call the setup functions in?",
    // compound nouns
    "Briefly, what is the call order of `FulfillmentService`?",
    "What is the plugin load order?",
    "What is the shutdown order of the services?",
    "What's the invocation order of the middleware in `ServerPipeline`?",
    "Give me the call sequence during an incremental build.",
    "Explain OrderOrchestrator's state transition table and payment, inventory, and shipping call order.",
    // "the sequence of … calls"
    "TL;DR of what `OrderOrchestrator` does and the sequence of payment / inventory / shipping calls.",
    // an ordinal after a run / execute verb, and after do-support
    "Describe `OrderOrchestrator` at a glance; which of payment / inventory / shipping runs first?",
    "Quick rundown of the `ReportGenerator` class - what gets called first, and what comes after?",
    "Which one is called first in `RequestRouter`, `authenticate` or `rateLimit`?",
    "Which does `Mailer` call first, the renderer or the client?",
    "What does `Pipeline` run next?",
    // "when … get called", "what happens first"
    "High-level map of `OrderOrchestrator`, focusing on when payment / inventory / shipping get called.",
    "Trace `Parser`: what happens first, and what happens next?",
    // JA
    "OrderOrchestrator の概要と、payment / inventory / shipping を呼ぶ順番を教えて。",
    "ReportGenerator を簡単に説明して。fetch / aggregate / render を呼び出す順番も知りたい。",
    "AuthGateway の概略と、token / session / audit の各サービスを呼び出す順番を教えてください。",
    "WorkflowEngine を俯瞰して教えて。build → test → publish の処理の順番が知りたい。",
    "ArtifactUploader の sign / chunk / commit を叩く順番も教えて。",
    "AudioMixer のステージを実行する順序をお願いします。",
    "ClaimProcessor の検証・審査・支払いを呼び出す順序も含めて。",
    "FulfillmentService の PaymentGateway、InventoryClient、ShippingClient の呼び出し順は？",
    "LevelStreamer のローダーが呼ばれる順番はどうなってる？",
    "ReplicaSync の snapshot, ship, apply が走る順番だけ知りたいです。",
    "MigrationRunner の up と down のフックはどんな順番で呼ばれる？",
    "OrderOrchestrator が payment / inventory / shipping をどういう流れで呼ぶのか教えて。",
    "JobScheduler の enqueue / lock / dispatch のうち最初に実行されるのはどれ？",
    "RequestRouter では authenticate と rateLimit はどちらが先に呼ばれる？",
    "payment と inventory はどちらを先に呼んでいる？",
  ])("a flow facet: %s", (query) => {
    expect(hasFlow(query)).toBe(true);
  });

  it.each([
    // "order" as a noun of the business, a sort or a queue
    "What are the possible order statuses in `OrderStatus`?",
    "Where do we call the payment API when an order is cancelled?",
    "How does the order service call the inventory service?",
    "How does the order handler call `PaymentGateway.charge` when the order total is zero?",
    "In order to understand `CheckoutService`, which file should I start with?",
    "Why does the ordered list in `renderChangelog` start at 0?",
    "Which handler runs when a purchase order is approved?",
    "What order types does `ExchangeClient` support?",
    "Who calls `cancelOrder`, and what order status does it set?",
    "In which order are the columns defined in the orders migration?",
    "Which order does `findLatest` return, newest first?",
    "Which order does `Reconciler` call `refund` for when a payment is split?",
    "Which orders does `ReportJob` call `archive` on after a purchase order is closed?",
    "Run the order import first, then the product import.",
    // "run before" / "called after" are no ordinal; a step list is no call order
    "Which checks does Desk.Submit run before it stores an order, and which errors can they return?",
    "A sequence of steps to reproduce the crash is attached.",
    "wire the new sensor callback into the boot sequence",
    // "registration order" is the order things were registered in, not an order of calls
    "libuv uv_timer_t same timeout notification order not registration order bug",
    // the caller, not the order
    "Which function calls `process` first?",
    "When does `process` get called?",
    // a change request
    "Reorder the calls in `submit()` so inventory runs before payment.",
    "Implement retries in `HttpClient` in the order: backoff, jitter, give-up.",
    "Change `CheckoutService` so it calls tax before pricing.",
    "Rename `callOrder` to `invocationOrder` across the module.",
    // JA
    "注文の順番を入れ替える API はどこ？",
    "順番待ちのキューは何件まで保持できますか？",
    "バックアップを実行する順番待ちの仕組みは？",
    "処理待ちのジョブ数を取得する API は？",
    "並び順を変更するにはどうすればいい？",
    "注文が表示される順番が入れ替わるのはなぜ？",
    "オーダーの優先順位はどこで決まりますか？",
    "`Bootstrapper` が config を先に呼ぶように変更して。",
    "実行順序を入れ替えるリファクタリングをお願いします。",
    "refund はキャンセル後に呼び出される。",
    "先に実行してください。",
    "どんな順番で表示されますか？",
  ])("no flow facet: %s", (query) => {
    expect(hasFlow(query)).toBe(false);
  });
});

describe("the flow facet — subject terms: the scaffolding of an order phrasing is no point of the flow", () => {
  it("blanks 'the order it calls …' / 'in which order' / 'the exact order' from the terms, keeping the named concerns", () => {
    const flows = extractFacetRequirements("Give me a quick overview of OrderOrchestrator and the exact order it calls payment / inventory / shipping in.")
      .filter((requirement) => requirement.facet === "flow");
    expect(flows.length).toBeGreaterThan(0);
    for (const flow of flows) {
      expect(flow.subjectTerms).not.toContain("order");
      expect(flow.subjectTerms).not.toContain("exact");
      expect(flow.subjectTerms).not.toContain("call");
      expect(flow.subjectTerms).toEqual(expect.arrayContaining(["payment", "inventory", "shipping"]));
    }
    const tail = extractFacetRequirements("Explain in detail how CheckoutService calls pricing, tax and payment, and in which order.")
      .filter((requirement) => requirement.facet === "flow");
    expect(tail.length).toBeGreaterThan(0);
    for (const flow of tail) expect(flow.subjectTerms).not.toContain("order");
  });

  it("changes nothing for a clause the order phrasing did not fire in: 'the order that was placed' keeps every word", () => {
    const flows = extractFacetRequirements("Where is the order that was placed stored, and in what order are the columns defined?");
    const terms = flows.flatMap((requirement) => requirement.subjectTerms);
    expect(terms).toContain("order");
  });
});
