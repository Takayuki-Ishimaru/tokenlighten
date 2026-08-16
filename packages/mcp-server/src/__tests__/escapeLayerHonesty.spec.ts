// escapeLayerHonesty.spec.ts — JSON is the ONLY escape layer.
//
// 2026-08-07 incident: an agent replacing a raw NUL in state/session.ts's
// LANE_KEY_MARKER with the visible six-character escape (backslash + "u0000")
// watched a single raw NUL land on disk instead, for every backslash count it
// tried. The two-stage workaround it needed (write a placeholder, then swap in
// a lone non-adjacent backslash) is the signature of a SECOND unescape layer
// somewhere between the caller and the file bytes.
//
// A 37-case exact-bytes probe driven straight at the spawned server's stdio
// (hand-written JSON-RPC lines, so exactly one escape layer exists by
// construction) cleared this package on every edit_file payload channel, and
// the same collapse reproduced through a NATIVE write tool with no TL server
// in the path — locating the real second layer in the calling harness's
// tool-argument decoder, outside this repo. These tests are the standing
// guarantee that it never migrates IN: `\uXXXX` and raw control characters are
// opaque payload bytes to this package, applied exactly as JSON delivered them.
//
// AUTHORING NOTE — deliberate `String.fromCharCode`: the channel these files
// are written through is the very layer that mangles adjacent backslashes, so
// a source literal like "\\u0000" cannot be trusted to still mean six
// characters by the time it reaches disk. The load-bearing fixtures are built
// from character codes instead, and `fixture guard` below asserts their exact
// codepoints — a mangled fixture fails loudly rather than quietly weakening
// every assertion beneath it.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  applySingleEdit,
  hasLiteralBackslashEscape,
  unescapeBackslashSequences,
} from "../write/textEdit.js";
import { searchReplaceEdit } from "../tools/searchReplaceEdit.js";
import { applyEditsMulti } from "../tools/applyEditsMulti.js";
import { unsafeGuardedWorkspaceRootForTests, type GuardedWorkspaceRoot } from "../write/guardedWorkspace.js";

// ---------------------------------------------------------------------------
// Fixtures — built from codepoints, never from backslash source literals
// ---------------------------------------------------------------------------

const BS = String.fromCharCode(92); // a single backslash
const NUL = String.fromCharCode(0); // a real NUL byte
const ESC_NUL = BS + "u0000"; // the SIX visible characters
const ESC_A = BS + "u0041"; // the SIX visible characters
const LIT_N = BS + "n"; // the TWO characters
const REAL_NL = String.fromCharCode(10);

const SESSION = "escape-layer-honesty";
const tmpDirs: string[] = [];

function mkWorkspace(): GuardedWorkspaceRoot {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-esc-test-"));
  tmpDirs.push(dir);
  return unsafeGuardedWorkspaceRootForTests(dir);
}

