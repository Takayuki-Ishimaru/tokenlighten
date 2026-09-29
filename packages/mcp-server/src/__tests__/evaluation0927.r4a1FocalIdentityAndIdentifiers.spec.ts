/**
 * evaluation0927.r4a1FocalIdentityAndIdentifiers.spec.ts — R4-A1 (round-4
 * wave, 2026-09-28): regression coverage for review-findings-fable-r3.md's
 * "focal identity and identifier extraction" findings — P0-1 (qualified
 * member), P0-2 (same-named method in another class), P0-3 identity half
 * (case/underscore-insensitive fallback), P1-7 (JA-glued identifiers),
 * P1-8 (non-code-shaped identifier candidates), and P2-14 (the "sequences"
 * phrasing idiom). Every fixture below is written FRESH against the
 * DESCRIBED defect class (different identifiers/domains than the
 * reviewer's own harness fixtures — größe/計算/loadOptions/HttpClient.
 * fetchJson/OrderService.cancel/fetchJSON wrapper), so a fix that only
 * special-cases the reviewer's exact names would still fail here.
 *
 * Fast, no-server unit tests first (requestFacets.ts's own exported pure
 * functions); spawned dev-server end-to-end cases follow, one describe
 * block per finding; negative controls (ordinary EN, already-spaced JA, an
 * unrelated prose word, a non-existent qualified member) close the file so
 * a shared-rule change (P1-7/P1-8 touch every pack's identifier extraction)
 * is proven not to regress the common path.
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
  type ConfigName,
  type ServerHandle,
} from "./helpers/qualityFirstScenarios.js";
import {
  explicitIdentifiersIn,
  qualifiedMemberPairsIn,
  weakSubjectCandidatesIn,
  conceptTermsIn,
} from "../features/task-pack/requestFacets.js";

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
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-r4a1-${tag}-`));
  tmpDirs.push(ws);
  return ws;
}

function writeFile(ws: string, rel: string, content: string): void {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

async function spawnedServer(ws: string, config: ConfigName = "default"): Promise<ServerHandle> {
  const s = startDevServer(ws, config);
  servers.push(s);
  await s.initialize();
  return s;
}

async function ask(ws: string, query: string, config: ConfigName = "default", hopCap = 20): Promise<ChainResult> {
  const s = await spawnedServer(ws, config);
  return followNextToEnd(
    s,
    { tool: "read_file", arguments: { query, task: { epoch: "new", profile: "answer" }, cwd: ws } },
    { cwd: ws, hopCap },
  );
}

function allGaps(chain: ChainResult): string {
  return chain.hops
    .map((h) => JSON.stringify((h.response?.["decision"] as Record<string, unknown> | undefined)?.["certificate"] ?? {}))
    .join(" | ");
}

/** Every served body (evidence + entries + top-level content) across every hop, concatenated — for "was the real call site's line shipped" checks. */
function allBodies(chain: ChainResult): string {
  const parts: string[] = [];
  for (const h of chain.hops) {
    const body = h.response as Record<string, unknown> | undefined;
    if (typeof body?.["content"] === "string") parts.push(body["content"] as string);
    for (const e of (body?.["evidence"] as Array<Record<string, unknown>> | undefined) ?? []) {
      if (typeof e["body"] === "string") parts.push(e["body"] as string);
    }
    for (const e of (body?.["entries"] as Array<Record<string, unknown>> | undefined) ?? []) {
      if (typeof e["content"] === "string") parts.push(e["content"] as string);
    }
  }
  return parts.join("\n");
}

function finalDecisionKind(chain: ChainResult): unknown {
  const finalHop = chain.hops[chain.hops.length - 1]!;
  return (finalHop.response?.["decision"] as Record<string, unknown> | undefined)?.["kind"];
}

// =============================================================================
// Fast, no-server unit tests — requestFacets.ts's own exported pure functions.
// =============================================================================

