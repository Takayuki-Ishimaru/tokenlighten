import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockActivationState,
  mockCachedState,
  mockInvalidate,
  mockRegisterCommands,
  mockRegisterSetup,
  mockRegisterMcp,
  mockRegisterSidebar,
  mockWatcher,
  mockBar,
} = vi.hoisted(() => ({
  mockActivationState: vi.fn(),
  mockCachedState: vi.fn(),
  mockInvalidate: vi.fn(),
  mockRegisterCommands: vi.fn(),
  mockRegisterSetup: vi.fn(),
  mockRegisterMcp: vi.fn(),
  mockRegisterSidebar: vi.fn(),
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
vi.mock("../sidebar.js", () => ({ registerControlCenter: mockRegisterSidebar }));
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
});
