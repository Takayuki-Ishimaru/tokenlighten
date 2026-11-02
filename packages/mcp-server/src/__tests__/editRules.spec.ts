import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { attachEditRulesOnce, EDIT_RULES } from "../protocol/editRules.js";
import { getSession } from "../state/session.js";

describe("edit_rules ride the first edit reply of a session", () => {
  let workspace: string;
  const answer = { decision: { kind: "act.answer" } };
  const editing = { decision: { kind: "act.edit" } };

  beforeEach(() => { workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-edit-rules-"))); });
  afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(workspace, { recursive: true, force: true }); });

  it("rides act.edit once, and never a reply that only reads", () => {
    expect(attachEditRulesOnce(answer, "read.task_pack", "claude-code", workspace, 9000)).toBe(answer);
    expect(attachEditRulesOnce(editing, "read.task_pack", "claude-code", workspace, 9000)).toEqual({ ...editing, edit_rules: EDIT_RULES });
    expect(attachEditRulesOnce(editing, "read.task_pack", "claude-code", workspace, 9000)).toBe(editing);
    expect(getSession(workspace).editRulesAnnounced).toBe(true);
  });

  it("rides the first edit outcome when no act.edit came before it", () => {
    const applied = { core: {} };
    expect(attachEditRulesOnce(applied, "edit.applied", "claude-code", workspace, 9000)).toHaveProperty("edit_rules", EDIT_RULES);
  });

  it("leaves a reply as it is with no client, with no room, or with the slim schemas off, and keeps the claim for later", () => {
    expect(attachEditRulesOnce(editing, "read.task_pack", undefined, workspace, 9000)).toBe(editing);
    expect(attachEditRulesOnce(editing, "read.task_pack", "claude-code", workspace, EDIT_RULES.length)).toBe(editing);
    vi.stubEnv("TL_PORTABLE_SLIM", "0");
    expect(attachEditRulesOnce(editing, "read.task_pack", "claude-code", workspace, 9000)).toBe(editing);
    vi.unstubAllEnvs();
    expect(getSession(workspace).editRulesAnnounced).toBe(false);
    expect(attachEditRulesOnce(editing, "read.task_pack", "claude-code", workspace, 9000)).toHaveProperty("edit_rules");
  });

  it("carries the rules the bench tied to edit-phase cost (v118: a passing check ends the phase; a verification kit needs no pull)", () => {
    for (const rule of [
      "New files/tests=edits:[{path,create:true,content}]+explicit cwd",
      "Path edits: no prior read needed",
      "edit.state_unknown=>recovery first",
      "Never retry failed edit verbatim",
      "Use returned verification kit; no closure pull just for it",
      "Follow returned closure next/verification.next_call + nonempty recipe.gaps",
      "run toolchain.test_entry from toolchain.test_entry_dir",
      "find other spellings of the old value",
      "Batch ready fixes/tests/style in ONE edits[]; verify",
      "Stop on relevant pass; no extra harnesses, before/after builds, style edits",
    ]) expect(EDIT_RULES).toContain(rule);
  });
});
