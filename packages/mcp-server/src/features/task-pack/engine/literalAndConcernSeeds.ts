// literalAndConcernSeeds — extracted implementation; imports point to the owning modules.
import * as fs from "fs";
import type { ArtifactTaskPackSection } from "../model.js";
import type { ConcernGroup } from "./roleAndConcernScope2.js";
import type { ContinuationCall } from "./packBasics.js";
import type { FindTextUniverse } from "../../search/find/findText.js";
import type { ImpactCandidate } from "@tokenlighten/types";
import type { TaskPackArgs } from "../model.js";
import { classifySurface } from "../../../util/impact.js";
import { createScanContentCache } from "../../search/find/findText.js";
import { createScanCoverage } from "../../search/find/findText.js";
import { enumerateFindTextUniverse } from "../../search/find/findText.js";
import { isNativeExtPath } from "../../../util/nativeSymbolRange.js";
import { literalFirstRoutingEnabled } from "../../../util/flags.js";
import { normIdent } from "./createAndWiringEndpoints2.js";
import { orderedUniqueTokens } from "./roleAndConcernScope2.js";
import { projectRootOf } from "../../locator/locateTaskContext.js";
import { readCached } from "./packBasics2.js";
import { readFileSafe } from "../../../util/safePath.js";
import { scanLiteral } from "../../search/find/findText.js";
import { shaOfText } from "../../../util/handles.js";
import { trace } from "../../../util/trace.js";

export function isTestConcernPath(relPath: string): boolean {
  return /(?:^|\/)(?:__tests__|tests?|specs?)(?:\/|$)/i.test(relPath)
    || /\.(?:spec|test)\.[^.]+$/i.test(relPath)
    // FIX-GOALIAS (eval-0929 §4/§8, WP-K): Go's own test convention is a
    // basename ending "_test.go" (underscore, never the dot the pattern
    // above requires) -- `findGoPackageConstantWindow`'s doc already claims
    // this exclusion for a sibling `_test.go` file; this generic helper
    // (18 call sites across caller/definition/candidate scans, every one of
    // them meaning "test file" for whatever language the path is in) never
    // actually matched it before this line existed.
    || /_test\.go$/i.test(relPath);
}

export function hasIdentifierSegment(text: string, token: string): boolean {
  const lowerText = text.toLowerCase();
  const lowerToken = token.toLowerCase();
  let from = 0;
  while (from < lowerText.length) {
    const index = lowerText.indexOf(lowerToken, from);
    if (index < 0) return false;
    const before = text[index - 1];
    const first = text[index];
    const after = text[index + token.length];
    const beforeBoundary = before === undefined
      || !/[A-Za-z0-9]/.test(before)
      || (/[a-z0-9]/.test(before) && first !== undefined && /[A-Z]/.test(first));
    const afterBoundary = after === undefined
      || !/[A-Za-z0-9]/.test(after)
      || (/[a-z0-9]/.test(text[index + token.length - 1] ?? "") && /[A-Z]/.test(after));
    if (beforeBoundary && afterBoundary) return true;
    from = index + 1;
  }
  return false;
}

export const CONCERN_DEFECT_EVIDENCE = [
  /\bdata race\b/i,
  /\brace condition\b/i,
  /\bwithout (?:holding|taking|acquiring|locking)\b/i,
  /\bsilently lost\b/i,
  /\bpartially[- ]written\b/i,
  /\bstale (?:pointer|state|value)\b/i,
  /\b(?:incorrect|wrong|broken|bug|fixme|todo)\b/i,
] as const;

export function concernDefectEvidence(
  content: string,
  hitLines: ReadonlySet<number>,
): { score: number; lines: number[] } {
  const lines = content.split(/\r?\n/);
  let score = 0;
  const evidenceLines = new Set<number>();
  const scoredMarkers = new Set<string>();
  for (const hitLine of hitLines) {
    const start = Math.max(0, hitLine - 81);
    const end = Math.min(lines.length, hitLine + 80);
    for (let index = start; index < end; index++) {
      for (const marker of CONCERN_DEFECT_EVIDENCE) {
        if (marker.test(lines[index] ?? "")) {
          evidenceLines.add(index + 1);
          const markerKey = `${index}:${marker.source}`;
          if (!scoredMarkers.has(markerKey)) {
            scoredMarkers.add(markerKey);
            score += marker.source.includes("race") || marker.source.includes("without") ? 4 : 2;
          }
        }
      }
    }
  }
  return { score: Math.min(12, score), lines: [...evidenceLines].sort((a, b) => a - b) };
}