describe("P1-7 (unit) — explicitIdentifiersIn stops at a Latin/CJK script boundary", () => {
  it("an ASCII identifier glued directly to a JA particle is isolated from the particle", () => {
    // Fresh identifier ("parseConfig"), never the reviewer's "loadOptions"/"HTTP_TIMEOUT_MS".
    const ids = explicitIdentifiersIn("parseConfigの呼び出し元を教えてください。");
    expect(ids).toContain("parseConfig");
    expect(ids.some((t) => t.length > "parseConfig".length + 3)).toBe(false); // no glued blob
  });

  it("a pure-CJK run is still one token (unaffected by the script-boundary split)", () => {
    // Fresh CJK identifier ("検証"), never the reviewer's "計算".
    const ids = explicitIdentifiersIn("検証はどこで定義されていますか");
    // Not code-shaped (no camelCase/underscore/ALLCAPS), so it never appears
    // in explicitIdentifiersIn's own output — this only asserts the
    // script-boundary split does not FRAGMENT the CJK run into single
    // characters when tokenizing (verified indirectly via weakSubjectCandidatesIn below).
    expect(ids).toEqual([]);
  });

  it("a pure Latin-with-diacritics word is completely unaffected (zero behavior change) — backtick-quoted stays recognized", () => {
    // `isPascalCaseHump`/the camelCase-hump regex are ASCII-anchored by
    // design (module doc: "no heuristic here decides" case-shape for a
    // bare Unicode word) — unaffected by the P1-7 tokenizer fix either way.
    // The backtick rule (`backticked.has(key)`), which does not require an
    // ASCII-shaped hump, is the guaranteed, unaffected path this asserts.
    const ids = explicitIdentifiersIn("Who calls `überprüfenWert`?");
    expect(ids).toContain("überprüfenWert");
  });
});

describe("P0-1 (unit) — qualifiedMemberPairsIn extracts owner/member pairs for '.', '#', and '::'", () => {
  it("dot, hash, and double-colon separators all yield the same {owner, member} shape", () => {
    expect(qualifiedMemberPairsIn("Who calls Billing.charge?")).toEqual([{ owner: "Billing", member: "charge" }]);
    expect(qualifiedMemberPairsIn("Who calls Billing#charge?")).toEqual([{ owner: "Billing", member: "charge" }]);
    expect(qualifiedMemberPairsIn("Who calls Billing::charge?")).toEqual([{ owner: "Billing", member: "charge" }]);
  });

  it("is capped at 2 pairs (a targeted anchor, not a general scan)", () => {
    const pairs = qualifiedMemberPairsIn("Compare A.one, B.two, C.three, and D.four.");
    expect(pairs.length).toBe(2);
  });

  it("a plain unqualified clause yields no pairs at all", () => {
    expect(qualifiedMemberPairsIn("Who calls charge?")).toEqual([]);
  });
});

describe("P1-8 (unit) — weakSubjectCandidatesIn offers non-code-shaped words, excluding facet-verb noise", () => {
  it("a lowercase Latin-with-diacritics subject is offered, 'who'/'calls' are not", () => {
    const cands = weakSubjectCandidatesIn("Who calls wähle?", []);
    expect(cands).toContain("wähle");
    expect(cands).not.toContain("calls");
    expect(cands).not.toContain("who");
  });

  it("a bare CJK subject is offered as one token", () => {
    const cands = weakSubjectCandidatesIn("Who calls 検証?", []);
    expect(cands).toEqual(["検証"]);
  });

  it("an already-explicit (code-shaped) identifier is never duplicated into the weak list", () => {
    const cands = weakSubjectCandidatesIn("Who calls fetchData?", ["fetchData"]);
    expect(cands).not.toContain("fetchData");
  });

  it("is capped at 4 words per clause", () => {
    const cands = weakSubjectCandidatesIn("prüfen wähle söhne blüten grüße höhle", []);
    expect(cands.length).toBeLessThanOrEqual(4);
  });
});

describe("P2-14 (unit) — 'sequences/sequenced' is masked in the 'how X ...' idiom exactly like 'handles'", () => {
  it("the EN stem 'sequence' never survives conceptTermsIn for a 'how X sequences A, B' clause", () => {
    const terms = conceptTermsIn("Explain how PaymentPipeline sequences authorization, capture, and settlement.");
    expect(terms).not.toContain("sequence");
  });

  it("'sequenced' (past tense) is masked the same way", () => {
    const terms = conceptTermsIn("How are the steps sequenced in PaymentPipeline?");
    expect(terms).not.toContain("sequenced");
  });

  it("a genuine domain use of 'sequence' OUTSIDE the 'how X <verb>s' shape is untouched", () => {
    const terms = conceptTermsIn("What is the retry sequence for PaymentPipeline?");
    expect(terms).toContain("sequence");
  });
});

// =============================================================================
// End-to-end: spawned dev server, fresh fixtures per finding.
// =============================================================================

