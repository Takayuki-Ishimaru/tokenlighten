/**
 * editItemAddressCorrection.spec.ts — an `edits[]` item that names no file.
 *
 * OBSERVED (2026-10-21 codex-copilot-proxy cohort, evidence-remediation-r16:
 * T07 tl-0 / tl-1 and T09 tl-0): after an `act.edit` task pack the agent sent
 * `tl_edit_file` with items that carried only `search`/`replace` (once with
 * `search` as an object, `{path, search}`). The server refused
 * `execution-typestate` / "edit has no certificate-backed handle or path" and
 * the wire advertised `retry:"challenge"` plus `certificate_id`. A challenge
 * cannot supply a missing address, so the agents followed it into three more
 * refusals (challenge rejected, unknown-arguments, challenge rejected) and two
 * of three gave up without editing; the one that added `path` instead was
 * applied on the very next call (T07 tl-1).
 *
 * THE CONTRACT PINNED HERE. For a non-create `edits[]` call in which at least
 * one item carries neither `handle` nor `path`, and the call names no file at
 * the top level either, the refusal names the correction instead of a
 * challenge:
 *   retry:"call"; field:"edits[<i>].path" (the first such item) and `fields`
 *   (all of them); a `detail` that says each item needs `path` (or a served
 *   `handle`) beside `search`/`replace` and names the certificate's write
 *   targets; `candidates:[{path, handle}]` from the fence's write targets; the
 *   `frontier` block unchanged; no challenge, no `certificate_id`, never
 *   terminal. A verbatim retry (the compacted refusal) carries the same
 *   correction. STRICTNESS IS UNCHANGED: nothing is inferred, the server never
 *   picks a file for the item.
 * A `search` sent as an object stays `invalid-input` (code/field/retry
 * unchanged) and gains a one-line hint that `path` goes beside `search`.
 *
 * Every other `execution-typestate` refusal is left as it was; the controls in
 * the in-process block pin that (flat pathless call, outside-frontier target
 * in a mixed batch, answer-ready certificate, top-level handle).
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { TaskExecutionContract } from "@tokenlighten/types";

import { buildRefusal } from "../protocol/refusal.js";
import {
  guardExecutionEdit,
  recordExecutionContract,
  recordExecutionEditResult,
  resetAll,
} from "../util/session.js";
import { killServerGroup } from "./helpers/killServerGroup.js";
import { pooledSpawn } from "./helpers/serverPool.js";
import { TSX_NODE_ARGS } from "./helpers/tsxNode.js";

type Body = Record<string, any>;

// ---------------------------------------------------------------------------
// Spawned server (the real wire)
// ---------------------------------------------------------------------------

const roots: string[] = [];
const stops: Array<() => void> = [];
const bin = fileURLToPath(new URL("../bin.ts", import.meta.url));

const VALUE_TS = 'export const value = "before";\n';
const LABEL_TS = 'import { value } from "./value";\nexport const label = `value=${value}`;\n';

function workspace(files: Record<string, string>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".tl-edit-address-")));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

/** One server over `root` in the production-default environment (plus an optional client posture). */
async function connect(root: string, clientId?: string): Promise<(name: string, args: Body) => Promise<Body>> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith("TL_") && !key.startsWith("TOKENLIGHTEN_")));
  const child = pooledSpawn(process.execPath, [...TSX_NODE_ARGS, bin, root, "--allow-write"], {
    cwd: root,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...env, ...(clientId !== undefined ? { TOKENLIGHTEN_CLIENT_ID: clientId } : {}) },
  });
  stops.push(() => killServerGroup(child));
  let buffer = "";
  let stderr = "";
  let sequence = 0;
  const waiters = new Map<number, (body: Body) => void>();
  child.stdout!.on("data", (data: Buffer) => {
    buffer += data.toString();
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let message: Body;
      try { message = JSON.parse(line); } catch { continue; }
      const done = waiters.get(message["id"]);
      if (done) { waiters.delete(message["id"]); done(message); }
    }
  });
  child.stderr!.on("data", (data: Buffer) => { stderr += data.toString(); });
  const rpc = (method: string, params: Body): Promise<Body> => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { waiters.delete(id); reject(new Error(`${method} timed out\n${stderr}`)); }, 20000);
    waiters.set(id, (body) => { clearTimeout(timer); resolve(body); });
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "vitest", version: "0" } });
  child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return async (name, args) => {
    const response = await rpc("tools/call", { name, arguments: { cwd: root, ...args } });
    return JSON.parse(response["result"].content[0].text) as Body;
  };
}

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const ONE_FILE_REQUEST = "Change value in src/value.ts from before to after.";
const TWO_FILE_REQUEST = "Change value in src/value.ts from before to after, and update the label in src/label.ts to say after-value.";

