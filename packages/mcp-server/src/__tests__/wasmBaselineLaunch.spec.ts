/**
 * A server started directly restarts itself once with --liftoff-only, because the
 * flag only works on the command line. See util/wasmBaselineLaunch.ts.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { WASM_BASELINE_FLAG, wasmBaselineRelaunchArgv } from "../util/wasmBaselineLaunch.js";
import { TSX_NODE_ARGS } from "./helpers/tsxNode.js";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("wasmBaselineRelaunchArgv", () => {
  it("restarts a process without the flag, keeping its node options and arguments in order", () => {
    expect(wasmBaselineRelaunchArgv(["--trace-warnings"], "bin.js", ["/ws", "--allow-write"], () => true))
      .toEqual([WASM_BASELINE_FLAG, "--trace-warnings", "bin.js", "/ws", "--allow-write"]);
  });

  it("does not restart a process that has the flag, so a restart cannot repeat", () => {
    let probed = false;
    const argv = wasmBaselineRelaunchArgv([WASM_BASELINE_FLAG], "bin.js", [], () => {
      probed = true;
      return true;
    });
    expect(argv).toBeUndefined();
    expect(probed).toBe(false);
  });

  it("runs in place on a runtime that refuses the flag", () => {
    expect(wasmBaselineRelaunchArgv([], "bin.js", [], () => false)).toBeUndefined();
  });
});

describe("relaunchWithWasmBaseline, end to end", () => {
  const created: string[] = [];
  afterAll(() => {
    for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
  });
  // A plain script stands in for the server: importing the transpiled module needs no build.
  const script = (body: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-wasm-baseline-"));
    created.push(dir);
    const file = path.join(dir, "entry.mjs");
    const helper = pathToFileURL(path.join(here, "..", "util", "wasmBaselineLaunch.ts")).href;
    fs.writeFileSync(file, `import { relaunchWithWasmBaseline } from ${JSON.stringify(helper)};\n${body}\n`);
    return file;
  };
  // Node 20 has no native type stripping. Use the shared source loader, but
  // omit its baseline flag so this fixture must actually restart itself.
  const sourceLoaderArgs = TSX_NODE_ARGS.filter(arg => arg !== WASM_BASELINE_FLAG);
  const run = (file: string, args: string[] = []) => spawnSync(process.execPath, ["--no-warnings", ...sourceLoaderArgs, file, ...args], {
    encoding: "utf8",
    input: "from-host\n",
    timeout: 60_000,
  });

  it("the restarted process has the flag, shares stdio, keeps its arguments and hands back its exit code", () => {
    const file = script(`
      if (!relaunchWithWasmBaseline(process.argv[1], process.argv.slice(2))) {
        const input = (await import("node:fs")).readFileSync(0, "utf8");
        process.stdout.write(JSON.stringify({ flag: process.execArgv.includes(${JSON.stringify(WASM_BASELINE_FLAG)}), args: process.argv.slice(2), input, pid: process.pid }));
        process.exit(7);
      }`);
    const result = run(file, ["/ws", "--allow-write"]);
    expect(result.stderr).toBe("");
    const restarted = JSON.parse(result.stdout);
    expect(restarted).toEqual({ flag: true, args: ["/ws", "--allow-write"], input: "from-host\n", pid: expect.any(Number) });
    expect(restarted.pid).not.toBe(result.pid);
    expect(result.status).toBe(7);
  }, 90_000);
});

describe("bin.ts", () => {
  it("decides on the restart before importing the server's modules", () => {
    const text = fs.readFileSync(path.join(here, "..", "bin.ts"), "utf8");
    expect(text).not.toMatch(/^import .*from "\.\/server\.js"/m);
    expect(text.indexOf("relaunchWithWasmBaseline(process.argv[1]")).toBeLessThan(text.indexOf('const { run } = await import("./server.js")'));
  });
});
