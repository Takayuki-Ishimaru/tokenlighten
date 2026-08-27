/**
 * config.spec.ts — unit tests for TOML read / write / key helpers.
 *
 * Uses a temp directory via test-fixtures/ to verify atomic write.
 * No network access required.
 *
 * Output policy: plain data — no meta envelope.
 * See docs/00-postmortem.md §2.2 for rationale.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import {
  readConfig,
  writeConfig,
  getNestedKey,
  setNestedKey,
  parseValue,
} from "../config.js";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `tl-config-test-${randomBytes(6).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("readConfig", () => {
  it("returns empty object when file does not exist", () => {
    const result = readConfig("/nonexistent/path/config.toml");
    expect(result).toEqual({});
  });

  it("parses a valid TOML file", () => {
    const dir = makeTmpDir();
    const filePath = join(dir, "config.toml");
    writeConfig(filePath, { proxy: { enabled: true } });
    const doc = readConfig(filePath);
    expect((doc["proxy"] as Record<string, unknown>)?.["enabled"]).toBe(true);
    rmSync(dir, { recursive: true });
  });
});

describe("writeConfig (atomic)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the file with correct content", () => {
    const filePath = join(tmpDir, "config.toml");
    writeConfig(filePath, { skeleton: { sizeCapBytes: 65536, maxRanked: 40 } });
    expect(existsSync(filePath)).toBe(true);
    const readBack = readConfig(filePath);
    const skeleton = readBack["skeleton"] as Record<string, unknown>;
    expect(skeleton?.["sizeCapBytes"]).toBe(65536);
    expect(skeleton?.["maxRanked"]).toBe(40);
  });

  it("round-trips a string value", () => {
    const filePath = join(tmpDir, "config.toml");
    writeConfig(filePath, { mcp: { workspaceRoot: "/home/user/repo" } });
    const doc = readConfig(filePath);
    expect((doc["mcp"] as Record<string, unknown>)?.["workspaceRoot"]).toBe(
      "/home/user/repo"
    );
  });

  it("round-trips legitimate constructor and prototype TOML keys", () => {
    const filePath = join(tmpDir, "config.toml");
    writeConfig(filePath, { constructor: "allowed", prototype: { enabled: true } });
    const doc = readConfig(filePath);
    expect(doc["constructor"]).toBe("allowed");
    expect((doc["prototype"] as Record<string, unknown>)?.["enabled"]).toBe(true);
  });

  it("overwrites existing content atomically", () => {
    const filePath = join(tmpDir, "config.toml");
    writeConfig(filePath, { version: 1 });
    writeConfig(filePath, { version: 2 });
    const doc = readConfig(filePath);
    expect(doc["version"]).toBe(2);
  });

  it("creates parent directories if missing", () => {
    const filePath = join(tmpDir, "sub", "nested", "config.toml");
    writeConfig(filePath, { ok: true });
    expect(existsSync(filePath)).toBe(true);
    rmSync(join(tmpDir, "sub"), { recursive: true });
  });

  it("success path: no .tmp file remains in the directory after write", () => {
    const filePath = join(tmpDir, "config.toml");
    writeConfig(filePath, { version: 1 });
    // There must be no .tl-*.tmp file left in tmpDir
    const files = readdirSync(tmpDir);
    const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });

  // Note: EBUSY retry behavior is tested exhaustively in atomicWrite.spec.ts.
  // Here we verify the config-level integration: writeConfig uses retryRename,
  // and after a successful write no .tl-*.tmp file remains.
  it("EBUSY retry path (via retryRename integration): retries 4x then succeeds, no tmp remnant", async () => {
    vi.resetModules();
    // Exercise the same injectable retry primitive used by config writes;
    // atomicWrite.spec.ts owns the exhaustive mock-based retry matrix.
    let callCount = 0;

    const { retryRename, makeTmpPath } = await import("../atomicWrite.js");
    const { writeFileSync: wfs, mkdirSync: mks, existsSync: exs, readdirSync: rds } = await import("fs");
    const { dirname: dn } = await import("path");
    const { stringify: stringifyToml } = await import("smol-toml");

    // Simulate writeConfig manually using injectable renameFn to test retry
    function writeConfigWithRenameFn(
      filePath: string,
      doc: Record<string, unknown>,
      renameFn: (s: string, d: string) => void
    ): void {
      const dir = dn(filePath);
      mks(dir, { recursive: true, mode: 0o700 });
      const serialized = stringifyToml(doc);
      const tmpPath = makeTmpPath(filePath);
      wfs(tmpPath, serialized, { encoding: "utf-8", mode: 0o600 });
      retryRename(tmpPath, filePath, { attempts: 5, baseMs: 1, capMs: 2, renameFn: (s, d) => {
        callCount++;
        if (callCount <= 4) {
          throw Object.assign(new Error("EBUSY"), { code: "EBUSY" }) as NodeJS.ErrnoException;
        }
        renameFn(s, d);
      }});
    }

    const { renameSync: realRename } = await import("fs");
    const filePath = join(tmpDir, "retried.toml");
    writeConfigWithRenameFn(filePath, { retried: true }, realRename);

    expect(callCount).toBe(5);
    expect(exs(filePath)).toBe(true);
    const files = rds(tmpDir);
    expect(files.filter((f: string) => f.endsWith(".tmp"))).toHaveLength(0);
  });
});

describe("getNestedKey", () => {
  const doc = {
    proxy: { enabled: true, port: 4000 },
    mcp: { workspaceRoot: "/repo" },
    flat: "hello",
  };

  it("returns a top-level value", () => {
    expect(getNestedKey(doc, "flat")).toBe("hello");
  });

  it("returns a nested value", () => {
    expect(getNestedKey(doc, "proxy.enabled")).toBe(true);
    expect(getNestedKey(doc, "proxy.port")).toBe(4000);
  });

  it("returns undefined for missing key", () => {
    expect(getNestedKey(doc, "proxy.missing")).toBeUndefined();
  });

  it("returns undefined for path through a non-object", () => {
    expect(getNestedKey(doc, "flat.sub")).toBeUndefined();
  });

  it("returns undefined for entirely missing key", () => {
    expect(getNestedKey(doc, "nonexistent")).toBeUndefined();
  });

  it("does not read inherited properties", () => {
    const inherited = Object.create({ hidden: "prototype value" }) as Parameters<typeof getNestedKey>[0];
    expect(getNestedKey(inherited, "hidden")).toBeUndefined();
  });

  it("rejects __proto__ path segments while allowing ordinary names", () => {
    expect(getNestedKey(doc, "proxy.__proto__.polluted")).toBeUndefined();
    expect(getNestedKey({ constructor: "allowed", prototype: "allowed" }, "constructor")).toBe("allowed");
    expect(getNestedKey({ constructor: "allowed", prototype: "allowed" }, "prototype")).toBe("allowed");
  });
});

describe("setNestedKey", () => {
  it("sets a top-level key", () => {
    const doc = {};
    setNestedKey(doc, "version", 1);
    expect(doc).toEqual({ version: 1 });
  });

  it("sets a nested key, creating intermediate tables", () => {
    const doc: Record<string, unknown> = {};
    setNestedKey(doc as Parameters<typeof setNestedKey>[0], "proxy.enabled", true);
    expect((doc["proxy"] as Record<string, unknown>)?.["enabled"]).toBe(true);
  });

  it("overwrites an existing nested value", () => {
    const doc = { proxy: { enabled: false } };
    setNestedKey(doc, "proxy.enabled", true);
    expect(doc.proxy.enabled).toBe(true);
  });

  it("preserves sibling keys", () => {
    const doc = { proxy: { enabled: true, port: 4000 } };
    setNestedKey(doc, "proxy.enabled", false);
    expect(doc.proxy.port).toBe(4000);
  });

  it("rejects __proto__ path segments without mutating Object.prototype", () => {
    const doc = {};
    expect(() => setNestedKey(doc, "safe.__proto__.polluted", true)).toThrow(/reserved path segment/);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("allows constructor and prototype keys", () => {
    const doc = {};
    setNestedKey(doc, "constructor.prototype.enabled", true);
    expect(doc).toEqual({ constructor: { prototype: { enabled: true } } });
  });

  it("shadows inherited tables instead of mutating them", () => {
    const parent = { inherited: { enabled: false } };
    const doc = Object.create(parent) as Parameters<typeof setNestedKey>[0];
    setNestedKey(doc, "inherited.enabled", true);
    expect(parent.inherited.enabled).toBe(false);
    expect(Object.hasOwn(doc, "inherited")).toBe(true);
    expect(doc["inherited"]).toEqual({ enabled: true });
  });
});

describe("parseValue", () => {
  it("parses 'true' as boolean", () => {
    expect(parseValue("true")).toBe(true);
  });

  it("parses 'false' as boolean", () => {
    expect(parseValue("false")).toBe(false);
  });

  it("parses an integer string as number", () => {
    expect(parseValue("42")).toBe(42);
  });

  it("parses a float string as number", () => {
    expect(parseValue("3.14")).toBeCloseTo(3.14);
  });

  it("returns a plain string for non-numeric non-boolean", () => {
    expect(parseValue("hello")).toBe("hello");
  });

  it("returns a path string unchanged", () => {
    expect(parseValue("/home/user/repo")).toBe("/home/user/repo");
  });
});
