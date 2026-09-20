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

import { readFileSync as nodeReadFileSync } from "node:fs";

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

/**
 * SHOULD-FIX 32 (2026-09-14, review round 4/5): the lenient, TOTAL
 * counterpart to `decodeTextBuffer` above — used by every reader whose job is
 * "produce SOME text for bytes I could read at all", never "decide whether
 * to trust this content as evidence". `readCodeSmallFile.ts`'s small-file
 * serve and `safePath.ts::readFileSafe` (~40-80 call sites; see that
 * function's own 2026 comment: "this fix's mandate is UTF-16 BOM parity, not
 * a new 'can't read this as text' failure mode") have each carried this exact
 * `decodeTextBuffer(buf) ?? buf.toString("utf8")` fallback inline for a
 * while. `readCodeTaskPack.ts`'s query-named-file augmentation used to be the
 * one server-side reader that did NOT fall back — so a NUL-riddled file the
 * slice route (`targets:[{handle}]`, routed through `buildSmallFile`) would
 * happily serve was disclosed as `"undecodable"`/`recoverable:false`, a claim
 * the response's own `next` then contradicted by producing exactly those
 * bytes. One formula now, so "can I serve this at all" (this function) and
 * "should I CERTIFY over content I have not actually verified" — the strict
 * `decodeTextBuffer`, unchanged, still the only decoder `findText.ts`'s
 * scan-for-absence and the write-path guard trust — can never drift apart.
 *
 * Total once `buf` exists: `Buffer.prototype.toString("utf8")` never throws,
 * so this never returns `null`/`undefined`. The only way to fail to produce
 * text for a path is for the READ ITSELF to fail (permissions, ENOENT, a
 * directory) — a fact the caller learns from its own `fs.readFileSync`/
 * `fs.readFile` throwing, not from this function.
 */
export function decodeTextBufferLenient(buf: Buffer): string {
  return decodeTextBuffer(buf) ?? buf.toString("utf8");
}

/** Counts non-overlapping occurrences of a single-character needle in `text`. */
function countChar(text: string, ch: string): number {
  let count = 0;
  for (let index = text.indexOf(ch); index !== -1; index = text.indexOf(ch, index + 1)) count++;
  return count;
}

/**
 * SHOULD-FIX 35 (2026-09-14, review round 5): `decodeTextBufferLenient`
 * above is deliberately TOTAL — it always returns SOME string once bytes
 * exist, even when those bytes are a genuine encoding failure (a BOM-less
 * UTF-16 save, or any other non-text content misread as UTF-8) that turns
 * into NUL-interleaved or U+FFFD-riddled garbage. That is still the right
 * contract for `safePath.ts::readFileSafe`'s ~40-80 call sites — a "give me
 * whatever text you can" reader this classification does not touch.
 *
 * It is the WRONG contract for a call site that is about to SERVE this text
 * as evidence and let a certified decision treat it as verified content
 * (`readCodeTaskPack.ts::augmentQueryNamedFileSurfaces`) — that call site
 * used to certify over mojibake with literal NUL bytes still in the served
 * body. `classifyLenientText` is the ADDITIONAL judgment call that call site
 * needs and `readFileSafe` does not: given text `decodeTextBufferLenient`
 * already produced (only ever consulted once the STRICT `decodeTextBuffer`
 * has already refused the bytes), is it trustworthy enough to serve as
 * evidence at all?
 *
 * SHOULD-FIX 37 (2026-09-14, review round 6): `readCodeSmallFile.ts`'s
 * tiny-file slice route (`buildSmallFile`) is a SECOND, independent path to
 * the SAME bytes this augmentation names query-named-file evidence for — a
 * caller can reach it directly (`targets:[{path}]`), and the augmentation's
 * own `next` (`content:"auto"` on a tiny file) reaches it too. It now runs
 * its unconditional `decodeTextBufferLenient` result through this same
 * classifier for the RARE-incidental-NUL ("stripped") case specifically, so
 * a file this augmentation discloses as "nul-stripped" cannot have that
 * exact NUL served raw one prescribed call later. It leaves "undecodable"
 * text exactly as `decodeTextBufferLenient` produced it, matching that
 * function's own total, never-refuses contract — a caller-facing REFUSAL
 * for heavily-corrupted content reached this way is the larger "two readers
 * must agree" structural question filed as its own chip, not this finding's.
 *
 *   - `"clean"`       — no U+0000, no U+FFFD: nothing to second-guess.
 *   - `"stripped"`    — some U+0000 present, but RARE (the NUL-free
 *     remainder is at least `MIN_NUL_FREE_RATIO` of the text) — the review's
 *     own ruling for "a single incidental NUL inside an otherwise-UTF-8
 *     file": serve the text with every U+0000 removed rather than refusing a
 *     file that is overwhelmingly real, readable content. The caller is
 *     expected to say so (a `why`/reason annotation), never serve it silently
 *     as if the bytes were untouched.
 *   - `"undecodable"` — U+0000 ABOVE that threshold (the hallmark of a whole
 *     file misread: a BOM-less UTF-16 save interleaves one NUL after every
 *     ASCII-range code unit, so a genuine UTF-16 file is never "rare NULs"),
 *     OR a U+FFFD ratio above `MAX_REPLACEMENT_RATIO` — unlike a NUL, a
 *     replacement character is already a lossy, non-invertible substitution
 *     Node's own decoder made for bytes that were never valid UTF-8 at all,
 *     so there is no principled way to "strip" one without silently
 *     deleting content it stands in for; a few are left in the served text
 *     untouched (matching the "small threshold" the finding's own primary
 *     rule states), but a high ratio means the whole buffer is not this
 *     encoding and must never be certified over.
 *
 * `MIN_NUL_FREE_RATIO`/`MAX_REPLACEMENT_RATIO` are the review's own chosen
 * thresholds, picked to admit "one stray control byte in an otherwise-normal
 * file" while refusing "this file is not text in this encoding at all". Pure
 * and total: never throws, never depends on the filesystem.
 */
