/**
 * handsOnReportFixtures.ts — synthetic workspace builders for
 * `handsOnReport0141.characterization.spec.ts`, the FAIL-FIRST reproduction
 * harness for the v0.14.1 hands-on report (see
 * `scratchpad/report-items.md`/`hands-on-report.md`, items P1-1..P2-4).
 *
 * The evaluator's own fixture is NOT shipped to us — this rebuilds an
 * equivalent from the report's own description: a small TypeScript
 * workspace with a cache implementation carrying a planted expiry-boundary
 * defect, its unit tests, a config file, and a handful of boundary-sized
 * files (a 123 B one-string file, a 30-line file, a 500-line/~37,500 B
 * file, and a 189-line/8,276 B commented file). No Redis anywhere — P1-2
 * deliberately asks about a topic that does not exist in this workspace.
 *
 * Every builder writes plain files via `node:fs` into a fresh `mkdtemp`
 * directory under `os.tmpdir()` (realpath'd), per this task's brief. Unlike
 * `explorationContinuationFixtures.ts`'s HOME-rooted `freshWorkspace` (which
 * exists so a spawned server without any extra flag accepts a caller `cwd`
 * different from the pinned root), every call site in the companion spec
 * passes the SAME directory as both the spawned server's own root (spawn
 * `cwd` + `bin.ts`'s positional root arg) and every tool call's own `cwd`
 * argument — `workspace/candidates.ts`'s `isWorkspaceCandidateAccepted`
 * accepts a `cwd` that resolves to the pinned fallback root itself
 * unconditionally ("H3"), regardless of $HOME/`TOKENLIGHTEN_ALLOWED_PARENTS`
 * — so no `--allowed-parent` grant is needed for an `os.tmpdir()`-rooted
 * workspace under this exact usage pattern.
 *
 * Cleanup is the SPEC's responsibility (its own `tmpDirs`/`afterAll`,
 * mirroring `explorationContinuationFixtures.ts`) — these builders only
 * create.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** helpers/ -> __tests__/ -> src/ -> mcp-server/ -> packages/ -> repo root. */
const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..", "..");

