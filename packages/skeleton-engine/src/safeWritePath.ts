import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

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

  const relParent = relative(root, dirname(target));
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
    if (!isPathInside(root, realpathSync(cursor))) {
      throw new Error(`unsafe-write-path: parent escapes repository root: ${cursor}`);
    }
  }
  if (createParents && targetRel.split(sep)[0] === ".tokenlighten") {
    const ignore = join(root, ".tokenlighten", ".gitignore");
    try {
      writeFileSync(ignore, "# TokenLighten runtime files\n*\n", { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = lstatSync(ignore);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("unsafe runtime .gitignore");
    }
  }
}

/** Create only the private runtime directory, never a missing workspace. */
export function ensureRuntimeDirectory(root: string): void {
  ensureSafeWriteParent(root, join(root, ".tokenlighten", ".runtime"), true);
}

export function assertSafeWriteTarget(repoRoot: string, targetPath: string): void {
  ensureSafeWriteParent(repoRoot, targetPath, false);
  if (!existsSync(targetPath)) return;
  if (lstatSync(targetPath).isSymbolicLink()) {
    throw new Error(`unsafe-write-path: target is a symlink: ${targetPath}`);
  }
}
