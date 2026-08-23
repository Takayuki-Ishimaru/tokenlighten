// ---------------------------------------------------------------------------
// Task Reasoning IR v1 — pure advisory projection (v0.10.0 beta.1, V10-05).
//
// DESIGN-v0.10-expansion-plan-v1.3.md V10-05; reconciliation §4 beta.1.
//
// ADVISORY POSTURE (v0.10): nothing imports this from dispatch — the
// projection is exercised only by its spec, and the wire emission of a
// reasoning summary is DELIBERATELY DEFERRED (the reconciliation's beta.1
// note records that as the sanctioned deviation). The IR restates what the
// pack and its contracts already certify; it is never a second authority
// (see packages/types/src/domain/reasoning.ts's header).
//
// PURITY CONTRACT: the projection reads ONLY the pack result and options it
// is handed. No store, no session, no filesystem, no clock, no mutation of
// the input (the spec pins all of that). Determinism: same input → same
// stateHash; the volatile task-handle wire string is EXCLUDED from the hash
// (identity class "task"), so two mints of the same task hash identically.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import type {
  TaskReasoningIR,
  EvidenceIdentity,
  EvidenceUse,
  EvidenceRole,
} from "@tokenlighten/types";
import type { TaskPackResult } from "../features/task-pack/model.js";
import { deriveCanonicalTaskDecision } from "../features/task-pack/canonicalDecision.js";

/** Hard caps (plan V10-05: summary/state size must stay bounded). */
export const IR_GOAL_MAX_CHARS = 480;
export const IR_OBLIGATIONS_MAX = 32;
export const IR_ALLOWED_NEXT_MAX = 6;
export const IR_CONSTRAINTS_MAX = 8;

export interface ProjectReasoningIrInput {
  /** A completed buildTaskPack result (any coverage/decision shape). */
  result: TaskPackResult;
  /**
   * The wire task identity (task.id / tlh_task handle) when the caller has
   * one. Volatile by construction (per-mint nonce), so it is carried on the
   * IR verbatim but contributes to stateHash only as its identity class.
   */
  taskId?: string;
  /** The task query text, if the caller still holds it (goal source). */
  query?: string;
}

/** ImpactSurface (wire) → EvidenceRole (domain) — conservative mapping. */
function roleOf(surfaceRole: string | undefined): EvidenceRole {
  switch (surfaceRole) {
    case "definition": return "definition";
    case "consumer": return "consumer";
    case "test": return "test";
    case "config": return "config";
    case "build": return "build";
    case "doc": return "doc";
    default: return "target";
  }
}

function parseRange(range: string | undefined): { startLine: number; endLine: number } | undefined {
  if (!range) return undefined;
  const m = /^(\d+)-(\d+)$/.exec(range);
  if (!m) return undefined;
  return { startLine: Number(m[1]), endLine: Number(m[2]) };
}

/**
 * Stable stringify: sorted object keys at every depth, arrays in place.
 * Small and local — the IR subset is plain JSON data by construction.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Projects a completed task pack onto the advisory Task Reasoning IR.
 * Pure: no I/O, no clock, no input mutation.
 */
