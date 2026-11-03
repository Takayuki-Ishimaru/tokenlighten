// answerCertificates — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { ContinuationCall } from "./packBasics.js";
import type { TaskExecutionContract } from "@tokenlighten/types";
import type { TaskPackResult } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import type { TaskReadinessEvidence } from "@tokenlighten/types";
import { FileReadCache } from "./packBasics2.js";
import { IDENTIFIER_DEFINITION_KEYWORD_RE } from "./answerCandidates2.js";
import { MAX_SURFACES_DISTINCT } from "./packBasics2.js";
import { MAX_SURFACE_CODE_BYTES } from "./packBasics2.js";
import { applyCanonicalTaskDecision } from "../canonicalDecision.js";
import { candidateToSurface } from "./surfaceMaterialization.js";
import { classifySurface } from "../../../util/impact.js";
import { codeTaskPackSurfaces } from "../artifactSections.js";
import { containsWholeIdentifier } from "../wholeIdentifier.js";
import { declarationRealExtent } from "../evidenceClosure.js";
import { directImportNeighbors } from "./contentSettlement3.js";
import { escapeRegExp } from "../../search/find/findText.js";
import { explicitCodeIdentifiers } from "./anchorFocus2.js";
import { handleTable } from "../../../util/handles.js";
import { hasHashComments } from "../callerExpansion.js";
import { hasIdentifierSegment } from "./literalAndConcernSeeds.js";
import { hasServedCode } from "./wiringEvidence2.js";
import { isDeclarationShapedMatchText } from "./callableResolution4.js";
import { parseSurfaceSpan } from "./packState2.js";
import { readCached } from "./packBasics2.js";
import { readinessEvidence } from "./changeAndReadinessEvidence2.js";
import { requiresRelatedAnswerContext } from "./answerCandidates.js";
import { shaOfText } from "../../../util/handles.js";
import { subtractLineSpans } from "./sourceAndConcernTerms.js";

/**
 * The one read that restores `windows`: a ranged target per window, in order.
 *
 * `budgetBytes` (R2-T1): the caller/client byte ceiling this pack ran under.
 * A caller-ranged read serves exactly what it names — it does NOT page under a
 * client-profile ceiling on its own (measured: a 178-line window read back at
 * 15,722 B under the VS Code 14,336 B ceiling), so a restoring read that can
 * be larger than the ceiling carries the budget explicitly and the read path
 * pages it with its own cursor chain. Omitted when no ceiling is active.
 */
export function evidenceRereadCall(
  windows: ReadonlyArray<{ readonly path: string; readonly start: number; readonly end: number }>,
  budgetBytes?: number,
): ContinuationCall {
  return {
    tool: "tl_read_file",
    arguments: {
      targets: windows.map((window) => ({ path: window.path, range: `${window.start}-${window.end}` })),
      ...(budgetBytes === undefined ? {} : { budget: { bytes: budgetBytes } }),
    },
  };
}

/**
 * The fail-closed arm both certificate invariants share (WP-B's
 * `enforceCertificateWireInvariant`, R2-T1's `enforceCeilingCertificateInvariant`):
 * the certificate is withdrawn outright and replaced by a discovery contract
 * whose ONE call reads `windows` — the evidence the certificate needed that
 * this response does not carry. `discover` + an executable ranged `next` is a
 * true statement of the client's situation (§2.1.1); the gap names the
 * obligations it is for, so nothing is dropped silently.
 */
export function failClosedToEvidenceReread(
  result: TaskPackResult,
  windows: ReadonlyArray<{ readonly path: string; readonly start: number; readonly end: number }>,
  reason: string,
  obligationIds: readonly string[],
  budgetBytes?: number,
): void {
  const reread = evidenceRereadCall(windows, budgetBytes);
  result.execution_contract = {
    version: 1,
    state: "needs-followup",
    readiness: "needs-followup",
    discovery_complete: false,
    next_action: "followup",
    max_additional_discovery_calls: 1,
    reason,
    typestate: { phase: "discovery", allowed_actions: ["read", "search"], challenge_required_for: [] },
    next_call: reread,
    ...(result.execution_contract?.workspace_state ? { workspace_state: result.execution_contract.workspace_state } : {}),
    capability_gaps: [{
      kind: "missing-evidence",
      recoverable: true,
      reason,
      obligation_ids: [...obligationIds],
      next_call: reread,
    }],
  };
  result.route = { action: "inspect_handles", reason, max_additional_tl_calls: 1 };
  result.next = reread;
  delete result.continuation;
  applyCanonicalTaskDecision(result);
}

