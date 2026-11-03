// packState — extracted implementation; imports point to the owning modules.
import * as fs from "fs";
import type { ContinuationCall } from "./packBasics.js";
import type { ContinuationLike } from "./packBasics.js";
import type { HandleEntry } from "../../../util/handles.js";
import type { SourceBodyCapsule } from "../sourceBodyCapsule.js";
import type { TaskExecutionContract } from "@tokenlighten/types";
import type { TaskPackArgs } from "../model.js";
import type { TaskPackResult } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import type { TaskProfile } from "@tokenlighten/types";
import type { TaskProfileBinding } from "@tokenlighten/types";
import type { TaskWorkspaceState } from "@tokenlighten/types";
import { beginServeCall } from "../../../state/session.js";
import { clearServedWindowsForScope } from "../../../util/packServeLog.js";
import { codeTaskPackSurfaces } from "../artifactSections.js";
import { countLines } from "../../../util/countLines.js";
import { createPriorBodyRestoration } from "../priorBodyRestoration.js";
import { isWithin } from "../../../util/safePath.js";
import { laneScopedKey } from "../../../util/laneKey.js";
import { makeSourceBodyCapsule } from "../sourceBodyCapsule.js";
import { normalizeContractLane } from "../../../util/packServeLog.js";
import { normalizePathEntry } from "./packBasics2.js";
import { proofCompletionEnabled } from "../../../util/flags.js";
import { readFileForRequest } from "../../../util/requestFileCache.js";
import { recordServedRange } from "../../../state/session.js";
import { recordServedWindow } from "../../../util/packServeLog.js";
import { resolveReal } from "../../../util/safePath.js";
import { safeResolve } from "../../../util/safePath.js";
import { servedFindWindowHasUnservedLines } from "../../../state/session.js";
import { servedWindowHasUnservedLines } from "../../../util/packServeLog.js";
import { shaOfText } from "../../../util/handles.js";
import { tokenizeForEpoch } from "../../../state/session.js";

/**
 * W4 (turn-economy wave 2): the REAL body of a surface whose `code`
 * applyPackDedupe replaced with a compact `code_unchanged` pointer. E4
 * forensics: applyPackDedupe runs before the proof/falsification/execution-
 * contract pass, and a cross-call dedup swaps a duplicate surface's `code` for
 * a POINTER string ("handle — see prior pack"). That is content-equivalent for
 * the CALLER (it already holds the body) but NOT for server-side token
 * scanning: servedSurfaceText would then return the pointer, so a
 * readiness/falsification counterexample that demoted the FIRST call to
 * awaiting-input silently vanishes on an identical re-call — flipping the phase
 * to prepared with no new information (a manufactured turn). Keyed on the
 * ORIGINAL surface object (identity), this side channel lets servedSurfaceText
 * recover the real body for server-side reasoning while the serialized RESPONSE
 * still ships only the compact pointer — so every proof pass reaches the SAME
 * verdict on every identical call, without re-sending the body. A WeakMap so a
 * dropped surface is garbage-collected with no eviction bookkeeping.
 */
export const dedupedSurfaceBody = new WeakMap<TaskPackSurface, string>();

export const priorBodyRestoration = createPriorBodyRestoration();

// ---------------------------------------------------------------------------
// Behavior 3: task_pack RE-CALL dedup — a compact, idempotent response.
//
// A solver commonly re-issues the SAME task_pack while working one task (the
// forensic: 4 calls, each re-serving a multi-KB pack — a full round trip
// costing ~$0.02-0.03 apiece). When the very same request lands again and the
// files the prior pack surfaced are unchanged, there is nothing new to say:
// return a sub-1KB acknowledgement (`pack_unchanged:true` + the surface
// handles + the still-open checks) instead of recomputing and re-serializing
// the whole pack. Anything that would change the served content (a changed
// surface file, or an "extra" arg the stored pack did not have) falls through
// to a full recompute exactly as today.
// ---------------------------------------------------------------------------

/**
 * The essentials of a served task_pack, retained per workspace so an identical
 * re-call can be answered compactly without recomputing. Deliberately small:
 * no code/skeleton/facts — only what the compact response needs plus the
 * file-fingerprint list used to prove the surfaces are unchanged.
 */
