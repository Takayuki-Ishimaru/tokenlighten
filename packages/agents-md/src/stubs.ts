// Plain data output — no meta envelope. See docs/00-postmortem.md §2.2.
//
// Canonical 5-stub target definitions.
// Spec: docs/components/04-agents-md-generator.md §5 target table.
//
// Windsurf and Roo are dropped — they natively read AGENTS.md.
// Cursor, Cline, and Continue use their current tool-native rule paths.

import type { StubTarget } from "@tokenlighten/types";

/**
 * The 6 canonical stub targets for tools that do not natively read AGENTS.md.
 * Order: claude, copilot, cursor, cline, continue, copilot-agent.
 *
 * "copilot-agent" (added 2026-09-19) is a whole VS Code Copilot Chat custom
 * agent file, not a managed block inside a rules file like the other 5 — see
 * `StubTargetId`'s own doc comment in @tokenlighten/types for why it is
 * conditionally included by callers instead of always processed.
 */
export const STUB_TARGETS: readonly StubTarget[] = [
  {
    id: "claude",
    file: "CLAUDE.md",
    injectionMode: "managed-block",
  },
  {
    id: "copilot",
    file: ".github/copilot-instructions.md",
    injectionMode: "managed-block",
  },
  {
    id: "cursor",
    file: ".cursor/rules/tokenlighten.mdc",
    injectionMode: "managed-block",
  },
  {
    id: "cline",
    file: ".clinerules/tokenlighten.md",
    injectionMode: "managed-block",
  },
  {
    id: "continue",
    file: ".continue/rules/tokenlighten.md",
    injectionMode: "managed-block",
  },
  {
    id: "copilot-agent",
    file: ".github/agents/tokenlighten-explore.agent.md",
    injectionMode: "managed-block",
  },
] as const;

/** Map from StubTargetId to its file path for quick lookup. */
export const STUB_TARGET_BY_ID: Readonly<Record<string, StubTarget>> =
  Object.fromEntries(STUB_TARGETS.map((t) => [t.id, t]));
