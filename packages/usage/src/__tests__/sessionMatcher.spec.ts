import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { splitJsonLines } from "../parsers/jsonl.js";
import { parseClaudeCodeSession } from "../parsers/claudeCode.js";
import { parseCodexSession } from "../parsers/codex.js";
import type { NormalizedSessionUsage } from "../parsers/types.js";
import { knownTokenCount, unknownTokenCount } from "../parsers/types.js";
import {
  groupUsageEventsBySession,
  matchSession,
  normalizeToolCallName,
  type SessionMatchCandidate,
  type TlSessionGroup,
} from "../sessionMatcher.js";

function fixture(name: string): unknown[] {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return splitJsonLines(readFileSync(path, "utf8"));
}

describe("normalizeToolCallName", () => {
  it("maps recognized TL tool-call names to their short form", () => {
    expect(normalizeToolCallName("mcp__tokenlighten__read_file")).toBe("read_file");
    expect(normalizeToolCallName("tokenlighten:search_files")).toBe("search_files");
    expect(normalizeToolCallName("tokenlighten__edit_file")).toBe("edit_file");
  });

  it("returns null for anything that is not a TL tool-call name", () => {
    expect(normalizeToolCallName("some_other_tool")).toBeNull();
    expect(normalizeToolCallName("mcp__tokenlighten__unknown_tool")).toBeNull();
    expect(normalizeToolCallName("mcp__othertool__read_file")).toBeNull();
  });
});

describe("matchSession — confident match", () => {
  it("matches when workspace/client/time/fingerprint all line up", () => {
    const session = parseClaudeCodeSession(fixture("claude-code-session-basic.jsonl"));
    const candidates: SessionMatchCandidate[] = [{ workspaceId: "ws-1", session }];
    const target: TlSessionGroup = {
      workspaceId: "ws-1",
      client: "claude-code",
      events: [
        { tool: "read_file", occurredAt: "2026-08-15T10:00:00.000Z" },
        { tool: "edit_file", occurredAt: "2026-08-15T10:02:00.000Z" },
      ],
    };
    const result = matchSession(target, candidates);
    expect(result.status).toBe("matched");
    if (result.status === "matched") {
      expect(result.confidence).toBe("high");
      expect(result.session).toBe(session);
      expect(result.matchedOn.fingerprintSimilarity).toBe(1);
      expect(result.score).toBeGreaterThanOrEqual(0.75);
    }
  });
});

