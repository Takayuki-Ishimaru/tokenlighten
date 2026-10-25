// tsxNode.ts — node arguments that run a TypeScript entry point (the dev
// server's src/bin.ts) in ONE process through tsx's loader.
//
// `node <tsx/cli> --liftoff-only src/bin.ts ...` starts two node processes
// per server: the tsx CLI, which only relays signals, and the real server it
// spawns as its own child with `--require tsx/preflight --import tsx` (see
// tsx/dist/cli.mjs). Spawning node with those same flags directly runs the
// same loader in the same server process, minus the wrapper. Measured
// 2026-10-17 on an M4 (spawn → `initialize` answered): ~690 ms → ~590 ms and
// ~0.15 s less CPU per server, and one ~50 MB process fewer per live server.
// About 250 spec files spawn servers, most of them one per test, so the
// wrapper cost a few thousand processes per full run.
//
// `--liftoff-only` is part of the vector, so no call site can drop it
// (testServerMemoryFence.spec.ts): every spawned dev server keeps
// WebAssembly on the baseline compiler.
//
// Spawn sites still pass `detached` and stop servers with killServerGroup():
// a server can start children of its own (language servers, workers), and the
// group kill reaches them too.
//
// tsconfig pin (2026-10-20). Without TSX_TSCONFIG_PATH, tsx uses the first
// tsconfig.json it finds from the server's cwd upward and applies that
// config's `paths` to every import outside node_modules. Most spawn sites set
// no cwd, so the server inherits vitest's: from the repository root (no
// tsconfig.json there) `@tokenlighten/usage` resolved through node_modules to
// packages/usage/dist/index.js, but from packages/mcp-server its tsconfig's
// type-checking map sent it to ../usage/dist/index.d.ts, which tsx loads as
// an empty module. Every spawned server then died on its first import
// ("does not provide an export named 'estimateTokensFromBytes'") and the specs
// failed with "SdkError: Connection closed". The env of a spawn site cannot
// carry the pin: StdioClientTransport passes only a fixed list of variables
// plus the site's own. So the first preload below sets TSX_TSCONFIG_PATH to
// devServer.tsconfig.json before tsx registers: the package's own compiler
// options with `paths` cleared, so workspace packages resolve through
// node_modules to their dist builds (as in-process vitest code and the
// published package resolve them) from any cwd. That is the same channel the
// tsx CLI's `--tsconfig` uses, and like it the variable stays in the server's
// environment; nothing the server starts runs tsx
// (devServerTsconfigPin.spec.ts).
import * as nodeModule from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const nodeRequire = nodeModule.createRequire(import.meta.url);

// Same choice as the tsx CLI: `--import` needs module.register (Node 18.19 /
// 20.6); older runtimes take the loader through `--loader`.
const LOADER_FLAG = typeof (nodeModule as { register?: unknown }).register === "function" ? "--import" : "--loader";

/** The tsconfig every spawned dev server compiles and resolves its source with. */
export const DEV_SERVER_TSCONFIG = fileURLToPath(new URL("./devServer.tsconfig.json", import.meta.url));

export const TSX_NODE_ARGS: readonly string[] = Object.freeze([
  "--require",
  fileURLToPath(new URL("./pinTsxTsconfig.cjs", import.meta.url)),
  "--require",
  nodeRequire.resolve("tsx/preflight"),
  LOADER_FLAG,
  pathToFileURL(nodeRequire.resolve("tsx")).href,
  "--liftoff-only",
]);
