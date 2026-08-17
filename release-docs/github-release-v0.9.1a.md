# TokenLighten v0.9.1a Public Beta

This Public Beta refresh contains the Windows and VS Code fixes completed on 2026-08-17.

## What changed

- Fixed Windows workspace containment when drive-letter casing differs, such as `C:` versus `c:`. This resolves the search-to-read failure reproduced with Claude in VS Code on Windows.
- Added an optional VS Code startup check for newer published GitHub Releases, including Public Beta prereleases.
- When a newer release is found, TokenLighten offers to open the matching VSIX download in the browser. Network or API failures remain silent and do not affect MCP operation.
- Added English and Japanese UI text for `tokenlighten.updateCheck.enabled`.

## Install

Download `tokenlighten-vscode-extension-0.9.2.vsix` below, then use VS Code's **Extensions → Install from VSIX…** command.

The GitHub release is named `v0.9.1a`, while the extension manifest uses `0.9.2`. VS Code requires a numeric `major.minor.patch` extension version, and `0.9.2` correctly supersedes the earlier `0.9.1` Public Beta.

## 日本語

このPublic Betaには、2026-08-17に対応したWindowsとVS Codeの修正が含まれます。

- Windowsでドライブ文字の大文字・小文字（`C:`と`c:`など）が異なる場合に、同じワークスペースが範囲外と誤判定される問題を修正しました。Windows版VS Code内のClaudeで再現していた、検索後のファイル読み込み失敗を解消します。
- VS Code起動時に、Public Betaのプレリリースを含むGitHub Releasesから新しいVSIXを確認できるようにしました。
- 新しいリリースがある場合は、ブラウザーでVSIXのダウンロードを開けます。通信やAPIの失敗は表示せず、MCPの動作には影響しません。
- `tokenlighten.updateCheck.enabled`で起動時確認を無効にできます。

下の`tokenlighten-vscode-extension-0.9.2.vsix`をダウンロードし、VS Codeの**拡張機能 → VSIXからのインストール…**からインストールしてください。

GitHub上のリリース名は`v0.9.1a`ですが、拡張機能内部のバージョンは`0.9.2`です。VS Code拡張機能では数値3要素のバージョンが必要で、既存の`0.9.1` Public Betaから確実に更新するためです。

This is a prerelease. Back up important work and do not include private source code, credentials, customer data, or unsanitized logs in public issues.
