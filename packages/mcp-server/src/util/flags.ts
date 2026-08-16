/**
 * flags.ts — centralized feature flag reader.
 *
 * Reads process.env at call time so tests can manipulate env per-test.
 * No I/O, no logging, no dependencies.
 *
 * ---------------------------------------------------------------------------
 * D10 — env-flag disposition for the protocol v1 freeze (2026-08-14)
 * ---------------------------------------------------------------------------
 *
 * DESIGN-v0.10-protocol-v1-contract-freeze.md §8 D10 adjudicates (a) for the
 * wire-affecting flags and (b) for the rest: "A protocol whose shape changes
 * with an env var is not frozen." The adjudicated permanent-on set is the
 * FIFTEEN flags that shipped default-ON from this file (§8 D10 [R5-1],
 * user-approved 2026-08-14, measured by 20 per-flag replayCorpus
 * counterfactual runs). Their readers, their env reads, and every off-branch
 * they guarded are DELETED — the behaviour is now unconditional, which is what
 * "no compat branches in product code" means. They are listed here by name
 * only, so the freeze is self-documenting and a reintroduced env read is
 * visibly a regression:
 *
 *   (A) permanent-on, off-branch deleted — NOT readable from env any more:
 *       TL_TASK_PACK, TL_FULL_GOVERNOR, TL_SMALL_FILE_ONE_CALL,
 *       TL_EDIT_INTENTS, TL_SESSION_CONTROL, TL_LEAN_CONTRACT,
 *       TL_RECURSIVE_READ_CLOSURE, TL_EVIDENCE_RELATIONS, TL_SEMANTIC_WIRING,
 *       TL_REFUSAL_PROGRESS, TL_CONSTRUCT_RECEIVER, TL_QUERY_BEHAVIOR_PROOF,
 *       TL_HUB_PUBLISH_ANCHOR, TL_SERVED_RANGE_LEDGER, TL_CREATE_REQUIRES_CWD.
 *
 * The flags that REMAIN in this file are out of the v1 wire contract. The
 * contract does not describe, and conformance does not cover, behaviour with
 * any of them enabled:
 *
 *   (B) out-of-contract, experiment-only (default OFF; D10(b)). Turning one on
 *       is an unfrozen capability addition, not a supported posture — and
 *       TL_ADAPTIVE_WHOLE_FILE=1 demonstrably fails the recorded corpus, which
 *       is why these were NOT permanent-on'd:
 *       TL_VERIFICATION_RECIPE, TL_HOP1_CLOSURE, TL_ADAPTIVE_WHOLE_FILE,
 *       TL_EVIDENCE_SHADOW, TL_EVIDENCE_COMPLETION, TL_WRITE_CAPABILITY.
 *
 *   (C) out-of-contract, non-wire operational/diagnostic (D10(b)). These
 *       select trace, indexing, or CI strictness, not response shape:
 *       TL_TRACE, TL_GRAPH_INDEX (tri-state; "permanent-on" is undefined for
 *       it), TL_DECISION_INVARIANT_STRICT (CI-only).
 *
 *   (C) elsewhere in the tree, recorded here so the inventory is complete:
 *       TL_GENERIC_TEXT_DISCOVERY (tools/walkRepo.ts — discovery scope, not
 *       wire shape), TL_KILL_SWITCH
 *       (server.ts), TL_MCP_CONFIG_SHA256 + TL_P1_CAUSAL_RUN_NONCE
 *       (util/trace.ts provenance), the core2 fault-injection trio
 *       TL_C2_TEST_COMMIT_DELAY_MS / TL_C2_TEST_FAIL_<name>_AT /
 *       TL_SHADOW_CANDIDATE_COMMIT (core2/edit.ts; core2 is excluded from the
 *       public dist per D9), and the TOKENLIGHTEN_* operational vars.
 *       TL_ENABLE_DEPRECATED_ALIASES and the three per-tool disables
 *       (TL_DISABLE_GET_FILE_SKELETON, TL_DISABLE_GET_SYMBOL_WITH_CONTEXT,
 *       TL_DISABLE_EXTRACT_OFFICE_TEXT) are D11 territory, not D10's, and are
 *       deliberately left untouched here.
 */

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseBool(value: string | undefined, defaultOn: boolean): boolean {
  if (value === undefined) return defaultOn;
  switch (value.toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
    case "":
      return false;
    default:
      return defaultOn;
  }
}

// ---------------------------------------------------------------------------
// Public API — (B) and (C) only; see the D10 block above.
// ---------------------------------------------------------------------------

