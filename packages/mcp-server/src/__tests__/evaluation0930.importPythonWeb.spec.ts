/**
 * evaluation0930.importPythonWeb.spec.ts — v0.15.0 NBR/FUI wave, WP-PW:
 * import resolution for Python and TS/JS files that live in a project NESTED
 * below the workspace root (features/task-pack/importResolvePython.ts and
 * importResolveWeb.ts).
 *
 * Pinned here: tsconfig `extends`/`baseUrl`/`paths` (JSONC, nearest config,
 * solution-style references), workspace packages (`exports`, `main`, `source`,
 * build output mapped back to source, `#imports`), code-only statement scan
 * (comments/strings/docstrings), one-hop barrel re-exports, Python import
 * roots (src layout, scripts, packages vs. same-named stdlib modules, PEP 420
 * namespace packages, submodule imports, `__init__` re-exports), the
 * negatives (node_modules is never read, missing targets, escapes from the
 * workspace), and bounded work on a workspace of more than 2,000 files.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { resolveWebImports, resetWebImportCaches } from "../features/task-pack/importResolveWeb.js";
import { resolvePythonImports, resetPythonImportCaches } from "../features/task-pack/importResolvePython.js";
import { resolveImportsOf } from "../features/task-pack/importResolution.js";
import { computeFrontierNeighbourIndex } from "../features/task-pack/frontierNeighbours.js";
import type { TaskPackResult, TaskPackSurface } from "../features/task-pack/model.js";

// Records every filesystem access the resolvers make while `spy.recording` is on,
// so "node_modules is never read" is asserted on the accesses themselves.
const spy = vi.hoisted(() => ({ recording: false, access: [] as string[] }));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const note = (p: unknown): void => {
    if (spy.recording) spy.access.push(String(p));
  };
  const wrap = <F extends (...args: any[]) => any>(fn: F): F =>
    ((...args: any[]) => {
      note(args[0]);
      return fn(...args);
    }) as F;
  const realpathSync = Object.assign(wrap(actual.realpathSync), { native: wrap(actual.realpathSync.native) });
  const wrapped = {
    ...actual,
    readFileSync: wrap(actual.readFileSync),
    statSync: wrap(actual.statSync),
    lstatSync: wrap(actual.lstatSync),
    readdirSync: wrap(actual.readdirSync),
    opendirSync: wrap(actual.opendirSync),
    realpathSync,
  };
  return { ...wrapped, default: wrapped };
});

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const tmpDirs: string[] = [];
const strayFiles: string[] = [];

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  for (const file of strayFiles.splice(0)) fs.rmSync(file, { recursive: true, force: true });
  for (const dir of tmpDirs.splice(0)) {
    try {
      await rmDirWithRetry(dir);
    } catch {
      /* best-effort cleanup */
    }
  }
});

