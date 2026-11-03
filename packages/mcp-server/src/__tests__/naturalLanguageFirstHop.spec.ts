import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeSmallTaskWorkspace, startSmallTaskServer, type SmallTaskServer } from "./helpers/smallTaskServer.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";

describe("natural-language first hop does not certify guessed implementations", () => {
  let server: SmallTaskServer;
  let workspace: string;
  beforeAll(async () => {
    workspace = makeSmallTaskWorkspace("tl-natural-first-", {
      "src/flask/app.py": "class Flask:\n    def _find_error_handler(self, e, blueprints):\n        for name in (*blueprints, None):\n            for cls in type(e).__mro__:\n                handler = self.error_handler_spec[name][None].get(cls)\n                if handler is not None:\n                    return handler\n        return None\n",
      "src/flask/testing.py": "from .app import Flask\nclass FlaskClient:\n    def __enter__(self):\n        return 'VALIDATION_DECOY_BODY'\n",
      "docs/conf.py": "project = 'Flask'\nconfig_docs = 'SPHINX_DECOY_BODY'\n",
      "docs/config.rst": "Configuration\n=============\nConfigure the Flask application settings.\n",
    });
    server = await startSmallTaskServer(workspace, { env: { TL_BACKGROUND_INDEX: "off", TL_LEGACY_INPUT: "accept" } });
  }, 90000);
  afterAll(async () => { await server?.kill(); if (workspace) await rmDirWithRetry(workspace); });

  it.each([
    "How does Flask decide which error handler to use?",
    "Flaskは例外時にどのエラーハンドラを選びますか？",
    "Add a Flask configuration key, with config docs and tests.",
    "Explain the service behavior. Include the defaults.",
    "Explain the service behavior, e.g. its results.",
    "When following redirects, how does requests change the HTTP method and decide whether to remove authentication headers?",
    "requestsがリダイレクトするとき、HTTPメソッドをどう変更し、認証ヘッダーを取り除くかをどう判断しますか？",
  ])("returns unverified locations instead of unrelated bodies: %s", async (query) => {
    const first = await server.call("tl_read_file", { cwd: workspace, lane: "natural", query, task: { epoch: "new" } });
    expect(first.isError, first.text).toBe(false);
    const decision = first.body.decision as Record<string, unknown>;
    expect(decision?.kind, first.text).toBe("await_input");
    expect(decision?.code, first.text).toBe("name-intended-target");
    expect(decision?.certificate).toBeUndefined();
    expect(decision?.next).toBeUndefined();
    expect(first.body.evidence ?? []).toEqual([]);
    expect(first.text).not.toMatch(/VALIDATION_DECOY_BODY|SPHINX_DECOY_BODY|"body":|query_candidate_selection/);
    const task = (first.body.task as { id?: string })?.id;
    expect(task, first.text).toBeTruthy();
    const repeated = await server.call("tl_read_file", { cwd: workspace, lane: "natural", query, task: { handle: task } });
    expect((repeated.body.decision as Record<string, unknown>)?.kind, repeated.text).toBe("await_input");
    expect(repeated.text).not.toMatch(/"body":|"certificate":|"next":/);
  }, 90000);

  it("serves an explicitly selected candidate range", async () => {
    const first = await server.call("tl_read_file", { cwd: workspace, lane: "select", query: "How are exception handlers selected?", task: { epoch: "new", profile: "answer" } });
    const task = (first.body.task as { id?: string })?.id;
    const selected = await server.call("tl_read_file", { cwd: workspace, lane: "select", targets: [{ path: "src/flask/app.py", range: "2-8" }], task: { handle: task } });
    expect(selected.isError, selected.text).toBe(false);
    expect(selected.text).toContain("_find_error_handler");
    expect(selected.text).toContain("return handler");
  }, 90000);

  it("retains a fresh same-task answer after explicit selection, with no further discovery", async () => {
    const query = "How does Flask decide which error handler to use?";
    const first = await server.call("tl_read_file", { cwd: workspace, lane: "closed", query, task: { epoch: "new", profile: "answer" } });
    const task = (first.body.task as { id?: string })?.id;
    expect((first.body.decision as Record<string, unknown>)?.kind, first.text).toBe("act.answer");
    expect(first.text).toContain("return handler");
    const selected = await server.call("tl_read_file", { cwd: workspace, lane: "closed", query, targets: [{ path: "src/flask/app.py" }], task: { handle: task } });
    expect(selected.isError, selected.text).toBe(false);
    // An explicit post-ready source read can be a read.text receipt. The next
    // task-pack request must still validate and retain the original answer.
    expect((selected.body.decision as Record<string, unknown>)?.kind, selected.text).not.toBe("discover");
    const selectedTask = (selected.body.task as { id?: string })?.id ?? task;
    const repeated = await server.call("tl_read_file", { cwd: workspace, lane: "closed", query, task: { handle: selectedTask } });
    expect((repeated.body.decision as Record<string, unknown>)?.kind, repeated.text).toBe("act.answer");
    expect(repeated.text).not.toContain('"next":');
    const different = await server.call("tl_read_file", { cwd: workspace, lane: "closed", query: "Explain the configuration choices", task: { epoch: "new", profile: "answer" } });
    expect((different.body.decision as Record<string, unknown>)?.kind, different.text).toBe("await_input");
  }, 90000);
});


