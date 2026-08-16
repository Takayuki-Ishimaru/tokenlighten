/**
 * commands/mcp.ts — 'tl mcp start|stop|status'
 *
 * Spawns / stops the Node MCP server (packages/mcp-server/dist/bin.js).
 *
 * Invocation: tl mcp <subcommand> [flags]
 *   start [--stdio] [--allow-write] [--workspace DIR] [--allowed-parent DIR]...
 *   stop
 *   status
 *
 * On POSIX: SIGTERM for graceful shutdown → SIGKILL fallback.
 * On Windows: taskkill /F /PID (SIGTERM is unreliable on Windows for Node,
 *   but MCP is Node so taskkill is the correct approach).
 *
 * Process management refs:
 *   docs/components/06-platform-support.md §2.2
 *   packages/mcp-server/src/bin.ts (--allow-write flag)
 *
 * Output policy: plain data — no meta envelope.
 * See docs/00-postmortem.md §2.2 for rationale.
 */

import { spawn } from "child_process";
import { dirname, join } from "path";
import { existsSync } from "fs";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { resolvePath } from "../paths.js";
import { resolveRepoRoot } from "../repoRoot.js";
import { ensurePrereqs } from "../prereqs.js";
import {
  writePidFile,
  readPidFile,
  removePidFile,
  isPidAlive,
  stopMcp,
} from "../process.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mcpPidPath(): string {
  return resolvePath("runtime", "mcp.pid", { ensureDir: true });
}

/**
 * Resolve path to compiled mcp-server bin.js.
 *
 * resolveRepoRoot() is TokenLighten-repo-specific (sentinel-file walk) and
 * can throw outside a full source checkout of THIS repo — see repoRoot.ts.
 * It must stay inside the fallback branch, never called unconditionally by
 * the caller, so the common case (an installed/bundled
 * @tokenlighten/mcp-server that resolves via node_modules — packaged vsix
 * or a normal npm install) never pays for or risks that lookup.
 */
function resolveMcpBin(): string {
  try {
    const require = createRequire(import.meta.url);
    return join(dirname(require.resolve("@tokenlighten/mcp-server")), "bin.js");
  } catch {
    // Real install resolution failed — fall through to the monorepo
    // sentinel-walk fallback below (dev checkout before workspace packages
    // have been installed/linked).
  }

  try {
    // Monorepo source checkout before workspace packages have been installed.
    return join(resolveRepoRoot(), "packages", "mcp-server", "dist", "bin.js");
  } catch {
    // Neither resolution found @tokenlighten/mcp-server — resolveRepoRoot()'s
    // sentinel-walk error ("TokenLighten repo root not found") is meaningless
    // outside this monorepo, so surface an actionable message instead: name
    // the missing package and the repair step for a real consumer install.
    throw new Error(
      "tl mcp: cannot locate @tokenlighten/mcp-server. Reinstall " +
        "@tokenlighten/cli, or run 'npm install @tokenlighten/mcp-server' " +
        "to install the missing package."
    );
  }
}

// ---------------------------------------------------------------------------
// Parse flags
// ---------------------------------------------------------------------------

interface McpStartOpts {
  allowWrite: boolean;
  stdio: boolean;
  workspace?: string;
  allowedParents: string[];
  noPrereqCheck: boolean;
}

function parseStartOpts(args: string[]): McpStartOpts {
  let allowWrite = false;
  let stdio = false;
  let workspace: string | undefined;
  const allowedParents: string[] = [];
  let noPrereqCheck = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--allow-write") {
      allowWrite = true;
    } else if (a === "--stdio") {
      stdio = true;
    } else if (a === "--workspace" && args[i + 1]) {
      workspace = args[++i];
    } else if (a === "--allowed-parent" && args[i + 1]) {
      allowedParents.push(args[++i]!);
    } else if (a === "--no-prereq-check") {
      noPrereqCheck = true;
    }
  }
  return { allowWrite, stdio, workspace, allowedParents, noPrereqCheck };
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

