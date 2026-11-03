/**
 * bodylessDiscover.spec.ts — TL_PACK_BODYLESS_DISCOVER (2026-11-03).
 *
 * A task's FIRST reply to a pathless `query` whose canonical decision is
 * `discover` over `coverage:"partial"` ships its candidate rows without bodies
 * (`handle`/`path`/`range`/`remaining`), keeping its one executable `next`.
 * Every other shape — a confident `act.*`, an explicit `targets` read, a
 * continuation, a receipt, a force-serve, an artifact pack, the flag off — is
 * byte-identical to before. The rule's seven clauses are in
 * features/task-pack/bodylessDiscover.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  applyBodylessDiscover,
  bodylessDiscoverSkipReason,
  isBodylessDiscoverWithheld,
  isFixedWindowRead,
  provedClaimHandles,
  restoreBodylessDiscoverIfConfident,
  wireDecision,
} from "../features/task-pack/bodylessDiscover.js";
import {
  canonicalTaskDecisionInvariantViolations,
  deriveCanonicalTaskDecision,
} from "../features/task-pack/canonicalDecision.js";
import { wasSemanticFrontierBodyWithheld } from "../features/task-pack/sfWithholdingMarks.js";
import type { TaskPackArgs, TaskPackResult } from "../features/task-pack/model.js";
import { projectEvidence } from "../protocol/decisionWire.js";
import { buildTaskPack } from "../tools/readCodeTaskPack.js";
import { handleTable } from "../util/handles.js";
import { resetAll } from "../util/session.js";

const FLAG = "TL_PACK_BODYLESS_DISCOVER";
let savedFlag: string | undefined;

beforeEach(() => {
  savedFlag = process.env[FLAG];
  delete process.env[FLAG];
  resetAll();
  handleTable.reset();
});

afterEach(() => {
  if (savedFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = savedFlag;
});

// ---------------------------------------------------------------------------
// Fixture: the W9 read-only candidate list (discoveryBundle.spec.ts) — an
// answer-profile choose-candidate pack whose canonical decision is `discover`
// with the bounded qref bundle as its `next`. Three bodied candidates.
// ---------------------------------------------------------------------------
const chooseCandidateContract = () => ({
  version: 1,
  state: "needs-followup",
  readiness: "choose-candidate",
  discovery_complete: false,
  next_action: "request-user-input",
  max_additional_discovery_calls: 0,
  reason: "choose-candidate: every candidate body is served inline (handles ha,hb,hc); pick the surface matching the task",
  await_input_code: "choose-candidate",
  typestate: {
    phase: "awaiting-input",
    allowed_actions: ["answer", "edit", "request-user-input"],
    challenge_required_for: [],
  },
  semantic_closure: {
    version: 1, state: "awaiting-input", closure_id: "open-bd",
    obligations_total: 2, obligations_proved: 1, unresolved: ["behavior-body"],
  },
});

function candidateListPack(selected = "answer"): TaskPackResult {
  return {
    mode: "task_pack",
    qref: "q-bd",
    coverage: "partial",
    coverage_reason: "candidate-list",
    surfaces: [
      { role: "domain", path: "src/Cli/MountCommand.ts", handle: "ha", range: "1-30", code: "export function mountA() {}\n", required: true, symbol: "mountA", why: "primary-candidate" },
      { role: "domain", path: "src/Services/DriveMounter.ts", handle: "hb", range: "1-30", code: "export function mountB() {}\n", required: true },
      { role: "domain", path: "src/Native/NativeMethods.ts", handle: "hc", range: "1-30", code: "export function mountC() {}\n", required: true },
    ],
    missing: [],
    route: { action: "confirm_candidates", reason: "several plausible targets", max_additional_tl_calls: 0 },
    profile_binding: { requested: "auto", selected, source: "inferred", confidence: 0.8, reason: "shape" },
    execution_contract: chooseCandidateContract(),
  } as unknown as TaskPackResult;
}

const EXPECTED_BUNDLE = {
  tool: "tl_read_file",
  arguments: {
    mode: "task_pack",
    qref: "q-bd",
    paths: ["src/Cli/MountCommand.ts", "src/Services/DriveMounter.ts", "src/Native/NativeMethods.ts"],
  },
};

/** A first, pathless wire request: `query` only, no binding, no targets. */
const firstPathlessArgs = (): TaskPackArgs => ({ query: "mount the drive from the CLI", lane: "default" });

