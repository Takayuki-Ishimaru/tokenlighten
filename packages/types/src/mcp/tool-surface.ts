// ---------------------------------------------------------------------------
// DESIGN-v0.15 §8.2 (R7 Part B) — the startup-selected advertised/validated
// tool surface.
//
// "full" (the default) advertises every capability this server has ever
// advertised, unchanged. "code" advertises code/plain-text/config read/edit/
// search only: every Office/archive-member/credential-ref input (the whole
// `edit_file.artifact`/`credentials` blocks, `select`'s artifact-addressing
// keys, `budget.rows`/`cells`, `scope.archive`/`credentialRef`,
// `targets[].archive`/`credentialRef`) is removed from the advertised schema
// AND from the validator that accepts inbound calls — a code-surface caller
// sending one of those fields is refused `unknown-arguments`, the same
// closed-schema mechanism an unrelated unknown key gets, never silently
// accepted and never a hidden execution path.
//
// Both surfaces share one canonical schema/validator/advertisement source
// (`packages/mcp-server/src/server.ts`'s `ALL_TOOLS` plus a single filter
// function derived from it) — this type exists so that source has one
// canonical name for the axis it branches on, per AGENTS.md's rule that
// `packages/types/src/` is the only place a shared contract is defined.
//
// FIXED PER CONNECTION. The active surface is resolved exactly ONCE, at
// process start (CLI `--tool-surface <code|full>` / env
// `TOKENLIGHTEN_TOOL_SURFACE=code|full`, default `full`), and never re-read
// for the lifetime of that process. There is no mid-connection "switch the
// tool definitions on the same connection" path — the schema textbook v1
// invariant (one schema per connection) extends to this axis. Changing the
// surface means starting a new server process, which yields a new
// `computeSchemaStamp(advertisedTools())` value (`util/schemaStamp.ts`) and
// therefore a client reconnect, exactly the same mechanism already shipped
// for the v0.13.0 VS Code wedged-schema-cache fix.
// ---------------------------------------------------------------------------

/**
 * The two legal tool-surface values. See the module doc comment above for
 * what each advertises and the fixed-per-connection rule.
 */
export type ToolSurface = "code" | "full";

/**
 * Canonical, exhaustive list of the only legal {@link ToolSurface} values —
 * the single source a CLI/env parser walks to validate an incoming string,
 * and to compose an error message that names every accepted spelling, so
 * that list never drifts from the type itself.
 */
export const TOOL_SURFACE_VALUES: readonly ToolSurface[] = ["code", "full"];

/** Type guard: narrows an arbitrary parsed string to {@link ToolSurface}. */
export function isToolSurface(value: unknown): value is ToolSurface {
  return value === "code" || value === "full";
}
