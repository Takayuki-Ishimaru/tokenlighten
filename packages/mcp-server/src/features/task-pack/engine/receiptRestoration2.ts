// receiptRestoration — extracted implementation; imports point to the owning modules.
import type { ReceiptConsumptionScope } from "./receiptProgress3.js";
import type { ServedPackRecord } from "./packState2.js";
import type { TaskExecutionContract } from "@tokenlighten/types";
import type { TaskPackArgs } from "../model.js";
import type { TaskPackResult } from "../model.js";
import type { TaskPackResultSurface } from "../model.js";
import { MAX_FINGERPRINT_FILES } from "./packState2.js";
import { SEMANTIC_DUP_OVERLAP_RATIO } from "./packState2.js";
import { SURFACE_ROLE_PRIORITY } from "./partialPackBuilder.js";
import { answerRecordPredatesProvenAbsence } from "./receiptRestoration.js";
import { codeTaskPackSurfaces } from "../artifactSections.js";
import { compactReceiptFromRecord } from "./receiptRestoration.js";
import { computeExtraArgsKey } from "./packState2.js";
import { computePackFingerprint } from "./packState2.js";
import { computeRequestProfileKey } from "./packState2.js";
import { computeWorkspaceInventoryState } from "./epochEvidence2.js";
import { createPendingRecordIsStale } from "./receiptRestoration.js";
import { currentSessionLane } from "../../../util/laneKey.js";
import { deriveCanonicalTaskDecision } from "../canonicalDecision.js";
import { epochsOverlap } from "./packState2.js";
import { executedSearchResultSequence } from "../../../util/packServeLog.js";
import { getPackChecks } from "../../../state/session.js";
import { getSession } from "../../../state/session.js";
import { handleTable } from "../../../util/handles.js";
import { isArtifactTaskPackSurface } from "../artifactSections.js";
import { laneScopedKey } from "../../../util/laneKey.js";
import { packProfileCompatible } from "./packState2.js";
import { queryCandidateSelectionRequired } from "./seedAdmission2.js";
import { receiptContinuationDisposition } from "./receiptProgress3.js";
import { receiptContractWithoutConsumedSearch } from "./receiptProgress.js";
import { receiptRecordWithoutConsumedSearch } from "./receiptProgress.js";
import { recordCertifiedTerminal } from "./receiptRestoration.js";
import { recordDocSurfaceIsPartial } from "./packState.js";
import { recordPredatesAdditionalServedEvidence } from "./receiptRestoration.js";
import { recordSupersededByLaterCertifiedTerminal } from "./receiptRestoration.js";
import { recordSurfacePartlyServed } from "./receiptProgress3.js";
import { recordWorkspaceState } from "./packState3.js";
import { requestedPathSet } from "./packState2.js";
import { servedPacksByWorkspace } from "./packState2.js";
import { shaOfText } from "../../../util/handles.js";
import { surfaceFileSha } from "./packState2.js";
import { surfaceRangeShipped } from "./receiptProgress3.js";
import { tokenizeForEpoch } from "../../../state/session.js";

export function tryServeCachedPack(
  workspace: string,
  args: TaskPackArgs,
  fingerprint: string,
): TaskPackResult | undefined {
  const records = servedPacksByWorkspace.get(laneScopedKey(workspace));
  if (records === undefined || records.length === 0) return undefined;
  const extraArgsKey = computeExtraArgsKey(args);
  const requestProfileKey = computeRequestProfileKey(args);
  // Most-recent first: if the same signature was served twice in the window, the
  // freshest capture carries the most up-to-date check ids / contract.
  const lane = currentSessionLane();
  const prev = [...records].reverse().find(
    (r) => r.fingerprint === fingerprint
      && r.extraArgsKey === extraArgsKey
      // F-V13-3: never re-serve another lane's record. A miss here is not a
      // refusal — it falls through to the full recompute this lane is owed.
      && r.lane === lane
      // B2b: an omitted taskProfile is the same request, not a new one.
      && packProfileCompatible(requestProfileKey, r.requestProfileKey),
  );
  if (prev === undefined) return undefined;
  // F-V13-5: the exact-fingerprint hit is the loop's own shape — the same
  // request, so the same fingerprint, so the same stored contract, so the same
  // consumed `next` — and the fingerprint cannot see the execution that
  // happened between the two calls.
  return revalidateRecordToReceipt(
    workspace,
    // G4 (2026-09-08, qref-binding follow-up): thread THIS request's own
    // recovered task binding through the stale-search repair too — same
    // reasoning as the `taskBinding` handed to `revalidateRecordToReceipt`
    // just below.
    receiptRecordWithoutConsumedSearch(workspace, prev, args.taskBinding),
    args.taskQueryRefReplay === true,
    // P1-1: the consumption scope of THIS request, so the receipt can ask the
    // executed-next ledger the same question the dispatcher answered when it
    // recorded the caller's execution of the prescribed next.
    { lane, ...(typeof args.taskBinding === "string" && args.taskBinding !== "" ? { taskBinding: args.taskBinding } : {}) },
  );
}

