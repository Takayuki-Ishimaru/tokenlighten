/**
 * coverageDisclosure.spec.ts — V11-09 (Incremental Index / Graph Update v2):
 * parser crash quarantine, the file-read-error false-absence fix, and the
 * coverage summary accessor. CRITICAL INVARIANT under test throughout:
 * partial coverage must never be reported (or silently defaulted) as
 * complete/absent.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs, truncateSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadOrBuildSourceIndex,
  getManifestCoverageSummary,
  resetManifestMemoForTest,
} from "../indexStore.js";
import { READ_PATH_MAX_BYTES } from "../readGuard.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = join(tmpdir(), `coverageDisclosure-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(join(tmpDir, "src"), { recursive: true });
  resetManifestMemoForTest();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("parser crash quarantine — a THROW during extraction isolates one file, never aborts the build", () => {
  it("a forced extraction crash on one file still indexes every OTHER file normally", async () => {
    await fs.writeFile(join(tmpDir, "src", "good.ts"), "export function fine() { return 1; }\n", "utf8");
    await fs.writeFile(join(tmpDir, "src", "bad.ts"), "export function boom() { return 1; }\n", "utf8");

    const result = await loadOrBuildSourceIndex(tmpDir, {
      commit: "c",
      ignoreHash: "h",
      __testHooks: { forceExtractionCrash: (relPath) => relPath === "src/bad.ts" },
    });

    // Pre-V11-09 this would have thrown out of loadOrBuildSourceIndex
    // entirely (extractChunks had no guard) — the whole build survives now.
    expect(result.manifest.files["src/good.ts"]!.symbols[0]!.name).toBe("fine");
    expect(result.manifest.files["src/good.ts"]!.parseStatus).toBeUndefined(); // "ok" == absent
  });

  it("the crashed file is isolated: empty symbols/chunks, marked quarantined, contentSha256 still recorded", async () => {
    await fs.writeFile(join(tmpDir, "src", "bad.ts"), "export function boom() { return 1; }\n", "utf8");

    const result = await loadOrBuildSourceIndex(tmpDir, {
      commit: "c",
      ignoreHash: "h",
      __testHooks: { forceExtractionCrash: (relPath) => relPath === "src/bad.ts" },
    });

    const entry = result.manifest.files["src/bad.ts"]!;
    expect(entry.parseStatus).toBe("quarantined");
    expect(entry.symbols).toEqual([]);
    expect(entry.chunks).toEqual([]);
    expect(entry.outgoingSymbolRefs).toEqual({});
    expect(entry.contentSha256).not.toBe(""); // bytes WERE read successfully — only extraction crashed
    expect(result.warnings.some((w) => w.includes("quarantined src/bad.ts"))).toBe(true);
    expect(result.cacheRebuildReasons).toContain("parser-crash-quarantined:src/bad.ts");
  });

  it("a quarantined file is re-attempted the next time its content changes (and can recover)", async () => {
    const badPath = join(tmpDir, "src", "bad.ts");
    await fs.writeFile(badPath, "export function boom() { return 1; }\n", "utf8");

    const first = await loadOrBuildSourceIndex(tmpDir, {
      commit: "c",
      ignoreHash: "h",
      __testHooks: { forceExtractionCrash: (relPath) => relPath === "src/bad.ts" },
    });
    expect(first.manifest.files["src/bad.ts"]!.parseStatus).toBe("quarantined");

    // Content changes — no force-crash this time, simulating the bug that
    // made extraction throw having been fixed, or the offending content
    // having been edited away.
    await fs.writeFile(badPath, "export function fixed() { return 2; }\n", "utf8");
    const second = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });

    const entry = second.manifest.files["src/bad.ts"]!;
    expect(entry.parseStatus).toBeUndefined(); // back to "ok"
    expect(entry.symbols[0]!.name).toBe("fixed");
  });

  it("an UNCHANGED quarantined file is NOT re-attempted on every reload (respects the ordinary content-hash cache gate)", async () => {
    await fs.writeFile(join(tmpDir, "src", "bad.ts"), "export function boom() { return 1; }\n", "utf8");

    let crashCalls = 0;
    const hooks = {
      forceExtractionCrash: (relPath: string) => {
        if (relPath === "src/bad.ts") crashCalls++;
        return relPath === "src/bad.ts";
      },
    };
    await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h", __testHooks: hooks });
    expect(crashCalls).toBe(1);

    // Second call, same content, no change — the fast path's content-hash
    // gate should reuse the cached (quarantined) entry outright, never
    // calling into extraction again for this unchanged file.
    const second = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h", __testHooks: hooks });
    expect(crashCalls).toBe(1); // not called again
    expect(second.reparsed).toBe(0);
    expect(second.manifest.files["src/bad.ts"]!.parseStatus).toBe("quarantined");
  });
});

describe("file-read-error — never a silent false absence (V11-09 fix)", () => {
  // readRegularFileUtf8 fails for several reasons (permissions, a
  // transient I/O error, exceeding its size cap, "not a regular file any
  // more") and loadOrBuildSourceIndex's per-file loop treats every one of
  // them identically (its catch block does not branch on WHY the read
  // failed). This suite drives the failure with a genuine TOCTOU race:
  // the file is a normal small file when THIS call's own enumerateFiles
  // pass runs (so it is correctly included in `files`), then gets
  // inflated past READ_PATH_MAX_BYTES via the midBuild hook at the exact
  // moment the per-file loop reaches it, moments later — reproducing
  // "another process touched this file between enumeration and read"
  // deterministically. (chmod-based permission denial and swapping the
  // path for a directory were both tried first: chmod 0o000 is not
  // enforced against the owning UID on this filesystem, and a directory
  // swap gets filtered out by enumerateFiles' OWN isFile()/size checks
  // before ever reaching indexStore's per-file loop at all — neither
  // reaches the code path this fix actually touches.)
  it("a file that becomes unreadable keeps its LAST KNOWN GOOD entry, stamped failed, instead of vanishing", async () => {
    const filePath = join(tmpDir, "src", "flaky.ts");
    const otherPath = join(tmpDir, "src", "other.ts");
    await fs.writeFile(filePath, "export function stable() { return 1; }\n", "utf8");
    await fs.writeFile(otherPath, "export function other() { return 1; }\n", "utf8");
    const first = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    expect(first.manifest.files["src/flaky.ts"]!.symbols[0]!.name).toBe("stable");

    // An ordinary, unrelated change so this SECOND call's own initial
    // whole-match memo check misses on its own merits and it actually
    // enters the per-file loop where midBuild fires — otherwise an
    // unchanged workspace would short-circuit before ever reaching
    // flaky.ts's own read at all (same requirement as the concurrent-
    // invalidation fault test above).
    await fs.writeFile(otherPath, "export function other() { return 2; }\n", "utf8");

    const second = await loadOrBuildSourceIndex(tmpDir, {
      commit: "c",
      ignoreHash: "h",
      __testHooks: {
        midBuild: (relPath) => {
          if (relPath === "src/flaky.ts") truncateSync(filePath, READ_PATH_MAX_BYTES + 1);
        },
      },
    });
    const entry = second.manifest.files["src/flaky.ts"];
    // The path MUST still be present — pre-V11-09 this `continue`d and
    // vanished the entry entirely, indistinguishable from a deletion.
    expect(entry).toBeDefined();
    expect(entry!.parseStatus).toBe("failed");
    // Last-known-good content preserved (still reports "stable").
    expect(entry!.symbols[0]!.name).toBe("stable");
  });

  it("recovers to ok once the file becomes readable again", async () => {
    const filePath = join(tmpDir, "src", "flaky.ts");
    const otherPath = join(tmpDir, "src", "other.ts");
    await fs.writeFile(filePath, "export function stable() { return 1; }\n", "utf8");
    await fs.writeFile(otherPath, "export function other() { return 1; }\n", "utf8");
    await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });

    await fs.writeFile(otherPath, "export function other() { return 2; }\n", "utf8");
    await loadOrBuildSourceIndex(tmpDir, {
      commit: "c",
      ignoreHash: "h",
      __testHooks: {
        midBuild: (relPath) => {
          if (relPath === "src/flaky.ts") truncateSync(filePath, READ_PATH_MAX_BYTES + 1);
        },
      },
    });
    await fs.writeFile(filePath, "export function stable() { return 1; }\n", "utf8");

    const recovered = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    expect(recovered.manifest.files["src/flaky.ts"]!.parseStatus).toBeUndefined();
  });
});

describe("getManifestCoverageSummary — the disclosure accessor", () => {
  it("all-ok manifest reports isPartial:false and zero quarantined/failed", async () => {
    await fs.writeFile(join(tmpDir, "src", "a.ts"), "export function a() {}\n", "utf8");
    const result = await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });

    const summary = getManifestCoverageSummary(result.manifest);
    expect(summary).toEqual({
      totalFiles: 1,
      ok: 1,
      quarantined: 0,
      failed: 0,
      isPartial: false,
      quarantinedPaths: [],
      failedPaths: [],
    });
  });

  it("a manifest with a quarantined file reports isPartial:true and names it — never silently 'complete'", async () => {
    await fs.writeFile(join(tmpDir, "src", "good.ts"), "export function fine() {}\n", "utf8");
    await fs.writeFile(join(tmpDir, "src", "bad.ts"), "export function boom() {}\n", "utf8");

    const result = await loadOrBuildSourceIndex(tmpDir, {
      commit: "c",
      ignoreHash: "h",
      __testHooks: { forceExtractionCrash: (relPath) => relPath === "src/bad.ts" },
    });

    const summary = getManifestCoverageSummary(result.manifest);
    expect(summary.isPartial).toBe(true);
    expect(summary.totalFiles).toBe(2);
    expect(summary.ok).toBe(1);
    expect(summary.quarantined).toBe(1);
    expect(summary.quarantinedPaths).toEqual(["src/bad.ts"]);
    expect(summary.failedPaths).toEqual([]);
  });

  it("a manifest with a failed (unreadable) file reports isPartial:true via failedPaths", async () => {
    const filePath = join(tmpDir, "src", "flaky.ts");
    const otherPath = join(tmpDir, "src", "other.ts");
    await fs.writeFile(filePath, "export function stable() {}\n", "utf8");
    await fs.writeFile(otherPath, "export function other() { return 1; }\n", "utf8");
    await loadOrBuildSourceIndex(tmpDir, { commit: "c", ignoreHash: "h" });
    await fs.writeFile(otherPath, "export function other() { return 2; }\n", "utf8");

    const second = await loadOrBuildSourceIndex(tmpDir, {
      commit: "c",
      ignoreHash: "h",
      __testHooks: {
        midBuild: (relPath) => {
          if (relPath === "src/flaky.ts") truncateSync(filePath, READ_PATH_MAX_BYTES + 1);
        },
      },
    });
    const summary = getManifestCoverageSummary(second.manifest);
    expect(summary.isPartial).toBe(true);
    expect(summary.failedPaths).toEqual(["src/flaky.ts"]);
  });

  it("quarantinedPaths/failedPaths are sorted, for deterministic disclosure", () => {
    const manifest = {
      version: 1 as const,
      engineVersion: "x",
      repoRootRealpath: "/r",
      ignoreHash: "h",
      builtFromCommit: "c",
      rootHash: "rh",
      files: {
        "z.ts": { path: "z.ts", language: "ts", sizeBytes: 1, mtimeMs: 1, contentSha256: "a", symbols: [], chunks: [], outgoingSymbolRefs: {}, parseStatus: "quarantined" as const },
        "a.ts": { path: "a.ts", language: "ts", sizeBytes: 1, mtimeMs: 1, contentSha256: "b", symbols: [], chunks: [], outgoingSymbolRefs: {}, parseStatus: "quarantined" as const },
      },
      directories: {},
    };
    const summary = getManifestCoverageSummary(manifest);
    expect(summary.quarantinedPaths).toEqual(["a.ts", "z.ts"]);
  });
});
