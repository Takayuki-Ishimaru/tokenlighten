# TokenLighten

[English](README.md) | [日本語](README.ja.md)

**TokenLighten**は、ファイル全体を繰り返し送る代わりに、コーディングエージェントへ対象を絞ったリポジトリコンテキストを提供する、ローカルファーストのMCPツールキットです。

公開するツールは`read_file`、`search_files`、`edit_file`の3つです。

## v0.11.1 リリース

**パブリックベータ更新版。** TokenLighten v0.11.1は最新のソースリリースです。フィードバックを反映する過程で、インターフェースや対応ワークフローが引き続き変更される場合があります。重要な作業はバックアップを取り、公開Issueには非公開のソースコード、認証情報、顧客データを含めないでください。

公開リリースには以下が含まれます。

- TokenLighten CLIとMCPサーバー
- 開発者向けのソースコードと公開パッケージテスト
- 単体で動作するVSIX形式のVS Code拡張機能

v0.9.xと比べ、v0.11.1では再起動後も継続できるタスクハンドル、absence／scopeの正直な開示、コンテンツハッシュによるインデックス鮮度、最新MCP transport、検証情報付きの限定編集、任意で有効化するgraph／retrieval／packing／reasoning／wire実験、paired calibration、VS Code診断機能が追加されています。実験機能は、明示的に有効化しない限りデフォルトで無効です。

公開リリースにはデスクトップアプリケーションと非公開ベンチハーネスを含めません。

## TokenLightenを使う理由

コーディングエージェントは、小さな変更を行うまでに、ファイルの探索、広い範囲の読み込み、同じコンテキストの再読込に複数ターンを費やすことがあります。TokenLightenはリポジトリをローカルで探索し、コンパクトな構造、シンボル、正確な範囲、範囲を限定した編集ハンドルを返します。

リポジトリのインデックス作成とコンテキスト選択はローカルCPU上で実行されます。TokenLighten自体がAIモデルを追加したり、リポジトリの内容をアップロードしたりすることはありません。エディタ、MCPクライアント、AIプロバイダーには、それぞれの設定と利用条件が引き続き適用されます。

削減効果は、リポジトリ、タスク、クライアント、モデルの動作によって異なります。TokenLightenが表示する使用量とコストはローカルな推定値であり、プロバイダーの請求記録ではありません。

## トークンとタスクコストの削減効果が期待できる場面

TokenLightenは、複数のファイル、パッケージ、文書形式にまたがって影響箇所を特定し、漏れなく正しく更新する必要があるタスクで、最も大きな効果を発揮するよう設計されています。変更箇所が既知の1か所に限定されるタスクでは、効果が小さくなると考えられます。

シンボル検索と参照検索は、該当する定義や呼び出し箇所を直接返せます。文書リーダーは、スプレッドシートをはじめとする対応形式から、ファイル全体を読み込まずに構造化された内容を抽出できます。これにより、リポジトリや文書を横断する作業に必要なコンテキストを集める際、検索と再読込の繰り返しを減らせます。

### 開発者ベンチマークの観察結果

最新の6タスクによる開発者向け決定ランでは、検証に合格した同条件の16ペア全体で、TokenLighten使用時の検証済みタスクコストがネイティブツールのみの場合より約**21%低く**なりました。

複数モジュールにまたがるテレメトリ配線タスクでは、estimatorのhealth判定を見つけ、送信側のsystem-status経路へ接続する必要がありました。検証に合格した3回の反復では、TokenLighten使用時のタスクコスト中央値が約**33%低く**なりました。

フライト制御、ミキサー、モード遷移にまたがる複数バグのオンコール対応タスクでは、両方の実行が検証に合格した2回の反復において、コスト中央値が約**29%低く**なりました。残る1回は両条件で検証結果が異なったため、このコスト比較には含めていません。

今回の結果から、TokenLightenの効果が小さくなりやすい傾向も確認されています。

- 対象範囲があらかじめ絞られた計算修正や、配置先が明確な文書起点の実装では、効果が限定的でした。
- 両条件で検証結果が一致しないタスクでは結果のばらつきが大きく、その実行は上記の数値比較から除外しています。
- 対象箇所が既知の小規模タスクでは、MCP schemaと管理ガイドの固定コストによりTokenLightenの方が高コストになる場合があります。

