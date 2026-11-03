// edit-validation — extracted implementation; imports point to the owning modules.
import type { InvalidValueViolation } from "../validation/requestShape.js";
import type { SchemaNode } from "../validation/requestShape.js";
import { ACTIVE_TOOL_SURFACE } from "../runtime/config.js";
import { ALL_TOOLS } from "./read-admission2.js";
import { EDIT_FILE_TOP_LEVEL_ONLY_ARGS } from "./tool-schema.js";
import { FULL_ONLY_PROPERTY_PATHS } from "../protocol/toolSchemas.js";
import { KILL_SWITCH } from "../runtime/config.js";
import { MAX_CREATE_CONTENT_BYTES } from "./edit-anchor.js";
import { activeRoot } from "../runtime/config.js";
import { advertisedKeysForRefusal } from "./tool-schema.js";
import { advertisedPropertiesFor } from "./tool-schema.js";
import { asCanonicalObject } from "./canonical-input.js";
import { dispatchPropertiesFor } from "./tool-schema.js";
import { effEditDietEnabled } from "../util/flags.js";
import { filterToolDefinitionForSurface } from "../protocol/toolSchemas.js";
import { findInvalidValues } from "../validation/requestShape.js";
import { findSmallBodiesEnabled } from "../util/flags.js";
import { findUnknownProperties } from "../validation/requestShape.js";
import { invalidValueRefusal } from "../validation/requestShape.js";
import { isCliCodingHost } from "../protocol/clientAdvertisement.js";
import { isCopilotCliClient } from "../protocol/clientAdvertisement.js";
import { leanCallsEnabled } from "../util/flags.js";
import { leanSchemaForEveryClient } from "../protocol/toolSchemas.js";
import { leanToolDefinitionForClient } from "../protocol/toolSchemas.js";
import { minimalToolsEnabled } from "../util/flags.js";
import { nearestAdvertisedKey } from "../validation/requestShape.js";
import { portableToolDefinition } from "../protocol/portableAdvertisement.js";
import { portableToolsEnabled } from "../util/flags.js";
import { resolvedClientId } from "../runtime/config.js";
import { stripNestedSchemaDescriptions } from "../protocol/toolSchemas.js";
import { toolDescriptionForClient } from "../protocol/clientAdvertisement.js";
import { unknownPropertyRefusal } from "../validation/requestShape.js";
import { withinRefusalBudget } from "../validation/requestShape.js";

/** The extra guidance for one unknown per-item key, or undefined if neither shape applies. */
export function editFileMisnestedArgHint(key: string): string | undefined {
  if (key === "replace_all") {
    return "per-item `replace_all` is not advertised; use `precondition:\"unique-match\"` for a single site or one edit item per site / `edits[]`";
  }
  if (EDIT_FILE_TOP_LEVEL_ONLY_ARGS.has(key)) {
    return `\`${key}\` is a top-level tl_edit_file argument, not a per-edit key — move it up`;
  }
  return undefined;
}

/**
 * The top-level arguments an unknown-argument REWRITE replays verbatim from
 * the caller's own call. Extracted from the `edits[].operations` incident
 * branch below (R29-FIX) so the D4 flat-rename branch cannot drift from it;
 * the operations branch's emitted bytes are unchanged by the extraction.
 */
export function editFileIncidentBaseArguments(args: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(typeof args["cwd"] === "string" ? { cwd: args["cwd"] } : {}),
    ...(typeof args["lane"] === "string" ? { lane: args["lane"] } : {}),
    ...(typeof args["operation_id"] === "string" ? { operation_id: args["operation_id"] } : {}),
  };
}

/**
 * Bound a mechanically-rewritten `edits[]` continuation to the same 32 KiB
 * payload cap the caller's own batch would be refused against, admitting
 * WHOLE groups (never splitting one file's items across the cap boundary)
 * and naming the honest remainder rather than silently dropping files.
 *
 * Shared by both rewrite branches in `editFileUnknownArgumentRefusal`
 * (R29-FIX `edits[].operations`, D4 flat `{old,new}` rename). Factored so the
 * two branches cannot diverge in what they promise AND so this file keeps
 * exactly the two serialized-size pre-shed admission sites
 * wireBudgetG8Fence.spec.ts's EXEMPT table reviewed and pinned for it — a
 * second copy of this loop would be a THIRD and FOURTH unreviewed site.
 *
 * `remainingTail` is the branch-specific instruction appended to the
 * `remaining` disclosure; everything before it is shared vocabulary.
 */
export function boundedCorrectedEditsCall<T>(
  groups: ReadonlyArray<{ readonly fileLabel: string; readonly items: readonly T[] }>,
  baseArguments: Record<string, unknown>,
  remainingTail: string,
): { next?: { tool: "tl_edit_file"; arguments: Record<string, unknown> }; remaining?: string } {
  const fullCorrectedEdits = groups.flatMap((f) => [...f.items]);
  const fullCandidate = { tool: "tl_edit_file" as const, arguments: { ...baseArguments, edits: fullCorrectedEdits } };
  if (Buffer.byteLength(JSON.stringify(fullCandidate), "utf8") <= MAX_CREATE_CONTENT_BYTES) {
    return { next: fullCandidate };
  }
  // Bounded: include whole files (never split one file's own items across
  // the cap boundary) until the next one would exceed it.
  let includedFiles = 0;
  let acc: T[] = [];
  for (const file of groups) {
    const candidateEdits = [...acc, ...file.items];
    const candidate = { tool: "tl_edit_file" as const, arguments: { ...baseArguments, edits: candidateEdits } };
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > MAX_CREATE_CONTENT_BYTES) break;
    acc = candidateEdits;
    includedFiles++;
  }
  if (includedFiles === 0) return {};
  const omitted = groups.slice(includedFiles).map((f) => f.fileLabel);
  return {
    next: { tool: "tl_edit_file", arguments: { ...baseArguments, edits: acc } },
    remaining:
      `${omitted.length} file(s) omitted for the 32 KiB tl_edit_file payload cap: ${omitted.join(", ")} — ${remainingTail}`,
  };
}

