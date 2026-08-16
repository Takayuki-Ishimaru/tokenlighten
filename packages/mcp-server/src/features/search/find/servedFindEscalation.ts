/**
 * servedFindEscalation.ts — L2 of the 2026-08-08 find-honesty wave: the
 * response-side protocol for a find whose ENTIRE match set was already served
 * to the caller this session.
 *
 * THE MEASURED DEFECT (bench run 2026-08-08-semantic-signal5-1, T05c rep2
 * arm-A, 20 discovery calls before the first edit). The server already KNEW
 * the caller was re-locating inside content it held: `served_note` plus
 * per-file `served_this_session:true` fired on SIX separate find responses in
 * that one cell. All six were ignored. Two of them (calls 11 and 12) re-served
 * the SAME 89 matches in the same file under two spellings of one query
 * (`drv_motor`, then `drv_motor.h`). The signal was correct and complete; it
 * was simply a trailing prose string with no protocol force, appended after
 * the payload the caller was already reading past. The two sibling reps that
 * won the pair self-enforced the same fact without being told.
 *
 * THE FIX IS ESCALATION, NOT DENIAL. A locate is a real need — "which lines of
 * the file I hold mention yaw?" is a legitimate question with a cheap correct
 * answer — so the FIRST all-served find under a certificate still serves
 * normally. What changes is that the fact becomes machine-readable
 * (`all_served:true`) instead of prose-only. Only the SECOND distinct
 * all-served find, or a repeat of one already answered, escalates: and even
 * then the locations still ride the response as a receipt (paths, matched
 * LINE NUMBERS, per-file counts, provenance). What the escalation drops is the
 * `snippets` — verbatim bytes of files the caller demonstrably already holds,
 * which is the only part that was ever redundant. Nothing this session has not
 * already served the caller is withheld at any step.
 *
 * WHY IT IS NOT A SECOND DISCOVERY BRAKE. guardExecutionDiscovery (state/
 * session.ts) refuses the 3rd+ BYTE-IDENTICAL call shape and runs before
 * dispatch. This fires at the 2nd all-served find, from the response path, on
 * a predicate the brake structurally cannot see: not "how often did you ask"
 * but "what do you already hold". Because it lands strictly earlier, an
 * all-served loop is answered here once rather than braked later under
 * different wording — an ordered ladder, not two brakes on one pedal. The
 * search-side analogue of the ND stand-down work.
 *
 * C3 (2026-08-09 range-honesty), A SECOND MEASURED DEFECT layered on the
 * first (bench run 2026-08-08-semantic-signal5-2, 8 T05c sightings + 2
 * others): the `served`/`all_served` check above is FILE-level
 * (getReadPaths — "was this path read at all"), but a doc-sliver serve (see
 * state/session.ts's servedRangeLedger, and the L1 doc-authority wave) can
 * mark a whole path "read" on a handful of lines out of thousands. Measured:
 * CONTRACT.md served 1514-1514 of 1,514 lines, then a find matched line
 * 1022 — `all_served:true` and the prose above fired anyway, false in 8/8
 * sightings, and was correctly ignored every time. `applyServedFindProtocol`
 * now checks every DISCLOSED matched line against servedFindMatchLinesOutsideServed
 * before either the prose or the L2 ledger runs: only when the whole match
 * set is truly line-for-line held does anything below this point execute. A
 * find that surfaces held files but unheld lines gets its own honest partial
 * note instead (`partially_served`/`partial_served_note`, per-file
 * `lines_held`/`matched_lines_outside_served`) and never touches the ledger —
 * it is real information, not a zero-info repeat, and must never itself
 * count toward escalation.
 */

