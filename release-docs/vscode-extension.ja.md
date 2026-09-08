# VS Code拡張機能

[English](vscode-extension.md) | [日本語](vscode-extension.ja.md)

TokenLightenのVS Code拡張機能は、CLI、MCPサーバー、パーサー、必要なアセットを1つのVSIXへ同梱します。別途`tl`をインストールする必要はありません。

## ビルドせずにインストールする

v0.14.2のGitHub Releaseから**[tokenlighten-vscode-extension-0.14.2.vsix](https://github.com/Takayuki-Ishimaru/tokenlighten/releases/download/v0.14.2/tokenlighten-vscode-extension-0.14.2.vsix)**をダウンロードしてください。同じVSIXをWindows、macOS、Linuxで使用できます。

1. **拡張機能**を開きます。
2. **VSIXからのインストール…**を選びます。
3. ダウンロードしたファイルを選びます。
4. 求められた場合はVS Codeを再読み込みします。

~~~bash
code --install-extension tokenlighten-vscode-extension-0.14.2.vsix
~~~

ソースからビルドする場合:

~~~bash
npm install
npm run package -w tokenlighten-vscode-extension
~~~

## ワークスペースをセットアップする

信頼済みのプロジェクトフォルダでTokenLightenビューを開き、**このワークスペースをセットアップ**を選択します。対応クライアントとTokenLighten管理のAI向け指示を設定し、管理ブロック外の内容は保持します。

ワークスペーススイッチでTokenLightenを有効／無効にできます。セットアップを再実行すると再び有効になり、セッション単位のnative commandを使うと通常設定を変えずに一時的にTokenLightenを迂回できます。

v0.13.0ではMCP provider versionにschema stampを含めます。advertiseされるtool schemaが変わるとVS Codeがcache済み定義を自動更新するため、手動でprovider名を変えたりcacheを消したりする必要はありません。

`tokenlighten.toolSurface`設定（既定`full`）はadvertiseされるtool schemaを選びます: `full`は全能力、`code`はコード・プレーンテキスト・設定向けの`read_file`/`edit_file`/`search_files`のみ — より小さいschemaで、Office/archive/credential系の入力は単に拒否されるのではなくadvertised schema自体から除去されます。詳細は[MCPツール](mcp-tools.md#tool-surface)を参照してください。変更は上記と同じくschemaに影響する変更なので、VS Codeは同じ仕組みで自動更新します。

`tokenlighten.guideProfile`設定は、セットアップ時にAGENTS.md/CLAUDE.mdへ書き込むguideのサイズを選びます: `full`／`medium`／`compact`のいずれかです。未設定のままにすると賢いデフォルトが適用されます — 通常は`full`、`tokenlighten.toolSurface`が`code`のときは`compact`になります（コード専用サーバーではfull guideのOffice/archive/credential関連の説明を活かす場面がないため）。`tokenlighten.guideProfile`を明示的に設定すると、このデフォルトより常に優先されます。

## ステータスバーと診断

TokenLightenのステータスバーをクリックすると、診断、有効化／無効化／セットアップ、サイドバーを開く操作、状態確認を選べます。診断画面には次を表示します。

- 拡張機能とTokenLightenのバージョン、正確な`server_build`
- Node実行ファイルと解決済みサーバー起動コマンド
- ワークスペースルートと実効的な書き込み権限
- MCP／Codex登録ファイル、インストール済みguideと同梱guideのバージョン
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
| `tokenlighten.guideProfile` | `full` | セットアップ時に書き込むguideのサイズ: `full`／`medium`／`compact`。未設定の場合、`tokenlighten.toolSurface`が`code`のときは`full`ではなく`compact`を書き込みます。明示的に設定した値は常にこのデフォルトより優先されます。 |

デスクトップアプリケーションは公開v0.14.2リリースに含まれません。