/**
 * evaluation0927.r6bValuePropertyClosure.spec.ts — R6-B (round-6 wave,
 * 2026-09-28): regression coverage for review-findings-fable-r5.md's P0-2
 * (value facet `covered` from an unresolved `this.p`/`self.p`/`Owner.P`
 * property chase) and P2-10 (externalPackageConst disclosure wording).
 *
 * Every fixture below is written FRESH against the DESCRIBED defect class —
 * different class/property/constant names, different files, different query
 * wording than the reviewer's own harness cases (`HttpClient`/`options`/
 * `DEFAULT_OPTIONS`, `$SCRATCH/review5/cases5.mjs`) — so a fix that only
 * special-cases the reviewer's exact identifiers would still fail here.
 *
 * Fast, no-server unit tests first (the pure evidenceClosure.ts functions
 * this wave widened); spawned dev-server end-to-end cases follow.
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
import { findOwnerPropertyWindow, selfPropertyReferencesIn, type OwnerMemberSpan } from "../features/task-pack/evidenceClosure.js";

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
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-r6b-${tag}-`));
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
    { tool: "tl_read_file", arguments: { query, task: { epoch: "new", profile: "answer" }, cwd: ws } },
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

/** Mirrors r5bValueFlowFacets.spec.ts's own helper: the moment ANY hop certifies act.answer/act.edit, every marker must already be in the cumulative served bytes. */
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

/**
 * P0-2's own minimum bar: the FIRST time any hop certifies act.answer/
 * act.edit, EITHER `marker` is already in the cumulative served bytes, OR
 * the certificate discloses an honest `request-item-undetermined` value gap.
 * Never silently "covered" (no gap, no marker) — the exact shape of P0-2.
 */
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
// P0-2 unit coverage: selfPropertyReferencesIn's Owner.P widening + the
// bare-receiver-call scoping guard
// ---------------------------------------------------------------------------
describe("P0-2 unit: selfPropertyReferencesIn(bodyLines, hashComment, ownerTypeName)", () => {
  it("matches a bare Owner.p qualified reference when ownerTypeName is supplied", () => {
    const body = ["  return Gateway.PRESET.retryDelayMs;"];
    expect(selfPropertyReferencesIn(body, false, "Gateway")).toEqual(["PRESET"]);
  });
  it("does NOT match a DIFFERENT type's qualified reference", () => {
    const body = ["  return OtherType.PRESET.retryDelayMs;"];
    expect(selfPropertyReferencesIn(body, false, "Gateway")).toEqual([]);
  });
  it("omitted ownerTypeName keeps the original this/self-only behaviour", () => {
    const body = ["  return Gateway.PRESET.retryDelayMs;"];
    expect(selfPropertyReferencesIn(body, false)).toEqual([]);
  });
  it("a property used ONLY as a discarded bare-statement call receiver (this.logger.info(...)) is excluded", () => {
    const body = ['  this.logger.info("dispatching");'];
    expect(selfPropertyReferencesIn(body, false)).toEqual([]);
  });
  it("the SAME property is kept when at least one occurrence is a real value use", () => {
    const body = ['  this.logger.info("dispatching");', "  report(this.logger);"];
    expect(selfPropertyReferencesIn(body, false)).toEqual(["logger"]);
  });
  it("a call whose RESULT feeds a larger expression is never treated as a bare receiver", () => {
    const body = ["  return this.limits.has(status) || attempt < 3;"];
    expect(selfPropertyReferencesIn(body, false)).toEqual(["limits"]);
  });
});

