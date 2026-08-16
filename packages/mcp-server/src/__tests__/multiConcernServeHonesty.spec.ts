import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildTaskPack,
  resetPackDedupeCache,
  resetRoleInventoryCache,
} from "../tools/readCodeTaskPack.js";
import { handleTable } from "../util/handles.js";
import { resetAll as resetAllSessions } from "../util/session.js";

// Serve-honesty regression battery (2026-08-01, T05c rep2 forensics).
//
// Ground truth being pinned: a multi_concern pack that certified
// prepared/complete while (a) withholding the header contract that its served
// source contradicted, (b) never serving nor disclosing a file the query
// literally named (CONTRACT.md), and (c) serving a mid-file range with no
// content_completeness/remaining_ranges stamp — leaving a guide-obedient
// caller with zero sanctioned TL continuation and native IO as the only
// visible path (43-escape desertion, run 2026-08-01-semantic-signal5-1).

const tmpDirs: string[] = [];

function writeFile(workspace: string, relPath: string, content: string): void {
  const abs = path.join(workspace, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function fillerFunctions(prefix: string, count: number): string {
  const lines: string[] = [];
  for (let index = 0; index < count; index++) {
    lines.push(
      `static int ${prefix}_${index}(int value) {`,
      `  int shifted = value + ${index};`,
      `  return shifted * 2;`,
      `}`,
      ``,
    );
  }
  return lines.join("\n");
}

function makeFirmwareWorkspace(tag: string): string {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `tl-serve-honesty-${tag}-`)));
  tmpDirs.push(workspace);
  writeFile(
    workspace,
    "CONTRACT.md",
    [
      "# Firmware contract",
      "",
      "## Motor sign convention",
      "",
      "FR spins CW and contributes negative yaw; BL mirrors it.",
      "The mixer implementation must follow this table exactly.",
      "",
    ].join("\n"),
  );
  writeFile(
    workspace,
    "firmware/include/control/mixer.hpp",
    [
      "#pragma once",
      "",
      "// Contract: FR(0) = throttle + (+yaw), CCW prop — authoritative table.",
      "void mixQuadX(float yaw);",
      "",
    ].join("\n"),
  );
  writeFile(
    workspace,
    "firmware/src/control/mixer.cpp",
    [
      '#include "control/mixer.hpp"',
      "",
      "// Motor order and sign convention (guidance section):",
      "void mixQuadX(float yaw) {",
      "  float fr = -yaw;",
      "  float bl = -yaw;",
      "  (void)fr;",
      "  (void)bl;",
      "}",
      "",
    ].join("\n"),
  );
  writeFile(
    workspace,
    "firmware/src/mode/manager.cpp",
    [
      fillerFunctions("mode_prelude", 200),
      "int modeSwitch(int requested, int failsafe) {",
      "  int selected = requested;",
      "  if (failsafe != 0) {",
      "    selected = failsafe;",
      "  }",
      "  return selected;",
      "}",
      "",
      fillerFunctions("mode_epilogue", 200),
    ].join("\n"),
  );
  return workspace;
}

function makeCamelCaseWorkspace(tag: string): string {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `tl-serve-honesty-${tag}-`)));
  tmpDirs.push(workspace);
  writeFile(workspace, "package.json", JSON.stringify({ name: tag, type: "module" }) + "\n");
  writeFile(
    workspace,
    "src/LeanContract.ts",
    [
      "export function projectLeanContract(phase: string): string {",
      "  return `lean:${phase}`;",
      "}",
      "",
    ].join("\n"),
  );
  return workspace;
}

beforeEach(() => {
  handleTable.reset();
  resetAllSessions();
  resetPackDedupeCache();
  resetRoleInventoryCache();
});

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("buildTaskPack — multi_concern serve honesty (2026-08-01)", () => {
  it("serves the header pair for a non-concurrency concern, force-includes the query-named doc, and stamps file-relative partiality", async () => {
    const workspace = makeFirmwareWorkspace("pack");
    const result = await buildTaskPack({
      query: [
        "全部直して:",
        "① mixQuadX の yaw 符号が逆っぽい (CONTRACT.md に FR/BL の規定があるはず)",
        "② modeSwitch のモード遷移がどちらか片方しか反映されないことがある",
        "完了基準: 両方の根本原因を修正。",
      ].join("\n"),
      taskProfile: "multi_concern",
    }, workspace);

    const servedPaths = result.surfaces.map((surface) => surface.path);

    // (a) pair-contract enrichment: BOTH sides of the mixer header/source
    // pair are visible even though the concern wording carries no concurrency
    // keyword — pre-fix, only race/mutex-flavored concerns got their sibling,
    // so whichever side ranked as the concern primary hid the other (T05c
    // rep2: mixer.cpp served, contradicting mixer.hpp contract withheld).
    expect(servedPaths).toContain("firmware/include/control/mixer.hpp");
    expect(servedPaths).toContain("firmware/src/control/mixer.cpp");

    // (b) B1c parity: the file the query literally names is force-included
    // (pre-fix the multi_concern builder skipped augmentQueryNamedFileSurfaces
    // entirely, so CONTRACT.md was neither served nor disclosed).
    expect(servedPaths).toContain("CONTRACT.md");

    // (c) file-relative completeness: the mid-file concern serve must disclose
    // its complement as zoomable remaining_ranges (label-free when the embed
    // itself is whole) so the guide's zoom affordance exists. Pre-fix: a
    // windowed serve of a 2000-line file carried no disclosure at all.
    const manager = result.surfaces.find((surface) => surface.path === "firmware/src/mode/manager.cpp");
    expect(manager).toBeDefined();
    expect(manager?.remaining_ranges?.length ?? 0).toBeGreaterThan(0);

    // Enrichment must never veto concern coverage, and the route must remain
    // a handle-grounded action (edit, or a cautious inspect of the served
    // handles for a huge partial primary) — never a locate/awaiting dead end.
    // The zoom affordance itself is structural: the partial stamp above plus
    // remaining_ranges is what the guide's re-slice path keys off.
    expect(result.concerns?.every((concern) => concern.status === "covered")).toBe(true);
    expect(["edit_from_handles", "inspect_handles"]).toContain(result.route?.action);
    if (result.route?.action === "edit_from_handles") {
      expect(result.route?.reason).toContain("remaining_ranges");
    }
  });

  it("does not mark a genuinely served camelCase caller path as named-but-unserved", async () => {
    const workspace = makeCamelCaseWorkspace("case");
    const result = await buildTaskPack({
      query: "explain the projectLeanContract phase projection",
      paths: ["src/LeanContract.ts"],
      taskProfile: "answer",
    }, workspace);

    expect(result.surfaces.some((surface) => surface.path === "src/LeanContract.ts")).toBe(true);
    expect(result.missing.filter((item) => item.toLowerCase().includes("leancontract"))).toEqual([]);
  });
});