const bodies = (result: TaskPackResult): Array<string | undefined> =>
  result.surfaces.map((surface) => (surface as { code?: string }).code);

describe("TL_PACK_BODYLESS_DISCOVER — a low-confidence first reply ships the candidate list, not the bodies", () => {
  it("strips every addressable body, keeps the rows reachable, and the discover `next` stands", () => {
    const result = candidateListPack();
    expect(deriveCanonicalTaskDecision(result)?.kind).toBe("discover");
    expect(bodylessDiscoverSkipReason(result, { args: firstPathlessArgs(), receipt: false })).toBeUndefined();

    const withheld = applyBodylessDiscover(result, { args: firstPathlessArgs(), receipt: false }, "C:/ws");
    expect(withheld).toBe(3);
    for (const surface of result.surfaces) {
      const row = surface as unknown as Record<string, unknown>;
      expect(row["code"]).toBeUndefined();
      expect(row["content_completeness"]).toBe("partial");
      expect(row["remaining_ranges"]).toEqual(["1-30"]);
      // Addressing survives: handle, path, range, role (and symbol/why where present).
      expect(typeof row["handle"]).toBe("string");
      expect(typeof row["path"]).toBe("string");
      expect(row["range"]).toBe("1-30");
      expect(row["role"]).toBe("domain");
      // Not an SF demotion: `demoted_count` must not be able to claim these rows.
      expect(wasSemanticFrontierBodyWithheld(surface)).toBe(false);
    }
    expect((result.surfaces[0] as unknown as Record<string, unknown>)["symbol"]).toBe("mountA");

    // The decision is restated over what ships and still names the one call that
    // fetches the bodies — the candidate form keeps its executable continuation.
    const decision = deriveCanonicalTaskDecision(result);
    expect(decision?.kind).toBe("discover");
    expect(decision?.next_call).toEqual(EXPECTED_BUNDLE);
    expect(result.execution_contract?.typestate.phase).toBe("discovery");
    expect(result.execution_contract?.next_call).toEqual(EXPECTED_BUNDLE);
    expect(canonicalTaskDecisionInvariantViolations(result)).toEqual([]);

    // The wire rows are A.8.2 E-8's sanctioned body-less shape: no body, no
    // prior, a `remaining` that covers the withheld window.
    const evidence = projectEvidence(result.surfaces);
    expect(evidence).toHaveLength(3);
    for (const row of evidence) {
      expect(row.body).toBeUndefined();
      expect(row.prior).toBeUndefined();
      expect(row.remaining).toEqual(["1-30"]);
      expect(row.handle).toMatch(/^h[abc]$/);
    }
  });

  it("merges the withheld window with what was already owed and with appended windows", () => {
    const result = candidateListPack();
    const first = result.surfaces[0] as unknown as Record<string, unknown>;
    first["remaining_ranges"] = ["31-60"];
    first["appended_windows"] = [{ marker: "// --- 80-90", range: "80-90" }];
    first["anchors_served"] = true;
    applyBodylessDiscover(result, { args: firstPathlessArgs(), receipt: false }, "C:/ws");
    expect(first["remaining_ranges"]).toEqual(["1-60", "80-90"]);
    expect(first["appended_windows"]).toBeUndefined();
    expect(first["anchors_served"]).toBeUndefined();
  });

  it("leaves `code_unchanged` pointers (prior on the wire) alone and keeps an unaddressable body", () => {
    const result = candidateListPack();
    const surfaces = result.surfaces as unknown as Array<Record<string, unknown>>;
    delete surfaces[1]!["code"];
    surfaces[1]!["code_unchanged"] = "see ha";
    delete surfaces[2]!["range"]; // no window to re-fetch by: fail closed, keep the body
    const withheld = applyBodylessDiscover(result, { args: firstPathlessArgs(), receipt: false }, "C:/ws");
    expect(withheld).toBe(1);
    expect(surfaces[0]!["code"]).toBeUndefined();
    expect(surfaces[1]!["code_unchanged"]).toBe("see ha");
    expect(surfaces[1]!["content_completeness"]).toBeUndefined();
    expect(surfaces[2]!["code"]).toBe("export function mountC() {}\n");
  });

  it("a row the request's own anchors resolved to keeps its body; the rest of the pack still goes body-less", () => {
    // 2026-11-03 (`anchoredSpans`): the declaration of a name the request
    // spells, or the exact occurrence of a literal it quotes/brackets
    // (anchorFirst.ts `recallAnchorResolution`), is pointed at by the request,
    // not guessed by the server — `[default: (unlimited)]` in
    // tests/test_options.py (anchorFirstRetrieval.spec.ts). Overlap is by
    // file AND line window; a span in another file or outside the row's
    // window exempts nothing. The thunk is read once the rule applies.
    const result = candidateListPack();
    let reads = 0;
    const anchoredSpans = () => {
      reads += 1;
      return [
        { path: "src/Cli/MountCommand.ts", startLine: 12, endLine: 14 }, // inside row 0's 1-30
        { path: "src/Services/DriveMounter.ts", startLine: 40, endLine: 44 }, // row 1 is 1-30: no overlap
        { path: "src/Elsewhere/Other.ts", startLine: 1, endLine: 30 }, // not a served file
      ];
    };
    const before = JSON.stringify(result.surfaces[0]);
    expect(applyBodylessDiscover(result, { args: firstPathlessArgs(), receipt: false, anchoredSpans }, "C:/ws")).toBe(2);
    expect(reads).toBe(1);
    expect(JSON.stringify(result.surfaces[0]), "the anchored row is untouched, body and all").toBe(before);
    expect(bodies(result)).toEqual(["export function mountA() {}\n", undefined, undefined]);
    for (const surface of result.surfaces.slice(1)) {
      expect((surface as unknown as Record<string, unknown>)["remaining_ranges"]).toEqual(["1-30"]);
    }
    expect(deriveCanonicalTaskDecision(result)?.kind).toBe("discover");

    // A clause that fails never reads the anchors.
    let untouchedReads = 0;
    const flagOff = candidateListPack();
    process.env[FLAG] = "0";
    expect(applyBodylessDiscover(flagOff, { args: firstPathlessArgs(), receipt: false, anchoredSpans: () => { untouchedReads += 1; return []; } }, "C:/ws")).toBe(0);
    delete process.env[FLAG];
    expect(untouchedReads).toBe(0);
  });

  it("the late half: a reply whose decision firmed up after the early pass gets every withheld body back, byte-for-byte", () => {
    // 2026-11-03 (concernStatusPolicyMatrix, 4 concerns / derived-name): the
    // early pass withheld the renewal module while the pack was a `discover`;
    // buildAnswerTaskPack's post-certification anchor pass then re-certified
    // `act.answer` — an answer missing the body it certified over. At
    // buildTaskPack's exit a non-`discover` reply restores what was withheld.
    const result = candidateListPack();
    const first = result.surfaces[0] as unknown as Record<string, unknown>;
    first["remaining_ranges"] = ["31-60"];
    first["appended_windows"] = [{ marker: "// --- 80-90", range: "80-90" }];
    first["anchors_served"] = true;
    // Compared as values (key order is not wire-visible: `projectEvidence`
    // writes each row's keys in its own fixed order).
    const before = result.surfaces.map((surface) => JSON.parse(JSON.stringify(surface)) as unknown);
    expect(applyBodylessDiscover(result, { args: firstPathlessArgs(), receipt: false }, "C:/ws")).toBe(3);
    expect(result.surfaces.every((surface) => isBodylessDiscoverWithheld(surface))).toBe(true);
    // Still a `discover`: nothing comes back.
    expect(restoreBodylessDiscoverIfConfident(result, "C:/ws")).toBe(0);
    expect(bodies(result).every((code) => code === undefined)).toBe(true);
    // The decision firms up (here: the EDIT SAFETY choose-candidate await over
    // a generic candidate list — any non-`discover` kind; the early pass had
    // repaired the contract onto discovery, so the contract is reset with the
    // profile): every row returns exactly as it was, and the marks are cleared.
    (result.profile_binding as { selected: string }).selected = "generic";
    result.execution_contract = chooseCandidateContract() as unknown as TaskPackResult["execution_contract"];
    expect(wireDecision(result)?.kind).not.toBe("discover");
    expect(restoreBodylessDiscoverIfConfident(result, "C:/ws")).toBe(3);
    expect(result.surfaces.map((surface) => JSON.parse(JSON.stringify(surface)) as unknown)).toEqual(before);
    expect(result.surfaces.some((surface) => isBodylessDiscoverWithheld(surface))).toBe(false);
    // Idempotent: a second call has nothing to restore.
    expect(restoreBodylessDiscoverIfConfident(result, "C:/ws")).toBe(0);
    // A pack this rule never touched restores nothing, whatever its decision.
    expect(restoreBodylessDiscoverIfConfident(candidateListPack("generic"), "C:/ws")).toBe(0);
  });

  it("a row the contract cites as the proof of a point the request named keeps its body; the generic surface-content claim exempts nothing", () => {
    // Clause 9 (concernStatusPolicyMatrix, 4 concerns / derived-name): the
    // pack had accepted `sessionRenewal.ts:2-4` as request item ri-4's proof and
    // planned its `next` for the OTHER items; withholding it left the follow-up
    // certifying over a one-line anchor with the implementing body never shipped.
    // A discovery-phase contract whose one next is a search (so clause 8 does
    // not exempt anything either), carrying the model: ri-2 proved by `hb`,
    // ri-3 still open, and the generic surface-content claim citing every row.
    const result = candidateListPack();
    result.coverage_reason = undefined;
    delete (result as unknown as { qref?: string }).qref;
    result.route = { action: "locate_missing_surfaces", reason: "ri-3 open", max_additional_tl_calls: 1 };
    result.execution_contract = {
      version: 1,
      state: "needs-followup",
      readiness: "needs-followup",
      discovery_complete: false,
      next_action: "followup",
      max_additional_discovery_calls: 1,
      reason: "request item ri-3 is still open",
      next_call: { tool: "tl_search_files", arguments: { action: "find", queries: ["mountC"] } },
      typestate: { phase: "discovery", allowed_actions: ["read", "search"], challenge_required_for: [] },
      evidence_model: {
        version: 1,
        decision: "answer",
        claims: [
          { id: "surface-content", kind: "surface-content", status: "supported", reason: "served", evidence_handles: ["ha", "hb", "hc"], confidence: 0.9 },
          { id: "request-item:ri-2", kind: "concern", status: "supported", reason: "proved", evidence_handles: ["hb"], confidence: 0.9 },
          { id: "request-item:ri-3", kind: "concern", status: "unresolved", reason: "open", evidence_handles: [], confidence: 0 },
        ],
        counterexamples: [],
        unresolved: ["request-item:ri-3"],
      },
    } as unknown as NonNullable<TaskPackResult["execution_contract"]>;
    expect([...provedClaimHandles(result)]).toEqual(["hb"]);
    expect(bodylessDiscoverSkipReason(result, { args: firstPathlessArgs(), receipt: false }), JSON.stringify(wireDecision(result))).toBeUndefined();
    expect(applyBodylessDiscover(result, { args: firstPathlessArgs(), receipt: false }, "C:/ws")).toBe(2);
    expect(bodies(result)).toEqual([undefined, "export function mountB() {}\n", undefined]);
    expect(isBodylessDiscoverWithheld(result.surfaces[1]!)).toBe(false);
    // No model (a compacted contract): nothing is exempt by this clause.
    const compacted = candidateListPack();
    expect([...provedClaimHandles(compacted)]).toEqual([]);
  });

  it("a candidate list the dispatcher will bundle (qref minted after this seam) is already judged by the wire it will ship", () => {
    // Without a `qref` the W9 bundle cannot form, so the canonical verdict here
    // is still `await-input`; the dispatcher mints the qref before the wire
    // decision is derived and ships `discover` with the bundle. The rule reads
    // that decision, not the pre-qref one (measured on the tl-setup first reply).
    const result = candidateListPack();
    delete (result as unknown as { qref?: string }).qref;
    expect(deriveCanonicalTaskDecision(result)?.kind).toBe("await-input");
    expect(bodylessDiscoverSkipReason(result, { args: firstPathlessArgs(), receipt: false })).toBeUndefined();
    expect(applyBodylessDiscover(result, { args: firstPathlessArgs(), receipt: false }, "C:/ws")).toBe(3);
    expect(bodies(result).every((code) => code === undefined)).toBe(true);
    // The pack itself never receives the placeholder.
    expect((result as unknown as { qref?: string }).qref).toBeUndefined();
  });

  it("server-derived paths from a pathless query (autoDiscoveredLocation) still count as pathless", () => {
    const result = candidateListPack();
    const args: TaskPackArgs = { ...firstPathlessArgs(), paths: ["src/Cli/MountCommand.ts"], autoDiscoveredLocation: true };
    expect(bodylessDiscoverSkipReason(result, { args, receipt: false })).toBeUndefined();
  });
});

