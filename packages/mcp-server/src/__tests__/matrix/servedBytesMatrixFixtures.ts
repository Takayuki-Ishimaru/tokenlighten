/**
 * servedBytesMatrixFixtures.ts — deterministic byte-level fixtures for
 * `servedBytesMatrix.spec.ts` (MX-B, 2026-09-14).
 *
 * Every fixture's bytes are built AT TEST-RUN TIME from escape sequences
 * (`String.fromCharCode(0)`, explicit byte arrays) — this source file never
 * contains a raw NUL byte, and no fixture byte is ever written into a
 * checked-in file. Each encoding is deliberately built so the exact verdict
 * `util/textDecode.ts::readServedText` should reach is derivable by hand from
 * that module's own documented policy (BOM sniff -> bomless-UTF-16 sniff ->
 * strict UTF-8 -> whole-text NUL density), which is also asserted directly in
 * the "pure decode policy" describe block of the spec so the wire assertions
 * have an independently-computed baseline to compare against, not a
 * hardcoded guess.
 *
 * Route/site inventory this generator is designed to feed:
 * `scratchpad/fix-notes-ab1.md`'s 62 call-site table (`scratchpad/ab1-sites.log`),
 * `packages/mcp-server/src/__tests__/servedBytesDoors.spec.ts`'s door list,
 * and `handsOnReport0142Fixtures.ts`'s `buildLenientDecodeWorkspace` (same
 * corruption shapes, generalized to all seventeen encodings the matrix brief
 * names rather than the four that helper covers).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// The seventeen encodings the brief names, plus the verdict each should
// reach under the CURRENT `readServedText` policy (util/textDecode.ts). This
// map is the shared baseline: the pure-layer describe asserts it is what
// `readServedText` actually returns, and the wire-layer describes assert
// every route reports the SAME verdict family for the same fixture.
// ---------------------------------------------------------------------------

export type EncodingId =
  | "utf8-valid"
  | "utf8-literal-fffd"
  | "utf8-bom"
  | "utf16le-bom"
  | "utf16be-bom"
  | "utf16le-no-bom"
  | "utf16be-no-bom"
  | "latin1-invalid"
  | "nul-sparse"
  | "nul-dense"
  | "nul-past-4kib"
  | "nul-last-byte"
  | "empty"
  | "bom-only"
  | "shift-jis"
  | "nul-past-surface-cap"
  | "nul-in-comment";

export const ENCODING_IDS: readonly EncodingId[] = [
  "utf8-valid",
  "utf8-literal-fffd",
  "utf8-bom",
  "utf16le-bom",
  "utf16be-bom",
  "utf16le-no-bom",
  "utf16be-no-bom",
  "latin1-invalid",
  "nul-sparse",
  "nul-dense",
  "nul-past-4kib",
  "nul-last-byte",
  "empty",
  "bom-only",
  "shift-jis",
  "nul-past-surface-cap",
  "nul-in-comment",
] as const;

export type VerdictFamily = "clean" | "stripped" | "undecodable";

/** The independently-derived expectation (see this file's own doc comment). */
export const EXPECTED_VERDICT: Record<EncodingId, VerdictFamily> = {
  "utf8-valid": "clean",
  "utf8-literal-fffd": "clean",
  "utf8-bom": "clean",
  "utf16le-bom": "clean",
  "utf16be-bom": "clean",
  "utf16le-no-bom": "undecodable",
  "utf16be-no-bom": "undecodable",
  "latin1-invalid": "undecodable",
  "nul-sparse": "stripped",
  "nul-dense": "undecodable",
  "nul-past-4kib": "undecodable",
  "nul-last-byte": "stripped",
  "empty": "clean",
  "bom-only": "clean",
  "shift-jis": "undecodable",
  "nul-past-surface-cap": "stripped",
  "nul-in-comment": "stripped",
};

/** The undecodable reason a route/refusal message should name, where applicable. */
export const EXPECTED_UNDECODABLE_REASON: Partial<Record<EncodingId, string>> = {
  "utf16le-no-bom": "utf16-no-bom",
  "utf16be-no-bom": "utf16-no-bom",
  "latin1-invalid": "invalid-encoding",
  "nul-dense": "nul-dense",
  "nul-past-4kib": "nul-dense",
  "shift-jis": "invalid-encoding",
};

/** A representative subset used for the mechanism-level routes (map/markdown/counterexample/cursor) — one of each verdict family plus a second undecodable flavor, per the brief's "keep the cell count practical". */
export const REPRESENTATIVE_IDS: readonly EncodingId[] = [
  "utf8-valid",
  "nul-sparse",
  "latin1-invalid",
  "shift-jis",
];

/** Same idea, for the two-file "counterexample" pairing (needs a DISTINCT clean partner per id). */
export const COUNTEREXAMPLE_IDS: readonly EncodingId[] = [
  "utf8-valid",
  "nul-sparse",
  "latin1-invalid",
  "utf16le-no-bom",
];

