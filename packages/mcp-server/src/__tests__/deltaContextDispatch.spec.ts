/**
 * deltaContextDispatch.spec.ts — B2 / V12-02 delta context, through the REAL
 * dispatcher (spawned server + JSON-RPC).
 *
 * WHY A SPAWNED SERVER. The lever spans three modules that only meet at
 * runtime: the write seam (`write/atomicWrite.ts` -> `write/deltaContext.ts`),
 * the ledger (`state/session.ts`), and the read dispatch + v1 projector
 * (`server.ts` -> `protocol/readFamily.ts`). A unit test of any one of them
 * would prove nothing about the sequence that matters — edit, then read.
 *
 * The six cells:
 *   (a) OFF PARITY — a full edit-then-read sequence is byte-identical to what a
 *       server that never saw the pre-edit file returns for the same read.
 *   (b) ON — the read serves prior + residual, and the two RECONSTRUCT the file
 *       byte-for-byte (delta reconstruction 100%).
 *   (c) EXTERNAL MODIFICATION between edit and read -> full body (base-mismatch
 *       fallback 100%).
 *   (d) force_serve:true -> full body, always.
 *   (e) SIZE GUARD — a projection that would cost more than the body serves the
 *       body (delta>full -> full).
 *   (f) MULTI-HUNK edits[] batch -> one enclosing region, still reconstructing.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { killServerGroup } from "./helpers/killServerGroup.js";
import { TSX_NODE_ARGS } from "./helpers/tsxNode.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.resolve(here, "..", "bin.ts");

type RpcServer = {
  rpc(id: number, method: string, params?: unknown): Promise<any>;
  kill(): void;
};

const spawned: RpcServer[] = [];
const tmpDirs: string[] = [];

function startServer(root: string, env: Record<string, string>): RpcServer {
  const child: ChildProcess = spawn(process.execPath, [...TSX_NODE_ARGS, bin, "--workspace", root, "--allow-write"], {
    cwd: root,
    // TL_EFF_SLIM_EDIT=0 restores the ±20 / enclosing-symbol after-window these
    // cases' exact spans were measured against (the default since 2026-10-01
    // is ±3); a case may override it, as (b2) does.
    env: { ...process.env, TOKENLIGHTEN_ALLOWED_PARENTS: os.homedir(), TL_EFF_SLIM_EDIT: "0", ...env },
    stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32",
  });
  let pending = "";
  let stderr = "";
  const waiters = new Map<number, (value: any) => void>();
  child.stdout!.on("data", (chunk: Buffer) => {
    pending += chunk.toString();
    let nl = -1;
    while ((nl = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line);
        const waiter = value?.id === undefined ? undefined : waiters.get(value.id);
        if (waiter !== undefined) {
          waiters.delete(value.id);
          waiter(value);
        }
      } catch { /* startup diagnostics never belong on stdout */ }
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const server: RpcServer = {
    rpc: (id, method, params) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`RPC timeout: ${id} ${method}\n${stderr}`));
      }, 60000);
      waiters.set(id, (value) => { clearTimeout(timer); resolve(value); });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    }),
    kill: () => { try { killServerGroup(child); } catch { /* already stopped */ } },
  };
  spawned.push(server);
  return server;
}

function body(reply: any): Record<string, any> {
  return JSON.parse(String(reply?.result?.content?.[0]?.text ?? "{}")) as Record<string, any>;
}

/** The exact serialized bytes the caller received — what the parity cell compares. */
function wireText(reply: any): string {
  return String(reply?.result?.content?.[0]?.text ?? "");
}

