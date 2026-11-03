// runtimeAndDedup — extracted implementation; imports point to the owning modules.
import * as fs from "fs";
import * as path from "path";
import type { AnswerCertificationSnapshot } from "./answerCertificates.js";
import type { AwaitingInputLatch } from "../../../util/packServeLog.js";
import type { PackedBlockFingerprint } from "./packState.js";
import type { SourceBodyCapsule } from "../sourceBodyCapsule.js";
import type { TaskExecutionContract } from "@tokenlighten/types";
import type { TaskPackArgs } from "../model.js";
import type { TaskPackResult } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import { EDIT_CONTEXT_WHY } from "./focalFlow.js";
import { EXECUTED_SEARCH_UNCLASSIFIED_WHY } from "./seedAdmission.js";
import { FileReadCache } from "./packBasics2.js";
import { MAX_FINGERPRINT_FILES } from "./packState2.js";
import { MAX_PACK_SOURCE_CAPSULE_BYTES } from "./packState.js";
import { RESIDENT_DEDUP_MIN_BYTES } from "./packState2.js";
import { ROUTE_REASON_ENVELOPE_CAP } from "./packState2.js";
import { RUNNABLE_TARGET_EXTS } from "./completionAndDocSlivers.js";
import { answerCertificationSnapshot } from "./answerCertificates.js";
import { clearAwaitingInputLatch } from "../../../util/packServeLog.js";
import { codeTaskPackSurfaces } from "../artifactSections.js";
import { consultAwaitingInputLatch } from "../../../util/packServeLog.js";
import { countLines } from "../../../util/countLines.js";
import { dedupedSurfaceBody } from "./packState2.js";
import { epochsOverlap } from "./packState2.js";
import { fitsInCap } from "./packTrimming2.js";
import { hasServedCode } from "./wiringEvidence2.js";
import { isCallerRangeSurface } from "../sfWithholdingMarks.js";
import { isExplicitRangeSurface } from "../sfWithholdingMarks.js";
import { isRequiredEnumReview } from "../changeScopeContinuation.js";
import { laneScopedKey } from "../../../util/laneKey.js";
import { lastPackBlocksByWorkspace } from "./packState.js";
import { normalizePathEntry } from "./packBasics2.js";
import { normalizedRequestPath } from "./guideAndArtifactSurfaces.js";
import { packFingerprintBinding } from "./packState.js";
import { parsePackLineRange } from "./packState2.js";
import { parseSurfaceSpan } from "./packState2.js";
import { priorBodyRestoration } from "./packState2.js";
import { protocolCallContext } from "../../../protocol/envelope.js";
import { pythonSyntaxCheck } from "../../../util/verificationPack.js";
import { readCached } from "./packBasics2.js";
import { recordAwaitingInputLatch } from "../../../util/packServeLog.js";
import { recordFunctionalValidationObligation } from "../../../util/packServeLog.js";
import { servedPacksByWorkspace } from "./packState2.js";
import { servedRangeReceipt } from "../../../state/session.js";
import { shaOfText } from "../../../util/handles.js";
import { sourceBodyCapsuleForSurface } from "./packState2.js";
import { sourceCapsuleCovers } from "../sourceBodyCapsule.js";
import { sourceCapsulePrior } from "../sourceCapsuleCallScope.js";
import { stageSourceCapsules } from "../sourceCapsuleCallScope.js";
import { surfaceBodyCoversRange } from "./seedResolution.js";
import { surfaceFileIdentity } from "./packState2.js";
import { surfaceFileSha } from "./packState2.js";
import { surfaceProvenance } from "../sfWithholdingMarks.js";
import { tokenizeForEpoch } from "../../../state/session.js";

/** iter-2 W5: the runnable create/edit target this artifact-sourced pack produces, if any. */
export function runnableArtifactTarget(result: TaskPackResult): string | undefined {
  if ((result.artifact_requirements?.length ?? 0) === 0) return undefined;
  const runnable = (p: string): boolean => RUNNABLE_TARGET_EXTS.has(path.posix.extname(p).toLowerCase());
  if (result.create_target !== undefined && runnable(result.create_target.path)) {
    return result.create_target.path;
  }
  // Edit frontier on a runnable module: a required, code-bearing surface that is
  // not itself one of the artifact source files.
  const sources = new Set((result.artifact_requirements ?? []).map(normalizedRequestPath));
  const editTarget = codeTaskPackSurfaces(result.surfaces).find((s) =>
    s.required !== false
    && hasServedCode(s)
    && runnable(s.path)
    && !sources.has(normalizedRequestPath(s.path))
  );
  return editTarget?.path;
}

/**
 * iter-2 W5 / iter-3 F5b: honest, generic wording — no sheet/filename specifics.
 * Softened to name the CHEAPEST sufficient proof so the obligation cannot be read
 * as license for an extended validation campaign (the T10-class tail): ONE smoke
 * run of the produced module against the served values, OR a diff review of the
 * produced values (the existing diff discharge). A passing type-check/compile
 * alone is still not validation.
 */
export const FUNCTIONAL_VALIDATION_NOTE =
  "validate the produced module the cheap way before closing — ONE smoke run against the served artifact values, "
  + "OR a diff review of the produced values (a passing type-check/compile alone is not validation); "
  + "no extended validation campaign is expected";

/**
 * iter-2 W5: when an artifact-sourced pack targets a runnable create/edit, add
 * ONE named functional-validation obligation to the pack's verify output and
 * record it in the session so a self-check consult can list it OPEN until a
 * verification-evidence event discharges it. Honest, not a refusal. Detection is
 * purely structural (artifact_requirements present + runnable target extension);
 * no title/filename matching of specific sheets.
 */
export function attachFunctionalValidationObligation(
  workspace: string,
  result: TaskPackResult,
): void {
  if (result.route?.action === "answer_from_handles") return;
  const target = runnableArtifactTarget(result);
  if (target === undefined) return;
  // Recorded under THIS task epoch (packServeLog resets it on a flip), so a
  // self-check consult can list it OPEN until a verification-evidence event —
  // done unconditionally (state, not bytes), even if the verify line below is
  // shed for budget.
  recordFunctionalValidationObligation(workspace, { note: FUNCTIONAL_VALIDATION_NOTE, targetPath: target });
  const verify = result.verify ?? [];
  if (verify.some((v) => v.startsWith(FUNCTIONAL_VALIDATION_NOTE))) return;
  // Added AFTER trimToCap, so commit it speculatively and keep it only when it
  // still fits (mirrors annotateSpannedRoots) — never reopen a budget trim just
  // closed.
  const line = `${FUNCTIONAL_VALIDATION_NOTE} [target ${target}]`;
  if (fitsInCap({ ...result, verify: [...verify, line] })) {
    result.verify = [...verify, line];
  }
}

/**
 * 2026-10-20 (decision window 6t-7, T10 arm A): the smoke run the line above
 * asks for needs an interpreter, and on that host the PATH's python3 was
 * 3.9.6 against requires-python >=3.10. Every arm-A cell spent 4-7 Bash turns
 * finding /opt/homebrew/bin/python3.12, and one wrote a fake openpyxl package
 * first. A Python artifact target's pack now carries the check and note the
 * edit kit's harness.syntax_check would (verificationPack.ts
 * pythonSyntaxCheck), with the module its artifact kind needs (xlsx:
 * openpyxl) counted when the project declares it. The target is usually
 * outside discoverVerificationHints' dominant root (its own pyproject.toml
 * roots it apart from the docs it is built from), hence its own pass. Like
 * the obligation, it is added after trimToCap and kept only when it fits.
 */
