// Plain data output — no meta envelope. See docs/00-postmortem.md §2.2.
//
// install-hooks: opt-in pre-commit hook that runs `tl skeleton check` so that
// AGENTS.md never drifts from the actual code structure.
// Spec: docs/06-stable-prefix-rebuild.md §3.7 (3-tier defense in depth).
//
// Default is OFF: the user must run `tl install-hooks` explicitly. This is the
// v0.3 lesson — auto-installed hooks broke contributor flows.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  lstatSync,
  realpathSync,
  renameSync,
  unlinkSync,
} from "fs";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";

const TL_LINE = "tl skeleton check";
const SHEBANG = "#!/bin/sh\n";

type HookMode = "husky" | "lefthook" | "plain";

function ensureSafeHookPath(repoRoot: string, hookPath: string, createParents = false): void {
  const root = realpathSync(repoRoot);
  const target = resolve(hookPath);
  const rel = relative(root, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`unsafe-hook-path: target escapes repository root: ${hookPath}`);
  }

  let cursor = root;
  for (const component of relative(root, dirname(target)).split(sep).filter(Boolean)) {
    cursor = resolve(cursor, component);
    if (!existsSync(cursor)) {
      if (!createParents) continue;
      mkdirSync(cursor, { mode: 0o755 });
    }
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`unsafe-hook-path: parent is not a real directory: ${cursor}`);
    }
    const canonical = realpathSync(cursor);
    const canonicalRel = relative(root, canonical);
    if (canonicalRel === ".." || canonicalRel.startsWith(`..${sep}`) || isAbsolute(canonicalRel)) {
      throw new Error(`unsafe-hook-path: parent escapes repository root: ${cursor}`);
    }
  }

  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    throw new Error(`unsafe-hook-path: hook is a symlink: ${target}`);
  }
}

function writeHook(repoRoot: string, hookPath: string, content: string): void {
  ensureSafeHookPath(repoRoot, hookPath, true);
  const tmpPath = `${hookPath}.tl-tmp-${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(tmpPath, content, { encoding: "utf-8", flag: "wx", mode: 0o755 });
    chmodSync(tmpPath, 0o755);
    ensureSafeHookPath(repoRoot, hookPath, false);
    renameSync(tmpPath, hookPath);
  } catch (error) {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    throw error;
  }
}

function detectMode(repoRoot: string): HookMode {
  if (existsSync(join(repoRoot, ".husky"))) return "husky";
  if (existsSync(join(repoRoot, "lefthook.yml"))) return "lefthook";
  return "plain";
}

function appendLineIfMissing(content: string, line: string): { content: string; changed: boolean } {
  const lines = content.split("\n");
  if (lines.some((l) => l.trim() === line)) {
    return { content, changed: false };
  }
  // Ensure file doesn't end with multiple blank lines
  const trimmed = content.trimEnd();
  return { content: trimmed + "\n" + line + "\n", changed: true };
}

function removeLineIfPresent(content: string, line: string): { content: string; changed: boolean } {
  const lines = content.split("\n");
  const filtered = lines.filter((l) => l.trim() !== line);
  if (filtered.length === lines.length) {
    return { content, changed: false };
  }
  return { content: filtered.join("\n"), changed: true };
}

async function installHusky(repoRoot: string): Promise<void> {
  const hookPath = join(repoRoot, ".husky", "pre-commit");
  ensureSafeHookPath(repoRoot, hookPath, false);
  let content = existsSync(hookPath) ? readFileSync(hookPath, "utf-8") : "";
  const { content: next, changed } = appendLineIfMissing(content, TL_LINE);
  if (!changed) {
    process.stdout.write(`tl install-hooks: ${hookPath} already contains '${TL_LINE}' — nothing to do.\n`);
    return;
  }
  writeHook(repoRoot, hookPath, next);
  process.stdout.write(`tl install-hooks: appended '${TL_LINE}' to ${hookPath}\n`);
}

async function uninstallHusky(repoRoot: string): Promise<void> {
  const hookPath = join(repoRoot, ".husky", "pre-commit");
  ensureSafeHookPath(repoRoot, hookPath, false);
  if (!existsSync(hookPath)) {
    process.stdout.write(`tl install-hooks: ${hookPath} not found — nothing to do.\n`);
    return;
  }
  const content = readFileSync(hookPath, "utf-8");
  const { content: next, changed } = removeLineIfPresent(content, TL_LINE);
  if (!changed) {
    process.stdout.write(`tl install-hooks: '${TL_LINE}' not found in ${hookPath} — nothing to do.\n`);
    return;
  }
  writeHook(repoRoot, hookPath, next);
  process.stdout.write(`tl install-hooks: removed '${TL_LINE}' from ${hookPath}\n`);
}

async function installLefthook(_repoRoot: string): Promise<void> {
  process.stdout.write(
    `tl install-hooks: lefthook detected. Add the following to your lefthook.yml pre-commit hooks:\n` +
    `  - run: tl skeleton check\n`
  );
}

async function uninstallLefthook(_repoRoot: string): Promise<void> {
  process.stdout.write(
    `tl install-hooks: lefthook detected. Remove 'run: tl skeleton check' from your lefthook.yml pre-commit hooks manually.\n`
  );
}

async function installPlain(repoRoot: string): Promise<void> {
  const gitHooksDir = join(repoRoot, ".git", "hooks");
  const hookPath = join(gitHooksDir, "pre-commit");
  ensureSafeHookPath(repoRoot, hookPath, true);
  let content = existsSync(hookPath) ? readFileSync(hookPath, "utf-8") : SHEBANG;
  if (!content.startsWith("#!")) {
    content = SHEBANG + content;
  }
  const { content: next, changed } = appendLineIfMissing(content, TL_LINE);
  if (!changed) {
    process.stdout.write(`tl install-hooks: ${hookPath} already contains '${TL_LINE}' — nothing to do.\n`);
    return;
  }
  writeHook(repoRoot, hookPath, next);
  process.stdout.write(`tl install-hooks: appended '${TL_LINE}' to ${hookPath}\n`);
}

async function uninstallPlain(repoRoot: string): Promise<void> {
  const hookPath = join(repoRoot, ".git", "hooks", "pre-commit");
  ensureSafeHookPath(repoRoot, hookPath, false);
  if (!existsSync(hookPath)) {
    process.stdout.write(`tl install-hooks: ${hookPath} not found — nothing to do.\n`);
    return;
  }
  const content = readFileSync(hookPath, "utf-8");
  const { content: next, changed } = removeLineIfPresent(content, TL_LINE);
  if (!changed) {
    process.stdout.write(`tl install-hooks: '${TL_LINE}' not found in ${hookPath} — nothing to do.\n`);
    return;
  }
  writeHook(repoRoot, hookPath, next);
  process.stdout.write(`tl install-hooks: removed '${TL_LINE}' from ${hookPath}\n`);
}

export async function runInstallHooks(args: string[]): Promise<void> {
  const uninstall = args.includes("--uninstall");
  const repoRoot = process.cwd();

  const mode = detectMode(repoRoot);

  try {
    if (uninstall) {
      if (mode === "husky") await uninstallHusky(repoRoot);
      else if (mode === "lefthook") await uninstallLefthook(repoRoot);
      else await uninstallPlain(repoRoot);
    } else {
      if (mode === "husky") await installHusky(repoRoot);
      else if (mode === "lefthook") await installLefthook(repoRoot);
      else await installPlain(repoRoot);
    }
  } catch (err) {
    process.stderr.write(`tl install-hooks: error — ${String(err)}\n`);
    process.exit(1);
  }

  process.exit(0);
}
