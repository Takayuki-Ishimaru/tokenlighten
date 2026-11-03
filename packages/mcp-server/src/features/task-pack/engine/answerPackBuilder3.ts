// answerPackBuilder — extracted implementation; imports point to the owning modules.
import type { AnswerStructureMap } from "./answerPackBuilder2.js";
import type { FacetRequirement } from "../requestFacets.js";
import { TASK_PACK_PREVIEW_DISCOVER_RESERVE_BYTES } from "../../../protocol/taskPackSizePreview.js";
import { TASK_PACK_PREVIEW_PREPARED_RESERVE_BYTES } from "../../../protocol/taskPackSizePreview.js";
import { activePackByteCeiling } from "./packBasics2.js";
import { preferExactAnswerBody } from "../../../protocol/answerBodyPolicy.js";
import { protocolCallContext } from "../../../protocol/envelope.js";

/**
 * The maps an answer pack may serve its primary type, decided BEFORE the pack is built
 * and booked. `ordinary` is the map the pack serves where TL_EFF_MAP_ANSWER_FIRST is
 * unset — whatever `structureMapForAnswer` decided for it, none included. `answerFirst`
 * is the core-only map the request could be answered from first, with the facet
 * requirements it was planned against; it is a CANDIDATE: `buildAnswerTaskPack` adopts it
 * only when the flow facets planned against it require nothing outside its first page
 * (`answerFirstPageHolds`), and otherwise serves `ordinary`, so that every reply of the
 * chain is the flag-unset reply.
 */
export interface AnswerStructureMapChoice {
  readonly ordinary: AnswerStructureMap | undefined;
  readonly answerFirst: AnswerFirstCandidate | undefined;
}

export interface AnswerFirstCandidate {
  readonly map: AnswerStructureMap;
  /** The request's facet requirements as answer-first plans them: a file name it spells is a file name (`withoutNamedFileArtifacts`), not `Owner.member`. */
  readonly requirements: readonly FacetRequirement[];
}

export const NO_STRUCTURE_MAP: AnswerStructureMapChoice = { ordinary: undefined, answerFirst: undefined };

/** Bytes a structure-map reply needs beside its rows: task, decision and certificate, and the other envelope members. */
export const STRUCTURE_MAP_ENVELOPE_RESERVE_BYTES = 2048;

/** Wire bytes an evidence row takes beside its body and path: handle, range and the JSON keys. */
export const STRUCTURE_MAP_ROW_ADDRESS_BYTES = 64;

/**
 * …and what two owed rows must differ by before a row is worth addressing over the lines between them
 * (`coalesceAnswerRows`): a row served as its own surface (the owed rows of a continuation) takes about
 * 77 B beside its path and body (T03's 38-row page: handle, range, role "api", the JSON keys), more with a
 * `why` note or a longer role. The size of a page is NOT estimated with this number: it is read off the
 * serialized row (`estimateStructureMapReplyBytes`, "owed-row").
 */
export const STRUCTURE_MAP_OWED_ROW_ADDRESS_BYTES = 96;

/** A handle as the wire spells it: `h` and ten base-36 characters. */
export const STRUCTURE_MAP_OWED_ROW_HANDLE = `h${"0".repeat(10)}`;

/** The role of an owed row in the skeleton the estimate serializes: longer than any role the pack assigns today ("unknown", "contract"), for a role is free-form. */
export const STRUCTURE_MAP_OWED_ROW_ROLE = "x".repeat(12);

/**
 * Headroom `owedRowsFitOnePage` keeps under the cap. The estimate is an upper
 * bound of the owed rows themselves (their notes included), but not of the
 * act.answer that carries them: that reply also re-sends the type's head (the
 * file and class header rows), and the pack builder admits a reply only while
 * its own size preview (protocol/taskPackSizePreview.ts: a placeholder task id
 * and a reserve of up to 2,048 B beside the body) stays under the cap, and
 * sheds rows when it does not. Measured on helpers/owedRowsDesk.ts under the
 * Copilot CLI ceiling (18,432 B): the one-page act.answer was 0.55-0.61 KB
 * above the estimate at 12 to 21 steps (0.42-0.46 KB with four loop-guard notes
 * counted); 20 owed steps estimated 15.7 KB and were one 16.0 KB act.answer; 22
 * estimated 17.6 KB and the preview cut the page, four calls in all. The margin
 * is the swing of that reserve between a pack whose decision is derived later
 * (`TASK_PACK_PREVIEW_DISCOVER_RESERVE_BYTES`, 2,048 B) and one whose contract is
 * built (`TASK_PACK_PREVIEW_PREPARED_RESERVE_BYTES`, 512 B): the 1,536 B this
 * measurement found, now read off the preview's own constants instead of copied.
 */
export const STRUCTURE_MAP_FIT_MARGIN_BYTES = TASK_PACK_PREVIEW_DISCOVER_RESERVE_BYTES - TASK_PACK_PREVIEW_PREPARED_RESERVE_BYTES;