/**
 * A pathless repeat can retain a certificate earned by this same task's
 * explicitly selected targets. Candidate proposals are never cached evidence.
 * Unlike semantic dedup, this path requires exact query/profile/task identity
 * and the currently installed prepared fence; it cannot resurrect an old act.
 */
export function tryServeCertifiedQueryReceipt(workspace: string, args: TaskPackArgs): TaskPackResult | undefined {
  if (args.forceServe === true || args.taskEpoch === "new"
    || !args.taskBinding || !args.query || args.path || args.symbol || args.paths?.length
    || args.lang !== undefined || (args.surfaceRoles?.length ?? 0) > 0) return undefined;
  const session = getSession(workspace);
  const fence = session.executionFence;
  if (fence === undefined || fence.phase !== "prepared"
    || fence.taskFingerprint !== args.taskBinding
    || session.revokedCertificateIds.has(fence.certificateId)) return undefined;
  const records = servedPacksByWorkspace.get(laneScopedKey(workspace));
  if (records === undefined) return undefined;
  const lane = currentSessionLane();
  const queryIdentity = shaOfText(args.query);
  const profileKey = computeRequestProfileKey(args);
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i]!;
    if (record.lane !== lane || record.taskBinding !== args.taskBinding
      || record.queryIdentity !== queryIdentity || record.requestProfileKey !== profileKey) continue;
    const contract = record.executionContract;
    const certificate = contract?.readiness_certificate;
    if (!recordCertifiedTerminal(contract) || contract?.typestate.phase !== "prepared"
      || certificate === undefined || certificate.id !== fence.certificateId
      || certificate.task_fingerprint !== fence.taskFingerprint
      || contract.typestate.certificate_id !== certificate.id
      || certificate.obligations.length === 0
      || certificate.obligations.some(obligation => obligation.status !== "proved")) continue;
    // A partial fingerprint list is not an unchanged-source proof. Reuse the
    // normal verifier only when every stored source has a captured identity.
    const fingerprinted = new Set(record.fileShas.map(entry => entry.path));
    if (record.surfaces.length === 0 || record.surfaces.some(surface => !fingerprinted.has(surface.path))) continue;
    const receipt = revalidateRecordToReceipt(
      workspace,
      receiptRecordWithoutConsumedSearch(workspace, record, args.taskBinding),
      args.taskQueryRefReplay === true,
      { lane, taskBinding: args.taskBinding },
    );
    if (receipt === undefined) continue;
    const decision = deriveCanonicalTaskDecision(receipt);
    if (decision?.kind === "act-answer" || decision?.kind === "act-edit") return receipt;
  }
  return undefined;
}

/**
 * Read-only preflight for the prepared-fence dispatcher exception. It proves
 * that this exact task_pack will be compacted to pack_unchanged before the
 * fence lets it reach the builder; it never authorizes a recomputed pack.
 */
export function canServeCachedTaskPackReceipt(workspace: string, args: TaskPackArgs): boolean {
  if (queryCandidateSelectionRequired(args, workspace)) {
    return tryServeCertifiedQueryReceipt(workspace, args) !== undefined;
  }
  return tryServeCachedPack(workspace, args, computePackFingerprint(args, workspace)) !== undefined;
}

/**
 * iter-3 F1/F2 shared revalidation: prove `prev` is still safe to re-serve as a
 * compact receipt (every captured surface file byte-unchanged AND the whole
 * inventory-complete workspace_state fingerprint unchanged), then build the
 * receipt. Returns undefined — forcing a full recompute — when any proof fails.
 * Factored out so the EXACT-fingerprint path (tryServeCachedPack) and the
 * SEMANTIC-duplicate path (tryServeSemanticDuplicatePack) apply byte-for-byte
 * identical staleness gates; the only thing that differs between them is HOW
 * `prev` was selected.
 *
 * B5 (2026-08-21 serve-honesty, twin of the tryServeSubsetReceipt C2 fix): a
 * qref REPLAY whose matched record holds a surface still stamped
 * content_completeness:"partial" must never collapse into a compact
 * pack_unchanged receipt here either. The reasoning is identical to
 * tryServeSubsetReceipt's own guard (below) — a replay's premise is "the
 * caller is short on evidence for this exact working set and is asking to see
 * more of it" — but the STRUCTURAL gap is one layer deeper: this path answers
 * from a STORED `ServedPackRecord`, not a freshly-built `TaskPackResult`, and
 * `ServedPackRecord.surfaces` used to carry only {handle,path,range,role} — no
 * field to even ASK whether the record's own surface was ever partial. Now
 * that captureServedPack threads content_completeness/total_lines onto the
 * record (see ServedPackRecord.surfaces), this gate can see what the record
 * itself knows. A wire pack-unchanged receipt (protocol/readFamily.ts's
 * `receiptOf`, case "pack-unchanged") allowlists only handle/prior/path/range/
 * role per evidence entry — there is no slot to RESTATE a partial marker on
 * it — so, exactly as the merged fix chose, the only honest move is to
 * DECLINE the compact receipt and let the caller fall through to a fresh
 * build, whose `content_completeness`/`remaining_ranges`/`total_lines`/
 * `next_call` all travel the normal (non-receipt) wire path honestly.
 *
 * Scoped to REPLAY specifically, exactly like the merged fix: a PLAIN re-ask
 * (isQueryRefReplay:false) that happens to exact-fingerprint-match or
 * semantic-duplicate-match a record with one still-partial peripheral surface
 * is not asking to see more of that surface, so a receipt over it stays a
 * correct, load-bearing "nothing changed" answer (semanticSignalRegression's
 * T05c case, mirrored for this path in servedRecordPartialSurface.spec.ts).
 */
