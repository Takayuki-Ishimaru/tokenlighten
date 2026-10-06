<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/branding/github-header-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="assets/branding/github-header-light.png">
    <img src="assets/branding/github-header-light.png" alt="TokenLighten MCP" width="100%">
  </picture>
</p>

<h1 align="center">
  <img src="assets/branding/app-icon.png" alt="" width="48" height="48">
  TokenLighten
</h1>

[English](README.md) | [日本語](README.ja.md)

**TokenLighten**は、ファイル全体を繰り返し送る代わりに、コーディングエージェントへ対象を絞ったリポジトリコンテキストを提供する、ローカルファーストのMCPツールキットです。

公開するツールは`tl_read_file`、`tl_search_files`、`tl_edit_file`の3つです。

## v0.15.1 リリース

**パブリックベータ。** TokenLighten v0.15.1では、コードの説明や計算に必要な根拠の収集を改善し、タスクパックの探索をワークスペース内に限定し、編集の再送時にも記録済みの結果を返します。MCPツールは引き続き3つで、サーバーはデフォルトで読み取り専用です。フィードバックに応じて、インターフェースや対応ワークフローが変更される場合があります。

v0.15.1の主な変更点は次のとおりです。

- 回答パックが質問に関係する関数の本体を全体で返すとき、その関数が読む定数もimport・別名・再エクスポートの先まで追跡します。
- `retry`のように関数名を明示した質問では、`retryDelay`のような似た名前と取り違えません。
- 複数の関数の呼び出し元を尋ねた場合、名前を挙げた各対象を保持します。
- 「edge cases」や「金額」のような説明の観点を、見つからないコードとして誤報しません。
- ワークスペース外へ向かうimportやシンボリックリンクを、タスクパックが読み取りません。
- 同じ`operation_id`で編集を再送すると、元の編集後テキストと、ファイルがその結果と今も一致するかを返します。

公開リリースには、CLI・MCPサーバー・Node.jsランタイムを同梱した4種類のインストール用アーカイブ（win-x64、darwin-arm64、darwin-x64、linux-x64）、ソースコードと公開パッケージテスト、単体で動作するVSIX形式のVS Code拡張機能が含まれます。デスクトップアプリケーションは含まれません。

**更新手順：** v0.15.1のアーカイブまたはVSIXを導入し、`tl workspace setup`または**このワークスペースをセットアップ**を再実行してください。その後、新しいエージェントセッションを開始するかMCPクライアントを再接続してください。正式なリクエスト項目とツール名はv0.15.0から変更ありません。更新手順と既知の制限は、[v0.15.1リリースノート](release-docs/github-release-v0.15.1.md)を参照してください。

## TokenLightenを使う理由

コーディングエージェントは、小さな変更を行うまでに、ファイルの探索、広い範囲の読み込み、同じコンテキストの再読込に複数ターンを費やすことがあります。TokenLightenはリポジトリをローカルで探索し、コンパクトな構造、シンボル、正確な範囲、範囲を限定した編集ハンドルを返します。

リポジトリのインデックス作成とコンテキスト選択はローカルCPU上で実行されます。TokenLighten自体がAIモデルを追加したり、リポジトリの内容をアップロードしたりすることはありません。エディタ、MCPクライアント、AIプロバイダーには、それぞれの設定と利用条件が引き続き適用されます。

削減効果は、リポジトリ、タスク、クライアント、モデルの動作によって異なります。TokenLightenが表示する使用量とコストはローカルな推定値であり、プロバイダーの請求記録ではありません。

## トークンとタスクコストの削減効果が期待できる場面

TokenLightenは、複数のファイル、パッケージ、文書形式にまたがって影響箇所を特定し、漏れなく正しく更新する必要があるタスクで、最も大きな効果を発揮するよう設計されています。変更箇所が既知の1か所に限定されるタスクでは、効果が小さくなると考えられます。

シンボル検索と参照検索は、該当する定義や呼び出し箇所を直接返せます。文書リーダーは、スプレッドシートをはじめとする対応形式から、ファイル全体を読み込まずに構造化された内容を抽出できます。これにより、リポジトリや文書を横断する作業に必要なコンテキストを集める際、検索と再読込の繰り返しを減らせます。

### 削減効果の目安（v0.15.0）

以下はv0.15.0での観察結果であり、v0.15.1を新たに測定した結果ではありません。

#### Sonnetでの比較

