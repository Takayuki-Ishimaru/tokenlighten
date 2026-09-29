/**
 * evaluation0927.r9orchJvmImports.spec.ts — round-9 orchestrator follow-up
 * (2026-09-29) to R9-B's JVM import resolution.
 *
 * 1. Exact package match. `findPackageTopLevelDeclarationWindow` scanned
 *    `^package\s+cfg\b`, which also matches `package cfg.aaa`: an
 *    `import cfg.TIMEOUT_MS` (or a same-package read with no import) served a
 *    SUB-package's same-named constant whenever that file sorted first — the
 *    wrong declaration. The scan now requires the package name to end there
 *    (`(?:\s|;|$)`; scanLiteral's safe-regex guard refuses lookaheads).
 * 2. A Kotlin member import of a camelCase top-level property
 *    (`import org.acme.net.defaultTimeout`) produced no import specifier at
 *    all once R9-B limited the Python `import a.b` shape to `.py` files, so an
 *    unresolvable read of it (a library outside the workspace) was certified
 *    with neither the value served nor a gap. It is now a named,
 *    non-package specifier exactly like Java's `import static a.b.C.name;`.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { followNextToEnd, startDevServer, type ChainResult, type ServerHandle } from "./helpers/qualityFirstScenarios.js";
import { importSpecifiersNaming } from "../features/task-pack/evidenceClosure.js";

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

function makeWorkspace(tag: string, files: Record<string, string>): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-r9j-${tag}-`));
  tmpDirs.push(ws);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(ws, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return ws;
}

async function ask(ws: string, query: string): Promise<ChainResult> {
  const s = startDevServer(ws, "default");
  servers.push(s);
  await s.initialize();
  return followNextToEnd(
    s,
    { tool: "read_file", arguments: { query, task: { epoch: "new", profile: "answer" }, cwd: ws } },
    { cwd: ws, hopCap: 14 },
  );
}

function served(chain: ChainResult): { path: string; body: string; why: string }[] {
  const out: { path: string; body: string; why: string }[] = [];
  for (const hop of chain.hops) {
    for (const e of ((hop.response as any)?.evidence ?? []) as any[]) {
      if (typeof e?.body === "string") out.push({ path: String(e.path ?? ""), body: e.body, why: String(e.why ?? "") });
    }
  }
  return out;
}

function gaps(chain: ChainResult): string[] {
  const out: string[] = [];
  for (const hop of chain.hops) {
    const d = (hop.response as any)?.decision ?? {};
    for (const g of d.certificate?.gaps ?? d.gaps ?? []) out.push(typeof g === "string" ? g : JSON.stringify(g));
  }
  return out;
}

const SETTINGS = "rootProject.name = \"app\"\n";
const CLIENT = (imp: string, expr: string) =>
  `package app\n\n${imp}\n\nclass HttpClient {\n    fun request(url: String): String? {\n        for (attempt in 0 until 3) {\n            return fetch(url, ${expr})\n        }\n        return null\n    }\n}\n`;
const WHAT = "What default timeout does HttpClient.request use?";

describe("importSpecifiersNaming — Kotlin member imports", () => {
  const kt = [
    "package app",
    "",
    "import org.acme.net.defaultTimeout",
    "import org.acme.net.retryDelay as backoff",
    "import org.acme.net.HttpConfig",
    "import org.acme.net.DEFAULT_RETRIES",
  ];
  const at = "src/main/kotlin/app/HttpClient.kt";
  it("a camelCase member is a named, non-package specifier", () => {
    expect(importSpecifiersNaming(kt, "defaultTimeout", false, at)).toEqual([
      { specifier: "org.acme.net", relative: false, wildcard: false, packageEligible: false },
    ]);
  });
  it("an aliased member is named by its alias only", () => {
    expect(importSpecifiersNaming(kt, "backoff", false, at)).toHaveLength(1);
    expect(importSpecifiersNaming(kt, "retryDelay", false, at)).toEqual([]);
  });
  it("a type import and a SCREAMING_SNAKE constant stay as before (no specifier)", () => {
    expect(importSpecifiersNaming(kt, "HttpConfig", false, at)).toEqual([]);
    expect(importSpecifiersNaming(kt, "DEFAULT_RETRIES", false, at)).toEqual([]);
  });
  it("Scala and Python files are unaffected", () => {
    expect(importSpecifiersNaming(["import scala.collection.mutable"], "mutable", false, "src/main/scala/App.scala")).toEqual([]);
    expect(importSpecifiersNaming(["import acme.net"], "net", true, "app/client.py")).toEqual([
      { specifier: "acme.net", relative: false, wildcard: false, packageEligible: true },
    ]);
  });
});

describe("end to end: JVM package lookups are exact, unresolvable Kotlin imports are disclosed", () => {
  it("`import cfg.TIMEOUT_MS` serves package cfg's constant even when a cfg.aaa decoy sorts first", async () => {
    const ws = makeWorkspace("decoy", {
      "settings.gradle.kts": SETTINGS,
      "src/main/kotlin/cfg/aaa/Aaa.kt": "package cfg.aaa\n\nconst val TIMEOUT_MS = 1111L\n",
      "src/main/kotlin/cfg/zdefaults.kt": "package cfg\n\nconst val TIMEOUT_MS = 6500L\n",
      "src/main/kotlin/app/HttpClient.kt": CLIENT("import cfg.TIMEOUT_MS", "TIMEOUT_MS"),
    });
    const bodies = served(await ask(ws, WHAT));
    expect(bodies.some((e) => e.path.endsWith("cfg/zdefaults.kt") && e.body.includes("6500L") && e.why.startsWith("closure:value"))).toBe(true);
    expect(bodies.filter((e) => e.path.endsWith("cfg/aaa/Aaa.kt"))).toEqual([]);
  }, 120_000);

  it("a typed camelCase `val` import resolves to the exact package too", async () => {
    const ws = makeWorkspace("typed", {
      "settings.gradle.kts": SETTINGS,
      "src/main/kotlin/cfg/aaa/Aaa.kt": "package cfg.aaa\n\nval defaultTimeout: Long = 1111L\n",
      "src/main/kotlin/cfg/zdefaults.kt": "package cfg\n\nval defaultTimeout: Long = 6500L\n",
      "src/main/kotlin/app/HttpClient.kt": CLIENT("import cfg.defaultTimeout", "defaultTimeout"),
    });
    const bodies = served(await ask(ws, WHAT));
    expect(bodies.some((e) => e.path.endsWith("cfg/zdefaults.kt") && e.body.includes("6500L"))).toBe(true);
    expect(bodies.filter((e) => e.path.endsWith("cfg/aaa/Aaa.kt"))).toEqual([]);
  }, 120_000);

  it("a same-package read never resolves to a sub-package's constant: disclosed instead", async () => {
    const ws = makeWorkspace("samepkg", {
      "settings.gradle.kts": SETTINGS,
      "src/main/kotlin/app/aaa/Aaa.kt": "package app.aaa\n\nconst val TIMEOUT_MS = 1111L\n",
      "src/main/kotlin/app/HttpClient.kt": CLIENT("import kotlin.math.max", "TIMEOUT_MS"),
    });
    const chain = await ask(ws, WHAT);
    expect(served(chain).filter((e) => e.path.endsWith("app/aaa/Aaa.kt"))).toEqual([]);
    expect(gaps(chain).some((g) => g.includes("request-item-undetermined:value") && g.includes("TIMEOUT_MS"))).toBe(true);
  }, 120_000);

  it("an unresolvable camelCase member import is disclosed; an imported function call is not", async () => {
    const ws = makeWorkspace("external", {
      "settings.gradle.kts": SETTINGS,
      "src/main/kotlin/app/HttpClient.kt":
        "package app\n\nimport kotlinx.coroutines.delay\nimport org.acme.net.defaultTimeout\n\nclass HttpClient {\n    suspend fun request(url: String): String? {\n        for (attempt in 0 until 3) {\n            delay(100)\n            return fetch(url, defaultTimeout)\n        }\n        return null\n    }\n}\n",
    });
    const all = gaps(await ask(ws, WHAT));
    expect(all.some((g) => g.includes("request-item-undetermined:value") && g.includes("defaultTimeout"))).toBe(true);
    expect(all.some((g) => g.includes("imported from package"))).toBe(false);
    expect(all.some((g) => /\bdelay\b/.test(g))).toBe(false);
  }, 120_000);
});
