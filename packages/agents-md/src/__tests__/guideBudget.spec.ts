// Budget guard for the agent-guide profiles (full/medium/compact x en/jp).
//
// Estimated-token convention: this package has no tokenizer dependency, so
// "estimated tokens" mirrors packages/usage/src/index.ts's existing,
// already-shipped `estimateTokensFromBytes` convention (bytes/4, rounded
// up) — the same convention compactBootstrap.spec.ts already uses — rather
// than inventing a new formula or adding a cross-package tokenizer
// dependency for a handful of constants.
//
// 2026-08-27 (v0.12 compact/medium first-class wave): compact becomes a
// first-class GuideProfile with EN+JP templates (see render.ts's
// renderCompactBlock/loadCompactTemplate), and medium gains a JP template.
// These ceilings pin real headroom above CURRENT measurements (see the
// comment above each constant) so future prose growth in either profile is
// a conscious, reviewed decision rather than a silent regression.
//
// The full-profile ceiling is a generous ANTI-RUNAWAY bound only — full's
// canonical EN/JP content is frozen byte-identical by
// injectForTarget.spec.ts's own AGENTS.md.tmpl/AGENTS.md.jp.tmpl budget
// table (which this wave does not touch), so this spec does not re-pin
// full's exact size, only guards against unbounded growth.

import { describe, it, expect } from "vitest";
import { renderCanonicalBlock, renderMediumBlock, renderCompactBlock } from "../render.js";

/** Mirrors packages/usage/src/index.ts's estimateTokensFromBytes exactly. */
function estimateTokensFromBytes(bytes: number): number {
  const clamped = Number.isFinite(bytes) ? Math.max(0, Math.round(bytes)) : 0;
  return Math.ceil(clamped / 4);
}

function estTokens(text: string): number {
  return estimateTokensFromBytes(Buffer.byteLength(text, "utf8"));
}

// Measured 2026-08-27: compact EN ~339 est tok (1353 B), compact JP ~336 est
// tok (1343 B) — both well under the ~455-est-tok pre-wave EN measurement's
// own V10-07 800-tok ceiling (compactBootstrap.spec.ts), and comfortably
// under this tighter first-class-profile ceiling too.
const COMPACT_TOKEN_CEILING = 500;

// Measured 2026-08-27: medium EN ~638 est tok (2550 B, unchanged this
// wave), medium JP ~599 est tok (2394 B, new this wave).
const MEDIUM_TOKEN_CEILING = 700;

// Measured 2026-08-27: full EN 9,988 B (2,609 real o200k tok per the
// project's own measurement), full JP 9,885 B rendered / 9,797 B raw
// template (real o200k: 3,068 tok). Neither full template is touched by
// this wave; this ceiling exists purely so unrelated future edits cannot
// silently balloon the default guide.
const FULL_BYTE_CEILING = 10_500;

describe("guide profile budget guard (compact/medium first-class wave)", () => {
  describe("compact profile", () => {
    it("EN stays at or under the estimated-token ceiling", () => {
      const tokens = estTokens(renderCompactBlock("en"));
      expect(tokens).toBeLessThanOrEqual(COMPACT_TOKEN_CEILING);
    });

    it("JP stays at or under the estimated-token ceiling", () => {
      const tokens = estTokens(renderCompactBlock("jp"));
      expect(tokens).toBeLessThanOrEqual(COMPACT_TOKEN_CEILING);
    });
  });

  describe("medium profile", () => {
    it("EN stays at or under the estimated-token ceiling", () => {
      const tokens = estTokens(renderMediumBlock("en"));
      expect(tokens).toBeLessThanOrEqual(MEDIUM_TOKEN_CEILING);
    });

    it("JP stays at or under the estimated-token ceiling", () => {
      const tokens = estTokens(renderMediumBlock("jp"));
      expect(tokens).toBeLessThanOrEqual(MEDIUM_TOKEN_CEILING);
    });
  });

  describe("full profile (generous anti-runaway ceiling only)", () => {
    it("EN stays at or under the byte ceiling", () => {
      const bytes = Buffer.byteLength(renderCanonicalBlock("en"), "utf8");
      expect(bytes).toBeLessThanOrEqual(FULL_BYTE_CEILING);
    });

    it("JP stays at or under the byte ceiling", () => {
      const bytes = Buffer.byteLength(renderCanonicalBlock("jp"), "utf8");
      expect(bytes).toBeLessThanOrEqual(FULL_BYTE_CEILING);
    });
  });
});
