/**
 * deltaContextDispatch.spec.ts — B2 / V12-02 delta context, through the REAL
 * dispatcher (spawned server + JSON-RPC), the same way
 * `postReadyTrimDispatch.spec.ts` exercises W5/W7.
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
import { afterAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const require = createRequire(import.meta.url);
const tsx = require.resolve("tsx/cli");
const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.resolve(here, "..", "bin.ts");

type RpcServer = {
  rpc(id: number, method: string, params?: unknown): Promise<any>;
  kill(): void;
};

const spawned: RpcServer[] = [];
const tmpDirs: string[] = [];

function startServer(root: string, env: Record<string, string>): RpcServer {
  const child: ChildProcess = spawn(process.execPath, [tsx, bin, "--workspace", root, "--allow-write"], {
    cwd: root,
    env: { ...process.env, TOKENLIGHTEN_ALLOWED_PARENTS: os.homedir(), ...env },
    stdio: ["pipe", "pipe", "pipe"],
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
    kill: () => { try { child.kill("SIGKILL"); } catch { /* already stopped */ } },
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

/** 60 comment-free lines: no doc elision, so a served body IS the file text. */
function wideSource(): string {
  const lines: string[] = [];
  for (let i = 1; i <= 60; i += 1) {
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

afterAll(() => {
  for (const s of spawned.splice(0)) s.kill();
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

describe("B2 / V12-02 delta context — real dispatcher", () => {
  it("(a) OFF PARITY: the flag adds zero wire bytes anywhere in an edit-then-read sequence", async () => {
    // THE CONSTRUCTION. Run the IDENTICAL three-call sequence twice against the
    // SAME workspace root — once with the flag off, once with it on — and
    // compare the serialized bytes call by call. Same root matters: handles are
    // minted from (root, path, sha), so any difference that shows up is a
    // difference in behaviour and not in addressing. The file is restored
    // between runs so both servers see the same starting bytes and the same
    // governor/budget state at every step.
    //
    // The claim this proves is the one that governs a default-OFF lever: the
    // ONLY response the feature can change is the post-edit read, and only when
    // the flag is on. A pre-edit read and the edit response itself must be
    // byte-identical in both runs — the write seam, the ledger transformation
    // and the read-side decision are all invisible on the wire.
    const root = makeWorkspace("off", wideSource());
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
        name: "search_files", arguments: { ...common, action: "find", query: "warmup", path: "src" },
      });
      out.push(wireText(await server.rpc(id++, "tools/call", {
        name: "read_file", arguments: { ...common, mode: "full", path: "src/order.ts" },
      })));
      out.push(wireText(await server.rpc(id++, "tools/call", {
        name: "edit_file",
        arguments: { ...common, path: "src/order.ts", search: WIDE_LINE_30, replace: `export const marker30 = "CHANGED";` },
      })));
      out.push(wireText(await server.rpc(id++, "tools/call", {
        name: "read_file", arguments: { ...common, mode: "full", path: "src/order.ts" },
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

    // OFF's post-edit read is the pre-B2 contract: one whole-file body, no
    // residency claim of any kind.
    const offEntries = evidenceOf(JSON.parse(off[2]!));
    expect(offEntries).toHaveLength(1);
    expect(offEntries[0]!.prior).toBeUndefined();
    expectWholeFileBody(offEntries[0]!, target);

    // ON's differs — which is the whole point, and is what makes the two
    // equalities above evidence rather than a tautology.
    expect(normalizeHandles(on[2]!)).not.toBe(normalizeHandles(off[2]!));
    expect(evidenceOf(JSON.parse(on[2]!)).some((e) => e.prior !== undefined)).toBe(true);
  }, 180000);

  it("(b) ON: the post-edit read serves prior + residual that reconstruct the file exactly", async () => {
    const root = makeWorkspace("on", wideSource());
    const traceHome = fs.mkdtempSync(path.join(os.tmpdir(), "tl-delta-home-"));
    tmpDirs.push(traceHome);
    const target = path.join(root, "src", "order.ts");
    const common = { cwd: root, lane: "delta-on" };

    const server = startServer(root, { TL_DELTA_CONTEXT: "1", TL_TRACE: "1", HOME: traceHome });
    await initialize(server);
    let id = 10;
    const first = body(await server.rpc(id++, "tools/call", {
      name: "read_file", arguments: { ...common, mode: "full", path: "src/order.ts" },
    }));
    const firstServed = evidenceOf(first)[0]!.body!;

    await server.rpc(id++, "tools/call", {
      name: "edit_file",
      arguments: {
        ...common, path: "src/order.ts", search: WIDE_LINE_30,
        replace: `export const marker30 = "CHANGED";\nexport const marker30b = "EXTRA";`,
      },
    });

    const reread = body(await server.rpc(id++, "tools/call", {
      name: "read_file", arguments: { ...common, mode: "full", path: "src/order.ts" },
    }));
    const entries = evidenceOf(reread);
    const disk = fs.readFileSync(target, "utf8");

    // A one-line -> two-line edit at line 30 of a 60-line file: lines 1-29 keep
    // their numbers, the change occupies 30-31, and 31-60 shift to 32-61.
    expect(entries.map((e) => e.range)).toEqual(["1-29", "30-31", "32-61"]);
    expect(entries[0]!.body).toBeUndefined();
    expect(entries[0]!.prior).toBeTruthy();
    expect(typeof entries[1]!.body).toBe("string");
    expect(entries[2]!.body).toBeUndefined();
    expect(entries[2]!.prior).toBeTruthy();

    // DELTA RECONSTRUCTION 100%.
    expect(reconstruct(entries, disk)).toBe(disk);

    // SERVE HONESTY: every `prior` window names bytes the caller demonstrably
    // received earlier — the transformed windows must appear verbatim in the
    // FIRST response's body, which is the only thing that was ever served.
    const diskLines = disk.replace(/\n$/, "").split("\n");
    for (const entry of entries.filter((e) => e.prior !== undefined)) {
      const { start, end } = parseRange(entry.range);
      expect(firstServed).toContain(diskLines.slice(start - 1, end).join("\n"));
    }

    // The residual body is only the changed lines — the point of the lever.
    expect(entries[1]!.body).toBe(`export const marker30 = "CHANGED";\nexport const marker30b = "EXTRA";`);
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
    expect(deltaLines[1]!["prior_segments"]).toBe(2);
    expect((deltaLines[1]!["flags_active"] as string[])).toContain("TL_DELTA_CONTEXT");
  }, 120000);

  it("(c) ON: an external write between edit and read falls back to the full body", async () => {
    const root = makeWorkspace("ext", wideSource());
    const target = path.join(root, "src", "order.ts");
    const common = { cwd: root, lane: "delta-ext" };
    const server = startServer(root, { TL_DELTA_CONTEXT: "1" });
    await initialize(server);
    let id = 10;
    await server.rpc(id++, "tools/call", { name: "read_file", arguments: { ...common, mode: "full", path: "src/order.ts" } });
    await server.rpc(id++, "tools/call", {
      name: "edit_file",
      arguments: { ...common, path: "src/order.ts", search: WIDE_LINE_30, replace: `export const marker30 = "CHANGED";` },
    });
    // Something outside this server rewrites the file: the carried ledger's
    // base no longer matches, so nothing may be claimed as held.
    fs.writeFileSync(target, `${fs.readFileSync(target, "utf8")}export const appended = 1;\n`, "utf8");

    const reread = body(await server.rpc(id++, "tools/call", {
      name: "read_file", arguments: { ...common, mode: "full", path: "src/order.ts" },
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
    await server.rpc(id++, "tools/call", { name: "read_file", arguments: { ...common, mode: "full", path: "src/order.ts" } });
    await server.rpc(id++, "tools/call", {
      name: "edit_file",
      arguments: { ...common, path: "src/order.ts", search: WIDE_LINE_30, replace: `export const marker30 = "CHANGED";` },
    });
    const forced = body(await server.rpc(id++, "tools/call", {
      name: "read_file", arguments: { ...common, mode: "full", path: "src/order.ts", force_serve: true },
    }));
    const entries = evidenceOf(forced);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.prior).toBeUndefined();
    expectWholeFileBody(entries[0]!, target);
  }, 120000);

  it("(e) ON: the size guard serves the plain body when the projection would cost more", async () => {
    const root = makeWorkspace("guard", narrowSource());
    const target = path.join(root, "src", "order.ts");
    const common = { cwd: root, lane: "delta-guard" };
    const server = startServer(root, { TL_DELTA_CONTEXT: "1" });
    await initialize(server);
    let id = 10;
    await server.rpc(id++, "tools/call", { name: "read_file", arguments: { ...common, mode: "full", path: "src/order.ts" } });
    await server.rpc(id++, "tools/call", {
      name: "edit_file",
      arguments: { ...common, path: "src/order.ts", search: "const s12=12;", replace: "const s12=1200;" },
    });
    const reread = body(await server.rpc(id++, "tools/call", {
      name: "read_file", arguments: { ...common, mode: "full", path: "src/order.ts" },
    }));
    const entries = evidenceOf(reread);
    // 23 held lines of ~13 bytes are worth less than the two prior markers plus
    // the fresh-segment overhead they would cost, so the body wins.
    expect(entries).toHaveLength(1);
    expect(entries[0]!.prior).toBeUndefined();
    expectWholeFileBody(entries[0]!, target);
  }, 120000);

  it("(f) ON: a multi-hunk edits[] batch composes into one enclosing region and still reconstructs", async () => {
    const root = makeWorkspace("batch", wideSource());
    const target = path.join(root, "src", "order.ts");
    const common = { cwd: root, lane: "delta-batch" };
    const server = startServer(root, { TL_DELTA_CONTEXT: "1" });
    await initialize(server);
    let id = 10;
    const first = body(await server.rpc(id++, "tools/call", {
      name: "read_file", arguments: { ...common, mode: "full", path: "src/order.ts" },
    }));
    const firstServed = evidenceOf(first)[0]!.body!;

    const applied = body(await server.rpc(id++, "tools/call", {
      name: "edit_file",
      arguments: {
        ...common,
        edits: [
          { path: "src/order.ts", search: WIDE_LINE_10, replace: `export const marker10 = "TEN";` },
          { path: "src/order.ts", search: WIDE_LINE_50, replace: `export const marker50 = "FIFTY";\nexport const marker50b = "FIFTY-B";` },
        ],
      },
    }));
    expect(applied["kind"], JSON.stringify(applied).slice(0, 300)).toBe("edit.applied");

    const reread = body(await server.rpc(id++, "tools/call", {
      name: "read_file", arguments: { ...common, mode: "full", path: "src/order.ts" },
    }));
    const entries = evidenceOf(reread);
    const disk = fs.readFileSync(target, "utf8");

    // Two distant hunks collapse into the ONE region the prefix/suffix pair can
    // prove — 10..50 pre-edit — so 1-9 keeps its lines and 51-60 shifts to
    // 52-61. Conservative by design: never a guessed interior alignment.
    expect(entries.map((e) => e.range)).toEqual(["1-9", "10-51", "52-61"]);
    expect(entries[0]!.prior).toBeTruthy();
    expect(entries[2]!.prior).toBeTruthy();
    expect(reconstruct(entries, disk)).toBe(disk);

    const diskLines = disk.replace(/\n$/, "").split("\n");
    for (const entry of entries.filter((e) => e.prior !== undefined)) {
      const { start, end } = parseRange(entry.range);
      expect(firstServed).toContain(diskLines.slice(start - 1, end).join("\n"));
    }
  }, 120000);
});
