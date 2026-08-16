import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildTaskPack,
  isArtifactTaskPackSurface,
  resetPackDedupeCache,
  resetRoleInventoryCache,
  type TaskPackResultSurface,
} from "../tools/readCodeTaskPack.js";
import { locateTaskContext, resetRootResolverCache } from "../features/locator/locateTaskContext.js";
import { resetTokenlightenIgnoreCache } from "../tools/walkRepo.js";
import { handleTable } from "../util/handles.js";
import { resetAll as resetAllSessions } from "../util/session.js";

const roots: string[] = [];

function workspace(tag: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `tl-decoy-${tag}-`)));
  roots.push(root);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: tag, type: "module" }) + "\n");
  return root;
}

function write(root: string, rel: string, content: string): void {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function resetState(): void {
  handleTable.reset();
  resetAllSessions();
  resetPackDedupeCache();
  resetRoleInventoryCache();
  resetRootResolverCache();
  resetTokenlightenIgnoreCache();
}

beforeEach(resetState);
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// Every path a locate() result exposes, whether it returned a confident hit
// (primary + related) or an abstain (candidates + candidateDetails) — same
// pooling shape locateTaskContext.spec.ts's sibling exact-text test uses.
function locatedPaths(result: Awaited<ReturnType<typeof locateTaskContext>>): Set<string> {
  const pool = new Set<string>();
  if (result.hit) {
    for (const c of result.primary) pool.add(c.path);
    for (const c of result.related) pool.add(c.path);
  } else {
    for (const c of result.candidates ?? []) pool.add(c.path);
    for (const c of result.candidateDetails ?? []) pool.add(c.path);
  }
  return pool;
}

function topLocatedPath(result: Awaited<ReturnType<typeof locateTaskContext>>): string | undefined {
  return result.hit ? result.primary[0]?.path : result.candidateDetails?.[0]?.path;
}

describe("decoy demotion — 残Stage2 2026-08-01 regression", () => {
  // 2026-08-01: a plain code query used to pull a same-workspace data file
  // into the task_pack as a surface whenever the query's words happened to
  // appear in that file's content (here, a microbench CSV literally quoting
  // the question). mayNameCallerArtifact now gates the dedupeTrimAndPersist
  // artifact bulk-append on the CALLER naming an artifact, not on incidental
  // keyword overlap.
  it("does not surface a CSV decoy for a plain code query", async () => {
    const root = workspace("csv-decoy");
    write(root, "src/skeletonBuilder.ts", [
      "// enforces the skeleton byte cap",
      "export function enforceSkeletonByteCap(bytes: number, cap: number): boolean {",
      "  return bytes <= cap;",
      "}",
      "",
    ].join("\n"));
    write(root, "data/skeleton-metrics.csv", [
      "skeleton byte cap enforced",
      "true,4096",
      "",
    ].join("\n"));

    const result = await buildTaskPack({ query: "where is the skeleton byte cap enforced?" }, root);

    expect(result.surfaces.some((surface) => surface.path.endsWith(".csv"))).toBe(false);
    expect(result.surfaces[0]?.path).toBe("src/skeletonBuilder.ts");
  });

  // 2026-08-01: the gate above must not screen out a GENUINE artifact
  // request — a query that names the file's extension in text (".csv") still
  // resolves to a caller-named artifact surface exactly as before the fix.
  it("still surfaces a caller-named CSV artifact in the same workspace shape", async () => {
    const root = workspace("csv-named");
    write(root, "src/skeletonBuilder.ts", [
      "// enforces the skeleton byte cap",
      "export function enforceSkeletonByteCap(bytes: number, cap: number): boolean {",
      "  return bytes <= cap;",
      "}",
      "",
    ].join("\n"));
    write(root, "data/skeleton-metrics.csv", [
      "skeleton byte cap enforced",
      "true,4096",
      "",
    ].join("\n"));

    const result = await buildTaskPack({ query: "skeleton-metrics.csv の内容を確認" }, root);

    const surfaces = result.surfaces as TaskPackResultSurface[];
    const artifact = surfaces.find(isArtifactTaskPackSurface);
    expect(artifact).toBeDefined();
    expect(artifact?.path).toBe("data/skeleton-metrics.csv");
  });

  // 2026-08-01: a __tests__ file that merely quotes the query back verbatim
  // (a common decoy shape: the test description restates the bug report)
  // must not outrank the real implementation. Exercises the
  // TEST_DIR_SEGMENT_RE -0.3 applyPenalties demotion.
  it("ranks the real implementation above a __tests__ decoy that quotes the query", async () => {
    const root = workspace("test-dir-decoy");
    write(root, "src/pricing.ts", [
      "export function applyDiscount(subtotal: number, rate: number): number {",
      "  return subtotal - subtotal * rate;",
      "}",
      "",
    ].join("\n"));
    write(root, "__tests__/pricing.test.ts", [
      "import { describe, it, expect } from \"vitest\";",
      "describe(\"pricing\", () => {",
      "  it(\"apply the discount to the order subtotal\", () => {",
      "    expect(true).toBe(true);",
      "  });",
      "});",
      "",
    ].join("\n"));

    const result = await locateTaskContext(root, {
      action: "locate",
      query: "applyDiscount apply the discount to the order subtotal",
    });

    expect(topLocatedPath(result)).toBe("src/pricing.ts");
  });

  // 2026-08-01: a comment that merely mentions a symbol's name must not
  // outrank the symbol's own definition — exact-symbol (2.0) always scores
  // above exact-text (1.2), independent of any decoy-path penalty.
  it("ranks the symbol definition above a comment-only decoy mention", async () => {
    const root = workspace("comment-decoy");
    write(root, "src/real.ts", [
      "export function rotateWidgetPhase(current: number): number {",
      "  return (current + 1) % 4;",
      "}",
      "",
    ].join("\n"));
    write(root, "src/decoy.ts", "// rotateWidgetPhase is documented here for onboarding\n");

    const result = await locateTaskContext(root, { action: "locate", query: "rotateWidgetPhase" });

    expect(topLocatedPath(result)).toBe("src/real.ts");
  });

  describe("data-extension penalty exemption", () => {
    function setupBuildReportFixture(): string {
      const root = workspace("data-ext-exempt");
      write(root, "src/buildReport.ts", [
        "export function buildReport(rows: string[]): string {",
        "  return rows.join(\"\\n\");",
        "}",
        "",
      ].join("\n"));
      write(root, "logs/build-report.log", [
        "buildReport run 1: ok",
        "buildReport run 2: ok",
        "",
      ].join("\n"));
      return root;
    }

    // 2026-08-01: a data-file sibling must never outrank the real
    // implementation for a plain code query. Enforced structurally — every
    // locate walk layer is source-ext only, so data files are not candidates.
    it("ranks the .ts implementation first for a plain code query", async () => {
      const root = setupBuildReportFixture();
      const result = await locateTaskContext(root, { action: "locate", query: "buildReport implementation" });
      expect(topLocatedPath(result)).toBe("src/buildReport.ts");
    });

    // 2026-08-01: an artifact-intent-flavored query must not destabilize the
    // result — the real implementation still wins outright. A data-extension
    // rank penalty (with an artifact-intent exemption) was written for this
    // case and REMOVED the same day as unreachable dead code: no locate walk
    // layer admits a "log"/"jsonl"/"ndjson" path as a candidate at all
    // (confirmed by probing — even an explicit `path=` scope pointed straight
    // at the .log file returns reason "not-found"), and "csv"/"tsv" are
    // reachable only via the caller-named-artifact path exercised above.
    // This test pins that walk-level safe-by-omission behavior; if a future
    // walk change admits data files, it fails and the rank question reopens.
    it("still resolves the real implementation when the query signals artifact intent", async () => {
      const root = setupBuildReportFixture();
      const result = await locateTaskContext(root, {
        action: "locate",
        query: "buildReport dataset csv export",
        limit: 10,
      });
      expect(topLocatedPath(result)).toBe("src/buildReport.ts");
      expect(locatedPaths(result).has("logs/build-report.log")).toBe(false);
    });
  });
});