/** The act.edit pack the cohort's agents edited under: its task id and each write target's handle. */
async function actEditPack(
  call: (name: string, args: Body) => Promise<Body>,
  request: string,
): Promise<{ task: string; handles: Record<string, string> }> {
  const pack = await call("tl_read_file", { query: request, task: { epoch: "new", profile: "generic" } });
  expect(pack["decision"]?.kind, JSON.stringify(pack["decision"])).toBe("act.edit");
  const handles: Record<string, string> = {};
  for (const row of pack["decision"].frontier as Array<Body>) handles[row["path"]] = row["handle"];
  return { task: pack["task"].id as string, handles };
}

const read = (root: string, rel: string): string => fs.readFileSync(path.join(root, rel), "utf8");

/** What no correction may carry: any trace of the challenge transition. */
function expectNoChallenge(refusal: Body): void {
  expect(refusal["retry"], JSON.stringify(refusal)).not.toBe("challenge");
  expect(refusal["certificate_id"], JSON.stringify(refusal)).toBeUndefined();
  expect(refusal["challenge"], JSON.stringify(refusal)).toBeUndefined();
  expect(refusal["terminal"], JSON.stringify(refusal)).toBeUndefined();
  expect(refusal["unlock"], JSON.stringify(refusal)).toBeUndefined();
  expect(JSON.stringify(refusal), "the wire names no challenge at all").not.toMatch(/challenge/i);
}

