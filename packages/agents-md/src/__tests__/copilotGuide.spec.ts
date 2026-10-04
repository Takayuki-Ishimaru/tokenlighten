// copilotGuide.spec.ts — VS Code Copilot standard-setup evaluation (2026-10-02).
//
// Copilot attaches AGENTS.md in full to every request; the full TokenLighten
// guide paid at each conversation's cold start was the dominant TokenLighten
// cost the evaluation measured. The `standalone`
// CopilotGuideMode renders Copilot's own two files self-contained so setup
// can stop Copilot attaching an AGENTS.md that holds nothing but TL's block
// (packages/cli workspace.ts) — AGENTS.md itself is untouched.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  copilotGuideModeForWorkspace,
  holdsOnlyManagedBlock,
  parseJsonc,
  readWorkspaceSettings,
} from "../copilotGuide.js";
import { injectAll } from "../injectAll.js";
import { blockSha256, renderBlock, renderCanonicalBlock, renderTargetPreamble, INSTRUCTIONS_VERSION } from "../render.js";
import { SENTINEL_END, SENTINEL_START } from "../sentinel.js";

const BLOCK = `${SENTINEL_START}\n<!-- tl-instructions-version: x -->\nbody\n${SENTINEL_END}\n`;

describe("holdsOnlyManagedBlock", () => {
  it("is true for nothing at all, whitespace, and TokenLighten's block alone (BOM and surrounding whitespace aside)", () => {
    expect(holdsOnlyManagedBlock("")).toBe(true);
    expect(holdsOnlyManagedBlock("\n  \n")).toBe(true);
    expect(holdsOnlyManagedBlock(BLOCK)).toBe(true);
    expect(holdsOnlyManagedBlock(`﻿\n${BLOCK}\n\n`)).toBe(true);
    expect(holdsOnlyManagedBlock(renderCanonicalBlock())).toBe(true);
  });

  it("is false for any content of the user's, before or after the block, or with no block at all", () => {
    expect(holdsOnlyManagedBlock(`# Project rules\n\n${BLOCK}`)).toBe(false);
    expect(holdsOnlyManagedBlock(`${BLOCK}\nAlways run the linter.\n`)).toBe(false);
    expect(holdsOnlyManagedBlock("Always run the linter.\n")).toBe(false);
  });

  it("is false for a block that repeats or never closes", () => {
    expect(holdsOnlyManagedBlock(`${BLOCK}${BLOCK}`)).toBe(false);
    expect(holdsOnlyManagedBlock(`${SENTINEL_START}\nbody\n`)).toBe(false);
  });
});

