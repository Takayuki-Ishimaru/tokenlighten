/**
 * evaluation0927.r9orchReviewFixes.spec.ts — fixes for the round-9
 * verification review (review-findings-fable-r9.md) plus one false disclosure
 * the orchestrator found while checking them (2026-09-29).
 *
 * P0-1 (cjsExplicitSelfKey): `module.exports = { TIMEOUT_MS: TIMEOUT_MS }`
 *   (also `exports.TIMEOUT_MS = TIMEOUT_MS`, `export default { … }`) read as
 *   `config.TIMEOUT_MS` served the key line as "the value"; the key's value
 *   side reads the module's own binding, which is now resolved and served.
 * P1-2: Kotlin resolution order — an explicit member import wins over a
 *   same-package declaration; a field of the focal's own class and a
 *   loop/catch/lambda variable never resolve to a same-package declaration.
 * P1-3: `/* c *\/ export default function f` on one line, `/* a *\/ /* b *\/`
 *   before the header and `export default @Dec() class X` are default exports.
 * P1-4: a Python continuation written at the opener's own indent is still
 *   inside the argument list.
 * Orchestrator: a property of the focal's own class whose declaration holds a
 *   literal (`private timeoutMs = 2000`, `private val timeoutMs = 2000L`,
 *   `self.timeout = 6.5`) was disclosed as "could not resolve within the class
 *   body" in every language; that declaration is the value and is served. A
 *   constant of the focal's own type read as a Kotlin `companion object`
 *   member, Rust `Self::X`, PHP `self::X` or C++ `Type::X` was disclosed as
 *   "could not be resolved" while sitting in the same file; it is served.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { followNextToEnd, startDevServer, type ChainResult, type ServerHandle } from "./helpers/qualityFirstScenarios.js";
import {
  argumentContinuationLines,
  exportsMemberValueReadsOwnName,
  propertyInitializerIsSelfContained,
} from "../features/task-pack/evidenceClosure.js";
import { focalIsSoleDefaultExport } from "../features/task-pack/readCodeTaskPack.js";

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
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-r9f-${tag}-`));
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

function served(chain: ChainResult): { path: string; range: string; body: string; why: string }[] {
  const out: { path: string; range: string; body: string; why: string }[] = [];
  for (const hop of chain.hops) {
    for (const e of ((hop.response as any)?.evidence ?? []) as any[]) {
      if (typeof e?.body === "string") out.push({ path: String(e.path ?? ""), range: String(e.range ?? ""), body: e.body, why: String(e.why ?? "") });
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

const WHAT = "What default timeout does HttpClient.request use?";

describe("unit: the helpers behind the fixes", () => {
  it("exportsMemberValueReadsOwnName: self-named keys only", () => {
    const at = (src: string, name = "TIMEOUT_MS") => {
      const lines = src.split("\n");
      return exportsMemberValueReadsOwnName(lines, { start: 1, end: lines.length }, name, false);
    };
    expect(at("module.exports = { TIMEOUT_MS: TIMEOUT_MS, RETRIES: RETRIES };")).toBe(true);
    expect(at("  TIMEOUT_MS: TIMEOUT_MS,")).toBe(true);
    expect(at("exports.TIMEOUT_MS = TIMEOUT_MS;")).toBe(true);
    expect(at("export default { TIMEOUT_MS: TIMEOUT_MS * 2 };")).toBe(true);
    expect(at("module.exports = { TIMEOUT_MS: 6500 };")).toBe(false);
    expect(at("module.exports = { TIMEOUT_MS: DEFAULT_TIMEOUT };")).toBe(false);
    expect(at("module.exports = { TIMEOUT_MS: config.TIMEOUT_MS };")).toBe(false);
    expect(at("module.exports = { OTHER: TIMEOUT_MS, TIMEOUT_MS: 5 };")).toBe(false);
  });

  it("propertyInitializerIsSelfContained: literals and literal-built values, never a name read", () => {
    const sc = (line: string, name: string, hash = false) => propertyInitializerIsSelfContained([line], name, hash);
    for (const [line, name] of [
      ["    private val timeoutMs = 2000L", "timeoutMs"],
      ["  private timeoutMs = 2000;", "timeoutMs"],
      ["    private final int timeoutMs = 2000;", "timeoutMs"],
      ["  private label = \"abc\";", "label"],
      ["  private readonly retryable = new Set([502, 503, 504]);", "retryable"],
      ["    private val delays = listOf(1000L, 2000L)", "delays"],
      ["    private final Duration timeout = Duration.ofSeconds(2);", "timeout"],
      ["  get timeoutMs(): number { return 2000; }", "timeoutMs"],
      ["  constructor(private timeoutMs = 2000) {}", "timeoutMs"],
    ] as const) expect(sc(line, name), line).toBe(true);
    expect(sc("        self.timeout = 6.5", "timeout", true)).toBe(true);
    for (const [line, name] of [
      ["    this.timeoutMs = timeoutMs;", "timeoutMs"],
      ["    private final Duration timeout = Config.TIMEOUT;", "timeout"],
      ["  private timeoutMs = config.timeoutMs;", "timeoutMs"],
      ["  private timeoutMs = DEFAULT_TIMEOUT * 2;", "timeoutMs"],
      ["  private label = `x${suffix}`;", "label"],
      ["    private val timeoutMs: Long", "timeoutMs"],
    ] as const) expect(sc(line, name), line).toBe(false);
  });

  it("focalIsSoleDefaultExport: block comments before the header on the same or earlier lines, decorators after `export default`", () => {
    expect(focalIsSoleDefaultExport(["/* istanbul ignore next */ export default function formatBytes(n) {", "  return n;", "}"], 1, "formatBytes")).toBe(true);
    expect(focalIsSoleDefaultExport(["/* a */ /* b */", "export default function formatBytes(n) {", "  return n;", "}"], 1, "formatBytes")).toBe(true);
    expect(focalIsSoleDefaultExport(["/** doc */ // note", "export default function formatBytes(n) {", "  return n;", "}"], 1, "formatBytes")).toBe(true);
    expect(focalIsSoleDefaultExport(["export default @Injectable() class Formatter {", "}"], 1, "Formatter")).toBe(true);
    // controls
    expect(focalIsSoleDefaultExport(["/* note */ export function formatBytes(n) {", "  return n;", "}"], 1, "formatBytes")).toBe(false);
    expect(focalIsSoleDefaultExport(["export function formatBytes(n) {", "  return \"*/ export default function formatBytes\";", "}"], 1, "formatBytes")).toBe(false);
  });

  it("argumentContinuationLines: a continuation at the opener's own indent stays inside the arguments", () => {
    const lines = ["    def request(self, url):", "        return fetch(url,", "        timeout=timeout)"];
    expect(argumentContinuationLines(lines, true, "app/client.py")).toEqual([false, false, true]);
    // control: a docstring line ending in `,` releases the frame on the next non-continuation line
    const doc = ["    def request(self, url):", "        \"\"\"", "        Fetch (with retries,", "        and more.", "        \"\"\"", "        timeout = 2.0"];
    expect(argumentContinuationLines(doc, true, "app/client.py").at(-1)).toBe(false);
  });
});

