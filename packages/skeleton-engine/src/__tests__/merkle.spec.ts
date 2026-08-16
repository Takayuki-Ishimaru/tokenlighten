import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { hashContent, hashIgnorePatterns, buildDirectoryDigests } from "../merkle.js";
import type { IndexedFileV1 } from "../indexStore.js";

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function makeFile(path: string, sha: string): IndexedFileV1 {
  return {
    path,
    language: "typescript",
    sizeBytes: 100,
    mtimeMs: 0,
    contentSha256: sha,
    symbols: [],
    chunks: [],
    outgoingSymbolRefs: {},
  };
}

describe("hashContent", () => {
  it("matches createHash sha256 directly", () => {
    const buf = Buffer.from("hello");
    expect(hashContent(buf)).toBe(
      createHash("sha256").update(Buffer.from("hello")).digest("hex"),
    );
  });

  it("empty buffer", () => {
    const buf = Buffer.from("");
    expect(hashContent(buf)).toBe(sha256(""));
  });
});

describe("hashIgnorePatterns", () => {
  it("is order-independent (sorted)", () => {
    expect(hashIgnorePatterns(["b", "a"])).toBe(hashIgnorePatterns(["a", "b"]));
  });

  it("differs for different patterns", () => {
    expect(hashIgnorePatterns(["a"])).not.toBe(hashIgnorePatterns(["b"]));
  });
});

describe("buildDirectoryDigests", () => {
  it("empty input → root is sha256 of empty string", () => {
    const { root, directories } = buildDirectoryDigests([]);
    expect(root).toBe(sha256(""));
    expect(directories[""]).toBeDefined();
    expect(directories[""]!.hash).toBe(sha256(""));
  });

  it("same files in different order → same root hash", () => {
    const files1 = [
      makeFile("src/a.ts", "aaa"),
      makeFile("src/b.ts", "bbb"),
    ];
    const files2 = [
      makeFile("src/b.ts", "bbb"),
      makeFile("src/a.ts", "aaa"),
    ];
    const { root: root1 } = buildDirectoryDigests(files1);
    const { root: root2 } = buildDirectoryDigests(files2);
    expect(root1).toBe(root2);
  });

  it("changing one file content → root hash changes", () => {
    const files1 = [makeFile("src/a.ts", "aaa"), makeFile("src/b.ts", "bbb")];
    const files2 = [makeFile("src/a.ts", "CHANGED"), makeFile("src/b.ts", "bbb")];
    const { root: root1 } = buildDirectoryDigests(files1);
    const { root: root2 } = buildDirectoryDigests(files2);
    expect(root1).not.toBe(root2);
  });

  it("changing file in one subdir does not change sibling subdir hash", () => {
    const files1 = [
      makeFile("alpha/x.ts", "x1"),
      makeFile("beta/y.ts", "y1"),
    ];
    const files2 = [
      makeFile("alpha/x.ts", "CHANGED"),
      makeFile("beta/y.ts", "y1"),
    ];
    const { directories: dirs1 } = buildDirectoryDigests(files1);
    const { directories: dirs2 } = buildDirectoryDigests(files2);

    // alpha dir should change, beta dir should NOT change.
    expect(dirs1["alpha"]!.hash).not.toBe(dirs2["alpha"]!.hash);
    expect(dirs1["beta"]!.hash).toBe(dirs2["beta"]!.hash);
  });

  it("single file → deterministic", () => {
    const files = [makeFile("main.ts", "abc123")];
    const { root: root1 } = buildDirectoryDigests(files);
    const { root: root2 } = buildDirectoryDigests(files);
    expect(root1).toBe(root2);
  });
});
