/**
 * evaluation0927.r7bValueHonesty.spec.ts — R7-B (round-7 wave, 2026-09-28):
 * regression coverage for review-findings-fable-r6.md's P1 item 3 (value
 * facet `covered` while the value was never served or disclosed: V1 imported
 * unresolved names, V2 self-property shapes, V3 qualified-owner widening, V4
 * construction-only bindings), item 4 (P1-4 qualified-constant owner
 * resolution priority) and item 7 (P2-7 dedup-as-miss, P2-8 reconciliation).
 *
 * Every fixture below is written FRESH against the DESCRIBED defect class —
 * different type/property/constant names, different files, different query
 * wording than the reviewer's own harness cases ($SCRATCH/review6/cases6.mjs)
 * — so a fix that only special-cases the reviewer's exact identifiers would
 * still fail here.
 *
 * Fast, no-server unit tests first (the pure evidenceClosure.ts functions
 * this wave added/widened); spawned dev-server end-to-end cases follow.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import {
  followNextToEnd,
  startDevServer,
  type ChainResult,
  type ServerHandle,
} from "./helpers/qualityFirstScenarios.js";
import {
  constructionOnlyInitializer,
  hasValuePositionOccurrence,
  importedModuleAliasesIn,
  ownerFieldNames,
  selfPropertyReferencesIn,
  type OwnerMemberSpan,
} from "../features/task-pack/evidenceClosure.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const tmpDirs: string[] = [];
const servers: ServerHandle[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.kill();
});
afterAll(async () => {
  for (const server of servers.splice(0)) await server.kill();
  for (const dir of tmpDirs.splice(0)) {
    try {
      await rmDirWithRetry(dir);
    } catch {
      /* best-effort cleanup */
    }
  }
});

