import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { isToolSurface, TOOL_SURFACE_VALUES, type ToolSurface } from "@tokenlighten/types";
import { realDirectory } from "../write/resolveWorkspace.js";
import { setHandlePersistence } from "../util/handles.js";
import { recordHandleEntry, rehydrateHandleEntry } from "../state/stateHandles.js";
import { registerServerBuildId } from "../state/session.js";
import { setEnvelopeToolSurface } from "../protocol/envelope.js";
import { deriveServerBuildId, deriveServerPackageVersion } from "../util/serverBuild.js";
import { creditedReadPathsByLane, operationsInFlight } from "./requestState.js";

const canonicalServerUrl = new URL(import.meta.url.endsWith(".ts") ? "../server.ts" : "../server.js", import.meta.url).href;
export const argv = process.argv.slice(2);

function workspaceRootArg(args: readonly string[]): string | undefined {
  let named: string | undefined;
  let positional: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--workspace") {
      named = args[++i];
      continue;
    }
    if (arg === "--allowed-root" || arg === "--allowed-parent") {
      i++;
      continue;
    }
    if (!arg.startsWith("--") && positional === undefined) positional = arg;
  }
  return named ?? positional;
}

const pooledSessionCwd = process.env["TL_TEST_SESSION_RESET"] === "1"
  ? process.env["TL_TEST_SESSION_CWD"] : undefined;

if (pooledSessionCwd !== undefined && (!path.isAbsolute(pooledSessionCwd) || realDirectory(pooledSessionCwd) === undefined)) {
  throw new Error("TL_TEST_SESSION_CWD must name an existing absolute directory");
}

const launchCwd = pooledSessionCwd ?? process.cwd();

export let activeRoot = path.resolve(launchCwd, workspaceRootArg(argv) ?? process.env["TOKENLIGHTEN_ROOT"] ?? launchCwd);

export let capturedClientId: string | undefined;

export function resetCapturedClientIdForTest(): void {
  capturedClientId = undefined;
}

export function resetServerStateForSessionReset(workspaceRoot: string, cwd: string = workspaceRoot): string {
  const next = path.resolve(workspaceRoot);
  if (realDirectory(next) === undefined) {
    throw new Error(`workspace root does not exist or is not a directory: ${next}`);
  }
  const nextCwd = path.resolve(next, cwd);
  if (pooledSessionCwd === undefined) {
    // Preserve the original reset behavior for harnesses without neutral cwd.
    process.chdir(nextCwd);
  } else if (realDirectory(nextCwd) === undefined) {
    throw new Error(`session cwd does not exist or is not a directory: ${nextCwd}`);
  }
  activeRoot = next;
  capturedClientId = undefined;
  creditedReadPathsByLane.clear();
  operationsInFlight.clear();
  return activeRoot;
}

export function resolvedClientId(): string | undefined {
  const override = process.env["TOKENLIGHTEN_CLIENT_ID"];
  return override !== undefined && override !== "" ? override : capturedClientId;
}

setHandlePersistence({ record: recordHandleEntry, rehydrate: rehydrateHandleEntry });

export const KILL_SWITCH = /^(1|true|yes|on)$/i.test(process.env["TL_KILL_SWITCH"] ?? "");

export const SERVER_BUILD_ID = deriveServerBuildId(canonicalServerUrl, ["server.ts", "serverOwned", "runtime", "mcp/dispatch", "features/task-pack", "state"]);

export const SERVER_PACKAGE_VERSION = deriveServerPackageVersion(canonicalServerUrl);

registerServerBuildId(SERVER_BUILD_ID);

export const DOC_DISABLED = /^(0|false|no|off)$/i.test(process.env["TOKENLIGHTEN_DOCUMENT_EXTRACTION"] ?? "");

export const ALLOW_WRITE = argv.includes("--allow-write");

function parseToolSurfaceArg(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tool-surface") return args[i + 1];
  }
  return undefined;
}

function resolveToolSurface(): ToolSurface {
  const raw = parseToolSurfaceArg(argv) ?? process.env["TOKENLIGHTEN_TOOL_SURFACE"];
  if (raw === undefined || raw === "") return "full";
  if (isToolSurface(raw)) return raw;
  process.stderr.write(
    `[tl-mcp] fatal: unrecognized --tool-surface/TOKENLIGHTEN_TOOL_SURFACE value ${JSON.stringify(raw)} (expected ${TOOL_SURFACE_VALUES.join(" | ")})\n`,
  );
  return process.exit(1);
}

export const ACTIVE_TOOL_SURFACE: ToolSurface = resolveToolSurface();

setEnvelopeToolSurface(ACTIVE_TOOL_SURFACE);

export const SESSION_ID: string = randomBytes(6).toString("hex");

export function captureClientId(value: string): void { capturedClientId = value; }
