/**
 * hookAdapters.spec.ts — each client's hook input/output mapping, with
 * payloads shaped exactly as the hosts document them, or as the live hosts
 * sent them (2026-11-03): Claude Code https://code.claude.com/docs/en/hooks
 * (2.1.309), Copilot CLI
 * https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference
 * (1.0.105), Codex https://developers.openai.com/codex/hooks.
 *
 * Since 2026-11-03 no hook rewrites a command: pre-tool-use prints nothing,
 * and post-tool-use replaces a long test/build output with the `tl run`
 * compression after the command ran as written.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectHookClient, handleHookEvent, normalizeHookClient, shellForTool, viewHookPayload, type HookHandlerDependencies } from "../hookAdapters.js";
import { compactionMarkerPath, readCompactionMarker } from "../compactionMarker.js";
import { DEFAULT_RUN_OUTPUT_LIMIT_BYTES } from "../runOutput.js";

const roots: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "tl-hook-"));
  mkdirSync(join(root, ".git"));
  roots.push(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** The run logs a post-tool-use call wrote under `root`. */
function runLogs(root: string): string[] {
  const directory = join(root, ".tokenlighten", ".runtime", "run");
  return existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith(".log")).map((name) => join(directory, name)) : [];
}

/** `npm test` of a node:test file: many passing tests that each print noise, one failure (the live workspace's shape). */
function nodeTestOutput(passing = 60): string {
  const lines = ["", "> hooklive@1.0.0 test", "> node --test --test-reporter=spec", ""];
  for (let i = 0; i < passing; i++) lines.push(`noise line for case ${i}: ${"x".repeat(60)}`);
  for (let i = 0; i < passing; i++) lines.push(`✔ passing case ${i} (0.${i}ms)`);
  lines.push(
    "✖ adds two numbers (0.7077ms)",
    `ℹ tests ${passing + 1}`, "ℹ suites 0", `ℹ pass ${passing}`, "ℹ fail 1", "ℹ cancelled 0", "ℹ skipped 0", "ℹ todo 0", "ℹ duration_ms 107.3751",
    "",
    "✖ failing tests:",
    "",
    "test at test\\math.test.js:4:1",
    "✖ adds two numbers (0.7077ms)",
    "  AssertionError [ERR_ASSERTION]: EXPECTED_FAILURE_MARKER sum is wrong",
    "  ",
    "  2 !== 3",
    "  ",
    "      at TestContext.<anonymous> (C:\\ws\\test\\math.test.js:4:41)",
    "      at Test.runInAsyncScope (node:async_hooks:227:14)",
    "      at Test.run (node:internal/test_runner/test:1402:25)",
    "      at Test.processPendingSubtests (node:internal/test_runner/test:974:18) {",
    "    generatedMessage: false,",
    "    code: 'ERR_ASSERTION',",
    "    actual: 2,",
    "    expected: 3,",
    "    operator: 'strictEqual',",
    "    diff: 'simple'",
    "  }",
  );
  return `${lines.join("\n")}\n`;
}

/** Claude Code's PreToolUse payload. */
const claudePre = (command: string, extra: Record<string, unknown> = {}): string => JSON.stringify({
  session_id: "abc123",
  transcript_path: "/home/user/.claude/projects/x/transcript.jsonl",
  cwd: "/home/user/my-project",
  permission_mode: "default",
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command, description: "Run test suite", timeout: 120000, run_in_background: false, ...extra },
  tool_use_id: "toolu_01ABC123",
});

/** Claude Code's PostToolUse payload as 2.1.309 sent it live (`tool_response` = the Bash output object). */
function claudePost(cwd: string, command: string, toolResponse: unknown, options: { toolName?: string; input?: Record<string, unknown> } = {}): string {
  return JSON.stringify({
    session_id: "cf18c0fa",
    transcript_path: "C:\\Users\\u\\.claude\\projects\\x\\cf18c0fa.jsonl",
    cwd,
    permission_mode: "default",
    effort: { level: "medium" },
    hook_event_name: "PostToolUse",
    tool_name: options.toolName ?? "Bash",
    tool_input: { command, description: "Run npm test", ...options.input },
    tool_response: toolResponse,
    tool_use_id: "toolu_01AxXNUZQmNq65P2UqAtmjw3",
    duration_ms: 4291,
  });
}

const bashResponse = (stdout: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  stdout,
  stderr: "\nShell cwd was reset to C:\\ws",
  interrupted: false,
  isImage: false,
  noOutputExpected: false,
  ...extra,
});

