import * as fs from "node:fs";
import * as path from "node:path";

import {maskCommentsAndStrings} from "../features/task-pack/sfCodeMask.js";

export function goPackageName(text: string): string | undefined {
  return /^[ \t]*package[ \t]+([A-Za-z_][A-Za-z0-9_]*)/m.exec(maskCommentsAndStrings(text))?.[1];
}

/** Pure package pairing shared by source context and the verification kit. */
export function samePackageGoTest(sourcePath: string, sourceText: string, testPath: string, testText: string): boolean {
  if (!sourcePath.endsWith(".go") || !testPath.endsWith("_test.go")
    || path.posix.dirname(sourcePath) !== path.posix.dirname(testPath)) return false;
  const sourcePackage = goPackageName(sourceText);
  return sourcePackage !== undefined && sourcePackage === goPackageName(testText);
}

export function goTestInvokesFocal(text: string, name: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return false;
  const code = maskCommentsAndStrings(text), call = new RegExp("\\b" + name + "\\s*\\(", "g");
  for (const match of code.matchAll(call)) {
    const prefix = code.slice(code.lastIndexOf("\n", match.index) + 1, match.index);
    if (!/\bfunc\b[^{}]*$/.test(prefix)) return true;
  }
  return false;
}

/** A single proven Go module suite. Multiple modules remain undetermined, never silently omit one. */
export function goVerificationEntry(workspace: string, files: readonly string[]): {command: string; dir: string} | undefined {
  try {
    const root = fs.realpathSync(workspace), modules = new Set<string>();
    const within = (file: string) => {const rel = path.relative(root, file); return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));};
    const goFiles = files.filter(file => file.endsWith(".go"));
    if (!goFiles.length) return undefined;
    for (const file of goFiles) {
      const abs = fs.realpathSync(path.resolve(root, file));
      if (!within(abs) || !fs.statSync(abs).isFile()) return undefined;
      let dir = path.dirname(abs), found = false;
      while (within(dir)) {
        const marker = path.join(dir, "go.mod");
        if (fs.existsSync(marker)) {
          const real = fs.realpathSync(marker);
          if (!within(real) || !fs.statSync(real).isFile()) return undefined;
          modules.add(path.relative(root, dir).split(path.sep).join("/"));
          found = true; break;
        }
        if (dir === root) break;
        dir = path.dirname(dir);
      }
      if (!found) return undefined;
    }
    if (modules.size !== 1) return undefined;
    return {command: "go test ./...", dir: [...modules][0]!};
  } catch {return undefined;}
}
export function goVerificationHint(entry: {command: string; dir: string} | undefined): string | undefined {
  if (!entry) return undefined;
  if (!entry.dir) return entry.command;
  // Keep executable hints portable and shell-safe; the kit can still carry cwd as data.
  return /^[A-Za-z0-9_./-]+$/.test(entry.dir) ? `cd ./${entry.dir} && ${entry.command}` : undefined;
}
