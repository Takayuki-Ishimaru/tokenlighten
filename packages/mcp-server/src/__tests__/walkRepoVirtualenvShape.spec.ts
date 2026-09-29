// walkRepoVirtualenvShape.spec.ts — round-4 evaluation finding P1-9.
//
// Round-3 (P2-15) replaced the unanchored `venv/`/`site-packages/` NAME
// patterns with a `pyvenv.cfg` MARKER check (walkRepo.ts's
// `hasVirtualenvMarkerFile`) — see walkRepoIgnore.spec.ts's own "Python
// virtualenv marker detection (P2-15)" describe block. Round-4 found the
// marker-only approach traded one false positive (`venv/` colliding with a
// real source dir) for real false negatives/positives of its own:
//
//   - venvNoMarker: a virtualenv missing its `pyvenv.cfg` (some creation
//     tools omit or lose it) still leaked its `site-packages/` content.
//   - rootInPlaceVenv: an IN-PLACE root virtualenv (`python -m venv .`) never
//     had its marker checked at all (the workspace root is never a
//     candidate for exclusion — hiding "." would hide everything), so its
//     nested `site-packages/` was walked as ordinary source.
//   - markerInSrc: a STRAY `pyvenv.cfg` dropped into an ordinary source
//     directory (no real environment around it) hid that entire directory.
//   - nestedVenvLift: an explicit `path=` lift into (or straight to) a
//     virtualenv must reveal its own nested `site-packages/` AND a nested
//     decoy marker, the same way a lift into any other DEFAULT_IGNORE
//     directory already reveals its own content.
//
// The fix (walkRepo.ts, skeleton-engine/ignore.ts): `site-packages/` is
// restored as an unconditional NAME pattern (unambiguous — no real source
// tree is ever named exactly that); the marker check now ALSO requires a
// sibling SHAPE (`lib/python*/site-packages`, `Lib/site-packages`,
// `bin/activate`, or `Scripts/activate`) before treating a `pyvenv.cfg` as a
// real environment; and an explicit lift into a virtualenv (by name or by
// marker+shape) suppresses BOTH mechanisms for its own lifted subtree.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  walkCodeFiles,
  resetTokenlightenIgnoreCache,
  createWalkOmissions,
} from "../tools/walkRepo.js";

const tmpDirs: string[] = [];

function mkWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.homedir(), ".tl-walk-venv-shape-test-"));
  tmpDirs.push(dir);
  return dir;
}

