import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { splitJsonLines } from "../parsers/jsonl.js";
import {
  CLAUDE_CODE_PARSER_VERSION,
  parseClaudeCodeSession,
} from "../parsers/claudeCode.js";

function fixture(name: string): unknown[] {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return splitJsonLines(readFileSync(path, "utf8"));
}

describe("parseClaudeCodeSession — basic fixture", () => {
  const lines = fixture("claude-code-session-basic.jsonl");
  const session = parseClaudeCodeSession(lines);

  it("stamps the parser version on the session", () => {
    expect(session.parserVersion).toBe(CLAUDE_CODE_PARSER_VERSION);
    expect(session.client).toBe("claude-code");
  });

  it("recovers the session cwd and TokenLighten usage flag", () => {
    expect(session.sessionCwd).toBe("/home/demo/workspace/example-repo");
    expect(session.usedTokenLighten).toBe(true);
  });

  it("produces one turn per assistant message that carried a usage block", () => {
    expect(session.turns).toHaveLength(3);
    expect(session.turns.map((t) => t.turnIndex)).toEqual([0, 1, 2]);
  });

  it("keeps input/output/cache-write/cache-read separated, never summed", () => {
    const [first] = session.turns;
    expect(first.counts.input).toEqual({ status: "known", tokens: 500 });
    expect(first.counts.output).toEqual({ status: "known", tokens: 120 });
    expect(first.counts.cacheWrite).toEqual({ status: "known", tokens: 0 });
    expect(first.counts.cacheRead).toEqual({ status: "known", tokens: 0 });
  });

  it("reasoning is ALWAYS unknown for Claude Code, with a non-empty documented reason", () => {
    for (const turn of session.turns) {
      expect(turn.counts.reasoning.status).toBe("unknown");
      if (turn.counts.reasoning.status === "unknown") {
        expect(turn.counts.reasoning.reason.length).toBeGreaterThan(0);
        expect(turn.counts.reasoning.reason).toMatch(/reasoning|thinking/i);
      }
    }
  });

  it("only the turn with a tool_use content block carries a fingerprint", () => {
    expect(session.turns[0].toolCallFingerprint).toEqual(["mcp__tokenlighten__read_file"]);
    expect(session.turns[1].toolCallFingerprint).toEqual([]);
    expect(session.turns[2].toolCallFingerprint).toEqual(["mcp__tokenlighten__edit_file"]);
  });

  it("preserves unrecognized usage keys by NAME only, never values", () => {
    expect(session.turns[0].unrecognizedUsageKeys).toEqual([]);
    expect(session.turns[2].unrecognizedUsageKeys).toEqual(["server_tool_use"]);
  });

  it("sums totals only for categories every turn reported", () => {
    expect(session.totals.input).toEqual({ status: "known", tokens: 500 + 650 + 800 });
    expect(session.totals.output).toEqual({ status: "known", tokens: 120 + 40 + 150 });
    expect(session.totals.cacheWrite).toEqual({ status: "known", tokens: 0 + 0 + 200 });
    expect(session.totals.cacheRead).toEqual({ status: "known", tokens: 0 + 500 + 650 });
    // Reasoning is unknown on every turn -> total is unknown, never a
    // fabricated 0.
    expect(session.totals.reasoning.status).toBe("unknown");
  });
});

describe("parseClaudeCodeSession — edge cases", () => {
  it("skips a turn that carries no usage block and records a warning", () => {
    const lines = [
      {
        type: "assistant",
        cwd: "/home/demo/workspace/no-usage",
        timestamp: "2026-08-15T00:00:00.000Z",
        message: {
          id: "m1",
          model: "claude-sonnet-5-20260810",
          content: [{ type: "text", text: "hello" }],
          // usage deliberately omitted
        },
      },
    ];
    const session = parseClaudeCodeSession(lines);
    expect(session.turns).toHaveLength(0);
    expect(session.warnings.some((w) => w.includes("no usage block"))).toBe(true);
  });

  it("an empty session yields all-unknown totals, not a fabricated known 0", () => {
    const session = parseClaudeCodeSession([]);
    expect(session.turns).toHaveLength(0);
    expect(session.sessionCwd).toBeNull();
    expect(session.usedTokenLighten).toBe(false);
    for (const category of ["input", "output", "cacheWrite", "cacheRead", "reasoning"] as const) {
      expect(session.totals[category].status).toBe("unknown");
    }
  });

  it("tolerates non-object lines without throwing", () => {
    const lines: unknown[] = [null, 42, "a string", [1, 2, 3], { type: "ai-title", title: "x" }];
    expect(() => parseClaudeCodeSession(lines)).not.toThrow();
    expect(parseClaudeCodeSession(lines).turns).toHaveLength(0);
  });

  it("is pure: identical input yields a deep-equal result and is never mutated", () => {
    const lines = fixture("claude-code-session-basic.jsonl");
    const snapshot = JSON.parse(JSON.stringify(lines));
    const a = parseClaudeCodeSession(lines);
    const b = parseClaudeCodeSession(lines);
    expect(a).toEqual(b);
    expect(lines).toEqual(snapshot);
  });
});
