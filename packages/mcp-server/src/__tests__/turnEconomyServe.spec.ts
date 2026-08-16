/**
 * turnEconomyServe.spec.ts — regression tests for the 2026-07-24 turn-economy
 * serve wave (C2/C3/C4). Each fix closes a per-turn cost leak seen in the A/B
 * loss cells:
 *   - C2: a content-serving mode returned an empty payload (a slice whose whole
 *         range was one doc/comment block collapsed to a lone elision marker),
 *         forcing a wasted comments=keep round trip.
 *   - C3: a refusal stranded a re-slice whose handle had expired even though the
 *         caller also supplied a still-serveable (path, range).
 *   - C4: concern pressure kept firing on small_file reads AFTER closure was
 *         certified complete, driving a re-read loop.
 *
 * In-process dispatch via callTool (closureMode.spec.ts / readCodeDocContent.spec.ts
 * pattern) so the exact read_file call shapes are exercised end to end.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { callTool } from "../server.js";
import { resetAll, recordConcernTokens, markClosureSatisfied } from "../util/session.js";
import { buildSmallFileConcernNote } from "../tools/readCodeModes.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const dirs: string[] = [];

function mkWs(tag: string): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(HOME, `.tl-turnserve-${tag}-`)));
  dirs.push(d);
  return d;
}
function write(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}
function parse(res: { content: Array<{ text: string }>; isError?: boolean }): {
  body: Record<string, unknown>;
  isError: boolean;
} {
  const text = res.content[0]?.text ?? "";
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* plain-string error text */
  }
  return { body, isError: res.isError === true };
}

beforeEach(() => {
  resetAll();
});
afterEach(() => {
  resetAll();
  for (const d of dirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ok */
    }
  }
});

// A TS file whose lines 2-7 are ENTIRELY one multi-line C block comment —
// elideDocComments would collapse it to a lone "/* doc elided ... */" marker.
const BLOCK_COMMENT_FILE =
  [
    "export const before = 1;",
    "/*",
    " * This whole slice range is a single multi-line documentation block.",
    " * Under the default comments=elide transform it collapses to one marker,",
    " * which used to ship an empty payload for a slice of exactly these lines.",
    " * C2 makes the serve fall back to this raw text instead of an empty marker.",
    " */",
    "export const after = 2;",
  ].join("\n") + "\n";

// ---------------------------------------------------------------------------
// C2 — content-serving modes never return an empty/marker-only payload.
// ---------------------------------------------------------------------------

describe("C2 — content-serving slice never returns an empty payload", () => {
  it("mode=slice over a fully-elided block comment serves the RAW block + a note, with no comments=keep round trip", async () => {
    const ws = mkWs("c2-slice");
    write(ws, "src/mod.ts", BLOCK_COMMENT_FILE);

    const { body, isError } = parse(
      await callTool("read_file", { mode: "slice", path: "src/mod.ts", range: "2-7", cwd: ws }),
    );

    expect(isError).toBe(false);
    // Rule K: the top-level `mode` echo is deleted; `kind` is the sole
    // discriminator (A.5.2).
    expect(body["kind"]).toBe("read.text");
    const evidence = body["evidence"] as Array<Record<string, unknown>>;
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.["range"]).toBe("2-7");

    // A.2.7: per-window text moved from top-level `content` onto `evidence[].body`.
    const content = String(evidence[0]?.["body"] ?? "");
    // Non-empty, RAW block content — NOT a lone "/* doc elided */" marker.
    expect(content.length).toBeGreaterThan(0);
    expect(content).toContain("documentation block");
    expect(content).not.toMatch(/^\/\* doc elided/);

    // Carries an explanatory note (elision would have removed all content)...
    expect(typeof body["note"]).toBe("string");
    expect(String(body["note"])).toContain("comments kept");
    // ...and never manufactures a comments=keep re-slice — the content is served.
    expect(body["next"]).toBeUndefined();
  });

  it("handles[] batch: an all-comment item serves RAW content + a note, not a lone marker", async () => {
    const ws = mkWs("c2-batch");
    write(ws, "src/mod.ts", BLOCK_COMMENT_FILE);

    // A first slice over the block mints a range handle to feed the batch path.
    const first = parse(
      await callTool("read_file", { mode: "slice", path: "src/mod.ts", range: "2-7", cwd: ws }),
    );
    const firstEvidence = first.body["evidence"] as Array<Record<string, unknown>> | undefined;
    const handle = String(firstEvidence?.[0]?.["handle"]);
    expect(handle).toMatch(/^h[0-9a-z]+$/);

    const { body } = parse(await callTool("read_file", { handles: [handle], cwd: ws }));
    // Rule K: the top-level `mode` echo is deleted; `kind` is the sole
    // discriminator. `handles[]` batch reads are always `read.batch` (A.5.4),
    // declared outright by the dispatcher independent of `mode`.
    expect(body["kind"]).toBe("read.batch");
    const items = (body["entries"] ?? []) as Array<Record<string, unknown>>;
    expect(items.length).toBe(1);
    // A.5.4's "handle" BatchEntry form keeps `content` under its own name
    // (unlike read.text's Evidence.body) — no rename here.
    const itemContent = String(items[0]?.["content"] ?? "");
    expect(itemContent.length).toBeGreaterThan(0);
    expect(itemContent).toContain("documentation block");
    expect(itemContent).not.toMatch(/^\/\* doc elided/);
    // `note` is carrier-less on this BatchEntry form (A.5.4 lists it only on
    // the "file-downgraded" variant, not "handle") — the substantive fact this
    // pinned (raw content served, not a lone elision marker) is already
    // proven by the two assertions above; no v1 successor to point at here.
  });

  it("a partially-elided slice (comment + real code) is still served elided (unchanged behavior)", async () => {
    const ws = mkWs("c2-partial");
    write(ws, "src/mod.ts", BLOCK_COMMENT_FILE);

    // Lines 2-8 include the block comment AND `export const after = 2;` — real
    // code remains after the marker, so the elided serve is non-empty and needs
    // no raw fallback.
    const { body } = parse(
      await callTool("read_file", { mode: "slice", path: "src/mod.ts", range: "2-8", cwd: ws }),
    );
    const evidence = body["evidence"] as Array<Record<string, unknown>>;
    const content = String(evidence[0]?.["body"] ?? "");
    expect(content).toContain("export const after = 2;");
    expect(content).toContain("doc elided"); // the comment block WAS elided
  });
});