describe("an edits[] item that names no file, after an act.edit pack (spawned server)", () => {
  for (const posture of [undefined, "copilot-cli"] as const) {
    const label = posture ?? "default client";

    it(`${label}: the refusal is retry:call with field, fields and the write target as candidates, and no challenge`, async () => {
      const root = workspace({ "src/value.ts": VALUE_TS });
      const call = await connect(root, posture);
      const { task, handles } = await actEditPack(call, ONE_FILE_REQUEST);

      const refusal = await call("tl_edit_file", {
        task: { handle: task },
        edits: [{ search: 'value = "before"', replace: 'value = "after"' }],
      });
      expect(refusal["kind"]).toBe("refusal");
      expect(refusal["code"]).toBe("execution-typestate");
      expect(refusal["retry"]).toBe("call");
      expect(refusal["field"]).toBe("edits[0].path");
      expect(refusal["fields"]).toEqual(["edits[0].path"]);
      expect(refusal["candidates"]).toEqual([{ path: "src/value.ts", handle: handles["src/value.ts"] }]);
      // The prose says what to do and names the certificate's write target.
      const detail = String(refusal["detail"]);
      expect(detail).toMatch(/each edits\[\] item needs its own path/);
      expect(detail).toMatch(/served handle whose window covers search/);
      expect(detail).toMatch(/beside search\/replace/);
      expect(detail).toContain("edits[0]");
      expect(detail).toContain("src/value.ts");
      // The frontier block is kept as it was.
      expect(refusal["frontier"].write_targets).toEqual({ handles: [handles["src/value.ts"]], paths: ["src/value.ts"] });
      expectNoChallenge(refusal);
      // Strictness is unchanged: nothing was inferred, nothing written.
      expect(read(root, "src/value.ts")).toBe(VALUE_TS);
    }, 60000);
  }

  it("the same edit with path added applies", async () => {
    const root = workspace({ "src/value.ts": VALUE_TS });
    const call = await connect(root);
    const { task } = await actEditPack(call, ONE_FILE_REQUEST);
    const search = 'value = "before"';
    const replace = 'value = "after"';

    expect((await call("tl_edit_file", { task: { handle: task }, edits: [{ search, replace }] }))["retry"]).toBe("call");
    const applied = await call("tl_edit_file", { task: { handle: task }, edits: [{ path: "src/value.ts", search, replace }] });
    expect(applied["kind"], JSON.stringify(applied)).toBe("edit.applied");
    expect(read(root, "src/value.ts")).toBe('export const value = "after";\n');
  }, 60000);

  it("every address-less item is named, and every write target is a candidate", async () => {
    const root = workspace({ "src/value.ts": VALUE_TS, "src/label.ts": LABEL_TS });
    const call = await connect(root);
    const { task, handles } = await actEditPack(call, TWO_FILE_REQUEST);
    expect(Object.keys(handles).sort()).toEqual(["src/label.ts", "src/value.ts"]);

    const refusal = await call("tl_edit_file", {
      task: { handle: task },
      edits: [
        { search: 'value = "before"', replace: 'value = "after"' },
        { search: "value=", replace: "after-value=" },
      ],
    });
    expect(refusal["code"]).toBe("execution-typestate");
    expect(refusal["retry"]).toBe("call");
    expect(refusal["field"]).toBe("edits[0].path");
    expect(refusal["fields"]).toEqual(["edits[0].path", "edits[1].path"]);
    expect(refusal["candidates"]).toEqual(expect.arrayContaining([
      { path: "src/value.ts", handle: handles["src/value.ts"] },
      { path: "src/label.ts", handle: handles["src/label.ts"] },
    ]));
    expect(refusal["candidates"]).toHaveLength(2);
    expect(String(refusal["detail"])).toContain("edits[0], edits[1]");
    expectNoChallenge(refusal);
    expect(read(root, "src/value.ts")).toBe(VALUE_TS);
    expect(read(root, "src/label.ts")).toBe(LABEL_TS);
  }, 60000);

  it("a mixed batch (one item with path, one without) names the missing item and writes nothing", async () => {
    const root = workspace({ "src/value.ts": VALUE_TS, "src/label.ts": LABEL_TS });
    const call = await connect(root);
    const { task } = await actEditPack(call, TWO_FILE_REQUEST);

    const refusal = await call("tl_edit_file", {
      task: { handle: task },
      edits: [
        { path: "src/value.ts", search: 'value = "before"', replace: 'value = "after"' },
        { search: "value=", replace: "after-value=" },
      ],
    });
    expect(refusal["kind"]).toBe("refusal");
    expect(refusal["code"]).toBe("execution-typestate");
    expect(refusal["retry"]).toBe("call");
    expect(refusal["field"]).toBe("edits[1].path");
    expect(refusal["fields"]).toEqual(["edits[1].path"]);
    expect(String(refusal["detail"])).toContain("edits[1] has neither");
    expect(String(refusal["detail"])).not.toContain("edits[0]");
    expectNoChallenge(refusal);
    // All-or-nothing: the well-formed item did not land either.
    expect(read(root, "src/value.ts")).toBe(VALUE_TS);
    expect(read(root, "src/label.ts")).toBe(LABEL_TS);
  }, 60000);

  it("a repeated identical refusal still carries the correction (the compacted refusal)", async () => {
    const root = workspace({ "src/value.ts": VALUE_TS, "src/label.ts": LABEL_TS });
    const call = await connect(root);
    const { task, handles } = await actEditPack(call, TWO_FILE_REQUEST);
    const sent = {
      task: { handle: task },
      edits: [
        { search: 'value = "before"', replace: 'value = "after"' },
        { search: "value=", replace: "after-value=" },
      ],
    };

    const first = await call("tl_edit_file", sent);
    const second = await call("tl_edit_file", sent);
    const third = await call("tl_edit_file", sent);
    for (const repeated of [second, third]) {
      expect(repeated["kind"]).toBe("refusal");
      expect(repeated["code"]).toBe("execution-typestate");
      expect(repeated["retry"]).toBe("call");
      expect(repeated["field"]).toBe("edits[0].path");
      expect(repeated["fields"]).toEqual(["edits[0].path", "edits[1].path"]);
      expect(repeated["candidates"]).toEqual(first["candidates"]);
      expect(repeated["candidates"]).toEqual(expect.arrayContaining([
        { path: "src/value.ts", handle: handles["src/value.ts"] },
      ]));
      const detail = String(repeated["detail"]);
      expect(detail).toMatch(/each edits\[\] item needs its own path/);
      expect(detail).toContain("already refused in this task");
      expectNoChallenge(repeated);
    }
    expect(String(second["detail"])).toContain("(attempt 2)");
    expect(String(third["detail"])).toContain("(attempt 3)");
    // It is a receipt, not the full refusal again.
    expect(second["frontier"]).toBeUndefined();
    expect(JSON.stringify(second).length).toBeLessThan(JSON.stringify(first).length);
    expect(read(root, "src/value.ts")).toBe(VALUE_TS);
  }, 60000);

  it("after the corrected batch landed, an address-less batch is the correction again, never a terminal verdict or a challenge", async () => {
    const root = workspace({ "src/value.ts": VALUE_TS });
    const call = await connect(root);
    const { task } = await actEditPack(call, ONE_FILE_REQUEST);

    expect((await call("tl_edit_file", { task: { handle: task }, edits: [{ search: 'value = "before"', replace: 'value = "after"' }] }))["retry"]).toBe("call");
    const applied = await call("tl_edit_file", {
      task: { handle: task },
      edits: [{ path: "src/value.ts", search: 'value = "before"', replace: 'value = "after"' }],
    });
    expect(applied["kind"], JSON.stringify(applied)).toBe("edit.applied");

    // The fence is now `verifying`. The earlier refusal's prescribed step has run; this is a new,
    // address-less batch, and the answer is still "put path on the item".
    const again = await call("tl_edit_file", {
      task: { handle: task },
      edits: [{ search: 'value = "after"', replace: 'value = "after-again"' }],
    });
    expect(again["kind"]).toBe("refusal");
    expect(again["code"]).toBe("execution-typestate");
    expect(again["retry"]).toBe("call");
    expect(again["field"]).toBe("edits[0].path");
    expect(String(again["detail"])).toMatch(/each edits\[\] item needs its own path/);
    expect(String(again["detail"])).not.toMatch(/outside the certificate frontier|can never enter/);
    expectNoChallenge(again);
    expect(read(root, "src/value.ts")).toBe('export const value = "after";\n');
  }, 60000);
});

