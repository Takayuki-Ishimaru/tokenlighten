import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TaskReadinessObligation } from "@tokenlighten/types";
import { extractRuntimeFacts, planNaturalQuery, type Source } from "../features/task-pack/naturalQueryPlan.js";
import { createNaturalEvidence, exactQueryIdentity, projectNaturalEvidence, projectNaturalRequestItems, projectNaturalFacets, appendNaturalObligations, collectNaturalServedSpans, withNaturalEvidence, currentNaturalEvidence, type NaturalIdentity, type ServedSpan } from "../features/task-pack/naturalQueryAdapter.js";
import { selectNaturalEditSurfaces } from "../features/task-pack/naturalEditSurfaces.js";
import { phoneticObjectGroups } from "../features/task-pack/naturalQueryPhonetics.js";
import { requiredSurfacesForTask } from "../features/task-pack/engine/roleAndConcernScope.js";
import { recordTaskContract, resetTaskContractStoreForTest } from "../features/task-pack/taskContractStore.js";
import { resetStateStoresForTests } from "../state/stateStore.js";
import { tokenizeForEpoch } from "../state/session.js";
import { countLines } from "../util/countLines.js";
import { elideDocCommentsWithWindows } from "../util/formatCompress.js";
import { shaOfText } from "../util/handles.js";

