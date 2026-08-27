// bundle-cli.mjs — builds a zero-install copy of the TokenLighten CLI (and
// the MCP server it spawns) into packages/vscode-extension/dist/, so the
// packaged .vsix works without a `tl` on PATH and without repo node_modules.
//
// Why this exists: `vsce package` runs with --no-dependencies (walking npm
// workspace symlinks otherwise pulls in ~340MB of unrelated monorepo
// devDependencies and trips vsce's secret scanner on a fixture) — so
// node_modules is NOT in the packaged .vsix, and @tokenlighten/cli's real
// dist/index.js is unreachable at runtime. See src/cli.ts's bundledCliScript().
//
// What gets bundled vs. copied as an asset, and why:
//
//  - @tokenlighten/cli (index.ts + its own commands/*.ts) bundles cleanly:
//    every internal import is static, so esbuild inlines it into one file
//    (dist/tl-cli.js), along with whatever it statically imports from
//    sibling packages (@tokenlighten/types and @tokenlighten/usage).
//    @tokenlighten/agents-md is deliberately external here even though
//    workspace.ts imports it statically: its renderers locate templates from
//    their real package directory, so the CLI must resolve the runtime package
//    copied under dist/node_modules instead of an inlined copy in tl-cli.js.
//
//  - @tokenlighten/mcp-server, @tokenlighten/skeleton-engine, and
//    @tokenlighten/agents-md are NOT reachable that way for every use, even
//    though (agents-md aside) esbuild can't see it: cli's commands/mcp.ts,
//    skeleton.ts, and agents.ts resolve these siblings at RUNTIME via
//    `createRequire(import.meta.url).resolve("@tokenlighten/<pkg>")` — mcp.ts
//    to find mcp-server's bin.js and spawn it as a *separate child process*
//    (the actual MCP stdio server), skeleton.ts/agents.ts to lazy dynamic-
//    import the package (keeps CLI cold-start fast when those subcommands
//    are unused). A require.resolve() call with a non-literal downstream
//    path is invisible to a bundler — esbuild cannot inline what it can't
//    statically see — so at runtime this always needs a REAL, separately
//    resolvable package on disk, in dev (npm workspace hoisting) and here
//    alike. This script gives each of those three packages its own single-
//    file esbuild bundle plus a minimal package.json shim under
//    dist/node_modules/@tokenlighten/<pkg>/, so Node's normal module
//    resolution finds them relative to tl-cli.js exactly as it would find
//    them relative to the monorepo root in dev.
//
//  - web-tree-sitter + tree-sitter-wasms are a further special case even
//    though mcp-server's tree-sitter code IS reachable via a literal dynamic
//    `import("web-tree-sitter")` (so esbuild DOES inline its JS into the
//    mcp-server bundle): the WASM binaries themselves are always loaded via
//    a real filesystem path, resolved with
//    `createRequire(import.meta.url).resolve("web-tree-sitter/package.json")`
//    (packages/mcp-server/src/skeleton/treeSitter.ts) — a real disk lookup
//    no bundler can replace. So both packages' package.json (real, unmodified
//    — required for that resolve() to succeed) plus the runtime .wasm and
//    the grammar .wasm files actually referenced by treeSitter.ts's GRAMMARS
//    map are copied verbatim. Copying only the 15 referenced grammars (of
//    the 36 tree-sitter-wasms ships) keeps this well under the full
//    package's ~49MB.
//
//  - agents-md's template files are read from disk relative to its own
//    compiled location (`join(__dirname, "..", "templates")` in
//    packages/agents-md/src/render.ts / injectForTarget.ts) — not an ESM
//    import, so templates/ is copied alongside its bundle to preserve that
//    relative layout.
//
//  - exceljs, mammoth, unpdf, pptx2json, officecrypto-tool, jszip,
//    @zip.js/zip.js, @libpdf/core, @modelcontextprotocol/sdk, smol-toml: all
//    pure JS (no native .node bindings anywhere in this dependency set —
//    verified), reached via literal dynamic `import("pkg")` calls in
//    mcp-server's office/* wrappers, so esbuild inlines them into the
//    mcp-server bundle with no separate asset handling needed.

