/** Context-only VS Code SessionStart hook: never changes tool permissions. */
export const COPILOT_SESSION_HINT = "TokenLighten is the workspace LOCATION FINDER and READER. Unknown file locations are supported: omit targets and pass the entire user request as query; tl_read_file finds and serves the source in ONE call. Never shorten query to keywords; keep every citation and constraint sentence. If TL tools are available, your FIRST file/source LOOKUP OR READ must be mcp__tokenlighten_tl_read_file with {query:\"<entire user request, verbatim>\",task:{epoch:\"new\"}}. Do not locate files with grep_search/semantic_search/read_file before this call. For an explicitly read-only task add task.profile:\"answer\". When decision.kind is act.answer, evidence[].body is exact source already read: answer with its paths and line numbers, without re-reading it. Run any next verbatim. Native lookup/read is allowed if TL is unavailable, the user asks for native, or TL reports incomplete scope/verified absence. No tool is disabled.";

export const COPILOT_SESSION_CONFIG = ".github/hooks/tokenlighten-session.json";
export const COPILOT_SESSION_RUNNER = ".tokenlighten/copilot-session.cjs";
export const COPILOT_SESSION_RECORD = ".tokenlighten/copilot-session-owned.json";

import { createHash, randomBytes } from "node:crypto";
import { closeSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const PATHS = [COPILOT_SESSION_CONFIG, COPILOT_SESSION_RUNNER] as const;
const LOCK = ".tokenlighten/copilot-session.lock";
type Snapshot = { body: string; dev: number; ino: number };
type RecordBody = { schemaVersion: 1; files: Record<string, string> };
const digest = (body: string): string => createHash("sha256").update(body).digest("hex");

function stat(path: string) {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** Check every component within the selected root, including dangling links. */
function safe(root: string, path: string): void {
  const rel = relative(root, path);
  if (!stat(root)?.isDirectory() || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("unsafe workspace path");
  let current = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = stat(current);
    if (info && (current === path ? !info.isFile() : !info.isDirectory())) throw new Error(`unsafe or symlinked path: ${current}`);
  }
}

function snapshot(root: string, path: string): Snapshot | undefined {
  safe(root, path);
  const info = stat(path);
  if (!info) return undefined;
  if (info.size > 8192) throw new Error(`oversized managed file: ${path}`);
  return { body: readFileSync(path, "utf8"), dev: info.dev, ino: info.ino };
}

function unchanged(root: string, path: string, before: Snapshot | undefined): void {
  const now = snapshot(root, path);
  if (now?.body !== before?.body || now?.dev !== before?.dev || now?.ino !== before?.ino) throw new Error(`file changed during setup: ${path}`);
}

function parseRecord(text: string): RecordBody {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("malformed hook ownership record");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join() !== "files,schemaVersion" || record.schemaVersion !== 1 || !record.files || typeof record.files !== "object" || Array.isArray(record.files)) throw new Error("malformed hook ownership record");
  const files = record.files as Record<string, unknown>;
  if (Object.keys(files).sort().join() !== [...PATHS].sort().join() || !Object.values(files).every(v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v))) throw new Error("malformed hook ownership record");
  return record as unknown as RecordBody;
}

