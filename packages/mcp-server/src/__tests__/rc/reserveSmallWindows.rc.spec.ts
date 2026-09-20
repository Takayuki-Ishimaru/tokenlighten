/**
 * reserveSmallWindows.rc.spec.ts — WP-S10 (2026-09-20 turn economy),
 * real-server reproduction of a defect recorded in live GitHub Copilot
 * sessions (2026-09-19 and 2026-09-20).
 *
 * MEASURED DEFECT: before answering, the model often re-reads a few exact
 * ranges it already holds ("verification read"). TokenLighten answers an
 * already-served range with a body-less receipt (`read.receipt`,
 * `code-unchanged`/`decision-unchanged`), the model then repeats the SAME
 * call with `task.force_serve:true`, and gets the bytes. Recorded:
 * `read_file {qref, targets:[{handle,range:"30-50"},{handle,range:"299-310"}],
 * task:{handle,profile:"answer"}}` -> receipt (487 B, one wasted turn) ->
 * identical call + `force_serve:true` -> ~1.2 KB of code. One model turn
 * costs as much as ~9-14 KB of served bytes on every host, so refusing to
 * re-send 1.2 KB is the expensive choice.
 *
 * FIX (`util/flags.ts`'s `reserveSmallWindowsEnabled`, DEFAULT OFF, a
 * TL_TURN_ECONOMY umbrella member): `server.ts`'s read_file dispatch, right
 * before the S1-A1 qref-repack reprojection, measures the TOTAL live size of
 * every explicit line window the call addresses (a single target's
 * range/ranges/symbol, or a paths[]/handles[] batch whose every entry does),
 * and — when the flag is on and that total is small (<=120 lines AND
 * <=4,096 raw bytes) — sets `args["force_serve"] = true`, the SAME flat
 * field `task.force_serve:true` maps onto, so every downstream dedupe door
 * serves real bytes exactly as an explicit forced call would.
 *
 * Harness copied from qrefRepackServesUnservedWindow.rc.spec.ts (repo
 * convention: no cross-spec helper import; each rc drill owns its stdio
 * JSON-RPC harness). Fixture: a small SYNTHETIC .ts file built in this file
 * (no fixture-specific keys/benchmark hints — AGENTS.md), so the exact served
 * range is deterministic and does not depend on any repo-wide concern-anchor
 * ranking heuristic.
 */

import { afterAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const nodeRequire = createRequire(import.meta.url);
const TSX_CLI = nodeRequire.resolve("tsx/cli");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_TS = path.resolve(HERE, "..", "..", "bin.ts");
const SPAWN_TIMEOUT_MS = 150_000;

const SEED_QUERY = "Explain what calc.ts does and how its operations combine sum and diff.";

/**
 * A small, self-contained TS file with twenty tiny functions -- 141 lines,
 * ~3.3 KB. Named/queried generically (no ShopFlow/OrderService-style
 * fixture-specific vocabulary): a single caller-named target this size, with
 * a generous budget and nothing else competing for evidence slots, is served
 * WHOLE by the existing (unrelated to this flag) task-pack builder --
 * verified empirically against the built server before this file was
 * written. That whole-file serve is this drill's "already served" baseline:
 * every window this drill re-asks for is a SUBSET of it.
 */
function fixtureContent(): string {
  const lines = ["// calc.ts -- twenty tiny arithmetic helpers"];
  for (let i = 0; i < 20; i++) {
    lines.push(`export function op${i}(a: number, b: number): number {`);
    lines.push(`  const sum = a + b + ${i};`);
    lines.push(`  const diff = a - b - ${i};`);
    lines.push(`  const combined = sum * diff;`);
    lines.push(`  return combined % 1000;`);
    lines.push(`}`);
    lines.push("");
  }
  return lines.join("\n") + "\n";
}
const FIXTURE_TOTAL_LINES = 141;

function calcWorkspace(): string {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-rc-reservesmall-")));
  fs.writeFileSync(path.join(ws, "calc.ts"), fixtureContent(), "utf8");
  return ws;
}

interface ServerHandle {
  initialize(): Promise<void>;
  rpc(id: number, method: string, params?: unknown, timeoutMs?: number): Promise<any>;
  kill(): void;
  alive(): boolean;
}

const tmpDirs: string[] = [];
const spawnedServers: ServerHandle[] = [];

function startServer(ws: string, env?: Record<string, string>): ServerHandle {
  const child: ChildProcess = spawn(process.execPath, [TSX_CLI, BIN_TS, ws], {
    cwd: ws,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...(env ?? {}) },
  });
  let stdoutBuf = "";
  let stderr = "";
  const waiters = new Map<number, (msg: any) => void>();
  child.stdout!.on("data", (d: Buffer) => {
    stdoutBuf += d.toString();
    let nl: number;
    while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg && msg.id != null && waiters.has(msg.id)) {
        const w = waiters.get(msg.id)!;
        waiters.delete(msg.id);
        w(msg);
      }
    }
  });
  child.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });

  function rpc(id: number, method: string, params?: unknown, timeoutMs = 90000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`rpc '${method}' timed out after ${timeoutMs}ms.\n--- stderr ---\n${stderr}`));
      }, timeoutMs);
      waiters.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async function initialize(): Promise<void> {
    await rpc(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "vitest-rc-reservesmall", version: "0" },
    });
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }

  const handle: ServerHandle = {
    initialize,
    rpc,
    kill: () => { try { child.kill("SIGKILL"); } catch { /* ok */ } },
    alive: () => child.exitCode === null && child.signalCode === null,
  };
  spawnedServers.push(handle);
  return handle;
}

