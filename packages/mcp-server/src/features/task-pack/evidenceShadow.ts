/**
 * evidenceShadow.ts — P1 evidence completion (DESIGN-v0.10 D7), SHADOW MODE.
 *
 * Computes everything the active feature would compute and CHANGES NOTHING on
 * the wire. The result goes to the trace channel (util/trace.ts) as one
 * `evidence_shadow` record per pack, which bench joins back to the archived
 * cell transcript via `workspace` + `qref`.
 *
 * Why the trace channel and not a response field: a response field is the one
 * thing shadow mode may not do — it would contaminate the byte/turn metrics the
 * experiment exists to measure. trace.ts is already shipping, already
 * env-gated, already swallows its own errors, and already names its file
 * `<pid>-<sha8(workspaceRoot)>.jsonl`, which is what keeps bench cells apart
 * given that ONE server process serves them all (established 2026-07-31: every
 * cell's tool results carry an identical server_build stamp).
 *
 * D7 rollout order is shadow -> paired ablation -> defaults. The active arm
 * remains default-OFF and serves concerns[].evidence[] only when its dedicated
 * flag is enabled; shadow-only operation preserves normalized response equivalence.
 */

import type {
  ConcernCoverage,
  ConcernEvidenceConflict,
  ConcernEvidenceSurface,
  TaskChangeContract,
  TaskExecutionContract,
  TaskWiringProfile,
} from "@tokenlighten/types";

import {
  evidenceCompletionEnabled,
  evidenceCompletionShadowEnabled,
} from "../../util/flags.js";
import { HANDLE_ID_LENGTH, handleTable } from "../../util/handles.js";
import { isTraceEnabled, trace } from "../../util/trace.js";
import { detectConflicts } from "./evidenceConflict.js";
import {
  resolveEvidence,
  type ConcernAnchors,
  type EvidenceSlice,
} from "./evidenceResolution.js";

/** The pack fields this module reads. Structural subset of TaskPackResult. */
interface ShadowPackView {
  coverage?: string;
  qref?: string;
  concerns?: ConcernCoverage[];
  surfaces: Array<{
    handle: string;
    path: string;
    range?: string;
    symbol?: string;
    code?: string;
    role?: string;
  }>;
  execution_contract?: Partial<TaskExecutionContract> & {
    phase?: string;
    typestate?: TaskExecutionContract["typestate"];
  };
  task_profile?: string;
  profile_binding?: { selected?: string };
}

/** Identifiers a body CALLS: `name(` minus the surface's own symbol. */
const CALL_RE = /\b([A-Za-z_][A-Za-z0-9_]{2,})\s*\(/g;
const CALL_STOPWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "sizeof", "typeof",
  "function", "constructor", "super", "await", "throw", "new", "delete",
  "print", "assert", "expect", "require",
]);
const MAX_CALLEES_SCANNED = 8;

function calleesOf(code: string, own: readonly string[]): string[] {
  const out: string[] = [];
  const ownLower = new Set(own.map((s) => s.toLowerCase()));
  CALL_RE.lastIndex = 0;
  for (let m = CALL_RE.exec(code); m !== null; m = CALL_RE.exec(code)) {
    const name = m[1]!;
    if (CALL_STOPWORDS.has(name.toLowerCase())) continue;
    if (ownLower.has(name.toLowerCase())) continue;
    if (!out.includes(name)) out.push(name);
    if (out.length >= MAX_CALLEES_SCANNED) break;
  }
  return out;
}

/** `src/a/mixer.ts` -> ["mixer.ts", "mixer"]. */
function basenameStems(p: string): string[] {
  const base = p.split("/").pop() ?? p;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return stem === base ? [base] : [base, stem];
}

/**
 * Per-concern anchors, built from what the pack ALREADY knows: the concern's
 * own handles, the surfaces those handles name, and the caller's query tokens.
 * Nothing here consults a domain list (D7's automatic-reject rule).
 */
