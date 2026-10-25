import {describe, expect, it, afterEach} from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {chunkSource, selectWindows, type ScoredWindow} from "../features/semantic-search/chunks.js";
import {goVerificationEntry, goVerificationHint} from "../util/goVerification.js";
import {projectReadBody} from "../protocol/readFamily.js";
import {requestItemLeads, explicitMultiEditRequestPaths} from "../features/task-pack/requestItems.js";

const roots: string[] = [];
function workspace(files: Record<string, string>) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-four-test-"))); roots.push(root);
  for (const [file, text] of Object.entries(files)) {fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true}); fs.writeFileSync(path.join(root, file), text);}
  return root;
}
afterEach(() => {for (const root of roots.splice(0)) fs.rmSync(root, {recursive: true, force: true});});
describe("independent explicit edit sentences", () => {
  it("retains both implementation and test paths in one compound item", () => {
    const query = "Change Compute in pkg/balance/compute.go to return cents plus one. Update pkg/balance/compute_test.go to expect 43 for Compute(42). Run the existing module test suite.";
    expect(explicitMultiEditRequestPaths(query)).toEqual(["pkg/balance/compute.go", "pkg/balance/compute_test.go"]);
  });
  it("keeps a separate explanation read-only", () => {
    expect(requestItemLeads("Explain pkg/balance/compute_test.go. Change Compute in pkg/balance/compute.go to return cents plus one.")).toEqual([
      {path: "pkg/balance/compute_test.go", lead: "read"}, {path: "pkg/balance/compute.go", lead: "edit"},
    ]);
  });
  it("does not invent writable rename destinations or override a protected path", () => {
    expect(requestItemLeads("Update src/a.ts. Rename src/b.ts to src/c.ts.").filter(row => row.lead === "edit")).toEqual([{path: "src/a.ts", lead: "edit"}]);
    expect(requestItemLeads("Update src/a.ts. Do not modify src/a.ts.")).toEqual([{path: "src/a.ts", lead: "read"}]);
  });
});