// ---------------------------------------------------------------------------
// D4 (2026-09-05, measured paid smoke r10): the FLAT sibling of the
// R29-FIX `edits[].operations` incident below. Two live cells sent
// edits:[{path, handle, allowPathFallback, old, new}, …] — a caller-native
// rename/hunk spelling of the advertised {search, replace} pair — and got a
// bare `unknown-arguments` refusal with a 36-entry `fields` list and NO
// executable recovery (treatment cell SF13, call 25: an 18-item batch).
// Same remedy, same guarantees: rewrite mechanically using the caller's OWN
// text, never a placeholder, and only when the mapping is total and
// unambiguous.
// ---------------------------------------------------------------------------
/** Caller spellings of the advertised `search` side of an edits[] item. */
export const FLAT_RENAME_SEARCH_ALIASES: readonly string[] = ["search", "old", "from"];

/** Caller spellings of the advertised `replace` side of an edits[] item. */
export const FLAT_RENAME_REPLACE_ALIASES: readonly string[] = ["replace", "new", "to"];

export const FLAT_RENAME_ALIASES: ReadonlySet<string> = new Set([
  ...FLAT_RENAME_SEARCH_ALIASES,
  ...FLAT_RENAME_REPLACE_ALIASES,
]);

/**
 * The per-item keys the rewrite knows how to CARRY. An allowlist, not a
 * denylist, on purpose: this refusal exists because "a dropped argument can
 * silently change which span is overwritten", so an item carrying any other
 * advertised key (`content`, `range`, `create`, `intent`, `target`,
 * `directoryHandle`, …) makes the rewrite non-total and the whole batch
 * falls through to the unchanged prose refusal rather than being rewritten
 * with that key dropped.
 */
export const FLAT_RENAME_CARRIED_ITEM_KEYS: readonly string[] = [
  "path", "handle", "allowPathFallback", "precondition", "expectedSha", "scopeHandle", "review",
];

/**
 * The top-level keys a flat-rename rewrite can replay. NOTE the spellings:
 * `editFileUnknownArgumentRefusal` runs on the POST-`normalizeCanonicalRequest`
 * argument object, where a canonical `task:{handle,epoch}` has already been
 * projected onto `task_handle`/`taskEpoch` (mapCanonicalTask) — the measured
 * r10 wire's `task:{handle}` arrives here as `task_handle`.
 *
 * Any OTHER accepted top-level key (`credentials`, `artifact`, `challenge`,
 * `force_serve`, `expected_state_version`, a `task.pull` projected onto
 * `mode`, …) would be silently dropped by the rewrite, so its presence
 * disqualifies the branch — same no-silent-drop rule as
 * `FLAT_RENAME_CARRIED_ITEM_KEYS`. An UNKNOWN top-level key disqualifies it
 * too, via the `unknownTop.length === 0` clause at the call site.
 */
export const FLAT_RENAME_CARRIED_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  "edits", "cwd", "lane", "operation_id", "task_handle", "taskEpoch",
]);

/**
 * Re-project the two task fields the rewrite carries back into the CANONICAL
 * `task` object `next` must speak (legacy input is refused by default — see
 * AGENTS.md's legacy-compat block), or `undefined` when the caller named
 * neither.
 */
export function flatRenameReplayedTask(args: Record<string, unknown>): Record<string, unknown> | undefined {
  const task: Record<string, unknown> = {
    ...(typeof args["task_handle"] === "string" ? { handle: args["task_handle"] } : {}),
    ...(typeof args["taskEpoch"] === "string" ? { epoch: args["taskEpoch"] } : {}),
  };
  return Object.keys(task).length > 0 ? task : undefined;
}

/**
 * One flat item -> its canonical `{path?, handle?, search, replace,
 * precondition}` twin, or `undefined` when the mapping is not mechanical and
 * unambiguous (which disqualifies the WHOLE batch — see the eligibility
 * predicate at the call site).
 *
 * Already-canonical items map through unchanged, so a batch mixing
 * `{path, old, new}` with `{path, search, replace}` still rewrites.
 */
