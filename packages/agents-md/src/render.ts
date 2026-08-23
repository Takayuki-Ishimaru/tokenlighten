// Plain data output — no meta envelope. See docs/00-postmortem.md §2.2.
//
// Template renderer for the AGENTS.md canonical block and tool-specific stubs.
// Spec: docs/components/04-agents-md-generator.md §6.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { StubTargetId } from "@tokenlighten/types";
import { SENTINEL_START, SENTINEL_END, sha256hex } from "./sentinel.js";
import { INSTRUCTIONS_VERSION } from "./version.js";

// Re-exported unchanged for existing consumers (injectAll.ts, index.ts) —
// version.ts is now the source of truth; see its header comment for why.
export { INSTRUCTIONS_VERSION } from "./version.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Template directory (one level up from src/). */
const TEMPLATE_DIR = join(__dirname, "..", "templates");

export type Locale = "en" | "jp";

/**
 * Load the raw template for the given locale.
 * Falls back to "en" if the locale file is not found.
 */
function loadTemplate(locale: Locale): string {
  const suffix = locale === "jp" ? ".jp.tmpl" : ".tmpl";
  const path = join(TEMPLATE_DIR, `AGENTS.md${suffix}`);
  return readFileSync(path, "utf8");
}

/** Claude Code imports AGENTS.md natively; do not duplicate its contents. */
const CLAUDE_IMPORT_TEMPLATE = `${SENTINEL_START}
<!-- tl-instructions-version: {{VERSION}} -->
<!-- tl-instructions-sha256: {{SHA256}} -->
# Claude Code

@AGENTS.md
${SENTINEL_END}
`;

function loadTemplateForTarget(target: StubTargetId | undefined, locale: Locale): string {
  return target === "claude" ? CLAUDE_IMPORT_TEMPLATE : loadTemplate(locale);
}

/**
 * Extract the body text between the sentinel lines from a template.
 * The template file already contains the full block with {{VERSION}} / {{SHA256}}
 * placeholders. We substitute those then return the full block.
 *
 * The sha256 is computed over the prose body (everything between the sentinel
 * lines, excluding version-line and hash-line themselves) so that it is
 * stable across tool-specific overrides that add prologues/epilogues.
 */
function renderTemplate(template: string, version: string): string {
  // First pass: substitute version (sha not yet known)
  const withVersion = template
    .replace(/{{VERSION}}/g, version)
    .replace(/{{SHA256}}/g, "0".repeat(64)); // placeholder

  // Compute sha over the body between sentinels (excluding version + hash lines)
  const bodyForHash = extractBodyForHash(withVersion);
  const sha = sha256hex(bodyForHash);

  // Second pass: inject real sha
  return withVersion.replace("0".repeat(64), sha);
}

/**
 * Extract the prose body (everything between start sentinel and end sentinel,
 * excluding the version-line and hash-line) for SHA computation.
 * This keeps the sha stable regardless of version bump or tool overrides.
 */
function extractBodyForHash(rendered: string): string {
  const startIdx = rendered.indexOf(SENTINEL_START);
  const endIdx = rendered.indexOf(SENTINEL_END);
  if (startIdx < 0 || endIdx < 0) return rendered;

  const inner = rendered.slice(startIdx + SENTINEL_START.length, endIdx);
  // Remove version-line and hash-line (comment lines matching the patterns).
  // 2026-07-12b2: the version pattern used `[^-]*`, which can never match —
  // version strings are hyphenated (YYYY-MM-DD-vNN-slug) — so the version
  // line was silently INCLUDED in every sha (the sha256 twin only worked
  // because hex has no hyphens). `.*?` restores the documented contract:
  // the sha is a pure content hash, stable across version bumps.
  return inner
    .replace(/<!--\s*tl-instructions-version:.*?-->\s*\n?/g, "")
    .replace(/<!--\s*tl-instructions-sha256:.*?-->\s*\n?/g, "");
}

/**
 * Cursor YAML frontmatter prefix (alwaysApply: true).
 * Spec: docs/components/04-agents-md-generator.md §6 tool-specific overrides.
 */
const CURSOR_FRONTMATTER = `---
description: TokenLighten MCP evidence-first routing
alwaysApply: true
---

`;

const CONTINUE_FRONTMATTER = `---
name: TokenLighten MCP workflow
description: Close codebase exploration with TokenLighten's evidence-backed readiness protocol
alwaysApply: true
---

`;