export function writeFile(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

/** A fresh, realpath'd direct child of `os.tmpdir()` — see module doc comment for why this needs no `--allowed-parent`. */
export function freshWorkspace(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tl-hor-${tag}-`));
  return fs.realpathSync(dir);
}

const MINIMAL_PACKAGE_JSON = JSON.stringify(
  { name: "tl-hands-on-fixture", version: "0.0.1", private: true, type: "module" },
  null,
  2,
) + "\n";

const MINIMAL_TSCONFIG_JSON = JSON.stringify(
  {
    compilerOptions: {
      target: "ES2022",
      module: "ES2022",
      moduleResolution: "Bundler",
      strict: true,
      skipLibCheck: true,
      outDir: "dist",
    },
    include: ["src"],
  },
  null,
  2,
) + "\n";

// ---------------------------------------------------------------------------
// src/cache.ts — the planted expiry-boundary defect (P1-1's edit target).
//
// `get()`'s expiry guard is `now > entry.expiresAt` (strict): an entry is
// still returned as valid when `now === entry.expiresAt`. The intended fix
// (P1-1's query, both JA and EN) is `now >= entry.expiresAt` — a one-operator
// diff, deliberately: this is a "unique text, single-site" edit, not a
// structural rewrite, exactly the class of change literal-first/fast-path
// routing exists to resolve directly. No comment on the class marks the bug
// itself: an in-source hint would leak the answer into the very evidence the
// exploration/discovery behavior under test is supposed to locate on its own
// (feedback-fixture-defects-are-test-material / no-bench-overfitting).
//
// Review finding 1 (2026-09-08, v0.14.1 hands-on report follow-up): kept
// DELIBERATELY SMALL (~19 real lines) and LF-terminated (every real repo's
// norm) — both are load-bearing for what P1-1's own regression must pin, not
// just style. `get()`'s own body is served first as a `class-method` surface
// and gets masked out of the negative-evidence ("readiness-falsification-
// counterexample") pass that follows, so that pass's `selectQueryEvidence`
// window centers on the still-unmasked `CacheEntry` interface near the TOP
// of the file — and `selectQueryEvidence` (tools/queryEvidence.ts) grows that
// window by windowLines=18 on each side from a raw `content.split("\n")`,
// which is NOT trailing-newline-aware. A file long enough to keep that
// window's end short of the real last line never reproduces the reported
// defect at all (measured: the original ~35-line version of this file
// produced a counterexample surface ending at line 21 of 35 — nowhere near
// the phantom trailing line — so `p1-1-ja`/`p1-1-en` passed whether or not
// `surfaceRangeShipped` clamped anything, pinning nothing). At this file's
// real 19 lines, that same window's end reaches (and, pre-fix, overshoots
// by one into) the file's true last line regardless of exactly which line
// the match centers on, so the surface's declared range is provably
// `1-<realLines + 1>` pre-fix and `1-<realLines>` post-fix — the exact
// off-by-one review finding 1 reports. Confirmed empirically both ways:
// reverting only the `Math.min(target.end, identity.totalLines)` clamp in
// `surfaceRangeShipped` makes `p1-1-ja`/`p1-1-en` FAIL again on this fixture
// (the qref re-pack re-presents the identical next); restoring the clamp
// makes them pass. If this file's shape ever needs to change again, re-run
// that same before/after check rather than trusting line-count arithmetic
// alone — the exact centering depends on what `maskServedRanges` has already
// excluded, not only on total length.
// ---------------------------------------------------------------------------
const CACHE_TS = `export interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}
export class Cache<V = unknown> {
  private readonly entries = new Map<string, CacheEntry<V>>();
  set(key: string, value: V, ttlMs: number, now: number = Date.now()): void {
    this.entries.set(key, { value, expiresAt: now + ttlMs });
  }
  get(key: string, now: number = Date.now()): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (now > entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }
}
`;

/**
 * ~10 lines, plain node:assert style. Covers get/set and a "just before
 * expiry" case only — deliberately NOT the exactly-at-expiry case, since
 * adding that assertion is what P1-1's query asks for. LF-terminated, like
 * every file this module writes (see the CACHE_TS comment above for why
 * that matters beyond style for this specific fixture pair). No `CacheConfig`
 * object: `Cache` above takes no constructor argument (review finding 1
 * trimmed it to keep the file short), so this instantiates with none either.
 */
const CACHE_TEST_TS = `import assert from "node:assert";
import { Cache } from "./cache.js";

const cache = new Cache<string>();

cache.set("k", "v", 100, 0);

assert.strictEqual(cache.get("k", 50), "v");

assert.strictEqual(cache.get("missing-key", 50), undefined);
`;

const CONFIG_TS = `export const RETRY_LIMIT = 3;
export const CACHE_TTL_MS = 60_000;
`;

/** Exactly one unique string, ~123 B total — P2-3's unique-replace target. */
const GREETING_TS = `export const GREETING_MESSAGE = "Hello from the TokenLighten fixture workspace, nice to meet you here today!";
`;

function buildSmall30Lines(): string[] {
  const lines: string[] = [];
  for (let i = 1; i <= 30; i++) {
    lines.push(`export const VALUE_${String(i).padStart(2, "0")} = ${i};`);
  }
  return lines;
}

/** ~500 lines / ~37,500 B of generated exported consts — a budget-cut/pagination subject. */
function buildLarge500Lines(): string[] {
  const pad = "x".repeat(30);
  const lines: string[] = [];
  for (let i = 0; i < 500; i++) {
    lines.push(`export const GENERATED_CONST_${String(i).padStart(4, "0")} = "${pad}_${i}";`);
  }
  return lines;
}

/**
 * P2-1 follow-up (2026-09-08): ~30 lines / well under TINY_BYTES (8,192 B),
 * WITH two real multi-line JSDoc blocks — unlike small30.ts (no comments at
 * all), a `comments:"elide"` serve of this file collapses those blocks to
 * `doc elided L<a>-<b>` markers while a `comments:"keep"` serve renders them
 * verbatim, so the two projections are byte-different. Needed to reproduce
 * the tiny-file dedup gap: server.ts's standalone dedup check (the
 * tiny-file-governor-exemption branch `buildFullDowngradePayload`'s own
 * Gate 1 never reaches) hardcoded `comments:"keep"` to never dedupe, even on
 * an exact repeat, until the P2-1 follow-up fix.
 */
const TINY_COMMENTS_30_TS = `/**
 * tiny30WithComments.ts — a small fixture used to prove a comments:"keep"
 * repeat of a TINY file dedups to a receipt just like every other
 * projection, and that a first comments:"keep" after only a comments:"elide"
 * serve still returns real bytes.
 */

/**
 * Adds two numbers.
 *
 * @param a - left operand
 * @param b - right operand
 * @returns the sum of a and b
 */
export function tinyAdd(a: number, b: number): number {
  return a + b;
}

/**
 * Multiplies two numbers.
 *
 * @param a - left operand
 * @param b - right operand
 * @returns the product of a and b
 */
export function tinyMultiply(a: number, b: number): number {
  return a * b;
}

export const TINY_GREETING = "hello from tiny30";
`;

export interface CacheWorkspace {
  dir: string;
}

/**
 * The primary P1/P2 fixture: cache.ts (planted defect) + cache.test.ts +
 * config.ts + greeting.ts (123 B unique string) + small30.ts (30 lines, no
 * comments) + large500.ts (500 lines) + withComments189.ts (189 lines/8,276 B,
 * many block+line comments — copied verbatim from the real
 * `packages/vscode-extension/src/mcpProvider.ts` at fixture-build time: that
 * file happens to be exactly 189 lines / 8,276 B on this repository, matching
 * the report's own numbers, so this is a real, not synthesized, commented TS
 * file) + tiny30WithComments.ts (P2-1 follow-up, 2026-09-08: ~30 lines/well
 * under TINY_BYTES, WITH real multi-line JSDoc blocks — unlike small30.ts,
 * this one gives a `comments:"elide"` serve and a `comments:"keep"` serve of
 * the SAME tiny file byte-different bodies, needed to exercise the standalone
 * dedup check's tiny-file-governor-exemption branch in server.ts). No Redis
 * anywhere.
 */
export function buildCacheWorkspace(): CacheWorkspace {
  const dir = freshWorkspace("cache");

  writeFile(dir, "package.json", MINIMAL_PACKAGE_JSON);
  writeFile(dir, "tsconfig.json", MINIMAL_TSCONFIG_JSON);
  writeFile(dir, "src/cache.ts", CACHE_TS);
  writeFile(dir, "src/cache.test.ts", CACHE_TEST_TS);
  writeFile(dir, "src/config.ts", CONFIG_TS);
  writeFile(dir, "src/greeting.ts", GREETING_TS);

  const small30 = buildSmall30Lines();
  if (small30.length !== 30) throw new Error(`fixture wiring bug: small30.ts has ${small30.length} lines, expected 30`);
  writeFile(dir, "src/small30.ts", small30.join("\n") + "\n");

  const large500 = buildLarge500Lines();
  if (large500.length !== 500) throw new Error(`fixture wiring bug: large500.ts has ${large500.length} lines, expected 500`);
  writeFile(dir, "src/large500.ts", large500.join("\n") + "\n");

  const mcpProviderPath = path.join(REPO_ROOT, "packages/vscode-extension/src/mcpProvider.ts");
  const withComments = fs.readFileSync(mcpProviderPath, "utf8");
  writeFile(dir, "src/withComments189.ts", withComments);

  writeFile(dir, "src/tiny30WithComments.ts", TINY_COMMENTS_30_TS);

  return { dir };
}

/**
 * P2-4's fixture: a separate, tiny workspace holding the REAL
 * `packages/vscode-extension/src/mcpProvider.ts`, `src/commands.ts`, and
 * `package.json` (the one declaring `tokenlighten.toolSurface`), copied
 * verbatim at build time — the same VSIX-real-code condition the report's
 * §3.2/P2-4 sections describe, so "how is the toolSurface setting wired from
 * the VS Code configuration to the MCP provider" is answerable from files
 * actually present in the workspace (package.json's `contributes.
 * configuration` declares it; commands.ts and mcpProvider.ts each read it
 * via `workspace.getConfiguration(...).get<string>("toolSurface", "full")`).
 */
export function buildExtensionCopyWorkspace(): CacheWorkspace {
  const dir = freshWorkspace("ext");
  const srcDir = path.join(REPO_ROOT, "packages/vscode-extension");

  writeFile(dir, "src/mcpProvider.ts", fs.readFileSync(path.join(srcDir, "src/mcpProvider.ts"), "utf8"));
  writeFile(dir, "src/commands.ts", fs.readFileSync(path.join(srcDir, "src/commands.ts"), "utf8"));
  writeFile(dir, "package.json", fs.readFileSync(path.join(srcDir, "package.json"), "utf8"));

  return { dir };
}
