// Zip-bomb preflight for Office document extraction.
//
// Ported from proto/src/document/zipPreflight.ts — VSCode imports stripped.
// Output is PLAIN data: no meta envelope, no 'tokenlighten:meta' wrappers.
// Reason: docs/00-postmortem.md §2.2 — meta envelope dominated cache_write cost.
//
// Walks the ZIP central directory and checks limits BEFORE passing bytes
// to any extractor. Uses JSZip's loadAsync which reads metadata without
// decompressing payloads.

// Defensive limits for ZIP-based office formats.
export const ZIP_LIMITS = {
  maxCompressedBytes: 25 * 1024 * 1024,    // 25 MB
  maxUncompressedBytes: 100 * 1024 * 1024, // 100 MB
  maxEntries: 10_000,
  maxExpansionRatio: 100,
  // Per-part (per-ZIP-entry) uncompressed cap — mirrors tools/archive.ts's
  // ARCHIVE_LIMITS.maxMemberBytes (16 MB) rather than write/artifactEdit.ts's
  // stricter 10 MB MAX_ZIP_MEMBER_BYTES, since a single legitimate OOXML part
  // (e.g. a large embedded xl/media image or worksheet XML) can reasonably
  // approach that neighborhood; a single part above this is treated as a
  // bomb regardless of whether the package-wide totals still pass.
  maxPartUncompressedBytes: 16 * 1024 * 1024, // 16 MB
} as const;

export type PreflightResult =
  | { ok: true }
  | {
      ok: false;
      code: "too-large" | "too-many-entries" | "zip-bomb" | "not-a-zip" | "part-too-large";
      detail: string;
    };

interface JSZipEntry {
  dir: boolean;
  _data?: {
    compressedSize: number;
    uncompressedSize: number;
  };
}

interface JSZipInstance {
  files: Record<string, JSZipEntry>;
}

// ---------------------------------------------------------------------------
// EOCD prescan (CWE-400, TL-SECURITY-REVIEW-2026-08-15 finding 3): a cheap,
// bounded backward scan for the ZIP End-Of-Central-Directory record, run
// BEFORE any full parser (JSZip.loadAsync below; libarchive's Archive.open
// in tools/archive.ts, which calls this same helper for the zip format) is
// invoked. It reads only the last <=64KB+22 bytes of the buffer plus a
// handful of integer fields out of the EOCD record itself — no
// central-directory walk, no per-entry allocation — so it stays cheap even
// against a pathological entry count that would otherwise make the real
// parser allocate one JS object per entry before anything downstream got a
// chance to say no.
//
// Deliberately conservative: anything this scan cannot confidently classify
// (no locatable EOCD signature, an ambiguous comment-length match) is
// treated as "proceed to the real parser" so a legitimate edge-case zip is
// never wrongly rejected by this fast path — it exists purely to
// short-circuit the OBVIOUS over-limit case cheaply, not to replace the
// real (authoritative) post-parse checks below, which still run unchanged.
// ZIP64 is the one exception: it only appears above 65,535 entries or a
// 4GB+ central directory, both already far beyond every ceiling this
// server enforces post-parse, so a ZIP64 signal is treated as a confident
// "over limit" rather than "ambiguous, defer".
const EOCD_SIGNATURE = 0x06054b50; // "PK\x05\x06" little-endian
const EOCD_SIZE = 22; // fixed portion of the record, excludes the comment
const EOCD_MAX_COMMENT_BYTES = 65535; // comment length field is a u16

