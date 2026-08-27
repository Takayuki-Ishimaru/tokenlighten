/**
 * findReferences — word-boundary identifier search (explore action=references).
 *
 * Walks code files and matches \bSYMBOL\b on each line. Lines that look like
 * line-comments are still returned but flagged via in_comment=true so callers
 * (and renameSymbol) can filter them.
 *
 * This is a LEXICAL heuristic, not AST resolution:
 *   - False positives in string literals are possible
 *   - Same identifier name in unrelated scopes is returned (no scope analysis)
 *
 * For full correctness use search_symbols (declarations) + read_code mode=symbol
 * to inspect each site. The trade-off is intentional — keeps the tool dep-free
 * and fast enough to run on every rename.
 *
 * C7 — the result exposes a `files` grouping (mirrors findText's
 * `buildFindResponse`/`FindFileGroup`): each file's matched lines carry
 * trimmed per-line source `snippets` (<=80 chars, match-centered via
 * findText's `trimMatchText`, same policy explore action=find uses) plus a
 * parallel `in_comment` array, so a rename/enum agent can enumerate call
 * sites — with enough source context to act on — in one call, without a
 * confirming read or native grep per site.
 *
 * The flat `references` array is kept for existing callers
 * (locateTaskContext.ts's `.slice(0, 5)` peek) that only need `.path`/
 * `.line`/`.in_comment`, but it is deliberately bounded to a small, FIXED
 * cost (REFERENCES_PEEK_CAP entries, no `text`) independent of how many
 * files fit in `files`. Two views of the same underlying reference set
 * would otherwise both compete for the identical 2048-byte budget and
 * roughly HALVE how many files can get a foothold in `files` — the one
 * view an enumerating agent actually needs — for no benefit, since no
 * caller reads more than a handful of entries off the flat array.
 *
 * E3 (2026-08-01 references-cursor): that cap is a CEILING, not a floor —
 * the peek is `min(REFERENCES_PEEK_CAP, effectiveLimit)` entries drawn from
 * the same served slice `files` is built from. It used to ignore `limit`
 * entirely, so a `limit:3` reply listed 3 file groups next to 10 flat
 * references — the response contradicting its own contract. The default
 * (no `limit`) path is unchanged: effectiveLimit is then MAX_REFERENCES
 * (200), so the peek is still REFERENCES_PEEK_CAP, which is what
 * locateTaskContext.ts's `.slice(0, 5)` reads.
 *
 * ND-2 (2026-08-08 references-cursor recall) — THE PEEK IS A PREFIX OF THE
 * PAGE, NOT OF THE SCAN FRONTIER. E3's "drawn from the same served slice
 * `files` is built from" was only true until the byte fit ran: the peek was
 * built from `servedRefs` (pre-fit) while `files` and the resume cursor come
 * from `fitted` (post-fit), so the two lists disagreed in both directions and
 * nothing disclosed it. Short peek (10 entries beside 16 emitted): a chain
 * walker reading `references[]` silently lost everything between the peek's
 * end and the cursor at EVERY boundary — measured 80 of 122 distinct
 * references (34%) on a 13-file C++ fixture, definition site included, with
 * the terminal page's honest `truncated:false` then certifying the short
 * union as complete. Long peek (10 entries beside 2 emitted, when long paths
 * let the fit seat only a couple of groups): the peek named references this
 * page never served and the NEXT page served them again. Post-ND-2 the peek
 * is re-derived from `fitted.files` — a prefix of the page, never past the
 * cursor — and any shortfall is stated in `references_omitted`, so the two
 * views can no longer contradict each other or the continuation. `files` is
 * still the enumeration surface; the peek stays a bounded convenience.
 *
 * L4 (2026-08-01 references-cursor v2) — LINE-GRANULAR OPAQUE CURSOR.
 * v1 (L3) paged with `after=<last-served-path>` at PATH granularity over
 * foothold-first (breadth) pages. Review falsified both halves: (a) a
 * `limit:3` page against a 10-reference file served 3 lines, then the
 * path-granular cursor excluded the WHOLE file — the other 7 lines were
 * permanently unreachable; (b) the foothold fit trims line-lists INSIDE
 * kept groups (Pass 2 widens round-robin), so a page was never a
 * (path,line) prefix and every trimmed line was likewise lost; (c) the
 * whitespace-joined `next` string broke on paths containing spaces
 * (`after=src/my dir/a.ts`). v2 contract:
 *
 *   (i)   pages are strict (path,line) PREFIXES of the remaining match
 *         stream — whole groups in path order; only the LAST group on a
 *         page may be line-truncated, disclosed via its `more_lines`;
 *   (ii)  the cursor is an OPAQUE base64url token encoding the last served
 *         (path,line) — server-issued only, safe for any path bytes, and
 *         line-granular so a mid-file cut resumes INSIDE the file;
 *   (iii) the continuation is a STRUCTURED `next_call` (tool + arguments),
 *         never a whitespace-joined string — quoting cannot break;
 *   (iv)  following `next_call` verbatim, repeatedly, serves EVERY matched
 *         LINE exactly once, then stops (no `next_call` on the last page);
 *   (v)   every page measures <= MAX_RESPONSE_BYTES except the floor case
 *         (one single line + envelope alone over the cap): the chain must
 *         ADVANCE, so that line is served anyway rather than stalling;
 *   (vi)  STATELESS + deterministic — the whole continuation state is the
 *         cursor inside the next call's own arguments; an undecodable
 *         cursor is ignored WITH `cursor_note` (serve-from-start beats a
 *         silently guessed window);
 *   (vii) `total` stays the true match count of the (still exhaustive)
 *         walk; `files_omitted` counts paths with NOTHING served this page.
 *
 * BREADTH was deliberately traded away: sampling a bit of every file is
 * incompatible with a scalar cursor (recovering skipped middles needs a
 * served-set bitmap, i.e. state). Exhaustive recall is THIS tool's
 * contract; breadth overview is findText's. `next_call` is emitted
 * whenever any matched line is unserved, whether the byte fit or the
 * caller's own `limit` withheld it (`truncation_reason` says which).
 */

