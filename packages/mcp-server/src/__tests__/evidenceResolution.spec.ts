// evidenceResolution.spec.ts — P1 evidence completion (D7), resolver unit tests.
//
// Spec: scratchpad/spec-p1-shadow.md §8.1. Written RED before the resolver
// existed. The resolver answers, per concern anchor, "what says this is a bug"
// in three provenance-labeled CLASSES with NO fixed ranking:
//   behavioral            — a test assert referencing the anchor's symbols
//   normative.prose       — a doc SECTION whose HEADING matches an anchor
//   normative.declaration — the declaring header of a symbol the fault site calls
//   runtime-observation   — descoped this wave (Q5); must report itself skipped
//
// Two rules are absolute and are tested as such (§6.1): the resolver may never
// call findReferences (it re-walks + tree-sitter-parses the whole repo with no
// cache — the 74.1s incident shape) and may never trigger an index build.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "node:url";

import {
  resolveEvidence,
  EVIDENCE_DEFAULT_CAPS,
  type ConcernAnchors,
} from "../features/task-pack/evidenceResolution.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function mkWs(tag: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `tl-evres-${tag}-`)));
  tmpDirs.push(dir);
  return dir;
}

function write(ws: string, rel: string, content: string): void {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

/** The minimal shape the resolver needs from a pack: one concern, one fault site. */
function anchors(over: Partial<ConcernAnchors> = {}): ConcernAnchors {
  return {
    id: "c1",
    tokens: ["frob"],
    symbols: ["frob"],
    callees: [],
    surfacePaths: ["src/widget.ts"],
    ...over,
  };
}

const CLASSES = ["behavioral", "normative", "runtime-observation"] as const;

describe("evidenceResolution — behavioral class", () => {
  it("1: a test file asserting on the anchor symbol resolves one behavioral slice", () => {
    const ws = mkWs("beh");
    write(ws, "src/widget.ts", "export function frob(n: number) {\n  return n + 1;\n}\n");
    write(ws, "test/widget.test.ts",
      "import { frob } from '../src/widget';\n\n" +
      "it('frobs', () => {\n  expect(frob(1)).toBe(2);\n});\n");

    const out = resolveEvidence({ workspace: ws, concerns: [anchors()] });
    const beh = out.concerns[0]!.resolved.filter((r) => r.class === "behavioral");
    expect(beh.length, JSON.stringify(out.concerns[0], null, 1)).toBe(1);
    expect(beh[0]!.path).toBe("test/widget.test.ts");
    expect(beh[0]!.why).toBe("assert-window:frob");
    expect(beh[0]!.matched).toEqual(["frob"]);
    expect(beh[0]!.text).toContain("expect(frob(1)).toBe(2)");
  });

  it("1b: a CALLEE anchor also resolves behavioral evidence (whole-file surfaces carry no symbol)", () => {
    // The live fix-pack shape: the concern's surface is a whole file with no
    // `symbol`, so its only symbol anchor is the basename — and an assert never
    // names a filename. The identifiers the fault site calls must anchor too.
    const ws = mkWs("callee-beh");
    write(ws, "src/mixer.ts", "export function mixQuadX(yaw: number) {\n  return +yaw;\n}\n");
    write(ws, "test/mixer.test.ts",
      "it('mixes', () => {\n  expect(mixQuadX(1)).toBe(-1);\n});\n");

    const out = resolveEvidence({
      workspace: ws,
      concerns: [anchors({
        tokens: ["mixquadx"], symbols: ["mixer.ts"],
        callees: ["mixQuadX"], surfacePaths: ["src/mixer.ts"],
      })],
    });
    const beh = out.concerns[0]!.resolved.filter((r) => r.class === "behavioral");
    expect(beh.length, JSON.stringify(out.concerns[0], null, 1)).toBe(1);
    expect(beh[0]!.why).toBe("assert-window:mixQuadX");
    expect(beh[0]!.text).toContain("expect(mixQuadX(1)).toBe(-1)");
  });

  it("2: a path matching /\\btest/ but NOT the structural isTestPath is not behavioral", () => {
    // Pins searchIndex.ts isTestPath over impact.ts classifySurface, whose
    // `\btest` catch-all would sweep in testbed/, latest/, … and inflate the
    // class with noise (spec §6.2).
    const ws = mkWs("testbed");
    write(ws, "src/widget.ts", "export function frob(n: number) {\n  return n + 1;\n}\n");
    write(ws, "src/testbed/widget.ts",
      "// a scratch harness, not a test\nexport const probe = () => expect(frob(1));\n");

    const out = resolveEvidence({ workspace: ws, concerns: [anchors()] });
    expect(out.concerns[0]!.resolved.filter((r) => r.class === "behavioral")).toEqual([]);
  });
});

describe("evidenceResolution — normative.prose class", () => {
  it("3: a doc HEADING matching the anchor resolves the section body", () => {
    const ws = mkWs("prose");
    write(ws, "src/widget.ts", "export function frob(n: number) {\n  return n + 1;\n}\n");
    write(ws, "docs/spec.md",
      "# Spec\n\n## 4.1 Unrelated\n\nNothing here.\n\n" +
      "## 4.2 widget.ts\n\nfrob MUST return n plus one.\n\n" +
      "## 4.3 Also unrelated\n\nNothing.\n");

    const out = resolveEvidence({
      workspace: ws,
      concerns: [anchors({ tokens: ["widget"], symbols: ["widget.ts"] })],
    });
    const prose = out.concerns[0]!.resolved.filter((r) => r.subclass === "prose");
    expect(prose.length, JSON.stringify(out.concerns[0], null, 1)).toBe(1);
    expect(prose[0]!.class).toBe("normative");
    expect(prose[0]!.path).toBe("docs/spec.md");
    expect(prose[0]!.why).toBe("heading-match:widget.ts");
    expect(prose[0]!.text).toContain("frob MUST return n plus one");
    // The section body only — not the neighbours.
    expect(prose[0]!.text).not.toContain("Also unrelated");
  });

  it("3a: a heading naming the module WITHOUT its extension still matches (containment ratio)", () => {
    // "## 8 Limiter" is the common doc style and must not be a recall miss,
    // but it goes through the ratio rather than the filename shortcut: a
    // heading that is MOSTLY the anchor scores; a passing mention does not.
    const ws = mkWs("stem");
    write(ws, "src/limiter.ts", "export function clampIntegral(v: number) {\n  return v;\n}\n");
    write(ws, "docs/spec.md",
      "# S\n\n## 8 Limiter\n\nclampIntegral MUST bound the integral term.\n");

    const out = resolveEvidence({
      workspace: ws,
      concerns: [anchors({
        tokens: ["clampintegral"], symbols: ["limiter.ts", "limiter"],
        surfacePaths: ["src/limiter.ts"],
      })],
    });
    const prose = out.concerns[0]!.resolved.filter((r) => r.subclass === "prose");
    expect(prose.length, JSON.stringify(out.concerns[0], null, 1)).toBe(1);
    expect(prose[0]!.text).toContain("clampIntegral MUST bound");
  });

  it("3d: a bare stem merely MENTIONED inside a long heading does not match", () => {
    const ws = mkWs("stem-neg");
    write(ws, "src/limiter.ts", "export function clampIntegral(v: number) {\n  return v;\n}\n");
    write(ws, "docs/spec.md",
      "# S\n\n## Appendix C: deployment notes for the limiter and everything else\n\nText.\n");

    const out = resolveEvidence({
      workspace: ws,
      concerns: [anchors({
        tokens: ["clampintegral"], symbols: ["limiter.ts", "limiter"],
        surfacePaths: ["src/limiter.ts"],
      })],
    });
    expect(out.concerns[0]!.resolved.filter((r) => r.subclass === "prose")).toEqual([]);
  });

  it("3b: a doc whose BODY mentions the anchor but whose HEADINGS do not resolves nothing", () => {
    // Proves heading-scoped matching. A full-text scan is both slower and
    // wildly imprecise — nearly every doc mentions nearly every identifier.
    const ws = mkWs("prose-neg");
    write(ws, "src/widget.ts", "export function frob(n: number) {\n  return n + 1;\n}\n");
    write(ws, "docs/spec.md",
      "# Spec\n\n## Overview\n\nSomewhere in here we mention frob and widget.ts in prose.\n");

    const out = resolveEvidence({
      workspace: ws,
      concerns: [anchors({ tokens: ["widget"], symbols: ["widget.ts"] })],
    });
    expect(out.concerns[0]!.resolved.filter((r) => r.subclass === "prose")).toEqual([]);
  });

  it("3c: THE never-empty trap — a non-matching doc must yield ZERO prose evidence", () => {
    // similarHeadingTexts is documented as never empty: it falls back to the
    // document's leading top-level headings when nothing scores. That is right
    // for a human recovery hint and WRONG here — accepting the fallback would
    // manufacture irrelevant normative evidence on every single pack, which is
    // the most likely way this feature ships looking fine and measuring badly
    // (spec §6.3).
    const ws = mkWs("prose-trap");
    write(ws, "src/widget.ts", "export function frob(n: number) {\n  return n + 1;\n}\n");
    write(ws, "docs/spec.md",
      "# Completely Unrelated Manual\n\n## Networking\n\nText.\n\n## Storage\n\nText.\n");

    const out = resolveEvidence({
      workspace: ws,
      concerns: [anchors({ tokens: ["frob"], symbols: ["frob"] })],
    });
    const prose = out.concerns[0]!.resolved.filter((r) => r.subclass === "prose");
    expect(prose, `manufactured heading evidence: ${JSON.stringify(prose)}`).toEqual([]);
  });
});

describe("evidenceResolution — normative.declaration class", () => {
  it("4: the declaring header of a called symbol resolves to signature + leading doc comment", () => {
    const ws = mkWs("decl");
    write(ws, "lib/acquire.h",
      "#pragma once\n\n" +
      "/**\n * @brief Acquire, blocking up to timeout_ms.\n" +
      " *        HAL_ERR_BUSY if timeout_ms == 0.\n */\n" +
      "int acquire(handle_t h, unsigned timeout_ms);\n");
    write(ws, "src/widget.c",
      "#include \"../lib/acquire.h\"\n\nint frob(handle_t h) {\n  return acquire(h, 0);\n}\n");

    const out = resolveEvidence({
      workspace: ws,
      concerns: [anchors({ callees: ["acquire"], surfacePaths: ["src/widget.c"] })],
    });
    const decl = out.concerns[0]!.resolved.filter((r) => r.subclass === "declaration");
    expect(decl.length, JSON.stringify(out.concerns[0], null, 1)).toBe(1);
    expect(decl[0]!.class).toBe("normative");
    expect(decl[0]!.path).toBe("lib/acquire.h");
    expect(decl[0]!.why).toBe("callee-declaration:acquire");
    expect(decl[0]!.text).toContain("int acquire(handle_t h, unsigned timeout_ms);");
    // The doc comment IS the declared semantics — it must ride along.
    expect(decl[0]!.text).toContain("HAL_ERR_BUSY if timeout_ms == 0");
    // …and only the declaration, not the whole header.
    expect(decl[0]!.text).not.toContain("#pragma once");
  });
});

describe("evidenceResolution — class independence, caps, and cost", () => {
  it("5: with several classes resolving, every class survives and is labeled (NO fixed ranking)", () => {
    const ws = mkWs("norank");
    write(ws, "lib/acquire.h",
      "/** doc */\nint acquire(handle_t h, unsigned timeout_ms);\n");
    write(ws, "src/widget.c",
      "#include \"../lib/acquire.h\"\nint frob(handle_t h) { return acquire(h, 0); }\n");
    write(ws, "test/widget_test.c",
      "void t() {\n  assert(frob(h) == 0);\n}\n");
    write(ws, "docs/spec.md", "# S\n\n## widget.c\n\nfrob MUST not block.\n");

    const out = resolveEvidence({
      workspace: ws,
      concerns: [anchors({
        tokens: ["frob", "widget"], symbols: ["frob", "widget.c"],
        callees: ["acquire"], surfacePaths: ["src/widget.c"],
      })],
    });
    const got = out.concerns[0]!.resolved;
    expect(got.some((r) => r.class === "behavioral"), JSON.stringify(got)).toBe(true);
    expect(got.some((r) => r.subclass === "prose"), JSON.stringify(got)).toBe(true);
    expect(got.some((r) => r.subclass === "declaration"), JSON.stringify(got)).toBe(true);
    // Every slice is class-labeled and carries its own provenance.
    for (const slice of got) {
      expect(CLASSES).toContain(slice.class);
      expect(slice.why.length).toBeGreaterThan(0);
      expect(slice.range).toMatch(/^\d+-\d+$/);
      expect(slice.bytes).toBeGreaterThan(0);
    }
    // Deterministic order for a stable shadow log.
    const again = resolveEvidence({
      workspace: ws,
      concerns: [anchors({
        tokens: ["frob", "widget"], symbols: ["frob", "widget.c"],
        callees: ["acquire"], surfacePaths: ["src/widget.c"],
      })],
    });
    expect(again.concerns[0]!.resolved.map((r) => `${r.class}:${r.path}:${r.range}`))
      .toEqual(got.map((r) => `${r.class}:${r.path}:${r.range}`));
  });

  it("6: over-cap candidates are resolved but only the cap is `selected`", () => {
    const ws = mkWs("caps");
    write(ws, "src/widget.ts", "export function frob() {}\n");
    for (const n of [1, 2, 3, 4, 5]) {
      write(ws, `test/frob${n}.test.ts`, `it('t${n}', () => {\n  expect(frob()).toBe(${n});\n});\n`);
    }
    const out = resolveEvidence({ workspace: ws, concerns: [anchors()] });
    const beh = out.concerns[0]!.resolved.filter((r) => r.class === "behavioral");
    const selected = beh.filter((r) => r.selected);
    expect(beh.length).toBeGreaterThan(EVIDENCE_DEFAULT_CAPS.slicesPerClassPerConcern);
    expect(selected.length).toBe(EVIDENCE_DEFAULT_CAPS.slicesPerClassPerConcern);
    expect(beh.filter((r) => !r.selected).length).toBeGreaterThan(0);
  });

  /** The resolver's own import statements — the surface these rules bind. */
  function resolverImports(): string {
    const src = fs.readFileSync(
      path.resolve(HERE, "..", "features", "task-pack", "evidenceResolution.ts"), "utf8",
    );
    // Import statements only. The prose above them NAMES the forbidden
    // functions (explaining why they are forbidden), so scanning the whole
    // file would fail on its own documentation.
    return (src.match(/^import[\s\S]*?;$/gm) ?? []).join("\n");
  }

  it("7: ZERO findReferences calls — enforced statically on the module's imports", () => {
    // A runtime spy would pass vacuously (the resolver simply never imports
    // it), so the real guard is the import graph. findReferences walks the
    // whole repo with fullRecall + per-file tree-sitter and has no cache.
    const imports = resolverImports();
    expect(imports.length, "no import statements parsed — the guard would be vacuous")
      .toBeGreaterThan(0);
    expect(imports).not.toMatch(/findReferences/);
    expect(imports).not.toMatch(/walkCodeFiles/);
    const out = resolveEvidence({ workspace: mkWs("walks"), concerns: [anchors()] });
    expect(out.cost.references_walks).toBe(0);
  });

  it("8: ZERO index builds — no build entry point is imported, and a cold graph is reported", () => {
    const imports = resolverImports();
    expect(imports).not.toMatch(/loadOrBuildSourceIndex/);
    expect(imports).not.toMatch(/buildSourceIndex/);
    expect(imports).not.toMatch(/writeGraphIfStale|buildTlGraphFromManifest/);
    const ws = mkWs("cold");
    write(ws, "src/widget.ts", "export function frob() {}\n");
    const out = resolveEvidence({
      workspace: ws,
      concerns: [anchors({ callees: ["nowhere_at_all"] })],
    });
    expect(["warm", "cold", "absent"]).toContain(out.cost.graph_index);
    expect(fs.existsSync(path.join(ws, ".tokenlighten"))).toBe(false);
  });

  it("9: the heading memo parses a doc once across concerns and re-parses after a mutation", () => {
    const ws = mkWs("memo");
    write(ws, "src/widget.ts", "export function frob() {}\n");
    write(ws, "docs/spec.md", "# S\n\n## widget.ts\n\nA.\n\n## other.ts\n\nB.\n");

    const two = [
      anchors({ id: "c1", tokens: ["widget"], symbols: ["widget.ts"] }),
      anchors({ id: "c2", tokens: ["other"], symbols: ["other.ts"] }),
    ];
    const out = resolveEvidence({ workspace: ws, concerns: two });
    expect(out.cost.docs_parsed).toBe(1);
    expect(out.cost.docs_memo_hits).toBeGreaterThanOrEqual(1);

    // A mutation invalidates the memo (path + mtime + size key).
    fs.writeFileSync(path.join(ws, "docs/spec.md"),
      "# S\n\n## widget.ts\n\nA changed.\n\n## other.ts\n\nB.\n", "utf8");
    const after = resolveEvidence({ workspace: ws, concerns: two });
    expect(after.cost.docs_parsed).toBe(1);
    const prose = after.concerns[0]!.resolved.find((r) => r.subclass === "prose");
    expect(prose?.text).toContain("A changed");
  });

  it("10: a span the caller already holds is marked already_served and excluded from the byte total", () => {
    const ws = mkWs("held");
    write(ws, "src/widget.ts", "export function frob() {}\n");
    write(ws, "test/widget.test.ts", "it('t', () => {\n  expect(frob()).toBe(1);\n});\n");

    const plain = resolveEvidence({ workspace: ws, concerns: [anchors()] });
    const beh = plain.concerns[0]!.resolved.find((r) => r.class === "behavioral");
    expect(beh, JSON.stringify(plain.concerns[0])).toBeDefined();
    expect(beh!.already_served).toBe(false);
    expect(plain.wouldServe.bytes).toBeGreaterThan(0);

    const held = resolveEvidence({
      workspace: ws,
      concerns: [anchors()],
      servedSpans: (p) => (p === "test/widget.test.ts" ? [[1, 999]] : []),
    });
    const heldBeh = held.concerns[0]!.resolved.find((r) => r.class === "behavioral");
    expect(heldBeh!.already_served).toBe(true);
    expect(held.wouldServe.bytes).toBe(0);
  });

  it("11: NEUTRALITY — machine-generated nonsense identifiers resolve the same structure", () => {
    // D7: fixture vocabulary in server code is an automatic reject. The
    // resolver keys off query-derived anchors only, so a workspace with no
    // real-world words in it must behave identically.
    const ws = mkWs("neutral");
    write(ws, "src/zqx7.ts", "export function vth9() {}\n");
    write(ws, "test/zqx7.test.ts", "it('k', () => {\n  expect(vth9()).toBe(0);\n});\n");
    write(ws, "docs/kpr.md", "# K\n\n## zqx7.ts\n\nvth9 MUST return zero.\n");

    const out = resolveEvidence({
      workspace: ws,
      concerns: [anchors({ tokens: ["vth9", "zqx7"], symbols: ["vth9", "zqx7.ts"], surfacePaths: ["src/zqx7.ts"] })],
    });
    const got = out.concerns[0]!.resolved;
    expect(got.some((r) => r.class === "behavioral"), JSON.stringify(got)).toBe(true);
    expect(got.some((r) => r.subclass === "prose"), JSON.stringify(got)).toBe(true);
  });

  it("11b: runtime-observation is descoped this wave and says so (Q5)", () => {
    const ws = mkWs("q5");
    write(ws, "src/widget.ts", "export function frob() {}\n");
    const out = resolveEvidence({ workspace: ws, concerns: [anchors()] });
    expect(out.concerns[0]!.class_skipped["runtime-observation"]).toBe("not-implemented");
    expect(out.concerns[0]!.resolved.filter((r) => r.class === "runtime-observation")).toEqual([]);
  });

  it("7b: an exhausted budget returns what it has, flags itself, and never throws", () => {
    const ws = mkWs("budget");
    write(ws, "src/widget.ts", "export function frob() {}\n");
    write(ws, "test/widget.test.ts", "it('t', () => {\n  expect(frob()).toBe(1);\n});\n");
    let t = 0;
    const out = resolveEvidence({
      workspace: ws,
      concerns: [anchors()],
      now: () => (t += 10_000), // every checkpoint is past the deadline
    });
    expect(out.cost.budget_exhausted).toBe(true);
    expect(out.concerns[0]!.resolved).toEqual([]);
  });
});
