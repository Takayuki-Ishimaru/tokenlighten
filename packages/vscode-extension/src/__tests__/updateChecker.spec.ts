import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockConfigurationGet,
  mockShowInformationMessage,
  mockOpenExternal,
  mockUriParse,
} = vi.hoisted(() => ({
  mockConfigurationGet: vi.fn(),
  mockShowInformationMessage: vi.fn(),
  mockOpenExternal: vi.fn(),
  mockUriParse: vi.fn((value: string) => ({ value })),
}));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({ get: mockConfigurationGet })),
  },
  window: {
    showInformationMessage: mockShowInformationMessage,
  },
  env: {
    openExternal: mockOpenExternal,
  },
  Uri: {
    parse: mockUriParse,
  },
}));

vi.mock("../statusBar.js", () => ({
  getDisplayLanguage: () => "en",
}));

import {
  checkForExtensionUpdate,
  isVersionNewer,
  selectNewestRelease,
  selectReleaseTarget,
} from "../updateChecker.js";
import type { GitHubRelease } from "../updateChecker.js";

const release = (
  tagName = "v0.10.0",
  assetUrl =
    "https://github.com/Takayuki-Ishimaru/tokenlighten/releases/download/v0.10.0/tokenlighten-vscode-extension-0.10.0.vsix",
): GitHubRelease => ({
  tagName,
  htmlUrl:
    `https://github.com/Takayuki-Ishimaru/tokenlighten/releases/tag/${tagName}`,
  assets: [{
    name: "tokenlighten-vscode-extension-0.10.0.vsix",
    browserDownloadUrl: assetUrl,
  }],
});

const context = {
  extension: {
    packageJSON: { version: "0.9.0" },
  },
};

describe("GitHub release update checks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfigurationGet.mockReturnValue(true);
    mockShowInformationMessage.mockResolvedValue(undefined);
    mockOpenExternal.mockResolvedValue(true);
  });

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
    expect(selectNewestRelease([
      {
        tag_name: "v0.9.1",
        html_url: "https://github.com/Takayuki-Ishimaru/tokenlighten/releases/tag/v0.9.1",
        assets: [],
        prerelease: true,
        draft: false,
      },
      {
        tag_name: "v0.9.1a",
        html_url: "https://github.com/Takayuki-Ishimaru/tokenlighten/releases/tag/v0.9.1a",
        assets: [],
        prerelease: true,
        draft: false,
      },
    ])?.tagName).toBe("v0.9.1a");
  });

  it("prefers a trusted VSIX asset from this repository", () => {
    expect(selectReleaseTarget(release())).toEqual({
      url: expect.stringContaining(
        "/Takayuki-Ishimaru/tokenlighten/releases/download/v0.10.0/",
      ),
      directVsix: true,
    });
  });

  it("rejects an untrusted asset and falls back to the trusted release page", () => {
    expect(selectReleaseTarget(release("v0.10.0", "https://example.com/tokenlighten.vsix")))
      .toEqual({
        url: "https://github.com/Takayuki-Ishimaru/tokenlighten/releases/tag/v0.10.0",
        directVsix: false,
      });
  });

  it("notifies and opens the GitHub VSIX after the user selects download", async () => {
    mockShowInformationMessage.mockResolvedValue("Download VSIX from GitHub");

    await checkForExtensionUpdate(
      context as never,
      async () => release(),
    );

    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("v0.10.0"),
      "Download VSIX from GitHub",
    );
    expect(mockUriParse).toHaveBeenCalledWith(
      expect.stringContaining("/releases/download/v0.10.0/"),
      true,
    );
    expect(mockOpenExternal).toHaveBeenCalledOnce();
  });

  it("does not prompt when the installed version is current", async () => {
    await checkForExtensionUpdate(
      context as never,
      async () => release("v0.9.0"),
    );

    expect(mockShowInformationMessage).not.toHaveBeenCalled();
    expect(mockOpenExternal).not.toHaveBeenCalled();
  });

  it("does not contact GitHub when update checks are disabled", async () => {
    mockConfigurationGet.mockReturnValue(false);
    const fetcher = vi.fn(async () => release());

    await checkForExtensionUpdate(context as never, fetcher);

    expect(fetcher).not.toHaveBeenCalled();
    expect(mockShowInformationMessage).not.toHaveBeenCalled();
  });

  it("does not open a URL when the notification is dismissed", async () => {
    await checkForExtensionUpdate(
      context as never,
      async () => release(),
    );

    expect(mockShowInformationMessage).toHaveBeenCalledOnce();
    expect(mockOpenExternal).not.toHaveBeenCalled();
  });
});