function writeFile(ws: string, rel: string, content: string): void {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function readFile(ws: string, rel: string): string {
  return fs.readFileSync(path.join(ws, rel), "utf8");
}

function codes(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

describe("escape-layer honesty — fixture guard", () => {
  it("the load-bearing literals are the exact byte sequences these tests claim", () => {
    expect(ESC_NUL.length).toBe(6);
    expect(codes(ESC_NUL)).toEqual([92, 117, 48, 48, 48, 48]);
    expect(ESC_A.length).toBe(6);
    expect(codes(ESC_A)).toEqual([92, 117, 48, 48, 52, 49]);
    expect(NUL.length).toBe(1);
    expect(codes(NUL)).toEqual([0]);
    expect(codes(LIT_N)).toEqual([92, 110]);
    // The six-character escape is NOT the one-character NUL. If this ever
    // passes trivially the fixture has already been collapsed.
    expect(ESC_NUL).not.toBe(NUL);
  });
});

// ---------------------------------------------------------------------------
// 1. The recovery helpers must not treat `\uXXXX` as an escape class
// ---------------------------------------------------------------------------

describe("escape-layer honesty — unescapeBackslashSequences boundaries", () => {
  it("hasLiteralBackslashEscape ignores `\\uXXXX` — only n/t/r are live classes", () => {
    expect(hasLiteralBackslashEscape(ESC_NUL)).toBe(false);
    expect(hasLiteralBackslashEscape(ESC_A)).toBe(false);
    expect(hasLiteralBackslashEscape(BS + BS + "u0000")).toBe(false);
    // The live classes still fire — this guard must not disable recovery.
    expect(hasLiteralBackslashEscape("foo" + LIT_N + "bar")).toBe(true);
  });

  it("a lone backslash before uXXXX is passed through untouched", () => {
    expect(unescapeBackslashSequences(ESC_NUL)).toBe(ESC_NUL);
    expect(unescapeBackslashSequences(ESC_A)).toBe(ESC_A);
    expect(codes(unescapeBackslashSequences(ESC_NUL))).toEqual([92, 117, 48, 48, 48, 48]);
  });

  it("backslash counts 1..3 before u0000 collapse only the `\\\\` PAIR, never the uXXXX", () => {
    // 1 backslash: nothing to collapse.
    expect(unescapeBackslashSequences(BS + "u0000")).toBe(BS + "u0000");
    // 2 backslashes: the pair becomes one backslash. uXXXX is untouched, so
    // the result is the six-character escape — NOT a NUL byte.
    expect(unescapeBackslashSequences(BS + BS + "u0000")).toBe(BS + "u0000");
    expect(unescapeBackslashSequences(BS + BS + "u0000")).not.toContain(NUL);
    // 3 backslashes: pair + lone.
    expect(unescapeBackslashSequences(BS + BS + BS + "u0000")).toBe(BS + BS + "u0000");
  });

  it("REGRESSION: the n/t/r purpose is preserved", () => {
    expect(unescapeBackslashSequences("a" + LIT_N + "b")).toBe("a" + REAL_NL + "b");
    expect(unescapeBackslashSequences("a" + BS + "tb")).toBe("a" + String.fromCharCode(9) + "b");
    expect(unescapeBackslashSequences("a" + BS + "rb")).toBe("a" + String.fromCharCode(13) + "b");
  });
});

// ---------------------------------------------------------------------------
// 2. applySingleEdit applies payload bytes verbatim (no recovery in play)
// ---------------------------------------------------------------------------

describe("escape-layer honesty — applySingleEdit is byte-transparent", () => {
  it("a replacement carrying the six-character escape writes SIX characters, not a NUL", () => {
    const r = applySingleEdit('const M = "PLACEHOLDER";' + REAL_NL, "PLACEHOLDER", ESC_NUL);
    expect(r.ok).toBe(true);
    expect(r.text).toBe('const M = "' + ESC_NUL + '";' + REAL_NL);
    expect(r.text).not.toContain(NUL);
    expect(r.normalizedEscapes).toBeUndefined();
  });

  it("a replacement carrying a RAW NUL writes exactly one NUL", () => {
    const r = applySingleEdit('const M = "PLACEHOLDER";' + REAL_NL, "PLACEHOLDER", NUL + "lane:");
    expect(r.ok).toBe(true);
    expect(r.text).toBe('const M = "' + NUL + 'lane:";' + REAL_NL);
    expect(codes(r.text!).filter((c) => c === 0).length).toBe(1);
  });

  it("uXXXX on the SEARCH side matches the literal six characters in the file", () => {
    const before = 'const M = "' + ESC_NUL + 'lane:";' + REAL_NL;
    const r = applySingleEdit(before, ESC_NUL + "lane:", NUL + "lane:");
    expect(r.ok).toBe(true);
    expect(r.text).toBe('const M = "' + NUL + 'lane:";' + REAL_NL);
  });

  it("a RAW NUL on the SEARCH side matches the raw NUL in the file (the incident shape)", () => {
    const before = 'const LANE_KEY_MARKER = "' + NUL + 'lane:";' + REAL_NL;
    const r = applySingleEdit(before, NUL + "lane:", ESC_NUL + "lane:");
    expect(r.ok).toBe(true);
    expect(r.text).toBe('const LANE_KEY_MARKER = "' + ESC_NUL + 'lane:";' + REAL_NL);
    expect(r.text).not.toContain(NUL);
    expect(r.normalizedEscapes).toBeUndefined();
  });

  it("controls: real newline, literal backslash-n, and the uXXXX escape all survive together", () => {
    const payload = "A" + REAL_NL + "B" + LIT_N + "C" + ESC_A + "D";
    const r = applySingleEdit("X" + REAL_NL, "X", payload);
    expect(r.ok).toBe(true);
    expect(r.text).toBe(payload + REAL_NL);
    // The uXXXX escape did NOT become the letter it encodes.
    expect(r.text).toContain(ESC_A);
    expect(r.text).not.toContain("C" + "A" + "D");
  });
});

// ---------------------------------------------------------------------------
// 3. Every edit_file payload channel, end to end through the write engines
// ---------------------------------------------------------------------------

describe("escape-layer honesty — payload channels write the bytes JSON delivered", () => {
  it("searchReplaceEdit top-level search/replace", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "m.ts", 'const M = "PLACEHOLDER";' + REAL_NL);

    const r = await searchReplaceEdit(
      { path: "m.ts", search: "PLACEHOLDER", replace: ESC_NUL },
      ws,
      true,
    );

    expect(r.ok).toBe(true);
    expect(readFile(ws, "m.ts")).toBe('const M = "' + ESC_NUL + '";' + REAL_NL);
    expect(readFile(ws, "m.ts")).not.toContain(NUL);
    if (r.ok) expect(r.normalized_escapes).toBeUndefined();
  });

  it("searchReplaceEdit create:true content", async () => {
    const ws = mkWorkspace();
    const content = 'const M = "' + ESC_NUL + '";' + REAL_NL;

    const r = await searchReplaceEdit(
      { path: "created.ts", search: "", replace: content, allow_create: true },
      ws,
      true,
    );

    expect(r.ok).toBe(true);
    expect(readFile(ws, "created.ts")).toBe(content);
    expect(readFile(ws, "created.ts")).not.toContain(NUL);
  });

  it("applyEditsMulti edits[] whole-file search/replace", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "b.ts", 'const M = "PLACEHOLDER";' + REAL_NL);

    const r = await applyEditsMulti(
      { edits: [{ path: "b.ts", search: "PLACEHOLDER", replace: ESC_NUL }] },
      ws,
      true,
      SESSION,
    );

    expect(r.ok).toBe(true);
    expect(readFile(ws, "b.ts")).toBe('const M = "' + ESC_NUL + '";' + REAL_NL);
    if (r.ok) expect(r.normalized_escapes).toBeUndefined();
  });

  it("applyEditsMulti range-scoped replace-all", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "r.ts", ["line1", 'const M = "PLACEHOLDER";', "line3", ""].join(REAL_NL));

    const r = await applyEditsMulti(
      { edits: [{ path: "r.ts", range: "1-3", search: "PLACEHOLDER", replace: ESC_NUL }] },
      ws,
      true,
      SESSION,
    );

    expect(r.ok).toBe(true);
    expect(readFile(ws, "r.ts")).toBe(["line1", 'const M = "' + ESC_NUL + '";', "line3", ""].join(REAL_NL));
    if (r.ok) expect(r.normalized_escapes).toBeUndefined();
  });

  it("applyEditsMulti range + content replacement", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "c.ts", ["line1", "REPLACE_ME", "line3", ""].join(REAL_NL));

    const r = await applyEditsMulti(
      { edits: [{ path: "c.ts", range: "2-2", search: "", replace: "", content: 'const M = "' + ESC_NUL + '";' + REAL_NL }] },
      ws,
      true,
      SESSION,
    );

    expect(r.ok).toBe(true);
    expect(readFile(ws, "c.ts")).toBe(["line1", 'const M = "' + ESC_NUL + '";', "line3", ""].join(REAL_NL));
    expect(readFile(ws, "c.ts")).not.toContain(NUL);
  });

  it("a raw NUL payload is applied, not normalized away, on the batch channel", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "n.ts", 'const M = "PLACEHOLDER";' + REAL_NL);

    const r = await applyEditsMulti(
      { edits: [{ path: "n.ts", search: "PLACEHOLDER", replace: NUL + "lane:" }] },
      ws,
      true,
      SESSION,
    );

    expect(r.ok).toBe(true);
    const after = readFile(ws, "n.ts");
    expect(after).toBe('const M = "' + NUL + 'lane:";' + REAL_NL);
    expect(codes(after).filter((c) => c === 0).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. The ONE legitimate rewrite must be disclosed, and its delta must be true
// ---------------------------------------------------------------------------

describe("escape-layer honesty — escape recovery is disclosed, never silent", () => {
  it("a recovered single edit reports normalized_escapes:true", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "rec.ts", ["alpha", "beta", "gamma", ""].join(REAL_NL));

    // The raw search misses (it carries the literal two-character backslash-n),
    // recovery unescapes it, and the replacement shares the `n` class.
    const r = await searchReplaceEdit(
      { path: "rec.ts", search: "alpha" + LIT_N + "beta", replace: "one" + LIT_N + "two" },
      ws,
      true,
    );

    expect(r.ok).toBe(true);
    expect(readFile(ws, "rec.ts")).toBe(["one", "two", "gamma", ""].join(REAL_NL));
    // The caller's bytes were NOT what got written — say so.
    if (r.ok) expect(r.normalized_escapes).toBe(true);
  });

  it("the recovered edit's lines/delta describe the edit that actually happened", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "delta.ts", ["alpha", "beta", "gamma", ""].join(REAL_NL));

    const r = await searchReplaceEdit(
      { path: "delta.ts", search: "alpha" + LIT_N + "beta", replace: "one" + LIT_N + "two" },
      ws,
      true,
    );

    expect(r.ok).toBe(true);
    if (r.ok) {
      // Before the fix the delta was computed from the caller's raw strings —
      // which never matched this file — and reported a one-line edit.
      expect(r.lines).toBe("1-2");
      expect(r.delta).toBe("+2/-2");
    }
  });

  it("DISCLOSED HAZARD: recovery collapses `\\\\` pairs in the replacement, including before uXXXX", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "haz.ts", ["alpha", "beta", "gamma", ""].join(REAL_NL));

    // The caller sent TWO backslashes before u0000 (the source form of a
    // `\uXXXX` literal). Because the search recovered on the shared `n` class,
    // the replacement is unescaped too and the pair collapses to one
    // backslash. This is the documented recovery contract, not a byte-honesty
    // hole — but it changes the caller's payload, so it must be disclosed.
    const r = await searchReplaceEdit(
      { path: "haz.ts", search: "alpha" + LIT_N + "beta", replace: "X" + LIT_N + "Y" + BS + BS + "u0000" },
      ws,
      true,
    );

    expect(r.ok).toBe(true);
    expect(readFile(ws, "haz.ts")).toBe(["X", "Y" + ESC_NUL, "gamma", ""].join(REAL_NL));
    // Never a NUL byte: uXXXX itself is still opaque.
    expect(readFile(ws, "haz.ts")).not.toContain(NUL);
    if (r.ok) expect(r.normalized_escapes).toBe(true);
  });

  it("an ordinary verbatim success carries no disclosure flag", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "plain.ts", 'const a = "old";' + REAL_NL);

    const r = await searchReplaceEdit(
      { path: "plain.ts", search: '"old"', replace: '"new"' },
      ws,
      true,
    );

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.normalized_escapes).toBeUndefined();
      expect(r.normalized_whitespace).toBeUndefined();
    }
  });
});
