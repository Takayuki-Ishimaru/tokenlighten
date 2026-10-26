import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { explicitEditConstraintPaths } from "../state/explicitEditConstraints.js";
import { clearTaskQueryRef, guardExecutionEdit, rememberTaskQuery, resetWorkspace } from "../state/session.js";
import { extractFacetRequirements } from "../features/task-pack/requestFacets.js";
import { extractCompoundFacetRequirements, planCompoundRequest } from "../features/task-pack/compoundRequests.js";
import { extractRequestItems, salientWords } from "../features/task-pack/requestItems.js";
import { startDevServer, type ServerHandle } from "./helpers/qualityFirstScenarios.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";

const ORIGINAL = 'Change processOrder in src/worker.ts to return "ready" instead of "pending". Do not modify src/config.ts; read src/config.ts only for context.';
const EN_QUERY = "Explain how getTokenLightenConfiguration selects the active workspace folder and how getTokenLightenConfigurationTarget chooses its configuration target in packages/vscode-extension/src/statusBar.ts. Give the conditions and callers. Do not change files.";
const JA_QUERY = "TokenLightenのローカル解析エンジンについて、typedSymbols・compoundRequests・semanticSearchの既定の有効/無効、設定ファイルの保存先、設定JSONが壊れている場合の動作を、実装に基づいて説明してください。変更は不要です。";
const WS = "/virtual/review-constraints";

describe("TL-REVIEW-02 explicit path prohibitions", () => {
  beforeEach(() => resetWorkspace(WS));
  it.each([
    [ORIGINAL, ["src/config.ts"]],
    ["Do not modify src/a.ts and src/b.ts; edit src/c.ts.", ["src/a.ts", "src/b.ts"]],
    ["src/config.ts は変更しないでください。src/worker.ts を更新してください。", ["src/config.ts"]],
    ["Explain src/config.ts and change src/worker.ts.", []],
    ["Read src/config.ts only for context.", []],
    ["Do not modify src/config; read src/worker only for context.", ["src/config"]],
    ["Do not modify src/config.ts and edit src/worker.ts.", ["src/config.ts"]],
    ["Create notes with this content: ```Do not modify src/config.ts```", []],
    ['Explain the message "Do not modify src/config.ts" in src/message.ts.', []],
    ['Do not modify "src/config.ts".', ["src/config.ts"]],
  ])("extracts only prohibited paths from %s", (query, paths) => {
    expect(explicitEditConstraintPaths(query as string)).toEqual(paths);
  });
  it("refuses path, handle, new-epoch edits and mixed batches before any guard mutation", () => {
    rememberTaskQuery(WS, ORIGINAL);
    rememberTaskQuery(WS, "Explain processOrder");
    for (const args of [
      { path: "./src/config.ts", search: "5", replace: "99" },
      { edits: [{ handle: "h-config", search: "5", replace: "99" }] },
      { path: "src/config.ts", content: "bad", taskEpoch: "new" },
      { edits: [{ path: "src/worker.ts", search: "pending", replace: "ready" }, { path: WS + "/src/config.ts", content: "bad" }] },
    ]) {
      const decision = guardExecutionEdit(WS, args, () => "src/config.ts");
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.refusal.reason).toBe("frontier-read-only");
        const next = decision.refusal.next_call as { arguments: { query: string } };
        expect(next.arguments.query).toContain(ORIGINAL);
        expect(next.arguments.query).not.toBe("edit src/config.ts");
      }
    }
    expect(guardExecutionEdit(WS, { path: "src/worker.ts", search: "pending", replace: "ready" }).allowed).toBe(true);
  });
  it("a declared new task can replace a constraint, while regeneration of the original retains it", () => {
    rememberTaskQuery(WS, ORIGINAL);
    clearTaskQueryRef(WS);
    rememberTaskQuery(WS, ORIGINAL);
    expect(guardExecutionEdit(WS, { path: "src/config.ts", search: "5", replace: "99" }).allowed).toBe(false);
    clearTaskQueryRef(WS);
    rememberTaskQuery(WS, "Change LIMIT in src/config.ts to 99.");
    expect(guardExecutionEdit(WS, { path: "src/config.ts", search: "5", replace: "99" }).allowed).toBe(true);
  });
});

