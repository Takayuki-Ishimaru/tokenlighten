/**
 * evaluation0929.descriptiveWords.spec.ts — WP-C (eval-0929 §6/§8): a
 * descriptive/facet word (conditions/callers/codes/statuses/flow/...) that
 * merely names WHICH KIND of information a clause asks for must never be
 * certified `request-item-absent`, whatever the query's SURFACE shape —
 * TS or Python identifier spelling, one sentence or a bullet list, English
 * or Japanese. Metamorphic matrix per the common brief's rule 12 / eval-0929
 * §8 table row 3 ("文・箇条書き、日本語・英語を切り替える | 満たした意味上の要求を
 * リテラル不在にしない"). Two controls at the end confirm a GENUINE literal
 * absence (a quoted identifier, and an explicit "is X defined" check) still
 * certifies absent — this fix narrows WHAT can be disclosed absent, it does
 * not turn the mechanism off.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import {
  startDevServer,
  followNextToEnd,
  anyEvidenceContains,
  collectDisclosureTexts,
  type ServerHandle,
} from "./helpers/qualityFirstScenarios.js";

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

function workspace(files: Record<string, string>): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, ".tl-e0929-descwords-"));
  tmpDirs.push(ws);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), content, "utf8");
  }
  return ws;
}

async function ask(ws: string, query: string) {
  const s = startDevServer(ws, "default");
  servers.push(s);
  await s.initialize();
  const chain = await followNextToEnd(s, { tool: "tl_read_file", arguments: { query, cwd: ws, task: { epoch: "new", profile: "answer" } } }, { cwd: ws, hopCap: 12 });
  const disclosures = collectDisclosureTexts(chain);
  return { chain, disclosures };
}

/** No descriptive/facet word — the vocabulary this fix excludes — ever
 *  appears as the disclosed TERM of a `request-item-absent`, in EITHER wire
 *  shape: the `act.answer` certificate's colon-joined string
 *  (`request-item-absent:conditions (...)`) or a `discover`/`await_input`
 *  gap's space-joined `refs` (`request-item-absent ri-3 conditions`, as
 *  `collectDisclosureTexts` stringifies it) — checked per-disclosure so an
 *  unrelated word elsewhere in the SAME joined report string can never mask
 *  (or fake) a match the way one shared regex with a tight adjacency
 *  requirement could. */
const FORBIDDEN_DESCRIPTIVE_WORD_RE = /\b(?:conditions?|callers?|codes|statuses|values?|flow)\b|条件|呼び出し元|既定値|ステータスコード/iu;
function forbiddenDescriptiveAbsence(disclosures: readonly string[]): string | undefined {
  return disclosures.find((d) => d.includes("request-item-absent") && FORBIDDEN_DESCRIPTIVE_WORD_RE.test(d));
}

// ---------------------------------------------------------------------------
// TS fixture (camelCase) — mirrors the eval's own TS-vs-Python pairing.
// ---------------------------------------------------------------------------
function tsFiles(): Record<string, string> {
  return {
    "src/service.ts": [
      "export const DEFAULT_TIMEOUT_MS = 7231;",
      "export const RETRYABLE_CODES = new Set([408, 425, 507]);",
      "export function getTimeout(): number { return DEFAULT_TIMEOUT_MS; }",
      "export function shouldRetry(code: number, attempt: number): boolean { return RETRYABLE_CODES.has(code) && attempt < 4; }",
      "export function sendRequest(code: number): boolean { return shouldRetry(code, 0); }",
      "",
    ].join("\n"),
    "src/handler.ts": [
      "import { sendRequest } from \"./service.js\";",
      "export function handleJob(): boolean { return sendRequest(503); }",
      "",
    ].join("\n"),
  };
}

// ---------------------------------------------------------------------------
// Python fixture (snake_case) — the eval-0929 §6 exact reproduction shape.
// ---------------------------------------------------------------------------
function pyFiles(): Record<string, string> {
  return {
    "service.py": [
      "DEFAULT_TIMEOUT_MS = 7231",
      "RETRYABLE_CODES = {408, 425, 507}",
      "",
      "def get_timeout():",
      "    return DEFAULT_TIMEOUT_MS",
      "",
      "def should_retry(code, attempt):",
      "    return code in RETRYABLE_CODES and attempt < 4",
      "",
      "def send_request(code):",
      "    return should_retry(code, 0)",
      "",
    ].join("\n"),
    "handler.py": [
      "from service import send_request",
      "",
      "def handle_job():",
      "    return send_request(503)",
      "",
    ].join("\n"),
  };
}

