/**
 * tl help / --help — print top-level usage.
 *
 * Output policy: plain data — no meta envelope.
 * See docs/00-postmortem.md §2.2 for rationale.
 */

import { readFileSync } from "fs";
import { createRequire } from "module";

/** Same pattern as commands/version.ts: read our own package.json at call
 *  time so this banner can't go stale again next release. */
function cliVersion(): string {
  try {
    // require.resolve (not a hardcoded "../.." from our own compiled
    // location) so this also works from a single-file bundle — see
    // packages/vscode-extension/scripts/bundle-cli.mjs.
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("@tokenlighten/cli/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

const buildUsage = (version: string): string => `\
tl — TokenLighten CLI v${version}

Usage: tl <command> [options]

Commands:
  config path              Print canonical config.toml path
  config get <key>         Read config value (dot-path key)
  config set <key> <val>   Write config value (atomic)
  skeleton build           Generate .repo-skeleton.md (delegates to @tokenlighten/skeleton-engine)
  skeleton check           Verify AGENTS.md skeleton block is current (CI gate)
  agents update            Write AGENTS.md stubs (delegates to @tokenlighten/agents-md)
  setup [--check]          Interactive prereq detection + install (Node/Python/git); --check aliases 'doctor --json'
  workspace setup          One-step AI rules + project-scoped MCP setup
  clients status           Inspect machine registration for Claude Code and Codex
  clients activate         Auto-register capability-confirmed hosts only
  clients select           Plan a profile from a request (add --apply to write)
  clients profile --client claude-code,codex --profile tl|native
                           Explicit tl/native profile switch (manual escape hatch)
  clients register         Register the global TokenLighten MCP server via vendor CLIs
  clients unregister       Remove managed global registrations via vendor CLIs
  logs summary             Show local token and cost-savings estimates
  logs export --output F   Export a privacy-reviewed local usage bundle
  doctor [--json]          Health checks: node version, config dir, tree-sitter, exceljs,
                           license-checker, MCP dist freshness, client registration
  install-hooks [--uninstall]
                           Add/remove 'tl skeleton check' pre-commit hook (opt-in)
  version                  Print CLI version
  help                     Print this help

  mcp start [--stdio] [--allow-write] [--workspace DIR] [--allowed-parent DIR]...
                           Spawn the Node MCP server (packages/mcp-server)
  mcp stop                 Stop the MCP server (SIGTERM → SIGKILL)
  mcp status               Check MCP server liveness via PID

`;

export function runHelp(): void {
  process.stdout.write(buildUsage(cliVersion()));
}
