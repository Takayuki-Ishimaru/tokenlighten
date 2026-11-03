// recursiveClosure — extracted implementation; imports point to the owning modules.
import type { ContinuationCall } from "./packBasics.js";
import type { TaskPackResult } from "../model.js";
import type { TaskProfile } from "@tokenlighten/types";
import { FileReadCache } from "./packBasics2.js";
import { RECURSIVE_CLOSURE_DEEP_PROFILES } from "./readinessFalsification2.js";
import { RECURSIVE_READ_CLOSURE_MAX_BRANCHES } from "./readinessFalsification2.js";
import { RECURSIVE_READ_CLOSURE_MAX_DEPTH } from "./readinessFalsification2.js";
import { RECURSIVE_READ_CLOSURE_MAX_OPERATIONS } from "./readinessFalsification2.js";
import { admitLeanSameHandleClosure } from "./recursiveClosure3.js";
import { admitReadOnlyNextCall } from "./unresolvedCalls.js";
import { buildTaskExecutionContract } from "./executionContract.js";
import { buildTaskWorkspaceState } from "./epochEvidence2.js";
import { canonicalContinuationCall } from "./packBasics.js";
import { closureCallSignature } from "./recursiveClosure2.js";
import { executeClosureRead } from "./recursiveClosure2.js";
import { executeClosureSearch } from "./recursiveClosure2.js";
import { isCandidateListPack } from "./recursiveClosure3.js";
import { noteClosureExecutedCalls } from "./recursiveClosure2.js";
import { refreshAfterRecursiveClosure } from "./recursiveClosure3.js";
import { resolveServedDuplicateCandidate } from "./recursiveClosure3.js";
import { runCandidateInlinePass } from "./recursiveClosure3.js";

