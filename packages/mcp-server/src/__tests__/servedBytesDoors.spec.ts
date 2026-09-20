import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * BLOCKERs 52/53 (review round 10) — THE GUARD THAT MAKES A SEVENTH DOOR
 * IMPOSSIBLE TO ADD SILENTLY.
 *
 * Rounds 5 through 10 each closed "two doors disagree about the same file" at
 * ONE door, and the next round found the next door. Round 10 found two more by
 * hand: the CANONICAL `content:"outline"` batch (`server.ts`'s `mode:"skeleton"`
 * batch, reached through an internal rewrite that sits downstream of the
 * legacy-input gate) and the `targets:[{handle},{handle}]` batch — each serving
 * exactly the bytes the single-target form of the same request refuses, one of
 * them under a `sha` and a handle claiming those bytes are pinned. Neither was
 * in AA1's 16-door inventory, because an inventory is a snapshot and a codebase
 * is not.
 *
 * This spec replaces the inventory with a MECHANICAL RULE. It greps the
 * wire-serving modules for every primitive that can turn file bytes into a
 * string, and fails unless each hit carries one of exactly two annotations on
 * its own line or the line above it:
 *
 *   `// served-bytes: readServedText`        — these bytes can reach the wire,
 *                                             and they go through the ONE policy
 *                                             (`util/textDecode.ts`), directly or
 *                                             via `readServedTextSafe` /
 *                                             `servedTextOrUndefined` /
 *                                             `server.ts::servedTextForRoute`.
 *   `// served-bytes: not-served (<why>)`    — these bytes cannot reach the wire,
 *                                             and the parenthesised reason says
 *                                             why (a sha, a count, a write input,
 *                                             a container another extractor owns).
 *
 * A new call site fails this spec until its author has decided which it is. That
 * is the whole point: the failure is the question "does this reach the wire?",
 * asked at the moment the door is built rather than five review rounds later.
 *
 * Deliberately NOT a semantic check — it cannot be one. It is a forcing
 * function on the author, and the reasons it collects are what a reviewer reads
 * instead of re-deriving the inventory by hand.
 */

const SRC = path.resolve(__dirname, "..");

/**
 * The modules whose output can become a `read_file` / `search_files` /
 * `edit_file` response body. A module added here inherits the rule; a module
 * NOT here is out of scope for this guard and must not read file bytes for the
 * wire (the three tool dispatchers all live in this list).
 */
const WIRE_SERVING_MODULES = [
  "server.ts",
  "features/task-pack/readCodeTaskPack.ts",
  "features/task-pack/evidenceResolution.ts",
  "tools/readCodeSmallFile.ts",
  "tools/readCodePack.ts",
  "protocol/envelope.ts",
  "protocol/readFamily.ts",
  "protocol/emit.ts",
  "state/readRequestStore.ts",
  "state/stateStore.ts",
] as const;

/**
 * Every primitive that can turn bytes on disk into a string this process could
 * put on a wire. `readServedText` / `servedTextOrUndefined` /
 * `readServedTextSafe` / `servedTextForRoute` are IN the list on purpose: a
 * policy call is still a door, and annotating it records that the door exists
 * and is gated, which is what makes the inventory auditable from the source.
 */
const READ_PRIMITIVES = [
  "readFileSafe",
  "readFileSafeOpt",
  "readBytesSafe",
  "readFileSync",
  "readServedTextSafe",
  "readServedText",
  "servedTextOrUndefined",
  "servedTextForRoute",
  "decodeTextBuffer",
  "decodeTextBufferLenient",
  "fs.readFile",
  // NOTE 73 (AC1, 2026-09-14, review round 12): round 11's M7 mutation showed
  // the BUFFER form of the promise API (`fs.promises.readFile(abs)`, no
  // encoding argument) was invisible here — only its `"utf8"` form was caught,
  // and only by test #5. `\.readFile\b` also covers an aliased handle
  // (`const { readFile } = fs.promises; readFile(abs)` reads as `readFile(`
  // via the bare entry above once the alias is called). Costs nothing: no
  // module in the list calls either shape today.
  "fs.promises.readFile",
  ".readFile",
] as const;

const PRIMITIVE_RE = new RegExp(
  `(?:${READ_PRIMITIVES.map((name) => name.replace(/\./g, "\\.")).join("|")})\\s*\\(`,
);

const SERVED_TAG = "// served-bytes: readServedText";
const NOT_SERVED_RE = /\/\/ served-bytes: not-served \([^)]+\)/;

interface Hit {
  readonly module: string;
  readonly line: number;
  readonly text: string;
  readonly annotated: boolean;
  readonly kind: "served" | "not-served" | "none";
}

