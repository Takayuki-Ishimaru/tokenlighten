// servedStateAndEdits — extracted implementation; imports point to the owning modules.
import * as fs from "fs";
import * as path from "path";
import type { NodePackageManifestLike } from "../../../util/nodeTestRunnability.js";
import type { PendingPackBookings } from "./wiringEvidence2.js";
import type { TaskPackArgs } from "../model.js";
import type { TaskPackResult } from "../model.js";
import type { TaskProfile } from "@tokenlighten/types";
import { FileReadCache } from "./packBasics2.js";
import { UNWRITABLE_ENCODING_RISK_PREFIX } from "./queryIntent4.js";
import { VERIFY_NO_INSTALL_SUGGESTION } from "./servedStateAndEdits2.js";
import { anyFileExistsCached } from "../../../util/packServeLog.js";
import { captureServedPack } from "./packState4.js";
import { certifiedWorkingSets } from "./epochContract3.js";
import { classifyNodeTestRunnability } from "../../../util/nodeTestRunnability.js";
import { codeTaskPackSurfaces } from "../artifactSections.js";
import { computePackFingerprint } from "./packState2.js";
import { dominantRootOf } from "./surfaceMaterialization.js";
import { exactReplacementFromQuery } from "./servedStateAndEdits2.js";
import { findNearestNpmScripts } from "./surfaceMaterialization.js";
import { fitsInCap } from "./packTrimming2.js";
import { hasExplicitIndependentConcernMarker } from "./roleAndConcernScope2.js";
import { hasIndependentEditConcernClauses } from "./roleAndConcernScope2.js";
import { hasServedCode } from "./wiringEvidence2.js";
import { isWithin } from "../../../util/safePath.js";
import { laneScopedKey } from "../../../util/laneKey.js";
import { nativeVerificationVerdict } from "./servedStateAndEdits2.js";
import { nodeModulesReachableFrom } from "../../../util/verificationPack.js";
import { pendingOwnServedSurfaces } from "./readinessObligations2.js";
import { projectRootOf } from "../../locator/locateTaskContext.js";
import { readCached } from "./packBasics2.js";
import { recordReadOnlyServedSurfaces } from "./epochEvidence.js";
import { recordServedEditAdmissibility } from "../../../state/session.js";
import { recordServedSurfaces } from "../../../util/packServeLog.js";
import { recordWithheldEditAddresses } from "../../../state/session.js";
import { rememberCertifiedWorkingSet } from "./epochContract2.js";
import { requestItemLeads } from "../requestItems.js";
import { resolveOldValueReplacement } from "./servedStateAndEdits2.js";
import { resolveReal } from "../../../util/safePath.js";
import { safeResolve } from "../../../util/safePath.js";
import { shippedSurfaces } from "./wiringEvidence.js";
import { shouldAttachVerification } from "../../../util/packServeLog.js";
import { statKindCached } from "../../../util/packServeLog.js";
import { surfaceAlreadyCoversWholeFile } from "../../../util/surfaceServedCoverage.js";
import { surfaceServedNulStripped } from "./changeAndReadinessEvidence.js";
import { surfaceToolchainDomain } from "../../../util/verificationPack.js";

