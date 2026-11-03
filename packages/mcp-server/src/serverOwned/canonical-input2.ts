// canonical-input — extracted implementation; imports point to the owning modules.
import type { AlternativeValueType } from "../validation/requestShape.js";
import type { LineWindow } from "@tokenlighten/types";
import { appendReadRequestTarget } from "../state/readRequestStore.js";
import { currentSessionLane } from "../util/laneKey.js";
import { findInvalidValues } from "../validation/requestShape.js";
import { openReadRequest } from "../state/readRequestStore.js";
import { protocolCallContext } from "../protocol/envelope.js";

/**
 * `JSON.parse` a string that at least LOOKS like an object/array — never
 * attempted on an ordinary string value (a real path, a real query token),
 * so a legitimate string is never even candidate-parsed, let alone coerced.
 */
/**
 * Re-validate a rescued (parsed) value against the SAME recursive
 * property-name schema (`findUnknownProperties`'s walk) the field would
 * receive if it had arrived natively, scoped to just this one field — so a
 * stringified `task` that invents an unadvertised sub-property is refused
 * exactly as a native one would be, never silently smuggled in. Reads the
 * REAL, LIVE advertised schema (`advertisedPropertiesFor`), never a
 * hand-maintained mirror of it.
 */
// ---------------------------------------------------------------------------
// DESIGN-v0.15 §5 (R2) — the read-request cursor
// ---------------------------------------------------------------------------

/**
 * The caller's own CANONICAL arguments, stashed before the legacy projection.
 *
 * `ProtocolCallContext.args` carries the POST-normalization dialect
 * (`maxBytes`, `paths`, `mode`, …), which is exactly what a restart `next` may
 * not contain under `TL_LEGACY_INPUT=refuse`. This marker is set in `callTool`,
 * one statement before `normalizeCanonicalRequest` runs, so the request record
 * can restate the ORIGINAL request in the one dialect the server is allowed to
 * prescribe. Symbol-keyed and therefore invisible to `Object.keys` — the
 * unknown-argument fence never sees it — but ENUMERABLE, so it survives the
 * `{...input}` spreads between here and `dispatchTool` (same contract as
 * `HANDLE_OVERRIDES_INPUT`).
 */
export const CANONICAL_ORIGINAL_INPUT = Symbol("tokenlighten.read-file-canonical-original-input");

/** Raw canonical entry provenance, separate from restart-safe canonical fields. */
export const QUERY_CANDIDATE_POLICY_INPUT = Symbol("tokenlighten.query-candidate-policy-input");

/** The advertised `tl_read_file` inputs a restart `next` may carry. */
export const CANONICAL_READ_INPUT_KEYS: readonly string[] =
  ["query", "qref", "targets", "content", "select", "budget", "task", "scope"];

/**
 * A cursor call carries ONLY the cursor plus call scoping and the two
 * sanctioned overrides.
 *
 * §5.2: "継続時に許す上書きは広告されたbudget調整とforce_serve等の再送指定に
 * 限り、targets/query/contentの無言変更は拒否する" — the silent change is the
 * thing being refused, so the refusal NAMES the field rather than letting the
 * `oneOf` composition reject the call with no field to fix.
 */
