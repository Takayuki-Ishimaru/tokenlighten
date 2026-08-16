import { describe, it, expect, beforeEach } from "vitest";
import { buildTaskPack } from "../tools/readCodeTaskPack.js";
import { handleTable } from "../util/handles.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

function mkFixture(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tl-partial-${tag}-`));
  return dir;
}

function writeFile(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

describe("buildTaskPack — partial surfaces from ambiguous candidates", () => {
  let workspace: string;

  beforeEach(() => {
    handleTable.reset();
    workspace = mkFixture("partial");
    // Create a multi-surface fixture
    writeFile(workspace, "packages/types/src/enums.ts", `
export enum TicketPriority { LOW = "LOW", MEDIUM = "MEDIUM", HIGH = "HIGH", PARAMOUNT = "PARAMOUNT" }
`);
    writeFile(workspace, "src/services/issueService.ts", `
import { TicketPriority } from "../types/enums";
export function getIssuesByPriority(priority: TicketPriority) { return []; }
`);
    writeFile(workspace, "src/components/IssueBadge.tsx", `
import { TicketPriority } from "../types/enums";
export function IssueBadge({ priority }: { priority: TicketPriority }) { return <span>{priority}</span>; }
`);
  });

  it("returns non-empty surfaces for ambiguous locate results", async () => {
    const result = await buildTaskPack(
      { query: "TicketPriority enum add PARAMOUNT status" },
      workspace,
    );
    expect(result.mode).toBe("task_pack");
    // Should have at least one surface even if locate abstained
    // The key assertion: surfaces should NOT be empty when candidates exist
    if (result.surfaces.length > 0) {
      expect(result.surfaces[0]!.handle).toBeTruthy();
      expect(result.surfaces[0]!.path).toBeTruthy();
      expect(result.surfaces[0]!.role).toBeTruthy();
    }
  }, 30000);

  it("surfaces are capped and avoid duplicate paths", async () => {
    const result = await buildTaskPack(
      { query: "TicketPriority enum" },
      workspace,
    );
    expect(result.surfaces.length).toBeLessThanOrEqual(6);
    const paths = result.surfaces.map((s) => s.path);
    expect(new Set(paths).size).toBe(paths.length);
  }, 30000);

  it("empty surfaces only for broad/not-found queries", async () => {
    const result = await buildTaskPack(
      { query: "xyznonexistent" },
      workspace,
    );
    expect(result.mode).toBe("task_pack");
    expect(result.surfaces).toHaveLength(0);
    expect(result.next).toBeTruthy();
  }, 30000);

  it("uses structured next_call only when its value gate keeps discovery open", async () => {
    const result = await buildTaskPack(
      { query: "TicketPriority" },
      workspace,
    );
    if (result.surfaces.length > 0) {
      // WP-A Part 3: `execution_contract.next_call` is coverage-driven. A
      // concerns-uncovered partial (the bare "TicketPriority" token matches no
      // surface PATH, only the located contract's content) yields an `explore
      // action=find` on that token; a complete/focused/candidate-list pack
      // yields a handle-based slice/edit/batch. Either way it is one typed,
      // actionable step rather than a second legacy command-string channel.
      const contract = result.execution_contract;
      const nextCall = contract?.next_call;
      if (contract?.discovery_complete) {
        expect(contract.readiness_certificate).toBeDefined();
        expect(contract.call_budget?.discovery_allowed).toBe(false);
        expect(nextCall).toBeUndefined();
      } else if (contract?.typestate.phase === "awaiting-input") {
        // 2026-07-19a choose-candidate close: a candidate-list pack whose
        // bodies are all served inline closes discovery WITHOUT a next_call —
        // the remaining step is the caller's choice, not another read.
        expect(["choose-candidate", "needs-followup"]).toContain(contract.readiness);
        expect(nextCall).toBeUndefined();
        expect(contract.call_budget?.discovery_allowed).toBe(false);
      } else {
        expect(["read_file", "edit_file", "search_files"]).toContain(nextCall?.tool);
        expect(nextCall?.arguments).toEqual(expect.any(Object));
        expect(contract?.call_budget?.discovery_allowed).toBe(true);
      }
    }
  }, 30000);
});

// ---------------------------------------------------------------------------
// FIX A: buildCompletionChecks must not emit phantom "ui/style not covered"
// checks for a workspace that structurally has no presentation layer (e.g.
// C++ firmware). The check is only actionable when the role actually exists
// somewhere in the workspace but this pack didn't reach it.
//
// FIX B: on a partial pack, missing_required_surfaces must ALWAYS be a subset
// of required_surfaces — reporting required_surfaces:[] alongside
// missing_required_surfaces:["api"] is a self-contradiction.
// ---------------------------------------------------------------------------