describe("a search sent as an object (spawned server)", () => {
  it("stays invalid-input on the same field and retry, and says path goes beside search", async () => {
    const root = workspace({ "src/value.ts": VALUE_TS });
    const call = await connect(root);
    const { task } = await actEditPack(call, ONE_FILE_REQUEST);

    const refusal = await call("tl_edit_file", {
      task: { handle: task },
      edits: [
        { search: { path: "src/value.ts", search: 'value = "before"' }, replace: 'value = "after"' },
        { search: { path: "src/value.ts", search: "export" }, replace: "export" },
      ],
    });
    expect(refusal["kind"]).toBe("refusal");
    expect(refusal["code"]).toBe("invalid-input");
    expect(refusal["field"]).toBe("edits[0].search");
    expect(refusal["fields"]).toEqual(["edits[0].search", "edits[1].search"]);
    expect(refusal["retry"]).toBe("call");
    const detail = String(refusal["detail"]);
    expect(detail).toContain("edits[0].search must be a string");
    expect(detail).toMatch(/path goes beside search as its own field/);
    expect(detail).toContain("edits:[{path, search, replace}]");
    expect(read(root, "src/value.ts")).toBe(VALUE_TS);
  }, 60000);

  it("adds no hint when the search is not an object", async () => {
    const root = workspace({ "src/value.ts": VALUE_TS });
    const call = await connect(root);
    const { task } = await actEditPack(call, ONE_FILE_REQUEST);

    const refusal = await call("tl_edit_file", {
      task: { handle: task },
      edits: [{ path: "src/value.ts", search: 42, replace: 'value = "after"' }],
    });
    expect(refusal["code"]).toBe("invalid-input");
    expect(refusal["field"]).toBe("edits[0].search");
    expect(String(refusal["detail"])).toContain("edits[0].search must be a string");
    expect(String(refusal["detail"])).not.toMatch(/beside search/);
  }, 60000);
});

// ---------------------------------------------------------------------------
// In-process: the guard's body, its wire projection, and the controls
// ---------------------------------------------------------------------------

