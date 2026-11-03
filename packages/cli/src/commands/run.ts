/**
 * tl run [--shell S] -- <command...> — runs a test or build command and
 * prints only what matters (2026-11-03). See runOutput.ts for what is kept
 * and why.
 *
 * The command runs through a shell: the one `--shell` names, else bash when
 * the environment says the caller is a bash (Git Bash sets MSYSTEM and SHELL
 * on Windows), else the platform shell. stdin is inherited; stdout and stderr
 * are captured in arrival order. The exit code is the command's own (a
 * PowerShell run forwards `$LASTEXITCODE`); a signal maps to 128+n. The full
 * combined output goes to `.tokenlighten/.runtime/run/<timestamp>-<id>.log`
 * under the workspace root (the nearest `.tokenlighten/.runtime/` or `.git`
 * above the cwd), and the compressed result to stdout.
 *
 * Output policy: plain data — no meta envelope.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { ensureRuntimeDirectory } from "@tokenlighten/skeleton-engine";
import { compressRunOutput, DEFAULT_RUN_OUTPUT_LIMIT_BYTES } from "../runOutput.js";
import { findWorkspaceRoot } from "../runtimeRoot.js";
import { wantsHelp } from "../util/helpFlag.js";

const RUN_USAGE = `\
Usage: tl run [--limit-bytes N] [--root DIR] [--shell bash|powershell|cmd|sh] -- <command...>

Runs the command through the shell, keeps its exit code, saves the full
combined output to .tokenlighten/.runtime/run/<timestamp>-<id>.log under the
workspace root, and prints a compressed result: every failure block the
runner printed (vitest, jest, pytest, tsc, eslint, go test, cargo, node --test),
the runner's summary, a short tail and the log path, within --limit-bytes
(default ${DEFAULT_RUN_OUTPUT_LIMIT_BYTES}). An unrecognised runner prints head, tail, any line that
looks like a failure, and the log path. A single argument after -- is the whole
shell command line, verbatim; several arguments are joined (quoted where needed).

  --limit-bytes N   Upper bound on the printed result (minimum 512)
  --root DIR        Workspace root for the log (default: nearest .tokenlighten/.runtime or .git)
  --shell S         Shell family for the command (default: bash when the caller is a
                    bash, else the platform shell); an unavailable shell falls back
`;

/** How many logs stay in the run directory; older ones are removed on the next run. */
const KEPT_LOGS = 40;

export type ShellRequest = "bash" | "powershell" | "cmd" | "sh";
export const SHELL_REQUESTS: readonly ShellRequest[] = ["bash", "powershell", "cmd", "sh"];

export interface ShellChoice {
  command: string;
  args: string[];
  /** How the command line is handed over: one `-c` argument, cmd.exe's quoted `/c` unit, or a PowerShell encoded command. */
  mode: "argument" | "cmd" | "powershell";
}

