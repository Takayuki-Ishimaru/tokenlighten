/**
 * hookAdapters.ts — thin per-client adapters over the client-agnostic hook
 * core (2026-11-03).
 *
 * The core is three things that know nothing about any host: the command
 * classifier (hookCommandClassifier.ts), the `tl run` compressor and its log
 * (runOutput.ts, commands/run.ts) and the compaction marker
 * (compactionMarker.ts). Since 2026-11-03 no adapter rewrites a command: the
 * agent's command runs exactly as written under the host's own permission
 * rules, and only the output the model sees afterwards is shortened.
 * Each adapter here maps ONE host's documented hook input/output contract
 * onto them and nothing more. Where a host's contract lacks a capability, the
 * adapter reports it as unsupported instead of imitating it.
 *
 * Contracts, as documented on 2026-11-03:
 *
 * - Claude Code (https://code.claude.com/docs/en/hooks). Input: snake_case
 *   (`hook_event_name`, `tool_name`, `tool_input`, `tool_response`, `cwd`,
 *   `source`, `trigger`). Output compression runs AFTER the command, on
 *   PostToolUse: `hookSpecificOutput.updatedToolOutput` "Replaces the tool's
 *   output with the provided value before it is sent to Claude" and must
 *   match the tool's output shape (for `Bash`: `{stdout, stderr,
 *   interrupted, isImage}`; a value that does not match is ignored and the
 *   original output is used). The command itself runs exactly as the agent
 *   wrote it, under the user's own permission rules: no rewrite, no
 *   permission decision, no prompt. PreToolUse prints nothing for Claude
 *   Code (2026-11-03, live findings with Claude Code 2.1.309 `-p`: the old
 *   `updatedInput` + `permissionDecision: "ask"` rewrite was DENIED in
 *   headless/SDK runs (`permission_denied`, reason type `hook`) and prompted
 *   on every call interactively; `updatedInput` without a decision is
 *   checked against the user's rules as REWRITTEN, so an allow rule such as
 *   `Bash(npm test)` no longer matched `node … run -- npm test`). Limit,
 *   observed live on the same day: a Bash command that exits non-zero fires
 *   PostToolUseFailure instead (`error`: "Exit code N" plus the output), whose
 *   only output field is `additionalContext`; an `updatedToolOutput` there is
 *   ignored, so a FAILING run reaches the model whole. The `Bash` tool is bash
 *   (Git Bash on Windows). PreCompact and SessionStart (`source`
 *   clear|compact) exist; a hook's stdout on SessionStart becomes context, so
 *   the marker events print nothing.
 * - Copilot CLI and VS Code `.github/hooks`
 *   (https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference,
 *   https://code.visualstudio.com/docs/agent-customization/hooks). Input:
 *   camelCase (`toolName`, `toolArgs`, `toolResult`, `cwd`, `source`,
 *   `trigger`); the PascalCase aliases send snake_case, read the same way.
 *   postToolUse output: `modifiedResult` (`resultType: "success"`,
 *   `textResultForLlm`) replaces what the model sees. Tool names are `bash`,
 *   `powershell` (the reference names the tools but not their argument
 *   shape, so a string `command` field is required) and VS Code's
 *   `run_in_terminal` (VS Code's Local harness may not honour
 *   `modifiedResult`; the original output then stands). preToolUse prints
 *   nothing (2026-11-03, live with Copilot CLI 1.0.105 `-p`: the
 *   `modifiedArgs` rewrite was denied, "Denied, no one to approve", even with
 *   `--allow-tool shell`, and the model retried it about eight times). A
 *   non-zero exit on preToolUse DENIES the call, so this process always exits
 *   0. preCompact is notification-only (enough to write the marker);
 *   sessionStart sends `source` startup|resume|new.
 * - Codex (https://developers.openai.com/codex/hooks). Input: the Claude
 *   Code shape plus `turn_id`. `updatedInput` is honoured only together with
 *   `permissionDecision: "allow"` ("ask" is parsed but not supported), so the
 *   command rewrite was never offered for Codex, and no tool hook is
 *   installed there: the agent runs `tl run` by hand. PreCompact, PostCompact
 *   and SessionStart (`source` clear|compact) exist and write the marker.
 */

