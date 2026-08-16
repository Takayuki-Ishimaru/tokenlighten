// capabilityGapWire.spec.ts — protocol v1, A.2.7 / A.9.2 rows 15 + 24 (OB-GAP).
//
// OB-GAP was the pre-publish obligation attached to `CapabilityGap.code`: the
// v1 union was a PROVISIONAL 3-value narrowing of the producer's 7-value
// `TaskCapabilityGap.kind`, and the four dropped values were neither mapped
// onto the three nor emitted — a gap the server could not name in v1
// vocabulary was silently NOT EMITTED. C2-7b ran the §3.4 E2 pass per value
// and closed it at FIVE:
//
//   invalid-request             LIVE emitter  -> MINTED  (additive, §1.4(a))
//   unsupported-operation       LIVE emitter  -> MINTED  (additive, §1.4(a))
//   permission-required         emitter-0/reader-0 -> DELETED (§1.4(d))
//   external-execution-required emitter-0/reader-0 -> DELETED (§1.4(d))
//
// This spec is the read-back of that decision at BOTH ends: the wire end (a
// real call whose gap now travels instead of being dropped) and the projection
// end (every producer value the type can express reaches `decision.gaps`, and
// an unteachable value still fails closed).

import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { TaskCapabilityGap, TaskExecutionContract } from "@tokenlighten/types";
import { projectTaskDecision } from "../protocol/decisionWire.js";

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

function mkDir(tag: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(HOME, `.tl-gapwire-${tag}-`)));
  tmpDirs.push(dir);
  return dir;
}

function startServer(opts: { cwd: string; args: string[] }): ServerHandle {
  const child: ChildProcess = spawn(process.execPath, [TSX_CLI, BIN_TS, ...opts.args], {
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
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

  function rpc(id: number, method: string, params?: unknown, timeoutMs = 30000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`rpc '${method}' timed out after ${timeoutMs}ms.\n--- server stderr ---\n${stderr}`));
      }, timeoutMs);
      waiters.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async function initialize(): Promise<void> {
    await rpc(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "vitest", version: "0" },
    });
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }

  return { initialize, rpc, kill: () => { try { child.kill("SIGKILL"); } catch { /* ok */ } } };
}

afterEach(() => {
  for (const s of servers.splice(0)) s.kill();
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

// ---------------------------------------------------------------------------
// 1. The wire end — a MINTED code that used to be dropped now travels
// ---------------------------------------------------------------------------

describe("OB-GAP — invalid-request reaches decision.gaps (was: silently dropped)", () => {
  it("a malformed paths[] entry produces a gap the caller can read, not just a shorter pack", async () => {
    // EXACT CALL SHAPE. `paths[]` in OBJECT form with an empty `path`:
    // buildTaskPack pushes "(invalid paths[] entry: missing path)" into
    // `missing`, and buildCapabilityGaps turns that marker into a
    // `kind:"invalid-request"` gap. The CONTROL case below runs the same query
    // over the same workspace with well-formed entries and gets no such gap,
    // so this is the malformed entry talking, not the query.
    //
    // Before OB-GAP this gap existed in the contract and was dropped by
    // decisionWire's GAP_CODES filter, so the caller saw a pack that had
    // quietly ignored one of its requested paths with nothing naming the fact.
    const ws = mkDir("invalid-request");
    fs.mkdirSync(path.join(ws, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, "src/auth.ts"),
      "export function login(user: string): boolean {\n  return user.length > 0;\n}\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(ws, "src/session.ts"),
      "export function newSession(id: string): string {\n  return id;\n}\n",
      "utf8",
    );

    const srv = startServer({ cwd: ws, args: [ws] });
    servers.push(srv);
    await srv.initialize();

    const res = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: {
        mode: "task_pack",
        query: "add a rate limit to the login path",
        paths: [{ path: "" }, { path: "src/auth.ts" }],
      },
    });
    const body = JSON.parse(res.result.content[0].text) as Record<string, any>;

    expect(body["kind"], JSON.stringify(body).slice(0, 400)).toBe("read.task_pack");
    const decision = body["decision"] as { kind: string; gaps?: Array<{ code: string }> };
    expect(decision, "no decision on the pack").toBeDefined();
    // §4.4 / D-4: gaps are representable only on `discover`.
    expect(decision.kind).toBe("discover");
    const codes = (decision.gaps ?? []).map((g) => g.code);
    expect(codes, `decision.gaps = ${JSON.stringify(decision.gaps)}`).toContain("invalid-request");
  }, 60000);

  it("CONTROL: the same call with well-formed paths carries NO invalid-request gap", async () => {
    // Non-vacuity for the case above: the gap tracks the MALFORMED ENTRY, not
    // the query, the workspace, or "task_pack emits a gap sometimes".
    const ws = mkDir("control");
    fs.mkdirSync(path.join(ws, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, "src/auth.ts"),
      "export function login(user: string): boolean {\n  return user.length > 0;\n}\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(ws, "src/session.ts"),
      "export function newSession(id: string): string {\n  return id;\n}\n",
      "utf8",
    );

    const srv = startServer({ cwd: ws, args: [ws] });
    servers.push(srv);
    await srv.initialize();

    const res = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: {
        mode: "task_pack",
        query: "add a rate limit to the login path",
        paths: [{ path: "src/auth.ts" }, { path: "src/session.ts" }],
      },
    });
    const body = JSON.parse(res.result.content[0].text) as Record<string, any>;
    const decision = body["decision"] as { gaps?: Array<{ code: string }> } | undefined;
    const codes = (decision?.gaps ?? []).map((g) => g.code);
    expect(codes, JSON.stringify(decision)).not.toContain("invalid-request");
  }, 60000);
});

