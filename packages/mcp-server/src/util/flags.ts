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
 *       TL_EVIDENCE_SHADOW, TL_EVIDENCE_COMPLETION, TL_WRITE_CAPABILITY,
 *       TL_BM25F_CANDIDATE, TL_RRF_FUSION (v0.10 beta.2, V10-08 Hybrid
 *       Retrieval v1 — see features/retrieval/; candidate-generation-stage
 *       only, never read by a known-local dispatch path),
 *       TL_COVERAGE_PACKER (v0.10 beta.2, V10-09: obligation-aware
 *       coverage-per-token candidate selection inside the task pack. It
 *       changes WHICH surfaces a pack serves, not the response SHAPE — no new
 *       kind, field, or tool argument — but "fewer/different surfaces" is
 *       still observable content, so it stays default-OFF and outside the
 *       frozen contract until a decision-scale run adjudicates it),
 *       TL_GRAPH_EVIDENCE (v0.11 wave A, V11-01: the derived graph-evidence /
 *       impact-analysis overlay in features/graph-evidence/. Wave A shipped
 *       that tree as a PURE library with ZERO production importers, so OFF
 *       was byte-identical BY CONSTRUCTION. Wave B (V11-05, below) is the
 *       first production importer — OFF is now byte-identical by ordinary
 *       branch discipline instead: locateTaskContext.ts's compound-retrieval
 *       seam requires this flag AND TL_COMPOUND_RETRIEVAL both on before it
 *       ever calls into features/compound/, which is the only production
 *       caller of features/graph-evidence/ today. V11-06's write/
 *       impactGuard.ts remains a second intended wave-B consumer, not yet
 *       wired),
 *       TL_COMPOUND_RETRIEVAL (v0.11 wave B, V11-05: the bounded read-only
 *       hop closure in features/compound/, wired at ONE seam in
 *       locateTaskContext.ts's candidate generation. COMPOSES with
 *       TL_GRAPH_EVIDENCE rather than standing alone — the seam calls
 *       applyCompoundRetrieval() only when BOTH flags are on; with either
 *       off the seam's `if` never runs, so `related` gets exactly its
 *       pre-V11-05 entries. Even fully on, the module only ever ADDS
 *       `related` candidates (never touches `primary` or reorders/evicts an
 *       existing entry) and rides the existing `ImpactCandidate` shape — no
 *       new kind, field, or tool argument. Default off; holdout/decision-
 *       scale adjudication is a later cycle's job, same posture as every
 *       other v0.11 wave-B retrieval flag here),
 *       TL_REASONING_IR_V2 (v0.11 wave B, V11-04: Task Reasoning IR v2 —
 *       reasoning_delta / obligation DAG / hypothesis tombstones / SHADOW Stop
 *       candidates in task-state/. Its ONE dispatch seam is advisory and
 *       trace-only: no wire kind, no wire field, no tool argument, and the
 *       seam is wrapped so any IR failure degrades to a trace line. With the
 *       flag unset the seam is not entered at all, so the pack bytes are
 *       identical).
 *
 *   (C) out-of-contract, non-wire operational/diagnostic (D10(b)). These
 *       select trace, indexing, CI strictness, or bounded production policy;
 *       they do not add protocol kinds, fields, or tool arguments:
 *       TL_TRACE, TL_GRAPH_INDEX (tri-state; "permanent-on" is undefined for
 *       it), TL_DECISION_INVARIANT_STRICT (CI-only), and the W15 policy knobs
 *       TL_TINY_SKELETON_CAP, TL_UNREAD_NOTE_SPECIFICITY, and
 *       TL_UNREAD_NOTE_MAX_HUNK_LINES. The W15 variables tune established
 *       read/edit response content within the frozen v1 families; defaults are
 *       the supported production posture and explicit overrides are operational.
 *
 *   (C) elsewhere in the tree, recorded here so the inventory is complete:
 *       TL_INDEX_CONSISTENCY_SCAN (v0.11.0, V11-09: skeleton-engine's
 *       bounded opportunistic self-heal — verifies a sample of the source
 *       index against disk content-sha and drops stale entries so the next
 *       load re-extracts them. Content-only, like TL_COVERAGE_PACKER: it
 *       can change WHICH cached entries survive into a served pack, never
 *       the response shape — no wire kind, field, or tool argument. NOT a
 *       reader in this file: skeleton-engine must not import mcp-server
 *       (see AGENTS.md's package table), so consistencyScan.ts's
 *       `consistencyScanEnabledFromEnv()` reads `process.env` directly,
 *       mirroring this file's parseBool convention by hand.
 *       RECLASSIFIED (B) -> (C) 2026-08-21 (v0.11.x release prep, W2-C):
 *       default flipped ON the same day, same rationale as TL_GRAPH_INDEX's
 *       (C) membership above — content-only, no wire-shape branch, so it is
 *       an operational/index posture rather than an unfrozen capability
 *       addition. Evidence for the flip: the manifestMemo whole-match
 *       shortcut (skeleton-engine/src/indexStore.ts) demonstrably serves
 *       stale symbol data indefinitely, within one long-lived server
 *       process, for a same-stat (size+mtime) external write that skips
 *       invalidateCachedWorkspaceFiles — reproduced end-to-end against the
 *       real server via search_files action=symbols (the one production
 *       loadOrBuildSourceIndex call site); see faultInjection.spec.ts and
 *       consistencyScan.spec.ts for the pinned regression shape. Cost is
 *       bounded by design (maxFiles/maxDurationMs in consistencyScan.ts)
 *       and measured at tens-to-low-hundreds of ms on a same-process warm
 *       (memo-hit) call; a cross-process cold or per-file-loop warm call
 *       pays effectively nothing extra, since the P1.4 content-hash gate
 *       already re-verifies every file's bytes on those paths regardless
 *       of this flag. Opt out with TL_INDEX_CONSISTENCY_SCAN=0.),
 *       TL_GENERIC_TEXT_DISCOVERY (tools/walkRepo.ts — discovery scope, not
 *       wire shape), TL_KILL_SWITCH
 *       (server.ts), TL_MCP_CONFIG_SHA256 + TL_P1_CAUSAL_RUN_NONCE
 *       (util/trace.ts provenance), the core2 fault-injection trio
 *       TL_C2_TEST_COMMIT_DELAY_MS / TL_C2_TEST_FAIL_<name>_AT /
 *       TL_SHADOW_CANDIDATE_COMMIT (core2/edit.ts; core2 is excluded from the
 *       public dist per D9), and the TOKENLIGHTEN_* operational vars —
 *       including TOKENLIGHTEN_PROTOCOL_ERA (mcp/transport/index.ts, v0.10
 *       alpha.1): a startup-once dual-era transport selector
 *       (legacy|modern, default legacy); never read by domain handlers and
 *       never a response-shape branch within an era. v0.10 alpha.2 (PI-09)
 *       adds the explicit-state locations and kill switch, all
 *       operational/platform class: TOKENLIGHTEN_STATE_KEY_DIR /
 *       TOKENLIGHTEN_CONFIG_HOME / TOKENLIGHTEN_HOME (+ the platform
 *       APPDATA / XDG_CONFIG_HOME fallbacks) locate the installation HMAC
 *       key (state/handleKeys.ts), and TOKENLIGHTEN_STATE_STORE=off
 *       disables the per-workspace persistent store (state/stateStore.ts) —
 *       a disabled/missing store degrades to the honest handle-unknown
 *       refusal path, never a response-shape change. v0.10 "simultaneous-
 *       instance locking" adds TOKENLIGHTEN_STATE_LOCK_STALE_MS
 *       (state/writerLock.ts): a test-only override of the advisory
 *       cross-process writer lock's staleness window (production default
 *       8000ms). Purely internal lock TIMING — it never changes a response
 *       shape, only how long a stale-lock break/acquire-bound takes to prove
 *       itself, which is exactly why it is safe to leave live rather than
 *       gating it behind a test-only build.
 *       v0.10 PI-09 deferred cell adds the opt-in Streamable HTTP leg
 *       (mcp/transport/modernHttp.ts): TOKENLIGHTEN_HTTP_PORT (unset =
 *       no HTTP, the default) and TOKENLIGHTEN_HTTP_HOST (default
 *       127.0.0.1, loopback-only) select whether/where a SECOND transport
 *       binds a socket alongside stdio. Both are startup-once and
 *       operational/platform class exactly like TOKENLIGHTEN_PROTOCOL_ERA
 *       above — never read by domain handlers, and the modern-era server
 *       factory this leg serves answers byte-identically to the stdio leg
 *       for the same call, so neither variable is a response-shape branch.
 *       F-A7 (v0.11 wave C) adds TOKENLIGHTEN_CLIENT_ID (server.ts): an
 *       explicit override/supply of the per-connection client identity that
 *       feeds ProtocolCallContext.clientId (protocol/envelope.ts) when the
 *       hand-rolled dispatcher's own initialize-time capture has nothing —
 *       operational/platform class like the pair above; see the V11-07
 *       addendum below for the wire-serialization consequence it can (only
 *       conditionally) reach.
 *       TL_ENABLE_DEPRECATED_ALIASES and the three per-tool disables
 *       (TL_DISABLE_GET_FILE_SKELETON, TL_DISABLE_GET_SYMBOL_WITH_CONTEXT,
 *       TL_DISABLE_EXTRACT_OFFICE_TEXT) are D11 territory, not D10's, and are
 *       deliberately left untouched here.
 *
 * ---------------------------------------------------------------------------
 * V10-11 addendum -- Adaptive Wire Encoding v1 (2026-08-20)
 * ---------------------------------------------------------------------------
 *
 * DESIGN-v0.10-expansion-plan-v1.3.md V10-11 adds two flags this file reads.
 * They are out-of-contract in a DIFFERENT sense than (A)/(B)/(C) above: D10's
 * "a protocol whose shape changes with an env var is not frozen" is about the
 * CANONICAL structure -- kind, required sets, field semantics -- and neither
 * flag ever changes that. What they choose is which `ResponseCodec`
 * (protocol/codec/) renders that already-decided structure onto
 * `TextContent.text`; `decode(encode(x))` recovers the identical canonical
 * payload for every codec V10-11 ships. Both default OFF, and with both
 * unset the wire is byte-identical to pre-V10-11 output (protocol/codec/
 * pipeline.ts's `applyResponseCodec` is a no-op on that path):
 *
 *   TOKENLIGHTEN_RESPONSE_FORMAT (json|auto|compact|debug, default json) --
 *       selects the live wire representation. "debug" never changes wire
 *       bytes (always json) but always gathers the shadow comparison below.
 *   TL_WIRE_SHADOW -- measures every eligible codec candidate and logs the
 *       comparison to the TL_TRACE channel without ever changing emitted
 *       bytes, independent of TOKENLIGHTEN_RESPONSE_FORMAT.
 *
 * ---------------------------------------------------------------------------
 * PI-03 addendum -- the attestation tier (2026-08-20, v0.10 close-out)
 * ---------------------------------------------------------------------------
 *
 * TL_CONTEXT_ATTESTATION joins class (B): out-of-contract, default OFF.
 *
 * It gates the PI-03 trusted-client-host tier -- `context_handle` issuance and
 * the `client_acknowledged_prior` receipt disposition -- and it is a (B) flag
 * for exactly the reason (B) exists: with it ON, a VERIFIED attestation lets a
 * receipt drop its micro-restate bytes, which is observable content even though
 * no kind, field, or tool argument changes. Reconciliation §2's PI-03 row says
 * the same thing in its own words: "default OFF; unknown clients keep exactly
 * today's behavior".
 *
 * Two properties make it safe to carry in the tree:
 *   - OFF is byte-identical to pre-PI-03 output, and the attestation channel
 *     is not even parsed (the verdict is `disabled`);
 *   - ON with no attestation, or with any attestation that does not verify, is
 *     ALSO byte-identical -- rejection is defined to behave exactly as
 *     unattested (domain/context-attestation.ts's
 *     `ContextAttestationRejection` doc).
 * So the flag's blast radius is bounded by "a client that can prove retention",
 * which is the population the tier was designed for.
 *
 * ---------------------------------------------------------------------------
 * V11-07 addendum -- Adaptive Wire Encoding v2 (2026-08-21)
 * ---------------------------------------------------------------------------
 *
 * TL_WIRE_BREAKEVEN joins class (B): out-of-contract, default OFF, and --
 * like TOKENLIGHTEN_RESPONSE_FORMAT/TL_WIRE_SHADOW above -- a wire
 * SERIALIZATION concern, never a change to protocol v1's canonical shape.
 *
 * It has no effect on its own: v2 selection (protocol/codec/selectV2.ts --
 * a per-cell break-even table, a client compatibility profile, a
 * tokenizer-aware comparison, an encoding cache, and a two-stage
 * codec x host-budget selection loop) runs ONLY when BOTH
 * TOKENLIGHTEN_RESPONSE_FORMAT=auto AND TL_WIRE_BREAKEVEN are set. With
 * either one unset (the default for both), `applyResponseCodec`
 * (protocol/codec/pipeline.ts) takes exactly the same branch it took
 * before this flag existed -- byte-identical output, same as every other
 * flag-off path this file documents.
 *
 * The one E-3 deviation this flag can ever activate: `read.text` -- never
 * eligible for non-json encoding under v1 -- may be encoded `tl-raw-1` when
 * a resolved client profile explicitly allows it AND the payload's
 * break-even cell clears (protocol/codec/clientProfile.ts,
 * protocol/codec/breakeven.ts). `read.task_pack` stays in
 * HARD_JSON_FIXED_KINDS unconditionally; this flag cannot reach it.
 *
 * F-A7 (v0.11 wave C) closes the seam `resolveClientProfile` always had:
 * `ProtocolCallContext.clientId` is now populated -- captured once from the
 * hand-rolled dispatcher's `initialize` clientInfo.name (server.ts's ONE
 * read site for it), or from TOKENLIGHTEN_CLIENT_ID when a leg never reaches
 * that capture (every leg but the hand-rolled fallback). Neither source is
 * itself wire-affecting: a clientId that fails to resolve a KNOWN, FRESH
 * profile still yields UNKNOWN_CLIENT_PROFILE, and this whole selection
 * branch stays behind TL_WIRE_BREAKEVEN+auto exactly as above.
 *
 * ---------------------------------------------------------------------------
 * V11-02 addendum -- Task-aware Weighted RRF v2 / Query Precision (2026-08-21)
 * ---------------------------------------------------------------------------
 *
 * TL_RRF_PROFILES joins class (B): out-of-contract, default OFF.
 *
 * DESIGN-v0.10-expansion-plan-v1.3.md V11-02 adds task-family-aware RRF
 * fusion weights (features/retrieval/profiles.ts, taskFamily.ts,
 * qualityGate.ts) ON TOP OF the existing V10-08 fusion path. It COMPOSES
 * with TL_RRF_FUSION rather than standing alone: profile resolution and the
 * weak-retriever quality gate only ever run when BOTH flags are on
 * (features/retrieval/index.ts's `profilesOn = rrfProfilesEnabled() &&
 * rrfFusionEnabled()`). With either flag off, every fusion list keeps its
 * pre-V11-02 implicit weight of 1 -- the same output
 * weightedReciprocalRankFusion (rrf.ts) produces for reciprocalRankFusion's
 * original callers, by construction (multiplying by 1 changes no bit of the
 * IEEE754 result). Default off; profile weights are holdout-tuned
 * (bench/workflows/retrieval/TUNING-PROFILES-2026-08-21.md) but not yet
 * adjudicated by a decision-scale run.
 *
 * ---------------------------------------------------------------------------
 * V11-03 addendum -- Coverage Packer v2 (2026-08-21)
 * ---------------------------------------------------------------------------
 *
 * TL_COVERAGE_PACKER_V2 joins class (B): out-of-contract, default OFF, and
 * COMPOSES with TL_COVERAGE_PACKER rather than standing alone -- v2 selection
 * (features/task-pack/coveragePackerV2.ts) only runs where v1 selection
 * would have (readCodeTaskPack.ts's ONE V10-09 seam, gated on
 * `coveragePackerEnabled()`); with TL_COVERAGE_PACKER off, this flag gates
 * nothing and the pack is byte-identical to both flags off. With both flags
 * on, the seam calls `coveragePackerV2.ts` instead of `coveragePacker.ts`
 * (v1 stays untouched and is v2's own low-confidence fallback target, so v1's
 * specs/behavior are unaffected either way).
 *
 * ---------------------------------------------------------------------------
 * V11-06 addendum -- Known-Local Fast Path v2 (2026-08-21)
 * ---------------------------------------------------------------------------
 *
 * TL_FAST_PATH_V2 joins class (B): out-of-contract, default OFF.
 *
 * DESIGN-v0.10-expansion-plan-v1.3.md V11-06 adds a Cheap Impact Guard
 * (write/impactGuard.ts), an Edit Representation Selector
 * (write/editSelector.ts), a Target Fingerprint (write/targetFingerprint.ts),
 * and Focused Verification (write/focusedVerification.ts) around the
 * EXISTING known-local edit seam in tools/searchReplaceEdit.ts. With this
 * flag off, that seam's code path is byte-identical to pre-V11-06 --
 * none of the four modules above is even imported into the branch. ON, the
 * only OBSERVABLE behavior changes are (a) a new, narrowly-scoped refusal
 * when a fresh re-read proves the target drifted between selection and
 * apply (target-fingerprint drift -- a real TOCTOU window this flag closes,
 * not a cosmetic addition) and (b) additional TL_TRACE records; every
 * existing success/failure outcome is unchanged, because the new checks
 * either reproduce write/textEdit.ts's own uniqueness decision via the same
 * (unnormalized) counting rule or are trace-only per deviation E-8
 * (DESIGN-v0.11-expansion-plan-reconciliation.md §4 -- no new wire fields
 * in waves A/B). It composes with TL_GRAPH_EVIDENCE: the guard's graph-
 * evidence probe (write/impactGuard.ts's `attemptGraphImpactProbe`) only
 * runs when TL_GRAPH_EVIDENCE is ALSO on; with it off the guard verdict
 * rests on cheap local (I/O-free) signals alone.
 *
 * ---------------------------------------------------------------------------
 * V11-05 addendum -- Compound Retrieval / Bounded Hop Closure (2026-08-21)
 * ---------------------------------------------------------------------------
 *
 * TL_COMPOUND_RETRIEVAL joins class (B): out-of-contract, default OFF.
 *
 * DESIGN-v0.10-expansion-plan-v1.3.md V11-05 folds the
 * definition -> references -> representative consumers -> tests/config hop
 * chain into ONE bounded, read-only graph-evidence expansion
 * (features/compound/compoundRetrieval.ts) seeded from the locator's own
 * already-resolved `primary`. It COMPOSES with TL_GRAPH_EVIDENCE exactly like
 * TL_RRF_PROFILES composes with TL_RRF_FUSION above: the seam in
 * locateTaskContext.ts only calls `applyCompoundRetrieval()` when BOTH flags
 * are on; with either off, `related` is built by exactly the pre-V11-05 code
 * path, byte-identical.
 *
 * Even fully enabled, the module can only ADD `related` candidates, appended
 * strictly after every pre-existing entry — it never touches `primary`,
 * never reorders `related`, and the downstream LOCATE_SUCCESS_CAP byte trim
 * (which pops `related` from the END) always sacrifices a compound addition
 * before any earlier, pre-existing entry. It declines outright (contributes
 * nothing, `related` unchanged) on a semantic branch (more than one distinct
 * file resolves the seed's symbol name), a non-empty staleness report, or an
 * empty provider set — see features/compound/compoundRetrieval.ts and
 * adapters.ts for the exact rules. No new wire kind, field, or tool argument
 * (deviation E-2): a compound-discovered node rides the existing
 * `ImpactCandidate` shape via its `required` flag (required tier -> pack-
 * eligible, likely tier -> inventory-only, informational tier -> traced but
 * NEVER wired).
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

/**
 * V10-08 Hybrid Retrieval v1: BM25F candidate generator (file metadata,
 * symbol declaration/body, markdown section, config object, test case units
 * — see features/retrieval/units.ts). Adds candidates to the
 * locateTaskContext.ts candidate-generation stage; never invoked on a
 * known-local dispatch path (routing/classifier.ts's known_local_fast never
 * reaches locateTaskContext at all, see routeClassifier.spec.ts's live
 * bypass proof).
 *
 * D10 (B): out-of-contract, debug/experiment-only; the v1 wire contract does
 * not cover behavior with this flag enabled — rank provenance goes to
 * TL_TRACE only, never the wire. Default off; field weights are initial
 * values pending holdout tuning (DESIGN-v0.10-expansion-plan-v1.3.md V10-08).
 */
export function bm25fCandidateEnabled(): boolean {
  return parseBool(process.env["TL_BM25F_CANDIDATE"], false);
}

/**
 * V10-08 Hybrid Retrieval v1: reciprocal rank fusion across candidate
 * rankers (exact path/text, parser-proven symbol, direct references,
 * current heuristic, and — when TL_BM25F_CANDIDATE is also on — BM25F).
 * Explicit paths, exact identifier matches, parser-proven declarations, and
 * direct references are a hard floor fusion may reorder among themselves but
 * never displace below a non-floor item or drop (features/retrieval/
 * hardFloor.ts). On its own (TL_BM25F_CANDIDATE off) this fuses only the
 * four non-BM25F rankers.
 *
 * D10 (B): out-of-contract, debug/experiment-only; the v1 wire contract does
 * not cover behavior with this flag enabled. Default off.
 */
export function rrfFusionEnabled(): boolean {
  return parseBool(process.env["TL_RRF_FUSION"], false);
}

/**
 * V11-02 Task-aware Weighted RRF v2: per-task-profile RRF retriever weights
 * (features/retrieval/profiles.ts / taskFamily.ts) plus the weak-retriever
 * quality gate (qualityGate.ts). Composes with TL_RRF_FUSION -- profile
 * resolution and the quality gate only run when BOTH this flag and
 * TL_RRF_FUSION are on; with either off, fusion keeps its pre-V11-02
 * implicit per-list weight of 1 (byte-identical output). See this file's
 * "V11-02 addendum" doc block above for the full disposition.
 *
 * D10 (B): out-of-contract, debug/experiment-only; the v1 wire contract does
 * not cover behavior with this flag enabled. Default off; weights are
 * holdout-tuned (bench/workflows/retrieval/TUNING-PROFILES-2026-08-21.md)
 * but not yet adjudicated by a decision-scale run.
 */
export function rrfProfilesEnabled(): boolean {
  return parseBool(process.env["TL_RRF_PROFILES"], false);
}

/**
 * D10 (B): V10-09 obligation-aware coverage-per-token packer (v0.10 beta.2).
 *
 * OFF (the default) leaves the task pack's relevance-first candidate selection
 * byte-identical — `wireBaselines.spec.ts` and `replayCorpus.spec.ts` pass
 * without regeneration, which is the gate this flag exists to keep clean. ON
 * routes the ranked pool through `features/task-pack/coveragePacker.ts` at the
 * single seam in `readCodeTaskPack.ts`.
 */
export function coveragePackerEnabled(): boolean {
  return parseBool(process.env["TL_COVERAGE_PACKER"], false);
}

/**
 * V11-03 (Coverage Packer v2, v0.11 wave B). See this file's "V11-03
 * addendum" doc block above for the composition rule with
 * `coveragePackerEnabled()` -- this reader only reports the env var's own
 * value; the seam is the one place that enforces the composition.
 *
 * D10 (B): out-of-contract, debug/experiment-only; the v1 wire contract does
 * not cover behavior with this flag enabled. Default off.
 */
export function coveragePackerV2Enabled(): boolean {
  return parseBool(process.env["TL_COVERAGE_PACKER_V2"], false);
}

/**
 * V10-11 (Adaptive Wire Encoding): the wire SERIALIZATION FORMAT selector.
 * See this file's "V10-11 addendum" doc block above for why this is
 * out-of-contract in a different sense than (A)/(B)/(C): the CANONICAL
 * protocol v1 structure (kind, required sets, field semantics) never varies
 * with this flag -- only which `ResponseCodec` renders that structure onto
 * `TextContent.text` does. Any unrecognized value, and the unset default,
 * both resolve to "json" -- the historical, byte-identical wire.
 */
export function responseFormatMode(): "json" | "auto" | "compact" | "debug" {
  const raw = process.env["TOKENLIGHTEN_RESPONSE_FORMAT"];
  switch (raw) {
    case "auto":
    case "compact":
    case "debug":
      return raw;
    default:
      return "json";
  }
}

/**
 * V10-11: shadow-measure every eligible codec candidate and log the
 * comparison to the TL_TRACE channel, WITHOUT changing a single emitted
 * byte (protocol/codec/pipeline.ts enforces that invariant, not this
 * reader). Independent of `responseFormatMode`; independent of
 * `traceEnabled` above (the `trace()` call this flag drives is itself
 * gated by that flag, exactly as every other `trace()` caller in this tree
 * already is).
 */
export function wireShadowEnabled(): boolean {
  return parseBool(process.env["TL_WIRE_SHADOW"], false);
}

/**
 * V10-02 (Telemetry v2): the D10 (B) out-of-contract experiment flags
 * currently ON, by NAME — feeds the trace envelope's `flags_active`
 * (util/trace.ts). Deliberately the (B) set ONLY:
 *   - never (A) — permanent-on and unconditional, so "active" carries no
 *     information any more (see the D10 block at the top of this file);
 *   - never (C) — trace/index/CI-strictness toggles, operational rather than
 *     response-shape experiments, so they answer a different question than
 *     "which unfrozen capability additions were live for this call";
 *   - never the V10-11 wire-encoding pair (responseFormatMode/
 *     wireShadowEnabled) — its own doc block above explains why that is
 *     out-of-contract in a THIRD sense (codec selection, not structure).
 * Order is fixed (declaration order below) so a diff against a prior trace
 * capture is stable. Reads process.env at call time, same contract as every
 * reader in this file.
 */
export function activeExperimentFlags(): readonly string[] {
  const active: string[] = [];
  if (verificationRecipeEnabled()) active.push("TL_VERIFICATION_RECIPE");
  if (hop1ClosureEnabled()) active.push("TL_HOP1_CLOSURE");
  if (adaptiveWholeFileEnabled()) active.push("TL_ADAPTIVE_WHOLE_FILE");
  if (evidenceCompletionShadowEnabled()) active.push("TL_EVIDENCE_SHADOW");
  if (evidenceCompletionEnabled()) active.push("TL_EVIDENCE_COMPLETION");
  if (writeCapabilityEnabled()) active.push("TL_WRITE_CAPABILITY");
  if (bm25fCandidateEnabled()) active.push("TL_BM25F_CANDIDATE");
  if (rrfFusionEnabled()) active.push("TL_RRF_FUSION");
  if (rrfProfilesEnabled()) active.push("TL_RRF_PROFILES");
  if (coveragePackerEnabled()) active.push("TL_COVERAGE_PACKER");
  if (coveragePackerV2Enabled()) active.push("TL_COVERAGE_PACKER_V2");
  if (graphEvidenceEnabled()) active.push("TL_GRAPH_EVIDENCE");
  if (fastPathV2Enabled()) active.push("TL_FAST_PATH_V2");
  if (compoundRetrievalEnabled()) active.push("TL_COMPOUND_RETRIEVAL");
  return active;
}

/**
 * D10 (B): PI-03's trusted-client-host attestation tier. See the "PI-03
 * addendum" block above for why it is (B) and what OFF guarantees.
 */
export function contextAttestationEnabled(): boolean {
  return parseBool(process.env["TL_CONTEXT_ATTESTATION"], false);
}

/**
 * D10 (B): V11-01's graph evidence / impact analysis overlay (v0.11 wave A).
 *
 * OFF (the default) was byte-identical to pre-V11-01 output for a stronger
 * reason than usual in wave A alone: `features/graph-evidence/` had NO
 * production importer, so there was no branch for this flag to select. Wave B
 * (V11-05, this file's "V11-05 addendum" above) is the first production
 * importer; OFF is now byte-identical by the ordinary composed-flag branch at
 * locateTaskContext.ts's compound-retrieval seam, which requires this flag
 * AND TL_COMPOUND_RETRIEVAL both on.
 */
export function graphEvidenceEnabled(): boolean {
  return parseBool(process.env["TL_GRAPH_EVIDENCE"], false);
}

/** V11-07 addendum above (this file's top doc comment) explains this flag's scope. */
export function wireBreakevenEnabled(): boolean {
  return parseBool(process.env["TL_WIRE_BREAKEVEN"], false);
}

/** V11-04 (B): Task Reasoning IR v2. Advisory + trace-only — see the (B) list above. */
export function reasoningIrV2Enabled(): boolean {
  return parseBool(process.env["TL_REASONING_IR_V2"], false);
}

/** V11-06 addendum above (this file's top doc comment) explains this flag's scope. */
export function fastPathV2Enabled(): boolean {
  return parseBool(process.env["TL_FAST_PATH_V2"], false);
}

/**
 * D10 (B): V11-05's compound retrieval (v0.11 wave B). See this file's
 * "V11-05 addendum" doc block above for the full disposition and its
 * composition with TL_GRAPH_EVIDENCE.
 */
export function compoundRetrievalEnabled(): boolean {
  return parseBool(process.env["TL_COMPOUND_RETRIEVAL"], false);
}