export interface ServedPackRecord {
  /** Exact-query resume identity; optional so older/subset records fail closed. */
  queryIdentity?: string;
  taskBinding?: string;
  /**
   * F-V13-3 (2026-08-30): the lane this pack was SERVED to. The window is
   * keyed per (workspace, lane), so this is defence in depth on the two
   * lookups that hand a stored `executionContract` back to a caller
   * (tryServeCachedPack / tryServeSemanticDuplicatePack) — a receipt that
   * restates a certificate is an authorization like any other, and
   * `computePackFingerprint` cannot discriminate lanes (it hashes query
   * tokens + paths + roles + workspace, nothing about the caller).
   */
  lane: string;
  /**
   * TL_EFF_MAP_ANSWER_FIRST: the pack was an answer-first map — its core served, the bodies it leaves owed named
   * in its advisory. Its surface is the map's whole extent (`83-1552`), of which the served-range ledger proves only
   * the served windows, so a receipt built from it lists the windows the ledger cannot prove (`surfaceRangeUnserved`)
   * as `remaining`, as the pack itself did, instead of the extent whole.
   */
  answerFirst?: true;
  /** Batching hint only, never proof: same-query continuations retain map paging. */
  structureMapQueryKey?: string;
  /** hash of (normalized query tokens + sorted paths[] + surfaceRoles + workspace) — the dedup-eligible identity. */
  fingerprint: string;
  /** JSON of the "extra" args {path,symbol,lang,limit} the served call carried; a differing value forces recompute (those args change served content). */
  extraArgsKey: string;
  /** B2b: the REQUESTED taskProfile ("auto" when omitted) — gated separately from extraArgsKey via packProfileCompatible. */
  requestProfileKey: string;
  /**
   * Per-surface identity for the compact response (role is `string` to mirror
   * TaskPackSurface.role, not the narrower ImpactSurface).
   *
   * B5 (2026-08-21 serve-honesty): `content_completeness`/`total_lines` are
   * carried through from the served TaskPackSurface at capture time (see
   * captureServedPack), NOT projected onto any compact receipt this record
   * later builds (protocol/readFamily.ts's pack-unchanged projector has no
   * per-evidence slot for them — the frozen wire shape stays untouched). Their
   * sole purpose is so revalidateRecordToReceipt can tell whether the surface
   * THIS record represents was ever disclosed as partial, and decline the
   * compact receipt on a qref replay rather than silently dropping that fact
   * — the same structural gap tryServeSubsetReceipt's own guard closed for
   * its (unstored, ad-hoc) record.
   *
   * P1-6 (round-4 evaluation, 2026-09-28): `remaining_ranges` joins the two
   * fields above for the SAME reason, closing the gap `recordPredatesAdditional
   * ServedEvidence`'s own doc comment already named ("`prev.surfaces` lacks
   * `remaining_ranges` (never stored on `ServedPackRecord`), so a capture-time
   * PARTIAL surface's nominal `range` reads as fully covered here"). Without
   * it, `servedLineSpansOf(prev.surfaces...)` — fed a `content_completeness:
   * "partial"` surface whose disclosed gaps are invisible — subtracts NO holes
   * from the nominal `range` and treats the WHOLE numeric span as already
   * served, even when most of it was never shipped. Live repro
   * (classFlowOver64Long): a capture-time surface `range:"1-564"`,
   * `content_completeness:"partial"`, disclosed `remaining_ranges:["495-564",
   * "565-620"]` after shipping only lines 1-494 — a LATER call's genuinely new
   * serve of lines 495-514 (real bytes, on the session's servedRangeLedger)
   * numerically falls inside the stale record's [1,564] nominal span, so the
   * staleness check answered "nothing new" and a `{qref}` re-pack after that
   * later call CERTIFIED an `act.answer` replayed the ORIGINAL, now-superseded
   * `discover` verbatim — the loop this record exists to prevent. Threading
   * the real gaps through lets `servedLineSpansOf` compute the record's TRUE
   * prior-served extent ([1,494] here), so the newly-ledgered 495-514 is
   * correctly seen as evidence the record never captured.
   */
  surfaces: Array<{
    handle: string;
    path: string;
    range: string;
    role: string;
    /** Capability identity captured before proof compaction; never emitted. */
    handleIdentity?: Readonly<HandleEntry>;
    content_completeness?: "partial";
    total_lines?: number;
    remaining_ranges?: string[];
  }>;
  /**
   * D2 (F-B2, 2026-08-21): the workspace_state THIS record's own `surfaces`
   * produce, computed at capture time from live disk plus the capture-time
   * inventory (see `recordWorkspaceState`).
   *
   * `revalidateRecordToReceipt` used to compare a recomputation over these
   * surfaces against `executionContract.workspace_state.fingerprint` — the
   * CERTIFICATE's fingerprint, hashed over the surface list the contract was
   * BUILT over. Those two lists diverge for every pack whose certificate
   * outlives the surfaces it was issued over: `carryForwardCertifiedWorkingSet`
   * clones an EARLIER pack's contract onto a replay that serves a narrower
   * set, and trimToCap's byte-budget shed pass removes surfaces AFTER
   * `buildTaskExecutionContract` has already hashed them. For those packs the
   * comparison could never succeed, so a cumulative / carry-forward pack was
   * permanently ineligible for the exact-reissue receipt and re-built in full
   * on every identical re-issue, however untouched the workspace was.
   *
   * Storing the record's own state removes that lossy reconstruction WITHOUT
   * weakening the proof — the other side of the equality is still recomputed
   * from live disk on every probe, so the equality remains exactly a freshness
   * test. Additive, module-private, never projected onto any wire shape (the
   * B5 precedent).
   */
  workspaceState: TaskWorkspaceState;
  coverage: TaskPackResult["coverage"];
  coverageReason: TaskPackResult["coverage_reason"] | undefined;
  missing: string[];
  next: ContinuationCall | undefined;
  profileBinding: TaskProfileBinding | undefined;
  taskProfile: Exclude<TaskProfile, "generic"> | undefined;
  executionContract: TaskExecutionContract | undefined;
  contentSufficiency: TaskPackResult["content_sufficiency"] | undefined;
  /** iter-2 W1: coverage_basis at serve time (so a re-serve receipt re-affirms cumulative completeness). */
  coverageBasis: TaskPackResult["coverage_basis"] | undefined;
  /** iter-2 W1/W2: the served route, echoed on the compact receipt so "working set complete — stop" survives the re-serve. */
  route: TaskPackResult["route"] | undefined;
  /**
   * TL142-01C (2026-09-13, v0.14.2 hands-on report §4 TL142-01 "C"): the
   * `create_target` this pack certified, so the compact re-serve can RESTATE
   * it instead of silently dropping the whole create route.
   *
   * Without this field the record had no slot to even ask the question:
   * `compactReceiptFromRecord` rebuilt the receipt from
   * coverage/route/missing/surfaces/executionContract, every one of which the
   * create pack still had, and `create_target` — the one member
   * `canonicalDecision`'s `act.edit` floor needs and `readFamily`'s
   * `KEPT_ON_TASK_PACK` still ships — was the single fact that could not
   * survive. Every same-epoch repeat of an `act.edit`+`create_target` pack
   * (bare `{qref}`, bare `task:{handle}`, or a plain query resend with no
   * `task` field at all — `tryServeCachedPack` answers all three) therefore
   * degraded to `discover`/`await_input` with the original 4-file discovery
   * `next` re-proposed, on a workspace where nothing had changed.
   *
   * Restated ONLY while the target still does not exist on disk (see
   * `restatableCreateTarget`): once the caller has actually created the file,
   * re-asserting the create would be a false claim, and the ordinary
   * staleness gates already force a full rebuild for that case anyway (the
   * new file moves the workspace-state fingerprint).
   */
  createTarget: TaskPackResult["create_target"] | undefined;
  /**
   * TL142-01B: the verified-absent request items this pack disclosed.
   *
   * The THIRD carrier a compact re-serve silently dropped (create_target was
   * the first two doors — see `createTarget`). `decisionWire.ts`'s
   * `projectCertificate` builds `certificate.gaps` from this array, so a
   * receipt that restated the certificate but not the absences shipped a
   * certificate whose disclosed gaps had vanished — on a workspace this very
   * path has already proven byte-identical, which is precisely the condition
   * under which an absence proof still holds.
   */
  requestItemAbsences: TaskPackResult["request_item_absences"] | undefined;
  /**
   * TL142-01A/01B: the executed-search RESULT ledger's sequence at capture
   * time (`util/packServeLog.ts`'s `executedSearchResultSequence`).
   *
   * The receipt door's own staleness clock. Every other gate on this path
   * proves the WORKSPACE has not changed; none of them can see that the CALLER
   * has, in between, run the search this pack itself prescribed and learned
   * where the symbol lives or that the token does not exist. Re-serving the
   * record as `pack-unchanged` then denies a proof the task already holds —
   * which is how a resume after a confirmed absence returned
   * `await_input:"no-grounded-call-remains"` instead of citing the absence.
   */
  executedSearchSequence: number;
  /** iter-2 W1: epoch tokens this pack was served under — restricts subset re-serves to the SAME task. */
  epochTokens: string[];
  /** iter-3 F2: the request's surfaceRoles[] (sorted) at serve time — a differing role set is a DIFFERENT working set (adds required roles), so it must not be treated as a semantic duplicate. */
  requestRoles: string[];
  /** iter-3 F2: the request's REQUESTED paths (normalized+sorted) at serve time — what the caller SEEDED, distinct from the served surfaces. A semantic-duplicate re-ask must re-request a SUBSET of these; a caller who deliberately seeds a DIFFERENT file (even one this pack served as supporting context) is re-focusing, not truncating, and earns a full serve. */
  requestPaths: string[];
  /** iter-2 W1: the inventory-complete workspace fingerprint at serve time, or "" when the inventory was not complete. A subset re-serve requires the CURRENT inventory to match this exactly — proof the WHOLE workspace (not just the served files) is unchanged. */
  inventoryFingerprint: string;
  /** Check ids present when this pack was served (intersected with session lastOpenIds at compact-response time). */
  checkIds: string[];
  /** Content-sha of each surface file at serve time (bounded set), keyed by workspace-relative path. Empty when a file was unreadable/oversized — then that surface can't be proven unchanged and we recompute. */
  fileShas: Array<{ path: string; sha: string }>;
}

