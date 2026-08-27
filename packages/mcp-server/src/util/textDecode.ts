/**
 * Shared BOM-aware text decoding + no-BOM NUL-corruption detection.
 *
 * `fs.readFileSync(path, "utf8")` blindly reinterprets whatever bytes are on
 * disk as UTF-8, with no BOM sniffing and no UTF-16 detection. A file saved
 * as UTF-16LE/BE (the common Windows default for .ps1/.bat, and a real
 * possibility for any text file edited on Windows) decodes into
 * NUL-interleaved garbage — or, worse, invalid UTF-8 byte sequences that
 * Node's decoder silently replaces with U+FFFD (REPLACEMENT CHARACTER), a
 * LOSSY, non-invertible transform.
 *
 *   - For a READ-only consumer (find, references) this means a literal
 *     query can never match content that is really there — bad enough to
 *     certify a false "this token does not exist anywhere" absence.
 *   - For a WRITE consumer it is worse: a naive read-modify-write round
 *     trip through the utf8<->string bridge does not merely misread a
 *     UTF-16 file, it PERMANENTLY CORRUPTS it on the very first write (the
 *     U+FFFD substitutions cannot be mapped back to the original bytes).
 *
 * Every consumer — read-side and write-side — sniffs bytes through this ONE
 * module before trusting a plain UTF-8 decode. Factored out of
 * findText.ts's readLinesCached (2026-08-27, the read-side false-absence
 * fix) when the same defect class was confirmed across the write paths
 * (rangeEdit.ts, searchReplaceEdit.ts, applyEditsMulti.ts, readAndEdit.ts,
 * renameSymbol.ts) and findReferences.ts the same day.
 */

/** Bytes sniffed, with no recognized BOM, before trusting a plain UTF-8 decode. */
export const UNDECODABLE_PROBE_BYTES = 4096;

/**
 * True when, with no recognized BOM, the leading bytes are NUL-riddled — the
 * hallmark of a UTF-16-without-BOM save (or other non-text content) misread
 * as UTF-8. A real UTF-8/ASCII text file essentially never contains a raw
 * NUL in its first few KB; a UTF-16 file saved without a BOM interleaves one
 * after every ASCII-range code unit.
 */
function looksUndecodableNoBom(buf: Buffer): boolean {
  const probe = buf.subarray(0, Math.min(buf.length, UNDECODABLE_PROBE_BYTES));
  return probe.includes(0);
}

/**
 * Full BOM-aware decode into text: honors a UTF-16LE/BE or UTF-8 BOM, and
 * applies the no-BOM NUL-corruption guard. Returns `null` when the content
 * cannot be decoded with confidence — the caller must treat that as
 * "undecodable" (unverifiable content), never as "empty". Read-side use
 * (find/references): the caller still WANTS the text even for UTF-16 — a
 * BOM present just picks the right decoder; only a NO-BOM NUL-riddled file
 * is refused.
 */
export function decodeTextBuffer(buf: Buffer): string | null {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    // UTF-16LE BOM — Node's "utf16le" encoding is already little-endian.
    return buf.subarray(2).toString("utf16le");
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16BE BOM: no big-endian decoder exists among Buffer's built-in
    // encodings, so byte-swap a COPY into LE order first (never mutate the
    // source buffer). swap16() requires an even length; a dangling final
    // odd byte (a malformed/truncated file) is dropped rather than thrown on.
    const body = Buffer.from(buf.subarray(2));
    const evenLen = body.length - (body.length % 2);
    return body.subarray(0, evenLen).swap16().toString("utf16le");
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString("utf8");
  }
  if (looksUndecodableNoBom(buf)) return null;
  return buf.toString("utf8");
}

/** Tags for the write-path guard's refusal reason — see detectWriteEncodingRisk. */
export type WriteEncodingRisk = "utf16le" | "utf16be" | "undecodable";

/**
 * Write-path guard: classifies a file's raw bytes as either safe to
 * continue handling through the existing read-utf8/write-utf8 bridge, or
 * unsafe (the write MUST refuse rather than proceed). Returns `undefined`
 * when safe.
 *
 * Plain UTF-8 — WITH or WITHOUT its own BOM — round-trips losslessly
 * through Node's utf8 codec (the BOM byte sequence maps to exactly one
 * valid codepoint, U+FEFF, and back), so it is NOT refused here. Only
 * content a naive utf8 read-modify-write would silently corrupt is:
 *   - a UTF-16 BOM (`"utf16le"` / `"utf16be"`) — decoding these bytes as
 *     UTF-8 hits invalid sequences that Node lossily replaces with U+FFFD;
 *   - no recognized BOM with NUL-riddled leading bytes (`"undecodable"`) —
 *     the same corruption, minus the one legible signal (a BOM) that would
 *     have named the real encoding.
 *
 * Full UTF-16 round-trip editing is out of scope for this guard: refusing
 * is the correct, safe v0.12.0 behavior — a write-path caller must never
 * decode-as-utf8-then-write-back for a file this function flags; it must
 * refuse the edit instead.
 */
export function detectWriteEncodingRisk(buf: Buffer): WriteEncodingRisk | undefined {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return "utf16le";
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return "utf16be";
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return undefined; // UTF-8 BOM: round-trips losslessly, safe
  if (looksUndecodableNoBom(buf)) return "undecodable";
  return undefined;
}

/** Human-readable description of a WriteEncodingRisk, for refusal messages. */
export function describeWriteEncodingRisk(risk: WriteEncodingRisk): string {
  if (risk === "utf16le") return "UTF-16LE (not UTF-8)";
  if (risk === "utf16be") return "UTF-16BE (not UTF-8)";
  return "not decodable as UTF-8 text (binary content or an unrecognized encoding)";
}

/** Shared refusal message text for the write-path fail-closed guard (code "unsupported-encoding"). */
export function writeEncodingRefusalMessage(relPath: string, risk: WriteEncodingRisk): string {
  return `Cannot edit ${relPath}: file is ${describeWriteEncodingRisk(risk)} — TokenLighten's write tools only support UTF-8 text this release; re-save the file as UTF-8, or edit it with a tool that supports this encoding.`;
}