export function revalidateRecordToReceipt(
  workspace: string,
  prev: ServedPackRecord,
  isQueryRefReplay: boolean,
  consumption: ReceiptConsumptionScope = { lane: currentSessionLane() },
): TaskPackResult | undefined {
  // The captured surfaces must actually be verifiable AND unchanged. An empty
  // capture (a no-surface pack) has nothing to re-serve compactly and nothing
  // to prove unchanged — recompute rather than emit an empty acknowledgement.
  if (prev.fileShas.length === 0) return undefined;
  if (isQueryRefReplay && prev.surfaces.some((s) => recordDocSurfaceIsPartial(workspace, s))) {
    return undefined;
  }
  for (const { path: p, sha } of prev.fileShas) {
    if (surfaceFileSha(workspace, p) !== sha) return undefined; // changed → recompute
  }
  // A re-serve is idempotent only for the same workspace state, not merely when
  // the previously surfaced files stayed byte-identical. Otherwise a new/changed
  // unserved implementation could invalidate the falsification result while the
  // compact response kept claiming closure.
  //
  // D2 (F-B2, 2026-08-21): the RECORD side of this equality used to be the
  // CERTIFICATE's fingerprint (`executionContract.workspace_state`), while the
  // current side was recomputed from `prev.surfaces`. Those are hashed over
  // DIFFERENT surface lists whenever a certificate outlives the surfaces it was
  // issued over — a C2 carry-forward clones an earlier pack's contract onto a
  // narrower replay, and trimToCap's byte-budget shed removes surfaces after the
  // contract was built — so for those packs the equality could never hold and
  // the receipt was permanently unreachable (F-B2). The record now carries its
  // OWN capture-time state, so the comparison stops reconstructing the record
  // side lossily. It does NOT get weaker: `recordWorkspaceState` re-hashes every
  // surface file's bytes off live disk and re-walks the inventory on THIS call,
  // so one changed surface byte — or any add/remove/resize anywhere in the
  // workspace — still moves the current fingerprint and declines the receipt.
  // The certificate's own `inventory_complete` gate is kept as-is: a proof
  // issued under an incomplete inventory is a weaker claim and stays
  // receipt-ineligible, and so is a record captured under one.
  const priorWorkspaceState = prev.executionContract?.workspace_state;
  if (priorWorkspaceState?.inventory_complete !== true) return undefined;
  if (prev.workspaceState.inventory_complete !== true) return undefined;
  const inventory = computeWorkspaceInventoryState(workspace);
  if (!inventory.complete) return undefined;
  const currentWorkspaceState = recordWorkspaceState(workspace, prev, inventory);
  if (currentWorkspaceState.fingerprint !== prev.workspaceState.fingerprint) return undefined;
  // P1-1: a record whose read continuation is spent with no bounded read left
  // to name has no readiness verdict worth replaying — re-evaluate the latest
  // state instead of re-serving a past response (see
  // `receiptContinuationDisposition`).
  if (
    receiptContinuationDisposition(
      workspace,
      prev,
      consumption,
      prev.executionContract?.next_call ?? prev.next,
    ).state === "spent"
  ) return undefined;
  // TL142-01C: see `createPendingRecordIsStale`.
  if (createPendingRecordIsStale(workspace, prev)) return undefined;
  // TL142-01B: see `answerRecordPredatesProvenAbsence`.
  if (answerRecordPredatesProvenAbsence(workspace, prev, consumption.taskBinding)) return undefined;
  // FIX-D (TL-06): see `recordPredatesAdditionalServedEvidence`.
  if (recordPredatesAdditionalServedEvidence(workspace, prev)) return undefined;
  // FIX-FC (finding 16): the generic/edit-profile counterpart, scoped away
  // from the answer-profile record the check above already owns — see
  // `recordSupersededByLaterCertifiedTerminal`'s own doc comment.
  if (
    prev.taskProfile !== "answer"
    && recordSupersededByLaterCertifiedTerminal(workspace, prev, consumption.lane)
  ) return undefined;
  return compactReceiptFromRecord(workspace, prev, currentWorkspaceState, consumption);
}

