// ---------------------------------------------------------------------------
// A server started without --liftoff-only runs tree-sitter's WebAssembly through
// V8's optimizing compiler. Measured 2026-11-01 on one real first request: peak
// working set 754 MB against 222 MB with the flag. With 28 servers at once, 5 of 56
// died with "Fatal process out of memory: Zone" on a V8 worker thread (exit
// 0x80000003) and calls took 81-117 s; with the flag none of 56 died and calls took
// 21-26 s. `tl mcp start` has always passed it (packages/cli/src/commands/mcp.ts),
// but `node dist/bin.js` and the `tl-mcp` bin did not.
//
// The flag only works on the command line: v8.setFlagsFromString at startup left the
// peak at 752 MB, and NODE_OPTIONS refuses it. So such a start restarts itself with it.
// ---------------------------------------------------------------------------

import { spawn, spawnSync } from "node:child_process";

export const WASM_BASELINE_FLAG = "--liftoff-only";

/**
 * The argv to restart with, or undefined when this process already has the flag or
 * its runtime refuses it. A runtime that does not know a V8 flag exits 9 before
 * running anything, so the flag is probed with the same binary first.
 */
export function wasmBaselineRelaunchArgv(
  execArgv: readonly string[],
  script: string,
  args: readonly string[],
  runtimeAcceptsFlag: () => boolean,
): string[] | undefined {
  if (execArgv.includes(WASM_BASELINE_FLAG)) return undefined;
  if (!runtimeAcceptsFlag()) return undefined;
  return [WASM_BASELINE_FLAG, ...execArgv, script, ...args];
}

function runtimeAcceptsFlag(): boolean {
  const probe = spawnSync(process.execPath, [WASM_BASELINE_FLAG, "--version"], { shell: false, stdio: "ignore", timeout: 3_000 });
  return probe.status === 0;
}

/**
 * Restart this server with the flag, sharing this process's stdio, and end with its
 * exit status. False when no restart is needed or possible: the caller then runs the
 * server here. A child that fails to spawn exits this process with an error rather
 * than running a second server on stdio the host may already be talking to.
 */
export function relaunchWithWasmBaseline(script: string, args: readonly string[]): boolean {
  const argv = wasmBaselineRelaunchArgv(process.execArgv, script, args, runtimeAcceptsFlag);
  if (argv === undefined) return false;
  const child = spawn(process.execPath, argv, { stdio: "inherit", windowsHide: true });
  const forwarded: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of forwarded) {
    process.on(signal, () => {
      child.kill(signal);
    });
  }
  child.on("error", (err) => {
    process.stderr.write(`[tl-mcp] fatal: could not restart with ${WASM_BASELINE_FLAG}: ${err.message}\n`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    process.exit(code ?? (signal === null ? 1 : 128));
  });
  return true;
}
