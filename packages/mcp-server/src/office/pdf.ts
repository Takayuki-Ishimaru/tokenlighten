// PDF extractor — unpdf wrapper for @tokenlighten/mcp-server.
//
// Library choice: unpdf (MIT). It bundles a serverless-friendly build of
// Mozilla's pdf.js (Apache-2.0) with ZERO required runtime dependencies —
// its only dependency, @napi-rs/canvas, is an OPTIONAL peer
// (peerDependenciesMeta: {"@napi-rs/canvas":{"optional":true}}) used solely
// for rendering pages to images/canvas. It is NOT installed in this repo and
// is never imported by the text-extraction path below, so no native binary
// enters the dependency graph (repo convention: no native binaries — see
// AGENTS.md "Conventions"). unpdf ships as pure ESM ("type":"module",
// `.mjs`/`.d.mts` build) and works directly under Node with no worker/canvas
// setup required for text extraction. Rejected alternative: pdfjs-dist
// directly (also Apache-2.0, license-wise fine) — unpdf is a thin wrapper
// around exactly that legacy/node build, pre-configured for serverless/CLI
// use (disableFontFace, standardFontDataUrl resolution, isEvalSupported:
// false, etc. — see unpdf's getDocumentProxy doc comment), so pdfjs-dist
// directly would only add setup code unpdf already does.
//
// NOTE: unpdf's shipped .d.mts unconditionally type-imports '@napi-rs/canvas'
// (used only by unrelated image-rendering exports we don't call). That
// package is intentionally not installed, so a *type-checked* static import
// of "unpdf" would fail module resolution. Verified empirically that this
// repo's tsconfig (skipLibCheck:true, inherited from tsconfig.base.json)
// tolerates it either way; we still lazy dynamic-import + hand-roll a
// minimal duck-typed surface below (getUnpdf/UnpdfModule), matching the
// getMammoth/getPptx2Json/getExcelJs convention in the sibling office/*.ts
// files, so this module never depends on unpdf's real (canvas-referencing)
// declaration files at all.
//
// Extraction is TEXT-LAYER ONLY — this is a searchable-PDF text extractor,
// not an OCR engine (see proto/docs/OFFICE_PDF_READONLY.md: "OCR は MVP
// 対象外"). A PDF with no embedded text layer (scanned/image-only) fails
// honestly with code "pdf-no-text-layer" instead of silently returning empty
// pages. Encrypted/password-protected PDFs fail honestly with
// "pdf-encrypted". Corrupt/unparseable input fails with "pdf-parse-failed".
// Never throws — every path above returns a structured {ok:false,...}.
//
// Output shape mirrors office/docx.ts's docxSections / office/pptx.ts's
// pptxSlides: {ok:true, pages:[{page,text}], truncated, warnings}, built
// with the SAME bake-into-cap maxChars accumulation those use (accumulate
// page text against the budget, cut with "..." on the page that overflows —
// never truncate the already-serialized JSON after the fact).

export interface PdfPage {
  page: number;
  text: string;
}

export type PdfFailureCode =
  | "pdf-encrypted"
  | "pdf-password-invalid"
  | "pdf-no-text-layer"
  | "pdf-parse-failed";

export interface PdfPagesFailure {
  ok: false;
  error: string;
  code: PdfFailureCode;
  /** Native-fallback guidance — set for pdf-encrypted/pdf-no-text-layer, omitted for pdf-parse-failed. */
  hint?: string;
  warnings: string[];
}

export interface PdfPagesSuccess {
  ok: true;
  pages: PdfPage[];
  truncated: boolean;
  warnings: string[];
}

export type PdfPagesResult = PdfPagesSuccess | PdfPagesFailure;

/** Safety net against pathological page counts (mirrors xlsx.ts's MAX_ROWS/MAX_PREVIEW_CELLS guards). */
const MAX_PAGES = 500;

// SECURITY (TL-SECURITY-REVIEW-2026-08-15 finding 2, CWE-400): extraction-time
// quotas enforced INSIDE the page loop in readPages, below — MAX_PAGES alone
// only bounds page COUNT; a single pathological page (millions of tiny
// TextItems) or many merely-large pages could still force full decode+
// normalize of everything before the (existing, post-loop) maxChars cap
// ever got a say. Sized as generous safety nets, not tight per-request
// budgets: a real page rarely exceeds a few thousand TextItems, and 500
// real pages rarely exceed a few million characters combined, so ordinary
// documents — including large, legitimate ones — never come close to
// tripping these; they exist to bound the WORST case.
const MAX_TEXT_ITEMS_PER_PAGE = 50_000;
const EXTRACTION_CHAR_BUDGET = 4_000_000; // ~4 MB of decoded text, cumulative across pages
const EXTRACTION_ITEM_BUDGET = 2_000_000; // cumulative TextItems across pages