function certificate(id: string, targets: ReadonlyArray<{ handle: string; path: string }>, action: "edit" | "answer" = "edit"): TaskExecutionContract {
  return {
    version: 1,
    state: "ready",
    readiness: action === "answer" ? "answer-ready" : "edit-ready",
    discovery_complete: true,
    next_action: action,
    max_additional_discovery_calls: 0,
    reason: "test proof",
    readiness_certificate: {
      version: 1,
      id,
      task_fingerprint: "task-1",
      profile: action === "answer" ? "answer" : "change_propagation",
      obligations: [{
        id: "behavior-body",
        kind: "behavior-body",
        status: "proved",
        required: true,
        evidence: targets.map((target) => ({ handle: target.handle, path: target.path, range: "1-20", symbol: "fn" })),
        reason: "callable body served",
      }],
      evidence_handles: targets.map((target) => target.handle),
      action_frontier: action === "edit" ? targets.map((target) => target.handle) : [],
      falsification: { version: 1, checked: ["callable-body"], counterexamples: [], unresolved: [] },
      risk: {
        policy: "selective-reject",
        estimated_false_ready_risk: 0.01,
        max_false_ready_risk: 0.05,
        decision: "accept",
        factors: [],
      },
    },
    typestate: {
      phase: "prepared",
      certificate_id: id,
      allowed_actions: action === "answer" ? ["answer", "challenge"] : ["edit", "challenge"],
      challenge_required_for: action === "answer" ? ["read", "search", "edit"] : ["read", "search"],
    },
    call_budget: {
      version: 2,
      policy: "expected-decision-change",
      normalized_turn_cost: 0.18,
      expected_decision_change: 0.01,
      expected_value: 0.011,
      decision_threshold: 0.18,
      discovery_allowed: false,
      terminal_action: action,
      reason: "low value",
    },
  };
}

const TARGETS = [
  { handle: "h-compute", path: "pkg/balance/compute.go" },
  { handle: "h-posting", path: "pkg/posting/posting.go" },
];
const resolveHandlePath = (handle: string): string | undefined =>
  TARGETS.find((target) => target.handle === handle)?.path;

function refusedBody(decision: ReturnType<typeof guardExecutionEdit>): Body {
  expect(decision.allowed).toBe(false);
  if (decision.allowed) throw new Error("expected a refusal");
  return decision.refusal as Body;
}

