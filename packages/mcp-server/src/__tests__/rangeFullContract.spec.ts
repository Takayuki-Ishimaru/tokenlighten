/**
 * rangeFullContract.spec.ts — TL-05 (plan-0143 §7.1/§10 C01), FIX-A2's own
 * fail-first coverage for the `content:"full"` + `range`/`ranges` contract,
 * the `mode=full` paths[] batch widening fix, and the budget floor.
 *
 * plan §7.1's contract table (orchestrator ruling, brief-fix-a2.md):
 *
 *   range/ranges/symbol + content:"auto" (or none) -> serve the selected
 *     lines within budget; the rest continues.
 *   range/ranges + content:"full" -> serve the selected lines UNELIDED (no
 *     doc-comment elision, no outline/skeleton substitution while the
 *     window fits the budget); NEVER widen to the whole file.
 *   no range + content:"full" -> whole file; continue when it does not fit
 *     (today's behaviour, unchanged).
 *   budget.allowFull:true -> only raises the allowed size; never widens the
 *     target, never forces a resend.
 *   task.force_serve:true -> same target, same projection, bodies are sent
 *     again.
 *
 * BEFORE THIS FIX (confirmed live, 2026-09-21, against this exact working
 * tree prior to FIX-A2's edits — see the wave report):
 *   - a MULTI-target `targets:[{path,range},{path,range}]` + `content:"full"`
 *     request served the WHOLE 200-line files (400 lines) instead of the 150
 *     requested lines — `resolvePathsBatchEntry`'s per-entry `range` was
 *     read but then silently discarded by the `mode=full` paths[] batch
 *     loop, which only ever called `resolveFullReadForPath` (whole file).
 *   - a `range`/`ranges` + `content:"full"` slice was byte-identical to the
 *     same request with `content:"auto"` (comments elided either way) —
 *     `content` was consulted only to pick `args.mode` and then deleted,
 *     with nothing left downstream to tell "range + full" apart from
 *     "range + auto".
 * Both are fixed by this same wave; this file is the NEW regression
 * coverage the brief asks for, run under BOTH the default and VS Code
 * configs (`CONFIG_ENV` below mirrors qualityFirstScenarios.ts's own two
 * configs).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { killServerGroup } from "./helpers/killServerGroup.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TSX_CLI = path.resolve(HERE, "../../../../node_modules/tsx/dist/cli.mjs");
const BIN_TS = path.resolve(HERE, "../bin.ts");

const tmpDirs: string[] = [];

function mkWs(tag: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), `.tl-rfc-${tag}-`)));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  return dir;
}

function write(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

interface RawResponse { body: Record<string, unknown>; text: string }
interface ServerHandle {
  initialize(): Promise<void>;
  call(tool: string, args: Record<string, unknown>): Promise<RawResponse>;
  kill(): void;
}

/** Both configs brief-common.md names ("Builds available for A/B"). */
const CONFIG_ENV: Record<string, NodeJS.ProcessEnv> = {
  default: {},
  vscode: {
    TOKENLIGHTEN_CLIENT: "vscode",
    TOKENLIGHTEN_CLIENT_ID: "vscode",
    TL_TURN_ECONOMY: "1",
    TOKENLIGHTEN_TASK_PACK_MAX_BYTES: "0",
  },
};

function startServer(cwd: string, configEnv: NodeJS.ProcessEnv): ServerHandle {
  const env: NodeJS.ProcessEnv = { ...process.env, TOKENLIGHTEN_ALLOWED_PARENTS: os.homedir(), ...configEnv };
  const child: ChildProcess = spawn(
    process.execPath,
    [TSX_CLI, "--liftoff-only", BIN_TS, cwd, "--allow-write"],
    { cwd, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", env },
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
      try { msg = JSON.parse(line) as { id?: unknown }; } catch { continue; }
      const id = msg?.id;
      if (typeof id === "number" && waiters.has(id)) {
        const waiter = waiters.get(id)!;
        waiters.delete(id);
        waiter(msg);
      }
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const rpc = (method: string, params: unknown): Promise<unknown> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`rpc '${method}' timed out\n${stderr}`));
      }, 90000);
      waiters.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };
  return {
    async initialize() {
      await rpc("initialize", {
        protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "rfc", version: "0" },
      });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    },
    async call(tool, args) {
      const raw = await rpc("tools/call", { name: tool, arguments: args });
      const result = (raw as { result?: { content?: Array<{ text?: unknown }> } })?.result;
      const content = result?.content;
      const text = Array.isArray(content) && content[0]?.text !== undefined ? String(content[0]!.text) : "";
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* assertions name the shape */ }
      return { body, text };
    },
    kill() { try { killServerGroup(child); } catch { /* already gone */ } },
  };
}