function makeWorkspace(tag: string, files: Readonly<Record<string, string>>): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-e0930-${tag}-`));
  tmpDirs.push(ws);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(ws, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return ws;
}

/** Runs `fn` with filesystem-access recording on and returns its result plus every path touched. */
function withAccessLog<T>(fn: () => T): { result: T; access: string[] } {
  spy.access.length = 0;
  spy.recording = true;
  try {
    const result = fn();
    return { result, access: [...spy.access] };
  } finally {
    spy.recording = false;
  }
}

const touchesNodeModules = (p: string): boolean => p.split(/[\\/]/).includes("node_modules");

const linesOf = (body: string): string[] => body.split(/\r?\n/);
const webEdges = (ws: string, importer: string, body: string) => resolveWebImports(ws, importer, linesOf(body));
const pyEdges = (ws: string, importer: string, body: string) => resolvePythonImports(ws, importer, linesOf(body));
const pathsOf = (edges: ReadonlyArray<{ path: string }>): string[] => edges.map((e) => e.path);

function surface(p: string, code: string): TaskPackSurface {
  return { role: "domain", handle: `h-${p}`, path: p, range: `1-${code.split(/\r?\n/).length}`, code };
}

function fakeResult(surfaces: TaskPackSurface[]): TaskPackResult {
  return { mode: "task_pack", coverage: "partial", surfaces, missing: [] };
}

// ---------------------------------------------------------------------------
// The shared monorepo: a root package.json with `workspaces: ["packages/*"]`,
// plus projects that are NOT workspace members (apps/*, services/*, scripts/).
// ---------------------------------------------------------------------------

const MONOREPO: Readonly<Record<string, string>> = {
  "package.json": JSON.stringify({ name: "acme-monorepo", private: true, workspaces: ["packages/*"] }),
  // JSONC: comments, a block comment, trailing commas, and `/*` inside a string value.
  "tsconfig.base.json": `{
  // shared compiler options
  "compilerOptions": {
    "strict": true,
    "target": "ES2022", /* block comment */
    "baseUrl": ".",
  },
  "exclude": ["**/*.spec.ts",],
}
`,
  // apps/web: extends the base, re-declares baseUrl relative to itself, three path patterns.
  "apps/web/package.json": JSON.stringify({ name: "web", private: true }),
  "apps/web/tsconfig.json": `{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*", "generated/*"],
      "~shared/*": ["../../packages/utils/src/*"],
      "@missing/*": ["nope/*"],
    },
  },
}
`,
  "apps/web/src/lib/format.ts": "export const fmt = (n: number) => String(n);\n",
  "apps/web/generated/gen/api.ts": "export const api = 1;\n",
  "apps/web/src/pages/local.ts": "export const local = 1;\n",
  // apps/admin: baseUrl only comes from the base config; `paths` is relative to it (the workspace root).
  "apps/admin/tsconfig.json": `{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "paths": { "$lib/*": ["apps/admin/src/lib/*"] } }
}
`,
  "apps/admin/src/lib/widget.ts": "export const widget = 1;\n",
  // apps/web/legacy: a nested config with no paths — the OUTER config does not apply there.
  "apps/web/legacy/tsconfig.json": `{ "compilerOptions": { "strict": false } }\n`,
  // baseUrl-only project
  "apps/classic/tsconfig.json": `{ "compilerOptions": { "baseUrl": "src" } }\n`,
  "apps/classic/src/components/Card.tsx": "export const Card = () => null;\n",
  // solution-style (Vite): the root config only lists references
  "apps/vite/tsconfig.json": `{ "files": [], "references": [{ "path": "./tsconfig.app.json" }, { "path": "./tsconfig.node.json" }] }\n`,
  "apps/vite/tsconfig.app.json": `{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] } }, "include": ["src"] }\n`,
  "apps/vite/tsconfig.node.json": `{ "compilerOptions": {}, "include": ["vite.config.ts"] }\n`,
  "apps/vite/src/util/helper.ts": "export const helper = 1;\n",
  // packages/ui: conditional exports, a subpath, a subpath pattern; built entries live in dist/, sources in src/
  "packages/ui/package.json": JSON.stringify({
    name: "@acme/ui",
    main: "./dist/index.cjs",
    exports: {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.mjs", require: "./dist/index.cjs" },
      "./button": { import: "./dist/button.mjs" },
      "./icons/*": "./dist/icons/*.js",
    },
  }),
  "packages/ui/src/index.ts": "export { Button } from './button';\nexport * from './theme';\n",
  "packages/ui/src/button.tsx": "export const Button = () => null;\n",
  "packages/ui/src/theme.ts": "export const palette = { primary: '#000' };\n",
  "packages/ui/src/icons/arrow.tsx": "export default function Arrow() { return null; }\n",
  // packages/utils: `main` names a built file, the source is src/index.ts (a barrel)
  "packages/utils/package.json": JSON.stringify({ name: "@acme/utils", main: "dist/index.js", types: "dist/index.d.ts" }),
  "packages/utils/src/index.ts":
    "export { formatPrice } from './format';\nexport { orig as renamed } from './renames';\nexport { default as clamp } from './clamp';\nexport * from './math';\n",
  "packages/utils/src/format.ts": "export function formatPrice(n: number): string { return String(n); }\n",
  "packages/utils/src/renames.ts": "export const orig = 1;\n",
  "packages/utils/src/clamp.ts": "export default function clamp(n: number): number { return n; }\n",
  "packages/utils/src/math.ts": "export const add = (a: number, b: number) => a + b;\nexport function sub(a: number, b: number) { return a - b; }\n",
  "packages/utils/src/clock.ts": "export const now = () => 0;\n",
  // packages/core: a `source` field, and package `imports`
  "packages/core/package.json": JSON.stringify({
    name: "@acme/core",
    source: "src/index.ts",
    main: "dist/index.js",
    imports: { "#internal/*": "./src/internal/*.ts", "#ext": "left-pad" },
  }),
  "packages/core/src/index.ts": "export const core = 1;\n",
  "packages/core/src/internal/secret.ts": "export const secret = 1;\n",
  "packages/core/src/user.ts": "import { secret } from '#internal/secret';\nimport pad from '#ext';\n",
  // two manifests declaring the same name: ambiguous, never resolved
  "packages/dup-a/package.json": JSON.stringify({ name: "@acme/dup" }),
  "packages/dup-a/index.ts": "export const a = 1;\n",
  "packages/dup-b/package.json": JSON.stringify({ name: "@acme/dup" }),
  "packages/dup-b/index.ts": "export const b = 1;\n",
  // a name that exists ONLY in node_modules; its manifest would resolve to a real workspace file if it were used
  "node_modules/x/package.json": JSON.stringify({ name: "x", main: "../../packages/utils/src/format.ts" }),
  "node_modules/x/index.js": "module.exports = {};\n",
  "node_modules/@acme/ui/package.json": JSON.stringify({ name: "@acme/ui", main: "../../../packages/utils/src/format.ts" }),
  // ---- Python: a src-layout service, a namespace package, a flat scripts directory ----
  "services/pricing/pyproject.toml": "[project]\nname = 'pricing'\n",
  "services/pricing/config.py": "PRICING_ROOT = 1\n",
  "services/pricing/src/pricing/__init__.py": "from .engine import compute_total\nfrom .rules import bulk_discount as discount\nfrom .models import *\n",
  "services/pricing/src/pricing/engine.py": "def compute_total(items):\n    return sum(items)\n",
  "services/pricing/src/pricing/rules.py": "def bulk_discount(n):\n    return n\n",
  "services/pricing/src/pricing/models.py": "__all__ = ['Price']\n\nclass Price:\n    pass\n\nclass Hidden:\n    pass\n",
  "services/pricing/src/pricing/api/__init__.py": "",
  "services/pricing/src/pricing/api/serializers.py": "def dump(x):\n    return x\n",
  "services/pricing/src/pricing/api/logging.py": "def log(msg):\n    print(msg)\n",
  "services/pricing/src/pricing/api/config.py": "API_ROOT = 1\n",
  "services/pricing/src/pricing/plugins/tax.py": "def tax(x):\n    return x\n",
  "services/pricing/scripts/config.py": "SCRIPT_ROOT = 1\n",
  "services/pricing/tests/test_engine.py": "",
  // ---- a second, independent project that reuses the package name `app` ----
  "svc_a/app/__init__.py": "",
  "svc_a/app/models.py": "class UserA:\n    pass\n",
  "svc_b/app/__init__.py": "",
  "svc_b/app/models.py": "class UserB:\n    pass\n",
  "svc_b/app/only_b.py": "def only_b():\n    pass\n",
  // ---- flat scripts (no packages) ----
  "scripts/etl/run.py": "",
  "scripts/etl/helpers.py": "def clean(x):\n    return x\n",
  "scripts/etl/loaders.py": "def load_rows():\n    return []\n",
};

const monorepo = makeWorkspace("mono", MONOREPO);

const HOME_TS = "apps/web/src/pages/home.ts";

// ---------------------------------------------------------------------------
// TS/JS — tsconfig / jsconfig
// ---------------------------------------------------------------------------

describe("TS/JS — tsconfig extends / baseUrl / paths (nested project)", () => {
  it("resolves paths patterns through a JSONC extends chain: targets in order, relative to the project, compiled extensions", () => {
    const edges = webEdges(
      monorepo,
      HOME_TS,
      [
        "import { fmt } from '@/lib/format';", // first target: src/*
        "import { api } from '@/gen/api';", // only the second target holds it: generated/*
        "import { now } from '~shared/clock';", // a target outside the app, inside the workspace
        "import { local } from './local.js';", // relative + compiled extension
      ].join("\n"),
    );
    expect(edges.map((e) => [e.path, e.line])).toEqual([
      ["apps/web/src/lib/format.ts", 1],
      ["apps/web/generated/gen/api.ts", 2],
      ["packages/utils/src/clock.ts", 3],
      ["apps/web/src/pages/local.ts", 4],
    ]);
    expect(edges[0]).toEqual({ path: "apps/web/src/lib/format.ts", line: 1, kind: "import", names: ["fmt"] });
  });

  it("paths is relative to a baseUrl that the BASE config declares (TypeScript's own rule)", () => {
    const edges = webEdges(monorepo, "apps/admin/src/main.ts", "import { widget } from '$lib/widget';\n");
    expect(pathsOf(edges)).toEqual(["apps/admin/src/lib/widget.ts"]);
  });

  it("a paths target that does not exist yields nothing", () => {
    expect(webEdges(monorepo, HOME_TS, "import { nope } from '@missing/thing';\n")).toEqual([]);
  });

  it("the NEAREST config governs: a nested config without paths does not inherit the outer aliases", () => {
    const body = "import { fmt } from '@/lib/format';\n";
    expect(webEdges(monorepo, "apps/web/legacy/old.ts", body)).toEqual([]);
    expect(pathsOf(webEdges(monorepo, "apps/web/src/pages/new.ts", body))).toEqual(["apps/web/src/lib/format.ts"]);
  });

  it("baseUrl alone resolves non-relative specifiers under it; a third-party name stays unresolved", () => {
    const edges = webEdges(monorepo, "apps/classic/src/index.ts", "import { Card } from 'components/Card';\nimport _ from 'lodash';\n");
    expect(pathsOf(edges)).toEqual(["apps/classic/src/components/Card.tsx"]);
  });

  it("a solution-style config (references only) defers to the referenced config that covers the file", () => {
    const body = "import { helper } from '@/util/helper';\n";
    expect(pathsOf(webEdges(monorepo, "apps/vite/src/App.ts", body))).toEqual(["apps/vite/src/util/helper.ts"]);
    // vite.config.ts is covered by the node config, which declares no aliases
    expect(webEdges(monorepo, "apps/vite/vite.config.ts", body)).toEqual([]);
  });

  it("extends only follows relative paths and stops at three levels", () => {
    const ws = makeWorkspace("extends", {
      "tsconfig.json": `{ "extends": "@tsconfig/node20/tsconfig.json", "compilerOptions": { "baseUrl": "." } }\n`,
      "shared/thing.ts": "export const thing = 1;\n",
      "deep/tsconfig.json": `{ "extends": "./l1.json" }\n`,
      "deep/l1.json": `{ "extends": "./l2.json" }\n`,
      "deep/l2.json": `{ "extends": "./l3.json" }\n`,
      "deep/l3.json": `{ "extends": "./l4.json" }\n`,
      "deep/l4.json": `{ "compilerOptions": { "baseUrl": ".", "paths": { "@d/*": ["src/*"] } } }\n`,
      "deep/src/x.ts": "export const x = 1;\n",
    });
    // a package in extends (node_modules) is not read; the leaf's own baseUrl still applies
    expect(pathsOf(webEdges(ws, "main.ts", "import { thing } from 'shared/thing';\n"))).toEqual(["shared/thing.ts"]);
    // the chain deep -> l1 -> l2 -> l3 is three levels; l4 (the fourth) is not followed
    expect(webEdges(ws, "deep/src/y.ts", "import { x } from '@d/x';\n")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// TS/JS — workspace packages
// ---------------------------------------------------------------------------

describe("TS/JS — workspace packages", () => {
  it("maps a conditional exports entry (built dist/) back to the package's src/ file", () => {
    const edges = webEdges(monorepo, HOME_TS, "import { Button } from '@acme/ui';\n");
    expect(pathsOf(edges)).toEqual(["packages/ui/src/index.ts", "packages/ui/src/button.tsx"]);
  });

  it("resolves subpath exports and subpath patterns", () => {
    const edges = webEdges(
      monorepo,
      HOME_TS,
      "import { Button } from '@acme/ui/button';\nimport Arrow from '@acme/ui/icons/arrow';\n",
    );
    expect(pathsOf(edges)).toEqual(["packages/ui/src/button.tsx", "packages/ui/src/icons/arrow.tsx"]);
  });

  it("a `main` that names a built file resolves to src/index; a plain subpath resolves under the package or its src/", () => {
    const entry = webEdges(monorepo, HOME_TS, "import * as utils from '@acme/utils';\n");
    expect(pathsOf(entry)).toEqual(["packages/utils/src/index.ts"]);
    const sub = webEdges(monorepo, HOME_TS, "import { add } from '@acme/utils/math';\n");
    expect(pathsOf(sub)).toEqual(["packages/utils/src/math.ts"]);
  });

  it("prefers a `source` field and resolves package.json `imports` (#alias), never an external #target", () => {
    expect(pathsOf(webEdges(monorepo, HOME_TS, "import { core } from '@acme/core';\n"))).toEqual(["packages/core/src/index.ts"]);
    const edges = webEdges(monorepo, "packages/core/src/user.ts", "import { secret } from '#internal/secret';\nimport pad from '#ext';\n");
    expect(pathsOf(edges)).toEqual(["packages/core/src/internal/secret.ts"]);
  });

  it("an unknown package, a Node builtin and an ambiguous package name yield nothing", () => {
    const body = "import React from 'react';\nimport fs from 'node:fs';\nimport path from 'path';\nimport d from '@acme/dup';\n";
    expect(webEdges(monorepo, HOME_TS, body)).toEqual([]);
  });

  it("a package name that exists only in node_modules yields nothing, and node_modules is never touched", () => {
    resetWebImportCaches();
    const { result: edges, access } = withAccessLog(() =>
      webEdges(monorepo, HOME_TS, "import x from 'x';\nimport { Button } from '@acme/ui';\nimport fmt from './local';\n"),
    );
    // `x` never resolves (its manifest would have pointed at packages/utils/src/format.ts); `@acme/ui` resolves to the
    // WORKSPACE package, not to the node_modules copy of the same name (whose main points elsewhere).
    expect(pathsOf(edges)).toEqual(["packages/ui/src/index.ts", "packages/ui/src/button.tsx", "apps/web/src/pages/local.ts"]);
    expect(access.length).toBeGreaterThan(0);
    expect(access.filter(touchesNodeModules)).toEqual([]);
  });

  it("relative imports never land in node_modules either", () => {
    const ws = makeWorkspace("nm-relative", {
      "src/app.ts": "",
      "node_modules/lib/index.ts": "export const lib = 1;\n",
    });
    const { result: edges, access } = withAccessLog(() => webEdges(ws, "src/app.ts", "import { lib } from '../node_modules/lib';\n"));
    expect(edges).toEqual([]);
    expect(access.filter(touchesNodeModules)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// TS/JS — solution-style references: include/exclude coverage
// ---------------------------------------------------------------------------

/**
 * True when `import '@/x'` resolves for `importer`: the root config is a solution config (references only), the
 * referenced app config declares the alias and carries `coverage` (`include`/`exclude`/`files`).
 */
function referenceCovers(tag: string, coverage: Record<string, unknown>, importer: string): boolean {
  const ws = makeWorkspace(tag, {
    "tsconfig.json": JSON.stringify({ files: [], references: [{ path: "./tsconfig.app.json" }] }),
    "tsconfig.app.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["lib/*"] } }, ...coverage }),
    "lib/x.ts": "export const x = 1;\n",
  });
  return pathsOf(webEdges(ws, importer, "import { x } from '@/x';\n")).length === 1;
}

describe("TS/JS — referenced config coverage: include/exclude keep tsconfig's rules", () => {
  it("no include means every file under the config directory, minus the default excludes", () => {
    expect(referenceCovers("cover-implicit", {}, "src/a.ts")).toBe(true);
    expect(referenceCovers("cover-implicit", {}, "a/b/c/d.ts")).toBe(true);
    expect(referenceCovers("cover-implicit", {}, "node_modules/pkg/a.ts")).toBe(false);
  });

  it("a last segment without wildcard or extension names a directory: everything below it", () => {
    const include = { include: ["src"] };
    expect(referenceCovers("cover-dir", include, "src/a.ts")).toBe(true);
    expect(referenceCovers("cover-dir", include, "src/deep/er/b.ts")).toBe(true);
    expect(referenceCovers("cover-dir", include, "lib/c.ts")).toBe(false);
    expect(referenceCovers("cover-dir", include, "srcx/d.ts")).toBe(false);
    // leading ./ and a trailing slash are ignored; `.` is the config directory itself
    expect(referenceCovers("cover-dir-forms", { include: ["./src/"] }, "src/deep/a.ts")).toBe(true);
    expect(referenceCovers("cover-dot", { include: ["."] }, "x/y/z.ts")).toBe(true);
    expect(referenceCovers("cover-dot", { include: ["./"] }, "x/y/z.ts")).toBe(true);
  });

  it("`*` stays inside a segment, `**` crosses directories, `?` is one character", () => {
    expect(referenceCovers("cover-star", { include: ["src/*"] }, "src/a.ts")).toBe(true);
    expect(referenceCovers("cover-star", { include: ["src/*"] }, "src/deep/b.ts")).toBe(false);
    expect(referenceCovers("cover-glob", { include: ["src/**/*.tsx"] }, "src/deep/er/c.tsx")).toBe(true);
    expect(referenceCovers("cover-glob", { include: ["src/**/*.tsx"] }, "src/deep/er/c.ts")).toBe(false);
    expect(referenceCovers("cover-glob", { include: ["src/**/*.tsx"] }, "src/c.tsx")).toBe(true);
    expect(referenceCovers("cover-any", { include: ["**/*.ts"] }, "a/b/c.ts")).toBe(true);
    expect(referenceCovers("cover-any", { include: ["**/*.ts"] }, "a/b/c.tsx")).toBe(false);
    expect(referenceCovers("cover-q", { include: ["src/?.ts"] }, "src/a.ts")).toBe(true);
    expect(referenceCovers("cover-q", { include: ["src/?.ts"] }, "src/ab.ts")).toBe(false);
    expect(referenceCovers("cover-mid", { include: ["s*c/**"] }, "src/deep/a.ts")).toBe(true);
  });

  it("exclude subtracts: a directory name, a glob, and an explicit list replaces the default excludes", () => {
    expect(referenceCovers("cover-exclude", { include: ["src"], exclude: ["src/legacy"] }, "src/legacy/old.ts")).toBe(false);
    expect(referenceCovers("cover-exclude", { include: ["src"], exclude: ["src/legacy"] }, "src/new.ts")).toBe(true);
    expect(referenceCovers("cover-exclude-glob", { include: ["src"], exclude: ["**/*.spec.ts"] }, "src/deep/a.spec.ts")).toBe(false);
    expect(referenceCovers("cover-exclude-glob", { include: ["src"], exclude: ["**/*.spec.ts"] }, "src/deep/a.ts")).toBe(true);
    // an explicit exclude list REPLACES the defaults (node_modules is only excluded by default)
    expect(referenceCovers("cover-exclude-default", { exclude: ["dist"] }, "node_modules/pkg/a.ts")).toBe(true);
    expect(referenceCovers("cover-exclude-default", { exclude: ["dist"] }, "dist/a.ts")).toBe(false);
  });

  it("files lists exact paths; with files and no include nothing else is covered", () => {
    expect(referenceCovers("cover-files", { files: ["src/main.ts"] }, "src/main.ts")).toBe(true);
    expect(referenceCovers("cover-files", { files: ["./src/main.ts"] }, "src/main.ts")).toBe(true);
    expect(referenceCovers("cover-files", { files: ["src/main.ts"] }, "src/other.ts")).toBe(false);
    expect(referenceCovers("cover-files-include", { files: ["src/main.ts"], include: ["lib"] }, "lib/z.ts")).toBe(true);
  });

  it("braces, character classes and absolute entries are taken literally: they can only under-match", () => {
    expect(referenceCovers("cover-literal", { include: ["{src,lib}"] }, "src/a.ts")).toBe(false);
    expect(referenceCovers("cover-literal", { include: ["src/[a].ts"] }, "src/a.ts")).toBe(false);
    expect(referenceCovers("cover-literal", { include: ["/src"] }, "src/a.ts")).toBe(false);
    expect(referenceCovers("cover-literal", { include: [""] }, "src/a.ts")).toBe(false);
  });
});

