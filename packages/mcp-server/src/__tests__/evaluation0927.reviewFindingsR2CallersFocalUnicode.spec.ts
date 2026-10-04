/**
 * evaluation0927.reviewFindingsR2CallersFocalUnicode.spec.ts — R3-A1
 * (round-3 wave, 2026-09-28): regression coverage for
 * review-findings-fable-r2.md's "callers, focal, Unicode" findings —
 * P0-1, P0-2, P1-7, P1-9, P2-12, and the kanji concept-fallback slice of
 * finding 3. Each fixture below is written fresh against the DESCRIBED
 * defect class (never copied from the reviewer's own harness fixtures), so
 * a fix that only special-cases the reviewer's exact file/identifier names
 * would still fail here.
 *
 * Fast, no-server unit tests first (callerExpansion.ts's own exported pure
 * functions); spawned dev-server end-to-end cases follow, one describe
 * block per finding.
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
  isAlwaysKeywordLedLanguage,
  opensBlockDeclaration,
} from "../features/task-pack/callerExpansion.js";

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
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-r3a1-${tag}-`));
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

async function ask(ws: string, query: string, hopCap = 20): Promise<ChainResult> {
  const s = await spawnedServer(ws);
  return followNextToEnd(
    s,
    { tool: "tl_read_file", arguments: { query, task: { epoch: "new", profile: "answer" }, cwd: ws } },
    { cwd: ws, hopCap },
  );
}

/** Every `evidence[]`/`entries[]` body row's `.why` string across every hop, concatenated (whitespace-joined) so a substring check reads naturally. */
function allWhy(chain: ChainResult): string {
  return chain.hops
    .flatMap((h) => (h.response?.["evidence"] as Array<Record<string, unknown>> | undefined) ?? [])
    .map((e) => String(e["why"] ?? ""))
    .join(" | ");
}

function allGaps(chain: ChainResult): string {
  return chain.hops
    .map((h) => JSON.stringify((h.response?.["decision"] as Record<string, unknown> | undefined)?.["certificate"] ?? {}))
    .join(" | ");
}

