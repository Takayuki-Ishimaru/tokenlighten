# VS Code拡張機能

[English](vscode-extension.md) | [日本語](vscode-extension.ja.md)

TokenLightenのVS Code拡張機能は、CLI、MCPサーバー、パーサー、必要なアセットを1つのVSIXへ同梱します。別途`tl`をインストールする必要はありません。

## ビルドせずにインストールする

v0.15.3のGitHub Releaseから**[tokenlighten-vscode-extension-0.15.3.vsix](https://github.com/Takayuki-Ishimaru/tokenlighten/releases/download/v0.15.3/tokenlighten-vscode-extension-0.15.3.vsix)**をダウンロードしてください。同じVSIXをWindows、macOS、Linuxで使用できます。

1. **拡張機能**を開きます。
2. **VSIXからのインストール…**を選びます。
3. ダウンロードしたファイルを選びます。
4. 求められた場合はVS Codeを再読み込みします。

~~~bash
code --install-extension tokenlighten-vscode-extension-0.15.3.vsix
~~~

ソースからVSIXを作成する場合はNode.js 22以降を使用してください:

~~~bash
npm install
npm run package -w tokenlighten-vscode-extension
~~~

## ワークスペースをセットアップする

信頼済みのプロジェクトフォルダでTokenLightenビューを開き、**このワークスペースをセットアップ**を選択します。これは`tl install --from-extension --workspace <フォルダ> --clients none`を実行します——単体のアーカイブ（[はじめに](getting-started.md)を参照）と同じマシン単位のインストールですが、バンドルされたNode.jsではなくVS Code自体のNode.jsランタイムを使用します：必要に応じてマシンインストールをステージし、このワークスペースの対応クライアント設定とTokenLighten管理のAI向け指示を書き込みます（管理ブロック外の内容は保持）。このマシン上の他のホスト（Claude Code、Codex）は登録しません——`--clients none`により、これらの登録は明示的な操作のままです。登録するには、`tl clients activate`を実行するか、アーカイブの`tl-setup`を使用してください。

このワークスペースの`.vscode/mcp.json`に管理エントリが書き込まれるため、拡張機能自身のMCP providerはそのワークスペース向けの2つ目の定義を提供しなくなります——VS Codeの`chat.mcp.collisionBehavior`設定にかかわらず、`tokenlighten`のMCP定義は常に1つだけ有効になります。一度もセットアップしていないワークスペースでは、マシンインストールが存在する場合に限りフォールバック定義が使われます。VSIXをインストールしただけではサーバーは起動しません。先に**このワークスペースをセットアップ**を実行してください。

ワークスペーススイッチでTokenLightenを有効／無効にできます。セットアップを再実行すると再び有効になり、セッション単位のnative commandを使うと通常設定を変えずに一時的にTokenLightenを迂回できます。

v0.13.0ではMCP provider versionにschema stampを含めます。advertiseされるtool schemaが変わるとVS Codeがcache済み定義を自動更新するため、手動でprovider名を変えたりcacheを消したりする必要はありません。

`tokenlighten.toolSurface`設定（既定`full`）はadvertiseされるtool schemaを選びます: `full`は全能力、`code`はコード・プレーンテキスト・設定向けの`tl_read_file`/`tl_edit_file`/`tl_search_files`のみ — より小さいschemaで、Office/archive/credential系の入力は単に拒否されるのではなくadvertised schema自体から除去されます。詳細は[MCPツール](mcp-tools.md#tool-surface)を参照してください。変更は上記と同じくschemaに影響する変更なので、VS Codeは同じ仕組みで自動更新します。

`tokenlighten.guideProfile`設定は、セットアップ時にAGENTS.md/CLAUDE.mdへ書き込むガイドを選びます: `compact`（既定）／`medium`／`full`です。ツールサーフェスにかかわらず、同じフォルダーで使うCodex・Claude Codeも`compact`を既定とします。フォルダー・ワークスペース・ユーザーの明示設定は優先し、セットアップ時のガイドサイズ選択は表示しません。

コードの質問や変更作業には通常のCopilot **Agent**チャットを使えます。
**tokenlighten-explore**は、TokenLightenの読取・検索ツールだけを使用する
読み取り専用の選択肢として引き続き利用できます。

セットアップは短い自己完結型のCopilotガイドを作成します。安全に変更できる
場合はTokenLighten専用ガイドの重複添付を避け、ご自身の指示と設定を保持します。
`tokenlighten.copilotGuide`設定で`standalone`（既定）または`agents-md`を
選べます。CLIでは`--copilot-guide keep`で既存構成を維持できます。

VS Codeのセットアップは、新しいローカルAgentチャット向けのSessionStart
ヒントも作成します。信頼済みワークスペース、有効な`chat.useHooks`、PATH上の
`node`が必要です。既存フックとユーザー編集を保持し、ツールの権限は変更しません。
`tl workspace setup --clients vscode --copilot-session-context keep`で
既存のフック構成を維持できます。無効化またはnative切替時には、TokenLightenが
管理するCopilotガイドも無効になります。

v0.15.3へアップグレードした後は、**このワークスペースをセットアップ**を
再実行し、新しいエージェントセッションを開始するかMCPクライアントを再接続
してください。管理ガイド、Copilot設定、接頭辞付きツール名を更新できます。
応答をインラインに保持する設定とCLIの変更回避オプションは、
[既存ワークスペースの更新](getting-started.md#refresh-an-existing-workspace-after-upgrading)
を参照してください。

拡張機能からのセットアップは、生成するMCP設定で書き込みを有効にします。
読み取り専用の設定にする場合は、CLIで`tl workspace setup --read-only`を
実行してください。拡張機能のセットアップを再実行すると、書き込みは再び有効になります。

## アンインストール

**TokenLighten: このマシンからTokenLightenをアンインストール**（コマンド`tokenlighten.uninstallMachine`）を実行すると、マシンインストール（ステージ済みランタイム、ホストID）とTokenLighten管理のホスト登録（Claude Code、Codex）が削除されます。ご自身や他のツールが書いた登録は変更されず、その旨が報告されます。このマシンインストールがセットアップしたワークスペースでは、TokenLightenが管理するガイドブロックと、`.vscode/mcp.json`・`.mcp.json`・`.codex/config.toml`内の管理対象`tokenlighten`エントリも削除されます（編集したMCPファイルの隣に`.tl-backup`のコピーを残します）。ご自身の記述や他のサーバーのエントリには触れません。Windowsでは、実行中のAIホストが使用しているランタイムファイルは、そのホストを閉じた後に削除されます。VSIXを削除してもマシンインストールは削除されません。先にこのコマンド、または[はじめに](getting-started.md#uninstall)に記載の絶対パス形式の`tl install --uninstall`（`<home>/bin`は`PATH`に追加されないため、そのままの`tl install --uninstall`では実行できません）を実行してください。

## ステータスバーと診断

TokenLightenのステータスバーをクリックすると、診断、有効化／無効化／セットアップ、サイドバーを開く操作、状態確認を選べます。診断画面には次を表示します。

- 拡張機能とTokenLightenのバージョン、正確な`server_build`
- Node実行ファイルと解決済みサーバー起動コマンド
- ワークスペースルートと実効的な書き込み権限
- MCP／Codex登録ファイル、インストール済みguideと同梱guideのバージョン
- `install_consistency`：マシンインストールのバージョンと、この拡張機能に同梱されたバージョン、`PATH`上の`tl`との比較
- 直近のTokenLighten呼び出し（tool／mode／kind／所要時間／エラーコード）

診断リングはローカルに保存され、query本文、パス、handle、ファイル内容を記録しません。`TOKENLIGHTEN_USAGE_LOG=off`を指定すると、usage記録と診断リングの両方が無効になります。

## 使用量と校正

サイドバーはローカルの使用量を表示し、計測値と代替の推定値を区別します。これらの推定値はプロバイダーの請求記録ではありません。

## プライバシーと適用範囲

リポジトリのインデックス作成とコンテキスト選択はローカルで実行されます。拡張機能自体がモデルを追加したり、内容をアップロードしたりすることはありません。モデルプロバイダーへのリクエストはコーディングエージェント側の責任です。ワークスペースを変更する操作には信頼済みワークスペースが必要です。

## 設定

| 設定 | デフォルト | 説明 |
|---|---:|---|
| `tokenlighten.enabled` | `true` | 現在のワークスペースでTokenLightenを有効／無効にします。 |
| `tokenlighten.updateCheck.enabled` | `true` | 起動時に新しいVSIXの公開を確認します。インストールには常にユーザー操作が必要です。 |
| `tokenlighten.language` | `auto` | VS Codeの表示言語を自動使用するか、英語／日本語を選択します。 |
| `tokenlighten.toolSurface` | `full` | advertiseされるMCP tool surface: `full`（全能力）または`code`（コード・プレーンテキスト・設定のみ、より小さいtool schema）。変更には再接続が必要です。 |
| `tokenlighten.copilotGuide` | `standalone` | Copilotガイドの形式：短い自己完結型、共通AGENTS.md、または既存構成の維持。 |
| `tokenlighten.guideProfile` | `compact` | セットアップ時に書き込む共通ガイド: `compact`／`medium`／`full`。どちらのツールサーフェスでも明示設定を優先します。 |

デスクトップアプリケーションは公開v0.15.3リリースに含まれません。
