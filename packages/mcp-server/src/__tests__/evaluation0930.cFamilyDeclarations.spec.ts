/**
 * evaluation0930.cFamilyDeclarations.spec.ts — v0.15.0 NBR/FUI improvement
 * wave (WP-CD): C/C++ `#include` resolution with include roots and
 * header/source counterparts (features/task-pack/cIncludes.ts), and the
 * declaration scan for every language (features/task-pack/declarationScan.ts).
 *
 * Pure unit tests: synthetic workspaces under a short tmp dir, the exported
 * functions called directly. Pinned here:
 *  - `#include` resolution: quoted vs angled rules, comments / `#if 0` /
 *    raw strings, CMake (`target_include_directories`, variables, generator
 *    expressions), compile_commands.json (`command` and `arguments`),
 *    Makefile `-I`, meson / Bazel, absolute paths outside the workspace,
 *    symlinks, the tree fallback, bounded work on a 2,000+ file tree;
 *  - header/source counterparts: same directory, mirrored trees, unique
 *    stem, ambiguous stem, search bound;
 *  - review round: an outer project's conventional directories are no include
 *    roots of a nested one (declared ones still are, a Bazel workspace root
 *    included), nothing behind a symbolic link that points out of the
 *    workspace is read or listed (asserted on recorded fs accesses), sibling
 *    libraries and vendored projects never pair as counterparts, and
 *    unterminated `typedef struct {` / `export const X = {` input stays linear;
 *  - declarations: C/C++ (types, enumerators, members, containers,
 *    exported, macros, statements never reported), Go / Java / Kotlin /
 *    Python / TS additions with negatives, and the pre-existing TS / Python /
 *    Go / Java results unchanged (differential against the old scan).
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { declarationsIn, type DeclaredSymbol } from "../features/task-pack/declarationScan.js";
import { resolveCIncludesOf } from "../features/task-pack/cIncludes.js";
import { resolveImportsOf } from "../features/task-pack/importResolution.js";
import { isLineComment } from "../features/task-pack/importGraphShared.js";

// Records the filesystem accesses the resolvers make while `spy.recording` is on (as `<kind>:<path>` with kind read | list |
// stat | realpath), so "nothing behind a symbolic link is read or listed" is asserted on the accesses themselves.
const spy = vi.hoisted(() => ({ recording: false, access: [] as string[] }));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const wrap = <F extends (...args: any[]) => any>(kind: string, fn: F): F =>
    ((...args: any[]) => {
      if (spy.recording) spy.access.push(`${kind}:${String(args[0])}`);
      return fn(...args);
    }) as F;
  const realpathSync = Object.assign(wrap("realpath", actual.realpathSync), { native: wrap("realpath", actual.realpathSync.native) });
  const wrapped = {
    ...actual,
    readFileSync: wrap("read", actual.readFileSync),
    statSync: wrap("stat", actual.statSync),
    lstatSync: wrap("stat", actual.lstatSync),
    readdirSync: wrap("list", actual.readdirSync),
    opendirSync: wrap("list", actual.opendirSync),
    realpathSync,
  };
  return { ...wrapped, default: wrapped };
});

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const tmpDirs: string[] = [];

afterAll(async () => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      await rmDirWithRetry(dir);
    } catch {
      /* best-effort cleanup */
    }
  }
});

function makeWorkspace(tag: string, files: Readonly<Record<string, string>> = {}): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-e0930-cfd-${tag}-`));
  tmpDirs.push(ws);
  for (const [rel, content] of Object.entries(files)) writeFile(ws, rel, content);
  return ws;
}

function writeFile(ws: string, rel: string, content: string): void {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function includesOf(ws: string, file: string, maxEdges = 40) {
  const body = fs.readFileSync(path.join(ws, file), "utf8");
  return resolveCIncludesOf(ws, file, body.split(/\r?\n/), maxEdges);
}

function pathsOf(edges: ReadonlyArray<{ path: string }>): string[] {
  return edges.map((e) => e.path);
}

/** Runs `fn` with filesystem-access recording on; returns its result plus every access made (`<kind>:<path>`). */
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

const lines = (...rows: string[]): string => rows.join("\n") + "\n";

// ---------------------------------------------------------------------------
// #include resolution
// ---------------------------------------------------------------------------

describe("cIncludes — CMake project nested below a workspace with an unrelated package.json", () => {
  const files: Record<string, string> = {
    "package.json": "{\"name\":\"unrelated-web-app\"}\n",
    "vendor/tools/native/CMakeLists.txt": lines(
      "cmake_minimum_required(VERSION 3.16)",
      "project(engine LANGUAGES CXX)",
      "add_library(engine src/x.cpp src/detail/y.cpp)",
      "target_include_directories(engine PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)",
    ),
    "vendor/tools/native/include/engine/x.hpp": "#pragma once\n",
    "vendor/tools/native/include/engine/detail/y.hpp": "#pragma once\n",
    "vendor/tools/native/src/local.h": "\n",
    "vendor/tools/native/src/x.cpp": lines(
      "#include \"engine/x.hpp\"",
      "#include <engine/detail/y.hpp>",
      "#include <vector>",
      "#include <sys/types.h>",
      "#include \"local.h\"",
      "#include \"missing/nothing.h\"",
    ),
    "vendor/tools/native/src/detail/y.cpp": lines(
      "#include \"local.h\"",
      "#include <local.h>",
      "#include \"engine/detail/y.hpp\"",
    ),
    "vendor/tools/native/src/detail/local.h": "\n",
  };
  const ws = makeWorkspace("cmake", files);

  it("resolves quoted and angled includes through the declared include directory; system headers yield nothing", () => {
    const edges = includesOf(ws, "vendor/tools/native/src/x.cpp");
    expect(edges.filter((e) => e.kind === "include")).toEqual([
      { path: "vendor/tools/native/include/engine/x.hpp", line: 1, kind: "include", names: [] },
      { path: "vendor/tools/native/include/engine/detail/y.hpp", line: 2, kind: "include", names: [] },
      { path: "vendor/tools/native/src/local.h", line: 5, kind: "include", names: [] },
    ]);
    // <vector>, <sys/types.h> and the missing header name nothing in the workspace.
    expect(pathsOf(edges).some((p) => p.includes("vector") || p.includes("types") || p.includes("nothing"))).toBe(false);
  });

  it("a quoted include resolves against the including directory first; an angled one never does", () => {
    const edges = includesOf(ws, "vendor/tools/native/src/detail/y.cpp");
    const inc = edges.filter((e) => e.kind === "include");
    // "local.h" → next to y.cpp (src/detail/local.h), not src/local.h; <local.h> never looks next to the file,
    // and src/ is a conventional root, so it lands on src/local.h.
    expect(inc.map((e) => [e.path, e.line])).toEqual([
      ["vendor/tools/native/src/detail/local.h", 1],
      ["vendor/tools/native/src/local.h", 2],
      ["vendor/tools/native/include/engine/detail/y.hpp", 3],
    ]);
  });

  it("emits include edges first (statement order), then counterparts, never the file itself", () => {
    const edges = includesOf(ws, "vendor/tools/native/include/engine/detail/y.hpp");
    expect(edges).toEqual([{ path: "vendor/tools/native/src/detail/y.cpp", line: 0, kind: "counterpart", names: [] }]);
    const y = includesOf(ws, "vendor/tools/native/src/detail/y.cpp");
    expect(pathsOf(y)).not.toContain("vendor/tools/native/src/detail/y.cpp");
  });

  it("through the dispatcher an include edge wins over the counterpart of the same path", () => {
    const body = fs.readFileSync(path.join(ws, "vendor/tools/native/src/detail/y.cpp"), "utf8");
    const edges = resolveImportsOf(ws, "vendor/tools/native/src/detail/y.cpp", body);
    const header = edges.filter((e) => e.path === "vendor/tools/native/include/engine/detail/y.hpp");
    expect(header).toHaveLength(1);
    expect(header[0]!.kind).toBe("include");
  });
});

describe("cIncludes — directive extraction", () => {
  it("skips comments, #if 0 (nesting-aware), raw strings and computed includes; other conditionals stay live", () => {
    const ws = makeWorkspace("directives", {
      "p/CMakeLists.txt": "project(p)\n",
      "p/include/live.h": "",
      "p/include/live2.h": "",
      "p/include/live3.h": "",
      "p/include/dead.h": "",
      "p/include/commented.h": "",
      "p/include/raw.h": "",
      "p/include/objc.h": "",
      "p/src/main.c": lines(
        "// #include \"commented.h\"",
        "/* #include \"commented.h\" */",
        "/*",
        "#include \"commented.h\"",
        "*/",
        "#include \"live.h\"",
        "#if 0",
        "#include \"dead.h\"",
        "#if FOO",
        "#include \"dead.h\"",
        "#endif",
        "#include \"dead.h\"",
        "#else",
        "#include \"live2.h\"",
        "#endif",
        "#ifdef SOMETHING",
        "#include \"live3.h\"",
        "#endif",
        "const char *shader = R\"GLSL(",
        "#include \"raw.h\"",
        ")GLSL\";",
        "#define HEADER \"live.h\"",
        "#include HEADER",
        "#import \"objc.h\"",
      ),
    });
    const edges = includesOf(ws, "p/src/main.c").filter((e) => e.kind === "include");
    expect(edges.map((e) => [e.path, e.line])).toEqual([
      ["p/include/live.h", 6],
      ["p/include/live2.h", 14],
      ["p/include/live3.h", 17],
      ["p/include/objc.h", 24],
    ]);
  });

  it("accepts a backslash separator and a spaced `# include`", () => {
    const ws = makeWorkspace("backslash", {
      "p/Makefile": "all:\n",
      "p/inc/sub/win.h": "",
      "p/src/a.c": lines("#  include <sub\\win.h>"),
    });
    expect(pathsOf(includesOf(ws, "p/src/a.c"))).toEqual(["p/inc/sub/win.h"]);
  });
});

describe("cIncludes — CMake variables, generator expressions and command forms", () => {
  it("expands PROJECT_SOURCE_DIR / CMAKE_SOURCE_DIR / CMAKE_CURRENT_LIST_DIR and unwraps BUILD_INTERFACE; INSTALL_INTERFACE and unknown variables are ignored", () => {
    const ws = makeWorkspace("cmakevars", {
      "repo/CMakeLists.txt": lines("project(top)", "include_directories(${CMAKE_SOURCE_DIR}/shared)", "add_subdirectory(mod)"),
      "repo/shared/common/util.h": "",
      "repo/mod/CMakeLists.txt": lines(
        "project(mod)",
        "target_include_directories(mod",
        "  PRIVATE",
        "    $<BUILD_INTERFACE:${PROJECT_SOURCE_DIR}/api>",
        "    $<INSTALL_INTERFACE:include/should_not_matter>",
        "  SYSTEM PUBLIC ${CMAKE_CURRENT_LIST_DIR}/pub",
        "  ${UNKNOWN_VARIABLE}/include",
        "  $<$<CONFIG:Debug>:debug_inc>",
        ")",
      ),
      "repo/mod/api/mod/api.h": "",
      "repo/mod/pub/mod/pub.h": "",
      "repo/mod/should_not_matter/mod/never.h": "",
      "repo/mod/src/m.cpp": lines(
        "#include <common/util.h>",
        "#include <mod/api.h>",
        "#include <mod/pub.h>",
        "#include <mod/never.h>",
      ),
    });
    expect(includesOf(ws, "repo/mod/src/m.cpp").map((e) => [e.path, e.line])).toEqual([
      ["repo/shared/common/util.h", 1],
      ["repo/mod/api/mod/api.h", 2],
      ["repo/mod/pub/mod/pub.h", 3],
    ]);
  });

  it("set() variables expand when defined once and stay unresolved when redefined differently", () => {
    const ws = makeWorkspace("cmakeset", {
      "a/CMakeLists.txt": lines(
        "project(a)",
        "set(A_INC ${CMAKE_CURRENT_SOURCE_DIR}/inc_a)",
        "set(PLAIN plain_inc)",
        "set(TWICE one)",
        "set(TWICE two)",
        "include_directories(${A_INC} ${PLAIN} ${TWICE})",
      ),
      "a/inc_a/from_a.h": "",
      "a/plain_inc/from_plain.h": "",
      "a/one/from_one.h": "",
      "a/two/from_two.h": "",
      "a/src/x.c": lines("#include <from_a.h>", "#include <from_plain.h>", "#include <from_one.h>", "#include <from_two.h>"),
    });
    expect(includesOf(ws, "a/src/x.c").map((e) => e.path)).toEqual(["a/inc_a/from_a.h", "a/plain_inc/from_plain.h"]);
  });

  it("an absolute directory outside the workspace is ignored; a comment does not declare directories", () => {
    const ws = makeWorkspace("cmakeabs", {
      "n/CMakeLists.txt": lines(
        "project(n)",
        "# include_directories(commented_out)",
        "include_directories(/usr/local/include /opt/somewhere/inc)",
        "target_include_directories(n PUBLIC real_inc)",
      ),
      "n/real_inc/r.h": "",
      "n/commented_out/c.h": "",
      "n/x.cpp": lines("#include <r.h>", "#include <c.h>"),
    });
    expect(pathsOf(includesOf(ws, "n/x.cpp"))).toEqual(["n/real_inc/r.h"]);
  });
});

