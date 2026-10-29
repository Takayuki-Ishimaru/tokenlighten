// serverPool.ts — lets a spec file's tests share dev servers instead of
// launching one per test (the server side is testing/sessionReset.ts).
//
// pooledSpawn() takes spawn()'s arguments. In a vitest run on every platform it
// pools by default: TL_TEST_SERVER_POOL=0 launches one server per test again,
// and =1 (or `{ pool: true }`) pools anywhere. In a script outside vitest
// such as scripts/tl-quality-eval.mjs it is spawn()
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
//   - Windows keeps the physical cwd outside removable fixtures; the server
//     receives the original logical cwd through a test-only launch variable.
//   - At most MAX_IDLE processes wait per spec file; setup cleanup kills idle
//     entries after its hooks, and worker exit kills any remaining entries.
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { PassThrough, Writable } from "node:stream";

// Fork workers have an IPC channel; ordinary child scripts inherit VITEST
// too, but must not acquire an idle server that prevents their own exit.
const POOL_SETTING = process.env["TL_TEST_SERVER_POOL"];
const POOL_ENABLED = POOL_SETTING === "1"
  || (POOL_SETTING !== "0" && process.env["VITEST"] !== undefined && typeof process.send === "function");
const MAX_IDLE = 2;
const RESET_TIMEOUT_MS = 30_000;
const STABLE_CWD = fileURLToPath(new URL("../../../", import.meta.url));
const POOL_CLEANUPS = Symbol.for("tokenlighten.test.serverPoolCleanups");

interface Entry {
  readonly key: string;
  readonly child: ChildProcess;
  readonly served: Set<string>;
  readonly detached: boolean;
  lease: Lease | undefined;
  alive: boolean;
  exited: boolean;
  terminating: boolean;
  idleSince: number;
  stdoutTail: Buffer;
  reset: Reset | undefined;
}

interface Reset {
  id: string;
  stdout: boolean;
  stderr: boolean;
  stderrTail: Buffer;
  done: (err?: Error) => void;
}

const entries: Entry[] = [];
const leases = new WeakSet<object>();
let resetSeq = 0;
let exitHookInstalled = false;
function stopPoolAtExit(): void {
  for (const entry of [...entries]) killEntry(entry);
}

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
    entry.alive && entry.lease === undefined && entry.stdoutTail.length === 0
      && entry.key === target.key && !entry.served.has(target.identity));
  const entry = reusable ?? launch(target.key, command, args, options);
  entry.served.add(target.identity);
  const reset = reusable === undefined ? undefined : { workspaceRoot: target.workspace, cwd: target.cwd };
  return new Lease(entry, command, args, reset) as unknown as ChildProcess;
}