export function cursorCoInputRefusal(
  canonical: string,
  input: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (canonical !== "tl_read_file") return undefined;
  if (typeof input["cursor"] !== "string" || input["cursor"] === "") return undefined;
  const refuse = (field: string): Record<string, unknown> => ({
    ok: false,
    code: "invalid-input",
    field,
    error: `tl_read_file cursor continuation cannot carry '${field}'`,
    detail: "cursor continuation accepts only budget/task.force_serve overrides",
    retry: "call",
  });
  for (const key of ["targets", "query", "qref", "content", "select", "scope"]) {
    if (input[key] !== undefined) return refuse(key);
  }
  const task = input["task"];
  if (task !== null && typeof task === "object" && !Array.isArray(task)) {
    for (const key of ["epoch", "pull"]) {
      if ((task as Record<string, unknown>)[key] !== undefined) return refuse(`task.${key}`);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 2026-10-10 v0.15.1 runtime review (P1 + P3): validate the CANONICAL request
// against the advertised schema before it is projected onto the legacy
// dispatch dialect.
// ---------------------------------------------------------------------------
//
// The strict name fence in dispatch runs AFTER `projectCanonicalRequest`, and
// the projection copies only the carrier members it knows, so a misspelled
// member of a carrier vanished before any fence saw it:
// `targets:[{path, rnage:"1-1"}]` read the whole file, `budget:{byte:100}`
// served uncapped, `task:{epcoh:"new"}` kept the old task. A misspelled
// top-level carrier did reach the fence, but was named against the flattened
// legacy key set (`maxRows`, `as`, …) with no suggestion. And no VALUE was
// checked anywhere: an out-of-enum `precondition` ran an edit with no guard.
//
// This runs once per call on the prepared canonical input (stringified
// carriers already parsed, EFF near-miss rewrites already applied):
//  - member names of the canonical carriers listed below, against the
//    advertised shape — `targets[]`/`budget`/`scope`/`select`/`task` on the
//    read tools, `task`/`credentials` on tl_edit_file, whose `edits[]` items
//    and top level keep their own fence with its incident rewrites;
//  - top-level names that are neither advertised nor an accepted legacy
//    spelling (read tools only — tl_edit_file's fence owns its top level);
//  - every advertised value: enums, primitive types, and the dependent
//    fields of an `edits[]` item.
// Absent and `null` values are not checked (see `findInvalidValues`).

/** Canonical carriers whose member names are validated before projection. */
export const CANONICAL_NAME_CHECKED_CARRIERS: Readonly<Record<string, readonly string[]>> = {
  tl_read_file: ["targets", "budget", "scope", "select", "task"],
  tl_search_files: ["budget", "scope", "task"],
  tl_edit_file: ["task", "credentials"],
};

/** Per-tool value-validation options (see `ValueValidationOptions`). */
// The near-miss shapes `normalizeWireArgs` repairs on purpose (replay corpus
// group c2, "field-reported tolerant wire shapes") stay accepted: a digit
// string for a budget/depth number, a boolean-like string for `regex`, a lone
// string for `queries`. Only a value dispatch would IGNORE or MISREAD is
// refused here.
// `cwd` and `lane` keep their own, more specific refusals (`invalid-cwd`,
// `invalid-lane`), which dispatch raises before touching any state.
export const DISPATCH_VALIDATED_SCALARS = (tool: string): ReadonlySet<string> => new Set([`${tool}.cwd`, `${tool}.lane`]);

export const TOLERATED_BUDGET_NUMBERS = (tool: string): Record<string, readonly AlternativeValueType[]> => ({
  [`${tool}.budget.bytes`]: ["numeric-string"],
  [`${tool}.budget.tokens`]: ["numeric-string"],
  [`${tool}.budget.items`]: ["numeric-string"],
  [`${tool}.scope.depth`]: ["numeric-string"],
  [`${tool}.scope.regex`]: ["boolean-string"],
});

export const CANONICAL_VALUE_OPTIONS: Readonly<Record<string, Parameters<typeof findInvalidValues>[3]>> = {
  tl_read_file: {
    // `content:"defer"` is the compatibility spelling of the small-file read
    // (`projectCanonicalRequest` maps it to mode small_file;
    // canonicalSurface.spec.ts pins the route).
    compatibilityValues: { "tl_read_file.content": ["defer"] },
    alternativeTypes: {
      ...TOLERATED_BUDGET_NUMBERS("tl_read_file"),
      // Their readers stringify each entry (`.map(String)`): a page, slide,
      // column or numbering-token section sent as a number keeps working.
      "tl_read_file.select.pages[]": ["number"],
      "tl_read_file.select.slides[]": ["number"],
      "tl_read_file.select.columns[]": ["number"],
      "tl_read_file.select.sections[]": ["number"],
    },
    skipPaths: DISPATCH_VALIDATED_SCALARS("tl_read_file"),
  },
  tl_search_files: {
    alternativeTypes: { ...TOLERATED_BUDGET_NUMBERS("tl_search_files"), "tl_search_files.queries": ["string"] },
    // dispatch resolves its own action aliases (grep/search/list/def/…,
    // symbols, locate) and refuses an unknown one with the full list.
    skipPaths: new Set([...DISPATCH_VALIDATED_SCALARS("tl_search_files"), "tl_search_files.action"]),
  },
  // tl_edit_file's `edits[].target` value set depends on the item kind and is
  // checked in `editItemTargetViolations`.
  tl_edit_file: { skipPaths: DISPATCH_VALIDATED_SCALARS("tl_edit_file") },
};

export function stageReadRequestForServe(input: {
  workspace: string;
  relPath: string;
  fileSha: string;
  totalLines: number;
  requested: LineWindow[];
  content: "full" | "auto" | "outline";
  keepComments: boolean;
  args: Record<string, unknown>;
  /**
   * TL-REVIEW-2 (2026-10-06): the comment windows excluded from `requested`
   * because this representation elides them — recorded on the target so
   * every continuation page restates them as `elided` (readRequestStore.ts's
   * `ReadRequestTargetState.elided`).
   */
  elided?: LineWindow[];
}): void {
  if (input.totalLines <= 0 || input.requested.length === 0) return;
  const context = protocolCallContext();
  if (context === undefined) return;
  if (context.readRequest !== undefined) {
    // DESIGN-v0.15 §5.1: a multi-target `content:"full"` call's Q must span
    // EVERY target, not just the first one this call's producer loop reached.
    // `server.ts`'s `mode=full` `paths[]` batch calls this once per path in
    // request order; the first call opens the request (below) and every
    // later call for a NEW path in the SAME dispatch appends to it instead of
    // silently staying single-target (a no-op here would repeat the
    // "abandons every target after the first" defect this append closes).
    appendReadRequestTarget(context.readRequest, {
      path: input.relPath,
      sha: input.fileSha,
      totalLines: input.totalLines,
      representation: { content: input.content, comments: input.keepComments ? "keep" : "elide" },
      requested: input.requested,
      ...(input.elided !== undefined && input.elided.length > 0 ? { elided: input.elided } : {}),
    });
    return;
  }
  const raw = (input.args as Record<PropertyKey, unknown>)[CANONICAL_ORIGINAL_INPUT];
  const canonical = raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? { ...(raw as Record<string, unknown>) }
    : {};
  // A LEGACY-dialect caller (only reachable with `TL_LEGACY_INPUT=accept`)
  // leaves nothing canonical to restate, so the restart `next` is synthesized
  // from what this serve knows. Either way `original_input` is canonical: the
  // server never prescribes a call its own default dispatch would refuse.
  if (canonical["targets"] === undefined && canonical["query"] === undefined && canonical["qref"] === undefined) {
    canonical["targets"] = [{ path: input.relPath }];
    canonical["content"] = input.content;
  }
  const budgetBytes = typeof input.args["maxBytes"] === "number" ? input.args["maxBytes"] : undefined;
  const budgetTokens = typeof input.args["maxTokens"] === "number" ? input.args["maxTokens"] : undefined;
  const lane = currentSessionLane();
  const taskHandle = typeof input.args["task_handle"] === "string" ? input.args["task_handle"] : undefined;
  const cwd = typeof input.args["cwd"] === "string" ? input.args["cwd"] : undefined;
  const staged = openReadRequest({
    workspaceRoot: input.workspace,
    ...(lane !== "" ? { lane } : {}),
    ...(taskHandle !== undefined ? { taskHandle } : {}),
    originalInput: canonical,
    ...(budgetBytes !== undefined || budgetTokens !== undefined
      ? {
          budget: {
            ...(budgetBytes !== undefined ? { bytes: budgetBytes } : {}),
            ...(budgetTokens !== undefined ? { tokens: budgetTokens } : {}),
          },
        }
      : {}),
    forceServeOrigin: input.args["force_serve"] === true,
    echo: {
      ...(cwd !== undefined ? { cwd } : {}),
      ...(lane !== "" ? { lane } : {}),
      ...(taskHandle !== undefined ? { taskHandle } : {}),
    },
    targets: [{
      path: input.relPath,
      sha: input.fileSha,
      totalLines: input.totalLines,
      representation: { content: input.content, comments: input.keepComments ? "keep" : "elide" },
      requested: input.requested,
      ...(input.elided !== undefined && input.elided.length > 0 ? { elided: input.elided } : {}),
    }],
  });
  if (staged !== undefined) context.readRequest = staged;
}