export function attachPythonInterpreterHint(workspace: string, result: TaskPackResult): void {
  if (result.route?.action === "answer_from_handles") return;
  const target = runnableArtifactTarget(result);
  if (target === undefined || path.posix.extname(target).toLowerCase() !== ".py") return;
  const modules = [...new Set((result.artifact_requirements ?? [])
    .map((source) => PY_ARTIFACT_MODULE[path.posix.extname(normalizedRequestPath(source)).toLowerCase()])
    .filter((module): module is string => module !== undefined))];
  const check = pythonSyntaxCheck(workspace, [target], { extraModules: modules, includeMissing: true });
  if (check === undefined) return;
  const verify = result.verify ?? [];
  const at = verify.indexOf(check.commands[0]!);
  if (at >= 0) {
    // discoverVerificationHints already stated the command (the target shares
    // the pack's root), with a note that could not count the artifact's
    // module: swap this one in when that note is provably the one it wrote.
    const plain = pythonSyntaxCheck(workspace, [target], { includeMissing: true });
    if (plain !== undefined && plain.note !== check.note && verify[at + 1] === plain.note) {
      const swapped = verify.map((line, index) => (index === at + 1 ? check.note : line));
      if (fitsInCap({ ...result, verify: swapped })) result.verify = swapped;
    }
    return;
  }
  const lines = [check.commands[0]!, check.note];
  if (fitsInCap({ ...result, verify: [...verify, ...lines] })) {
    result.verify = [...verify, ...lines];
  }
}

// ---------------------------------------------------------------------------
// iter-3 F5: runtime hint (python interpreter + module presence, fs-stat only)
// ---------------------------------------------------------------------------

/** iter-3 F5: Office source extension → the python site-packages module dir an artifact of that kind needs. */
export const PY_ARTIFACT_MODULE: Record<string, string> = {
  ".xlsx": "openpyxl",
  ".xlsm": "openpyxl",
  ".xltx": "openpyxl",
  ".docx": "docx", // python-docx installs as the 'docx' package
  ".pptx": "pptx", // python-pptx installs as the 'pptx' package
  // NOTE: no ".csv"/".tsv" entry on purpose — Python's `csv` module is in the
  // stdlib, so a csv-sourced build needs no site-packages module and gets no
  // runtime hint (attachRuntimeHint returns early when moduleDir is undefined).
};

/** iter-3 F5: overall byte ceiling for the whole runtime hint (kept well under the pack budget). */
export const RUNTIME_HINT_MAX_BYTES = 500;

/**
 * iter-3 F5: python3* interpreters discovered by filesystem stat only — PATH
 * entries plus common Homebrew/System locations. NEVER executed (no child
 * process); a stat that resolves to a file (symlinks are followed) counts. This
 * is a hint source, not a guarantee the interpreter runs.
 */
export function discoverPythonInterpreters(): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const consider = (candidate: string): void => {
    if (seen.has(candidate)) return;
    seen.add(candidate);
    try {
      if (fs.statSync(candidate).isFile()) found.push(candidate); // statSync follows symlinks
    } catch { /* absent / broken symlink — skip */ }
  };
  const names = ["python3", "python3.13", "python3.12", "python3.11", "python3.10", "python"];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir.length === 0) continue;
    for (const name of names) consider(path.join(dir, name));
  }
  for (const common of [
    "/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3",
    "/opt/homebrew/bin/python3.13", "/opt/homebrew/bin/python3.12", "/opt/homebrew/bin/python3.11",
    "/Library/Frameworks/Python.framework/Versions/Current/bin/python3",
  ]) consider(common);
  return found;
}

/**
 * iter-3 F5: does `binPath`'s install tree appear to contain `moduleDir` in its
 * site-packages? fs.stat only (no import, no exec): from the interpreter prefix
 * (dirname twice), scan each `<prefix>/lib/python3.<n>/site-packages/<moduleDir>`.
 * A true result means the package DIRECTORY exists on disk — a hint that the
 * import will resolve, not a proof (a broken/partial install still stats).
 */
export function pythonHasModule(binPath: string, moduleDir: string): boolean {
  const prefix = path.dirname(path.dirname(binPath));
  const libDir = path.join(prefix, "lib");
  let libEntries: string[];
  try {
    libEntries = fs.readdirSync(libDir);
  } catch {
    return false;
  }
  for (const entry of libEntries) {
    if (!/^python3(\.\d+)?$/.test(entry)) continue;
    const modPath = path.join(libDir, entry, "site-packages", moduleDir);
    try {
      if (fs.statSync(modPath).isDirectory()) return true;
    } catch { /* not here — keep scanning versions */ }
  }
  return false;
}

/**
 * iter-3 F5: when an artifact-sourced pack's sources are Office files AND its
 * runnable create/edit target is a Python module, attach ONE compact `runtime`
 * hint — discovered python3* interpreters and whether each appears to carry the
 * module the artifact kind needs (xlsx→openpyxl, docx→python-docx). Purely a
 * hint (fs presence, not import-tested); bounded to RUNTIME_HINT_MAX_BYTES and
 * skipped silently on a non-Python target, non-Office sources, or when no
 * interpreter is found. Attached speculatively and kept only if it still fits the
 * pack cap (mirrors attachFunctionalValidationObligation / annotateSpannedRoots).
 */
export function attachRuntimeHint(result: TaskPackResult): void {
  if (result.route?.action === "answer_from_handles") return;
  const target = runnableArtifactTarget(result);
  if (target === undefined) return;
  if (path.posix.extname(target).toLowerCase() !== ".py") return; // Python targets only
  let moduleDir: string | undefined;
  for (const src of result.artifact_requirements ?? []) {
    const mod = PY_ARTIFACT_MODULE[path.posix.extname(normalizedRequestPath(src)).toLowerCase()];
    if (mod !== undefined) { moduleDir = mod; break; }
  }
  if (moduleDir === undefined) return; // sources aren't a known Office kind
  const bins = discoverPythonInterpreters();
  if (bins.length === 0) return; // nothing found → skip silently
  // Interpreters carrying the module first, so byte-trimming keeps the useful ones.
  const interpreters = bins
    .map((p) => ({ path: p, has_module: pythonHasModule(p, moduleDir!) }))
    .sort((a, b) => Number(b.has_module) - Number(a.has_module));
  const note =
    `hint only (fs presence, NOT import-tested): a python3 whose site-packages has "${moduleDir}" can build ${target}`;
  const build = () => ({ kind: "python" as const, note, module: moduleDir!, interpreters });
  while (interpreters.length > 1
    && Buffer.byteLength(JSON.stringify({ runtime: build() }), "utf8") > RUNTIME_HINT_MAX_BYTES) {
    interpreters.pop();
  }
  const hint = build();
  if (Buffer.byteLength(JSON.stringify({ runtime: hint }), "utf8") > RUNTIME_HINT_MAX_BYTES) return;
  if (fitsInCap({ ...result, runtime: hint })) {
    result.runtime = hint;
  }
}

// ---------------------------------------------------------------------------
// iter-3 F4: envelope weight — trim orientation-only metadata on packs 2+ and
// on any prepared/complete pack, where the caller already holds the code body.
// ---------------------------------------------------------------------------

/**
 * iter-3 F4: is this the FIRST pack of the active epoch (no prior overlapping-
 * epoch record captured yet)? The first exploratory pack keeps today's full
 * envelope for orientation value; later packs shed it (the caller already has
 * the map). Read BEFORE captureServedPack runs, so it reflects prior calls only.
 */
export function isFirstEpochPack(workspace: string, epochTokens: readonly string[]): boolean {
  const records = servedPacksByWorkspace.get(laneScopedKey(workspace));
  if (records === undefined || records.length === 0) return true;
  if (epochTokens.length === 0) return records.length === 0;
  return !records.some((r) => epochsOverlap(r.epochTokens, epochTokens));
}