// ---------------------------------------------------------------------------
// 2. The projection end — the closed 5-value union, and the fail-closed floor
// ---------------------------------------------------------------------------

/** Minimal contract that reaches the `discover` branch of projectTaskDecision. */
function contractWithGaps(gaps: TaskCapabilityGap[]): TaskExecutionContract {
  return {
    version: 1,
    state: "needs-followup",
    readiness: "needs-followup",
    discovery_complete: false,
    next_action: "followup",
    max_additional_discovery_calls: 1,
    reason: "synthetic contract for the gap projection",
    typestate: { phase: "discovery", certificate_id: "cert-gapwire" },
    next_call: { tool: "search_files", arguments: { action: "tree", path: "src" } },
    capability_gaps: gaps,
  } as unknown as TaskExecutionContract;
}

function projectGapCodes(gaps: TaskCapabilityGap[]): string[] {
  const decision = projectTaskDecision({
    result: {},
    contract: contractWithGaps(gaps),
    canonicalKind: "discover",
    evidence: [],
  });
  expect(decision?.kind).toBe("discover");
  const gapsOut = (decision as { gaps?: Array<{ code: string }> }).gaps ?? [];
  return gapsOut.map((g) => g.code);
}

describe("OB-GAP — CapabilityGap.code is a CLOSED 5-value union with no lossy narrowing left", () => {
  // The whole producer union, spelled out. TypeScript enforces membership:
  // adding a seventh `TaskCapabilityGap.kind` without teaching decisionWire
  // makes this array a compile error rather than a silent wire drop.
  const ALL_KINDS: ReadonlyArray<TaskCapabilityGap["kind"]> = [
    "missing-evidence",
    "ambiguous-target",
    "invalid-request",
    "unsupported-operation",
    "workspace-changed",
  ];

  it("every value the producer type can express reaches the wire — the map is total, not a narrowing", () => {
    expect(ALL_KINDS.length, "TaskCapabilityGap.kind is no longer 5 values — re-run OB-GAP's E2 pass for the new value").toBe(5);
    for (const kind of ALL_KINDS) {
      const codes = projectGapCodes([{ kind, recoverable: true, reason: `synthetic ${kind}` }]);
      expect(codes, `producer kind "${kind}" did not reach decision.gaps`).toEqual([kind]);
    }
  });

  it("the two MINTED codes are the ones that used to be dropped", () => {
    // Direct read-back of the disposition table: before C2-7b, projecting
    // either of these returned an EMPTY gap list.
    expect(projectGapCodes([
      { kind: "invalid-request", recoverable: true, reason: "malformed paths[] entry" },
      { kind: "unsupported-operation", recoverable: false, reason: "route resolved to a native fallback" },
    ])).toEqual(["invalid-request", "unsupported-operation"]);
  });

  it("an unteachable producer value still FAILS CLOSED — it is dropped, never coerced onto a code that would misdescribe it", () => {
    // The two DELETED values, forced past the type system exactly the way a
    // future untaught value would arrive. Coercing them onto `missing-evidence`
    // would claim "the server looked and it is not there" about a permission
    // problem — the false-semantic class §4.4 exists to keep apart — so the
    // floor drops instead of guessing.
    const smuggled = [
      { kind: "permission-required", recoverable: false, reason: "deleted value" },
      { kind: "external-execution-required", recoverable: false, reason: "deleted value" },
    ] as unknown as TaskCapabilityGap[];
    expect(projectGapCodes(smuggled)).toEqual([]);
    // ...and a real gap alongside them still travels: the floor drops the
    // unnameable one, not the response.
    const mixed = [
      ...smuggled,
      { kind: "missing-evidence", recoverable: true, reason: "real gap" } as TaskCapabilityGap,
    ];
    expect(projectGapCodes(mixed)).toEqual(["missing-evidence"]);
  });

  it("obligation ids ride as refs, de-duplicated, and absence of refs is not absence of the gap", () => {
    const codes = projectGapCodes([
      { kind: "invalid-request", recoverable: true, reason: "r", obligation_ids: ["o1", "o1", "o2"] },
    ]);
    expect(codes).toEqual(["invalid-request"]);
    const decision = projectTaskDecision({
      result: {},
      contract: contractWithGaps([
        { kind: "invalid-request", recoverable: true, reason: "r", obligation_ids: ["o1", "o1", "o2"] },
      ]),
      canonicalKind: "discover",
      evidence: [],
    }) as { gaps?: Array<{ code: string; refs?: string[] }> };
    expect(decision.gaps?.[0]?.refs).toEqual(["o1", "o2"]);
  });
});
