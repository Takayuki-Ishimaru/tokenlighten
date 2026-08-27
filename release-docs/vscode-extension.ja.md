# VS Code拡張機能

[English](vscode-extension.md) | [日本語](vscode-extension.ja.md)

TokenLightenのVS Code拡張機能は、CLI、MCPサーバー、パーサー、必要なアセットを1つのVSIXへ同梱します。別途`tl`をインストールする必要はありません。

## ビルドせずにインストールする

v0.12.1のGitHub Releaseから**[tokenlighten-vscode-extension-0.12.1.vsix](https://github.com/Takayuki-Ishimaru/tokenlighten/releases/download/v0.12.1/tokenlighten-vscode-extension-0.12.1.vsix)**をダウンロードしてください。同じVSIXをWindows、macOS、Linuxで使用できます。

1. **拡張機能**を開きます。
2. **VSIXからのインストール…**を選びます。
3. ダウンロードしたファイルを選びます。
4. 求められた場合はVS Codeを再読み込みします。

~~~bash
code --install-extension tokenlighten-vscode-extension-0.12.1.vsix
~~~

ソースからビルドする場合:

~~~bash
npm install
npm run package -w tokenlighten-vscode-extension
~~~

## ワークスペースをセットアップする

信頼済みのプロジェクトフォルダでTokenLightenビューを開き、**このワークスペースをセットアップ**を選択します。対応クライアントとTokenLighten管理のAI向け指示を設定し、管理ブロック外の内容は保持します。

ワークスペーススイッチでTokenLightenを有効／無効にできます。セットアップを再実行すると再び有効になり、セッション単位のnative commandを使うと通常設定を変えずに一時的にTokenLightenを迂回できます。

## ステータスバーと診断

TokenLightenのステータスバーをクリックすると、診断、有効化／無効化／セットアップ、サイドバーを開く操作、状態確認を選べます。診断画面には次を表示します。

- 拡張機能とTokenLightenのバージョン、正確な`server_build`
- Node実行ファイルと解決済みサーバー起動コマンド
- ワークスペースルートと実効的な書き込み権限
- MCP／Codex登録ファイル、インストール済みguideと同梱guideのバージョン
- 直近のTokenLighten呼び出し（tool／mode／kind／所要時間／エラーコード）

診断リングはローカルに保存され、query本文、パス、handle、ファイル内容を記録しません。`TOKENLIGHTEN_USAGE_LOG=off`を指定すると、usage記録と診断リングの両方が無効になります。

## 使用量と校正

サイドバーは、paired calibrationによる実測とフォールバック推定を区別し、medium（12 paired samples）／high（24）信頼度までの進捗を表示します。これらはローカル推定値であり、プロバイダーの請求記録ではありません。

## プライバシーと適用範囲

リポジトリのインデックス作成とコンテキスト選択はローカルで実行されます。拡張機能自体がモデルを追加したり、内容をアップロードしたりすることはありません。モデルプロバイダーへのリクエストはコーディングエージェント側の責任です。ワークスペースを変更する操作には信頼済みワークスペースが必要です。

## 設定

| 設定 | デフォルト | 説明 |
|---|---:|---|
| `tokenlighten.enabled` | `true` | 現在のワークスペースでTokenLightenを有効／無効にします。 |
| `tokenlighten.updateCheck.enabled` | `true` | 起動時に新しいVSIXの公開を確認します。インストールには常にユーザー操作が必要です。 |
| `tokenlighten.language` | `auto` | VS Codeの表示言語を自動使用するか、英語／日本語を選択します。 |

デスクトップアプリケーションは公開v0.12.1リリースに含まれません。