/**
 * TL_EFF_EVIDENCE_PATH_GROUPS: headroom the first page's admission keeps under
 * the cap when the rows are priced as they ship grouped. The estimate admits a
 * plan, but it is not an upper bound of the pack that gets built from it: a
 * measured pack outweighed its estimate by up to 320 B (the restated `next` that
 * ships where no cursor can be issued, the contract the rebuild adds, the row
 * addresses the constant undercounts), and a map cannot be trimmed row by row, so
 * a plan admitted within that error of the cap leaves the shed ladder nothing but
 * the map itself (T03, state store off: 1.6 KB where the ungrouped page was 17.6).
 * The planner admits the first source allowance, in steps of 1 KB, whose estimate
 * fits; ungrouped, T03's steps landed 595 B under the cap with the optional
 * content (`gaps`) for the trim ladder to shed, and grouped pricing moves the same
 * steps up by about two thousand bytes, to 78 B under it. The margin is the one the
 * continuation page keeps (`STRUCTURE_MAP_FIT_MARGIN_BYTES`: the swing of the
 * preview's reserve between a prepared and a discover pack); with the flag off
 * nothing changes.
 */
export const STRUCTURE_MAP_GROUPED_ADMISSION_MARGIN_BYTES = STRUCTURE_MAP_FIT_MARGIN_BYTES;

/**
 * Headroom the first page's admission keeps under an active cap when the builder
 * has no exact wire preview. The estimate prices the wire. The size preview that sizes a pack as
 * it ships (protocol/taskPackSizePreview.ts) is the builder's measure for an
 * exact-body host only; for any other the builder holds the INTERNAL result to the
 * ceiling, adds the decision, certificate and `next` the contract builds after it,
 * and gives the tail of the map back (`reduceServedBodyTail`) until the pack fits
 * again — or strips the map's body when even that is not enough. Measured with the
 * ladder forced onto each of its pages under 14,336 B (T03, and Python types in
 * files of 400-1,900 lines): a page estimated 941, 767 and 491 B under the ceiling
 * shipped 10 of 12, 16 of 20 and 9 of 14 of its rows, T03's skeleton page,
 * estimated 710 B over it, a 1.6 KB reply whose rows carry no body, and no page
 * with 1,380 B or more to spare lost a row.
 * This is a measured envelope allowance, not a bound derived from the preview
 * reserve: sampled post-build overhead was at most 1,380 B. Row shedding is
 * traced as structure_map_rows_shed so an insufficient allowance is visible.
 */
export const STRUCTURE_MAP_UNBATCHED_ADMISSION_MARGIN_BYTES = STRUCTURE_MAP_FIT_MARGIN_BYTES;

/** TL_EFF_MAP_ANSWER_FIRST applies under a pack ceiling below this (`includeDoc`'s own threshold: the compact hosts). */
export const STRUCTURE_MAP_ANSWER_FIRST_MAX_CAP_BYTES = 20 * 1024;

// The advisory is not sized by a tuned constant: `attachAnswerFirstAdvisory` attaches it
// to the finished pack and measures the pack with the advisory on it (the size preview, the
// first measurement of the shed ladder's `packWireBytes`), taking tiers and calls off the end
// until the pack fits. What the decision time uses for the room it will have
// (`answerFirstStructureMap`) is the finished pack's preview reserve
// (`TASK_PACK_PREVIEW_PREPARED_RESERVE_BYTES`) beside the planned page.
/** The most windows a continuation call can carry and still ship as one cursor (protocol/readCallContinuation.ts `compactableReadNext`). */
export const STRUCTURE_MAP_MAX_OWED_WINDOWS = 64;

/** At most this many enum types ride beside a structure map. */
export const STRUCTURE_MAP_MAX_STATE_TYPES = 2;

/** An enum type rides beside a map only when its whole declaration is at most this many source bytes. */
export const STRUCTURE_MAP_STATE_TYPE_MAX_BYTES = 4096;

/** Stage 2 inspects only a bounded number and aggregate byte size of C++ candidates. */
export const STRUCTURE_MAP_CPP_COUNTERPART_MAX_FILES = 32;

export const STRUCTURE_MAP_CPP_COUNTERPART_MAX_FILE_BYTES = 1_048_576;

export const STRUCTURE_MAP_CPP_COUNTERPART_MAX_SCAN_BYTES = 4_194_304;

/**
 * The structure map for an answer whose first candidate is `candidate`
 * (`ordinary`), or none unless the request asks for a short or map-shaped
 * answer (`asksForStructureMap`), names a flow facet, and the candidate is a type
 * with direct members whose comment-elided body does not fit one surface
 * (MAX_SURFACE_CODE_BYTES) — a type that fits is still served whole. A map
 * is paged to fit the pack's own cap (the code-bearing tier, under any
 * caller, environment or client-profile ceiling). Unserved map windows
 * remain required by the ordinary facet gate and get executable follow-ups.
 * `ordinary` is what the pack serves without TL_EFF_MAP_ANSWER_FIRST and is
 * computed exactly as it is without it; `answerFirst` is the flag's candidate, a
 * core-only map that `buildAnswerTaskPack` adopts only when the request's facets
 * require nothing outside its first page (`answerFirstPageHolds`).
 * A capped builder without exact wire preview additionally admits only a
 * page carrying the type's full skeleton; smaller ceilings keep the
 * whole-member route.
 */
/** A capped builder without an exact wire preview needs skeleton admission. */
export function packHeldToCeilingWithoutPreview(): boolean {
  return activePackByteCeiling() !== undefined && !preferExactAnswerBody(protocolCallContext()?.clientId);
}