async function runMcpStart(args: string[]): Promise<void> {
  const opts = parseStartOpts(args);

  // Pre-flight: node is always available (we ARE running in Node), but when
  // --allow-write is on we also ensure git is present.
  if (opts.allowWrite) {
    await ensurePrereqs(["git"], opts.noPrereqCheck);
  } else {
    await ensurePrereqs(["node"], opts.noPrereqCheck);
  }

  const pidPath = opts.stdio ? undefined : mcpPidPath();
  const existing = pidPath ? readPidFile(pidPath) : null;

  if (existing && isPidAlive(existing.pid)) {
    process.stderr.write(
      `tl mcp: already running (PID ${existing.pid})\n`
    );
    process.exit(1);
  }

  if (existing && pidPath) removePidFile(pidPath);

  const mcpBin = resolveMcpBin();

  if (!existsSync(mcpBin)) {
    process.stderr.write(
      `tl mcp: MCP server bin not found at ${mcpBin}\n` +
        `Run 'npm run build -w @tokenlighten/mcp-server' first.\n`
    );
    process.exit(1);
  }

  // Build argv — shell:false, array form
  const argv: string[] = [mcpBin];
  if (opts.allowWrite) argv.push("--allow-write");
  if (opts.workspace) argv.push("--workspace", opts.workspace);
  for (const parent of opts.allowedParents) argv.push("--allowed-parent", parent);

  const instanceId = randomBytes(16).toString("hex");
  const child = spawn(process.execPath, argv, {
    shell: false,
    detached: false,
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, TOKENLIGHTEN_INSTANCE_ID: instanceId },
  });

  if (child.pid === undefined) {
    process.stderr.write("tl mcp: failed to spawn MCP server process\n");
    process.exit(1);
  }

  // Write PID file
  if (pidPath) {
    writePidFile(pidPath, {
      pid: child.pid,
      started_at_unix: Math.floor(Date.now() / 1000),
      command: [process.execPath, ...argv].join(" "),
      instance_id: instanceId,
      identity_token: mcpBin,
    });
  }

  // stdout is reserved for MCP JSON-RPC framing.
  if (!opts.stdio) {
    process.stderr.write(`tl mcp: started (PID ${child.pid})\n`);
  }

  // Wait for the child and mirror exit code
  const code = await new Promise<number>((resolve) => {
    child.on("exit", (c) => resolve(c ?? 0));
    child.on("error", () => resolve(1));
  });
  if (pidPath) removePidFile(pidPath);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

async function runMcpStop(): Promise<void> {
  const pidPath = mcpPidPath();
  const data = readPidFile(pidPath);

  if (!data) {
    process.stderr.write("tl mcp: no PID file found — MCP server may not be running\n");
    process.exit(1);
  }

  if (!isPidAlive(data.pid)) {
    process.stdout.write(`tl mcp: PID ${data.pid} not alive — removing stale PID file\n`);
    removePidFile(pidPath);
    return;
  }

  process.stdout.write(`tl mcp: stopping PID ${data.pid}...\n`);
  await stopMcp(pidPath, data.pid);
  process.stdout.write("tl mcp: stopped\n");
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

function runMcpStatus(): void {
  const pidPath = mcpPidPath();
  const data = readPidFile(pidPath);

  if (!data || !isPidAlive(data.pid)) {
    process.stdout.write(JSON.stringify({ status: "down" }) + "\n");
    process.exit(1);
  }

  process.stdout.write(
    JSON.stringify({ status: "up", pid: data.pid }) + "\n"
  );
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function runMcp(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;

  switch (subcommand) {
    case "start":
      await runMcpStart(rest);
      break;
    case "stop":
      await runMcpStop();
      break;
    case "status":
      runMcpStatus();
      break;
    default:
      process.stderr.write(
        `tl mcp: unknown subcommand '${subcommand ?? "(none)"}'. ` +
          `Valid: start, stop, status\n`
      );
      process.exit(1);
  }
}