import * as fs from "fs";
// PI-09 (v0.10 alpha.2): the paging cursor is now a purpose=continuation
// signed handle. Same field, same opacity — see encodeReferencesCursor.
import { looksLikeStateHandle } from "../state/handleCodec.js";
import { mintContinuationHandle, resolveContinuationHandle } from "../state/stateHandles.js";
import type { LangKey, WalkOmissions } from "./walkRepo.js";
import { walkCodeFiles, createWalkOmissions, TEXT_SCAN_MAX_FILE_SIZE_BYTES } from "./walkRepo.js";
import { escapeRegExp, trimMatchText, buildOmittedExtra, createScanCoverage } from "../features/search/find/findText.js";
import { decodeTextBuffer } from "../util/textDecode.js";
import { collectLexicalSegments, segmentKindAt } from "./lexicalRanges.js";
import {
  computeMemberSweep,
  MEMBER_SWEEP_HINT_TEXT,
  type MemberSweepAttachment,
  type MemberSweepCandidate,
} from "../features/search/find/memberSweep.js";

const MAX_REFERENCES = 200;
/** Safety valve: never tree-sitter-parse more than this many candidate files for one member_sweep lookup. */
const MAX_MEMBER_SWEEP_CANDIDATES = 20;

/** Hard byte cap for the full JSON response. */
export const MAX_RESPONSE_BYTES = 2048;

/**
 * Ceiling on the flat `references[]` convenience array — independent of
 * MAX_REFERENCES/the byte cap applied to `files`. locateTaskContext.ts only
 * reads `.slice(0, 5)`; 10 stays comfortably above that (double headroom)
 * while keeping the array's fixed cost small (~550B of the 2048B budget)
 * so most of the cap is left for `files` — the view that actually matters
 * for C7's "enumerate call sites in one call" goal.
 * E3 (2026-08-01 references-cursor): a caller's own `limit`, when smaller,
 * wins — see the module doc comment.
 */
const REFERENCES_PEEK_CAP = 10;

export interface FindReferencesInput {
  symbol: string;
  lang?: LangKey;
  /** Restrict to a file or subdirectory (workspace-relative). */
  path?: string;
  /** L2 (2026-08-01 references-contract): caller's match cap. Was accepted by
   * the advertised search_files schema and then silently dropped here. It now
   * clamps to [1, MAX_REFERENCES] and bounds only what is SERVED (the files[]
   * grouping input and the match-cap verdict) — `total` still reports the true
   * count, which is free because the walk is exhaustive either way. */
  limit?: number;
  /** L4 (2026-08-01 references-cursor v2): OPAQUE continuation token from a
   * prior response's `next_call.arguments.cursor` — server-issued base64url
   * encoding the last served (path,line), so a mid-file cut resumes INSIDE
   * the file and paths with spaces cannot break it. It is the ENTIRE
   * continuation state (stateless paging). An undecodable value is IGNORED
   * (serve-from-start) and disclosed via `cursor_note`; an over-the-end
   * cursor simply leaves nothing to serve. */
  cursor?: string;
}

export interface Reference {
  path: string;
  line: number;
  in_comment: boolean;
  /** Trimmed source line (<=80 chars, match-centered) for this reference.
   * NOT populated on the flat `references[]` array returned by
   * findReferences() (see the C7 module doc comment for why) — read
   * `files[].snippets` instead. The field exists on this type so a future
   * flat-array consumer that DOES want text can populate it without a type
   * change; the module's own construction paths leave it undefined here. */
  text?: string;
}

/**
 * One file's references, grouped so the path is not repeated per line —
 * mirrors findText.ts's `FindFileGroup`. `lines`, `snippets`, and
 * `in_comment` stay index-aligned (snippets/in_comment are parallel arrays
 * to `lines`, same convention as FindFileGroup.snippets).
 */
export interface ReferenceFileGroup {
  path: string;
  lines: number[];
  /** Trimmed source text per line, same order/length as `lines`. */
  snippets?: string[];
  /** Comment flag per line, same order/length as `lines`. */
  in_comment: boolean[];
  /** L2 (2026-08-01 references-contract): this path sits under a build-output
   * directory segment (dist/build/out/coverage/.next/target). Provenance
   * only — NEVER a filter: the full-recall rule in findReferences() requires
   * such hits still be returned, the caller just gets to weigh them. */
  generated?: boolean;
  /** L4 (2026-08-01 references-cursor v2): matched lines of THIS file not on
   * this page (the caller's `limit` or the byte fit cut mid-file). They are
   * recoverable — the page's `next_call` cursor resumes inside this file.
   * Same disclosure convention as findText's FindFileGroup.more_lines. */
  more_lines?: number;
}

/**
 * L2 (2026-08-01 references-contract): why `truncated` is true. Before this,
 * a `total:10, limit:50, truncated:true` response gave the caller no way to
 * tell a byte-fit from a match overflow, so it read as a bug in the tool.
 * Present exactly when `truncated` is true.
 */
export type ReferenceTruncationReason = "bytes" | "match-cap" | "match-cap+bytes";

/**
 * L2 (2026-08-01 references-contract): zero-match certificate — the same
 * honesty contract as findText's FindAbsence (features/search/find/findText.ts)
 * in a simpler shape. Only issued when files were actually opened and read, so
 * "I scanned nothing" can never render as "it isn't there".
 */
