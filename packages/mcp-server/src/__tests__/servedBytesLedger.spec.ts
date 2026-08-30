import { describe, expect, it, beforeEach } from "vitest";
import {
  recordServedBytes,
  resetPackServeLogForTest,
  servedBytesLedgerSnapshot,
} from "../util/packServeLog.js";
import { emitFinalizedPayload } from "../protocol/emit.js";
import { noteServedBytesSource, runWithProtocolCall } from "../protocol/envelope.js";
import type { ProtocolCallContext } from "../protocol/envelope.js";

describe("B-6 served-bytes novelty ledger", () => {
  beforeEach(() => resetPackServeLogForTest());

  it("deduplicates by task epoch and lane, with force_serve as the only bypass", () => {
    const base = {
      workspaceRoot: "/workspace",
      epoch: "epoch-1",
      lane: "track-b-luna",
      bytes: 120,
      digest: "digest-a",
      source: "fresh" as const,
    };
    expect(recordServedBytes(base).novel).toBe(true);
    expect(recordServedBytes({ ...base, source: "receipt" }).novel).toBe(false);
    expect(recordServedBytes({ ...base, source: "replay", forceServe: true }).novel).toBe(true);
    expect(recordServedBytes({ ...base, lane: "other-lane" }).novel).toBe(true);
    expect(recordServedBytes({ ...base, epoch: "epoch-2" }).novel).toBe(true);
    expect(servedBytesLedgerSnapshot("/workspace", "epoch-1", "track-b-luna")).toHaveLength(1);
    expect(servedBytesLedgerSnapshot("/workspace", "epoch-1", "track-b-luna")[0]?.forced).toBe(true);
  });

  it("connects receipt, budget-shed, replay, and verification-kit sources at the real emission funnel", () => {
    const context = (qref?: string): ProtocolCallContext => ({
      tool: "read_file",
      workspace: "/runtime-workspace",
      args: { taskEpoch: "runtime-epoch", lane: "track-b-luna", ...(qref ? { qref } : {}) },
    });
    emitFinalizedPayload({ v: 1, kind: "read.text", evidence: [{ handle: "h-runtime", path: "src/runtime.ts", range: "1-1", body: "fresh-runtime" }] }, "read.text", context());
    emitFinalizedPayload({ v: 1, kind: "read.receipt", receipt: { receipt: "kit-unchanged", kit_ref: "kit-runtime" } }, "read.receipt", context());
    emitFinalizedPayload({ v: 1, kind: "read.text", evidence: [{ handle: "h-runtime-replay", path: "src/replay.ts", range: "1-1", body: "replay-runtime" }] }, "read.text", context("q-runtime"));
    emitFinalizedPayload({ v: 1, kind: "edit.applied", core: { paths: ["src/runtime.ts"], counts: { files: 1, edits: 1 }, workspace: { fingerprint: "fp", scope: "served-evidence", evidence_files: 1, inventory_files: 1, inventory_complete: true } }, applied: [{ path: "src/runtime.ts", range: "1-1" }], verification: { status: "ready" }, marker: "kit-runtime" }, "edit.applied", context());
    // B-F5: this fixture (8 x 600-char evidence bodies, ~4.9 KB natural,
    // against a 1000 B budgetOverrideBytes) MUST force the budget ladder to
    // shed at least one record — the non-vacuity assertion right after this
    // call proves that happened rather than assuming it, so a future change
    // to the ladder/fixture that stops shedding fails loudly here instead
    // of silently degrading this into an unlabeled "fresh" entry.
    const shedResult = emitFinalizedPayload({ v: 1, kind: "read.task_pack", task: { id: "shed-task", coverage: "complete", replay: "q-shed" }, profile: "generic", evidence: Array.from({ length: 8 }, (_, i) => ({ handle: `h-shed-${i}`, path: `src/shed-${i}.ts`, range: "1-20", body: "T".repeat(600) })), decision: { kind: "done" } }, "read.task_pack", context(), { budgetOverrideBytes: 1000 });
    const shedText = shedResult.content[0]?.text ?? "";
    expect(
      Buffer.byteLength(shedText, "utf8"),
      `fixture no longer forces the ladder to shed at a 1000 B budget: ${shedText.slice(0, 300)}`,
    ).toBeLessThan(8 * 600);

    const entries = servedBytesLedgerSnapshot("/runtime-workspace", "runtime-epoch", "track-b-luna");
    const sources = entries.map((entry) => entry.source);
    // B-F5 (2026-08-28): "trim" was renamed to "budget-shed" because it
    // named the wrong mechanism — `noteEmission`'s `trimmed` flag is
    // exactly "this call's own budget ladder shed at least one record"
    // (emit.ts), unrelated to the separate post-ready trim/dedup path
    // (state/session.ts's `postReadyTrim`). Asserted with `toContain`, not
    // `arrayContaining`, specifically so this source classification cannot
    // silently stop firing again the way the old "trim" label did (this
    // exact assertion previously never required "trim" to appear at all).
    expect(sources, JSON.stringify(entries)).toContain("budget-shed");
    expect(sources).toEqual(expect.arrayContaining(["fresh", "receipt", "replay", "verification-kit", "budget-shed"]));
  });

  it("records explicit trim and dedup producer provenance at the emission funnel", () => {
    const context: ProtocolCallContext = {
      tool: "read_file",
      workspace: "/runtime-source",
      args: { taskEpoch: "source-epoch", lane: "track-e" },
    };
    runWithProtocolCall(context, () => {
      noteServedBytesSource("post-ready-trim");
      return emitFinalizedPayload(
        { v: 1, kind: "read.text", evidence: [{ handle: "h-trim", path: "src/large.ts", range: "1-20", body: "trimmed fixture evidence" }] },
        "read.text",
        context,
      );
    });
    runWithProtocolCall(context, () => {
      noteServedBytesSource("dedup");
      return emitFinalizedPayload(
        { v: 1, kind: "read.text", evidence: [{ handle: "h-dedup", path: "src/large.ts", range: "1-20", body: "dedup fixture evidence" }] },
        "read.text",
        context,
      );
    });
    const sources = servedBytesLedgerSnapshot("/runtime-source", "source-epoch", "track-e").map((entry) => entry.source);
    expect(sources).toEqual(["post-ready-trim", "dedup"]);
  });

  it("keeps served bytes separate from the proof/pack span ledger", () => {
    const result = recordServedBytes({
      workspaceRoot: "/workspace",
      epoch: "epoch-1",
      lane: "track-b-luna",
      bytes: 10,
      digest: "digest-b",
      source: "verification-kit",
    });
    expect(result.entry.source).toBe("verification-kit");
    expect(result.entry).not.toHaveProperty("obligation");
    expect(result.entry).not.toHaveProperty("proof");
  });
});
