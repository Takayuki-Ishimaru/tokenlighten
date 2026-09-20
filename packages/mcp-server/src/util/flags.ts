/**
 * flags.ts — centralized feature flag reader.
 *
 * Reads process.env at call time so tests can manipulate env per-test.
 *
 * "No I/O" means this module never performs I/O to DECIDE a flag's value —
 * every reader above is a pure `process.env` lookup. The proof-completion
 * trace (`noteProofCompletionPack`, near the bottom of this file) is the one
 * scoped, deliberate exception to that, and is not itself a flag reader: it
 * is the live engagement counter's OPTIONAL, opt-in diagnostic side channel,
 * gated on an explicitly named trace-file env var
 * (`TL_PROOF_COMPLETION_TRACE_PATH`) that is unset in every normal run. When
 * set, it appends one size-capped JSON line per newly counted pack (P2(b),
 * 2026-08-28: capped at PROOF_COMPLETION_TRACE_MAX_BYTES, silently skipping
 * further appends once the file reaches that size — an opt-in debug trace a
 * caller forgot to rotate must not grow without bound). It stays in this
 * file, not a separate module, because it reads the SAME
 * `PROOF_COMPLETION_FLAG_REGISTRY` this file already owns and every other
 * proof-completion reader lives here too; moving only the trace writer
 * elsewhere would split one flag's behavior across two files for a cosmetic
 * gain over the size cap this comment documents instead.
 *
 * ---------------------------------------------------------------------------
 * D10 — env-flag disposition for the protocol v1 freeze (2026-08-14)
 *
 * 2026-09-14 addendum (USER ruling, DESIGN-v0.14-plan.md §10 residual 12):
 * TL_FRONTIER_STRICT_WRITES — D10(B) out-of-contract, default OFF. Strict
 * mode for an edit outside the task's certified frontier: refuses with
 * `frontier-read-only` + retry:"new-task" + a re-pack `next` instead of
 * applying with the `outside-certified-frontier` reclassification marker.
 * Adds no kind, field or tool argument; listed in activeExperimentFlags.
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
 * The flags that REMAIN in this file either select supported content policy
 * within the frozen response families or remain outside the v1 wire contract.
 * None changes the canonical kind/field/tool-argument surface:
 *
 *   (D) EXPIRED EXPERIMENTS, DELETED (v0.14 flag inventory, 2026-08-31).
 *       The mirror image of (A): these flags' experiments concluded AGAINST
 *       adoption (or were superseded), so their readers, env reads, guarded
 *       branches, and — where the whole module existed only for the flag —
 *       the modules themselves are DELETED. OFF (the recorded production
 *       posture for every one of them) is now unconditional. Listed by name
 *       so a reintroduced env read is visibly a regression, same contract as
 *       the (A) list above; protocolVersionBranch.spec.ts enforces it:
 *         TL_INTERFACE_AUTHORITY (T-L1; Probe-2 adjudication 2026-08-26:
 *           prereg PASS overturned by attribution audit, adoption declined),
 *         TL_POST_READY_TRIM + TL_POST_READY_TRIM_N (W5; Probe-2: silent
 *           null — 1 of 5 resolveFullReadForPath sites wired; retired),
 *         TL_OVERLAP_TRIM (W7; Probe-2: non-discriminating, retired. The
 *           segments[]/code_unchanged projector it shared is UNFLAGGED
 *           general machinery and still serves TL_DELTA_CONTEXT),
 *         TL_ADAPTIVE_WHOLE_FILE (measured 2026-08-14: fails recorded
 *           replay-corpus cases seh1/seh2; never repaired),
 *         TL_VERIFICATION_RECIPE, TL_HOP1_CLOSURE (bench-inconclusive since
 *           the 2026-08-14 freeze; superseded by the unconditional
 *           verification-kit manifest),
 *         TL_EVIDENCE_SHADOW, TL_EVIDENCE_COMPLETION (D7 rollout stalled at
 *           shadow — the paired ablation never ran; superseded by v0.13
 *           proof-carrying completion, and the serving-lever family was
 *           closed by Probe-2. features/task-pack/evidenceShadow.ts deleted
 *           with them),
 *         TL_WRITE_CAPABILITY (D5-era staged-rollout label; telemetry-only,
 *           zero behavioral consumers ever — see
 *           DESIGN-v0.10-write-capability-RFC.md §9),
 *         TL_SCHEMA_DEFS (F-1 $defs/$ref schema compression; the
 *           pre-registered 3-real-client gate never passed and
 *           DESIGN-v0.14-proposal §5 adjudicated the line dead — retirement
 *           stamp executed).
 *       Consolidated the same day (env surface merged, accessors kept):
 *         TL_RRF_PROFILES        -> TL_RRF_FUSION=profiles
 *         TL_COVERAGE_PACKER_V2  -> TL_COVERAGE_PACKER=v2
 *         TL_COMPOUND_RETRIEVAL  -> TL_GRAPH_EVIDENCE=compound
 *
 *   (S) supported v0.14 content policy (default ON, explicit rollback):
 *       TL_LITERAL_FIRST_ROUTING selects source-literal-first task-pack seeds
 *       inside the existing response families. The paired v3 decision run
 *       adopted it as the supported default; exact `0`/`off` remains a v0.14
 *       rollback switch while broader task-shape evidence accumulates.
 *
 *       TL_CONCERN_RECOVERY and TL_JA_QUERY_BRIDGE (USER ruling 2026-09-19,
 *       shipped in v0.14.3): the FP first-pack-precision pair is promoted
 *       from D10(B) experiment to supported policy, default ON. Explicit
 *       `0`/`off` on either restores its pre-FP behaviour byte-for-byte and
 *       remains the rollback path. Both reach only answer-profile task
 *       packs; neither adds a kind, field, or tool argument. See the "FP
 *       addendum" doc block below for the full mechanism.
 *
 *   (B) out-of-contract, experiment-only (default OFF; D10(b)). Turning one on
 *       is an unfrozen capability addition, not a supported posture:
 *       TL_DELTA_CONTEXT,
 *       TL_BATCH_EDIT_FRONTIER (requires the first prepared edit to cover every
 *       ready edit obligation and closes unsanctioned pre-edit discovery),
 *       TL_LEGACY_INPUT (v0.14 migration-only input-dialect escape hatch;
 *       canonical refusal is the default, and only the exact value `accept`
 *       enables the legacy normalizer; canonical calls and response families
 *       are unchanged),
 *       TL_BM25F_CANDIDATE, TL_RRF_FUSION (v0.10 beta.2, V10-08 Hybrid
 *       Retrieval v1 — see features/retrieval/; candidate-generation-stage
 *       only, never read by a known-local dispatch path),
 *       TL_COVERAGE_PACKER (v0.10 beta.2, V10-09: obligation-aware
 *       coverage-per-token candidate selection inside the task pack. It
 *       changes WHICH surfaces a pack serves, not the response SHAPE — no new
 *       kind, field, or tool argument — but "fewer/different surfaces" is
 *       still observable content, so it stays default-OFF and outside the
 *       frozen contract until a decision-scale run adjudicates it),
 *       TL_SEMANTIC_FRONTIER_GUARD (paired-run semantic-frontier treatment;
 *       it reuses existing kinds and fields but changes which continuation
 *       carriers/surfaces ship. It therefore belongs to D10(B), not the
 *       supported-policy bucket. DEFAULT FLIPPED TO OFF (2026-09-02): the
 *       paired paid smoke evidence (smoke-v2/v3) showed no consistent cost
 *       benefit and quality parity between the guard's ON and OFF treatment,
 *       so default-ON was unjustified; opt in with
 *       TL_SEMANTIC_FRONTIER_GUARD=1. Trace still records the effective
 *       treatment for paired billing whichever way it is set),
 *       TL_GRAPH_EVIDENCE (v0.11 wave A, V11-01: the derived graph-evidence /
 *       impact-analysis overlay in features/graph-evidence/. Wave A shipped
 *       that tree as a PURE library with ZERO production importers, so OFF
 *       was byte-identical BY CONSTRUCTION. Wave B (V11-05, below) is the
 *       first production importer — OFF is now byte-identical by ordinary
 *       branch discipline instead: locateTaskContext.ts's compound-retrieval
 *       seam runs only at TL_GRAPH_EVIDENCE=compound (V11-05, the bounded
 *       read-only hop closure in features/compound/ — since the v0.14
 *       consolidation the former TL_COMPOUND_RETRIEVAL pair var is this
 *       flag's "compound" value), which is the only production caller of
 *       features/graph-evidence/ today. V11-06's write/impactGuard.ts
 *       remains a second intended wave-B consumer, not yet wired. Even at
 *       "compound", the module only ever ADDS `related` candidates (never
 *       touches `primary` or reorders/evicts an existing entry) and rides
 *       the existing `ImpactCandidate` shape — no new kind, field, or tool
 *       argument. Default off; holdout/decision-scale adjudication is a
 *       later cycle's job, same posture as every
 *       other v0.11 wave-B retrieval flag here),
 *       TL_REASONING_IR_V2 (v0.11 wave B, V11-04: Task Reasoning IR v2 —
 *       reasoning_delta / obligation DAG / hypothesis tombstones / SHADOW Stop
 *       candidates in task-state/. Its ONE dispatch seam is advisory and
 *       trace-only: no wire kind, no wire field, no tool argument, and the
 *       seam is wrapped so any IR failure degrades to a trace line. With the
 *       flag unset the seam is not entered at all, so the pack bytes are
 *       identical).
 *
 *       v0.15 W-CORE-FLAGS (2026-09-02): the Semantic Frontier v2 program's
 *       ten registered flags -- TL_SF_STATEFUL, TL_SF_DEMOTE,
 *       TL_SF_STRUCTURAL_CONCERNS, TL_SF_RELATION_PACKETS, TL_SF_VERIFY_FIRST,
 *       TL_SF_CONTINUATION_BUNDLE, TL_CWD_NEAR_MISS, TL_RECEIPT_COVERAGE,
 *       TL_BATCH_HINTS, TL_SEARCH_DEDUP -- registered together (all default
 *       OFF) as unfrozen capability additions for a later decision-scale run
 *       to adjudicate. See the "v0.15 W-CORE-FLAGS" doc block further down
 *       this file for which of the ten a production branch actually reads as
 *       of any given commit -- that block, not this one, is required to stay
 *       current with wiring changes.
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
 * Profile weighting is class (B): out-of-contract, default OFF. Since the
 * v0.14 consolidation it is `TL_RRF_FUSION=profiles` (the former
 * TL_RRF_PROFILES pair var is this flag's "profiles" value — profiles always
 * implied fusion, so the pair was one three-valued choice).
 *
 * DESIGN-v0.10-expansion-plan-v1.3.md V11-02 adds task-family-aware RRF
 * fusion weights (features/retrieval/profiles.ts, taskFamily.ts,
 * qualityGate.ts) ON TOP OF the existing V10-08 fusion path. Profile
 * resolution and the weak-retriever quality gate run only at "profiles"
 * (features/retrieval/index.ts's `profilesOn`). At plain "on", every fusion
 * list keeps its pre-V11-02 implicit weight of 1 -- the same output
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
 * Coverage Packer v2 is class (B): out-of-contract, default OFF. Since the
 * v0.14 consolidation it is `TL_COVERAGE_PACKER=v2` (the former
 * TL_COVERAGE_PACKER_V2 pair var is this flag's "v2" value) -- v2 selection
 * (features/task-pack/coveragePackerV2.ts) only ever ran where v1 selection
 * would have (readCodeTaskPack.ts's ONE V10-09 seam, gated on
 * `coveragePackerEnabled()`), so the pair was one three-valued choice. At
 * "v2", the seam calls `coveragePackerV2.ts` instead of `coveragePacker.ts`
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
 * Compound retrieval is class (B): out-of-contract, default OFF. Since the
 * v0.14 consolidation it is `TL_GRAPH_EVIDENCE=compound` (the former
 * TL_COMPOUND_RETRIEVAL pair var is this flag's "compound" value — the seam
 * always required both, so compound-without-graph was inexpressible).
 *
 * DESIGN-v0.10-expansion-plan-v1.3.md V11-05 folds the
 * definition -> references -> representative consumers -> tests/config hop
 * chain into ONE bounded, read-only graph-evidence expansion
 * (features/compound/compoundRetrieval.ts) seeded from the locator's own
 * already-resolved `primary`. The seam in locateTaskContext.ts calls
 * `applyCompoundRetrieval()` only at "compound"; at "on"/"off", `related` is
 * built by exactly the pre-V11-05 code path, byte-identical.
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
 *
 * ---------------------------------------------------------------------------
 * DESIGN-v0.15 exploration-continuation-reliability addendum (2026-09-07)
 * ---------------------------------------------------------------------------
 *
 * Two more D10-classified env reads, both added by this wave and NOT part of
 * the SEMANTIC_FRONTIER_V2_FLAG_REGISTRY ten (neither gates a v0.15 SF
 * treatment arm):
 *
 *   TOKENLIGHTEN_TOOL_SURFACE (server.ts's `resolveToolSurface`, §8.2/R7 Part
 *   B) -- startup-only launcher configuration, resolved ONCE at module
 *   evaluation (same timing/pattern as ALLOW_WRITE) and never re-read for the
 *   life of the process; the public launcher option is the CLI
 *   `--tool-surface` flag, this is its env spelling. Unrecognized values fail
 *   the process closed rather than silently defaulting. It DOES change the
 *   ADVERTISED SURFACE -- a `code`-surface connection sees fewer
 *   schema/dispatch properties (Office/archive/credential inputs withdrawn) --
 *   but that is an explicit, out-of-band operator opt-in at process start,
 *   never a per-request branch a caller's own tool arguments can steer, and
 *   the frozen v1 wire vocabulary/kinds are identical on both surfaces. Not
 *   (B): it adds no unfrozen protocol capability behind a default-OFF
 *   experiment flag: `full` (the default, unset) is exactly today's
 *   surface, and `code` is a reviewed, shipped, narrower surface, not an
 *   experiment. Classified (C)-adjacent: operational/launcher configuration.
 *
 *   TOKENLIGHTEN_TEST_MAX_SEARCH_SNAPSHOT_RECORDS
 *   (state/searchRequestStore.ts's `MAX_SEARCH_SNAPSHOT_RECORDS`, §6.1/R3) --
 *   test-only override (a positive integer) of the R3 search-continuation
 *   snapshot's default 4096-record cap, letting a test reach the
 *   `snapshot_capped`/`snapshot_next_path` recovery path without constructing
 *   thousands of matches. Ignored (falls back to 4096) when unset,
 *   non-numeric, or non-positive; production never sets it. Class (C):
 *   test-harness/diagnostic, never a response-shape branch at the production
 *   default.
 *
 * ---------------------------------------------------------------------------
 * FX-M addendum -- Task-Pack Trim Fairness (2026-09-19)
 * ---------------------------------------------------------------------------
 *
 * Two more D10(B) flags, both scoped to trimToCap's/dedupeTrimAndPersist's
 * byte-budget handling in readCodeTaskPack.ts and both default OFF:
 *
 *   TL_PACK_GUIDE_ELIDE -- a pre-pass in `dedupeTrimAndPersist`, immediately
 *   before `trimToCap` runs, that replaces the INNER contents of a served
 *   agent-guide file's TokenLighten-managed block (AGENTS.md, CLAUDE.md,
 *   CLAUDE.local.md, GEMINI.md, and the per-host rule-file mirrors) with one
 *   marker line, since every host that serves one of these already injects
 *   the SAME block into the model's own instructions -- shipping it again
 *   inside a pack's `code` is pure duplication that starves other
 *   caller-named bodies out of the fixed byte cap. Runs unconditionally over
 *   every eligible surface, cap-pressure or not (the block is redundant
 *   context either way); it never touches `range`, `handle`, or any
 *   coverage/role field.
 *
 *   TL_PACK_FAIR_TRIM -- replaces trimToCap Phase E's "halve every
 *   caller-supplied body every round" ladder (>=2 caller-supplied bodies
 *   case only) with a water-filling pass: it binary-searches the largest
 *   shared per-body byte ceiling under which every body either fits whole
 *   (small bodies) or is cut to the same line-boundary prefix (large
 *   bodies), so a small caller-named file is never ground down alongside a
 *   large one just because they share a cap. Falls through to the untouched
 *   legacy ladder when no ceiling at or above its search floor makes the
 *   pack fit.
 *
 * OFF (the default) for either flag leaves the corresponding code path
 * byte-identical to pre-FX-M output -- wireBaselines.spec.ts and
 * replayCorpus.spec.ts pass without regeneration with both unset. See each
 * accessor's own doc comment below (util/flags.ts, next to
 * compoundRetrievalEnabled) for the exact seam and fallback behavior.
 *
 * ---------------------------------------------------------------------------
 * F5 addendum -- Find Wide Snippet Page (2026-09-19)
 * ---------------------------------------------------------------------------
 *
 * TL_FIND_WIDE_PAGE joins class (B): out-of-contract, default OFF.
 *
 * Widens the explore action=find snippet-section byte cap
 * (features/search/find/findText.ts's fitFilesToCap()/applyRoles() calls,
 * read through the new findResponseCapBytes() accessor -- see that
 * function's own doc comment for the full rationale and every call site it
 * covers, including relatedLookups.ts's and memberSweep.ts's own additive
 * byte-cap checks) from MAX_RESPONSE_BYTES (4096) to
 * FIND_WIDE_PAGE_RESPONSE_BYTES (16384) when ON. The companion whole-response
 * ceiling MAX_INVENTORY_RESPONSE_BYTES (findInventoryCapBytes()) widens by
 * the same delta, to preserve the inventory's own byte headroom -- see that
 * accessor's own doc comment.
 *
 * MOTIVATION (2026-09-19 measured live-session forensics): a 7-file/50-match
 * find result truncated at the 4096-byte cap came back as four separate
 * follow-up calls (3084 B + 1681 B + 1499 B + ...), one full priced model
 * turn per ~1.5-3 KB page -- in one session, six consecutive pages of the
 * SAME search were ~28% of that session's total cost. Measured host pricing
 * makes one extra turn cost about as much as 10-20 KB of new payload, so a
 * 4 KB page sits far below break-even on every host measured.
 *
 * OFF (the default) is byte-identical to pre-F5 output: both accessors
 * return their unchanged pre-flag constants, so replayCorpus.spec.ts and
 * wireBaselines.spec.ts pass without regeneration. ON changes only HOW MANY
 * BYTES of the SAME fields (files[]/roles/matched_terms/hint, then
 * inventory/rollup) ship before truncation kicks in -- same fields, same
 * ordering, same total_files/total_matches honesty either way; no new kind,
 * field, or tool argument.
 *
 * ---------------------------------------------------------------------------
 * FP addendum -- First-Pack Precision (2026-09-19; promoted to (S) supported
 * policy, DEFAULT ON, by USER ruling 2026-09-19 -- shipped in v0.14.3)
 * ---------------------------------------------------------------------------
 *
 * Two flags, both scoped to how a task pack's FIRST candidate set is built
 * from the caller's query. Both reach only answer-profile task packs;
 * neither adds a kind, field, or tool argument. Explicit `0`/`off` on either
 * is the documented rollback path and restores the pre-FP behaviour
 * byte-for-byte:
 *
 *   TL_CONCERN_RECOVERY -- per-concern evidence recovery for multi-concern
 *   queries (features/task-pack/concernRecovery.ts). The explicit-identifier
 *   recovery reads at most three code-shaped identifiers and drops any name
 *   without a unique definition owner, so an enumerated literal list whose
 *   members only ever appear as values produced no surface, and one
 *   identifier's import neighbourhood could take every embed slot. ON
 *   recovers enumerated/backticked literal items by sibling co-occurrence
 *   (the file where several members of the SAME list appear together) and
 *   shares embed slots across concerns.
 *
 *   TL_JA_QUERY_BRIDGE -- Japanese-to-identifier query bridging
 *   (features/retrieval/jaQueryBridge.ts). A Japanese query against an
 *   English codebase shares no lexical token with it, so the first pack can
 *   come back empty. ON expands katakana loanwords and common software-domain
 *   terms into Latin tokens, keeping ONLY expansions that occur in the
 *   workspace's own identifier/path vocabulary.
 *
 * OFF (explicit `0`/`off`) for either flag remains byte-identical to pre-FP
 * output -- the rollback path. Neither adds a kind, field, or tool argument.
 */
