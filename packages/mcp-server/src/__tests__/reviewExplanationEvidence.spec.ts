import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { startDevServer, type ServerHandle } from "./helpers/qualityFirstScenarios.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";

const queries = [
  "Explain how getTokenLightenConfiguration selects the active workspace folder and how getTokenLightenConfigurationTarget chooses its configuration target in packages/vscode-extension/src/statusBar.ts. Give the conditions and callers. Do not change files.",
  "Explain getTokenLightenConfiguration and getTokenLightenConfigurationTarget in packages/vscode-extension/src/statusBar.ts. Include their conditions and call sites. Do not edit any files.",
  "TokenLightenのローカル解析エンジンについて、typedSymbols・compoundRequests・semanticSearchの既定の有効/無効、設定ファイルの保存先、設定JSONが壊れている場合の動作を、実装に基づいて説明してください。変更は不要です。",
  "typedSymbols、compoundRequests、semanticSearchの初期設定と設定ファイルのパスを調べ、設定ファイルが不正なJSONの場合にどうなるか説明してください。コードの変更はしないでください。",
];
const dirs: string[] = [];
const servers: ServerHandle[] = [];
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
afterAll(async () => {
  for (const server of servers) await server.kill();
  for (const dir of dirs) await rmDirWithRetry(dir);
});
function temporary(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-explanation-evidence-")));
  dirs.push(dir);
  return dir;
}
function write(root: string, name: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  fs.writeFileSync(path.join(root, name), text);
}
function fixture(): string {
  const root = temporary();
  for (const subtree of ["packages/vscode-extension/src", "packages/mcp-server/src/features/engines"]) {
    fs.cpSync(path.join(repo, subtree), path.join(root, subtree), {
      recursive: true, filter: (name) => !name.includes("__tests__"),
    });
  }
  write(root, "package.json", JSON.stringify({ name: "evidence-workspace", version: "1.0.0", private: true }));
  for (let i = 0; i < 12; i += 1) {
    write(root, `noise/descriptor${i}.ts`, `export function unrelated${i}() {
  const conditions = true;
  const callers: string[] = [];
  const sites = callers;
  return { conditions, callers, sites };
}
`);
  }
  write(root, "test/questions.spec.ts", "export const questions = " + JSON.stringify(queries) + ";\n");
  return root;
}
async function explain(root: string, query: string, compound: boolean): Promise<any[]> {
  const settings = temporary();
  write(settings, "engines.json", JSON.stringify({ version: 1, compoundRequests: { enabled: compound } }));
  const server = startDevServer(root, "vscode", {
    extraEnv: { TOKENLIGHTEN_ENGINES_FILE: path.join(settings, "engines.json") },
  });
  servers.push(server);
  await server.initialize();
  let replies = [(await server.callTool("tl_read_file", {
    cwd: root, query, task: { epoch: "new", profile: "answer" },
  })).body as any];
  const observations = [...replies];
  let qref = replies[0]?.qref;
  for (let hop = 0; hop < 6; hop += 1) {
    if (replies.some((body) => body.decision?.kind === "act.answer")) break;
    const next = replies.flatMap((body) => {
      const call = body.decision?.next ?? body.next ?? body.limit?.next;
      return call === undefined ? [] : Array.isArray(call) ? call : [call];
    });
    // A references reply has no decision: resume the original task after the
    // returned search has completed, without changing that returned call.
    if (next.length === 0 && replies.every((body) => body.decision === undefined) && typeof qref === "string") {
      next.push({ tool: "tl_read_file", arguments: { cwd: root, qref } });
    }
    if (next.length === 0) break;
    replies = await Promise.all(next.map(async (call: any) => (await server.callTool(call.tool, call.arguments)).body));
    qref = replies.find((body) => typeof body.qref === "string")?.qref ?? qref;
    observations.push(...replies);
  }
  return observations;
}
function evidenceText(observations: any[], suffix: string): string {
  return observations.flatMap((body) => body.evidence ?? body.entries ?? [])
    .filter((row: any) => typeof row.path === "string" && row.path.endsWith(suffix))
    .map((row: any) => row.body ?? row.content ?? "").join("\n");
}
function assertComplete(observations: any[]): void {
  const final = observations.at(-1);
  const diagnosis = JSON.stringify(observations.map((body) => body.decision));
  expect(final.decision?.kind, diagnosis).toBe("act.answer");
  expect(final.decision?.certificate?.gaps ?? [], diagnosis).toEqual([]);
}
function assertEnglishBodies(observations: any[]): void {
  const body = evidenceText(observations, "packages/vscode-extension/src/statusBar.ts");
  expect(body).toContain("const resource = vscode.workspace.workspaceFolders?.[0]?.uri;");
  expect(body).toContain('return vscode.workspace.getConfiguration("tokenlighten", resource);');
  expect(body).toContain("return vscode.workspace.workspaceFolders?.length");
  expect(body).toContain("? vscode.ConfigurationTarget.WorkspaceFolder");
  expect(body).toContain(": vscode.ConfigurationTarget.Workspace;");
  const callerRows = observations.flatMap((reply) => reply.evidence ?? []);
  for (const name of ["commands.ts", "sidebar.ts"]) {
    const callers = callerRows.filter((row: any) => row.path?.endsWith(name))
      .map((row: any) => row.body ?? "").join("\n");
    expect(callers, name).toMatch(/getTokenLightenConfiguration(?:Target)?\(/);
  }
}
function assertConfigurationBodies(observations: any[]): void {
  const body = evidenceText(observations, "packages/mcp-server/src/features/engines/config.ts");
  expect(body).toContain('return process.env.TOKENLIGHTEN_ENGINES_FILE || join(homedir(), ".tokenlighten", "engines.json");');
  expect(body).toContain("typedSymbols: { enabled: false, discoverServers: false, servers: {} }");
  expect(body).toContain("compoundRequests: { enabled: true }");
  expect(body).toContain('semanticSearch: { enabled: false, cacheDir: join(homedir(), ".tokenlighten", "models") }');
  expect(body).toContain("try { return readEngineConfigurationStrict(file); }");
  expect(body).toContain("catch {");
  expect(body).toContain("return { ...defaults, typedSymbols: { ...defaults.typedSymbols, enabled: false }, compoundRequests: { enabled: false } };");
  expect(body).toContain('JSON.parse(raw.toString("utf8"))');
}

describe("reported explanations with root manifest, descriptor noise and question echoes", () => {
  it.each(queries.flatMap((query, index) => [false, true].map((compound) => ({ query, index, compound }))))(
    "has actual answer evidence and no spurious gaps, question=$index compound=$compound",
    async ({ query, index, compound }) => {
      const observations = await explain(fixture(), query, compound);
      assertComplete(observations);
      if (index < 2) assertEnglishBodies(observations);
      else assertConfigurationBodies(observations);
    }, 60_000,
  );
  it("keeps an unrelated additional requested topic disclosed", async () => {
    const observations = await explain(fixture(),
      queries[0]!.replace("Give the conditions and callers.", "Give the conditions and callers and the quasarDeploymentScripts."), true);
    const final = observations.at(-1);
    const disclosures = JSON.stringify(final.decision);
    expect(final.decision?.kind === "act.answer" && (final.decision?.certificate?.gaps ?? []).length === 0, disclosures).toBe(false);
    expect(disclosures).toMatch(/quasarDeploymentScripts|quasar|deployment/i);
  }, 60_000);
});
