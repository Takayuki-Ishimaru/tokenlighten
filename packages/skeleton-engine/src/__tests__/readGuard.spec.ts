import { describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { READ_PATH_MAX_BYTES, readRegularFileUtf8 } from "../readGuard.js";

const execFileAsync = promisify(execFile);

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "tl-read-guard-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("readRegularFileUtf8", () => {
  it("reads a bounded regular file", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "input.txt");
      await writeFile(path, "safe\n", "utf8");
      await expect(readRegularFileUtf8(path)).resolves.toBe("safe\n");
    });
  });

  it("rejects a file exceeding the 64 MiB cap before reading it", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "large.txt");
      await writeFile(path, "", "utf8");
      await truncate(path, READ_PATH_MAX_BYTES + 1);
      await expect(readRegularFileUtf8(path)).rejects.toThrow(/file-too-large/);
    });
  });

  it("rejects decoded content that exceeds the cap even when both stats are small", async () => {
    const stat = vi.spyOn(fs, "stat").mockResolvedValue({
      isFile: () => true,
      size: 4,
    } as never);
    const readFile = vi.spyOn(fs, "readFile").mockResolvedValue("12345" as never);
    try {
      await expect(readRegularFileUtf8("virtual", 4)).rejects.toThrow(
        /content-too-large-after-read/,
      );
      expect(stat).toHaveBeenCalledTimes(1);
    } finally {
      stat.mockRestore();
      readFile.mockRestore();
    }
  });

  it("rejects a file that grows between the pre-read and post-read stats", async () => {
    const stat = vi.spyOn(fs, "stat")
      .mockResolvedValueOnce({ isFile: () => true, size: 4 } as never)
      .mockResolvedValueOnce({ isFile: () => true, size: 5 } as never);
    const readFile = vi.spyOn(fs, "readFile").mockResolvedValue("safe" as never);
    try {
      await expect(readRegularFileUtf8("virtual", 8)).rejects.toThrow(
        /file-grew-during-read/,
      );
      expect(stat).toHaveBeenCalledTimes(2);
    } finally {
      stat.mockRestore();
      readFile.mockRestore();
    }
  });

  it("rejects a directory", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "directory");
      await mkdir(path);
      await expect(readRegularFileUtf8(path)).rejects.toThrow(/not-a-regular-file/);
    });
  });

  it.skipIf(process.platform === "win32")("rejects a FIFO without opening it", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "stream.fifo");
      await execFileAsync("mkfifo", [path]);
      await expect(readRegularFileUtf8(path)).rejects.toThrow(/not-a-regular-file/);
    });
  });
});
