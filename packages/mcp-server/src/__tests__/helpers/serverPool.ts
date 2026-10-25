// serverPool.ts — lets a spec file's tests share dev servers instead of
// launching one per test (the server side is testing/sessionReset.ts).
//
// pooledSpawn() takes spawn()'s arguments. In a spec run on macOS or Linux it
// pools by default: TL_TEST_SERVER_POOL=0 launches one server per test again,
// and =1 (or `{ pool: true }`) pools anywhere. Elsewhere — Windows, or a
// script outside vitest such as scripts/tl-quality-eval.mjs — it is spawn()
// itself. When it pools, a dev-server launch —
// `<node> ...TSX_NODE_ARGS <...>/src/bin.ts [workspace] ...` with piped stdio,
// an existing workspace and the legacy stdio transport — returns a
// ChildProcess-shaped lease on a pooled process instead:
//
//   - A pooled process serves one lease at a time, and only launches with the
//     same command, arguments (the workspace aside), cwd and environment. It
//     never serves a workspace it served before, so a restart is still a real
//     restart.
//   - A reused process is reset first (`tokenlighten/testReset`). What the
//     test writes meanwhile is held back, and what the previous session left
//     on stdout/stderr is dropped, so a lease only ever sees its own session.
//   - kill() and stdin.end() end the lease the way an exit would (`exit` and
//     `close`, exitCode/signalCode) and return the process to the pool —
//     unless a request is still unanswered or the reset never finished: then
//     the process is really killed. killServerGroup() routes leases to kill().
//   - At most MAX_IDLE processes wait per spec file (vitest runs each file in
//     its own process); all are killed when that process exits, and
//     closeServerPool() kills the idle ones earlier.
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { PassThrough, Writable } from "node:stream";

// vitest sets VITEST in its workers. Windows stays opt-in: the pool's process
// handling (process groups, signals) has only been exercised on POSIX.
const POOL_SETTING = process.env["TL_TEST_SERVER_POOL"];
const POOL_ENABLED = POOL_SETTING === "1"
  || (POOL_SETTING !== "0" && process.env["VITEST"] !== undefined && process.platform !== "win32");
const MAX_IDLE = 2;
const RESET_TIMEOUT_MS = 30_000;

interface Entry {
  readonly key: string;
  readonly child: ChildProcess;
  readonly served: Set<string>;
  lease: Lease | undefined;
  alive: boolean;
  idleSince: number;
  stdoutTail: Buffer;
  resetId: string | undefined;
  onReset: ((err?: Error) => void) | undefined;
}

const entries: Entry[] = [];
const leases = new WeakSet<object>();
let resetSeq = 0;
let exitHookInstalled = false;

/** True for a lease pooledSpawn() returned (killServerGroup must not signal its process group). */
export function isPooledChild(child: unknown): boolean {
  return typeof child === "object" && child !== null && leases.has(child);
}

export function pooledSpawn(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
  { pool = POOL_ENABLED }: { pool?: boolean } = {},
): ChildProcess {
  const target = pool ? poolTarget(command, args, options) : undefined;
  if (target === undefined) return spawn(command, [...args], options);
  const reusable = entries.find((entry) =>
    entry.alive && entry.lease === undefined && entry.key === target.key && !entry.served.has(target.workspace));
  const entry = reusable ?? launch(target.key, command, args, options);
  entry.served.add(target.workspace);
  const reset = reusable === undefined ? undefined : { workspaceRoot: target.workspace, cwd: target.cwd };
  return new Lease(entry, command, args, reset) as unknown as ChildProcess;
}

/** The pool key and workspace for a poolable dev-server launch, else undefined. */
function poolTarget(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): { key: string; workspace: string; cwd: string } | undefined {
  const binAt = args.findIndex((arg) => /[\\/]src[\\/]bin\.ts$/.test(arg));
  if (binAt < 0 || typeof options.cwd !== "string") return undefined;
  const stdio = options.stdio ?? "pipe";
  const piped = stdio === "pipe" || (Array.isArray(stdio) && [0, 1, 2].every((i) => (stdio[i] ?? "pipe") === "pipe"));
  if (!piped) return undefined;

  // The root the server resolves for itself (server.ts workspaceRootArg).
  let named: number | undefined;
  let positional: number | undefined;
  for (let i = binAt + 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--workspace") {
      named = i + 1;
      i++;
      continue;
    }
    if (arg === "--allowed-root" || arg === "--allowed-parent") {
      i++;
      continue;
    }
    if (!arg.startsWith("--") && positional === undefined) positional = i;
  }
  const wsIndex = named ?? positional;
  const env = options.env ?? process.env;
  // Only the legacy stdio transport answers the reset request.
  if ((env["TOKENLIGHTEN_PROTOCOL_ERA"] ?? "").trim().toLowerCase() === "modern") return undefined;
  if ((env["TOKENLIGHTEN_HTTP_PORT"] ?? "") !== "") return undefined;
  const cwd = path.resolve(options.cwd);
  const workspace = path.resolve(cwd, wsIndex !== undefined ? args[wsIndex]! : env["TOKENLIGHTEN_ROOT"] ?? cwd);
  try {
    if (!fs.statSync(workspace).isDirectory()) return undefined;
  } catch {
    return undefined; // the launch fails on its own, as a fresh one would
  }
  const key = JSON.stringify([
    command,
    args.map((arg, i) => (i === wsIndex ? "$WS" : arg)),
    cwd === workspace ? "$WS" : cwd,
    options.detached === true,
    Object.entries(env).filter(([, value]) => value !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ]);
  return { key, workspace, cwd };
}