import type { AgentHookClient, AgentHookEvent } from "@tokenlighten/types";
import { classifyShellCommand } from "./hookCommandClassifier.js";
import { recordCompactionEpoch, type CompactionNote } from "./compactionMarker.js";
import { findWorkspaceRoot } from "./runtimeRoot.js";
import { compressRunOutput, DEFAULT_RUN_OUTPUT_LIMIT_BYTES } from "./runOutput.js";
import { displayLogPath, writeRunLog, type CapturedRun } from "./commands/run.js";

export const HOOK_CLIENTS: readonly AgentHookClient[] = ["claude-code", "codex", "copilot"];
export const HOOK_EVENTS: readonly AgentHookEvent[] = ["pre-tool-use", "post-tool-use", "pre-compact", "post-compact", "session-start"];

/** Spellings the installer and users may pass for `--client`. */
export function normalizeHookClient(value: string): AgentHookClient | undefined {
  switch (value.trim().toLowerCase()) {
    case "claude-code":
    case "claude":
      return "claude-code";
    case "codex":
      return "codex";
    case "copilot":
    case "copilot-cli":
    case "vscode":
    case "github-copilot":
      return "copilot";
    default:
      return undefined;
  }
}

export function isHookEvent(value: string): value is AgentHookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(value);
}

/** Session-start sources after which the model holds none of what was served. */
const RESET_SOURCES: ReadonlySet<string> = new Set(["compact", "clear", "new"]);

/** The shell family behind a terminal tool; "unknown" when the host does not say which. */
export type ToolShell = "bash" | "powershell" | "unknown";

/**
 * The shell behind a client's terminal tool, or undefined for a tool whose
 * `command` is not a shell command line: the tools whose results the
 * post-tool-use adapters read (Claude Code `Bash`; Copilot `bash`,
 * `powershell`, VS Code `run_in_terminal`).
 */
export function shellForTool(client: AgentHookClient, toolName: string | undefined): ToolShell | undefined {
  const name = toolName?.toLowerCase();
  if (name === undefined) return undefined;
  if (client === "claude-code") return name === "bash" ? "bash" : undefined;
  if (client === "copilot") {
    if (name === "bash") return "bash";
    if (name === "powershell") return "powershell";
    if (name === "run_in_terminal" || name === "runinterminal") return "unknown";
  }
  return undefined;
}

export interface HookPayloadView {
  toolName?: string;
  toolInput: Record<string, unknown>;
  /** The host's own key for the tool arguments (`tool_input` or `toolArgs`). */
  toolInputKey: "tool_input" | "toolArgs";
  command?: string;
  background: boolean;
  cwd?: string;
  source?: string;
  /** Claude Code PostToolUse: what the tool returned (`tool_response`), when it is an object. */
  toolResponse?: Record<string, unknown>;
  /** Copilot postToolUse: `toolResult` (or the alias payload's `tool_result`), when it is an object. */
  toolResult?: Record<string, unknown>;
  /** PostToolUse: the host's own `duration_ms`, when it sends one. */
  durationMs?: number;
}

