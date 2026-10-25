import { describe, expect, it, vi } from "vitest";
import * as parser from "../skeleton/treeSitter.js";
import { analyzeEnumConsumerContext, boundEnumConsumerContexts, type EnumConsumerContext } from "../features/task-pack/auxiliaryEnumContexts.js";

const analyze = (body: string, path = "src/consumer.ts", subjects = ["Priority"], rank = 0) =>
  analyzeEnumConsumerContext(path, body, subjects, rank);
const source = (method = "values") => `import { Priority } from './priority';\n\nconst values = Object.${method}(Priority);`;
async function required(body: string, path = "src/consumer.ts", rank = 0): Promise<EnumConsumerContext> {
  const plan = await analyze(body, path, ["Priority"], rank);
  expect(plan).toBeDefined();
  return plan!;
}
function texts(plan: EnumConsumerContext): string {
  return plan.windows.map(window => window.text).join("\n");
}

describe("analyzeEnumConsumerContext: bounded source context only", () => {
  it.each(["values", "keys", "entries"])("captures named import and Object.%s", async method => {
    const body = source(method), plan = await required(body);
    expect(plan.binding).toBe("value");
    expect(plan.pairs[0]?.accessor).toBe(method);
    expect(plan.windows.map(window => [window.start, window.end])).toEqual([[1, 1], [3, 3]]);
    expect(boundEnumConsumerContexts([plan], new Map([[plan.path, body]]), new Set())).toEqual([plan]);
  });
  it("follows a named import alias and keeps the outer runtime expression", async () => {
    const plan = await required(`import { Priority as P } from './priority';\n\nconst choices = Object.values(P).map(p => ({ value: p, label: p }));`);
    expect(plan.pairs[0]).toMatchObject({ subject: "Priority", local: "P", binding: "value" });
    expect(texts(plan)).toContain(".map(p => ({ value: p, label: p }))");
  });
  it.each([
    "import type { Priority } from './priority';",
    "import { type Priority } from './priority';",
    "import /* comment */ type { Priority } from './priority';",
    "import { type/* comment */Priority } from './priority';",
  ])("marks type-only imports explicitly: %s", async declaration => {
    const plan = await required(`${declaration}\nObject.values(Priority);`);
    expect(plan.binding).toBe("type-only");
    expect(plan.pairs[0]?.binding).toBe("type-only");
    expect(Object.keys(plan)).not.toContain("complete");
  });
  it("does not infer dynamic behavior from Record, strings or comments", async () => {
    expect(await analyze(`import type {Priority} from './priority';\ntype Counts = Record<Priority, number>;\n// Object.values(Priority)\nconst message = 'Object.values(Priority)';`)).toBeUndefined();
  });
  it.each([
    "function f(Priority: string) { return Object.values(Priority); }",
    "function f({x: Priority}: any) { return Object.values(Priority); }",
    "const f = (Priority: any) => Object.values(Priority);",
    "const f = Priority => Object.values(Priority);",
    "function unrelated(Priority: string) {}\nObject.values(Priority);",
    "const Priority = {}; Object.values(Priority);",
    "class Priority {}\nObject.values(Priority);",
    "try {} catch (Priority) { Object.values(Priority); }",
    "Priority = other; Object.values(Priority);",
  ])("abstains on same-local declarations or writes: %s", async expression => {
    expect(await analyze(`import {Priority} from './priority';\n${expression}`)).toBeUndefined();
  });
  it.each([
    "const Object = helper; Object.values(Priority);",
    "function f(Object: any) { return Object.values(Priority); }",
    "Object.values = helper; Object.values(Priority);",
    "import {Object} from './helper'; Object.values(Priority);",
    "import Object = require('./helper'); Object.values(Priority);",
    "namespace Object { export const values = (x: any) => []; } Object.values(Priority);",
    "for (Object of items) { Object.values(Priority); }",
  ])("abstains on Object shadowing or mutation: %s", async expression => {
    expect(await analyze(`import {Priority} from './priority';\n${expression}`)).toBeUndefined();
  });
  it("handles JavaScript formal-parameter shadowing", async () => {
    expect(await analyze(`import {Priority} from './priority';\nfunction f(Priority) { return Object.values(Priority); }`, "consumer.js")).toBeUndefined();
  });
  it("abstains on duplicate local imports", async () => {
    expect(await analyze(`import {Priority} from './a';\nimport {Other as Priority} from './b';\nObject.values(Priority);`)).toBeUndefined();
  });
  it.each([
    "Object.values(Priority", "Object.values(Priority, extra);", "Object.values(...Priority);",
    "Object?.values(Priority);", "Object['values'](Priority);", "Object.values(Other);",
  ])("abstains on malformed/unsupported calls: %s", async expression => {
    expect(await analyze(`import {Priority} from './priority';\n${expression}`)).toBeUndefined();
  });
  it("splits a complete enclosing if into exact windows of at most eight lines", async () => {
    const body = ["import {Priority} from './priority';", "", "function check(raw: string) {", "  if (raw) {",
      "    const values = Object.values(Priority);", "    if (!values.includes(raw as any)) {", "      throw new Error(",
      "        'invalid',", "      );", "    }", "    return raw;", "  }", "}"].join("\n");
    const plan = await required(body);
    expect(plan.pairs[0]?.useWindows.map(window => [window.start, window.end])).toEqual([[4, 11], [12, 12]]);
    expect(plan.windows.every(window => window.end - window.start < 8)).toBe(true);
    expect(boundEnumConsumerContexts([plan], new Map([[plan.path, body]]), new Set())).toEqual([plan]);
  });
  it("keeps TSX callbacks and source text verbatim, including Unicode and CRLF", async () => {
    const body = "// 日本語 😀\r\nimport {Priority as P} from './priority';\r\n\r\nexport function Picker() {\r\n return <ul>{Object.values(P).map(p => (\r\n   <li key={p}>{p}</li>\r\n ))}</ul>;\r\n}";
    const plan = await required(body, "src/Picker.tsx");
    expect(texts(plan)).toContain("<li key={p}>{p}</li>");
    for (const window of plan.windows) expect(window.text).toBe(body.split("\n").slice(window.start - 1, window.end).join("\n"));
  });
  it("includes context without claiming no-change when a static map also exists", async () => {
    const plan = await required(`${source()}\nconst counts = {LOW: 0, HIGH: 0};`);
    expect(plan).not.toHaveProperty("noEditRequired");
    expect(plan).not.toHaveProperty("fullyReviewed");
  });
  it("abstains on a multi-line import exceeding eight lines", async () => {
    expect(await analyze(["import {", ...Array(7).fill("// spacer"), "Priority", "} from './priority';", "Object.values(Priority);"].join("\n"))).toBeUndefined();
  });
  it("abstains on an outer expression exceeding sixteen lines", async () => {
    expect(await analyze(`import {Priority} from './priority';\nconst x = Object.values(Priority).map(p => ({\n${Array(17).fill("// context").join("\n")}\nvalue: p\n}));`)).toBeUndefined();
  });
  it("abstains when the existing parser cannot supply a syntax tree", async () => {
    const unavailable = vi.spyOn(parser, "withTreeSitterRoot").mockResolvedValueOnce(undefined);
    try { expect(await analyze(source())).toBeUndefined(); }
    finally { unavailable.mockRestore(); }
  });
  it("bounds source bytes and AST nodes", async () => {
    expect(await analyze(source() + "\n//" + "x".repeat(96 * 1024))).toBeUndefined();
    expect(await analyze(source() + "\n" + "x();".repeat(3000))).toBeUndefined();
  });
  it.each(["/absolute.ts", "../escape.ts", "a/../b.ts", "C:/drive.ts", "a\\b.ts", "consumer.py"])("rejects unsafe/unsupported path %s", async path => {
    expect(await analyze(source(), path)).toBeUndefined();
  });
});

