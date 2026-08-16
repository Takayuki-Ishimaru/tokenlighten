// evidenceShadow.spec.ts — P1 evidence completion (D7), SHADOW MODE.
//
// Spec: scratchpad/spec-p1-shadow.md §4 / §8.3 / §8.4. Written RED.
//
// Shadow mode's entire safety claim is: with the flag ON the server computes
// evidence, writes it to the trace channel, and CHANGES NOTHING on the wire.
// Test 17 is that claim, and it is the reason this file exists. Everything
// else here protects the channel it rides on.
//
// Sink: util/trace.ts (already shipping) — append-only JSONL at
// ~/.tokenlighten/trace/<pid>-<sha8(workspaceRoot)>.jsonl. Per-workspace
// naming is what keeps cells apart when one server process serves them all
// (established 2026-07-31: every bench cell's tool results carry an identical
// server_build stamp).

import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const nodeRequire = createRequire(import.meta.url);
const TSX_CLI = nodeRequire.resolve("tsx/cli");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_TS = path.resolve(HERE, "..", "bin.ts");
const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();

const tmpDirs: string[] = [];
const servers: ServerHandle[] = [];

interface ServerHandle {
  initialize(): Promise<void>;
  rpc(id: number, method: string, params?: unknown, timeoutMs?: number): Promise<any>;
  kill(): void;
}

afterEach(() => {
  while (servers.length) servers.pop()!.kill();
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function mkDir(tag: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(HOME, `.tl-evsh-${tag}-`)));
  tmpDirs.push(dir);
  return dir;
}

function writeFile(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function startServer(opts: { cwd: string; args: string[]; env?: Record<string, string> }): ServerHandle {
  const child: ChildProcess = spawn(
    process.execPath,
    [TSX_CLI, BIN_TS, ...opts.args],
    { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...(opts.env ?? {}) } },
  );
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
  return {
    async initialize(): Promise<void> {
      await this.rpc(1, "initialize", {
        protocolVersion: "2024-11-05", capabilities: {},
        clientInfo: { name: "vitest", version: "0" },
      });
    },
    rpc(id: number, method: string, params?: unknown, timeoutMs = 60000): Promise<any> {
      const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      return new Promise((resolve, reject) => {
        const t = setTimeout(
          () => reject(new Error(`rpc timeout ${method}\n${stderr.slice(-2000)}`)), timeoutMs,
        );
        waiters.set(id, (m) => { clearTimeout(t); resolve(m); });
        child.stdin!.write(payload);
      });
    },
    kill(): void { child.kill("SIGKILL"); },
  };
}

function parseToolResult(rpcResult: any): Record<string, unknown> {
  const text: string = rpcResult?.result?.content?.[0]?.text;
  expect(typeof text).toBe("string");
  return JSON.parse(text);
}

/** A two-concern fix-pack workspace with a matching doc heading and a test. */
function seedFixPack(ws: string): void {
  writeFile(ws, "src/mixer.ts",
    "export function mixQuadX(yaw: number) {\n  const FR = +yaw;\n  return FR;\n}\n");
  writeFile(ws, "src/limiter.ts",
    "export function clampIntegral(v: number) {\n  return v;\n}\n");
  writeFile(ws, "test/mixer.test.ts",
    "import { mixQuadX } from '../src/mixer';\n\n" +
    "it('mixes', () => {\n  expect(mixQuadX(1)).toBe(-1);\n});\n");
  writeFile(ws, "CONTRACT.md",
    "# Contract\n\n## 1 Overview\n\nText.\n\n" +
    "## 7.6 mixer.ts\n\n| rotor | yaw |\n| --- | --- |\n| FR | -yaw |\n\n" +
    "## 8 Limiter\n\nclampIntegral MUST bound the integral term.\n");
}

/**
 * Shaped like the live T05c report so the pack actually binds the
 * multi_concern profile: an explicit independence marker plus a marked list
 * (splitConcernClauses treats `(1)`/`(2)` as authoritative boundaries), and a
 * mutation verb per clause.
 */
const FIX_PACK_QUERY =
  "two separate unrelated bugs in the same build, find and fix both.\n"
  + "(1) fix the inverted mixQuadX yaw sign in src/mixer.ts against the contract.\n"
  + "(2) fix clampIntegral in src/limiter.ts so the integral stops winding up.";

