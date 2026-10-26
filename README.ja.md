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

## v0.16.2 リリース

**パブリックベータ。** TokenLighten v0.16.2では、コードの説明、変更禁止ファイルの扱い、CLIの信頼性を改善しました。フィードバックに応じて、インターフェースや対応ワークフローが変更される場合があります。

v0.16.2の主な修正点は次のとおりです。

- 条件・呼び出し元・設定ファイルの詳細・エラー時の処理など、説明に必要な実装コードを取得する処理を改善しました。
- 異なるモジュールの同名メソッドを区別し、TypeScriptの型だけの参照を実行時の値として誤判定する問題を修正しました。
- 変更を禁止したファイルを列挙した場合、一覧の各ファイルを保護します。
- 任意のローカル解析で、呼び出し先の区別とソースの行位置をより正確に保持します。
- CLIの接続失敗、サーバー停止時のプロセス情報、ログ切り替え中の使用量読み取りを修正しました。

MCPツールは引き続き`tl_read_file`、`tl_search_files`、`tl_edit_file`の3つです。手動起動のサーバーは`--allow-write`を指定しない限り読み取り専用で、初回のワークスペースセットアップは既定で書き込みを有効にします。

公開リリースには、CLI・MCPサーバー・Node.jsランタイムを同梱した4種類のインストール用アーカイブ（win-x64、darwin-arm64、darwin-x64、linux-x64）、ソースコードと公開パッケージテスト、単体で動作するVSIX形式のVS Code拡張機能が含まれます。モデルの重みは利用者の操作で別途取得します。デスクトップアプリケーションは含まれません。

**更新手順：** v0.16.2のアーカイブまたはVSIXを導入し、ワークスペースのセットアップを更新してください。その後、新しいエージェントセッションを開始するかMCPクライアントを再接続してください。CLIでの再セットアップは、各クライアントの既存の書き込み権限を維持します。`--read-only`または`--allow-write`で明示的に変更できます。拡張機能の**このワークスペースをセットアップ**は書き込みを有効にします。3つのツール名と正式なトップレベルのリクエスト項目はv0.16.1から変更ありません。詳しくは[v0.16.2リリースノート](release-docs/github-release-v0.16.2.md)と[ローカル解析エンジン](release-docs/local-analysis.md)を参照してください。

## TokenLightenを使う理由

コーディングエージェントは、小さな変更を行うまでに、ファイルの探索、広い範囲の読み込み、同じコンテキストの再読込に複数ターンを費やすことがあります。TokenLightenはリポジトリをローカルで探索し、コンパクトな構造、シンボル、正確な範囲、範囲を限定した編集ハンドルを返します。

リポジトリのインデックス作成とコンテキスト選択はローカルCPU上で実行されます。任意の意味検索では、別途取得するローカルの埋め込みモデルを使用します。既定では無効で、TokenLightenがリポジトリの内容をモデルサービスへ送信することはありません。エディタ、MCPクライアント、AIプロバイダーには、それぞれの設定と利用条件が引き続き適用されます。

削減効果は、リポジトリ、タスク、クライアント、モデルの動作によって異なります。TokenLightenが表示する使用量とコストはローカルな推定値であり、プロバイダーの請求記録ではありません。

## トークンとタスクコストの削減効果が期待できる場面

TokenLightenは、複数のファイル、パッケージ、文書形式にまたがって影響箇所を特定し、漏れなく正しく更新する必要があるタスクで、最も大きな効果を発揮するよう設計されています。変更箇所が既知の1か所に限定されるタスクでは、効果が小さくなると考えられます。

シンボル検索と参照検索は、該当する定義や呼び出し箇所を直接返せます。文書リーダーは、スプレッドシートをはじめとする対応形式から、ファイル全体を読み込まずに構造化された内容を抽出できます。これにより、リポジトリや文書を横断する作業に必要なコンテキストを集める際、検索と再読込の繰り返しを減らせます。

### 削減効果の目安（v0.16.0）

#### Sonnetでの比較

2026年10月20日、v0.16.0のリリース前候補を既定設定で使用し、Claude Code上の同じSonnet 5モデルが通常のファイル読み取り・検索ツールだけを使う場合と比較しました。6種類の課題を各構成で3回ずつ試行し、**両構成で作業結果を検証でき、使用量記録に欠落のない12組**では、入力・キャッシュ済み・出力トークンをそれぞれ料金換算した**タスク全体の合計コストが37.8%低くなりました**。

| 作業の例 | タスク料金の削減率（料金中央値の比較） | 比較できた組数 |
|---|---:|---:|
| 制御やモード遷移にまたがる関連バグを直す | **67.7%** | 1 |
| スプレッドシート仕様から評価ルールを実装する | **47.4%** | 2 |
| 範囲の狭い計算・データ整合性の修正を行う | **40.5%** | 2 |
| 関連する機能を横断して優先度ロジックを実装する | **30.3%** | 2 |
| 推定器の健全性を送信テレメトリーへ接続する | **23.0%** | 2 |
| 注文処理の流れと依存関係を説明する | **19.7%** | 3 |