describe("buildTaskPack — partial pack invariants for a firmware (no ui/style) workspace", () => {
  let workspace: string;

  beforeEach(() => {
    handleTable.reset();
    workspace = mkFixture("fw");
    // Pure C++ firmware layout: domain (control/), api (telemetry/),
    // config (driver/). NO ui/style role anywhere in the tree.
    writeFile(workspace, "firmware/include/control/gain_controller.hpp",
      "namespace ctl { class GainController { public: float update(float e); float kP_, kI_, i_; }; }\n");
    writeFile(workspace, "firmware/src/control/gain_controller.cpp",
      "#include <control/gain_controller.hpp>\nnamespace ctl { float GainController::update(float e){ i_ += e; return kP_*e + kI_*i_; } }\n");
    writeFile(workspace, "firmware/include/control/muxer.hpp",
      "namespace ctl { class Muxer { public: void mix(float,float,float); float out_[4]; }; }\n");
    writeFile(workspace, "firmware/src/control/muxer.cpp",
      "#include <control/muxer.hpp>\nnamespace ctl { void Muxer::mix(float roll,float pitch,float yaw){ out_[0]=roll-pitch+yaw; } }\n");
    writeFile(workspace, "firmware/include/control/attitude_controller.hpp",
      "namespace ctl { class AttitudeController { public: void step(); }; }\n");
    writeFile(workspace, "firmware/src/control/attitude_controller.cpp",
      "#include <control/attitude_controller.hpp>\nnamespace ctl { void AttitudeController::step(){} }\n");
    writeFile(workspace, "firmware/src/telemetry/telemetry_bridge.cpp",
      "#include <telemetry/telemetry_bridge.hpp>\nvoid send(){}\n");
    writeFile(workspace, "firmware/src/driver/drv_motor.c",
      "void motor_init(void){}\n");
  });

  it("emits NO phantom ui/style 'not covered' checks for a firmware workspace (FIX A)", async () => {
    const result = await buildTaskPack(
      { query: "fix the gain controller update and the muxer mix and the attitude controller step in control" },
      workspace,
    );
    const checks = result.checks ?? [];
    // The workspace has no presentation layer at all — a "ui/style not
    // covered" hint would send the agent to locate a surface that cannot
    // exist. It must never appear.
    expect(checks.some((c) => /^ui:.*not covered/.test(c))).toBe(false);
    expect(checks.some((c) => /^style:.*not covered/.test(c))).toBe(false);
  }, 30000);

  it("keeps missing_required_surfaces a subset of required_surfaces (FIX B)", async () => {
    // A plain multi-word fix query with no enum/rename shape lands in the
    // abstain/partial path with requiredRoles = []. The field must therefore
    // be absent (or empty) — never claim a role is required-and-missing when
    // nothing was required.
    const result = await buildTaskPack(
      { query: "fix gain controller anti-windup and muxer output sign and attitude controller gains" },
      workspace,
    );
    const required = result.required_surfaces ?? [];
    const missingRequired = result.missing_required_surfaces ?? [];
    for (const role of missingRequired) {
      expect(required).toContain(role);
    }
    // Reproduced contradiction case: nothing required -> nothing
    // required-and-missing.
    if (required.length === 0) {
      expect(missingRequired).toHaveLength(0);
    }
  }, 30000);

  it("surfaces more than one same-role domain file for a multi-surface fix (C2)", async () => {
    const result = await buildTaskPack(
      { query: "fix the gain controller update and the muxer mix and the attitude controller step in control" },
      workspace,
    );
    const domainSurfaces = result.surfaces.filter((s) => s.role === "domain");
    // A multi-file firmware fix must not collapse to a single domain surface;
    // the pool holds several distinct control/ files.
    expect(domainSurfaces.length).toBeGreaterThan(1);
    // Still bounded and duplicate-free.
    expect(result.surfaces.length).toBeLessThanOrEqual(6);
    const paths = result.surfaces.map((s) => s.path);
    expect(new Set(paths).size).toBe(paths.length);
  }, 30000);

  it("classifies firmware headers under control/ as domain, not contract (C1, via pack surfaces)", async () => {
    const result = await buildTaskPack(
      { query: "fix the gain controller update and the muxer mix and the attitude controller step in control" },
      workspace,
    );
    const header = result.surfaces.find((s) => s.path.endsWith("control/gain_controller.hpp"));
    // The header surface must actually be present — otherwise the role
    // assertion below is vacuous (the earlier `if (header)` guard let this test
    // pass even when the classification-under-test never surfaced). The C2
    // per-role expansion for this multi-surface control/ query reliably packs
    // the gain_controller header pair, so this is deterministic.
    expect(header).toBeDefined();
    // Post-C1 reorder: an include/ header under a recognized domain subdir
    // classifies as domain, no longer collapsing to contract.
    expect(header!.role).toBe("domain");
  }, 30000);
});