export function eocdEntryCountPrescan(
  bytes: Uint8Array,
  maxEntries: number,
): { ok: true } | { ok: false; detail: string } {
  if (bytes.length < EOCD_SIZE) return { ok: true }; // too small to be a real zip — let the real parser classify it
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const scanFloor = Math.max(0, bytes.length - EOCD_SIZE - EOCD_MAX_COMMENT_BYTES);
  for (let offset = bytes.length - EOCD_SIZE; offset >= scanFloor; offset--) {
    if (view.getUint32(offset, true) !== EOCD_SIGNATURE) continue;
    const commentLen = view.getUint16(offset + 20, true);
    // A genuine EOCD's declared comment always reaches exactly EOF; a
    // signature-shaped byte sequence found elsewhere (e.g. inside
    // compressed data) essentially never also satisfies this.
    if (offset + EOCD_SIZE + commentLen !== bytes.length) continue;
    const entryCount = view.getUint16(offset + 10, true);
    const cdSize = view.getUint32(offset + 12, true);
    const cdOffset = view.getUint32(offset + 16, true);
    const zip64 = entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff;
    if (zip64) {
      return {
        ok: false,
        detail: "ZIP64 central directory (entry count/size beyond this server's ceilings)",
      };
    }
    if (entryCount > maxEntries) {
      return {
        ok: false,
        detail: `central directory declares ${entryCount} entries, exceeds limit ${maxEntries}`,
      };
    }
    return { ok: true };
  }
  return { ok: true }; // no EOCD located in the scan window — defer to the real parser
}

/**
 * Walk the ZIP central directory to detect bombs before extraction.
 * Reads NO decompressed payloads — sizes come from metadata only.
 */
export async function preflightZip(bytes: Uint8Array): Promise<PreflightResult> {
  const prescan = eocdEntryCountPrescan(bytes, ZIP_LIMITS.maxEntries);
  if (!prescan.ok) {
    return { ok: false, code: "too-many-entries", detail: prescan.detail };
  }
  let JSZip: { loadAsync(data: Uint8Array): Promise<JSZipInstance> };
  try {
    // Lazy import — keep cold-start fast when extract_office_text is unused.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    JSZip = (await import("jszip")).default as unknown as typeof JSZip;
  } catch {
    return { ok: false, code: "not-a-zip", detail: "jszip not available" };
  }

  let zip: JSZipInstance;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (err) {
    return {
      ok: false,
      code: "not-a-zip",
      detail: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    };
  }

  let compressedBytes = 0;
  let uncompressedBytes = 0;
  let entries = 0;

  for (const [entryName, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    entries++;
    const data = entry._data;
    if (data) {
      if (data.uncompressedSize > ZIP_LIMITS.maxPartUncompressedBytes) {
        return {
          ok: false,
          code: "part-too-large",
          detail: `part "${entryName}" uncompressed size ${data.uncompressedSize} exceeds per-part limit ${ZIP_LIMITS.maxPartUncompressedBytes}`,
        };
      }
      compressedBytes += data.compressedSize;
      uncompressedBytes += data.uncompressedSize;
    }

    // Early abort after each entry.
    const check = checkCounters(compressedBytes, uncompressedBytes, entries);
    if (!check.ok) return check;
  }

  return checkCounters(compressedBytes, uncompressedBytes, entries);
}

function checkCounters(
  compressedBytes: number,
  uncompressedBytes: number,
  entries: number,
): PreflightResult {
  if (compressedBytes > ZIP_LIMITS.maxCompressedBytes) {
    return {
      ok: false,
      code: "too-large",
      detail: `compressedBytes ${compressedBytes} exceeds limit ${ZIP_LIMITS.maxCompressedBytes}`,
    };
  }
  if (uncompressedBytes > ZIP_LIMITS.maxUncompressedBytes) {
    return {
      ok: false,
      code: "too-large",
      detail: `uncompressedBytes ${uncompressedBytes} exceeds limit ${ZIP_LIMITS.maxUncompressedBytes}`,
    };
  }
  if (entries > ZIP_LIMITS.maxEntries) {
    return {
      ok: false,
      code: "too-many-entries",
      detail: `entries ${entries} exceeds limit ${ZIP_LIMITS.maxEntries}`,
    };
  }
  if (compressedBytes > 0 && uncompressedBytes / compressedBytes > ZIP_LIMITS.maxExpansionRatio) {
    return {
      ok: false,
      code: "zip-bomb",
      detail: `expansion ratio ${(uncompressedBytes / compressedBytes).toFixed(1)} exceeds limit ${ZIP_LIMITS.maxExpansionRatio}`,
    };
  }
  return { ok: true };
}
