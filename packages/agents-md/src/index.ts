// @tokenlighten/agents-md — canonical AGENTS.md template + 5-stub injector.
// Plain data output — no meta envelope. See docs/00-postmortem.md §2.2.
//
// Public API surface for library consumers.
// CLI entry point: src/cli.ts

export { parseSentinelBlock, detectEol, sha256hex, SENTINEL_START, SENTINEL_END } from "./sentinel.js";
export type { ParsedSentinel } from "./sentinel.js";

export { renderBlock, renderCanonicalBlock, renderMediumBlock, renderCompactBlock, blockSha256, INSTRUCTIONS_VERSION } from "./render.js";
export type { GuideProfile, Locale } from "./render.js";

export { rewrite, hasManualGuidance, removeBlock } from "./inject.js";
export type { DriftMode, RewriteAction, RewriteResult } from "./inject.js";

export { STUB_TARGETS, STUB_TARGET_BY_ID } from "./stubs.js";

export { injectAll, removeAll } from "./injectAll.js";
export type {
  InjectAllConfig,
  RemoveAllConfig,
  RemoveAllResult,
} from "./injectAll.js";

export { RealClock, FakeClock } from "./clock.js";
export type { Clock } from "./clock.js";

export { injectForTarget } from "./injectForTarget.js";
export type { InjectForTargetOptions, InjectForTargetResult, TargetGuideVariant } from "./injectForTarget.js";