describe("P0-1 — a qualified 'Owner.member' clause resolves to the MEMBER, never the owner class", () => {
  it("TS: 'Who calls Billing.charge?' never credits Billing's own construction as a call site", async () => {
    const ws = makeWorkspace("p01-ts");
    writeFile(ws, "package.json", '{ "name": "p01ts", "private": true, "type": "module" }\n');
    writeFile(
      ws,
      "src/billing.ts",
      "export class Billing {\n  constructor(private readonly ledger: Map<string, number>) {}\n\n  charge(id: string, amount: number): void {\n    this.ledger.set(id, amount);\n  }\n\n  refund(id: string): void {\n    this.ledger.delete(id);\n  }\n}\n",
    );
    writeFile(
      ws,
      "src/api/checkout.ts",
      "import { Billing } from \"../billing\";\n\nconst billing = new Billing(new Map());\n\nexport function checkout(id: string, amount: number): void {\n  billing.charge(id, amount);\n}\n",
    );
    const chain = await ask(ws, "Who calls Billing.charge?");
    const gaps = allGaps(chain);
    // Never certified empty under the CLASS's own name (the "new Billing(...)"
    // construction miscounted as the member's own call site).
    expect(gaps).not.toMatch(/callers:Billing \(/);
    const bodies = allBodies(chain);
    expect(bodies).toMatch(/billing\.charge\(id, amount\)/);
  });

  it("Python: 'Who calls Billing.charge?' resolves to the method inside the class", async () => {
    const ws = makeWorkspace("p01-py");
    writeFile(ws, "pyproject.toml", "[project]\nname = \"p01py\"\nversion = \"0.1.0\"\n");
    writeFile(
      ws,
      "billing/core.py",
      "class Billing:\n    def __init__(self, ledger):\n        self.ledger = ledger\n\n    def charge(self, order_id, amount):\n        self.ledger[order_id] = amount\n\n    def refund(self, order_id):\n        self.ledger.pop(order_id, None)\n",
    );
    writeFile(
      ws,
      "billing/api.py",
      "from .core import Billing\n\nbilling = Billing({})\n\n\ndef checkout(order_id, amount):\n    billing.charge(order_id, amount)\n",
    );
    const chain = await ask(ws, "Who calls Billing.charge?");
    const gaps = allGaps(chain);
    expect(gaps).not.toMatch(/callers:Billing \(/);
    const bodies = allBodies(chain);
    expect(bodies).toMatch(/billing\.charge\(order_id, amount\)/);
  });
});

describe("P0-2 — an unqualified name declared in SEVERAL classes: empty only if EVERY candidate has zero call sites", () => {
  it("the alphabetically-earlier class's zero-caller 'flush' never masks the other class's real caller", async () => {
    const ws = makeWorkspace("p02-two");
    writeFile(ws, "package.json", '{ "name": "p02two", "private": true, "type": "module" }\n');
    // Sorts BEFORE zwriter.ts in a plain walk, and its OWN flush() has no callers.
    writeFile(
      ws,
      "src/awriter.ts",
      "export class AlphaWriter {\n  flush(): void {\n    console.log(\"alpha flush, never called\");\n  }\n}\n",
    );
    writeFile(
      ws,
      "src/zwriter.ts",
      "export class ZetaWriter {\n  constructor(private readonly buf: string[]) {}\n\n  flush(): void {\n    console.log(this.buf.join(\"\"));\n  }\n}\n\nexport const writer = new ZetaWriter([]);\n",
    );
    writeFile(
      ws,
      "src/api/save.ts",
      "import { writer } from \"../zwriter\";\n\nexport function save(): void {\n  writer.flush();\n}\n",
    );
    const chain = await ask(ws, "Who calls flush?");
    const gaps = allGaps(chain);
    expect(gaps).not.toMatch(/callers:flush \(0 call sites/);
    const bodies = allBodies(chain);
    expect(bodies).toMatch(/writer\.flush\(\)/);
  });
});

describe("P0-3 — case/underscore identity is a FALLBACK only when no exact declaration exists", () => {
  it("a same-named-modulo-case wrapper never masks the real function's own callers", async () => {
    const ws = makeWorkspace("p03-wrap");
    writeFile(ws, "package.json", '{ "name": "p03wrap", "private": true, "type": "module" }\n');
    writeFile(
      ws,
      "src/normalize.ts",
      "export function normalizeInput(value: string): string {\n  return value.trim().toLowerCase();\n}\n",
    );
    // A same-named-modulo-case WRAPPER whose own body calls the real function
    // once — the ONLY call site "NormalizeInput" (exact case) has.
    writeFile(
      ws,
      "src/wrapper/NormalizeInput.ts",
      "import { normalizeInput } from \"../normalize\";\n\nexport function NormalizeInput(value: string): string {\n  return normalizeInput(value);\n}\n",
    );
    writeFile(
      ws,
      "src/api/submit.ts",
      "import { normalizeInput } from \"../normalize\";\n\nexport function submit(value: string): string {\n  return normalizeInput(value);\n}\n",
    );
    const chain = await ask(ws, "Who calls normalizeInput?");
    const gaps = allGaps(chain);
    // Never certified empty under the WRAPPER's exact name.
    expect(gaps).not.toMatch(/callers:NormalizeInput \(0 call sites/);
    const bodies = allBodies(chain);
    expect(bodies).toMatch(/normalizeInput\(value\)/);
  });
});

describe("P1-7 — a JA clause with no space before its particle still resolves the glued identifier", () => {
  it("'parseConfigの呼び出し元を教えてください。' finds parseConfig's real caller", async () => {
    const ws = makeWorkspace("p17-ja");
    writeFile(ws, "package.json", '{ "name": "p17ja", "private": true, "type": "module" }\n');
    writeFile(
      ws,
      "src/httpConfig.ts",
      "export function parseConfig(raw: string): Record<string, string> {\n  return JSON.parse(raw);\n}\n",
    );
    writeFile(
      ws,
      "src/boot.ts",
      "import { parseConfig } from \"./httpConfig\";\n\nexport function boot(raw: string): Record<string, string> {\n  return parseConfig(raw);\n}\n",
    );
    const chain = await ask(ws, "parseConfigの呼び出し元を教えてください。");
    const gaps = allGaps(chain);
    // Never the whole-clause dead end ("no callable or declaration ... could be resolved").
    expect(gaps).not.toMatch(/no callable or declaration/);
    const bodies = allBodies(chain);
    expect(bodies).toMatch(/parseConfig\(raw\)/);
  });
});

describe("P1-8 — a non-code-shaped word in an identifier slot resolves via an EXACT declaration match", () => {
  it("a lowercase Latin-with-diacritics function name is found by 'Who calls X?'", async () => {
    const ws = makeWorkspace("p18-latin");
    writeFile(ws, "package.json", '{ "name": "p18latin", "private": true, "type": "module" }\n');
    writeFile(ws, "src/wähle.ts", "export function wähle(optionen: string[]): string {\n  return optionen[0] ?? \"\";\n}\n");
    writeFile(
      ws,
      "src/menu.ts",
      "import { wähle } from \"./wähle\";\n\nexport function menu(optionen: string[]): string {\n  return wähle(optionen);\n}\n",
    );
    const chain = await ask(ws, "Who calls wähle?");
    const gaps = allGaps(chain);
    expect(gaps).not.toMatch(/no callable or declaration/);
    expect(gaps).not.toMatch(/no selected callable carries/);
    const bodies = allBodies(chain);
    expect(bodies).toMatch(/wähle\(optionen\)/);
  });

  it("a bare CJK function name is found by 'Who calls X?'", async () => {
    const ws = makeWorkspace("p18-cjk");
    writeFile(ws, "package.json", '{ "name": "p18cjk", "private": true, "type": "module" }\n');
    writeFile(ws, "src/検証.ts", "export function 検証(値: number[]): boolean {\n  return 値.length > 0;\n}\n");
    writeFile(
      ws,
      "src/report.ts",
      "import { 検証 } from \"./検証\";\n\nexport function report(値: number[]): boolean {\n  return 検証(値);\n}\n",
    );
    const chain = await ask(ws, "Who calls 検証?");
    const gaps = allGaps(chain);
    expect(gaps).not.toMatch(/no callable or declaration/);
    expect(gaps).not.toMatch(/no selected callable carries/);
    const bodies = allBodies(chain);
    expect(bodies).toMatch(/検証\(値\)/);
  });
});

describe("P2-14 — 'how X sequences A, B, and C' never claims 'sequence' names an absent member", () => {
  it("a class whose whole body already answers the question is never certified undetermined over the word 'sequences'", async () => {
    const ws = makeWorkspace("p214-seq");
    writeFile(ws, "package.json", '{ "name": "p214seq", "private": true, "type": "module" }\n');
    writeFile(
      ws,
      "src/paymentPipeline.ts",
      "export class PaymentPipeline {\n  authorize(): void {\n    console.log(\"authorize\");\n  }\n\n  capture(): void {\n    console.log(\"capture\");\n  }\n\n  settle(): void {\n    console.log(\"settle\");\n  }\n}\n",
    );
    const chain = await ask(ws, "Explain how PaymentPipeline sequences authorization, capture, and settlement.");
    const gaps = allGaps(chain);
    expect(gaps).not.toMatch(/matches no member of PaymentPipeline/);
  });
});

// =============================================================================
// Negative controls — the shared identifier-extraction changes (P1-7/P1-8)
// touch EVERY pack's request-facet parsing; these prove the ordinary path is
// unaffected.
// =============================================================================

describe("Negative controls — ordinary paths keep their existing decisions", () => {
  it("an ordinary ASCII 'Who calls X?' with a real declaration is unaffected (both configs)", async () => {
    for (const config of ["default", "vscode"] as const) {
      const ws = makeWorkspace(`neg-ascii-${config}`);
      writeFile(ws, "package.json", '{ "name": "negascii", "private": true, "type": "module" }\n');
      writeFile(ws, "src/fetchData.ts", "export function fetchData(url: string): Promise<unknown> {\n  return fetch(url).then((r) => r.json());\n}\n");
      writeFile(ws, "src/consumer.ts", "import { fetchData } from \"./fetchData\";\n\nexport function load(url: string): Promise<unknown> {\n  return fetchData(url);\n}\n");
      const chain = await ask(ws, "Who calls fetchData?", config);
      const bodies = allBodies(chain);
      expect(bodies).toMatch(/fetchData\(url\)/);
    }
  });

  it("an ALREADY-spaced JA identifier clause still resolves (the script-boundary split changes nothing when a space already separates them)", async () => {
    const ws = makeWorkspace("neg-ja-spaced");
    writeFile(ws, "package.json", '{ "name": "negjaspaced", "private": true, "type": "module" }\n');
    writeFile(ws, "src/httpConfig.ts", "export function parseConfig(raw: string): Record<string, string> {\n  return JSON.parse(raw);\n}\n");
    writeFile(ws, "src/boot.ts", "import { parseConfig } from \"./httpConfig\";\n\nexport function boot(raw: string): Record<string, string> {\n  return parseConfig(raw);\n}\n");
    const chain = await ask(ws, "parseConfig の呼び出し元を教えてください。");
    const bodies = allBodies(chain);
    expect(bodies).toMatch(/parseConfig\(raw\)/);
  });

  it("an ordinary prose word in a 'Who calls X?' shape with NO matching declaration never invents a false resolution", async () => {
    const ws = makeWorkspace("neg-prose");
    writeFile(ws, "package.json", '{ "name": "negprose", "private": true, "type": "module" }\n');
    writeFile(ws, "src/thing.ts", "export function thing(): number {\n  return 1;\n}\n");
    const chain = await ask(ws, "Who calls database?");
    // No crash, and the decision never falsely certifies "database" as an
    // identity match for the unrelated "thing" function (P1-8's own
    // exact-match-only guard: a miss must stay a miss).
    const gaps = allGaps(chain);
    expect(gaps).not.toMatch(/callers:thing/);
  });

  it("a qualified clause naming a member that does not exist inside the owner degrades gracefully (no crash, no false owner-as-focal)", async () => {
    const ws = makeWorkspace("neg-qualified-miss");
    writeFile(ws, "package.json", '{ "name": "negqualifiedmiss", "private": true, "type": "module" }\n');
    writeFile(
      ws,
      "src/widget.ts",
      "export class Widget {\n  render(): void {\n    console.log(\"render\");\n  }\n}\n\nexport const widget = new Widget();\n",
    );
    writeFile(ws, "src/use.ts", "import { widget } from \"./widget\";\n\nexport function use(): void {\n  widget.render();\n}\n");
    const chain = await ask(ws, "Who calls Widget.destroy?");
    const gaps = allGaps(chain);
    // Never silently credited to the CLASS's own construction/reference.
    expect(gaps).not.toMatch(/callers:Widget \(/);
    const decision = finalDecisionKind(chain);
    expect(decision).toBeDefined();
  });
});
