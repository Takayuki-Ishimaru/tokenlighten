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
//    @zip.js/zip.js, @libpdf/core, smol-toml: all
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
import { createHash } from "node:crypto";
import { copyOnnxRuntimeLegalFiles } from "../../../scripts/onnxruntime-licenses.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = join(__dirname, "..");
const REPO_ROOT = join(__dirname, "..", "..", "..");
const DEFAULT_DIST = join(EXT_ROOT, "dist");
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
async function bundleSiblingPackage({ name, srcEntry, outBasename, plugins = [], subpaths = {}, outDir }) {
  const pkgRoot = join(outDir, "node_modules", ...name.split("/"));
  const pkgDist = join(pkgRoot, "dist");
  mkdirSync(pkgDist, { recursive: true });
  const outfile = join(pkgDist, outBasename);

  await build({
    ...commonOpts,
    entryPoints: [srcEntry],
    outfile,
    plugins,
  });
  const exports = { ".": { default: `./dist/${outBasename}` }, "./package.json": "./package.json" };
  for (const [subpath, source] of Object.entries(subpaths)) {
    const basename = `${subpath}.js`;
    await build({ ...commonOpts, entryPoints: [source], outfile: join(pkgDist, basename) });
    exports[`./${subpath}`] = { default: `./dist/${basename}` };
  }

  const realPkgDir = join(REPO_ROOT, "packages", name.replace("@tokenlighten/", ""));
  writeFileSync(
    join(pkgRoot, "package.json"),
    JSON.stringify(
      {
        name,
        version: pkgVersion(realPkgDir),
        type: "commonjs",
        main: `dist/${outBasename}`,
        exports,
      },
      null,
      2,
    ) + "\n",
  );
  return { pkgRoot, pkgDist, outfile };
}