export function projectTaskReasoningIR(input: ProjectReasoningIrInput): TaskReasoningIR {
  const { result } = input;

  // --- evidence catalog: one identity per served surface, grounded only ---
  const evidenceCatalog: EvidenceIdentity[] = [];
  const evidenceIdByHandle = new Map<string, string>();
  for (const s of result.surfaces ?? []) {
    const evidenceId = `e${evidenceCatalog.length + 1}`;
    evidenceIdByHandle.set(s.handle, evidenceId);
    evidenceCatalog.push({
      evidenceId,
      source: {
        kind: "file",
        uri: s.path,
        // The pack carries a content sha only on some surfaces (turn-economy
        // V2). Never fabricate one: absent sha → structural class, no hash.
        contentHash: s.sha ?? "",
        ...(s.sha === undefined ? {} : {}),
      },
      locator: {
        ...(parseRange(s.range) === undefined ? {} : { lineRange: parseRange(s.range)! }),
        ...(s.symbol === undefined ? {} : { symbol: { id: s.symbol, name: s.symbol, kind: "unknown" } }),
      },
      evidenceClass: s.sha !== undefined ? "direct" : "structural",
      validityKeys: s.sha !== undefined ? [{ type: "file-sha", value: `${s.path}@${s.sha}` }] : [],
    });
  }

  // --- obligations: change_contract first, capability gaps for discovery ---
  const taskRefForUses = "task"; // identity class — never the volatile handle
  const evidenceUses: EvidenceUse[] = [];
  const obligations: TaskReasoningIR["obligations"] = [];

  const contract = result.change_contract;
  if (contract !== undefined) {
    for (const o of contract.obligations) {
      const evidenceId = evidenceIdByHandle.get(o.handle);
      const refs = evidenceId === undefined ? [] : [evidenceId];
      // Plan hard rule: a "satisfied"-like state REQUIRES grounded evidence.
      // A ready obligation is still OPEN work (the edit has not run); an
      // obligation whose surface cannot be grounded degrades to open too.
      const state: TaskReasoningIR["obligations"][number]["state"] =
        o.status === "needs-context" ? "blocked" : "open";
      obligations.push({
        id: o.id,
        claim: `${o.action} ${o.path}:${o.range}${o.reason === undefined ? "" : ` (${o.reason})`}`.slice(0, 200),
        state,
        evidenceRefs: refs,
      });
      if (evidenceId !== undefined) {
        evidenceUses.push({
          taskRef: taskRefForUses,
          evidenceId,
          roles: [roleOf(o.role)],
          obligationIds: [o.id],
          required: o.required,
        });
      }
    }
  }
  // Covered concerns are the pack's own closure claims: satisfied ONLY when
  // grounded in at least one cataloged surface handle.
  for (const c of result.concerns ?? []) {
    if (c.status !== "covered") continue;
    const refs = (c.handles ?? [])
      .map((h: string) => evidenceIdByHandle.get(h))
      .filter((x): x is string => x !== undefined);
    obligations.push({
      id: `concern:${c.id}`,
      claim: `concern ${c.id} covered by served surfaces`,
      state: refs.length > 0 ? "satisfied" : "open",
      evidenceRefs: refs,
    });
  }
  // Discovery shape: execution-contract capability gaps become open work.
  const gaps = result.execution_contract?.capability_gaps ?? [];
  for (let i = 0; i < gaps.length; i += 1) {
    const gap = gaps[i] as { kind?: string; reason?: string };
    obligations.push({
      id: `gap:${i + 1}`,
      claim: (gap.reason ?? gap.kind ?? "unresolved capability gap").slice(0, 200),
      state: "open",
      evidenceRefs: [],
    });
  }
  // Cap: required/blocked/open before satisfied, stable order within groups.
  const rank = (s: string): number => (s === "blocked" ? 0 : s === "open" ? 1 : s === "invalidated" ? 2 : 3);
  const cappedObligations = obligations
    .map((o, i) => ({ o, i }))
    .sort((a, b) => rank(a.o.state) - rank(b.o.state) || a.i - b.i)
    .slice(0, IR_OBLIGATIONS_MAX)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.o);

  // --- decision ---
  const canonical = deriveCanonicalTaskDecision(result);
  const decisionState: TaskReasoningIR["decision"]["state"] =
    canonical === undefined ? "pending"
      : canonical.kind === "act-answer" || canonical.kind === "act-edit" ? "prepared"
        : canonical.kind === "terminal-closed" ? "done"
          : "pending"; // discover | await-input (acting/verifying are post-edit states)
  const decisionRefs =
    decisionState === "prepared"
      ? cappedObligations.filter((o) => o.evidenceRefs.length > 0).flatMap((o) => o.evidenceRefs).slice(0, 8)
      : [];

  // --- allowed next (grounded: route + pack continuation only) ---
  const allowedNext: TaskReasoningIR["allowedNext"] = [];
  if (result.route !== undefined) {
    const tool = result.route.action === "edit_from_handles" ? "edit_file"
      : result.route.action === "locate_missing_surfaces" ? "search_files"
        : "read_file";
    allowedNext.push({ tool, reason: result.route.action });
  }
  if (result.next !== undefined && canonical?.kind === "discover") {
    allowedNext.push({ tool: "read_file", reason: "continue-discovery" });
  }

  // --- constraints (grounded rows only — nothing invented) ---
  const constraints: TaskReasoningIR["constraints"] = [];
  if (result.profile_binding !== undefined) {
    constraints.push({
      id: "profile-binding",
      text: `profile=${result.profile_binding.selected} source=${result.profile_binding.source}`,
      source: "repository",
    });
  }
  if (result.task_profile !== undefined) {
    constraints.push({ id: "task-profile", text: `task_profile=${result.task_profile}`, source: "repository" });
  }

  // --- invalidation keys ---
  const invalidationKeys: TaskReasoningIR["invalidationKeys"] = [];
  if (result.qref !== undefined) invalidationKeys.push({ type: "qref", value: result.qref });
  for (const e of evidenceCatalog) {
    const key = e.validityKeys[0];
    if (key !== undefined) invalidationKeys.push(key);
  }

  const goal = (input.query ?? result.qref ?? "").slice(0, IR_GOAL_MAX_CHARS);

  const ir: TaskReasoningIR = {
    taskRef: input.taskId ?? result.qref ?? "task",
    stateVersion: 1,
    stateHash: "", // filled below from the canonicalized subset
    goal,
    constraints: constraints.slice(0, IR_CONSTRAINTS_MAX),
    evidenceCatalog,
    evidenceUses,
    obligations: cappedObligations,
    decision: { state: decisionState, evidenceRefs: decisionRefs },
    allowedNext: allowedNext.slice(0, IR_ALLOWED_NEXT_MAX),
    invalidationKeys,
  };

  // stateHash boundary (§4.4): task-state identity only. The volatile task
  // handle enters as its identity class; delivery-domain material (bodies,
  // wire handles, confidences, server build) never entered the IR at all.
  const hashSubject = {
    taskRef: "task",
    goal: ir.goal,
    constraints: ir.constraints,
    evidence: ir.evidenceCatalog.map((e) => ({
      uri: e.source.uri,
      contentHash: e.source.contentHash,
      cls: e.evidenceClass,
      range: e.locator?.lineRange,
    })),
    uses: ir.evidenceUses,
    obligations: ir.obligations,
    decision: ir.decision,
    allowedNext: ir.allowedNext,
    invalidationKeys: ir.invalidationKeys,
  };
  ir.stateHash = createHash("sha256").update(stableStringify(hashSubject)).digest("hex");
  return ir;
}