全体の37.8%は料金の合計同士、表は各構成の料金中央値同士を比較した値です。試行した18組のうち6組は、少なくとも片方の使用量記録が不完全なため、この主集計から除いています。課題別で最も大きい削減率は1組だけの結果です。試行数が少ないため、一般的な削減率や効果の保証を示すものではありません。

補足として、欠けたTL側の出力を次の要求の入力から推定した保守的な上限額で計上し、通常構成側は記録額のままにした参考集計では、**16組で35.2%の料金減**でした。上限を求められない2組は除いています。これは不完全な記録を補った推定であり、上の完全な記録だけによる比較とは分けて扱います。

Sonnetで測定した候補の後に加えたリクエスト処理の修正は、Sonnetでは別途再測定していません。 v0.16.2での削減効果も新たに測定していません。

### 効果が小さくなりやすい・苦手なタスク

探索や再読み込みがほとんど必要ない作業では、TokenLightenの効果が小さくなりやすくなります。

- **変更箇所が分かっている1か所だけの小さな修正**：値の置換や短い計算式の修正など。
- **局所的なコードの説明**：すでに提示されている短い関数の説明など。

こうした作業では、ツールの説明・操作手順・呼び出しに必要な追加コンテキストが、読み込みの削減分を上回る場合があります。上記の比較でも、あらゆる小さな作業で料金が下がることを示すものではありません。

任意の型付きシンボル解決は、対応する定義・参照の特定を補助しますが、すべての編集を型情報に基づいて行うものではありません。型・インポート・オーバーロードの解決に依存するファイル横断のリネームには、言語対応ツールによる解析と検証が必要です。詳しい対応範囲は[対応言語とファイル形式](release-docs/language-support.md)を参照してください。

## アーカイブをインストールする（拡張機能もビルドも不要）

[最新のGitHub Release](https://github.com/Takayuki-Ishimaru/tokenlighten/releases)からご利用のOS向けアーカイブをダウンロードし、公開されている`SHA256SUMS`で検証してから展開し、次を実行します。

```sh
./tl-setup /path/to/workspace       # macOS/Linux
tl-setup C:\path\to\workspace       # Windows
```

各アーカイブには専用のNode.jsが同梱されているため、別途ランタイムを導入する必要も、エディタ拡張機能も不要です。この操作により、検出されたすべてのAIエージェントホスト（Claude Code、Codex、Gemini CLI、Copilot CLI、およびVS Code内のGitHub Copilot Chat）向けにTokenLightenをマシン単位のMCPサーバーとして登録し、指定したワークスペースをセットアップします。検証・アップグレード・ロールバック・アンインストールの手順は[はじめに](release-docs/getting-started.md)を参照してください。

VS Code拡張機能を使いたい場合は、次の節を参照してください。

## VS Code拡張機能をインストールする（ビルド不要）

v0.16.2のGitHub Releaseから[tokenlighten-vscode-extension-0.16.2.vsix](https://github.com/Takayuki-Ishimaru/tokenlighten/releases/download/v0.16.2/tokenlighten-vscode-extension-0.16.2.vsix)をダウンロードしてください。Node.jsの導入やソースからのビルドは不要です。このリリースにはOS固有のネイティブバイナリが含まれないため、Windows、macOS、Linuxで同じVSIXを使用します。

インストール手順は次のとおりです。

1. VS Codeで**拡張機能**ビューを開きます。
2. **VSIXからのインストール…**を選びます。
3. ダウンロードしたファイルを選択します。

ターミナルからインストールすることもできます。

```sh
code --install-extension tokenlighten-vscode-extension-0.16.2.vsix
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

共通ガイドは、すべてのツールサーフェスで`compact`を既定とします。依頼全文を`tl_read_file`へ渡し、所在不明のファイルを探索して、取得済みの本文を再利用する手順をCodex・Claude Codeへ提供します。長いガイドを使う場合は`--guide-profile full`または`medium`を明示してください。CodexはAGENTS.mdの管理ブロック、Claude CodeはCLAUDE.mdの参照経路を使います。実行環境を更新した後、対象クライアントの`tl workspace setup`を再実行し、新しいセッションを開始してください。削減効果はタスク、クライアント、モデルにより異なります。

VS Code向けセットアップは、通常のAgentの新規ローカルチャットへTLの初回読取・再読回避手順を渡すSessionStartフックも作成します。信頼済みワークスペースで`chat.useHooks`が有効、かつ`node`がPATH上にあることが条件です。ツールや承認設定は変更せず、既存フックとユーザー編集を保持します。フックを作成・更新しない場合は`tl workspace setup --clients vscode --copilot-session-context keep`を使ってください。

初回のワークスペースセットアップは、既定で書き込みを有効にします。`tl workspace setup`を再実行すると、各クライアントの既存の書き込み権限を維持します。`--read-only`または`--allow-write`で明示的に変更でき、実効的な権限は通常出力とJSON出力に表示されます。

手動で起動するMCPサーバーは、`--allow-write`を指定しない限り読み取り専用です。

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
