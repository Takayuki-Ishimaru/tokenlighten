import { beforeEach, describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";

const {
  mockRegisterProvider,
  mockLoadUsageSummary,
  mockActivationState,
  activationState,
  configurationState,
  mockConfigurationUpdate,
  mockExecuteCommand,
} = vi.hoisted(() => ({
  mockRegisterProvider: vi.fn(),
  mockLoadUsageSummary: vi.fn(),
  mockActivationState: vi.fn(),
  activationState: { current: "ready" },
  configurationState: { enabled: true, autoUpdate: true, updateCheck: true, language: "en" as "auto" | "en" | "ja" },
  mockConfigurationUpdate: vi.fn(),
  mockExecuteCommand: vi.fn(),
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
            : key === "autoUpdate.enabled"
              ? configurationState.autoUpdate
              : key === "updateCheck.enabled"
                ? configurationState.updateCheck
                : defaultValue,
      update: mockConfigurationUpdate,
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
    executeCommand: mockExecuteCommand,
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
  formatUsageMeasurementStatus: (tier: { status: string; basis: string }, language: "en" | "ja") =>
    language === "ja"
      ? `${tier.status === "measured" ? "実測" : tier.status === "estimated" ? "推定" : "利用不可"}（根拠: ${tier.basis}）`
      : `${tier.status} (basis: ${tier.basis})`,
  formatUsageMeasurementTier: (tier: { status: string; basis: string; tokens: number | null }, language: "en" | "ja") => {
    const tokens = tier.tokens === null
      ? (language === "ja" ? "利用不可" : "unavailable")
      : language === "ja" ? `${tier.tokens}トークン` : `${tier.tokens} tokens`;
    const status = language === "ja"
      ? tier.status === "measured" ? "実測" : tier.status === "estimated" ? "推定" : "利用不可"
      : tier.status;
    return language === "ja"
      ? `${tokens}（${status}・根拠: ${tier.basis}）`
      : `${tokens} (${status}; basis: ${tier.basis})`;
  },
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
    configurationState.autoUpdate = true;
    configurationState.updateCheck = true;
    mockConfigurationUpdate.mockImplementation(async (key: string, value: boolean) => {
      if (key === "autoUpdate.enabled") configurationState.autoUpdate = value;
      if (key === "updateCheck.enabled") configurationState.updateCheck = value;
    });
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
        confidence: "medium",
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

  it("shows calibration progress and measured byte ratio with empty paired logs", async () => {
    mockLoadUsageSummary.mockResolvedValue({
      measuredBaselineCalls: 3,
      measuredResponseBytes: 400,
      measuredBaselineBytes: 800,
      estimatedResponseTokens: 100,
      method: "file-bytes",
      measurementDisplay: {
        wire: { status: "measured", basis: "test", tokens: null },
        mcpResponse: { status: "estimated", basis: "test", tokens: 10 },
        contextAvoided: { status: "estimated", basis: "test", tokens: -250 },
        session: { status: "unavailable", basis: "test", tokens: null, net: { status: "estimated", basis: "test", tokens: -260 } },
      },
      sessionEstimate: { status: "estimated", confidence: "low", calibration: { sampleCount: 0 }, warnings: [] },
    });
    mockRegisterProvider.mockReturnValue({ dispose: vi.fn() });
    const context = { subscriptions: [] as unknown[], extensionUri: extensionUriStub };
    registerControlCenter(context as never);
    const [, provider] = mockRegisterProvider.mock.calls[0] as [string, { resolveWebviewView(view: unknown): void }];
    const webview = { options: {}, html: "", cspSource: "test", asWebviewUri: (uri: unknown) => uri, onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })) };
    provider.resolveWebviewView({ webview } as never);
    await vi.waitFor(() => expect(webview.html).toContain("Calibrating: 0/24 paired samples"));
    expect(webview.html).toContain("Measured calls: 3; response bytes vs baseline: 50.0%");
    expect(webview.html).toContain("TL response total: ~100 tokens (file-bytes); observed usage: measured (basis: test); MCP response overhead: 10 tokens (estimated; basis: test); context avoided: -250 tokens (estimated; basis: test); session avoided-turn: unavailable (unavailable; basis: test); net: -260 tokens (estimated; basis: test)");
    expect(webview.html).toContain("Calibrating: 0/24 paired samples");
  });

  it("renders distinct measurement-unavailable reasons", async () => {
    for (const [reason, expected] of [["recorder-off", "Recorder is off."], ["log-dir-unavailable", "Usage log directory is unavailable."], ["scope-mismatch", "Usage logs do not match this workspace scope."]] as const) {
      mockLoadUsageSummary.mockResolvedValue({ measuredBaselineCalls: 0, sessionEstimate: { status: "estimated", confidence: "low", calibration: { sampleCount: 0 }, warnings: [reason] } });
      mockRegisterProvider.mockReturnValue({ dispose: vi.fn() });
      const context = { subscriptions: [] as unknown[], extensionUri: extensionUriStub };
      registerControlCenter(context as never);
      const [, provider] = mockRegisterProvider.mock.calls.at(-1) as [string, { resolveWebviewView(view: unknown): void }];
      const webview = { options: {}, html: "", cspSource: "test", asWebviewUri: (uri: unknown) => uri, onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })) };
      provider.resolveWebviewView({ webview } as never);
      await vi.waitFor(() => expect(webview.html).toContain(expected));
    }
  });

  it("does not present a 99.9% per-call fallback when attributable AI logs are unavailable", async () => {
    mockLoadUsageSummary.mockResolvedValue({
      estimatedTokenReductionPercent: 99.9,
      estimatedCostReductionPercent: 4.5,
      sessionEstimate: {
        status: "provider-logs-unavailable",
        tokenReductionPercent: null,
        costReductionPercent: null,
        confidence: "unavailable",
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

    await vi.waitFor(() => expect(webview.html).toContain(
      "Token and billing reduction estimates unavailable: no attributable local AI logs for this workspace.",
    ));
    expect(webview.html).not.toContain("99.9%");
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
  function resolveSidebar() {
    const context = { subscriptions: [] as unknown[], extensionUri: extensionUriStub };
    registerControlCenter(context as never);
    const [, provider] = mockRegisterProvider.mock.calls.at(-1) as [
      string, { resolveWebviewView(view: unknown): void },
    ];
    const webview = {
      options: {}, html: "", cspSource: "test",
      asWebviewUri: (uri: unknown) => uri,
      onDidReceiveMessage: vi.fn((_message: (value: unknown) => void) => ({ dispose: vi.fn() })),
    };
    provider.resolveWebviewView({ webview } as never);
    const send = webview.onDidReceiveMessage.mock.calls[0][0];
    return { webview, send };
  }

  it("shows automatic updates enabled by default and sends the checkbox value immediately", async () => {
    const { webview } = resolveSidebar();
    await vi.waitFor(() => expect(webview.html).toContain('id="autoUpdate" type="checkbox" checked'));
    expect(webview.html).toContain("Automatically update the extension");
    expect(webview.html).toContain("Applies to all workspaces and saves immediately.");
    const handlers = new Map<string, (event: { target: { checked: boolean } }) => void>();
    const postMessage = vi.fn();
    const script = webview.html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeDefined();
    runInNewContext(script!, {
      acquireVsCodeApi: () => ({ postMessage }),
      document: {
        querySelectorAll: () => [],
        getElementById: (id: string) => ({
          addEventListener: (event: string, handler: (event: { target: { checked: boolean } }) => void) =>
            handlers.set(`${id}:${event}`, handler),
        }),
      },
    });
    handlers.get("autoUpdate:change")!({ target: { checked: false } });
    expect(postMessage).toHaveBeenCalledWith({ action: "setAutoUpdate", autoUpdate: false });
  });

  it.each(["autoUpdate", "updateCheck"] as const)("shows auto updates off when %s is disabled", async key => {
    configurationState[key] = false;
    const { webview } = resolveSidebar();
    await vi.waitFor(() => expect(webview.html).toContain('id="autoUpdate"'));
    expect(webview.html).not.toContain('id="autoUpdate" type="checkbox" checked');
  });

  it("saves the auto update switch globally, without reloading the workspace", async () => {
    const { webview, send } = resolveSidebar();
    await vi.waitFor(() => expect(webview.html).toContain('id="autoUpdate"'));
    send({ action: "setAutoUpdate", autoUpdate: false });
    await vi.waitFor(() => expect(mockConfigurationUpdate).toHaveBeenCalledWith("autoUpdate.enabled", false, 1));
    await vi.waitFor(() => expect(webview.html).not.toContain('id="autoUpdate" type="checkbox" checked'));
    expect(mockExecuteCommand).not.toHaveBeenCalled();
    expect(mockConfigurationUpdate).not.toHaveBeenCalledWith("enabled", false, expect.anything());
  });

  it("re-enables update checks when the sidebar switch is turned on", async () => {
    configurationState.autoUpdate = false;
    configurationState.updateCheck = false;
    const { webview, send } = resolveSidebar();
    await vi.waitFor(() => expect(webview.html).toContain('id="autoUpdate"'));
    send({ action: "setAutoUpdate", autoUpdate: true });
    await vi.waitFor(() => expect(mockConfigurationUpdate).toHaveBeenCalledWith("updateCheck.enabled", true, 1));
    await vi.waitFor(() => expect(webview.html).toContain('id="autoUpdate" type="checkbox" checked'));
    expect(mockConfigurationUpdate).toHaveBeenCalledWith("autoUpdate.enabled", true, 1);
    expect(mockExecuteCommand).not.toHaveBeenCalled();
  });

  it.each([undefined, "true", 1, null])("rejects a malformed auto update message: %s", async value => {
    const { webview, send } = resolveSidebar();
    await vi.waitFor(() => expect(webview.html).toContain('id="autoUpdate"'));
    send({ action: "setAutoUpdate", autoUpdate: value });
    await Promise.resolve();
    expect(mockConfigurationUpdate).not.toHaveBeenCalled();
  });

  it("labels automatic updates in Japanese", async () => {
    configurationState.language = "ja";
    const { webview } = resolveSidebar();
    await vi.waitFor(() => expect(webview.html).toContain("拡張機能を自動更新する"));
    expect(webview.html).toContain("全ワークスペース共通で、変更は即時保存されます。");
  });

});