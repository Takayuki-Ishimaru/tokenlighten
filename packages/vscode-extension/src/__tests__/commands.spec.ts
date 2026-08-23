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
  mockShowQuickPick,
  mockCreateWebviewPanel,
  mockRegisterCommand,
  mockConfigurationUpdate,
  mockExecuteCommand,
  mockActivationState,
  mockActivationStateCached,
  mockWorkspaceMcpSettings,
  mockSetWorkspaceConfigured,
  mockShowDiagnosticsPanel,
  mockLanguage,
} = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockShowInformationMessage: vi.fn(),
  mockShowWarningMessage: vi.fn(),
  mockShowSaveDialog: vi.fn(),
  mockShowQuickPick: vi.fn(),
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
  mockWorkspaceMcpSettings: vi.fn(() => ({ usageLoggingEnabled: true })),
  mockSetWorkspaceConfigured: vi.fn(),
  mockShowDiagnosticsPanel: vi.fn(),
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
    showQuickPick: mockShowQuickPick,
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
  workspaceMcpSettingsCached: mockWorkspaceMcpSettings,
}));

vi.mock("../diagnosticsPanel.js", () => ({
  showDiagnosticsPanel: mockShowDiagnosticsPanel,
}));

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

import {
  disableWorkspace,
  enableWorkspace,
  exportUsageLogs,
  loadUsageSummary,
  registerCommands,
  setupWorkspace,
  showStatusMenu,
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

  it("labels a workspace whose recorder setting is off", async () => {
    mockWorkspaceMcpSettings.mockReturnValueOnce({ usageLoggingEnabled: false });
    mockSpawn.mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ measuredBaselineCalls: 0 }),
      stderr: "",
    });
    await expect(loadUsageSummary()).resolves.toMatchObject({
      measurementUnavailableReason: "recorder-off",
    });
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
    confidence = status === "estimated" ? "medium" : "unavailable",
  ) => ({
    eventCount: 4,
    successfulCalls: 4,
    failedCalls: 0,
    estimatedResponseTokens: 750,
    measuredBaselineCalls: 3,
    measuredResponseBytes: 400,
    measuredBaselineBytes: 800,
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
      calibration: { sampleCount: 0 },
      warnings: [],
    },
  });

  it("shows calibration progress and measured byte ratio with empty paired logs", async () => {
    mockSpawn.mockResolvedValue({ code: 0, stdout: JSON.stringify(summary("estimated", "low")), stderr: "" });
    await showUsageDashboard({ subscriptions: [] } as never);
    const panel = mockCreateWebviewPanel.mock.results[0]!.value as { webview: { html: string } };
    expect(panel.webview.html).toContain("Calibrating: 0/24 paired samples (medium 12 / high 24).");
    expect(panel.webview.html).toContain("Measured calls: 3; response bytes vs baseline: 50.0%.");
    expect(panel.webview.html).toContain("Calibrating: 0/24 paired samples");
  });

  it("renders distinct measurement-unavailable reasons in English and Japanese", async () => {
    for (const [reason, expected] of [
      ["recorder-off", "Recorder is off."],
      ["log-dir-unavailable", "Usage log directory is unavailable."],
      ["scope-mismatch", "Usage logs do not match this workspace scope."],
    ] as const) {
      const current = summary("estimated", "low") as { measurementUnavailableReason?: string; sessionEstimate: { warnings: string[] } };
      current.measurementUnavailableReason = reason;
      current.sessionEstimate.warnings = [reason];
      mockSpawn.mockResolvedValue({ code: 0, stdout: JSON.stringify(current), stderr: "" });
      await showUsageDashboard({ subscriptions: [] } as never);
      const panel = mockCreateWebviewPanel.mock.results.at(-1)!.value as { webview: { html: string } };
      expect(panel.webview.html).toContain(expected);
    }
    mockLanguage.current = "ja";
    const japanese = summary("estimated", "low") as { measurementUnavailableReason?: string };
    japanese.measurementUnavailableReason = "recorder-off";
    mockSpawn.mockResolvedValue({ code: 0, stdout: JSON.stringify(japanese), stderr: "" });
    await showUsageDashboard({ subscriptions: [] } as never);
    const panel = mockCreateWebviewPanel.mock.results.at(-1)!.value as { webview: { html: string } };
    expect(panel.webview.html).toContain("レコーダーが無効です。");
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
    expect(panel.webview.html).toContain("Confidence: medium.");
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

  it("does not present the 99.9% per-call fallback as a session reduction", async () => {
    const unavailable = summary("provider-logs-unavailable");
    unavailable.estimatedTokenReductionPercent = 99.9;
    mockSpawn.mockResolvedValue({
      code: 0,
      stdout: JSON.stringify(unavailable),
      stderr: "",
    });

    await showUsageDashboard({ subscriptions: [] } as never);

    const panel = mockCreateWebviewPanel.mock.results[0]!.value as {
      webview: { html: string };
    };
    expect(panel.webview.html).not.toContain("99.9%");
    expect(panel.webview.html).toContain(
      "Token and billing reduction estimates are unavailable: no attributable local AI logs for this workspace.",
    );
    expect(panel.webview.html).toContain("Confidence: unavailable.");
  });

  it("hides matched estimates when their calibration confidence is low", async () => {
    const lowConfidence = summary("estimated", "low");
    lowConfidence.sessionEstimate.tokenReductionPercent = 99.9;
    lowConfidence.sessionEstimate.costReductionPercent = 99.8;
    mockSpawn.mockResolvedValue({
      code: 0,
      stdout: JSON.stringify(lowConfidence),
      stderr: "",
    });

    await showUsageDashboard({ subscriptions: [] } as never);

    const panel = mockCreateWebviewPanel.mock.results[0]!.value as {
      webview: { html: string };
    };
    expect(panel.webview.html).not.toContain("99.9%");
    expect(panel.webview.html).not.toContain("99.8%");
    expect(panel.webview.html).toContain(
      "Reduction estimates are hidden because confidence is low.",
    );
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

  it("opens the status menu, which replays the shared unconfigured toast when Status is picked", async () => {
    mockActivationState.mockResolvedValue("not-configured");
    mockShowQuickPick.mockImplementation(
      async (items: Array<{ action: string }>) => items.find((i) => i.action === "status"),
    );
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

describe("showStatusMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLanguage.current = "en";
  });

  function pickedActions(): string[] {
    const items = mockShowQuickPick.mock.calls.at(-1)?.[0] as Array<{ action: string }>;
    return items.map((item) => item.action);
  }

  it("offers Diagnostics first, then Disable, Open Sidebar, and Status when the workspace is ready", async () => {
    mockActivationState.mockResolvedValue("ready");
    mockShowQuickPick.mockResolvedValue(undefined);

    await showStatusMenu({ subscriptions: [] } as never, undefined);

    expect(pickedActions()).toEqual(["diagnostics", "disable", "sidebar", "status"]);
  });

  it("offers Enable instead of Disable when the workspace is configured but disabled", async () => {
    mockActivationState.mockResolvedValue("disabled");
    mockShowQuickPick.mockResolvedValue(undefined);

    await showStatusMenu({ subscriptions: [] } as never, undefined);

    expect(pickedActions()).toEqual(["diagnostics", "enable", "sidebar", "status"]);
  });

  it("offers Set Up when the workspace has never been configured", async () => {
    mockActivationState.mockResolvedValue("not-configured");
    mockShowQuickPick.mockResolvedValue(undefined);

    await showStatusMenu({ subscriptions: [] } as never, undefined);

    expect(pickedActions()).toEqual(["diagnostics", "setup", "sidebar", "status"]);
  });

  it("omits enable/disable/setup when untrusted, no workspace is open, or the CLI is unavailable", async () => {
    for (const state of ["untrusted", "no-workspace", "unavailable"] as const) {
      mockActivationState.mockResolvedValue(state);
      mockShowQuickPick.mockResolvedValue(undefined);

      await showStatusMenu({ subscriptions: [] } as never, undefined);

      expect(pickedActions()).toEqual(["diagnostics", "sidebar", "status"]);
    }
  });

  it("opens the diagnostics panel when Diagnostics is picked", async () => {
    mockActivationState.mockResolvedValue("ready");
    mockShowQuickPick.mockImplementation(
      async (items: Array<{ action: string }>) => items.find((i) => i.action === "diagnostics"),
    );
    const context = { subscriptions: [] as unknown[] };

    await showStatusMenu(context as never, undefined);

    expect(mockShowDiagnosticsPanel).toHaveBeenCalledWith(context);
  });

  it("opens the TokenLighten sidebar when Open Sidebar is picked", async () => {
    mockActivationState.mockResolvedValue("ready");
    mockShowQuickPick.mockImplementation(
      async (items: Array<{ action: string }>) => items.find((i) => i.action === "sidebar"),
    );

    await showStatusMenu({ subscriptions: [] } as never, undefined);

    expect(mockExecuteCommand).toHaveBeenCalledWith("workbench.view.extension.tokenlighten-sidebar");
  });

  it("disables the workspace when Disable is picked", async () => {
    mockActivationState.mockResolvedValue("ready");
    mockShowQuickPick.mockImplementation(
      async (items: Array<{ action: string }>) => items.find((i) => i.action === "disable"),
    );

    await showStatusMenu({ subscriptions: [] } as never, undefined);

    expect(mockConfigurationUpdate).toHaveBeenCalledWith("enabled", false, 3);
  });

  it("enables the workspace when Enable is picked", async () => {
    mockActivationState.mockResolvedValue("disabled");
    mockShowQuickPick.mockImplementation(
      async (items: Array<{ action: string }>) => items.find((i) => i.action === "enable"),
    );

    await showStatusMenu({ subscriptions: [] } as never, undefined);

    expect(mockConfigurationUpdate).toHaveBeenCalledWith("enabled", true, 3);
  });

  it("runs setup when Set Up is picked, reusing the existing setupWorkspace flow", async () => {
    mockActivationState.mockResolvedValue("not-configured");
    mockShowQuickPick.mockImplementation(
      async (items: Array<{ action: string }>) => items.find((i) => i.action === "setup"),
    );
    mockShowInformationMessage.mockResolvedValueOnce("Set up TokenLighten").mockResolvedValueOnce(undefined);
    mockSpawn.mockResolvedValue({ code: 0, stdout: "{}", stderr: "" });
    const bar = { setStale: vi.fn(), setFresh: vi.fn(), setError: vi.fn(), setActivationState: vi.fn() };

    await showStatusMenu({ subscriptions: [] } as never, bar as never);

    expect(bar.setFresh).toHaveBeenCalledOnce();
  });

  it("does nothing when the QuickPick is dismissed", async () => {
    mockActivationState.mockResolvedValue("ready");
    mockShowQuickPick.mockResolvedValue(undefined);

    await showStatusMenu({ subscriptions: [] } as never, undefined);

    expect(mockShowDiagnosticsPanel).not.toHaveBeenCalled();
    expect(mockExecuteCommand).not.toHaveBeenCalled();
    expect(mockConfigurationUpdate).not.toHaveBeenCalled();
    expect(mockShowInformationMessage).not.toHaveBeenCalled();
  });
});

describe("disableWorkspace", () => {
  it("disables TokenLighten for the current workspace folder", async () => {
    await disableWorkspace();
    expect(mockConfigurationUpdate).toHaveBeenCalledWith("enabled", false, 3);
  });
});
