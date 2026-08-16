/**
 * editFamily.spec.ts — protocol v1, A.5.11–A.5.14 + §4.2.1 (C2-5).
 *
 * THE EXACT REGRESSION CALL SHAPES for the `edit_file` family migration, per
 * AGENTS.md. Five emit paths reach one member and all five are exercised here:
 * single search/replace, `edits[]` batch, `create:true`, `mode=rename`, and the
 * pathless dispatch.
 *
 * WHAT THIS FILE IS REALLY GUARDING. §4.2.1 states the one property this phase
 * must not break: converting a side-effect report into a refusal does not
 * withhold information, it ASSERTS A FALSEHOOD ABOUT THE CALLER'S DISK, and it
 * is the one falsehood the caller cannot detect — the only record of what
 * happened was the response that got replaced. So the assertions below are not
 * shape tourism:
 *
 *   - SE-STABLE (§4.2.1(1)). `edit.applied` / `edit.rolled_back` /
 *     `edit.state_unknown` never become `refusal` and never become each other,
 *     at any budget, through any funnel path — including the deprecated write
 *     aliases, which `CANON` does not map and which therefore reached the
 *     funnel as `read.text` before this commit.
 *   - THE FLOOR (§4.2.1(3)). Counts + non-empty paths + a workspace marker on
 *     every one of the three, and the paths are the WORKSPACE-RELATIVE ones a
 *     human types into `git diff`, never handles.
 *   - ROW 13. `code:"rollback-failed"` means the RESTORE failed, which is
 *     `edit.state_unknown`; a CLEAN rollback is `edit.rolled_back`. Two flags
 *     for three states became two members, and the discriminating test is here.
 *   - ROW 14. `checkpoint: null` is OMITTED, not emitted as `null` — at the
 *     wire, while `applyEditsMulti`'s own `string | null` contract stands.
 *
 * The rollback members are driven through `finalizeProtocolResponse` directly
 * rather than by inducing a mid-batch write failure over stdio: the funnel IS
 * the boundary the rule is about, and driving it directly is what lets one test
 * assert "no budget produces a refusal" over a body that is otherwise
 * indistinguishable from one (`ok:false`, `isError:true`, a `write-error` code).
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { finalizeProtocolResponse, kindForCall, runWithProtocolCall } from "../protocol/envelope.js";
import { applyEditsMulti } from "../tools/applyEditsMulti.js";
import { handleTable } from "../util/handles.js";

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
  const dir = fs.mkdtempSync(path.join(HOME, `.tl-efam-${tag}-`));
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

  function send(obj: unknown): void {
    child.stdin!.write(JSON.stringify(obj) + "\n");
  }

  function rpc(id: number, method: string, params?: unknown, timeoutMs = 25000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`rpc '${method}' timed out after ${timeoutMs}ms.\n--- server stderr ---\n${stderr}`));
      }, timeoutMs);
      waiters.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async function initialize(): Promise<void> {
    await rpc(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "vitest", version: "0" },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  function kill(): void {
    try { child.kill("SIGKILL"); } catch { /* ok */ }
  }

  return { initialize, rpc, kill };
}

