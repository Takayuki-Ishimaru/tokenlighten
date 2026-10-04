// Plain data output — no meta envelope. See docs/00-postmortem.md §2.2.
//
// copilotGuide.ts — Copilot standard-setup evaluation (2026-10-02). Predicts,
// before `tl install` runs, whether its workspace step gives GitHub Copilot
// the standalone TokenLighten guide (.github/copilot-instructions.md) and
// stops Copilot attaching AGENTS.md — so the guide-size question (USER
// ruling 2026-09-20, commands.ts) is asked only while Copilot still attaches
// AGENTS.md, the one case its answer changes what Copilot pays. Mirrors
// packages/cli's own rule (workspace.ts `ensureCopilotGuide`): the final
// `chat.useAgentsMdFile` decides, a value the user wrote is never changed,
// and setup turns the attachment off only for an AGENTS.md that is absent or
// holds nothing but TokenLighten's managed block, in a settings file its safe
// merge can write. A window opened through a `.code-workspace` file is a
// separate case (`predictStandaloneInWorkspaceFile`): there only the workspace
// file's value counts.

import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
// A RUNTIME import from the dedicated subpath, never the package root — the
// same CJS-bundling reason as commands.ts's guideProfileDefault import.
import { copilotGuideModeForWorkspace, holdsOnlyManagedBlock } from "@tokenlighten/agents-md/copilotGuide";

/** `tl install --copilot-guide`'s values (packages/cli workspace.ts). */
export type CopilotGuideRequest = "standalone" | "agents-md" | "keep";

const AGENTS_MD_SETTING = "chat.useAgentsMdFile";

/**
 * Review 2026-10-02: whether `tl install` will leave Copilot reading the
 * standalone guide. `settingsValue` is `chat.useAgentsMdFile` as VS Code
 * reads it from this folder's own settings (comments allowed).
 * - an explicit `true` keeps AGENTS.md attached;
 * - an explicit `false` keeps it off — unless `agents-md` was asked for and
 *   that `false` is TokenLighten's own (setup then removes it);
 * - unset, only a `standalone` request turns it off, and only while AGENTS.md
 *   holds nothing of the user's and setup can safely write the settings file.
 */
export function predictStandaloneCopilotGuide(
  root: string,
  request: CopilotGuideRequest,
  settingsValue: boolean | undefined,
): boolean {
  if (settingsValue === true) return false;
  if (settingsValue === false) return request !== "agents-md" || !tokenLightenOwnsSetting(root, AGENTS_MD_SETTING);
  return request === "standalone" && agentsMdHoldsOnlyTokenLighten(root) && workspaceSettingsWritable(root);
}

/**
 * The same question for a window opened through a `.code-workspace` file. VS
 * Code registers `chat.useAgentsMdFile` window-scoped, so there only the
 * WORKSPACE FILE's value counts — never the folder's own `.vscode/settings.json`
 * that `tl install` writes. Standalone is therefore assumed only for a
 * workspace-file value that is `false` already: an unset value, or one the user
 * will be asked to confirm after setup (commands.ts's apply flow), is not
 * assumed, so the guide-size question is asked as it always was — never wrong.
 * `agents-md` withdraws a `false` this extension set (`ownedByTokenLighten`: its
 * workspaceState record) and leaves one the user wrote.
 */
export function predictStandaloneInWorkspaceFile(
  request: CopilotGuideRequest,
  workspaceFileValue: boolean | undefined,
  ownedByTokenLighten: boolean,
): boolean {
  if (workspaceFileValue !== false) return false;
  return request !== "agents-md" || !ownedByTokenLighten;
}

/** True when setup's safe merge can write `.vscode/settings.json`: absent, or a regular file holding a strict-JSON object (never JSONC, never through a symlink). */
export function workspaceSettingsWritable(root: string): boolean {
  const dir = join(root, ".vscode");
  const target = join(dir, "settings.json");
  try {
    if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) return false;
    if (!existsSync(target)) return true;
    if (lstatSync(target).isSymbolicLink()) return false;
    const parsed: unknown = JSON.parse(readFileSync(target, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/** True when TokenLighten's own record (`.tokenlighten/copilot-guide.json`) lists `key` as a setting it turned off. */
function tokenLightenOwnsSetting(root: string, key: string): boolean {
  const target = join(root, ".tokenlighten", "copilot-guide.json");
  try {
    if (!existsSync(target) || lstatSync(target).isSymbolicLink()) return false;
    const parsed: unknown = JSON.parse(readFileSync(target, "utf8"));
    const listed = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)["settings"]
      : undefined;
    return Array.isArray(listed) && listed.includes(key);
  } catch {
    return false;
  }
}

/** True when `root` has an AGENTS.md — the only case a workspace-level `chat.useAgentsMdFile: false` hides anything there. */
export function agentsMdPresent(root: string): boolean {
  return existsSync(join(root, "AGENTS.md"));
}

/**
 * True when the folder at `root` reads the compact standalone Copilot guide:
 * its own `.vscode/settings.json` turns the AGENTS.md attachment off
 * (`copilotGuideModeForWorkspace`, VS Code's JSONC included), which setup only
 * does while `.github/copilot-instructions.md` carries that guide. A
 * workspace-level `false` (commands.ts's `.code-workspace` apply flow) is safe
 * for a folder with an AGENTS.md only then — otherwise its Copilot file is the
 * pointer to the very AGENTS.md the setting would hide.
 */
export function copilotGuideIsStandalone(root: string): boolean {
  return copilotGuideModeForWorkspace(root) === "standalone";
}

export function agentsMdHoldsOnlyTokenLighten(root: string): boolean {
  const target = join(root, "AGENTS.md");
  try {
    if (!existsSync(target)) return true;
    let source = target;
    // packages/cli workspace.ts's own rule (`holdsOnlyTokenLightenGuide`): a
    // symlink is judged by the file it points at, and only when that file is
    // inside the folder -- an `AGENTS.md -> CLAUDE.md` workspace is folded by
    // the CLI, so the extension must not call its TokenLighten-only target
    // "your own content".
    if (lstatSync(target).isSymbolicLink()) {
      source = realpathSync(target);
      const rel = relative(realpathSync(root), source);
      if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
    }
    if (!statSync(source).isFile()) return false;
    return holdsOnlyManagedBlock(readFileSync(source, "utf8"));
  } catch {
    return false;
  }
}