export function concernLayerPathAdjustment(query: string, relPath: string): number {
  const lowerQuery = query.toLowerCase();
  const lowerPath = relPath.toLowerCase();
  const wantsBackend = /\b(?:backend|server-side)\b/.test(lowerQuery) || query.includes("バックエンド");
  const wantsFrontend = /\b(?:frontend|client-side)\b/.test(lowerQuery) || query.includes("フロントエンド");
  const wantsShared = /\bshared\b/.test(lowerQuery) || query.includes("共有");
  const wantsValidation =
    /\b(?:validation|validate|validator|schema|parse)\b/.test(lowerQuery)
    || /バリデーション|検証/.test(query);
  if (wantsValidation) {
    if (/(?:^|\/)(?:routes?|controllers?|schemas?|validation|middleware)(?:\/|$)/.test(lowerPath)) {
      return 22;
    }
    if (/(?:^|\/)repositories?(?:\/|$)/.test(lowerPath)) return -4;
  }
  if (wantsBackend) {
    if (/(?:^|\/)(?:backend|server|api)(?:\/|$)/.test(lowerPath)) return 12;
    if (/(?:^|\/)(?:frontend|web|ui)(?:\/|$)/.test(lowerPath)) return -8;
  }
  if (wantsFrontend) {
    if (/(?:^|\/)(?:frontend|web|ui)(?:\/|$)/.test(lowerPath)) return 12;
    if (/(?:^|\/)(?:backend|server|api)(?:\/|$)/.test(lowerPath)) return -8;
  }
  if (wantsShared && /(?:^|\/)(?:shared|common)(?:\/|$)/.test(lowerPath)) return 10;
  // (2026-08-02 anti-overfit, DESIGN-v0.10 §5 / spec-multiconcern-vocab §4.2)
  // TWO path-ranking nudges used to sit here and are both gone:
  //
  //   `wantsControl`  — /\b(?:control|controller|steering)\b/ OR
  //                     /制御|ステアリング/, ±24/−10 toward control/ over
  //                     math|util|support (§1a row 1).
  //   `wantsModeTransition` — see below.
  //
  // Both were EN/JA word pairs reverse-engineered from one fixture's symptoms
  // (139dbe74) and both were RANKING bonuses, never gates. "Fixture vocabulary
  // in server code is an automatic reject" outranks the fact that a nudge is
  // low-stakes: a nudge tuned to one benchmark is still tuning to one
  // benchmark, and it silently mis-ranked every report phrased any other way.
  // Neither is replaced — concernAnchorTokens' literal-identifier extraction
  // and literalConcernCandidates' co-occurrence score already rank these
  // candidates from the caller's own words plus repository evidence.
  //
  // A `wantsModeTransition` nudge used to sit here, gated by
  // /\bmode\b…\btransition\b/ OR /モード…遷移/ — an EN/JA word pair
  // reverse-engineered from one fixture's third symptom (139dbe74). It was a
  // ±24/±6 RANKING bonus, never a gate, and concernAnchorTokens' literal
  // identifier extraction plus literalConcernCandidates' co-occurrence score
  // already carry that weight structurally. Deleted rather than translated:
  // the fix for task-specific vocabulary is removal, not more languages
  // (editIntentForRole precedent).
  return 0;
}

export function concernFacetEvidenceScore(query: string, content: string, relPath: string): number {
  const haystack = `${relPath}\n${content}`;
  let score = 0;
  const aggregationShaped = /\b(?:stats?|statistics|aggregate|aggregation|counts?|summary)\b/i.test(query)
    || /統計|集計|件数/.test(query);
  const validationShaped = /\b(?:validation|validate|validator|schema)\b/i.test(query)
    || /バリデーション|検証/.test(query);
  if (
    aggregationShaped
    && /\b(?:stats?|statistics|aggregate|aggregation|counts?|summary|by[A-Z]\w*|per[A-Z]\w*)\b/i.test(haystack)
  ) {
    score += 10;
  }
  if (
    aggregationShaped
    && /(?:^|\/)(?:admin|analytics|metrics?|reports?)(?:\/|[A-Z_.-])/i.test(relPath)
  ) {
    score += 12;
  }
  if (
    validationShaped
    && /\b(?:coerce|normalize|normalise|allowed|isValid|validate|validator|parse|safeParse|nativeEnum|switch|case)\b/i.test(haystack)
  ) {
    score += 12;
  } else if (
    validationShaped
    && /\b(?:validation|schema|parse|safeParse)\b/i.test(haystack)
  ) {
    score += 4;
  }
  return score;
}

