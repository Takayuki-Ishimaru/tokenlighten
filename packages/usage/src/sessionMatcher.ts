/**
 * sessionMatcher.ts — V11-08 Attribution & Calibration v2.
 *
 * Matches TokenLighten usage events (TL's own `TokenLightenUsageEvent`
 * channel — see index.ts's `createUsageRecorder`) to client provider-log
 * sessions (parsers/claudeCode.ts, parsers/codex.ts) by:
 *
 *   workspace opaque id × client × time window × tool-call fingerprint
 *   sequence
 *
 * per the V11-08 task brief. Scoring is deterministic (no randomness, no
 * bench-tuned weights — see the named constants below and their comments
 * for the reasoning behind each one). An ambiguous or conflicting match
 * NEVER resolves to a best guess: this module either returns a single
 * confidently-matched session, or `{status:"unavailable", reason}` with
 * `reason` one of exactly the four the brief specifies:
 *
 *   missing-log      — no provider-log session was available for this
 *                       client at all (the log itself is absent/unscanned).
 *   unmatched-session — provider-log sessions existed, but none in this
 *                       workspace cleared the minimum match score, OR the
 *                       top two candidates were too close to call apart
 *                       (ambiguous/conflicting, per the brief's explicit
 *                       instruction that ambiguity maps to this reason).
 *   unknown-model     — a session matched geometrically (workspace/time/
 *                       fingerprint) but never reported a recognizable
 *                       model id, so it cannot support priced attribution.
 *   low-confidence    — a session matched but its score sits below the
 *                       high-confidence band — declined rather than
 *                       guessed.
 *
 * Pure: no filesystem/hash I/O. Workspace identity is compared by simple
 * string equality on an ALREADY-OPAQUE `workspaceId` the caller supplies for
 * both sides (e.g. via index.ts's `usageWorkspaceId()`) — this module never
 * hashes a raw path itself, keeping it deterministic and independently
 * testable without touching disk.
 */

import type { TokenLightenClient, TokenLightenTool } from "@tokenlighten/types";
import type { NormalizedSessionUsage } from "./parsers/types.js";

const TOKENLIGHTEN_TOOL_NAME =
  /^(?:mcp__)?tokenlighten(?:__|:)(read_file|search_files|edit_file)$/i;

/** Maps a raw tool-call name (as recorded in a client log, e.g.
 *  "mcp__tokenlighten__read_file") to TL's short tool name, or null when the
 *  name does not identify a TokenLighten tool call at all. */
export function normalizeToolCallName(name: string): TokenLightenTool | null {
  const match = TOKENLIGHTEN_TOOL_NAME.exec(name.trim());
  return match ? (match[1].toLowerCase() as TokenLightenTool) : null;
}

// ---------------------------------------------------------------------------
// Deterministic scoring policy (documented reasoning, not bench-tuned — see
// this file's header doc; DESIGN-v0.11-expansion-plan-reconciliation.md §1's
// "no bench overfitting" rule governs RETRIEVAL weights, not this offline
// attribution heuristic, but the same non-fabrication spirit applies).
// ---------------------------------------------------------------------------

/** Workspace and client are hard filters (exact match or excluded); of the
 *  two SCORED dimensions, the tool-call fingerprint sequence is the
 *  stronger identity signal (exact tool-call orderings are fairly unique to
 *  one session) than a coarse time window, so it carries more weight. */
export const SESSION_MATCH_TIME_WEIGHT = 0.4;
export const SESSION_MATCH_FINGERPRINT_WEIGHT = 0.6;

/** Padding applied to both sides' time ranges before computing overlap, so a
 *  single-instant TL call vs. a log line a few seconds off the same moment
 *  still scores as overlapping. */
export const SESSION_MATCH_TIME_WINDOW_SLACK_MS = 5 * 60 * 1000;

/** Below this combined score, a candidate is not seriously considered. */
export const SESSION_MATCH_MIN_CANDIDATE_SCORE = 0.35;
/** At/above this score (plus a known model and an unambiguous winner), a
 *  match is confident enough to report. */
export const SESSION_MATCH_HIGH_CONFIDENCE_SCORE = 0.75;
/** Top two survivors within this margin of each other are ambiguous. */
export const SESSION_MATCH_AMBIGUITY_MARGIN = 0.08;

