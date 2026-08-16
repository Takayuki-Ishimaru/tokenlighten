/**
 * commands.spec.ts — verify each command spawns the expected tl args
 * and transitions status bar state correctly.
 *
 * Covers: agentsMd.write, skeleton.build, mcp.install, status.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockSpawn,
  mockShowInformationMessage,
  mockShowWarningMessage,
  mockShowSaveDialog,
  mockCreateWebviewPanel,
  mockRegisterCommand,
  mockConfigurationUpdate,
  mockExecuteCommand,
  mockActivationState,
  mockActivationStateCached,
  mockSetWorkspaceConfigured,
  mockLanguage,
} = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockShowInformationMessage: vi.fn(),
  mockShowWarningMessage: vi.fn(),
  mockShowSaveDialog: vi.fn(),
  mockCreateWebviewPanel: vi.fn(() => ({
    webview: {
      html: "",
      onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
    },
  })),
  mockRegisterCommand: vi.fn((_id: string, fn: () => void) => ({ dispose: vi.fn(), _fn: fn })),
  mockConfigurationUpdate: vi.fn().mockResolvedValue(undefined),
  mockExecuteCommand: vi.fn().mockResolvedValue(undefined),
  mockActivationState: vi.fn(),
  mockActivationStateCached: vi.fn(),
  mockSetWorkspaceConfigured: vi.fn(),
  mockLanguage: { current: "en" },
}));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: (_k: string, d: unknown) => d,
      update: mockConfigurationUpdate,
    }),
    isTrusted: true,
    workspaceFolders: [{ uri: { fsPath: "/workspace", path: "/workspace" } }],
  },
  window: {
    showInformationMessage: mockShowInformationMessage,
    showWarningMessage: mockShowWarningMessage,
    showErrorMessage: vi.fn(),
    showSaveDialog: mockShowSaveDialog,
    createWebviewPanel: mockCreateWebviewPanel,
  },
  commands: {
    registerCommand: mockRegisterCommand,
    executeCommand: mockExecuteCommand,
  },
  Uri: {
    parse: (s: string) => ({ fsPath: s }),
    file: (s: string) => ({ fsPath: s }),
  },
  env: {
    get language() {
      return mockLanguage.current;
    },
    openExternal: vi.fn(),
  },
  StatusBarAlignment: { Left: 1 },
  ConfigurationTarget: { Workspace: 2, WorkspaceFolder: 3 },
  ViewColumn: { One: 1 },
}));

vi.mock("node:child_process", () => ({ spawn: mockSpawn }));

vi.mock("../cli.js", () => ({ spawnTl: mockSpawn }));

vi.mock("../workspaceState.js", () => ({
  setWorkspaceConfigured: mockSetWorkspaceConfigured,
  workspaceActivationState: mockActivationState,
  workspaceActivationStateCached: mockActivationStateCached,
}));

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

import {
  enableWorkspace,
  exportUsageLogs,
  loadUsageSummary,
  registerCommands,
  setupWorkspace,
  showUsageDashboard,
  workspaceSetupArgs,
} from "../commands.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockActivationState.mockResolvedValue("ready");
  mockActivationStateCached.mockReturnValue("ready");
});

describe("enableWorkspace", () => {
  it("enables TokenLighten for the current workspace folder", async () => {
    await enableWorkspace();
    expect(mockConfigurationUpdate).toHaveBeenCalledWith("enabled", true, 3);
  });
});

describe("workspaceSetupArgs", () => {
  it("runs the complete, repairable setup for every supported client", () => {
    expect(workspaceSetupArgs("/workspace")).toEqual([
      "workspace",
      "setup",
      "--root",
      "/workspace",
      "--clients",
      "vscode,codex,claude-code",
      "--json",
    ]);
    expect(workspaceSetupArgs("/workspace")).not.toContain("--rules-only");
  });
});

describe("setupWorkspace", () => {
  it("marks setup ready and reloads so configured features start", async () => {
    mockShowInformationMessage
      .mockResolvedValueOnce("Set up TokenLighten")
      .mockResolvedValueOnce(undefined);
    mockSpawn.mockResolvedValue({ code: 0, stdout: "{}", stderr: "" });
    const bar = {
      setStale: vi.fn(),
      setFresh: vi.fn(),
      setError: vi.fn(),
    };

    await setupWorkspace(bar as never);

    expect(mockSetWorkspaceConfigured).toHaveBeenCalledWith("/workspace", true, {
      writeEnabled: true,
      usageLoggingEnabled: true,
    });
    expect(bar.setFresh).toHaveBeenCalledOnce();
    expect(mockExecuteCommand).toHaveBeenCalledWith("workbench.action.reloadWindow");
  });
});

describe("loadUsageSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads usage with the current workspace as the CLI working directory", async () => {
    mockSpawn.mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ estimatedResponseTokens: 750, estimatedSavedTokens: 250 }),
      stderr: "",
    });

    await loadUsageSummary();

    expect(mockSpawn).toHaveBeenCalledWith(
      ["logs", "summary", "--json", "--workspace-root", "/workspace"],
      { cwd: "/workspace" },
    );
  });
});

describe("showUsageDashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLanguage.current = "en";
  });

  const summary = (
    status: "estimated" | "provider-logs-unavailable",
    confidence = status === "estimated" ? "low" : "unavailable",
  ) => ({
    eventCount: 4,
    successfulCalls: 4,
    failedCalls: 0,
    estimatedResponseTokens: 750,
    measuredBaselineCalls: 3,
    estimatedSavedTokens: 250,
    estimatedSavedCostUsd: 0.1,
    estimatedTokenReductionPercent: 12.3,
    estimatedCostReductionPercent: 9.9,
    scope: { kind: "workspace", workspaceId: "opaque" },
    sessionEstimate: {
      status,
      tokenReductionPercent: 45.6,
      costReductionPercent: 34.5,
      matchedSessions: status === "estimated" ? 2 : 0,
      confidence,
    },
  });

  it("shows matched session estimates when attributable AI logs exist", async () => {
    mockSpawn.mockResolvedValue({
      code: 0,
      stdout: JSON.stringify(summary("estimated")),
      stderr: "",
    });

    await showUsageDashboard({ subscriptions: [] } as never);

    const panel = mockCreateWebviewPanel.mock.results[0]!.value as {
      webview: { html: string };
    };
    expect(panel.webview.html).toContain("matched against local AI logs");
    expect(panel.webview.html).toContain("Confidence: low.");
    expect(panel.webview.html).toContain("45.6%");
    expect(panel.webview.html).toContain("34.5%");
  });

  it("shows the dashboard as disabled until workspace setup is verified", async () => {
    mockActivationState.mockResolvedValue("not-configured");
    mockSpawn.mockResolvedValue({
      code: 0,
      stdout: JSON.stringify(summary("estimated")),
      stderr: "",
    });

    await showUsageDashboard({ subscriptions: [] } as never);

    const panel = mockCreateWebviewPanel.mock.results[0]!.value as {
      webview: { html: string };
    };
    expect(panel.webview.html).toContain(
      "TL status in this workspace<div class=\"value\">Disabled</div>",
    );
  });

  it("falls back to measured per-call reduction without attributable logs", async () => {
    mockSpawn.mockResolvedValue({
      code: 0,
      stdout: JSON.stringify(summary("provider-logs-unavailable")),
      stderr: "",
    });

    await showUsageDashboard({ subscriptions: [] } as never);

    const panel = mockCreateWebviewPanel.mock.results[0]!.value as {
      webview: { html: string };
    };
    expect(panel.webview.html).toContain("Measured per-call reduction");
    expect(panel.webview.html).toContain("12.3%");
    expect(panel.webview.html).toContain(
      "Billing estimate unavailable: no attributable local AI logs for this workspace.",
    );
    expect(panel.webview.html).toContain("Confidence: unavailable.");
  });

  it("shows medium confidence in Japanese", async () => {
    mockLanguage.current = "ja";
    mockSpawn.mockResolvedValue({
      code: 0,
      stdout: JSON.stringify(summary("estimated", "medium")),
      stderr: "",
    });

    await showUsageDashboard({ subscriptions: [] } as never);

    const panel = mockCreateWebviewPanel.mock.results[0]!.value as {
      webview: { html: string };
    };
    expect(panel.webview.html).toContain("信頼度: medium。");
  });
});

describe("exportUsageLogs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exports with the current workspace as the CLI working directory", async () => {
    mockShowSaveDialog.mockResolvedValue({ fsPath: "/tmp/workspace-usage.zip" });
    mockSpawn.mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    await exportUsageLogs();

    expect(mockSpawn).toHaveBeenCalledWith(
      [
        "logs",
        "export",
        "--output",
        "/tmp/workspace-usage.zip",
        "--workspace-root",
        "/workspace",
      ],
      { cwd: "/workspace" },
    );
  });
});

describe("registerCommands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLanguage.current = "en";
  });

  it("reports the shared unconfigured state from the status command", async () => {
    mockActivationState.mockResolvedValue("not-configured");
    const context = { subscriptions: [] as unknown[] };
    registerCommands(context as never);
    const statusHandler = mockRegisterCommand.mock.calls.find(
      ([id]) => id === "tokenlighten.status",
    )?.[1] as (() => void) | undefined;

    statusHandler?.();

    await vi.waitFor(() => expect(mockShowInformationMessage).toHaveBeenCalledWith(
      "TokenLighten is not set up in this workspace",
    ));
  });

  it("registers only workspace status, usage, and log actions", () => {
    const context = { subscriptions: [] as unknown[] };
    registerCommands(context as never);

    const ids = mockRegisterCommand.mock.calls.map(([id]) => id);
    expect(ids).toEqual([
      "tokenlighten.status",
      "tokenlighten.usage.show",
      "tokenlighten.logs.export",
    ]);
    expect(ids).not.toContain("tokenlighten.mcp.install");
    expect(ids).not.toContain("tokenlighten.agentsMd.write");
    expect(ids).not.toContain("tokenlighten.skeleton.build");
  });
});