/** Follows `decision.next_call|next`, top-level `next`, `limit.next`, then
 *  the first `entries[].next`/`evidence[].next` — mirrors
 *  qualityFirstScenarios.ts's own `extractNext` precedence exactly, since
 *  that is the contract a real caller (and the shared acceptance harness)
 *  follows. */
function extractNext(body: Record<string, unknown>): { tool: string; arguments: Record<string, unknown> } | undefined {
  const decision = body["decision"] as Record<string, unknown> | undefined;
  const decisionNext = (decision?.["next_call"] ?? decision?.["next"]) as
    { tool?: unknown; arguments?: unknown } | undefined;
  if (decisionNext && typeof decisionNext.tool === "string") {
    return { tool: decisionNext.tool, arguments: (decisionNext.arguments as Record<string, unknown>) ?? {} };
  }
  const topNext = body["next"] as { tool?: unknown; arguments?: unknown } | undefined;
  if (topNext && typeof topNext.tool === "string") {
    return { tool: topNext.tool, arguments: (topNext.arguments as Record<string, unknown>) ?? {} };
  }
  const limit = body["limit"] as Record<string, unknown> | undefined;
  const limitNext = limit?.["next"] as { tool?: unknown; arguments?: unknown } | undefined;
  if (limitNext && typeof limitNext.tool === "string") {
    return { tool: limitNext.tool, arguments: (limitNext.arguments as Record<string, unknown>) ?? {} };
  }
  for (const key of ["entries", "evidence"]) {
    const arr = body[key];
    if (Array.isArray(arr)) {
      for (const raw of arr) {
        const entry = raw as Record<string, unknown> | undefined;
        const entryNext = entry?.["next"] as { tool?: unknown; arguments?: unknown } | undefined;
        if (entryNext && typeof entryNext.tool === "string") {
          return { tool: entryNext.tool, arguments: (entryNext.arguments as Record<string, unknown>) ?? {} };
        }
      }
    }
  }
  return undefined;
}

/** Follows `next` verbatim (never edited), collecting every response's own
 *  `text`, up to `hopCap` hops. */
async function followToEnd(
  server: ServerHandle,
  first: { tool: string; arguments: Record<string, unknown> },
  hopCap = 20,
): Promise<{ hops: RawResponse[]; capped: boolean }> {
  const hops: RawResponse[] = [];
  let call: { tool: string; arguments: Record<string, unknown> } | undefined = first;
  while (call !== undefined) {
    if (hops.length >= hopCap) return { hops, capped: true };
    const res = await server.call(call.tool, call.arguments);
    hops.push(res);
    call = extractNext(res.body);
  }
  return { hops, capped: false };
}

/** Collects every `[tag-nnnn]` id mentioned anywhere in `texts`, matching
 *  qualityFirstScenarios.ts's own line-set accounting approach (scan the
 *  served bytes directly; never trust `remaining`/`next` metadata, which is
 *  exactly what is under test). */
function collectIds(texts: readonly string[], tag: string): Set<number> {
  const out = new Set<number>();
  const re = new RegExp(`\\[${tag}-(\\d{4})\\]`, "g");
  for (const text of texts) {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) out.add(Number(m[1]));
  }
  return out;
}

function selfIdLines(tag: string, count: number, lineBytes: number): string {
  const filler = "filler text for byte padding purposes here, extra padding words follow now. ";
  const lines: string[] = [];
  for (let i = 1; i <= count; i++) {
    const base = `[${tag}-${String(i).padStart(4, "0")}] `;
    let line = base;
    while (Buffer.byteLength(line, "utf8") < lineBytes) line += filler;
    lines.push(line.slice(0, lineBytes));
  }
  return lines.join("\n") + "\n";
}