const JS_API = "const { HttpClient } = require(\"./client\");\n\nasync function getProfile(id) {\n  return new HttpClient().request(`/profiles/${id}`);\n}\n\nmodule.exports = { getProfile };\n";
const JS_CLIENT = "const config = require(\"./config\");\n\nclass HttpClient {\n  async request(url) {\n    for (let attempt = 0; attempt < 3; attempt++) {\n      const response = await fetch(url, { signal: AbortSignal.timeout(config.TIMEOUT_MS) });\n      if (response.ok) return response;\n    }\n    throw new Error(\"exhausted\");\n  }\n}\n\nmodule.exports = { HttpClient };\n";

describe("end to end: self-named export keys serve the module's own binding", () => {
  for (const [label, config] of [
    ["object literal", "const TIMEOUT_MS = 1000;\nconst RETRIES = 3;\n\nmodule.exports = { TIMEOUT_MS: TIMEOUT_MS, RETRIES: RETRIES };\n"],
    ["multi-line object", "const TIMEOUT_MS = 1000;\nconst RETRIES = 3;\n\nmodule.exports = {\n  TIMEOUT_MS: TIMEOUT_MS,\n  RETRIES: RETRIES,\n};\n"],
    ["exports.X = X", "const TIMEOUT_MS = 1000;\n\nexports.TIMEOUT_MS = TIMEOUT_MS;\n"],
  ] as const) {
    it(`CommonJS ${label}`, async () => {
      const ws = makeWorkspace("cjs", { "package.json": "{ \"name\": \"app\", \"private\": true }\n", "src/api.js": JS_API, "src/client.js": JS_CLIENT, "src/config.js": config });
      const chain = await ask(ws, WHAT);
      const bodies = served(chain);
      expect(bodies.some((e) => e.path === "src/config.js" && e.body.includes("const TIMEOUT_MS = 1000") && e.why.startsWith("closure:value"))).toBe(true);
      expect(gaps(chain).filter((g) => g.includes("request-item-undetermined:value"))).toEqual([]);
    }, 120_000);
  }

  it("control: a key whose value is a literal still serves the key (never the same-named local)", async () => {
    const ws = makeWorkspace("cjsctl", {
      "package.json": "{ \"name\": \"app\", \"private\": true }\n",
      "src/api.js": JS_API,
      "src/client.js": JS_CLIENT,
      "src/config.js": "const TIMEOUT_MS = 1000;\n\nmodule.exports = { TIMEOUT_MS: 6500 };\n",
    });
    const bodies = served(await ask(ws, WHAT));
    expect(bodies.some((e) => e.path === "src/config.js" && e.body.includes("TIMEOUT_MS: 6500") && e.why.startsWith("closure:value"))).toBe(true);
    expect(bodies.some((e) => e.path === "src/config.js" && e.body.includes("const TIMEOUT_MS = 1000") && e.why.startsWith("closure:value"))).toBe(false);
  }, 120_000);
});

