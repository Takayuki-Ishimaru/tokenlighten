/**
 * evaluation0927.r9bValueMatrix.spec.ts — R9-B (round-9 wave, 2026-09-29):
 * regression coverage for review-findings-fable-r8.md's value-facet P0/P1
 * items this agent owns (brief-round9.md "R9-B — values"):
 *
 * B1 (P0-1 pyKwargSameNameImportedConst, P0-2 rustMatchArmConstCondition +
 *     the C#/PHP/Kotlin/Rust "pure row" neighbours) — THE ROUND-9 LESSON:
 *     `transientBindingNamesIn`'s NAME-LEVEL exclusion (loop/catch/except/
 *     lambda/arrow/Kotlin-lambda/kwarg) is dropped from the value-candidate
 *     set entirely; only the focal's own parameters/type stay excluded
 *     (they are bound for the WHOLE body by the language itself). A
 *     keyword-argument NAME token is now skipped by POSITION only
 *     (`isKeywordArgumentNamePosition`, Python/Kotlin/Scala), never by name
 *     across the body — the value SIDE of `timeout=timeout` is a candidate
 *     again. A second, independent instance of the same bug class was found
 *     during this wave's own reproduction: `namesDeclaredWithin`'s
 *     `simpleAssignRe` read a match-arm/switch-expression arrow
 *     (`RETRY_LIMIT => …`) as a "simple assignment" declaring a LOCAL named
 *     RETRY_LIMIT (the `=` inside `=>` satisfied `=(?!=)`) — fixed the same
 *     way `topLevelAssignmentIndex` already excludes `=>`: `=(?![=>])`.
 * B2 (P0-3 ktImportedTopLevelConst, ktImportedObjectMemberConst + two P2-11
 *     residuals) — `importSpecifiersNaming`'s Python `import a.b [as x]`
 *     shape is now gated to `.py` files (a new optional `filePath` param);
 *     a JVM (Kotlin/Scala) bare member import `import a.b.NAME` is resolved
 *     by a NEW function, `findJvmImportedConstantWindow` (capitalised
 *     segment before NAME -> owner type, package-checked; lower-case ->
 *     package -> top-level declaration); a same-file `private`/`internal
 *     const val`/`val` (declarationShapes widened) and a same-PACKAGE
 *     top-level constant with no import (`findJvmPackageSiblingConstantWindow`)
 *     both now resolve too.
 * B3 (P1-7 javaStaticStarWrongOwner, csUsingStaticWrongOwner) — a type
 *     wildcard import (`import static a.b.C.*`, `using static A.B.C;`)
 *     resolves ONLY to an owner C declared in a file whose package/namespace
 *     matches `a.b`/`A.B` EXACTLY (`findPackageQualifiedOwnerMemberWindow`,
 *     replacing `findWildcardImportedConstantWindow`'s old call into
 *     `findQualifiedConstantWindow`'s "single other declaring file"
 *     fallback, which never checked the specifier's own package path).
 * B4 (P1-8) — (a) resolving a MODULE-ALIAS MEMBER (`config.TIMEOUT_MS`
 *     through `require`/a default import) now prefers an explicit
 *     `module.exports = { TIMEOUT_MS: 6500 }` key over a same-named
 *     top-level declaration in the same file (`resolveConstantWindow`'s new
 *     `preferExportsMember` parameter, set only by the module-alias-member
 *     call site); a SHORTHAND key (`{ TIMEOUT_MS }`) is unaffected and still
 *     chases the local binding. (b) several Python `from x import *` lines:
 *     the LAST one that defines the name wins (`findConstantAcrossReexports`
 *     now tries a Python file's wildcard specifiers in reverse source order).
 *
 * THE ROUND-8/9 LESSON: every fixture below is written FRESH (different
 * names, different files, different wording) from both the reviewer's own
 * repro fixtures AND round-8's own r8bValueMatrix.spec.ts fixtures.
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
  constantLikeReferencesIn,
  findModuleConstantWindow,
  importSpecifiersNaming,
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
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-r9b-${tag}-`));
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
    else if (g && typeof g === "object") out.push(JSON.stringify(g));
  }
  return out;
}

function evidenceOf(response: unknown): any[] {
  return ((response as any)?.evidence ?? []) as any[];
}

/** Every cumulative gap string seen up to and including the first act.answer/act.edit certification. */
function allGapsUntilCertified(chain: ChainResult): string[] {
  const out: string[] = [];
  for (const hop of chain.hops) {
    out.push(...gapRefs(hop.response));
    const kind = decisionOf(hop.response).kind;
    if (kind === "act.answer" || kind === "act.edit") break;
  }
  return out;
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

/** Strict bar: the value MUST be served (never merely disclosed). */
function assertValueServed(chain: ChainResult, marker: string): void {
  let cumulative = "";
  for (const hop of chain.hops) {
    for (const e of evidenceOf(hop.response)) if (typeof e?.body === "string") cumulative += `${e.body}\n`;
  }
  expect(cumulative, `expected "${marker}" to be served somewhere in the chain's evidence`).toContain(marker);
}

/** The wrong-owner bar (B3): a file matching `re` must NEVER be cited as evidence anywhere in the chain. */
function assertNeverServedFrom(chain: ChainResult, re: RegExp): void {
  for (const hop of chain.hops) {
    for (const e of evidenceOf(hop.response)) {
      if (typeof e?.body === "string" && typeof e?.path === "string") {
        expect(re.test(e.path), `wrongly served evidence from "${e.path}" (range ${e.range})`).toBe(false);
      }
    }
  }
}

/** P3/B1 bar: no gap string anywhere in the chain (up to first certification) names any of `forbidden`. */
function assertNoForbiddenDisclosure(chain: ChainResult, forbidden: readonly string[]): void {
  const gaps = allGapsUntilCertified(chain);
  for (const name of forbidden) {
    const hit = gaps.find((g) => new RegExp(`(?<![\\w.])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w.])`).test(g));
    expect(hit, `gap wrongly named "${name}" (forbidden: parameter/loop-catch-lambda variable/kwarg name/local/own type): ${JSON.stringify(hit)}`).toBeUndefined();
  }
}

// ===========================================================================
// Unit: B1 — THE ROUND-9 LESSON. `constantLikeReferencesIn`'s candidate set
// (what `excludeNames`/positional checks actually decide) for every "pure
// row" shape review-findings-fable-r8.md's item 2 names, own reproduction.
// ===========================================================================
describe("unit: constantLikeReferencesIn — B1 match-arm/switch-expression constants are candidates again", () => {
  it("Rust: a const used as a bare match-arm pattern is a candidate (own repro of rustMatchArmConstCondition's root cause)", () => {
    const refs = constantLikeReferencesIn(
      ["match attempt {", "    MAX_RETRIES => return None,", "    _ => attempt += 1,", "}"],
      false, "giveUp", new Set(), "a.rs",
    );
    expect(refs).toContain("MAX_RETRIES");
  });
  it("Rust: a tuple match-arm pattern still carries its constant (control -- never broken)", () => {
    const refs = constantLikeReferencesIn(["    (MAX_RETRIES, _) => 1,"], false, "f", new Set(), "a.rs");
    expect(refs).toContain("MAX_RETRIES");
  });
  it("C#: a switch-expression arm constant is a candidate", () => {
    const refs = constantLikeReferencesIn(
      ["return attempt switch", "{", "    RetryLimit => false,", "    _ => true,", "};"],
      false, "ShouldRetry", new Set(), "a.cs",
    );
    expect(refs).toContain("RetryLimit");
  });
  it("PHP: a match()/array literal KEY constant is a candidate", () => {
    const refs = constantLikeReferencesIn(
      ["return match($status) {", "    RETRY_LIMIT => true,", "    default => false,", "};"],
      false, "shouldRetry", new Set(), "a.php",
    );
    expect(refs).toContain("RETRY_LIMIT");
  });
  it("Kotlin: a single-line `when` case constant (the shape `{ NAME -> ... }` used to look like a lambda parameter list)", () => {
    const refs = constantLikeReferencesIn(
      ["    val outcome = when (mode) { FAST_MODE -> 1; else -> 2 }"],
      false, "compute", new Set(), "a.kt",
    );
    expect(refs).toContain("FAST_MODE");
  });
  it("multi-line Kotlin when (control -- never broken, no '{' immediately before the case)", () => {
    const refs = constantLikeReferencesIn(
      ["    when (mode) {", "        FAST_MODE -> 1", "        else -> 2", "    }"],
      false, "compute", new Set(), "a.kt",
    );
    expect(refs).toContain("FAST_MODE");
  });
});

describe("unit: constantLikeReferencesIn — B1 keyword-argument NAME is skipped by POSITION only (Python/Kotlin/Scala)", () => {
  it("Python: fetch(url, budget=budget) -- the VALUE side still registers the imported constant", () => {
    const refs = constantLikeReferencesIn(["    return post(url, budget=budget)"], true, "send", new Set(), "a.py");
    expect(refs).toContain("budget");
  });
  it("Kotlin: post(url, budget = budget) -- named-argument syntax, value side registers", () => {
    const refs = constantLikeReferencesIn(["        return post(url, budget = budget)"], false, "send", new Set(), "a.kt");
    expect(refs).toContain("budget");
  });
  it("Scala: post(url, budget = budget) -- named-argument syntax, value side registers", () => {
    const refs = constantLikeReferencesIn(["    post(url, budget = budget)"], false, "send", new Set(), "a.scala");
    expect(refs).toContain("budget");
  });
  it("NOT gated for TS/JS: an assignment-as-argument-expression is scanned ordinarily (never positionally skipped there)", () => {
    const refs = constantLikeReferencesIn(["  post(url, budget = budget);"], false, "send", new Set(), "a.ts");
    expect(refs).toContain("budget");
  });
  it("a genuine top-level reassignment is never mistaken for a kwarg name (no preceding '(' or ',')", () => {
    const refs = constantLikeReferencesIn(["budget = 5;", "return budget;"], false, "f", new Set(), "a.py");
    // "budget" here is a LOCAL declared within this same body (namesDeclaredWithin) --
    // correctly excluded for a DIFFERENT, pre-existing reason, not the kwarg check.
    expect(refs).not.toContain("budget");
  });
});

// ===========================================================================
// Unit: B2 — declarationShapes widened for Kotlin/Scala visibility modifiers
// before `const val`/`val` (the P2-11 "same-file" residual).
// ===========================================================================
describe("unit: findModuleConstantWindow — B2 Kotlin/Scala modifier + const-val shapes", () => {
  it("`private const val NAME` (modifier + two keywords)", () => {
    const win = findModuleConstantWindow(["private const val budgetMs = 4500L"], "budgetMs", false);
    expect(win?.start).toBe(1);
  });
  it("`internal val NAME` (modifier, single keyword)", () => {
    const win = findModuleConstantWindow(["internal val budgetMs = 4500L"], "budgetMs", false);
    expect(win?.start).toBe(1);
  });
  it("`public const val NAME`", () => {
    const win = findModuleConstantWindow(["public const val budgetMs = 4500L"], "budgetMs", false);
    expect(win?.start).toBe(1);
  });
  it("bare `const val NAME` (no modifier -- control, must still work)", () => {
    const win = findModuleConstantWindow(["const val budgetMs = 4500L"], "budgetMs", false);
    expect(win?.start).toBe(1);
  });
  it("an indented (non-column-0) modified val is NOT a module-level declaration (a class member, same rule as before)", () => {
    const win = findModuleConstantWindow(["class Foo {", "  private const val budgetMs = 1", "}"], "budgetMs", false);
    expect(win).toBeUndefined();
  });
});

// ===========================================================================
// Unit: B2 — importSpecifiersNaming's Python bare-import shape is gated to
// `.py` files; a Kotlin/Scala file with the IDENTICAL syntax is unaffected.
// ===========================================================================
describe("unit: importSpecifiersNaming — B2 filePath gates the Python bare-import shape", () => {
  it("Python file: `import a.b.name` still resolves as before (byte-for-byte)", () => {
    const specs = importSpecifiersNaming(["import pkg.settings"], "settings", true, "app/client.py");
    expect(specs).toEqual([{ specifier: "pkg.settings", relative: false, wildcard: false, packageEligible: true }]);
  });
  it("Kotlin file: the IDENTICAL syntax `import cfg.TIMEOUT_MS` no longer produces a (wrong) package-eligible specifier", () => {
    const specs = importSpecifiersNaming(["import cfg.TIMEOUT_MS"], "TIMEOUT_MS", false, "app/Client.kt");
    expect(specs).toEqual([]);
  });
  it("filePath omitted: old permissive behaviour is preserved byte-for-byte (every existing caller/spec is unaffected)", () => {
    const specs = importSpecifiersNaming(["import cfg.TIMEOUT_MS"], "TIMEOUT_MS", false);
    expect(specs).toEqual([{ specifier: "cfg.TIMEOUT_MS", relative: false, wildcard: false, packageEligible: true }]);
  });
  it("Kotlin wildcard imports are unaffected by the gate (a different regex, still recognized)", () => {
    const specs = importSpecifiersNaming(["import cfg.*"], "anything", false, "app/Client.kt");
    expect(specs).toEqual([{ specifier: "cfg", relative: false, wildcard: true, packageEligible: false }]);
  });
});

// ===========================================================================
// E2E matrix — B1: a keyword-argument NAME colliding with an imported/
// module constant no longer hides the constant's VALUE side; a constant
// used as a match/switch-expression arm resolves. Every fixture is FRESH.
// ===========================================================================
describe("E2E matrix — B1: kwarg-name/match-arm constants resolve (THE ROUND-9 LESSON)", () => {
  it("Python: fetch(url, budget=budget) -- the imported constant is served, not hidden by its own kwarg name", async () => {
    const ws = makeWorkspace("b1PyKwarg");
    writeFile(ws, "pyproject.toml", '[project]\nname = "netapp"\n');
    writeFile(ws, "netapp/__init__.py", "");
    writeFile(ws, "netapp/limits.py", "budget = 4.5\nceiling = 9\n");
    writeFile(
      ws,
      "netapp/worker.py",
      "from .limits import budget\n\n\nclass Dispatcher:\n    def send(self, url):\n        for attempt in range(3):\n            return post(url, budget=budget)\n        return None\n",
    );
    writeFile(ws, "netapp/api.py", 'from .worker import Dispatcher\n\n\ndef dispatch(pid):\n    return Dispatcher().send(f"/queues/{pid}")\n');
    const chain = await ask(ws, "What default budget does Dispatcher.send use?");
    assertValueServed(chain, "budget = 4.5");
    assertNoForbiddenDisclosure(chain, ["url", "attempt", "Dispatcher"]);
  }, 60_000);

  it("Kotlin: post(url, budget = budget) -- named-argument syntax, same collision shape", async () => {
    const ws = makeWorkspace("b1KtKwarg");
    writeFile(ws, "build.gradle.kts", 'plugins { kotlin("jvm") version "2.0.0" }\n');
    writeFile(ws, "src/main/kotlin/app/Limits.kt", "package app\n\nconst val budget = 4500L\n");
    writeFile(
      ws,
      "src/main/kotlin/app/Dispatcher.kt",
      "package app\n\nclass Dispatcher {\n    fun send(url: String): String {\n        for (attempt in 0 until 3) {\n            return post(url, budget = budget)\n        }\n        return \"\"\n    }\n}\n",
    );
    writeFile(ws, "src/main/kotlin/app/Main.kt", 'package app\n\nfun main() {\n    println(Dispatcher().send("/q/1"))\n}\n');
    const chain = await ask(ws, "What default budget does Dispatcher.send use?");
    assertValueServed(chain, "budget = 4500");
    assertNoForbiddenDisclosure(chain, ["url", "attempt", "Dispatcher"]);
  }, 60_000);

  it("Rust: a const used as a bare match-arm pattern resolves (rustMatchArmConstCondition's own class, fresh names)", async () => {
    const ws = makeWorkspace("b1RustMatch");
    writeFile(ws, "Cargo.toml", '[package]\nname = "netcli"\nversion = "0.1.0"\nedition = "2021"\n');
    writeFile(ws, "src/main.rs", 'mod worker;\n\nfn main() {\n    println!("{:?}", worker::send("/q/1"));\n}\n');
    writeFile(
      ws,
      "src/worker.rs",
      "const MAX_ATTEMPTS: u32 = 4;\n\npub fn send(url: &str) -> Option<String> {\n    let mut attempt = 0;\n    loop {\n        match attempt {\n            MAX_ATTEMPTS => return None,\n            _ => attempt += 1,\n        }\n        if !url.is_empty() {\n            return Some(url.to_string());\n        }\n    }\n}\n",
    );
    const chain = await ask(ws, "Under what condition does send give up?");
    assertValueServed(chain, "MAX_ATTEMPTS: u32 = 4");
  }, 60_000);

  it("control: a genuine kwarg name and a genuine loop variable are never disclosed, while a genuinely-unresolvable wildcard-imported CONST_CASE name still is", async () => {
    const ws = makeWorkspace("b1Control");
    writeFile(ws, "pyproject.toml", '[project]\nname = "netapp2"\n');
    writeFile(ws, "netapp2/__init__.py", "");
    writeFile(ws, "netapp2/limits.py", "ceiling = 9\n");
    writeFile(
      ws,
      "netapp2/worker.py",
      "from .limits import *\n\n\nclass Dispatcher:\n    def send(self, url):\n        for slot in range(3):\n            return post(url, budget=RETRY_BUDGET_MS)\n        return None\n",
    );
    const chain = await ask(ws, "What default retry budget does Dispatcher.send use?");
    assertHonestValueCompletion(chain, "RETRY_BUDGET_MS = ");
    // "budget" (kwarg NAME, positionally skipped) and "slot" (a loop variable,
    // never resolves, so silently harmless per this module's own contract)
    // must never be disclosed as though EITHER were an unresolved import.
    assertNoForbiddenDisclosure(chain, ["url", "slot", "budget", "Dispatcher"]);
  }, 60_000);
});

// ===========================================================================
// E2E matrix — B2: a JVM bare member import (`import a.b.NAME`, no wildcard,
// no "static") resolves through the owner type or the package's own
// top-level declarations; the two P2-11 residuals (same-file modifier,
// same-package no-import) resolve too. Every fixture is FRESH.
// ===========================================================================
describe("E2E matrix — B2: JVM bare member import resolves (ktImportedTopLevelConst/ktImportedObjectMemberConst class)", () => {
  it("Kotlin: `import cfg.budgetMs` (top-level constant of another package)", async () => {
    const ws = makeWorkspace("b2KtTopLevel");
    writeFile(ws, "build.gradle.kts", 'plugins { kotlin("jvm") version "2.0.0" }\n');
    writeFile(ws, "src/main/kotlin/cfg/Limits.kt", "package cfg\n\nconst val budgetMs = 4500L\nconst val ceiling = 9\n");
    writeFile(
      ws,
      "src/main/kotlin/app/Dispatcher.kt",
      "package app\n\nimport cfg.budgetMs\n\nclass Dispatcher {\n    fun send(url: String): String {\n        val deadline = System.currentTimeMillis() + budgetMs\n        return if (deadline > 0) url else \"\"\n    }\n}\n",
    );
    writeFile(ws, "src/main/kotlin/app/Main.kt", 'package app\n\nfun main() {\n    println(Dispatcher().send("/q/1"))\n}\n');
    const chain = await ask(ws, "What default budget does Dispatcher.send use?");
    assertValueServed(chain, "budgetMs = 4500");
  }, 60_000);

  it("Kotlin: `import cfg.Limits.budgetMs` (an object's own member)", async () => {
    const ws = makeWorkspace("b2KtObjectMember");
    writeFile(ws, "build.gradle.kts", 'plugins { kotlin("jvm") version "2.0.0" }\n');
    writeFile(ws, "src/main/kotlin/cfg/Limits.kt", "package cfg\n\nobject Limits {\n    const val budgetMs = 4500L\n    const val ceiling = 9\n}\n");
    writeFile(
      ws,
      "src/main/kotlin/app/Dispatcher.kt",
      "package app\n\nimport cfg.Limits.budgetMs\n\nclass Dispatcher {\n    fun send(url: String): String {\n        val deadline = System.currentTimeMillis() + budgetMs\n        return if (deadline > 0) url else \"\"\n    }\n}\n",
    );
    const chain = await ask(ws, "What default budget does Dispatcher.send use?");
    assertValueServed(chain, "budgetMs = 4500");
  }, 60_000);

  it("Scala: the identical bare-member-import shape (proves the extension gate covers Scala too)", async () => {
    const ws = makeWorkspace("b2ScalaMember");
    writeFile(ws, "build.sbt", 'ThisBuild / scalaVersion := "3.3.0"\n');
    writeFile(ws, "src/main/scala/cfg/Limits.scala", "package cfg\n\nobject Limits {\n  val budgetMs = 4500\n}\n");
    writeFile(
      ws,
      "src/main/scala/app/Dispatcher.scala",
      "package app\n\nimport cfg.Limits.budgetMs\n\nclass Dispatcher {\n  def send(url: String): String = {\n    val deadline = System.currentTimeMillis() + budgetMs\n    if (deadline > 0) url else \"\"\n  }\n}\n",
    );
    const chain = await ask(ws, "What default budget does Dispatcher.send use?");
    assertValueServed(chain, "budgetMs = 4500");
  }, 60_000);

  it("P2-11: Kotlin same-file `private const val` (modifier before the keyword)", async () => {
    const ws = makeWorkspace("b2KtPrivateSameFile");
    writeFile(ws, "build.gradle.kts", 'plugins { kotlin("jvm") version "2.0.0" }\n');
    writeFile(
      ws,
      "src/main/kotlin/app/Dispatcher.kt",
      "package app\n\nprivate const val budgetMs = 4500L\n\nclass Dispatcher {\n    fun send(url: String): String {\n        val deadline = System.currentTimeMillis() + budgetMs\n        return if (deadline > 0) url else \"\"\n    }\n}\n",
    );
    const chain = await ask(ws, "What default budget does Dispatcher.send use?");
    assertValueServed(chain, "budgetMs = 4500");
  }, 60_000);

  it("P2-11: Kotlin same-PACKAGE top-level constant, no import at all", async () => {
    const ws = makeWorkspace("b2KtSamePackage");
    writeFile(ws, "build.gradle.kts", 'plugins { kotlin("jvm") version "2.0.0" }\n');
    writeFile(ws, "src/main/kotlin/app/Defaults.kt", "package app\n\nconst val budgetMs = 4500L\nconst val ceiling = 9\n");
    writeFile(
      ws,
      "src/main/kotlin/app/Dispatcher.kt",
      "package app\n\nclass Dispatcher {\n    fun send(url: String): String {\n        val deadline = System.currentTimeMillis() + budgetMs\n        return if (deadline > 0) url else \"\"\n    }\n}\n",
    );
    writeFile(ws, "src/main/kotlin/app/Main.kt", 'package app\n\nfun main() { println(Dispatcher().send("/q/1")) }\n');
    const chain = await ask(ws, "What default budget does Dispatcher.send use?");
    assertValueServed(chain, "budgetMs = 4500");
  }, 60_000);

  it("control: a bare member import whose owner package never declares the member stays honestly undetermined (never guessed)", async () => {
    const ws = makeWorkspace("b2Control");
    writeFile(ws, "build.gradle.kts", 'plugins { kotlin("jvm") version "2.0.0" }\n');
    writeFile(ws, "src/main/kotlin/cfg/Limits.kt", "package cfg\n\nconst val CEILING = 9\n");
    writeFile(
      ws,
      "src/main/kotlin/app/Dispatcher.kt",
      "package app\n\nimport cfg.BUDGET_MS\n\nclass Dispatcher {\n    fun send(url: String): String {\n        val deadline = System.currentTimeMillis() + BUDGET_MS\n        return if (deadline > 0) url else \"\"\n    }\n}\n",
    );
    const chain = await ask(ws, "What default budget does Dispatcher.send use?");
    assertHonestValueCompletion(chain, "BUDGET_MS = ");
  }, 60_000);
});

// ===========================================================================
// E2E matrix — B3: a type wildcard import resolves ONLY to an owner declared
// in the SPECIFIER's own package/namespace -- a same-named class elsewhere
// is never served as though it were. Every fixture is FRESH.
// ===========================================================================
describe("E2E matrix — B3: type-wildcard owner is package/namespace-checked (javaStaticStarWrongOwner/csUsingStaticWrongOwner class)", () => {
  it("Java: `import static remote.external.Limits.*;` next to a LOCAL same-named `net.Limits` -- neither is served", async () => {
    const ws = makeWorkspace("b3JavaWrongOwner");
    writeFile(ws, "pom.xml", "<project><modelVersion>4.0.0</modelVersion><groupId>app</groupId><artifactId>app</artifactId><version>1</version></project>\n");
    writeFile(ws, "src/main/java/net/Limits.java", "package net;\n\npublic final class Limits {\n    public static final int BUDGET_MS = 1111;\n    public static final int CEILING = 9;\n}\n");
    writeFile(
      ws,
      "src/main/java/app/Dispatcher.java",
      "package app;\n\nimport static remote.external.Limits.*;\n\npublic final class Dispatcher {\n    public String send(String url) {\n        for (int attempt = 0; attempt < 3; attempt++) {\n            long deadline = System.currentTimeMillis() + BUDGET_MS;\n            if (deadline > 0) return url;\n        }\n        throw new IllegalStateException(\"exhausted\");\n    }\n}\n",
    );
    writeFile(
      ws,
      "src/main/java/app/Main.java",
      'package app;\n\npublic final class Main {\n    public static void main(String[] args) {\n        System.out.println(new Dispatcher().send("/q/1"));\n    }\n}\n',
    );
    const chain = await ask(ws, "What default budget does Dispatcher.send use?");
    assertNeverServedFrom(chain, /net\/Limits\.java/);
    // BUDGET_MS is CONST_CASE-shaped, so an honest miss is disclosed (never silenced) --
    // unlike PascalCase C# names (see the sibling C# test's own note).
    assertHonestValueCompletion(chain, "BUDGET_MS = ");
  }, 60_000);

  it("C#: `using static Remote.External.Limits;` next to a LOCAL same-named `Limits` class -- never served", async () => {
    const ws = makeWorkspace("b3CsWrongOwner");
    writeFile(ws, "App.csproj", '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n');
    writeFile(ws, "src/Limits.cs", "namespace Net;\n\npublic static class Limits\n{\n    public const int BudgetMs = 1111;\n    public const int Ceiling = 9;\n}\n");
    writeFile(
      ws,
      "src/Dispatcher.cs",
      "using static Remote.External.Limits;\n\nnamespace App;\n\npublic sealed class Dispatcher\n{\n    public string Send(string url)\n    {\n        for (var attempt = 0; attempt < 3; attempt++)\n        {\n            var deadline = System.Environment.TickCount64 + BudgetMs;\n            if (deadline > 0) return url;\n        }\n        throw new System.InvalidOperationException(\"exhausted\");\n    }\n}\n",
    );
    writeFile(
      ws,
      "src/Program.cs",
      'namespace App;\n\npublic static class Program\n{\n    public static void Main()\n    {\n        System.Console.WriteLine(new Dispatcher().Send("/q/1"));\n    }\n}\n',
    );
    const chain = await ask(ws, "What default budget does Dispatcher.Send use?");
    // The B3 bar itself: the wrong (locally-declared, same-named) class is
    // never served as though the wildcard import had named it. (A PascalCase
    // name like "BudgetMs" is a separate, pre-existing, documented residual
    // that never reaches `isUnresolvableConstantName`'s CONST_CASE gate --
    // out of B3's own scope; only the never-serve-the-wrong-file bar is
    // asserted here.)
    assertNeverServedFrom(chain, /Limits\.cs/);
  }, 60_000);

  it("control (rule 19 recall): a CORRECT-package type wildcard still resolves (never regressed by the package check)", async () => {
    const ws = makeWorkspace("b3Control");
    writeFile(ws, "pom.xml", "<project><modelVersion>4.0.0</modelVersion><groupId>app</groupId><artifactId>app</artifactId><version>1</version></project>\n");
    writeFile(ws, "src/main/java/cfg/Limits.java", "package cfg;\n\npublic final class Limits {\n    public static final int BUDGET_MS = 4500;\n}\n");
    writeFile(
      ws,
      "src/main/java/app/Dispatcher.java",
      'package app;\n\nimport static cfg.Limits.*;\n\npublic final class Dispatcher {\n    public String send(String url) {\n        long deadline = System.currentTimeMillis() + BUDGET_MS;\n        return deadline > 0 ? url : "";\n    }\n}\n',
    );
    const chain = await ask(ws, "What default budget does Dispatcher.send use?");
    assertValueServed(chain, "BUDGET_MS = 4500");
  }, 60_000);
});

// ===========================================================================
// E2E matrix — B4: (a) a module-alias member prefers an explicit exports-
// object key over a same-named local top-level declaration; a SHORTHAND key
// still chases the local binding. (b) several Python star imports: the LAST
// one wins. Every fixture is FRESH.
// ===========================================================================
describe("E2E matrix — B4: module-alias export key wins; Python last star-import wins", () => {
  it("B4(a): an explicit exports key (BUDGET_MS: 6500) wins over a same-named local top-level declaration (BUDGET_MS = 1000)", async () => {
    const ws = makeWorkspace("b4ExportsKeyWins");
    writeFile(ws, "package.json", '{ "name": "netcjs", "private": true }\n');
    writeFile(ws, "src/limits.js", "const BUDGET_MS = 1000; // legacy default kept for the migration script\n\nmodule.exports = {\n  BUDGET_MS: 6500,\n  CEILING: 9,\n};\n");
    writeFile(
      ws,
      "src/dispatcher.js",
      "const limits = require(\"./limits\");\n\nclass Dispatcher {\n  async send(url) {\n    for (let attempt = 0; attempt < 3; attempt++) {\n      const controller = new AbortController();\n      const timer = setTimeout(() => controller.abort(), limits.BUDGET_MS);\n      try {\n        return await fetch(url, { signal: controller.signal });\n      } finally {\n        clearTimeout(timer);\n      }\n    }\n    throw new Error(\"exhausted\");\n  }\n}\n\nmodule.exports = { Dispatcher };\n",
    );
    const chain = await ask(ws, "What default budget does Dispatcher.send use?");
    assertValueServed(chain, "BUDGET_MS: 6500");
  }, 60_000);

  it("B4(a) control: a SHORTHAND exports key ({ BUDGET_MS }) still chases the local binding (never treated as a value of its own)", async () => {
    const ws = makeWorkspace("b4ShorthandKey");
    writeFile(ws, "package.json", '{ "name": "netcjs2", "private": true }\n');
    writeFile(ws, "src/limits2.js", "const BUDGET_MS = 4500;\n\nmodule.exports = {\n  BUDGET_MS,\n  CEILING: 9,\n};\n");
    writeFile(
      ws,
      "src/dispatcher2.js",
      'const limits = require("./limits2");\n\nclass Dispatcher2 {\n  send(url) {\n    return limits.BUDGET_MS > 0 ? url : "";\n  }\n}\n\nmodule.exports = { Dispatcher2 };\n',
    );
    const chain = await ask(ws, "What default budget does Dispatcher2.send use?");
    assertValueServed(chain, "BUDGET_MS = 4500");
  }, 60_000);

  it("B4(b): two Python `from x import *` lines -- the LAST one (source order) wins, matching Python's own runtime semantics", async () => {
    // NOTE: exactly two star imports, matching the reviewer's own
    // pyTwoStarImportsLastWins shape -- own reproduction found that a THIRD
    // candidate file pushes the locator's separate ambiguous-target
    // discovery phase (upstream of, and independent from, the
    // findConstantAcrossReexports reordering this item fixes) into showing
    // several literal-match candidates during honest exploration; the
    // "last wins" CLOSURE guarantee this item makes is about `resolveConstantWindow`'s
    // own resolution, fully covered already at two imports.
    const ws = makeWorkspace("b4PyStarLastWins");
    writeFile(ws, "pyproject.toml", '[project]\nname = "netapp3"\n');
    writeFile(ws, "netapp3/__init__.py", "");
    writeFile(ws, "netapp3/legacy.py", "budget_ms = 1100\n");
    writeFile(ws, "netapp3/current.py", "budget_ms = 6500\n");
    writeFile(
      ws,
      "netapp3/worker.py",
      "from .legacy import *\nfrom .current import *\n\n\nclass Dispatcher:\n    def send(self, url):\n        return post(url, budget=budget_ms)\n",
    );
    writeFile(ws, "netapp3/api.py", 'from .worker import Dispatcher\n\n\ndef dispatch(pid):\n    return Dispatcher().send(f"/queues/{pid}")\n');
    const chain = await ask(ws, "What default budget does Dispatcher.send use?");
    assertValueServed(chain, "budget_ms = 6500");
    assertNeverServedFrom(chain, /legacy\.py/);
  }, 60_000);
});