export function flatRenameItemRewrite(rawEntry: unknown): Record<string, unknown> | undefined {
  if (rawEntry === null || typeof rawEntry !== "object" || Array.isArray(rawEntry)) return undefined;
  const entry = rawEntry as Record<string, unknown>;
  for (const key of Object.keys(entry)) {
    if (!FLAT_RENAME_ALIASES.has(key) && !FLAT_RENAME_CARRIED_ITEM_KEYS.includes(key)) return undefined;
  }
  const hasPath = typeof entry["path"] === "string" && entry["path"] !== "";
  const hasHandle = typeof entry["handle"] === "string" && entry["handle"] !== "";
  if (!hasPath && !hasHandle) return undefined;
  // Collapse each side's aliases to ONE value. `undefined` = the side was
  // never given (an alias with no counterpart), `null` = the caller gave two
  // spellings of the same side with different values, or a non-string — both
  // ambiguous, both disqualifying.
  const collapse = (aliases: readonly string[]): string | undefined | null => {
    let value: string | undefined;
    for (const alias of aliases) {
      const candidate = entry[alias];
      if (candidate === undefined) continue;
      if (typeof candidate !== "string") return null;
      if (value !== undefined && value !== candidate) return null;
      value = candidate;
    }
    return value;
  };
  const search = collapse(FLAT_RENAME_SEARCH_ALIASES);
  const replace = collapse(FLAT_RENAME_REPLACE_ALIASES);
  if (search === null || replace === null || search === undefined || replace === undefined) return undefined;
  return {
    ...(hasPath ? { path: entry["path"] } : {}),
    ...(hasHandle ? { handle: entry["handle"] } : {}),
    search,
    replace,
    // The caller's own guard wins; `unique-match` is only ADDED when they
    // named none, matching the advertised single-site edit shape.
    precondition: entry["precondition"] !== undefined ? entry["precondition"] : "unique-match",
    ...(entry["allowPathFallback"] !== undefined ? { allowPathFallback: entry["allowPathFallback"] } : {}),
    ...(entry["expectedSha"] !== undefined ? { expectedSha: entry["expectedSha"] } : {}),
    ...(entry["scopeHandle"] !== undefined ? { scopeHandle: entry["scopeHandle"] } : {}),
    ...(entry["review"] !== undefined ? { review: entry["review"] } : {}),
  };
}

/**
 * Whether one `edits[]` item must pass `enforcePreconditions` before the
 * batch is applied. `unique-match` alone is enforced by applyEditsMulti
 * against the in-memory file state; every other precondition — and, since
 * the 2026-10-10 review, any `expectedSha`/`scopeHandle` the item (or the
 * call) carries, whatever its precondition — is checked per item before any
 * write, keeping the batch all-or-nothing.
 */
export function batchItemNeedsPreconditionCheck(precondition: unknown, guardArgs: Record<string, unknown>): boolean {
  if (precondition !== undefined && precondition !== "unique-match") return true;
  return (typeof guardArgs["expectedSha"] === "string" && guardArgs["expectedSha"] !== "")
    || (typeof guardArgs["scopeHandle"] === "string" && guardArgs["scopeHandle"] !== "");
}

/**
 * The arguments one `edits[]` item's guards are checked against: the call's
 * arguments overlaid by the item's own, with the item's EFFECTIVE
 * precondition. A call-level `expectedSha`/`scopeHandle` belongs to the
 * call-level precondition, so an item that names a different precondition of
 * its own does not inherit it (argMatrix.spec.ts "per-item unique-match
 * overrides a failing call-level expected-hash"); the item's OWN guard fields
 * always apply.
 */
export function batchItemGuardArgs(
  args: Record<string, unknown>,
  entry: Record<string, unknown>,
  precondition: unknown,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...args, ...entry, precondition };
  if (entry["expectedSha"] === undefined && precondition !== "expected-hash") delete merged["expectedSha"];
  if (entry["scopeHandle"] === undefined && precondition !== "scope-handle") delete merged["scopeHandle"];
  return merged;
}

/**
 * P1 (2026-10-10 review), dispatch backstop: the VALUES of the post-projection
 * tl_edit_file arguments. Canonical requests were already value-checked
 * against the advertised schema in `callToolOnce` (`canonicalRequestRefusal`,
 * with `edits[N].…` paths); this covers the flat shapes that never pass
 * through a canonical carrier — a top-level `{path, search, replace,
 * precondition}` call, or a legacy-dialect caller under
 * `TL_LEGACY_INPUT=accept` — so no shape runs an edit with an out-of-enum
 * guard, a non-string replacement, or a string `"true"` where a boolean
 * decides what is written. A flat `intent` kind is left to dispatch, which
 * already refuses an unknown one (`intent-unknown`) or one combined with
 * `edits[]` (`intent-incompatible-with-batch`).
 */
export const EDIT_FILE_STRING_ARGS: readonly string[] = [
  "path", "handle", "search", "replace", "content", "from", "symbol", "lang", "to", "operation_id",
  "expectedSha", "scopeHandle", "directoryHandle", "task_handle", "taskEpoch",
  "credentialRef", "outputCredentialRef",
];

export const EDIT_FILE_BOOLEAN_ARGS: readonly string[] = ["create", "review", "allowPathFallback", "includeComments", "force_serve"];

export const EDIT_FILE_PRECONDITIONS: readonly string[] = ["unique-match", "expected-hash", "scope-handle", "references-reviewed"];

export const EDIT_FILE_FLAT_VALUE_SCHEMA: Record<string, SchemaNode> = {
  ...Object.fromEntries(EDIT_FILE_STRING_ARGS.map((name) => [name, { type: "string" }])),
  ...Object.fromEntries(EDIT_FILE_BOOLEAN_ARGS.map((name) => [name, { type: "boolean" }])),
  precondition: { type: "string", enum: EDIT_FILE_PRECONDITIONS },
  target: { type: "string", enum: ["all"] },
  expected_state_version: { type: "number" },
};

/** The flat intent dialect's `target` is the intent's own text (the member to append), not the `"all"` flag. */
export const EDIT_FILE_FLAT_INTENT_VALUE_SCHEMA: Record<string, SchemaNode> = {
  ...EDIT_FILE_FLAT_VALUE_SCHEMA,
  target: { type: "string" },
};

/**
 * 2026-10-22 (codex-copilot-proxy cohort r16, T07 tl-0): an agent put the file
 * INSIDE `search` -- `edits:[{search:{path, search}, replace}]` -- and was told
 * only that `edits[0].search must be a string`, which does not say where the
 * path it had just written belongs. When an offending `search` really is an
 * object, the refusal says so in one line. `code`, `field`, `fields` and
 * `retry` are untouched; nothing is repaired or guessed.
 */