export function buildConcernAnchors(
  pack: ShadowPackView,
  tokensByConcern: ReadonlyMap<string, string[]>,
): ConcernAnchors[] {
  const byHandle = new Map(pack.surfaces.map((s) => [s.handle, s]));
  const out: ConcernAnchors[] = [];
  for (const concern of pack.concerns ?? []) {
    const surfaces = concern.handles
      .map((h) => byHandle.get(h))
      .filter((s): s is ShadowPackView["surfaces"][number] => s !== undefined);
    const symbols: string[] = [];
    const surfacePaths: string[] = [];
    const callees: string[] = [];
    for (const surface of surfaces) {
      if (!surfacePaths.includes(surface.path)) surfacePaths.push(surface.path);
      if (surface.symbol !== undefined && !symbols.includes(surface.symbol)) {
        symbols.push(surface.symbol);
      }
      // Both the basename and its extension-less stem: a doc heading may name
      // either ("## 7.6 mixer.ts" vs "## 8 Limiter"), and the resolver scores
      // the two differently on purpose (see resolveNormativeProse).
      for (const stem of basenameStems(surface.path)) {
        if (!symbols.includes(stem)) symbols.push(stem);
      }
      for (const callee of calleesOf(surface.code ?? "", symbols)) {
        if (!callees.includes(callee)) callees.push(callee);
      }
    }
    out.push({
      id: concern.id,
      tokens: tokensByConcern.get(concern.id) ?? [],
      symbols,
      callees,
      surfacePaths,
    });
  }
  return out;
}

/** Spans the pack itself just served, as a cheap stand-in for the D4 ledger. */
function packServedSpanLookup(pack: ShadowPackView): (relPath: string) => Array<[number, number]> {
  const byPath = new Map<string, Array<[number, number]>>();
  for (const surface of pack.surfaces) {
    if (surface.code === undefined || surface.range === undefined) continue;
    const m = /^(\d+)-(\d+)$/.exec(surface.range);
    if (m === null) continue;
    const list = byPath.get(surface.path) ?? [];
    list.push([Number(m[1]), Number(m[2])]);
    byPath.set(surface.path, list);
  }
  return (relPath) => byPath.get(relPath) ?? [];
}

/** Provenance minus the body — the log never carries evidence text. */
function loggableSlice(slice: EvidenceSlice): Record<string, unknown> {
  const { text: _text, ...rest } = slice;
  return rest;
}

/** Content-bearing, handle-addressable evidence nested under one concern. */
type ActiveEvidence = ConcernEvidenceSurface;

/**
 * Stand-in occupying an evidence item's `handle` slot while the byte cap is
 * being checked, replaced by a real minted id once the item is admitted.
 *
 * B2 (2026-08-04 review): it must be EXACTLY as long as a minted id, because
 * the cap decision is made while it is still in place. The original stand-in
 * was 130 chars against an 11-char id, so every item was charged 119 B it never
 * ships — evidence that fits under packCapBytes was dropped, and the P1
 * ablation would have measured a weaker treatment than the design specifies.
 * Deliberately NOT handle-shaped (`^h[0-9a-z]+$`), so a leak into a response
 * is visibly not a handle rather than a plausible dead one.
 */
export const PENDING_HANDLE_PLACEHOLDER = "p1-pending!".padEnd(HANDLE_ID_LENGTH, "!")
  .slice(0, HANDLE_ID_LENGTH);

function parseLineRange(range: string): [number, number] | undefined {
  const match = /^(\d+)-(\d+)$/.exec(range);
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  return start > 0 && end >= start ? [start, end] : undefined;
}

function servedEvidenceHandle(pack: ShadowPackView, slice: EvidenceSlice): string | undefined {
  const evidenceRange = parseLineRange(slice.range);
  if (!evidenceRange) return undefined;
  for (const surface of pack.surfaces) {
    if (surface.path !== slice.path || surface.code === undefined || !surface.range) continue;
    const servedRange = parseLineRange(surface.range);
    if (
      servedRange &&
      servedRange[0] <= evidenceRange[0] &&
      servedRange[1] >= evidenceRange[1]
    ) {
      return surface.handle;
    }
  }
  return undefined;
}

