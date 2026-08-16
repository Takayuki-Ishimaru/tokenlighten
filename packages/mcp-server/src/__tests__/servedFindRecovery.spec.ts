/**
 * servedFindRecovery.spec.ts — the 2026-08-08 find-honesty wave (L2 + L3).
 *
 * GROUND TRUTH BEING PINNED. Bench run 2026-08-08-semantic-signal5-1, cell
 * T05c-aeroctl-fix-pack-rep2-a_tl_allowed: 20 discovery calls before the first
 * edit, against sibling reps that took 11 and 10. Three measured mechanisms,
 * all reproduced below with the cell's own shapes:
 *
 *  L2  `served_note` + per-file `served_this_session:true` fired on SIX
 *      separate find responses and was ignored 6/6 — passive prose with no
 *      protocol force. Two of the six (calls 11 and 12) re-served an IDENTICAL
 *      89-match result set under `drv_motor` then `drv_motor.h`.
 *  L3a a 0-match `find queries=["CW prop","yaw torque",...] path=CONTRACT.md`
 *      answered did_you_mean [drv_motor.h, drv_motor_pwm.c] by FILENAME
 *      similarity. The probes lived verbatim in mixer.hpp/mixer.cpp — both
 *      already served. Following the suggestion cost two dead calls.
 *  L3b the "edit-grade repeated-hit candidate … edit this handle without
 *      another locate/read" hint fired 5 times across the three reps and named
 *      a file that was actually edited 0/5 times.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TaskExecutionContract } from "@tokenlighten/types";

import { buildFindResponse, buildFindResponseForQueries } from "../features/search/find/findText.js";
import { applyServedFindProtocol } from "../features/search/find/servedFindEscalation.js";
import { handleTable } from "../util/handles.js";
import {
  getServedFindLedgerForTest,
  recordEditedPath,
  recordExecutionContract,
  recordReadPath,
  recordServedEditAdmissibility,
  recordServedRange,
  resetAll,
} from "../util/session.js";

const tmpDirs: string[] = [];

function mkWorkspace(tag: string): string {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `tl-find-honesty-${tag}-`)));
  tmpDirs.push(ws);
  return ws;
}

function writeFile(ws: string, relPath: string, content: string): void {
  const abs = path.join(ws, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

/** An edit-ready certificate over one served handle/path. */
function editContract(certificateId: string, handle: string, filePath: string): TaskExecutionContract {
  return {
    version: 1,
    state: "ready",
    readiness: "edit-ready",
    discovery_complete: true,
    next_action: "edit",
    max_additional_discovery_calls: 0,
    reason: "served",
    readiness_certificate: {
      version: 1,
      id: certificateId,
      task_fingerprint: `fp-${certificateId}`,
      profile: "change_propagation",
      obligations: [{
        id: "behavior-body",
        kind: "behavior-body",
        status: "proved",
        required: true,
        evidence: [{ handle, path: filePath, range: "1-40", symbol: "mixQuadX" }],
        reason: "callable body served",
      }],
      evidence_handles: [handle],
      action_frontier: [handle],
      falsification: { version: 1, checked: ["callable-body"], counterexamples: [], unresolved: [] },
      risk: {
        policy: "selective-reject",
        estimated_false_ready_risk: 0.01,
        max_false_ready_risk: 0.05,
        decision: "accept",
        factors: [],
      },
    },
    typestate: {
      phase: "prepared",
      certificate_id: certificateId,
      allowed_actions: ["edit", "challenge"],
      challenge_required_for: ["read", "search"],
    },
    call_budget: {
      version: 2,
      policy: "expected-decision-change",
      normalized_turn_cost: 0.18,
      expected_decision_change: 0.01,
      expected_value: 0.011,
      decision_threshold: 0.18,
      discovery_allowed: false,
      terminal_action: "edit",
      reason: "low value",
    },
  };
}

/**
 * The aeroctl shapes the cell actually ran against: an authoritative contract
 * document, and the mixer header/source pair whose comments carry the phrases
 * ("CW prop", "CCW prop", "front-right") the solver kept hunting for.
 */
