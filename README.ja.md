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

公開するツールは`read_file`、`search_files`、`edit_file`の3つです。

## v0.14.2 リリース

**パブリックベータ。** TokenLighten v0.14.2は、タスクの継続、複数の論点を含む依頼や日本語の解釈、コード専用プロジェクトのセットアップを改善するアップデートです。MCPツールは引き続き3つで、サーバーはデフォルトで読み取り専用です。フィードバックに応じて、インターフェースや対応ワークフローが変更される場合があります。

v0.14.2の主な変更点は次のとおりです。

- タスクを継続するとき、完了済みの読み込みとそれまでの要求を引き継ぎ、同じ手順を繰り返さずに先へ進めるようにしました。
- 特定のファイル・識別子・複数の論点を指定した依頼の焦点を保ち、日本語の文や見つからない論点の扱いを改善しました。
- 入力待ちになった場合は、何が未解決なのかを示し、利用できる場合は回復用の呼び出しも返します。
- `budget.allowFull:true`を指定した場合も含め、すでにコンテキストにある内容の不要な再送を抑えます。
- コード専用のワークスペースをセットアップすると、デフォルトでコンパクトなエージェントガイドを使用します。ガイドの種類を明示した場合は、その設定を優先します。

公開リリースには以下が含まれます。

- TokenLighten CLIとMCPサーバー
- 開発者向けのソースコードと公開パッケージテスト
- 単体で動作するVSIX形式のVS Code拡張機能

**互換性の注意：** 3つのツールと現行のリクエスト項目は引き続き利用できます。`budget.allowFull:true`はファイル全体の読み込み上限を引き上げる設定となり、再送を強制しなくなりました。以前に受け取った内容の再送が必要な場合は`task.force_serve:true`を指定してください。エージェント向けの管理ガイドは、ワークスペースのセットアップを再実行すると更新できます。v0.12／v0.13の旧リクエスト項目は引き続きデフォルトで受け付けません（サーバー側の`TL_LEGACY_INPUT=accept`は一時的な移行手段として利用できます）。詳細と既知の制限は、[v0.14.2リリースノート](release-docs/github-release-v0.14.2.md)を参照してください。

## TokenLightenを使う理由

コーディングエージェントは、小さな変更を行うまでに、ファイルの探索、広い範囲の読み込み、同じコンテキストの再読込に複数ターンを費やすことがあります。TokenLightenはリポジトリをローカルで探索し、コンパクトな構造、シンボル、正確な範囲、範囲を限定した編集ハンドルを返します。

リポジトリのインデックス作成とコンテキスト選択はローカルCPU上で実行されます。TokenLighten自体がAIモデルを追加したり、リポジトリの内容をアップロードしたりすることはありません。エディタ、MCPクライアント、AIプロバイダーには、それぞれの設定と利用条件が引き続き適用されます。

削減効果は、リポジトリ、タスク、クライアント、モデルの動作によって異なります。TokenLightenが表示する使用量とコストはローカルな推定値であり、プロバイダーの請求記録ではありません。

## トークンとタスクコストの削減効果が期待できる場面

TokenLightenは、複数のファイル、パッケージ、文書形式にまたがって影響箇所を特定し、漏れなく正しく更新する必要があるタスクで、最も大きな効果を発揮するよう設計されています。変更箇所が既知の1か所に限定されるタスクでは、効果が小さくなると考えられます。

シンボル検索と参照検索は、該当する定義や呼び出し箇所を直接返せます。文書リーダーは、スプレッドシートをはじめとする対応形式から、ファイル全体を読み込まずに構造化された内容を抽出できます。これにより、リポジトリや文書を横断する作業に必要なコンテキストを集める際、検索と再読込の繰り返しを減らせます。

### 削減効果の目安（v0.14.0）

v0.14.0の比較では、同じエージェントが通常のファイル読み取り・検索ツールだけを使う場合に比べ、TokenLightenを使った場合の**タスク全体の合計料金は36.7%低くなりました**。両方の構成で作業結果を検証できたものを比較しています。

| 作業の例 | タスク料金の削減率（中央値） |
|---|---:|
| 関連する機能を横断して優先度ロジックを実装する | **59.1%** |
| 複数モジュールの判定を追い、下流の動作へ接続する | **40.5%** |
| スプレッドシート仕様から評価ルールを実装する | **39.1%** |
| 範囲の狭い計算・データ整合性の修正を行う | **29.0%** |
| 局所的な判定とその影響範囲を説明する | **25.1%** |
| 制御やモード遷移にまたがる関連バグを直す | **17.9%** |