// ---------------------------------------------------------------------------
// P0-2 unit coverage: findOwnerPropertyWindow's typed-field + accessor shapes
// ---------------------------------------------------------------------------
describe("P0-2 unit: findOwnerPropertyWindow widened shapes", () => {
  it("Java/C#-style typed field (`final`/modifiers + a bare type token before the name)", () => {
    const lines = [
      "public class Gateway {",
      "    private final int retryDelayMs = Presets.RETRY_DELAY_MS;",
      "",
      "    public String send(String url) {",
      "        return url;",
      "    }",
      "}",
    ];
    const methodSpans: OwnerMemberSpan[] = [{ start: 4, end: 6, name: "send" }];
    expect(findOwnerPropertyWindow(lines, 1, 7, methodSpans, "retryDelayMs", false)).toEqual({ start: 2, end: 2, truncated: false });
  });

  it("TS read accessor: `get name()` is name's own declaration, body returned as the window", () => {
    const lines = [
      "export class Gateway {",
      "  private get retryDelayMs(): number {",
      "    return PRESET.retryDelayMs;",
      "  }",
      "",
      "  send(): number {",
      "    return this.retryDelayMs;",
      "  }",
      "}",
    ];
    const methodSpans: OwnerMemberSpan[] = [{ start: 2, end: 4, name: "retryDelayMs" }, { start: 6, end: 8, name: "send" }];
    expect(findOwnerPropertyWindow(lines, 1, 9, methodSpans, "retryDelayMs", false)).toEqual({ start: 2, end: 4, truncated: false });
  });

  it("an ordinary same-named METHOD without the `get` keyword is never mistaken for an accessor", () => {
    const lines = [
      "export class Gateway {",
      "  retryDelayMs(): number {",
      "    return 4200;",
      "  }",
      "}",
    ];
    const methodSpans: OwnerMemberSpan[] = [{ start: 2, end: 4, name: "retryDelayMs" }];
    expect(findOwnerPropertyWindow(lines, 1, 5, methodSpans, "retryDelayMs", false)).toBeUndefined();
  });

  it("the untyped shape still wins when it matches (no behaviour change for the pre-existing case)", () => {
    const lines = [
      "export class Gateway {",
      "  private readonly retryDelayMs: number = PRESET_MS;",
      "}",
    ];
    expect(findOwnerPropertyWindow(lines, 1, 3, [], "retryDelayMs", false)).toEqual({ start: 2, end: 2, truncated: false });
  });
});

// ---------------------------------------------------------------------------
// P0-2 end-to-end: never `covered` by an inline literal while the property
// stays unresolved (the minimum bar) -- five distinct unresolved shapes
// ---------------------------------------------------------------------------
const SETTINGS_TS = "export interface Settings { retryDelayMs: number; maxRetries: number }\n\nexport const BASE_SETTINGS: Settings = {\n  retryDelayMs: 4200,\n  maxRetries: 4,\n};\n";
const SEND_BODY = "  async send(url: string): Promise<Response> {\n    for (let attempt = 0; attempt < this.settings.maxRetries; attempt++) {\n      const controller = new AbortController();\n      const timer = setTimeout(() => controller.abort(), this.settings.retryDelayMs);\n      try {\n        return await fetch(url, { signal: controller.signal });\n      } finally {\n        clearTimeout(timer);\n      }\n    }\n    throw new Error(\"exhausted\");\n  }\n";