/**
 * iter-3 F4: shed orientation-only envelope weight.
 *
 * Two tiers, because the pieces differ in whether they carry FIRST-TIME
 * information a caller still needs:
 *  (a) session-once orientation that a caller who has seen this working set no
 *      longer needs — the top-level `tree` navigation inventory, per-surface
 *      `outline` and `why` on FULL-code surfaces (a partial/code-less surface
 *      keeps its outline — it drives slice zooming over the unfetched span).
 *      Dropped only on a REPEAT pack (packs 2+) of the epoch: the first pack —
 *      even a complete/focused one — is the caller's first orientation to this
 *      set, so its per-surface provenance (anchor-focus `why`, doc heading
 *      `outline`) is first-time information and is preserved.
 *  (b) redundancy independent of position — `likely_edits` on a read/answer
 *      profile (nothing to edit), and an overlong route.reason — dropped on any
 *      pack that is NOT the first exploratory pack OR is prepared/complete.
 *
 * The first exploratory pack (partial, not prepared/complete) is returned
 * untouched. Returns the bytes saved (for measurement/tests). Mutates in place.
 */
/**
 * Serve-honesty (2026-08-01): an EDIT-terminal route names the zoom affordance
 * whenever required surfaces disclose remaining_ranges. Runs AFTER
 * applyEnvelopeWeightTrim (same discipline as annotateSpannedRoots' span
 * remedy): the reason cap cuts on the last clause boundary, which is exactly
 * where this suffix would sit, and it is load-bearing honesty — the
 * multi_concern builder mints its route directly (never through buildRoute's
 * Wave-4 zoomNote), so without this pass a windowed serve read as a silent
 * "complete" and the caller's only visible continuation was native IO (T05c
 * rep2 desertion trigger).
 */
export function annotateEditZoomAffordance(result: TaskPackResult): void {
  const route = result.route;
  if (route === undefined || route.action !== "edit_from_handles") return;
  if (route.reason.includes("remaining_ranges")) return;
  const partialDisclosed = codeTaskPackSurfaces(result.surfaces).filter((s) =>
    s.required !== false
    && (s.content_completeness === "partial" || (s.remaining_ranges?.length ?? 0) > 0)).length;
  if (partialDisclosed === 0) return;
  result.route = {
    ...route,
    reason: `${route.reason}; ${partialDisclosed} surface(s) have remaining lines (re-slice to zoom, or ONE tl_read_file {targets:[{handle}], content:"full"} when most of the file is needed)`,
  };
}

export function applyEnvelopeWeightTrim(
  result: TaskPackResult,
  isFirstPack: boolean,
  isChangeProfile: boolean,
): number {
  const phase = result.execution_contract?.typestate?.phase;
  const preparedOrComplete =
    phase === "prepared" || result.coverage === "complete" || result.coverage === "focused";
  if (isFirstPack && !preparedOrComplete) return 0;
  const before = Buffer.byteLength(JSON.stringify(result), "utf8");
  // (b) position-independent redundancy.
  if (!isChangeProfile) {
    for (const surf of codeTaskPackSurfaces(result.surfaces)) delete surf.likely_edits;
  }
  if (result.route !== undefined && result.route.reason.length > ROUTE_REASON_ENVELOPE_CAP) {
    // Cut on a clause boundary, not mid-word. route.reason is assembled as
    // "<base>; <decorator>; <decorator>", so a hard slice left readers and
    // telemetry with fragments like "frontier_index is the complete" — a clause
    // that reverses its own meaning once the rest is gone. Fall back to the hard
    // cut only when there is no boundary to land on.
    const capped = result.route.reason.slice(0, ROUTE_REASON_ENVELOPE_CAP);
    const lastBoundary = capped.lastIndexOf("; ");
    result.route.reason = lastBoundary > 0 ? capped.slice(0, lastBoundary) : capped;
  }
  // (a) orientation the caller already holds — REPEAT packs only.
  if (!isFirstPack) {
    delete result.tree;
    for (const surf of codeTaskPackSurfaces(result.surfaces)) {
      const carriesFullCode = surf.code !== undefined && surf.content_completeness !== "partial";
      if (carriesFullCode) {
        // SHOULD-FIX 28 (2026-09-14, review round 4): one `why` is NOT
        // orientation the caller already holds — it is a CAVEAT ABOUT THIS
        // BODY. A surface promoted out of the executed-search ledger in a
        // language this server cannot classify says so in its `why`
        // (`EXECUTED_SEARCH_UNCLASSIFIED_WHY`: the declaration is unverified),
        // and stripping that leaves a full-bodied surface that reads exactly
        // like a verified one. Every other `why` is a provenance label the
        // caller has seen before, and keeps being dropped.
        // Review provenance also constrains the certificate rebuilt later.
        if (surf.why !== EXECUTED_SEARCH_UNCLASSIFIED_WHY && !isRequiredEnumReview(surf.why)
          && surf.why?.startsWith(EDIT_CONTEXT_WHY) !== true) delete surf.why;
        delete surf.outline;
      }
    }
  }
  return before - Buffer.byteLength(JSON.stringify(result), "utf8");
}

/** iter-2 W4: sorted, de-duped input paths a pack "already had" — its surfaces plus any caller-supplied paths. */
export function collectPackInputPaths(result: TaskPackResult, args: TaskPackArgs | undefined): string[] {
  const set = new Set<string>();
  for (const s of result.surfaces) if (typeof s.path === "string" && s.path.length > 0) set.add(normalizedRequestPath(s.path));
  if (typeof args?.path === "string" && args.path.length > 0) set.add(normalizedRequestPath(args.path));
  for (const entry of args?.paths ?? []) {
    const p = normalizePathEntry(entry).path;
    if (typeof p === "string" && p.length > 0) set.add(normalizedRequestPath(p));
  }
  return [...set].sort();
}

/** iter-2 W4: content fingerprint of the referenced files — a change clears the awaiting-input latch. */
export function packInputFingerprint(workspace: string, inputPaths: readonly string[]): string {
  const parts: string[] = [];
  for (const p of inputPaths.slice(0, MAX_FINGERPRINT_FILES)) {
    parts.push(`${p}:${surfaceFileSha(workspace, p) ?? "missing"}`);
  }
  return shaOfText(parts.join("\u0000"));
}

/**
 * iter-2 W4: a genuine unresolved-PROOF wait (the D4 artifact-input escape), NOT
 * a human candidate/concern choice — those have their own resolution machinery
 * (the caller picks a served candidate) and must not be latched.
 */
export function isGenuineProofWait(result: TaskPackResult, contract: TaskExecutionContract): boolean {
  if (contract.next_action !== "request-user-input") return false;
  if (result.route?.action === "confirm_candidates") return false;
  if (result.coverage_reason === "candidate-list") return false;
  return (result.artifact_requirements?.length ?? 0) > 0
    || /unresolved proof/i.test(contract.reason);
}

/**
 * iter-2 W4: awaiting-input idempotency. Consulted at the finalizer AFTER the
 * contract is settled.
 *   - awaiting-input (genuine proof) → record the latch so a later re-ask cannot
 *     silently escape it; serve the pack as-is (return undefined).
 *   - prepared, latch still holds (same epoch, no new inputs, files unchanged) →
 *     DOWNGRADE to a compact awaiting-input receipt (return it) so re-issuing the
 *     query cannot re-grant `prepared` for a still-unresolved proof.
 *   - otherwise (latch cleared / different task / discovery) → return undefined.
 */
export function applyAwaitingInputIdempotency(
  workspace: string,
  result: TaskPackResult,
  args: TaskPackArgs,
  effectiveQuery: string,
): TaskPackResult | undefined {
  const contract = result.execution_contract;
  const phase = contract?.typestate?.phase;
  const epochTokens = tokenizeForEpoch(effectiveQuery);
  const inputPaths = collectPackInputPaths(result, args);
  const fileFingerprint = packInputFingerprint(workspace, inputPaths);

  if (phase === "awaiting-input" && contract !== undefined) {
    if (isGenuineProofWait(result, contract)) {
      const unresolved = contract.semantic_closure?.unresolved?.[0]
        ?? contract.evidence_model?.unresolved?.[0]
        ?? "the required input";
      const residentHandles = codeTaskPackSurfaces(result.surfaces).map((s) => s.handle).slice(0, 8);
      recordAwaitingInputLatch(workspace, {
        unresolvedProof: unresolved,
        inputPaths,
        fileFingerprint,
        note: `awaiting input to resolve "${unresolved}"; re-issuing the query does not resolve it — supply the missing input `
          + `(new paths/handles) or challenge the certificate. Resident handles already served: ${residentHandles.join(",") || "(none)"}`,
      });
    }
    return undefined;
  }

  if (phase === "prepared") {
    const latch = consultAwaitingInputLatch(workspace, epochTokens, inputPaths, fileFingerprint);
    if (latch === undefined) {
      // Genuinely prepared (or a different task) — drop any stale latch.
      clearAwaitingInputLatch(workspace);
      return undefined;
    }
    return downgradeToAwaitingInput(workspace, result, latch);
  }
  return undefined;
}

