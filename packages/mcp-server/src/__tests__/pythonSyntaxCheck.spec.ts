/**
 * pythonSyntaxCheck.spec.ts — the interpreter a Python edit's checks need
 * (util/pythonInterpreter.ts, verificationPack.ts pythonSyntaxCheck), and
 * where it rides: the edit kit's harness.syntax_check and the first pack's
 * verify (2026-10-20, decision window 6t-7, T10 arm A: python3 was the Xcode
 * shim's 3.9.6 against requires-python >=3.10, and every cell spent 4-7 Bash
 * turns finding /opt/homebrew/bin/python3.12).
 *
 * Every choice here runs through the PATH/probe seam
 * (setPythonInterpreterSeamForTest), so nothing depends on this host's
 * interpreters. The POSIX-only cases start real fake-interpreter scripts
 * outside (and, for the never-run checks, inside) the workspace to pin the
 * real process path: the 2 s timeout, the `-E -c` argv, the os.tmpdir() cwd.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildVerificationManifest,
  KIT_NOTE_MAX_BYTES,
  pythonSyntaxCheck,
  setToolchainPathLookupForTest,
} from "../util/verificationPack.js";
import {
  importNameOf,
  importedExternalModules,
  parseRequiresPython,
  pythonProjectRoot,
  readPythonRequirements,
  requirementName,
  resetPythonProbeCacheForTest,
  setPythonInterpreterSeamForTest,
  versionSatisfies,
} from "../util/pythonInterpreter.js";
import { buildTaskPack, resetPackDedupeCache, resetRoleInventoryCache } from "../tools/readCodeTaskPack.js";
import { handleTable } from "../util/handles.js";
import { resetPackServeLogForTest } from "../util/packServeLog.js";

const tmpDirs: string[] = [];

function mkWorkspace(tag: string): string {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `tl-pysc-${tag}-`)));
  tmpDirs.push(ws);
  return ws;
}

function write(root: string, rel: string, content: string, mode?: number): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  if (mode !== undefined) fs.chmodSync(abs, mode);
}

/** The T10 project's shape: requires-python >=3.10 and declared dependencies. */
function project(ws: string, deps: readonly string[], requires = ">=3.10"): void {
  write(ws, "svc/pyproject.toml", [
    "[build-system]",
    'requires = ["setuptools>=68"]',
    "",
    "[project]",
    'name = "svc"',
    `requires-python = "${requires}"`,
    "dependencies = [",
    ...deps.map((dep) => `    "${dep}",`),
    "]",
    "",
    "[project.optional-dependencies]",
    'dev = ["pytest>=7.0"]',
    "",
  ].join("\n"));
  write(ws, "svc/svc_pkg/__init__.py", "");
}

/** Where the fake interpreters "live": never created, outside every workspace. */
const FAKE_BIN = path.resolve(os.tmpdir(), "tl-pysc-fake-host", "bin");
const fakeBin = (name: string): string => path.join(FAKE_BIN, name);

interface FakePython {
  version?: string;
  modules?: readonly string[];
  /** "timeout" = the probe never answered; "status" = it exited non-zero; "garbage" = no tlprobe line. */
  fail?: "timeout" | "status" | "garbage";
  /** Where `locate` says it is, when not FAKE_BIN. */
  at?: string;
}

/** Pin the PATH lookup and the probe to `bins`; returns every probe run's binary. */
function fakeHost(bins: Record<string, FakePython>, aliases: Record<string, string> = {}): string[] {
  const runs: string[] = [];
  setPythonInterpreterSeamForTest({
    locate: (name) => (bins[name] === undefined ? undefined : bins[name]!.at ?? fakeBin(name)),
    run: (bin, args) => {
      runs.push(bin);
      const fake = Object.entries(bins).find(([name, entry]) => (entry.at ?? fakeBin(name)) === bin)?.[1];
      if (fake === undefined || fake.fail === "timeout") return undefined;
      if (fake.fail === "status") return { status: 1, stdout: "" };
      if (fake.fail === "garbage") return { status: 0, stdout: `Python ${fake.version}\n` };
      expect(args.slice(0, 2)).toEqual(["-E", "-c"]);
      const asked = args.slice(3);
      return { status: 0, stdout: `tlprobe ${fake.version} ${(fake.modules ?? []).filter((m) => asked.includes(m)).join(" ")}\n` };
    },
    realpath: (file) => aliases[file] ?? file,
  });
  return runs;
}

/** The command word as pythonSyntaxCheck's shellWord writes it on POSIX. */
function word(text: string, platform: NodeJS.Platform = "linux"): string {
  if (/^[A-Za-z0-9_./+=:@%,-]+$/.test(text)) return text;
  return platform === "win32" ? `"${text.replace(/"/g, '\\"')}"` : `'${text.replace(/'/g, "'\\''")}'`;
}