import { handleTable } from "../../../util/handles.js";
import {
  EDIT_REPLACE_PLACEHOLDER,
  EDIT_SEARCH_PLACEHOLDER,
  getReadPaths,
  getExecutionFence,
  getLastExecutionCertificateId,
  recordAllServedFind,
  resetServedFindLedger,
  servedFindCertificateUnlock,
  servedFindMatchLinesOutsideServed,
  servedFindWindowHasUnservedLines,
  servedPathProvenance,
} from "../../../state/session.js";

/** Per-file receipt entry on an escalated response. */
interface ServedFindReceiptFile {
  path: string;
  lines: number[];
  match_count: number;
  served_by?: string;
  served_this_session: true;
}

export interface ServedFindOutcome {
  /** The body to return. Either the annotated find response or the escalation. */
  body: Record<string, unknown>;
  /**
   * True when `body` is the terminal-style escalation rather than a find
   * response. The dispatcher must NOT attach its usual find-response extras
   * (search hop-1, member sweep, related lookups) to an escalation — those
   * describe a result set this body deliberately no longer carries.
   */
  escalated: boolean;
}

/** Cap on receipt line numbers per file — the count stays exact regardless. */
const RECEIPT_LINES_PER_FILE = 12;

/**
 * The byte-selecting identity of a find call. Same principle as
 * discoveryCallSignature: every argument that changes WHICH bytes come back is
 * in, everything else (cwd/lane select the session, taskProfile is a routing
 * declaration) is out.
 */
function findCallSignature(args: Record<string, unknown>): string {
  const queries = Array.isArray(args["queries"])
    ? (args["queries"] as unknown[]).map(String)
    : undefined;
  return JSON.stringify({
    action: "find",
    query: args["query"] !== undefined ? String(args["query"]) : undefined,
    queries,
    path: args["path"] !== undefined ? String(args["path"]) : undefined,
    regex: args["regex"] === undefined ? undefined : Boolean(args["regex"]),
    lang: args["lang"] !== undefined ? String(args["lang"]) : undefined,
  });
}

/**
 * The identity of a RESULT SET: which files, which matched lines, how many
 * matches. Deliberately independent of the query string — the measured
 * duplicate (`drv_motor` then `drv_motor.h`, 89 matches, identical 8 preview
 * lines) is only detectable on the result.
 */
function resultFingerprint(files: readonly Record<string, unknown>[], totalMatches: number): string {
  const parts = files
    .map((file) => {
      const lines = Array.isArray(file["lines"]) ? (file["lines"] as unknown[]).map(Number) : [];
      const more = typeof file["more_lines"] === "number" ? file["more_lines"] : 0;
      return `${String(file["path"])}#${lines.join(",")}+${more}`;
    })
    .sort();
  return `${parts.join("|")}::${totalMatches}`;
}

function fileLines(file: Record<string, unknown>): number[] {
  return Array.isArray(file["lines"])
    ? (file["lines"] as unknown[]).map(Number).filter((n) => Number.isFinite(n))
    : [];
}

function receiptFor(
  workspace: string,
  files: readonly Record<string, unknown>[],
): ServedFindReceiptFile[] {
  return files.map((file) => {
    const path = String(file["path"]);
    const lines = fileLines(file);
    const shown = lines.slice(0, RECEIPT_LINES_PER_FILE);
    // `match_count` must be the file's TRUE hit count, never the preview
    // length: the preview is capped twice over (MAX_LINES_PER_FILE, then the
    // response byte budget), and `more_lines` carries the remainder.
    const more = typeof file["more_lines"] === "number" ? file["more_lines"] : 0;
    const declared = typeof file["match_count"] === "number" ? file["match_count"] : undefined;
    const servedBy = servedPathProvenance(workspace, path, lines);
    return {
      path,
      lines: shown,
      match_count: declared ?? lines.length + more,
      ...(servedBy !== undefined ? { served_by: servedBy } : {}),
      served_this_session: true as const,
    };
  });
}

/**
 * The zoom transition, offered ONLY when it would genuinely put bytes on the
 * wire. A window this session has already fully served comes back as a
 * `code_unchanged` receipt, and prescribing that as "the way forward" would
 * repeat the exact dishonesty this wave exists to remove.
 */