/** D10 (C): index mode. Non-wire; tri-state, so permanent-on does not apply. */
export function graphIndexMode(): "auto" | "on" | "off" {
  const raw = process.env["TL_GRAPH_INDEX"];
  if (raw === undefined) return "auto";
  switch (raw.toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return "on";
    case "0":
    case "false":
    case "no":
    case "off":
      return "off";
    default:
      return "auto";
  }
}

/** D10 (C): diagnostic trace channel. Out-of-contract, non-wire. */
export function traceEnabled(): boolean {
  return parseBool(process.env["TL_TRACE"], false);
}

/**
 * Compact, provenance-only executable verification recipe enrichment.
 *
 * D10 (B): out-of-contract, debug/experiment-only; the v1 wire contract does
 * not cover behavior with this flag enabled. Experimental capability addition,
 * bench-inconclusive so far; default off pending evidence it earns its keep.
 */
export function verificationRecipeEnabled(): boolean {
  return parseBool(process.env["TL_VERIFICATION_RECIPE"], false);
}

/**
 * Bounded call-site/definition context attached to find/references results.
 *
 * D10 (B): out-of-contract, debug/experiment-only; the v1 wire contract does
 * not cover behavior with this flag enabled. Experimental capability addition,
 * bench-inconclusive so far; default off pending evidence it earns its keep.
 */
export function hop1ClosureEnabled(): boolean {
  return parseBool(process.env["TL_HOP1_CLOSURE"], false);
}

/**
 * Escalate repeated non-contiguous slices to one governed whole-file serve.
 *
 * D10 (B): out-of-contract, debug/experiment-only; the v1 wire contract does
 * not cover behavior with this flag enabled. Measured 2026-08-14: enabling it
 * fails two recorded replay-corpus cases (`seh1`/`seh2`, elided-window zoom),
 * so it is an unfrozen capability addition rather than a supported posture.
 */
export function adaptiveWholeFileEnabled(): boolean {
  return parseBool(process.env["TL_ADAPTIVE_WHOLE_FILE"], false);
}

/**
 * P1 evidence completion (DESIGN-v0.10 D7), SHADOW half: resolve per-concern
 * decision-authority evidence and write it to the trace channel, changing
 * NOTHING in responses.
 *
 * D10 (B): out-of-contract, debug/experiment-only; the v1 wire contract does
 * not cover behavior with this flag enabled. Default off — an unproven
 * capability addition, and shadow mode's whole point is that flipping it on is
 * observationally inert on the wire (evidenceShadow.spec.ts pins that). D7's
 * rollout order is shadow -> paired ablation -> defaults, and the paired
 * ablation hasn't run yet.
 */
export function evidenceCompletionShadowEnabled(): boolean {
  return parseBool(process.env["TL_EVIDENCE_SHADOW"], false);
}

/**
 * P1 evidence completion, ACTIVE half: serve the resolved evidence in the pack.
 *
 * D10 (B): out-of-contract, debug/experiment-only; the v1 wire contract does
 * not cover behavior with this flag enabled. Default off; this is the arm the
 * D7 paired ablation turns on. Not yet wired to a serving path — shadow ships
 * first by design.
 */
export function evidenceCompletionEnabled(): boolean {
  return parseBool(process.env["TL_EVIDENCE_COMPLETION"], false);
}

/**
 * D5/W2/W3: scoped write-capability grants remain default-off.
 *
 * D10 (B): out-of-contract, debug/experiment-only; the v1 wire contract does
 * not cover behavior with this flag enabled.
 */
export function writeCapabilityEnabled(): boolean {
  return parseBool(process.env["TL_WRITE_CAPABILITY"], false);
}

/**
 * P0a §6.1 (2026-08-13): the shared task-pack exit ALWAYS repairs a
 * route/contract/continuation contradiction before the response leaves the
 * dispatcher. Strict mode additionally THROWS when a violation survives the
 * repair — i.e. when the canonical normalizer could not converge, which is a
 * genuine invariant breach rather than a stale projection. Default off in
 * production (a live agent gets the repaired response, never an RPC error);
 * the vitest configs turn it on so a regression fails loudly in CI.
 *
 * D10 (C): out-of-contract, non-wire; it converts an already-repaired response
 * into a CI failure and never changes a production payload.
 */
export function decisionInvariantStrictEnabled(): boolean {
  return parseBool(process.env["TL_DECISION_INVARIANT_STRICT"], false);
}