function writeFile(workspace: string, rel: string, content: string): void {
  const abs = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

afterEach(() => {
  resetTokenlightenIgnoreCache();
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

describe("P1-9 venvNoMarker: a virtualenv missing pyvenv.cfg still hides its site-packages/ by name", () => {
  it("venv/lib/python3.12/site-packages/... is excluded even with NO pyvenv.cfg anywhere", () => {
    const ws = mkWorkspace();
    writeFile(ws, "venv/lib/python3.12/site-packages/requests/api.py", "NEEDLE_NOMARKER = 1\n");
    writeFile(ws, "venv/bin/activate", "# activate\n");
    writeFile(ws, "src/app.py", "NEEDLE_APP = 1\n");

    const om = createWalkOmissions();
    const files = walkCodeFiles(ws, { omissions: om }).map((f) => f.relPath);

    expect(files).toEqual(["src/app.py"]);
    expect(om.ignored).toBeGreaterThanOrEqual(1);
  });
});

describe("P1-9 rootInPlaceVenv: an in-place root virtualenv hides its nested site-packages/ but never the root itself", () => {
  it("root pyvenv.cfg + root lib/python.../site-packages + root bin/activate: site-packages hidden, sibling root source stays visible", () => {
    const ws = mkWorkspace();
    writeFile(ws, "pyvenv.cfg", "home = /usr/bin\ninclude-system-site-packages = false\nversion = 3.12.4\n");
    writeFile(ws, "lib/python3.12/site-packages/requests/api.py", "NEEDLE_ROOTVENV = 1\n");
    writeFile(ws, "bin/activate", "# activate\n");
    // A real source file at the workspace root, sibling to the in-place
    // venv's own lib/bin dirs — the root is never excluded wholesale (that
    // would hide this too), only the unambiguous nested site-packages/ is.
    writeFile(ws, "app.py", "NEEDLE_ROOT_APP = 1\n");

    const om = createWalkOmissions();
    const files = walkCodeFiles(ws, { omissions: om }).map((f) => f.relPath);

    expect(files).toContain("app.py");
    expect(files.some((f) => f.includes("site-packages"))).toBe(false);
    expect(om.ignored).toBeGreaterThanOrEqual(1);
  });
});

describe("P1-9 markerInSrc: a stray pyvenv.cfg with no sibling shape never hides a directory", () => {
  it("src/pyvenv.cfg alone (no lib/.../site-packages, no bin|Scripts/activate) leaves src/ fully visible", () => {
    const ws = mkWorkspace();
    writeFile(ws, "src/pyvenv.cfg", "home = /usr/bin\nversion = 3.12.4\n");
    writeFile(ws, "src/app.ts", "export const NEEDLE_SRC_APP = 1;\n");
    writeFile(ws, "src/nested/util.ts", "export const NEEDLE_SRC_NESTED = 1;\n");

    const files = walkCodeFiles(ws).map((f) => f.relPath).sort();

    expect(files).toEqual(["src/app.ts", "src/nested/util.ts"]);
  });

  it("a marker WITH a sibling activate script (real shape) still hides the directory, unlike the stray case above", () => {
    const ws = mkWorkspace();
    writeFile(ws, "src/pyvenv.cfg", "home = /usr/bin\n");
    writeFile(ws, "src/bin/activate", "# activate\n");
    writeFile(ws, "src/app.ts", "export const NEEDLE_SHAPED = 1;\n");

    const om = createWalkOmissions();
    const files = walkCodeFiles(ws, { omissions: om }).map((f) => f.relPath);

    expect(files).toEqual([]);
    expect(om.ignored).toBeGreaterThanOrEqual(1);
  });
});

describe("P1-9 nestedVenvLift: an explicit lift into a virtualenv reveals its own nested dependency patterns, name- and marker-based alike", () => {
  function buildNestedVenv(ws: string): void {
    writeFile(ws, "tools/venv/pyvenv.cfg", "home = /usr/bin\nversion = 3.12.4\n");
    writeFile(ws, "tools/venv/bin/activate", "# activate\n");
    writeFile(ws, "tools/venv/lib/python3.12/site-packages/needlepkg/mod.py", "NEEDLE_TOOLS_VENV = 1\n");
    // A DECOY nested marker with no shape of its own (just the bare file) —
    // must never hide inner.py, lift or no lift (P1-9's "a stray marker
    // alone never hides a directory", restated one level deeper).
    writeFile(ws, "tools/venv/lib/python3.12/site-packages/needlepkg/nested/pyvenv.cfg", "home = /usr/bin\n");
    writeFile(ws, "tools/venv/lib/python3.12/site-packages/needlepkg/nested/inner.py", "NEEDLE_NESTED_INNER = 1\n");
    writeFile(ws, "tools/build.py", "NEEDLE_TOOLS_SRC = 1\n");
  }

  it("(a) unscoped: the whole venv is hidden, including its own site-packages/; tools/build.py stays visible", () => {
    const ws = mkWorkspace();
    buildNestedVenv(ws);

    const files = walkCodeFiles(ws).map((f) => f.relPath);

    expect(files).toEqual(["tools/build.py"]);
  });

  it("(b) an explicit path= lift straight into the venv root reveals its own site-packages/ AND the nested decoy marker's content", () => {
    const ws = mkWorkspace();
    buildNestedVenv(ws);

    const files = walkCodeFiles(ws, { subPath: "tools/venv" }).map((f) => f.relPath).sort();

    expect(files).toEqual([
      "tools/venv/lib/python3.12/site-packages/needlepkg/mod.py",
      "tools/venv/lib/python3.12/site-packages/needlepkg/nested/inner.py",
    ]);
  });

  it("(c) a lift into the venv's ANCESTOR (not the venv itself) does not cascade: the venv stays hidden, the ancestor's other content is visible", () => {
    const ws = mkWorkspace();
    buildNestedVenv(ws);

    const files = walkCodeFiles(ws, { subPath: "tools" }).map((f) => f.relPath);

    expect(files).toEqual(["tools/build.py"]);
  });

  it("(d) an explicit path= lift straight into the nested site-packages/ package dir reveals the nested decoy marker's content too", () => {
    const ws = mkWorkspace();
    buildNestedVenv(ws);

    const files = walkCodeFiles(ws, {
      subPath: "tools/venv/lib/python3.12/site-packages/needlepkg",
    }).map((f) => f.relPath).sort();

    expect(files).toEqual([
      "tools/venv/lib/python3.12/site-packages/needlepkg/mod.py",
      "tools/venv/lib/python3.12/site-packages/needlepkg/nested/inner.py",
    ]);
  });

  it("recall control: an UNRELATED lift (dist/) still excludes an ordinary node_modules/ nested inside it — the venv-family lift exemption does not leak into other DEFAULT_IGNORE families", () => {
    const ws = mkWorkspace();
    writeFile(ws, "dist/index.js", "const built = 1;\n");
    writeFile(ws, "dist/node_modules/pkg/index.js", "module.exports = 1;\n");

    const scoped = walkCodeFiles(ws, { subPath: "dist" }).map((f) => f.relPath);

    expect(scoped).toEqual(["dist/index.js"]);
  });
});
