// readReplyCeiling.spec.ts — 2026-10-24 (read-page ceiling): a `read.text` /
// `read.batch` reply is bound to the client profile's response ceiling, the way a
// task pack (readCodeTaskPack.ts's clampToActiveCeiling) and a find page
// (findText.ts's findResponseCapBytes) already were.
//
// THE DEFECT (generality audit r16, §3.6/§4.6; review-af-wire F3). The Copilot
// CLI spills a reply of 23,466 B or more into a temporary file the agent has to
// read back as another turn, and VS Code does the same above ~17 KB
// (protocol/codec/clientProfile.ts). Task packs and find pages kept under that;
// the read PAGES did not: a 290 KB C# class read through its own `limit.next`
// chain came back as eight 25.8 KB `read.text` pages, a 36 KB Python class as a
// 26.3 KB one under VS Code, and the 54-window `remaining` list of an
// answer-first reply, followed with `targets`, as one 31.5 KB `read.batch`.
//
// THE RULE UNDER TEST (protocol/budget/wireBudget.ts's `bindToResponseCeiling`,
// applied by protocol/emit.ts to `read.text` / `read.batch` and by server.ts's
// sizing sites): reply bound = min(declared budget, ceiling); the declared one
// wins when it is the tighter, a larger one is clamped, none = the ceiling; a
// client without a ceiling (claude-code, generic) is unbound, byte for byte. The
// paging mechanics carry what does not fit: no line asked for is dropped, and a
// page that cannot get under the ceiling because a source line is wider than it
// returns a bounded terminal refusal with no misleading retry continuation.
//
// Every end-to-end case here drives the real dispatcher (`callTool`) after the
// real handshake capture (`handleRequest` initialize), follows `limit.next`
// verbatim, and checks the three acceptance facts: every reply <= the ceiling,
// the union of served lines is exactly the lines asked for, the chain ends.

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ToolCall } from "@tokenlighten/types";

import {
  callTool,
  handleRequest,
  resetCapturedClientIdForTest,
} from "../server.js";
import { resetAll as resetAllSessions } from "../util/session.js";
import { bindToResponseCeiling } from "../protocol/budget/wireBudget.js";
import { resolveReadReplyCeiling } from "../protocol/codec/clientProfile.js";
import { unionBatchContinuations } from "../protocol/budget/wireLimit.js";
import { pageEnvelopeReserve, pageRowOverhead, wireWindowsCostBytes } from "../state/readRequestStore.js";
import { emitFinalizedPayload } from "../protocol/emit.js";
import type { ProtocolCallContext } from "../protocol/envelope.js";
import { shortTmpDir } from "./helpers/shortTmpDir.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const tmpDirs: string[] = [];
/** A chain is a dozen or more real dispatches of a large file; give each case the room the repo's own `--testTimeout=120000` runs give it. */
const CHAIN_TIMEOUT_MS = 120_000;

type Body = Record<string, unknown>;

/** The two clients whose profile carries a ceiling, as their handshake names them. */
const PROFILES = [
  { label: "copilot-cli", clientName: "copilot-cli", ceiling: 18 * 1024 },
  { label: "vscode", clientName: "Visual Studio Code", ceiling: 14336 },
] as const;

