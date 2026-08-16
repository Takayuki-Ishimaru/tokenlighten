/**
 * atomicWrite.spec.ts — tests for retryRename / makeTmpPath helpers.
 *
 * Required coverage (docs/components/06-platform-support.md §10.3):
 *   1. Success path — tmp file is gone after rename completes.
 *   2. EBUSY retry path — renameSync throws EBUSY 4 times, succeeds on attempt 5.
 *
 * Output policy: plain data — no meta envelope.
 * See docs/00-postmortem.md §2.2 for rationale.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync, existsSync, rmSync, renameSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";

afterEach(async () => {
  // nothing to restore — tests use injectable renameFn, no global mocks
});

function makeTmpDir(): string {
  const dir = join(tmpdir(), `tl-aw-test-${randomBytes(6).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeBusyError(): NodeJS.ErrnoException {
  return Object.assign(new Error("EBUSY: resource busy or locked"), {
    code: "EBUSY",
  }) as NodeJS.ErrnoException;
}

describe("retryRename — success path", () => {
  it("renames src to dst and tmp file is gone afterwards", async () => {
    const dir = makeTmpDir();
    const src = join(dir, "source.tmp");
    const dst = join(dir, "target.toml");

    writeFileSync(src, "hello");
    expect(existsSync(src)).toBe(true);

    const { retryRename } = await import("../atomicWrite.js");
    retryRename(src, dst);

    expect(existsSync(src)).toBe(false);
    expect(existsSync(dst)).toBe(true);

    rmSync(dir, { recursive: true });
  });
});

describe("retryRename — EBUSY retry path", () => {
  it("retries EBUSY 4 times then succeeds on 5th attempt", async () => {
    const dir = makeTmpDir();
    const src = join(dir, "source.tmp");
    const dst = join(dir, "target.toml");

    writeFileSync(src, "retried content");

    const { retryRename } = await import("../atomicWrite.js");

    let callCount = 0;
    // Injectable renameFn: throw EBUSY 4x, succeed on 5th.
    const renameFn = (s: string, d: string) => {
      callCount++;
      if (callCount <= 4) {
        throw makeBusyError();
      }
      renameSync(s, d); // real rename on 5th call
    };

    retryRename(src, dst, { attempts: 5, baseMs: 1, capMs: 2, renameFn });

    expect(callCount).toBe(5);
    expect(existsSync(src)).toBe(false);
    expect(existsSync(dst)).toBe(true);

    rmSync(dir, { recursive: true });
  });

  it("throws AtomicWriteError after exhausting all EBUSY attempts", async () => {
    const dir = makeTmpDir();
    const src = join(dir, "source-fail.tmp");
    const dst = join(dir, "target-fail.toml");

    writeFileSync(src, "will not succeed");

    const { retryRename, AtomicWriteError } = await import("../atomicWrite.js");

    // Always throw EBUSY
    const renameFn = (_s: string, _d: string) => {
      throw makeBusyError();
    };

    let threw: unknown;
    try {
      retryRename(src, dst, { attempts: 3, baseMs: 1, capMs: 2, renameFn });
    } catch (e) {
      threw = e;
    }

    expect(threw).toBeInstanceOf(AtomicWriteError);
    // tmp file should be cleaned up after failure
    expect(existsSync(src)).toBe(false);

    rmSync(dir, { recursive: true });
  });

  it("surfaces non-EBUSY errors immediately without retry", async () => {
    const dir = makeTmpDir();
    const src = join(dir, "source-erofs.tmp");
    const dst = join(dir, "target-erofs.toml");

    writeFileSync(src, "read only");

    const { retryRename, AtomicWriteError } = await import("../atomicWrite.js");

    let callCount = 0;
    const renameFn = (_s: string, _d: string) => {
      callCount++;
      throw Object.assign(new Error("EROFS: read-only file system"), {
        code: "EROFS",
      }) as NodeJS.ErrnoException;
    };

    let threw: unknown;
    try {
      retryRename(src, dst, { attempts: 5, baseMs: 1, capMs: 2, renameFn });
    } catch (e) {
      threw = e;
    }

    // Should have thrown immediately without retry — callCount must be 1
    expect(callCount).toBe(1);
    // Error is the original (not wrapped in AtomicWriteError since it's not EBUSY)
    expect(threw).not.toBeInstanceOf(AtomicWriteError);
    expect((threw as NodeJS.ErrnoException).code).toBe("EROFS");

    rmSync(dir, { recursive: true });
  });
});
