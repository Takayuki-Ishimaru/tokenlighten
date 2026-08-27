// Round-trip coverage for the "compact" GuideProfile through injectAll,
// mirroring injectAll.spec.ts's own per-target patterns. Compact was wired
// as a first-class GuideProfile (alongside full/medium) in the 2026-08-27
// compact/medium first-class wave — see render.ts's renderCompactBlock/
// loadCompactTemplate. The default profile stays "full"; these tests only
// cover the opt-in `profile: "compact"` path across every stub target and
// both locales.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { injectAll } from "../injectAll.js";
import { renderBlock, renderCanonicalBlock, blockSha256, INSTRUCTIONS_VERSION } from "../render.js";

function makeTempRepo(): string {
  return mkdtempSync(join(tmpdir(), "tl-agents-compact-"));
}

function readFile(repo: string, relPath: string): string {
  return readFileSync(join(repo, relPath), "utf8");
}

const ALL_STUB_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  ".github/copilot-instructions.md",
  ".cursor/rules/tokenlighten.mdc",
  ".clinerules/tokenlighten.md",
  ".continue/rules/tokenlighten.md",
];

describe("compact GuideProfile round-trip via injectAll (all targets, both locales)", () => {
  let repo: string;

  beforeEach(() => {
    repo = makeTempRepo();
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  for (const locale of ["en", "jp"] as const) {
    it(`writes all ${ALL_STUB_FILES.length} files with the compact heading (${locale})`, async () => {
      const result = await injectAll({ repoRoot: repo, driftMode: "auto-rewrite", profile: "compact", locale });

      for (const f of ALL_STUB_FILES) {
        expect(result.wrote).toContain(f);
        expect(existsSync(join(repo, f))).toBe(true);
      }

      // CLAUDE.md stays the @AGENTS.md import stub regardless of profile.
      expect(readFile(repo, "CLAUDE.md")).toContain("@AGENTS.md");

      // Every other stub gets the compact body, not the full one.
      const fullBodyTargets = ALL_STUB_FILES.filter((f) => f !== "CLAUDE.md");
      for (const target of fullBodyTargets) {
        const content = readFile(repo, target);
        expect(content, target).toContain("## TokenLighten MCP (compact)");
        expect(content, target).toContain(INSTRUCTIONS_VERSION);
        expect(content, target).toContain("read_file");
        expect(content, target).toContain("SAFE-STOP");
        // The deep, full-only rules stay absent from the compact body.
        expect(content, target).not.toContain("brace_delta");
      }

      // cursor/continue keep their tool-native frontmatter ahead of the block.
      expect(readFile(repo, ".cursor/rules/tokenlighten.mdc"))
        .toMatch(/^---\ndescription: TokenLighten MCP evidence-first routing/);
      expect(readFile(repo, ".continue/rules/tokenlighten.md"))
        .toMatch(/^---\nname: TokenLighten MCP workflow/);
    });

    it(`is idempotent on a second run with no changes (${locale})`, async () => {
      await injectAll({ repoRoot: repo, driftMode: "auto-rewrite", profile: "compact", locale });
      const result = await injectAll({ repoRoot: repo, driftMode: "auto-rewrite", profile: "compact", locale });

      expect(result.wrote).toEqual([]);
      for (const f of ALL_STUB_FILES) {
        expect(result.skipped.some((s) => s.path === f && s.reason === "already-up-to-date")).toBe(true);
      }
    });

    it(`round-trips through renderBlock/blockSha256 exactly like injectAll wrote it, with a real embedded sha256 (${locale})`, async () => {
      await injectAll({ repoRoot: repo, driftMode: "auto-rewrite", profile: "compact", locale });

      const canonical = renderCanonicalBlock(locale, INSTRUCTIONS_VERSION, "compact");
      const sha = blockSha256(locale, INSTRUCTIONS_VERSION, undefined, "compact");
      expect(readFile(repo, "AGENTS.md")).toBe(canonical);
      // Proves "version/sha substitution identical to other profiles": the
      // sha embedded in the rendered block matches blockSha256's own
      // independently computed value, exactly like full/medium.
      expect(canonical).toContain(sha);

      const cursorBlock = renderBlock("cursor", locale, INSTRUCTIONS_VERSION, "compact");
      expect(readFile(repo, ".cursor/rules/tokenlighten.mdc")).toBe(cursorBlock);
    });
  }

  it("switching profile full -> compact replaces the managed block but preserves content outside it", async () => {
    await injectAll({ repoRoot: repo, driftMode: "auto-rewrite" }); // full (default)
    const before = readFile(repo, "AGENTS.md");
    writeFileSync(join(repo, "AGENTS.md"), `${before}\n## My own notes\n\nkeep me\n`, "utf8");

    await injectAll({ repoRoot: repo, driftMode: "auto-rewrite", profile: "compact" });

    const agents = readFile(repo, "AGENTS.md");
    expect(agents).toContain("## TokenLighten MCP (compact)");
    expect(agents).toContain("keep me");
  });

  it("switching profile compact -> full restores the full stable-prefix guide", async () => {
    await injectAll({ repoRoot: repo, driftMode: "auto-rewrite", profile: "compact" });
    await injectAll({ repoRoot: repo, driftMode: "auto-rewrite" });

    const agents = readFile(repo, "AGENTS.md");
    expect(agents).not.toContain("## TokenLighten MCP (compact)");
  });
});
