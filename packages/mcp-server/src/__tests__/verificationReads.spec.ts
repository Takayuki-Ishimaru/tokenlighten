import { describe, expect, it } from "vitest";
import {
  clarifyOptionalVerificationTests,
  optionalVerificationTestHandles,
  testHandlesOverReadBudget,
  VERIFICATION_TEST_READ_BUDGET_BYTES,
} from "../protocol/verificationReads.js";
type Kit = {
  note: string;
  omitted: number;
  toolchain: {test_entry?: string; test_entry_dir?: string; deps_installed: boolean};
  surfaces: Array<Record<string, unknown>>;
  [key: string]: unknown;
};
const note = "run toolchain.test_entry from toolchain.test_entry_dir; use served test context; read only omitted bodies via next";
function kit(): Kit {
  return {note, omitted: 0, toolchain: {test_entry: "npm test", test_entry_dir: "apps/web", deps_installed: true}, surfaces: [
    {path: "pkg/balance/compute_test.go", handle: "held", role: "test", body: "served-earlier", served_by: "read-1"},
    {path: "pkg/balance/balance_test.go", handle: "optional", role: "test", body: "omitted"},
  ]};
}
describe("optional verification test context", () => {
  it("guides an installed CLI test entry without changing body truth or handles", () => {
    const value = kit(), original = structuredClone(value.surfaces);
    const handles = optionalVerificationTestHandles(value, true, new Set(), new Set());
    expect([...handles]).toEqual(["optional"]);
    clarifyOptionalVerificationTests(value, handles, []);
    expect(value.note).toContain("verification instructions are already included");
    expect(value.note).toContain('run "npm test" from "apps/web"');
    expect(value.note).toContain("do not pull closure just to retrieve this kit again");
    expect(value.note).toContain("follow a closure next only when explicitly returned");
    expect(value.note).toContain("other listed test source is optional");
    expect(value.note).not.toContain("run toolchain.test_entry from toolchain.test_entry_dir");
    expect(value.note).not.toContain("follow verification.next_call");
    expect(value.surfaces).toEqual(original);
    expect(value.omitted).toBe(0);
  });
  it("retains required kit reads when a verification next_call exists", () => {
    const value = kit();
    value.next_call = { tool: "tl_read_file", arguments: { handles: ["required"] } };
    const handles = optionalVerificationTestHandles(value, true, new Set(), new Set());
    clarifyOptionalVerificationTests(value, handles, []);
    expect(value.note).toContain("follow verification.next_call");
    expect(value.note).toContain("recipe.gaps");
    expect(value.note).toContain('run "npm test" from "apps/web"');
    expect(value.note).not.toContain("run toolchain.test_entry from toolchain.test_entry_dir");
    expect(value.note).toContain("other listed test source is optional");
  });
  it("keeps known recipe gaps ahead of the local test run", () => {
    const value = {...kit(), recipe: {gaps: [{code: "assertion-missing"}]}};
    clarifyOptionalVerificationTests(value, new Set(["optional"]), []);
    expect(value.note).toContain("follow verification.next_call when present and nonempty recipe.gaps before the run");
    expect(value.note).toContain('run "npm test" from "apps/web"');
  });
  it("does not skip optional test bodies without an exact runnable directory", () => {
    const value = kit();
    delete value.toolchain.test_entry_dir;
    const handles = optionalVerificationTestHandles(value, true, new Set(), new Set());
    clarifyOptionalVerificationTests(value, handles, []);
    expect(handles.size).toBe(0);
    expect(value.note).toBe(note);
  });
  it.each([
    {recipe: {}},
    {recipe: {gaps: "unknown"}},
    {recipe: {gaps: {code: "missing"}}},
    {next_call: null},
    {next_call: {tool: "tl_read_file"}},
    {next_call: {tool: "not_a_tool", arguments: {}}},
  ])("fails closed for malformed gaps or next_call: %j", extra => {
    const value = {...kit(), ...extra};
    const handles = optionalVerificationTestHandles(value, true, new Set(), new Set());
    expect(handles.size).toBe(0);
    clarifyOptionalVerificationTests(value, new Set(["optional"]), []);
    expect(value.note).toBe(note);
  });
  it.each(["non-CLI", "deps unknown", "deps absent"])("keeps prerequisite reads when not runnable: %s", () => {
    const value = kit();
    const handles = optionalVerificationTestHandles(value, false, new Set(), new Set());
    clarifyOptionalVerificationTests(value, handles, []);
    expect(handles.size).toBe(0); expect(value.note).toBe(note);
  });
  it.each([[{code:"assertion-missing"}], "unknown"])("keeps recipe gaps required: %j", gaps => {
    const value = {...kit(), recipe: {gaps}};
    const handles = optionalVerificationTestHandles(value, true, new Set(), new Set());
    clarifyOptionalVerificationTests(value, handles, []);
    expect(handles.size).toBe(0); expect(value.recipe.gaps).toEqual(gaps); expect(value.note).toBe(note);
  });
  it.each(["recipe ref", "mock", "include", "link"])("keeps a required %s body in the batch", kind => {
    const value = kit();
    const handles = optionalVerificationTestHandles(value, true,
      new Set(kind === "recipe ref" ? ["pkg/balance/balance_test.go"] : []),
      new Set(kind === "recipe ref" ? [] : ["optional"]));
    clarifyOptionalVerificationTests(value, handles, ["optional"]);
    expect(handles.size).toBe(0); expect(value.note).toBe(note);
  });
  it("does not call mixed required and optional test surfaces optional", () => {
    const value = kit();
    value.surfaces.push({path:"test/contract.go",handle:"required",role:"test",body:"omitted"});
    const handles = optionalVerificationTestHandles(value, true, new Set(["test/contract.go"]), new Set());
    expect([...handles]).toEqual(["optional"]);
    clarifyOptionalVerificationTests(value, handles, ["required"]);
    expect(value.note).toBe(note);
  });
  it("does not change advice if the body still rides the actual batch", () => {
    const value = kit(); clarifyOptionalVerificationTests(value, new Set(["optional"]), ["optional"]);
    expect(value.note).toBe(note);
  });
});

