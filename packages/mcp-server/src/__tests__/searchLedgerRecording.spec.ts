// searchLedgerRecording.spec.ts — P1-d (2026-08-28 review-fix wave) fixtures
// for search_files dispatch ledger-recording.
//
// Pre-wave, server.ts's search_files dispatch recorded ONLY find's authoritative
// absence into the task-contract ledger. references and tree executed with no
// ledger write at all, and a find HIT (as opposed to an absence) was likewise
// never consumed as a proof transition. This file exercises the REAL dispatch
// (in-process `callTool` from server.ts, same pattern as pi04TermAbsence.spec.ts)
// so the assertions cover the actual wiring, not a taskContractStore.ts helper
// called directly — the D-W5 lesson (a unit spec that calls a guard/helper
// directly can stay green while the dispatcher never wires it in).
//
// The task-contract ledger lives in the SAME process as this test (in-process
// dispatch, unlike sequenceCorpus.spec.ts's spawned child server), so
// `taskContractLedgerSnapshotForTest` can observe exactly what the dispatch
// call recorded.

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { callTool } from "../server.js";
import { resetAll as resetAllSessions } from "../util/session.js";
import {
  bindTaskContractHandle,
  executableNextScope,
  recordTaskContract,
  registerExecutableNextScope,
  resetTaskContractStoreForTest,
  taskContractLedgerSnapshotForTest,
  type TaskContractScope,
} from "../features/task-pack/taskContractStore.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const tmpDirs: string[] = [];

/** Dispatch-based tests need a cwd checkCwdOrRefuse accepts — same constraint every in-process callTool spec in this suite honors (see pi04TermAbsence.spec.ts / closureMode.spec.ts). */
function mkWorkspace(tag: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(HOME, `.tl-sldg-${tag}-`)));
  tmpDirs.push(root);
  return root;
}

function writeFile(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

async function dispatch(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await callTool("search_files", args);
  expect("isError" in result && result.isError === true, JSON.stringify(result)).toBe(false);
  const text = (result.content[0] as { text?: string } | undefined)?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

/** Seed a scope with a taskHandle (registerExecutableNextScope is a no-op without one) and one unproven concern-token obligation for `token`. */
function seedConcern(root: string, lane: string, taskHandle: string, token: string): TaskContractScope {
  const scope = bindTaskContractHandle(root, { lane }, taskHandle);
  recordTaskContract(root, [token.toLowerCase()], { query: `find ${token}`, concernTokens: [token] }, scope);
  return scope;
}

function concernObligation(root: string, scope: TaskContractScope, token: string) {
  return taskContractLedgerSnapshotForTest(root, scope)?.obligations
    .find((entry) => entry.kind === "concern-token" && entry.target === token);
}

afterEach(() => {
  resetAllSessions();
  resetTaskContractStoreForTest();
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe("search_files dispatch ledger recording (P1-d)", () => {
  it("find: a HIT proves the scoped concern-token obligation as served", async () => {
    const root = mkWorkspace("find-hit");
    writeFile(root, "src/util.ts", "export function computeTotal() { return 1; }\n");
    const lane = "p1d-find-hit";
    const scope = seedConcern(root, lane, "task-find-hit", "computeTotal");
    registerExecutableNextScope(root, scope, { tool: "search_files", arguments: { action: "find", query: "computeTotal" } });
    expect(concernObligation(root, scope, "computeTotal")?.proof).toBeUndefined();

    const body = await dispatch({ action: "find", query: "computeTotal", cwd: root, lane });
    expect(JSON.stringify(body)).not.toContain("\"absence\"");

    expect(concernObligation(root, scope, "computeTotal")?.proof).toEqual({ type: "served", witness: "computeTotal" });
  });

  it("references: a HIT proves the scoped concern-token obligation, an authoritative absence discharges it as absent", async () => {
    const root = mkWorkspace("references");
    writeFile(root, "src/util.ts", "export function computeTotal() { return 1; }\n");
    writeFile(root, "src/caller.ts", "import { computeTotal } from \"./util.js\";\nexport const x = computeTotal();\n");

    const hitLane = "p1d-refs-hit";
    const hitScope = seedConcern(root, hitLane, "task-refs-hit", "computeTotal");
    registerExecutableNextScope(root, hitScope, { tool: "search_files", arguments: { action: "references", query: "computeTotal" } });
    await dispatch({ action: "references", query: "computeTotal", cwd: root, lane: hitLane });
    expect(concernObligation(root, hitScope, "computeTotal")?.proof).toEqual({ type: "served", witness: "computeTotal" });

    const absentLane = "p1d-refs-absent";
    const absentScope = seedConcern(root, absentLane, "task-refs-absent", "totallyMissingSymbolXYZ");
    registerExecutableNextScope(root, absentScope, { tool: "search_files", arguments: { action: "references", query: "totallyMissingSymbolXYZ" } });
    await dispatch({ action: "references", query: "totallyMissingSymbolXYZ", cwd: root, lane: absentLane });
    expect(concernObligation(root, absentScope, "totallyMissingSymbolXYZ")?.proof)
      .toEqual({ type: "authoritative-absent", witness: "totallyMissingSymbolXYZ" });
  });

  it("references: an unscoped call (never prescribed) records nothing — fail-closed", async () => {
    const root = mkWorkspace("references-unscoped");
    writeFile(root, "src/util.ts", "export function computeTotal() { return 1; }\n");
    const lane = "p1d-refs-unscoped";
    // A concern-token obligation exists, but NO registerExecutableNextScope ran
    // for this exact call — the dispatcher must not guess which task it belongs to.
    const scope = seedConcern(root, lane, "task-refs-unscoped", "computeTotal");
    await dispatch({ action: "references", query: "computeTotal", cwd: root, lane });
    expect(concernObligation(root, scope, "computeTotal")?.proof).toBeUndefined();
  });

  it("tree: an executed, scoped tree call retires its pending-next entry", async () => {
    const root = mkWorkspace("tree");
    writeFile(root, "src/util.ts", "export function computeTotal() { return 1; }\n");
    const lane = "p1d-tree";
    // A contract record must exist BEFORE binding the handle: bindTaskContractHandle
    // only MOVES an existing lane-scoped record (it is a no-op otherwise, per its
    // own doc comment), and registerExecutableNextScope's pendingNexts write is
    // itself gated on that record already existing at the destination scope — the
    // exact ordering sequenceCorpus.spec.ts's "recovers one pending next after
    // restart" unit test already establishes.
    recordTaskContract(root, ["tree", "src"], { query: "tree src" }, { lane });
    const scope = bindTaskContractHandle(root, { lane }, "task-tree");
    const next = { tool: "search_files", arguments: { action: "tree", path: "src" } };
    registerExecutableNextScope(root, scope, next);
    expect(executableNextScope(root, lane, next)).toEqual(scope);

    await dispatch({ action: "tree", path: "src", cwd: root, lane });

    expect(executableNextScope(root, lane, next)).toBeUndefined();
  });
});
