// callerExpansion — extracted implementation; imports point to the owning modules.
import type { TaskPackArgs } from "../model.js";
import { elideDocComments } from "../../../util/formatCompress.js";
import { elisionLeftMarkersOnly } from "./packBasics2.js";
import { importSpecifiersNaming } from "../evidenceClosure.js";
import { languageForPath } from "../../../util/languages.js";
import { maskNonCode } from "../callerExpansion.js";
import { scanLiteral } from "../../search/find/findText.js";
import { sliceLinesToText } from "../../../util/countLines.js";

/** Lines scanned backward for the enclosing Go `interface {` opener. */
export const MAX_GO_INTERFACE_LOOKBACK_LINES = 200;

/**
 * Whether 1-based `line` sits directly inside a Go `interface { … }` body:
 * walks backward (≤ MAX_GO_INTERFACE_LOOKBACK_LINES) to the nearest `{` that
 * is still open at `line` and tests whether it opens an interface type.
 */
export function insideGoInterfaceBody(lines: readonly string[], line: number, hashComment: boolean): boolean {
  let depth = 0;
  for (let n = line - 1; n >= 1 && n >= line - MAX_GO_INTERFACE_LOOKBACK_LINES; n--) {
    const text = maskNonCode(lines[n - 1] ?? "", hashComment);
    for (let i = text.length - 1; i >= 0; i--) {
      const ch = text[i];
      if (ch === "}") depth += 1;
      else if (ch === "{") {
        if (depth === 0) return /\binterface\s*$/.test(text.slice(0, i));
        depth -= 1;
      }
    }
  }
  return false;
}

/** `text` with every closed `( … )` group (innermost first) replaced by a space. */
export function withoutClosedParenGroups(text: string): string {
  let out = text;
  for (let previous = ""; previous !== out;) {
    previous = out;
    out = out.replace(/\([^()]*\)/g, " ");
  }
  return out;
}

/** The last path segment of `p`, extension stripped — a cheap, filesystem-free stand-in for "same file" when the two paths being compared are not identical strings (a workspace-relative focal path vs. a relative import specifier). */
export function basenameNoExt(p: string): string {
  const last = p.split("/").pop() ?? p;
  return last.replace(/\.[^./]+$/, "");
}

/**
 * P0-2 (eval-0927 review-r2 #2, methodManyCallers/goMethodManyCallers): a
 * receiver reaching this point already failed BOTH of `receiverStrength`'s
 * name-based tiers (exact and weak-suffix) AND `fileNamesType` (the calling
 * file never mentions the focal's type name as TEXT) — but a generically-
 * named shared instance (`client: HttpClient`, `c: *zhttp.Client`) imported
 * straight from the type's OWN defining file is common, ordinary code, and
 * "the file names the type" is not the only legitimate corroboration for
 * it. True when the calling file imports `receiver` from a specifier whose
 * own file basename matches `focalPath`'s — reuses evidenceClosure.ts's
 * `importSpecifiersNaming` (name -> specifier text; TS/JS/Python/Java/C#/
 * C++ shapes) rather than a full resolver, which this boundary has no
 * filesystem access to run. A same-basename file in an unrelated directory
 * is the one (rare, harmless — it only adds an extra caller candidate)
 * false positive this basename-only comparison accepts, the same recall-
 * over-precision direction `receiverStrength`'s own weak tier already
 * favors. Go has no per-name import trace at all (`importSpecifiersNaming`'s
 * own documented limitation — a package import names no individual value),
 * so `goMethodManyCallers`'s `c *zhttp.Client` receiver is covered instead
 * by the plain `zhttp.Client`-vs-`Client` type-name match `receiverStrength`
 * already performs (the qualifier is stripped before this function is ever
 * reached) — this helper adds recall only for languages with a real
 * per-binding import line.
 */
export function receiverImportedFromFocalFile(lines: readonly string[], receiver: string, focalPath: string, hashComment: boolean): boolean {
  const focalBase = basenameNoExt(focalPath);
  if (focalBase.length === 0) return false;
  return importSpecifiersNaming(lines, receiver, hashComment).some((spec) => basenameNoExt(spec.specifier) === focalBase);
}

/**
 * Files a callers/flow FACET scan classifies line by line (eval-0927
 * review-r3 P2-13, genericMethodManyCallers/multilineSigManyCallers: 45
 * one-call caller files against the shared 40-file MAX_CALLER_FILES_EXAMINED
 * ended `undetermined` with nothing left to read). Separate from that shared
 * bound, which also sizes focal resolution and the edit-side caller
 * expansion: here every file was already opened by the literal scan, so
 * classifying one costs a cached read plus a regex per mentioning line, and
 * the result is the whole answer to "who calls X". Past it the scan still
 * reports `filesCapped` (disclosed `undetermined`).
 */
export const MAX_FACET_CALLER_FILES_CLASSIFIED = 128;

