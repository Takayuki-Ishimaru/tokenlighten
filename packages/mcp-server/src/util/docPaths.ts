/**
 * docPaths.ts — which documents are LOW-VALUE answer evidence, and whether a
 * request names one.
 *
 * WHY THIS EXISTS (2026-10-29 field report). Following `next` verbatim on
 * express's "How does res.redirect work?" for ten hops returned 129 KB, paging
 * the 3,928-line History.md to its end; res.redirect was never served. A
 * changelog is a chronological log of past edits: it mentions almost every
 * identifier of a project on some line, so a lexical locator ranks it, and a
 * "partial document" zoom then pages it forever. It is evidence about how a
 * project CHANGED, almost never about how it WORKS — unless the request asks
 * about the change log itself ("what changed in History.md for 5.0"), in which
 * case it is the answer and must stay reachable.
 *
 * Pure string logic over workspace-relative paths: no fs, no workspace, no
 * session. `canonicalDecision.ts` (fs-free by construction) and the answer
 * ranker both call it.
 */

/**
 * Basename stems that mark a project's change/release log. Matched as a PREFIX
 * of the basename, case-insensitively, and only when the next character is not
 * a letter — `CHANGELOG`, `Changelog.md`, `HISTORY-2.x.rst`, `NEWS.txt`,
 * `release_notes_v2.md` match; `historyService.ts`, `newsletter.ts` and
 * `changesets.json` do not (a letter after the stem means a different word).
 */
const LOW_VALUE_STEM = "changelog|changes|history|news|releases|release[-_ ]?notes";
const LOW_VALUE_BASENAME_RE = new RegExp(`^(?:${LOW_VALUE_STEM})(?![a-z])`, "i");

/**
 * Source-code extensions. `History.md` is a log, but `history.ts` / `News.java`
 * is a module that implements one: the stem rule applies to documents and data
 * files ("any extension"), never to a language this server parses as code.
 */
const SOURCE_CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "py", "pyi", "go", "rs",
  "java", "kt", "kts", "scala", "groovy", "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "hxx",
  "cs", "fs", "vb", "rb", "php", "swift", "m", "mm", "dart", "lua", "pl", "r", "ex", "exs",
  "erl", "hs", "ml", "clj", "sh", "bash", "zsh", "ps1", "bat", "cmd", "sql", "vue", "svelte",
]);

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function splitPath(path: string): { dirs: string[]; base: string } {
  const segments = normalizePath(path).split("/").filter((segment) => segment !== "");
  const base = segments.pop() ?? "";
  return { dirs: segments, base };
}

function extensionOf(base: string): string {
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/**
 * True for a change/release log by NAME (`CHANGELOG*`, `CHANGES*`,
 * `HISTORY*`/`History*`, `NEWS*`, `RELEASES*`, `RELEASE-NOTES*` /
 * `RELEASE_NOTES*`, any extension but a source-code one) and for anything under
 * a `docs/` or `doc/` directory at any depth.
 */
export function isLowValueDocPath(path: string): boolean {
  if (typeof path !== "string" || path === "") return false;
  const { dirs, base } = splitPath(path);
  if (base === "") return false;
  if (dirs.some((segment) => /^docs?$/i.test(segment))) return true;
  return LOW_VALUE_BASENAME_RE.test(base) && !SOURCE_CODE_EXTENSIONS.has(extensionOf(base));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `needle` occurs in `haystack` as a whole token (no identifier/path/dot character on either side). */
function containsToken(haystack: string, needle: string): boolean {
  if (needle === "") return false;
  return new RegExp(`(?<![a-z0-9_.-])${escapeRegExp(needle)}(?![a-z0-9_-])`, "i").test(haystack);
}

/**
 * Words by which a request asks about documentation itself rather than about
 * code: "the ADR", "the PDF spec", 「コードと文書で食い違いがあるか」 (policyarc
 * T04, semanticSignalRegression.spec.ts — its spec PDFs live under `docs/specs/`).
 */
const DOCUMENT_KIND_EN_RE = /\b(?:docs?|documentation|documents?|specs?|specifications?|adrs?|manuals?|readme|pdfs?)\b/i;
const DOCUMENT_KIND_JA_RE = /文書|ドキュメント|仕様|設計書|資料|マニュアル|説明書|PDF/iu;

/**
 * Does `query` NAME this document? True when the query contains the
 * workspace-relative path, or the basename (extension included — "History.md"
 * is how a person names the file), or, for a change/release log, the stem as a
 * word ("what changed in the changelog for 5.0"), or, for a `docs/` page that is
 * not such a log, a word that asks about documentation by kind
 * (`DOCUMENT_KIND_*`). Deliberately generous: a false "yes" restores the
 * pre-existing behaviour for that one document, a false "no" would withhold a
 * document the person asked for.
 */
export function queryNamesDocPath(query: string | undefined, path: string): boolean {
  if (typeof query !== "string" || query === "" || typeof path !== "string" || path === "") return false;
  const haystack = query.replace(/\\/g, "/");
  const normalized = normalizePath(path);
  const { dirs, base } = splitPath(normalized);
  if (base === "") return false;
  if (containsToken(haystack, normalized) || containsToken(haystack, base)) return true;
  const stem = LOW_VALUE_BASENAME_RE.exec(base)?.[0];
  if (stem === undefined || SOURCE_CODE_EXTENSIONS.has(extensionOf(base))) {
    return dirs.some((segment) => /^docs?$/i.test(segment))
      && (DOCUMENT_KIND_EN_RE.test(haystack) || DOCUMENT_KIND_JA_RE.test(haystack));
  }
  const words = stem.toLowerCase().replace(/[-_ ]/g, "[-_ ]?");
  return new RegExp(`(?<![a-z0-9_])${words}(?![a-z0-9_])`, "i").test(haystack);
}
