/**
 * tl version — print package version from package.json
 *
 * Output policy: plain data — no meta envelope.
 * See docs/00-postmortem.md §2.2 for rationale.
 */

import { readFileSync } from "fs";
import { createRequire } from "module";

export function runVersion(): void {
  try {
    // require.resolve (not a hardcoded "../.." from our own compiled
    // location) so this also works from a single-file bundle, where this
    // code no longer lives 2 directories below the package root — see
    // packages/vscode-extension/scripts/bundle-cli.mjs. cli's package.json
    // already exports "./package.json" for exactly this lookup.
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("@tokenlighten/cli/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    process.stdout.write((pkg.version ?? "unknown") + "\n");
  } catch {
    process.stdout.write("unknown\n");
  }
}
