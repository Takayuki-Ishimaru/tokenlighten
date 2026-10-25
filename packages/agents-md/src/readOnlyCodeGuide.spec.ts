import { describe, expect, it } from "vitest";
import { renderBlock, renderReadOnlyCodeBlock } from "./render.js";
import { parseSentinelBlock } from "./sentinel.js";
describe("explicit read-only code guide", () => {
  it("keeps the read protocol and requires host-enforced read-only tools", () => {
    const guide = renderReadOnlyCodeBlock();
    for (const rule of ["read-only code", "No writes, shell, or subagents", "entire user request, verbatim", 'profile:"answer"', "citation/constraint", "own cwd", "fixed lane", "task.handle", "expected_state_version", "new epoch", "Canonical arguments", "ONE targets", "scope.path", "act.answer", "exact evidence[].body", "paths/line ranges", "no re-read", "act.edit or unknown kind", "next verbatim", "refusal's retry", "user-input=ask", "none=stop", "read.receipt", "task.force_serve:true", "budget.bytes/tokens", "incomplete scope/verified absence"]) expect(guide).toContain(rule);
    expect(guide).not.toContain("tl_edit_file {");
    expect(Buffer.byteLength(guide)).toBeLessThan(2000);
    expect(parseSentinelBlock(guide)).not.toBeNull();
  });
  it("is opt-in and renders a stable versioned managed block", () => {
    const ordinary = renderBlock(undefined, "en", undefined, "compact", "code");
    const readonly = renderReadOnlyCodeBlock("test-version");
    expect(readonly).toContain("test-version-read-only-code");
    expect(readonly).toBe(renderReadOnlyCodeBlock("test-version"));
    // v119-v128 compact wording: "Single edit: prepared `handle/search/replace` …" (was "Known single edit").
    expect(ordinary).toContain("Single edit:");
    expect(ordinary).not.toContain("read-only-code");
    expect(renderBlock(undefined, "en", undefined, "compact", "code")).toBe(ordinary);
  });
});
