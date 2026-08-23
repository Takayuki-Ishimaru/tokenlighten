// extract_office_text tool implementation for @tokenlighten/mcp-server.
//
// Adapts docx (mammoth), xlsx (exceljs), pptx (pptx2json), pdf (unpdf —
// text-layer only, see office/pdf.ts's header for the library choice and
// office/pdf.ts's pdfPages() for the structured artifact-mode extractor this
// wraps).
// Applies zip-bomb preflight before unzip — docx/xlsx/pptx only; pdf is not
// a zip container, so it skips straight to its own extractor (which applies
// its own page-count safety cap instead — see office/pdf.ts's MAX_PAGES).
// Output is PLAIN markdown text: no meta envelope, no 'tokenlighten:meta' wrappers.
// Reason: docs/00-postmortem.md §2.2 — meta envelope dominated cache_write cost.
//
// Full spec: docs/components/02-mcp-server.md §2.5, §6.

import type { McpToolResult } from "@tokenlighten/types";
import { preflightZip } from "../office/zipPreflight.js";
import { extractDocx } from "../office/docx.js";
import { extractXlsx } from "../office/xlsx.js";
import { extractPptx } from "../office/pptx.js";
import { pdfPages } from "../office/pdf.js";
import { prepareOfficeDocument } from "../office/decrypt.js";
import {
  extractOoxmlVisualInventory,
  renderOoxmlVisualInventory,
} from "../office/ooxmlVisuals.js";

// ---------------------------------------------------------------------------
// D8: `ExtractOfficeTextInput` / `ExtractOfficeTextOutput` used to live in
// `@tokenlighten/types`' `mcp/legacy-read.ts`, which is DELETED. This module
// serves the ADVERTISED office paths of `read_file`, so the request shape moves
// here next to its one emitter and the output shape is renamed to what it
// actually is: the payload the funnel projects onto the v1 `read.artifact`
// family (types `mcp/read-result.ts`).
// ---------------------------------------------------------------------------

/** Request shape of `read_file`'s office-extraction paths. */
export interface ExtractOfficeTextInput {
  /** Workspace-relative path to a .docx, .xlsx, or .pptx file. */
  path: string;
  /** Opaque password reference resolved by the MCP server; never the password itself. */
  credentialRef?: string;
  /** Maximum raw file size to read in bytes. Default: 1 MiB. */
  maxBytes?: number;
  /**
   * Hard byte cap on the rendered text field. Default: 12288
   * (MAX_RESPONSE_BYTES). Internal callers that slice/continue the text
   * themselves (core2 office view) may raise it.
   */
  maxResponseBytes?: number;
  /**
   * Cap on extracted text in tokens (word-count estimate). Default: 4000.
   * When exceeded the text is truncated from the end.
   */
  maxTokens?: number;
}

/** The office-extraction payload — projection source for v1 `read.artifact`. */
export interface OfficeTextPayload {
  /** Extracted markdown text (may be truncated; see `truncated`). */
  text: string;
  /** Office document kind that was processed. */
  kind: "docx" | "xlsx" | "pptx" | "pdf";
  /** True when `text` was cut short by `maxTokens`. */
  truncated: boolean;
  /** Non-fatal warnings encountered during extraction (e.g. unsupported features). */
  warnings: string[];
}

const DEFAULT_MAX_BYTES = 1 * 1024 * 1024; // 1 MiB per docs/components/02-mcp-server.md §8
const DEFAULT_MAX_TOKENS = 4000;

// ---------------------------------------------------------------------------
// P1.2: Hard byte cap — exported so budget tests (P3.3) can import them.
// ---------------------------------------------------------------------------

/** Hard byte cap for the rendered text field in office extraction responses. */
export const MAX_RESPONSE_BYTES = 12288;

// ---------------------------------------------------------------------------
// CWE-400/409 caller-value hard clamp (TL-V0.9-RELEASE-STRATEGY-2026-08-12.md
// §6.6-2 item 3, shipped 2026-08-13): maxBytes/maxTokens used to pass
// straight through from the caller (`input.maxBytes ?? DEFAULT_MAX_BYTES`)
// with NO ceiling — every external server.ts dispatch site (extract_office_text,
// read_file mode=full/mode=auto, search_files action=office) forwards
// `args["maxBytes"]`/`args["maxTokens"]` verbatim (some via `Number(...)`
// coercion of arbitrary caller JSON, so a non-numeric string becomes NaN, and
// a JSON literal like 1e999 parses to Infinity), and there is no schema layer
// rejecting undeclared/out-of-range args before they reach this function.
//
// MAX_BYTES_CEILING is 10x DEFAULT_MAX_BYTES. Chosen relative to the OTHER
// fixed safety nets downstream: office/zipPreflight.ts's ZIP_LIMITS cap the
// real decompression work at 25 MiB compressed / 100 MiB uncompressed / 16
// MiB per-part regardless of maxBytes, so raising this gate to 10 MiB never
// lets a caller bypass that backstop — it just avoids buffering something
// needlessly large before we even get there, while comfortably covering
// real-world docx/xlsx/pptx/pdf sizes.
const MAX_BYTES_CEILING = 10 * 1024 * 1024; // 10 MiB

