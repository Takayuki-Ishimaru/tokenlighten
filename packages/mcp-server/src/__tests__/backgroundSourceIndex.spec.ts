/**
 * backgroundSourceIndex.spec.ts — features/indexing/sourceIndexAccess.ts: the
 * whole-workspace source index is built once per workspace at a time, and a
 * task pack's symbol lookups no longer block the first reply on that build.
 *
 * Pinned here:
 *   - a background lookup answers `warming` before the build completes, and
 *     the manifest once it has (TL_BACKGROUND_INDEX=on: no wait at all);
 *   - lookups that arrive while a build runs share it: one builder call;
 *   - a `wait` lookup joins the in-flight build instead of starting another;
 *   - a failed build leaves the request to proceed without symbols, is
 *     recorded, and is retried only after FAILED_RETRY_MS (a `wait` lookup
 *     retries at once and sees the failure);
 *   - `auto`: a small walked workspace waits for its build (so small fixtures
 *     keep their complete first pack, as does an unmeasured one), a large one waits at most the bounded
 *     budget; `off` is the legacy direct call and records nothing;
 *   - within one read request, background lookups reuse the first manifest;
 *   - the transport-close exit only ever fires while a build is in flight;
 *   - over the wire (a spawned server with an injected slow or failing
 *     builder): the first `tl_read_file` returns before the build completes
 *     with `task.coverage:"partial"` and `coverage_reason:"index-warming"`,
 *     two queued first calls start one build, an explicit symbol search waits
 *     for the index, the pack after readiness matches a server that built
 *     synchronously, a failing build still yields a reply, and closing stdin
 *     ends a process whose build is still running.
 */
import { describe, it, expect, afterEach, afterAll, vi } from "vitest";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { SourceIndexManifestV1 } from "@tokenlighten/skeleton-engine";

import {
  FAILED_RETRY_MS,
  exitAfterTransportCloseIfBuilding,
  noteWorkspaceWalkSize,
  obtainSourceIndex,
  prewarmSourceIndex,
  resetSourceIndexAccessForTest,
  setSourceIndexBuilderForTest,
  sourceIndexBuildInFlight,
  sourceIndexBuildsSettledForTest,
  sourceIndexStatus,
  sourceIndexWarmingForCurrentRequest,
  type SourceIndexBuildOptions,
} from "../features/indexing/sourceIndexAccess.js";
import { backgroundIndexMinFiles, backgroundIndexMode, backgroundIndexWaitMs } from "../util/flags.js";
import { runWithRequestSignal } from "../util/requestCancellation.js";
import { killServerGroup } from "./helpers/killServerGroup.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { makeSmallTaskWorkspace, startSmallTaskServer, type SmallTaskServer } from "./helpers/smallTaskServer.js";
import { TSX_NODE_ARGS } from "./helpers/tsxNode.js";

const FILES: Readonly<Record<string, string>> = {
  "src/math.ts": "export function add(a: number, b: number) {\n  return a + b;\n}\n\nexport function scale(n: number, factor: number) {\n  return n * factor;\n}\n",
  "src/retry.ts": "export const MAX_RETRIES = 3;\n\nexport function retryRequest(attempt: number): boolean {\n  return attempt < MAX_RETRIES;\n}\n",
  "README.md": "# fixture\n",
};
const QUERY = "What does the add function in src/math.ts return?";
const QUERY_2 = "Explain how retryRequest in src/retry.ts decides to retry.";
/** Never served before the readiness comparison on either server (no dedupe or prior-pack effects). */
const QUERY_3 = "What does the scale function in src/math.ts multiply by?";
const OPTS: SourceIndexBuildOptions = { ignoreHash: "", graphIndexMode: "off" };

