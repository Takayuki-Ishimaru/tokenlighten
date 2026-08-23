/**
 * multiRoot.spec.ts — V11-09 (Incremental Index / Graph Update v2):
 * multi-root/worktree cache-key identity audit.
 *
 * AUDIT FINDING (see this workstream's final report): the ONLY per-root
 * in-process cache anywhere in skeleton-engine is indexStore.ts's
 * manifestMemo (and the new manifestMemoEpoch it is paired with) — audited
 * by grepping every module-level `new Map`/`new Set` across
 * packages/skeleton-engine/src/*.ts. graph.ts and apiGraph.ts each have a
 * tiny single-slot newline-offset memo (`lineOfMemoText`/
 * `lineOfMemoNewlines`) keyed by CONTENT EQUALITY, not by root/path, so two
 * different workspaces' distinct file contents naturally never collide
 * there. pagerank.ts takes `previousGraph` as an explicit caller-supplied
 * parameter — no module-level state at all.
 *
 * manifestMemo/manifestMemoEpoch were ALREADY keyed by
 * `realpathSync(root)` / `fs.realpath(root)` before this workstream — this
 * suite exists to PROVE that identity is real, not merely asserted, with
 * two genuinely distinct root directories (the same shape two worktrees of
 * one repo would have: distinct directories, independently mutable,
 * possibly diverged content) exercised concurrently against the SAME
 * in-process caches this test file (and a real server process) shares.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import {
  loadOrBuildSourceIndex,
  invalidateCachedWorkspaceFiles,
  resetManifestMemoForTest,
} from "../indexStore.js";

let rootA: string;
let rootB: string;

beforeEach(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  rootA = join(tmpdir(), `multiRoot-A-${stamp}`);
  rootB = join(tmpdir(), `multiRoot-B-${stamp}`);
  await fs.mkdir(join(rootA, "src"), { recursive: true });
  await fs.mkdir(join(rootB, "src"), { recursive: true });
  resetManifestMemoForTest();
});

afterEach(async () => {
  await fs.rm(rootA, { recursive: true, force: true });
  await fs.rm(rootB, { recursive: true, force: true });
});

describe("multi-root isolation", () => {
  it("two roots with the SAME relative path but DIFFERENT content never cross-contaminate", async () => {
    await fs.writeFile(join(rootA, "src", "shared.ts"), "export function fromA() { return 1; }\n", "utf8");
    await fs.writeFile(join(rootB, "src", "shared.ts"), "export function fromB() { return 2; }\n", "utf8");

    const a = await loadOrBuildSourceIndex(rootA, { commit: "c", ignoreHash: "h" });
    const b = await loadOrBuildSourceIndex(rootB, { commit: "c", ignoreHash: "h" });

    expect(a.manifest.files["src/shared.ts"]!.symbols[0]!.name).toBe("fromA");
    expect(b.manifest.files["src/shared.ts"]!.symbols[0]!.name).toBe("fromB");
    expect(a.manifest.rootHash).not.toBe(b.manifest.rootHash);
    expect(a.manifest.repoRootRealpath).not.toBe(b.manifest.repoRootRealpath);
  });

  it("re-reading root A after root B was built serves A's own memo entry, not B's (both directions)", async () => {
    await fs.writeFile(join(rootA, "src", "shared.ts"), "export function fromA() {}\n", "utf8");
    await fs.writeFile(join(rootB, "src", "shared.ts"), "export function fromB() {}\n", "utf8");

    const a1 = await loadOrBuildSourceIndex(rootA, { commit: "c", ignoreHash: "h" });
    const b1 = await loadOrBuildSourceIndex(rootB, { commit: "c", ignoreHash: "h" });
    // Interleave: read A again, then B again — an unchanged workspace hits
    // the memo's whole-match shortcut and returns the SAME object; if the
    // two roots' memo entries were sharing a key, this would instead
    // return the OTHER root's manifest (wrong content) or force a spurious
    // rebuild every time (wrong statFingerprint match).
    const a2 = await loadOrBuildSourceIndex(rootA, { commit: "c", ignoreHash: "h" });
    const b2 = await loadOrBuildSourceIndex(rootB, { commit: "c", ignoreHash: "h" });

    expect(a2.manifest).toBe(a1.manifest);
    expect(b2.manifest).toBe(b1.manifest);
    expect(a2.reparsed).toBe(0);
    expect(b2.reparsed).toBe(0);
    expect(a2.manifest.files["src/shared.ts"]!.symbols[0]!.name).toBe("fromA");
    expect(b2.manifest.files["src/shared.ts"]!.symbols[0]!.name).toBe("fromB");
  });

  it("invalidating root A busts ONLY root A's memo entry — root B's is untouched", async () => {
    await fs.writeFile(join(rootA, "src", "shared.ts"), "export function fromA() { return 1; }\n", "utf8");
    await fs.writeFile(join(rootB, "src", "shared.ts"), "export function fromB() { return 1; }\n", "utf8");

    const a1 = await loadOrBuildSourceIndex(rootA, { commit: "c", ignoreHash: "h" });
    const b1 = await loadOrBuildSourceIndex(rootB, { commit: "c", ignoreHash: "h" });

    invalidateCachedWorkspaceFiles(rootA, ["src/shared.ts"]);

    const a2 = await loadOrBuildSourceIndex(rootA, { commit: "c", ignoreHash: "h" });
    const b2 = await loadOrBuildSourceIndex(rootB, { commit: "c", ignoreHash: "h" });

    // A was invalidated: memo busted, a NEW manifest object even though
    // content on disk did not change (still forces a content-hash
    // re-validation, per V10-10's contract).
    expect(a2.manifest).not.toBe(a1.manifest);
    // B was never touched: still the exact same memoized object.
    expect(b2.manifest).toBe(b1.manifest);
    expect(b2.reparsed).toBe(0);
  });

  it("invalidating root B busts ONLY root B's memo entry — root A's is untouched (the other direction)", async () => {
    await fs.writeFile(join(rootA, "src", "shared.ts"), "export function fromA() { return 1; }\n", "utf8");
    await fs.writeFile(join(rootB, "src", "shared.ts"), "export function fromB() { return 1; }\n", "utf8");

    const a1 = await loadOrBuildSourceIndex(rootA, { commit: "c", ignoreHash: "h" });
    const b1 = await loadOrBuildSourceIndex(rootB, { commit: "c", ignoreHash: "h" });

    invalidateCachedWorkspaceFiles(rootB, ["src/shared.ts"]);

    const a2 = await loadOrBuildSourceIndex(rootA, { commit: "c", ignoreHash: "h" });
    const b2 = await loadOrBuildSourceIndex(rootB, { commit: "c", ignoreHash: "h" });

    expect(a2.manifest).toBe(a1.manifest);
    expect(a2.reparsed).toBe(0);
    expect(b2.manifest).not.toBe(b1.manifest);
  });

  it("the SAME root expressed via two syntactically different (but realpath-equal) strings shares ONE identity, not two", async () => {
    // The inverse property to every test above: two roots that ARE
    // genuinely the same directory must not fragment into separate memo
    // entries just because a caller happened to spell the path
    // differently (e.g. with a trailing separator) — root identity is
    // realpath-based specifically so this collapses correctly.
    await fs.writeFile(join(rootA, "src", "shared.ts"), "export function fromA() {}\n", "utf8");
    const first = await loadOrBuildSourceIndex(rootA, { commit: "c", ignoreHash: "h" });

    const rootAWithTrailingSep = rootA + sep;
    const second = await loadOrBuildSourceIndex(rootAWithTrailingSep, { commit: "c", ignoreHash: "h" });

    // Same realpath identity => the whole-match memo shortcut fires and
    // returns the SAME manifest object, not a spurious rebuild.
    expect(second.manifest).toBe(first.manifest);
    expect(second.reparsed).toBe(0);
  });

  it("a nested directory legitimately enumerates as part of its OUTER root — this is ordinary recursive walking, not a worktree-boundary bug", async () => {
    // Documents the boundary of what THIS workstream's identity fix
    // covers: manifestMemo keys are correct per root that
    // loadOrBuildSourceIndex is actually CALLED WITH (proven by every test
    // above). A directory that is genuinely nested inside another root's
    // own tree (no separate call, no separate identity requested) is
    // correctly enumerated as part of that outer root, exactly like any
    // other subdirectory — deciding WHICH root a given request should use
    // (e.g. never asking the outer root to index across a nested git
    // worktree boundary) is a request-routing concern one layer up
    // (mcp-server's GuardedWorkspaceRoot / per-request cwd), not something
    // enumerateFiles/manifestMemo could or should second-guess.
    const nested = join(rootA, "nested-workspace");
    await fs.mkdir(join(nested, "src"), { recursive: true });
    await fs.writeFile(join(rootA, "src", "shared.ts"), "export function outer() {}\n", "utf8");
    await fs.writeFile(join(nested, "src", "shared.ts"), "export function inner() {}\n", "utf8");

    const outer = await loadOrBuildSourceIndex(rootA, { commit: "c", ignoreHash: "h" });
    expect(outer.manifest.files["src/shared.ts"]!.symbols[0]!.name).toBe("outer");
    expect(outer.manifest.files["nested-workspace/src/shared.ts"]!.symbols[0]!.name).toBe("inner");

    // Indexing the nested directory as its OWN root (a real, separate
    // loadOrBuildSourceIndex call — the shape a second server instance
    // actually rooted there would make) gets its own independent identity,
    // proven the same way as every other pair in this file.
    const innerAsOwnRoot = await loadOrBuildSourceIndex(nested, { commit: "c", ignoreHash: "h" });
    expect(Object.keys(innerAsOwnRoot.manifest.files)).toEqual(["src/shared.ts"]);
    expect(innerAsOwnRoot.manifest.repoRootRealpath).not.toBe(outer.manifest.repoRootRealpath);
  });
});
