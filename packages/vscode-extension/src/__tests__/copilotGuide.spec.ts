// copilotGuide.spec.ts — the extension's prediction of whether `tl install`
// leaves GitHub Copilot reading the standalone TokenLighten guide (review of
// the Copilot standard-setup batch, 2026-10-02). commands.ts asks the
// guide-size question only when this says Copilot still attaches AGENTS.md.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  agentsMdHoldsOnlyTokenLighten,
  agentsMdPresent,
  copilotGuideIsStandalone,
  predictStandaloneCopilotGuide,
  predictStandaloneInWorkspaceFile,
  workspaceSettingsWritable,
} from "../copilotGuide.js";

const TL_ONLY = "<!-- tokenlighten:mcp-instructions:start -->\nbody\n<!-- tokenlighten:mcp-instructions:end -->\n";

describe("predictStandaloneCopilotGuide", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tl-ext-copilot-guide-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("unset: standalone only for the standalone request, an AGENTS.md of TokenLighten's alone, and a writable settings file", () => {
    expect(predictStandaloneCopilotGuide(root, "standalone", undefined)).toBe(true);
    writeFileSync(join(root, "AGENTS.md"), TL_ONLY);
    expect(predictStandaloneCopilotGuide(root, "standalone", undefined)).toBe(true);
    expect(predictStandaloneCopilotGuide(root, "agents-md", undefined)).toBe(false);
    expect(predictStandaloneCopilotGuide(root, "keep", undefined)).toBe(false);

    // A JSONC settings file is never rewritten by setup: the question stays.
    mkdirSync(join(root, ".vscode"));
    writeFileSync(join(root, ".vscode", "settings.json"), "{\n  // mine\n}\n");
    expect(predictStandaloneCopilotGuide(root, "standalone", undefined)).toBe(false);
    writeFileSync(join(root, ".vscode", "settings.json"), "{}\n");
    expect(predictStandaloneCopilotGuide(root, "standalone", undefined)).toBe(true);

    writeFileSync(join(root, "AGENTS.md"), `# Team rules\n\n${TL_ONLY}`);
    expect(predictStandaloneCopilotGuide(root, "standalone", undefined)).toBe(false);
  });

  it("an explicit true keeps AGENTS.md attached under every request", () => {
    for (const request of ["standalone", "agents-md", "keep"] as const) {
      expect(predictStandaloneCopilotGuide(root, request, true), request).toBe(false);
    }
  });

  it("an explicit false keeps it off — unless agents-md is asked for and the false is TokenLighten's own", () => {
    writeFileSync(join(root, "AGENTS.md"), "# Team rules\n");
    for (const request of ["standalone", "agents-md", "keep"] as const) {
      expect(predictStandaloneCopilotGuide(root, request, false), request).toBe(true);
    }
    mkdirSync(join(root, ".tokenlighten"));
    writeFileSync(join(root, ".tokenlighten", "copilot-guide.json"), JSON.stringify({ schemaVersion: 1, settings: ["chat.useAgentsMdFile"] }));
    expect(predictStandaloneCopilotGuide(root, "agents-md", false)).toBe(false);
    expect(predictStandaloneCopilotGuide(root, "standalone", false)).toBe(true);
  });
});