function isCommentOrTypeOnly(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return true;
  // A function DECLARATION or an import is not a call site.
  if (/^(?:export\s+)?(?:async\s+)?function\s/.test(trimmed)) return true;
  if (/^import\s|^\}\s*from\s/.test(trimmed)) return true;
  // A type position (`readFileSafe: (relPath: string) => Promise<...>`).
  if (/^\w+:\s*\(/.test(trimmed)) return true;
  return false;
}

/**
 * SHOULD-FIX 66 (AC1, 2026-09-14, review round 12) — THE ANNOTATION WINDOW ENDS
 * AT THE FIRST NON-COMMENT LINE.
 *
 * Round 11 mutated a scratchpad copy of the ten modules and found the one hole
 * the guard did not disclose (M4): a NEW, UNANNOTATED
 * `await readFileSafe(requestedPath, workspace)` inserted IMMEDIATELY BELOW an
 * annotated call inherited its neighbour's tag, and all six tests passed. The
 * same line two rows down (M4b) correctly failed. Adding a second read inside an
 * already-gated route is the likeliest way the next door gets added, and it is
 * exactly the shape this guard exists to catch.
 *
 * An annotation is a COMMENT that precedes its call, so the window walks up only
 * while the lines above are comments — a preceding STATEMENT ends it. Every real
 * annotation in the tree today sits on a comment line directly above its call
 * (or on the call line itself), so the 45-site floor is unaffected.
 */
function annotationWindow(lines: readonly string[], index: number): string {
  const isComment = (line: string | undefined): boolean =>
    line !== undefined && /^\s*(?:\/\/|\*|\/\*)/.test(line);
  const parts: string[] = [lines[index] ?? ""];
  for (let above = index - 1; above >= 0 && isComment(lines[above]); above -= 1) {
    parts.push(lines[above]!);
    // Two comment lines above is the documented reach (a tag on its own line
    // under a one-line lead-in); walking further would re-open the bleed in a
    // wider form.
    if (parts.length >= 3) break;
  }
  return parts.join("\n");
}

function collectHits(): Hit[] {
  const hits: Hit[] = [];
  for (const module of WIRE_SERVING_MODULES) {
    const abs = path.join(SRC, module);
    const lines = fs.readFileSync(abs, "utf8").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const text = lines[index]!;
      if (isCommentOrTypeOnly(text)) continue;
      if (!PRIMITIVE_RE.test(text)) continue;
      const window = annotationWindow(lines, index);
      const served = window.includes(SERVED_TAG);
      const notServed = NOT_SERVED_RE.test(window);
      hits.push({
        module,
        line: index + 1,
        text: text.trim(),
        annotated: served || notServed,
        kind: served ? "served" : notServed ? "not-served" : "none",
      });
    }
  }
  return hits;
}

