import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockRegisterProvider,
  mockLoadUsageSummary,
  mockActivationState,
  activationState,
  configurationState,
} = vi.hoisted(() => ({
  mockRegisterProvider: vi.fn(),
  mockLoadUsageSummary: vi.fn(),
  mockActivationState: vi.fn(),
  activationState: { current: "ready" },
  configurationState: { enabled: true, language: "en" as "auto" | "en" | "ja" },
}));

vi.mock("vscode", () => ({
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  workspace: {
    isTrusted: true,
    workspaceFolders: [{ uri: { fsPath: "/workspace" } }],
    getConfiguration: () => ({
      get: (key: string, defaultValue: unknown) =>
        key === "enabled"
          ? configurationState.enabled
          : key === "language"
            ? configurationState.language
            : defaultValue,
      update: vi.fn().mockResolvedValue(undefined),
    }),
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
    onDidChangeWorkspaceFolders: vi.fn(() => ({ dispose: vi.fn() })),
  },
  window: {
    registerWebviewViewProvider: mockRegisterProvider,
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
  },
  commands: {
    executeCommand: vi.fn(),
    registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
  },
  env: { language: "en" },
  Uri: {
    joinPath: (_base: unknown, ...segments: string[]) => ({
      toString: () => `https://file%2B.vscode-resource.test/${segments.join("/")}`,
    }),
  },
}));

const extensionUriStub = { fsPath: "/extension", scheme: "file" };

vi.mock("../cli.js", () => ({
  getTlVersion: vi.fn(() => "0.9.0"),
}));

vi.mock("../commands.js", () => ({
  loadUsageSummary: mockLoadUsageSummary,
}));

vi.mock("../workspaceState.js", () => ({
  workspaceActivationState: mockActivationState,
}));

import { registerControlCenter } from "../sidebar.js";

