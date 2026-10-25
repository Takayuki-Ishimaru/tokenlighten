import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import * as https from "node:https";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as vscode from "vscode";

const MAX_BYTES = 256 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 5;
const RELEASE_DOWNLOAD_PREFIX = "/takayuki-ishimaru/tokenlighten/releases/download/";
const ASSET_HOSTS = new Set([
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);

function validatedUrl(raw: string, initial: boolean): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new Error("Invalid VSIX download URL");
  }
  const githubAsset = url.hostname === "github.com"
    && url.pathname.toLowerCase().startsWith(RELEASE_DOWNLOAD_PREFIX)
    && /\/tokenlighten-vscode-extension-[\w.+-]+\.vsix$/.test(url.pathname);
  if (initial ? !githubAsset : !githubAsset && !ASSET_HOSTS.has(url.hostname)) {
    throw new Error("Untrusted VSIX download URL");
  }
  return url;
}

function requestResponse(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    let received = false;
    const request = https.get(url, {
      signal,
      headers: { "User-Agent": "TokenLighten-VSCode" },
    }, response => {
      received = true;
      resolve(response);
    });
    request.once("error", reject);
    request.once("close", () => {
      if (!received) reject(new Error("VSIX request closed before receiving a response"));
    });
  });
}

async function downloadResponse(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
  for (let redirects = 0; ; redirects++) {
    signal.throwIfAborted();
    const response = await requestResponse(url, signal);
    if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
      const location = response.headers.location;
      response.destroy();
      if (!location || redirects >= MAX_REDIRECTS) {
        throw new Error("Invalid or excessive VSIX download redirects");
      }
      url = validatedUrl(new URL(location, url).toString(), false);
      continue;
    }
    if (response.statusCode !== 200) {
      response.destroy();
      throw new Error(`VSIX download returned HTTP ${response.statusCode ?? "unknown"}`);
    }
    const length = response.headers["content-length"];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) {
      response.destroy();
      throw new Error("Invalid or oversized VSIX response");
    }
    return response;
  }
}

/** Install a release asset through VS Code, retaining the private file until it finishes. */
export async function installReleaseVsix(url: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const source = validatedUrl(url, true);
  const directory = await mkdtemp(join(tmpdir(), "tokenlighten-vsix-"));
  const controller = new AbortController();
  const abort = (): void => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(() => {
    controller.abort(new Error("VSIX download timed out"));
  }, DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await downloadResponse(source, controller.signal);
    const path = join(directory, "update.vsix");
    let bytes = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.byteLength;
        callback(bytes > MAX_BYTES ? new Error("VSIX download exceeds the size limit") : null,
          bytes > MAX_BYTES ? undefined : chunk);
      },
      flush(callback) {
        callback(bytes === 0 ? new Error("VSIX download is empty") : null);
      },
    });
    await pipeline(
      response,
      limit,
      createWriteStream(path, { flags: "wx", mode: 0o600 }),
      { signal: controller.signal },
    );
    clearTimeout(timer);
    controller.signal.throwIfAborted();
    signal.throwIfAborted();
    await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(path));
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    await rm(directory, { recursive: true, force: true });
  }
}