/**
 * TWO PER-PROCESS TOKENS, AND NOTHING ELSE.
 *
 * Handle ids are minted per SERVER PROCESS, so two runs of the same sequence
 * address the same file with different opaque strings; each is rewritten to its
 * first-appearance ordinal, everywhere it occurs (including inside a `next`).
 * `SideEffectCore.workspace.fingerprint` is derived from those same ids, so it
 * moves with them — verified by running the sequence twice with IDENTICAL
 * environments, where these are the only two bytes that differ.
 *
 * Everything else — every field, every value, the structure and the ORDER — is
 * compared exactly, which is what makes this a parity cell rather than a
 * similarity check.
 */
function normalizeHandles(text: string): string {
  const seen: string[] = [];
  for (const match of text.matchAll(/"handle":"([^"]+)"/g)) {
    const id = match[1]!;
    if (!seen.includes(id)) seen.push(id);
  }
  let out = text;
  seen.forEach((id, index) => { out = out.split(id).join(`H${index}`); });
  return out.replace(/"fingerprint":"sha256:[0-9a-f]+"/g, '"fingerprint":"sha256:NORMALIZED"');
}

async function initialize(server: RpcServer): Promise<void> {
  await server.rpc(1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "delta-context", version: "1" },
  });
  await new Promise((resolve) => setTimeout(resolve, 120));
}

function makeWorkspace(prefix: string, source: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), `tl-delta-${prefix}-`)));
  tmpDirs.push(root);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "order.ts"), source, "utf8");
  // A second file gives every server a cheap first call, so the one-shot
  // server-build announcement is consumed before the payload under comparison.
  fs.writeFileSync(path.join(root, "src", "warmup.ts"), "export const warmup = 1;\n", "utf8");
  return root;
}

/** Comment-free lines: no doc elision, so a served body IS the file text. Defaults to 60; cell (a) below passes a bigger count so the edit's own PEW window (see its doc comment) covers only a fraction of the file, leaving real "outside the window" territory. */
function wideSource(lineCount = 60): string {
  const lines: string[] = [];
  for (let i = 1; i <= lineCount; i += 1) {
    lines.push(`export const marker${i} = "row ${i} payload ${"a".repeat(56)}";`);
  }
  return `${lines.join("\n")}\n`;
}

/** 24 very short lines — every held window is worth less than its own marker. */
function narrowSource(): string {
  const lines: string[] = [];
  for (let i = 1; i <= 24; i += 1) lines.push(`const s${i}=${i};`);
  return `${lines.join("\n")}\n`;
}

const WIDE_LINE_30 = `export const marker30 = "row 30 payload ${"a".repeat(56)}";`;
const WIDE_LINE_10 = `export const marker10 = "row 10 payload ${"a".repeat(56)}";`;
const WIDE_LINE_50 = `export const marker50 = "row 50 payload ${"a".repeat(56)}";`;
const WIDE_LINE_100 = `export const marker100 = "row 100 payload ${"a".repeat(56)}";`;

interface EvidenceEntry {
  range: string;
  body?: string;
  prior?: string;
}

function evidenceOf(payload: Record<string, any>): EvidenceEntry[] {
  expect(payload["kind"], JSON.stringify(payload).slice(0, 400)).toBe("read.text");
  const evidence = payload["evidence"];
  expect(Array.isArray(evidence), JSON.stringify(payload).slice(0, 400)).toBe(true);
  return evidence as EvidenceEntry[];
}

/**
 * A whole-file serve carries the file's text without its final newline (the
 * projector measures what actually shipped and `compressFormat` does not
 * re-add it), so both sides are compared trailing-newline-insensitively.
 */
function expectWholeFileBody(entry: EvidenceEntry, target: string): void {
  expect(String(entry.body ?? "").replace(/\n$/, ""))
    .toBe(fs.readFileSync(target, "utf8").replace(/\n$/, ""));
}

function parseRange(range: string): { start: number; end: number } {
  const m = /^(\d+)-(\d+)$/.exec(range);
  expect(m, `unparseable evidence range ${range}`).toBeTruthy();
  return { start: Number(m![1]), end: Number(m![2]) };
}

