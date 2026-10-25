import {describe, expect, it} from "vitest";
import {createPriorBodyRestoration} from "../features/task-pack/priorBodyRestoration.js";
const source = () => ({path: "src/a.ts", handle: "ha", range: "1-2", code: "export const a = 1;\n",
  code_unchanged: "ha — see prior pack"} as Record<string, unknown>);
describe("authenticated prior body restoration", () => {
  it("strips an identical restored body only on the captured object", () => {
    const helper = createPriorBodyRestoration(), row = source();
    helper.capture(row, row.code_unchanged as string);
    const clone = {...row};
    helper.strip([row, clone]);
    expect(row.code).toBeUndefined();
    expect(clone.code).toBeDefined();
    expect(row.code_unchanged).toBe("ha — see prior pack");
  });
  it.each([
    ["path", "src/b.ts"], ["handle", "hb"], ["range", "2-3"],
    ["code", "changed"], ["code_unchanged", "unproven"],
    ["remaining_ranges", ["2-2"]], ["appended_windows", [{range: "3-3"}]],
    ["content_completeness", "partial"],
  ])("keeps a body after %s changes", (field, value) => {
    const helper = createPriorBodyRestoration(), row = source();
    helper.capture(row, row.code_unchanged as string);
    row[field as string] = value;
    helper.strip([row]);
    expect(row.code).toBeDefined();
  });
  it("keeps unproven, reset and force-served bodies", () => {
    const helper = createPriorBodyRestoration(), row = source();
    helper.strip([row]); expect(row.code).toBeDefined();
    helper.capture(row, row.code_unchanged as string);
    helper.strip([row], true); expect(row.code).toBeDefined();
    helper.reset();
    helper.strip([row]); expect(row.code).toBeDefined();
  });
});