const ENV_KEYS = ["TL_BACKGROUND_INDEX", "TL_BACKGROUND_INDEX_MIN_FILES", "TL_BACKGROUND_INDEX_WAIT_MS", "TL_STARTUP_WARMUP"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  await sourceIndexBuildsSettledForTest();
  resetSourceIndexAccessForTest();
  vi.useRealTimers();
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
afterAll(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function fakeManifest(tag: string): SourceIndexManifestV1 {
  return {
    version: 1, engineVersion: "spec", repoRootRealpath: "", ignoreHash: "", builtFromCommit: "spec",
    rootHash: tag, generation: 1, files: {}, directories: {},
  } as unknown as SourceIndexManifestV1;
}

/** A builder the test settles by hand; counts its calls. */
function deferredBuilder() {
  let calls = 0;
  let settle: { resolve: (m: SourceIndexManifestV1) => void; reject: (e: Error) => void } | undefined;
  const pending = new Promise<SourceIndexManifestV1>((resolve, reject) => { settle = { resolve, reject }; });
  const builder = async (): Promise<{ manifest: SourceIndexManifestV1 }> => {
    calls += 1;
    return { manifest: await pending };
  };
  return {
    builder,
    calls: () => calls,
    resolve: (tag = "built") => settle!.resolve(fakeManifest(tag)),
    reject: (message = "boom") => settle!.reject(new Error(message)),
  };
}

function tempWorkspace(): string {
  const ws = makeSmallTaskWorkspace("tl-bg-index-", FILES);
  cleanups.push(() => rmDirWithRetry(ws));
  return ws;
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("sourceIndexAccess (in-process)", () => {
  it("on: a background lookup returns warming before the build completes, and the manifest after", async () => {
    process.env["TL_BACKGROUND_INDEX"] = "on";
    const ws = tempWorkspace();
    const build = deferredBuilder();
    setSourceIndexBuilderForTest(build.builder);

    const first = await obtainSourceIndex(ws, OPTS, "background");
    expect(first.warming).toBe(true);
    expect(first.manifest).toBeUndefined();
    expect(sourceIndexStatus(ws)).toMatchObject({ state: "building", builds: 1 });
    expect(sourceIndexBuildInFlight()).toBe(true);

    build.resolve("v1");
    await sourceIndexBuildsSettledForTest();
    expect(sourceIndexStatus(ws)).toMatchObject({ state: "ready", builds: 1 });
    expect(sourceIndexBuildInFlight()).toBe(false);

    // Ready: the lookup goes to the builder (skeleton-engine's memo in production).
    let refreshed = 0;
    setSourceIndexBuilderForTest(async () => { refreshed += 1; return { manifest: fakeManifest("v2") }; });
    const after = await obtainSourceIndex(ws, OPTS, "background");
    expect(after.warming).toBeUndefined();
    expect(after.manifest?.rootHash).toBe("v2");
    expect(refreshed).toBe(1);
    expect(sourceIndexStatus(ws).builds).toBe(1);
  });

  it("concurrent background lookups share one build; a wait lookup joins it", async () => {
    process.env["TL_BACKGROUND_INDEX"] = "on";
    const ws = tempWorkspace();
    const build = deferredBuilder();
    setSourceIndexBuilderForTest(build.builder);

    const [a, b] = await Promise.all([
      obtainSourceIndex(ws, OPTS, "background"),
      obtainSourceIndex(ws, OPTS, "background"),
    ]);
    expect(a.warming).toBe(true);
    expect(b.warming).toBe(true);
    expect(build.calls()).toBe(1);

    let waited: Awaited<ReturnType<typeof obtainSourceIndex>> | undefined;
    const waiting = obtainSourceIndex(ws, OPTS, "wait").then((outcome) => { waited = outcome; });
    await tick();
    expect(waited).toBeUndefined(); // still blocked on the shared build
    build.resolve("shared");
    await waiting;
    expect(waited?.manifest?.rootHash).toBe("shared");
    expect(build.calls()).toBe(1);
    expect(sourceIndexStatus(ws).builds).toBe(1);
  });

  it("a failed build: the background lookup proceeds without symbols, the failure is recorded, and a retry waits FAILED_RETRY_MS", async () => {
    process.env["TL_BACKGROUND_INDEX"] = "on";
    const ws = tempWorkspace();
    const build = deferredBuilder();
    setSourceIndexBuilderForTest(build.builder);

    expect((await obtainSourceIndex(ws, OPTS, "background")).warming).toBe(true);
    build.reject("disk on fire");
    await sourceIndexBuildsSettledForTest();
    expect(sourceIndexStatus(ws)).toMatchObject({ state: "failed", builds: 1, failure: "disk on fire" });

    // Within the retry window: no new build, still warming.
    const second = deferredBuilder();
    setSourceIndexBuilderForTest(second.builder);
    const again = await obtainSourceIndex(ws, OPTS, "background");
    expect(again).toMatchObject({ warming: true, state: "failed" });
    expect(second.calls()).toBe(0);

    // A wait lookup retries at once and sees the failure, as the direct call did.
    const failing = deferredBuilder();
    setSourceIndexBuilderForTest(failing.builder);
    const waiting = obtainSourceIndex(ws, OPTS, "wait");
    await tick();
    failing.reject("still on fire");
    await expect(waiting).rejects.toThrow("still on fire");
    expect(failing.calls()).toBe(1);
    expect(sourceIndexStatus(ws)).toMatchObject({ state: "failed", builds: 2 });

    // After the window a background lookup retries.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + FAILED_RETRY_MS + 1);
    const retry = deferredBuilder();
    setSourceIndexBuilderForTest(retry.builder);
    expect((await obtainSourceIndex(ws, OPTS, "background")).warming).toBe(true);
    expect(retry.calls()).toBe(1);
    retry.resolve("recovered");
    await sourceIndexBuildsSettledForTest();
    expect(sourceIndexStatus(ws)).toMatchObject({ state: "ready", builds: 3 });
  });

  it("auto: a small walked workspace waits for its build; a large one waits only the bounded budget", async () => {
    delete process.env["TL_BACKGROUND_INDEX"];
    process.env["TL_BACKGROUND_INDEX_MIN_FILES"] = "400";
    process.env["TL_BACKGROUND_INDEX_WAIT_MS"] = "40";
    const small = tempWorkspace();
    const large = tempWorkspace();

    setSourceIndexBuilderForTest(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return { manifest: fakeManifest("slow") };
    });
    noteWorkspaceWalkSize(small, 12);
    const outcome = await obtainSourceIndex(small, OPTS, "background");
    expect(outcome.manifest?.rootHash).toBe("slow"); // waited past the 40 ms budget: small workspaces complete
    expect(sourceIndexStatus(small).state).toBe("ready");

    noteWorkspaceWalkSize(large, 5_000);
    const bounded = await obtainSourceIndex(large, OPTS, "background");
    expect(bounded).toMatchObject({ warming: true, state: "building" });
    await sourceIndexBuildsSettledForTest();
    expect(sourceIndexStatus(large).state).toBe("ready");

    // Unmeasured (no walk size): waits like a small one, so load alone never cuts symbols.
    const unknown = tempWorkspace();
    expect((await obtainSourceIndex(unknown, OPTS, "background")).manifest?.rootHash).toBe("slow");
  });

  it("auto with every knob unset or blank: the defaults are 400 files and 1500 ms, never 0 (a small workspace still waits)", async () => {
    for (const blank of [undefined, "", " "]) {
      for (const key of ENV_KEYS) {
        if (blank === undefined) delete process.env[key];
        else process.env[key] = blank;
      }
      expect(backgroundIndexMode()).toBe("auto");
      expect(backgroundIndexMinFiles()).toBe(400);
      expect(backgroundIndexWaitMs()).toBe(1500);
    }
    for (const key of ENV_KEYS) delete process.env[key];
    process.env["TL_BACKGROUND_INDEX_MIN_FILES"] = "0";
    process.env["TL_BACKGROUND_INDEX_WAIT_MS"] = "0";
    expect(backgroundIndexMinFiles()).toBe(0); // an explicit 0 stays 0
    expect(backgroundIndexWaitMs()).toBe(0);
    for (const key of ENV_KEYS) delete process.env[key];

    // The 2026-11-02 regression: an unset TL_BACKGROUND_INDEX_MIN_FILES read as
    // 0, so an 18-file workspace took a 0 ms wait and answered "index-warming".
    const small = tempWorkspace();
    setSourceIndexBuilderForTest(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { manifest: fakeManifest("default-wait") };
    });
    noteWorkspaceWalkSize(small, 18);
    await runWithRequestSignal(new AbortController().signal, async () => {
      const outcome = await obtainSourceIndex(small, OPTS, "background");
      expect(outcome.manifest?.rootHash).toBe("default-wait");
      expect(sourceIndexWarmingForCurrentRequest()).toBe(false);
    });
  });

  it("prewarm: starts a repository root's build once, and never a non-repository, the home directory, or with TL_BACKGROUND_INDEX=off or TL_STARTUP_WARMUP=0", async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const build = deferredBuilder();
    setSourceIndexBuilderForTest(build.builder);

    const plain = tempWorkspace();
    expect(prewarmSourceIndex(plain, OPTS)).toBe(false);
    expect(sourceIndexStatus(plain).state).toBe("idle");
    expect(prewarmSourceIndex(os.homedir(), OPTS)).toBe(false);

    const repo = tempWorkspace();
    fs.mkdirSync(path.join(repo, ".git"));
    process.env["TL_BACKGROUND_INDEX"] = "off";
    expect(prewarmSourceIndex(repo, OPTS)).toBe(false);
    process.env["TL_BACKGROUND_INDEX"] = "auto";
    process.env["TL_STARTUP_WARMUP"] = "0";
    expect(prewarmSourceIndex(repo, OPTS)).toBe(false);
    delete process.env["TL_STARTUP_WARMUP"];
    expect(build.calls()).toBe(0);

    expect(prewarmSourceIndex(repo, OPTS)).toBe(true);
    expect(prewarmSourceIndex(repo, OPTS)).toBe(false); // already building: still one build
    expect(sourceIndexStatus(repo)).toMatchObject({ state: "building", builds: 1 });
    // A lookup that arrives meanwhile joins the prewarm's build.
    const lookup = obtainSourceIndex(repo, OPTS, "wait");
    build.resolve("prewarmed");
    expect((await lookup).manifest?.rootHash).toBe("prewarmed");
    expect(build.calls()).toBe(1);
  });

  it("off: the legacy direct call builds the real index and records no state", async () => {
    process.env["TL_BACKGROUND_INDEX"] = "off";
    const ws = tempWorkspace();
    const build = deferredBuilder();
    setSourceIndexBuilderForTest(build.builder); // must not be consulted
    const outcome = await obtainSourceIndex(ws, OPTS, "background");
    expect(outcome.warming).toBeUndefined();
    expect(Object.keys(outcome.manifest?.files ?? {})).toContain("src/math.ts");
    expect(build.calls()).toBe(0);
    expect(sourceIndexStatus(ws)).toMatchObject({ state: "idle", builds: 0 });
  });

  it("within one read request, background lookups reuse the first manifest; the warming mark is per request", async () => {
    process.env["TL_BACKGROUND_INDEX"] = "on";
    const ws = tempWorkspace();
    let calls = 0;
    setSourceIndexBuilderForTest(async () => { calls += 1; return { manifest: fakeManifest(`m${calls}`) }; });

    // First request: finds the index warming.
    const warmingRequest = new AbortController();
    await runWithRequestSignal(warmingRequest.signal, async () => {
      expect((await obtainSourceIndex(ws, OPTS, "background")).warming).toBe(true);
      expect(sourceIndexWarmingForCurrentRequest()).toBe(true);
    });
    await sourceIndexBuildsSettledForTest();
    expect(calls).toBe(1);

    // Second request, index ready: one refresh, then the memo.
    const readRequest = new AbortController();
    await runWithRequestSignal(readRequest.signal, async () => {
      expect(sourceIndexWarmingForCurrentRequest()).toBe(false);
      const a = await obtainSourceIndex(ws, OPTS, "background");
      const b = await obtainSourceIndex(ws, OPTS, "background");
      expect(a.manifest?.rootHash).toBe("m2");
      expect(b.manifest).toBe(a.manifest);
      // A wait lookup (an edit path) never reads the per-request memo.
      const c = await obtainSourceIndex(ws, OPTS, "wait");
      expect(c.manifest?.rootHash).toBe("m3");
    });
    expect(calls).toBe(3);
    // Outside any request, with nothing building, nothing is warming.
    expect(sourceIndexWarmingForCurrentRequest()).toBe(false);
  });

  it("the transport-close exit fires only while a build is in flight, once, after the flush", async () => {
    process.env["TL_BACKGROUND_INDEX"] = "on";
    const ws = tempWorkspace();
    const exits: string[] = [];
    expect(exitAfterTransportCloseIfBuilding(() => exits.push("flush-idle"), () => exits.push("exit-idle"))).toBe(false);
    expect(exits).toEqual([]);

    const build = deferredBuilder();
    setSourceIndexBuilderForTest(build.builder);
    await obtainSourceIndex(ws, OPTS, "background");
    let flushed: (() => void) | undefined;
    expect(exitAfterTransportCloseIfBuilding((exit) => { flushed = exit; }, () => exits.push("exit"))).toBe(true);
    expect(exits).toEqual([]); // nothing until the output flushed
    flushed!();
    flushed!();
    expect(exits).toEqual(["exit"]);
    build.resolve();
  });
});

