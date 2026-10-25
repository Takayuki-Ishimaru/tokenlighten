import {afterEach, describe, expect, it} from "vitest";
import {createHash} from "node:crypto";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createPackFingerprintBinding, type BindablePackFingerprint} from "../features/task-pack/packFingerprintBinding.js";
import {applyPackDedupe, applyRequiredSourceCapsuleDedup, persistPackFingerprints, resetPackDedupeCache, stagePackFingerprintBinding} from "../features/task-pack/readCodeTaskPack.js";
import {runWithProtocolCall, type ProtocolCallContext} from "../protocol/envelope.js";
import {finalizeSourceCapsules, runWithSourceCapsuleCall} from "../features/task-pack/sourceCapsuleCallScope.js";
import {laneScopedKey} from "../util/laneKey.js";
import type {TaskPackResult} from "../features/task-pack/model.js";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function fixture() {
  const key = "/workspace\0lane-a", owner = {}, source = {}, body = "export const A = 1;\n";
  const row = {path: "a.ts", handle: "ha", range: "1-1", code: body};
  const entries: BindablePackFingerprint[] = [{handle: row.handle, range: row.range, hash: hash(body),
    taskBinding: undefined}];
  const slots = new Map([[key, entries]]);
  const binder = createPackFingerprintBinding(k => slots.get(k), hash);
  binder.capture(source, key, owner, entries, [row]);
  const wire = {kind: "read.task_pack", task: {id: "authenticated-task"},
    evidence: [{path: row.path, handle: row.handle, range: row.range, body}]};
  return {key, owner, source, row, entries, slots, binder, wire};
}
function commitOuterCapsules(workspace: string, text: string, binding: string): void {
  finalizeSourceCapsules(laneScopedKey(workspace), text, () => binding);
}
afterEach(resetPackDedupeCache);
describe("final-wire pack fingerprint binding", () => {
  it("binds only exact delivered bytes and commits once", () => {
    const f = fixture(), finish = f.binder.stage(f.source, f.key, f.owner, "X", f.wire.task.id)!;
    expect(f.entries[0]!.taskBinding).toBeUndefined();
    finish(JSON.stringify(f.wire), f.owner);
    expect(f.entries[0]!.taskBinding).toBe("X");
    f.entries[0]!.taskBinding = "Y";
    finish(JSON.stringify(f.wire), f.owner);
    expect(f.entries[0]!.taskBinding).toBe("Y");
  });
  it("cannot bind a same-byte concurrent replacement or a reset slot", () => {
    for (const reset of [false, true]) {
      const f = fixture(), finish = f.binder.stage(f.source, f.key, f.owner, "X", f.wire.task.id)!;
      const replacement = f.entries.map(row => ({...row}));
      if (reset) f.slots.delete(f.key); else f.slots.set(f.key, replacement);
      finish(JSON.stringify(f.wire), f.owner);
      expect(replacement[0]!.taskBinding).toBeUndefined();
      expect(f.entries[0]!.taskBinding).toBeUndefined();
    }
  });
  it.each(["body", "range", "path", "handle", "task", "refusal", "absent", "non-json"])("abstains after final-wire %s changes", field => {
    const f = fixture(), finish = f.binder.stage(f.source, f.key, f.owner, "X", f.wire.task.id)!;
    const wire: any = structuredClone(f.wire);
    if (field === "task") wire.task.id = "other-task";
    else if (field === "refusal") wire.kind = "refusal";
    else if (field === "absent") wire.evidence = [];
    else wire.evidence[0][field] = "different";
    finish(field === "non-json" ? "raw codec" : JSON.stringify(wire), f.owner);
    expect(f.entries[0]!.taskBinding).toBeUndefined();
  });
  it("rejects other owners, lane/workspace keys, cloned source objects and a discarded capability", () => {
    const f = fixture();
    expect(f.binder.stage(f.source, f.key, {}, "X", f.wire.task.id)).toBeUndefined();
    expect(f.binder.stage(f.source, "/other\0lane-a", f.owner, "X", f.wire.task.id)).toBeUndefined();
    expect(f.binder.stage(f.source, "/workspace\0lane-b", f.owner, "X", f.wire.task.id)).toBeUndefined();
    expect(f.binder.stage({}, f.key, f.owner, "X", f.wire.task.id)).toBeUndefined();
    const finish = f.binder.stage(f.source, f.key, f.owner, "X", f.wire.task.id)!;
    finish(JSON.stringify(f.wire), {});
    expect(f.entries[0]!.taskBinding).toBeUndefined();
    f.binder.reset();
    expect(f.binder.stage(f.source, f.key, f.owner, "X", f.wire.task.id)).toBeUndefined();
  });
  it("never overwrites a binding established after capture", () => {
    const f = fixture(), finish = f.binder.stage(f.source, f.key, f.owner, "X", f.wire.task.id)!;
    f.entries[0]!.taskBinding = "Y";
    finish(JSON.stringify(f.wire), f.owner);
    expect(f.entries[0]!.taskBinding).toBe("Y");
  });
  it("lets only the final delivered same-task required body dedupe", () => {
    const context: ProtocolCallContext = {tool: "tl_read_file"};
    const pack = () => ({surfaces: [{handle: "ha", path: "a.ts", range: "1-1",
      code: "export const A = 1;\n", required: true}]} as unknown as TaskPackResult);
    runWithProtocolCall(context, () => {
      const first = pack();
      persistPackFingerprints("/ws", first);
      stagePackFingerprintBinding("/ws", first, "X", "authenticated-task");
      expect(context.finalizePackFingerprintBinding).toBeTypeOf("function");
      context.finalizePackFingerprintBinding!(JSON.stringify({kind: "read.task_pack", task: {id: "authenticated-task"},
        evidence: [{handle: "ha", path: "a.ts", range: "1-1", body: first.surfaces[0]!.code}]}), context);
      const same = pack(), other = pack();
      applyPackDedupe("/ws", same, "X");
      applyPackDedupe("/ws", other, "Y");
      expect(same.surfaces[0]!.code).toBeUndefined();
      expect(same.surfaces[0]!.code_unchanged).toContain("prior pack");
      expect(other.surfaces[0]!.code).toBe("export const A = 1;\n");
    });
  });
  it.each([33, 40])("dedupes only a required source subset under a verified %i-line final-wire prefix", initialLineCount => {
    const workspace = mkdtempSync(join(tmpdir(), "tl-source-capsule-"));
    try {
      const source = Array.from({length: 165}, (_, i) => `source line ${i + 1}`).join("\n") + "\n";
      writeFileSync(join(workspace, "IssueDetail.tsx"), source);
      const schemaPath = join(workspace, "packages/shared/src/schemas");
      mkdirSync(schemaPath, {recursive: true});
      const schemaSource = Array.from({length: 50}, (_, i) => `schema line ${i + 1}`).join("\n") + "\n";
      writeFileSync(join(schemaPath, "issue.ts"), schemaSource);
      const lines = source.split("\n");
      const firstBody = lines.slice(0, initialLineCount).join("\n") + "\n";
      const initialSurface = {handle: "h-initial", path: "IssueDetail.tsx", range: "1-165",
        code: firstBody, remaining_ranges: ["41-165"]};
      const schemaBody = schemaSource.split("\n").slice(34, 40).join("\n");
      const initialSchema = {handle: "h-schema", path: "packages/shared/src/schemas/issue.ts", range: "35-40", code: schemaBody};
      const initial = {surfaces: [initialSurface, initialSchema]} as unknown as TaskPackResult;
      const context: ProtocolCallContext = {tool: "tl_read_file"};
      runWithSourceCapsuleCall(() => runWithProtocolCall(context, () => {
        persistPackFingerprints(workspace, initial);
        stagePackFingerprintBinding(workspace, initial, "same-task-binding", "task-handle");
        context.finalizePackFingerprintBinding!(JSON.stringify({kind: "read.task_pack", task: {id: "task-handle"},
          evidence: [
            {handle: "h-initial", path: "IssueDetail.tsx", range: "1-165", body: firstBody},
            {handle: "h-schema", path: "packages/shared/src/schemas/issue.ts", range: "35-40", body: schemaBody},
          ]}), context);
        commitOuterCapsules(workspace, JSON.stringify({kind: "read.task_pack", task: {id: "task-handle"}, evidence: [
          {handle: "h-initial", path: "IssueDetail.tsx", range: "1-165", body: firstBody},
          {handle: "h-schema", path: "packages/shared/src/schemas/issue.ts", range: "35-40", body: schemaBody},
        ]}), "same-task-binding");
        const required: any = {handle: "h-required", path: "IssueDetail.tsx", range: "1-28",
          code: lines.slice(0, 28).join("\n"), required: true};
        const requiredSchema: any = {handle: "h-schema-next", path: "packages/shared/src/schemas/issue.ts", range: "35-40",
          code: schemaBody, required: true};
        runWithSourceCapsuleCall(() => applyRequiredSourceCapsuleDedup(workspace,
          {surfaces: [required, requiredSchema]} as unknown as TaskPackResult, "same-task-binding"));
        expect(required.code).toBeUndefined();
        expect(required.code_unchanged).toContain("h-initial — see prior pack");
        expect(requiredSchema.code).toBeUndefined();
        expect(requiredSchema.code_unchanged).toContain("h-schema — see prior pack");
      }));
    } finally {
      rmSync(workspace, {recursive: true, force: true});
    }
  });
  it("keeps the required body for stale bytes, wrong task, forced/exempt rows, or incomplete provenance", () => {
    for (const mismatch of ["stale", "task", "transformed", "force", "exempt", "partial", "unbound",
      "missing-wire", "wrong-wire-body", "preview"] as const) {
      resetPackDedupeCache();
      const workspace = mkdtempSync(join(tmpdir(), "tl-source-capsule-"));
      try {
        const source = Array.from({length: 165}, (_, i) => `source line ${i + 1}`).join("\n") + "\n";
        const file = join(workspace, "IssueDetail.tsx");
        writeFileSync(file, source);
        const lines = source.split("\n"), priorLineCount = mismatch === "partial" ? 20 : 40;
        const firstBody = lines.slice(0, priorLineCount).join("\n") + "\n";
        const initial = {surfaces: [{handle: "h-initial", path: "IssueDetail.tsx", range: "1-165",
          code: firstBody, remaining_ranges: [`${priorLineCount + 1}-165`]}]} as unknown as TaskPackResult;
        const context: ProtocolCallContext = {tool: "tl_read_file", ...(mismatch === "preview" ? {sizePreview: true} : {})};
        runWithProtocolCall(context, () => {
          persistPackFingerprints(workspace, initial);
          stagePackFingerprintBinding(workspace, initial, "same-task-binding", "task-handle");
          context.finalizePackFingerprintBinding?.(JSON.stringify({kind: "read.task_pack", task: {id: "task-handle"},
            evidence: mismatch === "missing-wire" ? [] : [{handle: "h-initial", path: "IssueDetail.tsx", range: "1-165",
              body: mismatch === "wrong-wire-body" ? "not-the-final-body" : firstBody}]}), context);
          if (mismatch === "stale") writeFileSync(file, source.replace("source line 100", "changed line 100"));
          const code = lines.slice(0, 28).join("\n");
          const required = {handle: "h-required", path: "IssueDetail.tsx", range: "1-28",
            code: mismatch === "transformed" ? code.replace("source line 4", "edited line 4") : code,
            required: true};
          applyRequiredSourceCapsuleDedup(workspace, {surfaces: [required]} as unknown as TaskPackResult,
            mismatch === "task" ? "different-task-binding" : mismatch === "unbound" ? undefined : "same-task-binding",
            {forceServe: mismatch === "force", ...(mismatch === "exempt" ? {exempt: () => true} : {})});
          expect(required.code).toBeDefined();
          expect(required).not.toHaveProperty("code_unchanged");
        });
      } finally {
        rmSync(workspace, {recursive: true, force: true});
      }
    }
  });
  it("caps the combined retained source capsules at 18 KiB", () => {
    for (const secondSize of [9 * 1024, 9 * 1024 + 1]) {
      resetPackDedupeCache();
      const workspace = mkdtempSync(join(tmpdir(), "tl-source-capsule-total-"));
      try {
        const firstBody = "a".repeat(9 * 1024), secondBody = "b".repeat(secondSize);
        writeFileSync(join(workspace, "first.ts"), firstBody);
        writeFileSync(join(workspace, "second.ts"), secondBody);
        const initial = {surfaces: [
          {handle: "first-prior", path: "first.ts", range: "1-1", code: firstBody},
          {handle: "second-prior", path: "second.ts", range: "1-1", code: secondBody},
        ]} as unknown as TaskPackResult;
        const context: ProtocolCallContext = {tool: "tl_read_file"};
        const firstWire = JSON.stringify({kind: "read.task_pack", task: {id: "task-handle"}, evidence: [
          {handle: "first-prior", path: "first.ts", range: "1-1", body: firstBody},
          {handle: "second-prior", path: "second.ts", range: "1-1", body: secondBody},
        ]});
        runWithSourceCapsuleCall(() => {
          runWithProtocolCall(context, () => {
            persistPackFingerprints(workspace, initial);
            stagePackFingerprintBinding(workspace, initial, "same-task", "task-handle");
            context.finalizePackFingerprintBinding!(firstWire, context);
          });
          commitOuterCapsules(workspace, firstWire, "same-task");
        });
        const required = {surfaces: [
          {handle: "first-next", path: "first.ts", range: "1-1", code: firstBody, required: true},
          {handle: "second-next", path: "second.ts", range: "1-1", code: secondBody, required: true},
        ]} as unknown as TaskPackResult;
        runWithSourceCapsuleCall(() => runWithProtocolCall(context, () => {
          applyRequiredSourceCapsuleDedup(workspace, required, "same-task");
          expect(required.surfaces[0]!.code).toBeUndefined();
          if (secondSize === 9 * 1024) {
            expect(required.surfaces[1]!.code).toBeUndefined();
          } else {
            expect(required.surfaces[1]!.code).toBe(secondBody);
            expect(required.surfaces[1]!.code_unchanged).toBeUndefined();
          }
        }));
      } finally {
        rmSync(workspace, {recursive: true, force: true});
      }
    }
  });
  it("uses the call-start finalized snapshot after current-pack persistence replaces the cache", () => {
    const workspace = mkdtempSync(join(tmpdir(), "tl-source-capsule-snapshot-"));
    try {
      const body = "export const held = true;\n";
      writeFileSync(join(workspace, "held.ts"), body);
      const first = {surfaces: [{handle: "prior-handle", path: "held.ts", range: "1-1", code: body}]} as unknown as TaskPackResult;
      const context1: ProtocolCallContext = {tool: "tl_read_file"};
      const firstWire = JSON.stringify({kind: "read.task_pack", task: {id: "task-handle"},
        evidence: [{handle: "prior-handle", path: "held.ts", range: "1-1", body}]});
      runWithSourceCapsuleCall(() => {
        runWithProtocolCall(context1, () => {
          applyPackDedupe(workspace, first, "same-task");
          persistPackFingerprints(workspace, first, "same-task");
        });
        commitOuterCapsules(workspace, firstWire, "same-task");
      });

      const nextSurface: any = {handle: "next-handle", path: "held.ts", range: "1-1", code: body, required: false};
      const next = {surfaces: [nextSurface]} as unknown as TaskPackResult;
      const context2: ProtocolCallContext = {tool: "tl_read_file"};
      runWithSourceCapsuleCall(() => runWithProtocolCall(context2, () => {
        applyPackDedupe(workspace, next, "same-task");
        persistPackFingerprints(workspace, next, "same-task");
        applyRequiredSourceCapsuleDedup(workspace, next, "same-task");
        expect(nextSurface.code).toBeUndefined();
        expect(nextSurface.code_unchanged).toContain("prior-handle — see prior pack");
      }));
    } finally {
      rmSync(workspace, {recursive: true, force: true});
    }
  });
  it("does not capture a sizing projection", () => {
    const context: ProtocolCallContext = {tool: "tl_read_file", sizePreview: true};
    runWithProtocolCall(context, () => {
      const result = {surfaces: [{handle: "ha", path: "a.ts", range: "1-1", code: "a", required: true}]} as unknown as TaskPackResult;
      persistPackFingerprints("/ws", result);
      stagePackFingerprintBinding("/ws", result, "X", "authenticated-task");
      expect(context.finalizePackFingerprintBinding).toBeUndefined();
    });
  });
});
