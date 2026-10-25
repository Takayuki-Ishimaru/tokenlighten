import {describe, expect, it} from "vitest";
import {changeScopeFollowupTarget} from "../features/task-pack/readCodeTaskPack.js";
import {recordBudgetDeferredSurface} from "../features/task-pack/changeScopeContinuation.js";
import type {TaskPackResult} from "../features/task-pack/model.js";

describe("change scope continuation", () => {
  const rows = [
    {handle: "a", path: "badge.ts", range: "1-40", required: true, status: "ready", action: "edit", role: "ui"},
    {handle: "b", path: "admin.ts", range: "1-80", required: true, status: "needs-context", action: "edit", role: "api"},
    {handle: "c", path: "schema.ts", range: "9-15", required: false, status: "ready", action: "review", role: "contract"},
    {handle: "d", path: "tokens.css", range: "1-50", required: true, status: "ready", action: "edit", role: "style"},
  ];
  const pack = (obligations = rows, surfaces = rows.map(row => ({...row, code: "held", remaining_ranges: row.handle === "b" ? ["41-80"] : undefined}))) =>
    ({surfaces, missing: [], change_contract: {obligations}} as unknown as TaskPackResult);
  it("carries partial, held edit and optional review scopes without substituting another same-role file", () => {
    const result = pack(), before = JSON.stringify(result);
    const next = changeScopeFollowupTarget(result);
    expect(next).toEqual({tool: "tl_read_file", arguments: {targets: rows.map(({path, range, action}) => ({path, range, ...(action === "review" ? {purpose: "edit-context: retained review"} : {})}))}});
    expect(JSON.stringify(result)).toBe(before);
  });
  it("uses paths for remaining windows outside a narrow handle", () => {
    const result = pack();
    result.surfaces[1]!.remaining_ranges = ["81-90"];
    expect(changeScopeFollowupTarget(result)?.arguments["targets"]).toContainEqual({path: "admin.ts", range: "1-90"});
    result.surfaces[1]!.remaining_ranges = ["10000-10010"];
    expect(changeScopeFollowupTarget(result)?.arguments["targets"]).toContainEqual({path: "admin.ts", ranges: ["1-80", "10000-10010"]});
  });
  it("advances a partial body to its exact remaining windows while retaining ready and review paths", () => {
    const result = pack();
    const partial = result.surfaces[1]!;
    Object.assign(partial, {code: Array.from({length: 40}, (_, index) => `line ${index + 1}`).join("\n"), content_completeness: "partial"});
    expect(changeScopeFollowupTarget(result)?.arguments["targets"]).toEqual([
      {path: "badge.ts", range: "1-40"}, {path: "admin.ts", range: "41-80"},
      {path: "schema.ts", range: "9-15", purpose: "edit-context: retained review"},
      {path: "tokens.css", range: "1-50"},
    ]);
    partial.remaining_ranges = ["11-20", "61-80"];
    expect(changeScopeFollowupTarget(result)?.arguments["targets"]).toContainEqual({path: "admin.ts", ranges: ["11-20", "61-80"]});
    partial.remaining_ranges = ["10000-10010"];
    expect(changeScopeFollowupTarget(result)?.arguments["targets"]).toContainEqual({path: "admin.ts", ranges: ["1-80", "10000-10010"]});
    partial.code = undefined;
    partial.remaining_ranges = ["41-80"];
    expect(changeScopeFollowupTarget(result)?.arguments["targets"]).toContainEqual({path: "admin.ts", range: "1-80"});
  });
  it("includes only inventoried budget-deferred addresses in the same retained scope", () => {
    const result = pack(rows.map(row => ({...row, status: "ready"})));
    result.missing = ["dropped-by-byte-budget:extra.css (re-request via handle)", "dropped-by-byte-budget:unknown.css (re-request via handle)"];
    result.frontier_index = [{path: "extra.css", role: "style", handle: "hdeferred"}, {path: "unrelated.ts", role: "domain", handle: "hunrelated"}];
    const targets = changeScopeFollowupTarget(result)?.arguments["targets"] as unknown[];
    expect(targets).toHaveLength(5);
    expect(targets.at(-1)).toEqual({handle: "hdeferred", purpose: "edit-context: retained review"});
    const before = JSON.stringify(result);
    recordBudgetDeferredSurface(result, {path: "extra.css", handle: "hdeferred", range: "1-20", action: "review"});
    expect(JSON.stringify(result)).toBe(before);
    expect((changeScopeFollowupTarget(result)?.arguments["targets"] as unknown[]).at(-1)).toEqual({path: "extra.css", range: "1-20", purpose: "edit-context: retained review"});
    recordBudgetDeferredSurface(result, {path: "extra.css", handle: "hdeferred", range: "1-20", action: "edit"});
    expect((changeScopeFollowupTarget(result)?.arguments["targets"] as unknown[]).at(-1)).toEqual({path: "extra.css", range: "1-20"});
    expect(JSON.stringify(targets)).not.toContain("unknown.css");
    expect(JSON.stringify(targets)).not.toContain("hunrelated");
  });
  it.each(["missing", "bodyless", "partial"])("retains required readonly proof when %s without granting an edit", mode => {
    const result = pack(rows.map(row => ({...row, status: "ready"})));
    const origin = {path: "schema.ts", handle: "c", range: "9-15", action: "review" as const, evidenceRequired: true};
    recordBudgetDeferredSurface(result, origin);
    const schema = result.surfaces[2]!;
    if (mode === "missing") {
      result.surfaces.splice(2, 1);
      result.change_contract!.obligations.splice(2, 1);
    } else if (mode === "bodyless") schema.code = undefined;
    else Object.assign(schema, {content_completeness: "partial", remaining_ranges: ["12-15"]});
    const targets = changeScopeFollowupTarget(result)?.arguments["targets"] as Array<Record<string, unknown>>;
    expect(targets.some(row => row.path === "badge.ts")).toBe(true);
    expect(targets.find(row => row.path === "schema.ts")).toMatchObject({purpose: "edit-context: retained enum-derived review"});
    expect(result.change_contract!.obligations.filter(row => row.path === "schema.ts").every(row => row.action === "review" && !row.required)).toBe(true);
    schema.code = "held";
    delete schema.content_completeness;
    delete schema.remaining_ranges;
    if (mode !== "missing") expect(changeScopeFollowupTarget(result)).toBeUndefined();
  });
  it("does not mint a scope for a ready contract or unresolved obligation address", () => {
    expect(changeScopeFollowupTarget(pack(rows.map(row => ({...row, status: "ready"}))))).toBeUndefined();
    const missing = pack(); missing.surfaces.splice(1, 1);
    expect(changeScopeFollowupTarget(missing)).toBeUndefined();
  });
});
