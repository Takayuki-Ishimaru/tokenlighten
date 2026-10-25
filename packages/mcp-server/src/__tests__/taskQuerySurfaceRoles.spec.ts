/**
 * taskQuerySurfaceRoles.spec.ts — wire-compaction review F1 (2026-10-23): the qref's
 * slot remembers that its task was first requested with `surfaceRoles`.
 *
 * A continuation page re-packs by `qref` (or by the query alone), and the cursor
 * behind it stores that call, so the page's own arguments never carry the scope its
 * first request had. The reply's emission still has to read the page as a page of a
 * call that passed roles (`role:"unknown"` stays on it; types `Evidence.role`), so the
 * task-pack dispatch asks the slot (server.ts `rememberTaskPackQuery`). The slot carries
 * the fact the way it carries the task binding and handle (state/session.ts
 * `rememberTaskQuery`): through a re-issue of the same query, through a restart (the
 * durable slot, state/stateHandles.ts), and not across a different query, an epoch
 * boundary, or a ref that no longer resolves.
 *
 * The emitted replies are pinned end to end by replayCorpus.spec.ts v016wk; the pass
 * that reads the fact is wireCompaction.spec.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  attachTaskQueryRefBinding,
  clearTaskQueryRef,
  rememberTaskQuery,
  resetAll as resetAllSessions,
  resolveTaskQueryRef,
  resolveTaskQueryRefSurfaceRoles,
  tokenizeForEpoch,
} from "../state/session.js";
import { recordTaskContract, resetTaskContractStoreForTest } from "../features/task-pack/taskContractStore.js";
import { stateStoreFor } from "../state/stateStore.js";

const QUERY = "add the CRITICAL priority to the shared enum, the PriorityBadge component and the issue create path";
const OTHER = "rename the tokens stylesheet variables for the badge";

const workspaces: string[] = [];
function makeWorkspace(tag: string): string {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `tl-qref-roles-${tag}-`)));
  workspaces.push(ws);
  fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ name: "qref-roles-fixture", version: "0.0.0", type: "module" }));
  return ws;
}
/** The durable slot rehydrates the query text from the task contract, as production's first pack writes it. */
function contractFor(ws: string, query: string): void {
  recordTaskContract(ws, tokenizeForEpoch(query), { query });
}

beforeEach(() => {
  resetTaskContractStoreForTest();
  resetAllSessions();
});
afterEach(() => {
  for (const ws of workspaces.splice(0)) {
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* the OS reaps tmpdir */ }
  }
});

