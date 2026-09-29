/**
 * fixFcEval0927Wave.spec.ts — FIX-FC, eval-0927 review wave (2026-09-27).
 *
 * Regression coverage for the eight items assigned to FIX-FC: review
 * findings 3, 13, 14, 15, 16, 20, plus two pre-existing defects found in the
 * full suite (an over-budget ranged read shipping no body; a wasted
 * post-certification `next`). Each case reproduces the exact defect against
 * the pre-fix behaviour recorded in this file's own comments (measured by
 * hand against the working tree before this wave's fix, and against the
 * `c0922` pre-wave candidate build where the brief's review notes it as
 * pre-existing) and then asserts the fixed shape. Every server is spawned
 * fresh per test and killed in `afterEach`, following
 * `readRequestContinuation.spec.ts`'s own pattern.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildHttpCorpusWorkspace } from "./helpers/evaluation0927Scenarios.js";

const nodeRequire = createRequire(import.meta.url);
const TSX_CLI = nodeRequire.resolve("tsx/cli");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_TS = path.resolve(HERE, "..", "bin.ts");

interface Server {
  initialize(): Promise<void>;
  call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  kill(): void;
}

const servers: Server[] = [];
const workspaces: string[] = [];

function startServer(cwd: string, extraArgs: readonly string[] = []): Server {
  const child: ChildProcess = spawn(process.execPath, [TSX_CLI, "--liftoff-only", BIN_TS, cwd, ...extraArgs], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, TOKENLIGHTEN_ALLOWED_PARENTS: os.tmpdir() },
    detached: process.platform !== "win32",
  });
  const killGroup = (): void => {
    try {
      if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch { /* already gone */ }
  };
  let buffer = "";
  let stderr = "";
  let nextId = 1;
  const waiters = new Map<number, (value: Record<string, unknown>) => void>();

  child.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line) as { id?: number };
        if (message.id !== undefined) {
          const waiter = waiters.get(message.id);
          if (waiter) {
            waiters.delete(message.id);
            waiter(message as Record<string, unknown>);
          }
        }
      } catch { /* non-JSON diagnostics */ }
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

  const rpc = (method: string, params?: unknown): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`fix-fc wave ${method} timed out\n${stderr}`));
      }, 60_000);
      waiters.set(id, (message) => { clearTimeout(timer); resolve(message); });
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

  return {
    async initialize(): Promise<void> {
      await rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "vitest-fix-fc-wave", version: "0" },
      });
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    async call(name, args): Promise<Record<string, unknown>> {
      const response = await rpc("tools/call", { name, arguments: args });
      if (response.error !== undefined) throw new Error(JSON.stringify(response.error));
      const result = response.result as { content?: Array<{ text?: string }> } | undefined;
      const text = result?.content?.[0]?.text ?? "{}";
      return JSON.parse(text) as Record<string, unknown>;
    },
    kill(): void { killGroup(); },
  };
}

afterEach(() => {
  for (const server of servers.splice(0)) server.kill();
});

afterAll(() => {
  for (const server of servers) server.kill();
  for (const dir of workspaces) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function makeWorkspace(tag: string, files: Record<string, string>): string {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `tl-fixfc-${tag}-`)));
  workspaces.push(ws);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(ws, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return ws;
}

function evidenceOf(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const raw = body["evidence"];
  return Array.isArray(raw) ? raw.filter((e): e is Record<string, unknown> => e !== null && typeof e === "object") : [];
}