function fileExists(path: string | undefined): path is string {
  if (path === undefined || path === "") return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function pathDirectories(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  return (env["PATH"] ?? env["Path"] ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
}

/** A Git Bash / POSIX bash, never WSL's `System32\bash.exe` stub (that runs the command in a Linux VM). */
function findBash(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): ShellChoice | undefined {
  const candidates: Array<string | undefined> = platform === "win32"
    ? [
      env["EXEPATH"] ? join(env["EXEPATH"], "bin", "bash.exe") : undefined,
      env["EXEPATH"] ? join(env["EXEPATH"], "usr", "bin", "bash.exe") : undefined,
      env["EXEPATH"] ? join(env["EXEPATH"], "..", "bin", "bash.exe") : undefined,
      env["ProgramFiles"] ? join(env["ProgramFiles"], "Git", "bin", "bash.exe") : undefined,
      env["ProgramFiles(x86)"] ? join(env["ProgramFiles(x86)"], "Git", "bin", "bash.exe") : undefined,
      env["LOCALAPPDATA"] ? join(env["LOCALAPPDATA"], "Programs", "Git", "bin", "bash.exe") : undefined,
      env["SHELL"] && /^[A-Za-z]:[\\/]/.test(env["SHELL"]) ? env["SHELL"] : undefined,
      ...pathDirectories(env, platform).filter((dir) => !/system32/i.test(dir)).map((dir) => join(dir, "bash.exe")),
    ]
    : ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash", ...pathDirectories(env, platform).map((dir) => join(dir, "bash"))];
  for (const candidate of candidates) {
    if (fileExists(candidate)) return { command: candidate, args: ["-c"], mode: "argument" };
  }
  return undefined;
}

function findPowerShell(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): ShellChoice | undefined {
  const args = ["-NoProfile", "-NonInteractive", "-EncodedCommand"];
  for (const dir of pathDirectories(env, platform)) {
    const pwsh = join(dir, platform === "win32" ? "pwsh.exe" : "pwsh");
    if (fileExists(pwsh)) return { command: pwsh, args, mode: "powershell" };
  }
  if (platform === "win32") {
    const system = env["SystemRoot"] ?? env["windir"] ?? "C:\\Windows";
    const legacy = join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return { command: fileExists(legacy) ? legacy : "powershell.exe", args, mode: "powershell" };
  }
  return undefined;
}

/**
 * The shell that runs the inner command. `requested` (from `--shell`) wins
 * when that shell is available; otherwise TL_RUN_SHELL when set; otherwise
 * bash wherever the caller's environment is a bash (Git Bash sets MSYSTEM
 * and SHELL on Windows), `/bin/bash` else `/bin/sh` on POSIX, and `cmd.exe`
 * on a Windows console that is not a bash.
 */
export function selectShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  requested?: ShellRequest,
): ShellChoice {
  if (requested === "bash") {
    const bash = findBash(env, platform);
    if (bash !== undefined) return bash;
  } else if (requested === "powershell") {
    const powershell = findPowerShell(env, platform);
    if (powershell !== undefined) return powershell;
  } else if (requested === "cmd" && platform === "win32") {
    return { command: env["ComSpec"] ?? "cmd.exe", args: ["/d", "/s", "/c"], mode: "cmd" };
  } else if (requested === "sh" && platform !== "win32") {
    return { command: "/bin/sh", args: ["-c"], mode: "argument" };
  }
  if (env["TL_RUN_SHELL"]) return { command: env["TL_RUN_SHELL"], args: ["-c"], mode: "argument" };
  if (platform === "win32") {
    const bashy = env["MSYSTEM"] !== undefined || /bash/i.test(env["SHELL"] ?? "");
    if (bashy) return findBash(env, platform) ?? { command: "bash", args: ["-c"], mode: "argument" };
    return { command: env["ComSpec"] ?? "cmd.exe", args: ["/d", "/s", "/c"], mode: "cmd" };
  }
  return { command: existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh", args: ["-c"], mode: "argument" };
}

/** The PowerShell script that runs `commandLine` and forwards its exit code. */
export function powershellScript(commandLine: string): string {
  return `${commandLine}\n$tlRunOk = $?\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }\nif (-not $tlRunOk) { exit 1 }\n`;
}

/** The argv for `shell` running `commandLine`. */
export function shellArguments(shell: ShellChoice, commandLine: string): string[] {
  switch (shell.mode) {
    case "cmd":
      // cmd.exe `/s /c` wants the whole command line as ONE quoted unit passed
      // through verbatim (what Node's own `shell: true` does).
      return [...shell.args, `"${commandLine}"`];
    case "powershell":
      // -EncodedCommand (base64 of UTF-16LE) sidesteps every quoting rule of
      // the Windows command line and of PowerShell itself.
      return [...shell.args, Buffer.from(powershellScript(commandLine), "utf16le").toString("base64")];
    default:
      return [...shell.args, commandLine];
  }
}

export interface CapturedRun {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  durationMs: number;
}

/** Runs `commandLine` through `shell`, capturing stdout and stderr in arrival order. */
export function runCommandCaptured(commandLine: string, options: { cwd: string; shell: ShellChoice; env?: NodeJS.ProcessEnv }): Promise<CapturedRun> {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now();
    const chunks: Buffer[] = [];
    const child = spawn(options.shell.command, shellArguments(options.shell, commandLine), {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["inherit", "pipe", "pipe"],
      windowsHide: true,
      ...(options.shell.mode === "cmd" ? { windowsVerbatimArguments: true } : {}),
    });
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolvePromise({ exitCode: code, signal, output: Buffer.concat(chunks).toString("utf8"), durationMs: Date.now() - started });
    });
  });
}

/** The process exit code `tl run` reports for a captured run. */
export function exitCodeFor(run: Pick<CapturedRun, "exitCode" | "signal">): number {
  if (run.exitCode !== null) return run.exitCode;
  const signals = osConstants.signals as Record<string, number>;
  const number = run.signal !== null ? signals[run.signal] : undefined;
  return number !== undefined ? 128 + number : 1;
}

/** `tl run -- a "b c"` → `a "b c"`; a single argument is the command line itself. */
export function joinCommandTokens(tokens: readonly string[]): string {
  if (tokens.length === 1) return tokens[0]!;
  return tokens.map((token) => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(token) ? token : `"${token.replace(/(["\\$`])/g, "\\$1")}"`)).join(" ");
}

