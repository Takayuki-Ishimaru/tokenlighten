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
const COMPACT_TOKEN_CEILING = 550;

// Measured 2026-08-27: medium EN ~638 est tok (2550 B, unchanged this
// wave), medium JP ~599 est tok (2394 B, new this wave).
//
// Re-measured 2026-09-02 (W-GUIDE-SYNC-1): medium EN ~1017 est tok
// (4068 B), medium JP ~1029 est tok (4114 B) after the same four-flag
// disclosure bullet as compact, worded slightly fuller (medium's existing
// per-bullet style). Both stay well under mediumGuide.spec.ts's own
// half-of-full-bytes ceiling.
//
// Re-measured 2026-09-03 (W-GUIDE-SYNC-2): medium EN ~1239 est tok
// (4956 B), medium JP ~1256 est tok (5022 B) after appending the five
// Semantic Frontier v2 flag-disclosure sentences (TL_SF_DEMOTE,
// TL_SF_VERIFY_FIRST, TL_SF_RELATION_PACKETS, TL_SF_CONTINUATION_BUNDLE,
// TL_SF_STRUCTURAL_CONCERNS — all default OFF, D10(B)) to the existing
// flag-gated bullet. compact.md*.tmpl are untouched per the ratified
// no-growth-for-default-OFF-features rule. Both stay well under
// mediumGuide.spec.ts's own half-of-full-bytes ceiling. Re-pinned at
// measured + ~74/91 tok headroom.
//
// Re-measured 2026-09-03 (FX-G-B, round 12 finding 4): medium EN ~1237
// est tok (4946 B, -10 B), medium JP ~1254 est tok (5015 B, -7 B) after
// correcting the TL_SF_RELATION_PACKETS sentence — it used to promise
// "callers/callees" unconditionally even though the real port has no
// callee source and now omits `callees` entirely, disclosing that via
// `unavailable` instead (see relationPacket.ts). The corrected sentence
// ("...callers+handles+truncated; callees iff not in `unavailable`...")
// is shorter than the one it replaced, and the version tag itself also
// shrank (v83-sf-v2-flag-disclosure -> v84-callees-honesty), so both
// locales went DOWN despite the added disclosure — per the ratified
// no-growth rule for a correction, not just a default-OFF addition.
// Ceiling left unchanged; still comfortable headroom.
//
// Re-measured 2026-09-03 (v85-sf2-diet, B-4 fixed-cost ceiling wave): the
// schemaSize.spec.ts B-4 bundle guard (initialize + tools/list + all six
// guide renders) had grown to 52072 B against its 50000 B ceiling once the
// v83/v84 SF v2 flag-disclosure bullets landed. Fix: collapsed the five SF
// v2 flag-gated behaviours (TL_SF_DEMOTE/TL_SF_VERIFY_FIRST/
// TL_SF_RELATION_PACKETS/TL_SF_CONTINUATION_BUNDLE/TL_SF_STRUCTURAL_CONCERNS)
// into ONE dense sentence naming only the observable wire tokens (one
// umbrella "SF v2 flags (default OFF)" mention, no individual flag names),
// plus a tightened legacy-compat paragraph (medium's own compat paragraph
// is not phrase-pinned the way full's is — see FULL_BYTE_CEILING below).
// Medium EN ~1050 est tok (4200 B, -746 B), medium JP ~1064 est tok
// (4255 B, -760 B). Re-pinned DOWN (never up, per AGENTS.md's own ratified
// rule) to measured + a small margin.
const MEDIUM_TOKEN_CEILING = 1100;

// Measured 2026-08-27: full EN 9,988 B (2,609 real o200k tok per the
// project's own measurement), full JP 9,885 B rendered / 9,797 B raw
// template (real o200k: 3,068 tok). Neither full template is touched by
// this wave; this ceiling exists purely so unrelated future edits cannot
// silently balloon the default guide.
//
// Re-measured 2026-09-03 (W-GUIDE-SYNC-2): full EN 11,797 B rendered, full
// JP 11,731 B rendered, after adding one new flag-gated bullet naming the
// five default-OFF Semantic Frontier v2 flags (see MEDIUM_TOKEN_CEILING
// comment above for the flag list) — the full guide previously had no
// flag-disclosure bullet at all. Re-pinned at measured + ~100-170 B
// headroom; still a generous anti-runaway bound, not a tight pin.
//
// Re-measured 2026-09-03 (FX-G-B, round 12 finding 4): full EN 11,787 B
// rendered (-10 B), full JP 11,724 B rendered (-7 B) after the same
// TL_SF_RELATION_PACKETS correction described above MEDIUM_TOKEN_CEILING.
// Ceiling left unchanged.
//
// Re-measured 2026-09-03 (v85-sf2-diet, B-4 fixed-cost ceiling wave): same
// B-4 overage described above MEDIUM_TOKEN_CEILING. The full guide's SF v2
// bullet keeps one sentence per behaviour (unlike medium's single dense
// sentence) but each sentence is trimmed to the observable behaviour;
// the Search/Edit/Zoom bullets and the legacy-compat paragraph were also
// tightened wherever no exact phrase is pinned by guideSchemaParity.spec.ts's
// GUIDE_SEMANTIC_CONTRACTS or injectAll.spec.ts's full-body-target
// assertions (the Act/refusal/receipt/verifying bullets turned out to be
// almost entirely phrase-pinned by those two suites and were left
// byte-identical after a first compression pass broke both). Full EN
// 11,223 B rendered (-564 B), full JP 11,214 B rendered (-510 B).
// Re-pinned DOWN (never up) to measured + a small margin — still a
// generous anti-runaway bound, not a tight pin.
const FULL_BYTE_CEILING = 11_400;

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