// Copilot standard-setup retest (2026-10-02): in a window opened through a
// `.code-workspace` file VS Code ignores the folder's own `chat.useAgentsMdFile`
// (window-scoped setting), so the prediction looks at the workspace file's value
// alone — and never assumes a standalone guide for a value that is not false yet.
describe("predictStandaloneInWorkspaceFile", () => {
  it("assumes standalone only for a workspace-file value that is false already", () => {
    for (const request of ["standalone", "keep"] as const) {
      expect(predictStandaloneInWorkspaceFile(request, false, false), request).toBe(true);
      expect(predictStandaloneInWorkspaceFile(request, false, true), request).toBe(true);
      expect(predictStandaloneInWorkspaceFile(request, undefined, false), request).toBe(false);
      expect(predictStandaloneInWorkspaceFile(request, undefined, true), request).toBe(false);
      expect(predictStandaloneInWorkspaceFile(request, true, false), request).toBe(false);
    }
  });

  it("agents-md withdraws a false this extension set, and leaves one the user wrote", () => {
    expect(predictStandaloneInWorkspaceFile("agents-md", false, true)).toBe(false);
    expect(predictStandaloneInWorkspaceFile("agents-md", false, false)).toBe(true);
    expect(predictStandaloneInWorkspaceFile("agents-md", undefined, true)).toBe(false);
    expect(predictStandaloneInWorkspaceFile("agents-md", true, false)).toBe(false);
  });

  it("differs from the folder-level prediction exactly where VS Code ignores the folder file: an unset workspace value", () => {
    const root = mkdtempSync(join(tmpdir(), "tl-ext-ws-predict-"));
    try {
      // A folder window: setup will write the folder's false, so standalone is predicted ...
      expect(predictStandaloneCopilotGuide(root, "standalone", undefined)).toBe(true);
      // ... but the same folder opened through a workspace file ignores that file.
      expect(predictStandaloneInWorkspaceFile("standalone", undefined, false)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("agentsMdHoldsOnlyTokenLighten", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tl-ext-agents-md-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("is true for no AGENTS.md or TokenLighten's block alone, false for the user's content", () => {
    expect(agentsMdHoldsOnlyTokenLighten(root)).toBe(true);
    writeFileSync(join(root, "AGENTS.md"), TL_ONLY);
    expect(agentsMdHoldsOnlyTokenLighten(root)).toBe(true);
    writeFileSync(join(root, "AGENTS.md"), `# Team rules\n\n${TL_ONLY}`);
    expect(agentsMdHoldsOnlyTokenLighten(root)).toBe(false);
  });

  // The CLI's own rule (workspace.ts `holdsOnlyTokenLightenGuide`), so the
  // apply command never refuses an `AGENTS.md -> CLAUDE.md` folder the CLI folded.
  it.skipIf(process.platform === "win32")("judges a symlink by its in-folder target, and an out-of-folder target as the user's", () => {
    writeFileSync(join(root, "CLAUDE.md"), TL_ONLY);
    symlinkSync(join(root, "CLAUDE.md"), join(root, "AGENTS.md"));
    expect(agentsMdHoldsOnlyTokenLighten(root)).toBe(true);
    writeFileSync(join(root, "CLAUDE.md"), `# Team rules\n\n${TL_ONLY}`);
    expect(agentsMdHoldsOnlyTokenLighten(root)).toBe(false);
    const outside = mkdtempSync(join(tmpdir(), "tl-agents-outside-"));
    try {
      writeFileSync(join(outside, "AGENTS.md"), TL_ONLY);
      rmSync(join(root, "AGENTS.md"));
      symlinkSync(join(outside, "AGENTS.md"), join(root, "AGENTS.md"));
      expect(agentsMdHoldsOnlyTokenLighten(root)).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// The `.code-workspace` apply flow (commands.ts) writes a workspace-level false
// only when every folder that HAS an AGENTS.md reads the compact guide.
describe("agentsMdPresent / copilotGuideIsStandalone", () => {
  let root: string;
  const writeSettings = (text: string): void => {
    mkdirSync(join(root, ".vscode"), { recursive: true });
    writeFileSync(join(root, ".vscode", "settings.json"), text);
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tl-ext-standalone-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("agentsMdPresent: false with no AGENTS.md, true with one (whatever it holds)", () => {
    expect(agentsMdPresent(root)).toBe(false);
    writeFileSync(join(root, "AGENTS.md"), TL_ONLY);
    expect(agentsMdPresent(root)).toBe(true);
  });

  it("copilotGuideIsStandalone: only a folder whose own settings turn the AGENTS.md attachment off (JSONC included)", () => {
    expect(copilotGuideIsStandalone(root)).toBe(false); // no settings file: agents-md mode
    writeSettings("{ \"chat.useAgentsMdFile\": false }");
    expect(copilotGuideIsStandalone(root)).toBe(true);
    writeSettings("{\n  // set by tl workspace setup\n  \"chat.useAgentsMdFile\": false,\n}\n");
    expect(copilotGuideIsStandalone(root)).toBe(true);
    writeSettings("{ \"chat.useAgentsMdFile\": true }");
    expect(copilotGuideIsStandalone(root)).toBe(false);
    writeSettings("{ \"editor.tabSize\": 2 }");
    expect(copilotGuideIsStandalone(root)).toBe(false);
    writeSettings("[1, 2]");
    expect(copilotGuideIsStandalone(root)).toBe(false);
  });

  it("copilotGuideIsStandalone ignores chat.useClaudeMdFile: only the AGENTS.md attachment decides", () => {
    writeSettings("{ \"chat.useClaudeMdFile\": false }");
    expect(copilotGuideIsStandalone(root)).toBe(false);
  });
});

describe("workspaceSettingsWritable", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tl-ext-settings-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("is true for no file or a strict JSON object, false for JSONC, a non-object, or a symlink", () => {
    expect(workspaceSettingsWritable(root)).toBe(true);
    mkdirSync(join(root, ".vscode"));
    writeFileSync(join(root, ".vscode", "settings.json"), "{\"editor.tabSize\": 2}\n");
    expect(workspaceSettingsWritable(root)).toBe(true);
    writeFileSync(join(root, ".vscode", "settings.json"), "{\"editor.tabSize\": 2,}\n");
    expect(workspaceSettingsWritable(root)).toBe(false);
    writeFileSync(join(root, ".vscode", "settings.json"), "[]\n");
    expect(workspaceSettingsWritable(root)).toBe(false);
    if (process.platform !== "win32") {
      writeFileSync(join(root, "real.json"), "{}\n");
      rmSync(join(root, ".vscode", "settings.json"));
      symlinkSync(join(root, "real.json"), join(root, ".vscode", "settings.json"));
      expect(workspaceSettingsWritable(root)).toBe(false);
    }
  });
});
