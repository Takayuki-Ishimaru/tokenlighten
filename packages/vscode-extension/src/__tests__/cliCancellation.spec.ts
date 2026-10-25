import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { state, spawnSpy } = vi.hoisted(() => ({ state: { packageJson: "" }, spawnSpy: vi.fn() }));
vi.mock("node:module", async importOriginal => {
  const actual = await importOriginal<typeof import("node:module")>();
  return { ...actual, createRequire: (filename: Parameters<typeof actual.createRequire>[0]) => {
    const require = actual.createRequire(filename);
    const originalResolve = require.resolve;
    const resolve = ((specifier: string, options?: { paths?: string[] }) => specifier === "@tokenlighten/cli/package.json" ? state.packageJson : originalResolve(specifier, options)) as typeof require.resolve;
    resolve.paths = require.resolve.paths;
    return Object.assign(require, { resolve });
  } };
});
vi.mock("cross-spawn", async importOriginal => {
  const actual = await importOriginal<typeof import("cross-spawn")>();
  spawnSpy.mockImplementation(actual.default);
  return { default: Object.assign(spawnSpy, { sync: actual.default.sync }) };
});
import { spawnTl } from "../cli.js";

let root: string;
beforeEach(() => {
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), "tl-cli-cancellation-"));
  state.packageJson = join(root, "package.json");
  writeFileSync(state.packageJson, "{}");
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist", "index.js"), "process.on('SIGTERM',()=>{console.log('cleanup completed');process.exit(0)});require('node:fs').writeFileSync(process.argv[2],'ready');setInterval(()=>{},100);");
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("CLI cancellation with real child processes", () => {
  it("does not launch a CLI after cancellation was already requested", async () => {
    const controller = new AbortController(); controller.abort();
    const result = await spawnTl([join(root, "ready")], { signal: controller.signal });
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ stdout: "", stderr: "TokenLighten CLI cancelled", code: null });
  });

  // Windows terminates on SIGTERM rather than dispatching a JS signal handler.
  it.skipIf(process.platform === "win32")("does not report success when a cancelled CLI handles SIGTERM and exits zero", async () => {
    const controller = new AbortController();
    const ready = join(root, "ready");
    const pending = spawnTl([ready], { signal: controller.signal, timeoutMs: 5000 });
    try {
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 3000, interval: 10 });
      controller.abort();
      const result = await pending;
      expect(spawnSpy).toHaveBeenCalledOnce();
      expect(controller.signal.aborted).toBe(true);
      expect(result.stdout).toContain("cleanup completed");
      expect(result.code).toBeNull();
      expect(result.stderr).toContain("TokenLighten CLI cancelled");
    } finally { controller.abort(); await pending; }
  });
});