describe("P0-2 end-to-end: a self-property chase that cannot resolve is never covered by an inline literal", () => {
  it("TS: inherited from a base class in a different file", async () => {
    const ws = makeWorkspace("inherited");
    writeFile(ws, "package.json", '{ "name": "r6b-inherit", "private": true, "type": "module" }\n');
    writeFile(ws, "src/settings.ts", SETTINGS_TS);
    writeFile(ws, "src/base.ts", "import { BASE_SETTINGS, type Settings } from \"./settings\";\n\nexport class Connector {\n  protected readonly settings: Settings = BASE_SETTINGS;\n}\n");
    writeFile(ws, "src/connector.ts", "import { Connector } from \"./base\";\n\nexport class ApiConnector extends Connector {\n" + SEND_BODY + "}\n");
    writeFile(ws, "src/caller.ts", "import { ApiConnector } from \"./connector\";\n\nconst gw = new ApiConnector();\n\nexport async function fetchThing(id: string): Promise<unknown> {\n  const response = await gw.send(`/things/${id}`);\n  return response.json();\n}\n");
    const chain = await ask(ws, "What default retry delay does ApiConnector.send use?");
    assertHonestValueCompletion(chain, "retryDelayMs: 4200");
    const last = chain.hops[chain.hops.length - 1]!;
    const refs = gapRefs(last.response);
    expect(refs.some((g) => g.includes("settings") && g.includes("could not resolve") && g.includes("class body"))).toBe(true);
  }, 60_000);

  it("TS: a constructor parameter with NO default", async () => {
    const ws = makeWorkspace("noDefault");
    writeFile(ws, "package.json", '{ "name": "r6b-nodefault", "private": true, "type": "module" }\n');
    writeFile(ws, "src/settings.ts", SETTINGS_TS);
    writeFile(ws, "src/connector.ts", "import type { Settings } from \"./settings\";\n\nexport class ApiConnector {\n  constructor(private readonly settings: Settings) {}\n\n" + SEND_BODY + "}\n");
    writeFile(ws, "src/caller.ts", "import { ApiConnector } from \"./connector\";\nimport { BASE_SETTINGS } from \"./settings\";\n\nconst gw = new ApiConnector(BASE_SETTINGS);\n\nexport async function fetchThing(id: string): Promise<unknown> {\n  const response = await gw.send(`/things/${id}`);\n  return response.json();\n}\n");
    const chain = await ask(ws, "What default retry delay does ApiConnector.send use?");
    assertHonestValueCompletion(chain, "retryDelayMs: 4200");
  }, 60_000);

  it("TS: assigned by a non-constructor setter-style method", async () => {
    const ws = makeWorkspace("setter");
    writeFile(ws, "package.json", '{ "name": "r6b-setter", "private": true, "type": "module" }\n');
    writeFile(ws, "src/settings.ts", SETTINGS_TS);
    writeFile(ws, "src/connector.ts", "import type { Settings } from \"./settings\";\n\nexport class ApiConnector {\n  private settings!: Settings;\n\n  configure(settings: Settings): void {\n    this.settings = settings;\n  }\n\n" + SEND_BODY + "}\n");
    writeFile(ws, "src/caller.ts", "import { ApiConnector } from \"./connector\";\nimport { BASE_SETTINGS } from \"./settings\";\n\nconst gw = new ApiConnector();\ngw.configure(BASE_SETTINGS);\n\nexport async function fetchThing(id: string): Promise<unknown> {\n  const response = await gw.send(`/things/${id}`);\n  return response.json();\n}\n");
    const chain = await ask(ws, "What default retry delay does ApiConnector.send use?");
    assertHonestValueCompletion(chain, "retryDelayMs: 4200");
  }, 60_000);

  it("Java: a typed field initialized from a qualified Class.CONST reference", async () => {
    const ws = makeWorkspace("javaField");
    writeFile(ws, "pom.xml", "<project><modelVersion>4.0.0</modelVersion><groupId>app</groupId><artifactId>app</artifactId><version>1</version></project>\n");
    writeFile(ws, "src/main/java/app/Presets.java", "package app;\n\npublic final class Presets {\n    public static final int RETRY_DELAY_MS = 4200;\n    public static final int MAX_RETRIES = 4;\n}\n");
    writeFile(
      ws,
      "src/main/java/app/Gateway.java",
      "package app;\n\nimport java.net.http.HttpRequest;\n\npublic class Gateway {\n    private final int retryDelayMs = Presets.RETRY_DELAY_MS;\n\n    public String send(String url) {\n        for (int attempt = 0; attempt < 3; attempt++) {\n            HttpRequest req = HttpRequest.newBuilder().timeout(java.time.Duration.ofMillis(this.retryDelayMs)).build();\n            if (req != null) return url;\n        }\n        throw new IllegalStateException(\"exhausted\");\n    }\n}\n",
    );
    writeFile(ws, "src/main/java/app/Main.java", "package app;\n\npublic class Main {\n    public static void main(String[] args) {\n        Gateway gw = new Gateway();\n        System.out.println(gw.send(\"/things/1\"));\n    }\n}\n");
    const chain = await ask(ws, "What default retry delay does Gateway.send use?");
    assertHonestValueCompletion(chain, "RETRY_DELAY_MS = 4200");
  }, 60_000);

  it("Python: inherited via a base class's __init__", async () => {
    const ws = makeWorkspace("pyInherited");
    writeFile(ws, "pyproject.toml", "[project]\nname = \"r6bpy\"\nversion = \"0.1.0\"\n");
    writeFile(ws, "gw/presets.py", "RETRY_DELAY_S = 4.2\nMAX_RETRIES = 4\n");
    writeFile(ws, "gw/base.py", "from .presets import RETRY_DELAY_S\n\n\nclass Connector:\n    def __init__(self):\n        self.retry_delay = RETRY_DELAY_S\n");
    writeFile(ws, "gw/gateway.py", "import urllib.request\n\nfrom .base import Connector\n\n\nclass ApiGateway(Connector):\n    def send(self, url):\n        for attempt in range(3):\n            response = urllib.request.urlopen(url, timeout=self.retry_delay)\n            if response.status < 500:\n                return response\n        raise RuntimeError(\"exhausted\")\n");
    writeFile(ws, "gw/caller.py", "from .gateway import ApiGateway\n\ngw = ApiGateway()\n\n\ndef fetch_thing(pid):\n    return gw.send(f\"/things/{pid}\")\n");
    const chain = await ask(ws, "What default retry delay does ApiGateway.send use?");
    assertHonestValueCompletion(chain, "RETRY_DELAY_S = 4.2");
  }, 60_000);

  it("TS: a static Owner.P reference to a property this scan cannot find anywhere (control: Owner.P also flows through the honesty gate, not just the resolving path)", async () => {
    const ws = makeWorkspace("staticUnresolved");
    writeFile(ws, "package.json", '{ "name": "r6b-static-unresolved", "private": true, "type": "module" }\n');
    writeFile(ws, "src/settings.ts", SETTINGS_TS);
    writeFile(
      ws,
      "src/connector.ts",
      "export class ApiConnector {\n  async send(url: string): Promise<Response> {\n    for (let attempt = 0; attempt < ApiConnector.FEATURE_FLAGS.maxRetries; attempt++) {\n      const response = await fetch(url);\n      if (response.ok) return response;\n    }\n    throw new Error(\"exhausted\");\n  }\n}\n",
    );
    writeFile(ws, "src/caller.ts", "import { ApiConnector } from \"./connector\";\n\nconst gw = new ApiConnector();\n\nexport async function fetchThing(id: string): Promise<unknown> {\n  const response = await gw.send(`/things/${id}`);\n  return response.json();\n}\n");
    const chain = await ask(ws, "What default retry limit does ApiConnector.send use?");
    const last = chain.hops[chain.hops.length - 1]!;
    const refs = gapRefs(last.response);
    expect(refs.some((g) => g.includes("FEATURE_FLAGS") && g.includes("could not resolve"))).toBe(true);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// P0-2 end-to-end: the BETTER outcome -- a getter and a static Owner.P
// reference both resolve fully (real evidence, not just an honest gap)
// ---------------------------------------------------------------------------
describe("P0-2 end-to-end: resolvable shapes reach the real constant, not just an honest gap", () => {
  it("TS: a read accessor (`get retryDelayMs()`) resolves through its own body", async () => {
    const ws = makeWorkspace("getter");
    writeFile(ws, "package.json", '{ "name": "r6b-getter", "private": true, "type": "module" }\n');
    writeFile(ws, "src/settings.ts", SETTINGS_TS);
    writeFile(
      ws,
      "src/connector.ts",
      "import { BASE_SETTINGS } from \"./settings\";\n\nexport class ApiConnector {\n  private get retryDelayMs(): number {\n    return BASE_SETTINGS.retryDelayMs;\n  }\n\n  async send(url: string): Promise<Response> {\n    for (let attempt = 0; attempt < 3; attempt++) {\n      const controller = new AbortController();\n      const timer = setTimeout(() => controller.abort(), this.retryDelayMs);\n      try {\n        return await fetch(url, { signal: controller.signal });\n      } finally {\n        clearTimeout(timer);\n      }\n    }\n    throw new Error(\"exhausted\");\n  }\n}\n",
    );
    writeFile(ws, "src/caller.ts", "import { ApiConnector } from \"./connector\";\n\nconst gw = new ApiConnector();\n\nexport async function fetchThing(id: string): Promise<unknown> {\n  const response = await gw.send(`/things/${id}`);\n  return response.json();\n}\n");
    const chain = await ask(ws, "What default retry delay does ApiConnector.send use?");
    assertNoFalseCompletion(chain, ["retryDelayMs: 4200"]);
  }, 60_000);

  it("TS: a static Owner.P reference resolves through the ordinary field shape", async () => {
    const ws = makeWorkspace("static");
    writeFile(ws, "package.json", '{ "name": "r6b-static", "private": true, "type": "module" }\n');
    writeFile(ws, "src/settings.ts", SETTINGS_TS);
    writeFile(
      ws,
      "src/connector.ts",
      "import { BASE_SETTINGS } from \"./settings\";\n\nexport class ApiConnector {\n  static readonly PRESET = BASE_SETTINGS;\n\n  async send(url: string): Promise<Response> {\n    for (let attempt = 0; attempt < ApiConnector.PRESET.maxRetries; attempt++) {\n      const controller = new AbortController();\n      const timer = setTimeout(() => controller.abort(), ApiConnector.PRESET.retryDelayMs);\n      try {\n        return await fetch(url, { signal: controller.signal });\n      } finally {\n        clearTimeout(timer);\n      }\n    }\n    throw new Error(\"exhausted\");\n  }\n}\n",
    );
    writeFile(ws, "src/caller.ts", "import { ApiConnector } from \"./connector\";\n\nconst gw = new ApiConnector();\n\nexport async function fetchThing(id: string): Promise<unknown> {\n  const response = await gw.send(`/things/${id}`);\n  return response.json();\n}\n");
    const chain = await ask(ws, "What default retry delay does ApiConnector.send use?");
    assertNoFalseCompletion(chain, ["retryDelayMs: 4200"]);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// P0-2 scoping control: an unrelated this.logger (used only as a discarded
// call receiver) must never turn an otherwise-resolvable question undetermined
// ---------------------------------------------------------------------------
describe("P0-2 scoping control: an irrelevant this.logger never blocks a resolvable value facet", () => {
  it("TS: this.logger.info(...) alongside a resolving this.settings reference", async () => {
    const ws = makeWorkspace("loggerControl");
    writeFile(ws, "package.json", '{ "name": "r6b-logger-control", "private": true, "type": "module" }\n');
    writeFile(ws, "src/settings.ts", SETTINGS_TS);
    writeFile(
      ws,
      "src/connector.ts",
      "import { BASE_SETTINGS, type Settings } from \"./settings\";\n\nexport class ApiConnector {\n  private readonly settings: Settings = BASE_SETTINGS;\n  private readonly logger = console;\n\n  async send(url: string): Promise<Response> {\n    this.logger.info(\"dispatching\");\n    for (let attempt = 0; attempt < this.settings.maxRetries; attempt++) {\n      const controller = new AbortController();\n      const timer = setTimeout(() => controller.abort(), this.settings.retryDelayMs);\n      try {\n        return await fetch(url, { signal: controller.signal });\n      } finally {\n        clearTimeout(timer);\n      }\n    }\n    throw new Error(\"exhausted\");\n  }\n}\n",
    );
    writeFile(ws, "src/caller.ts", "import { ApiConnector } from \"./connector\";\n\nconst gw = new ApiConnector();\n\nexport async function fetchThing(id: string): Promise<unknown> {\n  const response = await gw.send(`/things/${id}`);\n  return response.json();\n}\n");
    const chain = await ask(ws, "What default retry delay does ApiConnector.send use?");
    assertNoFalseCompletion(chain, ["retryDelayMs: 4200"]);
    for (const hop of chain.hops) {
      const refs = gapRefs(hop.response);
      expect(refs.some((g) => g.includes("logger"))).toBe(false);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// P2-10 end-to-end: an external-package constant names the package, never the
// generic "no declaration was found" wording
// ---------------------------------------------------------------------------
describe("P2-10 end-to-end: an external-package constant is disclosed naming the package", () => {
  it("TS: a bare ALL-CAPS name (no underscore) imported from a non-relative package specifier", async () => {
    const ws = makeWorkspace("externalPkg");
    writeFile(ws, "package.json", '{ "name": "r6b-external", "private": true, "type": "module", "dependencies": { "@example/gateway-defaults": "^2.0.0" } }\n');
    writeFile(
      ws,
      "src/dispatch.ts",
      "import { GATEWAYDEFAULTS } from \"@example/gateway-defaults\";\n\nexport async function dispatch(url: string): Promise<Response> {\n  for (let attempt = 0; attempt < GATEWAYDEFAULTS.maxRetries; attempt++) {\n    const response = await fetch(url, { signal: AbortSignal.timeout(GATEWAYDEFAULTS.retryDelayMs) });\n    if (response.ok) return response;\n  }\n  throw new Error(\"exhausted\");\n}\n",
    );
    const chain = await ask(ws, "What default retry delay does dispatch use?");
    const last = chain.hops[chain.hops.length - 1]!;
    const refs = gapRefs(last.response);
    expect(refs.some((g) =>
      g.includes("GATEWAYDEFAULTS") && g.includes("imported from package @example/gateway-defaults")
    )).toBe(true);
    // Never the OLD, imprecise wording this finding replaces.
    expect(refs.some((g) => g.includes("GATEWAYDEFAULTS") && g.includes("no declaration was found"))).toBe(false);
  }, 60_000);
});
