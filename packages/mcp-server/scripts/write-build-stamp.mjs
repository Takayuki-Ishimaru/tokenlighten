#!/usr/bin/env node
// write-build-stamp.mjs — emits dist/.build-stamp as one line:
//   `<ISO of newest dist mtime>-<first 12 hex of sha256 over dist js/json content>`
//
// Why (2026-07-31 escapefix incident): serverBuild.ts used to fingerprint the
// running process by mtime+size of dist/server.js alone. Incremental tsc can
// skip rewriting that file, so a genuinely fresh rebuild kept reporting a
// stale-looking fingerprint — and diagnosing a REAL stale long-lived server
// process (which silently serves pre-rebuild logic) cost two full paired
// bench runs. A content hash over the whole dist tree is unambiguous in both
// directions: identical content compares equal across rebuilds, any code
// change produces a new hash.
//
// The timestamp component derives from the newest dist file mtime (not
// wall-clock) so the stamp is a pure function of the build outputs.
// Optional argv[2] overrides the dist dir — used by serverBuild.spec.ts.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const distDir = resolve(process.argv[2] ?? join(here, "..", "dist"));

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(abs);
    else if (/\.(?:js|json)$/.test(entry.name)) yield abs;
  }
}

const files = [...walk(distDir)]
  .map((abs) => ({ abs, rel: relative(distDir, abs).split(sep).join("/") }))
  .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
if (files.length === 0) {
  console.error(`write-build-stamp: no .js/.json files under ${distDir} — run tsc first`);
  process.exit(1);
}

const hash = createHash("sha256");
let newestMtimeMs = 0;
for (const { abs, rel } of files) {
  hash.update(rel);
  hash.update("\0");
  hash.update(readFileSync(abs));
  hash.update("\0");
  const mtimeMs = statSync(abs).mtimeMs;
  if (mtimeMs > newestMtimeMs) newestMtimeMs = mtimeMs;
}

const stamp = `${new Date(newestMtimeMs).toISOString()}-${hash.digest("hex").slice(0, 12)}`;
writeFileSync(join(distDir, ".build-stamp"), `${stamp}\n`);
console.log(`[build-stamp] ${stamp} (${files.length} files)`);
