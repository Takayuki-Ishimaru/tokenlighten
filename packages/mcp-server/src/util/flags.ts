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
 * Test harness: TL_TEST_SESSION_RESET enables the private session-reset RPC.
 * Only with that gate, TL_TEST_SESSION_CWD supplies a logical launch cwd while
 * the pooled process stays in a stable physical directory on Windows. These
 * are operational test controls; normal launches ignore the logical cwd and
 * expose no reset RPC or changed tool-response shape.
 * Host budget: MAX_MCP_OUTPUT_TOKENS lowers Claude's output ceiling; it does
 * not select a protocol version, schema, or response representation.
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
 *       TL_LEAN_SCHEMA (v0.15.0, USER ruling after the pre-registered
 *       3-real-client gate passed 2026-09-30): the all-client advertised-schema
 *       diet -- `tools/list` no longer carries each tool's top-level
 *       `oneOf`/`anyOf` or `task.dependentRequired` -- is promoted from a
 *       default-OFF experiment to supported policy, default ON.
 *       Explicit `0`/`off` restores the full pre-v0.15.0 schema byte-for-byte
 *       and remains the rollback path. Advertising-only: dispatch enforces
 *       every one of those constraints regardless of what is advertised, and
 *       nothing adds a kind, field, or tool argument. See `leanSchemaEnabled`'s
 *       doc block below for the gate's three results.
 *
 *       TL_PACK_CONTAINMENT_DEDUP (2026-10-19, after the v0.16.0 decision runs
 *       6t-2 and 6t-3; see `packContainmentDedupEnabled`'s doc block for the
 *       evidence): a task-pack row whose lines and text another row of the
 *       same file in the pack already carries ships once, default ON for
 *       every client. Explicit `0`/`off` restores today's pack byte-for-byte
 *       and remains the rollback path. It adds no kind, field, or tool
 *       argument: a cut appended window is a row that does not ship, and a
 *       contained surface carries the existing `code_unchanged` pointer
 *       (`prior` on the wire).
 *
 *       TL_EFF_TOLERANT_INPUT (USER ruling 2026-10-01, after the paired
 *       efficiency A/B in bench/workflows/experiments/2026-10-01-efficiency-ideas):
 *       unambiguous near-miss inputs that used to refuse are served instead,
 *       default ON. Explicit `0`/`off` restores every refusal byte-for-byte
 *       and remains the rollback path. It adds no kind, field, or tool
 *       argument; each rewrite is one the refusal's own `retry: call` named.
 *       The wider find cap that rode it in the experiment stayed a (B) flag,
 *       TL_EFF_WIDE_FIND, because the guide documented `>5 queries` as a
 *       refusal, until it too was promoted on 2026-10-18 with the guide's
 *       cap moved to `>10` (see `effWideFindEnabled`).
 *
 *       TL_EFF_SLIM_EDIT (USER ruling 2026-10-01, same A/B; the T13 verified
 *       gap was traced to the verifier's static tracer, not to this flag --
 *       behaviourally both arms were 3/6): `edit.applied` ships its `after`
 *       window as the changed lines ±3 and its verification kit without
 *       inline bodies, default ON. Explicit `0`/`off` restores the ±20 /
 *       enclosing-symbol window and inline kit bodies byte-for-byte and
 *       remains the rollback path. It adds no kind, field, or tool argument:
 *       a body-less kit entry is the existing `omitted` label with the kit's
 *       existing batched `next_call`.
 *
 *       TL_EFF_FIND_PHRASE (promoted 2026-10-18, after the v0.16.0 Sonnet
 *       decision run bench/workflows/runs/2026-10-18-v016-decision-6t-1; see
 *       `effFindPhraseEnabled`'s doc block for the evidence): a `find` whose
 *       queries all match nothing, at least one of them a phrase, is re-run
 *       once on the identifier-like tokens inside them, default ON. Explicit
 *       `0`/`off` restores the all-miss reply and its absence certificate
 *       byte-for-byte and remains the rollback path. It adds no kind, field,
 *       or tool argument: a hit is the existing `search.matches` find reply
 *       for those tokens, disclosed in the same `normalized` note
 *       TL_EFF_TOLERANT_INPUT uses.
 *
 *       TL_EFF_EDIT_DIET (2026-10-19, after the v0.16.0 decision run
 *       bench/workflows/runs/2026-10-18-v016-decision-6t-3; see
 *       `effEditDietEnabled`'s doc block for the evidence): the `edit.applied`
 *       reply diet, default ON for the CLI coding hosts only (Claude Code,
 *       Copilot CLI, Codex CLI — server.ts passes the host classification, the
 *       TL_PORTABLE_TOOLS precedent). Explicit `0`/`off` restores today's
 *       reply for every client and remains the rollback path; explicit `1`
 *       turns it on for every client. It adds no kind, field, or tool
 *       argument: an echo window is the existing absent `after`, a kit delta
 *       is the existing kit with fewer entries and its one `note`, and the
 *       omitted batched read is the existing optional `next_call`.
 *
 *       TL_EFF_FIND_SNIPPET_CAP (2026-10-19, after the v0.16.0 decision run
 *       bench/workflows/runs/2026-10-18-v016-decision-6t-3; see
 *       `effFindSnippetCapEnabled`'s doc block for the evidence): a `find`
 *       matching more than ten files keeps `snippets` only for the ten files
 *       with the most matched lines, default ON for every client. Every file
 *       still lists all of its `lines`, and the match set's completeness
 *       (`total_*`, `truncated`/`limit`, `inventory`, `term_results`,
 *       `absence`) is unchanged. Explicit `0`/`off` restores the uncapped
 *       reply byte-for-byte and remains the rollback path. It adds one
 *       optional find-form field, `snippet_cap` (the cap, the number of files
 *       left with lines only, the `scope` that narrows the find to show
 *       them), and no kind or tool argument.
 *
 *       TL_EFF_AUTOFOLLOW (2026-10-19, after the v0.16.0 decision run
 *       bench/workflows/runs/2026-10-19-v016-decision-6t-4, whose T03 arm A
 *       median was $0.585 against arm B's $0.502; see `effAutofollowEnabled`'s
 *       doc block for the rules and the evidence): a `discover` task pack
 *       whose one `next` re-issues the caller's own request is followed
 *       server-side and answered as one reply, and so, since decision run
 *       6t-6, is a follow-up that is itself such a pack reading more windows
 *       of the files it serves, while the reply stays within 45,056 B;
 *       default ON for every client. Explicit `0`/`off` restores the discover
 *       reply and its `next` byte-for-byte and remains the rollback path. It
 *       adds one optional task-pack field, `auto_followed` (`from`, `note`,
 *       the discover packs' own `gaps`, and `hops` when follow-ups chained),
 *       and no kind or tool argument.
 *
 *       TL_EFF_STRUCTURE_MAP (2026-10-20, after the v0.16.0 decision run
 *       bench/workflows/runs/2026-10-20-v016-decision-6t-7, whose T03 arm A
 *       cost $1.72 against arm B's $1.71; see `effStructureMapEnabled`'s doc
 *       block for the rule and the evidence): a short, map-shaped answer
 *       request about a type too large for one surface, naming a flow over
 *       its concerns, is served the type's structure map in one `act.answer`
 *       — its doc comment, its header, every member's signature and every
 *       statement that calls a named concern, the enum types its header is
 *       declared in beside it — while the member bodies stay owed; default
 *       ON for every client. Under a pack ceiling below the Copilot CLI's
 *       18,432 B (2026-10-24: VS Code's 14,336 B) the map is served only when
 *       its first page holds the whole skeleton, the header's code and every
 *       member's signature. Explicit `0`/`off` restores the whole-member
 *       flow requirement and its discover chain byte-for-byte and remains the
 *       rollback path. It adds no field, kind or tool argument.
 *
 *       TL_EFF_FLOW_ORDER_VOCAB (2026-10-25): additional EN/JA phrasings for
 *       the call-order facet detector and its subject extraction, default ON.
 *       Explicit `0` restores the prior detector within the existing response
 *       families; it adds no kind, field, or tool argument. The phrasing and
 *       subject rules are pinned by the structure-map entry/facet held-outs.
 *
 *       TL_EFF_REPLY_COMPACT (2026-10-23, codex-copilot-proxy wire audit,
 *       bench/workflows/experiments/2026-10-21-codex-copilot-proxy/drafts/
 *       fable-analysis-r16/wire-overhead-audit.md §5.1; the rules are in
 *       protocol/wireCompaction.ts): members of a reply that repeat what the
 *       reply already says leave the wire after the budget ladder has run,
 *       default ON for every client — a task-pack evidence row's
 *       `role:"unknown"` when neither the call nor the task it continues
 *       passed `surfaceRoles`, the generic `likely_edits` pair (its kinds ride
 *       alone), the informational `reason` of `profile_binding`, and the
 *       all-zero `excluded_by_reason` of a complete `search.tree`
 *       `scope_report`. Explicit `0`/`off` restores the previous reply
 *       byte-for-byte and remains the rollback path. It adds no kind or tool
 *       argument; every omitted member is one a caller already reads as
 *       optional. (An obligation's `path`/`range`/`role` restated from its
 *       evidence row was part of this set until the wire-compaction review of
 *       2026-10-23 moved it behind TL_EFF_EVIDENCE_PATH_GROUPS, below.)
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
 *       identical),
 *       TL_EFF_LIGHT_ANSWER (2026-10-10, small-task cost: a fresh answer
 *       question about one small, self-contained file skips the pathless
 *       locator and is built by the seeded builder and certification tail a
 *       caller-supplied target takes; its one evidence row omits `why` and
 *       `symbol`. No kind, field or tool argument; unset, byte-identical),
 *       TL_EFF_EVIDENCE_PATH_GROUPS (2026-10-23, same wire audit, §4.2 rank 1:
 *       `path` and `handle` once per file): inside one `read.task_pack`
 *       reply, consecutive evidence rows of one file carry `path` on the first
 *       row of the run only, and `handle` on every row whose handle differs
 *       from the row above; a row without them is the file (and handle) of
 *       the row above. A top-level `evidence_note` says so whenever a reply
 *       was grouped. In the same "restated from the evidence rows" family, a
 *       plan obligation leaves off the `path`/`range`/`role` the first row of
 *       its handle carries (moved here from TL_EFF_REPLY_COMPACT by the
 *       wire-compaction review: an obligation without a `path` makes the model
 *       look the row up to learn where an edit item goes, which no cohort has
 *       exercised). It adds one optional task-pack field and takes members
 *       off rows and obligations a reader used to find on each, so it stays
 *       default OFF until a model cohort has run it; unset, byte-identical.
 *       The pack builder prices the grouped rows too
 *       (`estimateStructureMapReplyBytes`, the task-pack size previews), so
 *       the bytes it saves can hold more rows.
 *
 *       TL_EFF_MAP_ANSWER_FIRST (2026-10-23, codex-copilot-proxy answer-first
 *       experiment; the rule is in `effMapAnswerFirstEnabled`'s doc block): a
 *       structure-map answer under a compact host ceiling is `act.answer` on
 *       its CORE evidence (the type's header, every member's signature, the
 *       state enums, and the whole bodies of the members that cover the named
 *       concerns) instead of `discover`, the other member bodies staying owed
 *       (`remaining`) and named, with the facts their absence would invite
 *       wrong, in the existing top-level `advisory`. It adds no kind, field or
 *       tool argument and changes which windows the map REQUIRES, so it stays
 *       default OFF until a model cohort has run it; unset, byte-identical.
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
 *       TL_STARTUP_WARMUP (2026-10-10, default ON; `0` disables) is the
 *       post-handshake startup warm-up (util/startupWarmup.ts): process-local
 *       CPU work in idle time that reads no request, writes nothing and
 *       prints nothing, so no response byte depends on it.
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
 *       real server via tl_search_files action=symbols (the one production
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
 *       adds the explicit-state locations and kill switch in the
 *       operational/platform class: TOKENLIGHTEN_STATE_KEY_DIR /
 *       TOKENLIGHTEN_CONFIG_HOME / TOKENLIGHTEN_HOME (+ the platform
 *       APPDATA / XDG_CONFIG_HOME fallbacks) locate the installation HMAC
 *       key (state/handleKeys.ts), and TOKENLIGHTEN_STATE_STORE=off
 *       disables the per-workspace persistent store (state/stateStore.ts) —
 *       a disabled/missing store degrades to the honest handle-unknown
 *       refusal path, never a response-shape change.
 *       v0.16 adds TOKENLIGHTEN_ENGINES_FILE (features/engines/config.ts):
 *       an optional path to trusted user-scoped local-analysis settings.
 *       It chooses providers and retrieval behavior, without choosing a
 *       codec, transport, advertised tool or wire schema. Effective settings
 *       enter the causal configuration digest; unset uses user defaults.
 *       SystemRoot is the Windows OS directory used to locate taskkill.exe
 *       for owned Language Server process-tree cleanup; no wire-shape effect.
 *       v0.10 "simultaneous-
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
 *       TOKENLIGHTEN_CLIENT (2026-10-02, read only by mcp/hostActivation.ts)
 *       is the older spelling of that identity in the VS Code entry `tl
 *       workspace setup` writes (TOKENLIGHTEN_CLIENT=vscode, later joined by
 *       TOKENLIGHTEN_CLIENT_ID=vscode); either one equal to "vscode" makes
 *       this server the VS Code client for ONE purpose: it may honor
 *       `<workspace>/.tokenlighten/host-activation.json`, the VS Code
 *       extension's window-scoped off switch. While that file is live (its
 *       ownerPid runs AND its updatedAt is fresh: no older than 90 s, none
 *       more than 60 s ahead, the extension rewriting it every 30 s)
 *       `tools/list` is empty and `tools/call` answers
 *       JSON-RPC -32601; `initialize` declares `tools.listChanged` for that
 *       client alone. No new protocol kind, field or tool argument, and with
 *       no live file — or for any other client, file or no file — no response
 *       byte moves. Operational/platform class like TOKENLIGHTEN_CLIENT_ID.
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
 * that capture (every leg but the hand-rolled legacy-era transport). Neither source is
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
 * TL_FIND_WIDE_PAGE joined class (B): out-of-contract, default OFF, at
 * introduction -- see the SPC addendum below for its 2026-09-29 promotion to
 * (S) supported, DEFAULT ON for every client. This block is kept for the
 * mechanism's own rationale, which the promotion does not change.
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
 * Explicit OFF (`TL_FIND_WIDE_PAGE=0`) is byte-identical to pre-F5 output:
 * both accessors return their unchanged pre-flag constants, so
 * replayCorpus.spec.ts and wireBaselines.spec.ts pass unmodified under that
 * override -- see the SPC addendum for what the (now default) ON state pins
 * instead. Either way, the flag changes only HOW MANY BYTES of the SAME
 * fields (files[]/roles/matched_terms/hint, then inventory/rollup) ship
 * before truncation kicks in -- same fields, same ordering, same
 * total_files/total_matches honesty either way; no new kind, field, or tool
 * argument.
 *
 * ---------------------------------------------------------------------------
 * SPC addendum -- Search Pages sized to the host Ceiling (2026-09-29; (S)
 * supported policy, DEFAULT ON for every client, promoted from F5's class
 * (B)/default-OFF by this wave's USER-approved v0.15.0 package)
 * ---------------------------------------------------------------------------
 *
 * WHY THE PROMOTION IS SAFE. F5's own OFF-by-default gate meant Claude
 * Code/Codex (hosts with NO response-byte ceiling at all -- widening is pure
 * upside for them) only got the wide page when an operator additionally set
 * TL_TURN_ECONOMY, and TL_TURN_ECONOMY itself was, in practice, written ONLY
 * by the VS Code setup script -- so almost every non-VS-Code session ran the
 * narrow 4096-byte/8-line-per-file page. MEASURED: a 2.3 KB find result
 * still needed 2 hops under that narrow page purely from the flat
 * MAX_LINES_PER_FILE(8) per-file cap (independent of the 4096-byte budget
 * having room to spare), and evaluator sessions averaged 1.06 `limit`+`next`
 * responses/cell, 17 of 18 of them `find` wire pages. VS Code is UNCHANGED
 * by this promotion (it already received the widened page via the
 * TURN_ECONOMY umbrella), so the promotion's entire effect is Claude
 * Code/Codex moving from the narrow to the wide page by default.
 *
 * `findResponseCapBytes()`/`findInventoryCapBytes()` (findText.ts) also gained
 * an optional PER-CALL ceiling override (`buildFindResponse`/
 * `buildFindResponseForQueries`'s own `opts.responseByteCeiling`), which
 * server.ts's find dispatch resolves from the caller's own declared
 * `budget.bytes`/`budget.tokens` (the SAME `resolveCallerByteCeiling` helper
 * every other caller-declared-budget consumer in that file already uses) --
 * "caller budget" outranks BOTH the host-ceiling tier and the flat
 * FIND_WIDE_PAGE_RESPONSE_BYTES default. See findText.ts's own doc comment
 * on that mechanism for exactly what it covers (the FIRST find response
 * only; continuation pages already run through an independent, separately
 * generous budget in server.ts/state/searchRequestStore.ts, untouched here).
 * No caller declaring a budget (the common case) changes nothing beyond the
 * ON-by-default flip itself.
 *
 * `findWidePageEnabled()` is NO LONGER a TL_TURN_ECONOMY umbrella member:
 * unlike that umbrella's other (still default-OFF, still VS-Code-setup-only)
 * members, this flag's default no longer depends on it at all -- an unset
 * TL_FIND_WIDE_PAGE now reads ON regardless of TL_TURN_ECONOMY, and
 * TL_TURN_ECONOMY=1 alone (no explicit TL_FIND_WIDE_PAGE) still reads ON too
 * (same value, different reason). Explicit `TL_FIND_WIDE_PAGE=0`/"false"/
 * "no"/"off" remains the rollback path to the pre-F5 narrow page, same
 * override semantics as every other (S) supported policy in this file
 * (concernRecoveryEnabled, jaQueryBridgeEnabled, taskHandleRecoveryEnabled).
 * Per that same precedent, `findWidePageEnabled` is no longer reported by
 * `activeExperimentFlags()` (util/trace.ts's `flags_active`) -- it is a
 * shipped default, not an active experiment, whether left unset or set
 * explicitly in either direction.
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
 * D10 (C): startup warm-up (util/startupWarmup.ts), default ON. Once the
 * client has completed the MCP handshake, the server uses the idle time
 * before its first tools/call to pre-pay the one-time costs of a first task
 * pack: the tree-sitter runtime, the grammars of the workspace's most common
 * source languages, and the first run of the request analyses every task
 * pack performs. Operational only: it reads no request, writes no state,
 * store, journal, ledger, handle, usage record or file, prints nothing, and
 * stops at the first tools/call, so no response byte depends on it. Explicit
 * `0`/`off` disables it.
 */
export function startupWarmupEnabled(): boolean {
  return parseBool(process.env["TL_STARTUP_WARMUP"], true);
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

/**
 * 2026-10-16 simple bench (S) supported policy, DEFAULT ON: an edit target
 * the server located itself carries the definitions its body depends on
 * (callee bodies and referenced constants, one hop, bounded) as review-only
 * context (readCodeTaskPack.ts `editContextCandidates`). Caller-named
 * targets are unaffected. TL_EDIT_CONTEXT=0 restores target-only edit packs.
 */
export function editContextEnabled(): boolean {
  return parseBool(process.env["TL_EDIT_CONTEXT"], true);
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
  if (portableToolsEnabled()) active.push("TL_PORTABLE_TOOLS");
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
  // F5 (2026-09-19) reported find-wide-page here while it was class (B),
  // default OFF. SPC (2026-09-29) promoted it to (S) supported, DEFAULT ON
  // for every client — see this file's "SPC addendum" doc block above — so,
  // matching concernRecoveryEnabled/jaQueryBridgeEnabled/
  // taskHandleRecoveryEnabled's own precedent, it is no longer reported
  // here: a shipped default is not an active experiment, whether left
  // unset or set explicitly in either direction.
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
  // Copilot retest r5 (2026-10-03): two more umbrella members, reported the
  // same way.
  if (minimalToolsEnabled()) active.push("TL_MINIMAL_TOOLS");
  if (findSmallBodiesEnabled()) active.push("TL_FIND_SMALL_BODIES");
  // V15-LTS (2026-09-29): the all-client schema diet. It was reported here
  // while it was a default-OFF experiment; v0.15.0 (2026-09-30) made it (S)
  // supported policy, DEFAULT ON for every client (see leanSchemaEnabled's own
  // doc block), so -- matching concernRecoveryEnabled/jaQueryBridgeEnabled/
  // taskHandleRecoveryEnabled/findWidePageEnabled's own precedent above -- it
  // is no longer reported: a shipped default is not an active experiment,
  // whether left unset or set explicitly in either direction. A stock
  // session's `flags_active` stays byte-identical to before this promotion.
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
  // V15-NBR/FUI (2026-09-29): independent prototypes, not SF v2 members —
  // see their own accessor doc blocks at the end of this file.
  if (neighbourIndexEnabled()) active.push("TL_NEIGHBOUR_INDEX");
  if (usageInventoryEnabled()) active.push("TL_USAGE_INVENTORY");
  // EFF (2026-10-01): efficiency experiment, default OFF. TL_EFF_TOLERANT_INPUT
  // and TL_EFF_SLIM_EDIT were promoted to supported policy, DEFAULT ON (see
  // this file's header), so -- matching taskHandleRecoveryEnabled/
  // leanSchemaEnabled's own precedent -- they are no longer reported here.
  // TL_EFF_FIND_PHRASE and TL_EFF_WIDE_FIND followed them on 2026-10-18, and
  // TL_EFF_AUTOFOLLOW on 2026-10-19; none is reported either.
  if (effLenientEditEnabled()) active.push("TL_EFF_LENIENT_EDIT");
  if (effPlanTrimEnabled()) active.push("TL_EFF_PLAN_TRIM");
  if (effHubWholeEnabled()) active.push("TL_EFF_HUB_WHOLE");
  if (effEditNoteEnabled()) active.push("TL_EFF_EDIT_NOTE");
  if (effLightAnswerEnabled()) active.push("TL_EFF_LIGHT_ANSWER");
  // TL_EFF_EDIT_DIET (2026-10-19): ON by default for the CLI coding hosts
  // only, which is a shipped default, not an experiment; like
  // TL_PORTABLE_TOOLS above, only an explicit value is reported.
  if (effEditDietEnabled()) active.push("TL_EFF_EDIT_DIET");
  // TL_EFF_EVIDENCE_PATH_GROUPS (2026-10-23): default OFF experiment, so a
  // stock session's `flags_active` is byte-identical to before it. The
  // sibling TL_EFF_REPLY_COMPACT is a shipped default (ON) and, like
  // TL_EFF_STRUCTURE_MAP above, is not reported.
  if (effEvidencePathGroupsEnabled()) active.push("TL_EFF_EVIDENCE_PATH_GROUPS");
  // TL_EFF_MAP_ANSWER_FIRST (2026-10-23): default OFF experiment, reported
  // only while on, so a stock session's `flags_active` is byte-identical.
  if (effMapAnswerFirstEnabled()) active.push("TL_EFF_MAP_ANSWER_FIRST");
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
 * OFF — the ruling's default behaviour: an `tl_edit_file` whose target the LATEST
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
 * TL_PACK_CONTAINMENT_DEDUP (2026-10-19), (S) supported pack policy, DEFAULT
 * ON for every client; explicit `0`/`off` is the rollback path and restores
 * today's pack byte-for-byte.
 *
 * ON: `dedupeTrimAndPersist` (readCodeTaskPack.ts
 * `applyPackContainmentDedup`) runs one more model-free pass before
 * `trimToCap`, so the bytes it frees go back to the trim ladder. A row whose
 * lines and text another row of the SAME file in this pack already carries
 * ships once: an appended window (`buildAnswerTaskPack`'s query-focused
 * member and facet excerpts) that its own surface's served body or a larger
 * kept window of it already holds is cut, and a separate surface inside
 * another surface's served body gets the `code_unchanged` pointer
 * `applyPackDedupe` gives an identical row, unless it is protected, on the
 * certified action frontier, required, edit-bearing, caller-named,
 * explicit-identifier evidence, or cited by the certificate.
 * `applyPackDedupe` matches only identical (handle, range, hash) rows.
 *
 * Measured on the v0.16.0 decision runs 6t-2 and 6t-3 (arm A, 36 cells):
 * the only contained rows were T03's four windows of OrderOrchestrator.java
 * (144-153, 146-151, 145-150, 147-152), all inside the class head's own
 * 107-165 body. Replayed, the six T03 first packs shrink by 2,287-2,465 B
 * (16-17%) with the same decision and `next`, and no other reply of the 36
 * cells moves. Adds no kind, field or tool argument.
 */
export function packContainmentDedupEnabled(): boolean {
  return parseBool(process.env["TL_PACK_CONTAINMENT_DEDUP"], true);
}

/**
 * F5 (2026-09-19) introduced this as D10 (B): out-of-contract, default OFF.
 * SPC (2026-09-29) promotes it to (S) supported, DEFAULT ON for every
 * client — see this file's "F5 addendum" and "SPC addendum" doc blocks
 * above for the full rationale (mechanism and promotion respectively).
 *
 * ON (the default): `features/search/find/findText.ts`'s
 * `findResponseCapBytes()` (the explore action=find snippet-section cap)
 * and `findInventoryCapBytes()` (the companion whole-response-with-inventory
 * ceiling) both widen — see each accessor's own doc comment for the exact
 * bytes and for the optional per-call ceiling override they also read.
 *
 * OFF (explicit `TL_FIND_WIDE_PAGE="0"`/"false"/"no"/"off"): both accessors
 * return their pre-flag constants unchanged, so the find response family is
 * byte-identical to pre-F5 output — the rollback path, same shape as
 * `concernRecoveryEnabled`/`jaQueryBridgeEnabled`/`taskHandleRecoveryEnabled`.
 *
 * No longer a TL_TURN_ECONOMY umbrella member (unlike this file's other,
 * still-default-OFF turn-economy policies): promoting the DEFAULT to ON
 * makes following that still-default-OFF umbrella pointless — an unset
 * TL_FIND_WIDE_PAGE would otherwise depend on an unrelated, unset variable
 * to reach the very state this promotion makes the default. Reads ON
 * whether TL_TURN_ECONOMY is unset, "0", or "1"; only this flag's OWN
 * variable can turn it off.
 */
export function findWidePageEnabled(): boolean {
  return parseBool(process.env["TL_FIND_WIDE_PAGE"], true);
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
 * byte-for-byte. `tl_read_file`/`tl_search_files` only; `tl_edit_file` keeps strict
 * authentication always (see server.ts's `recoverAuthFailedTaskHandle`,
 * never wired into the tl_edit_file dispatch arm).
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
 * and recovers nothing. A long deletion/ellipsis near-miss with at least 80
 * retained characters also uses that unique live lane candidate on read/search,
 * provided the call names neither a CAS version nor a new epoch; short display
 * abbreviations and every edit keep strict authentication/refusal handling.
 * (c) (2026-10-02, Copilot standard-setup evaluation)
 * when nothing was recovered and the SAME call sends `task.epoch:"new"`
 * without `expected_state_version`, a handle that names no live task (any
 * outcome but `wrong-workspace`) is dropped and the call proceeds as the new
 * task it asked for (server.ts's `dropDeadTaskHandleForNewEpoch`). Adds no
 * kind, field, or tool argument: an already-defined refusal turns into an
 * already-defined success on the SAME schema, nothing new ships either way.
 *
 * OFF (explicit "0"): `recoverAuthFailedTaskHandle` and
 * `dropDeadTaskHandleForNewEpoch` return immediately; every call reaches
 * `taskHandleRefusal` exactly as it does today.
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
 * SEEDED pack (`buildSeededTaskPack` — a `tl_read_file {query, targets:[{path},…]}`
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
 * so the pack's own prescribed `next` — `tl_search_files find ["ShopFlow"]` — is a
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
 * `tl_search_files find` calls on exact code text purely to learn line numbers
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
 * `tl_edit_file` search/replace): each body line gains a source-line-number
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
 * carries. Unset, it is also ON for the CLI coding hosts (`cliHost`: Claude
 * Code and Copilot CLI, 2026-10-17), whose citation answers re-read whole
 * files to count lines.
 */
export function answerLineGutterEnabled(cliHost = false): boolean {
  // Same PRESENCE-first read as `seededGenerousEnabled`/
  // `identifierGroundingEnabled` above, for the same reason: the member's own
  // variable is an override, not a defaulted value.
  const raw = process.env["TL_ANSWER_LINE_GUTTER"];
  if (raw !== undefined) return parseBool(raw, false);
  // 2026-10-17 simple paired bench (DESIGN-v0.14-plan §20.8): also ON for the
  // CLI coding hosts (`cliHost`: Claude Code, Copilot CLI and, §20.11, Codex
  // CLI), whose answers cite file:line and re-read whole files to learn the
  // line numbers.
  return turnEconomyEnabled() || cliHost;
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
 * (`tl_read_file {targets:[{handle,range:"1-14"}]}`) fetching the 14 import lines
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
 * `turnEconomyEnabled()`. With neither variable set, `tl_read_file`'s dedupe
 * receipts are byte-identical to pre-WP-S10 output. Scoped to ONE seam in
 * `server.ts`'s `tl_read_file` dispatch, immediately before the S1-A1 qref-repack
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
 * `canonicalToolCall` omits `cwd` from an emitted tl_read_file/tl_search_files
 * continuation when it targets the same workspace the triggering call is
 * already resolved against (VS Code launches one server per single
 * workspace root, so that call's own workspace IS the server's root), and
 * omits `task.handle` when the continuation already carries a `qref` (which
 * binds the task on its own) or is a plain targets-only read/search that
 * needs no task continuity to be served. A cursor continuation,
 * `task.pull:"closure"`, a challenge, or `task.expected_state_version`
 * still keep the handle explicit — each genuinely needs it.
 * `tl_edit_file` continuations are unchanged: write safety keeps `cwd`/
 * `task.handle` explicit always. `server.ts`'s `advertisedTools()`
 * additionally sheds tl_read_file's `budget.bytes`/`budget.tokens`, each
 * tool's top-level `oneOf`/`anyOf`, `task`'s `dependentRequired` and every
 * nested property description from the advertised schema for that same
 * vscode+flag case (`targets[].purpose` STAYS advertised, described as a
 * directory-target field: it is what the directory-confined recovery of a
 * seeded pack locates with) — Copilot's own schema validator
 * rejects `oneOf`/`anyOf`/`dependentRequired` outright, and the server
 * enforces every one of these constraints at dispatch regardless of what is
 * advertised, so nothing served becomes stricter or looser than today.
 *
 * Copilot CLI also opts into the existing minimal advertisement when both
 * TL_LEAN_CALLS=1 and TL_MINIMAL_TOOLS=1; emitted continuations remain scoped
 * to VS Code. The CLI variant preserves recovery fields through open objects.
 * OFF (the default), or an unrelated client: every emitted call is
 * byte-identical to pre-WP-V1 output, and so is every advertised schema apart
 * from the two elements `TL_LEAN_SCHEMA` (`leanSchemaEnabled` below) sheds for
 * EVERY client since v0.15.0 -- with `TL_LEAN_SCHEMA=0` as well, byte-identical
 * to pre-WP-V1 output.
 */
export function leanCallsEnabled(): boolean {
  // Same PRESENCE-first read as `seededGenerousEnabled`/
  // `reserveSmallWindowsEnabled` above, for the same reason: the member's
  // own variable is an override, not a defaulted value.
  const raw = process.env["TL_LEAN_CALLS"];
  if (raw !== undefined) return parseBool(raw, false);
  return turnEconomyEnabled();
}

/**
 * Copilot retest r5 (2026-10-03), turn-economy policy — DEFAULT OFF, a member
 * of the TL_TURN_ECONOMY umbrella with `seededGenerousEnabled`'s override
 * semantics, and in effect only where `leanCallsEnabled` is (the resolved
 * "vscode" client, plus exact "copilot-cli" when BOTH flags are enabled,
 * through server.ts's `leanToolDefinitionForClient`).
 *
 * ON: the vscode advertisement keeps only the arguments a Copilot model
 * writes on its own (query; targets path/handle/range/symbol/purpose; task
 * epoch/profile/force_serve; plain edits plus cwd; find/references/tree with
 * scope.path/regex) and the short, steering tool descriptions
 * (clientAdvertisement.ts `VSCODE_MINIMAL_TOOL_DESCRIPTIONS`). Archive,
 * credential, structural-intent, budget and idempotency arguments, and since
 * Copilot retest r6 also qref/cursor/content/cwd on reads and searches and the
 * rarely written options (see server.ts MINIMAL_SCHEMA_PROPERTY_PATHS), are no
 * longer advertised; `select` and `artifact` stay advertised as one-line
 * opaque objects. Dispatch still accepts every one of them (inbound
 * validation reads ALL_TOOLS, never the advertisement), and a server-issued
 * `next` still carries whichever one it needs.
 *
 * WHY: r5 measured that a model without `tool_search` (MAI flash) pays every
 * advertised byte on every round; TokenLighten's share was ~1,870 tokens of
 * the first round. Explicit "0" restores the r4/r5 lean advertisement so
 * the two can be compared on the same build.
 */
export function minimalToolsEnabled(): boolean {
  const raw = process.env["TL_MINIMAL_TOOLS"];
  if (raw !== undefined) return parseBool(raw, false);
  return turnEconomyEnabled();
}

/**
 * Copilot retest r5 (2026-10-03), turn-economy policy — DEFAULT OFF, a member
 * of the TL_TURN_ECONOMY umbrella with `seededGenerousEnabled`'s override
 * semantics. Not client-scoped (like every member but TL_LEAN_CALLS).
 *
 * ON: a `tl_search_files` `find` whose WHOLE result is a few small files
 * (findText.ts `attachSmallFileContexts`: at most 6 files, each at most 80
 * lines and 2,400 bytes, 3,200 bytes in all) carries each file's full text in
 * the existing `range`/`handle`/`context` fields of its `files[]` entry —
 * the shape the dominant-edit context already uses, so no kind, field or
 * argument is added. A file the session already holds, or one that already
 * carries a dominant-edit window, is left as it was.
 *
 * WHY: r5's one TokenLighten run searched (`find`), then read the three hits
 * in a second call, then answered — three model rounds, the same as the
 * native grep/read path, so it saved nothing. With the bodies in the search
 * result that run needs two.
 */
export function findSmallBodiesEnabled(): boolean {
  const raw = process.env["TL_FIND_SMALL_BODIES"];
  if (raw !== undefined) return parseBool(raw, false);
  return turnEconomyEnabled();
}

/**
 * V15-LTS (2026-09-29) -- the ALL-CLIENT counterpart to `leanCallsEnabled`'s
 * ADVERTISED-SCHEMA diet (never its emitted-continuation-shape changes,
 * which stay vscode-only: omitting `cwd`/`task.handle` from a server-authored
 * `next` steers what the SERVER sends back, so it needs a client that
 * actually benefits from a single-root assumption; the schema diet only
 * changes what `tools/list` advertises, which every client reads). Plain
 * standalone env reader, DEFAULT ON since v0.15.0 (2026-09-30), NOT a
 * `turnEconomyEnabled()` umbrella member -- turn economy is written only by
 * the VS Code setup script, and this flag is meant for hosts turn economy
 * never reaches (Claude Code, Codex CLI), so following that umbrella would be
 * the wrong default source.
 *
 * See `server.ts`'s `leanSchemaForEveryClient` for the exact two elements it
 * sheds (top-level `oneOf`/`anyOf`; `task.dependentRequired`) and why both
 * are safe for EVERY client, not just vscode: each is a constraint
 * `dispatchTool` already enforces regardless of what is advertised, AND
 * each is already stated in prose the model already has -- AGENTS.md's
 * protocol section for `task.dependentRequired` ("Pass
 * task.expected_state_version ONLY beside a task.handle ... alone it
 * refuses"), and, for the top-level choice keywords, the tool's own
 * un-shed top-level `description` plus the same guide's per-shape bullets
 * (bare `qref`, `task.pull`, a cursor-only continuation). Deliberately
 * narrower than `leanCallsEnabled`'s vscode diet: it does NOT shed
 * `budget.bytes`/`budget.tokens` (a real capability whose removal was
 * motivated by a Copilot-specific replay finding, not a universal
 * no-information-loss argument) and does NOT strip nested property
 * descriptions (that cut needs a field-by-field audit against guide
 * coverage this wave does not attempt) -- both remain exactly as
 * out-of-scope for this flag as the D10(B) note above requires.
 *
 * Default ON since v0.15.0: the pre-registered 3-real-client conformance gate
 * (Claude Code / Codex CLI / VS Code Copilot Chat) -- the SAME kind of gate
 * that retired `TL_SCHEMA_DEFS` after it never passed
 * (DESIGN-v0.14-proposal-2026-08-31.md §5; see this file's TL_SCHEMA_DEFS
 * retirement stamp in the D10 block above) -- PASSED on 2026-09-30, with these
 * three results:
 *   - Claude Code 2.1.211, headless run: all three tools called, edit applied.
 *   - Codex CLI 0.159.1, headless run: all three tools called; the model's
 *     first `oldText`/`newText` edit was refused `unknown-arguments` and
 *     recovered -- the SAME behaviour in a default-schema (full-schema)
 *     control run, so it is not caused by the lean schema.
 *   - VS Code Copilot Chat, production evidence: the VS Code setup has served
 *     `TL_TURN_ECONOMY`'s strictly leaner schema since 2026-09-20 (8,337 B,
 *     oneOf 2 / anyOf 1 / dependentRequired 0; 8,361 B after the Copilot
 *     retest r3 description change; 6,755 B with oneOf/anyOf 0 since the r4
 *     cut and the tl_ tool names).
 * Unlike TL_SCHEMA_DEFS, this flag changes no wire SHAPE at all -- both
 * elements it sheds are already proven advertising-only by
 * `leanCallsEnabled`'s own shipped vscode behavior -- so the gate was about
 * CLIENT SCHEMA ACCEPTANCE (does the shrunk schema still validate/parse for
 * that host), not about a new capability's wire risk.
 *
 * ON (the default): every client's advertised schema sheds the top-level
 * `oneOf`/`anyOf` and `task.dependentRequired`. Explicit `TL_LEAN_SCHEMA=0`
 * (or `false`/`no`/`off`) restores the full pre-v0.15.0 schema byte-for-byte
 * on every client -- the rollback path, same shape as
 * `findWidePageEnabled`/`concernRecoveryEnabled`/`taskHandleRecoveryEnabled`.
 * Being a shipped default now, it is no longer an active experiment:
 * `activeExperimentFlags` does not report it, whether unset or set explicitly
 * in either direction (same precedent as those three).
 */
export function leanSchemaEnabled(): boolean {
  return parseBool(process.env["TL_LEAN_SCHEMA"], true);
}

/**
 * D10(B): model/client-independent compact advertisement. Select with
 * --guide-profile portable during workspace setup, or set TL_PORTABLE_TOOLS=1
 * for the schema alone. Does not join TL_TURN_ECONOMY.
 * Projects canonical schemas after tool-surface filtering; keeps routing,
 * task continuity, budgets and edit safety discoverable. Rare fields remain
 * host-valid in open objects and dispatch validates the complete contract.
 * Unset, it is OFF except for the CLI coding hosts (Claude Code, Copilot
 * CLI, Codex CLI; server.ts `portableAdvertisementForClient`, 2026-10-17), whose every
 * request pays for the advertised bytes. TL_PORTABLE_TOOLS=0 restores the
 * previous client-specific advertisements for every client.
 */
export function portableToolsEnabled(defaultOn = false): boolean {
  // 2026-10-17 simple paired bench (DESIGN-v0.14-plan §20.8): server.ts passes
  // `defaultOn` = true for the CLI coding hosts (Claude Code, Copilot CLI,
  // Codex CLI),
  // whose every request carries every advertised schema. An explicit value
  // still decides for every client; `activeExperimentFlags` reports only it.
  return parseBool(process.env["TL_PORTABLE_TOOLS"], defaultOn);
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

// ---------------------------------------------------------------------------
// V15-NBR/FUI (2026-09-29): two independent v0.15.0 candidate prototypes,
// prepared for a small paid A/B engagement probe (measure-v015/REPORT.md's
// "Extra finding" and ideation-v015-fable.md candidate 5). Both (B):
// out-of-contract, default OFF, no wire kind/field beyond an additive
// `plan` member (readFamily.ts's PLAN_MEMBERS, A.6.1's rare-extension rule).
// Neither depends on the other or on any SF v2 flag above. With both unset a
// task pack is byte-identical to pre-V15-NBR/FUI output by construction: the
// attach functions (features/task-pack/frontierNeighbours.ts,
// features/task-pack/usageInventory.ts) open with this exact flag check and
// do nothing else when it reads false.
// ---------------------------------------------------------------------------

/**
 * v0.15 (B): NBR frontier neighbour index. ON: a `read.task_pack` (answer and
 * generic profiles), after its final surfaces are fixed, gets up to 8
 * BODYLESS rows (`plan.neighbours`) for workspace files the served files
 * import, `#include`, reference without an import (same Java/Kotlin package,
 * same Go package) or pair with (C/C++ header/source), and that this
 * response, `frontier_index` and `served_earlier` do not already name —
 * path, a minted handle, and a short `why` — ranked by relevance to the
 * request and by use in the served slice, capped at ~1 KiB. Imports resolve
 * in projects nested below the workspace root (features/task-pack/
 * importResolution.ts and the per-family resolvers). Never evidence, never
 * cited by a certificate/obligation, never booked as served. OFF (default):
 * the attach hook returns before doing anything; the pack is byte-identical
 * to pre-NBR output.
 */
export function neighbourIndexEnabled(): boolean {
  return parseBool(process.env["TL_NEIGHBOUR_INDEX"], false);
}

/**
 * v0.15 (B): FUI frontier usage inventory. ON: the same pack gets
 * `plan.usages`, a lexical (never "callers") inventory for up to 6
 * identifiers ranked by relevance to the request — named by the request,
 * matching its terms, or constants/types/enum members the served code
 * references or declares — `{symbol, files:[{path, lines}], total,
 * inventory_complete, scope?}`, the declaring file first, from the same
 * word-bounded scanner `tl_search_files find` uses, scanned only inside the
 * served file's own project (`scope`, omitted when that is the whole
 * workspace), capped at ~1.5 KiB. OFF (default): the attach hook returns
 * before doing anything; byte-identical to pre-FUI output.
 */
export function usageInventoryEnabled(): boolean {
  return parseBool(process.env["TL_USAGE_INVENTORY"], false);
}

// ---------------------------------------------------------------------------
// EFF (2026-10-01): efficiency experiment, class (B), default OFF, except
// TL_EFF_TOLERANT_INPUT and TL_EFF_SLIM_EDIT, promoted to supported policy,
// DEFAULT ON (USER ruling 2026-10-01; see this file's header),
// TL_EFF_FIND_PHRASE and TL_EFF_WIDE_FIND, promoted the same way on
// 2026-10-18, and TL_EFF_AUTOFOLLOW, promoted on 2026-10-19. Measured
// against the h2 decision windows (2026-09-30/10-01): each lever targets a
// reply byte or round-trip cost observed there.
// ---------------------------------------------------------------------------

/**
 * TL_EFF_AUTOFOLLOW: a task pack whose decision is `discover` with ONE
 * executable tl_read_file `next` that re-issues the caller's own request (the
 * T03 shape) runs that follow-up server-side and returns one reply holding
 * both (server.ts `autofollowDiscoverPack`). Default ON since 2026-10-19;
 * explicit `0`/`off` restores the discover reply and its `next`
 * byte-for-byte.
 *
 * The 2026-10-19 rules: only a `next` whose `query` is the caller's own, in
 * the same epoch, on a pack with no `plan`; never a discover whose gaps
 * include `ambiguous-target` (a pick among candidates is the agent's call);
 * and no booked-but-undelivered bytes — a follow-up that served anything is
 * delivered (a task pack merges; a plain read rides as rows), only one that
 * served nothing is dropped. The first version followed plain reads and
 * candidate picks too, and returned the discover reply unchanged when it could
 * not merge, leaving the follow-up booked: on the HEAD build the solver's own
 * read of the dropped window (6t-3 T10 rep2 #8) got a 157 B `code-unchanged`
 * receipt for 5,843 B it never received, and 6t-2 T13 rep0 #9 grew 7.9 KB.
 * Replayed on both windows' 36 arm-A cells under the rules
 * (rc/autofollowDiscover.rc.spec.ts holds the T03, T09 and T10 shapes): each
 * T03 first call is one `act.answer` of 20,246-20,388 B against 24,631-24,958
 * B for the two recorded packs, and no other reply changes.
 *
 * The default flip (2026-10-19, after decision run 6t-4) fixed what turning
 * it on exposed. A pack built under a byte ceiling (the request's `budget`,
 * TOKENLIGHTEN_TASK_PACK_MAX_BYTES, or the client profile's, VS Code's
 * 14,336 B) is never followed: two packs in one reply overran a 14,336 B
 * budget at 17,421 and 21,135 B. The discover pack's own `decision.gaps`
 * ride `auto_followed.gaps`: the follow-up's `act.*` decision has no member
 * to keep them, and a chain that disclosed `missing-evidence` before it
 * closed reached the client as one silent `act.answer`. And its
 * `server_build` and `answer_resolution` stay on the merged reply, which had
 * dropped both. Replayed on 6t-4's arm-A first calls, T03's is one
 * `act.answer` of 20,955 B where the discover and the `next` every cell sent
 * came to 11,846 + 10,413 B, and no other task's first reply changes.
 * Turning it on moved 31 tests in 13 files. Those whose subject is the client
 * running the discover's `next` (repack monotonicity, the qref re-pack,
 * pack-serve and sequence chains, the spelling of a server-authored `next`)
 * pin `TL_EFF_AUTOFOLLOW=0`; the rest expect the merged reply, most with a
 * rollback control beside it.
 *
 * The chain (2026-10-19, after decision run 6t-6). A follow-up that is itself
 * a discover pack whose one `next` reads more windows of the files the reply
 * serves, under the same task and the request's own query, is followed
 * again, three follow-ups at most, and only while an upper-bound estimate of
 * the reply, taken before the read, stays within 45,056 B: Claude Code moves
 * a tool result over 50,000 characters out of the conversation into a file.
 * Each 6t-6 T03 cell had run that chain by hand: 21,678 B, its next 33,398 B,
 * then the act.answer, one model turn each. Replayed on its first call (a
 * fixture-only cell, whose shorter workspace path trims about 100 B), the
 * first reply carries OrderOrchestrator.java through line 823 (37,201 B,
 * `auto_followed.hops` 2) and its next is the act.answer (28,239 B): two
 * replies where there were three. No other task's first reply changes. The
 * first follow-up is not held to the cap, as before.
 */
export function effAutofollowEnabled(): boolean {
  return parseBool(process.env["TL_EFF_AUTOFOLLOW"], true);
}

/**
 * TL_EFF_SLIM_EDIT: `edit.applied` ships a post-edit window of the changed
 * lines plus a few lines of context (no enclosing-symbol widening) and a
 * verification kit without inline bodies (handles plus one `next_call`).
 * Default ON since 2026-10-01; explicit `0` restores the ±20 /
 * enclosing-symbol window and inline kit bodies.
 */
export function effSlimEditEnabled(): boolean {
  return parseBool(process.env["TL_EFF_SLIM_EDIT"], true);
}

/**
 * TL_EFF_LENIENT_EDIT: an edit item whose exact `search` text occurs once on
 * disk is admitted on a file the session has not been served yet, and the
 * native-edit argument names (`file_path`/`old_string`/`new_string`/
 * `replace_all`, `oldText`/`newText`) map to their canonical items.
 */
export function effLenientEditEnabled(): boolean {
  return parseBool(process.env["TL_EFF_LENIENT_EDIT"], false);
}

/**
 * TL_EFF_TOLERANT_INPUT: unambiguous near-miss inputs that the h2 windows saw
 * refused are served instead (a one-element `ranges` on a batch target, a
 * package-qualified references name, a directory path given to tl_read_file, a
 * legacy `task.taskProfile`, tl_edit_file's own `task.profile`), each disclosed in
 * a `normalized` note. Default ON since 2026-10-01; explicit `0` restores the
 * refusals.
 */
export function effTolerantInputEnabled(): boolean {
  return parseBool(process.env["TL_EFF_TOLERANT_INPUT"], true);
}

/**
 * TL_EFF_WIDE_FIND: a `find` accepts up to ten `queries` instead of refusing
 * past five. Split from TL_EFF_TOLERANT_INPUT when that flag became default
 * ON, since the guide documented the five-query refusal. Default ON since
 * 2026-10-18 (USER ruling: 「TL_EFF_WIDE_FINDをデフォルトオン」), with the
 * full guide's cap moved to `>10`; explicit `0` restores the five-query
 * refusal. Evidence: the v0.16.0 decision rerun
 * (bench/workflows/runs/2026-10-18-v016-decision-6t-2) refused two finds of
 * six and seven queries in T03 (rep0 #5, rep2 #5); each refusal's `next` was
 * the first five, so each cost a turn, and rep2's follow-up find for the
 * leftover token then met the repeated all-served guard.
 */
export function effWideFindEnabled(): boolean {
  return parseBool(process.env["TL_EFF_WIDE_FIND"], true);
}

/**
 * TL_EFF_PLAN_TRIM: a task pack omits `plan.wiring.evidence_graph` (a node and
 * relation index of paths and handles the pack's own evidence already
 * carries) unless TL_SF_RELATION_PACKETS asks for relation packets.
 */
export function effPlanTrimEnabled(): boolean {
  return parseBool(process.env["TL_EFF_PLAN_TRIM"], false);
}

/**
 * TL_EFF_FIND_PHRASE: a `find` whose queries all match nothing, at least one
 * of them a phrase of several words, is re-run once on the identifier-like
 * tokens inside those queries (camelCase, snake_case, dotted or digit-bearing
 * names, file names, ALLCAPS words), at most five, and that result is served
 * with a `normalized` note naming the tokens. Measured 2026-10-01: 33 of the
 * 93 finds in the efficiency A/B's treatment arm were phrases that matched
 * nothing, each costing the solver a turn; replayed offline on the A/B's 42
 * zero-match phrase finds, 32 hit (DESIGN-v0.14-plan.md §19.11).
 * Default ON since 2026-10-18; explicit `0` restores the all-miss reply (its
 * absence certificate, no re-run). Promoted after the v0.16.0 Sonnet decision
 * run (bench/workflows/runs/2026-10-18-v016-decision-6t-1), whose arm A sent
 * a phrase find in T05c rep0 -- ["CW prop CCW prop motor direction",
 * "drv_motor motor direction spin", "DRV_MOTOR_COUNT motor index FR FL BL
 * BR", "yaw sign convention clockwise"] -- that matched nothing and was
 * answered with an authoritative absence certificate. The re-run would have
 * searched `drv_motor` and `DRV_MOTOR_COUNT`; the solver's next call asked
 * for the bare `DRV_MOTOR_COUNT`, which matched.
 */
export function effFindPhraseEnabled(): boolean {
  return parseBool(process.env["TL_EFF_FIND_PHRASE"], true);
}

/**
 * TL_EFF_FIND_SNIPPET_CAP (2026-10-19): a `find` that matches more than
 * FIND_SNIPPET_MAX_FILES (10) files keeps `snippets` only for the ten files
 * with the most matched lines. Every matched file still lists all of its
 * `lines`, and the reply's `snippet_cap` gives the cap, the number of files
 * left with lines only, and the `scope` that narrows the same find to a
 * directory matching no more than ten files, where every snippet comes back
 * (features/search/find/findText.ts `capFindSnippets`). The match set and its
 * completeness (`total_files`/`total_matches`, `truncated`/`limit`,
 * `inventory`, `term_results`, `absence`) are unchanged. Measured on the
 * v0.16.0 decision run bench/workflows/runs/2026-10-18-v016-decision-6t-3,
 * arm A: 12 of its 49 finds matched 13-31 files and ran 4.7-11.1 KB, mostly
 * snippets of up to eight lines per file — T09 rep1 #4 (`IssuePriority`,
 * `priority`) was 31 files in 10,674 B, CONTRACT.md alone 10 lines and 8
 * snippets. Default ON; explicit `0` restores the uncapped reply
 * byte-for-byte.
 */
export function effFindSnippetCapEnabled(): boolean {
  return parseBool(process.env["TL_EFF_FIND_SNIPPET_CAP"], true);
}

/**
 * TL_EFF_STRUCTURE_MAP (2026-10-20): an answer request that asks for a short
 * or map-shaped answer (features/task-pack/structureMap.ts
 * `asksForStructureMap`), names a flow facet, and whose first candidate is a
 * type with direct members too large for one surface is served the type's
 * STRUCTURE MAP (readCodeTaskPack.ts `structureMapForAnswer`): its own doc
 * comment, its header (declaration, fields, constants and tables, the
 * constructors), every member's signature, and every statement that calls a
 * named concern or one of the type's own helpers that does, in source order,
 * with the workspace enum types the header is declared in beside it. The flow
 * facets require exactly those windows of each member they match, so the
 * certificate is issued over served rows; the member bodies stay owed
 * (`remaining`). The first page is the largest of a ladder of source allowances
 * (16 KB down to 2 KB in steps of 1 KB, under every ceiling) whose estimated
 * reply fits the pack's code-bearing tier under the active byte ceiling. From the
 * ceiling at which a map's owed windows are served in batches sized to it (the
 * Copilot CLI's 18,432 B, and every pack without a ceiling) any page that fits is
 * a map. Below it (VS Code's 14,336 B) a page is admitted only when it carries
 * the map's skeleton — the code lines of the header and of every member's
 * signature, which the planner takes before any member body — and the builder
 * will keep it: the estimate, priced as a builder without the size preview
 * measures it (ungrouped), stays STRUCTURE_MAP_UNBATCHED_ADMISSION_MARGIN_BYTES
 * (1,536 B) under the ceiling, and the follow-up that asks for the windows the page
 * left owed is batched like the larger tier's. A ceiling too small for the
 * skeleton (T03's is 127 code lines, 15,046 B estimated) is served no map and
 * keeps the whole-member requirement. Measured on the 69 map-shaped chains of the
 * generality audit under VS Code's 14,336 B: the map stands in 23 of them, up
 * from 2, the mean chain takes 4.14 round trips where it took 4.26, and over the
 * 38 chains that reach an answer both ways 3.26 where they took 3.71 (24.7 to
 * 22.7 KB), 10 taking fewer and 2 more. Measured on the v0.16.0
 * decision run bench/workflows/runs/2026-10-20-v016-decision-6t-7: each T03
 * arm A cell's first reply was a 37,307 B discover through
 * OrderOrchestrator.java line 823, and its next the 28,045-28,239 B
 * act.answer; replayed on the same first call (a fixture-only cell) it is one
 * act.answer of 24,877 B, and no other task's first reply changes. Default
 * ON; explicit `0` restores the whole-member requirement and its chain
 * byte-for-byte.
 *
 * WHICH LANGUAGES, AND WHAT A MEMBER IS (2026-10-24, design: bench/workflows/
 * experiments/2026-10-21-codex-copilot-proxy/drafts/fable-analysis-r16/
 * out-of-line-maps-design.md, Stage 1). Java, TypeScript, Python, C# and Kotlin
 * types have their members inside them, and map as above. Go, Rust, C and C++
 * types have members OUTSIDE their range, which the map reaches through
 * features/task-pack/structureMapMembers.ts (the parser is not changed):
 *
 *   Go     the methods of the same file whose receiver is `T` / `*T` (generic
 *          too), their `//` doc comments included; `New…` / `new…` functions
 *          whose result holds `T` are its constructors, mapped with the header.
 *          A `type T interface` is never mapped.
 *   Rust   the fns of the same file's `impl T { … }` / `impl Trait for T { … }`
 *          blocks (generics, lifetimes and `where` clauses read through), outside
 *          a `#[cfg(test)]` module; `new` is the constructor.
 *   C      a `struct T { … }` DEFINITION and the functions of the same file whose
 *          first parameter is a pointer to it (`struct T *`, `T *`, `T_t *`,
 *          `const T *`), named from their signature text (the parser names a
 *          function after the first `struct X` of its line). NOT covered: "the
 *          file is the module" (no struct, nothing for the request to name) and
 *          `typedef struct { … } T_t;` (no symbol: the locator cannot reach it).
 *   C++    the methods defined in the class body and the `T::m` definitions of
 *          the same file (`T::T` the constructor; a constructor or destructor
 *          whose body begins below its signature line has no symbol and is read
 *          from the text, initialiser list included). NOT covered: the usual
 *          layout, a `.hpp` class with its definitions in the counterpart `.cpp`
 *          — the multi-path map is the design's Stage 2 (the seams are
 *          `StructureMapMember.path`, `StructureMapType.memberFiles` and
 *          `cppOutOfLineMembers`' `source`) — a two-level qualifier with an
 *          Allman brace and `operator` definitions (the parser gives them no
 *          symbol); an out-of-line template member is read from its signature.
 *
 * The map of such a type is of its EXTENT: `range` runs from the first line of
 * its doc or first member to the last member, and the code of other types and
 * functions between the members is never required and never served — it is in
 * `remaining_ranges` as lines not served, and a row never carries it along
 * (coalesceAnswerRows `canBridge`). The members the type has in OTHER files
 * (a Go package's other files, a Rust crate's other modules) are not mapped;
 * the reply's `advisory` says how many and where, when the room under the
 * ceiling allows (`attachStructureMapElsewhereNote`); a chain the server follows
 * on its own keeps that one line (`mergeAutofollowReplies`). The Go receiver
 * variable counts like `this` for a call to a helper of the type.
 *
 * LOCATOR (same change): a plain word the request frames as a declaration — "the
 * big Transport struct", "type Transport", "impl Decimal", "struct engine",
 * "Transport 構造体" — is an explicit identifier like a backticked one
 * (features/task-pack/declarationFraming.ts, readCodeTaskPack.ts
 * `explicitCodeIdentifiers`), so the first candidate is the declaration and not
 * a test that mentions the word. Such a name is matched in the spelling of its
 * frame (the lowercase method `transport()` of another file is not the struct
 * `Transport`), and when the request also names a file that declares the type,
 * that declaration is the first candidate (`framedTypeInNamedFiles`). This is not
 * behind the flag: it applies to every answer pack, and the generic uses of the
 * same nouns name nothing.
 *
 * The ENTRY rule (2026-10-24, generality audit §3.3.3: of 16 natural
 * paraphrases of the T03 question 1 EN and no JA one passed both detectors) is
 * two closed vocabularies written for paraphrases, not for one request.
 * `asksForStructureMap` reads brevity words about the SIZE OF THE ANSWER:
 * "TL;DR", "short summary / version / answer", "quick rundown", "keep it
 * short", "be brief", "at a glance", "in a nutshell", "in a few lines",
 * ざっと, 簡単に説明して, 要点, …を中心にまとめて。 — and none of their other
 * senses ("short-circuit", "shortcut", "quick fix", "how quickly", "the
 * summary field", `summary.total`, 簡単に直せますか, まとめて削除) and none of
 * them negated ("Don't summarize", 「要約せずに」): a request wrongly judged
 * map-shaped is answered from rows instead of whole members, so a miss costs a
 * hop and a false match costs evidence. The flow facet (requestFacets.ts
 * `isCallOrderClause`, FLOW_JA_RE) reads the ORDER OF CALLS anchored to a call
 * or execution verb or noun — "the order it calls payment in", "what order
 * does it call …", "in which order do A, B and C get invoked", "which of A /
 * B / C runs first", "when A / B / C get called", "the sequence of … calls",
 * "call order", 呼ぶ順番, 呼び出し順, 最初に実行される — never the bare word
 * "order" / 順番 (a purchase order, a sort order, 注文の順番, 順番待ち). A
 * request that fails either detector keeps the whole-member requirement.
 * Scored on two held-out sets (entryHeldout1.ts, a development set;
 * entryHeldout2.ts, blind) by structureMapEntry.heldout{1,2}.spec.ts and
 * requestFacets.heldout{8,9}.spec.ts, pinned rule by rule by
 * structureMapEntry.rules.spec.ts and end to end by
 * structureMapEntryPhrasing.spec.ts.
 */
export function effStructureMapEnabled(): boolean {
  return parseBool(process.env["TL_EFF_STRUCTURE_MAP"], true);
}

/** Additional EN/JA call-order question phrasings; independent of map layout.
 * Default ON. Set TL_EFF_FLOW_ORDER_VOCAB=0 to restore the prior flow detector
 * and subject extraction, including when TL_EFF_STRUCTURE_MAP is disabled.
 */
export function effFlowOrderVocabEnabled(): boolean {
  return parseBool(process.env["TL_EFF_FLOW_ORDER_VOCAB"], true);
}

/**
 * TL_EFF_MAP_ANSWER_FIRST (2026-10-23, codex-copilot-proxy answer-first
 * experiment; design: bench/workflows/experiments/2026-10-21-codex-copilot-proxy/
 * drafts/fable-analysis-r16/answer-first-design.md; generality rules 2026-10-24,
 * drafts/fable-analysis-r16/generality-audit.md): the structure map
 * (`TL_EFF_STRUCTURE_MAP`) answers on its CORE evidence instead of requiring
 * every member that names a concern. The flow facets then require
 *
 *   core = the type's header code, every direct member's signature, the state
 *          enums the header is declared in, and the WHOLE bodies of the
 *          members that cover the request's named concerns (structureMap.ts
 *          `coverMembers`: the entry point first, then the member that
 *          accounts for most of what is left),
 *
 * and the first page, which is the core and nothing else, is `act.answer` with
 * its certificate: one call where the map's chain is a discover, a cursor page
 * and an answer. The bodies of the other members stay owed on the head row
 * (`remaining`, optional depth), `limit` stays `capped`, and no `next` is
 * issued; the same request restated in the same task is answered by a receipt
 * whose row lists, as `remaining`, the windows the page left owed that no read
 * has since served (not the map's whole extent). The top-level `advisory` (an existing optional field) states, as
 * facts and in this priority within its byte budget, which member bodies were
 * not served (those of the members that call a requested concern, with their
 * ranges, `via helper` for one that reaches the concern only through a helper of
 * the type, and that every other member is signature-only), the loop guards inside
 * them (the Java loop-guard review), the same-file uses of the constants declared
 * in the served header (each line classified lexically as a `set`, which stores
 * the value, or a `read`, any other use: a comparison, a lookup, an argument of
 * another call; an assignment TO the constant, its initializer, is no use), and the
 * concern calls of each unserved member in source order (calls in different
 * cases of one switch or arms of one if/else chain are marked as alternatives:
 * `[case FULFILLED] / [case DELIVERED]`); it never says what to do, so the
 * agent chooses its own depth.
 *
 * THE INVARIANT. With the flag set, every reply of every chain is one of two things:
 * the answer-first `act.answer` as the FIRST reply (the core served, the advisory with
 * at least its first tier), or — byte for byte — the reply the same request gets with the
 * flag unset. There is no third reply: no chain that runs on the core's requirements
 * after a first reply that did not answer (a "silent relaxation": fewer of the type's
 * lines than the ordinary map, no advisory). The decision is made BEFORE the pack is
 * built and booked (readCodeTaskPack.ts `buildAnswerTaskPack`, at the facet-hook seat): a
 * DRY RUN of the facet hook against the core (`FacetClosureTrial`: the real hook on copies
 * of the selection, no handle, cursor or session state, not counted as a run of the hook,
 * no plan recorded) says what the request's facets would require, and the core is
 * adopted only when its first page holds all of it (`answerFirstPageHolds`) and proves
 * what the contract asks of a page (`answerFirstPageProves`: the code identifiers the
 * request names, and `behavior-body` — the concerns it lists are in a callable's served
 * text and every callable it names has a line of its body shown). A flow whose call sites
 * lie in another function of the file or another file, a second facet whose subject lies
 * elsewhere, a member the core does not hold, a constructor named like the type whose
 * body the page leaves out — each takes the ordinary map, and the request is served
 * exactly as without the flag. Should an adopted page still not ship as the answer (a late
 * pass withdrew a window it cites; not even the first tier of the advisory fits under the
 * ceiling), the facet plan of the ordinary map is recorded again and the reply is a
 * discover that names what the ordinary requirements still need
 * (`restoreOrdinaryFacetPlan`, `rederiveAfterPlanRestore`): the rest of the chain is the
 * ordinary chain's, never the core's. That first reply is then neither of the two above, so
 * the backstop is for what the decision cannot see (a pass added later); the admission
 * estimate (`STRUCTURE_MAP_GROUPED_ADMISSION_MARGIN_BYTES`) and the contract pre-check keep
 * it from being reached by any request measured.
 *
 * WHAT COUNTS. A concern call is, for the cover, the members the facts list and the call
 * index (one rule per type, structureMap.ts `answerFirstCover`): a call on one of the type's
 * collaborator fields — the fields a constructor receives, builds (`this.x = new X(…)`,
 * `self._s = requests.Session()`, `self.x = X(…)`, `_x = x;` to a declared field, a C++
 * initializer list) or conventionally holds (C# `private readonly IFoo _foo;` and the
 * get-only property `public IFoo Foo { get; }`, the C++ members `X* x_;`, `X& x_;`,
 * `std::unique_ptr<X> x_;`, `std::shared_ptr<X> x_;`) — and only when that finds no member
 * at all, a call whose receiver chain or callee names a concern, except a no-argument call
 * on a parameter or local of the member (`req.paymentMethod()`, a record accessor, is no
 * payment call) and a call of the type's own member through `this`/`self` (a helper: the
 * facts follow it one level). A member the request names (`subjectCallableNamesIn`, the
 * code identifiers) that calls a concern is in the cover too, up to the cover's three
 * members; a cover that cannot hold the named members is no cover and the ordinary map
 * is served. The words a request uses to describe the answer's form (`briefly`, `big`,
 * `around`, `call`, `map`, `lines`, `order`, `flow`, 概要, 順番 …: structureMap.ts
 * `ANSWER_FORM_WORDS`) are no concern word of this map; the ordinary map's own terms
 * are unchanged. A request that spells the type's own file name (`Orders.java`) is
 * planned as the same request without it (readCodeTaskPack.ts `withoutNamedFileArtifacts`:
 * requestFacets.ts reads `Orders.java` as member `java` of owner `Orders`, which sends
 * the default path's flow facet to the constructor and its callees; that default behavior
 * is unchanged).
 *
 * WHAT THE BYTES ARE MADE OF. No constant here is tuned to one class. The admission margin
 * (STRUCTURE_MAP_FIT_MARGIN_BYTES, 1,536 B) is the difference of the size preview's own
 * reserves for a pack whose decision is derived later and one whose contract is built
 * (protocol/taskPackSizePreview.ts, 2,048 B and 512 B), and the preview reserve the
 * advisory is planned beside is the second of them. The advisory itself is measured, not
 * allowed for: composed for the whole room the finished pack leaves, attached, and the pack
 * measured again with the advisory on it — by the size preview (`taskPackSizePreview`, the
 * first measurement of the shed ladder's `packWireBytes`) or, for a client whose bodies the
 * preview cannot prove exact, as the plan's estimate plus the advisory's own wire bytes —
 * then recomposed for less (tiers and calls dropped from the end) while it is over the
 * ceiling. No tuned allowance beside it: a pack with no room for the first tier is not the
 * answer-first reply.
 *
 * Effective only for an answer-profile structure map that cannot answer on its
 * first page, under a compact host ceiling (an active pack byte ceiling below
 * 20 KiB: the Copilot CLI's 18,432 B, and VS Code's 14,336 B under
 * TL_TURN_ECONOMY when the core fits it — a 6-step desk answers in one 7.3 KB
 * reply there, the 1,552-line T03 class does not fit it and is left alone), and
 * whose core, certificate and advisory fit the first reply (T03 fits the Copilot
 * CLI's only with TL_EFF_EVIDENCE_PATH_GROUPS's grouped rows, its constructor body
 * then being the last thing the page spends bytes on); otherwise nothing changes
 * for that pack. LANGUAGE REACH: a structure map exists where the type's methods sit
 * inside its range (`structureMapTypeOf`): Java, C#, C++, Python, TypeScript/JavaScript,
 * Kotlin, PHP and Ruby; Go, Rust and C keep their methods outside the type, have no
 * map, and are never touched by this flag; the branch labels and the loop-guard review
 * of the advisory read brace languages (Java only for the review), Python gets the call
 * index without labels. It changes which windows a map REQUIRES, which is observable content
 * and a different contract for the certificate's `request-item:*` obligations
 * (the cited windows are the core's), so it is class (B), default OFF: unset,
 * every reply is byte-identical.
 */
export function effMapAnswerFirstEnabled(): boolean {
  return parseBool(process.env["TL_EFF_MAP_ANSWER_FIRST"], false);
}

/**
 * TL_EFF_HUB_WHOLE: in a construct-receiver wiring pack, the construction hub
 * (the wiring's insertion site, the file the solver must edit to construct
 * and drive the receiver) is served whole up to WIRING_COMPLETE_SURFACE_BYTES
 * as a priority draw, like the produced class's own header, instead of
 * drawing on the bounded extra budget. Measured 2026-10-02 (T13 arm A): the
 * 19.6 KB hub exceeded that 10 KB budget, arrived as a 5.4 KB skeleton, and
 * every cell that edited it natively read it whole first.
 */
export function effHubWholeEnabled(): boolean {
  return parseBool(process.env["TL_EFF_HUB_WHOLE"], false);
}

/**
 * TL_EFF_EDIT_NOTE: an `act.edit` task pack with a non-empty frontier carries
 * one `advisory` sentence saying that `tl_edit_file` edits the served frontier
 * handles without the whole-file Read a native Edit requires first. Measured
 * 2026-10-02 (T13 arm A): most post-pack native Reads were that forced Read,
 * and the cells that edited through `tl_edit_file` had few or none.
 */
export function effEditNoteEnabled(): boolean {
  return parseBool(process.env["TL_EFF_EDIT_NOTE"], false);
}

/**
 * TL_EFF_LIGHT_ANSWER (2026-10-10, small-task cost): the light answer path.
 * An answer question about ONE small file — a fresh `task.epoch:"new"` call
 * naming exactly one existing file (one `targets[]` path, or one directory-
 * qualified path in the query) of at most 4 KiB and 120 lines, in TypeScript,
 * JavaScript, Python, Go, Rust or Ruby, that names no other module and asks one
 * thing about code the file itself contains — skips the pathless locator and
 * is built by the seeded builder and certification tail a caller-supplied
 * target takes; the response leaves out the evidence row's `why` and `symbol`.
 * The decision, certificate and every frozen member are the shared tail's own.
 * Anything else, and everything with the flag OFF (the default), takes the full
 * pipeline byte-for-byte. See features/task-pack/lightAnswer.ts and
 * readCodeTaskPack.ts `lightAnswerTarget`.
 */
export function effLightAnswerEnabled(): boolean {
  return parseBool(process.env["TL_EFF_LIGHT_ANSWER"], false);
}

/**
 * TL_EFF_EDIT_DIET (2026-10-19): the `edit.applied` reply diet. Three cuts,
 * each to bytes the caller already holds or does not use:
 *   - an `applied[].after` window is left out when every replacement the
 *     caller sent for that file landed in it verbatim, exactly once, and the
 *     server rewrote nothing (no escape or whitespace normalization, no CR
 *     line endings, no `target:"all"` fan-out, no elision anchor) — the
 *     window would only echo the caller's own text and the lines it was
 *     served; `applied_note` then says the post-edit state equals the content
 *     sent;
 *   - a verification kit repeats no entry this task's earlier kits already
 *     carried in this lane: only the new or changed entries ride, and the
 *     kit's `note` counts what was left out (the whole-kit `kit_unchanged`
 *     receipt still answers a byte-identical repeat; `task.force_serve:true`
 *     and a new task epoch send the whole kit again);
 *   - a kit that carries a harness `build_command` omits its batched
 *     `next_call` (the bodies stay listed with their handles).
 * Measured on the v0.16.0 decision run 2026-10-18-v016-decision-6t-3, arm A:
 * 227,769 B of `edit.applied` replies, of which about 108.8 KB were
 * `after.body` echoes and 83.6 KB verification kits whose compile_facts,
 * link_set and harness were re-sent on every later edit (6.9-9.6 KB each);
 * one cell followed a kit `next_call` into a 36.5 KB read it never used.
 * Unset, ON for the CLI coding hosts (`cliHost`: Claude Code, Copilot CLI,
 * Codex CLI; server.ts passes `isCliCodingHost`), OFF for every other client,
 * whose replies stay byte-identical. Explicit `0` restores today's reply for
 * every client; explicit `1` turns the diet on for every client.
 */
export function effEditDietEnabled(cliHost = false): boolean {
  return parseBool(process.env["TL_EFF_EDIT_DIET"], cliHost);
}

/**
 * TL_EFF_REPLY_COMPACT (2026-10-23, codex-copilot-proxy wire audit
 * bench/workflows/experiments/2026-10-21-codex-copilot-proxy/drafts/
 * fable-analysis-r16/wire-overhead-audit.md §5.1 "SAFE"): the reply envelope
 * leaves off members that repeat what the reply already says, in one pass
 * after the budget ladder (protocol/wireCompaction.ts `compactReplyEnvelope`,
 * called from protocol/emit.ts). Everything upstream (the pack builder, the
 * ladder, the served-range ledger, the size previews) keeps seeing the full
 * envelope, so which rows and decisions a call produces does not depend on
 * this flag; only the bytes that ship do:
 *   - a `read.task_pack` evidence row's `role:"unknown"`, when the call passed
 *     no `surfaceRoles` (a call that did keeps the value: absence of `role`
 *     is the readback "the selector did not bind", protocol.ts [R4-2]). A
 *     continuation page (a cursor, a `qref` re-pack) carries no scope of its
 *     own, so the task-pack dispatch publishes whether the TASK was first
 *     requested with roles (state/session.ts `rememberTaskQuery`, the qref's
 *     slot, persisted with it) and the page keeps `"unknown"` as its first
 *     page did (`ProtocolCallContext.surfaceRolesPassed`);
 *   - a row's generic `likely_edits` pair (an `inspect-slice` and a
 *     `handle-scoped-edit` hint on the row's own handle, at 0.5/0.4 or
 *     0.85/0.75), replaced by its kinds; any other value is left as it is;
 *   - the informational `reason` of `profile_binding` ("no high-confidence
 *     task-shape marker", "query matched X", ...); advice that tells the
 *     caller what to send (it names `task.profile`) stays;
 *   - the all-zero `excluded_by_reason` of a complete `search.tree`
 *     `scope_report`.
 * An `obligations[]` entry's `path`/`range`/`role` restated from its evidence
 * row is NOT among them: it is a model-behaviour change on edit tasks (the
 * model looks a row up by `handle` to learn where an edit item goes) that no
 * cohort has exercised, so it belongs to TL_EFF_EVIDENCE_PATH_GROUPS and
 * obligations ship whole by default (wireCompaction.ts
 * `restateObligationsFromEvidence`).
 * `server_build` needs no entry here: it already rides the first task pack of
 * a session only (server.ts `attachServerBuildOnce`).
 * Default ON; explicit `0`/`off` restores the previous reply byte-for-byte.
 * Measured on the r18 replies (bytes, the default against the rolled-back
 * reply): T03 none on the answer-declared chain and -32 B on the first page of
 * the profile-omitted one (the binding's reason); T07 -265 B (seven unclassified
 * rows, the generic pair, the reason); T09 -44 B on its first pack and -831 B on
 * its second page (unclassified rows, generic pairs, the reason).
 */
export function effReplyCompactEnabled(): boolean {
  return parseBool(process.env["TL_EFF_REPLY_COMPACT"], true);
}

/**
 * TL_EFF_EVIDENCE_PATH_GROUPS (2026-10-23, same audit §4.2 rank 1): evidence
 * `path` and `handle` once per file. Within one `read.task_pack` reply the
 * rows of a run of consecutive rows on the same `path` (two or more) drop
 * `path` after the first row, and drop `handle` from every row whose handle
 * equals the one on the row above; a row without them IS the file and the
 * handle of the row above. A grouped reply carries `evidence_note`
 * (protocol/evidencePathGroups.ts `EVIDENCE_PATH_GROUP_NOTE`) so the reader,
 * model or program, knows the convention is in force; a reply with no such
 * run is left as it was.
 *
 * Same family, same flag: a plan obligation leaves off the `path`, `range` and
 * `role` the first evidence row of its `handle` carries
 * (wireCompaction.ts `restateObligationsFromEvidence`; a reader restores them
 * from the whole rows with `resolveObligations`). It was in the default-ON
 * TL_EFF_REPLY_COMPACT set until the wire-compaction review of 2026-10-23:
 * an obligation without a `path` makes the model look the row up by `handle`
 * to learn where an edit item goes (r18's Codex wrote every edit item with a
 * `path`), a behaviour change on edit tasks that no cohort has exercised.
 *
 * Measured on the r18 first packs: written in place, T03's 30-row structure map
 * (28 rows of one file on one handle, 2 of another) loses 2,667 B of 17,196
 * (15.5 %, the note paid for); the paged owed rows (one file, a handle per
 * row) lose 230-380 B; T09's two packs lose 141 and 348 B for the grouped rows
 * and 424 and 520 B more for the restated obligations (565 and 868 B in all);
 * T07's first pack saves less than the note costs and ships whole. As built
 * (the saved bytes
 * priced, below), T03's three-reply chain is 48,934 B against 51,475 (-4.9 %),
 * its first page 15,964 B. A reply is grouped only when it saves at least
 * EVIDENCE_PATH_GROUP_MIN_NET_SAVING_BYTES (64 B) net of the note.
 *
 * The bytes that ship are what is budgeted when the flag is on: the pack
 * builder prices the grouped rows (`estimateStructureMapReplyBytes`,
 * `taskPackSizePreview`, `auxiliaryEnumAttachmentSizePreview`) and the emit
 * ladder measures the grouped text, so the bytes the grouping saves can hold
 * more rows or more source (the structure map's first page is admitted one
 * source step larger) and a caller-declared budget binds what ships. A map
 * cannot be shed row by row, and its estimate is not an upper bound of the
 * pack built from it, so the first page's admission keeps
 * STRUCTURE_MAP_GROUPED_ADMISSION_MARGIN_BYTES of headroom (readCodeTaskPack.ts;
 * without it a state store that issues no cursor, which restates the request in
 * `next`, left the ladder only the map itself: a 1.6 KB head where the page is
 * 16 KB). With the flag off nothing is priced, measured or admitted differently.
 *
 * Default OFF: it moves `path`/`handle` off rows that every reader used to
 * find there, which is a wire-contract change for models (an edit item still
 * needs the `path`) as much as for programs, and it adds one optional
 * task-pack field. Unset, the wire is byte-identical.
 */
export function effEvidencePathGroupsEnabled(): boolean {
  return parseBool(process.env["TL_EFF_EVIDENCE_PATH_GROUPS"], false);
}
