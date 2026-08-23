import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { splitJsonLines } from "../parsers/jsonl.js";
import { CODEX_PARSER_VERSION, parseCodexSession } from "../parsers/codex.js";

function fixture(name: string): unknown[] {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return splitJsonLines(readFileSync(path, "utf8"));
}

describe("parseCodexSession — basic fixture", () => {
  const lines = fixture("codex-session-basic.jsonl");
  const session = parseCodexSession(lines);

  it("stamps the parser version on the session", () => {
    expect(session.parserVersion).toBe(CODEX_PARSER_VERSION);
    expect(session.client).toBe("codex");
  });

  it("recovers the session cwd and TokenLighten usage flag", () => {
    expect(session.sessionCwd).toBe("/home/demo/workspace/example-repo");
    expect(session.usedTokenLighten).toBe(true);
  });

  it("deltas CONSECUTIVE cumulative token_count snapshots into per-turn counts", () => {
    expect(session.turns).toHaveLength(2);
    const [first, second] = session.turns;
    // First snapshot: the cumulative total IS the delta (nothing preceded it).
    expect(first.counts.input).toEqual({ status: "known", tokens: 300 - 50 });
    expect(first.counts.output).toEqual({ status: "known", tokens: 80 });
    expect(first.counts.cacheRead).toEqual({ status: "known", tokens: 50 });
    // Second snapshot: delta from the first.
    expect(second.counts.input).toEqual({ status: "known", tokens: (700 - 150) - (300 - 50) });
    expect(second.counts.output).toEqual({ status: "known", tokens: 160 - 80 });
    expect(second.counts.cacheRead).toEqual({ status: "known", tokens: 150 - 50 });
  });

  it("assigns each turn only the tool calls made SINCE the previous token_count event", () => {
    expect(session.turns[0].toolCallFingerprint).toEqual(["mcp__tokenlighten__read_file"]);
    expect(session.turns[1].toolCallFingerprint).toEqual(["mcp__tokenlighten__edit_file"]);
  });

  it("carries the model from the preceding turn_context event", () => {
    expect(session.turns[0].model).toBe("gpt-5.6-terra");
    expect(session.turns[1].model).toBe("gpt-5.6-terra");
  });

  it("cache-write is ALWAYS unknown for Codex (no such billing category)", () => {
    for (const turn of session.turns) {
      expect(turn.counts.cacheWrite.status).toBe("unknown");
      if (turn.counts.cacheWrite.status === "unknown") {
        expect(turn.counts.cacheWrite.reason).toMatch(/cache-write/i);
      }
    }
  });

  it("reasoning is unknown when the log never reports reasoning_tokens", () => {
    for (const turn of session.turns) {
      expect(turn.counts.reasoning.status).toBe("unknown");
    }
  });

  it("sums totals only for categories every turn reported", () => {
    expect(session.totals.input).toEqual({ status: "known", tokens: (300 - 50) + ((700 - 150) - (300 - 50)) });
    expect(session.totals.output).toEqual({ status: "known", tokens: 80 + (160 - 80) });
    expect(session.totals.cacheRead).toEqual({ status: "known", tokens: 50 + (150 - 50) });
    expect(session.totals.cacheWrite.status).toBe("unknown");
    expect(session.totals.reasoning.status).toBe("unknown");
  });
});

describe("parseCodexSession — reasoning tokens reported", () => {
  const lines = fixture("codex-session-with-reasoning.jsonl");
  const session = parseCodexSession(lines);

  it("separates reasoning tokens (SEPARATE category, never folded into output)", () => {
    expect(session.turns).toHaveLength(2);
    expect(session.turns[0].counts.reasoning).toEqual({ status: "known", tokens: 40 });
    expect(session.turns[1].counts.reasoning).toEqual({ status: "known", tokens: 75 - 40 });
    // Output must NOT include reasoning -- deltas independently.
    expect(session.turns[0].counts.output).toEqual({ status: "known", tokens: 100 });
    expect(session.totals.reasoning).toEqual({ status: "known", tokens: 75 });
  });
});

describe("parseCodexSession — unknown model", () => {
  const lines = fixture("codex-session-unknown-model.jsonl");
  const session = parseCodexSession(lines);

  it("every turn's model is the unknown sentinel when no turn_context ever reported one", () => {
    expect(session.turns.length).toBeGreaterThan(0);
    expect(session.turns.every((t) => t.model === "unknown")).toBe(true);
  });
});

describe("parseCodexSession — non-monotonic counters", () => {
  it("treats a backwards counter as unknown for that turn and records a warning, never a negative or clamped figure", () => {
    const lines: unknown[] = [
      { type: "session_meta", payload: { type: "session_meta", cwd: "/home/demo/workspace/weird" } },
      { type: "turn_context", payload: { type: "turn_context", model: "gpt-5.6-terra" } },
      {
        type: "event_msg",
        payload: { type: "token_count", info: { total_token_usage: { input_tokens: 500, cached_input_tokens: 0, output_tokens: 200, total_tokens: 700 } } },
      },
      {
        type: "event_msg",
        // output_tokens goes BACKWARDS from 200 to 100 -- corrupt/reset log.
        payload: { type: "token_count", info: { total_token_usage: { input_tokens: 600, cached_input_tokens: 0, output_tokens: 100, total_tokens: 700 } } },
      },
    ];
    const session = parseCodexSession(lines);
    expect(session.turns).toHaveLength(2);
    expect(session.turns[1].counts.output.status).toBe("unknown");
    expect(session.warnings.some((w) => w.includes("backwards"))).toBe(true);
  });
});

describe("parseCodexSession — edge cases", () => {
  it("an empty session yields all-unknown totals, not a fabricated known 0", () => {
    const session = parseCodexSession([]);
    expect(session.turns).toHaveLength(0);
    expect(session.sessionCwd).toBeNull();
    for (const category of ["input", "output", "cacheWrite", "cacheRead", "reasoning"] as const) {
      expect(session.totals[category].status).toBe("unknown");
    }
  });

  it("tolerates non-object lines without throwing", () => {
    const lines: unknown[] = [null, 7, "line", [1, 2], { payload: "not-an-object" }];
    expect(() => parseCodexSession(lines)).not.toThrow();
  });

  it("is pure: identical input yields a deep-equal result and is never mutated", () => {
    const lines = fixture("codex-session-basic.jsonl");
    const snapshot = JSON.parse(JSON.stringify(lines));
    const a = parseCodexSession(lines);
    const b = parseCodexSession(lines);
    expect(a).toEqual(b);
    expect(lines).toEqual(snapshot);
  });
});