/**
 * FX-J/FX-K — THE SINGLE BOOKING PASS, run at `dedupeTrimAndPersist`'s exit,
 * after the SF pre-booking seam and after every shedding phase, in BOTH flag
 * states (FX-K collapsed the flag-selected pre-seam site into this one).
 *
 * Every producer that asserts something about what this response served reads
 * ONE projection, `shippedSurfaces(returned)`, over the pack the caller
 * actually receives. A surface whose body this response did not send —
 * withheld by the SF seam, stripped by `trimToCap` Phase E, or spliced out by
 * Phase F — therefore contributes no body, no edit authority (union, and so
 * the NEXT pack's `priorEpochActionFrontier` and its certificate
 * `action_frontier`), no certified-context claim, and no served-range
 * coverage. It stays addressable by handle for READS — a zoom re-serves its
 * bytes without a false `prior`, because nothing here booked them.
 *
 * FX-K's CARRIED-FORWARD GAP, CLOSED BY FX-L (2026-09-03, ruling (r)). The
 * certificate is a SECOND write authority: `session.ts`'s
 * `recordExecutionContract` lifts `action_frontier` ∪ `evidence_handles` (and
 * the evidence paths) into the same admissible union, and the certificate is
 * rebuilt post-`trimToCap` but before the last shedding rungs, so it could
 * still name a surface this response did not send. MEASURED, flag off:
 *
 *   tl_read_file { query:<generic pricing change>, budget:{bytes:6144} }
 *     → five bodyless rows; one of them (`src/anchor.ts`) is in the certificate
 *   tl_edit_file { handle:<that row's handle>, … }        → edit.applied
 *   tl_edit_file { handle:<any other bodyless row>, … }   → refusal
 *   tl_edit_file { path:<any of them>, … }                → refusal
 *
 * FX-K closed the PATH form and every handle the certificate does not list; the
 * remaining handle is closed at the GATE, not here, and this pass supplies the
 * evidence it needs — `recordWithheldEditAddresses` below.
 *
 * WHY THE REPAIR IS NOT A FILTER IN THIS FUNCTION, with the attempt that was
 * measured and reverted. Filtering the certificate's own entries down to
 * `shipped` empties it whenever the pack shipped nothing — and an edit-terminal
 * certificate with no handles, no action paths, no evidence and an empty union
 * hits `recordExecutionContract`'s 2026-07-25 T13 escape hatch, which CLEARS
 * the fence on the stated ground that "a refuse-only fence is strictly worse
 * than no fence: leave edits ungated instead". End to end that turned four
 * refusals into four `edit.applied`, including the never-packed control: the
 * narrowing OPENS edits in exactly the case it was meant to close. FX-L
 * therefore teaches the GATE the difference between "this session never served
 * anything" (the hatch keeps reading the RAW certificate, so it fires exactly
 * where it always did) and "this response emitted addresses and withheld their
 * bytes" (per-address residency, written below; the fence stays and refuses,
 * with a recoverable `next`).
 *
 * THE STATE CHANGE THIS MAKES ON THE DEFAULT PATH IS DELIBERATE (round-15
 * finding 1). `8ea1eb52` booked the pre-trim list, so a cap-overflowing pack
 * granted write authority over files it shipped no bytes for; a `budget.bytes`
 * read plus one `tl_edit_file` proved it end to end. The T09/T10 regression class
 * ("the gate refuses a handle this server itself served") is guarded from the
 * other side: `shippedSurfaces` keeps every surface that ships WITH a body,
 * and `hasServedCode` deliberately counts a `code_unchanged` restatement,
 * because the caller does hold those exact bytes.
 */