/** The pool key and workspace for a poolable dev-server launch, else undefined. */
function poolTarget(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): { key: string; workspace: string; identity: string; cwd: string } | undefined {
  const binAt = args.findIndex((arg) => /[\\/]src[\\/]bin\.ts$/.test(arg));
  if (binAt < 0 || typeof options.cwd !== "string") return undefined;
  // Spawn semantics that a ChildProcess-shaped lease cannot faithfully preserve.
  if (Object.keys(options).some((key) => !["cwd", "env", "stdio", "detached", "windowsHide"].includes(key))) return undefined;
  if (args.includes("--print-schema-stamp") || args.includes("--print-config-digest")) return undefined;
  const stdio = options.stdio ?? "pipe";
  const piped = stdio === "pipe" || (Array.isArray(stdio) && stdio.length <= 3 && [0, 1, 2].every((i) => (stdio[i] ?? "pipe") === "pipe"));
  if (!piped) return undefined;

  // The root the server resolves for itself (server.ts workspaceRootArg).
  let named: number | undefined;
  let positional: number | undefined;
  for (let i = binAt + 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--workspace") {
      if (args[i + 1] === undefined || args[i + 1]!.startsWith("--")) return undefined;
      named = i + 1;
      i++;
      continue;
    }
    if (arg === "--allowed-root" || arg === "--allowed-parent") {
      if (args[i + 1] === undefined || args[i + 1]!.startsWith("--")) return undefined;
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
  if (env["TOKENLIGHTEN_ENGINES_FILE"] !== undefined) return undefined;
  // Optional native/semantic runtimes do not have a proven reset boundary.
  const home = process.platform === "win32" ? env["USERPROFILE"] : env["HOME"];
  try {
    const engines = JSON.parse(fs.readFileSync(path.join(home ?? os.homedir(), ".tokenlighten", "engines.json"), "utf8")) as {
      typedSymbols?: { enabled?: unknown }; semanticSearch?: { enabled?: unknown };
    };
    if (engines?.typedSymbols?.enabled || engines?.semanticSearch?.enabled) return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
  }
  if (process.platform === "win32") {
    // Moving the physical cwd must not reinterpret ambient relative paths.
    if (!path.isAbsolute(command) || env["NODE_OPTIONS"]) return undefined;
    if (!path.isAbsolute(args[binAt]!) || args.slice(0, binAt).some((arg) => arg.startsWith("."))) return undefined;
    for (let i = 0; i < binAt; i++) {
      if (["--require", "-r", "--import", "--loader", "--experimental-loader"].includes(args[i]!)) {
        const preload = args[++i] ?? "";
        if (!path.isAbsolute(preload) && !preload.startsWith("file:") && !preload.startsWith("node:")) return undefined;
      }
    }
    for (let i = binAt + 1; i < args.length; i++) {
      if ((args[i] === "--allowed-root" || args[i] === "--allowed-parent") && !path.isAbsolute(args[i + 1] ?? "")) return undefined;
    }
    for (const name of ["HOME", "USERPROFILE", "TOKENLIGHTEN_HOME", "TOKENLIGHTEN_LOG_HOME", "TOKENLIGHTEN_CONFIG_HOME",
      "TOKENLIGHTEN_STATE_KEY_DIR", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "TOKENLIGHTEN_CODEX_LOG_HOME", "TOKENLIGHTEN_CLAUDE_LOG_HOME"]) {
      if (env[name] && !path.isAbsolute(env[name]!)) return undefined;
    }
    for (const parent of (env["TOKENLIGHTEN_ALLOWED_PARENTS"] ?? "").split(path.delimiter)) {
      if (parent && !path.isAbsolute(parent)) return undefined;
    }
    for (const directory of (env["PATH"] ?? env["Path"] ?? "").split(path.delimiter)) {
      if (directory && !path.isAbsolute(directory)) return undefined;
    }
  }
  const cwd = path.resolve(options.cwd);
  const workspace = path.resolve(cwd, wsIndex !== undefined ? args[wsIndex]! : env["TOKENLIGHTEN_ROOT"] ?? cwd);
  let identity: string;
  let cwdIdentity: string;
  try {
    if (!fs.statSync(workspace).isDirectory()) return undefined;
    identity = directoryIdentity(workspace);
    cwdIdentity = directoryIdentity(cwd);
  } catch {
    return undefined; // the launch fails on its own, as a fresh one would
  }
  const key = JSON.stringify([
    command,
    args.map((arg, i) => (i === wsIndex ? "$WS" : arg)),
    cwdIdentity === identity ? "$WS" : cwdIdentity,
    options.detached === true,
    options.windowsHide === true,
    Object.entries(env).filter(([, value]) => value !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ]);
  return { key, workspace, identity, cwd };
}

function directoryIdentity(directory: string): string {
  const real = fs.realpathSync.native(directory);
  return process.platform === "win32" ? real.toLowerCase() : real;
}

/** Kills every idle pooled process now (leases in use keep theirs). */
export function closeServerPool(): void {
  for (const entry of entries.filter((candidate) => candidate.lease === undefined)) killEntry(entry);
}

function launch(key: string, command: string, args: readonly string[], options: SpawnOptions): Entry {
  // The setup janitor runs after spec hooks, closing idle pools before it
  // removes fixtures. A registry avoids importing vitest from this helper.
  const cleanups = (globalThis as unknown as Record<symbol, Set<() => void> | undefined>)[POOL_CLEANUPS];
  cleanups?.add(closeServerPool);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", stopPoolAtExit);
  }
  const child = spawn(command, [...args], {
    ...options,
    ...(process.platform === "win32" ? { cwd: STABLE_CWD } : {}),
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...(options.env ?? process.env), TL_TEST_SESSION_RESET: "1",
      ...(process.platform === "win32" ? { TL_TEST_SESSION_CWD: path.resolve(options.cwd as string) } : {}) },
  });
  const entry: Entry = {
    key,
    child,
    served: new Set(),
    detached: options.detached === true,
    lease: undefined,
    alive: true,
    exited: false,
    terminating: false,
    idleSince: 0,
    stdoutTail: Buffer.alloc(0),
    reset: undefined,
  };
  child.stdout!.on("data", (chunk: Buffer) => onStdout(entry, chunk));
  child.stderr!.on("data", (chunk: Buffer) => onStderr(entry, chunk));
  child.on("spawn", () => entry.lease?.emit("spawn"));
  child.on("error", (err) => {
    retire(entry);
    entry.lease?.emit("error", err);
  });
  child.on("exit", (code, signal) => {
    entry.exited = true;
    retire(entry);
    entry.lease?.realExit(code, signal);
  });
  child.on("close", (code, signal) => {
    entry.exited = true;
    retire(entry);
    if (entry.stdoutTail.length > 0) entry.lease?.deliverStdout(entry.stdoutTail);
    entry.stdoutTail = Buffer.alloc(0);
    entry.lease?.realClose(code, signal);
    finishReset(entry, new Error("pooled server closed during its session reset"));
  });
  child.stdin!.on("error", (err: Error) => {
    if (entry.reset !== undefined) finishReset(entry, err);
    else {
      killEntry(entry);
      entry.lease?.realInputError(err);
    }
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
    if (entry.reset !== undefined) {
      // Until the reset answers, every line belongs to the previous session.
      const text = line.toString("utf8");
      if (!text.includes(entry.reset.id)) continue;
      let message: { id?: unknown; error?: unknown; result?: { reset?: unknown } };
      try {
        message = JSON.parse(text) as typeof message;
      } catch {
        continue;
      }
      if (message.id !== entry.reset.id) continue;
      if (message.error !== undefined || message.result?.reset !== true) {
        finishReset(entry, new Error(`session reset failed: ${JSON.stringify(message)}`));
      } else {
        entry.reset.stdout = true;
        finishReset(entry);
      }
      continue;
    }
    entry.lease?.deliverStdout(Buffer.from(line));
  }
  entry.stdoutTail = start < data.length ? Buffer.from(data.subarray(start)) : Buffer.alloc(0);
}

function onStderr(entry: Entry, chunk: Buffer): void {
  const reset = entry.reset;
  if (reset === undefined) return entry.lease?.deliverStderr(chunk);
  const marker = Buffer.from(`\u001eTL_TEST_RESET_STDERR:${reset.id}\n`);
  const data = Buffer.concat([reset.stderrTail, chunk]);
  const at = data.indexOf(marker);
  if (at < 0) {
    reset.stderrTail = Buffer.from(data.subarray(Math.max(0, data.length - marker.length + 1)));
    return;
  }
  reset.stderr = true;
  reset.stderrTail = Buffer.alloc(0);
  finishReset(entry);
  if (entry.reset === undefined && at + marker.length < data.length) {
    entry.lease?.deliverStderr(data.subarray(at + marker.length));
  }
}

function finishReset(entry: Entry, err?: Error): void {
  const reset = entry.reset;
  if (reset === undefined || (err === undefined && !(reset.stdout && reset.stderr))) return;
  entry.reset = undefined;
  reset.done(err);
}

function retire(entry: Entry): void {
  entry.alive = false;
  const at = entries.indexOf(entry);
  if (at >= 0) entries.splice(at, 1);
  if (entries.length === 0 && exitHookInstalled) {
    process.removeListener("exit", stopPoolAtExit);
    exitHookInstalled = false;
  }
}

function killEntry(entry: Entry): void {
  retire(entry);
  if (entry.exited || entry.terminating) return;
  entry.terminating = true;
  const pid = entry.child.pid;
  try {
    if (process.platform === "win32" && pid !== undefined) {
      // Node's kill() only terminates the root on Windows; tsx/runtime children
      // must not keep the worker's pipes or fixture directories open.
      const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      if (result.status !== 0) entry.child.kill("SIGKILL");
    } else if (entry.detached && pid !== undefined) process.kill(-pid, "SIGKILL");
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
  private exited = false;
  /** Writes held back while the reset is pending; undefined once it answered. */
  private held: Buffer[] | undefined;
  private readonly inflight = new Map<string, number>();
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
    // A physical pipe failure is handled once by the entry, including queued
    // writes whose callers did not register stream error listeners.
    this.stdin.on("error", () => {});
    if (reset === undefined) return;

    this.held = [];
    const id = `tl-pool-reset-${++resetSeq}`;
    const timer = setTimeout(() => finishReset(entry, new Error("session reset timed out")), RESET_TIMEOUT_MS);
    entry.reset = { id, stdout: false, stderr: false, stderrTail: Buffer.alloc(0), done: (err) => {
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
    } };
    entry.child.stdin!.write(
      JSON.stringify({ jsonrpc: "2.0", id, method: "tokenlighten/testReset", params: { ...reset, stderrBarrier: id } }) + "\n",
    );
    setImmediate(() => this.emit("spawn"));
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    if (this.ended || this.exited) return false;
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
    if (this.ended || this.exited) return;
    this.exited = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }

  realClose(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.ended) return;
    this.ended = true;
    if (this.entry.lease === this) this.entry.lease = undefined;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
  }

  realInputError(err: Error): void {
    if (this.ended) return;
    this.deliverStderr(Buffer.from(`[server-pool] ${err.message}\n`));
    this.end(1, null);
  }

  private end(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.ended || this.exited) return;
    const entry = this.entry;
    if (entry.lease === this) entry.lease = undefined;
    const reusable = entry.alive && this.held === undefined && entry.reset === undefined
      && this.inflight.size === 0 && this.stdinTail.length === 0 && entry.stdoutTail.length === 0;
    // Cancels the timeout and drops queued input before retiring an unfinished reset.
    if (entry.reset !== undefined) {
      this.finish(code, signal);
      finishReset(entry, new Error("lease ended during its session reset"));
    }
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
      if (!this.exited) this.emit("exit", code, signal);
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
          const id = JSON.stringify(message.id);
          this.inflight.set(id, (this.inflight.get(id) ?? 0) + 1);
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
        const id = JSON.stringify(message.id);
        const count = this.inflight.get(id) ?? 0;
        if (count <= 1) this.inflight.delete(id);
        else this.inflight.set(id, count - 1);
      }
    } catch {
      /* not a JSON-RPC line */
    }
  }
}