// ---------------------------------------------------------------------------
// P0-1 (fast, no server): a bare call-shaped occurrence whose line ends
// with `{` because of an ARGUMENT (object literal / callback / dict), never
// its own body, must never read as a declaration -- and a keyword-led
// language's bare occurrence must never read as a declaration at all.
// ---------------------------------------------------------------------------
describe("P0-1 — opensBlockDeclaration: an argument's own `{` is never X's body opener", () => {
  it("an object-literal argument left open on this line is a call, not a declaration", () => {
    // publish("orders.created", {   <- the `{` belongs to the SECOND ARGUMENT, not publish's own body
    const masked = 'publish(               , {';
    expect(opensBlockDeclaration(masked, "")).toBe(false);
  });

  it("a callback argument left open on this line is a call, not a declaration", () => {
    // schedule("nightly", function() {
    const masked = 'schedule(          , function() {';
    expect(opensBlockDeclaration(masked, "")).toBe(false);
  });

  it("a same-line declaration (own paren-matched param list, then {) is still recognized", () => {
    expect(opensBlockDeclaration("cancel(id) {", "")).toBe(true);
    expect(opensBlockDeclaration("public ClientOptions loadOptions(Foo x) {", "public ClientOptions ")).toBe(true);
  });

  it("a deferred body opener on the NEXT non-blank line is recognized when supplied — behind a declaration head", () => {
    // R4-A2: the lookahead parameter is now an ORDERED array of further
    // masked lines (a multi-line parameter list may need more than one —
    // see callSiteClassificationMatrix.spec.ts), not a single string.
    //
    // Round 5 (orchestrator ruling, eval-0927 review-r4 cell
    // ts-bare-multiline-call-then-block): with NO head at all, `cancel(id)`
    // then `{` on the next line reads equally as an Allman-style JS method
    // or as a call statement followed by a block. Reading a CALL as a
    // declaration drops the call site AND hides it from the mention guard
    // (a declaration line is "explained"), which can end in a false "no
    // callers"; reading a rare head-less Allman method as a call only adds a
    // false caller. So the head-less form is a call; a head (a type, a
    // modifier, a return annotation) still proves the declaration.
    expect(opensBlockDeclaration("cancel(id)", "", false, ["{"])).toBe(false);
    expect(opensBlockDeclaration("public void cancel(id)", "public void ", false, ["{"])).toBe(true);
    expect(opensBlockDeclaration("cancel(id): Result", "", false, ["{"])).toBe(true);
    expect(opensBlockDeclaration("cancel(id)", "", false, undefined)).toBe(false);
  });

  it("a Kotlin-style trailing lambda (bare call, paren closes, then `{`) is a CALL when the language always keyword-leads", () => {
    // repeat(5) {  -- Kotlin has no keyword-less declaration syntax at all
    expect(opensBlockDeclaration("repeat(5) {", "", true)).toBe(false);
    // The identical shape with the language flag OFF (TS/JS-like) is still a declaration.
    expect(opensBlockDeclaration("repeat(5) {", "", false)).toBe(true);
  });

  it("isAlwaysKeywordLedLanguage recognizes Kotlin/Rust/Swift/Go/Python/Ruby/Scala and rejects TS/Java/C#", () => {
    for (const p of ["a.kt", "a.rs", "a.swift", "a.go", "a.py", "a.rb", "a.scala"]) {
      expect(isAlwaysKeywordLedLanguage(p), p).toBe(true);
    }
    for (const p of ["a.ts", "a.tsx", "a.java", "a.cs", "a.cpp"]) {
      expect(isAlwaysKeywordLedLanguage(p), p).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// P2-12 (fast, no server): a generic return type's own comma never cuts the
// declaration head, at any nesting depth.
// ---------------------------------------------------------------------------
describe("P2-12 — a generic return type is one declaration-head token, comma and nesting included", () => {
  it("Map<String, Integer> counts(...) { is a declaration head", () => {
    expect(opensBlockDeclaration("Map<String, Integer> counts(String scope) {", "Map<String, Integer> ")).toBe(true);
  });
  it("nested generics Foo<Bar<Baz>> are one token too", () => {
    expect(opensBlockDeclaration("Foo<Bar<Baz>> build(int n) {", "Foo<Bar<Baz>> ")).toBe(true);
  });
  it("a wildcard bound List<? extends T> is one token too", () => {
    expect(opensBlockDeclaration("List<? extends T> items(int n) {", "List<? extends T> ")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P0-1/P2-12 end-to-end: fresh fixtures, never the reviewer's own file/
// function names.
// ---------------------------------------------------------------------------
describe("P0-1/P2-12 end-to-end — callers of a function whose only call site is an open argument or a generic-return sibling", () => {
  it("a bare call with a multi-line dict argument (Python) is found as the caller, never mistaken for a declaration", async () => {
    const ws = makeWorkspace("p01-py");
    writeFile(ws, "pyproject.toml", '[project]\nname = "p01py"\nversion = "0.1.0"\n');
    writeFile(
      ws,
      "app/audit.py",
      "def audit(event, payload):\n    print(event, payload)\n",
    );
    writeFile(
      ws,
      "app/checkout.py",
      "from .audit import audit\n\n\ndef finalize_order(order):\n    audit(order.id, {\n        \"stage\": \"finalize\",\n        \"total\": order.total,\n    })\n    return True\n",
    );
    const chain = await ask(ws, "Who calls audit?");
    const why = allWhy(chain);
    expect(why).toContain("closure:callers audit");
    expect(why).toContain("1 of 1 call sites");
    expect(allGaps(chain)).not.toContain("request-item-empty:callers:audit");
  });

  it("a Java sibling class's generic-return-type method of the same name is never counted as a caller of the real one", async () => {
    const ws = makeWorkspace("p212-java");
    writeFile(ws, "pom.xml", "<project><modelVersion>4.0.0</modelVersion><groupId>x</groupId><artifactId>y</artifactId><version>1</version></project>\n");
    writeFile(
      ws,
      "src/main/java/app/Inventory.java",
      "package app;\n\nimport java.util.HashMap;\nimport java.util.Map;\n\npublic class Inventory {\n  public Map<String, Integer> tally(String bucket) {\n    Map<String, Integer> out = new HashMap<>();\n    out.put(bucket, 1);\n    return out;\n  }\n}\n",
    );
    writeFile(
      ws,
      "src/main/java/app/Decoy.java",
      "package app;\n\nimport java.util.HashMap;\nimport java.util.Map;\n\npublic class Decoy {\n  Map<String, Integer> tally(String bucket) {\n    return new HashMap<>();\n  }\n}\n",
    );
    writeFile(
      ws,
      "src/main/java/app/Main.java",
      "package app;\n\npublic class Main {\n  public static void main(String[] args) {\n    Inventory inventory = new Inventory();\n    System.out.println(inventory.tally(\"all\"));\n  }\n}\n",
    );
    const chain = await ask(ws, "Who calls Inventory.tally?");
    const why = allWhy(chain);
    expect(why).toContain("closure:callers tally");
    expect(why).toContain("1 of 1 call sites");
  });
});

// ---------------------------------------------------------------------------
// P0-2 end-to-end: a non-keyword (method-shorthand) declaration must win
// the focal race even past many decoy callers, and a still-mismatched
// focal name must never certify "empty" under the wrong identity.
// ---------------------------------------------------------------------------
describe("P0-2 — a keyword-less declaration wins focal resolution past many decoy callers; a name mismatch is never certified empty", () => {
  it("a TS class-method (no modifier) declaration is the focal, not a mention-fallback decoy, past 40+ callers", async () => {
    const ws = makeWorkspace("p02-ts");
    writeFile(ws, "package.json", '{ "name": "p02ts", "private": true, "type": "module" }\n');
    writeFile(
      ws,
      "src/zzregistry.ts",
      "export class WidgetRegistry {\n  constructor(private readonly base: string) {}\n\n  lookupItem(key: string): Promise<unknown> {\n    return fetch(this.base + key).then((r) => r.json());\n  }\n}\n\nexport const registry = new WidgetRegistry(\"https://example.test\");\n",
    );
    for (let i = 0; i < 42; i++) {
      writeFile(
        ws,
        `src/api/w${String(i).padStart(2, "0")}.ts`,
        `import { registry } from "../zzregistry";\n\nexport async function getW${i}(id: string): Promise<unknown> {\n  return registry.lookupItem(\`/w${i}/\${encodeURIComponent(id)}\`);\n}\n`,
      );
    }
    const chain = await ask(ws, "Who calls lookupItem?", 20);
    const gaps = allGaps(chain);
    // Never presented under a decoy mention's name (e.g. "getW0"):
    expect(gaps).not.toContain("callers:getW");
    // Either genuinely resolved (closure ran under the real name) or an
    // honest, non-empty disclosure -- never a false "0 call sites" under
    // the wrong identity.
    expect(gaps).not.toMatch(/callers:getW\d+ \(0 call sites/);
  });
});

// ---------------------------------------------------------------------------
// P1-7 end-to-end: known call sites past the old fixed 24-per-hop cap keep
// paginating via open/next instead of a dead-end "undetermined, no next".
// ---------------------------------------------------------------------------
describe("P1-7 — more than 24 known call sites keep discovering (open/next) until served or genuinely unreadable", () => {
  it("30 real callers of a plain top-level function eventually reach a decision that is never a silent, gapless false-covered", async () => {
    const ws = makeWorkspace("p17-many");
    writeFile(ws, "package.json", '{ "name": "p17many", "private": true, "type": "module" }\n');
    writeFile(
      ws,
      "src/ledger.ts",
      "export function recordTx(id: string, amount: number): void {\n  console.log(id, amount);\n}\n",
    );
    for (let i = 0; i < 30; i++) {
      writeFile(
        ws,
        `src/tx/t${String(i).padStart(2, "0")}.ts`,
        `import { recordTx } from "../ledger";\n\nexport function runT${i}(): void {\n  recordTx("t${i}", ${i});\n}\n`,
      );
    }
    const chain = await ask(ws, "Who calls recordTx?", 30);
    const finalHop = chain.hops[chain.hops.length - 1]!;
    const finalDecision = (finalHop.response?.["decision"] as Record<string, unknown> | undefined)?.["kind"];
    // The chain must terminate on a real decision (act.answer or a
    // disclosed discover/undetermined), never loop forever, and if it
    // certifies, it must be under the real name with an honest count.
    expect(["act.answer", "discover"]).toContain(finalDecision);
    const gaps = allGaps(chain);
    if (gaps.includes("callers:recordTx")) {
      expect(gaps).not.toContain("callers:recordTx (0 call sites");
    }
  });
});

// ---------------------------------------------------------------------------
// P1-9 end-to-end: a Unicode (non-ASCII, non-CJK) identifier is found by
// name, by callers, and by tl_search_files references -- a FRESH script
// (Turkish/French-accented) never used by the reviewer's own fixtures.
// ---------------------------------------------------------------------------
describe("P1-9 — a Latin-with-diacritics identifier resolves like any ASCII one", () => {
  it("a French-accented function name is found as the focal and its caller is served", async () => {
    const ws = makeWorkspace("p19-fr");
    writeFile(ws, "package.json", '{ "name": "p19fr", "private": true, "type": "module" }\n');
    writeFile(
      ws,
      "src/longueur.ts",
      "export function longueur(éléments: number[]): number {\n  const résultat = éléments.length;\n  return résultat * 3;\n}\n",
    );
    writeFile(
      ws,
      "src/consommateur.ts",
      "import { longueur } from \"./longueur\";\n\nexport function rapport(): number {\n  return longueur([1, 2, 3]);\n}\n",
    );
    const chain = await ask(ws, "Where is longueur used and what does it return?");
    const why = allWhy(chain);
    expect(why).toMatch(/longueur/);
    const lastBody = chain.hops[chain.hops.length - 1]!.response;
    expect(JSON.stringify(lastBody)).not.toContain("neither an identifier");
  });

  it("tl_search_files references finds a Latin-with-diacritics symbol instead of refusing it as invalid input", async () => {
    const ws = makeWorkspace("p19-refs");
    writeFile(ws, "package.json", '{ "name": "p19refs", "private": true, "type": "module" }\n');
    writeFile(ws, "src/étage.ts", "export function étage(n: number): number {\n  return n + 1;\n}\nexport const résultat = étage(2);\n");
    const s = await spawnedServer(ws);
    const r = await s.callTool("tl_search_files", { action: "references", scope: { symbol: "étage" }, cwd: ws });
    expect(r.body["kind"]).toBe("search.references");
    expect(r.body["code"]).not.toBe("invalid-input");
    const refs = (r.body["references"] as Array<Record<string, unknown>> | undefined) ?? [];
    expect(refs.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Kanji concept fallback: bounded by MATCHES, not by walk order -- the real
// match sorts well past the old 40-file walk-order prefix.
// ---------------------------------------------------------------------------
describe("kanji concept fallback — bestConceptAnchoredCandidate is bounded by matches, not file order", () => {
  it("a kanji-only query still reaches the real match when 45 decoy files sort ahead of it in the walk", async () => {
    const ws = makeWorkspace("kanji-fallback");
    writeFile(ws, "package.json", '{ "name": "kanjifallback", "private": true, "type": "module" }\n');
    // Decoys sort ALPHABETICALLY ahead of "zzz_taimuauto.ts" and mention
    // none of the bridged concept terms at all.
    for (let i = 0; i < 45; i++) {
      writeFile(
        ws,
        `src/aaa/pad${String(i).padStart(2, "0")}.ts`,
        `export function pad${i}(items: number[]): number {\n  return items.length * ${i};\n}\n`,
      );
    }
    // The real match: last in walk order, its NAME anchors the bridged
    // concept term for "timeout" (待ち時間 -> timeout).
    writeFile(
      ws,
      "src/zzz_taimuauto.ts",
      "export function defaultTimeoutMs(): number {\n  // the default timeout applied to every outbound request\n  return 4000;\n}\n",
    );
    const chain = await ask(ws, "既定の待ち時間はいくつですか。", 20);
    const servedPaths = chain.hops
      .flatMap((h) => (h.response?.["evidence"] as Array<Record<string, unknown>> | undefined) ?? [])
      .map((e) => String(e["path"] ?? ""));
    expect(servedPaths.some((p) => p.includes("zzz_taimuauto"))).toBe(true);
  });
});
