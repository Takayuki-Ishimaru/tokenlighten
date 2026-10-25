import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { MULTILINGUAL_E5_MODEL, E5_MIT_NOTICE } from "@tokenlighten/types";

/** Load exported runtime modules lazily, including the separately packaged CJS entries. */
async function runtime<T>(entry: string): Promise<T> {
  const require = createRequire(import.meta.url);
  const loaded = await import(pathToFileURL(require.resolve(`@tokenlighten/mcp-server/${entry}`)).href) as { default?: T };
  return loaded.default ?? loaded as T;
}

export async function runEngines(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write("tl engines status [--json]\ntl engines set typedSymbols|compoundRequests|semanticSearch on|off\ntl engines discovery on|off\ntl engines server <ts|js|py|go|rs|java|c|cpp|cs|kt|php|rb> <executable> [args...]\ntl engines resolve <file> <zero-based-line> <UTF-16-character> [--cwd <root>]\ntl models list [--json]\ntl models install [--json]\ntl models licenses [--json]\n");
    return;
  }
  const configModule = await runtime<typeof import("@tokenlighten/mcp-server/engines")>("engines");
  const config = configModule.readEngineConfiguration();
  const action = args[0] ?? "status";
  if (action === "status") {
    const typed = await runtime<typeof import("@tokenlighten/mcp-server/typed-symbols")>("typed-symbols");
    process.stdout.write(`${JSON.stringify({ configFile: configModule.engineConfigPath(), config, languages: typed.TYPED_SYMBOL_LANGUAGES,
      servers: typed.LANGUAGE_SERVER_CANDIDATES }, null, args.includes("--json") ? undefined : 2)}\n`);
    return;
  }
  if (action === "set" || action === "discovery") {
    const key = action === "discovery" ? "discoverServers" : args[1];
    const value = action === "discovery" ? args[1] : args[2];
    if (value !== "on" && value !== "off") throw new Error("Engine setting must be on or off");
    if (action !== "discovery" && key !== "typedSymbols" && key !== "compoundRequests" && key !== "semanticSearch") throw new Error("Unknown engine setting");
    const updated = configModule.updateEngineConfiguration(latest => {
      if (action === "discovery") latest.typedSymbols.discoverServers = value === "on";
      else latest[key as "typedSymbols" | "compoundRequests" | "semanticSearch"].enabled = value === "on";
    });
    process.stdout.write(`${JSON.stringify(updated)}\n`);
    return;
  }
  if (action === "server") {
    const lang = args[1]; const command = args[2];
    if (!lang || !/^(ts|js|py|go|rs|java|c|cpp|cs|kt|php|rb)$/.test(lang) || !command?.trim()
      || command.length > 4096 || args.slice(3).length > 64 || args.slice(3).some(arg => arg.length > 4096)) throw new Error("Expected a supported language, server executable and bounded arguments");
    const updated = configModule.updateEngineConfiguration(latest => { latest.typedSymbols.servers[lang] = { command, args: args.slice(3) }; });
    process.stdout.write(`${JSON.stringify(updated)}\n`);
    return;
  }
  if (action === "resolve") {
    const line = Number(args[2]); const character = Number(args[3]);
    if (!args[1] || !Number.isSafeInteger(line) || line < 0 || !Number.isSafeInteger(character) || character < 0) throw new Error("Expected file, zero-based line and UTF-16 character");
    const typed = await runtime<typeof import("@tokenlighten/mcp-server/typed-symbols")>("typed-symbols");
    const aliases: Record<string, string> = { ts: "typescript", js: "javascript", py: "python", rs: "rust", cs: "csharp", kt: "kotlin", rb: "ruby" };
    const cwdIndex = args.indexOf("--cwd");
    if (cwdIndex >= 0 && !args[cwdIndex + 1]) throw new Error("--cwd requires a workspace root");
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    process.once("SIGINT", abort); process.once("SIGTERM", abort);
    try {
      const result = await typed.resolveTypedSymbols({ root: cwdIndex >= 0 ? args[cwdIndex + 1]! : process.cwd(), path: args[1],
        position: { line, character }, discoverServers: config.typedSymbols.discoverServers, signal: controller.signal,
        servers: Object.fromEntries(Object.entries(config.typedSymbols.servers).map(([key, value]) => [aliases[key] ?? key, value])) });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } finally { process.off("SIGINT", abort); process.off("SIGTERM", abort); }
    return;
  }
  throw new Error("Unknown engines command. Run tl engines --help");
}

export async function runModels(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) { await runEngines(["--help"]); return; }
  const action = args[0] ?? "list";
  if (action === "licenses") {
    process.stdout.write(args.includes("--json")
      ? `${JSON.stringify([{ ...MULTILINGUAL_E5_MODEL, licenseText: E5_MIT_NOTICE }])}\n`
      : `${MULTILINGUAL_E5_MODEL.id}@${MULTILINGUAL_E5_MODEL.revision}\n${MULTILINGUAL_E5_MODEL.note}\n${E5_MIT_NOTICE}`);
    return;
  }
  const configModule = await runtime<typeof import("@tokenlighten/mcp-server/engines")>("engines");
  const models = await runtime<typeof import("@tokenlighten/mcp-server/semantic-search")>("semantic-search");
  const config = action === "install" ? configModule.readEngineConfigurationStrict() : configModule.readEngineConfiguration();
  if (action === "list") {
    const status = await models.readSemanticModelStatus({ cacheDir: config.semanticSearch.cacheDir });
    process.stdout.write(`${JSON.stringify({ ...status, enabled: config.semanticSearch.enabled, model: MULTILINGUAL_E5_MODEL })}\n`);
    return;
  }
  if (action === "install") {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    process.once("SIGINT", abort); process.once("SIGTERM", abort);
    try {
      const result = await models.prepareSemanticModel({ cacheDir: config.semanticSearch.cacheDir, allowDownload: true, signal: controller.signal });
      if (result.status !== "ready") throw new Error("Model installation did not produce a complete local model");
      controller.signal.throwIfAborted();
      configModule.updateEngineConfiguration(latest => {
        controller.signal.throwIfAborted();
        if (latest.semanticSearch.cacheDir !== config.semanticSearch.cacheDir) throw new Error("Model cache changed during installation; downloaded files were retained. Retry for the current cache.");
        latest.semanticSearch.enabled = true;
      });
      process.stdout.write(`${JSON.stringify({ ...result, enabled: true })}\n`);
    } finally { process.off("SIGINT", abort); process.off("SIGTERM", abort); }
    return;
  }
  throw new Error("Unknown models command. Run tl engines --help");
}