/**
 * DELTA RECONSTRUCTION, THE ASSERTION THIS WHOLE LEVER IS JUDGED ON.
 *
 * Walk the evidence in range order and take, for each window, the `body` the
 * response carried or — for a `prior` window — the lines the caller already
 * holds. The concatenation must be the file on disk, byte for byte. A wrong
 * shift, a kept-but-changed window or an off-by-one boundary all fail here.
 */
function reconstruct(entries: EvidenceEntry[], diskText: string): string {
  const diskLines = diskText.replace(/\n$/, "").split("\n");
  const ordered = [...entries].sort((a, b) => parseRange(a.range).start - parseRange(b.range).start);
  const out: string[] = [];
  let expectedNext = 1;
  for (const entry of ordered) {
    const { start, end } = parseRange(entry.range);
    expect(start, `evidence windows must tile without a gap: ${JSON.stringify(ordered)}`).toBe(expectedNext);
    out.push(entry.body ?? diskLines.slice(start - 1, end).join("\n"));
    expectedNext = end + 1;
  }
  expect(expectedNext - 1, `evidence must cover the whole file: ${JSON.stringify(ordered)}`)
    .toBe(diskLines.length);
  return `${out.join("\n")}\n`;
}

// Every server is started inside one test (`startServer` self-pushes into
// `spawned`, never reused across `it`s — test "(a)" already kills its own 2
// inline); stop the rest now so this file's 6 tests never hold all their
// servers alive at once.
afterEach(() => {
  for (const s of spawned.splice(0)) s.kill();
});