function zoomTransition(
  workspace: string,
  files: readonly ServedFindReceiptFile[],
): { transition: string; nextCall: Record<string, unknown> } | undefined {
  for (const file of files) {
    if (file.lines.length === 0) continue;
    const start = Math.max(1, Math.min(...file.lines) - 20);
    const end = Math.max(...file.lines) + 20;
    if (!servedFindWindowHasUnservedLines(workspace, file.path, start, end)) continue;
    const handle = handleTable.upsert({
      kind: "range",
      path: file.path,
      range: `${start}-${end}`,
      workspaceRoot: workspace,
    }).id;
    return {
      transition: `read_file mode=slice handle=${handle} range=${start}-${end}`,
      nextCall: {
        tool: "read_file",
        arguments: { mode: "slice", handle, range: `${start}-${end}`, cwd: workspace },
      },
    };
  }
  return undefined;
}

/**
 * Annotate a find response with what this session already served the caller,
 * and escalate a repeated all-served find to the terminal-style protocol.
 *
 * Behaviour by case (see the module doc for why each is what it is):
 *  1. hits include a NOT-yet-served file -> unchanged response, per-file
 *     `served_this_session` on the served ones, ledger RESET (progress).
 *  2. zero matches -> untouched. An empty result is neither residency nor
 *     progress; the absence certificate already answers it.
 *  3. first all-served find under the live certificate -> full response plus
 *     `all_served:true` and the existing prose note.
 *  4. second+ (or a repeat) -> the escalation body.
 *
 * Without a live certificate nothing escalates: "you already hold this" is a
 * protocol-grade claim only while the decision it belongs to is open.
 */