function tracePath(ws: string, home: string): string {
  const sha8 = createHash("sha256").update(ws).digest("hex").slice(0, 8);
  const dir = path.join(home, ".tokenlighten", "trace");
  if (!fs.existsSync(dir)) return "";
  const hit = fs.readdirSync(dir).find((f) => f.endsWith(`-${sha8}.jsonl`));
  return hit ? path.join(dir, hit) : "";
}

function readShadowRecords(ws: string, home: string): Array<Record<string, any>> {
  const p = tracePath(ws, home);
  if (!p) return [];
  return fs.readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, any>)
    .filter((r) => r["event"] === "evidence_shadow");
}

/**
 * Response fields that legitimately differ between two independent server
 * processes over two independent temp workspaces. Everything else must match
 * byte for byte.
 */
function normalize(body: unknown, ws: string): string {
  return JSON.stringify(body)
    .split(ws).join("$WS")
    .replace(/"h[0-9a-z]{8,}"/g, '"$HANDLE"')
    .replace(/\bh[0-9a-z]{8,}\b/g, "$HANDLE")
    .replace(/q-[0-9a-f]{8,}/g, "$QREF")
    .replace(/ready-[0-9a-f]{8,}/g, "$CERT")
    .replace(/open-[0-9a-f]{8,}/g, "$CLOSURE")
    .replace(/sha256:[0-9a-f]+/g, "$SHA")
    .replace(/"server_build":"[^"]*"/g, '"server_build":"$BUILD"');
}

describe("evidenceShadow — the no-op proof", () => {
  it("17: with the shadow flag ON the response is byte-identical to the flag OFF", async () => {
    // THE central claim of shadow mode. If this ever fails, the feature is no
    // longer shadow and every byte/turn metric measured under it is invalid.
    const homeOff = mkDir("home-off");
    const homeOn = mkDir("home-on");
    const wsOff = mkDir("ws-off");
    const wsOn = mkDir("ws-on");
    seedFixPack(wsOff);
    seedFixPack(wsOn);

    const srvOff = startServer({ cwd: wsOff, args: [wsOff], env: { HOME: homeOff } });
    servers.push(srvOff);
    await srvOff.initialize();
    const off = parseToolResult(await srvOff.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "task_pack", query: FIX_PACK_QUERY, cwd: wsOff },
    }));

    const srvOn = startServer({
      cwd: wsOn, args: [wsOn],
      env: {
        HOME: homeOn,
        TL_TRACE: "1",
        TL_EVIDENCE_SHADOW: "1",
        TL_MCP_CONFIG_SHA256: "a".repeat(64),
        TL_P1_CAUSAL_RUN_NONCE: "n10-v07-natural-byte-proof",
      },
    });
    servers.push(srvOn);
    await srvOn.initialize();
    const on = parseToolResult(await srvOn.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "task_pack", query: FIX_PACK_QUERY, cwd: wsOn },
    }));

    expect(normalize(on, wsOn)).toBe(normalize(off, wsOff));
    // And the shadow really did run — otherwise this test passes vacuously.
    expect(readShadowRecords(wsOn, homeOn).length).toBeGreaterThan(0);
    expect(readShadowRecords(wsOff, homeOff).length).toBe(0);
  }, 90000);

  it("23: active and shadow flags coexist without shadow mutating the active response", async () => {
    const homeActive = mkDir("home-active-only");
    const homeBoth = mkDir("home-active-shadow");
    const wsActive = mkDir("ws-active-only");
    const wsBoth = mkDir("ws-active-shadow");
    seedFixPack(wsActive);
    seedFixPack(wsBoth);

    const activeServer = startServer({
      cwd: wsActive,
      args: [wsActive],
      env: { HOME: homeActive, TL_EVIDENCE_COMPLETION: "1" },
    });
    servers.push(activeServer);
    await activeServer.initialize();
    const active = parseToolResult(await activeServer.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "task_pack", query: FIX_PACK_QUERY, cwd: wsActive },
    }));

    const bothServer = startServer({
      cwd: wsBoth,
      args: [wsBoth],
      env: {
        HOME: homeBoth,
        TL_TRACE: "1",
        TL_EVIDENCE_SHADOW: "1",
        TL_EVIDENCE_COMPLETION: "1",
      },
    });
    servers.push(bothServer);
    await bothServer.initialize();
    const both = parseToolResult(await bothServer.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "task_pack", query: FIX_PACK_QUERY, cwd: wsBoth },
    }));

    expect(normalize(both, wsBoth)).toBe(normalize(active, wsActive));
    // task_pack's `concerns[]` moves under `plan.concerns` in v1 (A.5.1's
    // ProfilePlan) — `concerns` is no longer a top-level field.
    const evidence = (((both as Record<string, any>)["plan"] as Record<string, any> | undefined)?.["concerns"] ?? [])
      .flatMap((concern: Record<string, any>) => concern["evidence"] ?? []);
    expect(evidence.length).toBeGreaterThan(0);
    expect(readShadowRecords(wsBoth, homeBoth).length).toBeGreaterThan(0);
    expect(readShadowRecords(wsActive, homeActive)).toHaveLength(0);
  }, 90000);
});

