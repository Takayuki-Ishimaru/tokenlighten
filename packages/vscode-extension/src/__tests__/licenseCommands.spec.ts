import { beforeEach, describe, expect, it, vi } from "vitest";
import { E5_MIT_NOTICE, MULTILINGUAL_E5_MODEL } from "@tokenlighten/types";
import type { SpawnResult } from "../cli.js";

const {
  mockReadFile, mockSpawnTl, mockCreatePanel, mockRegisterCommand, mockExecuteCommand,
  mockShowError, mockQuickPick, mockInputBox, mockWithProgress, state,
} = vi.hoisted(() => ({
  mockReadFile: vi.fn(), mockSpawnTl: vi.fn(), mockCreatePanel: vi.fn(),
  mockRegisterCommand: vi.fn(), mockExecuteCommand: vi.fn(), mockShowError: vi.fn(),
  mockQuickPick: vi.fn(), mockInputBox: vi.fn(), mockWithProgress: vi.fn(),
  state: { trusted: true, language: "en" as "en" | "ja" },
}));

vi.mock("vscode", () => ({
  commands: { registerCommand: mockRegisterCommand, executeCommand: mockExecuteCommand },
  window: {
    createWebviewPanel: mockCreatePanel, showErrorMessage: mockShowError,
    showQuickPick: mockQuickPick, showInputBox: mockInputBox, withProgress: mockWithProgress,
  },
  workspace: { get isTrusted() { return state.trusted; } },
  ViewColumn: { One: 1 }, ProgressLocation: { Notification: 15 },
}));
vi.mock("node:fs/promises", () => ({ readFile: mockReadFile }));
vi.mock("../cli.js", () => ({ spawnTl: mockSpawnTl }));
vi.mock("../statusBar.js", () => ({ getDisplayLanguage: () => state.language }));

import { registerLicenseCommands } from "../licenses.js";

interface Panel {
  webview: { html: string; onDidReceiveMessage: ReturnType<typeof vi.fn> };
  onDidDispose: ReturnType<typeof vi.fn>;
  subscriptionDispose: ReturnType<typeof vi.fn>;
  receive(message: unknown): Promise<void>;
  dispose(): void;
}

function makePanel(): Panel {
  let handler: ((message: unknown) => unknown) | undefined;
  let disposed: (() => void) | undefined;
  const subscriptionDispose = vi.fn();
  return {
    webview: {
      html: "",
      onDidReceiveMessage: vi.fn((callback: (message: unknown) => unknown) => {
        handler = callback;
        return { dispose: subscriptionDispose };
      }),
    },
    onDidDispose: vi.fn((callback: () => void) => {
      disposed = callback;
      return { dispose: vi.fn() };
    }),
    subscriptionDispose,
    async receive(message) { await handler?.(message); },
    dispose() { disposed?.(); },
  };
}

const registered = new Map<string, () => Promise<void>>();
const panels: Panel[] = [];
const notices = "| Package | License | Publisher | Repository |\n| --- | --- | --- | --- |\n| `tiny-package` | MIT | Example | https://example.test/tiny |\n\nMIT License\nPermission is hereby granted.\n";
const status = { config: { typedSymbols: { enabled: true, discoverServers: false, servers: {} }, compoundRequests: { enabled: true }, semanticSearch: { enabled: false } } };
const json = (value: unknown): SpawnResult => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });

function defaultSpawn(args: string[]): Promise<SpawnResult> {
  return Promise.resolve(json(args[0] === "engines" && args[1] === "status" ? status : { status: "ready" }));
}

beforeEach(() => {
  vi.resetAllMocks();
  registered.clear();
  panels.splice(0);
  state.trusted = true;
  state.language = "en";
  mockReadFile.mockResolvedValue(notices);
  mockSpawnTl.mockImplementation(defaultSpawn);
  mockRegisterCommand.mockImplementation((name: string, callback: () => Promise<void>) => {
    registered.set(name, callback);
    return { dispose: vi.fn() };
  });
  mockCreatePanel.mockImplementation(() => {
    const panel = makePanel();
    panels.push(panel);
    return panel;
  });
  mockExecuteCommand.mockResolvedValue(undefined);
  mockShowError.mockResolvedValue(undefined);
  mockWithProgress.mockImplementation(async (_options: unknown, task: (progress: unknown, token: unknown) => Promise<unknown>) => task({ report: vi.fn() }, {
    isCancellationRequested: false,
    onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })),
  }));
});

