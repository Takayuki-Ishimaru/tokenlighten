/**
 * sfCapOverflowBookings.spec.ts — FX-K (round-15 finding 1).
 *
 * THE DEFECT, on the SHIPPED DEFAULT PATH. `budget.bytes` is an advertised
 * `read_file` input, so `trimToCap` is reachable in ONE ordinary production
 * call. Until FX-K the admissible union, the cumulative served-surface log and
 * the certified working set were all booked BEFORE that trim, from the
 * pre-trim surface list — so a surface whose body Phase E stripped, or whose
 * whole row Phase F spliced out, was booked as "served". Round-15 drove it end
 * to end with every SF flag off:
 *
 *   read_file  { query: <generic pricing change>, budget: { bytes: 6144 } }
 *              → read.task_pack, limit { cause: "capped" }, every row bodyless
 *   read_file  { query: <same epoch>, targets: [src/anchor.ts] }   ← prepared fence
 *   edit_file  { path: "src/pricing_1.ts", … }   → edit.applied     ← BLIND EDIT
 *   edit_file  { path: "src/plain.ts", … }       → refusal          ← control: the gate IS live
 *
 * DESIGN gap (o) had deferred the repair partly on "Phase-E-on-survivor は
 * 本番入口から到達不能" (unreachable from the production entrance). That was
 * false, and no earlier round had shown the booking produce an APPLIED edit.
 *
 * WHAT FX-K CHANGES. One unconditional booking pass at `dedupeTrimAndPersist`'s
 * exit, off `shippedSurfaces(returned)`, in both flag states. The default
 * path's SESSION STATE therefore changes — deliberately — and this file is the
 * pin for what it changes to. The T09/T10 regression class ("the gate refuses
 * a handle this server itself served") is guarded from the other side by the
 * same cases: every surface that ships WITH a body, and every `code_unchanged`
 * restatement, stays admissible.
 *
 * WHICH CASES FAIL WITHOUT THE FIX (verified by restoring the pre-FX-K
 * `readCodeTaskPack.ts` from `git show HEAD:` and re-running, then restoring):
 *   - "books nothing for a pack whose bodies the cap stripped"  (union = all 3 paths)
 *   - "never books a surface the cap did not ship"              (spliced path booked)
 *   - "a bodyless-shipped file is not editable one call later"  (edit.applied)
 * The positive controls (bodies shipped → editable; `code_unchanged` →
 * editable; same-call demotion refused) pass before and after: their job is to
 * prove FX-K narrowed only the dishonest half.
 *
 * WHAT THIS FILE DOES NOT COVER — the certificate as a SECOND write authority.
 * `recordExecutionContract` lifts a certificate's `action_frontier` ∪
 * `evidence_handles` into the same admissible union, and the certificate is
 * rebuilt post-`trimToCap` but before the last shedding rungs, so it can still
 * name a bodyless-shipped surface. Measured on the 6144-byte pack below: the
 * PATH form and every handle the certificate does not list refuse, and ONE
 * certificate-listed handle still applied. `bookShippedPackServeState`'s own
 * doc records why narrowing the certificate inside the booking pass is not the
 * repair (it empties the certificate and trips session.ts's T13 "leave edits
 * ungated" escape hatch, which OPENS every edit including the control).
 *
 * That half was closed by FX-L (2026-09-03, ruling (r)) at the GATE, and is
 * pinned by `sfCertificateWriteAuthority.spec.ts` — including the recovery
 * loop, which is the reason it could not be a bare narrowing. This file keeps
 * its scope: what the BOOKING PASS books. Its own contribution to FX-L is the
 * `recordWithheldEditAddresses` complement of the same `shippedSurfaces`
 * projection, which is what lets the gate tell a capped certificate from a
 * session that never served anything.
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { callTool } from "../server.js";
import { getSession, tokenizeForEpoch } from "../state/session.js";
import { queryServedSurfaces } from "../util/packServeLog.js";
import { resetAll as resetAllSessions } from "../util/session.js";

// ---------------------------------------------------------------------------
// Fixture — round-15's `r15_k` corpus: eight 40-function pricing modules (so
// any small `budget.bytes` overflows the cap), one small anchor file the
// second call pins a prepared fence on, and one never-packed control file.
// ---------------------------------------------------------------------------

const QUERY =
  "Update orderTotal pricing rules across the pricing modules so quantity discounts apply.";
const ANCHOR_QUERY =
  "Update applyQuantityDiscount so orderTotal quantity discounts apply.";
const ANCHOR = "src/anchor.ts";
const CONTROL = "src/plain.ts";
/** The line every pricing module carries exactly once, so an edit is unambiguous. */
const EDIT_ANCHOR = "return qty * price + 3;";