export function bookShippedPackServeState(
  workspace: string,
  returned: TaskPackResult,
  effectiveQuery: string,
  bookings: PendingPackBookings,
  /**
   * The full working set the certificate was issued over, when this exit is
   * the one that may retain it. `undefined` on the byte-budget fallback exit,
   * which has never touched the certified working set (`8ea1eb52` did not
   * either) — adding it there would be a state change on the default path.
   */
  certified: { trimmed: TaskPackResult } | undefined,
  capture: { args: TaskPackArgs; captureTarget: TaskPackResult } | undefined,
): void {
  // THE projection. Computed once, from the final pack, and used by every
  // producer below.
  // Auxiliary rows do not become cumulative role coverage, a certified working
  // set, or primary edit bookings: `shippedSurfaces` leaves them out.
  // captureServedPack retains actual source; the existing soft-frontier policy
  // can ground a later explicit edit in it.
  const shipped = shippedSurfaces(returned);
  if (bookings.pack !== undefined) pendingOwnServedSurfaces.delete(bookings.pack);

  // Record only CHANGE-pack surfaces (an answer pack has no edit closure to
  // cumulatively complete a later change pack from, and its read-only surfaces
  // should not stand in for edit-served roles).
  if (bookings.cumulativeEligible && shipped.length > 0) {
    recordServedSurfaces(
      workspace,
      workspace,
      // C1 (DESIGN-v0.15 §12 rows 82-84, R31-FIX regression): thread the
      // range-aware "already amounts to a whole-file re-pack" verdict onto
      // the epoch ledger entry, computed once here where the full surface
      // (range/content_completeness/remaining_ranges) is still at hand — see
      // util/surfaceServedCoverage.ts. A LATER call's
      // `finalizePackServeState` filters on it before stamping
      // `epochServedPaths`, so a path an earlier call only partially (and
      // re-packably) served is not mistaken for closed.
      shipped.map((s) => ({
        path: s.path,
        role: s.role,
        handle: s.handle,
        fullyServed: surfaceAlreadyCoversWholeFile(s),
      })),
      bookings.epochTokens,
    );
  } else if (shipped.length > 0) {
    // WP-S11: the declared-answer complement. The comment above says why these
    // surfaces must not enter the cumulative log — an answer pack has no edit
    // closure to complete a later change pack from. It does not follow that
    // this task should forget its own bodies: record them in the same-task
    // READ-ONLY view instead, which only `epochServedEvidence` consults, so a
    // re-pack of THIS task stops re-minting obligations pack 1 discharged.
    // Same projection (`shipped`), same epoch binding, no write authority.
    recordReadOnlyServedSurfaces(workspace, shipped, bookings.epochTokens);
  }

  // Cache only after the final returned projection. An awaiting-input or
  // receipt downgrade must never leave its earlier prepared certificate
  // available for qref carry-forward; when the returned contract remains
  // prepared, retain trimmed's full working set rather than a compact receipt.
  if (certified !== undefined) {
    if (returned.execution_contract?.typestate.phase === "prepared") {
      // FX-K (round-15 finding 3): the SAME `shipped` list, never a second
      // projection over `trimmed`. `certified.trimmed` supplies the contract
      // and the coverage/route fields the replay restores; the certified PATHS
      // are exactly what this response sent bytes for.
      rememberCertifiedWorkingSet(workspace, certified.trimmed, effectiveQuery, shipped);
    } else {
      // The map is one certificate per workspace. A non-prepared final result
      // supersedes any earlier certificate for this task/session; retaining it
      // would let a later qref replay resurrect authority the current evidence
      // just withdrew.
      certifiedWorkingSets.delete(laneScopedKey(path.resolve(workspace)));
    }
  }

  // A1 (2026-08-01 signal5-2): EVERY content-bearing served surface — answer
  // packs included — grounds a later edit of that file. Feed the edit gate's
  // admissible union at serve time; ready-certificate install alone left
  // partial/discovery-pack surfaces permanently outside the frontier, so the
  // gate refused handles this server itself had served (T09 enums.ts).
  if (shipped.length > 0) {
    recordServedEditAdmissibility(workspace, {
      handles: shipped
        .map((s) => s.handle)
        .filter((h): h is string => typeof h === "string" && h.length > 0),
      paths: shipped.map((s) => s.path),
    });
  }

  // FX-L (2026-09-03, ruling (r)) — THE COMPLEMENT OF THE SAME PROJECTION.
  //
  // FX-K withdrew the union/log/certified-set bookings for a surface this
  // response shipped no body for. The certificate is a SECOND write authority
  // and the booking pass cannot narrow it (filtering it here empties it, which
  // trips session.ts's 2026-07-25 T13 escape hatch and ungates every edit —
  // measured and reverted; see this function's doc). What the booking pass CAN
  // do is state the fact the gate was missing: these addresses were EMITTED and
  // their bytes were WITHHELD. `recordExecutionContract` reads exactly that to
  // tell "this session never served anything" (no residency ⇒ today's
  // behaviour, T13 hatch intact) from "this response emitted addresses and
  // withheld their bytes" (⇒ the certificate lift refuses, with a recovery
  // `next`).
  //
  // Recorded AFTER the shipped booking above, deliberately: residency is
  // monotone toward "shipped", so a path with one body-bearing row and one
  // bodyless row (the ordinary multi-surface file) resolves to shipped, and a
  // handle whose file shipped under a different id inherits that answer.
  //
  // THE `fast_path` EXCEPTION, AND WHY IT IS NOT A HOLE. A proved
  // `single-site-unique-match` pack deliberately ships its surface WITHOUT a
  // body (`readCodeTaskPack.spec.ts`: "emits an explicit guarded receipt only
  // for one served, writable exact replacement" asserts `code` is undefined) —
  // that IS the economy: the SERVER read the file, proved exactly one
  // occurrence, and hands back the literal `search`/`replace` plus a content
  // `sha` and `precondition:"unique-match"`, so the caller writes one proven
  // edit without paying for the bytes. Calling that address "withheld" would
  // refuse the very edit the same response certified, in one call, with no
  // recovery worth the name. It is excluded, not marked shipped: residency
  // stays `undefined`, which is the "no positive evidence either way" answer,
  // and the write is still gated by the fast-path proof itself.
  const fastPathHandle = returned.fast_path?.handle ?? "";
  const fastPathPath = returned.fast_path?.path ?? "";
  const withheldSurfaces = codeTaskPackSurfaces(returned.surfaces).filter((s) =>
    !hasServedCode(s) && s.path !== fastPathPath && s.handle !== fastPathHandle);
  if (withheldSurfaces.length > 0) {
    recordWithheldEditAddresses(workspace, {
      handles: withheldSurfaces
        .map((s) => s.handle)
        .filter((h): h is string => typeof h === "string" && h.length > 0),
      paths: [...new Set(withheldSurfaces.map((s) => s.path))],
    });
  }

  if (capture !== undefined) {
    // §3 residual: dedup baseline vs. wire — `captureTarget` is the fingerprint
    // baseline (see dedupeTrimAndPersist), `returned` is what the caller
    // actually receives and therefore what the served-range ledger may book
    // (`packServedSpans` books a line only from a surface that still carries a
    // body, so a withheld one contributes nothing by construction).
    captureServedPack(
      workspace,
      capture.args,
      computePackFingerprint(capture.args, workspace),
      capture.captureTarget,
      returned,
    );
  }
}

