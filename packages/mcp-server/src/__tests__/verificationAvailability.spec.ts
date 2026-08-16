/**
 * verificationAvailability.spec.ts — IMPROVEMENT D: honest verification-path
 * signal. The pack stats the served surfaces' ACTUAL toolchain and emits a
 * machine-readable verdict: runnable => the exact command; not runnable
 * (dependencies not installed) => an explicit "do not install" verdict, so an
 * agent does not burn turns installing a toolchain the checkout never had.
 *
 * The human-facing verify[] hints are intentionally UNCHANGED (additive field).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildTaskPack } from "../tools/readCodeTaskPack.js";
import { handleTable } from "../util/handles.js";
import { resetPackServeLogForTest } from "../util/packServeLog.js";
import { setToolchainPathLookupForTest, resetVerificationKitDedupeForTest } from "../util/verificationPack.js";

function mkWs(tag: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `tl-verify-${tag}-`)));
}
function write(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}
function mkdir(dir: string, rel: string): void {
  fs.mkdirSync(path.join(dir, rel), { recursive: true });
}

describe("buildTaskPack — IMPROVEMENT D: verification runnability verdict", () => {
  beforeEach(() => {
    handleTable.reset();
    resetPackServeLogForTest();
    resetVerificationKitDedupeForTest();
  });

  it("node project WITHOUT node_modules => available:false, dependencies not installed", async () => {
    const ws = mkWs("node-noinstall");
    write(ws, "package.json", JSON.stringify({ name: "app", scripts: { test: "vitest run" } }));
    write(ws, "src/a.ts", "export const a = 1;\n");
    const res = await buildTaskPack({ paths: [{ path: "src/a.ts" }] }, ws);
    expect(res.verification).toBeDefined();
    expect(res.verification!.available).toBe(false);
    expect(res.verification!.reason).toBe("dependencies not installed");
    expect(res.verification!.suggestion).toMatch(/do not install dependencies/);
    // The human-facing verify hints are still emitted (unchanged behavior).
    expect((res.verify ?? []).some((v) => v.includes("npm test"))).toBe(true);
  }, 30000);

  it("node project WITH node_modules => available:true, exact command", async () => {
    const ws = mkWs("node-install");
    write(ws, "package.json", JSON.stringify({ name: "app", scripts: { test: "vitest run" } }));
    write(ws, "src/a.ts", "export const a = 1;\n");
    mkdir(ws, "node_modules");
    write(ws, "node_modules/.marker", "");
    const res = await buildTaskPack({ paths: [{ path: "src/a.ts" }] }, ws);
    expect(res.verification).toBeDefined();
    expect(res.verification!.available).toBe(true);
    expect(res.verification!.command).toBe("npm test");
  }, 30000);

  it("python project WITHOUT an installed runner => available:false", async () => {
    const ws = mkWs("py-noinstall");
    write(ws, "pyproject.toml", "[tool.pytest.ini_options]\n");
    write(ws, "app/service.py", "def f():\n    return 1\n");
    const res = await buildTaskPack({ paths: [{ path: "app/service.py" }] }, ws);
    expect(res.verification).toBeDefined();
    expect(res.verification!.available).toBe(false);
    expect(res.verification!.reason).toBe("dependencies not installed");
  }, 30000);

  // K3 (2026-08-01 verify-kit-diet): the edit-time verification KIT
  // (buildVerificationManifest — surfaces/link_set/kit_unchanged/kit_ref) and
  // this pack-time runnability VERDICT (available/command/reason) are two
  // separate mechanisms that happen to share the `verification` response key
  // on different tools. buildTaskPack's plain read path never calls
  // buildVerificationManifest at all, but the module-level kit dedupe cache
  // is shared process-wide, so this pins the verdict shape never grows the
  // kit's fields.
  it("the pack-time availability verdict never carries the edit-time kit's dedupe fields", async () => {
    const ws = mkWs("verdict-no-kit-fields");
    write(ws, "package.json", JSON.stringify({ name: "app", scripts: { test: "vitest run" } }));
    write(ws, "src/a.ts", "export const a = 1;\n");
    mkdir(ws, "node_modules");
    write(ws, "node_modules/.marker", "");

    const res = await buildTaskPack({ paths: [{ path: "src/a.ts" }] }, ws);
    expect(res.verification).toBeDefined();
    expect(res.verification!.available).toBe(true);
    expect(res.verification!.command).toBe("npm test");
    const raw = res.verification as unknown as Record<string, unknown>;
    expect(raw["kit_unchanged"], "the availability verdict must never grow a kit field").toBeUndefined();
    expect(raw["kit_ref"]).toBeUndefined();
  }, 30000);
});

/**
 * 2026-07-30 forensics: a C++ fix task was told verification was UNAVAILABLE
 * with clang++ on PATH, and another was handed `test_entry:"npm test"` for a
 * firmware harness — both because the pack-time verdict only knew npm/pytest
 * and an ancestor directory happened to hold an unrelated package.json. The
 * verdict now asks the surface set's OWN toolchain, through the same injectable
 * host probe the edit-time manifest uses.
 */
