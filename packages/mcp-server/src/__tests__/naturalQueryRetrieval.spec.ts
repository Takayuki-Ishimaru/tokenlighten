import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { makeSmallTaskWorkspace, startSmallTaskServer, type CallResult, type SmallTaskServer } from "./helpers/smallTaskServer.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";

type Decision = { kind?: string; next?: Next | Next[]; certificate?: { obligations?: string[] } };
type Next = { tool: string; arguments: Record<string, unknown> };
const decision = (reply: CallResult): Decision => reply.body.decision as Decision;
const taskHandle = (reply: CallResult): string => (reply.body.task as { id: string }).id;
const bodyText = (reply: CallResult): string => ((reply.body.evidence ?? []) as Array<{ body?: string }>).map(e => e.body ?? "").join("\n");
async function fixture(files: Record<string, string>, run: (server: SmallTaskServer, workspace: string) => Promise<void>, allowWrite = false): Promise<void> {
  const workspace = makeSmallTaskWorkspace("tl-natural-retrieval-", files);
  const server = await startSmallTaskServer(workspace, { allowWrite, env: { TL_EFF_AUTOFOLLOW: "0", TL_BACKGROUND_INDEX: "off" } });
  try { await run(server, workspace); }
  finally { await server.kill(); await rmDirWithRetry(workspace); }
}
const operations = `class Engine:
    def process(self, packet):
        self.revise(packet)
        self.cleanup(packet)
        return packet
    def revise(self, packet):
        if packet.priority < 2:
            packet.priority = 2
        return packet
    def cleanup(self, packet):
        if packet.access_tokens:
            del packet.access_tokens[0]
        return packet
`;
const operationQuery = "How does the system change packet priority and remove access tokens?";
const policy = `def choose(token_policies):
    for token_policy in token_policies:
        if token_policy.enabled:
            return token_policy
    return None
`;

