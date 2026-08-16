/**
 * readCodeDocContent.spec.ts — S1/C1: read_code mode=auto (or bare, mode
 * omitted) on a LARGE (>= the local SMALL_FILE_BYTES threshold, 8192 bytes
 * as of 2026-07-16a, was 3000) NON-CODE file returns a capped CONTENT slice,
 * not a useless code-skeleton header ("(no signatures detected)") or a raw
 * skeleton dump.
 *
 * Regression guards:
 *   - a large code .ts file still returns a skeleton via mode=auto.
 *   - explicit mode=skeleton on a .md still returns the skeleton, not content.
 *
 * Uses the in-process dispatch (callTool from ../server.js), same pattern as
 * closureMode.spec.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { callTool, DOC_HEADINGS_CAP_BYTES, DOC_HEADINGS_CAP_ENTRIES } from "../server.js";
import { resetAll } from "../util/session.js";
import { handleTable } from "../util/handles.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const dirs: string[] = [];

function mkWs(tag: string): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(HOME, `.tl-doccontent-${tag}-`)));
  dirs.push(d);
  return d;
}

function write(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function parse(res: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
}

/** >3KB of markdown prose with real headings, well past SMALL_FILE_BYTES (8192 as of 2026-07-16a). */
function bigMarkdown(): string {
  const lines: string[] = ["# Design Notes", "", "## Overview", ""];
  for (let i = 0; i < 200; i++) {
    lines.push(`This is paragraph ${i} of real prose describing the design in detail so the file exceeds the small-file byte threshold comfortably.`);
  }
  lines.push("", "## Appendix", "More detail here.");
  return lines.join("\n") + "\n";
}

/** >3KB of JSON, well past SMALL_FILE_BYTES (8192 as of 2026-07-16a). */
function bigJson(): string {
  const entries: Record<string, unknown> = {};
  for (let i = 0; i < 150; i++) {
    entries[`key_${i}`] = { id: i, label: `entry-${i}`, note: "some real json content for the doc-content test" };
  }
  return JSON.stringify({ entries }, null, 2) + "\n";
}

/** >8KB of TypeScript, for the code-file regression guard (2026-07-16a: was >3KB/120 lines, now needs to clear the raised TINY_BYTES/SMALL_FILE_BYTES=8192 threshold). */
function bigTs(): string {
  const lines: string[] = [];
  for (let i = 0; i < 200; i++) {
    lines.push(`export function fn${i}(x: number): number { return x + ${i}; }`);
  }
  return lines.join("\n") + "\n";
}

