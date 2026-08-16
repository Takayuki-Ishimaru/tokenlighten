/**
 * tl config <subcommand> — read / write config.toml
 *
 * Subcommands:
 *   tl config path           — print canonical config.toml path
 *   tl config get <key>      — read value at dot-path key
 *   tl config set <key> <val>— atomic write
 *
 * Output policy: plain data — no meta envelope.
 * See docs/00-postmortem.md §2.2 for rationale.
 */

import { configFilePath } from "../paths.js";
import {
  readConfig,
  writeConfig,
  getNestedKey,
  setNestedKey,
  parseValue,
} from "../config.js";

const CONFIG_USAGE = `\
Usage: tl config <subcommand>

Subcommands:
  path              Print the canonical config.toml path
  get <key>         Read a value (dot-path, e.g. mcp.workspaceRoot)
  set <key> <value> Write a value (atomic rename)
`;

export function runConfig(args: string[]): void {
  const [sub, ...rest] = args;

  if (!sub || sub === "--help" || sub === "-h") {
    process.stdout.write(CONFIG_USAGE);
    return;
  }

  if (sub === "path") {
    process.stdout.write(configFilePath() + "\n");
    return;
  }

  if (sub === "get") {
    const key = rest[0];
    if (!key) {
      process.stderr.write("tl config get: missing <key>\n");
      process.exit(1);
    }
    const filePath = configFilePath();
    const doc = readConfig(filePath);
    const value = getNestedKey(doc, key);
    if (value === undefined) {
      process.stderr.write(`tl config get: key '${key}' not found\n`);
      process.exit(1);
    }
    process.stdout.write(String(value) + "\n");
    return;
  }

  if (sub === "set") {
    const key = rest[0];
    const rawValue = rest[1];
    if (!key || rawValue === undefined) {
      process.stderr.write("tl config set: missing <key> or <value>\n");
      process.exit(1);
    }
    const filePath = configFilePath();
    const doc = readConfig(filePath);
    const typed = parseValue(rawValue);
    setNestedKey(doc, key, typed);
    writeConfig(filePath, doc);
    process.stdout.write(`${key} = ${String(typed)}\n`);
    return;
  }

  process.stderr.write(`tl config: unknown subcommand '${sub}'\n${CONFIG_USAGE}`);
  process.exit(1);
}
