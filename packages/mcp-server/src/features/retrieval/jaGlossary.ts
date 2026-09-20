// jaGlossary.ts — general software/business Japanese vocabulary -> English
// stems, for jaQueryBridge.ts's longest-match glossary scan (TL_JA_QUERY_BRIDGE;
// (S) supported first-pack policy, default ON since 2026-09-19 (USER ruling);
// explicit `=0` is the rollback path).
//
// USER STANDING RULE (no bench overfitting): every entry below was written
// from general Japanese software/business vocabulary knowledge BEFORE any
// eval query, fixture, task id or file name in this repository was
// consulted. Nothing here was reverse-engineered from bench/fixtures/ or
// from packages/mcp-server/src/__tests__/firstPackPrecisionEval.spec.ts.
// If a future editor is tempted to add a term because it appears in an eval
// query or a fixture, don't — add it only if it is independently common
// software/business vocabulary.
//
// Shape: [term, stems]. `term` is usually kanji/kana; `stems` are lowercase
// ASCII word stems (1-4 per entry); jaQueryBridge.ts only emits a stem when
// it (or a word it prefixes, min stem length 4) is actually present in the
// workspace vocabulary — see its own doc comment.
//
// A general katakana LOANWORD (a word borrowed whole from English, whose
// meaning IS the transliteration) is normally handled by
// jaQueryBridge.ts's phonetic bridge (jaPhonetic.ts), not here — that path
// generalizes to any workspace vocabulary word without needing an entry
// per word. The SHORT-KATAKANA section below is the deliberate exception
// (orchestrator Phase 2, 2026-09-19): a 2-3-mora loanword (エラー, キー,
// コード, ...) reduces to only 1-2 consonant classes, which the phonetic
// bridge's own design refuses to trust on its own (a 1-class key is never
// accepted; a 2-class key is accepted only when exactly one vocabulary
// word matches it — far too fragile for words this short and this common).
// Listing them directly, keyed by their exact katakana spelling, gives
// jaQueryBridge.ts's SAME longest-match scan (and, for a run like
// エラーコード, its compound segmentation) a reliable exact answer instead
// of an unreliable guess. These entries are plain, standard, dictionary-
// level Japanese loanwords chosen from general knowledge — see the
// standing rule above; none were added because of anything observed in an
// eval run.
//
// Longest-match scan order is handled by the caller (jaQueryBridge.ts
// sorts this table by descending term length once at module load); entries
// here are grouped by theme for maintainability only, not by length.
export const JA_GLOSSARY: ReadonlyArray<readonly [string, readonly string[]]> = [
  // Commerce / orders
  ["注文", ["order"]],
  ["発注", ["order", "purchase"]],
  ["仕入", ["purchase", "procurement"]],
  ["支払", ["payment", "pay"]],
  ["決済", ["payment", "checkout", "settle"]],
  ["返金", ["refund"]],
  ["在庫", ["inventory", "stock"]],
  ["在庫切れ", ["stockout"]],
  ["欠品", ["stockout", "shortage"]],
  ["補充", ["replenish", "restock"]],
  ["棚卸", ["inventory", "stocktake"]],
  ["納品", ["delivery", "deliver"]],
  ["検品", ["inspect", "inspection"]],
  ["返品", ["return"]],
  ["交換", ["exchange"]],
  ["取消", ["cancel"]],
  ["中止", ["cancel", "abort"]],
  ["割引", ["discount"]],
  ["割戻", ["rebate"]],
  ["特典", ["benefit", "perk"]],
  ["商品", ["product", "item"]],
  ["価格", ["price"]],
  ["見積", ["estimate", "quote"]],
  ["請求", ["invoice", "billing", "charge"]],
  ["請求書", ["invoice"]],
  ["領収書", ["receipt"]],
  ["元帳", ["ledger"]],
  ["仕訳", ["journal"]],
  ["残高", ["balance"]],
  ["顧客", ["customer", "client"]],
  ["会員", ["member"]],
  ["配送", ["shipping", "delivery"]],
  ["発送", ["ship", "dispatch"]],
  ["出荷", ["shipment", "ship"]],
  ["配達", ["delivery"]],
  ["配車", ["dispatch"]],
  ["経路", ["route"]],
  ["賞味期限", ["expiry", "expire"]],
  ["消費期限", ["expiry", "expire"]],
  ["有効期限", ["expiry", "expire", "validity"]],
  ["期限", ["expiry", "expire", "deadline"]],
  ["税金", ["tax"]],
  ["消費税", ["tax"]],
  ["手数料", ["fee"]],
  ["通貨", ["currency"]],
  ["為替", ["exchange", "rate"]],

  // Accounts / auth / permissions
  ["予約", ["reservation", "reserve", "booking"]],
  ["認証", ["auth", "login", "authenticate"]],
  ["認可", ["authorize", "permission"]],
  ["権限", ["permission", "role"]],
  ["権限管理", ["permission", "role"]],
  ["役割", ["role"]],
  ["登録", ["register", "signup"]],
  ["入会", ["join", "signup"]],
  ["招待", ["invite", "invitation"]],
  ["参加", ["join"]],
  ["退会", ["leave", "unsubscribe", "withdraw"]],
  ["解約", ["cancel", "unsubscribe", "terminate"]],
  ["利用者", ["user"]],
  ["管理者", ["admin", "administrator"]],
  ["運営者", ["operator"]],
  ["所有者", ["owner"]],
  ["担当者", ["assignee", "owner"]],
  ["作成者", ["author", "creator"]],
  ["更新者", ["editor", "updater"]],
  ["編集者", ["editor"]],
  ["閲覧", ["view", "browse"]],
  ["承認", ["approve", "approval"]],
  ["拒否", ["reject", "deny"]],
  ["確認", ["confirm", "confirmation"]],
  ["承諾", ["accept", "agree"]],
  ["同意", ["consent", "agree"]],
  ["規約", ["terms", "agreement"]],
  ["契約", ["contract"]],
  ["請負", ["contract"]],

  // Config / state / lifecycle
  ["設定", ["config", "setting", "preference"]],
  ["言語", ["language", "locale"]],
  ["状態", ["state", "status"]],
  ["遷移", ["transition"]],
  ["有効", ["valid", "enable"]],
  ["無効", ["invalid", "disable"]],
  ["有効化", ["enable", "activate"]],
  ["無効化", ["disable", "invalidate"]],
  ["初期化", ["initialize", "init"]],
  ["終了", ["exit", "terminate", "finish"]],
  ["起動", ["start", "launch", "boot"]],
  ["停止", ["stop", "halt"]],
  ["再起動", ["restart", "reboot"]],
  ["稼働", ["operate", "uptime"]],
  ["停電", ["outage"]],
  ["障害", ["failure", "outage"]],
  ["復旧", ["recover", "restore"]],
  ["復元", ["restore", "recover"]],
  ["待機", ["wait", "pending"]],
  ["完了", ["complete", "done", "finish"]],
  ["失敗", ["fail", "failure"]],
  ["成功", ["success"]],

  // CRUD / data ops
  ["削除", ["delete", "remove"]],
  ["更新", ["update"]],
  ["取得", ["get", "fetch"]],
  ["保存", ["save", "store"]],
  ["検索", ["search", "find"]],
  ["一覧", ["list"]],
  ["送信", ["send"]],
  ["受信", ["receive"]],
  ["同期", ["sync"]],
  ["作成", ["create"]],
  ["編集", ["edit"]],
  ["複製", ["copy", "clone", "duplicate"]],
  ["移動", ["move"]],
  ["共有", ["share"]],
  ["公開", ["publish"]],
  ["非公開", ["private"]],
  ["下書き", ["draft"]],
  ["草稿", ["draft"]],
  ["提出", ["submit"]],
  ["変換", ["convert", "transform"]],
  ["換算", ["convert"]],
  ["生成", ["generate"]],
  ["入力", ["input"]],
  ["出力", ["output"]],
  ["表示", ["display", "show"]],
  ["非表示", ["hide"]],
  ["選択", ["select", "choose"]],
  ["選択肢", ["option", "choice"]],
  ["項目", ["item", "field"]],
  ["属性", ["attribute", "property"]],
  ["種別", ["type", "category"]],
  ["分類", ["category", "classify"]],
  ["階層", ["hierarchy", "tier"]],

  // Reliability / ops / security
  ["再送", ["retry", "resend"]],
  ["再試行", ["retry"]],
  ["再接続", ["reconnect"]],
  ["検証", ["validate", "verify"]],
  ["暗号", ["encrypt", "crypt"]],
  ["署名", ["sign", "signature"]],
  ["通知", ["notification", "notify"]],
  ["通信", ["communication", "connection"]],
  ["接続", ["connect", "connection"]],
  ["切断", ["disconnect"]],
  ["負荷", ["load"]],
  ["監視", ["monitor"]],
  ["警告", ["warning", "warn"]],
  ["異常", ["error", "anomaly", "abnormal"]],
  ["検知", ["detect"]],
  ["発見", ["discover", "find"]],
  ["通過", ["pass"]],
  ["合格", ["pass"]],
  ["不合格", ["fail"]],
  ["遅延", ["delay", "latency"]],
  ["速度", ["speed", "rate"]],
  ["容量", ["capacity"]],
  ["冗長", ["redundant", "redundancy"]],
  ["重複", ["duplicate"]],
  ["欠損", ["missing", "defect"]],
  ["不備", ["defect", "deficiency"]],
  ["不具合", ["bug", "defect"]],
  ["修正", ["fix"]],
  ["修復", ["repair", "fix"]],
  ["訂正", ["correct", "correction"]],
  ["補正", ["correct", "adjustment"]],
  ["調整", ["adjust", "tune"]],
  ["微調整", ["finetune", "tweak"]],
  ["整合性", ["consistency", "integrity"]],
  ["一貫性", ["consistency"]],
  ["競合", ["conflict", "race"]],
  ["衝突", ["collision", "conflict"]],
  ["排他", ["exclusive", "mutex"]],

  // Analysis / numbers / reporting
  ["分析", ["analyze", "analytics"]],
  ["集計", ["aggregate", "summary"]],
  ["統計", ["statistics", "stats"]],
  ["計算", ["calculate", "compute"]],
  ["評価", ["evaluate", "evaluation"]],
  ["採点", ["score", "grade"]],
  ["判定", ["judge", "determine"]],
  ["判断", ["judge", "decide"]],
  ["決定", ["decide", "decision"]],
  ["選定", ["select"]],
  ["比較", ["compare"]],
  ["検討", ["consider", "review"]],
  ["報告", ["report"]],
  ["通報", ["report"]],
  ["上限", ["limit", "cap", "max"]],
  ["下限", ["floor", "min"]],
  ["最大", ["max", "maximum"]],
  ["最小", ["min", "minimum"]],
  ["平均", ["average", "mean"]],
  ["合計", ["total", "sum"]],
  ["差分", ["diff", "delta"]],

  // Engineering process
  ["実装", ["implement", "implementation"]],
  ["仕様", ["spec", "specification"]],
  ["要件", ["requirement"]],
  ["設計", ["design"]],
  ["構築", ["build", "construct"]],
  ["構成", ["configuration", "config"]],
  ["依存", ["dependency", "depend"]],
  ["互換", ["compatible", "compatibility"]],
  ["拡張", ["extend", "extension"]],
  ["縮小", ["shrink", "reduce"]],
  ["最適化", ["optimize"]],
  ["高速化", ["speedup", "optimize"]],
  ["軽量化", ["lighten", "slim"]],
  ["簡略化", ["simplify"]],
  ["自動化", ["automate", "automation"]],
  ["自動", ["auto", "automatic"]],
  ["手動", ["manual"]],
  ["定期実行", ["scheduled", "cron"]],
  ["定期", ["periodic", "scheduled"]],
  ["繰り返し", ["repeat", "loop", "iterate"]],
  ["分岐", ["branch"]],
  ["条件分岐", ["branch", "conditional"]],
  ["統合", ["integrate", "merge"]],
  ["結合", ["join", "merge", "combine"]],
  ["分割", ["split", "partition"]],
  ["並列", ["parallel"]],
  ["並行", ["concurrent", "parallel"]],
  ["直列", ["serial", "sequential"]],
  ["例外", ["exception"]],

  // Org / people / misc business
  ["組織", ["organization"]],
  ["部署", ["department"]],
  ["拠点", ["location", "site"]],
  ["倉庫", ["warehouse"]],
  ["店舗", ["store", "shop"]],
  ["在宅", ["remote"]],
  ["出社", ["onsite"]],
  ["勤怠", ["attendance"]],
  ["給与", ["salary", "payroll"]],
  ["住所", ["address"]],
  ["氏名", ["name"]],
  ["電話番号", ["phone", "telephone"]],
  ["生年月日", ["birthdate"]],
  ["郵便番号", ["zipcode", "postalcode"]],
  ["性別", ["gender"]],
  ["年齢", ["age"]],
  ["国籍", ["nationality"]],
  ["退職", ["resign"]],

  // Short katakana loanwords (see the module doc's "SHORT-KATAKANA section"
  // note above for why these are listed directly rather than left to the
  // phonetic bridge). Standard, dictionary-level IT/business loanwords.
  ["エラー", ["error"]],
  ["キー", ["key"]],
  ["ユーザー", ["user"]],
  ["データ", ["data"]],
  ["ログ", ["log"]],
  ["コード", ["code"]],
  ["モード", ["mode"]],
  ["ノード", ["node"]],
  ["タグ", ["tag"]],
  ["ファイル", ["file"]],
  ["ページ", ["page"]],
  ["メール", ["mail", "email"]],
  ["カート", ["cart"]],
  ["アイテム", ["item"]],
  ["タイプ", ["type"]],
  ["テスト", ["test"]],
  ["ビルド", ["build"]],
  ["ルール", ["rule"]],
  ["ロール", ["role"]],
  ["パス", ["path", "pass"]],
  ["ポート", ["port"]],
  ["ホスト", ["host"]],
  ["ジョブ", ["job"]],
  ["タスク", ["task"]],
  ["キュー", ["queue"]],
  ["バグ", ["bug"]],
  ["フラグ", ["flag"]],
  ["サイズ", ["size"]],
  ["ビュー", ["view"]],
  ["リンク", ["link"]],
  ["ノート", ["note"]],
  ["メモ", ["memo"]],
  ["キャッシュ", ["cache"]],
  ["バッチ", ["batch"]],
  ["ボット", ["bot"]],
  ["ネット", ["net", "network"]],
  ["グループ", ["group"]],
  ["チーム", ["team"]],
  ["セット", ["set"]],
  ["ゲート", ["gate"]],
  ["キット", ["kit"]],
  ["コア", ["core"]],
  ["ゾーン", ["zone"]],
  ["レベル", ["level"]],
  ["モジュール", ["module"]],
  ["パッケージ", ["package"]],
  ["ライブラリ", ["library"]],
  ["レイヤー", ["layer"]],
  ["プラグイン", ["plugin"]],
  ["ウィジェット", ["widget"]],
  ["チャート", ["chart"]],
  ["グラフ", ["graph"]],
  ["ダッシュボード", ["dashboard"]],
  ["ウィンドウ", ["window"]],
  ["タブ", ["tab"]],
  ["フォーム", ["form"]],
  ["ボタン", ["button"]],
  ["アイコン", ["icon"]],
  ["メニュー", ["menu"]],
  ["ヘッダー", ["header"]],
  ["フッター", ["footer"]],
  ["スレッド", ["thread"]],
  ["プロセス", ["process"]],

  // ---------------------------------------------------------------------
  // Orchestrator Phase 4 (2026-09-19) coverage expansion: a systematic
  // category walk, general Japanese software/business vocabulary only —
  // written before consulting any repository, fixture, or eval file (same
  // standing rule as the module doc above). Some stems below coincide with
  // a cross-language programming keyword already in jaQueryBridge.ts's
  // COMMON_WORD_STOPLIST (e.g. "function", "default", "class") and will
  // simply never fire on their own; every such entry also carries at
  // least one non-stoplisted stem, so the entry still works.
  // ---------------------------------------------------------------------

  // CRUD / lifecycle verbs
  ["追加", ["add"]],
  ["除去", ["remove", "exclude"]],
  ["置換", ["replace"]],
  ["挿入", ["insert"]],
  ["抽出", ["extract"]],
  ["破棄", ["discard", "dispose"]],
  ["移行", ["migrate", "migration"]],
  ["一時停止", ["pause", "suspend"]],
  ["再開", ["resume"]],
  ["巻き戻し", ["rewind", "revert"]],

  // Authentication / authorization / accounts
  ["二段階認証", ["twofactor", "mfa"]],
  ["多要素認証", ["multifactor", "mfa"]],
  ["本人確認", ["identity", "verify"]],
  ["生体認証", ["biometric"]],
  ["資格情報", ["credential"]],
  ["権限昇格", ["escalation", "privilege"]],
  ["アクセス権", ["access"]],
  ["パスワード", ["password"]],
  ["ログアウト", ["logout"]],
  ["セキュリティ", ["security"]],
  ["アカウント", ["account"]],
  ["なりすまし", ["impersonation", "spoofing"]],

  // Payments / billing / pricing / tax
  ["前払い", ["prepaid", "prepayment"]],
  ["後払い", ["postpaid"]],
  ["分割払い", ["installment"]],
  ["定期購入", ["subscription"]],
  ["課金", ["billing", "charge"]],
  ["従量課金", ["usage"]],
  ["返済", ["repay", "repayment"]],
  ["借入", ["borrow", "loan"]],
  ["収益", ["revenue"]],
  ["損益", ["profit", "loss"]],
  ["原価", ["cost"]],
  ["利益", ["profit"]],
  ["送金", ["remit", "remittance"]],
  ["出金", ["withdraw", "withdrawal"]],
  ["入金", ["deposit"]],

  // Orders / carts / shipping / logistics / warehousing / replenishment
  ["配送先", ["destination"]],
  ["出庫", ["outbound"]],
  ["入庫", ["inbound", "receiving"]],
  ["積載", ["load", "loading"]],
  ["追跡", ["track", "tracking"]],
  ["集荷", ["pickup"]],
  ["荷物", ["package", "parcel"]],
  ["梱包", ["packaging", "pack"]],
  ["物流", ["logistics"]],
  ["引当", ["allocate", "allocation"]],

  // Inventory and catalogue
  ["品目", ["item"]],
  ["型", ["model"]],
  ["カタログ", ["catalog", "catalogue"]],
  ["バーコード", ["barcode"]],

  // Messaging / notification / email / SMS / push
  ["宛先", ["recipient", "destination"]],
  ["件名", ["subject"]],
  ["本文", ["body", "content"]],
  ["添付", ["attach", "attachment"]],
  ["既読", ["read", "seen"]],
  ["未読", ["unread"]],
  ["配信停止", ["unsubscribe"]],
  ["プッシュ", ["push"]],
  ["一斉送信", ["broadcast"]],

  // Scheduling / queues / jobs / retries / timeouts
  ["スケジュール", ["schedule"]],
  ["定刻", ["scheduled", "ontime"]],
  ["遅延実行", ["delayed"]],
  ["中断", ["interrupt", "abort"]],
  ["打ち切り", ["abort", "terminate"]],
  ["間隔", ["interval"]],
  ["待ち行列", ["queue"]],

  // Data processing (parse, convert, aggregate, filter, sort, validate, judge/evaluate/decide, calculate)
  ["解析", ["parse", "analyze"]],
  ["フィルタ", ["filter"]],
  ["ソート", ["sort"]],
  ["集約", ["aggregate"]],
  ["正規化", ["normalize", "normalization"]],
  ["算出", ["calculate", "compute"]],
  ["マッピング", ["mapping"]],

  // Configuration / features / flags / settings / environment
  ["環境", ["environment"]],
  ["本番環境", ["production"]],
  ["開発環境", ["development"]],
  ["検証環境", ["staging"]],
  ["機能", ["feature", "function"]],
  ["初期値", ["initial", "default"]],
  ["既定値", ["default", "preset"]],
  ["カスタマイズ", ["customize"]],

  // Errors / exceptions / logging / monitoring / tracking / tracing / metrics / analytics / reports
  ["監査", ["audit"]],
  ["トレース", ["trace"]],
  ["メトリクス", ["metrics"]],
  ["可観測性", ["observability"]],
  ["稼働率", ["uptime", "availability"]],
  ["アラート", ["alert"]],

  // UI / screens / forms / navigation
  ["画面", ["screen"]],
  ["入力欄", ["field"]],
  ["必須", ["required"]],
  ["任意", ["optional"]],
  ["ナビゲーション", ["navigation"]],
  ["パンくず", ["breadcrumb"]],
  ["プレースホルダー", ["placeholder"]],
  ["バリデーション", ["validation"]],

  // Storage / database / cache / files / import-export
  ["データベース", ["database"]],
  ["テーブル", ["table"]],
  ["カラム", ["column"]],
  ["圧縮", ["compress", "compression"]],
  ["解凍", ["decompress", "extract"]],
  ["バックアップ", ["backup"]],

  // Networking / API / requests / sessions / tokens
  ["エンドポイント", ["endpoint"]],
  ["ボディ", ["body"]],
  ["クエリ", ["query"]],
  ["パラメータ", ["parameter"]],
  ["ペイロード", ["payload"]],
  ["タイムスタンプ", ["timestamp"]],

  // Security / crypto / secrets / permissions
  ["秘密", ["secret"]],
  ["証明書", ["certificate"]],
  ["脆弱性", ["vulnerability"]],
  ["侵入", ["intrusion"]],
  ["漏洩", ["leak", "breach"]],
  ["マルウェア", ["malware"]],
  ["ファイアウォール", ["firewall"]],

  // Testing / build / deploy / release
  ["デプロイ", ["deploy", "deployment"]],
  ["リリース", ["release"]],
  ["ロールバック", ["rollback"]],

  // Documents / policies / contracts / approval workflows
  ["差し戻し", ["reject", "return"]],
  ["決裁", ["approval", "decision"]],

  // Accounting / ledger / journal
  ["借方", ["debit"]],
  ["貸方", ["credit"]],
  ["決算", ["closing", "settlement"]],
] as const;
