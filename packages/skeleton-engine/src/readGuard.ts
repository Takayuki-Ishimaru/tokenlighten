import { promises as fs } from "node:fs";

/** Same 64 MiB file-content cap used by the MCP read-path contract. */
export const READ_PATH_MAX_BYTES = 64 * 1024 * 1024;

export class UnsafeReadPathError extends Error {
  constructor(path: string, reason: string) {
    super(`unsafe-read-path: ${path}: ${reason}`);
    this.name = "UnsafeReadPathError";
  }
}

/**
 * Read UTF-8 only after proving that the target is a bounded regular file.
 *
 * The post-read stat rejects a file that grew while its bytes were read. This
 * is a fail-closed size-race guard, not a substitute for descriptor-relative
 * path resolution; the latter is designed in DESIGN-v0.10-nofollow-fd-plan.md.
 */
export async function readRegularFileUtf8(
  path: string,
  maxBytes = READ_PATH_MAX_BYTES,
): Promise<string> {
  const before = await fs.stat(path);
  if (!before.isFile()) {
    throw new UnsafeReadPathError(path, "not-a-regular-file");
  }
  if (before.size > maxBytes) {
    throw new UnsafeReadPathError(path, `file-too-large (${before.size} > ${maxBytes})`);
  }

  const content = await fs.readFile(path, "utf8");
  const contentBytes = Buffer.byteLength(content, "utf8");
  if (contentBytes > maxBytes) {
    throw new UnsafeReadPathError(
      path,
      `content-too-large-after-read (${contentBytes} > ${maxBytes})`,
    );
  }

  const after = await fs.stat(path);
  if (!after.isFile()) {
    throw new UnsafeReadPathError(path, "not-a-regular-file-after-read");
  }
  if (after.size > maxBytes) {
    throw new UnsafeReadPathError(path, `file-too-large-after-read (${after.size} > ${maxBytes})`);
  }
  if (after.size > before.size) {
    throw new UnsafeReadPathError(path, `file-grew-during-read (${before.size} -> ${after.size})`);
  }

  return content;
}