import { appendFileSync, statSync } from "node:fs";

/**
 * `wire_effect` CORRECTED 2026-08-28 (A-F6). It read `"none"`, which was false
 * in two ways this flag cannot avoid and must therefore declare:
 *
 *   1. CERTIFICATE IDENTITY. With proof completion ON a discharged ledger
 *      contributes its digest to `deterministicCertificate`, whose id becomes
 *      `ready-<ledger16>-<proof16>` instead of v0.12's `ready-<proof16>`.
 *      `decision.certificate.id` is a wire field, and
 *      `ledgerCertificateBindingValid` discriminates the two shapes by regex,
 *      so the id form is load-bearing rather than cosmetic — it cannot be moved
 *      under the flag without making the binding check unable to tell a
 *      ledger-backed act from a legacy one.
 *   2. DECISION DISTRIBUTION. That is the flag's PURPOSE (A-4..A-7 exist to
 *      stop `act.answer` on an unresolved exhaustive query), so an exhaustive
 *      query legitimately yields a different `decision.kind` ON and OFF.
 *
 * What IS parity, and what the parity spec pins, is the NON-exhaustive task:
 * same decision kind, same certificate shape family, no engagement trace.
 */
export const PROOF_COMPLETION_FLAG_REGISTRY = Object.freeze({
  flag: "TL_PROOF_COMPLETION",
  default: "on",
  off_compatibility: true,
  engagement_trace_env: "TL_PROOF_COMPLETION_TRACE_PATH",
  wire_effect: "decision-distribution+certificate-id-shape",
});

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
 * v0.13 proof-carrying completion is a correctness fence, so it defaults on.
 * OFF remains a short-lived incident escape hatch and an ON/OFF parity seam.
 */
export function proofCompletionEnabled(): boolean {
  return parseBool(process.env["TL_PROOF_COMPLETION"], true);
}

// Process-local diagnostic only.  The counter is deliberately incremented by
// readCodeTaskPack's proof gate, not by flag lookup, so it measures live pack
// decisions and remains zero when the compatibility switch is OFF.
let proofCompletionLiveCounter = 0;

