import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readBytesSafe, readFileSafe, resolveReal } from "../util/safePath.js";

describe("Native workspace paths (including Windows short-name TEMP)", () => {
  it("reads a workspace beneath the runner's short-name TEMP path", async () => {
    const root = mkdtempSync(join(tmpdir(), "tl-short-path-"));
    try {
      writeFileSync(join(root, "hello.txt"), "archive smoke content\n");
      const canonical = await realpath(root);
      expect(resolveReal(root)).toBe(canonical);
      expect(resolveReal(root)).toBe(realpathSync.native(root));
      expect(await readFileSafe("hello.txt", root)).toBe("archive smoke content\n");
      expect(await readBytesSafe("hello.txt", root)).toEqual(new Uint8Array(Buffer.from("archive smoke content\n")));
      expect(await readFileSafe("../outside.txt", root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
