import { EventEmitter } from "node:events";
import { access, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import type { IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGet, mockInstall, mockCreateWriteStream, mockMkdtemp, mockRm } = vi.hoisted(() => ({
  mockGet: vi.fn(), mockInstall: vi.fn(), mockCreateWriteStream: vi.fn(),
  mockMkdtemp: vi.fn(), mockRm: vi.fn(),
}));
vi.mock("node:https", () => ({ get: mockGet }));
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  mockCreateWriteStream.mockImplementation(actual.createWriteStream);
  return { ...actual, createWriteStream: mockCreateWriteStream };
});
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  mockMkdtemp.mockImplementation(actual.mkdtemp);
  mockRm.mockImplementation(actual.rm);
  return { ...actual, mkdtemp: mockMkdtemp, rm: mockRm };
});
vi.mock("vscode", () => ({
  commands: { executeCommand: mockInstall },
  Uri: { file: (fsPath: string) => ({ fsPath, scheme: "file" }) },
}));
import { installReleaseVsix } from "../extensionUpdater.js";

const URL = "https://github.com/Takayuki-Ishimaru/tokenlighten/releases/download/v0.10.0/tokenlighten-vscode-extension-0.10.0.vsix";
const signal = () => new AbortController().signal;
function response(chunks: Buffer[] = [Buffer.from("vsix payload")], status = 200, headers = {}): IncomingMessage {
  return Object.assign(Readable.from(chunks), { statusCode: status, headers }) as IncomingMessage;
}
function serve(stream: IncomingMessage): void {
  mockGet.mockImplementationOnce((_url: globalThis.URL, options: RequestOptions, callback: (res: IncomingMessage) => void) => {
    const request = new EventEmitter();
    stream.on("error", () => {});
    options.signal?.addEventListener("abort", () => {
      const error = new Error("aborted");
      request.emit("error", error);
      stream.destroy(error);
    }, { once: true });
    queueMicrotask(() => callback(stream));
    return request;
  });
}
async function expectCleaned(): Promise<void> {
  for (const result of mockMkdtemp.mock.results) {
    const directory = await result.value;
    await expect(access(directory)).rejects.toThrow();
  }
}
describe("release VSIX installation", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockInstall.mockReset().mockResolvedValue(undefined);
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    mockCreateWriteStream.mockReset().mockImplementation(actual.createWriteStream);
  });
  afterEach(() => vi.useRealTimers());

  it("streams to an exclusive file, retains it while installing, and cleans it afterward", async () => {
    serve(response([Buffer.from("first"), Buffer.from("second")]));
    let finish!: () => void;
    mockInstall.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const pending = installReleaseVsix(URL, signal());
    await vi.waitFor(() => expect(mockInstall).toHaveBeenCalledOnce());
    const [command, uri] = mockInstall.mock.calls[0] as [string, { fsPath: string }];
    expect(command).toBe("workbench.extensions.installExtension");
    expect(await readFile(uri.fsPath, "utf8")).toBe("firstsecond");
    expect(mockCreateWriteStream).toHaveBeenCalledWith(uri.fsPath, { flags: "wx", mode: 0o600 });
    finish();
    await pending;
    await expectCleaned();
  });

  it.each([
    "http://github.com/Takayuki-Ishimaru/tokenlighten/releases/download/v1/extension.vsix",
    "https://example.com/tokenlighten.vsix",
    "https://github.com/other/repo/releases/download/v1/tokenlighten-vscode-extension-1.vsix",
    "https://user:password@github.com/Takayuki-Ishimaru/tokenlighten/releases/download/v1/tokenlighten-vscode-extension-1.vsix",
    "https://github.com:8443/Takayuki-Ishimaru/tokenlighten/releases/download/v1/tokenlighten-vscode-extension-1.vsix",
    "https://github.com/Takayuki-Ishimaru/tokenlighten/releases/download/v1/runtime.zip",
  ])("rejects an invalid initial URL: %s", async url => {
    await expect(installReleaseVsix(url, signal())).rejects.toThrow();
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockMkdtemp).not.toHaveBeenCalled();
    expect(mockInstall).not.toHaveBeenCalled();
  });

  it("follows a GitHub asset redirect over HTTPS without forwarding credentials", async () => {
    serve(response([], 302, { location: "https://release-assets.githubusercontent.com/asset?signature=public" }));
    serve(response());
    await installReleaseVsix(URL, signal());
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(mockGet.mock.calls[1][0].hostname).toBe("release-assets.githubusercontent.com");
    expect(mockGet.mock.calls[1][1].headers).toEqual({ "User-Agent": "TokenLighten-VSCode" });
    expect(mockInstall).toHaveBeenCalledOnce();
    await expectCleaned();
  });

  it.each([
    "https://evil.example/asset.vsix",
    "http://release-assets.githubusercontent.com/asset",
    "https://token@objects.githubusercontent.com/asset",
    "https://objects.githubusercontent.com:8443/asset",
    "https://github.com/other/repo/releases/download/v1/extension.vsix",
  ])("rejects an untrusted redirect: %s", async location => {
    serve(response([], 302, { location }));
    await expect(installReleaseVsix(URL, signal())).rejects.toThrow();
    expect(mockGet).toHaveBeenCalledOnce();
    expect(mockInstall).not.toHaveBeenCalled();
    await expectCleaned();
  });

  it("rejects a redirect without a location and excessive redirects", async () => {
    serve(response([], 302));
    await expect(installReleaseVsix(URL, signal())).rejects.toThrow("redirect");
    for (let i = 0; i < 6; i++) {
      serve(response([], 302, { location: "https://objects.githubusercontent.com/asset" }));
    }
    await expect(installReleaseVsix(URL, signal())).rejects.toThrow("redirect");
    expect(mockGet).toHaveBeenCalledTimes(7);
    expect(mockInstall).not.toHaveBeenCalled();
    await expectCleaned();
  });

  it.each([404, 500])("does not install HTTP %s responses and cleans the directory", async status => {
    serve(response([], status));
    await expect(installReleaseVsix(URL, signal())).rejects.toThrow("HTTP");
    expect(mockInstall).not.toHaveBeenCalled();
    await expectCleaned();
  });

  it.each(["268435457", "invalid"])("rejects invalid or excessive content lengths: %s", async length => {
    serve(response([], 200, { "content-length": length }));
    await expect(installReleaseVsix(URL, signal())).rejects.toThrow("oversized");
    expect(mockInstall).not.toHaveBeenCalled();
    await expectCleaned();
  });

  it("enforces the streaming limit even without a content length", async () => {
    mockCreateWriteStream.mockImplementation(() => new Writable({
      write(_chunk, _encoding, callback) { callback(); },
    }));
    const chunk = Buffer.alloc(1024 * 1024);
    serve(response(Array(257).fill(chunk)));
    await expect(installReleaseVsix(URL, signal())).rejects.toThrow("size limit");
    expect(mockInstall).not.toHaveBeenCalled();
    await expectCleaned();
  });

  it("rejects an empty body", async () => {
    serve(response([]));
    await expect(installReleaseVsix(URL, signal())).rejects.toThrow("empty");
    expect(mockInstall).not.toHaveBeenCalled();
    await expectCleaned();
  });

  it("rejects an interrupted response and cleans up", async () => {
    const broken = Object.assign(new Readable({
      read() { this.destroy(new Error("broken stream")); },
    }), { statusCode: 200, headers: {} }) as IncomingMessage;
    serve(broken);
    await expect(installReleaseVsix(URL, signal())).rejects.toThrow("broken stream");
    expect(mockInstall).not.toHaveBeenCalled();
    await expectCleaned();
  });

  it("cleans up if the HTTP request fails before headers", async () => {
    mockGet.mockImplementationOnce(() => {
      const request = new EventEmitter();
      queueMicrotask(() => request.emit("error", new Error("offline")));
      return request;
    });
    await expect(installReleaseVsix(URL, signal())).rejects.toThrow("offline");
    expect(mockInstall).not.toHaveBeenCalled();
    await expectCleaned();
  });

  it("fails promptly if the request closes without a response", async () => {
    mockGet.mockImplementationOnce(() => {
      const request = new EventEmitter();
      queueMicrotask(() => request.emit("close"));
      return request;
    });
    await expect(installReleaseVsix(URL, signal())).rejects.toThrow("closed");
    expect(mockInstall).not.toHaveBeenCalled();
    await expectCleaned();
  });

  it("propagates installation failure and cleans the staged VSIX", async () => {
    serve(response());
    mockInstall.mockRejectedValue(new Error("install refused"));
    await expect(installReleaseVsix(URL, signal())).rejects.toThrow("install refused");
    await expectCleaned();
  });

  it("does not start downloading after an earlier abort", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(installReleaseVsix(URL, controller.signal)).rejects.toThrow();
    expect(mockMkdtemp).not.toHaveBeenCalled();
    expect(mockInstall).not.toHaveBeenCalled();
  });

  it("aborts during a streaming download and removes its partial file", async () => {
    const stream = Object.assign(new PassThrough(), { statusCode: 200, headers: {} }) as unknown as IncomingMessage;
    serve(stream);
    const controller = new AbortController();
    const pending = installReleaseVsix(URL, controller.signal);
    const rejection = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(mockCreateWriteStream).toHaveBeenCalledOnce());
    stream.push(Buffer.from("partial"));
    controller.abort();
    await rejection;
    expect(mockInstall).not.toHaveBeenCalled();
    await expectCleaned();
  });

  it("does not install when cancellation arrives as the download finishes", async () => {
    const controller = new AbortController();
    mockCreateWriteStream.mockImplementation(() => {
      const destination = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
      destination.once("finish", () => controller.abort());
      return destination;
    });
    serve(response());
    await expect(installReleaseVsix(URL, controller.signal)).rejects.toThrow();
    expect(mockInstall).not.toHaveBeenCalled();
    await expectCleaned();
  });

  it("bounds a response that keeps trickling data by an absolute two-minute timeout", async () => {
    vi.useFakeTimers();
    const stream = Object.assign(new PassThrough(), { statusCode: 200, headers: {} }) as unknown as IncomingMessage;
    serve(stream);
    const pending = installReleaseVsix(URL, signal());
    const rejection = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(mockCreateWriteStream).toHaveBeenCalledOnce());
    stream.push(Buffer.from("partial"));
    await vi.advanceTimersByTimeAsync(120_000);
    await rejection;
    expect(mockInstall).not.toHaveBeenCalled();
    await expectCleaned();
  });

  it("parallel downloads own separate directories and cannot clean one another", async () => {
    serve(response([Buffer.from("one")]));
    serve(response([Buffer.from("two")]));
    const finish: Array<() => void> = [];
    mockInstall.mockImplementation(() => new Promise<void>(resolve => finish.push(resolve)));
    const one = installReleaseVsix(URL, signal());
    const two = installReleaseVsix(URL, signal());
    await vi.waitFor(() => expect(mockInstall).toHaveBeenCalledTimes(2));
    const paths = mockInstall.mock.calls.map(call => (call[1] as { fsPath: string }).fsPath);
    expect(dirname(paths[0])).not.toBe(dirname(paths[1]));
    expect([await readFile(paths[0], "utf8"), await readFile(paths[1], "utf8")].sort()).toEqual(["one", "two"]);
    finish[0]();
    // Arrival order can vary; wait for this directory's actual cleanup.
    await vi.waitFor(async () => { await expect(access(dirname(paths[0]))).rejects.toThrow(); });
    await expect(access(paths[1])).resolves.toBeUndefined();
    finish[1]();
    await Promise.all([one, two]);
    await expectCleaned();
  });
});