interface ClaudeReply { hookSpecificOutput: { hookEventName: string; updatedToolOutput: Record<string, unknown> & { stdout: string } } }

describe("Claude Code adapter", () => {
  it.each([
    ["a recognised test command", claudePre("npm test")],
    ["a recognised build command", claudePre("npx tsc --noEmit -p packages/cli")],
    ["a non-test command", claudePre("git status")],
    ["a non-shell tool", JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/x" } })],
    ["a malformed payload", "{not json"],
  ])("pre-tool-use prints nothing for %s: no rewrite, no permission decision, no prompt", (_label, payload) => {
    const result = handleHookEvent("pre-tool-use", "claude-code", payload);
    expect(result).toMatchObject({ stdout: "", action: "none" });
  });

  it("post-tool-use replaces a long recognised run with the compression, keeping the failure, and saves the whole output", () => {
    const root = fixture();
    const stdout = nodeTestOutput();
    const response = bashResponse(stdout);
    expect(Buffer.byteLength(stdout)).toBeGreaterThan(DEFAULT_RUN_OUTPUT_LIMIT_BYTES);
    const result = handleHookEvent("post-tool-use", "claude-code", claudePost(root, "npm test", response), { resolveRoot: () => root });
    expect(result.action).toBe("compress");
    expect(result.stdout.endsWith("\n")).toBe(true);
    const reply = JSON.parse(result.stdout) as ClaudeReply;
    expect(Object.keys(reply)).toEqual(["hookSpecificOutput"]);
    expect(reply.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(Object.keys(reply.hookSpecificOutput)).toEqual(["hookEventName", "updatedToolOutput"]);
    const output = reply.hookSpecificOutput.updatedToolOutput;
    expect(output).toEqual({ stdout: expect.any(String), stderr: "", interrupted: false, isImage: false });
    const text = output.stdout;
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(DEFAULT_RUN_OUTPUT_LIMIT_BYTES);
    expect(text.split("\n")[0]).toBe("TokenLighten compressed this output: exit 0 after 4.3s (node-test)");
    expect(text).toContain("EXPECTED_FAILURE_MARKER sum is wrong");
    expect(text).toContain("✖ adds two numbers");
    expect(text).toContain("ℹ fail 1");
    expect(text).not.toContain("noise line for case 30");
    // The full log: written by tl run's own writer under the workspace root, named in the second line.
    const logs = runLogs(root);
    expect(logs).toHaveLength(1);
    const logLine = text.split("\n")[1]!;
    expect(logLine).toMatch(/^full log: \.tokenlighten\/\.runtime\/run\/\d{8}-\d{6}-[0-9a-f]{6}\.log \(\d+ bytes, \d+ lines, 1 failure header\)$/);
    expect(logs[0]!.replace(/\\/g, "/")).toContain(logLine.slice("full log: ".length).split(" (")[0]!);
    const log = readFileSync(logs[0]!, "utf8");
    expect(log.split("\n")[0]).toBe("# tl hook post-tool-use (claude-code): npm test");
    expect(log).toContain(`${stdout}\nShell cwd was reset to C:\\ws`);
    expect(log).toContain("noise line for case 30");
    // Never a permission decision.
    expect(result.stdout).not.toMatch(/permissionDecision|"allow"|"ask"/);
  });

  it("keeps interrupted and isImage exactly as received, and an exit note Claude Code gives stays in the status", () => {
    const root = fixture();
    const deps: HookHandlerDependencies = { resolveRoot: () => root };
    const interrupted = handleHookEvent("post-tool-use", "claude-code", claudePost(root, "npx vitest run", { stdout: nodeTestOutput(), stderr: "", interrupted: true }), deps);
    const interruptedOutput = (JSON.parse(interrupted.stdout) as ClaudeReply).hookSpecificOutput.updatedToolOutput;
    expect(interruptedOutput).toEqual({ stdout: expect.any(String), stderr: "", interrupted: true });
    expect(interruptedOutput.stdout.split("\n")[0]).toBe("TokenLighten compressed this output: interrupted after 4.3s (node-test)");
    const interpreted = handleHookEvent("post-tool-use", "claude-code", claudePost(root, "npm test", bashResponse(nodeTestOutput(), { returnCodeInterpretation: "Some tests failed" })), deps);
    const interpretedOutput = (JSON.parse(interpreted.stdout) as ClaudeReply).hookSpecificOutput.updatedToolOutput;
    expect(interpretedOutput).toMatchObject({ stderr: "", interrupted: false, isImage: false });
    expect(interpretedOutput.stdout.split("\n")[0]).toBe("TokenLighten compressed this output: non-zero exit (Some tests failed) after 4.3s (node-test)");
  });

  it("leaves an output within the budget alone and writes no log", () => {
    const root = fixture();
    const result = handleHookEvent("post-tool-use", "claude-code", claudePost(root, "npm test", bashResponse(nodeTestOutput(3))), { resolveRoot: () => root });
    expect(result).toMatchObject({ stdout: "", action: "none", detail: expect.stringContaining("fits the budget") });
    expect(runLogs(root)).toEqual([]);
  });

  it.each([
    ["an unrecognised command", (root: string) => claudePost(root, "git log -p", bashResponse(nodeTestOutput()))],
    ["a pipeline that already filters", (root: string) => claudePost(root, "npm test 2>&1 | tail -40", bashResponse(nodeTestOutput()))],
    ["a background run", (root: string) => claudePost(root, "npm test", bashResponse(nodeTestOutput()), { input: { run_in_background: true } })],
    ["a non-Bash tool", (root: string) => claudePost(root, "npm test", bashResponse(nodeTestOutput()), { toolName: "PowerShell" })],
    ["an image result", (root: string) => claudePost(root, "npm test", bashResponse(nodeTestOutput(), { isImage: true }))],
    ["a non-boolean isImage", (root: string) => claudePost(root, "npm test", bashResponse(nodeTestOutput(), { isImage: "no" }))],
    ["no tool_response", (root: string) => claudePost(root, "npm test", undefined)],
    ["a string tool_response", (root: string) => claudePost(root, "npm test", nodeTestOutput())],
    ["a stdout that is not a string", (root: string) => claudePost(root, "npm test", { stdout: ["x"], stderr: "", interrupted: false, isImage: false })],
    ["a missing stderr", (root: string) => claudePost(root, "npm test", { stdout: nodeTestOutput(), interrupted: false, isImage: false })],
    ["a missing interrupted flag", (root: string) => claudePost(root, "npm test", { stdout: nodeTestOutput(), stderr: "", isImage: false })],
    ["a malformed payload", () => "{not json"],
    ["an empty payload", () => ""],
    ["a JSON array", () => "[]"],
  ])("post-tool-use prints nothing for %s", (_label, payload) => {
    const root = fixture();
    const result = handleHookEvent("post-tool-use", "claude-code", payload(root), { resolveRoot: () => root });
    expect(result).toMatchObject({ stdout: "", action: "none" });
    expect(runLogs(root)).toEqual([]);
  });

  it("prints nothing when the full log cannot be saved: the output is never shortened without it", () => {
    const root = fixture();
    const result = handleHookEvent("post-tool-use", "claude-code", claudePost(root, "npm test", bashResponse(nodeTestOutput())), {
      resolveRoot: () => root,
      writeLog: () => { throw new Error("disk full"); },
    });
    expect(result).toMatchObject({ stdout: "", action: "none", detail: expect.stringContaining("disk full") });
  });

  it("writes the compaction marker on PreCompact and on SessionStart clear|compact only", () => {
    const written: Array<{ root: string; event: string; source?: string; client?: string }> = [];
    const deps = {
      resolveRoot: (cwd: string | undefined) => `root:${cwd ?? "?"}`,
      recordCompaction: (root: string, note: { event: string; source?: string; client?: string }) => { written.push({ root, ...note }); },
    };
    const preCompact = JSON.stringify({ session_id: "abc123", transcript_path: "/x", cwd: "/ws", hook_event_name: "PreCompact", trigger: "auto", custom_instructions: null });
    expect(handleHookEvent("pre-compact", "claude-code", preCompact, deps)).toEqual({ stdout: "", action: "marker" });
    const sessionStart = (source: string): string => JSON.stringify({ session_id: "abc123", transcript_path: "/x", cwd: "/ws", hook_event_name: "SessionStart", source, model: "claude-opus-5" });
    expect(handleHookEvent("session-start", "claude-code", sessionStart("compact"), deps).action).toBe("marker");
    expect(handleHookEvent("session-start", "claude-code", sessionStart("clear"), deps).action).toBe("marker");
    expect(handleHookEvent("session-start", "claude-code", sessionStart("startup"), deps).action).toBe("none");
    expect(handleHookEvent("session-start", "claude-code", sessionStart("resume"), deps).action).toBe("none");
    expect(written).toEqual([
      { root: "root:/ws", event: "pre-compact", client: "claude-code" },
      { root: "root:/ws", event: "session-start", client: "claude-code", source: "compact" },
      { root: "root:/ws", event: "session-start", client: "claude-code", source: "clear" },
    ]);
  });
});

describe("Copilot adapter (Copilot CLI and VS Code .github/hooks)", () => {
  const copilotTool = (toolArgs: unknown, toolName = "bash"): string => JSON.stringify({
    sessionId: "s-1", timestamp: 1730000000000, cwd: "/ws", toolName, toolArgs,
  });
  /** Copilot CLI 1.0.105's postToolUse payload, as sent live for `npm.cmd test` in the powershell tool. */
  const copilotPost = (cwd: string, command: string, toolResult: unknown, toolName = "powershell", extraArgs: Record<string, unknown> = {}): string => JSON.stringify({
    sessionId: "fd056042", timestamp: 1793676552923, cwd, toolName, toolArgs: { command, description: "Run npm tests", ...extraArgs }, toolResult,
  });
  const shellResult = (text: string, exitCode = 1): Record<string, unknown> => ({
    resultType: "success",
    textResultForLlm: `${text}<shellId: 0 completed with exit code ${exitCode}>`,
  });
  type CopilotReply = { modifiedResult: { resultType: string; textResultForLlm: string } };

  it.each([
    ["bash", copilotTool({ command: "npx vitest run a.spec.ts", description: "tests" })],
    ["powershell", copilotTool({ command: "npm test" }, "powershell")],
    ["toolArgs as a JSON string", copilotTool(JSON.stringify({ command: "npm test" }))],
    ["VS Code run_in_terminal", copilotTool({ command: "npm test", explanation: "tests", isBackground: false }, "run_in_terminal")],
    ["the PascalCase alias payload", JSON.stringify({ session_id: "s", cwd: "/ws", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "go test ./..." } })],
  ])("pre-tool-use prints nothing (%s): the command runs as written", (_label, payload) => {
    expect(handleHookEvent("pre-tool-use", "copilot", payload)).toMatchObject({ stdout: "", action: "none" });
  });

  it("post-tool-use replaces a long failing run through modifiedResult and keeps the exit-code line", () => {
    const root = fixture();
    const output = nodeTestOutput();
    const result = handleHookEvent("post-tool-use", "copilot", copilotPost(root, "npm.cmd test", shellResult(output)), { resolveRoot: () => root });
    expect(result.action).toBe("compress");
    const reply = JSON.parse(result.stdout) as CopilotReply;
    expect(Object.keys(reply)).toEqual(["modifiedResult"]);
    expect(Object.keys(reply.modifiedResult)).toEqual(["resultType", "textResultForLlm"]);
    expect(reply.modifiedResult.resultType).toBe("success");
    const text = reply.modifiedResult.textResultForLlm;
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(DEFAULT_RUN_OUTPUT_LIMIT_BYTES);
    const lines = text.trimEnd().split("\n");
    expect(lines[0]).toBe("TokenLighten compressed this output: exit 1 (node-test)");
    expect(lines[1]).toMatch(/^full log: \.tokenlighten\/\.runtime\/run\/\S+\.log \(/);
    expect(lines[lines.length - 1]).toBe("<shellId: 0 completed with exit code 1>");
    expect(text).toContain("EXPECTED_FAILURE_MARKER sum is wrong");
    expect(text).not.toContain("noise line for case 30");
    const logs = runLogs(root);
    expect(logs).toHaveLength(1);
    const log = readFileSync(logs[0]!, "utf8");
    expect(log.split("\n")[0]).toBe("# tl hook post-tool-use (copilot): npm.cmd test");
    expect(log).toContain(`${output}<shellId: 0 completed with exit code 1>`);
    expect(result.stdout).not.toMatch(/permissionDecision|"allow"/);
  });

  it("handles the bash tool, VS Code run_in_terminal and the alias payload's tool_result the same way", () => {
    const root = fixture();
    const deps: HookHandlerDependencies = { resolveRoot: () => root };
    const passing = handleHookEvent("post-tool-use", "copilot", copilotPost(root, "npm test", shellResult(nodeTestOutput(), 0), "bash"), deps);
    expect((JSON.parse(passing.stdout) as CopilotReply).modifiedResult.textResultForLlm.split("\n")[0]).toBe("TokenLighten compressed this output: exit 0 (node-test)");
    // No status line: the text is compressed whole, the exit stays unknown.
    const terminal = handleHookEvent("post-tool-use", "copilot", copilotPost(root, "npm test", { resultType: "success", textResultForLlm: nodeTestOutput() }, "run_in_terminal"), deps);
    const terminalText = (JSON.parse(terminal.stdout) as CopilotReply).modifiedResult.textResultForLlm;
    expect(terminalText.split("\n")[0]).toBe("TokenLighten compressed this output: exit unknown (node-test)");
    expect(terminalText).toContain("EXPECTED_FAILURE_MARKER");
    const alias = JSON.stringify({ session_id: "s", timestamp: "2026-11-03T00:00:00Z", cwd: root, hook_event_name: "PostToolUse", tool_name: "bash", tool_input: { command: "npx vitest run" }, tool_result: { result_type: "success", text_result_for_llm: nodeTestOutput() } });
    expect(handleHookEvent("post-tool-use", "copilot", alias, deps).action).toBe("compress");
    expect(runLogs(root)).toHaveLength(3);
  });

  it.each([
    ["an output within the budget", (root: string) => copilotPost(root, "npm.cmd test", shellResult(nodeTestOutput(3)))],
    ["a failure result type", (root: string) => copilotPost(root, "npm.cmd test", { resultType: "failure", textResultForLlm: nodeTestOutput() })],
    ["no toolResult", (root: string) => copilotPost(root, "npm.cmd test", undefined)],
    ["a toolResult without text", (root: string) => copilotPost(root, "npm.cmd test", { resultType: "success" })],
    ["an unrecognised command", (root: string) => copilotPost(root, "git log -p", shellResult(nodeTestOutput()))],
    ["an async shell", (root: string) => copilotPost(root, "npm test", shellResult(nodeTestOutput()), "bash", { mode: "async" })],
    ["a non-shell tool", (root: string) => copilotPost(root, "npm test", shellResult(nodeTestOutput()), "edit")],
    ["a malformed payload", () => "{not json"],
  ])("post-tool-use prints nothing for %s", (_label, payload) => {
    const root = fixture();
    expect(handleHookEvent("post-tool-use", "copilot", payload(root), { resolveRoot: () => root })).toMatchObject({ stdout: "", action: "none" });
    expect(runLogs(root)).toEqual([]);
  });

  it("writes the marker on preCompact and on sessionStart new; not on startup or resume", () => {
    const written: string[] = [];
    const deps = { resolveRoot: () => "/root", recordCompaction: (_root: string, note: { event: string; source?: string }) => { written.push(`${note.event}:${note.source ?? "-"}`); } };
    expect(handleHookEvent("pre-compact", "copilot", JSON.stringify({ sessionId: "s", timestamp: 1, cwd: "/ws", transcriptPath: "/t", trigger: "auto", customInstructions: "" }), deps).action).toBe("marker");
    for (const source of ["startup", "resume", "new"]) {
      handleHookEvent("session-start", "copilot", JSON.stringify({ sessionId: "s", timestamp: 1, cwd: "/ws", source }), deps);
    }
    expect(written).toEqual(["pre-compact:-", "session-start:new"]);
  });
});

describe("Codex adapter", () => {
  it("never rewrites or replaces output (updatedInput needs permissionDecision allow there) but writes the marker", () => {
    const payload = JSON.stringify({ session_id: "s", transcript_path: "/t", cwd: "/ws", hook_event_name: "PreToolUse", model: "gpt-5", turn_id: "t1", tool_name: "Bash", tool_use_id: "c1", tool_input: { command: "npm test" }, permission_mode: "default" });
    const result = handleHookEvent("pre-tool-use", "codex", payload);
    expect(result.stdout).toBe("");
    expect(result.detail).toContain("allow");
    const post = JSON.stringify({ session_id: "s", cwd: "/ws", hook_event_name: "PostToolUse", turn_id: "t1", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { stdout: nodeTestOutput(), stderr: "", interrupted: false, isImage: false } });
    expect(handleHookEvent("post-tool-use", "codex", post)).toMatchObject({ stdout: "", action: "none" });
    const written: string[] = [];
    const deps = { resolveRoot: () => "/root", recordCompaction: (_r: string, note: { event: string }) => { written.push(note.event); } };
    expect(handleHookEvent("pre-compact", "codex", JSON.stringify({ session_id: "s", cwd: "/ws", hook_event_name: "PreCompact", turn_id: "t1", trigger: "manual" }), deps).action).toBe("marker");
    expect(handleHookEvent("post-compact", "codex", JSON.stringify({ session_id: "s", cwd: "/ws", hook_event_name: "PostCompact", turn_id: "t1", trigger: "auto" }), deps).action).toBe("marker");
    expect(handleHookEvent("session-start", "codex", JSON.stringify({ session_id: "s", cwd: "/ws", hook_event_name: "SessionStart", source: "compact" }), deps).action).toBe("marker");
    expect(written).toEqual(["pre-compact", "post-compact", "session-start"]);
  });
});

describe("client detection, payload view and the marker file", () => {
  it("tells the three payload shapes apart and accepts the --client spellings", () => {
    expect(detectHookClient({ toolName: "bash", toolArgs: {} })).toBe("copilot");
    expect(detectHookClient({ sessionId: "s", cwd: "/" })).toBe("copilot");
    expect(detectHookClient({ hook_event_name: "PreToolUse", turn_id: "t" })).toBe("codex");
    expect(detectHookClient({ hook_event_name: "PreToolUse", tool_use_id: "x" })).toBe("claude-code");
    expect(normalizeHookClient("vscode")).toBe("copilot");
    expect(normalizeHookClient("copilot-cli")).toBe("copilot");
    expect(normalizeHookClient("claude")).toBe("claude-code");
    expect(normalizeHookClient("codex")).toBe("codex");
    expect(normalizeHookClient("gemini")).toBeUndefined();
    expect(viewHookPayload({ toolName: "bash", toolArgs: { command: "x", isBackground: true }, cwd: "/w" }))
      .toMatchObject({ toolName: "bash", command: "x", background: true, cwd: "/w", toolInputKey: "toolArgs" });
    expect(viewHookPayload({ tool_name: "Bash", tool_input: { command: "x" }, tool_response: { stdout: "o" }, duration_ms: 12 }))
      .toMatchObject({ toolResponse: { stdout: "o" }, durationMs: 12 });
    expect(viewHookPayload({ toolName: "bash", toolArgs: {}, toolResult: { resultType: "success" }, duration_ms: -1 }))
      .toEqual({ toolName: "bash", toolInput: {}, toolInputKey: "toolArgs", background: false, toolResult: { resultType: "success" } });
  });

  it("records a growing epoch in .tokenlighten/.runtime/compaction-epoch.json under the resolved root", () => {
    const root = fixture();
    const sub = join(root, "packages", "x");
    mkdirSync(sub, { recursive: true });
    const payload = JSON.stringify({ session_id: "s", cwd: sub, hook_event_name: "PreCompact", trigger: "manual", custom_instructions: null });
    expect(handleHookEvent("pre-compact", "claude-code", payload).action).toBe("marker");
    const path = compactionMarkerPath(root);
    expect(existsSync(path)).toBe(true);
    expect(readCompactionMarker(root)).toMatchObject({ schemaVersion: 1, epoch: 1, event: "pre-compact", client: "claude-code" });
    handleHookEvent("session-start", "codex", JSON.stringify({ session_id: "s", cwd: sub, hook_event_name: "SessionStart", source: "clear" }));
    expect(readCompactionMarker(root)).toMatchObject({ epoch: 2, event: "session-start", source: "clear", client: "codex" });
    expect(readFileSync(join(root, ".tokenlighten", ".gitignore"), "utf8")).toContain("*");
    // A cwd that is not a directory is "nothing to mark", never an error.
    expect(handleHookEvent("pre-compact", "claude-code", JSON.stringify({ cwd: join(root, "missing", "dir") })).action).toBe("marker");
  });

  it("knows the shell behind each client's terminal tool; only those tools' results are read", () => {
    expect(shellForTool("claude-code", "Bash")).toBe("bash");
    expect(shellForTool("copilot", "bash")).toBe("bash");
    expect(shellForTool("copilot", "powershell")).toBe("powershell");
    expect(shellForTool("copilot", "run_in_terminal")).toBe("unknown");
    expect(shellForTool("copilot", "runInTerminal")).toBe("unknown");
    expect(shellForTool("codex", "Bash")).toBeUndefined();
    expect(shellForTool("claude-code", "Read")).toBeUndefined();
    expect(shellForTool("claude-code", "PowerShell")).toBeUndefined();
    expect(shellForTool("copilot", "edit_file")).toBeUndefined();
    expect(shellForTool("claude-code", undefined)).toBeUndefined();
  });
});
