import type {
  TaskCapabilityGap,
  TaskExecutionContract,
  TaskSemanticClosure,
} from "@tokenlighten/types";

/**
 * Compact closure receipt. The canonical agent guide keys off `state` alone
 * ("`semantic_closure.state=closed` stops"), so the wire carries the state and
 * nothing else — the full receipt's version/closure_id/tallies are server-side
 * provenance the agent never acts on.
 */
export interface LeanSemanticClosure {
  state: TaskSemanticClosure["state"];
}

/**
 * Compact residual gap. The guide's rule is "Open=>`capability_gaps[].next_call`",
 * so every emitted gap MUST carry the one call that closes it; a gap with no
 * executable call is dropped rather than shipped as unactionable prose.
 */
export interface LeanCapabilityGap {
  kind: TaskCapabilityGap["kind"];
  reason: string;
  next_call: NonNullable<TaskCapabilityGap["next_call"]>;
}

/**
 * Decision-relevant signals shared by every lean phase projection. Emitted
 * only when the full contract carries them (never synthesized), so the wire
 * gains a stop/continue signal without paying for it on responses that have
 * nothing to say.
 */
export interface LeanDecisionSignals {
  semantic_closure?: LeanSemanticClosure;
  capability_gaps?: LeanCapabilityGap[];
}

export type LeanExecutionContract =
  | ({
      phase: "discovery";
      unresolved: string[];
      allowed: string[];
      next_call?: TaskExecutionContract["next_call"];
    } & LeanDecisionSignals)
  | ({
      phase: "prepared";
      certificate: string;
      obligations: string[];
      allowed: string[];
      frontier: string[];
    } & LeanDecisionSignals)
  | ({
      phase: "awaiting-input";
      reason: string;
      unresolved: string[];
      allowed: string[];
    } & LeanDecisionSignals)
  | ({
      /**
       * Terminal / runtime-only phases. `done` is produced by the canonical
       * decision normalizer's terminal-closed branch and can be restored from
       * a captured pack on a later cache/qref hit, so it MUST project rather
       * than throw (the pre-P0a `unsupported task-pack execution phase` throw
       * was reachable from that path and surfaced as an RPC internal error).
       */
      phase: "done" | "acting" | "verifying" | "revoked";
      unresolved: string[];
      allowed: string[];
    } & LeanDecisionSignals);

/** At most this many gaps ride the wire; the rest are same-kind repetitions. */
const MAX_LEAN_CAPABILITY_GAPS = 2;

/** Gap reasons are guidance, not proof — cap them like every other wire prose field. */
const MAX_LEAN_GAP_REASON_CHARS = 120;

function capReason(reason: string): string {
  if (reason.length <= MAX_LEAN_GAP_REASON_CHARS) return reason;
  const cut = reason.slice(0, MAX_LEAN_GAP_REASON_CHARS);
  const wordSafe = cut.replace(/\s+\S*$/u, "");
  return wordSafe.length > 0 ? wordSafe : cut;
}

/**
 * Project the decision-relevant closure signals the canonical guide instructs
 * agents to act on. A gap inherits the contract's own `next_call` when it has
 * none of its own, so "open" is never reported without a way to close it.
 */
function projectDecisionSignals(contract: TaskExecutionContract): LeanDecisionSignals {
  const signals: LeanDecisionSignals = {};
  const closure = contract.semantic_closure;
  if (closure !== undefined) {
    signals.semantic_closure = { state: closure.state };
  }
  const gaps = contract.capability_gaps ?? [];
  if (gaps.length === 0) return signals;
  const fallbackCall = contract.next_call;
  const projected: LeanCapabilityGap[] = [];
  for (const gap of gaps) {
    if (projected.length >= MAX_LEAN_CAPABILITY_GAPS) break;
    const call = gap.next_call ?? fallbackCall;
    if (call === undefined) continue;
    projected.push({ kind: gap.kind, reason: capReason(gap.reason), next_call: call });
  }
  if (projected.length > 0) signals.capability_gaps = projected;
  return signals;
}

/**
 * Project the rich internal proof into the action-relevant v0.10 wire shape.
 * The caller records/enforces the full contract before replacing the response
 * field with this projection.
 */
export function projectLeanExecutionContract(contract: TaskExecutionContract): LeanExecutionContract {
  const phase = contract.typestate.phase;
  const unresolved = contract.falsification?.unresolved
    ?? contract.readiness_certificate?.falsification?.unresolved
    ?? [];
  const allowed = [...contract.typestate.allowed_actions];
  const signals = projectDecisionSignals(contract);

  if (phase === "prepared") {
    const certificate = contract.readiness_certificate?.id ?? contract.typestate.certificate_id;
    if (!certificate) throw new Error("prepared execution contract is missing a certificate id");
    return {
      phase,
      certificate,
      obligations: [...(contract.readiness_certificate?.obligations.map((item) => item.id) ?? [])],
      allowed,
      frontier: [...(contract.readiness_certificate?.action_frontier ?? [])],
      ...signals,
    };
  }

  if (phase === "awaiting-input") {
    return {
      phase,
      reason: contract.reason,
      unresolved,
      allowed,
      ...signals,
    };
  }

  if (phase !== "discovery") {
    return { phase, unresolved, allowed, ...signals };
  }
  const nextCall = contract.next_call;
  if (nextCall !== undefined && nextCall.tool !== "read_file" && nextCall.tool !== "search_files") {
    throw new Error(`discovery execution contract has a non-read-only next_call: ${nextCall.tool}`);
  }
  return {
    phase,
    unresolved,
    allowed,
    ...(nextCall ? { next_call: nextCall } : {}),
    ...signals,
  };
}