// ---------------------------------------------------------------------------
// C3 — every refusal carries a redirect; a recoverable stale handle self-heals.
// ---------------------------------------------------------------------------

describe("C3 — stale handle self-heals when the path is recoverable", () => {
  const STALE = "h999999"; // never minted in this fresh session

  it("stale handle + path + range serves the requested slice directly, with a note", async () => {
    const ws = mkWs("c3-selfheal");
    write(ws, "src/enums.ts", "export type Priority = 'LOW' | 'HIGH';\nexport const A = 1;\nexport const B = 2;\n");

    const { body, isError } = parse(
      await callTool("read_file", {
        mode: "slice",
        handle: STALE,
        path: "src/enums.ts",
        range: "1-2",
        cwd: ws,
      }),
    );

    // Self-healed: served, NOT refused.
    expect(isError).toBe(false);
    expect(body["kind"]).toBe("read.text");
    const evidence = body["evidence"] as Array<Record<string, unknown>>;
    expect(evidence[0]?.["range"]).toBe("1-2");
    expect(String(evidence[0]?.["body"] ?? "")).toContain("Priority");
    // Fresh handle minted for the served range, and a note about the stale one.
    expect(String(evidence[0]?.["handle"])).toMatch(/^h[0-9a-z]+$/);
    expect(String(body["note"] ?? "")).toContain("no longer live");
  });

  it("stale handle + path with NO mode still self-heals a range re-slice", async () => {
    const ws = mkWs("c3-selfheal-auto");
    write(ws, "src/enums.ts", "export const A = 1;\nexport const B = 2;\nexport const C = 3;\n");

    // handle + explicit range + mode omitted is an unambiguous slice request.
    const { body, isError } = parse(
      await callTool("read_file", { handle: STALE, path: "src/enums.ts", range: "2-3", cwd: ws }),
    );
    expect(isError).toBe(false);
    expect(body["kind"]).toBe("read.text");
    const evidence = body["evidence"] as Array<Record<string, unknown>>;
    expect(String(evidence[0]?.["body"] ?? "")).toContain("export const B = 2;");
  });

  it("stale handle with NO recoverable path still refuses BUT carries a redirect", async () => {
    const ws = mkWs("c3-norecover");
    const res = await callTool("read_file", { mode: "slice", handle: STALE, cwd: ws });
    const { body, isError } = parse(res);
    expect(isError).toBe(true);
    // Never a dead end: the refusal carries an actionable alternative/next.
    const hasRedirect =
      body["next"] !== undefined ||
      body["next_call"] !== undefined ||
      (Array.isArray(body["alternatives"]) && (body["alternatives"] as unknown[]).length > 0);
    expect(hasRedirect).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C4 — post-closure quiescence: the small_file concern note stops firing once
// closure is certified complete (mirrors buildConcernNote's existing gate).
// ---------------------------------------------------------------------------

describe("C4 — buildSmallFileConcernNote suppressed after closure is satisfied", () => {
  // No file I/O: buildSmallFileConcernNote takes content/outline directly and
  // keys its session state on the workspace string.
  const CONTENT = "export const telemetrybudget = compute();\nexport const other = 1;\n";
  const OUTLINE = ""; // defer serve shows no outline, so the token is "hidden"

  it("fires BEFORE closure — the token hits content but not the outline", () => {
    const ws = mkWs("c4-before");
    recordConcernTokens(ws, ["telemetrybudget"]);
    const note = buildSmallFileConcernNote(ws, "src/a.ts", CONTENT, OUTLINE);
    expect(typeof note).toBe("string");
    expect(String(note)).toContain("telemetrybudget");
  });

  it("is SUPPRESSED after markClosureSatisfied — no new discovery pressure post-closure", () => {
    const ws = mkWs("c4-after");
    recordConcernTokens(ws, ["telemetrybudget"]);
    markClosureSatisfied(ws);
    const note = buildSmallFileConcernNote(ws, "src/a.ts", CONTENT, OUTLINE);
    expect(note).toBeUndefined();
  });
});