const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const source = (path: string, text: string, role: Source["role"] = "implementation"): Source => ({ path, text, role, language: path.endsWith(".py") ? "python" : "text" });
const query = "How does the engine change packet priority and remove access tokens?";
const implementation = `class Engine:
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
async function proof(text = implementation, requested = query) {
  const facts = await extractRuntimeFacts([source("opaque.py", text)]);
  const plan = planNaturalQuery(requested, facts, ["engine", "system"]);
  const identity: NaturalIdentity = { workspace: "workspace", taskBinding: "task-A", lane: "lane-A", profile: "answer", queryIdentity: exactQueryIdentity(requested), inventoryIdentity: "inventory-1" };
  const evidence = createNaturalEvidence(identity, requested, "answer", plan, facts);
  const served: ServedSpan[] = evidence.required.map((span, index) => ({ ...span, handle: `h${index}` }));
  return { facts, plan, identity, evidence, served, currentHash: () => hash(text) };
}

describe("natural proof residency and authority", () => {
  it("uses exact raw source hashes and never treats a nominal range as a served body", async () => {
    const value = await proof();
    expect(value.evidence.gaps).toEqual([]);
    expect(value.facts.declarations.every(d => d.sha === hash(implementation))).toBe(true);
    expect(hash(implementation)).not.toBe(shaOfText(implementation));
    const surface = { path: "opaque.py", range: `1-${countLines(implementation)}`, handle: "h-body", code: implementation };
    const resident = collectNaturalServedSpans(value.evidence.required, [surface], () => implementation);
    expect(projectNaturalEvidence(value.identity, resident, value.currentHash, value.evidence).proved).toBe(true);
    for (const code of [undefined, "class Engine: ...", implementation.replace("            del packet.access_tokens[0]", "            pass")]) {
      const incomplete = collectNaturalServedSpans(value.evidence.required, [{ ...surface, code }], () => implementation);
      expect(projectNaturalEvidence(value.identity, incomplete, value.currentHash, value.evidence).proved).toBe(false);
    }
  });

  it("requires every operation's current spans across partial responses", async () => {
    const value = await proof();
    expect(projectNaturalEvidence(value.identity, [], value.currentHash, value.evidence).proved).toBe(false);
    expect(projectNaturalEvidence(value.identity, value.served.filter(s => s.end < 10), value.currentHash, value.evidence).proved).toBe(false);
    expect(projectNaturalEvidence(value.identity, value.served, () => "changed", value.evidence).proved).toBe(false);
    const ready = projectNaturalEvidence(value.identity, value.served, value.currentHash, value.evidence);
    expect(ready.proved).toBe(true);
    expect(ready.evidence.every(e => /^\d+-\d+$/.test(e.range!))).toBe(true);
  });

  it("rejects foreign task, lane, profile, query and inventory identities", async () => {
    const value = await proof();
    for (const changed of [{ taskBinding: "task-B" }, { lane: "lane-B" }, { profile: "generic" }, { queryIdentity: "other-query" }, { inventoryIdentity: "other-inventory" }]) {
      const projection = projectNaturalEvidence({ ...value.identity, ...changed }, value.served, value.currentHash, value.evidence);
      expect(projection.proved).toBe(false);
      expect(projection.ownedClauseIds.size).toBe(0);
      expect(projection.obligations.some(o => o.status === "uncovered")).toBe(true);
    }
  });

  it("replaces only owned semantic clauses and retains authority, dependency and caller duties", async () => {
    const value = await proof();
    const ready = projectNaturalEvidence(value.identity, value.served, value.currentHash, value.evidence);
    const first = [...ready.ownedClauseIds][0]!;
    const raw = {
      obligations: [
        { id: `request-item:${first}`, kind: "concern" as const, required: true as const, status: "uncovered" as const },
        { id: "authority-check", kind: "concern" as const, required: true as const, status: "uncovered" as const },
      ], absences: [{ id: first }], undetermined: [{ id: first }, { id: "other" }], gap: { next_call: {}, ids: [first] },
    };
    const projected = projectNaturalRequestItems(raw, ready);
    expect(projected.obligations.map(o => o.id)).toEqual(["authority-check"]);
    expect(projected.obligations[0]!.status).toBe("uncovered");
    expect(projected.undetermined).toEqual([{ id: "other" }]);
    expect(projected.gap).toBeUndefined();
    const facet = (label: string, kind: string, dependency?: true) => ({ label, requirement: { facet: kind, clause: query }, facts: { openTargets: [] }, ...(dependency ? { dependency } : {}) });
    const facets = projectNaturalFacets({ entries: [facet("semantic", "value"), facet("callers", "callers"), facet("dependency", "value", true)], openTargets: [], disclosures: [] }, ready)!;
    expect(facets.entries.map(f => f.label)).toEqual(["callers", "dependency"]);
  });

  it("appends mandatory natural requirements beyond twelve without proving existing duties", async () => {
    const value = await proof();
    const ready = projectNaturalEvidence(value.identity, value.served, value.currentHash, value.evidence);
    const obligations: TaskReadinessObligation[] = Array.from({ length: 12 }, (_, index) => ({ id: `authority-${index}`, kind: "concern", required: true, status: "uncovered" }));
    const before = structuredClone(obligations);
    appendNaturalObligations(obligations, ready);
    expect(obligations.length).toBeGreaterThan(12);
    expect(obligations.slice(0, 12)).toEqual(before);
    expect(obligations.some(o => o.id === "request-item:natural-query:runtime-closure")).toBe(true);
  });

  it("isolates concurrent async contexts and clears a failed context", async () => {
    const value = await proof();
    const other = { ...value.evidence, identity: { ...value.identity, lane: "other" } };
    const seen = await Promise.all([
      withNaturalEvidence(value.evidence, async () => { await new Promise(resolve => setTimeout(resolve, 5)); return currentNaturalEvidence(); }),
      withNaturalEvidence(other, async () => { await new Promise(resolve => setTimeout(resolve, 1)); return currentNaturalEvidence(); }),
    ]);
    expect(seen).toEqual([value.evidence, other]);
    expect(currentNaturalEvidence()).toBeUndefined();
    await expect(withNaturalEvidence(value.evidence, async () => { throw new Error("expected failure"); })).rejects.toThrow("expected failure");
    expect(currentNaturalEvidence()).toBeUndefined();
  });

  it("avoids new edit-role inference for answers while preserving explicit and carried roles", async () => {
    const value = await proof();
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "tl-natural-roles-")));
    writeFileSync(join(workspace, "opaque.py"), implementation);
    try {
      expect(requiredSurfacesForTask(query, workspace)).toEqual(expect.arrayContaining(["api", "contract"]));
      expect(withNaturalEvidence(value.evidence, () => requiredSurfacesForTask(query, workspace))).toEqual([]);
      expect(withNaturalEvidence(value.evidence, () => requiredSurfacesForTask(query, workspace, ["test"]))).toEqual(["test"]);
      recordTaskContract(workspace, tokenizeForEpoch(query), { query, requiredRoles: ["api"] });
      expect(withNaturalEvidence(value.evidence, () => requiredSurfacesForTask(query, workspace))).toEqual(["api"]);
      expect(withNaturalEvidence(value.evidence, () => requiredSurfacesForTask(query, workspace, ["test"]))).toEqual(expect.arrayContaining(["api", "test"]));
      expect(withNaturalEvidence({ ...value.evidence, purpose: "edit" }, () => requiredSurfacesForTask(query, workspace))).toEqual(expect.arrayContaining(["api", "contract"]));
    } finally { resetTaskContractStoreForTest(); resetStateStoresForTests(); rmSync(workspace, { recursive: true, force: true }); }
  });
});

describe("natural source residency maps exact line positions", () => {
  const lines = ["def f():", ...Array.from({ length: 16 }, () => ""), "    return 1", ""];
  const text = lines.join("\n");
  const need = { path: "blank.py", sha: hash(text), start: 1, end: 18 };
  const collect = (code: string, range = "1-18", remaining_ranges?: string[]) => collectNaturalServedSpans([need], [{ path: need.path, range, handle: "h", code, ...(remaining_ranges ? { remaining_ranges } : {}) }], () => text);
  const covers = (spans: ServedSpan[], start: number, end: number) => {
    for (let line = start; line <= end; line++) if (!spans.some(s => s.start <= line && s.end >= line)) return false;
    return true;
  };
  it("credits a complete body with an aligned run of blank lines", () => {
    expect(covers(collect(text), 1, 18)).toBe(true);
  });
  it("does not credit a clipped or elided body, including adjacent blank lines", () => {
    expect(covers(collect(lines.slice(0, 8).join("\n")), 9, 16)).toBe(false);
    expect(covers(collect(text, "1-18", ["9-16"]), 9, 16)).toBe(false);
    expect(covers(collect(lines.slice(0, 8).concat(lines.slice(16)).join("\n")), 9, 16)).toBe(false);
  });
  it("credits final blank lines only for an exact complete slice", () => {
    const oneBlank = lines.slice(0, 3).join("\n");
    expect(covers(collect(oneBlank, "1-3"), 1, 3)).toBe(true);
    const blanks = lines.slice(0, 9).join("\n");
    expect(covers(collect(blanks, "1-9"), 1, 9)).toBe(true);
    expect(covers(collect(blanks, "1-18"), 18, 18)).toBe(false);
    expect(covers(collect(blanks, "1-18"), 9, 9)).toBe(false);
  });
  it("maps executable lines past a real renderer-elided docstring without crediting the docstring", () => {
    const source = 'def f():\n    """long\n    documentation\n    """\n    return 1';
    const rendered = elideDocCommentsWithWindows(source, "python", 1);
    const span = { path: "doc.py", sha: hash(source), start: 1, end: 5 };
    const served = collectNaturalServedSpans([span], [{ path: span.path, range: "1-5", handle: "h", code: rendered.text }], () => source);
    expect(covers(served, 1, 1)).toBe(true);
    expect(covers(served, 2, 4)).toBe(false);
    expect(covers(served, 5, 5)).toBe(true);
  });
  it("maps exact reconstructed disjoint ledger ranges without filling their gap", () => {
    const served = collect(`${lines.slice(0, 3).join("\n")}\n${lines.slice(16, 18).join("\n")}`, "1-3,17-18");
    expect(covers(served, 1, 3)).toBe(true);
    expect(covers(served, 17, 18)).toBe(true);
    expect(covers(served, 4, 16)).toBe(false);
  });
  it("does not borrow a repeated earlier block for later nominal lines", () => {
    const block = Array.from({ length: 8 }, (_, i) => `line ${i}`).join("\n");
    const repeated = `${block}\n${block}`;
    const target = { path: "repeat.py", sha: hash(repeated), start: 9, end: 16 };
    const spans = collectNaturalServedSpans([target], [{ path: target.path, range: "1-16", handle: "h", code: block }], () => repeated);
    expect(covers(spans, 9, 16)).toBe(false);
  });
});

describe("structural operation negatives", () => {
  it.each([
    ["read instead of delete", "How does the system remove access tokens?", "def inspect(access_tokens):\n    return access_tokens\n"],
    ["documentation instead of delete", "How does the system remove access tokens?", 'def inspect(access_tokens):\n    """Remove access tokens before sending."""\n    copied = access_tokens\n    return copied\n'],
    ["local copy instead of member change", "How does the system change packet priority?", "def inspect(packet):\n    packet_priority = packet.priority\n    return packet_priority\n"],
    ["unknown extra operation", "How does the system change packet priority and notify the lunar observer?", "def rewrite(packet):\n    if packet.priority < 2:\n        packet.priority = 2\n    return packet\n"],
    ["overridden decision guard", "How does the system remove access tokens?", "class Gate:\n    def allowed(self, access_tokens):\n        return len(access_tokens) > 0\n    def clean(self, access_tokens):\n        if self.allowed(access_tokens):\n            del access_tokens[0]\nclass Custom(Gate):\n    def allowed(self, access_tokens):\n        return False\n"],
  ])("does not certify %s even when all selected spans are supplied", async (_name, requested, text) => {
    const value = await proof(text, requested);
    expect(value.evidence.gaps.length).toBeGreaterThan(0);
    expect(projectNaturalEvidence(value.identity, value.served, value.currentHash, value.evidence).proved).toBe(false);
  });

  it("does not use a similar-sounding unrelated identifier as an operation object", () => {
    expect(phoneticObjectGroups("メソッド", ["merged", "method"])).toEqual([["method"]]);
    expect(phoneticObjectGroups("メソッド", ["merged"])).toEqual([[]]);
    expect(phoneticObjectGroups("パケット", ["pocket"])).toEqual([[]]);
    expect(phoneticObjectGroups("パケット", ["packet", "pocket"])).toEqual([["packet"]]);
  });
});

const editQuery = "Add a configuration setting to control event handler precedence, including implementation, config docs and tests.";
const editSources: Source[] = [
  source("pkg/__init__.py", "from .opaque import Engine\n"),
  source("pkg/opaque.py", `class Engine:
    default_config = dict(POLICY_MODE="strict")
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
        """REGISTRY_DOCSTRING is documentation, not runtime evidence."""
        def decorator(handler):
            self.install(kind, handler)
            return handler
        return decorator
    def client(self):
        return self