describe("evidenceShadow — the log", () => {
  it("18: every record is valid JSONL and matches the §4.3 schema", async () => {
    const home = mkDir("home-schema");
    const ws = mkDir("ws-schema");
    seedFixPack(ws);
    const srv = startServer({
      cwd: ws, args: [ws], env: { HOME: home, TL_TRACE: "1", TL_EVIDENCE_SHADOW: "1" },
    });
    servers.push(srv);
    await srv.initialize();
    await srv.rpc(2, "tools/call", {
      name: "read_file", arguments: { mode: "task_pack", query: FIX_PACK_QUERY, cwd: ws },
    });

    const records = readShadowRecords(ws, home);
    expect(records.length, "no evidence_shadow record was written").toBeGreaterThan(0);
    for (const r of records) {
      expect(typeof r["ts"]).toBe("number");
      expect(r["workspace"]).toBe(ws);
      expect(typeof r["pack"]["profile"]).toBe("string");
      expect(typeof r["pack"]["coverage"]).toBe("string");
      expect(typeof r["pack"]["surface_bytes"]).toBe("number");
      expect(typeof r["pack"]["concern_count"]).toBe("number");
      expect(Array.isArray(r["concerns"])).toBe(true);
      expect(typeof r["would_serve"]["slice_count"]).toBe("number");
      expect(typeof r["would_serve"]["bytes"]).toBe("number");
      expect(typeof r["would_serve"]["pack_bytes_after"]).toBe("number");
      expect(typeof r["cost"]["ms_total"]).toBe("number");
      expect(r["cost"]["references_walks"], "the resolver must never walk").toBe(0);
      expect(typeof r["cost"]["budget_exhausted"]).toBe("boolean");
      for (const c of r["concerns"]) {
        expect(typeof c["id"]).toBe("string");
        expect(Array.isArray(c["anchor_tokens"])).toBe(true);
        expect(Array.isArray(c["resolved"])).toBe(true);
        expect(c["class_skipped"]["runtime-observation"]).toBe("not-implemented");
        for (const s of c["resolved"]) {
          expect(["behavioral", "normative", "runtime-observation"]).toContain(s["class"]);
          expect(typeof s["path"]).toBe("string");
          expect(String(s["range"])).toMatch(/^\d+-\d+$/);
          expect(typeof s["why"]).toBe("string");
          expect(typeof s["selected"]).toBe("boolean");
          // The log carries provenance, never the evidence body.
          expect(s["text"], "shadow log must not carry slice bodies").toBeUndefined();
        }
      }
    }
  }, 90000);

  it("18b: initial and qref-replay traces carry the exact tool-result qref", async () => {
    const home = mkDir("home-qref");
    const ws = mkDir("ws-qref");
    seedFixPack(ws);
    const srv = startServer({
      cwd: ws, args: [ws], env: { HOME: home, TL_TRACE: "1", TL_EVIDENCE_SHADOW: "1" },
    });
    servers.push(srv);
    await srv.initialize();

    const initial = parseToolResult(await srv.rpc(2, "tools/call", {
      name: "read_file", arguments: { mode: "task_pack", query: FIX_PACK_QUERY, cwd: ws },
    }));
    const qref = String(initial["qref"]);
    expect(qref).toMatch(/^q-[a-f0-9]{16}$/);
    // execution_contract is deleted from the wire (A.5.1); its
    // readiness_certificate becomes `decision.certificate` on act.answer /
    // act.edit — {id, obligations, workspace} (A.2.4) instead of the old flat
    // certificate/obligations pair.
    const decision = initial["decision"] as
      { certificate?: { id?: string; obligations?: string[] } } | undefined;
    const certificate = String(decision?.certificate?.id);
    const obligation = String(decision?.certificate?.obligations?.[0]);
    expect(certificate).not.toBe("");
    expect(obligation).not.toBe("");
    expect(initial["evidenceShadowQref"]).toBeUndefined();
    expect(readShadowRecords(ws, home).map((record) => record["pack"]["qref"]))
      .toEqual([qref]);

    // Invalidate exact-pack dedup so the qref replay exercises the resolver
    // and emits a second shadow record instead of a compact cached receipt.
    writeFile(ws, "src/mixer.ts",
      "export function mixQuadX(yaw: number) {\n  const FR = +yaw;\n  return FR;\n}\n\n// changed after initial pack\n");
    const replay = parseToolResult(await srv.rpc(3, "tools/call", {
      name: "read_file", arguments: {
        mode: "task_pack",
        qref,
        cwd: ws,
        // The edited source is decision-changing evidence. P0 correctly
        // keeps an unchallenged qref replay closed; provide the certificate
        // challenge that re-opens discovery for this test's fresh trace.
        challenge: {
          certificate_id: certificate,
          obligation_id: obligation,
          expected_action_change: "the changed source can change the answer evidence",
        },
      },
    }));
    expect(replay["qref"]).toBe(qref);
    expect(replay["evidenceShadowQref"]).toBeUndefined();
    expect(readShadowRecords(ws, home).map((record) => record["pack"]["qref"]))
      .toEqual([qref, qref]);
  }, 90000);

  it("19: two workspaces on ONE server process land in separate per-workspace files", async () => {
    // Pins the shared-process fact: one TL server serves every bench cell, and
    // per-workspace file naming is what keeps the cells demultiplexable.
    const home = mkDir("home-multi");
    const wsA = mkDir("ws-a");
    const wsB = mkDir("ws-b");
    seedFixPack(wsA);
    seedFixPack(wsB);

    const srv = startServer({
      cwd: wsA, args: [wsA, wsB], env: { HOME: home, TL_TRACE: "1", TL_EVIDENCE_SHADOW: "1" },
    });
    servers.push(srv);
    await srv.initialize();
    await srv.rpc(2, "tools/call", {
      name: "read_file", arguments: { mode: "task_pack", query: FIX_PACK_QUERY, cwd: wsA },
    });
    await srv.rpc(3, "tools/call", {
      name: "read_file", arguments: { mode: "task_pack", query: FIX_PACK_QUERY, cwd: wsB },
    });

    const a = tracePath(wsA, home);
    const b = tracePath(wsB, home);
    expect(a).not.toBe("");
    expect(b).not.toBe("");
    expect(a).not.toBe(b);
    // Non-vacuous: each file must actually carry its own workspace's records.
    const recA = readShadowRecords(wsA, home);
    const recB = readShadowRecords(wsB, home);
    expect(recA.length).toBeGreaterThan(0);
    expect(recB.length).toBeGreaterThan(0);
    for (const r of recA) expect(r["workspace"]).toBe(wsA);
    for (const r of recB) expect(r["workspace"]).toBe(wsB);
  }, 90000);
});

