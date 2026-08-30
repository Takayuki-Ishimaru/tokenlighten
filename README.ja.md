# TokenLighten

[English](README.md) | [日本語](README.ja.md)

**TokenLighten**は、ファイル全体を繰り返し送る代わりに、コーディングエージェントへ対象を絞ったリポジトリコンテキストを提供する、ローカルファーストのMCPツールキットです。

公開するツールは`read_file`、`search_files`、`edit_file`の3つです。

## v0.13.1 リリース

**パブリックベータ・信頼性更新版。** TokenLighten v0.13.1は最新のソースリリースです。並行エージェント、複数対象の読み取り、ファイル作成を含む一括編集、継続処理、チェックリスト形式のタスクについて、3ツールのMCP構成を変えずに正しさを改善しました。フィードバックを反映する過程で、インターフェースや対応ワークフローが引き続き変更される場合があります。重要な作業はバックアップを取り、公開Issueには非公開のソースコード、認証情報、顧客データを含めないでください。

公開リリースには以下が含まれます。

- TokenLighten CLIとMCPサーバー
- 開発者向けのソースコードと公開パッケージテスト
- 単体で動作するVSIX形式のVS Code拡張機能

並行エージェント間のタスク状態を分離し、範囲指定を伴う複数対象読み取りと作成／編集の一括処理を安定させました。ローカルな削減量集計は、個々の呼び出しではなくタスク全体を単位にします。proof completionは引き続きデフォルト有効です。v0.12の旧リクエストfieldはv0.13.x中は受理しますが、advertiseされません。

## TokenLightenを使う理由

コーディングエージェントは、小さな変更を行うまでに、ファイルの探索、広い範囲の読み込み、同じコンテキストの再読込に複数ターンを費やすことがあります。TokenLightenはリポジトリをローカルで探索し、コンパクトな構造、シンボル、正確な範囲、範囲を限定した編集ハンドルを返します。

リポジトリのインデックス作成とコンテキスト選択はローカルCPU上で実行されます。TokenLighten自体がAIモデルを追加したり、リポジトリの内容をアップロードしたりすることはありません。エディタ、MCPクライアント、AIプロバイダーには、それぞれの設定と利用条件が引き続き適用されます。

削減効果は、リポジトリ、タスク、クライアント、モデルの動作によって異なります。TokenLightenが表示する使用量とコストはローカルな推定値であり、プロバイダーの請求記録ではありません。

## トークンとタスクコストの削減効果が期待できる場面

TokenLightenは、複数のファイル、パッケージ、文書形式にまたがって影響箇所を特定し、漏れなく正しく更新する必要があるタスクで、最も大きな効果を発揮するよう設計されています。変更箇所が既知の1か所に限定されるタスクでは、効果が小さくなると考えられます。

シンボル検索と参照検索は、該当する定義や呼び出し箇所を直接返せます。文書リーダーは、スプレッドシートをはじめとする対応形式から、ファイル全体を読み込まずに構造化された内容を抽出できます。これにより、リポジトリや文書を横断する作業に必要なコンテキストを集める際、検索と再読込の繰り返しを減らせます。

### 開発者ベンチマークから分かる傾向

v0.13.1の開発者ベンチマークでは、TokenLighten/nativeの集計コスト比は**0.809**でした。評価対象のタスクコストが、TokenLightenでは**19.1%低かった**という点推定です。両構成とも、評価した18タスクをすべて解決・検証しました。

タスク別の結果には差があります。

| タスクの傾向 | v0.13.1のnative比 |
|---|---:|
| 複数モジュールの判定を追い、下流の動作へ接続する | **29.0%低い** |
| 制御やモード遷移にまたがる関連バグを直す | **17.9%低い** |
| スプレッドシート仕様から評価ルールを実装する | **16.7%低い** |
| 範囲の狭い計算・データ整合性修正を行う | **7.3%低い** |
| 関連する機能経路を横断して優先度ロジックを実装する | **7.4%低い** |

複数の関連箇所を追跡・変更する作業では、引き続き大きな効果が見られました。一方、局所的な説明タスクでは固定コストの影響が出やすく、改善余地が残っています。