describe("TS/JS — a hostile include/exclude cannot stall the resolver (review pass 2, P0-2)", () => {
  // The review's workspace: a solution config referencing an app config whose `include` is `*?` repeated. Compiled to
  // `[^/]*[^/][^/]*…` and tested against a segment shorter than the mandatory `[^/]` run, V8 backtracks exponentially
  // (killed after 20 s). The importer directory name is deliberately long.
  const HOSTILE_DIR = "a_rather_long_source_directory_name_for_the_probe";
  const hostileWorkspace = (tag: string, coverage: Record<string, unknown>) =>
    makeWorkspace(tag, {
      "tsconfig.json": JSON.stringify({ files: [], references: [{ path: "./tsconfig.app.json" }] }),
      "tsconfig.app.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } }, ...coverage }),
      [`${HOSTILE_DIR}/a.ts`]: "",
      [`${HOSTILE_DIR}/c.ts`]: "export const c = 1;\n",
      "src/b.ts": "export const b = 1;\n",
    });
  const body = "import { b } from '@/b';\nimport { c } from './c';\n";
  const timed = <T>(fn: () => T): { result: T; ms: number } => {
    const t0 = performance.now();
    const result = fn();
    return { result, ms: performance.now() - t0 };
  };

  it("the review's include (2,000 x `*?` = 4,000 characters) is refused at once; the relative import still resolves", () => {
    const ws = hostileWorkspace("glob-review-include", { include: ["*?".repeat(2000)] });
    const { result, ms } = timed(() => webEdges(ws, `${HOSTILE_DIR}/a.ts`, body));
    expect(ms).toBeLessThan(1000);
    // the alias lives in the referenced config, which does not cover the file: unresolved, never a stall
    expect(pathsOf(result)).toEqual([`${HOSTILE_DIR}/c.ts`]);
  });

  it("an alternation within the pattern bounds (250 x `*?` = 500 characters) is matched in linear time", () => {
    const ws = hostileWorkspace("glob-bounded-include", { include: ["*?".repeat(250), `**/${"*?".repeat(120)}`] });
    const { result, ms } = timed(() => webEdges(ws, `${HOSTILE_DIR}/a.ts`, body));
    expect(ms).toBeLessThan(1000);
    expect(pathsOf(result)).toEqual([`${HOSTILE_DIR}/c.ts`]);
  });

  it("the same alternations in `exclude` cost nothing and exclude nothing: the covering include still applies", () => {
    for (const coverage of [
      { include: ["**/*.ts"], exclude: ["*?".repeat(2000)] },
      { include: ["**/*.ts"], exclude: ["*?".repeat(250)] },
      { include: ["**/*.ts"], exclude: [`${HOSTILE_DIR}/${"*?".repeat(100)}`] },
    ]) {
      const ws = hostileWorkspace("glob-hostile-exclude", coverage);
      const { result, ms } = timed(() => webEdges(ws, `${HOSTILE_DIR}/a.ts`, body));
      expect(ms).toBeLessThan(1000);
      expect(pathsOf(result)).toEqual(["src/b.ts", `${HOSTILE_DIR}/c.ts`]);
    }
  });

  it("a package.json listing 12,000 explicit exports and 12,000 imports subpaths does not make every import of it expensive", () => {
    const exportsMap: Record<string, string> = {};
    const importsMap: Record<string, string> = {};
    for (let i = 0; i < 12_000; i++) {
      exportsMap[`./sub${i}`] = `./src/sub${i}.ts`;
      importsMap[`#k${i}`] = `./src/k${i}.ts`;
    }
    exportsMap["./lib/*"] = "./src/lib/*.ts";
    importsMap["#lib/*"] = "./src/lib/*.ts";
    const files: Record<string, string> = {
      "packages/big/package.json": JSON.stringify({ name: "@x/big", exports: exportsMap, imports: importsMap }),
      "packages/big/src/user.ts": "",
      "app/main.ts": "",
    };
    for (let i = 0; i < 50; i++) files[`packages/big/src/lib/a${i}.ts`] = `export const a${i} = ${i};\n`;
    const ws = makeWorkspace("big-subpath-maps", files);
    const viaExports = Array.from({ length: 50 }, (_, i) => `import a${i} from '@x/big/lib/a${i}';`).join("\n");
    const viaImports = Array.from({ length: 50 }, (_, i) => `import a${i} from '#lib/a${i}';`).join("\n");
    resetWebImportCaches();
    const t0 = performance.now();
    const exported = webEdges(ws, "app/main.ts", viaExports);
    const imported = webEdges(ws, "packages/big/src/user.ts", viaImports);
    const exportedAgain = webEdges(ws, "app/main.ts", viaExports);
    // cold parse of one ~700 KB manifest (under the 1 MiB read cap) plus 150 lookups: ~25 ms; scanning every key per lookup cost ~400 ms
    expect(performance.now() - t0).toBeLessThan(250);
    expect(exported.map((e) => e.path)).toEqual(Array.from({ length: 50 }, (_, i) => `packages/big/src/lib/a${i}.ts`));
    expect(imported.map((e) => e.path)).toEqual(exported.map((e) => e.path));
    expect(exportedAgain).toEqual(exported);
  });

  it("a config listing 90,000 include entries considers only the first 256: bounded work, a hostile list can only lose edges", () => {
    const filler = Array.from({ length: 90_000 }, (_, i) => `d${i}`);
    const cut = hostileWorkspace("glob-many-entries", { include: filler });
    const first = hostileWorkspace("glob-many-entries-first", { include: [HOSTILE_DIR, ...filler] });
    const late = hostileWorkspace("glob-many-entries-late", { include: [...filler, HOSTILE_DIR] });
    const cutRun = timed(() => webEdges(cut, `${HOSTILE_DIR}/a.ts`, body));
    const firstRun = timed(() => webEdges(first, `${HOSTILE_DIR}/a.ts`, body));
    const lateRun = timed(() => webEdges(late, `${HOSTILE_DIR}/a.ts`, body));
    for (const run of [cutRun, firstRun, lateRun]) expect(run.ms).toBeLessThan(1500);
    expect(pathsOf(cutRun.result)).toEqual([`${HOSTILE_DIR}/c.ts`]);
    expect(pathsOf(firstRun.result)).toEqual(["src/b.ts", `${HOSTILE_DIR}/c.ts`]); // the covering entry is inside the first 256
    expect(pathsOf(lateRun.result)).toEqual([`${HOSTILE_DIR}/c.ts`]); // beyond the 256th: cut, so the reference covers less
  });
});

// ---------------------------------------------------------------------------
// TS/JS — statement scan
// ---------------------------------------------------------------------------

