/** User-scoped local analysis settings, independent of MCP wire contracts. */
export interface LanguageServerCommand {
  command: string;
  args?: string[];
  initializationOptions?: unknown;
  configuration?: unknown;
}

export interface EngineConfiguration {
  version: 1;
  typedSymbols: {
    enabled: boolean;
    discoverServers: boolean;
    servers: Record<string, LanguageServerCommand>;
  };
  compoundRequests: { enabled: boolean };
  semanticSearch: { enabled: boolean; cacheDir: string };
}
