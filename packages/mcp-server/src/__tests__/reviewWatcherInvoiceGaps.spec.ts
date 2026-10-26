import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { startDevServer, type ServerHandle } from "./helpers/qualityFirstScenarios.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const dirs: string[] = [];
const servers: ServerHandle[] = [];
afterAll(async () => {
  for (const server of servers) await server.kill();
  for (const dir of dirs) await rmDirWithRetry(dir);
});
function workspace(files: Record<string, string> = {}): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-watcher-invoice-gap-")));
  dirs.push(root);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  return root;
}
async function ask(root: string, query: string, typed = false): Promise<any[]> {
  const settings = workspace({ "engines.json": JSON.stringify({
    version: 1, typedSymbols: { enabled: typed }, compoundRequests: { enabled: true },
  }) });
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
  for (let step = 0; step < 8; step += 1) {
    if (replies.some((reply) => reply.decision?.kind === "act.answer")) break;
    const calls = replies.flatMap((reply) => {
      const next = reply.decision?.next ?? reply.next ?? reply.limit?.next;
      return next === undefined ? [] : Array.isArray(next) ? next : [next];
    });
    if (calls.length === 0 && replies.every((reply) => reply.decision === undefined) && typeof qref === "string") {
      calls.push({ tool: "tl_read_file", arguments: { cwd: root, qref } });
    }
    if (calls.length === 0) break;
    replies = await Promise.all(calls.map(async (call: any) => (await server.callTool(call.tool, call.arguments)).body));
    observations.push(...replies);
    qref = replies.find((reply) => typeof reply.qref === "string")?.qref ?? qref;
  }
  return observations;
}
function decision(observations: any[]): any {
  return observations.at(-1)?.decision;
}
function source(observations: any[], suffix: string): string {
  return observations.flatMap((reply) => reply.evidence ?? reply.entries ?? [])
    .filter((row: any) => row.path?.endsWith(suffix))
    .map((row: any) => row.body ?? row.content ?? "").join("\n");
}
function complete(observations: any[]): void {
  const last = decision(observations);
  const diagnosis = JSON.stringify(observations.map((reply) => reply.decision));
  expect(last?.kind, diagnosis).toBe("act.answer");
  expect(last?.certificate?.gaps ?? [], diagnosis).toEqual([]);
}

const watcherQueries = [
  "packages/vscode-extension/src/watcher.ts の WorkspaceWatcher について、保存時のデバウンス時間と監視対象の言語を説明してください。変更は不要です。",
  "WorkspaceWatcherが保存イベントを検知してからagents-mdとskeletonを実行するまでの流れを説明してください。デバウンス時間と監視対象言語、エラー時の扱いも含めてください。変更は不要です。",
  "VS Code拡張のWorkspaceWatcherについて、保存を検知する条件、デバウンス時間、監視対象の言語、AGENTS.mdとスケルトンの更新順序、表示言語の決め方を実装に基づいて説明してください。変更は不要です。",
];
function watcherWorkspace(): string {
  const root = workspace({ "package.json": '{"name":"watcher-review","private":true}' });
  const subtree = "packages/vscode-extension/src";
  fs.cpSync(path.join(repo, subtree), path.join(root, subtree), {
    recursive: true, filter: (name) => !name.includes("__tests__"),
  });
  for (let i = 0; i < 12; i += 1) {
    const name = path.join(root, "noise", `descriptor${i}.ts`);
    fs.mkdirSync(path.dirname(name), { recursive: true });
    fs.writeFileSync(name, `export function monitor${i}() { const detect = true; const extension = "ts"; const locale = "en"; return { detect, extension, locale }; }\n`);
  }
  return root;
}

describe("WorkspaceWatcher explanation gaps", () => {
  it.each(watcherQueries)("serves actual constants and save flow without descriptor gaps: %s", async (query) => {
    const observations = await ask(watcherWorkspace(), query);
    complete(observations);
    const body = source(observations, "watcher.ts");
    expect(body).toContain("const DEBOUNCE_MS = 5000;");
    expect(body).toContain("const WATCHED_LANGUAGES = new Set([");
    expect(body).toContain('"typescript", "typescriptreact", "javascript", "javascriptreact"');
    expect(body).toContain("vscode.workspace.onDidSaveTextDocument");
    expect(body).toContain("if (!this.isTracked(doc)) return;");
    expect(body).toContain("this.scheduleRun();");
    expect(body).toContain("if (this.timer !== undefined) clearTimeout(this.timer);");
    expect(body).toContain('this.spawn(["agents-md", "write", "--for-target"])');
    expect(body).toContain('this.spawn(["skeleton", "build", "--compact"])');
    expect(body).toContain("this.bar.setError(msg);");
    if (query.includes("表示言語")) {
      const language = source(observations, "statusBar.ts");
      expect(language).toContain("export function getDisplayLanguage()");
      expect(language).toContain('vscode.env.language.toLowerCase().startsWith("ja")');
    }
  }, 60_000);
  it("retains a truly unknown additional requested subject", async () => {
    const observations = await ask(watcherWorkspace(),
      watcherQueries[1]!.replace("変更は不要です。", "quasarWatcherRoutingの実装も説明してください。変更は不要です。"));
    const last = decision(observations);
    expect(last?.kind === "act.answer" && (last?.certificate?.gaps ?? []).length === 0, JSON.stringify(last)).toBe(false);
    expect(JSON.stringify(last)).toMatch(/quasarWatcherRouting|quasar/i);
  }, 60_000);
});