const KT_SETTINGS = { "settings.gradle.kts": "rootProject.name = \"app\"\n" };
const KT_CLIENT = (imp: string, expr: string, fields = "") =>
  `package app\n\n${imp}\n\nclass HttpClient {\n${fields}    fun request(url: String): String? {\n        for (attempt in 0 until 3) {\n            return fetch(url, ${expr})\n        }\n        return null\n    }\n}\n`;

describe("end to end: Kotlin name precedence", () => {
  it("an explicit member import wins over a same-package declaration", async () => {
    const ws = makeWorkspace("ktimp", {
      ...KT_SETTINGS,
      "src/main/kotlin/other/Net.kt": "package other\n\nconst val TIMEOUT_MS = 6500L\n",
      "src/main/kotlin/app/Defaults.kt": "package app\n\nconst val TIMEOUT_MS = 1111L\n",
      "src/main/kotlin/app/HttpClient.kt": KT_CLIENT("import other.TIMEOUT_MS", "TIMEOUT_MS"),
    });
    const bodies = served(await ask(ws, WHAT));
    expect(bodies.some((e) => e.path.endsWith("other/Net.kt") && e.body.includes("6500L") && e.why.startsWith("closure:value"))).toBe(true);
    expect(bodies.filter((e) => e.path.endsWith("app/Defaults.kt"))).toEqual([]);
  }, 120_000);

  it("a field of the focal's own class is the value, never a same-package top-level property", async () => {
    const ws = makeWorkspace("ktfield", {
      ...KT_SETTINGS,
      "src/main/kotlin/app/Defaults.kt": "package app\n\nval timeoutMs = 6500L\n",
      "src/main/kotlin/app/HttpClient.kt": KT_CLIENT("import kotlin.math.max", "timeoutMs", "    private val timeoutMs = 2000L\n\n"),
    });
    const chain = await ask(ws, WHAT);
    expect(served(chain).filter((e) => e.path.endsWith("app/Defaults.kt"))).toEqual([]);
    expect(gaps(chain).filter((g) => g.includes("request-item-undetermined:value"))).toEqual([]);
  }, 120_000);

  it("a loop variable never resolves to a same-package property of the same name", async () => {
    const ws = makeWorkspace("ktloop", {
      ...KT_SETTINGS,
      "src/main/kotlin/app/Defaults.kt": "package app\n\nval timeoutMs = 6500L\nval timeouts = listOf(1000L, 2000L, 4000L)\n",
      "src/main/kotlin/app/HttpClient.kt": "package app\n\nclass HttpClient {\n    fun request(url: String): String? {\n        for (timeoutMs in timeouts) {\n            return fetch(url, timeoutMs)\n        }\n        return null\n    }\n}\n",
    });
    const bodies = served(await ask(ws, WHAT));
    expect(bodies.some((e) => e.path.endsWith("app/Defaults.kt") && e.why === "closure:value timeouts (read by request)")).toBe(true);
    expect(bodies.filter((e) => e.why.startsWith("closure:value timeoutMs"))).toEqual([]);
  }, 120_000);
});