v0.15.0のリリース準備中に、同じSonnetモデルが通常のファイル読み取り・検索ツールだけを使う場合と、TokenLightenを使う場合を比較しました。6種類の課題を各3回試行し、両構成で作業結果を確認でき、請求記録に欠落のない11組では、使用量を料金換算した**タスク全体の合計コストが33.7%低くなりました**。

| 作業の例 | タスク料金の削減率（料金中央値の比較） | 比較できた組数 |
|---|---:|---:|
| 制御やモード遷移にまたがる関連バグを直す | **53.2%** | 2 |
| 局所的な判定とその影響範囲を説明する | **43.6%** | 1 |
| 関連する機能を横断して優先度ロジックを実装する | **35.9%** | 3 |
| 範囲の狭い計算・データ整合性の修正を行う | **21.5%** | 2 |
| スプレッドシート仕様から評価ルールを実装する | **9.4%** | 3 |

未完了の課題や請求記録が不完全な試行は、この集計に含めていません。表は通常構成とTL構成それぞれの料金中央値から計算した参考値で、1組だけの説明課題を含むため、一般的な削減率を示すものではありません。スプレッドシートの課題は中央値では低くなった一方、3組の合計コストではわずかに増えました。

#### GitHub Copilotでの実験

v0.15.0のリリース準備中に、VS CodeのGitHub Copilotで、通常の**Agent**モードによるコードの読取・説明を比較しました。Autoのモデル選択と標準ツールを有効にしたまま、TokenLightenの有無で計24回試行し、回答の計算結果とCopilotが記録した請求クレジットを確認しています。下表は同じモデル・同じ課題での**平均請求クレジットの削減率**です。

| 作業の例 | モデル | 削減率 | 試行数（通常 / TL） |
|---|---|---:|---:|
| 割引・送料・税の規則を追い、複数の注文の金額を説明する | GPT-6 Luna | **9.8%** | 2 / 2 |
| ファイルの場所を指定せず、再試行の待ち時間とその根拠を説明する | GPT-6 Luna | **11.9%** | 2 / 2 |
| ソースの場所を指定し、再試行の待ち時間とその根拠を説明する | MAI-Code-1.1-Flash | 6.8%（差は明確でない） | 5 / 6 |
| ファイルの場所を指定せず、再試行の待ち時間とその根拠を説明する | MAI-Code-1.1-Flash | 54.5%（キャッシュ条件の影響が大きい） | 2 / 2 |

Copilotでは専用のカスタムAgentを選ばずにTokenLightenが使われ、MAIの短い読取課題では、回答までのモデルとの往復が通常の3〜4回から2回に減りました。一方、試行数は少なく、Autoによるモデルの配分やキャッシュ条件も揃えていません。6.8%の例は試行ごとの料金範囲が重なり、54.5%の例もそのまま通常の削減率として期待できるものではありません。

**この割合は料金の削減率であり、トークン数の削減率ではありません。** 入力・出力・キャッシュ済みトークンは単価が異なるため、料金の削減率をそのままトークンの削減率には換算できません。削減できるコンテキスト量は、エージェントが本来読み込むソースの量や、同じ内容を読み直す回数によって変わります。

これらは参考値であり、削減を保証するものではありません。Copilotの比較は読取・説明課題に限られ、Sonnetの比較ともモデル、課題、測定条件が異なるため、数値を合算できません。結果はリポジトリ、タスク、クライアント、モデルの動作、料金によって異なります。ご自身のワークスペースでは、CLIやVS Codeの使用量表示でローカルの計測値と推定値を確認できます。これらの表示はプロバイダーの請求記録ではありません。

### 効果が小さくなりやすい・苦手なタスク

探索や再読み込みがほとんど必要ない作業では、TokenLightenの効果が小さくなりやすくなります。

- **変更箇所が分かっている1か所だけの小さな修正**：値の置換や短い計算式の修正など。
- **局所的なコードの説明**：すでに提示されている短い関数の説明など。

こうした作業では、ツールの説明・操作手順・呼び出しに必要な追加コンテキストが、読み込みの削減分を上回る場合があります。過去の比較には、小さな修正や局所的な説明で料金が同程度、または増えた例もありました。上の例でも、あらゆる小さな作業で料金が下がることを示すものではありません。

また、TokenLightenは型情報に基づく完全な意味解析を行うものではありません。型・インポート・オーバーロードの解決に依存するファイル横断のリネームには、言語対応ツールによる解析と検証が必要です。詳しい対応範囲は[対応言語とファイル形式](release-docs/language-support.md)を参照してください。