describe("cIncludes — compile_commands.json", () => {
  const buildCommands = (ws: string, dir: string, entries: unknown[]): void => {
    writeFile(ws, `${dir}/compile_commands.json`, JSON.stringify(entries));
  };

  it("reads -I, -I <dir>, -isystem, -iquote from `command` and `arguments`, relative to the entry's directory; outside absolutes are ignored", () => {
    const ws = makeWorkspace("ccdb", {
      "proj/CMakeLists.txt": "project(proj)\n",
      "proj/third/dep/dep.h": "",
      "proj/gen/gen.h": "",
      "proj/quote/q.h": "",
      "proj/sys/s.h": "",
      "proj/abs/inside.h": "",
      "proj/src/a.cpp": lines("#include <dep/dep.h>", "#include <gen.h>", "#include \"q.h\"", "#include <s.h>", "#include <inside.h>", "#include <outside.h>"),
    });
    buildCommands(ws, "proj/build", [
      {
        directory: path.join(ws, "proj", "build"),
        command: `c++ -DX=1 -I../third -I ../gen -iquote "../quote" -isystem ../sys -I${path.join(ws, "proj", "abs")} -I/somewhere/outside/the/workspace -c ../src/a.cpp -o a.o`,
        file: "../src/a.cpp",
      },
    ]);
    expect(includesOf(ws, "proj/src/a.cpp").map((e) => [e.path, e.line])).toEqual([
      ["proj/third/dep/dep.h", 1],
      ["proj/gen/gen.h", 2],
      ["proj/quote/q.h", 3],
      ["proj/sys/s.h", 4],
      ["proj/abs/inside.h", 5],
    ]);
    // the same file through the `arguments` form
    buildCommands(ws, "proj/build", [
      {
        directory: path.join(ws, "proj", "build"),
        arguments: ["c++", "-I../third", "-I", "../gen", "-c", "../src/a.cpp"],
        file: path.join(ws, "proj", "src", "a.cpp"),
      },
    ]);
    expect(pathsOf(includesOf(ws, "proj/src/a.cpp"))).toEqual(["proj/third/dep/dep.h", "proj/gen/gen.h"]);
  });

  it("uses the entry for the file itself, and the union of all entries for a header", () => {
    const ws = makeWorkspace("ccdb-union", {
      "p/CMakeLists.txt": "project(p)\n",
      "p/libA/a.h": "",
      "p/libB/b.h": "",
      "p/src/one.cpp": lines("#include <a.h>", "#include <b.h>"),
      "p/src/two.cpp": lines("#include <a.h>", "#include <b.h>"),
      "p/src/shared.hpp": lines("#include <a.h>", "#include <b.h>"),
    });
    const at = (rel: string): string => path.join(ws, "p", rel);
    buildCommands(ws, "p", [
      { directory: at(""), command: "cc -IlibA -c src/one.cpp", file: "src/one.cpp" },
      { directory: at(""), command: "cc -IlibB -c src/two.cpp", file: "src/two.cpp" },
    ]);
    expect(pathsOf(includesOf(ws, "p/src/one.cpp"))).toEqual(["p/libA/a.h"]);
    expect(pathsOf(includesOf(ws, "p/src/two.cpp"))).toEqual(["p/libB/b.h"]);
    expect(pathsOf(includesOf(ws, "p/src/shared.hpp")).sort()).toEqual(["p/libA/a.h", "p/libB/b.h"]);
  });

  it("finds compile_commands.json under out/ and cmake-build-*, and skips a file over 8 MiB", () => {
    const ws = makeWorkspace("ccdb-dirs", {
      "p/CMakeLists.txt": "project(p)\n",
      "p/deps/d.h": "",
      "p/src/x.cpp": lines("#include <d.h>"),
    });
    buildCommands(ws, "p/cmake-build-debug", [{ directory: path.join(ws, "p"), command: "cc -Ideps -c src/x.cpp", file: "src/x.cpp" }]);
    expect(pathsOf(includesOf(ws, "p/src/x.cpp"))).toEqual(["p/deps/d.h"]);
    fs.rmSync(path.join(ws, "p/cmake-build-debug"), { recursive: true, force: true });
    const padding = "x".repeat(8 * 1024 * 1024 + 16);
    writeFile(ws, "p/out/compile_commands.json", JSON.stringify([{ directory: path.join(ws, "p"), command: "cc -Ideps", file: "src/x.cpp", pad: padding }]));
    expect(pathsOf(includesOf(ws, "p/src/x.cpp"))).toEqual([]);
  });
});

describe("cIncludes — Makefile, Makefile.am, meson and Bazel", () => {
  it("reads -Iinc, -I inc, variables defined once, $(CURDIR); ignores unresolved variables and shell calls", () => {
    const ws = makeWorkspace("make", {
      "tool/Makefile": lines(
        "INC := extra",
        "CFLAGS += -Iinc -I lib/include -I$(INC) -I$(shell pwd)/nope -I$(UNDEFINED)/x -I$(CURDIR)/cur",
        "all: main.o",
        "\t$(CC) $(CFLAGS) -c src/main.c",
      ),
      "tool/inc/in.h": "",
      "tool/lib/include/lib.h": "",
      "tool/extra/ex.h": "",
      "tool/cur/cu.h": "",
      "tool/nope/no.h": "",
      "tool/src/main.c": lines("#include <in.h>", "#include <lib.h>", "#include <ex.h>", "#include <cu.h>", "#include <no.h>"),
    });
    expect(pathsOf(includesOf(ws, "tool/src/main.c"))).toEqual(["tool/inc/in.h", "tool/lib/include/lib.h", "tool/extra/ex.h", "tool/cur/cu.h"]);
  });

  it("expands $(top_srcdir) / $(srcdir) in Makefile.am against configure.ac", () => {
    const ws = makeWorkspace("automake", {
      "gnu/configure.ac": "AC_INIT([x],[1])\n",
      "gnu/Makefile.am": "SUBDIRS = lib\n",
      "gnu/include/top.h": "",
      "gnu/lib/Makefile.am": "AM_CPPFLAGS = -I$(top_srcdir)/include -I$(srcdir)/priv\n",
      "gnu/lib/priv/p.h": "",
      "gnu/lib/x.c": lines("#include <top.h>", "#include <p.h>"),
    });
    expect(pathsOf(includesOf(ws, "gnu/lib/x.c"))).toEqual(["gnu/include/top.h", "gnu/lib/priv/p.h"]);
  });

  it("reads meson include_directories and Bazel includes", () => {
    const ws = makeWorkspace("mesonbazel", {
      "m/meson.build": "inc = include_directories('public', 'private/api')\n",
      "m/public/pub.h": "",
      "m/private/api/priv.h": "",
      "m/x.c": lines("#include <pub.h>", "#include <priv.h>"),
      "b/BUILD": "cc_library(name = \"lib\", srcs = [\"y.cc\"], includes = [\"headers\", \"more\"])\n",
      "b/headers/h.h": "",
      "b/more/m.h": "",
      "b/y.cc": lines("#include <h.h>", "#include <m.h>"),
    });
    expect(pathsOf(includesOf(ws, "m/x.c"))).toEqual(["m/public/pub.h", "m/private/api/priv.h"]);
    expect(pathsOf(includesOf(ws, "b/y.cc"))).toEqual(["b/headers/h.h", "b/more/m.h"]);
  });
});

