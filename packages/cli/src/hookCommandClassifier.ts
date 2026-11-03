/**
 * hookCommandClassifier.ts — decides whether a shell command an agent ran is
 * a test/build command whose output is worth compressing (2026-11-03). The
 * post-tool-use hooks (hookAdapters.ts) shorten a recognised command's output
 * after it ran exactly as the agent wrote it; no hook rewrites a command.
 *
 * Client-agnostic: the input is the command string and whether the host will
 * run it in the background; the per-client hook adapters (hookAdapters.ts)
 * extract those two facts from each host's payload shape.
 *
 * CONSERVATIVE BY CONSTRUCTION. A command is recognised only when every token
 * is understood: one of the listed runners at the front (after optional
 * `VAR=value` assignments and an optional `cd <dir> && ` prefix), no
 * pipeline, redirection, chaining or substitution outside quotes (a `| tail`
 * or `| grep` already filters; a `> file` has nothing to compress), no watch
 * mode, no newline, and nothing already wrapped in `tl run`. Everything else,
 * output included, is left exactly as the host produced it.
 */

export type UntouchedReason =
  | "empty"
  | "background"
  | "too-long"
  | "multiline"
  | "already-wrapped"
  | "unbalanced-quotes"
  | "pipeline-or-redirect"
  | "compound"
  | "watch-mode"
  | "not-a-test-or-build-command";

export type CommandClassification =
  | {
    /** A recognised test/build command (the kind keeps its name from the dropped pre-tool rewrite). */
    kind: "rewrite";
    /** Which runner the command starts (`npm test`, `vitest`, `pytest`, `go test`, ...). */
    runner: string;
    /** The command without the `cd` prefix and a trailing `2>&1`. */
    inner: string;
    /** `cd <dir> && ` when the command had one, else "". */
    prefix: string;
  }
  | { kind: "untouched"; reason: UntouchedReason };