/**
 * iter-2 W1: the last few served task_pack records per workspace (bounded FIFO),
 * NOT just the single most recent. The iter-1 verbatim-duplicate loss was a
 * VERBATIM re-call "1 call apart": an intervening pack had overwritten the old
 * single-slot cache, so the identical re-call compared against the wrong record,
 * saw a fingerprint mismatch, and re-served ~20KB in full with no receipt.
 * Retaining a small window lets a duplicate that is not the immediately-
 * preceding call still hit the compact re-serve. Each record still carries its
 * own file-sha + workspace-state proof, so staleness is verified per record.
 */
export const MAX_CACHED_PACKS_PER_WORKSPACE = 8;

export const servedPacksByWorkspace = new Map<string, ServedPackRecord[]>();

export function structureMapChainWasServed(workspace: string, query: string): boolean {
  const key = shaOfText(query);
  return (servedPacksByWorkspace.get(laneScopedKey(workspace)) ?? [])
    .some(record => record.structureMapQueryKey === key);
}

/**
 * iter-3 F2: fraction of the LARGER of (current query tokens, prior record
 * tokens) that must be shared for a semantic-duplicate match. 0.8 = a re-ask may
 * differ by at most ~20% of tokens (the truncated-mid-word tail) before it is
 * treated as a genuinely different request that earns a full serve.
 */
