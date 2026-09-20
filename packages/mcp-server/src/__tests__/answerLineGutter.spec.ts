// answerLineGutter.spec.ts — regression coverage for TL_ANSWER_LINE_GUTTER
// (WP-S4, 2026-09-20).
//
// DEFECT UNDER TEST (measured 2026-09-19, recorded GitHub Copilot sessions):
// TL evidence carries a `range` (e.g. "256-308") plus a body whose multi-line
// doc comments are collapsed by `elideDocCommentsWithWindows`
// (util/formatCompress.ts) into a single marker line naming the elided span,
// so a statement's true source line cannot be counted off the wire — a method
// starting at file line 274 is unreachable by counting from a body that opens
// at line 256. The model issued serial `search_files find` calls on exact
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

afterEach(() => {
  delete process.env[FLAG];
  delete process.env[UMBRELLA];
  for (const root of workspaces.splice(0)) fs.rmSync(root, { recursive: true, force: true });
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
  const child: ChildProcess = spawn(process.execPath, [TSX_CLI, BIN_TS, cwd], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
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
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
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
  return server.call("read_file", {
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

  it("ON + generic profile: un-numbered (bodies must stay copy-exact for edit_file)", async () => {
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
    const { body } = await server.call("read_file", {
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
    const { body } = await server.call("read_file", {
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
  // (searched: `comments:"keep"` is a real read_file argument, but it governs
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