/** Payloads are distinguishable: camelCase keys are Copilot's, `turn_id` is Codex's, the rest Claude Code's. */
export function detectHookClient(payload: Record<string, unknown>): AgentHookClient {
  if ("toolName" in payload || "toolArgs" in payload || "sessionId" in payload) return "copilot";
  if ("turn_id" in payload) return "codex";
  return "claude-code";
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
    } catch {
      return undefined;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Reads the fields every adapter needs from either field spelling. */
export function viewHookPayload(payload: Record<string, unknown>): HookPayloadView {
  const camel = "toolArgs" in payload || "toolName" in payload;
  const toolInput = asObject(camel ? payload["toolArgs"] : payload["tool_input"]) ?? {};
  const toolName = typeof payload["tool_name"] === "string" ? payload["tool_name"]
    : typeof payload["toolName"] === "string" ? payload["toolName"] : undefined;
  const command = typeof toolInput["command"] === "string" ? toolInput["command"] : undefined;
  const background = toolInput["run_in_background"] === true
    || toolInput["isBackground"] === true
    || toolInput["async"] === true
    || toolInput["mode"] === "async";
  const toolResponse = asObject(payload["tool_response"]);
  const toolResult = asObject(payload["toolResult"]) ?? asObject(payload["tool_result"]);
  const durationMs = payload["duration_ms"];
  return {
    ...(toolName !== undefined ? { toolName } : {}),
    toolInput,
    toolInputKey: camel ? "toolArgs" : "tool_input",
    ...(command !== undefined ? { command } : {}),
    background,
    ...(typeof payload["cwd"] === "string" ? { cwd: payload["cwd"] } : {}),
    ...(typeof payload["source"] === "string" ? { source: payload["source"] } : {}),
    ...(toolResponse !== undefined ? { toolResponse } : {}),
    ...(toolResult !== undefined ? { toolResult } : {}),
    ...(typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0 ? { durationMs } : {}),
  };
}

export interface HookHandlerDependencies {
  recordCompaction?: (workspaceRoot: string, note: CompactionNote) => void;
  resolveRoot?: (cwd: string | undefined) => string;
  /** Saves the full output of a compressed run; default: `tl run`'s own log writer (commands/run.ts `writeRunLog`). */
  writeLog?: (workspaceRoot: string, commandLine: string, cwd: string, run: CapturedRun) => string;
}

export interface HookHandlerResult {
  /** Exactly what the process prints; "" prints nothing. */
  stdout: string;
  action: "compress" | "marker" | "none";
  /** Why nothing happened, for `TL_HOOK_DEBUG`. */
  detail?: string;
}

const NOTHING = (detail: string): HookHandlerResult => ({ stdout: "", action: "none", detail });

const resolveRootWith = (deps: HookHandlerDependencies): ((cwd: string | undefined) => string) =>
  deps.resolveRoot ?? ((cwd) => findWorkspaceRoot(cwd ?? process.cwd()));

/** First header line of a compressed result: the agent ran its own command, not `tl run`. */
const COMPRESSED_LABEL = "TokenLighten compressed this output";

interface RunToCompress {
  command: string;
  /** The full text the host would show (stdout+stderr), which the log keeps whole. */
  output: string;
  exitCode: number | null;
  status?: string;
  /** Budget for the compressed text (default: the compressor's own). */
  limitBytes?: number;
  /** What the log keeps and the budget check measures, when it differs from `output` (the host's whole text). */
  logged?: string;
}

/**
 * The shared post-tool-use core (2026-11-03): an output within the
 * compressor's budget is left alone; a longer one is saved through `tl run`'s
 * log writer and replaced by `tl run`'s ranking compression, whose second line
 * names the log. No log, no compression: the original output then stands.
 */
function compressFinishedRun(view: HookPayloadView, deps: HookHandlerDependencies, client: AgentHookClient, run: RunToCompress): { text: string } | string {
  const logged = run.logged ?? run.output;
  const outputBytes = Buffer.byteLength(logged, "utf8");
  if (outputBytes <= DEFAULT_RUN_OUTPUT_LIMIT_BYTES) return `output fits the budget (${outputBytes} <= ${DEFAULT_RUN_OUTPUT_LIMIT_BYTES} bytes)`;
  const cwd = view.cwd ?? process.cwd();
  const writeLog = deps.writeLog
    ?? ((root, commandLine, logCwd, captured) => writeRunLog(root, commandLine, logCwd, captured, new Date(), `tl hook post-tool-use (${client})`));
  let logPath: string;
  try {
    logPath = writeLog(resolveRootWith(deps)(view.cwd), run.command, cwd, { exitCode: run.exitCode, signal: null, output: logged, durationMs: view.durationMs ?? 0 });
  } catch (error) {
    return `log not written: ${String((error as Error).message ?? error)}`;
  }
  return {
    text: compressRunOutput({
      command: run.command,
      output: run.output,
      exitCode: run.exitCode,
      logPath: displayLogPath(cwd, logPath),
      label: COMPRESSED_LABEL,
      ...(run.status !== undefined ? { status: run.status } : {}),
      ...(view.durationMs !== undefined ? { durationMs: view.durationMs } : {}),
      ...(run.limitBytes !== undefined ? { limitBytes: run.limitBytes } : {}),
    }),
  };
}

/** The recognised test/build command of a shell tool call, or the reason there is none. */
function recognisedCommand(view: HookPayloadView): string | { reason: string } {
  if (view.command === undefined) return { reason: "no command string" };
  const classification = classifyShellCommand(view.command, { background: view.background });
  if (classification.kind === "untouched") return { reason: `untouched: ${classification.reason}` };
  return view.command;
}

/**
 * Claude Code PostToolUse (2026-11-03): shortens what the model sees of a
 * test/build run that already happened. Acts only on Claude Code's `Bash`
 * tool, a command the classifier recognises (its rewrite is not used), a
 * `tool_response` with string `stdout`/`stderr` and a boolean `interrupted`,
 * and a combined output over the compressor's budget. The reply is
 * `updatedToolOutput` in the Bash output shape, with `interrupted` and
 * `isImage` exactly as received; anything else prints nothing, so the
 * original output stands.
 *
 * Exit status: PostToolUse fires only for a call Claude Code counts as a
 * success, which for these runners is exit 0 (a non-zero exit fires
 * PostToolUseFailure, live with 2.1.309, whose output cannot be replaced);
 * the header says so. Should a response carry Claude Code's
 * `returnCodeInterpretation` (its note for a non-zero code it does not treat
 * as an error), that note is the status instead, so no exit information is
 * lost.
 */
function claudePostToolUse(view: HookPayloadView, deps: HookHandlerDependencies): HookHandlerResult {
  if (view.toolName !== "Bash") return NOTHING(`tool ${view.toolName ?? "(none)"} is not Claude Code's Bash`);
  const command = recognisedCommand(view);
  if (typeof command !== "string") return NOTHING(command.reason);
  const response = view.toolResponse;
  if (response === undefined) return NOTHING("no tool_response object");
  const { stdout, stderr, interrupted, isImage } = response;
  if (typeof stdout !== "string" || typeof stderr !== "string") return NOTHING("tool_response has no string stdout/stderr");
  if (typeof interrupted !== "boolean") return NOTHING("tool_response.interrupted is not a boolean");
  // An image result carries image data in stdout; there is nothing to rank in it.
  if (isImage !== undefined && isImage !== false) return NOTHING("tool_response is an image or has a non-boolean isImage");
  const output = stdout === "" || stderr === "" || stdout.endsWith("\n") ? `${stdout}${stderr}` : `${stdout}\n${stderr}`;
  const rawInterpretation = response["returnCodeInterpretation"];
  const interpretation = typeof rawInterpretation === "string" && rawInterpretation.trim() !== "" ? rawInterpretation.trim() : undefined;
  const status = interrupted ? "interrupted" : interpretation !== undefined ? `non-zero exit (${interpretation})` : undefined;
  const compressed = compressFinishedRun(view, deps, "claude-code", {
    command,
    output,
    exitCode: status === undefined ? 0 : null,
    ...(status !== undefined ? { status } : {}),
  });
  if (typeof compressed === "string") return NOTHING(compressed);
  const reply = {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      updatedToolOutput: { stdout: compressed.text, stderr: "", interrupted, ...(isImage !== undefined ? { isImage } : {}) },
    },
  };
  return { stdout: `${JSON.stringify(reply)}\n`, action: "compress" };
}

