import * as https from "node:https";
import * as vscode from "vscode";
import { getDisplayLanguage } from "./statusBar.js";

const RELEASES_API =
  "https://api.github.com/repos/Takayuki-Ishimaru/tokenlighten/releases?per_page=10";
const RELEASE_PATH_PREFIX = "/takayuki-ishimaru/tokenlighten/releases/";
const RESPONSE_LIMIT_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 8_000;

export interface GitHubReleaseAsset {
  name: string;
  browserDownloadUrl: string;
}

export interface GitHubRelease {
  tagName: string;
  htmlUrl: string;
  assets: GitHubReleaseAsset[];
}

interface ParsedVersion {
  core: [number, number, number];
  postrelease: number;
  prerelease: string[] | undefined;
}

export interface ReleaseTarget {
  url: string;
  directVsix: boolean;
}

export type LatestReleaseFetcher = () => Promise<GitHubRelease | undefined>;

function parseVersion(value: string): ParsedVersion | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)([a-z])?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/i.exec(
    value.trim(),
  );
  if (!match) return undefined;
  const core = match.slice(1, 4).map(Number) as [number, number, number];
  if (core.some((part) => !Number.isSafeInteger(part))) return undefined;
  return {
    core,
    postrelease: match[4]
      ? match[4].toLowerCase().charCodeAt(0) - "a".charCodeAt(0) + 1
      : 0,
    prerelease: match[5]?.split("."),
  };
}

function comparePrerelease(
  left: string[] | undefined,
  right: string[] | undefined,
): number {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;

    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return Number(a) > Number(b) ? 1 : -1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a > b ? 1 : -1;
  }
  return 0;
}

export function isVersionNewer(candidate: string, current: string): boolean {
  const left = parseVersion(candidate);
  const right = parseVersion(current);
  if (!left || !right) return false;

  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] === right.core[index]) continue;
    return left.core[index] > right.core[index];
  }
  if (left.postrelease !== right.postrelease) {
    return left.postrelease > right.postrelease;
  }
  return comparePrerelease(left.prerelease, right.prerelease) > 0;
}

function trustedGitHubReleaseUrl(
  raw: string,
  kind: "download" | "release",
): string | undefined {
  try {
    const parsed = new URL(raw);
    if (
      parsed.protocol !== "https:"
      || parsed.hostname.toLowerCase() !== "github.com"
      || parsed.username
      || parsed.password
      || parsed.port
    ) {
      return undefined;
    }

    const pathname = parsed.pathname.toLowerCase();
    const expected = kind === "download"
      ? `${RELEASE_PATH_PREFIX}download/`
      : `${RELEASE_PATH_PREFIX}tag/`;
    if (!pathname.startsWith(expected)) return undefined;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export function selectReleaseTarget(
  release: GitHubRelease,
): ReleaseTarget | undefined {
  for (const asset of release.assets) {
    if (!asset.name.toLowerCase().endsWith(".vsix")) continue;
    const url = trustedGitHubReleaseUrl(asset.browserDownloadUrl, "download");
    if (url) return { url, directVsix: true };
  }

  const releaseUrl = trustedGitHubReleaseUrl(release.htmlUrl, "release");
  return releaseUrl ? { url: releaseUrl, directVsix: false } : undefined;
}

function parseRelease(value: unknown): GitHubRelease | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (
    record["draft"] === true
    || typeof record["tag_name"] !== "string"
    || typeof record["html_url"] !== "string"
    || !Array.isArray(record["assets"])
  ) {
    return undefined;
  }

  const assets: GitHubReleaseAsset[] = [];
  for (const value of record["assets"]) {
    if (!value || typeof value !== "object") continue;
    const asset = value as Record<string, unknown>;
    if (
      typeof asset["name"] === "string"
      && typeof asset["browser_download_url"] === "string"
    ) {
      assets.push({
        name: asset["name"],
        browserDownloadUrl: asset["browser_download_url"],
      });
    }
  }

  return {
    tagName: record["tag_name"],
    htmlUrl: record["html_url"],
    assets,
  };
}

export function selectNewestRelease(value: unknown): GitHubRelease | undefined {
  const candidates = (Array.isArray(value) ? value : [value])
    .map(parseRelease)
    .filter((release): release is GitHubRelease =>
      release !== undefined && parseVersion(release.tagName) !== undefined
    );
  candidates.sort((left, right) => {
    if (isVersionNewer(left.tagName, right.tagName)) return -1;
    if (isVersionNewer(right.tagName, left.tagName)) return 1;
    return 0;
  });
  return candidates[0];
}

export function fetchLatestRelease(): Promise<GitHubRelease | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: GitHubRelease | undefined): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    try {
      const request = https.get(
        RELEASES_API,
        {
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "TokenLighten-VSCode",
            "X-GitHub-Api-Version": "2026-03-10",
          },
        },
        (response) => {
          if (response.statusCode !== 200) {
            response.resume();
            finish(undefined);
            return;
          }

          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer | string) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += buffer.byteLength;
            if (bytes > RESPONSE_LIMIT_BYTES) {
              response.destroy();
              finish(undefined);
              return;
            }
            chunks.push(buffer);
          });
          response.once("end", () => {
            if (settled) return;
            try {
              finish(selectNewestRelease(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
            } catch {
              finish(undefined);
            }
          });
          response.once("error", () => finish(undefined));
        },
      );
      request.setTimeout(REQUEST_TIMEOUT_MS, () => {
        request.destroy(new Error("GitHub release check timed out"));
      });
      request.once("error", () => finish(undefined));
    } catch {
      finish(undefined);
    }
  });
}

function currentExtensionVersion(context: vscode.ExtensionContext): string {
  const packageJson = context.extension.packageJSON as Record<string, unknown>;
  return typeof packageJson["version"] === "string" ? packageJson["version"] : "";
}

export async function checkForExtensionUpdate(
  context: vscode.ExtensionContext,
  fetcher: LatestReleaseFetcher = fetchLatestRelease,
): Promise<void> {
  try {
    const enabled = vscode.workspace
      .getConfiguration("tokenlighten")
      .get<boolean>("updateCheck.enabled", true);
    if (!enabled) return;

    const current = currentExtensionVersion(context);
    const release = await fetcher();
    if (!release || !isVersionNewer(release.tagName, current)) return;

    const target = selectReleaseTarget(release);
    if (!target) return;

    const japanese = getDisplayLanguage() === "ja";
    const action = target.directVsix
      ? japanese ? "GitHubからVSIXをダウンロード" : "Download VSIX from GitHub"
      : japanese ? "GitHubリリースを開く" : "Open GitHub release";
    const message = japanese
      ? `TokenLighten ${release.tagName} が利用できます（現在: ${current}）。`
      : `TokenLighten ${release.tagName} is available (installed: ${current}).`;

    const selected = await vscode.window.showInformationMessage(message, action);
    if (selected !== action) return;
    await vscode.env.openExternal(vscode.Uri.parse(target.url, true));
  } catch {
    // Update checks are best-effort and must never block extension activation.
  }
}