/**
 * iter-3 F2 (semantic-duplicate receipt): the exact-fingerprint dedup
 * (tryServeCachedPack) misses when a re-issue of the SAME request was merely
 * TRUNCATED mid-word by the client (the last epoch token differs) or otherwise
 * tokenizes slightly differently — the forensic case that re-served a full
 * ~20KB pack for zero new content. This recognizes such a near-identical re-ask
 * and serves the SAME compact receipt.
 *
 * The match is deliberately conservative — DISTINCT working-set packs (enum vs
 * backend vs frontend, different concern/paths) must NOT collapse into one
 * another. The strong discriminator is PATH-SUBSET: the new request's explicit
 * paths must be a subset of the prior record's served paths. Token overlap alone
 * is not enough (two different concerns can share a few tokens); the rule is
 * path-subset ∧ HIGH (near-equality) epoch-token overlap ∧ the whole-workspace
 * inventory fingerprint unchanged. Every staleness gate the exact path applies
 * still runs (revalidateRecordToReceipt), so a changed file forces a full serve.
 */
export function tryServeSemanticDuplicatePack(
  workspace: string,
  args: TaskPackArgs,
): TaskPackResult | undefined {
  const records = servedPacksByWorkspace.get(laneScopedKey(workspace));
  if (records === undefined || records.length === 0) return undefined;
  const queryTokens = tokenizeForEpoch(args.query ?? args.symbol ?? args.path ?? "");
  if (queryTokens.length < 2) return undefined; // too little signal to match semantically
  const extraArgsKey = computeExtraArgsKey(args);
  const requestProfileKey = computeRequestProfileKey(args);
  const curPaths = requestedPathSet(args);
  const curPathsKey = curPaths.join(" ");
  const inventory = computeWorkspaceInventoryState(workspace);
  if (!inventory.complete) return undefined;
  const curTokenSet = new Set(queryTokens);
  const curRoles = (args.surfaceRoles ?? []).slice().sort().join("\u0000");
  const lane = currentSessionLane();
  // Most-recent first: prefer the freshest matching record.
  for (const prev of [...records].reverse()) {
    // F-V13-3: a semantic duplicate is duplicate only WITHIN one lane — this
    // path is strictly looser than the exact one (near-token-equality, not
    // identity), so it is the likelier of the two to collapse two agents'
    // distinct working sets into one another's receipt.
    if (prev.lane !== lane) continue;
    // Same "extra" args (path/symbol/lang/limit) — a differing value changes
    // served content, exactly as the exact path requires. B2b: the requested
    // profile is gated separately, so an omitted one still matches.
    if (prev.extraArgsKey !== extraArgsKey) continue;
    if (!packProfileCompatible(requestProfileKey, prev.requestProfileKey)) continue;
    // Same surfaceRoles set — a differing role set is a DIFFERENT working set
    // (it adds required roles / more surfaces), never a mere query truncation.
    if (prev.requestRoles.join("\u0000") !== curRoles) continue;
    // Whole-workspace-unchanged: the record's inventory-complete fingerprint must
    // equal the current one (proves no unserved file moved), same as the subset
    // receipt's guarantee.
    if (prev.inventoryFingerprint === "" || prev.inventoryFingerprint !== inventory.fingerprint) continue;
    // SAME requested (seeded) path set. Query truncation preserves paths exactly,
    // so the requested sets must be EQUAL — not merely the current being a subset
    // of what the prior pack SERVED. This keeps a deliberate re-seed of a DIFFERENT
    // file (even one the earlier pack served as supporting context), and a pathless
    // re-ask against a seeded prior, from collapsing into the wrong receipt.
    if (prev.requestPaths.join(" ") !== curPathsKey) continue;
    // HIGH (near-equality) token overlap — a truncated re-ask shares all-but-the-
    // truncated-tail token with the prior. Require the shared count to dominate
    // BOTH token lists so a small query cannot match a large unrelated record.
    const recTokens = prev.epochTokens;
    if (recTokens.length === 0) continue;
    let shared = 0;
    for (const t of recTokens) if (curTokenSet.has(t)) shared += 1;
    const denom = Math.max(queryTokens.length, recTokens.length);
    if (shared < denom * SEMANTIC_DUP_OVERLAP_RATIO) continue;
    // A pathless re-ask (no explicit paths) rides on token overlap alone, so it
    // must clear a stricter bar: all-but-one current token present in the record.
    if (curPaths.length === 0 && shared < queryTokens.length - 1) continue;
    // F-V13-5: the looser of the two receipt paths repairs its match the same
    // way the exact one does — the staleness is a property of the RECORD, not
    // of how it was selected.
    const receipt = revalidateRecordToReceipt(
      workspace,
      // G4 (2026-09-08, qref-binding follow-up): same fix as the exact-
      // fingerprint door (tryServeCachedPack) — thread this request's own
      // recovered task binding through the stale-search repair.
      receiptRecordWithoutConsumedSearch(workspace, prev, args.taskBinding),
      args.taskQueryRefReplay === true,
      // P1-1: same consumption scope as the exact-fingerprint door — the
      // staleness is a property of the RECORD, not of how it was selected.
      { lane, ...(typeof args.taskBinding === "string" && args.taskBinding !== "" ? { taskBinding: args.taskBinding } : {}) },
    );
    if (receipt !== undefined) return receipt;
  }
  return undefined;
}