/**
 * The status line Copilot CLI appends to a shell result
 * (`<shellId: 0 completed with exit code 1>`, live with 1.0.105 on
 * 2026-11-03), with the exit code when it names one.
 */
const COPILOT_SHELL_STATUS = /^<shellId:[^>\n]*>$/;
const COPILOT_EXIT_CODE = /\bexit code (-?\d+)\b/;

/**
 * Copilot postToolUse (2026-11-03): the same compression for Copilot CLI's
 * `bash` and `powershell` tools and VS Code's `run_in_terminal`. Input:
 * `toolResult: {resultType: "success", textResultForLlm}` (the alias payload's
 * `tool_result: {result_type, text_result_for_llm}` is read too); reply:
 * `modifiedResult: {resultType: "success", textResultForLlm}`, which
 * "Must have resultType: success" (cli-hooks-reference). Copilot CLI 1.0.105
 * reports a non-zero shell exit as a SUCCESSFUL result whose last line is
 * `<shellId: N completed with exit code M>`, so failing runs are compressed
 * too; that status line is kept verbatim as the last line, and its code is
 * the compressor's exit code. A result of any other type prints nothing.
 */
function copilotPostToolUse(view: HookPayloadView, deps: HookHandlerDependencies): HookHandlerResult {
  if (shellForTool("copilot", view.toolName) === undefined) return NOTHING(`tool ${view.toolName ?? "(none)"} is not a shell tool`);
  const command = recognisedCommand(view);
  if (typeof command !== "string") return NOTHING(command.reason);
  const result = view.toolResult;
  if (result === undefined) return NOTHING("no toolResult object");
  const resultType = result["resultType"] ?? result["result_type"];
  const text = result["textResultForLlm"] ?? result["text_result_for_llm"];
  if (resultType !== "success") return NOTHING(`toolResult type ${String(resultType)} is not success`);
  if (typeof text !== "string") return NOTHING("toolResult has no string textResultForLlm");
  const lines = text.replace(/\s+$/, "").split(/\r?\n/);
  const last = lines[lines.length - 1]?.trim() ?? "";
  const trailer = COPILOT_SHELL_STATUS.test(last) ? last : undefined;
  const code = trailer !== undefined ? COPILOT_EXIT_CODE.exec(trailer) : null;
  const output = trailer !== undefined ? `${lines.slice(0, -1).join("\n")}\n` : text;
  const compressed = compressFinishedRun(view, deps, "copilot", {
    command,
    output,
    // The log keeps the host's text whole, status line included.
    logged: text,
    exitCode: code !== null ? Number(code[1]) : null,
    ...(trailer !== undefined ? { limitBytes: DEFAULT_RUN_OUTPUT_LIMIT_BYTES - Buffer.byteLength(trailer, "utf8") - 1 } : {}),
  });
  if (typeof compressed === "string") return NOTHING(compressed);
  const textResultForLlm = trailer !== undefined ? `${compressed.text}${trailer}\n` : compressed.text;
  return { stdout: `${JSON.stringify({ modifiedResult: { resultType: "success", textResultForLlm } })}\n`, action: "compress" };
}