describe("TL_PACK_BODYLESS_DISCOVER — every other shape is untouched", () => {
  const untouched = (result: TaskPackResult, args: TaskPackArgs | undefined, receipt: boolean, reason: string): void => {
    const before = JSON.stringify(result);
    expect(bodylessDiscoverSkipReason(result, { args, receipt })).toBe(reason);
    expect(applyBodylessDiscover(result, { args, receipt }, "C:/ws")).toBe(0);
    expect(JSON.stringify(result)).toBe(before);
    expect(bodies(result).every((code) => typeof code === "string")).toBe(true);
  };

  it("flag off (TL_PACK_BODYLESS_DISCOVER=0) restores the bodies byte-for-byte", () => {
    process.env[FLAG] = "0";
    untouched(candidateListPack(), firstPathlessArgs(), false, "flag-off");
  });

  it("an explicit `targets`/`paths` read keeps its bodies", () => {
    untouched(candidateListPack(), { ...firstPathlessArgs(), paths: ["src/Cli"] }, false, "explicit-target");
    untouched(candidateListPack(), { ...firstPathlessArgs(), path: "src/Cli/MountCommand.ts" }, false, "explicit-target");
    untouched(candidateListPack(), { ...firstPathlessArgs(), symbol: "mountA" }, false, "explicit-target");
  });

  it("a request whose own text names a workspace file keeps its bodies (the dependency rows too)", () => {
    // Clause 2, prose half: "check control/mixer.cpp against CONTRACT.md",
    // "Explain checkLimit in src/main.ts" — the locator did not choose the
    // file, the caller did. Either carrier settles it: the resolver's answer
    // (`requestNamesFile`), or a served row stamped `query-named-file` /
    // `caller-supplied`.
    const resolved = candidateListPack();
    const before = JSON.stringify(resolved);
    expect(bodylessDiscoverSkipReason(resolved, { args: firstPathlessArgs(), receipt: false, requestNamesFile: () => true })).toBe("explicit-target");
    expect(applyBodylessDiscover(resolved, { args: firstPathlessArgs(), receipt: false, requestNamesFile: () => true }, "C:/ws")).toBe(0);
    expect(JSON.stringify(resolved)).toBe(before);
    // The resolver saying "no file named" leaves the rule in force.
    expect(bodylessDiscoverSkipReason(candidateListPack(), { args: firstPathlessArgs(), receipt: false, requestNamesFile: () => false })).toBeUndefined();

    const stamped = candidateListPack();
    (stamped.surfaces[1] as unknown as Record<string, unknown>)["why"] = "query-named-file; nul-stripped";
    untouched(stamped, firstPathlessArgs(), false, "explicit-target");
    const supplied = candidateListPack();
    (supplied.surfaces[2] as unknown as Record<string, unknown>)["why"] = "anchor-focus: query-matched symbol mountC; caller-supplied";
    untouched(supplied, firstPathlessArgs(), false, "explicit-target");
    // Segment-exact: a locator pick from inside a caller-named DIRECTORY is the
    // server's choice, not the caller's (as `callerNamedSurface` reads it).
    const dirPick = candidateListPack();
    (dirPick.surfaces[0] as unknown as Record<string, unknown>)["why"] = "caller-supplied-dir";
    expect(bodylessDiscoverSkipReason(dirPick, { args: firstPathlessArgs(), receipt: false })).toBeUndefined();
  });

  it("a continuation (task.handle / qref binding, or a qref replay) keeps its bodies", () => {
    untouched(candidateListPack(), { ...firstPathlessArgs(), taskBinding: "task-abc" }, false, "continuation");
    untouched(candidateListPack(), { ...firstPathlessArgs(), taskQueryRefReplay: true }, false, "continuation");
  });

  it("force_serve, receipts and a request with no query keep their bodies", () => {
    untouched(candidateListPack(), { ...firstPathlessArgs(), forceServe: true }, false, "force-serve");
    untouched(candidateListPack(), firstPathlessArgs(), true, "receipt");
    untouched(candidateListPack(), { lane: "default" }, false, "no-query");
    untouched(candidateListPack(), undefined, false, "no-request-args");
  });

  it("an artifact (office/csv/archive) pack and a truncated diff pack keep their bodies", () => {
    const artifact = candidateListPack();
    (artifact as unknown as Record<string, unknown>)["artifact_sections"] = [{ path: "docs/spec.docx", kind: "artifact" }];
    untouched(artifact, firstPathlessArgs(), false, "artifact-pack");
    const build = candidateListPack();
    (build as unknown as Record<string, unknown>)["task_profile"] = "artifact_build";
    untouched(build, firstPathlessArgs(), false, "artifact-pack");
    const diff = candidateListPack();
    diff.coverage_reason = "diff-truncated";
    untouched(diff, firstPathlessArgs(), false, "diff-pack");
  });

  it("a `discover` whose next pages the located set (fixed windows) keeps its bodies", () => {
    // Clause 8: the structure map's owed member windows, a change frontier
    // paged behind a cursor, `next[]` sibling pages — page one of a plan over
    // files the pack has already bounded, never a guess.
    expect(isFixedWindowRead({ tool: "tl_read_file", arguments: { cursor: "tlc_s1_abc" } })).toBe(true);
    expect(isFixedWindowRead({ tool: "tl_read_file", arguments: { handle: "ha", range: "31-60" } })).toBe(true);
    expect(isFixedWindowRead({ tool: "tl_read_file", arguments: { handles: ["ha", "hb"] } })).toBe(true);
    expect(isFixedWindowRead({ tool: "tl_read_file", arguments: { qref: "q", targets: [{ path: "src/a.ts", range: "3-9" }, { path: "src/b.ts", symbol: "B" }] } })).toBe(true);
    expect(isFixedWindowRead([
      { tool: "tl_read_file", arguments: { targets: [{ path: "src/a.ts", range: "3-9" }] } },
      { tool: "tl_read_file", arguments: { targets: [{ handle: "hb" }] } },
    ])).toBe(true);
    // The guess shapes: whole candidate files, the W9 paths bundle, a query re-pack, a search.
    expect(isFixedWindowRead({ tool: "tl_read_file", arguments: { qref: "q", targets: [{ path: "src/a.ts" }, { path: "src/b.ts", range: "1-9" }] } })).toBe(false);
    expect(isFixedWindowRead(EXPECTED_BUNDLE)).toBe(false);
    expect(isFixedWindowRead({ tool: "tl_read_file", arguments: { query: "mount the drive", task: { handle: "t" } } })).toBe(false);
    expect(isFixedWindowRead({ tool: "tl_search_files", arguments: { action: "tree", path: "src" } })).toBe(false);
    expect(isFixedWindowRead([])).toBe(false);
    expect(isFixedWindowRead(undefined)).toBe(false);

    // Through the rule: a discovery-phase pack whose one next is the owed
    // window of a file it already serves.
    const paging = candidateListPack();
    paging.coverage_reason = undefined;
    delete (paging as unknown as { qref?: string }).qref;
    (paging.surfaces[0] as unknown as Record<string, unknown>)["remaining_ranges"] = ["31-60"];
    (paging.surfaces[0] as unknown as Record<string, unknown>)["content_completeness"] = "partial";
    const owed = { tool: "tl_read_file", arguments: { targets: [{ path: "src/Cli/MountCommand.ts", range: "31-60" }] } };
    paging.execution_contract = {
      version: 1,
      state: "needs-followup",
      readiness: "needs-followup",
      discovery_complete: false,
      next_action: "read",
      max_additional_discovery_calls: 1,
      reason: "one owed window remains",
      next_call: owed,
      typestate: { phase: "discovery", allowed_actions: ["read", "search"], challenge_required_for: [] },
    } as unknown as NonNullable<TaskPackResult["execution_contract"]>;
    paging.route = { action: "inspect_handles", reason: "owed window", max_additional_tl_calls: 1 };
    const decision = wireDecision(paging);
    expect(decision?.kind).toBe("discover");
    expect(isFixedWindowRead(decision?.next)).toBe(true);
    untouched(paging, firstPathlessArgs(), false, "paging-continuation");
  });

  it("a confident pack — focused/complete coverage, or a decision that is not `discover` — keeps its bodies", () => {
    const focused = candidateListPack();
    focused.coverage = "focused";
    untouched(focused, firstPathlessArgs(), false, "coverage-not-partial");
    const complete = candidateListPack();
    complete.coverage = "complete";
    untouched(complete, firstPathlessArgs(), false, "coverage-not-partial");
    // EDIT SAFETY (discoveryBundle.spec.ts): a generic-profile choose-candidate
    // pack awaits the caller's choice — `await-input`, not `discover`.
    const awaiting = candidateListPack("generic");
    expect(deriveCanonicalTaskDecision(awaiting)?.kind).toBe("await-input");
    untouched(awaiting, firstPathlessArgs(), false, "decision-not-discover");
  });
});