function attachResolvedEvidence(args: {
  workspace: string;
  pack: ShadowPackView;
  resolution: ReturnType<typeof resolveEvidence>;
  packCapBytes: number;
}): void {
  const { workspace, pack, resolution, packCapBytes } = args;
  type ActiveConcern = ConcernCoverage;
  type MutablePack = ShadowPackView & {
    route?: {
      action:
        | "edit_from_handles"
        | "locate_missing_surfaces"
        | "fallback_native"
        | "confirm_candidates"
        | "inspect_handles"
        | "answer_from_handles";
      reason: string;
      max_additional_tl_calls: number;
    };
    next?: string;
    continuation?: unknown;
    change_contract?: TaskChangeContract;
    wiring?: TaskWiringProfile;
    checks?: string[];
    verify?: string[];
  };
  const mutablePack = pack as MutablePack;
  const pending: Array<{ evidence: ActiveEvidence }> = [];
  const seenBodies = new Set<string>();
  const conflicting: Array<{
    target: ActiveConcern;
    originalStatus: ConcernCoverage["status"];
  }> = [];

  for (const resolved of resolution.concerns) {
    const concern = pack.concerns?.find((candidate) => candidate.id === resolved.id);
    if (!concern) continue;
    const target = concern as ActiveConcern;
    const admitted: EvidenceSlice[] = [];

    for (const slice of resolved.resolved.filter((candidate) => candidate.selected)) {
      const bodyKey = `${slice.path}:\0${slice.range}`;
      if (seenBodies.has(bodyKey)) continue;
      const priorHandle = servedEvidenceHandle(pack, slice);
      const evidence = {
        class: slice.class,
        ...(slice.subclass ? { subclass: slice.subclass } : {}),
        handle: PENDING_HANDLE_PLACEHOLDER,
        path: slice.path,
        range: slice.range,
        why: slice.why,
        matched: slice.matched,
        ...(priorHandle
          ? {
              code_unchanged:
                `${priorHandle} — duplicate of an earlier surface in this pack`,
            }
          : { code: slice.text }),
      } satisfies ActiveEvidence;

      const list = (target.evidence ??= []);
      list.push(evidence);
      if (Buffer.byteLength(JSON.stringify(pack), "utf8") > packCapBytes) {
        list.pop();
        if (list.length === 0) delete target.evidence;
        continue;
      }
      seenBodies.add(bodyKey);
      admitted.push(slice);
      pending.push({ evidence });
    }

    const conflicts: ConcernEvidenceConflict[] = detectConflicts(resolved.id, admitted)
      .map((conflict) => ({
        ...conflict,
        verdict: "hold-prepared" as const,
      }));
    if (conflicts.length > 0) {
      conflicting.push({ target, originalStatus: target.status });
      target.conflicts = conflicts;
      target.status = "needs-followup";
    }
  }

  const heldContract = structuredClone(pack.execution_contract);
  const heldRoute = structuredClone(mutablePack.route);
  const hadNext = Object.hasOwn(mutablePack, "next");
  const heldNext = mutablePack.next;
  const hadContinuation = Object.hasOwn(mutablePack, "continuation");
  const heldContinuation = structuredClone(mutablePack.continuation);
  const hadChangeContract = Object.hasOwn(mutablePack, "change_contract");
  const heldChangeContract = structuredClone(mutablePack.change_contract);
  const hadWiring = Object.hasOwn(mutablePack, "wiring");
  const heldWiring = structuredClone(mutablePack.wiring);
  const hadChecks = Object.hasOwn(mutablePack, "checks");
  const heldChecks = structuredClone(mutablePack.checks);
  const hadVerify = Object.hasOwn(mutablePack, "verify");
  const heldVerify = structuredClone(mutablePack.verify);

  if (conflicting.length > 0) {
    const reason =
      "cross-class evidence conflicts were served; resolve them before editing";
    const contract = pack.execution_contract;
    if (contract?.typestate !== undefined) {
      delete contract.phase;
      contract.state = "needs-followup";
      contract.readiness = "needs-followup";
      contract.discovery_complete = false;
      contract.next_action = "request-user-input";
      contract.max_additional_discovery_calls = 0;
      contract.reason = reason;
      // protocol v1, A.7.2 branch 5 / A.9.2 row 21: this is the awaiting-input
      // transition that lives outside readCodeTaskPack's guard, and it produces
      // the same wire state, so it carries its own code.
      contract.await_input_code = "resolve-evidence-conflict";
      contract.typestate = {
        ...contract.typestate,
        phase: "awaiting-input",
        allowed_actions: ["request-user-input"],
        challenge_required_for: [],
      };
      delete contract.readiness_certificate;
      delete contract.falsification;
      delete contract.readiness_risk;
      delete contract.call_budget;
      delete contract.next_call;
      delete contract.evidence_model;
      delete contract.semantic_closure;
      delete contract.capability_gaps;
    } else {
      // Active attachment normally sees the canonical rich contract. Keep the
      // compact fallback honest if a caller supplies a pre-projected pack.
      pack.execution_contract = {
        phase: "awaiting-input",
        reason,
        await_input_code: "resolve-evidence-conflict",
        typestate: {
          phase: "awaiting-input",
          allowed_actions: ["request-user-input"],
          challenge_required_for: [],
        },
      };
    }
    mutablePack.route = {
      action: "inspect_handles",
      reason,
      max_additional_tl_calls: 0,
    };
    delete mutablePack.next;
    delete mutablePack.continuation;
    delete mutablePack.checks;
    delete mutablePack.verify;
    if (mutablePack.change_contract !== undefined) {
      mutablePack.change_contract.status = "needs-followup";
      mutablePack.change_contract.discovery_complete = false;
      mutablePack.change_contract.max_additional_tl_calls = 0;
      mutablePack.change_contract.stages = [];
      mutablePack.change_contract.missing = [...new Set([
        ...mutablePack.change_contract.missing,
        ...conflicting.map(({ target }) => `evidence-conflict:${target.id}`),
      ])];
    }
    if (mutablePack.wiring !== undefined) {
      mutablePack.wiring.status = "needs-followup";
      mutablePack.wiring.edit_frontier = [];
      mutablePack.wiring.note = reason;
      for (const connection of mutablePack.wiring.connections) {
        connection.status = "needs-followup";
        delete connection.required_action;
      }
    }

    if (Buffer.byteLength(JSON.stringify(pack), "utf8") > packCapBytes) {
      const removed = new Set<ActiveEvidence>();
      for (const { target, originalStatus } of conflicting) {
        for (const evidence of target.evidence ?? []) removed.add(evidence);
        delete target.evidence;
        delete target.conflicts;
        target.status = originalStatus;
      }
      for (let index = pending.length - 1; index >= 0; index--) {
        if (removed.has(pending[index]!.evidence)) pending.splice(index, 1);
      }
      pack.execution_contract = heldContract;
      if (heldRoute === undefined) delete mutablePack.route;
      else mutablePack.route = heldRoute;
      if (hadNext) mutablePack.next = heldNext;
      else delete mutablePack.next;
      if (hadContinuation) mutablePack.continuation = heldContinuation;
      else delete mutablePack.continuation;
      if (hadChangeContract) mutablePack.change_contract = heldChangeContract;
      else delete mutablePack.change_contract;
      if (hadWiring) mutablePack.wiring = heldWiring;
      else delete mutablePack.wiring;
      if (hadChecks) mutablePack.checks = heldChecks;
      else delete mutablePack.checks;
      if (hadVerify) mutablePack.verify = heldVerify;
      else delete mutablePack.verify;
    }
  }

  for (const { evidence } of pending) {
    evidence.handle = handleTable.upsert({
      kind: "range",
      workspaceRoot: workspace,
      path: evidence.path,
      range: evidence.range,
    }).id;
  }
}