/** A contending/crashed setup fails fast. Never removes somebody else's lock. */
function lock(root: string): () => void {
  const path = join(root, LOCK);
  safe(root, path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const nonce = randomBytes(16).toString("hex");
  let fd: number;
  try { fd = openSync(path, "wx", 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("hook setup is busy; existing lock preserved"); throw error; }
  try { writeFileSync(fd, nonce); } finally { closeSync(fd); }
  const owned = snapshot(root, path)!;
  return () => { try { unchanged(root, path, owned); unlinkSync(path); } catch { /* Preserve any replacement. */ } };
}

/** New files publish without replacement; refresh requires the owned snapshot. */
function publish(root: string, path: string, body: string, before: Snapshot | undefined): void {
  safe(root, path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.tl-tmp-${randomBytes(16).toString("hex")}`);
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, body); } finally { closeSync(fd); }
  const owned = snapshot(root, temporary)!;
  try {
    unchanged(root, path, before);
    if (before) renameSync(temporary, path);
    else linkSync(temporary, path);
  } finally {
    try { unchanged(root, temporary, owned); unlinkSync(temporary); } catch { /* Preserve any replacement. */ }
  }
}

function rendered(): Record<string, string> {
  const payload = { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: COPILOT_SESSION_HINT } };
  const runner = `// TokenLighten: context only; no stdin, filesystem, or permission changes.\nprocess.stdout.write(${JSON.stringify(JSON.stringify(payload))});\n`;
  const config = JSON.stringify({ hooks: { SessionStart: [{ type: "command", command: `node ${COPILOT_SESSION_RUNNER}`, timeout: 5 }] } }, null, 2) + "\n";
  const files = { [COPILOT_SESSION_CONFIG]: digest(config), [COPILOT_SESSION_RUNNER]: digest(runner) };
  return { [COPILOT_SESSION_CONFIG]: config, [COPILOT_SESSION_RUNNER]: runner, [COPILOT_SESSION_RECORD]: JSON.stringify({ schemaVersion: 1, files }, null, 2) + "\n" };
}

function ownedState(root: string): Map<string, Snapshot | undefined> {
  const state = new Map([...PATHS, COPILOT_SESSION_RECORD].map(p => [p, snapshot(root, join(root, p))]));
  const recordText = state.get(COPILOT_SESSION_RECORD)?.body;
  if (!recordText) {
    if ([...state.values()].some(Boolean)) throw new Error("foreign hook file collision; existing files preserved");
  } else {
    const record = parseRecord(recordText);
    for (const path of PATHS) {
      const file = state.get(path);
      if (file && digest(file.body) !== record.files[path]) throw new Error(`user-modified hook file preserved: ${path}`);
    }
  }
  return state;
}

export function installCopilotSessionHook(selectedRoot: string): { files: string[]; warnings: string[] } {
  const root = resolve(selectedRoot);
  let release: (() => void) | undefined;
  try {
    // Check all paths before creating the lock or any directory.
    for (const p of [...PATHS, COPILOT_SESSION_RECORD]) safe(root, join(root, p));
    release = lock(root);
    const state = ownedState(root);
    const contents = rendered();
    // Runner before record before active config: a failed write cannot activate
    // a new configuration that points to a missing runner.
    for (const path of [COPILOT_SESSION_RUNNER, COPILOT_SESSION_RECORD, COPILOT_SESSION_CONFIG]) {
      const before = state.get(path);
      if (before?.body !== contents[path]) publish(root, join(root, path), contents[path]!, before);
    }
    return { files: [...PATHS, COPILOT_SESSION_RECORD].map(p => join(root, p)), warnings: [] };
  } catch (error) {
    return { files: [], warnings: [String((error as Error).message)] };
  } finally { release?.(); }
}

export function removeCopilotSessionHook(selectedRoot: string): { warnings: string[] } {
  const root = resolve(selectedRoot);
  let release: (() => void) | undefined;
  try {
    // No record means no ownership, including legacy/user hook files.
    if (!snapshot(root, join(root, COPILOT_SESSION_RECORD))) return { warnings: [] };
    release = lock(root);
    const state = ownedState(root);
    // Preserve the whole pair when either file was edited. Configuration is
    // removed first so a removal failure keeps its runner available.
    for (const path of [...PATHS, COPILOT_SESSION_RECORD]) {
      const before = state.get(path);
      if (before) { unchanged(root, join(root, path), before); unlinkSync(join(root, path)); }
    }
    return { warnings: [] };
  } catch (error) { return { warnings: [String((error as Error).message)] }; }
  finally { release?.(); }
}