function makeWorkspace(tag: string): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-r7b-${tag}-`));
  tmpDirs.push(ws);
  return ws;
}

function writeFile(ws: string, rel: string, content: string): void {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

async function spawnedServer(ws: string): Promise<ServerHandle> {
  const s = startDevServer(ws, "default");
  servers.push(s);
  await s.initialize();
  return s;
}

async function ask(ws: string, query: string, hopCap = 14): Promise<ChainResult> {
  const s = await spawnedServer(ws);
  return followNextToEnd(
    s,
    { tool: "read_file", arguments: { query, task: { epoch: "new", profile: "answer" }, cwd: ws } },
    { cwd: ws, hopCap },
  );
}

function decisionOf(response: unknown): any {
  return (response as any)?.decision ?? {};
}

function gapRefs(response: unknown): string[] {
  const gaps = decisionOf(response).certificate?.gaps ?? decisionOf(response).gaps ?? [];
  const out: string[] = [];
  for (const g of gaps) {
    if (typeof g === "string") out.push(g);
    else if (Array.isArray(g?.refs)) out.push(...g.refs);
  }
  return out;
}

function evidenceOf(response: unknown): any[] {
  return ((response as any)?.evidence ?? []) as any[];
}

/** The moment ANY hop certifies act.answer/act.edit, every marker must already be in the cumulative served bytes. */
function assertNoFalseCompletion(chain: ChainResult, markers: readonly string[]): void {
  let cumulative = "";
  for (const hop of chain.hops) {
    for (const e of evidenceOf(hop.response)) if (typeof e?.body === "string") cumulative += `${e.body}\n`;
    const kind = decisionOf(hop.response).kind;
    if (kind === "act.answer" || kind === "act.edit") {
      for (const marker of markers) {
        expect(cumulative, `certified "${kind}" without "${marker}" anywhere in the served evidence so far`).toContain(marker);
      }
    }
  }
}

/** Honest minimum bar: the FIRST certification either already served `marker`, or discloses an honest value gap. */
function assertHonestValueCompletion(chain: ChainResult, marker: string): void {
  let cumulative = "";
  for (const hop of chain.hops) {
    for (const e of evidenceOf(hop.response)) if (typeof e?.body === "string") cumulative += `${e.body}\n`;
    const kind = decisionOf(hop.response).kind;
    if (kind === "act.answer" || kind === "act.edit") {
      if (cumulative.includes(marker)) continue;
      const gaps = gapRefs(hop.response);
      expect(
        gaps.some((g) => g.includes("request-item-undetermined") && g.includes("value")),
        `certified "${kind}" with neither "${marker}" served nor an honest value gap disclosed (gaps: ${JSON.stringify(gaps)})`,
      ).toBe(true);
    }
  }
}

// ---------------------------------------------------------------------------
// V1 unit: hasValuePositionOccurrence -- value vs call-only vs type position
// ---------------------------------------------------------------------------
describe("V1 unit: hasValuePositionOccurrence(bodyLines, hashComment, name)", () => {
  it("a bare value use is a value-position occurrence", () => {
    expect(hasValuePositionOccurrence(["  return helperConfig;"], false, "helperConfig")).toBe(true);
  });
  it("a direct call helperConfig(...) is call-only, never a value position", () => {
    expect(hasValuePositionOccurrence(["  return helperConfig(url);"], false, "helperConfig")).toBe(false);
  });
  it("new helperConfig(...) construction is call-only, never a value position", () => {
    expect(hasValuePositionOccurrence(["  return new helperConfig();"], false, "helperConfig")).toBe(false);
  });
  it("a discarded receiver call helperConfig.log(...) is call-only", () => {
    expect(hasValuePositionOccurrence(['  helperConfig.log("x");'], false, "helperConfig")).toBe(false);
  });
  it("a receiver call whose RESULT is consumed IS a value position", () => {
    expect(hasValuePositionOccurrence(["  return helperConfig.has(status);"], false, "helperConfig")).toBe(true);
  });
  it("a TYPE ANNOTATION position (`: Name`) is never a value position", () => {
    expect(hasValuePositionOccurrence(["  const opts: HelperConfig = load();"], false, "HelperConfig")).toBe(false);
  });
  it("mixed: a type-position occurrence plus a genuine value use downstream still counts", () => {
    const body = ["  const opts: HelperConfig = load();", "  report(HelperConfig);"];
    expect(hasValuePositionOccurrence(body, false, "HelperConfig")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// V3 unit: importedModuleAliasesIn -- Go/Python/Rust module aliasing
// ---------------------------------------------------------------------------
describe("V3 unit: importedModuleAliasesIn(fileLines, hashComment)", () => {
  it("Go grouped import block: unaliased path binds its last segment", () => {
    const lines = ["package client", "", "import (", '\t"net/http"', "", '\t"example.com/app/limits"', ")", ""];
    const aliases = importedModuleAliasesIn(lines, false);
    expect(aliases.has("http")).toBe(true);
    expect(aliases.has("limits")).toBe(true);
  });
  it("Go single-line import with an explicit alias", () => {
    const lines = ['import lim "example.com/app/limits"'];
    expect(importedModuleAliasesIn(lines, false).has("lim")).toBe(true);
  });
  it("Python: unaliased dotted import binds the FIRST segment (real Python semantics)", () => {
    expect(importedModuleAliasesIn(["import pkg.limits"], true).has("pkg")).toBe(true);
  });
  it("Python: `as` alias binds the alias, not any segment", () => {
    const aliases = importedModuleAliasesIn(["import pkg.limits as lim"], true);
    expect(aliases.has("lim")).toBe(true);
    expect(aliases.has("pkg")).toBe(false);
  });
  it("Rust: `use a::b::limits as lim;` binds the alias", () => {
    expect(importedModuleAliasesIn(["use a::b::limits as lim;"], false).has("lim")).toBe(true);
  });
  it("an ordinary named import line contributes no module alias", () => {
    expect(importedModuleAliasesIn(['import { limits } from "./limits";'], false).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// V2 unit: ownerFieldNames -- implicit-this field enumeration
// ---------------------------------------------------------------------------
describe("V2 unit: ownerFieldNames(lines, classStart, classEnd, methodSpans, hashComment)", () => {
  it("Java: a typed field (modifiers + bare type token) is captured by name", () => {
    const lines = [
      "public class Sink {",
      "    private final int flushMs = Presets.FLUSH_MS;",
      "",
      "    public void run() {",
      "        System.out.println(flushMs);",
      "    }",
      "}",
    ];
    const methodSpans: OwnerMemberSpan[] = [{ start: 4, end: 6, name: "run" }];
    expect(ownerFieldNames(lines, 1, 7, methodSpans, false).has("flushMs")).toBe(true);
  });
  it("Kotlin: `val`/`var` fields are captured (the untyped shape)", () => {
    const lines = ["class Sink {", "    private val flushMs = Presets.FLUSH_MS", "}"];
    expect(ownerFieldNames(lines, 1, 3, [], false).has("flushMs")).toBe(true);
  });
  it("a name declared INSIDE a method body is never captured as a field", () => {
    const lines = ["public class Sink {", "    public void run() {", "        int flushMs = 5;", "    }", "}"];
    const methodSpans: OwnerMemberSpan[] = [{ start: 2, end: 4, name: "run" }];
    expect(ownerFieldNames(lines, 1, 5, methodSpans, false).has("flushMs")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// V2 unit: selfPropertyReferencesIn -- cls/super/bracket/ivar widening
// ---------------------------------------------------------------------------
describe("V2 unit: selfPropertyReferencesIn widened qualifiers", () => {
  it("Python cls.p is recognized ONLY when relPath ends .py", () => {
    expect(selfPropertyReferencesIn(["    return cls.flush_ms"], true, undefined, "pkg/sink.py")).toEqual(["flush_ms"]);
    expect(selfPropertyReferencesIn(["    return cls.flush_ms"], true, undefined, "pkg/sink.ts")).toEqual([]);
  });
  it("super.p is recognized with no language gate", () => {
    expect(selfPropertyReferencesIn(["    return super.flushMs;"], false)).toEqual(["flushMs"]);
  });
  it('bracket notation this["p"] / self[\'p\'] is recognized', () => {
    expect(selfPropertyReferencesIn(['    return this["flushMs"];'], false)).toEqual(["flushMs"]);
    expect(selfPropertyReferencesIn(["    return self['flush_ms']"], true)).toEqual(["flush_ms"]);
  });
  it("Ruby @p ivar syntax is recognized ONLY when relPath ends .rb", () => {
    expect(selfPropertyReferencesIn(["  @flush_ms"], true, undefined, "lib/sink.rb")).toEqual(["flush_ms"]);
  });
  it("a bare @decorator line in a NON-Ruby file is never mistaken for an ivar read", () => {
    expect(selfPropertyReferencesIn(["  @property"], true, undefined, "pkg/sink.py")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// V4 unit: constructionOnlyInitializer -- construction/call with no literal
// ---------------------------------------------------------------------------
describe("V4 unit: constructionOnlyInitializer(windowLines, hashComment)", () => {
  it("a bare `new X()` with no literal anywhere is a construction-only initializer", () => {
    expect(constructionOnlyInitializer(["export const registry = new Registry();"], false)).toBe("new Registry()");
  });
  it("a bare factory call `load()` with no literal is a construction-only initializer", () => {
    expect(constructionOnlyInitializer(["export const registry = load();"], false)).toBe("load()");
  });
  it("a call carrying a literal argument is NOT construction-only (P0-4's computed-constant shape)", () => {
    expect(constructionOnlyInitializer(["export const port = parseInt(\"8080\", 10);"], false)).toBeUndefined();
  });
  it("a plain literal is not a construction at all", () => {
    expect(constructionOnlyInitializer(["export const MAX = 5;"], false)).toBeUndefined();
  });
  it("a call whose result is combined with something else is not construction-only", () => {
    expect(constructionOnlyInitializer(["export const registry = new Registry() || fallback;"], false)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// V2 end-to-end: implicit-this BARE field reads (Java/Kotlin) and Python cls
// ---------------------------------------------------------------------------
describe("V2 end-to-end: implicit-this bare field reads resolve, never silently dropped", () => {
  it("Java: a bare identifier (no this.) that names a typed instance field", async () => {
    const ws = makeWorkspace("javaBare");
    writeFile(ws, "pom.xml", "<project><modelVersion>4.0.0</modelVersion><groupId>app</groupId><artifactId>app</artifactId><version>1</version></project>\n");
    writeFile(ws, "src/main/java/app/Presets.java", "package app;\n\npublic final class Presets {\n    public static final int FLUSH_INTERVAL_MS = 7200;\n    public static final int BATCH_SIZE = 3;\n}\n");
    writeFile(
      ws,
      "src/main/java/app/Sink.java",
      "package app;\n\npublic class Sink {\n    private final int flushMs = Presets.FLUSH_INTERVAL_MS;\n\n    public void flush() {\n        for (int i = 0; i < 3; i++) {\n            System.out.println(flushMs);\n        }\n    }\n}\n",
    );
    writeFile(ws, "src/main/java/app/Main.java", "package app;\n\npublic class Main {\n    public static void main(String[] args) {\n        new Sink().flush();\n    }\n}\n");
    const chain = await ask(ws, "What default flush interval does Sink.flush use?");
    assertHonestValueCompletion(chain, "FLUSH_INTERVAL_MS = 7200");
  }, 60_000);

  it("Kotlin: a bare `val` field initialized from another object's constant", async () => {
    const ws = makeWorkspace("ktBare");
    writeFile(ws, "build.gradle.kts", "plugins { kotlin(\"jvm\") version \"2.0.0\" }\n");
    writeFile(ws, "src/main/kotlin/app/Presets.kt", "package app\n\nobject Presets {\n    const val FLUSH_INTERVAL_MS = 7200L\n    const val BATCH_SIZE = 3\n}\n");
    writeFile(
      ws,
      "src/main/kotlin/app/Sink.kt",
      "package app\n\nclass Sink {\n    private val flushMs = Presets.FLUSH_INTERVAL_MS\n\n    fun flush() {\n        for (i in 0 until 3) {\n            val deadline = System.currentTimeMillis() + flushMs\n            if (deadline > 0) println(deadline)\n        }\n    }\n}\n",
    );
    writeFile(ws, "src/main/kotlin/app/Main.kt", "package app\n\nfun main() {\n    Sink().flush()\n}\n");
    const chain = await ask(ws, "What default flush interval does Sink.flush use?");
    assertHonestValueCompletion(chain, "FLUSH_INTERVAL_MS = 7200");
  }, 60_000);

  it("Python: a @classmethod reading cls.p resolves through the class attribute", async () => {
    const ws = makeWorkspace("pyCls");
    writeFile(ws, "pyproject.toml", "[project]\nname = \"r7bpycls\"\nversion = \"0.1.0\"\n");
    writeFile(ws, "app/presets.py", "FLUSH_INTERVAL_S = 7.2\nBATCH_SIZE = 3\n");
    writeFile(
      ws,
      "app/sink.py",
      "from .presets import FLUSH_INTERVAL_S\n\n\nclass Sink:\n    flush_interval = FLUSH_INTERVAL_S\n\n    @classmethod\n    def flush(cls):\n        for _ in range(3):\n            print(cls.flush_interval)\n",
    );
    writeFile(ws, "app/main.py", "from .sink import Sink\n\nSink.flush()\n");
    const chain = await ask(ws, "What default flush interval does Sink.flush use?");
    assertHonestValueCompletion(chain, "FLUSH_INTERVAL_S = 7.2");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// V3 end-to-end: qualified-owner widening (any-case member, ::, alias)
// ---------------------------------------------------------------------------
describe("V3 end-to-end: qualified Owner.member / Owner::member resolution widening", () => {
  it("TS: a lower-case member behind a chain continuation (Owner.member.next)", async () => {
    const ws = makeWorkspace("v3LowerMember");
    writeFile(ws, "package.json", '{ "name": "r7b-v3lower", "private": true, "type": "module" }\n');
    writeFile(ws, "src/presets.ts", "export interface Presets { flushMs: number }\n\nexport const BASE: Presets = {\n  flushMs: 7200,\n};\n");
    writeFile(ws, "src/registry.ts", "import { BASE, type Presets } from \"./presets\";\n\nexport class Registry {\n  static readonly active: Presets = BASE;\n}\n");
    writeFile(
      ws,
      "src/sink.ts",
      "import { Registry } from \"./registry\";\n\nexport class Sink {\n  flush(): number {\n    return Registry.active.flushMs;\n  }\n}\n",
    );
    const chain = await ask(ws, "What default flush interval does Sink.flush use?");
    assertHonestValueCompletion(chain, "flushMs: 7200");
  }, 60_000);

  it("C++: `Owner::member` scope resolution", async () => {
    const ws = makeWorkspace("v3Cpp");
    writeFile(ws, "CMakeLists.txt", "cmake_minimum_required(VERSION 3.20)\nproject(app CXX)\nadd_executable(app src/main.cpp src/sink.cpp)\n");
    writeFile(ws, "src/presets.hpp", "#pragma once\n\nstruct Presets {\n  static constexpr int FLUSH_MS = 7200;\n};\n");
    writeFile(ws, "src/sink.hpp", "#pragma once\n\nclass Sink {\n public:\n  int flush();\n};\n");
    writeFile(ws, "src/sink.cpp", "#include \"sink.hpp\"\n#include \"presets.hpp\"\n\nint Sink::flush() {\n  const int interval = Presets::FLUSH_MS;\n  return interval;\n}\n");
    writeFile(ws, "src/main.cpp", "#include \"sink.hpp\"\n#include <iostream>\n\nint main() {\n  Sink s;\n  std::cout << s.flush() << std::endl;\n  return 0;\n}\n");
    const chain = await ask(ws, "What default flush interval does Sink::flush use?");
    assertHonestValueCompletion(chain, "FLUSH_MS = 7200");
  }, 60_000);

  it("Go: a lower-case cross-package alias resolves through the package's own declaration", async () => {
    const ws = makeWorkspace("v3Go");
    writeFile(ws, "go.mod", "module example.com/sinkapp\n\ngo 1.22\n");
    writeFile(ws, "presets/presets.go", "package presets\n\nconst FlushIntervalMs = 7200\n\nconst BatchSize = 3\n");
    writeFile(
      ws,
      "sink/sink.go",
      "package sink\n\nimport (\n\t\"fmt\"\n\n\t\"example.com/sinkapp/presets\"\n)\n\ntype Sink struct{}\n\nfunc (s *Sink) Flush() int {\n\tfmt.Println(\"flushing\")\n\treturn presets.FlushIntervalMs\n}\n",
    );
    writeFile(ws, "app/main.go", "package app\n\nimport \"example.com/sinkapp/sink\"\n\nfunc Main() int {\n\ts := &sink.Sink{}\n\treturn s.Flush()\n}\n");
    const chain = await ask(ws, "What default flush interval does Sink.Flush use?");
    assertHonestValueCompletion(chain, "FlushIntervalMs = 7200");
    // Never a false "0 call sites"/empty-style claim for the unrelated
    // `fmt.Println` stdlib call this same body makes (the silent-skip-on-
    // failure rule for a non-Go-package alias miss, see
    // `resolveQualifiedReferencesIn`'s own doc).
    for (const hop of chain.hops) {
      const refs = gapRefs(hop.response);
      expect(refs.some((g) => g.includes("fmt.Println"))).toBe(false);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// P1-4 end-to-end: qualified-constant owner resolution priority
// ---------------------------------------------------------------------------
describe("P1-4 end-to-end: owner resolution prefers the focal's own import over an unrelated same-named declaration", () => {
  it("two files declare the same type name; only the IMPORTED one is served", async () => {
    const ws = makeWorkspace("p14priority");
    writeFile(ws, "package.json", '{ "name": "r7b-p14", "private": true, "type": "module" }\n');
    writeFile(ws, "src/wrong/presets.ts", "export class Presets {\n  static readonly FLUSH_MS = 1200;\n}\n");
    writeFile(ws, "src/right/presets.ts", "export class Presets {\n  static readonly FLUSH_MS = 7200;\n}\n");
    writeFile(
      ws,
      "src/sink.ts",
      "import { Presets } from \"./right/presets\";\n\nexport class Sink {\n  flush(): number {\n    return Presets.FLUSH_MS;\n  }\n}\n",
    );
    const chain = await ask(ws, "What default flush interval does Sink.flush use?");
    assertHonestValueCompletion(chain, "FLUSH_MS = 7200");
    // The UNRELATED same-named declaration's own value must never appear as
    // served evidence for this question.
    let cumulative = "";
    for (const hop of chain.hops) for (const e of evidenceOf(hop.response)) if (typeof e?.body === "string") cumulative += e.body;
    expect(cumulative).not.toContain("1200");
  }, 60_000);

  it("two classes share ONE file; only the NAMED class's own member is served", async () => {
    const ws = makeWorkspace("p14oneFile");
    writeFile(ws, "package.json", '{ "name": "r7b-p14b", "private": true, "type": "module" }\n');
    writeFile(
      ws,
      "src/presets.ts",
      "export class LegacyPresets {\n  static readonly FLUSH_MS = 1200;\n}\n\nexport class Presets {\n  static readonly FLUSH_MS = 7200;\n}\n",
    );
    writeFile(
      ws,
      "src/sink.ts",
      "import { Presets } from \"./presets\";\n\nexport class Sink {\n  flush(): number {\n    return Presets.FLUSH_MS;\n  }\n}\n",
    );
    const chain = await ask(ws, "What default flush interval does Sink.flush use?");
    assertHonestValueCompletion(chain, "FLUSH_MS = 7200");
    // The SPECIFIC window this fix resolves for the qualified reference
    // (tagged `why: "...Presets.FLUSH_MS..."`) must be the "Presets"
    // class's OWN member line alone -- member search bounded to the
    // matched class's own body span, never the whole file (and never
    // widened into a sibling's same-named field via the qualified window's
    // own further-reference chase -- own reproduction, 2026-09-28).
    for (const hop of chain.hops) {
      for (const e of evidenceOf(hop.response)) {
        if (typeof e?.why !== "string" || !e.why.includes("Presets.FLUSH_MS")) continue;
        expect(e.range, `closure:value window tagged "${e.why}" unexpectedly widened past the single field line`).toBe("6-6");
        if (typeof e.body === "string") expect(e.body).not.toContain("1200");
      }
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// P2-7 end-to-end: a property whose constant was ALREADY chased through
// another reading context counts as resolved, never a dedup-as-miss
// ---------------------------------------------------------------------------
describe("P2-7 end-to-end: a shared constant read by two properties is never falsely undetermined", () => {
  it("TWO fields initialized from the SAME module constant both resolve", async () => {
    const ws = makeWorkspace("p27shared");
    writeFile(ws, "package.json", '{ "name": "r7b-p27", "private": true, "type": "module" }\n');
    writeFile(ws, "src/presets.ts", "export interface Presets { flushMs: number; batchSize: number }\n\nexport const BASE_PRESETS: Presets = {\n  flushMs: 7200,\n  batchSize: 3,\n};\n");
    writeFile(
      ws,
      "src/sink.ts",
      "import { BASE_PRESETS, type Presets } from \"./presets\";\n\nexport class Sink {\n  private readonly primary: Presets = BASE_PRESETS;\n  private readonly backup: Presets = BASE_PRESETS;\n\n  flush(): number {\n    return this.primary.flushMs + this.backup.batchSize;\n  }\n}\n",
    );
    const chain = await ask(ws, "What default flush interval does Sink.flush use?");
    assertNoFalseCompletion(chain, ["flushMs: 7200"]);
    // The honesty check: no hop's gaps may claim "backup" is unresolved once
    // BASE_PRESETS (which backs it too) is already served under "primary".
    for (const hop of chain.hops) {
      const cumulative = evidenceOf(hop.response).filter((e) => typeof e?.body === "string").map((e) => e.body).join("\n");
      if (!cumulative.includes("flushMs: 7200")) continue;
      const refs = gapRefs(hop.response);
      expect(refs.some((g) => g.includes("backup") && g.includes("could not resolve"))).toBe(false);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// P2-8 end-to-end: a qualified reference whose owner is ALREADY resolved as
// a plain candidate is reconciled, never disclosed as a separate miss
// ---------------------------------------------------------------------------
describe("P2-8 end-to-end: an already-resolved owner's qualified member is reconciled, not re-disclosed unresolved", () => {
  it("`const Config = {...} as const` resolves as a plain candidate; Config.member is never ALSO disclosed unresolved", async () => {
    const ws = makeWorkspace("p28asConst");
    writeFile(ws, "package.json", '{ "name": "r7b-p28", "private": true, "type": "module" }\n');
    writeFile(ws, "src/limits.ts", "export const Limits = {\n  FLUSH_MS: 7200,\n  BATCH_SIZE: 3,\n} as const;\n");
    writeFile(
      ws,
      "src/sink.ts",
      "import { Limits } from \"./limits\";\n\nexport class Sink {\n  flush(): number {\n    return Limits.FLUSH_MS;\n  }\n}\n",
    );
    const chain = await ask(ws, "What default flush interval does Sink.flush use?");
    assertNoFalseCompletion(chain, ["FLUSH_MS: 7200"]);
    for (const hop of chain.hops) {
      const cumulative = evidenceOf(hop.response).filter((e) => typeof e?.body === "string").map((e) => e.body).join("\n");
      if (!cumulative.includes("FLUSH_MS: 7200")) continue;
      const refs = gapRefs(hop.response);
      expect(refs.some((g) => g.includes("Limits.FLUSH_MS") && g.includes("could not be resolved"))).toBe(false);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// V4 minimal end-to-end: a construction-only value is disclosed, never
// silently "covered" by the resolved declaration alone
// ---------------------------------------------------------------------------
describe("V4 minimal end-to-end: a value behind a no-literal constructor call is disclosed, never covered", () => {
  it("`export const registry = new Registry();` -- the REAL value lives inside Registry, never on this line", async () => {
    const ws = makeWorkspace("v4construct");
    writeFile(ws, "package.json", '{ "name": "r7b-v4", "private": true, "type": "module" }\n');
    writeFile(
      ws,
      "src/registry.ts",
      "export class Registry {\n  private readonly values = new Map<string, number>([[\"flushMs\", 7200]]);\n\n  get(key: string): number {\n    return this.values.get(key) ?? 0;\n  }\n}\n\nexport const registry = new Registry();\n",
    );
    writeFile(
      ws,
      "src/sink.ts",
      "import { registry } from \"./registry\";\n\nexport class Sink {\n  flush(): number {\n    return registry.get(\"flushMs\");\n  }\n}\n",
    );
    const chain = await ask(ws, "What default flush interval does Sink.flush use?");
    // The MINIMUM bar: never certify act.answer with "registry" resolved to
    // the bare `new Registry()` line alone AND no disclosure -- either the
    // real 7200 is served, or an honest gap says the construction was not
    // followed.
    let cumulative = "";
    for (const hop of chain.hops) {
      for (const e of evidenceOf(hop.response)) if (typeof e?.body === "string") cumulative += `${e.body}\n`;
      const kind = decisionOf(hop.response).kind;
      if (kind === "act.answer" || kind === "act.edit") {
        if (cumulative.includes("7200")) continue;
        const refs = gapRefs(hop.response);
        expect(
          refs.some((g) => g.includes("registry") && g.includes("built by") && g.includes("new Registry()")),
          `certified "${kind}" with neither the real value served nor the construction-only gap disclosed (gaps: ${JSON.stringify(refs)})`,
        ).toBe(true);
      }
    }
  }, 60_000);
});