## アーカイブをインストールする（拡張機能もビルドも不要）

[最新のGitHub Release](https://github.com/Takayuki-Ishimaru/tokenlighten/releases)からご利用のOS向けアーカイブをダウンロードし、公開されている`SHA256SUMS`で検証してから展開し、次を実行します。

```sh
./tl-setup /path/to/workspace       # macOS/Linux
tl-setup C:\path\to\workspace       # Windows
```

各アーカイブには専用のNode.jsが同梱されているため、別途ランタイムを導入する必要も、エディタ拡張機能も不要です。この操作により、検出されたすべてのAIエージェントホスト（Claude Code、Codex、Gemini CLI、Copilot CLI、およびVS Code内のGitHub Copilot Chat）向けにTokenLightenをマシン単位のMCPサーバーとして登録し、指定したワークスペースをセットアップします。検証・アップグレード・ロールバック・アンインストールの手順は[はじめに](release-docs/getting-started.md)を参照してください。

VS Code拡張機能を使いたい場合は、次の節を参照してください。

## VS Code拡張機能をインストールする（ビルド不要）

v0.15.1のGitHub Releaseから[tokenlighten-vscode-extension-0.15.1.vsix](https://github.com/Takayuki-Ishimaru/tokenlighten/releases/download/v0.15.1/tokenlighten-vscode-extension-0.15.1.vsix)をダウンロードしてください。Node.jsの導入やソースからのビルドは不要です。このリリースにはOS固有のネイティブバイナリが含まれないため、Windows、macOS、Linuxで同じVSIXを使用します。

インストール手順は次のとおりです。

1. VS Codeで**拡張機能**ビューを開きます。
2. **VSIXからのインストール…**を選びます。
3. ダウンロードしたファイルを選択します。

ターミナルからインストールすることもできます。

```sh
code --install-extension tokenlighten-vscode-extension-0.15.1.vsix
```

信頼済みのプロジェクトフォルダを開き、TokenLightenビューから**このワークスペースをセットアップ**を選択します。VSIXにはCLI、MCPサーバー、パーサー、必要なアセットが含まれるため、別途グローバルインストールする必要はありません。この操作は、上記のアーカイブと同じマシン単位のインストール（`tl install --from-extension`）を実行し、現在のワークスペースをセットアップしますが、このマシン上のClaude CodeやCodexなど他のホストは登録しません（`--clients none`）。これらを登録するには、`tl clients activate`を実行するか、アーカイブの`tl-setup`を使用してください。

詳しくは[VS Code拡張機能](release-docs/vscode-extension.ja.md)を参照してください。

## ソースからビルドする

必要な環境は次のとおりです。

- Node.js 20以降
- npm
- 書き込みを許可したリポジトリ操作を使用する場合はGit

```sh
git clone https://github.com/Takayuki-Ishimaru/tokenlighten.git
cd tokenlighten
npm ci
npm run build
npm link --workspace packages/cli
tl version
tl doctor --json
```

`npm link`はこのチェックアウトだけで有効な`tl`コマンドです。他のホストからも見つかるマシンインストールにするには、続けて`tl install --dev`を実行してください。アーカイブインストールと同じIDになります。

別のワークスペースにTokenLightenをセットアップします。

```sh
cd /path/to/project
tl workspace setup
```

`tl workspace setup`は、ワークスペースのMCP設定とAGENTS.md/CLAUDE.md内のTokenLightenガイドブロックを管理します。対応エージェントがセッションをまたいで現在のツール操作手順を参照できるよう、ガイドブロックを残してください。詳しい設定方法と、`tl clients activate`によるマシン全体へのクライアント登録は、[はじめに](release-docs/getting-started.md#set-up-a-workspace)を参照してください。

共通ガイドは、依頼全文を`tl_read_file`へ渡し、所在不明のファイルを探索して、取得済みの本文を再利用する手順をCodex・Claude Codeへ提供します。CodexはAGENTS.mdの管理ブロック、Claude CodeはCLAUDE.mdの参照経路を使います。実行環境を更新した後、対象クライアントの`tl workspace setup`を再実行し、新しいセッションを開始してください。削減効果はタスク、クライアント、モデルにより異なります。

VS Code向けセットアップは、通常のAgentの新規ローカルチャットへTLの初回読取・再読回避手順を渡すSessionStartフックも作成します。信頼済みワークスペースで`chat.useHooks`が有効、かつ`node`がPATH上にあることが条件です。ツールや承認設定は変更せず、既存フックとユーザー編集を保持します。フックを作成・更新しない場合は`tl workspace setup --clients vscode --copilot-session-context keep`を使ってください。

MCPサーバーはデフォルトで読み取り専用です。ワークスペースの変更を明示的に許可する場合だけ、書き込みを有効にしてください。

```sh
tl mcp start --stdio --workspace /path/to/project
tl mcp start --stdio --allow-write --workspace /path/to/project
```

現在のコマンド一覧は`tl help`で確認できます。

## MCPツール

| ツール | 用途 |
|---|---|
| `tl_read_file` | あらゆるタスクの最初の一手。対象箇所が不明な調査や複数ファイルにまたがる調査も含みます。対象を絞ったファイル内容、構造、シンボル、タスク向けコンテキストパックを返します。 |
| `tl_search_files` | 選択したワークスペース全体からファイル、テキスト、シンボル、参照をリポジトリ全体・`.gitignore`準拠で検索します。 |
| `tl_edit_file` | 事前の読み込みで確立したコンテキストに基づき、範囲を限定して編集します。`--allow-write`が必要です。 |

動作と安全上の注意は[MCPツール](release-docs/mcp-tools.md)を参照してください。

## パッケージ

| パッケージ | 用途 |
|---|---|
| `@tokenlighten/mcp-server` | 標準入出力を使用するMCPサーバーと3つの公開ツールです。 |
| `@tokenlighten/cli` | `tl`コマンドとワークスペース／クライアントのセットアップです。 |
| `@tokenlighten/skeleton-engine` | リポジトリマップ、シンボル、範囲、ルート抽出です。 |
| `@tokenlighten/agents-md` | ドリフト検出機能を備えた、管理対象のエージェント指示ブロックです。 |
| `@tokenlighten/usage` | ローカルな使用量と削減効果の推定です。 |
| `@tokenlighten/types` | 共有する公開TypeScriptコントラクトです。 |
| `tokenlighten-vscode-extension` | 単体で動作するVS Code統合です。 |

## 対応言語とファイル形式

主要なプログラミング言語として、TypeScript、JavaScript、Python、Go、Java、Rust、C、C++、Kotlin、C#、PHP、Rubyに対応しています。

対応するテキスト、Office、PDF、アーカイブ形式も読み取れます。一部の形式は読み取り専用で、PDFにはテキストレイヤーが必要です。現在の対応範囲は[対応言語とファイル形式](release-docs/language-support.md)を参照してください。

## 開発

公開ソースの開発者向けチェックは、リポジトリのルートで実行します。

```sh
npm ci
npm run build
npm run test:packages
npm run test:bundle-cli
npm run licenses
npm run doctor
```

VSIXをビルドします。

```sh
npm run package -w tokenlighten-vscode-extension
```

変更を送る前に[CONTRIBUTING.md](CONTRIBUTING.md)を確認してください。

## ドキュメント

- [はじめに](release-docs/getting-started.md)
- [MCPツール](release-docs/mcp-tools.md)
- [VS Code拡張機能](release-docs/vscode-extension.ja.md)
- [対応言語とファイル形式](release-docs/language-support.md)
- [プライバシー、セキュリティ、サポート](release-docs/privacy-security-support.md)
- [ライセンスと利用方針](release-docs/licensing.md)

## セキュリティとサポート

サーバーは`--allow-write`を指定しない限り読み取り専用です。脆弱性を報告する前に[SECURITY.md](SECURITY.md)、ベストエフォートのサポート方針については[SUPPORT.md](SUPPORT.md)を確認してください。公開Issueには認証情報、非公開のソースコード、顧客データ、未加工のログを投稿しないでください。

## ライセンス

TokenLightenはソースアベイラブルのソフトウェアであり、OSI承認のオープンソースライセンスではありません。個人利用、勤務先や顧客の業務における個人としての利用、組織内利用、適切な表示を伴う個人的かつ非組織的な再配布は、リリースの利用条件で許可されます。製品／サービスへの組み込み、および組織的または商用の再配布には、Takayuki Ishimaru（GitHub: [@Takayuki-Ishimaru](https://github.com/Takayuki-Ishimaru)）の事前の書面による許可が必要です。

リリースに含まれる`LICENSE`が正式な利用条件です。平易な要約は[ライセンスと利用方針](release-docs/licensing.md)を参照してください。