export interface ReferenceAbsence {
  /** Files opened and scanned. Unreadable ones are NOT counted here. */
  scanned_files: number;
  symbol: string;
  conclusion: string;
  /** Present when some walked files could not be read — the certificate then
   * covers only the scanned ones. */
  caveat?: string;
}

export interface FindReferencesResult {
  symbol: string;
  /** Bounded flat peek at THIS PAGE's references — always a PREFIX of the
   * lines in `files` (ND-2), never a reference the page did not emit and
   * never past the `next_call` cursor. `references_omitted` states what it
   * withholds. Enumerate `files`, not this, to act on call sites. */
  references: Reference[];
  /** References grouped by file — see ReferenceFileGroup. Enumerate this
   * (not `references`) to act on call sites without repeating the path. */
  files: ReferenceFileGroup[];
  truncated: boolean;
  /** L2 (2026-08-01 references-contract): present exactly when `truncated`. */
  truncation_reason?: ReferenceTruncationReason;
  total: number;
  /** F-W2D-1: per-layer skip counts from the walk, same shape/vocabulary as
   * findText.ts's FindResponse.omitted (see WalkOmissions) — present exactly
   * when at least one class fired. `total`/`files`/`absence` above cover only
   * what THIS walk scanned; a nonzero `oversize` in particular means at least
   * one file that could have referenced `symbol` was never opened (the walk's
   * size ceiling, not a deliberate exclusion) — re-scope directly at it to
   * include it. Was silently missing before F-W2D-1: this walk tracked no
   * omissions at all, so an oversize file's absence from every field above
   * was indistinguishable from "scanned and clean". */
  omitted?: Partial<WalkOmissions> & { undecodable?: number };
  /** L2 (2026-08-01 references-contract): file groups with NOTHING served on
   * this page — by the byte fit OR by the caller's `limit`
   * (`truncation_reason` says which). Per-PAGE number: groups served by
   * earlier pages of the chain are not "omitted", and a group whose TAIL
   * lines were cut is disclosed by its own `more_lines`, not counted here.
   * Present exactly when > 0, always alongside `next_call`. */
  files_omitted?: number;
  /** ND-2 (2026-08-08 references-cursor recall): references this page EMITTED
   * in `files` but did not repeat on the bounded flat `references` peek —
   * exactly `emitted - references.length`. Present exactly when > 0, so a
   * short peek can never read as the page's complete served set (the silent
   * shortfall was a 34% recall loss for peek-reading chain walkers). They are
   * NOT withheld: they are in `files` on this same page, and this page's
   * cursor already sits after them. */
  references_omitted?: number;
  /** L4 (2026-08-01 references-cursor v2): structured continuation of this
   * same search — run it verbatim; following it to exhaustion serves every
   * matched LINE exactly once (see the module doc contract). Present exactly
   * while any matched line is still unserved. Replaces the v1 string `next`,
   * whose whitespace-joined form broke on paths containing spaces. */
  next_call?: { tool: "search_files"; arguments: Record<string, unknown> };
  /** L4: present when the supplied cursor failed to decode — this page was
   * served from the START of the match list, never a guessed window. */
  cursor_note?: string;
  /** L2 (2026-08-01 references-contract): zero-match certificate, only on a
   * result that actually scanned something. */
  absence?: ReferenceAbsence;
  /** L1 (2026-07-30 T11 forensics): present when `symbol` resolves to a unique class/interface definition with >=2 members — a ready-to-run batched find call for member call-sites (see memberSweep.ts). */
  member_sweep?: MemberSweepAttachment;
  /** Present only alongside member_sweep. */
  hint?: string;
}

/**
 * Line-comment prefixes by language. Block comments (`/* ... *\/`) are
 * approximated: any line whose first non-whitespace token is `/​*`, `*`, or
 * `*​/` is treated as comment-like. Multi-line strings are NOT detected —
 * lexical-only.
 */
const LINE_COMMENT_PREFIXES: Record<string, string[]> = {
  typescript: ["//"], typescriptreact: ["//"],
  javascript: ["//"], javascriptreact: ["//"],
  java: ["//"], kotlin: ["//"], go: ["//"], rust: ["//"],
  c: ["//"], cpp: ["//"],
  csharp: ["//"], php: ["//"],
  python: ["#"], ruby: ["#"],
  default: [],
};

export function looksLikeComment(line: string, language: string): boolean {
  const trimmed = line.trimStart();
  if (!trimmed) return false;
  const prefixes = LINE_COMMENT_PREFIXES[language] ?? LINE_COMMENT_PREFIXES["default"]!;
  for (const p of prefixes) {
    if (trimmed.startsWith(p)) return true;
  }
  if (trimmed.startsWith("/*") || trimmed.startsWith("*/") || trimmed.startsWith("* ") || trimmed === "*") return true;
  return false;
}

const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

/**
 * L2 (2026-08-01 references-contract): build-output directory segments. A
 * match marks the group `generated:true` — provenance, never an exclusion
 * (see the full-recall rule in findReferences()). The basename is skipped on
 * purpose: `src/out.ts` is source, `src/out/x.ts` is build output.
 */
const GENERATED_SEGMENTS = new Set(["dist", "build", "out", "coverage", ".next", "target"]);

function isGeneratedPath(relPath: string): boolean {
  const segments = relPath.split("/");
  for (let i = 0; i < segments.length - 1; i++) {
    if (GENERATED_SEGMENTS.has(segments[i]!)) return true;
  }
  return false;
}

/** Longest of the three literals — every fit trial measures with this one so
 * the trial is a conservative over-estimate of the real field. */
const WIDEST_TRUNCATION_REASON = "match-cap+bytes";

function truncationReason(matchCapped: boolean, byteFitted: boolean): ReferenceTruncationReason {
  if (matchCapped && byteFitted) return "match-cap+bytes";
  return matchCapped ? "match-cap" : "bytes";
}

function effectiveMatchLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return MAX_REFERENCES;
  return Math.min(Math.max(1, Math.floor(limit)), MAX_REFERENCES);
}

/**
 * L3/L4 (2026-08-01 references-cursor): THE path ordering. Everything that
 * has to agree on "what comes after what" — the match sort, the group sort,
 * the cursor comparison — goes through this one comparator, so "served" is
 * provably a (path,line) prefix and the cursor can never skip a match.
 * (Replaces the old busiestDroppedScope/narrowingCall pair, which named one
 * modal directory and left every other dropped group unreachable.)
 */
function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** L4: the decoded cursor — the last (path, line) an earlier page served. */
interface ReferencesCursorPos {
  p: string;
  l: number;
}

/**
 * L4 / PI-09: server-issued opaque continuation token.
 *
 * WITH a workspace root this mints a purpose=`continuation` SIGNED handle
 * (`tlh_cont_v1_…`) — MAC-authenticated, workspace-bound and expiring, with the
 * `(path,line)` position riding the token's authenticated tail. Field position
 * is unchanged (`next.arguments.cursor`, F5) and the value was always opaque,
 * so this is a VALUE upgrade with no schema change: the guide's "never
 * hand-build its cursor" law is now enforced by a MAC instead of asked for in
 * prose.
 *
 * WITHOUT one (the no-arg form specs use) it emits the pre-PI-09 unsigned v1
 * encoding, which `decodeReferencesCursor` still accepts — see its
 * COMPATIBILITY WINDOW note.
 *
 * The mint falls back to the unsigned form rather than throwing: a cursor is a
 * page offset, and losing paging because key material is unavailable would be a
 * worse outcome than an unauthenticated offset into a search the server
 * re-executes and re-scopes from scratch anyway.
 */
export function encodeReferencesCursor(pos: ReferencesCursorPos, workspaceRoot?: string): string {
  if (workspaceRoot !== undefined) {
    const signed = mintContinuationHandle(workspaceRoot, { v: 1, p: pos.p, l: pos.l });
    if (signed !== undefined) return signed;
  }
  return Buffer.from(JSON.stringify({ v: 1, p: pos.p, l: pos.l }), "utf8").toString("base64url");
}

/**
 * L4: strict decode — anything malformed yields undefined, and the caller
 * discloses that through `cursor_note` + serve-from-start rather than refusing
 * a page outright (serving from the start re-serves at worst; a guessed window
 * silently loses matches).
 *
 * COMPATIBILITY WINDOW, stated rather than assumed. Two forms are accepted:
 *
 *  - `tlh_cont_v1_…` — the signed form this server now MINTS. A failed MAC,
 *    a wrong purpose, an expired lifetime or a foreign workspace all decode to
 *    undefined and therefore take the existing fresh-first-page path.
 *  - the pre-PI-09 unsigned base64url JSON. Still accepted in v0.10 because
 *    tokens minted by an older server (and the frozen replay-corpus case
 *    `rfc3_references_after_cursor_verbatim`, which carries one literally) must
 *    keep paging. Dropping it is a v0.11 decision once no pinned fixture
 *    carries one.
 *
 * Accepting the unsigned form costs nothing security-wise: this cursor is a
 * page OFFSET into a search the server re-executes and re-scopes from the
 * request, never a capability. A forged offset can only make the server skip
 * results it would otherwise have served — it can reach nothing new. The signed
 * form adds tamper-evidence, expiry and workspace binding to the tokens the
 * server actually issues, which is what makes a cross-workspace replay of a
 * SERVER-ISSUED cursor detectable.
 */
export function decodeReferencesCursor(token: string, workspaceRoot?: string): ReferencesCursorPos | undefined {
  if (looksLikeStateHandle(token)) {
    const resolved = resolveContinuationHandle<{ v?: unknown; p?: unknown; l?: unknown }>(token, workspaceRoot);
    if (!resolved.ok) return undefined;
    const payload = resolved.payload;
    if (payload.v !== 1 || typeof payload.p !== "string" || typeof payload.l !== "number" || !Number.isFinite(payload.l)) {
      return undefined;
    }
    return { p: payload.p, l: Math.floor(payload.l) };
  }
  try {
    const raw = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as Record<string, unknown>;
    if (raw["v"] !== 1 || typeof raw["p"] !== "string" || typeof raw["l"] !== "number" || !Number.isFinite(raw["l"])) {
      return undefined;
    }
    return { p: raw["p"], l: Math.floor(raw["l"] as number) };
  } catch {
    return undefined;
  }
}

/** L4: is this match strictly after the cursor position, in (path,line) order? */
function refAfterPos(ref: { path: string; line: number }, pos: ReferencesCursorPos): boolean {
  const c = comparePaths(ref.path, pos.p);
  return c > 0 || (c === 0 && ref.line > pos.l);
}

const CURSOR_INVALID_NOTE =
  "invalid cursor ignored — served from the start of the match list; use next_call.arguments.cursor verbatim";

/**
 * L4 (2026-08-01 references-cursor v2): the runnable STRUCTURED continuation.
 * Echoes the ORIGINAL scoping args (path/lang/limit) so following it verbatim
 * keeps paging the same search instead of silently widening it, carries the
 * clamped `limit` so the call is idempotent under re-issue, and puts the whole
 * continuation state in one opaque `cursor` token — no whitespace joining, so
 * a path like `src/my dir/a.ts` cannot corrupt the call.
 */