/**
 * Test-only seam for B1's degradation proof: forces the enrichment body to
 * throw so the swallow-and-degrade boundary below can be exercised end to end.
 * Production callers never set it; `undefined` restores normal operation.
 */
let activeFailureForTest: (() => never) | undefined;

export function setEvidenceCompletionFailureForTest(fail: (() => never) | undefined): void {
  activeFailureForTest = fail;
}

/**
 * Restore a pack to a previously captured snapshot IN PLACE.
 *
 * The caller holds the pack by reference and keeps using it after we return,
 * so a failed enrichment cannot simply be dropped — the object itself must be
 * put back. Rebuilding the key set (rather than assigning over it) also removes
 * keys the partial enrichment ADDED, which is the difference between degrading
 * and shipping a half-mutated contract.
 */
function restorePackInPlace(
  pack: Record<string, unknown>,
  snapshot: Record<string, unknown>,
): void {
  for (const key of Object.keys(pack)) delete pack[key];
  Object.assign(pack, snapshot);
}

export function attachEvidenceCompletion(args: {
  workspace: string;
  pack: ShadowPackView;
  tokensByConcern: ReadonlyMap<string, string[]>;
  packCapBytes: number;
}): void {
  const profile =
    args.pack.profile_binding?.selected ?? args.pack.task_profile ?? "unknown";
  const phase =
    args.pack.execution_contract?.phase ??
    args.pack.execution_contract?.typestate?.phase ??
    "unknown";
  const eligibleFixProfile =
    profile === "generic" ||
    profile === "change_propagation" ||
    profile === "multi_concern" ||
    profile === "wiring";
  if (
    !evidenceCompletionEnabled() ||
    !eligibleFixProfile ||
    phase !== "prepared" ||
    (args.pack.concerns ?? []).length === 0
  ) {
    return;
  }
  // B1 (2026-08-04 review): the same swallow-and-degrade boundary the shadow
  // half has ("a shadow must never be able to fail the call it is shadowing").
  // Enrichment is an OPTIONAL improvement to a pack the base arm would have
  // served fine, so no failure inside it may reach the caller as a failed
  // read_file. During the paired ablation only the TREATMENT arm runs this
  // code, so an escaping error is a lost cell AND a directional bias.
  //
  // Degradation has to be total, not partial: attachResolvedEvidence mutates
  // the pack incrementally (evidence lists, concern status, contract, route,
  // wiring) and mints handles only at the very end, so a mid-flight throw would
  // otherwise ship placeholder handles or an orphaned awaiting-input contract.
  // Snapshot first; if the pack cannot even be snapshotted, decline to enrich
  // rather than enter a state we could not undo.
  let snapshot: ShadowPackView;
  try {
    snapshot = structuredClone(args.pack);
  } catch {
    return;
  }
  try {
    activeFailureForTest?.();
    const anchors = buildConcernAnchors(args.pack, args.tokensByConcern);
    const resolution = resolveEvidence({
      workspace: args.workspace,
      concerns: anchors,
      servedSpans: packServedSpanLookup(args.pack),
    });
    attachResolvedEvidence({
      workspace: args.workspace,
      pack: args.pack,
      resolution,
      packCapBytes: args.packCapBytes,
    });
  } catch (error) {
    restorePackInPlace(
      args.pack as unknown as Record<string, unknown>,
      snapshot as unknown as Record<string, unknown>,
    );
    // Silent degradation would make the ablation unfalsifiable — a treatment
    // arm that quietly stopped treating would read as "P1 has no effect".
    // No-ops unless a trace channel is already open.
    trace("evidence_completion_degraded", {
      workspace: args.workspace,
      profile,
      error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    }, args.workspace);
  }
}

