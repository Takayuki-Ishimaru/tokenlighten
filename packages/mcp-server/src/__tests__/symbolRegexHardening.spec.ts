// symbolRegexHardening.spec.ts — CWE-1333 regression coverage.
//
// TL-V0.9-RELEASE-STRATEGY-2026-08-12.md §6.6: task-pack `paths[].symbol` is a
// caller-supplied JSON string (server.ts's mode=pack path mapping does
// `String(e["symbol"])` with no validation, and the task_pack mapper does the
// same) that used to be interpolated straight into `new RegExp(...)`:
//
//   - packages/mcp-server/src/tools/readCodePack.ts symbolSlice()
//   - packages/mcp-server/src/tools/getSymbolWithContext.ts
//     extractSiblingSignatures() (via isTargetElidedSignatureLine())
//
// An unescaped symbol let a caller trigger catastrophic backtracking
// (symbol:"(a+)+$") or an uncaught SyntaxError (symbol:"["). Both sites now
// escape the symbol with escapeRegExp (the same primitive
// renameSymbol.ts/findReferences.ts/readCodeModes.ts already use) and cap its
// length at MAX_REGEX_QUERY_CHARS — findText.ts's own admission bound for
// caller regex text — degrading an empty/unsafe/over-cap symbol to "no
// match" instead of throwing or hanging.
//
// This spec pins: (a) a catastrophic-backtracking payload still completes
// fast, (b) an unbalanced-bracket payload never throws, (c) an over-cap
// symbol degrades to no-match even when a same-named declaration genuinely
// exists, (d) a legitimate identifier still resolves exactly as before the
// hardening (escaping a plain identifier is a no-op).

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readCodePack } from "../tools/readCodePack.js";
import { getSymbolWithContext, isTargetElidedSignatureLine } from "../tools/getSymbolWithContext.js";
import { MAX_REGEX_QUERY_CHARS } from "../features/search/find/findText.js";

// Generous but bounded: catches catastrophic backtracking (which would blow
// well past this on any machine) without being flaky on a loaded CI box.
const REDOS_BUDGET_MS = 2000;

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
});

