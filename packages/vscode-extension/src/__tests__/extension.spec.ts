import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockActivationState,
  mockCachedState,
  mockInvalidate,
  mockRegisterCommands,
  mockRegisterSetup,
  mockRegisterMcp,
  mockRegisterHostActivation,
  mockRemoveOwnOverrides,
  mockRegisterSidebar,
  mockCheckForUpdate,
  mockWatcher,
  mockBar,
} = vi.hoisted(() => ({
  mockRegisterHostActivation: vi.fn(),
  mockRemoveOwnOverrides: vi.fn(),
  mockActivationState: vi.fn(),
  mockCachedState: vi.fn(),
  mockInvalidate: vi.fn(),
  mockRegisterCommands: vi.fn(),
  mockRegisterSetup: vi.fn(),
  mockRegisterMcp: vi.fn(),
  mockRegisterSidebar: vi.fn(),
  mockCheckForUpdate: vi.fn(),
  mockWatcher: vi.fn(),
  mockBar: {
    setActivationState: vi.fn(),
    dispose: vi.fn(),
  },
}));

vi.mock("vscode", () => ({
  workspace: {
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
  },
}));

vi.mock("../statusBar.js", () => ({
  StatusBarManager: class {
    setActivationState = mockBar.setActivationState;
    dispose = mockBar.dispose;
  },
}));

vi.mock("../watcher.js", () => ({
  WorkspaceWatcher: class {
    constructor(...args: unknown[]) {
      mockWatcher(...args);
    }
    dispose = vi.fn();
  },
}));

vi.mock("../commands.js", () => ({
  registerCommands: mockRegisterCommands,
  registerSetupCommand: mockRegisterSetup,
}));

vi.mock("../cli.js", () => ({ spawnTl: vi.fn() }));
vi.mock("../mcpProvider.js", () => ({ registerMcpProvider: mockRegisterMcp }));
// The window-scoped off switch for a managed `.vscode/mcp.json` server
// (hostActivation.spec.ts covers what it writes); here only WHEN it is wired.
vi.mock("../hostActivation.js", () => ({
  registerHostActivation: mockRegisterHostActivation,
  removeOwnHostActivationOverrides: mockRemoveOwnOverrides,
}));
vi.mock("../sidebar.js", () => ({ registerControlCenter: mockRegisterSidebar }));
vi.mock("../updateChecker.js", () => ({ checkForExtensionUpdate: mockCheckForUpdate }));
vi.mock("../workspaceState.js", () => ({
  invalidateWorkspaceConfigured: mockInvalidate,
  workspaceActivationState: mockActivationState,
  workspaceActivationStateCached: mockCachedState,
}));

import { activate, deactivate } from "../extension.js";

describe("extension activation", () => {
  beforeEach(() => {
    deactivate();
    vi.clearAllMocks();
    mockCachedState.mockReturnValue("not-configured");
  });

  it("registers UI and MCP integration but does not start a watcher before setup", async () => {
    mockActivationState.mockResolvedValue("not-configured");
    const context = { subscriptions: [] as unknown[] };

    await activate(context as never);

    expect(mockRegisterSidebar).toHaveBeenCalledOnce();
    expect(mockRegisterSetup).toHaveBeenCalledOnce();
    expect(mockRegisterCommands).toHaveBeenCalledOnce();
    expect(mockRegisterMcp).toHaveBeenCalledOnce();
    expect(mockRegisterHostActivation).toHaveBeenCalledOnce();
    expect(mockRegisterHostActivation).toHaveBeenCalledWith(context);
    expect(mockCheckForUpdate).toHaveBeenCalledOnce();
    expect(mockBar.setActivationState).toHaveBeenCalledWith("not-configured");
    expect(mockWatcher).not.toHaveBeenCalled();
  });

  it("starts the workspace watcher only after configured status is ready", async () => {
    mockActivationState.mockResolvedValue("ready");
    const context = { subscriptions: [] as unknown[] };

    await activate(context as never);

    expect(mockBar.setActivationState).toHaveBeenCalledWith("ready");
    expect(mockWatcher).toHaveBeenCalledOnce();
  });

  it("wires the host-activation override sync even when the workspace is not ready, and removes this window's overrides on deactivate", async () => {
    mockActivationState.mockResolvedValue("disabled");
    const context = { subscriptions: [] as unknown[] };

    await activate(context as never);

    // `tokenlighten.enabled = false` makes the state "disabled" and activation returns early —
    // the sync is wired before that, because the override file is exactly what a disabled window needs.
    expect(mockRegisterHostActivation).toHaveBeenCalledOnce();
    expect(mockRemoveOwnOverrides).not.toHaveBeenCalled();

    deactivate();

    expect(mockRemoveOwnOverrides).toHaveBeenCalledOnce();
  }, 20_000);
});