function register(): { subscriptions: unknown[]; extensionPath: string } {
  const context = { subscriptions: [] as unknown[], extensionPath: "/test-extension" };
  registerLicenseCommands(context as never);
  return context;
}

async function engines(): Promise<Panel> {
  register();
  await registered.get("tokenlighten.engines.show")!();
  return panels[0]!;
}

function escaped(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

describe("license and engine command registration", () => {
  it("registers both commands and adds both disposables to the extension lifetime", () => {
    const context = register();
    expect([...registered.keys()]).toEqual(["tokenlighten.licenses.show", "tokenlighten.engines.show"]);
    expect(context.subscriptions).toHaveLength(2);
  });

  it("shows bundled notices and the complete pinned model license when the CLI is unavailable", async () => {
    mockSpawnTl.mockRejectedValue(new Error("CLI unavailable"));
    register();
    await registered.get("tokenlighten.licenses.show")!();
    const content = panels[0]!.webview.html;
    expect(content).toContain("tiny-package");
    expect(content).toContain(escaped(MULTILINGUAL_E5_MODEL.id));
    expect(content).toContain(escaped(MULTILINGUAL_E5_MODEL.revision));
    expect(content).toContain(escaped(MULTILINGUAL_E5_MODEL.source));
    expect(content).toContain(escaped(E5_MIT_NOTICE));
    expect(content).toContain('class="status available"');
    expect(mockShowError).not.toHaveBeenCalled();
    expect(mockSpawnTl).toHaveBeenCalledWith(["models", "list", "--json"]);
    expect(mockSpawnTl.mock.calls.some(([args]) => args[1] === "install")).toBe(false);
  });

  it("keeps model notices visible before the model is installed", async () => {
    mockSpawnTl.mockResolvedValue(json({ status: "missing" }));
    register();
    await registered.get("tokenlighten.licenses.show")!();
    expect(panels[0]!.webview.html).toContain(escaped(E5_MIT_NOTICE));
    expect(panels[0]!.webview.html).toContain('class="status available"');
  });

  it("tries the packaged dist notice path before giving up and localizes the missing-file message", async () => {
    mockReadFile.mockRejectedValueOnce(new Error("missing")).mockResolvedValueOnce(notices);
    register();
    await registered.get("tokenlighten.licenses.show")!();
    expect(mockReadFile.mock.calls.map(([file]) => file)).toEqual(["/test-extension/THIRD_PARTY_NOTICES.md", "/test-extension/dist/THIRD_PARTY_NOTICES.md"]);
    expect(panels[0]!.webview.html).toContain("tiny-package");
    state.language = "ja";
    mockReadFile.mockRejectedValue(new Error("missing"));
    await registered.get("tokenlighten.licenses.show")!();
    expect(panels[1]!.webview.html).toContain("拡張機能を再インストールしてください");
    expect(mockCreatePanel.mock.calls[1]?.[1]).toBe("TokenLighten ライセンス");
  });
});

describe("analysis engine panel", () => {
  it.each([{}, { config: {} }, { config: { ...status.config, typedSymbols: { enabled: "false" } } },
    { config: { ...status.config, compoundRequests: { enabled: "false" } } },
    { config: { ...status.config, semanticSearch: [] } },
    { config: { ...status.config, typedSymbols: { ...status.config.typedSymbols, servers: [] } } },
  ])("treats a successful CLI exit with malformed engine status as unknown: %j", async payload => {
    mockSpawnTl.mockImplementation((args: string[]) => Promise.resolve(json(args[0] === "engines" ? payload : { status: "ready" })));
    const panel = await engines();
    expect(panel.webview.html).toContain("Invalid TokenLighten engine status");
    expect(panel.webview.html).toMatch(/data-engine="typedSymbols"[^>]*\bdisabled\b/u);
    expect(panel.webview.html).toContain("Downloaded");
  });

  it.each([{}, { status: "unexpected" }, { status: true }])("treats malformed model readiness as unknown while preserving settings: %j", async payload => {
    mockSpawnTl.mockImplementation((args: string[]) => Promise.resolve(json(args[0] === "engines" ? status : payload)));
    const panel = await engines();
    expect(panel.webview.html).toContain("Invalid TokenLighten model status");
    expect(panel.webview.html).toContain("Status unavailable");
    expect(panel.webview.html).toContain('data-engine="typedSymbols" checked');
  });

  it("retains engine settings when only model status fails", async () => {
    mockSpawnTl.mockImplementation((args: string[]) => args[0] === "engines"
      ? Promise.resolve(json({ config: { ...status.config, typedSymbols: { enabled: true, discoverServers: true, servers: {} } } }))
      : Promise.reject(new Error("model cache unavailable")));
    const panel = await engines();
    expect(panel.webview.html).toContain('data-engine="typedSymbols" checked');
    expect(panel.webview.html).toContain('data-engine="compoundRequests" checked');
    expect(panel.webview.html).toContain('id="discover" type="checkbox" checked');
    expect(panel.webview.html).toContain("model cache unavailable");
    expect(panel.webview.html).toContain("Status unavailable");
  });

  it("retains model readiness and disables unknown engine settings when only engine status fails", async () => {
    mockSpawnTl.mockImplementation((args: string[]) => args[0] === "engines"
      ? Promise.reject(new Error("engine config unavailable")) : Promise.resolve(json({ status: "ready" })));
    const panel = await engines();
    expect(panel.webview.html).toContain("Downloaded");
    expect(panel.webview.html).toMatch(/data-engine="typedSymbols"[^>]*\bdisabled\b/u);
    expect(panel.webview.html).toMatch(/id="discover"[^>]*\bdisabled\b/u);
    expect(panel.webview.html).toContain("engine config unavailable");
    expect(mockSpawnTl.mock.calls.every(([args]) => args[1] === "status" || args[1] === "list")).toBe(true);
  });

  it("renders model readiness, configured server metadata and escaped errors", async () => {
    const malicious = '</pre><script>alert("x")</script>&';
    mockSpawnTl.mockImplementation((args: string[]) => args[0] === "engines"
      ? Promise.resolve(json({ config: { ...status.config, typedSymbols: { enabled: true, discoverServers: true, servers: { py: { command: malicious, args: [malicious] } } } } }))
      : Promise.resolve(json({ status: "ready" })));
    const panel = await engines();
    expect(panel.webview.html).toContain("Downloaded");
    expect(panel.webview.html).toContain('id="discover" type="checkbox" checked');
    expect(panel.webview.html).not.toContain(malicious);
    expect(panel.webview.html).toContain("&lt;script&gt;");
    expect(panel.webview.html.match(/<script nonce=/gu)).toHaveLength(1);
    expect(panel.webview.html).toContain("default-src 'none'");
    expect(mockCreatePanel.mock.calls[0]?.[3]).toEqual({ enableScripts: true, localResourceRoots: [] });
    panel.dispose();
    expect(panel.subscriptionDispose).toHaveBeenCalledOnce();
    mockSpawnTl.mockRejectedValue(new Error(malicious));
    await registered.get("tokenlighten.engines.show")!();
    expect(panels[1]!.webview.html).toContain(escaped(malicious));
    expect(panels[1]!.webview.html).not.toContain(malicious);
  });

  it.each(["typedSymbols", "compoundRequests", "semanticSearch"])("applies the allowlisted %s setting and refreshes", async (engine) => {
    const panel = await engines();
    mockSpawnTl.mockClear();
    await panel.receive({ action: "set", engine, enabled: false });
    expect(mockSpawnTl.mock.calls.map(([args]) => args)).toEqual([
      ["engines", "set", engine, "off"], ["engines", "status", "--json"], ["models", "list", "--json"],
    ]);
    expect(mockShowError).not.toHaveBeenCalled();
  });

  it("toggles installed-server discovery and opens licenses through the command dispatcher", async () => {
    const panel = await engines();
    mockSpawnTl.mockClear();
    await panel.receive({ action: "discovery", enabled: true });
    expect(mockSpawnTl).toHaveBeenCalledWith(["engines", "discovery", "on"]);
    mockSpawnTl.mockClear();
    await panel.receive({ action: "licenses" });
    expect(mockExecuteCommand).toHaveBeenCalledWith("tokenlighten.licenses.show");
    expect(mockSpawnTl).not.toHaveBeenCalled();
  });

  it.each([
    {}, { action: "unknown" }, { action: "set", engine: "__proto__", enabled: true },
    { action: "set", engine: "typedSymbols", enabled: "true" }, { action: "discovery", enabled: "false" },
    { action: "set", engine: ["typedSymbols"], enabled: true },
  ])("leaves invalid webview actions inert: %j", async (message) => {
    const panel = await engines();
    mockSpawnTl.mockClear();
    await panel.receive(message);
    expect(mockSpawnTl).not.toHaveBeenCalled();
    expect(mockWithProgress).not.toHaveBeenCalled();
    expect(mockQuickPick).not.toHaveBeenCalled();
    expect(mockExecuteCommand).not.toHaveBeenCalled();
  });

  it.each([{ action: "set", engine: "typedSymbols", enabled: true }, { action: "discovery", enabled: true }, { action: "server" }, { action: "install" }])("prevents execution of a setting or installation action in an untrusted workspace: %j", async (message) => {
    const panel = await engines();
    state.trusted = false;
    mockSpawnTl.mockClear();
    await panel.receive(message);
    expect(mockSpawnTl).not.toHaveBeenCalled();
    expect(mockWithProgress).not.toHaveBeenCalled();
    expect(mockQuickPick).not.toHaveBeenCalled();
    expect(mockShowError).toHaveBeenCalledWith("Configure engines from a trusted workspace.");
  });

  it("passes the chosen server executable and JSON arguments as an array without shell parsing", async () => {
    const panel = await engines();
    const executable = "/opt/Language Servers/py server; echo unsafe";
    const args = ["--stdio", "argument with spaces", "$(not-a-command)", 'quoted"argument'];
    mockQuickPick.mockResolvedValue("py");
    mockInputBox.mockResolvedValueOnce(executable).mockResolvedValueOnce(JSON.stringify(args));
    mockSpawnTl.mockClear();
    await panel.receive({ action: "server" });
    expect(mockSpawnTl.mock.calls[0]?.[0]).toEqual(["engines", "server", "py", executable, ...args]);
    expect(mockQuickPick.mock.calls[0]?.[0]).toEqual(["py", "go", "rs", "java", "c", "cpp", "cs", "kt", "php", "rb"]);
  });

  it.each(['{"flag":true}', '["--stdio", 2]', 'not json'])("rejects invalid JSON server arguments: %s", async (rawArgs) => {
    const panel = await engines();
    mockQuickPick.mockResolvedValue("go");
    mockInputBox.mockResolvedValueOnce("gopls").mockResolvedValueOnce(rawArgs);
    mockSpawnTl.mockClear();
    await panel.receive({ action: "server" });
    expect(mockSpawnTl).not.toHaveBeenCalled();
    expect(mockShowError).toHaveBeenCalledOnce();
  });

  it("does not execute a server configuration when an input prompt is cancelled", async () => {
    const panel = await engines();
    mockQuickPick.mockResolvedValue("rs");
    mockInputBox.mockResolvedValueOnce("rust-analyzer").mockResolvedValueOnce(undefined);
    mockSpawnTl.mockClear();
    await panel.receive({ action: "server" });
    expect(mockSpawnTl).not.toHaveBeenCalled();
    expect(mockShowError).not.toHaveBeenCalled();
  });

  it("forwards cancellable model-install progress to an AbortSignal and disposes the listener", async () => {
    const panel = await engines();
    let cancel: (() => void) | undefined;
    const cancellationDispose = vi.fn();
    mockWithProgress.mockImplementation(async (_options: unknown, task: (progress: unknown, token: unknown) => Promise<unknown>) => task({}, {
      isCancellationRequested: false,
      onCancellationRequested: (callback: () => void) => { cancel = callback; return { dispose: cancellationDispose }; },
    }));
    let finishInstall: ((value: SpawnResult) => void) | undefined;
    mockSpawnTl.mockImplementation((args: string[]) => args[0] === "models" && args[1] === "install"
      ? new Promise<SpawnResult>((resolve) => { finishInstall = resolve; }) : defaultSpawn(args));
    mockSpawnTl.mockClear();
    const pending = panel.receive({ action: "install" });
    await vi.waitFor(() => expect(finishInstall).toBeDefined());
    const [args, options] = mockSpawnTl.mock.calls[0]! as [string[], { timeoutMs: number; signal: AbortSignal }];
    expect(args).toEqual(["models", "install", "--json"]);
    expect(options.timeoutMs).toBe(900_000);
    expect(options.signal.aborted).toBe(false);
    expect(mockWithProgress.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ cancellable: true, location: 15 }));
    cancel!();
    expect(options.signal.aborted).toBe(true);
    finishInstall!({ code: null, stdout: "", stderr: "Cancelled" });
    await pending;
    expect(cancellationDispose).toHaveBeenCalledOnce();
    expect(mockShowError).toHaveBeenCalledWith("Cancelled");
  });

  it("honors a cancellation requested before the progress callback starts", async () => {
    const panel = await engines();
    mockWithProgress.mockImplementation(async (_options: unknown, task: (progress: unknown, token: unknown) => Promise<unknown>) => task({}, {
      isCancellationRequested: true,
      onCancellationRequested: () => ({ dispose: vi.fn() }),
    }));
    mockSpawnTl.mockClear();
    await panel.receive({ action: "install" });
    const install = mockSpawnTl.mock.calls.find(([args]) => args[0] === "models" && args[1] === "install");
    expect(install === undefined || (install[1] as { signal?: AbortSignal })?.signal?.aborted === true).toBe(true);
  });

  it("keeps status parse or CLI failures as visible errors without performing a mutation", async () => {
    mockSpawnTl.mockResolvedValue({ code: 0, stdout: "[]", stderr: "" });
    const panel = await engines();
    expect(panel.webview.html).toContain("Invalid TokenLighten status");
    mockSpawnTl.mockResolvedValue({ code: 9, stdout: "", stderr: "permission denied" });
    mockSpawnTl.mockClear();
    await panel.receive({ action: "set", engine: "compoundRequests", enabled: true });
    expect(mockSpawnTl.mock.calls.map(([args]) => args)).toEqual([["engines", "set", "compoundRequests", "on"], ["engines", "status", "--json"], ["models", "list", "--json"]]);
    expect(mockShowError).toHaveBeenCalledWith("permission denied");
  });

  it("serializes rapid settings changes so a second process cannot overwrite the first change", async () => {
    const panel = await engines();
    let release: ((result: SpawnResult) => void) | undefined;
    mockSpawnTl.mockClear();
    mockSpawnTl.mockImplementation((args: string[]) => args[1] === "set" && args[2] === "typedSymbols"
      ? new Promise<SpawnResult>(resolve => { release = resolve; }) : defaultSpawn(args));
    const first = panel.receive({ action: "set", engine: "typedSymbols", enabled: false });
    const second = panel.receive({ action: "set", engine: "compoundRequests", enabled: false });
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(mockSpawnTl.mock.calls.filter(([args]) => args[1] === "set").map(([args]) => args[2])).toEqual(["typedSymbols"]);
    release!(json({}));
    await Promise.all([first, second]);
    expect(mockSpawnTl.mock.calls.filter(([args]) => args[1] === "set").map(([args]) => args[2])).toEqual(["typedSymbols", "compoundRequests"]);
  });
});

