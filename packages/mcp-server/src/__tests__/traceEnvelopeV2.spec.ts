/**
 * traceEnvelopeV2.spec.ts — V10-02 Telemetry v2 envelope, hermetic unit tests.
 *
 * Exercises util/trace.ts's enrichment directly (runWithTraceCall/
 * setTraceContext/trace()), without spawning a subprocess or going through
 * server.ts's callTool dispatch — the dispatch-integrated path (repeated_query
 * resolving a REAL qref, etc.) is covered separately by
 * observationEventsV2.spec.ts's in-process callTool tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  trace,
  getTracePath,
  setTraceEnabledForTest,
  runWithTraceCall,
  setTraceContext,
  resetTraceCallIdForTest,
} from "../util/trace.js";
import { workspaceRefOf } from "../state/handleCodec.js";
import { activeExperimentFlags } from "../util/flags.js";

let tmpHome: string;
let origHome: string | undefined;
let origCausalEnv: Record<string, string | undefined>;

const WS_ROOT = "/workspace/envelope-project";

// Mirrors trace.spec.ts's own CAUSAL_ENV_KEYS: these two vars make
// traceCausalAttestation emit a p1_causal_attestation record on the FIRST
// trace() call of a (pid, workspace) pair. Left set, they leak into whatever
// test runs next and prepend an extra record ahead of the ordinary events a
// positional readEventRecords() assertion expects.
const CAUSAL_ENV_KEYS = ["TL_MCP_CONFIG_SHA256", "TL_P1_CAUSAL_RUN_NONCE"] as const;

function readRecords(ws = WS_ROOT): Array<Record<string, unknown>> {
  const p = getTracePath(ws);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Ordinary event records only — filters out the launch attestation so
 *  positional destructuring in a test is never fragile to whether THIS
 *  process already attested this trace file. */
function readEventRecords(ws = WS_ROOT): Array<Record<string, unknown>> {
  return readRecords(ws).filter((r) => r["event"] !== "p1_causal_attestation");
}

beforeEach(() => {
  origHome = process.env.HOME;
  origCausalEnv = {};
  for (const key of CAUSAL_ENV_KEYS) {
    origCausalEnv[key] = process.env[key];
    delete process.env[key];
  }
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tl-envelope-test-"));
  process.env.HOME = tmpHome;
  setTraceEnabledForTest(true);
  resetTraceCallIdForTest();
});