/**
 * iter-2 W4: rebuild `result` as a compact awaiting-input receipt that re-emits
 * the latched verdict. Surfaces the caller already holds (resident this epoch)
 * are stripped to identity; any genuinely new surface keeps its body so no fresh
 * evidence is hidden. The execution_contract is forced to awaiting-input with
 * the latch note; workspace_state is preserved so the caller can still revalidate.
 */
export function downgradeToAwaitingInput(
  workspace: string,
  result: TaskPackResult,
  latch: AwaitingInputLatch,
): TaskPackResult {
  const resident = residentSurfaceKeys(workspace, result);
  const surfaces = codeTaskPackSurfaces(result.surfaces).map((s) => {
    const isResident = resident.has(`${s.path} ${s.range}`);
    return {
      handle: s.handle,
      path: s.path,
      range: s.range,
      role: s.role,
      // Keep a NEW surface's body; strip a resident one (the caller holds it).
      ...(isResident ? {} : (s.code !== undefined ? { code: s.code } : {})),
    } as TaskPackSurface;
  });
  const prior = result.execution_contract;
  const awaitingContract: TaskExecutionContract = {
    version: prior?.version ?? 1,
    state: "needs-followup",
    readiness: "needs-followup",
    discovery_complete: false,
    next_action: "request-user-input",
    max_additional_discovery_calls: 0,
    reason: latch.note,
    ...(prior?.workspace_state ? { workspace_state: prior.workspace_state } : {}),
    ...(prior?.evidence_model ? { evidence_model: prior.evidence_model } : {}),
    ...(prior?.semantic_closure
      ? { semantic_closure: { ...prior.semantic_closure, state: "awaiting-input" } }
      : {}),
    typestate: {
      phase: "awaiting-input",
      allowed_actions: ["request-user-input"],
      challenge_required_for: [],
    },
  } as TaskExecutionContract;
  return {
    mode: "task_pack",
    // Honestly NOT complete — the proof is unresolved, so a complete-stop route
    // (and any cumulative-complete claim) must not survive the downgrade.
    coverage: "partial",
    coverage_reason: "missing-roles",
    surfaces,
    missing: [...result.missing],
    route: {
      action: "locate_missing_surfaces",
      reason: latch.note,
      max_additional_tl_calls: 0,
    },
    ...(result.task_profile ? { task_profile: result.task_profile } : {}),
    ...(result.artifact_requirements ? { artifact_requirements: [...result.artifact_requirements] } : {}),
    execution_contract: awaitingContract,
  };
}

/**
 * iter-2 W4/W1: `${path} ${range}` keys of surfaces that an earlier serve in
 * this session delivered AND whose file is still byte-identical (so the caller
 * holds an up-to-date copy). Epoch scoping is the caller's responsibility — the
 * W4 latch consult has already confirmed the same task epoch before this runs.
 *
 * eval-0927 §6.1 fix (2026-09-27): a captured surface whose OWN serve was
 * disclosed-partial (`content_completeness:"partial"`, ALWAYS paired with a
 * non-empty `remaining_ranges` per TaskPackSurface's own contract — see
 * model.ts) shipped only part of its declared `range`. `downgradeToAwaitingInput`
 * (this function's one caller) strips a resident surface's body down to
 * identity — doing that for a range this session never actually delivered in
 * full would tell the caller it already holds bytes it does not have. Skipped
 * here exactly as `applyResidentFileDedup` already skips it on its own pack's
 * surfaces (this function's sibling below) for the identical reason.
 */
export function residentSurfaceKeys(workspace: string, _result: TaskPackResult): Set<string> {
  const out = new Set<string>();
  const records = servedPacksByWorkspace.get(laneScopedKey(workspace));
  if (records === undefined) return out;
  for (const rec of records) {
    const shaByPath = new Map(rec.fileShas.map(({ path: p, sha }) => [p, sha]));
    for (const s of rec.surfaces) {
      if (s.content_completeness === "partial") continue;
      const capturedSha = shaByPath.get(s.path);
      if (capturedSha === undefined) continue;
      if (surfaceFileSha(workspace, s.path) !== capturedSha) continue;
      out.add(`${s.path} ${s.range}`);
    }
  }
  return out;
}

/**
 * iter-3 F3: content-addressed index of `${path}\u0000${range}` -> the prior
 * serve's { handle, sha } for every surface an EARLIER same-epoch pack in this
 * session delivered AND whose file is still byte-identical. Epoch-scoped here
 * (unlike residentSurfaceKeys, whose caller pre-confirms the epoch): a body
 * served under a DIFFERENT task may have been compacted out of the caller's
 * context, so only records whose epoch overlaps the current one count. First
 * writer wins (the earliest serve owns the resident handle the caller holds).
 *
 * eval-0927 §6.1 fix (2026-09-27): SAME skip as `residentSurfaceKeys` above,
 * for the SAME reason, on the subsumption side this time. Before this fix a
 * surface captured with `range:"1-40"` but shipped only lines 1-20
 * (`content_completeness:"partial"`, `remaining_ranges:["21-40"]`) still
 * indexed key `path\u00001-40` as fully resident, so a LATER request for
 * exactly the disclosed-but-never-shipped `21-40` window matched by
 * SUBSUMPTION in `applyResidentFileDedup` (`entry.span.start <= start &&
 * entry.span.end >= end`) and was answered with a body-less `code_unchanged`
 * "already served this session" pointer for bytes that had never shipped —
 * confirmed live (`scratchpad/int/probe-prior2.mts dev query`): call B's
 * `21-40`/`64-83`/`107-126` all came back `prior`/`code_unchanged` although
 * only their first halves were ever on the wire. `applyResidentFileDedup`
 * already refuses to STRIP a partial surface's OWN body one loop below
 * (`if (surf.content_completeness === "partial") continue;`); this is the
 * missing other half — refusing to grant a FUTURE surface residency FROM one.
 */
export function residentBodyIndex(
  workspace: string,
  epochTokens: readonly string[],
): Map<string, { handle: string; sha: string }> {
  const idx = new Map<string, { handle: string; sha: string }>();
  const records = servedPacksByWorkspace.get(laneScopedKey(workspace));
  if (records === undefined || epochTokens.length === 0) return idx;
  for (const rec of records) {
    if (!epochsOverlap(rec.epochTokens, epochTokens)) continue;
    const shaByPath = new Map(rec.fileShas.map(({ path: p, sha }) => [p, sha]));
    for (const s of rec.surfaces) {
      if (s.content_completeness === "partial") continue;
      const capturedSha = shaByPath.get(s.path);
      if (capturedSha === undefined) continue;
      if (surfaceFileSha(workspace, s.path) !== capturedSha) continue;
      const key = `${s.path}\u0000${s.range}`;
      if (!idx.has(key)) idx.set(key, { handle: s.handle, sha: capturedSha });
    }
  }
  return idx;
}

/** iter-3 F3: compact 12-hex form of a stored `sha256:<hex>` content sha, for the resident marker. */
export function shortSha(sha: string): string {
  return sha.replace(/^sha256:/, "").slice(0, 12);
}