// ---------------------------------------------------------------------------
// Over the wire: a spawned server with the default builder shaped by the
// TL_TEST_INDEX_BUILD_* seams.
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_TS = path.resolve(HERE, "..", "bin.ts");

type Body = Record<string, unknown>;
const taskOf = (body: Body): Record<string, unknown> => (body["task"] ?? {}) as Record<string, unknown>;
const readArgs = (cwd: string, query: string): Record<string, unknown> => ({ cwd, query, task: { epoch: "new" } });

/** The parts of a pack that do not depend on session-minted handles or ids. */
function stablePack(body: Body): unknown {
  const evidence = Array.isArray(body["evidence"]) ? body["evidence"] as Array<Record<string, unknown>> : [];
  return {
    kind: body["kind"],
    decision: (body["decision"] as Record<string, unknown> | undefined)?.["kind"],
    coverage: taskOf(body)["coverage"],
    evidence: evidence.map((row) => [row["path"], row["range"], row["body"]]),
  };
}

function traceEvents(home: string, event: string): Array<Record<string, unknown>> {
  const dir = path.join(home, ".tokenlighten", "trace");
  if (!fs.existsSync(dir)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".jsonl")) continue;
    for (const line of fs.readFileSync(path.join(dir, file), "utf8").split("\n")) {
      if (!line.includes(`"${event}"`)) continue;
      try { out.push(JSON.parse(line) as Record<string, unknown>); } catch { /* partial line */ }
    }
  }
  return out;
}