interface Case {
  readonly name: string;
  readonly files: () => Record<string, string>;
  readonly query: string;
  readonly caller: string;
}

const CASES: readonly Case[] = [
  { name: "TS sentence EN", files: tsFiles, caller: "sendRequest(503)", query: "Explain the default value returned by getTimeout, the conditions of shouldRetry, and the callers of sendRequest." },
  { name: "TS bullets EN", files: tsFiles, caller: "sendRequest(503)", query: "Explain the retry service:\n- Default value returned by getTimeout\n- Conditions checked by shouldRetry\n- Callers of sendRequest" },
  { name: "TS sentence JA", files: tsFiles, caller: "sendRequest(503)", query: "getTimeout の既定値、shouldRetry の条件、sendRequest の呼び出し元を説明してください。" },
  { name: "TS bullets JA", files: tsFiles, caller: "sendRequest(503)", query: "リトライサービスについて説明してください。\n・getTimeout が返す既定値\n・shouldRetry の条件\n・sendRequest の呼び出し元" },
  { name: "Python sentence EN (eval-0929 §6 exact repro)", files: pyFiles, caller: "send_request(503)", query: "Explain the default value returned by get_timeout, the conditions of should_retry, and the callers of send_request." },
  { name: "Python bullets EN", files: pyFiles, caller: "send_request(503)", query: "Explain the retry service:\n- Default value returned by get_timeout\n- Conditions checked by should_retry\n- Callers of send_request" },
  { name: "Python sentence JA", files: pyFiles, caller: "send_request(503)", query: "get_timeout の既定値、should_retry の条件、send_request の呼び出し元を説明してください。" },
  { name: "Python bullets JA", files: pyFiles, caller: "send_request(503)", query: "リトライサービスについて説明してください。\n・get_timeout が返す既定値\n・should_retry の条件\n・send_request の呼び出し元" },
];

describe("descriptive/facet words never become a literal absence (eval-0929 §6/§8)", () => {
  for (const c of CASES) {
    it(`${c.name}: no descriptive-word absence, values and caller served`, async () => {
      const ws = workspace(c.files());
      const { chain, disclosures } = await ask(ws, c.query);
      const bad = forbiddenDescriptiveAbsence(disclosures);
      expect(bad, `forbidden descriptive-word absence among: ${JSON.stringify(disclosures)}`).toBeUndefined();
      expect(anyEvidenceContains(chain, ["7231"]), "default value 7231 never served").toBe(true);
      expect(anyEvidenceContains(chain, ["408", "425", "507"]), "retryable codes never served").toBe(true);
      expect(anyEvidenceContains(chain, [c.caller]), `caller line (${c.caller}) never served`).toBe(true);
    }, 30_000);
  }

  // ---------------------------------------------------------------------------
  // Recall controls (common brief rule 10) — a GENUINE literal absence must
  // still be certified: the fix narrows WHAT can be disclosed absent, never
  // turns the mechanism off.
  // ---------------------------------------------------------------------------

  it("control: a quoted, genuinely absent identifier is still certified absent", async () => {
    const ws = workspace(tsFiles());
    const { disclosures } = await ask(
      ws,
      "Explain the default value returned by getTimeout, and whether the identifier `NO_SUCH_TOKEN_4471` exists.",
    );
    const absentDisclosure = disclosures.find((d) => d.includes("request-item-absent") && d.includes("NO_SUCH_TOKEN_4471"));
    expect(absentDisclosure, `no request-item-absent naming NO_SUCH_TOKEN_4471 among: ${JSON.stringify(disclosures)}`).toBeDefined();
  }, 30_000);

  it('control: an explicit "is X defined" existence check is still certified absent', async () => {
    const ws = workspace(pyFiles());
    const { disclosures } = await ask(
      ws,
      "Explain the default value returned by get_timeout, and whether the exact identifier NO_SUCH_TOKEN_4471 is defined.",
    );
    const absentDisclosure = disclosures.find((d) => d.includes("request-item-absent") && d.includes("NO_SUCH_TOKEN_4471"));
    expect(absentDisclosure, `no request-item-absent naming NO_SUCH_TOKEN_4471 among: ${JSON.stringify(disclosures)}`).toBeDefined();
  }, 30_000);
});