describe("the guard's address-less refusal and its wire projection (in-process)", () => {
  afterEach(() => resetAll());

  it("is retry:call with field/fields/candidates, keeps the frontier, and carries no challenge, no certificate_id, no terminal", () => {
    const root = "/workspace/addressless-body";
    recordExecutionContract(root, "fix balance sign", certificate("cert-1", TARGETS));
    const body = refusedBody(guardExecutionEdit(root, {
      edits: [{ search: "a", replace: "b" }, { search: "c", replace: "d" }, { search: "e", replace: "f" }],
    }, resolveHandlePath));

    expect(body["reason"]).toBe("execution-typestate");
    expect(body["retry"]).toBe("call");
    expect(body["field"]).toBe("edits[0].path");
    expect(body["fields"]).toEqual(["edits[0].path", "edits[1].path", "edits[2].path"]);
    expect(body["candidates"]).toEqual([
      { path: "pkg/balance/compute.go", handle: "h-compute" },
      { path: "pkg/posting/posting.go", handle: "h-posting" },
    ]);
    expect(body["frontier"].write_targets).toEqual({
      handles: ["h-compute", "h-posting"],
      paths: ["pkg/balance/compute.go", "pkg/posting/posting.go"],
    });
    for (const key of ["challenge", "certificate_id", "terminal", "terminal_reason", "unlock"]) {
      expect(body[key], key).toBeUndefined();
    }
    expect(body["challenge_required"]).not.toBe(true);
    const detail = String(body["detail"]);
    expect(detail).toContain("each edits[] item needs its own path (or a served handle whose window covers search) beside search/replace");
    expect(detail).toContain("edits[0], edits[1], edits[2] have neither");
    expect(detail).toContain("pkg/balance/compute.go");
    expect(detail).toContain("pkg/posting/posting.go");

    // The same body on the wire.
    const wire = buildRefusal("tl_edit_file", structuredClone(body)) as unknown as Body;
    expect(wire["code"]).toBe("execution-typestate");
    expect(wire["retry"]).toBe("call");
    expect(wire["field"]).toBe("edits[0].path");
    expect(wire["fields"]).toEqual(body["fields"]);
    expect(wire["candidates"]).toEqual(body["candidates"]);
    expect(wire["frontier"]).toEqual(body["frontier"]);
    expect(wire["certificate_id"]).toBeUndefined();
    expect(JSON.stringify(wire)).not.toMatch(/challenge/i);
  }, 10000);

  it("candidates omit the side a write target does not have, and the prose caps its target list", () => {
    const root = "/workspace/addressless-pairs";
    const many = Array.from({ length: 6 }, (_, index) => ({ handle: `h-${index}`, path: `src/file${index}.ts` }));
    recordExecutionContract(root, "touch many", certificate("cert-many", many));
    const body = refusedBody(guardExecutionEdit(root, { edits: [{ search: "a", replace: "b" }] }, (handle) =>
      many.find((target) => target.handle === handle)?.path));
    expect(body["candidates"]).toEqual(many.map((target) => ({ path: target.path, handle: target.handle })));
    const detail = String(body["detail"]);
    expect(detail).toContain("src/file0.ts, src/file1.ts, src/file2.ts");
    expect(detail).not.toContain("src/file3.ts");
    expect(detail).toContain("+3 more in candidates");

    // A target with a handle and no evidence path, and a path-only target.
    const pairs = certificate("cert-sides", [{ handle: "h-only", path: "src/x.ts" }]);
    pairs.readiness_certificate!.obligations[0]!.evidence = [];
    pairs.readiness_certificate!.action_frontier = ["h-only", "src/by-path.ts"];
    pairs.readiness_certificate!.evidence_handles = ["h-only"];
    recordExecutionContract("/workspace/addressless-sides", "sides", pairs);
    const sides = refusedBody(guardExecutionEdit("/workspace/addressless-sides", { edits: [{ search: "a", replace: "b" }] }));
    expect(sides["candidates"]).toEqual([{ handle: "h-only" }, { path: "src/by-path.ts" }]);
    expect(String(sides["detail"])).toContain("handle h-only, src/by-path.ts");
    // The dispatcher's handle table says which file a handle-only write target is: reported, not inferred.
    const resolved = refusedBody(guardExecutionEdit(
      "/workspace/addressless-sides",
      { edits: [{ search: "a2", replace: "b2" }] },
      (handle) => (handle === "h-only" ? "src/x.ts" : undefined),
    ));
    expect(resolved["candidates"]).toEqual([{ path: "src/x.ts", handle: "h-only" }, { path: "src/by-path.ts" }]);
    expect(String(resolved["detail"])).toContain("src/x.ts, src/by-path.ts");
  }, 10000);

  it("a certificate with no write target still names the missing path, with no candidates and no target sentence", () => {
    const root = "/workspace/addressless-no-targets";
    const bare = certificate("cert-bare", TARGETS);
    bare.readiness_certificate!.action_frontier = [];
    recordExecutionContract(root, "fix balance sign", bare);
    const body = refusedBody(guardExecutionEdit(root, { edits: [{ search: "a", replace: "b" }] }, resolveHandlePath));
    expect(body["retry"]).toBe("call");
    expect(body["field"]).toBe("edits[0].path");
    expect(body["candidates"]).toBeUndefined();
    expect(String(body["detail"])).toContain("edits[0] has neither.");
    expect(String(body["detail"])).not.toContain("write targets");
    for (const key of ["challenge", "certificate_id", "terminal", "unlock"]) expect(body[key], key).toBeUndefined();
    const wire = buildRefusal("tl_edit_file", structuredClone(body)) as unknown as Body;
    expect(wire["retry"]).toBe("call");
    expect(wire["candidates"]).toBeUndefined();
  }, 10000);

  it("caps the fields it lists and says how many items there are", () => {
    const root = "/workspace/addressless-cap";
    recordExecutionContract(root, "fix balance sign", certificate("cert-cap", TARGETS));
    const edits = Array.from({ length: 20 }, (_, index) => ({ search: `s${index}`, replace: `r${index}` }));
    const body = refusedBody(guardExecutionEdit(root, { edits }, resolveHandlePath));
    expect(body["fields"]).toHaveLength(16);
    expect(body["fields"][0]).toBe("edits[0].path");
    expect(body["field"]).toBe(body["fields"][0]);
    expect(String(body["detail"])).toContain("edits[0], edits[1], edits[2], edits[3] and 16 more have neither");
  }, 10000);

  it("a verbatim retry is a compact receipt that keeps the correction and gains no challenge", () => {
    const root = "/workspace/addressless-compact";
    recordExecutionContract(root, "fix balance sign", certificate("cert-2", TARGETS));
    const call = { edits: [{ search: "a", replace: "b" }, { search: "c", replace: "d" }] };
    const first = refusedBody(guardExecutionEdit(root, call, resolveHandlePath));
    const second = refusedBody(guardExecutionEdit(root, structuredClone(call), resolveHandlePath));

    expect(second["unchanged"]).toBeDefined();
    expect(second["frontier"]).toBeUndefined();
    expect(second["retry"]).toBe("call");
    expect(second["field"]).toBe("edits[0].path");
    expect(second["fields"]).toEqual(first["fields"]);
    expect(second["candidates"]).toEqual(first["candidates"]);
    expect(String(second["detail"])).toContain(String(first["detail"]));
    expect(String(second["detail"])).toContain("already refused in this task (attempt 2)");
    for (const key of ["challenge", "certificate_id", "terminal", "unlock"]) expect(second[key], key).toBeUndefined();

    const wire = buildRefusal("tl_edit_file", structuredClone(second)) as unknown as Body;
    expect(wire["retry"]).toBe("call");
    expect(wire["field"]).toBe("edits[0].path");
    expect(wire["candidates"]).toEqual(first["candidates"]);
    expect(wire["certificate_id"]).toBeUndefined();
    expect(JSON.stringify(wire)).not.toMatch(/challenge/i);
  }, 10000);

  it("a repeated refusal keeps its \"already refused\" notice inside the wire's detail cap even with long monorepo paths", () => {
    const root = "/workspace/addressless-long-paths";
    const long = Array.from({ length: 4 }, (_, index) => ({
      handle: `h-long-${index}`,
      path: `packages/some-long-package-name/src/features/area${index}/handler.ts`,
    }));
    recordExecutionContract(root, "touch the handlers", certificate("cert-long", long));
    const resolve = (handle: string): string | undefined => long.find((target) => target.handle === handle)?.path;
    const call = { edits: [{ search: "a", replace: "b" }, { search: "c", replace: "d" }] };
    const first = refusedBody(guardExecutionEdit(root, call, resolve));
    const second = refusedBody(guardExecutionEdit(root, structuredClone(call), resolve));

    // The prose names the first target and counts the rest; `candidates` has all four in full.
    expect(String(first["detail"])).toContain(long[0]!.path);
    expect(String(first["detail"])).not.toContain(long[1]!.path);
    expect(String(first["detail"])).toContain("(+3 more in candidates)");
    const wire = buildRefusal("tl_edit_file", structuredClone(second)) as unknown as Body;
    expect(wire["candidates"]).toHaveLength(4);
    expect(wire["retry"]).toBe("call");
    // ...so the repeat notice survives the wire's 400-character detail cap whole.
    expect(String(wire["detail"])).toContain("already refused in this task (attempt 2); retrying it unchanged cannot change the result.");
    expect(String(wire["detail"])).not.toContain("…");
    expect(String(wire["detail"])).not.toContain("First correction:");
  }, 10000);

  it("a landed batch does not turn the next address-less refusal terminal (the old discharged-demand verdict)", () => {
    const root = "/workspace/addressless-discharged";
    recordExecutionContract(root, "fix balance sign", certificate("cert-3", TARGETS));
    refusedBody(guardExecutionEdit(root, { edits: [{ search: "a", replace: "b" }] }, resolveHandlePath));
    // The caller does what the refusal prescribed: edits that name their files land.
    expect(guardExecutionEdit(root, {
      edits: [
        { path: "pkg/balance/compute.go", search: "a", replace: "b" },
        { path: "pkg/posting/posting.go", search: "a", replace: "b" },
      ],
    }, resolveHandlePath)).toEqual({ allowed: true });
    recordExecutionEditResult(root, true, ["pkg/balance/compute.go", "pkg/posting/posting.go"]);

    const again = refusedBody(guardExecutionEdit(root, { edits: [{ search: "x", replace: "y" }] }, resolveHandlePath));
    expect(again["terminal"]).toBeUndefined();
    expect(again["retry"]).toBe("call");
    expect(again["field"]).toBe("edits[0].path");
    expect(again["challenge"]).toBeUndefined();
    expect(again["unlock"]).toBeUndefined();
  }, 10000);

  describe("everything else stays exactly as it was", () => {
    it("a flat call with no file (no edits[]) keeps its refusal and its challenge", () => {
      const root = "/workspace/addressless-flat";
      recordExecutionContract(root, "fix balance sign", certificate("cert-flat", TARGETS));
      const body = refusedBody(guardExecutionEdit(root, { search: "a", replace: "b" }, resolveHandlePath));
      expect(body["detail"]).toBe("edit has no certificate-backed handle or path");
      expect(body["challenge"]).toBeDefined();
      expect(body["retry"]).toBeUndefined();
      expect(body["field"]).toBeUndefined();
      expect(body["candidates"]).toBeUndefined();
      expect(body["certificate_id"]).toBe("cert-flat");
      const wire = buildRefusal("tl_edit_file", structuredClone(body)) as unknown as Body;
      expect(wire["retry"]).toBe("challenge");
      expect(wire["certificate_id"]).toBe("cert-flat");
    }, 10000);

    it("an empty edits[] keeps its refusal", () => {
      const root = "/workspace/addressless-empty";
      recordExecutionContract(root, "fix balance sign", certificate("cert-empty", TARGETS));
      const body = refusedBody(guardExecutionEdit(root, { edits: [] }, resolveHandlePath));
      expect(body["detail"]).toBe("edit has no certificate-backed handle or path");
      expect(body["challenge"]).toBeDefined();
    }, 10000);

    it("an item outside the frontier in a mixed batch is still the frontier refusal", () => {
      const root = "/workspace/addressless-outside";
      recordExecutionContract(root, "fix balance sign", certificate("cert-outside", TARGETS));
      const body = refusedBody(guardExecutionEdit(root, {
        edits: [
          { path: "pkg/never/served.go", search: "a", replace: "b" },
          { search: "c", replace: "d" },
        ],
      }, resolveHandlePath));
      // The existing F-R8 shape for a path the caller named itself: a re-pack `next_call`, retry:"call".
      expect(String(body["detail"])).toContain("edit target is outside certificate frontier paths=pkg/never/served.go");
      expect(body["retry"]).toBe("call");
      expect(body["next_call"]).toMatchObject({ tool: "tl_read_file", arguments: { taskEpoch: "new", paths: ["pkg/never/served.go"] } });
      expect(body["field"]).toBeUndefined();
      expect(body["candidates"]).toBeUndefined();
    }, 10000);

    it("a top-level handle leaves the call to the dispatcher's own per-item check", () => {
      const root = "/workspace/addressless-toplevel";
      recordExecutionContract(root, "fix balance sign", certificate("cert-top", TARGETS));
      expect(guardExecutionEdit(root, {
        handle: "h-compute",
        edits: [{ search: "a", replace: "b" }],
      }, resolveHandlePath)).toEqual({ allowed: true });
    }, 10000);

    it("a create item is not an address-less item", () => {
      const root = "/workspace/addressless-create";
      recordExecutionContract(root, "fix balance sign", certificate("cert-create", TARGETS));
      const body = refusedBody(guardExecutionEdit(root, {
        edits: [{ create: true, content: "package x\n" }],
      }, resolveHandlePath));
      expect(body["detail"]).toBe("edit has no certificate-backed handle or path");
      expect(body["field"]).toBeUndefined();
    }, 10000);

    it("an answer-ready certificate keeps its own refusal", () => {
      const root = "/workspace/addressless-answer";
      recordExecutionContract(root, "explain balance sign", certificate("cert-answer", TARGETS, "answer"));
      const body = refusedBody(guardExecutionEdit(root, { edits: [{ search: "a", replace: "b" }] }, resolveHandlePath));
      expect(String(body["detail"])).toContain("answer-ready certificate does not authorize edits");
      expect(body["challenge"]).toBeDefined();
      expect(body["field"]).toBeUndefined();
      expect(body["candidates"]).toBeUndefined();
    }, 10000);
  });
});