export const SEARCH_OBJECT_HINT = "path goes beside search as its own field: edits:[{path, search, replace}]";

export function withSearchObjectHint(
  refusal: Record<string, unknown>,
  violations: readonly InvalidValueViolation[],
  input: Record<string, unknown>,
): Record<string, unknown> {
  const edits = Array.isArray(input["edits"]) ? input["edits"] as unknown[] : [];
  const searchIsObject = violations.some((violation) => {
    const itemMatch = /^edits\[(\d+)\]\.search$/u.exec(violation.field);
    const holder = itemMatch !== null
      ? asCanonicalObject(edits[Number(itemMatch[1])])
      : violation.field === "search" ? input : undefined;
    return asCanonicalObject(holder?.["search"]) !== undefined;
  });
  return searchIsObject && typeof refusal["error"] === "string"
    ? { ...refusal, error: `${refusal["error"]}; ${SEARCH_OBJECT_HINT}` }
    : refusal;
}

export function editFileValueRefusal(args: Record<string, unknown>): Record<string, unknown> | null {
  const flatSchema = args["intent"] !== undefined || args["mode"] !== undefined
    ? EDIT_FILE_FLAT_INTENT_VALUE_SCHEMA
    : EDIT_FILE_FLAT_VALUE_SCHEMA;
  const violations: InvalidValueViolation[] = findInvalidValues("tl_edit_file", flatSchema, args);
  const edits = args["edits"];
  if (Array.isArray(edits)) {
    edits.forEach((raw, index) => {
      const item = asCanonicalObject(raw);
      if (item === undefined) {
        violations.push({ field: `edits[${index}]`, structPath: "tl_edit_file.edits[]", expected: "an object" });
        return;
      }
      const itemSchema = item["intent"] !== undefined || item["mode"] !== undefined
        ? EDIT_FILE_FLAT_INTENT_VALUE_SCHEMA
        : EDIT_FILE_FLAT_VALUE_SCHEMA;
      for (const violation of findInvalidValues("tl_edit_file", itemSchema, item)) {
        violations.push({ ...violation, field: `edits[${index}].${violation.field}` });
      }
    });
  }
  const refusal = invalidValueRefusal("tl_edit_file", violations);
  if (refusal !== null) return withSearchObjectHint(refusal, violations, args);
  if (args["create"] === true && args["expectedSha"] !== undefined && args["expectedSha"] !== null) {
    return {
      ok: false,
      code: "invalid-input",
      field: "expectedSha",
      retry: "call",
      error: "expectedSha guards an existing file's current content, and create:true names a new file — drop expectedSha, or drop create to edit the existing file under that guard",
    };
  }
  const scopeHandle = args["scopeHandle"];
  if (args["precondition"] === "scope-handle" && (typeof scopeHandle !== "string" || scopeHandle === "")) {
    return {
      ok: false,
      code: "invalid-input",
      field: "scopeHandle",
      retry: "call",
      error: "precondition:\"scope-handle\" needs scopeHandle=<a handle id this session already holds> naming the scope the edit must stay inside",
    };
  }
  return null;
}