/**
 * R-D2 (2026-09-21, TL-06 REBUILD class, item A rule 2, plan §8.1) — WHEN THE
 * PATHLESS SEED RECORD IS DECLINED BECAUSE THIS TASK HAS MOVED ON, RESTATE
 * THE CERTIFICATE IT MOVED ON TO, INSTEAD OF REBUILDING FROM THE SEED SHAPE.
 *
 * THE DEFECT (arch-map-b.md §1 Chip 2, R-B3 probe chain): one epoch + lane —
 * pathless query -> `discover` (the SEED record, fingerprinted over EMPTY
 * paths); the caller runs the seed's own `next` (explicit `targets` +
 * `task.handle`) and THIS SAME task certifies `act.answer`, captured as its
 * OWN record under a DIFFERENT fingerprint (`computePackFingerprint` hashes
 * `paths`, and the follow-up carried some); a bare `{qref}` / `task.handle`
 * resume re-resolves to the ORIGINAL pathless query text, so
 * `tryServeCachedPack` / `tryServeSemanticDuplicatePack` can only ever
 * rediscover the SEED record — `tryServeSemanticDuplicatePack`'s own
 * `requestPaths` equality is the reviewed guard that "a pathless re-ask …
 * must not collapse" into a record seeded WITH paths, and it is exactly as
 * strict in reverse. `recordPredatesAdditionalServedEvidence` (FIX-D)
 * correctly declines the now-stale seed once this task has served evidence
 * the seed never captured — but the two callers above then simply give up
 * and force a full REBUILD from the pathless seed shape, which re-derives
 * `result.surfaces` from scratch and can be strictly poorer than the
 * certificate this task already earned (measured: a REBUILD whose own
 * pathless auto-discovery finds no candidate surface at all regresses
 * `behavior-body`/`surface-content` to "uncovered" and a downstream
 * capability-gap arm invents an unrelated `tl_search_files` dead end).
 *
 * THE FIX. After both existing lookups decline, and ONLY because the decline
 * was FIX-D's "newer evidence exists" verdict (never a genuinely changed
 * file, an uncertified pending create, or a proven-absence supersession —
 * their own declines still force the ordinary rebuild, unchanged), search
 * this SAME bounded per-workspace/per-lane record window — already sorted
 * oldest-first, so positions AFTER the seed's own are chronologically LATER —
 * for the freshest record of the SAME TASK (epoch tokens overlapping the
 * seed's own; `computePackFingerprint`/`requestPaths` do not need to match —
 * that is the whole point, this is deliberately a DIFFERENTLY-SHAPED call of
 * the same task) that reached a CERTIFIED terminal decision
 * (`recordCertifiedTerminal`: `act.answer` or `act.edit`, `discovery_complete`,
 * a bound certificate id). That candidate is then run through the IDENTICAL
 * `revalidateRecordToReceipt` staleness gate the two lookups above use —
 * every served file byte-unchanged, the whole-workspace inventory fingerprint
 * unchanged, no read continuation spent to nothing — so a candidate that
 * happens to ALSO be stale (a file changed after it was captured) is declined
 * exactly as honestly, falling through to the ordinary rebuild.
 *
 * SAME TASK, NEVER A NEW QUERY (the reviewed constraint's other half). This
 * function is reachable ONLY after `tryServeCachedPack` already matched
 * `seed` by EXACT fingerprint — `computePackFingerprint` hashes the
 * normalized query tokens (plus paths/roles/workspace), so that match is
 * itself the proof this call's own query is not a "genuinely different
 * pathless re-ask": a bare `{qref}`, an explicit/recovered `task.handle`
 * continuation, and a plain query resend with byte-identical text all
 * fingerprint identically and are equally "this same request, asked again"
 * (`concernStatusPolicyMatrix.spec.ts`'s "restate" chain shape — no `qref`,
 * no `task.handle` at all — pins that a plain resend gets the SAME
 * monotonicity as a `qref`/`task.handle` resume). A caller that changes the
 * query text produces a DIFFERENT fingerprint and never reaches `seed`, hence
 * never reaches this function at all — the exact-match precondition IS the
 * "never a new query" guard, so no separate continuation flag is checked
 * here.
 *
 * SELF-LIMITING like its siblings: this never writes a new record, so a
 * later identical resume finds the SAME two candidates in the SAME order.
 *
 * FIX-FC (eval-0927 review finding 16, 2026-09-27) ADDENDUM: the seed-decline
 * test now also accepts `recordSupersededByLaterCertifiedTerminal` — the
 * SAME defect shape, live for a `taskProfile !== "answer"` seed (an
 * edit-shaped task whose ambiguity was resolved by the B1c pending-candidate
 * bind, then the bind's own success cleared that memory before a SECOND
 * identical replay could reuse it). The candidate search below mirrors the
 * seed check's own profile: an answer-profile seed still searches only
 * answer-profile candidates (unchanged), and a generic-superseded seed
 * searches only non-answer candidates — the two searches never cross.
 */