it("review regression: a failed semantic toggle restores the persisted unchecked state", async () => {
  const panel = await engines();
  let changed: (() => void) | undefined;
  let pending: Promise<void> | undefined;
  const input = { checked: false, dataset: { engine: "semanticSearch" }, addEventListener: (_: string, callback: () => void) => { changed = callback; } };
  let currentHtml = panel.webview.html;
  Object.defineProperty(panel.webview, "html", { get: () => currentHtml, set: (value: string) => { currentHtml = value; input.checked = /data-engine="semanticSearch"\s+checked/.test(value); } });
  const script = currentHtml.match(/<script nonce="[^\"]+">([\s\S]*?)<\/script>/)![1]!;
  const {runInNewContext} = await import("node:vm");
  runInNewContext(script, {document:{querySelectorAll: (selector: string) => selector.includes("data-engine") ? [input] : [],getElementById: () => ({addEventListener: () => {}})},acquireVsCodeApi: () => ({postMessage: (message: unknown) => { pending = panel.receive(message); }})});
  mockSpawnTl.mockClear();
  mockSpawnTl.mockImplementation((args: string[]) => args[1] === "set" ? Promise.resolve({code: 1, stdout: "", stderr: "permission denied"}) : defaultSpawn(args));
  input.checked = true; changed!(); await pending;
  expect(mockShowError).toHaveBeenCalledWith("permission denied");
  expect(input.checked).toBe(false);
});