/** Kills every idle pooled process now (leases in use keep theirs). */
export function closeServerPool(): void {
  for (const entry of entries.filter((candidate) => candidate.lease === undefined)) killEntry(entry);
}

function launch(key: string, command: string, args: readonly string[], options: SpawnOptions): Entry {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => {
      for (const entry of [...entries]) killEntry(entry);
    });
  }
  const child = spawn(command, [...args], {
    ...options,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...(options.env ?? process.env), TL_TEST_SESSION_RESET: "1" },
  });
  const entry: Entry = {
    key,
    child,
    served: new Set(),
    lease: undefined,
    alive: true,
    idleSince: 0,
    stdoutTail: Buffer.alloc(0),
    resetId: undefined,
    onReset: undefined,
  };
  child.stdout!.on("data", (chunk: Buffer) => onStdout(entry, chunk));
  child.stderr!.on("data", (chunk: Buffer) => {
    // Output written before the reset's answer belongs to the previous session.
    if (entry.resetId === undefined) entry.lease?.deliverStderr(chunk);
  });
  child.on("spawn", () => entry.lease?.emit("spawn"));
  child.on("error", (err) => {
    retire(entry);
    entry.lease?.emit("error", err);
  });
  child.on("exit", (code, signal) => {
    retire(entry);
    entry.onReset?.(new Error(`pooled server exited during its session reset (code ${code}, signal ${signal})`));
    entry.lease?.realExit(code, signal);
  });
  entries.push(entry);
  return entry;
}

function onStdout(entry: Entry, chunk: Buffer): void {
  const data = entry.stdoutTail.length > 0 ? Buffer.concat([entry.stdoutTail, chunk]) : chunk;
  let start = 0;
  for (let nl = data.indexOf(10, start); nl >= 0; nl = data.indexOf(10, start)) {
    const line = data.subarray(start, nl + 1);
    start = nl + 1;
    if (entry.resetId !== undefined) {
      // Until the reset answers, every line belongs to the previous session.
      const text = line.toString("utf8");
      if (!text.includes(entry.resetId)) continue;
      let message: { id?: unknown; error?: unknown };
      try {
        message = JSON.parse(text) as { id?: unknown; error?: unknown };
      } catch {
        continue;
      }
      if (message.id !== entry.resetId) continue;
      const done = entry.onReset;
      entry.resetId = undefined;
      entry.onReset = undefined;
      done?.(message.error === undefined ? undefined : new Error(`session reset failed: ${JSON.stringify(message.error)}`));
      continue;
    }
    entry.lease?.deliverStdout(Buffer.from(line));
  }
  entry.stdoutTail = start < data.length ? Buffer.from(data.subarray(start)) : Buffer.alloc(0);
}

function retire(entry: Entry): void {
  entry.alive = false;
  const at = entries.indexOf(entry);
  if (at >= 0) entries.splice(at, 1);
}

