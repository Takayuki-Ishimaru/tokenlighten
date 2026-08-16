/**
 * serverBuild.spec.ts — build-identity fingerprint (2026-07-31 escapefix
 * incident: the single-file mtime+size fingerprint survived incremental
 * rebuilds unchanged, so a fresh rebuild kept reporting a stale-looking id —
 * and a REAL stale long-lived server process cost two paired bench runs to
 * diagnose).
 *
 * Contract pinned here:
 *   1. deriveServerBuildId prefers dist/.build-stamp (content hash over the
 *      dist tree, written by scripts/write-build-stamp.mjs) next to the
 *      module file.
 *   2. A malformed or absent stamp falls back to the module file's own
 *      mtime+size — never undefined while the file exists.
 *   3. write-build-stamp.mjs: identical dist content ⇒ identical hash across
 *      runs; any content change ⇒ a different hash.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { deriveServerBuildId } from "../util/serverBuild.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STAMP_SCRIPT = path.resolve(HERE, "..", "..", "scripts", "write-build-stamp.mjs");

const tmpDirs: string[] = [];

function makeDir(tag: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `tl-server-build-${tag}-`)));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function runStampScript(distDir: string): string {
  const proc = spawnSync(process.execPath, [STAMP_SCRIPT, distDir], { encoding: "utf8" });
  expect(proc.status, proc.stderr).toBe(0);
  return fs.readFileSync(path.join(distDir, ".build-stamp"), "utf8").trim();
}

const STAMP_SHAPE = /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z-[0-9a-f]{12}$/;
const STAT_SHAPE = /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z-\d+$/;

describe("deriveServerBuildId", () => {
  it("prefers a well-formed .build-stamp next to the module file", () => {
    const dir = makeDir("stamp");
    const moduleFile = path.join(dir, "server.js");
    fs.writeFileSync(moduleFile, "export {};\n");
    const stamp = "2026-07-31T00:00:00.000Z-abcdef123456";
    fs.writeFileSync(path.join(dir, ".build-stamp"), `${stamp}\n`);

    expect(deriveServerBuildId(pathToFileURL(moduleFile).href)).toBe(stamp);
  });

  it("falls back to the module file's mtime+size when the stamp is malformed", () => {
    const dir = makeDir("malformed");
    const moduleFile = path.join(dir, "server.js");
    fs.writeFileSync(moduleFile, "export {};\n");
    fs.writeFileSync(path.join(dir, ".build-stamp"), "not a stamp\n");

    const id = deriveServerBuildId(pathToFileURL(moduleFile).href);
    expect(id).toMatch(STAT_SHAPE);
  });

  it("falls back to the module file's mtime+size when no stamp exists", () => {
    const dir = makeDir("nostamp");
    const moduleFile = path.join(dir, "server.js");
    fs.writeFileSync(moduleFile, "export {};\n");

    const id = deriveServerBuildId(pathToFileURL(moduleFile).href);
    expect(id).toMatch(STAT_SHAPE);
    const stat = fs.statSync(moduleFile);
    expect(id).toBe(`${stat.mtime.toISOString()}-${stat.size}`);
  });

  it("returns undefined when the module has no on-disk file", () => {
    expect(deriveServerBuildId(pathToFileURL(path.join(os.tmpdir(), "definitely-missing.js")).href)).toBeUndefined();
  });
});

describe("write-build-stamp.mjs", () => {
  it("emits a stable hash for identical content and a new hash for changed content", () => {
    const dist = makeDir("dist");
    fs.mkdirSync(path.join(dist, "util"), { recursive: true });
    fs.writeFileSync(path.join(dist, "server.js"), "export const dispatch = 1;\n");
    fs.writeFileSync(path.join(dist, "util", "helper.js"), "export const helper = 2;\n");

    const first = runStampScript(dist);
    expect(first).toMatch(STAMP_SHAPE);

    // Identical content ⇒ identical hash suffix (the whole point: an
    // incremental rebuild that changes nothing must compare EQUAL, and the
    // old single-file mtime fingerprint could not promise that).
    const second = runStampScript(dist);
    expect(second.slice(-12)).toBe(first.slice(-12));

    // Any content change ⇒ a different hash.
    fs.writeFileSync(path.join(dist, "util", "helper.js"), "export const helper = 3;\n");
    const third = runStampScript(dist);
    expect(third).toMatch(STAMP_SHAPE);
    expect(third.slice(-12)).not.toBe(first.slice(-12));
  });

  it("fails loudly on a dist dir with no build outputs", () => {
    const empty = makeDir("empty");
    const proc = spawnSync(process.execPath, [STAMP_SCRIPT, empty], { encoding: "utf8" });
    expect(proc.status).not.toBe(0);
    expect(proc.stderr).toContain("no .js/.json files");
  });

  it("the repo's own built dist carries a stamp deriveServerBuildId picks up", () => {
    // Integration sanity: after `npm run build` the real dist has a stamp and
    // the exported fingerprint IS that stamp (guards the package.json wiring).
    const realDist = path.resolve(HERE, "..", "..", "dist");
    const stampPath = path.join(realDist, ".build-stamp");
    if (!fs.existsSync(path.join(realDist, "server.js"))) return; // dist not built in this checkout
    expect(fs.existsSync(stampPath), "npm run build must write dist/.build-stamp").toBe(true);
    const stamp = fs.readFileSync(stampPath, "utf8").trim();
    expect(stamp).toMatch(STAMP_SHAPE);
    expect(deriveServerBuildId(pathToFileURL(path.join(realDist, "server.js")).href)).toBe(stamp);
  });
});
