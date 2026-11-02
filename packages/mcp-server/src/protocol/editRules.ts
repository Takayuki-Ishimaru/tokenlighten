// What a model needs to know only once it is changing files. These sentences were
// in the compact guide, where a session that only reads paid for them on every
// request (csv probe, 2026-11-01: the guide and schemas were TokenLighten's whole
// cost gap). They now ride the first reply of an edit in a session, like
// `server_build`. A subagent sharing the server's session does not get them again;
// the edit tool's own description carries what a call needs. No client means a test
// harness, a direct caller, or the opt-in modern transport without
// TOKENLIGHTEN_CLIENT_ID (it captures no clientInfo), whose replies stay as they were.
// A reply with no room under the client's ceiling leaves them to a later one.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Kind } from "@tokenlighten/types";

import { claimEditRulesAnnouncement } from "../state/session.js";
import { portableSlimEnabled } from "../util/flags.js";
import { isCopilotCliClient } from "./clientAdvertisement.js";
import { resolveClientProfile } from "./codec/clientProfile.js";

export const EDIT_RULES = "New files/tests=edits:[{path,create:true,content}]+explicit cwd; empty frontier+create_target=create. Path edits: no prior read needed. edit.state_unknown=>recovery first. Never retry failed edit verbatim. Use returned verification kit; no closure pull just for it. Follow returned closure next/verification.next_call + nonempty recipe.gaps; run toolchain.test_entry from toolchain.test_entry_dir. Before editing, check nearby code/tests; find other spellings of the old value. Batch ready fixes/tests/style in ONE edits[]; verify. Repair related failures; retest. Stop on relevant pass; no extra harnesses, before/after builds, style edits; report other failures.";

type Row = Record<string, unknown>;

function startsAnEdit(payload: Row, kind: Kind): boolean {
  if (kind === "edit.applied" || kind === "edit.rolled_back") return true;
  const decision = payload["decision"];
  return kind === "read.task_pack" && decision !== null && typeof decision === "object" && (decision as Row)["kind"] === "act.edit";
}

/**
 * VS Code and Copilot CLI read `.github/copilot-instructions.md`. `tl install`'s
 * standalone guide there keeps these rules, because Copilot then attaches no
 * AGENTS.md, so a session with that guide would be told them twice. A workspace
 * with no such file (the extension's own registration, never set up) or the
 * compact guide there still needs them from the reply.
 */
function copilotGuideHoldsEditRules(clientId: string, workspace: string): boolean {
  if (resolveClientProfile(clientId).id !== "vscode" && !isCopilotCliClient(clientId)) return false;
  try {
    // served-bytes: not-served (one yes/no about the host's own guide file; nothing read is sent)
    return readFileSync(join(workspace, ".github", "copilot-instructions.md"), "utf8").includes("edit.state_unknown");
  } catch {
    return false;
  }
}

export function attachEditRulesOnce(payload: Row, kind: Kind, clientId: string | undefined, workspace: string | undefined, roomBytes: number): Row {
  if (clientId === undefined || workspace === undefined || !portableSlimEnabled() || !startsAnEdit(payload, kind)) return payload;
  if (EDIT_RULES.length + 20 > roomBytes || !claimEditRulesAnnouncement(workspace)) return payload;
  return copilotGuideHoldsEditRules(clientId, workspace) ? payload : { ...payload, edit_rules: EDIT_RULES };
}