`),
  source("manual/settings.rst", "Configuration\n=============\n\n.. py:data:: POLICY_MODE\n\n    Controls the configured policy.\n", "documentation"),
  source("manual/conf.py", 'POLICY_MODE = "strict"\n', "documentation"),
  source("tests/conftest.py", "import pytest\nfrom pkg import Engine\n@pytest.fixture\ndef service():\n    instance = Engine()\n    return instance\n", "test"),
  source("tests/test_knobs.py", 'from pkg import Engine\ndef test_config_roundtrip():\n    instance = Engine()\n    assert instance.config["POLICY_MODE"] == "strict"\n', "test"),
  source("tests/test_dispatch.py", `def test_handler_priority(service):
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
    assert c.run("parent") == "parent"
    assert c.run("child") == "child"
`, "test"),
];

describe("natural edit source roles", () => {
  it("requires executable nested registration, exact config docs, and observed behavior tests", async () => {
    const facts = await extractRuntimeFacts(editSources);
    const plan = planNaturalQuery(editQuery, facts);
    const roles = await selectNaturalEditSurfaces(editQuery, plan, editSources, undefined, facts);
    expect(roles.missing).toEqual([]);
    const behavior = roles.relations.find(r => r.role === "behavior-test")!;
    expect(behavior.spans[0]!.path).toBe("tests/test_dispatch.py");
    const implementation = editSources.find(s => s.path === "pkg/opaque.py")!;
    const lines = implementation.text.split("\n");
    const nestedCall = lines.findIndex(line => line.includes("self.install(kind, handler)")) + 1;
    const docstring = lines.findIndex(line => line.includes("REGISTRY_DOCSTRING")) + 1;
    const runtime = behavior.spans.filter(s => s.path === implementation.path);
    expect(runtime.some(s => s.start <= nestedCall && s.end >= nestedCall)).toBe(true);
    expect(runtime.some(s => s.start <= docstring && s.end >= docstring)).toBe(false);
    expect(roles.relations.some(r => r.spans.some(s => s.path === "manual/conf.py"))).toBe(false);
    const docs = roles.relations.find(r => r.role === "documentation")!;
    expect(docs.spans[0]!.end).toBeLessThanOrEqual(countLines(editSources.find(s => s.path === "manual/settings.rst")!.text));
  });

  it("does not accept missing prose docs, a same-name foreign owner, or tests without assertions", async () => {
    const facts = await extractRuntimeFacts(editSources);
    const plan = planNaturalQuery(editQuery, facts);
    const noDocs = await selectNaturalEditSurfaces(editQuery, plan, editSources.filter(s => s.path !== "manual/settings.rst"), undefined, facts);
    expect(noDocs.missing).toContain("documentation");
    const wrongOwner = editSources.map(s => s.role === "test" ? { ...s, text: s.text.replaceAll("from pkg import Engine", "from other import Engine") } : s);
    wrongOwner.push(source("other.py", "class Engine:\n    pass\n"));
    const wrong = await selectNaturalEditSurfaces(editQuery, plan, wrongOwner, undefined, facts);
    expect(wrong.missing).toEqual(expect.arrayContaining(["test", "behavior-test"]));
    const noAssertions = editSources.map(s => s.path === "tests/test_dispatch.py" ? { ...s, text: s.text.replaceAll("assert c.run", "c.run") } : s);
    expect((await selectNaturalEditSurfaces(editQuery, plan, noAssertions, undefined, facts)).missing).toContain("behavior-test");
  });
});