describe("standalone Copilot stubs", () => {
  const standalone = renderBlock("copilot", "en", INSTRUCTIONS_VERSION, "full", "full", "standalone");
  const pointer = renderBlock("copilot", "en", INSTRUCTIONS_VERSION, "full", "full");

  it("are self-contained: the protocol's own rules, no pointer to AGENTS.md, and the Copilot-only notes kept", () => {
    expect(standalone).toContain("# TokenLighten MCP - GitHub Copilot");
    expect(standalone).not.toContain("TL protocol: `AGENTS.md`; follow it");
    expect(standalone).toContain("Do not fetch AGENTS.md/CLAUDE.md for this protocol");
    // v102: the edit/search call shapes live in the tool descriptions, which
    // a Copilot model reads before calling either tool; the guide keeps the
    // routing and every reply-handling rule.
    for (const rule of ["act.answer", "discover", "await_input", "refusal", "read.receipt", "task.force_serve", "tl_search_files", "tl_edit_file", "edit.state_unknown", "edit.rolled_back"]) {
      expect(standalone, rule).toContain(rule);
    }
    // The Copilot-only notes the pointer carried.
    expect(standalone).toContain("Large tool result");
    expect(standalone).toContain("tokenlighten-explore");
  });

  it("carry the sentinel, the version and a sha that blockSha256 reproduces — distinct from the pointer's", () => {
    expect(standalone.startsWith(SENTINEL_START)).toBe(true);
    expect(standalone).toContain(`<!-- tl-instructions-version: ${INSTRUCTIONS_VERSION} -->`);
    const sha = blockSha256("en", INSTRUCTIONS_VERSION, "copilot", "full", "full", "standalone");
    expect(standalone).toContain(`<!-- tl-instructions-sha256: ${sha} -->`);
    expect(sha).not.toBe(blockSha256("en", INSTRUCTIONS_VERSION, "copilot", "full", "full"));
  });

  it("are locale-, profile- and tool-surface-invariant, like the pointer", () => {
    expect(renderBlock("copilot", "jp", INSTRUCTIONS_VERSION, "compact", "code", "standalone")).toBe(standalone);
  });

  it("leave the default (agents-md) rendering byte-for-byte unchanged", () => {
    expect(pointer).toBe(renderBlock("copilot"));
    expect(pointer).toContain("TL protocol: `AGENTS.md`; follow it");
  });

  it("puts a ready first inspection call before lookup alternatives and gates native fallback", () => {
    const first = standalone.split("\n").find((line) => line.startsWith("1. FIRST source inspection:"))!;
    expect(first).toContain("mcp__tokenlighten_tl_read_file");
    expect(standalone).not.toContain("tool_search");
    const example = JSON.parse(first.split("`")[3]);
    expect(example).toEqual({ query: "<entire user request, verbatim>", task: { epoch: "new" } });
    expect(first).toContain('read-only => add `"profile":"answer"` inside `task`');
    expect(first).toContain("targets:[{path},...]");
    expect(first).toContain("replaces grep_search/semantic_search/read_file");
    expect(standalone).toContain("Batch independent context calls with TL.");
    expect(standalone).toContain("Native search/read only when TL is unavailable, the user asks for native, or TL reports incomplete scope/verified absence.");
    expect(standalone).toContain("mcp__tokenlighten_tl_search_files");
    expect(standalone).toContain("mcp__tokenlighten_tl_edit_file");
    expect(standalone).toContain("`whole:true` means `context` is already read");
    expect(standalone).toContain("answer from exact `evidence[].body`");
    expect(standalone).toContain("No re-read of served files");
    expect(standalone).not.toMatch(/`(?:read_file|edit_file|search_files) \{/u);
    expect(standalone.indexOf("1. FIRST")).toBeLessThan(standalone.indexOf("2. `act.answer`"));
    expect(standalone.indexOf("2. `act.answer`")).toBeLessThan(standalone.indexOf("3. Native"));
    // Concrete references must survive rendering in both setup guide modes.
    expect(pointer).toContain("mcp__tokenlighten_tl_read_file");
  });

  it("stay compact: the whole point is to replace a ~12.5 KB attachment", () => {
    // Measured 2026-10-02: 2,396 B after the review added the done / none /
    // edit.state_unknown / edit.rolled_back rules, 2,526 B with the
    // task.profile line. v101 (2026-10-03, Copilot retest r5): 2,031 B — a
    // model without tool_search pays this attachment on every round, so the
    // same rules are stated in fewer words. Ceiling = a little headroom.
    // v102 (Copilot retest r6): 1,843 B — the edit/search call shapes moved
    // to the tool descriptions the model reads anyway.
    expect(Buffer.byteLength(standalone, "utf8")).toBeLessThanOrEqual(1850);
    expect(Buffer.byteLength(standalone, "utf8")).toBeLessThan(Buffer.byteLength(renderCanonicalBlock(), "utf8") / 4);
  });

  it("the exploration subagent keeps its frontmatter and rules but no longer points at AGENTS.md", () => {
    const agent = renderBlock("copilot-agent", "en", INSTRUCTIONS_VERSION, "full", "full", "standalone");
    expect(agent.startsWith(renderTargetPreamble("copilot-agent"))).toBe(true);
    expect(agent).not.toContain("AGENTS.md");
    expect(agent).toContain("the rules below are the TL protocol");
    expect(agent).toContain("never call `tl_edit_file`");
    expect(renderBlock("copilot-agent")).toContain("follow the protocol in `AGENTS.md`");
  });

  // v105: `tokenlighten-explore` is also the user's selectable read-only mode.
  // Both Copilot guide modes must give the picker the same guarantees, because
  // either can be what setup writes; and the file stays model-neutral -- no
  // benchmark hint, and nothing that touches the user's model/agent selection.
  it("makes the custom agent a user-selectable read-only mode in either guide mode", () => {
    for (const mode of ["agents-md", "standalone"] as const) {
      const agent = renderBlock("copilot-agent", "en", INSTRUCTIONS_VERSION, "full", "full", mode);
      expect(agent.startsWith(renderTargetPreamble("copilot-agent")), mode).toBe(true);
      expect(agent, mode).toContain("user-invocable: true");
      expect(agent.match(/^user-invocable:/gm)?.length, mode).toBe(1);
      expect(agent, mode).toContain("tools:\n  - tokenlighten/tl_read_file\n  - tokenlighten/tl_search_files\n");
      expect(agent, mode).not.toContain("tokenlighten/tl_edit_file");
      expect(agent, mode).not.toContain("tokenlighten/*");
      // The read-only request opens with TL's answer profile...
      expect(agent, mode).toContain('task:{epoch:"new",profile:"answer"}');
      // ...and hands anything that needs a write, or a missing TL, back to the user.
      expect(agent, mode).toContain("For changes or unavailable TL, ask the user to switch to Agent.");
      // No benchmark hints and no model/selection settings in a generated file.
      expect(agent, mode).not.toContain("tool_search");
      expect(agent.slice(0, agent.indexOf("\n---\n")), mode).not.toMatch(/^model:/m);
      expect(agent.slice(0, agent.indexOf("\n---\n")), mode).not.toMatch(/temperature|reasoning-effort/u);
    }
  });

  it("keeps the agent body locale-, profile- and surface-invariant in either guide mode", () => {
    for (const mode of ["agents-md", "standalone"] as const) {
      const base = renderBlock("copilot-agent", "en", INSTRUCTIONS_VERSION, "full", "full", mode);
      expect(renderBlock("copilot-agent", "jp", INSTRUCTIONS_VERSION, "compact", "code", mode)).toBe(base);
      expect(renderBlock("copilot-agent", "en", INSTRUCTIONS_VERSION, "medium", "full", mode)).toBe(base);
    }
  });
});

describe("injectAll copilotGuide", () => {
  let repo: string;
  const read = (rel: string): string => readFileSync(join(repo, rel), "utf8");
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "tl-copilot-guide-"));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("renders both Copilot files standalone while AGENTS.md keeps the requested profile", async () => {
    await injectAll({ repoRoot: repo, driftMode: "auto-rewrite", targets: ["claude", "copilot", "copilot-agent"], copilotGuide: "standalone" });
    expect(read(".github/copilot-instructions.md")).toBe(renderBlock("copilot", "en", INSTRUCTIONS_VERSION, "full", "full", "standalone"));
    expect(read(".github/agents/tokenlighten-explore.agent.md")).toBe(
      renderBlock("copilot-agent", "en", INSTRUCTIONS_VERSION, "full", "full", "standalone"),
    );
    expect(read("AGENTS.md")).toBe(renderCanonicalBlock());
  });

  it("is idempotent, and switches modes in place (a switch rewrites the block, like a profile switch)", async () => {
    await injectAll({ repoRoot: repo, driftMode: "auto-rewrite", targets: ["copilot"], copilotGuide: "standalone" });
    const second = await injectAll({ repoRoot: repo, driftMode: "auto-rewrite", targets: ["copilot"], copilotGuide: "standalone" });
    expect(second.skipped.find((item) => item.path === ".github/copilot-instructions.md")?.reason).toBe("already-up-to-date");

    const back = await injectAll({ repoRoot: repo, driftMode: "auto-rewrite", targets: ["copilot"], copilotGuide: "agents-md" });
    expect(back.wrote).toContain(".github/copilot-instructions.md");
    expect(read(".github/copilot-instructions.md")).toBe(renderBlock("copilot"));
  });

  it("keeps a user's own text around the Copilot block, in either mode", async () => {
    mkdirSync(dirname(join(repo, ".github/copilot-instructions.md")), { recursive: true });
    writeFileSync(join(repo, ".github/copilot-instructions.md"), "# Team notes\n\nUse pnpm.\n");
    await injectAll({ repoRoot: repo, driftMode: "auto-rewrite", targets: ["copilot"], copilotGuide: "standalone" });
    const text = read(".github/copilot-instructions.md");
    expect(text).toContain("Use pnpm.");
    expect(text).toContain("# TokenLighten MCP - GitHub Copilot");
  });

  // Review 2026-10-02 (P1): every other generator (`tl-agents update`/`check`,
  // `tl clients …`) calls injectAll without a Copilot guide; it must keep the
  // one the workspace's settings give Copilot, never revert it to a pointer at
  // an AGENTS.md Copilot no longer attaches.
  it("without a requested guide, follows the workspace's .vscode/settings.json (VS Code's JSONC included)", async () => {
    mkdirSync(join(repo, ".vscode"), { recursive: true });
    writeFileSync(join(repo, ".vscode/settings.json"), "{\n  // set by tl workspace setup\n  \"chat.useAgentsMdFile\": false,\n}\n");
    await injectAll({ repoRoot: repo, driftMode: "auto-rewrite", targets: ["copilot", "copilot-agent"] });
    expect(read(".github/copilot-instructions.md")).toBe(renderBlock("copilot", "en", INSTRUCTIONS_VERSION, "full", "full", "standalone"));
    expect(read(".github/agents/tokenlighten-explore.agent.md")).toBe(
      renderBlock("copilot-agent", "en", INSTRUCTIONS_VERSION, "full", "full", "standalone"),
    );

    const exitCode = process.exitCode;
    try {
      const check = await injectAll({ repoRoot: repo, driftMode: "fail-build", targets: ["copilot", "copilot-agent"] });
      expect(check.drifted).toEqual([]);
    } finally {
      process.exitCode = exitCode;
    }
  });

  it("switches guides without a backup or a 'manual edits' warning — the old block is TokenLighten's own rendering", async () => {
    await injectAll({ repoRoot: repo, driftMode: "auto-rewrite", targets: ["copilot"], copilotGuide: "standalone" });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const back = await injectAll({ repoRoot: repo, driftMode: "auto-rewrite", targets: ["copilot"] });
      expect(back.wrote).toContain(".github/copilot-instructions.md");
      expect(stderr.mock.calls.map((call) => String(call[0])).join("")).not.toContain("manual edits");
    } finally {
      stderr.mockRestore();
    }
    expect(read(".github/copilot-instructions.md")).toBe(renderBlock("copilot"));
    expect(existsSync(join(repo, ".tokenlighten/backups"))).toBe(false);
  });

  it("a guide-profile switch of AGENTS.md is a settings switch too, while a hand-edited block is still backed up", async () => {
    await injectAll({ repoRoot: repo, driftMode: "auto-rewrite", targets: [] });
    await injectAll({ repoRoot: repo, driftMode: "auto-rewrite", targets: [], profile: "compact" });
    expect(read("AGENTS.md")).toBe(renderCanonicalBlock("en", INSTRUCTIONS_VERSION, "compact"));
    expect(existsSync(join(repo, ".tokenlighten/backups"))).toBe(false);

    // A hand edit inside the block (its sha line untouched) is no rendering of
    // TokenLighten's: the switch back keeps today's backup and warning.
    writeFileSync(join(repo, "AGENTS.md"), read("AGENTS.md").replace("TokenLighten", "TokenLighten (our fork)"));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await injectAll({ repoRoot: repo, driftMode: "auto-rewrite", targets: [], profile: "full" });
      expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain("manual edits");
    } finally {
      stderr.mockRestore();
    }
    expect(read("AGENTS.md")).toBe(renderCanonicalBlock());
    expect(existsSync(join(repo, ".tokenlighten/backups"))).toBe(true);
  });
});

describe("parseJsonc / readWorkspaceSettings — VS Code's settings dialect", () => {
  it("accepts line and block comments and trailing commas, and never touches string contents", () => {
    const text = [
      "﻿{",
      "  // a line comment",
      "  \"a\": \"http://x/*y*/\", /* a block comment */",
      "  \"b\": [1, 2,],",
      "  \"c\": \"say \\\"hi\\\", // not a comment\",",
      "}",
    ].join("\n");
    expect(parseJsonc(text)).toEqual({ a: "http://x/*y*/", b: [1, 2], c: "say \"hi\", // not a comment" });
    expect(parseJsonc("{\"a\": 1, // trailing\n}")).toEqual({ a: 1 });
  });

  it("throws like JSON.parse on text that is not that dialect", () => {
    expect(() => parseJsonc("{ a: 1 }")).toThrow();
    expect(() => parseJsonc("")).toThrow();
  });

  it("reports absent, unreadable and ok, and derives the guide from chat.useAgentsMdFile", () => {
    const root = mkdtempSync(join(tmpdir(), "tl-copilot-settings-"));
    try {
      expect(readWorkspaceSettings(root)).toEqual({ status: "absent" });
      expect(copilotGuideModeForWorkspace(root)).toBe("agents-md");
      mkdirSync(join(root, ".vscode"));
      writeFileSync(join(root, ".vscode/settings.json"), "[1, 2]");
      expect(readWorkspaceSettings(root)).toEqual({ status: "unreadable" });
      writeFileSync(join(root, ".vscode/settings.json"), "{ \"chat.useAgentsMdFile\": true }");
      expect(copilotGuideModeForWorkspace(root)).toBe("agents-md");
      // Only chat.useAgentsMdFile decides: CLAUDE.md's switch (a legacy key TokenLighten no longer writes) never makes a guide standalone.
      writeFileSync(join(root, ".vscode/settings.json"), "{ \"chat.useClaudeMdFile\": false }");
      expect(copilotGuideModeForWorkspace(root)).toBe("agents-md");
      writeFileSync(join(root, ".vscode/settings.json"), "{ \"chat.useAgentsMdFile\": false, }");
      expect(readWorkspaceSettings(root)).toEqual({ status: "ok", document: { "chat.useAgentsMdFile": false } });
      expect(copilotGuideModeForWorkspace(root)).toBe("standalone");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