import { build } from "esbuild";
import {
  existsSync,
  mkdirSync,
  rmSync,
  cpSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = join(__dirname, "..");
const REPO_ROOT = join(__dirname, "..", "..", "..");
const DIST = join(EXT_ROOT, "dist");
const REPO_NODE_MODULES = join(REPO_ROOT, "node_modules");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function pkgVersion(pkgDir) {
  return readJson(join(pkgDir, "package.json")).version;
}

const commonOpts = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  minify: true,
  // No sourcemap: unlike extension.js (debugged in-process by VS Code), the
  // CLI and mcp-server run as spawned child processes never attached to an
  // interactive debugger, so a sourcemap here is pure vsix weight (the
  // mcp-server bundle alone carried a 21MB map versus 5.5MB of actual code).
  sourcemap: false,
  logLevel: "info",
  // Every bundled entry point here is ESM source using import.meta.url to
  // find sibling files relative to its own compiled location. esbuild's cjs
  // output format leaves import.meta.url empty (see its "empty-import-meta"
  // warning) — inject/define swap it for a real CJS-derived equivalent that
  // still names the bundle's own on-disk location. See import-meta-url-shim.js.
  inject: [join(__dirname, "import-meta-url-shim.js")],
  define: { "import.meta.url": "import_meta_url" },
  // unzipper's lib/Open/index.js (pulled in transitively via exceljs, inlined
  // into the mcp-server bundle below) has an opt-in `Open.s3_v3()` helper
  // that requires "@aws-sdk/client-s3" — a real dependency neither exceljs's
  // xlsx.load()/writeBuffer() nor mcp-server's streaming reader ever calls,
  // and not installed here (it's not one of unzipper's own declared deps).
  // esbuild resolves every static require() it can see regardless of which
  // branch actually runs, so without this it hard-fails at bundle time on a
  // module that's genuinely unreachable at runtime. Marking it external
  // leaves the require() call untouched in the output, matching source
  // behavior exactly (still unreachable, still fine).
  external: ["@aws-sdk/client-s3"],
};

// Public bundles must not carry the experimental Core 2 protocol behind the
// normal server identity. Development builds still import the real module.
const publicCore2ExclusionPlugin = {
  name: "tokenlighten-public-core2-exclusion",
  setup(buildContext) {
    const serverEntry = join(REPO_ROOT, "packages/mcp-server/src/server.ts");
    buildContext.onLoad({ filter: /\/server\.ts$/ }, (args) => {
      if (args.path !== serverEntry) return undefined;
      let contents = readFileSync(args.path, "utf8");
      const replacements = [
        [
          /const core2Module = argv\.includes\("--core2"\)\n  \? await import\("\.\/core2\/index\.js"\)\n  : undefined;/,
          "",
        ],
        [
          /  if \(core2Module\) return core2Module\.core2Config\(fallbackRoot\)\.allowedParents;\n\n/,
          "",
        ],
        [
          /  \/\/ C2 prototype \(--core2\): same 3 tool names,[\s\S]*?  if \(core2Module\?\.core2Config\(activeRoot\)\.enabled\) \{[\s\S]*?\n  \}\n/,
          "",
        ],
        [
          /  \/\/ C2 prototype \(--core2\): the lean protocol owns the whole call[\s\S]*?  if \(c2\.enabled\) \{[\s\S]*?\n  \}\n\n/,
          "",
        ],
        [
          /\n  if \(core2Module\) \{\n    const c2 = core2Module\.core2Config\(activeRoot\);[\s\S]*?\n  \}\n\n  if \(KILL_SWITCH\)/,
          "\n  if (KILL_SWITCH)",
        ],
      ];
      const needsCore2Sanitization = /core\s*2|core2|--core2/i.test(contents);
      for (const [pattern, next] of replacements) {
        if (!pattern.test(contents)) {
          if (!needsCore2Sanitization) continue;
          throw new Error(`bundle-cli: public Core 2 exclusion pattern drifted: ${pattern}`);
        }
        contents = contents.replace(pattern, next);
      }
      const lingeringCore2 = contents.split("\n").filter((line) => /core\s*2|core2|--core2/i.test(line));
      if (lingeringCore2.some((line) => !/^\s*(?:\/\/|\/\*|\*|\*\/)/.test(line))) {
        throw new Error("bundle-cli: public Core 2 exclusion left a non-comment reference in server.ts");
      }
      contents = contents.split("\n").filter((line) => !/core\s*2|core2|--core2/i.test(line)).join("\n");
      if (/core\s*2|core2|--core2/i.test(contents)) {
        throw new Error("bundle-cli: public Core 2 exclusion left a reference in server.ts");
      }
      return { contents, loader: "ts", resolveDir: dirname(args.path) };
    });

  },
};