describe("natural query public retrieval and completion", () => {
  it.each([
    [operationQuery, operations, "del packet.access_tokens[0]"],
    ["Which token policy to use?", policy, "return token_policy"],
    ["どのエラーハンドラを選ぶかをどう決めますか？", policy.replaceAll("token_policies", "error_handlers").replaceAll("token_policy", "error_handler"), "return error_handler"],
  ])("automatically serves connected implementation and certifies its operations: %s", async (query, source, returned) => {
    await fixture({ "opaque.py": source }, async (server, workspace) => {
      const reply = await server.call("tl_read_file", { cwd: workspace, query, task: { epoch: "new", profile: "answer" } });
      expect(reply.isError, reply.text).toBe(false);
      expect(decision(reply).kind, reply.text).toBe("act.answer");
      const provenance = ((reply.body.evidence ?? []) as Array<{ why?: string }>).map(e => e.why);
      expect(provenance).toContain("natural-query-operation");
      expect(provenance).not.toContain("caller-supplied");
      expect(bodyText(reply)).toContain(returned);
      if (source === operations) expect(bodyText(reply)).toContain("packet.priority = 2");
      else expect(bodyText(reply)).toContain(".enabled:");
      // This also pins the adapter's raw SHA representation against sha256:-prefixed handle hashes.
      expect(decision(reply).certificate?.obligations).toContain("request-item:natural-query:runtime-closure");
      expect(decision(reply).certificate?.obligations).toContain("request-item:natural-operation:1");
      expect(decision(reply).next).toBeUndefined();
    });
  }, 90000);

  it.each([
    ["runtime only reads", "How does the system remove access tokens?", "def inspect(access_tokens):\n    return access_tokens\n"],
    ["docstring invents deletion", "How does the system remove access tokens?", 'def inspect(access_tokens):\n    """Remove access tokens before sending."""\n    copied = access_tokens\n    return copied\n'],
    ["one requested operation is unsupported", "How does the system change packet priority and notify the lunar observer?", "def rewrite(packet):\n    if packet.priority < 2:\n        packet.priority = 2\n    return packet\n"],
    ["subclass overrides a decision guard", "How does the system remove access tokens?", "class Gate:\n    def allowed(self, access_tokens):\n        return len(access_tokens) > 0\n    def clean(self, access_tokens):\n        if self.allowed(access_tokens):\n            del access_tokens[0]\nclass Custom(Gate):\n    def allowed(self, access_tokens):\n        return False\n"],
  ])("abstains when %s", async (_name, query, source) => {
    await fixture({ "opaque.py": source }, async (server, workspace) => {
      const reply = await server.call("tl_read_file", { cwd: workspace, query, task: { epoch: "new", profile: "answer" } });
      expect(reply.isError, reply.text).toBe(false);
      expect(decision(reply).kind, reply.text).toBe("await_input");
      expect(decision(reply).certificate).toBeUndefined();
      expect(reply.body.evidence ?? []).toEqual([]);
      // Choosing a location authorizes reading it; it does not prove that its
      // implementation performs the requested operation.
      const selected = await server.call("tl_read_file", {
        cwd: workspace, query, targets: [{ path: "opaque.py" }], task: { handle: taskHandle(reply) },
      });
      expect(selected.isError, selected.text).toBe(false);
      expect(decision(selected).kind, selected.text).not.toMatch(/^act\./);
      expect(decision(selected).certificate).toBeUndefined();
    });
  }, 90000);

  it("serves edit roles and a returned registry callback without requiring its elided docstring", async () => {
    const engine = `class Engine:
    default_config = dict(POLICY_MODE="strict")
    def __init__(self):
        self.config = dict(self.default_config)
        self.handler_table = {}
    def route(self, event):
        if self.config["POLICY_MODE"]:
            handler = self.choose(event)
            return handler(event)
        return None
    def choose(self, event):
        for kind in event.__class__.__mro__:
            handler = self.handler_table.get(kind)
            if handler is not None:
                return handler
        return None
    def install(self, kind, handler):
        self.handler_table[kind] = handler
    def handler(self, kind):
        """ELIDED_REGISTRY_DOCUMENTATION: registration explains this decorator.

        The returned callback writes the shared runtime registry.
        """
        def decorator(handler):
            self.install(kind, handler)
            return handler
        return decorator
    def client(self):
        return self
`;
    await fixture({
      "pkg/__init__.py": "from .opaque import Engine\n",
      "pkg/opaque.py": engine,
      "manual/settings.rst": "Configuration\n=============\n\n.. py:data:: POLICY_MODE\n\n    Controls the configured policy.\n",
      "manual/conf.py": 'POLICY_MODE = "DOC_BUILD_DECOY"\n',
      "tests/conftest.py": "import pytest\nfrom pkg import Engine\n@pytest.fixture\ndef service():\n    instance = Engine()\n    return instance\n",
      "tests/test_knobs.py": 'from pkg import Engine\ndef test_config_roundtrip():\n    instance = Engine()\n    assert instance.config["POLICY_MODE"] == "strict"\n',
      "tests/test_dispatch.py": `def test_handler_priority(service):
    class Parent(Exception):
        pass
    class Child(Parent):
        pass
    @service.handler(Parent)
    def parent(e):
        return "parent"
    @service.handler(Child)
    def child(e):
        return "child"
    c = service.client()
    assert c.route(Parent()) == "parent"
    assert c.route(Child()) == "child"
`,
    }, async (server, workspace) => {
      const reply = await server.call("tl_read_file", { cwd: workspace,
        query: "Add a configuration setting to control event handler precedence, including implementation, config docs and tests.",
        task: { epoch: "new", profile: "generic" } });
      expect(decision(reply).kind, reply.text).toBe("act.edit");
      expect(bodyText(reply)).toContain("self.install(kind, handler)");
      expect(bodyText(reply)).not.toContain("ELIDED_REGISTRY_DOCUMENTATION");
      const paths = ((reply.body.evidence ?? []) as Array<{ path: string }>).map(e => e.path);
      expect(paths).toEqual(expect.arrayContaining(["pkg/opaque.py", "manual/settings.rst", "tests/test_knobs.py", "tests/test_dispatch.py"]));
      expect(paths).not.toContain("manual/conf.py");
      expect(decision(reply).certificate?.obligations?.some(id => id.startsWith("request-item:natural-role:behavior-test:"))).toBe(true);
    }, true);
  }, 90000);

  it("preserves missing natural obligations after a budgeted next and a narrowed target", async () => {
    const longOperations = operations
      .replace("        return packet\n    def cleanup", `${Array.from({ length: 90 }, (_, i) => `        packet.priority_trace_${i} = "${"x".repeat(55)}${i}"`).join("\n")}\n        return packet\n    def cleanup`)
      .replace("            del packet.access_tokens[0]\n", `            del packet.access_tokens[0]\n${Array.from({ length: 90 }, (_, i) => `        packet.access_trace_${i} = "${"y".repeat(55)}${i}"`).join("\n")}\n`);
    await fixture({ "opaque.py": longOperations }, async (server, workspace) => {
      const first = await server.call("tl_read_file", { cwd: workspace, query: operationQuery, budget: { bytes: 6144 }, task: { epoch: "new", profile: "answer" } });
      expect(decision(first).kind, first.text).toBe("discover");
      const next = decision(first).next;
      const calls = Array.isArray(next) ? next : next ? [next] : [];
      expect(calls.length).toBeGreaterThan(0);
      // Exercise exactly the public next shape, including opaque cursors.
      const replies = await Promise.all(calls.map(call => server.call(call.tool, { ...call.arguments, cwd: workspace })));
      const latest = replies.at(-1)!;
      expect(decision(latest).kind, latest.text).not.toMatch(/^act\./);
      const narrowed = await server.call("tl_read_file", {
        cwd: workspace, query: operationQuery, budget: { bytes: 6144 },
        targets: [{ path: "opaque.py", range: "1-5" }], task: { handle: taskHandle(latest) },
      });
      expect(decision(narrowed).kind, narrowed.text).not.toMatch(/^act\./);
      expect(decision(narrowed).certificate).toBeUndefined();
      expect(narrowed.text).toContain("request-item:natural-query:runtime-closure");
    });
  }, 90000);

  it("does not turn an unsupported natural operation into a proof after explicit selection", async () => {
    await fixture({ "opaque.py": "def inspect(access_tokens):\n    return access_tokens\n" }, async (server, workspace) => {
      const query = "How does the service remove access tokens?";
      const first = await server.call("tl_read_file", { cwd: workspace, query, task: { epoch: "new", profile: "answer" } });
      expect(decision(first).kind, first.text).toBe("await_input");
      const selected = await server.call("tl_read_file", { cwd: workspace, query,
        targets: [{ path: "opaque.py" }], task: { handle: taskHandle(first) } });
      expect(selected.isError, selected.text).toBe(false);
      expect(decision(selected).kind, selected.text).not.toMatch(/^act\./);
      expect(decision(selected).certificate).toBeUndefined();
      expect(selected.text).toContain("request-item:natural-query:runtime-closure");
    });
  }, 90000);

  it("invalidates a certified repeat when an unchanged-size file introduces an equally supported implementation", async () => {
    const decoy = "def unrelated():\n    return None\n".padEnd(policy.length, " ");
    await fixture({ "primary.py": policy, "other.py": decoy }, async (server, workspace) => {
      const query = "Which token policy to use?";
      const first = await server.call("tl_read_file", { cwd: workspace, query, task: { epoch: "new", profile: "answer" } });
      expect(decision(first).kind, first.text).toBe("act.answer");
      const target = path.join(workspace, "other.py");
      const before = fs.statSync(target);
      fs.writeFileSync(target, policy);
      fs.utimesSync(target, before.atime, before.mtime);
      expect(fs.statSync(target).size).toBe(before.size);
      const repeated = await server.call("tl_read_file", { cwd: workspace, query, task: { handle: taskHandle(first) } });
      expect(repeated.isError, repeated.text).toBe(false);
      expect(decision(repeated).kind, repeated.text).toBe("await_input");
      expect(decision(repeated).certificate).toBeUndefined();
    });
  }, 90000);
  it("reuses complete clause-owned bodies without losing the certified stop", async () => {
    await fixture({
      "one.ts": "// badges are validated here.\nexport function validateBadge(badge: string): boolean {\n  return badge.length > 2;\n}\n",
      "two.ts": "// queued totals are computed here.\nexport function computeQueuedTotals(records: number[]): number {\n  return records.length * 2;\n}\n",
    }, async (server, workspace) => {
      const query = "Explain how badges are validated and how queued totals are computed.";
      const first = await server.call("tl_read_file", {cwd:workspace,query,task:{epoch:"new",profile:"answer"}});
      expect(decision(first).kind,first.text).toBe("await_input");
      const selected = await server.call("tl_read_file", {cwd:workspace,query,targets:[{path:"one.ts"},{path:"two.ts"}],task:{handle:taskHandle(first)}});
      expect(decision(selected).kind,selected.text).toBe("act.answer");
      expect(decision(selected).certificate?.obligations).toEqual(expect.arrayContaining(["request-item:ri-1","request-item:ri-2","request-item:natural-existing-clause-proof"]));
      expect(bodyText(selected)).toContain("badge.length > 2");
      expect(bodyText(selected)).toContain("records.length * 2");
      const repeated = await server.call("tl_read_file", {cwd:workspace,query,task:{handle:taskHandle(selected)}});
      expect(decision(repeated).kind,repeated.text).toBe("act.answer");
      fs.writeFileSync(path.join(workspace,"two.ts"),"// queued totals are computed here.\n");
      const stale = await server.call("tl_read_file", {cwd:workspace,query,task:{handle:taskHandle(repeated)}});
      expect(decision(stale).kind,stale.text).not.toMatch(/^act\./);
    });
  },90000);

  it("does not let a second proved clause discharge an unimplemented deletion", async () => {
    await fixture({
      "one.py":"# service remove access tokens\ndef inspect_access_tokens(access_tokens):\n    return access_tokens\n",
      "two.py":"# credentials are validated here\ndef validate_credentials(credentials):\n    return len(credentials) > 0\n",
    },async(server,workspace)=>{
      const query="How does the service remove access tokens and how are credentials validated?";
      const first=await server.call("tl_read_file",{cwd:workspace,query,task:{epoch:"new",profile:"answer"}});
      expect(decision(first).kind,first.text).toBe("await_input");
      const selected=await server.call("tl_read_file",{cwd:workspace,query,targets:[{path:"one.py"},{path:"two.py"}],task:{handle:taskHandle(first)}});
      expect(bodyText(selected)).toContain("return access_tokens");
      expect(bodyText(selected)).toContain("return len(credentials) > 0");
      expect(decision(selected).kind,selected.text).not.toMatch(/^act\./);
      expect(decision(selected).certificate).toBeUndefined();
      expect(selected.text).toContain("request-item:natural-operation:1");
    });
  },90000);

  it.each([
    ["How does the system validate credentials?",false],
    ["How does the service translate access tokens?",false],
    ["Explain how credentials are validated and how access tokens are translated.",false],
    ["Explain how credentials are validated and how access tokens are translated.",true],
  ])("requires executable action grounding for unsupported clauses: %s (named=%s)",async(query,named)=>{
    await fixture({
      "credentials.py":`# credentials are validated here\ndef ${named ? 'validate_credentials' : 'inspect_credentials'}(credentials):\n    return ${named ? 'True' : 'credentials'}\n`,
      "tokens.py":`# access tokens are translated here\ndef ${named ? 'translate_tokens' : 'inspect_tokens'}(access_tokens):\n    return access_tokens\n`,
    },async(server,workspace)=>{
      const first=await server.call("tl_read_file",{cwd:workspace,query,task:{epoch:"new",profile:"answer"}});
      expect(decision(first).kind,first.text).toBe("await_input");
      const selected=await server.call("tl_read_file",{cwd:workspace,query,targets:[{path:"credentials.py"},{path:"tokens.py"}],task:{handle:taskHandle(first)}});
      expect(decision(selected).kind,selected.text).not.toMatch(/^act\./);
      expect(decision(selected).certificate).toBeUndefined();
      expect(bodyText(selected)).toContain(named ? "return True" : "return credentials");
      expect(bodyText(selected)).toContain("return access_tokens");
    });
  },90000);

  it.each([
    ["conditional logging", "def validate_credentials(credentials):\n    if credentials:\n        print(credentials)\n    return True\n", "def translate_tokens(access_tokens):\n    if access_tokens:\n        print(access_tokens)\n    return access_tokens\n"],
    ["returned logging", "def validate_credentials(credentials):\n    return print(credentials)\n", "def translate_tokens(access_tokens):\n    return print(access_tokens)\n"],
  ])("does not treat %s as a named action implementation",async(_name,credentials,tokens)=>{
    await fixture({"credentials.py":credentials,"tokens.py":tokens},async(server,workspace)=>{
      const query="Explain how credentials are validated and how access tokens are translated.";
      const first=await server.call("tl_read_file",{cwd:workspace,query,task:{epoch:"new",profile:"answer"}});
      expect(decision(first).kind,first.text).toBe("await_input");
      const selected=await server.call("tl_read_file",{cwd:workspace,query,targets:[{path:"credentials.py"},{path:"tokens.py"}],task:{handle:taskHandle(first)}});
      expect(decision(selected).kind,selected.text).not.toMatch(/^act\./);
      expect(decision(selected).certificate).toBeUndefined();
    });
  },90000);

  it("does not borrow a sibling method's computed body to prove the selected method", async () => {
    await fixture({
      "src/limits.ts": "export const RETRY_LIMIT = 7; export class Alpha { retry(attempts: number): boolean { return attempts < RETRY_LIMIT; } }\n",
      "src/scheduler.ts": "import { RETRY_LIMIT } from './limits.js';\nexport class Beta {\n  retry(attempts: number): boolean {\n    return false;\n  }\n}\n",
      "src/worker.ts": "import { Beta } from './scheduler.js';\nexport function finishAttempt(attempts: number) {\n  return new Beta().retry(attempts);\n}\n",
    }, async (server, workspace) => {
      const query = "How does the scheduler decide whether to retry: what is the retry limit constant's configured value, and who calls the retry decision?";
      const first = await server.call("tl_read_file", {cwd:workspace,query,task:{epoch:"new",profile:"answer"}});
      expect(decision(first).kind, first.text).toBe("await_input");
      const selected = await server.call("tl_read_file", {cwd:workspace,query,targets:[
        {path:"src/scheduler.ts",range:"3-5"}, {path:"src/limits.ts",range:"1-1"},
      ],task:{handle:taskHandle(first)}});
      expect(bodyText(selected), selected.text).toContain("return false;");
      expect(bodyText(selected), selected.text).toContain("return attempts < RETRY_LIMIT;");
      expect(decision(selected).kind, selected.text).not.toMatch(/^act\./);
      expect(decision(selected).certificate).toBeUndefined();
    });
  }, 90000);

  it("isolates unrelated syntax errors while preserving owner and scope failures",async()=>{
    const one="// badges are validated here.\nexport function validateBadge(badge: string): boolean {\n  return badge.length > 2;\n}\n";
    const two="// queued totals are computed here.\nexport function computeQueuedTotals(records: number[]): number {\n  return records.length * 2;\n}\n";
    await fixture({"one.ts":one,"two.ts":two,"unrelated.ts":"this is not TypeScript ???\n"},async(server,workspace)=>{
      const query="Explain how badges are validated and how queued totals are computed.";
      const select=async()=>{
        const first=await server.call("tl_read_file",{cwd:workspace,query,task:{epoch:"new",profile:"answer"}});
        expect(decision(first).kind,first.text).toBe("await_input");
        return server.call("tl_read_file",{cwd:workspace,query,targets:[{path:"one.ts"},{path:"two.ts"}],task:{handle:taskHandle(first)}});
      };
      const cleanOwners=await select();
      expect(decision(cleanOwners).kind,cleanOwners.text).toBe("act.answer");
      fs.writeFileSync(path.join(workspace,"one.ts"),one+"const = ???;\n");
      const brokenOwner=await select();
      expect(decision(brokenOwner).kind,brokenOwner.text).not.toMatch(/^act\./);
      fs.writeFileSync(path.join(workspace,"one.ts"),one);
      fs.writeFileSync(path.join(workspace,"unread.ts"),"// padding\n".repeat(110000));
      const omittedScope=await select();
      expect(decision(omittedScope).kind,omittedScope.text).not.toMatch(/^act\./);
      expect(decision(omittedScope).certificate).toBeUndefined();
    });
  },90000);

});
