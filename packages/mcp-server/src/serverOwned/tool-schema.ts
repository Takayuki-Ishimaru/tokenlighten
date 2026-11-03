// tool-schema — extracted implementation; imports point to the owning modules.
import type { SchemaNode } from "../validation/requestShape.js";
import { ACTIVE_TOOL_SURFACE } from "../runtime/config.js";
import { ALL_TOOLS } from "./read-admission2.js";
import { FULL_ONLY_LEGACY_KEYS } from "../protocol/toolSchemas.js";
import { FULL_ONLY_PROPERTY_PATHS } from "../protocol/toolSchemas.js";
import { LEGACY_INPUT_FIELDS } from "./task-binding2.js";
import { PENDING_C6_ADJUDICATION } from "../validation/requestShape.js";
import { filterToolDefinitionForSurface } from "../protocol/toolSchemas.js";

export const EDIT_FILE_ADVISORY_ARGS: readonly string[] = PENDING_C6_ADJUDICATION["tl_edit_file"] ?? [];

export function legacyProperties(names: readonly string[]): Record<string, SchemaNode> {
  return Object.fromEntries(names.map((name) => [name, {}])) as Record<string, SchemaNode>;
}

export const LEGACY_CHALLENGE_SCHEMA: SchemaNode = {
  type: "object",
  properties: legacyProperties(["certificate_id", "obligation_id", "expected_action_change"]),
};

export const LEGACY_ARCHIVE_SCHEMA: SchemaNode = {
  type: "object",
  properties: legacyProperties(["path", "member", "prefix"]),
};

export const LEGACY_ARTIFACT_SCHEMA: SchemaNode = {
  type: "object",
  properties: {
    ...legacyProperties(["kind", "flatten"]),
    cells: {
      type: "array",
      items: { type: "object", properties: legacyProperties(["sheet", "cell", "value", "formula"]) },
    },
    replacements: {
      type: "array",
      items: { type: "object", properties: legacyProperties(["search", "replace", "all"]) },
    },
    form: { type: "object" },
    members: {
      type: "array",
      items: { type: "object", properties: legacyProperties(["action", "member", "content", "sourcePath"]) },
    },
  },
};

export const LEGACY_EDIT_ITEM_SCHEMA: SchemaNode = {
  type: "object",
  properties: {
    ...legacyProperties([
      "path", "handle", "range", "search", "replace", "content", "create", "from", "expectedSha", "precondition",
      "allowPathFallback", "target", "scopeHandle", "directoryHandle", "review",
    ]),
    intent: {
      type: "object",
      properties: legacyProperties(["kind", "from", "to", "symbol", "lang", "includeComments"]),
    },
  },
};

// FX-M8: this is the WIRE-FACING legacy `paths[]` item schema — the one
// `dispatchPropertiesFor`/`dispatchPropertiesForTest` return, and therefore
// the one a real legacy caller's `paths[]` entry (and requestShapeValidation.
// spec.ts's C-6 pin) is validated and its refusal `keys` derived against. It
// must NOT advertise `handle`: legacy `paths[]` is deprecated input
// (TL_LEGACY_INPUT=refuse in the RC) and a caller was never meant to be able
// to address a target by bare handle through it. See LEGACY_PATHS_SCHEMA_
// INTERNAL below for the separate, handle-inclusive schema FX-M1/E1 actually
// needs, and LEGACY_PATHS_INTERNAL_HANDLE_INPUT for how the two are told
// apart at validation time.
export const LEGACY_PATHS_SCHEMA: SchemaNode = {
  type: "array",
  items: {
    type: ["string", "object"],
    properties: {
      ...legacyProperties(["path", "purpose", "range", "symbol"]),
      ranges: { type: "array", items: { type: "string" } },
    },
  },
};

// FX-M8 (fixes the C-6 regression FX-M1 introduced): `handle` is an
// INTERNAL-ONLY item property, produced only by `legacyPathTarget`'s own
// projection of a canonical `targets:[{handle}, ...]` batch entry that had no
// `path` (FX-M1/E1) — never a field a caller sends directly through the
// wire-facing `paths[]` schema above. This is the schema `dispatchTool`
// substitutes in, for `paths` only, exactly when
// LEGACY_PATHS_INTERNAL_HANDLE_INPUT marks the call's `args.paths` as having
// come from that internal projection rather than from a caller's own legacy
// input — so the E1/F4 fix (carrying the handle through instead of collapsing
// it to `{}`) still clears the post-normalization gate without the internal
// carriage leaking into what the wire schema advertises.
export const LEGACY_PATHS_SCHEMA_INTERNAL: SchemaNode = {
  type: "array",
  items: {
    type: ["string", "object"],
    properties: {
      ...legacyProperties(["path", "purpose", "range", "symbol", "handle"]),
      ranges: { type: "array", items: { type: "string" } },
    },
  },
};