const tmpDirs: string[] = [];

function mkWorkspace(tag: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), `.tl-sf-cap-${tag}-`)));
  tmpDirs.push(dir);
  const write = (rel: string, content: string): void => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  };
  for (let module = 0; module < 8; module++) {
    const lines = [`// module ${module}: orderTotal pricing surface`];
    for (let fn = 0; fn < 40; fn++) {
      lines.push(
        `export function orderTotal_${module}_${fn}(qty: number, price: number): number {`,
        `  // pricing rule ${module}.${fn} for orderTotal`,
        `  return qty * price + ${fn};`,
        "}",
      );
    }
    write(`src/pricing_${module}.ts`, `${lines.join("\n")}\n`);
  }
  write(ANCHOR, [
    "export function applyQuantityDiscount(x: number): number {",
    "  // orderTotal quantity discount anchor",
    "  return x;",
    "}",
  ].join("\n"));
  write(CONTROL, Array.from({ length: 12 }, (_, i) => `export const L${i} = ${i};`).join("\n"));
  return dir;
}

afterEach(() => {
  for (const key of SF_FLAG_KEYS) delete process.env[key];
  resetAllSessions();
  for (const dir of tmpDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

const SF_FLAG_KEYS = [
  "TL_SEMANTIC_FRONTIER_GUARD", "TL_SF_STATEFUL", "TL_SF_DEMOTE",
  "TL_SF_STRUCTURAL_CONCERNS", "TL_SF_RELATION_PACKETS", "TL_SF_VERIFY_FIRST",
  "TL_SF_CONTINUATION_BUNDLE", "TL_CWD_NEAR_MISS", "TL_RECEIPT_COVERAGE",
  "TL_BATCH_HINTS", "TL_SEARCH_DEDUP", "TL_GRAPH_EVIDENCE",
] as const;

interface WireRow { handle?: string; path?: string; body?: string; prior?: string }

async function readPack(
  ws: string,
  args: Record<string, unknown>,
): Promise<{ kind?: string; limit?: { cause?: string }; evidence?: WireRow[] }> {
  const res = await callTool("read_file", { ...args, cwd: ws });
  return JSON.parse(res.content[0]?.text ?? "{}") as {
    kind?: string; limit?: { cause?: string }; evidence?: WireRow[];
  };
}

/** The two booked answers to "what did this session serve", as path sets. */
function bookedState(ws: string, query: string): { union: string[]; log: string[] } {
  return {
    union: [...getSession(ws).admissibleEditPaths],
    log: queryServedSurfaces(ws, ws, { epochTokens: tokenizeForEpoch(query) })
      .map((entry) => entry.path),
  };
}

// ---------------------------------------------------------------------------
// (1) The state sweep — in-process `callTool`, every SF flag off.
// ---------------------------------------------------------------------------

describe("FX-K: the cap-overflow sweep — the default path books only what it shipped", () => {
  /**
   * Ten `budget.bytes` points spanning refusal → all-bodies-stripped →
   * some-rows-spliced → everything ships. Round-15's differential sweep against
   * `8ea1eb52` showed the union and the log were IDENTICAL to the pre-trim list
   * at every point; the same sweep after FX-K books the shipped set at every
   * point, and the two disagree at exactly the cap-overflow points.
   */
  const BUDGET_POINTS = [4096, 6144, 8192, 10240, 12288, 16384, 20480, 26000, 40000, 0] as const;

  it("at EVERY budget point: booked ⊆ shipped-with-body, and shipped-with-body ⊆ booked", async () => {
    let sawBodylessShip = false;
    let sawFullShip = false;
    for (const bytes of BUDGET_POINTS) {
      resetAllSessions();
      const ws = mkWorkspace(`sweep-${bytes}`);
      const args: Record<string, unknown> = { query: QUERY, task: { profile: "generic", epoch: "new" } };
      if (bytes > 0) args["budget"] = { bytes };
      const pack = await readPack(ws, args);
      if (pack.kind !== "read.task_pack") continue; // 4096 refuses before it can build
      const rows = pack.evidence ?? [];
      const withBody = new Set(
        rows.filter((row) => typeof row.body === "string" && row.body.length > 0)
          .map((row) => row.path!)
          .filter((p): p is string => typeof p === "string"),
      );
      const anyRow = new Set(rows.map((row) => row.path).filter((p): p is string => typeof p === "string"));
      if (anyRow.size > 0 && withBody.size === 0) sawBodylessShip = true;
      if (withBody.size > 0) sawFullShip = true;

      const { union, log } = bookedState(ws, QUERY);
      // ⊆ : nothing booked that this response did not send bytes for. This is
      // the FX-K direction — the blind-edit credential.
      for (const booked of union) {
        expect(
          withBody.has(booked),
          `bytes=${bytes}: "${booked}" is edit-admissible but shipped no body `
          + `(rows with bodies: ${[...withBody].join(", ") || "none"})`,
        ).toBe(true);
      }
      for (const booked of log) {
        expect(
          withBody.has(booked),
          `bytes=${bytes}: "${booked}" is in the cumulative served log but shipped no body`,
        ).toBe(true);
      }
      // ⊇ : everything that DID ship stays editable. This is the T09/T10
      // direction — narrowing here would be the "the gate refuses a handle
      // this server itself served" regression.
      for (const shipped of withBody) {
        expect(union, `bytes=${bytes}: "${shipped}" shipped a body and must stay editable`)
          .toContain(shipped);
        expect(log, `bytes=${bytes}: "${shipped}" shipped a body and must be logged`)
          .toContain(shipped);
      }
    }
    expect(sawBodylessShip, "precondition: some budget point must ship rows with NO body").toBe(true);
    expect(sawFullShip, "precondition: some budget point must ship rows WITH bodies").toBe(true);
  }, 180000);

  it("never books a surface the cap spliced out of the response entirely", async () => {
    const ws = mkWorkspace("splice");
    // Three 60-function modules named by the request: at 8192 bytes the pack
    // reaches Phase F and drops a whole surface rather than only stripping
    // bodies (the eight-module pathless corpus above stops at Phase E).
    const targets = ["src/big_0.ts", "src/big_1.ts", "src/big_2.ts"];
    targets.forEach((rel, module) => {
      const lines = [`// module ${module}: orderTotal pricing surface`];
      for (let fn = 0; fn < 60; fn++) {
        lines.push(
          `export function bigOrderTotal_${module}_${fn}(qty: number, price: number): number {`,
          `  // pricing rule ${module}.${fn} for orderTotal`,
          `  return qty * price + ${fn};`,
          "}",
        );
      }
      fs.writeFileSync(path.join(ws, rel), `${lines.join("\n")}\n`, "utf8");
    });
    const pack = await readPack(ws, {
      query: "Update orderTotal pricing rules across the three pricing modules so quantity discounts apply.",
      targets: targets.map((p) => ({ path: p })),
      task: { profile: "generic", epoch: "new" },
      budget: { bytes: 8192 },
    });
    expect(pack.kind).toBe("read.task_pack");
    const shippedPaths = new Set((pack.evidence ?? []).map((row) => row.path));
    const spliced = targets.filter((p) => !shippedPaths.has(p));
    expect(spliced.length, "precondition: the byte budget must shed at least one whole surface")
      .toBeGreaterThan(0);
    const { union, log } = bookedState(ws, "Update orderTotal pricing rules across the three pricing modules so quantity discounts apply.");
    for (const p of spliced) {
      expect(union, `a surface the response never sent must not be editable: ${p}`).not.toContain(p);
      expect(log, `a surface the response never sent must not be logged: ${p}`).not.toContain(p);
    }
  }, 90000);

  it("a `code_unchanged` restatement keeps its path admissible — the caller holds those bytes", async () => {
    const ws = mkWorkspace("restate");
    const first = await readPack(ws, {
      query: QUERY,
      targets: [{ path: "src/pricing_0.ts" }],
      task: { profile: "generic", epoch: "new" },
    });
    expect(first.kind).toBe("read.task_pack");
    expect(bookedState(ws, QUERY).union).toContain("src/pricing_0.ts");
    // Same epoch, same target: the pack restates rather than re-sending.
    const again = await readPack(ws, {
      query: QUERY,
      targets: [{ path: "src/pricing_0.ts" }],
      task: { profile: "generic" },
    });
    const restated = (again.evidence ?? []).some((row) =>
      row.path === "src/pricing_0.ts" && (typeof row.prior === "string" || typeof row.body === "string"));
    expect(restated || again.kind === "read.receipt",
      "precondition: the second call must restate or receipt the same path").toBe(true);
    expect(
      bookedState(ws, QUERY).union,
      "a restatement is a legitimate 'you already hold these bytes' claim — it must not "
      + "withdraw edit authority the first serve granted",
    ).toContain("src/pricing_0.ts");
  }, 90000);
});

// ---------------------------------------------------------------------------
// (2) The production shape — spawned stdio server, real `edit_file`.
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TSX_CLI = path.resolve(HERE, "../../../../node_modules/tsx/dist/cli.mjs");
const BIN_TS = path.resolve(HERE, "../bin.ts");

interface RawResponse { isError: boolean; body: Record<string, unknown>; text: string }
interface ServerHandle {
  initialize(): Promise<void>;
  call(tool: string, args: Record<string, unknown>): Promise<RawResponse>;
  kill(): void;
}

function startServer(cwd: string, env: NodeJS.ProcessEnv): ServerHandle {
  const child: ChildProcess = spawn(
    process.execPath,
    [TSX_CLI, BIN_TS, cwd, "--allow-write"],
    { cwd, stdio: ["pipe", "pipe", "pipe"], env },
  );
  let stdout = "";
  let stderr = "";
  let nextId = 1;
  const waiters = new Map<number, (msg: unknown) => void>();
  child.stdout!.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    let nl = stdout.indexOf("\n");
    while (nl >= 0) {
      const line = stdout.slice(0, nl);
      stdout = stdout.slice(nl + 1);
      nl = stdout.indexOf("\n");
      if (line.trim() === "") continue;
      let msg: { id?: unknown };
      try {
        msg = JSON.parse(line) as { id?: unknown };
      } catch {
        continue;
      }
      const id = msg?.id;
      if (typeof id === "number" && waiters.has(id)) {
        const waiter = waiters.get(id)!;
        waiters.delete(id);
        waiter(msg);
      }
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const rpc = (method: string, params: unknown): Promise<unknown> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`rpc '${method}' timed out\n${stderr}`));
      }, 90000);
      waiters.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };
  return {
    async initialize() {
      await rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "sf-cap-overflow", version: "0" },
      });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    },
    async call(tool, args) {
      const raw = await rpc("tools/call", { name: tool, arguments: args });
      const result = (raw as { result?: { content?: Array<{ text?: unknown }>; isError?: unknown } })?.result;
      const content = result?.content;
      const text = Array.isArray(content) && content[0]?.text !== undefined ? String(content[0]!.text) : "";
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        /* a non-JSON body stays empty; the assertions name the shape */
      }
      return { isError: result?.isError === true, body, text };
    },
    kill() {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    },
  };
}