/**
 * TEST-ONLY seam (mirrors this codebase's established `{ maxBytes }`-style
 * per-call cap override convention — see util/safePath.ts's checkReadTarget,
 * exercised in __tests__/readPathResourceCaps.spec.ts):
 * lets a regression test shrink the extraction-time safety quotas above
 * without constructing megabytes of real PDF content. Never set by
 * production callers — `pdfPages`' public opts type below flags the field
 * accordingly.
 */
export interface PdfExtractionQuotaOverrides {
  maxTextItemsPerPage?: number;
  extractionCharBudget?: number;
  extractionItemBudget?: number;
}

// ---------------------------------------------------------------------------
// Lazy-loaded unpdf — keep cold-start fast when pdf reads are unused (same
// convention as office/xlsx.ts's getExcelJs / office/pptx.ts's getPptx2Json).
// ---------------------------------------------------------------------------

interface UnpdfTextItem {
  str?: string;
  hasEOL?: boolean;
}

interface UnpdfTextContent {
  items: UnpdfTextItem[];
}

interface UnpdfPageProxy {
  getTextContent(): Promise<UnpdfTextContent>;
}

interface UnpdfDocumentProxy {
  numPages: number;
  getPage(pageNumber: number): Promise<UnpdfPageProxy>;
  destroy(): Promise<void>;
}

type UnpdfModule = {
  getDocumentProxy: (
    data: Uint8Array,
    options?: { password?: string; verbosity?: number },
  ) => Promise<UnpdfDocumentProxy>;
};

let unpdfCache: UnpdfModule | undefined;

async function getUnpdf(): Promise<UnpdfModule> {
  if (unpdfCache) return unpdfCache;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  unpdfCache = (await import("unpdf")) as unknown as UnpdfModule;
  return unpdfCache;
}

// ---------------------------------------------------------------------------
// Whitespace normalization
// ---------------------------------------------------------------------------

