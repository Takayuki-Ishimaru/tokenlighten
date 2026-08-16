import { describe, it, expect, vi, beforeEach } from "vitest";

let capturedText = "";
let capturedTooltip = "";

const {
  mockGetConfiguration,
  workspaceUri,
  languageState,
  environmentLanguage,
} = vi.hoisted(() => {
  const languageState = { value: "auto" as "auto" | "en" | "ja" };
  return {
    languageState,
    environmentLanguage: { value: "en" },
    mockGetConfiguration: vi.fn((_section: string, _resource?: unknown) => ({
      get: (key: string, defaultValue: unknown) =>
        key === "language" ? languageState.value : defaultValue,
    })),
    workspaceUri: { fsPath: "/workspace" },
  };
});

vi.mock("vscode", () => {
  const item = {
    get text() { return capturedText; },
    set text(v: string) { capturedText = v; },
    get tooltip() { return capturedTooltip; },
    set tooltip(v: string) { capturedTooltip = v; },
    command: undefined as unknown,
    show: vi.fn(),
    dispose: vi.fn(),
  };
  return {
    StatusBarAlignment: { Left: 1, Right: 2 },
    window: { createStatusBarItem: vi.fn(() => item) },
    workspace: {
      workspaceFolders: [{ uri: workspaceUri }],
      getConfiguration: mockGetConfiguration,
    },
    env: {
      get language() { return environmentLanguage.value; },
    },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  };
});

import {
  StatusBarManager,
  getDisplayLanguage,
  getLanguageConfigurationTarget,
  getTokenLightenConfiguration,
  getTokenLightenConfigurationTarget,
} from "../statusBar.js";

describe("StatusBarManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedText = "";
    capturedTooltip = "";
    languageState.value = "auto";
    environmentLanguage.value = "en";
  });

  it("starts in the disabled state", () => {
    const mgr = new StatusBarManager();
    expect(capturedText).toBe("TL: disabled");
    mgr.dispose();
  });

  it("setFresh() shows the enabled state", () => {
    const mgr = new StatusBarManager();
    mgr.setFresh();
    expect(capturedText).toBe("TL: enabled");
    expect(capturedTooltip).toMatch(/up-to-date/i);
    mgr.dispose();
  });

  it("setStale() keeps the enabled state visible", () => {
    const mgr = new StatusBarManager();
    mgr.setStale();
    expect(capturedText).toBe("TL: enabled (saving…)");
    expect(capturedTooltip).toMatch(/regenerating/i);
    mgr.dispose();
  });

  it("setError(msg) shows an error with truncated tooltip", () => {
    const mgr = new StatusBarManager();
    const longMsg = "x".repeat(300);
    mgr.setError(longMsg);
    expect(capturedText).toBe("TL: error");
    expect(capturedTooltip).toHaveLength(200);
    mgr.dispose();
  });

  it("setOff() shows the disabled state", () => {
    const mgr = new StatusBarManager();
    mgr.setFresh();
    mgr.setOff();
    expect(capturedText).toBe("TL: disabled");
    expect(capturedTooltip).toMatch(/no tl binary/i);
    mgr.dispose();
  });

  it("shows an explicit unconfigured state in English and Japanese", () => {
    const mgr = new StatusBarManager();
    mgr.setActivationState("not-configured");
    expect(capturedText).toBe("TL: not set up");
    expect(capturedTooltip).toMatch(/not set up/i);

    environmentLanguage.value = "ja-JP";
    mgr.setActivationState("not-configured");
    expect(capturedText).toBe("TL: 未設定");
    expect(capturedTooltip).toContain("未設定");
    mgr.dispose();
  });

  it("uses the VS Code display locale when language is automatic", () => {
    environmentLanguage.value = "ja-JP";
    expect(getDisplayLanguage()).toBe("ja");
    const mgr = new StatusBarManager();
    mgr.setFresh();
    expect(capturedText).toBe("TL: 有効");
    mgr.dispose();
  });

  it("explicit English overrides a Japanese VS Code locale", () => {
    environmentLanguage.value = "ja";
    languageState.value = "en";
    expect(getDisplayLanguage()).toBe("en");
  });

  it("does not expose doctor state", () => {
    const mgr = new StatusBarManager();
    expect(capturedText).not.toContain("doctor");
    mgr.dispose();
  });

  it("keeps workspace settings resource-scoped and language global", () => {
    getTokenLightenConfiguration();
    expect(mockGetConfiguration).toHaveBeenCalledWith("tokenlighten", workspaceUri);
    expect(getTokenLightenConfigurationTarget()).toBe(3);
    expect(getLanguageConfigurationTarget()).toBe(1);
  });
});
