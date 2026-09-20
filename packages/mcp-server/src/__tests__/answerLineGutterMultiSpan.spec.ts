// answerLineGutterMultiSpan.spec.ts — WP-G1 (2026-09-20): TL_ANSWER_LINE_GUTTER
// coverage for the two served-body shapes answerLineGutter.spec.ts's original
// matrix did not reach.
//
// MEASURED GAP (live GitHub Copilot session, recorded on a build that already
// had the single-span gutter): the first pack numbered PaymentService,
// OrderStatus, and api.js, but left the two bodies the answer actually
// depended on UN-numbered:
//   1. `OrderService.java:27-420`, `remaining:["1-26","80-179"]` — the
//      response-budget cap cut lines 80-179 OUT OF THE MIDDLE of the body,
//      with no marker at the cut. The body is `renderer(27-79) + "\n" +
//      renderer(180-420)`. The old gutter only numbered a body byte-equal to
//      rendering the WHOLE `range` in one piece, so it refused.
//   2. `OrderController.java:62-69` (a caller-of-focused surface) — the body
//      is the handler window followed by verbatim source lines from OUTSIDE
//      the range (`package …;`, one `import …;`) that
//      `materializeExplicitAnswerAnchorEvidence` (readCodeTaskPack.ts)
//      appends for each still-missing explicit identifier. Refused for the
//      same reason.
// The model's own words right after that pack: "the cancel path is
// identified; next I will fetch the EXACT LINE NUMBERS the answer needs" —
// spending model requests re-reading ranges it already held. This file pins
// `lineGutter.ts`'s fix: MULTI-SPAN bodies (range minus in-range `remaining`
// windows) and COMPOSITE bodies (a rendered window plus appended,
// individually-verified-unique context lines).
//
// Every fixture is generated into os.tmpdir() by this file — no bench
// fixture, corpus, or session path is read — matching answerLineGutter.spec
// .ts's own convention. Fixture line numbers below deliberately mirror the
// measured reproduction (27-420 / 80-179 / cancel at 274; 62-69 / package
// line at 1) as closely as a synthetic file can, so this suite's assertions
// double as a direct check against the numbers the brief for this work
// records; the original probe workspace itself did not survive an
// in-progress machine restart during this wave, so this is a reconstruction
// of the same SHAPE, not a replay of the original bytes.
//
// These cases call `applyAnswerLineGutter` DIRECTLY against a REAL file on
// disk (the same "direct seam check" pattern as answerLineGutter.spec.ts's
// own last case): a multi-span or composite body is a shape the
// response-budget cap or `materializeExplicitAnswerAnchorEvidence` (owned by
// a different work package in this wave, readCodeTaskPack.ts) produce
// internally. What this module must get right is the CONTRACT — given a
// path+range(+remaining)+body of one of these shapes, on real bytes on disk,
// does it number soundly? — independent of whichever producer code path
// reaches it on the wire.

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { applyAnswerLineGutter, stripAnswerLineGutter } from "../protocol/lineGutter.js";
import { elideDocCommentsWithWindows } from "../util/formatCompress.js";

const FLAG = "TL_ANSWER_LINE_GUTTER";

const workspaces: string[] = [];

