/**
 * projectRoot.spec.ts — unit tests for the GENERAL project-root model
 * (buildRootResolver / inferClusterRoot / commonAncestorDir), the
 * replacement for the former bench-fixtures-path-boundary root detection.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildRootResolver, inferClusterRoot, commonAncestorDir, ROOT_MARKER_FILES } from "../util/projectRoot.js";

const tmpDirs: string[] = [];

function mkWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-projroot-test-"));
  tmpDirs.push(dir);
  return dir;
}
function touch(ws: string, rel: string, content = "x\n"): void {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

describe("buildRootResolver — manifest/VCS root detection", () => {
  it("each manifest-bearing directory is a root; nested files resolve to the nearest one", () => {
    const ws = mkWorkspace();
    touch(ws, "a/package.json", '{"name":"a"}\n');
    touch(ws, "a/src/x.ts");
    touch(ws, "b/go.mod", "module b\n");
    touch(ws, "b/internal/y.go", "package internal\n");
    touch(ws, "top.ts"); // no enclosing manifest

    const files = ["a/package.json", "a/src/x.ts", "b/go.mod", "b/internal/y.go", "top.ts"];
    const r = buildRootResolver(ws, files);
    expect(r.rootOf("a/src/x.ts")).toBe("a");
    expect(r.rootOf("b/internal/y.go")).toBe("b");
    expect(r.rootOf("top.ts")).toBe(""); // workspace root
    expect(new Set(r.markerRoots)).toEqual(new Set(["a", "b"]));
  });

  it("nearest-enclosing wins for nested manifests (monorepo package inside a repo)", () => {
    const ws = mkWorkspace();
    touch(ws, "package.json", '{"name":"root"}\n');          // workspace-root manifest
    touch(ws, "packages/inner/package.json", '{"name":"inner"}\n'); // nested manifest
    touch(ws, "packages/inner/src/z.ts");
    touch(ws, "packages/outerless/src/w.ts");                // no own manifest

    const files = [
      "package.json", "packages/inner/package.json",
      "packages/inner/src/z.ts", "packages/outerless/src/w.ts",
    ];
    const r = buildRootResolver(ws, files);
    // A nested package resolves to ITSELF (nearest manifest), not the root.
    expect(r.rootOf("packages/inner/src/z.ts")).toBe("packages/inner");
    // A sibling with no own manifest resolves to the workspace root, because
    // the ROOT manifest at "" is not a "nested" marker root (it is the "" sentinel).
    expect(r.rootOf("packages/outerless/src/w.ts")).toBe("");
    expect(new Set(r.markerRoots)).toEqual(new Set(["packages/inner"]));
  });

  it("a .git entry (dir or file) marks a root even without a manifest", () => {
    const ws = mkWorkspace();
    fs.mkdirSync(path.join(ws, "checkout/.git"), { recursive: true });
    touch(ws, "checkout/main.c", "int main(){return 0;}\n");
    touch(ws, "src/app.ts");
    const r = buildRootResolver(ws, ["checkout/main.c", "src/app.ts"]);
    expect(r.rootOf("checkout/main.c")).toBe("checkout");
    expect(r.rootOf("src/app.ts")).toBe("");
  });

  it("infers a marker-less native project root from src/include/test shape", () => {
    const ws = mkWorkspace();
    touch(ws, "vendor/drop/firmware/include/control/muxer.hpp");
    touch(ws, "vendor/drop/firmware/src/control/muxer.cpp");
    touch(ws, "vendor/drop/firmware/test/test_muxer.cpp");
    touch(ws, "vendor/drop/tools/measure.ts");

    const r = buildRootResolver(ws, [
      "vendor/drop/firmware/include/control/muxer.hpp",
      "vendor/drop/firmware/src/control/muxer.cpp",
      "vendor/drop/firmware/test/test_muxer.cpp",
      "vendor/drop/tools/measure.ts",
    ]);

    expect(r.rootOf("vendor/drop/firmware/src/control/muxer.cpp")).toBe("vendor/drop/firmware");
    expect(r.rootOf("vendor/drop/firmware/include/control/muxer.hpp")).toBe("vendor/drop/firmware");
    expect(r.rootOf("vendor/drop/tools/measure.ts")).toBe("");
  });

  it("every curated marker filename is recognized as a root", () => {
    // One marker per subdirectory; each must be detected.
    const ws = mkWorkspace();
    const files: string[] = [];
    ROOT_MARKER_FILES.forEach((marker, i) => {
      const dir = `m${i}`;
      touch(ws, `${dir}/${marker}`, "\n");
      touch(ws, `${dir}/code.ts`);
      files.push(`${dir}/${marker}`, `${dir}/code.ts`);
    });
    const r = buildRootResolver(ws, files);
    ROOT_MARKER_FILES.forEach((_marker, i) => {
      expect(r.rootOf(`m${i}/code.ts`)).toBe(`m${i}`);
    });
  });
});

describe("inferClusterRoot — manifest-independent subtree inference", () => {
  it("returns the common subtree when >=60% of top-K score mass concentrates there (depth>=2)", () => {
    const items = [
      { path: "firmware/src/estimator/a.c", score: 2 },
      { path: "firmware/src/estimator/b.c", score: 2 },
      { path: "firmware/src/estimator/c.c", score: 1.5 },
      { path: "tools/x.ts", score: 0.4 }, // out-of-cluster straggler
    ];
    expect(inferClusterRoot(items)).toBe("firmware/src/estimator");
  });

  it("returns null when the mass is spread across unrelated subtrees", () => {
    const items = [
      { path: "alpha/one.ts", score: 2 },
      { path: "beta/two.ts", score: 2 },
      { path: "gamma/three.ts", score: 2 },
    ];
    // No single depth>=2 subtree captures >=60%.
    expect(inferClusterRoot(items)).toBeNull();
  });

  it("does not nominate a shallow (depth<2) directory", () => {
    const items = [
      { path: "src/a.ts", score: 3 },
      { path: "src/b.ts", score: 3 },
    ];
    // Common ancestor is "src" (depth 1) — below minDepth, so null.
    expect(inferClusterRoot(items)).toBeNull();
  });

  it("ignores non-positive-score (already-demoted) items", () => {
    const items = [
      { path: "firmware/src/estimator/a.c", score: 2 },
      { path: "firmware/src/estimator/b.c", score: 2 },
      { path: "elsewhere/deep/dir/c.ts", score: -1 }, // demoted; must not count
    ];
    expect(inferClusterRoot(items)).toBe("firmware/src/estimator");
  });
});

describe("commonAncestorDir", () => {
  it("returns the shared directory prefix", () => {
    expect(commonAncestorDir(["a/b/c/x.ts", "a/b/d/y.ts"])).toBe("a/b");
  });
  it("returns the sole file's parent for a single path", () => {
    expect(commonAncestorDir(["a/b/c/x.ts"])).toBe("a/b/c");
  });
  it("returns \"\" when paths share no directory", () => {
    expect(commonAncestorDir(["a/x.ts", "b/y.ts"])).toBe("");
  });
  it("returns \"\" for an empty list", () => {
    expect(commonAncestorDir([])).toBe("");
  });
});