export const SEMANTIC_DUP_OVERLAP_RATIO = 0.8;

/**
 * iter-3 F3: minimum body size (bytes) before a cross-pack resident surface is
 * worth replacing with a code-less marker. Tiny bodies (< this) cost more in
 * indirection/marker text than they save, so they keep their inline code.
 */
export const RESIDENT_DEDUP_MIN_BYTES = 512;

/** iter-3 F4: hard cap on route.reason length on an envelope-trimmed pack. */
export const ROUTE_REASON_ENVELOPE_CAP = 200;

/** iter-2 W1 (subset case): two epoch-token lists name the same task iff they share a token (both non-empty). Mirrors packServeLog's internal overlap rule. */
export function epochsOverlap(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const set = new Set(a);
  return b.some((t) => set.has(t));
}

/** Bound on how many surface files the unchanged-check reads (keeps the cheap idempotency probe cheap). */
export const MAX_FINGERPRINT_FILES = 12;

/** Per-file byte cap for the unchanged-check sha (skip pathological huge files rather than reading them on a mere probe). */
export const MAX_FINGERPRINT_FILE_BYTES = 256 * 1024;

/**
 * The dedup-eligible identity of a task_pack request: normalized query tokens
 * (order-independent via sort), the paths[] entries (path+range+symbol, sorted),
 * surfaceRoles (sorted), and the workspace. cwd is folded in as `workspace`
 * (the caller-supplied cwd is already resolved to the workspace root before we
 * are called). Excludes path/symbol/lang/limit — those are the "extra" args
 * gated separately via extraArgsKey.
 */
export function computePackFingerprint(args: TaskPackArgs, workspace: string): string {
  const queryTokens = tokenizeForEpoch(args.query ?? "").slice().sort();
  // FIX-B3: paths[] entries may still be bare strings at this point (this
  // fingerprint is computed BEFORE buildSeededTaskPack's own normalization
  // runs) — normalize per-entry here too so a bare-string call fingerprints
  // identically to the equivalent {path:...} object form instead of
  // throwing on a missing `.path`.
  const paths = (args.paths ?? [])
    .map(normalizePathEntry)
    .map((p) => [p.path, p.range ?? "", p.symbol ?? ""].join("\u0000"))
    .slice()
    .sort();
  const roles = (args.surfaceRoles ?? []).slice().sort();
  const material = JSON.stringify({ q: queryTokens, p: paths, r: roles, w: workspace });
  return shaOfText(material);
}

/**
 * iter-3 F2: the normalized, sorted set of paths a request explicitly SEEDED
 * (paths[] + path).
 *
 * DESIGN-v0.15 R1 false-completion fix (2026-09-07, P1): each `paths[]` entry
 * now carries its `range`/`symbol` alongside the path (mirroring
 * `computePackFingerprint`'s own `paths` material exactly) — PATH ALONE used
 * to be the whole key, so a follow-up asking for a WIDER/DIFFERENT range of a
 * path this task already seeded (e.g. `range:"7-41"` after an earlier
 * `range:"1-20"` of the SAME file, same query) fingerprinted identically to
 * the earlier, narrower request. `tryServeSemanticDuplicatePack`'s "SAME
 * requested path set" gate then matched the stale EARLIER record and replayed
 * its compact `pack-unchanged` receipt instead of building the fresh pack the
 * wider range asked for — silently discarding the caller's own explicit
 * widening and masking exactly the range-coverage fix this mechanism exists
 * to make effective (an uncovered decision/relation/definition item's own
 * follow-up `range` request must actually reach a fresh build). The singular
 * legacy `args.path` stays a bare path add: it carries no `range` of its own,
 * and its `symbol` is already covered separately by `computeExtraArgsKey`.
 */
