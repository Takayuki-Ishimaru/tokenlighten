/**
 * stateStoreLoopWorker.ts — test fixture, spawned via tsx by
 * stateStoreConcurrency.spec.ts (never imported directly): a standalone
 * process that opens the PI-09 persistent state store directly (the same
 * `state/stateStore.ts` + `state/stateHandles.ts` surfaces a real MCP server
 * instance uses) against a SHARED workspace and runs an interleaved
 * mint/consume/edit-dedup workload — the store-level equivalent of "two
 * server instances hammering the same workspace at once".
 *
 * Deliberately bypasses the MCP/stdio protocol layer entirely: the PI-09
 * concurrency cell under test lives in stateStore.ts/writerLock.ts, and
 * driving it directly (rather than through JSON-RPC framing) keeps the drill
 * fast, deterministic, and focused on the exact locked code paths.
 *
 * argv: <workspaceRoot> <workerId> <iterations> <sharedKeyCount> <sharedOpCount>
 *
 * Prints exactly one JSON summary line to stdout on completion (schema: see
 * `WorkerSummary` below) and exits 0. Any unexpected throw is left
 * uncaught — Node's default handler prints a stack to stderr and exits
 * non-zero, which the parent test treats as a hard failure.
 */
import { randomBytes } from "node:crypto";

import {
  resetStateStoresForTests,
  stateStoreFor,
  type PutOutcome,
} from "../../state/stateStore.js";
import { mintTaskHandle, resolveTaskHandle } from "../../state/stateHandles.js";
import { validateHandleToken } from "../../state/handleCodec.js";

const [, , workspaceRoot, workerId, iterationsRaw, sharedKeyCountRaw, sharedOpCountRaw] = process.argv;
if (
  workspaceRoot === undefined ||
  workerId === undefined ||
  iterationsRaw === undefined ||
  sharedKeyCountRaw === undefined ||
  sharedOpCountRaw === undefined
) {
  process.stderr.write(
    "usage: stateStoreLoopWorker.ts <workspaceRoot> <workerId> <iterations> <sharedKeyCount> <sharedOpCount>\n",
  );
  process.exit(2);
}
const iterations = Number(iterationsRaw);
const sharedKeyCount = Number(sharedKeyCountRaw);
const sharedOpCount = Number(sharedOpCountRaw);
const MAX_CAS_RETRIES = 40;

// ---------------------------------------------------------------------------
// Summary shape
// ---------------------------------------------------------------------------

interface WorkerSummary {
  workerId: string;
  pid: number;
  ownMintFailures: number;
  ownConsumeFailures: number;
  tamperAccepted: number; // MUST be 0 — a corrupted token ever validating
  crossWorkspaceAccepted: number; // MUST be 0
  casAppliedCounts: Record<string, number>; // sharedKey -> # of successful applies BY THIS worker
  casExhausted: string[]; // shared keys where MAX_CAS_RETRIES was not enough (should stay empty)
  opResults: Array<{ opId: string; firstSeen: boolean; value: string; mine: string }>;
}

const summary: WorkerSummary = {
  workerId,
  pid: process.pid,
  ownMintFailures: 0,
  ownConsumeFailures: 0,
  tamperAccepted: 0,
  crossWorkspaceAccepted: 0,
  casAppliedCounts: {},
  casExhausted: [],
  opResults: [],
};

// Every store-level worker call goes through ONE cached store instance for
// this process's whole lifetime, exactly like a real long-lived server
// process — resetStateStoresForTests is called ONCE up front purely so a
// worker started against an already-populated dir (a prior test in the same
// file) does not accidentally inherit another test's cache from this
// module's perspective; there is no other process sharing this one's memory.
resetStateStoresForTests();

const store = stateStoreFor(workspaceRoot);
if (store === undefined || !store.available) {
  process.stderr.write(`worker ${workerId}: store unavailable at ${workspaceRoot}\n`);
  process.exit(3);
}

// ---------------------------------------------------------------------------
// 1. Independent mint/consume — high volume, no cross-worker contention
// ---------------------------------------------------------------------------

for (let i = 0; i < iterations; i++) {
  const fingerprint = `worker-${workerId}-task-${i}`;
  const token = mintTaskHandle(workspaceRoot, {
    taskFingerprint: fingerprint,
    replay: `replay-${workerId}-${i}`,
    mintedAtMs: Date.now(),
  });
  if (token === undefined) {
    summary.ownMintFailures += 1;
    continue;
  }
  const resolved = resolveTaskHandle(token, workspaceRoot);
  if (!resolved.ok || resolved.state.taskFingerprint !== fingerprint) {
    summary.ownConsumeFailures += 1;
  }

  // Tamper control: flip one character of the freshly minted token and
  // confirm it NEVER validates. Cheap, run on every iteration to stress this
  // under real concurrent load rather than only at rest.
  const flipped = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
  const tamperCheck = validateHandleToken({ token: flipped, expectedPurpose: "task", workspaceRoot });
  if (tamperCheck.ok) summary.tamperAccepted += 1;

  // Cross-workspace control: the same token must never resolve under a
  // DIFFERENT workspace root.
  const crossCheck = resolveTaskHandle(token, `${workspaceRoot}-not-the-real-one-${randomBytes(3).toString("hex")}`);
  if (crossCheck.ok) summary.crossWorkspaceAccepted += 1;
}

// ---------------------------------------------------------------------------
// 2. Shared-key CAS contention — every key is touched by BOTH workers
// ---------------------------------------------------------------------------

for (let k = 0; k < sharedKeyCount; k++) {
  const key = `shared-cas-${k}`;
  let applied = false;
  for (let attempt = 0; attempt < MAX_CAS_RETRIES && !applied; attempt++) {
    const expectedVersion = store.versionOf(key);
    const result: PutOutcome = store.put({
      key,
      purpose: "content",
      data: { writer: workerId, attempt },
      ttlMs: 300_000,
      expectedVersion,
    });
    if (result.ok) {
      applied = true;
      summary.casAppliedCounts[key] = (summary.casAppliedCounts[key] ?? 0) + 1;
    }
    // else: state-conflict — store.get()/versionOf() right after a FAILED
    // put is guaranteed fresh (the failed put's resync already updated the
    // in-memory cache before the CAS check ran), so the next attempt's
    // expectedVersion is not a stale guess.
  }
  if (!applied) summary.casExhausted.push(key);
}

// ---------------------------------------------------------------------------
// 3. Shared operation_id dedup — every id is touched by BOTH workers
// ---------------------------------------------------------------------------

for (let i = 0; i < sharedOpCount; i++) {
  const opId = `shared-op-${i}`;
  const mine = `${workerId}:${i}`;
  const result = store.rememberOperation(opId, mine);
  summary.opResults.push({ opId, firstSeen: result.firstSeen, value: result.value, mine });
}

process.stdout.write(`${JSON.stringify(summary)}\n`);
process.exit(0);
