# Managed environments

This page is for administrators and security teams evaluating or deploying
TokenLighten on machines they do not fully control themselves — fleet
management, AppLocker/WDAC-restricted Windows images, egress-filtered
networks, or organization-managed VS Code/Claude Code/Cursor policies. If you
are installing TokenLighten for yourself, see [Getting started](getting-started.md)
instead.

## The identity to allowlist

An archive install (`tl-setup` / `tl install`) gives every host on the
machine the same, version-independent command line:

| Platform | `command` | `args` prefix |
|---|---|---|
| macOS | `~/Library/Application Support/tokenlighten/bin/node` | `~/Library/Application Support/tokenlighten/bin/tl.js mcp start --stdio` |
| Linux | `~/.local/share/tokenlighten/bin/node` | `~/.local/share/tokenlighten/bin/tl.js mcp start --stdio` |
| Windows | `%LOCALAPPDATA%\tokenlighten\Data\bin\node.exe` | `%LOCALAPPDATA%\tokenlighten\Data\bin\tl.js mcp start --stdio` |

`<home>` (the directory above `bin/`) can be redirected with the `--home
<dir>` install flag or the `TOKENLIGHTEN_HOME` environment variable; if your
policy points it elsewhere, allowlist the redirected path instead of the
default above. This identity does not change across TokenLighten upgrades —
`bin/node` and `bin/tl.js` are replaced in place, not renamed — so an
allowlist entry written once does not need to be revisited every release,
only re-verified after a Node.js security re-release (see below).

## The VS Code extension uses a different command line

When TokenLighten is set up through the VS Code extension's **Set up this
workspace** rather than a standalone archive, the runtime is VS Code's own
Electron process, not the bundled Node.js binary: `command` is VS Code's own
executable, invoked with `ELECTRON_RUN_AS_NODE=1`. This is unchanged from
earlier TokenLighten releases, so an environment that already allowlisted it
needs no new entry for VSIX-only users. If an archive install runs on the
same machine afterward, it replaces this identity with the bundled-Node one
above for every host it registers; the two paths converge rather than
producing two separate live servers (see the release notes' compatibility
section).

## What is written, and where

- **Machine directory** (`<home>` above): the staged application
  (`app/<version>/`, older versions kept until `--prune`), the bundled
  runtime (`bin/node` or `bin/node.exe`), the regenerated launcher
  (`bin/tl.js`), a human-facing shim (`bin/tl` or `bin/tl.cmd`, never spawned
  by hosts), and `install.json` — the single record of what this machine
  install has registered.
- **Per-host files**, only for hosts actually detected: a vendor-CLI command
  for Claude Code, Codex, and Gemini CLI; a config-file write for Copilot CLI
  (`~/.copilot/mcp-config.json`); a printed, pasteable snippet for anything
  else (`tl clients snippet` reproduces it on demand without writing
  anything).
- **Per-workspace files**, only for workspaces passed to `tl-setup`/`tl
  install --workspace`: `.vscode/mcp.json` (GitHub Copilot Chat), `.mcp.json`
  (Claude Code, project scope), `.codex/config.toml` (Codex, project scope),
  and the TokenLighten guide blocks in that workspace's `AGENTS.md`/
  `CLAUDE.md` (sentinel-delimited; content outside the managed block is left
  alone).

In addition to `<home>` and the given workspace(s), registration updates the
selected hosts' user-level configuration. User-level files for Cursor,
Windsurf, Kiro, Amazon Q, and VS Code's own user-level `mcp.json` are not
written by this release; `tl clients snippet` prints entries for manual setup.

## No network calls of its own

`tl-setup` and `tl install` do not contact any TokenLighten-operated
service. The only network access in the install flow is the archive download
itself (done by whoever downloads it — a browser, a script, or your software
distribution tooling — not by `tl-setup`). Building an archive from source
downloads Node.js from `nodejs.org`, but that happens at build time, on the
machine producing the release, never during `tl-setup` on an end-user
machine. At runtime, the installed MCP server takes requests only from the
host process that spawned it over stdio; it does not open outbound
connections on its own.

## Usage log

The install records local usage to `<home>/usage.log`. It never leaves the
machine and is not transmitted anywhere by TokenLighten. Set
`TOKENLIGHTEN_USAGE_LOG=off` in the host's environment to turn off local
usage recording. The installer's `--read-only` flag controls workspace
editing separately and does not disable usage recording.

## Write posture

