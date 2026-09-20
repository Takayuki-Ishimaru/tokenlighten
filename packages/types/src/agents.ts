/**
 * Contracts for the AGENTS.md generator (component 4).
 * Canonical AGENTS.md + 5-stub injector for tools that do not natively
 * read AGENTS.md. See docs/components/04-agents-md-generator.md.
 */

/**
 * The parsed representation of a managed sentinel block found in a file.
 * Sentinel grammar (see docs/components/04-agents-md-generator.md §1):
 *
 *   <!-- tokenlighten:mcp-instructions:start -->
 *   <!-- tl-instructions-version: <version> -->
 *   <!-- tl-instructions-sha256: <sha256> -->
 *   <body>
 *   <!-- tokenlighten:mcp-instructions:end -->
 */
export interface SentinelBlock {
  /** 0-based character offset of the start sentinel line in the file. */
  start: number;
  /** 0-based character offset immediately after the end sentinel line. */
  end: number;
  /**
   * Version string embedded in the block (e.g. "2026-06-25-cheap").
   * Format: YYYY-MM-DD-tag.
   */
  version: string;
  /**
   * SHA-256 hex digest (64 hex chars) of the canonical block body,
   * used for manual-edit drift detection.
   */
  sha256: string;
  /**
   * Raw text of the managed block including both sentinels and all
   * inner lines (version-line, hash-line, prose body).
   */
  body: string;
}

/**
 * The 6 agent IDs that require a generated stub (do not natively read AGENTS.md).
 * Windsurf and Roo are excluded — they natively read AGENTS.md (see §5 target table).
 *
 * "copilot-agent" is additive (2026-09-19): unlike the other 5 (a managed
 * block inside a rules/instructions file), it renders a whole VS Code
 * Copilot Chat custom-agent file (`.github/agents/tokenlighten-explore.agent.md`)
 * that a parent agent's `runSubagent` tool can target by name so the child
 * also uses TokenLighten. It is only ever included in `injectAll`/`removeAll`
 * when the caller opts in (see `packages/cli/src/commands/workspace.ts`'s
 * `setupWorkspace()`, which adds it to the managed-target list only while
 * configuring the `vscode` client) and is deliberately excluded from
 * `injectForTarget`'s `TARGET_FILES` (that flow writes generic guide text
 * into a foreign repo with no notion of a live MCP server registration to
 * point a custom agent's `tools:` list at).
 */
export type StubTargetId = "claude" | "copilot" | "cursor" | "cline" | "continue" | "copilot-agent";

/**
 * Describes a single stub target: where to write and how to inject.
 * All stubs use `managed-block` injection mode.
 */
export interface StubTarget {
  /** Agent identifier. */
  id: StubTargetId;
  /**
   * Destination file path relative to repo root (POSIX forward-slash).
   * Examples: "CLAUDE.md", ".github/copilot-instructions.md",
   * ".cursor/rules/tokenlighten.md", ".clinerules",
   * ".continue/rules/tokenlighten.md".
   */
  file: string;
  /**
   * Injection strategy.
   * `managed-block`: idempotent sentinel-delimited block rewrite (the only
   * mode supported).
   */
  injectionMode: "managed-block";
}

/**
 * Result returned by the AGENTS.md generator after a `tl agents update` run.
 */
export interface GenerateResult {
  /**
   * Workspace-relative POSIX paths of files that were written (created or updated).
   */
  wrote: string[];
  /**
   * Files that were intentionally skipped (no write occurred).
   * Each entry explains why (e.g. "manual-guidance-detected",
   * "symlink-refused", "locked").
   */
  skipped: { path: string; reason: string }[];
  /**
   * Files where the on-disk content differed from the canonical block
   * (sha256 mismatch / version mismatch) and the generator chose not to
   * overwrite (warn / fail-build drift modes).
   * `expected` = canonical sha256, `actual` = sha256 of what is on disk.
   */
  drifted: { path: string; expected: string; actual: string }[];
}