export function emitEvidenceShadow(args: {
  workspace: string;
  pack: ShadowPackView;
  /** Exact server-derived qref that the enclosing tool result will carry. */
  qref?: string;
  /** Concern id -> the significant tokens of its own query clause. */
  tokensByConcern: ReadonlyMap<string, string[]>;
  /** Serialized size of the pack WITHOUT any evidence, for the R1 risk number. */
  surfaceBytes: number;
  /** MAX_TASK_PACK_BYTES, so the record can carry the activation headroom. */
  packCapBytes: number;
}): void {
  if (!evidenceCompletionShadowEnabled() || !isTraceEnabled()) return;
  try {
    const { workspace, pack } = args;
    if ((pack.concerns ?? []).length === 0) return;

    const anchors = buildConcernAnchors(pack, args.tokensByConcern);
    const resolution = resolveEvidence({
      workspace,
      concerns: anchors,
      servedSpans: packServedSpanLookup(pack),
    });

    const concerns = resolution.concerns.map((concern) => ({
      id: concern.id,
      anchor_tokens: concern.anchor_tokens,
      anchor_symbols: concern.anchor_symbols,
      anchor_callees: concern.anchor_callees,
      resolved: concern.resolved.map(loggableSlice),
      class_counts: concern.class_counts,
      class_skipped: concern.class_skipped,
      conflicts: detectConflicts(concern.id, concern.resolved).map((conflict) => ({
        ...conflict,
        // Shadow mode observes; it does not hold. Record what the ACTIVE arm
        // would have done so the verdict is measurable before it is enforced.
        verdict: "would-hold-prepared" as const,
      })),
    }));

    trace("evidence_shadow", {
      workspace,
      pack: {
        ...(args.qref !== undefined
          ? { qref: args.qref }
          : pack.qref !== undefined
            ? { qref: pack.qref }
            : {}),
        profile: pack.profile_binding?.selected ?? pack.task_profile ?? "unknown",
        coverage: pack.coverage ?? "unknown",
        phase: pack.execution_contract?.phase
          ?? pack.execution_contract?.typestate?.phase
          ?? "unknown",
        surface_bytes: args.surfaceBytes,
        concern_count: (pack.concerns ?? []).length,
      },
      concerns,
      would_serve: {
        slice_count: resolution.wouldServe.slice_count,
        bytes: resolution.wouldServe.bytes,
        trimmed_count: resolution.wouldServe.trimmed_count,
        // R1: the activation risk number, recorded on EVERY record so the flip
        // decision rests on a measured distribution rather than an estimate.
        pack_bytes_after: args.surfaceBytes + resolution.wouldServe.bytes,
        pack_cap_bytes: args.packCapBytes,
      },
      cost: resolution.cost,
    }, workspace);
  } catch {
    // A shadow must never be able to fail the call it is shadowing.
  }
}