const NUL = String.fromCharCode(0);

function sanitize(id: EncodingId): string {
  return id.replace(/[^a-zA-Z0-9]/g, "_");
}

/** The one code identifier embedded (decodably, where the encoding allows it) in each fixture — the "needle" the `symbol` / `literal-first` / `search_files find` routes target. */
export function matrixIdentifier(id: EncodingId): string {
  return `servedMatrixSymbol_${sanitize(id)}`;
}

function commentPadding(lineCount: number): string {
  return "// padding line kept well clear of the declaration above or below\n".repeat(lineCount);
}

/**
 * Deterministic bytes for one encoding. `identifier` defaults to this
 * encoding's own `matrixIdentifier`, but the counterexample workspace
 * builder overrides it so the SAME corruption shape can carry a DIFFERENT
 * (shared) identifier — see `buildServedBytesMatrixWorkspace`. Every branch
 * is commented with the verdict it is built to reach; see EXPECTED_VERDICT
 * above for the same claim in table form.
 */
export function buildEncodingBytes(id: EncodingId, identifier: string = matrixIdentifier(id)): Buffer {
  const declLine = `export const ${identifier} = () => {};\n`;
  switch (id) {
    case "utf8-valid": {
      // clean: ordinary UTF-8, ~2 KiB (the "small" tier) — the control fixture.
      const body = commentPadding(28) + declLine + "// end of clean fixture\n";
      return Buffer.from(body, "utf8");
    }
    case "utf8-literal-fffd": {
      // clean: a literal U+FFFD the AUTHOR wrote (encodes to valid UTF-8
      // bytes EF BF BD) — must be preserved, never treated as a decode
      // artifact and never stripped (readServedText's replacementRatio is
      // reported, never a gate).
      return Buffer.from(`${declLine}// literal replacement char: �\n`, "utf8");
    }
    case "utf8-bom": {
      // clean: EF BB BF prefix, decoded with the BOM stripped.
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(declLine, "utf8")]);
    }
    case "utf16le-bom": {
      // clean: FF FE prefix names UTF-16LE.
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(declLine, "utf16le")]);
    }
    case "utf16be-bom": {
      // clean: FE FF prefix names UTF-16BE — byte-swap a UTF-16LE buffer.
      const le = Buffer.from(declLine, "utf16le");
      const be = Buffer.from(le).swap16();
      return Buffer.concat([Buffer.from([0xfe, 0xff]), be]);
    }
    case "utf16le-no-bom": {
      // undecodable/utf16-no-bom: no BOM, but the alternating-NUL signature
      // (every other byte 0x00 for ASCII text) is dense enough to be
      // recognized as a lost-BOM UTF-16LE save, NOT strict-UTF-8-decoded.
      return Buffer.from(declLine, "utf16le");
    }
    case "utf16be-no-bom": {
      // undecodable/utf16-no-bom: same signature, opposite byte parity.
      const le = Buffer.from(declLine, "utf16le");
      return Buffer.from(le).swap16();
    }
    case "latin1-invalid": {
      // undecodable/invalid-encoding: one Latin-1 byte (0xE9, "é") that is
      // not valid UTF-8 anywhere in the buffer.
      return Buffer.concat([
        Buffer.from(`${declLine}// caf`, "utf8"),
        Buffer.from([0xe9]),
        Buffer.from(" latte\n", "utf8"),
      ]);
    }
    case "nul-sparse": {
      // stripped: ONE NUL in a ~2 KiB buffer — (len-1)/len well over 0.99.
      const body = commentPadding(28) + declLine + NUL + "// binary marker\n";
      return Buffer.from(body, "utf8");
    }
    case "nul-dense": {
      // undecodable/nul-dense: five NULs in ~35 chars — density fails
      // MIN_NUL_FREE_RATIO regardless of the "nul-in-short-file" carve-out,
      // which fires only for EXACTLY one NUL.
      const body = `${declLine}${NUL.repeat(5)}// end\n`;
      return Buffer.from(body, "utf8");
    }
    case "nul-past-4kib": {
      // undecodable/nul-dense: 300 NULs starting well past byte 4096 — the
      // exact shape of finding 49/50 (the retired 4 KB probe called this
      // "decodable"; the whole-buffer policy must not).
      const body = `// ${"a".repeat(4200)}\n${declLine}${("x" + NUL).repeat(300)}`;
      return Buffer.from(body, "utf8");
    }
    case "nul-last-byte": {
      // stripped: the ONE NUL is the buffer's literal final byte (no
      // trailing newline after it) — an edge case for any route that slices
      // or line-splits near EOF.
      const body = commentPadding(27) + declLine + NUL;
      return Buffer.from(body, "utf8");
    }
    case "empty": {
      // clean: totalLength 0 short-circuits before any ratio is computed.
      return Buffer.alloc(0);
    }
    case "bom-only": {
      // clean: a UTF-8 BOM with nothing after it decodes to "".
      return Buffer.from([0xef, 0xbb, 0xbf]);
    }
    case "shift-jis": {
      // undecodable/invalid-encoding: valid Shift-JIS, never valid UTF-8 —
      // strict decode must fail outright, never fall back to a ratio.
      return Buffer.concat([
        Buffer.from(`// ${identifier}\n`, "utf8"),
        Buffer.from(Array.from({ length: 80 }, (_, i) => (i % 2 === 0 ? 0x93 : 0xfa))),
        Buffer.from("\n"),
      ]);
    }
    case "nul-past-surface-cap": {
      // stripped, > MAX_SURFACE_CODE_BYTES (12288 B, readCodeTaskPack.ts):
      // ONE NUL placed after the 12 KiB mark, in an otherwise-huge clean
      // file — ratio-wise this is still "stripped" (sparsity, not density),
      // which is the point: does a route that only ever SLICES a window of
      // a large file still compute the verdict over the WHOLE buffer, and
      // still state the strip when the served slice's own sha/range must
      // describe the stripped text rather than the disk bytes?
      const body = `// ${"a".repeat(12300)}\n${declLine}${NUL}// end\n`;
      return Buffer.from(body, "utf8");
    }
    case "nul-in-comment": {
      // stripped: the ONE NUL sits inside a `//` comment line, with the
      // declaration itself entirely clean before and after it — probes
      // whether comment-eliding logic (elideDocComments et al.) special-
      // cases comment text in a way that bypasses the whole-file policy.
      const body = `${commentPadding(14)}// marker ${NUL} embedded in a comment only\n${declLine}${commentPadding(14)}`;
      return Buffer.from(body, "utf8");
    }
    default: {
      const never: never = id;
      throw new Error(`unhandled encoding id: ${String(never)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Workspace assembly
// ---------------------------------------------------------------------------

export function writeBytes(dir: string, rel: string, buf: Buffer): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
}

/** A fresh, realpath'd direct child of `os.tmpdir()` — no `--allowed-parent` needed (see handsOnReportFixtures.ts's own `freshWorkspace`, same convention). */
export function freshMatrixWorkspace(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tl-mxb-${tag}-`));
  return fs.realpathSync(dir);
}