**この割合は料金の削減率であり、トークン数の削減率ではありません。** 入力・出力・キャッシュ済みトークンは単価が異なるため、料金の削減率をそのままトークンの削減率には換算できません。削減できるコンテキスト量は、エージェントが本来読み込むソースの量や、同じ内容を読み直す回数によって変わります。

これらは参考値であり、削減を保証するものではありません。この比較はv0.14.0で行ったもので、v0.14.2では再計測していません。結果はリポジトリ、タスク、クライアント、モデルの動作、料金によって異なります。ご自身のワークスペースでは、CLIやVS Codeの使用量表示でローカルの計測値と推定値を確認できます。これらの表示はプロバイダーの請求記録ではありません。

### 効果が小さくなりやすい・苦手なタスク

探索や再読み込みがほとんど必要ない作業では、TokenLightenの効果が小さくなりやすくなります。

- **変更箇所が分かっている1か所だけの小さな修正**：値の置換や短い計算式の修正など。
- **局所的なコードの説明**：すでに提示されている短い関数の説明など。

こうした作業では、ツールの説明・操作手順・呼び出しに必要な追加コンテキストが、読み込みの削減分を上回る場合があります。過去の比較には、小さな修正や局所的な説明で料金が同程度、または増えた例もありました。上のv0.14.0の例では削減が見られましたが、あらゆる小さな作業で料金が下がることを示すものではありません。

また、TokenLightenは型情報に基づく完全な意味解析を行うものではありません。型・インポート・オーバーロードの解決に依存するファイル横断のリネームには、言語対応ツールによる解析と検証が必要です。詳しい対応範囲は[対応言語とファイル形式](release-docs/language-support.md)を参照してください。

## VS Code拡張機能をインストールする（ビルド不要）

v0.14.2のGitHub Releaseから[tokenlighten-vscode-extension-0.14.2.vsix](https://github.com/Takayuki-Ishimaru/tokenlighten/releases/download/v0.14.2/tokenlighten-vscode-extension-0.14.2.vsix)をダウンロードしてください。Node.jsの導入やソースからのビルドは不要です。このリリースにはOS固有のネイティブバイナリが含まれないため、Windows、macOS、Linuxで同じVSIXを使用します。

インストール手順は次のとおりです。

1. VS Codeで**拡張機能**ビューを開きます。
2. **VSIXからのインストール…**を選びます。
3. ダウンロードしたファイルを選択します。

ターミナルからインストールすることもできます。

```sh
code --install-extension tokenlighten-vscode-extension-0.14.2.vsix
```

信頼済みのプロジェクトフォルダを開き、TokenLightenビューから**このワークスペースをセットアップ**を選択します。VSIXにはCLI、MCPサーバー、パーサー、必要なアセットが含まれるため、別途グローバルインストールする必要はありません。

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

別のワークスペースにTokenLightenをセットアップします。

```sh
cd /path/to/project
tl workspace setup
```

`tl workspace setup`は、ワークスペースのMCP設定とAGENTS.md/CLAUDE.md内のTokenLightenガイドブロックを管理します。対応エージェントがセッションをまたいで現在のツール操作手順を参照できるよう、ガイドブロックを残してください。詳しい設定方法と、`tl clients activate`によるマシン全体へのクライアント登録は、[はじめに](release-docs/getting-started.md#set-up-a-workspace)を参照してください。

MCPサーバーはデフォルトで読み取り専用です。ワークスペースの変更を明示的に許可する場合だけ、書き込みを有効にしてください。

```sh
tl mcp start --stdio --workspace /path/to/project
tl mcp start --stdio --allow-write --workspace /path/to/project
```

現在のコマンド一覧は`tl help`で確認できます。

## MCPツール

| ツール | 用途 |
|---|---|
| `read_file` | あらゆるタスクの最初の一手。対象箇所が不明な調査や複数ファイルにまたがる調査も含みます。対象を絞ったファイル内容、構造、シンボル、タスク向けコンテキストパックを返します。 |
| `search_files` | 選択したワークスペース全体からファイル、テキスト、シンボル、参照をリポジトリ全体・`.gitignore`準拠で検索します。 |
| `edit_file` | 事前の読み込みで確立したコンテキストに基づき、範囲を限定して編集します。`--allow-write`が必要です。 |

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