function markerEvent(event: AgentHookEvent, client: AgentHookClient, view: HookPayloadView, deps: HookHandlerDependencies): HookHandlerResult {
  if (event === "session-start" && (view.source === undefined || !RESET_SOURCES.has(view.source))) {
    return NOTHING(`session-start source ${view.source ?? "(none)"} keeps the context`);
  }
  const root = resolveRootWith(deps)(view.cwd);
  const record = deps.recordCompaction ?? ((workspaceRoot, note) => { recordCompactionEpoch(workspaceRoot, note); });
  try {
    record(root, { event, client, ...(view.source !== undefined ? { source: view.source } : {}) });
  } catch (error) {
    return NOTHING(`marker not written: ${String((error as Error).message ?? error)}`);
  }
  return { stdout: "", action: "marker" };
}

/** Why pre-tool-use prints nothing, per client (2026-11-03: no hook rewrites a command any more). */
const NO_PRE_TOOL_USE: Readonly<Record<AgentHookClient, string>> = {
  "claude-code": "claude-code: the command runs as written; post-tool-use compresses its output",
  copilot: "copilot: the command runs as written; post-tool-use compresses its output",
  codex: "codex honours updatedInput only with permissionDecision allow, which TokenLighten never sends; run tl run by hand",
};

/**
 * Handles one hook invocation. Never throws: a malformed payload is "nothing
 * to do", because a hook error would block (Copilot) or be logged as a
 * failure (the others) for a command TokenLighten was only going to shorten.
 *
 * pre-tool-use prints nothing for every client (2026-11-03), so a hook file
 * from an earlier install can never deny, prompt or rewrite. Live findings:
 * Claude Code 2.1.309 `-p` DENIED the `updatedInput` + `ask` rewrite
 * (`permission_denied`, reason type `hook`), and without a decision checked
 * the user's allow rules against the rewritten `node … run -- npm test`;
 * Copilot CLI 1.0.105 `-p` denied the `modifiedArgs` rewrite ("Denied, no one
 * to approve") even with `--allow-tool shell`, and the model retried the
 * denied call about eight times.
 */
export function handleHookEvent(
  event: AgentHookEvent,
  client: AgentHookClient | undefined,
  payloadText: string,
  deps: HookHandlerDependencies = {},
): HookHandlerResult {
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = payloadText.trim() === "" ? {} : JSON.parse(payloadText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return NOTHING("payload is not a JSON object");
    payload = parsed as Record<string, unknown>;
  } catch {
    return NOTHING("payload is not JSON");
  }
  const resolvedClient = client ?? detectHookClient(payload);
  if (event === "pre-tool-use") return NOTHING(NO_PRE_TOOL_USE[resolvedClient]);
  const view = viewHookPayload(payload);
  if (event === "post-tool-use") {
    if (resolvedClient === "claude-code") return claudePostToolUse(view, deps);
    if (resolvedClient === "copilot") return copilotPostToolUse(view, deps);
    return NOTHING("codex: TokenLighten installs no tool hooks there; run tl run by hand");
  }
  return markerEvent(event, resolvedClient, view, deps);
}