const ECHO = '; echo "exit=$?"';
const XCRUN = "; a \"couldn't create cache file\" line is the macOS xcrun shim's, not a compile error";

afterEach(() => {
  setPythonInterpreterSeamForTest(undefined);
  setToolchainPathLookupForTest(undefined);
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("requires-python", () => {
  const ok = (spec: string, version: string): boolean =>
    versionSatisfies(version.split(".").map(Number), parseRequiresPython(spec)!);

  it("reads >=, >, <, <=, ~=, ==X.Y.*, ==X.Y, != and comma lists the PEP 440 way", () => {
    expect([ok(">=3.10", "3.9.6"), ok(">=3.10", "3.10.0"), ok(">=3.10", "3.12.13")]).toEqual([false, true, true]);
    expect([ok(">3.9", "3.9.0"), ok(">3.9", "3.9.1"), ok(">3.9", "3.10.0")]).toEqual([false, true, true]);
    expect([ok("<3.13", "3.12.9"), ok("<3.13", "3.13.0")]).toEqual([true, false]);
    expect([ok("<=3.12", "3.12.0"), ok("<=3.12", "3.12.1")]).toEqual([true, false]);
    expect([ok("~=3.10", "3.9.9"), ok("~=3.10", "3.10.0"), ok("~=3.10", "3.14.1"), ok("~=3.10", "4.0.0")]).toEqual([false, true, true, false]);
    expect([ok("~=3.10.2", "3.10.1"), ok("~=3.10.2", "3.10.9"), ok("~=3.10.2", "3.11.0")]).toEqual([false, true, false]);
    expect([ok("==3.11.*", "3.11.4"), ok("==3.11.*", "3.12.0")]).toEqual([true, false]);
    expect([ok("==3.11", "3.11.0"), ok("==3.11", "3.11.4")]).toEqual([true, false]);
    expect([ok("!=3.11.*", "3.11.4"), ok("!=3.11.*", "3.12.0"), ok("!=3.11.2", "3.11.2")]).toEqual([false, true, false]);
    expect([ok(">=3.8, <4", "3.12.13"), ok(">=3.8, <4", "4.0.0"), ok(">= 3.10 ,< 3.13", "3.12.1")]).toEqual([true, false, true]);
  });

  it("claims nothing about a constraint it cannot read", () => {
    for (const spec of [">=3.10rc1", "===3.10", "~=3", ">=3.*", "python>=3", "", ","]) {
      expect(parseRequiresPython(spec), spec).toBeUndefined();
    }
  });
});

describe("declared dependencies", () => {
  it("maps distribution names to import names: lowercase, '-' as '_', and the common mismatches", () => {
    const pairs: Array<[string, string]> = [
      ["pyyaml", "yaml"], ["PyYAML", "yaml"], ["python-docx", "docx"], ["beautifulsoup4", "bs4"],
      ["Pillow", "PIL"], ["scikit-learn", "sklearn"], ["python_dateutil", "dateutil"], ["opencv-python", "cv2"],
      ["openpyxl", "openpyxl"], ["Flask", "flask"], ["typing-extensions", "typing_extensions"],
      ["Flask-SQLAlchemy", "flask_sqlalchemy"], ["zope.interface", "zope"],
    ];
    for (const [distribution, module] of pairs) expect(importNameOf(distribution), distribution).toBe(module);
  });

  it("reads a requirement's name through extras, pins, hashes and direct references; a marker drops it", () => {
    expect(requirementName("requests[security]>=2.28")).toBe("requests");
    expect(requirementName("flask==2.3.3 --hash=sha256:abc")).toBe("flask");
    expect(requirementName("name @ https://example.invalid/name-1.0.whl")).toBe("name");
    expect(requirementName("pywin32>=300; sys_platform == 'win32'")).toBeUndefined();
  });

  it("takes requires-python and [project].dependencies from pyproject, plus requirements.txt", () => {
    const ws = mkWorkspace("reqs");
    write(ws, "app/pyproject.toml", [
      "[tool.other]",
      'dependencies = ["not-this"]',
      "[project]",
      'name = "app"',
      "requires-python = '>=3.10, <4'",
      "dependencies = [  # runtime",
      '  "Flask>=2.0",',
      '  "requests[socks]>=2.28",  # the [socks] extra is not a table',
      "  'PyYAML',",
      '  "tomli; python_version < \'3.11\'",',
      "]",
      "[project.optional-dependencies]",
      'dev = ["pytest"]',
    ].join("\n"));
    write(ws, "app/requirements.txt", [
      "# pinned",
      "openpyxl==3.1.2  # xlsx",
      "-r requirements-dev.txt",
      "-e .",
      "git+https://example.invalid/x.git#egg=x",
      "./vendor/local_pkg",
      "python-dateutil>=2.8 \\",
      "    --hash=sha256:abc",
      "",
    ].join("\n"));
    expect(readPythonRequirements(ws, "app")).toEqual({
      requiresPython: ">=3.10,<4",
      clauses: parseRequiresPython(">=3.10,<4"),
      modules: ["dateutil", "flask", "openpyxl", "requests", "yaml"],
    });
  });

  it("falls back to setup.cfg python_requires, and leaves out a requires-python it cannot read", () => {
    const ws = mkWorkspace("setupcfg");
    write(ws, "setup.cfg", "[metadata]\nname = x\n\n[options]\npython_requires = >=3.11\n");
    expect(readPythonRequirements(ws, "")).toEqual({ requiresPython: ">=3.11", clauses: parseRequiresPython(">=3.11"), modules: [] });
    write(ws, "pyproject.toml", '[project]\nrequires-python = ">=3.10rc1"\ndependencies = ["rich"]\n');
    expect(readPythonRequirements(ws, "")).toEqual({ modules: ["rich"] });
  });

  it("finds the nearest project root, a create target's included, and none outside any project", () => {
    const ws = mkWorkspace("root");
    write(ws, "a/pyproject.toml", "[project]\n");
    write(ws, "a/b/requirements.txt", "flask\n");
    write(ws, "a/b/c/mod.py", "");
    write(ws, "loose/tool.py", "");
    expect(pythonProjectRoot(ws, "a/b/c/mod.py")).toBe("a/b");
    expect(pythonProjectRoot(ws, "a/x/new_module.py")).toBe("a");
    expect(pythonProjectRoot(ws, "loose/tool.py")).toBeUndefined();
    expect(pythonProjectRoot(ws, "../escape.py")).toBeUndefined();
  });

  it("follows the edited file's imports through the project's own modules to the external ones", () => {
    const ws = mkWorkspace("closure");
    project(ws, ["openpyxl", "pandas", "flask"]);
    write(ws, "svc/svc_pkg/data/__init__.py", "import json\n");
    write(ws, "svc/svc_pkg/data/tables.py", "import pandas as pd\n");
    write(ws, "svc/svc_pkg/pricing/__init__.py", "");
    write(ws, "svc/svc_pkg/pricing/helpers.py", "from typing import Any\n");
    write(ws, "svc/svc_pkg/pricing/engine.py", [
      "import openpyxl, decimal",
      "from svc_pkg.data import tables",
      "from . import helpers",
      "def lazy():",
      "    import requests  # function-level imports count",
      "# import flask  (a comment does not)",
    ].join("\n"));
    expect([...importedExternalModules(ws, "svc", ["svc/svc_pkg/pricing/engine.py"])].sort())
      .toEqual(["decimal", "json", "openpyxl", "pandas", "requests", "typing"]);
  });
});

describe("pythonSyntaxCheck — the choice", () => {
  const target = "svc/svc_pkg/engine.py";

  it("T10: python3 below requires-python and lacking the module; python3.12 named with why", () => {
    const ws = mkWorkspace("t10");
    project(ws, ["openpyxl>=3.0"]);
    write(ws, target, "import openpyxl\n");
    fakeHost({ python3: { version: "3.9.6" }, "python3.12": { version: "3.12.13", modules: ["openpyxl"] } });
    expect(pythonSyntaxCheck(ws, [target], { platform: "linux" })).toEqual({
      commands: [`${word(fakeBin("python3.12"))} -m py_compile ${target}${ECHO}`],
      note: "python3 is 3.9.6 (requires-python >=3.10) and lacks openpyxl; python3.12 satisfies both; run smoke checks with it from the workspace root",
    });
  });

  it("says nothing when python3 already satisfies the project (byte identity), in the kit too", () => {
    const ws = mkWorkspace("suffices");
    project(ws, ["openpyxl"]);
    write(ws, target, "import openpyxl\n");
    fakeHost({ python3: { version: "3.11.2", modules: ["openpyxl"] }, "python3.12": { version: "3.12.13", modules: ["openpyxl"] } });
    expect(pythonSyntaxCheck(ws, [target], { platform: "linux" })).toBeUndefined();
    expect(buildVerificationManifest(ws, [target], { pythonSyntaxCheck: true })).toEqual(buildVerificationManifest(ws, [target]));
    expect(buildVerificationManifest(ws, [target], { pythonSyntaxCheck: true })).toBeUndefined();
  });

  it("names the first candidate, newest first, that meets requires-python and has every declared module", () => {
    const ws = mkWorkspace("order");
    project(ws, ["rich"], ">=3.10,<3.14");
    write(ws, target, "");
    fakeHost({
      python3: { version: "3.9.6", modules: ["rich"] },
      "python3.14": { version: "3.14.0", modules: ["rich"] },
      "python3.13": { version: "3.13.1" },
      "python3.12": { version: "3.12.13", modules: ["rich"] },
      "python3.11": { version: "3.11.9", modules: ["rich"] },
    });
    const check = pythonSyntaxCheck(ws, [target], { platform: "linux" })!;
    expect(check.commands[0]!.startsWith(`${word(fakeBin("python3.12"))} -m py_compile`), check.commands[0]).toBe(true);
    expect(check.note).toBe("python3 is 3.9.6 (requires-python >=3.10,<3.14); python3.12 satisfies it; run smoke checks with it from the workspace root");
  });

  it("with no interpreter that has every declared module, falls back to the ones the edited code reaches", () => {
    // The T10 host: python3.12 had openpyxl, not flask, pandas or requests.
    const ws = mkWorkspace("tier2");
    project(ws, ["flask", "openpyxl", "pandas", "requests"]);
    write(ws, target, "import openpyxl\n");
    fakeHost({ python3: { version: "3.9.6" }, "python3.12": { version: "3.12.13", modules: ["openpyxl"] } });
    expect(pythonSyntaxCheck(ws, [target], { platform: "linux" })).toEqual({
      commands: [`${word(fakeBin("python3.12"))} -m py_compile ${target}${ECHO}`],
      note: "python3 is 3.9.6 (requires-python >=3.10) and lacks openpyxl; python3.12 satisfies both but lacks flask, pandas, requests; run smoke checks with it from the workspace root",
    });
  });

  it("counts what the edited code reaches through the project's own modules, and a caller's extra module", () => {
    const ws = mkWorkspace("tier2closure");
    project(ws, ["flask", "openpyxl", "pandas"]);
    write(ws, "svc/svc_pkg/tables.py", "import pandas\n");
    write(ws, target, "from .tables import load\n");
    fakeHost({ python3: { version: "3.9.6" }, "python3.12": { version: "3.12.13", modules: ["openpyxl"] } });
    // engine.py reaches pandas through tables.py, and python3.12 lacks it: no claim.
    expect(pythonSyntaxCheck(ws, [target], { platform: "linux" })).toBeUndefined();

    write(ws, target, '"""TODO: implement from the rate table."""\n');
    expect(pythonSyntaxCheck(ws, [target], { platform: "linux" })!.note)
      .toBe("python3 is 3.9.6 (requires-python >=3.10); python3.12 satisfies it but lacks flask, pandas; run smoke checks with it from the workspace root");
    expect(pythonSyntaxCheck(ws, [target], { platform: "linux", extraModules: ["openpyxl"] })!.note)
      .toBe("python3 is 3.9.6 (requires-python >=3.10) and lacks openpyxl; python3.12 satisfies both but lacks flask, pandas; run smoke checks with it from the workspace root");
    // An extra module the project does not declare is not checked.
    expect(pythonSyntaxCheck(ws, [target], { platform: "linux", extraModules: ["docx"] })!.note)
      .toBe("python3 is 3.9.6 (requires-python >=3.10); python3.12 satisfies it but lacks flask, pandas; run smoke checks with it from the workspace root");
  });

  it("says nothing when python3 meets what the edited code reaches, though not every declared module", () => {
    const ws = mkWorkspace("tier2quiet");
    project(ws, ["flask", "openpyxl"]);
    write(ws, target, "import openpyxl\n");
    fakeHost({ python3: { version: "3.11.2", modules: ["openpyxl"] }, "python3.12": { version: "3.12.13", modules: ["openpyxl"] } });
    expect(pythonSyntaxCheck(ws, [target], { platform: "linux" })).toBeUndefined();
  });

  it("makes no claim when no candidate satisfies the project", () => {
    const ws = mkWorkspace("none");
    project(ws, ["openpyxl"]);
    write(ws, target, "import openpyxl\n");
    fakeHost({ python3: { version: "3.9.6" }, "python3.12": { version: "3.12.13" }, "python3.11": { version: "3.11.2" } });
    expect(pythonSyntaxCheck(ws, [target], { platform: "linux" })).toBeUndefined();
  });

  it("with nothing declared, python3 on PATH answers for itself unprobed; without one, the first candidate that runs", () => {
    const ws = mkWorkspace("undeclared");
    write(ws, "tools/requirements.txt", "# nothing yet\n");
    write(ws, "tools/gen.py", "print(1)\n");
    const runs = fakeHost({ python3: { version: "3.9.6" }, "python3.12": { version: "3.12.13" } });
    expect(pythonSyntaxCheck(ws, ["tools/gen.py"], { platform: "linux" })).toBeUndefined();
    expect(runs).toEqual([]);

    fakeHost({ "python3.11": { version: "3.11.9" } });
    expect(pythonSyntaxCheck(ws, ["tools/gen.py"], { platform: "linux" })).toEqual({
      commands: [`${word(fakeBin("python3.11"))} -m py_compile tools/gen.py${ECHO}`],
      note: "no python3 on PATH; python3.11 runs; run smoke checks with it from the workspace root",
    });
  });

  it("covers the first file's project only, at most maxUnits files; the rest are listed unchecked", () => {
    const ws = mkWorkspace("units");
    project(ws, ["openpyxl"]);
    write(ws, "other/pyproject.toml", '[project]\nrequires-python = ">=3.12"\n');
    write(ws, "other/x.py", "");
    const files = Array.from({ length: 4 }, (_, i) => `svc/svc_pkg/m${i}.py`);
    for (const rel of files) write(ws, rel, "");
    fakeHost({ python3: { version: "3.9.6" }, "python3.12": { version: "3.12.13", modules: ["openpyxl"] } });
    const check = pythonSyntaxCheck(ws, [...files, "other/x.py", "svc/svc_pkg/gone.py", "svc/README.md"], { platform: "linux", maxUnits: 3 })!;
    expect(check.commands[0]).toBe(`${word(fakeBin("python3.12"))} -m py_compile ${files.slice(0, 3).join(" ")}${ECHO}`);
    expect(check.unchecked).toEqual([files[3], "other/x.py"]);
  });

  it("adds the xcrun clause on darwin within the kit note budget, and drops the exit echo on win32", () => {
    const ws = mkWorkspace("platforms");
    project(ws, ["openpyxl"]);
    write(ws, target, "import openpyxl\n");
    fakeHost({ python3: { version: "3.9.6" }, "python3.12": { version: "3.12.13", modules: ["openpyxl"] } });
    const darwin = pythonSyntaxCheck(ws, [target], { platform: "darwin" })!;
    expect(darwin.note.endsWith(XCRUN), darwin.note).toBe(true);
    expect(darwin.note.startsWith("python3 is 3.9.6 (requires-python >=3.10) and lacks openpyxl; python3.12 satisfies both; ")).toBe(true);
    expect(Buffer.byteLength(darwin.note, "utf8")).toBeLessThanOrEqual(KIT_NOTE_MAX_BYTES);
    const win32 = pythonSyntaxCheck(ws, [target], { platform: "win32" })!;
    expect(win32.commands[0]!.endsWith(`py_compile ${target}`), win32.commands[0]).toBe(true);
    expect(win32.note).not.toContain("xcrun");
  });

  it("degrades the note to fit the kit budget when lists and constraints run long", () => {
    const ws = mkWorkspace("budget");
    const deps = ["alpha_mod", "bravo_mod", "charlie_mod", "delta_mod", "echo_mod", "foxtrot_mod", "golf_mod", "hotel_mod"];
    project(ws, deps, ">=3.10.4,<3.14,!=3.11.2,!=3.11.3,!=3.12.0");
    write(ws, target, deps.slice(0, 5).map((dep) => `import ${dep}`).join("\n"));
    fakeHost({ python3: { version: "3.9.6" }, "python3.12": { version: "3.12.13", modules: deps.slice(0, 5) } });
    const note = pythonSyntaxCheck(ws, [target], { platform: "darwin" })!.note;
    expect(Buffer.byteLength(note, "utf8"), note).toBeLessThanOrEqual(KIT_NOTE_MAX_BYTES);
    expect(note).toContain("python3.12");
    expect(note).toContain("run smoke checks with it");
    expect(note.endsWith(XCRUN)).toBe(true);
  });
});

describe("pythonSyntaxCheck — probes", () => {
  const target = "svc/svc_pkg/engine.py";

  function t10(tag: string): string {
    const ws = mkWorkspace(tag);
    project(ws, ["openpyxl"]);
    write(ws, target, "import openpyxl\n");
    return ws;
  }

  it("probes each resolved interpreter at most once per process", () => {
    const ws = t10("cache");
    const runs = fakeHost({ python3: { version: "3.9.6" }, "python3.13": { version: "3.13.1" }, "python3.12": { version: "3.12.13", modules: ["openpyxl"] } });
    const first = pythonSyntaxCheck(ws, [target], { platform: "linux" });
    const second = pythonSyntaxCheck(ws, [target], { platform: "linux" });
    expect(buildVerificationManifest(ws, [target], { pythonSyntaxCheck: true })?.harness?.syntax_check).toEqual(pythonSyntaxCheck(ws, [target]));
    expect(second).toEqual(first);
    expect(runs).toEqual([fakeBin("python3"), fakeBin("python3.13"), fakeBin("python3.12")]);

    resetPythonProbeCacheForTest();
    pythonSyntaxCheck(ws, [target], { platform: "linux" });
    expect(runs).toHaveLength(6);
  });

  it("shares one probe between names that resolve to the same file", () => {
    const ws = t10("alias");
    const real = path.resolve(FAKE_BIN, "..", "Cellar", "python3.12");
    const runs = fakeHost(
      { python3: { version: "3.12.13", modules: [] }, "python3.12": { version: "3.12.13", modules: [] }, "python3.11": { version: "3.11.9", modules: ["openpyxl"] } },
      { [fakeBin("python3")]: real, [fakeBin("python3.12")]: real },
    );
    const check = pythonSyntaxCheck(ws, [target], { platform: "linux" })!;
    expect(check.note).toBe("python3 lacks openpyxl; python3.11 has it; run smoke checks with it from the workspace root");
    expect(runs).toEqual([fakeBin("python3"), fakeBin("python3.11")]);
  });

  it("a failed or timed-out probe makes no claim", () => {
    const ws = t10("failed");
    for (const fail of ["timeout", "status", "garbage"] as const) {
      fakeHost({ python3: { version: "3.9.6", fail }, "python3.12": { version: "3.12.13", modules: ["openpyxl"] } });
      // Nothing about python3: the note starts at the interpreter that answered.
      expect(pythonSyntaxCheck(ws, [target], { platform: "linux" })!.note, fail)
        .toBe("python3.12 meets requires-python >=3.10 and has every declared module; run smoke checks with it from the workspace root");
      fakeHost({ python3: { version: "3.9.6" }, "python3.12": { version: "3.12.13", modules: ["openpyxl"], fail } });
      expect(pythonSyntaxCheck(ws, [target], { platform: "linux" }), fail).toBeUndefined();
    }
  });

  it("stays quiet when a test pinned the toolchain lookup without pinning the probe", () => {
    const ws = t10("pinned");
    setToolchainPathLookupForTest((candidates) => candidates[0]);
    expect(pythonSyntaxCheck(ws, [target], { platform: "linux" })).toBeUndefined();
  });

  it("never probes an interpreter inside the workspace: an activated venv says nothing, a workspace python3.12 is skipped", () => {
    const ws = t10("wsbin");
    let runs = fakeHost({ python3: { version: "3.9.6", at: path.join(ws, ".venv", "bin", "python3") }, "python3.12": { version: "3.12.13", modules: ["openpyxl"] } });
    expect(pythonSyntaxCheck(ws, [target], { platform: "linux" })).toBeUndefined();
    expect(runs).toEqual([]);

    runs = fakeHost({
      python3: { version: "3.9.6" },
      "python3.13": { version: "3.13.1", modules: ["openpyxl"], at: path.join(ws, "bin", "python3.13") },
      "python3.12": { version: "3.12.13", modules: ["openpyxl"] },
    });
    expect(pythonSyntaxCheck(ws, [target], { platform: "linux" })!.commands[0]!.startsWith(word(fakeBin("python3.12")))).toBe(true);
    expect(runs).toEqual([fakeBin("python3"), fakeBin("python3.12")]);
  });

  it("names a project venv's interpreter as preferred without running it", () => {
    const ws = t10("venv");
    write(ws, "svc/.venv/bin/python", "#!/bin/sh\nexit 3\n", 0o755);
    const runs = fakeHost({ python3: { version: "3.9.6" }, "python3.12": { version: "3.12.13", modules: ["openpyxl"] } });
    expect(pythonSyntaxCheck(ws, [target], { platform: "linux" })).toEqual({
      commands: [`svc/.venv/bin/python -m py_compile ${target}${ECHO}`],
      note: "python3 is 3.9.6 (requires-python >=3.10) and lacks openpyxl; the project's .venv/bin/python is preferred (not probed); run smoke checks with it from the workspace root",
    });
    expect(runs).toEqual([fakeBin("python3")]);
  });

  describe.skipIf(process.platform === "win32")("real processes (POSIX)", () => {
    function fakeDir(tag: string): string {
      const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `tl-pysc-bin-${tag}-`)));
      tmpDirs.push(dir);
      return dir;
    }

    it("runs `-E -c <script> <modules>` from os.tmpdir() and reads the tlprobe line", () => {
      const ws = t10("realrun");
      const dir = fakeDir("run");
      const log = path.join(dir, "argv.log");
      write(dir, "python3", "#!/bin/sh\necho 'tlprobe 3.9.6'\n", 0o755);
      write(dir, "python3.12", `#!/bin/sh\npwd > '${log}'\nprintf '%s\\n' "$@" >> '${log}'\necho 'noise from a sitecustomize'\necho 'tlprobe 3.12.13 openpyxl'\n`, 0o755);
      setPythonInterpreterSeamForTest({ locate: (name) => (fs.existsSync(path.join(dir, name)) ? path.join(dir, name) : undefined) });
      expect(pythonSyntaxCheck(ws, [target], { platform: "linux" })!.commands[0])
        .toBe(`${word(path.join(dir, "python3.12"))} -m py_compile ${target}${ECHO}`);
      const lines = fs.readFileSync(log, "utf8").split("\n");
      expect(fs.realpathSync(lines[0]!)).toBe(fs.realpathSync(os.tmpdir()));
      expect(lines.slice(1, 3)).toEqual(["-E", "-c"]);
      expect(lines.filter((line) => line === "openpyxl")).toHaveLength(1);
    });

    it("gives up on a probe after 2 s and makes no claim; the failure is cached", () => {
      const ws = t10("realtimeout");
      const dir = fakeDir("timeout");
      write(dir, "python3", "#!/bin/sh\nsleep 10\necho 'tlprobe 3.12.13 openpyxl'\n", 0o755);
      setPythonInterpreterSeamForTest({ locate: (name) => (name === "python3" ? path.join(dir, name) : undefined) });
      const started = Date.now();
      expect(pythonSyntaxCheck(ws, [target], { platform: "linux" })).toBeUndefined();
      expect(Date.now() - started).toBeLessThan(6000);
      const again = Date.now();
      expect(pythonSyntaxCheck(ws, [target], { platform: "linux" })).toBeUndefined();
      expect(Date.now() - again).toBeLessThan(1000);
    }, 20000);

    it("never starts a workspace binary: not an activated venv's python3, a workspace python3.12, or the project venv", () => {
      const ws = t10("realws");
      const marker = path.join(fakeDir("marker"), "ran");
      const planted = `#!/bin/sh\necho "$0" >> '${marker}'\necho 'tlprobe 3.12.13 openpyxl'\n`;
      write(ws, ".venv/bin/python3", planted, 0o755);
      write(ws, "bin/python3.12", planted, 0o755);
      write(ws, "svc/.venv/bin/python", planted, 0o755);
      const outside = fakeDir("outside");
      write(outside, "python3", "#!/bin/sh\necho 'tlprobe 3.9.6'\n", 0o755);

      setPythonInterpreterSeamForTest({ locate: (name) => (name === "python3" ? path.join(ws, ".venv", "bin", "python3") : undefined) });
      expect(pythonSyntaxCheck(ws, [target], { platform: "linux" })).toBeUndefined();

      setPythonInterpreterSeamForTest({
        locate: (name) => (name === "python3" ? path.join(outside, "python3") : name === "python3.12" ? path.join(ws, "bin", "python3.12") : undefined),
      });
      expect(pythonSyntaxCheck(ws, [target], { platform: "linux" })!.commands[0]).toBe(`svc/.venv/bin/python -m py_compile ${target}${ECHO}`);
      fs.rmSync(path.join(ws, "svc", ".venv"), { recursive: true });
      resetPythonProbeCacheForTest();
      expect(pythonSyntaxCheck(ws, [target], { platform: "linux" })).toBeUndefined();
      expect(fs.existsSync(marker), fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "").toBe(false);
    });
  });
});