export function editFileUnknownArgumentRefusal(args: Record<string, unknown>): Record<string, unknown> | null {
  // §1.3.1(1) wants ONE recursive engine, so the detection lives in
  // validation/requestShape.ts and this function keeps only the RENDERING.
  // The fields the 2026-08-01 incident specs pin (`unknown_arguments`,
  // `unknown_edits_item_arguments`, the corrective `next_call`) are unchanged
  // and in the same places; §1.3.1's `field` / `did_you_mean` / `keys` /
  // `retry` ride alongside them. Over tl_edit_file's schema the shared walk
  // produces MORE than the two groups the old hand-rolled filter handled:
  // top-level keys, keys inside `edits[]` items — AND, since C-6 gave
  // `artifact`/`challenge` their own declared keys, keys nested inside
  // THOSE two as well (`edits.items` is no longer the only declared nested
  // shape). Row 18 (C2-6): a violation whose `parentPath` is neither
  // exactly "tl_edit_file" nor an `edits[N]` match — e.g. `artifact.bogus_key`
  // — used to fail BOTH grouping branches below and vanish from every named
  // field list; `fields` (below) now names every violation unconditionally,
  // regardless of which bucket (or no bucket) it also sorts into.
  const violations = findUnknownProperties("tl_edit_file", dispatchPropertiesFor("tl_edit_file"), args);
  if (violations.length === 0) return null;
  const unknownTop: string[] = [];
  const unknownItems: Array<{ index: number; arguments: string[] }> = [];
  for (const violation of violations) {
    if (violation.parentPath === "tl_edit_file") {
      unknownTop.push(violation.field);
      continue;
    }
    const nested = /^edits\[(\d+)\]\.([\s\S]+)$/.exec(violation.field);
    if (nested === null) continue;
    const index = Number(nested[1]);
    const existing = unknownItems.find((entry) => entry.index === index);
    if (existing !== undefined) existing.arguments.push(nested[2]!);
    else unknownItems.push({ index, arguments: [nested[2]!] });
  }
  // F-R8: a per-item key that is really one of tl_edit_file's TOP-LEVEL
  // arguments is a real capability one nesting level too deep, not noise —
  // say so, and surface it via the existing `did_you_mean` near-miss slot
  // even though it is a nesting error rather than a spelling one. Keyed off
  // `violations[0]` because that is the one violation `did_you_mean` (below)
  // already speaks for.
  const first = violations[0]!;
  const firstNested = /^edits\[(\d+)\]\.([\s\S]+)$/.exec(first.field);
  const firstBareKey = firstNested !== null ? firstNested[2] : first.field;
  const misnestedDidYouMean =
    firstBareKey !== undefined && EDIT_FILE_TOP_LEVEL_ONLY_ARGS.has(firstBareKey) ? firstBareKey : undefined;
  const misnestedHints: string[] = [];
  for (const key of [...unknownTop, ...unknownItems.flatMap((item) => item.arguments)]) {
    const hint = editFileMisnestedArgHint(key);
    if (hint !== undefined && !misnestedHints.includes(hint)) misnestedHints.push(hint);
  }
  // §1.3.1(4)(5) + CONDITION ②. `keys` is weighed against the bytes THIS
  // payload actually emits, not the shared renderer's shorter body.
  const shape = unknownPropertyRefusal("tl_edit_file", violations)!;
  // P3 (2026-10-10 review): a TOP-LEVEL offender is named against the
  // advertised top-level keys, not the flattened legacy dispatch set this
  // walk ran on (which listed `includeComments`/`symbol`/`to` — `edits[]`
  // item and intent fields — as if they were top-level arguments).
  const topLevelHint = first.parentPath === "tl_edit_file"
    ? publicTopLevelKeyHint("tl_edit_file", first.field)
    : undefined;
  const firstDidYouMean = topLevelHint !== undefined
    ? topLevelHint.didYouMean ?? misnestedDidYouMean
    : shape.did_you_mean ?? misnestedDidYouMean;
  const pathQualified = {
    field: shape.field,
    ...(firstDidYouMean !== undefined ? { did_you_mean: firstDidYouMean } : {}),
    retry: shape.retry,
  };

  // R29-FIX (2026-09-05, D3): a caller-native "hunk list" shape --
  // edits[i].operations: [{op:"replace"|"update", old|search|from, new|replace|to}]
  // -- resembles a native patch-tool operation list closely enough that it
  // showed up independently in two treatment cells' FIRST tl_edit_file attempt
  // (measured, r9 paid smoke: SF05-a and SF13-a) against every file in a
  // multi-file batch at once. Unlike the `range` incident below, there is no
  // safe single-item rewrite -- the WHOLE batch was built this way -- so this
  // mechanically rewrites every operation into a canonical {path|handle,
  // search, replace, precondition:"unique-match"} item using the CALLER'S OWN
  // old/new text (never a placeholder), bounded to the same 32 KiB payload
  // cap a caller's own batch call would be refused against; a batch that
  // does not fit names the honest remainder via `remaining` rather than
  // silently dropping files. Strict: only fires when EVERY edits[] item was
  // flagged for exactly this one violation and EVERY one of its operations
  // matches the shape -- a mixed or partially-malformed batch falls through
  // to the prose branch below unchanged.
  const rawEditsForOperationsIncident = Array.isArray(args["edits"]) ? (args["edits"] as unknown[]) : undefined;
  const operationsIncidentEligible =
    unknownTop.length === 0
    && rawEditsForOperationsIncident !== undefined
    && unknownItems.length === rawEditsForOperationsIncident.length
    && unknownItems.every((item) => item.arguments.length === 1 && item.arguments[0] === "operations")
    && rawEditsForOperationsIncident.every((rawEntry) => {
        if (rawEntry === null || typeof rawEntry !== "object" || Array.isArray(rawEntry)) return false;
        const entry = rawEntry as Record<string, unknown>;
        if (typeof entry["path"] !== "string" && typeof entry["handle"] !== "string") return false;
        const ops = entry["operations"];
        if (!Array.isArray(ops) || ops.length === 0) return false;
        return ops.every((rawOp) => {
          if (rawOp === null || typeof rawOp !== "object" || Array.isArray(rawOp)) return false;
          const op = rawOp as Record<string, unknown>;
          if (op["op"] !== "replace" && op["op"] !== "update") return false;
          const oldVal = op["old"] ?? op["search"] ?? op["from"];
          const newVal = op["new"] ?? op["replace"] ?? op["to"];
          return typeof oldVal === "string" && typeof newVal === "string";
        });
      });
  interface CorrectedOperationsItem {
    path?: string;
    handle?: string;
    search: string;
    replace: string;
    precondition: "unique-match";
  }
  let operationsIncidentNextCall: { tool: "tl_edit_file"; arguments: Record<string, unknown> } | undefined;
  let operationsIncidentRemaining: string | undefined;
  if (operationsIncidentEligible && rawEditsForOperationsIncident !== undefined) {
    const correctedByFile: Array<{ fileLabel: string; items: CorrectedOperationsItem[] }> =
      rawEditsForOperationsIncident.map((rawEntry) => {
        const entry = rawEntry as Record<string, unknown>;
        const target = typeof entry["path"] === "string"
          ? { path: entry["path"] as string }
          : { handle: entry["handle"] as string };
        const fileLabel = typeof entry["path"] === "string"
          ? (entry["path"] as string)
          : (entry["handle"] as string);
        const ops = entry["operations"] as unknown[];
        const items: CorrectedOperationsItem[] = ops.map((rawOp) => {
          const op = rawOp as Record<string, unknown>;
          const oldVal = (op["old"] ?? op["search"] ?? op["from"]) as string;
          const newVal = (op["new"] ?? op["replace"] ?? op["to"]) as string;
          return { ...target, search: oldVal, replace: newVal, precondition: "unique-match" as const };
        });
        return { fileLabel, items };
      });
    // Same bounding, same disclosure vocabulary as the D4 flat branch below
    // (`boundedCorrectedEditsCall`); the emitted bytes are unchanged by that
    // extraction — this branch's `remainingTail` is verbatim what it used to
    // append inline.
    const bounded = boundedCorrectedEditsCall(
      correctedByFile,
      editFileIncidentBaseArguments(args),
      "issue the same edits[].operations shape for these in a follow-up call",
    );
    operationsIncidentNextCall = bounded.next;
    operationsIncidentRemaining = bounded.remaining;
  }

  // D4 (2026-09-05): the FLAT sibling of the branch above — edits[] items
  // that spell the advertised {search, replace} pair as {old, new} (or
  // {from, to}). Strict in the same way: EVERY flagged field must be one of
  // those aliases (nothing else, at any depth), EVERY item must map
  // mechanically and unambiguously, and no top-level or per-item argument
  // may be dropped by the rewrite. Anything else falls through to the
  // unchanged prose refusal below, byte for byte.
  const rawEditsForFlatIncident = Array.isArray(args["edits"]) ? (args["edits"] as unknown[]) : undefined;
  const flatRenameItems: Array<Record<string, unknown>> = [];
  const flatIncidentEligible =
    !operationsIncidentEligible
    && unknownTop.length === 0
    && rawEditsForFlatIncident !== undefined
    && rawEditsForFlatIncident.length > 0
    && unknownItems.length > 0
    // Every violation is inside an edits[] item (not `artifact.*`/`task.*`/…),
    // and every one of them is a rename alias.
    && violations.every((violation) => {
        const nested = /^edits\[(\d+)\]\.([\s\S]+)$/.exec(violation.field);
        return nested !== null && FLAT_RENAME_ALIASES.has(nested[2]!);
      })
    && Object.keys(args).every((key) => FLAT_RENAME_CARRIED_TOP_LEVEL_KEYS.has(key))
    && rawEditsForFlatIncident.every((rawEntry) => {
        const rewritten = flatRenameItemRewrite(rawEntry);
        if (rewritten === undefined) return false;
        flatRenameItems.push(rewritten);
        return true;
      });
  let flatIncidentNextCall: { tool: "tl_edit_file"; arguments: Record<string, unknown> } | undefined;
  let flatIncidentRemaining: string | undefined;
  if (flatIncidentEligible) {
    const bounded = boundedCorrectedEditsCall(
      flatRenameItems.map((item) => ({
        fileLabel: String(item["path"] ?? item["handle"]),
        items: [item],
      })),
      {
        ...editFileIncidentBaseArguments(args),
        // The measured wire carried `task:{handle}` on the refused call;
        // replaying it keeps the corrected call inside the caller's own task
        // rather than silently opening a new one.
        ...(flatRenameReplayedTask(args) !== undefined ? { task: flatRenameReplayedTask(args) } : {}),
      },
      "issue the same flat rename shape for these in a follow-up call",
    );
    flatIncidentNextCall = bounded.next;
    flatIncidentRemaining = bounded.remaining;
  }

  // The measured incident shape maps 1:1 onto an edits[] anchor item — hand
  // back the runnable corrected call. `content` stays a placeholder: the
  // caller already holds their own bytes, echoing them back is pure cost.
  const incidentShape =
    unknownItems.length === 0
    && unknownTop.length === 1
    && unknownTop[0] === "range"
    && typeof args["range"] === "string"
    && args["content"] !== undefined
    && (typeof args["handle"] === "string" || typeof args["path"] === "string");
  const refusal = {
    ok: false,
    reason: "unknown-arguments",
    code: "unknown-arguments",
    ...pathQualified,
    // Row 18 (C2-6): the COMPLETE path-qualified violation set, unconditionally
    // — not just whichever of unknownTop/unknownItems a violation sorted into.
    fields: violations.map((v) => v.field),
    ...(unknownTop.length > 0 ? { unknown_arguments: unknownTop } : {}),
    ...(unknownItems.length > 0 ? { unknown_edits_item_arguments: unknownItems } : {}),
    error:
      "tl_edit_file refuses arguments outside its advertised schema instead of dropping them — on a write tool a dropped argument can silently change which span is overwritten (a dropped top-level `range` once turned a 113-line replacement into a whole-file overwrite)",
    ...(incidentShape
      ? {
          note: "top-level {handle, content} always replaces the handle's ENTIRE range; a line-range replacement is an edits[] item: edits:[{handle, range, content}]",
          next_call: {
            tool: "tl_edit_file",
            arguments: {
              edits: [
                {
                  ...(typeof args["handle"] === "string"
                    ? { handle: args["handle"] }
                    : { path: String(args["path"]) }),
                  range: String(args["range"]),
                  content: "<replacement text for exactly those lines>",
                },
              ],
            },
          },
        }
      : operationsIncidentNextCall !== undefined
        ? {
            note: "a caller-native {op,old,new} hunk list is not tl_edit_file's advertised schema; rewritten mechanically into canonical edits[] items using your own search/replace text",
            next_call: operationsIncidentNextCall,
            ...(operationsIncidentRemaining !== undefined ? { remaining: operationsIncidentRemaining } : {}),
          }
      : flatIncidentNextCall !== undefined
        ? {
            note: "a caller-native flat {old,new} (or {from,to}) rename item is not tl_edit_file's advertised schema; rewritten mechanically into canonical edits[] items using your own search/replace text",
            next_call: flatIncidentNextCall,
            ...(flatIncidentRemaining !== undefined ? { remaining: flatIncidentRemaining } : {}),
          }
        : {
            detail: [
              ...misnestedHints,
              "re-issue with only advertised tl_edit_file arguments; a line-range replacement is edits:[{handle, range, content}]",
            ].join(" — "),
          }),
  };
  // FX-R3: `keys` is the caller-facing recovery list — filter out any field
  // `TL_LEGACY_INPUT=refuse` would itself refuse `legacy-input` (see
  // `advertisedKeysForRefusal`'s doc comment). `shape.keys` (unfiltered) still
  // gates whether a key list exists at all / fit the refusal's own budget.
  const withKeys = {
    ...refusal,
    keys: topLevelHint !== undefined ? topLevelHint.keys : advertisedKeysForRefusal(shape.keys ?? []),
  };
  return shape.keys !== undefined && withinRefusalBudget(withKeys) ? withKeys : refusal;
}

