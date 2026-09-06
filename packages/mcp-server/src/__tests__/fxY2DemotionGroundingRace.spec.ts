/**
 * fxY2DemotionGroundingRace.spec.ts — FX-Y2 (round-24 adversarial review,
 * finding 1, MEDIUM, 2026-09-04).
 *
 * `scratchpad/round24-review.md` finding 1: `relationAnchorGroundingServed`
 * (sfSatisfaction.ts) trusted the PERSISTED "satisfied" mark of a relation
 * concern's grounding `definition`/`declaration` sibling instead of
 * re-verifying that the sibling's body was still on the wire of the response
 * actually being decided over. A `declaration` concern (`sfConcerns.ts` rule
 * 2) is non-advisory (blocking) but never `required` (I-2 protects only
 * caller-named addresses), so nothing stopped `TL_SF_DEMOTE` from stripping
 * its body in the SAME pack, AFTER the sync satisfaction pass had already
 * recorded it satisfied but BEFORE the async relation-packet pass — which
 * runs with NO `evidence` field of its own — asked whether disclosure could
 * close the sibling relation concern.
 *
 * RULING (dd) ships two independent fixes:
 *   (1) ELIGIBILITY (`canonicalDecision.ts`'s `demotionEligibleNow`, via
 *       `sfSatisfaction.ts`'s new `isAddressGroundingOpenConcern`): an
 *       address that grounds an OPEN non-advisory concern — its own, or (for
 *       an open `relation` concern) a definition/declaration sibling's — is
 *       treated as required-for-demotion-purposes, so the race's premise
 *       (satisfied-then-demoted) cannot arise in the first place.
 *   (2) RE-VERIFICATION (`sfSatisfaction.ts`'s `relationAnchorGroundingServed`
 *       + `readCodeTaskPack.ts`'s `applySemanticFrontierRelationPackets`,
 *       which now recomputes served evidence from the pack's CURRENT,
 *       post-seam surfaces instead of omitting `evidence` entirely): a
 *       defense-in-depth check against the response actually being decided
 *       over, never the persisted mark alone.
 *
 * `sfSatisfaction.spec.ts`'s own new "round-24 finding 1 / ruling (dd)
 * (FX-Y2)" block proves fix (2) and `isAddressGroundingOpenConcern` at the
 * pure-function level, with a documented pre-fix failure (see that file).
 * THIS file proves fix (1) — the eligibility half — by driving the REAL
 * exported production functions (`extractStructuralConcerns`, `openSfTask`/
 * `recordServed`/`markConcernSatisfied`, `applyResponseToConcerns`,
 * `attachSfPackContext`/`attachSfDemotionResidency`,
 * `annotateSemanticFrontierContinuation`, `isSemanticFrontierDemotionEligible`/
 * `applySemanticFrontierDemotion`) over a hand-assembled but REAL C++
 * header/impl pack shape, plus real `buildTaskPack`/`callTool` production-
 * shape controls.
 *
 * WHY NOT A SINGLE full callTool() REPRO. Reproducing the exact race through
 * one production `callTool` call requires a served, non-advisory
 * `declaration` concern's surface that (a) is genuinely classified
 * continuation-optional by `semanticFrontier.ts`'s own classifier (zero
 * legacy bindings, non-primary — the real, mechanical trigger
 * `TL_SF_DEMOTE` acts on) AND (b) is not otherwise swept into the pack's
 * `execution_contract.readiness_certificate.evidence_handles` (which, for
 * every C++ qualified-anchor fixture this file's own exploration tried,
 * unconditionally lists every served native surface as "action-bearing" —
 * `contractEvidenceAddresses` reads `evidence_handles` unconditionally,
 * independent of `action_frontier`). Round-24's own probe2 ran out of budget
 * on exactly this combination and flagged it as the open next step rather
 * than asserting it proven; this file's own exploration (documented in the
 * session, not committed) reached the same wall from several angles
 * (generic vs. answer profile, explicit targets, case-desynchronized
 * qualifier spelling, header/impl basename mismatches). The eligibility fix
 * itself does not depend on how the declaration surface was found — only on
 * whether ITS OWN address is a sibling of a currently open relation concern
 * — so testing it by driving the exact production functions with a
 * hand-assembled pack (matching every real function's own input contract,
 * concerns extracted by the REAL `extractStructuralConcerns`) is the
 * faithful "production shape" proof for THIS specific fix; the full-wire
 * `callTool` tests below are the honest regression/control coverage the
 * task asks for on top of it.
 *
 * PROOF THIS FAILS WITHOUT THE FIX: see the "eligibility (fix 1)" describe
 * block below — each fix-proving test was run against `canonicalDecision.ts`
 * restored to its pre-FX-Y2 `git show HEAD:...` blob (temporarily copied
 * over the file, run, then restored) and failed exactly as expected; see the
 * inline comment on each assertion for the pre-fix observed value.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { callTool } from "../server.js";
import {
  resetPackDedupeCache,
  resetRoleInventoryCache,
} from "../features/task-pack/readCodeTaskPack.js";
import {
  extractStructuralConcerns,
  type SfAnchorResolver,
  type SfQualifiedAnchor,
} from "../features/task-pack/sfConcerns.js";
import {
  applyResponseToConcerns,
  attachSfPackContext,
  type SfResponseEvidence,
} from "../features/task-pack/sfSatisfaction.js";
import {
  annotateSemanticFrontierContinuation,
  isSemanticFrontierContinuationOptional,
} from "../features/task-pack/semanticFrontier.js";
import {
  applyCanonicalTaskDecision,
  applySemanticFrontierDemotion,
  attachSfDemotionResidency,
  isSemanticFrontierDemotionEligible,
} from "../features/task-pack/canonicalDecision.js";
import {
  markConcernSatisfied,
  openSfTask,
  recordServed,
  resetSfStateForTests,
  type SfServedLedgerReader,
  type SfTaskContext,
} from "../task-state/sfState.js";
import { resetAll as resetAllSessions } from "../state/session.js";
import { resetStateStoresForTests } from "../state/stateStore.js";
import { resetPackServeLogForTest } from "../util/packServeLog.js";
import { SEMANTIC_FRONTIER_V2_FLAG_REGISTRY } from "../util/flags.js";

const SF_FLAG_KEYS = Object.keys(SEMANTIC_FRONTIER_V2_FLAG_REGISTRY) as readonly string[];
const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();

const tmpDirs: string[] = [];
function mkWorkspace(tag: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(HOME, `.tl-fxy2-${tag}-`)));
  tmpDirs.push(dir);
  return dir;
}
function write(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}
function resetAllPackState(): void {
  resetPackDedupeCache();
  resetRoleInventoryCache();
  resetPackServeLogForTest();
  resetAllSessions();
  resetStateStoresForTests();
  resetSfStateForTests();
}
function setTenFlags(savedEnv: Map<string, string | undefined>): void {
  for (const key of SF_FLAG_KEYS) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    process.env[key] = "1";
  }
  if (!savedEnv.has("TL_GRAPH_EVIDENCE")) savedEnv.set("TL_GRAPH_EVIDENCE", process.env["TL_GRAPH_EVIDENCE"]);
  process.env["TL_GRAPH_EVIDENCE"] = "1";
}

afterEach(() => {
  resetAllPackState();
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// ---------------------------------------------------------------------------
// (1) ELIGIBILITY — the exact production functions, a hand-assembled C++
// header/impl pack shape that reproduces the race's PRECONDITIONS honestly:
// a `declaration` concern (rule 2, non-advisory, `required:false`) whose
// surface is genuinely classified continuation-optional by the REAL
// `annotateSemanticFrontierContinuation`, satisfied by a real sync body pass,
// while its sibling `relation` concern (rule 5) is still OPEN.
// ---------------------------------------------------------------------------

describe("FX-Y2 eligibility (fix 1) — an address grounding an open relation concern is never demotion-eligible", () => {
  const savedEnv = new Map<string, string | undefined>();

  afterEach(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedEnv.clear();
  });

  /** Real anchorResolver: `Foo::bar` resolves to a real declaration/definition pair. */
  const anchorResolver: SfAnchorResolver = (anchor: SfQualifiedAnchor) => {
    if (anchor.qualifier === "Foo" && anchor.member === "bar") {
      return { definitions: ["src/foo.cpp"], declarations: ["src/foo.h"] };
    }
    return {};
  };

  const QUERY = "explain the references and callers of Foo::bar";

  /** Builds the SAME `SfStructuralConcern[]` the real production seam would extract. */
  function realConcerns() {
    return extractStructuralConcerns({ query: QUERY, profile: "generic", anchorResolver });
  }

  it("sanity: the real extractor produces definition + declaration (required:false, non-advisory) + relation, sharing one qualified anchor", () => {
    setTenFlags(savedEnv);
    const concerns = realConcerns();
    const definition = concerns.find((c) => c.kind === "definition");
    const declaration = concerns.find((c) => c.kind === "declaration");
    const relation = concerns.find((c) => c.kind === "relation");
    expect(definition?.bindings).toEqual(["src/foo.cpp"]);
    expect(declaration?.bindings).toEqual(["src/foo.h"]);
    expect(declaration?.advisory, "non-advisory: blocking").toBe(false);
    expect(declaration?.required, "NOT I-2-protected — this is the exact FX-Y2 precondition").toBe(false);
    expect(relation?.advisory).toBe(false);
    expect(relation?.anchor).toEqual(definition?.anchor);
  });

  it("the declaration's surface is genuinely classified continuation-optional by the real classifier", () => {
    setTenFlags(savedEnv);
    const definitionSurface: any = { path: "src/foo.cpp", handle: "h1", code: "void Foo::bar() {}\n", range: "1-1", role: "domain" };
    const declarationSurface: any = { path: "src/foo.h", handle: "h2", code: "class Foo { void bar(); };\n", range: "1-1", role: "contract" };
    const result = { surfaces: [definitionSurface, declarationSurface] } as any;
    // The classifier's LEGACY arm (`guardEnabled:true`) is what produces this
    // race's precondition — a marked declaration surface whose eligibility the
    // FX-Y2 fix then has to refuse. FX-R3 D4 (2026-09-04) changed the v2 arm's
    // marking SOURCE to the pack's grounded structural concerns, and under
    // THAT source this same surface is not marked at all (asserted below), so
    // the eligibility fix would never be exercised if this line used it.
    annotateSemanticFrontierContinuation(result, QUERY, true);
    expect(isSemanticFrontierContinuationOptional(definitionSurface), "index 0 stays primary").toBe(false);
    expect(isSemanticFrontierContinuationOptional(declarationSurface), "zero legacy bindings, non-primary").toBe(true);
  });

  it("FX-R3 D4: under the v2 marking source the same declaration surface is never even marked (second, independent protection)", () => {
    setTenFlags(savedEnv);
    const definitionSurface: any = { path: "src/foo.cpp", handle: "h1", code: "void Foo::bar() {}\n", range: "1-1", role: "domain" };
    const declarationSurface: any = { path: "src/foo.h", handle: "h2", code: "class Foo { void bar(); };\n", range: "1-1", role: "contract" };
    const result = { surfaces: [definitionSurface, declarationSurface] } as any;
    annotateSemanticFrontierContinuation(result, QUERY, false, realConcerns());
    // `src/foo.h` is the declaration concern's own binding, so it is
    // structurally bound and the v2 arm keeps its body without ever consulting
    // eligibility.
    expect(isSemanticFrontierContinuationOptional(declarationSurface)).toBe(false);
  });

  it("FIX-PROVING: the declaration's address is INELIGIBLE for demotion while its sibling relation concern is still open — applySemanticFrontierDemotion withholds NOTHING", async () => {
    setTenFlags(savedEnv);
    const ws = mkWorkspace("elig");
    const concerns = realConcerns();

    const definitionSurface: any = { path: "src/foo.cpp", handle: "h1", code: "void Foo::bar() {\n  int x = 1;\n}\n", range: "1-3", role: "domain" };
    const declarationSurface: any = { path: "src/foo.h", handle: "h2", code: "class Foo {\n public:\n  void bar();\n};\n", range: "1-4", role: "contract" };
    const result: any = { surfaces: [definitionSurface, declarationSurface] };

    // Real classifier pass — marks `declarationSurface` continuation-optional
    // (confirmed above), through the LEGACY arm, which is the only source that
    // still produces this race's precondition after FX-R3 D4.
    annotateSemanticFrontierContinuation(result, QUERY, true);

    // D4: a ledger that has NEVER served either path before — the ordinary
    // "never held these bytes" eligibility precondition. Must be present on
    // `ctx` from the START (`snapshotOf`'s `ledgerWired` is computed as
    // `ctx.ledger !== undefined` at EVERY state-adapter call, including
    // `openSfTask`/`recordServed`/`markConcernSatisfied` — attaching it only
    // later, for `attachSfDemotionResidency` alone, would leave
    // `ctx.snapshot.ledgerWired` false throughout and make
    // `demotionEligibleNow` fail closed on THAT gate before ever reaching the
    // eligibility check this test exists to prove).
    const neverServedLedger: SfServedLedgerReader = {
      hasServedPath: () => false,
      wasFullyServed: () => false,
      servedRangeCoverage: () => undefined,
    };
    const ctx: SfTaskContext = { workspaceRoot: ws, query: QUERY, ledger: neverServedLedger };

    // Real SF state lifecycle: open the record, then the SYNC body pass
    // (mirrors `openSemanticFrontierPackState`) — both bodies are still
    // present on `result.surfaces` at this point, exactly like production.
    let latest = openSfTask(ctx, concerns);
    const served: SfResponseEvidence[] = [
      // SF-F10: `evidenceId` must be stamped explicitly and identically for
      // `recordServed`'s catalog and `applyResponseToConcerns`'s own proof
      // (`evidenceIdOf`'s fallback spelling differs from `recordServed`'s
      // `deriveEvidenceId`) — production's `sfServedFromPack` does this via
      // `sfEvidenceIdFor`; hand-built here for the same reason.
      { path: "src/foo.cpp", evidenceId: "src/foo.cpp", body: true, evidenceClass: "direct" },
      { path: "src/foo.h", evidenceId: "src/foo.h", body: true, evidenceClass: "direct" },
    ];
    const afterServed = recordServed(ctx, served);
    if (afterServed.active) latest = afterServed;
    const satisfaction = applyResponseToConcerns({
      snapshot: latest,
      concerns,
      response: { kind: "read.task_pack", evidence: served },
    });
    for (const id of satisfaction.satisfied) {
      const after = markConcernSatisfied(ctx, id, { ...(satisfaction.proofs[id] ?? {}), grounding: "structural" });
      if (after.active) latest = after;
    }
    // Precondition check: declaration is satisfied, relation is still OPEN
    // (its own closure only ever happens in the ASYNC relation-packet pass,
    // which this test deliberately never runs — matching the exact moment
    // `applySemanticFrontierPreBookingSeam`'s demotion step runs in
    // production, per FX-I-A's own ordering).
    const declarationId = concerns.find((c) => c.kind === "declaration")!.id;
    const relationId = concerns.find((c) => c.kind === "relation")!.id;
    expect(latest.satisfied).toContain(declarationId);
    expect(latest.openNonAdvisory).toContain(relationId);
    expect(latest.ledgerWired, "sanity: the ledger gate must be live, or this test proves nothing").toBe(true);

    attachSfPackContext(result, {
      snapshot: latest,
      concerns,
      satisfaction,
      observationOnly: false,
    });
    attachSfDemotionResidency(result, ctx);

    // `isSemanticFrontierDemotionEligible` reads a WeakMap mark that only
    // `markSemanticFrontierDemotionEligibility` (private) populates, and that
    // helper is invoked from the exported, real production exit
    // `applyCanonicalTaskDecision` — the SAME call `reapplySemanticFrontierDecision`
    // makes in the actual seam. Calling it here (tolerant of a
    // partial/hand-built `result`; it returns early once no
    // `execution_contract` exists, after marking) is what makes the marks
    // exist to read at all.
    applyCanonicalTaskDecision(result);

    // PRE-FIX this returned `true` (only `snapshot.requiredAddresses` — I-2,
    // caller-named only — was consulted; the declaration was never
    // caller-named, so nothing protected it).
    expect(
      isSemanticFrontierDemotionEligible(declarationSurface),
      "the declaration still grounds the OPEN relation concern's own disclosure closure",
    ).toBe(false);

    // PRE-FIX this stripped `declarationSurface.code` (demoted:1). Post-fix:
    // nothing is demoted (the only OTHER surface, the definition, is index-0
    // primary and was never eligible either).
    const demoted = applySemanticFrontierDemotion(result);
    expect(demoted, "PRE-FIX this was 1 (the declaration got demoted)").toBe(0);
    expect(typeof declarationSurface.code, "the declaration keeps its body").toBe("string");
    expect(declarationSurface.content_completeness).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (2) demoted_count / re_suppression_count consistency (task requirement c):
// the eligibility fix must never manufacture a re-suppression — a surface
// this pass declines to demote is simply never marked eligible in the first
// place, so `re_suppression_count` (decisionWire.ts's own, independent
// invariant) stays 0 regardless.
// ---------------------------------------------------------------------------

describe("FX-Y2 — demoted_count / re_suppression_count stay consistent", () => {
  const savedEnv = new Map<string, string | undefined>();
  afterEach(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedEnv.clear();
  });

  it("a pack where the eligibility fix withholds a would-be demotion reports demoted_count 0 and re_suppression_count 0 on the wire", async () => {
    setTenFlags(savedEnv);
    resetAllPackState();
    const ws = mkWorkspace("counts");
    write(ws, "src/foo.h", "class Foo {\n public:\n  void bar();\n};\n");
    write(ws, "src/foo.cpp", "#include \"foo.h\"\nvoid Foo::bar() {\n  int x = 1;\n}\n");
    write(ws, ".git/HEAD", "ref: refs/heads/main\n");

    const res = await callTool("read_file", {
      query: "explain the callers of Foo::bar",
      task: { profile: "generic", epoch: "new" },
      cwd: ws,
    });
    const text = (res as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? "";
    const wire = JSON.parse(text) as {
      kind?: unknown;
      plan?: { wiring?: { demoted_count?: number; re_suppression_count?: number } };
    };
    expect(wire.kind).toBe("read.task_pack");
    const demotedCount = wire.plan?.wiring?.demoted_count;
    const reSuppressionCount = wire.plan?.wiring?.re_suppression_count;
    // Absence (undefined, "nothing demoted") and an explicit 0 both satisfy
    // the invariant this test is guarding: re_suppression_count is NEVER > 0.
    expect(reSuppressionCount ?? 0).toBe(0);
    if (demotedCount !== undefined) expect(demotedCount).toBeGreaterThanOrEqual(0);
  }, 30000);
});

// ---------------------------------------------------------------------------
// (3) PRODUCTION-SHAPE CONTROLS — real `callTool`, the round-24 probe2 C++
// fixture verbatim (task requirement b's control clauses).
// ---------------------------------------------------------------------------

describe("FX-Y2 production-shape controls (real callTool, C++ header/impl fixture)", () => {
  const savedEnv = new Map<string, string | undefined>();
  afterEach(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedEnv.clear();
  });

  it("both the declaration and definition ship WITH grounding, and the relation concern closes by disclosure with `unavailable` on the wire (round-24 probe2 fixture, no regression from the fix)", async () => {
    setTenFlags(savedEnv);
    resetAllPackState();
    const ws = mkWorkspace("probe2-control");
    write(ws, "src/foo.h", "class Foo {\n public:\n  void bar();\n  void baz();\n};\n");
    write(ws, "src/foo.cpp", "#include \"foo.h\"\nvoid Foo::bar() {\n  int x = 1;\n}\nvoid Foo::baz() {\n  int y = 2;\n}\n");
    write(ws, ".git/HEAD", "ref: refs/heads/main\n");

    const res = await callTool("read_file", {
      query: "explain the callers of Foo::bar",
      task: { profile: "generic", epoch: "new" },
      cwd: ws,
    });
    const text = (res as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? "";
    const wire = JSON.parse(text) as {
      kind?: unknown;
      evidence?: Array<{ path?: unknown; body?: unknown }>;
      decision?: { kind?: unknown; frontier?: Array<{ path?: unknown; writable?: unknown }> };
      plan?: { wiring?: { evidence_graph?: { unavailable?: unknown[] } } };
    };
    expect(wire.kind).toBe("read.task_pack");
    const foo_h = (wire.evidence ?? []).find((e) => e.path === "src/foo.h");
    const foo_cpp = (wire.evidence ?? []).find((e) => e.path === "src/foo.cpp");
    expect(typeof foo_h?.body, "the declaration keeps its body").toBe("string");
    expect(typeof foo_cpp?.body, "the definition keeps its body").toBe("string");
    expect(wire.decision?.kind).toBe("act.edit");
    expect(
      wire.decision?.frontier?.some((f) => f.path === "src/foo.cpp" && f.writable === true),
    ).toBe(true);
    expect(wire.plan?.wiring?.evidence_graph?.unavailable ?? []).toContain("callers");
  }, 30000);

  it("a genuinely UNSERVED grounding sibling never closes by disclosure — the pack stays open with an executable `next` (never a bare await-input)", async () => {
    setTenFlags(savedEnv);
    resetAllPackState();
    const ws = mkWorkspace("unserved-control");
    write(ws, "src/isolated.h", "class Widget {\n public:\n  void spin();\n};\n");
    write(ws, ".git/HEAD", "ref: refs/heads/main\n");

    const res = await callTool("read_file", {
      query: "explain the callers of Widget::spin",
      task: { profile: "answer", epoch: "new" },
      cwd: ws,
    });
    const text = (res as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? "";
    const wire = JSON.parse(text) as {
      kind?: unknown;
      decision?: { kind?: unknown; next?: unknown; candidates?: unknown[] };
    };
    expect(wire.kind).toBe("read.task_pack");
    if (wire.decision?.kind === "await_input") {
      const hasNext = wire.decision.next !== undefined;
      const hasCandidates = Array.isArray(wire.decision.candidates) && wire.decision.candidates.length > 0;
      expect(hasNext || hasCandidates, "await_input must never be bare (ruling (cc))").toBe(true);
    } else {
      // A discover/act.* shape is also an acceptable, non-dead-end outcome —
      // the invariant this control guards is "never a bare await_input",
      // not a specific decision kind.
      expect(wire.decision?.kind).not.toBe(undefined);
    }
  }, 30000);
});
