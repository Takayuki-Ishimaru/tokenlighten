import { describe, expect, it } from "vitest";
import { renderPortableCodeBlock, renderCompactBlock } from "./render.js";
import { parseSentinelBlock } from "./sentinel.js";
describe("portable code bootstrap", () => {
  it("covers read, write, continuation and fail-closed routing without client/model names", () => {
    const guide = renderPortableCodeBlock();
    for (const s of ["entire user request, verbatim", "cwd", "In parallel, set it on call 1 and never change it", "task.handle", "expected_state_version", "act.answer/act.edit", "evidence[].body", "Unknown kind", "next verbatim", "refusal.retry", "read.receipt", "task.force_serve:true", 'task.pull:"closure"', "omit when reading targets", "allowPathFallback:false", "--allow-write", "edit.state_unknown", "edit.rolled_back", "operation_id", "recipe.gaps", "its result is unusable", "scope is incomplete/absent; return to TL when usable", "Use TL for every workspace read, search and edit", "later reads: targets[] (path|handle,range), no query", "one literal identifier per queries[] entry, never a phrase", "native read/search/edit is allowed under the fallback conditions above", "Same request's later calls: returned task.id as task.handle, never epoch:\"new\""]) expect(guide).toContain(s);
    // v116: the continuation line also forbids re-opening the task (bench 6t-2 T13 rep0).
    expect(guide).not.toContain("Continue returned task.id as task.handle");
    expect(guide).not.toMatch(/Copilot|Codex|Claude|GPT|Qwen/);
    expect(Buffer.byteLength(guide)).toBeLessThan(Buffer.byteLength(renderCompactBlock()) * .8);
    expect(parseSentinelBlock(guide).block).toBeDefined();
  });
  it("hashes content independently of version", () => {
    const hash = (v: string) => renderPortableCodeBlock(v).match(/tl-instructions-sha256: ([a-f0-9]{64})/)![1];
    expect(hash("2026-10-16-v1")).toBe(hash("2026-10-16-v2"));
  });
});