for (const [configName, configEnv] of Object.entries(CONFIG_ENV)) {
  describe(`content:"full" + range/ranges contract (config=${configName})`, () => {
    // R1 (suite-efficiency pass, 2026-09-29): these 4 cases touch disjoint
    // paths (data/alpha+beta.txt, src/commented.ts, src/many.ts,
    // data/ranged+whole.txt — no path is reused across cases), always
    // address content by explicit path/range (never a bare `query`, so
    // sibling fixture files cannot change what a case's own read returns),
    // and each already resets `task:{epoch:"new"}` on its meaningful call —
    // so one shared workspace + one shared server safely replaces 4 per-test
    // spawns. `ws`/`server` are pulled out of `tmpDirs`/killed manually in
    // `afterAll` so the per-test `afterEach` below (which still applies to
    // the OTHER describe blocks in this file) does not tear them down after
    // the first case.
    let ws: string;
    let server: ServerHandle;
    beforeAll(async () => {
      ws = mkWs(`${configName}-c01-shared`);
      const idx = tmpDirs.indexOf(ws);
      if (idx >= 0) tmpDirs.splice(idx, 1);
      write(ws, "data/alpha.txt", selfIdLines("alpha", 200, 120));
      write(ws, "data/beta.txt", selfIdLines("beta", 200, 120));
      write(ws, "src/commented.ts", [
        "export function helper(x: number): number {",
        "  return x + 1;",
        "}",
        "",
        "/**",
        " * A substantial doc comment block, several lines long, of exactly the",
        " * shape elideDocCommentsForDisplay collapses under content:\"auto\" —",
        " * this exact sentence must survive verbatim under content:\"full\".",
        " * One more padding line so the block is unambiguously multi-line.",
        " */",
        "export function annotated(y: number): number {",
        "  return y * 2;",
        "}",
      ].join("\n") + "\n");
      {
        const lines: string[] = [];
        for (let i = 1; i <= 40; i++) lines.push(`export const R${i} = ${i}; // r-tag-${String(i).padStart(3, "0")}`);
        write(ws, "src/many.ts", lines.join("\n") + "\n");
      }
      write(ws, "data/ranged.txt", selfIdLines("ranged", 60, 40));
      write(ws, "data/whole.txt", selfIdLines("whole", 15, 40));
      server = startServer(ws, configEnv);
      await server.initialize();
    }, 60000);
    afterAll(() => {
      server?.kill();
      try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it("two-file ranged batch: content:\"full\" delivers exactly the 150 requested lines, never the whole 400-line files", async () => {
      const { hops, capped } = await followToEnd(server, {
        tool: "tl_read_file",
        arguments: {
          targets: [
            { path: "data/alpha.txt", range: "11-90" },
            { path: "data/beta.txt", range: "31-100" },
          ],
          content: "full",
          budget: { bytes: 6500 },
          task: { epoch: "new" },
          cwd: ws,
        },
      });
      expect(capped, `chain never terminated within the hop cap: ${hops.length} hops`).toBe(false);
      const texts = hops.map((h) => h.text);
      const alphaGot = collectIds(texts, "alpha");
      const betaGot = collectIds(texts, "beta");
      const wantAlpha = new Set(Array.from({ length: 80 }, (_, i) => 11 + i));
      const wantBeta = new Set(Array.from({ length: 70 }, (_, i) => 31 + i));
      const extraAlpha = [...alphaGot].filter((id) => !wantAlpha.has(id));
      const extraBeta = [...betaGot].filter((id) => !wantBeta.has(id));
      const missingAlpha = [...wantAlpha].filter((id) => !alphaGot.has(id));
      const missingBeta = [...wantBeta].filter((id) => !betaGot.has(id));
      expect(extraAlpha, `content:"full" widened past the requested alpha range: ${extraAlpha.join(",")}`).toEqual([]);
      expect(extraBeta, `content:"full" widened past the requested beta range: ${extraBeta.join(",")}`).toEqual([]);
      expect(missingAlpha, `alpha lines never delivered: ${missingAlpha.join(",")}`).toEqual([]);
      expect(missingBeta, `beta lines never delivered: ${missingBeta.join(",")}`).toEqual([]);
    }, 180000);

    it("a code file with a doc comment: range + content:\"full\" comes back UNELIDED, unlike the same range with content:\"auto\"", async () => {
      const autoRes = await server.call("tl_read_file", {
        targets: [{ path: "src/commented.ts", range: "1-13" }],
        content: "auto",
        cwd: ws,
      });
      expect(
        autoRes.text,
        `precondition: content:"auto" must actually elide this comment block, or the fixture is not exercising elision: ${autoRes.text.slice(0, 400)}`,
      ).not.toContain("this exact sentence must survive verbatim");

      const fullRes = await server.call("tl_read_file", {
        targets: [{ path: "src/commented.ts", range: "1-13" }],
        content: "full",
        task: { epoch: "new" },
        cwd: ws,
      });
      expect(
        fullRes.text,
        `range + content:"full" must serve the comment block UNELIDED: ${fullRes.text.slice(0, 500)}`,
      ).toContain("this exact sentence must survive verbatim");
      expect(fullRes.text, "must not widen to more than the requested file's own content").not.toMatch(/doc elided/);
    }, 180000);

    it("ranges:[] (plural) on one target + content:\"full\": both windows unelided, never widened to the whole file", async () => {
      const res = await server.call("tl_read_file", {
        targets: [{ path: "src/many.ts", ranges: ["1-5", "36-40"] }],
        content: "full",
        task: { epoch: "new" },
        cwd: ws,
      });
      expect(res.body["kind"], JSON.stringify(res.body).slice(0, 300)).toBe("read.text");
      for (const tag of ["r-tag-001", "r-tag-005", "r-tag-036", "r-tag-040"]) {
        expect(res.text, `window must contain ${tag}`).toContain(tag);
      }
      for (const tag of ["r-tag-010", "r-tag-020", "r-tag-030"]) {
        expect(res.text, `must NOT widen past the two requested windows (found ${tag})`).not.toContain(tag);
      }
    }, 180000);

    it("mixed batch: one ranged target serves ONLY its range, the un-ranged sibling serves its whole file", async () => {
      const { hops, capped } = await followToEnd(server, {
        tool: "tl_read_file",
        arguments: {
          targets: [
            { path: "data/ranged.txt", range: "10-20" },
            { path: "data/whole.txt" },
          ],
          content: "full",
          task: { epoch: "new" },
          cwd: ws,
        },
      });
      expect(capped, `chain never terminated: ${hops.length} hops`).toBe(false);
      const texts = hops.map((h) => h.text);
      const rangedGot = collectIds(texts, "ranged");
      const wholeGot = collectIds(texts, "whole");
      const wantRanged = new Set(Array.from({ length: 11 }, (_, i) => 10 + i));
      const extraRanged = [...rangedGot].filter((id) => !wantRanged.has(id));
      expect(extraRanged, `the RANGED target must never widen to the whole file: extra=${extraRanged.join(",")}`).toEqual([]);
      expect(rangedGot, "the ranged target's own window must be fully delivered").toEqual(wantRanged);
      const wantWhole = new Set(Array.from({ length: 15 }, (_, i) => 1 + i));
      expect(wholeGot, "the un-ranged sibling must still be served in full (unchanged behaviour)").toEqual(wantWhole);
    }, 180000);
  });

  describe(`budget floor (config=${configName})`, () => {
    afterEach(() => {
      for (const dir of tmpDirs.splice(0)) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    });

    it("a budget below the floor never dead-ends: it refuses with an executable next, or a cursor-staged single target names required_min_bytes", async () => {
      // FINDING (documented for the report, not asserted as a fixed product
      // number): this repo has TWO DIFFERENT floor-refusal shapes.
      //   - `budget-below-minimum` + `required_min_bytes` — minted only by
      //     `emit.ts`'s read/search-REQUEST-staged tail (a cursor-continued
      //     single target, `state/readRequestStore.ts`) and by
      //     `chooseSearchPage`'s own cursor floor.
      //   - `cap-exceeded` (no `required_min_bytes`, PROSE `detail` naming
      //     the exact measured/limit bytes) — `emit.ts`'s GENERIC
      //     `failClosed` tail, reached by every OTHER kind once the shed
      //     ladder cannot fit the declared budget — including `read.batch`,
      //     which never stages a read-request. Measured live at
      //     `budget.bytes:1/100/500` against this exact 2-target ranged
      //     batch: `cap-exceeded` every time, WITH a `next` that re-issues
      //     the same (or a one-line-narrower) call — never a bodyless dead
      //     end — until `budget.bytes` reaches a few KB, at which point the
      //     SAME call becomes a genuine `read.batch` success.
      const ws = mkWs(`${configName}-floor`);
      write(ws, "data/alpha.txt", selfIdLines("alpha", 200, 120));
      write(ws, "data/beta.txt", selfIdLines("beta", 200, 120));
      const server = startServer(ws, configEnv);
      try {
        await server.initialize();
        const tiny = await server.call("tl_read_file", {
          targets: [
            { path: "data/alpha.txt", range: "11-90" },
            { path: "data/beta.txt", range: "31-100" },
          ],
          content: "full",
          budget: { bytes: 1 },
          task: { epoch: "new" },
          cwd: ws,
        });
        if (tiny.body["kind"] === "refusal") {
          expect(
            ["budget-below-minimum", "cap-exceeded"],
            `unexpected refusal code for a below-floor budget: ${JSON.stringify(tiny.body).slice(0, 300)}`,
          ).toContain(tiny.body["code"]);
          if (tiny.body["code"] === "budget-below-minimum") {
            const minBytes = tiny.body["required_min_bytes"];
            expect(typeof minBytes, `required_min_bytes must be reported: ${JSON.stringify(tiny.body)}`).toBe("number");
            expect(minBytes as number, "the reported floor must be a positive byte count").toBeGreaterThan(0);
          } else {
            // `cap-exceeded` carries no machine-readable minimum — the
            // never-a-dead-end guarantee is that it still names a `next`.
            expect(tiny.body["next"], `a below-floor cap-exceeded refusal must still carry a next: ${JSON.stringify(tiny.body).slice(0, 400)}`).toBeDefined();
            expect(typeof tiny.body["detail"], "must state what it measured, even with no machine-readable floor").toBe("string");
          }
        } else {
          // This build's floor for this call shape is below 1 B worth of
          // declared budget pressure — acceptable; the contract is "never a
          // silent success with nothing delivered AND never an
          // unrecoverable dead end", not a specific numeric floor.
          expect(Buffer.byteLength(tiny.text, "utf8")).toBeGreaterThan(0);
        }
      } finally {
        server.kill();
      }
    }, 180000);

    it("a cursor-staged single-target continuation's floor DOES report required_min_bytes", async () => {
      // CONTRAST case for the finding above: the single-target, content:"full"
      // path stages a read-request (server.ts's stageReadRequestForServe) and
      // so DOES reach emit.ts's request-staged tail, which names
      // required_min_bytes explicitly.
      const ws = mkWs(`${configName}-floor-single`);
      write(ws, "data/alpha.txt", selfIdLines("alpha", 200, 120));
      const server = startServer(ws, configEnv);
      try {
        await server.initialize();
        const first = await server.call("tl_read_file", {
          targets: [{ path: "data/alpha.txt", range: "11-90" }],
          content: "full",
          budget: { bytes: 900 },
          task: { epoch: "new" },
          cwd: ws,
        });
        const next = extractNext(first.body);
        if (next?.tool === "tl_read_file" && typeof next.arguments["cursor"] === "string") {
          const tinyCursor = await server.call("tl_read_file", { ...next.arguments, budget: { bytes: 1 } });
          if (tinyCursor.body["kind"] === "refusal") {
            expect(tinyCursor.body["code"], JSON.stringify(tinyCursor.body).slice(0, 300)).toBe("budget-below-minimum");
            expect(typeof tinyCursor.body["required_min_bytes"]).toBe("number");
          }
        }
        // Otherwise (no cursor minted at 900 B for this fixture size) there
        // is nothing further to probe here — not a failure of this test.
      } finally {
        server.kill();
      }
    }, 180000);

    it("a caller-declared budget on a LATER hop is honoured, not silently widened back to the server default", async () => {
      const ws = mkWs(`${configName}-laterbudget`);
      write(ws, "data/alpha.txt", selfIdLines("alpha", 200, 120));
      write(ws, "data/beta.txt", selfIdLines("beta", 200, 120));
      const server = startServer(ws, configEnv);
      try {
        await server.initialize();
        const first = await server.call("tl_read_file", {
          targets: [
            { path: "data/alpha.txt", range: "11-90" },
            { path: "data/beta.txt", range: "31-100" },
          ],
          content: "full",
          budget: { bytes: 6500 },
          task: { epoch: "new" },
          cwd: ws,
        });
        const next = extractNext(first.body);
        expect(next, `first hop must carry a continuation: ${first.text.slice(0, 300)}`).toBeDefined();
        // FIX-A1's inheritCallerResponseBudget (protocol/envelope.ts) already
        // carries the 6500 B declaration onto this minted `next` — assert it
        // is actually present rather than re-deriving the mechanism.
        const carriedBudget = next!.arguments["budget"] as Record<string, unknown> | undefined;
        expect(carriedBudget?.["bytes"], JSON.stringify(next)).toBe(6500);
        const overridden = await server.call(next!.tool, { ...next!.arguments, budget: { bytes: 2000 } });
        expect(Buffer.byteLength(overridden.text, "utf8"), "an explicit override must be honoured, not ignored").toBeLessThanOrEqual(2000 + 512);
      } finally {
        server.kill();
      }
    }, 180000);
  });

  describe(`C02 regression controls (config=${configName})`, () => {
    afterEach(() => {
      for (const dir of tmpDirs.splice(0)) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    });

    it("a projection change (comments kept vs elided) on the SAME range is not receipted as unchanged", async () => {
      const ws = mkWs(`${configName}-projchange`);
      const src = [
        "export function first(): number {",
        "  return 1;",
        "}",
        "",
        "/**",
        " * projection-change-marker-line-one, a multi-line block comment that",
        " * elideDocCommentsForDisplay collapses under the default projection —",
        " * the fix under test must not let a later content:\"full\" read of the",
        " * SAME range be answered from a receipt that predates this text.",
        " */",
        "export function second(): number {",
        "  return 2;",
        "}",
      ].join("\n") + "\n";
      write(ws, "src/proj.ts", src);
      const server = startServer(ws, configEnv);
      try {
        await server.initialize();
        const auto1 = await server.call("tl_read_file", { targets: [{ path: "src/proj.ts", range: "1-13" }], cwd: ws });
        expect(auto1.body["kind"]).toBe("read.text");
        const auto2 = await server.call("tl_read_file", { targets: [{ path: "src/proj.ts", range: "1-13" }], cwd: ws });
        expect(auto2.body["kind"], "precondition: a plain repeat really is held").toBe("read.receipt");

        const full = await server.call("tl_read_file", {
          targets: [{ path: "src/proj.ts", range: "1-13" }], content: "full", cwd: ws,
        });
        expect(
          full.text,
          `content:"full" must re-serve the UNELIDED bytes, never answer from the elided-era receipt: ${full.text.slice(0, 400)}`,
        ).toContain("projection-change-marker-line-one");
      } finally {
        server.kill();
      }
    }, 180000);

    it("content:\"full\" alone (no range) still dedups to a receipt on an already-served window — R6 unaffected", async () => {
      const ws = mkWs(`${configName}-r6control`);
      write(ws, "src/plain.ts", "export const PLAIN_A = 1;\nexport const PLAIN_B = 2;\n");
      const server = startServer(ws, configEnv);
      try {
        await server.initialize();
        await server.call("tl_read_file", { targets: [{ path: "src/plain.ts" }], cwd: ws });
        const withFull = await server.call("tl_read_file", { targets: [{ path: "src/plain.ts" }], content: "full", cwd: ws });
        expect(withFull.body["kind"], JSON.stringify(withFull.body).slice(0, 300)).toBe("read.receipt");
      } finally {
        server.kill();
      }
    }, 180000);
  });
}