export function requestedPathSet(args: TaskPackArgs): string[] {
  const out = new Set<string>();
  for (const entry of args.paths ?? []) {
    const normalized = normalizePathEntry(entry);
    if (normalized.path.length === 0) continue;
    out.add([normalized.path, normalized.range ?? "", normalized.symbol ?? ""].join("\u0000"));
  }
  if (typeof args.path === "string" && args.path.length > 0) out.add(args.path);
  return [...out].sort();
}

/**
 * JSON key of the "extra" args that must MATCH for a dedup (differing →
 * recompute).
 *
 * B2b (2026-08-01 serving-completeness): `taskProfile` LEFT this key and moved
 * to computeRequestProfileKey. Live defect (2026-07-31-semantic-signal5-2,
 * T09): a qref-only replay that OMITTED taskProfile re-served the whole 14.7KB
 * pack, while the byte-identical call that carried taskProfile got the 1.9KB
 * `pack_unchanged` receipt — the sole difference was `"auto"` vs the declared
 * value inside this key. Absence of the arg is not a different request; it is
 * the documented "omit if unknown" form of the same one.
 */
export function computeExtraArgsKey(args: TaskPackArgs): string {
  return JSON.stringify({
    path: args.path ?? null,
    symbol: args.symbol ?? null,
    lang: args.lang ?? null,
    limit: args.limit ?? null,
  });
}

/** The request signature TaskPackArgs.namedScopeRequest compares: fingerprint plus extra-args key. */
export function namedScopeSignature(args: TaskPackArgs, fingerprint: string): string {
  return `${fingerprint}\u0000${computeExtraArgsKey(args)}`;
}

/** B2b: the REQUESTED profile, normalized ("auto" when the caller omitted it). */
export function computeRequestProfileKey(args: TaskPackArgs): string {
  return String(args.taskProfile ?? "auto");
}

/**
 * B2b: may a record captured under `recordProfileKey` answer a request made
 * under `requestProfileKey`?
 *
 * Asymmetric on purpose. An EXPLICIT profile is a caller declaration that
 * changes the served route/shape, so it must match exactly (unchanged
 * behavior). An ABSENT profile ("auto") is the caller saying "you decide" — the
 * record's own resolved profile is a valid answer, and the receipt echoes it
 * (`task_profile`), so the caller is never told something the pack did not say.
 * Every other staleness gate (file shas, workspace fingerprint) still runs.
 */
export function packProfileCompatible(requestProfileKey: string, recordProfileKey: string): boolean {
  return requestProfileKey === recordProfileKey || requestProfileKey === "auto";
}

/** Read a workspace-relative file and return its content-sha, bounded by size; undefined when unreadable/oversized. */
/**
 * P1-1 item 2: `surfaceFileSha`'s sibling, returning the SAME sha plus the
 * line count `servedRangeReceipt` needs to clamp a window. One bounded read,
 * one realpath containment check, identical failure envelope (undefined on an
 * unreadable, escaping or oversized file).
 */
export function surfaceFileIdentity(workspace: string, relPath: string): { sha: string; totalLines: number } | undefined {
  const abs = safeResolve(relPath, workspace);
  if (abs === undefined) return undefined;
  try {
    const real = fs.realpathSync(abs);
    if (!isWithin(real, resolveReal(workspace))) return undefined;
    if (fs.statSync(real).size > MAX_FINGERPRINT_FILE_BYTES) return undefined;
    // served-bytes: not-served (surface fingerprint: sha + line count only)
    const text = readFileForRequest(real).toString("utf8");
    const lines = text.split("\n");
    // A trailing newline yields a final empty element that is not a line.
    const totalLines = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
    return totalLines > 0 ? { sha: shaOfText(text), totalLines } : undefined;
  } catch {
    return undefined;
  }
}

export function surfaceFileSha(workspace: string, relPath: string): string | undefined {
  const abs = safeResolve(relPath, workspace);
  if (abs === undefined) return undefined;
  try {
    const real = fs.realpathSync(abs);
    if (!isWithin(real, resolveReal(workspace))) return undefined;
    const size = fs.statSync(real).size;
    if (size > MAX_FINGERPRINT_FILE_BYTES) return undefined;
    // served-bytes: not-served (surface fingerprint: sha only)
    return shaOfText(readFileForRequest(real).toString("utf8"));
  } catch {
    return undefined;
  }
}

export function sourceBodyCapsuleForSurface(
  workspace: string,
  surface: TaskPackSurface,
  body: string,
): SourceBodyCapsule | undefined {
  if (surface.appended_windows !== undefined && surface.appended_windows.length > 0) return undefined;
  const abs = safeResolve(surface.path, workspace);
  if (abs === undefined) return undefined;
  try {
    const real = fs.realpathSync(abs);
    if (!isWithin(real, resolveReal(workspace))) return undefined;
    if (fs.statSync(real).size > MAX_FINGERPRINT_FILE_BYTES) return undefined;
    // Read once at capsule construction: both the digest and exact source slice
    // are from the same file snapshot. A later comparison re-reads it.
    // served-bytes: not-served (source capsule proof: exact-prefix comparison + sha only; the capsule keeps the already-served surf.code, never these bytes)
    const source = readFileForRequest(real).toString("utf8");
    return makeSourceBodyCapsule({
      path: surface.path,
      handle: surface.handle,
      range: surface.range,
      body,
      source,
      sha: shaOfText(source),
      remainingRanges: surface.remaining_ranges,
      hasAppendedWindows: surface.appended_windows !== undefined && surface.appended_windows.length > 0,
    });
  } catch {
    return undefined;
  }
}

