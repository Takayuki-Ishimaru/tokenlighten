import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockRegisterProvider,
  mockLaunch,
  mockWorkspaceChanged,
  mockConfigurationChanged,
  mockMcpSettings,
  mockSetupStateChanged,
  mockRegisterCommand,
  mockExecuteCommand,
  mockShowInformationMessage,
} = vi.hoisted(() => ({
  mockRegisterProvider: vi.fn(),
  mockLaunch: vi.fn(),
  mockWorkspaceChanged: vi.fn(() => ({ dispose: vi.fn() })),
  mockConfigurationChanged: vi.fn(() => ({ dispose: vi.fn() })),
  mockMcpSettings: vi.fn(),
  mockSetupStateChanged: vi.fn(() => ({ dispose: vi.fn() })),
  mockRegisterCommand: vi.fn(() => ({ dispose: vi.fn() })),
  mockExecuteCommand: vi.fn(),
  mockShowInformationMessage: vi.fn(),
}));

interface MockDefinition {
  cwd: unknown;
  label: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  version: string;
}

vi.mock("vscode", () => {
  class EventEmitter {
    readonly event = vi.fn();
    fire = vi.fn();
    dispose = vi.fn();
  }
  class Definition {
    cwd: unknown;
    constructor(
      readonly label: string,
      readonly command: string,
      readonly args: string[],
      readonly env: Record<string, string>,
      readonly version: string,
    ) {}
  }
  return {
    EventEmitter,
    McpStdioServerDefinition: Definition,
    workspace: {
      workspaceFolders: [{ uri: { fsPath: "/workspace" } }],
      onDidChangeWorkspaceFolders: mockWorkspaceChanged,
      onDidChangeConfiguration: mockConfigurationChanged,
    },
    lm: {
      registerMcpServerDefinitionProvider: mockRegisterProvider,
    },
    commands: {
      registerCommand: mockRegisterCommand,
      executeCommand: mockExecuteCommand,
    },
    window: {
      showInformationMessage: mockShowInformationMessage,
    },
  };
});

vi.mock("../cli.js", () => ({
  getMcpLaunchConfig: mockLaunch,
}));

vi.mock("../workspaceState.js", () => ({
  onWorkspaceSetupStateChanged: mockSetupStateChanged,
  workspaceMcpSettingsCached: mockMcpSettings,
}));

import {
  registerMcpProvider,
  setNativeSessionBypass,
} from "../mcpProvider.js";

describe("VS Code MCP definition provider", () => {
  beforeEach(() => {
    setNativeSessionBypass(false);
    vi.clearAllMocks();
    mockLaunch.mockImplementation((args: string[]) => ({
      command: "/node",
      args: ["/bundled/tl.js", ...args],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    }));
    mockRegisterProvider.mockReturnValue({ dispose: vi.fn() });
    mockMcpSettings.mockReturnValue({
      writeEnabled: true,
      usageLoggingEnabled: true,
    });
  });

  it("provides the bundled full-access MCP server in the workspace", () => {
    const context = {
      subscriptions: [],
      extension: { packageJSON: { version: "0.10.0-test" } },
    } as unknown as {
      subscriptions: { dispose(): unknown }[];
    };
    registerMcpProvider(context as never);
    expect(mockRegisterProvider).toHaveBeenCalledOnce();
    const [, provider] = mockRegisterProvider.mock.calls[0] as [
      string,
      { provideMcpServerDefinitions(): MockDefinition[] },
    ];
    const definitions = provider.provideMcpServerDefinitions();
    expect(definitions).toHaveLength(1);
    expect(definitions[0]).toMatchObject({
      command: "/node",
      args: ["/bundled/tl.js", "mcp", "start", "--stdio", "--allow-write"],
      cwd: { fsPath: "/workspace" },
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        TOKENLIGHTEN_CLIENT: "vscode",
        TOKENLIGHTEN_USAGE_LOG: "on",
        TOKENLIGHTEN_ACTIVATION: "host-auto",
      },
      version: "0.10.0-test",
    });
  });

  it("honors a verified read-only, usage-off workspace definition", () => {
    mockMcpSettings.mockReturnValue({
      writeEnabled: false,
      usageLoggingEnabled: false,
    });
    const context = {
      subscriptions: [],
      extension: { packageJSON: { version: "0.10.0-test" } },
    } as unknown as {
      subscriptions: { dispose(): unknown }[];
    };
    registerMcpProvider(context as never);
    const [, provider] = mockRegisterProvider.mock.calls[0] as [
      string,
      { provideMcpServerDefinitions(): MockDefinition[] },
    ];

    const definitions = provider.provideMcpServerDefinitions();

    expect(mockLaunch).toHaveBeenCalledWith([
      "mcp", "start", "--stdio",
    ]);
    expect(definitions[0]?.env["TOKENLIGHTEN_USAGE_LOG"]).toBe("off");
  });

  it("supports an observable session-only native bypass and reversible resume", () => {
    const context = {
      subscriptions: [],
      extension: { packageJSON: { version: "0.10.0-test" } },
    } as unknown as { subscriptions: { dispose(): unknown }[] };
    registerMcpProvider(context as never);
    const [, provider] = mockRegisterProvider.mock.calls[0] as [
      string,
      { provideMcpServerDefinitions(): MockDefinition[] },
    ];

    setNativeSessionBypass(true);
    expect(provider.provideMcpServerDefinitions()).toEqual([]);
    expect(mockExecuteCommand).toHaveBeenCalledWith(
      "setContext",
      "tokenlighten.mcpActivation",
      "native-bypass",
    );

    setNativeSessionBypass(false);
    expect(provider.provideMcpServerDefinitions()).toHaveLength(1);
    expect(mockExecuteCommand).toHaveBeenCalledWith(
      "setContext",
      "tokenlighten.mcpActivation",
      "active",
    );
  });

  it("provides no MCP server definitions before workspace setup is verified", () => {
    mockMcpSettings.mockReturnValue(null);
    const context = {
      subscriptions: [],
      extension: { packageJSON: { version: "0.10.0-test" } },
    } as unknown as {
      subscriptions: { dispose(): unknown }[];
    };
    registerMcpProvider(context as never);
    const [, provider] = mockRegisterProvider.mock.calls[0] as [
      string,
      { provideMcpServerDefinitions(): MockDefinition[] },
    ];

    expect(provider.provideMcpServerDefinitions()).toEqual([]);
    expect(mockLaunch).not.toHaveBeenCalled();
  });
});