afterEach(() => {
  if (origHome !== undefined) process.env.HOME = origHome;
  else delete process.env.HOME;
  for (const key of CAUSAL_ENV_KEYS) {
    if (origCausalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = origCausalEnv[key];
  }
  setTraceEnabledForTest(false);
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("trace envelope — always-present fields", () => {
  it("every record carries trace_id, flags_active, workspaceRef, protocol_era", () => {
    trace("some_event", { foo: 1 }, WS_ROOT);
    const [record] = readEventRecords();
    expect(typeof record!["trace_id"]).toBe("string");
    expect((record!["trace_id"] as string).length).toBeGreaterThan(0);
    expect(Array.isArray(record!["flags_active"])).toBe(true);
    expect(record!["workspaceRef"]).toBe(workspaceRefOf(WS_ROOT));
    expect(typeof record!["protocol_era"]).toBe("string");
  });

  it("workspaceRef is the existing sha-derived ref, never the raw workspace path", () => {
    trace("some_event", {}, WS_ROOT);
    const [record] = readEventRecords();
    expect(record!["workspaceRef"]).not.toContain(WS_ROOT);
    expect(record!["workspaceRef"]).toMatch(/^[0-9a-f]+$/);
  });

  it("trace_id is stable across multiple calls within the same process", () => {
    trace("event_a", {}, WS_ROOT);
    trace("event_b", {}, WS_ROOT);
    const [a, b] = readEventRecords();
    expect(a!["trace_id"]).toBe(b!["trace_id"]);
  });

  it("trace_id is stable across different workspace roots (per-PROCESS, not per-workspace)", () => {
    trace("event_a", {}, "/workspace/root-a");
    trace("event_b", {}, "/workspace/root-b");
    const [a] = readEventRecords("/workspace/root-a");
    const [b] = readEventRecords("/workspace/root-b");
    expect(a!["trace_id"]).toBe(b!["trace_id"]);
  });

  it("flags_active reflects the D10 (B) flags currently on, matching activeExperimentFlags()", () => {
    const orig = process.env["TL_HOP1_CLOSURE"];
    process.env["TL_HOP1_CLOSURE"] = "1";
    try {
      trace("some_event", {}, WS_ROOT);
      const [record] = readEventRecords();
      expect(record!["flags_active"]).toEqual(activeExperimentFlags());
      expect(record!["flags_active"]).toContain("TL_HOP1_CLOSURE");
    } finally {
      if (orig === undefined) delete process.env["TL_HOP1_CLOSURE"];
      else process.env["TL_HOP1_CLOSURE"] = orig;
    }
  });

  it("flags_active is an empty array when no (B) flag is on", () => {
    trace("some_event", {}, WS_ROOT);
    const [record] = readEventRecords();
    expect(record!["flags_active"]).toEqual([]);
  });

  it("the p1_causal_attestation record ALSO carries the envelope", () => {
    process.env["TL_MCP_CONFIG_SHA256"] = "a".repeat(64);
    process.env["TL_P1_CAUSAL_RUN_NONCE"] = "n-envelope-attestation";
    trace("ordinary", {}, WS_ROOT);
    const attestation = readRecords().find((r) => r["event"] === "p1_causal_attestation");
    expect(attestation).toBeDefined();
    expect(attestation!["workspaceRef"]).toBe(workspaceRefOf(WS_ROOT));
    expect(typeof attestation!["trace_id"]).toBe("string");
    // The attestation's OWN workspace_root (raw canonical path, needed to
    // join a trace file to a bench cell) and the envelope's workspaceRef
    // (opaque sha) coexist as distinct fields.
    expect(attestation!["workspace_root"]).toBe(WS_ROOT);
  });
});

describe("trace envelope — per-call fields (call_id/task_ref/route)", () => {
  it("are absent (dropped by JSON.stringify) outside any runWithTraceCall scope", () => {
    trace("outside_call", {}, WS_ROOT);
    const [record] = readEventRecords();
    expect("call_id" in record!).toBe(false);
    expect("task_ref" in record!).toBe(false);
    expect("route" in record!).toBe(false);
  });

  it("call_id is set once runWithTraceCall wraps the trace() call", () => {
    runWithTraceCall(() => {
      trace("inside_call", {}, WS_ROOT);
    });
    const [record] = readEventRecords();
    expect(typeof record!["call_id"]).toBe("number");
  });

  it("call_id is monotonic and shared across every trace() line of ONE call", () => {
    runWithTraceCall(() => {
      trace("first_in_call", {}, WS_ROOT);
      trace("second_in_call", {}, WS_ROOT);
    });
    runWithTraceCall(() => {
      trace("first_in_next_call", {}, WS_ROOT);
    });
    const [a, b, c] = readEventRecords();
    expect(a!["call_id"]).toBe(b!["call_id"]);
    expect(c!["call_id"]).toBeGreaterThan(a!["call_id"] as number);
  });

  it("call_id survives an await inside the same runWithTraceCall scope", async () => {
    await runWithTraceCall(async () => {
      trace("before_await", {}, WS_ROOT);
      await new Promise((resolve) => setImmediate(resolve));
      trace("after_await", {}, WS_ROOT);
    });
    const [before, after] = readEventRecords();
    expect(before!["call_id"]).toBe(after!["call_id"]);
  });

  it("two interleaved runWithTraceCall scopes never see each other's call_id", async () => {
    const order: string[] = [];
    const first = runWithTraceCall(async () => {
      order.push("first-start");
      await new Promise((resolve) => setImmediate(resolve));
      trace("first_call_event", {}, WS_ROOT);
      order.push("first-end");
    });
    const second = runWithTraceCall(async () => {
      order.push("second-start");
      trace("second_call_event", {}, WS_ROOT);
      order.push("second-end");
    });
    await Promise.all([first, second]);
    // Both scopes really did interleave (not accidentally serialized) --
    // otherwise this test would not exercise the ALS isolation it claims to.
    expect(order).toEqual(["first-start", "second-start", "second-end", "first-end"]);
    const records = readEventRecords();
    const firstRecord = records.find((r) => r["event"] === "first_call_event")!;
    const secondRecord = records.find((r) => r["event"] === "second_call_event")!;
    expect(firstRecord["call_id"]).not.toBe(secondRecord["call_id"]);
  });

  it("setTraceContext refines route/task_ref for the CURRENT call only", () => {
    runWithTraceCall(() => {
      trace("before_context", {}, WS_ROOT);
      setTraceContext({ route: "known_local_fast", taskRef: "q-abc123def4567890" });
      trace("after_context", {}, WS_ROOT);
    });
    runWithTraceCall(() => {
      trace("unrelated_call", {}, WS_ROOT);
    });
    const [before, after, unrelated] = readEventRecords();
    expect("route" in before!).toBe(false);
    expect("task_ref" in before!).toBe(false);
    expect(after!["route"]).toBe("known_local_fast");
    expect(after!["task_ref"]).toBe("q-abc123def4567890");
    expect("route" in unrelated!).toBe(false);
    expect("task_ref" in unrelated!).toBe(false);
  });

  it("setTraceContext outside runWithTraceCall is a harmless no-op", () => {
    expect(() => setTraceContext({ route: "orchestrated" })).not.toThrow();
    trace("after_noop_context", {}, WS_ROOT);
    const [record] = readEventRecords();
    expect("route" in record!).toBe(false);
  });

  it("task_ref never contains the volatile tlh_ handle prefix", () => {
    runWithTraceCall(() => {
      setTraceContext({ taskRef: "q-0123456789abcdef" });
      trace("with_task_ref", {}, WS_ROOT);
    });
    const [record] = readEventRecords();
    expect(record!["task_ref"]).not.toContain("tlh_");
    expect(record!["task_ref"]).toMatch(/^q-[0-9a-f]{16}$/);
  });

  it("envelope fields are never shadowable by a same-named payload field", () => {
    runWithTraceCall(() => {
      setTraceContext({ route: "orchestrated" });
      // A hostile/careless payload naming a reserved envelope field.
      trace("shadow_attempt", { route: "IMPOSTER", trace_id: "IMPOSTER" }, WS_ROOT);
    });
    const [record] = readEventRecords();
    expect(record!["route"]).toBe("orchestrated");
    expect(record!["trace_id"]).not.toBe("IMPOSTER");
  });
});