// MAX_TOKENS_CEILING must clear core2/read.ts's serveOffice — a legitimate
// INTERNAL (trusted) caller that requests maxTokens:OFFICE_EXTRACT_TOKENS
// (4,000,000) so its own maxResponseBytes-bounded slicing sees the full
// extracted text before it re-slices. Keep headroom above that known value so
// this clamp never clips a real internal request. External callers are
// separately bounded regardless of maxTokens by the fixed MAX_RESPONSE_BYTES
// byte cap below (maxResponseBytes itself is never forwarded by any external
// dispatch site — only core2/read.ts sets it — so it is out of scope here).
const MAX_TOKENS_CEILING = 5_000_000;

/**
 * Sanitize+clamp a caller-supplied numeric knob: undefined, non-finite
 * (NaN/±Infinity), negative, or zero collapses to `fallback` (identical to
 * omitting the knob); a finite value in (0, ceiling] passes through
 * UNCHANGED; anything larger is pinned to `ceiling`. Keeps default/in-range
 * behavior byte-identical while bounding pathological caller input.
 * Exported (like MAX_RESPONSE_BYTES above) so callerValueClamps.spec.ts can
 * pin the exact ceiling numbers directly — proving the 10 MiB/5M ceilings
 * through extractOfficeText's real fileBytes/text path would need an
 * implausibly large in-memory fixture.
 */
export function clampCallerNumber(value: number | undefined, fallback: number, ceiling: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return value > ceiling ? ceiling : value;
}

/** Simple word-count based token estimate (v0.1 heuristic, no tiktoken). */
function estimateTokens(text: string): number {
  // ~1.33 tokens per word on average for prose (conservative).
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * 1.33);
}

/**
 * Truncate text to at most `maxBytes` UTF-8 bytes. Attempts to cut at a
 * section boundary (blank line) if one exists in the last 20% of the budget.
 * Appends a truncation notice with bytes elided.
 */
function truncateToBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= maxBytes) return { text, truncated: false };

  // Reserve space for the truncation notice.
  const notice = `\n…[truncated: X bytes elided]`;
  const noticeBytes = Buffer.byteLength(notice, "utf8") + 20; // +20 for actual number
  const budget = maxBytes - noticeBytes;

  // Find the cut point at a section boundary if possible.
  // Walk backwards from budget looking for a blank line within 20% of budget.
  // Convert budget bytes to a character index (approximate — multi-byte chars).
  // We'll slice to a char count, then check actual bytes.
  let charIdx = Math.floor(budget / 1.1); // rough upper bound
  while (charIdx > 0 && Buffer.byteLength(text.slice(0, charIdx), "utf8") < budget) {
    charIdx++;
  }
  while (charIdx > 0 && Buffer.byteLength(text.slice(0, charIdx), "utf8") > budget) {
    charIdx--;
  }

  // Look for a blank line near the cut.
  const lastBlank = text.lastIndexOf("\n\n", charIdx);
  const lowerBound = Math.floor(charIdx * 0.8);
  const cutCharIdx = lastBlank >= lowerBound ? lastBlank : charIdx;

  const truncatedText = text.slice(0, cutCharIdx);
  const elided = totalBytes - Buffer.byteLength(truncatedText, "utf8");
  return {
    text: truncatedText + `\n…[truncated: ${elided} bytes elided]`,
    truncated: true,
  };
}

/**
 * Truncate text to approximately `maxTokens` tokens by truncating at the
 * last word boundary before the limit. Appends a truncation notice.
 */
function truncateToTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
  const totalTokens = estimateTokens(text);
  if (totalTokens <= maxTokens) return { text, truncated: false };

  // Binary-search for the character position where we hit the token budget.
  // Simple approximation: tokens ≈ chars / 4.
  const targetChars = maxTokens * 4;
  if (text.length <= targetChars) return { text, truncated: false };

  const truncated = text.slice(0, targetChars);
  // Cut at last newline for cleaner output.
  const lastNewline = truncated.lastIndexOf("\n");
  const cutAt = lastNewline > targetChars * 0.5 ? lastNewline : targetChars;
  const result =
    truncated.slice(0, cutAt) +
    `\n[truncated at ${maxTokens} tokens]`;

  return { text: result, truncated: true };
}

/** Detect document kind from file extension. */
function detectKind(path: string): "docx" | "xlsx" | "pptx" | "pdf" | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".xlsx")) return "xlsx";
  if (lower.endsWith(".pptx")) return "pptx";
  if (lower.endsWith(".pdf")) return "pdf";
  return null;
}

/**
 * Extract text from a .docx / .xlsx / .pptx / .pdf file.
 * Applies zip-bomb preflight before extraction (docx/xlsx/pptx only — pdf is
 * not a zip container; office/pdf.ts applies its own MAX_PAGES safety cap).
 * Returns plain markdown text, truncated to maxTokens.
 */