/**
 * P3 (2026-10-10 review): the recovery key list and suggestion for an unknown
 * TOP-LEVEL argument. The strict walks run on the post-projection legacy
 * dialect (`dispatchPropertiesFor`), whose top level flattens every carrier
 * (`maxRows`, `as`, `path`, …), so the refusal used to hand back internal
 * names that are not in `tools/list` and no `did_you_mean` for a misspelled
 * carrier (`budjet` is far from every legacy key and one edit from the
 * advertised `budget`). The list is the advertised top-level names; under
 * `TL_LEGACY_INPUT=accept` the legacy spellings that mode accepts ride too.
 */
export function publicTopLevelKeyHint(tool: string, key: string): { keys: string[]; didYouMean?: string } {
  const advertised = Object.keys(advertisedPropertiesFor(tool)).sort();
  const legacyAccepted = process.env["TL_LEGACY_INPUT"] === "accept"
    ? Object.keys(dispatchPropertiesFor(tool)).filter((name) => !advertised.includes(name)).sort()
    : [];
  const didYouMean = nearestAdvertisedKey(key, advertised) ?? nearestAdvertisedKey(key, legacyAccepted);
  return { keys: [...advertised, ...legacyAccepted], ...(didYouMean !== undefined ? { didYouMean } : {}) };
}

