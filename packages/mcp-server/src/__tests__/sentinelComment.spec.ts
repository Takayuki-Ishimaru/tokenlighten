// Tests for util/sentinelComment.ts — the single source of truth for
// TokenLighten's own sentinel/metadata comment lines (get_file_skeleton's
// `tokenlighten:skeleton ...` header/notices, get_symbol_with_context's
// `tokenlighten:scope ...` header/notices).
//
// isTokenlightenSentinelLine is exercised with the EXACT live strings the
// two consumers this module replaced used to hand-roll:
//   - getFileSkeleton.ts's doc-map profile handler (was
//     `trimmed.startsWith("// tokenlighten")`)
//   - getSymbolWithContext.ts's extractSiblingSignatures (was
//     `l.includes("// tokenlighten:skeleton")`)
// plus the `#` (python/ruby) and `/* ... */` (css) forms neither call site
// recognized before.

import { describe, it, expect } from "vitest";
import { commentPrefixFor, commentNote, isTokenlightenSentinelLine } from "../util/sentinelComment.js";

describe("commentPrefixFor", () => {
  it("returns # for python and ruby", () => {
    expect(commentPrefixFor("python")).toBe("#");
    expect(commentPrefixFor("ruby")).toBe("#");
  });

  it("returns // for every other language, including css", () => {
    expect(commentPrefixFor("typescript")).toBe("//");
    expect(commentPrefixFor("javascript")).toBe("//");
    expect(commentPrefixFor("go")).toBe("//");
    expect(commentPrefixFor("java")).toBe("//");
    expect(commentPrefixFor("c")).toBe("//");
    expect(commentPrefixFor("cpp")).toBe("//");
    expect(commentPrefixFor("css")).toBe("//"); // raw prefix only — css-awareness lives in commentNote()
  });
});

describe("commentNote", () => {
  it("wraps css text as a /* ... */ one-liner (css has no line-comment syntax)", () => {
    expect(commentNote("css", "tokenlighten:skeleton path=x.css lang=css original_lines=1 elided_lines=0 profile=full-skeleton"))
      .toBe("/* tokenlighten:skeleton path=x.css lang=css original_lines=1 elided_lines=0 profile=full-skeleton */");
    expect(commentNote("css", "note: AST unavailable; skeleton produced by regex fallback."))
      .toBe("/* note: AST unavailable; skeleton produced by regex fallback. */");
  });

  it("wraps python/ruby text with a # prefix", () => {
    expect(commentNote("python", "tokenlighten:scope path=x.py symbol=foo lang=python"))
      .toBe("# tokenlighten:scope path=x.py symbol=foo lang=python");
    expect(commentNote("ruby", "target:")).toBe("# target:");
  });

  it("wraps every other language with a // prefix", () => {
    expect(commentNote("typescript", "tokenlighten:skeleton path=x.ts lang=typescript original_lines=1 elided_lines=0 profile=class-map"))
      .toBe("// tokenlighten:skeleton path=x.ts lang=typescript original_lines=1 elided_lines=0 profile=class-map");
    expect(commentNote("cpp", "[truncated: file too large even for symbol-map; use mode=symbol for a specific function body]"))
      .toBe("// [truncated: file too large even for symbol-map; use mode=symbol for a specific function body]");
  });

  it("never emits an invalid CSS `//` line, even for a truncation marker", () => {
    const note = commentNote("css", "[truncated: file too large even for symbol-map; use mode=symbol for a specific function body]");
    expect(note.startsWith("//")).toBe(false);
    expect(note).toBe("/* [truncated: file too large even for symbol-map; use mode=symbol for a specific function body] */");
  });
});

describe("isTokenlightenSentinelLine", () => {
  it("recognizes the // form (most languages) — exact live getFileSkeleton.ts header shape", () => {
    expect(isTokenlightenSentinelLine(
      "// tokenlighten:skeleton path=src/foo.ts lang=typescript original_lines=10 elided_lines=2 profile=class-map",
    )).toBe(true);
  });

  it("recognizes the # form (python/ruby) — previously MISSED by the old `// tokenlighten` startsWith checks", () => {
    expect(isTokenlightenSentinelLine(
      "# tokenlighten:skeleton path=src/foo.py lang=python original_lines=5 elided_lines=1 profile=class-map",
    )).toBe(true);
  });

  it("recognizes the /* ... */ one-liner form (css) — previously MISSED entirely (the form did not exist yet)", () => {
    expect(isTokenlightenSentinelLine(
      "/* tokenlighten:skeleton path=src/foo.css lang=css original_lines=5 elided_lines=1 profile=full-skeleton */",
    )).toBe(true);
  });

  it("recognizes a tokenlighten:scope header in all three forms", () => {
    expect(isTokenlightenSentinelLine("// tokenlighten:scope path=src/foo.ts symbol=bar lang=typescript")).toBe(true);
    expect(isTokenlightenSentinelLine("# tokenlighten:scope path=src/foo.py symbol=bar lang=python")).toBe(true);
    expect(isTokenlightenSentinelLine("/* tokenlighten:scope path=src/foo.css symbol=bar lang=css */")).toBe(true);
  });

  it("matches the exact substring getSymbolWithContext.ts's extractSiblingSignatures used to check via .includes", () => {
    // The old check was `l.includes("// tokenlighten:skeleton")` — confirm the
    // replacement predicate accepts the identical live string.
    const line = "// tokenlighten:skeleton path=x.ts lang=typescript original_lines=1 elided_lines=0 profile=class-map";
    expect(isTokenlightenSentinelLine(line)).toBe(true);
  });

  it("ignores leading whitespace", () => {
    expect(isTokenlightenSentinelLine("   // tokenlighten:skeleton path=x.ts lang=typescript")).toBe(true);
    expect(isTokenlightenSentinelLine("\t/* tokenlighten:scope path=x.css symbol=bar lang=css */")).toBe(true);
  });

  it("returns false for an ordinary (non-sentinel) comment in any of the three forms", () => {
    expect(isTokenlightenSentinelLine("// just a regular comment")).toBe(false);
    expect(isTokenlightenSentinelLine("# just a regular comment")).toBe(false);
    expect(isTokenlightenSentinelLine("/* just a regular comment */")).toBe(false);
  });

  it("returns false for a blank line or an ordinary code line", () => {
    expect(isTokenlightenSentinelLine("")).toBe(false);
    expect(isTokenlightenSentinelLine("   ")).toBe(false);
    expect(isTokenlightenSentinelLine("export function foo() {}")).toBe(false);
    expect(isTokenlightenSentinelLine(".badge, .chip--paramount")).toBe(false);
  });

  it("returns false for text that merely mentions 'tokenlighten' without the sentinel prefix shape", () => {
    expect(isTokenlightenSentinelLine("the tokenlighten:skeleton feature is neat")).toBe(false);
    expect(isTokenlightenSentinelLine("tokenlighten:skeleton path=x.ts")).toBe(false); // no comment opener at all
  });
});