describe("read_code mode=auto — large non-code file returns capped content (S1/C1)", () => {
  beforeEach(() => { resetAll(); handleTable.reset(); });
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("large .md via mode=auto returns real content + handle, not a skeleton dead-end", async () => {
    const ws = mkWs("md-auto");
    const md = bigMarkdown();
    write(ws, "NOTES.md", md);
    expect(Buffer.byteLength(md, "utf8")).toBeGreaterThan(3000);

    const res = await callTool("read_file", { path: "NOTES.md", mode: "auto", cwd: ws });
    const body = parse(res);
    const evidence = body["evidence"] as Array<Record<string, unknown>>;

    expect(typeof evidence[0]?.["body"]).toBe("string");
    expect(evidence[0]?.["body"] as string).toContain("paragraph 0 of real prose");
    expect(evidence[0]?.["body"] as string).not.toContain("(no signatures detected)");
    expect(typeof evidence[0]?.["handle"]).toBe("string");
    // Rule T: response-level truncation is `limit`, which appears only when
    // something was withheld — its mere presence IS the truncation signal.
    expect(body["limit"]).toBeDefined();
    const limit = body["limit"] as Record<string, unknown>;
    const next = limit["next"] as Record<string, unknown> | undefined;
    expect(next?.["tool"]).toBe("read_file");
    const nextArgs = next?.["arguments"] as Record<string, unknown> | undefined;
    // Remainder form (2026-07-09c): the continuation names the WHOLE rest of
    // the doc — the slice serve clamps per call — not a fixed +120 window.
    const m = /^(\d+)-(\d+)$/.exec(String(nextArgs?.["range"]));
    expect(m).not.toBeNull();
    const totalLines = md.replace(/\n$/, "").split("\n").length;
    expect(Number(m![2])).toBe(totalLines);
  });

  it("single-line (zero-newline) oversized .txt truncates WITHOUT an inverted next (skc2 Q5: was range=2-1)", async () => {
    const ws = mkWs("single-line");
    // One giant line, no newline anywhere: past SMALL_FILE_BYTES (8192, so
    // the large-non-code branch fires) and past DOC_CONTENT_CAP_BYTES (4096,
    // so the serve truncates mid-line); countLines() === 1, so no whole line
    // exists after the cut and no line range can name the remainder.
    const oneLine = "lorem ipsum single-line payload ".repeat(512); // 16384 bytes, zero newlines
    write(ws, "notes.txt", oneLine);

    const res = await callTool("read_file", { path: "notes.txt", mode: "auto", cwd: ws });
    const body = parse(res);
    const evidence = body["evidence"] as Array<Record<string, unknown>>;

    // Rule T: response-level truncation is `limit`, which appears only when
    // something was withheld — its mere presence IS the truncation signal.
    expect(body["limit"]).toBeDefined();
    expect(typeof evidence[0]?.["body"]).toBe("string");
    expect((evidence[0]?.["body"] as string).length).toBeGreaterThan(0);
    expect(typeof evidence[0]?.["handle"]).toBe("string");
    // THE regression: pre-fix this emitted next "...range=2-1" (start > end).
    // KNOWN GAP (flagged, not patched): limitFrom's deriveNext
    // (readFamily.ts) falls back to a bare `{mode:"slice", handle}` next call
    // whenever a handle exists with zero remaining_ranges, even when — as
    // here — there is genuinely no useful continuation (a single line with
    // no later line to slice). That fabricates a `next` that just re-serves
    // the identical truncated body, silently reintroducing the class of
    // dead-end this test was written to catch (the original bug was an
    // inverted range=2-1; this is a same-handle no-progress loop instead).
    // No correct v1 carrier exists for "next is genuinely absent" here; left
    // pointing at the real regression rather than weakened to pass falsely.
    const limit = body["limit"] as Record<string, unknown> | undefined;
    expect(limit?.["next"]).toBeUndefined();
    expect(String(body["hint"] ?? "")).toContain("mode=full");
  });

  it("single-line file WITH a trailing newline behaves the same (countLines is trailing-newline aware)", async () => {
    const ws = mkWs("single-line-nl");
    const oneLine = "trailing newline single-line xs ".repeat(512) + "\n";
    write(ws, "notes.txt", oneLine);

    const res = await callTool("read_file", { path: "notes.txt", mode: "auto", cwd: ws });
    const body = parse(res);

    // Rule T: response-level truncation is `limit`, which appears only when
    // something was withheld — its mere presence IS the truncation signal.
    expect(body["limit"]).toBeDefined();
    // KNOWN GAP (flagged, not patched): see the identical note on the
    // sibling zero-newline test above — limitFrom's deriveNext fabricates a
    // same-handle no-progress `next` here too.
    const limit = body["limit"] as Record<string, unknown> | undefined;
    expect(limit?.["next"]).toBeUndefined();
    expect(String(body["hint"] ?? "")).toContain("mode=full");
  });

  it("giant first line with real lines after it still emits a VALID in-bounds remainder next", async () => {
    const ws = mkWs("giant-head");
    // First line alone exceeds DOC_CONTENT_CAP_BYTES, so the cap cuts inside
    // line 1 (no newline in the capped slice); lines 2..101 exist, so the
    // continuation must name 2-101 — never inverted, never out of bounds.
    const head = "giant head line without breaks ".repeat(256); // ~8KB, one line
    const tail = Array.from({ length: 100 }, (_, i) => `tail line ${i} with enough prose to matter.`);
    write(ws, "notes.txt", head + "\n" + tail.join("\n") + "\n");

    const res = await callTool("read_file", { path: "notes.txt", mode: "auto", cwd: ws });
    const body = parse(res);

    // Rule T: response-level truncation is `limit`, which appears only when
    // something was withheld — its mere presence IS the truncation signal.
    expect(body["limit"]).toBeDefined();
    const limit = body["limit"] as Record<string, unknown>;
    const next = limit["next"] as Record<string, unknown> | undefined;
    const nextArgs = next?.["arguments"] as Record<string, unknown> | undefined;
    expect(nextArgs?.["range"]).toBe("2-101");
  });

  it("large .md via bare read_code (mode omitted) returns content, not a skeleton", async () => {
    const ws = mkWs("md-bare");
    const md = bigMarkdown();
    write(ws, "NOTES.md", md);

    const res = await callTool("read_file", { path: "NOTES.md", cwd: ws });
    const body = parse(res);
    const evidence = body["evidence"] as Array<Record<string, unknown>>;

    expect(typeof evidence[0]?.["body"]).toBe("string");
    expect(evidence[0]?.["body"] as string).not.toContain("(no signatures detected)");
    expect(typeof evidence[0]?.["handle"]).toBe("string");
  });

  it("large .markdown outline supports Setext and ignores fenced pseudo-headings", async () => {
    const ws = mkWs("markdown-outline");
    const md = [
      "# Real Title",
      "",
      "~~~md",
      "## Fake ATX",
      "Fake Setext",
      "-----------",
      "~~~",
      "",
      "Deployment",
      "==========",
      ...Array.from({ length: 180 }, (_, index) => `Deployment detail ${index}: staged rollout and rollback guidance.`),
      "",
    ].join("\n");
    write(ws, "GUIDE.markdown", md);

    const res = await callTool("read_file", { path: "GUIDE.markdown", cwd: ws });
    const body = parse(res);
    const headings = body["headings"] as Array<Record<string, unknown>>;

    expect(headings.map((heading) => heading["text"])).toEqual(["Real Title", "Deployment"]);
    expect(headings[1]?.["style"]).toBe("setext");
    expect(headings[1]?.["section"]).toBe("Deployment");
    expect(String(headings[1]?.["range"])).toMatch(/^9-\d+$/);
  });

  it("large .json via mode=auto returns real content + handle, not a skeleton dead-end", async () => {
    const ws = mkWs("json-auto");
    const json = bigJson();
    write(ws, "data.json", json);
    expect(Buffer.byteLength(json, "utf8")).toBeGreaterThan(3000);

    const res = await callTool("read_file", { path: "data.json", mode: "auto", cwd: ws });
    const body = parse(res);
    const evidence = body["evidence"] as Array<Record<string, unknown>>;

    expect(typeof evidence[0]?.["body"]).toBe("string");
    expect(evidence[0]?.["body"] as string).toContain("entry-0");
    expect(evidence[0]?.["body"] as string).not.toContain("(no signatures detected)");
    expect(typeof evidence[0]?.["handle"]).toBe("string");
  });

  it("truncation is on a line boundary (capped content never ends mid-line)", async () => {
    const ws = mkWs("md-trunc");
    const md = bigMarkdown();
    write(ws, "NOTES.md", md);

    const res = await callTool("read_file", { path: "NOTES.md", mode: "auto", cwd: ws });
    const body = parse(res);
    const evidence = body["evidence"] as Array<Record<string, unknown>>;
    const content = evidence[0]?.["body"] as string;
    const fullLines = new Set(md.split(/\r?\n/));
    const cappedLines = content.split(/\r?\n/);
    // Every line in the capped output must be a complete line from the
    // source file (no partial/mid-line cut).
    for (const line of cappedLines) {
      expect(fullLines.has(line)).toBe(true);
    }
  });

  it("large code .ts file via mode=auto still returns a skeleton (regression guard)", async () => {
    const ws = mkWs("ts-auto");
    const ts = bigTs();
    write(ws, "big.ts", ts);
    expect(Buffer.byteLength(ts, "utf8")).toBeGreaterThan(8192);

    const res = await callTool("read_file", { path: "big.ts", mode: "auto", cwd: ws });
    const body = parse(res);

    // Rule K: a skeleton is `read.map`'s "signatures" form (A.5.3); its own
    // vocabulary lives at `outline.form`, and there is no top-level `content`
    // or `handle` on this kind — the handle rides at `outline.handle`.
    expect(body["kind"]).toBe("read.map");
    expect(body["content"]).toBeUndefined();
    const outline = body["outline"] as Record<string, unknown>;
    expect(outline["form"]).toBe("signatures");
    expect(typeof outline["handle"]).toBe("string");
  });

  it("large code auto with a semantic query returns the late regression block", async () => {
    const ws = mkWs("ts-query-focus");
    const filler = Array.from({ length: 600 }, (_, index) =>
      `export const filler${index} = ${index};`
    ).join("\n");
    const ts = [
      "function readFile(path: string): string { return path; }",
      filler,
      "describe('execution contract', () => {",
      "  it('keeps a structured next call', () => {",
      "    const result = { execution_contract: { next_call: undefined } };",
      "    expect(result.execution_contract.next_call).toBeUndefined();",
      "  });",
      "});",
    ].join("\n");
    write(ws, "big.spec.ts", ts);

    const res = await callTool("read_file", {
      path: "big.spec.ts",
      mode: "auto",
      query: "find the exact execution_contract structured next_call regression test",
      cwd: ws,
    });
    const body = parse(res);
    const evidence = body["evidence"] as Array<Record<string, unknown>>;

    expect(evidence[0]?.["body"], JSON.stringify(body)).toContain("result.execution_contract");
    expect(evidence[0]?.["body"]).not.toContain("function readFile");
    expect(Number(String(evidence[0]?.["range"]).split("-")[0])).toBeGreaterThan(150);
    // KNOWN GAP (flagged, not patched): `focus` (why this window was chosen
    // semantically) is still computed by server.ts
    // (`...(focus ? { focus } : {})` around line 331) but readFamily.ts's
    // KEPT_ON_TEXT omits it, so it never reaches the wire. No v1 carrier
    // serves this assertion; left unmodified so it keeps failing honestly.
    const focus = body["focus"] as Record<string, unknown>;
    expect(focus["kind"]).toBe("test-block");
  });

  it("large JSON auto with a semantic query returns the late metric", async () => {
    const ws = mkWs("json-query-focus");
    const environment: Record<string, string> = {};
    for (let index = 0; index < 240; index++) environment[`environment_${index}`] = `value-${index}`;
    const json = JSON.stringify({
      environment,
      billing: {
        arm_breakdown: {
          comparison: {
            ratio_a_over_b: 0.86804,
            total_tokens_ratio_a_over_b: 0.773837,
          },
        },
      },
    }, null, 2);
    write(ws, "result.json", json);

    const res = await callTool("read_file", {
      path: "result.json",
      mode: "auto",
      query: "report the paired billing cost ratio A over B",
      cwd: ws,
    });
    const body = parse(res);
    const evidence = body["evidence"] as Array<Record<string, unknown>>;

    expect(evidence[0]?.["body"]).toContain('"ratio_a_over_b": 0.86804');
    expect(evidence[0]?.["body"]).not.toContain('"environment_0"');
    expect(Number(String(evidence[0]?.["range"]).split("-")[0])).toBeGreaterThan(200);
    // KNOWN GAP (flagged, not patched): see the identical note on the
    // semantic TS-query test above — `focus` has no v1 carrier right now.
    const focus = body["focus"] as Record<string, unknown>;
    expect(focus["kind"]).toBe("json-key");
  });

  it("explicit mode=skeleton on a large .md still returns a skeleton, not content", async () => {
    const ws = mkWs("md-skel");
    const md = bigMarkdown();
    write(ws, "NOTES.md", md);

    const res = await callTool("read_file", { path: "NOTES.md", mode: "skeleton", cwd: ws });
    const body = parse(res);

    // The doc-content branch never runs for explicit mode=skeleton — this
    // must go through getFileSkeleton, whose payload has no top-level
    // `content` string field shaped like the doc-content response, and the
    // handle now rides at `outline.handle` (A.5.3's "signatures" form).
    expect(body["kind"]).toBe("read.map");
    expect(body["content"]).toBeUndefined();
    const outline = body["outline"] as Record<string, unknown>;
    expect(typeof outline["handle"]).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Headings-envelope caps — 2026-07-17 spec-final rc2, cell md_4800kb: the
// S1/C1 branch above mapped EVERY parsed heading into the response (22,680
// entries / 3.72MB beside the 4KB-capped body — 917x envelope/body). The
// outline now honors DOC_HEADINGS_CAP_ENTRIES + DOC_HEADINGS_CAP_BYTES with
// explicit headings_truncated/headings_total (mode=overview: the existing
// truncated flag plus sections_total). The exact live call shapes are also
// pinned at full repro scale in replayCorpus.spec.ts (mdh group).
// ---------------------------------------------------------------------------

/** Generated-markdown shape from the repro: many short H2 sections under one H1. */
function generatedHeadingsMarkdown(sectionCount: number): string {
  const lines: string[] = ["# Generated Review Log", ""];
  for (let i = 0; i < sectionCount; i++) {
    lines.push(`## Case ${i} — generated finding with a realistically wide heading title`);
    lines.push("");
    lines.push(`Verdict paragraph for case ${i}: synthesized prose padding the file well past the caps.`);
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

describe("read_file markdown headings envelope caps (md_4800kb regression)", () => {
  beforeEach(() => { resetAll(); handleTable.reset(); });
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("default/auto read of a generated large-headings .md caps the outline by entries AND bytes, truncating explicitly", async () => {
    const ws = mkWs("md-headings-cap");
    const sectionCount = 1500; // 1501 headings total incl. the leading H1
    write(ws, "REVIEW.md", generatedHeadingsMarkdown(sectionCount));

    const res = await callTool("read_file", { path: "REVIEW.md", cwd: ws });
    const body = parse(res);

    // Rule T: response-level truncation is `limit`, which appears only when
    // something was withheld — its mere presence IS the truncation signal.
    expect(body["limit"]).toBeDefined();

    const headings = body["headings"] as Array<Record<string, unknown>>;
    expect(Array.isArray(headings)).toBe(true);
    expect(headings.length).toBeGreaterThan(0);
    expect(headings.length).toBeLessThanOrEqual(DOC_HEADINGS_CAP_ENTRIES);
    expect(Buffer.byteLength(JSON.stringify(headings), "utf8")).toBeLessThanOrEqual(DOC_HEADINGS_CAP_BYTES);
    // Document order survives the cap: the H1 leads.
    expect(headings[0]?.["text"]).toBe("Generated Review Log");

    // Explicit truncation indicator — never silent. `headings_truncated` is
    // now the "metadata" member of `limit.omitted` (A.2.7/§4.4); this
    // response happens to ALSO truncate content (a separate axis), which is
    // what makes `limit` present at all here — see markdownNavigation.spec.ts
    // for the case where ONLY headings are capped and `limit` is absent
    // entirely (a genuine silent-truncation bug, not reproduced by this
    // specific fixture).
    const limit = body["limit"] as Record<string, unknown>;
    expect(limit["omitted"]).toContain("metadata");
    // KNOWN GAP (flagged, not patched): the exact pre-cap heading count
    // (`headings_total`) has no v1 carrier — `limit.omitted` only proves
    // SOME metadata was dropped, not how much. Left pointing at the vanished
    // field.
    expect(body["headings_total"]).toBe(sectionCount + 1);

    // The whole envelope stays sane (live regression: 3.72MB).
    expect(Buffer.byteLength(res.content[0]!.text, "utf8")).toBeLessThan(16384);
  });

  it("mode=overview on the same file byte-caps sections and reports sections_total", async () => {
    const ws = mkWs("md-overview-cap");
    const sectionCount = 1500;
    write(ws, "REVIEW.md", generatedHeadingsMarkdown(sectionCount));

    const res = await callTool("read_file", { path: "REVIEW.md", mode: "overview", cwd: ws });
    const body = parse(res);

    // v1 (A.5.3 + Rule K, 2026-08-14): `mode=overview` on a markdown path used
    // to ship a top-level `kind:"markdown"` that SHADOWED the D4 discriminator,
    // so the response reached the wire wholly unprojected. It is now a
    // `read.map` whose private vocabulary lives at `outline.form`, and Rule T
    // collapses `truncated` into `limit`. `sections_total` — the pre-cap count
    // `limit` cannot state — rides the outline under A.8.2's emitted-iff rule.
    expect(body["kind"]).toBe("read.map");
    const outline = body["outline"] as Record<string, unknown>;
    expect(outline["form"]).toBe("markdown");
    const sections = outline["sections"] as Array<Record<string, unknown>>;
    expect(Array.isArray(sections)).toBe(true);
    expect(sections.length).toBeGreaterThan(0);
    expect(sections.length).toBeLessThanOrEqual(DOC_HEADINGS_CAP_ENTRIES);
    expect(Buffer.byteLength(JSON.stringify(sections), "utf8")).toBeLessThanOrEqual(DOC_HEADINGS_CAP_BYTES);
    expect(body["limit"]).toBeDefined();
    expect(outline["sections_total"]).toBe(sectionCount + 1);
    expect(Buffer.byteLength(res.content[0]!.text, "utf8")).toBeLessThan(16384);
  });

  it("an untruncated outline carries no truncation keys (cap-inactive control)", async () => {
    const ws = mkWs("md-headings-control");
    write(ws, "NOTES.md", bigMarkdown()); // 3 headings, well under both caps

    const res = await callTool("read_file", { path: "NOTES.md", cwd: ws });
    const body = parse(res);

    const headings = body["headings"] as Array<Record<string, unknown>>;
    expect(headings.map((heading) => heading["text"])).toEqual(["Design Notes", "Overview", "Appendix"]);
    expect(body["headings_truncated"]).toBeUndefined();
    expect(body["headings_total"]).toBeUndefined();
  });
});