/** Target-native metadata/prologue that must remain before the managed block. */
export function renderTargetPreamble(target: StubTargetId | undefined): string {
  if (target === "cursor") return CURSOR_FRONTMATTER;
  if (target === "continue") return CONTINUE_FRONTMATTER;
  return "";
}

/**
 * Render the full managed block for a given target and locale.
 *
 * The returned string includes an optional prologue, then the start sentinel,
 * version-line, sha256-line, body prose, and end sentinel — all on LF line
 * endings.
 *
 * @param target  The stub target id ("claude" | "copilot" | etc.). Pass
 *   undefined to render the canonical AGENTS.md block (no overrides).
 * @param locale  "en" (default) or "jp".
 * @param version Override version string (defaults to INSTRUCTIONS_VERSION).
 */
export type GuideProfile = "full" | "medium";

function loadMediumTemplate(): string {
  return readFileSync(join(TEMPLATE_DIR, "medium.md.tmpl"), "utf8");
}

function loadTemplateForProfile(
  target: StubTargetId | undefined,
  locale: Locale,
  profile: GuideProfile,
): string {
  if (target === "claude") return CLAUDE_IMPORT_TEMPLATE;
  return profile === "medium" ? loadMediumTemplate() : loadTemplateForTarget(target, locale);
}

export function renderBlock(
  target: StubTargetId | undefined,
  locale: Locale = "en",
  version: string = INSTRUCTIONS_VERSION,
  profile: GuideProfile = "full",
): string {
  const template = loadTemplateForProfile(target, locale, profile);
  const rendered = renderTemplate(template, version);
  return renderTargetPreamble(target) + rendered;
}

/**
 * Convenience: render the canonical block that goes into AGENTS.md itself.
 */
export function renderCanonicalBlock(
  locale: Locale = "en",
  version: string = INSTRUCTIONS_VERSION,
  profile: GuideProfile = "full",
): string {
  return renderBlock(undefined, locale, version, profile);
}

/**
 * Extract the sha256 that would be embedded in a rendered block.
 * Useful for pre-computing the expected hash without re-parsing.
 */
export function blockSha256(
  locale: Locale = "en",
  version: string = INSTRUCTIONS_VERSION,
  target?: StubTargetId,
  profile: GuideProfile = "full",
): string {
  const template = loadTemplateForProfile(target, locale, profile);
  const withVersion = template
    .replace(/{{VERSION}}/g, version)
    .replace(/{{SHA256}}/g, "0".repeat(64));
  const bodyForHash = extractBodyForHash(withVersion);
  return sha256hex(bodyForHash);
}

/**
 * Compact Bootstrap v1 (DESIGN-v0.10-expansion-plan-v1.3.md V10-07;
 * reconciliation §5 D-7). A separate, hand-authored, English-only template
 * carrying ONLY the always-on rules a caller cannot safely learn on-demand:
 * the 3-tool routing rule, workspace-write safety (`cwd`/`lane`), the
 * receipt-never-dead-ends rule, the unknown-`kind` safe-stop, and
 * follow-every-`next`. Everything else the full block teaches (artifact/
 * archive specifics, verification-kit detail, per-kind deep rules) is meant
 * to arrive on-demand inside the response that needs it instead of paying a
 * fixed per-session cost — see `templates/compact.md.tmpl`'s own header.
 *
 * NOT WIRED INTO ANY DISTRIBUTION THIS WAVE: no stub target renders this,
 * `injectAll`/`injectForTarget` never call it, and no drift/sentinel
 * machinery tracks it (no `{{SHA256}}` substitution — there is nothing to
 * detect drift against yet). It exists as a rendered artifact plus
 * `__tests__/compactBootstrap.spec.ts`'s size/content measurements so a
 * later rc wave can decide whether/how to wire it in (client-profile
 * selection, a `compact` stub-target flag, etc.) with real numbers in hand
 * rather than guessing.
 */
export function renderMediumBlock(version: string = INSTRUCTIONS_VERSION): string {
  return renderTemplate(loadMediumTemplate(), version);
}

export function renderCompactBlock(version: string = INSTRUCTIONS_VERSION): string {
  const path = join(TEMPLATE_DIR, "compact.md.tmpl");
  const template = readFileSync(path, "utf8");
  return template.replace(/{{VERSION}}/g, version);
}