function normalizeWhitespace(text: string): string {
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Page selector — 1-based page numbers or "N-M" ranges, e.g. ["1","3-5"].
// Mirrors pptxSlides' string-array selector convention (office/pptx.ts,
// `slides?: string[]` matched positionally), extended with range syntax
// since PDF page selection is commonly range-shaped ("pages 2 through 5")
// rather than one-off like slide picks.
// ---------------------------------------------------------------------------

function parsePageSelector(items: string[]): Set<number> | undefined {
  const wanted = new Set<number>();
  for (const raw of items) {
    const trimmed = raw.trim();
    const rangeM = /^(\d+)\s*-\s*(\d+)$/.exec(trimmed);
    if (rangeM) {
      const a = parseInt(rangeM[1]!, 10);
      const b = parseInt(rangeM[2]!, 10);
      const [start, end] = a <= b ? [a, b] : [b, a];
      if (
        start < 1
        || !Number.isSafeInteger(start)
        || !Number.isSafeInteger(end)
        || end - start + 1 > MAX_PAGES
        || wanted.size + (end - start + 1) > MAX_PAGES
      ) {
        return new Set();
      }
      for (let n = start; n <= end; n++) wanted.add(n);
      continue;
    }
    const n = parseInt(trimmed, 10);
    if (Number.isSafeInteger(n) && n > 0) {
      if (wanted.size >= MAX_PAGES) return new Set();
      wanted.add(n);
    }
  }
  return wanted.size > 0 ? wanted : undefined;
}

// ---------------------------------------------------------------------------
// Open-failure classification
// ---------------------------------------------------------------------------

function openFailure(err: unknown, passwordSupplied: boolean): PdfPagesFailure {
  const name =
    err && typeof err === "object" && "name" in err ? String((err as { name: unknown }).name) : undefined;
  if (name === "PasswordException") {
    const code =
      err && typeof err === "object" && "code" in err
        ? Number((err as { code: unknown }).code)
        : undefined;
    const incorrect = passwordSupplied || code === 2;
    if (incorrect) {
      return {
        ok: false,
        error: "The resolved credential did not unlock the PDF.",
        code: "pdf-password-invalid",
        hint: "Check the credentialRef mapping and restart the MCP server after changing its environment.",
        warnings: [],
      };
    }
    return {
      ok: false,
      error: "PDF is password-protected; cannot extract without a password.",
      code: "pdf-encrypted",
      hint:
        "configure a TOKENLIGHTEN_PASSWORD_* environment variable and pass its opaque credentialRef",
      warnings: [],
    };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return { ok: false, error: msg.slice(0, 200), code: "pdf-parse-failed", warnings: [] };
}

// ---------------------------------------------------------------------------
// Page reading + selection + bake-into-cap truncation
// ---------------------------------------------------------------------------

async function readPages(
  doc: UnpdfDocumentProxy,
  opts: { pages?: string[]; query?: string; __quotaOverridesForTest?: PdfExtractionQuotaOverrides },
  maxChars: number,
): Promise<PdfPagesResult> {
  const warnings: string[] = [];
  const totalPages = doc.numPages;
  const pageCap = Math.min(totalPages, MAX_PAGES);
  if (totalPages > MAX_PAGES) {
    warnings.push(`PDF has ${totalPages} pages; only the first ${MAX_PAGES} are considered.`);
  }

  const quotaOverrides = opts.__quotaOverridesForTest;
  const maxItemsPerPage = quotaOverrides?.maxTextItemsPerPage ?? MAX_TEXT_ITEMS_PER_PAGE;
  const charBudget = quotaOverrides?.extractionCharBudget ?? EXTRACTION_CHAR_BUDGET;
  const itemBudget = quotaOverrides?.extractionItemBudget ?? EXTRACTION_ITEM_BUDGET;

  // SECURITY (finding 2): resolve the page selector BEFORE decoding so an
  // explicit pages= request never pays for getTextContent() on a page it
  // could not possibly serve — the loop below `continue`s past anything
  // not in `wanted` instead of decoding every page up to pageCap first and
  // filtering afterward (the old, always-decode-everything order).
  const wanted = opts.pages && opts.pages.length > 0 ? parsePageSelector(opts.pages) : undefined;

  // Per-page text via pdf.js's own text-content API (TextItem[].str, joined
  // on hasEOL) — the same primitive unpdf's own extractText() convenience
  // helper is built on, called directly here (rather than through that
  // helper) so page reads stay bounded by pageCap instead of unconditionally
  // walking every page of a pathologically large document.
  const allPages: PdfPage[] = [];
  let budgetChars = 0;
  let budgetItems = 0;
  for (let n = 1; n <= pageCap; n++) {
    if (wanted && !wanted.has(n)) continue;
    const page = await doc.getPage(n);
    const content = await page.getTextContent();

    // Per-page item quota: a single pathological page's TextItem[] can be
    // vastly larger than any real page's — slice BEFORE map/join/
    // normalizeWhitespace so a bomb page cannot amplify into several
    // full-length intermediate strings on top of whatever pdf.js itself
    // already allocated decoding it.
    let items = content.items;
    if (items.length > maxItemsPerPage) {
      warnings.push(`Page ${n} has ${items.length} text items; only the first ${maxItemsPerPage} are considered.`);
      items = items.slice(0, maxItemsPerPage);
    }
    budgetItems += items.length;

    const raw = items.map((it) => (it.str ?? "") + (it.hasEOL ? "\n" : "")).join("");
    const text = normalizeWhitespace(raw);
    allPages.push({ page: n, text });
    budgetChars += text.length;

    // Cumulative quota: abort decoding further pages once the running
    // total already vastly exceeds anything the (later) maxChars cap could
    // ever serve — stops a pathological multi-hundred-page document from
    // being fully decoded before that cap gets a say. A multi-page pages=
    // selector that hits this mid-selection loses its later members too
    // (same "cap + honest warning" tradeoff MAX_PAGES above already makes).
    if (budgetChars > charBudget || budgetItems > itemBudget) {
      warnings.push(`Extraction budget exceeded after page ${n}; remaining pages were not scanned.`);
      break;
    }
  }

  // A page selector that matched nothing in [1,pageCap] — out of range, or
  // rejected by parsePageSelector for exceeding MAX_PAGES pre-expansion —
  // never decoded a single page. Report an honest empty result rather than
  // falling into the whole-document no-text-layer classification below,
  // which must never be triggered by a selector simply missing.
  if (wanted && allPages.length === 0) {
    return { ok: true, pages: [], truncated: false, warnings };
  }

  // Whole-document no-text-layer classification is intentionally scoped to
  // the pages actually decoded above (== the whole considered document
  // when no selector is given, matching pre-existing behavior; == just the
  // requested subset when narrowed by pages=, so a blank REQUESTED page
  // never shadows real text living elsewhere in the document — that text
  // was never decoded in this call and this call cannot make claims about
  // it either way).
  const hasAnyText = allPages.some((p) => p.text.length > 0);
  if (!hasAnyText) {
    return {
      ok: false,
      error: "PDF has no extractable text layer (likely scanned/image-only).",
      code: "pdf-no-text-layer",
      hint: "OCR is out of scope for TL's pdf extraction; run an external OCR tool and read its output instead",
      warnings,
    };
  }

  // Filter by page selector (a no-op today — the loop above already only
  // ever decoded `wanted` pages when a selector was given — kept as an
  // explicit, cheap invariant rather than relying on the loop alone).
  let filtered = allPages;
  if (wanted) {
    filtered = allPages.filter((p) => wanted.has(p.page));
  }

  // Filter by query — same lexical-overlap convention as docxSections/pptxSlides.
  if (opts.query) {
    const queryLower = opts.query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter((t) => t.length > 2);
    filtered = filtered.filter((p) => {
      const combined = p.text.toLowerCase();
      return queryTerms.some((term) => combined.includes(term));
    });
  }

  // Bake-into-cap maxChars truncation — SAME accumulate-then-cut pattern as
  // docxSections/pptxSlides: the returned JSON is built to fit inside the
  // budget from the start, never sliced after the fact.
  let totalChars = 0;
  let truncated = false;
  const result: PdfPage[] = [];
  for (const p of filtered) {
    if (totalChars + p.text.length > maxChars) {
      const remaining = maxChars - totalChars;
      if (remaining > 100) {
        result.push({ page: p.page, text: p.text.slice(0, remaining) + "..." });
      }
      truncated = true;
      break;
    }
    result.push(p);
    totalChars += p.text.length;
  }

  return { ok: true, pages: result, truncated, warnings };
}

// ---------------------------------------------------------------------------
// Public extractor
// ---------------------------------------------------------------------------

export async function pdfPages(
  bytes: Uint8Array,
  opts: {
    /** 1-based page numbers and/or "N-M" ranges, e.g. ["1","3-5"]. */
    pages?: string[];
    query?: string;
    maxChars?: number;
    /** Resolved in-process password. Callers must never source this from a raw MCP argument. */
    password?: string;
    /** TEST-ONLY — see PdfExtractionQuotaOverrides. Never set by production callers. */
    __quotaOverridesForTest?: PdfExtractionQuotaOverrides;
  } = {},
): Promise<PdfPagesResult> {
  const maxChars = opts.maxChars ?? 16_000;

  let unpdf: UnpdfModule;
  try {
    unpdf = await getUnpdf();
  } catch {
    return {
      ok: false,
      error: "unpdf package not available for PDF extraction.",
      code: "pdf-parse-failed",
      warnings: [],
    };
  }

  let doc: UnpdfDocumentProxy;
  try {
    // Defensive copy: verified empirically that unpdf/pdf.js's Node "fake
    // worker" path TRANSFERS (detaches) the input's underlying ArrayBuffer —
    // passing the caller's own `bytes` reference to a SECOND pdfPages() call
    // (e.g. a handle re-read, or a test fixture reused across `it()` blocks)
    // would fail with "Cannot transfer object of unsupported type." on the
    // second call. `new Uint8Array(bytes)` copies into a fresh ArrayBuffer,
    // so the caller's buffer is never mutated/detached by this function.
    // verbosity:0 keeps pdf.js's internal diagnostics (which already go to
    // stderr via console.warn, never stdout — verified not to collide with
    // this server's stdio JSON-RPC framing) quiet at the default level.
    doc = await unpdf.getDocumentProxy(new Uint8Array(bytes), {
      verbosity: 0,
      ...(opts.password !== undefined ? { password: opts.password } : {}),
    });
  } catch (err: unknown) {
    return openFailure(err, opts.password !== undefined);
  }

  try {
    return await readPages(doc, opts, maxChars);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg.slice(0, 200), code: "pdf-parse-failed", warnings: [] };
  } finally {
    try {
      await doc.destroy();
    } catch {
      // Best-effort cleanup only — the extraction result above already
      // computed and is unaffected by a destroy() failure.
    }
  }
}