export const DECOY_CSS = "/* decoy sibling file, never corrupted */\n.panel { color: red; }\n";

export function relPathFor(id: EncodingId): string {
  return `src/enc/${sanitize(id)}.ts`;
}

export function relMarkdownPathFor(id: EncodingId): string {
  return `docs/enc/${sanitize(id)}.md`;
}

export function counterexampleCleanPathFor(id: EncodingId): string {
  return `src/cx/${sanitize(id)}-clean.ts`;
}

export function counterexamplePathFor(id: EncodingId): string {
  return `src/cx/${sanitize(id)}-encoded.ts`;
}

export function counterexampleIdentifierFor(id: EncodingId): string {
  return `cxSharedSymbol_${sanitize(id)}`;
}

/**
 * Builds the ONE shared workspace every describe block in the matrix spec
 * reads from. All 17 encodings get a `.ts` fixture; the REPRESENTATIVE_IDS
 * subset additionally gets a `.md` copy (markdown-outline route) and
 * COUNTEREXAMPLE_IDS gets a clean/encoded pair (a query names the
 * `-clean.ts` half plus the shared identifier; the `-encoded.ts` half — same
 * identifier, this encoding's corruption — becomes the
 * readiness-falsification-counterexample candidate).
 */
export function buildServedBytesMatrixWorkspace(): { dir: string } {
  const dir = freshMatrixWorkspace("main");
  writeBytes(dir, "package.json", Buffer.from('{"name":"tl-mxb-fixture","private":true}\n', "utf8"));
  writeBytes(dir, "src/decoy.css", Buffer.from(DECOY_CSS, "utf8"));

  for (const id of ENCODING_IDS) {
    writeBytes(dir, relPathFor(id), buildEncodingBytes(id));
  }

  for (const id of REPRESENTATIVE_IDS) {
    // Same bytes, `.md` extension — routes the outline dispatcher through
    // isMarkdownPath's heading-outline branch instead of the code-skeleton
    // branch.
    writeBytes(dir, relMarkdownPathFor(id), buildEncodingBytes(id));
  }

  for (const id of COUNTEREXAMPLE_IDS) {
    const sharedIdentifier = counterexampleIdentifierFor(id);
    writeBytes(
      dir,
      counterexampleCleanPathFor(id),
      Buffer.from(`export const ${sharedIdentifier} = 1;\n// the clean half of a counterexample pair\n`, "utf8"),
    );
    // The SAME identifier, embedded directly (never a post-hoc string
    // replace on already-encoded bytes, which would silently no-op for a
    // multi-byte encoding like UTF-16).
    writeBytes(dir, counterexamplePathFor(id), buildEncodingBytes(id, sharedIdentifier));
  }

  return { dir };
}