これらは開発者が実施したベンチマークの観察結果であり、削減を保証するものではありません。v0.11.1の評価は公開済みのv0.9.xより広いタスク構成を使用しているため、両リリースの直接的なbefore/after比較ではありません。実際のコストはリポジトリ、タスク、クライアント、モデルの動作、料金によって異なり、ローカル推定値はプロバイダーの請求記録ではありません。詳しい解釈と注意事項は[v0.11.1リリース草案](release-docs/github-release-v0.11.1.md#benchmark-update)を参照してください。

## VS Code拡張機能をインストールする（ビルド不要）

v0.11.1公開後、[tokenlighten-vscode-extension-0.11.1.vsix](https://github.com/Takayuki-Ishimaru/tokenlighten/releases/download/v0.11.1/tokenlighten-vscode-extension-0.11.1.vsix)をダウンロードしてください。Node.jsの導入やソースからのビルドは不要です。このリリースにはOS固有のネイティブバイナリが含まれないため、Windows、macOS、Linuxで同じVSIXを使用します。

インストール手順は次のとおりです。

1. VS Codeで**拡張機能**ビューを開きます。
2. **VSIXからのインストール…**を選びます。
3. ダウンロードしたファイルを選択します。

ターミナルからインストールすることもできます。

```sh
code --install-extension tokenlighten-vscode-extension-0.11.1.vsix
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

v0.11.1では、完全なパッケージテストをUbuntuとmacOSのCIゲートにしています。Windows CIでは、ソースのビルド、同梱CLI、依存関係のライセンスと通知、実行時依存関係の監査、診断を確認します。一部のテストfixtureがまだWindowsへ移植できていないため、完全なパッケージテストはWindowsのリリースゲートではありません。これはWindowsやVSIXのインストールが非対応であることを意味せず、Windows固有のテスト範囲は今後拡充します。

## ドキュメント

- [はじめに](release-docs/getting-started.md)
- [MCPツール](release-docs/mcp-tools.md)
- [VS Code拡張機能](release-docs/vscode-extension.ja.md)
- [対応言語とファイル形式](release-docs/language-support.md)
- [プライバシー、セキュリティ、サポート](release-docs/privacy-security-support.md)
- [ライセンスと利用方針](release-docs/licensing.md)

既存の`docs/`ディレクトリは開発履歴であり、公開するv0.11.1ソースリリースには含まれません。

## セキュリティとサポート

### 依存関係監査のスナップショット

2026-08-23にv0.11.1ソースを監査した時点で、`npm audit --omit=dev`は通常のruntime dependency viewについて**Critical 0件、High 0件、Moderate 2件**を報告しました。

開発用依存関係を含むソース開発環境全体では、**Critical 1件、High 1件、Moderate 5件**が報告されました。これらは通常のインストール済みVSIXのruntime view外です。コントリビューターは、信頼できないソースやコンテンツを開発ツールで処理する前に内容を確認してください。

これは特定日時点の依存関係監査であり、脆弱性が存在しないことを保証するものではありません。監査情報は公開後に変化する可能性があります。実行時依存関係には`npm audit --omit=dev`、開発環境全体には`npm audit`を再実行してください。

サーバーは`--allow-write`を指定しない限り読み取り専用です。脆弱性を報告する前に[SECURITY.md](SECURITY.md)、ベストエフォートのサポート方針については[SUPPORT.md](SUPPORT.md)を確認してください。公開Issueには認証情報、非公開のソースコード、顧客データ、未加工のログを投稿しないでください。

## ライセンス

TokenLightenはソースアベイラブルのソフトウェアであり、OSI承認のオープンソースライセンスではありません。個人利用、勤務先や顧客の業務における個人としての利用、組織内利用、適切な表示を伴う個人的かつ非組織的な再配布は、リリースの利用条件で許可されます。製品／サービスへの組み込み、および組織的または商用の再配布には、Takayuki Ishimaru（GitHub: [@Takayuki-Ishimaru](https://github.com/Takayuki-Ishimaru)）の事前の書面による許可が必要です。

リリースに含まれる`LICENSE`が正式な利用条件です。平易な要約は[ライセンスと利用方針](release-docs/licensing.md)を参照してください。