export function applyServedFindProtocol(
  response: object,
  workspace: string,
  args: Record<string, unknown>,
  certificateIdOverride?: string,
): ServedFindOutcome {
  try {
    const record = response as Record<string, unknown>;
    const rawFiles = record["files"];
    if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
      return { body: record, escalated: false };
    }
    const files = rawFiles.filter(
      (entry): entry is Record<string, unknown> =>
        entry !== null && typeof entry === "object" && typeof (entry as { path?: unknown }).path === "string",
    );
    if (files.length !== rawFiles.length || files.length === 0) {
      return { body: record, escalated: false };
    }

    const served = new Set(getReadPaths(workspace));
    if (served.size === 0) return { body: record, escalated: false };
    const servedFiles = files.filter((file) => served.has(String(file["path"])));

    if (servedFiles.length === 0) {
      // Nothing held — a pure discovery result. Progress, so the ledger goes.
      resetServedFindLedger(workspace);
      return { body: record, escalated: false };
    }

    const annotated = files.map((file) =>
      served.has(String(file["path"])) ? { ...file, served_this_session: true } : file,
    );

    if (servedFiles.length < files.length) {
      // Case 1: at least one NOT-yet-served location. This is a legitimate
      // scope change and must never inherit escalation pressure earned
      // elsewhere — it explicitly CLEARS the ledger.
      resetServedFindLedger(workspace);
      return { body: { ...record, files: annotated }, escalated: false };
    }

    // Case 3/4: every matching file is already in the caller's context — but
    // that is a FILE-level fact (getReadPaths), and an honest residency
    // claim needs a LINE-level one. C3 (2026-08-09 range-honesty): check
    // every DISCLOSED matched line against this session's actual served
    // ranges before any residency prose or ledger accounting below runs.
    const outsideByPath = new Map<string, number[]>();
    for (const file of files) {
      const outside = servedFindMatchLinesOutsideServed(workspace, String(file["path"]), fileLines(file));
      if (outside.length > 0) outsideByPath.set(String(file["path"]), outside);
    }

    if (outsideByPath.size > 0) {
      // State b: every matched file is known, but not every matched LINE is
      // held — a doc-sliver serve (or a governed full-mode downgrade) can
      // mark a whole path "read" on a sliver of it. This is real,
      // non-redundant information (the caller cannot get these specific
      // lines from context it already holds), so: no residency prose, and it
      // must NEVER touch the L2 ledger — a partial find is not a zero-info
      // repeat, and must never itself advance toward, or trigger, the
      // terminal brake.
      const rangedFiles = annotated.map((file) => {
        const outside = outsideByPath.get(String(file["path"]));
        return {
          ...file,
          lines_held: outside === undefined,
          ...(outside !== undefined ? { matched_lines_outside_served: outside.length } : {}),
        };
      });
      const outsideTotal = [...outsideByPath.values()].reduce((sum, lines) => sum + lines.length, 0);
      const partialServedNote =
        `matching files were only partially served this session — ${outsideTotal} matched ` +
        `line${outsideTotal === 1 ? "" : "s"} ${outsideTotal === 1 ? "lies" : "lie"} outside the ranges you ` +
        `hold; do not treat ${outsideTotal === 1 ? "it" : "them"} as already read`;
      return {
        body: { ...record, files: rangedFiles, partially_served: true, partial_served_note: partialServedNote },
        escalated: false,
      };
    }

    // State a: every matched file AND every matched line is inside content
    // this session actually served — today's behaviour, unchanged.
    const totalMatches = typeof record["total_matches"] === "number" ? record["total_matches"] : 0;
    const fence = getExecutionFence(workspace);
    const certificateId = certificateIdOverride ?? fence?.certificateId ?? getLastExecutionCertificateId(workspace);
    const servedNote =
      "every matching file was already served to you this session — the matches sit inside content you hold; check your context before re-reading";
    if (certificateId === undefined) {
      return {
        body: { ...record, files: annotated, all_served: true, served_note: servedNote },
        escalated: false,
      };
    }

    const verdict = recordAllServedFind(
      workspace,
      certificateId,
      findCallSignature(args),
      resultFingerprint(files, totalMatches),
      // The caller's OWN wording, not the response's rendered `query` (which
      // joins queries[] with " OR ") — a duplicate verdict has to name
      // something the caller can find in its own transcript.
      Array.isArray(args["queries"])
        ? (args["queries"] as unknown[]).map(String).join(" OR ")
        : String(args["query"] ?? record["query"] ?? ""),
    );

    if (!verdict.escalate) {
      return {
        body: {
          ...record,
          files: annotated,
          all_served: true,
          all_served_occurrence: verdict.occurrence,
          served_note: servedNote,
        },
        escalated: false,
      };
    }

    return {
      body: buildEscalation(workspace, record, files, totalMatches, verdict, certificateId),
      escalated: true,
    };
  } catch {
    return { body: response as Record<string, unknown>, escalated: false };
  }
}