describe("confirmed query subjects retain targeted routes", () => {
  let server: SmallTaskServer;
  let workspace: string;
  beforeAll(async () => {
    workspace = makeSmallTaskWorkspace("tl-confirmed-subject-", {
      "package.json": JSON.stringify({ name: "@tools/token-lighten" }),
      "src/TokenLighten.ts": "export class TokenLighten { choose() { return 1; } }\n",
      "src/OrderOrchestrator.ts": "export class OrderOrchestrator { place() { return 2; } }\n",
      "src/retry.ts": "export function retry() { return 3; }\nexport function retryDelay() { return 100; }\n",
      "src/run.ts": "export function run() { return 4; }\n",
      "src/Sum.ts": "export function Sum() { return 5; }\n",
      "src/HTTP.ts": "export function HTTP() { return 6; }\n",
      "include/EKF.hpp": "namespace nav { class EKF { public: EKF(); bool healthy(); }; }\n",
      "src/EKF.cpp": "#include \"../include/EKF.hpp\"\nnav::EKF::EKF() {}\nbool nav::EKF::healthy() { return true; }\n",
      "src/MAVLink.ts": "export class MAVLink { encode() { return 1; } }\n",
      "src/redirect.ts": "export function redirect() { return 'UNRELATED_REDIRECT_BODY'; }\n",
      "src/requests.py": "class Session:\n    def rebuild_method(self, method):\n        return method\n",
    });
    server = await startSmallTaskServer(workspace, { env: { TL_BACKGROUND_INDEX: "off", TL_LEGACY_INPUT: "accept" } });
  }, 90000);
  afterAll(async () => { await server?.kill(); if (workspace) await rmDirWithRetry(workspace); });

  it.each([
    ["Explain OrderOrchestrator briefly.", "OrderOrchestrator"],
    ["Give me a quick overview of OrderOrchestrator and the order it calls payment / inventory / shipping in.", "OrderOrchestrator"],
    ["Explain how OrderOrchestrator places an order.", "OrderOrchestrator"],
    ["Explain the EKF class.", "EKF"],
    ["shopflow に最近入った OrderOrchestrator っていうデカいクラスを短く説明してほしい。", "OrderOrchestrator"],
    ["Explain the retry function, including the exact maximum number of attempts.", "retry"],
    ["Explain run", "run"],
    ["Fix Sum so drains count down.", "Sum"],
  ])("keeps a declared direct subject usable: %s", async (query, name) => {
    const result = await server.call("tl_read_file", { cwd: workspace, query, task: { epoch: "new" } });
    expect(result.isError, result.text).toBe(false);
    expect((result.body.decision as { code?: string })?.code, result.text).not.toBe("name-intended-target");
    expect(result.text).toContain(name);
  }, 90000);

  it.each([
    "How does TokenLighten choose a continuation?",
    "Find why navigation health stays normal when EKF fails; reuse the MAVLink encoder.",
    "When following redirects, how does requests change the HTTP method and decide whether to remove authentication headers?",
    "How does requests choose the redirect method?",
    "How does requests choose the redirect function?",
    "Explain the MissingType class.",
  ])("does not make incidental or absent declarations into request anchors: %s", async query => {
    const result = await server.call("tl_read_file", { cwd: workspace, query, task: { epoch: "new" } });
    expect(result.isError, result.text).toBe(false);
    expect((result.body.decision as { code?: string })?.code, result.text).toBe("name-intended-target");
    expect(result.body.evidence ?? []).toEqual([]);
    expect(result.text).not.toMatch(/"certificate":|"next":|"body":|UNRELATED_REDIRECT_BODY/);
  }, 90000);
});