describe("buildTaskPack — native surface sets never get an npm-domain verdict", () => {
  beforeEach(() => {
    handleTable.reset();
    resetPackServeLogForTest();
    resetVerificationKitDedupeForTest();
  });

  afterEach(() => setToolchainPathLookupForTest(undefined));

  /** A native fixture nested under a package.json that has nothing to do with it. */
  function mkNativeWs(tag: string): string {
    const ws = mkWs(tag);
    write(ws, "package.json", JSON.stringify({ name: "host", scripts: { test: "vitest run" } }));
    mkdir(ws, "node_modules");
    write(ws, "node_modules/.marker", "");
    write(ws, "fw/include/control/mixer.hpp", "#pragma once\nvoid mix(float* out);\n");
    write(ws, "fw/src/control/mixer.cpp", '#include "control/mixer.hpp"\nvoid mix(float* out) { out[0] = 0.0f; }\n');
    return ws;
  }

  it("compiler on PATH => available:true naming the compiler, never npm test", async () => {
    const ws = mkNativeWs("native-cxx");
    setToolchainPathLookupForTest((candidates) => (candidates.includes("clang++") ? "clang++" : undefined));
    const res = await buildTaskPack({ paths: [{ path: "fw/src/control/mixer.cpp" }] }, ws);
    expect(res.verification, JSON.stringify(res.verify)).toBeDefined();
    expect(res.verification!.available).toBe(true);
    expect(res.verification!.command).toContain("clang++");
    expect(res.verification!.command).toContain("no project build system detected");
    expect(res.verification!.command).not.toContain("npm");
  }, 30000);

  it("no compiler on PATH => available:false naming the missing toolchain, never 'dependencies not installed' via npm", async () => {
    const ws = mkNativeWs("native-nocxx");
    setToolchainPathLookupForTest(() => undefined);
    const res = await buildTaskPack({ paths: [{ path: "fw/src/control/mixer.cpp" }] }, ws);
    expect(res.verification, JSON.stringify(res.verify)).toBeDefined();
    expect(res.verification!.available).toBe(false);
    expect(res.verification!.reason).toBe("no C/C++ toolchain found");
    expect(res.verification!.suggestion).toMatch(/do not install dependencies/);
    expect(JSON.stringify(res.verification)).not.toContain("npm");
  }, 30000);

  it("names the project build system when the native tree actually has one", async () => {
    const ws = mkNativeWs("native-cmake");
    write(ws, "fw/CMakeLists.txt", "# firmware build\n");
    setToolchainPathLookupForTest((candidates) => (candidates.includes("g++") ? "g++" : undefined));
    const res = await buildTaskPack({ paths: [{ path: "fw/src/control/mixer.cpp" }] }, ws);
    expect(res.verification!.available).toBe(true);
    expect(res.verification!.command).toContain("fw/CMakeLists.txt");
  }, 30000);
});
