/**
 * session.ts — per-workspace session state for reads, edits, and task closure
 * and adaptive session control.
 *
 * Keyed by an absolute workspace root path. Callers must pass the realpath;
 * this module is I/O-free and does not call fs.realpath itself.
 *
 * Ordering uses a monotonic module-level counter, with ONE deliberate
 * exception: idle-TTL session eviction (lastTouchedMs, sweepIdleSessions
 * below) is inherently wall-clock, 2026-07-12b2 — see the `now()` seam.
 * Production reads the real Date.now(); tests inject a fake clock via
 * setClockForTest instead of depending on real elapsed time. This is
 * unrelated to server.ts's BYTE_DETERMINISM rule (SESSION_ID doc comment),
 * which is about not leaking wall-clock values INTO response payloads —
 * eviction only decides whether an internal Map entry survives.
 */

import { createHash } from "crypto";
import type { TaskExecutionContract, TaskVerifyObligation } from "@tokenlighten/types";
import { currentSessionLane, laneScopedKey, rootOfLaneScopedKey } from "../util/laneKey.js";
import { batchEditFrontierEnabled, frontierStrictWritesEnabled, receiptCoverageEnabled } from "../util/flags.js";
import { persistQueryRef, rehydrateQueryRef, rehydrateQueryRefBinding, rehydrateQueryRefHandle, clearPersistedQueryRef } from "./stateHandles.js";
// M1 (2026-09-05 R28 remediation): the ONE production reset for
// packServeLog.ts's served-surface ledger (see `clearServedSurfaces`'s own
// doc comment for why an explicit `task.epoch:"new"` must retire it here, not
// only via `recordServedSurfaces`'s query-token-overlap heuristic). A leaf
// module (imports `util/laneKey.js` only), so this is a one-directional edge
// — no cycle.
import { clearServedSurfaces } from "../util/packServeLog.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PathExpansionEntry {
  count: number;
  lastSha: string;
  /** P2-1 (2026-09-08): projection this expansion was served under — "keep"
   * (comments preserved) vs "elide" (default). wasFullyServed only answers
   * true when a request's own projection matches what is recorded here, so a
   * first comments:"keep" read after an elide-only serve still falls through
   * to real bytes (ruling F3 stays intact). */
  keepComments: boolean;
}

export interface ServedRangeLedgerState {
  fileSha: string;
  /**
   * MERGED view of `spans`, materialized on every record. Drives the
   * `served`/`unserved`/`complete`/`clusters` reporting fields; receipts are
   * decided from `spans` (see servedRangeReceipt).
   */
  ranges: Array<[number, number]>;
  /**
   * F2 (2026-08-02 serve-honesty): the UNMERGED per-serve spans — one entry
   * per contiguous run of file lines a single call actually put on the wire,
   * tagged (F3) with the label of the call that served it. This is the
   * ledger's ground truth; `ranges` is only its merged projection.
   */
  spans: ServedRangeSpan[];
  requests: string[];
  /**
   * ND-4 (2026-08-08 serve honesty): the file's own line count at `fileSha`.
   * Every recording site already knows it, and without it the ledger cannot
   * tell a window the caller HOLDS from a window that lies entirely past EOF
   * and therefore denotes no bytes at all: `spans` are clamped to the file, so
   * a 200-240 request against a 41-line file records the same 41-41 span a
   * genuine 41-41 read does. "its bytes are already in your context" is false
   * for the first and true for the second.
   */
  totalLines: number;
  /**
   * B2 / V12-02 (2026-08-27 delta context, TL_DELTA_CONTEXT): the sha this
   * entry described BEFORE `transformServedRangesAcrossServerEdit` re-projected
   * its spans through an edit this server applied. Present only on an entry the
   * transformation touched, and it is the ONLY thing every delta-serving branch
   * is gated on — with the flag off nothing ever writes it, so those branches
   * are unreachable and the pre-B2 wire is preserved exactly.
   *
   * INTERNAL STATE, NEVER WIRE. Protocol v1 is frozen; delta serving is
   * expressed entirely in the existing `segments[]`/`code_unchanged` +
   * evidence `body`/`prior`/`remaining` vocabulary. This field only decides
   * WHICH already-shipped projection runs.
   */
  deltaFromSha?: string;
  /**
   * FX-V1 (round-20A finding 1, ruling (x), 2026-09-04): file-line spans this
   * session's OWN serves elided — a `doc elided L<a>-<b>` marker
   * (`util/formatCompress.ts`'s `elideDocComments`) the caller genuinely
   * received on the wire, naming the exact lines it stands for — never bytes
   * TL never touched at all.
   *
   * UNMERGED, exactly like `spans` — `_stageElisionGap` (called from
   * `recordServedRange`) pushes an entry the SAME way `recordServedRange`
   * pushes to `spans`: immediately and optimistically, before the funnel
   * knows whether the finalized wire will corroborate it. `id` lets
   * `_settleSessionServeBookings` RETRACT one exact entry if the response was
   * shed before reaching the wire (a governor/cap/response-size cut it after
   * this call staged it) — the same optimistic-write/corroboration-gated-
   * retraction shape `spans` already uses, so a direct in-process caller of
   * `recordServedRange` that never runs a funnel (the unit specs) sees its
   * elided claim exactly as durably as its shipped one.
   *
   * READ ONLY BY `_foreignHandleRangeCovered`. `servedRangeReceipt` (every
   * `prior`/`code_unchanged`/`served_by` claim) is DELIBERATELY elision-blind
   * — a receipt about an elided line must always re-serve, since the caller
   * never actually received those bytes; only WRITE-AUTHORITY coverage (the
   * caller holds the lines' exact positions and TL, not the caller, chose to
   * compress them) may count an elided span as held. Capped the same way
   * `spans` is; fail-safe direction is under-claiming (see
   * `SERVED_RANGE_LEDGER_ELISION_CAP`).
   *
   * FX-W3 (ruling (aa), 2026-09-04) TIGHTENS WHERE THE `id` ABOVE COMES FROM
   * WITHOUT CHANGING THIS FIELD'S SHAPE OR THIS FUNCTION'S ALGORITHM.
   * `_stageElisionGap` still detects a candidate purely by ARITHMETIC — the
   * gap between two `recordServedRange` calls sharing one (call, range) key —
   * never by inspecting served TEXT for marker-shaped lines. What changed is
   * upstream, at the RECORD-TIME call sites in `server.ts`: they used to split
   * their own window into per-span `recordServedRange` calls by re-parsing
   * their OWN rendered output for marker-shaped lines
   * (`servedSpansOfDisplayedText`), which cannot distinguish a genuine
   * `elideDocComments` collapse from a caller's own file content that merely
   * LOOKS like one — round-21A finding 1's forged `/* doc elided L5-250 *\/`
   * literal. They now split using `elideDocCommentsWithWindows`'s own
   * `elided` return value — the exact windows the compressor itself removed,
   * a fact of the renderer — via pure arithmetic (`spansExcludingWindows`),
   * so a candidate `_stageElisionGap` ever sees can only ever correspond to a
   * REAL collapse. The retraction half (`_settleSessionServeBookings`,
   * below) and the CONFIRMATION half (`servedWindowsOf`,
   * `protocol/envelope.ts`) are equally load-bearing: `envelope.ts` no longer
   * extends a corroboration window past what the wire's own declared `range`
   * says by re-parsing the wire body either, so even a genuinely-forged
   * candidate that slipped through would be retracted here for want of a
   * window that reaches it, whenever the response was shed at all.
   */
  elided: ElidedRangeEntry[];
  /**
   * FX-V1: ephemeral (call, range)-scoped cursor `_stageElisionGap` uses to
   * detect a gap between consecutive shipped spans of the SAME (call,
   * window) group — see its doc comment. Internal record-time bookkeeping
   * only: never read outside `recordServedRange`/`_stageElisionGap`, not part
   * of the ledger's receipt surface, and never serialized to the wire.
   */
  _elisionCursor?: { call: number; range: string; next: number };
}

/** One contiguous run of file lines one call actually served, plus its provenance. */
export interface ServedRangeSpan {
  start: number;
  end: number;
  /** F3 audit label, e.g. `slice 1-40 (call #2)`. */
  by: string;
  /**
   * [R5-10] (2026-08-14). Session-unique identity, so the funnel can RETRACT
   * this exact span if the response it was booked for turned out to carry no
   * bytes for it. Identity rather than value equality because two spans of the
   * same window are ordinary (a re-affirmation of an already-held range books
   * one), and retracting the wrong one would delete a genuine serve.
   */
  id: number;
}

/**
 * FX-V1 (round-20A finding 1, ruling (x), 2026-09-04): one file-line span this
 * session's own serve elided (see `ServedRangeLedgerState.elided`). `id`
 * mirrors `ServedRangeSpan.id` — session-unique, so `_settleSessionServeBookings`
 * can retract exactly this entry rather than any other elided span of the
 * same window.
 */
export interface ElidedRangeEntry {
  start: number;
  end: number;
  id: number;
}

/**
 * F3 (2026-08-02 serve-honesty): who served the bytes. Supplied by each
 * recording site so a later receipt can name its own source instead of
 * asserting "served earlier this session" with no way to check.
 */
export interface ServedRangeProvenance {
  /** The read_file mode that served them, e.g. `slice`, `symbol`, `task_pack`. */
  mode: string;
  /** The window the caller asked for, e.g. `1-40`. */
  range: string;
  /** Session-scoped ordinal of the serving call — see beginServeCall. */
  call: number;
}

export interface ArtifactServedRangeState {
  fileSha: string;
  ranges: Array<[number, number, number, number]>;
  servedBy: string[];
}

export interface ArtifactServedRangeReceipt {
  sha: string;
  served: string[];
  complete: boolean;
  served_by?: string;
}

const ARTIFACT_SERVED_RANGE_LEDGER_PATH_CAP = 128;
const ARTIFACT_SERVED_RANGE_LEDGER_RANGE_CAP = 64;
const ARTIFACT_SERVED_RANGE_LEDGER_PROVENANCE_CAP = 64;

export interface ServedRangeLedgerReceipt {
  sha: string;
  served: string[];
  unserved: string[];
  /** Raw lines in this request that were not covered by an earlier serve. */
  added_lines: number;
  requests: number;
  clusters: number;
  complete: boolean;
  /**
   * F3: which earlier call put these bytes on the wire, e.g.
   * `slice 1-40 (call #2)`. Present only on a RECEIPT (servedRangeReceipt);
   * recordServedRange's return value describes the serve happening now and
   * never carries it. ~30 B.
   */
  served_by?: string;
}

/**
 * One structured completion check produced by read_code mode=task_pack and
 * consumed by edit_code closure tracking. `desc` is the human-readable line
 * (mirrors the pack's `checks[]` text); `token`+`glob` make a check
 * machine-verifiable: the check is satisfied when `token` appears literally
 * in a file whose workspace-relative path matches `glob` (either a `*.ext`
 * suffix form or a plain path substring). Checks without a `token` are
 * advisory-only and never reported as open by closure tracking.
 *
 * WIRING variant (`tokens`, exactly 2 entries: [source, dest]): satisfaction
 * was redesigned 2026-07-12b2 (run 12b showed the old both-tokens-within-
 * `proximity`-lines-of-`glob` rule false-opening on a correct layered live
 * solution AND false-satisfying on a comment): the check now closes when a
 * session-edited (or git-detected) file OUTSIDE `sourceDir` contains the
 * SOURCE token in non-comment text — see closureTracking's
 * wiringCheckSatisfied. "Outside `sourceDir`" is MODULE-normalized
 * (2026-07-12c): closureTracking's isUnderSourceDir also treats
 * `include/<mod>/...` and `src/<mod>/...` as the same module (path segments
 * exactly equal to "include"/"src" are dropped before the prefix compare),
 * so a purely intra-module edit split across a C-family include/src layout
 * can no longer false-satisfy the check. `glob` survives only to phrase
 * `desc`'s illustrative "e.g. in <file>" (the attention anchor); `proximity`
 * is no longer read anywhere — see wiringCheckSatisfied and
 * buildWiringCooccurrenceCheck. Case-insensitive, underscore-insensitive
 * normalization applies so `Gyro::isHealthy` matches `is_healthy`. A record
 * carrying `tokens` is machine-verifiable exactly like `token`; a record
 * with neither `token` nor a 2-entry `tokens` is advisory. Records missing
 * `sourceDir` fail closed (never satisfy).
 */
export interface PackCheckRecord {
  id: string;
  desc: string;
  token?: string;
  /** Wiring: exactly 2 tokens, [source, dest] — see the WIRING variant note above. */
  tokens?: string[];
  /** Structural closure: every token must occur in one comment-stripped file matched by glob. */
  allTokens?: string[];
  /** Legacy proximity window — no longer read by satisfaction; kept for `desc` phrasing. */
  proximity?: number;
  glob?: string;
  role?: string;
  /**
   * Wiring: workspace-relative dirname of the SOURCE endpoint. Satisfaction
   * requires the source token in a file NOT under this dir (consumption
   * approximation). Excluded from deriveCheckId (id stability across the
   * 2026-07-12b2 redesign is pinned by closureTracking.spec.ts).
   */
  sourceDir?: string;
}

/**
 * True when a check is machine-verifiable (single `token` OR a 2-token
 * co-occurrence). Lives here — next to the record type — so the epoch merge
 * below and closureTracking's open-check scan share ONE definition of
 * "verifiable"; the two must never drift apart (a record the merge treats as
 * verifiable but the scan ignores would silently stop being tracked).
 */
export function isVerifiableCheck(c: Pick<PackCheckRecord, "token" | "tokens" | "allTokens">): boolean {
  if (typeof c.token === "string" && c.token !== "") return true;
  if (
    Array.isArray(c.allTokens)
    && c.allTokens.length > 0
    && c.allTokens.every((token) => typeof token === "string" && token !== "")
  ) return true;
  return Array.isArray(c.tokens) && c.tokens.length === 2 &&
    typeof c.tokens[0] === "string" && c.tokens[0] !== "" &&
    typeof c.tokens[1] === "string" && c.tokens[1] !== "";
}

/**
 * Content-derived check id: `chk-` + 8 sha256 hex chars over the fields that
 * IDENTIFY a check. Identity is the machine-verifiable content — role + glob
 * + token set (order-insensitive: a co-occurrence pair is symmetric) — or,
 * for an advisory record (no token set), role + desc. `proximity` and a
 * verifiable record's `desc` are mutable detail, NOT identity: a same-task
 * re-emission may reword the desc or widen the window without becoming a
 * different check (the epoch merge then keeps the freshest copy under the
 * same id).
 *
 * Positional ids (`chk-<n>`) are gone because emission order shifts with
 * surface inventory between same-task packs: an epoch merge on a same-index
 * collision replaced an OPEN check with an unrelated one — lastOpenIds then
 * verified the WRONG token — and a re-emitted check landing on a new index
 * accumulated a duplicate instead of refreshing in place.
 */
export function deriveCheckId(r: Omit<PackCheckRecord, "id">): string {
  const tokenSet = Array.isArray(r.allTokens) && r.allTokens.length > 0
    ? ["all", ...r.allTokens].sort()
    : Array.isArray(r.tokens) && r.tokens.length === 2
      ? ["pair", ...r.tokens].sort()
    : typeof r.token === "string" && r.token !== "" ? [r.token] : [];
  const basis = isVerifiableCheck(r)
    ? ["v", r.role ?? "", r.glob ?? "", ...tokenSet]
    : ["a", r.role ?? "", r.desc];
  return `chk-${createHash("sha256").update(basis.join("\u0000")).digest("hex").slice(0, 8)}`;
}

/**
 * A workspace's ACTIVE task_pack "check epoch". A single real-world session
 * routinely calls task_pack several times while working ONE task (re-scoping,
 * pinning paths[], following a partial pack's `next`) — and previously each
 * call REPLACED the check state wholesale, so a later same-task pack that
 * happened to omit a still-open check (e.g. a machine-verifiable style-token
 * check the agent had not yet satisfied) WIPED it, and the agent declared the
 * task solved with that surface untouched (the live false_solved forensic).
 *
 * The epoch model fixes this. Checks accumulate across every pack that belongs
 * to the SAME task — decided by TOKEN OVERLAP between the new pack's query and
 * the epoch's accumulated query tokens (`epochTokens`), so "TicketPriority
 * byTicket badge" still overlaps "Ticket priority enum ONHOLD" (camelCase is
 * split; see `tokenizeForEpoch`). A genuinely NEW task in the same session
 * (zero token overlap on a non-empty query) starts a fresh epoch so stale
 * checks do not haunt it; a queryless/seeded pack never replaces (it merges
 * into, or opens, the current epoch).
 *
 * `checks` and `lastOpenIds` keep their prior meaning (closureTracking.ts reads
 * both), so this shape is a superset of the old one for existing consumers.
 */
export interface PackChecksState {
  /** The query that OPENED this epoch (first pack of the task). "" for a queryless open. */
  epochQuery: string;
  /** Accumulated significant tokens across every query merged into this epoch (see tokenizeForEpoch). */
  epochTokens: string[];
  /** Union (by id) of every merged pack's check records — the fix: a record survives even when a later same-task pack omits it. */
  checks: PackCheckRecord[];
  /** Closure-tracking state: ids reported open by the most recent edit_code response, so the open→satisfied transition fires exactly once. */
  lastOpenIds: string[];
}

export interface ExecutionReclassification {
  from: "answer";
  to: "edit";
  trigger: "create" | "grounded-edit";
  certificate_id: string;
}

/**
 * One write-frontier target, named by handle, by path, or both. "" marks the
 * side that is not (yet) established — an evidence-less frontier handle has
 * `path: ""`; an explicit path-only frontier entry has `handle: ""`. Ticket 1
 * (2026-08-07, serve-honesty fix, no cost claim): lets write_targets /
 * also_admissible be built from ONE paired collection instead of filtering
 * two independently-deduped flat arrays, which can diverge in length with no
 * positional correspondence — a live dogfooded refusal against this file,
 * mid-investigation, observed write_targets handles=2/paths=1 and
 * also_admissible handles=6/paths=4.
 */
export interface HandlePathPair {
  handle: string;
  path: string;
}

/** Runtime fence installed only by an accepted proof-carrying ready contract. */
export interface ExecutionFenceState {
  phase: "prepared" | "acting" | "verifying" | "done" | "revoked";
  certificateId: string;
  taskFingerprint: string;
  /**
   * The query that OPENED this epoch — the same field PackChecksState carries
   * (see its `epochQuery`), for the same reason: `epochTokens` alone can say
   * whether an incoming query belongs to this task but cannot TELL the caller
   * which task the certificate is about. A prepared-stop receipt that names no
   * task is indistinguishable across unrelated suppressions, which is how a
   * live probe read "answer from the certified evidence" as authority to
   * answer a question the certificate had never seen (2026-08-13 forensics).
   */
  epochQuery: string;
  epochTokens: string[];
  terminalAction: "answer" | "edit";
  obligationIds: string[];
  evidenceHandles: string[];
  evidencePaths: string[];
  actionFrontier: string[];
  actionPaths: string[];
  /**
   * {handle,path} pairs for THIS certificate's action frontier — one entry
   * per distinct write target, built directly from the certificate's own
   * evidence so index i is always genuinely one target (see HandlePathPair).
   * actionFrontier/actionPaths above remain the permission predicate,
   * unchanged; this is a parallel LABEL only, read by write_targets in
   * executionRefusal.
   */
  actionTargetPairs: HandlePathPair[];
  /**
   * FX-L (2026-09-03, ruling (r)): the certificate addresses this pack CITED
   * and this session never sent bytes for — `action_frontier` ∪
   * `evidence_handles` MINUS the shipped projection above. Absent when the
   * certificate and the shipped set agree, which is every non-capped pack.
   *
   * NOT a permission field: nothing admits an edit because of it. It exists so
   * the refusal these addresses now produce carries the recovery ruling (r)
   * requires — "the fence STAYS and refuses, and the refusal must carry a
   * recoverable `next` … so it is not refuse-only". `executionRefusal` turns it
   * into a `read_file` re-read of exactly the refused address, which restores
   * residency (`recordServedRange` / the booking pass) and admits the same
   * edit on the next call. That loop IS the T13 anti-desertion property.
   */
  withheldTargets?: HandlePathPair[];
  /** Exact ready change-contract targets batched atomically; never inferred from the broader actionTargetPairs frontier. */
  batchEditTargets: HandlePathPair[];
  challengeCount: number;
  reclassification?: ExecutionReclassification;
  /**
   * C0 (2026-08-02 T05c rep0): the last edit-shaped demand this fence emitted
   * in a refusal's `next_call`, keyed by PATH — stable under handle re-minting.
   * `satisfiedPaths` is filled by recordExecutionEditResult from the paths a
   * SUCCESSFUL edit actually wrote. rep0's discharging batch used FRESH handles
   * (hb01ecktt2j/h7lrxxowq30) for the same two paths the superseded prescribed
   * handles named, so handle identity cannot be the key. A demand whose paths
   * are all satisfied has been discharged: the prescribed step demonstrably
   * ran, and the server must stop claiming "unchanged since previous refusal".
   */
  demand?: {
    id: string;
    paths: string[];
    satisfiedPaths: string[];
    /**
     * The refused TARGETS this demand was prescribed to (refusalTargetKey).
     * "You already ran the prescribed step" is only true for a caller that was
     * actually given that prescription — an unrelated target refused later has
     * no such history, and answering it with that verdict is a false claim
     * that also consumes the discharge the real claimant is owed.
     */
    forTargets: string[];
  };
  /**
   * Wave 4 (2026-07-24 T09/T13 forensics): per-fence discovery-call signature
   * counts for the loop brake. The typestate gate no longer hard-refuses
   * post-prepared reads/searches (that manufactured challenge-flailing and
   * native escapes); only a call repeated with an IDENTICAL signature twice
   * over is refused as a genuine loop.
   *
   * INVARIANT (L1/L2b, 2026-08-08). A count here means "this exact call,
   * against content that has not changed since, ran N times":
   *   - IDENTITY: the key must distinguish every argument that changes which
   *     bytes come back (discoveryCallSignature). A key coarser than the call
   *     turns this counter into a source of FALSE refusals for work that was
   *     never requested — the measured 2026-08-08 defect.
   *   - FRESHNESS: a successful edit under this fence invalidates the premise,
   *     so recordExecutionEditResult CLEARS the map. Nothing else may leave a
   *     stale count standing; there is no other way to reset it short of a new
   *     epoch, which discards the fence entirely.
   */
  discoverySignatures: Map<string, number>;
  /**
   * ND-1 (2026-08-08 serve honesty): call signatures whose earlier, IDENTICAL
   * occurrence provably put no file bytes on the wire — a selector that did
   * not resolve (`mode=symbol` with an absent symbol). Written by the very
   * response path that produced the miss (noteDiscoveryServedNoBytes), so it
   * is observed ground truth rather than a re-derived guess, and read by the
   * loop brake, which must not answer such a repeat with any residency claim.
   * Cleared with `discoverySignatures` on a successful edit: a write may have
   * introduced the very symbol that was missing.
   */
  zeroByteSignatures: Set<string>;
  /**
   * Discovery this pack's OWN response advertised as still available, and the
   * one budget that governs it.
   *
   * `signature`/`remaining`: one exact server-issued follow-up (a surface's own
   * `next_call`) may fill an advertised capability gap, consumed once — callers
   * cannot widen it into a fresh frontier or loop the same zoom.
   *
   * `zoomHandles`/`zoomRemaining` (2026-08-13 defect G): the same response also
   * advertises `remaining_ranges` on its partial surfaces, and a route granting
   * `max_additional_tl_calls > 0` says those zooms are affordable. Before this
   * field the fence refused them — a pack told the caller "here is what I did
   * not serve, ask for it" and then suppressed the ask, which is the
   * self-contradiction that drove measured native escapes. Handle-scoped rather
   * than signature-scoped because the caller legitimately picks WHICH unserved
   * window it needs, not just the one the surface happened to name; bounded by
   * the route's own budget so it cannot become an open discovery frontier.
   */
  sanctionedDiscovery?: {
    signature: string;
    remaining: number;
    zoomHandles?: string[];
    zoomRemaining?: number;
  };
}

/**
 * L2 (2026-08-08 find-honesty): the all-served-find ledger for ONE certificate.
 * See WorkspaceSession.servedFindLedger for why it exists and why it is
 * certificate-scoped.
 */
export interface ServedFindLedgerState {
  /** The certificate this ledger belongs to; a different id resets it. */
  certificateId: string;
  /** How many DISTINCT all-served finds ran under that certificate. */
  occurrences: number;
  /**
   * Result fingerprints (path + matched lines + totals) already answered
   * all-served. A second find with a DIFFERENT query but an IDENTICAL result
   * set is the measured "exact-duplicate" shape (T05c rep2 calls 11/12
   * re-served the same 89 matches under `drv_motor` then `drv_motor.h`), so
   * identity is taken on the RESULT, never on the query string.
   */
  fingerprints: Set<string>;
  /** Byte-selecting call signatures already answered all-served. */
  signatures: Set<string>;
  /** The query string of the first find that produced each fingerprint. */
  firstQueryByFingerprint: Map<string, string>;
}

/** Bounded so a long session cannot grow either set without limit. */
const SERVED_FIND_LEDGER_CAP = 32;

/**
 * TL_SEARCH_DEDUP (DESIGN-v0.15-sf-turn-economy.md §4, W-T-D wave): one
 * recorded `search_files` response, keyed by its canonical fingerprint (see
 * `protocol/searchFamily.ts`'s `searchDedupFingerprint`) in
 * `WorkspaceSession.searchDedupLedger`.
 *
 * This ledger does NOT cache or replay old bytes — the server always
 * recomputes the search fresh, and (with no write in between) a fresh search
 * over the same fingerprint is provably the same result. What this ledger
 * remembers is only enough PROVENANCE to let a repeat's response cite the
 * call that first proved it: `servedBy` is a human-readable label
 * (`search find (call #N)`), never a body snapshot.
 */
export interface SearchDedupLedgerEntry {
  /** The wire `kind` the first serving response carried (`search.matches`, etc). */
  readonly kind: string;
  /** The resolved `search_files` action (`find`, `symbols`, `references`, `tree`). */
  readonly action: string;
  /** F3-style audit label for the first serving call, e.g. `search find (call #2)`. */
  readonly servedBy: string;
  /** The result's own count field at record time (`total_files`/`total`/etc). */
  readonly files: number;
  /**
   * `WorkspaceSession.writeEventSerial` at record time. A lookup whose
   * CURRENT session counter has moved on is stale — some edit landed since —
   * and must be treated as a miss, never as a hit with borrowed provenance.
   */
  readonly writeEventSerial: number;
  /**
   * F3 (2026-09-02 review fix): sha256 (`protocol/searchFamily.ts`'s
   * `searchDedupDigest`) of the FULL fresh body this entry was recorded
   * from. `writeEventSerial` alone only proves "no write went through THIS
   * server's own edit path since" — it says nothing about an external
   * (non-TL) edit to the same files. A repeat's freshly recomputed digest is
   * compared against this value BEFORE a `receipt` is ever attached; any
   * mismatch means the content actually changed (by any means), so the
   * fresh body is served with no receipt and this entry is replaced.
   */
  readonly digest: string;
}

/** Bounded LRU: `searchDedupLookup`/`recordSearchDedupEntry` evict the oldest entry past this. */
const SEARCH_DEDUP_LEDGER_CAP = 64;

/**
 * L1 (2026-08-07): how a create-shaped call named the workspace it writes into.
 * Supplied by the DISPATCHER, which is the only layer that sees the raw call
 * shape and the handle table; the guard never infers it. Absent means the
 * dispatcher could not establish a workspace for this create, which is the
 * same predicate W1's `cwd-required-for-create` refusal keys on.
 */
export type CreateWorkspacePin = "explicit-cwd" | "handle-capability" | "single-root-default";

/** Provenance for a create admitted by its own pin rather than by the frontier. */
export interface ExecutionCreateAuthorization {
  pin: CreateWorkspacePin;
  /** The create targets this authorization covers, exactly as requested. */
  paths: string[];
}

/**
 * FX-L SOFT FRONTIER MARKER (user ruling 2026-09-14, review-findings-6
 * SHOULD-FIX 38): where an applied edit's path stood relative to the LATEST
 * certified decision bound to this lane+task. Projected verbatim onto
 * `EditReclassification.frontier_status` / `AppliedEntry.frontier_status`
 * (`protocol/editFamily.ts`), which carry the normative definitions.
 */
export type CertifiedFrontierStatus = "read-only" | "not-in-frontier" | "answer-decision";

/**
 * The LATEST certified decision this lane was handed, as the CALLER saw it —
 * recorded by `server.ts` from the projected `decision` (protocol/decisionWire.
 * ts) at the one site that also installs the fence, never re-derived here.
 *
 * SCOPE. Lane+workspace, because it lives on `WorkspaceSession` and
 * `getSession` keys on `laneScopedKey` (see `util/laneKey.ts`'s module header:
 * every lane-partitioned store answers "whose call is this?" the same way).
 * Epoch, because BOTH guards clear it on `task.epoch:"new"` exactly where they
 * clear `intentEditObserved` — so "the lane's latest certified decision,
 * produced in this epoch" is a structural property, not a timestamp compare.
 *
 * NOT A PERMISSION RECORD. Nothing admits or refuses an edit because of this
 * by default; FX-L's shipped-bytes fence remains the sole authority (ruling
 * (r)). It exists so an edit the fence admits can SAY where it landed —
 * and, only under `TL_FRONTIER_STRICT_WRITES`, so an operator can opt into
 * refusing there instead.
 */
export interface CertifiedDecisionRecord {
  /** `decision.certificate.id`; "" when the decision carried no certificate. */
  certificateId: string;
  kind: "act.edit" | "act.answer";
  /** `decision.frontier`, verbatim — `act.answer` has none, so this is empty. */
  frontier: ReadonlyArray<{ path: string; writable: boolean }>;
  /**
   * `decision.create_target.path`, when the decision certified one. A create
   * target is an AUTHORIZED write that is absent from the frontier by
   * construction (the file does not exist yet), so it is never marked.
   */
  createTargetPath: string;
  /** `task.id` this decision was served under; "" when none was minted. */
  taskId: string;
  /** `qref` this decision was served under; "" when none was minted. */
  qref: string;
}

/**
 * One derived FX-L soft marker, carried on an ALLOWED guard decision and
 * projected by `protocol/editFamily.ts`. `paths` is every marked target in
 * request order (a mixed batch marks per item); `status` is the FIRST marked
 * target's status, which is what the single top-level receipt reports.
 */
export interface ExecutionFrontierMarker {
  certificate_id: string;
  status: CertifiedFrontierStatus;
  paths: string[];
}

export type ExecutionGuardDecision =
  | {
      allowed: true;
      challenged?: true;
      resetForNewTask?: true;
      /** W5: dispatch an honest existing-wire downgrade for a post-ready full read. */
      postReadyTrim?: true;
      reclassified?: ExecutionReclassification;
      createAuthorization?: ExecutionCreateAuthorization;
      /**
       * FX-L soft frontier marker (user ruling 2026-09-14). Deliberately a
       * SEPARATE field from `reclassified`, not a widening of it: the
       * dispatcher hands `reclassified` to `recordExecutionEditResult`, whose
       * reclassification branch commits `terminalAction:"edit"` and
       * `phase:"verifying"` on the fence. Folding an advisory marker into that
       * struct would silently re-type every marked edit's fence — a behaviour
       * change the ruling does not ask for. This field is read by the wire
       * projection only.
       */
      frontierMarker?: ExecutionFrontierMarker;
    }
  | { allowed: false; refusal: Record<string, unknown> };

/**
 * guardExecutionDiscovery's decision: ExecutionGuardDecision plus exactly one
 * arm. `servedReceipt` (L2a, 2026-08-08) is a NON-error body the dispatcher
 * returns through toolOk — it says "you already hold these bytes", not "you
 * may not have them", so it must never travel as a refusal. Only the discovery
 * guard can produce it; the edit guard's consumers keep the narrower union.
 */
export type ExecutionDiscoveryDecision =
  | ExecutionGuardDecision
  | { allowed: false; servedReceipt: Record<string, unknown> };

export interface WorkspaceSession {
  /** read_code call counts keyed by mode string. */
  readsByMode: Map<string, number>;

  /**
   * Latest task query, exposed only through its workspace-bound opaque qref.
   *
   * G3 (2026-09-08, qref-binding fix): `taskBinding`, when present, is the
   * SAME server-derived task fingerprint `util/packServeLog.ts`'s
   * `executedNextLedgerKey` partitions the executed-next ledger on — see
   * `rememberTaskQuery`/`resolveTaskQueryRefBinding` below.
   *
   * G4 (2026-09-08, qref-task-scope fix): `taskHandle`, when present, is the
   * WIRE `task.id` this epoch's task minted — a DIFFERENT value from
   * `taskBinding` (see `attachTaskQueryRefBinding`'s own doc comment). Lets a
   * later handleless re-pack inject `task_handle` so the requirement/
   * obligation ledger scope (`taskContractStore.ts`) matches the scope an
   * earlier pack of this same task was relocated to.
   */
  activeTaskQuery: { ref: string; query: string; taskBinding?: string; taskHandle?: string } | undefined;

  /** Per-path full-read tracking. Key is workspace-relative or absolute path. */
  fullExpansionsPerPath: Map<string, PathExpansionEntry>;

  /**
   * B2e (2026-08-01 serving-completeness): paths whose most recent mode=full
   * "allow" was CHUNKED (only the first FULL_SERVE_CHUNK_BYTES actually went on
   * the wire). Keyed path -> {sha, keepComments}. decideFullRead records an expansion for every
   * allow, so without this marker wasFullyServed would claim the caller holds
   * bytes the response never carried — the T05c defect (a 52KB single-serve the
   * client clamped, after which every slice answered `code_unchanged`).
   * Fail-safe by construction: an entry only ever makes wasFullyServed answer
   * FALSE, so the worst outcome is one redundant serve.
   */
  partialFullServes: Map<string, { sha: string; keepComments: boolean }>;

  /** Total full-file expansions this session; decays on handle-backed edits. */
  fullExpansionsTotal: number;

  /**
   * DESIGN-v0.8 §C4: total TINY-file full-content expansions this session —
   * a SEPARATE counter from fullExpansionsTotal (tiny files are exempt from
   * PER_PATH_FULL_CAP/PER_TASK_FULL_CAP by design, so they must not share a
   * budget with non-tiny full reads; TINY_TASK_CAP in fullGovernor.ts governs
   * this counter on its own). Never decays — unlike fullExpansionsTotal,
   * there is no "progress refills budget" rule for the tiny governor; it
   * exists purely to stop an agent from loading many whole small files into
   * permanent context.
   *
   * FIX-3a (2026-07-09d forensics): ONLY non-exempt (agent-facing) tiny full
   * expansions land here now. governorExempt calls (readCodePack's explicit
   * paths[] enumeration, via buildSmallFile) used to increment this SAME
   * counter — so an N-file pack silently ate into the budget an agent's own
   * later tiny reads draw down, even though the pack's expansions were never
   * blocked by it. Those now land in tinyFullExpansionsExemptTotal instead.
   */
  tinyFullExpansionsTotal: number;

  /**
   * FIX-3a (2026-07-09d forensics): governorExempt tiny full-content
   * expansions this session — recorded for telemetry (so a trace reflects
   * reality), but never consulted by the TINY_TASK_CAP gate. Kept fully
   * separate from tinyFullExpansionsTotal so pack enrichment (readCodePack's
   * explicit, already one-call-complete paths[] enumeration) cannot erode the
   * agent-facing tiny budget. Never decays, same rationale as
   * tinyFullExpansionsTotal.
   */
  tinyFullExpansionsExemptTotal: number;

  /** Number of handle-backed edit_code completions. */
  handleBackedEdits: number;

  /** Number of edit_code calls that used path/search without a handle. */
  pathOrSearchEditsWithoutHandle: number;

  /** Repeated reads of the same (path, range) pair. Key: `${path}#${range}`. */
  repeatedReadsPerPathRange: Map<string, number>;

  /** Content-hash-bound cumulative line ranges served for each path. */
  servedRangeLedger: Map<string, ServedRangeLedgerState>;

  /** Content-hash-bound sheet ranges served by artifact reads. */
  artifactServedRangeLedger: Map<string, ArtifactServedRangeState>;

  /**
   * DESIGN-v0.15 §6.2 (R4): the parent-full-request exception's index.
   *
   * `state/readRequestStore.ts`'s `markReadRequestOpenness` populates this
   * with a request's `state/stateStore.ts` key, per target path, whenever
   * that request's own settle leaves it INCOMPLETE (D non-empty) — and drops
   * it again once a later settle empties D. `openParentReadRequest` reads it
   * to answer "is there an OPEN full/range/batch read request still owed
   * lines of this path, in THIS (workspace, lane)?" for a later, ORDINARY
   * (non-cursor) read of the same path — the case a plain re-read of one
   * page's exact range, or one symbol inside it, must still carry the
   * parent's `next` while the parent itself has remaining lines (design
   * §6.2's second paragraph: "今回のページだけが既読だった場合は親のDを更新
   * し、残件がある限り次ページを運ぶ").
   *
   * Keyed by STORE KEY, never by value — the lookup always re-loads and
   * re-settles the live record against the CURRENT ledger, so a pointer left
   * behind by an expired/completed/foreign-bound request is simply pruned
   * when next encountered rather than trusted. An INDEPENDENT read (no open
   * parent request exists for its path) finds nothing here and answers with
   * a plain, next-less receipt — R4's headline fix.
   */
  openReadRequests: Map<string, Set<string>>;

  /**
   * [R5-10] (2026-08-14) — spans booked by the CURRENT response, awaiting the
   * funnel's corroboration that the wire actually carried them.
   *
   * Booking is provisional by default and confirmed at the funnel exit
   * (`settleServedRanges`), because "what a serve path intended to serve" and
   * "what the serialized response carries" are different facts and the ledger
   * grounds a claim about the second. F-1b/F-1c both live in that gap: a
   * response that shipped an outline or a body-less entry booked its range
   * anyway, and every later read of those lines was suppressed with a
   * `code-unchanged` receipt for bytes no consumer ever received.
   *
   * Empty between calls. A direct in-process caller of `recordServedRange`
   * (the unit specs) never runs a funnel, so its spans simply stay booked —
   * provisional means "retractable", not "inert".
   *
   * FX-N (ruling (s), 2026-09-03): this list is now also the STAGING SET for
   * the admissible-union / byte-residency writes `recordServedRange` used to
   * perform inline. No second structure was added, deliberately: the two facts
   * ("these lines were booked" and "this path was booked") come from the same
   * statement and must be settled by the same corroboration, so deriving the
   * second from the first makes them unable to disagree. `settleServedRanges`
   * promotes a path iff at least one of its spans survived corroboration.
   */
  pendingServeSpans: Array<{ path: string; id: number; start: number; end: number }>;

  /**
   * FX-V1 (round-20A finding 1, ruling (x), 2026-09-04): elision-gap entries
   * `_stageElisionGap` (called from `recordServedRange`) already wrote
   * OPTIMISTICALLY into their ledger entry's `ServedRangeLedgerState.elided`
   * for the CURRENT response, awaiting the SAME funnel corroboration
   * `pendingServeSpans` awaits — mirroring exactly how a span is written to
   * `state.spans` immediately and only RETRACTED later if unconfirmed. An
   * entry here is retracted from `elided` by `_settleSessionServeBookings`
   * unless the finalized wire's corroboration FULLY contains it; anything the
   * response shed before the wire loses its claim. Empty between calls.
   */
  pendingElidedSpans: Array<{ path: string; id: number; start: number; end: number }>;

  /**
   * FX-W3 (ruling (aa), 2026-09-04, round-21A finding 1): per-path TRUE
   * FILE-LINE end this response's own `recordServedRange` calls declared they
   * were serving, for the CURRENT response — the largest `provenance.range`
   * end seen so far for that path (`_parseHandleLineRange`, the same parse
   * `_stageElisionGap` already runs). RENDERER ACCOUNTING, written
   * automatically by `recordServedRange` for EVERY caller (`server.ts`,
   * `tools/readCodeSmallFile.ts`, `features/task-pack/readCodeTaskPack.ts`,
   * `features/search/find/servedFindEscalation.ts`, `protocol/coverageReceipt.ts`)
   * without any of them needing to know this map exists — never derived from
   * wire text.
   *
   * WHY IT EXISTS. A `mode=full`/`small_file` serve's WIRE `range` is
   * synthesized from DISPLAY line count (`readFamily.ts`), which under-reaches
   * the file whenever a real elision collapsed a comment block — the `seh6`
   * fixture's `range:"1-20"` for a 40-line file whose real spans reach line
   * 40. Round-17/FX-N's fix was to WIDEN the wire's OWN declared window by
   * re-parsing the served BODY for marker-shaped lines; round-21A broke that
   * (a caller's own file content that merely LOOKS like a TL elision marker
   * is indistinguishable from a genuine one to that parse, and combined with
   * an ordinary `budget.bytes` shed it inflated corroboration past what the
   * wire actually carried). This map lets `_settleSessionServeBookings` widen
   * a window `protocol/envelope.ts`'s `servedWindowsOf` ALREADY attributed to
   * a path — never manufacture one from nothing — using a fact recorded
   * in-process, at STAGING time, before any wire-level shed could touch it,
   * and ONLY when `emit.ts` has independently confirmed no shedding occurred
   * on this response at all (see `_settleSessionServeBookings`'s `wasShed`
   * parameter). A shed response never widens through this map either: the
   * declared window then narrows exactly as ruling (aa) requires.
   *
   * RESIDUE SAFETY. Like `pendingServeSpans`/`pendingElidedSpans`, an entry
   * left behind by a call that threw before reaching the funnel survives
   * here until the NEXT response of this session settles — but
   * `_settleSessionServeBookings` only ever widens a window this response's
   * OWN corroboration (`ServeCorroboration.windows`) already produced for
   * that exact path, so a stale entry for a path this response's wire never
   * mentions at all can never manufacture write authority the way an
   * unconditional per-path lookup would (round-17 finding 2's exact class of
   * hazard, avoided the same way that fix avoided it: never promote/widen
   * what THIS response did not itself corroborate). Empty between calls.
   */
  pendingRenderedExtent: Map<string, number>;

  /** Monotonic id source for `ServedRangeSpan.id` ([R5-10]). */
  serveSpanSerial: number;

  /**
   * F3 (2026-08-02 serve-honesty): monotonic ordinal of ledger-recording
   * SERVE CALLS in this session, used to label each recorded span with the
   * call that produced it (`slice 1-40 (call #2)`). One tick per response, not
   * per span — a ranges[] batch that records four windows is still one call.
   */
  serveCallSerial: number;

  /**
   * Total allowFull=true full-content expansions this session. Independent of
   * fullExpansionsTotal (which allowFull deliberately bypasses): this counter
   * exists so ALLOWFULL_TASK_CAP in fullGovernor.ts can bound the bypass —
   * without it, allowFull permits one full read per DISTINCT path with no
   * per-task ceiling at all (the live 10-full-reads pattern). Never decays.
   */
  allowFullExpansionsTotal: number;

  /**
   * 2026-07-19a candidate-pack brake: true while the most recent served task
   * pack was a candidate-list partial whose choice is still pending — no edit
   * yet, no newer non-candidate pack, no explicit taskEpoch:"new". While
   * pending, decideFullRead caps broad (non-tiny) full reads at
   * CANDIDATE_PACK_FULL_CAP across BOTH the plain and allowFull budgets: the
   * pack's served candidate bodies are the disambiguation evidence, and
   * unbounded tree-wide full re-reads are exactly the T13 rep0 runaway
   * (23 full + 23 slice calls, $6.15 vs $2.21 paired).
   */
  candidatePackPending: boolean;

  /** Broad (non-tiny) full reads served while candidatePackPending. */
  candidatePackFullReads: number;

  /** Latest task_pack's structured checks; undefined until a pack is built. */
  packChecks: PackChecksState | undefined;

  /** Proof-carrying ready phase for the active task epoch. */
  executionFence: ExecutionFenceState | undefined;

  /**
   * DESIGN-v0.15-sf-intent-layers.md §4.2 (IL-W2) — layer 2 OBSERVED evidence
   * for `sfIntent.ts`'s `resolveIntent`: has an `edit_file` call already
   * passed `guardExecutionEdit` (i.e. `decision.allowed` — see
   * `guardExecutionEdit`'s exported wrapper) during the CURRENT task epoch?
   * Same lifetime as the task-state ledger: lane/workspace-scoped (this is a
   * per-lane `WorkspaceSession`), cleared by `task.epoch:"new"` in both
   * `guardExecutionDiscovery` and `guardExecutionEditCore`, exactly like
   * `servedFindLedger`/`searchDedupLedger` above. Never cleared by anything
   * else — an edit that lands stays observed for the rest of this task, per
   * §4.2's "以後の pack は書き込み可能 frontier を出す".
   *
   * L1 (2026-09-05 R28 remediation): an edit_file call that ITSELF carries
   * `task.epoch:"new"` is NOT excluded from setting this. `guardExecutionEdit`
   * used to gate on `resetForNewTask !== true`, on the (false, for edit_file)
   * assumption that a reset-tagged decision meant "nothing observed yet" —
   * true for the discovery guard's `taskEpoch:"new"` exit, which returns
   * before any bytes are served, but `guardExecutionEditCore`'s own
   * `taskEpoch:"new"` branch does not short-circuit the edit: it resets the
   * epoch's ledgers and falls through to `{allowed:true,
   * resetForNewTask:true}`, and server.ts's dispatcher then actually applies
   * the edit in the SAME call. The old gate left a genuinely landed edit
   * unrecorded whenever it opened its own epoch. The corrected rule is simply
   * `decision.allowed` — a REFUSED edit (`allowed:false`) still never sets
   * this, reset-tagged or not.
   */
  intentEditObserved: boolean;

  /**
   * FX-L soft frontier marker (user ruling 2026-09-14): the LATEST certified
   * decision this lane was handed in the current epoch. See
   * `CertifiedDecisionRecord` for the scope rules, and
   * `certifiedFrontierMarkerFor` for the one predicate that reads it.
   *
   * Absent means "no certified decision is bound to this lane+epoch" — a plain
   * `targets:[{path}]` read-then-edit flow, or a fresh epoch — and that is
   * exactly the state in which no marker is ever emitted.
   */
  certifiedDecision?: CertifiedDecisionRecord;

  /**
   * VF-5 hand-off: the active task epoch's `TaskChangeContract.verify_obligations`,
   * as last reported by `recordExecutionContract`. Read-only outside this
   * file via `recordedVerifyObligations()` — a kit-less `read.closure` call
   * (no `verification` surface on THIS response) has nothing else to derive
   * obligations from, so `protocol/readFamily.ts`'s `verifyClosureGate` falls
   * back to this instead of treating the closure as clean.
   *
   * LIFETIME (FX-G-A, round-12 finding 1): EXACTLY the task epoch — the same
   * lifetime as `executionFence`. Every site that writes
   * `session.executionFence = undefined` also calls
   * `_clearRecordedVerifyObligations`, INCLUDING the two genuine epoch
   * boundaries (`guardExecutionDiscovery`'s and `guardExecutionEdit`'s
   * `taskEpoch:"new"` branches), which used to clear the fence and the
   * admissible union but leave this field standing. A survivor withheld the
   * NEXT task's `read.closure`, naming a file that task never touched.
   * Writes are REPLACE, never merge: see `recordExecutionContract`'s
   * `verifyObligations` parameter for the empty-array-clears rule.
   */
  recordedVerifyObligations: readonly TaskVerifyObligation[] | undefined;

  /** One-shot advisory for prepared handles invalidated by a later pack. */
  pendingPreparedHandleAdvisory: string | undefined;

  /** Proof provenance retained for serving-ledger receipts after an epoch reset. */
  lastExecutionCertificateId: string | undefined;

  /** Certificates revoked by a concrete challenge in the active task epoch. */
  revokedCertificateIds: Set<string>;

  /**
   * Frontier-union fix (2026-07-24 T10 forensics): cumulative union of
   * admissible edit HANDLES across the current session epoch — every handle
   * that appeared in ANY installed certificate's action_frontier OR
   * evidence_handles, not just the LATEST certificate's. Multi-file work
   * explores several files via successive task_packs (each installing a fresh
   * certificate whose action_frontier is only that pack's target) and then
   * edits an EARLIER one; binding edits to just the most-recent frontier made
   * `edit_file handle=h102` fail with "edit target is outside certificate
   * frontier {h217}" after a later pack served app.py as h217, forcing a
   * wasteful re-pack + challenge + 2-stage edit (~5 turns). guardExecutionEdit
   * consults the LATEST frontier first (unchanged fast path) then this union; a
   * union hit still passes every OTHER gate (phase, terminal-action, challenge,
   * verifying) — this only widens WHICH handles are admissible.
   *
   * Handle classification preserves the wave-4 semantics (see the actionHandles
   * derivation in recordExecutionContract): an `h[0-9a-z]+`-shaped
   * action_frontier entry is a handle regardless of evidence-set membership.
   *
   * Per-site classification of the `executionFence = undefined` writes (spec
   * point 3 — "does this event mean old handles are STALE, or just that no cert
   * is armed right now?"):
   *   - recordExecutionContract INSTALL (`executionFence = {...}`, ~L2418): a
   *     NEW cert REPLACES the old one — union ACCUMULATES (survives). This IS
   *     the fix: the whole point is that ordinary cert replacement keeps
   *     earlier handles editable.
   *   - recordExecutionContract not-ready (`state !== "ready"`, ~L2319): a
   *     non-ready contract only means the latest call did not certify; same
   *     files, same epoch — union SURVIVES (clearing here would wipe it on
   *     every exploratory/discovery pack, the exact opposite of the fix).
   *   - recordExecutionContract pack_unchanged mismatch (`certificate ===
   *     undefined`, ~L2333): pack_unchanged means content is UNCHANGED, so the
   *     handles served earlier stay valid — union SURVIVES.
   *   - guardExecutionDiscovery taskEpoch:"new" (~L3178), guardExecutionEdit
   *     taskEpoch:"new" (~L3364): these are the genuine EPOCH boundaries (a
   *     new task; old handles are now stale) — union is CLEARED here,
   *     alongside revokedCertificateIds, via _clearAdmissibleEditUnion. Epoch
   *     detection lives ONLY in the guards (they run before
   *     recordExecutionContract on every read/search/edit), which is
   *     precisely why the recordExecutionContract clears above must NOT touch
   *     the union.
   *
   * FIFO-capped at ADMISSIBLE_EDIT_UNION_CAP (most-recent entries kept) because
   * sessions are long-lived.
   */
  admissibleEditHandles: string[];

  /**
   * Frontier-union fix: the paths counterpart of admissibleEditHandles — the
   * accumulated explicit action_frontier paths (create targets) plus evidence
   * paths across the epoch, consulted for path-based edits and create. Same
   * accumulate/clear rules and the same cap as admissibleEditHandles.
   *
   * W1 (2026-08-07, create-frontier lifecycle): the union's invariant is that
   * it only ever gains paths this server itself SERVED **or itself WROTE** —
   * recordCreatedEditAdmissibility enrolls a successfully created path at
   * write time. It still never gains a path the caller merely NAMED.
   */
  admissibleEditPaths: string[];

  /**
   * Ticket 1 (2026-08-07, serve-honesty fix): {handle,path} PAIRS accumulated
   * alongside admissibleEditHandles/admissibleEditPaths — never a
   * replacement for them (those two flat arrays stay the permission
   * predicate, untouched). A batch is recorded as genuinely paired only when
   * its handles/paths arrive at matching length (positionally corresponding
   * at the call site); an unequal-length batch is recorded as honestly
   * UNPAIRED entries ({handle,path:""} / {handle:"",path}) rather than
   * guessed. Read only by write_targets/also_admissible in executionRefusal.
   * Same accumulate/clear rules and cap as admissibleEditHandles.
   */
  admissibleEditTargetPairs: HandlePathPair[];

  /**
   * FX-L (2026-09-03, ruling (r)) — PER-ADDRESS BYTE RESIDENCY, the only
   * authority for "does the caller actually hold this file's bytes".
   *
   * A certificate's `action_frontier`/`evidence_handles` name what the pack
   * CITED, which is not the same question: FX-K proved a `budget.bytes` pack
   * can emit a surface row, strip its body, name it in the certificate, and
   * have `recordExecutionContract` lift it into the admissible union — an
   * `edit.applied` against bytes the session never sent.
   *
   * `"shipped"` is written by the two SERVE-TIME producers and by them only:
   * `recordServedEditAdmissibility` (the single post-trim booking pass's
   * `shippedSurfaces(returned)` projection, plus `recordCreatedEditAdmissibility`
   * for a file this server itself wrote) and `settleServedRanges` (the
   * served-range ledger's funnel-exit settlement — FX-N moved this write out of
   * `recordServedRange`, which fires mid-assembly, before the response kind is
   * known; see ruling (s)). `"withheld"` is written by
   * `recordWithheldEditAddresses` from the same booking pass, for exactly the
   * surfaces the FINAL pack emitted WITHOUT a body (Phase-E stripped,
   * Phase-F spliced, SF-seam withheld).
   *
   * MONOTONE TOWARD SHIPPED. `"shipped"` is never downgraded: a later pack that
   * re-emits an already-served path bodyless (a restatement, a demoted echo)
   * does not withdraw bytes the caller demonstrably holds — that direction is
   * the T09/T10 "the gate refuses a handle this server itself served"
   * regression class. Insertion order is preserved on upgrade, so the FIFO cap
   * evicts by first-seen exactly like the admissible union.
   *
   * ABSENT ≠ WITHHELD. An address neither producer has ever seen (a synthetic
   * certificate, a handle minted by a read family that does not route through
   * the booking pass) is `undefined` and stays admissible — the filter refuses
   * only on POSITIVE evidence of withholding, never on missing evidence.
   * Cleared with the admissible union at a genuine epoch boundary.
   */
  editHandleResidency: Map<string, "shipped" | "withheld">;
  /** Path-keyed counterpart of `editHandleResidency`; same writers and rules. */
  editPathResidency: Map<string, "shipped" | "withheld">;

  /**
   * FX-P1 ruling (v) (2026-09-03, round-18A finding 2): `_clearAdmissibleEditUnion`
   * wipes `editHandleResidency`/`editPathResidency` wholesale at every genuine
   * epoch boundary — but the handle table is NOT epoch-scoped, so a handle
   * minted (and marked `withheld`) in the epoch that is about to retire is
   * still redeemable after the wipe, and a plain post-reset lookup then reads
   * `undefined` ("unknown", positive-evidence-only admits). That is a second,
   * standing laundering channel beyond the ordering bug the same finding
   * fixes in `guardExecutionEdit` — ANY later epoch reset (not only one
   * declared on the very edit call that names the address) opens it.
   *
   * These two sets are the retired complement: every key `_clearAdmissibleEditUnion`
   * is about to drop from the live "withheld" maps is folded in HERE first, and
   * survives the reset. `_editAddressResidency` consults them only as a
   * fallback, AFTER the live maps report nothing for the address (so a fresh
   * "shipped" mark in the new epoch — an honest re-read — always wins; see
   * that function). Only `"withheld"` ever needs to survive: a `"shipped"`
   * mark is never authority-in-a-different-epoch on its own, and letting it
   * survive would create exactly the "epoch switch grants authority" hole
   * ruling (v) closes for the opposite (withheld) direction. FIFO-capped like
   * `editHandleResidency` (same `EDIT_RESIDENCY_CAP`), so a long session
   * cannot grow this without bound.
   */
  retiredWithheldEditHandles: Set<string>;
  /** Path-keyed counterpart of `retiredWithheldEditHandles`; same rule. */
  retiredWithheldEditPaths: Set<string>;

  /**
   * R2 (2026-07-25 refusal-forensics): the last few execution-edit refusal
   * signatures (editCallSignature), most-recent last, bounded to
   * EDIT_REFUSAL_SIGNATURE_HISTORY entries. A refused edit whose signature is
   * still present here is a verbatim retry, so the guard answers it with a
   * compact receipt (reason + next_call, ~200 B) instead of the full refusal
   * payload — a re-sent identical edit must not provoke another 17 KB task_pack
   * re-discovery. Epoch boundaries clear it alongside the admissible union
   * (_clearAdmissibleEditUnion); it is edit-scoped, not read/search state.
   */
  recentEditRefusalSignatures: string[];

  /**
   * W6 (2026-08-24): refusal-shape ledger for edit_file.  This deliberately
   * keeps the request identity separate from the older compact-response ring:
   * the former explains an unchanged retry, while the latter only controls
   * payload size.  Entries are FIFO and are reset at taskEpoch:new.
   */
  refusedEditShapes: Array<{ key: string; detail: string; count: number }>;

  /** Workspace-relative paths successfully written by edit_code this session. */
  editedPaths: Set<string>;

  /**
   * TL_SEARCH_DEDUP (W-T-D): monotonic count of successful writes this
   * session — incremented once per `recordEditedPath` call, regardless of
   * whether the written path was already in `editedPaths` (a second write to
   * the SAME path still invalidates a search-dedup entry recorded in
   * between). This is the generic "a write happened" signal the search-dedup
   * ledger stales itself against; nothing else reads it, so it carries no
   * other freshness meaning by design — nothing before this wave needed a
   * write COUNT (as opposed to a write SET or a boolean brake), so none
   * existed to reuse.
   */
  writeEventSerial: number;

  /**
   * Successful single-edit edit_file completions this session (search/replace,
   * handle+content, target=all, pathless, symbol+search — NOT create=true, NOT
   * an edits[] batch, NOT a failed/refused edit). Drives the one-shot edits[]
   * batching hint; see recordSingleEditCompletion and BATCH_HINT_THRESHOLD.
   */
  singleEditCompletions: number;

  /**
   * True once this session has made ANY edits[] batch call (any batch size,
   * success or failure) — the agent has demonstrated it knows the form, so
   * the one-shot batching hint (recordSingleEditCompletion) never fires.
   */
  usedEditsBatch: boolean;

  /**
   * Fix B (2026-07-12c single-query-find-loop forensics): successful single-`query`
   * search_files find completions this session — a `queries:[...]` call
   * does NOT increment this (see the find dispatch in server.ts). Sibling of
   * singleEditCompletions/BATCH_HINT_THRESHOLD; drives the one-shot find
   * batching hint via recordSingleFindCompletion and FIND_HINT_THRESHOLD.
   */
  singleFindCompletions: number;

  /**
   * Fix B: true once the one-shot find batching hint has fired this session
   * — see recordSingleFindCompletion. Unlike usedEditsBatch (which
   * suppresses the edit hint permanently once edits[] has ever been used),
   * there is no such suppression here: live evidence (2026-07-12c)
   * showed an agent using queries:[...] twice yet still making 14
   * single-token find calls, so demonstrated knowledge of the batch form
   * does not reliably stop the wasteful pattern.
   */
  findHintFired: boolean;

  /**
   * W-BATCH-HINT candidate 3 (TL_BATCH_HINTS, default OFF): consecutive
   * single-target read-family calls (read_file with exactly one
   * target/handle, or search_files action=find with exactly one query) this
   * task epoch has issued with no intervening multi-target read-family call.
   * Unlike singleFindCompletions/findHintFired above (a per-session one-shot
   * latch), this streak is scoped to (workspace, lane, task epoch): reset to
   * 0 by any multi-target read-family call AND by `taskEpoch:"new"` — see
   * recordReadFamilySingleTargetCall and guardExecutionDiscovery's epoch-reset
   * block. Read by server.ts at the read_file/search_files dispatch sites
   * only; getSession(workspaceRoot) is already lane-scoped (laneScopedKey),
   * so no separate per-lane map is needed here.
   */
  serialSingleTargetReads: number;

  /**
   * Guard 2 (2026-07-12b decoy-fix forensics): rolling set of concern-anchor
   * tokens harvested from this session's task_pack/locate queries (the SAME
   * FIX-A-filtered identifier-shaped extraction task_pack's own concern gate
   * uses — see readCodeTaskPack.ts's concernAnchorTokens). Lowercased,
   * deduped, capped at MAX_CONCERN_TOKENS with FIFO eviction. Read by
   * resolveSlice's range path (readCodeModes.ts) to warn when a partial
   * slice misses the region the task's own query is actually about.
   */
  concernTokens: string[];

  /**
   * Guard 2: workspace-relative paths that have already carried a
   * concern_note this session — the note fires at most once per (session,
   * path) so re-slicing the same file doesn't get re-warned every call.
   */
  concernNotedPaths: Set<string>;

  /**
   * Feature 1 (2026-07-12b2 "never-read decoy" forensics):
   * workspace-relative paths successfully served content by read_code this
   * session — slice, full, skeleton, symbol, small_file (any contentMode,
   * including outline/defer), auto, plus any task_pack surface whose `code`
   * was populated. Lets the one-shot unread-sibling note (see
   * unreadSiblingNoteFired) tell "never opened" apart from "already saw
   * this file" when scanning an edited file's project family.
   */
  readPaths: Set<string>;

  /**
   * L2 (2026-08-08 find-honesty wave, T05c rep2 forensics): per-certificate
   * ledger of find calls whose ENTIRE match set was already served this
   * session.
   *
   * WHY. The passive `served_note` prose ("every matching file was already
   * served to you this session…") plus per-file `served_this_session:true`
   * fired on SIX separate find responses in one cell and was ignored 6/6 —
   * a trailing string carries no protocol force, so the caller kept
   * re-locating inside content it already held (20 discovery calls before
   * its first edit; the two winning sibling reps self-enforced the same
   * signal and never needed it). This ledger is what turns the 2nd such
   * find into a machine-readable stop with a truthful way forward.
   *
   * SCOPE is the CERTIFICATE, not the session: "you already hold this" is
   * only a protocol-grade claim while the decision it belongs to is live.
   * A new certificate resets the ledger wholesale (see recordAllServedFind),
   * and so does any find that surfaces a NOT-yet-served location — a
   * legitimate scope change is progress and must never inherit escalation
   * pressure earned by a different scope.
   */
  servedFindLedger?: ServedFindLedgerState;

  /**
   * TL_SEARCH_DEDUP (DESIGN-v0.15-sf-turn-economy.md §4, default OFF): the
   * per-task record of already-served `search_files` fingerprints — see
   * `SearchDedupLedgerEntry`'s doc comment for what it holds and why.
   *
   * TASK-scoped like `servedFindLedger`: cleared wholesale on `taskEpoch:
   * "new"` (see `guardExecutionDiscovery`/`guardExecutionEdit`), because "this
   * exact search already ran" is a claim about the CURRENT task, not the
   * session. Individual entries also self-invalidate on any intervening write
   * via `writeEventSerial`, so a write mid-task does not require a second
   * clear call to take effect.
   *
   * Iteration order is LRU-recency order (`searchDedupLookup`/
   * `recordSearchDedupEntry` re-insert on touch), capped at
   * SEARCH_DEDUP_LEDGER_CAP entries.
   */
  searchDedupLedger: Map<string, SearchDedupLedgerEntry>;

  /**
   * F9 (2026-09-02 review fix): the search-dedup ledger's OWN serve-call
   * ordinal, used ONLY to label a first-time entry's `servedBy` provenance
   * string (`search find (call #N)`). Deliberately SEPARATE from
   * `serveCallSerial` above: that counter numbers every read_file serving
   * call server.ts labels a `served_by`/`code_unchanged` receipt against, so
   * a search_files call drawing from it would silently renumber every READ
   * receipt issued afterward whenever TL_SEARCH_DEDUP happens to be on — an
   * observable wire-shape difference from merely enabling a (B) flag, which
   * the flag's own byte-identity contract forbids. See
   * `beginSearchDedupServeCall` below.
   */
  searchDedupCallSerial: number;

  /**
   * Feature 1: true once the one-shot unread-sibling concern note has run
   * for this session — fires at most once, at the session's FIRST
   * successful edit_code completion (single or edits[] batch), regardless
   * of whether a qualifying sibling was found.
   */
  unreadSiblingNoteFired: boolean;

  /**
   * 2026-07-16a re-read-loop forensics: true once a closure-bearing evaluation
   * (computeClosureState's total>0) found EVERY verifiable check already
   * satisfied — set by attachClosure's edit path and the mode=closure read
   * path (closureTracking.ts), both of which recompute this on EVERY
   * closure-bearing call, not just once (unlike unreadSiblingNoteFired
   * above, this is not one-shot: it tracks current state, not "has this
   * ever happened"). While true, the advisory re-read nudges
   * (buildConcernNote in readCodeModes.ts; the unread-sibling note in
   * server.ts's finishEdit) are suppressed — a 20+ turn re-read loop was
   * observed where those notes kept naming "unread" concerns even after
   * mode=closure had already reported complete:true. See
   * markClosureSatisfied / clearClosureSatisfied.
   */
  closureSatisfied: boolean;
  /**
   * One-shot guard for the verification manifest (util/verificationPack.ts):
   * full bodies ride the FIRST qualifying edit/closure response only; later
   * closure calls re-serve handles without bodies. Reset with the session.
   */
  verificationManifestPathsServed: Set<string>;
  /**
   * S1 (2026-08-07 kit-entry-dedupe): rel path -> sha of the WHOLE-FILE bytes
   * this server actually put on the wire for that path inside a verification
   * kit. Keyed by CONTENT, not by path alone: a path whose file changed since
   * that serve has not been served, and saying otherwise is exactly the
   * false-receipt class the 2026-08-01 serve-honesty wave closed. Partial
   * serves (the harness-entry head) never land here — a head is not the file.
   *
   * L2 (2026-08-07): SESSION-scoped, deliberately NOT reset by
   * `taskEpoch:"new"`. "Already in your context" is a fact about the caller's
   * transcript, not about the task: an epoch boundary re-scopes what this
   * server will reason about, and evicts nothing from the caller's context
   * window. Clearing it there manufactured a re-send of bytes the caller
   * demonstrably still held — measured in 2026-08-07-semantic-signal5-1 T05c
   * rep0, where a 9,821 B mock header plus 4,468 B of headers re-shipped once
   * after each of two epoch resets (30,992 B total). The read side's own
   * "you hold these bytes" ledger (`servedRangeLedger`) was never
   * epoch-cleared; this was the sole exception. The content key is what keeps
   * that safe across a longer lifetime: a changed file has a different sha
   * and is served in full.
   */
  verificationSurfacesServed: Map<string, string>;

  /**
   * Feature 4 (2026-07-12b2, 12b/t10r2 stale-worktree forensics): wall-clock
   * ms (module-level `now()`) this session was last touched by getSession —
   * drives the idle-TTL eviction sweep (sweepIdleSessions) so a long-lived
   * server doesn't grow the session map forever.
   */
  lastTouchedMs: number;

  /**
   * Escalation (2026-07-12c ignored-open-check forensics): the SAME wiring check was
   * reported open on 7-8 CONSECUTIVE edit_code responses and the agent
   * concluded anyway — the plain per-edit closure reminder is easy to skim
   * past once it has repeated verbatim a few times. `closureOpenStreak`
   * counts consecutive CLOSURE-BEARING attachClosure evaluations (an active
   * pack with >=1 verifiable check — computeClosureState's `total > 0`,
   * whether `open` is empty or not) whose open check-id set shared at least
   * one id with the immediately preceding such evaluation's set — see
   * recordClosureOpenStreak for the exact continuation/reset rules. Sibling
   * of singleEditCompletions/usedEditsBatch (same one-shot-hint SHAPE: a
   * counter plus a fired flag) but this one tracks IDENTITY continuity
   * across calls, not a plain call count.
   */
  closureOpenStreak: number;

  /**
   * Check-id snapshot from the last CLOSURE-BEARING attachClosure evaluation
   * — the comparison basis recordClosureOpenStreak uses to decide whether
   * the NEXT evaluation continues the same run or starts a fresh one. Empty
   * whenever closureOpenStreak is 0. Deliberately separate from
   * PackChecksState.lastOpenIds (recordClosureReport) — that field mirrors
   * only the MOST RECENT evaluation and exists to fire the open→satisfied
   * transition exactly once; this snapshot instead persists as the
   * continuity basis across a whole run of edits.
   */
  closureOpenStreakIds: string[];

  /**
   * True once the one-shot "ignored open check" escalation note has fired
   * for this session — see recordClosureOpenStreak /
   * CLOSURE_ESCALATION_THRESHOLD. Latches permanently for the rest of the
   * session: unlike closureOpenStreak (which resets to 0 whenever a check
   * closes), a session that has already escalated once does not escalate
   * again even if a LATER, unrelated check also runs
   * CLOSURE_ESCALATION_THRESHOLD+ edits open.
   */
  closureEscalationFired: boolean;

  // -------------------------------------------------------------------------
  // W3 (2026-07-30, dist build-id echo): has THIS session already carried
  // server_build in a task_pack response? Gates a one-time-per-session
  // attach, mirroring the verification-manifest/closure "mark once" fields
  // above — see claimServerBuildAnnouncement.
  // -------------------------------------------------------------------------
  serverBuildAnnounced: boolean;
}

// ---------------------------------------------------------------------------
// Module-level singleton store
// ---------------------------------------------------------------------------

/** Map from workspace root path to its session state. */
const _sessions: Map<string, WorkspaceSession> = new Map();

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Epoch-comparison stopwords: high-frequency filler that carries no task
 * identity, so two unrelated tasks would spuriously "overlap" on them (every
 * feature request says "add", every fix says "fix"). Deliberately small — the
 * min-length-3 filter already removes most noise words; this only adds the
 * short-but-common ones that survive it and the handful of ubiquitous verbs.
 */
const _EPOCH_STOPWORDS: ReadonlySet<string> = new Set([
  "add", "the", "for", "fix", "new", "and", "into", "with", "that", "this",
  "use", "set", "get", "not", "but", "all", "any", "its", "via", "then",
  "update", "support", "make", "from", "code", "file", "task",
]);

// Script-aware query repair keeps content-bearing Japanese terms while
// dropping particles and generic request language that cannot identify repo evidence.
const _EPOCH_CJK_STOPWORDS: ReadonlySet<string> = new Set([
  "これ", "それ", "この", "その", "ため", "よう", "して", "する", "した", "される",
  "いる", "ある", "ない", "ください", "してください", "について", "基づいて", "機能", "追加", "変更", "修正",
]);

const _EPOCH_MIN_TOKEN_LEN = 3;
const _EPOCH_CJK_MIN_TOKEN_LEN = 2;

/**
 * Tokenize a query for EPOCH comparison: split camelCase/PascalCase AND
 * snake_case AND kebab-case boundaries, lowercase, drop tokens shorter than
 * `_EPOCH_MIN_TOKEN_LEN` and the small stopword set. Returns a de-duplicated,
 * order-preserving list.
 *
 * This is what makes a follow-up pack recognized as the SAME task: e.g.
 * "TicketPriority byTicket badge CSS style" tokenizes to
 * ["ticket","priority","ticket","badge","css","style"] → deduped
 * ["ticket","priority","badge","css","style"], which shares "ticket"/"priority"/
 * "badge" with "Ticket priority enum ONHOLD TicketBadge validation
 * statistics" → non-empty overlap → MERGE (never wipe the open check).
 *
 * Self-contained (session.ts stays dependency-free, per the module header):
 * this is a purpose-built epoch tokenizer, not queryShape.ts's distinctiveness-
 * sorted identifier tokenizer — the epoch only needs a set for overlap, so a
 * stable min-length+stopword split is exactly enough and keeps the semantics
 * fully specified in this one file.
 */
export function tokenizeForEpoch(query: string): string[] {
  // 1. Insert a boundary before an uppercase run that follows a lower/digit
  //    (camelCase/PascalCase: "byTicket" -> "by Ticket", "HTTPServer" is
  //    left as one run, which is fine — it de-dupes to itself).
  const spaced = query.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  // 2. Extract ASCII alphanumerics plus deterministic CJK script spans.
  //    Script boundaries split e.g. "認証フローを確認" into the actionable
  //    terms "認証" and "フロー" without embeddings or translation.
  const raw = spaced.toLowerCase().match(
    /[a-z0-9]+|\p{Script=Katakana}[\p{Script=Katakana}ー]*|\p{Script=Han}+|\p{Script=Hiragana}+/gu,
  ) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of raw) {
    const isCjk = /[^\x00-\x7f]/u.test(t);
    if (t.length < (isCjk ? _EPOCH_CJK_MIN_TOKEN_LEN : _EPOCH_MIN_TOKEN_LEN)) continue;
    if (_EPOCH_STOPWORDS.has(t) || _EPOCH_CJK_STOPWORDS.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** True when the two token lists share at least one token. */
function _tokensOverlap(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const set = new Set(a);
  return b.some((t) => set.has(t));
}

// ---------------------------------------------------------------------------
// [T1] Same-task threshold (2026-08-27 prepared-fence P0).
//
// `_tokensOverlap` alone is too permissive a same-task test for
// `newTaskQueryMismatch`: two task_pack queries about UNRELATED subjects
// routinely share at least one token of pure protocol/request vocabulary
// ("query", "coverage", "read", "path", etc.), which `_tokensOverlap` treated
// as proof of a same-task restatement - collapsing a genuine topic change
// into "decision unchanged" and serving the WRONG certified frontier back to
// the caller. (Contrast the pack-cache dedup bar this module does not own -
// readCodeTaskPack.ts's SEMANTIC_DUP_OVERLAP_RATIO=0.8 plus equal requested-
// path/role sets - which was already ratio-based; this one was still
// any-shared-token.)
//
// `_sameTaskQuery` below is the raised bar. It is satisfied by EITHER of two
// independent paths - deliberately not one blended score, so each threshold
// can be reasoned about (and re-tuned) on its own:
//
//   (A) CONTENT-TOKEN BREADTH. Filter both `tokenizeForEpoch` outputs to
//       CONTENT tokens (drop `_PROTOCOL_VOCAB_STOPWORDS`, on top of
//       `tokenizeForEpoch`'s own general stopwords), then require BOTH >= 2
//       shared content tokens AND a shared/smaller-side ratio >= 0.5. The
//       count floor stops one coincidental content word (both queries happen
//       to say "timeout") from passing at a trivially small denominator; the
//       ratio floor stops a long query from dragging in an unrelated short
//       one just by containing it as a small slice of its vocabulary. This is
//       the path an ordinary same-task restatement (reworded, still about the
//       same feature) clears.
//
//   (B) SIGNATURE-TOKEN AGREEMENT. Extract identifier-shaped spans from the
//       RAW query text (`_extractSignatureTokens`: camelCase/snake_case
//       originals, path segments, quoted phrases) and require ANY shared one
//       - reusing `_tokensOverlap`'s existing any-overlap primitive, just
//       over a much higher-precision token set. Two queries that name the
//       same function or file are the same task even when the surrounding
//       prose barely overlaps at all; signature tokens are exactly what
//       `tokenizeForEpoch`'s lowercase-and-split step (needed for (A)'s
//       general matching) erases.
//
// Neither path is satisfiable by protocol vocabulary alone: (A) excludes it
// by construction, and (B)'s shapes (case transition / underscore / path
// separator / quoting) never match a bare protocol noun like "query" or
// "receipt". `tokenizeForEpoch` and `_tokensOverlap` are UNCHANGED by this -
// the new logic is layered on top, so `recordPackChecks`'s own
// `_tokensOverlap` call (a lower-stakes check-record MERGE decision, not an
// execution-fence gate) keeps its existing cheap, eager behavior.
//
// Thresholds tuned against `sameTaskThreshold.spec.ts`'s pairs; revisit both
// together if either drifts.
// ---------------------------------------------------------------------------

/**
 * Generic MCP/protocol-surface nouns: present in nearly every task_pack-
 * shaped query regardless of subject, so they carry no same-task signal for
 * path (A). `task`/`file`/`code` are already excluded by `tokenizeForEpoch`'s
 * own `_EPOCH_STOPWORDS`.
 */
const _PROTOCOL_VOCAB_STOPWORDS: ReadonlySet<string> = new Set([
  "query", "queries", "coverage", "read", "edit", "edits", "editing",
  "search", "mode", "path", "paths", "pack", "handle", "handles",
  "call", "calls", "tool", "tools", "request", "response", "receipt",
  "certificate", "certified", "evidence", "decision", "next", "action",
  "actions", "args", "argument", "arguments", "cwd", "lane", "profile",
  "epoch",
]);

/** Path (A) floor: fewer shared content tokens than this can be pure coincidence regardless of ratio. */
const _MIN_SHARED_CONTENT_TOKENS = 2;
/** Path (A) floor: shared content tokens must also be a majority of the SMALLER side's content vocabulary. */
const _MIN_CONTENT_OVERLAP_RATIO = 0.5;

/** `tokens` (already `tokenizeForEpoch`'d) with protocol/request vocabulary removed - what is left could actually identify a subject. */
function _contentTokens(tokens: readonly string[]): string[] {
  return tokens.filter((t) => !_PROTOCOL_VOCAB_STOPWORDS.has(t));
}

/** Path (A): the count-and-ratio bar over CONTENT tokens - see the constraint comment above `_PROTOCOL_VOCAB_STOPWORDS`. */
function _contentOverlapMeetsBar(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const setA = new Set(a);
  const sharedCount = b.reduce((n, t) => n + (setA.has(t) ? 1 : 0), 0);
  if (sharedCount < _MIN_SHARED_CONTENT_TOKENS) return false;
  return sharedCount / Math.min(a.length, b.length) >= _MIN_CONTENT_OVERLAP_RATIO;
}

/** Longest quoted span or identifier/path run `_extractSignatureTokens` inspects; caps pathological input, not ordinary queries. */
const _MAX_SIGNATURE_SCAN_TOKENS = 128;

/**
 * Path (B): SIGNATURE tokens extracted from RAW query text - substrings
 * shaped like a code identifier, file path, or quoted phrase. Deliberately
 * NOT run through `tokenizeForEpoch`: its lowercase-and-split step is exactly
 * what would destroy the camelCase/snake_case boundary this function keys off
 * of, and it has no notion of "identifier-shaped" for CJK text - CJK
 * same-task matching goes through `_contentOverlapMeetsBar` instead, since a
 * `tokenizeForEpoch` script-run token IS already a content token there.
 *
 *  - quoted/backtick spans (double quote, single quote, or backtick, 2-80
 *    chars): an exact phrase the caller deliberately set off.
 *  - runs containing '/' or ending in a short extension (".ts", ".py", etc.):
 *    path-shaped ("session.ts", "packages/mcp-server/...").
 *  - runs with an internal lower/digit->upper transition or an underscore,
 *    >= 4 letters total: camelCase/PascalCase/snake_case identifiers
 *    ("tokenizeForEpoch", "task_epoch"). A bare capitalized word ("Ticket")
 *    or a very short snake token ("is_ok") is common English-adjacent prose
 *    and is left to path (A) instead.
 *
 * Known imprecision (accepted, see [T1] final report): a hyphen/slash used as
 * plain prose punctuation ("either/or", "same-task") can occasionally look
 * path-shaped. The failure mode is two UNRELATED queries coincidentally
 * matching on that one shared idiom - rare, and no worse than any other
 * single-token heuristic false positive.
 */
function _extractSignatureTokens(query: string): string[] {
  const out = new Set<string>();
  const QUOTED = /"([^"\n]{2,80})"|'([^'\n]{2,80})'|`([^`\n]{2,80})`/g;
  for (const match of query.matchAll(QUOTED)) {
    if (out.size >= _MAX_SIGNATURE_SCAN_TOKENS) break;
    const span = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (span.length >= 2) out.add(span.toLowerCase());
  }
  const RUN = /[A-Za-z_][A-Za-z0-9_./-]{2,}/g;
  for (const raw of query.match(RUN) ?? []) {
    if (out.size >= _MAX_SIGNATURE_SCAN_TOKENS) break;
    const trimmed = raw.replace(/^[./-]+|[./-]+$/g, "");
    if (trimmed.length < 4) continue;
    const isPath = trimmed.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(trimmed);
    const isCamel = /[a-z0-9][A-Z]/.test(trimmed);
    const isSnake = trimmed.includes("_") && trimmed.replace(/_/g, "").length >= 4;
    if (isPath || isCamel || isSnake) out.add(trimmed.toLowerCase());
  }
  return [...out];
}

/**
 * True when `phraseTokens` (>= 2 words, from decomposing ONE side's
 * signature token) appear ADJACENTLY, in order, inside `query`'s tokenized
 * text. Path (C)'s primitive: a snake_case/camelCase identifier and its
 * natural-language spelled-out form are the SAME referent, just cased
 * differently, and `tokenizeForEpoch` already normalizes case/segmentation
 * on both sides — so the phrase need only appear as a contiguous run of
 * `tokenizeForEpoch(query)`'s own tokens, not as a raw substring (which
 * would be thrown off by punctuation/hyphenation between the words).
 */
function _phraseAppearsInQuery(phraseTokens: readonly string[], query: string): boolean {
  if (phraseTokens.length < 2) return false;
  const haystack = tokenizeForEpoch(query);
  if (haystack.length < phraseTokens.length) return false;
  for (let start = 0; start <= haystack.length - phraseTokens.length; start += 1) {
    let matched = true;
    for (let i = 0; i < phraseTokens.length; i += 1) {
      if (haystack[start + i] !== phraseTokens[i]) { matched = false; break; }
    }
    if (matched) return true;
  }
  return false;
}

/**
 * The raised same-task bar `newTaskQueryMismatch` gates on: `incomingQuery`
 * (raw) is the SAME task as `fenceQuery` (raw, `fence.epochQuery`) when ANY
 * of three paths is satisfied - see the constraint comment above
 * `_PROTOCOL_VOCAB_STOPWORDS` for (A) and (B)'s full rationale.
 *
 * (C) CROSS-FORM PHRASE MATCH (2026-08-27, afg2_pack_answer_subquery
 * regression: "increase the premium multiplier rounding in the rating
 * engine" then the answer-profile sub-read "what does premium_multiplier
 * return for a given risk tier" — a real corpus pair, not a hypothetical).
 * Neither (A) nor (B) covers it: content overlap is 2 tokens
 * ("premium"/"multiplier") out of 6, a 0.33 ratio below (A)'s 0.5 floor, and
 * (B) requires a signature token on EACH side, but the FIRST query spells
 * the phrase out in plain prose ("premium multiplier", two words - no case
 * transition, no underscore) while only the SECOND uses the snake_case
 * identifier. Same referent, asymmetric casing convention. (C) catches
 * this: decompose each side's signature tokens back into words
 * (`tokenizeForEpoch` undoes the casing exactly the way it was applied) and
 * check whether that >= 2-word phrase appears, in order, in the OTHER
 * query's own tokens. A coincidental multi-word phrase match across two
 * UNRELATED queries is far less likely than a single-token or ratio
 * coincidence, so this path stays a same-task signal on its own, not
 * something that needs (A)/(B)'s count-and-ratio hedge.
 */
function _sameTaskQuery(
  incomingQuery: string,
  incomingTokens: readonly string[],
  fenceQuery: string,
  fenceTokens: readonly string[],
): boolean {
  const incomingSignature = _extractSignatureTokens(incomingQuery);
  const fenceSignature = _extractSignatureTokens(fenceQuery);
  if (_tokensOverlap(incomingSignature, fenceSignature)) return true;
  if (
    incomingSignature.some((t) => _phraseAppearsInQuery(tokenizeForEpoch(t), fenceQuery))
    || fenceSignature.some((t) => _phraseAppearsInQuery(tokenizeForEpoch(t), incomingQuery))
  ) {
    return true;
  }
  return _contentOverlapMeetsBar(_contentTokens(incomingTokens), _contentTokens(fenceTokens));
}

/**
 * Cap on the accumulated epoch token union (F6). Without it, epochTokens grew
 * O(session length): every same-task pack that MERGEs unions in its fresh
 * query tokens, so a long session merging many overlapping-but-distinct
 * queries accreted an unbounded token list (a 500-merge session reached 500+
 * tokens). The FIRST-SEEN 64 are kept and later overflow is dropped: the
 * earliest tokens are the ones that OPENED the epoch and best define the task's
 * identity, and epoch membership is decided by ANY-overlap (see
 * `_tokensOverlap`) — so keeping the founding tokens preserves the overlap
 * signal that keeps follow-up packs attached, while a 65th-onward niche token
 * from a late re-scope contributes negligible additional overlap power. 64 is
 * generous: a realistic same-task epoch tokenizes to well under it.
 */
const _MAX_EPOCH_TOKENS = 64;

/**
 * Union of two token lists, order-preserving (a first, then new-from-b), capped
 * at `_MAX_EPOCH_TOKENS` keeping the FIRST-SEEN entries (F6). Existing tokens in
 * `a` are never dropped in favor of new ones from `b`; once the cap is reached
 * no further new tokens are appended.
 */
function _unionTokens(a: readonly string[], b: readonly string[]): string[] {
  const out = [...a];
  const seen = new Set(a);
  for (const t of b) {
    if (out.length >= _MAX_EPOCH_TOKENS) break; // first-seen cap: drop overflow.
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  // `a` alone could already exceed the cap only via prior direct assignment
  // (never through this function); clamp defensively so the invariant holds.
  return out.length > _MAX_EPOCH_TOKENS ? out.slice(0, _MAX_EPOCH_TOKENS) : out;
}

/**
 * Bound on the accumulated union of check records in a single epoch. A
 * long-running same-task session could otherwise grow `checks` without limit.
 */
const _MAX_EPOCH_CHECKS = 24;

/**
 * Union `existing` and `incoming` check records BY ID (incoming wins on a
 * collision so a re-emitted check's freshest desc/token/glob is kept — except
 * that an advisory record never overwrites a VERIFIABLE one; see the
 * downgrade guard below), bounded
 * at `_MAX_EPOCH_CHECKS`. When over the bound, SATISFIED checks are evicted
 * first: closureTracking owns satisfaction, so the only satisfaction signal
 * available here is `lastOpenIds` — a record whose id is NOT in `lastOpenIds`
 * is a safe eviction candidate; an OPEN record (id ∈ lastOpenIds) is never
 * silently dropped (the whole point of the epoch). If the bound is still
 * exceeded after evicting every non-open record, the OPEN ones are kept in
 * full (they take precedence over the numeric bound — losing an open check is
 * the exact false_solved bug this epoch model exists to prevent).
 */
function _mergeCheckRecords(
  existing: readonly PackCheckRecord[],
  incoming: readonly PackCheckRecord[],
  lastOpenIds: readonly string[],
): PackCheckRecord[] {
  const byId = new Map<string, PackCheckRecord>();
  for (const r of existing) byId.set(r.id, r);
  for (const r of incoming) {
    // Incoming wins on an id collision (freshest desc/glob/proximity) with one
    // exception: an advisory (token-less) record never overwrites a VERIFIABLE
    // one. Stripping the token set would make the check invisible to
    // computeClosureState's verifiable filter while its id lingers in
    // lastOpenIds — the check would silently stop being tracked even though
    // the underlying edit is still missing.
    const prev = byId.get(r.id);
    if (prev !== undefined && isVerifiableCheck(prev) && !isVerifiableCheck(r)) continue;
    byId.set(r.id, r);
  }
  const merged = [...byId.values()];
  if (merged.length <= _MAX_EPOCH_CHECKS) return merged;

  // Over the bound: evict non-open records first (ids not in lastOpenIds),
  // oldest-first (Map insertion order preserves existing-before-incoming).
  const openIds = new Set(lastOpenIds);
  const open = merged.filter((r) => openIds.has(r.id));
  const nonOpen = merged.filter((r) => !openIds.has(r.id));
  const keepFromNonOpen = Math.max(0, _MAX_EPOCH_CHECKS - open.length);
  // Keep the NEWEST non-open records (they are most likely still relevant);
  // Map order is oldest→newest, so slice from the tail.
  const trimmedNonOpen = nonOpen.slice(nonOpen.length - keepFromNonOpen);
  // Preserve overall insertion order among the survivors for stable output.
  const survivors = new Set([...open, ...trimmedNonOpen]);
  return merged.filter((r) => survivors.has(r));
}

// ---------------------------------------------------------------------------
// Feature 4 (2026-07-12b2, 12b/t10r2 stale-worktree forensics): idle-TTL
// session eviction. A long-lived server accumulates one WorkspaceSession per
// distinct workspace root it has ever seen (worktrees, stale bench runs, ...)
// with no eviction — a PREVIOUS run's worktree session was still listed as
// "active" by otherActiveRoots/Guard 1's root_note. Lazy sweep: only runs
// once the registry exceeds SESSION_EVICT_THRESHOLD entries (a small/typical
// server never pays this cost), and only removes entries idle past
// SESSION_IDLE_TTL_MS.
// ---------------------------------------------------------------------------

const SESSION_EVICT_THRESHOLD = 8;
const SESSION_IDLE_TTL_MS = 24 * 60 * 60 * 1000;

/** Clock seam: production reads the real wall clock; tests swap it via setClockForTest (see this file's header doc). */
let now: () => number = () => Date.now();

/** Test hook: inject a fake clock for idle-TTL eviction tests. */
export function setClockForTest(fn: () => number): void {
  now = fn;
}

/** Test hook: restore the real wall clock after setClockForTest. */
export function resetClockForTest(): void {
  now = () => Date.now();
}

// ---------------------------------------------------------------------------
// Concurrent-agent session lanes (2026-08-07). A stdio MCP connection carries
// no per-call client identity, so several agents multiplexed over ONE server
// process against the SAME workspace root used to share one WorkspaceSession:
// one agent's verifying fence refused another agent's calls by name, a
// taskEpoch:"new" escape destroyed the OTHER agent's verify obligation, and
// served-range receipts claimed bytes "already in your context" that only the
// other agent held. Nothing in the arguments can infer the actor (a topic
// change and a second agent look identical — the epoch-token reset in
// guardExecutionDiscovery proves how easily that heuristic misfires), so
// isolation is explicit and cooperative: dispatch binds each call to the
// caller-declared `lane` and getSession keys on (root, lane). No lane = the
// historical shared session, byte-for-byte.
// ---------------------------------------------------------------------------

// F-V13-3 (2026-08-30): the lane ALS and the composite-key derivation now live
// in the dependency-free leaf `util/laneKey.ts`, so the stores BELOW this layer
// can partition by lane too — packServeLog's served surfaces, priorPackStore's
// obligations, and readCodeTaskPack's three task_pack caches were all keyed on
// the workspace root ALONE, which is exactly how one lane's certificate came to
// fence, and to authorize, another lane's edits. They cannot import THIS module
// (it pulls in util/flags.js; they are deliberate leaves), hence the leaf. The
// two ALS entry points are re-exported so every existing importer of
// state/session (and of its util/session facade) is unchanged, and the key
// derivation is byte-identical — same NUL marker, same "no lane returns the
// root itself" identity.
export { runWithSessionLane, currentSessionLane } from "../util/laneKey.js";

const sessionKeyFor = laneScopedKey;
const rootOfSessionKey = rootOfLaneScopedKey;

/**
 * Evicts sessions idle longer than SESSION_IDLE_TTL_MS, gated on the
 * registry exceeding SESSION_EVICT_THRESHOLD entries. `protectedKey` — the
 * (root, lane) session key actively being fetched/listed by the caller — is
 * NEVER evicted even if idle past the TTL: eviction targets genuinely
 * abandoned sessions, not one that just came back into active use. Never
 * creates a session (no getSession call) — safe to call from
 * otherActiveRoots's read-only path.
 */
function sweepIdleSessions(protectedKey?: string): void {
  if (_sessions.size <= SESSION_EVICT_THRESHOLD) return;
  const cutoff = now() - SESSION_IDLE_TTL_MS;
  for (const [key, session] of _sessions) {
    if (key === protectedKey) continue;
    if (session.lastTouchedMs < cutoff) _sessions.delete(key);
  }
}

function _emptySession(): WorkspaceSession {
  return {
    readsByMode: new Map(),
    activeTaskQuery: undefined,
    fullExpansionsPerPath: new Map(),
    partialFullServes: new Map(),
    fullExpansionsTotal: 0,
    tinyFullExpansionsTotal: 0,
    tinyFullExpansionsExemptTotal: 0,
    handleBackedEdits: 0,
    pathOrSearchEditsWithoutHandle: 0,
    repeatedReadsPerPathRange: new Map(),
    servedRangeLedger: new Map(),
    artifactServedRangeLedger: new Map(),
    openReadRequests: new Map(),
    pendingServeSpans: [],
    pendingElidedSpans: [],
    pendingRenderedExtent: new Map(),
    serveSpanSerial: 0,
    serveCallSerial: 0,
    allowFullExpansionsTotal: 0,
    candidatePackPending: false,
    candidatePackFullReads: 0,
    packChecks: undefined,
    executionFence: undefined,
    intentEditObserved: false,
    recordedVerifyObligations: undefined,
    pendingPreparedHandleAdvisory: undefined,
    lastExecutionCertificateId: undefined,
    revokedCertificateIds: new Set(),
    admissibleEditHandles: [],
    admissibleEditPaths: [],
    admissibleEditTargetPairs: [],
    editHandleResidency: new Map(),
    editPathResidency: new Map(),
    retiredWithheldEditHandles: new Set(),
    retiredWithheldEditPaths: new Set(),
    recentEditRefusalSignatures: [],
    refusedEditShapes: [],
    editedPaths: new Set(),
    writeEventSerial: 0,
    searchDedupLedger: new Map(),
    searchDedupCallSerial: 0,
    singleEditCompletions: 0,
    usedEditsBatch: false,
    singleFindCompletions: 0,
    findHintFired: false,
    serialSingleTargetReads: 0,
    concernTokens: [],
    concernNotedPaths: new Set(),
    readPaths: new Set(),
    unreadSiblingNoteFired: false,
    closureSatisfied: false,
    verificationManifestPathsServed: new Set(),
    verificationSurfacesServed: new Map(),
    lastTouchedMs: now(),
    closureOpenStreak: 0,
    closureOpenStreakIds: [],
    closureEscalationFired: false,
    // W3 (2026-07-30): see the WorkspaceSession field doc above.
    serverBuildAnnounced: false,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Returns the session for (workspace root, current lane), creating it lazily. */
export function getSession(workspaceRoot: string): WorkspaceSession {
  const key = sessionKeyFor(workspaceRoot);
  sweepIdleSessions(key);
  let session = _sessions.get(key);
  if (session === undefined) {
    session = _emptySession();
    _sessions.set(key, session);
  }
  session.lastTouchedMs = now();
  return session;
}

/** Pure qref derivation shared by pre-serve trace correlation and registration. */
export function taskQueryRef(workspaceRoot: string, query: string): string {
  const normalized = query.trim();
  return `q-${createHash("sha256")
    .update(workspaceRoot)
    .update("\0")
    .update(normalized)
    .digest("hex")
    .slice(0, 16)}`;
}

/**
 * Records the newest task query and invalidates the previous qref for this
 * workspace.
 *
 * G2 (2026-09-04): also mirrored onto the durable per-(workspace, lane) slot
 * (`state/stateHandles.ts`'s `persistQueryRef`) so a `qref` minted here still
 * resolves after a server restart or a fresh reconnect — see that module's
 * doc comment for why a single persisted slot, not a table, is the right
 * shape. The in-process field stays authoritative and is written first; the
 * durable mirror is best-effort and never changes what this call returns.
 *
 * G3 (2026-09-08, qref-binding fix): an optional `taskBinding` — the SAME
 * canonical task-fingerprint string `server.ts`'s `canonicalTaskBindingOf`/
 * `canonicalTaskBindingForHandle` derive for the executed-next ledger
 * (`util/packServeLog.ts`'s `executedNextLedgerKey`). Most callers mint the
 * qref before that fingerprint exists (the FIRST pack of an epoch registers
 * its task contract before a handle is minted); `attachTaskQueryRefBinding`
 * below lets a caller stamp it on AFTER the fact, onto the SAME still-active
 * slot, without re-minting the ref or touching the query text.
 *
 * Finding 10 (adversarial review 2, 2026-09-08): both `server.ts` call sites
 * re-issue this on EVERY non-empty resolved query — including a bare-qref
 * RE-PACK of the identical (workspace, query) pair ("a qref-driven pack never
 * reads as a dead end after one replay") — which deterministically re-mints
 * the SAME ref every time. A re-pack's OWN `taskBinding`/`taskHandle` (once a
 * task has any) do not change call to call either, since `mintTaskHandle`
 * RE-EMITS the same token per fingerprint. So a bare 2-arg re-issue used to
 * unconditionally re-persist a bindingless copy of an already-bound slot,
 * immediately clobbered a few lines later by `recordTaskPackExecution`'s own
 * `attachTaskQueryRefBinding` call re-adding the SAME binding — two durable
 * writes doing the work of (at most) one. Carrying the ACTIVE slot's own
 * binding/handle forward when the caller passes none (never overriding an
 * explicit one) and skipping the write entirely when nothing about the
 * persisted shape actually changed closes that gap: a re-pack of an unchanged
 * task now persists nothing here (the on-disk slot is already correct), and
 * `attachTaskQueryRefBinding` a few lines later independently reaches the
 * same "nothing changed" conclusion and also skips — net zero durable writes
 * for the overwhelmingly common continuation case, versus two before. A
 * fresh epoch's first pack (no prior slot to carry anything forward from)
 * still writes twice — the binding genuinely is not known until AFTER this
 * call returns — which is the one case this cannot coalesce away without
 * restructuring the caller's own control flow, a larger change than this
 * NOTE-level finding warrants.
 */
export function rememberTaskQuery(workspaceRoot: string, query: string, taskBinding?: string): string {
  const normalized = query.trim();
  const ref = taskQueryRef(workspaceRoot, normalized);
  const session = getSession(workspaceRoot);
  const previous = session.activeTaskQuery;
  const carriedOver = previous?.ref === ref;
  const effectiveBinding = typeof taskBinding === "string" && taskBinding !== ""
    ? taskBinding
    : (carriedOver ? previous.taskBinding : undefined);
  const effectiveHandle = carriedOver ? previous.taskHandle : undefined;
  const unchanged = carriedOver
    && previous.query === normalized
    && previous.taskBinding === effectiveBinding
    && previous.taskHandle === effectiveHandle;
  session.activeTaskQuery = {
    ref,
    query: normalized,
    ...(typeof effectiveBinding === "string" && effectiveBinding !== "" ? { taskBinding: effectiveBinding } : {}),
    ...(typeof effectiveHandle === "string" && effectiveHandle !== "" ? { taskHandle: effectiveHandle } : {}),
  };
  if (!unchanged) {
    persistQueryRef(workspaceRoot, ref, normalized, effectiveBinding, effectiveHandle);
  }
  return ref;
}

/**
 * Late-bind a task's canonical binding onto a qref this same response ALREADY
 * issued via `rememberTaskQuery` — the one caller (`server.ts`'s
 * `recordTaskPackExecution`) that only learns the fingerprint after minting
 * the task handle, which happens after the qref is minted. A no-op when the
 * session's active slot has moved on to a different ref (a later call already
 * superseded this one before this could run) or holds no query for it at all:
 * this attaches metadata to a still-live qref, never grounds to resurrect a
 * stale one.
 *
 * G4 (2026-09-08, qref-task-scope fix): an optional 4th argument, `taskHandle`
 * — the WIRE `task.id` the SAME minting call produced (`server.ts`'s
 * `withTaskHandle`, read right after this function's caller computes
 * `taskBinding`). A DIFFERENT value from `taskBinding`: that fingerprint
 * partitions the executed-next ledger, while `taskHandle` is what a later
 * handleless `read_file {qref}` re-pack must present as `task_handle` so
 * `taskContractScopeOf` resolves the exact `{lane, taskHandle}` scope
 * `taskContractStore.ts`'s `bindTaskContractHandle` relocated the epoch's
 * requirement/obligation ledger to when this task's handle was first minted.
 * Without it, a bare-qref rebuild's own `taskContractScopeOf` computes
 * `{lane, taskHandle: undefined}` — a scope `bindTaskContractHandle` already
 * vacated — and `buildTaskPack` sees no memory of the epoch's previously
 * proved required roles/concern tokens. Omitted (not even an empty string)
 * when the caller has none to give, matching `taskBinding`'s own convention.
 *
 * Finding 10 (adversarial review 2, 2026-09-08): skips its own durable write
 * when the slot ALREADY carries this exact (query, taskBinding, taskHandle)
 * triple — the ordinary shape of a re-pack continuing an unchanged task,
 * where `rememberTaskQuery` (called a few lines earlier in both `server.ts`
 * call sites) already carried the same binding/handle forward and, for the
 * identical reason, already skipped ITS OWN write. The two functions reach
 * the "nothing changed" conclusion independently but consistently, since both
 * compare against the SAME `session.activeTaskQuery` slot; a genuinely NEW or
 * changed binding/handle (a fresh epoch's first pack) still writes exactly as
 * before.
 */
export function attachTaskQueryRefBinding(
  workspaceRoot: string,
  ref: string,
  taskBinding: string,
  taskHandle?: string,
): void {
  if (ref === "" || taskBinding === "") return;
  const session = getSession(workspaceRoot);
  const active = session.activeTaskQuery;
  if (active === undefined || active.ref !== ref) return;
  // The exact shape the object below is about to take — compared against
  // what is ALREADY there, so "unchanged" means byte-identical, not merely
  // "a handle was passed".
  const nextHandle = typeof taskHandle === "string" && taskHandle !== "" ? taskHandle : undefined;
  const unchanged = active.taskBinding === taskBinding && active.taskHandle === nextHandle;
  session.activeTaskQuery = {
    ...active,
    taskBinding,
    ...(nextHandle !== undefined ? { taskHandle: nextHandle } : {}),
  };
  if (!unchanged) {
    persistQueryRef(workspaceRoot, ref, active.query, taskBinding, taskHandle);
  }
}

/**
 * Resolves only the current workspace-bound qref; old and cross-workspace
 * refs fail closed.
 *
 * G2: an in-process MISS (a restarted server, or the first call of a fresh
 * reconnect) consults the durable slot before failing closed, exactly as
 * `util/handles.ts`'s content-handle `get` consults its own persisted
 * backing. A hit is promoted into this session so every later call in this
 * process takes the fast, in-memory path; a ref that does not match the
 * slot's current contents (superseded, or cleared by `taskEpoch:"new"`) is
 * still a miss, on disk exactly as it already was in memory.
 *
 * G3: promotion also recovers the persisted `taskBinding` (if any), so a
 * cold `resolveTaskQueryRefBinding` call right after this one never has to
 * hit the store a second time.
 *
 * G4: promotion also recovers the persisted `taskHandle` (if any), the same
 * way and for the same reason — see `resolveTaskQueryRefHandle` below.
 */
export function resolveTaskQueryRef(workspaceRoot: string, ref: string): string | undefined {
  const active = getSession(workspaceRoot).activeTaskQuery;
  if (active !== undefined) return active.ref === ref ? active.query : undefined;
  const rehydrated = rehydrateQueryRef(workspaceRoot, ref);
  if (rehydrated === undefined) return undefined;
  const taskBinding = rehydrateQueryRefBinding(workspaceRoot, ref);
  const taskHandle = rehydrateQueryRefHandle(workspaceRoot, ref);
  getSession(workspaceRoot).activeTaskQuery = {
    ref,
    query: rehydrated,
    ...(taskBinding !== undefined ? { taskBinding } : {}),
    ...(taskHandle !== undefined ? { taskHandle } : {}),
  };
  return rehydrated;
}

/**
 * Companion to `resolveTaskQueryRef`: the task binding recorded alongside
 * this qref (see `rememberTaskQuery`/`attachTaskQueryRefBinding`), or
 * undefined for a legacy slot minted before this field existed — the SAME
 * "no stored value degrades to today's per-call inference" posture every
 * other optional enrichment in this module already has. Delegates the
 * in-process-hit-or-rehydrate resolution to `resolveTaskQueryRef` itself so
 * the two accessors can never observe a different outcome for the same ref.
 */
export function resolveTaskQueryRefBinding(workspaceRoot: string, ref: string): string | undefined {
  const active = getSession(workspaceRoot).activeTaskQuery;
  if (active !== undefined) return active.ref === ref ? active.taskBinding : undefined;
  if (resolveTaskQueryRef(workspaceRoot, ref) === undefined) return undefined;
  return getSession(workspaceRoot).activeTaskQuery?.taskBinding;
}

/**
 * G4 (2026-09-08, qref-task-scope fix): companion to `resolveTaskQueryRefBinding`
 * — the WIRE task handle recorded alongside this qref (see
 * `attachTaskQueryRefBinding`'s own doc comment for why this is a distinct
 * value from `taskBinding`), or undefined for a legacy slot minted before
 * this field existed. Same delegation discipline as `resolveTaskQueryRefBinding`:
 * the in-process-hit-or-rehydrate resolution always runs through
 * `resolveTaskQueryRef` itself, so the two accessors can never disagree about
 * the same ref.
 */
export function resolveTaskQueryRefHandle(workspaceRoot: string, ref: string): string | undefined {
  const active = getSession(workspaceRoot).activeTaskQuery;
  if (active !== undefined) return active.ref === ref ? active.taskHandle : undefined;
  if (resolveTaskQueryRef(workspaceRoot, ref) === undefined) return undefined;
  return getSession(workspaceRoot).activeTaskQuery?.taskHandle;
}

/**
 * Explicit epoch boundary for task query inheritance.
 *
 * G2: clears the durable slot too — an epoch boundary must sever a `qref`'s
 * validity on disk exactly as it does in memory, or a stale ref could outlive
 * an explicit `taskEpoch:"new"` purely by surviving a restart in between.
 */
export function clearTaskQueryRef(workspaceRoot: string): void {
  getSession(workspaceRoot).activeTaskQuery = undefined;
  clearPersistedQueryRef(workspaceRoot);
}

// R1/R2 (2026-07-25 refusal-forensics) caps. A typestate refusal now carries
// the way forward (frontier + next_call); these bound its worst-case size to
// ~1.5 KB (handles are short `h`+10-char-base36 ids; paths dominate, so they
// are capped tighter) and the verbatim-retry history to the last few edit
// signatures.
const FRONTIER_HANDLE_CAP = 32;
const FRONTIER_PATH_CAP = 16;
/**
 * FX-L: how many cited-but-unshipped addresses a fence remembers for its
 * recovery `next`. Small on purpose — the `next` it feeds is a re-read call,
 * and a re-read of 8 files is already the largest recovery worth prescribing.
 */
const WITHHELD_TARGET_CAP = 8;
const NEXT_CALL_EDIT_CAP = 8;
// v0.14.1 defect 3 fix (2026-09-07): the F-R8 known-outside-repack recovery
// (executionRefusal's `knownOutsideRepack` branch) re-reads paths this
// session already knows about -- small files, cheap to batch in full, unlike
// the edit-template caps above. Reusing NEXT_CALL_EDIT_CAP silently dropped
// every path past the 8th with no `remaining`/`limit` signal, so a caller
// running that `next` verbatim and then retrying the same edit was refused
// again for the omitted paths. Raised well above the common case; a batch
// that still exceeds it gets an explicit `remaining` list instead of silent
// loss (see the `remaining` construction in executionRefusal).
const KNOWN_OUTSIDE_REPACK_PATH_CAP = 64;
const EDIT_REFUSAL_SIGNATURE_HISTORY = 8;
/** W6: bounded per-task refusal-shape history. */
const EDIT_REFUSAL_SHAPE_LEDGER_CAP = 32;

/** Stable JSON for the W6 shape ledger; object-key order is not meaningful. */
function canonicalEditShape(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalEditShape).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      // `operation_id` is idempotency metadata, and a challenge is the
      // protocol-sanctioned state transition.  Every other argument remains
      // identity-bearing, including cwd/lane/path/search.
      .filter((key) => key !== "operation_id" && key !== "challenge")
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalEditShape(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function noteRefusedEditShape(
  session: WorkspaceSession,
  args: Record<string, unknown> | undefined,
  detail: string,
): { count: number; firstDetail: string } | undefined {
  if (args === undefined || args["challenge"] !== undefined) return undefined;
  const key = canonicalEditShape(args);
  const prior = session.refusedEditShapes.find((entry) => entry.key === key);
  if (prior !== undefined) {
    prior.count += 1;
    return { count: prior.count, firstDetail: prior.detail };
  }
  session.refusedEditShapes.push({ key, detail, count: 1 });
  if (session.refusedEditShapes.length > EDIT_REFUSAL_SHAPE_LEDGER_CAP) {
    session.refusedEditShapes.shift();
  }
  return undefined;
}

/** W6 advisory for edit refusals emitted before the execution-typestate guard. */
export function repeatedEditRefusalAdvisory(
  workspaceRoot: string,
  args: Record<string, unknown>,
  correction: string,
): string | undefined {
  const repeated = noteRefusedEditShape(getSession(workspaceRoot), args, correction);
  if (repeated === undefined) return undefined;
  return `This edit_file shape was already refused in this task (attempt ${repeated.count}); retrying it unchanged cannot change the result. First correction: ${repeated.firstDetail}`;
}

/**
 * Hard ceiling on the advertised-zoom budget a single pack can install
 * (defect G). The route says whether one more call is affordable; a
 * miscomputed or hostile `max_additional_tl_calls` must not be able to turn a
 * prepared certificate back into an open discovery frontier.
 */
const SANCTIONED_ZOOM_BUDGET_CAP = 4;

// Prescription placeholders. A next_call NEVER echoes the caller's own bytes
// back (the caller already holds them; echoing is pure cost — the same
// convention as editFileUnknownArgumentRefusal's corrective call in server.ts).
// A1 (2026-08-04 review): exported because W1's cwd-required-for-create
// refusal in server.ts is the SAME kind of template and must reuse the SAME
// placeholders — it shipped echoing the caller's `content` verbatim, so a
// 24 KiB create drew a measured 24,555-byte refusal.
export const EDIT_SEARCH_PLACEHOLDER = "<exact text to replace>";
export const EDIT_REPLACE_PLACEHOLDER = "<its replacement>";
export const CREATE_BODY_PLACEHOLDER = "<your file body>";
// L4 (2026-08-08): unlike the three placeholders above (which stand in for
// bytes the CALLER already holds), the create-response `read_back`
// affordance needs this one because the server genuinely does not know
// which lines a caller's compiler/test error is pointing at — there is
// nothing of the caller's to echo, only a shape to fill in.
export const READ_BACK_RANGE_PLACEHOLDER = "<start>-<end>";

/**
 * The refusal-detail sentinel for a create outside the certificate path
 * frontier. Shared by guardExecutionEdit (which emits it) and
 * classifyEditRefusal (which classifies on it) so the two can never drift;
 * classifyEditRefusal always replaces it with a terminal classification
 * before it reaches a caller, and it is that classification (not this
 * string) that executionTypestate.spec.ts asserts on.
 */
const CREATE_OUTSIDE_FRONTIER_DETAIL = "create target is outside the certificate path frontier";

/**
 * The live admissible edit set for a refusal's `frontier`: the LATEST
 * certificate frontier first (the current target, always kept), then the
 * most-recent epoch-union entries, de-duplicated and capped. Returns the empty
 * list when the caller passes an empty `primary`/`union` (an answer-terminal
 * refusal authorizes no edits, so its frontier is honestly empty).
 */
function mergeFrontier(primary: readonly string[], union: readonly string[], cap: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: string): boolean => {
    if (value === "" || seen.has(value)) return true;
    seen.add(value);
    out.push(value);
    return out.length < cap;
  };
  for (const value of primary) if (!push(value)) return out;
  for (let i = union.length - 1; i >= 0; i--) if (!push(union[i])) return out;
  return out;
}

/**
 * Ticket 1 (2026-08-07): caps and de-duplicates a {handle,path} pair list in
 * given order, keeping write_targets/also_admissible small the same way
 * mergeFrontier keeps the flat frontier small. A "" side never participates
 * in the collision check (it asserts nothing to collide with) — only a
 * REAL, already-seen handle or path drops a later pair. Reuses
 * FRONTIER_PATH_CAP (the tighter of the two existing frontier caps, since
 * each pair entry carries both a handle and a — typically larger — path).
 */
function capTargetPairs(pairs: readonly HandlePathPair[], cap: number): HandlePathPair[] {
  const out: HandlePathPair[] = [];
  const seenHandles = new Set<string>();
  const seenPaths = new Set<string>();
  for (const pair of pairs) {
    if (pair.handle !== "" && seenHandles.has(pair.handle)) continue;
    if (pair.path !== "" && seenPaths.has(pair.path)) continue;
    if (pair.handle !== "") seenHandles.add(pair.handle);
    if (pair.path !== "") seenPaths.add(pair.path);
    out.push(pair);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * The ONE concrete call that satisfies a refusal's required_action, with real
 * argument values where known — so the model executes it instead of re-packing
 * to relocate the frontier:
 *   - verifying                     -> read_file mode=closure (+cwd)
 *   - edit-ready, handles in scope  -> edit_file edits=[{handle}, ...]
 *   - edit-ready, only paths        -> edit_file path=<frontier path>
 *   - answer-ready / no frontier    -> the challenge shape (the sole admissible
 *                                      tool action; required_action already
 *                                      says "answer from certified evidence").
 * Reuses the {tool, arguments} convention used by execution_contract.next_call.
 */
function frontierNextCall(
  fence: ExecutionFenceState,
  frontierHandles: readonly string[],
  frontierPaths: readonly string[],
  workspaceRoot?: string,
  verifyingEffective: boolean = fence.phase === "verifying",
  remedyRepackPaths?: readonly string[],
): Record<string, unknown> {
  const cwd = workspaceRoot ? { cwd: workspaceRoot } : {};
  if (verifyingEffective) {
    return { tool: "read_file", arguments: { mode: "closure", ...cwd } };
  }
  if (fence.terminalAction === "edit") {
    // C4 (2026-08-02 T05c rep0 idx 155→156): the prescription must be a call
    // edit_file's OWN dispatch accepts. It used to emit bare `{handle}` items,
    // which server.ts's edits[] mapping loop refuses outright ("a range-scoped
    // edits[] entry needs either content ... or search+replace"); the solver
    // executed the prescription verbatim, got that error, and abandoned TL for
    // Bash-heredoc authoring on the next turn. It also omitted `cwd`, which
    // the bench PreToolUse guard independently denies
    // (tokenlighten-cwd-outside-worktree). Both are fixed here, unflagged:
    // prescribing a call this server refuses is a defect with no upside.
    if (frontierHandles.length > 0) {
      return {
        tool: "edit_file",
        arguments: {
          edits: frontierHandles.slice(0, NEXT_CALL_EDIT_CAP).map((handle) => ({
            handle,
            search: EDIT_SEARCH_PLACEHOLDER,
            replace: EDIT_REPLACE_PLACEHOLDER,
          })),
          ...cwd,
        },
      };
    }
    if (frontierPaths.length > 0) {
      return {
        tool: "edit_file",
        arguments: {
          path: frontierPaths[0],
          search: EDIT_SEARCH_PLACEHOLDER,
          replace: EDIT_REPLACE_PLACEHOLDER,
          ...cwd,
        },
      };
    }
    // No frontier to point at (degenerate edit cert) — fall through to the
    // challenge escape rather than emit an empty edits=[] hint.
  }
  if (fence.terminalAction !== "edit" && remedyRepackPaths !== undefined && remedyRepackPaths.length > 0) {
    // A2 (2026-08-01 signal5-2 T10): when the caller wants to EDIT under an
    // answer-terminal fence, the real remedy is a change-scoped re-pack of the
    // caller's own targets — serve it as the executable next_call. The old
    // placeholder challenge buried the actual way forward (taskEpoch:"new") in
    // free-text `detail` and cost a measured 4-turn detour per occurrence.
    return {
      tool: "read_file",
      arguments: { mode: "task_pack", taskEpoch: "new", paths: [...remedyRepackPaths], ...cwd },
    };
  }
  // D2: an obligation-less fence cannot accept a challenge, so prescribing one
  // here would be a call this server refuses. Fall back to the transition that
  // IS unconditionally honoured (guardExecutionEdit/Discovery both handle
  // taskEpoch:"new" before any fence check).
  const escapeChallenge = challengeTemplate(fence, CHALLENGE_LEAD_DECISION);
  if (escapeChallenge === undefined) {
    return { tool: "read_file", arguments: { mode: "task_pack", taskEpoch: "new", ...cwd } };
  }
  return {
    tool: "read_file",
    arguments: {
      ...cwd,
      challenge: escapeChallenge,
    },
  };
}

type Terminality =
  | { kind: "advanceable" }
  | { kind: "terminal"; reason: string; detail: string; unlock: Record<string, unknown> };

/**
 * D2 invariant (2026-08-02): the server never ADVERTISES a transition its own
 * validator refuses — the same rule C4 established for `next_call`.
 *
 * `applyChallenge` requires `challenge.obligation_id ∈ fence.obligationIds`, so
 * a certificate that lists no obligations can never accept a challenge; the
 * historical `?? "surface-content"` fallback advertised one anyway, at every
 * refusal site. Returns `undefined` there, so callers can omit the escape
 * instead of promising it. `expected_action_change` keeps the exact prefix
 * `parseChallenge`'s placeholder guard matches on, and says outright that it
 * must be replaced.
 */
function challengeTemplate(fence: ExecutionFenceState, lead: string): Record<string, unknown> | undefined {
  const obligationId = fence.obligationIds[0];
  if (obligationId === undefined || obligationId === "") return undefined;
  return {
    certificate_id: fence.certificateId,
    obligation_id: obligationId,
    expected_action_change: `<${lead} — REPLACE this placeholder with that sentence>`,
  };
}

const CHALLENGE_LEAD_EVIDENCE = "describe the concrete answer/edit decision that new evidence would change";
const CHALLENGE_LEAD_DECISION = "state the concrete answer/edit decision new evidence would change";

/** The two — and only two — transitions this server accepts out of a live fence. */
function unlockPayload(fence: ExecutionFenceState): Record<string, unknown> {
  // 2026-08-02 review blocker A: applyChallenge requires
  // `challenge.obligation_id ∈ fence.obligationIds`, so an obligation-less
  // fence can NEVER accept a challenge — the historical
  // `?? "surface-content"` fallback advertised a transition this server
  // refuses. Same invariant as C4: never prescribe what dispatch rejects.
  // Advertise `challenge` only when an obligation id exists to name;
  // taskEpoch:"new" is unconditional (guardExecutionEdit honours it before
  // any fence check) and is a complete escape on its own.
  const challenge = challengeTemplate(
    fence,
    "one sentence: the concrete edit/answer decision this call changes — e.g. authoring a NEW verification harness that no served surface can be",
  );
  if (challenge === undefined) {
    return {
      accepted_transitions: ["taskEpoch:new"],
      note: "this certificate lists no challengeable obligation, so `challenge` cannot be accepted — start a new task epoch with read_file mode=task_pack taskEpoch:\"new\"",
    };
  }
  return {
    accepted_transitions: ["challenge", "taskEpoch:new"],
    challenge,
    note: "re-issue THIS call unchanged, with the `challenge` object attached and its `expected_action_change` placeholder REPLACED by your own one-sentence decision (the placeholder text itself is refused); or start a new task epoch with read_file mode=task_pack taskEpoch:\"new\"",
  };
}

/**
 * L2 (2026-08-08 find-honesty) — the certificate-level half of a repeated
 * all-served find's `unlock`: the ONE write target worth prescribing (when the
 * live certificate is edit-terminal and names one) plus the two decision-reset
 * escapes.
 *
 * Routed through this module rather than rebuilt in the search feature for one
 * reason: `challengeTemplate`'s invariant. applyChallenge requires
 * `challenge.obligation_id ∈ fence.obligationIds`, so an obligation-less fence
 * can never accept a challenge, and advertising one would prescribe what
 * dispatch rejects (2026-08-02 review blocker A). Keeping the single source of
 * that decision here means the search-side unlock cannot drift from it.
 *
 * Returns undefined when no certificate is live — there is then nothing to
 * escalate against and the caller must not manufacture an unlock.
 */
export function servedFindCertificateUnlock(workspaceRoot: string): {
  editTargetHandle?: string;
  editTargetPath?: string;
  acceptedTransitions: string[];
  challenge?: Record<string, unknown>;
} | undefined {
  const session = getSession(workspaceRoot);
  const fence = session.executionFence;
  if (fence === undefined) return undefined;
  const acceptedTransitions: string[] = [];
  let editTargetHandle: string | undefined;
  let editTargetPath: string | undefined;
  if (fence.terminalAction === "edit") {
    const pair = fence.actionTargetPairs.find((entry) => entry.handle !== "")
      ?? [...session.admissibleEditTargetPairs].reverse().find((entry) => entry.handle !== "");
    if (pair !== undefined) {
      editTargetHandle = pair.handle;
      if (pair.path !== "") editTargetPath = pair.path;
    } else {
      const handle = fence.actionFrontier[0] ?? session.admissibleEditHandles.at(-1);
      if (handle !== undefined) editTargetHandle = handle;
      const path = fence.actionPaths[0] ?? session.admissibleEditPaths.at(-1);
      if (path !== undefined) editTargetPath = path;
    }
    if (editTargetHandle !== undefined) {
      acceptedTransitions.push(`edit_file handle=${editTargetHandle}`);
    }
  }
  const challenge = challengeTemplate(fence, CHALLENGE_LEAD_DECISION);
  if (challenge !== undefined) acceptedTransitions.push("challenge");
  acceptedTransitions.push("taskEpoch:new");
  return {
    ...(editTargetHandle !== undefined ? { editTargetHandle } : {}),
    ...(editTargetPath !== undefined ? { editTargetPath } : {}),
    acceptedTransitions,
    ...(challenge !== undefined ? { challenge } : {}),
  };
}

/**
 * C1 (2026-08-02 T05c rep0 forensics). A refusal is TERMINAL when no execution
 * of its own `required_action` can ever change the predicate that refused.
 * Exactly two classes qualify today, both deliberately narrow:
 *
 *  1. A create target outside the certificate path frontier. `actionPaths` and
 *     `admissibleEditPaths` only ever gain paths the server SERVED (three
 *     serve-time sites, no write-time site), and a file that does not exist
 *     yet can never be served — so the demanded frontier batch is a no-op with
 *     respect to the gate. This is the formal statement of the
 *     unsatisfiability rep0 spent ~20 turns discovering empirically.
 *  2. A demand this fence emitted that has since been fully discharged: the
 *     client executed the prescribed step, it landed, and the target is STILL
 *     inadmissible. An executed prescribed step is an authenticated
 *     transition; if it did not unlock, the server must stop claiming it will.
 *
 * Rule 2 is checked FIRST: once the prescribed step demonstrably ran, that is
 * the stronger and more actionable statement about why this refusal is stuck.
 * Everything else stays `advanceable` — including the `acting`-phase refusal
 * ("edits are allowed only from prepared phase"), deliberately out of scope.
 */
function classifyEditRefusal(
  fence: ExecutionFenceState,
  args: Record<string, unknown>,
  detail: string | undefined,
): Terminality {
  const demand = fence.demand;
  // 2026-08-02 review round 2 (P1-2): identity is the REFUSED TARGET, not the
  // prescription. "You already ran the prescribed step" is a statement about a
  // specific caller's history — it is true only for a target this demand was
  // actually prescribed to. An unrelated target refused after someone else's
  // discharge was never given that step, so it gets a live prescription; the
  // discharge stays banked for the caller who is owed it.
  if (
    demand !== undefined
    && demand.forTargets.includes(refusalTargetKey(args))
    && demand.paths.length > 0
    && demand.paths.every((candidate) => demand.satisfiedPaths.includes(candidate))
  ) {
    return {
      kind: "terminal",
      reason: "prescribed-step-executed-target-still-inadmissible",
      detail: `the prescribed frontier batch already ran (${demand.paths.join(", ")} written) and this target is still outside the certificate frontier; re-running it cannot change that`,
      unlock: unlockPayload(fence),
    };
  }
  // v0.14.1 defect 1 fix (2026-09-07): `detail === CREATE_OUTSIDE_FRONTIER_DETAIL`
  // alone is unambiguous -- session.ts sends that exact sentinel `detail` from
  // exactly two create-admission-failure call sites (the answer-fence branch
  // and guardExecutionEditCore's create branch), both already create-triggered
  // by construction. Dropping the redundant `isCreateEditRequest(args)` guard
  // is what lets a per-item edits[] create (which `isCreateEditRequest`
  // deliberately does not recognise -- see its own doc comment) reach this
  // SAME terminal classification instead of falling through to the generic
  // frontier/challenge prescription, which would point the caller at an
  // unrelated already-in-frontier file.
  if (detail === CREATE_OUTSIDE_FRONTIER_DETAIL) {
    const target = requestedEditPaths(args)[0] ?? "this create target";
    // D2 fix (2026-08-06, P5-F3): a brand-new create target can never be
    // grounded by `challenge` -- challenge only contests evidence THIS
    // server already served, and mints no create authority. That is true
    // whether the live fence is answer-terminal or edit-terminal (a
    // verifying-phase harness-authoring refusal is the identical shape,
    // and executionRefusal's next_call must agree -- see the matching fix
    // there). Only a read/contract transition (taskEpoch:"new", which
    // re-derives create_target) can ever admit this path, so advertise
    // exactly that -- never `challenge` -- regardless of
    // fence.terminalAction. Previously this branch fell through to
    // unlockPayload for every non-answer fence, which prescribed a
    // `challenge` this exact create request cannot be unlocked by (the
    // 2026-08-04-semantic-signal5-1 T05c/T10 dead-end loop).
    //
    // W1 INVARIANT (2026-08-07, create-frontier lifecycle): this branch can
    // only ever be about a path this server has NOT written. A create that
    // SUCCEEDS is enrolled into the admissible union at write time
    // (recordCreatedEditAdmissibility, called by the dispatcher's create arm
    // in server.ts), so the follow-up edit of a just-created file is admitted
    // by the frontier-membership checks in guardExecutionEdit and never
    // reaches any refusal. "can never enter this certificate's path frontier"
    // below therefore states a property of UNWRITTEN targets only; the union
    // the frontier is merged with holds what this server served OR wrote.
    return {
      kind: "terminal",
      reason: "create-target-not-servable",
      detail: `create target ${target} can never enter this certificate's path frontier (the frontier only holds paths this server served); executing the frontier batch will not change that`,
      unlock: {
        accepted_transitions: ["read_file mode=task_pack taskEpoch:new"],
        note: "challenge and taskEpoch:new may rebind create authority only through a read/contract transition; do not attach either field to this edit_file create",
      },
    };
  }
  return { kind: "advanceable" };
}

/**
 * The terminal prescription: the caller's OWN call plus the advertised
 * `challenge`. Bodies are placeholders, never the caller's bytes — that is the
 * difference between a ~600 B refusal and an ~8 KB one.
 */
function terminalNextCall(
  args: Record<string, unknown>,
  challenge: unknown,
  workspaceRoot?: string,
): Record<string, unknown> {
  const explicitPath = typeof args["path"] === "string" && args["path"] !== "" ? args["path"] : undefined;
  const derivedPath = requestedEditPaths(args)[0];
  const derivedHandle = requestedEditHandles(args)[0];
  const target: Record<string, unknown> = explicitPath !== undefined
    ? { path: explicitPath }
    : derivedPath !== undefined
      ? { path: derivedPath }
      : derivedHandle !== undefined
        ? { handle: derivedHandle }
        : {};
  const body: Record<string, unknown> = isCreateEditRequest(args)
    ? { create: true, content: CREATE_BODY_PLACEHOLDER }
    : { search: EDIT_SEARCH_PLACEHOLDER, replace: EDIT_REPLACE_PLACEHOLDER };
  return {
    tool: "edit_file",
    arguments: {
      ...target,
      ...body,
      ...(challenge !== undefined ? { challenge } : {}),
      ...(workspaceRoot ? { cwd: workspaceRoot } : {}),
    },
  };
}

/**
 * Stable id for the edit-shaped demand a refusal emitted. Keyed on the demand's
 * PATHS, not its handles (2026-08-02 review blocker B): the same file set
 * re-prescribed through re-minted handles is the SAME demand, which is the
 * whole point of clause 5.
 */
function demandIdFor(paths: readonly string[]): string {
  return `dmd-${createHash("sha256").update([...paths].sort().join(",")).digest("hex").slice(0, 8)}`;
}

/** Stable identity of the TARGET a refusal was about (its handles ∪ paths). */
function refusalTargetKey(args: Record<string, unknown>): string {
  return demandIdFor([...requestedEditPaths(args), ...requestedEditHandles(args)]);
}

/** How many distinct refused targets one demand tracks before evicting oldest. */
const DEMAND_TARGET_CAP = 8;

function executionRefusal(
  session: WorkspaceSession,
  fence: ExecutionFenceState,
  detail?: string,
  workspaceRoot?: string,
  opts?: {
    editContext?: boolean;
    remedyRepackPaths?: readonly string[];
    /** The caller's own edit_file arguments — read only to classify terminality. */
    editArgs?: Record<string, unknown>;
    /** Resolves a served handle to its workspace-relative path (demand ledger). */
    resolveHandlePath?: (handle: string) => string | undefined;
    /**
     * ND-3 (2026-08-08): this refusal is the DISCOVERY LOOP BRAKE. Its
     * accepted transitions are not a typestate refusal's: the braked call is
     * terminal for its exact shape, and the only things that re-open it are a
     * different selection, a successful edit_file (which clears the counter),
     * or a challenge. Measured at 67da02c2: the shape this flag replaces
     * advertised required_action "verify-with-closure-or-diff", a
     * `read_file mode=closure` next_call and an allowed_verification_calls
     * pair — and executing closure ("no-registered-checks"), diff, find or
     * tree cleared nothing, so every machine field pointed at a recovery that
     * does not exist while the prose `detail` already told the truth.
     */
    discoveryBrake?: boolean;
    /** ND-3: a concrete, executable rescope call the ledger could name, if any. */
    brakeRescopeNextCall?: Record<string, unknown>;
    /**
     * F-R8 (W8-C, 2026-08-22): set ONLY when every currently-refused edit
     * target (handle AND path) independently resolves through
     * `resolveHandlePath` / the caller's own literal `path` — i.e. this
     * session minted or was given every one of them, just under an earlier,
     * now-superseded epoch/pack. Measured (T05c rep0 arm A,
     * 2026-08-22-v011-decision-6t-1): the generic frontier prescription below
     * can only point at the CURRENT (unrelated) frontier, and the bare
     * `challenge` escape demands evidence the caller does not have — four
     * refusals total; the caller's OWN recovery re-pack after this one still
     * cost two more (an unknown-argument retry, then a `not-found` range
     * guess) before it landed. `paths` re-establishes a covering
     * certificate in ONE call; `pairs` documents the same targets on
     * `also_admissible` so the refusal itself says they are known, not
     * foreign. A handle this session never minted (e.g. a hallucinated one
     * mixed into the same batch) leaves this undefined and the fence falls
     * back to today's frontier/challenge guidance unchanged — this is the
     * "two independent tasks' frontiers genuinely conflict" escape hatch.
     */
    // P2-2 fix: `recoveryPaths` is the UNION of the whole batch's non-create
    // requested targets (see guardExecutionEditCore's construction site) —
    // what the recovery `next` below actually re-packs with. `paths`/`pairs`
    // stay the strict outside-of-frontier subset for `alsoAdmissiblePairs`
    // and the `cause:"capped"` diagnosis.
    knownOutsideRepack?: { paths: readonly string[]; pairs: readonly HandlePathPair[]; recoveryPaths: readonly string[] };
  },
): ExecutionGuardDecision {
  const advanceableChallenge = challengeTemplate(fence, CHALLENGE_LEAD_EVIDENCE);
  // D10 (2026-08-14): `TL_REFUSAL_PROGRESS` is deleted. Progressive refusals
  // (terminal classification, path-keyed demand ledger, escape-preserving
  // compaction) are unconditional, so the former `progress &&` guards are gone.
  // 2026-07-25 T13 forensics: an edit-context refusal during "verifying" is a
  // FRONTIER problem (out-of-frontier target), not an edit retry — shape it
  // like the prepared-phase edit refusal so the way forward is the admissible
  // frontier, not a misleading verify-with-closure instruction.
  const verifying = fence.phase === "verifying" && opts?.editContext !== true;
  const brake = opts?.discoveryBrake === true;
  // ND-3: scoped precisely to the DEAD END. A braked call in any other phase
  // is already prescribed a transition that works — "batch-edit-certified-
  // frontier" with an edit_file template (a successful edit clears the
  // counter) or the challenge escape (which revokes the fence) — and those
  // pins stay exactly as they are. Only the verifying variant prescribed
  // closure/diff, which reset nothing.
  const brakeDeadEnd = brake && verifying;

  // ND-3: a braked call cannot be discharged by doing what required_action
  // says — nothing "verifies" it back open. It is terminal for its exact
  // shape, so it takes the repo's terminal vocabulary (unlock-or-rescope +
  // unlock{accepted_transitions,note}) and the transitions that verifiably
  // work ride there instead.
  const requiredAction = brakeDeadEnd
    ? "unlock-or-rescope"
    : verifying
      ? "verify-with-closure-or-diff"
      : fence.terminalAction === "edit"
        ? "batch-edit-certified-frontier"
        : "answer-from-certified-evidence";
  // R1: every typestate refusal carries the way forward — the live admissible
  // edit set (latest frontier UNION the epoch-scoped admissible union) and ONE
  // concrete next_call that satisfies required_action. An answer-terminal
  // refusal authorizes no edits, so its frontier is honestly empty.
  const isEditContext = fence.terminalAction === "edit";
  const frontierHandles = isEditContext
    ? mergeFrontier(fence.actionFrontier, session.admissibleEditHandles, FRONTIER_HANDLE_CAP)
    : [];
  const frontierPaths = isEditContext
    ? mergeFrontier(fence.actionPaths, session.admissibleEditPaths, FRONTIER_PATH_CAP)
    : [];

  // C6 (clause 4): PARTITION the flat frontier into the certificate's own
  // action frontier (the write targets) and everything the epoch union merely
  // makes admissible (served context: README.md, CONTRACT.md, sibling test
  // files — rep0's advertised frontier was 4/8 pure read-only context). This
  // is LABELLING only: `admissibleEditPaths` stays the permission predicate,
  // because narrowing it would re-open the 2026-07-24 T09/T10 "server refuses
  // the handles it itself served" regressions (see R7.3).
  //
  // Ticket 1 (2026-08-07): write_targets/also_admissible are now built from
  // ONE paired {handle,path} collection per partition (fence.actionTargetPairs
  // / session.admissibleEditTargetPairs) instead of independently filtering
  // frontierHandles/frontierPaths — independent filtering left the two output
  // arrays free to diverge in LENGTH with no positional correspondence (a
  // live dogfooded refusal against this file, mid-investigation, observed
  // write_targets handles=2/paths=1 and also_admissible handles=6/paths=4,
  // forcing the caller to guess which handle went with which path). The flat
  // frontierHandles/frontierPaths above are UNTOUCHED — same computation,
  // same byte-identical output as before this fix. "" marks a pair's side
  // that is not established (see HandlePathPair).
  const isWriteTargetPair = (pair: HandlePathPair): boolean =>
    (pair.handle !== "" && fence.actionFrontier.includes(pair.handle))
    || (pair.path !== "" && fence.actionPaths.includes(pair.path));
  const writeTargetPairs = isEditContext ? capTargetPairs(fence.actionTargetPairs, FRONTIER_PATH_CAP) : [];
  const admissibleCandidatePairs = isEditContext
    ? capTargetPairs([...session.admissibleEditTargetPairs].reverse(), FRONTIER_PATH_CAP)
    : [];
  const knownOutsideRepack = isEditContext ? opts?.knownOutsideRepack : undefined;
  const alsoAdmissiblePairsBase = admissibleCandidatePairs.filter((pair) => !isWriteTargetPair(pair));
  // F-R8: the known-but-out-of-epoch targets ride `also_admissible` too — a
  // refused handle the caller sees echoed back here is DOCUMENTED as known,
  // not silently indistinguishable from a foreign/hallucinated one.
  const alsoAdmissiblePairs = knownOutsideRepack === undefined
    ? alsoAdmissiblePairsBase
    : [
        ...alsoAdmissiblePairsBase,
        ...knownOutsideRepack.pairs.filter((pair) =>
          !alsoAdmissiblePairsBase.some((existing) => existing.handle === pair.handle && existing.path === pair.path)),
      ];
  const writeTargets = {
    handles: writeTargetPairs.map((pair) => pair.handle),
    paths: writeTargetPairs.map((pair) => pair.path),
  };
  const alsoAdmissible = {
    handles: alsoAdmissiblePairs.map((pair) => pair.handle),
    paths: alsoAdmissiblePairs.map((pair) => pair.path),
  };
  // The behavioural half of clause 4: the prescription is built from the WRITE
  // TARGETS. The flat frontier is the fallback so a degenerate certificate
  // (empty action frontier, non-empty union) keeps today's next_call rather
  // than silently collapsing to the challenge escape. A "" side (a write
  // target named by path only, or by handle only) is never prescription
  // material — edit_file cannot dispatch on an empty handle or path.
  const prescriptionCandidateHandles = writeTargets.handles.filter((handle) => handle !== "");
  const prescriptionCandidatePaths = writeTargets.paths.filter((path) => path !== "");
  const prescriptionHandles =
    prescriptionCandidateHandles.length > 0 ? prescriptionCandidateHandles : frontierHandles;
  const prescriptionPaths =
    prescriptionCandidatePaths.length > 0 ? prescriptionCandidatePaths : frontierPaths;
  // ---------------------------------------------------------------------
  // FX-L (2026-09-03, ruling (r)) — THE CAPPED-CERTIFICATE RECOVERY.
  //
  // A fence whose certificate cited addresses this session never sent bytes
  // for now REFUSES them (recordExecutionContract's shipped projection). Ruling
  // (r) requires that refusal to be recoverable, "the same executable shape the
  // read family uses for `cause:"capped"`": re-read exactly the unshipped
  // addresses, keep the workspace and the task binding, and the very next
  // `edit_file` is admitted — because a served range marks the path shipped
  // (`recordServedRange`) and the booking pass books it into the union.
  //
  // SCOPED TO THE ADDRESSES THIS REFUSAL IS ABOUT. It fires when the refused
  // target IS one of the withheld ones (the honest diagnosis: "you were told
  // about this file and never given it"), or when the fence has nothing else
  // to prescribe at all (an entirely-withheld certificate, which would
  // otherwise be the refuse-only fence the 2026-07-25 T13 note warns about).
  // A never-packed control file matches neither, so its refusal keeps today's
  // shape byte for byte.
  const fenceWithheldTargets = isEditContext ? fence.withheldTargets ?? [] : [];
  const requestedEditArgs = opts?.editArgs ?? {};
  const requestedHandlesForRecovery = requestedEditHandles(requestedEditArgs);
  const requestedPathsForRecovery = new Set([
    ...requestedEditPaths(requestedEditArgs),
    ...requestedHandlesForRecovery
      .map((handle) => opts?.resolveHandlePath?.(handle))
      .filter((candidate): candidate is string => typeof candidate === "string" && candidate !== ""),
  ]);
  // FX-N (round-16 finding 3, 2026-09-03) — MATCH ON THE RESOLVED PATH.
  //
  // `recordExecutionContract` builds each withheld pair's path from the
  // certificate's own evidence pairing (`evidenceByHandle`), which is EMPTY for
  // a frontier handle minted outside the obligation evidence set — those pairs
  // carry `path:""`. Matching on `pair.path` alone therefore missed the very
  // address being refused whenever the certificate had no pairing for it, and
  // the recovery fell through to `nothingElseToPrescribe`'s whole-complement
  // branch, whose FIRST entry is an unrelated file. Measured (`r16_b`, flags
  // off): `edit_file {path:"src/pricing_0.ts"}` refused with
  // `next = read_file targets:[{path:"src/anchor.ts"}]`; running it verbatim
  // served anchor.ts, the same edit refused AGAIN, and only that second
  // refusal named pricing_0.ts — one wasted round trip per address, and a
  // first `next` that is not the executable recovery for the refusal it rides
  // on. §12 row FX-L states the contract as "未出荷 address のみ拒否し `next`
  // はその未出荷 address だけを名指す (per-address)".
  //
  // The dispatcher's handle table is the second resolver the recovery already
  // uses when it BUILDS the `next` (see `recoveryTargets` below); consulting it
  // for the MATCH as well is what makes the two halves agree about which
  // address this refusal is about.
  const resolvedWithheldPath = (pair: HandlePathPair): string =>
    pair.path !== "" ? pair.path : opts?.resolveHandlePath?.(pair.handle) ?? "";
  const refusedWithheld = fenceWithheldTargets.filter((pair) =>
    (pair.handle !== "" && requestedHandlesForRecovery.includes(pair.handle))
    || (resolvedWithheldPath(pair) !== ""
      && requestedPathsForRecovery.has(resolvedWithheldPath(pair))));
  const nothingElseToPrescribe = prescriptionCandidateHandles.length === 0
    && prescriptionCandidatePaths.length === 0
    && frontierHandles.length === 0
    && frontierPaths.length === 0;
  // FX-N (round-16 finding 3) — THE FALLBACK NAMES THE REFUSED ADDRESS.
  //
  // `nothingElseToPrescribe` is the entirely-withheld certificate: the fence
  // has no frontier left to prescribe, and FX-L keeps it alive precisely so it
  // can refuse with a recovery instead of being cleared. What it prescribed was
  // the certificate's WHOLE withheld complement, whose first entry has no
  // relation to the edit being refused — measured in `r16_b`: an
  // `edit_file {path:"src/pricing_0.ts"}` answered
  // `next = read_file targets:[{path:"src/anchor.ts"}]`, and only the SECOND
  // refusal, after that unrelated read, named pricing_0.ts. The loop terminated
  // but cost an extra round trip per address, and the first `next` was not the
  // executable recovery for the refusal it rode on.
  //
  // The refused address IS the honest recovery here, by the same rule FX-L
  // states for the withheld case: a `read_file … content:"full"` of it puts
  // bytes on the wire and books them, and the very next edit is admitted (this
  // is the A1 serve-time admissibility rule, not a new affordance —
  // `r16_b`'s own second step is the measurement). The certificate's withheld
  // complement stays as the fallback for every other shape. Nothing changes for
  // a fence that still HAS a frontier: the refused address never reaches this
  // branch there, so the never-packed control keeps today's frontier
  // prescription byte for byte.
  //
  // GATED ON POSITIVE `withheld` EVIDENCE, AND ON AN EDIT-TERMINAL FENCE.
  // Only an address THIS SESSION emitted and withheld the bytes for is
  // recovered this way — the same per-address residency FX-L writes, read from
  // the session rather than from the one certificate that happens to be live
  // (in `r16_b` the refused address was withheld by an EARLIER capped pack in
  // the same epoch, which is why the live certificate's own complement did not
  // contain it). Three shapes are deliberately left exactly as they were:
  //   - a never-packed control under an entirely-withheld certificate has no
  //     residency at all, so it keeps prescribing the certificate's withheld
  //     complement (`sfCertificateWriteAuthority.spec.ts`'s discriminating
  //     control);
  //   - an ANSWER-ready certificate's ungrounded edit keeps its
  //     `taskEpoch:"new"` re-scope remedy — reading the file does not, and must
  //     not, unlock an answer fence (`executionTypestate.spec.ts` A2, replay
  //     corpus `afr2`);
  //   - a refusal that names no address, or an address with no `withheld`
  //     record, falls through to the complement.
  const refusedUnshippedPairs: HandlePathPair[] = fence.terminalAction === "edit"
    ? [
        ...requestedHandlesForRecovery.map((handle) => ({
          handle,
          path: opts?.resolveHandlePath?.(handle) ?? "",
        })),
        ...requestedEditPaths(requestedEditArgs).map((path) => ({ handle: "", path })),
      ].filter((pair) =>
        (pair.handle !== "" && _editAddressResidency(session, pair.handle, "") === "withheld")
        || (pair.path !== "" && _editAddressResidency(session, "", pair.path) === "withheld"))
    : [];
  const withheldRecoveryTargets = refusedWithheld.length > 0
    ? refusedWithheld
    : nothingElseToPrescribe
      ? (refusedUnshippedPairs.length > 0 ? refusedUnshippedPairs : fenceWithheldTargets)
      : [];
  // The task binding rides when this session still has one: `qref` re-binds the
  // re-read to the same task epoch, so the recovery is a zoom on the certified
  // task rather than an abandonment of it (a `taskEpoch:"new"` recovery would
  // discard the very certificate the caller is trying to execute).
  // NO `qref`, DELIBERATELY, AND THIS WAS MEASURED. Ruling (r) asks for the
  // task binding to ride; on this fixture it makes the recovery unexecutable.
  // `read_file {qref, targets:[…]}` is a task-pack RE-ASK, and the pack dedup
  // answers it `pack-unchanged` with a `prior` restatement for the very surface
  // the capped pack shipped no body for — the recovery would route straight
  // back through the mechanism that withheld the bytes, and hand the caller a
  // second false "you already hold these". The plain targeted read below is the
  // "read/search of UNSERVED scope is still served" affordance, it is scoped to
  // the same epoch by the fence that emitted it, and it is the only shape
  // observed to actually put the bytes on the wire AND book them.
  //
  // (The false `prior` on that re-ask is a separate, pre-existing defect in the
  // receipt path, reported by FX-L rather than fixed here: the booking pass
  // books no span for a bodyless surface, but the receipt still cites it.)
  // A withheld ADDRESS is prescribed by PATH wherever one is known — the
  // certificate's own {handle,path} pairing first, the dispatcher's handle
  // table second. Measured: `targets:[{handle}]` under a live qref answers
  // `decision-unchanged` (a receipt, not bytes), and a handle-addressed re-read
  // re-mints a handle rather than proving the file resident.
  const recoveryTargets = withheldRecoveryTargets
    .slice(0, NEXT_CALL_EDIT_CAP)
    .map((pair) => (pair.path !== "" ? pair.path : opts?.resolveHandlePath?.(pair.handle) ?? ""))
    .filter((candidate) => candidate !== "")
    .filter((candidate, index, all) => all.indexOf(candidate) === index);
  // `content:"full"` is load-bearing, not decoration. The recovery only closes
  // the loop if the re-read BOOKS what it serves: `content:"full"` routes
  // through `recordServedRange`, which is the served-range ledger ruling (r)
  // names as the proof of residency — the default `auto` selection returns the
  // same bytes on this fixture and books nothing, so a caller executing it
  // verbatim would be refused a second time. A file too large for one full read
  // answers with the read family's own capped contract (skeleton +
  // `remaining_ranges` + an executable `next`), which is the documented way on
  // from there.
  const withheldNextCall = recoveryTargets.length > 0
    ? {
        tool: "read_file",
        arguments: {
          targets: recoveryTargets.map((candidate) => ({ path: candidate })),
          content: "full",
          ...(workspaceRoot ? { cwd: workspaceRoot } : {}),
        },
      }
    : undefined;
  // ---------------------------------------------------------------------
  // F-R8: a known-but-out-of-epoch batch takes priority over both the brake
  // rescope and the generic frontier/challenge prescription — neither of
  // those names the caller's actual targets, and this one is a real,
  // placeholder-free `read_file` call that re-covers exactly them.
  //
  // FX-L outranks even that: `knownOutsideRepack` prescribes
  // `taskEpoch:"new"`, which THROWS AWAY the live certificate. When the reason
  // the target is inadmissible is "this response withheld its bytes", the
  // proportionate recovery is to send them.
  const nextCall = withheldNextCall !== undefined
    ? withheldNextCall
    : knownOutsideRepack !== undefined
    ? {
        tool: "read_file",
        arguments: {
          mode: "task_pack",
          taskEpoch: "new",
          // P2-2 fix: the UNION of the batch's non-create targets, not just
          // the outside-of-frontier subset — see knownOutsideRepack's own
          // `recoveryPaths` doc comment above for why the subset alone
          // needed a SECOND recovery read. Finding 3 fix: `recoveryPaths`
          // orders the outside-of-frontier subset FIRST, so this slice keeps
          // what the refusal is actually about even when the union exceeds
          // the cap — `remaining` below still names whatever this drops.
          paths: [...knownOutsideRepack.recoveryPaths].slice(0, KNOWN_OUTSIDE_REPACK_PATH_CAP),
          ...(workspaceRoot ? { cwd: workspaceRoot } : {}),
        },
      }
    : (brakeDeadEnd ? opts?.brakeRescopeNextCall : undefined) ?? frontierNextCall(
        fence,
        prescriptionHandles,
        prescriptionPaths,
        workspaceRoot,
        // ND-3: `verifying` prescribes read_file mode=closure, which does NOT
        // clear the brake. A braked call therefore never gets it — it falls back
        // to the frontier/challenge prescription, every branch of which is a
        // transition that actually releases the counter.
        brakeDeadEnd ? false : verifying,
        opts?.remedyRepackPaths,
      );

  // The PATHS the current prescription would have the caller write. Both the
  // terminality identity check and the demand ledger key on these — handle ids
  // are not stable across re-minting (clause 5).
  const resolveHandle = opts?.resolveHandlePath;
  const batchHandles = prescriptionHandles.slice(0, NEXT_CALL_EDIT_CAP);
  const prescribedPaths = batchHandles.length > 0
    ? [...new Set(batchHandles
        .map((handle) => resolveHandle?.(handle))
        .filter((candidate): candidate is string => typeof candidate === "string" && candidate !== ""))]
    : prescriptionPaths.slice(0, 1);

  // C2: a terminal refusal is a DIFFERENT payload, not a decorated one. It
  // carries no `frontier` — advertising an edit frontier next to
  // required_action:"unlock-or-rescope" is precisely the misdirection that
  // cost rep0 its turns — and it is idempotent by construction, so
  // refuseExecutionEdit never compacts it. Classified HERE, after the
  // prescription exists, because the discharged-demand rule is scoped to the
  // step actually being prescribed (2026-08-02 review blocker B).
  if (opts?.editContext === true) {
    const terminality = classifyEditRefusal(fence, opts.editArgs ?? {}, detail);
    if (terminality.kind === "terminal") {
      // Blocker B (lifetime): "you ran the prescribed step and it did not
      // unlock" is worth saying ONCE, to the caller it is about. Consume only
      // THIS target's claim; the demand survives for any other target it was
      // prescribed to, and dies when the last claim is spent. Left armed for
      // everyone it would make the fence permanently terminal, since a
      // terminal refusal never re-arms the ledger.
      if (
        terminality.reason === "prescribed-step-executed-target-still-inadmissible"
        && fence.demand !== undefined
      ) {
        const spent = refusalTargetKey(opts.editArgs ?? {});
        const remainingTargets = fence.demand.forTargets.filter((key) => key !== spent);
        fence.demand = remainingTargets.length > 0
          ? { ...fence.demand, forTargets: remainingTargets }
          : undefined;
      }
      return {
        allowed: false,
        refusal: {
          ok: false,
          reason: "execution-typestate",
          terminal: true,
          terminal_reason: terminality.reason,
          phase: fence.phase,
          certificate_id: fence.certificateId,
          required_action: "unlock-or-rescope",
          retry_same_call: false,
          detail: terminality.detail,
          unlock: terminality.unlock,
          next_call_is_template: true,
          // D2 fix (2026-08-06, P5-F3): a create-target-not-servable
          // refusal must acquire authority through a fresh read/contract
          // transition regardless of fence.terminalAction -- challenge
          // cannot mint create authority (see the matching fix in
          // classifyEditRefusal). Keying this on terminality.reason
          // rather than re-testing fence.terminalAction === "answer"
          // keeps next_call locked to whatever classifyEditRefusal just
          // decided, so the two can never drift apart the way they did
          // here: this ternary used to fall through to terminalNextCall
          // even once classifyEditRefusal stopped naming challenge,
          // which would have prescribed a same-shaped edit_file replay
          // with no challenge and no taskEpoch -- a guaranteed dead
          // loop, strictly worse than the false challenge promise it
          // replaced. Other terminal edit refusals (the demand-ledger
          // case) retain the historical edit_file unlock template.
          next_call: terminality.reason === "create-target-not-servable"
            // v0.14.1 defect 1 fix (2026-09-07): this next_call is a
            // next_call_is_template:true payload (set unconditionally a few
            // lines below), and its query carries a placeholder -- protocol/
            // refusal.ts's emittableToolCall deliberately does not
            // canonicalize any template so the caller's placeholder survives
            // verbatim, which means the legacy mode/taskEpoch/taskProfile/
            // paths spelling used to reach the wire unchanged. The canonical
            // fix would route this through protocol/envelope.ts's
            // canonicalToolCall ("the ONE place every emitted next/next_call
            // is built through"), but envelope.ts imports protocol/emit.ts
            // and protocol/readFamily.ts, both of which import THIS module --
            // state/session.ts -> protocol/envelope.ts -> protocol/emit.ts ->
            // state/session.ts is a real cycle (confirmed live: it threw
            // "Cannot access 'EDIT_SEARCH_PLACEHOLDER' before initialization"
            // in protocol/refusal.ts, which imports both this module and
            // envelope.ts, the moment session.ts's own top-level evaluation
            // reached an envelope.js import ahead of that const). So the
            // canonical shape is hand-built here instead: `task.epoch`/
            // `task.profile` replace `taskEpoch`/`taskProfile`, `targets`
            // (path-only entries) replaces `paths`, and `mode` is dropped --
            // byte-identical to what canonicalToolCall("read_file", {mode:
            // "task_pack", ...}) produces for this exact shape (no `content`
            // key: canonicalReadArguments only defaults one for mode !==
            // "task_pack"/"closure").
            ? {
                tool: "read_file",
                arguments: {
                  task: { epoch: "new", profile: "generic" },
                  query: `<one sentence change request that explicitly says to create ${requestedEditPaths(opts.editArgs ?? {})[0] ?? "the target file"}>`,
                  targets: requestedEditPaths(opts.editArgs ?? {}).slice(0, 8).map((path) => ({ path })),
                  ...(workspaceRoot ? { cwd: workspaceRoot } : {}),
                },
              }
            : terminalNextCall(
                opts.editArgs ?? {},
                (terminality.unlock as { challenge?: unknown }).challenge,
                workspaceRoot,
              ),
        },
      };
    }
  }

  // C5 (clauses 3 + 5): record the edit-shaped demand this refusal just
  // emitted, keyed by PATH. `satisfiedPaths` survives re-emission so a demand
  // discharged by an earlier batch is not silently re-armed.
  if (opts?.editContext === true && isEditContext && nextCall["tool"] === "edit_file") {
    const previous = fence.demand;
    // Blocker C (durability): NEVER shrink `paths`. Recomputing them from
    // whatever the handle registry still resolves silently DELETES outstanding
    // work the moment a handle expires or re-mints — and a demand whose
    // unfinished paths vanished reads as fully discharged, which is exactly
    // the false-completion clause 5 exists to prevent. Carry the previous
    // paths forward whenever this is the same demand (overlapping file set, or
    // a prescription that resolved nothing at all).
    const sameDemand = previous !== undefined && (
      prescribedPaths.length === 0
      || previous.paths.some((candidate) => prescribedPaths.includes(candidate))
    );
    const paths = sameDemand
      ? [...new Set([...previous!.paths, ...prescribedPaths])]
      : prescribedPaths;
    // P1-2: every target this prescription is handed to earns its own single
    // terminal verdict once the batch lands. Union rather than overwrite —
    // retargeting would silently cancel the claim of whoever was prescribed
    // the step first.
    const targetKey = refusalTargetKey(opts.editArgs ?? {});
    const forTargets = [...new Set([...(sameDemand ? previous!.forTargets : []), targetKey])]
      .slice(-DEMAND_TARGET_CAP);
    fence.demand = {
      id: demandIdFor(paths),
      paths,
      // A genuinely NEW prescription has not been run yet; only a carried-over
      // demand keeps its write history.
      satisfiedPaths: sameDemand ? [...previous!.satisfiedPaths] : [],
      forTargets,
    };
  }

  return {
    allowed: false,
    refusal: {
      ok: false,
      reason: "execution-typestate",
      phase: fence.phase,
      // C7: `verifying` + an edit-context refusal reports a phase that
      // contradicts required_action ("batch-edit-certified-frontier"). The
      // 2026-07-25 T13 fix corrected required_action and left `phase` saying
      // the opposite; name the discrepancy instead of leaving it to be guessed.
      ...(fence.phase === "verifying" && opts?.editContext === true
        ? { phase_note: "verifying phase, but this refusal is a frontier membership refusal, not a verify instruction" }
        : {}),
      certificate_id: fence.certificateId,
      next_action: verifying ? "verify" : fence.terminalAction,
      required_action: requiredAction,
      discovery_closed: !verifying,
      retry_same_call: false,
      // `frontier` unifies the former `edit_frontier` (latest frontier) and
      // `also_admissible` (epoch union) into ONE field present on every refusal.
      frontier: isEditContext
        ? {
            handles: frontierHandles,
            paths: frontierPaths,
            write_targets: writeTargets,
            also_admissible: alsoAdmissible,
          }
        : { handles: frontierHandles, paths: frontierPaths },
      // FX-L (ruling (r)): the refusal SAYS why the certificate's own address is
      // inadmissible, in the read family's own vocabulary — the bytes were
      // capped out of the response that named it. Advisory: `code` still says
      // `execution-typestate` and `next` carries the whole recovery, so a
      // caller that ignores this field loses nothing.
      //
      // ONLY when THIS target is the withheld one. An unrelated target refused
      // under an entirely-withheld fence still gets the recovery `next` (that
      // fence has nothing else to offer anyone, and a fence that can only
      // refuse is the 2026-07-25 T13 failure), but saying `cause:"capped"`
      // about a file the pack never named would be a false diagnosis.
      ...(withheldNextCall !== undefined && refusedWithheld.length > 0 ? { cause: "capped" } : {}),
      next_call: nextCall,
      // v0.14.1 defect 3 fix (2026-09-07): `knownOutsideRepack.recoveryPaths`
      // can exceed KNOWN_OUTSIDE_REPACK_PATH_CAP for a genuinely large batch
      // (P2-2 fix, 2026-09-08: this now keys off `recoveryPaths`, the same
      // union field `next_call` above slices from — not `.paths`, the
      // strict outside-only subset, so this overflow report always names
      // what THIS next_call actually dropped); the `next_call` above
      // silently drops the tail, so name what it dropped instead of losing
      // it -- a caller that re-issues `next_call` verbatim and then retries
      // the SAME edit_file call is refused again for exactly the omitted
      // paths otherwise.
      //
      // Review finding 3 residual (2026-09-08): `recoveryPaths` orders the
      // outside-of-frontier subset first (see its own construction comment),
      // so the common case — a large batch with a small outside subset —
      // fits the outside targets inside the cap and this overflow is only
      // ever already-admissible targets that did not need the recovery read
      // in the first place. The one case ordering cannot fix: an
      // outside-of-frontier subset that ITSELF exceeds the cap (every target
      // in an over-sized batch is outside the frontier). `remaining` still
      // discloses that tail honestly, but the caller genuinely needs a
      // SECOND recovery read to cover it — no single 64-path call can.
      ...(knownOutsideRepack !== undefined && knownOutsideRepack.recoveryPaths.length > KNOWN_OUTSIDE_REPACK_PATH_CAP
        ? { remaining: knownOutsideRepack.recoveryPaths.slice(KNOWN_OUTSIDE_REPACK_PATH_CAP) }
        : {}),
      // Rides the REFUSAL, never the arguments: edit_file's unknown-argument
      // layer fails closed, so a marker inside `arguments` would make the
      // prescription unexecutable all over again.
      ...(nextCall["tool"] === "edit_file" ? { next_call_is_template: true } : {}),
      // ND-3: never advertised on a braked call — closure and diff are served
      // normally but reset nothing, so naming them as this refusal's allowed
      // recovery is the machine-readable half of the dead end.
      ...(verifying && !brake
        ? {
            allowed_verification_calls: [
              { tool: "read_file", arguments: { mode: "closure" } },
              { tool: "search_files", arguments: { action: "diff" } },
            ],
          }
        : {}),
      // ND-3: the brake's real accepted transitions, in the repo's terminal
      // vocabulary. Every entry is one this server verifiably honours: a
      // different selection is served normally (the signature differs), a
      // successful edit_file clears the counter (L2b), and the challenge is
      // listed only when this fence carries an obligation applyChallenge will
      // actually accept.
      ...(brakeDeadEnd
        ? {
            terminal: true,
            terminal_reason: "discovery-loop-brake",
            unlock: {
              accepted_transitions: [
                "read_file|search_files naming a different window, path, symbol or query",
                "edit_file - any successful edit under this certificate",
                ...(advanceableChallenge !== undefined
                  ? ["read_file challenge={certificate_id, obligation_id, expected_action_change}"]
                  : []),
              ],
              note: "this exact call shape stays refused until one of the accepted transitions runs; verification calls are served normally but do not re-open it",
              ...(advanceableChallenge !== undefined ? { challenge: advanceableChallenge } : {}),
            },
          }
        : {}),
      challenge_required: !verifying,
      detail: detail ?? (verifying
        ? "the certified edit already committed; do not retry edit, verify with closure or diff and finish"
        : "discovery is closed; execute required_action now, or supply a concrete decision-changing challenge"),
      // D2 (2026-08-02): the challenge escape is advertised only when this
      // fence has an obligation id `applyChallenge` will actually accept —
      // otherwise the payload promised a transition the validator refuses.
      // Everything else about the refusal (frontier, prescription, detail) is
      // unchanged, so an obligation-less fence stays fully advanceable.
      //
      // F-R8: a known-but-out-of-epoch batch gets the re-pack `next_call`
      // above INSTEAD of the challenge invitation — a challenge demands new
      // evidence that changes the certified decision, and the caller has
      // none; it just wants a certificate that covers files this session
      // already showed it. `retryOf` (protocol/refusal.ts) honours an
      // explicit `retry` before it ever looks for a `challenge` affordance, so
      // declaring it here is sufficient to route the wire's `retry` to
      // `"call"` and let the real `next_call` ride as `next`.
      ...(!verifying && knownOutsideRepack === undefined && advanceableChallenge !== undefined
        ? { challenge: advanceableChallenge }
        : {}),
      ...(knownOutsideRepack !== undefined ? { retry: "call" as const } : {}),
    },
  };
}

/**
 * Signature of an edit_file call, for verbatim-retry detection: two calls with
 * the same handles/paths/create/search/replace/symbol/target/intent/content and
 * the same edits[] bodies produce the same string. A changed search/replace is
 * genuinely different work and does NOT compact.
 */
function editCallSignature(args: Record<string, unknown>): string {
  const str = (key: string): string => (typeof args[key] === "string" ? (args[key] as string) : "");
  const edits = Array.isArray(args["edits"])
    ? args["edits"].map((edit) => {
        if (!edit || typeof edit !== "object") return "";
        const e = edit as Record<string, unknown>;
        return JSON.stringify([
          typeof e["handle"] === "string" ? e["handle"] : "",
          typeof e["path"] === "string" ? e["path"] : "",
          typeof e["search"] === "string" ? e["search"] : "",
          typeof e["replace"] === "string" ? e["replace"] : "",
        ]);
      }).sort()
    : [];
  return JSON.stringify([
    "edit",
    requestedEditHandles(args).slice().sort(),
    requestedEditPaths(args).slice().sort(),
    args["create"] === true,
    str("search"),
    str("replace"),
    str("symbol"),
    str("target"),
    str("intent"),
    str("content"),
    edits,
  ]);
}

/** A next_call trimmed for a compact retry receipt: drop cwd (the retry already
 * carried the caller's), cap the edits hint. Keeps the receipt well under 400 B
 * regardless of workspace-path length. */
function compactNextCall(nextCall: unknown): Record<string, unknown> | undefined {
  if (!nextCall || typeof nextCall !== "object") return undefined;
  const call = nextCall as { tool?: unknown; arguments?: unknown };
  if (typeof call.tool !== "string") return undefined;
  const callArgs = call.arguments && typeof call.arguments === "object"
    ? { ...(call.arguments as Record<string, unknown>) }
    : {};
  // C4 (2026-08-02), unflagged: `cwd` is KEPT. Stripping it made the compact
  // prescription a miniature of the very defect C4 fixes — a call the caller
  // cannot legally execute (the bench PreToolUse guard denies cwd-less TL
  // calls, code=tokenlighten-cwd-outside-worktree). A prescription must be
  // executable in BOTH the full and the compact shape; ~30 B buys that.
  // The compact view slices to the SAME cap the full prescription uses. A
  // tighter display cap here produced the observed 8→6 "shrink" that read as
  // the frontier moving under the caller (2026-08-02 T05c rep0).
  if (Array.isArray(callArgs["edits"])) {
    callArgs["edits"] = (callArgs["edits"] as unknown[]).slice(0, NEXT_CALL_EDIT_CAP);
  }
  return { tool: call.tool, arguments: callArgs };
}

/**
 * R2: a verbatim edit retry gets a compact receipt (~200 B) — same reason code,
 * "unchanged since previous refusal", and the next_call again — not the full
 * refusal payload the model already saw. No repeated detail prose, no frontier.
 */
function compactEditRefusal(
  full: Record<string, unknown>,
  delta?: { paths: string[]; handles: string[] },
): Record<string, unknown> {
  // D10 (2026-08-14): `TL_REFUSAL_PROGRESS` is deleted; the escape-preserving
  // compaction below is the only compaction. The former escape-erasing variant
  // is gone with it.
  const compactCall = compactNextCall(full["next_call"]);
  // C3 (2026-08-02 T05c): the compact receipt used to erase the ONE universal
  // escape. rep0 saw `challenge` in refusal #1 and never again across four
  // more refusals; rep1 attached it to the byte-identical call and was through
  // in one turn. ~190 B against a measured ~20-turn worst case. When a demand
  // is PARTIALLY discharged the receipt names what is still outstanding rather
  // than the flatly false "unchanged" (a fully discharged demand is already
  // routed to a terminal refusal upstream, so `remaining` is never empty).
  return {
    ok: false,
    reason: "execution-typestate",
    required_action: full["required_action"],
    retry_same_call: false,
    certificate_id: full["certificate_id"],
    ...(delta ? { remaining: delta } : { unchanged: "unchanged since previous refusal" }),
    ...(full["challenge"] ? { challenge: full["challenge"] } : {}),
    // FX-L: `cause` rides the compact receipt for the same reason `challenge`
    // does — it is the DIAGNOSIS, and this shape is what a caller sees on every
    // retry after the first. A compact receipt that keeps the recovery call but
    // drops the one word saying the bytes were capped is the escape-erasing
    // compaction C3 removed, in miniature. ~20 B.
    ...(full["cause"] !== undefined ? { cause: full["cause"] } : {}),
    ...(compactCall ? { next_call: compactCall } : {}),
  };
}

/**
 * The single edit-refusal exit for guardExecutionEdit: builds the full R1
 * refusal, then (R2) collapses it to a compact receipt when this exact edit
 * signature was already refused earlier in the epoch. Records new signatures in
 * a bounded ring so only the FIRST occurrence pays the full payload.
 */
function refuseExecutionEdit(
  session: WorkspaceSession,
  fence: ExecutionFenceState,
  workspaceRoot: string,
  editSignature: string,
  detail: string,
  remedyRepackPaths?: readonly string[],
  editArgs?: Record<string, unknown>,
  resolveHandlePath?: (handle: string) => string | undefined,
  knownOutsideRepack?: { paths: readonly string[]; pairs: readonly HandlePathPair[]; recoveryPaths: readonly string[] },
): ExecutionGuardDecision {
  const full = executionRefusal(session, fence, detail, workspaceRoot, {
    editContext: true,
    ...(remedyRepackPaths !== undefined && remedyRepackPaths.length > 0 ? { remedyRepackPaths } : {}),
    ...(editArgs !== undefined ? { editArgs } : {}),
    ...(resolveHandlePath !== undefined ? { resolveHandlePath } : {}),
    ...(knownOutsideRepack !== undefined ? { knownOutsideRepack } : {}),
  });
  // W6: do not alter the refusal verdict or sanctioned transition.  A
  // byte-identical retry is useful only insofar as it repeats the concrete
  // correction the first refusal named, so attach that as advisory prose.
  const repeatedShape = noteRefusedEditShape(session, editArgs, detail);
  if (repeatedShape !== undefined && full.allowed === false) {
    const currentDetail = typeof full.refusal["detail"] === "string"
      ? `${full.refusal["detail"]} `
      : "";
    full.refusal["detail"] = `${currentDetail}This edit_file shape was already refused in this task (attempt ${repeatedShape.count}); retrying it unchanged cannot change the result. First correction: ${repeatedShape.firstDetail}`;
  }
  // C2: a terminal refusal is already minimal and byte-idempotent — compacting
  // it would strip the very `unlock` it exists to advertise, which is the
  // mechanism that hid the escape from rep0 in the first place. The signature
  // is still recorded below so the ring behaves identically for other shapes.
  const isTerminal = full.allowed === false && full.refusal["terminal"] === true;
  if (!isTerminal && full.allowed === false && session.recentEditRefusalSignatures.includes(editSignature)) {
    const demand = fence.demand;
    const remainingPaths = demand !== undefined
      ? demand.paths.filter((candidate) => !demand.satisfiedPaths.includes(candidate))
      : [];
    // Only a demand that has actually MOVED produces a delta; an untouched
    // demand genuinely is unchanged, and saying so stays honest (rfp3).
    const delta = demand !== undefined && demand.satisfiedPaths.length > 0 && remainingPaths.length > 0
      ? { paths: remainingPaths, handles: [] as string[] }
      : undefined;
    const compact = compactEditRefusal(full.refusal, delta);
    // compactEditRefusal intentionally drops most prose. W6's escalation is
    // the exception: it is advisory-only but must survive the compact path.
    if (repeatedShape !== undefined) compact["detail"] = full.refusal["detail"];
    return { allowed: false, refusal: compact };
  }
  session.recentEditRefusalSignatures.push(editSignature);
  if (session.recentEditRefusalSignatures.length > EDIT_REFUSAL_SIGNATURE_HISTORY) {
    session.recentEditRefusalSignatures.shift();
  }
  return full;
}

function parseChallenge(args: Record<string, unknown>): {
  certificateId: string;
  obligationId: string;
  expectedActionChange: string;
} | undefined {
  const raw = args["challenge"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const certificateId = typeof value["certificate_id"] === "string" ? value["certificate_id"].trim() : "";
  const obligationId = typeof value["obligation_id"] === "string" ? value["obligation_id"].trim() : "";
  const expectedActionChange = typeof value["expected_action_change"] === "string"
    ? value["expected_action_change"].trim()
    : "";
  const placeholder = /^(?:<.*>|state which answer\/edit decision|describe the concrete answer\/edit decision)/i
    .test(expectedActionChange);
  const decisionShaped = /\b(?:add|call|change|choose|derive|edit|expand|fix|pass|remove|replace|switch|target|frontier|answer|use)\b/i
    .test(expectedActionChange);
  if (
    !certificateId
    || !obligationId
    || expectedActionChange.length < 12
    || placeholder
    || !decisionShaped
  ) return undefined;
  return { certificateId, obligationId, expectedActionChange };
}

function applyChallenge(
  session: WorkspaceSession,
  fence: ExecutionFenceState,
  args: Record<string, unknown>,
  workspaceRoot?: string,
): ExecutionGuardDecision | undefined {
  if (args["challenge"] === undefined) return undefined;
  const challenge = parseChallenge(args);
  if (challenge === undefined) {
    return executionRefusal(
      session,
      fence,
      "challenge must name the concrete answer/edit/fix decision that the requested evidence can change",
      workspaceRoot,
    );
  }
  if (challenge.certificateId !== fence.certificateId) {
    return executionRefusal(session, fence, "challenge certificate_id does not match the active task", workspaceRoot);
  }
  if (!fence.obligationIds.includes(challenge.obligationId)) {
    return executionRefusal(session, fence, "challenge obligation_id is not present in the readiness certificate", workspaceRoot);
  }
  fence.phase = "revoked";
  fence.challengeCount++;
  session.revokedCertificateIds.add(fence.certificateId);
  return { allowed: true, challenged: true };
}

/**
 * FIFO cap on each epoch-scoped admissible-union list (handles and paths) —
 * sessions are long-lived, so an unbounded union would grow O(session length).
 * Most-recent DISTINCT entries are kept; the oldest first-seen entry is evicted
 * on overflow. 256 is generous: a realistic multi-file task certifies far fewer
 * distinct handles.
 */
const ADMISSIBLE_EDIT_UNION_CAP = 256;

/**
 * Appends `additions` to an admissible-union list, de-duplicating (an entry
 * already admissible keeps its first-seen position) and FIFO-evicting the
 * OLDEST entry once the list exceeds ADMISSIBLE_EDIT_UNION_CAP. Empty strings
 * are ignored.
 */
function _appendAdmissible(list: string[], additions: readonly string[]): void {
  for (const item of additions) {
    if (item === "" || list.includes(item)) continue;
    list.push(item);
    if (list.length > ADMISSIBLE_EDIT_UNION_CAP) list.shift();
  }
}

/**
 * Ticket 1 (2026-08-07): the paired counterpart of _appendAdmissible — same
 * de-dupe/FIFO-cap discipline (exact-pair identity; oldest evicted first),
 * kept ALONGSIDE the flat admissibleEditHandles/admissibleEditPaths lists,
 * never replacing them. A placeholder ({handle,path:""} or {handle:"",path})
 * and a later fully-resolved pair for the same identity can both be present
 * — executionRefusal reads this list newest-first (via capTargetPairs), so a
 * later real pair naturally wins over an earlier placeholder once capped.
 */
function _appendAdmissiblePairs(list: HandlePathPair[], additions: readonly HandlePathPair[]): void {
  for (const pair of additions) {
    if (pair.handle === "" && pair.path === "") continue;
    if (list.some((existing) => existing.handle === pair.handle && existing.path === pair.path)) continue;
    list.push(pair);
    if (list.length > ADMISSIBLE_EDIT_UNION_CAP) list.shift();
  }
}

/**
 * Clears the epoch-scoped admissible edit state — the frontier union AND the
 * verbatim-retry refusal-signature ring (both are per-task, edit-scoped, and
 * stale once the epoch turns over). Called ONLY at genuine epoch boundaries
 * (taskEpoch:"new" in the discovery guard; taskEpoch:"new" in the edit guard)
 * where prior handles are now stale — NEVER
 * when a new certificate merely replaces the old one (that path must let the
 * union accumulate; see admissibleEditHandles' doc comment for the full
 * per-site classification).
 */
function _clearAdmissibleEditUnion(session: WorkspaceSession): void {
  session.admissibleEditHandles = [];
  session.admissibleEditPaths = [];
  session.admissibleEditTargetPairs = [];
  // FX-L: residency is epoch-scoped for the same reason the union is — the
  // handles are stale and the next task's certificate must be judged against
  // what THAT task served. Cleared here and nowhere else, so the two can never
  // disagree about which epoch they describe.
  //
  // FX-P1 ruling (v): before wiping, fold every WITHHELD key into the retired
  // sets (see their doc comment) — a `taskEpoch:"new"` boundary must not be a
  // way to forget that this session already emitted an address bodyless. The
  // live maps' own SHIPPED keys are dropped outright: a stale "shipped" mark
  // has no protective value to preserve across an epoch it does not describe.
  for (const [key, state] of session.editHandleResidency) {
    if (state === "withheld") _foldIntoRetiredWithheld(session.retiredWithheldEditHandles, key);
  }
  for (const [key, state] of session.editPathResidency) {
    if (state === "withheld") _foldIntoRetiredWithheld(session.retiredWithheldEditPaths, key);
  }
  session.editHandleResidency.clear();
  session.editPathResidency.clear();
  session.recentEditRefusalSignatures = [];
  session.refusedEditShapes = [];
}

/**
 * FIFO-capped insert into a retired-withheld set (`EDIT_RESIDENCY_CAP` —
 * declared just below, referenced only at call time so the forward reference
 * is safe). Insertion order is a `Set`'s iteration order, so the oldest
 * entry is whichever was added first.
 */
function _foldIntoRetiredWithheld(set: Set<string>, key: string): void {
  if (key === "" || set.has(key)) return;
  set.add(key);
  while (set.size > EDIT_RESIDENCY_CAP) {
    const oldest = set.values().next().value as string | undefined;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
}

/**
 * FX-L: per-address residency bound. Sized above ADMISSIBLE_EDIT_UNION_CAP
 * because a capped pack emits MORE addresses than it books (that is the whole
 * defect), and a "withheld" entry evicted early silently re-opens the blind
 * edit it exists to refuse.
 */
const EDIT_RESIDENCY_CAP = 512;

/**
 * The ONE writer for `editHandleResidency`/`editPathResidency`. `"shipped"`
 * always wins (see the field doc: monotone toward shipped), an entry keeps its
 * first-seen position on upgrade, and the oldest entry is FIFO-evicted past
 * the cap — identical discipline to `_appendAdmissible`.
 */
function _markEditResidency(
  map: Map<string, "shipped" | "withheld">,
  keys: readonly string[],
  state: "shipped" | "withheld",
): void {
  for (const key of keys) {
    if (key === "") continue;
    const current = map.get(key);
    if (current === state) continue;
    if (current === "shipped") continue;
    map.set(key, state);
    while (map.size > EDIT_RESIDENCY_CAP) {
      const oldest = map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
}

/**
 * FX-L (ruling (r)): "this response EMITTED these addresses and sent no bytes
 * for them". Called by the single post-trim booking pass
 * (`bookShippedPackServeState`) with exactly the final pack's bodyless
 * surfaces, AFTER `recordServedEditAdmissibility` has marked the shipped ones,
 * so a path with one shipped and one bodyless row stays `"shipped"`.
 *
 * This is the ONLY thing that distinguishes "this session never served
 * anything" (a synthetic or first-call certificate — residency `undefined`,
 * today's behavior preserved) from "this response emitted addresses and
 * withheld their bytes" (a cap-overflowing pack — residency `"withheld"`, the
 * certificate lift refuses). `recordExecutionContract` is the only reader.
 */
export function recordWithheldEditAddresses(
  workspaceRoot: string,
  entries: { handles?: readonly string[]; paths?: readonly string[] },
): void {
  const handles = entries.handles ?? [];
  const paths = entries.paths ?? [];
  if (handles.length === 0 && paths.length === 0) return;
  const session = getSession(workspaceRoot);
  _markEditResidency(session.editHandleResidency, handles, "withheld");
  _markEditResidency(session.editPathResidency, paths, "withheld");
}

/**
 * FX-P1 (INV-I-1, DESIGN-v0.15 ruling (r)/(v), 2026-09-03) — THE ONE
 * EDIT-ADMISSIBILITY PREDICATE.
 *
 * Ruling (r): write authority comes from SHIPPED BYTES (a body this session
 * sent, a `code_unchanged` restatement, a served range, a file this server
 * created) and from nothing else. Three consumers ask that question and, before
 * this function, two of them spelled the answer out inline while a third never
 * asked at all:
 *
 *   1. `recordExecutionContract`'s certificate lift (`addressShipped`) — FX-L;
 *   2. `executionRefusal`'s capped-recovery match (`refusedUnshippedPairs`) —
 *      FX-N;
 *   3. `guardExecutionEdit` itself — WHICH DID NOT ASK, and that is INV-I-1.
 *
 * INV-I-1, THE MEASURED DEFECT (live, all SF flags off, `scratchpad/fxp1/i1.mjs`):
 *
 *   read_file { query:<generic pricing change>, task:{profile:"generic",epoch:"new"},
 *               budget:{ bytes: 6144 } }
 *     -> read.task_pack, decision.kind = "discover", ONE evidence row
 *        (`src/pricing_5.ts`) whose body the byte cap stripped: `hasBody:false`.
 *        The booking pass marks it `withheld` exactly as FX-L designed.
 *   edit_file { edits:[{ handle:<that row's handle>, content:"…" }] }
 *     -> edit.applied.   The 575-byte real file is replaced by a 37-byte guess.
 *
 * Reproduced identically for `handle`+`search`, `path`+`search`, and
 * `handle`+`range`+`content`; only `path`+`content` refused, and only because
 * `write-intent-ambiguous` catches that ONE shape for unrelated reasons. So the
 * gap was never about a form — it was about the gate.
 *
 * ROOT CAUSE, one line: `guardExecutionEdit`'s
 * `if (fence === undefined || fence.phase === "revoked" || fence.phase === "done")
 * return { allowed: true }`. The FENCE was the only thing that ever consulted
 * residency, via the certificate lift, and a pack whose `decision.kind` is
 * `discover` emits NO `execution_contract`, so `recordExecutionContract` never
 * runs and no fence is installed. FX-K/FX-L/FX-N did not catch it because every
 * one of their cases arms a certificate first — `sfCertificateWriteAuthority`'s
 * production case even spends a second call specifically to install the fence.
 * A capped DISCOVERY pack mints handles and installs nothing.
 *
 * WHY THIS FUNCTION AND NOT A FOURTH INLINE COPY. The three consumers must agree
 * about the SAME address, or the gate refuses what the recovery cannot restore
 * (and vice versa — round-16 finding 3 was exactly that disagreement, in the
 * path-resolution half). One function, three callers, one answer.
 *
 * POSITIVE EVIDENCE ONLY, UNCHANGED. `"unknown"` — an address neither serve-time
 * producer ever saw — stays admissible. Requiring proof of shipping would refuse
 * every edit in a session that never read anything, which is both a legitimate
 * call shape and the T09/T10 "the gate refuses a handle this server itself
 * served" regression class. Only an address this session EMITTED and withheld
 * the bytes for is refused.
 */
export type EditAddressResidency = "shipped" | "withheld" | "unknown";

function _editAddressResidency(
  session: WorkspaceSession,
  handle: string,
  filePath: string,
): EditAddressResidency {
  // THE FILE IS THE UNIT OF BYTE RESIDENCY (FX-L): a known path outranks the
  // handle id, because the same file is routinely re-emitted under a fresh
  // handle and the pack withholds (or sends) the FILE, not one address for it.
  if (session.editHandleResidency.get(handle) === "shipped") return "shipped";
  const byPath = filePath === "" ? undefined : session.editPathResidency.get(filePath);
  if (byPath === "shipped") return "shipped";
  if (byPath === "withheld") return "withheld";
  if (session.editHandleResidency.get(handle) === "withheld") return "withheld";
  // FX-P1 ruling (v): the live maps say nothing about this address in the
  // CURRENT epoch — fall back to what a now-retired epoch recorded before its
  // `taskEpoch:"new"` wipe. A fresh "shipped" mark always wins (both checks
  // above already returned before reaching here), so this can only ever
  // EXTEND a refusal that positive evidence already earned, never create one
  // out of "unknown". See the fields' own doc comment for why only the
  // withheld direction is carried forward.
  if (handle !== "" && session.retiredWithheldEditHandles.has(handle)) return "withheld";
  if (filePath !== "" && session.retiredWithheldEditPaths.has(filePath)) return "withheld";
  return "unknown";
}

/**
 * IL-W5 (DESIGN-v0.15-sf-intent-layers.md §11.2(1)) — read-only, HANDLE-ONLY
 * accessor for the `write-intent-ambiguous` auto-resolve. Deliberately NOT a
 * `path` lookup, and NOT `_editAddressResidency` (which falls back to the
 * PATH-keyed `editPathResidency` map): that map is `"shipped"` the instant
 * ANY byte of the path reached this lane — `_promoteStagedServeBookings`
 * (the general per-response funnel exit) promotes a path the moment ONE of
 * its served spans corroborates, by design (FX-N: "a partially-carried span
 * still counts... they are per-FILE, not per-line"), and
 * `recordServedEditAdmissibility` (the task_pack booking pass) does the same
 * for a single served slice row. Measured regression
 * (`fxq2RangeGranularForeignHandle.spec.ts`, "control: the SAME lane's
 * honest whole-file path+content replace still refuses"): a lane that read
 * only lines 1-10 of a large file already has `editPathResidency==="shipped"`
 * for that path, which would wrongly auto-resolve a bare `{path, content}`
 * whole-file replace as if the whole file were held.
 *
 * The caller (server.ts) proves FULL-body residency instead by canonicalizing
 * the exact whole-file `{kind:"file", path, workspaceRoot, sha:<current sha>}`
 * handle (via `handleTable.upsert`, which resolves to the SAME id a prior
 * `create:true` or `content:"full"` serve already minted, and mints nothing
 * new when it did not) and asking THIS function whether exactly THAT handle
 * — never the path — is `"shipped"`. A `create:true` mint's handle is marked
 * shipped by `recordCreatedEditAdmissibility`; a task_pack whole-file serve's
 * handle is marked shipped by `recordServedEditAdmissibility`. A plain direct
 * `content:"full"` read (outside task_pack) does not mint through either of
 * those, so the caller ALSO checks `servedRangeCoverage(...).complete` (the
 * range ledger `bookFullFileExpansionServe` populates for exactly that case)
 * — this accessor only ever answers the handle half of that OR.
 */
export function isHandleShippedInThisLane(workspaceRoot: string, handle: string): boolean {
  if (handle === "") return false;
  return getSession(workspaceRoot).editHandleResidency.get(handle) === "shipped";
}

/**
 * Every address THIS edit call asks to write whose bytes this session emitted
 * and withheld. Reads BOTH request vocabularies — `requestedEditHandles` and
 * `requestedEditPaths` — so `handle`+`content`, `handle`+`search`,
 * `path`+`search`, a `range` form and an `edits[]` batch all reach the same
 * answer; the write FORM is not part of the question.
 */
function _withheldEditAddresses(
  session: WorkspaceSession,
  args: Record<string, unknown>,
  resolveHandlePath?: (handle: string) => string | undefined,
): HandlePathPair[] {
  const pairs: HandlePathPair[] = [
    ...requestedEditHandles(args).map((handle) => ({
      handle,
      path: resolveHandlePath?.(handle) ?? "",
    })),
    ...requestedEditPaths(args).map((path) => ({ handle: "", path })),
  ];
  return pairs
    .filter((pair) => _editAddressResidency(session, pair.handle, pair.path) === "withheld")
    .filter((pair, index, all) =>
      all.findIndex((other) => other.handle === pair.handle && other.path === pair.path) === index);
}

/**
 * Defensive per-session element bound for `recordedVerifyObligations`. The
 * PRODUCER (`features/task-pack/sfVerifyObligations.ts`) already caps a
 * contract at 8, and the CONSUMER (`protocol/readFamily.ts`'s
 * `VERIFY_MAX_OBLIGATIONS`) caps the gate at 12 and DISCLOSES what it dropped;
 * this bound sits above both so it never silences that disclosure in any shape
 * production can reach — it exists only so a hostile/oversized contract cannot
 * park an unbounded array on the session.
 */
const RECORDED_VERIFY_OBLIGATIONS_MAX = 32;

/**
 * FX-G-A (round-12 finding 1): the single greppable writer for "this task
 * epoch's recorded verify obligations are gone". Called by EVERY site that
 * writes `session.executionFence = undefined` — the three inside
 * `recordExecutionContract` and, the ones that were missing, the two
 * `taskEpoch:"new"` epoch boundaries in `guardExecutionDiscovery` /
 * `guardExecutionEdit`. Keeping one function (rather than five inline
 * assignments) is what makes the fence/obligation co-lifetime invariant
 * checkable by grep, which is how this defect got past review the first time.
 */
function _clearRecordedVerifyObligations(session: WorkspaceSession): void {
  session.recordedVerifyObligations = undefined;
}

/**
 * A1 (2026-08-01 signal5-2): serve-time admissibility feed. Any content-bearing
 * serve (pack surface, slice, full, handles read) makes its handle/path
 * edit-admissible for the rest of the epoch, independent of whether a ready
 * certificate ever mentions it. Callers pass only what actually carried bytes.
 */
export function recordServedEditAdmissibility(
  workspaceRoot: string,
  entries: { handles?: readonly string[]; paths?: readonly string[] },
): void {
  const session = getSession(workspaceRoot);
  if (entries.handles !== undefined && entries.handles.length > 0) {
    _appendAdmissible(session.admissibleEditHandles, entries.handles);
  }
  if (entries.paths !== undefined && entries.paths.length > 0) {
    _appendAdmissible(session.admissibleEditPaths, entries.paths);
  }
  // FX-L: this function's contract is already "callers pass only what actually
  // carried bytes", so it is the exact, and only, place the SHIPPED half of
  // per-address residency is established. It runs BEFORE
  // `recordWithheldEditAddresses` in the booking pass, which is what makes a
  // path with one body-bearing and one bodyless row resolve to "shipped".
  _markEditResidency(session.editHandleResidency, entries.handles ?? [], "shipped");
  _markEditResidency(session.editPathResidency, entries.paths ?? [], "shipped");
  // Ticket 1 (2026-08-07): pair handles with paths ONLY when this call's own
  // arrays arrived at matching length — this call site's real caller
  // (readCodeTaskPack.ts finalizePackServeState) maps both from the SAME
  // served-surface list, so equal length here means positional correspondence
  // (`admissibleServed.map(s=>s.handle)` vs `.map(s=>s.path)`); an unequal
  // length means that caller's own handle-filter dropped a handle-less
  // surface, so correspondence is already lost before this function sees it
  // — recording each side UNPAIRED there is honest, guessing which handle
  // went with which path is exactly what this ticket removes.
  if (
    entries.handles !== undefined && entries.paths !== undefined
    && entries.handles.length === entries.paths.length && entries.handles.length > 0
  ) {
    const paths = entries.paths;
    _appendAdmissiblePairs(session.admissibleEditTargetPairs,
      entries.handles.map((handle, i) => ({ handle, path: paths[i]! })));
  } else {
    if (entries.handles !== undefined && entries.handles.length > 0) {
      _appendAdmissiblePairs(session.admissibleEditTargetPairs,
        entries.handles.map((handle) => ({ handle, path: "" })));
    }
    if (entries.paths !== undefined && entries.paths.length > 0) {
      _appendAdmissiblePairs(session.admissibleEditTargetPairs,
        entries.paths.map((path) => ({ handle: "", path })));
    }
  }
}

/**
 * W1 (2026-08-07, create-frontier lifecycle): enroll a path this server ITSELF
 * just WROTE into the epoch-scoped admissible edit union, at write time.
 *
 * Measured incident (2026-08-07-semantic-signal5-2): L1 made `create:true`
 * self-authorizing, so the file landed in one call — but the created path
 * entered no admissible set, so the very next `edit_file` against it was
 * refused `execution-typestate` / `batch-edit-certified-frontier`, advertising
 * a frontier that omitted the file this session had just authored. The
 * observed recoveries were a re-READ of our own fresh bytes (5 turns for one
 * edit) and desertion to native tools (6 native escapes in one cell).
 *
 * Why this cannot widen containment or the answer fence:
 *   - It is called ONLY after createFile.ts returned ok:true, i.e. after the
 *     --allow-write gate, the lexical workspace-prefix check and the realpath
 *     walk to the nearest existing ancestor all passed. A create that never
 *     happened enrolls nothing, and none of those checks are reachable here.
 *   - The path is workspace-relative and the union is keyed by workspace root
 *     (getSession), so it is admissible in exactly the tree it was written
 *     into and in no other.
 *   - The answer-fence create gate is UPSTREAM: guardExecutionEdit refuses a
 *     create under an answer certificate BEFORE any write (D5/W4, L1.4), so no
 *     answer fence can reach this function with a path it did not already
 *     admit — this can only ever re-record something already admissible there.
 *   - A create that FAILED (file_exists in particular) enrolls nothing: see
 *     createTargetExistsRefusal in server.ts for why a bounced create must not
 *     become a blind-edit bypass of the frontier.
 */
export function recordCreatedEditAdmissibility(
  workspaceRoot: string,
  created: { handle?: string; path: string },
): void {
  if (created.path === "") return;
  recordServedEditAdmissibility(workspaceRoot, {
    handles: created.handle !== undefined && created.handle !== "" ? [created.handle] : [],
    paths: [created.path],
  });
}

/** Install (or clear) the workspace's runtime fence from a final wire contract. */
export function recordExecutionContract(
  workspaceRoot: string,
  query: string,
  contract: TaskExecutionContract | undefined,
  sanctionedDiscovery?: { tool: "read_file" | "search_files"; args: Record<string, unknown> },
  /**
   * Defect G (2026-08-13): the handles whose surfaces shipped `remaining_ranges`
   * on the response installing this fence, plus the route's own
   * `max_additional_tl_calls`. Passed in from recordTaskPackExecution, the only
   * layer that sees the FINAL normalized route next to the FINAL surfaces.
   */
  sanctionedZoom?: { handles: readonly string[]; budget: number },
  batchEditTargets: readonly HandlePathPair[] = [],
  /**
   * VF-5 hand-off: this call's `TaskChangeContract.verify_obligations`, when
   * the caller (server.ts) has one to report. Recorded verbatim, alongside
   * every "ready" contract this function sees (even a compact pack_unchanged
   * one) so a LATER, kit-less `read.closure` call in the SAME task epoch can
   * still recover it via `recordedVerifyObligations()`.
   *
   * SET SEMANTICS (FX-G-A, round-12 finding 1) — REPLACE, never merge:
   *   - `undefined`  = this caller has no `verify_obligations` FIELD to report
   *     at all (the flag is off, or the contract carried none): the recorded
   *     value is left untouched.
   *   - `[]`         = this contract reported the field and it is EMPTY, i.e.
   *     "this task has no verify obligations": the recorded value is CLEARED.
   *     It used to be ignored, so one task's obligations outlived every
   *     later contract in the session that honestly reported none.
   *   - non-empty    = REPLACES whatever was recorded. Never unioned with an
   *     earlier contract's list: obligations are per-contract, and merging
   *     two contracts' lists would withhold a closure for a file the live
   *     contract does not name.
   */
  verifyObligations?: readonly TaskVerifyObligation[],
): "installed" | "cleared" | "revoked" {
  const session = getSession(workspaceRoot);
  const certificate = contract?.readiness_certificate;
  const previousFence = session.executionFence;
  const rememberInvalidatedPreparedHandles = (): void => {
    if (previousFence?.phase !== "prepared") return;
    const handles = [...new Set(previousFence.actionFrontier.filter((handle) => handle !== ""))];
    if (handles.length === 0) return;
    session.pendingPreparedHandleAdvisory = `prepared handle(s) ${handles.join(", ")} were superseded before execution`;
  };
  if (contract?.state !== "ready") {
    rememberInvalidatedPreparedHandles();
    session.executionFence = undefined;
    _clearRecordedVerifyObligations(session);
    return "cleared";
  }
  if (verifyObligations !== undefined) {
    session.recordedVerifyObligations = verifyObligations.length > 0
      ? verifyObligations.slice(0, RECORDED_VERIFY_OBLIGATIONS_MAX)
      : undefined;
  }
  const certificateId = certificate?.id ?? contract.typestate.certificate_id;
  // A challenged proof must not be re-armed by a compact pack_unchanged
  // response or by a deterministic recomputation of the same evidence.  A
  // genuinely different proof has a different certificate id and remains
  // installable.  taskEpoch:"new" clears this set below.
  if (certificateId && session.revokedCertificateIds.has(certificateId)) {
    return "revoked";
  }
  // Compact pack_unchanged contracts intentionally omit proof payloads.  They
  // may retain an already-installed fence, but can never create a new one.
  if (certificate === undefined) {
    if (certificateId && session.executionFence?.certificateId === certificateId) return "installed";
    session.executionFence = undefined;
    _clearRecordedVerifyObligations(session);
    return "cleared";
  }
  // `evidence` is OPTIONAL since 2026-08-14: a computed proof carries it, a
  // re-serve BINDING does not (`certificateBindingFor`). `?? []` is the same
  // answer the retention trim already produced by writing `evidence: []`, so
  // this reads a binding exactly as it read a trimmed proof — the frontier and
  // the admissible union come from `evidence_handles`/`action_frontier`, which
  // both forms carry.
  const evidence = certificate.obligations.flatMap((obligation) => obligation.evidence ?? []);
  const evidenceHandleSet = new Set(certificate.evidence_handles);
  // Wave 4 fix (2026-07-24 T13 forensics): action_frontier entries were
  // intersected with evidence_handles, so a frontier handle minted outside the
  // obligation evidence set was silently dropped AND misclassified as a path —
  // the edit guard then refused the very handle the certificate itself listed
  // ("edit target is outside certificate frontier handles=h134"). Classify by
  // shape instead: handle-shaped entries are frontier handles, verbatim.
  const actionHandles = new Set(certificate.action_frontier.filter((entry) =>
    /^h[0-9a-z]+$/.test(entry) || evidenceHandleSet.has(entry)
  ));
  const explicitActionPaths = certificate.action_frontier.filter((entry) => !actionHandles.has(entry));
  // Ticket 1 (2026-08-07): the certificate's OWN {handle,path} pairing, built
  // directly from its evidence — the true correspondence, no guessing needed,
  // since evidence items are already {handle,path} records. Read by
  // write_targets (executionRefusal) and by the admissible-union pair
  // accumulation below. An action-frontier handle with no matching evidence
  // entry (the Wave-4 comment above: "a frontier handle minted outside the
  // obligation evidence set") gets path:"" rather than being silently
  // dropped from the pairing.
  const evidenceByHandle = new Map(evidence.map((item) => [item.handle, item.path] as const));
  const actionTargetPairs: HandlePathPair[] = [
    ...[...actionHandles].map((handle) => ({ handle, path: evidenceByHandle.get(handle) ?? "" })),
    ...explicitActionPaths.map((path) => ({ handle: "", path })),
  ];
  // ---------------------------------------------------------------------
  // FX-L (2026-09-03, ruling (r)) — THE CERTIFICATE IS NOT WRITE AUTHORITY.
  //
  // `action_frontier` / `evidence_handles` name what this pack CITED. Write
  // authority comes only from SHIPPED BYTES: an address per-address residency
  // proves the caller holds (a body this session sent, a `code_unchanged`
  // restatement, a served range, or a file this server itself created).
  // Everything below — the fence, the answer-sub-read lift, and the epoch
  // admissible union — is built from the SHIPPED projection of the raw
  // certificate read above.
  //
  // Measured defect (round-15 `r15_k`, all SF flags off): a `budget.bytes`
  // pack ships five bodyless rows, `priorEpochActionFrontier` carries one of
  // their handles into the next certificate's `action_frontier`, and this
  // function lifted it into `admissibleEditHandles` — so `edit_file
  // {handle:…}` landed `edit.applied` against a file the session sent no bytes
  // for, while the PATH form of the same edit refused. FX-K closed the union
  // half in the booking pass and recorded this half as carried-forward.
  //
  // WHY POSITIVE EVIDENCE ONLY. `addressShipped` refuses on `"withheld"` and
  // on nothing else: an address neither serve-time producer has ever seen is
  // `undefined` and stays admissible. Requiring positive proof of shipping
  // instead would refuse every certificate a read family outside the task-pack
  // booking pass minted — the T09/T10 "the gate refuses a handle this server
  // itself served" regression class, which is the one direction this file may
  // never move in.
  //
  // THE FILE IS THE UNIT OF BYTE RESIDENCY, so a known path outranks the handle
  // id: the same file is routinely re-emitted under a fresh handle, and the
  // pack withholds (or sends) the FILE, not one address for it. A handle whose
  // path is already proven resident is therefore admissible even though its own
  // row carried no body — withdrawing it would be the T09/T10 direction. Only
  // when no path is known (a certificate with no evidence pairing — exactly the
  // round-15 shape) does the handle's own residency decide.
  // FX-P1: ONE predicate (`_editAddressResidency`), three consumers. This call
  // is byte-for-byte the answer FX-L's inline copy gave — "withheld" refuses,
  // "shipped" and "unknown" admit — now shared with the edit gate and the
  // capped-recovery match so the three can never disagree about an address.
  const addressShipped = (handle: string, filePath: string): boolean =>
    _editAddressResidency(session, handle, filePath) !== "withheld";
  const pathOf = (handle: string): string => evidenceByHandle.get(handle) ?? "";
  const pairShipped = (pair: HandlePathPair): boolean => addressShipped(pair.handle, pair.path);
  const shippedActionHandles = new Set(
    [...actionHandles].filter((handle) => addressShipped(handle, pathOf(handle))),
  );
  const shippedExplicitActionPaths = explicitActionPaths.filter((entry) => addressShipped("", entry));
  const shippedEvidence = evidence.filter((item) => addressShipped(item.handle, item.path));
  const shippedEvidenceHandleSet = new Set(
    [...evidenceHandleSet].filter((handle) => addressShipped(handle, pathOf(handle))),
  );
  const shippedActionTargetPairs = actionTargetPairs.filter(pairShipped);
  // The complement, kept on the fence so the refusal it now produces is
  // RECOVERABLE rather than refuse-only (ruling (r)): these are exactly the
  // addresses this certificate promised and this session never sent, and a
  // `read_file` of them restores their authority in one call.
  const rawEvidenceOnlyPairs: HandlePathPair[] = [...evidenceHandleSet]
    .filter((handle) => !actionHandles.has(handle))
    .map((handle) => ({ handle, path: pathOf(handle) }));
  const withheldTargets: HandlePathPair[] = [...actionTargetPairs, ...rawEvidenceOnlyPairs]
    .filter((pair) => !pairShipped(pair))
    .filter((pair, index, all) =>
      all.findIndex((other) => other.handle === pair.handle && other.path === pair.path) === index)
    .slice(0, WITHHELD_TARGET_CAP);
  // ---------------------------------------------------------------------
  const terminalAction: "answer" | "edit" = contract.next_action === "answer" ? "answer" : "edit";
  // A3 (2026-08-01 signal5-2 T10): an explicit answer-profile SUB-READ inside a
  // live change epoch must not downgrade the edit-authorizing fence — the
  // last-writer-wins replacement below is what turned one trivia read into two
  // edit refusals and a taskEpoch:"new" detour. Keep the edit fence installed;
  // the answer certificate's evidence still feeds the admissible union so the
  // content it served stays edit-admissible.
  const liveFence = session.executionFence;
  if (
    terminalAction === "answer"
    && liveFence !== undefined
    && liveFence.terminalAction === "edit"
    && (liveFence.phase === "prepared" || liveFence.phase === "acting" || liveFence.phase === "verifying")
  ) {
    // FX-L: the answer certificate's evidence feeds the union exactly as
    // before — but only the SHIPPED half of it. An answer sub-read that cited
    // a bodyless row must not hand the live edit fence authority the pack
    // itself never sent bytes for.
    _appendAdmissible(session.admissibleEditHandles, [...shippedEvidenceHandleSet]);
    _appendAdmissible(session.admissibleEditPaths, shippedEvidence.map((item) => item.path));
    _appendAdmissiblePairs(session.admissibleEditTargetPairs,
      shippedEvidence.map((item) => ({ handle: item.handle, path: item.path })));
    return "installed";
  }
  // 2026-07-25 T13 forensics: an edit-terminal certificate with NO frontier
  // handles, NO frontier paths, and NO evidence arms a fence that can only
  // refuse — every edit is "outside certificate frontier" by construction and
  // the refusal's own frontier payload is empty. A refuse-only fence is
  // strictly worse than no fence: leave edits ungated instead.
  //
  // FX-L (ruling (r)) — READ ON THE RAW CERTIFICATE, DELIBERATELY. The hatch
  // answers "was there anything to fence at all", which is a question about
  // the CERTIFICATE, not about residency. Re-pointing it at the shipped
  // projection is exactly the attempt FX-K measured and reverted: a
  // cap-overflowing pack's certificate filters to empty, the hatch fires, the
  // fence is CLEARED, and four refusals (including a never-packed control)
  // become four `edit.applied` — the narrowing opens edits in precisely the
  // case it was written to close. So: no certificate content ⇒ no fence (this
  // branch, byte-identical to before); a certificate whose addresses were all
  // withheld ⇒ the fence STAYS and refuses, with a recoverable `next`
  // (`withheldTargets`, consumed by executionRefusal).
  if (
    terminalAction === "edit"
    && actionHandles.size === 0
    && explicitActionPaths.length === 0
    && evidence.length === 0
    && session.admissibleEditHandles.length === 0
    && session.admissibleEditPaths.length === 0
  ) {
    session.executionFence = undefined;
    _clearRecordedVerifyObligations(session);
    return "cleared";
  }
  // Defect G: the zoom sanction is a property of the RESPONSE that installed
  // this fence, so it is rebuilt (never inherited) with every install — a later
  // pack whose surfaces are complete must not keep an earlier pack's budget
  // alive. Budget is clamped to a small integer: the route is the authority on
  // whether one more call is affordable, not on how many.
  const zoomHandles = [...new Set((sanctionedZoom?.handles ?? []).filter((h) => typeof h === "string" && h !== ""))];
  const rawBudget = sanctionedZoom?.budget ?? 0;
  const zoomBudget = Number.isFinite(rawBudget)
    ? Math.min(Math.max(0, Math.trunc(rawBudget)), SANCTIONED_ZOOM_BUDGET_CAP)
    : 0;
  const zoomSanction = zoomHandles.length > 0 && zoomBudget > 0
    ? { zoomHandles, zoomRemaining: zoomBudget }
    : undefined;
  if (previousFence?.phase === "prepared" && previousFence.certificateId !== certificate.id) {
    rememberInvalidatedPreparedHandles();
  }
  session.executionFence = {
    phase: "prepared",
    certificateId: certificate.id,
    taskFingerprint: certificate.task_fingerprint,
    epochQuery: query ?? "",
    epochTokens: tokenizeForEpoch(query),
    terminalAction,
    obligationIds: certificate.obligations.map((obligation) => obligation.id),
    // FX-L: every membership predicate the edit gate reads off this fence is
    // the SHIPPED projection of the certificate. The raw certificate survives
    // only in `obligationIds` (challenge authorship, which grants no writes)
    // and in `withheldTargets` (the recovery `next`).
    evidenceHandles: [...shippedEvidenceHandleSet],
    evidencePaths: [...new Set(shippedEvidence.map((item) => item.path))],
    actionFrontier: [...shippedActionHandles],
    actionPaths: [...new Set([
      ...shippedExplicitActionPaths,
      ...shippedEvidence.filter((item) => shippedActionHandles.has(item.handle)).map((item) => item.path),
    ])],
    actionTargetPairs: shippedActionTargetPairs,
    ...(withheldTargets.length > 0 ? { withheldTargets } : {}),
    // FX-L: a batch obligation is a REQUIREMENT to write a target. Requiring
    // one the fence will then refuse as unshipped is a deadlock, so the same
    // shipped predicate narrows it. Pure narrowing of a demand — it can never
    // widen authority, and it is a no-op whenever nothing was withheld.
    batchEditTargets: batchEditTargets.filter(pairShipped).filter((pair) => pair.handle !== "" || pair.path !== "").filter((pair, index, all) => all.findIndex((candidate) => candidate.handle === pair.handle && candidate.path === pair.path) === index).slice(0, 12).map((pair) => ({ ...pair })),
    challengeCount: 0,
    discoverySignatures: new Map(),
    zeroByteSignatures: new Set(),
    // ONE accounting home for every sanctioned post-prepared discovery call,
    // so an advertised zoom is never a new uncounted class next to the exact
    // signature follow-up.
    ...(sanctionedDiscovery !== undefined || zoomSanction !== undefined
      ? {
          sanctionedDiscovery: {
            signature: sanctionedDiscovery !== undefined
              ? discoveryCallSignature(sanctionedDiscovery.tool, sanctionedDiscovery.args)
              : "",
            remaining: sanctionedDiscovery !== undefined ? 1 : 0,
            ...(zoomSanction ?? {}),
          },
        }
      : {}),
  };
  session.lastExecutionCertificateId = certificate.id;
  // Frontier-union fix (2026-07-24 T10): accumulate THIS certificate's handles
  // (action_frontier ∪ evidence_handles) and paths (explicit action paths ∪
  // evidence paths) into the epoch-scoped admissible union, so a LATER
  // certificate replacing the fence does not strand an EARLIER pack's editable
  // handle. actionHandles is the wave-4 shape-classified set, so an h-shaped
  // frontier entry outside the evidence set is still admitted as a handle (and
  // is never mixed into the path list).
  // FX-L (ruling (r)): the lift is the SHIPPED intersection, never the raw
  // certificate. This is the line the round-15 repro rode into the union.
  _appendAdmissible(session.admissibleEditHandles, [...shippedActionHandles, ...shippedEvidenceHandleSet]);
  _appendAdmissible(session.admissibleEditPaths, [
    ...shippedExplicitActionPaths,
    ...shippedEvidence.map((item) => item.path),
  ]);
  // Ticket 1 (2026-08-07): the paired counterpart of the two accumulations
  // above. actionTargetPairs already covers action_frontier's own handles/
  // paths; evidence-cited handles OUTSIDE the action frontier (supporting
  // evidence, not itself a write target, e.g. evidenceHandleSet \ actionHandles)
  // still belong in the admissible union, paired via the same evidenceByHandle
  // lookup so no guessed correspondence enters the union either.
  const evidenceOnlyPairs: HandlePathPair[] = [...shippedEvidenceHandleSet]
    .filter((handle) => !shippedActionHandles.has(handle))
    .map((handle) => ({ handle, path: pathOf(handle) }));
  _appendAdmissiblePairs(session.admissibleEditTargetPairs, [...shippedActionTargetPairs, ...evidenceOnlyPairs]);
  return "installed";
}

/**
 * Arguments deliberately OUTSIDE the discovery signature, each for a stated
 * reason (everything else the caller sends is part of the call's identity):
 *   - `cwd`/`lane` select WHICH session the counter lives in, so the fence
 *     doing the counting already encodes them.
 *   - `taskEpoch`/`challenge` are decision-reset inputs handled ABOVE the
 *     brake in guardExecutionDiscovery — a call carrying either never reaches
 *     the signature at all.
 *   - `taskProfile` is a routing declaration, not a byte selection; admitting
 *     it would turn a profile flip into a brake-evasion lever.
 *   - `credentialRef`/`outputCredentialRef` are opaque secret references and
 *     never belong in a derived key.
 * The leading block is the set already carried EXPLICITLY by the tuple.
 */
const SIGNATURE_IGNORED_ARGS: ReadonlySet<string> = new Set([
  "mode", "action", "path", "paths", "handle", "handles", "query", "queries",
  "range", "ranges", "sections", "pages", "slides", "sheet", "symbol",
  "archive", "cursor", "qref",
  "cwd", "lane", "taskEpoch", "challenge", "taskProfile",
  "credentialRef", "outputCredentialRef",
]);

/** Key-sorted JSON, so the signature is stable under argument insertion order. */
function stableSignatureJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableSignatureJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort()
    .map((key) => `${JSON.stringify(key)}:${stableSignatureJson(record[key])}`)
    .join(",")}}`;
}

/**
 * Window selectors, ORDER-PRESERVING on purpose: server.ts re-emits segments in
 * the order the caller asked for them, so a re-ordered window list is a
 * different response — and where the two readings differ, this one errs toward
 * SERVING, which is the safe direction for a brake whose measured failure mode
 * was refusing work that had never been requested.
 */
function signatureWindowList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => (typeof entry === "string" ? entry : stableSignatureJson(entry)))
    : [];
}

/** An archive read's identity is the member/prefix, not just the container. */
function archiveSignatureParts(value: unknown): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return ["", "", ""];
  const selector = value as Record<string, unknown>;
  const str = (key: string): string => (typeof selector[key] === "string" ? selector[key] as string : "");
  return [str("path"), str("member"), str("prefix")];
}

/**
 * Normalized discovery-call signature for the loop brake: identical tool +
 * mode/action + targets + WINDOW SELECTION + query.
 *
 * L1 (2026-08-08, live stdio forensics against b0cd81bf): the tuple used to be
 * [tool, mode, paths, handles, query, queries, range, symbol] — every
 * MULTI-window selector was missing. Three genuinely distinct zoom windows on
 * one handle (`ranges:["35-45"]`, then `["46-56"]`, then `["57-67"]`) hashed to
 * ONE signature, so the third was refused with "this exact call already ran
 * twice" — a false statement about a window that had never been requested.
 * Same for three distinct `sections`, and for a `references` walk whose pages
 * differ only in `cursor` (the guide tells callers to run that next_call "to
 * exhaustion", i.e. straight into the brake). The singular `range` WAS present,
 * which is exactly why path+range zooms stayed per-window granular while the
 * `ranges:[..]` form AGENTS.md advertises as canonical did not.
 *
 * The rule is now positive and complete: every argument that changes WHICH
 * BYTES come back is part of the identity — named explicitly where it is a
 * known selector, and carried by the trailing `rest` element otherwise, so the
 * next selector this API grows cannot silently re-open the defect. Only
 * SIGNATURE_IGNORED_ARGS stays out.
 *
 * Different windows/paths/queries are different work (served); the SAME call
 * shape repeated is the runaway pattern the typestate gate exists to stop, and
 * it still collides byte-for-byte.
 */
function discoveryCallSignature(tool: string, args: Record<string, unknown>): string {
  const mode = String(args["mode"] ?? args["action"] ?? "auto");
  const paths = [
    ...(typeof args["path"] === "string" ? [args["path"]] : []),
    ...(Array.isArray(args["paths"])
      ? args["paths"].map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
      : []),
  ].sort();
  const handles = [
    ...(typeof args["handle"] === "string" ? [args["handle"]] : []),
    ...(Array.isArray(args["handles"]) ? args["handles"].filter((h): h is string => typeof h === "string") : []),
  ].sort();
  const query = typeof args["query"] === "string" ? args["query"].trim().toLowerCase() : "";
  const queries = Array.isArray(args["queries"])
    ? args["queries"].filter((q): q is string => typeof q === "string").map((q) => q.toLowerCase()).sort()
    : [];
  const range = typeof args["range"] === "string" ? args["range"] : "";
  const ranges = signatureWindowList(args["ranges"]);
  const sections = signatureWindowList(args["sections"]);
  const pages = signatureWindowList(args["pages"]);
  const slides = signatureWindowList(args["slides"]);
  const sheet = typeof args["sheet"] === "string" ? args["sheet"] : "";
  const symbol = typeof args["symbol"] === "string" ? args["symbol"] : "";
  const archive = archiveSignatureParts(args["archive"]);
  // `cursor` is the references pager: successive pages of ONE walk differ in
  // nothing else at all, so without it page 3 is "the same call" as page 1.
  const cursor = typeof args["cursor"] === "string" ? args["cursor"] : "";
  const qref = typeof args["qref"] === "string" ? args["qref"] : "";
  const rest = Object.keys(args)
    .filter((key) => !SIGNATURE_IGNORED_ARGS.has(key))
    .sort()
    .map((key) => `${key}=${stableSignatureJson(args[key])}`);
  return JSON.stringify([
    tool, mode, paths, handles, query, queries,
    range, ranges, sections, pages, slides, sheet, symbol, archive, cursor, qref, rest,
  ]);
}

/** Windows a self-material receipt will name before it stops enumerating. */
const SELF_MATERIAL_RECEIPT_WINDOW_CAP = 6;

/**
 * Defect G (2026-08-13): is this call the ZOOM the installing pack itself
 * advertised, and is there budget left for it? Consumes one unit and returns
 * true when so.
 *
 * Handle-scoped, not signature-scoped, because the surface advertises a LIST of
 * remaining_ranges and the caller legitimately picks which one it needs — the
 * live repro was refused for asking a different unserved window than the one
 * the surface's own next_call happened to name. Bounded three ways so it stays
 * a zoom affordance and never an open frontier: the handle must be one THIS
 * pack left partial, the call must be window-shaped (a re-pack or a search
 * against the same handle is not a zoom), and the route's budget is finite and
 * shared with the exact-signature sanction.
 */
function consumeSanctionedZoom(
  fence: ExecutionFenceState,
  tool: "read_file" | "search_files",
  args: Record<string, unknown>,
): boolean {
  if (tool !== "read_file") return false;
  const sanction = fence.sanctionedDiscovery;
  if (sanction?.zoomHandles === undefined || (sanction.zoomRemaining ?? 0) <= 0) return false;
  const handle = typeof args["handle"] === "string" ? args["handle"] : undefined;
  if (handle === undefined || !sanction.zoomHandles.includes(handle)) return false;
  const mode = typeof args["mode"] === "string" ? args["mode"] : "";
  const windowed = requestedLineWindows(args).length > 0
    || namedMaterialSelector(args) !== undefined
    || mode === "slice"
    || mode === "section";
  // A task_pack is a request for a NEW pack, never a zoom into this one, even
  // when it names a sanctioned handle.
  if (!windowed || mode === "task_pack") return false;
  sanction.zoomRemaining = (sanction.zoomRemaining ?? 0) - 1;
  return true;
}

/** Distinct zero-byte verdicts one fence remembers before evicting the oldest. */
const ZERO_BYTE_SIGNATURE_CAP = 64;

/**
 * Selectors that denote file material by NAME. The served-range ledger vouches
 * LINES, so it can never say which lines one of these resolves to — which is
 * exactly why a receipt minted from the file-level ledger for one of them is
 * not a well-formed claim (ND-1).
 */
const NAMED_MATERIAL_SELECTORS = ["symbol", "sections", "pages", "slides", "sheet"] as const;

function namedMaterialSelector(args: Record<string, unknown>): string | undefined {
  return NAMED_MATERIAL_SELECTORS.find((key) => {
    const value = args[key];
    return typeof value === "string" ? value !== "" : Array.isArray(value) && value.length > 0;
  });
}

/**
 * The line windows a call asks for, in request order. An `undefined` entry
 * marks a window this server cannot parse; callers must read one as "I do not
 * know what this call denotes", never as "this call names no window".
 */
function requestedLineWindows(args: Record<string, unknown>): Array<[number, number] | undefined> {
  const raw = [
    ...(Array.isArray(args["ranges"]) ? args["ranges"].map(String) : []),
    ...(typeof args["range"] === "string" ? [args["range"] as string] : []),
  ];
  return raw.map((spec) => {
    const parsed = /^L?(\d+)\s*-\s*L?(\d+)$/.exec(spec.trim());
    return parsed === null ? undefined : ([Number(parsed[1]), Number(parsed[2])] as [number, number]);
  });
}

/**
 * The self-material file a braked call is about: a path this session served
 * (the admissible union recordServedRange feeds), edited, or that the active
 * certificate carries as evidence. Shared by every brake decision so the
 * receipt, the stand-down and the rescue prescription can never disagree
 * about WHICH file the call names.
 */
function brakeTargetPath(
  session: WorkspaceSession,
  fence: ExecutionFenceState,
  args: Record<string, unknown>,
  resolveHandlePath?: (handle: string) => string | undefined,
): string | undefined {
  const handle = typeof args["handle"] === "string" ? args["handle"] : undefined;
  const targets = [
    typeof args["path"] === "string" ? args["path"] : undefined,
    handle !== undefined ? resolveHandlePath?.(handle) : undefined,
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate !== "");
  return targets.find((candidate) =>
    session.admissibleEditPaths.includes(candidate)
    || session.editedPaths.has(candidate)
    || fence.evidencePaths.includes(candidate));
}

/**
 * L2a (2026-08-08): the loop brake's answer when the repeated read targets
 * material THIS SESSION already put on the wire — the admissible edit union
 * (recordServedEditAdmissibility / recordCreatedEditAdmissibility, plus the
 * serve-time enrolment recordServedRange performs) or the certificate's own
 * evidence paths.
 *
 * The brake used to answer such a repeat with the full execution-typestate
 * refusal (~1245 B) whose required_action ("verify-with-closure-or-diff") did
 * not clear the counter — measured: closure, diff, find, tree and even a
 * further SUCCESSFUL edit all left it standing, so the certificate refused
 * that call for the rest of the session. A repeat of our OWN bytes has a
 * strictly cheaper and strictly more useful answer (~470 B): the receipt the
 * slice path already emits for a window the caller demonstrably holds — the
 * sha those bytes were served at, the windows, and which call served them.
 * Same shape as server.ts's deferred-held entries ({range, sha,
 * code_unchanged, served_by}), with the per-window sha hoisted because every
 * window here belongs to ONE file at ONE sha.
 *
 * A prepared fence never promises newly served bytes. It may return this compact
 * action receipt, or the proof-gated held-window receipt below when the ledger
 * can vouch for bytes the caller already has.
 *
 * ---------------------------------------------------------------------------
 * 2026-08-13 prepared-stop receipt honesty (live repro on the shipped dist +
 * code forensics). This receipt was a pure function of (fence, session,
 * repeated): a suppressed handle read, a read of a file never opened, a `find`
 * search and a task_pack for an unrelated question all produced BYTE-IDENTICAL
 * payloads, each asserting `code_unchanged:true`. Four defects, fixed here:
 *
 *   A  It emitted placeholder-bearing next_calls (the challenge template, and
 *      via frontierNextCall an edit_file template carrying
 *      EDIT_SEARCH_PLACEHOLDER) WITHOUT `next_call_is_template`, the marker
 *      every other producer in this tree attaches. A caller that executes an
 *      unmarked template verbatim sends `<exact text to replace>` as real bytes.
 *   B  `code_unchanged:true` was unconditional — and this branch is reached
 *      precisely AFTER heldSelfMaterialReceipt failed to prove residency, so
 *      the one claim it made was the one claim it could not ground. Live: it
 *      claimed content-identity for an advertised-but-unserved range, a file
 *      never opened, a search, and a different file entirely. The certified
 *      DECISION is what is unchanged here; `decision_unchanged` says exactly
 *      that and asserts nothing about file bytes. Genuine residency receipts
 *      (heldSelfMaterialReceipt, pack_unchanged) keep `code_unchanged`.
 *   C  The fence knew its task (taskFingerprint/epochTokens/epochQuery) and
 *      disclosed none of it: `certified_query` + `refused` now say WHICH task
 *      certified the stop and WHICH call was stopped.
 *   D  It attached a bare challengeTemplate while terminal refusals get the
 *      richer unlockPayload — so `taskEpoch:"new"`, the one escape that works
 *      unconditionally, was never named. `unlock` now carries both transitions.
 *   E  Worst of all, a task_pack for a genuinely DIFFERENT question was
 *      answered "answer-from-certified-evidence" — an instruction to answer a
 *      question the evidence had never seen. Suppression stays (an unrelated
 *      read mid-task is still usually a mistake), but the receipt now says
 *      `query_mismatch` and hands back an executable re-pack instead of a
 *      fabrication prompt.
 * ---------------------------------------------------------------------------
 */
function preparedDiscoveryReceipt(
  session: WorkspaceSession,
  fence: ExecutionFenceState,
  workspaceRoot: string | undefined,
  repeated: boolean,
  tool: "read_file" | "search_files",
  args: Record<string, unknown>,
): Record<string, unknown> {
  const isEdit = fence.terminalAction === "edit";
  const handles = isEdit
    ? mergeFrontier(fence.actionFrontier, session.admissibleEditHandles, FRONTIER_HANDLE_CAP)
    : [];
  const paths = isEdit
    ? mergeFrontier(fence.actionPaths, session.admissibleEditPaths, FRONTIER_PATH_CAP)
    : [];
  const challenge = challengeTemplate(fence, CHALLENGE_LEAD_EVIDENCE);
  const mismatch = newTaskQueryMismatch(fence, tool, args);
  const nextCall = mismatch !== undefined
    ? {
        tool: "read_file",
        arguments: {
          mode: "task_pack",
          // Verbatim, never an excerpt: this call must be EXECUTABLE, and a
          // truncated query is a different task. Same convention as the
          // revocation rewrite's rescopeCall in server.ts.
          query: mismatch,
          taskEpoch: "new",
          ...(workspaceRoot ? { cwd: workspaceRoot } : {}),
        },
      }
    : frontierNextCall(fence, handles, paths, workspaceRoot, false);
  // [R5-10] F-1 (2026-08-14) — WHY THIS PRESCRIPTION IS LEFT AS IT IS.
  //
  // `frontierNextCall` may return a PLACEHOLDER call here: an `edit_file` whose
  // `search`/`replace` the caller fills in, or a `challenge` whose
  // `expected_action_change` it writes. That is the correct in-process
  // prescription — CONDITION ① pins it, and it names the edit frontier, which
  // nothing else does — but §2.6 forbids a placeholder-bearing call ON THE
  // WIRE, so `envelope.ts`'s `scrubTemplateCalls` deletes it there. Composed
  // with the E4 deletion of `unlock` and the receipt projector's own field
  // list, that left F-1's stop with no continuation at all.
  //
  // The repair belongs on the WIRE side, not here: `readFamily.ts`'s
  // `projectReceipt` mints the executable floor (a `taskEpoch:"new"` re-pack
  // scoped to this call's own target, read from the funnel's inbound `args`)
  // for exactly the receipts whose `next_call` the scrub removed. Fixing it in
  // this function instead would change what the fence prescribes in-process —
  // a semantics change §0.2 forbids, and the thing the CONDITION ① pins exist
  // to catch.
  const certifiedQuery = truncateForReceipt(fence.epochQuery, CERTIFIED_QUERY_CAP);
  // [R5-10a] (ratified 2026-08-14) — THE RECEIPT NAMES WHAT IT CERTIFIED.
  //
  // A.2.4 types `CertificateRef.obligations` REQUIRED and non-empty, and A.4
  // makes `certificate` the required member of the `decision-unchanged` form,
  // but this emitter shipped a bare `certificate_id` and the projector's `{id}`
  // fallback fired on every one of them. The justification recorded on the
  // projector — that the fence "retains only the certificate id" — was simply
  // false at HEAD: `obligationIds` is populated straight from the certificate
  // when the contract is recorded and is already read by `applyChallenge`.
  //
  // §2.1.1's floor is stated PER OBLIGATION, so a receipt that says "the
  // certified decision stands" without naming what it certified cannot be
  // checked against that floor. These ids are transcribed, never synthesised —
  // an invented obligation list is exactly the false proof the 2026-08-13
  // honesty fix removed. When the fence somehow holds none (theoretically
  // impossible: an accepted ready contract always carries at least one), the
  // record is OMITTED and the projector's id-only fallback stands, because an
  // empty `obligations: []` would both violate the declared non-empty tuple and
  // assert "certified nothing", which is worse than saying less.
  //
  // WorkspaceMarker is deliberately NOT added: the ruling's scope is
  // `obligations` only, and the fence carries `taskFingerprint`, a different
  // shape — re-asserting a possibly stale marker is its own decision.
  const certificate = fence.obligationIds.length > 0
    ? { id: fence.certificateId, obligations: [...fence.obligationIds] }
    : undefined;
  return {
    ok: true,
    receipt: "prepared-discovery-closed",
    reason: "prepared-discovery-closed",
    // NOT `code_unchanged`: see defect B above.
    decision_unchanged: true,
    new_content: false,
    phase: "prepared",
    certificate_id: fence.certificateId,
    ...(certificate !== undefined ? { certificate } : {}),
    ...(certifiedQuery !== "" ? { certified_query: certifiedQuery } : {}),
    terminal_action: fence.terminalAction,
    discovery_closed: true,
    refused: refusedCallDescriptor(tool, args),
    ...(mismatch !== undefined ? { query_mismatch: true } : {}),
    required_action: mismatch !== undefined
      ? "re-pack-new-epoch"
      : isEdit ? "batch-edit-certified-frontier" : "answer-from-certified-evidence",
    retry_same_call: false,
    ...(repeated ? { unchanged: "same prepared discovery request is already closed" } : {}),
    next_call: nextCall,
    // The marker rides the RESPONSE, never the arguments (executionRefusal's
    // convention): a marker inside `arguments` would make the prescription
    // unexecutable all over again.
    ...(containsTemplatePlaceholder(nextCall) ? { next_call_is_template: true } : {}),
    unlock: unlockPayload(fence),
    ...(challenge !== undefined ? { challenge } : {}),
    // Same once-per-session claim a served pack uses: a stop receipt is often
    // the first response an operator inspects, and it must be able to say
    // which build produced it — without paying the stamp twice.
    ...(_serverBuildId !== undefined && _claimServerBuild(session)
      ? { server_build: _serverBuildId }
      : {}),
  };
}

/** Longest `certified_query` a receipt will carry; enough to identify a task, not to re-transmit it. */
const CERTIFIED_QUERY_CAP = 96;
/** Longest query excerpt `refused.target` will carry. */
const REFUSED_TARGET_CAP = 64;

/** Caps `value` at `cap` CHARACTERS total, marking the cut so a reader never mistakes it for the whole string. */
function truncateForReceipt(value: string | undefined, cap: number): string {
  const text = (value ?? "").trim();
  if (text.length <= cap) return text;
  return `${text.slice(0, cap - 1)}…`;
}

/**
 * WHICH call this stop refused. Two jobs: it tells the caller what the server
 * thinks it just asked for (a stop that names nothing is unactionable), and it
 * breaks the pathological byte-identity that let four completely different
 * refusals produce the same payload.
 */
function refusedCallDescriptor(
  tool: "read_file" | "search_files",
  args: Record<string, unknown>,
): Record<string, unknown> {
  const str = (key: string): string | undefined => {
    const value = args[key];
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  const firstPath = Array.isArray(args["paths"])
    ? args["paths"].map((p) => (typeof p === "string" ? p : undefined)).find((p) => p !== undefined && p !== "")
    : undefined;
  const target = str("path")
    ?? firstPath
    ?? str("handle")
    ?? (str("query") !== undefined ? truncateForReceipt(str("query"), REFUSED_TARGET_CAP) : undefined);
  const selector = tool === "search_files" ? str("action") : str("mode");
  return {
    tool,
    ...(selector !== undefined ? (tool === "search_files" ? { action: selector } : { mode: selector }) : {}),
    ...(target !== undefined ? { target } : {}),
  };
}

/**
 * Does `value` still carry a `<...>` prescription placeholder anywhere?
 * Structural rather than a list of the known constants, so a next_call shape
 * added later cannot silently ship unmarked (the defect-A failure mode).
 */
function containsTemplatePlaceholder(value: unknown): boolean {
  if (typeof value === "string") return /<[^<>]{2,}>/.test(value);
  if (Array.isArray(value)) return value.some(containsTemplatePlaceholder);
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(containsTemplatePlaceholder);
  }
  return false;
}

/**
 * Defect E (2026-08-13). Is this refused call a task_pack whose query belongs
 * to a DIFFERENT task than the one the certificate closed? Returns the
 * caller's query verbatim when so, undefined otherwise.
 *
 * Suppression itself is unchanged and deliberate — an unrelated read in the
 * middle of a certified task is usually a detour, and auto-rotating the epoch
 * would silently discard a live certificate. What changes is the ANSWER: the
 * old receipt told such a caller to "answer from certified evidence", i.e. to
 * answer a question this evidence has never seen. Observed live: a probe asked
 * about CHANGELOG.md under a session.ts certificate and was pushed toward
 * fabricating the answer from session.ts.
 *
 * Deliberately narrow — every clause below rules out a FALSE mismatch:
 *   - both sides must have significant tokens (a queryless pack, or a fence
 *     opened queryless, proves nothing about task identity);
 *   - `qref`/`challenge`/`taskEpoch` callers are explicitly declaring their
 *     relationship to this epoch, so never second-guess them;
 *   - the same overlap predicate PackChecksState uses (_tokensOverlap), so the
 *     fence and the pack-check epoch can never disagree about task identity.
 */
function newTaskQueryMismatch(
  fence: ExecutionFenceState,
  tool: "read_file" | "search_files",
  args: Record<string, unknown>,
): string | undefined {
  if (tool !== "read_file" || args["mode"] !== "task_pack") return undefined;
  if (typeof args["qref"] === "string" && args["qref"] !== "") return undefined;
  if (args["taskEpoch"] !== undefined || args["challenge"] !== undefined) return undefined;
  const query = typeof args["query"] === "string" ? args["query"] : "";
  if (query.trim() === "") return undefined;
  const incoming = tokenizeForEpoch(query);
  if (incoming.length === 0 || fence.epochTokens.length === 0) return undefined;
  // [T1] Raised same-task bar - see the constraint comment above
  // `_PROTOCOL_VOCAB_STOPWORDS`. `_sameTaskQuery` true => same task => no
  // mismatch (undefined); false => this query names a NEW task, so the
  // caller re-packs into a fresh epoch (return the verbatim query).
  return _sameTaskQuery(query, incoming, fence.epochQuery, fence.epochTokens) ? undefined : query;
}

function heldSelfMaterialReceipt(
  session: WorkspaceSession,
  fence: ExecutionFenceState,
  args: Record<string, unknown>,
  resolveHandlePath?: (handle: string) => string | undefined,
): Record<string, unknown> | undefined {
  const selfMaterial = brakeTargetPath(session, fence, args, resolveHandlePath);
  if (selfMaterial === undefined) return undefined;
  const state = session.servedRangeLedger.get(selfMaterial);
  if (state === undefined || state.spans.length === 0) return undefined;

  const covered = mergeServedRanges(
    state.spans.map((span) => [span.start, span.end] as [number, number]),
  );
  const windowFor = (start: number, end: number): Record<string, unknown> | undefined => {
    if (!covered.some(([rangeStart, rangeEnd]) => rangeStart <= start && rangeEnd >= end)) return undefined;
    const servedBy = servedByLabel(state, start, end);
    return {
      range: `${start}-${end}`,
      code_unchanged: true,
      ...(servedBy !== undefined ? { served_by: servedBy } : {}),
    };
  };

  const requested = requestedLineWindows(args);
  const windows: Array<Record<string, unknown>> = [];
  for (const window of requested) {
    // An unparseable window is "I do not know what this call denotes", which
    // can never ground a residency claim.
    if (window === undefined) return undefined;
    const held = windowFor(window[0], window[1]);
    // One unheld window means this call is NOT a pure repeat of bytes the
    // caller holds — fall back to the refusal rather than overclaim.
    if (held === undefined) return undefined;
    windows.push(held);
  }
  if (requested.length === 0 && namedMaterialSelector(args) !== undefined) {
    // ND-1 (2026-08-08): the ledger vouches LINES; a NAMED selector
    // (symbol/sections/pages/slides/sheet) denotes lines it cannot name, so
    // falling through to the whole-file clusters below would answer a
    // question nobody asked — a symbol living at 19-38 could earn a receipt
    // reading `windows:[{range:"1-10"}]`. The claim is well-formed only when
    // this file's coverage is COMPLETE at this sha: then whatever the
    // selector denotes here is necessarily already held.
    if (unservedServedRanges(state.ranges, state.totalLines).length > 0) return undefined;
  }
  if (windows.length === 0) {
    // A partial range-ledger hit is not a whole-file residency proof. For a
    // broad full request, leave the guard open when any complement remains so
    // the normal full dispatcher can serve the fresh ranges (W14 L1/L3).
    const unserved = unservedServedRanges(state.ranges, state.totalLines);
    if (fence.phase === "prepared" && args["mode"] === "full" && unserved.length > 0) {
      return undefined;
    }
    // No explicit window — a whole-handle/whole-file repeat (the observed 3rd
    // `mode=full`). The ledger's own clusters ARE what those calls served.
    for (const [start, end] of covered.slice(0, SELF_MATERIAL_RECEIPT_WINDOW_CAP)) {
      const held = windowFor(start, end);
      if (held !== undefined) windows.push(held);
    }
  }
  if (windows.length === 0) return undefined;
  const cappedWindows = windows.slice(0, SELF_MATERIAL_RECEIPT_WINDOW_CAP);
  // FX-S #3 (2026-09-03), corrected 2026-09-05 (candidate 2 forensics). This
  // comment used to claim TL_RECEIPT_COVERAGE's `covered_by` "could never
  // surface" through THIS receipt — `heldSelfMaterialReceipt` is the
  // execution fence's OWN "you already hold these exact bytes" brake
  // (guardExecutionDiscovery), which intercepts a repeat read/zoom BEFORE any
  // mode dispatch (and therefore before `coverageReceiptFor`'s OTHER call
  // sites ever run) whenever a prepared certificate is active. THAT PART IS
  // STILL TRUE. What was wrong is the "could never surface" conclusion: it
  // was drawn from sfV2CombinedPin.spec.ts's own TL_RECEIPT_COVERAGE scenario
  // (its `fullA`/`fullB` calls), which does NOT actually exercise this brake
  // at all — `fullA`/`fullB` read `src/plain.ts`, a path that is never part
  // of the open certificate's own evidence/edit material
  // (`brakeTargetPath`'s admissibleEditPaths/editedPaths/fence.evidencePaths
  // union), so those calls fall through to the ORDINARY, fence-independent
  // `coverageReceiptFor` path instead (`coverageReceiptWiring.spec.ts`'s own
  // subject) — a DIFFERENT emit site that was already wired correctly. A
  // repeat read of material the certificate's OWN frontier actually names
  // (e.g. re-reading one of an edit-ready pack's explicit `targets` while
  // that pack's certificate is still open) DOES reach this function, and
  // live-verified (receiptCoverageFenceRepeat.spec.ts, the case this
  // forensics correction produced): `cappedWindows` below already carries
  // EXACTLY the CoveredSpan shape (`{range, served_by?}`) for every line this
  // claim corroborates, `protocol/envelope.ts`'s `priorOnlyTextReceipt`
  // recognizes `windowFor`'s per-window `code_unchanged:true` marker and
  // reconstructs the `receipt:"code-unchanged"` tag + `handle` this legacy
  // (`path`, no `receipt` tag) body shape lacks — forwarding `covered_by`
  // unmodified through its `{...body, ...}` spread — and `readFamily.ts`'s
  // `receiptOf`/`projectCoveredBy` then project it onto the wire exactly like
  // any other `code-unchanged` receipt. No code path drops it. Both
  // `priorOnlyTextReceipt` and `projectCoveredBy` gate on the SAME
  // `receiptCoverageEnabled()` flag this function reads below, so the
  // default-off wire stays untouched, byte-for-byte.
  const coveredBy = receiptCoverageEnabled()
    ? cappedWindows.map((window) => {
        const w = window as { range: string; served_by?: string };
        return { range: w.range, ...(w.served_by !== undefined ? { served_by: w.served_by } : {}) };
      })
    : undefined;
  return {
    ok: true,
    reason: "already-served",
    code_unchanged: true,
    path: selfMaterial,
    sha: state.fileSha.slice(0, 12),
    windows: cappedWindows,
    ...(coveredBy !== undefined && coveredBy.length > 0 ? { covered_by: coveredBy } : {}),
    phase: fence.phase,
    certificate_id: fence.certificateId,
    detail: "these lines are already in your context, unchanged since this session served them — act on them, or ask for a window you do not hold",
  };
}

/**
 * Third strike: the 1st and 2nd occurrences of one call shape are served, the
 * 3rd brakes. Unchanged from Wave 4 — L1 changed only what counts as "one
 * call shape", never how many repeats are tolerated.
 */
const DISCOVERY_LOOP_BRAKE_THRESHOLD = 2;

/**
 * L1b (2026-08-08): the brake's detail, worded so it can only ever state
 * something true. The predecessor asserted "this exact call already ran twice"
 * from a signature that did NOT distinguish windows, so it routinely said so
 * about a window that had never been requested; and the only ways forward it
 * named (required_action / challenge) did not clear the counter, which made
 * every hit terminal for the session. This text is defensive in both
 * directions: it says what the server actually compared (a byte-identical
 * call), and it names the escapes that genuinely release the brake — a
 * different selection, or a successful edit (L2b).
 */
const DISCOVERY_LOOP_BRAKE_DETAIL =
  "this call is byte-identical to two earlier calls under the active certificate, so its bytes are already in your context; "
  + "a different window, path, symbol or query is served normally, and a successful edit_file re-opens re-reads of what it changed — "
  + "those are the transitions that release it; otherwise challenge the certificate with the decision the evidence would change";

/**
 * ND-1 / ND-4 (2026-08-08 serve honesty): does the braked call provably serve
 * NO file bytes at all?
 *
 * Both brake answers assert residency — the receipt says "these lines are
 * already in your context", the refusal says "its bytes are already in your
 * context". That claim is only WELL-FORMED when the call would put bytes on
 * the wire. Two shapes observed live at 67da02c2 where it is not:
 *
 *   ND-1  read_file mode=symbol with an absent symbol. Calls 1 and 2 answered
 *         with the 395 B {code:"not-found", candidates, skeleton, next}; the
 *         3rd was answered from the FILE-level ledger with a 408 B
 *         {ok:true, reason:"already-served", windows:[{range:"1-41"}]} — a
 *         receipt for material that does not exist. Proven here by the
 *         identical predecessors' own outcome (noteDiscoveryServedNoBytes),
 *         which is observed ground truth, not a re-derived guess.
 *   ND-4  a window lying entirely past EOF. The read path answers it honestly
 *         (253 B: content "", the FILE's real sha, total_lines, a note) while
 *         the brake claimed bytes that were never served. Proven here from
 *         the ledger's own recorded totalLines.
 *
 * In both cases the honest brake answer is not a brake answer at all: the read
 * path's own response is idempotent, smaller than either brake payload, and
 * self-healing (candidates/next; the file's real line count). Standing down is
 * fail-safe by construction — the worst case is that the call simply executes.
 */
function brakedCallServesNoBytes(
  session: WorkspaceSession,
  fence: ExecutionFenceState,
  signature: string,
  args: Record<string, unknown>,
  resolveHandlePath?: (handle: string) => string | undefined,
): boolean {
  if (fence.zeroByteSignatures.has(signature)) return true;
  const requested = requestedLineWindows(args);
  if (requested.length === 0 || requested.some((window) => window === undefined)) return false;
  const path = brakeTargetPath(session, fence, args, resolveHandlePath);
  if (path === undefined) return false;
  const state = session.servedRangeLedger.get(path);
  if (state === undefined) return false;
  // EVERY window must lie past EOF. One window that still overlaps the file
  // means the call serves bytes, and the brake keeps its teeth.
  return requested.every((window) => window![0] > state.totalLines);
}

/**
 * ND-3 (2026-08-08): the ONE concrete, executable call that actually re-opens
 * progress for a braked read — a window of the same file the caller does not
 * already hold, taken from the served-range ledger's own `unserved` list. A
 * real call, not a placeholder. `undefined` when the ledger cannot name one
 * (nothing served for this path, or the file is fully served already), in
 * which case the refusal falls back to the frontier prescription.
 */
function brakeRescopeNextCall(
  session: WorkspaceSession,
  fence: ExecutionFenceState,
  args: Record<string, unknown>,
  workspaceRoot?: string,
  resolveHandlePath?: (handle: string) => string | undefined,
): Record<string, unknown> | undefined {
  const path = brakeTargetPath(session, fence, args, resolveHandlePath);
  if (path === undefined) return undefined;
  const state = session.servedRangeLedger.get(path);
  if (state === undefined || state.totalLines <= 0) return undefined;
  const unserved = unservedServedRanges(state.ranges, state.totalLines);
  if (unserved.length === 0) return undefined;
  return {
    tool: "read_file",
    arguments: {
      mode: "slice",
      path,
      range: unserved[0],
      ...(workspaceRoot ? { cwd: workspaceRoot } : {}),
    },
  };
}

/**
 * Read/search boundary guard. A new epoch opens only via an explicit
 * taskEpoch:"new"; a non-overlapping task_pack against a live certificate
 * instead gets a query_mismatch stop (see preparedDiscoveryReceipt).
 *
 * Wave 4 reshape (2026-07-24 T09/T13/T10 forensics): a prepared/verifying
 * fence no longer hard-refuses new read/search calls. The old behavior
 * manufactured the exact waste it existed to prevent — T09-A spent 69% of its
 * TL calls in the abstain->challenge->recovery cycle after a narrow first
 * pack certified `prepared`, and T13-A escaped to native reads because the
 * pack's own remaining_ranges were "locked". Serving is strictly cheaper than
 * refusing: same-scope repeats compress to pack_unchanged/code_unchanged
 * receipts, re-slices of served handles are the product's documented zoom
 * mechanism, and new-scope acquisition is legitimate discovery that ends with
 * a replacement certificate. The fence still: gates EDITS to the certified
 * frontier (guardExecutionEdit, unchanged), reports phase in every envelope,
 * honors explicit challenges, and refuses only a call repeated with an
 * IDENTICAL signature twice over (genuine loop containment — the 2026-07-19a
 * T13 runaway pattern).
 *
 * 2026-08-08 (L1/L2): that last clause is now true of the IMPLEMENTATION too.
 * The signature covers every byte-selecting argument (discoveryCallSignature),
 * so distinct windows can no longer collide into a false "already ran twice";
 * a genuine repeat of the session's OWN served bytes answers with a receipt
 * instead of a refusal (heldSelfMaterialReceipt); and a successful edit clears
 * the counters, because post-edit bytes are new material
 * (recordExecutionEditResult).
 *
 * `resolveHandlePath` is supplied by the DISPATCHER, the only layer that sees
 * the handle table; it is read-only and used solely to decide whether a
 * repeated read targets this session's own material. Absent, handle-addressed
 * repeats simply fall through to the refusal — never to a wrong receipt.
 */
export function guardExecutionDiscovery(
  workspaceRoot: string,
  tool: "read_file" | "search_files",
  args: Record<string, unknown>,
  resolveHandlePath?: (handle: string) => string | undefined,
  exactPreparedTaskPackReceipt = false,
): ExecutionDiscoveryDecision {
  const session = getSession(workspaceRoot);
  // taskEpoch:"new" opens a genuinely new task even when no fence is
  // installed (candidate-list packs never install one) — release the
  // candidate-pack full-read brake before the fence checks below.
  if (args["taskEpoch"] === "new") {
    session.candidatePackPending = false;
    session.candidatePackFullReads = 0;
    session.revokedCertificateIds.clear();
    session.refusedEditShapes = [];
    // A served-find escalation is a per-task loop ledger. Byte provenance
    // survives the epoch, but a new declared task must not inherit its
    // predecessor's occurrence count or terminal escalation.
    session.servedFindLedger = undefined;
    // TL_SEARCH_DEDUP (W-T-D): same reasoning — "this exact search already
    // ran this task" is a claim about the task that just ended.
    session.searchDedupLedger.clear();
    // Whether a NEW task re-attaches a verification kit is task-shaped, so
    // this one resets. Which BYTES are already on the wire is NOT: see
    // `verificationSurfacesServed`'s doc comment for why that ledger is
    // session-scoped and deliberately survives the epoch boundary.
    session.verificationManifestPathsServed.clear();
    // DESIGN-v0.15-sf-intent-layers.md §4.2 (IL-W2): "an edit already landed
    // THIS task" is exactly as task-shaped as the ledgers above — a NEW
    // declared task has observed no edit of its own yet, even when reached
    // via a discovery call rather than an edit_file call.
    session.intentEditObserved = false;
    // FX-L soft frontier marker (user ruling 2026-09-14): the latest CERTIFIED
    // decision is as task-shaped as `intentEditObserved` directly above — a
    // newly declared task has been handed no certified decision of its own
    // yet. Clearing it HERE is what makes the ruling's "only when it was
    // produced in this epoch" fallback structural rather than a clock compare.
    session.certifiedDecision = undefined;
    // M1 (2026-09-05 R28 remediation): `referencesObserved` (sfIntent.ts,
    // backed by packServeLog.ts's `executedLocates` ledger) is exactly as
    // task-shaped as `intentEditObserved` just above — "a `references` call
    // already ran THIS task" is a claim about the task that just ended, same
    // as every other ledger in this block. `recordServedSurfaces`'s own
    // query-token-overlap heuristic reset is a best-effort SIBLING path (a
    // re-pack whose query happens to share no token with the retiring one),
    // not a substitute for this one: a declared `task.profile:"answer"` task
    // never calls `recordServedSurfaces` at all (candidate-list packs skip
    // it), so without this explicit clear the ledger survived indefinitely
    // across an EXPLICIT `task.epoch:"new"` — the exact leak this fixes.
    clearServedSurfaces(workspaceRoot);
    // W-BATCH-HINT candidate 3: the serial-single-target-call streak is
    // exactly as task-shaped as the ledgers above — a NEW declared task has
    // issued no read-family calls of its own yet, so a streak from the task
    // that just ended must not carry forward and inflate the new task's own
    // count.
    session.serialSingleTargetReads = 0;
  }
  const fence = session.executionFence;
  if (args["taskEpoch"] === "new") {
    if (fence?.phase === "prepared") {
      const handles = [...new Set(fence.actionFrontier.filter((handle) => handle !== ""))];
      if (handles.length > 0) {
        session.pendingPreparedHandleAdvisory = `prepared handle(s) ${handles.join(", ")} were superseded before execution`;
      }
    }
    session.executionFence = undefined;
    _clearAdmissibleEditUnion(session);
    // FX-G-A (round-12 finding 1): the fence's OWN lifetime governs the VF-5
    // obligation hand-off. Without this, a dead task's
    // `change_contract.verify_obligations` outlived its epoch and
    // `verifyClosureGate`'s kit-less fallback withheld the NEXT task's
    // `read.closure`, naming a file that task never touched.
    _clearRecordedVerifyObligations(session);
    session.refusedEditShapes = [];
    return { allowed: true, resetForNewTask: true };
  }
  if (fence === undefined || fence.phase === "revoked" || fence.phase === "done") return { allowed: true };

  // Explicit challenges still revoke (or refuse when malformed) — a caller
  // that wants to formally reopen a certified decision keeps that path.
  const challenged = applyChallenge(session, fence, args, workspaceRoot);
  if (challenged !== undefined) return challenged;

  const signature = discoveryCallSignature(tool, args);
  const seen = fence.discoverySignatures.get(signature) ?? 0;
  fence.discoverySignatures.set(signature, seen + 1);

  // A ready certificate is a stop certificate, not a hint.  Its task epoch
  // cannot acquire fresh read/search evidence unless the caller gives the
  // proof a concrete decision-changing challenge (handled above), or opens an
  // explicit taskEpoch:"new" (handled before the fence lookup).  A capability
  // gap must therefore remain a discovery contract and never reach this fence.
  if (fence.phase === "prepared") {
    const batchFenceActive = batchEditFrontierEnabled()
      && fence.terminalAction === "edit"
      && (fence.batchEditTargets.length > 1 || fence.actionTargetPairs.length > 1);
    // W5b: a prepared edit certificate trims the first broad full read.
    // A concrete decision-changing challenge above revokes the fence and is
    // the explicit escape hatch; force_serve remains unconditional recovery.
    if (
      !batchFenceActive
      && fence.terminalAction === "edit"
      && tool === "read_file"
      && args["mode"] === "full"
      && args["force_serve"] !== true
    ) {
      return { allowed: true, postReadyTrim: true };
    }

    // A verified cache hit is an idempotent receipt, not discovery: let it
    // reach task_pack's existing pack_unchanged encoder. The dispatcher
    // proves the hit up front, so a stale or changed pack cannot use this
    // exception to re-serve fresh content under a prepared certificate.
    if (tool === "read_file" && args["mode"] === "task_pack" && exactPreparedTaskPackReceipt) {
      return { allowed: true };
    }
    // A prepared certificate stops arbitrary discovery, but an explicit
    // capability gap on the very response that installed it remains actionable.
    // Match the normalized call signature exactly and consume it once: callers
    // cannot widen this into a fresh search/read frontier or loop the same zoom.
    if (fence.sanctionedDiscovery?.remaining === 1 && fence.sanctionedDiscovery.signature === signature) {
      fence.sanctionedDiscovery.remaining = 0;
      return { allowed: true };
    }
    // Defect G (2026-08-13): the SAME response also advertised remaining_ranges
    // on its partial surfaces under a route that granted additional calls —
    // and this fence then refused the zoom it had just advertised. A pack that
    // publishes what it did not serve and suppresses the ask for it is the
    // self-contradiction T13-A escaped to native reads over. Consumed from the
    // same sanctioned-discovery budget above, so an advertised zoom is
    // accounted exactly like the exact-signature follow-up rather than as a
    // new, uncounted post-prepared class. 2026-08-22 fence-serves-unserved-scope:
    // exhaustion no longer falls to suppression — the fallthrough below now
    // serves this same unserved territory unconditionally, so this budget
    // survives only as a fast, bookkeeping early-exit for the advertised-zoom
    // shape specifically, never as an actual limiter (required semantics #1).
    if (consumeSanctionedZoom(fence, tool, args)) {
      return { allowed: true };
    }
    // A ready multi-target pack already has its complete edit frontier. Only
    // advertised zooms above and explicit recovery may serve before it lands.
    if (batchFenceActive) {
      if (args["force_serve"] === true) return { allowed: true };
      if (tool === "read_file") {
        const receipt = heldSelfMaterialReceipt(session, fence, args, resolveHandlePath);
        if (receipt !== undefined) return { allowed: false, servedReceipt: receipt };
      }
      return { allowed: false, servedReceipt: preparedDiscoveryReceipt(session, fence, workspaceRoot, seen > 0, tool, args) };
    }
    // F-V12-1 (2026-08-27, D1-b): `search_files` bypasses the read-side
    // residency receipt below UNCONDITIONALLY, ahead of it rather than after.
    // heldSelfMaterialReceipt answers "do I already hold these EXACT BYTES" —
    // a question `find`/`tree`/`references`/`symbols` never asks (they ask
    // "where are the matches", a different question over possibly the SAME
    // path). Its receipt shape (`{ok, reason:"already-served", windows, ...}`)
    // has no field the search wire vocabulary renders: this dispatcher had
    // already committed the response to `search.matches` (noteResolvedAction),
    // so addressing that receipt through the search projector silently
    // defaulted every search field to empty — `query:"", total_files:0,
    // total_matches:0, files:[]` — a FABRICATED absence certificate for a
    // token provably present in a file this session holds, indistinguishable
    // on the wire from a genuine scope-complete zero-match. Measured: a
    // `search_files action=find path=<file>` (any query text, regex/literal/
    // queries[] alike) reproducibly returns this false-empty response, but
    // ONLY while an active `prepared` certificate's evidence/edit material
    // includes that exact path — the same signature reissued after
    // `taskEpoch:"new"`, or in a fresh session, or from a `discover`-phase
    // session, searches for real. Root cause: this call reached
    // heldSelfMaterialReceipt BEFORE the tool==="search_files" bypass a few
    // lines below, which the 2026-08-22 fence-serves-unserved-scope wave
    // already states as this fence's intent ("`search_files` (any action)...
    // now reach the ordinary...path below this guard") — that wave's own
    // regression spec (fenceServesUnservedScope.rc.spec.ts) never drove a
    // find scoped to the certificate's OWN evidence path, so the ordering gap
    // survived. The search-appropriate "you already hold this" answer already
    // exists downstream, correctly worded and line-accurate:
    // applyServedFindProtocol/servedFindEscalation.ts's `all_served`/
    // escalation, which this bypass now reaches unconditionally instead.
    if (tool === "search_files") {
      return { allowed: true };
    }
    // A residency proof over the fence's OWN evidence/edit material: "content
    // the caller already has" (required semantics #1(b)) — keeps its receipt
    // unconditionally, including past the change below. `read_file` only —
    // `search_files` is bypassed above (F-V12-1).
    const receipt = heldSelfMaterialReceipt(session, fence, args, resolveHandlePath);
    if (receipt !== undefined) {
      return { allowed: false, servedReceipt: receipt };
    }
    // 2026-08-22 fence-serves-unserved-scope (measured: bench 2026-08-22, T09
    // rep1 alone spent 8 receipts -> 8 taskEpoch:"new" re-packs, 290 KB
    // arm-wide; v0.10 had the same loop on T07/T13). A prepared certificate is
    // a terminal verdict about the ANSWER/EDIT decision, not a lock on
    // further READ-ONLY discovery of scope this session has not proven itself
    // to hold. `read_file` in any mode OTHER than `task_pack` reaches the
    // ordinary, fence-INDEPENDENT serve/dedup path below this guard — the same
    // one that runs when no fence exists at all, and the one
    // `servedReceipts.spec.ts` / `receiptHonesty.spec.ts` already hold to "an
    // already-served re-ask receipts, everything else serves real bytes"
    // (servedContentReceipt's own code-unchanged tag). `search_files` no
    // longer needs naming here — it already returned above (F-V12-1). Only
    // `task_pack` stays gated here: a fresh pack mints a NEW certificate,
    // which is exactly the transition the epoch boundary (`taskEpoch:"new"`,
    // or the qref/cache-hit shortcut above) exists to make deliberate rather
    // than incidental — see `preparedDiscoveryReceipt` and `readFamily.ts`'s
    // `receiptHasContinuation` for what still happens to that narrower class.
    if (tool === "read_file" && args["mode"] !== "task_pack") {
      return { allowed: true };
    }
    return {
      allowed: false,
      servedReceipt: preparedDiscoveryReceipt(session, fence, workspaceRoot, seen > 0, tool, args),
    };
  }

  // Verifying is intentionally different: a bounded closure/diff or a
  // post-edit inspection can still be legitimate.  Retain the old loop brake
  // there so it compresses only truly repeated verification work.
  if (seen >= DISCOVERY_LOOP_BRAKE_THRESHOLD) {
    if (brakedCallServesNoBytes(session, fence, signature, args, resolveHandlePath)) {
      return { allowed: true };
    }
    const receipt = heldSelfMaterialReceipt(session, fence, args, resolveHandlePath);
    if (receipt !== undefined) return { allowed: false, servedReceipt: receipt };
    return executionRefusal(session, fence, DISCOVERY_LOOP_BRAKE_DETAIL, workspaceRoot, {
      discoveryBrake: true,
      brakeRescopeNextCall: brakeRescopeNextCall(session, fence, args, workspaceRoot, resolveHandlePath),
    });
  }
  return { allowed: true };
}

/**
 * ND-1 (2026-08-08 serve honesty): record that ONE discovery call shape
 * provably served no file bytes, so a later repeat of it is never answered
 * with a residency claim (see brakedCallServesNoBytes).
 *
 * Called by the response path that produced the miss, with the SAME argument
 * object the guard was given — the signature must be byte-for-byte the one the
 * brake will compute, or the verdict is filed against a call that never
 * happened. A no-op without a live fence: there is no brake to inform.
 */
export function noteDiscoveryServedNoBytes(
  workspaceRoot: string,
  tool: "read_file" | "search_files",
  args: Record<string, unknown>,
): void {
  const fence = getSession(workspaceRoot).executionFence;
  if (fence === undefined) return;
  fence.zeroByteSignatures.add(discoveryCallSignature(tool, args));
  while (fence.zeroByteSignatures.size > ZERO_BYTE_SIGNATURE_CAP) {
    const oldest = fence.zeroByteSignatures.values().next().value as string | undefined;
    if (oldest === undefined) break;
    fence.zeroByteSignatures.delete(oldest);
  }
}

/**
 * True iff the LEGACY top-level create/allow_create flag is set -- the whole
 * call is a create. A canonical edits[] item's OWN `create:true` is a
 * DIFFERENT, per-item concern (see `requestedItemCreatePaths` and
 * guardExecutionEditCore's create branch); this function deliberately does
 * not look inside `edits[]`, so every OTHER branch gated on it keeps reading
 * "is the WHOLE call a create", unchanged.
 */
function isCreateEditRequest(args: Record<string, unknown>): boolean {
  return args["create"] === true || args["allow_create"] === true;
}

function requestedEditHandles(args: Record<string, unknown>): string[] {
  const handles: string[] = [];
  if (typeof args["handle"] === "string") handles.push(args["handle"]);
  if (Array.isArray(args["edits"])) {
    for (const edit of args["edits"]) {
      if (edit && typeof edit === "object" && typeof (edit as Record<string, unknown>)["handle"] === "string") {
        handles.push((edit as Record<string, unknown>)["handle"] as string);
      }
    }
  }
  return [...new Set(handles)];
}

function requestedEditPaths(args: Record<string, unknown>): string[] {
  const paths: string[] = [];
  if (typeof args["path"] === "string") paths.push(args["path"]);
  if (Array.isArray(args["edits"])) {
    for (const edit of args["edits"]) {
      if (edit && typeof edit === "object" && typeof (edit as Record<string, unknown>)["path"] === "string") {
        paths.push((edit as Record<string, unknown>)["path"] as string);
      }
    }
  }
  return [...new Set(paths)];
}

/**
 * v0.14.1 defect 1 fix (2026-09-07): the per-item create paths in a canonical
 * `edits[]` batch -- every item whose OWN `create === true`, independent of
 * the legacy top-level `create`/`allow_create` flag (`isCreateEditRequest`),
 * which keeps meaning "the whole call is a create" unchanged. Never includes
 * the legacy top-level `path` -- that path's create-ness is decided by
 * `isCreateEditRequest`, not by this function.
 */
function requestedItemCreatePaths(args: Record<string, unknown>): string[] {
  const paths: string[] = [];
  if (Array.isArray(args["edits"])) {
    for (const edit of args["edits"]) {
      if (
        edit && typeof edit === "object"
        && (edit as Record<string, unknown>)["create"] === true
        && typeof (edit as Record<string, unknown>)["path"] === "string"
      ) {
        paths.push((edit as Record<string, unknown>)["path"] as string);
      }
    }
  }
  return [...new Set(paths)];
}

// ---------------------------------------------------------------------------
// FX-L SOFT FRONTIER MARKER (user ruling 2026-09-14, review-findings-6
// SHOULD-FIX 38)
//
// THE RULING, AND WHAT IT DELIBERATELY DOES NOT MOVE. review-findings-6
// finding 38 measured that an `edit_file` on a served evidence handle applies
// even when the certified decision named that file read-only (or named it
// not at all): `act.edit` with frontier `[{src/retry.ts}]` still wrote
// `src/cache.ts`; `act.answer` with no frontier still wrote its served file.
// That is FX-L's RATIFIED design — "THE CERTIFICATE IS NOT WRITE AUTHORITY …
// Write authority comes only from SHIPPED BYTES" — and consulting
// `writable:false` at dispatch inverts its one-way rule (it would REFUSE a
// handle this server itself served, the T09/T10 regression class). So the
// fence below is untouched, `nul-stripped` still refuses physically, and
// IL-W2's `editObserved` exemption is unaffected. What is ADDED is a
// disclosure: the edit lands and SAYS where it landed.
//
// WHERE THE LOOKUP LIVES. On the session (lane+workspace via `laneScopedKey`),
// written by `server.ts` from the decision it just projected — never
// re-derived here from the certificate, because the question is "what did the
// CALLER last certify about this path", and the caller saw the projected
// `decision.frontier`, not `action_frontier`. Cleared on `task.epoch:"new"` in
// both guards beside `intentEditObserved`, which is what makes "produced in
// this epoch" structural.
// ---------------------------------------------------------------------------

/**
 * Records the latest certified (`act.edit` / `act.answer`) decision for this
 * lane. Called from `server.ts`'s single decision-emission site.
 *
 * Only the two CERTIFIED kinds are recorded. A later `discover` / `await_input`
 * / `done` pack does NOT retire an earlier certified decision: it certifies
 * nothing, so "the latest certified decision" is still the earlier one. Only
 * `task.epoch:"new"` retires it.
 */
export function recordCertifiedDecision(workspaceRoot: string, record: CertifiedDecisionRecord): void {
  getSession(workspaceRoot).certifiedDecision = record;
}

/** The latest certified decision for this lane+epoch, if any. */
export function certifiedDecisionFor(workspaceRoot: string): CertifiedDecisionRecord | undefined {
  return getSession(workspaceRoot).certifiedDecision;
}

/**
 * PURE (unit-testable) half of the marker: where `path` stands relative to
 * `record`. `undefined` means the decision authorized it — no marker.
 *
 * Order matters and is the ruling's own: an explicit frontier entry answers
 * first (it is the decision's most specific statement about that path),
 * `act.answer` answers next (it certified no writable frontier at all), and
 * "the decision was `act.edit` and simply did not name this path" is the
 * remainder.
 */
export function certifiedFrontierStatusOf(
  record: CertifiedDecisionRecord,
  path: string,
): CertifiedFrontierStatus | undefined {
  if (path === "") return undefined;
  // A certified create target is an AUTHORIZED write that no frontier can
  // contain (`projectFrontier` drops an entry whose path cannot be named, and
  // the file does not exist yet) — marking it would call the decision's own
  // `act.edit`+`create_target` floor a violation of itself.
  if (path === record.createTargetPath) return undefined;
  const entry = record.frontier.find((candidate) => candidate.path === path);
  if (entry !== undefined) return entry.writable ? undefined : "read-only";
  if (record.kind === "act.answer") return "answer-decision";
  return "not-in-frontier";
}

/** One requested edit target, with the argument address that named it. */
interface RequestedEditTarget {
  path: string;
  /** `edits[i].path` / `edits[i].handle` / `path` / `handle` — the refusal's `field`. */
  field: string;
  /** True iff THIS item is a create (`create:true`, or the legacy call-wide flag). */
  create: boolean;
}

/**
 * Every edit target this call names, IN REQUEST ORDER, each resolved to a
 * workspace-relative path and labelled with the argument that named it.
 *
 * Deliberately not `requestedEditPaths ∪ requestedEditHandles`: those two are
 * deduped sets with no positional correspondence, and both the per-item
 * `applied[]` marker and the strict refusal's `field` need to say WHICH item.
 */
function requestedEditTargets(
  args: Record<string, unknown>,
  resolveHandlePath?: (handle: string) => string | undefined,
): RequestedEditTarget[] {
  const callWideCreate = isCreateEditRequest(args);
  const targets: RequestedEditTarget[] = [];
  const push = (path: string | undefined, field: string, create: boolean): void => {
    if (typeof path !== "string" || path === "") return;
    if (targets.some((existing) => existing.path === path)) return;
    targets.push({ path, field, create });
  };
  if (typeof args["path"] === "string") push(args["path"], "path", callWideCreate);
  if (typeof args["handle"] === "string") {
    push(resolveHandlePath?.(args["handle"] as string), "handle", callWideCreate);
  }
  if (Array.isArray(args["edits"])) {
    args["edits"].forEach((edit, index) => {
      if (edit === null || typeof edit !== "object") return;
      const item = edit as Record<string, unknown>;
      const create = callWideCreate || item["create"] === true;
      if (typeof item["path"] === "string") push(item["path"], `edits[${index}].path`, create);
      if (typeof item["handle"] === "string") {
        push(resolveHandlePath?.(item["handle"] as string), `edits[${index}].handle`, create);
      }
    });
  }
  return targets;
}

/**
 * True iff this `edit_file` call's own task binding (if it carries one) still
 * names the lane+epoch the recorded decision belongs to.
 *
 * WHY THIS IS A GUARD AND NOT A COMPARISON OF IDENTIFIERS IN EVERY CASE.
 * `server.ts`'s `taskHandleRefusal` already refuses a `task_handle` that is
 * unknown, expired, wrong-purpose, from another workspace or from another lane
 * BEFORE this guard runs, and `applyRecoveredTaskHandleFromQref` only ever
 * stamps a handle this same server minted onto the qref the caller supplied.
 * So by the time we are here, a binding that is PRESENT is already known to
 * belong to this workspace+lane. What is left to check is the one thing those
 * gates do not answer — whether it names the same TASK the record does — and
 * that is only checkable when the record actually captured an identifier
 * (`withTaskHandle` degrades to no handle when no durable store is available,
 * and a pack can be served without a qref). When the record captured none, the
 * epoch rule alone governs, which is the ruling's own fallback.
 */
function certifiedDecisionBindingHolds(record: CertifiedDecisionRecord, args: Record<string, unknown>): boolean {
  const handle = typeof args["task_handle"] === "string" ? args["task_handle"] : "";
  if (handle !== "" && record.taskId !== "" && handle !== record.taskId) return false;
  const qref = typeof args["qref"] === "string" ? args["qref"].trim() : "";
  if (qref !== "" && record.qref !== "" && qref !== record.qref) return false;
  return true;
}

/**
 * The FX-L soft marker for this `edit_file` call, or `undefined` when the
 * latest certified decision authorized every target it names (and when there
 * is no certified decision bound to this lane+epoch at all).
 *
 * Exported for the unit spec; the production readers are `guardExecutionEdit`
 * (which attaches it to an allowed decision) and its strict-mode refusal.
 */
export function certifiedFrontierMarkerFor(
  workspaceRoot: string,
  args: Record<string, unknown>,
  resolveHandlePath?: (handle: string) => string | undefined,
): ExecutionFrontierMarker | undefined {
  // An edit_file that carries its OWN `task.epoch:"new"` opens a new task, and
  // a new task has been handed no certified decision yet. `guardExecutionEditCore`
  // retires the record for exactly this reason — but it does so INSIDE the call
  // this marker describes, and the wrapper reads the record before that (see
  // `guardExecutionEdit`'s ordering note), so the same rule is applied here
  // rather than left to depend on which of the two ran first.
  if (args["taskEpoch"] === "new") return undefined;
  const record = getSession(workspaceRoot).certifiedDecision;
  if (record === undefined) return undefined;
  if (!certifiedDecisionBindingHolds(record, args)) return undefined;
  const marked: Array<{ path: string; status: CertifiedFrontierStatus; field: string }> = [];
  for (const target of requestedEditTargets(args, resolveHandlePath)) {
    // A create names a file that does not exist yet: it has no frontier
    // standing to report, and `guardExecutionEditCore`'s own create branches
    // (pack-named target, or an explicit workspace pin) already decide it.
    if (target.create) continue;
    const status = certifiedFrontierStatusOf(record, target.path);
    if (status === undefined) continue;
    marked.push({ path: target.path, status, field: target.field });
  }
  const first = marked[0];
  if (first === undefined) return undefined;
  return {
    certificate_id: record.certificateId,
    status: first.status,
    paths: marked.map((entry) => entry.path),
  };
}

/**
 * The `field` the strict-mode refusal names: the argument address of the FIRST
 * offending item, in request order. Recomputed rather than carried on
 * `ExecutionFrontierMarker` so the advisory marker's wire shape stays minimal
 * (`field` is a refusal concept, meaningless on `edit.applied`).
 */
function firstMarkedEditField(
  record: CertifiedDecisionRecord,
  args: Record<string, unknown>,
  resolveHandlePath?: (handle: string) => string | undefined,
): string {
  for (const target of requestedEditTargets(args, resolveHandlePath)) {
    if (target.create) continue;
    if (certifiedFrontierStatusOf(record, target.path) !== undefined) return target.field;
  }
  return "edits";
}

/**
 * FX-L STRICT MODE (`TL_FRONTIER_STRICT_WRITES=1`, default OFF): the same
 * condition the soft marker discloses, as a refusal of the WHOLE batch.
 *
 * "Rollback, consistent with execution-typestate" is structural here: this
 * runs BEFORE `guardExecutionEditCore`, so no fence transition, no admissible-
 * union write and no disk write is attempted — the §2.4 "nothing was
 * attempted" row holds by construction rather than by undoing anything.
 *
 * NEVER A DEAD END (§2.6). `retry:"new-task"` names the only transition that
 * can change the answer — a re-pack that states the edit intent explicitly —
 * and `next_call` IS that call, executable verbatim: `edit <path>` as the
 * query, the offending path as an explicit target (so the new certificate's
 * frontier is computed over it), and `profile:"generic"`, because a `generic`
 * task is a CHANGE task and an `answer` one is not. Measured: that call
 * returns `act.edit` with `frontier:[{path, writable:true}]` and the identical
 * edit then applies unmarked.
 *
 * DISCLOSED DEVIATION FROM THE RULING'S WORDING (2026-09-14). The ruling reads
 * "`query:<original query if recorded, else "edit <P>">`". The original query
 * is measurably the one query that CANNOT recover this refusal: it is what
 * produced P's read-only / omitted / answer standing in the first place, so
 * re-packing it narrowed to P re-derives the same verdict — measured on the
 * ruling's own JA fixture, the recorded query plus `targets:[{path:"src/
 * cache.ts"}]` returns `act.answer` with `evidence_files:0` (cache.ts is not
 * even served), which is exactly the dead end the same sentence of the ruling
 * forbids. The overriding "Never a dead end" clause therefore wins: the query
 * is always the intent-stating `edit <path>` form, and the recorded query is
 * NOT lost — it is named in `detail` below, so the caller can restate it.
 */
function refuseStrictFrontierWrite(
  session: WorkspaceSession,
  workspaceRoot: string,
  args: Record<string, unknown>,
  record: CertifiedDecisionRecord,
  marker: ExecutionFrontierMarker,
  resolveHandlePath?: (handle: string) => string | undefined,
): ExecutionGuardDecision {
  const path = marker.paths[0] ?? "";
  const lane = currentSessionLane();
  const recordedQuery = session.executionFence?.epochQuery ?? "";
  const reason = marker.status === "read-only"
    ? "names it read-only"
    : marker.status === "answer-decision"
      ? "is an act.answer and certified no writable frontier"
      : "is an act.edit whose frontier omits it";
  return {
    allowed: false,
    refusal: {
      ok: false,
      reason: "frontier-read-only",
      retry: "new-task",
      retry_same_call: false,
      field: firstMarkedEditField(record, args, resolveHandlePath),
      certificate_id: record.certificateId,
      detail: `TL_FRONTIER_STRICT_WRITES: ${marker.paths.join(",")} is outside the writable frontier of the latest certified decision (${record.certificateId || "no certificate id"}) — that decision ${reason}. Nothing was written. Run the next call to re-pack with the edit intent stated${recordedQuery !== "" ? `; the task this decision closed was "${recordedQuery}"` : ""}.`,
      next_call: {
        tool: "read_file",
        arguments: {
          query: `edit ${path}`,
          targets: [{ path }],
          task: { epoch: "new", profile: "generic" },
          ...(workspaceRoot ? { cwd: workspaceRoot } : {}),
          ...(lane !== "" ? { lane } : {}),
        },
      },
    },
  };
}

/**
 * FX-P1: the refusal for an edit that no CERTIFICATE fences but the ONE
 * admissibility predicate rejects — a withheld address (INV-I-1) or a
 * cross-lane handle (INV-I-2).
 *
 * It is deliberately NOT `refuseExecutionEdit`: that builder needs a live
 * fence for `phase`/`certificate_id`/`frontier`, and inventing one here would
 * report a certificate the caller never received. So this is the minimum
 * honest refusal, in the SAME vocabulary the fenced capped refusal uses:
 * `execution-typestate` (the code), an advisory `cause` (only where the
 * diagnosis is true — `"capped"` is a claim about the byte budget, never
 * attached to a lane refusal), and the executable per-address recovery
 * `next_call` — `read_file … content:"full"`, which is the one `targets`
 * shape that routes through `recordServedRange` and therefore actually books
 * what it serves, so the very next edit is admitted.
 *
 * `retry` is left to `retryOf` and lands on `"call"`, the same transition the
 * fenced capped refusal reports (measured, `scratchpad/fxp1/fxl_shape.mjs`):
 * no `terminal`, no `discovery_closed`, no `required_action` — because there
 * is no fence to unlock or rescope, only bytes to fetch.
 *
 * FX-V1 (round-20A finding 1, ruling (x), 2026-09-04): `content:"full"` was
 * already the right shape here and stays UNCHANGED — round-20A's finding was
 * never that this `next` names the wrong call, only that
 * `_foreignHandleRangeCovered`'s whole-file predicate could not be satisfied
 * by running it, for any file containing a 2+-line doc comment (its lines
 * never rode a prior wire, so no ordinary `content:"full"` re-read — this
 * one included — could ever book them). Now that the predicate accepts
 * `state.spans ∪ state.elided` (see `_foreignHandleRangeCovered`), the SAME
 * `content:"full"` this `next` has always issued genuinely closes that gap:
 * it re-stages the whole file under the redeeming lane, `_stageElisionGap`
 * detects the identical elision gap again, and the retried edit's whole-file
 * check now finds `spans ∪ elided` covering `1..totalLines`. The FX-Q1 loop
 * property — "running the recovery verbatim admits the same edit" — holds
 * for the first time for a commented file, with no change to this function.
 */
function _refuseUngatedEdit(
  session: WorkspaceSession,
  workspaceRoot: string,
  args: Record<string, unknown>,
  spec: { cause?: string; detail: string; recoveryPaths: readonly string[]; lane?: string },
): ExecutionGuardDecision {
  const targets = [...new Set(spec.recoveryPaths)].slice(0, NEXT_CALL_EDIT_CAP);
  // W6 parity: a verbatim retry of this exact shape repeats the correction
  // rather than the whole payload, using the same ring the fenced refusals use.
  const repeated = noteRefusedEditShape(session, args, spec.detail);
  const detail = repeated === undefined
    ? spec.detail
    : `${spec.detail} This edit_file shape was already refused in this task (attempt ${repeated.count}); retrying it unchanged cannot change the result. First correction: ${repeated.firstDetail}`;
  return {
    allowed: false,
    refusal: {
      ok: false,
      reason: "execution-typestate",
      retry_same_call: false,
      detail,
      ...(spec.cause !== undefined ? { cause: spec.cause } : {}),
      ...(targets.length > 0
        ? {
            next_call: {
              tool: "read_file",
              arguments: {
                targets: targets.map((candidate) => ({ path: candidate })),
                content: "full",
                // round-18A finding 6: the recovery must stage its serve under
                // the SAME lane that was refused, or "run it verbatim" mints a
                // lane-less (or wrong-lane) handle that cannot ground the
                // caller's own retry. Omitted for a lane-less caller so a
                // single-agent session's `next_call` stays byte-identical.
                ...(spec.lane !== undefined && spec.lane !== "" ? { lane: spec.lane } : {}),
                ...(workspaceRoot ? { cwd: workspaceRoot } : {}),
              },
            },
          }
        : {}),
    },
  };
}

/**
 * FX-Q2 (ruling (w), round-19A, 2026-09-03): parse a `HandleEntry.range`
 * string (`"start-end"`, both inclusive, 1-based) into numeric bounds.
 * Malformed input (should never occur from the handle table, but this is a
 * fail-closed boundary) yields `undefined`, which the caller treats exactly
 * like a whole-file handle — the STRICTER of the two readings, never the more
 * permissive one.
 */
function _parseHandleLineRange(range: string): { start: number; end: number } | undefined {
  const parts = range.split("-");
  if (parts.length !== 2) return undefined;
  const start = Number.parseInt(parts[0]!, 10);
  const end = Number.parseInt(parts[1]!, 10);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) return undefined;
  return { start, end };
}

/**
 * FX-Q2 (ruling (w), round-19A, 2026-09-03): does the REDEEMING lane's own
 * SETTLED served-range ledger for `path` already cover `requestedRange` in
 * full? `requestedRange === undefined` means the foreign handle names the
 * WHOLE FILE, which is answered against the ledger's OWN recorded
 * `totalLines` — this module is I/O-free (see the file header) and never
 * re-reads the file to find out how long it "really" is now; the ledger's
 * own bookkeeping is exactly what a genuine `content:"full"` serve (or a
 * `code_unchanged` restatement of one) would have populated.
 *
 * Reuses `servedRangeReceipt` — the ledger's own canonical "is this window
 * already held" query, same subsumption logic the same-lane receipt path
 * uses — against the ledger's OWN `fileSha`, not an externally supplied one:
 * this predicate only asks "does THIS lane's own ledger already prove it
 * received these exact bytes", which is a question the ledger can answer
 * about itself without any outside disk read.
 *
 * FX-V1 (round-20A finding 1, ruling (x), 2026-09-04) — SHIPPED ∪ ELIDED,
 * BUT ONLY HERE. `servedRangeReceipt` alone is elision-blind by design: every
 * ordinary text serve (`content:"full"` included, and the plain DEFAULT read
 * mode) collapses a 2+-line doc-comment/docstring block to a single
 * `doc elided L<a>-<b>` marker (`util/formatCompress.ts`'s `elideDocComments`)
 * whose source lines never ride the wire, so `recordServedRange` never books
 * them and a whole-file `servedRangeReceipt` subsumption over
 * `1..totalLines` was PERMANENTLY unreachable for any such file — the
 * redeeming lane's own recovery `next` (`_refuseUngatedEdit`, below), run
 * verbatim and repeatedly, could never satisfy the predicate it was offered
 * as the remedy for (round-20A's live minimal repro: a 2-line JSDoc comment).
 *
 * The ruling: a window TL ITSELF chose to elide from a serve — disclosed
 * in-band by the marker naming its own exact line span — counts as coverage
 * for THIS write-authority predicate, because the caller holds the marker's
 * printed positions and TL, not the caller, chose the compression. It does
 * NOT count for `servedRangeReceipt`/`prior`/`code_unchanged`/`served_by` —
 * those stay exactly as elision-blind as before, since a receipt claims the
 * caller already RECEIVED the bytes, which an elided span's caller did not.
 * So this function tries the ordinary receipt first (unchanged, and the
 * common case is decided there without ever touching `elided`), and only on
 * a receipt miss falls back to a SEPARATE union-and-subsume check over
 * `state.spans ∪ state.elided` — never routed through `servedRangeReceipt`
 * itself, which must stay elision-blind for every other caller.
 * `state.elided` is populated only by `_stageElisionGap` /
 * `_settleSessionServeBookings`, confirmed under the same finalized-wire
 * corroboration `spans` are, so a response a governor/cap shed before the
 * wire leaves no elision claim behind either.
 */
function _foreignHandleRangeCovered(
  session: WorkspaceSession,
  workspaceRoot: string,
  path: string,
  requestedRange: { start: number; end: number } | undefined,
): boolean {
  const state = session.servedRangeLedger.get(path);
  if (state === undefined) return false;
  const { start, end } = requestedRange ?? { start: 1, end: state.totalLines };
  if (servedRangeReceipt(workspaceRoot, path, state.fileSha, start, end, state.totalLines) !== undefined) {
    return true;
  }
  if (state.elided.length === 0) return false;
  const s = Math.max(1, Math.min(state.totalLines, start));
  const e = Math.max(s, Math.min(state.totalLines, end));
  const shippedOrElided = mergeServedRanges([
    ...state.spans.map((span) => [span.start, span.end] as [number, number]),
    ...state.elided.map((entry) => [entry.start, entry.end] as [number, number]),
  ]);
  return shippedOrElided.some(([rangeStart, rangeEnd]) => rangeStart <= s && rangeEnd >= e);
}

/**
 * Edit boundary guard: an edit-ready certificate may mutate only its
 * frontier. Renamed from `guardExecutionEdit` (IL-W2, DESIGN-v0.15
 * §4.2) — the exported name now belongs to the thin wrapper just below
 * this function, which layers the §4.2 observed-edit record on top
 * without touching anything in here. Every internal booking this function
 * already performs (fence/certificate transitions, admissible-union
 * writes, refusal construction) is unchanged and in the same order.
 */
function guardExecutionEditCore(
  workspaceRoot: string,
  args: Record<string, unknown>,
  resolveHandlePath?: (handle: string) => string | undefined,
  opts?: {
    createWorkspacePin?: CreateWorkspacePin;
    /**
     * FX-P1 (INV-I-2): the lane a handle was minted in, from the dispatcher's
     * handle table. `undefined` for an unknown handle, a handle from another
     * workspace, or a lane-less mint — all three are "no positive evidence
     * about provenance" and admit.
     */
    resolveHandleLane?: (handle: string) => string | undefined;
    /**
     * FX-Q2 (ruling (w), round-19A, 2026-09-03): the handle's own stored
     * `"start-end"` line range (`HandleEntry.range`), from the SAME
     * dispatcher handle table `resolveHandleLane` reads. `undefined` means
     * either an unknown handle (never reaches this — `resolveHandleLane`
     * already refused it a positive lane) or, for a handle this call already
     * knows is foreign, a WHOLE-FILE handle (the table simply has no `range`
     * on that entry). Only consulted once a handle is already known to be
     * foreign, so the "unknown handle" and "whole-file handle" cases can
     * never be confused with each other here.
     */
    resolveHandleRange?: (handle: string) => string | undefined;
  },
): ExecutionGuardDecision {
  const session = getSession(workspaceRoot);
  // taskEpoch:"new" opens a genuinely new task even when no fence is
  // installed (candidate-list packs never install one) — release the
  // candidate-pack full-read brake before the fence checks below.
  if (args["taskEpoch"] === "new") {
    session.candidatePackPending = false;
    session.candidatePackFullReads = 0;
    session.revokedCertificateIds.clear();
    session.servedFindLedger = undefined;
    // TL_SEARCH_DEDUP (W-T-D): same epoch reset as the discovery guard.
    session.searchDedupLedger.clear();
    // L2 (2026-08-07): same epoch reset as the discovery guard — see there.
    session.verificationManifestPathsServed.clear();
    // DESIGN-v0.15-sf-intent-layers.md §4.2 (IL-W2): same epoch reset as the
    // discovery guard's identical clear above — see there.
    session.intentEditObserved = false;
    // FX-L soft frontier marker (user ruling 2026-09-14): same epoch reset as
    // the discovery guard's identical clear above — see there. An `edit_file`
    // that opens its own epoch is bound to no certified decision, so it is
    // never marked (and, under TL_FRONTIER_STRICT_WRITES, never refused).
    session.certifiedDecision = undefined;
    // M1 (2026-09-05 R28 remediation): same epoch reset as the discovery
    // guard's identical clear above — see there. An `edit_file` call carrying
    // its OWN `task.epoch:"new"` is exactly as much "a new task" as a
    // discovery call carrying one; the served-surface ledger must not survive
    // it either.
    clearServedSurfaces(workspaceRoot);
  }
  const fence = session.executionFence;
  const createRequested = isCreateEditRequest(args);

  // -----------------------------------------------------------------------
  // FX-P1 (INV-I-2, 2026-09-03) — A HANDLE IS WRITE AUTHORITY ONLY IN THE LANE
  // THAT EARNED IT.
  //
  // MEASURED (`scratchpad/fxp1/i2.mjs`, and INV-I's own `p10_lane_isolation`):
  // lane A reads `src/shared.ts` in full and receives handle h; lane B, which
  // issued ZERO reads in this workspace, sends
  // `edit_file {lane:"agent-B", edits:[{handle:h, content:"…HIJACKED…"}]}`
  // and the file is overwritten. Every OTHER piece of session state is
  // lane-partitioned (`sessionKeyFor` = `laneScopedKey`), so lane B's fence,
  // its admissible union and its byte residency all correctly said "you have
  // never been served this file" — and none of them was consulted, because
  // handle possession alone reached the write.
  //
  // THE RULING (INV-I-2's open design question, decided here). Lanes ARE an
  // isolation boundary for WRITES: AGENTS.md's concurrency contract, F-V13-3's
  // certificate cross-talk fix and FX-M1's `operation_id`/kit-cache lane folds
  // all treat `lane` that way, and a bearer-token reading makes the write half
  // of that contract vacuous. READS are deliberately left alone — a read is
  // not write authority, it serves bytes rather than consuming them, and it
  // stages what it serves under the READING lane's own session
  // (`recordServedRange` -> `getSession(workspaceRoot)` -> `laneScopedKey`),
  // so a cross-lane zoom grounds the reader and nobody else. That asymmetry is
  // the whole point: lane B may LOOK at lane A's handle and, by looking, earn
  // its own authority over those bytes.
  //
  // NO FALSE POSITIVES BY CONSTRUCTION: `canonicalKey` now forks handle dedup
  // identity by lane, so a lane's own honest read always hands it a handle
  // stamped with its own lane. `undefined` (a lane-less mint, or an entry
  // rehydrated from a pre-FX-P1 store) is unknown provenance and admits —
  // positive evidence only, the same rule residency follows.
  const redeemingLane = currentSessionLane();
  const foreignLaneHandles = createRequested
    ? []
    : requestedEditHandles(args).filter((handle) => {
        const mintedIn = opts?.resolveHandleLane?.(handle);
        if (typeof mintedIn !== "string" || mintedIn === "" || mintedIn === redeemingLane) return false;
        // ruling (w) (round-19A, 2026-09-03) — REVOKES the FX-Q1 exception
        // below (round-18A finding 6 / ruling (r)-(u-2)), which asked only
        // "does the redeeming lane hold ANY earned authority over this FILE"
        // (`_editAddressResidency(...) === "shipped"`, a FILE-granular
        // question). MEASURED (`scratchpad/r19a/a1_range_foreign.mts`,
        // `a3_range_foreign_searchreplace.mts`, both env arms): lane A reads
        // ONLY lines 500-510 of a 700-line file and gets a range-scoped
        // handle; lane B, having read only lines 1-10 of the SAME file (so it
        // already holds file-granular "shipped" residency), redeems lane A's
        // handle and blind-overwrites lines 500-510 — bytes lane B never
        // received — for both `{handle,content}` and `{handle,search,
        // replace}`. The SAME lane B's honest equivalent, a bare
        // `path`+`content` whole-file replace declaring its actual intent,
        // correctly refuses `write-intent-ambiguous`
        // (`a2_path_whole_file_control.mts`) — so the foreign-range-handle
        // route was a strictly more dangerous, less-declared write primitive
        // than anything the file-granular check was designed to permit.
        //
        // THE RULING: a handle NAMES an address, not merely a file, and a
        // handle minted with a `range` names exactly that address — the
        // redeeming lane's own authority must cover the SAME address, not
        // just some other part of the same file. The redeeming lane's OWN
        // session (`session` here IS that lane's — `getSession` is
        // lane-scoped) may already hold that authority via its own honest
        // reads, staged under its own lane in `servedRangeLedger` — the same
        // per-address ledger FX-L/FX-N already treat as the sole proof of
        // "bytes this lane received". A foreign handle is redundant with (and
        // therefore admissible against) bytes this lane already holds only
        // when that ledger's SETTLED spans fully cover the handle's own line
        // range; a whole-file handle (no `range` on its table entry) needs
        // whole-file coverage — a genuine `content:"full"` serve, or a
        // `code_unchanged` restatement of one, both leave nothing unserved.
        // File-granular admission (the old exception) is now refused.
        //
        // THE LOOP PROPERTY IS UNCHANGED: `_refuseUngatedEdit`'s recovery
        // `next` below always reads the WHOLE file (`content:"full"`) under
        // the redeeming lane, which trivially satisfies ANY range this same
        // predicate asks about on the verbatim retry — so FX-Q1's "running
        // the recovery verbatim admits the same edit" property still holds
        // for this narrower predicate.
        const path = resolveHandlePath?.(handle) ?? "";
        if (path === "") return true;
        const range = opts?.resolveHandleRange?.(handle);
        const requestedRange = typeof range === "string" ? _parseHandleLineRange(range) : undefined;
        return !_foreignHandleRangeCovered(session, workspaceRoot, path, requestedRange);
      });
  if (foreignLaneHandles.length > 0) {
    return _refuseUngatedEdit(session, workspaceRoot, args, {
      detail: `edit handle(s) ${foreignLaneHandles.join(",")} were minted in another agent lane; a handle is write authority only in the lane that was served its bytes`
        + (redeemingLane === "" ? " (this call declared no lane)" : ` (this call's lane=${redeemingLane})`),
      recoveryPaths: foreignLaneHandles
        .map((handle) => resolveHandlePath?.(handle) ?? "")
        .filter((candidate) => candidate !== ""),
      lane: redeemingLane,
    });
  }


  // D5/W4: challenge/taskEpoch:new are decision-reset inputs, not create
  // authority. An edit_file create cannot combine either with the mutation to
  // bypass an installed answer fence; a read/contract transition must first
  // install a lineage whose exact create target is grounded.
  if (fence !== undefined && fence.terminalAction === "answer" && createRequested) {
    const editSignature = editCallSignature(args);
    const paths = requestedEditPaths(args);
    const groundedCreate = (fence.phase === "prepared" || fence.phase === "verifying")
      && args["taskEpoch"] !== "new"
      && args["challenge"] === undefined
      && paths.length > 0
      && paths.every((candidate) =>
        fence.actionPaths.includes(candidate) || session.admissibleEditPaths.includes(candidate));
    if (groundedCreate) {
      return {
        allowed: true,
        reclassified: {
          from: "answer",
          to: "edit",
          trigger: "create",
          certificate_id: fence.certificateId,
        },
      };
    }
    return refuseExecutionEdit(
      session,
      fence,
      workspaceRoot,
      editSignature,
      CREATE_OUTSIDE_FRONTIER_DETAIL,
      undefined,
      args,
      resolveHandlePath,
    );
  }

  if (args["taskEpoch"] === "new") {
    // -------------------------------------------------------------------
    // FX-P1 ruling (v) (round-18A finding 2, 2026-09-03) — THE PREDICATE
    // RUNS BEFORE THE RESET, NOT AFTER IT, AND NEVER RUNS UNRESET.
    //
    // MEASURED (`scratchpad/r18/d3_gate.mts`, live, every SF flag off): a
    // capped DISCOVERY pack mints a handle for a row it shipped no body for
    // (residency "withheld"); `edit_file {task:{epoch:"new"}, edits:[{handle,
    // content}]}` used to hit the OLD version of this branch, which returned
    // `{allowed:true}` immediately — several statements before the
    // `_withheldEditAddresses` predicate below ever ran. `taskEpoch:"new"`
    // (the legacy spelling) reproduced identically. The result was the exact
    // INV-I-1 blind whole-file overwrite, laundered through one extra
    // advertised key.
    //
    // THE FIX: ask the SAME predicate the unfenced exit below asks — of the
    // RETIRING epoch's residency, i.e. BEFORE `_clearAdmissibleEditUnion`
    // wipes `editHandleResidency`/`editPathResidency` — and refuse on a
    // withheld address exactly as that exit does. Ruling (v) is explicit:
    // "epoch リセットは書き込み権限を生まない"; a caller cannot use
    // `task.epoch:"new"` to disclaim knowledge that ITS OWN prior call in
    // this same session was told these bytes were withheld. NO EPOCH RESET
    // HAPPENS ON REFUSAL — fence, admissible union, residency and verify
    // obligations are left exactly as they were, so the caller's next honest
    // step (read the address, or resubmit without `task.epoch:"new"` once it
    // has) lands on ground this task already has.
    //
    // A handle minted in the epoch that is now retiring and redeemed AFTER a
    // *different* call already performed the reset goes through the same
    // predicate too, via `session.retiredWithheldEditHandles`/
    // `retiredWithheldEditPaths` (`_clearAdmissibleEditUnion`'s doc comment):
    // the handle table itself is not epoch-scoped, so without that carry-over
    // the wipe below would erase the only record that the address was ever
    // withheld, and a LATER plain edit (no `task.epoch:"new"` of its own)
    // could then redeem it as "unknown" (positive-evidence-only admits).
    const withheld = createRequested ? [] : _withheldEditAddresses(session, args, resolveHandlePath);
    if (withheld.length > 0) {
      const recoveryPaths = withheld
        .map((pair) => (pair.path !== "" ? pair.path : resolveHandlePath?.(pair.handle) ?? ""))
        .filter((candidate) => candidate !== "");
      return _refuseUngatedEdit(session, workspaceRoot, args, {
        cause: "capped",
        detail: "this session emitted "
          + withheld.map((pair) => pair.path || pair.handle).join(",")
          + " and withheld its bytes; `task.epoch:\"new\"` does not create write authority over bytes this "
          + "session never actually served — the epoch was NOT reset",
        recoveryPaths,
        lane: redeemingLane,
      });
    }
    // Mirror of the discovery guard's branch above: an epoch reset through
    // edit_file discards an unexecuted prepared frontier just the same, so it
    // owes the same one-shot advisory (w12 merge-review symmetry fix).
    if (fence?.phase === "prepared") {
      const handles = [...new Set(fence.actionFrontier.filter((handle) => handle !== ""))];
      if (handles.length > 0) {
        session.pendingPreparedHandleAdvisory = `prepared handle(s) ${handles.join(", ")} were superseded before execution`;
      }
    }
    session.executionFence = undefined;
    _clearAdmissibleEditUnion(session);
    // FX-G-A: same co-lifetime as the discovery guard's branch above — an
    // epoch reset declared through `edit_file` retires the dead task's VF-5
    // verify obligations too.
    _clearRecordedVerifyObligations(session);
    return { allowed: true, resetForNewTask: true };
  }
  // -----------------------------------------------------------------------
  // FX-P1 (INV-I-1, ruling (r)) — THE ADMISSIBILITY PREDICATE RUNS FOR EVERY
  // EDIT, NOT ONLY THE ONES A CERTIFICATE HAPPENS TO FENCE.
  //
  // The early return immediately below is what INV-I-1 rides: a capped
  // DISCOVERY pack mints a handle for a row it shipped no body for, installs
  // no `execution_contract` (so `recordExecutionContract` never runs), and the
  // gate then admits every write form against bytes the caller never received.
  // `_withheldEditAddresses` is the same predicate the certificate lift and the
  // capped recovery already use, asked here of the REQUEST rather than of a
  // certificate — so it covers `handle`+`content`, `handle`+`search`,
  // `path`+`search`, the ranged forms and an `edits[]` batch identically.
  //
  // SCOPED TO THE UNFENCED EXITS ON PURPOSE. When a live fence exists, a
  // withheld address is already refused by the frontier check below (FX-L's
  // shipped projection removed it from the frontier) and that refusal carries
  // the `cause`/`next` shape `sfCertificateWriteAuthority` pins — including
  // the deliberate ABSENCE of `cause:"capped"` for a DEMOTED row, whose bytes
  // were withheld for a different reason. Short-circuiting it here would
  // rewrite refusals that are already correct.
  //
  // Creates are excluded: a create target is a file that does not exist yet, so
  // it has no withheld bytes to hold back, and the create branches below own
  // that decision (`create-target-exists` refuses an existing file anyway).
  if (fence === undefined || fence.phase === "revoked" || fence.phase === "done") {
    const withheld = createRequested ? [] : _withheldEditAddresses(session, args, resolveHandlePath);
    if (withheld.length > 0) {
      const recoveryPaths = withheld
        .map((pair) => (pair.path !== "" ? pair.path : resolveHandlePath?.(pair.handle) ?? ""))
        .filter((candidate) => candidate !== "");
      // `cause:"capped"` reads the residency map, which records THAT bytes were
      // withheld, not WHY — a demoted surface marks the same map. Under a live
      // fence FX-L can tell the two apart (only a capped certificate address
      // reaches `fence.withheldTargets`, which is why the DEMOTE arm keeps a
      // `cause`-free refusal) and this exit cannot. It is advisory either way:
      // `code` is `execution-typestate` and `next` carries the whole recovery,
      // which is identical for both reasons — read the address and the write is
      // admitted. The detail therefore states the FACT (emitted, not sent)
      // without asserting a mechanism.
      return _refuseUngatedEdit(session, workspaceRoot, args, {
        cause: "capped",
        detail: "this session emitted "
          + withheld.map((pair) => pair.path || pair.handle).join(",")
          + " and withheld its bytes; write authority comes only from bytes this session actually served",
        recoveryPaths,
        lane: redeemingLane,
      });
    }
    return { allowed: true };
  }
  const challenged = applyChallenge(session, fence, args, workspaceRoot);
  if (challenged !== undefined) return challenged;
  // R2: one signature per edit call — a verbatim retry of ANY refusal below
  // compacts (refuseExecutionEdit) instead of re-emitting the full payload.
  const editSignature = editCallSignature(args);
  // 2026-07-25 T13 forensics: "verifying" used to hard-refuse EVERY further
  // edit (4 identical verify-with-closure-or-diff refusals on a legitimate
  // second-file batch; two closure calls never cleared it). Sequential
  // multi-batch editing is the normal certified workflow — keep the fence but
  // let verifying fall through to the SAME frontier-membership checks as
  // prepared. Verbatim retries still compact via recentEditRefusalSignatures,
  // and a repeat of an already-applied edit fails naturally at content level.
  if (fence.phase !== "prepared" && fence.phase !== "verifying") {
    return refuseExecutionEdit(session, fence, workspaceRoot, editSignature, "edits are allowed only from prepared phase", undefined, args, resolveHandlePath);
  }
  const handles = requestedEditHandles(args);
  const paths = requestedEditPaths(args);
  if (fence.terminalAction !== "edit") {
    // A2 (2026-08-01 signal5-2 T10): an answer certificate certifies an ANSWER;
    // it is not a licence to police edits. When every requested target is
    // grounded in content this server itself served this epoch (the admissible
    // union / evidence paths), the edit is exactly as safe as under an edit
    // certificate. Create-shaped calls were handled above so only an existing
    // grounded edit can reach this branch.
    const groundedHandle = (handle: string): boolean => {
      if (session.admissibleEditHandles.includes(handle)) return true;
      const relPath = resolveHandlePath?.(handle);
      return relPath !== undefined && relPath !== "" && (
        session.admissibleEditPaths.includes(relPath)
        || fence.evidencePaths.includes(relPath)
      );
    };
    const grounded = (handles.length > 0 || paths.length > 0)
      && handles.every(groundedHandle)
      && paths.every((candidate) =>
        session.admissibleEditPaths.includes(candidate) || fence.evidencePaths.includes(candidate));
    if (grounded) {
      return {
        allowed: true,
        reclassified: {
          from: "answer",
          to: "edit",
          trigger: "grounded-edit",
          certificate_id: fence.certificateId,
        },
      };
    }
    const remedyRepackPaths = [...new Set([
      ...paths,
      ...handles
        .map((handle) => resolveHandlePath?.(handle))
        .filter((p): p is string => typeof p === "string" && p !== ""),
    ])].slice(0, 8);
    return refuseExecutionEdit(session, fence, workspaceRoot, editSignature, "answer-ready certificate does not authorize edits; if the task genuinely requires edits, re-scope with taskEpoch:\"new\"", remedyRepackPaths, args, resolveHandlePath);
  }
  // v0.14.1 defect 1 fix (2026-09-07): a canonical edits[] batch may mark
  // individual items create:true -- each such item is a create request for
  // ITS OWN path, independent of whichever other items ride in the same
  // batch (mixed batches included). `createRequested` (the legacy top-level
  // create/allow_create flag) keeps meaning "the whole call is a create",
  // unchanged -- every OTHER branch above that gates on it (foreign-lane
  // handles, the answer-fence branch, the taskEpoch:"new"/unfenced
  // withheld-bytes checks) is deliberately left reading that same narrow
  // boolean: widening it there would silently exempt a mixed batch's
  // NON-create items from those checks too (FX-P1's lane isolation above in
  // particular must not weaken). Per-item detection is therefore local to
  // this branch and the frontier check immediately below it.
  const itemCreatePaths = createRequested ? [] : requestedItemCreatePaths(args);
  const createPaths = createRequested ? paths : itemCreatePaths;
  const nonCreateHandles = createRequested ? [] : handles;
  const nonCreatePaths = createRequested
    ? []
    : paths.filter((candidate) => !itemCreatePaths.includes(candidate));
  const anyCreateRequested = createRequested || itemCreatePaths.length > 0;
  if (
    batchEditFrontierEnabled() && fence.phase === "prepared" && fence.batchEditTargets.length > 1
    // A wholly-create call has no prepared batch to complete against
    // (unchanged pure-create behaviour, below); a mixed batch must still
    // batch every ready obligation among its non-create items.
    && (nonCreateHandles.length > 0 || nonCreatePaths.length > 0)
  ) {
    const requestedHandleSet = new Set(handles);
    const requestedPathSet = new Set([...paths, ...handles.map((handle) => resolveHandlePath?.(handle)).filter((candidate): candidate is string => typeof candidate === "string" && candidate !== "")]);
    const missingBatchTargets = fence.batchEditTargets.filter((target) => !requestedHandleSet.has(target.handle) && (target.path === "" || !requestedPathSet.has(target.path)));
    if (missingBatchTargets.length > 0) {
      const missing = missingBatchTargets.map((target) => target.path || target.handle).join(",");
      return refuseExecutionEdit(session, fence, workspaceRoot, editSignature, `prepared multi-target edit must batch every ready edit obligation in one edits[] call; missing=${missing}`, undefined, args, resolveHandlePath);
    }
  }
  let createAuthorization: ExecutionCreateAuthorization | undefined;
  if (anyCreateRequested) {
    // Frontier-union fix: a create target admissible in ANY earlier same-epoch
    // certificate (the union) stays admissible, not just the latest frontier.
    const packNamedCreate = createPaths.length > 0 && createPaths.every((candidate) =>
      fence.actionPaths.includes(candidate) || session.admissibleEditPaths.includes(candidate));
    if (!packNamedCreate) {
    // L1 (2026-08-07 T05c/T10 forensics): this fence ALREADY authorizes
    // writes, and the only transition the refusal below can advertise --
    // `read_file mode=task_pack taskEpoch:"new"` -- grants the create no
    // authority it lacks here: that branch DISCARDS the fence outright (see
    // the taskEpoch:"new" reset above), after which the byte-identical create
    // is admitted by the `fence === undefined` fast path. Measured cost of
    // that round trip in 2026-08-07-semantic-signal5-1 T05c rep0: two turns
    // and a second full upload of the file body, per created file, twice per
    // cell -- for a predicate that admits the same call either way.
    //
    // So when the caller states WHERE the file goes (an explicit cwd, or a
    // handle capability that carries one), admit it on the first call. This
    // is not a security relaxation: confinement for a create is enforced
    // downstream and unconditionally by createFile.ts (the --allow-write
    // gate, the lexical workspace-prefix check, and the realpath walk to the
    // nearest existing ancestor), none of which this branch can reach or
    // weaken. The frontier predicate only ever decided WHETHER the caller had
    // to spend a re-pack first.
    //
    // Deliberately NOT extended to `fence.terminalAction === "answer"`, which
    // is handled far above and keeps refusing: a pin says where a create goes,
    // never whether an answer certificate may write at all (D5/W4).
      if (opts?.createWorkspacePin === undefined || createPaths.length === 0) {
        return refuseExecutionEdit(session, fence, workspaceRoot, editSignature, CREATE_OUTSIDE_FRONTIER_DETAIL, undefined, args, resolveHandlePath);
      }
      createAuthorization = { pin: opts.createWorkspacePin, paths: [...createPaths] };
    }
    if (nonCreateHandles.length === 0 && nonCreatePaths.length === 0) {
      return createAuthorization !== undefined ? { allowed: true, createAuthorization } : { allowed: true };
    }
    // Mixed batch: the create side is admitted (pack-named or pinned, above)
    // -- fall through to the SAME ordinary frontier-membership check every
    // other edit goes through, now scoped to the non-create remainder, before
    // admitting the whole batch.
  }
  // Frontier-union fix (2026-07-24 T10): admit a target in the LATEST frontier
  // (unchanged fast path) OR in the epoch-scoped admissible union (a handle/path
  // served by an EARLIER pack of this same task). All the OTHER gates above
  // (phase, terminal-action, challenge, verifying) already passed — this only
  // widens WHICH targets the frontier membership check accepts.
  // 2026-07-25 T05c forensics: a frontier handle bound to lines 1-69 of a
  // 309-line file stranded the LEGITIMATE successor handles of the SAME file
  // (4 refused calls -> forced challenge -> native edit). A handle this server
  // itself minted for a file already in the certificate's frontier/evidence/
  // admissible path set satisfies the serve-with-state purpose — admit it.
  const handlePathAdmissible = (handle: string): boolean => {
    const relPath = resolveHandlePath?.(handle);
    return relPath !== undefined && relPath !== "" && (
      fence.actionPaths.includes(relPath)
      || session.admissibleEditPaths.includes(relPath)
      || fence.evidencePaths.includes(relPath)
    );
  };
  const checkHandles = anyCreateRequested ? nonCreateHandles : handles;
  const checkPaths = anyCreateRequested ? nonCreatePaths : paths;
  const outsideHandles = checkHandles.filter((handle) =>
    !fence.actionFrontier.includes(handle)
    && !session.admissibleEditHandles.includes(handle)
    && !handlePathAdmissible(handle));
  const outsidePaths = checkPaths.filter((candidate) =>
    !fence.actionPaths.includes(candidate) && !session.admissibleEditPaths.includes(candidate));
  if (!anyCreateRequested && handles.length === 0 && paths.length === 0) {
    return refuseExecutionEdit(session, fence, workspaceRoot, editSignature, "edit has no certificate-backed handle or path", undefined, args, resolveHandlePath);
  }
  if (outsideHandles.length > 0 || outsidePaths.length > 0) {
    // F-R8 (2026-08-22 T05c rep0 arm A): outside-frontier handles that this
    // SESSION itself minted — just under an earlier, now-superseded epoch —
    // are not foreign. Resolve every one of them; only when ALL resolve (a
    // hallucinated handle mixed into the same batch stays on today's path) is
    // the caller pointed at a real re-pack instead of a same-frontier
    // template it cannot use and a challenge it cannot author.
    const outsideHandlePairs: HandlePathPair[] = outsideHandles.map((handle) => ({
      handle,
      path: resolveHandlePath?.(handle) ?? "",
    }));
    const allOutsideHandlesKnown = outsideHandlePairs.every((pair) => pair.path !== "");
    const knownOutsideRepackPaths = allOutsideHandlesKnown
      ? [...new Set([...outsideHandlePairs.map((pair) => pair.path), ...outsidePaths])]
      : [];
    // P2-2 fix (report-items.md / DESIGN-v0.15 hands-on-report wave): the
    // recovery `next` below re-packs with `taskEpoch:"new"`, which installs a
    // FRESH certificate whose frontier is computed solely from the `paths`
    // that call names. Naming only the outside-of-frontier subset
    // (`knownOutsideRepackPaths`, still computed above for its OTHER
    // consumers) left the already-admissible remainder unserved under the
    // new epoch, so the identical batch refused a SECOND time citing exactly
    // those paths — two recovery reads for one mixed batch. `recoveryPaths`
    // is the UNION of the whole batch's non-create requested set
    // (`checkPaths` plus `checkHandles` resolved to paths, both already in
    // scope here) — every non-create target the re-packed certificate must
    // cover so the identical batch applies in one shot. `knownOutsideRepack.
    // paths`/`.pairs` themselves stay OUTSIDE-only, unchanged, for their
    // other consumers (`alsoAdmissiblePairs`, the `cause:"capped"`
    // diagnosis) — only the recovery `next` widens.
    //
    // Review finding 3 fix (2026-09-08): `knownOutsideRepackPaths` — the
    // outside-of-frontier subset, i.e. what THIS refusal is actually about —
    // is ordered FIRST, ahead of the rest of the union. `next_call` below
    // slices this array to KNOWN_OUTSIDE_REPACK_PATH_CAP (64); before this
    // fix the union was ordered by caller-supplied batch position, so for a
    // >64-target batch the outside subset could sort past the cap and be
    // silently dropped from the recovery `next` — re-opening the exact
    // two-read case this whole mechanism exists to close, only for the
    // large-batch shape where it matters most. `knownOutsideRepackPaths` is
    // reliable to lead with here: this branch only ever constructs when
    // `allOutsideHandlesKnown` is true (the gate above), so it already names
    // EVERY outside target, never a partial view. Residual (documented, not
    // solved by ordering alone): when the outside-of-frontier subset ITSELF
    // exceeds the 64 cap (every target in an over-sized batch is outside the
    // frontier, not just a handful), no ordering can fit them all in one
    // recovery read — `remaining` still discloses the dropped tail, and the
    // caller genuinely needs a second recovery read for it.
    const recoveryPaths = [...new Set([
      ...knownOutsideRepackPaths,
      ...checkPaths,
      ...checkHandles
        .map((handle) => resolveHandlePath?.(handle))
        .filter((candidate): candidate is string => typeof candidate === "string" && candidate !== ""),
    ])];
    const knownOutsideRepack = knownOutsideRepackPaths.length > 0
      ? {
          paths: knownOutsideRepackPaths,
          pairs: [...outsideHandlePairs, ...outsidePaths.map((path) => ({ handle: "", path }))],
          recoveryPaths,
        }
      : undefined;
    // The unified `frontier` payload (executionRefusal) now carries the epoch
    // admissible union structurally, so a stranded edit is pointed back at the
    // still-editable handles WITHOUT a free-text also_admissible note or a
    // reflexive re-pack + challenge cycle (the T10 thrash this fix removed).
    // F-R8 narrows that on purpose: this only ever ADDS a real re-pack call
    // when the refused targets are independently verified as session-known;
    // it never widens the frontier itself and never fires for a genuinely
    // unknown/foreign handle (h999-style in executionTypestate.spec.ts), so
    // the T10 guard is unchanged for every case it protected.
    return refuseExecutionEdit(
      session,
      fence,
      workspaceRoot,
      editSignature,
      `edit target is outside certificate frontier${outsideHandles.length ? ` handles=${outsideHandles.join(",")}` : ""}${outsidePaths.length ? ` paths=${outsidePaths.join(",")}` : ""}`,
      undefined,
      args,
      resolveHandlePath,
      knownOutsideRepack,
    );
  }
  return createAuthorization !== undefined ? { allowed: true, createAuthorization } : { allowed: true };
}

/** The `opts` shape `guardExecutionEditCore` takes, reused by its wrapper below. */
type GuardExecutionEditOpts = Parameters<typeof guardExecutionEditCore>[3];

/**
 * DESIGN-v0.15-sf-intent-layers.md §4.2 (IL-W2): records layer 2's
 * OBSERVED evidence for `sfIntent.ts`'s `resolveIntent` — has an edit_file
 * call already passed this guard, genuinely, during the current task epoch?
 *
 * L1 (2026-09-05 R28 remediation): `resetForNewTask` no longer excludes this
 * record. Unlike the DISCOVERY guard (`guardExecutionDiscovery`), whose
 * `taskEpoch:"new"` branch returns immediately — no read/search bytes are
 * served by that same call, so `resetForNewTask:true` there genuinely means
 * "nothing was observed yet" — `guardExecutionEditCore`'s `taskEpoch:"new"`
 * branch does NOT short-circuit the edit: it resets the epoch's ledgers
 * in-place and, absent a withheld-address refusal, falls through to
 * `{allowed:true, resetForNewTask:true}` while server.ts's dispatcher
 * CONTINUES on to actually apply the requested edit in this SAME call (the
 * only gate is `if (!executionGuard.allowed) return …`). An edit_file call
 * that opens its own new epoch and lands is therefore exactly as much "an
 * edit_file call passed this guard, genuinely, during the current task
 * epoch" as an ordinary one — the epoch it belongs to is simply the one it
 * just opened. The old `resetForNewTask !== true` guard treated "opened a new
 * epoch" as synonymous with "did not edit", which is true for discovery and
 * false for edit_file; excluding it here left a landed edit unrecorded, so
 * `referencesObserved`/`editObserved`-gated logic downstream saw a task that
 * had (from ITS OWN edit_file call) already written a file but had
 * apparently never edited anything. A REFUSED edit — `decision.allowed ===
 * false`, whether or not it also carried `task.epoch:"new"` — still never
 * sets this: `decision.allowed` alone is the exact predicate the
 * NON-reset path always used, extended honestly to the reset path.
 *
 * Deliberately NOT a new post-core seam: no staging, no deferred/wire-time
 * settlement (unlike `settleServedRanges`'s FX-N ruling (s) pattern), no
 * separate module reading the finished decision later. This wrapper reads
 * the SAME `ExecutionGuardDecision` its caller reads, synchronously, right
 * here, and every fence/certificate booking `guardExecutionEditCore` performs
 * stays exactly as it was — this function changes nothing about WHEN or IN
 * WHAT ORDER those bookings happen, only records one extra fact once the
 * core guard has already finished deciding.
 */
export function guardExecutionEdit(
  workspaceRoot: string,
  args: Record<string, unknown>,
  resolveHandlePath?: (handle: string) => string | undefined,
  opts?: GuardExecutionEditOpts,
): ExecutionGuardDecision {
  // -----------------------------------------------------------------------
  // FX-L SOFT FRONTIER MARKER (user ruling 2026-09-14). Derived in the SAME
  // wrapper IL-W2 already owns, for the same reason: it reads the finished
  // question without moving a single booking inside `guardExecutionEditCore`.
  //
  // ORDER. The marker is computed BEFORE the core runs, because the strict
  // arm must refuse with nothing attempted — the core's `task.epoch:"new"`
  // branch would otherwise have already retired the very record the decision
  // is about (and cleared this epoch's ledgers). In the DEFAULT arm the
  // ordering is immaterial: the core neither reads nor writes
  // `session.certifiedDecision`.
  //
  // STRICT PRE-EMPTS, DELIBERATELY. When the flag is on, a target the latest
  // certified decision did not authorize is refused here even if the core
  // would have refused it for a different reason. That is the honest reading
  // of "the same condition REFUSES the whole batch": the condition is about
  // AUTHORITY, and an authority failure is not improved by first computing a
  // byte-residency diagnosis for a write that may not happen at all. The one
  // refusal this can never mask is the physical one — a `nul-stripped` file
  // is never certified writable in the first place (BLOCKER 62's
  // `writeAuthorityVeto` gate 3 degrades that pack to `await_input`, which is
  // not a certified decision), so no record exists for it to be marked
  // against and `detectWriteEncodingRisk` still owns that refusal, flag or no
  // flag.
  // -----------------------------------------------------------------------
  const session = getSession(workspaceRoot);
  const certified = session.certifiedDecision;
  const marker = certifiedFrontierMarkerFor(workspaceRoot, args, resolveHandlePath);
  if (frontierStrictWritesEnabled() && certified !== undefined && marker !== undefined) {
    return refuseStrictFrontierWrite(session, workspaceRoot, args, certified, marker, resolveHandlePath);
  }
  const decision = guardExecutionEditCore(workspaceRoot, args, resolveHandlePath, opts);
  if (decision.allowed) {
    session.intentEditObserved = true;
    // Attached only on the allowed arm: a REFUSED edit wrote nothing, so it
    // has no landing site to report. Never folded into `reclassified` — see
    // `ExecutionGuardDecision.frontierMarker`'s own doc comment.
    if (marker !== undefined) return { ...decision, frontierMarker: marker };
  }
  return decision;
}

/**
 * Successful certified edit advances PREPARED -> VERIFYING, and (C5) discharges
 * the fence's outstanding demand by the PATHS the edit actually wrote.
 *
 * `writtenPaths` defaults to `[]` so the historical 2-argument call compiles
 * unchanged. Discharge deliberately runs for EVERY phase, not just `prepared`:
 * the 2026-08-02 T05c rep0 fence was already `verifying` when the prescribed
 * batch landed, which is exactly the case the ledger has to record.
 */
export function recordExecutionEditResult(
  workspaceRoot: string,
  success: boolean,
  writtenPaths: readonly string[] = [],
  reclassification?: ExecutionReclassification,
): void {
  const fence = getSession(workspaceRoot).executionFence;
  if (fence === undefined) return;
  // L2b (2026-08-08): a successful write is the FRESHNESS half of
  // discoverySignatures' invariant (see its doc). Every count under this fence
  // describes a call whose answer the write may have just changed, so re-reads
  // of post-edit content are legitimate and must not meet a brake armed by
  // pre-edit calls. Measured before this fix: closure, diff, find, tree and
  // even a further SUCCESSFUL edit all left the counter standing, so the
  // refusal's own required_action could not be discharged and the call stayed
  // refused for the rest of the session. This is the minimal correct site —
  // the single funnel a successful edit_file reports through, and already the
  // owner of the fence's other post-write transitions (demand ledger, phase,
  // reclassification). Cleared BEFORE the early returns below so the
  // reclassification and non-prepared paths reset too.
  if (success) {
    fence.discoverySignatures.clear();
    // ND-1: every zero-byte verdict was derived from PRE-edit content. A
    // symbol the write may have just introduced must not stay classified as
    // "this call shape serves nothing".
    fence.zeroByteSignatures.clear();
  }
  if (success && fence.demand !== undefined) {
    for (const written of writtenPaths) {
      if (written === "" || fence.demand.satisfiedPaths.includes(written)) continue;
      fence.demand.satisfiedPaths.push(written);
    }
  }
  if (success && reclassification !== undefined) {
    // Commit the observed action change only after the write succeeds. Keep
    // the fence live as an edit/verifying fence, so follow-up writes remain
    // bounded by the existing frontier instead of falling into no-fence mode.
    fence.reclassification = reclassification;
    fence.terminalAction = "edit";
    fence.phase = "verifying";
    return;
  }
  if (fence.phase !== "prepared" || fence.terminalAction !== "edit") return;
  if (success) fence.phase = "verifying";
}

export function getExecutionFence(workspaceRoot: string): ExecutionFenceState | undefined {
  return getSession(workspaceRoot).executionFence;
}

/**
 * VF-5 hand-off: the active task epoch's recorded `TaskChangeContract.verify_obligations`,
 * as last reported to `recordExecutionContract`. `undefined` when no ready
 * contract in the CURRENT epoch reported any — which now covers three cases
 * that all mean the same thing to the gate: none was ever recorded, a later
 * contract reported an empty list (replace semantics), or the epoch turned
 * over (`taskEpoch:"new"`). Never an empty array: the recorder normalizes
 * `[]` to `undefined`. Read by `protocol/readFamily.ts`'s `verifyClosureGate`
 * as its kit-less fallback source (VF-5).
 */
export function recordedVerifyObligations(workspaceRoot: string): readonly TaskVerifyObligation[] | undefined {
  return getSession(workspaceRoot).recordedVerifyObligations;
}

/** Consume the one-shot advisory generated when a prepared frontier is superseded. */
export function takePreparedHandleAdvisory(workspaceRoot: string): string | undefined {
  const session = getSession(workspaceRoot);
  const advisory = session.pendingPreparedHandleAdvisory;
  session.pendingPreparedHandleAdvisory = undefined;
  return advisory;
}

/**
 * Re-key an installed fence when the producer demotes the certificate identity
 * it is about to ship.
 *
 * WHY THIS EXISTS. `recordExecutionContract` installs the fence keyed on
 * `certificate.id`, and `challengeCertificate` matches the caller-supplied
 * `certificate_id` against `fence.certificateId` — so the fence's key is the
 * id the CALLER sees on the wire. `recordTaskPackExecution` learns only later
 * (once the task handle has resolved the durable ledger scope) whether a
 * ledger-backed id can actually be backed by a snapshot; when it cannot, it
 * strips the ledger claim. Without this, the wire would carry one id and the
 * fence another, and the challenge that id authorizes could never match.
 *
 * Deliberately a no-op unless the live fence still carries `from`: a fence that
 * has already been cleared, revoked or replaced must not be resurrected here.
 */
export function rekeyExecutionFenceCertificate(
  workspaceRoot: string,
  from: string,
  to: string,
): void {
  if (from === to) return;
  const session = getSession(workspaceRoot);
  const fence = session.executionFence;
  if (fence !== undefined && fence.certificateId === from) fence.certificateId = to;
  if (session.lastExecutionCertificateId === from) session.lastExecutionCertificateId = to;
}

/** A new task opens the gate without erasing provenance for already-served bytes. */
export function getLastExecutionCertificateId(workspaceRoot: string): string | undefined {
  const session = getSession(workspaceRoot);
  return session.executionFence?.certificateId ?? session.lastExecutionCertificateId;
}

/**
 * Test hook (frontier-union fix): the current epoch-scoped admissible edit
 * union. Returns copies so callers cannot mutate session state.
 */
export function getAdmissibleEditUnionForTest(
  workspaceRoot: string,
): { handles: string[]; paths: string[] } {
  const s = getSession(workspaceRoot);
  return { handles: [...s.admissibleEditHandles], paths: [...s.admissibleEditPaths] };
}

/**
 * Guard 1 (2026-07-12b cross-workspace-bleed forensics): returns OTHER workspace roots
 * that currently hold an active session, excluding `resolvedRoot`. A
 * read-only scan of the registry — deliberately does NOT call getSession, so
 * asking about a root (including `resolvedRoot` itself) never creates a
 * session as a side effect of the check. Used by server.ts's callTool to
 * warn a cwd-less, handle-less read_file/search_files call when more than
 * one workspace is live, so a call that silently resolves against the
 * default root isn't mistaken for the OTHER active worktree.
 */
export function otherActiveRoots(resolvedRoot: string): string[] {
  sweepIdleSessions(sessionKeyFor(resolvedRoot));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const key of _sessions.keys()) {
    // Lanes are an intra-root partition, not extra roots: every lane of one
    // root collapses to a single entry, and the resolved root is excluded in
    // ALL its lanes — this list feeds cwd candidates/root notes, so a
    // composite key must never leak here.
    const root = rootOfSessionKey(key);
    if (root === resolvedRoot || seen.has(root)) continue;
    seen.add(root);
    out.push(root);
  }
  return out;
}

/** Increments the read_code call counter for the given mode. */
export function recordReadMode(workspaceRoot: string, mode: string): void {
  const s = getSession(workspaceRoot);
  s.readsByMode.set(mode, (s.readsByMode.get(mode) ?? 0) + 1);
}

/**
 * Records a full-file expansion for the given path and sha.
 *
 * When the sha differs from the previously recorded sha, the per-path counter
 * resets to 1 (the file changed, so this is a fresh expansion).
 *
 * Returns whether the reset happened.
 */
export function recordFullExpansion(
  workspaceRoot: string,
  path: string,
  sha: string,
  keepComments: boolean,
): { resetByShaChange: boolean } {
  const s = getSession(workspaceRoot);
  const prev = s.fullExpansionsPerPath.get(path);

  let resetByShaChange = false;
  if (prev === undefined) {
    s.fullExpansionsPerPath.set(path, { count: 1, lastSha: sha, keepComments });
  } else if (prev.lastSha !== sha) {
    s.fullExpansionsPerPath.set(path, { count: 1, lastSha: sha, keepComments });
    resetByShaChange = true;
  } else {
    prev.count += 1;
    // P2-1 (2026-09-08): record the LATEST projection — wasFullyServed
    // compares against it, so a repeat under a different projection is
    // never mistaken for "already fully served".
    prev.keepComments = keepComments;
  }

  s.fullExpansionsTotal += 1;
  return { resetByShaChange };
}

/**
 * DESIGN-v0.8 §C4: records a TINY-file full-content expansion, incrementing
 * the dedicated tinyFullExpansionsTotal counter. Called by fullGovernor.ts's
 * tiny-file branch ALONGSIDE (not instead of) recordFullExpansion — the two
 * counters track independent budgets (TINY_TASK_CAP vs PER_TASK_FULL_CAP)
 * and neither reset/decay affects the other.
 *
 * FIX-3a (2026-07-09d forensics): `exempt:true` (readCodeSmallFile.ts's
 * buildSmallFile, when called with governorExempt — readCodePack's explicit
 * paths[] enumeration) routes the increment to the SEPARATE
 * tinyFullExpansionsExemptTotal counter instead. An exempt call is still
 * recorded (telemetry reflects reality) but never erodes the
 * TINY_TASK_CAP budget non-exempt (ordinary agent) calls draw down. Default
 * `false` preserves the exact prior behavior for every existing caller.
 */
export function recordTinyFullExpansion(workspaceRoot: string, exempt = false): void {
  const s = getSession(workspaceRoot);
  if (exempt) {
    s.tinyFullExpansionsExemptTotal += 1;
    return;
  }
  s.tinyFullExpansionsTotal += 1;
}

/**
 * Records a successful handle-backed edit.
 *
 * Decays full_expansions_total by floor(total / 2), i.e. total <- ceil(total / 2).
 * This is the "progress refills budget" rule from the design.
 */
export function recordHandleEdit(workspaceRoot: string): void {
  const s = getSession(workspaceRoot);
  s.handleBackedEdits += 1;
  s.fullExpansionsTotal = Math.ceil(s.fullExpansionsTotal / 2);
}

/** Records an edit_code call that used path/search without a handle. */
export function recordPathSearchEdit(workspaceRoot: string): void {
  const s = getSession(workspaceRoot);
  s.pathOrSearchEditsWithoutHandle += 1;
}

/**
 * Successful single-edit count at which the one-shot batching hint fires (see
 * recordSingleEditCompletion). 2026-07-24 bench T09 forensics: at 4 the nudge
 * landed only after most batchable work had already been spent as one-shot
 * calls (observed sessions made 5 sequential single edits and ignored it); 2
 * is the earliest point with evidence of a forming sequence.
 */
export const BATCH_HINT_THRESHOLD = 2;

/**
 * Records a successful single-edit edit_file completion (search/replace,
 * handle+content, target=all, pathless, symbol+search) — callers gate on
 * ok!==false before calling this, same convention as recordHandleEdit /
 * recordPathSearchEdit above. NOT called for create=true or an edits[] batch
 * (see recordEditsBatchUsed) — those aren't poolable into edits[], so they
 * must not count toward the threshold.
 *
 * Returns true exactly once per session: on the call that brings the counter
 * to BATCH_HINT_THRESHOLD, unless the session has already used edits[] (the
 * agent already knows the batch form, so the hint stays permanently
 * suppressed). The counter keeps incrementing past the threshold; only the
 * boolean return value is one-shot.
 */
export function recordSingleEditCompletion(workspaceRoot: string): boolean {
  const s = getSession(workspaceRoot);
  s.singleEditCompletions += 1;
  return s.singleEditCompletions === BATCH_HINT_THRESHOLD && !s.usedEditsBatch;
}

/**
 * Marks that this session has made an edits[] batch call (any batch size,
 * success or failure) — permanently suppresses the one-shot batching hint
 * (recordSingleEditCompletion never returns true again this session).
 */
export function recordEditsBatchUsed(workspaceRoot: string): void {
  getSession(workspaceRoot).usedEditsBatch = true;
}

/**
 * Successful single-query find count at which the one-shot batching hint
 * fires (see recordSingleFindCompletion). L2 (2026-07-30 bench T11
 * forensics): lowered 4 -> 2 — a live A/B cell paid 7 of its 17 TL calls on
 * serial single-token find guessing, and by the OLD threshold's 4th call
 * most of that waste had already happened. Mirrors BATCH_HINT_THRESHOLD's
 * own "4 fires too late, 2 catches the pattern while it is still forming"
 * finding above — same rationale, same one-shot mechanism (findHintFired),
 * only the number changed.
 */
export const FIND_HINT_THRESHOLD = 2;

/**
 * Records a successful single-`query` search_files find completion (Fix B,
 * 2026-07-12c single-query-find-loop forensics) — a `queries:[...]` call does NOT call
 * this (see the find dispatch in server.ts). Mirrors
 * recordSingleEditCompletion's counter/threshold shape, but guards on an
 * explicit `findHintFired` flag rather than relying solely on a
 * count===threshold equality, and has no batch-use suppression (see
 * findHintFired's doc comment for why).
 *
 * Returns true exactly once per session: on the call that brings the
 * counter to FIND_HINT_THRESHOLD. The counter keeps incrementing past the
 * threshold; only the boolean return value — and findHintFired — are
 * one-shot.
 */
export function recordSingleFindCompletion(workspaceRoot: string): boolean {
  const s = getSession(workspaceRoot);
  // Increment UNCONDITIONALLY (even past the threshold, even after the hint
  // has fired) so the counter stays an accurate count for telemetry
  // (snapshotForTrace) — only the boolean RETURN value is one-shot, gated
  // separately by findHintFired below.
  s.singleFindCompletions += 1;
  if (s.findHintFired) return false;
  if (s.singleFindCompletions === FIND_HINT_THRESHOLD) {
    s.findHintFired = true;
    return true;
  }
  return false;
}

/**
 * W-BATCH-HINT candidate 3 (TL_BATCH_HINTS, default OFF; DESIGN-v0.15-sf-
 * turn-economy.md §3). Threshold at which a run of consecutive single-target
 * read-family calls (read_file with one target/handle, or search_files
 * action=find with one query — see server.ts's classification at its two
 * `guardExecutionDiscovery` call sites) starts advertising the fold-into-one-
 * call hint. UNLIKE FIND_HINT_THRESHOLD/BATCH_HINT_THRESHOLD (one-shot: the
 * hint fires once and never again), this hint is meant to keep firing on
 * every response for the rest of an unbroken streak — see
 * recordReadFamilySingleTargetCall's return-value doc below — because the
 * turn waste it names (32 consecutive single-target calls in the r4
 * forensics this candidate answers) does not stop being waste after the
 * first nudge.
 */
export const SERIAL_SINGLE_TARGET_HINT_THRESHOLD = 3;

/**
 * Records one read-family call's target-count shape against this
 * (workspace, lane, task-epoch) streak — `getSession` is already lane-scoped
 * (laneScopedKey) and `guardExecutionDiscovery`'s epoch-reset block zeroes
 * `serialSingleTargetReads` on `taskEpoch:"new"`, so this function itself
 * only has to handle the streak's own increment/reset rule: `isSingleTarget`
 * true advances the streak by one; false (a multi-target read_file or
 * search_files-find call) resets it to zero — the "a multi-target call
 * resets the counter" rule this candidate specifies. Call this UNCONDITIONALLY
 * for every read_file/search_files-find call that reaches dispatch (never for
 * edit_file, which does not participate at all — neither advancing nor
 * resetting the streak), regardless of whether the response that follows
 * turns out to be a receipt or a refusal: the streak counts CALL SHAPES, and
 * whether to actually attach the hint to THIS response is a separate,
 * narrower decision the caller makes from the boolean this returns (never
 * fires on edit_file/refusal/receipt kinds — see envelope.ts's
 * `applySerialSingleTargetHint`).
 *
 * Returns true from the call that brings the streak to
 * SERIAL_SINGLE_TARGET_HINT_THRESHOLD onward, until the next reset — NOT
 * one-shot, unlike recordSingleFindCompletion above.
 */
export function recordReadFamilySingleTargetCall(workspaceRoot: string, isSingleTarget: boolean): boolean {
  const s = getSession(workspaceRoot);
  if (!isSingleTarget) {
    s.serialSingleTargetReads = 0;
    return false;
  }
  s.serialSingleTargetReads += 1;
  return s.serialSingleTargetReads >= SERIAL_SINGLE_TARGET_HINT_THRESHOLD;
}

/**
 * Records a read of (path, range) and returns the updated repeat count.
 * The first read returns 1; each subsequent call for the same pair increments.
 */
export function recordRepeatedRead(
  workspaceRoot: string,
  path: string,
  range: string,
): number {
  const s = getSession(workspaceRoot);
  const key = `${path}#${range}`;
  const next = (s.repeatedReadsPerPathRange.get(key) ?? 0) + 1;
  s.repeatedReadsPerPathRange.set(key, next);
  return next;
}

function parseArtifactRange(range: string): [number, number, number, number] | undefined {
  const match = range.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
  if (match === null) return undefined;
  const col = (value: string): number => [...value.toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
  const parsed: [number, number, number, number] = [Number(match[2]), Number(match[4]), col(match[1]!), col(match[3]!)];
  // Reversed spans (e.g. "C5:A1") never come from server echoes; refuse them
  // so the containment math cannot false-positive against a ledger entry.
  if (parsed[0] > parsed[1] || parsed[2] > parsed[3]) return undefined;
  return parsed;
}

function artifactRangeText(range: [number, number, number, number]): string {
  const col = (n: number): string => { let out = ""; for (let value = n; value > 0; value = Math.floor((value - 1) / 26)) out = String.fromCharCode(65 + ((value - 1) % 26)) + out; return out; };
  return `${col(range[2])}${range[0]}:${col(range[3])}${range[1]}`;
}

export function artifactRangeReceipt(workspaceRoot: string, path: string, sheet: string, fileSha: string, requestedRange: string): ArtifactServedRangeReceipt | undefined {
  const requested = parseArtifactRange(requestedRange);
  if (requested === undefined) return undefined;
  const state = getSession(workspaceRoot).artifactServedRangeLedger.get(`${path}#${sheet}`);
  if (state === undefined || state.fileSha !== fileSha) return undefined;
  const covered = state.ranges.find(([r1, r2, c1, c2]) => r1 <= requested[0] && r2 >= requested[1] && c1 <= requested[2] && c2 >= requested[3]);
  if (covered === undefined) return undefined;
  return { sha: fileSha.slice(0, 12), served: state.ranges.map(artifactRangeText), complete: true, ...(state.servedBy[0] ? { served_by: state.servedBy[0] } : {}) };
}

export function recordArtifactServedRange(workspaceRoot: string, path: string, sheet: string, fileSha: string, range: string, servedBy?: string): ArtifactServedRangeReceipt {
  const parsed = parseArtifactRange(range);
  if (parsed === undefined) return { sha: fileSha.slice(0, 12), served: [], complete: false };
  const session = getSession(workspaceRoot);
  const key = `${path}#${sheet}`;
  let state = session.artifactServedRangeLedger.get(key);
  if (state === undefined || state.fileSha !== fileSha) { state = { fileSha, ranges: [], servedBy: [] }; session.artifactServedRangeLedger.set(key, state); }
  if (session.artifactServedRangeLedger.size > ARTIFACT_SERVED_RANGE_LEDGER_PATH_CAP) {
    const oldest = session.artifactServedRangeLedger.keys().next().value;
    if (oldest !== undefined && oldest !== key) session.artifactServedRangeLedger.delete(oldest);
  }
  if (!state.ranges.some((r) => r.every((value, i) => value === parsed[i]))) state.ranges.push(parsed);
  if (servedBy !== undefined && !state.servedBy.includes(servedBy)) state.servedBy.push(servedBy);
  if (state.ranges.length > ARTIFACT_SERVED_RANGE_LEDGER_RANGE_CAP) state.ranges.splice(0, state.ranges.length - ARTIFACT_SERVED_RANGE_LEDGER_RANGE_CAP);
  if (state.servedBy.length > ARTIFACT_SERVED_RANGE_LEDGER_PROVENANCE_CAP) state.servedBy.splice(0, state.servedBy.length - ARTIFACT_SERVED_RANGE_LEDGER_PROVENANCE_CAP);
  return { sha: fileSha.slice(0, 12), served: state.ranges.map(artifactRangeText), complete: true, ...(state.servedBy[0] ? { served_by: state.servedBy[0] } : {}) };
}

const SERVED_RANGE_LEDGER_PATH_CAP = 128;
/**
 * Per-file bounds. Both follow the same eviction idiom as the path cap above
 * (drop the OLDEST entries), and both fail SAFE: a dropped cluster or request
 * makes the ledger claim LESS coverage than was actually served, so the worst
 * outcome is one redundant normal serve — never a receipt for bytes the caller
 * does not hold.
 */
const SERVED_RANGE_LEDGER_REQUEST_CAP = 32;
const SERVED_RANGE_LEDGER_CLUSTER_CAP = 64;
/**
 * F2: bound on the UNMERGED per-serve spans. Same drop-the-oldest idiom and
 * the same fail-safe direction — an evicted span is coverage the ledger stops
 * claiming, never coverage it invents.
 */
const SERVED_RANGE_LEDGER_SPAN_CAP = 256;
/**
 * FX-V1 (round-20A finding 1, 2026-09-04): bound on `ServedRangeLedgerState.elided`.
 * Same drop-the-oldest idiom and the same fail-safe direction as the caps
 * above — an evicted elided span costs one redundant `content:"full"` (or
 * `comments:"keep"`) re-serve before a foreign handle admits, never a claim
 * the ledger cannot back.
 */
const SERVED_RANGE_LEDGER_ELISION_CAP = 64;

function mergeServedRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = ranges
    .map(([start, end]) => [start, end] as [number, number])
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged: Array<[number, number]> = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous === undefined || range[0] > previous[1] + 1) {
      merged.push(range);
    } else {
      previous[1] = Math.max(previous[1], range[1]);
    }
  }
  return merged;
}

/**
 * F2: re-derive the merged `ranges` projection from the unmerged `spans`
 * ground truth, applying both caps. Called on every record so the two views
 * can never drift. Cap order matters: spans are trimmed first, then the merged
 * result, and any span left entirely below the surviving cluster floor is
 * dropped too — so `spans` never claims coverage `ranges` no longer reports.
 */
function materializeServedRanges(state: ServedRangeLedgerState): void {
  if (state.spans.length > SERVED_RANGE_LEDGER_SPAN_CAP) {
    state.spans = state.spans.slice(-SERVED_RANGE_LEDGER_SPAN_CAP);
  }
  let merged = mergeServedRanges(
    state.spans.map((span) => [span.start, span.end] as [number, number]),
  );
  if (merged.length > SERVED_RANGE_LEDGER_CLUSTER_CAP) {
    merged = merged.slice(-SERVED_RANGE_LEDGER_CLUSTER_CAP);
    const floor = merged[0]![0];
    state.spans = state.spans.filter((span) => span.end >= floor);
  }
  state.ranges = merged;
}

/**
 * F3: name the call(s) that put `[start,end]` on the wire. Prefers the single
 * span that subsumes the window (the honest common case); otherwise reports
 * the overlapping serves, capped so the label stays ~40 B.
 */
function servedByLabel(
  state: ServedRangeLedgerState,
  start: number,
  end: number,
): string | undefined {
  const exact = state.spans.find((span) => span.start <= start && span.end >= end);
  if (exact !== undefined) return exact.by;
  const labels: string[] = [];
  for (const span of state.spans) {
    if (span.end < start || span.start > end) continue;
    if (!labels.includes(span.by)) labels.push(span.by);
  }
  if (labels.length === 0) return undefined;
  if (labels.length <= 2) return labels.join(" + ");
  return `${labels[0]!} +${labels.length - 1} more`;
}

/** The gaps left between merged served ranges — the complement of `ranges`. */
function unservedServedRanges(
  ranges: ReadonlyArray<readonly [number, number]>,
  totalLines: number,
): string[] {
  const unserved: string[] = [];
  let cursor = 1;
  for (const [rangeStart, rangeEnd] of ranges) {
    if (cursor < rangeStart) unserved.push(`${cursor}-${rangeStart - 1}`);
    cursor = rangeEnd + 1;
  }
  if (cursor <= totalLines) unserved.push(`${cursor}-${totalLines}`);
  return unserved;
}

/**
 * READ-ONLY probe (the query counterpart of recordServedRange, which mutates):
 * is `[startLine,endLine]` of `filePath` already fully covered by content this
 * session served for THIS EXACT `fileSha`? Returns the served-state receipt
 * when yes — the caller already holds those bytes, so the read can answer with
 * a compact `code_unchanged` receipt instead of re-serving identical content.
 *
 * Deliberately CONSERVATIVE — every one of these falls back to a normal serve:
 *  - no ledger entry for the path (nothing was ever served),
 *  - `state.fileSha !== fileSha` (the file changed on disk since that serve;
 *    recordServedRange resets the entry on a sha change, so a stale entry can
 *    never satisfy this),
 *  - PARTIAL overlap — coverage must span the whole request with no uncovered
 *    line inside it.
 *
 * F2 (2026-08-02 serve-honesty): subsumption is decided from the UNMERGED
 * per-serve `spans`, not from the merged `ranges` accumulator, so the property
 * "every receipted line was on some response's wire" is local to one array and
 * cannot be manufactured by an accumulator. Two notes for future readers:
 *
 *  - The merge itself never invented coverage. mergeServedRanges starts a NEW
 *    cluster whenever `range[0] > previous[1] + 1`, i.e. it fuses only spans
 *    that OVERLAP or are exactly adjacent — one skipped line already splits
 *    the cluster. (The investigation spec read that `+ 1` as a one-line gap
 *    TOLERANCE and proposed single-span subsumption on that basis; it is not a
 *    tolerance, and single-span subsumption would have deleted the legitimate
 *    cumulative-coverage receipt that servedReceipts.spec.ts pins.) What
 *    actually manufactured coverage was a DISHONEST span — closed by F1.
 *  - So a gapless chain of honest spans is itself honest, and that is what is
 *    accepted here. The single-span case is still preferred, because it is
 *    what lets the receipt name exactly one source call (F3 `served_by`).
 */
export function servedRangeReceipt(
  workspaceRoot: string,
  filePath: string,
  fileSha: string,
  startLine: number,
  endLine: number,
  totalLines: number,
): ServedRangeLedgerReceipt | undefined {
  const state = getSession(workspaceRoot).servedRangeLedger.get(filePath);
  if (state === undefined || state.fileSha !== fileSha) return undefined;
  const start = Math.max(1, Math.min(totalLines, startLine));
  const end = Math.max(start, Math.min(totalLines, endLine));
  const covered = mergeServedRanges(
    state.spans.map((span) => [span.start, span.end] as [number, number]),
  );
  const subsumed = covered.some(
    ([rangeStart, rangeEnd]) => rangeStart <= start && rangeEnd >= end,
  );
  if (!subsumed) return undefined;
  const unserved = unservedServedRanges(state.ranges, totalLines);
  const servedBy = servedByLabel(state, start, end);
  return {
    sha: fileSha.slice(0, 12),
    served: state.ranges.map(([rangeStart, rangeEnd]) => `${rangeStart}-${rangeEnd}`),
    unserved,
    added_lines: 0,
    requests: state.requests.length,
    clusters: state.ranges.length,
    complete: unserved.length === 0,
    ...(servedBy !== undefined ? { served_by: servedBy } : {}),
  };
}

/**
 * Records file lines that were ACTUALLY PUT ON THE WIRE and returns a compact
 * receipt.
 *
 * F1 (2026-08-02 serve-honesty): every caller must pass what it SERVED, not
 * what was requested. Comment blocks collapsed to a `doc elided L<a>-<b>`
 * marker never reach the caller, so the recording sites split their window
 * with servedSpansOfDisplayedText (util/formatCompress.ts) and call this once
 * per surviving span. Under-recording costs one redundant re-serve;
 * over-recording hands out a `code_unchanged` receipt for bytes nobody ever
 * received.
 */
/**
 * FX-N (ruling (s), 2026-09-03): the lane-scoped SESSION KEYS holding staged
 * serve bookings the funnel has not settled yet.
 *
 * WHY A REGISTRY AND NOT JUST THE CALL'S OWN ROOT. `emit.ts` knows the root
 * dispatch RESOLVED (`ProtocolCallContext.readServeWorkspace`, taken at
 * dispatch entry), but a read whose target is addressed by handle may ADOPT
 * the handle's own mint root part-way through (`server.ts`'s `let workspace`
 * — "the handle IS the workspace pin") and book into THAT session instead.
 * Settling only the entry-time root would leave those spans provisional
 * forever and, worse, would never promote their union/residency — the T09/T10
 * "the gate refuses a handle this server itself served" direction. The
 * registry names exactly the sessions this call actually booked into.
 *
 * KEYS, NOT ROOTS, so the settlement is lane-isolated by construction: an
 * entry is consumed only by a call running in the same lane it was staged in
 * (`sessionKeyFor` re-derives the same composite key iff the lane matches).
 * A key left behind by a THROWN call is therefore not lost to another lane;
 * it is settled by the next response of its own lane, whose corroboration
 * cannot promote a path it did not itself ship.
 */
const _pendingServeSessionKeys = new Set<string>();

/**
 * FX-V1 (round-20A finding 1, ruling (x), 2026-09-04): stage a CANDIDATE
 * elided-line gap for this `recordServedRange` call, keyed to the caller's
 * own (provenance `call`, provenance `range`) pair.
 *
 * WHY THIS DETECTS ELISION AND NOTHING ELSE. Every serve site that can elide
 * doc comments narrows the window it books through
 * `servedSpansOfDisplayedText` (`util/formatCompress.ts`) BEFORE calling
 * `recordServedRange` — one call per surviving (non-elided) span, in
 * increasing line order, all sharing one `beginServeCall` ordinal and one
 * `provenance.range` string naming the FULL window that walk covered (see
 * every booking site: `bookFullFileExpansionServe`, `buildFullServePayload`'s
 * governed-head branch, `readCodeSmallFile.ts`'s small_file serve,
 * `appendFresh`'s ledger-difference fresh windows, `readCodeTaskPack.ts`).
 * Nothing else drops file lines from that walk, so a gap between the
 * window's own start (or the previous shipped span already recorded for the
 * SAME (call, range) pair) and THIS span's start is exactly the lines a
 * `doc elided L<a>-<b>` marker stood in for.
 *
 * KEYED ON (call, range), NOT call ALONE. A single response can book several
 * DIFFERENT windows under one shared `beginServeCall` ordinal — e.g.
 * `buildLedgerDifferenceFullPayload`'s `appendFresh`, called once per FRESH
 * sub-range with one `serveCall` shared across the whole difference payload.
 * The "prior" span between two such fresh windows names bytes an EARLIER call
 * genuinely served (not re-shipped now, but never elided either); mistaking
 * that gap for an elision candidate would be exactly the over-claim ruling
 * (x) forbids. A new (call, range) pair always resets the cursor to that
 * window's own start, so a prior-coverage gap between two fresh windows is
 * never attributed to this window's cursor.
 *
 * WRITTEN OPTIMISTICALLY, RETRACTED ON NON-CONFIRMATION. Exactly like
 * `recordServedRange` itself pushes its own span into `state.spans`
 * immediately (before the funnel knows whether the wire will corroborate
 * it), this writes the gap directly into `state.elided` right away, and ALSO
 * stages it in `session.pendingElidedSpans` so `_settleSessionServeBookings`
 * can RETRACT that exact entry once the finalized wire's corroboration is
 * known — a candidate whose response was shed by a governor/cap/response-size
 * AFTER this call must not survive as a standing elision claim. A direct
 * in-process caller of `recordServedRange` that never runs a funnel (the unit
 * specs) therefore sees the elided claim immediately, exactly as durably as
 * the shipped span it sits beside.
 *
 * No-op when `provenance` is absent or its `range` does not parse as a
 * `"start-end"` pair (the same shape `_parseHandleLineRange` already parses
 * for handle ranges — reused here rather than duplicated) — there is then no
 * window to detect a gap against, and recording nothing is always the safe
 * direction (ruling (x): elided-window coverage is an ADDITIVE write-
 * authority relaxation, never a receipt claim).
 */
function _stageElisionGap(
  session: WorkspaceSession,
  state: ServedRangeLedgerState,
  filePath: string,
  provenance: ServedRangeProvenance | undefined,
  start: number,
  end: number,
): void {
  if (provenance === undefined) return;
  const parsedWindow = _parseHandleLineRange(provenance.range);
  if (parsedWindow === undefined) return;
  const track = state._elisionCursor;
  const cursor = track !== undefined && track.call === provenance.call && track.range === provenance.range
    ? track.next
    : parsedWindow.start;
  if (start > cursor) {
    const gapStart = Math.max(1, Math.min(state.totalLines, cursor));
    const gapEnd = Math.max(gapStart, Math.min(state.totalLines, start - 1));
    // Written OPTIMISTICALLY, exactly like `state.spans.push` a few lines up
    // in `recordServedRange` — a direct in-process caller that never runs a
    // funnel (the unit specs) sees this claim immediately and durably, just
    // like the shipped span it sits beside. `_settleSessionServeBookings`
    // RETRACTS this exact `id` later if the finalized wire never actually
    // corroborates it.
    const id = (session.serveSpanSerial += 1);
    state.elided.push({ start: gapStart, end: gapEnd, id });
    if (state.elided.length > SERVED_RANGE_LEDGER_ELISION_CAP) {
      state.elided = state.elided.slice(-SERVED_RANGE_LEDGER_ELISION_CAP);
    }
    session.pendingElidedSpans.push({ path: filePath, id, start: gapStart, end: gapEnd });
  }
  state._elisionCursor = { call: provenance.call, range: provenance.range, next: Math.max(cursor, end + 1) };
}

export function recordServedRange(
  workspaceRoot: string,
  filePath: string,
  fileSha: string,
  startLine: number,
  endLine: number,
  totalLines: number,
  provenance?: ServedRangeProvenance,
): ServedRangeLedgerReceipt {
  const session = getSession(workspaceRoot);
  const start = Math.max(1, Math.min(totalLines, startLine));
  const end = Math.max(start, Math.min(totalLines, endLine));
  // FX-N (ruling (s), 2026-09-03) — THE UNION/RESIDENCY WRITES MOVED OUT OF
  // THIS FUNCTION, to `settleServedRanges` at the funnel exit.
  //
  // A1 (2026-08-01 signal5-2) established that raw content served for a path
  // grounds a later edit of that path, and FX-L (ruling (r)) added that the
  // served-range ledger IS the "body shipped" proof. Both remain true. What
  // was wrong is WHEN they were asserted: these two statements used to run
  // HERE, while the body was still being assembled — before the budget/cap
  // shed, before the response kind was known, and outside [R5-10]'s
  // corroboration entirely. Round-16 measured the cost end to end: a
  // `read_file … budget:{bytes:300}` that shed to `refusal/cap-exceeded`
  // (ZERO file bytes on the wire) still enrolled the path in the admissible
  // union and marked it `"shipped"`, so the next `edit_file` landed on a file
  // no byte of which had ever been sent (`r16_e`), and an FX-L `withheld`
  // address was laundered to `shipped` by the same byte-free call (`r16_q`).
  //
  // The booking is now STAGED on `pendingServeSpans` alongside the ledger span
  // it comes from, and promoted by `settleServedRanges` only for a path whose
  // spans the FINAL serialized payload actually corroborated. Nothing else
  // about the enrolment changed: same union, same monotone residency, same
  // "a served range grounds the edit" rule — asserted one funnel exit later,
  // from the bytes that left rather than the bytes that were intended.
  _pendingServeSessionKeys.add(sessionKeyFor(workspaceRoot));
  let state = session.servedRangeLedger.get(filePath);
  if (state === undefined || state.fileSha !== fileSha) {
    state = { fileSha, ranges: [], spans: [], requests: [], totalLines, elided: [] };
    session.servedRangeLedger.delete(filePath);
    session.servedRangeLedger.set(filePath, state);
  }
  // Same sha means the same content means the same line count, so this is a
  // no-op refresh for an existing state — assigned unconditionally so the
  // field is never stale for one minted before ND-4 added it.
  state.totalLines = totalLines;
  let previouslyServed = 0;
  for (const [rangeStart, rangeEnd] of state.ranges) {
    const overlapStart = Math.max(start, rangeStart);
    const overlapEnd = Math.min(end, rangeEnd);
    if (overlapStart <= overlapEnd) previouslyServed += overlapEnd - overlapStart + 1;
  }
  const addedLines = end - start + 1 - previouslyServed;
  const request = `${start}-${end}`;
  if (!state.requests.includes(request)) {
    state.requests.push(request);
    if (state.requests.length > SERVED_RANGE_LEDGER_REQUEST_CAP) state.requests.shift();
  }
  // [R5-10]: booked PROVISIONALLY. `settleServedRanges` at the funnel exit
  // keeps this span only if the serialized response actually carried bytes for
  // this path; otherwise it is retracted by id and the lines stay unserved.
  const spanId = (session.serveSpanSerial += 1);
  state.spans.push({
    start,
    end,
    by: provenance !== undefined
      ? `${provenance.mode} ${provenance.range} (call #${provenance.call})`
      : `read ${start}-${end}`,
    id: spanId,
  });
  session.pendingServeSpans.push({ path: filePath, id: spanId, start, end });
  // FX-V1 (round-20A finding 1, ruling (x), 2026-09-04): stage this call's own
  // elision-gap candidate, if any — see `_stageElisionGap`'s doc comment.
  _stageElisionGap(session, state, filePath, provenance, start, end);
  // FX-W3 (ruling (aa), 2026-09-04): stage this call's own TRUE recorded
  // extent for `filePath` — see `WorkspaceSession.pendingRenderedExtent`'s
  // doc comment. `provenance.range` is the caller's OWN declared window (file
  // coordinates, e.g. `1-40` for a whole-file serve, `50-200` for a slice),
  // never the wire's synthesized display range, so a narrow slice's own
  // extent never widens past its own request.
  if (provenance !== undefined) {
    const declaredWindow = _parseHandleLineRange(provenance.range);
    if (declaredWindow !== undefined) {
      const priorExtent = session.pendingRenderedExtent.get(filePath);
      session.pendingRenderedExtent.set(filePath, Math.max(priorExtent ?? 0, declaredWindow.end));
    }
  }
  materializeServedRanges(state);
  while (session.servedRangeLedger.size > SERVED_RANGE_LEDGER_PATH_CAP) {
    const oldest = session.servedRangeLedger.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    session.servedRangeLedger.delete(oldest);
  }
  const unserved = unservedServedRanges(state.ranges, totalLines);
  return {
    sha: fileSha.slice(0, 12),
    served: state.ranges.map(([rangeStart, rangeEnd]) => `${rangeStart}-${rangeEnd}`),
    unserved,
    added_lines: addedLines,
    requests: state.requests.length,
    clusters: state.ranges.length,
    complete: unserved.length === 0,
  };
}

/**
 * Do a payload-declared path and a ledger key name the same file?
 *
 * They usually ARE the same string — both are workspace-relative — but the
 * batch/handles booking site keys by the handle's stored path, which can be
 * absolute. Suffix-tolerant on a separator boundary so an absolute/relative
 * pair still matches; deliberately NOT basename-only, which would let
 * `a/util.ts` corroborate `b/util.ts`. Mismatches fail OPEN (the span is kept,
 * not retracted), so the tolerance costs at most a missed retraction.
 */
function _servePathsMatch(left: string, right: string): boolean {
  const a = left.replace(/\\/g, "/");
  const b = right.replace(/\\/g, "/");
  if (a === b) return true;
  return a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

/**
 * [R5-10], THE LEDGER HALF — "a serve dropped by a cap is UNSERVED and remains
 * discovery-eligible", adjudicated 2026-08-14.
 *
 * Called once per response, from the funnel exit (`protocol/emit.ts`'s
 * `emitFinalizedPayload`, invoked from `protocol/envelope.ts`'s
 * `finalizeProtocolResponse`) with the corroboration read off the FINAL
 * serialized payload. Every span this response booked provisionally is either
 * confirmed or retracted; the pending list is empty on return either way.
 *
 * WHY THE FUNNEL AND NOT THE EMIT SITES. There are nine booking sites across
 * `server.ts` and `features/task-pack/`, and each one books what it INTENDS to
 * serve. Between that intent and the wire sit the governors, the per-task cap,
 * the display elision, the member projection and the response cap — any of
 * which can shed the bytes while the booking stands. Auditing nine sites
 * makes the next one a new defect; deriving the booking from the bytes that
 * actually left makes the class unrepresentable. It is also where P3a's single
 * measurement point sits, which is not a coincidence: "what did this response
 * actually carry" is one question and deserves one answer.
 *
 * SETTLED HERE TOO, SINCE FX-N (ruling (s), 2026-09-03): the admissible-union
 * enrolment (A1, 2026-08-01) and the per-address `"shipped"` residency (FX-L)
 * that `recordServedRange` used to write inline. The older note here read
 * "DELIBERATELY NOT RETRACTED … edit admissibility is grounded in the caller
 * having addressed the path under a live certificate, which a body-less
 * response does not undo". Ruling (s) supersedes that reading: write authority
 * comes from SHIPPED BYTES, and a response that shipped none of a path's bytes
 * grounds nothing about that path.
 *
 * PROMOTION, NOT RETRACTION, is what actually happens — the distinction
 * matters and is what keeps this out of the T09/T10 direction. The writes were
 * never performed at booking time, so this function does not remove anything a
 * previous call established: it promotes exactly the paths THIS response
 * corroborated, and silently drops the staging for the rest. An earlier call
 * that genuinely served a path keeps its union entry and its `"shipped"`
 * residency; a later byte-free refusal neither adds nor withdraws one
 * (ruling (s): "a refusal books nothing and retracts nothing it did not
 * ship").
 */
/**
 * R11 A-5 (independent review, 2026-09-03): the contiguous sub-ranges of
 * `span` that lie within the union of `windows` — `[]` when there is no
 * overlap at all, `[span]` unchanged when `windows` fully cover it, and one
 * or more NARROWER pieces otherwise (a gap between two windows inside the
 * span splits it). Pure and side-effect free so `settleServedRanges` can
 * decide, per span, whether to leave it untouched, retract it outright, or
 * replace it with only what was demonstrably delivered.
 */
function _coveredPiecesOfSpan(
  span: { start: number; end: number },
  windows: ReadonlyArray<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  const overlaps = windows
    .map((w) => ({ start: Math.max(span.start, w.start), end: Math.min(span.end, w.end) }))
    .filter((r) => r.start <= r.end)
    .sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const r of overlaps) {
    const last = merged[merged.length - 1];
    if (last !== undefined && r.start <= last.end + 1) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ start: r.start, end: r.end });
    }
  }
  return merged;
}

export function settleServedRanges(
  workspaceRoot: string,
  corroboration: ServeCorroboration,
  wasShed?: boolean,
): void {
  _pendingServeSessionKeys.delete(sessionKeyFor(workspaceRoot));
  _settleSessionServeBookings(getSession(workspaceRoot), corroboration, wasShed);
}

/**
 * FX-N (ruling (s)): the ONE settlement `protocol/emit.ts` calls, for EVERY
 * response of every kind, once, after the projector has finalized the wire.
 *
 * `primaryRoot` is the root this call's dispatch resolved against
 * (`context.workspace` for an edit, `context.readServeWorkspace` for a
 * read/search); it is settled even when it staged nothing, so an edit keeps
 * its historical `settleServedRanges(context.workspace, …)` behaviour exactly.
 * Every OTHER session key this call booked into — see
 * `_pendingServeSessionKeys` — is settled in the same pass, so there is one
 * booking write per call and no path is ever settled twice.
 */
export function settleServedCallBookings(
  corroboration: ServeCorroboration,
  primaryRoot?: string,
  wasShed?: boolean,
): void {
  const keys: string[] = [];
  const seen = new Set<string>();
  if (primaryRoot !== undefined && primaryRoot !== "") {
    const key = sessionKeyFor(primaryRoot);
    seen.add(key);
    keys.push(key);
  }
  for (const key of [..._pendingServeSessionKeys]) {
    // Lane isolation: a key staged in another lane re-derives to a different
    // composite key here, so it is left for that lane's own funnel exit.
    if (key !== sessionKeyFor(rootOfSessionKey(key))) continue;
    _pendingServeSessionKeys.delete(key);
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  for (const key of keys) {
    _pendingServeSessionKeys.delete(key);
    const session = _sessions.get(key);
    if (session === undefined) continue;
    _settleSessionServeBookings(session, corroboration, wasShed);
  }
}

/** The corroboration `protocol/envelope.ts`'s `servedWindowsOf` produces. */
export interface ServeCorroboration {
  /**
   * True when the response carries served bytes this function cannot
   * attribute to a path (a body-bearing entry with no `path` addressing).
   *
   * FAIL-CLOSED ON AUTHORITY since FX-O1 (ruling (t), 2026-09-03): the
   * response has not proved that any particular file's bytes reached the
   * caller, so it promotes NO path — no admissible-union entry, no `"shipped"`
   * residency. The span half still settles against whatever windows the payload
   * DID attribute, so nothing demonstrably delivered is thrown away and
   * everything uncorroborated is discarded, exactly as on any other response.
   * The old fail-open arm did the opposite in both halves: it kept every span
   * AND promoted every pending path, which made FX-N's own safety argument — "a key left
   * behind by a THROWN call is settled by the next response of its own lane,
   * whose corroboration cannot promote a path it did not itself ship" — false
   * for exactly the responses that took it: a staged residue for a file no
   * byte of which was ever sent became `"shipped"` on the next unattributed
   * response and unlocked `edit_file` (round-17 finding 2).
   *
   * The cost the old comment feared (re-serving bytes the caller holds) is
   * paid by nothing in production: the two shapes that reached this arm —
   * `mode=symbol`'s assembled scope view and `mode=auto`'s small-content serve
   * — now publish `ProtocolCallContext.serveAttributionPath` at their staging
   * sites, so `protocol/envelope.ts` attributes their bodies and this flag is
   * unreachable for a shipped body. A future shape that IS unattributable is
   * refused write authority rather than granted it on a guess.
   */
  unattributed: boolean;
  /** Body-bearing line windows the serialized payload declared. */
  windows: ReadonlyArray<{ path: string; start: number; end: number }>;
}

function _settleSessionServeBookings(
  session: WorkspaceSession,
  corroboration: ServeCorroboration,
  // FX-W3 (ruling (aa), 2026-09-04): true iff `emit.ts`'s ladder performed
  // ANY wire-level shedding on this response. Defaults to the CONSERVATIVE
  // (narrow-only) direction so every pre-existing direct caller of
  // `settleServedRanges`/`settleServedCallBookings` (the unit specs that hand-
  // build a `ServeCorroboration` and know nothing of this parameter) keeps its
  // exact prior behavior. See `pendingRenderedExtent`'s doc comment for why
  // this is the ONLY signal allowed to widen a window past what the wire
  // declared, and only ever a window this response's OWN corroboration
  // already produced for that path.
  wasShed: boolean = true,
): void {
  const pending = session.pendingServeSpans;
  // FX-V1: a pending elided candidate can only ever be staged ALONGSIDE a
  // pending span from the SAME `recordServedRange` call (see
  // `_stageElisionGap`), so `pending.length === 0` implies no elided
  // candidate is pending either — but the OR guard costs nothing and keeps
  // this function correct even if that invariant ever loosens.
  if (pending.length === 0 && session.pendingElidedSpans.length === 0) return;
  session.pendingServeSpans = [];
  // FX-O1 (ruling (t), 2026-09-03) — FAIL CLOSED ON AUTHORITY. An
  // unattributable response cannot prove that any particular file's bytes
  // reached the caller, so it promotes NOTHING: no admissible-union entry, no
  // `"shipped"` residency. The span half still settles against whatever windows
  // the payload DID attribute, so a span this response demonstrably carried
  // keeps its receipt and the residue — anything the payload does not
  // corroborate, including a staging left behind by a call that threw before
  // the funnel — is discarded exactly as it is on any other response.
  //
  // The old arm did the opposite in both halves: it kept every span AND
  // promoted every pending path, which made FX-N's safety note ("a key left
  // behind by a THROWN call … is settled by the next response of its own lane,
  // whose corroboration cannot promote a path it did not itself ship") false
  // for the responses that took it. See `ServeCorroboration.unattributed`.
  //
  // FX-W3 (ruling (aa)): a window `servedWindowsOf` ALREADY attributed to a
  // path is widened to this response's own recorded TRUE extent for that
  // SAME path (`pendingRenderedExtent`), but ONLY when nothing was shed. This
  // NEVER manufactures a window for a path the wire's own walk did not
  // attribute at all (the `windows.map` below only ever touches an EXISTING
  // entry), so a stale `pendingRenderedExtent` entry left by an unrelated
  // thrown call can widen nothing this response's own corroboration does not
  // already mention — the same residue-safety `unattributed` already
  // provides for `windows` itself.
  const renderedExtent = session.pendingRenderedExtent;
  session.pendingRenderedExtent = new Map();
  const windows = wasShed || renderedExtent.size === 0
    ? corroboration.windows
    : corroboration.windows.map((window) => {
        const extentEnd = renderedExtent.get(window.path);
        return extentEnd !== undefined && extentEnd > window.end
          ? { ...window, end: extentEnd }
          : window;
      });

  // FX-N: paths at least one of whose spans the FINAL payload corroborated.
  // A partially-carried span still counts — the caller demonstrably holds
  // bytes of that file, which is the whole question the union/residency pair
  // answers (they are per-FILE, not per-line; the per-line claim is the
  // ledger's own, settled span by span below).
  const shippedPaths = new Set<string>();
  const retractedByPath = new Map<string, Set<number>>();
  const narrowedByPath = new Map<string, Array<{ start: number; end: number; by: string }>>();
  for (const span of pending) {
    // CONTAINMENT, not intersection (R11 A-5, independent review 2026-09-03).
    // The emitters already narrow each span to the marker-free text they put
    // on the wire (`servedSpansOfDisplayedText`), so in the ordinary
    // (elision-only) case the corroborated window equals the booked span
    // exactly and nothing below changes anything — this stays a no-op for
    // that case, which is what the old any-overlap rule was actually trying
    // to protect. But a LATER stage (a governor, a per-task cap, the response
    // cap) can shed bytes AFTER the span was booked, independent of that
    // narrowing: then the corroborated window is a strict SUBSET of the
    // booked span, and the old rule kept the span WHOLE on any overlap at
    // all — a span booked 1-40 whose serve was shed to 1-20 stayed booked as
    // 1-40, so a later request for 21-40 answered from a ledger claiming
    // bytes that were never delivered. Book only what the windows actually
    // cover instead: fully carried spans are untouched; a partially-carried
    // span is retracted and replaced by narrower spans naming only the
    // delivered sub-range(s); a span with no overlap at all is retracted
    // outright, exactly as before.
    const matchingWindows = windows.filter((window) =>
      _servePathsMatch(window.path, span.path));
    const covered = _coveredPiecesOfSpan(span, matchingWindows);
    if (covered.length > 0) shippedPaths.add(span.path);
    if (covered.length === 1 && covered[0]!.start === span.start && covered[0]!.end === span.end) {
      continue; // fully carried — unchanged, byte-identical to the old rule's outcome here.
    }
    let ids = retractedByPath.get(span.path);
    if (ids === undefined) { ids = new Set(); retractedByPath.set(span.path, ids); }
    ids.add(span.id);
    if (covered.length > 0) {
      const originalBy = session.servedRangeLedger.get(span.path)?.spans
        .find((s) => s.id === span.id)?.by ?? `read ${span.start}-${span.end}`;
      let pieces = narrowedByPath.get(span.path);
      if (pieces === undefined) { pieces = []; narrowedByPath.set(span.path, pieces); }
      for (const piece of covered) pieces.push({ start: piece.start, end: piece.end, by: originalBy });
    }
  }

  for (const [path, ids] of retractedByPath) {
    const state = session.servedRangeLedger.get(path);
    if (state === undefined) continue;
    const kept = state.spans.filter((span) => !ids.has(span.id));
    const narrowed = narrowedByPath.get(path) ?? [];
    if (kept.length === state.spans.length && narrowed.length === 0) continue;
    if (kept.length === 0 && narrowed.length === 0) {
      // Nothing this session ever put on the wire for this path survives, so
      // the entry itself is the claim to delete — an emptied state would pin
      // `fileSha` and make a later serve of a CHANGED file look like a
      // sha-reset rather than the first serve it is.
      session.servedRangeLedger.delete(path);
      continue;
    }
    state.spans = kept;
    for (const piece of narrowed) {
      state.spans.push({
        start: piece.start,
        end: piece.end,
        by: piece.by,
        id: (session.serveSpanSerial += 1),
      });
    }
    materializeServedRanges(state);
  }

  // FX-V1 (round-20A finding 1, ruling (x), 2026-09-04): RETRACT this
  // response's staged elision-gap candidates that the finalized wire does not
  // corroborate, under the SAME `windows` the spans above were just judged
  // against. `_stageElisionGap` already wrote each candidate directly into
  // its `ServedRangeLedgerState.elided` (optimistic, exactly like
  // `state.spans.push` above) — this is the retraction half, not the write.
  //
  // FULL containment only — never narrowed like a shipped span. A shipped
  // span narrows sensibly (a partially-delivered span still names bytes the
  // caller genuinely holds for the delivered sub-range), but a PARTIALLY
  // confirmed elision gap is not a coherent claim: either the response's
  // finalized wire demonstrably reaches all the way across the gap (proving
  // the marker that stands for it really rode the wire), or it does not and
  // the candidate must be retracted outright. `corroboration.unattributed`
  // fails this closed exactly like the shipped-span half above — an
  // unattributable response proves no particular file's bytes reached the
  // caller, so every pending elision claim is retracted.
  const pendingElided = session.pendingElidedSpans;
  if (pendingElided.length > 0) {
    session.pendingElidedSpans = [];
    const retractedElidedByPath = new Map<string, Set<number>>();
    for (const candidate of pendingElided) {
      let confirmed = false;
      if (!corroboration.unattributed) {
        const matchingWindows = windows.filter((window) =>
          _servePathsMatch(window.path, candidate.path));
        const covered = _coveredPiecesOfSpan(candidate, matchingWindows);
        confirmed = covered.length === 1
          && covered[0]!.start === candidate.start
          && covered[0]!.end === candidate.end;
      }
      if (confirmed) continue;
      let ids = retractedElidedByPath.get(candidate.path);
      if (ids === undefined) { ids = new Set(); retractedElidedByPath.set(candidate.path, ids); }
      ids.add(candidate.id);
    }
    for (const [path, ids] of retractedElidedByPath) {
      const state = session.servedRangeLedger.get(path);
      // A path deleted above (nothing this session ever shipped for it
      // survived settlement) has no entry left to retract from anyway.
      if (state === undefined) continue;
      state.elided = state.elided.filter((entry) => !ids.has(entry.id));
    }
  }

  // FX-O1: an unattributable response promotes nothing — see the note at the
  // head of this function. The ledger half above has already settled.
  _promoteStagedServeBookings(session, corroboration.unattributed ? new Set<string>() : shippedPaths);
}

/**
 * FX-N (ruling (s)): the promotion half of the settlement — the ONLY place a
 * raw read's admissible-union enrolment and `"shipped"` byte residency are
 * written, and it runs from the finalized wire.
 *
 * The two writes are exactly the pair `recordServedRange` used to perform
 * inline (A1's `_appendAdmissible` and FX-L's `_markEditResidency`), with
 * identical semantics: de-duplicated, FIFO-capped, monotone toward `shipped`.
 * `_markEditResidency` will not overwrite an existing `"shipped"`, and a path
 * marked `"withheld"` earlier in THIS call by the pack booking pass
 * (`recordWithheldEditAddresses`) is only reachable here if the same call also
 * put a body for that path on the wire — in which case `"shipped"` is the
 * honest answer and the pack pass already wrote it. A byte-free response
 * reaches this function with an EMPTY set, which is what closes round-16
 * finding 1c: the `withheld → shipped` laundering path no longer exists.
 */
function _promoteStagedServeBookings(session: WorkspaceSession, paths: ReadonlySet<string>): void {
  if (paths.size === 0) return;
  const list = [...paths];
  _appendAdmissible(session.admissibleEditPaths, list);
  _markEditResidency(session.editPathResidency, list, "shipped");
}

// ---------------------------------------------------------------------------
// B2 / V12-02 — DELTA CONTEXT (TL_DELTA_CONTEXT, default OFF)
// ---------------------------------------------------------------------------

/**
 * The one hunk an edit this server applied actually produced, in PRE-edit file
 * line coordinates. Derived from the before/after BYTES by
 * `write/deltaContext.ts`'s `computeEditHunkGeometry` — never from replaying
 * the caller's `search`/`replace` strings, which recover across escaping and
 * indentation drift and therefore do not name the lines that changed.
 */
export interface ServedRangeEditHunk {
  /**
   * First PRE-edit line NOT covered by the common prefix (1-based). Every line
   * strictly below it is byte-identical in the post-edit file AT THE SAME
   * INDEX — that identity is what makes a surviving span honest.
   */
  preStart: number;
  /**
   * Last PRE-edit line NOT covered by the common suffix (1-based). Every line
   * strictly above it is byte-identical in the post-edit file at index+`delta`.
   * `preEnd === preStart - 1` denotes a PURE INSERTION (nothing was replaced).
   */
  preEnd: number;
  /** postLineCount - preLineCount. */
  delta: number;
}

/** One surviving piece of a span, after the hunk is applied to it. */
interface TransformedPiece {
  start: number;
  end: number;
}

/**
 * Project one PRE-edit span through `hunk`, returning the pieces whose bytes
 * are PROVABLY unchanged and where they now live.
 *
 * THE WHOLE SAFETY ARGUMENT, IN THREE LINES:
 *   - lines `< hunk.preStart` are the common PREFIX: identical, same index;
 *   - lines `> hunk.preEnd` are the common SUFFIX: identical, index + delta;
 *   - everything between is the change itself, and is DROPPED.
 * Nothing else is claimed. A span straddling the hunk is TRUNCATED to its
 * surviving head/tail rather than kept whole (which would claim changed bytes)
 * or dropped whole (which would throw away the head of a fully-read file — the
 * case the lever exists for). Truncation cannot mis-map: the two facts above
 * are byte identities established by `computeEditHunkGeometry` from the actual
 * texts, so a kept piece names bytes the caller demonstrably still holds.
 *
 * SYMBOL/SECTION INTEGRITY. Spans are FILE-LINE claims, not symbol claims —
 * mode=symbol's assembled view is already modelled back into file lines at its
 * recording site — so a truncated span never splits a symbol "ambiguously": it
 * names fewer lines, each still byte-exact. Where a piece would be empty or
 * inverted it is simply not emitted, which is the invalidation this contract
 * prefers over any inferred mapping.
 */
function transformSpanAcrossHunk(
  start: number,
  end: number,
  hunk: ServedRangeEditHunk,
): TransformedPiece[] {
  const pieces: TransformedPiece[] = [];
  // Head: the part of the span strictly below the change — unmoved.
  const headEnd = Math.min(end, hunk.preStart - 1);
  if (start <= headEnd) pieces.push({ start, end: headEnd });
  // Tail: the part strictly above the change — shifted by the net line delta.
  const tailStart = Math.max(start, hunk.preEnd + 1);
  if (tailStart <= end) {
    pieces.push({ start: tailStart + hunk.delta, end: end + hunk.delta });
  }
  return pieces;
}

/**
 * B2 / V12-02: re-project the served-range ledger entry for `relPath` across an
 * edit THIS SERVER just applied, so a post-edit re-read serves only what
 * actually changed.
 *
 * Returns a summary when it transformed an entry, `undefined` when it did not
 * (no entry, or the entry describes a different sha than the bytes that were
 * replaced). `beforeSha` is a PRECONDITION, not a hint: the entry is touched
 * only when it demonstrably describes the exact pre-edit content, which is what
 * makes this safe to call from the write seam without knowing which read path
 * booked the spans.
 *
 * ONLY SERVER-APPLIED HUNKS REACH HERE. The single caller is
 * `write/atomicWrite.ts`'s `writeExistingFileAtomic`, AFTER its rename has
 * succeeded — the narrowest seam every existing-file edit, intent and
 * rollback-restore funnels through. A write that threw never transforms
 * (the old bytes are still on disk and the old entry still describes them); an
 * EXTERNAL write never transforms (nothing calls this), and the sha it leaves
 * behind no longer matches the entry, so the ordinary sha-mismatch fallback
 * serves the full body.
 *
 * A rollback-restore is itself a write through the same seam, so it transforms
 * in reverse and the ledger tracks the bytes on disk either way; because the
 * changed region is dropped in BOTH directions, the composition is always a
 * subset of what is honestly held, never a superset.
 */
export function transformServedRangesAcrossServerEdit(
  workspaceRoot: string,
  relPath: string,
  beforeSha: string,
  afterSha: string,
  afterTotalLines: number,
  hunk: ServedRangeEditHunk,
): { kept: number; dropped: number; shifted: number; heldLines: number } | undefined {
  const session = getSession(workspaceRoot);
  const state = session.servedRangeLedger.get(relPath);
  if (state === undefined || state.fileSha !== beforeSha) return undefined;

  // A PRE-EDIT BOOKING CANNOT BE ADJUDICATED BY A POST-EDIT RESPONSE.
  //
  // `settleServedRanges` is contracted to run once per response against that
  // response's own windows. FX-N (ruling (s), 2026-09-03) made that true: the
  // funnel now settles for the read family as well, keyed on
  // `ProtocolCallContext.readServeWorkspace`. Until then the guard was
  // `context.workspace`, written only by the EDIT path (`finishEdit`'s
  // `noteWorkspaceRoot`), so a read's provisional spans stayed pending and were
  // settled against the NEXT EDIT's payload — and an `edit.applied` declares no
  // addressed body window at all (`applied[].head` is a string ARRAY, so
  // `servedWindowsOf` books nothing), which silently deleted the head of every
  // carried ledger here (reproduced 2026-08-27; reported then as an independent
  // defect, since with the sha reset it is otherwise invisible). That
  // cross-response leak is closed; what remains, and is what this block is
  // about, is a span still pending from a call that THREW before reaching the
  // funnel.
  //
  // Retracting THIS path's pending spans is not something this function can
  // decide honestly, and neither is confirming them; what it can say is that
  // pre-edit coordinates no longer describe the file. So they are DISCHARGED:
  // removed from the pending list without touching the spans they refer to,
  // which are re-projected below on their own merits. Flag-gated by the sole
  // caller, so nothing changes while TL_DELTA_CONTEXT is off.
  if (session.pendingServeSpans.length > 0) {
    session.pendingServeSpans = session.pendingServeSpans
      .filter((span) => !_servePathsMatch(span.path, relPath));
  }

  let dropped = 0;
  let shifted = 0;
  const kept: ServedRangeSpan[] = [];
  for (const span of state.spans) {
    const pieces = afterTotalLines >= 1
      ? transformSpanAcrossHunk(span.start, span.end, hunk)
      : [];
    if (pieces.length === 0) {
      dropped += 1;
      continue;
    }
    if (pieces.length > 1 || pieces[0]!.start !== span.start || pieces[0]!.end !== span.end) {
      shifted += 1;
    }
    pieces.forEach((piece, index) => {
      // Clamp defensively against the POST-edit file. The identities above
      // already keep every piece in range; a clamp costs nothing and makes a
      // future geometry bug an under-claim rather than a receipt for lines the
      // file does not have.
      const pieceStart = Math.max(1, Math.min(afterTotalLines, piece.start));
      const pieceEnd = Math.max(pieceStart, Math.min(afterTotalLines, piece.end));
      kept.push({
        start: pieceStart,
        end: pieceEnd,
        // The provenance label names the CALL that put these bytes on the wire
        // and the window it was asked for. Both remain true — the bytes are the
        // same bytes — so the label rides through verbatim rather than being
        // rewritten with post-edit coordinates it never described.
        by: span.by,
        // [R5-10] identity must stay UNIQUE: a straddling span splits into two
        // pieces, and reusing one id for both would let a single retraction
        // delete a piece the response did corroborate. The head keeps the
        // original id (so a retraction still pending from this call finds it);
        // each further piece mints its own.
        id: index === 0 ? span.id : (session.serveSpanSerial += 1),
      });
    });
  }

  if (kept.length === 0) {
    // Same reasoning as settleServedRanges': an emptied state would pin a sha
    // and make the next serve look like a reset instead of the first serve of
    // this content that it is.
    session.servedRangeLedger.delete(relPath);
    return { kept: 0, dropped, shifted, heldLines: 0 };
  }

  state.fileSha = afterSha;
  state.totalLines = afterTotalLines;
  state.deltaFromSha = beforeSha;
  state.spans = kept;
  // FX-V1 (round-20A finding 1, 2026-09-04): discard rather than re-project.
  // `elided` spans are only ever trusted for the WRITE-AUTHORITY coverage
  // predicate (`_foreignHandleRangeCovered`), never a receipt, but an
  // unshifted elided span surviving a line-count-changing edit could still
  // land on the WRONG post-edit lines and over-claim coverage there — a
  // hazard `spans` avoids by being explicitly re-projected through the same
  // hunk above. Re-projecting `elided` too would need the identical
  // transform-and-clamp machinery for a claim that only ever saves one
  // re-serve; discarding it is the fail-safe direction this whole ledger
  // already follows (under-claiming costs a redundant serve, never a false
  // admission), and it naturally re-populates on the next elided serve of the
  // post-edit content.
  state.elided = [];
  state._elisionCursor = undefined;
  materializeServedRanges(state);
  const heldLines = state.ranges.reduce((sum, [start, end]) => sum + (end - start + 1), 0);
  return { kept: state.spans.length, dropped, shifted, heldLines };
}

/**
 * B2 / V12-02: does this session hold ANY served-range claim for `relPath`?
 *
 * The write seam's arming check. It is deliberately sha-BLIND: the seam asks
 * before the write, when it is about to decide whether reading the pre-edit
 * bytes is worth a syscall, and `transformServedRangesAcrossServerEdit` does
 * the authoritative sha check afterwards.
 */
export function hasServedRangeLedgerEntry(workspaceRoot: string, relPath: string): boolean {
  return getSession(workspaceRoot).servedRangeLedger.has(relPath);
}

/**
 * W-BATCH-HINT (TL_BATCH_HINTS, DESIGN-v0.15-sf-turn-economy.md §3): how many
 * distinct served-range CLUSTERS (`ServedRangeLedgerState.ranges`, already
 * merged by `materializeServedRanges`) this session holds for `relPath` right
 * now — independent of whether any of them covers a particular new request.
 * Pure read accessor over the same ledger DC3 designates as the single
 * authority for byte-residency claims: never mutates, never invents a
 * cluster the ledger does not already report. Used only to detect "this is
 * the 2nd distinct slice/symbol read of this path this session" (exactly one
 * cluster existed before the call that is about to add a 2nd) without a
 * second, competing counter.
 */
export function servedClusterCount(workspaceRoot: string, relPath: string): number {
  return getSession(workspaceRoot).servedRangeLedger.get(relPath)?.ranges.length ?? 0;
}

/**
 * W-BATCH-HINT sibling of `servedClusterCount`: the held clusters themselves,
 * spelled in the wire's `"<start>-<end>"` dialect, oldest-serve-first. Used
 * only to NAME already-held spans in `READ_BATCH_HINT_TEXT` — never to decide
 * whether to serve fewer bytes (that stays `coverageReceiptFor`'s job, gated
 * separately by `TL_RECEIPT_COVERAGE`).
 */
export function servedClusterRanges(workspaceRoot: string, relPath: string): string[] {
  const state = getSession(workspaceRoot).servedRangeLedger.get(relPath);
  return state === undefined ? [] : state.ranges.map(([start, end]) => `${start}-${end}`);
}

/**
 * B2 / V12-02: what a read should do about this path's delta-derived ledger
 * entry, given the sha of the bytes ACTUALLY on disk right now.
 *
 *   `"carried"` — the entry survived a server edit and still describes the disk
 *                 (`ServedRangeLedgerState.deltaFromSha` present, shas agree).
 *                 This is the ONLY value any delta-serving branch acts on, so
 *                 no branch can fire on an entry the transformation never
 *                 touched — which is what keeps TL_DELTA_CONTEXT from widening
 *                 TL_OVERLAP_TRIM's scope, or vice versa.
 *   `"dropped"` — THE BASE-MISMATCH FALLBACK: something outside this server
 *                 wrote the file after the transformation, so the entry is
 *                 deleted here and the caller serves the full body.
 *                 `servedRangeCoverage` would already answer "no claim" on the
 *                 sha mismatch; deleting makes it final, so a later revert to
 *                 the same bytes cannot resurrect a projection whose provenance
 *                 chain now has a hole in it.
 *   `undefined` — nothing delta-derived here; the caller's ordinary
 *                 (TL_OVERLAP_TRIM / receipt / full-serve) logic decides.
 */
export function deltaLedgerStatus(
  workspaceRoot: string,
  relPath: string,
  diskSha: string,
): "carried" | "dropped" | undefined {
  const session = getSession(workspaceRoot);
  const state = session.servedRangeLedger.get(relPath);
  if (state === undefined || state.deltaFromSha === undefined) return undefined;
  if (state.fileSha === diskSha) return "carried";
  session.servedRangeLedger.delete(relPath);
  return "dropped";
}

/**
 * Records an allowFull=true full-content expansion. Called by
 * fullGovernor.ts's allowFull branch ALONGSIDE recordFullExpansion; the two
 * counters track independent budgets (ALLOWFULL_TASK_CAP vs
 * PER_TASK_FULL_CAP) and neither reset/decay affects the other.
 */
export function recordAllowFullExpansion(workspaceRoot: string): void {
  const s = getSession(workspaceRoot);
  s.allowFullExpansionsTotal += 1;
}

/**
 * F3: claim the next serve-call ordinal for this session. Call ONCE per
 * response that is about to record served ranges, then pass the same ordinal
 * into every recordServedRange the response makes, so a multi-window batch
 * reads as one call in the `served_by` label rather than N.
 */
export function beginServeCall(workspaceRoot: string): number {
  const s = getSession(workspaceRoot);
  s.serveCallSerial += 1;
  return s.serveCallSerial;
}

/**
 * Records a task_pack's structured checks under the CHECK-EPOCH model (see
 * PackChecksState). Decides among START / MERGE / REPLACE from token overlap
 * between `query` and the active epoch:
 *
 *  - No existing epoch → START it (store query + tokens + records).
 *  - Non-empty query with ≥1 token overlap with the epoch → MERGE: union the
 *    records BY ID (existing records are KEPT even when absent from this pack —
 *    this is the closure-wipe fix), extend epochTokens, and PRESERVE
 *    lastOpenIds (a follow-up pack must not reset the open→satisfied tracker).
 *  - Non-empty query with ZERO token overlap → REPLACE (a genuinely new task in
 *    the same session; stale checks must not haunt it) and reset lastOpenIds.
 *  - Empty/undefined query (seeded/queryless pack) → NEVER replace: MERGE into
 *    the current epoch, or START one with epochQuery:"" if none exists.
 *
 * `records` must be the FULL computed record set (the caller passes it BEFORE
 * any response trimming — session state is independent of what the wire
 * response dropped for size).
 */
export function recordPackChecks(
  workspaceRoot: string,
  query: string,
  records: PackCheckRecord[],
): void {
  const s = getSession(workspaceRoot);
  const incomingTokens = tokenizeForEpoch(query ?? "");
  const hasQuery = incomingTokens.length > 0;
  const existing = s.packChecks;

  // START: first pack for this workspace (or after a reset).
  if (existing === undefined) {
    s.packChecks = {
      epochQuery: query ?? "",
      epochTokens: incomingTokens,
      checks: [...records],
      lastOpenIds: [],
    };
    return;
  }

  // REPLACE only for a genuinely-new NON-EMPTY query with zero overlap. A
  // queryless pack (no significant tokens) can NEVER trigger replace.
  const shouldReplace = hasQuery && !_tokensOverlap(incomingTokens, existing.epochTokens);
  if (shouldReplace) {
    s.packChecks = {
      epochQuery: query ?? "",
      epochTokens: incomingTokens,
      checks: [...records],
      lastOpenIds: [],
    };
    return;
  }

  // MERGE (overlap, OR a queryless pack): union records by id, keeping the
  // existing ones even when this pack omitted them; preserve lastOpenIds.
  existing.checks = _mergeCheckRecords(existing.checks, records, existing.lastOpenIds);
  existing.epochTokens = _unionTokens(existing.epochTokens, incomingTokens);
  // epochQuery stays the query that OPENED the epoch (do not overwrite it —
  // it labels the task). A queryless open keeps epochQuery:"".
}

/** Returns the latest task_pack checks state, or undefined if no pack ran. */
export function getPackChecks(workspaceRoot: string): PackChecksState | undefined {
  return getSession(workspaceRoot).packChecks;
}

/**
 * Stores the check ids reported open by the current edit_code response and
 * returns the PREVIOUS report's ids, so the caller can detect the
 * open→satisfied transition (report "all checks satisfied" exactly once).
 * No-op (returns []) when no pack checks exist.
 */
export function recordClosureReport(
  workspaceRoot: string,
  openIds: string[],
): string[] {
  const s = getSession(workspaceRoot);
  if (s.packChecks === undefined) return [];
  const prev = s.packChecks.lastOpenIds;
  s.packChecks.lastOpenIds = [...openIds];
  return prev;
}

/** Consecutive-open-identity threshold at which the escalation note fires once — see recordClosureOpenStreak. */
export const CLOSURE_ESCALATION_THRESHOLD = 5;

/**
 * Escalation (2026-07-12c ignored-open-check forensics): the SAME wiring check was
 * reported open on 7-8 consecutive edit_code responses and the agent
 * concluded anyway. Call on EVERY closure-bearing attachClosure evaluation
 * (an active pack with >=1 verifiable check — computeClosureState's
 * `total > 0`), passing the CURRENT open check-id set — including the empty
 * case (all checks satisfied), which is exactly what resets the run when a
 * check closes. Mirrors the one-shot-hint SHAPE recordSingleEditCompletion /
 * recordSingleFindCompletion use (a counter plus a one-shot fired flag), but
 * — unlike those plain call counters — this one tracks IDENTITY continuity:
 * a same-id-set streak, not merely "N calls happened".
 *
 *  - `openIds` empty → the run resets: closureOpenStreak -> 0,
 *    closureOpenStreakIds -> []. closureEscalationFired is NOT touched — a
 *    session that already escalated once stays escalated for the rest of
 *    the session even after the check that triggered it closes.
 *  - `openIds` non-empty and shares >=1 id with the previous snapshot
 *    (closureOpenStreakIds) → continuing run: closureOpenStreak += 1.
 *  - `openIds` non-empty but shares NO id with the previous snapshot → a
 *    fresh, unrelated run starts: closureOpenStreak -> 1 (e.g. the
 *    previously-tracked check closed in the SAME call that a different,
 *    unrelated check first opened — the two must not chain into one run).
 *  - closureOpenStreakIds is always replaced with the current `openIds`
 *    afterward, so the NEXT call compares against THIS one.
 *
 * A failed/refused edit, or a session with no pack (or a pack with zero
 * verifiable checks), never calls this at all — attachClosure returns
 * before reaching the closure computation in both cases — so those do not
 * break continuity (they are simply absent from the "consecutive" count,
 * neither extending nor resetting the run) and a session with no closure
 * checks can never escalate (closureOpenStreak/closureEscalationFired stay
 * at their zero/false defaults forever).
 *
 * Returns true exactly once per session: the call where closureOpenStreak
 * first reaches CLOSURE_ESCALATION_THRESHOLD while closureEscalationFired is
 * still false. Every other call — before the threshold, after it has
 * already fired once, or on an empty `openIds` — returns false.
 */
export function recordClosureOpenStreak(workspaceRoot: string, openIds: readonly string[]): boolean {
  const s = getSession(workspaceRoot);
  if (openIds.length === 0) {
    s.closureOpenStreak = 0;
    s.closureOpenStreakIds = [];
    // 2026-07-25: "all checks satisfied" is the certified task's completion
    // signal — release a verifying fence so follow-up work is not refused
    // after the edit is proven done (T13-rep0: closure never cleared the
    // verify gate and every subsequent edit was refused).
    if (s.executionFence?.phase === "verifying") s.executionFence.phase = "done";
    return false;
  }
  const prevIds = new Set(s.closureOpenStreakIds);
  const continuing = openIds.some((id) => prevIds.has(id));
  s.closureOpenStreak = continuing ? s.closureOpenStreak + 1 : 1;
  s.closureOpenStreakIds = [...openIds];
  if (s.closureOpenStreak >= CLOSURE_ESCALATION_THRESHOLD && !s.closureEscalationFired) {
    s.closureEscalationFired = true;
    return true;
  }
  return false;
}

/** Records a workspace-relative path successfully written by edit_code. */
export function recordEditedPath(workspaceRoot: string, path: string): void {
  const session = getSession(workspaceRoot);
  session.editedPaths.add(path);
  // A successful write IS the candidate choice — release the candidate-pack
  // full-read brake (see WorkspaceSession.candidatePackPending).
  session.candidatePackPending = false;
  session.candidatePackFullReads = 0;
  // L2 (2026-08-08 find-honesty): a write invalidates the ledger's premise —
  // "every match is already in your context" cannot be asserted across bytes
  // this session just changed. Same freshness rule the discovery brake's
  // signature map obeys (see ExecutionFenceState.discoverySignatures).
  session.servedFindLedger = undefined;
  // TL_SEARCH_DEDUP (W-T-D): same freshness rule again, for the search-dedup
  // ledger — "this exact search already ran with no write since" can no
  // longer be asserted. Bumping the counter (rather than clearing the map
  // outright) lets each entry self-invalidate lazily at lookup time.
  session.writeEventSerial += 1;
}

/**
 * Arms the 2026-07-19a candidate-pack full-read brake: the just-served task
 * pack is a candidate-list partial, so broad full reads are capped at
 * CANDIDATE_PACK_FULL_CAP (fullGovernor.ts) until the choice lands (an edit),
 * a non-candidate pack replaces it, or taskEpoch:"new" opens a new task.
 */
export function recordCandidateListPack(workspaceRoot: string): void {
  const session = getSession(workspaceRoot);
  session.candidatePackPending = true;
  session.candidatePackFullReads = 0;
}

/** Releases the candidate-pack brake (non-candidate pack / new epoch). */
export function clearCandidateListPack(workspaceRoot: string): void {
  const session = getSession(workspaceRoot);
  session.candidatePackPending = false;
  session.candidatePackFullReads = 0;
}

/** True while a candidate-list pack's choice is still pending. */
export function isCandidateListPackPending(workspaceRoot: string): boolean {
  return getSession(workspaceRoot).candidatePackPending;
}

/** Counts a broad full read served while the candidate-pack brake is armed. */
export function recordCandidatePackFullRead(workspaceRoot: string): void {
  const session = getSession(workspaceRoot);
  if (session.candidatePackPending) session.candidatePackFullReads += 1;
}

/** Returns the workspace-relative paths edited this session. */
export function getEditedPaths(workspaceRoot: string): string[] {
  return [...getSession(workspaceRoot).editedPaths];
}

/** Max concern-anchor tokens retained per session (Guard 2); FIFO-evicted. */
export const MAX_CONCERN_TOKENS = 24;

/**
 * Guard 2 (2026-07-12b): appends a query's concern-anchor tokens (see
 * WorkspaceSession's concernTokens doc) to the session's rolling set.
 * Lowercases, dedupes (skips a token already present rather than reordering
 * it), and evicts the OLDEST token once the set exceeds MAX_CONCERN_TOKENS.
 * A no-op for an empty token list, so a queryless/unproductive harvest costs
 * nothing.
 */
export function recordConcernTokens(workspaceRoot: string, tokens: readonly string[]): void {
  if (tokens.length === 0) return;
  const s = getSession(workspaceRoot);
  for (const raw of tokens) {
    const t = raw.toLowerCase();
    // W9 backstop (root-leak forensics): significantQueryTokens /
    // concreteIdentifierTokens / compactCodeTerms already enforce their own
    // length floors (>=3) before a token ever reaches here, but the
    // search_files find `queries[]` feeder records entries VERBATIM with no
    // floor of its own (see server.ts's dispatchTool). A stray 1-2 char or
    // purely-numeric token carries no locate-able concern either way, so
    // drop it here once, for every feeder, rather than duplicating the
    // check at each call site.
    if (t.length < 3 || /^[0-9]+$/.test(t) || s.concernTokens.includes(t)) continue;
    s.concernTokens.push(t);
    if (s.concernTokens.length > MAX_CONCERN_TOKENS) s.concernTokens.shift();
  }
}

/** Returns this session's current concern-anchor token set (Guard 2). */
export function getConcernTokens(workspaceRoot: string): string[] {
  return [...getSession(workspaceRoot).concernTokens];
}

/** True once a Guard-2 concern_note has already fired for this (session, path). */
export function hasConcernNoteFired(workspaceRoot: string, path: string): boolean {
  return getSession(workspaceRoot).concernNotedPaths.has(path);
}

/** Marks a Guard-2 concern_note as fired for this (session, path) — see hasConcernNoteFired. */
export function markConcernNoteFired(workspaceRoot: string, path: string): void {
  getSession(workspaceRoot).concernNotedPaths.add(path);
}

/**
 * Feature 1 (2026-07-12b2): records a workspace-relative path successfully
 * served content by read_code this session — see WorkspaceSession.readPaths.
 */
export function recordReadPath(workspaceRoot: string, path: string): void {
  getSession(workspaceRoot).readPaths.add(path);
}

/** Returns the workspace-relative paths read this session (Feature 1). */
export function getReadPaths(workspaceRoot: string): string[] {
  return [...getSession(workspaceRoot).readPaths];
}

/**
 * DESIGN-v0.15-sf-intent-layers.md §4.2 (IL-W2): the layer-2 OBSERVED
 * evidence a task_pack build threads into `sfIntent.ts`'s `resolveIntent` as
 * `IntentEvidence.editObserved` — see `WorkspaceSession.intentEditObserved`'s
 * doc comment for the exact set/clear rules. Read-only outside this file.
 */
export function getIntentEditObserved(workspaceRoot: string): boolean {
  return getSession(workspaceRoot).intentEditObserved;
}

// ---------------------------------------------------------------------------
// L2 (2026-08-08 find-honesty) — the all-served-find escalation state machine.
//
// STATES, per certificate (see WorkspaceSession.servedFindLedger):
//
//   open        no all-served find recorded yet (occurrences === 0).
//   noted       exactly one distinct all-served find recorded. The response
//               that put it here SERVES normally — a locate is a real need and
//               "which lines" is a legitimate first answer — but carries
//               `all_served:true` so the signal is machine-readable rather
//               than a trailing prose string.
//   escalated   a SECOND distinct all-served find, or a repeat of one already
//               answered (same call signature, or same result fingerprint
//               under a different query). The response becomes terminal-style
//               with an unlock; the locations still ride it as a receipt.
//
// TRANSITIONS OUT (the whole point — escalation must always be escapable):
//   - any find that surfaces a NOT-yet-served location  -> resetServedFindLedger
//   - a successful edit                                 -> resetServedFindLedger
//   - a new certificate                                 -> ledger re-created
//   - taskEpoch:"new" / session reset                   -> ledger discarded
//
// DELIBERATELY NOT a second discovery brake. guardExecutionDiscovery refuses
// the 3rd+ byte-identical call shape and runs BEFORE dispatch; this fires at
// the 2nd all-served find from the RESPONSE path, on a predicate the brake
// cannot see (what the caller already holds, not how often it asked). Because
// it lands first, an all-served loop is answered here once rather than braked
// later under different wording — the ladder is ordered, not doubled.
// ---------------------------------------------------------------------------

/** The verdict L2 renders on one all-served find. */
export interface AllServedFindVerdict {
  /** 1 for the first distinct all-served find under this certificate. */
  occurrence: number;
  /** True when this exact call signature ran all-served before. */
  repeatedCall: boolean;
  /** The earlier query that produced this identical result set, if any. */
  duplicateOfQuery?: string;
  /** True once the response must escalate to the terminal-style shape. */
  escalate: boolean;
}

function trimLedgerSet(set: Set<string>): void {
  while (set.size > SERVED_FIND_LEDGER_CAP) {
    const oldest = set.values().next().value as string | undefined;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
}

/**
 * Records one find whose ENTIRE match set was already served this session and
 * returns the verdict the response path must obey.
 *
 * `certificateId` scopes the ledger; passing a different id than the one on
 * file starts a fresh ledger (a new decision has not yet asked anything twice).
 * `fingerprint` identifies the RESULT, `signature` the CALL — either one
 * repeating is enough to escalate, which is what catches both the measured
 * shapes: a second DISTINCT all-served query, and a differently-worded query
 * that re-serves an identical match set.
 */
export function recordAllServedFind(
  workspaceRoot: string,
  certificateId: string,
  signature: string,
  fingerprint: string,
  query: string,
): AllServedFindVerdict {
  const session = getSession(workspaceRoot);
  let ledger = session.servedFindLedger;
  if (ledger === undefined || ledger.certificateId !== certificateId) {
    ledger = {
      certificateId,
      occurrences: 0,
      fingerprints: new Set(),
      signatures: new Set(),
      firstQueryByFingerprint: new Map(),
    };
    session.servedFindLedger = ledger;
  }
  const repeatedCall = ledger.signatures.has(signature);
  const duplicateOfQuery = ledger.fingerprints.has(fingerprint)
    ? ledger.firstQueryByFingerprint.get(fingerprint)
    : undefined;
  const seenBefore = repeatedCall || ledger.fingerprints.has(fingerprint);
  // A repeat does not add a DISTINCT occurrence; it escalates on its own.
  if (!seenBefore) ledger.occurrences += 1;
  ledger.signatures.add(signature);
  ledger.fingerprints.add(fingerprint);
  // Provenance for the duplicate verdict: the FIRST query that produced this
  // result set, so a re-serve can name what already answered it rather than
  // asserting a duplicate the caller cannot locate in its own transcript.
  if (!ledger.firstQueryByFingerprint.has(fingerprint)) {
    ledger.firstQueryByFingerprint.set(fingerprint, query);
  }
  trimLedgerSet(ledger.signatures);
  trimLedgerSet(ledger.fingerprints);
  for (const key of [...ledger.firstQueryByFingerprint.keys()]) {
    if (!ledger.fingerprints.has(key)) ledger.firstQueryByFingerprint.delete(key);
  }
  return {
    occurrence: Math.max(1, ledger.occurrences),
    repeatedCall,
    ...(duplicateOfQuery !== undefined ? { duplicateOfQuery } : {}),
    escalate: seenBefore || ledger.occurrences >= 2,
  };
}

/**
 * Clears the all-served ledger. Called when a find surfaces a NOT-yet-served
 * location (progress: the caller is exploring, not circling) and on every
 * successful edit (the premise "you already hold every match" can no longer be
 * asserted across a write).
 */
export function resetServedFindLedger(workspaceRoot: string): void {
  getSession(workspaceRoot).servedFindLedger = undefined;
}

/** Test hook: the live ledger, as plain data. */
export function getServedFindLedgerForTest(
  workspaceRoot: string,
): { certificateId: string; occurrences: number; signatures: string[]; fingerprints: string[] } | undefined {
  const ledger = getSession(workspaceRoot).servedFindLedger;
  if (ledger === undefined) return undefined;
  return {
    certificateId: ledger.certificateId,
    occurrences: ledger.occurrences,
    signatures: [...ledger.signatures],
    fingerprints: [...ledger.fingerprints],
  };
}

// ---------------------------------------------------------------------------
// TL_SEARCH_DEDUP (DESIGN-v0.15-sf-turn-economy.md §4, W-T-D wave, default
// OFF) — the search-dedup ledger. Consulted/written only by
// `protocol/searchFamily.ts`'s `applySearchDedup`, itself only reachable when
// `util/flags.ts`'s `searchDedupEnabled()` is true, so with the flag off
// neither function below is ever called and the ledger stays permanently
// empty — the flag-off byte-identity guarantee holds by construction, not by
// a check inside these functions.
// ---------------------------------------------------------------------------

/** Re-insert `key` at the MRU (last) position, evicting the LRU entry past the cap. */
function touchSearchDedupLedger(
  ledger: Map<string, SearchDedupLedgerEntry>,
  key: string,
  entry: SearchDedupLedgerEntry,
): void {
  ledger.delete(key);
  ledger.set(key, entry);
  while (ledger.size > SEARCH_DEDUP_LEDGER_CAP) {
    const oldest = ledger.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    ledger.delete(oldest);
  }
}

/**
 * Look up a fingerprint recorded earlier THIS task. Returns `undefined` on a
 * genuine miss (never recorded) OR on a STALE hit (some write landed after
 * the entry was recorded) — the two are indistinguishable to the caller on
 * purpose: both mean "do not dedup, this call must stand on its own". A stale
 * entry found here is evicted immediately rather than left to expire, so a
 * later distinct write does not resurrect it by coincidence of counter math.
 *
 * A fresh hit is touched (moved to MRU) before being returned, so a
 * repeatedly-asked query survives LRU pressure from other distinct queries
 * the same task also ran.
 */
export function searchDedupLookup(
  workspaceRoot: string,
  fingerprint: string,
): SearchDedupLedgerEntry | undefined {
  const session = getSession(workspaceRoot);
  const entry = session.searchDedupLedger.get(fingerprint);
  if (entry === undefined) return undefined;
  if (entry.writeEventSerial !== session.writeEventSerial) {
    session.searchDedupLedger.delete(fingerprint);
    return undefined;
  }
  touchSearchDedupLedger(session.searchDedupLedger, fingerprint, entry);
  return entry;
}

/**
 * Record the FIRST serving of a fingerprint this task, stamped with the
 * session's CURRENT write-event counter — a later `searchDedupLookup` treats
 * any entry whose stamp has fallen behind as stale (see its own doc comment).
 */
export function recordSearchDedupEntry(
  workspaceRoot: string,
  fingerprint: string,
  entry: { kind: string; action: string; servedBy: string; files: number; digest: string },
): void {
  const session = getSession(workspaceRoot);
  touchSearchDedupLedger(session.searchDedupLedger, fingerprint, {
    ...entry,
    writeEventSerial: session.writeEventSerial,
  });
}

/**
 * F9 (2026-09-02 review fix): the search-dedup ledger's OWN serve-call
 * ordinal — see `WorkspaceSession.searchDedupCallSerial`'s doc comment for
 * why this is a dedicated counter rather than a reuse of `beginServeCall`'s
 * shared `serveCallSerial`.
 */
export function beginSearchDedupServeCall(workspaceRoot: string): number {
  const s = getSession(workspaceRoot);
  s.searchDedupCallSerial += 1;
  return s.searchDedupCallSerial;
}

/** Test hook: the live search-dedup ledger, as plain data (MRU last). */
export function getSearchDedupLedgerForTest(
  workspaceRoot: string,
): ReadonlyArray<readonly [string, SearchDedupLedgerEntry]> {
  return [...getSession(workspaceRoot).searchDedupLedger.entries()];
}

/** Test hook: the session's current write-event counter. */
export function getWriteEventSerialForTest(workspaceRoot: string): number {
  return getSession(workspaceRoot).writeEventSerial;
}

/**
 * Test hook (F9): the session's SHARED serve-call serial (`beginServeCall`'s
 * counter) — used to prove that search-dedup activity (`beginSearchDedupServeCall`)
 * never advances it, so enabling TL_SEARCH_DEDUP cannot shift a subsequent
 * read's `served_by` numbering.
 */
export function getServeCallSerialForTest(workspaceRoot: string): number {
  return getSession(workspaceRoot).serveCallSerial;
}

/**
 * L2 — provenance for one already-served path: the call that put those lines
 * on the wire, read from the SAME served-range ledger the `code_unchanged`
 * receipts are built from (servedByLabel). Returns undefined when the path has
 * no ledger entry, so a receipt says nothing it cannot source.
 *
 * `lines` narrows the label to the calls covering the matched lines; without
 * it the label covers the file's whole served extent.
 */
export function servedPathProvenance(
  workspaceRoot: string,
  filePath: string,
  lines?: readonly number[],
): string | undefined {
  const state = getSession(workspaceRoot).servedRangeLedger.get(filePath);
  if (state === undefined || state.spans.length === 0) return undefined;
  const candidates = lines !== undefined && lines.length > 0 ? [...lines] : undefined;
  const start = candidates !== undefined ? Math.min(...candidates) : state.spans[0]!.start;
  const end = candidates !== undefined
    ? Math.max(...candidates)
    : Math.max(...state.spans.map((span) => span.end));
  return servedByLabel(state, start, end);
}

/**
 * Merged, provenance-agnostic served-line coverage for one path this
 * session — the shared computation behind both servedFindWindowHasUnservedLines
 * (one contiguous window, fully covered or not) and, C3 (2026-08-09
 * range-honesty), servedFindMatchLinesOutsideServed (a SCATTERED set of match
 * lines, each checked independently). Empty when the path has no recorded
 * served range at all.
 */
function servedCoverageRanges(workspaceRoot: string, filePath: string): Array<[number, number]> {
  const state = getSession(workspaceRoot).servedRangeLedger.get(filePath);
  if (state === undefined) return [];
  return mergeServedRanges(state.spans.map((span) => [span.start, span.end] as [number, number]));
}

/**
 * L2 — true when the matched lines of an already-served file still have bytes
 * this session has NOT put on the wire, i.e. a zoom would genuinely serve
 * something. Used to decide whether an escalation may honestly advertise a
 * `read_file mode=slice` transition instead of prescribing a re-serve that
 * would come back as a `code_unchanged` receipt.
 */
export function servedFindWindowHasUnservedLines(
  workspaceRoot: string,
  filePath: string,
  start: number,
  end: number,
): boolean {
  const covered = servedCoverageRanges(workspaceRoot, filePath);
  return !covered.some(([rangeStart, rangeEnd]) => rangeStart <= start && rangeEnd >= end);
}

/**
 * C3 (2026-08-09 range-honesty) — the subset of `lines` NOT covered by any
 * range this session has actually been served for `filePath`; empty when
 * every one of them is held.
 *
 * File-level provenance (getReadPaths / servedPathProvenance) answers "was
 * this path read at all this session"; this answers "are THESE SPECIFIC
 * lines inside bytes actually put on the wire" — two different facts. The
 * measured defect (bench 2026-08-08-semantic-signal5-2, 8 T05c sightings): a
 * doc-sliver serve (task_pack's anchor-focus, or a governed full-mode
 * downgrade) marks the whole path "read" on a handful of served lines out of
 * thousands — e.g. CONTRACT.md served 1514-1514 of 1,514 lines — and a find
 * elsewhere in that same file matched line 1022. The file-level claim
 * ("every matching file was already served") was true; the line-level one
 * ("the matches sit inside content you hold") was not, 8/8 measured times.
 * Callers of this probe must gate any "you already hold this" residency
 * claim on the RESULT being empty, never on file-level provenance alone.
 */
export function servedFindMatchLinesOutsideServed(
  workspaceRoot: string,
  filePath: string,
  lines: readonly number[],
): number[] {
  const covered = servedCoverageRanges(workspaceRoot, filePath);
  if (covered.length === 0) return [...lines];
  return lines.filter((line) => !covered.some(([rangeStart, rangeEnd]) => rangeStart <= line && line <= rangeEnd));
}

/**
 * L3(b) — true when `path` is a plausible EDIT target for this session: a
 * write target of the live certificate, a path already edited, or a path the
 * epoch-scoped admissible union carries.
 *
 * Used to gate find's "edit-grade repeated-hit candidate" hint. That hint is
 * minted by find itself (attachDominantEditContext) and find never enrolls
 * anything in the admissible union — the three enrollment sites are the task
 * pack and a successful create — so this predicate cannot be satisfied by the
 * very call it is gating. Measured basis (2026-08-08 T05c, all three reps):
 * the ungated hint fired 5 times and named a file that was actually edited
 * 0/5 times, twice steering a solver into a file outside any admissible edit
 * set (drv_motor_pwm.c, scheduler.c).
 */
export function isPlausibleEditTarget(workspaceRoot: string, path: string): boolean {
  if (path === "") return false;
  const session = getSession(workspaceRoot);
  if (session.editedPaths.has(path)) return true;
  if (session.admissibleEditPaths.includes(path)) return true;
  const fence = session.executionFence;
  return fence !== undefined && fence.actionPaths.includes(path);
}

/**
 * turn-economy wave 2 (W1): true when this exact (path, sha) was already
 * FULLY served by a prior mode=full/auto/small_file expansion this session —
 * i.e. recordFullExpansion ran for the path with the SAME sha still recorded
 * (a sha change resets the per-path entry, so a stale entry never matches).
 *
 * A governor DOWNGRADE never calls recordFullExpansion (only an "allow" does),
 * so a true here means the caller ALREADY has these exact bytes in its context
 * from the earlier serve. That lets a governed repeat read return a compact
 * `{code_unchanged:true, handle, sha}` (content-equivalent) instead of either
 * a zero-content breadcrumb (the old skeleton downgrade) or a wasteful
 * re-serve of bytes the caller holds. When it is FALSE (a genuine first serve
 * that the cap is downgrading), the caller must instead serve the file head.
 */
export function wasFullyServed(workspaceRoot: string, path: string, sha: string, keepComments: boolean): boolean {
  const session = getSession(workspaceRoot);
  // B2e (2026-08-01 serving-completeness): a CHUNKED full serve records an
  // expansion (decideFullRead's "allow" always does) but only put the first
  // chunk on the wire. Treating it as "fully served" is exactly the T05c defect
  // — later slices answered `code_unchanged` for bytes the model never saw.
  const partial = session.partialFullServes.get(path);
  if (partial !== undefined && partial.sha === sha && partial.keepComments === keepComments) return false;
  const entry = session.fullExpansionsPerPath.get(path);
  // P2-1 (2026-09-08): projection-keyed — a prior serve under the OTHER
  // projection never counts as "fully served" for this one.
  return entry !== undefined && entry.lastSha === sha && entry.count >= 1 && entry.keepComments === keepComments;
}

/**
 * B2e (2026-08-01 serving-completeness): declare how much of a mode=full
 * "allow" actually reached the wire for (path, sha). `complete:false` marks the
 * serve as chunked (wasFullyServed answers false until a complete serve of the
 * same sha lands); `complete:true` clears any prior marker. Idempotent.
 */
export function recordFullServeCompleteness(
  workspaceRoot: string,
  path: string,
  sha: string,
  complete: boolean,
  keepComments: boolean,
): void {
  const session = getSession(workspaceRoot);
  if (complete) session.partialFullServes.delete(path);
  else session.partialFullServes.set(path, { sha, keepComments });
}

/**
 * B2d (2026-08-01 serving-completeness): READ-ONLY coverage view of the
 * served-range ledger for (filePath, fileSha) — the merged served clusters plus
 * the complement, regardless of whether any single request is fully subsumed.
 *
 * servedRangeReceipt answers only the narrow "is THIS window already held?"
 * question and returns undefined on partial overlap, so a caller that needs to
 * RANK requested windows by how much of each is still unserved (the ranges[]
 * ordering guarantee) or to name the largest unserved span (the per-task-cap
 * zoom next_call) had no way to ask. Returns undefined when nothing was served
 * for this exact sha — the same conservative "no claim" answer.
 */
export function servedRangeCoverage(
  workspaceRoot: string,
  filePath: string,
  fileSha: string,
  totalLines: number,
): { served: Array<[number, number]>; unserved: string[]; complete: boolean } | undefined {
  const state = getSession(workspaceRoot).servedRangeLedger.get(filePath);
  if (state === undefined || state.fileSha !== fileSha) return undefined;
  const served = state.ranges.map(([start, end]) => [start, end] as [number, number]);
  const unserved = unservedServedRanges(state.ranges, totalLines);
  return { served, unserved, complete: unserved.length === 0 };
}

/**
 * B2d: how many lines of `[startLine,endLine]` this session has NOT yet served
 * for `fileSha`. `totalLines` clamps the window exactly as recordServedRange
 * does, so the count always describes real file lines.
 */
export function unservedLineCount(
  workspaceRoot: string,
  filePath: string,
  fileSha: string,
  startLine: number,
  endLine: number,
  totalLines: number,
): number {
  const start = Math.max(1, Math.min(totalLines, startLine));
  const end = Math.max(start, Math.min(totalLines, endLine));
  const width = end - start + 1;
  const coverage = servedRangeCoverage(workspaceRoot, filePath, fileSha, totalLines);
  if (coverage === undefined) return width;
  let covered = 0;
  for (const [rangeStart, rangeEnd] of coverage.served) {
    const overlapStart = Math.max(start, rangeStart);
    const overlapEnd = Math.min(end, rangeEnd);
    if (overlapStart <= overlapEnd) covered += overlapEnd - overlapStart + 1;
  }
  return Math.max(0, width - covered);
}

/** True once the one-shot unread-sibling note (Feature 1) has already fired for this session. */
export function hasUnreadSiblingNoteFired(workspaceRoot: string): boolean {
  return getSession(workspaceRoot).unreadSiblingNoteFired;
}

/** Marks the one-shot unread-sibling note (Feature 1) as fired for this session — see hasUnreadSiblingNoteFired. */
export function markUnreadSiblingNoteFired(workspaceRoot: string): void {
  getSession(workspaceRoot).unreadSiblingNoteFired = true;
}

/**
 * True once a closure-bearing evaluation has certified every verifiable
 * check satisfied this session (2026-07-16a re-read-loop forensics) — see
 * markClosureSatisfied for the writer side and WorkspaceSession's
 * closureSatisfied field for the full rationale.
 */
export function isClosureSatisfied(workspaceRoot: string): boolean {
  return getSession(workspaceRoot).closureSatisfied;
}

/**
 * 2026-07-16a re-read-loop forensics: marks the session's closure ledger fully satisfied —
 * called from attachClosure (edit path) and the mode=closure read path
 * (closureTracking.ts) whenever a closure-bearing evaluation's `open` list
 * is empty. See clearClosureSatisfied for the re-arm side and
 * isClosureSatisfied for the readers this gates.
 */
export function markClosureSatisfied(workspaceRoot: string): void {
  getSession(workspaceRoot).closureSatisfied = true;
}

// ---------------------------------------------------------------------------
// W3 (2026-07-30, dist build-id echo): once-per-session claim so a response
// self-identifies which server build produced it without paying the byte
// cost on every single response — a stale MCP child (still serving pre-fix
// dist/ bytes) is otherwise invisible from the outside.
// ---------------------------------------------------------------------------
/**
 * The dispatch module's build id, published here by server.ts at module load
 * (it owns the derivation — see deriveServerBuildId's doc on why the CALLER's
 * `import.meta.url` is the right input, and why session.ts deriving its own
 * would report a different, less meaningful id).
 *
 * Read by the prepared-stop receipt through the SAME once-per-session claim a
 * served pack uses (_claimServerBuild): a suppressed call is often the first
 * response an operator inspects when asking "is the running server the build I
 * just shipped?" — the 2026-08-13 live repro spent turns on exactly that — and
 * routing it through the shared claim keeps the byte-economy contract
 * (one stamp per session, whichever response gets there first) intact.
 */
let _serverBuildId: string | undefined;

export function registerServerBuildId(buildId: string | undefined): void {
  _serverBuildId = buildId;
}

/** For tests/receipts: the registered build id, or undefined when none was published. */
export function currentServerBuildId(): string | undefined {
  return _serverBuildId;
}

/** The one claim point: true (and marks the session) exactly once per session. */
function _claimServerBuild(session: WorkspaceSession): boolean {
  if (session.serverBuildAnnounced) return false;
  session.serverBuildAnnounced = true;
  return true;
}

/**
 * Returns true (and marks the session) the FIRST time this is called for a
 * given workspace; false (no side effect) on every later call. Callers
 * attach `server_build` to the response only when this returns true.
 */
export function claimServerBuildAnnouncement(workspaceRoot: string): boolean {
  return _claimServerBuild(getSession(workspaceRoot));
}

/** Per-file ledger for WorkspaceSession.verificationManifestPathsServed. */
export function unservedVerificationPaths(workspaceRoot: string, paths: readonly string[]): string[] {
  const served = getSession(workspaceRoot).verificationManifestPathsServed;
  return paths.filter((p) => !served.has(p));
}

export function markVerificationPathsServed(workspaceRoot: string, paths: readonly string[]): void {
  const served = getSession(workspaceRoot).verificationManifestPathsServed;
  for (const p of paths) served.add(p);
}

/**
 * S1: has this EXACT content for `path` already ridden a verification kit?
 * `contentSha` is the sha of the whole-file bytes the kit would serve now, so
 * an edited/rewritten file re-serves in full instead of inheriting a stale
 * "served-earlier" label earned by its previous content.
 */
export function isVerificationSurfaceServed(
  workspaceRoot: string,
  path: string,
  contentSha: string,
): boolean {
  return getSession(workspaceRoot).verificationSurfacesServed.get(path) === contentSha;
}

/** Records ONLY bytes that actually left the server: call it at serve time. */
export function markVerificationSurfaceServed(
  workspaceRoot: string,
  path: string,
  contentSha: string,
): void {
  getSession(workspaceRoot).verificationSurfacesServed.set(path, contentSha);
}

/**
 * S1: a new task epoch rebuilds the caller's context assumptions, so the kit's
 * per-entry served ledger is dropped with it — the conservative direction is
 * re-serving bytes, never an unproven "already in your context" claim.
 */
export function clearVerificationLedgers(workspaceRoot: string): void {
  const session = getSession(workspaceRoot);
  session.verificationSurfacesServed.clear();
  session.verificationManifestPathsServed.clear();
}

/**
 * A closure-bearing evaluation whose `open` list is non-empty re-arms the
 * advisory notes gated by isClosureSatisfied — see markClosureSatisfied.
 */
export function clearClosureSatisfied(workspaceRoot: string): void {
  getSession(workspaceRoot).closureSatisfied = false;
}

/** Clears the session for a single workspace root, in every lane. Test hook. */
export function resetWorkspace(workspaceRoot: string): void {
  for (const key of [..._sessions.keys()]) {
    if (rootOfSessionKey(key) === workspaceRoot) _sessions.delete(key);
  }
}

/** Clears all session state. Test hook. */
export function resetAll(): void {
  _sessions.clear();
  // FX-N: the staging registry names session KEYS, so a leftover entry would
  // point at a session that no longer exists. Cleared with them.
  _pendingServeSessionKeys.clear();
}

/** Returns a plain-object snapshot suitable for trace output. */
export function snapshotForTrace(workspaceRoot: string): Record<string, unknown> {
  const s = getSession(workspaceRoot);
  return {
    workspaceRoot,
    readsByMode: Object.fromEntries(s.readsByMode),
    fullExpansionsPerPath: Object.fromEntries(
      Array.from(s.fullExpansionsPerPath.entries()).map(([k, v]) => [k, { ...v }]),
    ),
    fullExpansionsTotal: s.fullExpansionsTotal,
    tinyFullExpansionsTotal: s.tinyFullExpansionsTotal,
    tinyFullExpansionsExemptTotal: s.tinyFullExpansionsExemptTotal,
    handleBackedEdits: s.handleBackedEdits,
    pathOrSearchEditsWithoutHandle: s.pathOrSearchEditsWithoutHandle,
    repeatedReadsPerPathRange: Object.fromEntries(s.repeatedReadsPerPathRange),
    allowFullExpansionsTotal: s.allowFullExpansionsTotal,
    packChecksCount: s.packChecks?.checks.length ?? 0,
    editedPaths: [...s.editedPaths],
    singleEditCompletions: s.singleEditCompletions,
    usedEditsBatch: s.usedEditsBatch,
    singleFindCompletions: s.singleFindCompletions,
    findHintFired: s.findHintFired,
    serialSingleTargetReads: s.serialSingleTargetReads,
    closureOpenStreak: s.closureOpenStreak,
    closureEscalationFired: s.closureEscalationFired,
    admissibleEditHandlesCount: s.admissibleEditHandles.length,
    admissibleEditPathsCount: s.admissibleEditPaths.length,
  };
}
