// Plain data output — no meta envelope. See docs/00-postmortem.md §2.2.
//
// Template renderer for the AGENTS.md canonical block and tool-specific stubs.
// Spec: docs/components/04-agents-md-generator.md §6.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { StubTargetId, ToolSurface } from "@tokenlighten/types";
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

// GitHub Copilot Chat injects BOTH AGENTS.md and this file into every
// request (unlike Claude Code's native @AGENTS.md import), so a full guide
// copy here used to double the fixed per-request cost and hasten
// compaction. It also collided with Copilot's own built-in `read_file`
// tool name. Keep this a short pointer + Copilot-specific operational
// notes instead of duplicating the protocol prose — see AGENTS.md for
// that. WP-V1 (2026-09-20, still under INSTRUCTIONS_VERSION's v97 label —
// v97 itself has not shipped yet, so this is a further edit of it, not a
// new version): tool identity (the tokenlighten_* names), deferred-tool
// reload, and query-language guidance are cut here -- VS Code's own
// `initialize`-time instructions (clientAdvertisement.ts's
// VSCODE_SERVER_INSTRUCTIONS, injected on every single request regardless
// of whether a tool has been loaded yet) already say all three, so this
// stub only needs the notes that are NOT there: the large-result
// workaround, the do-not-target-AGENTS.md/omit-budget rule, the
// answer-as-soon-as-act.answer rule, and the delegation-cost warning.
const COPILOT_IMPORT_TEMPLATE = `${SENTINEL_START}
<!-- tl-instructions-version: {{VERSION}} -->
<!-- tl-instructions-sha256: {{SHA256}} -->
# TokenLighten MCP - GitHub Copilot notes

TL protocol: \`AGENTS.md\`; follow it. Copilot notes:

- A "Large tool result ... written to file" reply means the host hid it: re-issue with \`budget.bytes\` <= 7000; \`tl workspace setup\` raises Copilot's inline-result threshold.
- Do not list \`AGENTS.md\`/\`CLAUDE.md\` as targets (already in your instructions), and omit \`budget\` unless you want LESS than TL's default; follow a \`limit\`/\`next\` instead of a built-in read.
- Answer or edit as soon as \`decision.kind\` is \`act.answer\`/\`act.edit\`. To read more, make ONE \`read_file {targets:[...]}\` call naming all of them (a \`qref\` is optional); never fetch a \`remaining\` range you do not need.
- Do not delegate what one or two TL calls can answer: a subagent re-pays the whole context (~5 of your turns just to start). Only for a large independent investigation, pass \`agentName:"tokenlighten-explore"\` to \`runSubagent\` so the subagent also uses TL.
${SENTINEL_END}
`;

// VS Code Copilot Chat's `runSubagent` tool auto-lists every enabled
// `.github/agents/*.agent.md` custom agent (by name + description) in every
// agent's own system prompt and tells the parent to invoke it by name — see
// the frontmatter enum/parser at workbench.desktop.main.js offset ~4181396
// and ~4305944 (`e.header.userInvocable`/`e.header.disableModelInvocation`).
// This is a whole file (frontmatter + body), never a managed block inside an
// existing rules file, so — unlike CLAUDE_IMPORT_TEMPLATE/COPILOT_IMPORT_TEMPLATE
// above — its "preamble" (YAML frontmatter) is what makes Copilot treat the
// file as a custom agent at all, not an optional tool-native prologue.
//
// `tools:` entries are MCP "full reference names" (`<server-referenceName>/<tool
// referenceName>`), verified against workbench.desktop.main.js: `Upe()`
// (~offset 13517256) builds a tool's full reference name as
// `${toolSet.referenceName}/${tool.toolReferenceName}`; the MCP toolset's own
// `referenceName` is `serverDefinition.label.toLowerCase().replace(/\s+/g,"-")`
// (contrib/mcp languageModelTools sync, ~offset 14364943) — `label` here is
// literally the `.vscode/mcp.json` `servers` object key this repo's own
// `configureVsCode()` writes (`servers["tokenlighten"] = ...`,
// packages/cli/src/commands/workspace.ts), already lowercase with no
// whitespace, so it round-trips unchanged. `toToolAndToolSetEnablementMap()`
// (~offset 13514017) is what actually resolves a custom agent's parsed
// `tools:` array against these full reference names. Deliberately two
// explicit tool entries, never the `tokenlighten/*` toolset wildcard
// (`Fbn()`, ~offset 13517431) — the wildcard would also enable
// `tokenlighten/edit_file`, breaking this agent's read-only-by-construction
// guarantee.
const COPILOT_AGENT_FRONTMATTER = `---
name: tokenlighten-explore
description: Use ONLY when you have already decided to hand a LARGE, independent read-only investigation (many files across the repository) to a subagent. Do NOT delegate an ordinary question or trace - a subagent starts a whole new context and costs more than calling the TokenLighten tools yourself. Read-only; cannot edit.
tools:
  - tokenlighten/read_file
  - tokenlighten/search_files
user-invocable: false
---

`;