function continuationNextCall(
  symbol: string,
  pos: ReferencesCursorPos,
  input: FindReferencesInput,
  workspaceRoot?: string,
): { tool: "search_files"; arguments: Record<string, unknown> } {
  return {
    tool: "search_files",
    arguments: {
      action: "references",
      query: symbol,
      ...(input.path ? { path: input.path } : {}),
      ...(input.lang ? { lang: input.lang } : {}),
      ...(input.limit !== undefined ? { limit: effectiveMatchLimit(input.limit) } : {}),
      cursor: encodeReferencesCursor(pos, workspaceRoot),
    },
  };
}

/**
 * L2 (2026-08-01 references-contract): attach the zero-match certificate.
 * Cap discipline mirrors the match-bearing path — measure, then shed the
 * optional parts, rather than overshoot MAX_RESPONSE_BYTES.
 */
function withAbsence(
  result: FindReferencesResult,
  args: { symbol: string; scannedFiles: number; unreadableFiles: number; oversizeOmitted: number; undecodableFiles: number; subPath?: string },
): FindReferencesResult {
  // "Read nothing" must never render as "it isn't there" — no scan, no
  // certificate (same gate as findText's buildAbsenceExtra).
  if (args.scannedFiles === 0) return result;
  // F-W2D-1: an oversize-skipped file is an unknown remainder, not a
  // deliberate exclusion — the walk's size ceiling, not something the caller
  // asked for. Mirrors buildAbsenceExtra's unreadable_dirs/oversize gate:
  // no certificate, not even a caveated one, while any are outstanding. The
  // caller still sees the exclusion via `result.omitted.oversize`.
  if (args.oversizeOmitted > 0) return result;
  // 2026-08-27 (encoding-honesty): a file the walk opened and read, but
  // whose bytes could not be decoded with confidence (see
  // util/textDecode.ts's decodeTextBuffer), is the SAME unknown remainder as
  // an oversize file — content nobody actually read cannot be ruled out.
  // The caller still sees the exclusion via `result.omitted.undecodable`.
  if (args.undecodableFiles > 0) return result;
  const scope = args.subPath ? ` under '${args.subPath}'` : "";
  const base: ReferenceAbsence = {
    scanned_files: args.scannedFiles,
    symbol: args.symbol,
    conclusion: `no scanned file${scope} references this symbol`,
  };
  const plural = (n: number): string => (n === 1 ? "file" : "files");
  const full: ReferenceAbsence = args.unreadableFiles > 0
    ? {
        ...base,
        caveat: `${args.unreadableFiles} walked ${plural(args.unreadableFiles)} could not be read; absence covers only the ${args.scannedFiles} scanned ${plural(args.scannedFiles)}`,
      }
    : base;
  for (const candidate of [full, base]) {
    const withCert = { ...result, absence: candidate };
    if (Buffer.byteLength(JSON.stringify(withCert), "utf8") <= MAX_RESPONSE_BYTES) return withCert;
  }
  return result;
}