export async function extractOfficeText(
  fileBytes: Uint8Array,
  input: ExtractOfficeTextInput,
  password?: string,
): Promise<McpToolResult<OfficeTextPayload>> {
  const { path } = input;
  const maxBytes = clampCallerNumber(input.maxBytes, DEFAULT_MAX_BYTES, MAX_BYTES_CEILING);
  const maxTokens = clampCallerNumber(input.maxTokens, DEFAULT_MAX_TOKENS, MAX_TOKENS_CEILING);
  // Response-cap override for INTERNAL callers that do their own bounded
  // slicing/continuation (core2 office view — remediation R2 Blocker 3).
  // External/tool callers keep the 12KB default.
  const maxResponseBytes = input.maxResponseBytes ?? MAX_RESPONSE_BYTES;

  // Detect document kind from path.
  const kind = detectKind(path);

  if (!kind) {
    return {
      ok: false,
      error: `Unsupported file type: ${path}. Only .docx, .xlsx, .pptx, .pdf are supported.`,
      code: "not-a-document",
    };
  }

  // Size guard.
  if (fileBytes.length > maxBytes) {
    return {
      ok: false,
      error: `File size ${fileBytes.length} bytes exceeds maxBytes (${maxBytes}).`,
      code: "too-large",
    };
  }

  let documentBytes = fileBytes;
  if (kind !== "pdf") {
    const prepared = await prepareOfficeDocument(fileBytes, password);
    if (!prepared.ok) {
      return {
        ok: false,
        error: prepared.error,
        code: prepared.code,
      };
    }
    documentBytes = prepared.bytes;
  }

  // Zip-bomb preflight — docx/xlsx/pptx are ZIP-based OOXML; pdf is not a
  // zip container (JSZip.loadAsync would reject a valid pdf as "not-a-zip"),
  // so pdf skips this and goes straight to pdfPages below.
  if (kind !== "pdf") {
    const preflight = await preflightZip(documentBytes);
    if (!preflight.ok) {
      return {
        ok: false,
        error: `Zip preflight failed: ${preflight.detail}`,
        code: preflight.code,
      };
    }
  }

  // Dispatch to the appropriate extractor.
  let rawText: string;
  let warnings: string[];

  if (kind === "docx") {
    const result = await extractDocx(documentBytes);
    if (!result.ok) {
      return {
        ok: false,
        error: result.error,
        code: "corrupt",
      };
    }
    rawText = result.text;
    warnings = result.warnings;
  } else if (kind === "xlsx") {
    const result = await extractXlsx(documentBytes);
    if (!result.ok) {
      return {
        ok: false,
        error: result.error,
        code: "corrupt",
      };
    }
    rawText = result.text;
    warnings = result.warnings;
  } else if (kind === "pptx") {
    const result = await extractPptx(documentBytes);
    if (!result.ok) {
      return {
        ok: false,
        error: result.error,
        code: "corrupt",
      };
    }
    rawText = result.text;
    warnings = result.warnings;
  } else {
    // pdf — reuses pdfPages (office/pdf.ts) rather than a separate flat
    // extractor, so there is exactly one PDF-parsing code path; flattened
    // here into the SAME "## <label>" per-unit markdown convention
    // extractPptx uses for slides ("## Slide N: Title").
    const result = await pdfPages(fileBytes, {
      ...(password !== undefined ? { password } : {}),
    });
    if (!result.ok) {
      // Preserve pdf.ts's specific failure code (pdf-encrypted /
      // pdf-no-text-layer / pdf-parse-failed) instead of collapsing to the
      // generic "corrupt" the docx/xlsx/pptx branches above use — the
      // caller's next step differs materially by code (supply a password
      // out-of-band vs. this file has no text layer at all vs. genuinely
      // malformed input).
      return {
        ok: false,
        error: result.hint ? `${result.error} (${result.hint})` : result.error,
        code: result.code,
      };
    }
    rawText = result.pages.map((p) => `## Page ${p.page}\n\n${p.text}`).join("\n\n");
    warnings = result.warnings;
  }

  if (kind !== "pdf") {
    const visuals = await extractOoxmlVisualInventory(documentBytes, kind, { preflighted: true });
    const visualText = renderOoxmlVisualInventory(visuals);
    if (visualText) rawText = `${rawText}\n\n${visualText}`;
    if (kind === "pptx" && visuals.charts.length > 0) {
      warnings = warnings.filter((warning) => !warning.startsWith("chart content not extracted"));
    }
    warnings.push(...visuals.warnings);
  }

  // Token-limit pass first (existing behavior).
  const tokenResult = truncateToTokens(rawText, maxTokens);

  // Byte-cap pass: hard cap on the text field (overridable, see above).
  const byteResult = truncateToBytes(tokenResult.text, maxResponseBytes);

  const text = byteResult.text;
  const truncated = tokenResult.truncated || byteResult.truncated;

  return {
    ok: true,
    data: {
      text,
      kind,
      truncated,
      warnings,
    },
  };
}