/**
 * IMPROVEMENT A part 4: when >=2 edit-frontier surfaces are known and the pack
 * is ready to edit, tell the caller to batch every known edit site into ONE
 * edits[] call. Short, appended once to the edit route's reason.
 */
export function annotateBatchEditFrontier(result: TaskPackResult): void {
  if (result.route?.action !== "edit_from_handles") return;
  const editSites = codeTaskPackSurfaces(result.surfaces).filter((s) => s.required !== false);
  if (editSites.length < 2) return;
  if (/one edits\[\] call/.test(result.route.reason)) return;
  result.route = {
    ...result.route,
    reason: `${result.route.reason}; batch all ${editSites.length} known edit sites into ONE edits[] call (multi-file allowed)`,
  };
}

export function attachSingleSiteUniqueMatchFastPath(
  result: TaskPackResult,
  workspace: string,
  query: string,
  profile: TaskProfile,
  cache?: FileReadCache,
  /**
   * True when the CALLER named this exact file (`paths`/`targets`) rather
   * than the server locating it. Only then does the normal evidence surface
   * "already carry" the body in the sense the clearing comment below
   * assumes -- see that comment for why the two cases must diverge (design
   * v0.15 §7 / R5: a literal-first DISCOVERED source has never appeared on
   * any wire yet, so its local window must ship even when a fast_path also
   * proves the edit).
   */
  hasCallerSuppliedLocation = false,
): void {
  delete result.fast_path;
  if (profile !== "generic" || result.route?.action !== "edit_from_handles") return;
  if (result.coverage !== "focused" && result.coverage !== "complete") return;
  if (result.missing.length !== 0 || result.concern_ambiguities?.length) return;
  if (hasIndependentEditConcernClauses(query) || hasExplicitIndependentConcernMarker(query)) return;
  // Field-eval fix (2026-08-27, v0.12 wave D2): "X, and ALSO refactor Y" used
  // to slip past this fence -- the optional connector only ever recognized a
  // bare "and", so an interposed filler word left the verb unreached. Found
  // via T2's own fail-open test, which reuses this exact fence.
  if (/(?:,|;|\n)\s*(?:and\s+)?(?:also\s+)?(?:fix|add|implement|change|replace|rename|refactor|wire|connect|update|create)\b/iu.test(query)
    || /(?:、|。|\n)\s*(?:さらに|加えて)?[^\n]{0,80}(?:修正|追加|実装|変更|置換|改名|接続|作成)/u.test(query)) return;
  const contract = result.execution_contract;
  if (contract?.typestate.phase !== "prepared" || !contract.typestate.allowed_actions.includes("edit")) return;
  const parsed = exactReplacementFromQuery(query);
  if (parsed === undefined) return;
  const surfaces = codeTaskPackSurfaces(result.surfaces);
  if (surfaces.length !== 1 || result.surfaces.length !== 1) return;
  const surface = surfaces[0]!;
  if (surface.required === false || surface.code === undefined) return;
  const replacement = "identifierOldValue" in parsed
    ? resolveOldValueReplacement(surface.code, parsed.identifierOldValue, parsed.replace)
    : parsed;
  // A fast-path receipt repeats both payloads; keep it genuinely small even
  // where the surrounding pack has headroom. Large replacements retain the
  // normal handle-first path and cannot create a post-trim cap inversion.
  if (replacement === undefined || Buffer.byteLength(replacement.search, "utf8") + Buffer.byteLength(replacement.replace, "utf8") > 4096) return;
  if (!surface.code.includes(replacement.search)) return;
  const resolved = safeResolve(surface.path, workspace);
  if (resolved === undefined) return;
  let real: string;
  try {
    real = fs.realpathSync(resolved);
    if (!isWithin(real, resolveReal(workspace)) || !fs.statSync(real).isFile()) return;
    fs.accessSync(real, fs.constants.W_OK);
  } catch {
    return;
  }
  const source = readCached(workspace, surface.path, cache);
  if (source === undefined || source.split(replacement.search).length - 1 !== 1) return;
  const certificate = result.execution_contract?.readiness_certificate;
  const taskId = result.qref ?? surface.handle;
  result.fast_path = {
    kind: "single-site-unique-match",
    handle: surface.handle,
    path: surface.path,
    search: replacement.search,
    replace: replacement.replace,
    precondition: "unique-match",
    root_bound: true,
    occurrence_count: 1,
    ...(certificate?.id !== undefined
      ? { certificate: {
          id: certificate.id,
          sha: certificate.task_fingerprint.startsWith("sha256:")
            ? certificate.task_fingerprint
            : `sha256:${certificate.task_fingerprint}`,
        } }
      : {}),
    task: { id: taskId },
  };
  // The fast path is a proof-carrying edit recipe; re-send no likely_edits
  // that the normal evidence surface already carried. The source BODY only
  // joins that "already carried" set when the caller supplied this exact
  // location themselves (`paths`/`targets`) -- design v0.15 §7's literal-
  // first discovery flow has the opposite shape: nothing pointed at this
  // file before the server's own search found it, so this response is the
  // first and only chance to show the local window the search/replace pair
  // is proven against. Clearing it there would certify `act.edit` over text
  // nobody -- caller or server -- ever actually saw on the wire.
  if (hasCallerSuppliedLocation) surface.code = undefined;
  surface.facts = undefined;
  surface.likely_edits = undefined;
  surface.done_check = undefined;
  // This duplicates only the bounded recipe/proof, so recheck the hard cap.
  if (!fitsInCap(result)) delete result.fast_path;
}