// ---------------------------------------------------------------------------
// Input / output shapes
// ---------------------------------------------------------------------------

export interface SessionMatchCandidate {
  /** Opaque workspace identifier, precomputed the SAME way as the TL
   *  events' workspaceId (e.g. via index.ts's `usageWorkspaceId` applied to
   *  `session.sessionCwd`) — this module does no hashing of its own. Null
   *  when the candidate's workspace could not be resolved at all (e.g. the
   *  log never recorded a cwd), which excludes it from matching. */
  readonly workspaceId: string | null;
  readonly session: NormalizedSessionUsage;
}

export interface TlSessionEvent {
  readonly tool: TokenLightenTool;
  readonly occurredAt: string;
}

export interface TlSessionGroup {
  readonly workspaceId: string;
  readonly client: TokenLightenClient;
  /** Every TL usage event recorded under one `sessionId`. Order does not
   *  need to be pre-sorted — this module sorts internally where it matters. */
  readonly events: readonly TlSessionEvent[];
}

export type SessionMatchFailureReason =
  | "missing-log"
  | "unmatched-session"
  | "unknown-model"
  | "low-confidence";

export type SessionMatchResult =
  | {
      readonly status: "matched";
      readonly session: NormalizedSessionUsage;
      readonly score: number;
      /** Matched results are always high-confidence by construction — see
       *  SESSION_MATCH_HIGH_CONFIDENCE_SCORE. There is no "matched, low
       *  confidence" outcome: below that band this function declines
       *  entirely (reason "low-confidence") rather than guess. */
      readonly confidence: "high";
      readonly matchedOn: {
        readonly timeWindowOverlap: number;
        readonly fingerprintSimilarity: number;
      };
    }
  | {
      readonly status: "unavailable";
      readonly reason: SessionMatchFailureReason;
      /** Always non-empty — same discipline as ComponentProvenance.basis in
       *  measurementEngine.ts. */
      readonly basis: string;
    };

// ---------------------------------------------------------------------------
// Scoring internals
// ---------------------------------------------------------------------------

interface TimeRange {
  readonly start: number;
  readonly end: number;
}

function timeRangeOf(timestamps: readonly (string | null)[]): TimeRange | null {
  const ms = timestamps
    .filter((t): t is string => t !== null)
    .map((t) => Date.parse(t))
    .filter((n) => Number.isFinite(n));
  if (ms.length === 0) return null;
  return { start: Math.min(...ms), end: Math.max(...ms) };
}

function overlapRatio(a: TimeRange, b: TimeRange, slackMs: number): number {
  const aStart = a.start - slackMs;
  const aEnd = a.end + slackMs;
  const bStart = b.start - slackMs;
  const bEnd = b.end + slackMs;
  const intersection = Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
  const union = Math.max(aEnd, bEnd) - Math.min(aStart, bStart);
  return union > 0 ? intersection / union : 0;
}

/** Standard O(n*m) longest-common-subsequence length — deterministic, no
 *  external dependency. Sequences in practice are short (one MCP session's
 *  tool calls), so this is not a performance concern. */
function lcsLength(a: readonly string[], b: readonly string[]): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => new Array(cols).fill(0) as number[]);
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

/** 0 when both sequences are empty (no evidence either way — NOT treated as
 *  a perfect match, which would let two TL-call-free candidates both score
 *  "perfectly" against each other). Otherwise 2*LCS / (lenA + lenB), in
 *  [0, 1]. */
function fingerprintSimilarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  return (2 * lcsLength(a, b)) / (a.length + b.length);
}