describe("boundEnumConsumerContexts", () => {
  it("rejects stale sources, altered source windows, missing import/use pairs and primary paths", async () => {
    const body = source(), plan = await required(body);
    expect(boundEnumConsumerContexts([plan], new Map([[plan.path, body + "\n"]]), new Set())).toEqual([]);
    expect(boundEnumConsumerContexts([plan], new Map([[plan.path, body]]), new Set([plan.path]))).toEqual([]);
    const incomplete = { ...plan, windows: plan.windows.slice(1) };
    const altered = { ...plan, windows: plan.windows.map((window, i) => i === 0 ? { ...window, text: "invented" } : window) };
    const noUses = { ...plan, pairs: plan.pairs.map(pair => ({ ...pair, useWindows: [] })) };
    for (const invalid of [incomplete, altered, noUses]) expect(boundEnumConsumerContexts([invalid], new Map([[plan.path, body]]), new Set())).toEqual([]);
  });
  it("admits at most four distinct paths, in stable rank order without mutating inputs", async () => {
    const body = source();
    const plans = await Promise.all(Array.from({ length: 6 }, (_, i) => required(body, `src/c${i}.ts`, 5 - i)));
    const before = JSON.stringify(plans);
    const result = boundEnumConsumerContexts([...plans, plans[0]!], new Map(plans.map(plan => [plan.path, body])), new Set());
    expect(result.map(plan => plan.path)).toEqual(["src/c5.ts", "src/c4.ts", "src/c3.ts", "src/c2.ts"]);
    expect(JSON.stringify(plans)).toBe(before);
  });
  it("enforces twelve windows without accepting a partial path bundle", async () => {
    const body = "import {Priority} from './priority';\n\n" + ["values", "keys", "entries", "values"].map((method, i) => `const x${i} = Object.${method}(Priority);\n\n`).join("");
    const plans = await Promise.all([0, 1, 2].map(i => required(body, `src/c${i}.ts`, i)));
    expect(plans[0]?.windows).toHaveLength(5);
    const result = boundEnumConsumerContexts(plans, new Map(plans.map(plan => [plan.path, body])), new Set());
    expect(result).toHaveLength(2);
    expect(result.flatMap(plan => plan.windows)).toHaveLength(10);
  });
  it("enforces raw UTF-8 byte budget and continues past a nonfitting bundle", async () => {
    const heavy = `${source()} // ${"界".repeat(330)}`;
    const light = source();
    const plans = await Promise.all([required(heavy, "src/a.ts", 0), required(heavy, "src/b.ts", 1), required(light, "src/c.ts", 2)]);
    const selected = boundEnumConsumerContexts(plans, new Map([["src/a.ts", heavy], ["src/b.ts", heavy], ["src/c.ts", light]]), new Set());
    expect(selected.map(plan => plan.path)).toEqual(["src/a.ts", "src/c.ts"]);
    expect(selected.flatMap(plan => plan.windows).reduce((sum, window) => sum + Buffer.byteLength(window.text), 0)).toBeLessThanOrEqual(2048);
  });
  it("accepts exactly 2048 source bytes and rejects 2049 atomically", async () => {
    const prefix = source() + " // ";
    const base = await required(prefix);
    const baseBytes = base.windows.reduce((sum, window) => sum + Buffer.byteLength(window.text), 0);
    const exact = prefix + "x".repeat(2048 - baseBytes);
    const exactPlan = await required(exact);
    expect(boundEnumConsumerContexts([exactPlan], new Map([[exactPlan.path, exact]]), new Set())).toHaveLength(1);
    const over = exact + "x", overPlan = await required(over);
    expect(boundEnumConsumerContexts([overPlan], new Map([[overPlan.path, over]]), new Set())).toEqual([]);
  });
  it("rejects out-of-bounds ranges and a false aggregate binding", async () => {
    const body = source(), plan = await required(body);
    const invalid = { ...plan, windows: plan.windows.map((window, i) => i === 0 ? {...window, start: 0} : window) };
    expect(boundEnumConsumerContexts([invalid], new Map([[plan.path, body]]), new Set())).toEqual([]);
    expect(boundEnumConsumerContexts([{...plan, binding: "type-only"}], new Map([[plan.path, body]]), new Set())).toEqual([]);
  });
  it("keeps representative service, form, filter and stats contexts with no private-fixture dependency", async () => {
    const files = new Map([
      ["src/service.ts", `import {Priority} from './priority';\nexport function validate(raw: string) {\n if (raw) {\n  const all = Object.values(Priority);\n  if (!all.includes(raw as any)) throw new Error('invalid');\n }\n}`],
      ["src/Form.tsx", `import {Priority} from './priority';\nexport function Form() {\n return <Select options={Object.values(Priority).map(p => ({value: p, label: p}))} />;\n}`],
      ["src/Filters.tsx", `import {Priority as P} from './priority';\nexport function Filters() {\n return <div>{Object.values(P).map(p => <button key={p}>{p}</button>)}</div>;\n}`],
      ["src/Stats.tsx", `import {Priority} from './priority';\nexport function Stats({stats}: any) {\n return <ul>{Object.values(Priority).map(p => <li key={p}>{stats.byPriority[p] ?? 0}</li>)}</ul>;\n}`],
    ]);
    const plans = await Promise.all([...files].map(([path, body], rank) => required(body, path, rank)));
    const selected = boundEnumConsumerContexts(plans, files, new Set());
    expect(selected).toHaveLength(4);
    expect(texts(selected[3]!)).toContain("stats.byPriority[p] ?? 0");
  });
});
