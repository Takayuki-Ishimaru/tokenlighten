// answerLineGutter.spec.ts — regression coverage for TL_ANSWER_LINE_GUTTER
// (WP-S4, 2026-09-20).
//
// DEFECT UNDER TEST (measured 2026-09-19, recorded GitHub Copilot sessions):
// TL evidence carries a `range` (e.g. "256-308") plus a body whose multi-line
// doc comments are collapsed by `elideDocCommentsWithWindows`
// (util/formatCompress.ts) into a single marker line naming the elided span,
// so a statement's true source line cannot be counted off the wire — a method
// starting at file line 274 is unreachable by counting from a body that opens
// at line 256. The model issued serial `tl_search_files find` calls on exact
// code text purely to learn line numbers. This flag numbers each line of an
// eligible served body with its true source line instead.
//
// THE POLICY IS DEFAULT OFF (USER ruling 2026-09-20: the Claude Code paired
// bench must not move against v0.14.0). It is switched on per host by
// `tl workspace setup` through the TL_TURN_ECONOMY umbrella, or per policy by
// an explicit TL_ANSWER_LINE_GUTTER value.
//
// Every fixture is generated into `os.tmpdir()` by this file; no bench
// fixture, corpus, or session path is read. Each test gets its OWN workspace
// on purpose (same reason seededGenerousPack.spec.ts documents: the pack's
// cross-call body dedupe is keyed by workspace).
//
// The seam under test (protocol/envelope.ts's `finalizeProtocolResponse`,
// immediately before `emit.ts`'s `emitFinalizedPayload`) only runs on the
// real wire funnel, so every case here goes through a REAL spawned server —
// an in-process call to `buildTaskPack`/`readCodeTaskPack` would bypass it
// entirely.

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { waitForExit } from "./helpers/rmDirWithRetry.js";

import { applyAnswerLineGutter, stripAnswerLineGutter } from "../protocol/lineGutter.js";
import { killServerGroup } from "./helpers/killServerGroup.js";

const FLAG = "TL_ANSWER_LINE_GUTTER";
const UMBRELLA = "TL_TURN_ECONOMY";

// ---------------------------------------------------------------------------
// Fixture — a Java class with one long Javadoc block (lines 10-17) ahead of
// the `cancel` method (line 18), the exact shape the motivating incident
// describes: a method whose true line is unreachable by counting from a body
// that opens well before its own doc comment.
// ---------------------------------------------------------------------------

const JAVA_LINES = [
  /* 1  */ "package com.example.billing;",
  /* 2  */ "",
  /* 3  */ "public class OrderService {",
  /* 4  */ "  private final Repo repo;",
  /* 5  */ "",
  /* 6  */ "  public OrderService(Repo repo) {",
  /* 7  */ "    this.repo = repo;",
  /* 8  */ "  }",
  /* 9  */ "",
  /* 10 */ "  /**",
  /* 11 */ "   * Cancels an existing order and issues a refund if payment was captured.",
  /* 12 */ "   * This is a deliberately long doc comment so the renderer's elision",
  /* 13 */ "   * marker spans several source lines, exactly like the reproduction this",
  /* 14 */ "   * flag exists to fix.",
  /* 15 */ "   * @param id the order identifier",
  /* 16 */ "   * @return the resulting order status",
  /* 17 */ "   */",
  /* 18 */ "  public OrderResponse cancel(long id) {",
  /* 19 */ "    OrderResponse response = repo.find(id);",
  /* 20 */ "    response.setStatus(\"CANCELLED\");",
  /* 21 */ "    return response;",
  /* 22 */ "  }",
  /* 23 */ "",
  /* 24 */ "  public OrderResponse refund(long id) {",
  /* 25 */ "    OrderResponse response = repo.find(id);",
  /* 26 */ "    response.setStatus(\"REFUNDED\");",
  /* 27 */ "    return response;",
  /* 28 */ "  }",
  /* 29 */ "}",
];
const JAVA_FILE = JAVA_LINES.join("\n") + "\n";
const JAVA_TOTAL_LINES = JAVA_LINES.length;