function killEntry(entry: Entry): void {
  retire(entry);
  const pid = entry.child.pid;
  try {
    if (process.platform !== "win32" && pid !== undefined) process.kill(-pid, "SIGKILL");
    else entry.child.kill("SIGKILL");
  } catch {
    try {
      entry.child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

function trimIdle(): void {
  const idle = entries.filter((entry) => entry.alive && entry.lease === undefined).sort((a, b) => a.idleSince - b.idleSince);
  for (const entry of idle.slice(0, Math.max(0, idle.length - MAX_IDLE))) killEntry(entry);
}

/** The ChildProcess-shaped view of one test's session on a pooled process. */
class Lease extends EventEmitter {
  readonly stdin: Writable;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdio: [Writable, PassThrough, PassThrough];
  readonly pid: number | undefined;
  readonly spawnfile: string;
  readonly spawnargs: string[];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  readonly connected = false;
  private ended = false;
  /** Writes held back while the reset is pending; undefined once it answered. */
  private held: Buffer[] | undefined;
  private readonly inflight = new Set<string>();
  private stdinTail = "";

  constructor(
    private readonly entry: Entry,
    command: string,
    args: readonly string[],
    reset: { workspaceRoot: string; cwd: string } | undefined,
  ) {
    super();
    leases.add(this);
    entry.lease = this;
    this.pid = entry.child.pid;
    this.spawnfile = command;
    this.spawnargs = [command, ...args];
    this.stdin = new Writable({
      write: (chunk: Buffer | string, encoding: BufferEncoding, callback: (err?: Error | null) => void) => {
        const buffer = typeof chunk === "string" ? Buffer.from(chunk, encoding) : chunk;
        if (this.ended) return callback();
        this.trackRequests(buffer);
        if (this.held !== undefined) {
          this.held.push(buffer);
          return callback();
        }
        entry.child.stdin!.write(buffer, callback);
      },
      final: (callback: (err?: Error | null) => void) => {
        // EOF on stdin: a fresh server exits 0 once its input ends.
        this.end(0, null);
        callback();
      },
    });
    this.stdio = [this.stdin, this.stdout, this.stderr];
    if (reset === undefined) return;

    this.held = [];
    const id = `tl-pool-reset-${++resetSeq}`;
    const timer = setTimeout(() => entry.onReset?.(new Error("session reset timed out")), RESET_TIMEOUT_MS);
    entry.resetId = id;
    entry.onReset = (err) => {
      clearTimeout(timer);
      if (err !== undefined) {
        killEntry(entry);
        this.deliverStderr(Buffer.from(`[server-pool] ${err.message}\n`));
        this.end(1, null);
        return;
      }
      const held = this.held ?? [];
      this.held = undefined;
      for (const buffer of held) entry.child.stdin!.write(buffer);
    };
    entry.child.stdin!.write(
      JSON.stringify({ jsonrpc: "2.0", id, method: "tokenlighten/testReset", params: reset }) + "\n",
    );
    setImmediate(() => this.emit("spawn"));
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    if (this.ended) return false;
    this.killed = true;
    this.end(null, typeof signal === "string" ? signal : "SIGKILL");
    return true;
  }

  ref(): void {}
  unref(): void {}

  deliverStdout(line: Buffer): void {
    if (this.ended) return;
    this.trackResponse(line);
    this.stdout.write(line);
  }

  deliverStderr(chunk: Buffer): void {
    if (!this.ended) this.stderr.write(chunk);
  }

  /** The pooled process itself exited while this lease held it. */
  realExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.finish(code, signal);
  }

  private end(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.ended) return;
    const entry = this.entry;
    if (entry.lease === this) entry.lease = undefined;
    const reusable = entry.alive && this.held === undefined && entry.resetId === undefined && this.inflight.size === 0;
    if (!reusable) killEntry(entry);
    else {
      entry.idleSince = Date.now();
      trimIdle();
    }
    this.finish(code, signal);
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.ended) return;
    this.ended = true;
    if (this.entry.lease === this) this.entry.lease = undefined;
    setImmediate(() => {
      this.exitCode = code;
      this.signalCode = signal;
      this.emit("exit", code, signal);
      this.stdout.end();
      this.stderr.end();
      this.emit("close", code, signal);
    });
  }

  /** Requests the test sent (by id), so a lease with an unanswered one is not reused. */
  private trackRequests(buffer: Buffer): void {
    this.stdinTail += buffer.toString("utf8");
    let nl: number;
    while ((nl = this.stdinTail.indexOf("\n")) >= 0) {
      const line = this.stdinTail.slice(0, nl);
      this.stdinTail = this.stdinTail.slice(nl + 1);
      try {
        const message = JSON.parse(line) as { id?: unknown; method?: unknown };
        if (message.id !== undefined && message.id !== null && typeof message.method === "string") {
          this.inflight.add(JSON.stringify(message.id));
        }
      } catch {
        /* not a JSON-RPC line */
      }
    }
  }

  private trackResponse(line: Buffer): void {
    if (this.inflight.size === 0) return;
    try {
      const message = JSON.parse(line.toString("utf8")) as { id?: unknown; result?: unknown; error?: unknown };
      if (message.id !== undefined && ("result" in message || "error" in message)) {
        this.inflight.delete(JSON.stringify(message.id));
      }
    } catch {
      /* not a JSON-RPC line */
    }
  }
}
