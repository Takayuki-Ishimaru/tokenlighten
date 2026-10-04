// Plain data output — no meta envelope. See docs/00-postmortem.md §2.2.
//
// Copilot standard-setup evaluation (2026-10-02): which TokenLighten guide
// GitHub Copilot Chat reads. Copilot attaches AGENTS.md in full to EVERY
// request, so the full guide is a fixed per-session cost there
// (~3.4k tokens, the dominant TokenLighten overhead the evaluation measured),
// while AGENTS.md itself is shared with Codex and Claude Code and must keep
// the full protocol for them (workspace.ts's WP-C1 §3 note; USER ruling
// 2026-09-20 in the VS Code extension's setup command).
//
//   standalone — Copilot gets its own complete, compact TokenLighten guide in
//                `.github/copilot-instructions.md` (a Copilot-only file), and
//                Copilot's AGENTS.md attachment is turned off
//                (`chat.useAgentsMdFile`) — only while AGENTS.md holds
//                nothing but TokenLighten's own block, so no instruction of
//                the user's is ever hidden from Copilot.
//   agents-md  — the earlier shape: Copilot reads AGENTS.md, and the Copilot
//                file is a short pointer to it.
//
// CLAUDE.md stays attached (verified 2026-10-02, VS Code 1.139.1): Copilot
// attaches it verbatim without expanding its `@AGENTS.md` import, the block
// TokenLighten writes there is ~280 B (about 70 tokens, not worth a switch),
// and `chat.useClaudeMdFile: false` would also hide the user's own global
// ~/.claude/CLAUDE.md. TokenLighten no longer writes that key at all.
//
// The workspace's own `.vscode/settings.json` is the record of which one
// applies: the mode is `standalone` exactly when Copilot reads
// `chat.useAgentsMdFile: false` there (`copilotGuideModeForWorkspace`), so
// every generator (`tl workspace setup`, `tl-agents update`/`check`,
// `tl clients …`) renders the Copilot files Copilot actually needs. VS Code
// registers that setting window-scoped: in a window opened through a
// `.code-workspace` file only the workspace file's `settings` (or the user's)
// apply, never a folder's `.vscode/settings.json` — `tl workspace setup`
// names such files, and the VS Code extension sets the workspace file's value.
//
// No template I/O and no import.meta.url (it only reads that settings file):
// the VS Code extension's CJS bundle imports it — the same reason
// guideProfileDefault.ts is split out.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SENTINEL_START, SENTINEL_END } from "./sentinel.js";

export type CopilotGuideMode = "standalone" | "agents-md";

/** Copilot Chat's switch for attaching AGENTS.md to every request. */
export const COPILOT_AGENTS_MD_SETTING = "chat.useAgentsMdFile";
/**
 * Copilot Chat's switch for attaching CLAUDE.md to every request: a legacy key
 * an earlier build wrote and TokenLighten no longer writes — it is withdrawn
 * from the workspace's settings, once, on the next setup run.
 */
export const COPILOT_CLAUDE_MD_SETTING = "chat.useClaudeMdFile";

/** A settings file larger than this is not read (VS Code settings are small). */
const MAX_SETTINGS_BYTES = 1024 * 1024;

/**
 * True when `text` holds nothing but TokenLighten's own managed block —
 * whitespace and a BOM aside — or nothing at all: everything such a file
 * gives Copilot is TokenLighten's guide, which `standalone` replaces. False
 * for any other text, and for a block that repeats or never closes.
 */
export function holdsOnlyManagedBlock(text: string): boolean {
  const body = text.replace(/^﻿/, "");
  const start = body.indexOf(SENTINEL_START);
  if (start < 0) return body.trim().length === 0;
  if (body.indexOf(SENTINEL_START, start + SENTINEL_START.length) >= 0) return false;
  const end = body.indexOf(SENTINEL_END, start + SENTINEL_START.length);
  if (end < 0) return false;
  const outside = body.slice(0, start) + body.slice(end + SENTINEL_END.length);
  return outside.trim().length === 0;
}

/**
 * `source` parsed the way VS Code reads a settings file: JSON plus `//` and
 * block comments and trailing commas (a leading BOM is ignored). String
 * contents are never touched. Throws, like `JSON.parse`, when the text is
 * not that dialect.
 */
export function parseJsonc(source: string): unknown {
  return JSON.parse(withoutTrailingCommas(withoutComments(source.replace(/^﻿/, ""))));
}

/** Index just past the JSON string literal that opens at `start` (a `"`). */
function skipString(source: string, start: number): number {
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    i += 1;
    if (ch === "\"") break;
  }
  return i;
}

function withoutComments(source: string): string {
  let out = "";
  let runStart = 0;
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\"") {
      i = skipString(source, i);
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      out += source.slice(runStart, i);
      while (i < source.length && source[i] !== "\n") i += 1;
      runStart = i;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      out += `${source.slice(runStart, i)} `;
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      runStart = i;
      continue;
    }
    i += 1;
  }
  return out + source.slice(runStart);
}

function withoutTrailingCommas(source: string): string {
  let out = "";
  let runStart = 0;
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\"") {
      i = skipString(source, i);
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < source.length && /\s/.test(source[j]!)) j += 1;
      if (source[j] === "}" || source[j] === "]") {
        out += source.slice(runStart, i);
        runStart = i + 1;
      }
    }
    i += 1;
  }
  return out + source.slice(runStart);
}

export type WorkspaceSettingsRead =
  | { readonly status: "absent" }
  | { readonly status: "unreadable" }
  | { readonly status: "ok"; readonly document: Readonly<Record<string, unknown>> };

/**
 * The workspace's `.vscode/settings.json` as VS Code reads it (comments and
 * trailing commas allowed, a symlink followed). Read-only and best-effort: a
 * missing file is `absent`; one that is not a regular file, exceeds 1 MiB,
 * or does not parse to an object is `unreadable`.
 */
export function readWorkspaceSettings(repoRoot: string): WorkspaceSettingsRead {
  const target = join(repoRoot, ".vscode", "settings.json");
  try {
    if (!existsSync(target)) return { status: "absent" };
    const stat = statSync(target);
    if (!stat.isFile() || stat.size > MAX_SETTINGS_BYTES) return { status: "unreadable" };
    const parsed = parseJsonc(readFileSync(target, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? { status: "ok", document: parsed as Record<string, unknown> }
      : { status: "unreadable" };
  } catch {
    return { status: "unreadable" };
  }
}

/** The guide Copilot reads under `settings`: `standalone` exactly when they turn its AGENTS.md attachment off. */
export function copilotGuideModeFromSettings(settings: WorkspaceSettingsRead): CopilotGuideMode {
  return settings.status === "ok" && settings.document[COPILOT_AGENTS_MD_SETTING] === false ? "standalone" : "agents-md";
}

/** The guide Copilot reads in the workspace at `repoRoot`, from its own `.vscode/settings.json`. */
export function copilotGuideModeForWorkspace(repoRoot: string): CopilotGuideMode {
  return copilotGuideModeFromSettings(readWorkspaceSettings(repoRoot));
}
