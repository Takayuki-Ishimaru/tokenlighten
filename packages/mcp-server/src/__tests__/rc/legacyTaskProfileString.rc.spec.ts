/**
 * legacyTaskProfileString.rc.spec.ts — a `task` sent as a JSON string that
 * carries the legacy `taskProfile` meets what the same task sent as an object
 * meets (v016 decision 6t-4, 2026-10-19).
 *
 * Recorded (arm A, T07 rep0 and T13 reps 1 and 2): the first tl_read_file
 * sent `task` as the string `{"epoch":"new","taskProfile":"generic"}` (T13:
 * `"wiring"`). The FX-2 rescue parses a stringified carrier only when every
 * member is advertised, so it kept the string, and the call was refused
 * `invalid-input`, field `task`, "task must be an object", with no `next`;
 * each cell re-sent the task as an object. Sent as an object, the same task
 * was served: TL_EFF_TOLERANT_INPUT (default ON) renames `task.taskProfile`
 * to `task.profile`.
 *
 * The rescue now parses a string whose only unknown member is the legacy
 * `taskProfile`, so it is renamed where a policy accepts it
 * (TL_EFF_TOLERANT_INPUT on every tool, TL_LEGACY_INPUT=accept on the read
 * tools) and otherwise refused `legacy-input`, field `task.taskProfile`, with
 * `next` = the same call with `task` as an object and `profile` in its place.
 * Servers here run with TL_LEGACY_INPUT unset (refuse), as in production and
 * the decision bench, unless a case sets it.
 *
 * The replay corpus group `v016ts` holds the recorded calls.
 */

import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "../helpers/shortTmpDir.js";
import { rmDirWithRetry } from "../helpers/rmDirWithRetry.js";
import { startDevServer, type ServerHandle, type ToolCallShape } from "../helpers/qualityFirstScenarios.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();

type Body = Record<string, unknown>;

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

/** T07 rep0's first call, verbatim but for cwd. */
const T07_QUERY = "[実業務 集計バグ報告] ledgerd で liability/equity/revenue 系のアカウント残高が逆符号で出ちゃう (credit が増えてるのに Net がマイナス)。\nledgerd の balance 計算 (Compute) まわりで credit-normal を考慮してないっぽい。\n修正して、影響の出る型一覧も列挙して。";
const T07_TASK = "{\"epoch\":\"new\",\"taskProfile\":\"generic\"}";
/** T13 reps 1 and 2 sent the same string with `wiring`. */
const T13_TASK = "{\"epoch\":\"new\",\"taskProfile\":\"wiring\"}";