export async function findReferences(input: FindReferencesInput, workspace: string): Promise<FindReferencesResult> {
  const symbol = input.symbol;
  if (!symbol || !IDENT_RE.test(symbol)) {
    return { symbol, references: [], files: [], truncated: false, total: 0 };
  }

  const needle = new RegExp(`\\b${escapeRegExp(symbol)}\\b`, "g");

  // Full-recall: findReferences must see EVERY reference to be correct, so it
  // opts out of build-dir/generated noise filtering (a real `src/build/` or
  // `**/generated/` source file must not be silently dropped). The
  // bench-runs/cache/coverage exclusions still apply — those are never source.
  // F-W2D-1: `omissions` used to be omitted entirely — this walk tracked NO
  // skip counts, so an oversize (or ignored/gitignored) file's absence from
  // `all` below was indistinguishable from "scanned and clean". `sizeCapBytes`
  // widens the walk-time ceiling for this plain word-boundary scan the same
  // way findText.ts's scanLiteral does — see TEXT_SCAN_MAX_FILE_SIZE_BYTES.
  const walkOmissions = createWalkOmissions();
  const files = walkCodeFiles(workspace, {
    ...(input.lang ? { lang: input.lang } : {}),
    ...(input.path ? { subPath: input.path } : {}),
    fullRecall: true,
    omissions: walkOmissions,
    sizeCapBytes: TEXT_SCAN_MAX_FILE_SIZE_BYTES,
  });

  const all: Reference[] = [];
  const memberSweepCandidates: MemberSweepCandidate[] = [];
  // L2 (2026-08-01 references-contract): the absence certificate below has to
  // separate "scanned everything and found nothing" from "could not read
  // anything" — count both outcomes as the walk goes.
  let scannedFiles = 0;
  let unreadableFiles = 0;
  // 2026-08-27 (encoding-honesty): a ScanCoverage, reused purely for its
  // `.undecodable` Set — findReferences has no walk-time WalkOmissions slot
  // for this (it is discovered at scan time, not walk time), same reasoning
  // as findText.ts's own ScanCoverage.undecodable. `.scanned`/`.unscanned`
  // stay empty and unused here.
  const scanCoverage = createScanCoverage();

  for (const f of files) {
    let raw: string;
    try {
      const buf = fs.readFileSync(f.absPath);
      const decoded = decodeTextBuffer(buf);
      if (decoded === null) {
        // Walked and opened, but the bytes could not be verified as text —
        // never folded into "scanned" (that would certify absence over
        // content nobody actually read), nor into "unreadable" (an fs-level
        // error the caller can act on directly — this is a stronger,
        // hard-gating exclusion, same as findText.ts's buildAbsenceExtra).
        scanCoverage.undecodable.add(f.relPath);
        continue;
      }
      raw = decoded;
    } catch {
      unreadableFiles++;
      continue;
    }
    scannedFiles++;
    const lines = raw.split(/\r?\n/);
    const lexicalSegments = await collectLexicalSegments(raw, f.language);
    let fileHasNonCommentMatch = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      needle.lastIndex = 0;
      let match: RegExpExecArray | null;
      let foundOnLine = false;
      let inComment = false;
      let matchStart: number | undefined;
      while ((match = needle.exec(line)) !== null) {
        const kind = segmentKindAt(lexicalSegments, i + 1, match.index);
        if (kind === "string") continue;
        foundOnLine = true;
        matchStart = match.index;
        inComment = kind === "comment" || looksLikeComment(line, f.language);
        break;
      }
      if (foundOnLine) {
        if (!inComment) fileHasNonCommentMatch = true;
        all.push({
          path: f.relPath,
          line: i + 1,
          in_comment: inComment,
          text: trimMatchText(line, matchStart),
        });
      }
    }
    // L1 (2026-07-30 T11 forensics): a file with a real (non-comment) hit is
    // a candidate definition site — confirmed below (class/interface named
    // `symbol`, via collectSymbols) reusing this ALREADY-READ content, no
    // re-read/re-walk. Bounded so a widely-referenced symbol never
    // tree-sitter-parses every matched file.
    if (fileHasNonCommentMatch && memberSweepCandidates.length < MAX_MEMBER_SWEEP_CANDIDATES) {
      memberSweepCandidates.push({ path: f.relPath, content: raw, language: f.language });
    }
  }

  // L3 (2026-08-01 references-cursor): impose THE ordering before anything
  // slices. walkCodeFiles is already byte-sorted by path, but the `limit`
  // slice, the group sort and the cursor must agree under ONE comparator for
  // "served" to be a provable prefix (see the module doc comment) — so sort
  // here rather than inherit the walk's incidental order.
  all.sort((a, b) => comparePaths(a.path, b.path) || a.line - b.line);

  // L4: the continuation cursor — LINE-granular. Everything at or before the
  // decoded (path,line) was served by an earlier page of this chain; this
  // page starts strictly after it. An undecodable token is IGNORED and
  // disclosed (cursor_note): serving from the start re-serves at worst,
  // while a guessed window would silently lose matches.
  const cursorToken = typeof input.cursor === "string" && input.cursor.length > 0 ? input.cursor : undefined;
  const cursorPos = cursorToken !== undefined ? decodeReferencesCursor(cursorToken, workspace) : undefined;
  const cursorInvalid = cursorToken !== undefined && cursorPos === undefined;
  const windowed = cursorPos === undefined
    ? all
    : all.filter((r) => refAfterPos(r, cursorPos));

  // L2 (2026-08-01 references-contract): `limit` bounds the SERVED slice only
  // — the grouping input below and this match-cap verdict. `total` further
  // down still reports every match the (already exhaustive) walk saw.
  const effectiveLimit = effectiveMatchLimit(input.limit);
  const matchTruncated = windowed.length > effectiveLimit;
  const servedRefs = matchTruncated ? windowed.slice(0, effectiveLimit) : windowed;

  // Flat `references[]` — a small, FIXED-cost convenience peek (no `text`,
  // capped independently of `files`). Kept for locateTaskContext.ts's
  // `.slice(0, 5)` and any other caller that just wants a quick path/line
  // list. Its cost does not vary with how many files matched, so it never
  // competes with `files` for cap budget.
  // E3 (2026-08-01 references-cursor): drawn from the SERVED slice and never
  // longer than the caller's own `limit` — a `limit:3` response peeking 10
  // references contradicted its own contract. Unset `limit` keeps the
  // pre-E3 behavior exactly (effectiveLimit is then 200 > the peek cap).
  // ND-2: `peekProbe` is the pre-fit WORST CASE and exists only so the byte
  // fit can measure the peek exactly (the L2 rule — peek/disclosure bytes ride
  // inside the trials, never appended after one picked `files`). The peek that
  // actually ships is re-derived from `fitted.files` after the fit; because
  // `fitted.files` is a (path,line) prefix of `servedRefs`, that shipped peek
  // is always a PREFIX of `peekProbe`, so the trials stay a conservative
  // over-estimate and no response can outgrow what it measured.
  const peekWidth = Math.min(REFERENCES_PEEK_CAP, effectiveLimit);
  const peekOf = (refs: readonly Reference[]): Reference[] =>
    refs.slice(0, peekWidth).map((r) => ({ path: r.path, line: r.line, in_comment: r.in_comment }));
  const peekProbe: Reference[] = peekOf(servedRefs);

  // L2 (2026-08-01 references-contract): certify a genuine zero instead of
  // returning a bare empty shape the caller has to re-grep to trust. Nothing
  // below applies with no matches (no groups to fit, no member_sweep
  // candidates), so this is also the cheap path.
  if (all.length === 0) {
    return withAbsence(
      { symbol, references: peekProbe, files: [], truncated: false, total: 0, ...buildOmittedExtra(walkOmissions, scanCoverage) },
      {
        symbol,
        scannedFiles,
        unreadableFiles,
        oversizeOmitted: walkOmissions.oversize,
        undecodableFiles: scanCoverage.undecodable.size,
        ...(input.path ? { subPath: input.path } : {}),
      },
    );
  }

  // C7 — group by file (path not repeated per line) and fit within
  // MAX_RESPONSE_BYTES, same foothold-first policy as findText.ts's
  // fitFilesToCap: every matched file keeps at least one line before any
  // file's line-list is trimmed further, and before any file is dropped.
  // `references` is fixed-size at this point (capped above, independent of
  // `files`), so fitReferencesToCap can include it EXACTLY in its trial
  // measurements without the loop needing to recompute it per trial.
  const memberSweep = memberSweepCandidates.length > 0
    ? await computeMemberSweep(symbol, memberSweepCandidates)
    : undefined;
  // F-W2D-1: `omitted` rides the SAME budgeted `extra` record member_sweep
  // already uses — baked into every fitReferencesPrefix trial below via
  // reasonProbe/continuationProbe (both spread `...extra`), never appended
  // after the fit picked `files` (the L2 rule this file's other disclosure
  // fields already follow).
  const extra: Record<string, unknown> = {
    ...buildOmittedExtra(walkOmissions, scanCoverage),
    ...(memberSweep ? { member_sweep: memberSweep, hint: MEMBER_SWEEP_HINT_TEXT } : {}),
  };

  const fileGroups = groupReferencesByFile(servedRefs);

  // L2 (2026-08-01 references-contract): the disclosure fields must sit inside
  // the fit's own trial measurements, never appended after it picked `files`
  // — the same rule `extra` already follows. `truncation_reason` bakes the
  // longest literal; `files_omitted`/`next_call` bake conservative worst
  // cases (max distinct unserved paths; a cursor token built from the
  // LONGEST path any group could name — token length grows with path
  // length); `cursor_note` is baked exactly whenever it will ride.
  // L4 (2026-08-01 references-cursor v2): when `limit` already withheld
  // matches this page is CERTAIN to carry a continuation, so the worst case
  // goes into pass 1 directly — otherwise a match-capped page could append
  // `next_call` to a `files` list the fit had only validated without it.
  const invalidNoteExtra: Record<string, unknown> = cursorInvalid
    ? { cursor_note: CURSOR_INVALID_NOTE }
    : {};
  // ND-2: `references_omitted` can ride on ANY page whose emitted set outruns
  // the peek — including an untruncated one — so its worst case goes into the
  // base probe every trial measures. MAX_REFERENCES is the widest literal the
  // real value can ever reach (the true count is <= MAX_REFERENCES - 1).
  const reasonProbe: Record<string, unknown> = {
    ...extra,
    ...invalidNoteExtra,
    truncation_reason: WIDEST_TRUNCATION_REASON,
    references_omitted: MAX_REFERENCES,
  };
  const widestPath = fileGroups.map((g) => g.path).reduce((a, b) => (b.length > a.length ? b : a), "");
  const continuationProbe: Record<string, unknown> = {
    ...reasonProbe,
    files_omitted: new Set(windowed.map((r) => r.path)).size,
    // PI-09: the probe must be signed too. It exists to RESERVE bytes for the
    // continuation the real emission will carry, and a signed token is ~3x the
    // unsigned one — measuring the cheap form and emitting the expensive one
    // would under-reserve and blow the fit. Widest path + max line keeps it an
    // upper bound on the real token's authenticated tail, which is exactly the
    // property this probe already relied on.
    next_call: continuationNextCall(symbol, { p: widestPath, l: 2147483647 }, input, workspace),
  };
  // L4: matched lines of the LAST limit-sliced group lying beyond the slice —
  // stamped on that group (as more_lines) BEFORE the fit so every trial
  // measures it exactly; the fit adds its own trim count on top at a cut.
  const lastSlicedPath = fileGroups.length > 0 ? fileGroups[fileGroups.length - 1]!.path : undefined;
  const limitRemainderForLast = lastSlicedPath === undefined
    ? 0
    : windowed.slice(servedRefs.length).filter((r) => r.path === lastSlicedPath).length;
  let fitted = fitReferencesPrefix(
    fileGroups, symbol, peekProbe, all.length, MAX_RESPONSE_BYTES,
    matchTruncated ? continuationProbe : reasonProbe,
    limitRemainderForLast,
  );
  if (fitted.cut && !matchTruncated) {
    fitted = fitReferencesPrefix(
      fileGroups, symbol, peekProbe, all.length, MAX_RESPONSE_BYTES,
      continuationProbe, limitRemainderForLast,
    );
  }

  // L4: the page is a strict (path,line) prefix, so the LAST SERVED LINE is
  // the entire continuation state — a mid-file cut resumes inside the file.
  // Empty `files` only happens when the caller's cursor already ran past
  // every match: end of chain, nothing to point at (whenever `windowed` is
  // non-empty, effectiveLimit >= 1 plus the fit's one-line floor guarantee
  // at least one served line).
  const lastGroup = fitted.files.length > 0 ? fitted.files[fitted.files.length - 1] : undefined;
  const lastPos: ReferencesCursorPos | undefined = lastGroup !== undefined
    ? { p: lastGroup.path, l: lastGroup.lines[lastGroup.lines.length - 1]! }
    : undefined;
  const unservedAfter = lastPos === undefined ? 0 : windowed.filter((r) => refAfterPos(r, lastPos)).length;
  const omittedPaths = new Set<string>();
  if (lastPos !== undefined) {
    for (const r of windowed) {
      if (refAfterPos(r, lastPos) && r.path !== lastPos.p) omittedPaths.add(r.path);
    }
  }
  const truncated = matchTruncated || fitted.cut;

  // ND-2: the page's ACTUALLY EMITTED references, in cursor order — the same
  // set `lastPos` was derived from. The flat peek is a prefix of THIS, so it
  // can never name a reference the page withheld nor sit past the cursor, and
  // whatever it does not repeat is counted rather than dropped in silence.
  const emittedRefs: Reference[] = fitted.files.flatMap((g) =>
    g.lines.map((line, i) => ({ path: g.path, line, in_comment: g.in_comment[i] ?? false })));
  const references = peekOf(emittedRefs);
  const referencesOmitted = emittedRefs.length - references.length;

  return {
    symbol,
    references,
    ...(referencesOmitted > 0 ? { references_omitted: referencesOmitted } : {}),
    files: fitted.files,
    truncated,
    ...(truncated ? { truncation_reason: truncationReason(matchTruncated, fitted.cut) } : {}),
    total: all.length,
    ...(cursorInvalid ? { cursor_note: CURSOR_INVALID_NOTE } : {}),
    ...(omittedPaths.size > 0 ? { files_omitted: omittedPaths.size } : {}),
    ...(unservedAfter > 0 && lastPos !== undefined
      ? { next_call: continuationNextCall(symbol, lastPos, input, workspace) }
      : {}),
    ...extra,
  };
}