afterEach(() => {
  delete process.env[FLAG];
  for (const root of workspaces.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A 420-line Java file shaped after the measured reproduction: lines 1-26
 * are outside the served `range` entirely (so a `remaining` window there
 * must be ignored, not treated as a cut), 27-79 and 180-420 are the two
 * spans either side of a 100-line cap-shed hole (80-179), and a 4-line doc
 * comment at 270-273 sits just ahead of `cancel` at line 274 — so the second
 * span alone still exercises the pre-existing doc-comment elision logic
 * alongside the new multi-span jump.
 */
function buildOrderServiceLines(): string[] {
  const lines: string[] = [];
  lines.push("package com.example.billing;");
  lines.push("");
  lines.push("public class OrderService {");
  for (let n = 4; n <= 26; n++) lines.push(`  // preamble filler ${n}`);
  for (let n = 27; n <= 79; n++) lines.push(`  // span-one filler ${n}`);
  for (let n = 80; n <= 179; n++) lines.push(`  // cut filler ${n}`);
  for (let n = 180; n <= 269; n++) lines.push(`  // span-two filler ${n}`);
  lines.push("  /**");
  lines.push("   * Cancels an existing order and issues a refund if captured.");
  lines.push("   * @param id the order identifier");
  lines.push("   */");
  lines.push("  public OrderResponse cancel(long id) {");
  lines.push("    OrderResponse response = repo.find(id);");
  lines.push("    response.setStatus(\"CANCELLED\");");
  lines.push("    return response;");
  lines.push("  }");
  // Lines 380 and 400 are blank (not filler comments) so the file has
  // several blank lines, not one -- realistic Java has blank lines between
  // members throughout, and a test proving a bare blank separator is NOT
  // individually unique needs more than the single blank line at line 2.
  for (let n = 279; n <= 419; n++) lines.push(n === 380 || n === 400 ? "" : `  // trailing filler ${n}`);
  lines.push("}");
  return lines;
}

/**
 * A 70-line Java controller: `package` (line 1) and `import` (line 2) are
 * the out-of-range context a composite body appends, and lines 62-69 are an
 * 8-line handler window (a 4-line doc comment at 62-65 ahead of `cancel` at
 * 66) matching the measured OrderController.java:62-69 reproduction.
 */
function buildOrderControllerLines(): string[] {
  const lines: string[] = [];
  lines.push("package com.example.web;");
  lines.push("import com.example.service.OrderService;");
  lines.push("");
  lines.push("public class OrderController {");
  for (let n = 5; n <= 61; n++) lines.push(`  // controller filler ${n}`);
  lines.push("  /**");
  lines.push("   * Cancels the given order via the service layer.");
  lines.push("   * @param id order identifier");
  lines.push("   */");
  lines.push("  public ResponseEntity<Void> cancel(long id) {");
  lines.push("    orderService.cancel(id);");
  lines.push("    return ResponseEntity.ok().build();");
  lines.push("  }");
  lines.push("}");
  return lines;
}

function makeWorkspace(fileName: string, lines: string[]): { root: string; lines: string[] } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tl-gutter-multispan-"));
  workspaces.push(root);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", fileName), lines.join("\n") + "\n", "utf8");
  return { root, lines };
}

/**
 * The renderer's own rendering of file lines `[start,end]` (1-based
 * inclusive) — the exact building block a multi-span or composite body
 * concatenates, per ruling (aa): every expected body in this file is
 * assembled from this, never hand-typed, so a test can never accidentally
 * encode a marker shape the real renderer would not produce.
 */
function renderSpan(lines: readonly string[], start: number, end: number): string {
  const slice = lines.slice(start - 1, end).join("\n");
  return elideDocCommentsWithWindows(slice, "java", start).text;
}

function firstEvidenceRow(result: Record<string, unknown>): Record<string, unknown> {
  return (result["evidence"] as Array<Record<string, unknown>>)[0]!;
}

// ---------------------------------------------------------------------------
// A. Multi-span (mid-cut) bodies
// ---------------------------------------------------------------------------

describe("TL_ANSWER_LINE_GUTTER — multi-span (mid-cut) bodies", () => {
  it("numbers a body cut in the middle of its range with a jump at the cut, and stripAnswerLineGutter round-trips it", () => {
    process.env[FLAG] = "1";
    const { root, lines } = makeWorkspace("OrderService.java", buildOrderServiceLines());
    const body = `${renderSpan(lines, 27, 79)}\n${renderSpan(lines, 180, 420)}`;

    const payload = {
      profile: "answer",
      evidence: [{
        handle: "h1",
        path: "src/OrderService.java",
        range: "27-420",
        remaining: ["1-26", "80-179"], // "1-26" is OUTSIDE this item's own range: must be ignored, not treated as a cut
        body,
      }],
    };
    const result = applyAnswerLineGutter(payload, "read.task_pack", { codecTraceWorkspace: root });
    const numbered = String(firstEvidenceRow(result)["body"]);
    const numberedLines = numbered.split("\n");

    expect(numberedLines[0]).toBe("27|  // span-one filler 27");
    const idx79 = numberedLines.findIndex((l) => l.startsWith("79|"));
    expect(idx79).toBeGreaterThanOrEqual(0);
    expect(numberedLines[idx79 + 1]).toMatch(/^180\|/);

    const cancelLine = numberedLines.find((l) => l.includes("public OrderResponse cancel(long id)"));
    expect(cancelLine).toMatch(/^274\|/);
    expect(numberedLines[numberedLines.length - 1]).toBe("420|}");

    expect(stripAnswerLineGutter(numbered)).toBe(body);
  });

  it("numbers a body cut in TWO places with a jump at each cut", () => {
    process.env[FLAG] = "1";
    const { root, lines } = makeWorkspace("OrderService.java", buildOrderServiceLines());
    const body = [renderSpan(lines, 27, 79), renderSpan(lines, 130, 299), renderSpan(lines, 351, 420)].join("\n");

    const payload = {
      profile: "answer",
      evidence: [{
        handle: "h1",
        path: "src/OrderService.java",
        range: "27-420",
        remaining: ["1-26", "80-129", "300-350"],
        body,
      }],
    };
    const result = applyAnswerLineGutter(payload, "read.task_pack", { codecTraceWorkspace: root });
    const numbered = String(firstEvidenceRow(result)["body"]);
    const numberedLines = numbered.split("\n");

    const idx79 = numberedLines.findIndex((l) => l.startsWith("79|"));
    expect(idx79).toBeGreaterThanOrEqual(0);
    expect(numberedLines[idx79 + 1]).toMatch(/^130\|/);

    const idx299 = numberedLines.findIndex((l) => l.startsWith("299|"));
    expect(idx299).toBeGreaterThanOrEqual(0);
    expect(numberedLines[idx299 + 1]).toMatch(/^351\|/);

    const cancelLine = numberedLines.find((l) => l.includes("public OrderResponse cancel(long id)"));
    expect(cancelLine).toMatch(/^274\|/);

    expect(stripAnswerLineGutter(numbered)).toBe(body);
  });

  it("a multi-span body with a mismatched line (e.g. a kept comment) stays entirely untouched", () => {
    process.env[FLAG] = "1";
    const { root, lines } = makeWorkspace("OrderService.java", buildOrderServiceLines());
    const goodBodyLines = `${renderSpan(lines, 27, 79)}\n${renderSpan(lines, 180, 420)}`.split("\n");
    goodBodyLines[0] = "  // TAMPERED, NEVER PRODUCED BY THE RENDERER";
    const mismatchedBody = goodBodyLines.join("\n");

    const payload = {
      profile: "answer",
      evidence: [{
        handle: "h1",
        path: "src/OrderService.java",
        range: "27-420",
        remaining: ["1-26", "80-179"],
        body: mismatchedBody,
      }],
    };
    const result = applyAnswerLineGutter(payload, "read.task_pack", { codecTraceWorkspace: root });
    const row = firstEvidenceRow(result);
    expect(row["body"]).toBe(mismatchedBody);
    expect(String(row["body"])).not.toMatch(/^\d+\|/m);
  });

  it("overlapping remaining windows are an inconsistent cut shape: leave the body untouched, never guess", () => {
    process.env[FLAG] = "1";
    const { root, lines } = makeWorkspace("OrderService.java", buildOrderServiceLines());
    const body = `${renderSpan(lines, 27, 79)}\n${renderSpan(lines, 180, 420)}`;

    const payload = {
      profile: "answer",
      evidence: [{
        handle: "h1",
        path: "src/OrderService.java",
        range: "27-420",
        remaining: ["80-150", "120-179"], // overlapping: inconsistent
        body,
      }],
    };
    const result = applyAnswerLineGutter(payload, "read.task_pack", { codecTraceWorkspace: root });
    const row = firstEvidenceRow(result);
    expect(row["body"]).toBe(body);
    expect(String(row["body"])).not.toMatch(/^\d+\|/m);
  });

  it("a non-array remaining field makes ONLY the holes-excluded candidate unavailable: a genuinely cut body (which needs it) still stays untouched", () => {
    // `remaining` is a hint, never an authority (WP-G1 follow-up): a
    // malformed value never crashes or forces a guess, it just removes the
    // holes-excluded CANDIDATE from consideration. The full-range candidate
    // is always tried too; this body is a genuine mid-cut shape that only
    // the (now unavailable) holes-excluded candidate could explain, so with
    // no candidate left standing the whole entry stays untouched.
    process.env[FLAG] = "1";
    const { root, lines } = makeWorkspace("OrderService.java", buildOrderServiceLines());
    const body = `${renderSpan(lines, 27, 79)}\n${renderSpan(lines, 180, 420)}`;

    const payload = {
      profile: "answer",
      evidence: [{ handle: "h1", path: "src/OrderService.java", range: "27-420", remaining: "not-an-array", body }],
    };
    const result = applyAnswerLineGutter(payload, "read.task_pack", { codecTraceWorkspace: root });
    const row = firstEvidenceRow(result);
    expect(row["body"]).toBe(body);
    expect(String(row["body"])).not.toMatch(/^\d+\|/m);
  });

  it("a FALSE claimed hole (the real body is actually the plain full-range rendering) never demotes the full-range match — WP-G1 follow-up regression", () => {
    // Measured shape (live ShopFlow reproduction, 2026-09-20): a producer
    // defect (`buildAnswerTaskPack`'s "query-focused member" excerpt loop,
    // readCodeTaskPack.ts) can merge a claimed `remaining` hole into a
    // primary surface whose body already contains the whole member UNCUT.
    // `remaining` here claims 80-179 is missing, but the real body is the
    // renderer's own FULL 27-420 rendering with nothing removed. Trusting
    // the claim used to render the WRONG (holes-excluded) candidate, fail
    // equality, and fall back to numbering only the 27-79 prefix (35/299
    // lines) with the other 264 left `~|` -- strictly worse than no gutter
    // at all. The full-range candidate must win instead.
    process.env[FLAG] = "1";
    const { root, lines } = makeWorkspace("OrderService.java", buildOrderServiceLines());
    const body = renderSpan(lines, 27, 420); // the FULL range, genuinely uncut

    const payload = {
      profile: "answer",
      evidence: [{ handle: "h1", path: "src/OrderService.java", range: "27-420", remaining: ["1-26", "80-179"], body }],
    };
    const result = applyAnswerLineGutter(payload, "read.task_pack", { codecTraceWorkspace: root });
    const numbered = String(firstEvidenceRow(result)["body"]);
    const numberedLines = numbered.split("\n");

    expect(numberedLines[0]).toBe("27|  // span-one filler 27");
    expect(numberedLines.every((l) => /^\d+\|/.test(l))).toBe(true);
    expect(numberedLines[numberedLines.length - 1]).toBe("420|}");
    const cancelLine = numberedLines.find((l) => l.includes("public OrderResponse cancel(long id)"));
    expect(cancelLine).toMatch(/^274\|/);

    expect(stripAnswerLineGutter(numbered)).toBe(body);
  });

  it("a full-range MATCH plus an appended verbatim excerpt of content the range ALREADY contains: the excerpt numbers at its true (in-range) line, non-verbatim lines stay ~| (WP-G1 follow-up)", () => {
    // The exact measured composite shape: the primary body is the renderer's
    // FULL, uncut rendering of the field's own `range` (strong corroboration
    // on its own), followed by a blank separator, a SYNTHETIC marker comment
    // (never verbatim source text), and a CONTIGUOUS run of lines that are
    // already part of the served range -- a "query-focused member" excerpt
    // appended on top of a primary surface that already contains the whole
    // member. `remaining` falsely claims an in-range hole (ignored: the
    // full-range candidate wins on line count). The blank/marker are not
    // verbatim source lines anywhere and stay `~|`; the 18-line excerpt is a
    // CONTIGUOUS run that matches the file's text at exactly one place (even
    // though it sits inside the already-served range, and even though its
    // own first/last lines are not unique in isolation) and gets true
    // numbers.
    process.env[FLAG] = "1";
    const { root, lines } = makeWorkspace("OrderService.java", buildOrderServiceLines());
    const fullRender = renderSpan(lines, 27, 420);
    const excerpt = lines.slice(199, 217).join("\n"); // file lines 200-217, verbatim, inside 27-420
    const body = `${fullRender}\n\n/* query-focused member place (200-217) */\n${excerpt}`;

    const payload = {
      profile: "answer",
      evidence: [{ handle: "h1", path: "src/OrderService.java", range: "27-420", remaining: ["1-26", "80-179"], body }],
    };
    const result = applyAnswerLineGutter(payload, "read.task_pack", { codecTraceWorkspace: root });
    const numbered = String(firstEvidenceRow(result)["body"]);
    const numberedLines = numbered.split("\n");
    const bodyLineCount = body.split("\n").length;

    expect(numberedLines).toHaveLength(bodyLineCount);
    const fullRenderLen = fullRender.split("\n").length;
    expect(numberedLines[fullRenderLen]).toBe("~|"); // blank separator
    expect(numberedLines[fullRenderLen + 1]).toBe("~|/* query-focused member place (200-217) */");
    for (let k = 0; k < 18; k++) {
      expect(numberedLines[fullRenderLen + 2 + k]).toBe(`${200 + k}|${lines[199 + k]}`);
    }
    const numberedCount = numberedLines.filter((l) => /^\d+\|/.test(l)).length;
    const tildeCount = numberedLines.filter((l) => l.startsWith("~|")).length;
    expect(numberedCount).toBeGreaterThan(tildeCount);
    expect(tildeCount).toBe(2);

    expect(stripAnswerLineGutter(numbered)).toBe(body);
  });

  it("guard (2): an interpretation that would leave MORE lines ~| than truly numbered is never applied — the body stays untouched", () => {
    // A window match too short (uncorroborated) to accept on its own, with
    // appended content that is mostly NOT independently placeable (only one
    // of four extra lines is genuinely unique outside the served span).
    // Even though that one line COULD be placed, applying the interpretation
    // would leave 3 of 4 appended lines (plus nothing else) as noise beside
    // a single numbered line -- net more `~|` than true numbers among the
    // lines this interpretation would touch beyond the trivial window position.
    process.env[FLAG] = "1";
    const { root, lines } = makeWorkspace("OrderController.java", buildOrderControllerLines());
    const windowLines = renderSpan(lines, 62, 69).split("\n");
    const prefixCutWindow = windowLines.slice(0, 1).join("\n"); // ONLY the doc marker line
    // Four appended lines, none of them present anywhere in the file at all
    // (so none can be independently confirmed) except one.
    const body = [
      prefixCutWindow,
      "package com.example.web;", // the only genuinely unique, placeable line
      "// nonsense context line A, appears nowhere in the file",
      "// nonsense context line B, appears nowhere in the file",
      "// nonsense context line C, appears nowhere in the file",
    ].join("\n");

    const payload = {
      profile: "answer",
      evidence: [{ handle: "h1", path: "src/OrderController.java", range: "62-69", body }],
    };
    const result = applyAnswerLineGutter(payload, "read.task_pack", { codecTraceWorkspace: root });
    const row = firstEvidenceRow(result);
    expect(row["body"]).toBe(body);
    expect(String(row["body"])).not.toMatch(/^\d+\|/m);
  });

  it("flag unset: a multi-span body ships byte-identical (no gutter)", () => {
    const { root, lines } = makeWorkspace("OrderService.java", buildOrderServiceLines());
    const body = `${renderSpan(lines, 27, 79)}\n${renderSpan(lines, 180, 420)}`;
    const payload = {
      profile: "answer",
      evidence: [{ handle: "h1", path: "src/OrderService.java", range: "27-420", remaining: ["1-26", "80-179"], body }],
    };
    const result = applyAnswerLineGutter(payload, "read.task_pack", { codecTraceWorkspace: root });
    expect(firstEvidenceRow(result)["body"]).toBe(body);
  });
});

// ---------------------------------------------------------------------------
// B. Composite (window + appended out-of-range context) bodies
// ---------------------------------------------------------------------------

describe("TL_ANSWER_LINE_GUTTER — composite (window + appended context) bodies", () => {
  it("numbers the window and each uniquely-placeable appended context line (package -> 1)", () => {
    process.env[FLAG] = "1";
    const { root, lines } = makeWorkspace("OrderController.java", buildOrderControllerLines());
    const body = `${renderSpan(lines, 62, 69)}\npackage com.example.web;\nimport com.example.service.OrderService;`;

    const payload = {
      profile: "answer",
      evidence: [{ handle: "h1", path: "src/OrderController.java", range: "62-69", body }],
    };
    const result = applyAnswerLineGutter(payload, "read.task_pack", { codecTraceWorkspace: root });
    const numbered = String(firstEvidenceRow(result)["body"]);
    const numberedLines = numbered.split("\n");

    expect(numberedLines[0]).toMatch(/^62\|\s*\/\* doc elided L62-65 \*\/$/);
    expect(numberedLines[1]).toMatch(/^66\|.*cancel\(long id\)/);
    expect(numberedLines[numberedLines.length - 2]).toBe("1|package com.example.web;");
    // Reported per the brief: in this reconstructed fixture the import line
    // sits at file line 2 (immediately after `package`), so it numbers 2.
    // The original live reproduction's own import line number is unknown —
    // the probe workspace that produced it did not survive this wave's
    // machine restart, so this fixture reconstructs the SHAPE, not a replay.
    expect(numberedLines[numberedLines.length - 1]).toBe("2|import com.example.service.OrderService;");

    expect(stripAnswerLineGutter(numbered)).toBe(body);
  });

  it("falls back to un-numbered ~| for the WHOLE appended group when even the BLOCK is not uniquely placeable", () => {
    // A block match (WP-G1 follow-up) can place lines that are not unique
    // ALONE, so ambiguity has to be genuinely block-level here: duplicate
    // BOTH appended lines, adjacent and in the same order, elsewhere in the
    // file. A single duplicated line (e.g. just `import`) would no longer
    // be enough to defeat placement, since the 2-line block "package;
    // import;" would still be unique even though `import` alone is not.
    process.env[FLAG] = "1";
    const controllerLines = buildOrderControllerLines();
    controllerLines.push("package com.example.web;", "import com.example.service.OrderService;");
    const { root, lines } = makeWorkspace("OrderController.java", controllerLines);
    const body = `${renderSpan(lines, 62, 69)}\npackage com.example.web;\nimport com.example.service.OrderService;`;

    const payload = {
      profile: "answer",
      evidence: [{ handle: "h1", path: "src/OrderController.java", range: "62-69", body }],
    };
    const result = applyAnswerLineGutter(payload, "read.task_pack", { codecTraceWorkspace: root });
    const numbered = String(firstEvidenceRow(result)["body"]);
    const numberedLines = numbered.split("\n");

    // The window part is still numbered -- only the appended group falls back.
    expect(numberedLines[0]).toMatch(/^62\|/);
    expect(numberedLines[1]).toMatch(/^66\|.*cancel\(long id\)/);
    expect(numberedLines[numberedLines.length - 2]).toBe("~|package com.example.web;");
    expect(numberedLines[numberedLines.length - 1]).toBe("~|import com.example.service.OrderService;");

    expect(stripAnswerLineGutter(numbered)).toBe(body);
  });

  it("a window that is ALSO a whole-line prefix cut, followed by appended context, numbers the prefix and the context (prefix-cut composite)", () => {
    process.env[FLAG] = "1";
    const { root, lines } = makeWorkspace("OrderController.java", buildOrderControllerLines());
    const windowLines = renderSpan(lines, 62, 69).split("\n");
    const prefixCutWindow = windowLines.slice(0, 2).join("\n"); // only the doc marker + the `cancel` line
    const body = `${prefixCutWindow}\npackage com.example.web;\nimport com.example.service.OrderService;`;

    const payload = {
      profile: "answer",
      evidence: [{ handle: "h1", path: "src/OrderController.java", range: "62-69", body }],
    };
    const result = applyAnswerLineGutter(payload, "read.task_pack", { codecTraceWorkspace: root });
    const numbered = String(firstEvidenceRow(result)["body"]);
    const numberedLines = numbered.split("\n");

    expect(numberedLines).toHaveLength(4);
    expect(numberedLines[0]).toMatch(/^62\|/);
    expect(numberedLines[1]).toMatch(/^66\|.*cancel\(long id\)/);
    expect(numberedLines[2]).toBe("1|package com.example.web;");
    expect(numberedLines[3]).toBe("2|import com.example.service.OrderService;");

    expect(stripAnswerLineGutter(numbered)).toBe(body);
  });

  it("flag unset: a composite body ships byte-identical (no gutter)", () => {
    const { root, lines } = makeWorkspace("OrderController.java", buildOrderControllerLines());
    const body = `${renderSpan(lines, 62, 69)}\npackage com.example.web;\nimport com.example.service.OrderService;`;
    const payload = {
      profile: "answer",
      evidence: [{ handle: "h1", path: "src/OrderController.java", range: "62-69", body }],
    };
    const result = applyAnswerLineGutter(payload, "read.task_pack", { codecTraceWorkspace: root });
    expect(firstEvidenceRow(result)["body"]).toBe(body);
  });
});

// ---------------------------------------------------------------------------
// C. read.batch entries name the same concept `remaining_ranges`
// ---------------------------------------------------------------------------

describe("TL_ANSWER_LINE_GUTTER — read.batch entries use remaining_ranges", () => {
  it("numbers a read.batch entry's multi-span content using its own remaining_ranges field", () => {
    process.env[FLAG] = "1";
    const { root, lines } = makeWorkspace("OrderService.java", buildOrderServiceLines());
    const content = `${renderSpan(lines, 27, 79)}\n${renderSpan(lines, 180, 420)}`;

    const payload = {
      entries: [{
        form: "handle",
        path: "src/OrderService.java",
        range: "27-420",
        remaining_ranges: ["1-26", "80-179"],
        content,
      }],
    };
    const result = applyAnswerLineGutter(payload, "read.batch", {
      codecTraceWorkspace: root,
      args: { taskProfile: "answer" },
    });
    const row = (result["entries"] as Array<Record<string, unknown>>)[0]!;
    const numbered = String(row["content"]);
    const numberedLines = numbered.split("\n");

    const idx79 = numberedLines.findIndex((l) => l.startsWith("79|"));
    expect(idx79).toBeGreaterThanOrEqual(0);
    expect(numberedLines[idx79 + 1]).toMatch(/^180\|/);
    expect(stripAnswerLineGutter(numbered)).toBe(content);
  });
});
