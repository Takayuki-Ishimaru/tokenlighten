// Idempotency invariant: running injectAll twice with identical config MUST
// produce zero diff on the second run (no writes, all skipped, no mtime change).
// Load-bearing: every write invalidates the Anthropic system-prompt prefix-cache.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { injectAll, removeAll } from "../injectAll.js";
import { FakeClock } from "../clock.js";

const STUB_FILES = [
  "CLAUDE.md",
  ".github/copilot-instructions.md",
  ".cursor/rules/tokenlighten.mdc",
  ".clinerules/tokenlighten.md",
  ".continue/rules/tokenlighten.md",
] as const;

const ALL_FILES = ["AGENTS.md", ...STUB_FILES] as const;

function makeTempRepo(): string {
  return mkdtempSync(join(tmpdir(), "tl-agents-idempotent-"));
}

function getMtimes(repo: string, files: readonly string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const f of files) {
    try {
      result[f] = statSync(join(repo, f)).mtimeMs;
    } catch {
      result[f] = -1;
    }
  }
  return result;
}

describe("removeAll managed guide blocks", () => {
  let repo: string;

  beforeEach(() => {
    repo = makeTempRepo();
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("previews then removes all six exact managed blocks while preserving user text", async () => {
    await injectAll({ repoRoot: repo, force: true });
    const agents = join(repo, "AGENTS.md");
    writeFileSync(agents, `user-owned prefix\n${readFileSync(agents, "utf8")}`, "utf8");
    const before = readFileSync(agents, "utf8");

    const preview = await removeAll({ repoRoot: repo, dryRun: true });
    expect(preview.errors).toEqual([]);
    expect(preview.planned).toHaveLength(ALL_FILES.length);
    expect(preview.removed).toEqual([]);
    expect(readFileSync(agents, "utf8")).toBe(before);

    const removed = await removeAll({ repoRoot: repo });
    expect(removed.errors).toEqual([]);
    expect(removed.removed).toHaveLength(ALL_FILES.length);
    expect(readFileSync(agents, "utf8")).toContain("user-owned prefix");
    for (const file of ALL_FILES) {
      expect(readFileSync(join(repo, file), "utf8"))
        .not.toContain("tokenlighten:mcp-instructions:start");
    }
  });

  it("fails closed when the requested repository root does not exist", async () => {
    const missing = join(repo, "missing-root");
    const removed = await removeAll({ repoRoot: missing, dryRun: true });
    expect(removed.planned).toEqual([]);
    expect(removed.removed).toEqual([]);
    expect(removed.errors).toContainEqual({
      path: missing,
      reason: expect.stringContaining("invalid-repo-root"),
    });
  });

  it("fails closed on a symlink and preserves its external target", async () => {
    await injectAll({ repoRoot: repo, force: true });
    const external = `${repo}-external.md`;
    const stub = join(repo, "CLAUDE.md");
    rmSync(stub);
    writeFileSync(external, "external-user-text\n", "utf8");
    symlinkSync(external, stub);
    try {
      const removed = await removeAll({ repoRoot: repo });
      expect(removed.errors).toContainEqual({
        path: "CLAUDE.md",
        reason: expect.stringContaining("read-refused"),
      });
      expect(readFileSync(external, "utf8")).toBe("external-user-text\n");
    } finally {
      rmSync(external, { force: true });
    }
  });
});

describe("injectAll idempotency", () => {
  let repo: string;

  beforeEach(() => {
    repo = makeTempRepo();
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("first run writes AGENTS.md + all 5 stub files", async () => {
    const clock = new FakeClock(1_000_000);
    const result1 = await injectAll({
      repoRoot: repo,
      driftMode: "auto-rewrite",
      clock,
    });

    // AGENTS.md + 5 stubs = 6 files written on first run
    expect(result1.wrote).toHaveLength(6);
    expect(result1.wrote).toContain("AGENTS.md");
    for (const f of STUB_FILES) {
      expect(result1.wrote).toContain(f);
    }
    expect(result1.skipped).toHaveLength(0);
  });

  it("second run writes 0 files and skips all 6 as already-up-to-date", async () => {
    const clock = new FakeClock(1_000_000);
    const config = { repoRoot: repo, driftMode: "auto-rewrite" as const, clock };

    await injectAll(config);
    // Advance fake clock so any write would produce a detectably different mtime
    await new Promise((r) => setTimeout(r, 5));
    const result2 = await injectAll(config);

    expect(result2.wrote).toHaveLength(0);
    expect(result2.skipped).toHaveLength(6);
    for (const item of result2.skipped) {
      expect(item.reason).toBe("already-up-to-date");
    }
  });

  it("file mtimes after run 2 equal mtimes after run 1 (no writes on second run)", async () => {
    const clock = new FakeClock(1_000_000);
    const config = { repoRoot: repo, driftMode: "auto-rewrite" as const, clock };

    await injectAll(config);
    const mtimes1 = getMtimes(repo, ALL_FILES);

    // Sleep 5ms so that any unintended write would produce a newer mtime
    await new Promise((r) => setTimeout(r, 5));

    await injectAll(config);
    const mtimes2 = getMtimes(repo, ALL_FILES);

    for (const f of ALL_FILES) {
      expect(mtimes2[f]).toBe(mtimes1[f]);
    }
  });

  it("each file written on first run matches a stable snapshot shape (sentinel block present)", async () => {
    const { readFileSync } = await import("node:fs");
    const clock = new FakeClock(1_000_000);
    await injectAll({ repoRoot: repo, driftMode: "auto-rewrite", clock });

    for (const f of ALL_FILES) {
      const content = readFileSync(join(repo, f), "utf8");
      expect(content).toContain("<!-- tokenlighten:mcp-instructions:start -->");
      expect(content).toContain("<!-- tokenlighten:mcp-instructions:end -->");
      expect(content).toContain("tl-instructions-sha256:");
      expect(content).toContain("tl-instructions-version:");
    }
  });
});