describe("TL-REVIEW-03 explanation wording", () => {
  it("binds the follow-up conditions/callers to both named functions without searching Give", () => {
    const requirements = [...extractFacetRequirements(EN_QUERY), ...extractCompoundFacetRequirements(EN_QUERY)];
    expect(requirements.map((r) => r.facet)).toEqual(["condition", "callers", "condition", "callers"]);
    for (const requirement of requirements) {
      expect(requirement.subjectIdentifiers).toEqual(["getTokenLightenConfiguration", "getTokenLightenConfigurationTarget"]);
      expect(requirement.subjectWeakCandidates).not.toContain("Give");
      expect(requirement.subjectTerms).not.toContain("give");
    }
  });
  it.each(["実装に基づいて説明してください。", "ソースコードに基づいて詳しく教えてください。", "コードに基づき説明してください。"])("does not search a request's evidentiary manner: %s", (ending) => {
    expect(salientWords(ending)).toEqual([]);
    expect(extractRequestItems("typedSymbolsの既定値、" + ending).flatMap((item) => salientWords(item.text))).not.toEqual(expect.arrayContaining(["基づいて説明"]));
  });
  it("keeps real content, quoted wording and named identifiers", () => {
    const words = extractRequestItems(JA_QUERY).flatMap((item) => salientWords(item.text));
    expect(words.join(" ")).not.toMatch(/基づ|説明|ください|不要/);
    expect(words).toEqual(expect.arrayContaining(["typedSymbols", "compoundRequests", "semanticSearch"]));
    expect(planCompoundRequest(JA_QUERY).clauses.map((clause) => clause.text).join(" ")).not.toMatch(/基づ|不要/);
    expect(salientWords("「実装に基づいて説明してください」という文字列を探して")).toContain("実装に基づいて説明してください");
    expect(salientWords("基づいて説明する関数を探して").join(" ")).toContain("基づいて説明");
  });
});

const dirs: string[] = [];
const servers: ServerHandle[] = [];
afterAll(async () => {
  for (const server of servers) await server.kill();
  for (const dir of dirs) await rmDirWithRetry(dir);
});
function workspace(files: Record<string, string>): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-review-")));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

describe("TL-REVIEW-02 real MCP recovery", () => {
  it.each(["0", "1"])("keeps the prohibition through a verbatim recovery, strict=%s", async (strict) => {
    const files = { "src/worker.ts": 'export function processOrder() { return "pending"; }\n', "src/config.ts": "export const LIMIT = 5;\n" };
    const ws = workspace(files);
    const server = startDevServer(ws, "default", { allowWrite: true, extraEnv: { TL_FRONTIER_STRICT_WRITES: strict } });
    servers.push(server);
    await server.initialize();
    await server.callTool("tl_read_file", { cwd: ws, query: ORIGINAL, task: { epoch: "new", profile: "generic" } });
    const args = { cwd: ws, edits: [
      { path: "src/worker.ts", search: '"pending"', replace: '"ready"', precondition: "unique-match" },
      { path: "src/config.ts", search: "LIMIT = 5", replace: "LIMIT = 99", precondition: "unique-match" },
    ] };
    const refused = (await server.callTool("tl_edit_file", args)).body as any;
    expect(refused.kind, JSON.stringify(refused)).toBe("refusal");
    expect(refused.code).toBe("frontier-read-only");
    for (const [name, content] of Object.entries(files)) expect(fs.readFileSync(path.join(ws, name), "utf8")).toBe(content);
    expect(refused.next.arguments.query).toContain(ORIGINAL);
    await server.callTool(refused.next.tool, refused.next.arguments);
    const again = (await server.callTool("tl_edit_file", args)).body as any;
    expect(again.kind, JSON.stringify(again)).toBe("refusal");
    for (const [name, content] of Object.entries(files)) expect(fs.readFileSync(path.join(ws, name), "utf8")).toBe(content);
  }, 30_000);
});

describe("TL-REVIEW-03 reported questions against the real repository", () => {
  it.each([EN_QUERY, JA_QUERY].flatMap((query) => [false, true].map((compound) => ({ query, compound }))))("does not create exploration gaps, compound=$compound: $query", async ({ query, compound }) => {
    const repo = fileURLToPath(new URL("../../../../", import.meta.url));
    const root = workspace({});
    const subtree = query === EN_QUERY ? "packages/vscode-extension/src" : "packages/mcp-server/src/features/engines";
    fs.cpSync(path.join(repo, subtree), path.join(root, subtree), {
      recursive: true, filter: (name) => !name.includes("__tests__"),
    });
    const engineHome = workspace({ "engines.json": JSON.stringify({ version: 1, compoundRequests: { enabled: compound } }) });
    const server = startDevServer(root, "vscode", { extraEnv: { TOKENLIGHTEN_ENGINES_FILE: path.join(engineHome, "engines.json") } });
    servers.push(server);
    await server.initialize();
    let response = (await server.callTool("tl_read_file", { cwd: root, query, task: { epoch: "new", profile: "answer" } })).body as any;
    const observations = [response];
    for (let step = 0; step < 6 && response.decision?.kind === "discover"; step += 1) {
      const next = response.decision.next;
      expect(next, JSON.stringify(response.decision)).toBeDefined();
      response = (await server.callTool(next.tool, next.arguments)).body as any;
      observations.push(response);
    }
    const diagnosis = JSON.stringify(observations.map((body) => body.decision));
    expect(diagnosis).not.toMatch(/candidate files for Give|基づいて説明|request-item[^"]*Give/);
    expect(response.decision?.kind, diagnosis).toBe("act.answer");
    const bodies = JSON.stringify(observations.flatMap((body) => body.evidence ?? []));
    if (query === EN_QUERY) {
      expect(bodies).toContain("getTokenLightenConfiguration");
      expect(bodies).toContain("getTokenLightenConfigurationTarget");
    } else {
      expect(bodies).toContain("typedSymbols");
      expect(bodies).toContain("compoundRequests");
      expect(bodies).toContain("semanticSearch");
      expect(bodies).toContain("engines.json");
    }
  }, 60_000);
});