/** A member that is ASCII word characters end to end, so `\b<member>\b` is exact — see `facetCallerMentionScan`. */
export const ASCII_WORD_MEMBER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The literal scan behind both facet caller scans. Word-bounded when the
 * member is plain ASCII word characters: every occurrence
 * `findCallOccurrences` accepts has a non-identifier character before it and
 * `(`/`<`/whitespace after it, so a line with no `\b<member>\b` match can
 * never yield a site. Dropping such lines changes no site; it only keeps
 * files that merely contain the letters (`get` inside `budget`) from
 * spending MAX_FACET_CALLER_FILES_CLASSIFIED. Any other member keeps the
 * substring scan.
 *
 * FIX (R6-A, eval-0927 review-r5 P1-4, vueCaller): `scanLiteral`'s default
 * walk (`findText.ts`'s own `FIND_EXTRA_EXTS`, `.css` only) never opens a
 * `.vue`/`.svelte`/`.astro` single-file-component at all, so a real call
 * inside one of these was invisible to this scan and the facet was
 * certified `empty` over a workspace it never actually read. Their
 * `<script>` blocks are ordinary JS/TS lines once opened — no other
 * classifier in this module keys on the file extension in a way that
 * excludes them (`HASH_COMMENT_EXTENSIONS`/`VOID_OPERATOR_EXTENSIONS`/
 * `ALWAYS_KEYWORD_LED_EXTENSIONS` simply do not list them, so they fall
 * through to the same generic C-like path an untagged `.ts` file would)  —
 * `extraExts` is `scanLiteral`'s own ADDITIVE-only walk hook (does not
 * shrink the default tracked-code set), scoped to just this one call site
 * rather than every `walkCodeFiles` caller. Kept local rather than
 * imported: `findText.ts`'s own `FIND_EXTRA_EXTS` is module-private, and
 * this scan's needs (a few named framework SFC extensions) are narrower
 * than "whatever `find` walks" anyway.
 *
 * A3 (R7-A, eval-0927 review-r6 P1-5, cshtmlCaller/erbCaller/htmlScriptCaller/
 * mdxCaller/ipynbCaller): a real call inside a server-side template or a
 * notebook cell was equally invisible -- `.css`/`.vue`/`.svelte`/`.astro`
 * stay CLASSIFIED as call sites (their embedded blocks are ordinary JS/TS),
 * but the extensions below mix in markup, a template language this module
 * has no grammar for, or a JSON envelope (`.ipynb`) whose "lines" are not
 * source lines at all -- `isCallerMentionOnlyFile` routes every occurrence
 * in one of THESE straight to the unclassified-mention list instead (see its
 * own doc and `unclassifiedMentionLines`'s hookup), never through the
 * call/declaration classifier this module built for C-like/Python-like
 * source. `.mdx` behaves like Markdown with embedded JSX -- same reasoning.
 */
export const CALLER_MENTION_ONLY_EXTENSIONS: ReadonlySet<string> = new Set([
  ".html", ".htm", ".xhtml", ".cshtml", ".razor", ".vbhtml", ".aspx", ".ascx",
  ".jsp", ".erb", ".ejs", ".hbs", ".handlebars", ".mustache",
  ".jinja", ".jinja2", ".j2", ".twig", ".njk", ".liquid",
  ".pug", ".jade", ".haml", ".slim", ".mdx", ".ipynb",
  // A3 (R8-A, eval-0927 review-r7 P1-3, javaCallerFromScala/rubyCallerFromRake/
  // cCallerFromObjC): every source/script language this module's call-site
  // classifier has no grammar for -- a real call in one of these was equally
  // invisible to a by-name classified scan (the classifier's declaration/
  // call-shape heuristics were built for the C-like/Python-like languages the
  // rest of this file already handles). Every occurrence in one of these
  // routes straight to the unclassified-mention list instead, exactly like
  // the markup/template extensions above.
  ".swift", ".scala", ".sc", ".dart", ".groovy", ".gvy", ".gradle",
  ".m", ".mm", ".rake", ".gemspec", ".lua",
  ".ex", ".exs", ".erl", ".hrl",
  ".pl", ".pm", ".sh", ".bash", ".zsh", ".ps1", ".psm1",
  ".r", ".jl", ".clj", ".cljs", ".cljc", ".hs", ".ml", ".mli",
  ".fs", ".fsi", ".fsx", ".vb", ".coffee", ".elm", ".nim", ".zig",
]);

/**
 * True when `relPath`'s extension is one of `CALLER_MENTION_ONLY_EXTENSIONS`
 * -- see `FACET_MENTION_SCAN_EXTRA_EXTS`'s own A3 doc above for why these
 * (and only these) route straight to the mention list. Exported only for
 * `evaluation0927.r7aFalseEmptyGuard.spec.ts`.
 */
export function isCallerMentionOnlyFile(relPath: string): boolean {
  const dot = relPath.lastIndexOf(".");
  return dot > 0 && CALLER_MENTION_ONLY_EXTENSIONS.has(relPath.slice(dot).toLowerCase());
}

export const FACET_MENTION_SCAN_EXTRA_EXTS = [
  ".css", ".vue", ".svelte", ".astro",
  ...CALLER_MENTION_ONLY_EXTENSIONS,
] as const;

export function facetCallerMentionScan(member: string, workspace: string, args: TaskPackArgs): ReturnType<typeof scanLiteral> {
  const wordBounded = ASCII_WORD_MEMBER_RE.test(member);
  return scanLiteral(wordBounded ? `\\b${member}\\b` : member, workspace, {
    caseInsensitive: false,
    ...(wordBounded ? { regex: true } : {}),
    ...(args.path ? { path: args.path } : {}),
    extraExts: FACET_MENTION_SCAN_EXTRA_EXTS,
  });
}

/** What a caller window would really put on the wire — the same elided-embed measure `wholeFileEmbedBytes` takes, over one range. */
export function callerWindowEmbedBytes(content: string, relPath: string, start: number, end: number): number {
  const slice = sliceLinesToText(content, start, end);
  if (slice.length === 0) return Number.MAX_SAFE_INTEGER;
  const rawBytes = Buffer.byteLength(slice, "utf8");
  const elided = elideDocComments(slice, languageForPath(relPath), start);
  if (elisionLeftMarkersOnly(elided)) return rawBytes;
  return Math.min(rawBytes, Buffer.byteLength(elided, "utf8"));
}