describe("cIncludes — fallbacks and safety", () => {
  it("without any build file, a qualified include resolves through the conventional directories of the ancestors; a bare one does not", () => {
    const ws = makeWorkspace("nobuild", {
      "lib/include/net/socket.h": "",
      "lib/include/plain.h": "",
      "lib/src/main.c": lines("#include <net/socket.h>", "#include <plain.h>"),
    });
    expect(pathsOf(includesOf(ws, "lib/src/main.c"))).toEqual(["lib/include/net/socket.h"]);
  });

  it("finds a header declared by a sibling CMake target only when exactly one file matches", () => {
    const ws = makeWorkspace("tree", {
      "mono/CMakeLists.txt": lines("project(mono)", "add_subdirectory(core)", "add_subdirectory(render)", "add_subdirectory(gui)"),
      "mono/core/CMakeLists.txt": "target_include_directories(core PUBLIC include)\n",
      "mono/core/include/core/base.h": "",
      "mono/core/include/dup/shared.h": "",
      "mono/gui/CMakeLists.txt": "target_include_directories(gui PUBLIC include)\n",
      "mono/gui/include/dup/shared.h": "",
      "mono/render/CMakeLists.txt": "target_include_directories(render PUBLIC include)\n",
      "mono/render/src/r.cpp": lines("#include <core/base.h>", "#include <dup/shared.h>", "#include <absent/none.h>"),
    });
    expect(includesOf(ws, "mono/render/src/r.cpp").map((e) => [e.path, e.line])).toEqual([["mono/core/include/core/base.h", 1]]);
  });

  it("finds a header of a sibling library when exactly one `<sibling>/include/<path>` matches", () => {
    const ws = makeWorkspace("siblings", {
      "libs/net/include/net/socket.h": "",
      "libs/util/include/common/shared.h": "",
      "libs/gui/include/common/shared.h": "",
      "libs/render/src/r.cpp": lines("#include <net/socket.h>", "#include <common/shared.h>", "#include <absent/none.h>"),
    });
    expect(includesOf(ws, "libs/render/src/r.cpp").map((e) => [e.path, e.line])).toEqual([["libs/net/include/net/socket.h", 1]]);
  });

  it("never follows a symbolic link out of the workspace and never resolves `..` out of it", () => {
    const outside = fs.realpathSync(shortTmpDir(HOME, ".tl-e0930-cfd-outside-"));
    tmpDirs.push(outside);
    fs.mkdirSync(path.join(outside, "hdr"), { recursive: true });
    fs.writeFileSync(path.join(outside, "hdr", "secret.h"), "", "utf8");
    fs.writeFileSync(path.join(outside, "escape.h"), "", "utf8");
    const ws = makeWorkspace("symlink", {
      "p/CMakeLists.txt": "include_directories(link)\n",
      "p/x.c": lines("#include <secret.h>", "#include \"../../escape.h\"", "#include \"link/secret.h\""),
    });
    if (process.platform !== "win32") {
      fs.symlinkSync(path.join(outside, "hdr"), path.join(ws, "p", "link"), "dir");
      expect(includesOf(ws, "p/x.c")).toEqual([]);
    }
    expect(pathsOf(includesOf(ws, "p/x.c"))).not.toContain("../escape.h");
  });

  it("caps at maxEdges and reports each target once", () => {
    const files: Record<string, string> = { "p/CMakeLists.txt": "project(p)\n" };
    const rows: string[] = [];
    for (let i = 0; i < 12; i++) {
      files[`p/include/h${i}.h`] = "";
      rows.push(`#include <h${i}.h>`);
    }
    rows.push("#include <h0.h>");
    files["p/src/big.c"] = lines(...rows);
    const ws = makeWorkspace("cap", files);
    expect(includesOf(ws, "p/src/big.c", 5)).toHaveLength(5);
    expect(includesOf(ws, "p/src/big.c", 40)).toHaveLength(12);
    expect(includesOf(ws, "p/src/big.c", 0)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Counterparts
// ---------------------------------------------------------------------------

describe("cIncludes — header/source counterparts", () => {
  it("pairs same-stem files in the same directory across the header and source extensions", () => {
    const ws = makeWorkspace("cp-same", {
      "m/CMakeLists.txt": "project(m)\n",
      "m/a.h": "", "m/a.c": "",
      "m/b.hpp": "", "m/b.cpp": "",
      "m/c.cuh": "", "m/c.cu": "",
      "m/d.hpp": "", "m/d.inl": "", "m/d.mm": "",
      "m/lonely.h": "",
    });
    const cp = (file: string): string[] => resolveCIncludesOf(ws, file, [], 40).map((e) => `${e.path}|${e.kind}|${e.line}`);
    expect(cp("m/a.h")).toEqual(["m/a.c|counterpart|0"]);
    expect(cp("m/a.c")).toEqual(["m/a.h|counterpart|0"]);
    expect(cp("m/b.hpp")).toEqual(["m/b.cpp|counterpart|0"]);
    expect(cp("m/c.cu")).toEqual(["m/c.cuh|counterpart|0"]);
    expect(cp("m/d.inl")).toEqual(["m/d.hpp|counterpart|0", "m/d.mm|counterpart|0"]);
    expect(cp("m/lonely.h")).toEqual([]);
  });

  it("pairs mirrored include/src trees, including include/<dirname>/x.h with src/x.cpp", () => {
    const ws = makeWorkspace("cp-mirror", {
      "lib/CMakeLists.txt": "project(lib)\n",
      "lib/include/net/socket.hpp": "", "lib/src/net/socket.cpp": "",
      "lib/include/net/detail/frame.hpp": "", "lib/src/net/detail/frame.cpp": "",
      "lib/include/util/clock.hpp": "", "lib/src/clock.cpp": "",
      "lib/inc/legacy/old.h": "", "lib/src/legacy/old.c": "",
      "lib/src/timer.cpp": "", "lib/include/lib/timer.hpp": "",
    });
    const cp = (file: string): string[] => resolveCIncludesOf(ws, file, [], 40).map((e) => e.path);
    expect(cp("lib/include/net/socket.hpp")).toEqual(["lib/src/net/socket.cpp"]);
    expect(cp("lib/src/net/socket.cpp")).toEqual(["lib/include/net/socket.hpp"]);
    expect(cp("lib/include/net/detail/frame.hpp")).toEqual(["lib/src/net/detail/frame.cpp"]);
    expect(cp("lib/include/util/clock.hpp")).toEqual(["lib/src/clock.cpp"]);
    expect(cp("lib/src/clock.cpp")).toEqual(["lib/include/util/clock.hpp"]);
    expect(cp("lib/inc/legacy/old.h")).toEqual(["lib/src/legacy/old.c"]);
    expect(cp("lib/src/timer.cpp")).toEqual(["lib/include/lib/timer.hpp"]);
  });

  it("finds a unique same-stem file within the project root; an ambiguous stem yields nothing", () => {
    const ws = makeWorkspace("cp-unique", {
      "proj/CMakeLists.txt": "project(proj)\n",
      "proj/api/only.hpp": "",
      "proj/impl/deep/only.cpp": "",
      "proj/api/twin.hpp": "",
      "proj/impl/a/twin.cpp": "",
      "proj/impl/b/twin.cpp": "",
      "proj/api/node_modules/hidden.hpp": "",
      "proj/other/hidden.cpp": "",
    });
    const cp = (file: string): string[] => resolveCIncludesOf(ws, file, [], 40).map((e) => e.path);
    expect(cp("proj/api/only.hpp")).toEqual(["proj/impl/deep/only.cpp"]);
    expect(cp("proj/impl/deep/only.cpp")).toEqual(["proj/api/only.hpp"]);
    expect(cp("proj/api/twin.hpp")).toEqual([]);
    expect(cp("proj/impl/a/twin.cpp")).toEqual(["proj/api/twin.hpp"]);
    // the copy under node_modules is never a candidate
    expect(cp("proj/other/hidden.cpp")).toEqual([]);
  });

  it("gives up when the unique-stem search would exceed its entry bound", () => {
    const files: Record<string, string> = { "big/CMakeLists.txt": "project(big)\n", "big/api/needle.hpp": "", "big/zz/needle.cpp": "" };
    for (let i = 0; i < 2100; i++) files[`big/filler/f${i}.txt`] = "";
    const ws = makeWorkspace("cp-bound", files);
    expect(resolveCIncludesOf(ws, "big/api/needle.hpp", [], 40)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Review round: outer projects, symbolic links, umbrella builds
// ---------------------------------------------------------------------------

describe("cIncludes — nested projects, symbolic links and umbrella builds (review round)", () => {
  it("a nested project's unresolved quoted include never lands on the conventional directories of an outer project, nor of an ancestor above its own root", () => {
    const ws = makeWorkspace("outer-conv", {
      "CMakeLists.txt": lines("cmake_minimum_required(VERSION 3.16)", "project(umbrella)", "add_subdirectory(libs/net)"),
      "src/config.h": "",
      "src/log.h": "",
      "src/app.c": lines("#include <config.h>", "#include \"log.h\""),
      "libs/net/CMakeLists.txt": lines("project(net)", "include_directories(${CMAKE_CURRENT_BINARY_DIR})", "target_include_directories(net PUBLIC include)"),
      "libs/net/include/net/socket.h": "",
      // the conventional `src/` of `libs`: an ancestor ABOVE the nested project's own root
      "libs/src/util/probe.h": "",
      "libs/net/src/socket.c": lines("#include \"config.h\"", "#include \"log.h\"", "#include <net/socket.h>", "#include \"util/probe.h\""),
    });
    // `config.h` is generated into the build directory and `log.h` is the application's: neither is visible to libs/net.
    expect(includesOf(ws, "libs/net/src/socket.c").map((e) => [e.path, e.line])).toEqual([["libs/net/include/net/socket.h", 3]]);
    // The application itself still resolves through its own project's conventional `src/`.
    expect(includesOf(ws, "src/app.c").map((e) => [e.path, e.line])).toEqual([["src/config.h", 1], ["src/log.h", 2]]);
  });

  it("the include directories an outer project DECLARES still reach its subprojects (CMake directory properties are inherited; so is a Makefile's -I)", () => {
    const cmake = makeWorkspace("outer-declared", {
      "CMakeLists.txt": lines("project(umbrella)", "include_directories(src)", "add_subdirectory(libs/net)"),
      "src/config.h": "",
      "libs/net/CMakeLists.txt": "project(net)\n",
      "libs/net/src/socket.c": lines("#include \"config.h\""),
    });
    expect(pathsOf(includesOf(cmake, "libs/net/src/socket.c"))).toEqual(["src/config.h"]);
    const make = makeWorkspace("outer-declared-mk", {
      "Makefile": "CFLAGS += -Isrc\n",
      "src/config.h": "",
      "libs/net/Makefile": "all:\n",
      "libs/net/src/socket.c": lines("#include \"config.h\""),
    });
    expect(pathsOf(includesOf(make, "libs/net/src/socket.c"))).toEqual(["src/config.h"]);
  });

  it("a Bazel workspace root stays an include root for every package below it (root-relative includes)", () => {
    const ws = makeWorkspace("bazel-root", {
      "WORKSPACE": "workspace(name = \"repo\")\n",
      "absl/base/BUILD.bazel": "cc_library(name = \"base\", srcs = [\"foo.cc\"])\n",
      "absl/base/foo.cc": lines("#include \"absl/base/foo.h\"", "#include \"absl/strings/str.h\"", "#include <absl/base/port.h>", "#include \"port.h\""),
      "absl/base/foo.h": "",
      "absl/base/port.h": "",
      "absl/strings/BUILD.bazel": "cc_library(name = \"strings\")\n",
      "absl/strings/str.h": "",
    });
    expect(includesOf(ws, "absl/base/foo.cc").map((e) => [e.path, e.line])).toEqual([
      ["absl/base/foo.h", 1],
      ["absl/strings/str.h", 2],
      ["absl/base/port.h", 3],
    ]);
  });

  it("reads and lists nothing behind a symbolic link that points out of the workspace (manifests, compile database, include directories)", () => {
    if (process.platform === "win32") return; // creating symbolic links needs a privilege there
    const outside = fs.realpathSync(shortTmpDir(HOME, ".tl-e0930-cfd-leak-"));
    tmpDirs.push(outside);
    writeFile(outside, "cinc/shared.h", "");
    writeFile(outside, "cinc/net/api.h", "");
    writeFile(outside, "manifests/CMakeLists.txt", "include_directories(secret)\n");
    writeFile(outside, "manifests/Makefile", "CFLAGS += -Isecret\n");
    writeFile(outside, "db/compile_commands.json", "[]\n");
    const ws = makeWorkspace("leak", {
      "a/CMakeLists.txt": lines("project(a)", "include_directories(inc)"),
      "a/src/own.h": "",
      "a/src/main.c": lines("#include <shared.h>", "#include \"net/api.h\"", "#include \"own.h\""),
      "b/src/main.c": lines("#include \"own.h\""),
      "b/src/own.h": "",
    });
    fs.symlinkSync(path.join(outside, "cinc"), path.join(ws, "a", "inc"), "dir");
    fs.symlinkSync(path.join(outside, "manifests", "CMakeLists.txt"), path.join(ws, "b", "CMakeLists.txt"), "file");
    fs.symlinkSync(path.join(outside, "manifests", "Makefile"), path.join(ws, "b", "Makefile"), "file");
    fs.symlinkSync(path.join(outside, "db"), path.join(ws, "b", "build"), "dir");
    const links = [path.join(ws, "a", "inc"), path.join(ws, "b", "CMakeLists.txt"), path.join(ws, "b", "Makefile"), path.join(ws, "b", "build"), outside];
    const under = (p: string, base: string): boolean => p === base || p.startsWith(base + path.sep);
    const contentAccess = (access: readonly string[]): string[] =>
      access.filter((a) => a.startsWith("read:") || a.startsWith("list:")).map((a) => a.slice(a.indexOf(":") + 1));
    const run = (file: string) => {
      const body = fs.readFileSync(path.join(ws, file), "utf8").split(/\r?\n/);
      return withAccessLog(() => resolveCIncludesOf(ws, file, body, 40));
    };

    const cold: Record<string, string[]> = {};
    for (const file of ["a/src/main.c", "b/src/main.c"]) {
      const { result, access } = run(file);
      cold[file] = contentAccess(access);
      // Only the real header next to the file resolves; nothing comes out of a link.
      expect(pathsOf(result), file).toEqual([file.replace("main.c", "own.h")]);
      // No manifest, compile database or directory behind a link is ever opened or listed.
      expect(cold[file]!.filter((p) => links.some((base) => under(p, base))), file).toEqual([]);
    }
    // The recorder is alive: the real manifest of `a` was read and the real directories were listed (cold caches).
    expect(cold["a/src/main.c"]).toContain(path.join(ws, "a", "CMakeLists.txt"));
    expect(cold["a/src/main.c"]).toContain(path.join(ws, "a"));
    expect(cold["b/src/main.c"]).toContain(path.join(ws, "b"));
  });

  it("sibling libraries under an umbrella build file are never counterparts of each other, and a vendored project is never searched", () => {
    const ws = makeWorkspace("umbrella", {
      "Makefile": "all:\n",
      "libs/a/src/util.c": "",
      "libs/b/include/util.h": "",
      // A library that owns its include/lib split pairs inside itself, whatever another library keeps under the same stem.
      "libs/c/include/c/parse.h": "",
      "libs/c/lib/parse.c": "",
      "libs/a/other/parse.c": "",
      // A directory that starts a project of its own (CMake / Meson project(), autotools configure.ac) is a different project.
      "core/api/thing.hpp": "",
      "core/api/curl_thing.h": "",
      "core/api/mthing.h": "",
      "vendor/zlib/CMakeLists.txt": "project(zlib)\n",
      "vendor/zlib/impl/thing.cpp": "",
      "vendor/curl/configure.ac": "AC_INIT([curl], [1])\n",
      "vendor/curl/impl/curl_thing.c": "",
      "vendor/mlib/meson.build": "project('mlib', 'c')\n",
      "vendor/mlib/impl/mthing.c": "",
      // ... but a plain CMakeLists.txt (or Makefile) is one more directory of the same project: LLVM-style trees keep pairing.
      "tool/CMakeLists.txt": "project(tool)\nadd_subdirectory(lib)\n",
      "tool/include/tool/Support/Foo.h": "",
      "tool/lib/Support/CMakeLists.txt": "add_library(support Foo.cpp)\n",
      "tool/lib/Support/Foo.cpp": "",
    });
    const cp = (file: string): string[] => resolveCIncludesOf(ws, file, [], 40).map((e) => e.path);
    expect(cp("libs/a/src/util.c")).toEqual([]);
    expect(cp("libs/b/include/util.h")).toEqual([]);
    expect(cp("libs/c/include/c/parse.h")).toEqual(["libs/c/lib/parse.c"]);
    expect(cp("libs/c/lib/parse.c")).toEqual(["libs/c/include/c/parse.h"]);
    expect(cp("core/api/thing.hpp")).toEqual([]);
    expect(cp("core/api/curl_thing.h")).toEqual([]);
    expect(cp("core/api/mthing.h")).toEqual([]);
    expect(cp("vendor/zlib/impl/thing.cpp")).toEqual([]);
    expect(cp("tool/include/tool/Support/Foo.h")).toEqual(["tool/lib/Support/Foo.cpp"]);
  });
});

// ---------------------------------------------------------------------------
// Bounded work
// ---------------------------------------------------------------------------

describe("cIncludes — bounded work", () => {
  it("resolves files of a 2,400-file tree in milliseconds on a warm cache", () => {
    const files: Record<string, string> = {
      "big/CMakeLists.txt": lines("project(big)", "target_include_directories(big PUBLIC include)", "include_directories(${CMAKE_CURRENT_SOURCE_DIR}/third_party/inc)"),
      "big/third_party/inc/vendored.h": "",
    };
    for (let m = 0; m < 40; m++) {
      for (let f = 0; f < 30; f++) {
        files[`big/include/mod${m}/api${f}.h`] = lines("#pragma once", "#include <vendored.h>");
        files[`big/src/mod${m}/impl${f}.cpp`] = lines(`#include "mod${m}/api${f}.h"`, `#include <mod${(m + 1) % 40}/api${f}.h>`, "#include <vector>", "#include <vendored.h>", "#include <nothing/here.h>");
      }
    }
    const ws = makeWorkspace("bounded", files);
    const sample = ["big/src/mod3/impl7.cpp", "big/src/mod39/impl29.cpp", "big/include/mod12/api5.h"];
    const run = (): void => {
      for (const f of sample) {
        const edges = includesOf(ws, f);
        expect(edges.length).toBeGreaterThan(0);
      }
    };
    run(); // cold: parses the manifest
    const started = process.hrtime.bigint();
    for (let i = 0; i < 20; i++) run();
    const perCallMs = Number(process.hrtime.bigint() - started) / 1e6 / (20 * sample.length);
    // Stated bound: under 25 ms per call on a warm cache (typically well below 2 ms).
    expect(perCallMs).toBeLessThan(25);
    expect(includesOf(ws, "big/src/mod3/impl7.cpp").map((e) => e.path)).toEqual([
      "big/include/mod3/api7.h",
      "big/include/mod4/api7.h",
      "big/third_party/inc/vendored.h",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

/** `line symbol kind exported[ in container]` rows of a scan. */
function rows(list: readonly DeclaredSymbol[]): string[] {
  return list.map((d) => `${d.line} ${d.symbol} ${d.kind ?? "?"} ${d.exported ? "pub" : "priv"}${d.container !== undefined ? ` in ${d.container}` : ""}`);
}

function namesOf(list: readonly DeclaredSymbol[]): string[] {
  return list.map((d) => d.symbol);
}

function pick(list: readonly DeclaredSymbol[], ...symbols: string[]): string[] {
  return rows(list.filter((d) => symbols.includes(d.symbol)));
}

describe("declarationsIn — C/C++ header", () => {
  const header = lines(
    "#ifndef ENGINE_HPP",
    "#define ENGINE_HPP",
    "",
    "#include <vector>",
    "#include \"common.h\"",
    "",
    "#define MAX_ENTITIES 1024",
    "#define SQUARE(x) ((x) * (x))",
    "#define MULTI_LINE(a, b) \\",
    "    do { foo(a); bar(b); } while (0)",
    "",
    "// void commented();",
    "/* int also_commented(); */",
    "",
    "namespace engine {",
    "",
    "class Renderer; // forward",
    "",
    "enum class Color : unsigned char { Red = 1, Green, Blue = (1 << 3), };",
    "enum Mode { MODE_A, MODE_B = 5 };",
    "",
    "struct Vec2 {",
    "  float x, y;",
    "  Vec2() = default;",
    "  Vec2(float x, float y) : x(x), y(y) {}",
    "  float length() const { return sqrtf(x * x + y * y); }",
    "  static Vec2 zero();",
    "};",
    "",
    "template <typename T>",
    "class Buffer : public Base<T> {",
    " public:",
    "  explicit Buffer(size_t n);",
    "  ~Buffer();",
    "  T& at(size_t i);",
    "  const T& at(size_t i) const { return data_[i]; }",
    "  static constexpr int kDefault = 16;",
    "  using value_type = T;",
    " protected:",
    "  virtual void hook() = 0;",
    " private:",
    "  T* data_;",
    "  size_t size_ = 0;",
    "  int flags : 3;",
    "  Buffer(const Buffer&) = delete;",
    "  Buffer& operator=(const Buffer&) = delete;",
    "};",
    "",
    "typedef struct Node { int v; struct Node* next; } Node;",
    "typedef unsigned int uint;",
    "typedef void (*Callback)(int, void*);",
    "using Handle = std::shared_ptr<Renderer>;",
    "template <class T> using Vec = std::vector<T>;",
    "",
    "extern int g_counter;",
    "static int s_hidden = 3;",
    "const char* const kNames[] = { \"a\", \"b\" };",
    "constexpr double kPi = 3.14159;",
    "std::map<int, std::string> registry;",
    "int (*fn_ptr)(int);",
    "",
    "int compute(int a, int b);",
    "static inline int helper(int x) { return x * 2; }",
    "[[nodiscard]] std::unique_ptr<Renderer> make_renderer(const Config& cfg);",
    "void process(std::function<void(int)> cb, int n = 5);",
    "Buffer<int>::Buffer(size_t n) : size_(n), data_{nullptr} {}",
    "",
    "namespace {",
    "  int anon_var = 0;",
    "  void anon_fn() {}",
    "}",
    "",
    "extern \"C\" {",
    "  void c_api(int x);",
    "}",
    "",
    "TEST(Suite, Case) {",
    "  int x = compute(1, 2);",
    "}",
    "Q_DECLARE_METATYPE(engine::Vec2);",
    "DECLARE_bool(verbose);",
    "",
    "}  // namespace engine",
    "",
    "#endif  // ENGINE_HPP",
  );
  const decls = declarationsIn("engine.hpp", header);

  it("reports types, enumerators, members, typedefs, variables and functions with kind, container and exported", () => {
    expect(rows(decls)).toEqual([
      "7 MAX_ENTITIES macro pub",
      "8 SQUARE macro pub",
      "9 MULTI_LINE macro pub",
      "19 Color type pub",
      "19 Red enum-member pub in Color",
      "19 Green enum-member pub in Color",
      "19 Blue enum-member pub in Color",
      "20 Mode type pub",
      "20 MODE_A enum-member pub in Mode",
      "20 MODE_B enum-member pub in Mode",
      "22 Vec2 type pub",
      "23 x member pub in Vec2",
      "23 y member pub in Vec2",
      "26 length member pub in Vec2",
      "27 zero member pub in Vec2",
      "31 Buffer type pub",
      "35 at member pub in Buffer",
      "36 at member pub in Buffer",
      "37 kDefault constant pub in Buffer",
      "38 value_type type pub in Buffer",
      "40 hook member priv in Buffer",
      "42 data_ member priv in Buffer",
      "43 size_ member priv in Buffer",
      "44 flags member priv in Buffer",
      "49 Node type pub",
      "49 v member pub in Node",
      "49 next member pub in Node",
      "50 uint type pub",
      "51 Callback type pub",
      "52 Handle type pub",
      "53 Vec type pub",
      "55 g_counter variable pub",
      "56 s_hidden variable priv",
      "57 kNames constant pub",
      "58 kPi constant pub",
      "59 registry variable pub",
      "60 fn_ptr variable pub",
      "62 compute function pub",
      "63 helper function priv",
      "64 make_renderer function pub",
      "65 process function pub",
      "66 Buffer member pub in Buffer",
      "69 anon_var variable priv",
      "70 anon_fn function priv",
      "74 c_api function pub",
    ]);
  });

  it("skips the include guard, comments, forward declarations, deleted members, constructors, destructors and macro invocations", () => {
    const names = namesOf(decls);
    for (const never of ["ENGINE_HPP", "commented", "also_commented", "Renderer", "operator", "TEST", "Q_DECLARE_METATYPE", "DECLARE_bool", "foo", "bar", "sqrtf"]) {
      expect(names, never).not.toContain(never);
    }
    // the constructors and destructor of the in-class declarations add no member entries
    expect(decls.filter((d) => d.symbol === "Buffer" && d.kind === "member").map((d) => d.line)).toEqual([66]);
    expect(decls.filter((d) => d.symbol === "Vec2").map((d) => d.kind)).toEqual(["type"]);
  });
});

describe("declarationsIn — C/C++ source and body statements", () => {
  it("out-of-line members carry their class as container; nothing inside a body, initializer or lambda is a declaration", () => {
    const source = lines(
      "#include \"engine.hpp\"",
      "namespace engine {",
      "Renderer::Renderer(int w, int h) : width_(w), height_{h} {",
      "  init();",
      "}",
      "Renderer::~Renderer() { shutdown(); }",
      "void Renderer::draw(const Scene& scene) {",
      "  for (auto& e : scene.entities) {",
      "    e.render(*this);",
      "  }",
      "  auto lambda = [](int x) { return x + 1; };",
      "  helper(3);",
      "  int local = compute(1);",
      "  return;",
      "}",
      "int Renderer::width() const noexcept { return width_; }",
      "static int counter = 0;",
      "std::vector<int> Renderer::indices() {",
      "  return {};",
      "}",
      "template <typename T>",
      "void Buffer<T>::grow() {",
      "  if (size_ > 0) foo(size_);",
      "}",
      "int main(int argc, char** argv) {",
      "  Renderer r(800, 600);",
      "  r.draw(scene);",
      "  return 0;",
      "}",
      "}  // namespace engine",
    );
    const decls = declarationsIn("engine.cpp", source);
    expect(rows(decls)).toEqual([
      "3 Renderer member pub in Renderer",
      "7 draw member pub in Renderer",
      "16 width member pub in Renderer",
      "17 counter variable priv",
      "18 indices member pub in Renderer",
      "22 grow member pub in Buffer",
      "25 main function pub",
    ]);
  });

  it("skips #if 0 regions and follows alternative #ifdef branches without losing its place", () => {
    const source = lines(
      "#if 0",
      "void dead_code() {}",
      "#else",
      "void live_code() {}",
      "#endif",
      "#ifdef _WIN32",
      "int platform(void) {",
      "#else",
      "int platform(void) {",
      "#endif",
      "  return 1;",
      "}",
      "void after_platform(void) {}",
      "const char* shader = R\"GLSL(",
      "#version 330",
      "void fake_in_raw_string() {}",
      ")GLSL\";",
      "void after_raw() {}",
      "#ifdef __cplusplus",
      "extern \"C\" {",
      "#endif",
      "void guarded_c(void);",
      "#ifdef __cplusplus",
      "}",
      "#endif",
      "void after_guard(void);",
    );
    const decls = declarationsIn("mix.cpp", source);
    expect(namesOf(decls)).toEqual(["live_code", "platform", "after_platform", "shader", "after_raw", "guarded_c", "after_guard"]);
  });

  it("C: typedef struct/enum names their members, function pointers, K&R definitions, GNU-style split declarations", () => {
    const source = lines(
      "#define BUF_SIZE 256",
      "struct point { int x; int y; };",
      "typedef struct { int a; int b; } pair_t;",
      "typedef enum { E_OK, E_FAIL = -1 } status_t;",
      "static const int table[] = { 1, 2, 3 };",
      "int global_count;",
      "extern const char *names[];",
      "static int",
      "helper(int a,",
      "       int b)",
      "{",
      "    int local = a + b;",
      "    return local;",
      "}",
      "int public_fn(const char *s, size_t n);",
      "void (*signal_handler(int sig, void (*func)(int)))(int);",
      "int oldstyle(a, b)",
      "    int a;",
      "    int b;",
      "{",
      "    return a + b;",
      "}",
      "DEFINE_THING(x);",
      "MODULE_LICENSE(\"GPL\");",
    );
    expect(rows(declarationsIn("util.c", source))).toEqual([
      "1 BUF_SIZE macro pub",
      "2 point type pub",
      "2 x member pub in point",
      "2 y member pub in point",
      "3 a member pub in pair_t",
      "3 b member pub in pair_t",
      "3 pair_t type pub",
      "4 E_OK enum-member pub in status_t",
      "4 E_FAIL enum-member pub in status_t",
      "4 status_t type pub",
      "5 table constant priv",
      "6 global_count variable pub",
      "7 names variable pub",
      "9 helper function priv",
      "15 public_fn function pub",
      "16 signal_handler function pub",
      "17 oldstyle function pub",
    ]);
  });

  it("access labels end macros that ran into them; operators, friends, requires-clauses and templates behave", () => {
    const source = lines(
      "template <typename T>",
      "concept Numeric = std::is_arithmetic_v<T>;",
      "template <Numeric T>",
      "requires (sizeof(T) > 2)",
      "T add(T a, T b);",
      "class Widget : public QObject {",
      "  Q_OBJECT",
      "  Q_PROPERTY(int value READ value WRITE setValue NOTIFY valueChanged)",
      "public:",
      "  explicit Widget(QObject *parent = nullptr);",
      "  int value() const;",
      "public slots:",
      "  void setValue(int v);",
      "signals:",
      "  void valueChanged(int v);",
      "private:",
      "  int value_;",
      "  friend class Other;",
      "  friend void swap(Widget&, Widget&);",
      "  bool operator==(const Widget& o) const { return true; }",
      "  operator bool() const { return true; }",
      "  template <typename T> void visit(T&& t);",
      "  DISALLOW_COPY_AND_ASSIGN(Widget);",
      "};",
      "extern template class Stack<int>;",
      "template class Stack<double>;",
      "static_assert(sizeof(int) == 4, \"int size\");",
      "using namespace std;",
      "using std::string;",
      "namespace fs = std::filesystem;",
    );
    expect(rows(declarationsIn("w.hpp", source))).toEqual([
      "2 Numeric type pub",
      "5 add function pub",
      "6 Widget type pub",
      "11 value member pub in Widget",
      "13 setValue member pub in Widget",
      "15 valueChanged member pub in Widget",
      "17 value_ member priv in Widget",
      "22 visit member priv in Widget",
    ]);
  });

  it("Objective-C interfaces, properties and methods", () => {
    const source = lines(
      "#import <Foundation/Foundation.h>",
      "@interface Foo : NSObject <Proto> {",
      "  int _ivar;",
      "}",
      "@property (nonatomic, strong) NSString *title;",
      "- (void)doThing:(int)x with:(NSString *)y;",
      "+ (instancetype)shared;",
      "@end",
      "@implementation Foo",
      "- (void)doThing:(int)x with:(NSString *)y {",
      "  NSLog(@\"x=%d\", x);",
      "}",
      "@end",
      "static int helper(int a) { return a; }",
    );
    expect(rows(declarationsIn("Foo.m", source))).toEqual([
      "2 Foo type pub",
      "5 title member pub in Foo",
      "6 doThing member pub in Foo",
      "7 shared member pub in Foo",
      "9 Foo type pub",
      "10 doThing member pub in Foo",
      "14 helper function priv",
    ]);
  });

  it("a slice that starts inside a scope reports nothing until the scope closes", () => {
    expect(rows(declarationsIn("s.cpp", lines("    int x = compute(1);", "    foo(x);", "    return x;", "}", "", "void after_close() {}")))).toEqual([
      "6 after_close function pub",
    ]);
    expect(rows(declarationsIn("s.hpp", lines("  void member();", "  int field;", "};", "", "void top_level();")))).toEqual([
      "5 top_level function pub",
    ]);
  });

  it("scans every C-family extension and no other", () => {
    const body = lines("int f(int x);");
    for (const ext of [".c", ".h", ".cc", ".cpp", ".cxx", ".c++", ".hh", ".hpp", ".hxx", ".h++", ".inl", ".ipp", ".tpp", ".cu", ".cuh", ".m", ".mm"]) {
      expect(namesOf(declarationsIn(`a${ext}`, body)), ext).toEqual(["f"]);
    }
    expect(declarationsIn("a.txt", body)).toEqual([]);
    expect(declarationsIn("a.rs", body)).toEqual([]);
  });

  it("stays fast on a 4,200-line file and terminates on unbalanced input", () => {
    const rowsOut: string[] = ["#include <vector>", "namespace big {"];
    for (let i = 0; i < 300; i++) {
      rowsOut.push(`class Widget${i} : public Base {`, " public:", `  Widget${i}(int a, int b) : a_(a), b_{b} { init(); }`, `  int value() const { return a_ + b_ * ${i}; }`, `  static constexpr int kId = ${i};`, " private:", "  int a_;", "  int b_;", "};");
      rowsOut.push(`inline int helper${i}(int x) {`, "  if (x > 3) { return foo(x) + bar(x, 2); }", "  for (int k = 0; k < x; ++k) { total += k; }", "  return x;", "}");
    }
    rowsOut.push("}");
    const body = rowsOut.join("\n");
    expect(rowsOut.length).toBeGreaterThan(4000);
    declarationsIn("big.cpp", body); // warm
    const started = process.hrtime.bigint();
    let found = 0;
    for (let i = 0; i < 5; i++) found = declarationsIn("big.cpp", body).length;
    const perScanMs = Number(process.hrtime.bigint() - started) / 1e6 / 5;
    // stated bound: under 250 ms per scan of a 4,200-line dense C++ file (typically ~15 ms)
    expect(perScanMs).toBeLessThan(250);
    expect(found).toBeGreaterThan(500);
    const pathological = "(".repeat(3000) + "\n" + "{".repeat(3000) + "\n" + "class X {\n".repeat(500) + "#if\n".repeat(500);
    expect(() => declarationsIn("bad.cpp", pathological)).not.toThrow();
    expect(() => declarationsIn("bad.h", "}".repeat(2000) + ")".repeat(2000))).not.toThrow();
  });
});

describe("declarationsIn — Go", () => {
  const source = lines(
    "package main",
    "",
    "import (",
    "\t\"fmt\"",
    ")",
    "",
    "/*",
    "const InComment = 1",
    "*/",
    "// Version doc",
    "const Version = \"1.0\"",
    "const a, B = 1, 2",
    "",
    "const (",
    "\t// Red is red",
    "\tRed Color = iota",
    "\tGreen",
    "\tBlue",
    "\t_",
    "\tmaxColor = Blue + 1",
    "\tLong = 1 +",
    "\t\t2",
    ")",
    "",
    "var (",
    "\tErrNotFound = errors.New(\"not found\")",
    "\tcounter     int",
    "\ttable = map[string]int{",
    "\t\t\"a\": 1,",
    "\t\t\"b\": 2,",
    "\t}",
    "\tfn = func() {",
    "\t\tx := 1",
    "\t}",
    ")",
    "",
    "var Global int",
    "type Color int",
    "type (",
    "\tHandler func(w int)",
    "\tConfig struct {",
    "\t\tName string",
    "\t}",
    "\tStack[T any] struct{}",
    ")",
    "",
    "func (s *Server) Handle(x int) error { return nil }",
    "func (Server) Name() string { return \"\" }",
    "func (s Stack[T]) Push(v T) {}",
    "func main() {",
    "\tconst local = 1",
    "\tvar v = 2",
    "\tfmt.Println(local, v)",
    "}",
    "var raw = `",
    "func fake() {}",
    "const Fake = 1",
    "`",
  );

  it("const/var (single-line and blocks, iota members), type blocks and methods with their receiver type", () => {
    expect(rows(declarationsIn("main.go", source))).toEqual([
      "11 Version constant pub",
      "12 a constant priv",
      "12 B constant pub",
      "16 Red constant pub",
      "17 Green constant pub",
      "18 Blue constant pub",
      "20 maxColor constant priv",
      "21 Long constant pub",
      "26 ErrNotFound variable pub",
      "27 counter variable priv",
      "28 table variable priv",
      "32 fn variable priv",
      "37 Global variable pub",
      "38 Color type pub",
      "40 Handler type pub",
      "41 Config type pub",
      "44 Stack type pub",
      "47 Handle member pub in Server",
      "48 Name member pub in Server",
      "49 Push member pub in Stack",
      "50 main function priv",
      "55 raw variable priv",
    ]);
  });

  it("never reports locals, comments, raw-string contents or the continuation of an expression", () => {
    const names = namesOf(declarationsIn("main.go", source));
    for (const never of ["InComment", "Fake", "fake", "local", "v", "x", "_"]) expect(names, never).not.toContain(never);
  });
});

describe("declarationsIn — Java", () => {
  const source = lines(
    "package p;",
    "import static java.lang.Math.*;",
    "",
    "/**",
    " * public class Fake {}",
    " */",
    "@SuppressWarnings({\"unchecked\", \"rawtypes\"})",
    "public abstract class Service<T extends Comparable<T>> implements Runnable {",
    "    public static final String NAME = \"svc\", ALT = \"alt\";",
    "    public static final int[] PRIMES = {2, 3, 5};",
    "    private static final Map<String, List<Integer>> CACHE = new HashMap<>() {{ put(\"a\", null); }};",
    "    protected static final long TIMEOUT = 30L * 1000;",
    "    public int notConstant = 5;",
    "    private final int alsoNot = 1;",
    "",
    "    @Autowired private Repo repo;",
    "",
    "    public Service(int x) { this.x = x; }",
    "",
    "    @GetMapping(\"/items\")",
    "    public abstract void run(String... args) throws Exception;",
    "",
    "    public static <R> R with(Supplier<R> s) { return s.get(); }",
    "",
    "    public interface Listener { void on(Event e); int PRIORITY = 1; }",
    "",
    "    enum Level { LOW(1), HIGH(2) { @Override int weight() { return 9; } }; final int w; Level(int w) { this.w = w; } int weight() { return w; } }",
    "",
    "    private int helper() {",
    "        Runnable r = new Runnable() { public void run() {} };",
    "        String text = \"\"\"",
    "            public class InText { }",
    "            \"\"\";",
    "        int local = 5;",
    "        return local;",
    "    }",
    "",
    "    record Point(int x, int y) { static final int ORIGIN = 0; public int sum() { return x + y; } }",
    "}",
    "class Second {}",
  );

  it("static final and interface constants, enum constants, methods (container, exported iff public), nested types", () => {
    expect(rows(declarationsIn("Service.java", source))).toEqual([
      "8 Service type pub",
      "9 NAME constant pub in Service",
      "9 ALT constant pub in Service",
      "10 PRIMES constant pub in Service",
      "11 CACHE constant priv in Service",
      "12 TIMEOUT constant priv in Service",
      "21 run member pub in Service",
      "23 with member pub in Service",
      "25 Listener type pub in Service",
      "25 on member pub in Listener",
      "25 PRIORITY constant pub in Listener",
      "27 Level type priv in Service",
      "27 LOW enum-member priv in Level",
      "27 HIGH enum-member priv in Level",
      "27 weight member priv in Level",
      "29 helper member priv in Service",
      "38 Point type priv in Service",
      "38 ORIGIN constant priv in Point",
      "38 sum member priv in Point",
      "40 Second type priv",
    ]);
  });

  it("a slice that starts inside a class body reads its members without a container; a method-body slice reports nothing", () => {
    expect(
      rows(
        declarationsIn(
          "Slice.java",
          lines(
            "    public static final int MAX = 10;",
            "    private int count;",
            "    public void run(String a) {",
            "        int local = compute(a);",
            "        return;",
            "    }",
            "    static class Inner { static final int K = 1; }",
          ),
        ),
      ),
    ).toEqual(["1 MAX constant pub", "3 run member pub", "7 Inner type priv", "7 K constant priv in Inner"]);
    expect(
      declarationsIn(
        "Body.java",
        lines(
          "        int total = 0;",
          "        for (int i = 0; i < 3; i++) { total += compute(i); }",
          "        if (total > 1) { log(total); } else if (total < 0) { throw fail(total); }",
          "        final int LOCAL = 5;",
          "        return format(total);",
        ),
      ),
    ).toEqual([]);
  });

  it("never reports fields that are not constants, constructors, locals, anonymous-class members or comment/text-block contents", () => {
    const names = namesOf(declarationsIn("Service.java", source));
    for (const never of ["notConstant", "alsoNot", "repo", "local", "r", "text", "Fake", "InText", "x", "y", "run2"]) expect(names, never).not.toContain(never);
    expect(names.filter((n) => n === "run")).toHaveLength(1);
  });
});

describe("declarationsIn — Kotlin", () => {
  const source = lines(
    "package p",
    "",
    "import kotlin.math.*",
    "",
    "const val MAX = 10",
    "val DEFAULT_NAME = \"x\"",
    "val lower = 5",
    "var mutable = 1",
    "private val hidden = 2",
    "",
    "/** class Fake */",
    "data class User(",
    "    val id: Int,",
    "    val name: String",
    ") : Base() {",
    "    val label: String = \"x\"",
    "    fun greet() = \"hi \\${name}\"",
    "    companion object {",
    "        const val TAG = \"user\"",
    "        fun create(): User = TODO()",
    "    }",
    "    private fun secret() {}",
    "}",
    "",
    "enum class Color(val rgb: Int) {",
    "    RED(1), GREEN(2),",
    "    BLUE(3) {",
    "        override fun x() {}",
    "    };",
    "",
    "    fun label() = name",
    "}",
    "",
    "enum class Simple { A, B, C }",
    "",
    "interface Api {",
    "    fun call()",
    "    val size: Int",
    "}",
    "",
    "object Singleton {",
    "    val INSTANCE_NAME = \"s\"",
    "    fun run() {",
    "        val local = 1",
    "    }",
    "}",
    "",
    "fun <T> List<T>.second(): T = this[1]",
    "fun topLevel(x: Int): Int {",
    "    val inner = 2",
    "    fun nested() {}",
    "    return x",
    "}",
    "typealias Names = List<String>",
    "sealed class Result {",
    "    class Ok : Result()",
    "}",
    "val multi = \"\"\"",
    "    fun fake() {}",
    "\"\"\"",
    "val String.lastChar: Char get() = this[length - 1]",
  );

  it("types, top-level fun/val/var/const val, enum entries, members with container", () => {
    expect(rows(declarationsIn("Main.kt", source))).toEqual([
      "5 MAX constant pub",
      "6 DEFAULT_NAME constant pub",
      "7 lower variable pub",
      "8 mutable variable pub",
      "9 hidden variable priv",
      "12 User type pub",
      "16 label member pub in User",
      "17 greet member pub in User",
      "19 TAG constant pub in User",
      "20 create member pub in User",
      "22 secret member priv in User",
      "25 Color type pub",
      "26 RED enum-member pub in Color",
      "26 GREEN enum-member pub in Color",
      "27 BLUE enum-member pub in Color",
      "31 label member pub in Color",
      "34 Simple type pub",
      "34 A enum-member pub in Simple",
      "34 B enum-member pub in Simple",
      "34 C enum-member pub in Simple",
      "36 Api type pub",
      "37 call member pub in Api",
      "38 size member pub in Api",
      "41 Singleton type pub",
      "42 INSTANCE_NAME constant pub in Singleton",
      "43 run member pub in Singleton",
      "48 second function pub",
      "49 topLevel function pub",
      "54 Names type pub",
      "55 Result type pub",
      "56 Ok type pub in Result",
      "58 multi variable pub",
      "61 lastChar variable pub",
    ]);
  });

  it("never reports locals, nested functions, constructor parameters or comment/raw-string contents", () => {
    const names = namesOf(declarationsIn("Main.kt", source));
    for (const never of ["local", "inner", "nested", "id", "name", "Fake", "fake"]) expect(names, never).not.toContain(never);
  });

  it("a slice starting inside a scope reports only modifier-led members (a local cannot carry one) and nested types", () => {
    expect(rows(declarationsIn("Slice.kt", lines("    val member = 1", "    fun method() {}", "}", "fun topLevel() {}")))).toEqual(["4 topLevel function pub"]);
    expect(
      rows(
        declarationsIn(
          "Slice2.kt",
          lines("    const val TAG = \"x\"", "    private val cache = mutableMapOf<String, Int>()", "    val plain = 1", "    override fun close() {}", "    data class Row(val id: Int)"),
        ),
      ),
    ).toEqual(["1 TAG constant pub", "2 cache member priv", "4 close member pub", "5 Row type pub"]);
    expect(declarationsIn("Body.kt", lines("        val total = compute(1)", "        var count = 0", "        fun inner() {}", "        return total"))).toEqual([]);
  });
});

describe("declarationsIn — Python", () => {
  const source = lines(
    "\"\"\"Module docstring",
    "class Fake:",
    "    pass",
    "X = 1",
    "\"\"\"",
    "import os",
    "MAX_RETRIES = 5",
    "timeout: int = 30",
    "_private = 1",
    "__all__ = [\"a\"]",
    "A, B = 1, 2",
    "x == 3",
    "else: y = 1",
    "call(",
    "    name=\"x\",",
    "    other=1,",
    ")",
    "BIG = {",
    "    \"a\": 1,",
    "}",
    "def func():",
    "    inner = 1",
    "class Color(Enum):",
    "    RED = 1",
    "    GREEN = auto()",
    "    _ignore_ = 5",
    "    def method(self): pass",
    "    BLUE: int = 3",
    "class Sub(enum.IntEnum):",
    "    ONE = 1",
    "    TWO = 2",
    "",
    "    class Meta:",
    "        X = 1",
    "class Plain:",
    "    CONST = 1",
    "if True:",
    "    IN_IF = 1",
    "async def afn(): pass",
  );

  it("column-0 assignments (constant vs variable), enum members with container, defs and classes as before", () => {
    expect(rows(declarationsIn("mod.py", source))).toEqual([
      "7 MAX_RETRIES constant pub",
      "8 timeout variable pub",
      "9 _private variable priv",
      "11 A constant pub",
      "11 B constant pub",
      "18 BIG constant pub",
      "21 func function pub",
      "23 Color type pub",
      "24 RED enum-member pub in Color",
      "25 GREEN enum-member pub in Color",
      "29 Sub type pub",
      "30 ONE enum-member pub in Sub",
      "31 TWO enum-member pub in Sub",
      "35 Plain type pub",
      "39 afn function pub",
    ]);
  });

  it("never reports docstring contents, keyword arguments spread over lines, comparisons, dunder names or nested/indented assignments", () => {
    const names = namesOf(declarationsIn("mod.py", source));
    for (const never of ["Fake", "X", "x", "y", "name", "other", "__all__", "inner", "CONST", "IN_IF", "_ignore_", "BLUE", "method"]) expect(names, never).not.toContain(never);
  });
});

describe("declarationsIn — TypeScript / JavaScript", () => {
  const source = lines(
    "import { x } from \"./y\";",
    "// export function commented() {}",
    "/* export class InBlock {} */",
    "export enum Color { Red, Green = 2, Blue = \"b\", 'Quoted-Key' = 4 }",
    "export const enum Dir {",
    "  Up = 1,",
    "  Down,",
    "}",
    "export const Theme = {",
    "  primary: '#fff',",
    "  'font-size': 12,",
    "  spacing: { sm: 4, md: 8 },",
    "  method() { return 1; },",
    "  get thing() { return 2; },",
    "  [computed]: 1,",
    "  ...spread,",
    "  shorthand,",
    "} as const;",
    "export const Frozen = Object.freeze({ a: 1, b: 2 });",
    "export const notObject = 5;",
    "export function doIt(): void {}",
    "export default class Foo {}",
    "export default abstract class Bar {}",
    "export abstract class Baz {}",
    "export declare function dec(): void;",
    "export namespace NS { export const A = 1; }",
    "function local() {}",
    "class Local {}",
    "const re = /export function inRegex\\(\\)/;",
    "const tpl = `",
    "export function inTemplate() {}",
    "`;",
    "export type T = string;",
    "export interface I { a: number }",
    "export default class extends Base {}",
    "declare function ambientFn(): void;",
    "declare const AMBIENT: number;",
    "abstract class Internal {}",
  );

  it("enum members, exported const object keys (top level only), extra export forms; keywords never symbols", () => {
    expect(rows(declarationsIn("mod.ts", source))).toEqual([
      "4 Color type pub",
      "4 Red enum-member pub in Color",
      "4 Green enum-member pub in Color",
      "4 Blue enum-member pub in Color",
      "4 Quoted-Key enum-member pub in Color",
      "5 Dir type pub",
      "6 Up enum-member pub in Dir",
      "7 Down enum-member pub in Dir",
      "9 Theme constant pub",
      "10 primary member pub in Theme",
      "11 font-size member pub in Theme",
      "12 spacing member pub in Theme",
      "13 method member pub in Theme",
      "14 thing member pub in Theme",
      "17 shorthand member pub in Theme",
      "19 Frozen constant pub",
      "19 a member pub in Frozen",
      "19 b member pub in Frozen",
      "20 notObject constant pub",
      "21 doIt function pub",
      "22 Foo type pub",
      "23 Bar type pub",
      "24 Baz type pub",
      "25 dec function pub",
      "26 NS type pub",
      "27 local function priv",
      "28 Local type priv",
      "33 T type pub",
      "34 I type pub",
      "36 ambientFn function priv",
      "37 AMBIENT constant priv",
      "38 Internal type priv",
    ]);
    // in a declaration file the ambient declarations are global
    expect(pick(declarationsIn("types.d.ts", lines("declare function ambientFn(): void;", "declare const AMBIENT: number;")), "ambientFn", "AMBIENT")).toEqual([
      "1 ambientFn function pub",
      "2 AMBIENT constant pub",
    ]);
  });

  it("nothing from comments, regex literals, template literals or nested object levels", () => {
    const names = namesOf(declarationsIn("mod.ts", source));
    for (const never of ["commented", "InBlock", "inRegex", "inTemplate", "sm", "md", "computed", "spread", "extends", "enum"]) expect(names, never).not.toContain(never);
  });
});

// ---------------------------------------------------------------------------
// The pre-existing scan, unchanged
// ---------------------------------------------------------------------------

/** The declaration scan as it was before this wave: the oracle the differential test compares against. */
function legacyDeclarationsIn(filePath: string, body: string): Array<{ symbol: string; line: number; exported: boolean }> {
  const TS_EXPORTED_RE = /^\s*export\s+(?:default\s+)?(?:async\s+)?(function\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/;
  const TS_TOPLEVEL_RE = /^(?:async\s+)?(function\*?|class)\s+([A-Za-z_$][\w$]*)/;
  const PY_DEF_RE = /^(?:async\s+)?def\s+([A-Za-z_]\w*)/;
  const PY_CLASS_RE = /^class\s+([A-Za-z_]\w*)/;
  const GO_DECL_RE = /^(func\s+(?:\([^)]*\)\s*)?|type\s+)([A-Za-z_]\w*)/;
  const JAVA_TYPE_RE = /^\s*(?:public\s+)?(?:static\s+)?(?:final\s+)?(?:abstract\s+)?(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/;
  const ext = path.posix.extname(filePath.replace(/\\/g, "/")).toLowerCase();
  const all = body.split(/\r?\n/);
  const out: Array<{ symbol: string; line: number; exported: boolean }> = [];
  for (let i = 0; i < Math.min(all.length, 4000); i++) { // the oracle keeps the old 4,000-line window; the corpora here are shorter
    const line = all[i]!;
    if (isLineComment(line, ext === ".py")) continue;
    if ([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"].includes(ext)) {
      const exported = TS_EXPORTED_RE.exec(line);
      if (exported?.[2]) { out.push({ symbol: exported[2], line: i + 1, exported: true }); continue; }
      const top = TS_TOPLEVEL_RE.exec(line);
      if (top?.[2]) out.push({ symbol: top[2], line: i + 1, exported: false });
    } else if (ext === ".py") {
      const def = PY_DEF_RE.exec(line);
      if (def?.[1]) { out.push({ symbol: def[1], line: i + 1, exported: true }); continue; }
      const cls = PY_CLASS_RE.exec(line);
      if (cls?.[1]) out.push({ symbol: cls[1], line: i + 1, exported: true });
    } else if (ext === ".go") {
      const decl = GO_DECL_RE.exec(line);
      if (decl?.[2]) out.push({ symbol: decl[2], line: i + 1, exported: /^[A-Z]/.test(decl[2]) });
    } else if (ext === ".java") {
      const decl = JAVA_TYPE_RE.exec(line);
      if (decl?.[1]) out.push({ symbol: decl[1], line: i + 1, exported: /^\s*public\b/.test(line) });
    }
  }
  return out;
}

describe("declarationsIn — existing TS / Python / Go / Java results are unchanged", () => {
  const corpus: Array<[string, string]> = [
    ["shop.ts", lines(
      "import { a } from \"./a.js\";",
      "export interface Order { id: string }",
      "export type Id = string;",
      "export const TAX_RATE = 0.2;",
      "export let counter = 0;",
      "export var legacy = 1;",
      "export async function fetchOrder(id: string): Promise<Order> { return null as never; }",
      "export function* ids() { yield 1; }",
      "export default function main() {}",
      "export class OrderService {",
      "  private cache = new Map();",
      "  async load() {}",
      "}",
      "function internal() {}",
      "async function internalAsync() {}",
      "class Internal {}",
      "const arrow = () => 1;",
      "  export function indented() {}",
      "// export function commented() {}",
      " * export function docLine() {}",
    )],
    ["util.jsx", lines("export function App() { return null; }", "export const VERSION = '1';", "function helper() {}", "class Legacy {}")],
    ["service.py", lines(
      "import os",
      "",
      "def top_level(a, b):",
      "    def nested(): pass",
      "    return a",
      "",
      "async def fetch():",
      "    pass",
      "",
      "class Repo(Base):",
      "    def method(self): pass",
      "    class Inner: pass",
      "",
      "class Second: pass",
      "# def commented(): pass",
    )],
    ["server.go", lines(
      "package server",
      "",
      "type Server struct{ name string }",
      "type handler func()",
      "func NewServer() *Server { return &Server{} }",
      "func (s *Server) Start() error { return nil }",
      "func (s Server) stop() {}",
      "func helper() {}",
      "func Generic[T any](v T) T { return v }",
      "// func commented() {}",
      "\tfunc indented() {}",
    )],
    ["Order.java", lines(
      "package shop;",
      "",
      "public class Order {",
      "    public static final int MAX = 5;",
      "    public interface Visitor { void visit(); }",
      "    static class Helper {}",
      "    private enum State { A, B }",
      "    public final class Locked {}",
      "    abstract class Base {}",
      "    public record Point(int x, int y) {}",
      "    public static abstract class Both {}",
      "    // class Commented {}",
      "}",
      "interface Api {}",
      "final class Sealed {}",
    )],
  ];

  it.each(corpus)("%s: every result of the old scan is still returned with the same symbol, line and exported", (file, body) => {
    const now = declarationsIn(file, body);
    for (const old of legacyDeclarationsIn(file, body)) {
      const hit = now.find((d) => d.symbol === old.symbol && d.line === old.line);
      expect(hit, `${file}: ${old.symbol}@${old.line}`).toBeDefined();
      expect(hit!.exported, `${file}: ${old.symbol}@${old.line} exported`).toBe(old.exported);
    }
  });

  it("the old scan's TS results on this repository's own task-pack sources are all still returned", () => {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "features", "task-pack");
    for (const name of ["importGraphShared.ts", "importResolution.ts", "usageInventory.ts", "frontierNeighbours.ts", "importResolveGo.ts"]) {
      const body = fs.readFileSync(path.join(dir, name), "utf8");
      const now = declarationsIn(name, body);
      for (const old of legacyDeclarationsIn(name, body)) {
        const hit = now.find((d) => d.symbol === old.symbol && d.line === old.line);
        expect(hit, `${name}: ${old.symbol}@${old.line}`).toBeDefined();
        expect(hit!.exported).toBe(old.exported);
      }
    }
  });

  it("fills kind and container only where the scan can tell: functions, types and methods", () => {
    const go = declarationsIn("server.go", corpus[3]![1]);
    expect(pick(go, "Server", "handler", "NewServer", "Start", "stop")).toEqual([
      "3 Server type pub",
      "4 handler type priv",
      "5 NewServer function pub",
      "6 Start member pub in Server",
      "7 stop member priv in Server",
    ]);
    const ts = declarationsIn("shop.ts", corpus[0]![1]);
    expect(pick(ts, "Order", "Id", "TAX_RATE", "counter", "fetchOrder", "OrderService", "internal")).toEqual([
      "2 Order type pub",
      "3 Id type pub",
      "4 TAX_RATE constant pub",
      "5 counter variable pub",
      "7 fetchOrder function pub",
      "10 OrderService type pub",
      "14 internal function priv",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Real-world shapes and robustness
// ---------------------------------------------------------------------------

describe("declarationsIn — shapes seen in real C/C++ code", () => {
  it("bare namespace macros that run into a declaration (no semicolon) do not hide it", () => {
    const source = lines(
      "FMT_BEGIN_NAMESPACE",
      "",
      "template <typename Char, typename Traits, typename Allocator>",
      "struct is_contiguous<std::basic_string<Char, Traits, Allocator>>",
      "    : std::true_type {};",
      "",
      "namespace detail {",
      "inline auto clz(uint32_t x) -> int { return 0; }",
      "}  // namespace detail",
      "",
      "FMT_END_NAMESPACE",
      "",
      "G_BEGIN_DECLS",
      "GType foo_get_type(void);",
      "G_END_DECLS",
    );
    expect(rows(declarationsIn("format.h", source))).toEqual([
      "4 is_contiguous type pub",
      "8 clz function pub",
      "14 foo_get_type function pub",
    ]);
  });

  it("an out-of-line static data member is a member of its class; a namespace-qualified variable stays a variable", () => {
    const source = lines(
      "namespace app {",
      "int counter = 0;",
      "}",
      "const int Widget::kLimit = 10;",
      "std::string Widget::name_;",
      "int app::counter2 = 1;",
    );
    expect(rows(declarationsIn("w.cpp", source))).toEqual([
      "2 counter variable pub",
      "4 kLimit constant pub in Widget",
      "5 name_ member pub in Widget",
      "6 counter2 variable pub",
    ]);
  });

  it("quoted object keys may carry dots and dashes; Python accepts a parenthesized tuple target", () => {
    expect(
      pick(declarationsIn("t.ts", lines("export const Types = {", "  'read.text': 1,", "  \"font-size\": 2,", "  '404': 3,", "  'a b': 4,", "} as const;")), "read.text", "font-size", "404", "a b"),
    ).toEqual(["2 read.text member pub in Types", "3 font-size member pub in Types"]);
    expect(rows(declarationsIn("c.py", lines("(MONDAY, TUESDAY) = range(2)", "[A, B] = 1, 2")))).toEqual(["1 MONDAY constant pub", "1 TUESDAY constant pub"]);
  });

  it("with more than 32 directories in compile_commands.json, the ones nearest to a header survive the root cap", () => {
    const files: Record<string, string> = { "p/CMakeLists.txt": "project(p)\n", "p/libs/near/include/near.h": "", "p/libs/near/src/a.cpp": lines("#include <near.h>") };
    const entries: unknown[] = [];
    for (let i = 0; i < 60; i++) {
      files[`p/other${i}/inc/o${i}.h`] = "";
      entries.push({ directory: "/w", command: `cc -I/w/p/other${i}/inc -c x${i}.cpp`, file: `x${i}.cpp` });
    }
    const ws = makeWorkspace("ccdb-many", files);
    const abs = (rel: string): string => path.join(ws, rel);
    writeFile(
      ws,
      "p/build/compile_commands.json",
      JSON.stringify([
        ...entries.map((e, i) => ({ ...(e as object), directory: abs("p/build"), command: `cc -I${abs(`p/other${i}/inc`)} -c x${i}.cpp` })),
        { directory: abs("p/build"), command: `cc -I${abs("p/libs/near/include")} -c y.cpp`, file: "y.cpp" },
      ]),
    );
    // a header has no entry of its own: the union is capped, nearest directories first
    writeFile(ws, "p/libs/near/src/hdr.hpp", lines("#include <near.h>"));
    expect(pathsOf(includesOf(ws, "p/libs/near/src/hdr.hpp"))).toEqual(["p/libs/near/include/near.h"]);
  });
});

describe("declarationsIn — robustness", () => {
  it("never throws and stays bounded on random token soup and on mutated real sources", () => {
    let seed = 20260930;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const vocab = ["{", "}", "(", ")", "[", "]", ";", ",", ":", "::", "<", ">", "=", "*", "&", "#if", "#else", "#endif", "#define X", "#include <a.h>", "class", "struct", "enum", "namespace", "template", "typedef", "using", "static", "const", "int", "void", "foo", "Bar", "x_", "operator", "public:", "extern \"C\"", "\"str\"", "'c'", "/*", "*/", "//", "\\", "R\"(", ")\"", "@interface", "@end", "-", "func", "type", "var", "package", "fun", "val", "object", "interface", "def", "export", "record", "@", "..."];
    const extensions = [".cpp", ".h", ".go", ".java", ".kt", ".py", ".ts", ".m", ".c"];
    const started = process.hrtime.bigint();
    for (let iter = 0; iter < 600; iter++) {
      const parts: string[] = [];
      const n = 5 + Math.floor(rnd() * 400);
      for (let i = 0; i < n; i++) parts.push(vocab[Math.floor(rnd() * vocab.length)]! + (rnd() < 0.2 ? "\n" : " "));
      const ext = extensions[Math.floor(rnd() * extensions.length)]!;
      expect(() => declarationsIn(`fuzz${ext}`, parts.join("")), `iteration ${iter} ${ext}`).not.toThrow();
    }
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "features", "task-pack");
    const real = fs.readFileSync(path.join(dir, "usageInventory.ts"), "utf8");
    for (let iter = 0; iter < 60; iter++) {
      let mutated = real;
      for (let k = 0; k < 3; k++) {
        const at = Math.floor(rnd() * mutated.length);
        mutated = mutated.slice(0, at) + (rnd() < 0.5 ? "" : vocab[Math.floor(rnd() * vocab.length)]!) + mutated.slice(at + Math.floor(rnd() * 300));
      }
      expect(() => declarationsIn("usageInventory.ts", mutated)).not.toThrow();
      expect(() => declarationsIn("usageInventory.cpp", mutated)).not.toThrow();
    }
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(15000);
  });

  it("scans past line 4,000 of a large file; a huge body is bounded at 20,000 lines / 1 MiB", () => {
    const filler = Array.from({ length: 5200 }, (_, i) => `// filler line ${i}`);
    const late: Array<[string, string]> = [
      ["server.go", "func LateHandler() {}\nconst LateConst = 1\nvar LateVar int\ntype LateType int\nfunc (s *Server) LateMethod() {}"],
      ["Big.java", "public class Late { public static final int LATE_CONST = 1; public void lateMethod() {} }"],
      ["big.kt", "fun lateFun() {}\nconst val LATE_KT = 1"],
      ["big.py", "def late_def(): pass\nLATE_PY = 1"],
      ["big.ts", "export function lateFn() {}\nexport enum LateEnum { LateMember }"],
      ["big.cpp", "int late_cpp(int x);\nstruct LateStruct { int lateField; };"],
    ];
    for (const [file, tail] of late) {
      const body = [...filler, tail].join("\n");
      const found = namesOf(declarationsIn(file, body));
      const expected: Record<string, string[]> = {
        "server.go": ["LateHandler", "LateConst", "LateVar", "LateType", "LateMethod"],
        "Big.java": ["Late", "LATE_CONST", "lateMethod"],
        "big.kt": ["lateFun", "LATE_KT"],
        "big.py": ["late_def", "LATE_PY"],
        "big.ts": ["lateFn", "LateEnum", "LateMember"],
        "big.cpp": ["late_cpp", "LateStruct", "lateField"],
      };
      expect(found, file).toEqual(expect.arrayContaining(expected[file]!));
    }
    const longLine = "int x" + " ".repeat(5000) + "= 1;";
    expect(() => declarationsIn("long.cpp", longLine + "\n" + "void after();\n")).not.toThrow();
    const manyLines = Array.from({ length: 30000 }, (_, i) => `int v${i};`).join("\n");
    const decls = declarationsIn("many.c", manyLines);
    expect(decls.length).toBeLessThanOrEqual(20000);
    expect(decls.length).toBeGreaterThan(19900);
    // 1 MiB of text bounds the scan even when lines are few and long
    const wide = Array.from({ length: 1500 }, (_, i) => `int w${i}; // ${"x".repeat(1900)}`).join("\n");
    const started = process.hrtime.bigint();
    const wideDecls = declarationsIn("wide.c", wide);
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(1500);
    expect(wideDecls.length).toBeLessThan(1500);
    expect(wideDecls.length).toBeGreaterThan(400);
  });
});

describe("declarationsIn — unterminated input stays linear (review round)", () => {
  const timed = <T>(fn: () => T): { value: T; ms: number } => {
    const started = process.hrtime.bigint();
    const value = fn();
    return { value, ms: Number(process.hrtime.bigint() - started) / 1e6 };
  };

  it("20,000 unterminated `typedef struct {` lines cost milliseconds, and real anonymous typedefs keep their names", () => {
    const open = timed(() => declarationsIn("open.h", "typedef struct {\n".repeat(20000)));
    expect(open.value).toEqual([]);
    // Was about 4 s: every opener looked ahead to the end of the file for a closing brace that never comes.
    expect(open.ms).toBeLessThan(1500);
    const nested = timed(() => declarationsIn("nested.h", "typedef struct {\n".repeat(5000) + "} A;\n".repeat(5000)));
    expect(nested.ms).toBeLessThan(1500);
    // A few thousand real anonymous typedef structs stay far below the lookahead budget: each keeps its name and its members' container.
    const real = Array.from({ length: 3000 }, (_, i) => `typedef struct { int a${i}; int b${i}; } T${i};`).join("\n");
    const decls = declarationsIn("real.h", real);
    expect(decls.filter((d) => d.kind === "type")).toHaveLength(3000);
    expect(pick(decls, "a0", "T0", "a2999", "b2999", "T2999")).toEqual([
      "1 a0 member pub in T0",
      "1 T0 type pub",
      "3000 a2999 member pub in T2999",
      "3000 b2999 member pub in T2999",
      "3000 T2999 type pub",
    ]);
  });

  it("20,000 unterminated `export const X = {` and `export enum E {` lines cost milliseconds", () => {
    const consts = timed(() => declarationsIn("open.ts", "export const X = {\n".repeat(20000)));
    // Was about 5 s: every opener scanned up to 3,000 lines of the next openers.
    expect(consts.value).toHaveLength(20000);
    expect(consts.value.every((d) => d.symbol === "X" && d.kind === "constant")).toBe(true);
    expect(consts.ms).toBeLessThan(1500);
    const enums = timed(() => declarationsIn("open2.ts", "export enum E {\n".repeat(20000)));
    expect(enums.value).toHaveLength(20000);
    expect(enums.ms).toBeLessThan(1500);
    // Sparse openers separated by ordinary lines stay linear as well (each scan ends at the next export statement).
    const sparse = Array.from({ length: 400 }, (_, i) => `export const K${i} = {\n${"  x: {\n".repeat(49)}`).join("");
    expect(timed(() => declarationsIn("sparse.ts", sparse)).ms).toBeLessThan(1500);
  });

  it("an object or enum body ends at its closing bracket, at a `;` between members or at the next module-level statement", () => {
    const decls = declarationsIn(
      "bodies.ts",
      lines(
        "export const routes = {",
        "  home: () =>",
        "    import(\"./home\"),", // a dynamic import inside a value is not a statement
        "  about: 1,",
        "  export: true,", // keys that are keywords
        "  import: false,",
        "};",
        "export const stray = {", // never closed: the next statement ends the scan
        "  lost: 1,",
        "export const after = { kept: 1 };",
        "export const semi = { first: 1; second: 2 };", // not a literal body: the scan stops at the `;`
        "export enum Mode {",
        "  export = 1,",
        "  import = 2,",
        "  Other,",
        "}",
      ),
    );
    expect(rows(decls)).toEqual([
      "1 routes constant pub",
      "2 home member pub in routes",
      "4 about member pub in routes",
      "5 export member pub in routes",
      "6 import member pub in routes",
      "8 stray constant pub",
      "9 lost member pub in stray",
      "10 after constant pub",
      "10 kept member pub in after",
      "11 semi constant pub",
      "11 first member pub in semi",
      "12 Mode type pub",
      "13 export enum-member pub in Mode",
      "14 import enum-member pub in Mode",
      "15 Other enum-member pub in Mode",
    ]);
  });
});

describe("declarationsIn — C library header idioms", () => {
  it("export macros that wrap the return type or the name, OF((…)) parameter wrappers", () => {
    const source = lines(
      "extern NCURSES_EXPORT(int) addch (const chtype);",
      "extern NCURSES_EXPORT(WINDOW *) derwin (WINDOW *, int, int, int, int);",
      "extern NCURSES_EXPORT_VAR(chtype) acs_map[];",
      "ZEXTERN int ZEXPORT deflateInit OF((z_streamp strm, int level));",
      "ZEXTERN gzFile ZEXPORT gzopen64 OF((const char *, const char *));",
      "PyAPI_FUNC(int) PyFoo_Check(PyObject *op);",
      "XMLPARSEAPI(void) XML_SetElementHandler(XML_Parser parser, int a);",
      "BZ_EXTERN int BZ_API(BZ2_bzCompressInit) (bz_stream* strm, int blockSize100k);",
      "LUA_API int (lua_gettop) (lua_State *L);",
      "LDAP_F( int ) ldap_open LDAP_P(( const char *host, int port ));",
    );
    expect(rows(declarationsIn("api.h", source))).toEqual([
      "1 addch function pub",
      "2 derwin function pub",
      "3 acs_map variable pub",
      "4 deflateInit function pub",
      "5 gzopen64 function pub",
      "6 PyFoo_Check function pub",
      "7 XML_SetElementHandler function pub",
      "8 BZ2_bzCompressInit function pub",
      "9 lua_gettop function pub",
      "10 ldap_open function pub",
    ]);
  });

  it("function-pointer typedefs and members with calling-convention or nullability words", () => {
    const source = lines(
      "typedef void (XMLCALL *XML_StartElementHandler)(void *userData, const char *name);",
      "typedef xp_error (xp_colormap_fun) (void *data, int first_color);",
      "typedef voidpf (*alloc_func) OF((voidpf opaque, uInt items, uInt size));",
      "struct Ops { int (* _Nullable _close)(void *); void (*(*getter)(int))(void); };",
      "void (*signal_handler(int sig, void (*func)(int)))(int);",
      "int hook(WINDOW *w);",
    );
    expect(rows(declarationsIn("fp.h", source))).toEqual([
      "1 XML_StartElementHandler type pub",
      "2 xp_colormap_fun type pub",
      "3 alloc_func type pub",
      "4 Ops type pub",
      "4 _close member pub in Ops",
      "4 getter member pub in Ops",
      "5 signal_handler function pub",
      "6 hook function pub",
    ]);
  });

  it("attribute and availability macros around a declaration are not declarations and do not hide it", () => {
    const source = lines(
      "int printf(const char * __restrict, ...) __printflike(1, 2);",
      "__deprecated_msg(\"use snprintf\") int sprintf(char *s, const char *fmt, ...);",
      "extern long timezone __DARWIN_ALIAS(timezone);",
      "extern FILE *__stdinp __swift_nonisolated_unsafe;",
      "__OSX_AVAILABLE(14.0) __IOS_AVAILABLE(17.0)",
      "extern NCURSES_EXPORT(int) get_escdelay (void);",
      "extern NCURSES_EXPORT(int) bkgd (chtype) NCURSES_EXPORT_ABI60(bkgd, );",
      "extern NCURSES_EXPORT(int) next_one (int);",
      "__CHECKINT_INLINE int32_t",
      "__checkint_is_mixed_sign32(int32_t x, int32_t y) {return ((x ^ y) < 0);}",
    );
    const decls = declarationsIn("attrs.h", source);
    expect(rows(decls)).toEqual([
      "1 printf function pub",
      "2 sprintf function pub",
      "3 timezone variable pub",
      "4 __stdinp variable pub",
      "6 get_escdelay function pub",
      "7 bkgd function pub",
      "8 next_one function pub",
      "10 __checkint_is_mixed_sign32 function pub",
    ]);
    for (const never of ["__printflike", "__deprecated_msg", "__DARWIN_ALIAS", "__swift_nonisolated_unsafe", "__OSX_AVAILABLE", "NCURSES_EXPORT_ABI60"]) {
      expect(namesOf(decls), never).not.toContain(never);
    }
  });

  it("enums defined through macros, behind runs of bare macros, and members whose type is an enum", () => {
    const source = lines(
      "typedef NS_ENUM(NSInteger, SHKind) { SHKindA = 0, SHKindB };",
      "OS_ENUM(img_error, long, img_error_ok = 0, img_error_bad, img_error_mem = 3);",
      "__BEGIN_DECLS",
      "enum { CHECK_OK = 0, CHECK_BAD = (1 << 0) };",
      "DNS_FLAGS_ENUM { kFlagA = 0x1, kFlagB = 0x2 };",
      "typedef enum { ex_a AXR_ENUM_AVAILABILITY_v1 = 1 } ex_version;",
      "typedef struct XML_cp { enum XML_Content_Type type; unsigned int numchildren; } XML_Content;",
      "FMT_BEGIN_NAMESPACE",
      "FMT_BEGIN_EXPORT",
      "enum class color : uint32_t { alice_blue = 0xF0F8FF, aqua };",
    );
    expect(rows(declarationsIn("enums.h", source))).toEqual([
      "1 SHKind type pub",
      "1 SHKindA enum-member pub in SHKind",
      "1 SHKindB enum-member pub in SHKind",
      "2 img_error type pub",
      "2 img_error_ok enum-member pub in img_error",
      "2 img_error_bad enum-member pub in img_error",
      "2 img_error_mem enum-member pub in img_error",
      "4 CHECK_OK enum-member pub",
      "4 CHECK_BAD enum-member pub",
      "5 kFlagA enum-member pub",
      "5 kFlagB enum-member pub",
      "6 ex_a enum-member pub in ex_version",
      "6 ex_version type pub",
      "7 XML_cp type pub",
      "7 type member pub in XML_cp",
      "7 numchildren member pub in XML_cp",
      "7 XML_Content type pub",
      "10 color type pub",
      "10 alice_blue enum-member pub in color",
      "10 aqua enum-member pub in color",
    ]);
  });
});