これらは開発者による観察結果であり、削減や品質を保証するものではありません。実際の結果はリポジトリ、タスク、クライアント、モデル、評価期間、料金によって異なり、ローカル推定値はプロバイダーの請求記録ではありません。詳しくは[v0.13.1リリースノート](release-docs/github-release-v0.13.1.md#benchmark-disclosure)を参照してください。

## VS Code拡張機能をインストールする（ビルド不要）

v0.13.1のGitHub Releaseから[tokenlighten-vscode-extension-0.13.1.vsix](https://github.com/Takayuki-Ishimaru/tokenlighten/releases/download/v0.13.1/tokenlighten-vscode-extension-0.13.1.vsix)をダウンロードしてください。Node.jsの導入やソースからのビルドは不要です。このリリースにはOS固有のネイティブバイナリが含まれないため、Windows、macOS、Linuxで同じVSIXを使用します。

インストール手順は次のとおりです。

1. VS Codeで**拡張機能**ビューを開きます。
2. **VSIXからのインストール…**を選びます。
3. ダウンロードしたファイルを選択します。

ターミナルからインストールすることもできます。

```sh
code --install-extension tokenlighten-vscode-extension-0.13.1.vsix
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

このnatural自動読込によるセットアップ（`tl workspace setup`が管理するAGENTS.md/CLAUDE.mdガイドブロックとワークスペースのMCP設定）は、本番環境でTokenLightenを運用する際の正規の経路です。開発者による比較では、同じガイド文を毎回プロンプトへ手動注入した場合とほぼ同等でした。セットアップ後も管理ガイドブロックを残してください。削除すると計測コストが大きく増え、セッション間で指示がずれる原因にもなります。詳しい説明と、Claude CodeとCodexへのマシン全体登録を行う`tl clients activate`については、[はじめに](release-docs/getting-started.md#set-up-a-workspace)を参照してください。

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

v0.13.1では、完全なパッケージテストをUbuntuとmacOSのCIゲートにしています。Windows CIでは、ソースのビルド、同梱CLI、依存関係のライセンスと通知、実行時依存関係の監査、診断を確認します。一部のテストfixtureがまだWindowsへ移植できていないため、完全なパッケージテストはWindowsのリリースゲートではありません。これはWindowsやVSIXのインストールが非対応であることを意味せず、Windows固有のテスト範囲は今後拡充します。

## ドキュメント

- [はじめに](release-docs/getting-started.md)
- [MCPツール](release-docs/mcp-tools.md)
- [VS Code拡張機能](release-docs/vscode-extension.ja.md)
- [対応言語とファイル形式](release-docs/language-support.md)
- [プライバシー、セキュリティ、サポート](release-docs/privacy-security-support.md)
- [ライセンスと利用方針](release-docs/licensing.md)

既存の`docs/`ディレクトリは開発履歴であり、公開するv0.13.1ソースリリースには含まれません。

## セキュリティとサポート

### 依存関係監査のスナップショット

2026-08-30にv0.13.1リリース候補を監査した時点で、`npm audit --omit=dev`と開発用依存関係を含む完全な`npm audit`はいずれも**脆弱性0件**を報告しました。

これは特定日時点の依存関係監査であり、脆弱性が存在しないことを保証するものではありません。監査情報は公開後に変化する可能性があります。実行時依存関係には`npm audit --omit=dev`、開発環境全体には`npm audit`を再実行してください。

サーバーは`--allow-write`を指定しない限り読み取り専用です。脆弱性を報告する前に[SECURITY.md](SECURITY.md)、ベストエフォートのサポート方針については[SUPPORT.md](SUPPORT.md)を確認してください。公開Issueには認証情報、非公開のソースコード、顧客データ、未加工のログを投稿しないでください。

## ライセンス

TokenLightenはソースアベイラブルのソフトウェアであり、OSI承認のオープンソースライセンスではありません。個人利用、勤務先や顧客の業務における個人としての利用、組織内利用、適切な表示を伴う個人的かつ非組織的な再配布は、リリースの利用条件で許可されます。製品／サービスへの組み込み、および組織的または商用の再配布には、Takayuki Ishimaru（GitHub: [@Takayuki-Ishimaru](https://github.com/Takayuki-Ishimaru)）の事前の書面による許可が必要です。

リリースに含まれる`LICENSE`が正式な利用条件です。平易な要約は[ライセンスと利用方針](release-docs/licensing.md)を参照してください。