describe("end to end: a literal-initialized property of the focal's own class is served, not disclosed", () => {
  const cases: [string, Record<string, string>, string][] = [
    ["TypeScript field", {
      "package.json": "{ \"name\": \"app\", \"private\": true, \"type\": \"module\" }\n",
      "src/client.ts": "export class HttpClient {\n  private timeoutMs = 2000;\n\n  async request(url: string): Promise<Response> {\n    for (let attempt = 0; attempt < 3; attempt++) {\n      return fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });\n    }\n    throw new Error(\"exhausted\");\n  }\n}\n",
    }, "timeoutMs = 2000"],
    ["Kotlin val", { ...KT_SETTINGS, "src/main/kotlin/app/HttpClient.kt": KT_CLIENT("import kotlin.math.max", "timeoutMs", "    private val timeoutMs = 2000L\n\n") }, "timeoutMs = 2000L"],
    ["Java final field", {
      "pom.xml": "<project><modelVersion>4.0.0</modelVersion><groupId>a</groupId><artifactId>app</artifactId><version>1</version></project>\n",
      "src/main/java/app/HttpClient.java": "package app;\n\npublic class HttpClient {\n    private final int timeoutMs = 2000;\n\n    public String request(String url) {\n        for (int attempt = 0; attempt < 3; attempt++) {\n            return fetch(url, timeoutMs);\n        }\n        return null;\n    }\n}\n",
    }, "timeoutMs = 2000"],
    ["Python self attribute", {
      "pyproject.toml": "[project]\nname = \"app\"\n",
      "app/__init__.py": "",
      "app/client.py": "class HttpClient:\n    def __init__(self):\n        self.timeout = 6.5\n\n    def request(self, url):\n        for attempt in range(3):\n            return fetch(url, timeout=self.timeout)\n        return None\n",
    }, "self.timeout = 6.5"],
  ];
  for (const [label, files, marker] of cases) {
    it(label, async () => {
      const chain = await ask(makeWorkspace("lit", files), WHAT);
      expect(served(chain).some((e) => e.body.includes(marker))).toBe(true);
      expect(gaps(chain).filter((g) => g.includes("could not resolve within the class body"))).toEqual([]);
    }, 120_000);
  }

  const ownTypeCases: [string, Record<string, string>, string, string][] = [
    ["Kotlin companion object constant", { ...KT_SETTINGS, "src/main/kotlin/app/HttpClient.kt": "package app\n\nclass HttpClient {\n    fun request(url: String): String? {\n        for (attempt in 0 until 3) {\n            return fetch(url, TIMEOUT_MS)\n        }\n        return null\n    }\n\n    companion object {\n        const val TIMEOUT_MS = 2000L\n    }\n}\n" }, "TIMEOUT_MS = 2000L", WHAT],
    ["Rust associated constant via Self::", {
      "Cargo.toml": "[package]\nname = \"cli\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
      "src/lib.rs": "pub struct HttpClient;\n\nimpl HttpClient {\n    const TIMEOUT_MS: u64 = 2000;\n\n    pub fn request(&self, url: &str) -> Option<u64> {\n        for _attempt in 0..3 {\n            if !url.is_empty() {\n                return Some(Self::TIMEOUT_MS);\n            }\n        }\n        None\n    }\n}\n",
    }, "TIMEOUT_MS: u64 = 2000", WHAT],
    ["PHP class constant via self::", {
      "composer.json": "{ \"name\": \"acme/app\" }\n",
      "src/HttpClient.php": "<?php\n\nclass HttpClient\n{\n    private const TIMEOUT_MS = 2000;\n\n    public function request(string $url): ?string\n    {\n        for ($attempt = 0; $attempt < 3; $attempt++) {\n            return fetch($url, self::TIMEOUT_MS);\n        }\n        return null;\n    }\n}\n",
    }, "TIMEOUT_MS = 2000", WHAT],
  ];
  for (const [label, files, marker, query] of ownTypeCases) {
    it(label, async () => {
      const chain = await ask(makeWorkspace("own", files), query);
      expect(served(chain).some((e) => e.body.includes(marker))).toBe(true);
      expect(gaps(chain).filter((g) => g.includes("request-item-undetermined:value"))).toEqual([]);
    }, 120_000);
  }

  it("control: a property assigned from a constructor parameter without a default stays disclosed", async () => {
    const ws = makeWorkspace("litctl", {
      "package.json": "{ \"name\": \"app\", \"private\": true, \"type\": \"module\" }\n",
      "src/client.ts": "export class HttpClient {\n  private timeoutMs: number;\n\n  constructor(timeoutMs: number) {\n    this.timeoutMs = timeoutMs;\n  }\n\n  async request(url: string): Promise<Response> {\n    for (let attempt = 0; attempt < 3; attempt++) {\n      return fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });\n    }\n    throw new Error(\"exhausted\");\n  }\n}\n",
    });
    const all = gaps(await ask(ws, WHAT));
    expect(all.some((g) => g.includes("request-item-undetermined:value") && g.includes("this.timeoutMs"))).toBe(true);
  }, 120_000);
});