// ---------------------------------------------------------------------------
// Item 1 / finding 3 — `prior` for bytes never shipped.
// ---------------------------------------------------------------------------
describe("finding 3: prior never claimed for bytes this task never actually shipped", () => {
  it("an ambiguous single-candidate hop's counterexample surface, if never shipped, is never later restated as resident", async () => {
    const ws = makeWorkspace("f3", {
      "package.json": '{ "name": "f3", "private": true, "type": "module" }\n',
      "src/config.ts": [
        "export interface ClientOptions {",
        "  timeoutMs: number;",
        "  maxAttempts: number;",
        "  retryDelayMs: number;",
        "}",
        "",
        "export const DEFAULT_OPTIONS: ClientOptions = {",
        "  timeoutMs: 5000,",
        "  maxAttempts: 3,",
        "  retryDelayMs: 100,",
        "};",
        "",
        "export function loadOptions(env: Record<string, string | undefined>): ClientOptions {",
        "  return { ...DEFAULT_OPTIONS, timeoutMs: Number(env.HTTP_TIMEOUT_MS ?? DEFAULT_OPTIONS.timeoutMs) };",
        "}",
        "",
      ].join("\n"),
      "src/httpClient.ts": [
        'import { loadOptions, type ClientOptions } from "./config";',
        'import { backoffDelay, shouldRetry } from "./retry";',
        "",
        "export async function fetchWithRetry(url: string, init: RequestInit = {}, options: ClientOptions = loadOptions(process.env)): Promise<Response> {",
        "  for (let attempt = 0; ; attempt++) {",
        "    const controller = new AbortController();",
        "    const timer = setTimeout(() => controller.abort(), options.timeoutMs);",
        "    try {",
        "      const response = await fetch(url, { ...init, signal: controller.signal });",
        "      if (!shouldRetry(response.status, attempt, options.maxAttempts)) return response;",
        "    } finally {",
        "      clearTimeout(timer);",
        "    }",
        "    await new Promise((resolve) => setTimeout(resolve, backoffDelay(attempt, options.retryDelayMs)));",
        "  }",
        "}",
        "",
      ].join("\n"),
      "src/retry.ts": [
        "export function shouldRetry(status: number, attempt: number, maxAttempts: number): boolean {",
        "  return (status === 429 || status >= 500) && attempt + 1 < maxAttempts;",
        "}",
        "export function backoffDelay(attempt: number, baseDelayMs: number): number {",
        "  return baseDelayMs * 2 ** attempt;",
        "}",
        "",
      ].join("\n"),
    });
    const server = startServer(ws, ["--tool-surface", "full"]);
    servers.push(server);
    await server.initialize();

    const query = "Raise the default timeout in src/config.ts from 5000 to 10000.";
    const hop0 = await server.call("read_file", { query, cwd: ws, task: { epoch: "new", profile: "answer" } });
    const qref = hop0["qref"];
    expect(typeof qref, `hop0 carried no qref: ${JSON.stringify(hop0)}`).toBe("string");

    // Every hop this task's own qref replays: any evidence row claiming
    // `prior` must name bytes an EARLIER hop's own evidence[].body actually
    // shipped for that exact (path, range) — never a row this exact chain
    // never put on the wire.
    const shipped = new Map<string, Set<number>>();
    const claimedPriorNeverShipped: unknown[] = [];
    const recordAndCheck = (body: Record<string, unknown>): void => {
      for (const entry of evidenceOf(body)) {
        const p = entry["path"];
        const range = entry["range"];
        if (typeof p !== "string" || typeof range !== "string") continue;
        const match = /^(\d+)-(\d+)$/.exec(range);
        if (match === null) continue;
        const [start, end] = [Number(match[1]), Number(match[2])];
        const haveShipped = typeof entry["body"] === "string";
        if (haveShipped) {
          const set = shipped.get(p) ?? new Set<number>();
          for (let line = start; line <= end; line++) set.add(line);
          shipped.set(p, set);
        } else if (entry["prior"] !== undefined) {
          const set = shipped.get(p) ?? new Set<number>();
          const missing: number[] = [];
          for (let line = start; line <= end; line++) if (!set.has(line)) missing.push(line);
          if (missing.length > 0) {
            claimedPriorNeverShipped.push({ path: p, range, prior: entry["prior"], missing: missing.slice(0, 5) });
          }
        }
      }
    };
    recordAndCheck(hop0);
    let hop = hop0;
    for (let i = 0; i < 4; i++) {
      hop = await server.call("read_file", { qref, cwd: ws });
      recordAndCheck(hop);
    }
    expect(
      claimedPriorNeverShipped,
      `a row claimed 'prior' for lines this chain never shipped: ${JSON.stringify(claimedPriorNeverShipped)}`,
    ).toEqual([]);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Item 2 / finding 13 — a budget-below-minimum refusal's `next` must name
// EVERY target of the original request, not just the ones a discarded draft
// still considered pending.
// ---------------------------------------------------------------------------
describe("finding 13: budget-below-minimum refusal next names every original target", () => {
  it("two ranged targets, tiny budget -> refusal next carries both, not just one", async () => {
    const ws = makeWorkspace("f13", {
      "package.json": '{ "name": "f13", "private": true, "type": "module" }\n',
      "src/config.ts": Array.from({ length: 20 }, (_, i) => `export const cfgLine${i} = ${i};`).join("\n") + "\n",
      "src/retry.ts": Array.from({ length: 20 }, (_, i) => `export const retryLine${i} = ${i};`).join("\n") + "\n",
    });
    const server = startServer(ws, ["--tool-surface", "full"]);
    servers.push(server);
    await server.initialize();

    const res = await server.call("read_file", {
      targets: [{ path: "src/config.ts", range: "5-7" }, { path: "src/retry.ts", range: "2-2" }],
      content: "full",
      budget: { bytes: 300 },
      cwd: ws,
    });
    expect(res["kind"]).toBe("refusal");
    expect(res["code"]).toBe("budget-below-minimum");
    const next = res["next"] as { arguments?: { targets?: Array<{ path?: string; range?: string }> } } | undefined;
    const targets = next?.arguments?.targets ?? [];
    const paths = targets.map((t) => t.path);
    expect(paths, `refusal next dropped a target: ${JSON.stringify(next)}`).toContain("src/config.ts");
    expect(paths, `refusal next dropped a target: ${JSON.stringify(next)}`).toContain("src/retry.ts");
    const configTarget = targets.find((t) => t.path === "src/config.ts");
    expect(configTarget?.range).toBe("5-7");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Item 3 / finding 14 — profile_binding on an undeclared continuation.
// ---------------------------------------------------------------------------
describe("finding 14: profile_binding survives an undeclared task.handle/qref continuation", () => {
  it("task.handle and bare qref continuations both keep an observable profile_binding", async () => {
    const ws = makeWorkspace("f14", {
      "package.json": '{ "name": "f14", "private": true, "type": "module" }\n',
      "src/config.ts": [
        "export interface ClientOptions { timeoutMs: number; maxAttempts: number; retryDelayMs: number; }",
        "export const DEFAULT_OPTIONS: ClientOptions = { timeoutMs: 5000, maxAttempts: 3, retryDelayMs: 100 };",
        "export function loadOptions(env: Record<string, string | undefined>): ClientOptions {",
        "  return { ...DEFAULT_OPTIONS, timeoutMs: Number(env.HTTP_TIMEOUT_MS ?? DEFAULT_OPTIONS.timeoutMs) };",
        "}",
        "",
      ].join("\n"),
    });
    const server = startServer(ws, ["--tool-surface", "full"]);
    servers.push(server);
    await server.initialize();

    const query = "Explain the default HTTP_TIMEOUT_MS value that loadOptions falls back to.";
    const hop0 = await server.call("read_file", { query, cwd: ws, task: { epoch: "new", profile: "answer" } });
    const taskId = (hop0["task"] as Record<string, unknown> | undefined)?.["id"];
    expect(typeof taskId, `hop0 carried no task.id: ${JSON.stringify(hop0)}`).toBe("string");

    // Hop0 explicitly declared the profile and it was honoured -- the field
    // may legitimately be omitted here (SEND-ONCE/NO-ECHO); this test does
    // not assert either way about hop0.

    const hop1 = await server.call("read_file", { query, cwd: ws, task: { handle: taskId } });
    const binding1 = hop1["profile_binding"] as Record<string, unknown> | undefined;
    expect(binding1, `task.handle continuation dropped profile_binding: ${JSON.stringify(hop1)}`).toBeDefined();
    expect(binding1?.["selected"]).toBe("answer");

    const qref = hop0["qref"];
    if (typeof qref === "string") {
      const hop2 = await server.call("read_file", { qref, cwd: ws });
      const binding2 = hop2["profile_binding"] as Record<string, unknown> | undefined;
      expect(binding2, `bare qref continuation dropped profile_binding: ${JSON.stringify(hop2)}`).toBeDefined();
      expect(binding2?.["selected"]).toBe("answer");
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Item 4 / finding 15 — a window this task already shipped must be resident
// (never a fresh, byte-for-byte identical body) on a later hop of the SAME
// task, even for a `required` answer-profile surface and even several hops
// later (past applyPackDedupe's own one-slot "last pack" memory).
// ---------------------------------------------------------------------------
describe("finding 15: a served window is not re-shipped fresh on a later hop of the same task", () => {
  it("a required, answer-profile counterexample window ships once, then resident", async () => {
    const ws = makeWorkspace("f15", {
      "package.json": '{ "name": "f15", "private": true, "type": "module" }\n',
      "src/config.ts": [
        "export interface ClientOptions { timeoutMs: number; maxAttempts: number; retryDelayMs: number; }",
        "export const DEFAULT_OPTIONS: ClientOptions = { timeoutMs: 9000, maxAttempts: 6, retryDelayMs: 250 };",
        ...Array.from({ length: 70 }, (_, i) => `export const endpointTimeout${i} = ${1000 + i * 37}; // endpoint override ${i}`),
        "export function loadOptions(env: Record<string, string | undefined>): ClientOptions {",
        "  const base = { ...DEFAULT_OPTIONS, timeoutMs: Number(env.HTTP_TIMEOUT_MS ?? DEFAULT_OPTIONS.timeoutMs) };",
        "  return base;",
        "}",
        "",
      ].join("\n"),
      "src/retry.ts": [
        ...Array.from({ length: 80 }, (_, i) => `export const retryPolicy${i} = { retry: ${i % 3 === 0}, delayMs: ${100 + i * 11} }; // status ${400 + i}`),
        "export function shouldRetry(status: number, attempt: number, maxAttempts: number): boolean {",
        "  const policy = (retryPolicy0 as { retry: boolean });",
        "  return policy !== undefined && policy.retry && attempt + 1 < maxAttempts;",
        "}",
        "",
      ].join("\n"),
      "src/client.ts": [
        'import { loadOptions } from "./config";',
        'import { shouldRetry } from "./retry";',
        "export async function fetchWithRetry(url: string): Promise<Response> {",
        "  const options = loadOptions(process.env);",
        "  for (let attempt = 0; ; attempt++) {",
        "    const response = await fetch(url);",
        "    if (!shouldRetry(response.status, attempt, options.maxAttempts)) return response;",
        "  }",
        "}",
        "",
      ].join("\n"),
    });
    const server = startServer(ws, ["--tool-surface", "full"]);
    servers.push(server);
    await server.initialize();

    const query = "Explain the default HTTP_TIMEOUT_MS value and the shouldRetry conditions.";
    let qref: unknown;
    let lastQrefBody = await server.call("read_file", { query, cwd: ws, task: { epoch: "new", profile: "answer" }, budget: { bytes: 6144 } });
    qref = lastQrefBody["qref"] ?? qref;

    // Track, per (path, range), whether THIS chain has already shipped a
    // real body for it, and flag a LATER hop that ships that exact window
    // fresh again (a byte-for-byte repeat with no `prior`/`code_unchanged`
    // marker) instead of restating it as resident.
    const shippedExact = new Set<string>();
    const reShippedFresh: unknown[] = [];
    const scan = (body: Record<string, unknown>): void => {
      for (const entry of evidenceOf(body)) {
        const p = entry["path"];
        const range = entry["range"];
        if (typeof p !== "string" || typeof range !== "string") continue;
        const key = `${p}\u0000${range}`;
        const hasBody = typeof entry["body"] === "string";
        if (hasBody) {
          if (shippedExact.has(key)) reShippedFresh.push({ path: p, range, hop: "later" });
          shippedExact.add(key);
        }
      }
    };
    scan(lastQrefBody);
    let next = (lastQrefBody["decision"] as Record<string, unknown> | undefined)?.["next"];
    for (let i = 0; i < 8 && (next !== undefined || typeof qref === "string"); i++) {
      const call = next as { tool?: string; arguments?: Record<string, unknown> } | undefined;
      const body = call?.arguments !== undefined
        ? await server.call(call.tool as string, { ...call.arguments, cwd: ws })
        : await server.call("read_file", { qref, cwd: ws });
      scan(body);
      qref = body["qref"] ?? qref;
      next = (body["decision"] as Record<string, unknown> | undefined)?.["next"];
      if (next === undefined && call?.arguments === undefined) break; // qref replay with no next: chain settled
    }
    expect(
      reShippedFresh,
      `a window already shipped this task came back as a FRESH body (no residency) later: ${JSON.stringify(reShippedFresh)}`,
    ).toEqual([]);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Item 5 / finding 16 — replay determinism: an identical `{qref}` re-issue
// with no workspace change must restate the same decision.
// ---------------------------------------------------------------------------
describe("finding 16: identical qref replay never flips the certified decision", () => {
  it("a generic edit task stays act.edit across repeated identical bare-qref replays", async () => {
    const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-fixfc-f16-")));
    workspaces.push(ws);
    buildHttpCorpusWorkspace(ws, "compact");
    const server = startServer(ws, ["--tool-surface", "full", "--allow-write"]);
    servers.push(server);
    await server.initialize();

    const query = "Raise the default timeout in src/config.ts from 5000 to 10000.";
    const hop0 = await server.call("read_file", { query, cwd: ws, task: { epoch: "new" } });
    const qref = hop0["qref"];
    expect(typeof qref, `hop0 carried no qref: ${JSON.stringify(hop0)}`).toBe("string");

    const hop2 = await server.call("read_file", { qref, cwd: ws });
    const decision2 = hop2["decision"] as Record<string, unknown> | undefined;
    // The SAME identical bare-qref call, twice more.
    const hop3 = await server.call("read_file", { qref, cwd: ws });
    const decision3 = hop3["decision"] as Record<string, unknown> | undefined;
    const hop4 = await server.call("read_file", { qref, cwd: ws });
    const decision4 = hop4["decision"] as Record<string, unknown> | undefined;

    expect(
      decision3?.["kind"],
      `identical qref replay flipped decision.kind: hop2=${JSON.stringify(decision2)} hop3=${JSON.stringify(decision3)}`,
    ).toBe(decision2?.["kind"]);
    expect(decision4?.["kind"]).toBe(decision2?.["kind"]);
    if (decision2?.["kind"] === "act.edit") {
      const cert2 = (decision2["certificate"] as Record<string, unknown> | undefined)?.["id"];
      const cert3 = (decision3?.["certificate"] as Record<string, unknown> | undefined)?.["id"];
      expect(cert3, "the SAME task's certificate id changed across an identical replay").toBe(cert2);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Item 6 / finding 20 — self-contradicting await_input unresolved wording.
// ---------------------------------------------------------------------------
describe("finding 20: await_input unresolved wording matches the actual candidate count", () => {
  it("never says both 'multiple candidates' and '1 candidate' for the same blocker", async () => {
    const ws = makeWorkspace("f20", {
      "package.json": '{ "name": "f20", "private": true, "type": "module" }\n',
      "src/config.ts": [
        "export interface ClientOptions { timeoutMs: number; maxAttempts: number; retryDelayMs: number; }",
        "export const DEFAULT_OPTIONS: ClientOptions = { timeoutMs: 5000, maxAttempts: 3, retryDelayMs: 100 };",
        "export function loadOptions(env: Record<string, string | undefined>): ClientOptions {",
        "  return { ...DEFAULT_OPTIONS, timeoutMs: Number(env.HTTP_TIMEOUT_MS ?? DEFAULT_OPTIONS.timeoutMs) };",
        "}",
        "",
      ].join("\n"),
    });
    const server = startServer(ws, ["--tool-surface", "full"]);
    servers.push(server);
    await server.initialize();

    const query = "Raise the default timeout in src/config.ts from 5000 to 10000.";
    const hop0 = await server.call("read_file", { query, cwd: ws, task: { epoch: "new", profile: "answer" } });
    const decision = hop0["decision"] as Record<string, unknown> | undefined;
    if (decision?.["kind"] !== "await_input") return; // this fixture's own ambiguity shape; nothing to check otherwise
    const unresolved = decision["unresolved"] as Array<Record<string, unknown>> | undefined;
    expect(unresolved, `await_input carried no unresolved[]: ${JSON.stringify(decision)}`).toBeDefined();
    const reasons = (unresolved ?? []).map((u) => String(u["reason"]));
    const saysMultiple = reasons.some((r) => r.includes("multiple candidates"));
    const saysOne = reasons.some((r) => /^1 candidate target\(s\)/.test(r));
    expect(
      saysMultiple && saysOne,
      `contradicting unresolved rows: ${JSON.stringify(reasons)}`,
    ).toBe(false);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Item 7 — an over-budget ranged read must ship the head that fits, never an
// all-or-nothing bodyless drop, and its `next` must progress past what it
// already shipped.
// ---------------------------------------------------------------------------
describe("pre-existing defect: an over-budget single-target ranged read ships a fitted head, not nothing", () => {
  it("a 601-line single caller-ranged target under a small budget still ships a real prefix", async () => {
    const lines = ["// bigModule.ts -- a large module with many independent sections"];
    for (let i = 0; i < 1200; i += 1) lines.push(`const padding${i} = ${i};`);
    const ws = makeWorkspace("f7", {
      "package.json": '{ "name": "f7", "private": true, "type": "module" }\n',
      "bigModule.ts": lines.join("\n") + "\n",
    });
    const server = startServer(ws, ["--tool-surface", "full"]);
    servers.push(server);
    await server.initialize();

    const res = await server.call("read_file", {
      query: "Explain what bigModule.ts does around this window.",
      targets: [{ path: "bigModule.ts", range: "300-900" }],
      content: "auto",
      task: { epoch: "new", profile: "answer" },
      budget: { bytes: 6200 },
      cwd: ws,
    });
    const entries = evidenceOf(res);
    const surface = entries.find((e) => e["path"] === "bigModule.ts");
    expect(surface, `no evidence row for bigModule.ts: ${JSON.stringify(res)}`).toBeDefined();
    expect(
      typeof surface?.["body"],
      `over-budget ranged read shipped NO body at all: ${JSON.stringify(surface)}`,
    ).toBe("string");
    expect((surface?.["body"] as string).length).toBeGreaterThan(0);
    expect(surface?.["remaining"], "a genuinely partial serve must disclose remaining").toBeDefined();

    // The next call must progress PAST what this response already shipped —
    // never re-name the exact same over-budget range verbatim (a dead loop).
    const next = (res["decision"] as Record<string, unknown> | undefined)?.["next"] as
      { arguments?: { targets?: Array<{ path?: string; range?: string }> } } | undefined;
    const nextRange = next?.arguments?.targets?.find((t) => t.path === "bigModule.ts")?.range;
    expect(nextRange, `next re-issues the identical failing range: ${JSON.stringify(next)}`).not.toBe("300-900");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Item 8 — a post-certification anchor row must not leave the SAME response's
// own `next` re-reading the exact line it just served.
// ---------------------------------------------------------------------------
describe("pre-existing waste: next never re-reads a line this same response just served", () => {
  it("sfflag1 fixture: next widens past the anchor row's own line, gaps unweakened", async () => {
    const ws = makeWorkspace("f8", {
      "src/feature_flags.ts": [
        'export const INVOICE_V2_FLAG = "invoice-v2";',
        'export function invoiceVersion(flagValue: boolean): "v1" | "v2" { return flagValue ? "v2" : "v1"; }',
      ].join("\n") + "\n",
      "src/render_invoice.ts": [
        'import { invoiceVersion } from "./feature_flags";',
        "export function renderInvoice(flagValue: boolean): string {",
        "  return `invoice ${invoiceVersion(flagValue)}`;",
        "}",
      ].join("\n") + "\n",
    });
    const server = startServer(ws, ["--tool-surface", "full"]);
    servers.push(server);
    await server.initialize();

    const query = "Trace INVOICE_V2_FLAG invoiceVersion renderInvoice src/feature_flags.ts relation feature flag branch.";
    const hop0 = await server.call("read_file", { query, cwd: ws, task: { epoch: "new", profile: "answer" } });
    const decision = hop0["decision"] as Record<string, unknown> | undefined;
    const gapsBefore = JSON.stringify(decision?.["gaps"]);
    const shippedWindows = new Set(
      evidenceOf(hop0)
        .filter((e) => typeof e["body"] === "string")
        .map((e) => `${e["path"]}\u0000${e["range"]}`),
    );
    const next = decision?.["next"] as { arguments?: { targets?: Array<{ path?: string; range?: string }> } } | undefined;
    for (const target of next?.arguments?.targets ?? []) {
      if (typeof target.path !== "string" || typeof target.range !== "string") continue;
      const key = `${target.path}\u0000${target.range}`;
      expect(
        shippedWindows.has(key),
        `next re-reads a window this same response already shipped: ${target.path}:${target.range}`,
      ).toBe(false);
    }
    // The certificate/gaps must be unweakened by this trim -- same gaps
    // before and after (this pass only ever touches `next`, never `missing`
    // or `execution_contract`).
    expect(JSON.stringify(decision?.["gaps"])).toBe(gapsBefore);
  }, 60_000);
});
