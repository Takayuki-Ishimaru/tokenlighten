/**
 * Byte-determinism contract test for buildSkeleton + renderSkeleton.
 *
 * Two runs on the same input must produce IDENTICAL bytes.
 * Required for byte-stable AGENTS.md skeleton sections — the stable-prefix
 * rebuild (docs/06-stable-prefix-rebuild.md §3.7 "byte-stable output が必須")
 * depends on the skeleton being bit-for-bit reproducible so that Anthropic
 * prompt-cache prefixes remain valid across successive runs.
 */

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { buildSkeleton } from "../index.js";
import { renderSkeleton } from "../render.js";

const FIXTURE_ROOT = join(new URL(".", import.meta.url).pathname, "../../test-fixtures/mini-repo");

const defaultConfig = {
  topN: 10,
  noCache: true,
  // Fix the commit so it does not depend on live git state.
  commit: "0000000000000000000000000000000000000000",
};

describe("buildSkeleton byte-determinism", () => {
  it("produces identical bytes on two consecutive runs", async () => {
    const out1 = await buildSkeleton(FIXTURE_ROOT, defaultConfig);
    const md1 = renderSkeleton(out1.skeleton, { fileSignatures: new Map() });

    const out2 = await buildSkeleton(FIXTURE_ROOT, defaultConfig);
    const md2 = renderSkeleton(out2.skeleton, { fileSignatures: new Map() });

    // String equality
    expect(md1).toBe(md2);

    // Buffer-level equality (byte-for-byte)
    expect(Buffer.from(md1).equals(Buffer.from(md2))).toBe(true);
  });

  it("skeleton object is deterministic (JSON.stringify-level)", async () => {
    const out1 = await buildSkeleton(FIXTURE_ROOT, defaultConfig);
    const out2 = await buildSkeleton(FIXTURE_ROOT, defaultConfig);

    // Object-level determinism: the skeleton objects must serialize identically.
    expect(JSON.stringify(out1.skeleton)).toBe(JSON.stringify(out2.skeleton));
  });

  it("output contains only LF line endings (no CRLF)", async () => {
    const out = await buildSkeleton(FIXTURE_ROOT, defaultConfig);
    const md = renderSkeleton(out.skeleton);
    expect(md).not.toMatch(/\r\n/);
    expect(md).not.toMatch(/\r(?!\n)/);
  });

  it("output does not contain absolute paths or hostname", async () => {
    const out = await buildSkeleton(FIXTURE_ROOT, defaultConfig);
    const md = renderSkeleton(out.skeleton);
    // Must not contain the absolute fixture path
    expect(md).not.toContain(FIXTURE_ROOT);
    // Must not contain process.cwd()
    expect(md).not.toContain(process.cwd());
  });

  it("header does not contain a timestamp", async () => {
    const out = await buildSkeleton(FIXTURE_ROOT, defaultConfig);
    const md = renderSkeleton(out.skeleton);
    // ISO 8601 date pattern must not appear in header comment
    const headerEnd = md.indexOf("-->");
    const header = headerEnd > 0 ? md.slice(0, headerEnd) : md;
    expect(header).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