describe("optional test read budget", () => {
  const KIB = 1024;
  const test = (handle: string, bytes: number, path = `tests/${handle}.py`) =>
    ({ path, handle, role: "test", bytes, body: "omitted" });
  it("is 16 KiB", () => {
    expect(VERIFICATION_TEST_READ_BUDGET_BYTES).toBe(16 * KIB);
  });
  it("spends the budget in relevance order and stops at the first test that does not fit", () => {
    const value = { ...kit(), surfaces: [test("first", 9 * KIB), test("second", 6 * KIB), test("third", 4 * KIB), test("small", KIB)] };
    // 9 + 6 = 15 KiB fits; 4 KiB would reach 19; the later 1 KiB test must not jump the queue.
    expect([...testHandlesOverReadBudget(value, new Set(), new Set())]).toEqual(["third", "small"]);
  });
  it("asks for nothing when the strongest test alone exceeds the budget", () => {
    const value = { ...kit(), surfaces: [test("huge", 40 * KIB), test("tiny", 512)] };
    expect([...testHandlesOverReadBudget(value, new Set(), new Set())]).toEqual(["huge", "tiny"]);
  });
  it("lets a recipe-named test ride regardless, and counts it against the budget first", () => {
    const value = { ...kit(), surfaces: [test("a", 10 * KIB), test("named", 12 * KIB, "tests/named.py"), test("b", 3 * KIB)] };
    expect([...testHandlesOverReadBudget(value, new Set(["tests/named.py"]), new Set())]).toEqual(["a", "b"]);
  });
  it("ignores mocks, served-earlier bodies and handles that already ride for another reason", () => {
    const value = { ...kit(), surfaces: [
      { path: "t/mock.py", handle: "mock", role: "mock", bytes: 99 * KIB, body: "omitted" },
      { path: "t/held.py", handle: "held", role: "test", bytes: 99 * KIB, body: "served-earlier" },
      test("skipped", 99 * KIB),
      test("fits", 8 * KIB),
    ] };
    expect([...testHandlesOverReadBudget(value, new Set(), new Set(["skipped"]))]).toEqual([]);
  });
  it("treats an entry of unknown size as over the budget, and a missing surfaces list as empty", () => {
    const value = { ...kit(), surfaces: [{ path: "t/x.py", handle: "x", role: "test", body: "omitted" }] };
    expect([...testHandlesOverReadBudget(value, new Set(), new Set())]).toEqual(["x"]);
    expect(testHandlesOverReadBudget({ note }, new Set(), new Set()).size).toBe(0);
  });
  it("lets the existing note rewrite name only the run command once every body-less test is over budget", () => {
    const value = kit();
    value.surfaces = [test("big1", 30 * KIB), test("big2", 30 * KIB)];
    const over = testHandlesOverReadBudget(value, new Set(), new Set());
    expect(over.size).toBe(2);
    clarifyOptionalVerificationTests(value, over, []);
    expect(value.note).toContain('run "npm test" from "apps/web"');
    expect(value.note).toContain("other listed test source is optional");
    // ...but while one in-budget test still rides next_call, the note keeps pointing at next.
    const mixed = kit();
    mixed.surfaces = [test("ok", 4 * KIB), test("big", 30 * KIB)];
    const mixedOver = testHandlesOverReadBudget(mixed, new Set(), new Set());
    expect([...mixedOver]).toEqual(["big"]);
    clarifyOptionalVerificationTests(mixed, mixedOver, ["ok"]);
    expect(mixed.note).toBe(note);
  });
});
