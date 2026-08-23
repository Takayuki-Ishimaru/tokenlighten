/**
 * diagnosticsPanel.spec.ts — the vscode-dependent rendering/message layer.
 * collectDiagnostics()/formatDiagnosticsText() (diagnostics.ts) are mocked
 * here — their own real-filesystem behavior is covered by
 * diagnostics.spec.ts; this file verifies the panel wires vscode inputs to
 * them correctly and reacts to the webview's copy/refresh messages.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockCreateWebviewPanel,
  mockClipboardWriteText,
  mockShowInformationMessage,
  mockCollectDiagnostics,
  mockFormatDiagnosticsText,
  mockWorkspaceMcpSettingsCached,
  mockWatch,
  mockWatcherClose,
  languageState,
  workspaceFoldersState,
} = vi.hoisted(() => ({
  mockCreateWebviewPanel: vi.fn(),
  mockClipboardWriteText: vi.fn().mockResolvedValue(undefined),
  mockShowInformationMessage: vi.fn(),
  mockCollectDiagnostics: vi.fn(),
  mockFormatDiagnosticsText: vi.fn(() => "PLAIN TEXT DIAGNOSTICS BLOCK"),
  mockWorkspaceMcpSettingsCached: vi.fn(),
  mockWatcherClose: vi.fn(),
  mockWatch: vi.fn(() => ({ close: mockWatcherClose })),
  languageState: { current: "en" as "en" | "ja" },
  workspaceFoldersState: {
    current: [{ uri: { fsPath: "/workspace" } }] as Array<{ uri: { fsPath: string } }> | undefined,
  },
}));

vi.mock("vscode", () => ({
  window: {
    createWebviewPanel: mockCreateWebviewPanel,
    showInformationMessage: mockShowInformationMessage,
  },
  workspace: {
    get workspaceFolders() {
      return workspaceFoldersState.current;
    },
  },
  env: {
    clipboard: { writeText: mockClipboardWriteText },
  },
  ViewColumn: { One: 1 },
}));

vi.mock("node:fs", () => ({
  watch: mockWatch,
}));

// The panel's live-refresh wiring calls these directly (not through
// diagnostics.js) to compute the ring file's expected basename — stubbed so
// this suite never touches the real filesystem via fs.realpathSync.native on
// a workspace root string ("/workspace") that does not exist on the test
// machine.
vi.mock("@tokenlighten/usage/diag", () => ({
  defaultDiagDir: () => "/fake/diag/dir",
  diagWorkspaceKey: () => "fakekey1234",
}));

vi.mock("../diagnostics.js", () => ({
  collectDiagnostics: mockCollectDiagnostics,
  formatDiagnosticsText: mockFormatDiagnosticsText,
}));

vi.mock("../statusBar.js", () => ({
  getDisplayLanguage: () => languageState.current,
}));

vi.mock("../workspaceState.js", () => ({
  workspaceMcpSettingsCached: mockWorkspaceMcpSettingsCached,
}));

import { showDiagnosticsPanel } from "../diagnosticsPanel.js";

interface FakePanel {
  webview: {
    cspSource: string;
    html: string;
    onDidReceiveMessage: ReturnType<typeof vi.fn>;
  };
  onDidDispose: ReturnType<typeof vi.fn>;
  trigger: (message: unknown) => void;
  dispose: () => void;
}

function makeFakePanel(): FakePanel {
  let html = "";
  let messageHandler: ((message: unknown) => void) | undefined;
  let disposeHandler: (() => void) | undefined;
  const panel: FakePanel = {
    webview: {
      cspSource: "vscode-webview://fake",
      get html() { return html; },
      set html(value: string) { html = value; },
      onDidReceiveMessage: vi.fn((handler: (message: unknown) => void) => {
        messageHandler = handler;
        return { dispose: vi.fn() };
      }),
    },
    onDidDispose: vi.fn((handler: () => void) => {
      disposeHandler = handler;
      return { dispose: vi.fn() };
    }),
    trigger: (message: unknown) => messageHandler?.(message),
    dispose: () => disposeHandler?.(),
  };
  return panel;
}

const sampleSnapshot = {
  extensionVersion: "1.2.3",
  tlVersion: "0.11.0",
  nodeExecutable: "/usr/local/bin/node",
  serverLaunch: { command: "tl", args: ["mcp", "start", "--stdio", "--allow-write"] },
  workspaceRoot: "/workspace",
  writeEnabledSetting: true,
  registrations: {
    claudeMcpJson: { path: "/workspace/.mcp.json", fileExists: true, hasTokenlighten: true, allowWrite: true },
    vscodeMcpJson: { path: "/workspace/.vscode/mcp.json", fileExists: false, hasTokenlighten: false, allowWrite: null },
    codexConfigToml: { path: "/workspace/.codex/config.toml", fileExists: false, hasTokenlighten: false, allowWrite: null },
  },
  guide: {
    installedVersion: "2026-08-22-v72-x",
    bundledVersion: "2026-08-22-v72-x",
    source: "AGENTS.md" as const,
    upToDate: true,
  },
  ring: {
    status: "ok" as const,
    calls: [
      { at: "2026-08-22T00:00:00.000Z", tool: "read_file", mode: "task_pack", kind: "read.task_pack", ms: 12, ok: true },
    ],
  },
};

function fakeContext(): { subscriptions: unknown[]; extension: { packageJSON: Record<string, unknown> } } {
  return { subscriptions: [], extension: { packageJSON: { version: "1.2.3" } } };
}

describe("showDiagnosticsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    languageState.current = "en";
    workspaceFoldersState.current = [{ uri: { fsPath: "/workspace" } }];
    mockCollectDiagnostics.mockReturnValue(sampleSnapshot);
    mockWorkspaceMcpSettingsCached.mockReturnValue({ writeEnabled: true, usageLoggingEnabled: true });
    mockCreateWebviewPanel.mockImplementation(() => makeFakePanel());
  });

  it("shows a no-workspace message instead of collecting diagnostics when no folder is open", () => {
    workspaceFoldersState.current = undefined;

    showDiagnosticsPanel(fakeContext() as never);

    expect(mockCollectDiagnostics).not.toHaveBeenCalled();
    const panel = mockCreateWebviewPanel.mock.results[0]!.value as FakePanel;
    expect(panel.webview.html).toContain("workspace folder");
  });

  it("collects diagnostics from the extension version, workspace root, and cached MCP settings", () => {
    showDiagnosticsPanel(fakeContext() as never);

    expect(mockCollectDiagnostics).toHaveBeenCalledWith({
      extensionVersion: "1.2.3",
      workspaceRoot: "/workspace",
      writeEnabledSetting: true,
      usageLoggingEnabledSetting: true,
    });
  });

  it("falls back to null settings when the workspace has no cached MCP settings", () => {
    mockWorkspaceMcpSettingsCached.mockReturnValue(null);

    showDiagnosticsPanel(fakeContext() as never);

    expect(mockCollectDiagnostics).toHaveBeenCalledWith(
      expect.objectContaining({ writeEnabledSetting: null, usageLoggingEnabledSetting: null }),
    );
  });

  it("renders every collected field into the panel HTML", () => {
    showDiagnosticsPanel(fakeContext() as never);

    const panel = mockCreateWebviewPanel.mock.results[0]!.value as FakePanel;
    const html = panel.webview.html;
    expect(html).toContain("1.2.3");
    expect(html).toContain("0.11.0");
    expect(html).toContain("/usr/local/bin/node");
    expect(html).toContain("/workspace");
    expect(html).toContain(".mcp.json");
    expect(html).toContain("read_file");
    expect(html).toContain("task_pack");
  });

  it("copies the formatted plain-text block to the clipboard and confirms it when Copy is clicked", () => {
    showDiagnosticsPanel(fakeContext() as never);
    const panel = mockCreateWebviewPanel.mock.results[0]!.value as FakePanel;

    panel.trigger({ action: "copy" });

    expect(mockFormatDiagnosticsText).toHaveBeenCalledWith(sampleSnapshot, "en");
    expect(mockClipboardWriteText).toHaveBeenCalledWith("PLAIN TEXT DIAGNOSTICS BLOCK");
    expect(mockShowInformationMessage).toHaveBeenCalled();
  });

  it("re-collects and re-renders when Refresh is clicked", () => {
    showDiagnosticsPanel(fakeContext() as never);
    expect(mockCollectDiagnostics).toHaveBeenCalledTimes(1);
    const panel = mockCreateWebviewPanel.mock.results[0]!.value as FakePanel;

    panel.trigger({ action: "refresh" });

    expect(mockCollectDiagnostics).toHaveBeenCalledTimes(2);
  });

  it("watches the diagnostics directory for live updates and closes the watcher on dispose", () => {
    showDiagnosticsPanel(fakeContext() as never);
    expect(mockWatch).toHaveBeenCalledOnce();
    const panel = mockCreateWebviewPanel.mock.results[0]!.value as FakePanel;

    panel.dispose();

    expect(mockWatcherClose).toHaveBeenCalledOnce();
  });

  it("never throws when fs.watch itself throws (e.g. the diagnostics directory does not exist yet)", () => {
    mockWatch.mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });

    expect(() => showDiagnosticsPanel(fakeContext() as never)).not.toThrow();
  });

  it("renders the Japanese title when the display language is Japanese", () => {
    languageState.current = "ja";

    showDiagnosticsPanel(fakeContext() as never);

    const panel = mockCreateWebviewPanel.mock.results[0]!.value as FakePanel;
    expect(panel.webview.html).toContain("TokenLighten 診断");
  });
});
