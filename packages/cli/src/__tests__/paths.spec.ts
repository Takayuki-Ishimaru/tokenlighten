/**
 * paths.spec.ts — unit tests for OS-aware path resolution.
 *
 * Mocks process.platform and relevant env vars to verify all 3 OS paths
 * without requiring the actual host to be each OS.
 *
 * IMPORTANT: tests must NOT touch the host filesystem for platform-specific
 * paths that would be invalid on the current OS (e.g. Windows paths on macOS).
 * All platform-specific assertions are pure string checks only.
 *
 * Output policy: plain data — no meta envelope.
 * See docs/00-postmortem.md §2.2 for rationale.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { mkdirSync } from "fs";

// We import the module under test AFTER mocking to avoid stale closure
// Note: vitest mocks work at the module level so we re-import dynamically.

const HOME = homedir();

describe("resolvePath / configFilePath", () => {
  const originalPlatform = process.platform;
  const originalEnv = { ...process.env };

  function clearTLEnv() {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("TOKENLIGHTEN_") || key.startsWith("XDG_")) {
        delete process.env[key];
      }
    }
    // Also unset umbrella
    delete process.env["TOKENLIGHTEN_HOME"];
  }

  afterEach(() => {
    // Restore platform
    Object.defineProperty(process, "platform", { value: originalPlatform });
    // Restore env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    // Clear module cache so resolvePath re-reads platform on next import
    vi.resetModules();
  });

  beforeEach(() => {
    clearTLEnv();
  });

  it("macOS: config dir resolves to ~/Library/Application Support/tokenlighten", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    vi.resetModules();
    const { resolvePath } = await import("../paths.js");
    const result = resolvePath("config");
    expect(result).toBe(
      join(HOME, "Library", "Application Support", "tokenlighten")
    );
  });

  it("macOS: cache dir resolves to ~/Library/Caches/tokenlighten", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    vi.resetModules();
    const { resolvePath } = await import("../paths.js");
    expect(resolvePath("cache")).toBe(
      join(HOME, "Library", "Caches", "tokenlighten")
    );
  });

  it("macOS: configFilePath ends with config.toml", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    vi.resetModules();
    const { configFilePath } = await import("../paths.js");
    expect(configFilePath()).toMatch(/config\.toml$/);
  });

  it("Linux: config dir defaults to ~/.config/tokenlighten", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    delete process.env["XDG_CONFIG_HOME"];
    vi.resetModules();
    const { resolvePath } = await import("../paths.js");
    expect(resolvePath("config")).toBe(
      join(HOME, ".config", "tokenlighten")
    );
  });

  it("Linux: XDG_CONFIG_HOME override is respected", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const customXdg = join(tmpdir(), "tl-test-xdg");
    mkdirSync(customXdg, { recursive: true });
    process.env["XDG_CONFIG_HOME"] = customXdg;
    vi.resetModules();
    const { resolvePath } = await import("../paths.js");
    expect(resolvePath("config")).toBe(join(customXdg, "tokenlighten"));
    delete process.env["XDG_CONFIG_HOME"];
  });

  // Windows path test: pure string assertion — NO fs operations on the resolved path.
  // On non-Windows hosts the path string is valid to compute but not to mkdir.
  it("Windows: config dir resolves to %APPDATA%\\tokenlighten\\Config (string only)", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    // Use a fake APPDATA value; resolvePath must NOT mkdir this on a POSIX host.
    process.env["APPDATA"] = "C:\\Users\\test\\AppData\\Roaming";
    vi.resetModules();
    const { resolvePath } = await import("../paths.js");
    // Assert string value only — do not allow fs side effects (ensureDir defaults false).
    const result = resolvePath("config");
    expect(result).toBe(
      join("C:\\Users\\test\\AppData\\Roaming", "tokenlighten", "Config")
    );
    delete process.env["APPDATA"];
  });

  it("per-bucket env override TOKENLIGHTEN_CONFIG_HOME takes priority", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    process.env["TOKENLIGHTEN_CONFIG_HOME"] = "/tmp/tl-test-config";
    vi.resetModules();
    const { resolvePath } = await import("../paths.js");
    expect(resolvePath("config")).toBe("/tmp/tl-test-config");
    delete process.env["TOKENLIGHTEN_CONFIG_HOME"];
  });

  it("umbrella TOKENLIGHTEN_HOME is used when per-bucket env is absent", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    process.env["TOKENLIGHTEN_HOME"] = "/tmp/tl-home";
    vi.resetModules();
    const { resolvePath } = await import("../paths.js");
    expect(resolvePath("config")).toBe(join("/tmp/tl-home", "config"));
    delete process.env["TOKENLIGHTEN_HOME"];
  });

  it("per-bucket env beats umbrella env", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    process.env["TOKENLIGHTEN_HOME"] = "/tmp/tl-home";
    process.env["TOKENLIGHTEN_CONFIG_HOME"] = "/tmp/tl-specific";
    vi.resetModules();
    const { resolvePath } = await import("../paths.js");
    expect(resolvePath("config")).toBe("/tmp/tl-specific");
    delete process.env["TOKENLIGHTEN_HOME"];
    delete process.env["TOKENLIGHTEN_CONFIG_HOME"];
  });

  it("resolvePath with leaf appends the leaf to the base", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    process.env["TOKENLIGHTEN_CONFIG_HOME"] = "/tmp/tl-leaf-test";
    vi.resetModules();
    const { resolvePath } = await import("../paths.js");
    expect(resolvePath("config", "config.toml")).toBe(
      "/tmp/tl-leaf-test/config.toml"
    );
    delete process.env["TOKENLIGHTEN_CONFIG_HOME"];
  });
});