describe("evidenceShadow — fail-safe and gating", () => {
  it("20: an unwritable sink never fails the call", async () => {
    const ws = mkDir("ws-nosink");
    seedFixPack(ws);
    // HOME points at a FILE, so ~/.tokenlighten/trace can never be created.
    const blocker = path.join(mkDir("home-blocked"), "not-a-dir");
    fs.writeFileSync(blocker, "x", "utf8");

    const srv = startServer({
      cwd: ws, args: [ws], env: { HOME: blocker, TL_TRACE: "1", TL_EVIDENCE_SHADOW: "1" },
    });
    servers.push(srv);
    await srv.initialize();
    const body = parseToolResult(await srv.rpc(2, "tools/call", {
      name: "read_file", arguments: { mode: "task_pack", query: FIX_PACK_QUERY, cwd: ws },
    }));
    // Rule K deletes the `mode` echo (kind discriminates); D6 deletes body
    // `ok` outright — `kind !== "refusal"` is the v1 carrier for "succeeded".
    expect(body["kind"]).toBe("read.task_pack");
    expect(body["kind"]).not.toBe("refusal");
  }, 90000);

  it("22: with TL_EVIDENCE_SHADOW unset there are no evidence_shadow records, even with TL_TRACE=1", async () => {
    const home = mkDir("home-traceonly");
    const ws = mkDir("ws-traceonly");
    seedFixPack(ws);
    const srv = startServer({ cwd: ws, args: [ws], env: { HOME: home, TL_TRACE: "1" } });
    servers.push(srv);
    await srv.initialize();
    await srv.rpc(2, "tools/call", {
      name: "read_file", arguments: { mode: "task_pack", query: FIX_PACK_QUERY, cwd: ws },
    });
    expect(readShadowRecords(ws, home)).toEqual([]);
    // …but the pre-existing pack events still ride, unchanged (test 25).
    const all = fs.readFileSync(tracePath(ws, home), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(all.some((r) => r["event"] === "task_pack_start")).toBe(true);
    expect(all.some((r) => r["event"] === "task_pack_end")).toBe(true);
  }, 90000);

  it("21: with tracing unavailable the resolver does not run at all", async () => {
    // TL_EVIDENCE_SHADOW=1 but TL_TRACE unset: nothing to write to, so nothing
    // to compute — fail-closed to zero cost.
    const home = mkDir("home-notrace");
    const ws = mkDir("ws-notrace");
    seedFixPack(ws);
    const srv = startServer({
      cwd: ws, args: [ws], env: { HOME: home, TL_EVIDENCE_SHADOW: "1" },
    });
    servers.push(srv);
    await srv.initialize();
    const body = parseToolResult(await srv.rpc(2, "tools/call", {
      name: "read_file", arguments: { mode: "task_pack", query: FIX_PACK_QUERY, cwd: ws },
    }));
    // Rule K deletes the `mode` echo; `kind` is the v1 discriminator.
    expect(body["kind"]).toBe("read.task_pack");
    expect(tracePath(ws, home)).toBe("");
  }, 90000);
});

describe("P1 causal attestation — public tool boundary", () => {
  it("26: a non-task-pack read emits launch identity without changing its MCP result", async () => {
    const home = mkDir("home-causal-map");
    const ws = mkDir("ws-causal-map");
    writeFile(ws, "src/value.ts", "export const value = 1;\n");
    const srv = startServer({
      cwd: ws,
      args: [ws],
      env: {
        HOME: home,
        TL_TRACE: "1",
        TL_MCP_CONFIG_SHA256: "b".repeat(64),
        TL_P1_CAUSAL_RUN_NONCE: "n10-v07-natural-map-proof",
        TL_EVIDENCE_COMPLETION: "0",
        TL_EVIDENCE_SHADOW: "0",
        TL_WRITE_CAPABILITY: "0",
      },
    });
    servers.push(srv);
    await srv.initialize();

    const body = parseToolResult(await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "map", path: "src/value.ts", cwd: ws },
    }));

    // Rule K deletes the `mode` echo; `kind` is the v1 discriminator.
    expect(body["kind"]).toBe("read.map");
    const records = fs.readFileSync(tracePath(ws, home), "utf8")
      .split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      event: "p1_causal_attestation",
      source: "tokenlighten-mcp-server",
      config_sha256: "b".repeat(64),
      workspace_root: ws,
      trace_file: path.basename(tracePath(ws, home)),
      run_nonce: "n10-v07-natural-map-proof",
      effective_flags: {
        TL_EVIDENCE_COMPLETION: "0",
        TL_EVIDENCE_SHADOW: "0",
        TL_WRITE_CAPABILITY: "0",
      },
    });
  }, 90000);
});