const MARKDOWN_FILE = [
  "# Billing overview",
  "",
  "OrderService cancels and refunds orders. See `cancel` and `refund`.",
  "",
].join("\n");

const QUERY = "Explain how OrderService cancels and refunds an order";

const workspaces: string[] = [];

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tl-answer-line-gutter-"));
  workspaces.push(root);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "OrderService.java"), JAVA_FILE, "utf8");
  fs.writeFileSync(path.join(root, "README.md"), MARKDOWN_FILE, "utf8");
  return root;
}

afterEach(async () => {
  delete process.env[FLAG];
  delete process.env[UMBRELLA];
  for (const root of workspaces.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  // Every server here is started inside one test (`taskPackCall`'s own
  // startServer call, or the two direct call sites below, never reused
  // across tests); stop it now so the file's 9 tests never hold all their
  // servers alive at once.
  for (const server of spawnedServers.splice(0)) await server.kill();
});

// ---------------------------------------------------------------------------
// Spawned-stdio harness, trimmed from seededGenerousPack.spec.ts (itself
// trimmed from rangedBatchNextPreservation.spec.ts).
// ---------------------------------------------------------------------------

const nodeRequire = createRequire(import.meta.url);
const TSX_CLI = nodeRequire.resolve("tsx/cli");
const BIN_TS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin.ts");

interface ServerHandle {
  initialize(): Promise<void>;
  call(name: string, args: Record<string, unknown>): Promise<{ body: Record<string, unknown>; bytes: number }>;
  kill(): Promise<void>;
}

const spawnedServers: ServerHandle[] = [];

function startServer(cwd: string, env: Record<string, string>): ServerHandle {
  const child: ChildProcess = spawn(process.execPath, [TSX_CLI, "--liftoff-only", BIN_TS, cwd], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32",
    env: { ...process.env, ...env },
  });
  let stdoutBuf = "";
  let stderr = "";
  const waiters = new Map<number, (msg: Record<string, unknown>) => void>();
  child.stdout!.on("data", (d: Buffer) => {
    stdoutBuf += d.toString();
    let nl: number;
    while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const id = msg["id"];
      if (typeof id === "number" && waiters.has(id)) {
        const waiter = waiters.get(id)!;
        waiters.delete(id);
        waiter(msg);
      }
    }
  });
  child.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });

  let nextId = 1;
  function rpc(method: string, params?: unknown, timeoutMs = 30000): Promise<Record<string, unknown>> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`rpc '${method}' timed out\n--- stderr ---\n${stderr}`));
      }, timeoutMs);
      waiters.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  return {
    async initialize() {
      await rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "vitest-answer-line-gutter", version: "0" },
      });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    },
    async call(name, args) {
      const res = await rpc("tools/call", { name, arguments: args }) as
        { result?: { content?: Array<{ text?: string }> } };
      const text = res.result?.content?.[0]?.text;
      expect(typeof text, `tool ${name} returned no text: ${JSON.stringify(res).slice(0, 400)}`).toBe("string");
      return { body: JSON.parse(text!) as Record<string, unknown>, bytes: Buffer.byteLength(text!, "utf8") };
    },
    async kill() {
      try { killServerGroup(child); } catch { /* already gone */ }
      await waitForExit(child);
    },
  };
}

afterAll(async () => {
  for (const server of spawnedServers.splice(0)) await server.kill();
});

function evidenceOf(body: Record<string, unknown>): Array<Record<string, unknown>> {
  return (Array.isArray(body["evidence"]) ? body["evidence"] : []) as Array<Record<string, unknown>>;
}

function entriesOf(body: Record<string, unknown>): Array<Record<string, unknown>> {
  return (Array.isArray(body["entries"]) ? body["entries"] : []) as Array<Record<string, unknown>>;
}

function findRow(body: Record<string, unknown>, relPath: string): Record<string, unknown> | undefined {
  return evidenceOf(body).find((row) => row["path"] === relPath)
    ?? entriesOf(body).find((row) => row["path"] === relPath);
}