describe("TS/JS — statements are found in code only", () => {
  const ws = makeWorkspace("scan", {
    "src/a.ts": "",
    "src/b.ts": "export const b = 1;\n",
    "src/c.ts": "export const c = 1;\n",
    "src/d.ts": "export const d = 1;\nexport default 1;\n",
    "src/e.ts": "export const e = 1;\n",
    "src/styles.css": "body {}\n",
    "src/f.ts": "export const f = 1;\n",
    "src/g.ts": "export const g = 1;\n",
  });

  it("skips comments, block comments, strings and template literals", () => {
    const body = [
      "// import { b } from './b';",
      "/*",
      "import { c } from './c';",
      " */",
      "const doc = \"import { d } from './d'\";",
      "const tpl = `",
      "import { e } from './e';",
      "`;",
      "const re = /import x from 'y'/;",
      "import { f } from './f'; // trailing comment",
      "",
    ].join("\n");
    const edges = webEdges(ws, "src/a.ts", body);
    expect(edges.map((e) => [e.path, e.line])).toEqual([["src/f.ts", 10]]);
  });

  it("finds side-effect, dynamic, require, export-from and multi-line imports, several per line", () => {
    const body = [
      "import './styles.css';",
      "const lazy = await import('./b');",
      "const { c: renamed } = require('./c');",
      "export * from './d';",
      "export { e } from './e';",
      "import {",
      "  f,",
      "  g as gg,",
      "} from './f'; import './g';",
      "",
    ].join("\n");
    const edges = webEdges(ws, "src/a.ts", body);
    expect(edges.map((e) => [e.path, e.line, e.names])).toEqual([
      ["src/styles.css", 1, []],
      ["src/b.ts", 2, ["lazy"]],
      ["src/c.ts", 3, ["c", "renamed"]],
      ["src/d.ts", 4, []],
      ["src/e.ts", 5, ["e"]],
      ["src/f.ts", 9, ["f", "g", "gg"]],
      ["src/g.ts", 9, []],
    ]);
  });

  it("names: default, namespace, named with aliases and type modifiers", () => {
    const body = "import d, { b as bb, type C } from './b';\nimport * as ns from './c';\nimport type T from './d';\n";
    const edges = webEdges(ws, "src/a.ts", body);
    expect(edges.map((e) => e.names)).toEqual([["b", "bb", "C", "d"], ["ns"], ["T"]]);
  });

  it("member calls named import/from are not statements", () => {
    const body = "loader.import('./b');\nArray.from('./c');\nconst s = \"don't\"; foo('./d');\n";
    expect(webEdges(ws, "src/a.ts", body)).toEqual([]);
  });

  it("strips resource queries and ignores protocol, loader and root-absolute specifiers", () => {
    const body = "import s from './styles.css?inline';\nimport a from 'data:text/javascript,1';\nimport b from '!raw!./b';\nimport c from '/src/c';\n";
    expect(pathsOf(webEdges(ws, "src/a.ts", body))).toEqual(["src/styles.css"]);
  });
});