function bodyOf(rpcResult: any): Record<string, unknown> {
  const text = rpcResult?.result?.content?.[0]?.text;
  expect(typeof text, `expected text content, got: ${JSON.stringify(rpcResult)}`).toBe("string");
  return JSON.parse(text);
}

afterAll(() => {
  for (const s of spawnedServers.splice(0)) s.kill();
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

interface Seeded {
  qref: string;
  taskId: string;
  handle: string;
}

/** Reaches `act.answer` with calc.ts served WHOLE (the "already served" baseline every later window is a subset of). */
async function seedCalcPack(server: ServerHandle, ws: string): Promise<Seeded> {
  const seed = bodyOf(await server.rpc(2, "tools/call", {
    name: "read_file",
    arguments: {
      query: SEED_QUERY,
      targets: [{ path: "calc.ts" }],
      content: "auto",
      task: { epoch: "new", profile: "answer" },
      budget: { bytes: 60_000 },
      cwd: ws,
    },
  }));
  expect(seed["kind"], JSON.stringify(seed).slice(0, 500)).toBe("read.task_pack");
  expect((seed["decision"] as Record<string, unknown> | undefined)?.["kind"], JSON.stringify(seed).slice(0, 500))
    .toBe("act.answer");
  const evidence = seed["evidence"] as Array<Record<string, unknown>>;
  const calcEvidence = evidence.find((e) => String(e["path"]).endsWith("calc.ts"));
  expect(calcEvidence, "calc.ts must be part of the served working set").toBeDefined();
  expect(
    calcEvidence!["range"],
    `expected calc.ts served WHOLE at 1-${FIXTURE_TOTAL_LINES}; got ${JSON.stringify(calcEvidence).slice(0, 300)}`,
  ).toBe(`1-${FIXTURE_TOTAL_LINES}`);
  return { qref: String(seed["qref"]), taskId: String((seed["task"] as Record<string, unknown>)["id"]), handle: String(calcEvidence!["handle"]) };
}

/** Recursively deletes every property literally named `handle`, at any depth, in place. */
function deepStripHandles(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) deepStripHandles(entry);
    return;
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    delete obj["handle"];
    for (const key of Object.keys(obj)) deepStripHandles(obj[key]);
  }
}

/**
 * Strips every per-process-random capability/identity token a `read.task_pack`
 * response can carry, so two independent server processes serving the
 * canonically-identical (path, sha, range) material can be compared for
 * everything ELSE byte-for-byte. `handle` is stripped at ANY depth (evidence
 * entries, `likely_edits`, `decision.frontier`, and `frontier_index` --
 * capability tokens minted per (workspace, lane, path) rather than pure
 * content hashes, so they legitimately differ across two independent server
 * processes even for the identical canonical (path, sha) key). `qref`/
 * `task.replay` are included too: unlike a fresh SEED call (whose qref is
 * deterministic across two pristine workspaces), a FOLLOW-UP call's qref is
 * derived in part from the chain's own (random) task id, so it legitimately
 * differs across processes here as well -- verified empirically against the
 * built server before this file was written.
 */