/**
 * IMPROVEMENT D: stat the served surfaces' ACTUAL toolchain and return a
 * machine-readable runnability verdict. The surface set's own language decides
 * which toolchain is even asked about (`surfaceToolchainDomain`) — native:
 * host compiler probe; python: pyproject/pytest config + an installed runner
 * marker; node: nearest package.json with a scripts.test + node_modules
 * presence. `available:false, reason:"dependencies not installed"` tells the
 * agent NOT to burn turns installing a toolchain the checkout was never set up
 * to run. Trivial fs cost (statKindCached). Returns undefined when there is no
 * verification toolchain to speak to at all.
 */
export function buildVerificationVerdict(
  workspace: string,
  paths: string[],
): NonNullable<TaskPackResult["verification"]> | undefined {
  const domain = surfaceToolchainDomain(paths);
  if (domain === "native") return nativeVerificationVerdict(workspace, paths);
  if (domain === "python") {
    const pyConfig =
      statKindCached(workspace, workspace, "pyproject.toml") === "file"
      || ["pytest.ini", "tox.ini", "setup.cfg"].some((f) => statKindCached(workspace, workspace, f) === "file")
      || paths.some((p) => statKindCached(workspace, workspace, `${path.posix.dirname(p)}/pyproject.toml`) === "file");
    if (!pyConfig) return undefined;
    const runner = anyFileExistsCached(workspace, workspace, [
      ".venv/bin/pytest", "venv/bin/pytest", ".venv/bin/python", "venv/bin/python",
    ]);
    return runner
      ? { available: true, command: "pytest" }
      : { available: false, reason: "dependencies not installed", suggestion: VERIFY_NO_INSTALL_SUGGESTION };
  }
  if (domain !== "node") return undefined;
  for (const rel of paths) {
    const found = findNearestNpmScripts(workspace, rel);
    if (found?.pkg.scripts?.test !== undefined) {
      const { dir } = found;
      // 2026-09-27 (external evaluation §6.2): runnable = an installed node_modules is reachable from `dir`
      // (ancestors included), OR nothing is declared to install and the script only runs builtins (a
      // zero-dependency `node --test …` suite). Same classifier as the edit-time kit (verificationPack.ts
      // detectTestEntry), so the two verdicts cannot disagree about one checkout.
      const installed = classifyNodeTestRunnability(
        found.pkg as NodePackageManifestLike,
        nodeModulesReachableFrom(workspace, dir),
      ).runnable;
      const cmd = dir ? `cd ${dir} && npm test` : "npm test";
      return installed
        ? { available: true, command: cmd }
        : { available: false, reason: "dependencies not installed", suggestion: VERIFY_NO_INSTALL_SUGGESTION };
    }
  }
  return undefined;
}