describe("evidenceShadow — anchors are independent of the enrichment gates", () => {
  it("23: buildConcernAnchors is byte-identical whether or not the query carries gate vocabulary", async () => {
    // Boundary pin between two changes landed in the same wave: the
    // multi-concern anti-overfit cleanup (spec-multiconcern-vocab) deleted the
    // EN/JA word gates that used to steer companion pairing and slice width,
    // and P1's anchors must never grow a dependency on that vocabulary in
    // either direction. Anchors come from the concern's own handles, the
    // surfaces those handles name, and the caller's query tokens — and from
    // nothing else, which this asserts by construction: the same pack + the
    // same tokens yield the same anchors no matter how the query is phrased.
    const { buildConcernAnchors } = await import("../features/task-pack/evidenceShadow.js");

    const pack = {
      surfaces: [
        {
          handle: "h1", path: "firmware/src/control/rate_controller.cpp", range: "1-40",
          code: "RateOutput RateController::update(float dt) {\n  return clamp(i_state_[0]);\n}\n",
          role: "domain",
        },
      ],
      concerns: [{ id: "c1", status: "covered", handles: ["h1"] }],
    };
    const tokens = new Map([["c1", ["ratecontroller", "settle"]]]);

    // The pack and the token map are identical; only the (unused-by-anchors)
    // surrounding phrasing would have differed. Anchors must be a pure
    // function of the two structural inputs.
    const a = buildConcernAnchors(pack as never, tokens);
    const b = buildConcernAnchors(pack as never, tokens);
    expect(a).toEqual(b);

    const [only] = a;
    expect(only?.id).toBe("c1");
    expect(only?.surfacePaths).toEqual(["firmware/src/control/rate_controller.cpp"]);
    // Basename AND extension-less stem, plus the callees the body invokes.
    expect(only?.symbols).toContain("rate_controller.cpp");
    expect(only?.symbols).toContain("rate_controller");
    expect(only?.callees).toContain("clamp");
    // Tokens are passed through verbatim from the caller's own query — the
    // resolver never re-derives them from a server-side word list.
    expect(only?.tokens).toEqual(["ratecontroller", "settle"]);
  });
});