function buildEscalation(
  workspace: string,
  record: Record<string, unknown>,
  files: readonly Record<string, unknown>[],
  totalMatches: number,
  verdict: { occurrence: number; repeatedCall: boolean; duplicateOfQuery?: string },
  certificateId: string,
): Record<string, unknown> {
  const receipt = receiptFor(workspace, files);
  const unlock = servedFindCertificateUnlock(workspace);
  const zoom = zoomTransition(workspace, receipt);

  const acceptedTransitions: string[] = [];
  if (zoom !== undefined) acceptedTransitions.push(zoom.transition);
  for (const transition of unlock?.acceptedTransitions ?? []) acceptedTransitions.push(transition);
  // Always last, always available: the caller may still search — just not over
  // scope it has already been served. This is the clause that keeps the
  // escalation an escalation rather than a wall.
  acceptedTransitions.push("search_files action=find path=<a scope this session has NOT served>");

  // The prescription order encodes what actually finishes the task. An
  // edit-terminal certificate with a named write target is the productive move
  // (both winning reps took it from here); a genuine unserved window comes
  // next; otherwise the caller is handed the rescope template rather than a
  // dead end.
  const editHandle = unlock?.editTargetHandle;
  const nextCall = editHandle !== undefined
    ? {
        tool: "edit_file",
        arguments: {
          handle: editHandle,
          search: EDIT_SEARCH_PLACEHOLDER,
          replace: EDIT_REPLACE_PLACEHOLDER,
          cwd: workspace,
        },
      }
    : zoom?.nextCall ?? {
        tool: "search_files",
        arguments: {
          action: "find",
          query: "<one identifier you have NOT already been served>",
          path: "<a scope this session has NOT served>",
          cwd: workspace,
        },
      };

  const duplicate = verdict.repeatedCall || verdict.duplicateOfQuery !== undefined;
  const terminalReason = duplicate
    ? verdict.duplicateOfQuery !== undefined && !verdict.repeatedCall
      ? `this query returns the SAME ${totalMatches} match(es) in the same file(s) that "${verdict.duplicateOfQuery}" already returned this session, and every one of those files was already served to you — a differently-spelled query over served scope cannot surface a new location`
      : `this exact find already ran this session over scope that was already served to you — re-running it cannot surface a location you do not already hold`
    : `every file this query matches was already served to you this session, and this is the ${verdict.occurrence}${ordinalSuffix(verdict.occurrence)} such find under certificate ${shortId(workspace)} — locating inside content you already hold cannot advance the task`;

  return {
    ok: false,
    error: "find-all-served-repeat",
    reason: "repeated-all-served-find",
    required_action: "unlock-or-rescope",
    // protocol v1 (C2-4, A.9.2 row 20 + §2.6): this body becomes a `Refusal`,
    // and when the fence sanctions a challenge the refusal's `retry` is
    // `"challenge"` — which v1 makes UNAUTHORABLE without the certificate the
    // challenge argument must name (`challenge.certificate_id`,
    // `server.ts:460`; `state/session.ts:2149-2151` refuses a mismatched one). The
    // id was already the identity this escalation was recorded under
    // (`recordAllServedFind` above); it was simply never on the wire, so the
    // one transition worth taking here would have degraded to a re-pack.
    certificate_id: certificateId,
    terminal: true,
    terminal_reason: terminalReason,
    // A terminal all-served escalation has no productive byte-identical retry.
    // Keep the same explicit retry contract as execution-typestate refusals.
    retry_same_call: false,
    all_served: true,
    all_served_occurrence: verdict.occurrence,
    ...(verdict.duplicateOfQuery !== undefined ? { duplicate_of_query: verdict.duplicateOfQuery } : {}),
    ...(verdict.repeatedCall ? { duplicate_call: true } : {}),
    query: String(record["query"] ?? ""),
    files: receipt,
    total_files: typeof record["total_files"] === "number" ? record["total_files"] : receipt.length,
    total_matches: totalMatches,
    receipt_note:
      "locations are complete (path + matched lines + exact counts); only snippets are omitted — they are verbatim bytes of files this session already served you",
    unlock: {
      accepted_transitions: acceptedTransitions,
      ...(unlock?.challenge !== undefined ? { challenge: unlock.challenge } : {}),
      note:
        "find over already-served scope is refused for this certificate; take a transition above — zoom an UNSERVED window, edit through the frontier, `challenge` if new evidence changes the certified decision, or search unserved scope",
    },
    next_call: nextCall,
    ...(nextCall.tool === "edit_file" || nextCall.tool === "search_files"
      ? { next_call_is_template: true }
      : {}),
  };
}

function ordinalSuffix(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return "th";
  switch (n % 10) {
    case 1: return "st";
    case 2: return "nd";
    case 3: return "rd";
    default: return "th";
  }
}

function shortId(workspace: string): string {
  return getExecutionFence(workspace)?.certificateId.slice(0, 8) ?? "<none>";
}