/** Live line count for a workspace-relative path; undefined when unreadable. */
export function surfaceFileLineCount(workspace: string, relPath: string): number | undefined {
  const abs = safeResolve(relPath, workspace);
  if (abs === undefined) return undefined;
  try {
    const real = fs.realpathSync(abs);
    if (!isWithin(real, resolveReal(workspace))) return undefined;
    if (fs.statSync(real).size > MAX_FINGERPRINT_FILE_BYTES) return undefined;
    // served-bytes: not-served (surface fingerprint: line count only)
    return countLines(readFileForRequest(real).toString("utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Capture the served pack's essentials + surface-file shas for a possible
 * future re-call dedup. Runs AFTER the full pack is built and trimmed, so the
 * captured surfaces/coverage/missing/next reflect exactly what shipped.
 */
/** Parse a "N-M" surface/remaining range; undefined for anything else. */
export function parseSurfaceSpan(range: string): { start: number; end: number } | undefined {
  const parsed = range.trim().match(/^(\d+)-(\d+)$/);
  if (parsed === null) return undefined;
  const start = parseInt(parsed[1]!, 10);
  const end = parseInt(parsed[2]!, 10);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) return undefined;
  return { start, end };
}

/**
 * B2d (2026-08-01 serving-completeness): the FILE LINE SPANS a pack actually
 * put on the wire, per workspace-relative path.
 *
 * A surface with no `code` (handle-only, or a `code_unchanged` pointer) shipped
 * no bytes and contributes nothing. A disclosed-partial surface contributes its
 * `range` MINUS its `remaining_ranges` — never the whole range, so the ledger
 * can never claim lines the excerpt omitted.
 *
 * W14 L1 (2026-08-22): the surface `range` is the exact task-pack evidence
 * window. A compact `doc elided L<a>-<b>` marker still addresses those source
 * lines inside that semantic window, so they remain prior on a later full read;
 * only explicit `remaining_ranges` stay unserved. This is deliberately scoped
 * to task_pack surface semantics — direct full/slice serves still book only the
 * physical spans their wire body carries.
 *
 * Exported for readCodeTaskPack.spec.ts, which pins the §3 residual property
 * (what dedupeTrimAndPersist CAPTURES for the ledger is a subset of what it
 * RETURNS) without having to reach into session state.
 */
export function packServedSpans(result: TaskPackResult): Map<string, Array<[number, number]>> {
  const spans = new Map<string, Array<[number, number]>>();
  for (const surface of codeTaskPackSurfaces(result.surfaces)) {
    if (surface.code === undefined || surface.code.length === 0) continue;
    const span = parseSurfaceSpan(String(surface.range ?? ""));
    if (span === undefined) continue;
    const omitted = (surface.remaining_ranges ?? [])
      .map(parseSurfaceSpan)
      .filter((entry): entry is { start: number; end: number } => entry !== undefined)
      .sort((left, right) => left.start - right.start);
    const served: Array<[number, number]> = [];
    let cursor = span.start;
    for (const gap of omitted) {
      if (gap.end < cursor) continue;
      if (gap.start > cursor) served.push([cursor, Math.min(span.end, gap.start - 1)]);
      cursor = Math.max(cursor, gap.end + 1);
      if (cursor > span.end) break;
    }
    if (cursor <= span.end) served.push([cursor, span.end]);
    // A task-pack range is its exact semantic evidence window. The body may
    // compact comments into a marker, but that marker still addresses the
    // omitted source lines; recording only marker-free tail lines made a later
    // mode=full treat the rest of the selected evidence as unserved.
    const existing = spans.get(surface.path) ?? [];
    existing.push(...served.filter(([start, end]) => end >= start));
    if (existing.length > 0) spans.set(surface.path, existing);
  }
  return spans;
}

export function nextCallCoveredBySpans(
  result: TaskPackResult,
  call: ContinuationLike,
  spans: ReadonlyMap<string, ReadonlyArray<readonly [number, number]>>,
): boolean {
  if (call.tool !== "tl_read_file") return false;
  const args = call.arguments as Record<string, unknown>;
  if (typeof args.handle !== "string") return false;
  const range = parsePackLineRange(args.range);
  if (range === undefined) return false;
  const surface = codeTaskPackSurfaces(result.surfaces)
    .find((candidate) => candidate.handle === args.handle);
  if (surface === undefined) return false;
  return spans.get(surface.path)?.some(([start, end]) =>
    start <= range[0] && end >= range[1]
  ) === true;
}

/**
 * B2d: LEDGER CONTINUITY. The pack serve path never touched the served-range
 * ledger, so a slice issued right after a pack could not see the pack's own
 * serving credit — the caller was charged twice for the same lines, and the
 * zoom-progress ordering above had no evidence to order by. Record what the
 * pack actually served (path, file sha, span) as the pack is captured.
 *
 * Bounded by MAX_FINGERPRINT_FILES like every other capture-time read, and
 * fail-safe: an unreadable file simply records nothing.
 */
export function parsePackLineRange(value: unknown): [number, number] | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d+)-(\d+)$/.exec(value);
  if (match === null) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  return Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end >= start
    ? [start, end]
    : undefined;
}

export interface ServedWindowScope {
  readonly epoch: string;
  readonly lane: string;
  readonly reset?: boolean;
}

export function servedZoomScopeForArgs(
  args: TaskPackArgs | undefined,
  query: string,
): ServedWindowScope | undefined {
  if (args === undefined) return undefined;
  return {
    epoch: tokenizeForEpoch(query).join("\u0000"),
    lane: normalizeContractLane(args.lane),
    ...(args.taskEpoch === "new" ? { reset: true } : {}),
  };
}

export function scopedWindowHasUnservedLines(
  workspace: string | undefined,
  surface: TaskPackSurface,
  parsed: [number, number],
  scope: ServedWindowScope | undefined,
): boolean {
  if (workspace === undefined) return true;
  if (scope === undefined) {
    return servedFindWindowHasUnservedLines(workspace, surface.path, parsed[0], parsed[1]);
  }
  return servedWindowHasUnservedLines({
    workspaceRoot: workspace,
    epoch: scope.epoch,
    lane: scope.lane,
    path: surface.path,
    sha: surfaceFileSha(workspace, surface.path),
    startLine: parsed[0],
    endLine: parsed[1],
  });
}

/** Select only a disclosed window that still has bytes outside the served ledger. */
export function firstUnservedPartialRange(
  workspace: string | undefined,
  surface: TaskPackSurface,
  scope?: ServedWindowScope,
  currentPackSpans?: ReadonlyMap<string, ReadonlyArray<readonly [number, number]>>,
): string | undefined {
  for (const range of surface.remaining_ranges ?? []) {
    const parsed = parsePackLineRange(range);
    // Keep malformed producer data actionable; the normal read admission will
    // reject it if it cannot be executed, while a valid range is checked against
    // the scoped served-window ledger before it becomes a zoom.
    if (parsed === undefined) return range;
    const coveredByCurrentPack = currentPackSpans?.get(surface.path)?.some(([start, end]) =>
      start <= parsed[0] && end >= parsed[1]
    ) === true;
    if (coveredByCurrentPack) continue;
    if (scopedWindowHasUnservedLines(workspace, surface, parsed, scope)) return range;
  }
  return undefined;
}

/**
 * Mark zoom ranges already served by this workspace session before canonical
 * projection. This is an internal producer marker: protocol/readFamily.ts
 * projects only the frozen wire fields, while canonicalDecision.ts uses it to
 * avoid reviving a stale document zoom after the contract correctly declined it.
 */
export function markServedZoomCandidates(
  workspace: string,
  result: TaskPackResult,
  forceServe = false,
  scope?: ServedWindowScope,
): void {
  if (forceServe) return;
  const suppressed: string[] = [];
  const currentPackSpans = packServedSpans(result);
  for (const surface of codeTaskPackSurfaces(result.surfaces)) {
    for (const range of surface.remaining_ranges ?? []) {
      const parsed = parsePackLineRange(range);
      if (
        parsed !== undefined
        && (
          currentPackSpans.get(surface.path)?.some(([start, end]) =>
            start <= parsed[0] && end >= parsed[1]
          ) === true
          || !scopedWindowHasUnservedLines(workspace, surface, parsed, scope)
        )
      ) {
        suppressed.push(JSON.stringify([surface.handle, range]));
      }
    }
  }
  if (suppressed.length > 0) {
    (result as TaskPackResult & { served_zoom_suppressed?: string[] }).served_zoom_suppressed = suppressed;
  }

  // `result.next` and the continuation plan can be minted before the current
  // pack's served spans are booked. If that emitted zoom is already covered by
  // a sibling surface in this same response, remove it before canonical
  // projection and select the first genuinely unserved required window.
  const parsedResultNext = result.next;
  const staleResultNext = parsedResultNext !== undefined
    && nextCallCoveredBySpans(result, parsedResultNext, currentPackSpans);
  const contractNext = result.execution_contract?.next_call;
  const staleContractNext = contractNext !== undefined
    && nextCallCoveredBySpans(result, contractNext, currentPackSpans);
  const servedZoomExhausted = suppressed.length > 0
    && codeTaskPackSurfaces(result.surfaces)
      .filter((surface) => surface.required !== false)
      .every((surface) =>
        firstUnservedPartialRange(workspace, surface, scope, currentPackSpans) === undefined
      );
  if (
    staleResultNext
    || staleContractNext
    || (!proofCompletionEnabled() && servedZoomExhausted)
  ) {
    delete result.next;
    delete result.continuation;
    const replacement = codeTaskPackSurfaces(result.surfaces)
      .filter((surface) => surface.required !== false)
      .map((surface) => ({
        surface,
        range: firstUnservedPartialRange(workspace, surface, scope, currentPackSpans),
      }))
      .find((entry): entry is { surface: TaskPackSurface; range: string } => entry.range !== undefined);
    if (replacement !== undefined) {
      const replacementCall: ContinuationCall = {
        tool: "tl_read_file",
        arguments: { handle: replacement.surface.handle, range: replacement.range },
      };
      result.next = replacementCall;
      if (result.execution_contract !== undefined) {
        result.execution_contract.next_call = replacementCall;
        if (result.execution_contract.call_budget !== undefined) {
          result.execution_contract.call_budget = {
            ...result.execution_contract.call_budget,
            candidate_call: replacementCall,
          };
        }
      }
    } else if (result.execution_contract !== undefined) {
      delete result.execution_contract.next_call;
      if (result.execution_contract.call_budget !== undefined) {
        delete result.execution_contract.call_budget.candidate_call;
      }
      // E-1 OFF parity: E-2 still removes a same-pack-served zoom, but the
      // proof-completion switch must not turn that removal into a terminal
      // act.* decision. Keep the legacy conservative await-input state when
      // no unserved replacement remains; ON can certify only after discharge.
      if (!proofCompletionEnabled()) {
        result.execution_contract.state = "needs-followup";
        result.execution_contract.readiness = "needs-followup";
        result.execution_contract.discovery_complete = false;
        result.execution_contract.next_action = "request-user-input";
        result.execution_contract.typestate.phase = "awaiting-input";
        result.execution_contract.typestate.allowed_actions = ["request-user-input"];
        result.execution_contract.typestate.challenge_required_for = [];
      }
    }
  }
}

// ---------------------------------------------------------------------------
// FX-I-A/FX-J (2026-09-03) — WHY THIS BOOKS IMMEDIATELY AGAIN.
//
// FX-H queued this booking in a module-global array and flushed it at
// `buildTaskPack`'s exit, because the SF pass that may still WITHHOLD a body
// (`applySemanticFrontierDemotion`, §3.5.1's supporting tier) ran only after
// `buildTaskPackCore` returned. That deferral was both incomplete (the edit
// admissibility union and the certified working set were booked pre-demotion
// anyway — round-13 finding 1) and unsafe (an unkeyed global queue flushed by
// whichever concurrent handler exited first — round-13 findings 3/4).
//
// The demotion now runs INSIDE `dedupeTrimAndPersist`, at
// `applySemanticFrontierPreBookingSeam` — which is AFTER
// `finalizePackServeState` (the classifier needs the finalized
// `execution_contract`) and BEFORE `bookShippedPackServeState`, the one pass
// that books. Under `TL_SF_DEMOTE` every booking producer, this one included,
// reads a single `shippedSurfaces` projection over the final pack, so the pack
// that gets booked IS the pack that ships. No queue, no flush, no cross-call
// state — and flag-off is unchanged by construction, because the seam returns
// before touching anything without `TL_SF_STATEFUL` and the two pre-seam
// producers keep their historical position.
// ---------------------------------------------------------------------------

export function recordPackServedRanges(
  workspace: string,
  result: TaskPackResult,
  scope?: ServedWindowScope,
): void {
  if (scope?.reset) clearServedWindowsForScope(workspace, scope.epoch, scope.lane);
  const spans = packServedSpans(result);
  if (spans.size === 0) return;
  // F3: one ordinal for the whole pack — every span it books was served by the
  // same call.
  const packCall = beginServeCall(workspace);
  let files = 0;
  for (const [relPath, ranges] of spans) {
    if (files >= MAX_FINGERPRINT_FILES) break;
    const abs = safeResolve(relPath, workspace);
    if (abs === undefined) continue;
    let text: string;
    try {
      const real = fs.realpathSync(abs);
      if (!isWithin(real, resolveReal(workspace))) continue;
      if (fs.statSync(real).size > MAX_FINGERPRINT_FILE_BYTES) continue;
      // served-bytes: not-served (served-range ledger capture: sha + span accounting only)
      text = readFileForRequest(real).toString("utf8");
    } catch {
      continue;
    }
    files += 1;
    const sha = shaOfText(text);
    const totalLines = Math.max(1, countLines(text));
    for (const [start, end] of ranges) {
      if (start > totalLines) continue;
      const servedEnd = Math.min(end, totalLines);
      recordServedRange(workspace, relPath, sha, start, servedEnd, totalLines, {
        mode: "task_pack",
        range: `${start}-${servedEnd}`,
        call: packCall,
      });
      if (scope !== undefined) {
        recordServedWindow({
          workspaceRoot: workspace,
          epoch: scope.epoch,
          lane: scope.lane,
          path: relPath,
          sha,
          startLine: start,
          endLine: servedEnd,
        });
      }
    }
  }
}