describe("sourceIndexAccess (spawned server)", () => {
  const servers: SmallTaskServer[] = [];
  afterAll(async () => {
    for (const server of servers.splice(0)) {
      await server.kill();
      await rmDirWithRetry(server.home);
    }
  });

  async function start(ws: string, env: Record<string, string>): Promise<SmallTaskServer> {
    const server = await startSmallTaskServer(ws, { env: { TL_TRACE: "1", ...env } });
    servers.push(server);
    return server;
  }

  it("the first read returns before a slow build completes and discloses index-warming; two queued first calls start one build; a symbol search waits; the pack after readiness matches a synchronous build", async () => {
    const ws = tempWorkspace();
    const control = await start(ws, { TL_BACKGROUND_INDEX: "off" });
    const slow = await start(ws, { TL_BACKGROUND_INDEX: "on", TL_TEST_INDEX_BUILD_DELAY_MS: "6000" });

    const started = performance.now();
    const [first, second] = await Promise.all([
      slow.call("tl_read_file", readArgs(ws, QUERY)),
      slow.call("tl_read_file", readArgs(ws, QUERY_2)),
    ]);
    const elapsed = performance.now() - started;
    expect(first.isError).toBe(false);
    expect(second.isError).toBe(false);
    expect(elapsed).toBeLessThan(6000); // neither reply waited for the 6 s build
    for (const reply of [first, second]) {
      expect(reply.body["kind"]).toBe("read.task_pack");
      expect(taskOf(reply.body)["coverage"]).toBe("partial");
      expect(taskOf(reply.body)["coverage_reason"]).toBe("index-warming");
      // Served from text search: the named file still arrives.
      expect(JSON.stringify(reply.body)).toContain("src/");
    }
    const starts = traceEvents(slow.home, "source_index_build").filter((e) => (e["phase"] ?? (e["payload"] as Record<string, unknown> | undefined)?.["phase"]) === "start");
    expect(starts.length).toBe(1);

    // An explicit symbol search waits for the index (it completes once the build does).
    const symbols = await slow.call("tl_search_files", { cwd: ws, action: "symbols", query: "add", queries: ["add"] }, 60_000);
    expect(symbols.isError).toBe(false);
    expect(JSON.stringify(symbols.body)).toContain("src/math.ts");
    const readies = traceEvents(slow.home, "source_index_build").filter((e) => (e["phase"] ?? (e["payload"] as Record<string, unknown> | undefined)?.["phase"]) === "ready");
    expect(readies.length).toBe(1);

    // After readiness: no warming disclosure, and the same pack a synchronous build serves.
    const after = await slow.call("tl_read_file", readArgs(ws, QUERY_3));
    expect(taskOf(after.body)["coverage_reason"]).not.toBe("index-warming");
    const sync = await control.call("tl_read_file", readArgs(ws, QUERY_3));
    expect(taskOf(sync.body)["coverage_reason"]).not.toBe("index-warming");
    expect(stablePack(after.body)).toEqual(stablePack(sync.body));
  }, 120_000);

  it("prewarm: a repository root's index starts building at the handshake, before any tool call, and the first read reuses that build", async () => {
    const ws = tempWorkspace();
    fs.mkdirSync(path.join(ws, ".git"));
    const server = await start(ws, {}); // inherited TL_* stripped: auto, warm-up on
    const phases = (): unknown[] => traceEvents(server.home, "source_index_build")
      .map((e) => e["phase"] ?? (e["payload"] as Record<string, unknown> | undefined)?.["phase"]);
    const deadline = Date.now() + 30_000;
    while (!phases().includes("ready") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(phases()).toEqual(["start", "ready"]); // built with no tools/call sent

    const first = await server.call("tl_read_file", readArgs(ws, QUERY));
    expect(first.isError).toBe(false);
    expect(taskOf(first.body)["coverage_reason"]).not.toBe("index-warming");
    expect(phases().filter((phase) => phase === "start")).toHaveLength(1);
  }, 60_000);

  it("a failing build still yields a reply from text search; the explicit symbol search reports the failure; the server lives on", async () => {
    const ws = tempWorkspace();
    const server = await start(ws, { TL_BACKGROUND_INDEX: "on", TL_TEST_INDEX_BUILD_FAIL: "1" });
    const first = await server.call("tl_read_file", readArgs(ws, QUERY));
    expect(first.isError).toBe(false);
    expect(taskOf(first.body)["coverage"]).toBe("partial");
    expect(taskOf(first.body)["coverage_reason"]).toBe("index-warming");
    expect(JSON.stringify(first.body)).toContain("src/math.ts");

    // A `wait` lookup retries the build at once and surfaces its failure the way
    // the direct call always did: the tool throws, and the stdio transport
    // answers a JSON-RPC error (-32603) rather than a result.
    const symbols = await server.rpc("tools/call", { name: "tl_search_files", arguments: { cwd: ws, action: "symbols", query: "add", queries: ["add"] } });
    const symbolsResult = symbols["result"] as Record<string, unknown> | undefined;
    expect(symbols["error"] !== undefined || symbolsResult?.["isError"] === true).toBe(true);

    const again = await server.call("tl_read_file", readArgs(ws, QUERY_2));
    expect(again.isError).toBe(false);
    expect(again.body["kind"]).toBe("read.task_pack");
  }, 60_000);

  it("closing stdin ends a process whose build is still running", async () => {
    const ws = tempWorkspace();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tl-bg-index-home-"));
    cleanups.push(() => rmDirWithRetry(home));
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("TL_")) env[key] = value;
    Object.assign(env, { HOME: home, USERPROFILE: home, TL_BACKGROUND_INDEX: "on", TL_TEST_INDEX_BUILD_DELAY_MS: "30000" });
    const child = spawn(process.execPath, [...TSX_NODE_ARGS, BIN_TS, ws], {
      cwd: ws, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", env,
    });
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    let stdout = "";
    const replies: Body[] = [];
    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      let nl: number;
      while ((nl = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, nl); stdout = stdout.slice(nl + 1);
        try { replies.push(JSON.parse(line) as Body); } catch { /* noise */ }
      }
    });
    const send = (msg: Body): void => { child.stdin!.write(`${JSON.stringify(msg)}\n`); };
    const reply = (id: number, timeoutMs: number): Promise<Body> => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no reply ${id}`)), timeoutMs);
      const poll = (): void => {
        const found = replies.find((r) => r["id"] === id);
        if (found) { clearTimeout(timer); resolve(found); } else setTimeout(poll, 20);
      };
      poll();
    });
    try {
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "vitest", version: "0" } } });
      await reply(1, 30_000);
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tl_read_file", arguments: readArgs(ws, QUERY) } });
      const first = await reply(2, 30_000);
      const text = String(((first["result"] as Body)["content"] as Array<Body>)[0]?.["text"] ?? "");
      expect(taskOf(JSON.parse(text) as Body)["coverage_reason"]).toBe("index-warming");

      const closedAt = performance.now();
      child.stdin!.end();
      const code = await Promise.race([exited, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 15_000))]);
      expect(code).not.toBe("timeout"); // the 30 s build did not keep the process alive
      expect(performance.now() - closedAt).toBeLessThan(15_000);
    } finally {
      if (child.exitCode === null && child.signalCode === null) await killServerGroup(child);
    }
  }, 90_000);
});