describe("bounded semantic source windows", () => {
  it("partitions Unicode, CRLF and long single lines without losing one source character", () => {
    const text = "x".repeat(1197) + "😀e\u0301".repeat(300) + "\r\n" + "next\rfinal\n";
    const source = {path: "data.txt", text, startLine: 40};
    const chunks = [...chunkSource(source)];
    expect(chunks.map(c => c.text).join("")).toBe(text);
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]!;
      expect(c.text).toBe(text.slice(c.startOffset, c.endOffset));
      expect(c.text.length).toBeLessThanOrEqual(1200);
      expect(c.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
      if (i) expect(c.startOffset).toBe(chunks[i - 1]!.endOffset);
    }
    expect(chunks[0]!.startLine).toBe(40);
    expect(chunks.at(-1)!.endLine).toBe(42);
  });
  it("selects seeds before merging, preserves gaps and uses max score instead of a sum", () => {
    const source = {path: "x.txt", text: "a\nb\nc\nd\ne\nf\ng\nh\n"};
    const window = (start: number, end: number, score: number): ScoredWindow => ({
      source, startLine: start + 1, endLine: end, startOffset: start * 2, endOffset: end * 2,
      text: source.text.slice(start * 2, end * 2), score,
    });
    const chosen = selectWindows([window(0, 2, 1), window(1, 3, .8), window(6, 8, .9), window(3, 4, -1), window(4, 5, -2)], 2);
    expect(chosen).toHaveLength(2);
    expect(chosen[0]).toMatchObject({startLine: 1, endLine: 4, score: 1});
    expect(chosen[1]).toMatchObject({startLine: 7, endLine: 8, score: .9});
    expect(chosen.some(c => c.startLine <= 6 && c.endLine >= 6)).toBe(false);
  });
  it("expands a containing function but never narrows a seed or claims a large body", () => {
    const source = {path: "x.ts", text: Array.from({length: 120}, () => "x").join("\n")};
    const seed: ScoredWindow = {source, startLine: 3, endLine: 4, startOffset: 4, endOffset: 8, text: source.text.slice(4, 8), score: 1};
    expect(selectWindows([seed], 1, new Map([[source, [{startLine: 1, endLine: 8}]]]))[0]).toMatchObject({startLine: 1, endLine: 8});
    expect(selectWindows([seed], 1, new Map([[source, [{startLine: 4, endLine: 5}]]]))[0]).toMatchObject({startLine: 3, endLine: 4});
    expect(selectWindows([seed], 1, new Map([[source, [{startLine: 1, endLine: 120}]]]))[0]).toMatchObject({startLine: 3, endLine: 4});
  });
});
describe("workspace-proven Go verification", () => {
  it("aligns implementation and test paths under the same module suite", () => {
    const root = workspace({"go.mod": "module example\n", "pkg/a/a.go": "package a\n", "pkg/b/b_test.go": "package b\n"});
    expect(goVerificationEntry(root, ["pkg/a/a.go", "pkg/b/b_test.go"])).toEqual({command: "go test ./...", dir: ""});
    expect(goVerificationHint(goVerificationEntry(root, ["pkg/a/a.go"]))).toBe("go test ./...");
  });
  it("uses the nearest nested module and does not mistake go.work for a module", () => {
    const root = workspace({"go.work": "go 1.22\nuse ./nested\n", "go.mod": "module outer\n",
      "outer.go": "package outer\n", "nested/go.mod": "module nested\n", "nested/p/x.go": "package p\n"});
    expect(goVerificationEntry(root, ["nested/p/x.go"])).toEqual({command: "go test ./...", dir: "nested"});
    expect(goVerificationHint(goVerificationEntry(root, ["nested/p/x.go"]))).toBe("cd ./nested && go test ./...");
    expect(goVerificationEntry(root, ["outer.go", "nested/p/x.go"])).toBeUndefined();
    const unproven = workspace({"go.work": "use ./a\n", "a/x.go": "package a\n"});
    expect(goVerificationEntry(unproven, ["a/x.go"])).toBeUndefined();
  });
  it("does not interpret a leading hyphen module directory as a cd option", () => {
    const root = workspace({"-module/go.mod": "module x\n", "-module/x.go": "package x\n"});
    expect(goVerificationHint(goVerificationEntry(root, ["-module/x.go"]))).toBe("cd ./-module && go test ./...");
  });
  it("keeps special cwd as data, refuses outside paths, and never builds an unsafe shell hint", () => {
    const root = workspace({"space $dir/go.mod": "module x\n", "space $dir/x.go": "package x\n"});
    const entry = goVerificationEntry(root, ["space $dir/x.go"]);
    expect(entry).toEqual({command: "go test ./...", dir: "space $dir"});
    expect(goVerificationHint(entry)).toBeUndefined();
    expect(goVerificationEntry(root, ["../foreign.go"])).toBeUndefined();
  });
});
export function duplicatedVerificationFixture() {
  const command = "cd packages/mcp-server && npm test";
  return {task: {id: "task-fixed", coverage: "complete"}, profile: "generic",
    evidence: [{path: "src/a.ts", handle: "h-a", range: "1-1", body: "export const A = 1;"}],
    decision: {kind: "act.edit", certificate: {id: "cert", obligations: ["surface-content"]},
      frontier: [{path: "src/a.ts", handle: "h-a", writable: true}]},
    verification: {available: true, command}, verify: [command]};
}
describe("exact verification hint deduplication", () => {
  it("retains authoritative verification, source and decision while removing just the duplicate", () => {
    const body = duplicatedVerificationFixture(), before = structuredClone(body);
    const result = projectReadBody("read.task_pack", body);
    expect(result.verify).toBeUndefined();
    expect((result.plan as any).verification).toEqual(body.verification);
    expect(result.evidence).toEqual(body.evidence);
    expect(result.decision).toEqual(body.decision);
    expect(body).toEqual(before);
    expect(Buffer.byteLength(JSON.stringify(result))).toBe(408);
  });
  it.each(["different", "multiple", "unavailable", "empty", "extra", "discover", "limited"])("keeps non-identical or incomplete hints: %s", variant => {
    const body: any = duplicatedVerificationFixture();
    if (variant === "different") body.verify = ["npm run typecheck"];
    if (variant === "multiple") body.verify.push("npm run typecheck");
    if (variant === "unavailable") body.verification.available = false;
    if (variant === "empty") body.verification.command = "";
    if (variant === "extra") body.verification.next = {tool: "tl_read_file", arguments: {targets: [{path: "test.ts"}]}};
    if (variant === "discover") body.decision = {kind: "discover", next: {tool: "tl_read_file", arguments: {targets: [{path: "a.ts"}]}}};
    if (variant === "limited") body.limit = {cause: "capped", omitted: ["metadata"]};
    const result = projectReadBody("read.task_pack", body);
    expect(result.verify).toEqual(body.verify);
  });
});
