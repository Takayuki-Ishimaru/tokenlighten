/**
 * sfPriorLedgerHonesty.spec.ts — FX-M4 (P1, round-16 forensics).
 *
 * THE DEFECT, in the PRODUCTION call shape. A `pack-unchanged` compact
 * receipt (`readCodeTaskPack.ts`'s `compactReceiptFromRecord`, reached via
 * `tryServeCachedPack` -> `revalidateRecordToReceipt` on a plain, non-qref-
 * replay re-ask) used to stamp `prior` — "the caller already holds these
 * bytes" — on EVERY bodyless surface in the cached record, including a row
 * `trimToCap` Phase E stripped under ordinary `budget.bytes` pressure and
 * therefore NEVER shipped a body for, on the FIRST call or any other. The
 * only guard against this (`revalidateRecordToReceipt`'s
 * `isQueryRefReplay`-scoped decline) does not fire for the common case: an
 * agent re-issuing an identical `task_pack` query one turn later, with no
 * `qref`.
 *
 *   read_file { query: <generic pricing change>, budget: { bytes: 9000 } }
 *     → read.task_pack, limit.cause:"capped"; one row ships its body in
 *       full (small enough to survive Phase E), two others ship none
 *   read_file { query: <same>, task: { profile: "generic" } }   ← plain re-ask
 *     → BEFORE THE FIX: every bodyless row — including the two that never
 *       shipped a body on the FIRST call either — carries `prior`, falsely
 *       asserting the caller holds bytes it was never sent.
 *
 * THE FIX (readCodeTaskPack.ts's `surfaceRangeShipped`, `protocol/
 * decisionWire.ts`'s `remaining.length === 0` guard on the `prior` fallback):
 * a compact receipt's `prior` eligibility is decided per row, against the
 * session's OWN served-range ledger (`servedClusterRanges`, the same
 * `recordServedRange`-written structure FX-K/FX-L's `addressShipped` reads
 * via `editPathResidency`) — never against the pack record's own
 * `content_completeness` self-report. A row the ledger cannot prove shipped
 * carries `content_completeness:"partial"` + `remaining_ranges` instead, so
 * `projectEvidence` emits `remaining` and withholds `prior`. Both
 * `revalidateRecordToReceipt` call sites (plain re-ask and qref replay) route
 * through the same `compactReceiptFromRecord`, so the predicate is shared.
 *
 * VERIFIED TO FAIL WITHOUT THE FIX: temporarily reverting the
 * `surfaceRangeShipped` helper/call site in `readCodeTaskPack.ts` and the
 * `remaining.length === 0` guard in `protocol/decisionWire.ts` (restoring the
 * unconditional `priorForBodyless` fallback) reproduces the false `prior` on
 * both `src/pricing_1.ts` and `src/pricing_2.ts` below — confirmed live
 * against a spawned server before this file was written, then restored.
 *
 * WHY SPAWNED STDIO. The bug is specifically about the WIRE shape a real
 * `bin.ts` JSON-RPC round trip produces — `readFamily.ts`'s projector is what
 * deletes `receipt`/`pack_unchanged` from the wire and `decisionWire.ts`'s
 * `projectEvidence` is what stamps `prior`/`remaining` — so an in-process
 * `callTool` shortcut would not exercise the same projection path a real
 * client sees.
 *
 * BUDGET CHOICE. 6144 (INV-D's own repro value) strips every row's body in
 * this fixture, leaving no "body shipped" control row in the SAME response.
 * 9000 was found empirically to split the fixture: `src/pricing_0.ts` (the
 * first-discovered, smallest-range surface) survives Phase E in full, while
 * `src/pricing_1.ts`/`src/pricing_2.ts` are stripped — one call, one budget,
 * both the defect case and its control.
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const QUERY =
  "Update orderTotal pricing rules across the pricing modules so quantity discounts apply.";
const BUDGET_BYTES = 9000;

const SF_FLAG_KEYS = [
  "TL_SEMANTIC_FRONTIER_GUARD", "TL_SF_STATEFUL", "TL_SF_DEMOTE",
  "TL_SF_STRUCTURAL_CONCERNS", "TL_SF_RELATION_PACKETS", "TL_SF_VERIFY_FIRST",
  "TL_SF_CONTINUATION_BUNDLE", "TL_CWD_NEAR_MISS", "TL_RECEIPT_COVERAGE",
  "TL_BATCH_HINTS", "TL_SEARCH_DEDUP", "TL_GRAPH_EVIDENCE",
] as const;

const tmpDirs: string[] = [];

afterEach(() => {
  for (const key of SF_FLAG_KEYS) delete process.env[key];
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

function mkWorkspace(tag: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), `.tl-sf-prior-${tag}-`)));
  tmpDirs.push(dir);
  const write = (rel: string, content: string): void => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  };
  // The exact r15_k corpus shape (sfCapOverflowBookings.spec.ts): eight
  // 40-function pricing modules, so any small `budget.bytes` overflows the
  // cap and `trimToCap` Phase E strips bodies.
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
  return dir;
}

// ---------------------------------------------------------------------------
// Spawned stdio server — production shape (matches sfCapOverflowBookings.spec.ts).
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
        clientInfo: { name: "sf-prior-ledger-honesty", version: "0" },
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

/** Every SF flag OFF — the shipped default this defect lives on. */
function spawnEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TOKENLIGHTEN_ALLOWED_PARENTS: os.homedir(),
    TL_LEGACY_INPUT: "accept",
  };
  for (const key of SF_FLAG_KEYS) delete env[key];
  return env;
}

