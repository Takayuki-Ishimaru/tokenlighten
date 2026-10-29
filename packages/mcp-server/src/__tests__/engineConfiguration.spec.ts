import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { activeEngineConfiguration, activeEngineDiscoveryGaps, defaultEngineConfiguration,
  engineConfigurationSha256, readEngineConfiguration, readEngineConfigurationStrict, recordEngineDiscoveryGap, withEngineConfiguration, writeEngineConfiguration, updateEngineConfiguration } from "../features/engines/config.js";
import { computedConfigSha256 } from "../util/trace.js";

describe("local engine settings", () => {
  it("preserves malformed settings during updates while runtime reads disable execution", () => {
    const root = mkdtempSync(join(tmpdir(), "tl-engines-malformed-"));
    const file = join(root, "engines.json");
    const original = '{"version":1,"typedSymbols":{"servers":{"go":{"command":"/custom/gopls"}}}';
    try {
      writeFileSync(file, original);
      expect(readEngineConfiguration(file).typedSymbols.enabled).toBe(false);
      expect(() => readEngineConfigurationStrict(file)).toThrow("existing settings were preserved");
      expect(() => updateEngineConfiguration(config => { config.semanticSearch.enabled = true; }, file)).toThrow("existing settings were preserved");
      expect(readFileSync(file, "utf8")).toBe(original);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("serializes updates from independent processes and releases the lock after a failed mutation", async () => {
    const root = mkdtempSync(join(tmpdir(), "tl-engines-concurrent-"));
    const file = join(root, "engines.json");
    const source = new URL("../features/engines/config.ts", import.meta.url).href;
    const script = `import {updateEngineConfiguration} from ${JSON.stringify(source)};
      process.send('ready');
      process.once('message', () => {
        updateEngineConfiguration(config => {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
          config[process.argv[2]].enabled = false;
        }, process.argv[1]);
        process.disconnect();
      });`;
    const children: ReturnType<typeof spawn>[] = [];
    try {
      const initial = defaultEngineConfiguration(); initial.typedSymbols.enabled = true;
      writeEngineConfiguration(initial, file);
      const records = ["typedSymbols", "compoundRequests"].map(key => {
        const child = spawn(process.execPath, ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href, "--input-type=module", "-e", script, file, key],
          { stdio: ["ignore", "ignore", "pipe", "ipc"] });
        children.push(child);
        let stderr = ""; child.stderr!.on("data", chunk => { stderr += String(chunk); });
        const ready = new Promise<void>((resolve, reject) => { child.once("message", () => resolve()); child.once("error", reject); child.once("exit", code => { if (code !== 0) reject(new Error(stderr)); }); });
        const done = new Promise<number | null>(resolve => child.once("close", resolve));
        return { child, ready, done, stderr: () => stderr };
      });
      await Promise.all(records.map(record => record.ready));
      for (const record of records) record.child.send("go");
      expect(await Promise.all(records.map(record => record.done)), records.map(record => record.stderr()).join("\n")).toEqual([0, 0]);
      expect(readEngineConfiguration(file)).toMatchObject({ typedSymbols: { enabled: false }, compoundRequests: { enabled: false } });
      expect(() => updateEngineConfiguration(() => { throw new Error("mutation failed"); }, file)).toThrow("mutation failed");
      updateEngineConfiguration(config => { config.semanticSearch.enabled = true; }, file);
      expect(readEngineConfiguration(file).semanticSearch.enabled).toBe(true);
    } finally { for (const child of children) if (child.exitCode === null) child.kill("SIGKILL"); rmSync(root, { recursive: true, force: true }); }
  }, 10_000);
  it("fingerprints effective settings in stable key order without exposing command arguments", async () => {
    const config = defaultEngineConfiguration();
    config.typedSymbols.enabled = true;
    config.typedSymbols.servers.py = { command: "private-server", args: ["private-value", "--stdio"], configuration: { z: 2, a: { y: 1, x: 0 } } };
    const reordered = structuredClone(config);
    reordered.typedSymbols.servers.py!.configuration = { a: { x: 0, y: 1 }, z: 2 };
    expect(engineConfigurationSha256(reordered)).toBe(engineConfigurationSha256(config));
    reordered.semanticSearch.cacheDir = "/different-home/models";
    expect(engineConfigurationSha256(reordered)).toBe(engineConfigurationSha256(config));
    reordered.typedSymbols.servers.py!.args!.reverse();
    expect(engineConfigurationSha256(reordered)).not.toBe(engineConfigurationSha256(config));
    expect(engineConfigurationSha256(config)).toMatch(/^[a-f0-9]{64}$/);
    const off = structuredClone(config); off.typedSymbols.enabled = false; off.compoundRequests.enabled = false;
    const fingerprints = await Promise.all([config, off].map(value => withEngineConfiguration(value, async () => {
      const before = computedConfigSha256(); await Promise.resolve(); expect(computedConfigSha256()).toBe(before); return before;
    })));
    expect(fingerprints[0]).not.toBe(fingerprints[1]);
    off.typedSymbols.servers.py!.command = "other-unused-command";
    const baseline = structuredClone(off); baseline.typedSymbols.servers = {};
    expect(engineConfigurationSha256(off)).toBe(engineConfigurationSha256(baseline));
  });
  it("keeps typed execution opt-in when settings are absent or partial", () => {
    const config = readEngineConfiguration(join(tmpdir(), "missing-tl-engines", "engines.json"));
    expect(config.typedSymbols.enabled).toBe(false);
    expect(config.typedSymbols.discoverServers).toBe(false);
    expect(config.compoundRequests.enabled).toBe(true);
    expect(config.semanticSearch.enabled).toBe(false);
    const root = mkdtempSync(join(tmpdir(), "tl-engines-partial-"));
    try {
      const file = join(root, "engines.json");
      writeFileSync(file, JSON.stringify({ version: 1, typedSymbols: { servers: {} } }));
      expect(readEngineConfigurationStrict(file).typedSymbols.enabled).toBe(false);
      writeFileSync(file, JSON.stringify({ version: 1, typedSymbols: { enabled: true } }));
      expect(readEngineConfigurationStrict(file).typedSymbols.enabled).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("roundtrips advanced server options and rejects malformed execution settings", () => {
    const root = mkdtempSync(join(tmpdir(), "tl-engines-config-"));
    try {
      const file = join(root, "engines.json");
      const config = defaultEngineConfiguration();
      config.typedSymbols.servers.py = { command: "pyright-langserver", args: ["--stdio"], initializationOptions: { mode: "types" }, configuration: { python: { analysis: { typeCheckingMode: "strict" } } } };
      writeEngineConfiguration(config, file);
      expect(readEngineConfiguration(file)).toEqual(config);
      for (const malformed of ["invalid", [], { enabled: true, discoverServers: true, servers: [] }]) {
        writeFileSync(file, JSON.stringify({ version: 1, typedSymbols: malformed }));
        expect(readEngineConfiguration(file).typedSymbols.enabled).toBe(false);
        expect(readEngineConfiguration(file).typedSymbols.discoverServers).toBe(false);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("rejects oversized serialized settings before replacing the last valid configuration", () => {
    const root = mkdtempSync(join(tmpdir(), "tl-engines-config-size-"));
    try {
      const file = join(root, "engines.json"); const previous = defaultEngineConfiguration();
      writeEngineConfiguration(previous, file);
      const oversized = structuredClone(previous);
      oversized.typedSymbols.servers.py = { command: "pyright-langserver", initializationOptions: { payload: "x".repeat(32 * 1024) } };
      expect(() => writeEngineConfiguration(oversized, file)).toThrow("existing settings were preserved");
      expect(readEngineConfiguration(file)).toEqual(previous);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("isolates captured settings and original-query discovery gaps across concurrent requests", async () => {
    const one = defaultEngineConfiguration(); const two = defaultEngineConfiguration();
    two.compoundRequests.enabled = false;
    const results = await Promise.all([one, two].map((config, index) => withEngineConfiguration(config, async () => {
      await Promise.resolve(); recordEngineDiscoveryGap("query", `gap-${index}`); recordEngineDiscoveryGap("auxiliary", "ignored");
      return { enabled: activeEngineConfiguration().compoundRequests.enabled, gaps: activeEngineDiscoveryGaps() };
    }, "query")));
    expect(results).toEqual([{ enabled: true, gaps: ["gap-0"] }, { enabled: false, gaps: ["gap-1"] }]);
    expect(activeEngineDiscoveryGaps()).toEqual([]);
  });
});