// Locale-independent and profile-independent (like CLAUDE_IMPORT_TEMPLATE/
// COPILOT_IMPORT_TEMPLATE above): this file's whole job is to point a
// runSubagent child at TL in a few lines, never to duplicate AGENTS.md's
// protocol prose.
const COPILOT_AGENT_IMPORT_TEMPLATE = `${SENTINEL_START}
<!-- tl-instructions-version: {{VERSION}} -->
<!-- tl-instructions-sha256: {{SHA256}} -->
# TokenLighten MCP - exploration subagent

Explore using ONLY the TokenLighten (TL) MCP tools (\`tokenlighten/read_file\`, \`tokenlighten/search_files\`); follow the protocol in \`AGENTS.md\`.

- Start with \`read_file {query:"<the subtask, with likely code identifiers>", task:{epoch:"new"}}\`.
- To read more files or ranges, make ONE \`read_file {targets:[...]}\` call naming all of them; answer as soon as \`decision.kind\` is \`act.answer\`.
- Use \`search_files\` for identifiers, references, and tree/inventory lookups.
- Put every known file into ONE \`targets:[...]\` call, not one call per file.
- When a reply carries \`limit\`/\`remaining\`, run its \`next\`.
- Omit \`budget\` unless you want LESS than TL's default.
- You cannot edit; never call \`edit_file\` or any write tool.
- Report findings with exact file paths and line ranges, not just summaries.
${SENTINEL_END}
`;