const ENV_KEYS = ["TOKENLIGHTEN_CLIENT_ID", "TOKENLIGHTEN_TASK_PACK_MAX_BYTES", "TOKENLIGHTEN_STATE_STORE"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  resetCapturedClientIdForTest();
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  resetCapturedClientIdForTest();
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterAll(() => {
  resetAllSessions();
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function mkWorkspace(tag: string): string {
  const root = fs.realpathSync(shortTmpDir(HOME, `.tl-readceil-${tag}-`));
  tmpDirs.push(root);
  return root;
}

function writeFile(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

/** The real handshake: this is how a client's name reaches the profile lookup. */
async function handshake(clientName: string): Promise<void> {
  await handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { clientInfo: { name: clientName, version: "1.0.0" } },
  });
}

async function read(args: Record<string, unknown>): Promise<{ body: Body; bytes: number }> {
  const result = await callTool("tl_read_file", args);
  const text = (result.content[0] as { text?: string } | undefined)?.text ?? "{}";
  return { body: JSON.parse(text) as Body, bytes: Buffer.byteLength(text, "utf8") };
}

/** The handle a ranged read of `file` mints: what a follow-up `targets:[{handle, range}]` names. */
async function handleFor(ws: string, file: string): Promise<string> {
  const { body } = await read({ cwd: ws, targets: [{ path: file, range: "1-3" }], content: "auto" });
  return String((body["evidence"] as Body[])[0]!["handle"]);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** One long class, no comments: ~70 B a line, the shape and size of the audit's 290 KB DocxAdapter. */
function bigClassSource(lines: number): string {
  return Array.from(
    { length: lines },
    (_, i) => `        var step${String(i).padStart(5, "0")} = Compute(input, ${i}, "${"x".repeat(30)}");`,
  ).join("\n") + "\n";
}

/** A TypeScript module whose every function carries a four-line doc block the default policy elides, so a read of it is a run of small code windows. */
function documentedModuleSource(functions: number): string {
  const out: string[] = ["// documented module"];
  for (let k = 0; k < functions; k += 1) {
    out.push(
      "/**",
      ` * Function ${k} computes a value for the module.`,
      " * It is documented so that comment elision has something to do",
      " */",
      `export function fn${k}(input: number, flag: boolean): number {`,
      `  const base = input * ${k + 1} + ${k};`,
      `  if (flag) { return base + ${k * 3}; }`,
      `  return base - ${k};`,
      "}",
      "",
    );
  }
  return out.join("\n") + "\n";
}

/** A module of `functions` small exported functions: its outline (signatures) is a few KB, its body is not read. */
function outlinedModuleSource(index: number, functions: number): string {
  const out: string[] = [`// module m${index}`];
  for (let k = 0; k < functions; k += 1) {
    out.push(
      `export function fn${index}_${k}(input: number, flag: boolean): number {`,
      `  return input * ${k + 1} + ${index};`,
      "}",
      "",
    );
  }
  return out.join("\n") + "\n";
}

function lineCountOf(text: string): number {
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n").length;
}

// ---------------------------------------------------------------------------
// What a chain served
// ---------------------------------------------------------------------------

const WINDOW = /^(\d+)-(\d+)$/;

/** Adds the lines a reply's rows deliver: bodies by `range`, and the comment windows it DISCLOSES as elided (delivered in the representation asked for, never owed). */
function recordServed(body: Body, served: Map<string, Set<number>>): void {
  const add = (rowPath: unknown, start: number, end: number): void => {
    if (typeof rowPath !== "string") return;
    let set = served.get(rowPath);
    if (set === undefined) { set = new Set<number>(); served.set(rowPath, set); }
    for (let line = start; line <= end; line += 1) set.add(line);
  };
  const rows = [
    ...(Array.isArray(body["evidence"]) ? (body["evidence"] as Body[]) : []).map((row) => ({ row, text: row["body"] })),
    ...(Array.isArray(body["entries"]) ? (body["entries"] as Body[]) : []).map((row) => ({ row, text: row["content"] })),
  ];
  for (const { row, text } of rows) {
    const match = typeof row["range"] === "string" ? WINDOW.exec(row["range"]) : null;
    if (match !== null && typeof text === "string") add(row["path"], Number(match[1]), Number(match[2]));
    // a whole-file entry (or the head of one a governed serve cut) names no range: its body is lines 1..k.
    else if (row["range"] === undefined && typeof text === "string" && String(row["form"] ?? "").startsWith("file")) {
      add(row["path"], 1, lineCountOf(text));
    }
    for (const disclosed of Array.isArray(row["elided"]) ? (row["elided"] as unknown[]) : []) {
      const window = typeof disclosed === "string" ? WINDOW.exec(disclosed) : null;
      if (window !== null) add(row["path"], Number(window[1]), Number(window[2]));
    }
  }
}

interface Chain {
  pages: Array<{ body: Body; bytes: number }>;
  served: Map<string, Set<number>>;
  /** The last page carried no `limit.next`: the chain ended by itself, not by the hop cap. */
  ended: boolean;
}

/** Runs `first`, then every `limit.next` verbatim (only the working directory is supplied when a `next` omits it), to the end or `hopCap`. */
async function followChain(first: Record<string, unknown>, cwd: string, hopCap = 60, allowTerminalRefusal = false): Promise<Chain> {
  const pages: Chain["pages"] = [];
  const served = new Map<string, Set<number>>();
  let args: Record<string, unknown> = { cwd, ...first };
  for (let hop = 0; hop < hopCap; hop += 1) {
    const page = await read(args);
    pages.push(page);
    if (page.body["kind"] === "refusal") {
      expect(allowTerminalRefusal, JSON.stringify(page.body).slice(0, 400)).toBe(true);
      expect(page.body["code"]).toBe("cap-exceeded");
      expect(page.body["retry"]).toBe("none");
      expect(page.body["limit"]).toBeUndefined();
      expect(page.body["next"]).toBeUndefined();
      return { pages, served, ended: true };
    }
    recordServed(page.body, served);
    const limit = page.body["limit"] as Body | undefined;
    const next = limit?.["next"] as { tool?: string; arguments?: Record<string, unknown> } | undefined;
    if (next === undefined) return { pages, served, ended: true };
    expect(next.tool).toBe("tl_read_file");
    args = { cwd, ...(next.arguments ?? {}) };
  }
  return { pages, served, ended: false };
}

function expectServed(chain: Chain, file: string, windows: ReadonlyArray<readonly [number, number]>): void {
  const served = chain.served.get(file) ?? new Set<number>();
  const asked = new Set<number>();
  for (const [start, end] of windows) for (let line = start; line <= end; line += 1) asked.add(line);
  const missing = [...asked].filter((line) => !served.has(line));
  expect(missing.slice(0, 12), `${file}: ${missing.length} asked lines never served`).toEqual([]);
  // ...and nothing outside the asked windows was claimed as served.
  const extra = [...served].filter((line) => !asked.has(line));
  expect(extra.slice(0, 12), `${file}: ${extra.length} lines served that were not asked for`).toEqual([]);
}

// ---------------------------------------------------------------------------
// The rule itself
// ---------------------------------------------------------------------------

describe("bindToResponseCeiling / resolveReadReplyCeiling (unit)", () => {
  it("a declared budget below the ceiling wins, a larger one is clamped, none = the ceiling", () => {
    expect(bindToResponseCeiling(6000, 18432)).toBe(6000);
    expect(bindToResponseCeiling(60000, 18432)).toBe(18432);
    expect(bindToResponseCeiling(18432, 18432)).toBe(18432);
    expect(bindToResponseCeiling(undefined, 18432)).toBe(18432);
  });

  it("no ceiling leaves the declared budget alone, and nothing declared is nothing bound", () => {
    expect(bindToResponseCeiling(6000, undefined)).toBe(6000);
    expect(bindToResponseCeiling(undefined, undefined)).toBeUndefined();
    expect(bindToResponseCeiling(6000, 0)).toBe(6000);
    expect(bindToResponseCeiling(undefined, Number.NaN)).toBeUndefined();
  });

  it("the reply ceiling is the task-pack ceiling: the profile's, replaced by TOKENLIGHTEN_TASK_PACK_MAX_BYTES, lifted by 0", () => {
    expect(resolveReadReplyCeiling("copilot-cli", undefined)).toBe(18 * 1024);
    expect(resolveReadReplyCeiling("Visual Studio Code", undefined)).toBe(14336);
    expect(resolveReadReplyCeiling("copilot-cli", "8192")).toBe(8192);
    expect(resolveReadReplyCeiling("copilot-cli", "0")).toBeUndefined();
    // Clients whose profile carries no ceiling are unbound, by construction.
    expect(resolveReadReplyCeiling("claude-code", undefined)).toBeUndefined();
    expect(resolveReadReplyCeiling("codex-mcp-client", undefined)).toBeUndefined();
    expect(resolveReadReplyCeiling(undefined, undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The funnel, on hand-built payloads
// ---------------------------------------------------------------------------

/** One emission through the real funnel tail for `clientId`, with the caller's own budget (if any) declared as `maxBytes`. */
function emit(payload: Body, kind: "read.text" | "read.batch", clientId: string | undefined, maxBytes?: number): { body: Body; bytes: number } {
  const context: ProtocolCallContext = {
    tool: "tl_read_file",
    ...(clientId !== undefined ? { clientId } : {}),
    ...(maxBytes !== undefined ? { args: { maxBytes } } : {}),
  };
  const result = emitFinalizedPayload(payload, kind, context);
  const text = result.content[0]?.text ?? "";
  return { body: JSON.parse(text) as Body, bytes: Buffer.byteLength(text, "utf8") };
}

function readTextPayload(lines: number): Body {
  return {
    v: 1,
    kind: "read.text",
    evidence: [{
      handle: "h1",
      path: "src/big.ts",
      range: `1-${lines}`,
      body: Array.from({ length: lines }, (_, i) => `line ${i + 1} ${"x".repeat(60)}`).join("\n"),
    }],
  };
}

/** A batch of `count` ranged entries of one handle each, ~2.4 KB apiece. */
function readBatchPayload(count: number): Body {
  return {
    v: 1,
    kind: "read.batch",
    entries: Array.from({ length: count }, (_, index) => ({
      form: "handle",
      handle: `h${index + 1}`,
      path: `src/file${index + 1}.ts`,
      range: "1-30",
      content: Array.from({ length: 30 }, (_, line) => `// ${index + 1}.${line + 1} ${"y".repeat(60)}`).join("\n"),
      truncated: false,
      sha: "sha256:abcdef012345",
    })),
  };
}

describe("emitFinalizedPayload binds a read.text / read.batch reply to the client's ceiling", () => {
  it("a 30 KB read.text is cut to the ceiling for copilot-cli and vscode, and left whole for a client without one", () => {
    const payload = readTextPayload(380);
    const whole = emit(payload, "read.text", "claude-code");
    expect(whole.bytes).toBeGreaterThan(25_000);
    expect(emit(payload, "read.text", undefined).bytes).toBe(whole.bytes);
    expect(emit(payload, "read.text", "codex-mcp-client").bytes).toBe(whole.bytes);
    for (const profile of PROFILES) {
      const bound = emit(payload, "read.text", profile.label);
      expect(bound.bytes, profile.label).toBeLessThanOrEqual(profile.ceiling);
      // what did not fit is owed: the row's `remaining` and the limit's `next` name the rest.
      const row = (bound.body["evidence"] as Body[])[0]!;
      expect(String(row["range"])).toMatch(/^1-\d+$/);
      expect(Array.isArray(row["remaining"])).toBe(true);
      const limit = bound.body["limit"] as Body;
      expect(limit["cause"]).toBe("wire");
      expect((limit["next"] as Body)["tool"]).toBe("tl_read_file");
    }
  });

  it("a declared budget below the ceiling still wins; one above it is clamped to the ceiling", () => {
    const payload = readTextPayload(380);
    for (const profile of PROFILES) {
      expect(emit(payload, "read.text", profile.label, 6000).bytes, `${profile.label} 6000`).toBeLessThanOrEqual(6000);
      const clamped = emit(payload, "read.text", profile.label, 60_000);
      expect(clamped.bytes, `${profile.label} 60000`).toBeLessThanOrEqual(profile.ceiling);
      expect(clamped.bytes).toBeGreaterThan(profile.ceiling * 0.5);
    }
    // ...and the same declared budget is honoured exactly as before for a client without a ceiling.
    expect(emit(payload, "read.text", "claude-code", 60_000).bytes).toBe(emit(payload, "read.text", "claude-code").bytes);
  });

  it("TOKENLIGHTEN_TASK_PACK_MAX_BYTES replaces the profile ceiling for reads exactly as for packs, and 0 lifts it", () => {
    const payload = readTextPayload(380);
    process.env["TOKENLIGHTEN_TASK_PACK_MAX_BYTES"] = "8192";
    expect(emit(payload, "read.text", "copilot-cli").bytes).toBeLessThanOrEqual(8192);
    process.env["TOKENLIGHTEN_TASK_PACK_MAX_BYTES"] = "0";
    expect(emit(payload, "read.text", "copilot-cli").bytes).toBe(emit(payload, "read.text", "claude-code").bytes);
  });

  it("a read.batch gives back WHOLE trailing entries into one next, never a half of every entry", () => {
    const payload = readBatchPayload(14);
    expect(emit(payload, "read.batch", "claude-code").bytes).toBeGreaterThan(30_000);
    for (const profile of PROFILES) {
      const bound = emit(payload, "read.batch", profile.label);
      expect(bound.bytes, profile.label).toBeLessThanOrEqual(profile.ceiling);
      const entries = bound.body["entries"] as Body[];
      expect(entries.length).toBeGreaterThan(3);
      expect(entries.length).toBeLessThan(14);
      for (const entry of entries) {
        // whole: the ranged entries are untouched, none narrowed to a half.
        expect(entry["range"]).toBe("1-30");
        expect(entry["truncated"]).toBe(false);
        expect(String(entry["content"]).split("\n")).toHaveLength(30);
      }
      // the dropped ones are owed, every one, by the single next.
      const limit = bound.body["limit"] as Body;
      const targets = ((limit["next"] as Body)["arguments"] as Body)["targets"] as Body[];
      expect(entries.length + targets.length).toBe(14);
      // every dropped entry is named once, each with its own whole window (the order of the list is not part of the contract).
      expect(targets.map((target) => `${String(target["handle"])}:${String(target["range"])}`).sort()).toEqual(
        Array.from({ length: 14 - entries.length }, (_, index) => `h${entries.length + index + 1}:1-30`).sort(),
      );
    }
  });

  it("a page that cannot get under the ceiling returns a bounded terminal refusal", () => {
    const monster: Body = {
      v: 1,
      kind: "read.text",
      evidence: [{ handle: "h1", path: "src/min.js", range: "1-1", body: "z".repeat(30_000) }],
    };
    for (const profile of PROFILES) {
      const out = emit(monster, "read.text", profile.label);
      expect(out.body["kind"], profile.label).toBe("refusal");
      expect(out.body["code"], profile.label).toBe("cap-exceeded");
      expect(out.body["retry"], profile.label).toBe("none");
      expect(out.body["detail"], profile.label).toContain("no source lines were served");
      expect(out.body["next"], profile.label).toBeUndefined();
      expect(out.bytes, profile.label).toBeLessThanOrEqual(profile.ceiling);
    }
    // an explicit budget the page cannot meet is still the caller's own to raise.
    const refused = emit(monster, "read.text", "copilot-cli", 5000);
    expect(refused.body["kind"]).toBe("refusal");
  });
});

// ---------------------------------------------------------------------------
// The batch continuation union keeps every window of one handle
// ---------------------------------------------------------------------------

describe("unionBatchContinuations keeps distinct windows of one handle", () => {
  const call = (targets: Array<Record<string, unknown>>): ToolCall =>
    ({ tool: "tl_read_file", arguments: { targets, content: "auto" } }) as unknown as ToolCall;

  it("two windows of one handle are two owed windows, not one", () => {
    const merged = unionBatchContinuations(
      call([{ handle: "h1", range: "110-138" }, { handle: "h1", range: "210-238" }, { handle: "h2", range: "10-38" }]),
      call([{ handle: "h1", range: "310-338" }]),
    );
    const targets = (merged!.arguments as Body)["targets"] as Body[];
    expect(targets.map((target) => `${String(target["handle"])}:${String(target["range"])}`)).toEqual([
      "h1:110-138", "h1:210-238", "h2:10-38", "h1:310-338",
    ]);
  });

  it("successive narrowing passes of ONE entry still replace each other (same handle, same end)", () => {
    const merged = unionBatchContinuations(
      call([{ handle: "h1", range: "51-100" }]),
      call([{ handle: "h1", range: "26-100" }]),
    );
    expect((merged!.arguments as Body)["targets"]).toEqual([{ handle: "h1", range: "26-100" }]);
  });

  it("two windows that end on one line are their union, not the later of the two", () => {
    const merged = unionBatchContinuations(
      call([{ handle: "h1", range: "10-40" }]),
      call([{ handle: "h1", range: "30-40" }]),
    );
    expect((merged!.arguments as Body)["targets"]).toEqual([{ handle: "h1", range: "10-40" }]);
  });
});

// ---------------------------------------------------------------------------
// End to end: the audit's shapes, per client
// ---------------------------------------------------------------------------

describe.each(PROFILES)("$label: the read pages of a large class fit the client's ceiling", ({ clientName, ceiling, label }) => {
  it("targets over the whole of a ~290 KB class: every page fits, the lines served are the lines asked for, the chain ends", async () => {
    await handshake(clientName);
    const ws = mkWorkspace(`class-${label}`);
    const source = bigClassSource(4200);
    expect(Buffer.byteLength(source, "utf8")).toBeGreaterThan(280_000);
    writeFile(ws, "src/Big.cs", source);

    const chain = await followChain({ targets: [{ path: "src/Big.cs", range: `1-${lineCountOf(source)}` }], content: "auto" }, ws);

    expect(chain.ended, "the chain must end by itself, not by the hop cap").toBe(true);
    expect(chain.pages.length).toBeGreaterThan(Math.floor(Buffer.byteLength(source, "utf8") / ceiling));
    for (const [index, page] of chain.pages.entries()) {
      expect(page.bytes, `page ${index}`).toBeLessThanOrEqual(ceiling);
      expect(page.body["kind"]).toBe("read.text");
    }
    // pages are worth a round trip: all but the last fill most of the ceiling.
    for (const page of chain.pages.slice(0, -1)) expect(page.bytes).toBeGreaterThan(ceiling * 0.8);
    expectServed(chain, "src/Big.cs", [[1, lineCountOf(source)]]);
    // the paging is the request's own: a cursor the store owes, not a restated read.
    const firstNext = (chain.pages[0]!.body["limit"] as Body)["next"] as { arguments: Body };
    expect(typeof firstNext.arguments["cursor"]).toBe("string");
  }, CHAIN_TIMEOUT_MS);

  it("the same read as content:full pages the same way", async () => {
    await handshake(clientName);
    const ws = mkWorkspace(`full-${label}`);
    const source = bigClassSource(1500);
    writeFile(ws, "src/Mid.cs", source);

    const chain = await followChain({ targets: [{ path: "src/Mid.cs" }], content: "full" }, ws);

    expect(chain.ended).toBe(true);
    expect(chain.pages.length).toBeGreaterThan(2);
    for (const [index, page] of chain.pages.entries()) expect(page.bytes, `page ${index}`).toBeLessThanOrEqual(ceiling);
    expectServed(chain, "src/Mid.cs", [[1, lineCountOf(source)]]);
  }, CHAIN_TIMEOUT_MS);

  it("a read of one symbol larger than the ceiling is paged, not spilled", async () => {
    await handshake(clientName);
    const ws = mkWorkspace(`symbol-${label}`);
    // ~21 KB of body: under the producer's 24 KiB symbol cap (so the pre-change reply was one 22 KB page), over both ceilings.
    const body = Array.from({ length: 330 }, (_, i) => `  const v${i} = ${i}; // padding padding padding padding ${i}`).join("\n");
    writeFile(ws, "src/big.ts", `export function processPayload() {\n${body}\n  return 0;\n}\n`);

    const chain = await followChain({ targets: [{ path: "src/big.ts", symbol: "processPayload" }], content: "auto" }, ws);

    expect(chain.ended).toBe(true);
    for (const [index, page] of chain.pages.entries()) expect(page.bytes, `page ${index}`).toBeLessThanOrEqual(ceiling);
    expect(chain.pages.length).toBeGreaterThan(1);
    expectServed(chain, "src/big.ts", [[1, 333]]);
  }, CHAIN_TIMEOUT_MS);

  it("a read.batch of 54 windows over two handles is paged by whole entries, every window arrives", async () => {
    await handshake(clientName);
    const ws = mkWorkspace(`batch-${label}`);
    const alpha = bigClassSource(3800);
    const beta = bigClassSource(1000);
    writeFile(ws, "src/alpha.cs", alpha);
    writeFile(ws, "src/beta.cs", beta);
    const hAlpha = await handleFor(ws, "src/alpha.cs");
    const hBeta = await handleFor(ws, "src/beta.cs");

    // The answer-first `remaining` list followed with `targets`: 54 windows of 29 lines, one in three on beta.
    const windows: Array<{ handle: string; file: string; range: string; span: [number, number] }> = [];
    let alphaIndex = 0;
    let betaIndex = 0;
    for (let i = 0; i < 54; i += 1) {
      const onBeta = i % 3 === 0;
      const start = onBeta ? 10 + betaIndex++ * 50 : 10 + alphaIndex++ * 100;
      windows.push({
        handle: onBeta ? hBeta : hAlpha,
        file: onBeta ? "src/beta.cs" : "src/alpha.cs",
        range: `${start}-${start + 28}`,
        span: [start, start + 28],
      });
    }

    const chain = await followChain({ targets: windows.map(({ handle, range }) => ({ handle, range })), content: "auto" }, ws);

    expect(chain.ended).toBe(true);
    expect(chain.pages.length).toBeGreaterThan(2);
    for (const [index, page] of chain.pages.entries()) {
      expect(page.bytes, `page ${index}`).toBeLessThanOrEqual(ceiling);
      // a last page of one window is a plain slice; every page before it is a batch.
      expect(page.body["kind"], `page ${index}`).toBe(index === chain.pages.length - 1 ? page.body["kind"] : "read.batch");
      expect(["read.batch", "read.text"]).toContain(page.body["kind"]);
    }
    expect(chain.pages[0]!.body["kind"]).toBe("read.batch");
    expectServed(chain, "src/alpha.cs", windows.filter((w) => w.file === "src/alpha.cs").map((w) => w.span));
    expectServed(chain, "src/beta.cs", windows.filter((w) => w.file === "src/beta.cs").map((w) => w.span));

    // A caller's tighter budget still wins through the whole batch continuation.
    resetAllSessions();
    const tight = await followChain({
      targets: windows.map(({ handle, range }) => ({ handle, range })),
      content: "auto",
      budget: { bytes: 10_000 },
    }, ws);
    expect(tight.ended).toBe(true);
    for (const [index, page] of tight.pages.entries()) expect(page.bytes, `tight page ${index}`).toBeLessThanOrEqual(10_000);
    expectServed(tight, "src/alpha.cs", windows.filter((w) => w.file === "src/alpha.cs").map((w) => w.span));
    expectServed(tight, "src/beta.cs", windows.filter((w) => w.file === "src/beta.cs").map((w) => w.span));
  }, CHAIN_TIMEOUT_MS);

  it("a batch containing a line wider than the ceiling refuses boundedly without losing a retryable tail", async () => {
    await handshake(clientName);
    const ws = mkWorkspace(`firstcut-${label}`);
    // One requested line cannot be represented under the client ceiling; the safe response is terminal disclosure, not an oversized page.
    const lines = Array.from({ length: 160 }, (_, i) => `const row${i + 1} = ${i + 1};`);
    lines[29] = `const blob = "${"q".repeat(ceiling + 4000)}";`;
    writeFile(ws, "src/cut.js", lines.join("\n") + "\n");
    const handle = await handleFor(ws, "src/cut.js");
    const windows = [{ start: 5, end: 60 }, { start: 100, end: 130 }];

    const chain = await followChain({ targets: windows.map((w) => ({ handle, range: `${w.start}-${w.end}` })), content: "auto" }, ws, 60, true);

    expect(chain.ended).toBe(true);
    expect(chain.pages.length).toBeGreaterThan(0);
    for (const page of chain.pages) expect(page.bytes).toBeLessThanOrEqual(ceiling);
    const terminal = chain.pages.at(-1)!.body;
    expect(terminal["kind"]).toBe("refusal");
    expect(terminal["detail"]).toContain("no source lines were served");
  }, CHAIN_TIMEOUT_MS);

  it("a file whose doc blocks the default policy elides pages by its code windows, and the disclosed comments are not owed", async () => {
    await handshake(clientName);
    const ws = mkWorkspace(`docs-${label}`);
    const source = documentedModuleSource(150);
    writeFile(ws, "src/documented.ts", source);

    const chain = await followChain({ targets: [{ path: "src/documented.ts", range: `1-${lineCountOf(source)}` }], content: "auto" }, ws);

    expect(chain.ended).toBe(true);
    for (const [index, page] of chain.pages.entries()) expect(page.bytes, `page ${index}`).toBeLessThanOrEqual(ceiling);
    // not twelve windows a page: a page is worth the ceiling, not the count cap.
    const middle = chain.pages.slice(1, -1);
    expect(middle.length).toBeGreaterThan(0);
    for (const page of middle) expect(page.bytes).toBeGreaterThan(ceiling * 0.6);
    expectServed(chain, "src/documented.ts", [[1, lineCountOf(source)]]);
  }, CHAIN_TIMEOUT_MS);

  it("a fixed multi-window cursor reports a truthful explicit-budget floor and replays the same windows", async () => {
    await handshake(clientName);
    const ws = mkWorkspace(`fixed-floor-${label}`);
    const source = documentedModuleSource(420);
    const file = "src/fixed.ts";
    writeFile(ws, file, source);
    const sourceLines = source.split(/\r?\n/u);
    const first = await read({ cwd: ws, targets: [{ path: file, range: `1-${lineCountOf(source)}` }], content: "auto" });
    expect(first.bytes).toBeLessThanOrEqual(ceiling);
    const firstNext = (first.body["limit"] as Body)["next"] as { tool?: string; arguments?: Record<string, unknown> };
    expect(firstNext.tool).toBe("tl_read_file");
    expect(typeof firstNext.arguments?.["cursor"]).toBe("string");
    const cursorArgs = { cwd: ws, ...(firstNext.arguments ?? {}) };
    const fixed = await read(cursorArgs);
    expect(fixed.bytes).toBeLessThanOrEqual(ceiling);
    expect(fixed.body["kind"]).toBe("read.text");
    const fixedRows = fixed.body["evidence"] as Body[];
    const windows = fixedRows.map(row => {
      const match = typeof row["range"] === "string" ? WINDOW.exec(row["range"] as string) : null;
      expect(match, "each emitted row names its fixed window").not.toBeNull();
      return { start: Number(match![1]), end: Number(match![2]) };
    });
    expect(windows.length, "the fixed page exercises per-row wire overhead").toBeGreaterThan(10);
    const legacyFloor = wireWindowsCostBytes(sourceLines, windows)
      + pageEnvelopeReserve(file, ws);
    const fullRowOverhead = pageRowOverhead(file) * windows.length;
    const probeBudget = legacyFloor + Math.max(1, Math.floor(fullRowOverhead / 2));
    expect(probeBudget).toBeGreaterThan(legacyFloor);
    expect(probeBudget).toBeLessThan(legacyFloor + fullRowOverhead);
    expect(probeBudget).toBeLessThan(ceiling);

    // This is the original fixed cursor, replayed with a declared budget that
    // covers every source line but not the projected row objects. It must refuse
    // with the actual floor instead of trimming/re-fixing the stored page.
    const tooSmall = await read({ ...cursorArgs, budget: { bytes: probeBudget } });
    expect(tooSmall.body["kind"]).toBe("refusal");
    expect(tooSmall.body["code"]).toBe("budget-below-minimum");
    const required = Number(tooSmall.body["required_min_bytes"]);
    expect(required).toBeGreaterThan(probeBudget);

    // Raising to the named floor must let the exact same page through; the
    // fixed windows and source bytes are stable on repeated replay.
    const retryArgs = { ...cursorArgs, budget: { bytes: required }, task: { ...((cursorArgs as Body)["task"] as Body), force_serve: true } };
    const retried = await read(retryArgs);
    expect(retried.body["kind"]).toBe("read.text");
    expect(retried.bytes).toBeLessThanOrEqual(required);
    const replay = await read(retryArgs);
    expect(replay.body["kind"]).toBe("read.text");
    expect(replay.bytes).toBe(retried.bytes);
    expect(replay.body["evidence"]).toEqual(retried.body["evidence"]);
    expect(retried.body["evidence"]).toEqual(fixed.body["evidence"]);
  }, CHAIN_TIMEOUT_MS);

  it("a content:full batch mixing ranged and bare targets pages every window: the ranged one deferred past a page is not lost, and the last page still names its elided comments", async () => {
    await handshake(clientName);
    const ws = mkWorkspace(`mixed-${label}`);
    const source = documentedModuleSource(40);
    const total = lineCountOf(source);
    const files = [0, 1, 2, 3, 4].map((index) => `src/m${index}.ts`);
    files.forEach((file, index) => writeFile(ws, file, source.replace("// documented module", `// documented module ${index}`)));

    const chain = await followChain({
      targets: [
        { path: files[0]!, range: "1-300" },
        { path: files[1]! },
        { path: files[2]! },
        { path: files[3]!, range: "1-200" },
        { path: files[4]! },
      ],
      content: "full",
    }, ws);

    expect(chain.ended).toBe(true);
    expect(chain.pages.length).toBeGreaterThan(2);
    for (const [index, page] of chain.pages.entries()) expect(page.bytes, `page ${index}`).toBeLessThanOrEqual(ceiling);
    expectServed(chain, files[0]!, [[1, 300]]);
    expectServed(chain, files[1]!, [[1, total]]);
    expectServed(chain, files[2]!, [[1, total]]);
    expectServed(chain, files[3]!, [[1, 200]]);
    expectServed(chain, files[4]!, [[1, total]]);
    // the page that completes the chain names its file's elided comment windows (they are not owed, but they are disclosed).
    const last = chain.pages[chain.pages.length - 1]!.body;
    const lastRows = [...((last["evidence"] as Body[] | undefined) ?? []), ...((last["entries"] as Body[] | undefined) ?? [])];
    expect(lastRows.flatMap((row) => (Array.isArray(row["elided"]) ? (row["elided"] as unknown[]) : [])).length).toBeGreaterThan(0);
  }, CHAIN_TIMEOUT_MS);

  it("a content:full batch of whole files larger than the ceiling is paged by the cursor, not shipped whole as its one entry", async () => {
    await handshake(clientName);
    const ws = mkWorkspace(`wholefiles-${label}`);
    // between the ceilings and the 24 KiB single-serve cap: served whole by the producer, wider than either ceiling
    const big = bigClassSource(300);
    const bigger = bigClassSource(900);
    expect(Buffer.byteLength(big, "utf8")).toBeGreaterThan(20_000);
    writeFile(ws, "src/a.cs", bigger);
    writeFile(ws, "src/b.cs", big);

    const chain = await followChain({ targets: [{ path: "src/a.cs" }, { path: "src/b.cs" }], content: "full" }, ws);

    expect(chain.ended).toBe(true);
    for (const [index, page] of chain.pages.entries()) expect(page.bytes, `page ${index}`).toBeLessThanOrEqual(ceiling);
    expectServed(chain, "src/a.cs", [[1, lineCountOf(bigger)]]);
    expectServed(chain, "src/b.cs", [[1, lineCountOf(big)]]);
  }, CHAIN_TIMEOUT_MS);

  it("a content:full batch whose last entry is a ranged window the producer cuts to the ceiling still owes the cut tail", async () => {
    await handshake(clientName);
    const ws = mkWorkspace(`rangedtail-${label}`);
    const first = bigClassSource(400);
    const second = bigClassSource(400);
    writeFile(ws, "src/first.cs", first);
    writeFile(ws, "src/second.cs", second);

    // two windows of 23 KB, each wider than either ceiling: the first is deferred whole, the second is the one entry that ships, cut to the ceiling
    const chain = await followChain({ targets: [{ path: "src/first.cs", range: "30-360" }, { path: "src/second.cs", range: "30-360" }], content: "full" }, ws);

    expect(chain.ended).toBe(true);
    for (const [index, page] of chain.pages.entries()) expect(page.bytes, `page ${index}`).toBeLessThanOrEqual(ceiling);
    expectServed(chain, "src/first.cs", [[30, 360]]);
    expectServed(chain, "src/second.cs", [[30, 360]]);
  }, CHAIN_TIMEOUT_MS);

  it("a batch of windows that each break into many one-line runs is cut at a window boundary: the wire cost of the runs counts, none is lost", async () => {
    await handshake(clientName);
    const ws = mkWorkspace(`runs-${label}`);
    const source = documentedModuleSource(300);
    writeFile(ws, "src/runs.ts", source);
    const handle = await handleFor(ws, "src/runs.ts");
    // sixteen windows of four documented functions: each is five runs of code between elided doc blocks, ~1 KB of entry envelopes per ~0.6 KB of code
    const windows = Array.from({ length: 16 }, (_, index) => {
      const start = 11 + index * 180;
      return { start, end: start + 39 };
    });

    const chain = await followChain({ targets: windows.map((w) => ({ handle, range: `${w.start}-${w.end}` })), content: "auto" }, ws);

    expect(chain.ended).toBe(true);
    expect(chain.pages.length).toBeGreaterThan(1);
    for (const [index, page] of chain.pages.entries()) expect(page.bytes, `page ${index}`).toBeLessThanOrEqual(ceiling);
    expectServed(chain, "src/runs.ts", windows.map((w) => [w.start, w.end] as const));
  }, CHAIN_TIMEOUT_MS);

  it("an outline batch is cut at an entry boundary and its continuation stays an outline", async () => {
    await handshake(clientName);
    const ws = mkWorkspace(`outline-${label}`);
    const files = Array.from({ length: 24 }, (_, index) => `src/m${index}.ts`);
    files.forEach((file, index) => writeFile(ws, file, outlinedModuleSource(index, 60)));

    const seen = new Set<string>();
    let args: Record<string, unknown> = { cwd: ws, targets: files.map((file) => ({ path: file })), content: "outline" };
    let pages = 0;
    for (; pages < 60; pages += 1) {
      const page = await read(args);
      expect(page.bytes, `page ${pages}`).toBeLessThanOrEqual(ceiling);
      expect(page.body["kind"], JSON.stringify(page.body).slice(0, 300)).not.toBe("refusal");
      for (const entry of (page.body["entries"] as Body[] | undefined) ?? []) seen.add(String(entry["path"]));
      // the last single path comes back as a plain outline (`read.map`), whose signatures name their file.
      const signatures = (page.body["outline"] as Body | undefined)?.["signatures"];
      const single = typeof signatures === "string" ? /path=(\S+)/u.exec(signatures)?.[1] : undefined;
      if (single !== undefined) seen.add(single);
      const next = (page.body["limit"] as Body | undefined)?.["next"] as { arguments?: Body } | undefined;
      if (next === undefined) break;
      // the recovery is the SAME outline over the paths left, never a full read of them.
      expect(next.arguments?.["content"]).toBe("outline");
      expect(JSON.stringify(next)).not.toContain('"mode":"full"');
      args = { cwd: ws, ...(next.arguments ?? {}) };
    }
    expect(pages).toBeLessThan(60);
    expect(pages).toBeGreaterThan(2);
    expect([...seen].sort()).toEqual([...files].sort());
  }, CHAIN_TIMEOUT_MS);

  it("an explicit budget below the ceiling wins and one above it is clamped, through the whole chain", async () => {
    await handshake(clientName);
    const ws = mkWorkspace(`explicit-${label}`);
    const source = bigClassSource(900);
    writeFile(ws, "src/e.cs", source);

    const tight = await followChain({ targets: [{ path: "src/e.cs", range: "1-900" }], content: "auto", budget: { bytes: 6000 } }, ws);
    expect(tight.ended).toBe(true);
    for (const [index, page] of tight.pages.entries()) expect(page.bytes, `tight page ${index}`).toBeLessThanOrEqual(6000);
    // Measure the actual emitted JSON, including the cwd echoed by the cursor
    // continuation. The sizing path must account for the same shape the client
    // receives, rather than an internally reconstructed cursor call without cwd.
    const firstTight = tight.pages[0]!;
    expect(firstTight.bytes).toBe(Buffer.byteLength(JSON.stringify(firstTight.body), "utf8"));
    const firstTightNext = (firstTight.body["limit"] as Body)["next"] as { arguments: Body };
    expect(firstTightNext.arguments["cwd"]).toBe(ws);
    expect(typeof firstTightNext.arguments["cursor"]).toBe("string");
    expectServed(tight, "src/e.cs", [[1, 900]]);

    resetAllSessions();
    const loose = await followChain({ targets: [{ path: "src/e.cs", range: "1-900" }], content: "auto", budget: { bytes: 60_000 } }, ws);
    expect(loose.ended).toBe(true);
    for (const [index, page] of loose.pages.entries()) expect(page.bytes, `loose page ${index}`).toBeLessThanOrEqual(ceiling);
    expect(loose.pages.length).toBeGreaterThan(2);
    expectServed(loose, "src/e.cs", [[1, 900]]);
  }, CHAIN_TIMEOUT_MS);

  it("with the state store off there is no cursor, and the plain remainder still owes every line", async () => {
    await handshake(clientName);
    const ws = mkWorkspace(`nostore-${label}`);
    const source = documentedModuleSource(150);
    writeFile(ws, "src/documented.ts", source);
    process.env["TOKENLIGHTEN_STATE_STORE"] = "off";

    const chain = await followChain({ targets: [{ path: "src/documented.ts", range: `1-${lineCountOf(source)}` }], content: "auto" }, ws);

    expect(chain.ended).toBe(true);
    for (const [index, page] of chain.pages.entries()) expect(page.bytes, `page ${index}`).toBeLessThanOrEqual(ceiling);
    expectServed(chain, "src/documented.ts", [[1, lineCountOf(source)]]);
    const firstNext = (chain.pages[0]!.body["limit"] as Body)["next"] as { arguments: Body };
    expect(firstNext.arguments["cursor"]).toBeUndefined();
  }, CHAIN_TIMEOUT_MS);

  it("a line wider than the client ceiling returns a bounded terminal refusal without serving or retrying it", async () => {
    await handshake(clientName);
    const ws = mkWorkspace(`longline-${label}`);
    const lines = Array.from({ length: 60 }, (_, i) => `const a${i} = ${i};`);
    lines.splice(20, 0, `const blob = "${"q".repeat(ceiling + 4000)}";`);
    writeFile(ws, "src/min.js", lines.join("\n") + "\n");

    const chain = await followChain({
      targets: [{ path: "src/min.js", range: `1-${lines.length}` }],
      content: "auto",
      budget: { bytes: 60_000 },
    }, ws, 60, true);

    expect(chain.ended).toBe(true);
    expect(chain.pages.length).toBeGreaterThan(0);
    for (const page of chain.pages) expect(page.bytes).toBeLessThanOrEqual(ceiling);
    const terminal = chain.pages.at(-1)!.body;
    expect(terminal["kind"]).toBe("refusal");
    expect(terminal["code"]).toBe("cap-exceeded");
    expect(terminal["retry"]).toBe("none");
    expect(terminal["detail"]).toContain("response ceiling");
    expect(terminal["detail"]).toContain("no source lines were served");
    expect(terminal["limit"]).toBeUndefined();
    expect(terminal["next"]).toBeUndefined();
    expect(terminal["decision"]).toBeUndefined();
    expect(JSON.stringify(terminal)).not.toContain("const blob");
  }, CHAIN_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// A client without a ceiling is unbound, byte for byte
// ---------------------------------------------------------------------------

describe("a client without a ceiling reads exactly as before", () => {
  async function firstPages(clientName: string | undefined, env: Record<string, string> = {}): Promise<Array<{ bytes: number; ranges: string[]; next: string }>> {
    resetAllSessions();
    resetCapturedClientIdForTest();
    if (clientName !== undefined) await handshake(clientName);
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
    const ws = mkWorkspace("unbound");
    const source = bigClassSource(1200);
    writeFile(ws, "src/Big.cs", source);
    const chain = await followChain({ targets: [{ path: "src/Big.cs", range: "1-1200" }], content: "auto" }, ws, 6);
    return chain.pages.map((page) => {
      const next = ((page.body["limit"] as Body | undefined)?.["next"] ?? {}) as { arguments?: Body };
      const shape = JSON.stringify(next.arguments ?? {}).replace(/"cwd":"[^"]*"/, '"cwd":"-"').replace(/h[0-9a-z]{10}/g, "h-");
      return {
        bytes: page.bytes,
        ranges: ((page.body["evidence"] as Body[] | undefined) ?? []).map((row) => String(row["range"])),
        next: shape,
      };
    });
  }

  it("claude-code, codex and an unknown client get the producer's 24 KiB pages and its own handle+range next", async () => {
    const claude = await firstPages("claude-code");
    expect(claude[0]!.bytes).toBeGreaterThan(24_000);
    expect(claude[0]!.next).not.toContain("cursor");
    expect(claude[0]!.next).toContain("targets");
    expect(await firstPages("codex-mcp-client")).toEqual(claude);
    expect(await firstPages(undefined)).toEqual(claude);
  });

  it("a ceiling lifted with TOKENLIGHTEN_TASK_PACK_MAX_BYTES=0 is the unbound read, byte for byte", async () => {
    const claude = await firstPages("claude-code");
    expect(await firstPages("copilot-cli", { TOKENLIGHTEN_TASK_PACK_MAX_BYTES: "0" })).toEqual(claude);
    expect(await firstPages("Visual Studio Code", { TOKENLIGHTEN_TASK_PACK_MAX_BYTES: "0" })).toEqual(claude);
  });
});