function makeAeroctlWorkspace(tag: string): string {
  const ws = mkWorkspace(tag);
  writeFile(
    ws,
    "CONTRACT.md",
    [
      "# AeroCtl — Integration Contract (authoritative)",
      "",
      "### 7.6 `<control/mixer.hpp>`",
      "",
      "The mixer maps roll/pitch/yaw to four motor outputs.",
      "State estimation publishes yaw as part of the attitude triple.",
      "Motor drivers live behind drv_motor.h; see section 4.1.",
      "The drv_motor_pwm.c backend owns duty conversion.",
      "",
    ].join("\n"),
  );
  writeFile(
    ws,
    "firmware/include/control/mixer.hpp",
    [
      "#pragma once",
      "// FR (0) — front-right, CW prop, produces -yaw",
      "// BL (1) — back-left,  CW prop, produces -yaw",
      "// FL (2) — front-left, CCW prop, produces +yaw",
      "// BR (3) — back-right, CCW prop, produces +yaw",
      "void mixQuadX(float roll, float pitch, float yaw, float* out);",
      "",
    ].join("\n"),
  );
  writeFile(
    ws,
    "firmware/src/control/mixer.cpp",
    [
      '#include "control/mixer.hpp"',
      "// FR (0) — front-right, CW prop, produces -yaw",
      "// BL (1) — back-left,  CW prop, produces -yaw",
      "void mixQuadX(float roll, float pitch, float yaw, float* out) {",
      "  out[0] = roll + pitch + yaw;",
      "  out[1] = roll - pitch + yaw;",
      "}",
      "",
    ].join("\n"),
  );
  // Filename-similar decoys: "motor" is in their NAMES and nowhere else.
  writeFile(ws, "firmware/include/driver/drv_motor.h", "#pragma once\nvoid pwm_set(int idx, int duty);\n");
  writeFile(
    ws,
    "firmware/src/driver/drv_motor_pwm.c",
    ["#include \"driver/drv_motor.h\"", "void pwm_set(int idx, int duty) { (void)idx; (void)duty; }", ""].join("\n"),
  );
  return ws;
}

/**
 * Record a path as read AND fully covered by a served range, at its real
 * on-disk line count — the C3 range ledger needs both the file-level fact
 * (getReadPaths) and the line-level one (servedRangeLedger) to agree a path
 * is genuinely, wholly held; recordReadPath alone leaves the range ledger
 * empty, which C3 correctly reads as "nothing on this path is held yet".
 */
function serveWholeFile(ws: string, relPath: string): void {
  recordReadPath(ws, relPath);
  const totalLines = fs.readFileSync(path.join(ws, relPath), "utf8").split("\n").length;
  recordServedRange(ws, relPath, `sha-${relPath}`, 1, totalLines, totalLines);
}

/** Serve CONTRACT.md and the mixer pair, exactly as rep2's task pack did — in full, as the small real task pack actually would (see docSliver.spec.ts for the sliver case this is NOT). */
function servePackSurfaces(ws: string): void {
  serveWholeFile(ws, "CONTRACT.md");
  serveWholeFile(ws, "firmware/include/control/mixer.hpp");
  serveWholeFile(ws, "firmware/src/control/mixer.cpp");
}

function armCertificate(ws: string, certificateId = "cert-t05c"): string {
  const handle = handleTable.upsert({
    kind: "range",
    path: "firmware/src/control/mixer.cpp",
    range: "1-40",
    workspaceRoot: ws,
  }).id;
  recordServedEditAdmissibility(ws, { handles: [handle], paths: ["firmware/src/control/mixer.cpp"] });
  recordExecutionContract(ws, "fix the mixer yaw sign", editContract(certificateId, handle, "firmware/src/control/mixer.cpp"));
  return handle;
}

/** Run one find through the same path the dispatcher uses. */
function runFind(ws: string, args: Record<string, unknown>): { body: Record<string, unknown>; escalated: boolean } {
  const response = Array.isArray(args["queries"])
    ? buildFindResponseForQueries(
        { queries: (args["queries"] as string[]), ...(args["path"] ? { path: String(args["path"]) } : {}) },
        ws,
      )
    : buildFindResponse(
        { query: String(args["query"] ?? ""), ...(args["path"] ? { path: String(args["path"]) } : {}) },
        ws,
      );
  return applyServedFindProtocol(response, ws, args);
}

beforeEach(() => {
  handleTable.reset();
  resetAll();
});