afterEach(() => {
  for (const s of servers.splice(0)) s.kill();
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

// ---------------------------------------------------------------------------
// Shared assertions
// ---------------------------------------------------------------------------

type Body = Record<string, unknown>;

function parseEdit(rpcResult: any): { text: string; data: Body; isError: boolean } {
  const text: string = rpcResult?.result?.content?.[0]?.text;
  expect(typeof text).toBe("string");
  return {
    text,
    data: JSON.parse(text) as Body,
    isError: rpcResult?.result?.isError === true,
  };
}

/**
 * §4.2.1(3): the floor, asserted as a floor.
 *
 * Every element is checked because the rule is "the shedder may never cut ANY
 * of it" — a core missing one of the four is not a smaller core, it is a report
 * a caller cannot recover from without the handle §4.2.1(5) says may be gone.
 */
function assertFloor(data: Body, expected: { paths: string[]; counts: Partial<Record<string, number>> }): void {
  const core = data["core"] as Body | undefined;
  expect(core, `no SideEffectCore on ${String(data["kind"])}`).toBeDefined();
  expect(core!["paths"]).toEqual(expected.paths);
  // Non-empty BY TYPE (`[string, ...string[]]`); non-empty on the wire too.
  expect((core!["paths"] as string[]).length).toBeGreaterThan(0);
  const counts = core!["counts"] as Record<string, number>;
  for (const key of ["applied", "attempted", "reverted", "unproven"]) {
    expect(typeof counts[key], `counts.${key}`).toBe("number");
  }
  for (const [key, value] of Object.entries(expected.counts)) {
    expect(counts[key], `counts.${key}`).toBe(value);
  }
  const workspace = core!["workspace"] as Record<string, unknown>;
  expect(typeof workspace["fingerprint"]).toBe("string");
  expect(String(workspace["fingerprint"]).length).toBeGreaterThan(0);
  // The write path consults no inventory, so claiming otherwise would be a
  // claim about files this operation never looked at.
  expect(workspace["scope"]).toBe("served-evidence");
  expect(workspace["inventory_complete"]).toBe(false);
  // A path, never a handle (§4.2.1(3)): workspace-RELATIVE, no leading slash.
  for (const p of core!["paths"] as string[]) {
    expect(path.isAbsolute(p), `core.paths must be workspace-relative: ${p}`).toBe(false);
  }
}

// ---------------------------------------------------------------------------
// A.5.11 `edit.applied` — the five emit paths
// ---------------------------------------------------------------------------

describe("A.5.11 edit.applied — every emit path reports one member (C2-5)", () => {
  it("single search/replace: core + applied[] carrying handle/lines/delta (ruling 4)", async () => {
    const ws = mkDir("single");
    writeFile(ws, "src/foo.ts", "export const VERSION = 'OLD';\n");
    const srv = startServer({ cwd: ws, args: [ws, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    const { data, isError } = parseEdit(await srv.rpc(2, "tools/call", {
      name: "edit_file",
      arguments: { path: "src/foo.ts", search: "OLD", replace: "NEW" },
    }));

    expect(data["kind"]).toBe("edit.applied");
    // A.8 rule E-3: `isError` is present iff the kind is one of exactly three,
    // and `edit.applied` is not one of them.
    expect(isError).toBe(false);
    assertFloor(data, {
      paths: ["src/foo.ts"],
      counts: { applied: 1, attempted: 1, reverted: 0, unproven: 0 },
    });

    // RULING 4: `handle` / `lines` / `delta` had NO declared address before this
    // commit — A.5.11 folds `files[]` into `core.paths` and says nothing about
    // the other three. P3a: "handle absence induces follow-up round-trips =
    // high-value field, LAST-stage shed."
    const applied = data["applied"] as Body[];
    expect(applied).toHaveLength(1);
    expect(applied[0]!["path"]).toBe("src/foo.ts");
    expect(typeof applied[0]!["handle"]).toBe("string");
    expect(applied[0]!["delta"]).toBe("+1/-1");
    expect(applied[0]!["code"]).toBeUndefined();
    expect(String(applied[0]!["slice_sha"])).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(applied[0]!["head"]).toEqual(["export const VERSION = 'NEW';", ""]);

    // D6: the body `ok` boolean is gone; `kind` carries the outcome.
    expect(data["ok"]).toBeUndefined();
  }, 30000);

  it("edits[] batch: files[] folds into core.paths + applied[], and nothing is lost", async () => {
    const ws = mkDir("batch");
    writeFile(ws, "src/a.ts", "export const A = 'OLD';\n");
    writeFile(ws, "src/b.ts", "export const B = 'OLD';\n");
    const srv = startServer({ cwd: ws, args: [ws, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    const { data } = parseEdit(await srv.rpc(2, "tools/call", {
      name: "edit_file",
      arguments: {
        edits: [
          { path: "src/a.ts", search: "OLD", replace: "NEW" },
          { path: "src/b.ts", search: "OLD", replace: "NEW" },
        ],
      },
    }));

    expect(data["kind"]).toBe("edit.applied");
    assertFloor(data, { paths: ["src/a.ts", "src/b.ts"], counts: { applied: 2, attempted: 2 } });

    // A.5.11: "Today's `files: EditFileResult[]` folds into `core.paths`."
    // Deleted from the wire — and the fold is TOTAL, so every path still
    // carries its own post-edit handle.
    expect(data["files"]).toBeUndefined();
    const applied = data["applied"] as Body[];
    expect(applied.map((entry) => entry["path"])).toEqual(["src/a.ts", "src/b.ts"]);
    for (const entry of applied) expect(typeof entry["handle"]).toBe("string");
    // Row 14: a batch DOES take a checkpoint, so the field is present here —
    // the omission case is asserted below.
    expect(typeof data["checkpoint"]).toBe("string");
  }, 30000);

  it("create:true reports the created path in the floor and gives its handle an applied[] address", async () => {
    const ws = mkDir("create");
    const srv = startServer({ cwd: ws, args: [ws, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    const { data } = parseEdit(await srv.rpc(2, "tools/call", {
      name: "edit_file",
      arguments: { path: "src/new.ts", content: "export const NEW = 1;\n", create: true, cwd: ws },
    }));

    expect(data["kind"]).toBe("edit.applied");
    assertFloor(data, { paths: ["src/new.ts"], counts: { applied: 1, attempted: 1 } });
    const applied = data["applied"] as Body[];
    expect(applied).toHaveLength(1);
    expect(applied[0]!["path"]).toBe("src/new.ts");
    // A create has no edited span, so `range` is the whole new file. `code` is
    // ABSENT rather than `""` — there was no read-back, and E-1 forbids
    // spelling that absence with an empty string.
    expect(applied[0]!["range"]).toBe("1-1");
    expect(applied[0]!["code"]).toBeUndefined();
    expect(typeof applied[0]!["handle"]).toBe("string");
  }, 30000);

  it("mode=rename is the same member, and its per-file replacement counts survive", async () => {
    const ws = mkDir("rename");
    writeFile(ws, "src/x.ts", "export function oldName(): void {}\n");
    writeFile(ws, "src/y.ts", "import { oldName } from './x';\noldName();\n");
    const srv = startServer({ cwd: ws, args: [ws, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    const { data } = parseEdit(await srv.rpc(2, "tools/call", {
      name: "edit_file",
      arguments: { mode: "rename", from: "oldName", to: "newName", lang: "ts" },
    }));

    expect(data["kind"]).toBe("edit.applied");
    const core = data["core"] as Body;
    expect((core["paths"] as string[]).length).toBeGreaterThan(0);
    expect((core["counts"] as Record<string, number>)["reverted"]).toBe(0);
    // `changed_files` cannot fold into `applied[]`: `RenameFileResult` is
    // `{path, replacements}` with no line span, and `AppliedEntry.range` is
    // required. Carried rather than dropped — a disclosed deviation.
    expect(Array.isArray(data["changed_files"])).toBe(true);
    expect(typeof data["total_replacements"]).toBe("number");
  }, 30000);

  it("pathless dispatch reports the file it resolved, in the floor", async () => {
    const ws = mkDir("pathless");
    writeFile(ws, "src/only.ts", "export const UNIQUE_FLAG_QQ = 'OLD';\n");
    const srv = startServer({ cwd: ws, args: [ws, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    const { data } = parseEdit(await srv.rpc(2, "tools/call", {
      name: "edit_file",
      arguments: { search: "UNIQUE_FLAG_QQ = 'OLD'", replace: "UNIQUE_FLAG_QQ = 'NEW'" },
    }));

    expect(data["kind"]).toBe("edit.applied");
    assertFloor(data, { paths: ["src/only.ts"], counts: { applied: 1, attempted: 1 } });
  }, 30000);

  // P3a S4 (recon open Q6 / work-order §2.5 item 3): `buildCore`
  // (`editFamily.ts`) returns `undefined` iff `paths`, after de-dup and
  // empty-string filtering, is EMPTY -- the ONLY branch that can produce it.
  // No real spawn/dispatch path in this suite constructs a body that resolves
  // zero paths (every real `edit_file` success names at least one file), so
  // this exercises the projector directly via `finalize()` (defined below,
  // hoisted, and already the harness the rollback/state_unknown tests use)
  // rather than a spawn -- there is nothing server-side to dispatch to.
  it("a no-path success body fails closed as a state-unknown refusal instead of omitting SideEffectCore", () => {
    const out = finalize("edit_file", { ok: true }, false);
    expect(out.isError).toBe(true);
    expect(out.data["kind"]).toBe("refusal");
    expect(out.data["code"]).toBe("invalid-input");
    expect(out.data["retry"]).toBe("none");
    expect(String(out.data["detail"])).toMatch(/fail-closed side-effect/);
    expect(String(out.data["detail"])).toMatch(/unverified/);
  });
});

// ---------------------------------------------------------------------------
// A.9.2 row 14 + the NormalizationReceipt
// ---------------------------------------------------------------------------

describe("A.9.2 row 14 + RULE R — the two receipts on edit.applied (C2-5)", () => {
  it("row 14: a checkpoint-less success OMITS the field rather than emitting null", async () => {
    const ws = mkDir("nocheckpoint");
    writeFile(ws, "src/foo.ts", "export const VERSION = 'OLD';\n");
    const srv = startServer({ cwd: ws, args: [ws, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    const { text, data } = parseEdit(await srv.rpc(2, "tools/call", {
      name: "edit_file",
      arguments: { path: "src/foo.ts", search: "OLD", replace: "NEW" },
    }));

    expect(data["kind"]).toBe("edit.applied");
    // The single-edit path never takes a checkpoint, so HEAD's `string | null`
    // contract would put `"checkpoint":null` on the wire. §1.3's absence
    // convention spells that by omitting the key.
    expect("checkpoint" in data).toBe(false);
    expect(text).not.toContain("null");
  }, 30000);

  it("applied-normalized is a RECEIPT, not an outcome: the single-edit boolean becomes a path list", async () => {
    const ws = mkDir("normalized");
    // A caller that double-encodes its search string: the literal two-character
    // `\n` is unescaped and RETRIED, which changes the bytes that land — the
    // disclosure exists so that rewrite is never silent.
    writeFile(ws, "src/foo.ts", "const a = 1;\nconst b = 2;\n");
    const srv = startServer({ cwd: ws, args: [ws, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    const { data } = parseEdit(await srv.rpc(2, "tools/call", {
      name: "edit_file",
      arguments: { path: "src/foo.ts", search: "const a = 1;\\nconst b", replace: "const a = 9;\\nconst b" },
    }));

    expect(data["kind"]).toBe("edit.applied");
    // §2.4: the side-effect state is identical to a plain apply, so this is a
    // receipt ON `edit.applied` and not a sixth outcome to branch on.
    const normalization = data["normalization"] as Body;
    expect(normalization).toBeDefined();
    // A.5.11 declares PATH LISTS. The single-edit engine reports
    // `normalized_escapes: true`; the response knows its own path, so the
    // boolean was only ever a path list with the path left out.
    expect(normalization["normalized_escapes"]).toEqual(["src/foo.ts"]);
    expect(data["normalized_escapes"]).toBeUndefined();
  }, 30000);
});

// ---------------------------------------------------------------------------
// A.5.13 / A.5.14 + A.9.2 row 13 — the two failure members, and SE-STABLE
// ---------------------------------------------------------------------------

/**
 * The funnel, driven directly.
 *
 * `finalizeProtocolResponse` is the boundary §4.2.1(1) is a rule ABOUT: it is
 * the only place in this process that can produce a `refusal`. Driving it with
 * a hand-built emitter body is what lets these tests state the rule as a rule —
 * "no input under any flag produces a refusal from a side-effect-bearing body"
 * — over bodies that are otherwise indistinguishable from refusals (`ok:false`,
 * `isError:true`, a `write-error` code, no `applied[]`).
 */
function finalize(tool: string, body: Body, isError: boolean): { data: Body; isError: boolean } {
  const result = runWithProtocolCall({ tool, args: {}, workspace: "/ws" }, () =>
    finalizeProtocolResponse(tool, {
      content: [{ type: "text", text: JSON.stringify(body) }],
      ...(isError ? { isError: true as const } : {}),
    }),
  );
  return {
    data: JSON.parse(result.content[0]!.text) as Body,
    isError: result.isError === true,
  };
}

/** A CLEAN mid-batch rollback, as `applyEditsMulti` now emits it (ruling 3). */
const CLEAN_ROLLBACK: Body = {
  ok: false,
  error: "Cannot write file: EACCES: permission denied",
  code: "write-error",
  path: "src/b.ts",
  rollback: [{ path: "src/a.ts", state: "rolled-back" }],
};

/** A rollback whose RESTORE failed: the tree matches neither state. */
const FAILED_ROLLBACK: Body = {
  ok: false,
  error: "Cannot write file: EACCES. Rollback could not restore every file — manual repair needed.",
  code: "rollback-failed",
  path: "src/c.ts",
  workspace_state: "workspace-state-unknown",
  rollback: [
    { path: "src/a.ts", state: "rolled-back" },
    {
      path: "src/b.ts",
      state: "restore-failed",
      expected_sha: "sha256:aaaaaaaaaaaa",
      stuck_sha: "sha256:bbbbbbbbbbbb",
      detail: "injected",
    },
  ],
  recovery: "inspect src/b.ts: each still holds POST-edit bytes (stuck_sha) instead of expected_sha.",
};

describe("A.9.2 row 13 — one flag pair became two members (C2-5)", () => {
  it("a CLEAN rollback is edit.rolled_back, and it reports the ledger it used to discard", () => {
    const { data, isError } = finalize("edit_file", CLEAN_ROLLBACK, false);

    // RULING 3 (user-adjudicated 2026-08-14). This body used to be a bare
    // four-key `write-error` — the caller learned nothing about N files that
    // had been written and put back — and it classified as a `refusal`, whose
    // §2.4 row says NOTHING WAS ATTEMPTED. Both halves are fixed here.
    expect(data["kind"]).toBe("edit.rolled_back");
    expect(isError).toBe(true);
    assertFloor(data, {
      paths: ["src/a.ts"],
      counts: { applied: 0, attempted: 1, reverted: 1, unproven: 0 },
    });
    expect(data["attempted"]).toEqual([{ path: "src/a.ts", state: "rolled-back" }]);
    // A.5.14's array name belongs to the OTHER member.
    expect(data["affected"]).toBeUndefined();
    // The sentinel strings are deleted: the KIND carries both facts now.
    expect(data["code"]).toBeUndefined();
    expect(data["workspace_state"]).toBeUndefined();
    expect(data["error"]).toBeUndefined();
    // …but WHY it failed and WHICH file could not be written survive.
    expect(String(data["detail"])).toContain("EACCES");
    expect(data["path"]).toBe("src/b.ts");
  });

  it("a FAILED restore is edit.state_unknown — not rolled_back, which C2-2's probe had backwards", () => {
    const { data, isError } = finalize("edit_file", FAILED_ROLLBACK, true);

    // `code:"rollback-failed"` means THE RESTORE ITSELF FAILED, which is §2.4's
    // "edits were attempted, the revert failed, on-disk state is not provable".
    // The transitional probe mapped it to `edit.rolled_back` — the CLEAN case.
    expect(data["kind"]).toBe("edit.state_unknown");
    expect(isError).toBe(true);
    assertFloor(data, {
      paths: ["src/a.ts", "src/b.ts"],
      counts: { applied: 0, attempted: 2, reverted: 1, unproven: 1 },
    });
    expect((data["affected"] as Body[])).toHaveLength(2);
    expect(data["attempted"]).toBeUndefined();
    // §2.4's normative invariant: `recovery` is REQUIRED here.
    expect(typeof data["recovery"]).toBe("string");
    expect(data["workspace_state"]).toBeUndefined();
  });

  // Orchestrator directive 2026-08-14: the SECOND §2.5-item-3 site.
  // `projectLedgerMember` (editFamily.ts, the rolled_back/state_unknown core
  // assembly) carries the same `if (core !== undefined)` conditional emission
  // as `edit.applied`'s :517 site, and gets the same guaranteed-fit treatment:
  // the validator's CORE_WHEN_PRESENT predicate (requiredSets.ts) accepts a
  // core-less ledger member, and this INDEPENDENT assertion pins the branch so
  // merge verification can see it without inferring from the applied-side test.
  // Pathless ledger rows are the only branch that produces it: `paths` filters
  // to empty, `buildCore` returns undefined, the key is omitted outright.
  it("pathless ledger rows fail closed as state-unknown refusals when SideEffectCore cannot be derived", () => {
    const rolled = finalize("edit_file", { ok: false, error: "EACCES", code: "write-error", rollback: [{ state: "rolled-back" }] }, false);
    expect(rolled.isError).toBe(true);
    expect(rolled.data["kind"]).toBe("refusal");
    expect(String(rolled.data["detail"])).toMatch(/fail-closed side-effect/);
    const restoreFailed = finalize("edit_file", { ok: false, error: "rollback failed", code: "rollback-failed", rollback: [{ state: "restore-failed" }], recovery: "inspect" }, true);
    expect(restoreFailed.isError).toBe(true);
    expect(restoreFailed.data["kind"]).toBe("refusal");
    expect(String(restoreFailed.data["detail"])).toMatch(/fail-closed side-effect/);
  });

  it("the two members are DISCRIMINATED by the ledger, not by a convention", () => {
    // The whole point of splitting them: "rolled back cleanly" and "cannot
    // prove the on-disk state" are two different things a client must handle
    // differently. One flip of one row's `state` is the entire difference.
    const clean = finalize("edit_file", CLEAN_ROLLBACK, false).data;
    const failed = finalize("edit_file", FAILED_ROLLBACK, true).data;
    expect(clean["kind"]).not.toBe(failed["kind"]);
    expect((clean["core"] as Body)["counts"]).toMatchObject({ reverted: 1, unproven: 0 });
    expect((failed["core"] as Body)["counts"]).toMatchObject({ reverted: 1, unproven: 1 });
    // `recovery` is optional on one and required on the other (§2.4).
    expect(clean["recovery"]).toBeUndefined();
    expect(failed["recovery"]).toBeDefined();
  });

  it("an EMPTY ledger is still a refusal — nothing was written, and saying so is true", () => {
    // The batch whose FIRST write failed: atomic writes leave that file at its
    // pre-edit bytes, so no file changed and §2.4's "nothing was attempted" is
    // honest. This is the boundary that makes the ledger a real discriminant
    // rather than a synonym for `write-error`.
    const { data } = finalize("edit_file", {
      ok: false, error: "Cannot write file: EACCES", code: "write-error", path: "src/a.ts",
    }, false);
    expect(data["kind"]).toBe("refusal");
    expect(data["core"]).toBeUndefined();
  });
});

describe("§4.2.1(1) SE-STABLE — a side-effect report is never converted (C2-5)", () => {
  const APPLIED_BODY: Body = { ok: true, path: "src/a.ts", lines: "1", delta: "+1/-1", handle: "h1" };
  const CASES: ReadonlyArray<readonly [string, Body, string]> = [
    ["edit.rolled_back", CLEAN_ROLLBACK, "edit.rolled_back"],
    ["edit.state_unknown", FAILED_ROLLBACK, "edit.state_unknown"],
  ];

  it("neither ledger-bearing member is converted, under either transport flag", () => {
    // THE LOAD-BEARING CASE. Both bodies carry `ok:false`, one carries
    // `isError:true`, and `isRefusalBody` reads exactly those two signals — so
    // every ordering regression in `kindForCall` lands here first. §2.5 makes
    // `isError` ADVISORY INPUT to classification and authority nowhere; it is
    // re-derived from `kind` afterwards, which is why the same body classifies
    // identically whichever way the emitter set it.
    //
    // SCOPE, STATED. This is about the CLASSIFICATION being stable, and about
    // §4.2.1(1)'s "no budget value, no configuration and no error condition at
    // the boundary under which the kind changes". It is not a claim that a body
    // asserting `ok:true` AND `isError:true` at once resolves to success: that
    // contradiction is an EMITTER bug, no dispatch path in this tree produces
    // it, and guessing which half to believe would mean reading a `path` on a
    // pre-write refusal as proof of a write.
    for (const [name, body, expected] of CASES) {
      for (const flag of [true, false]) {
        const { data } = finalize("edit_file", body, flag);
        expect(data["kind"], `${name} with isError=${flag}`).toBe(expected);
        expect(data["kind"], `${name} with isError=${flag}`).not.toBe("refusal");
      }
    }
    expect(finalize("edit_file", APPLIED_BODY, false).data["kind"]).toBe("edit.applied");
  });

  it("A.8 rule E-3: isError is set on exactly the two members §2.5 names", () => {
    expect(finalize("edit_file", APPLIED_BODY, false).isError).toBe(false);
    expect(finalize("edit_file", CLEAN_ROLLBACK, false).isError).toBe(true);
    expect(finalize("edit_file", FAILED_ROLLBACK, false).isError).toBe(true);
  });

  it("D11: the four deprecated WRITE ALIASES are no longer write tools — the hole is closed by deletion", () => {
    // The live SE-STABLE hole C2-5 patched: `CANON` mapped only the three
    // read/search renames, so a write through `apply_edits_multi` or
    // `search_replace_edit` reached the funnel under its OWN name, missed the
    // edit gate, and classified as `read.text` — a completed effect on the
    // caller's disk wearing a read's member. C2-5 widened WRITE_TOOLS to those
    // four names; D11 then DELETED the names, so the widening is deleted too.
    //
    // This pin is the read-back of that: the four names are no longer known to
    // the funnel at all. It is not a claim about behaviour a caller can reach
    // — no caller can name them any more (legacyAliasGating.spec.ts) — it is
    // the guard against silently RE-ADDING one to WRITE_TOOLS without also
    // re-adding the tool, which would resurrect a write door with no schema.
    //
    // ASKED OF THE CLASSIFIER, NOT OF THE EMITTER (S2b). The question this pin
    // asks — "is this name a write tool?" — is `kindForCall`'s, and that is the
    // whole of `WRITE_TOOLS`'s reach. Driving the same probe through
    // `finalize()` asked a SECOND question the pin never meant to ask: it made
    // the emitter shape an `edit.applied`-shaped body as a `read.text`, a member
    // whose required set is >=1 addressed `Evidence` (§4.3), which that body has
    // no way to satisfy. No production path can produce that state — a deleted
    // alias is refused at the JSON-RPC method level with -32601 and never
    // reaches `callTool`, let alone the funnel (legacyAliasGating.spec.ts) — so
    // the emitter was being asked to shape a response that cannot exist. The
    // classifier call is the same probe against the layer that actually holds
    // the answer, and it stays discriminating: `APPLIED_BODY` is exactly the
    // body that DOES classify `edit.applied` under the one real name, asserted
    // two lines below.
    for (const alias of ["apply_edits_multi", "search_replace_edit", "create_file", "read_and_edit"]) {
      const kind = kindForCall({ tool: alias, args: {}, workspace: "/ws" }, APPLIED_BODY, false);
      expect(kind, alias).not.toBe("edit.applied");
    }
    // edit_file is the one and only door.
    expect(finalize("edit_file", APPLIED_BODY, false).data["kind"]).toBe("edit.applied");
    expect(finalize("edit_file", CLEAN_ROLLBACK, false).data["kind"]).toBe("edit.rolled_back");
    expect(finalize("edit_file", FAILED_ROLLBACK, true).data["kind"]).toBe("edit.state_unknown");
  });

  it("a write that DOES refuse names edit_file, not read_file, as the tool to retry", () => {
    // `Refusal.for` names the ADVERTISED tool a caller can re-issue against
    // (A.5.15). After D11 only advertised names reach this funnel, so `for` is
    // structurally incapable of naming something absent from `tools/list`.
    const { data } = finalize("edit_file", { ok: false, error: "edits must be an array" }, false);
    expect(data["kind"]).toBe("refusal");
    expect(data["for"]).toBe("edit_file");
  });

  it("a body the projector cannot shape fails closed as a refusal instead of degrading the side-effect outcome", () => {
    const out = finalize("edit_file", { ok: true, note: "no path anywhere" }, false);
    expect(out.isError).toBe(true);
    expect(out.data["kind"]).toBe("refusal");
    expect(String(out.data["detail"])).toMatch(/fail-closed side-effect/);
  });
});

// ---------------------------------------------------------------------------
// A.5.12 — the reclassification receipt
// ---------------------------------------------------------------------------

describe("A.5.12 — reclassification is a RECEIPT on the write that happened (ruling 2)", () => {
  const RECLASSIFIED = {
    from: "answer", to: "edit", trigger: "grounded-edit", certificate_id: "cert-abc123",
  };

  it("rides edit.applied, keeping the side-effect proof a standalone kind would discard", () => {
    const { data } = finalize("edit_file", {
      ok: true, path: "src/a.ts", lines: "1", delta: "+1/-1", handle: "h1",
      reclassified: RECLASSIFIED,
    }, false);

    // The appendix models `edit.reclassified` as "nothing was written". Every
    // reclassification this server emits is attached to a write that ALREADY
    // LANDED, so porting it literally would have deleted the proof — the one
    // thing §4.2.1 exists to make impossible.
    expect(data["kind"]).toBe("edit.applied");
    expect(data["core"]).toBeDefined();
    expect(data["reclassification"]).toEqual({
      trigger: "grounded-edit", certificate_id: "cert-abc123",
    });
    // `from`/`to` are constants and carry nothing a caller can act on.
    expect(JSON.stringify(data)).not.toContain('"from"');
    expect(data["reclassified"]).toBeUndefined();
  });

  it("A.5.12's union obligation is discharged: `trigger` is closed, not a bare string", () => {
    // §1.4 makes narrowing a `string` to a union breaking AFTER publication, so
    // the declaration has to happen before. An out-of-union trigger is not
    // emitted at all rather than widening the contract by accident.
    const { data } = finalize("edit_file", {
      ok: true, path: "src/a.ts", lines: "1", delta: "+1/-1",
      reclassified: { ...RECLASSIFIED, trigger: "some-future-trigger" },
    }, false);
    expect(data["reclassification"]).toBeUndefined();
    expect(data["kind"]).toBe("edit.applied");
  });

  it("a receipt with no certificate_id is not emitted — there is nothing to check it against", () => {
    // Same rule the same adjudication set for `Refusal.certificate_id`:
    // `certificate_id` is the only non-constant field and the correlation key
    // back to the fence that re-typed the call.
    const { data } = finalize("edit_file", {
      ok: true, path: "src/a.ts", lines: "1", delta: "+1/-1",
      reclassified: { from: "answer", to: "edit", trigger: "create" },
    }, false);
    expect(data["reclassification"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §4.2.1 — a post-write fault must not discard a completed side effect
// ---------------------------------------------------------------------------

describe("§4.2.1 — bookkeeping that runs AFTER the write cannot delete the report (C2-5)", () => {
  it("a handle-mint failure degrades the report; it does not throw the batch away", async () => {
    // THE LIVE RISK THIS CLOSES. `applyEditsMulti`'s per-file result block runs
    // AFTER the writes committed, and it was unguarded: an exception from
    // `shaOfText` or `handleTable.upsert` propagated to `callTool`, then to the
    // hand-rolled JSON-RPC catch, and answered a batch THAT HAD ALREADY WRITTEN
    // BOTH FILES with a contentless -32603. Byte pressure — or here, a
    // bookkeeping fault — rewriting what happened to a file is the exact
    // shearing bug §4.2.1 exists to remove.
    //
    // The degraded path keeps everything computed BEFORE the write (path,
    // lines, delta, all from Phase 1) and gives up only the handle, whose empty
    // string the wire projection drops per A.8 rule E-1.
    const ws = mkDir("postwrite");
    writeFile(ws, "a.ts", "export const A = 'OLD';\n");
    writeFile(ws, "b.ts", "export const B = 'OLD';\n");

    const spy = vi.spyOn(handleTable, "upsert").mockImplementation(() => {
      throw new Error("injected handle-mint failure");
    });
    try {
      const result = await applyEditsMulti(
        {
          edits: [
            { path: "a.ts", search: "OLD", replace: "NEW" },
            { path: "b.ts", search: "OLD", replace: "NEW" },
          ],
        },
        ws as never,
        true,
        "editfamily-postwrite",
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
      for (const file of result.files) {
        expect(file.lines).not.toBe("");
        expect(file.delta).not.toBe("");
        expect(file.handle).toBe("");
      }
    } finally {
      spy.mockRestore();
    }

    // And the writes really did land — which is the whole point: the response
    // now says so.
    expect(fs.readFileSync(path.join(ws, "a.ts"), "utf8")).toContain("NEW");
    expect(fs.readFileSync(path.join(ws, "b.ts"), "utf8")).toContain("NEW");
  }, 30000);
});

// ---------------------------------------------------------------------------
// The refusal exit — a SAMPLE of the pre-write sites
// ---------------------------------------------------------------------------

describe("pre-write refusals leave through the cross-tool Refusal, not the edit family (C2-5)", () => {
  it("three shapes that never touched disk are refusals with a code and a retry", async () => {
    // §2.4: "`refused` leaves the edit family. A refusal is not an edit result;
    // it is the cross-tool `Refusal` of §2.6 with `for:\"edit_file\"`." The
    // ~23 pre-write refusal sites in `applyEditsMulti` are all this shape, and
    // the distinguishing property is the one that matters here: NO `core`,
    // because nothing was attempted.
    const ws = mkDir("prewrite");
    writeFile(ws, "src/dup.ts", "const x = 1;\nconst x = 1;\n");
    const srv = startServer({ cwd: ws, args: [ws, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    const cases: Array<[string, Body]> = [
      ["missing file", { path: "src/nope.ts", search: "a", replace: "b" }],
      ["non-unique search under precondition", { path: "src/dup.ts", search: "const x = 1;", replace: "y", precondition: "unique-match" }],
      ["empty edits[]", { edits: [] }],
    ];
    let id = 2;
    for (const [label, args] of cases) {
      const { data } = parseEdit(await srv.rpc(id++, "tools/call", { name: "edit_file", arguments: args }));
      expect(data["kind"], label).toBe("refusal");
      expect(data["for"], label).toBe("edit_file");
      expect(typeof data["code"], label).toBe("string");
      expect(typeof data["retry"], label).toBe("string");
      // The property §4.2.1 turns on: a refusal claims nothing happened, and
      // carries no side-effect core to contradict itself with.
      expect(data["core"], label).toBeUndefined();
      // D6: no body `ok` on any member.
      expect(data["ok"], label).toBeUndefined();
    }
  }, 30000);
});