/**
 * Group references by file, path not repeated per line — mirrors
 * findText.ts's groupByFile. Lines (and their parallel snippets/in_comment
 * entries) are sorted ascending per file for readability.
 */
function groupReferencesByFile(references: Reference[]): ReferenceFileGroup[] {
  interface Entry { line: number; text?: string; in_comment: boolean }
  const byPath = new Map<string, Entry[]>();
  for (const r of references) {
    let list = byPath.get(r.path);
    if (!list) {
      list = [];
      byPath.set(r.path, list);
    }
    list.push({ line: r.line, text: r.text, in_comment: r.in_comment });
  }
  const groups: ReferenceFileGroup[] = [];
  for (const [p, entries] of byPath) {
    entries.sort((a, b) => a.line - b.line);
    const hasAnyText = entries.some((e) => e.text !== undefined);
    groups.push({
      path: p,
      lines: entries.map((e) => e.line),
      ...(hasAnyText ? { snippets: entries.map((e) => e.text ?? "") } : {}),
      in_comment: entries.map((e) => e.in_comment),
      // L2 (2026-08-01 references-contract): stamped here, before the fit, so
      // the flag is measured EXACTLY by every trial rather than added after.
      ...(isGeneratedPath(p) ? { generated: true } : {}),
    });
  }
  // Byte-stable order: path ascending (same convention as findText.ts).
  return groups.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
/**
 * L4 (2026-08-01 references-cursor v2): fit a grouped file list to `maxBytes`
 * as a strict (path,line) PREFIX — whole groups in path order; only the LAST
 * kept group may be line-truncated, and its withheld tail is disclosed on the
 * group itself as `more_lines`. This replaces the foothold/round-robin fit
 * (v1), whose "a bit of every file" pages were incompatible with a scalar
 * cursor: every line it trimmed inside a kept group was permanently skipped
 * once the path-granular cursor moved past that file.
 *
 * Floor guarantee: when even ONE line + envelope exceeds `maxBytes` and
 * nothing else was kept, that line is served anyway — the chain must advance
 * (a stalled page whose next_call re-points at itself would loop forever).
 *
 * `lastGroupExtraMoreLines` carries the caller's `limit` remainder for the
 * final sliced group, so the stamped `more_lines` is measured exactly by
 * every trial and the fit's own trim count stacks on top at a cut.
 */
function fitReferencesPrefix(
  groups: ReferenceFileGroup[],
  symbol: string,
  references: Reference[],
  total: number,
  maxBytes: number,
  extra: Record<string, unknown>,
  lastGroupExtraMoreLines: number,
): { files: ReferenceFileGroup[]; cut: boolean } {
  // `build()` measures every trial with `truncated:false` — the LONGER of the
  // two literals ("false", 5 bytes, vs "true", 4) — so every trial is a
  // conservative (over-)estimate of the real final size. `references` is
  // fixed (bounded independently, computed once by the caller) so it can be
  // included exactly on every trial; `extra` bakes the caller's worst-case
  // disclosure fields the same way — never appended after the fit picked
  // `files` (the L2 rule).
  const build = (fs: ReferenceFileGroup[]): unknown =>
    ({ symbol, references, files: fs, truncated: false, total, ...extra });
  const fits = (fs: ReferenceFileGroup[]): boolean =>
    Buffer.byteLength(JSON.stringify(build(fs)), "utf8") <= maxBytes;

  if (groups.length === 0) return { files: [], cut: false };

  // Stamp the caller's limit remainder on the final sliced group so trials
  // measure it exactly (see the call site).
  const stamped = groups.map((g, i) =>
    i === groups.length - 1 && lastGroupExtraMoreLines > 0
      ? { ...g, more_lines: lastGroupExtraMoreLines }
      : g);
  if (fits(stamped)) return { files: stamped, cut: false };

  // Greedy prefix: whole groups in path order until the budget refuses one.
  const kept: ReferenceFileGroup[] = [];
  for (const g of stamped) {
    if (fits([...kept, g])) {
      kept.push(g);
      continue;
    }
    // Cut point: serve this group's HEAD lines; disclose the withheld tail on
    // the group itself via more_lines (stacking on any limit remainder the
    // stamp above already recorded).
    const baseMore = g.more_lines ?? 0;
    const headOf = (lineCount: number): ReferenceFileGroup => ({
      path: g.path,
      lines: g.lines.slice(0, lineCount),
      ...(g.snippets ? { snippets: g.snippets.slice(0, lineCount) } : {}),
      in_comment: g.in_comment.slice(0, lineCount),
      ...(g.generated ? { generated: true } : {}),
      more_lines: baseMore + (g.lines.length - lineCount),
    });
    for (let lineCount = g.lines.length - 1; lineCount >= 1; lineCount--) {
      const candidate = headOf(lineCount);
      if (fits([...kept, candidate])) return { files: [...kept, candidate], cut: true };
    }
    if (kept.length === 0) {
      // Floor: one line + envelope alone exceeds maxBytes. Serve it anyway —
      // the chain must ADVANCE past this line, or a page would re-point its
      // next_call at itself forever.
      return { files: [headOf(1)], cut: true };
    }
    return { files: kept, cut: true };
  }
  // Unreachable in practice (the all-groups trial above failed, so some group
  // must refuse admission), kept for type-totality.
  return { files: kept, cut: kept.length < stamped.length };
}