/**
 * iter-3 F3 (cross-pack resident-file dedup): legitimately-DIFFERENT packs in one
 * session (an enum change, a backend query, a frontend view) each re-served the
 * same unchanged shared file body (the forensic: a shared enums file re-sent up
 * to 3×). applyPackDedupe only catches the immediately-PRIOR pack and keys on the
 * handle, so a shared file resurfacing two packs later — or under a fresh handle
 * — slipped through. This pass, run right after applyPackDedupe, replaces the
 * `code` of any NON-required surface whose exact (path,range) body was already
 * served this epoch AND whose file is byte-unchanged with a compact code-less
 * resident marker naming the prior handle + sha, so the caller (who already holds
 * that body) is told where it is instead of paying for it again. The real body is
 * preserved server-side (dedupedSurfaceBody) so proof passes stay deterministic,
 * exactly as applyPackDedupe does. Conservative:
 *   - only bodies >= RESIDENT_DEDUP_MIN_BYTES (tiny ones aren't worth indirection);
 *   - never a `required` edit-frontier surface (its body stays fully visible),
 *     UNLESS `allowRequiredDedup` says this pack has no edit frontier to protect;
 *   - exact (path,range) match with the file proven byte-unchanged (so the marker
 *     truthfully points at bytes the caller already has).
 *
 * FIX-FC (eval-0927 review finding 15, 2026-09-27) — TWO FIXES, ONE ROOT CAUSE.
 *
 * Live repro (`bigConstants`): a facet/closure chain's own re-added "anchor"
 * window (`src/retry.ts:66-87`, a `runInternalReadinessFalsification`
 * counterexample) shipped as a brand-new body on hop 1, then AGAIN,
 * byte-for-byte, several hops later in the SAME task — 1954 B repeated for
 * bytes the caller already held.
 *
 * (1) `allowRequiredDedup` (new parameter, default `false` — every EXISTING
 *     caller keeps today's behaviour byte-for-byte). The counterexample
 *     surface above is marked `required: candidate.strong` — a signal that it
 *     is IMPORTANT EVIDENCE for the answer's proof, not that it is an EDIT
 *     TARGET. The pre-existing skip conflated the two: "keep the edit
 *     target's body inline" is the right call for a write-shaped pack (an
 *     edit needs the caller to hold the literal current bytes), but an
 *     "answer" task profile never carries a write frontier at all — nothing
 *     `required` on such a pack is ever an edit target, so exempting it from
 *     residency here only re-ships bytes the caller already has, with no
 *     compensating benefit. Callers pass `true` exactly when this pack's own
 *     `task_profile`/`profile_binding` proves it is answer-only.
 *
 * (2) The historical "same handle → applyPackDedupe/pack_unchanged own this"
 *     skip assumed any handle match already went through `applyPackDedupe`.
 *     That is true only for the IMMEDIATELY PRIOR pack (`applyPackDedupe`'s
 *     own single-slot `lastPackBlocksByWorkspace`) — this function exists
 *     specifically for the case that assumption fails, "a shared file
 *     resurfacing two packs later" (its own doc, above). By the time this
 *     loop reaches a surface with `surf.code !== undefined`, `applyPackDedupe`
 *     (which runs immediately before this pass, in every caller) has already
 *     had its chance at THIS exact object and evidently found no match —
 *     otherwise `code` would already be `undefined`. So a residency-index hit
 *     sharing the current surface's own (deterministic, content-addressed)
 *     handle is not evidence of anything special: it is simply the same
 *     window, byte-identical, resident from an OLDER pack `applyPackDedupe`'s
 *     one-slot cache no longer remembers — exactly what this function is for.
 *     The skip is removed; no code path relied on it (no test constructs a
 *     resident hit whose handle equals the surface's own).
 */
export function applyResidentFileDedup(
  workspace: string,
  result: TaskPackResult,
  epochTokens: readonly string[],
  options?: {
    /** True when this pack's own task profile proves `required` never means "edit target" here — see this function's own doc comment, fix (1). */
    allowRequiredDedup?: boolean;
    /** Surfaces that must keep their body regardless of residency (the caller's own windows under a small-window reserve force). */
    exempt?: (surface: TaskPackSurface) => boolean;
  },
): void {
  if (result.pack_unchanged === true) return;
  const idx = residentBodyIndex(workspace, epochTokens);
  // B2b (2026-08-01 serving-completeness): PACK PADDING. Live defect
  // (2026-07-31-semantic-signal5-2, T09): a caller-scoped pack for ONE new doc
  // padded itself with 14.6KB of surfaces this session had ALREADY served —
  // they missed this pass because the index keyed on an EXACT (path,range) pair
  // from a prior PACK. Two generalizations, both holding the "a marker must
  // truthfully name bytes the caller already has" bar:
  //   (a) a range SUBSUMED by an already-served range of the same file counts
  //       (the caller holds a superset), and
  //   (b) the session’s own served-range ledger counts as evidence, not only
  //       prior packs — a slice/symbol/full serve of those lines leaves them
  //       exactly as resident as a pack surface did.
  // Per-path list form of the pack index, for the subsumption test.
  const residentByPath = new Map<
    string,
    Array<{ span: { start: number; end: number }; handle: string; sha: string }>
  >();
  for (const [key, value] of idx) {
    const cut = key.lastIndexOf("\u0000");
    if (cut <= 0) continue;
    const span = parseSurfaceSpan(key.slice(cut + 1));
    if (span === undefined) continue;
    const relPath = key.slice(0, cut);
    const list = residentByPath.get(relPath) ?? [];
    list.push({ span, handle: value.handle, sha: value.sha });
    residentByPath.set(relPath, list);
  }
  for (const surf of codeTaskPackSurfaces(result.surfaces)) {
    if (surf.code === undefined) continue; // nothing to strip (or already deduped)
    if (options?.exempt?.(surf) === true) continue;
    if (surf.required === true && options?.allowRequiredDedup !== true) continue; // keep the edit target's body inline
    if (Buffer.byteLength(surf.code, "utf8") < RESIDENT_DEDUP_MIN_BYTES) continue;
    // A disclosed-partial body is NOT the whole `range`; claiming residency
    // over that range would over-state what the caller holds.
    if (surf.content_completeness === "partial") continue;
    const span = parseSurfaceSpan(String(surf.range ?? ""));
    let hit = idx.get(`${surf.path}\u0000${surf.range}`);
    if (hit === undefined && span !== undefined) {
      hit = (residentByPath.get(surf.path) ?? []).find(
        (entry) => entry.span.start <= span.start && entry.span.end >= span.end,
      );
    }
    if (hit !== undefined) {
      dedupedSurfaceBody.set(surf, surf.code);
      surf.code_unchanged =
        `${hit.handle} — already served this session (${surf.path}:${surf.range}, sha ${shortSha(hit.sha)}); `
        + `resident in your context — re-read ${hit.handle} only if the body is needed`;
      surf.code = undefined;
      continue;
    }
    // B2b RESIDUAL (deliberate): the session's served-range LEDGER also proves
    // residency for slice/symbol/full serves and for packs of a different task
    // epoch — but packServeIter3's "does NOT strip across a DIFFERENT task
    // epoch (the body may be out of context)" contract owns that ground, and
    // the ledger carries no epoch to honor it with. Cross-epoch padding is left
    // un-deduped rather than silently weakening that guarantee.
  }
}

