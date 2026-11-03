// sourceAndConcernTerms — extracted implementation; imports point to the owning modules.
import type { ConcernTermVariants } from "./sourceAndConcernTerms3.js";
import type { TaskPackSurface } from "../model.js";
import { concernCodeOnlyLines } from "./concernProof2.js";
import { containsJapanese } from "../../retrieval/jaQueryBridge.js";
import { evidenceSurfacesForPath } from "./sourceAndConcernTerms.js";
import { languageForPath } from "../../../util/languages.js";
import { readCached } from "./packBasics2.js";
import { servedLineSpansOf } from "./sourceAndConcernTerms.js";
import { subtractLineSpans } from "./sourceAndConcernTerms.js";
import { textHasWordVariant } from "../salientWordMatch.js";

/**
 * R-B1 (held item 1): true when a topic term the SERVED part of `relPath`
 * does not carry occurs at a real code position in the file's UNSERVED part
 * — see the route-(b) guard in `concernCoveredByServedEvidence`. English
 * variants only: a Japanese term never reaches route (b) (it is a bridge
 * guess, never `literalCodeAnchor`).
 */
export function unservedRemainderCarriesMissingTerm(
  relPath: string,
  terms: readonly string[],
  contentEvidenced: ReadonlySet<string>,
  variantsByTerm: ReadonlyMap<string, ConcernTermVariants>,
  priorEvidence: readonly TaskPackSurface[],
  workspace: string,
): boolean {
  const missing = terms.filter((term) => !contentEvidenced.has(term.toLowerCase()));
  if (missing.length === 0) return false;
  const content = readCached(workspace, relPath);
  if (content === undefined) return false;
  const lines = content.split(/\r\n|\r|\n/);
  const pieces = subtractLineSpans({ start: 1, end: Math.max(1, lines.length) }, servedLineSpansOf(evidenceSurfacesForPath(priorEvidence, relPath)));
  if (pieces.length === 0) return false;
  const variants = missing
    .flatMap((term) => variantsByTerm.get(term)?.variants ?? [term])
    .filter((variant) => variant.length > 0 && !containsJapanese(variant));
  if (variants.length === 0) return false;
  const codeLines = concernCodeOnlyLines(lines, languageForPath(relPath));
  // One text, split into words once: no word spans a line break, so this is the same answer as asking line by line.
  const unserved: string[] = [];
  for (const piece of pieces) {
    for (let n = Math.max(1, piece.start); n <= Math.min(piece.end, lines.length); n += 1) {
      unserved.push(codeLines[n - 1] ?? "");
    }
  }
  const unservedCode = unserved.join("\n");
  return variants.some((variant) => textHasWordVariant(unservedCode, variant));
}

export interface ConcernCoverageVerdict {
  covered: boolean;
  /** The served surfaces that cover the concern (empty when `covered` is false). */
  surfaces: TaskPackSurface[];
  /** Topic terms evidenced by the covering surfaces, for the reason string and TL_TRACE. */
  matchedTerms: string[];
  /**
   * The STRONGEST form of coverage: some covering surface carries the term at
   * a real CODE position, i.e. the implementation itself is on the wire — not
   * just a matching file name or a mention in that file's header comment.
   * Consulted only where "the caller actually holds the implementation"
   * matters on its own (the `analysis-source` reconciliation below).
   */
  codeAnchored: boolean;
  reason: string;
  /**
   * R-B3 (ruling 1): set only when NOTHING covers the concern and at least
   * one served surface WOULD have covered it through a single anchored term,
   * but another of the concern's topic terms is provably absent from the
   * whole scanned scope — the provably absent term, for the caller to
   * disclose as absent-in-scope (certification with a truthful disclosure,
   * no extra hop).
   */
  collisionAbsentTerm?: string;
}