/** Bundle one package's entry to a single CJS file, with a minimal package.json shim next to it so `require.resolve("@tokenlighten/<name>")` succeeds from tl-cli.js's dist/node_modules layout. */
async function bundleSiblingPackage({ name, srcEntry, outBasename, plugins = [] }) {
  const pkgRoot = join(DIST, "node_modules", ...name.split("/"));
  const pkgDist = join(pkgRoot, "dist");
  mkdirSync(pkgDist, { recursive: true });
  const outfile = join(pkgDist, outBasename);

  await build({
    ...commonOpts,
    entryPoints: [srcEntry],
    outfile,
    plugins,
  });

  const realPkgDir = join(REPO_ROOT, "packages", name.replace("@tokenlighten/", ""));
  writeFileSync(
    join(pkgRoot, "package.json"),
    JSON.stringify(
      {
        name,
        version: pkgVersion(realPkgDir),
        type: "commonjs",
        main: `dist/${outBasename}`,
        exports: { ".": { default: `./dist/${outBasename}` } },
      },
      null,
      2,
    ) + "\n",
  );
  return { pkgRoot, pkgDist, outfile };
}

async function main() {
  // Start clean so stale grammar files / shims never survive a rename.
  rmSync(join(DIST, "tl-cli.js"), { force: true });
  rmSync(join(DIST, "tl-cli.js.map"), { force: true });
  rmSync(join(DIST, "node_modules"), { recursive: true, force: true });

  // 1. @tokenlighten/cli itself — the thin orchestrator the extension spawns.
  await build({
    ...commonOpts,
    entryPoints: [join(REPO_ROOT, "packages/cli/src/index.ts")],
    outfile: join(DIST, "tl-cli.js"),
    external: [...commonOpts.external, "@tokenlighten/agents-md"],
  });
  // version.ts / help.ts read their own version via
  // require.resolve("@tokenlighten/cli/package.json") (not a hardcoded
  // "../.." from their own compiled location, which breaks once bundled) —
  // copy the real, unmodified package.json (it already exports
  // "./package.json") so that resolves from tl-cli.js's own location too.
  const cliShimDir = join(DIST, "node_modules", "@tokenlighten", "cli");
  mkdirSync(cliShimDir, { recursive: true });
  cpSync(
    join(REPO_ROOT, "packages/cli/package.json"),
    join(cliShimDir, "package.json"),
  );

  // 2. @tokenlighten/mcp-server — resolved+spawned as a child process by
  //    `tl mcp start` (commands/mcp.ts's resolveMcpBin). This is the actual
  //    MCP stdio server backing read_file/edit_file/search_files.
  const { pkgDist: mcpServerDist } = await bundleSiblingPackage({
    name: "@tokenlighten/mcp-server",
    srcEntry: join(REPO_ROOT, "packages/mcp-server/src/bin.ts"),
    outBasename: "bin.js",
    plugins: [publicCore2ExclusionPlugin],
  });

  // Archive support (tools/archive.ts) dynamic-imports
  // "libarchive.js/dist/libarchive-node.mjs", whose bundled-in code spawns a
  // worker_threads.Worker at `new URL("./worker-bundle-node.mjs",
  // import.meta.url)` relative to ITS OWN module — which, once inlined,
  // means relative to bin.js's location (see import-meta-url-shim.js). That
  // worker script is loaded directly by Node as its own module (never seen
  // by esbuild, so it can't be inlined) and in turn locates
  // libarchive.wasm the same self-relative way — both copied verbatim,
  // unmodified, as siblings of bin.js so both real disk lookups resolve.
  const libarchiveDist = join(REPO_NODE_MODULES, "libarchive.js", "dist");
  cpSync(
    join(libarchiveDist, "worker-bundle-node.mjs"),
    join(mcpServerDist, "worker-bundle-node.mjs"),
  );
  cpSync(
    join(libarchiveDist, "libarchive.wasm"),
    join(mcpServerDist, "libarchive.wasm"),
  );

  // 3. @tokenlighten/skeleton-engine — lazy dynamic-imported by
  //    `tl skeleton build` and `tl agents-md write --for-target`.
  await bundleSiblingPackage({
    name: "@tokenlighten/skeleton-engine",
    srcEntry: join(REPO_ROOT, "packages/skeleton-engine/src/index.ts"),
    outBasename: "index.js",
  });

  // 4. @tokenlighten/agents-md — lazy dynamic-imported by `tl agents-md
  //    write` (both --for-target and plain). Needs its templates/ dir
  //    (read relative to its own compiled location) copied alongside.
  const { pkgRoot: agentsMdRoot } = await bundleSiblingPackage({
    name: "@tokenlighten/agents-md",
    srcEntry: join(REPO_ROOT, "packages/agents-md/src/index.ts"),
    outBasename: "index.js",
  });
  cpSync(
    join(REPO_ROOT, "packages/agents-md/templates"),
    join(agentsMdRoot, "templates"),
    { recursive: true },
  );

  // Keep the generated third-party inventory with the runtime bundles shipped
  // inside the VSIX. The project LICENSE is added separately once its text is
  // approved; do not inherit the private repository's legacy MIT file here.
  cpSync(
    join(REPO_ROOT, "THIRD_PARTY_NOTICES.md"),
    join(DIST, "THIRD_PARTY_NOTICES.md"),
  );

  // 5. web-tree-sitter + tree-sitter-wasms — mcp-server's public
  //    tree-sitter code (packages/mcp-server/src/skeleton/treeSitter.ts)
  //    resolves these via a real `require.resolve("<pkg>/package.json")`
  //    disk lookup at runtime, independent of whatever esbuild inlined, so
  //    both need a real, unmodified package.json plus the actual .wasm
  //    bytes on disk. Only the 15 grammar files treeSitter.ts's GRAMMARS
  //    map can ever request are copied (of the 36 tree-sitter-wasms ships)
  //    to avoid dragging in ~30MB of unused grammars.
  const wtsSrc = join(REPO_NODE_MODULES, "web-tree-sitter");
  const wtsDst = join(DIST, "node_modules", "web-tree-sitter");
  mkdirSync(wtsDst, { recursive: true });
  cpSync(join(wtsSrc, "package.json"), join(wtsDst, "package.json"));
  cpSync(join(wtsSrc, "tree-sitter.wasm"), join(wtsDst, "tree-sitter.wasm"));

  const NEEDED_GRAMMARS = [
    "go", "rust", "java", "c", "cpp", "ruby", "python", "c_sharp", "php",
    "kotlin", "javascript", "tsx", "typescript", "html", "css",
  ];
  const tswSrc = join(REPO_NODE_MODULES, "tree-sitter-wasms");
  const tswDst = join(DIST, "node_modules", "tree-sitter-wasms");
  const tswOutDst = join(tswDst, "out");
  mkdirSync(tswOutDst, { recursive: true });
  cpSync(join(tswSrc, "package.json"), join(tswDst, "package.json"));
  for (const grammar of NEEDED_GRAMMARS) {
    const file = `tree-sitter-${grammar}.wasm`;
    const from = join(tswSrc, "out", file);
    if (!existsSync(from)) {
      throw new Error(`bundle-cli: expected grammar file missing: ${from}`);
    }
    cpSync(from, join(tswOutDst, file));
  }

  process.stdout.write("bundle-cli: done\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`bundle-cli: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
}