interface WireRow {
  handle?: string;
  path?: string;
  body?: string;
  prior?: string;
  remaining?: string[];
}

describe("FX-M4 P1: a plain pack-unchanged re-serve never claims `prior` for a never-shipped row", () => {
  it("stamps `prior` only on the row the ledger proves shipped; withholds it (with `remaining`) on the rows it did not", async () => {
    const ws = mkWorkspace("plain");
    const srv = startServer(ws, spawnEnv());
    try {
      await srv.initialize();

      const first = await srv.call("read_file", {
        query: QUERY,
        task: { profile: "generic", epoch: "new" },
        budget: { bytes: BUDGET_BYTES },
        cwd: ws,
      });
      expect(first.body.kind, "first call must be a task pack").toBe("read.task_pack");
      expect(
        (first.body.limit as { cause?: string } | undefined)?.cause,
        "precondition: the fixture/budget must actually trigger trimToCap capping",
      ).toBe("capped");
      const firstRows = (first.body.evidence ?? []) as WireRow[];
      const shippedPaths = new Set(
        firstRows.filter((r) => typeof r.body === "string").map((r) => r.path),
      );
      const bodylessPaths = new Set(
        firstRows.filter((r) => r.body === undefined).map((r) => r.path),
      );
      expect(
        shippedPaths.size,
        "precondition: at least one row must ship a full body (the `prior`-eligible control)",
      ).toBeGreaterThanOrEqual(1);
      expect(
        bodylessPaths.size,
        "precondition: at least one row must ship no body (the P1 defect target)",
      ).toBeGreaterThanOrEqual(1);

      // Plain re-ask: byte-identical request minus `task.epoch:"new"` — NOT a
      // qref replay. This is `tryServeCachedPack`'s exact-fingerprint path,
      // the one revalidateRecordToReceipt call site the historical
      // isQueryRefReplay guard never covered.
      const second = await srv.call("read_file", {
        query: QUERY,
        task: { profile: "generic" },
        budget: { bytes: BUDGET_BYTES },
        cwd: ws,
      });
      expect(second.body.kind, "the re-ask must still read as a task pack on the wire").toBe(
        "read.task_pack",
      );
      const secondRows = (second.body.evidence ?? []) as WireRow[];
      expect(secondRows.length, "the compact re-serve must restate every original row").toBe(
        firstRows.length,
      );

      for (const row of secondRows) {
        expect(row.body, `${row.path}: a compact receipt row never re-embeds a body`).toBeUndefined();
        if (shippedPaths.has(row.path)) {
          expect(
            typeof row.prior,
            `${row.path}: the caller DOES hold this row's bytes from the first call — `
            + `prior must be stamped`,
          ).toBe("string");
          expect(row.remaining, `${row.path}: a shipped row has no unserved window`).toBeUndefined();
        } else {
          expect(
            bodylessPaths.has(row.path),
            `${row.path}: every row must be classified as either shipped or bodyless`,
          ).toBe(true);
          // THE FIX: no prior for a row the ledger never proved shipped.
          expect(
            row.prior,
            `${row.path}: THE BUG — this row never shipped a body on the first call either; `
            + `\`prior\` falsely claims the caller already holds it`,
          ).toBeUndefined();
          expect(
            Array.isArray(row.remaining) && row.remaining.length > 0,
            `${row.path}: an unproven row must disclose its unserved window instead of `
            + `silently claiming completeness`,
          ).toBe(true);
        }
      }
    } finally {
      srv.kill();
    }
  }, 90000);
});