/**
 * eval-0927 §6.1: note a window appended to `surface.code` from other lines of
 * the same file, so the wire projection can ship it as its own row
 * (`TaskPackSurface.appended_windows`).
 */
export function recordAppendedWindow(surface: TaskPackSurface, marker: string, range: string): void {
  surface.appended_windows = [...(surface.appended_windows ?? []), { marker, range }];
}

/**
 * The one contiguous window of `range` a centered slice kept: `range` minus
 * its unserved spans. Falls back to `range` itself when the remainder is not
 * a single window (a slice never splits one, so that is a malformed input).
 */
export function keptWindowOf(range: string, unserved: readonly string[]): string {
  const whole = /^(\d+)-(\d+)$/.exec(range);
  if (whole === null) return range;
  const holes = unserved.flatMap((entry) => {
    const hole = /^(\d+)-(\d+)$/.exec(entry);
    return hole === null ? [] : [{ start: Number(hole[1]), end: Number(hole[2]) }];
  });
  const kept = subtractLineSpans({ start: Number(whole[1]), end: Number(whole[2]) }, holes);
  return kept.length === 1 ? `${kept[0]!.start}-${kept[0]!.end}` : range;
}

/**
 * H1 (review R26): remove `line` (1-based, file coordinates) from every
 * "<start>-<end>" window in `ranges`, dropping a window it fully covers and
 * splitting one it bisects into its two remaining halves. Malformed entries
 * pass through unchanged rather than being silently discarded.
 */
export function subtractServedLineFromRanges(ranges: readonly string[], line: number): string[] {
  const out: string[] = [];
  for (const entry of ranges) {
    const match = /^(\d+)-(\d+)$/.exec(entry);
    if (match === null) {
      out.push(entry);
      continue;
    }
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (line < start || line > end) {
      out.push(entry);
      continue;
    }
    if (start < line) out.push(`${start}-${line - 1}`);
    if (end > line) out.push(`${line + 1}-${end}`);
  }
  return out;
}

/**
 * FIX-ORIG (2026-09-27, orchestrator ruling on eval-0927 P1's hybrid-body
 * finding): the best evidence line for `anchor` among `lines` (a whole-file,
 * 0-based split; caller reads the result as `index+1`, 1-based). Ranks a
 * declaration/definition-shaped line (a declaration keyword immediately
 * before the identifier, or the identifier itself immediately followed by
 * `(` for a callable, or by `=`/`:` for an assignment-style declaration —
 * the SAME shape `recoverExplicitIdentifierAnswerCandidates`'s
 * `definitionShaped` already tests) above a bare mention; among bare
 * mentions, an import/include/require line ranks LAST — it is the least
 * informative occurrence (it restates the name being imported without
 * showing how it is used), which is exactly why "shouldRetry" in
 * httpClient.ts must resolve to its call site, not its import line 2.
 * `undefined` when `anchor` occurs nowhere outside a comment.
 */