export async function literalConcernCandidates(
  workspace: string,
  group: ConcernGroup,
  onlyFiles: ReadonlySet<string>,
): Promise<ImpactCandidate[]> {
  interface HitGroup {
    path: string;
    lines: Set<number>;
    tokens: Set<string>;
    linesByToken: Map<string, Set<number>>;
    defectEvidence: number;
    defectLines: number[];
    facetEvidence: number;
  }
  const byPath = new Map<string, HitGroup>();
  for (const token of group.tokens.filter((value) => value.length >= 3).slice(0, 6)) {
    const matches = scanLiteral(token, workspace, {
      caseInsensitive: true,
      onlyFiles: new Set(onlyFiles),
    });
    for (const match of matches) {
      if (/^[a-z0-9_]+$/i.test(token) && !hasIdentifierSegment(match.text ?? "", token)) continue;
      const entry = byPath.get(match.path) ?? {
        path: match.path,
        lines: new Set<number>(),
        tokens: new Set<string>(),
        linesByToken: new Map<string, Set<number>>(),
        defectEvidence: 0,
        defectLines: [],
        facetEvidence: 0,
      };
      entry.lines.add(match.line);
      entry.tokens.add(token);
      const tokenLines = entry.linesByToken.get(token) ?? new Set<number>();
      tokenLines.add(match.line);
      entry.linesByToken.set(token, tokenLines);
      byPath.set(match.path, entry);
    }
  }
  let entries = [...byPath.values()];
  const nonTests = entries.filter((entry) => !isTestConcernPath(entry.path));
  if (nonTests.length > 0) entries = nonTests;
  await Promise.all(entries.map(async (entry) => {
    // served-bytes: not-served (concern-defect scoring: marker counting, no body derived from it)
    const content = await readFileSafe(entry.path, workspace);
    // Causal warning markers are useful only when lexical grounding is weak.
    // With several independent query tokens they can belong to an unrelated
    // defect elsewhere in the same file and must not outweigh co-occurrence.
    const defect = content === null || group.tokens.length > 1
      ? { score: 0, lines: [] }
      : concernDefectEvidence(content, entry.lines);
    entry.defectEvidence = defect.score;
    entry.defectLines = defect.lines;
    entry.facetEvidence = content === null
      ? 0
      : concernFacetEvidenceScore(group.query, content, entry.path);
  }));
  const score = (entry: HitGroup): number => {
    const lowerPath = entry.path.toLowerCase();
    const pathHits = group.tokens.filter((token) => lowerPath.includes(token)).length;
    const sourceBonus = /\.(?:c|cc|cpp|cxx|go|java|js|jsx|py|rs|ts|tsx)$/i.test(entry.path) ? 1 : 0;
    return entry.tokens.size * 10
      + pathHits * 4
      + Math.min(5, entry.lines.size)
      + sourceBonus
      + concernLayerPathAdjustment(group.query, entry.path)
      + entry.defectEvidence
      + entry.facetEvidence;
  };
  entries.sort((a, b) => score(b) - score(a) || a.path.localeCompare(b.path));

  return entries.slice(0, 3).map((entry) => {
    const anchorLines = [...entry.linesByToken.values()]
      .map((lines) => [...lines].sort((a, b) => a - b))
      .sort((a, b) => a.length - b.length)[0] ?? [...entry.lines].sort((a, b) => a - b);
    let cluster: number[] = [];
    for (let index = 0; index < anchorLines.length; index++) {
      const candidateCluster = anchorLines.slice(index).filter((line) => line - anchorLines[index]! <= 40);
      // Prefer the later cluster on ties: leading file comments frequently
      // name the concept while the executable implementation is farther down.
      if (candidateCluster.length >= cluster.length) cluster = candidateCluster;
    }
    const line = cluster[0] ?? anchorLines[0] ?? 1;
    // Concurrency/race fixes usually span the producer, guarded state, and
    // consumer/commit method. A single-symbol window hides the actual mutex
    // and invites agents to invent one, so keep a bounded cross-method slice.
    // Structural only (2026-08-02 anti-overfit): an identifier the CALLER
    // literally typed, or the content-side defect scan around the hit lines.
    // Two natural-language arms used to follow — EN concurren*/mutex/atomic/
    // lost-update and JA 競合/排他/同時/重な/片方…失わ — both reverse-engineered
    // from one fixture's symptom wording. concernDefectEvidence already reads
    // the FILE for `data race`/`partially-written`/`silently lost`/…, which is
    // the same conclusion drawn from evidence instead of from phrasing.
    const raceShaped = group.tokens.includes("race")
      || entry.defectEvidence >= 4;
    const lastMatchedLine = Math.max(...entry.lines, cluster.at(-1) ?? line);
    const range = raceShaped
      ? entry.defectLines.length > 0
        ? `${Math.max(1, entry.defectLines[0]! - 40)}-${Math.max(entry.defectLines.at(-1)!, lastMatchedLine) + 60}`
        : `${Math.max(1, line - 140)}-${(cluster.at(-1) ?? line) + 140}`
      : `${Math.max(1, line - 12)}-${(cluster.at(-1) ?? line) + 12}`;
    return {
      path: entry.path,
      line,
      range,
      surface: classifySurface(entry.path),
      why: "concern-literal",
      // Preserve the repository-observed co-occurrence score so callers can
      // reject a lexical tie instead of breaking it with a domain alias or
      // lexicographic filename order.
      confidence: Math.min(0.99, 0.45 + score(entry) * 0.01),
      required: true,
    };
  });
}

/** Minimum span for a served window to count as spanning several methods. */
export const CROSS_METHOD_MIN_SPAN_LINES = 60;

/**
 * True when a concern's served window spans several method bodies.
 *
 * literalConcernCandidates widens a concern's range to a cross-method window
 * EXACTLY when its structural race signal fired (`defectEvidence >= 4`, or the
 * caller literally typed `race`), and leaves it at a ±12-line single-symbol
 * window otherwise. The width therefore IS that verdict carried forward, which
 * is why the downstream sites can read it instead of re-running a
 * natural-language test of their own (2026-08-02 anti-overfit).
 */
export function isCrossMethodConcernRange(range: string | undefined): boolean {
  const parsed = /^(\d+)-(\d+)$/.exec(range ?? "");
  if (parsed === null) return false;
  return Number(parsed[2]) - Number(parsed[1]) + 1 >= CROSS_METHOD_MIN_SPAN_LINES;
}