afterEach(() => {
  handleTable.reset();
  resetAll();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// L2 — the all-served escalation state machine
// ---------------------------------------------------------------------------

describe("L2 — repeated all-served find escalates to protocol", () => {
  it("serves the FIRST all-served find in full and makes the signal machine-readable", () => {
    const ws = makeAeroctlWorkspace("first");
    servePackSurfaces(ws);
    armCertificate(ws);

    const first = runFind(ws, { action: "find", query: "yaw", path: "CONTRACT.md" });

    expect(first.escalated).toBe(false);
    // Nothing is withheld: the full response, snippets and all, still rides.
    expect(first.body["total_matches"]).toBeGreaterThan(0);
    const files = first.body["files"] as Record<string, unknown>[];
    expect(files[0]?.["snippets"]).toBeDefined();
    expect(files[0]?.["served_this_session"]).toBe(true);
    // THE fix for "ignored 6/6": a structured field beside the prose note.
    expect(first.body["all_served"]).toBe(true);
    expect(first.body["all_served_occurrence"]).toBe(1);
    expect(String(first.body["served_note"])).toContain("already served to you this session");
  });

  it("escalates the SECOND distinct all-served find with a truthful unlock", () => {
    const ws = makeAeroctlWorkspace("second");
    servePackSurfaces(ws);
    const editHandle = armCertificate(ws);

    // rep2 call 5 (`7.6`) then call 7 (`propeller rotation`) — two different
    // queries, both landing entirely inside CONTRACT.md, already served.
    const first = runFind(ws, { action: "find", query: "7.6", path: "CONTRACT.md" });
    expect(first.escalated).toBe(false);

    const second = runFind(ws, { action: "find", query: "yaw", path: "CONTRACT.md" });

    expect(second.escalated).toBe(true);
    const body = second.body;
    expect(body["ok"]).toBe(false);
    expect(body["error"]).toBe("find-all-served-repeat");
    expect(body["terminal"]).toBe(true);
    expect(body["required_action"]).toBe("unlock-or-rescope");
    expect(String(body["terminal_reason"])).toContain("already served to you this session");

    // NOT information denial: the locate answer survives whole — every matched
    // file, its exact hit count, and the matched LINE numbers. Only the
    // snippets (verbatim bytes of files the caller holds) are gone.
    const receipt = body["files"] as Record<string, unknown>[];
    expect(receipt.length).toBeGreaterThan(0);
    expect(receipt[0]?.["path"]).toBe("CONTRACT.md");
    expect((receipt[0]?.["lines"] as number[]).length).toBeGreaterThan(0);
    expect(receipt[0]?.["match_count"]).toBe(body["total_matches"]);
    expect(receipt[0]).not.toHaveProperty("snippets");
    expect(String(body["receipt_note"])).toContain("only snippets are omitted");

    // The unlock names what ACTUALLY progresses (progressive refusals are
    // unconditional since D10, 2026-08-14).
    const unlock = body["unlock"] as Record<string, unknown>;
    const transitions = unlock["accepted_transitions"] as string[];
    expect(transitions).toContain(`edit_file handle=${editHandle}`);
    expect(transitions).toContain("challenge");
    expect(transitions).toContain("taskEpoch:new");
    expect(transitions.some((t) => t.startsWith("search_files action=find path="))).toBe(true);
    expect(unlock["challenge"]).toBeDefined();

    // …and one executable next_call, marked as the template it is.
    const nextCall = body["next_call"] as Record<string, unknown>;
    expect(nextCall["tool"]).toBe("edit_file");
    expect((nextCall["arguments"] as Record<string, unknown>)["handle"]).toBe(editHandle);
    expect(body["next_call_is_template"]).toBe(true);
  });

  it("escalates an exact-duplicate result set even under a different query string", () => {
    const ws = makeAeroctlWorkspace("dupe");
    servePackSurfaces(ws);
    armCertificate(ws);

    // rep2 calls 11/12: `drv_motor` then `drv_motor.h`, same file, same 89
    // matches, re-served in full. Different query STRING, identical RESULT —
    // so identity is taken on the result, never on the query.
    const first = runFind(ws, { action: "find", query: "drv_motor", path: "CONTRACT.md" });
    expect(first.escalated).toBe(false);
    const firstFiles = first.body["files"] as Record<string, unknown>[];

    const second = runFind(ws, { action: "find", query: "drv_motor.h", path: "CONTRACT.md" });

    // Same result set reached by a different spelling.
    expect(second.body["total_matches"]).toBe(first.body["total_matches"]);
    expect(second.escalated).toBe(true);
    expect(second.body["duplicate_of_query"]).toBe("drv_motor");
    expect(String(second.body["terminal_reason"])).toContain("drv_motor");
    expect(firstFiles[0]?.["path"]).toBe("CONTRACT.md");
  });

  it("escalates a byte-identical repeat of the very first all-served find", () => {
    const ws = makeAeroctlWorkspace("repeat");
    servePackSurfaces(ws);
    armCertificate(ws);

    const args = { action: "find", query: "yaw", path: "CONTRACT.md" };
    expect(runFind(ws, { ...args }).escalated).toBe(false);
    const repeat = runFind(ws, { ...args });

    expect(repeat.escalated).toBe(true);
    expect(repeat.body["duplicate_call"]).toBe(true);
    // The discovery-signature brake refuses the 3rd+ identical shape and runs
    // BEFORE dispatch. L2 lands on the 2nd, from the response path, so an
    // all-served loop is answered once here rather than braked later under
    // different wording — an ordered ladder, not two brakes on one pedal.
    expect(repeat.body["required_action"]).toBe("unlock-or-rescope");
  });

  it("never trips on a find that surfaces a NOT-yet-served location, and that find CLEARS the pressure", () => {
    const ws = makeAeroctlWorkspace("scope");
    servePackSurfaces(ws);
    armCertificate(ws);

    // One all-served find arms the ledger…
    expect(runFind(ws, { action: "find", query: "yaw", path: "CONTRACT.md" }).escalated).toBe(false);
    expect(getServedFindLedgerForTest(ws)?.occurrences).toBe(1);

    // …a legitimate scope change reaches an UNSERVED file. Untouched, and it
    // resets: progress must never inherit pressure earned by a different scope.
    const widened = runFind(ws, { action: "find", query: "pwm_set" });
    expect(widened.escalated).toBe(false);
    expect(widened.body["all_served"]).toBeUndefined();
    const widenedFiles = widened.body["files"] as Record<string, unknown>[];
    expect(widenedFiles.some((f) => String(f["path"]).includes("drv_motor"))).toBe(true);
    expect(getServedFindLedgerForTest(ws)).toBeUndefined();

    // So the next all-served find is a FIRST again, and still serves in full.
    const afterReset = runFind(ws, { action: "find", query: "yaw", path: "CONTRACT.md" });
    expect(afterReset.escalated).toBe(false);
    expect(afterReset.body["all_served_occurrence"]).toBe(1);
  });

  it("leaves zero-match finds and uncertified sessions alone", () => {
    const ws = makeAeroctlWorkspace("neutral");
    servePackSurfaces(ws);

    // No certificate: "you already hold this" is not a protocol-grade claim.
    const uncertified = runFind(ws, { action: "find", query: "yaw", path: "CONTRACT.md" });
    expect(uncertified.escalated).toBe(false);
    expect(uncertified.body["all_served"]).toBe(true);
    expect(getServedFindLedgerForTest(ws)).toBeUndefined();

    armCertificate(ws);
    // A zero-match find is neither residency nor progress — it must not count.
    const miss = runFind(ws, { action: "find", query: "nonexistent_token_zzz", path: "CONTRACT.md" });
    expect(miss.escalated).toBe(false);
    expect(getServedFindLedgerForTest(ws)).toBeUndefined();
  });

  it("clears the ledger on a successful edit", () => {
    const ws = makeAeroctlWorkspace("edit");
    servePackSurfaces(ws);
    armCertificate(ws);

    expect(runFind(ws, { action: "find", query: "yaw", path: "CONTRACT.md" }).escalated).toBe(false);
    expect(getServedFindLedgerForTest(ws)?.occurrences).toBe(1);

    // A write invalidates "every match is already in your context".
    recordEditedPath(ws, "firmware/src/control/mixer.cpp");
    expect(getServedFindLedgerForTest(ws)).toBeUndefined();
    expect(runFind(ws, { action: "find", query: "yaw", path: "CONTRACT.md" }).escalated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// L3(a) — did_you_mean ranks by served CONTENT, not by filename
// ---------------------------------------------------------------------------

describe("L3(a) — did_you_mean ranks served files that contain the query first", () => {
  it("reproduces rep2 call 8 and puts the token-containing served files ahead of the filename guesses", () => {
    const ws = makeAeroctlWorkspace("dym");
    servePackSurfaces(ws);

    // The measured call, verbatim in shape: four probes, scoped to a document
    // that contains none of them. Pre-fix this answered
    // [drv_motor.h, drv_motor_pwm.c] on FILENAME similarity to "motor" and
    // cost two dead calls; the probes live verbatim in the served mixer pair.
    const response = buildFindResponseForQueries(
      { queries: ["CW prop", "yaw torque", "clockwise", "motor spins"], path: "CONTRACT.md" },
      ws,
    );

    expect(response.total_matches).toBe(0);
    const candidates = response.did_you_mean ?? [];
    expect(candidates.slice(0, 2)).toEqual([
      "firmware/include/control/mixer.hpp",
      "firmware/src/control/mixer.cpp",
    ]);
    // The decoys are still reachable, but strictly behind — and labelled.
    const basis = (response as unknown as Record<string, unknown>)["did_you_mean_basis"] as Record<string, unknown>;
    expect(basis["content_matched"]).toBe(2);
    expect(String(basis["note"])).toContain("CONTAIN your search text");
    const decoyIndex = candidates.findIndex((c) => c.includes("drv_motor"));
    if (decoyIndex >= 0) expect(decoyIndex).toBeGreaterThan(1);
  });

  it("keeps the filename ladder when no served file contains the query", () => {
    const ws = makeAeroctlWorkspace("dym-none");
    recordReadPath(ws, "CONTRACT.md");

    const response = buildFindResponse({ query: "drv_motor_absent_symbol", path: "CONTRACT.md" }, ws);

    expect(response.total_matches).toBe(0);
    const basis = (response as unknown as Record<string, unknown>)["did_you_mean_basis"] as
      | Record<string, unknown>
      | undefined;
    // Nothing content-backed to promote — the honest answer says the
    // suggestions are name guesses, and does not imply a verified hit.
    if (basis !== undefined) {
      expect(basis["content_matched"]).toBe(0);
      expect(String(basis["note"])).toContain("FILENAME matches only");
    }
  });
});

// ---------------------------------------------------------------------------
// L3(b) — the repeated-hit hint is gated on edit admissibility
// ---------------------------------------------------------------------------

describe("L3(b) — the repeated-hit hint only claims edit-grade for an admissible target", () => {
  it("suppresses the edit verb for a file outside the admissible edit set, keeping the bundled context", () => {
    const ws = mkWorkspace("hint-no");
    writeFile(
      ws,
      "firmware/src/driver/drv_motor_pwm.c",
      [
        "#include \"driver/drv_motor.h\"",
        "void pwm_set(int motor_idx, int duty) {",
        "  timer_write(motor_idx, duty);",
        "  timer_latch(motor_idx);",
        "}",
        "",
      ].join("\n"),
    );
    writeFile(ws, "docs/notes.md", "motor_idx appears here once\n");

    const response = buildFindResponse({ query: "motor_idx" }, ws);

    // The promotion is UNCHANGED — range, handle and exact source still ride,
    // still replacing a follow-up read.
    expect(response.files[0]?.handle).toMatch(/^h[0-9a-z]+$/);
    expect(response.files[0]?.context).toContain("timer_write");
    // …but the file is in no certificate frontier and was never edited, so the
    // hint is read-shaped. Measured basis: this exact hint fired 5 times
    // across the three T05c reps and named an actually-edited file 0/5 times.
    expect(response.hint).toContain("repeated-hit cluster");
    expect(response.hint).toContain("not an established edit target");
    expect(response.hint).not.toContain("edit this handle");
  });

  it("keeps the edit-grade wording when the file IS an admissible edit target", () => {
    const ws = mkWorkspace("hint-yes");
    writeFile(
      ws,
      "firmware/src/control/mixer.cpp",
      [
        "#include \"control/mixer.hpp\"",
        "void mixQuadX(float yaw, float* out) {",
        "  out[0] = motor_idx_scale(yaw);",
        "  out[1] = motor_idx_scale(-yaw);",
        "}",
        "",
      ].join("\n"),
    );
    writeFile(ws, "docs/notes.md", "motor_idx_scale appears here once\n");
    const handle = handleTable.upsert({
      kind: "range",
      path: "firmware/src/control/mixer.cpp",
      range: "1-6",
      workspaceRoot: ws,
    }).id;
    recordServedEditAdmissibility(ws, { handles: [handle], paths: ["firmware/src/control/mixer.cpp"] });

    const response = buildFindResponse({ query: "motor_idx_scale" }, ws);

    expect(response.files[0]?.path).toBe("firmware/src/control/mixer.cpp");
    expect(response.hint).toContain("edit-grade repeated-hit candidate");
    expect(response.hint).toContain("without another locate/read");
  });
});

// ---------------------------------------------------------------------------
// C3 — served-find range-honesty: file-level provenance vs line-level residency
// ---------------------------------------------------------------------------
//
// Source: bench run 2026-08-08-semantic-signal5-2, 8 T05c sightings + 2
// others. L2's `served`/`all_served` check (above) is FILE-level
// (getReadPaths — "was this path read at all this session"). A doc-sliver
// serve (task_pack's anchor-focus, see docSliver.spec.ts) can mark a whole
// path "read" on a handful of lines out of thousands: measured, CONTRACT.md
// served 1514-1514 of 1,514 lines, then a find matched line 1022. The
// file-level claim was true; "the matches sit inside content you hold" was
// not — false in 8/8 measured sightings, and correctly ignored every time.
//
// This group pins the fix: a residency claim (all_served / served_note) must
// be RANGE-accurate, not just file-level, and a find that surfaces a held
// file but unheld lines must (a) say so honestly instead and (b) never touch
// the L2 escalation ledger — it is real information, not a zero-info repeat.
// ---------------------------------------------------------------------------

describe("C3 — a residency claim must be RANGE-accurate, not just file-level", () => {
  /** A large, line-numbered doc with exactly one distinctive match line. */
  function makeBigDoc(ws: string, relPath: string, totalLines: number, tokenLine: number, token: string): void {
    const lines: string[] = [];
    for (let i = 1; i <= totalLines; i++) {
      lines.push(i === tokenLine ? `${token} marks the one match line` : `filler content on line ${i}`);
    }
    writeFile(ws, relPath, lines.join("\n") + "\n");
  }

  it("reproduces the measured shape — CONTRACT.md served 1514-1514 of 1514 lines, a find matches line 1022: no residency prose, no ledger advance, an honest partial note + range field", () => {
    const ws = mkWorkspace("c3-measured");
    const TOTAL = 1514;
    const MATCH_LINE = 1022;
    makeBigDoc(ws, "CONTRACT.md", TOTAL, MATCH_LINE, "quadrotor_yaw_authority");
    // The L1 doc-sliver serve, exactly: the whole path is marked read
    // (getReadPaths), but only the LAST line was ever put on the wire.
    recordReadPath(ws, "CONTRACT.md");
    recordServedRange(ws, "CONTRACT.md", "sha-sliver", TOTAL, TOTAL, TOTAL);
    armCertificate(ws);

    const result = runFind(ws, { action: "find", query: "quadrotor_yaw_authority", path: "CONTRACT.md" });

    expect(result.escalated).toBe(false);
    // No false residency claim survives.
    expect(result.body["all_served"]).toBeUndefined();
    expect(result.body["served_note"]).toBeUndefined();
    // An honest one stands in its place, in the OLD note's size class.
    expect(result.body["partially_served"]).toBe(true);
    const note = String(result.body["partial_served_note"]);
    expect(note).toContain("outside the ranges you hold");
    expect(Buffer.byteLength(note, "utf8")).toBeLessThan(200);
    const files = result.body["files"] as Record<string, unknown>[];
    const file = files.find((f) => f["path"] === "CONTRACT.md")!;
    expect(file["served_this_session"]).toBe(true); // file-level provenance IS true
    expect(file["lines_held"]).toBe(false); // line-level residency is NOT
    expect(file["matched_lines_outside_served"]).toBe(1);
    expect(file["lines"]).toEqual([MATCH_LINE]);
    // A partial find is not a zero-info repeat — it never touches the ledger.
    expect(getServedFindLedgerForTest(ws)).toBeUndefined();
  });

  it("a fully-held match keeps today's behaviour byte-for-byte: all_served, the OLD prose, and the ledger advancing", () => {
    const ws = makeAeroctlWorkspace("c3-full");
    servePackSurfaces(ws);
    armCertificate(ws);

    const result = runFind(ws, { action: "find", query: "yaw", path: "CONTRACT.md" });

    expect(result.escalated).toBe(false);
    expect(result.body["all_served"]).toBe(true);
    expect(result.body["all_served_occurrence"]).toBe(1);
    expect(String(result.body["served_note"])).toContain("already served to you this session");
    expect(result.body["partially_served"]).toBeUndefined();
    expect(result.body["partial_served_note"]).toBeUndefined();
    const files = result.body["files"] as Record<string, unknown>[];
    expect(files[0]?.["lines_held"]).toBeUndefined();
    expect(files[0]?.["matched_lines_outside_served"]).toBeUndefined();
    expect(getServedFindLedgerForTest(ws)?.occurrences).toBe(1);
  });

  it("mixed multi-file: one fully held, one partial — per-file truth, no ledger advance", () => {
    const ws = mkWorkspace("c3-mixed");
    writeFile(ws, "held.md", "alpha shared_probe_token here\nsecond line\n");
    makeBigDoc(ws, "partial.md", 200, 150, "shared_probe_token");
    // held.md: read AND fully covered by a served range.
    recordReadPath(ws, "held.md");
    recordServedRange(ws, "held.md", "sha-held", 1, 2, 2);
    // partial.md: read, but only lines 1-5 of 200 were ever served — the
    // match sits at line 150, well outside.
    recordReadPath(ws, "partial.md");
    recordServedRange(ws, "partial.md", "sha-partial", 1, 5, 200);
    armCertificate(ws);

    const result = runFind(ws, { action: "find", query: "shared_probe_token" });

    expect(result.escalated).toBe(false);
    expect(result.body["all_served"]).toBeUndefined();
    expect(result.body["partially_served"]).toBe(true);
    const files = result.body["files"] as Record<string, unknown>[];
    const held = files.find((f) => f["path"] === "held.md")!;
    const partial = files.find((f) => f["path"] === "partial.md")!;
    expect(held["served_this_session"]).toBe(true);
    expect(held["lines_held"]).toBe(true);
    expect(held["matched_lines_outside_served"]).toBeUndefined();
    expect(partial["served_this_session"]).toBe(true);
    expect(partial["lines_held"]).toBe(false);
    expect(partial["matched_lines_outside_served"]).toBe(1);
    // No ledger interaction of any kind for a partial-residency response.
    expect(getServedFindLedgerForTest(ws)).toBeUndefined();
  });

  it("a partial-residency find in between does not block escalation across two genuinely-held all-served finds", () => {
    const ws = makeAeroctlWorkspace("c3-interleave");
    servePackSurfaces(ws);
    armCertificate(ws);

    const first = runFind(ws, { action: "find", query: "7.6", path: "CONTRACT.md" });
    expect(first.escalated).toBe(false);
    expect(first.body["all_served_occurrence"]).toBe(1);

    // A partial-residency find lands in between — it must not touch the ledger.
    makeBigDoc(ws, "unrelated_big.md", 50, 30, "interposed_unheld_token");
    recordReadPath(ws, "unrelated_big.md");
    recordServedRange(ws, "unrelated_big.md", "sha-u", 1, 3, 50);
    const partial = runFind(ws, { action: "find", query: "interposed_unheld_token", path: "unrelated_big.md" });
    expect(partial.escalated).toBe(false);
    expect(partial.body["partially_served"]).toBe(true);
    expect(getServedFindLedgerForTest(ws)?.occurrences).toBe(1); // unchanged by the partial find

    // A second, DIFFERENT, genuinely fully-held query still escalates.
    const second = runFind(ws, { action: "find", query: "yaw", path: "CONTRACT.md" });
    expect(second.escalated).toBe(true);
    expect(second.body["all_served_occurrence"]).toBe(2);
  });

  it("the no-friction guarantee is unaffected: a scope-change find still resets the ledger", () => {
    const ws = makeAeroctlWorkspace("c3-scope-change");
    servePackSurfaces(ws);
    armCertificate(ws);

    // Arm one genuinely-held occurrence.
    expect(runFind(ws, { action: "find", query: "yaw", path: "CONTRACT.md" }).escalated).toBe(false);
    expect(getServedFindLedgerForTest(ws)?.occurrences).toBe(1);

    // A find reaching a NOT-yet-served path is untouched and CLEARS the
    // ledger — this existing guarantee is unaffected by C3.
    const widened = runFind(ws, { action: "find", query: "pwm_set" });
    expect(widened.escalated).toBe(false);
    expect(widened.body["all_served"]).toBeUndefined();
    expect(widened.body["partially_served"]).toBeUndefined();
    expect(getServedFindLedgerForTest(ws)).toBeUndefined();
  });
});
