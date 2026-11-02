// Guide files (AGENTS.md, CLAUDE.md, .github/copilot-instructions.md, ...) are
// project-shared text with no secret in them: a new file takes the process
// default mode (0644 under the usual 022 umask) instead of being forced to
// 0600, and replacing an existing file keeps ITS mode. Backups copy arbitrary
// user text and stay 0600. POSIX modes are meaningless on Windows.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { injectAll, removeAll } from "../injectAll.js";
import { injectForTarget } from "../injectForTarget.js";
import { INSTRUCTIONS_VERSION } from "../render.js";
import { SENTINEL_END, SENTINEL_START } from "../sentinel.js";
import { FakeClock } from "../clock.js";

const posixOnly = process.platform === "win32";
const modeOf = (path: string): number => statSync(path).mode & 0o777;

describe.skipIf(posixOnly)("guide file permissions (POSIX)", () => {
  let repo: string;
  let previousUmask: number;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "tl-agents-mode-"));
    previousUmask = process.umask(0o022);
  });

  afterEach(() => {
    process.umask(previousUmask);
    rmSync(repo, { recursive: true, force: true });
  });

  it("injectAll creates guide files with the umask's normal mode, not 0600", async () => {
    const result = await injectAll({ repoRoot: repo, targets: ["claude", "copilot"], driftMode: "auto-rewrite" });

    expect(result.wrote).toEqual(expect.arrayContaining(["CLAUDE.md", ".github/copilot-instructions.md"]));
    for (const file of ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md"]) {
      expect(modeOf(join(repo, file)), file).toBe(0o644);
    }
    // The directory it created is shareable too.
    expect(modeOf(join(repo, ".github")) & 0o055).toBe(0o055);
  });

  it("follows the umask rather than hard-coding 0644", async () => {
    process.umask(0o077);
    await injectAll({ repoRoot: repo, targets: ["claude"], driftMode: "auto-rewrite" });

    expect(modeOf(join(repo, "CLAUDE.md"))).toBe(0o600);
  });

  it("rewriting an existing guide file keeps that file's mode (wider or narrower)", async () => {
    await injectAll({ repoRoot: repo, targets: ["claude", "copilot"], driftMode: "auto-rewrite" });
    chmodSync(join(repo, "CLAUDE.md"), 0o664);
    chmodSync(join(repo, ".github/copilot-instructions.md"), 0o640);
    chmodSync(join(repo, "AGENTS.md"), 0o600);

    // A different profile forces every managed block to be rewritten.
    const second = await injectAll({ repoRoot: repo, targets: ["claude", "copilot"], driftMode: "auto-rewrite", profile: "full" });

    expect(second.wrote.length).toBeGreaterThan(0);
    expect(modeOf(join(repo, "CLAUDE.md"))).toBe(0o664);
    expect(modeOf(join(repo, ".github/copilot-instructions.md"))).toBe(0o640);
    expect(modeOf(join(repo, "AGENTS.md"))).toBe(0o600);
  });

  it("removeAll keeps the mode of a user file it strips the block from", async () => {
    mkdirSync(dirname(join(repo, "CLAUDE.md")), { recursive: true });
    writeFileSync(join(repo, "CLAUDE.md"), "# My notes\n");
    await injectAll({ repoRoot: repo, targets: ["claude"], driftMode: "auto-rewrite" });
    chmodSync(join(repo, "CLAUDE.md"), 0o664);

    const removed = await removeAll({ repoRoot: repo, targets: ["claude"] });

    expect(removed.errors).toEqual([]);
    expect(readFileSync(join(repo, "CLAUDE.md"), "utf8")).toContain("# My notes");
    expect(modeOf(join(repo, "CLAUDE.md"))).toBe(0o664);
  });

  it("injectForTarget creates AGENTS.md normally and keeps an existing file's mode", async () => {
    await injectForTarget({ repoRoot: repo, repoSkeleton: "stub" });
    expect(modeOf(join(repo, "AGENTS.md"))).toBe(0o644);

    chmodSync(join(repo, "AGENTS.md"), 0o660);
    await injectForTarget({ repoRoot: repo, repoSkeleton: "stub 2" });
    expect(modeOf(join(repo, "AGENTS.md"))).toBe(0o660);
  });

  it("a backup of a hand-edited block stays private (0600), while the rewritten file is shareable", async () => {
    // A block whose recorded sha no longer matches: the rewrite backs up the hand-edited text first.
    writeFileSync(join(repo, "AGENTS.md"), [
      SENTINEL_START,
      `<!-- tl-instructions-version: ${INSTRUCTIONS_VERSION} -->`,
      "<!-- tl-instructions-sha256: " + "d".repeat(64) + " -->",
      "Manually edited content inside block",
      SENTINEL_END,
    ].join("\n") + "\n");

    const result = await injectAll({ repoRoot: repo, driftMode: "auto-rewrite", clock: new FakeClock(123456789) });

    expect(result.wrote).toContain("AGENTS.md");
    const backup = join(repo, ".tokenlighten", "backups", "AGENTS.md.123456789.bak");
    expect(existsSync(backup)).toBe(true);
    expect(modeOf(backup)).toBe(0o600);
    expect(modeOf(join(repo, "AGENTS.md"))).toBe(0o644);
  });
});