export function tryServeSupersedingCertifiedRecord(
  workspace: string,
  args: TaskPackArgs,
  fingerprint: string,
): TaskPackResult | undefined {
  const records = servedPacksByWorkspace.get(laneScopedKey(workspace));
  if (records === undefined || records.length === 0) return undefined;
  const extraArgsKey = computeExtraArgsKey(args);
  const requestProfileKey = computeRequestProfileKey(args);
  const lane = currentSessionLane();
  let seedPos = -1;
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]!;
    if (
      r.fingerprint === fingerprint
      && r.extraArgsKey === extraArgsKey
      && r.lane === lane
      && packProfileCompatible(requestProfileKey, r.requestProfileKey)
    ) {
      seedPos = i;
      break;
    }
  }
  if (seedPos < 0) return undefined;
  const seed = records[seedPos]!;
  // FIX-FC (finding 16): `seedIsGenericSuperseded` is the generic/edit-profile
  // sibling of the answer-only `recordPredatesAdditionalServedEvidence` decline
  // just below — see `recordSupersededByLaterCertifiedTerminal`'s own doc
  // comment for the full defect (a bare-qref replay whose fingerprint reverts
  // to a stale pathless SEED once the pending-candidate memory that had
  // resolved it is consumed). Exactly one of the two fires per `seed`
  // (mutually exclusive on `taskProfile`), so the answer-profile path this
  // function already served is untouched.
  const seedIsGenericSuperseded = seed.taskProfile !== "answer"
    && recordSupersededByLaterCertifiedTerminal(workspace, seed, lane);
  if (!recordPredatesAdditionalServedEvidence(workspace, seed) && !seedIsGenericSuperseded) return undefined;
  for (let i = records.length - 1; i > seedPos; i--) {
    const candidate = records[i]!;
    if (candidate.lane !== lane) continue;
    // The generic-superseded seed's own candidate search accepts a candidate
    // of the SAME (non-answer) profile — the answer-only search below is
    // unchanged for an answer-profile seed.
    if (seedIsGenericSuperseded ? candidate.taskProfile === "answer" : candidate.taskProfile !== "answer") continue;
    if (!epochsOverlap(candidate.epochTokens, seed.epochTokens)) continue;
    if (!recordCertifiedTerminal(candidate.executionContract)) continue;
    const receipt = revalidateRecordToReceipt(
      workspace,
      receiptRecordWithoutConsumedSearch(workspace, candidate, args.taskBinding),
      args.taskQueryRefReplay === true,
      { lane, ...(typeof args.taskBinding === "string" && args.taskBinding !== "" ? { taskBinding: args.taskBinding } : {}) },
    );
    if (receipt !== undefined) return receipt;
  }
  return undefined;
}

/**
 * iter-2 W1 (subset case): a freshly-built pack whose every code-bearing surface
 * (path+range) is already resident-and-unchanged from earlier same-epoch serves
 * in this session is re-serving bodies the caller already holds. When the
 * workspace is proven unchanged (same inventory-complete workspace_state
 * fingerprint the exact-dup path uses), return the compact receipt naming those
 * resident handles instead. Conservative: exact (path,range) membership, and
 * only when EVERY served surface is covered — a genuinely new surface falls
 * through to a normal full serve.
 */