describe("the qref slot remembers that its task passed surfaceRoles", () => {
  it("is false for a task that passed none, and for a ref nothing resolves", () => {
    const ws = makeWorkspace("plain");
    contractFor(ws, QUERY);
    const ref = rememberTaskQuery(ws, QUERY);
    expect(resolveTaskQueryRefSurfaceRoles(ws, ref)).toBe(false);
    expect(resolveTaskQueryRefSurfaceRoles(ws, "q-0000000000000000")).toBe(false);
    expect(resolveTaskQueryRefSurfaceRoles(ws, "")).toBe(false);
  });

  it("is true once a call passed them, and stays true while the same query is re-issued without them", () => {
    const ws = makeWorkspace("carry");
    contractFor(ws, QUERY);
    const ref = rememberTaskQuery(ws, QUERY, undefined, true);
    expect(resolveTaskQueryRefSurfaceRoles(ws, ref)).toBe(true);
    // The continuation pages: a bare-qref re-pack re-issues the same query, naming no roles.
    expect(rememberTaskQuery(ws, QUERY)).toBe(ref);
    expect(rememberTaskQuery(ws, QUERY, "binding-1", false)).toBe(ref);
    expect(resolveTaskQueryRefSurfaceRoles(ws, ref)).toBe(true);
    // ...and a late-bound task binding does not drop it.
    attachTaskQueryRefBinding(ws, ref, "late-bound-fingerprint", "tlh_task");
    expect(resolveTaskQueryRefSurfaceRoles(ws, ref)).toBe(true);
  });

  it("does not carry across a different query, a superseded ref, or an epoch boundary", () => {
    const ws = makeWorkspace("scope");
    contractFor(ws, QUERY);
    const first = rememberTaskQuery(ws, QUERY, undefined, true);
    contractFor(ws, OTHER);
    const second = rememberTaskQuery(ws, OTHER);
    expect(second).not.toBe(first);
    expect(resolveTaskQueryRefSurfaceRoles(ws, second), "a different query is a different task").toBe(false);
    expect(resolveTaskQueryRefSurfaceRoles(ws, first), "the superseded ref resolves to nothing").toBe(false);
    // The same query again, as a new epoch: the epoch boundary clears the slot first.
    const roles = rememberTaskQuery(ws, QUERY, undefined, true);
    expect(resolveTaskQueryRefSurfaceRoles(ws, roles)).toBe(true);
    clearTaskQueryRef(ws);
    expect(resolveTaskQueryRefSurfaceRoles(ws, roles)).toBe(false);
    expect(resolveTaskQueryRefSurfaceRoles(ws, rememberTaskQuery(ws, QUERY)), "a plain task after the boundary").toBe(false);
  });

  it("survives a restart: the durable slot carries the fact (and only the fact, never the roles)", () => {
    const ws = makeWorkspace("durable");
    contractFor(ws, QUERY);
    const ref = rememberTaskQuery(ws, QUERY, "task-binding-fixture", true);
    attachTaskQueryRefBinding(ws, ref, "task-binding-fixture", "tlh_task");
    resetAllSessions();
    expect(resolveTaskQueryRef(ws, ref), "rehydrated from the durable slot").toBe(QUERY);
    expect(resolveTaskQueryRefSurfaceRoles(ws, ref)).toBe(true);
    // A plain task's slot rehydrates without it.
    clearTaskQueryRef(ws);
    contractFor(ws, OTHER);
    const plain = rememberTaskQuery(ws, OTHER, "other-binding");
    resetAllSessions();
    expect(resolveTaskQueryRef(ws, plain)).toBe(OTHER);
    expect(resolveTaskQueryRefSurfaceRoles(ws, plain)).toBe(false);
  });

  it("writes the durable slot once per change: repeating an unchanged re-issue writes nothing further, and a slot minted without roles is byte-identical to one minted before the field existed", () => {
    const ws = makeWorkspace("journal");
    contractFor(ws, QUERY);
    const store = stateStoreFor(ws);
    const slotWrites = (): number => {
      try { return fs.readFileSync(path.join(store!.dir, "journal.ndjson"), "utf8").split("\n").filter(line => line.includes("\"purpose\":\"qref\"")).length; } catch { return 0; }
    };
    expect(store?.available, "the fixture has a state store").toBe(true);
    const ref = rememberTaskQuery(ws, QUERY, undefined, true);
    const afterMint = slotWrites();
    expect(afterMint).toBeGreaterThan(0);
    rememberTaskQuery(ws, QUERY);
    rememberTaskQuery(ws, QUERY, undefined, true);
    expect(slotWrites(), "a re-issue that changes nothing persists nothing").toBe(afterMint);
    const record = JSON.parse(fs.readFileSync(path.join(store!.dir, "journal.ndjson"), "utf8").split("\n").filter(line => line.includes("\"purpose\":\"qref\"")).at(-1)!);
    expect(JSON.stringify(record)).toContain("\"surfaceRoles\":true");
    expect(JSON.stringify(record)).not.toContain("\"ui\"");
    // A task that passed none writes no such key at all.
    clearTaskQueryRef(ws);
    contractFor(ws, OTHER);
    rememberTaskQuery(ws, OTHER, "b");
    const plainRecord = fs.readFileSync(path.join(store!.dir, "journal.ndjson"), "utf8").split("\n").filter(line => line.includes("\"purpose\":\"qref\"")).at(-1)!;
    expect(plainRecord).not.toContain("surfaceRoles");
    expect(ref).toMatch(/^q-[0-9a-f]{16}$/);
  });
});