/** Text of a row, whichever field family it arrived under (`body` or `content`). */
function textOf(row: Record<string, unknown>): string {
  return String(row["body"] ?? row["content"] ?? "");
}

async function taskPackCall(
  root: string,
  env: Record<string, string>,
  profile: "answer" | "generic",
  targets: Array<Record<string, unknown>>,
): Promise<{ body: Record<string, unknown>; bytes: number }> {
  const server = startServer(root, env);
  spawnedServers.push(server);
  await server.initialize();
  return server.call("tl_read_file", {
    cwd: root,
    query: QUERY,
    targets,
    task: { epoch: "new", profile },
  });
}

describe("TL_ANSWER_LINE_GUTTER — answer-profile task_pack", () => {
  it("flag unset: the served body carries no gutter", async () => {
    const root = makeWorkspace();
    const { body } = await taskPackCall(root, {}, "answer", [{ path: "src/OrderService.java" }]);
    expect(body["kind"]).toBe("read.task_pack");
    const row = findRow(body, "src/OrderService.java");
    expect(row).toBeDefined();
    const served = textOf(row!);
    expect(served).not.toMatch(/^\d+\|/m);
    expect(stripAnswerLineGutter(served)).toBe(served);
  }, 60000);

  it("ON + answer profile: every line is numbered, the doc-comment marker carries its FIRST source line, and the following line is the true source line", async () => {
    const root = makeWorkspace();
    const { body } = await taskPackCall(root, { [FLAG]: "1" }, "answer", [{ path: "src/OrderService.java" }]);
    const row = findRow(body, "src/OrderService.java");
    expect(row).toBeDefined();
    expect(row!["range"]).toBe(`1-${JAVA_TOTAL_LINES}`);

    const served = textOf(row!);
    const lines = served.split("\n").filter((_, i, arr) => !(i === arr.length - 1 && arr[i] === ""));
    expect(lines[0]).toBe("1|package com.example.billing;");

    const markerIndex = lines.findIndex((l) => l.includes("doc elided"));
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    expect(lines[markerIndex]).toMatch(/^10\|\s*\/\* doc elided L10-17 \*\/$/);
    expect(lines[markerIndex + 1]).toMatch(/^18\|.*public OrderResponse cancel\(long id\) \{/);

    // Stripping the gutter recovers exactly the flag-off body (the SAME
    // renderer, just with a `<n>|` prefix per line) — proves numbering never
    // touches anything but the prefix.
    const offRoot = makeWorkspace();
    const { body: offBody } = await taskPackCall(offRoot, {}, "answer", [{ path: "src/OrderService.java" }]);
    const offRow = findRow(offBody, "src/OrderService.java");
    expect(stripAnswerLineGutter(served)).toBe(textOf(offRow!));
  }, 60000);

  it("ON + generic profile: un-numbered (bodies must stay copy-exact for tl_edit_file)", async () => {
    const root = makeWorkspace();
    const { body } = await taskPackCall(root, { [FLAG]: "1" }, "generic", [{ path: "src/OrderService.java" }]);
    const row = findRow(body, "src/OrderService.java");
    expect(row).toBeDefined();
    expect(textOf(row!)).not.toMatch(/^\d+\|/m);
  }, 60000);

  it("TL_TURN_ECONOMY=1 alone (umbrella, no explicit member override): numbered", async () => {
    const root = makeWorkspace();
    const { body } = await taskPackCall(root, { [UMBRELLA]: "1" }, "answer", [{ path: "src/OrderService.java" }]);
    const row = findRow(body, "src/OrderService.java");
    expect(row).toBeDefined();
    expect(textOf(row!).split("\n")[0]).toBe("1|package com.example.billing;");
  }, 60000);

  it("TL_TURN_ECONOMY=1 with an explicit TL_ANSWER_LINE_GUTTER=0 keeps it off — the member override wins", async () => {
    const root = makeWorkspace();
    const { body } = await taskPackCall(root, { [UMBRELLA]: "1", [FLAG]: "0" }, "answer", [{ path: "src/OrderService.java" }]);
    const row = findRow(body, "src/OrderService.java");
    expect(row).toBeDefined();
    expect(textOf(row!)).not.toMatch(/^\d+\|/m);
  }, 60000);

  it("ON: a Markdown evidence body is left un-numbered", async () => {
    const root = makeWorkspace();
    const { body } = await taskPackCall(root, { [FLAG]: "1" }, "answer", [{ path: "README.md" }]);
    const row = findRow(body, "README.md");
    expect(row).toBeDefined();
    expect(textOf(row!)).not.toMatch(/^\d+\|/m);
  }, 60000);

  it("ON: a ranged read.text whose OWN call declares an answer task is numbered from the range's true start line", async () => {
    const root = makeWorkspace();
    const server = startServer(root, { [FLAG]: "1" });
    spawnedServers.push(server);
    await server.initialize();
    const { body } = await server.call("tl_read_file", {
      cwd: root,
      targets: [{ path: "src/OrderService.java", range: "18-22" }],
      task: { epoch: "new", profile: "answer" },
    });
    const row = findRow(body, "src/OrderService.java");
    expect(row).toBeDefined();
    const lines = textOf(row!).split("\n").filter((l) => l !== "");
    expect(lines[0]).toMatch(/^18\|.*public OrderResponse cancel\(long id\) \{/);
    expect(lines[1]).toMatch(/^19\|/);
    expect(lines[lines.length - 1]).toMatch(/^22\|/);
  }, 60000);

  it("ON: the same ranged call with profile:\"generic\" is un-numbered", async () => {
    const root = makeWorkspace();
    const server = startServer(root, { [FLAG]: "1" });
    spawnedServers.push(server);
    await server.initialize();
    const { body } = await server.call("tl_read_file", {
      cwd: root,
      targets: [{ path: "src/OrderService.java", range: "18-22" }],
      task: { epoch: "new", profile: "generic" },
    });
    const row = findRow(body, "src/OrderService.java");
    expect(row).toBeDefined();
    expect(textOf(row!)).not.toMatch(/^\d+\|/m);
  }, 60000);

  // No wire-facing toggle reproduces a served body that DIFFERS from
  // `elideDocCommentsWithWindows`'s own rendering of the same path+range
  // (searched: `comments:"keep"` is a real tl_read_file argument, but it governs
  // Office/artifact comments, not code doc-comment elision, and left this
  // Java render byte-identical to the default). The safety property itself
  // ("comments kept / a trimmed middle / a stale file never gets numbered")
  // is still exactly `applyAnswerLineGutter`'s to keep, so this ONE case
  // calls the real seam function directly, in-process, against a REAL file
  // on disk, with a hand-mismatched body standing in for whichever
  // producer-side shape reaches it on the wire.
  it("ON: a served body that does not match the renderer's own rendering stays un-numbered (direct seam check)", () => {
    process.env[FLAG] = "1";
    const root = makeWorkspace();
    const mismatchedBody = JAVA_FILE
      .split("\n")
      .slice(0, JAVA_TOTAL_LINES)
      .join("\n")
      // A comment kept verbatim (never elided) is exactly the kind of
      // mismatch a `comments:"keep"`-shaped or stale-cache producer body
      // would carry -- the renderer this module recomputes always elides.
      .replace("  /**", "  /** KEPT, NEVER ELIDED");
    const payload = {
      profile: "answer",
      evidence: [
        { handle: "h1", path: "src/OrderService.java", range: `1-${JAVA_TOTAL_LINES}`, body: mismatchedBody },
      ],
    };
    const result = applyAnswerLineGutter(payload, "read.task_pack", { codecTraceWorkspace: root });
    const row = (result["evidence"] as Array<Record<string, unknown>>)[0]!;
    expect(row["body"]).toBe(mismatchedBody);
    expect(String(row["body"])).not.toMatch(/^\d+\|/m);
  });
});

// ---------------------------------------------------------------------------
// Copilot retest r2 (2026-10-02): whole-file read.batch entries.
//
// A whole-file batch entry (`form:"file"`, `fullFileExpansion:true`) carries
// no `range`, so it shipped un-numbered. In the live large-task session
// (GPT-6 Luna) the model then re-read the same nine files with explicit
// ranges just to learn their line numbers -- one whole extra round, 18 % of
// that session's credits. The fixtures below are not part of QUERY's answer,
// so the first pack never serves them and the follow-up gets their bodies.
// ---------------------------------------------------------------------------

const GAUGE_LINES = [
  /* 1  */ "package com.example.metrics;",
  /* 2  */ "",
  /* 3  */ "public class Gauge {",
  /* 4  */ "  private long value;",
  /* 5  */ "",
  /* 6  */ "  /**",
  /* 7  */ "   * Records a sample. This doc comment is long on purpose so the",
  /* 8  */ "   * renderer elides it into one marker line, exactly like the",
  /* 9  */ "   * evaluated fixture's own comments were.",
  /* 10 */ "   * @param sample the new reading",
  /* 11 */ "   */",
  /* 12 */ "  public void record(long sample) {",
  /* 13 */ "    value = Math.max(value, sample);",
  /* 14 */ "  }",
  /* 15 */ "}",
];
const WINDOW_LINES = [
  /* 1 */ "/**",
  /* 2 */ " * Sliding-window helper. A JSDoc block long enough to be",
  /* 3 */ " * elided by the renderer, so the numbering must jump from",
  /* 4 */ " * its marker straight to line 6.",
  /* 5 */ " */",
  /* 6 */ "export function windowSum(values: number[], size: number): number {",
  /* 7 */ "  return values.slice(-size).reduce((a, b) => a + b, 0);",
  /* 8 */ "}",
];
const WHOLE_FILE_PATHS = ["src/metrics/Gauge.java", "src/metrics/window.ts"] as const;

function makeWholeFileWorkspace(): string {
  const root = makeWorkspace();
  fs.mkdirSync(path.join(root, "src", "metrics"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "metrics", "Gauge.java"), GAUGE_LINES.join("\n") + "\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "metrics", "window.ts"), WINDOW_LINES.join("\n") + "\n", "utf8");
  return root;
}

/** The live follow-up's own shape: a task pack first, then `qref` + whole-file targets + `content:"full"`. */
async function wholeFileFollowUp(
  env: Record<string, string>,
  profile: "answer" | "generic",
  withQref: boolean,
): Promise<Record<string, unknown>> {
  const root = makeWholeFileWorkspace();
  const server = startServer(root, env);
  spawnedServers.push(server);
  await server.initialize();
  const pack = await server.call("tl_read_file", { cwd: root, query: QUERY, task: { epoch: "new", profile } });
  const qref = pack.body["qref"];
  const { body } = await server.call("tl_read_file", {
    cwd: root,
    ...(withQref && typeof qref === "string" ? { qref } : {}),
    targets: WHOLE_FILE_PATHS.map((p) => ({ path: p })),
    content: "full",
  });
  return body;
}

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line !== "");
}

describe("TL_ANSWER_LINE_GUTTER — whole-file read.batch entries (Copilot retest r2)", () => {
  it("ON + answer lane, the live qref follow-up: rangeless whole-file entries are numbered from line 1, across each elided doc comment", async () => {
    const body = await wholeFileFollowUp({ [FLAG]: "1" }, "answer", true);
    expect(body["kind"], JSON.stringify(body).slice(0, 400)).toBe("read.batch");
    const gauge = findRow(body, "src/metrics/Gauge.java");
    const window = findRow(body, "src/metrics/window.ts");
    expect(gauge, JSON.stringify(body).slice(0, 400)).toBeDefined();
    expect(window, JSON.stringify(body).slice(0, 400)).toBeDefined();
    // The shape under test: no `range` on the entry at all.
    expect(gauge!["range"]).toBeUndefined();
    const gaugeLines = nonEmptyLines(textOf(gauge!));
    expect(gaugeLines[0]).toBe("1|package com.example.metrics;");
    expect(gaugeLines.filter((line) => !/^\d+\|/.test(line)), textOf(gauge!)).toEqual([]);
    expect(gaugeLines.find((line) => line.includes("doc elided")), textOf(gauge!)).toMatch(/^6\|/);
    expect(gaugeLines.find((line) => line.includes("public void record(long sample) {")), textOf(gauge!)).toMatch(/^12\|/);
    expect(gaugeLines[gaugeLines.length - 1]).toBe("15|}");
    const windowLines = nonEmptyLines(textOf(window!));
    expect(windowLines.find((line) => line.includes("export function windowSum")), textOf(window!)).toMatch(/^6\|/);
    expect(windowLines[windowLines.length - 1]).toBe("8|}");

    // Stripping the gutter recovers exactly the flag-off bytes.
    const offBody = await wholeFileFollowUp({}, "answer", true);
    for (const p of WHOLE_FILE_PATHS) {
      expect(stripAnswerLineGutter(textOf(findRow(body, p)!))).toBe(textOf(findRow(offBody, p)!));
    }
  }, 90000);

  it("ON + answer lane without the qref (lane-inherited answer profile): numbered too", async () => {
    const body = await wholeFileFollowUp({ [FLAG]: "1" }, "answer", false);
    const gauge = findRow(body, "src/metrics/Gauge.java");
    expect(gauge, JSON.stringify(body).slice(0, 400)).toBeDefined();
    expect(nonEmptyLines(textOf(gauge!))[0]).toBe("1|package com.example.metrics;");
  }, 60000);

  it("ON + generic lane: the same follow-up stays un-numbered (bodies stay copy-exact for tl_edit_file)", async () => {
    const body = await wholeFileFollowUp({ [FLAG]: "1" }, "generic", false);
    for (const p of WHOLE_FILE_PATHS) {
      const row = findRow(body, p);
      expect(row, JSON.stringify(body).slice(0, 400)).toBeDefined();
      expect(textOf(row!)).not.toMatch(/^\d+\|/m);
    }
  }, 60000);

  it("ON: the renderer's exact whole-file bytes are numbered only on a whole-file entry, never on another rangeless shape (direct seam check)", async () => {
    // The flag-off server's own rendering, so only the entry's shape differs between the two calls below.
    const offBody = await wholeFileFollowUp({}, "answer", false);
    const rendered = textOf(findRow(offBody, "src/metrics/Gauge.java")!);
    expect(rendered).not.toMatch(/^\d+\|/m);
    process.env[FLAG] = "1";
    const root = makeWholeFileWorkspace();
    const context = { codecTraceWorkspace: root, args: { taskProfile: "answer" } };
    const whole = applyAnswerLineGutter(
      { entries: [{ form: "file", path: "src/metrics/Gauge.java", truncated: false, handle: "h1", content: rendered, fullFileExpansion: true }] },
      "read.batch",
      context,
    );
    expect(String((whole["entries"] as Array<Record<string, unknown>>)[0]!["content"]).split("\n")[0]).toBe("1|package com.example.metrics;");
    const other = applyAnswerLineGutter(
      { entries: [{ form: "handle", path: "src/metrics/Gauge.java", handle: "h2", content: rendered }] },
      "read.batch",
      context,
    );
    expect((other["entries"] as Array<Record<string, unknown>>)[0]!["content"]).toBe(rendered);
    const mismatched = rendered.replace("record(long sample)", "record(long sampleKEPT)");
    const stale = applyAnswerLineGutter(
      { entries: [{ form: "file", path: "src/metrics/Gauge.java", truncated: false, handle: "h3", content: mismatched, fullFileExpansion: true }] },
      "read.batch",
      context,
    );
    expect((stale["entries"] as Array<Record<string, unknown>>)[0]!["content"]).toBe(mismatched);
  }, 60000);
});