function ledgerWorkspace(tag: string): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-ltp-${tag}-`));
  tmpDirs.push(ws);
  const write = (rel: string, content: string): void => {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), content);
  };
  write("ledgerd/pkg/account/account.go", [
    "package account",
    "",
    "// Kind is the account class; liability, equity and revenue are credit-normal.",
    "type Kind int",
    "",
    "const (",
    "\tAsset Kind = iota",
    "\tLiability",
    "\tEquity",
    "\tRevenue",
    "\tExpense",
    ")",
    "",
    "type Account struct {",
    "\tID   string",
    "\tKind Kind",
    "}",
    "",
  ].join("\n"));
  write("ledgerd/pkg/balance/compute.go", [
    "package balance",
    "",
    "import \"github.com/ledgerd/ledger/pkg/account\"",
    "",
    "type Balance struct {",
    "\tDebit  int64",
    "\tCredit int64",
    "\tNet    int64",
    "}",
    "",
    "// Compute totals the postings of acct; Net is Debit minus Credit.",
    "func Compute(acct account.Account, debits, credits []int64) Balance {",
    "\tvar b Balance",
    "\tfor _, d := range debits {",
    "\t\tb.Debit += d",
    "\t}",
    "\tfor _, c := range credits {",
    "\t\tb.Credit += c",
    "\t}",
    "\tb.Net = b.Debit - b.Credit",
    "\treturn b",
    "}",
    "",
  ].join("\n"));
  return ws;
}

async function serverFor(ws: string, extraEnv: Record<string, string> = {}): Promise<ServerHandle> {
  const server = startDevServer(ws, "default", { allowWrite: true, extraEnv });
  servers.push(server);
  await server.initialize();
  return server;
}

async function call(server: ServerHandle, tool: string, args: Body): Promise<Body> {
  return (await server.callTool(tool, args)).body as Body;
}

/** The refusal names `task.taskProfile` and carries an executable `next`. */
function legacyRefusalNext(refusal: Body, tool: string): ToolCallShape {
  expect(refusal["kind"], JSON.stringify(refusal).slice(0, 600)).toBe("refusal");
  expect(refusal["code"]).toBe("legacy-input");
  expect(refusal["field"]).toBe("task.taskProfile");
  expect(refusal["retry"]).toBe("call");
  const prose = String(refusal["detail"] ?? "");
  expect(prose).toContain("legacy input");
  // `field` names the member; the prose does not spell it again (models copy
  // server text into their next call; rc/noLegacySpellingOnWire.rc.spec.ts).
  expect(prose).not.toMatch(/\btaskProfile\b/);
  const next = refusal["next"] as ToolCallShape | undefined;
  expect(next, `the refusal must name an executable next: ${JSON.stringify(refusal).slice(0, 600)}`).toBeDefined();
  expect(next!.tool).toBe(tool);
  return next!;
}

const taskIdOf = (body: Body): string => {
  const id = (body["task"] as Body | undefined)?.["id"];
  expect(typeof id, JSON.stringify(body).slice(0, 400)).toBe("string");
  return id as string;
};

describe("a stringified task carrying the legacy taskProfile", () => {
  it("the recorded first call is served like the same task sent as an object (TL_EFF_TOLERANT_INPUT default ON)", async () => {
    const ws = ledgerWorkspace("default");
    const server = await serverFor(ws);
    const asString = await call(server, "tl_read_file", { query: T07_QUERY, task: T07_TASK, cwd: ws });
    expect(asString["kind"], JSON.stringify(asString).slice(0, 600)).toBe("read.task_pack");
    expect(asString["profile"]).toBe("generic");
    const asObject = await call(server, "tl_read_file", { query: T07_QUERY, task: JSON.parse(T07_TASK), cwd: ws });
    expect(asObject["kind"], JSON.stringify(asObject).slice(0, 600)).toBe("read.task_pack");
    expect(asObject["profile"]).toBe(asString["profile"]);
    expect((asObject["decision"] as Body | undefined)?.["kind"]).toBe((asString["decision"] as Body | undefined)?.["kind"]);
  }, 120_000);

  it.each([
    ["the recorded string", T07_TASK],
    ["the same task as an object", JSON.parse(T07_TASK) as Body],
  ])("with TL_EFF_TOLERANT_INPUT=0, %s is refused by name and its next — profile in place of taskProfile — is served", async (_label, task) => {
    const ws = ledgerWorkspace("eff-off");
    const server = await serverFor(ws, { TL_EFF_TOLERANT_INPUT: "0" });
    const refusal = await call(server, "tl_read_file", { query: T07_QUERY, task, cwd: ws });
    const next = legacyRefusalNext(refusal, "tl_read_file");
    expect(String(refusal["detail"])).toContain("task.profile in its place");
    expect(next.arguments).toEqual({ cwd: ws, task: { epoch: "new", profile: "generic" }, query: T07_QUERY });
    const pack = await call(server, next.tool, next.arguments);
    expect(pack["kind"], JSON.stringify(pack).slice(0, 600)).toBe("read.task_pack");
    expect(pack["profile"]).toBe("generic");
  }, 120_000);

  it("T13's wiring value rides next unchanged", async () => {
    const ws = ledgerWorkspace("wiring");
    const server = await serverFor(ws, { TL_EFF_TOLERANT_INPUT: "0" });
    const refusal = await call(server, "tl_read_file", { query: T07_QUERY, task: T13_TASK, cwd: ws });
    const next = legacyRefusalNext(refusal, "tl_read_file");
    expect(next.arguments["task"]).toEqual({ epoch: "new", profile: "wiring" });
    expect(next.arguments["query"]).toBe(T07_QUERY);
  }, 120_000);

  it.each([
    ["the recorded string", T07_TASK],
    ["the same task as an object", JSON.parse(T07_TASK) as Body],
  ])("TL_LEGACY_INPUT=accept takes %s on the read tools even with TL_EFF_TOLERANT_INPUT=0", async (_label, task) => {
    const ws = ledgerWorkspace("accept");
    const server = await serverFor(ws, { TL_EFF_TOLERANT_INPUT: "0", TL_LEGACY_INPUT: "accept" });
    const pack = await call(server, "tl_read_file", { query: T07_QUERY, task, cwd: ws });
    expect(pack["kind"], JSON.stringify(pack).slice(0, 600)).toBe("read.task_pack");
    expect(pack["profile"]).toBe("generic");
  }, 120_000);

  it("beside task.profile, the legacy member is refused and next keeps the caller's profile alone", async () => {
    const ws = ledgerWorkspace("both");
    const server = await serverFor(ws);
    const refusal = await call(server, "tl_read_file", {
      query: T07_QUERY,
      task: "{\"epoch\":\"new\",\"profile\":\"answer\",\"taskProfile\":\"generic\"}",
      cwd: ws,
    });
    const next = legacyRefusalNext(refusal, "tl_read_file");
    expect(next.arguments["task"]).toEqual({ epoch: "new", profile: "answer" });
    const pack = await call(server, next.tool, next.arguments);
    expect(pack["kind"], JSON.stringify(pack).slice(0, 600)).toBe("read.task_pack");
    expect(pack["profile"]).toBe("answer");
  }, 120_000);

  it("tl_search_files continues the task from a stringified {handle, taskProfile}; with TL_EFF_TOLERANT_INPUT=0 next moves the profile", async () => {
    const flagSets: Array<Record<string, string>> = [{}, { TL_EFF_TOLERANT_INPUT: "0" }];
    for (const flags of flagSets) {
      const ws = ledgerWorkspace("search");
      const server = await serverFor(ws, flags);
      const pack = await call(server, "tl_read_file", { query: T07_QUERY, task: { epoch: "new", profile: "generic" }, cwd: ws });
      const handle = taskIdOf(pack);
      const args = { action: "find", queries: ["Compute"], task: JSON.stringify({ handle, taskProfile: "generic" }), cwd: ws };
      const reply = await call(server, "tl_search_files", args);
      if (Object.keys(flags).length === 0) {
        expect(reply["kind"], JSON.stringify(reply).slice(0, 600)).toBe("search.matches");
        continue;
      }
      const next = legacyRefusalNext(reply, "tl_search_files");
      expect(next.arguments["task"]).toEqual({ handle, profile: "generic" });
      expect(next.arguments["queries"]).toEqual(["Compute"]);
      const matches = await call(server, next.tool, next.arguments);
      expect(matches["kind"], JSON.stringify(matches).slice(0, 600)).toBe("search.matches");
    }
  }, 180_000);

  it("tl_edit_file with TL_EFF_TOLERANT_INPUT=0: next drops the profile, an edit's no-op, and applies", async () => {
    const ws = ledgerWorkspace("edit");
    const server = await serverFor(ws, { TL_EFF_TOLERANT_INPUT: "0" });
    const pack = await call(server, "tl_read_file", {
      query: "Compute in ledgerd/pkg/balance/compute.go ignores credit-normal accounts; fix Net",
      targets: [{ path: "ledgerd/pkg/balance/compute.go" }],
      task: { epoch: "new", profile: "generic" },
      cwd: ws,
    });
    const handle = taskIdOf(pack);
    const edits = [{ path: "ledgerd/pkg/balance/compute.go", search: "\tb.Net = b.Debit - b.Credit\n", replace: "\tb.Net = b.Debit - b.Credit // see account.Kind\n", precondition: "unique-match" }];
    const refusal = await call(server, "tl_edit_file", { edits, task: JSON.stringify({ handle, taskProfile: "generic" }), cwd: ws });
    const next = legacyRefusalNext(refusal, "tl_edit_file");
    expect(next.arguments["task"]).toEqual({ handle });
    expect(next.arguments["edits"]).toEqual(edits);
    const applied = await call(server, next.tool, next.arguments);
    expect(applied["kind"], JSON.stringify(applied).slice(0, 600)).toBe("edit.applied");
    expect(fs.readFileSync(path.join(ws, "ledgerd/pkg/balance/compute.go"), "utf8")).toContain("// see account.Kind");
  }, 120_000);

  it("control: a stringified task with a member that is no legacy spelling is still not parsed", async () => {
    const ws = ledgerWorkspace("typo");
    const server = await serverFor(ws);
    const refusal = await call(server, "tl_read_file", { query: T07_QUERY, task: "{\"epoch\":\"new\",\"profil\":\"generic\"}", cwd: ws });
    expect(refusal["kind"], JSON.stringify(refusal).slice(0, 600)).toBe("refusal");
    expect(refusal["code"]).toBe("invalid-input");
    expect(refusal["field"]).toBe("task");
  }, 120_000);
});
