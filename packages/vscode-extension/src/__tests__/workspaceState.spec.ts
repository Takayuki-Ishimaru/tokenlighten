import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockFindTlBinary,
  mockSpawnTl,
  configurationState,
  workspaceState,
} = vi.hoisted(() => ({
  mockFindTlBinary: vi.fn(),
  mockSpawnTl: vi.fn(),
  configurationState: { enabled: true },
  workspaceState: {
    trusted: true,
    root: "/workspace" as string | undefined,
  },
}));

vi.mock("vscode", () => ({
  workspace: {
    get isTrusted() {
      return workspaceState.trusted;
    },
    get workspaceFolders() {
      return workspaceState.root
        ? [{ uri: { fsPath: workspaceState.root } }]
        : undefined;
    },
    getConfiguration: () => ({
      get: (key: string, defaultValue: unknown) =>
        key === "enabled" ? configurationState.enabled : defaultValue,
    }),
  },
}));

vi.mock("../cli.js", () => ({
  findTlBinary: mockFindTlBinary,
  spawnTl: mockSpawnTl,
}));

import {
  invalidateWorkspaceConfigured,
  workspaceActivationState,
  workspaceActivationStateCached,
  workspaceMcpSettingsCached,
} from "../workspaceState.js";

describe("workspace activation state", () => {
  beforeEach(() => {
    invalidateWorkspaceConfigured();
    vi.clearAllMocks();
    configurationState.enabled = true;
    workspaceState.trusted = true;
    workspaceState.root = "/workspace";
    mockFindTlBinary.mockReturnValue(true);
  });

  it("becomes ready only after a matching CLI status probe", async () => {
    mockSpawnTl.mockResolvedValue({
      code: 0,
      stderr: "",
      stdout: JSON.stringify({
        schemaVersion: 1,
        workspaceRoot: "/workspace",
        configured: true,
        writeEnabled: false,
        usageLoggingEnabled: false,
      }),
    });

    await expect(workspaceActivationState()).resolves.toBe("ready");

    expect(mockSpawnTl).toHaveBeenCalledWith(
      ["workspace", "status", "--root", "/workspace", "--json"],
      { cwd: "/workspace" },
    );
    expect(workspaceActivationStateCached()).toBe("ready");
    expect(workspaceMcpSettingsCached()).toEqual({
      writeEnabled: false,
      usageLoggingEnabled: false,
    });
  });

  it("fails closed for malformed, unsuccessful, or differently rooted probes", async () => {
    mockSpawnTl.mockResolvedValue({
      code: 0,
      stderr: "",
      stdout: JSON.stringify({
        schemaVersion: 1,
        workspaceRoot: "/other",
        configured: true,
        writeEnabled: true,
        usageLoggingEnabled: true,
      }),
    });

    await expect(workspaceActivationState()).resolves.toBe("not-configured");
    expect(workspaceActivationStateCached()).toBe("not-configured");
    expect(workspaceMcpSettingsCached()).toBeNull();
  });

  it("does not probe when workspace prerequisites are not satisfied", async () => {
    configurationState.enabled = false;

    await expect(workspaceActivationState()).resolves.toBe("disabled");

    expect(mockSpawnTl).not.toHaveBeenCalled();
  });
});