export const LEGACY_DISPATCH_PROPERTIES: Record<string, Record<string, SchemaNode>> = {
  tl_read_file: {
    ...legacyProperties([
    "path", "credentialRef", "mode", "symbol", "handle", "handles", "query", "qref", "cursor",
    "taskProfile", "lang", "maxTokens", "allowFull", "content", "comments", "includeClosure", "surfaceRoles",
    "sheet", "range", "ranges", "sections", "slides", "pages", "maxBytes", "limit", "profile", "kind", "as",
    "columns", "rows", "maxRows", "maxCells", "taskEpoch", "task_handle", "lane",
    "expected_state_version", "force_serve", "cwd",
    ]),
    archive: LEGACY_ARCHIVE_SCHEMA,
    challenge: LEGACY_CHALLENGE_SCHEMA,
    paths: LEGACY_PATHS_SCHEMA,
  },
  tl_edit_file: {
    ...legacyProperties([
      "path", "credentialRef", "outputCredentialRef", "handle", "search", "replace", "content",
      "create", "from", "intent", "symbol", "lang", "mode", "to", "review", "operation_id", "precondition",
      "allowPathFallback", "target", "expectedSha", "scopeHandle", "directoryHandle", "includeComments",
      "taskEpoch", "task_handle", "lane", "expected_state_version", "force_serve", "cwd",
    ]),
    artifact: LEGACY_ARTIFACT_SCHEMA,
    challenge: LEGACY_CHALLENGE_SCHEMA,
    edits: { type: "array", items: LEGACY_EDIT_ITEM_SCHEMA },
  },
  tl_search_files: {
    ...legacyProperties([
    "action", "query", "queries", "path", "credentialRef", "depth", "lang", "limit", "cursor",
    "includeClosure", "surfaceRoles", "regex", "symbol", "includeScores", "taskProfile", "maxTokens",
    "maxBytes", "taskEpoch", "task_handle", "lane", "expected_state_version", "force_serve", "cwd",
    ]),
    archive: LEGACY_ARCHIVE_SCHEMA,
    challenge: LEGACY_CHALLENGE_SCHEMA,
  },
};

export function advertisedPropertiesFor(tool: string): Record<string, SchemaNode> {
  const definition = ALL_TOOLS.find((entry) => entry.name === tool)!.definition;
  const inputSchema = definition["inputSchema"] as { properties: Record<string, SchemaNode> };
  if (ACTIVE_TOOL_SURFACE === "full") return inputSchema.properties;
  // DESIGN-v0.15 §8.2 (R7 Part B): the SAME filter `advertisedTools()` applies
  // to the wire schema, applied here to the closed-schema validator's own
  // property tree — a code-mode caller sending e.g. `select:{sheet:...}` is
  // refused `unknown-arguments` the same way any other unadvertised key is,
  // never a second, hand-written gate.
  return filterToolDefinitionForSurface(
    { name: tool, inputSchema: { properties: structuredClone(inputSchema.properties) } },
    ACTIVE_TOOL_SURFACE,
    FULL_ONLY_PROPERTY_PATHS[tool] ?? [],
  ).inputSchema.properties;
}

export function dispatchPropertiesFor(tool: string): Record<string, SchemaNode> {
  const legacy = LEGACY_DISPATCH_PROPERTIES[tool];
  if (legacy === undefined) return advertisedPropertiesFor(tool);
  if (ACTIVE_TOOL_SURFACE === "full") return legacy;
  // DESIGN-v0.15 §8.2 (R7 Part B) — the report's "concrete gap": left
  // unfiltered, a code-mode server run with `TL_LEGACY_INPUT=accept` would
  // silently reopen the exact Office/archive backdoor the surface exists to
  // close, since a legacy caller's field name never touches the advertised
  // (already-filtered) property tree above. `FULL_ONLY_LEGACY_KEYS` names
  // the same capabilities' flat legacy spellings.
  return filterToolDefinitionForSurface(
    { name: tool, inputSchema: { properties: structuredClone(legacy) } },
    ACTIVE_TOOL_SURFACE,
    FULL_ONLY_LEGACY_KEYS[tool] ?? [],
  ).inputSchema.properties;
}

/** Test-only readback of the post-normalizer validation surface. */
export function dispatchPropertiesForTest(tool: string): Record<string, SchemaNode> {
  return structuredClone(dispatchPropertiesFor(tool));
}