// NOT ADDED (2026-08-02, measured): an "the companion must share >=1 concern
// anchor token" admission rule. It is self-defeating here — the companion is
// BY DEFINITION the file the reporter did not name, so requiring it to contain
// a word the reporter typed removes exactly the pairing this function exists
// to produce. Measured on the T05c fixture: concern ①'s anchors reduce to
// ["saturation"], which lives in pid.cpp and NOT in rate_controller.cpp, so
// the rule deleted the legitimate control-layer companion (and with it the
// concern's whole reason to look across the layer boundary). See the report
// for the affinity-based alternative that addresses cross-concern bleed
// without this contradiction.
export async function layeredControlCompanionCandidates(
  workspace: string,
  _group: ConcernGroup,
  onlyFiles: ReadonlySet<string>,
  existing: readonly ImpactCandidate[],
): Promise<ImpactCandidate[]> {
  // Structural admission (2026-08-02 anti-overfit, spec-multiconcern-vocab
  // §4.1). This used to require the query to contain one of
  // control|controller|steering|制御|ステアリング AND one of
  // saturat*|anti-windup|integrat*|clamp*|飽和|戻ら|蓄積 — eight words
  // reverse-engineered from one fixture's first symptom, which silently
  // dropped this pairing for every bug report in every other phrasing and
  // every other language. The 7-marker content scan below (`evidence >= 4`)
  // was always the real decision; the word test was a redundant pre-filter in
  // front of it. Now: attempt the probe whenever the leading candidate is
  // native, and let the file's own contents decide.
  const isControlLayer = (candidatePath: string): boolean =>
    /(?:^|\/)(?:control|controllers?)(?:\/|$)/i.test(candidatePath);
  const isMathLayer = (candidatePath: string): boolean =>
    /(?:^|\/)(?:math|numeric|algorithm)(?:\/|$)/i.test(candidatePath);
  const primary = existing[0];
  // The concern must ALREADY sit on the control⇄math boundary for a crossing
  // to mean anything. This is what the deleted word gate was really buying:
  // scope. Without a scope test the probe fires for every concern and can
  // hand a control-layer file to a concern that already has its own literal
  // primary elsewhere (measured: the mode-transition concern was reassigned
  // to rate_controller.cpp). Requiring the primary to be native AND on one
  // side of the boundary reproduces that scope from the file tree instead of
  // from the query's wording — and generalizes, because it no longer depends
  // on the reporter naming the layer.
  if (primary === undefined || !isNativeExtPath(primary.path)) return [];
  if (!isControlLayer(primary.path) && !isMathLayer(primary.path)) return [];
  // Decide from the leading causal owner, not from any lexical runner-up: a
  // mixer or unrelated file under /control/ can otherwise masquerade as the
  // missing stateful controller layer.
  const wantControl = primary === undefined || !isControlLayer(primary.path);
  const paths = [...onlyFiles]
    .filter((candidatePath) => isNativeExtPath(candidatePath))
    .filter((candidatePath) => /\.(?:c|cc|cpp|cxx)$/i.test(candidatePath))
    .filter((candidatePath) => wantControl ? isControlLayer(candidatePath) : isMathLayer(candidatePath));

  const ranked: Array<ImpactCandidate & { score: number }> = [];
  await Promise.all(paths.map(async (candidatePath) => {
    // served-bytes: not-served (companion-candidate discovery predicate: no body derived from it)
    const content = await readFileSafe(candidatePath, workspace);
    if (content === null) return;
    const markers = [
      /(?:^|[^a-z0-9])i_state_/i,
      /\bintegr(?:al|ator)/i,
      /\bclamp/i,
      /\b(?:out|output)_?limit/i,
      /\b(?:update|step)\s*\(/i,
      /\berror\b/i,
      /\bdt\b/i,
    ];
    const evidence = markers.filter((marker) => marker.test(content)).length;
    if (evidence < 4) return;
    const lines = content.split(/\r?\n/);
    // Anchor the companion at the stateful control callable, not the first
    // file-level marker. Large native modules commonly declare limits near
    // the top and implement update()/step() much later; centering on that
    // declaration produced a truthful file candidate whose embedded slice
    // omitted the actual edit site.
    const callableIndexes = lines
      .map((sourceLine, index) => ({ sourceLine: sourceLine.trim(), index }))
      .filter(({ sourceLine }) =>
        !/^(?:\/\/|\/\*|\*)/.test(sourceLine)
        && /\b(?:update|step)\s*\(/i.test(sourceLine)
      )
      .map(({ index }) => index);
    const neighborhoodScore = (index: number): number => {
      const neighborhood = lines
        .slice(Math.max(0, index - 12), Math.min(lines.length, index + 81))
        .join("\n");
      return markers.filter((marker) => marker.test(neighborhood)).length;
    };
    const matchedIndex = callableIndexes
      .sort((left, right) => neighborhoodScore(right) - neighborhoodScore(left))[0]
      ?? lines.findIndex((line) =>
        /i_state_|integr(?:al|ator)|clamp|(?:out|output)_?limit/i.test(line)
      );
    const line = Math.max(1, matchedIndex + 1);
    const pathScore = /(?:rate|attitude|position|velocity|pid).*controller/i.test(candidatePath)
      ? 10
      : /controller/i.test(candidatePath)
        ? 6
        : 0;
    const score = evidence * 6 + pathScore;
    ranked.push({
      path: candidatePath,
      line,
      range: `${Math.max(1, line - 24)}-${line + 80}`,
      surface: classifySurface(candidatePath),
      why: "concern-causal-layer",
      confidence: Math.min(0.94, 0.5 + score * 0.01),
      required: true,
      score,
    });
  }));
  ranked.sort((left, right) =>
    right.score - left.score || left.path.localeCompare(right.path)
  );
  return ranked.slice(0, 1).map(({ score: _score, ...candidate }) => candidate);
}

export interface PropagationSeedHit {
  path: string;
  line: number;
  role: string;
  tokens: Set<string>;
  definitionScore: number;
}

export type LiteralFrontierRole = "subject" | "destination" | "measurement-only";

export interface LiteralFrontierTerm {
  value: string;
  role: LiteralFrontierRole;
  /** Grammar pattern plus source span: absence is never inferred without it. */
  roleSource: string;
}

/**
 * Directed routing is an ordering hint, never a general-language edit parser.
 * An UNQUOTED atom must still look identifier/path-shaped to become an
 * edit-ready source/destination term -- bare prose ("the timeout", "status")
 * falls back to the ordinary locator. An EXPLICITLY QUOTED atom (the
 * caller's own `` `…` ``/`"…"`/`'…'`/`「…」`/`『…』` delimiters) is different
 * evidence: the delimiters are the caller's own unambiguous boundary, so its
 * interior -- Unicode text, internal whitespace, punctuation, case -- is
 * kept exactly as written (design v0.15 §7: never normalize a quoted
 * source's Unicode/whitespace/punctuation away). Only a genuinely empty
 * interior, or one spanning a hard line break (almost certainly two
 * sentences the outer grammar accidentally bridged), is rejected.
 */
export function literalFrontierAtom(value: string, quoted: boolean): string | undefined {
  if (quoted) {
    // English captures carry their own delimiters (the outer `atom`
    // alternation wraps the WHOLE quoted span, backticks/quotes included);
    // JA bracket captures are already delimiter-free (their regex capture
    // group excludes 「」/『』) -- stripping is a safe no-op for those.
    const interior = value.replace(/^[`"'「『]|[`"'」』]$/gu, "");
    if (interior.length === 0 || /[\r\n]/u.test(interior)) return undefined;
    // A quoted capture is ambiguous between a genuine literal -- a short UI
    // label ("Reload window", "Reload (window)", "日本語 ラベル"), an
    // identifier, or arbitrary caller-supplied text/code the atom regex's
    // OWN backtick/quote alternative already bounded tightly enough to
    // trust as a unit -- and a conceptual PROSE sentence describing one
    // ("the old status label"), which must still fall back to the ordinary
    // locator ("意味が曖昧なら推測編集しない", design v0.15 §7). A pure run
    // of lowercase ASCII letters/apostrophes/spaces -- no uppercase (Title
    // Case), digit, non-ASCII text (JA/etc.), or punctuation -- is exactly
    // that prose shape, whether it is one word or several (a long, purely
    // alphabetic-lowercase blob is just as ambiguous a "sentence" as a short
    // one); anything carrying even one such signal is trusted verbatim.
    if (/^[a-z\s']+$/u.test(interior)) return undefined;
    return interior;
  }
  const trimmed = value.trim();
  if (trimmed.length < 2 || /\s/u.test(trimmed)) return undefined;
  if (!/^[A-Za-z0-9_./:-]+$/u.test(trimmed)) return undefined;
  // Bare prose words ("status", "green", "default") are concepts, not
  // literal code evidence. Require an identifier/path signal even when the
  // relation grammar itself is otherwise unambiguous.
  return /[A-Z0-9_./:-]/u.test(trimmed) ? trimmed : undefined;
}

/**
 * True when a captured English `atom` alternative used an explicit quote
 * delimiter. The English regex's capture group spans the WHOLE alternative
 * (delimiters included when present), unlike the JA bracket groups whose own
 * regex already strips 「」/『』 before the value reaches here -- so JA
 * quoted-ness is instead known directly from which capture group matched
 * (see call sites below), never sniffed from content.
 */
export function isDelimitedAtomCapture(value: string): boolean {
  const t = value.trim();
  return t.length >= 2 && (
    (t.startsWith("`") && t.endsWith("`"))
    || (t.startsWith("\"") && t.endsWith("\""))
    || (t.startsWith("'") && t.endsWith("'"))
    || (t.startsWith("「") && t.endsWith("」"))
    || (t.startsWith("『") && t.endsWith("』"))
  );
}

export interface LiteralSourceWitness {
  path: string;
  line: number;
  root: string;
  implementation: boolean;
}

export function isLiteralImplementationPath(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  if (isTestConcernPath(relPath)) return false;
  return !(
    /(?:^|\/)(?:readme|changelog|contributing|license)(?:\.|$)/.test(lower)
    || /(?:^|\/)(?:docs?|examples?|fixtures?|__mocks__|mocks?)(?:\/|$)/.test(lower)
    || /\.(?:md|mdx|txt)$/u.test(lower)
  );
}

export function literalFirstMultipleRelations(query: string): boolean {
  const atom = "(?:`[^`]+`|[\"'][^\"']+[\"']|「[^」]+」|『[^』]+』|[A-Za-z0-9_./-]+)";
  const english = new RegExp(`\\b(?:replace|rename|change)\\s+(${atom})\\s+(?:with|to|into)\\s+(${atom})`, "giu");
  const japanese = /(?:「([^」]+)」|『([^』]+)』|([A-Za-z0-9_./-]+))\s*(?:を|から)\s*(?:「([^」]+)」|『([^』]+)』|([A-Za-z0-9_./-]+))\s*(?:に|へ)(?:変更|置換|改名|リネーム)/gu;
  return [...query.matchAll(english)].length + [...query.matchAll(japanese)].length > 1;
}

/** Extract a directed change relation without applying identifier-shape filters. */
export function literalFirstRelation(query: string, symbol?: string): LiteralFrontierTerm[] | undefined {
  const terms: LiteralFrontierTerm[] = [];
  const add = (value: string, role: LiteralFrontierRole, source: string, quoted: boolean): void => {
    const atomValue = literalFrontierAtom(value, quoted);
    if (atomValue === undefined || terms.some((term) => term.value === atomValue && term.role === role)) return;
    terms.push({ value: atomValue, role, roleSource: source });
  };
  const atom = "(?:`[^`]+`|[\"'][^\"']+[\"']|「[^」]+」|『[^』]+』|[A-Za-z0-9_./-]+)";
  const english = new RegExp(`\\b(?:replace|rename|change)\\s+(${atom})\\s+(?:with|to|into)\\s+(${atom})`, "iu").exec(query);
  const englishInsertRemove = new RegExp(`\\b(?:insert|add)\\s+(${atom}).*?\\b(?:remove|delete)\\s+(${atom})`, "iu").exec(query);
  const japanese = /(?:「([^」]+)」|『([^』]+)』|([A-Za-z0-9_./-]+))\s*(?:を|から)\s*(?:「([^」]+)」|『([^』]+)』|([A-Za-z0-9_./-]+))\s*(?:に|へ)(?:変更|置換|改名|リネーム)/u.exec(query);
  const japaneseInsertRemove = /(?:「([^」]+)」|『([^』]+)』|([A-Za-z0-9_./-]+))\s*を\s*(?:削除|remove).{0,40}?(?:「([^」]+)」|『([^』]+)』|([A-Za-z0-9_./-]+))\s*を\s*(?:挿入|insert)/iu.exec(query);
  // A conjunction of several directed edits is a multi-concern request. Do
  // not silently select the first relation and call it a pure rename; the
  // ordinary multi-concern/propagation flow keeps every clause visible.
  if (literalFirstMultipleRelations(query)) return undefined;
  if (english) {
    add(english[1]!, "subject", `english-directed:${english.index ?? 0}`, isDelimitedAtomCapture(english[1]!));
    add(english[2]!, "destination", `english-directed:${english.index ?? 0}`, isDelimitedAtomCapture(english[2]!));
  } else if (japanese) {
    add(japanese[1] ?? japanese[2] ?? japanese[3] ?? "", "subject", `japanese-directed:${japanese.index ?? 0}`, japanese[1] !== undefined || japanese[2] !== undefined);
    add(japanese[4] ?? japanese[5] ?? japanese[6] ?? "", "destination", `japanese-directed:${japanese.index ?? 0}`, japanese[4] !== undefined || japanese[5] !== undefined);
  } else if (englishInsertRemove) {
    add(englishInsertRemove[2]!, "subject", `english-insert-remove:${englishInsertRemove.index ?? 0}`, isDelimitedAtomCapture(englishInsertRemove[2]!));
    add(englishInsertRemove[1]!, "destination", `english-insert-remove:${englishInsertRemove.index ?? 0}`, isDelimitedAtomCapture(englishInsertRemove[1]!));
  } else if (japaneseInsertRemove) {
    add(japaneseInsertRemove[1] ?? japaneseInsertRemove[2] ?? japaneseInsertRemove[3] ?? "", "subject", `japanese-insert-remove:${japaneseInsertRemove.index ?? 0}`, japaneseInsertRemove[1] !== undefined || japaneseInsertRemove[2] !== undefined);
    add(japaneseInsertRemove[4] ?? japaneseInsertRemove[5] ?? japaneseInsertRemove[6] ?? "", "destination", `japanese-insert-remove:${japaneseInsertRemove.index ?? 0}`, japaneseInsertRemove[4] !== undefined || japaneseInsertRemove[5] !== undefined);
  } else {
    return undefined;
  }
  if (symbol) add(symbol, "subject", "args.symbol", false);
  // Compound segments are measured for collision/absence evidence only; the
  // whole dotted/slashed form above remains the sole propagation seed.
  for (const term of [...terms]) {
    if (term.role === "measurement-only") continue;
    for (const part of term.value.split(/[./]/u)) {
      if (part.length >= 2 && part !== term.value) add(part, "measurement-only", `segment-of:${term.roleSource}`, false);
    }
  }
  // TL142-02 Decision 2 (2026-09-13): every `add()` above can reject its
  // candidate (literalFrontierAtom's own length guard) and leave `terms`
  // EMPTY while still having matched english/japanese — an empty array is
  // not undefined, so the routing gate below (`!== undefined`) used to
  // treat a garbage digit-only match as a successful relation extraction.
  // Callers must see "nothing usable" and undefined mean the same thing.
  return terms.length > 0 ? terms : undefined;
}

/**
 * R-DEST: the replacement token is measured for collision/verification only.
 * It must never become a concern seed or a standing task obligation.
 */
export function literalFirstDestinationNorms(query: string): ReadonlySet<string> {
  if (!literalFirstRoutingEnabled()) return new Set<string>();
  return new Set(
    (literalFirstRelation(query) ?? [])
      .filter((term) => term.role === "destination")
      .map((term) => normIdent(term.value))
      .filter((term) => term.length > 0),
  );
}

/** A single exact match of the literal SOURCE, at (path, line, column) granularity. */
export interface LiteralSourceOccurrence {
  path: string;
  line: number;
  column: number;
}

export interface LiteralFirstMeasurement {
  /** `partial` is deliberately non-terminal: it cannot prove source absence. */
  kind: "present" | "absent" | "partial";
  source: LiteralFrontierTerm;
  seedTokens: string[];
  /** Destination already exists beside the exact source; never fast-edit it. */
  destinationCollision: boolean;
  /** Exact source occurrences retained internally for deterministic anchoring. */
  sourceWitnesses: readonly LiteralSourceWitness[];
  sourceImplementationPaths: number;
  sourceRootCount: number;
  scannedPaths: number;
  /** DISTINCT FILE count -- kept for the existing rarity-limit/root checks below, which are genuinely about file/root spread, not per-file occurrence count. */
  sourcePaths: number;
  /**
   * Design v0.15 §7: the TRUE occurrence count -- "一致ファイルが1件でも、
   * 同じファイルに2出現あれば一意ではない". Always >= `sourcePaths` (one
   * file contributing >= 1 occurrence each); never conflate the two:
   * `sourcePaths===1 && sourceOccurrenceCount===1` is the only shape that
   * may be treated as a genuinely unique replacement source.
   */
  sourceOccurrenceCount: number;
  /** Every occurrence backing `sourceOccurrenceCount`, for local-window construction. */
  sourceOccurrences: readonly LiteralSourceOccurrence[];
  destinationOccurrences: number;
  universePaths: number;
  universeFingerprint: string;
  universeComplete: boolean;
  universeScope: string;
  excludedPaths: number;
  universe: FindTextUniverse;
}

export function literalUniverseFingerprint(universe: FindTextUniverse): string {
  const files = universe.files.map((file) => {
    try {
      const stat = fs.statSync(file.absPath);
      return [file.relPath, stat.size, stat.mtimeMs] as const;
    } catch {
      return [file.relPath, -1, -1] as const;
    }
  });
  return shaOfText(JSON.stringify({
    policy: "ordinary-find-primary-v1",
    scopes: universe.scopes,
    files,
  }));
}

/**
 * Every exact, case-sensitive occurrence of `source` inside one already-
 * confirmed candidate file (a fresh, bounded re-read -- `scanLiteral`'s own
 * per-line regex has no `g` flag, so it cannot see a second occurrence on
 * the same line; this is the precise recount design v0.15 §7 requires).
 * `fallbackLine` is the witness `scanLiteral` already proved for this path,
 * used only if the reread itself fails (I/O race, since-deleted file) or
 * somehow finds nothing -- never UNDER-count below what was already proved.
 */
export function countSourceOccurrencesInFile(
  workspace: string,
  relPath: string,
  source: string,
  fallbackLine: number,
): LiteralSourceOccurrence[] {
  const content = source.length === 0 ? undefined : readCached(workspace, relPath);
  if (content === undefined) return [{ path: relPath, line: fallbackLine, column: 1 }];
  const out: LiteralSourceOccurrence[] = [];
  const lines = content.split(/\r\n|\r|\n/u);
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i]!;
    let from = 0;
    for (;;) {
      const at = lineText.indexOf(source, from);
      if (at < 0) break;
      out.push({ path: relPath, line: i + 1, column: at + 1 });
      from = at + source.length;
    }
  }
  return out.length > 0 ? out : [{ path: relPath, line: fallbackLine, column: 1 }];
}

export function literalFirstMeasurement(
  args: TaskPackArgs,
  query: string,
  workspace: string,
  scopes: readonly string[] | undefined,
): LiteralFirstMeasurement | undefined {
  const terms = literalFirstRelation(query, args.symbol);
  if (terms === undefined) return undefined;
  const source = terms.find((term) => term.role === "subject" && term.roleSource !== "args.symbol");
  if (source === undefined) return undefined;
  const universe = enumerateFindTextUniverse(workspace, {
    ...(scopes && scopes.length > 0 ? { paths: scopes } : {}),
  });
  const contentCache = createScanContentCache();
  const coverage = createScanCoverage();
  const presentSubjects: string[] = [];
  const sourceRoots = new Set<string>();
  const destinationRoots = new Set<string>();
  const sourceWitnesses = new Map<string, LiteralSourceWitness>();
  let directSourceOccurrences = 0;
  let destinationOccurrences = 0;
  for (const term of terms) {
    const paths = new Set<string>();
    // Design v0.15 §7: the replacement source is a fixed string, matched
    // CASE-SENSITIVELY -- "retry_limit" must never be credited as a witness
    // for a query naming "RETRY_LIMIT" (or vice versa). Same for the
    // destination: it exists to detect a collision with the exact source
    // identity, not a same-spelling-different-case neighbor.
    for (const match of scanLiteral(term.value, workspace, {
      caseInsensitive: false,
      files: universe.files,
      contentCache,
      coverage,
    })) {
      paths.add(match.path);
      if (term === source) {
        const root = projectRootOf(match.path, workspace);
        sourceRoots.add(root);
        if (!sourceWitnesses.has(match.path)) {
          sourceWitnesses.set(match.path, {
            path: match.path,
            line: match.line,
            root,
            implementation: isLiteralImplementationPath(match.path),
          });
        }
      }
      if (term.role === "destination") destinationRoots.add(projectRootOf(match.path, workspace));
    }
    if (term === source) directSourceOccurrences = paths.size;
    if (term.role === "destination") destinationOccurrences += paths.size;
    if (term.role === "subject" && paths.size > 0) presentSubjects.push(term.value);
  }
  const excludedPaths = Object.values(universe.omissions)
    .reduce((total, count) => total + count, 0);
  const universeComplete = coverage.scanned.size === universe.files.length
    && coverage.unscanned.size === 0
    && coverage.undecodable.size === 0
    && universe.omissions.unreadable_dirs === 0
    && universe.omissions.oversize === 0;
  // Design v0.15 §7: a genuine per-occurrence recount over just the
  // already-confirmed candidate files (never a second incomplete walk --
  // the file SET still comes entirely from the shared `universe` above).
  // `sourceWitnesses` deliberately keeps its existing first-per-path shape
  // (other consumers below key surfaces/candidates by distinct path); this
  // is an additional, independent view for exactly the "is this file's ONE
  // match its ONLY match" question.
  const sourceOccurrences = [...sourceWitnesses.values()]
    .flatMap((witness) => countSourceOccurrencesInFile(workspace, witness.path, source.value, witness.line))
    .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column);
  return {
    kind: directSourceOccurrences === 0
      ? universeComplete ? "absent" : "partial"
      : "present",
    source,
    seedTokens: orderedUniqueTokens(presentSubjects).slice(0, 6),
    destinationCollision: [...destinationRoots].some((root) => sourceRoots.has(root)),
    sourceWitnesses: [...sourceWitnesses.values()].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line),
    sourceImplementationPaths: [...sourceWitnesses.values()].filter((witness) => witness.implementation).length,
    sourceRootCount: sourceRoots.size,
    scannedPaths: coverage.scanned.size,
    sourcePaths: directSourceOccurrences,
    sourceOccurrenceCount: sourceOccurrences.length,
    sourceOccurrences,
    destinationOccurrences,
    universePaths: universe.files.length,
    universeFingerprint: literalUniverseFingerprint(universe),
    universeComplete,
    universeScope: universe.scopes.join(","),
    excludedPaths,
    universe,
  };
}

/**
 * Diagnostic-only route evidence.  It is intentionally not copied to the MCP
 * wire result: callers must opt in when they need to audit literal routing.
 */
export interface LiteralFirstRouteAttestation {
  kind: LiteralFirstMeasurement["kind"];
  source: string;
  sourcePaths: number;
  sourceImplementationPaths: number;
  sourceRootCount: number;
  destinationCollision: boolean;
  universeComplete: boolean;
  witnesses: readonly LiteralSourceWitness[];
}

export function literalFirstRouteAttestation(
  args: TaskPackArgs,
  query: string,
  workspace: string,
): LiteralFirstRouteAttestation | undefined {
  if (!literalFirstRoutingEnabled()) return undefined;
  const literal = literalFirstMeasurement(args, query, workspace, undefined);
  if (!literal) return undefined;
  return {
    kind: literal.kind,
    source: literal.source.value,
    sourcePaths: literal.sourcePaths,
    sourceImplementationPaths: literal.sourceImplementationPaths,
    sourceRootCount: literal.sourceRootCount,
    destinationCollision: literal.destinationCollision,
    universeComplete: literal.universeComplete,
    witnesses: literal.sourceWitnesses,
  };
}

export type LiteralFirstRouteOutcome = "source-absent" | "safeguarded" | "abstained" | "committed";

export function traceLiteralFirstRouteDecision(
  literal: LiteralFirstMeasurement | undefined,
  selectedPaths: readonly string[],
  routeOutcome: LiteralFirstRouteOutcome,
  workspace: string,
  remainingCountOverride?: number,
): void {
  if (!literal) return;
  const selected = new Set(selectedPaths);
  trace("literal_first_route_attestation", {
    schema_version: 1,
    eligible: true,
    attempted: true,
    committed: routeOutcome === "committed",
    route_outcome: routeOutcome,
    kind: literal.kind,
    source: literal.source.value,
    source_paths: literal.sourcePaths,
    source_implementation_paths: literal.sourceImplementationPaths,
    source_root_count: literal.sourceRootCount,
    destination_collision: literal.destinationCollision,
    universe_complete: literal.universeComplete,
    universe_fingerprint: literal.universeFingerprint,
    selected_count: selectedPaths.length,
    selected_paths: selectedPaths,
    remaining_count: remainingCountOverride ?? literal.sourceWitnesses.filter((witness) => !selected.has(witness.path)).length,
    witnesses: literal.sourceWitnesses.map((witness) => ({
      path: witness.path,
      line: witness.line,
      root: witness.root,
      implementation: witness.implementation,
    })),
  }, workspace);
}

export interface PropagationSeedResolution {
  paths: string[];
  auxiliaryCandidates?: readonly {path: string; rank: number}[];
  auxiliaryScopes?: readonly string[];
  literal?: LiteralFirstMeasurement;
}

export interface ArtifactBuildExtraction {
  section?: ArtifactTaskPackSection;
  sectionId?: string;
  next: ContinuationCall;
}