export const MIN_NUL_FREE_RATIO = 0.99;
export const MAX_REPLACEMENT_RATIO = 0.01;

export type LenientTextVerdict =
  | { kind: "clean"; text: string }
  | { kind: "stripped"; text: string; nulCount: number; totalLength: number }
  | { kind: "undecodable"; nulCount: number; replacementCount: number; totalLength: number };

export function classifyLenientText(text: string): LenientTextVerdict {
  const totalLength = text.length;
  if (totalLength === 0) return { kind: "clean", text };
  const nulCount = countChar(text, "\u0000");
  const replacementCount = countChar(text, "�");
  if (nulCount === 0 && replacementCount === 0) return { kind: "clean", text };
  if (replacementCount / totalLength > MAX_REPLACEMENT_RATIO) {
    return { kind: "undecodable", nulCount, replacementCount, totalLength };
  }
  if (nulCount > 0 && (totalLength - nulCount) / totalLength < MIN_NUL_FREE_RATIO) {
    return { kind: "undecodable", nulCount, replacementCount, totalLength };
  }
  if (nulCount === 0) return { kind: "clean", text };
  return { kind: "stripped", text: text.split("\u0000").join(""), nulCount, totalLength };
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

/**
 * Shared refusal message text for the write-path fail-closed guard (code
 * "unsupported-encoding").
 *
 * BLOCKER 62 (AC1, 2026-09-14, review round 12): the `"undecodable"` risk fires
 * on ANY NUL in the first 4096 bytes, including a file `readServedText` serves
 * with a `"stripped"` verdict — so the caller can legitimately have READ this
 * file (with a note saying the NULs were stripped) and still be refused here.
 * The message now names that read-side disclosure, so the two verdicts read as
 * ONE policy instead of a contradiction; the pack side no longer certifies such
 * an edit at all (`readCodeTaskPack.ts::writeAuthorityVeto`).
 */
export function writeEncodingRefusalMessage(relPath: string, risk: WriteEncodingRisk): string {
  const strippedNote = risk === "undecodable"
    ? " If this file was served to you with a \"nul-stripped\" note, that is the same fact: the served text is NUL-free, the bytes on disk are not, and writing the served text back would delete them."
    : "";
  return `Cannot edit ${relPath}: file is ${describeWriteEncodingRisk(risk)} — TokenLighten's write tools only support UTF-8 text this release; re-save the file as UTF-8, or edit it with a tool that supports this encoding.${strippedNote}`;
}

// ---------------------------------------------------------------------------
// ONE decode policy for every SERVED body (AA1, 2026-09-14, review round 10)
// ---------------------------------------------------------------------------

/**
 * Findings 49/50/51 (review round 9) each measured the same defect at a
 * DIFFERENT door: five independent readers were each deciding, on their own
 * terms, whether bytes are text worth serving. The predicates in play
 * disagreed with each other by construction:
 *
 *   - `decodeTextBuffer` above calls a buffer "decodable" whenever its FIRST
 *     4096 bytes carry no NUL (`looksUndecodableNoBom`). A file whose NULs
 *     begin at byte 4260 passes -- so the readiness-falsification-counterexample
 *     route (which reads via that function) put 300 escaped NUL bytes inside a
 *     certified `act.answer` (finding 49), and `classifyUnreadableNamedPath`
 *     re-derived `"unreadable"` for a file the same server had just read and
 *     certified (finding 50).
 *   - `classifyLenientText` above judges ALREADY-DECODED text by RATIOS, so it
 *     cannot tell "this UTF-8 file contains a literal U+FFFD character" (fine)
 *     from "Node replaced 80 invalid bytes with U+FFFD" (not fine) -- the two
 *     are the same string. Round 8's BLOCKER 40 and round 9's finding 51 are
 *     the two horns of exactly that ambiguity, and no threshold can separate
 *     them, because the distinguishing fact was thrown away by the decode.
 *   - Neither predicate is STRICT in the sense every consumer assumed: an
 *     invalid UTF-8 sequence in the first 4 KB of a no-BOM file is detected by
 *     neither.
 *
 * `readServedText` is the ONE policy, and it asks the question in the one order
 * that makes the answer decidable -- BEFORE the lossy decode, on the BYTES:
 *
 *   1. A recognized BOM names the encoding: decode with it (UTF-16LE/BE,
 *      UTF-8), fatally.
 *   2. With no BOM, an alternating-NUL signature is a BOM-less UTF-16 save
 *      (`utf16-no-bom`) -- checked on the bytes, because such a buffer is
 *      perfectly VALID UTF-8 (U+0000 is a legal codepoint) and would otherwise
 *      sail through step 3.
 *   3. Strict UTF-8: `TextDecoder("utf-8", { fatal: true })` over the WHOLE
 *      buffer. Any invalid sequence anywhere is a failure
 *      (`invalid-encoding`) -- never a ratio, never a probe window. This is
 *      what makes "U+FFFD in the decoded text" unambiguous afterwards: every
 *      surviving U+FFFD is a real character the author wrote, so
 *      `replacementRatio` is REPORTED for diagnostics and is never a gate.
 *   4. NUL characters, counted over the WHOLE decoded text (for a BOM-less
 *      buffer that is exactly the buffer's own NUL-byte count -- no 4 KB
 *      probe): none => `clean`; a RARE one (the NUL-free remainder is at least
 *      `MIN_NUL_FREE_RATIO`) => `stripped`, the review's own ruling for "a
 *      single incidental control byte in an otherwise-real file" -- the caller
 *      serves `text` (already NUL-free) and MUST say that it stripped; past
 *      that => `nul-dense`, disclosed like any other unreadable file.
 *
 * A verdict of `"undecodable"` means: this server must NOT put these bytes on
 * the wire and must NOT certify a decision over them. It discloses the path
 * instead (`unreadable-named-path` / a gap / `coverage` short of complete), so
 * the caller learns the fact rather than receiving mojibake.
 *
 * DOCUMENTED TRADE (round 10): a Latin-1/Shift-JIS file containing bytes that
 * are not valid UTF-8 is now `undecodable` and is DISCLOSED rather than served
 * as mojibake, at every door. Rounds 5-9 served it at two doors and refused it
 * at a third; "served" was the accident of `decodeTextBuffer` only probing for
 * NULs. Disclosure is the honest answer: the server genuinely cannot tell what
 * those bytes say, and a certified answer over mojibake is worse than a row
 * saying "re-save this file as UTF-8". A BOM'd UTF-8/UTF-16 file, and an
 * ordinary UTF-8 file containing a literal U+FFFD character, are served
 * unchanged.
 *
 * Pure and total apart from the path-form read: never throws.
 */
export type ServedTextUndecodableReason =
  /** Strict decode (UTF-8 fatal, or the BOM-named codec) refused the bytes. */
  | "invalid-encoding"
  /** Strict decode succeeded, but NULs are too dense to be incidental. */
  | "nul-dense"
  /**
   * SHOULD-FIX 60: the SAME ratio rule, in the length register where it admits
   * no NUL at all (below `NUL_RATIO_SHORT_FILE_CHARS` characters). Reported
   * separately because "nul-dense" is a false description of one NUL in 42
   * characters — see `NUL_RATIO_SHORT_FILE_CHARS`.
   */
  | "nul-in-short-file"
  /** No BOM, alternating NULs -- a UTF-16 save that lost its BOM. */
  | "utf16-no-bom"
  /** The READ ITSELF failed (ENOENT, permissions, a directory) -- path form only. */
  | "unreadable";

export type ServedTextVerdict =
  | { kind: "clean"; text: string; nulCount: 0; replacementRatio: number; totalLength: number }
  | { kind: "stripped"; text: string; nulCount: number; replacementRatio: number; totalLength: number }
  | {
    kind: "undecodable";
    reason: ServedTextUndecodableReason;
    nulCount: number;
    replacementRatio: number;
    totalLength: number;
  };

/** The NUL character, spelled as an escape so no source file carries a raw NUL byte. */
const NUL_CHAR = "\u0000";

/** Lazily constructed: one fatal UTF-8 decoder, reused for every call. */
let strictUtf8Decoder: InstanceType<typeof TextDecoder> | undefined;

function decodeStrict(bytes: Uint8Array, encoding: "utf-8" | "utf-16le"): string | undefined {
  try {
    if (encoding === "utf-8") {
      strictUtf8Decoder ??= new TextDecoder("utf-8", { fatal: true });
      return strictUtf8Decoder.decode(bytes);
    }
    return new TextDecoder("utf-16le", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * True when a buffer with NO recognized BOM carries the one-NUL-per-code-unit
 * signature of a UTF-16 save: essentially every NUL sits on the SAME parity of
 * byte offset (the high byte of an ASCII-range code unit), and they are dense
 * enough to account for a large share of the buffer's code units.
 *
 * Deliberately narrow: a file that merely contains stray NULs has them
 * scattered across both parities and/or nowhere near half the buffer, and falls
 * to the NUL-density rule instead (reporting `nul-dense`, a different and more
 * accurate fact). `buf.length >= 4` because two code units are the smallest
 * evidence worth calling a pattern.
 */
function looksLikeBomlessUtf16(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  let evenNul = 0;
  let oddNul = 0;
  for (let index = 0; index < buf.length; index++) {
    if (buf[index] !== 0) continue;
    if (index % 2 === 0) evenNul++;
    else oddNul++;
  }
  const dominant = Math.max(evenNul, oddNul);
  if (dominant === 0) return false;
  const stray = Math.min(evenNul, oddNul);
  const codeUnits = Math.floor(buf.length / 2);
  return stray * 10 <= dominant && dominant * 2 >= codeUnits;
}

function classifyDecodedServedText(text: string): ServedTextVerdict {
  const totalLength = text.length;
  // Diagnostic only -- NEVER a gate (see the policy comment above).
  const replacementRatio = totalLength === 0 ? 0 : countChar(text, "�") / totalLength;
  if (totalLength === 0) return { kind: "clean", text, nulCount: 0, replacementRatio, totalLength };
  // WHOLE text, never a probe window (findings 49/50's root cause).
  const nulCount = countChar(text, NUL_CHAR);
  if (nulCount === 0) return { kind: "clean", text, nulCount: 0, replacementRatio, totalLength };
  if ((totalLength - nulCount) / totalLength < MIN_NUL_FREE_RATIO) {
    // SHOULD-FIX 60: ONE rule, TWO honest names. Below
    // `NUL_RATIO_SHORT_FILE_CHARS` the ratio cannot tolerate a single NUL, so
    // the file is refused for its LENGTH, not for NUL density; saying
    // "nul-dense" about 1 NUL in 42 characters is false. The boundary is
    // derived from `MIN_NUL_FREE_RATIO`, never a second threshold.
    // Bounded so the new name cannot mislead in the OTHER direction: 40 NULs
    // in 50 characters IS dense, short file or not. `nul-in-short-file` is the
    // sparsest corruption possible — exactly ONE NUL — refused only because the
    // ratio has no room for it at this length.
    const reason: ServedTextUndecodableReason = nulCount === 1 && totalLength < NUL_RATIO_SHORT_FILE_CHARS
      ? "nul-in-short-file"
      : "nul-dense";
    return { kind: "undecodable", reason, nulCount, replacementRatio, totalLength };
  }
  return {
    kind: "stripped",
    text: text.split(NUL_CHAR).join(""),
    nulCount,
    replacementRatio,
    totalLength,
  };
}

function undecodableServedText(
  reason: ServedTextUndecodableReason,
  nulCount = 0,
  totalLength = 0,
): ServedTextVerdict {
  return { kind: "undecodable", reason, nulCount, replacementRatio: 0, totalLength };
}

/**
 * NOTE 74 (round 10): the `invalid-encoding` arm has no decoded text, so it has
 * no CHARACTER length and cannot count NUL CHARACTERS — it used to report the
 * buffer's byte length in `totalLength` (characters everywhere else) and a
 * hardcoded `nulCount: 0` even for a buffer full of NULs. Report the bytes it
 * actually measured: the buffer's own NUL-BYTE count, and `totalLength: 0`
 * ("no decoded text"), so no consumer can read a byte count as a char count.
 */
function undecodableUndecodedBytes(buf: Buffer): ServedTextVerdict {
  let nulBytes = 0;
  for (let index = 0; index < buf.length; index++) if (buf[index] === 0) nulBytes++;
  return { kind: "undecodable", reason: "invalid-encoding", nulCount: nulBytes, replacementRatio: 0, totalLength: 0 };
}

/**
 * The ONE verdict every SERVED body is gated on. `input` is either the raw
 * bytes or an ABSOLUTE filesystem path to read them from (the path form
 * returns `reason: "unreadable"` when the read itself fails, so a caller can
 * still tell "I could not read this" from "these bytes are not text").
 *
 * See the block comment above `ServedTextUndecodableReason` for the policy and
 * the order it is evaluated in.
 */
export function readServedText(input: Buffer | string): ServedTextVerdict {
  let buf: Buffer;
  if (typeof input === "string") {
    try {
      buf = nodeReadFileSync(input);
    } catch {
      return undecodableServedText("unreadable");
    }
  } else {
    buf = input;
  }
  // 1. A recognized BOM names the encoding.
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    const body = buf.subarray(2);
    // Drop a dangling odd byte exactly as decodeTextBuffer/Buffer#toString do,
    // so a BOM'd file is never refused for a truncated final code unit.
    const decoded = decodeStrict(body.subarray(0, body.length - (body.length % 2)), "utf-16le");
    return decoded === undefined
      ? undecodableUndecodedBytes(buf)
      : classifyDecodedServedText(decoded);
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16BE: byte-swap a COPY into LE order (never mutate the source).
    const body = Buffer.from(buf.subarray(2));
    const even = body.subarray(0, body.length - (body.length % 2));
    const decoded = decodeStrict(Buffer.from(even).swap16(), "utf-16le");
    return decoded === undefined
      ? undecodableUndecodedBytes(buf)
      : classifyDecodedServedText(decoded);
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    const decoded = decodeStrict(buf.subarray(3), "utf-8");
    return decoded === undefined
      ? undecodableUndecodedBytes(buf)
      : classifyDecodedServedText(decoded);
  }
  // 2. No BOM: an alternating-NUL buffer is a UTF-16 save, and IS valid UTF-8,
  //    so it must be caught before the strict decode accepts it.
  if (looksLikeBomlessUtf16(buf)) {
    let nulBytes = 0;
    for (let index = 0; index < buf.length; index++) if (buf[index] === 0) nulBytes++;
    return undecodableServedText("utf16-no-bom", nulBytes, buf.length);
  }
  // 3. Strict UTF-8 over the WHOLE buffer.
  const decoded = decodeStrict(buf, "utf-8");
  if (decoded === undefined) return undecodableUndecodedBytes(buf);
  // 4. NUL density over the WHOLE decoded text.
  return classifyDecodedServedText(decoded);
}

/**
 * Convenience for the callers whose only question is "give me the text I am
 * allowed to serve, or nothing" -- `clean`/`stripped` collapse to their
 * (already NUL-free) text, `undecodable` to `undefined`. A caller that must
 * ANNOTATE the strip, or disclose the reason, uses `readServedText` directly.
 */
export function servedTextOrUndefined(input: Buffer | string): string | undefined {
  const verdict = readServedText(input);
  return verdict.kind === "undecodable" ? undefined : verdict.text;
}

/**
 * SHOULD-FIX 57 (AB1, 2026-09-14, review round 11): the ONE sentence every door
 * uses to STATE a `"stripped"` serve. The policy comment above already says the
 * caller "serves `text` (already NUL-free) and MUST say that it stripped" —
 * round 10 measured five server routes serving it silently, each under a `sha`
 * computed over the stripped text, so the pin did not describe the bytes on
 * disk. One string, so no door can word it differently and none can forget the
 * sha half: it carries the `nul-stripped` token every existing `why` assertion
 * matches, the original small-file sentence verbatim, and the sha statement.
 */
export const NUL_STRIPPED_SERVE_NOTE =
  "nul-stripped: one or more literal NUL bytes were stripped from this file's content before serving;"
  + " the sha, range and byte counts on this response describe the served (stripped) text, not the bytes on disk";

/**
 * SHOULD-FIX 60 (AB1, 2026-09-14, review round 11): `MIN_NUL_FREE_RATIO` is a
 * pure ratio, so for a SHORT file it degenerates into an absolute rule — with
 * one NUL, `(N-1)/N >= 0.99` holds iff `N >= 100`. Round 10 measured that cliff
 * exactly (99 => refused, 100 => stripped) and reported the real defect: the
 * reason word. A 42-byte file holding ONE NUL — the sparsest corruption
 * possible — was told it was `nul-dense`. The refusal is KEPT (a 73-byte 1-NUL
 * file being undecodable at every door is a named criterion of rounds 8-10);
 * only the naming is fixed, and it is fixed by REPORTING WHICH ARM FIRED:
 *
 *   - `"nul-in-short-file"` — below `NUL_RATIO_SHORT_FILE_CHARS` characters,
 *     where the ratio rule cannot tolerate even a single NUL;
 *   - `"nul-dense"` — at or above it, where the NULs really are dense.
 *
 * `NUL_RATIO_SHORT_FILE_CHARS` is not a second threshold to keep aligned: it is
 * DERIVED from `MIN_NUL_FREE_RATIO` (the shortest length at which one NUL is
 * tolerable), so the two cannot drift.
 */
export const NUL_RATIO_SHORT_FILE_CHARS = Math.ceil(1 / (1 - MIN_NUL_FREE_RATIO));

/**
 * Human-readable expansion of a `ServedTextUndecodableReason`, naming the RULE
 * that fired rather than only its tag — `undecodableTextMessage` puts the tag
 * on the wire, and "nul-dense" for one NUL in 42 characters told the caller
 * something false about its own file.
 */
export function describeServedTextRefusal(
  reason: ServedTextUndecodableReason,
  detail?: { nulCount?: number; totalLength?: number },
): string {
  if (reason === "nul-in-short-file") {
    const count = detail?.nulCount;
    const total = detail?.totalLength;
    const measured = count !== undefined && total !== undefined ? `${count} NUL in ${total} characters; ` : "";
    return `nul-in-short-file (${measured}any NUL is refused below ${NUL_RATIO_SHORT_FILE_CHARS} characters, where the ${MIN_NUL_FREE_RATIO} NUL-free ratio cannot tolerate one)`;
  }
  if (reason === "nul-dense") {
    const count = detail?.nulCount;
    const total = detail?.totalLength;
    return count !== undefined && total !== undefined
      ? `nul-dense (${count} NUL in ${total} characters; the NUL-free remainder is below ${MIN_NUL_FREE_RATIO})`
      : `nul-dense (the NUL-free remainder is below ${MIN_NUL_FREE_RATIO})`;
  }
  return reason;
}