describe("TS/JS — more module-resolution rules", () => {
  it("jsconfig.json works like tsconfig.json; ${configDir} in paths; extensionless .json; trailing-slash directory import", () => {
    const ws = makeWorkspace("jsconfig", {
      "jsconfig.json": `{ "compilerOptions": { "paths": { "~/*": ["\${configDir}/app/*"] } } }\n`,
      "app/util/index.js": "export const util = 1;\n",
      "app/data.json": "{}\n",
      "app/main.js": "",
      "app/lib/index.js": "export const lib = 1;\n",
      "app/lib.js": "export const wrong = 1;\n",
    });
    const body = "import { util } from '~/util';\nimport data from '~/data';\nimport { lib } from './lib/';\nimport { wrong } from './lib';\n";
    expect(pathsOf(webEdges(ws, "app/main.js", body))).toEqual(["app/util/index.js", "app/data.json", "app/lib/index.js", "app/lib.js"]);
  });

  it("a matching paths pattern DECIDES (no baseUrl fallback, as in TypeScript); a specifier matching no pattern still uses baseUrl", () => {
    const ws = makeWorkspace("paths-decides", {
      "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "lib/*": ["nowhere/*"], "@/*": ["shared/*"] } } }),
      "src/util.ts": "export const u = 1;\n",
      "lib/tool.ts": "export const t = 1;\n",
      "app.ts": "",
    });
    expect(webEdges(ws, "app.ts", "import a from 'lib/tool';\n")).toEqual([]);
    expect(pathsOf(webEdges(ws, "app.ts", "import a from 'src/util';\n"))).toEqual(["src/util.ts"]);
  });

  it("a `#` name may be claimed by a paths key, and an explicit .ts names the .tsx file when only that exists", () => {
    const ws = makeWorkspace("hash-and-tsx", {
      "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "#c/*": ["src/c/*"], "@widget": ["src/widget.ts"] } } }),
      "src/c/thing.ts": "export const thing = 1;\n",
      "src/widget.tsx": "export const Widget = () => null;\n",
      "app.ts": "",
    });
    expect(pathsOf(webEdges(ws, "app.ts", "import a from '#c/thing';\nimport w from '@widget';\n"))).toEqual(["src/c/thing.ts", "src/widget.tsx"]);
  });

  it("declaration files resolve when no source module exists: ./types -> types.d.ts, ./api -> api/index.d.ts", () => {
    const ws = makeWorkspace("declarations", {
      "src/app.ts": "",
      "src/types.d.ts": "export interface Shape { sides: number }\n",
      "src/api/index.d.ts": "export declare function call(): void;\n",
      "src/both.ts": "export const both = 1;\n",
      "src/both.d.ts": "export declare const both: number;\n",
    });
    const edges = webEdges(ws, "src/app.ts", "import type { Shape } from './types';\nimport { call } from './api';\nimport { both } from './both';\n");
    expect(pathsOf(edges)).toEqual(["src/types.d.ts", "src/api/index.d.ts", "src/both.ts"]);
  });

  it("a directory that is itself a package resolves through its package.json entry (built entry mapped back to source)", () => {
    const ws = makeWorkspace("dir-manifest", {
      "src/app.ts": "",
      "src/vendor-lib/package.json": JSON.stringify({ name: "vendor-lib", main: "lib/main.js" }),
      "src/vendor-lib/src/main.ts": "export const main = 1;\n",
      "src/vendor-lib/index.ts": "export const other = 1;\n",
    });
    expect(pathsOf(webEdges(ws, "src/app.ts", "import { main } from './vendor-lib';\n"))).toEqual(["src/vendor-lib/src/main.ts"]);
  });

  it("a barrel's own re-exports resolve in the BARREL's config context, not the importer's", () => {
    const ws = makeWorkspace("barrel-context", {
      "apps/a/tsconfig.json": `{ "compilerOptions": {} }\n`,
      "apps/a/src/x.ts": "",
      "apps/b/tsconfig.json": `{ "compilerOptions": { "baseUrl": ".", "paths": { "@b/*": ["src/*"] } } }\n`,
      "apps/b/src/barrel.ts": "export { thing } from '@b/thing';\n",
      "apps/b/src/thing.ts": "export const thing = 1;\n",
    });
    const edges = webEdges(ws, "apps/a/src/x.ts", "import { thing } from '../../b/src/barrel';\n");
    expect(pathsOf(edges)).toEqual(["apps/b/src/barrel.ts", "apps/b/src/thing.ts"]);
  });

  it("an alias onto a package's declaration OUTPUT resolves to its source twin; with no twin the resolved output file is kept", () => {
    const ws = makeWorkspace("build-output", {
      "apps/web/tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@shared": ["../../packages/shared/dist/index.d.ts"], "@built-only": ["../../packages/built/dist/index.d.ts"] } },
      }),
      "apps/web/src/x.ts": "",
      "packages/shared/package.json": JSON.stringify({ name: "@acme/shared" }),
      "packages/shared/src/index.ts": "export const shared = 1;\n",
      "packages/shared/dist/index.d.ts": "export declare const shared = 1;\n",
      "packages/shared/dist/index.js": "export const shared = 1;\n",
      "packages/shared/dist/util.js": "export const util = 1;\n",
      "packages/shared/dist/consumer.js": "",
      "packages/built/package.json": JSON.stringify({ name: "@acme/built" }),
      "packages/built/dist/index.d.ts": "export declare const built = 1;\n",
      // a `build` folder that is ordinary source (no manifest beside it) is untouched
      "tools/main.ts": "",
      "tools/build/util.ts": "export const buildUtil = 1;\n",
    });
    expect(pathsOf(webEdges(ws, "apps/web/src/x.ts", "import { shared } from '@shared';\nimport { built } from '@built-only';\n"))).toEqual([
      "packages/shared/src/index.ts",
      "packages/built/dist/index.d.ts",
    ]);
    expect(pathsOf(webEdges(ws, "tools/main.ts", "import { buildUtil } from './build/util';\n"))).toEqual(["tools/build/util.ts"]);
    // a file that lives IN the output keeps its own neighbours
    expect(pathsOf(webEdges(ws, "packages/shared/dist/consumer.js", "import { util } from './util.js';\n"))).toEqual(["packages/shared/dist/util.js"]);
  });

  it("a relative import into a real source build/, out/ or dist/ directory names that file: never redirected to src/, never dropped", () => {
    const ws = makeWorkspace("relative-into-build", {
      "package.json": JSON.stringify({ name: "app", private: true }),
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
      // checked-in build scripts beside the root package.json, and an UNRELATED src/helpers.ts of the same name
      "build/helpers.ts": "export function banner(): string { return 'build'; }\n",
      "build/webpack.config.ts": "export const config = {};\n",
      "build/index.ts": "export const buildIndex = 1;\n",
      "src/helpers.ts": "export function banner(): string { return 'app'; }\n",
      "src/emit.ts": "export const srcEmit = 1;\n",
      "out/emit.ts": "export const outEmit = 1;\n",
      "dist/bundle.d.ts": "export declare const bundle: number;\n",
      "src/bundle.ts": "export const bundle = 1;\n",
      "scripts/release.ts": "",
    });
    const body = [
      "import { banner } from '../build/helpers';",
      "import { config } from '../build/webpack.config';",
      "import { buildIndex } from '../build';",
      "import { outEmit } from '../out/emit';",
      "import type { bundle } from '../dist/bundle';",
      "",
    ].join("\n");
    expect(webEdges(ws, "scripts/release.ts", body).map((e) => [e.path, e.line])).toEqual([
      ["build/helpers.ts", 1],
      ["build/webpack.config.ts", 2],
      ["build/index.ts", 3],
      ["out/emit.ts", 4],
      ["dist/bundle.d.ts", 5], // the author named the declaration file's directory: it is that file, not src/bundle.ts
    ]);
  });

  it("only a generated artifact with a TypeScript twin is redirected: a real source file or a JS twin is not evidence of generation", () => {
    const ws = makeWorkspace("artifact-twin", {
      "apps/web/tsconfig.json": JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@build/*": ["../../build/*"], // an alias that NAMES the source build scripts
            "@decl": ["../../pkg/dist/index.d.ts"], // declaration output with a TypeScript twin
            "@compiled": ["../../pkg/dist/util.js"], // compiled JS with a TypeScript twin
            "@tool": ["../../build/tool.js"], // hand-written JS whose only src/ namesake is JS
            "@lonely": ["../../pkg/dist/lonely.d.ts"], // declaration output with no twin at all
          },
        },
      }),
      "apps/web/src/x.ts": "",
      "package.json": JSON.stringify({ name: "root", private: true }),
      "build/helpers.ts": "export const buildHelpers = 1;\n",
      "src/helpers.ts": "export const srcHelpers = 1;\n",
      "build/tool.js": "module.exports = {};\n",
      "src/tool.js": "module.exports = { app: true };\n",
      "pkg/package.json": JSON.stringify({ name: "pkg" }),
      "pkg/src/index.ts": "export const index = 1;\n",
      "pkg/src/util.tsx": "export const util = 1;\n",
      "pkg/dist/index.d.ts": "export declare const index: number;\n",
      "pkg/dist/util.js": "exports.util = 1;\n",
      "pkg/dist/lonely.d.ts": "export declare const lonely: number;\n",
    });
    const body = [
      "import { h } from '@build/helpers';",
      "import { i } from '@decl';",
      "import { u } from '@compiled';",
      "import t from '@tool';",
      "import { l } from '@lonely';",
      "",
    ].join("\n");
    expect(pathsOf(webEdges(ws, "apps/web/src/x.ts", body))).toEqual([
      "build/helpers.ts",
      "pkg/src/index.ts",
      "pkg/src/util.tsx",
      "build/tool.js",
      "pkg/dist/lonely.d.ts",
    ]);
  });

  it("a workspace package whose entry is a built file with no source twin resolves to that entry — unless a later entry names real source", () => {
    const ws = makeWorkspace("entry-without-twin", {
      "apps/app/src/main.ts": "",
      "packages/nb/package.json": JSON.stringify({ name: "@acme/nb", main: "dist/index.js", exports: { "./extra": "./dist/extra.js" } }),
      "packages/nb/dist/index.js": "exports.nb = 1;\n",
      "packages/nb/dist/extra.js": "exports.extra = 1;\n",
      // a package whose dist is absent (a fresh clone) and whose source layout is unknown: nothing to point at
      "packages/gone/package.json": JSON.stringify({ name: "@acme/gone", main: "dist/index.js" }),
      "packages/gone/lib/main.ts": "export const gone = 1;\n",
      // a built `main` without a twin must not shadow a later entry that names real source
      "packages/mixed/package.json": JSON.stringify({ name: "@acme/mixed", main: "dist/index.js", types: "src/main.ts" }),
      "packages/mixed/dist/index.js": "exports.mixed = 1;\n",
      "packages/mixed/src/main.ts": "export const mixed = 1;\n",
    });
    expect(
      pathsOf(webEdges(ws, "apps/app/src/main.ts", "import a from '@acme/nb';\nimport b from '@acme/nb/extra';\nimport c from '@acme/gone';\nimport d from '@acme/mixed';\n")),
    ).toEqual(["packages/nb/dist/index.js", "packages/nb/dist/extra.js", "packages/mixed/src/main.ts"]);
  });

  it("a paths wildcard substitution is normalized: no self edge, no second spelling of the same file", () => {
    const ws = makeWorkspace("paths-normalized", {
      "apps/web/package.json": JSON.stringify({ name: "web" }),
      "apps/web/tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }),
      "apps/web/lib/util.ts": "export const u = 1;\n",
      "apps/web/src/self.ts": "",
    });
    const body = "import { u } from '@/../lib/util';\nimport { u as u2 } from '../lib/util';\nimport { s } from '@/./self';\nimport { s as s2 } from '@/../src/./self';\n";
    const raw = webEdges(ws, "apps/web/src/self.ts", body);
    expect(raw.map((e) => [e.path, e.line])).toEqual([
      ["apps/web/lib/util.ts", 1],
      ["apps/web/lib/util.ts", 2],
    ]);
    // through the dispatcher the two spellings dedupe to one edge (and the file itself never appears)
    expect(resolveImportsOf(ws, "apps/web/src/self.ts", body).map((e) => [e.path, e.line])).toEqual([["apps/web/lib/util.ts", 1]]);
    // a substitution that climbs out of the workspace resolves nothing
    expect(webEdges(ws, "apps/web/src/self.ts", "import x from '@/../../../../../../etc/passwd';\n")).toEqual([]);
  });

  it("a non-canonical importer path (./src//a.ts, backslashes) never yields the importer itself", () => {
    const ws = makeWorkspace("importer-forms", {
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 1;\n",
    });
    const body = "import { a } from './a';\nimport { b } from './b';\n";
    for (const importer of ["src/a.ts", "./src/a.ts", "src//a.ts", "src\\a.ts", ".\\src\\a.ts"]) {
      expect(pathsOf(webEdges(ws, importer, body))).toEqual(["src/b.ts"]);
    }
  });

  it("a tsconfig extends base (or references target) created AFTER the first resolution is picked up; a deleted one is dropped", () => {
    resetWebImportCaches();
    const ws = makeWorkspace("extends-created-late", {
      "package.json": JSON.stringify({ name: "late-root", private: true }),
      "tsconfig.json": `{ "extends": "./tsconfig.base.json", "compilerOptions": {} }\n`,
      "src/a.ts": "",
      "lib/b.ts": "export const b = 1;\n",
      "solution/tsconfig.json": `{ "files": [], "references": [{ "path": "./tsconfig.app.json" }] }\n`,
      "solution/src/s.ts": "",
      "solution/src/util/u.ts": "export const u = 1;\n",
    });
    const viaBase = () => pathsOf(webEdges(ws, "src/a.ts", "import { b } from '@lib/b';\n"));
    const viaReference = () => pathsOf(webEdges(ws, "solution/src/s.ts", "import { u } from '@s/util/u';\n"));
    expect(viaBase()).toEqual([]);
    expect(viaReference()).toEqual([]);
    // no cache reset in between: the missing files are dependencies of the cached views
    fs.writeFileSync(path.join(ws, "tsconfig.base.json"), `{ "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["lib/*"] } } }\n`);
    fs.writeFileSync(path.join(ws, "solution/tsconfig.app.json"), `{ "compilerOptions": { "baseUrl": ".", "paths": { "@s/*": ["./src/*"] } }, "include": ["src"] }\n`);
    expect(viaBase()).toEqual(["lib/b.ts"]);
    expect(viaReference()).toEqual(["solution/src/util/u.ts"]);
    fs.rmSync(path.join(ws, "tsconfig.base.json"));
    expect(viaBase()).toEqual([]);
  });

  it("parsed manifests are validated by mtime+size: an edited tsconfig takes effect at once; package.json after the recheck interval", () => {
    resetWebImportCaches();
    const ws = makeWorkspace("invalidate", {
      "package.json": JSON.stringify({ name: "root", private: true }),
      "tsconfig.json": `{ "compilerOptions": { "baseUrl": ".", "paths": { "@x/*": ["one/*"] } } }\n`,
      "one/thing.ts": "export const one = 1;\n",
      "two/thing.ts": "export const two = 1;\n",
      "lib/package.json": JSON.stringify({ name: "@t/lib", main: "src/a.ts" }),
      "lib/src/a.ts": "export const a = 1;\n",
      "lib/src/b.ts": "export const b = 1;\n",
      "app.ts": "",
    });
    const alias = () => pathsOf(webEdges(ws, "app.ts", "import { t } from '@x/thing';\n"));
    const pkg = () => pathsOf(webEdges(ws, "app.ts", "import { l } from '@t/lib';\n"));
    expect(alias()).toEqual(["one/thing.ts"]);
    expect(pkg()).toEqual(["lib/src/a.ts"]);
    // a different size, so the stamp differs even when the mtime tick is the same
    fs.writeFileSync(path.join(ws, "tsconfig.json"), `{ "compilerOptions": { "baseUrl": ".", "paths": { "@x/*": ["two/*"] } }, "include": ["**/*"] }\n`);
    expect(alias()).toEqual(["two/thing.ts"]);
    fs.writeFileSync(path.join(ws, "lib/package.json"), JSON.stringify({ name: "@t/lib", main: "src/b.ts", description: "changed" }));
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 5_000);
      expect(pkg()).toEqual(["lib/src/b.ts"]);
      // a package.json that did not exist when the map was built is found once the map is rebuilt (60 s)
      fs.mkdirSync(path.join(ws, "late"), { recursive: true });
      fs.writeFileSync(path.join(ws, "late/package.json"), JSON.stringify({ name: "@t/late", main: "index.ts" }));
      fs.writeFileSync(path.join(ws, "late/index.ts"), "export const late = 1;\n");
      const late = () => pathsOf(webEdges(ws, "app.ts", "import { l } from '@t/late';\n"));
      vi.setSystemTime(Date.now() + 5_000);
      expect(late()).toEqual([]);
      vi.setSystemTime(Date.now() + 61_000);
      expect(late()).toEqual(["late/index.ts"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// TS/JS — one-hop barrel re-exports
// ---------------------------------------------------------------------------

describe("TS/JS — one-hop barrel re-exports", () => {
  it("adds the defining module for a named re-export, an aliased one, a default re-export and an `export *` that declares the name", () => {
    const edges = webEdges(
      monorepo,
      HOME_TS,
      [
        "import { formatPrice } from '@acme/utils';", // export { formatPrice } from './format'
        "import { renamed } from '@acme/utils';", // export { orig as renamed } from './renames'
        "import { clamp } from '@acme/utils';", // export { default as clamp } from './clamp'
        "import { add } from '@acme/utils';", // export * from './math' (math declares add)
        "import { missing } from '@acme/utils';", // no module exports it
        "",
      ].join("\n"),
    );
    expect(edges.map((e) => [e.path, e.line, e.names])).toEqual([
      ["packages/utils/src/index.ts", 1, ["formatPrice"]],
      ["packages/utils/src/format.ts", 1, ["formatPrice"]],
      ["packages/utils/src/index.ts", 2, ["renamed"]],
      ["packages/utils/src/renames.ts", 2, ["renamed", "orig"]],
      ["packages/utils/src/index.ts", 3, ["clamp"]],
      ["packages/utils/src/clamp.ts", 3, ["clamp"]],
      ["packages/utils/src/index.ts", 4, ["add"]],
      ["packages/utils/src/math.ts", 4, ["add"]],
      ["packages/utils/src/index.ts", 5, ["missing"]],
    ]);
  });

  it("`export *` does not re-export the default, and a namespace import adds no hop", () => {
    const body = "import def from '@acme/utils';\nimport * as all from '@acme/utils';\n";
    expect(pathsOf(webEdges(monorepo, HOME_TS, body))).toEqual(["packages/utils/src/index.ts", "packages/utils/src/index.ts"]);
  });

  it("a default import follows `export { default } from`, and a relative directory barrel works too", () => {
    const ws = makeWorkspace("barrel-default", {
      "src/app.ts": "",
      "src/components/index.ts": "export { default } from './Panel';\nexport { Tab } from './Tab';\n",
      "src/components/Panel.tsx": "export default function Panel() { return null; }\n",
      "src/components/Tab.tsx": "export const Tab = () => null;\n",
    });
    const edges = webEdges(ws, "src/app.ts", "import Panel from './components';\nimport { Tab } from './components';\n");
    expect(edges.map((e) => [e.path, e.line])).toEqual([
      ["src/components/index.ts", 1],
      ["src/components/Panel.tsx", 1],
      ["src/components/index.ts", 2],
      ["src/components/Tab.tsx", 2],
    ]);
  });

  it("follows the two-step re-export (import then export) and `export * as ns`", () => {
    const ws = makeWorkspace("barrel-two-step", {
      "src/app.ts": "",
      "src/lib/index.ts": "import { alpha } from './alpha';\nimport * as beta from './beta';\nexport { alpha };\nexport { beta };\nexport * as gamma from './gamma';\n",
      "src/lib/alpha.ts": "export const alpha = 1;\n",
      "src/lib/beta.ts": "export const b = 1;\n",
      "src/lib/gamma.ts": "export const g = 1;\n",
    });
    const edges = webEdges(ws, "src/app.ts", "import { alpha, beta, gamma } from './lib';\n");
    expect(pathsOf(edges)).toEqual(["src/lib/index.ts", "src/lib/alpha.ts", "src/lib/beta.ts", "src/lib/gamma.ts"]);
  });

  it("several names re-exported from one module become ONE hop edge carrying all of them", () => {
    const ws = makeWorkspace("barrel-merge", {
      "src/app.ts": "",
      "src/lib/index.ts": "export { a, b } from './ab';\nexport { c } from './c';\n",
      "src/lib/ab.ts": "export const a = 1;\nexport const b = 2;\n",
      "src/lib/c.ts": "export const c = 3;\n",
    });
    const edges = webEdges(ws, "src/app.ts", "import { a, b, c } from './lib';\n");
    expect(edges.map((e) => [e.path, e.names])).toEqual([
      ["src/lib/index.ts", ["a", "b", "c"]],
      ["src/lib/ab.ts", ["a", "b"]],
      ["src/lib/c.ts", ["c"]],
    ]);
  });

  it("at most 8 barrel lookups per file", () => {
    const names = Array.from({ length: 12 }, (_, i) => `n${i}`);
    const barrel = names.map((n) => `export { ${n} } from './${n}';`).join("\n") + "\n";
    const files: Record<string, string> = { "src/app.ts": "", "src/lib/index.ts": barrel };
    for (const n of names) files[`src/lib/${n}.ts`] = `export const ${n} = 1;\n`;
    const ws = makeWorkspace("barrel-cap", files);
    const edges = webEdges(ws, "src/app.ts", `import { ${names.join(", ")} } from './lib';\n`);
    // one edge for the barrel itself + exactly 8 hops
    expect(edges).toHaveLength(1 + 8);
    expect(pathsOf(edges).slice(1)).toEqual(names.slice(0, 8).map((n) => `src/lib/${n}.ts`));
  });
});

// ---------------------------------------------------------------------------
// TS/JS — workspace safety
// ---------------------------------------------------------------------------

describe("TS/JS — an escape from the workspace never yields an edge", () => {
  it("relative specifiers and paths targets that leave the workspace are dropped; a symlink out of it too", () => {
    const wsName = path.basename(monorepo);
    const outsideFile = path.join(path.dirname(monorepo), `${wsName}-outside.ts`);
    const outsideDir = path.join(path.dirname(monorepo), `${wsName}-outside-dir`);
    fs.writeFileSync(outsideFile, "export const leaked = 1;\n");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, "linked.ts"), "export const linked = 1;\n");
    strayFiles.push(outsideFile, outsideDir);
    const ws = makeWorkspace("escape", {
      "apps/web/tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@out": [`../../../${wsName}-outside.ts`], "@abs": [outsideFile] } } }),
      "apps/web/src/entry.ts": "",
    });
    let symlinked = true;
    try {
      fs.symlinkSync(outsideDir, path.join(ws, "apps/web/src/linkdir"), "dir");
      fs.symlinkSync(path.join(outsideDir, "linked.ts"), path.join(ws, "apps/web/src/linkfile.ts"), "file");
    } catch {
      symlinked = false; // no symlink privilege on this platform
    }
    const body = [
      `import { leaked } from '../../../../${wsName}-outside';`,
      "import { leaked as l2 } from '@out';",
      "import { leaked as l3 } from '@abs';",
      "import { linked } from './linkdir/linked';",
      "import { linked as l4 } from './linkfile';",
      "",
    ].join("\n");
    expect(webEdges(ws, "apps/web/src/entry.ts", body)).toEqual([]);
    if (process.platform !== "win32") expect(symlinked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

const HANDLERS = "services/pricing/src/pricing/api/handlers.py";

describe("Python — a src-layout service nested below the workspace root", () => {
  it("resolves absolute imports through the topmost package's parent, and standard-library imports yield nothing", () => {
    const edges = pyEdges(
      monorepo,
      HANDLERS,
      [
        "import os, json",
        "from collections import OrderedDict",
        "from pricing.engine import compute_total",
        "import pricing.rules",
        "",
      ].join("\n"),
    );
    expect(edges.map((e) => [e.path, e.line])).toEqual([
      ["services/pricing/src/pricing/engine.py", 3],
      ["services/pricing/src/pricing/rules.py", 4],
    ]);
  });

  it("`from pkg import submodule` goes to the submodule, not to the package file", () => {
    const edges = pyEdges(monorepo, HANDLERS, "from pricing import engine\nfrom pricing.api import serializers as ser\n");
    expect(edges.map((e) => [e.path, e.names])).toEqual([
      ["services/pricing/src/pricing/engine.py", ["engine"]],
      ["services/pricing/src/pricing/api/serializers.py", ["serializers", "ser"]],
    ]);
  });

  it("follows a re-export through __init__.py: explicit, aliased and star (star only when the module defines the name)", () => {
    const edges = pyEdges(
      monorepo,
      HANDLERS,
      "from pricing import compute_total, discount, Price, Hidden\n",
    );
    expect(edges.map((e) => [e.path, e.line, e.names])).toEqual([
      ["services/pricing/src/pricing/__init__.py", 1, ["compute_total", "discount", "Price", "Hidden"]],
      ["services/pricing/src/pricing/engine.py", 1, ["compute_total"]],
      // `from .rules import bulk_discount as discount`: the local name is `discount`, the defining name `bulk_discount`
      ["services/pricing/src/pricing/rules.py", 1, ["discount", "bulk_discount"]],
      // `from .models import *` with __all__ = ['Price']: Price is re-exported, Hidden is not
      ["services/pricing/src/pricing/models.py", 1, ["Price"]],
    ]);
  });

  it("a PEP 420 namespace package (a directory without __init__.py) resolves for both import forms", () => {
    const edges = pyEdges(monorepo, HANDLERS, "from pricing.plugins import tax\nimport pricing.plugins.tax as t2\n");
    expect(edges.map((e) => [e.path, e.names])).toEqual([
      ["services/pricing/src/pricing/plugins/tax.py", ["tax"]],
      ["services/pricing/src/pricing/plugins/tax.py", ["t2", "tax"]],
    ]);
  });

  it("relative imports: `from . import mod`, `from .. import mod`, `from ..mod import name`", () => {
    const edges = pyEdges(
      monorepo,
      HANDLERS,
      "from . import serializers\nfrom .. import engine\nfrom ..models import Price\nfrom ... import nothing_here\n",
    );
    expect(pathsOf(edges)).toEqual([
      "services/pricing/src/pricing/api/serializers.py",
      "services/pricing/src/pricing/engine.py",
      "services/pricing/src/pricing/models.py",
    ]);
  });

  it("a test file outside the package still finds it through the project's src/ directory", () => {
    const edges = pyEdges(monorepo, "services/pricing/tests/test_engine.py", "from pricing.engine import compute_total\nimport config\n");
    expect(pathsOf(edges)).toEqual(["services/pricing/src/pricing/engine.py", "services/pricing/config.py"]);
  });

  it("inside a package a sibling module named like a stdlib module or a top-level module is NOT taken for an absolute import", () => {
    // api/logging.py and api/config.py sit next to handlers.py, but handlers.py is inside a package:
    // `import logging` is the standard library, `import config` is the project's top-level config.py.
    const edges = pyEdges(monorepo, HANDLERS, "import logging\nimport config\n");
    expect(pathsOf(edges)).toEqual(["services/pricing/config.py"]);
  });

  it("a script directory (no __init__.py) resolves siblings first", () => {
    const edges = pyEdges(monorepo, "services/pricing/scripts/report.py", "import config\nfrom pricing.engine import compute_total\n");
    expect(pathsOf(edges)).toEqual(["services/pricing/scripts/config.py", "services/pricing/src/pricing/engine.py"]);
  });

  it("commented and docstring imports, and unknown modules, yield nothing", () => {
    const body = [
      '"""Module docs.',
      "",
      "    from pricing.engine import compute_total",
      '"""',
      "# from pricing.rules import bulk_discount",
      "x = 'import pricing.models'",
      "from pricing.missing import nothing",
      "import totally.unknown",
      "",
    ].join("\n");
    expect(pyEdges(monorepo, HANDLERS, body)).toEqual([]);
  });

  it("finds statements the old scan missed: parenthesized blocks with comments, backslash continuations, several modules per import", () => {
    const body = [
      "from pricing import (",
      "    engine,  # the engine, with a comma",
      "    rules,",
      ")",
      "from pricing.engine import \\",
      "    compute_total",
      "import pricing.models, pricing.rules as r",
      "",
    ].join("\n");
    const edges = pyEdges(monorepo, HANDLERS, body);
    expect(edges.map((e) => [e.path, e.line])).toEqual([
      ["services/pricing/src/pricing/engine.py", 1],
      ["services/pricing/src/pricing/rules.py", 1],
      ["services/pricing/src/pricing/engine.py", 5],
      ["services/pricing/src/pricing/models.py", 7],
      ["services/pricing/src/pricing/rules.py", 7],
    ]);
  });

  it("two independent projects reusing a package name resolve within their own project", () => {
    const a = pyEdges(monorepo, "svc_a/app/views.py", "from app.models import UserA\nfrom app.only_b import only_b\n");
    expect(pathsOf(a)).toEqual(["svc_a/app/models.py"]);
    const b = pyEdges(monorepo, "svc_b/app/views.py", "from app.models import UserB\nfrom app.only_b import only_b\n");
    expect(pathsOf(b)).toEqual(["svc_b/app/models.py", "svc_b/app/only_b.py"]);
  });

  it("a flat scripts directory resolves sibling modules (implicit-relative style)", () => {
    const edges = pyEdges(monorepo, "scripts/etl/run.py", "import json\nimport helpers\nfrom loaders import load_rows\nfrom helpers import clean\n");
    expect(edges.map((e) => [e.path, e.line])).toEqual([
      ["scripts/etl/helpers.py", 2],
      ["scripts/etl/loaders.py", 3],
      ["scripts/etl/helpers.py", 4],
    ]);
  });

  it("stub files are only a last resort", () => {
    const ws = makeWorkspace("py-stubs", {
      "proj/pyproject.toml": "",
      "proj/native.pyi": "def fast() -> int: ...\n",
      "proj/both.py": "def a(): pass\n",
      "proj/both.pyi": "def a() -> None: ...\n",
      "proj/main.py": "",
    });
    const edges = pyEdges(ws, "proj/main.py", "import native\nimport both\n");
    expect(pathsOf(edges)).toEqual(["proj/native.pyi", "proj/both.py"]);
  });

  it("at most 8 re-export lookups per file", () => {
    const names = Array.from({ length: 12 }, (_, i) => `f${i}`);
    const init = names.map((n) => `from .m_${n} import ${n}`).join("\n") + "\n";
    const files: Record<string, string> = { "proj/pyproject.toml": "", "proj/pkg/__init__.py": init, "proj/main.py": "" };
    for (const n of names) files[`proj/pkg/m_${n}.py`] = `def ${n}():\n    pass\n`;
    const ws = makeWorkspace("py-cap", files);
    const edges = pyEdges(ws, "proj/main.py", `from pkg import ${names.join(", ")}\n`);
    expect(edges).toHaveLength(1 + 8);
    expect(pathsOf(edges)[0]).toBe("proj/pkg/__init__.py");
  });

  it("a python edge never escapes the workspace (relative climb and symlink)", () => {
    const wsName = "py-escape";
    const outsideDir = path.join(os.tmpdir(), `.tl-e0930-outside-${process.pid}`);
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, "leaky.py"), "def leak():\n    pass\n");
    strayFiles.push(outsideDir);
    const ws = makeWorkspace(wsName, { "app/main.py": "" });
    try {
      fs.symlinkSync(outsideDir, path.join(ws, "app/linked"), "dir");
    } catch {
      /* no symlink privilege on this platform */
    }
    const body = "from ....... import beyond\nfrom linked import leaky\nfrom linked.leaky import leak\nimport linked.leaky\n";
    expect(pyEdges(ws, "app/main.py", body)).toEqual([]);
  });
});

describe("Python — more resolution rules", () => {
  it("a file with a __main__ guard runs as a script: its own directory is searched first, even inside a package", () => {
    const body = "import config\nif __name__ == '__main__':\n    pass\n";
    // handlers.py is a library module: `import config` skips the package sibling api/config.py
    expect(pathsOf(pyEdges(monorepo, HANDLERS, "import config\n"))).toEqual(["services/pricing/config.py"]);
    // the same statement in a script (guarded) finds the sibling first
    expect(pathsOf(pyEdges(monorepo, HANDLERS, body))).toEqual(["services/pricing/src/pricing/api/config.py"]);
  });

  it("an absolute re-export in __init__ (`from pkg.impl import name`) and an import inside try/except are followed", () => {
    const ws = makeWorkspace("py-absolute-reexport", {
      "proj/pyproject.toml": "",
      "proj/src/lib/__init__.py": "try:\n    from lib.impl import make\nexcept ImportError:\n    make = None\nfrom lib.other import Thing as Renamed\n",
      "proj/src/lib/impl.py": "def make():\n    pass\n",
      "proj/src/lib/other.py": "class Thing:\n    pass\n",
      "proj/tests/test_lib.py": "",
    });
    const edges = pyEdges(ws, "proj/tests/test_lib.py", "from lib import make, Renamed\n");
    expect(edges.map((e) => [e.path, e.names])).toEqual([
      ["proj/src/lib/__init__.py", ["make", "Renamed"]],
      ["proj/src/lib/impl.py", ["make"]],
      ["proj/src/lib/other.py", ["Renamed", "Thing"]],
    ]);
  });

  it("several names re-exported from one module become ONE hop edge carrying all of them", () => {
    const ws = makeWorkspace("py-merge", {
      "proj/pyproject.toml": "",
      "proj/pkg/__init__.py": "from .ab import a, b\nfrom .cc import c\n",
      "proj/pkg/ab.py": "def a(): pass\ndef b(): pass\n",
      "proj/pkg/cc.py": "def c(): pass\n",
      "proj/main.py": "",
    });
    const edges = pyEdges(ws, "proj/main.py", "from pkg import a, b, c\n");
    expect(edges.map((e) => [e.path, e.names])).toEqual([
      ["proj/pkg/__init__.py", ["a", "b", "c"]],
      ["proj/pkg/ab.py", ["a", "b"]],
      ["proj/pkg/cc.py", ["c"]],
    ]);
  });

  it("a module file shadows a same-named directory that has no __init__.py (CPython's rule); a real namespace directory does not", () => {
    const ws = makeWorkspace("py-shadow", {
      "proj/pyproject.toml": "",
      "proj/shadow.py": "def s(): pass\n",
      "proj/shadow/inner.py": "def i(): pass\n",
      "proj/ns/inner.py": "def n(): pass\n",
      "proj/main.py": "",
    });
    const edges = pyEdges(ws, "proj/main.py", "import shadow\nimport shadow.inner\nfrom shadow import inner\nimport ns.inner\nfrom ns import inner as ni\n");
    expect(edges.map((e) => [e.path, e.line])).toEqual([
      ["proj/shadow.py", 1],
      // `import shadow.inner` (line 2) resolves nothing: shadow is a module, not a package.
      // `from shadow import inner` names an attribute of the module file, never the directory's inner.py.
      ["proj/shadow.py", 3],
      ["proj/ns/inner.py", 4],
      ["proj/ns/inner.py", 5],
    ]);
  });

  it("imports at any indentation are statements: function bodies, if TYPE_CHECKING, try/except, semicolon-joined", () => {
    const body = [
      "def lazy():",
      "    import pricing.engine",
      "    if TYPE_CHECKING:",
      "        from pricing.rules import bulk_discount",
      "x = 1; import pricing.models",
      "",
    ].join("\n");
    expect(pyEdges(monorepo, HANDLERS, body).map((e) => [e.path, e.line])).toEqual([
      ["services/pricing/src/pricing/engine.py", 2],
      ["services/pricing/src/pricing/rules.py", 4],
      ["services/pricing/src/pricing/models.py", 5],
    ]);
  });

  it("an intermediate directory is never an import root: short names there do not capture a nested project's imports", () => {
    const ws = makeWorkspace("py-no-ancestor-roots", {
      "package.json": JSON.stringify({ name: "monorepo" }),
      "tasks.py": "def root_tasks(): pass\n",
      // deployment helpers one level above the services (not packages)
      "services/tasks.py": "def deploy(): pass\n",
      "services/config.py": "DEPLOY_REGION = 'eu'\n",
      "services/billing/pyproject.toml": "[project]\nname = 'billing'\n",
      "services/billing/src/billing/__init__.py": "",
      "services/billing/src/billing/worker.py": "",
      "services/billing/src/billing/models.py": "class Invoice: pass\n",
      "services/billing/scripts/backfill.py": "",
      "services/billing/settings.py": "QUEUE = 'billing'\n",
      // marker-less project: no pyproject/setup, no packages — only the file's own directory and the workspace root apply
      "backend/app/main.py": "",
      "backend/app/core/config.py": "DEBUG = True\n",
    });
    const worker = "services/billing/src/billing/worker.py";
    // `tasks` / `config` are not in the service's roots (a, b, d): the workspace-root tasks.py is the only tasks.py in reach (rule d)
    const edges = pyEdges(ws, worker, "import tasks\nimport config\nfrom billing import models\nimport settings\n");
    expect(edges.map((e) => [e.path, e.line])).toEqual([
      ["tasks.py", 1],
      ["services/billing/src/billing/models.py", 3],
      ["services/billing/settings.py", 4], // the project root (b) is a root
    ]);
    // a script directory: its own dir first, then the project root and src/, then the workspace root
    expect(pathsOf(pyEdges(ws, "services/billing/scripts/backfill.py", "import settings\nimport config\nimport tasks\nfrom billing import models\n"))).toEqual([
      "services/billing/settings.py",
      "tasks.py",
      "services/billing/src/billing/models.py",
    ]);
    // no manifest and no package anywhere: `app` is not reachable from backend/app/main.py (only rule c: backend/app, and d: the root)
    expect(pyEdges(ws, "backend/app/main.py", "from app.core import config\nimport app.core.config\n")).toEqual([]);
  });

  it("a workspace that is a single flat project (no manifest, no packages) still resolves through the workspace root", () => {
    const ws = makeWorkspace("py-flat", { "main.py": "", "util.py": "def u(): pass\n", "pkg/__init__.py": "", "pkg/mod.py": "def m(): pass\n" });
    const edges = pyEdges(ws, "main.py", "import util\nfrom pkg import mod\nfrom pkg.mod import m\n");
    expect(pathsOf(edges)).toEqual(["util.py", "pkg/mod.py", "pkg/mod.py"]);
  });
});

describe("path forms", () => {
  it("a non-canonical Python importer path (./pkg//a.py, backslashes) never yields the importer itself", () => {
    const ws = makeWorkspace("py-importer-forms", {
      "pkg/__init__.py": "",
      "pkg/a.py": "",
      "pkg/b.py": "def b(): pass\n",
    });
    const body = "from . import a, b\nfrom .a import thing\nimport pkg.a\nimport pkg.b\n";
    for (const importer of ["pkg/a.py", "./pkg/a.py", "pkg//a.py", "pkg\\a.py", ".\\pkg\\a.py"]) {
      expect(pathsOf(pyEdges(ws, importer, body))).toEqual(["pkg/b.py", "pkg/b.py"]);
    }
  });

  it("a backslash importer path and a trailing-separator workspace resolve like the canonical forms", () => {
    const body = "import { fmt } from '@/lib/format';\n";
    const canonical = webEdges(monorepo, HOME_TS, body);
    expect(pathsOf(canonical)).toEqual(["apps/web/src/lib/format.ts"]);
    expect(webEdges(monorepo, HOME_TS.replace(/\//g, "\\"), body)).toEqual(canonical);
    expect(resolveWebImports(monorepo + path.sep, HOME_TS, linesOf(body))).toEqual(canonical);
    const pyBody = "from pricing.engine import compute_total\n";
    expect(resolvePythonImports(monorepo + path.sep, HANDLERS.replace(/\//g, "\\"), linesOf(pyBody))).toEqual(pyEdges(monorepo, HANDLERS, pyBody));
  });
});

// ---------------------------------------------------------------------------
// Through the dispatcher and the neighbour index
// ---------------------------------------------------------------------------

describe("dispatcher and neighbour index over the nested projects", () => {
  it("resolveImportsOf dedupes by path and keeps statement order across hops", () => {
    const body = [
      "import { Button } from '@acme/ui';",
      "import { Button as B2 } from '@acme/ui/button';",
      "import { fmt } from '@/lib/format';",
      "",
    ].join("\n");
    const edges = resolveImportsOf(monorepo, HOME_TS, body);
    expect(edges.map((e) => [e.path, e.line])).toEqual([
      ["packages/ui/src/index.ts", 1],
      ["packages/ui/src/button.tsx", 1],
      ["apps/web/src/lib/format.ts", 3],
    ]);
  });

  it("plan.neighbours rows appear for a Python file and a TS file of nested projects (row order belongs to the ranking, so the SET is asserted)", () => {
    const py = "from pricing import engine, compute_total\nimport os\n";
    const pyRows = computeFrontierNeighbourIndex(fakeResult([surface(HANDLERS, py)]), monorepo);
    expect(pyRows.map((r) => r.path).sort()).toEqual(["services/pricing/src/pricing/__init__.py", "services/pricing/src/pricing/engine.py"]);
    const ts = "import { formatPrice } from '@acme/utils';\nimport { fmt } from '@/lib/format';\n";
    const tsRows = computeFrontierNeighbourIndex(fakeResult([surface(HOME_TS, ts)]), monorepo);
    expect(tsRows.map((r) => r.path).sort()).toEqual(
      ["apps/web/src/lib/format.ts", "packages/utils/src/format.ts", "packages/utils/src/index.ts"].sort(),
    );
    for (const row of tsRows) expect(row.why).toContain(HOME_TS);
  });
});

describe("robustness: hostile input costs edges, never an exception or unbounded time", () => {
  it("broken manifests and garbage bodies are survived", () => {
    const ws = makeWorkspace("hostile", {
      "tsconfig.json": "{ this is not json",
      "package.json": "\u0000\u0001 not json either",
      "sub/tsconfig.json": `{ "extends": "./tsconfig.json", "compilerOptions": { "paths": { "@a/*": ["nope/*"], "**": 5 } } }\n`,
      "sub/package.json": JSON.stringify({ name: 7, exports: { ".": { import: { require: { default: null } } } }, main: {} }),
      "sub/x.ts": "export const x = 1;\n",
      "sub/y.py": "",
    });
    const garbage = String.fromCharCode(...Array.from({ length: 4000 }, (_, i) => (i * 7919) % 256));
    expect(pathsOf(webEdges(ws, "sub/main.ts", "import { x } from './x';\nimport a from '@a/b';\nimport n from 'pkg';\n"))).toEqual(["sub/x.ts"]);
    expect(webEdges(ws, "sub/main.ts", garbage)).toEqual([]);
    expect(pyEdges(ws, "sub/y.py", garbage)).toEqual([]);
    expect(webEdges(ws, "sub/main.ts", "")).toEqual([]);
    expect(pyEdges(ws, "sub/y.py", "")).toEqual([]);
  });

  it("pathological lines stay linear (a single line of 200,000 `from '`, 50,000 dots, unclosed `export {` barrels)", () => {
    const ws = makeWorkspace("pathological", {
      "src/main.ts": "",
      "src/a.ts": "export const a = 1;\n",
      "src/barrel.ts": "export {".repeat(40000),
      "src/barrel8.ts": "export {".repeat(5000),
    });
    // Linear time is checked as a ratio, not against a wall-clock bound: each
    // shape at full size is timed against 1/8 of itself, the two alternately,
    // with the import caches cleared before every run (each run is the cold
    // call the shape is about), keeping the least of five runs of each. 8x
    // the input costs at most ~8x when linear or capped (measured 2026-10-20:
    // 1.2x to 7.7x; the unclosed barrel 31 -> 242 ms), 64x when quadratic.
    // The former 1.5 s bound per call kept 7.5x headroom on the barrel, less
    // than the 8.7x slowdown measured beside 40 CPU burners
    // (helpers/repoPackTimeout.ts).
    const shapes: Array<(scale: number) => unknown> = [
      (scale) => webEdges(ws, "src/main.ts", "from '".repeat(200_000 / scale)),
      (scale) => webEdges(ws, "src/main.ts", "import x from ".repeat(30_000 / scale)),
      (scale) => webEdges(ws, "src/main.ts", scale === 1 ? "import { a } from './barrel';\n" : "import { a } from './barrel8';\n"),
      (scale) => webEdges(ws, "src/main.ts", "import a from './a';\n".repeat(60_000 / scale)),
      (scale) => pyEdges(ws, "src/main.py", `from ${".".repeat(50_000 / scale)}x import y\nfrom ${".".repeat(50_000 / scale)}\n`),
      (scale) => pyEdges(ws, "src/main.py", "from x import (\n".repeat(30_000 / scale)),
    ];
    for (const [index, shape] of shapes.entries()) {
      const least = [Infinity, Infinity];
      for (let run = 0; run < 5; run++) {
        for (const [slot, scale] of [8, 1].entries()) {
          resetWebImportCaches();
          resetPythonImportCaches();
          const t0 = performance.now();
          shape(scale);
          least[slot] = Math.min(least[slot]!, performance.now() - t0);
        }
      }
      expect(least[1]! / least[0]!, `shape ${index}: ${least[0]!.toFixed(2)} ms -> ${least[1]!.toFixed(2)} ms`).toBeLessThan(32);
    }
  });
});

// ---------------------------------------------------------------------------
// Bounded work
// ---------------------------------------------------------------------------

describe("a huge directory does not stall the package walk", () => {
  it("6,000 entries in one directory: the walk keeps at most 5,000 of them and still finishes quickly", () => {
    const ws = makeWorkspace("huge-dir", { "package.json": JSON.stringify({ name: "huge" }), "src/app.ts": "", "aaa/package.json": JSON.stringify({ name: "@h/early", main: "index.ts" }), "aaa/index.ts": "export const e = 1;\n" });
    fs.mkdirSync(path.join(ws, "dataset"), { recursive: true });
    for (let i = 0; i < 6_000; i++) fs.writeFileSync(path.join(ws, "dataset", `f${String(i).padStart(5, "0")}.txt`), "");
    resetWebImportCaches();
    const t0 = performance.now();
    const edges = webEdges(ws, "src/app.ts", "import { e } from '@h/early';\nimport r from 'react';\n");
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(pathsOf(edges)).toEqual(["aaa/index.ts"]);
  });
});

describe("bounded work on a workspace of more than 2,000 files", () => {
  it("resolves imports of TS and Python files in a few milliseconds each on a warm cache", () => {
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: "bulk", private: true, workspaces: ["packages/*"] }),
      "tsconfig.base.json": JSON.stringify({ compilerOptions: { baseUrl: "." } }),
    };
    const PACKAGES = 50;
    const MODULES = 20;
    for (let p = 0; p < PACKAGES; p++) {
      files[`packages/pkg${p}/package.json`] = JSON.stringify({ name: `@bulk/pkg${p}`, main: "dist/index.js", types: "dist/index.d.ts" });
      files[`packages/pkg${p}/tsconfig.json`] = JSON.stringify({
        extends: "../../tsconfig.base.json",
        compilerOptions: { baseUrl: ".", paths: { "@self/*": ["./src/*"] } },
      });
      files[`packages/pkg${p}/src/index.ts`] = Array.from({ length: MODULES }, (_, m) => `export { v${m} } from './m${m}';`).join("\n") + "\n";
      for (let m = 0; m < MODULES; m++) {
        const next = (p + 1) % PACKAGES;
        files[`packages/pkg${p}/src/m${m}.ts`] = [
          `import { v${(m + 1) % MODULES} } from './m${(m + 1) % MODULES}';`,
          `import { v0 } from '@bulk/pkg${next}';`,
          "import { v1 } from '@self/m1';",
          "import React from 'react';",
          "import fs from 'node:fs';",
          `export const v${m} = 1;`,
          "",
        ].join("\n");
      }
      files[`services/svc${p}/pyproject.toml`] = "[project]\nname = 'svc'\n";
      files[`services/svc${p}/src/svc${p}/__init__.py`] = Array.from({ length: MODULES }, (_, m) => `from .m${m} import f${m}`).join("\n") + "\n";
      for (let m = 0; m < MODULES; m++) {
        files[`services/svc${p}/src/svc${p}/m${m}.py`] = [
          "import os",
          "import json",
          `from svc${p} import f${(m + 1) % MODULES}`,
          `from svc${p}.m${(m + 2) % MODULES} import f${(m + 2) % MODULES}`,
          `from . import m${(m + 3) % MODULES}`,
          `def f${m}():`,
          "    pass",
          "",
        ].join("\n");
      }
    }
    expect(Object.keys(files).length).toBeGreaterThan(2000);
    const ws = makeWorkspace("bulk", files);
    resetWebImportCaches();
    resetPythonImportCaches();

    const tsSamples: string[] = [];
    const pySamples: string[] = [];
    for (let p = 0; p < PACKAGES; p += 5) {
      for (let m = 0; m < MODULES; m += 4) {
        tsSamples.push(`packages/pkg${p}/src/m${m}.ts`);
        pySamples.push(`services/svc${p}/src/svc${p}/m${m}.py`);
      }
    }
    const bodies = new Map<string, string[]>();
    for (const rel of [...tsSamples, ...pySamples]) bodies.set(rel, linesOf(fs.readFileSync(path.join(ws, rel), "utf8")));

    const runAll = (): { web: number; py: number; webEdges: number; pyEdges: number } => {
      let webCount = 0;
      let pyCount = 0;
      const t0 = performance.now();
      for (const rel of tsSamples) webCount += resolveWebImports(ws, rel, bodies.get(rel)!).length;
      const t1 = performance.now();
      for (const rel of pySamples) pyCount += resolvePythonImports(ws, rel, bodies.get(rel)!).length;
      const t2 = performance.now();
      return { web: (t1 - t0) / tsSamples.length, py: (t2 - t1) / pySamples.length, webEdges: webCount, pyEdges: pyCount };
    };

    const cold = runAll(); // builds the package map and parses every manifest and barrel once
    const warm = runAll();
    console.log(
      `[bounded-work] files=${Object.keys(files).length} cold ts/py avg ms=${cold.web.toFixed(2)}/${cold.py.toFixed(2)} ` +
        `warm ts/py avg ms=${warm.web.toFixed(3)}/${warm.py.toFixed(3)}`,
    );
    // Each sampled TS module yields a relative, a paths and a workspace-package edge (+ its barrel hop); each Python module yields four edges.
    expect(warm.webEdges).toBeGreaterThan(tsSamples.length * 3);
    expect(warm.pyEdges).toBeGreaterThan(pySamples.length * 3);
    // Stated bound: a few milliseconds per file on a warm cache (typical: well under 1 ms; the bound leaves headroom for a loaded machine).
    expect(warm.web).toBeLessThan(8);
    expect(warm.py).toBeLessThan(8);
    expect(cold.web).toBeLessThan(200);
    expect(cold.py).toBeLessThan(200);
  });
});