function mkDir(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tl-symre-${tag}-`));
  tmpDirs.push(dir);
  return dir;
}

function writeFile(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

async function readFileSafe(ws: string, rel: string): Promise<string | null> {
  try {
    return fs.readFileSync(path.join(ws, rel), "utf8");
  } catch {
    return null;
  }
}

describe("symbolRegexHardening — read_file mode=pack paths[].symbol (readCodePack.symbolSlice)", () => {
  it("(a) catastrophic-backtracking payload completes fast against an adversarial line", async () => {
    const ws = mkDir("redos");
    // Pre-fix, `(function|class|def|interface|type)\s+${symbol}\b` with
    // symbol="(a+)+$" substituted verbatim becomes the classic evil regex
    // `(function|class|def|interface|type)\s+(a+)+$\b`. This line satisfies
    // the keyword alternation, gives the inner `a+` a long run of 'a' to
    // chew on, then a non-'a' terminator so the outer `+` can never cleanly
    // reach `$` — every composition of the 32 a's into the outer `+` has to
    // be tried and fails, which is exponential pre-fix.
    const evilLine = "function " + "a".repeat(32) + "!";
    writeFile(ws, "evil.ts", evilLine + "\n");

    const start = Date.now();
    const result = await readCodePack(
      { mode: "pack", paths: [{ path: "evil.ts", symbol: "(a+)+$" }] },
      ws,
      (rel) => readFileSafe(ws, rel),
    );
    const elapsedMs = Date.now() - start;

    expect(elapsedMs).toBeLessThan(REDOS_BUDGET_MS);
    expect(result.items).toEqual([]);
    expect(result.omitted).toEqual([{ path: "evil.ts", reason: "not-found" }]);
    expect(result.completeness).toBe("empty");
  });

  it("(b) an unbalanced-bracket payload returns a normal no-match pack response, never throws", async () => {
    const ws = mkDir("bracket");
    writeFile(ws, "plain.ts", "export function plain() { return 1; }\n");

    await expect(
      readCodePack(
        { mode: "pack", paths: [{ path: "plain.ts", symbol: "[" }] },
        ws,
        (rel) => readFileSafe(ws, rel),
      ),
    ).resolves.not.toThrow();

    const result = await readCodePack(
      { mode: "pack", paths: [{ path: "plain.ts", symbol: "[" }] },
      ws,
      (rel) => readFileSafe(ws, rel),
    );
    expect(result.items).toEqual([]);
    expect(result.omitted).toEqual([{ path: "plain.ts", reason: "not-found" }]);
    expect(result.completeness).toBe("empty");
  });

  it("(c) an over-cap-length symbol degrades to no-match even when the name is a real declaration", async () => {
    const ws = mkDir("overcap");
    const longName = "a".repeat(MAX_REGEX_QUERY_CHARS + 1);
    // The declaration genuinely exists under this exact (huge) name, so the
    // miss below is caused by the length cap, not by an incidental non-match
    // — without the cap, the (now-escaped) pattern would still find it.
    writeFile(ws, "huge.ts", `function ${longName}() { return 1; }\n`);

    const result = await readCodePack(
      { mode: "pack", paths: [{ path: "huge.ts", symbol: longName }] },
      ws,
      (rel) => readFileSafe(ws, rel),
    );

    expect(result.items).toEqual([]);
    expect(result.omitted).toEqual([{ path: "huge.ts", reason: "not-found" }]);
  });

  it("(d) control: a legitimate identifier still slices the same target as before hardening", async () => {
    const ws = mkDir("control");
    writeFile(ws, "symbol.ts", [
      "export function otherFn(): void {}",
      "",
      "export function symbolTarget(): number {",
      "  return 7;",
      "}",
    ].join("\n") + "\n");

    const result = await readCodePack(
      { mode: "pack", paths: [{ path: "symbol.ts", symbol: "symbolTarget" }] },
      ws,
      (rel) => readFileSafe(ws, rel),
    );

    expect(result.completeness).toBe("complete");
    expect(result.items.length).toBe(1);
    expect(result.items[0]!.path).toBe("symbol.ts");
    expect(result.items[0]!.content).toContain("export function symbolTarget(): number {");
    expect(result.items[0]!.content).toContain("return 7");
    // symbolTarget is well within the first 20 lines, so the ±20-line window
    // always starts at line 1 — escaping a plain identifier is a no-op, so
    // this must match pre-hardening behavior exactly.
    expect(result.items[0]!.range).toMatch(/^1-\d+$/);
  });
});

describe("symbolRegexHardening — get_symbol_with_context / task_pack paths[].symbol (isTargetElidedSignatureLine)", () => {
  // Matches treeSitter.ts's own brace-style elided rendering: `${sig} { ... }`.
  const elidedLine = "render(): string { ... }";

  it("(a) catastrophic-backtracking targetName resolves fast against an adversarial line", () => {
    // Same evil-regex shape as the readCodePack case above, mirrored against
    // isTargetElidedSignatureLine's own `\b${targetName}\b.*\{...\}` pattern.
    // Pre-fix, targetName="(a+)+$" substituted verbatim gives
    // `\b(a+)+$\b.*\{...\}`: a clean word-boundary at position 0, a long run
    // of 'a' for the inner `a+` to chew on, then a non-'a' terminator so the
    // outer `+` can never cleanly reach `$` — exponential pre-fix.
    const evilLine = "a".repeat(32) + "!";
    const start = Date.now();
    const matched = isTargetElidedSignatureLine(evilLine, "(a+)+$");
    expect(Date.now() - start).toBeLessThan(REDOS_BUDGET_MS);
    expect(matched).toBe(false);
  });

  it("(b) an unbalanced-bracket targetName returns false, never throws", () => {
    expect(() => isTargetElidedSignatureLine(elidedLine, "[")).not.toThrow();
    expect(isTargetElidedSignatureLine(elidedLine, "[")).toBe(false);
  });

  it("(c) an over-cap-length targetName degrades to false", () => {
    const longName = "a".repeat(MAX_REGEX_QUERY_CHARS + 1);
    const line = `${longName}(): string { ... }`;
    expect(isTargetElidedSignatureLine(line, longName)).toBe(false);
  });

  it("(d) control: a legitimate identifier matches exactly as the original unescaped regex would", () => {
    expect(isTargetElidedSignatureLine(elidedLine, "render")).toBe(true);
    expect(isTargetElidedSignatureLine("other(): void { ... }", "render")).toBe(false);
  });

  it("(e) the same quartet end-to-end through getSymbolWithContext — the task_pack paths[].symbol route (server.ts's mapTaskPackPaths forwards paths[].symbol into `symbol` unsanitized, same as get_symbol_with_context's own `symbol` input)", async () => {
    const tsSrc = [
      "export class Widget {",
      "  render(): string {",
      "    return \"<widget/>\";",
      "  }",
      "",
      "  resize(w: number): void {",
      "    this.width = w;",
      "  }",
      "}",
    ].join("\n") + "\n";

    // (a)/(b)/(c): an adversarial `symbol` must never throw or hang the
    // whole call, regardless of which internal branch (found vs not-found)
    // ends up handling it.
    const adversarialSymbols = ["(a+)+$", "[", "a".repeat(MAX_REGEX_QUERY_CHARS + 1)];
    for (const adversarial of adversarialSymbols) {
      const start = Date.now();
      const result = await getSymbolWithContext(tsSrc, { path: "widget.ts", symbol: adversarial });
      expect(Date.now() - start).toBeLessThan(REDOS_BUDGET_MS);
      expect(typeof result.ok).toBe("boolean");
    }

    // (d) control: a legitimate symbol still finds the right body AND still
    // correctly excludes the target's own elided signature from the sibling
    // list (the exact behavior isTargetElidedSignatureLine is responsible
    // for) — proving the hardening left real symbol lookups unchanged.
    const result = await getSymbolWithContext(tsSrc, { path: "widget.ts", symbol: "render" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.code).toContain("sibling signatures");
    expect(result.data.code).toContain("resize");
    const siblingSection = result.data.code.split("sibling signatures:")[1]?.split("target:")[0] ?? "";
    expect(siblingSection).not.toContain("render(");
  });
});

// ---------------------------------------------------------------------------
// edit_file intent append-enum-member — the same CWE-1333 shape on the write
// path: symbolName is the caller's raw args.symbol (server.ts prefers it over
// the handle-resolved name). Found by this wave's new-RegExp sweep; fixed by
// mirroring appendUnionMember.ts's escapeForRegex.
// ---------------------------------------------------------------------------
import { appendEnumMember } from "../intents/appendEnumMember.js";

describe("append-enum-member symbolName hardening", () => {
  const braceEnum = "enum Color {\n  RED,\n  GREEN\n}\n";
  const pythonEnum = "class Color(Enum):\n    RED = \"RED\"\n";

  it("does not throw on an unbalanced-bracket symbol and simply finds no enum", () => {
    expect(appendEnumMember(braceEnum, "[", "BLUE", undefined)).toBeNull();
    expect(appendEnumMember(pythonEnum, "[", "BLUE", "python")).toBeNull();
  });

  it("completes fast on a backtracking-shaped symbol against adversarial content", () => {
    const adversarial = `enum ${"a".repeat(2000)} {`;
    const started = Date.now();
    expect(appendEnumMember(adversarial, "(a+)+$", "BLUE", undefined)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("still appends to a plain identifier enum (control, both syntaxes)", () => {
    const brace = appendEnumMember(braceEnum, "Color", "BLUE", undefined);
    expect(brace).toContain("BLUE");
    const python = appendEnumMember(pythonEnum, "Color", "BLUE", "python");
    expect(python).toContain("BLUE = \"BLUE\"");
  });
});