describe("where the check rides", () => {
  beforeEach(() => {
    resetPackDedupeCache();
    resetRoleInventoryCache();
    resetPackServeLogForTest();
    handleTable.reset();
  });

  const clause = process.platform === "darwin" ? XCRUN : "";
  const target = "svc/svc_pkg/engine.py";

  it("the edit kit carries it as harness.syntax_check only when the edit path asks (structural callers unchanged)", () => {
    const ws = mkWorkspace("kit");
    project(ws, ["openpyxl"]);
    write(ws, target, "import openpyxl\n");
    fakeHost({ python3: { version: "3.9.6" }, "python3.12": { version: "3.12.13", modules: ["openpyxl"] } });
    const manifest = buildVerificationManifest(ws, [target], { pythonSyntaxCheck: true })!;
    expect(manifest.verify_strategy).toBe("syntax_only+diff");
    expect(manifest.harness?.syntax_check).toEqual(pythonSyntaxCheck(ws, [target]));
    expect(Buffer.byteLength(manifest.harness!.syntax_check!.note, "utf8")).toBeLessThanOrEqual(KIT_NOTE_MAX_BYTES);
    expect(buildVerificationManifest(ws, [target])).toBeUndefined();
  });

  it("a native check keeps the field when an edit set mixes C++ and Python", () => {
    const ws = mkWorkspace("mixed");
    project(ws, ["openpyxl"]);
    write(ws, target, "import openpyxl\n");
    write(ws, "fw/src/a.cpp", "int a() { return 1; }\n");
    fakeHost({ python3: { version: "3.9.6" }, "python3.12": { version: "3.12.13", modules: ["openpyxl"] } });
    setToolchainPathLookupForTest((candidates) => candidates.find((name) => name === "clang++"));
    const check = buildVerificationManifest(ws, ["fw/src/a.cpp", target], { pythonSyntaxCheck: true })!.harness!.syntax_check!;
    expect(check.commands).toHaveLength(1);
    expect(check.commands[0]!.startsWith("clang++ "), check.commands[0]).toBe(true);
  });

  it("a Python fix pack's verify states the interpreter instead of a bare pytest, and keeps pytest when python3 suffices", async () => {
    const ws = mkWorkspace("packfix");
    project(ws, ["openpyxl"]);
    write(ws, target, "import openpyxl\n\ndef total_premium(rows):\n    return sum(r[1] for r in rows)\n");
    fakeHost({ python3: { version: "3.9.6" }, "python3.12": { version: "3.12.13", modules: ["openpyxl"] } });
    const pack = await buildTaskPack({ query: "Fix total_premium in svc/svc_pkg/engine.py: it must skip rows without a rate.", paths: [target] }, ws);
    expect(pack.verify, JSON.stringify(pack.verify)).toEqual([
      `${word(fakeBin("python3.12"), process.platform)} -m py_compile ${target}${process.platform === "win32" ? "" : ECHO}`,
      `python3 is 3.9.6 (requires-python >=3.10) and lacks openpyxl; python3.12 satisfies both; run smoke checks with it from the workspace root${clause}`,
    ]);

    resetPackDedupeCache();
    fakeHost({ python3: { version: "3.12.1", modules: ["openpyxl"] } });
    const quiet = await buildTaskPack({ query: "Fix total_premium in svc/svc_pkg/engine.py: it must skip rows without a rate.", paths: [target] }, ws);
    expect(quiet.verify).toContain("pytest");
  }, 30000);

  async function workbookBytes(sheetName: string): Promise<Buffer> {
    type Worksheet = { addRow(values: unknown[]): void };
    type Workbook = { addWorksheet(name: string): Worksheet; xlsx: { writeBuffer(): Promise<Buffer> } };
    const ExcelJSMod = (await import("exceljs")) as unknown as { Workbook: new () => Workbook };
    const workbook = new ExcelJSMod.Workbook();
    const sheet = workbook.addWorksheet(sheetName);
    sheet.addRow(["product", "rate"]);
    for (let i = 0; i < 3; i++) sheet.addRow([`item-${i}`, i + 0.25]);
    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  it("an artifact pack's Python target states the check once, counting openpyxl for an xlsx source", async () => {
    // Here the target shares the pack's root, so discoverVerificationHints
    // states the command first and the artifact pass swaps in its note. The
    // T10 layout, where only the artifact pass sees the target, is the
    // replay corpus's v016py1.
    const ws = mkWorkspace("packartifact");
    project(ws, ["flask", "openpyxl"]);
    write(ws, target, '"""Rating engine.\n\nTODO: implement calculate_rate from the rate table XLSX.\n"""\n');
    fs.mkdirSync(path.join(ws, "docs"), { recursive: true });
    fs.writeFileSync(path.join(ws, "docs/rate-table.xlsx"), await workbookBytes("BaseRates"));
    fakeHost({ python3: { version: "3.9.6" }, "python3.12": { version: "3.12.13", modules: ["openpyxl"] } });
    const pack = await buildTaskPack({
      query: "Implement calculate_rate in svc/svc_pkg/engine.py from the rate table XLSX using BaseRates.",
      paths: ["docs/rate-table.xlsx", target],
    }, ws);
    const verify = pack.verify ?? [];
    const command = `${word(fakeBin("python3.12"), process.platform)} -m py_compile ${target}${process.platform === "win32" ? "" : ECHO}`;
    expect(verify.some((line) => line.startsWith("validate the produced module the cheap way")), JSON.stringify(verify)).toBe(true);
    expect(verify.filter((line) => line === command), JSON.stringify(verify)).toHaveLength(1);
    expect(verify[verify.indexOf(command) + 1]).toBe(
      `python3 is 3.9.6 (requires-python >=3.10) and lacks openpyxl; python3.12 satisfies both but lacks flask; run smoke checks with it from the workspace root${clause}`,
    );
    expect(verify.filter((line) => line.startsWith("python3 is 3.9.6")), JSON.stringify(verify)).toHaveLength(1);
  }, 30000);
});
