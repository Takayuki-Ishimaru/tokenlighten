// gitignorePatterns.ts — shared workspace .gitignore loader.
//
// Reads the root .gitignore plus nested ones (bounded depth) and rewrites
// nested patterns to workspace-relative form, matching git's per-directory
// scoping. Pure pattern extraction: callers build their own matcher and
// decide default-vs-explicit-scope semantics.

import * as fs from "fs";
import * as path from "path";

export function loadWorkspaceGitignorePatterns(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, relDir: string, depth: number): void => {
    const giPath = path.join(dir, ".gitignore");
    let text: string | undefined;
    try {
      text = fs.readFileSync(giPath, "utf8");
    } catch {
      text = undefined;
    }
    if (text !== undefined) {
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line.length === 0 || line.startsWith("#")) continue;
        const negated = line.startsWith("!");
        const body = negated ? line.slice(1) : line;
        if (relDir === "") {
          // Root .gitignore: the ignore matcher itself implements git's
          // anchoring rules for workspace-level patterns.
          out.push(negated ? `!${body}` : body);
          continue;
        }
        // Git scoping: a separator at the BEGINNING or MIDDLE of the pattern
        // anchors it to this .gitignore's own directory; only a trailing
        // separator (directory-only marker) leaves it floating to any depth.
        const anchoredBySlash = body.startsWith("/") || body.slice(0, -1).includes("/");
        if (anchoredBySlash) {
          const scoped = body.startsWith("/") ? `${relDir}${body}` : `${relDir}/${body}`;
          out.push(negated ? `!${scoped}` : scoped);
          continue;
        }
        out.push(negated ? `!${relDir}/**/${body}` : `${relDir}/**/${body}`);
        // A bare name at nested scope also matches directly under that dir;
        // this anchored variant keeps parity with the recursive form above.
        out.push(negated ? `!${relDir}/${body}` : `${relDir}/${body}`);
      }
    }
    if (depth >= 6) return; // bounded nested-.gitignore discovery
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }) as fs.Dirent[];
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      walk(path.join(dir, entry.name), relDir === "" ? entry.name : `${relDir}/${entry.name}`, depth + 1);
    }
  };
  walk(root, "", 0);
  return out;
}