/** P2(b) (2026-08-28): named bound on the opt-in trace file — an untended debug trace must not grow without bound. */
export const PROOF_COMPLETION_TRACE_MAX_BYTES = 10 * 1024 * 1024;

export function noteProofCompletionPack(): number {
  proofCompletionLiveCounter += 1;
  const tracePath = process.env[PROOF_COMPLETION_FLAG_REGISTRY.engagement_trace_env];
  if (typeof tracePath === "string" && tracePath !== "") {
    try {
      // Size cap: skip the append (rather than truncate/rotate, either of
      // which is a heavier decision than a diagnostic side channel should
      // make on the caller's behalf) once the file is already at or past the
      // bound. A missing file statSync-fails, which the catch below already
      // treats as "proceed" for the append that follows.
      let currentSize = 0;
      try { currentSize = statSync(tracePath).size; } catch { /* file does not exist yet */ }
      if (currentSize < PROOF_COMPLETION_TRACE_MAX_BYTES) {
        appendFileSync(tracePath, `${JSON.stringify({ flag: PROOF_COMPLETION_FLAG_REGISTRY.flag, enabled: true, count: proofCompletionLiveCounter })}\n`, "utf8");
      }
    } catch {
      // Diagnostics must never turn a completed proof decision into a refusal.
    }
  }
  return proofCompletionLiveCounter;
}

export function proofCompletionLiveCounterForTest(): number {
  return proofCompletionLiveCounter;
}