afterAll(() => {
  for (const s of spawned.splice(0)) s.kill();
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

describe("B2 / V12-02 delta context — real dispatcher", () => {
  it("(a) OFF PARITY: the flag adds zero wire bytes for a read the edit's own window never touches", async () => {
    // THE CONSTRUCTION. Run the IDENTICAL three-call sequence twice against the
    // SAME workspace root — once with the flag off, once with it on — and
    // compare the serialized bytes call by call. Same root matters: handles are
    // minted from (root, path, sha), so any difference that shows up is a
    // difference in behaviour and not in addressing. The file is restored
    // between runs so both servers see the same starting bytes and the same
    // governor/budget state at every step.
    //
    // RE-PINNED 2026-09-29 (INT, eval-0929 wave, ruling dlc/2): the post-edit
    // read used to be a whole-file `mode:"full"` re-read, which the PEW
    // "edit-after" mechanism (server.ts / state/session.ts, unconditional —
    // fires with the flag OFF too) now legitimately turns into a residency
    // claim on ITS OWN, whenever the request's own coverage falls entirely
    // inside the edit's disclosed +-20/enclosing-symbol window (confirmed on
    // the wire: identical `read.receipt` with `served_by:"edit-after ..."` in
    // both OFF and ON runs for such a read — that is PEW, not this lever, and
    // is exercised on its own by the NEW "edit-after receipt" corpus case
    // below). A whole-file read on a small fixture always falls inside that
    // window, so it no longer isolates TL_DELTA_CONTEXT's OWN contribution.
    // Isolating it needs a read PEW's window cannot explain at all: a range
    // request for lines the edit never touched and never came near. The fixture
    // is enlarged (200 lines; the edit sits at line 100) so such a range
    // genuinely exists and was never previously served in full either.
    //
    // The claim this proves is the one that governs a default-OFF lever: for a
    // read outside the edit's own window, the flag changes NOTHING except
    // whether a still-valid earlier full-file read may be cited instead of
    // resent — the write seam and the edit response itself stay byte-identical
    // in both runs either way.
    const root = makeWorkspace("off", wideSource(200));
    const target = path.join(root, "src", "order.ts");
    const pristine = fs.readFileSync(target, "utf8");
    const common = { cwd: root, lane: "delta-parity" };

    const sequence = async (env: Record<string, string>): Promise<string[]> => {
      fs.writeFileSync(target, pristine, "utf8");
      const server = startServer(root, env);
      await initialize(server);
      let id = 10;
      const out: string[] = [];
      // Burn the one-shot server-build announcement on a call that is NOT part
      // of the comparison (it is claimed once per build id, so only the first
      // run of the pair would carry it). A find keeps the full-read budget —
      // which both runs must enter the sequence with identically — untouched.
      await server.rpc(id++, "tools/call", {
        name: "tl_search_files", arguments: { ...common, action: "find", query: "warmup", path: "src" },
      });
      out.push(wireText(await server.rpc(id++, "tools/call", {
        name: "tl_read_file", arguments: { ...common, mode: "full", path: "src/order.ts" },
      })));
      out.push(wireText(await server.rpc(id++, "tools/call", {
        name: "tl_edit_file",
        arguments: { ...common, path: "src/order.ts", search: WIDE_LINE_100, replace: `export const marker100 = "CHANGED";` },
      })));
      // Lines 180-190 sit far outside line 100's +-20/enclosing-symbol window —
      // PEW's edit-after mechanism has nothing to say about this range.
      out.push(wireText(await server.rpc(id++, "tools/call", {
        name: "tl_read_file", arguments: { ...common, targets: [{ path: "src/order.ts", range: "180-190" }] },
      })));
      server.kill();
      return out;
    };

    const off = await sequence({});
    const on = await sequence({ TL_DELTA_CONTEXT: "1" });

    // The read BEFORE any edit, and the edit response itself: identical bytes.
    expect(normalizeHandles(on[0]!)).toBe(normalizeHandles(off[0]!));
    expect(JSON.parse(off[1]!)["kind"]).toBe("edit.applied");
    expect(normalizeHandles(on[1]!)).toBe(normalizeHandles(off[1]!));

    // OFF's out-of-window read is the pre-B2 contract: a fresh body, no
    // residency claim of any kind — PEW cannot reach it and the base ledger
    // does not survive an edit on its own.
    const offBody = JSON.parse(off[2]!);
    expect(offBody["kind"], JSON.stringify(offBody).slice(0, 400)).toBe("read.text");
    const offEntries = evidenceOf(offBody);
    expect(offEntries).toHaveLength(1);
    expect(offEntries[0]!.prior).toBeUndefined();
    expect(typeof offEntries[0]!.body).toBe("string");

    // ON's differs — which is the whole point, and is what makes the two
    // equalities above evidence rather than a tautology. Delta-context's
    // ledger recognises the range as still covered by the earlier full read,
    // so it dedups to a zero-byte receipt naming that earlier call.
    expect(normalizeHandles(on[2]!)).not.toBe(normalizeHandles(off[2]!));
    const onBody = JSON.parse(on[2]!);
    expect(onBody["kind"], JSON.stringify(onBody).slice(0, 400)).toBe("read.receipt");
    expect(String(onBody["receipt"]?.["served_by"] ?? "")).toContain("full 1-200");
  }, 180000);

  it("(b) ON: the post-edit read serves prior + residual that reconstruct the file exactly", async () => {
    // RE-PINNED 2026-09-29 (INT, eval-0929 wave, ruling dlc/2): a `mode:"full"`
    // FIRST read makes every later full re-read 100% coverable from (that full
    // body) + (the edit's own PEW-disclosed `applied[].after` window) alone —
    // confirmed on the wire, this now dedups all the way to a zero-byte
    // `read.receipt` (cell (a)'s territory), leaving nothing for THIS lever's
    // OWN prior+residual splitting to add. Reading only PART of the file first
    // (1-45 of 60) keeps a genuine multi-piece reconstruction reachable: the
    // untouched prefix is jointly provable from that partial read plus the
    // edit's own disclosed window (delta-context's specific, still-real value —
    // OFF cannot do this join, only PEW's own narrower window), while lines
    // 46-60 were never served before and must still arrive as fresh bytes.
    const root = makeWorkspace("on", wideSource());
    const traceHome = fs.mkdtempSync(path.join(os.tmpdir(), "tl-delta-home-"));
    tmpDirs.push(traceHome);
    const target = path.join(root, "src", "order.ts");
    const common = { cwd: root, lane: "delta-on" };

    const server = startServer(root, { TL_DELTA_CONTEXT: "1", TL_TRACE: "1", HOME: traceHome });
    await initialize(server);
    let id = 10;
    const first = body(await server.rpc(id++, "tools/call", {
      name: "tl_read_file", arguments: { ...common, targets: [{ path: "src/order.ts", range: "1-45" }] },
    }));
    const firstServed = evidenceOf(first)[0]!.body!;

    const edited = body(await server.rpc(id++, "tools/call", {
      name: "tl_edit_file",
      arguments: {
        ...common, path: "src/order.ts", search: WIDE_LINE_30,
        replace: `export const marker30 = "CHANGED";\nexport const marker30b = "EXTRA";`,
      },
    }));
    // PEW's own disclosed post-edit window — the OTHER source a merged `prior`
    // citation below is allowed to draw on, alongside `firstServed`.
    const editAfter = (((edited["applied"] as unknown[])?.[0] ?? {}) as Record<string, unknown>)["after"] as
      { range: string; body: string } | undefined;
    expect(editAfter, JSON.stringify(edited).slice(0, 400)).toBeDefined();

    const reread = body(await server.rpc(id++, "tools/call", {
      name: "tl_read_file", arguments: { ...common, mode: "full", path: "src/order.ts" },
    }));
    const entries = evidenceOf(reread);
    const disk = fs.readFileSync(target, "utf8");

    // The partial read (1-45) and the edit's own window (10-51) overlap and
    // merge into ONE prior span (1-51); lines 52-61 (never read before) arrive
    // fresh. A one-line -> two-line edit at line 30 of a 60-line file shifts
    // everything after it by +1, hence 52-61 rather than 51-60.
    expect(entries.map((e) => e.range)).toEqual(["1-51", "52-61"]);
    expect(entries[0]!.body).toBeUndefined();
    expect(entries[0]!.prior).toBeTruthy();
    expect(typeof entries[1]!.body).toBe("string");

    // DELTA RECONSTRUCTION 100%.
    expect(reconstruct(entries, disk)).toBe(disk);

    // SERVE HONESTY: the merged `prior` window's bytes must be fully explained
    // by the TWO sources it names — the part before the edit's own window came
    // from the first (partial) read, and the edited window itself is exactly
    // PEW's own disclosed `after` text, never a fresh invention.
    const editAfterRange = parseRange(editAfter!.range);
    const mergedRange = parseRange(entries[0]!.range);
    const diskLines = disk.replace(/\n$/, "").split("\n");
    expect(firstServed).toContain(diskLines.slice(mergedRange.start - 1, editAfterRange.start - 1).join("\n"));
    expect(editAfter!.body).toBe(diskLines.slice(editAfterRange.start - 1, editAfterRange.end).join("\n"));

    // The response is still far smaller than resending the whole file.
    expect(wireText({ result: { content: [{ text: JSON.stringify(reread) }] } }).length)
      .toBeLessThan(Buffer.byteLength(disk, "utf8") / 2);

    // Trace engagement counter (zero wire bytes, TL_TRACE channel).
    await new Promise((resolve) => setTimeout(resolve, 250));
    const traceDir = path.join(traceHome, ".tokenlighten", "trace");
    const records: Array<Record<string, unknown>> = [];
    for (const file of fs.existsSync(traceDir) ? fs.readdirSync(traceDir) : []) {
      for (const line of fs.readFileSync(path.join(traceDir, file), "utf8").trim().split("\n")) {
        if (line.length > 0) records.push(JSON.parse(line) as Record<string, unknown>);
      }
    }
    const deltaLines = records.filter((r) => r["event"] === "delta_context");
    expect(deltaLines.map((r) => r["phase"])).toEqual(["ledger-transform", "serve"]);
    expect(deltaLines[0]!["line_delta"]).toBe(1);
    expect(deltaLines[0]!["hunk"]).toBe("30-30");
    // ONE merged prior segment now (was 2 pre-merge): the partial read and
    // PEW's edit-after window join into a single provable span.
    expect(deltaLines[1]!["prior_segments"]).toBe(1);
    expect((deltaLines[1]!["flags_active"] as string[])).toContain("TL_DELTA_CONTEXT");
  }, 120000);

  it("(b2) ON under the default ±3 after-window: prior + residual still reconstruct the file exactly", async () => {
    // Same sequence as (b) with TL_EFF_SLIM_EDIT left at its default. The
    // edit at line 30 (one line -> two) now discloses 27-34, inside what the
    // partial read already covered (1-45, shifted to 1-46 by the extra
    // line), so the prior span is 1-46 and 47-61 arrive fresh.
    const root = makeWorkspace("on-slim", wideSource());
    const target = path.join(root, "src", "order.ts");
    const common = { cwd: root, lane: "delta-on-slim" };

    const server = startServer(root, { TL_DELTA_CONTEXT: "1", TL_EFF_SLIM_EDIT: "1" });
    await initialize(server);
    let id = 10;
    await server.rpc(id++, "tools/call", {
      name: "tl_read_file", arguments: { ...common, targets: [{ path: "src/order.ts", range: "1-45" }] },
    });
    const edited = body(await server.rpc(id++, "tools/call", {
      name: "tl_edit_file",
      arguments: {
        ...common, path: "src/order.ts", search: WIDE_LINE_30,
        replace: `export const marker30 = "CHANGED";\nexport const marker30b = "EXTRA";`,
      },
    }));
    const editAfter = (((edited["applied"] as unknown[])?.[0] ?? {}) as Record<string, unknown>)["after"] as
      { range: string } | undefined;
    expect(editAfter?.range, JSON.stringify(edited).slice(0, 400)).toBe("27-34");

    const reread = body(await server.rpc(id++, "tools/call", {
      name: "tl_read_file", arguments: { ...common, mode: "full", path: "src/order.ts" },
    }));
    const entries = evidenceOf(reread);
    const disk = fs.readFileSync(target, "utf8");
    expect(entries.map((e) => e.range)).toEqual(["1-46", "47-61"]);
    expect(entries[0]!.body).toBeUndefined();
    expect(entries[0]!.prior).toBeTruthy();
    expect(typeof entries[1]!.body).toBe("string");
    expect(reconstruct(entries, disk)).toBe(disk);
  }, 120000);

  it("(c) ON: an external write between edit and read falls back to the full body", async () => {
    const root = makeWorkspace("ext", wideSource());
    const target = path.join(root, "src", "order.ts");
    const common = { cwd: root, lane: "delta-ext" };
    const server = startServer(root, { TL_DELTA_CONTEXT: "1" });
    await initialize(server);
    let id = 10;
    await server.rpc(id++, "tools/call", { name: "tl_read_file", arguments: { ...common, mode: "full", path: "src/order.ts" } });
    await server.rpc(id++, "tools/call", {
      name: "tl_edit_file",
      arguments: { ...common, path: "src/order.ts", search: WIDE_LINE_30, replace: `export const marker30 = "CHANGED";` },
    });
    // Something outside this server rewrites the file: the carried ledger's
    // base no longer matches, so nothing may be claimed as held.
    fs.writeFileSync(target, `${fs.readFileSync(target, "utf8")}export const appended = 1;\n`, "utf8");

    const reread = body(await server.rpc(id++, "tools/call", {
      name: "tl_read_file", arguments: { ...common, mode: "full", path: "src/order.ts" },
    }));
    const entries = evidenceOf(reread);
    expect(entries.every((e) => e.prior === undefined)).toBe(true);
    expect(entries).toHaveLength(1);
    expectWholeFileBody(entries[0]!, target);
  }, 120000);

  it("(d) ON: force_serve:true always returns the full body", async () => {
    const root = makeWorkspace("force", wideSource());
    const target = path.join(root, "src", "order.ts");
    const common = { cwd: root, lane: "delta-force" };
    const server = startServer(root, { TL_DELTA_CONTEXT: "1" });
    await initialize(server);
    let id = 10;
    await server.rpc(id++, "tools/call", { name: "tl_read_file", arguments: { ...common, mode: "full", path: "src/order.ts" } });
    await server.rpc(id++, "tools/call", {
      name: "tl_edit_file",
      arguments: { ...common, path: "src/order.ts", search: WIDE_LINE_30, replace: `export const marker30 = "CHANGED";` },
    });
    const forced = body(await server.rpc(id++, "tools/call", {
      name: "tl_read_file", arguments: { ...common, mode: "full", path: "src/order.ts", force_serve: true },
    }));
    const entries = evidenceOf(forced);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.prior).toBeUndefined();
    expectWholeFileBody(entries[0]!, target);
  }, 120000);

  it("(e) ON: the size guard's tiny fixture now reaches an even cheaper zero-byte receipt, matching OFF", async () => {
    // RE-PINNED 2026-09-29 (INT, eval-0929 wave, ruling dlc/2): the guard's own
    // point — a tiny held window is not worth citing — is now made moot by PEW,
    // which is unconditional (server.ts / state/session.ts): on THIS 24-line
    // fixture, editing line 12 discloses an `applied[].after` window ("1-25")
    // that alone already covers the WHOLE file, so a full re-read dedups to a
    // zero-byte `read.receipt` before delta-context's own citation-cost
    // comparison ever gets a chance to run — confirmed on the wire, byte-
    // identical in OFF and ON (PEW does not consult the flag). A receipt costs
    // strictly less than either a citation or a plain body, so this is a
    // strictly CHEAPER outcome than the "plain body wins" the guard used to
    // demonstrate, on the exact same fixture and edit. Cell (b) above still
    // exercises delta-context's own citation-vs-body accounting on a fixture
    // PEW's window does not fully swallow.
    const root = makeWorkspace("guard", narrowSource());
    const common = { cwd: root, lane: "delta-guard" };

    const sequence = async (env: Record<string, string>): Promise<Record<string, unknown>> => {
      const server = startServer(root, env);
      await initialize(server);
      let id = 10;
      await server.rpc(id++, "tools/call", { name: "tl_read_file", arguments: { ...common, mode: "full", path: "src/order.ts" } });
      await server.rpc(id++, "tools/call", {
        name: "tl_edit_file",
        arguments: { ...common, path: "src/order.ts", search: "const s12=12;", replace: "const s12=1200;" },
      });
      const reread = body(await server.rpc(id++, "tools/call", {
        name: "tl_read_file", arguments: { ...common, mode: "full", path: "src/order.ts" },
      }));
      server.kill();
      return reread;
    };

    const off = await sequence({});
    expect(off["kind"], JSON.stringify(off).slice(0, 400)).toBe("read.receipt");
    expect(String((off["receipt"] as Record<string, unknown>)?.["served_by"] ?? "")).toContain("edit-after");

    fs.writeFileSync(path.join(root, "src", "order.ts"), narrowSource(), "utf8");
    const on = await sequence({ TL_DELTA_CONTEXT: "1" });
    expect(on["kind"], JSON.stringify(on).slice(0, 400)).toBe("read.receipt");
    // Compare everything except `handle`, which is minted per SERVER PROCESS
    // (see `normalizeHandles`'s own doc comment) — the receipt's own claim
    // (type, cited provenance, content hash) must still match exactly.
    const offReceipt = { ...(off["receipt"] as Record<string, unknown>) };
    const onReceipt = { ...(on["receipt"] as Record<string, unknown>) };
    delete offReceipt["handle"];
    delete onReceipt["handle"];
    expect(onReceipt).toEqual(offReceipt);
  }, 120000);

  it("(f) ON: a multi-hunk edits[] batch composes into one enclosing region and still reconstructs", async () => {
    // RE-PINNED 2026-09-29 (INT, eval-0929 wave, ruling dlc/2): same root cause
    // as cell (b) — a `mode:"full"` first read makes the whole file trivially
    // 100%-coverable from (that full body) + (the batch's own PEW-disclosed
    // `applied[0].after` enclosing window) alone, collapsing to a zero-byte
    // receipt (confirmed on the wire) before this lever's own merge logic gets
    // to add anything. The fixture is enlarged (120 lines; the two hunks sit at
    // lines 10 and 50) so PEW's own enclosing window — generous, but still
    // bounded — covers only its own neighbourhood, and the first read is
    // partial (1-90) so real "never read before" territory (past line 90)
    // survives for the lever to genuinely need fresh bytes for.
    const root = makeWorkspace("batch", wideSource(120));
    const target = path.join(root, "src", "order.ts");
    const common = { cwd: root, lane: "delta-batch" };
    const server = startServer(root, { TL_DELTA_CONTEXT: "1" });
    await initialize(server);
    let id = 10;
    const first = body(await server.rpc(id++, "tools/call", {
      name: "tl_read_file", arguments: { ...common, targets: [{ path: "src/order.ts", range: "1-90" }] },
    }));
    const firstServed = evidenceOf(first)[0]!.body!;

    const applied = body(await server.rpc(id++, "tools/call", {
      name: "tl_edit_file",
      arguments: {
        ...common,
        edits: [
          { path: "src/order.ts", search: WIDE_LINE_10, replace: `export const marker10 = "TEN";` },
          { path: "src/order.ts", search: WIDE_LINE_50, replace: `export const marker50 = "FIFTY";\nexport const marker50b = "FIFTY-B";` },
        ],
      },
    }));
    expect(applied["kind"], JSON.stringify(applied).slice(0, 300)).toBe("edit.applied");
    const editAfter = (((applied["applied"] as unknown[])?.[0] ?? {}) as Record<string, unknown>)["after"] as
      { range: string; body: string } | undefined;
    expect(editAfter, JSON.stringify(applied).slice(0, 400)).toBeDefined();

    const reread = body(await server.rpc(id++, "tools/call", {
      name: "tl_read_file", arguments: { ...common, mode: "full", path: "src/order.ts" },
    }));
    const entries = evidenceOf(reread);
    const disk = fs.readFileSync(target, "utf8");

    // The partial read (1-90) and the batch's own enclosing window (here 1-64)
    // merge into ONE prior span; lines past it (never read before) arrive
    // fresh. Conservative by design: never a guessed interior alignment.
    expect(entries).toHaveLength(2);
    expect(entries[0]!.prior).toBeTruthy();
    expect(entries[0]!.body).toBeUndefined();
    expect(typeof entries[1]!.body).toBe("string");
    expect(reconstruct(entries, disk)).toBe(disk);

    // SERVE HONESTY, as in cell (b): the merged `prior` window is fully
    // explained by the partial first read PLUS PEW's own disclosed `after`
    // text — never a fresh invention.
    const editAfterRange = parseRange(editAfter!.range);
    const mergedRange = parseRange(entries[0]!.range);
    const diskLines = disk.replace(/\n$/, "").split("\n");
    expect(firstServed).toContain(diskLines.slice(mergedRange.start - 1, editAfterRange.start - 1).join("\n"));
    expect(editAfter!.body).toBe(diskLines.slice(editAfterRange.start - 1, editAfterRange.end).join("\n"));
  }, 120000);
});
