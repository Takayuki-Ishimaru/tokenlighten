#!/usr/bin/env node
// bin.ts — CLI entry point for @tokenlighten/mcp-server.
// Invokes run() which starts the MCP stdio server.
//
// Flags:
//   --allow-write   Enable edit_file's write capability (including structured
//                   artifact rewrites). edit_file is one of the exactly 3
//                   advertised tools (read_file, edit_file, search_files) —
//                   see server.ts. Default: edit_file is registered
//                   (advertised) but write calls return error
//                   'write-not-enabled' with a restart hint.
//   --allowed-parent <path>
//                   Repeatable. Permit existing worktrees rooted at direct
//                   children of this parent, including when it is outside HOME.
//   --print-config-digest
//                   Print the 64-lowercase-hex computed MCP configuration
//                   digest (the same formula the running server attests with
//                   — packages/mcp-server/src/util/trace.ts
//                   computedConfigSha256) for the CURRENT process environment
//                   to stdout, then exit 0. Does not start the MCP server.
//   --print-schema-stamp
//                   Print the 16-lowercase-hex deterministic content stamp of
//                   this build's advertised tools/list surface (util/
//                   schemaStamp.ts computeSchemaStamp(advertisedTools())) to
//                   stdout, then exit 0. Does not start the MCP server. Used
//                   by packages/vscode-extension's build (bundled-server
//                   provenance for the generated schema stamp) and by
//                   packages/cli's workspace setup (TOKENLIGHTEN_SCHEMA_STAMP
//                   written into generated MCP client config) — see
//                   util/schemaStamp.ts for why this exists.

import { fileURLToPath } from "node:url";
import * as path from "node:path";

import { computedConfigSha256 } from "./util/trace.js";
import { computeSchemaStamp } from "./util/schemaStamp.js";
import { advertisedTools, run } from "./server.js";

/** Exported for unit testing without spawning the CLI or the MCP server. */
export function printConfigDigestRequested(argv: readonly string[]): boolean {
  return argv.includes("--print-config-digest");
}

/** Exported for unit testing without spawning the CLI or the MCP server. */
export function printSchemaStampRequested(argv: readonly string[]): boolean {
  return argv.includes("--print-schema-stamp");
}

// Guards the CLI's side effects (server startup, or stdout+exit) behind
// actual invocation as the entry script, so this module stays IMPORT-SAFE —
// e.g. from a unit test exercising printConfigDigestRequested — without
// starting the MCP stdio server or calling process.exit as an import side
// effect. Matches the IS_MAIN pattern already used by
// bench/workflows/run_oneshot_ab.mjs.
const IS_MAIN = typeof process.argv[1] === "string"
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (IS_MAIN) {
  if (printConfigDigestRequested(process.argv.slice(2))) {
    process.stdout.write(`${computedConfigSha256()}\n`);
    process.exit(0);
  } else if (printSchemaStampRequested(process.argv.slice(2))) {
    process.stdout.write(`${computeSchemaStamp(advertisedTools())}\n`);
    process.exit(0);
  } else {
    run().catch((err: unknown) => {
      process.stderr.write(
        `[tl-mcp] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    });
  }
}