/**
 * The recovery `keys`/`did_you_mean` of a dispatch-level unknown-argument
 * refusal: the public top-level names for a top-level offender
 * (`publicTopLevelKeyHint`), the legacy-filtered nested list otherwise
 * (FX-R3, `advertisedKeysForRefusal`).
 */
export function withPublicRecoveryKeys<T extends { field: string; keys?: string[]; did_you_mean?: string }>(tool: string, refusal: T): T {
  if (/[.[]/.test(refusal.field)) {
    return refusal.keys !== undefined ? { ...refusal, keys: advertisedKeysForRefusal(refusal.keys) } : refusal;
  }
  const hint = publicTopLevelKeyHint(tool, refusal.field);
  const didYouMean = hint.didYouMean ?? refusal.did_you_mean;
  return {
    ...refusal,
    ...(didYouMean !== undefined ? { did_you_mean: didYouMean } : {}),
    ...(refusal.keys !== undefined ? { keys: hint.keys } : {}),
  };
}

/**
 * `clientId` defaults to `resolvedClientId()` (the id captured by this same
 * process's `handleRequest` "initialize" case, or the TOKENLIGHTEN_CLIENT_ID
 * override — see resolvedClientId's doc comment) so every EXISTING bare
 * `advertisedTools()` call site (both transport legs, every test in
 * this package) keeps its exact prior behavior with no change at the call
 * site: `resolvedClientId()` is `undefined` unless something upstream of
 * this call already captured a real client, which resolves to the
 * "unknown" profile and therefore the pre-existing default descriptions
 * (see clientAdvertisement.ts's "DEFAULT BEHAVIOR IS BYTE-IDENTICAL" note).
 * Callers that already know which client they are advertising to (tests;
 * a future transport leg) may pass it explicitly instead.
 */
/**
 * 2026-10-17 simple paired bench (DESIGN-v0.14-plan §20.8): the portable
 * advertisement (4.1 KB against 12.4 KB for Claude Code and Codex CLI and
 * 7.7 KB for Copilot CLI) is the default for `isCliCodingHost` clients, whose every request pays
 * for the schema bytes. An explicit TL_PORTABLE_TOOLS decides for every
 * client: `1` portable everywhere, `0` the client-specific advertisements
 * everywhere.
 */
export function portableAdvertisementForClient(clientId: string | undefined): boolean {
  return portableToolsEnabled(isCliCodingHost(clientId));
}

/**
 * TL_EFF_EDIT_DIET (2026-10-19, v016 decision 6t-3): the `edit.applied` reply
 * diet (util/flags.ts `effEditDietEnabled`), ON by default for the
 * `isCliCodingHost` clients — the same host classification and the same
 * explicit-value-decides-for-every-client rule as the portable advertisement
 * above (DESIGN-v0.14-plan §20.8). Every other client keeps today's reply.
 */
export function editDietEnabled(): boolean {
  return effEditDietEnabled(isCliCodingHost(resolvedClientId()));
}

export function advertisedTools(clientId: string | undefined = resolvedClientId(), hintRoot: string = activeRoot) {
  // SECURITY (TL-SECURITY-REVIEW-2026-08-15 finding 8, CWE-693): KILL_SWITCH
  // is the single truth source both ALL_TOOLS' `enabled: !KILL_SWITCH` below
  // and the tools/call dispatch gate already key off — advertise nothing at
  // all when it is set, REGARDLESS of protocol mode, matching this file's
  // own "kill-switch: TL_KILL_SWITCH=1 causes tools/list to return empty"
  // contract.
  if (KILL_SWITCH) return [];
  // Deep-copy each definition. ALL_TOOLS holds the single source-of-truth
  // schema objects; handing out the live references let any caller (a test
  // that inspects+mutates the schema, or a future in-process consumer) mutate
  // them in place, and that mutation would leak into every later
  // advertisedTools() call in the same process — corrupting an unrelated
  // caller's tools/list AND cross-contaminating tests that assert on the
  // schema (e.g. a nested `description` length). structuredClone severs that
  // sharing so each caller gets an independent tree.
  // D11: no `deprecated` filter — ALL_TOOLS holds only advertised tools now,
  // so advertised == accepted by construction rather than by agreement.
  // DESIGN-v0.15 §8.2 (R7 Part B): `full` (the default) returns the exact
  // prior byte-for-byte definitions — `filterToolDefinitionForSurface` is a
  // no-op passthrough for that surface, so this line's behavior for existing
  // users is unchanged.
  return ALL_TOOLS.filter((t) => t.enabled).map((t) => {
    const cloned = structuredClone(t.definition) as {
      name: string;
      description: string;
      inputSchema: { properties: Record<string, SchemaNode>; anyOf?: unknown[]; required?: string[] };
    };
    // Portable mode uses the same canonical projection for every client and model.
    if (portableAdvertisementForClient(clientId)) return portableToolDefinition(filterToolDefinitionForSurface(cloned, ACTIVE_TOOL_SURFACE, FULL_ONLY_PROPERTY_PATHS[t.name] ?? []), hintRoot) as unknown as Record<string, unknown>;
    // VS Code / GitHub Copilot Chat only (see clientAdvertisement.ts):
    // swap in the richer description for this tool. Every other/unknown
    // client gets `undefined` here, so `cloned.description` is left exactly
    // as ALL_TOOLS defined it — the input SCHEMA (inputSchema below) is
    // never touched by this override, on any client.
    // Copilot retest r5: under TL_MINIMAL_TOOLS the shorter VS Code
    // descriptions ride with the minimal advertisement, so they share its
    // gate (`leanToolDefinitionForClient` applies the schema half).
    // Copilot retest r6: the minimal search description promises whole small
    // files only while TL_FIND_SMALL_BODIES delivers them.
    const descriptionOverride = toolDescriptionForClient(clientId, t.name, leanCallsEnabled() && minimalToolsEnabled(), findSmallBodiesEnabled());
    if (descriptionOverride !== undefined) cloned.description = descriptionOverride;
    const surfaced = filterToolDefinitionForSurface(
      cloned,
      ACTIVE_TOOL_SURFACE,
      FULL_ONLY_PROPERTY_PATHS[t.name] ?? [],
    );
    // V15-LTS (2026-09-29): the all-client schema diet — see
    // `leanSchemaForEveryClient`'s own doc comment. A no-op only while
    // `leanSchemaEnabled()` is off (explicit TL_LEAN_SCHEMA=0; ON is the
    // default since v0.15.0). Runs BEFORE the vscode-only
    // client diet below: its cuts are a strict subset of that one's, so the order
    // does not change the result, only which flag a given cut is attributed
    // to when both are on.
    const leaned = leanSchemaForEveryClient(surfaced);
    // The CLI eagerly transmits schemas. Drop only nested explanation text:
    // every property, enum, type and validation constraint stays identical.
    if (isCopilotCliClient(clientId)) stripNestedSchemaDescriptions(leaned.inputSchema.properties);
    // WP-V1 (2026-09-20): a second, independent diet — see
    // `leanToolDefinitionForClient`'s own doc comment. A no-op for every
    // unrelated client, or when the applicable lean/minimal gates are off.
    return leanToolDefinitionForClient(leaned, clientId) as unknown as Record<string, unknown>;
  });
}

/**
 * The tool surfaces the schema stamp fingerprints (util/schemaStamp.ts; the
 * TOKENLIGHTEN_SCHEMA_STAMP that `tl workspace setup` writes and the VS Code
 * extension bakes into its server definition's `version`): this process's
 * default advertisement, plus what a VS Code client receives under the VS
 * Code setup's own TL_TURN_ECONOMY=1. Copilot retest r5 (2026-10-03): the
 * minimal tier changed ONLY the second, so a stamp over the first alone stayed
 * byte-identical and VS Code could keep serving its cached r5 tool
 * definitions to the first round of a chat.
 */
export const STAMP_HINT_ROOT = "/workspace";

export function stampedToolSurfaces(): unknown[] {
  // The default advertisement, the CLI hosts' portable default (§20.8; Codex
  // CLI since §20.11), and VS Code under its setup's TL_TURN_ECONOMY=1.
  // The portable read cwd hint names this process's root, which is a
  // per-workspace value, not schema shape: stamp it as one fixed root so the
  // stamp is the same wherever it is computed (the VS Code build computes it
  // from its own package directory, CI checks it from the repository root).
  const root = STAMP_HINT_ROOT;
  const surfaces: unknown[] = [advertisedTools(resolvedClientId(), root), advertisedTools("claude-code", root),
    advertisedTools("copilot-cli", root), advertisedTools("codex-mcp-client", root)];
  const saved = process.env["TL_TURN_ECONOMY"];
  process.env["TL_TURN_ECONOMY"] = "1";
  try {
    surfaces.push(advertisedTools("vscode", root));
  } finally {
    if (saved === undefined) delete process.env["TL_TURN_ECONOMY"];
    else process.env["TL_TURN_ECONOMY"] = saved;
  }
  return surfaces;
}