const invoiceFiles = {
  "package.json": '{"name":"invoice-review","private":true,"type":"module"}',
  "src/format.ts": "export function normalizeAmount(amount: number): number { return Math.round(amount * 100); }\n",
  "src/tax.ts": "export function calculate(subtotalCents: number): number { return Math.round(subtotalCents * 0.1); }\n",
  "src/shipping.ts": 'export function calculate(country: string): number { return country === "JP" ? 500 : 1500; }\n',
  "src/invoice.ts": [
    'import { normalizeAmount as cents } from "./format.js";',
    'import * as tax from "./tax.js";',
    'import * as shipping from "./shipping.js";',
    "export function invoice(subtotal: number, country: string): number {",
    "  const subtotalCents = cents(subtotal);",
    "  return subtotalCents + tax.calculate(subtotalCents) + shipping.calculate(country);",
    "}", "",
  ].join("\n"),
};
const invoiceQueries = [
  "src/invoice.ts の invoice が合計金額を計算する流れと、呼び出している関数の定義・戻り値を説明してください。変更は不要です。",
  "Explain invoice in src/invoice.ts, including how cents, tax.calculate and shipping.calculate contribute to the returned total. Do not change files.",
];
describe("invoice alias and same-name callee explanation gaps", () => {
  it.each(invoiceQueries.flatMap((query) => [false, true].map((typed) => ({ query, typed }))))(
    "provides all four implementation bodies without false gaps, typed=$typed: $query",
    async ({ query, typed }) => {
      const observations = await ask(workspace(invoiceFiles), query, typed);
      complete(observations);
      expect(source(observations, "invoice.ts")).toContain("return subtotalCents + tax.calculate(subtotalCents) + shipping.calculate(country);");
      expect(source(observations, "format.ts")).toContain("return Math.round(amount * 100);");
      expect(source(observations, "tax.ts")).toContain("return Math.round(subtotalCents * 0.1);");
      expect(source(observations, "shipping.ts")).toContain('return country === "JP" ? 500 : 1500;');
    }, 60_000,
  );
  it("discloses same-named module calls beyond the bounded scan", async () => {
    const files: Record<string, string> = { ...invoiceFiles };
    const imports: string[] = [];
    const calls: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      imports.push(`import * as module${index} from "./module${index}.js";`);
      calls.push(`module${index}.calculate(subtotal)`);
      files[`src/module${index}.ts`] = `export function calculate(value: number): number { return value + ${index}; }\n`;
    }
    files["src/invoice.ts"] = [...imports, `export function invoice(subtotal: number): number { return ${calls.join(" + ")}; }`, ""].join("\n");
    const observations = await ask(workspace(files), invoiceQueries[0]!);
    const last = decision(observations);
    expect(last?.kind === "act.answer" && (last?.certificate?.gaps ?? []).length === 0, JSON.stringify(last)).toBe(false);
  }, 60_000);
  it("retains a missing namespace data value", async () => {
    const files = { ...invoiceFiles, "src/invoice.ts": invoiceFiles["src/invoice.ts"].replace(
      "return subtotalCents +", "return tax.MISSING_RATE + subtotalCents +") };
    const observations = await ask(workspace(files), invoiceQueries[0]!);
    const last = decision(observations);
    expect(last?.kind === "act.answer" && (last?.certificate?.gaps ?? []).length === 0, JSON.stringify(last)).toBe(false);
    expect(JSON.stringify(last)).toMatch(/MISSING_RATE|unresolved|undetermined/i);
  }, 60_000);
  it.each([false, true])("does not bind a shadowed namespace receiver to its import, typed=%s", async (typed) => {
    const files = { ...invoiceFiles, "src/invoice.ts": invoiceFiles["src/invoice.ts"].replace(
      "country: string): number", "country: string, shipping: { calculate(country: string): number }): number") };
    const observations = await ask(workspace(files), invoiceQueries[0]!, typed);
    const last = decision(observations);
    expect(last?.kind === "act.answer" && (last?.certificate?.gaps ?? []).length === 0, JSON.stringify(last)).toBe(false);
  }, 60_000);
  it.each([false, true])("does not conceal a missing callee implementation after a complex member call: %s", async (complexFirst) => {
    let invoice = invoiceFiles["src/invoice.ts"].replace("cents(subtotal)", "missingAdjuster(subtotal)");
    if (complexFirst) invoice = invoice.replace("  const subtotalCents", '  (country || "JP").missingAdjuster();\n  const subtotalCents');
    const files = { ...invoiceFiles, "src/invoice.ts": invoice };
    const observations = await ask(workspace(files), invoiceQueries[0]!);
    const last = decision(observations);
    expect(last?.kind === "act.answer" && (last?.certificate?.gaps ?? []).length === 0, JSON.stringify(last)).toBe(false);
    expect(JSON.stringify(last)).toMatch(/missingAdjuster|unresolved|undetermined|unknown|callee/i);
  }, 60_000);
});
