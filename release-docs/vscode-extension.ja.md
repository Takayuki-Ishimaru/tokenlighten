# VS Code拡張機能

[English](vscode-extension.md) | [日本語](vscode-extension.ja.md)

TokenLightenのVS Code拡張機能は、TokenLighten CLI、MCPサーバー、パーサー、必要なアセットをVSIXに同梱しています。パッケージ済みの拡張機能を使用する場合、`tl`を別途インストールする必要はありません。

## ビルドせずにインストールする

v0.9.1 Public BetaのGitHub Releaseから[tokenlighten-vscode-extension-0.9.1.vsix](https://github.com/Takayuki-Ishimaru/tokenlighten/releases/download/v0.9.1/tokenlighten-vscode-extension-0.9.1.vsix)をダウンロードしてください。Node.jsの導入やソースからのビルドは不要です。このリリースにはOS固有のネイティブバイナリが含まれないため、Windows、macOS、Linuxで同じVSIXを使用します。

VS Codeからインストールする手順は次のとおりです。

1. **拡張機能**を開きます。
2. 拡張機能ビューのメニューから**VSIXからのインストール…**を選びます。
3. ダウンロードした`.vsix`ファイルを選びます。
4. 求められた場合はVS Codeを再読み込みします。

コマンドラインからインストールすることもできます。

```bash
code --install-extension tokenlighten-vscode-extension-<version>.vsix
```

ソースからVSIXをビルドする場合は、次を実行します。

```bash
npm ci
npm run package -w tokenlighten-vscode-extension
```

依存関係を意図的に変更してlockfileを更新する場合に限り、`npm install`を使用してください。

## ワークスペースをセットアップする

信頼済みのプロジェクトフォルダを開き、アクティビティバーからTokenLightenビューを開いて、**このワークスペースをセットアップ**を選択します。セットアップ処理は、そのワークスペースで対応クライアントとTokenLighten管理のAI向け指示を設定します。

拡張機能には、ワークスペースごとにTokenLightenを有効または無効にするスイッチがあります。ワークスペースのセットアップを再実行すると、再び有効になります。一時的にTokenLightenを経由せず、ネイティブツールを使用するセッション単位のオプションもあります。

## プライバシーと適用範囲

リポジトリのインデックス作成とコンテキスト選択はローカルで実行されます。この拡張機能自体がモデルを追加したり、リポジトリの内容をアップロードしたりすることはありません。選択したコーディングエージェントは、自身がモデルプロバイダーへ送るリクエストについて引き続き責任を持ちます。

拡張機能が表示する使用量と削減量はローカルな推定値であり、プロバイダーの請求記録ではありません。ワークスペースを変更する操作には、信頼済みのVS Codeワークスペースが必要です。

## 設定

| 設定 | デフォルト | 説明 |
|---|---:|---|
| `tokenlighten.enabled` | `true` | 現在のワークスペースでTokenLightenを有効または無効にします。 |
| `tokenlighten.language` | `auto` | VS Codeの表示言語を自動的に使用するか、英語または日本語を明示的に選択します。 |

デスクトップアプリケーションはこのリリースに含まれません。