function loadTemplateForTarget(target: StubTargetId | undefined, locale: Locale): string {
  if (target === "claude") return CLAUDE_IMPORT_TEMPLATE;
  if (target === "copilot") return COPILOT_IMPORT_TEMPLATE;
  if (target === "copilot-agent") return COPILOT_AGENT_IMPORT_TEMPLATE;
  return loadTemplate(locale);
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

// DESIGN-v0.15 §8.2 (R7 Part B): guide/tool-surface pairing. The "full"
// guide tier is the ONLY tier that mentions archive/credential capabilities
// in prose (compact/medium templates never do — nothing to strip there,
// this is a harmless no-op on them). `AGENTS.md.tmpl`/`.jp.tmpl` wrap that
// prose in these markers, each on its own line.
const FULL_ONLY_START = "<!-- tl-full-only:start -->";
const FULL_ONLY_END = "<!-- tl-full-only:end -->";
// Inline variant: wraps a full-only PHRASE inside an otherwise code-legal
// sentence (no surrounding newline to consume/preserve, unlike the
// line-oriented block markers above).
const FULL_ONLY_INLINE_START = "<!--tl-full-only-inline-->";
const FULL_ONLY_INLINE_END = "<!--/tl-full-only-inline-->";

/**
 * `full` (default) strips ONLY the marker text, keeping every wrapped word —
 * the rendered output is therefore byte-identical to a template that never
 * had these markers, which is why the root AGENTS.md generated block (always
 * rendered at "full") does not change. `code` strips the markers AND
 * whatever they wrap (a whole line/block for the line-oriented pair, an
 * inline phrase for the other), so a `--tool-surface code` workspace's
 * generated guide never mentions a capability its advertised schema does
 * not have.
 */
function applyToolSurface(template: string, toolSurface: ToolSurface): string {
  if (toolSurface === "code") {
    return template
      .replace(new RegExp(`${FULL_ONLY_START}\\n[\\s\\S]*?${FULL_ONLY_END}\\n?`, "g"), "")
      .replace(new RegExp(`${FULL_ONLY_INLINE_START}[\\s\\S]*?${FULL_ONLY_INLINE_END}`, "g"), "");
  }
  return template
    .replace(new RegExp(`${FULL_ONLY_START}\\n`, "g"), "")
    .replace(new RegExp(`${FULL_ONLY_END}\\n`, "g"), "")
    .replace(new RegExp(FULL_ONLY_INLINE_START, "g"), "")
    .replace(new RegExp(FULL_ONLY_INLINE_END, "g"), "");
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
  if (target === "copilot-agent") return COPILOT_AGENT_FRONTMATTER;
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
export type GuideProfile = "full" | "medium" | "compact";

// P2-3(1): re-exported unchanged for existing consumers (packages/cli,
// index.ts) — guideProfileDefault.ts is now the source of truth, split out
// for the same CJS-bundling reason INSTRUCTIONS_VERSION is (see version.ts's
// header comment): a consumer that only needs this pure defaulting rule
// must be able to import it without pulling render.ts's module-load-time
// fileURLToPath(import.meta.url) template-path resolution in at all.
export { defaultGuideProfileForSurface } from "./guideProfileDefault.js";

function loadMediumTemplate(locale: Locale): string {
  const suffix = locale === "jp" ? ".jp.tmpl" : ".tmpl";
  return readFileSync(join(TEMPLATE_DIR, `medium.md${suffix}`), "utf8");
}

function loadCompactTemplate(locale: Locale): string {
  const suffix = locale === "jp" ? ".jp.tmpl" : ".tmpl";
  return readFileSync(join(TEMPLATE_DIR, `compact.md${suffix}`), "utf8");
}

function loadTemplateForProfile(
  target: StubTargetId | undefined,
  locale: Locale,
  profile: GuideProfile,
  toolSurface: ToolSurface,
): string {
  if (target === "claude") return applyToolSurface(CLAUDE_IMPORT_TEMPLATE, toolSurface);
  // Copilot's stub is fixed regardless of profile (like Claude's import
  // block above): the short pointer replaces medium/compact too, since the
  // whole point is to never duplicate protocol prose in this file, at any
  // guide profile or tool surface.
  if (target === "copilot") return applyToolSurface(COPILOT_IMPORT_TEMPLATE, toolSurface);
  // Same reasoning as "copilot" above: a custom-agent file body stays fixed
  // across every guide profile/tool surface.
  if (target === "copilot-agent") return applyToolSurface(COPILOT_AGENT_IMPORT_TEMPLATE, toolSurface);
  if (profile === "medium") return applyToolSurface(loadMediumTemplate(locale), toolSurface);
  if (profile === "compact") return applyToolSurface(loadCompactTemplate(locale), toolSurface);
  return applyToolSurface(loadTemplateForTarget(target, locale), toolSurface);
}

export function renderBlock(
  target: StubTargetId | undefined,
  locale: Locale = "en",
  version: string = INSTRUCTIONS_VERSION,
  profile: GuideProfile = "full",
  // DESIGN-v0.15 §8.2 (R7 Part B): trailing/optional so every existing
  // positional call site (profile-only callers included) is unaffected —
  // "full" reproduces exactly today's output (applyToolSurface's "full"
  // branch only removes the (new, otherwise-invisible) marker lines).
  toolSurface: ToolSurface = "full",
): string {
  const template = loadTemplateForProfile(target, locale, profile, toolSurface);
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
  toolSurface: ToolSurface = "full",
): string {
  return renderBlock(undefined, locale, version, profile, toolSurface);
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
  toolSurface: ToolSurface = "full",
): string {
  const template = loadTemplateForProfile(target, locale, profile, toolSurface);
  const withVersion = template
    .replace(/{{VERSION}}/g, version)
    .replace(/{{SHA256}}/g, "0".repeat(64));
  const bodyForHash = extractBodyForHash(withVersion);
  return sha256hex(bodyForHash);
}

/**
 * Medium guide profile (E8). A shorter, hand-authored EN/JP template that
 * keeps the exercised decision-tree rules (task_pack, decision.kind, refusal/
 * retry, edits[], verification kit, receipts) at roughly a quarter of the
 * full block's bytes. Wired as a first-class `GuideProfile`: `injectAll`,
 * the `tl-agents` CLI (`--profile medium`), and `renderBlock`/
 * `renderCanonicalBlock`/`blockSha256` all accept `"medium"` and apply the
 * same `{{VERSION}}`/`{{SHA256}}` substitution as `"full"`.
 */
export function renderMediumBlock(locale: Locale = "en", version: string = INSTRUCTIONS_VERSION): string {
  return renderTemplate(loadMediumTemplate(locale), version);
}

/**
 * Compact Bootstrap v1 (DESIGN-v0.10-expansion-plan-v1.3.md V10-07;
 * reconciliation §5 D-7). A separate, hand-authored EN/JP template carrying
 * ONLY the always-on rules a caller cannot safely learn on-demand: the
 * 3-tool routing rule, workspace-write safety (`cwd`/`lane`), the
 * receipt-never-dead-ends rule, the unknown-`kind` safe-stop, and
 * follow-every-`next`. Everything else the full block teaches (artifact/
 * archive specifics, verification-kit detail, per-kind deep rules) arrives
 * on-demand inside the response that needs it instead of paying a fixed
 * per-session cost — see `templates/compact.md.tmpl`'s own body.
 *
 * Wired two ways: (1) directly, as `injectForTarget`'s opt-in
 * `guide: "compact"` target-repo variant (V10-07 rc.1 decision,
 * 2026-08-20; unchanged by this wave); and (2) since this wave, as a
 * first-class `GuideProfile` alongside `"full"`/`"medium"` — `injectAll`
 * and the `tl-agents` CLI (`--profile compact`) can now write it to every
 * stub target with the same `{{VERSION}}`/`{{SHA256}}` substitution and
 * sentinel-based drift detection the other profiles get. The default
 * guide for both paths remains `"full"`; nothing here changes that.
 */
export function renderCompactBlock(locale: Locale = "en", version: string = INSTRUCTIONS_VERSION): string {
  return renderTemplate(loadCompactTemplate(locale), version);
}
