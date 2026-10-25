import { readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, isAbsolute, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { EngineConfiguration, LanguageServerCommand } from "@tokenlighten/types";
import { acquireWriterLock } from "../../state/writerLock.js";
const engineConfigurationStorage = new AsyncLocalStorage<{ config: EngineConfiguration; query?: string; gaps: Set<string> }>();

export function withEngineConfiguration<T>(config: EngineConfiguration, callback: () => T, query?: string): T {
  return engineConfigurationStorage.run({ config, query, gaps: new Set() }, callback);
}

export function activeEngineConfiguration(): EngineConfiguration {
  return engineConfigurationStorage.getStore()?.config ?? readEngineConfiguration();
}

export function recordEngineDiscoveryGap(query: string, gap: string): void {
  const state = engineConfigurationStorage.getStore();
  if (state?.query === query) state.gaps.add(gap);
}

export function activeEngineDiscoveryGaps(): string[] {
  return [...(engineConfigurationStorage.getStore()?.gaps ?? [])];
}

export function engineConfigPath(): string {
  return process.env.TOKENLIGHTEN_ENGINES_FILE || join(homedir(), ".tokenlighten", "engines.json");
}

export function defaultEngineConfiguration(): EngineConfiguration {
  return {
    version: 1,
    typedSymbols: { enabled: false, discoverServers: false, servers: {} },
    compoundRequests: { enabled: true },
    semanticSearch: { enabled: false, cacheDir: join(homedir(), ".tokenlighten", "models") },
  };
}

/** Effective settings only; traces receive this digest, never server arguments. */
export function engineConfigurationSha256(config: EngineConfiguration = activeEngineConfiguration()): string {
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, stable(item)]))
    : value;
  const effective = {
    version: config.version,
    typedSymbols: config.typedSymbols.enabled ? config.typedSymbols : { enabled: false },
    compoundRequests: config.compoundRequests,
    semanticSearch: config.semanticSearch.enabled ? config.semanticSearch : { enabled: false },
  };
  return createHash("sha256").update("tokenlighten-local-engines-v1\0").update(JSON.stringify(stable(effective))).digest("hex");
}

/** Invalid persisted settings disable optional execution rather than guessing. */
export function readEngineConfiguration(file = engineConfigPath()): EngineConfiguration {
  try { return readEngineConfigurationStrict(file); }
  catch {
    const defaults = defaultEngineConfiguration();
    return { ...defaults, typedSymbols: { ...defaults.typedSymbols, enabled: false }, compoundRequests: { enabled: false } };
  }
}

/** Mutations must not replace a malformed file with runtime fallback defaults. */
export function readEngineConfigurationStrict(file = engineConfigPath()): EngineConfiguration {
  const defaults = defaultEngineConfiguration();
  try {
    const raw = readFileSync(file);
    if (raw.length > 32 * 1024) throw new Error("Engine configuration exceeds 32 KiB");
    const value = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    if (!value || Array.isArray(value) || value.version !== 1) throw new Error("Unsupported engine configuration");
    for (const key of ["typedSymbols", "compoundRequests", "semanticSearch"]) {
      if (value[key] !== undefined && (!value[key] || typeof value[key] !== "object" || Array.isArray(value[key]))) throw new Error("Invalid engine settings object");
    }
    const typed = value.typedSymbols as Record<string, unknown> | undefined;
    const compound = value.compoundRequests as Record<string, unknown> | undefined;
    const semantic = value.semanticSearch as Record<string, unknown> | undefined;
    const servers: Record<string, LanguageServerCommand> = Object.create(null) as Record<string, LanguageServerCommand>;
    if (typed?.servers !== undefined && (!typed.servers || typeof typed.servers !== "object" || Array.isArray(typed.servers))) throw new Error("Invalid language server map");
    if (typed?.servers && typeof typed.servers === "object" && !Array.isArray(typed.servers)) {
      for (const [lang, rawCommand] of Object.entries(typed.servers)) {
        if (!/^(py|go|rs|java|c|cpp|cs|kt|php|rb|ts|js)$/.test(lang)) throw new Error("Unknown language server");
        const entry = rawCommand as Record<string, unknown>;
        if (!entry || typeof entry.command !== "string" || !entry.command.trim() || entry.command.length > 4096) throw new Error("Invalid language server command");
        if (entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.length > 64 || !entry.args.every(arg => typeof arg === "string" && arg.length <= 4096))) throw new Error("Invalid language server arguments");
        servers[lang] = { command: entry.command, ...(entry.args ? { args: entry.args as string[] } : {}),
          ...(entry.initializationOptions !== undefined ? { initializationOptions: entry.initializationOptions } : {}),
          ...(entry.configuration !== undefined ? { configuration: entry.configuration } : {}) };
      }
    }
    const bool = (record: Record<string, unknown> | undefined, key: string, fallback: boolean): boolean => {
      if (record?.[key] === undefined) return fallback;
      if (typeof record[key] !== "boolean") throw new Error("Engine setting must be boolean");
      return record[key] as boolean;
    };
    const cacheDir = semantic?.cacheDir ?? defaults.semanticSearch.cacheDir;
    if (typeof cacheDir !== "string" || !isAbsolute(cacheDir)) throw new Error("Model cache must be an absolute path");
    return {
      version: 1,
      typedSymbols: { enabled: bool(typed, "enabled", defaults.typedSymbols.enabled), discoverServers: bool(typed, "discoverServers", false), servers },
      compoundRequests: { enabled: bool(compound, "enabled", true) },
      semanticSearch: { enabled: bool(semantic, "enabled", false), cacheDir },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaults;
    throw new Error("Engine configuration could not be read; existing settings were preserved", { cause: error });
  }
}

export function writeEngineConfiguration(config: EngineConfiguration, file = engineConfigPath()): void {
  withConfigurationLock(file, () => writeConfigurationSnapshot(config, file));
}

/** Read/modify/write under one cross-process lock; callbacks must be synchronous. */
export function updateEngineConfiguration(change: (config: EngineConfiguration) => void, file = engineConfigPath()): EngineConfiguration {
  return withConfigurationLock(file, () => {
    const config = readEngineConfigurationStrict(file);
    change(config);
    writeConfigurationSnapshot(config, file);
    return config;
  });
}

function withConfigurationLock<T>(file: string, action: () => T): T {
  const absolute = resolve(file);
  // A separate private namespace avoids the state store's writer.lock name.
  const lockDirectory = join(dirname(absolute), `.tl-engines-${createHash("sha256").update(absolute).digest("hex").slice(0, 24)}`);
  mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
  const lock = acquireWriterLock(lockDirectory, { staleMs: 8000, acquireBoundMs: 9000 });
  if (!lock) throw new Error("Engine configuration is busy; existing settings were preserved");
  try { return action(); } finally { lock.release(); }
}

function writeConfigurationSnapshot(config: EngineConfiguration, file: string): void {
  const payload = `${JSON.stringify(config, null, 2)}\n`;
  if (Buffer.byteLength(payload, "utf8") > 32 * 1024) throw new Error("Engine configuration exceeds 32 KiB; existing settings were preserved");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomBytes(16).toString("hex")}.tmp`;
  writeFileSync(temporary, payload, { flag: "wx", mode: 0o600 });
  try { renameSync(temporary, file); } catch (error) { unlinkSync(temporary); throw error; }
}