/**
 * P1-1 item 2 (2026-09-08, v0.14.1 hands-on report): A WINDOW THIS SESSION
 * ALREADY PUT ON THE WIRE IS SERVED EVIDENCE, EVEN WHEN THIS PACK DID NOT
 * INLINE IT.
 *
 * `applyResidentFileDedup` above answers "may I STRIP this body?", so it
 * returns early for every surface with no `code` to strip. That left the
 * OTHER half of the same fact unstated: a surface this pack never inlined,
 * whose exact window the caller nevertheless received earlier this session, is
 * indistinguishable — to `hasServedCode`, and therefore to `codelessRequired`
 * / `gapFallback` / `requiredServed` — from a surface nobody has ever seen. So
 * a re-pack after the caller ran the prescribed read kept re-deriving the
 * SAME "this surface is code-starved" gap over bytes already in the caller's
 * context, which is the producer half of P1-1's loop.
 *
 * THE PROOF IS THE LEDGER'S, NOT THE PACK'S. `servedRangeReceipt` is the
 * canonical "is this window already held?" predicate — it is sha-scoped
 * (an entry for different bytes answers "no claim"), it clamps to real file
 * lines, and it requires the window to be SUBSUMED by a merged served span
 * rather than merely overlapping it. It is the same predicate `prior` /
 * `code_unchanged` / `served_by` are already granted on, so this pass states
 * on the CONTRACT side exactly what the wire is already telling the caller.
 *
 * FAILS CLOSED everywhere the proof is not exact: no sha (unreadable/oversized
 * file), no `total_lines` to clamp against, an unparseable range, a surface
 * already disclosed `content_completeness:"partial"`, or an artifact surface
 * (slide text is answer evidence, never editable code — the same line
 * `servedForGrant` draws). A surface it cannot prove keeps its codeless
 * status and its honest discovery gap.
 *
 * Byte-neutral: it writes only `code_unchanged`, never `code`, so no body is
 * added to or removed from the response.
 */
export function applyLedgerServedSurfaces(workspace: string, result: TaskPackResult): void {
  if (result.pack_unchanged === true) return;
  const identityByPath = new Map<string, { sha: string; totalLines: number } | undefined>();
  for (const surf of codeTaskPackSurfaces(result.surfaces)) {
    if (surf.code !== undefined || surf.code_unchanged !== undefined) continue;
    if (surf.content_completeness === "partial") continue;
    const span = parseSurfaceSpan(String(surf.range ?? ""));
    if (span === undefined) continue;
    if (!identityByPath.has(surf.path)) identityByPath.set(surf.path, surfaceFileIdentity(workspace, surf.path));
    const identity = identityByPath.get(surf.path);
    if (identity === undefined) continue;
    // A codeless surface rarely carries `total_lines` (nothing was measured for
    // it), so the clamp comes from the file itself — read once per path and
    // memoized, the same bounded read `surfaceFileSha` already performs.
    const totalLines = typeof surf.total_lines === "number" && surf.total_lines > 0
      ? surf.total_lines
      : identity.totalLines;
    if (servedRangeReceipt(workspace, surf.path, identity.sha, span.start, span.end, totalLines) === undefined) continue;
    surf.code_unchanged =
      `${surf.handle} — already served this session (${surf.path}:${surf.range}, sha ${shortSha(identity.sha)}); `
      + `resident in your context — re-read ${surf.handle} only if the body is needed`;
  }
}

/**
 * Mutates `result.surfaces` in place: any surface whose embedded `code`
 * fingerprints identically (same handle, same range, same content hash) to
 * an entry already seen — either from the immediately prior pack for this
 * workspace, or from an earlier surface already processed in THIS pack —
 * has its `code` replaced with a short `code_unchanged` pointer instead.
 * Runs BEFORE trimToCap so the bytes it frees are available to the trim
 * ladder like any other savings, and is a no-op for surfaces with no `code`
 * to begin with (undefined-code surfaces have nothing to dedupe).
 *
 * P1 fix: this ONLY reads (suppresses) — it does NOT persist the workspace
 * cache. Persistence is deferred to persistPackFingerprints(), run AFTER
 * trimToCap, so the cache records ONLY the code actually delivered in the
 * final response. Persisting here (pre-trim) recorded fingerprints for code
 * that trimToCap then stripped (Phase 5 drops `surf.code`; Phase 1 drops whole
 * surfaces), so the NEXT pack would emit `code_unchanged: "<handle> — see
 * prior pack"` pointing at code the prior pack never actually delivered.
 *
 * TL142-03 (2026-09-13): `taskBinding` narrows the `required===true` skip
 * below to the ONE case its own comment describes — a genuinely DIFFERENT
 * request reusing this handle while making the body action-bearing — instead
 * of every required surface, unconditionally, forever. An unchanged repeat of
 * the SAME task (proven by a matching `TaskPackArgs.taskBinding`, the
 * server-resolved identity behind qref/task.handle) dedupes a required
 * surface exactly like any other; when identity cannot be proven (either side
 * `undefined`, or a genuinely different task), the skip still fires and the
 * body is resent — fail toward resending, never toward a false "same task".
 */
export function applyPackDedupe(
  workspace: string,
  result: TaskPackResult,
  taskBinding?: string,
  exempt?: (surface: TaskPackSurface) => boolean,
): void {
  const cacheKey = laneScopedKey(workspace);
  const context = protocolCallContext();
  if (context?.sizePreview !== true) sourceCapsulePrior(cacheKey);
  const prior = lastPackBlocksByWorkspace.get(cacheKey) ?? [];
  const running: PackedBlockFingerprint[] = prior.map((f) => ({ ...f, fromPriorPack: true }));
  // 2026-10-29 (field report: measurementEngine.ts 337-401 shipped twice in one
  // response): the same lines of the same file reach a pack under different
  // handles (a locator symbol handle and a `kind:"range"` upsert) or rendered
  // with different comment elision, so the handle+hash match below misses
  // them. Within ONE pack, the second body for an identical path and range
  // adds nothing the first did not send.
  const servedSpanInPack = new Set<string>();

  for (const surf of result.surfaces) {
    if (surf.code === undefined) continue;
    if (exempt?.(surf) === true) continue;
    const hash = shaOfText(surf.code);
    const spanKey = `${surf.path}\0${surf.range}`;
    if (servedSpanInPack.has(spanKey)) {
      dedupedSurfaceBody.set(surf, surf.code);
      surf.code_unchanged = `${surf.handle} — duplicate of an earlier surface in this pack`;
      surf.code = undefined;
      continue;
    }
    const match = running.find((f) => f.handle === surf.handle && f.range === surf.range && f.hash === hash);
    if (match) {
      // A different request can reuse the same handle while making that body
      // action-bearing (artifact target, edit frontier, etc.). Exact request
      // re-calls are already intercepted by pack_unchanged; never replace a
      // newly required body with a pointer to unrelated prior-pack context —
      // UNLESS this fingerprint was recorded under the SAME proven task
      // identity, in which case it is not "a different request" at all.
      const provenSameTask = match.taskBinding !== undefined
        && taskBinding !== undefined
        && match.taskBinding === taskBinding;
      if (match.fromPriorPack && surf.required === true && !provenSameTask) {
        servedSpanInPack.add(spanKey);
        continue;
      }
      // W4: preserve the real body server-side (identity-keyed) so proof passes
      // stay deterministic across identical re-calls; the response still ships
      // only the compact pointer below.
      dedupedSurfaceBody.set(surf, surf.code);
      if (match.fromPriorPack && provenSameTask) priorBodyRestoration.capture(surf, `${surf.handle} — see prior pack`);
      surf.code_unchanged = match.fromPriorPack
        ? `${surf.handle} — see prior pack`
        : `${surf.handle} — duplicate of an earlier surface in this pack`;
      surf.code = undefined;
      continue;
    }
    running.push({ handle: surf.handle, range: surf.range, hash, fromPriorPack: false, taskBinding });
    servedSpanInPack.add(spanKey);
  }
}

/**
 * Late pre-booking exact-source reuse for required context. Kept separate from
 * the early body dedupe so proof passes inspect the original body first. The
 * caller runs the normal priorBodyRestoration strip after this pass.
 */