// ---------------------------------------------------------------------------
// Through the real builder: `dedupeTrimAndPersist` runs the pass as the last
// step before the booking pass, so the pack `buildTaskPack` returns is the one
// the wire projects.
// ---------------------------------------------------------------------------
const roots: string[] = [];

function mkWorkspace(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-bodyless-")));
  roots.push(root);
  return root;
}

function writeFile(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** Several files that each answer one word of the question and none that answers it whole. */
function ambiguousWorkspace(): string {
  const ws = mkWorkspace();
  const member = (tag: string, lines: string[]): string => [
    `// ${tag} — one of several candidates.`,
    `export function ${tag}(input: number): number {`,
    ...lines.map((line) => `  ${line}`),
    "}",
    "",
  ].join("\n");
  writeFile(ws, "src/retry/policy.ts", member("retryPolicy", ["const attempts = input + 1;", "return attempts;"]));
  writeFile(ws, "src/net/backoff.ts", member("backoffDelay", ["const delay = input * 2;", "return delay;"]));
  writeFile(ws, "src/upload/failed.ts", member("failedUpload", ["const retried = input - 1;", "return retried;"]));
  writeFile(ws, "src/queue/schedule.ts", member("scheduleRetry", ["const slot = input % 7;", "return slot;"]));
  writeFile(ws, "README.md", "# fixture\n\nRetry, backoff and upload helpers.\n");
  return ws;
}

const AMBIGUOUS_QUERY = "How does the retry policy decide the backoff delay for a failed upload?";

describe("TL_PACK_BODYLESS_DISCOVER through buildTaskPack", () => {
  it("a confident first reply keeps its bodies (the live pipeline left them in place)", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "src/compute.ts", [
      "/** Computes the normal side of an account. */",
      "export function Compute(): number {",
      "  const normalSide = 0;",
      "  return normalSide;",
      "}",
      "",
    ].join("\n"));
    const args = { query: "Explain Compute and what it returns", taskProfile: "answer" } as const;
    const result = await buildTaskPack(args, ws);
    expect(result.surfaces.length).toBeGreaterThan(0);
    expect(bodies(result).some((code) => typeof code === "string" && code.includes("function Compute"))).toBe(true);
    // The exemption that applied is one of the two confidence clauses, never
    // one of the request-shape clauses: this WAS a first, pathless query.
    expect(["coverage-not-partial", "decision-not-discover"]).toContain(
      bodylessDiscoverSkipReason(result, { args: { ...args, lane: "default" }, receipt: false }),
    );
  });

  it("a low-confidence first reply goes out body-less with the same `next`; flag off restores the bodies", async () => {
    // Flag OFF first: the pre-change pack, and the precondition this case needs.
    // No declared profile: the inferred profile over this fixture lands on
    // partial / candidate-list with a `discover` tree next (an answer profile
    // certifies one candidate as `act.answer` instead, and is covered above).
    process.env[FLAG] = "0";
    const offWs = ambiguousWorkspace();
    const args = { query: AMBIGUOUS_QUERY } as const;
    const off = await buildTaskPack(args, offWs);
    const offDecision = deriveCanonicalTaskDecision(off);
    expect(off.coverage, "precondition: the fixture must build a partial pack").toBe("partial");
    expect(offDecision?.kind, "precondition: the fixture must build a discover pack").toBe("discover");
    expect(bodies(off).some((code) => typeof code === "string"), "precondition: the flag-off pack carries bodies").toBe(true);
    expect(bodylessDiscoverSkipReason(off, { args: { ...args, lane: "default" }, receipt: false })).toBe("flag-off");

    // Flag ON (the default): same fixture, fresh session.
    delete process.env[FLAG];
    resetAll();
    handleTable.reset();
    const onWs = ambiguousWorkspace();
    const on = await buildTaskPack(args, onWs);
    const onDecision = deriveCanonicalTaskDecision(on);
    expect(on.coverage).toBe("partial");
    expect(onDecision?.kind).toBe("discover");
    // No fresh body left; every row still addressable with the window it owes.
    expect(bodies(on).every((code) => code === undefined)).toBe(true);
    for (const surface of on.surfaces) {
      const row = surface as unknown as Record<string, unknown>;
      expect(typeof row["handle"]).toBe("string");
      expect(row["content_completeness"]).toBe("partial");
      expect(Array.isArray(row["remaining_ranges"]) && (row["remaining_ranges"] as unknown[]).length > 0).toBe(true);
    }
    // The wire form: body-less rows with `remaining`, and one executable next.
    const evidence = projectEvidence(on.surfaces);
    expect(evidence.length).toBe(on.surfaces.length);
    expect(evidence.every((row) => row.body === undefined && row.prior === undefined && (row.remaining?.length ?? 0) > 0)).toBe(true);
    expect(onDecision?.next_call).toBeDefined();
    expect(["tl_read_file", "tl_search_files"]).toContain(onDecision?.next_call?.tool);
    // The same `next` as the flag-off pack, re-pointed only by the handles the
    // two fresh sessions minted: tool and argument shape agree.
    expect(onDecision?.next_call?.tool).toBe(offDecision?.next_call?.tool);
    expect(Object.keys(onDecision?.next_call?.arguments ?? {}).sort()).toEqual(Object.keys(offDecision?.next_call?.arguments ?? {}).sort());
    expect(canonicalTaskDecisionInvariantViolations(on)).toEqual([]);
    // Same rows, same addressing; only the bodies left.
    expect(on.surfaces.map((s) => [s.path, (s as { range?: string }).range]))
      .toEqual(off.surfaces.map((s) => [s.path, (s as { range?: string }).range]));
  });
});