/** IMPROVEMENT D: attach result.verification for edit-shaped packs with surfaces. */
export function attachVerificationVerdict(workspace: string, result: TaskPackResult): void {
  if (result.route?.action === "answer_from_handles") return;
  const surfaces = codeTaskPackSurfaces(result.surfaces);
  if (surfaces.length === 0) return;
  const root = dominantRootOf(surfaces);
  const paths = surfaces.map((s) => s.path).filter((p) => projectRootOf(p) === root);
  const verdict = buildVerificationVerdict(workspace, paths.length > 0 ? paths : surfaces.map((s) => s.path));
  if (verdict === undefined) return;
  // iter-2 W3: attach the verdict ONCE per session (first edit pack), and again
  // only when it CHANGED (e.g. dependencies were installed). The iter-1
  // forensics paid the identical ~209B verdict on 7 packs for zero behavior
  // change; a repeat of the same verdict is suppressed here.
  const sig = JSON.stringify(verdict);
  if (!shouldAttachVerification(workspace, sig)) return;
  result.verification = verdict;
}

/**
 * BLOCKER 62 (AC1, 2026-09-14, review round 12) — STATE the encoding risk that
 * cost this request its write authority.
 *
 * `writeAuthorityVeto` keeps a NUL-stripped file out of every writable frontier,
 * which is the safety half. Without this, the caller gets an `await_input` whose
 * `unresolved[]` never mentions the one fact that decided it, and the only place
 * the risk is stated is a `why` qualifier the caller has no reason to read as a
 * write verdict. Emitted ONLY when the request's own wording asks to CHANGE that
 * path (`requestItemLeads`), because a read of a stripped file is perfectly fine
 * and is already disclosed by the served note — it is the promise of an edit
 * that was false.
 *
 * Deliberately does NOT move `coverage`: nothing about discovery is incomplete,
 * and the empty frontier is already what degrades the decision.
 */
export function discloseUnwritableStrippedPaths(result: TaskPackResult, query: string): void {
  if (query === "") return;
  const strippedPaths = codeTaskPackSurfaces(result.surfaces)
    .filter((surface) => surfaceServedNulStripped(surface.why))
    .map((surface) => surface.path);
  if (strippedPaths.length === 0) return;
  const editLeadPaths = new Set(
    requestItemLeads(query)
      .filter((entry) => entry.lead === "edit" || entry.lead === "inherited-edit")
      .map((entry) => entry.path),
  );
  const disclosures = [...new Set(strippedPaths)]
    .filter((relPath) => editLeadPaths.has(relPath))
    .sort((left, right) => left.localeCompare(right))
    .map((relPath) => `${UNWRITABLE_ENCODING_RISK_PREFIX}${relPath} was served with its NUL `
      + `characters stripped, so TokenLighten will not write it back (the edit would silently delete `
      + `them); re-save it as UTF-8 before asking for a change`);
  if (disclosures.length === 0) return;
  result.missing = [...new Set([...result.missing, ...disclosures])];
}