export function findAnchorEvidenceLineIndex(lines: readonly string[], anchor: string): number | undefined {
  const escaped = escapeRegExp(anchor);
  const boundaryRe = new RegExp(`\\b${escaped}\\b`);
  const importLineRe = /^\s*(?:import\b|from\s+\S+\s+import\b|require\s*\(|#include\b|using\s)/i;
  let firstNonImport = -1;
  let firstImport = -1;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (/^\s*(?:\/\/|\/\*|\*|#)/.test(line)) continue;
    const at = line.search(boundaryRe);
    if (at < 0) continue;
    const before = line.slice(0, at);
    const after = line.slice(at + anchor.length);
    if (IDENTIFIER_DEFINITION_KEYWORD_RE.test(before) || /^\s*[(=:]/.test(after)) return index;
    if (importLineRe.test(line)) {
      if (firstImport < 0) firstImport = index;
    } else if (firstNonImport < 0) {
      firstNonImport = index;
    }
  }
  return firstNonImport >= 0 ? firstNonImport : (firstImport >= 0 ? firstImport : undefined);
}

/** A query naming many identifiers must not turn into an unbounded number of
 *  one-line "presence" surfaces. */
export const MAX_ANCHOR_EVIDENCE_SURFACES = 4;

/**
 * FIX-ORIG: admit `anchor`'s evidence line as its OWN small, exact-verbatim
 * surface (mint+push), when no existing surface could be honestly widened to
 * include it. Never a foreign line spliced onto someone else's body (C1/C2).
 * A single-line range: this proves presence of the NAME only, deliberately —
 * value/condition/callers are separate obligations (FIX-G).
 */
export function addAnchorEvidenceSurface(
  surfaces: TaskPackSurface[],
  workspace: string,
  path: string,
  anchorLine: number,
  lineText: string,
  anchor: string,
  budget: { remaining: number },
): void {
  if (budget.remaining <= 0) return;
  const range = `${anchorLine}-${anchorLine}`;
  if (surfaces.some((s) => s.path === path && s.range === range)) return;
  const handle = handleTable.upsert({
    kind: "range", path, range, workspaceRoot: workspace, sha: shaOfText(lineText),
  });
  surfaces.push({
    role: classifySurface(path),
    handle: handle.id,
    path,
    range,
    symbol: anchor,
    why: "explicit-identifier-anchor",
    code: lineText,
    required: true,
  });
  budget.remaining -= 1;
}

/** Bodyless candidate rows that may each receive their anchor line as a body. */
export const MAX_BODYLESS_ANCHOR_FILLS = 8;

export function materializeExplicitAnswerAnchorEvidence(
  surfaces: readonly TaskPackSurface[],
  query: string,
  workspace: string,
  cache: FileReadCache,
): void {
  const anchors = [...new Set(explicitCodeIdentifiers(query))]
    .filter((anchor) => anchor.length >= 3);
  if (anchors.length === 0) return;
  const mutableSurfaces = surfaces as TaskPackSurface[];
  // Per FILE: a file whose served rows lack the line where it names an
  // anchor (its definition when it has one) gets that one line, once — never
  // once per surface of the same file (the original redundancy), and never
  // skipped merely because ANOTHER file mentions the name (eval-0927 review:
  // a consumer's `${INVOICE_V2_FLAG}` made the provider file's own definition
  // line look "proven", and the provider shipped without it).
  const fileShowsLine = (filePath: string, line: number): boolean =>
    mutableSurfaces.some((s) => {
      if (s.path !== filePath || s.code === undefined) return false;
      const span = parseSurfaceSpan(String(s.range ?? ""));
      if (span === undefined || line < span.start || line > span.end) return false;
      return !(s.remaining_ranges ?? []).some((entry) => {
        const hole = parseSurfaceSpan(entry);
        return hole !== undefined && line >= hole.start && line <= hole.end;
      });
    });
  const anchorBudget = { remaining: MAX_ANCHOR_EVIDENCE_SURFACES };
  let bodylessFills = 0;
  // This pass runs AFTER the pack was certified (dedupeTrimAndPersist), so it
  // never rewrites a certified surface's range or body — the decision was
  // made over those shapes (eval-0927 review, replay sfflag1: widening a
  // two-line file's one-line focus surface to the whole file after
  // certification made the discovery bundle the decision relied on look
  // redundant, and the wire fell back to a dead-end symbol search). An anchor
  // a served body lacks ships as its own one-line surface instead.
  for (const surface of [...mutableSurfaces]) {
    // A `code_unchanged` residency pointer is the CALLER's bytes, not this
    // pass's to read as served text (C2): never extended.
    if (surface.code === undefined && surface.code_unchanged !== undefined) continue;
    const full = readCached(workspace, surface.path, cache);
    if (full === undefined) continue;
    const lines = full.split(/\r?\n/);
    if (surface.code === undefined) {
      // A genuinely bodyless row (a candidate joined without bytes, e.g. one
      // of several same-basename files): its first anchor line becomes its
      // body, and its `remaining` names exactly the rest (H1, review R26).
      // Per row, not pack-wide — each row is a different file the caller has
      // not seen, and the line is what tells the candidates apart.
      if (bodylessFills >= MAX_BODYLESS_ANCHOR_FILLS) continue;
      const span = parseSurfaceSpan(String(surface.range ?? ""));
      if (span === undefined) continue;
      for (const anchor of anchors) {
        // WP-N (eval-0929 §8): the anchor is an EXPLICIT identifier, so only a
        // whole-identifier occurrence names it (any case — a prose heading may
        // spell it differently); a line holding it only inside a longer
        // identifier (`X_V2`, `APP_X`) is a near-miss, never its anchor line.
        if (!containsWholeIdentifier(full, anchor, { caseInsensitive: true })) continue;
        // The first line naming the anchor identifies the file — a Markdown
        // heading (`# Bravo contract`) included, which
        // `findAnchorEvidenceLineIndex` (a code-definition finder) skips.
        const lineIndex = lines.findIndex((line) =>
          !/^\s*(?:\/\/|\/\*|\*)/.test(line) && containsWholeIdentifier(line, anchor, { caseInsensitive: true }));
        if (lineIndex < 0) continue;
        const anchorLine = lineIndex + 1;
        if (anchorLine < span.start || anchorLine > span.end) continue;
        const text = lines[lineIndex]!;
        if (Buffer.byteLength(text, "utf8") > MAX_SURFACE_CODE_BYTES) continue;
        surface.code = text;
        const narrowed = subtractServedLineFromRanges(
          surface.remaining_ranges !== undefined && surface.remaining_ranges.length > 0
            ? surface.remaining_ranges
            : [surface.range],
          anchorLine,
        );
        if (narrowed.length === 0) {
          delete surface.remaining_ranges;
          delete surface.content_completeness;
        } else {
          surface.remaining_ranges = narrowed;
          surface.content_completeness = "partial";
        }
        bodylessFills += 1;
        break;
      }
      continue;
    }
    for (const anchor of anchors) {
      // WP-N: whole-identifier on both sides — a body showing only `X_V2` does
      // not already show X, and a file holding only `X_V2` has no X line.
      if (containsWholeIdentifier(surface.code, anchor, { caseInsensitive: true })
        || !containsWholeIdentifier(full, anchor, { caseInsensitive: true })) continue;
      const lineIndex = findAnchorEvidenceLineIndex(lines, anchor);
      if (lineIndex === undefined || fileShowsLine(surface.path, lineIndex + 1)) continue;
      addAnchorEvidenceSurface(mutableSurfaces, workspace, surface.path, lineIndex + 1, lines[lineIndex]!, anchor, anchorBudget);
    }
  }
}

/**
 * P2-12b (round-4 fable finding, 2026-09-28) — a PURE PREVIEW of
 * `materializeExplicitAnswerAnchorEvidence`'s own NEW-ROW arm, run against a
 * throwaway shallow COPY of `surfaces` so a READINESS check that runs
 * strictly BEFORE the real pass (`buildReadinessObligations`, called from
 * inside `dedupeTrimAndPersist` — see this file's own FIX-FC comment: the
 * anchor pass runs deliberately AFTER certification) can know exactly what
 * the real pass WILL add, before it runs — never by moving the real pass
 * earlier (that is the change this file's other doc comments warn against:
 * "never rewrites a certified surface's range or body", the sfflag1
 * regression), only by giving the certificate the SAME fact the anchor pass
 * itself is about to act on.
 *
 * Confirmed live (V01 flagship): hop 0 served `src/config.ts:14-14` as an
 * `explicit-identifier-anchor` row containing `HTTP_TIMEOUT_MS`, in the SAME
 * response whose `identifier:HTTP_TIMEOUT_MS` obligation still read
 * "uncovered" — because `buildReadinessObligations` ran before that row
 * existed. This closes the gap the RIGHT way (teach the obligation check
 * the fact sooner) rather than pruning the already-built gap list afterward
 * (which the FIX-FC comment a few lines below explicitly rules out: "`result.
 * missing` / `result.execution_contract`'s gaps are untouched").
 *
 * Never runs the BODYLESS-FILL arm's mutation for real via this preview in a
 * way that matters: that arm rewrites an EXISTING row's `.code` in place with
 * no `why`/`symbol` marker naming which anchor filled it, so it cannot be
 * attributed to one identifier here — a candidate row with no body has no
 * OTHER identifier evidence either, so the obligation stays uncovered exactly
 * as before for that shape (no regression, simply not yet improved).
 *
 * SAFE TO CALL TWICE with the same inputs: this module's only side effect,
 * `handleTable.upsert`, is idempotent for the same (kind, path, range,
 * workspaceRoot, sha) — the real pass's later call mints the identical
 * handle this preview already caused to exist, never a second one.
 */
export function previewAnchoredIdentifiers(
  surfaces: readonly TaskPackSurface[],
  query: string,
  workspace: string,
  cache: FileReadCache,
): ReadonlyMap<string, TaskReadinessEvidence> {
  const probe = surfaces.map((surface) => ({ ...surface }));
  materializeExplicitAnswerAnchorEvidence(probe, query, workspace, cache);
  const anchored = new Map<string, TaskReadinessEvidence>();
  for (let i = surfaces.length; i < probe.length; i++) {
    const row = probe[i]!;
    if (row.why === "explicit-identifier-anchor" && row.symbol !== undefined && !anchored.has(row.symbol)) {
      if (!anchorRowIsWholeEvidence(row, workspace, cache)) continue;
      anchored.set(row.symbol, readinessEvidence(row));
    }
  }
  return anchored;
}

/**
 * Whether an anchor row carries the WHOLE evidence for its identifier: a
 * use of the name (an env-var key, a property, a call — `HTTP_TIMEOUT_MS`
 * on V01's `config.ts:14`) or a declaration that ends inside the row. The
 * first line of a longer declaration (a function's signature, a table's
 * opener) is not: counting it certified "Explain parseConfigHeader and
 * finalizeShutdownSequence" with only `finalizeShutdownSequence`'s signature
 * sent (orchestrator, round 4 — the §3 class of the evaluation). Exported
 * for evaluation0927.anchorRowSufficiency.spec.ts.
 */
export function anchorRowIsWholeEvidence(row: TaskPackSurface, workspace: string, cache: FileReadCache): boolean {
  const bounds = /^(\d+)-(\d+)$/.exec(row.range);
  const lines = readCached(workspace, row.path, cache)?.split(/\r?\n/);
  if (bounds === null || lines === undefined || row.symbol === undefined) return false;
  const first = Number(bounds[1]);
  const last = Number(bounds[2]);
  const text = lines[first - 1];
  if (text === undefined) return false;
  if (!isDeclarationShapedMatchText(text, row.symbol)) return true;
  const hashComment = hasHashComments(row.path);
  if (declarationRealExtent(lines, first, hashComment).end > last) return false;
  // A body on the following lines that no bracket opens on this one: an
  // Allman-style `{`, or an indentation-scoped body (Python `def f():`).
  const indent = (value: string): number => value.length - value.trimStart().length;
  for (let next = last + 1; next <= lines.length; next++) {
    const candidate = lines[next - 1]!;
    if (candidate.trim() === "") continue;
    return !(candidate.trimStart().startsWith("{") || (hashComment && indent(candidate) > indent(text)));
  }
  return true;
}

/**
 * FIX-FC (eval-0927 review finding 8, 2026-09-27) — TRIM `next` AGAINST WHAT
 * THIS RESPONSE ACTUALLY SHIPS, NEVER THE CERTIFICATE.
 *
 * Live repro (`sfflag1` replay fixture): the query names both
 * `INVOICE_V2_FLAG` (line 1 of `src/feature_flags.ts`) and `invoiceVersion`
 * (line 2); the answer-explicit-symbol-focus locator anchors on line 2 only,
 * so `result.next` is computed — INSIDE `dedupeTrimAndPersist`, before this
 * function's caller ever runs — as a discovery call naming `src/
 * feature_flags.ts` (correctly: the identifier gap is real at that point).
 * `materializeExplicitAnswerAnchorEvidence`, a few lines above, runs
 * DELIBERATELY AFTER certification (its own doc comment: "never rewrites a
 * certified surface's range or body") and adds the missing line as its OWN
 * one-line surface (`src/feature_flags.ts:1-1`) to close exactly that gap —
 * but nothing then revisits `next`, which still names the SAME `src/
 * feature_flags.ts:1-1` window this response's own evidence now already
 * carries. Running that `next` verbatim (AGENTS.md: "never as a template")
 * re-reads a line the caller already has, for zero new information.
 *
 * THE FIX IS ADDITIVE, NEVER SUBTRACTIVE. `result.missing` /
 * `result.execution_contract`'s gaps are untouched — the identifier's OWN
 * evidence line closing does not by itself prove the OTHER obligations the
 * gap named (`request-item:facet-1:flow` in the live repro still needs the
 * file's relation to the caller, which line 1 alone does not show) — so this
 * never claims more coverage than dedupeTrimAndPersist certified. It only
 * asks: does `next`'s own explicit `range` name a window THIS response's
 * surfaces now serve a real body for? If so, the range is dropped from that
 * target (falling back to "read the whole file"), which is NEVER a
 * regression versus the un-widened call: a target whose narrow range was
 * fully redundant is redundant in exactly the same way when widened only if
 * its ENTIRE file were already fully served too, and this pass leaves a
 * target alone whenever ANY part of its file remains unserved — the common
 * case, since `materializeExplicitAnswerAnchorEvidence` deliberately adds
 * ONE line, never a whole file.
 *
 * P2-16 (eval-0927 review r2 finding 16) is deliberately NOT handled here:
 * widening a `next` target whose range an EARLIER hop already shipped turned
 * a narrow continuation into a whole-file read and left follow-up chains with
 * no decision (requestItemGateMatrix, 2026-09-28). A facet continuation that
 * re-asks for lines an earlier hop shipped costs one hop that comes back as
 * `prior` — honest, and left as a known residual.
 */
export function trimNextAgainstShippedEvidence(result: TaskPackResult): void {
  // The exact (path, range) windows this response's OWN surfaces now carry a
  // real body for — computed ONCE, after every post-certification augmenter
  // above (anchor/import/graph) has had its say, so this can see additions
  // none of them individually knew about. Shared below: "already shipped"
  // must be the SAME definition for every field this function trims, or one
  // could be caught while a sibling naming the identical window is not.
  const shippedWindows = new Set(
    codeTaskPackSurfaces(result.surfaces)
      .filter(hasServedCode)
      .map((s) => `${s.path}\u0000${s.range}`),
  );
  if (shippedWindows.size === 0) return;
  trimResultNextInPlace(result, shippedWindows);
  pruneContractNextCalls(result.execution_contract, shippedWindows);
}

/**
 * `result.next`'s own widen-only trim (the ORIGINAL FIX-FC behaviour, unchanged).
 * See `pruneContractNextCalls`'s doc comment for why the OTHER two fields this
 * function's caller trims use the opposite rule (remove, never widen).
 */
export function trimResultNextInPlace(result: TaskPackResult, shippedWindows: ReadonlySet<string>): void {
  const next = result.next;
  if (next === undefined || next.tool !== "tl_read_file") return;
  const args = next.arguments;
  if (args === null || typeof args !== "object" || Array.isArray(args)) return;
  const targets = (args as Record<string, unknown>)["targets"];
  if (!Array.isArray(targets) || targets.length === 0) return;
  let changed = false;
  const widenedTargets = targets.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const record = entry as Record<string, unknown>;
    const path = record["path"];
    const range = record["range"];
    if (typeof path !== "string" || typeof range !== "string") return entry;
    if (!shippedWindows.has(`${path}\u0000${range}`)) return entry;
    changed = true;
    const { range: _droppedRange, ...withoutRange } = record;
    return withoutRange;
  });
  if (!changed) return;
  (args as Record<string, unknown>)["targets"] = widenedTargets;
}

/**
 * WP-H (eval-0929 §5/§8) — THE SAME "next must not re-read what this response
 * already shipped" rule as `trimResultNextInPlace`, for the two fields
 * `decisionWire.ts`'s `discoverNext`/`gapNamedNext` read BEFORE they ever look
 * at `result.next`/`result.continuation`: `execution_contract.next_call` and
 * each `execution_contract.capability_gaps[].next_call`. Neither is
 * `result.next`, so the widen-only pass above never reached them.
 *
 * MEASURED (eval-0929 §5's `mayRetry`/`RETRYABLE_STATUSES` fixture, budget
 * 6144): the facet gate's OWN batched gap call named the constant's window
 * (`codes.ts:1-1`) while `dedupeTrimAndPersist`'s contract build was still
 * open; the SAME-RESPONSE anchor pass a few lines above then shipped that
 * exact window with a body — but `decisionWire.ts::discoverNext` reads
 * `contract.next_call` UNCONDITIONALLY, before it ever falls through to
 * `result.continuation` (the genuinely useful `decide.ts` remainder the SAME
 * builder had already computed), so the stale call always won the wire and
 * the next hop answered `prior` for a window the caller already held.
 *
 * REMOVE THE EXACT-MATCH TARGET, NEVER WIDEN, HERE — the opposite choice from
 * `trimResultNextInPlace`, and deliberately so. That function widens because
 * `result.next` is the LAST-RESORT slot (dropping its one target outright
 * risks the documented P2-16 residual: a call with nothing left to name).
 * These two fields are different: they are two of the FOUR INDEPENDENT
 * sources `decisionWire.ts::projectTaskDecision` tries in rank order, ABOVE
 * `result.continuation` in that order, so removing an exact-match target here
 * — and, if that empties the array, removing the field entirely rather than
 * shipping an unaddressable `targets: []` — never leaves the response with
 * nothing to act on. It only stops THIS call from occupying the winning rank,
 * so a lower-ranked source (starting with `result.continuation`, already
 * computed by the same builder) gets read instead. Widening would keep the
 * redundant call in that winning slot, which is exactly what stopped the
 * fallback chain from ever being consulted — the defect this closes.
 *
 * ADDITIVE ONLY, as `trimResultNextInPlace` already is: `obligation_ids`,
 * `reason` and every other field of a gap are untouched, so the wire's
 * `gaps` disclosure (`projectGaps`, read from those same fields) still names
 * every obligation this pass has not verified closed — only the now-moot
 * RECOVERY CALL for an already-served window is pruned.
 */
export function pruneContractNextCalls(
  contract: TaskExecutionContract | undefined,
  shippedWindows: ReadonlySet<string>,
): void {
  if (contract === undefined) return;
  const prunedTop = pruneShippedTargets(contract.next_call, shippedWindows);
  if (prunedTop !== undefined) {
    if (prunedTop.exhausted) delete contract.next_call;
    else contract.next_call = prunedTop.call;
  }
  for (const gap of contract.capability_gaps ?? []) {
    const prunedGap = pruneShippedTargets(gap.next_call, shippedWindows);
    if (prunedGap === undefined) continue;
    if (prunedGap.exhausted) delete gap.next_call;
    else gap.next_call = prunedGap.call;
  }
}

/**
 * `call`'s `targets[]`, minus every entry whose EXACT `{path,range}` is in
 * `shippedWindows` — the same definition of "already shipped"
 * `trimResultNextInPlace` uses. `undefined` when `call` is not a
 * `targets[]`-shaped `tl_read_file` call, or nothing in it matched (the common
 * case: byte-identical, no new object allocated). `exhausted` is true when
 * every target was removed, so the caller deletes the whole field rather than
 * shipping a `targets: []` no call could execute.
 */
export function pruneShippedTargets(
  // The CONTRACT's own `ContinuationCall` (`@tokenlighten/types`'s
  // `mcp/task-pack.ts`, `arguments: Record<string, unknown>`) — read off
  // `TaskExecutionContract`/`TaskCapabilityGap` themselves rather than named
  // directly, because this file's OWN local `ContinuationCall` alias (line
  // ~511, `ToolCall & {purpose?}`) types `arguments` against the STRICT
  // `JsonValue`-only wire union and is a different, incompatible type despite
  // sharing the name — `result.next`/`result.continuation` (that local alias)
  // are `trimResultNextInPlace`'s domain, never this function's.
  call: TaskExecutionContract["next_call"],
  shippedWindows: ReadonlySet<string>,
): { call: NonNullable<TaskExecutionContract["next_call"]>; exhausted: boolean } | undefined {
  if (call === undefined || call.tool !== "tl_read_file") return undefined;
  const args = call.arguments;
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const targets = (args as Record<string, unknown>)["targets"];
  if (!Array.isArray(targets) || targets.length === 0) return undefined;
  let changed = false;
  const kept = targets.filter((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return true;
    const record = entry as Record<string, unknown>;
    const path = record["path"];
    const range = record["range"];
    if (typeof path !== "string" || typeof range !== "string") return true;
    if (!shippedWindows.has(`${path}\u0000${range}`)) return true;
    changed = true;
    return false;
  });
  if (!changed) return undefined;
  return {
    call: { ...call, arguments: { ...args, targets: kept } },
    exhausted: kept.length === 0,
  };
}

/**
 * A relation answer can name a renderer plus its providers.  The normal
 * answer profile intentionally does not take generic import closure, but in
 * this exact shape an already-resolved relative import is the requested
 * evidence.  Admit only neighbour files whose body proves one of the
 * caller's explicit identifiers or whose complete basename was named; this
 * avoids turning "imports" into a broad dependency walk.
 */
export async function augmentExplicitAnswerImportSurfaces(
  surfaces: TaskPackSurface[],
  query: string,
  workspace: string,
  cache: FileReadCache,
): Promise<void> {
  if (!requiresRelatedAnswerContext(query) || surfaces.length >= MAX_SURFACES_DISTINCT) return;
  const anchors = [...new Set(explicitCodeIdentifiers(query))]
    .filter((anchor) => anchor.length >= 3);
  if (anchors.length === 0) return;
  const seen = new Set(surfaces.map((surface) => surface.path));
  for (const source of [...surfaces]) {
    if (surfaces.length >= MAX_SURFACES_DISTINCT) return;
    // Answer surfaces are often a function-sized slice that begins after the
    // import block.  Resolve neighbours from the full, already-readable file
    // so an observed import is not lost merely because its body was focused.
    const fullSource = readCached(workspace, source.path, cache);
    const importSource = fullSource === undefined ? source : { ...source, code: fullSource };
    for (const importedPath of directImportNeighbors(workspace, [importSource], seen)) {
      if (surfaces.length >= MAX_SURFACES_DISTINCT) return;
      const content = readCached(workspace, importedPath, cache);
      if (content === undefined) continue;
      const basename = path.basename(importedPath, path.extname(importedPath));
      // WP-N (eval-0929 §8): an imported file holding only a longer identifier
      // (`X_V2`) is not the provider of the explicit identifier X — whole-
      // identifier occurrences only. The query-named-path fallback keeps its
      // basename segment match (a file name, not a code identifier).
      const anchored = anchors.find((anchor) => containsWholeIdentifier(content, anchor, { caseInsensitive: true }));
      const explicit = anchored
        ?? (query.includes(importedPath) || query.includes(path.basename(importedPath)) ? basename : undefined);
      if (explicit === undefined) continue;
      const lines = content.split(/\r?\n/);
      const line = Math.max(1, lines.findIndex((candidate) => anchored !== undefined
        ? containsWholeIdentifier(candidate, anchored, { caseInsensitive: true })
        : hasIdentifierSegment(candidate, explicit)) + 1);
      const range = `${line}-${line}`;
      const surface = await candidateToSurface({
        path: importedPath,
        line,
        range,
        surface: classifySurface(importedPath),
        why: "answer-explicit-import-provider",
        confidence: 0.98,
      }, workspace, [], query, cache, { answerProfile: true });
      surface.required = true;
      surfaces.push(surface);
      seen.add(importedPath);
    }
  }
}