function candidateFingerprint(session: NormalizedSessionUsage): TokenLightenTool[] {
  return session.turns
    .flatMap((t) => t.toolCallFingerprint)
    .map(normalizeToolCallName)
    .filter((t): t is TokenLightenTool => t !== null);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Matches ONE TL session group against a pool of candidate provider-log
 * sessions. Pure and deterministic: identical input always yields a
 * deep-equal result, and `candidates` is never mutated or reordered.
 */
export function matchSession(
  target: TlSessionGroup,
  candidates: readonly SessionMatchCandidate[],
): SessionMatchResult {
  const clientCandidates = candidates.filter((c) => c.session.client === target.client);
  if (clientCandidates.length === 0) {
    return {
      status: "unavailable",
      reason: "missing-log",
      basis: `no ${target.client} provider-log session was supplied to match against`,
    };
  }

  const workspaceCandidates = clientCandidates.filter(
    (c) => c.workspaceId !== null && c.workspaceId === target.workspaceId,
  );
  if (workspaceCandidates.length === 0) {
    return {
      status: "unavailable",
      reason: "unmatched-session",
      basis: `${clientCandidates.length} ${target.client} session(s) were available but none share this workspace`,
    };
  }

  const tlSequence = target.events.map((e) => e.tool);
  const tlRange = timeRangeOf(target.events.map((e) => e.occurredAt));

  const scored = workspaceCandidates.map((candidate) => {
    const logSequence = candidateFingerprint(candidate.session);
    const logRange = timeRangeOf(candidate.session.turns.map((t) => t.timestamp));
    const timeWindowOverlap = tlRange && logRange
      ? overlapRatio(tlRange, logRange, SESSION_MATCH_TIME_WINDOW_SLACK_MS)
      : 0;
    const similarity = fingerprintSimilarity(tlSequence, logSequence);
    const score =
      SESSION_MATCH_TIME_WEIGHT * timeWindowOverlap
      + SESSION_MATCH_FINGERPRINT_WEIGHT * similarity;
    return { candidate, score, timeWindowOverlap, fingerprintSimilarity: similarity };
  });

  const survivors = scored
    .filter((s) => s.score >= SESSION_MATCH_MIN_CANDIDATE_SCORE)
    .sort((a, b) => b.score - a.score);

  if (survivors.length === 0) {
    return {
      status: "unavailable",
      reason: "unmatched-session",
      basis: `${workspaceCandidates.length} same-workspace ${target.client} session(s) `
        + "considered; none reached the minimum match score",
    };
  }

  if (
    survivors.length > 1
    && survivors[0].score - survivors[1].score < SESSION_MATCH_AMBIGUITY_MARGIN
  ) {
    return {
      status: "unavailable",
      reason: "unmatched-session",
      basis: `${survivors.length} candidate sessions scored within `
        + `${SESSION_MATCH_AMBIGUITY_MARGIN} of each other (top two: `
        + `${survivors[0].score.toFixed(3)}, ${survivors[1].score.toFixed(3)}) `
        + "— ambiguous, never guessed",
    };
  }

  const winner = survivors[0];
  const modelKnown = winner.candidate.session.turns.some((t) => t.model !== "unknown");
  if (!modelKnown) {
    return {
      status: "unavailable",
      reason: "unknown-model",
      basis: "the matching session's log never reported a recognizable model id",
    };
  }

  if (winner.score < SESSION_MATCH_HIGH_CONFIDENCE_SCORE) {
    return {
      status: "unavailable",
      reason: "low-confidence",
      basis: `best match score ${winner.score.toFixed(3)} is below the `
        + `high-confidence threshold ${SESSION_MATCH_HIGH_CONFIDENCE_SCORE} `
        + "— declined rather than guessed",
    };
  }

  return {
    status: "matched",
    session: winner.candidate.session,
    score: winner.score,
    confidence: "high",
    matchedOn: {
      timeWindowOverlap: winner.timeWindowOverlap,
      fingerprintSimilarity: winner.fingerprintSimilarity,
    },
  };
}

/**
 * Groups raw TL usage events into per-session groups keyed by
 * (workspaceId, client, sessionId) — a convenience for callers that have not
 * already grouped their events. Events within a group are sorted by
 * `occurredAt` ascending. Pure: never mutates `events`.
 */
export function groupUsageEventsBySession(
  events: readonly {
    readonly sessionId: string;
    readonly workspaceId: string;
    readonly client: TokenLightenClient;
    readonly tool: TokenLightenTool;
    readonly occurredAt: string;
  }[],
): TlSessionGroup[] {
  const groups = new Map<string, { workspaceId: string; client: TokenLightenClient; events: TlSessionEvent[] }>();
  for (const event of events) {
    const key = `${event.workspaceId}\0${event.client}\0${event.sessionId}`;
    const group = groups.get(key) ?? { workspaceId: event.workspaceId, client: event.client, events: [] };
    group.events.push({ tool: event.tool, occurredAt: event.occurredAt });
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({
      workspaceId: group.workspaceId,
      client: group.client,
      events: [...group.events].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt)),
    }));
}