export function resetProofCompletionLiveCounterForTest(): void {
  proofCompletionLiveCounter = 0;
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
export function rrfFusionMode(): "off" | "on" | "profiles" {
  const raw = process.env["TL_RRF_FUSION"];
  if (raw?.toLowerCase() === "profiles") return "profiles";
  return parseBool(raw, false) ? "on" : "off";
}

export function rrfFusionEnabled(): boolean {
  return rrfFusionMode() !== "off";
}

/**
 * V11-02 Task-aware Weighted RRF v2: per-task-profile RRF retriever weights
 * (features/retrieval/profiles.ts / taskFamily.ts) plus the weak-retriever
 * quality gate (qualityGate.ts). CONSOLIDATED (v0.14 flag inventory,
 * 2026-08-31): the former TL_RRF_PROFILES env var is folded into
 * `TL_RRF_FUSION=profiles` — profiles always implied fusion (either-off was
 * byte-identical), so the pair was one three-valued choice wearing two env
 * vars. This accessor keeps its name and exact semantics: true iff fusion
 * runs WITH profile weights.
 *
 * D10 (B): out-of-contract; weights are holdout-tuned
 * (bench/workflows/retrieval/TUNING-PROFILES-2026-08-21.md) but not yet
 * adjudicated by a decision-scale run.
 */
export function rrfProfilesEnabled(): boolean {
  return rrfFusionMode() === "profiles";
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
export function coveragePackerMode(): "off" | "v1" | "v2" {
  const raw = process.env["TL_COVERAGE_PACKER"];
  if (raw?.toLowerCase() === "v2") return "v2";
  return parseBool(raw, false) ? "v1" : "off";
}

export function coveragePackerEnabled(): boolean {
  return coveragePackerMode() !== "off";
}

/**
 * V11-03 (Coverage Packer v2, v0.11 wave B). CONSOLIDATED (v0.14 flag
 * inventory, 2026-08-31): the former TL_COVERAGE_PACKER_V2 env var is folded
 * into `TL_COVERAGE_PACKER=v2` — v2 only ever ran where v1 selection would
 * have (the one V10-09 seam), so the pair was one three-valued choice.
 * Accessor name and semantics preserved: true iff the seam routes through
 * coveragePackerV2.ts instead of coveragePacker.ts.
 */
export function coveragePackerV2Enabled(): boolean {
  return coveragePackerMode() === "v2";
}

/** v0.14 supported literal-first policy; explicit OFF is the rollback path. */
export function literalFirstRoutingEnabled(): boolean {
  return parseBool(process.env["TL_LITERAL_FIRST_ROUTING"], true);
}

/**
 * D10(B) paired-run treatment. It never changes advertised protocol kinds,
 * but it can change response content by suppressing optional carriers; keep
 * it explicitly trace-classified rather than treating it as supported policy.
 *
 * Default OFF (2026-09-02): paired paid evidence (smoke-v2/v3) showed no
 * consistent cost benefit and quality parity, so default-ON was unjustified.
 * Opt in with TL_SEMANTIC_FRONTIER_GUARD=1; the unset default and explicit
 * `0`/`off` are byte-identical.
 */
export function semanticFrontierGuardEnabled(): boolean {
  return parseBool(process.env["TL_SEMANTIC_FRONTIER_GUARD"], false);
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
  if (bm25fCandidateEnabled()) active.push("TL_BM25F_CANDIDATE");
  // Consolidated tri-state flags report their exact env assignment so a trace
  // diff distinguishes the base capability from its folded-in extension.
  const rrf = rrfFusionMode();
  if (rrf !== "off") active.push(rrf === "profiles" ? "TL_RRF_FUSION=profiles" : "TL_RRF_FUSION");
  const packer = coveragePackerMode();
  if (packer !== "off") active.push(packer === "v2" ? "TL_COVERAGE_PACKER=v2" : "TL_COVERAGE_PACKER");
  const graph = graphEvidenceMode();
  if (graph !== "off") active.push(graph === "compound" ? "TL_GRAPH_EVIDENCE=compound" : "TL_GRAPH_EVIDENCE");
  if (fastPathV2Enabled()) active.push("TL_FAST_PATH_V2");
  if (deltaContextEnabled()) active.push("TL_DELTA_CONTEXT");
  if (batchEditFrontierEnabled()) active.push("TL_BATCH_EDIT_FRONTIER");
  // FX-L strict frontier writes (user ruling 2026-09-14). Default OFF, so a
  // stock session's `flags_active` is byte-identical to before this flag.
  if (frontierStrictWritesEnabled()) active.push("TL_FRONTIER_STRICT_WRITES");
  // Default OFF since 2026-09-02 (paired paid evidence showed no consistent
  // cost benefit). It remains a D10(B) treatment because its carrier
  // selection is observable content.
  if (semanticFrontierGuardEnabled()) active.push("TL_SEMANTIC_FRONTIER_GUARD");
  // FX-M (2026-09-19): task-pack trim fairness pair. Both default OFF; see
  // this file's "FX-M addendum" doc block above.
  if (packGuideElideEnabled()) active.push("TL_PACK_GUIDE_ELIDE");
  if (packFairTrimEnabled()) active.push("TL_PACK_FAIR_TRIM");
  // F5 (2026-09-19): find wide snippet page. Default OFF; see this file's
  // "F5 addendum" doc block above.
  if (findWidePageEnabled()) active.push("TL_FIND_WIDE_PAGE");
  // Turn economy (2026-09-20): the per-host umbrella and each member policy
  // it governs. Both default OFF, so a stock session's `flags_active` is
  // byte-identical to before them; a member is reported whenever it is
  // effectively on, whether by its own override or by the umbrella.
  if (turnEconomyEnabled()) active.push("TL_TURN_ECONOMY");
  if (seededGenerousEnabled()) active.push("TL_SEEDED_GENEROUS");
  if (identifierGroundingEnabled()) active.push("TL_IDENTIFIER_GROUNDING");
  if (answerLineGutterEnabled()) active.push("TL_ANSWER_LINE_GUTTER");
  if (namedTargetResolutionEnabled()) active.push("TL_NAMED_TARGET_RESOLUTION");
  if (foldSmallRemainderEnabled()) active.push("TL_FOLD_SMALL_REMAINDER");
  if (callerExpansionEnabled()) active.push("TL_CALLER_EXPANSION");
  if (reserveSmallWindowsEnabled()) active.push("TL_RESERVE_SMALL_WINDOWS");
  // WP-V1 (2026-09-20): lean vscode-only calls/schemas -- reported whenever
  // effectively on (own override or the umbrella); a non-"vscode" client
  // still reports this the same way `activeExperimentFlags` reports every
  // other member, since this trace is about the FLAG'S value, not about
  // whether the current call happens to be vscode-scoped.
  if (leanCallsEnabled()) active.push("TL_LEAN_CALLS");
  // v0.15 W-CORE-FLAGS: Semantic Frontier v2 program flags -- registration
  // only today (no production branch reads them yet, see their own doc
  // blocks above); reported here for trace-inventory parity with every
  // other (B) flag while wiring is pending.
  if (sfStatefulEnabled()) active.push("TL_SF_STATEFUL");
  if (sfDemoteEnabled()) active.push("TL_SF_DEMOTE");
  if (sfStructuralConcernsEnabled()) active.push("TL_SF_STRUCTURAL_CONCERNS");
  if (sfRelationPacketsEnabled()) active.push("TL_SF_RELATION_PACKETS");
  if (sfVerifyFirstEnabled()) active.push("TL_SF_VERIFY_FIRST");
  if (sfContinuationBundleEnabled()) active.push("TL_SF_CONTINUATION_BUNDLE");
  if (cwdNearMissEnabled()) active.push("TL_CWD_NEAR_MISS");
  if (receiptCoverageEnabled()) active.push("TL_RECEIPT_COVERAGE");
  if (batchHintsEnabled()) active.push("TL_BATCH_HINTS");
  if (searchDedupEnabled()) active.push("TL_SEARCH_DEDUP");
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
 * importer; OFF is now byte-identical by the ordinary flag branch at
 * locateTaskContext.ts's compound-retrieval seam, which runs only at this
 * flag's "compound" mode.
 */
export function graphEvidenceMode(): "off" | "on" | "compound" {
  const raw = process.env["TL_GRAPH_EVIDENCE"];
  if (raw?.toLowerCase() === "compound") return "compound";
  return parseBool(raw, false) ? "on" : "off";
}

export function graphEvidenceEnabled(): boolean {
  return graphEvidenceMode() !== "off";
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
 * B2 / V12-02 (2026-08-27): DELTA CONTEXT — carry the served-range ledger
 * ACROSS this server's own edits.
 *
 * WHAT OFF GUARANTEES. The served-range ledger is keyed by content sha
 * (`ServedRangeLedgerState.fileSha`), so a write of any kind invalidates every
 * entry for that path: the next read of the edited file re-serves the whole
 * body even though only a few lines moved. OFF keeps exactly that — the ledger
 * transformation at the `writeExistingFileAtomic` seam is the ONLY writer of
 * `deltaFromSha`, and every delta-serving branch is additionally gated on that
 * marker being present. No transformation, no marker, no branch: a full
 * edit-then-read sequence is byte-identical to the pre-B2 tree
 * (`deltaContextDispatch.spec.ts`'s parity cell pins this on the wire).
 *
 * WHAT ON CHANGES. After an edit THIS SERVER applied, the ledger's spans are
 * re-projected through the hunk actually written (derived from the before/after
 * BYTES, never from replaying the caller's search strings): spans above the
 * change keep their lines, spans below shift by the line delta, and the changed
 * region itself is dropped. A later read of the same file then serves only the
 * residual windows as bodies and names the rest `prior` — the same
 * `segments[]`/`code_unchanged` projection TL_OVERLAP_TRIM already uses, which
 * this flag reuses without altering it.
 *
 * Deliberately SEPARATE from TL_OVERLAP_TRIM (retired default-OFF, Probe-2):
 * that lever trims a partially overlapping read of an UNCHANGED file; this one
 * makes the ledger survive a change. Neither implies the other, and no branch
 * added here fires on TL_OVERLAP_TRIM alone.
 */
export function deltaContextEnabled(): boolean {
  return parseBool(process.env["TL_DELTA_CONTEXT"], false);
}

/** Experimental one-shot boundary for multi-target prepared edits. */
export function batchEditFrontierEnabled(): boolean {
  return parseBool(process.env["TL_BATCH_EDIT_FRONTIER"], false);
}

/**
 * D10 (B): FX-L STRICT FRONTIER WRITES (user ruling 2026-09-14,
 * review-findings-6 SHOULD-FIX 38). Default OFF.
 *
 * OFF — the ruling's default behaviour: an `edit_file` whose target the LATEST
 * certified decision did not authorize still APPLIES, and the `edit.applied`
 * response discloses the fact through `EditReclassification.frontier_status`
 * (`state/session.ts`'s `certifiedFrontierMarkerFor`). FX-L is untouched: the
 * hard fence still admits exactly the bytes this session served this epoch.
 *
 * ON — the same condition REFUSES the whole batch with `frontier-read-only`,
 * `retry:"new-task"` and an executable re-pack `next`. This is the one
 * direction FX-L's ruling (r) says this file may never move in by default
 * ("the gate refuses a handle this server itself served"), which is exactly
 * why it is a flag and not a behaviour change: an operator who wants
 * explain-only enforcement at dispatch opts in, and the T09/T10 regression
 * class stays closed for everyone else.
 *
 * Class (B), not (C): it selects response SHAPE (an `edit.applied` with a
 * receipt vs. a `refusal`), so it is reported by `activeExperimentFlags`
 * below like every other (B) treatment.
 */
export function frontierStrictWritesEnabled(): boolean {
  return parseBool(process.env["TL_FRONTIER_STRICT_WRITES"], false);
}

/**
 * D10 (B): V11-05's compound retrieval (v0.11 wave B). CONSOLIDATED (v0.14
 * flag inventory, 2026-08-31): the former TL_COMPOUND_RETRIEVAL env var is
 * folded into `TL_GRAPH_EVIDENCE=compound` — the seam always required BOTH
 * flags, so compound-without-graph was inexpressible and the pair was one
 * three-valued choice. Accessor name and semantics preserved: true iff the
 * locateTaskContext.ts seam may call applyCompoundRetrieval() (which still
 * implies graphEvidenceEnabled()).
 */
export function compoundRetrievalEnabled(): boolean {
  return graphEvidenceMode() === "compound";
}

/**
 * FX-M (2026-09-19), D10 (B): out-of-contract, default OFF. See this file's
 * "FX-M addendum" doc block above for the full rationale.
 *
 * ON: `dedupeTrimAndPersist` (readCodeTaskPack.ts) elides the INNER contents
 * of a served agent-guide file's TokenLighten-managed block (between the
 * sentinel comment lines) to one marker line before `trimToCap` ever runs,
 * stamping `content_completeness:"partial"` + the elided absolute line span
 * in `remaining_ranges`. The sentinel lines themselves, and any content
 * outside them, are untouched; a file whose basename/path is not on the
 * fixed agent-guide list is never considered, even if it happens to embed
 * the same sentinel text.
 *
 * OFF (the default): the pre-pass never runs, so a served guide file's body
 * is byte-identical to pre-FX-M output.
 */
export function packGuideElideEnabled(): boolean {
  // Turn economy (2026-09-20): presence-first member of the per-host umbrella,
  // same shape as `seededGenerousEnabled()` — the member's own variable wins in
  // either direction when set; unset follows `TL_TURN_ECONOMY` (default OFF,
  // so a stock server is byte-identical).
  const raw = process.env["TL_PACK_GUIDE_ELIDE"];
  if (raw !== undefined) return parseBool(raw, false);
  return turnEconomyEnabled();
}

/**
 * FX-M (2026-09-19), D10 (B): out-of-contract, default OFF. See this file's
 * "FX-M addendum" doc block above for the full rationale.
 *
 * ON: `trimToCap`'s Phase E (readCodeTaskPack.ts), when it already has >= 2
 * caller-supplied (explicitly named) bodies to balance, tries a
 * water-filling pass BEFORE the legacy "halve every body every round"
 * ladder: binary-search the largest shared per-body byte ceiling at which
 * every body either survives whole (at/under the ceiling) or is cut to a
 * shared line-boundary prefix (over the ceiling), verified against the
 * pack's real byte cap and backed off geometrically to correct for
 * `capForResult`'s non-monotonic (step-function) behavior. On success the
 * trimmed pack is returned immediately, same early-return shape as the
 * legacy loop. On failure (no per-body ceiling at or above the search floor
 * makes the pack fit) every touched body is restored to its original bytes
 * and the UNMODIFIED legacy halving loop runs exactly as it would with this
 * flag off.
 *
 * OFF (the default): Phase E's caller-supplied-body handling is the exact
 * pre-FX-M legacy code path, byte-identical.
 */
export function packFairTrimEnabled(): boolean {
  // Turn economy (2026-09-20): presence-first member of the per-host umbrella
  // (see `packGuideElideEnabled()` above). Measured on a recorded Copilot call
  // (query + 8 caller-named files, `budget.bytes:30000`): the legacy Phase E
  // halving cut EVERY body to its first half and used 20.5 KB of the 30 KB the
  // caller allowed, so the model re-requested all eight remainders; the
  // water-filling trim serves the small files whole and spends the budget.
  const raw = process.env["TL_PACK_FAIR_TRIM"];
  if (raw !== undefined) return parseBool(raw, false);
  return turnEconomyEnabled();
}

/**
 * F5 (2026-09-19), D10 (B): out-of-contract, default OFF. See this file's
 * "F5 addendum" doc block above for the full rationale.
 *
 * ON: `features/search/find/findText.ts`'s `findResponseCapBytes()` (the
 * explore action=find snippet-section cap) and `findInventoryCapBytes()`
 * (the companion whole-response-with-inventory ceiling) both widen — see
 * each accessor's own doc comment for the exact bytes.
 *
 * OFF (the default): both accessors return their pre-flag constants
 * unchanged, so the find response family is byte-identical to pre-F5
 * output.
 *
 * 2026-09-20 addendum: joined the TL_TURN_ECONOMY umbrella as a member,
 * with exactly the override semantics `seededGenerousEnabled` documents —
 * its own TL_FIND_WIDE_PAGE variable wins outright whenever it is set
 * (including explicit "0"); only an UNSET variable falls back to
 * `turnEconomyEnabled()`. Unset both and this reads exactly as before.
 */
export function findWidePageEnabled(): boolean {
  const raw = process.env["TL_FIND_WIDE_PAGE"];
  if (raw !== undefined) return parseBool(raw, false);
  return turnEconomyEnabled();
}

/**
 * FP (2026-09-19), (S) supported first-pack policy: DEFAULT ON by USER
 * ruling 2026-09-19, shipped in v0.14.3. See this file's "FP addendum" doc
 * block above for the full rationale.
 *
 * ON (the default): a task pack's answer-evidence stage additionally runs
 * features/task-pack/concernRecovery.ts -- enumerated/backticked literal
 * items of the query are located by fixed-string scan and resolved by sibling
 * co-occurrence, and embed slots are shared across the query's concerns so a
 * single identifier's import neighbourhood cannot take all of them. Reaches
 * only answer-profile task packs; adds no kind, field, or tool argument.
 *
 * OFF (explicit `0`/`off`): the stage is never entered; packs are
 * byte-identical to pre-FP output -- the rollback path, restoring pre-FP
 * behaviour byte-for-byte.
 */
export function concernRecoveryEnabled(): boolean {
  return parseBool(process.env["TL_CONCERN_RECOVERY"], true);
}

/**
 * FP (2026-09-19), (S) supported first-pack policy: DEFAULT ON by USER
 * ruling 2026-09-19, shipped in v0.14.3. See this file's "FP addendum" doc
 * block above for the full rationale.
 *
 * ON (the default): query tokenisation additionally runs
 * features/retrieval/jaQueryBridge.ts -- katakana loanwords and common
 * software-domain Japanese terms are expanded into Latin tokens, and only
 * expansions present in the workspace's own identifier/path vocabulary are
 * kept. Expansions are weak lexical tokens, never explicit identifiers.
 * Reaches only answer-profile task packs; adds no kind, field, or tool
 * argument.
 *
 * OFF (explicit `0`/`off`): the bridge is never consulted; query tokens are
 * byte-identical to pre-FP output -- the rollback path, restoring pre-FP
 * behaviour byte-for-byte.
 */
export function jaQueryBridgeEnabled(): boolean {
  return parseBool(process.env["TL_JA_QUERY_BRIDGE"], true);
}

/**
 * TL_TASK_HANDLE_RECOVERY (2026-09-19), (S) supported policy — DEFAULT ON;
 * explicit "0"/"off" is the rollback path, restoring today's behaviour
 * byte-for-byte. `read_file`/`search_files` only; `edit_file` keeps strict
 * authentication always (see server.ts's `recoverAuthFailedTaskHandle`,
 * never wired into the edit_file dispatch arm).
 *
 * ON (the default): when a presented `task.handle` fails authentication,
 * server.ts's `recoverAuthFailedTaskHandle` tries, in order, (0) a live
 * handle of this (workspace, lane) that the presented string merely extends
 * by a few trailing characters (`isTailExtendedHandle` - the authentic token
 * is all there), (a) the SAME call's own `qref` bound to exactly one live
 * handle of this (workspace, lane), then (b) exactly one live lane lineage
 * handle that is a `state/laneTaskHandles.ts` `isMidSplicedHandle` match for
 * the presented string. On a match the call proceeds as if that recovered handle had been
 * presented — same task, same wire `task.id` on the way out — instead of
 * refusing `handle-unknown`. Two or more qualifying candidates is ambiguous
 * and recovers nothing. Adds no kind, field, or tool argument: an
 * already-defined refusal turns into an already-defined success on the SAME
 * schema, nothing new ships either way.
 *
 * OFF (explicit "0"): `recoverAuthFailedTaskHandle` returns immediately;
 * every call reaches `taskHandleRefusal` exactly as it does today.
 */
export function taskHandleRecoveryEnabled(): boolean {
  return parseBool(process.env["TL_TASK_HANDLE_RECOVERY"], true);
}

/**
 * TL_TURN_ECONOMY (2026-09-20), DEFAULT OFF — the per-host opt-in written by
 * `tl workspace setup` into the VS Code MCP entry; enables the turn-economy
 * serving policies as a set.
 *
 * WHY AN UMBRELLA, AND WHY OFF: these policies trade served BYTES for model
 * TURNS, and the exchange rate is a property of the HOST, not of the server —
 * one extra turn prices at roughly 9-14 KB of source on the hosts measured,
 * but the Claude Code paired bench must not move against v0.14.0 (USER ruling
 * 2026-09-20). So the whole family stays off by default on every host and is
 * switched on for the hosts where it pays, by setup, through this one
 * variable, rather than by each policy flag being flipped independently.
 *
 * Each member flag keeps its OWN env var as an explicit per-policy override:
 * set it to "0"/"1" and that value wins outright; leave it unset and the
 * member follows this umbrella. Unset both and the server is byte-identical
 * to pre-turn-economy output.
 */
export function turnEconomyEnabled(): boolean {
  return parseBool(process.env["TL_TURN_ECONOMY"], false);
}

/**
 * WP-S2 (2026-09-20), turn-economy policy — DEFAULT OFF, and a member of the
 * TL_TURN_ECONOMY umbrella above: an explicit `TL_SEEDED_GENEROUS` value
 * (either "0"/"off" or "1"/"on") always wins; unset, this flag follows
 * `turnEconomyEnabled()`. With neither variable set the seeded/anchor paths
 * are byte-identical to pre-WP-S2 output. Scoped to `readCodeTaskPack.ts`'s
 * SEEDED pack (`buildSeededTaskPack` — a `read_file {query, targets:[{path},…]}`
 * where the CALLER named the files) and to `selectAnchorFocus`'s member
 * ranking.
 *
 * MOTIVATION (measured 2026-09-20, live GitHub Copilot sessions): cost on
 * every host is dominated by model TURNS — one extra turn prices at roughly
 * 9-14 KB of served source — so a pack that under-serves a file the caller
 * NAMED is more expensive than one that serves it whole. A named file whose
 * RAW size exceeded MAX_SURFACE_CODE_BYTES was re-pointed at its single best
 * anchor symbol; on an 18 KB service class that shipped the 754-byte
 * CONSTRUCTOR and certified `act.answer`, and the same query with NO targets
 * served the whole class — naming the files made the pack worse.
 *
 * ON, four changes, all on the caller-NAMED seed path:
 *   1. the whole-file "fits" decision is taken on the size the surface would
 *      really EMBED (after the same doc-comment elision the embed applies),
 *      not on raw bytes;
 *   2. on an `answer` (read-only) profile a named file with no caller
 *      range/symbol is served WHOLE up to SEEDED_ANSWER_SURFACE_CODE_BYTES,
 *      water-filled smallest-first across the named set, and a seeded answer
 *      pack naming >= 2 files may reach the existing 32 KB budget tier.
 *      `generic` keeps today's 12,288-byte per-surface allowance;
 *   3. a named file that still does not fit serves up to four distinct,
 *      non-overlapping query-ranked symbol windows (answer profile) instead
 *      of one, with `remaining_ranges` partitioned across them exactly once;
 *   4. when the top-scoring anchor symbol is the file's own enclosing TYPE
 *      and it does not fit, the members are re-ranked on the query tokens
 *      MINUS that type's name tokens, with light whole-word inflection
 *      tolerance on the name match (all profiles).
 *
 * OFF (the default, and explicit "0"/"off"): every one of those branches is
 * skipped and the seeded/anchor paths are byte-identical to pre-WP-S2 output.
 * Adds no kind, field, or tool argument — only WHICH bytes of the existing
 * `code`/`remaining_ranges`/`range` fields a named file's surface carries.
 */
export function seededGenerousEnabled(): boolean {
  // The member's own variable is an OVERRIDE, so it is read for PRESENCE
  // first: `parseBool(raw, turnEconomyEnabled())` would make an unparseable
  // value silently inherit the umbrella instead of meaning what the operator
  // wrote, and `parseBool(raw, false)` alone would make "unset" mean "off"
  // even under the umbrella.
  const raw = process.env["TL_SEEDED_GENEROUS"];
  if (raw !== undefined) return parseBool(raw, false);
  return turnEconomyEnabled();
}

/**
 * WP-S5 (2026-09-20), turn-economy policy — DEFAULT OFF, and a member of the
 * TL_TURN_ECONOMY umbrella above with exactly the override semantics
 * `seededGenerousEnabled` documents. With neither variable set the readiness
 * obligations a pack mints are byte-identical to pre-WP-S5 output. Scoped to
 * `readCodeTaskPack.ts`'s `buildReadinessObligations` explicit-identifier loop.
 *
 * MOTIVATION (measured 2026-09-20, the recommended `query: <verbatim request>`
 * shape): a request that names its own PRODUCT ("このリポジトリ(ShopFlow)で…")
 * mints `identifier:ShopFlow` as a BLOCKING obligation, because the word is
 * PascalCase and that is all the shape oracle can see. No symbol in the
 * workspace is named `ShopFlow` (only neighbours such as `ShopFlowApiClient`),
 * so the pack's own prescribed `next` — `search_files find ["ShopFlow"]` — is a
 * call the server can predict will find nothing useful: following it returned
 * fuzzy symbol hits and a re-pack that served an unrelated file and REGRESSED
 * the decision. Two model turns bought a worse task state. A stop-list
 * (`PROSE_ACRONYMS`) closes vocabulary words like API/JSON/URL; it cannot
 * generalize to product, repository, or brand names.
 *
 * SCOPE (widened 2026-09-20, second live Copilot session): this flag now
 * carries ONE rule in three places — AN OBLIGATION MUST BE GROUNDED IN CODE
 * SHAPE, and the server never prescribes a call whose own execution it can
 * predict is useless.
 *   (1) identifiers, below;
 *   (2) ENUMERATED AND REQUEST ITEMS. A list item or clause blocks a pack only
 *       when the caller wrote it as code (backticked/quoted, an uppercase
 *       letter after the first character, a digit, `_`, `.`, `/`, `::`, `#`,
 *       `(`, or an ALL-CAPS token). `PAID, CANCELLED` and `order.quantity`
 *       keep their obligations; "inventory restoration", "line numbers" and
 *       "read-only" become ranking hints only. A clause that constrains the
 *       ANSWER'S FORM or the AGENT'S BEHAVIOUR ("need exact file paths and
 *       line numbers", "read-only, do not edit", "簡潔に", "変更しないで") asks
 *       nothing about the repository and mints no request item at all.
 *   (3) TOKENLIGHTEN'S OWN MANAGED GUIDE TEXT. A scan hit inside the managed
 *       block of an agents-md target (AGENTS.md, CLAUDE.md, GEMINI.md,
 *       .github/copilot-instructions.md, the Copilot explore-agent file, the
 *       per-host rule mirrors) is not a discovery candidate: the host already
 *       gave the model that text. Detection is the FX-M path list plus the
 *       `<!-- tokenlighten:mcp-instructions:start -->` sentinel, so only the
 *       BLOCK's lines are unmatchable and a guide file that also carries the
 *       project's own guidance stays a first-class candidate. A point whose
 *       only occurrences were in a block is closed as "not repository
 *       evidence" — never as a verified absence, since the word does occur.
 *
 * Measured, second session (VS Code Copilot, umbrella on): three prose
 * `enumerated-item:` obligations plus a `request-item` for "do not edit." held
 * a complete pack at `discover`, and its `next` re-packed the same query
 * against TL's own three guide files. The model ran it verbatim: one wasted
 * turn, junk evidence.
 *
 * ON, for identifiers: a query word becomes a blocking `identifier:<name>`
 * obligation only when it is GROUNDED — backticked, qualified (`A.b`, `A::b`,
 * `A#b`), call-shaped (`name(`), snake_case/`$`-bearing, or carrying at least
 * one whole-word, definition-shaped occurrence in a source file of the
 * workspace. A bare camelCase/PascalCase word that fails all of those over a
 * COMPLETE workspace walk mints no obligation, so no `find` is prescribed for
 * it and the decision follows from the remaining obligations. Anything the
 * grounding scan cannot decide (an incomplete walk, an unreadable workspace)
 * keeps today's behaviour, fail-closed.
 *
 * OFF (the default, and explicit "0"/"off"): the grounding check is never
 * consulted and every identifier the shape oracle admits mints its obligation
 * exactly as before. Adds no kind, field, or tool argument — only WHICH
 * obligations (and therefore which `decision.kind`/`next`) a pack derives.
 */
export function identifierGroundingEnabled(): boolean {
  // Same PRESENCE-first read as `seededGenerousEnabled` above, for the same
  // reason: the member's own variable is an override, not a defaulted value.
  const raw = process.env["TL_IDENTIFIER_GROUNDING"];
  if (raw !== undefined) return parseBool(raw, false);
  return turnEconomyEnabled();
}

/**
 * WP-S4 (2026-09-20), turn-economy policy — DEFAULT OFF, and a member of the
 * TL_TURN_ECONOMY umbrella above with exactly the override semantics
 * `seededGenerousEnabled`/`identifierGroundingEnabled` document: an explicit
 * `TL_ANSWER_LINE_GUTTER` value (either "0"/"off" or "1"/"on") always wins;
 * unset, this flag follows `turnEconomyEnabled()`. With neither variable set
 * the read family's served bodies are byte-identical to pre-WP-S4 output.
 * Scoped to one seam in `protocol/envelope.ts`'s `finalizeProtocolResponse` —
 * immediately before `emit.ts`'s `emitFinalizedPayload` measures the payload
 * — which calls the pure renderer in `protocol/lineGutter.ts`.
 *
 * MOTIVATION (measured 2026-09-19, recorded GitHub Copilot sessions): TL
 * evidence carries a `range` such as "256-308" plus a body whose multi-line
 * doc comments are collapsed by `elideDocCommentsWithWindows`
 * (util/formatCompress.ts) into a single marker line naming the elided span,
 * so the true source line of a statement inside the body cannot be counted
 * off the wire (a method actually starting at file line 274 is unreachable by
 * counting from a body that opens at line 256). The model issued serial
 * `search_files find` calls on exact code text purely to learn line numbers
 * — 3 extra model turns in one session, 1 in another — and a turn prices at
 * roughly the same as 9-14 KB of served bytes on every host measured, so
 * serving the numbers in-band is strictly cheaper than the native escape.
 *
 * ON, for CODE evidence only (a path whose language `elideDocCommentsWithWindows`
 * actually renders — see `protocol/lineGutter.ts`'s own allowlist; Markdown,
 * plain text, config, Office and archive evidence are untouched) inside an
 * ANSWER-profile response (`read.task_pack` with `profile:"answer"`, or a
 * `read.text`/`read.batch` whose OWN call args declare `task.profile:"answer"`
 * — never a `generic`/change task, whose bodies must stay copy-exact for
 * `edit_file` search/replace): each body line gains a source-line-number
 * gutter, re-derived from the renderer per ruling (aa) (never by re-parsing
 * marker-shaped text) and applied ONLY when the served body is byte-equal to
 * `elideDocCommentsWithWindows`'s own rendering of that path+range, or a
 * whole-line prefix of it (a cap-cut body). Anything else — comments kept, a
 * trimmed middle, a synthetic outline, a stale file — ships un-numbered.
 *
 * OFF (the default, and explicit "0"/"off"): `protocol/lineGutter.ts`'s
 * transform is never invoked and every read-family body is byte-identical to
 * pre-WP-S4 output. Adds no kind, field, or tool argument — only WHICH BYTES
 * of an existing `evidence[].body` / `entries[].content` a numbered line
 * carries.
 */
export function answerLineGutterEnabled(): boolean {
  // Same PRESENCE-first read as `seededGenerousEnabled`/
  // `identifierGroundingEnabled` above, for the same reason: the member's own
  // variable is an override, not a defaulted value.
  const raw = process.env["TL_ANSWER_LINE_GUTTER"];
  if (raw !== undefined) return parseBool(raw, false);
  return turnEconomyEnabled();
}

/**
 * WP-S8 (2026-09-20), turn-economy policy — DEFAULT OFF, and a member of the
 * TL_TURN_ECONOMY umbrella above with exactly the override semantics
 * `seededGenerousEnabled`/`identifierGroundingEnabled` document: an explicit
 * `TL_NAMED_TARGET_RESOLUTION` value (either "0"/"off" or "1"/"on") always
 * wins; unset, this flag follows `turnEconomyEnabled()`. With neither
 * variable set a seeded pack's surfaces and `missing` are byte-identical to
 * pre-WP-S8 output. Scoped to `buildSeededTaskPack`
 * (features/task-pack/readCodeTaskPack.ts) — nothing else reads it.
 *
 * MOTIVATION (recorded GitHub Copilot session 2026-09-20): the model's FIRST
 * call named ten `targets`, each with a `purpose`. Three were file paths it
 * had GUESSED the folder for (`frontend/order.js` where `frontend/js/order.js`
 * exists) and three were DIRECTORIES. The pack served the four paths that
 * happened to be exact, reported the three guesses as `missing`, and drew
 * NOTHING out of the three directories — including the service directory
 * holding the three classes the question was about. The model spent two more
 * turns (three parallel `find`s, then a second pack) recovering what it had
 * already named, and a turn prices at roughly 9-14 KB of served bytes on
 * every host measured.
 *
 * ON, for a seeded pack only:
 *   - a caller-named FILE path that does not exist resolves to the workspace's
 *     UNIQUE same-basename file (preferring, when several exist, the unique
 *     one under the named path's own parent subtree) and is then seeded
 *     exactly as if the caller had spelled it, its `why` carrying a
 *     `resolved-from:<named path>` marker; ambiguity, an existing path, a
 *     range/symbol the resolved file cannot honor, and anything outside the
 *     workspace or ignored all stay unresolved and reported as today;
 *   - a caller-named DIRECTORY contributes locate evidence, on the FIRST pack
 *     of an ANSWER task only (never a `qref` replay, never a change pack —
 *     readiness and obligations are untouched), through the same per-clause
 *     locate recovery `concernRecovery.ts` already runs for the answer path,
 *     driven by that target's own `purpose` text and confined to the
 *     directory. Additions are strictly additive after the caller-named file
 *     surfaces and bounded per directory and in total.
 *
 * OFF (the default, and explicit "0"/"off"): neither branch is entered. Adds
 * no kind, field, or tool argument — only WHICH surfaces an existing seeded
 * pack carries and which named paths its existing `missing` reports.
 */
export function namedTargetResolutionEnabled(): boolean {
  // Same PRESENCE-first read as `seededGenerousEnabled`/
  // `identifierGroundingEnabled` above, for the same reason: the member's own
  // variable is an override, not a defaulted value.
  const raw = process.env["TL_NAMED_TARGET_RESOLUTION"];
  if (raw !== undefined) return parseBool(raw, false);
  return turnEconomyEnabled();
}

/**
 * WP-S7 (2026-09-20), turn-economy policy — DEFAULT OFF, and a member of the
 * TL_TURN_ECONOMY umbrella above with exactly the override semantics
 * `seededGenerousEnabled`/`identifierGroundingEnabled`/`answerLineGutterEnabled`/
 * `namedTargetResolutionEnabled` document: an explicit `TL_FOLD_SMALL_REMAINDER`
 * value (either "0"/"off" or "1"/"on") always wins; unset, this flag follows
 * `turnEconomyEnabled()`. With neither variable set a pack's surfaces and
 * `remaining_ranges` are byte-identical to pre-WP-S7 output. Scoped to
 * `readCodeTaskPack.ts`'s `dedupeTrimAndPersist` — the single choke point
 * every pack builder (`buildTaskPack`, `buildSeededTaskPack`, `buildPartialPack`,
 * `buildDiffTaskPack`) already funnels through — via the `applyFoldSmallRemainder`
 * pass, run once over the FULL surface list before `trimToCap` and therefore
 * before the served-range ledger books what shipped.
 *
 * MOTIVATION (measured 2026-09-20, live GitHub Copilot session, turn-economy
 * umbrella on): an answer pack served a class from its declaration line and
 * listed the file's own head as `remaining` — e.g. `OrderService.java:27-420
 * remaining:["1-26"]` — a package line, imports and a blank line nobody asked
 * about. The model then spent a WHOLE extra turn
 * (`read_file {targets:[{handle,range:"1-14"}]}`) fetching the 14 import lines
 * it needed; one extra turn prices at roughly 9-14 KB of served source on
 * every host measured, so withholding ~400 bytes nobody needed cost far more
 * than it saved, and the standing `remaining` entry is itself a standing
 * invitation to zoom.
 *
 * ON: when a CODE file (never Markdown, never an artifact surface) is
 * represented in the pack by exactly ONE surface, no other surface names the
 * same path, that surface carries embedded `code`, its `remaining_ranges`
 * total 40 lines or fewer whose own elided embed is 2,048 bytes or fewer, and
 * the surface is neither a caller-explicit range
 * (`sfWithholdingMarks.ts`'s `isCallerRangeSurface`) nor one the semantic
 * frontier already withheld a body from (`wasSemanticFrontierBodyWithheld`) —
 * the surface is widened to the whole file (`1-<lastLine>`), rendered through
 * the exact same `centeredSliceForCap`/`sliceCode` whole-file path a
 * fits-the-cap serve already uses (same doc-comment elision), and
 * `remaining_ranges` is dropped. The widen is REJECTED, leaving the surface
 * exactly as it was, when the whole body would not fit the per-surface cap or
 * would push the pack past its own byte budget (`fitsInCap`) — checked
 * directly, never left for `trimToCap` to discover after the fact. Applies to
 * every profile and to both the answer path's symbol/identifier-focused
 * surfaces and the seeded path's anchor-focus windows — the economics do not
 * depend on whether the task is read-only.
 *
 * OFF (the default, and explicit "0"/"off"): `applyFoldSmallRemainder` returns
 * immediately and every pack is byte-identical to pre-WP-S7 output. Adds no
 * kind, field, or tool argument — only WHICH bytes of the existing
 * `code`/`range`/`remaining_ranges` fields a surface carries.
 */
export function foldSmallRemainderEnabled(): boolean {
  // Same PRESENCE-first read as `seededGenerousEnabled`/
  // `identifierGroundingEnabled`/`answerLineGutterEnabled`/
  // `namedTargetResolutionEnabled` above, for the same reason: the member's
  // own variable is an override, not a defaulted value.
  const raw = process.env["TL_FOLD_SMALL_REMAINDER"];
  if (raw !== undefined) return parseBool(raw, false);
  return turnEconomyEnabled();
}

/**
 * WP-S9 (2026-09-20), turn-economy policy — DEFAULT OFF, and a member of the
 * TL_TURN_ECONOMY umbrella above with exactly the override semantics
 * `seededGenerousEnabled`/`identifierGroundingEnabled` document: an explicit
 * `TL_CALLER_EXPANSION` value (either "0"/"off" or "1"/"on") always wins;
 * unset, this flag follows `turnEconomyEnabled()`. With neither variable set
 * an answer pack's surfaces are byte-identical to pre-WP-S9 output. Scoped to
 * `readCodeTaskPack.ts`'s `buildAnswerTaskPack` — the FIRST pack of an answer
 * task only (never a `qref` replay, exactly like the concern recovery it
 * merges through) — and the pure helpers in
 * `features/task-pack/callerExpansion.ts`.
 *
 * MOTIVATION (measured 2026-09-20, live GitHub Copilot session, umbrella on):
 * a query asking where order cancellation ENTERS the system ("the cancellation
 * API endpoint, the OrderService cancellation method, the PaymentService
 * refund method, where OrderStatus is defined") got a pack carrying the
 * service class, the enum and the refund method — and not the HTTP handler
 * that calls `orderService.cancel(id)`. The clause's own words ("API",
 * "endpoint", "route", "entry point") do not occur in that file at all, so
 * LEXICAL location cannot reach it however wide the search: a caller is a
 * STRUCTURAL relation. The pack still certified `act.answer`, and the model
 * spent three more turns (one `find` for the member name and two ranged reads)
 * walking the one call edge the server already had every ingredient to walk —
 * 1,303 mAIU against the 986 mAIU the same question cost when the model
 * happened to name the controller file itself. "Who calls this / where does
 * the request enter" is among the most common trace questions.
 *
 * ON, for the first answer pack only, AFTER the normal selection: up to two
 * FOCAL MEMBERS are read off the evidence already selected (a surface focused
 * on a method, or the method(s) of a served TYPE that the query names under
 * the same inflection-tolerant match the anchor scorer uses). Call sites of
 * those members OUTSIDE their own file, within the pack's own scope, are
 * admitted only when the occurrence is CALL-shaped and its receiver is
 * compatible with the focal type (the receiver's normalized form equals or
 * ends with the type's name, or the file names the type independently);
 * comments, strings, declarations and test files are excluded. The enclosing
 * function of at most the best two — at most 4,096 embedded bytes — is folded
 * in through the SAME additive merge (`mergeConcernAdditions`) with a ZERO
 * displacement budget, so a selected surface is never replaced, reordered or
 * dropped. No compatible call site adds nothing: the mechanism abstains rather
 * than guessing, and readiness/obligation logic is untouched (the addition is
 * evidence, not an obligation).
 *
 * OFF (the default, and explicit "0"/"off"): the hook returns before any scan
 * and every answer pack is byte-identical to pre-WP-S9 output. Adds no kind,
 * field, or tool argument — only WHICH surfaces an existing pack carries.
 */
export function callerExpansionEnabled(): boolean {
  // Same PRESENCE-first read as `seededGenerousEnabled`/
  // `identifierGroundingEnabled`/`foldSmallRemainderEnabled` above, for the
  // same reason: the member's own variable is an override, not a defaulted
  // value.
  const raw = process.env["TL_CALLER_EXPANSION"];
  if (raw !== undefined) return parseBool(raw, false);
  return turnEconomyEnabled();
}

/**
 * WP-S10 (2026-09-20), turn-economy policy — DEFAULT OFF, and a member of the
 * TL_TURN_ECONOMY umbrella above with exactly the override semantics
 * `seededGenerousEnabled`/`identifierGroundingEnabled`/`foldSmallRemainderEnabled`/
 * `callerExpansionEnabled` document: an explicit `TL_RESERVE_SMALL_WINDOWS`
 * value (either "0"/"off" or "1"/"on") always wins; unset, this flag follows
 * `turnEconomyEnabled()`. With neither variable set, `read_file`'s dedupe
 * receipts are byte-identical to pre-WP-S10 output. Scoped to ONE seam in
 * `server.ts`'s `read_file` dispatch, immediately before the S1-A1 qref-repack
 * reprojection: when this flag is on, the call addresses one or more explicit
 * line windows (a single target's `range`/`ranges`/`symbol`, or a
 * `paths[]`/`handles[]` batch whose every entry does, by path or handle, with
 * or without `qref`), and the TOTAL requested size is small (their lines sum
 * to at most 120 AND their raw bytes to at most 4,096, measured against live
 * file content), `args["force_serve"]` is set to `true` for the rest of this
 * call — the SAME flat field `task.force_serve:true` maps onto, so every
 * downstream dedupe door (the S1-A1 reprojection guard, the prepared-fence
 * `executionGuard`/`guardExecutionDiscovery` short-circuit, the A7
 * handles=[] batch loop, and the ordinary mode=slice/symbol served-range
 * ledger) sees the SAME effective value a genuine `force_serve:true` call
 * would have set, and serves real bytes exactly as that call does.
 *
 * MOTIVATION (measured live GitHub Copilot sessions, 2026-09-19 and
 * 2026-09-20): before answering, the model often re-reads a few exact ranges
 * it already holds ("verification read"). TokenLighten answered an
 * already-served range with a body-less receipt (`read.receipt`,
 * `code-unchanged`/`decision-unchanged`), and the model then repeated the
 * SAME call with `task.force_serve:true` to get the bytes — recorded: a
 * 2-range, ~1.2 KB re-ask receipted at 487 B, then cost a whole extra turn to
 * recover. One model turn costs as much as ~9-14 KB of served bytes on every
 * host measured, so refusing to re-send 1.2 KB is the expensive choice: the
 * receipt saves ~300 tokens and costs a whole turn.
 *
 * OFF (the default, and explicit "0"/"off"): this seam is never consulted and
 * `args["force_serve"]` keeps whatever value the caller itself sent — every
 * dedupe door serves today's exact byte-for-byte receipt. Adds no kind,
 * field, or tool argument — only WHETHER a small, already-served, unchanged
 * window ships as a receipt or as the SAME bytes a caller's own
 * `task.force_serve:true` would have gotten. A whole-file re-read
 * (`mode:"full"`), an archive/artifact/Office read, and a task-pack re-issue
 * naming no explicit window at all (a bare `{qref}`, or the identical query
 * re-sent) are out of this seam's scope by construction — see server.ts's
 * `collectSmallWindowTargets` for the exact eligibility rule.
 */
export function reserveSmallWindowsEnabled(): boolean {
  // Same PRESENCE-first read as `seededGenerousEnabled`/
  // `identifierGroundingEnabled`/`foldSmallRemainderEnabled`/
  // `callerExpansionEnabled` above, for the same reason: the member's own
  // variable is an override, not a defaulted value.
  const raw = process.env["TL_RESERVE_SMALL_WINDOWS"];
  if (raw !== undefined) return parseBool(raw, false);
  return turnEconomyEnabled();
}

/**
 * WP-V1 (2026-09-20), turn-economy policy — DEFAULT OFF, and a member of the
 * TL_TURN_ECONOMY umbrella above with exactly the override semantics
 * `seededGenerousEnabled` documents. Unlike the other members, this one is
 * further scoped to the resolved client profile "vscode" (GitHub Copilot
 * Chat — see codec/clientProfile.ts's `resolveClientProfile`); every other
 * client is unaffected regardless of this flag's value.
 *
 * ON, and the resolved client is "vscode": `protocol/envelope.ts`'s
 * `canonicalToolCall` omits `cwd` from an emitted read_file/search_files
 * continuation when it targets the same workspace the triggering call is
 * already resolved against (VS Code launches one server per single
 * workspace root, so that call's own workspace IS the server's root), and
 * omits `task.handle` when the continuation already carries a `qref` (which
 * binds the task on its own) or is a plain targets-only read/search that
 * needs no task continuity to be served. A cursor continuation,
 * `task.pull:"closure"`, a challenge, or `task.expected_state_version`
 * still keep the handle explicit — each genuinely needs it.
 * `edit_file` continuations are unchanged: write safety keeps `cwd`/
 * `task.handle` explicit always. `server.ts`'s `advertisedTools()`
 * additionally sheds read_file's `budget.bytes`/`budget.tokens`, each
 * tool's top-level `oneOf`/`anyOf`, `task`'s `dependentRequired` and every
 * nested property description from the advertised schema for that same
 * vscode+flag case (`targets[].purpose` STAYS advertised, described as a
 * directory-target field: it is what the directory-confined recovery of a
 * seeded pack locates with) — Copilot's own schema validator
 * rejects `oneOf`/`anyOf`/`dependentRequired` outright, and the server
 * enforces every one of these constraints at dispatch regardless of what is
 * advertised, so nothing served becomes stricter or looser than today.
 *
 * OFF (the default), or any other client: every emitted call and every
 * advertised schema is byte-identical to pre-WP-V1 output.
 */
export function leanCallsEnabled(): boolean {
  // Same PRESENCE-first read as `seededGenerousEnabled`/
  // `reserveSmallWindowsEnabled` above, for the same reason: the member's
  // own variable is an override, not a defaulted value.
  const raw = process.env["TL_LEAN_CALLS"];
  if (raw !== undefined) return parseBool(raw, false);
  return turnEconomyEnabled();
}

// ---------------------------------------------------------------------------
// v0.15 W-CORE-FLAGS: Semantic Frontier v2 program flags (2026-09-02)
// ---------------------------------------------------------------------------
//
// The Semantic Frontier v2 program registers ten flags here, ALL DEFAULT OFF,
// per D10(B): each is an unfrozen capability addition for a later
// decision-scale run to adjudicate, not supported policy. Registration
// happened first; wiring is landing incrementally across waves, so "no
// production branch reads it" is NOT true of every one of the ten below --
// keep this paragraph current in the SAME commit that wires (or unwires) an
// accessor (protocolVersionBranch.spec.ts's F1 fix depends on this file and
// that spec's CLASSIFIED_ENV staying in sync, not on this prose, but stale
// prose here is still a lie the next reader inherits):
//
//   WIRED (a production branch reads the accessor, as of 2026-09-03):
//   sfStatefulEnabled / sfStructuralConcernsEnabled
//   (features/task-pack/readCodeTaskPack.ts, the task-state SF adapter,
//   features/task-pack/sfConcerns.ts), cwdNearMissEnabled /
//   receiptCoverageEnabled / batchHintsEnabled (server.ts, plus
//   protocol/readFamily.ts and protocol/coverageReceipt.ts for
//   receiptCoverageEnabled specifically), searchDedupEnabled
//   (protocol/searchFamily.ts, state/session.ts, protocol/envelope.ts), and
//   sfVerifyFirstEnabled (round-11 fix, 2026-09-03 — this doc block was
//   stale: the accessor already had two real production readers before this
//   correction, it was simply never moved out of the list below):
//   protocol/readFamily.ts's `verifyClosureGate`/`receiptOf`'s
//   `closure-complete` arm (gates whether a `read.closure` may claim `done`),
//   and features/task-pack/sfVerifyObligations.ts's `deriveVerifyObligations`
//   via readCodeTaskPack.ts's `buildTaskChangeContract` (attaches
//   `TaskChangeContract.verify_obligations` only while the flag is on), and
//   sfDemoteEnabled (third-inertness-layer fix, 2026-09-03 — this doc block
//   was stale: canonicalDecision.ts/decisionWire.ts/envelope.ts already read
//   it, but nothing ever populated the continuation-optional marking those
//   branches demote FROM unless the mutually-exclusive legacy guard was also
//   on, making the accessor's own reads inert whenever it was the only lever
//   enabled): features/task-pack/semanticFrontier.ts's
//   `annotateSemanticFrontierContinuation` now also gates open on this flag
//   (previously gated solely on the legacy `guardEnabled` parameter).
//   FOURTH inertness layer (FX-H, 2026-09-03): even after the third fix the
//   reads stayed byte-inert because canonicalDecision.ts's eligibility gate
//   refused every surface that still carried `code` — i.e. every body the
//   budget had not already shed — so the flag could only reorder rows. Now
//   only `code_unchanged` disqualifies (D4 "already held" is proven by the
//   per-address served-range ledger), `applySemanticFrontierDemotion`
//   withholds the body on the surface itself (never the last body in the
//   pack), and the served-range booking is deferred under this flag so a
//   withheld window is never booked as `prior`.
//
//   sfRelationPacketsEnabled (wave-4 relation seam, features/task-pack/
//   sfRelationSeam.ts via readCodeTaskPack.ts): compiles a bounded relation
//   packet into `plan.wiring.evidence_graph` for grounded relational concerns;
//   requires graph evidence (see the consistency check below).
//   sfContinuationBundleEnabled (wave-4 structural continuation seam,
//   features/task-pack/sfContinuationBundle.ts via readCodeTaskPack.ts):
//   appends bodyless structural fills (counterpart header/impl, declaration,
//   named test) to `evidence[]` only in slack left by explicit targets and
//   unsatisfied concerns (DC2). Neither has a "registration only" exemption
//   any more: both are pinned by the flag-off byte-identity corpus like every
//   other lever above.
//
// `assertSemanticFrontierV2FlagConsistency` below encodes the program's
// documented cross-flag dependencies in one place so a later wiring wave
// inherits the check instead of re-deriving the rules per call site.

/** v0.15 (B): carries frontier state across turns within a task epoch. */
export function sfStatefulEnabled(): boolean {
  return parseBool(process.env["TL_SF_STATEFUL"], false);
}

/** v0.15 (B): demotes stale frontier entries instead of discarding them outright. Requires TL_SF_STATEFUL. */
export function sfDemoteEnabled(): boolean {
  return parseBool(process.env["TL_SF_DEMOTE"], false);
}

/** v0.15 (B): surfaces structural (non-textual) concerns in the served frontier. */
export function sfStructuralConcernsEnabled(): boolean {
  return parseBool(process.env["TL_SF_STRUCTURAL_CONCERNS"], false);
}

/** v0.15 (B): packages graph-evidence relations as discrete frontier packets. Requires graph evidence not disabled. */
export function sfRelationPacketsEnabled(): boolean {
  return parseBool(process.env["TL_SF_RELATION_PACKETS"], false);
}

/**
 * v0.15 (B): orders verification obligations ahead of new discovery.
 * Requires TL_SF_STATEFUL — VF-11 (round-11, 2026-09-03): unlike the other
 * "Requires TL_SF_STATEFUL" flags below, this one is WIRED into production
 * reads (see the WIRED list above) that run on every request, not just at
 * server boot. `assertSemanticFrontierV2FlagConsistency` below still throws
 * at boot for an inconsistent operator configuration, but a per-call reader
 * must never throw mid-request — so this accessor ALSO enforces the
 * dependency itself, gracefully: the effective value silently drops to
 * `false` (verify-first gate never engages) when TL_SF_STATEFUL is off,
 * whatever TL_SF_VERIFY_FIRST says. That degraded effective value is what
 * `activeExperimentFlags()` reports for paired-billing trace purposes too
 * (mirroring the "trace still records the effective treatment" convention
 * documented above for TL_SEMANTIC_FRONTIER_GUARD) — the trace never shows
 * TL_SF_VERIFY_FIRST active while its dependency is unmet.
 */
export function sfVerifyFirstEnabled(): boolean {
  if (!parseBool(process.env["TL_SF_VERIFY_FIRST"], false)) return false;
  return sfStatefulEnabled();
}

/** v0.15 (B): bundles continuation state for a resumed frontier session. Requires TL_SF_STATEFUL. */
export function sfContinuationBundleEnabled(): boolean {
  return parseBool(process.env["TL_SF_CONTINUATION_BUNDLE"], false);
}

/** v0.15 (B): suggests near-miss cwd candidates on a worktree-root refusal. */
export function cwdNearMissEnabled(): boolean {
  return parseBool(process.env["TL_CWD_NEAR_MISS"], false);
}

/** v0.15 (B): adds coverage accounting to read receipts. */
export function receiptCoverageEnabled(): boolean {
  return parseBool(process.env["TL_RECEIPT_COVERAGE"], false);
}

/** v0.15 (B): adds batching hints to multi-target read/edit responses. */
export function batchHintsEnabled(): boolean {
  return parseBool(process.env["TL_BATCH_HINTS"], false);
}

/** v0.15 (B): deduplicates near-identical search matches before serving. */
export function searchDedupEnabled(): boolean {
  return parseBool(process.env["TL_SEARCH_DEDUP"], false);
}

/**
 * Registry of the ten v0.15 Semantic Frontier v2 flags, one-line purpose
 * each. Frozen so a later wave cannot silently mutate the inventory; extend
 * by adding a new entry (and a matching accessor) in the same commit that
 * introduces the flag, same discipline as PROOF_COMPLETION_FLAG_REGISTRY.
 */
export const SEMANTIC_FRONTIER_V2_FLAG_REGISTRY = Object.freeze({
  TL_SF_STATEFUL: "Carries frontier state across turns within a task epoch.",
  TL_SF_DEMOTE: "Withholds supporting frontier bodies (bodyless rows with remaining + handle) instead of dropping them; requires TL_SF_STATEFUL, and (FX-R3b) TL_SF_STRUCTURAL_CONCERNS — after FX-R3 D4 the marking source is the grounded structural concern state, so TL_SF_DEMOTE without it is fully inert.",
  TL_SF_STRUCTURAL_CONCERNS: "Surfaces structural (non-textual) concerns in the served frontier. Requires TL_SF_STATEFUL — the only production caller (readCodeTaskPack.ts's applySemanticFrontierState) returns before ever reaching the extractor when TL_SF_STATEFUL is off, so this flag alone is a silent no-op, not trace-only.",
  TL_SF_RELATION_PACKETS: "Packages graph-evidence relations as discrete frontier packets. Requires TL_SF_STATEFUL for the same reason as TL_SF_STRUCTURAL_CONCERNS above (applySemanticFrontierState gates the seam), in addition to requiring graph evidence not disabled (see the consistency check below).",
  TL_SF_VERIFY_FIRST: "Orders verification obligations ahead of new discovery.",
  TL_SF_CONTINUATION_BUNDLE: "Bundles continuation state for a resumed frontier session.",
  TL_CWD_NEAR_MISS: "Suggests near-miss cwd candidates on a worktree-root refusal.",
  TL_RECEIPT_COVERAGE: "Adds coverage accounting to read receipts.",
  TL_BATCH_HINTS: "Adds batching hints to multi-target read/edit responses.",
  TL_SEARCH_DEDUP: "Deduplicates near-identical search matches before serving.",
} as const);

/**
 * Reads every registry flag through its own accessor, so `TRUE`, `on` and
 * `1` all fold to the same answer. That is NOT the same claim for every
 * entry, though: the registry's "Requires TL_SF_STATEFUL" wording on several
 * flags (TL_SF_DEMOTE, TL_SF_STRUCTURAL_CONCERNS, TL_SF_RELATION_PACKETS,
 * TL_SF_CONTINUATION_BUNDLE) describes a startup-time CONSISTENCY CHECK
 * (`assertSemanticFrontierV2FlagConsistency` below) and/or a downstream
 * production gate — their own accessors do not read `TL_SF_STATEFUL` and
 * return the RAW env bit exactly as set. `sfVerifyFirstEnabled()` is the
 * ONLY accessor of the ten that actually degrades: it reads `false` whenever
 * `TL_SF_STATEFUL` is off even if `TL_SF_VERIFY_FIRST` itself is "1" — the one
 * case where "the value production actually uses" differs from the raw bit.
 * `semanticFrontierV2FlagValues()` below, and the `config_sha256` digest it
 * feeds, therefore fold nine raw bits and one STATEFUL-degraded bit — never
 * ten degraded values. This is a documentation fix only: no accessor's
 * behaviour changes, so the digest does not move.
 *
 * FX-R3 D5 (2026-09-04): `util/trace.ts`'s p1 causal `config_sha256` listed
 * only TL_GRAPH_INDEX / TL_SEMANTIC_FRONTIER_GUARD / TL_TRACE, so a v2
 * TREATMENT server (all ten of these on) and a CONTROL server (all off)
 * produced the SAME configuration digest — the causal attestation could not
 * tell the paid A/B arms apart. The digest now folds in this table.
 *
 * TYPE-ENFORCED COMPLETENESS: the accessor map is keyed by
 * `keyof typeof SEMANTIC_FRONTIER_V2_FLAG_REGISTRY`, so adding a flag to the
 * registry without adding its accessor here fails `tsc`, and the iteration
 * below walks the REGISTRY — never a hand-copied list that could drift.
 */
const SEMANTIC_FRONTIER_V2_FLAG_ACCESSORS: Readonly<
  Record<keyof typeof SEMANTIC_FRONTIER_V2_FLAG_REGISTRY, () => boolean>
> = {
  TL_SF_STATEFUL: sfStatefulEnabled,
  TL_SF_DEMOTE: sfDemoteEnabled,
  TL_SF_STRUCTURAL_CONCERNS: sfStructuralConcernsEnabled,
  TL_SF_RELATION_PACKETS: sfRelationPacketsEnabled,
  TL_SF_VERIFY_FIRST: sfVerifyFirstEnabled,
  TL_SF_CONTINUATION_BUNDLE: sfContinuationBundleEnabled,
  TL_CWD_NEAR_MISS: cwdNearMissEnabled,
  TL_RECEIPT_COVERAGE: receiptCoverageEnabled,
  TL_BATCH_HINTS: batchHintsEnabled,
  TL_SEARCH_DEDUP: searchDedupEnabled,
};

/** `[env var, "1"|"0"]` for every v0.15 registry flag, in registry order. */
export function semanticFrontierV2FlagValues(): ReadonlyArray<readonly [string, string]> {
  return (Object.keys(SEMANTIC_FRONTIER_V2_FLAG_REGISTRY) as Array<
    keyof typeof SEMANTIC_FRONTIER_V2_FLAG_REGISTRY
  >).map((key) => [key, SEMANTIC_FRONTIER_V2_FLAG_ACCESSORS[key]() ? "1" : "0"] as const);
}

/**
 * v0.15 startup-time (and test-time) consistency check over the
 * SEMANTIC_FRONTIER_V2_FLAG_REGISTRY dependencies. Called from
 * `server.ts`'s startup path (see that file's own call site) — this is no
 * longer a test-only export waiting on a future wiring wave; a
 * misconfigured operator gets a loud boot-time failure today. Throws an
 * Error naming BOTH flags on the first violation found; a caller that wants
 * every violation reported at once should catch, fix, and re-invoke, since
 * later checks are never reached once an earlier one throws.
 */
export function assertSemanticFrontierV2FlagConsistency(): void {
  if (sfDemoteEnabled() && !sfStatefulEnabled()) {
    throw new Error(
      "TL_SF_DEMOTE requires TL_SF_STATEFUL: TL_SF_DEMOTE is enabled but TL_SF_STATEFUL is not.",
    );
  }
  if (sfDemoteEnabled() && semanticFrontierGuardEnabled()) {
    throw new Error(
      "TL_SF_DEMOTE and TL_SEMANTIC_FRONTIER_GUARD are mutually exclusive: both are enabled.",
    );
  }
  // FX-R3b item 2 (2026-09-04): after FX-R3 D4 the v2 marking source is the
  // pack's GROUNDED STRUCTURAL CONCERN state and nothing else — "zero grounded
  // structural concerns => mark nothing" is the ratified contract
  // (`annotateSemanticFrontierContinuation`, semanticFrontier.ts). With
  // TL_SF_STRUCTURAL_CONCERNS off, `extractStructuralConcerns` returns `[]` as
  // its FIRST statement, so there is no grounded source, nothing is ever
  // marked continuation-optional, and TL_SF_DEMOTE is FULLY INERT — the same
  // silent-no-op class as TL_SF_STRUCTURAL_CONCERNS-without-TL_SF_STATEFUL
  // caught just below. Fail closed at boot rather than let an operator (or a
  // paid arm) believe the lever is on.
  if (sfDemoteEnabled() && !sfStructuralConcernsEnabled()) {
    throw new Error(
      "TL_SF_DEMOTE requires TL_SF_STRUCTURAL_CONCERNS: TL_SF_DEMOTE is enabled but TL_SF_STRUCTURAL_CONCERNS is not (after FX-R3 D4 the demotion marking source is the grounded structural concern state, so TL_SF_DEMOTE alone marks nothing).",
    );
  }
  // FX-G-B (round 12, finding 3): `readCodeTaskPack.ts`'s
  // `applySemanticFrontierState` is the ONLY production caller of both the
  // structural-concern extractor and the relation-packet seam, and it opens
  // with `if (!sfStatefulEnabled()) return;` — before either is ever
  // reached. So TL_SF_STRUCTURAL_CONCERNS or TL_SF_RELATION_PACKETS enabled
  // alone (without TL_SF_STATEFUL) boots clean today and is a TOTAL no-op:
  // not the "trace only" degradation the v0.15 plan's §7 used to document
  // (that prose has been corrected — see DESIGN-v0.15-semantic-frontier-
  // plan.md §7 and §5.1.1), no trace, no concern, nothing. Catch it here,
  // the same way TL_SF_DEMOTE/TL_SF_CONTINUATION_BUNDLE/TL_SF_VERIFY_FIRST
  // already catch their own STATEFUL dependency below.
  if (sfStructuralConcernsEnabled() && !sfStatefulEnabled()) {
    throw new Error(
      "TL_SF_STRUCTURAL_CONCERNS requires TL_SF_STATEFUL: TL_SF_STRUCTURAL_CONCERNS is enabled but TL_SF_STATEFUL is not (readCodeTaskPack.ts's applySemanticFrontierState never reaches the extractor otherwise).",
    );
  }
  if (sfRelationPacketsEnabled() && !sfStatefulEnabled()) {
    throw new Error(
      "TL_SF_RELATION_PACKETS requires TL_SF_STATEFUL: TL_SF_RELATION_PACKETS is enabled but TL_SF_STATEFUL is not (readCodeTaskPack.ts's applySemanticFrontierState never reaches the relation seam otherwise).",
    );
  }
  if (sfRelationPacketsEnabled() && !graphEvidenceEnabled()) {
    throw new Error(
      "TL_SF_RELATION_PACKETS requires TL_GRAPH_EVIDENCE not to be disabled: TL_SF_RELATION_PACKETS is enabled but graph evidence is off.",
    );
  }
  if (sfContinuationBundleEnabled() && !sfStatefulEnabled()) {
    throw new Error(
      "TL_SF_CONTINUATION_BUNDLE requires TL_SF_STATEFUL: TL_SF_CONTINUATION_BUNDLE is enabled but TL_SF_STATEFUL is not.",
    );
  }
  // NOTE: `sfVerifyFirstEnabled()` itself already folds in the
  // `sfStatefulEnabled()` check (VF-11) and silently degrades to `false`
  // rather than ever throwing mid-request — so it can never observe this
  // inconsistency to report it. This boot-time check reads the RAW env var
  // instead, specifically so a misconfigured operator still gets a loud
  // failure at startup rather than a silent no-op.
  if (parseBool(process.env["TL_SF_VERIFY_FIRST"], false) && !sfStatefulEnabled()) {
    throw new Error(
      "TL_SF_VERIFY_FIRST requires TL_SF_STATEFUL: TL_SF_VERIFY_FIRST is enabled but TL_SF_STATEFUL is not.",
    );
  }
}
