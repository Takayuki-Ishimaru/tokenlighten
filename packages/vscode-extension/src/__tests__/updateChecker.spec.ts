import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockConfigurationGet, mockShowInformationMessage, mockShowWarningMessage,
  mockOpenExternal, mockUriParse, mockInstall, mockExecuteCommand,
  mockConfigurationChanged, state,
} = vi.hoisted(() => ({
  mockConfigurationGet: vi.fn(),
  mockShowInformationMessage: vi.fn(),
  mockShowWarningMessage: vi.fn(),
  mockOpenExternal: vi.fn(),
  mockUriParse: vi.fn((value: string) => ({ value })),
  mockInstall: vi.fn(),
  mockExecuteCommand: vi.fn(),
  mockConfigurationChanged: vi.fn((_listener: unknown) => ({ dispose: vi.fn() })),
  state: { autoUpdate: true, updateCheck: true, language: "en" as "en" | "ja" },
}));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({ get: mockConfigurationGet })),
    onDidChangeConfiguration: mockConfigurationChanged,
  },
  window: {
    showInformationMessage: mockShowInformationMessage,
    showWarningMessage: mockShowWarningMessage,
  },
  env: { openExternal: mockOpenExternal },
  commands: { executeCommand: mockExecuteCommand },
  Uri: { parse: mockUriParse },
}));
vi.mock("../statusBar.js", () => ({ getDisplayLanguage: () => state.language }));
vi.mock("../extensionUpdater.js", () => ({ installReleaseVsix: mockInstall }));

import {
  checkForExtensionUpdate, isVersionNewer, registerExtensionUpdateChecks,
  selectNewestRelease, selectReleaseTarget, UPDATE_INTERVAL_MS,
} from "../updateChecker.js";
import type { GitHubRelease } from "../updateChecker.js";
import type { ExtensionContext, ConfigurationChangeEvent } from "vscode";

const release = (tagName = "v0.10.0", assetUrl?: string): GitHubRelease => {
  const name = `tokenlighten-vscode-extension-${tagName.replace(/^v/i, "")}.vsix`;
  return {
    tagName,
    htmlUrl: `https://github.com/Takayuki-Ishimaru/tokenlighten/releases/tag/${tagName}`,
    assets: [{
      name,
      browserDownloadUrl: assetUrl
        ?? `https://github.com/Takayuki-Ishimaru/tokenlighten/releases/download/${tagName}/${name}`,
    }],
  };
};
const context = () => ({
  extension: { packageJSON: { version: "0.9.0" } },
  subscriptions: [] as Array<{ dispose(): void }>,
}) as unknown as ExtensionContext;
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
function changeSetting(key: string): void {
  const listener = mockConfigurationChanged.mock.calls[0]?.[0] as unknown as
    (event: ConfigurationChangeEvent) => void;
  listener({ affectsConfiguration: (name: string) => name === key } as ConfigurationChangeEvent);
}