function timestamp(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/**
 * Writes the full output under the workspace's private runtime directory and
 * prunes old logs. `label` names the writer in the first line: `tl run`, or
 * the Claude Code PostToolUse hook that saved a run it did not start
 * (2026-11-03).
 */
export function writeRunLog(root: string, commandLine: string, cwd: string, run: CapturedRun, now: Date = new Date(), label = "tl run"): string {
  ensureRuntimeDirectory(root);
  const directory = join(root, ".tokenlighten", ".runtime", "run");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${timestamp(now)}-${randomBytes(3).toString("hex")}.log`);
  const header = `# ${label}: ${commandLine}\n# cwd: ${cwd}\n# exit: ${run.exitCode ?? `signal ${run.signal ?? "?"}`} after ${run.durationMs} ms\n`;
  writeFileSync(path, header + run.output, { encoding: "utf8", mode: 0o600 });
  try {
    const logs = readdirSync(directory).filter((name) => name.endsWith(".log")).sort();
    for (const stale of logs.slice(0, Math.max(0, logs.length - KEPT_LOGS))) {
      try { unlinkSync(join(directory, stale)); } catch { /* another run may hold it */ }
    }
  } catch { /* pruning is best effort */ }
  return path;
}

/** The log path as printed: relative (forward slashes) when it lies under `cwd`, else as written. */
export function displayLogPath(cwd: string, logPath: string): string {
  return isAbsolute(logPath) && !relative(cwd, logPath).startsWith("..") ? relative(cwd, logPath).replace(/\\/g, "/") : logPath;
}

export interface ParsedRunArgs { commandLine: string; limitBytes?: number; root?: string; shell?: ShellRequest }

export function parseRunArgs(args: readonly string[]): ParsedRunArgs | { error: string } {
  let limitBytes: number | undefined;
  let root: string | undefined;
  let shell: ShellRequest | undefined;
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") { i += 1; break; }
    if (arg === "--limit-bytes") {
      const value = Number(args[++i]);
      if (!Number.isFinite(value) || value <= 0) return { error: "--limit-bytes needs a positive number" };
      limitBytes = value;
      continue;
    }
    if (arg === "--root") {
      root = args[++i];
      if (root === undefined) return { error: "--root needs a directory" };
      continue;
    }
    if (arg === "--shell") {
      const value = args[++i];
      if (value === undefined || !(SHELL_REQUESTS as readonly string[]).includes(value)) {
        return { error: `--shell expects ${SHELL_REQUESTS.join(" | ")}` };
      }
      shell = value as ShellRequest;
      continue;
    }
    if (arg.startsWith("--")) return { error: `unknown option ${arg}` };
    break;
  }
  const tokens = args.slice(i);
  if (tokens.length === 0) return { error: "no command given" };
  return {
    commandLine: joinCommandTokens(tokens),
    ...(limitBytes !== undefined ? { limitBytes } : {}),
    ...(root !== undefined ? { root } : {}),
    ...(shell !== undefined ? { shell } : {}),
  };
}

export async function runRun(args: string[]): Promise<void> {
  if (args.length === 0 || wantsHelp(args.slice(0, args.indexOf("--") === -1 ? args.length : args.indexOf("--")))) {
    process.stdout.write(RUN_USAGE);
    return;
  }
  const parsed = parseRunArgs(args);
  if ("error" in parsed) {
    process.stderr.write(`tl run: ${parsed.error}\n${RUN_USAGE}`);
    process.exitCode = 1;
    return;
  }
  const cwd = process.cwd();
  const root = parsed.root !== undefined ? resolve(parsed.root) : findWorkspaceRoot(cwd);
  const shell = selectShell(process.env, process.platform, parsed.shell);
  let run: CapturedRun;
  try {
    run = await runCommandCaptured(parsed.commandLine, { cwd, shell });
  } catch (error) {
    process.stderr.write(`tl run: cannot start ${shell.command}: ${String((error as Error).message ?? error)}\n`);
    process.exitCode = 1;
    return;
  }
  let logPath: string;
  try {
    logPath = writeRunLog(root, parsed.commandLine, cwd, run);
  } catch (error) {
    // No log is no reason to hide the output: print it whole, say why.
    process.stdout.write(run.output);
    process.stderr.write(`tl run: full output not saved (${String((error as Error).message ?? error)})\n`);
    process.exitCode = exitCodeFor(run);
    return;
  }
  process.stdout.write(compressRunOutput({
    command: parsed.commandLine,
    output: run.output,
    exitCode: run.exitCode,
    signal: run.signal,
    logPath: displayLogPath(cwd, logPath),
    durationMs: run.durationMs,
    ...(parsed.limitBytes !== undefined ? { limitBytes: parsed.limitBytes } : {}),
  }));
  process.exitCode = exitCodeFor(run);
}