/** `only === undefined` ⇒ every SF flag OFF (the shipped default). */
function spawnEnv(only?: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TOKENLIGHTEN_ALLOWED_PARENTS: os.homedir(),
    TL_LEGACY_INPUT: "accept",
  };
  for (const key of SF_FLAG_KEYS) delete env[key];
  for (const key of only ?? []) env[key] = "1";
  return env;
}

const editArgs = (target: Record<string, unknown>, search: string): Record<string, unknown> => ({
  edits: [{ ...target, search, replace: `${search} // FX-K`, precondition: "unique-match", allowPathFallback: false }],
});

describe("FX-K: a bodyless-shipped file is not editable, in the production call shape", () => {
  /**
   * Round-15's `r15_k`, verbatim in shape, with every SF flag OFF. The second
   * call is what makes the fence live: the first pack alone installs no
   * prepared certificate, so an edit against it is ungated for reasons that
   * have nothing to do with booking (and the control would apply too).
   */
  it("flag off: the capped pack's bodyless path refuses, the never-packed control refuses", async () => {
    const ws = mkWorkspace("e2e-capped");
    const srv = startServer(ws, spawnEnv());
    try {
      await srv.initialize();
      const first = await srv.call("read_file", {
        query: QUERY,
        task: { profile: "generic", epoch: "new" },
        budget: { bytes: 6144 },
        cwd: ws,
      });
      expect(first.body["kind"]).toBe("read.task_pack");
      expect((first.body["limit"] as { cause?: string } | undefined)?.cause,
        "precondition: the budget must actually cap this pack").toBe("capped");
      const rows = (first.body["evidence"] as WireRow[] | undefined) ?? [];
      const bodyless = rows.find((row) =>
        typeof row.path === "string" && row.path.startsWith("src/pricing_")
        && (row.body === undefined || row.body === ""));
      expect(bodyless?.path, "precondition: the cap must ship a pricing row with no body").toBeDefined();

      // Same epoch, a prepared fence over an unrelated anchor file.
      await srv.call("read_file", {
        query: ANCHOR_QUERY,
        targets: [{ path: ANCHOR }],
        task: { profile: "generic" },
        cwd: ws,
      });

      const blind = await srv.call("edit_file", { ...editArgs({ path: bodyless!.path! }, EDIT_ANCHOR), cwd: ws });
      expect(
        blind.body["kind"],
        `editing ${bodyless!.path} — a file this session sent NO bytes for — must refuse`,
      ).toBe("refusal");
      expect(blind.body["code"]).toBe("execution-typestate");
      // The row is still ADDRESSABLE for reads: FX-K withdraws write authority,
      // not the handle.
      const zoom = await srv.call("read_file", { handle: bodyless!.handle, cwd: ws });
      expect(zoom.body["kind"], "a bodyless-shipped row must still be readable by handle")
        .not.toBe("refusal");

      const control = await srv.call("edit_file", {
        ...editArgs({ path: CONTROL }, "export const L1 = 1;"), cwd: ws,
      });
      expect(control.body["kind"], "control: a never-packed file refuses at the same fence")
        .toBe("refusal");
      expect(control.body["code"]).toBe("execution-typestate");
    } finally {
      srv.kill();
    }
  }, 180000);

  /**
   * The discriminating control for the case above: the SAME sequence with a
   * budget that lets the bodies ship. If FX-K had narrowed the union too far,
   * this is the T09/T10 regression it would show up as.
   */
  it("flag off: the SAME sequence APPLIES when the pack ships the body", async () => {
    const ws = mkWorkspace("e2e-uncapped");
    const srv = startServer(ws, spawnEnv());
    try {
      await srv.initialize();
      const first = await srv.call("read_file", {
        query: QUERY,
        targets: [{ path: "src/pricing_1.ts" }],
        task: { profile: "generic", epoch: "new" },
        cwd: ws,
      });
      expect(first.body["kind"]).toBe("read.task_pack");
      const served = ((first.body["evidence"] as WireRow[] | undefined) ?? [])
        .find((row) => row.path === "src/pricing_1.ts" && typeof row.body === "string" && row.body.length > 0);
      expect(served, "precondition: pricing_1 must ship a body here").toBeDefined();

      await srv.call("read_file", {
        query: ANCHOR_QUERY,
        targets: [{ path: ANCHOR }],
        task: { profile: "generic" },
        cwd: ws,
      });

      const applied = await srv.call("edit_file", {
        ...editArgs({ path: "src/pricing_1.ts" }, EDIT_ANCHOR), cwd: ws,
      });
      expect(
        applied.body["kind"],
        "a file whose bytes this session DID send stays editable — narrowing this is the "
        + "T09/T10 'the gate refuses a handle this server itself served' regression",
      ).toBe("edit.applied");
    } finally {
      srv.kill();
    }
  }, 180000);
});

