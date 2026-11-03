/**
 * compactionEpoch.spec.ts — the compaction reset (2026-11-03,
 * state/compactionEpoch.ts).
 *
 * A session serves a range; the marker the agent hosts' hooks write changes;
 * the same read now returns content instead of a held `read.receipt`; task
 * handles, the task itself and edit authority survive. The check is one
 * `stat` per tool call, keyed by workspace root, with no client id involved.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMPACTION_MARKER_RELATIVE_PATH } from "@tokenlighten/types";

import { callTool } from "../server.js";
import {
  compactionMarkerSignature,
  noteCompactionMarker,
  resetCompactionMarkerForTest,
  resetServedContentClaims,
} from "../state/compactionEpoch.js";
import { clearServedContentState, getSession, recordServedRange, resetAll, runWithSessionLane, servedRangeReceipt } from "../state/session.js";
import { handleTable, shaOfText } from "../util/handles.js";

const tmpDirs: string[] = [];

function mkWs(tag: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), `.tl-compaction-${tag}-`)));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  return dir;
}

function write(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function workspace(tag: string): string {
  const ws = mkWs(tag);
  for (const name of ["s1", "s2"]) write(ws, `src/${name}.ts`, `export const TOKEN_${name} = 1;\nexport const other_${name} = 2;\n`);
  for (const name of ["big1", "big2"]) {
    write(ws, `src/${name}.ts`, `export const TOKEN_${name} = 1;\n`
      + Array.from({ length: 30 }, (_, i) => `export function ${name}_${i}(): number {\n  return ${i};\n}`).join("\n") + "\n");
  }
  write(ws, "src/fence_anchor.ts", "export function anchorFn(x: number): number {\n  // anchor\n  return x;\n}\n");
  return ws;
}

/** What `tl hook pre-compact` writes, with a body whose size differs per epoch. */
function bumpMarker(ws: string, epoch: number): void {
  const target = path.join(ws, COMPACTION_MARKER_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${epoch}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, epoch, at: new Date().toISOString(), event: "pre-compact", client: "spec", pad: "x".repeat(epoch) })}\n`);
  fs.renameSync(temporary, target);
}

async function read(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reply = await callTool("tl_read_file", args);
  return JSON.parse(reply.content[0]!.text) as Record<string, unknown>;
}

beforeEach(() => {
  resetAll();
  resetCompactionMarkerForTest();
});

afterEach(() => {
  resetAll();
  resetCompactionMarkerForTest();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("compaction reset through the tool entry point", () => {
  it("a held window is served again once the marker changed; handles, the task and edit authority survive", async () => {
    const ws = workspace("serve");
    const outline = await read({ targets: [{ path: "src/s1.ts" }], content: "outline", cwd: ws });
    const outlineHandle = String((outline["outline"] as Record<string, unknown> | undefined)?.["handle"]
      ?? (outline["evidence"] as Array<Record<string, unknown>> | undefined)?.[0]?.["handle"] ?? "");
    expect(outlineHandle, `expected an outline handle: ${JSON.stringify(outline).slice(0, 300)}`).not.toBe("");
    const pack = await read({
      query: "Update anchorFn so the anchor returns a scaled value.",
      targets: [{ path: "src/fence_anchor.ts" }], task: { profile: "generic", epoch: "new" }, cwd: ws,
    });
    const taskId = String((pack["task"] as Record<string, unknown> | undefined)?.["id"] ?? "");
    expect(taskId, `expected a task id: ${JSON.stringify(pack).slice(0, 300)}`).not.toBe("");

    const batch = await read({ targets: [{ path: "src/big1.ts" }, { path: "src/big2.ts" }], content: "full", cwd: ws });
    expect(batch["kind"]).toBe("read.batch");
    const sha = shaOfText(fs.readFileSync(path.join(ws, "src/big1.ts"), "utf8"));
    expect(servedRangeReceipt(ws, "src/big1.ts", sha, 2, 6, 92)).toBeDefined();
    const held = await read({ targets: [{ path: "src/big1.ts", range: "2-6" }], cwd: ws });
    expect(held["kind"], `expected a receipt, got ${JSON.stringify(held).slice(0, 240)}`).toBe("read.receipt");

    const handlesBefore = handleTable.size();
    const authorityBefore = [...getSession(ws).admissibleEditPaths];
    expect(authorityBefore).toContain("src/big1.ts");

    // The host compacted: its hook rewrote the marker. The next tool call notices.
    bumpMarker(ws, 1);
    const served = await read({ targets: [{ path: "src/big1.ts", range: "2-6" }], cwd: ws });
    expect(served["kind"], `expected content, got ${JSON.stringify(served).slice(0, 240)}`).not.toBe("read.receipt");
    expect(JSON.stringify(served)).toContain("big1_1");

    // Server-side state the model never lost is still there.
    expect(handleTable.size()).toBeGreaterThanOrEqual(handlesBefore);
    expect(handleTable.get(outlineHandle)).toBeDefined();
    for (const rel of authorityBefore) expect(getSession(ws).admissibleEditPaths).toContain(rel);
    const byHandle = await read({ targets: [{ handle: outlineHandle }], content: "full", cwd: ws });
    expect(byHandle["kind"]).not.toBe("refusal");
    const resumed = await read({
      query: "Update anchorFn so the anchor returns a scaled value.",
      targets: [{ path: "src/fence_anchor.ts" }], task: { handle: taskId }, cwd: ws,
    });
    expect(resumed["kind"], `the task handle must still be accepted: ${JSON.stringify(resumed).slice(0, 300)}`).not.toBe("refusal");

    // Re-served content is held again until the next compaction.
    expect(servedRangeReceipt(ws, "src/big1.ts", sha, 2, 6, 92)).toBeDefined();
    const heldAgain = await read({ targets: [{ path: "src/big1.ts", range: "2-6" }], cwd: ws });
    expect(heldAgain["kind"]).toBe("read.receipt");
    bumpMarker(ws, 2);
    expect((await read({ targets: [{ path: "src/big1.ts", range: "2-6" }], cwd: ws }))["kind"]).not.toBe("read.receipt");
  }, 60000);

  it("a repeated task pack is re-served with its bodies once the marker changed, not answered from the served-pack record", async () => {
    const ws = workspace("pack");
    const args = { query: "What does anchorFn in src/fence_anchor.ts return?", cwd: ws };
    const first = await read({ ...args, task: { epoch: "new" } });
    expect(JSON.stringify(first)).toContain("return x;");
    const repeat = await read(args);
    expect(JSON.stringify(repeat), `the repeat should not resend the body: ${JSON.stringify(repeat).slice(0, 300)}`).not.toContain("return x;");

    bumpMarker(ws, 1);
    const afterCompaction = await read(args);
    expect(JSON.stringify(afterCompaction), `expected the body again: ${JSON.stringify(afterCompaction).slice(0, 300)}`).toContain("return x;");
  }, 60000);

  it("the first sight of a marker is the baseline, an unchanged or removed marker resets nothing, and TL_COMPACTION_MARKER=0 turns the check off", async () => {
    const ws = workspace("baseline");
    bumpMarker(ws, 1);
    await read({ targets: [{ path: "src/big1.ts" }, { path: "src/big2.ts" }], content: "full", cwd: ws });
    const sha = shaOfText(fs.readFileSync(path.join(ws, "src/big1.ts"), "utf8"));
    expect(servedRangeReceipt(ws, "src/big1.ts", sha, 2, 6, 92)).toBeDefined();
    // Same marker: no reset.
    expect(noteCompactionMarker(ws)).toBe(false);
    expect((await read({ targets: [{ path: "src/big1.ts", range: "2-6" }], cwd: ws }))["kind"]).toBe("read.receipt");
    // A marker that disappears compacted nothing.
    fs.unlinkSync(path.join(ws, COMPACTION_MARKER_RELATIVE_PATH));
    expect(noteCompactionMarker(ws)).toBe(false);
    expect(servedRangeReceipt(ws, "src/big1.ts", sha, 2, 6, 92)).toBeDefined();
    // Flag off: even a changed marker is ignored.
    const previous = process.env["TL_COMPACTION_MARKER"];
    process.env["TL_COMPACTION_MARKER"] = "0";
    try {
      bumpMarker(ws, 2);
      expect(noteCompactionMarker(ws)).toBe(false);
      expect((await read({ targets: [{ path: "src/big1.ts", range: "2-6" }], cwd: ws }))["kind"]).toBe("read.receipt");
    } finally {
      if (previous === undefined) delete process.env["TL_COMPACTION_MARKER"];
      else process.env["TL_COMPACTION_MARKER"] = previous;
    }
    // Flag back on: the marker that appeared while the check was off counts as
    // a compaction against the last baseline this process saw (absent).
    expect(noteCompactionMarker(ws)).toBe(true);
    expect(servedRangeReceipt(ws, "src/big1.ts", sha, 2, 6, 92)).toBeUndefined();
    await read({ targets: [{ path: "src/big1.ts" }, { path: "src/big2.ts" }], content: "full", cwd: ws });
    expect(servedRangeReceipt(ws, "src/big1.ts", sha, 2, 6, 92)).toBeDefined();
    bumpMarker(ws, 3);
    expect(noteCompactionMarker(ws)).toBe(true);
    expect(servedRangeReceipt(ws, "src/big1.ts", sha, 2, 6, 92)).toBeUndefined();
    expect(noteCompactionMarker(undefined)).toBe(false);
  }, 60000);
});

describe("clearServedContentState", () => {
  it("empties the served ledgers in every lane of the root and leaves the rest of the session alone", () => {
    const ws = mkWs("lanes");
    const other = mkWs("other");
    const rel = "src/direct.ts";
    recordServedRange(ws, rel, "sha256:a", 1, 1, 1, { mode: "full", range: "1-1", call: 1 });
    runWithSessionLane("alpha", () => recordServedRange(ws, rel, "sha256:a", 1, 1, 1, { mode: "full", range: "1-1", call: 1 }));
    recordServedRange(other, rel, "sha256:b", 1, 1, 1, { mode: "full", range: "1-1", call: 1 });
    const session = getSession(ws);
    session.admissibleEditPaths.push("src/kept.ts");
    session.searchDedupLedger.set("fingerprint", { } as never);
    session.verificationSurfacesServed.set("src/x.ts", "sha");
    const readsBefore = session.readsByMode.size;

    expect(resetServedContentClaims(ws)).toBeUndefined();
    expect(session.servedRangeLedger.size).toBe(0);
    expect(runWithSessionLane("alpha", () => getSession(ws)).servedRangeLedger.size).toBe(0);
    expect(session.pendingServeSpans).toEqual([]);
    expect(session.searchDedupLedger.size).toBe(0);
    expect(session.verificationSurfacesServed.size).toBe(0);
    expect(session.admissibleEditPaths).toContain("src/kept.ts");
    expect(session.readsByMode.size).toBe(readsBefore);
    // Another workspace's session is untouched.
    expect(getSession(other).servedRangeLedger.has(rel)).toBe(true);
    expect(clearServedContentState(path.join(ws, "nowhere"))).toBe(0);
  });

  it("the stat signature names absence and changes with every rewrite", () => {
    const ws = mkWs("signature");
    expect(compactionMarkerSignature(ws)).toBe("absent");
    bumpMarker(ws, 1);
    const first = compactionMarkerSignature(ws);
    expect(first).not.toBe("absent");
    bumpMarker(ws, 2);
    expect(compactionMarkerSignature(ws)).not.toBe(first);
  });
});