function stripIdentity(body: Record<string, unknown>): unknown {
  const clone = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  delete clone["qref"];
  const task = clone["task"];
  if (task !== null && typeof task === "object") {
    delete (task as Record<string, unknown>)["id"];
    delete (task as Record<string, unknown>)["replay"];
  }
  const decision = clone["decision"];
  if (decision !== null && typeof decision === "object") {
    const certificate = (decision as Record<string, unknown>)["certificate"];
    if (certificate !== null && typeof certificate === "object") delete (certificate as Record<string, unknown>)["id"];
  }
  deepStripHandles(clone);
  return clone;
}

describe("WP-S10 — TL_RESERVE_SMALL_WINDOWS reserves a small already-served window from a dedupe receipt", () => {
  it(
    "qref + already-served small window(s) receipt when unset, serve real bytes when on, and are byte-identical " +
      "(modulo identity tokens) to an explicit force_serve:true call; a >120-line already-served window still " +
      "receipts even when the flag is on",
    async () => {
      const wsOff = calcWorkspace();
      tmpDirs.push(wsOff);
      const serverOff = startServer(wsOff);
      const wsOn = calcWorkspace();
      tmpDirs.push(wsOn);
      const serverOn = startServer(wsOn, { TL_RESERVE_SMALL_WINDOWS: "1" });
      const wsForced = calcWorkspace();
      tmpDirs.push(wsForced);
      const serverForced = startServer(wsForced);
      await Promise.all([serverOff.initialize(), serverOn.initialize(), serverForced.initialize()]);

      const seededOff = await seedCalcPack(serverOff, wsOff);
      const seededOn = await seedCalcPack(serverOn, wsOn);
      const seededForced = await seedCalcPack(serverForced, wsForced);

      // 1. UNSET: a single already-served small range (11 lines, well under
      // both caps) still receipts -- today's exact behaviour.
      const singleOff = bodyOf(await serverOff.rpc(3, "tools/call", {
        name: "read_file",
        arguments: {
          qref: seededOff.qref,
          targets: [{ handle: seededOff.handle, range: "5-15" }],
          task: { handle: seededOff.taskId, profile: "answer" },
          cwd: wsOff,
        },
      }));
      expect(singleOff["kind"], JSON.stringify(singleOff).slice(0, 500)).toBe("read.receipt");

      // 2. THE RECORDED SHAPE: two already-served small ranges in one call.
      // Unset, this also receipts.
      const twoOff = bodyOf(await serverOff.rpc(4, "tools/call", {
        name: "read_file",
        arguments: {
          qref: seededOff.qref,
          targets: [
            { handle: seededOff.handle, range: "5-15" },
            { handle: seededOff.handle, range: "50-60" },
          ],
          task: { handle: seededOff.taskId, profile: "answer" },
          cwd: wsOff,
        },
      }));
      expect(twoOff["kind"], JSON.stringify(twoOff).slice(0, 500)).toBe("read.receipt");

      // 3. ON: the IDENTICAL single-range call serves real bytes.
      const singleOn = bodyOf(await serverOn.rpc(3, "tools/call", {
        name: "read_file",
        arguments: {
          qref: seededOn.qref,
          targets: [{ handle: seededOn.handle, range: "5-15" }],
          task: { handle: seededOn.taskId, profile: "answer" },
          cwd: wsOn,
        },
      }));
      expect(
        singleOn["kind"],
        `flag on: a small already-served range must serve real bytes, not a receipt; got ${JSON.stringify(singleOn).slice(0, 500)}`,
      ).not.toBe("read.receipt");
      const singleOnEvidence = singleOn["evidence"] as Array<Record<string, unknown>> | undefined;
      expect(singleOnEvidence, JSON.stringify(singleOn).slice(0, 500)).toBeDefined();
      expect(singleOnEvidence![0]?.["range"]).toBe("5-15");
      expect(typeof singleOnEvidence![0]?.["body"]).toBe("string");
      expect((singleOnEvidence![0]!["body"] as string).length).toBeGreaterThan(0);

      // 4. ON: the two-small-ranges recorded shape also serves real bytes.
      const twoOn = bodyOf(await serverOn.rpc(4, "tools/call", {
        name: "read_file",
        arguments: {
          qref: seededOn.qref,
          targets: [
            { handle: seededOn.handle, range: "5-15" },
            { handle: seededOn.handle, range: "50-60" },
          ],
          task: { handle: seededOn.taskId, profile: "answer" },
          cwd: wsOn,
        },
      }));
      expect(
        twoOn["kind"],
        `flag on: two small already-served ranges must serve real bytes; got ${JSON.stringify(twoOn).slice(0, 500)}`,
      ).not.toBe("read.receipt");
      const twoOnEvidence = twoOn["evidence"] as Array<Record<string, unknown>>;
      expect(twoOnEvidence.map((e) => e["range"])).toEqual(["5-15", "50-60"]);
      for (const entry of twoOnEvidence) {
        expect(typeof entry["body"]).toBe("string");
        expect((entry["body"] as string).length).toBeGreaterThan(0);
      }

      // 5. FORCED (no flag, explicit task.force_serve:true): the known-good
      // baseline this flag's auto-forced call must match, byte-identical
      // modulo identity tokens.
      const singleForced = bodyOf(await serverForced.rpc(3, "tools/call", {
        name: "read_file",
        arguments: {
          qref: seededForced.qref,
          targets: [{ handle: seededForced.handle, range: "5-15" }],
          task: { handle: seededForced.taskId, profile: "answer", force_serve: true },
          cwd: wsForced,
        },
      }));
      expect(singleForced["kind"]).not.toBe("read.receipt");
      expect(
        stripIdentity(singleOn),
        `the flag-triggered serve must be byte-identical (modulo identity tokens) to an explicit force_serve:true call.\n` +
          `flag-on: ${JSON.stringify(singleOn).slice(0, 800)}\nforced: ${JSON.stringify(singleForced).slice(0, 800)}`,
      ).toEqual(stripIdentity(singleForced));

      // 6. SIZE GATE: a >120-line already-served window still receipts even
      // with the flag on -- the total-size cap is not merely a byte cap.
      const largeOn = bodyOf(await serverOn.rpc(5, "tools/call", {
        name: "read_file",
        arguments: {
          qref: seededOn.qref,
          targets: [{ handle: seededOn.handle, range: "1-135" }],
          task: { handle: seededOn.taskId, profile: "answer" },
          cwd: wsOn,
        },
      }));
      expect(
        largeOn["kind"],
        `a >120-line already-served window must still receipt even with the flag on; got ${JSON.stringify(largeOn).slice(0, 500)}`,
      ).toBe("read.receipt");

      expect(serverOff.alive()).toBe(true);
      expect(serverOn.alive()).toBe(true);
      expect(serverForced.alive()).toBe(true);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "a bare qref re-pack naming no explicit target is untouched by the flag",
    async () => {
      const wsOff = calcWorkspace();
      tmpDirs.push(wsOff);
      const serverOff = startServer(wsOff);
      const wsOn = calcWorkspace();
      tmpDirs.push(wsOn);
      const serverOn = startServer(wsOn, { TL_RESERVE_SMALL_WINDOWS: "1" });
      await Promise.all([serverOff.initialize(), serverOn.initialize()]);

      const seededOff = await seedCalcPack(serverOff, wsOff);
      const seededOn = await seedCalcPack(serverOn, wsOn);

      const bareOff = bodyOf(await serverOff.rpc(3, "tools/call", {
        name: "read_file",
        arguments: { qref: seededOff.qref, task: { handle: seededOff.taskId, profile: "answer" }, cwd: wsOff },
      }));
      const bareOn = bodyOf(await serverOn.rpc(3, "tools/call", {
        name: "read_file",
        arguments: { qref: seededOn.qref, task: { handle: seededOn.taskId, profile: "answer" }, cwd: wsOn },
      }));

      expect(bareOn["kind"], JSON.stringify(bareOn).slice(0, 300)).toBe(bareOff["kind"]);
      expect(
        stripIdentity(bareOn),
        "a bare {qref} re-pack (no explicit targets) must be byte-identical whether the flag is on or off -- " +
          "there is no explicit window for this seam to size, so it must never touch `force_serve`.",
      ).toEqual(stripIdentity(bareOff));

      expect(serverOff.alive()).toBe(true);
      expect(serverOn.alive()).toBe(true);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "a small already-served range of a file that changed on disk still serves fresh bytes, never a stale receipt",
    async () => {
      const ws = calcWorkspace();
      tmpDirs.push(ws);
      const server = startServer(ws, { TL_RESERVE_SMALL_WINDOWS: "1" });
      await server.initialize();
      const seeded = await seedCalcPack(server, ws);

      // Baseline: served, unchanged, small -> real bytes (already covered by
      // the first `it`, reasserted here as the control this test's own
      // change must diverge from).
      const before = bodyOf(await server.rpc(3, "tools/call", {
        name: "read_file",
        arguments: {
          qref: seeded.qref,
          targets: [{ handle: seeded.handle, range: "5-15" }],
          task: { handle: seeded.taskId, profile: "answer" },
          cwd: ws,
        },
      }));
      expect(before["kind"]).not.toBe("read.receipt");

      // Mutate a line INSIDE the requested 5-15 window (changes the file's
      // sha, and the window's own served text, without shifting any line
      // numbers) and re-issue the SAME qref + small-range call.
      const filePath = path.join(ws, "calc.ts");
      const mutated = fs.readFileSync(filePath, "utf8").replace(
        "  const sum = a + b + 1;",
        "  const sum = a + b + 1; // CHANGED-ON-DISK",
      );
      expect(mutated, "the targeted line must exist exactly once in the fixture").not.toBe(
        fs.readFileSync(filePath, "utf8"),
      );
      fs.writeFileSync(filePath, mutated, "utf8");

      const after = bodyOf(await server.rpc(4, "tools/call", {
        name: "read_file",
        arguments: {
          qref: seeded.qref,
          targets: [{ handle: seeded.handle, range: "5-15" }],
          task: { handle: seeded.taskId, profile: "answer" },
          cwd: ws,
        },
      }));
      expect(
        after["kind"],
        `a changed file must never receipt stale bytes, flag or no flag; got ${JSON.stringify(after).slice(0, 500)}`,
      ).not.toBe("read.receipt");
      // Honesty: the serve reflects the file as it stands NOW, not as it
      // stood when the original handle/receipt material was minted.
      const beforeBody = (before["evidence"] as Array<Record<string, unknown>>)[0]!["body"] as string;
      const afterEvidence = (after["evidence"] as Array<Record<string, unknown>> | undefined)?.[0];
      expect(afterEvidence, JSON.stringify(after).slice(0, 500)).toBeDefined();
      const afterBody = afterEvidence!["body"] as string;
      expect(beforeBody, "control: the pre-change body must not already carry the marker").not.toContain("CHANGED-ON-DISK");
      expect(afterBody, "the post-change serve must reflect the new on-disk content").toContain("CHANGED-ON-DISK");

      expect(server.alive()).toBe(true);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "TL_TURN_ECONOMY=1 alone turns the policy on; an explicit TL_RESERVE_SMALL_WINDOWS=0 keeps it off under the umbrella",
    async () => {
      const wsUmbrella = calcWorkspace();
      tmpDirs.push(wsUmbrella);
      const serverUmbrella = startServer(wsUmbrella, { TL_TURN_ECONOMY: "1" });
      const wsOverride = calcWorkspace();
      tmpDirs.push(wsOverride);
      const serverOverride = startServer(wsOverride, { TL_TURN_ECONOMY: "1", TL_RESERVE_SMALL_WINDOWS: "0" });
      await Promise.all([serverUmbrella.initialize(), serverOverride.initialize()]);

      const seededUmbrella = await seedCalcPack(serverUmbrella, wsUmbrella);
      const seededOverride = await seedCalcPack(serverOverride, wsOverride);

      const umbrella = bodyOf(await serverUmbrella.rpc(3, "tools/call", {
        name: "read_file",
        arguments: {
          qref: seededUmbrella.qref,
          targets: [{ handle: seededUmbrella.handle, range: "5-15" }],
          task: { handle: seededUmbrella.taskId, profile: "answer" },
          cwd: wsUmbrella,
        },
      }));
      expect(
        umbrella["kind"],
        `TL_TURN_ECONOMY=1 alone must turn this policy on; got ${JSON.stringify(umbrella).slice(0, 500)}`,
      ).not.toBe("read.receipt");

      const overridden = bodyOf(await serverOverride.rpc(3, "tools/call", {
        name: "read_file",
        arguments: {
          qref: seededOverride.qref,
          targets: [{ handle: seededOverride.handle, range: "5-15" }],
          task: { handle: seededOverride.taskId, profile: "answer" },
          cwd: wsOverride,
        },
      }));
      expect(
        overridden["kind"],
        `explicit TL_RESERVE_SMALL_WINDOWS=0 must win over the umbrella; got ${JSON.stringify(overridden).slice(0, 500)}`,
      ).toBe("read.receipt");

      expect(serverUmbrella.alive()).toBe(true);
      expect(serverOverride.alive()).toBe(true);
    },
    SPAWN_TIMEOUT_MS,
  );
});