export function runRecursiveReadOnlyClosure(
  result: TaskPackResult,
  profile: TaskProfile,
  query: string,
  workspace: string,
  cache?: FileReadCache,
  scopePaths?: readonly string[],
): number {
  // D10 (2026-08-14): `TL_RECURSIVE_READ_CLOSURE` is deleted.
  if (query.trim().length === 0) return 0;
  if ((result.concern_ambiguities?.length ?? 0) > 0) return 0;
  const seen = new Set<string>();
  const receipt: NonNullable<TaskPackResult["internalized"]> = [];
  let operations = 0;

  // Candidate-list packs get exactly one bounded inline pass and an explicit
  // stop — never the open-ended discovery loop (whose next_call re-derivation
  // is what the 2026-07-19a thrash fed on). Runs for EVERY profile: ambiguity
  // is where the anti-thrash help matters most.
  if (isCandidateListPack(result)) {
    operations += runCandidateInlinePass(result, profile, query, workspace, receipt, cache);
    if (resolveServedDuplicateCandidate(result, profile, query)) {
      refreshAfterRecursiveClosure(result, profile, query, workspace, cache);
    }
    if (receipt.length > 0) result.internalized = receipt.slice(0, RECURSIVE_READ_CLOSURE_MAX_OPERATIONS);
    return operations;
  }

  // Inferred lean profiles may close one predictable follow-up, but only by
  // completing one already-selected required surface through its exact handle.
  // Search, path discovery, new surfaces, and multi-handle choice stay external.
  if (
    result.profile_binding?.source === "inferred"
    && result.profile_binding.selected === profile
    && (profile === "generic" || profile === "answer")
  ) {
    const contract = buildTaskExecutionContract(
      result, profile, query, buildTaskWorkspaceState(result), workspace,
    );
    if (
      contract.typestate.phase === "discovery"
      && contract.call_budget?.discovery_allowed === true
      && contract.next_call !== undefined
    ) {
      const candidates: ContinuationCall[] = [
        contract.next_call,
        ...(result.continuation?.stages[0]?.calls ?? []),
      ].map((call) => canonicalContinuationCall(call)!);
      for (const candidate of candidates) {
        const call = admitLeanSameHandleClosure(result, candidate, query, workspace);
        if (!call) continue;
        operations = 1;
        const used = executeClosureRead(result, call, workspace);
        if (used.evidence > 0) {
          receipt.push({
            op: "read",
            status: "used",
            evidence: used.evidence,
            ...(used.handle ? { handle: used.handle } : {}),
          });
          refreshAfterRecursiveClosure(result, profile, query, workspace, cache);
          result.internalized = receipt;
        }
        break;
      }
    }
    return operations;
  }

  // Deep recursive discovery is limited to structurally multi-site profiles
  // (or an explicit caller-pinned taskProfile) — see
  // RECURSIVE_CLOSURE_DEEP_PROFILES.
  if (
    result.profile_binding?.source !== "explicit"
    && !RECURSIVE_CLOSURE_DEEP_PROFILES.has(profile)
  ) {
    return operations;
  }

  for (let depth = 0; depth < RECURSIVE_READ_CLOSURE_MAX_DEPTH; depth++) {
    if (isCandidateListPack(result)) {
      // A refresh flipped the pack INTO a candidate list mid-loop: same
      // bounded inline + explicit stop as the entry path.
      operations += runCandidateInlinePass(result, profile, query, workspace, receipt, cache);
      break;
    }
    const contract = buildTaskExecutionContract(
      result, profile, query, buildTaskWorkspaceState(result), workspace,
    );
    if (
      contract.typestate.phase !== "discovery"
      || contract.call_budget?.discovery_allowed !== true
      || contract.next_call === undefined
    ) {
      break;
    }
    const candidates: ContinuationCall[] = [
      contract.next_call,
      ...(result.continuation?.stages[0]?.calls ?? []),
    ].map((call) => canonicalContinuationCall(call)!);
    // D1 (FX-R3): the RAW candidate travels beside the admitted call, because
    // `result.next` still holds the raw shape and the loop executes the
    // admitted one — the fingerprint set has to answer for both.
    const admitted: Array<{ raw: ContinuationCall; call: ContinuationCall }> = [];
    for (const candidate of candidates) {
      const call = admitReadOnlyNextCall(candidate, query);
      if (!call) continue;
      const signature = closureCallSignature(call);
      if (seen.has(signature)) continue;
      seen.add(signature);
      admitted.push({ raw: candidate, call });
      if (admitted.length >= RECURSIVE_READ_CLOSURE_MAX_BRANCHES) break;
    }
    if (admitted.length === 0) break;

    let stageEvidence = 0;
    for (const { raw, call } of admitted) {
      if (operations >= RECURSIVE_READ_CLOSURE_MAX_OPERATIONS) break;
      operations += 1;
      if (call.tool === "tl_read_file") {
        const used = executeClosureRead(result, call, workspace);
        if (used.evidence > 0) {
          receipt.push({
            op: "read",
            status: "used",
            evidence: used.evidence,
            ...(used.handle ? { handle: used.handle } : {}),
          });
          stageEvidence += used.evidence;
          // D1: recorded only for a call whose EVIDENCE IS NOW IN THIS PACK.
          // A call the loop ran to no effect (its ranked harvest is bounded by
          // depth/branch/byte caps that a caller's own call is not) leaves the
          // pack exactly as it was, so restating it is still a real
          // affordance — suppressing it there would strand the caller.
          noteClosureExecutedCalls(result, [raw, call]);
        }
      } else if (call.tool === "tl_search_files") {
        const evidence = executeClosureSearch(result, call, workspace, query, scopePaths);
        if (evidence > 0) {
          receipt.push({ op: "find", status: "used", evidence });
          stageEvidence += evidence;
          noteClosureExecutedCalls(result, [raw, call]); // D1, see above.
        }
      }
    }
    if (stageEvidence === 0) break;
    refreshAfterRecursiveClosure(result, profile, query, workspace, cache);
    if (operations >= RECURSIVE_READ_CLOSURE_MAX_OPERATIONS) break;
  }

  if (receipt.length > 0) result.internalized = receipt.slice(0, RECURSIVE_READ_CLOSURE_MAX_OPERATIONS);
  return operations;
}