Generated host and workspace entries default to write-enabled
(`--allow-write` on the MCP server they launch), the same default
`tl workspace setup` has used. Pass `--read-only` at install time to omit
`--allow-write` from every entry this run writes; mixed postures across
workspaces are supported by running `tl install --workspace <path>
--read-only` for only the workspaces that need it.

## Bundled Node.js and its signature

Each archive embeds one official Node.js LTS binary, downloaded from
`nodejs.org` and checksum-verified against `nodejs.org`'s own
`SHASUMS256.txt` at build time (`tl doctor` reports the exact embedded
version on an installed machine). The macOS and Windows binaries are
code-signed by their publisher. Inspect the binary you received with
`codesign -dv --verbose=4 <path-to-node>` on macOS, or
`Get-AuthenticodeSignature <path-to-node.exe>` in Windows PowerShell, before
creating a publisher-based allowlist rule.

On macOS, `tl install` clears the quarantine attribute on the copy of the
runtime it stages under `<home>` (its own copied payload only, never a
system-wide change) so the extracted binary is not blocked by Gatekeeper on
first launch.

## AppLocker / WDAC

Default Windows AppLocker rules cover only `%windir%` and `%programfiles%`.
`%LOCALAPPDATA%\tokenlighten\Data\bin\node.exe` is user-writable and outside
both, so a default-deny AppLocker or WDAC policy blocks it unless you either:

- add a publisher rule for the Node.js code-signing certificate (confirm the
  certificate details with `Get-AuthenticodeSignature` before writing the rule), or
- install under an already-approved path with `--home <admin-approved dir>`.

## `SHA256SUMS` and reading the scripts before you run them

Every archive release ships a `SHA256SUMS` file alongside the four archives.
Verify the downloaded archive against it before extracting:

```sh
shasum -a 256 -c SHA256SUMS
```

`tl-setup` (POSIX) and `tl-setup.cmd` (Windows) are short, human-readable
scripts, not compiled binaries — read them before running in any
policy-sensitive environment. In full, they are:

```sh
#!/bin/sh
set -eu
DIR=$(cd "$(dirname "$0")" && pwd)
exec "$DIR/runtime/node" "$DIR/tl-cli.js" install --source "$DIR" "$@"
```

```bat
@echo off
setlocal
"%~dp0runtime\node.exe" "%~dp0tl-cli.js" install --source "%~dp0." %*
exit /b %ERRORLEVEL%
```

Both simply run the sibling bundle under the sibling runtime with no
downloads and no `PATH` lookups; all further behavior is `tl install` itself
(`packages/cli/src/commands/install.ts` in the source repository).

There is no npm provenance attestation for this distribution channel — the
archives are not published through the npm registry, so `SHA256SUMS` plus
the code-signing verification above are the integrity controls that apply
here, not npm's provenance chain.

## Proxy note

`tl-setup` makes no network calls of its own (see above), so the only
network access to plan for is the archive download. Route that through
whatever proxy or allowlist you already use for GitHub Release downloads
(`github.com` and its release-asset CDN,
`objects.githubusercontent.com`).

## Per-host allowlist entries

- **VS Code**: `chat.mcp.access` and org-managed `allowedMcpServers` gate
  whether an MCP server may run at all; `chat.mcp.collisionBehavior`
  (default `"disable"`) governs what happens when more than one same-label
  definition exists for one workspace — TokenLighten's extension suppresses
  its own provider definition once a workspace's `.vscode/mcp.json` carries
  a managed entry, so a set-up workspace normally has exactly one enabled
  definition regardless of this setting. `tl doctor` reports a
  `"suffix"` collision behavior as informational (it would run two
  concurrent servers instead of disabling one).
- **Claude Code**: an admin-managed `managed-mcp.json` /
  `allowedMcpServers` policy gates which servers a user's `claude mcp
  add-json` may register.
- **Cursor**, **Windsurf**, **Gemini CLI**: these hosts have their own
  admin allowlist mechanisms (an admin pattern for Cursor, a regex allowlist
  for Windsurf, an admin allowlist for Gemini CLI). TokenLighten's writer
  support does not include Cursor and Windsurf in this release; consult
  each vendor's own documentation for the allowlist
  pattern to add for the identity above in the meantime.

## Node.js security re-release policy

TokenLighten pins one Node.js LTS line per release and embeds a
checksum-verified binary at build time. When a Node.js security release
lands on that line, the project re-releases the archives with the patched
binary as soon as practical. Run `tl doctor` to see the
embedded Node.js version on an installed machine, and compare it against the
current Node.js release schedule if you need to confirm a specific machine
is patched.
