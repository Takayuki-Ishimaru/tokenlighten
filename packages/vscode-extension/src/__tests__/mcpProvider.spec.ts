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
  mockEventEmitterInstances,
  TEST_STAMP,
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
  // Every `new vscode.EventEmitter()` created inside mcpProvider.ts (exactly
  // one per registerMcpProvider() call — the `changed` emitter) is recorded
  // here so a test can assert whether ITS `.fire` was called, since the real
  // instance is otherwise only reachable indirectly via the opaque
  // `onDidChangeMcpServerDefinitions` property vscode.lm.
  // registerMcpServerDefinitionProvider receives.
  mockEventEmitterInstances: [] as Array<{
    event: ReturnType<typeof vi.fn>;
    fire: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }>,
  // Fixed, recognizable stand-in for the real generated stamp (see
  // ../generated/schemaStamp.ts) — this spec exercises mcpProvider.ts's OWN
  // version-combining / globalState-comparison / change-firing logic, not
  // whether the generated file's actual current value is correct (that is
  // schemaStamp.spec.ts's job).
  TEST_STAMP: "deadbeefcafef00d",
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
    constructor() {
      mockEventEmitterInstances.push(this);
    }
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

vi.mock("../generated/schemaStamp.js", () => ({
  TOKENLIGHTEN_SCHEMA_STAMP: TEST_STAMP,
}));

import {
  registerMcpProvider,
  setNativeSessionBypass,
} from "../mcpProvider.js";

/** In-memory stand-in for vscode.ExtensionContext.globalState (a Memento). */
function makeGlobalState(initial?: string) {
  let stored = initial;
  return {
    get: vi.fn(() => stored),
    update: vi.fn((_key: string, value: string | undefined) => {
      stored = value;
      return Promise.resolve();
    }),
  };
}

function makeContext(previousSchemaStamp?: string) {
  return {
    subscriptions: [],
    extension: { packageJSON: { version: "0.10.0-test" } },
    globalState: makeGlobalState(previousSchemaStamp),
  } as unknown as {
    subscriptions: { dispose(): unknown }[];
    globalState: ReturnType<typeof makeGlobalState>;
  };
}

function registerAndGetProvider(context: ReturnType<typeof makeContext>) {
  registerMcpProvider(context as never);
  const [, provider] = mockRegisterProvider.mock.calls[0] as [
    string,
    { provideMcpServerDefinitions(): MockDefinition[] },
  ];
  return provider;
}

describe("VS Code MCP definition provider", () => {
  beforeEach(() => {
    setNativeSessionBypass(false);
    vi.clearAllMocks();
    mockEventEmitterInstances.length = 0;
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
    const provider = registerAndGetProvider(makeContext());
    expect(mockRegisterProvider).toHaveBeenCalledOnce();
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
      version: `0.10.0-test+${TEST_STAMP}`,
    });
  });

  it("honors a verified read-only, usage-off workspace definition", () => {
    mockMcpSettings.mockReturnValue({
      writeEnabled: false,
      usageLoggingEnabled: false,
    });
    const provider = registerAndGetProvider(makeContext());

    const definitions = provider.provideMcpServerDefinitions();

    expect(mockLaunch).toHaveBeenCalledWith([
      "mcp", "start", "--stdio",
    ]);
    expect(definitions[0]?.env["TOKENLIGHTEN_USAGE_LOG"]).toBe("off");
  });

  it("supports an observable session-only native bypass and reversible resume", () => {
    const provider = registerAndGetProvider(makeContext());

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
    const provider = registerAndGetProvider(makeContext());

    expect(provider.provideMcpServerDefinitions()).toEqual([]);
    expect(mockLaunch).not.toHaveBeenCalled();
  });

  describe("schema-stamp cache-invalidation nudge (VS Code MCP definition-cache mitigation)", () => {
    it("does not fire a definitions-changed event on a first-ever activation (no previous stamp recorded)", () => {
      const context = makeContext(undefined);
      registerAndGetProvider(context);

      const emitter = mockEventEmitterInstances.at(-1);
      expect(emitter?.fire).not.toHaveBeenCalled();
      expect(context.globalState.update).toHaveBeenCalledWith(
        "tokenlighten.mcpSchemaStamp",
        TEST_STAMP,
      );
    });

    it("does not fire when the recorded stamp already matches the current one", () => {
      const context = makeContext(TEST_STAMP);
      registerAndGetProvider(context);

      const emitter = mockEventEmitterInstances.at(-1);
      expect(emitter?.fire).not.toHaveBeenCalled();
    });

    it("fires a definitions-changed event when the recorded stamp differs from the current one", () => {
      const context = makeContext("0000000000000000");
      registerAndGetProvider(context);

      const emitter = mockEventEmitterInstances.at(-1);
      expect(emitter?.fire).toHaveBeenCalledOnce();
      expect(context.globalState.update).toHaveBeenCalledWith(
        "tokenlighten.mcpSchemaStamp",
        TEST_STAMP,
      );
    });
  });
});