/** Preserve upstream licensing alongside a runtime-only copy of a dependency. */
function copyRuntimePackage(source, destination, members, packageJson = undefined) {
  mkdirSync(destination, { recursive: true });
  for (const member of members) {
    const path = join(source, member);
    if (!existsSync(path)) throw new Error(`bundle-cli: required runtime asset missing: ${path}`);
    cpSync(path, join(destination, member), { recursive: true });
  }
  for (const member of ["LICENSE", "LICENSE.txt", "LICENSE.md", "NOTICE", "NOTICE.txt", "ThirdPartyNotices.txt", "README.md"]) {
    if (existsSync(join(source, member))) cpSync(join(source, member), join(destination, member));
  }
  const manifest = packageJson ?? readJson(join(source, "package.json"));
  writeFileSync(join(destination, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  copyOnnxRuntimeLegalFiles(`${manifest.name}@${manifest.version}`, destination);
}

/**
 * Text inference only: no Sharp/libvips or host-specific image packages enter
 * a universal VSIX/install archive. The default is portable CPU WASM; the
 * explicit native option adds available official bindings and retains WASM
 * fallback (notably for macOS x64, which ONNX Runtime 1.30 no longer ships).
 */
async function bundleSemanticRuntime(outDir, nativeSemanticRuntime = false) {
  const nodeModules = join(outDir, "node_modules");
  const transformersSource = join(REPO_NODE_MODULES, "@huggingface", "transformers");
  const transformersRoot = join(nodeModules, "@huggingface", "transformers");
  const upstreamEntry = join(transformersSource, "dist", "transformers.node.mjs");
  if (!existsSync(upstreamEntry)) throw new Error("bundle-cli: optional @huggingface/transformers must be installed to package semantic search");
  const modificationNotice = "TokenLighten text-only distribution of Transformers.js.\n"
    + "Changes: Sharp image backend replaced with null; feature extraction uses text only.\n"
    + (nativeSemanticRuntime
      ? "ONNX backend selects the official native CPU runtime when a platform binding exists, otherwise the official locally packaged CPU WASM runtime.\n"
      : "ONNX backend uses the official locally packaged portable CPU WASM runtime. Native binaries are not included.\n")
    + "Tensor constructors use the selected runtime. WASM binaries load from this package tree without CDN requests.\n"
    + "Dependency metadata lists the packaged runtime closure; model weights are not included.\n";
  const upstreamPackage = readJson(join(transformersSource, "package.json"));
  copyRuntimePackage(transformersSource, transformersRoot, ["LICENSE"], {
    ...upstreamPackage,
    main: "./dist/transformers.node.mjs",
    exports: { ".": { default: "./dist/transformers.node.mjs" } },
    dependencies: {
      ...(nativeSemanticRuntime ? { "onnxruntime-node": upstreamPackage.dependencies["onnxruntime-node"] } : {}),
      "onnxruntime-web": upstreamPackage.dependencies["onnxruntime-web"],
    },
    scripts: {},
    tokenlightenModification: {
      textOnly: true,
      nativeSemanticRuntime,
      notice: "MODIFICATIONS.txt",
      upstreamEntrySha256: createHash("sha256").update(readFileSync(upstreamEntry)).digest("hex"),
    },
  });
  mkdirSync(join(transformersRoot, "dist"), { recursive: true });
  writeFileSync(join(transformersRoot, "MODIFICATIONS.txt"), modificationNotice);
  await build({
    bundle: true, platform: "node", target: "node20", format: "esm", minify: true,
    sourcemap: false, logLevel: "info", entryPoints: [upstreamEntry],
    outfile: join(transformersRoot, "dist", "transformers.node.mjs"),
    banner: { js: "/* Modified by TokenLighten: text-only Transformers.js with local native/WASM CPU inference. See ../MODIFICATIONS.txt and ../LICENSE. */" },
    plugins: [{
      name: "tokenlighten-transformers-text-only",
      setup(context) {
        context.onResolve({ filter: /^sharp$/ }, () => ({ path: "sharp-disabled", namespace: "tokenlighten-text-only" }));
        context.onLoad({ filter: /.*/, namespace: "tokenlighten-text-only" }, () => ({ contents: "export default null;", loader: "js" }));
        context.onLoad({ filter: /transformers\.node\.mjs$/ }, args => {
          if (args.path !== upstreamEntry) return undefined;
          let contents = readFileSync(args.path, "utf8");
          const nativeImport = 'var onnx_node_default = requireFromHere("onnxruntime-node");';
          const tensorImport = 'import { Tensor } from "onnxruntime-common";';
          const imageGuard = 'throw new Error("Unable to load image processing library.");';
          if (!contents.includes(nativeImport) || !contents.includes(tensorImport) || !contents.includes(imageGuard)) throw new Error("bundle-cli: Transformers text-only adaptation drifted");
          const nativeSelection = nativeSemanticRuntime
            ? `var nativePackageRoot = path.dirname(requireFromHere.resolve("onnxruntime-node/package.json"));
var nativeBinding = path.join(nativePackageRoot, "bin", "napi-v6", process.platform, process.arch, "onnxruntime_binding.node");
var nativeAvailable = fs.existsSync(nativeBinding);`
            : "var nativeAvailable = false;";
          contents = contents.replace(nativeImport, `${nativeSelection}
var onnx_node_default = nativeAvailable ? requireFromHere("onnxruntime-node") : requireFromHere("onnxruntime-web");
if (!nativeAvailable) {
  env.useWasmCache = false;
  var wasmRoot = path.dirname(requireFromHere.resolve("onnxruntime-web"));
  onnx_node_default.env.wasm.wasmPaths = {
    mjs: url.pathToFileURL(path.join(wasmRoot, "ort-wasm-simd-threaded.mjs")).href,
    wasm: url.pathToFileURL(path.join(wasmRoot, "ort-wasm-simd-threaded.wasm")).href
  };
  onnx_node_default.env.wasm.numThreads = 1;
}`);
          contents = contents.replace(tensorImport, "var Tensor = onnx_node_default.Tensor;");
          contents = contents.replace(imageGuard, 'loadImageFunction = async () => { throw new Error("Image processing is unavailable in the TokenLighten text-only runtime."); };');
          return { contents, loader: "js", resolveDir: dirname(upstreamEntry) };
        });
      },
    }],
  });

  if (nativeSemanticRuntime) {
    const nativeSource = join(REPO_NODE_MODULES, "onnxruntime-node");
    const nativeManifest = readJson(join(nativeSource, "package.json"));
    copyRuntimePackage(nativeSource, join(nodeModules, "onnxruntime-node"), ["dist", "bin"], {
      ...nativeManifest, scripts: {}, dependencies: { "onnxruntime-common": nativeManifest.dependencies["onnxruntime-common"] },
    });
    copyRuntimePackage(join(REPO_NODE_MODULES, "onnxruntime-common"), join(nodeModules, "onnxruntime-common"), ["dist"]);
  }
  const webSource = join(REPO_NODE_MODULES, "onnxruntime-web");
  const webManifest = readJson(join(webSource, "package.json"));
  const webRoot = join(nodeModules, "onnxruntime-web");
  copyRuntimePackage(webSource, webRoot, [], {
    ...webManifest, scripts: {}, main: "dist/ort.node.min.js",
    exports: { ".": { default: "./dist/ort.node.min.js" } },
    dependencies: { "onnxruntime-common": webManifest.dependencies["onnxruntime-common"] },
  });
  mkdirSync(join(webRoot, "dist"), { recursive: true });
  for (const asset of ["ort.node.min.js", "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"]) {
    cpSync(join(webSource, "dist", asset), join(webRoot, "dist", asset));
  }
  const webCommonSource = join(webSource, "node_modules", "onnxruntime-common");
  const commonSource = existsSync(webCommonSource) ? webCommonSource : join(REPO_NODE_MODULES, "onnxruntime-common");
  copyRuntimePackage(commonSource, join(webRoot, "node_modules", "onnxruntime-common"), ["dist"]);

  // The typed-symbol worker resolves the compiler and its standard libraries
  // at runtime, independently of every esbuild entry above.
  copyRuntimePackage(join(REPO_NODE_MODULES, "typescript"), join(nodeModules, "typescript"), ["lib", "bin"]);
}

/**
 * Build a zero-install copy of the TokenLighten CLI (and the MCP server it
 * spawns) into `outDir` (default: this package's own `dist/`). Exported so
 * other build tooling (e.g. scripts/build-install-bundle.mjs) can produce
 * the same tree at an arbitrary location without re-running this file as a
 * subprocess.
 */
export async function bundleCli({ outDir = DEFAULT_DIST, nativeSemanticRuntime = false } = {}) {
  // Start clean so stale grammar files / shims never survive a rename.
  rmSync(join(outDir, "tl-cli.js"), { force: true });
  rmSync(join(outDir, "tl-cli.js.map"), { force: true });
  rmSync(join(outDir, "node_modules"), { recursive: true, force: true });

  // 1. @tokenlighten/cli itself — the thin orchestrator the extension spawns.
  await build({
    ...commonOpts,
    entryPoints: [join(REPO_ROOT, "packages/cli/src/index.ts")],
    outfile: join(outDir, "tl-cli.js"),
    external: ["@tokenlighten/agents-md"],
  });
  // version.ts / help.ts read their own version via
  // require.resolve("@tokenlighten/cli/package.json") (not a hardcoded
  // "../.." from their own compiled location, which breaks once bundled) —
  // copy the real, unmodified package.json (it already exports
  // "./package.json") so that resolves from tl-cli.js's own location too.
  const cliShimDir = join(outDir, "node_modules", "@tokenlighten", "cli");
  mkdirSync(cliShimDir, { recursive: true });
  cpSync(
    join(REPO_ROOT, "packages/cli/package.json"),
    join(cliShimDir, "package.json"),
  );

  // 2. @tokenlighten/mcp-server — resolved+spawned as a child process by
  //    `tl mcp start` (commands/mcp.ts's resolveMcpBin). This is the actual
  //    MCP stdio server backing tl_read_file/tl_edit_file/tl_search_files.
  const { pkgDist: mcpServerDist } = await bundleSiblingPackage({
    name: "@tokenlighten/mcp-server",
    srcEntry: join(REPO_ROOT, "packages/mcp-server/src/bin.ts"),
    outBasename: "bin.js",
    plugins: [publicCore2ExclusionPlugin],
    subpaths: {
      engines: join(REPO_ROOT, "packages/mcp-server/src/features/engines/config.ts"),
      "semantic-search": join(REPO_ROOT, "packages/mcp-server/src/features/semantic-search/index.ts"),
      "typed-symbols": join(REPO_ROOT, "packages/mcp-server/src/features/typed-symbols/index.ts"),
    },
    outDir,
  });
  await bundleSemanticRuntime(outDir, nativeSemanticRuntime);

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
    outDir,
  });

  // 4. @tokenlighten/agents-md — lazy dynamic-imported by `tl agents-md
  //    write` (both --for-target and plain). Needs its templates/ dir
  //    (read relative to its own compiled location) copied alongside.
  const { pkgRoot: agentsMdRoot } = await bundleSiblingPackage({
    name: "@tokenlighten/agents-md",
    srcEntry: join(REPO_ROOT, "packages/agents-md/src/index.ts"),
    outBasename: "index.js",
    outDir,
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
    join(outDir, "THIRD_PARTY_NOTICES.md"),
  );
  cpSync(join(REPO_ROOT, "MODEL_LICENSES.json"), join(outDir, "MODEL_LICENSES.json"));

  // 5. web-tree-sitter + tree-sitter-wasms — mcp-server's public
  //    tree-sitter code (packages/mcp-server/src/skeleton/treeSitter.ts)
  //    resolves these via a real `require.resolve("<pkg>/package.json")`
  //    disk lookup at runtime, independent of whatever esbuild inlined, so
  //    both need a real, unmodified package.json plus the actual .wasm
  //    bytes on disk. Only the 15 grammar files treeSitter.ts's GRAMMARS
  //    map can ever request are copied (of the 36 tree-sitter-wasms ships)
  //    to avoid dragging in ~30MB of unused grammars.
  const wtsSrc = join(REPO_NODE_MODULES, "web-tree-sitter");
  const wtsDst = join(outDir, "node_modules", "web-tree-sitter");
  mkdirSync(wtsDst, { recursive: true });
  cpSync(join(wtsSrc, "package.json"), join(wtsDst, "package.json"));
  cpSync(join(wtsSrc, "tree-sitter.wasm"), join(wtsDst, "tree-sitter.wasm"));

  const NEEDED_GRAMMARS = [
    "go", "rust", "java", "c", "cpp", "ruby", "python", "c_sharp", "php",
    "kotlin", "javascript", "tsx", "typescript", "html", "css",
  ];
  const tswSrc = join(REPO_NODE_MODULES, "tree-sitter-wasms");
  const tswDst = join(outDir, "node_modules", "tree-sitter-wasms");
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

/** Parse `--out <dir>` for direct-run invocation. */
function parseCliArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") {
      const value = argv[i + 1];
      if (!value) throw new Error("bundle-cli: --out requires a value");
      options.outDir = resolve(value);
      i += 1;
    } else if (argv[i] === "--native-semantic-runtime") {
      options.nativeSemanticRuntime = true;
    }
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseCliArgs(process.argv.slice(2));
  bundleCli(options).catch((err) => {
    process.stderr.write(`bundle-cli: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
}