const MAX_COMMAND_LENGTH = 2000;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=[^\s"'`$;&|<>()]*$/;
const CD_PREFIX = /^cd\s+("[^"$`\\]+"|'[^']+'|[^\s;&|<>$`"'()]+)\s*&&\s*(\S.*)$/;
const TRAILING_STDERR_MERGE = /\s+2>&1\s*$/;
const ALREADY_WRAPPED = /(^|[\s"'/\\])tl(\.js|\.cmd)?["']?\s+run(\s|$)/;
const WATCH_FLAG = /^(--watch(All)?|--watch=.*|-w|--ui|--serve|--dev)$/;
const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(["npm", "pnpm", "yarn", "bun"]);
const RUNNER_BINARIES: Readonly<Record<string, string>> = {
  vitest: "vitest", jest: "jest", tsc: "tsc", eslint: "eslint", pytest: "pytest", "py.test": "pytest",
};
const PYTHON_LAUNCHERS: ReadonlySet<string> = new Set(["python", "python3", "py"]);
/**
 * A Windows launcher suffix: `npm.cmd test`, `npx.cmd vitest`, `go.exe test`
 * name the same runners. Copilot CLI's `powershell` tool cannot run `npm`
 * where the execution policy blocks `npm.ps1`, so agents type the `.cmd`
 * shim there (2026-11-03, live with Copilot CLI 1.0.105).
 */
const WINDOWS_LAUNCHER_SUFFIX = /\.(cmd|exe)$/i;
const launcherName = (token: string | undefined): string | undefined => token?.replace(WINDOWS_LAUNCHER_SUFFIX, "");

/** `npm run <script>`: tests, builds, lint and typecheck; never a dev server or a watcher. */
function scriptQualifies(name: string): boolean {
  if (/(^|[:.\-_])(watch|dev|serve|start|preview)([:.\-_]|$)/.test(name)) return false;
  return /^(test|build)/.test(name) || name === "lint" || name === "typecheck";
}

/**
 * Walks the command once, tracking quotes. Returns the reason the command
 * cannot be recognised as a whole, or undefined when it is a single simple
 * command. `$(`, backticks and `${` are refused even inside double quotes
 * (the shell still runs them there); single quotes make everything literal.
 */
function unsafeShellSyntax(command: string): UntouchedReason | undefined {
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote === "'") { if (ch === "'") quote = undefined; continue; }
    if (quote === '"') {
      if (ch === "\\") { i += 1; continue; }
      if (ch === '"') { quote = undefined; continue; }
      if (ch === "`" || (ch === "$" && (command[i + 1] === "(" || command[i + 1] === "{"))) return "pipeline-or-redirect";
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "\\") { i += 1; continue; }
    if (ch === "|" || ch === "<" || ch === ">") return "pipeline-or-redirect";
    if (ch === ";" || ch === "&" || ch === "(" || ch === ")" || ch === "{" || ch === "}") return "compound";
    if (ch === "`" || (ch === "$" && (command[i + 1] === "(" || command[i + 1] === "{"))) return "pipeline-or-redirect";
  }
  return quote === undefined ? undefined : "unbalanced-quotes";
}

/** The runner a token list names, or undefined. Tokens are whitespace-split; only the lead matters. */
function recognizeRunner(tokens: readonly string[]): string | undefined {
  let start = 0;
  while (start < tokens.length && ENV_ASSIGNMENT.test(tokens[start]!)) start += 1;
  const t = (offset: number): string | undefined => tokens[start + offset];
  const t0 = launcherName(t(0));
  if (t0 === undefined) return undefined;
  if (PACKAGE_MANAGERS.has(t0)) {
    const t1 = t(1);
    if (t1 === undefined) return undefined;
    if (t1 === "test" || t1 === "t" || t1 === "tst") return `${t0} test`;
    if (t1 === "run" || (t0 === "npm" && t1 === "run-script")) {
      const script = t(2);
      return script !== undefined && !script.startsWith("-") && scriptQualifies(script) ? `${t0} run ${script}` : undefined;
    }
    if (t0 === "pnpm" && t1 === "exec") return recognizeBinary(tokens.slice(start + 2));
    if (t0 === "yarn" && RUNNER_BINARIES[t1] !== undefined) return RUNNER_BINARIES[t1];
    if (t0 !== "npm" && scriptQualifies(t1)) return `${t0} ${t1}`;
    return undefined;
  }
  if (t0 === "npx" || t0 === "bunx") {
    let offset = 1;
    while (t(offset) === "--yes" || t(offset) === "-y" || t(offset) === "--no-install" || t(offset) === "--no") offset += 1;
    return recognizeBinary(tokens.slice(start + offset));
  }
  if (RUNNER_BINARIES[t0] !== undefined) return RUNNER_BINARIES[t0];
  if (PYTHON_LAUNCHERS.has(t0) && t(1) === "-m" && t(2) === "pytest") return "pytest";
  if ((t0 === "uv" || t0 === "poetry") && t(1) === "run" && t(2) === "pytest") return "pytest";
  if (t0 === "go" && (t(1) === "test" || t(1) === "build" || t(1) === "vet")) return `go ${t(1)}`;
  if (t0 === "cargo" && (t(1) === "test" || t(1) === "build" || t(1) === "check" || t(1) === "clippy")) return `cargo ${t(1)}`;
  return undefined;
}

function recognizeBinary(tokens: readonly string[]): string | undefined {
  const binary = launcherName(tokens[0]);
  return binary !== undefined ? RUNNER_BINARIES[binary] : undefined;
}

/**
 * Classifies one shell command. `background` is the host's own flag (Claude
 * Code's `run_in_background`, Copilot's async mode): a command the agent
 * will poll later gets no wrapper, since nothing reads its result inline.
 */
export function classifyShellCommand(command: string, options: { background?: boolean } = {}): CommandClassification {
  const trimmed = command.trim();
  if (trimmed === "") return { kind: "untouched", reason: "empty" };
  if (options.background === true) return { kind: "untouched", reason: "background" };
  if (trimmed.length > MAX_COMMAND_LENGTH) return { kind: "untouched", reason: "too-long" };
  if (/[\r\n]/.test(trimmed)) return { kind: "untouched", reason: "multiline" };
  if (ALREADY_WRAPPED.test(trimmed)) return { kind: "untouched", reason: "already-wrapped" };
  let prefix = "";
  let rest = trimmed;
  const cd = CD_PREFIX.exec(trimmed);
  if (cd !== null) {
    prefix = `cd ${cd[1]} && `;
    rest = cd[2]!;
  }
  rest = rest.replace(TRAILING_STDERR_MERGE, "");
  const unsafe = unsafeShellSyntax(rest);
  if (unsafe !== undefined) return { kind: "untouched", reason: unsafe };
  const tokens = rest.split(/\s+/).filter(Boolean);
  if (tokens.some((token) => WATCH_FLAG.test(token))) return { kind: "untouched", reason: "watch-mode" };
  const runner = recognizeRunner(tokens);
  if (runner === undefined) return { kind: "untouched", reason: "not-a-test-or-build-command" };
  return { kind: "rewrite", runner, inner: rest, prefix };
}