export function applyRequiredSourceCapsuleDedup(
  workspace: string,
  result: TaskPackResult,
  taskBinding?: string,
  options?: {forceServe?: boolean; exempt?: (surface: TaskPackSurface) => boolean},
): void {
  if (options?.forceServe === true || !taskBinding || taskBinding.length === 0 || result.pack_unchanged === true) return;
  const context = protocolCallContext();
  if (context?.sizePreview === true) return;
  const cacheKey = laneScopedKey(workspace);
  const prior = sourceCapsulePrior(cacheKey);
  let inspectedBytes = 0;
  for (const surf of codeTaskPackSurfaces(result.surfaces)) {
    if (surf.code === undefined || options?.exempt?.(surf) === true) continue;
    const bytes = Buffer.byteLength(surf.code, "utf8");
    if (inspectedBytes + bytes > MAX_PACK_SOURCE_CAPSULE_BYTES) break;
    inspectedBytes += bytes;
    const currentCapsule = sourceBodyCapsuleForSurface(workspace, surf, surf.code);
    if (currentCapsule === undefined) continue;
    const resident = prior.find((entry) =>
      entry.taskBinding === taskBinding && sourceCapsuleCovers(entry.capsule, currentCapsule));
    if (resident === undefined) continue;
    const pointer = `${resident.capsule.handle} — see prior pack`;
    dedupedSurfaceBody.set(surf, surf.code);
    priorBodyRestoration.capture(surf, pointer);
    surf.code_unchanged = pointer;
    surf.code = undefined;
  }
}

/**
 * TL_PACK_CONTAINMENT_DEDUP (2026-10-19, default ON; util/flags.ts
 * `packContainmentDedupEnabled`) — A ROW INSIDE ANOTHER ROW OF THE SAME FILE
 * SHIPS ONCE.
 *
 * `applyPackDedupe` above catches a row IDENTICAL to another (same handle,
 * range and content hash). Measured on the v0.16.0 decision runs 6t-2 and
 * 6t-3 (arm A): every T03 first pack shipped OrderOrchestrator.java:144-153,
 * 146-151, 145-150 and 147-152 — the constructor's signature and its three
 * facet parameter lines, appended by `buildAnswerTaskPack`'s member loop to
 * the class-head surface — while that same surface's body already served
 * 107-165: about 2.4 KB, 17% of the pack, of lines the caller got twice.
 *
 * One rule, two shapes: a row whose lines another row of the same file in
 * this pack already carries adds nothing. "Carries" is proved on the text,
 * never on a range alone (a surface's own `range`/`remaining_ranges` can
 * claim more than its body holds — T03's class head claims 45-1552 at this
 * point with a body that ends at 270): the row's text must be its file's own
 * lines at its range, occur nowhere else in that file, and be a substring of
 * the container's body, whose range must cover it with none of its
 * `remaining_ranges` crossing it.
 *   - An APPENDED WINDOW (`appended_windows`) its own surface's head body, or
 *     a wider kept window of the same surface, carries is cut from `code` with
 *     its marker. Internally it is no row (the wire split makes it one), so
 *     there is nothing for a pointer to sit on: it is dropped outright, the
 *     way a window a trim cut away does not ship. Its container is always the
 *     SAME surface, so that surface's `servedSurfaceText`, served spans and
 *     handle keep every line and every character they had: the proof passes
 *     and the certificate citations see what they saw before.
 *   - A separate SURFACE another code-bearing surface of the same path
 *     carries gets the `code_unchanged` pointer `applyPackDedupe` gives an
 *     identical row, the real body kept in `dedupedSurfaceBody`. Never one
 *     that is protected, `exempt`, required, edit-bearing (`likely_edits`/
 *     `edit_intent`/`done_check`), on the certified action frontier or a
 *     wiring frontier, caller-named (provenance, caller or explicit range),
 *     explicit-identifier evidence (`why` naming "explicit"), partial,
 *     carrying windows of its own, cited by the certificate this pack was
 *     built with in a way its withdrawal would break (`wouldIntroduceBreach`),
 *     or whose pointer would cost more than its body.
 *
 * Ties keep the first: of two rows with one range the later goes, and a row
 * is only ever cut into a container that stays, so no line goes unserved.
 * Runs once, right before `trimToCap`, so the bytes it frees go back to the
 * trim ladder. Exported for packContainmentDedup.spec.ts.
 */
export function applyPackContainmentDedup(
  result: TaskPackResult,
  workspace: string,
  options: {
    protectedSurfaces?: ReadonlySet<TaskPackSurface>;
    exempt?: (surface: TaskPackSurface) => boolean;
    cache?: FileReadCache;
  } = {},
): void {
  if (result.pack_unchanged === true) return;
  const surfaces = codeTaskPackSurfaces(result.surfaces);
  const sources = new Map<string, string | undefined>();
  /** `text` is `filePath`'s own whole lines from line `start`, and occurs nowhere else in the file. */
  const isUniqueSourceAt = (filePath: string, text: string, start: number): boolean => {
    if (!sources.has(filePath)) sources.set(filePath, readCached(workspace, filePath, options.cache)?.replace(/\r\n?/g, "\n"));
    const source = sources.get(filePath);
    const probe = text.endsWith("\n") ? text.slice(0, -1) : text;
    if (source === undefined || probe.trim() === "") return false;
    const at = source.indexOf(probe);
    if (at === -1 || source.indexOf(probe, at + 1) !== -1) return false;
    if (at > 0 && source[at - 1] !== "\n") return false;
    const after = at + probe.length;
    if (after < source.length && source[after] !== "\n") return false;
    let line = 1;
    for (let newline = source.indexOf("\n"); newline !== -1 && newline < at; newline = source.indexOf("\n", newline + 1)) line += 1;
    return line === start;
  };
  /** Verbatim source of `range` in `filePath`: exactly its lines, unique in the file. */
  const isVerbatimRow = (filePath: string, range: string, text: string): boolean => {
    const span = parsePackLineRange(range);
    return span !== undefined
      && countLines(text) === span[1] - span[0] + 1
      && isUniqueSourceAt(filePath, text, span[0]);
  };
  for (const surface of surfaces) {
    if (options.exempt?.(surface) === true) continue;
    dropContainedAppendedWindows(surface, isVerbatimRow);
  }

  const spanOf = (surface: TaskPackSurface): [number, number] | undefined => parsePackLineRange(surface.range);
  const position = new Map(surfaces.map((surface, index) => [surface, index] as const));
  /** `outer` may hold `inner`: a wider span, or the same span earlier in the pack. */
  const outranks = (outer: TaskPackSurface, inner: TaskPackSurface): boolean => {
    const a = spanOf(outer);
    const b = spanOf(inner);
    if (a === undefined || b === undefined || a[0] > b[0] || a[1] < b[1]) return false;
    return a[0] !== b[0] || a[1] !== b[1] || position.get(outer)! < position.get(inner)!;
  };
  const headOf = (surface: TaskPackSurface): string => {
    const code = surface.code ?? "";
    const first = surface.appended_windows?.[0];
    const at = first === undefined ? -1 : code.indexOf(first.marker);
    return at === -1 ? code : code.slice(0, at);
  };
  const certificate = result.execution_contract?.readiness_certificate;
  const frontierHandles = new Set<string>([
    ...(certificate?.action_frontier ?? []),
    ...(result.wiring?.edit_frontier ?? []),
    ...(result.wiring?.review_frontier ?? []),
    ...(result.wiring?.connections ?? []).flatMap((connection) => [
      connection.source?.handle,
      connection.destination?.handle,
      connection.insertion_handle,
      ...connection.supporting_handles,
    ].filter((handle): handle is string => typeof handle === "string")),
  ]);
  const namedOrExplicit = (surface: TaskPackSurface): boolean => {
    const why = surfaceProvenance(surface);
    return isCallerRangeSurface(surface)
      || isExplicitRangeSurface(surface)
      || (why !== undefined
        && (why.includes("caller-supplied")
          || why.includes("query-named-file")
          || why.includes("header-source-pair")
          || why.includes("explicit")));
  };
  const demotable = (surface: TaskPackSurface): boolean =>
    surface.code !== undefined
    && surface.code.trim() !== ""
    && options.protectedSurfaces?.has(surface) !== true
    && options.exempt?.(surface) !== true
    && surface.required !== true
    && surface.likely_edits === undefined
    && surface.edit_intent === undefined
    && surface.done_check === undefined
    && !frontierHandles.has(surface.handle)
    && surface.content_completeness !== "partial"
    && (surface.remaining_ranges?.length ?? 0) === 0
    && (surface.appended_windows?.length ?? 0) === 0
    && !namedOrExplicit(surface);
  // Widest spans first (ties in pack order), so every container a surface
  // could be cut into has already settled whether it stays.
  const order = surfaces
    .filter((surface) => spanOf(surface) !== undefined)
    .sort((a, b) => {
      const [as, ae] = spanOf(a)!;
      const [bs, be] = spanOf(b)!;
      return (be - bs) - (ae - as) || position.get(a)! - position.get(b)!;
    });
  let certification: AnswerCertificationSnapshot | undefined;
  for (const surface of order) {
    if (!demotable(surface)) continue;
    const body = surface.code!;
    const container = order.find((candidate) =>
      candidate !== surface
      && candidate.path === surface.path
      && candidate.code !== undefined
      && outranks(candidate, surface)
      && surfaceBodyCoversRange(candidate, surface.range)
      && headOf(candidate).includes(body));
    if (container === undefined) continue;
    const pointer = `${surface.handle} — lines ${surface.range} are inside ${container.handle} (${container.range}) in this pack`;
    if (Buffer.byteLength(pointer, "utf8") >= Buffer.byteLength(body, "utf8")) continue;
    if (!isVerbatimRow(surface.path, surface.range, body)) continue;
    certification ??= answerCertificationSnapshot(result);
    if (certification.keep?.(surface, codeTaskPackSurfaces(result.surfaces)) === true) continue;
    dedupedSurfaceBody.set(surface, body);
    surface.code_unchanged = pointer;
    surface.code = undefined;
  }
}