describe("TokenLighten sidebar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadUsageSummary.mockResolvedValue({});
    mockActivationState.mockImplementation(async () => activationState.current);
    activationState.current = "ready";
    configurationState.enabled = true;
    configurationState.language = "en";
  });

  it("shows a loading document before the asynchronous summary resolves", () => {
    mockRegisterProvider.mockReturnValue({ dispose: vi.fn() });
    const context = { subscriptions: [] as unknown[], extensionUri: extensionUriStub };
    registerControlCenter(context as never);

    const [, provider] = mockRegisterProvider.mock.calls[0] as [
      string,
      { resolveWebviewView(view: unknown): void },
    ];
    const webview = {
      options: {},
      html: "",
      cspSource: "test",
      asWebviewUri: (uri: unknown) => uri,
      onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
    };
    provider.resolveWebviewView({ webview } as never);

    expect(webview.html).toContain("Loading TokenLighten");
    expect(webview.html).toContain("--brand-orange:#FF6B1A");
  });

  it("shows only workspace-scoped setup, savings, settings, and logs", async () => {
    mockLoadUsageSummary.mockResolvedValue({
      estimatedTokenReductionPercent: 12.3,
      estimatedCostReductionPercent: 4.5,
      sessionEstimate: {
        status: "estimated",
        tokenReductionPercent: 45.6,
        costReductionPercent: 34.5,
      },
    });
    mockRegisterProvider.mockReturnValue({ dispose: vi.fn() });
    const context = { subscriptions: [] as unknown[], extensionUri: extensionUriStub };
    registerControlCenter(context as never);

    const [, provider] = mockRegisterProvider.mock.calls[0] as [
      string,
      { resolveWebviewView(view: unknown): void },
    ];
    const webview = {
      options: {},
      html: "",
      cspSource: "test",
      asWebviewUri: (uri: unknown) => uri,
      onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
    };
    provider.resolveWebviewView({ webview } as never);

    await vi.waitFor(() => expect(webview.html).toContain("tokenlighten.setup"));
    expect(webview.html).toContain("Version: 0.9.0");
    expect(webview.html).toContain("Workspace setup");
    expect(webview.html).toContain("Workspace logs");
    expect(webview.html).toContain(
      "Estimated token reduction in this workspace (matched against local AI logs)",
    );
    expect(webview.html).toContain("45.6%");
    expect(webview.html).toContain(
      "Estimated billing reduction in this workspace (matched against local AI logs)",
    );
    expect(webview.html).toContain("34.5%");
    expect(webview.html).not.toContain("This machine's AI clients");
    expect(webview.html).not.toContain("data-client=");
    expect(webview.html).not.toContain("tokenlighten.mcp.install");
    expect(webview.html).not.toContain("tokenlighten.agentsMd.write");
    expect(webview.html).not.toContain("id=\"cliPath\"");
    expect(webview.html).not.toContain("id=\"tokenCost\"");
  });

  it("shows the measured fallback when attributable AI logs are unavailable", async () => {
    mockLoadUsageSummary.mockResolvedValue({
      estimatedTokenReductionPercent: 12.3,
      estimatedCostReductionPercent: 4.5,
      sessionEstimate: {
        status: "provider-logs-unavailable",
        tokenReductionPercent: null,
        costReductionPercent: null,
      },
    });
    mockRegisterProvider.mockReturnValue({ dispose: vi.fn() });
    const context = { subscriptions: [] as unknown[], extensionUri: extensionUriStub };
    registerControlCenter(context as never);

    const [, provider] = mockRegisterProvider.mock.calls[0] as [
      string,
      { resolveWebviewView(view: unknown): void },
    ];
    const webview = {
      options: {},
      html: "",
      cspSource: "test",
      asWebviewUri: (uri: unknown) => uri,
      onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
    };
    provider.resolveWebviewView({ webview } as never);

    await vi.waitFor(() => expect(webview.html).toContain("Measured per-call reduction"));
    expect(webview.html).toContain("12.3%");
    expect(webview.html).toContain(
      "Billing estimate unavailable: no attributable local AI logs for this workspace.",
    );
    expect(webview.html).not.toContain("4.5%");
  });

  it("shows setup, not active metrics, before setup is verified", async () => {
    activationState.current = "not-configured";
    mockRegisterProvider.mockReturnValue({ dispose: vi.fn() });
    const context = { subscriptions: [] as unknown[], extensionUri: extensionUriStub };
    registerControlCenter(context as never);

    const [, provider] = mockRegisterProvider.mock.calls[0] as [
      string,
      { resolveWebviewView(view: unknown): void },
    ];
    const webview = {
      options: {},
      html: "",
      cspSource: "test",
      asWebviewUri: (uri: unknown) => uri,
      onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
    };
    provider.resolveWebviewView({ webview } as never);

    await vi.waitFor(() => expect(webview.html).toContain("Not set up"));
    expect(webview.html).toContain(
      "Set up this workspace before enabling TokenLighten features.",
    );
    expect(mockLoadUsageSummary).not.toHaveBeenCalled();
    const setupButton = webview.html.match(
      /<button[^>]*data-command="tokenlighten\.setup"[^>]*>/,
    )?.[0];
    expect(setupButton).toBeDefined();
    expect(setupButton).not.toContain("disabled");
  });

  it("keeps setup available while TokenLighten is disabled", async () => {
    configurationState.enabled = false;
    activationState.current = "disabled";
    mockRegisterProvider.mockReturnValue({ dispose: vi.fn() });
    const context = { subscriptions: [] as unknown[], extensionUri: extensionUriStub };
    registerControlCenter(context as never);

    const [, provider] = mockRegisterProvider.mock.calls[0] as [
      string,
      { resolveWebviewView(view: unknown): void },
    ];
    const webview = {
      options: {},
      html: "",
      cspSource: "test",
      asWebviewUri: (uri: unknown) => uri,
      onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
    };
    provider.resolveWebviewView({ webview } as never);

    await vi.waitFor(() => expect(webview.html).toContain("tokenlighten.setup"));
    const setupButton = webview.html.match(
      /<button[^>]*data-command="tokenlighten\.setup"[^>]*>/,
    )?.[0];
    expect(setupButton).toBeDefined();
    expect(setupButton).not.toContain("disabled");
    expect(webview.html).not.toContain("id=\"workspaceEnabled\" type=\"checkbox\" checked");
  });

  it("switches the complete workspace view to Japanese", async () => {
    configurationState.language = "ja";
    mockRegisterProvider.mockReturnValue({ dispose: vi.fn() });
    const context = { subscriptions: [] as unknown[], extensionUri: extensionUriStub };
    registerControlCenter(context as never);

    const [, provider] = mockRegisterProvider.mock.calls[0] as [
      string,
      { resolveWebviewView(view: unknown): void },
    ];
    const webview = {
      options: {},
      html: "",
      cspSource: "test",
      asWebviewUri: (uri: unknown) => uri,
      onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
    };
    provider.resolveWebviewView({ webview } as never);

    await vi.waitFor(() => expect(webview.html).toContain("ワークスペース設定"));
    expect(webview.html).toContain("このワークスペースをセットアップ");
    expect(webview.html).toContain("ワークスペース ログ");
    expect(webview.html).not.toContain("このマシンのAIクライアント");
  });

  it("renders the Dawn palette with theme-aware accessibility fallbacks", async () => {
    mockRegisterProvider.mockReturnValue({ dispose: vi.fn() });
    const context = { subscriptions: [] as unknown[], extensionUri: extensionUriStub };
    registerControlCenter(context as never);

    const [, provider] = mockRegisterProvider.mock.calls[0] as [
      string,
      { resolveWebviewView(view: unknown): void },
    ];
    const webview = {
      options: {},
      html: "",
      cspSource: "test",
      asWebviewUri: (uri: unknown) => uri,
      onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
    };
    provider.resolveWebviewView({ webview } as never);

    await vi.waitFor(() => expect(webview.html).toContain("--brand-orange: #FF6B1A"));
    expect(webview.html).toContain("--brand-lavender: #C6A7E8");
    expect(webview.html).toContain("--brand-blue: #4057D6");
    expect(webview.html).toContain("--brand-black: #191827");
    expect(webview.html).toContain("--brand-mist: #F2EEF5");
    expect(webview.html).toContain("--tl-canvas: var(--vscode-sideBar-background)");
    expect(webview.html).toContain("--tl-focus: var(--vscode-focusBorder");
    expect(webview.html).toContain("button:focus-visible");
    expect(webview.html).toContain("body.vscode-high-contrast");
    expect(webview.html).toContain("color: #FFFFFF");
    expect(webview.html).toContain("<img class=\"mark\"");
    expect(webview.html).toContain(
      "src=\"https://file%2B.vscode-resource.test/media/icon.png\"",
    );
    expect(webview.html).toContain("img-src test;");
    expect(webview.html).not.toContain(">TL<");
  });
});