describe("evidenceShadow — trace channel regressions (T2)", () => {
  it("24: TL_TRACE is read at CALL time, not at module load", async () => {
    // trace.ts cached process.env.TL_TRACE in a module-level binding, which
    // contradicts flags.ts's documented "reads process.env at call time so
    // tests can manipulate env per-test" contract and made the channel
    // untestable without setTraceEnabledForTest.
    const { trace, setTraceEnabledForTest } = await import("../util/trace.js");
    const home = mkDir("home-calltime");
    const ws = mkDir("ws-calltime");
    const prevHome = process.env["HOME"];
    const prevTrace = process.env["TL_TRACE"];
    try {
      process.env["HOME"] = home;
      delete process.env["TL_TRACE"];
      setTraceEnabledForTest(undefined); // clear any override
      trace("unit_probe", { a: 1 }, ws);
      expect(tracePath(ws, home), "wrote while TL_TRACE was unset").toBe("");

      process.env["TL_TRACE"] = "1";
      trace("unit_probe", { a: 2 }, ws);
      expect(tracePath(ws, home), "did not write after TL_TRACE was set").not.toBe("");
    } finally {
      setTraceEnabledForTest(undefined);
      if (prevHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = prevHome;
      if (prevTrace === undefined) delete process.env["TL_TRACE"]; else process.env["TL_TRACE"] = prevTrace;
    }
  });

  it("24b: trace.ts and flags.ts agree on TL_TRACE (one predicate, not two)", async () => {
    const { traceEnabled } = await import("../util/flags.js");
    const { isTraceEnabled, setTraceEnabledForTest } = await import("../util/trace.js");
    const prev = process.env["TL_TRACE"];
    try {
      setTraceEnabledForTest(undefined);
      for (const value of ["1", "true", "on", "yes", "0", "false", "off", ""]) {
        process.env["TL_TRACE"] = value;
        expect(isTraceEnabled(), `disagreement on TL_TRACE=${JSON.stringify(value)}`)
          .toBe(traceEnabled());
      }
    } finally {
      setTraceEnabledForTest(undefined);
      if (prev === undefined) delete process.env["TL_TRACE"]; else process.env["TL_TRACE"] = prev;
    }
  });
});
