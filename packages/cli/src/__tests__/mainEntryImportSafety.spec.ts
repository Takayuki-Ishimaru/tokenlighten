import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { dirname, resolve, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";

// Regression coverage for making packages/cli's built entry (dist/index.js —
// both the npm "bin" target AND the package "main") IMPORT-SAFE: importing
// it must never run the CLI dispatcher (help banner stdout pollution, or a
// process.exit() in the IMPORTER's own process) as a side effect of module
// evaluation. Mirrors the release-smoke harness's `main-entry-import-safety`
// check (scratchpad prep/B-release-smoke.mjs's checkModuleResolution),
// which exercises the identical scenario against a real npm-installed
// consumer: a bare `await import("@tokenlighten/cli")` from a host script
// whose OWN process.argv has nothing to do with `tl`.

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_INDEX_JS = resolve(HERE, "..", "..", "dist", "index.js");

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

describe('dist/index.js import safety (packages/cli\'s package "main" == its npm "bin")', () => {
  it("import()-ing the built entry from an unrelated host script produces no stdout pollution, no premature exit, and leaves exports accessible", () => {
    const marker = "__TL_IMPORT_SAFETY_MARKER__";
    const script = `
let result;
try {
  const mod = await import(${JSON.stringify(pathToFileURL(DIST_INDEX_JS).href)});
  result = { ok: true, exportKeys: Object.keys(mod) };
} catch (err) {
  result = { ok: false, error: String((err && err.stack) || err) };
}
process.stdout.write(${JSON.stringify(marker)} + JSON.stringify(result) + ${JSON.stringify(marker)});
`;
    // No extra argv beyond the eval'd script itself — reproduces a host
    // importer whose OWN process.argv has nothing to do with `tl` (the
    // exact scenario an unguarded top-level dispatcher call would misread
    // as `tl help` / `tl <unknown command>`).
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: 15_000,
      shell: false,
    });

    expect(res.error).toBeUndefined();
    expect(res.status).toBe(0); // no premature process.exit()

    const idx1 = res.stdout.indexOf(marker);
    const idx2 = res.stdout.lastIndexOf(marker);
    expect(idx1).toBeGreaterThanOrEqual(0);
    expect(idx2).toBeGreaterThan(idx1);

    // Nothing outside the marker pair — the import produced no help banner
    // or other unexpected stdout output.
    const outside = (res.stdout.slice(0, idx1) + res.stdout.slice(idx2 + marker.length)).trim();
    expect(outside).toBe("");

    const payload = JSON.parse(res.stdout.slice(idx1 + marker.length, idx2)) as {
      ok: boolean;
      exportKeys?: string[];
      error?: string;
    };
    expect(payload.ok).toBe(true);
    // Whatever the module exports (today: nothing — it's dispatcher-only),
    // the resolved module namespace must be enumerable without throwing.
    expect(Array.isArray(payload.exportKeys)).toBe(true);
  });

  it("`node dist/index.js help` still dispatches normally and prints usage (exit 0)", () => {
    const res = spawnSync(process.execPath, [DIST_INDEX_JS, "help"], {
      encoding: "utf8",
      timeout: 15_000,
      shell: false,
    });

    expect(res.error).toBeUndefined();
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/Usage: tl <command>/);
    expect(res.stdout).toContain("setup [--check]");
    expect(res.stdout).not.toMatch(/^\s*bench\b/m);
  });

  it("does not expose the private benchmark command", () => {
    const res = spawnSync(process.execPath, [DIST_INDEX_JS, "bench"], {
      encoding: "utf8",
      timeout: 15_000,
      shell: false,
    });

    expect(res.error).toBeUndefined();
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("unknown command 'bench'");
  });

  it.skipIf(process.platform === "win32")(
    "dispatches through an npm-bin-style symlink (node_modules/.bin/tl -> dist/index.js), not just a direct node invocation",
    () => {
      const binDir = mkdtempSync(join(tmpdir(), "tl-bin-symlink-"));
      tmpDirs.push(binDir);
      const symlinkPath = join(binDir, "tl");
      symlinkSync(DIST_INDEX_JS, symlinkPath);

      // Matches how the release-smoke harness's runMcpHandshake() actually
      // invokes the installed CLI bin: spawn the resolved
      // node_modules/.bin/<name> path directly. process.argv[1] here is
      // the SYMLINK path, not dist/index.js's real path — the exact case a
      // lexical (non-realpath) argv[1] comparison misses.
      const res = spawnSync(process.execPath, [symlinkPath, "help"], {
        encoding: "utf8",
        timeout: 15_000,
        shell: false,
      });

      expect(res.error).toBeUndefined();
      expect(res.status).toBe(0);
      expect(res.stdout).toMatch(/Usage: tl <command>/);
    }
  );
});