describe("served-bytes doors — every byte-read primitive in a wire-serving module is classified", () => {
  it("finds the doors at all (the guard is not silently matching nothing)", () => {
    const hits = collectHits();
    // The count is deliberately a FLOOR, not a pin: adding a door must fail the
    // annotation assertion below, never this one.
    expect(hits.length).toBeGreaterThanOrEqual(45);
    expect(new Set(hits.map((hit) => hit.module)).size).toBeGreaterThanOrEqual(4);
  });

  it("every hit carries `// served-bytes: readServedText` or `// served-bytes: not-served (<why>)`", () => {
    const unclassified = collectHits().filter((hit) => !hit.annotated);
    expect(
      unclassified.map((hit) => `${hit.module}:${hit.line}  ${hit.text}`),
      "A new byte-read call site in a wire-serving module must declare whether its"
      + " bytes can reach the wire. Add `// served-bytes: readServedText` (and route"
      + " it through util/textDecode.ts — in server.ts that means servedTextForRoute)"
      + " or `// served-bytes: not-served (<why>)` on the call line or the line above"
      + " it. Unclassified:",
    ).toEqual([]);
  });

  it("a `not-served` annotation always states a reason", () => {
    const bad: string[] = [];
    for (const module of WIRE_SERVING_MODULES) {
      const lines = fs.readFileSync(path.join(SRC, module), "utf8").split("\n");
      lines.forEach((line, index) => {
        if (!line.includes("served-bytes: not-served")) return;
        if (!NOT_SERVED_RE.test(line)) bad.push(`${module}:${index + 1}  ${line.trim()}`);
      });
    }
    expect(bad, "`not-served` must carry a parenthesised reason").toEqual([]);
  });

  it("server.ts obtains served text ONLY through servedTextForRoute (BLOCKERs 52/53's root cause)", () => {
    const lines = fs.readFileSync(path.join(SRC, "server.ts"), "utf8").split("\n");
    const offenders: string[] = [];
    lines.forEach((line, index) => {
      if (isCommentOrTypeOnly(line)) return;
      if (!/\breadServedTextSafe\s*\(/.test(line)) return;
      // The funnel's own body is the one sanctioned caller.
      if (line.includes("const verdict = await readServedTextSafe(rel, workspace)")) return;
      offenders.push(`server.ts:${index + 1}  ${line.trim()}`);
    });
    expect(
      offenders,
      "Call servedTextForRoute(rel, workspace), not readServedTextSafe directly:"
      + " the funnel is what publishes a `stripped` serve so the response STATES it"
      + " (SHOULD-FIX 57). Offenders:",
    ).toEqual([]);
  });

  it("no wire-serving module reintroduces a raw utf8 whole-file read for a body", () => {
    const offenders: string[] = [];
    for (const module of WIRE_SERVING_MODULES) {
      const lines = fs.readFileSync(path.join(SRC, module), "utf8").split("\n");
      lines.forEach((line, index) => {
        if (isCommentOrTypeOnly(line)) return;
        // `readFileSync(x, "utf8")` / `fs.readFile(x, "utf8")` bypass every
        // BOM and encoding question by construction. Allowed only where the
        // annotation says the bytes are not served.
        if (!/read(?:File|FileSync)\s*\([^)]*["']utf-?8["']/.test(line)) return;
        // SHOULD-FIX 66 (AC1, round 12): the same comment-bounded window, so
        // this test cannot inherit a neighbour's annotation either.
        const window = annotationWindow(lines, index);
        if (NOT_SERVED_RE.test(window)) return;
        offenders.push(`${module}:${index + 1}  ${line.trim()}`);
      });
    }
    expect(
      offenders,
      "A raw utf8 whole-file read cannot produce a served body: route it through"
      + " util/textDecode.ts, or annotate why these bytes never reach the wire.",
    ).toEqual([]);
  });

  it("the two BLOCKER routes go through the funnel, with the tag in their own comment block", () => {
    const lines = fs.readFileSync(path.join(SRC, "server.ts"), "utf8").split("\n");
    const gated = (needle: string): boolean => {
      const index = lines.findIndex((line) => line.includes(needle));
      expect(index, `call site not found: ${needle}`).toBeGreaterThan(-1);
      // The tag must sit in THIS call's own preceding comment block, not
      // somewhere else in a 20k-line file.
      return lines.slice(Math.max(0, index - 25), index + 1).some((line) => line.includes(SERVED_TAG));
    };
    // BLOCKER 52: the canonical content:"outline" batch (mode=skeleton + paths[]).
    expect(gated("const skelVerdict = await servedTextForRoute(requestedPath, workspace);")).toBe(true);
    // BLOCKER 53: the handles batch.
    expect(gated("hVerdict = await servedTextForRoute(hPath, workspace);")).toBe(true);
    // The two doors round 10 did NOT name, found by this wave's own enumeration.
    expect(gated("const servedBack = servedTextOrUndefined(path.join(workspace, f.path));")).toBe(true);
    expect(gated("const cursorVerdict = await servedTextForRoute(target.path, workspace);")).toBe(true);
  });
});

/**
 * SHOULD-FIX 66 (AC1, 2026-09-14, review round 12) — the M4 pin.
 *
 * Round 11 simulated the guard on a scratchpad COPY of the ten modules and
 * mutated it. This block pins the same property against `annotationWindow`
 * directly, so the hole cannot be reopened by a helper edit and the regression
 * needs no copy of the source tree to reproduce.
 */
describe("served-bytes doors — the annotation window (M4)", () => {
  const served = "  // served-bytes: readServedText";
  const call = "  const a = await servedTextForRoute(p, w);";
  const newDoor = "  const rv11Bleed = await readFileSafe(requestedPath, workspace);";

  it("M4: an unannotated read ONE line below an annotated call does NOT inherit the tag", () => {
    const lines = [served, call, newDoor];
    expect(annotationWindow(lines, 1)).toContain(SERVED_TAG);       // the annotated call
    expect(annotationWindow(lines, 2)).not.toContain(SERVED_TAG);   // the new door
  });

  it("M4b: two lines below is equally uncovered (round 11's own control)", () => {
    const lines = [served, call, "  doSomethingElse();", newDoor];
    expect(annotationWindow(lines, 3)).not.toContain(SERVED_TAG);
  });

  it("the SANCTIONED shapes still resolve: tag on the call line, directly above, or under a one-line lead-in", () => {
    expect(annotationWindow([`${newDoor} ${SERVED_TAG}`], 0)).toContain(SERVED_TAG);
    expect(annotationWindow([served, newDoor], 1)).toContain(SERVED_TAG);
    expect(annotationWindow(["  // why this read exists", served, newDoor], 2)).toContain(SERVED_TAG);
    // A block-comment line counts as a comment, like the real annotations do.
    expect(annotationWindow([" * lead-in", served, newDoor], 2)).toContain(SERVED_TAG);
  });

  it("a blank line between the tag and the call ENDS the window (a blank line is not a comment)", () => {
    expect(annotationWindow([served, "", newDoor], 2)).not.toContain(SERVED_TAG);
  });
});