describe("GitHub release update checks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.autoUpdate = true;
    state.updateCheck = true;
    state.language = "en";
    mockConfigurationGet.mockImplementation((key: string, fallback: unknown) =>
      key === "autoUpdate.enabled" ? state.autoUpdate
        : key === "updateCheck.enabled" ? state.updateCheck : fallback);
    mockShowInformationMessage.mockResolvedValue(undefined);
    mockShowWarningMessage.mockResolvedValue(undefined);
    mockOpenExternal.mockResolvedValue(true);
    mockInstall.mockResolvedValue(undefined);
  });
  afterEach(() => vi.useRealTimers());

  it("compares semantic versions including v-prefixes and prereleases", () => {
    expect(isVersionNewer("v0.10.0", "0.9.9")).toBe(true);
    expect(isVersionNewer("0.9.0", "0.9.0")).toBe(false);
    expect(isVersionNewer("v0.9.1a", "0.9.1")).toBe(true);
    expect(isVersionNewer("v0.9.1a", "0.9.2")).toBe(false);
    expect(isVersionNewer("0.9.0-beta.2", "0.9.0-beta.1")).toBe(true);
    expect(isVersionNewer("0.9.0-beta.1", "0.9.0")).toBe(false);
    expect(isVersionNewer("not-a-version", "0.9.0")).toBe(false);
  });

  it("selects the highest published version including public-beta releases", () => {
    expect(selectNewestRelease(["v0.9.1", "v0.9.1a"].map(tag_name => ({
      tag_name,
      html_url: `https://github.com/Takayuki-Ishimaru/tokenlighten/releases/tag/${tag_name}`,
      assets: [], prerelease: true, draft: false,
    })))?.tagName).toBe("v0.9.1a");
  });

  it("prefers the matching trusted VSIX asset from this repository", () => {
    expect(selectReleaseTarget(release())).toEqual({
      url: expect.stringContaining("/releases/download/v0.10.0/"),
      directVsix: true,
    });
  });

  it.each([
    "https://example.com/tokenlighten.vsix",
    "https://github.com/other/repo/releases/download/v0.10.0/tokenlighten.vsix",
    "https://github.com/Takayuki-Ishimaru/tokenlighten/releases/download/v0.11.0/tokenlighten-vscode-extension-0.10.0.vsix",
  ])("rejects a foreign or mismatched asset: %s", (url) => {
    expect(selectReleaseTarget(release("v0.10.0", url))).toEqual({
      url: release().htmlUrl, directVsix: false,
    });
  });

  it("does not install a differently named extension from the same release", async () => {
    const candidate = release();
    candidate.assets[0].name = "other-extension.vsix";
    await checkForExtensionUpdate(context(), async () => candidate);
    expect(mockInstall).not.toHaveBeenCalled();
    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("available"), "Open GitHub release");
  });

  it("automatically installs by default before notifying, with no browser or forced reload", async () => {
    // Missing settings must use the manifest default, true.
    mockConfigurationGet.mockImplementation((_key: string, fallback: unknown) => fallback);
    await checkForExtensionUpdate(context(), async () => release());
    expect(mockInstall).toHaveBeenCalledWith(release().assets[0].browserDownloadUrl, expect.any(AbortSignal));
    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("has been installed"), "Reload Window");
    expect(mockOpenExternal).not.toHaveBeenCalled();
    expect(mockExecuteCommand).not.toHaveBeenCalled();
  });

  it("reloads only when the user chooses the post-install action", async () => {
    mockShowInformationMessage.mockResolvedValue("Reload Window");
    await checkForExtensionUpdate(context(), async () => release());
    expect(mockExecuteCommand).toHaveBeenCalledWith("workbench.action.reloadWindow");
  });

  it("uses Japanese for the installed notification and reload action", async () => {
    state.language = "ja";
    await checkForExtensionUpdate(context(), async () => release());
    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("をインストールしました"), "ウィンドウを再読み込み");
  });

  it("uses notification-only mode when automatic updates are off", async () => {
    state.autoUpdate = false;
    mockShowInformationMessage.mockResolvedValue("Download VSIX from GitHub");
    await checkForExtensionUpdate(context(), async () => release());
    expect(mockInstall).not.toHaveBeenCalled();
    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("v0.10.0"), "Download VSIX from GitHub");
    expect(mockUriParse).toHaveBeenCalledWith(
      expect.stringContaining("/releases/download/v0.10.0/"), true);
    expect(mockOpenExternal).toHaveBeenCalledOnce();
  });

  it("does not open a URL when a notification is dismissed", async () => {
    state.autoUpdate = false;
    await checkForExtensionUpdate(context(), async () => release());
    expect(mockShowInformationMessage).toHaveBeenCalledOnce();
    expect(mockOpenExternal).not.toHaveBeenCalled();
  });

  it("does not contact GitHub when update checks are disabled", async () => {
    state.updateCheck = false;
    const fetcher = vi.fn(async () => release());
    await checkForExtensionUpdate(context(), fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    expect(mockInstall).not.toHaveBeenCalled();
    expect(mockShowInformationMessage).not.toHaveBeenCalled();
  });

  it.each(["v0.9.0", "v0.8.9", "invalid"])("does not install current, older or invalid versions: %s", async tag => {
    await checkForExtensionUpdate(context(), async () => release(tag));
    expect(mockInstall).not.toHaveBeenCalled();
    expect(mockShowInformationMessage).not.toHaveBeenCalled();
  });

  it("ignores unavailable and failed release checks without blocking activation", async () => {
    await checkForExtensionUpdate(context(), async () => undefined);
    await checkForExtensionUpdate(context(), async () => { throw new Error("offline"); });
    expect(mockInstall).not.toHaveBeenCalled();
    expect(mockShowWarningMessage).not.toHaveBeenCalled();
  });

  it("reports a failed install, offers manual download, and retries later", async () => {
    const ctx = context();
    mockInstall.mockRejectedValueOnce(new Error("installation failed"));
    mockShowWarningMessage.mockResolvedValue("Download VSIX from GitHub");
    await checkForExtensionUpdate(ctx, async () => release());
    expect(mockShowWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("could not be updated"), "Download VSIX from GitHub");
    expect(mockShowInformationMessage).not.toHaveBeenCalled();
    expect(mockOpenExternal).toHaveBeenCalledOnce();
    await checkForExtensionUpdate(ctx, async () => release());
    expect(mockInstall).toHaveBeenCalledTimes(2);
    expect(mockShowInformationMessage).toHaveBeenCalledOnce();
  });

  it("remembers a completed install while the running extension awaits reload", async () => {
    const ctx = context();
    await checkForExtensionUpdate(ctx, async () => release());
    await checkForExtensionUpdate(ctx, async () => release());
    expect(mockInstall).toHaveBeenCalledOnce();
    expect(mockShowInformationMessage).toHaveBeenCalledOnce();
    await checkForExtensionUpdate(ctx, async () => release("v0.11.0"));
    expect(mockInstall).toHaveBeenCalledTimes(2);
  });

  it("keeps checking for newer updates while an earlier notification remains open", async () => {
    const ctx = context();
    mockShowInformationMessage.mockImplementation(() => new Promise(() => {}));
    await checkForExtensionUpdate(ctx, async () => release());
    await checkForExtensionUpdate(ctx, async () => release("v0.11.0"));
    expect(mockInstall).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent checks in the same extension host", async () => {
    const ctx = context();
    let resolve!: (value: GitHubRelease) => void;
    const fetcher = vi.fn(() => new Promise<GitHubRelease>(done => { resolve = done; }));
    const first = checkForExtensionUpdate(ctx, fetcher);
    const second = checkForExtensionUpdate(ctx, fetcher);
    resolve(release());
    await Promise.all([first, second]);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(mockInstall).toHaveBeenCalledOnce();
  });

  it("rechecks settings after the network response before installing", async () => {
    await checkForExtensionUpdate(context(), async () => {
      state.autoUpdate = false;
      return release();
    });
    expect(mockInstall).not.toHaveBeenCalled();
    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("available"), "Download VSIX from GitHub");
  });

  it("does no work after cancellation, including a late network response", async () => {
    const controller = new AbortController();
    await checkForExtensionUpdate(context(), async () => {
      controller.abort();
      return release();
    }, mockInstall, controller.signal);
    expect(mockInstall).not.toHaveBeenCalled();
    expect(mockShowInformationMessage).not.toHaveBeenCalled();
  });

  it("checks at startup and every six hours, then stops on disposal", async () => {
    vi.useFakeTimers();
    const ctx = context();
    const fetcher = vi.fn(async () => undefined);
    registerExtensionUpdateChecks(ctx, fetcher, mockInstall);
    await flush();
    expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS);
    expect(fetcher).toHaveBeenCalledTimes(2);
    ctx.subscriptions.forEach(item => item.dispose());
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS * 2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("immediately checks when the global update check setting is re-enabled", async () => {
    vi.useFakeTimers();
    state.updateCheck = false;
    const ctx = context();
    const fetcher = vi.fn(async () => release());
    registerExtensionUpdateChecks(ctx, fetcher, mockInstall);
    await flush();
    expect(fetcher).not.toHaveBeenCalled();
    state.updateCheck = true;
    changeSetting("tokenlighten.updateCheck.enabled");
    await flush();
    expect(mockInstall).toHaveBeenCalledOnce();
    ctx.subscriptions.forEach(item => item.dispose());
  });

  it("aborts an in-flight download when automatic updates are disabled", async () => {
    vi.useFakeTimers();
    const ctx = context();
    const signals: AbortSignal[] = [];
    mockInstall.mockImplementation((_url: string, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    });
    registerExtensionUpdateChecks(ctx, async () => release(), mockInstall);
    await flush();
    state.autoUpdate = false;
    changeSetting("tokenlighten.autoUpdate.enabled");
    await flush();
    expect(signals[0].aborted).toBe(true);
    expect(mockInstall).toHaveBeenCalledOnce();
    expect(mockShowWarningMessage).not.toHaveBeenCalled();
    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("available"), "Download VSIX from GitHub");
    ctx.subscriptions.forEach(item => item.dispose());
  });

  it("disposal cancels a pending check and prevents late installation", async () => {
    vi.useFakeTimers();
    const ctx = context();
    let resolve!: (value: GitHubRelease) => void;
    registerExtensionUpdateChecks(ctx, () => new Promise<GitHubRelease>(done => { resolve = done; }), mockInstall);
    ctx.subscriptions.forEach(item => item.dispose());
    resolve(release());
    await flush();
    expect(mockInstall).not.toHaveBeenCalled();
    expect(mockShowInformationMessage).not.toHaveBeenCalled();
  });
});