describe("matchSession — the four unmatched reasons, each fixture-reachable", () => {
  it('missing-log: no candidate session exists for this client at all', () => {
    const target: TlSessionGroup = {
      workspaceId: "ws-1",
      client: "codex",
      events: [{ tool: "read_file", occurredAt: "2026-08-15T10:00:00.000Z" }],
    };
    const result = matchSession(target, []);
    expect(result).toEqual({
      status: "unavailable",
      reason: "missing-log",
      basis: expect.stringContaining("codex"),
    });
  });

  it("unmatched-session: candidates exist but none share the target workspace", () => {
    const session = parseClaudeCodeSession(fixture("claude-code-session-basic.jsonl"));
    const candidates: SessionMatchCandidate[] = [{ workspaceId: "ws-1", session }];
    const target: TlSessionGroup = {
      workspaceId: "ws-DIFFERENT",
      client: "claude-code",
      events: [{ tool: "read_file", occurredAt: "2026-08-15T10:00:00.000Z" }],
    };
    const result = matchSession(target, candidates);
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toBe("unmatched-session");
      expect(result.basis).toContain("workspace");
    }
  });

  it("unmatched-session: an ambiguous/conflicting pair of near-identical candidates is declined, never guessed", () => {
    const sessionA = parseClaudeCodeSession(fixture("claude-code-session-ambiguous-a.jsonl"));
    const sessionB = parseClaudeCodeSession(fixture("claude-code-session-ambiguous-b.jsonl"));
    const candidates: SessionMatchCandidate[] = [
      { workspaceId: "ws-amb", session: sessionA },
      { workspaceId: "ws-amb", session: sessionB },
    ];
    // Exactly the midpoint of A's and B's turn timestamps -- by construction,
    // A and B score IDENTICALLY against it (see this file's design notes).
    const target: TlSessionGroup = {
      workspaceId: "ws-amb",
      client: "claude-code",
      events: [
        { tool: "read_file", occurredAt: "2026-08-16T09:00:15.000Z" },
        { tool: "edit_file", occurredAt: "2026-08-16T09:01:15.000Z" },
      ],
    };
    const result = matchSession(target, candidates);
    expect(result).toEqual({
      status: "unavailable",
      reason: "unmatched-session",
      basis: expect.stringContaining("ambiguous"),
    });
  });

  it("unknown-model: the sole, unambiguous, high-scoring candidate never reported a model id", () => {
    const session = parseCodexSession(fixture("codex-session-unknown-model.jsonl"));
    expect(session.turns.every((t) => t.model === "unknown")).toBe(true);
    const candidates: SessionMatchCandidate[] = [{ workspaceId: "ws-unknown-model", session }];
    const target: TlSessionGroup = {
      workspaceId: "ws-unknown-model",
      client: "codex",
      events: [{ tool: "read_file", occurredAt: "2026-08-19T11:00:05.000Z" }],
    };
    const result = matchSession(target, candidates);
    expect(result).toEqual({
      status: "unavailable",
      reason: "unknown-model",
      basis: expect.any(String),
    });
  });

  it("low-confidence: a plausible but weak single-winner match is declined rather than guessed", () => {
    const weakSession: NormalizedSessionUsage = {
      client: "claude-code",
      parserVersion: "test-fixture",
      sessionCwd: "/home/demo/workspace/weak",
      usedTokenLighten: true,
      turns: [
        {
          turnIndex: 0,
          model: "claude-sonnet-5-20260810",
          timestamp: "2026-08-20T00:00:00.000Z",
          toolCallFingerprint: ["mcp__tokenlighten__read_file", "mcp__tokenlighten__edit_file"],
          counts: {
            input: knownTokenCount(100),
            output: knownTokenCount(20),
            cacheWrite: knownTokenCount(0),
            cacheRead: knownTokenCount(0),
            reasoning: unknownTokenCount("test fixture"),
          },
          unrecognizedUsageKeys: [],
        },
      ],
      totals: {
        input: knownTokenCount(100),
        output: knownTokenCount(20),
        cacheWrite: knownTokenCount(0),
        cacheRead: knownTokenCount(0),
        reasoning: unknownTokenCount("test fixture"),
      },
      warnings: [],
    };
    const candidates: SessionMatchCandidate[] = [{ workspaceId: "ws-weak", session: weakSession }];
    const target: TlSessionGroup = {
      workspaceId: "ws-weak",
      client: "claude-code",
      // Only a partial fingerprint overlap (1 of 2 tool calls), and far
      // enough in time (30 min, beyond the 5-min slack) that time overlap
      // contributes 0 -- plausible but not solid.
      events: [{ tool: "read_file", occurredAt: "2026-08-20T00:30:00.000Z" }],
    };
    const result = matchSession(target, candidates);
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toBe("low-confidence");
    }
  });
});

describe("groupUsageEventsBySession", () => {
  it("groups by (workspaceId, client, sessionId) and sorts events ascending by time", () => {
    const groups = groupUsageEventsBySession([
      { sessionId: "s1", workspaceId: "w1", client: "claude-code", tool: "edit_file", occurredAt: "2026-08-15T10:02:00.000Z" },
      { sessionId: "s1", workspaceId: "w1", client: "claude-code", tool: "read_file", occurredAt: "2026-08-15T10:00:00.000Z" },
      { sessionId: "s2", workspaceId: "w1", client: "claude-code", tool: "search_files", occurredAt: "2026-08-15T11:00:00.000Z" },
    ]);
    expect(groups).toHaveLength(2);
    const s1 = groups.find((g) => g.events.length === 2)!;
    expect(s1.events.map((e) => e.tool)).toEqual(["read_file", "edit_file"]);
  });
});
