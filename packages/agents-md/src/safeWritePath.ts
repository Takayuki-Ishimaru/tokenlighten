import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * Validate every existing parent component without following repository-owned
 * symlinks. Missing parents are optionally created one component at a time and
 * immediately re-validated.
 */
export function ensureSafeWriteParent(
  repoRoot: string,
  targetPath: string,
  createParents = false,
): void {
  const configuredRoot = resolve(repoRoot);
  const root = realpathSync(configuredRoot);
  const configuredTarget = resolve(targetPath);
  const targetRel = relative(configuredRoot, configuredTarget);
  if (
    targetRel === ""
    || targetRel === ".."
    || targetRel.startsWith(`..${sep}`)
    || isAbsolute(targetRel)
  ) {
    throw new Error(`unsafe-write-path: target escapes repository root: ${targetPath}`);
  }
  const target = resolve(root, targetRel);

  const parent = dirname(target);
  const relParent = relative(root, parent);
  let cursor = root;
  for (const component of relParent.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, component);
    if (!existsSync(cursor)) {
      if (!createParents) continue;
      mkdirSync(cursor, { mode: 0o755 });
    }
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`unsafe-write-path: parent is not a real directory: ${cursor}`);
    }
    const canonical = realpathSync(cursor);
    if (!isInside(root, canonical)) {
      throw new Error(`unsafe-write-path: parent escapes repository root: ${cursor}`);
    }
  }
}

/** Refuse a final-path symlink in addition to validating all parent paths. */
export function assertSafeWriteTarget(repoRoot: string, targetPath: string): void {
  ensureSafeWriteParent(repoRoot, targetPath, false);
  if (!existsSync(targetPath)) return;
  const stat = lstatSync(targetPath);
  if (stat.isSymbolicLink()) {
    throw new Error(`unsafe-write-path: target is a symlink: ${targetPath}`);
  }
}