describe("FX-K: a SAME-CALL demoted surface refuses by handle and by path", () => {
  /**
   * Round-15's `r15_c`. One `generic` pack both demotes surfaces and installs a
   * prepared fence, so the demotion and the certificate come from the same
   * response — the shape FX-I-A's nominate/book split could not close.
   *
   * The ten-flag env is load-bearing: with only `TL_SF_STATEFUL` +
   * `TL_SF_DEMOTE` this fixture demotes nothing (the supporting surfaces are
   * not even packed), so a two-flag version of this case would pass vacuously.
   */
  it("ten flags on: every bodyless row refuses both shapes; a body-bearing row is not asserted editable by this case", async () => {
    const ws = mkWorkspace("same-call");
    fs.writeFileSync(path.join(ws, "src/sensor.hpp"), [
      "#pragma once", "namespace acme {", "class Sensor {", "public:",
      "    bool isHealthy() const;", "};", "}", "",
    ].join("\n"), "utf8");
    fs.writeFileSync(path.join(ws, "src/sensor.cpp"), [
      '#include "sensor.hpp"', "namespace acme {", "bool Sensor::isHealthy() const {",
      "    return true;", "}", "}", "",
    ].join("\n"), "utf8");
    fs.writeFileSync(path.join(ws, "src/monitor.cpp"), [
      '#include "sensor.hpp"', "namespace acme {", "void checkAll(const Sensor& s) {",
      "    if (!s.isHealthy()) {", "        // alert", "    }", "}", "}", "",
    ].join("\n"), "utf8");
    fs.writeFileSync(path.join(ws, "src/supporting_notes.ts"), [
      "export const SUPPORTING_NOTE = 'supporting lexical context';",
      "export const CONTINUATION_NOTE = 'continuation relation';",
    ].join("\n"), "utf8");
    fs.mkdirSync(path.join(ws, "tests"), { recursive: true });
    fs.writeFileSync(path.join(ws, "tests/sensor_test.cpp"), [
      '#include "../src/sensor.hpp"', "int main() {", "    acme::Sensor s;",
      "    return s.isHealthy() ? 0 : 1;", "}", "",
    ].join("\n"), "utf8");

    const srv = startServer(ws, spawnEnv(SF_FLAG_KEYS.filter((k) => k !== "TL_SEMANTIC_FRONTIER_GUARD")));
    try {
      await srv.initialize();
      const pack = await srv.call("read_file", {
        query: "Update Sensor::isHealthy and the continuation relation supporting context notes.",
        task: { profile: "generic", epoch: "new" },
        cwd: ws,
      });
      expect(pack.body["kind"]).toBe("read.task_pack");
      const rows = (pack.body["evidence"] as WireRow[] | undefined) ?? [];
      const bodyless = rows.filter((row) =>
        typeof row.path === "string" && (row.body === undefined || row.body === ""));
      expect(bodyless.length, "precondition: the ten-flag pack must demote at least one surface")
        .toBeGreaterThan(0);
      for (const row of bodyless) {
        const search = row.path!.endsWith(".cpp") ? "return true;" : "bool isHealthy() const;";
        const byHandle = await srv.call("edit_file", { ...editArgs({ handle: row.handle }, search), cwd: ws });
        expect(byHandle.body["kind"], `same-call demoted ${row.path} must refuse by handle`).toBe("refusal");
        expect(byHandle.body["code"]).toBe("execution-typestate");
        const byPath = await srv.call("edit_file", { ...editArgs({ path: row.path }, search), cwd: ws });
        expect(byPath.body["kind"], `same-call demoted ${row.path} must refuse by path`).toBe("refusal");
        expect(byPath.body["code"]).toBe("execution-typestate");
      }
      const control = await srv.call("edit_file", {
        ...editArgs({ path: CONTROL }, "export const L1 = 1;"), cwd: ws,
      });
      expect(control.body["kind"], "control: a never-packed file refuses too").toBe("refusal");
    } finally {
      srv.kill();
    }
  }, 240000);
});
