#!/usr/bin/env node
/**
 * @tokenlighten/cli — tl command surface
 *
 * Dispatches to subcommand modules.
 * Full spec: docs/components/05-vscode-extension.md §4 (CLI parity table)
 *
 * v0.4: proxy removed; bench delegates to python -m tokenlighten_bench.
 *
 * Output policy: plain data — no meta envelope.
 * See docs/00-postmortem.md §2.2 for rationale.
 */

import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs";

import { runHelp } from "./commands/help.js";
import { runConfig } from "./commands/config.js";
import { runInstallHooks } from "./commands/install-hooks.js";
import { runSkeleton } from "./commands/skeleton.js";
import { runAgents } from "./commands/agents.js";
import { runDoctor } from "./commands/doctor.js";
import { runVersion } from "./commands/version.js";
import { runMcp } from "./commands/mcp.js";
import { runSetup } from "./commands/setup.js";
import { runWorkspace } from "./commands/workspace.js";
import { runLogs } from "./commands/logs.js";
import { runClients } from "./commands/clients.js";

// Resolve a path's real (symlink-free) location, tolerating paths that
// don't exist on disk (falls back to a lexical resolve instead of throwing,
// so callers always get a stable, comparable absolute path).
function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// Guards the CLI's side effects (argv parsing, env mutation, dispatcher
// execution) behind actual invocation as the entry script, so this module
// stays IMPORT-SAFE — e.g. from `import("@tokenlighten/cli")`, whose "main"
// field points at this same compiled file — without printing the help
// banner, mutating process.env, or calling process.exit as an import side
// effect. Both sides are realpath'd (not just lexically resolved) so this
// also matches through the npm-generated `node_modules/.bin/tl` symlink,
// not just a direct `node dist/index.js` invocation. Matches the IS_MAIN
// pattern already used by packages/mcp-server/src/bin.ts.
const IS_MAIN = typeof process.argv[1] === "string"
  && safeRealpath(process.argv[1]) === safeRealpath(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;

  // Global flag: --no-prereq-check disables pre-flight prereq checks in
  // MCP startup. Commands that never do pre-flight (config, version,
  // help, doctor, setup) ignore this flag.
  const NO_PREREQ_CHECK = rest.includes("--no-prereq-check");
  // Propagate to child commands by injecting into env so downstream modules can
  // read it without arg-threading. We also pass it via filtered argv below.
  if (NO_PREREQ_CHECK) {
    process.env["TL_NO_PREREQ_CHECK"] = "1";
  }

  // Strip --no-prereq-check from the args forwarded to sub-commands.
  const filteredRest = rest.filter((a) => a !== "--no-prereq-check");

  switch (command) {
    case undefined:
    case "--help":
    case "-h":
    case "help":
      runHelp();
      break;

    case "config":
      runConfig(filteredRest);
      break;

    case "skeleton":
      await runSkeleton(filteredRest);
      break;

    case "agents":
      await runAgents(filteredRest);
      break;

    // "tl agents-md write" → routes to the same handler as "tl agents update"
    // (docs/components/05-vscode-extension.md §4 parity)
    case "agents-md":
      await runAgents(filteredRest);
      break;

    case "doctor":
      await runDoctor(filteredRest);
      break;

    case "install-hooks":
      await runInstallHooks(filteredRest);
      break;

    case "version":
    case "--version":
    case "-v":
      runVersion();
      break;

    case "mcp":
      await runMcp(filteredRest);
      break;

    case "setup":
      // 'tl setup --check' → alias for doctor --json prereq subset
      if (filteredRest.includes("--check")) {
        await runDoctor(["--json"]);
      } else {
        await runSetup(filteredRest);
      }
      break;

    case "workspace":
      await runWorkspace(filteredRest);
      break;

    case "logs":
      await runLogs(filteredRest);
      break;

    case "clients":
      await runClients(filteredRest);
      break;

    default:
      process.stderr.write(
        `tl: unknown command '${command}'. Run 'tl help' for usage.\n`
      );
      process.exit(1);
  }
}

if (IS_MAIN) {
  main().catch((err: unknown) => {
    process.stderr.write(`tl: unexpected error: ${String(err)}\n`);
    process.exit(1);
  });
}
