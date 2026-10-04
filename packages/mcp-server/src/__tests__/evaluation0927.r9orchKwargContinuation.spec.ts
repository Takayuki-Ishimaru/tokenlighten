/**
 * evaluation0927.r9orchKwargContinuation.spec.ts — round-9 orchestrator
 * follow-up (2026-09-29) to review-8's P0-1 (pyKwargSameNameImportedConst).
 *
 * R9-B fixed the single-line shape `fetch(url, timeout=timeout)`. The same
 * false "covered" survived in the MULTI-LINE shapes black and ktlint produce
 * (`fetch(\n    url,\n    timeout=timeout,\n)`, a hanging indent, a Kotlin
 * named argument on its own line): `namesDeclaredWithin` read the line
 * `timeout=timeout,` as an assignment STATEMENT, declared a local `timeout`,
 * and so removed the imported `timeout` from the whole body — the pack
 * certified act.answer without serving or disclosing the value.
 *
 * Fix (evidenceClosure.ts): `argumentContinuationLines` marks the lines that
 * begin inside an argument/parameter list (innermost open bracket `(`/`[`;
 * a `{` body or a Go `var (` group ends that). On those lines `name=` is a
 * binding site of the callee: never a local declaration, and the NAME token
 * itself is skipped by position (the value side stays a candidate).
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { followNextToEnd, startDevServer, type ChainResult, type ServerHandle } from "./helpers/qualityFirstScenarios.js";
import { argumentContinuationLines, constantLikeReferencesIn } from "../features/task-pack/evidenceClosure.js";

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
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-r9o-${tag}-`));
  tmpDirs.push(ws);
  return ws;
}

function writeFile(ws: string, rel: string, content: string): void {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

async function ask(ws: string, query: string): Promise<ChainResult> {
  const s = startDevServer(ws, "default");
  servers.push(s);
  await s.initialize();
  return followNextToEnd(
    s,
    { tool: "tl_read_file", arguments: { query, task: { epoch: "new", profile: "answer" }, cwd: ws } },
    { cwd: ws, hopCap: 14 },
  );
}

function servedBodies(chain: ChainResult): { path: string; body: string; why: string }[] {
  const out: { path: string; body: string; why: string }[] = [];
  for (const hop of chain.hops) {
    for (const e of ((hop.response as any)?.evidence ?? []) as any[]) {
      if (typeof e?.body === "string") out.push({ path: String(e.path ?? ""), body: e.body, why: String(e.why ?? "") });
    }
  }
  return out;
}

function certifiedKinds(chain: ChainResult): string[] {
  return chain.hops.map((hop) => String((hop.response as any)?.decision?.kind ?? ""));
}

function scan(src: string, relPath: string, hashComment: boolean): { continuation: string; refs: string[] } {
  const lines = src.split("\n");
  return {
    continuation: argumentContinuationLines(lines, hashComment, relPath).map((b) => (b ? "1" : "0")).join(""),
    refs: constantLikeReferencesIn(lines, hashComment, "request", new Set(["url", "self"]), relPath),
  };
}

describe("argumentContinuationLines + constantLikeReferencesIn — a `name=` line inside an argument list", () => {
  it("black style: the value side of `timeout=timeout,` is a read of the imported name", () => {
    const r = scan("    def request(self, url):\n        return fetch(\n            url,\n            timeout=timeout,\n        )", "app/client.py", true);
    expect(r.continuation).toBe("00111");
    expect(r.refs).toContain("timeout");
  });
  it("black style with a different value: the kwarg NAME is skipped, the value is a candidate", () => {
    const r = scan("    def request(self, url):\n        return fetch(\n            url,\n            timeout=default_timeout,\n        )", "app/client.py", true);
    expect(r.refs).toContain("default_timeout");
    expect(r.refs).not.toContain("timeout");
  });
  it("hanging indent under the open paren", () => {
    const r = scan("    def request(self, url):\n        return fetch(url,\n                     timeout=timeout)", "app/client.py", true);
    expect(r.continuation).toBe("001");
    expect(r.refs).toContain("timeout");
  });
  it("Kotlin named argument on its own line", () => {
    const r = scan("    fun request(url: String): String? {\n        return fetch(\n            url,\n            timeoutMs = timeoutMs,\n        )\n    }", "app/HttpClient.kt", false);
    expect(r.refs).toContain("timeoutMs");
  });
  it("JSX attributes inside `return (`: the attribute name is skipped, its value is read", () => {
    const r = scan("export function request() {\n  return (\n    <Fetcher\n      delay={TIMEOUT_MS}\n      timeout={timeout}\n    />\n  );\n}", "src/App.tsx", false);
    expect(r.refs).toEqual(expect.arrayContaining(["TIMEOUT_MS", "timeout"]));
    expect(r.refs).not.toContain("delay");
  });
  it("a multi-line parameter default of a nested def/function: the default is read, the parameter name is skipped there", () => {
    const py = scan("    def request(self, url):\n        def inner(\n            retry_after=TIMEOUT_S,\n        ):\n            return 1\n        return inner()", "app/client.py", true);
    expect(py.refs).toContain("TIMEOUT_S");
    expect(py.refs).not.toContain("retry_after");
    const ts = scan("export function request(url: string) {\n  function inner(\n    retryAfter = TIMEOUT_MS,\n  ) {\n    return 1;\n  }\n  return inner();\n}", "src/client.ts", false);
    expect(ts.refs).toContain("TIMEOUT_MS");
    expect(ts.refs).not.toContain("retryAfter");
  });

  // Controls: statements stay statements.
  it("control: a real local assignment at statement level still shadows the import", () => {
    expect(scan("    def request(self, url):\n        timeout = 2.0\n        return fetch(url, timeout=timeout)", "app/client.py", true).refs).not.toContain("timeout");
  });
  it("control: an assignment whose right-hand side opens a paren is still a local", () => {
    const r = scan("    def request(self, url):\n        timeout = (\n            TIMEOUT_S\n        )\n        return fetch(url, timeout=timeout)", "app/client.py", true);
    expect(r.refs).not.toContain("timeout");
    expect(r.refs).toContain("TIMEOUT_S");
  });
  it("control: an unbalanced paren inside a multi-line docstring does not turn later statements into arguments", () => {
    const r = scan("    def request(self, url):\n        \"\"\"\n        Fetch the URL (with retries.\n        \"\"\"\n        timeout = 2.0\n        return fetch(url, timeout=timeout)", "app/client.py", true);
    expect(r.continuation).toBe("000000");
    expect(r.refs).not.toContain("timeout");
  });
  it("control: a Go grouped `var (` block declares locals", () => {
    const r = scan("func request(url string) time.Duration {\n\tvar (\n\t\ttimeout = 2 * time.Second\n\t)\n\treturn timeout\n}", "pkg/client.go", false);
    expect(r.continuation).toBe("000000");
    expect(r.refs).not.toContain("timeout");
  });
  it("control: statements inside a lambda/callback body passed as an argument stay statements", () => {
    const kt = scan("    fun request(url: String): Int {\n        run(block = {\n            total = LIMIT\n        })\n        return total\n    }", "app/HttpClient.kt", false);
    expect(kt.continuation).toBe("000000");
    expect(kt.refs).toEqual(expect.arrayContaining(["LIMIT"]));
    expect(kt.refs).not.toContain("total");
    expect(kt.refs).not.toContain("block");
    const js = scan("export function request(url: string) {\n  setTimeout(() => {\n    retries = MAX_RETRIES;\n  }, 10);\n  return retries;\n}", "src/client.ts", false);
    expect(js.refs).toContain("MAX_RETRIES");
    expect(js.refs).not.toContain("retries");
  });
});

const PY_API = "from .client import HttpClient\n\n\ndef get_profile(pid):\n    return HttpClient().request(f\"/profiles/{pid}\")\n";
function pyWorkspace(tag: string, settings: string, client: string): string {
  const ws = makeWorkspace(tag);
  writeFile(ws, "pyproject.toml", "[project]\nname = \"app\"\n");
  writeFile(ws, "app/__init__.py", "");
  writeFile(ws, "app/api.py", PY_API);
  writeFile(ws, "app/settings.py", settings);
  writeFile(ws, "app/client.py", client);
  return ws;
}
const PY_REQUEST = (call: string, imp = "from .settings import timeout") =>
  `${imp}\n\n\nclass HttpClient:\n    def request(self, url):\n        for attempt in range(3):\n${call}\n        return None\n`;
const WHAT = "What default timeout does HttpClient.request use?";

describe("end to end: the imported value behind a multi-line keyword argument is served", () => {
  it("Python black style `timeout=timeout,`", async () => {
    const ws = pyWorkspace("black", "timeout = 6.5\nretries = 3\n", PY_REQUEST("            return fetch(\n                url,\n                timeout=timeout,\n            )"));
    const chain = await ask(ws, WHAT);
    expect(certifiedKinds(chain)).toContain("act.answer");
    expect(servedBodies(chain).some((e) => e.path === "app/settings.py" && e.body.includes("timeout = 6.5") && e.why.startsWith("closure:value timeout"))).toBe(true);
  }, 120_000);

  it("Python hanging indent", async () => {
    const ws = pyWorkspace("hang", "timeout = 6.5\nretries = 3\n", PY_REQUEST("            return fetch(url,\n                         timeout=timeout)"));
    const chain = await ask(ws, WHAT);
    expect(servedBodies(chain).some((e) => e.path === "app/settings.py" && e.body.includes("timeout = 6.5"))).toBe(true);
  }, 120_000);

  it("Kotlin named argument on its own line, imported top-level val", async () => {
    const ws = makeWorkspace("kt");
    writeFile(ws, "settings.gradle.kts", "rootProject.name = \"app\"\n");
    writeFile(ws, "src/main/kotlin/cfg/Defaults.kt", "package cfg\n\nval timeoutMs = 6500L\nval retries = 3\n");
    writeFile(
      ws,
      "src/main/kotlin/app/HttpClient.kt",
      "package app\n\nimport cfg.timeoutMs\n\nclass HttpClient {\n    fun request(url: String): String? {\n        for (attempt in 0 until 3) {\n            return fetch(\n                url,\n                timeoutMs = timeoutMs,\n            )\n        }\n        return null\n    }\n}\n",
    );
    const chain = await ask(ws, WHAT);
    expect(servedBodies(chain).some((e) => e.path.endsWith("cfg/Defaults.kt") && e.body.includes("timeoutMs = 6500L"))).toBe(true);
  }, 120_000);

  it("control: a real local shadowing the import answers from the local, never from settings.py", async () => {
    const ws = pyWorkspace(
      "shadow",
      "timeout = 6.5\nretries = 3\n",
      "from .settings import timeout\n\n\nclass HttpClient:\n    def request(self, url):\n        timeout = 2.0\n        for attempt in range(3):\n            return fetch(\n                url,\n                timeout=timeout,\n            )\n        return None\n",
    );
    const chain = await ask(ws, WHAT);
    const bodies = servedBodies(chain);
    expect(bodies.some((e) => e.path === "app/client.py" && e.body.includes("timeout = 2.0"))).toBe(true);
    expect(bodies.some((e) => e.path === "app/settings.py")).toBe(false);
    expect(bodies.filter((e) => e.why.startsWith("closure:value timeout"))).toEqual([]);
  }, 120_000);

  // config.go is also served by ordinary discovery (the query says "timeout"
  // and config.go declares one; unchanged from the c0922 build, and the same
  // for a plain `timeout :=` local), so the control is that the VALUE closure
  // never claims it.
  it("control: a Go local declared in a `var (` group answers from the local, never from the package-level var", async () => {
    const ws = makeWorkspace("go");
    writeFile(ws, "go.mod", "module example.com/app\n\ngo 1.22\n");
    writeFile(ws, "client/config.go", "package client\n\nimport \"time\"\n\nvar timeout = 6500 * time.Millisecond\n");
    writeFile(
      ws,
      "client/client.go",
      "package client\n\nimport \"time\"\n\nfunc Request(url string) time.Duration {\n\tvar (\n\t\ttimeout = 2 * time.Second\n\t)\n\tfor attempt := 0; attempt < 3; attempt++ {\n\t\tif url != \"\" {\n\t\t\treturn timeout\n\t\t}\n\t}\n\treturn 0\n}\n",
    );
    const chain = await ask(ws, "What default timeout does Request use?");
    const bodies = servedBodies(chain);
    expect(bodies.some((e) => e.path === "client/client.go" && e.body.includes("timeout = 2 * time.Second"))).toBe(true);
    expect(bodies.filter((e) => e.path === "client/config.go" && e.why.startsWith("closure:value"))).toEqual([]);
  }, 120_000);
});