export function tryServeSubsetReceipt(
  workspace: string,
  result: TaskPackResult,
  epochTokens: readonly string[],
  isQueryRefReplay: boolean,
  // G4 (2026-09-08, qref-binding follow-up): the CURRENT request's own
  // recovered task binding — see receiptContractWithoutConsumedSearch's own
  // parameter doc comment. Threaded from the call site's `opts.args.taskBinding`.
  taskBinding?: string,
): TaskPackResult | undefined {
  if (result.pack_unchanged === true) return undefined;
  if ((result.surfaces as TaskPackResultSurface[]).some(isArtifactTaskPackSurface)) return undefined;
  // Scope-incomplete packs still carry load-bearing role/concern guidance.
  // A body-partial pack with no such disclosure is different: the completion
  // projection correctly keeps its optional zoom open, while an unchanged
  // plain re-ask may still receipt the exact resident window. qref replays are
  // fenced separately below because they explicitly request that disclosure.
  const contentOnlyPartial = result.coverage === "partial"
    && result.coverage_reason === undefined
    && result.missing.length === 0
    && (result.missing_required_surfaces?.length ?? 0) === 0
    && codeTaskPackSurfaces(result.surfaces)
      .some((surface) => surface.content_completeness === "partial");
  if (result.coverage !== "complete" && result.coverage !== "focused" && !contentOnlyPartial) return undefined;
  // C2 byte-cap-fix follow-up (2026-08-21): a qref REPLAY (taskQueryRefReplay)
  // whose carried-forward working set still holds a surface with
  // content_completeness:"partial" — the doc-sliver affordance's own honesty
  // marker (applyDocSliverHonesty, above) — must never collapse into this
  // receipt. The replay's whole premise is "the caller is short on evidence
  // for this exact working set and is asking to see more of it" (C2's own
  // carryForwardCertifiedWorkingSet docstring), and ServedPackRecord.surfaces
  // (and this function's own ad-hoc record below) carry only
  // {handle,path,range,role}: a compact pack_unchanged receipt has no field to
  // restate the partial marker/total_lines/next_call in. Collapsing such a
  // reply here silently retracts the partial disclosure L1/C1/C2 exist to
  // make honest — the same false closure applyDocSliverHonesty's own
  // `pack_unchanged` guard refuses to create, approached from the other
  // direction (a pack that already earned the marker, reaching this
  // compaction afterward instead of before). Scoped to a REPLAY specifically
  // (not every partial-content pack): a plain re-ask of a broader multi-file
  // working set that happens to include one still-partial peripheral doc
  // — semanticSignalRegression.spec.ts's T05c case — is not asking to see
  // more of that doc, so a receipt over it stays a correct, load-bearing
  // "nothing changed" answer.
  if (
    isQueryRefReplay
    && codeTaskPackSurfaces(result.surfaces).some((s) => s.content_completeness === "partial")
  ) return undefined;
  const bodySurfaces = codeTaskPackSurfaces(result.surfaces).filter(
    (s) => s.code !== undefined || s.code_unchanged !== undefined,
  );
  if (bodySurfaces.length === 0) return undefined;
  if (result.execution_contract?.workspace_state === undefined) return undefined;
  const records = servedPacksByWorkspace.get(laneScopedKey(workspace));
  if (records === undefined || records.length === 0) return undefined;
  // v0.15.1 runtime review TL-REVIEW-5 (2026-10-06): a receipt restates the
  // bytes, and the `pack-unchanged` wire form has no member for a decision —
  // `readFamily.ts`'s projector keeps the addressing and drops the rest. That
  // is right when the decision did not move, and wrong when THIS pack is the
  // one that certified it: the reviewer's "Explain the timeout, maximum
  // retries, and retryable status codes of retry in http.ts." ran the
  // `discover`'s own bundle `next`, the re-pack certified `act.answer` over
  // the very bytes the first pack served, and the caller received
  // `pack-unchanged` with coverage complete and no decision at all — a chain
  // that never said "answer now". A terminal certificate no earlier pack of
  // this lane carried is news, so the fresh pack (its already-served windows
  // still restated as `prior`) ships with its decision instead. A plain
  // re-ask after that finds the certificate on the stored record and still
  // gets this compact receipt.
  const certificateIdOf = (contract: TaskExecutionContract | undefined): string | undefined =>
    contract?.readiness_certificate?.id ?? contract?.typestate.certificate_id;
  const freshCertificateId = certificateIdOf(result.execution_contract);
  const receiptLane = currentSessionLane();
  if (
    freshCertificateId !== undefined
    && recordCertifiedTerminal(result.execution_contract)
    && !records.some((rec) => rec.lane === receiptLane && certificateIdOf(rec.executionContract) === freshCertificateId)
  ) return undefined;
  // Whole-workspace-unchanged proof: the CURRENT inventory-complete fingerprint
  // must equal one a prior serve captured. This rules out a new/changed UNSERVED
  // file (which per-surface shas alone cannot see) silently invalidating the
  // pack — exactly the guarantee the exact-dup path's inventory gate gives.
  const inventory = computeWorkspaceInventoryState(workspace);
  if (!inventory.complete) return undefined;
  // The union of (path,range) served under an OVERLAPPING epoch by a record whose
  // whole-workspace inventory still matches, each file proven byte-unchanged.
  const resident = new Set<string>();
  for (const rec of records) {
    if (rec.inventoryFingerprint === "" || rec.inventoryFingerprint !== inventory.fingerprint) continue;
    if (!epochsOverlap(rec.epochTokens, epochTokens)) continue;
    const shaByPath = new Map(rec.fileShas.map(({ path: p, sha }) => [p, sha]));
    for (const s of rec.surfaces) {
      const capturedSha = shaByPath.get(s.path);
      if (capturedSha === undefined) continue; // unproven file — cannot claim unchanged
      if (surfaceFileSha(workspace, s.path) !== capturedSha) continue; // changed
      // v0.15.1 runtime review (2026-10-06): a record lists every surface its
      // pack ADDRESSED, the ones a byte cap withheld whole included, and a
      // receipt over such a row claimed `prior` for bytes no call had sent.
      // A window is resident when the served-range ledger proves it shipped,
      // or when the record itself says part of it shipped (a partially
      // served body: `content_completeness:"partial"` with only part of the
      // range left `remaining`) — `compactReceiptFromRecord` still judges
      // each row's `prior` by the ledger alone.
      if (!surfaceRangeShipped(workspace, s.path, s.range) && !recordSurfacePartlyServed(s)) continue;
      resident.add(`${s.path}\u0000${s.range}`);
    }
  }
  if (resident.size === 0) return undefined;
  if (!bodySurfaces.every((s) => resident.has(`${s.path}\u0000${s.range}`))) return undefined;
  const fileShas: Array<{ path: string; sha: string }> = [];
  const seen = new Set<string>();
  for (const s of result.surfaces) {
    if (seen.has(s.path)) continue;
    seen.add(s.path);
    const sha = surfaceFileSha(workspace, s.path);
    if (sha !== undefined) fileShas.push({ path: s.path, sha });
    if (fileShas.length >= MAX_FINGERPRINT_FILES) break;
  }
  const record: ServedPackRecord = {
    // Synthetic, never stored (see the workspaceState note below), but the
    // field is required so no record-builder can forget it — and the honest
    // value is the lane this subset receipt is being served INTO.
    lane: currentSessionLane(),
    fingerprint: "",
    extraArgsKey: "",
    requestProfileKey: "auto",
    surfaces: result.surfaces.map((s) => ({
      handle: s.handle,
      path: s.path,
      range: s.range,
      role: s.role,
      handleIdentity: handleTable.get(s.handle) ? { ...handleTable.get(s.handle)! } : undefined,
      // B5/P1-6: keep this ad-hoc record's fields accurate too — never stored
      // (see the "never F2-matched" note below), but compactReceiptFromRecord's
      // shared surface-projection reads them uniformly regardless of which
      // caller built the record.
      ...(s.content_completeness !== undefined ? { content_completeness: s.content_completeness } : {}),
      ...(s.total_lines !== undefined ? { total_lines: s.total_lines } : {}),
      ...(s.remaining_ranges !== undefined ? { remaining_ranges: [...s.remaining_ranges] } : {}),
    })),
    // D2 (F-B2): this record is synthetic and never stored, so it never reaches
    // revalidateRecordToReceipt's freshness equality — but the field is
    // deliberately REQUIRED on ServedPackRecord so no future record-builder can
    // forget it. The honest value here is the freshly-built pack's own
    // workspace_state, which is also what this call hands
    // compactReceiptFromRecord below (non-undefined by the guard above).
    workspaceState: result.execution_contract!.workspace_state!,
    coverage: result.coverage,
    coverageReason: result.coverage_reason,
    coverageBasis: result.coverage_basis,
    route: result.route ? { ...result.route } : undefined,
    // TL142-01C: the THIRD receipt door, and it dropped the create route the
    // same way the stored-record door did. This path compacts a FRESHLY BUILT,
    // already-certified pack, so omitting `create_target` here turned a
    // just-earned `act.edit` into `await_input:"no-grounded-call-remains"` —
    // the certificate survived, the frontier the create IS did not, and
    // `projectTaskDecision`'s act.edit floor needs both.
    createTarget: result.create_target ? { ...result.create_target } : undefined,
    requestItemAbsences: result.request_item_absences ? result.request_item_absences.map((a) => ({ ...a })) : undefined,
    executedSearchSequence: executedSearchResultSequence(workspace, currentSessionLane(), taskBinding),
    epochTokens: [...epochTokens],
    requestRoles: [], // synthetic subset-receipt record — never stored, so never F2-matched
    requestPaths: [],
    inventoryFingerprint: inventory.fingerprint,
    missing: [...result.missing],
    next: result.next,
    profileBinding: result.profile_binding,
    taskProfile: result.task_profile,
    // F-V13-5, belt-and-braces on the third door: this path compacts a FRESHLY
    // BUILT pack, so `suppressNonProgressingNextCall` has normally repaired a
    // consumed next already — but the compaction is otherwise free to
    // re-publish whatever contract survived it, and the identity-preserving
    // repair costs nothing when there is nothing to repair.
    //
    // G4 (2026-09-08, qref-binding follow-up): pass `undefined` explicitly for
    // `recordLane` (this synthetic record's own default already matches) so
    // the 4th positional `taskBinding` argument reaches its intended
    // parameter — see receiptContractWithoutConsumedSearch's own doc comment.
    executionContract: receiptContractWithoutConsumedSearch(workspace, result.execution_contract, undefined, taskBinding),
    contentSufficiency: result.content_sufficiency,
    checkIds: (getPackChecks(workspace)?.checks ?? []).map((c) => c.id),
    fileShas,
  };
  return compactReceiptFromRecord(workspace, record, result.execution_contract!.workspace_state!);
}

// ===========================================================================
// iter-2 W2 / W4 / W5 orchestration — applied at the shared dedupeTrimAndPersist
// exit so every pack flow reports identically.
// ===========================================================================

/** Every value `classifySurface` can return — the vocabulary `missing` uses for a ROLE gap. */
export const SURFACE_ROLE_NAMES: ReadonlySet<string> = new Set(Object.keys(SURFACE_ROLE_PRIORITY));