/**
 * `applyPackContainmentDedup`'s window half: cut every appended window of
 * `surface` whose verbatim text (`isVerbatimRow`) the surface's own head body
 * carries within its served range, or a wider kept window of it carries.
 * Leaves the surface exactly as built when a recorded marker is not where it
 * was recorded.
 */
export function dropContainedAppendedWindows(
  surface: TaskPackSurface,
  isVerbatimRow: (filePath: string, range: string, text: string) => boolean,
): void {
  const code = surface.code;
  const recorded = surface.appended_windows;
  if (code === undefined || recorded === undefined || recorded.length === 0) return;
  const found: Array<{ entry: { marker: string; range: string }; at: number; span: [number, number] }> = [];
  let from = 0;
  for (const entry of recorded) {
    const at = code.indexOf(entry.marker, from);
    const span = parsePackLineRange(entry.range);
    if (at === -1 || span === undefined) return;
    found.push({ entry, at, span });
    from = at + entry.marker.length;
  }
  const segments = found.map((window, index) => code.slice(window.at, found[index + 1]?.at ?? code.length));
  const texts = found.map((window, index) => segments[index]!.slice(window.entry.marker.length));
  const head = code.slice(0, found[0]!.at);
  const verbatim = found.map((window, index) => isVerbatimRow(surface.path, window.entry.range, texts[index]!));
  const inHead = found.map((window, index) =>
    verbatim[index]! && surfaceBodyCoversRange(surface, window.entry.range) && head.includes(texts[index]!));
  const holds = (outer: number, inner: number): boolean => {
    const [os, oe] = found[outer]!.span;
    const [is, ie] = found[inner]!.span;
    if (os > is || oe < ie) return false;
    return (os !== is || oe !== ie || outer < inner) && texts[outer]!.includes(texts[inner]!);
  };
  const dropped = found.map((_, index) =>
    inHead[index]! || (verbatim[index]! && found.some((__, other) => other !== index && !inHead[other]! && holds(other, index))));
  if (!dropped.some(Boolean)) return;
  surface.code = head + segments.filter((_, index) => !dropped[index]).join("");
  const kept = recorded.filter((_, index) => !dropped[index]);
  if (kept.length > 0) surface.appended_windows = kept;
  else delete surface.appended_windows;
}

/**
 * P1 fix: persist the FINAL response's code-bearing surfaces as this
 * workspace's "last pack" fingerprints — the cache is what the
 * immediately-next pack dedupes against, so it must describe exactly what
 * THIS pack actually delivered.
 *
 * Runs AFTER trimToCap. Records surfaces that still carry embedded `code`
 * in the final result: a surface whose code trimToCap stripped (Phase 5), or
 * a surface trimToCap dropped entirely (Phase 1), delivered no code, so it
 * must not seed a `code_unchanged` pointer on the next pack — such a surface
 * is simply absent from `result.surfaces` with a `code` value, so the loop
 * below never records it.
 *
 * TL142-03 (2026-09-13): MERGE, don't replace. The pre-fix version rebuilt
 * the cache from scratch every call, recording ONLY surfaces that shipped
 * FRESH code THIS pack — so a surface applyPackDedupe (or the residency
 * passes) successfully demoted to `code_unchanged` THIS call dropped OUT of
 * the cache going into the NEXT call, even though nothing about it changed.
 * For a non-required surface that is a stable period-2 oscillation (dedupes,
 * forgets, re-sends in full, re-populates, dedupes again — forever); for a
 * required one it compounded with the `applyPackDedupe` guard to make the
 * body unconditionally fresh every call. The fix: a surface demoted to
 * `code_unchanged` THIS call is STILL VALID (its content provably did not
 * change — that is what "demoted" means), so its fingerprint is carried
 * forward exactly like a freshly-delivered one. The real body a demotion
 * needs to re-hash is recovered from the `dedupedSurfaceBody` side channel
 * (set by both applyPackDedupe and applyResidentFileDedup on every match) —
 * a surface demoted by applyLedgerServedSurfaces never had `code` to begin
 * with (it only processes codeless surfaces), so there is nothing to carry
 * for it here; that mechanism re-derives residency from the session ledger on
 * every call regardless of this cache.
 */
export function persistPackFingerprints(workspace: string, result: TaskPackResult, taskBinding?: string): void {
  const fingerprints: PackedBlockFingerprint[] = [];
  const stagedCapsules: {capsule: SourceBodyCapsule; taskBinding?: string; body: string; range: string}[] = [];
  let capsuleBytes = 0;
  for (const surf of result.surfaces) {
    if (surf.code !== undefined) {
      const bodyBytes = Buffer.byteLength(surf.code, "utf8");
      const sourceCapsule = capsuleBytes + bodyBytes <= MAX_PACK_SOURCE_CAPSULE_BYTES
        ? sourceBodyCapsuleForSurface(workspace, surf, surf.code) : undefined;
      if (sourceCapsule !== undefined) capsuleBytes += bodyBytes;
      if (sourceCapsule !== undefined) {
        stagedCapsules.push({capsule: sourceCapsule, taskBinding, body: surf.code, range: surf.range});
      }
      fingerprints.push({
        handle: surf.handle,
        range: surf.range,
        hash: shaOfText(surf.code),
        fromPriorPack: true,
        taskBinding,
      });
      continue;
    }
    if (surf.code_unchanged === undefined) continue;
    const unchangedBody = dedupedSurfaceBody.get(surf);
    if (unchangedBody === undefined) continue; // codeless-origin demotion — nothing to carry
    fingerprints.push({
      handle: surf.handle,
      range: surf.range,
      hash: shaOfText(unchangedBody),
      fromPriorPack: true,
      taskBinding,
    });
  }
  lastPackBlocksByWorkspace.set(laneScopedKey(workspace), fingerprints);
  const context = protocolCallContext();
  if (context?.sizePreview !== true) stageSourceCapsules(laneScopedKey(workspace), stagedCapsules);
  if (context && context.sizePreview !== true) {
    packFingerprintBinding.capture(result, laneScopedKey(workspace), context, fingerprints, result.surfaces);
  }
}