/**
 * FX-R3 (2026-09-03, round-18B finding 6): filter the caller-facing key LIST
 * an `unknown-arguments` refusal advertises, under `TL_LEGACY_INPUT=refuse`
 * (the RC setting).
 *
 * `dispatchPropertiesFor`'s returned schema must keep DECLARING every legacy
 * field (`maxBytes`, `paths`, `mode`, …) unconditionally — that schema is
 * also what `findUnknownProperties` validates the POST-canonical-mapping
 * `args` object against, and `normalizeCanonicalRequest` legitimately writes
 * those exact field names (`budget.bytes` -> `args.maxBytes`,
 * `task.handle` -> `args.task_handle`, …), so narrowing the schema itself
 * would make every canonical `budget`/`task`/`scope` call refuse
 * `unknown-arguments` on its own internally-mapped field.
 *
 * What SHOULD narrow under refuse mode is the advertised-key list a refusal
 * hands back as its recovery affordance: `legacyInputRefusal` (below) refuses
 * every one of `LEGACY_INPUT_FIELDS` as `legacy-input` before validation ever
 * runs, so naming them in `keys` walks the caller straight into a second,
 * different refusal for re-sending exactly what was just advertised. This
 * filters only that disclosure list; membership/validation is untouched.
 */
export function advertisedKeysForRefusal(keys: readonly string[]): string[] {
  if (process.env["TL_LEGACY_INPUT"] === "accept") return [...keys];
  return keys.filter((key) => !LEGACY_INPUT_FIELDS.has(key));
}

// ---------------------------------------------------------------------------
// TC-2 (A.9.4): every EMITTED `ToolCall` passes the server's own inbound
// request-shape validator. `ToolCall.arguments` is open at the TYPE level —
// A.9.4 says so, because the advertised schema is the authority and duplicating
// it into TypeScript would create a second one — and it is CLOSED at runtime by
// this registration plus the TC-2 spec. A call this server would refuse if the
// caller sent it is never a call this server tells the caller to send.
// ---------------------------------------------------------------------------
// Derive the runtime tool-name guard from the same declaration that powers
// `tools/list`; protocol helpers must not grow a second, drifting allowlist.
















export function editFileAdvertisedProperties(): Record<string, unknown> {
  return dispatchPropertiesFor("tl_edit_file") as Record<string, unknown>;
}

/**
 * Exported so refusal payloads can be checked against the very schema this
 * dispatch enforces: the server must never PRESCRIBE a call its own dispatch
 * refuses (2026-08-02 T05c rep0 idx 155→156 — the prescribed next_call was
 * rejected by the edits[] mapping loop and the cell abandoned TL on the next
 * turn). Pinned by executionTypestate.spec.ts R5.1/R5.3 and the rdl replay
 * group.
 */
export const EDIT_FILE_KNOWN_ARGS: ReadonlySet<string> = new Set([
  ...Object.keys(editFileAdvertisedProperties()),
  ...EDIT_FILE_ADVISORY_ARGS,
]);

export const EDIT_FILE_KNOWN_EDITS_ITEM_ARGS: ReadonlySet<string> = new Set(
  Object.keys(
    (editFileAdvertisedProperties()["edits"] as { items: { properties: Record<string, unknown> } }).items.properties,
  ),
);

// ---------------------------------------------------------------------------
// F-R8 (W8-C, 2026-08-22): measured in bench/workflows/runs/
// 2026-08-22-v011-decision-6t-1 (T05c rep0 arm A) — a solver placed `review`
// (then, on retry, `replace_all`) inside three `edits[]` items. Both are
// unknown-arguments refusals by construction (correct — a write tool must
// fail closed), but neither refusal told the caller anything about WHERE the
// key it used actually lives:
//
//  - `review`/`operation_id`/`cwd`/`lane`/… ARE real tl_edit_file arguments —
//    just top-level ones. `keys` on a per-item violation only ever lists the
//    PER-ITEM advertised set (content/expectedSha/handle/path/precondition/
//    range/replace/search), so a caller who typed a real name saw no
//    evidence it was real anywhere on the wire.
//  - `replace_all` is not advertised at EITHER nesting depth. It is the
//    native Edit tool's vocabulary; tl_edit_file's equivalent is
//    `precondition:"unique-match"` for a single site, or one `edits[]` item
//    per site.
//
// Both cost the caller a full round trip in the measured transcript. This
// section only ADDS explanatory text (`detail` and, for the top-level-arg
// case, `did_you_mean`) to an already-correct refusal — it never changes
// whether tl_edit_file refuses.
// ---------------------------------------------------------------------------
export const EDIT_FILE_TOP_LEVEL_ONLY_ARGS: ReadonlySet<string> = new Set(
  [...EDIT_FILE_KNOWN_ARGS].filter(
    (key) => key !== "edits" && !EDIT_FILE_KNOWN_EDITS_ITEM_ARGS.has(key),
  ),
);
