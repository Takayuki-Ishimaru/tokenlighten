// Small TypeScript fixture for skeleton and symbol-context testing.
// Used by packages/mcp-server/src/__tests__/

import { readFile } from "fs/promises";
import { join } from "path";

/** Configuration for the greeter. */
interface GreeterConfig {
  prefix: string;
  suffix?: string;
}

/** A simple greeter class for testing skeleton extraction. */
export class Greeter {
  private config: GreeterConfig;

  constructor(config: GreeterConfig) {
    this.config = config;
  }

  /** Return a greeting string for the given name. */
  greet(name: string): string {
    const suffix = this.config.suffix ?? "!";
    return `${this.config.prefix} ${name}${suffix}`;
  }

  /** Return a farewell string for the given name. */
  farewell(name: string): string {
    return `Goodbye, ${name}.`;
  }

  /** Format the greeter as a string. */
  toString(): string {
    return `Greeter(prefix=${this.config.prefix})`;
  }
}

/** A standalone utility function. */
export function formatMessage(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");
}

/** Load a configuration file from disk. */
export async function loadConfig(configPath: string): Promise<GreeterConfig> {
  const raw = await readFile(join(configPath), "utf8");
  return JSON.parse(raw) as GreeterConfig;
}
