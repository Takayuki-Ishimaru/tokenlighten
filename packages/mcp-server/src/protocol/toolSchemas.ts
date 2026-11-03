// The advertised tool-schema building blocks (the canonical property trees
// that server.ts's ALL_TOOLS composes into the three tool definitions) and the
// per-surface and per-client schema diets `advertisedTools` applies to them.
// Moved out of server.ts unchanged on 2026-11-02 (v0.16.4 field evaluation:
// server.ts had grown past 29,000 lines); "this file" in the notes below means
// the schema source, which this module now is. The move is byte-neutral on the
// wire: the schema stamp (vscode-extension generate-schema-stamp) is identical.
import type { ToolSurface } from "@tokenlighten/types";

import { leanCallsEnabled, leanSchemaEnabled, minimalToolsEnabled } from "../util/flags.js";
import type { SchemaNode } from "../validation/requestShape.js";
import { isCopilotCliClient } from "./clientAdvertisement.js";
import { resolveClientProfile } from "./codec/clientProfile.js";

// v0.13 wave-3 (Track D, W3-1) restoration: wave-2's `propertyNames()`
// stripped every advertised property down to a bare `{}` — no `type`, no
// `description` — across all 151 property sites in this file, in exchange
// for a smaller minified byte count. That is the exact defect class
// `guideSchemaParity.spec.ts` and the 2026-08-01 guard-resurrection wave
// exist to catch on the OTHER axis (a capability the guide/server instructs
// but the schema hides): a schema-valid caller with no other source of
// truth (no guide loaded, a host that only reads `tools/list`) cannot tell
// what a bare `{}` property is FOR, what values it takes, or that it exists
// at all beyond its bare name. Every property below is restored with a
// short (<=120 char), imperative description; `propertyNames()` is deleted
// so a future edit cannot silently reintroduce the bare-`{}` shape by
// reaching for the old helper. See schemaSize.spec.ts's byte-budget test
// for the measured cost this restoration accepts (ledger comment there
// records the before/after).
export const closed = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  properties,
});

const CANONICAL_ARCHIVE = closed({
  path: { type: "string", description: "Archive path (.zip)." },
  member: { type: "string", description: "Member path in the archive." },
  prefix: { type: "string", description: "Members under this prefix." },
});
export const CANONICAL_TASK = {
  ...closed({
    handle: { type: "string", description: "Resumes a prior task_pack." },
    epoch: { type: "string", description: "\"new\": resets task-pack state." },
    profile: { type: "string", description: "answer=read-only, generic=change." },
    expected_state_version: { type: "number", description: "CAS guard vs stale state." },
    challenge: { type: "object", description: "Re-authorizes a decision." },
    force_serve: { type: "boolean", description: "Re-serves already-served bodies." },
    pull: { enum: ["closure"], description: "Returns the closure report." },
  }),
  dependentRequired: { expected_state_version: ["handle"] },
};
export const CANONICAL_SCOPE = {
  // W2-1(c): `mapCanonicalScope` (below) has always read `scope.symbol` and
  // copied it onto the legacy `symbol` dispatch argument — it was reachable
  // through dispatch but never advertised, so a caller composing
  // `tl_search_files` references/find against a specific symbol via the
  // canonical `scope` carrier got an unknown-arguments refusal for a field
  // the server already implements. This is the same class of defect the
  // guard-resurrection wave fixed for other hidden-capability cases: an
  // unadvertised accepted field is not a private implementation detail, it
  // is a capability the caller cannot reach without already knowing the
  // server's internals.
  ...closed({
    path: { type: "string", description: "Root path to search under." },
    credentialRef: { type: "string", description: "Credential ref; never raw." },
    lang: { type: "string", description: "Language hint." },
    regex: { type: "boolean", description: "Regex mode (find only)." },
    depth: { type: "number", description: "Max tree depth." },
    includeClosure: { type: "boolean", description: "Returns the task_pack closure." },
    surfaceRoles: { type: "array", items: { type: "string" }, description: "Surface roles for closure." },
    includeScores: { type: "boolean", description: "Match-confidence scores." },
    symbol: { type: "string", description: "Symbol to address/search." },
    archive: { ...CANONICAL_ARCHIVE, description: "path/member/prefix." },
    kind: { enum: ["text", "symbol"], description: "text or resolved symbol." },
  }),
};
// W3-4(b): tl_search_files delivers only the byte/token/item dimensions — it has
// no Office table concept (rows/cells) and no full-read escalation
// (allowFull) for a search RESULT the way a file read does. Before this
// split, CANONICAL_BUDGET was one object shared verbatim across tl_read_file
// and tl_search_files, so tl_search_files ADVERTISED all six budget members while
// `LEGACY_DISPATCH_PROPERTIES.tl_search_files` recognizes none of
// rows/cells/allowFull — a schema-valid `tl_search_files` call using any of the
// three was refused `unknown-arguments` by the very next gate
// (canonicalSurface.spec.ts's D-5 property test found and documented this
// live). Splitting the advertised shape per tool closes the gap by
// narrowing the AD, not by widening dispatch to accept table/full-read
// concepts a search result does not have.
const CANONICAL_BUDGET_DIMENSIONS = {
  bytes: { type: "number", description: "Byte cap." },
  tokens: { type: "number", description: "Token cap." },
  items: { type: "number", description: "Item cap." },
} as const;
export const CANONICAL_BUDGET = {
  ...closed({
    ...CANONICAL_BUDGET_DIMENSIONS,
    rows: { type: "number", description: "Row cap (Office)." },
    cells: { type: "number", description: "Cell cap (Office)." },
    allowFull: { type: "boolean", description: "Higher full-read cap." },
  }),
};
export const CANONICAL_SEARCH_BUDGET = {
  ...closed({ ...CANONICAL_BUDGET_DIMENSIONS }),
};
export const CANONICAL_TARGET = {
  ...closed({
    path: { type: "string", description: "File path to read." },
    handle: { type: "string", description: "Handle; resolves path/symbol/range." },
    credentialRef: { type: "string", description: "Credential ref; never raw." },
    range: { type: "string", description: "1-based N-M line window." },
    ranges: { type: "array", items: { type: "string" }, description: "Several N-M windows, one target." },
    symbol: { type: "string", description: "Symbol in this target." },
    purpose: { type: "string", description: "Why this target is needed." },
    profile: { type: "string", description: "Skeleton rendering profile." },
    lang: { type: "string", description: "Language hint." },
    archive: { ...CANONICAL_ARCHIVE, description: "path/member/prefix." },
  }),
  oneOf: [{ required: ["path"] }, { required: ["handle"] }],
};
export const CANONICAL_SELECT = {
  ...closed({
    kind: { type: "string", description: "xlsx/pptx/pdf/zip kind." },
    format: { type: "string", description: "Output format (text/json)." },
    comments: { enum: ["elide", "keep"], description: "elide (default) or keep." },
    sheet: { type: "string", description: "Worksheet name (xlsx)." },
    rows: { type: "array", items: { type: "number" }, description: "Row selector (xlsx)." },
    columns: { type: "array", items: { type: "string" }, description: "Column selector (xlsx)." },
    sections: { type: "array", items: { type: "string" }, description: "Headings to serve (max 8)." },
    slides: { type: "array", items: { type: "string" }, description: "Slide numbers (pptx)." },
    pages: { type: "array", items: { type: "string" }, description: "Page numbers/ranges (pdf)." },
  }),
};

// W2-2: the subset of `select`'s fields that address a specific ARTIFACT
// sub-resource (a workbook sheet/rows/columns, a slide, a page, an explicit
// `kind`/`format`) and therefore mean "serve this target through the
// artifact reader". `comments` and `sections` are also `select` fields but
// are NOT artifact addressing — `comments` rides the ordinary read path
// (the long-standing `comments:"keep"` argument) and `sections` has its own
// dedicated markdown-heading route (`args.sections`, server.ts's "Markdown
// section read" block) that runs independently of `mode`. Naming this list
// once, here, is what `mapCanonicalSelect` below tests against; it used to
// treat "any select field present" as "route to artifact", which sent a
// bare `select:{sections:[...]}` or `select:{comments:"keep"}` canonical
// call into artifact serving — a reader that cannot answer either request.
export const ARTIFACT_SELECT_KEYS: readonly string[] =
  ["kind", "format", "sheet", "rows", "columns", "slides", "pages"];
export const CANONICAL_EDIT_ITEM = {
  ...closed({
    path: { type: "string", description: "File path to edit." },
    from: { type: "string", description: "Path/handle for create-by-copy." },
    handle: { type: "string", description: "Handle; resolves path/symbol/range." },
    range: { type: "string", description: "1-based N-M range." },
    search: { type: "string", description: "Text to find (with replace)." },
    replace: { type: "string", description: "Text (pair with search)." },
    content: {
      type: "string",
      // IL-W5 (DESIGN-v0.15-sf-intent-layers.md §11.2(4)): match the
      // advertised shape to what dispatch actually does. A whole-file
      // replace on an EXISTING file needs `handle` — UNLESS this lane
      // already holds the file's full current body (a prior `create:true`
      // or a `content:"full"` serve), in which case `path` alone resolves
      // through the same write path and reports the resolved handle in
      // `applied[]`. `create:true` is for new files. Paired with `range`,
      // replaces just that range.
      description: "Existing file: handle, or path if lane holds the full body; range replaces only that range.",
    },
    create: { type: "boolean", description: "true: creates a new file." },
    expectedSha: { type: "string", description: "Content hash (expected-hash)." },
    // W3-1(b): the enum this property carries is not decoration — it is the
    // only advertised list of the four legal `precondition` values, and a
    // schema-diet pass that reduced this to a bare `{}` deleted that list
    // outright rather than merely omitting its description.
    precondition: {
      type: "string",
      enum: ["unique-match", "expected-hash", "scope-handle", "references-reviewed"],
      description: "Write guard for this edit; see enum.",
    },
    allowPathFallback: { type: "boolean", description: "Fallback to path if handle fails." },
    target: { type: "string", description: "\"all\": replace every match." },
    scopeHandle: { type: "string", description: "For precondition=scope-handle." },
    directoryHandle: { type: "string", description: "Create-into-directory address." },
    review: { type: "boolean", description: "Attach review metadata." },
    intent: {
      ...closed({
        from: { type: "string", description: "Rename source symbol name." },
        to: { type: "string", description: "Symbol name (rename/append-*)." },
        symbol: { type: "string", description: "Symbol for this intent." },
        lang: { type: "string", description: "Language hint." },
        includeComments: { type: "boolean", description: "Also update matching comments." },
        kind: {
          enum: ["rename", "remove-duplicate-branch", "append-union-member", "append-enum-member", "rename-symbol-references"],
          description: "Structural intent to run.",
        },
      }),
      description: "Rename/append/dedupe a member.",
    },
  }),
  // 2026-10-22 (codex-copilot-proxy cohort r16/r17, T07/T09): every edits[]
  // item names its own file (`path` or `handle`), or is an `intent` item.
  // Dispatch refuses an item with neither `path` nor `handle` (the batch
  // pre-pass `edits-item-missing-target`; the act.edit fence's address
  // correction), but the `oneOf` below reads as if `search`/`replace` alone
  // were a complete item: 4 of the 8 Codex edit trials sent exactly that and
  // paid 1-4 refusals each. This item-level `anyOf` says it once for every
  // item form. `intent` is its third alternative because a lone
  // `intent.kind:"rename"` item with no `path`/`handle` is a workspace-wide
  // rename that dispatch accepts (renameSymbol's `path` is optional; probed:
  // it applies). The other four intent kinds need a handle and are answered
  // `intent-requires-handle`; telling them from a rename would take a larger
  // branch that inspects `intent.kind`, so the keyword admits every intent item
  // and dispatch keeps that refusal.
  // It is `anyOf`, never `oneOf` (cf. CANONICAL_TARGET): `path` and `handle`
  // are legal together (`allowPathFallback`), and a strict validator counts a
  // `oneOf` double match as a failure. It is a sibling of `oneOf`, not nested
  // in a branch: a branch carrying its own `anyOf` would reach Codex as a
  // type-less composition node (its schema lowering leaves such a node
  // untyped) and would cover one item form instead of all of them.
  // ADVERTISEMENT ONLY: requestShape.ts never evaluates
  // `required`/`oneOf`/`anyOf`, so dispatch, its refusals and their
  // corrections are unchanged. LEAN_SCHEMA_PROPERTY_PATHS cuts this keyword for
  // VS Code and the Copilot CLI minimal tier, like `oneOf`.
  anyOf: [{ required: ["path"] }, { required: ["handle"] }, { required: ["intent"] }],
  // W2-1(b): the three original branches left two dispatch-accepted item
  // shapes schema-INVALID (protocol-v1-snapshot.json carries two frozen
  // emits of exactly this kind, self-rejected by their own advertised
  // schema before this fix): an INTENT edit (`{path|handle, intent:{...}}`,
  // no search/replace/range/content of its own — `normalizeCanonicalRequest`
  // has always unpacked `intent` into the legacy mode/from/to/symbol
  // dispatch shape) and a WHOLE-FILE REPLACE (`{handle|path, content}`, no
  // `range` — the top-level `{handle,content}` form documented in
  // AGENTS.md's edit protocol section). The whole-file-replace branch
  // excludes range/create/search so it cannot double-match branches 2/3, or
  // silently accept a truncated search+replace/range+content/create+content
  // shape that is missing its required partner field.
  oneOf: [
    { required: ["search", "replace"] },
    { required: ["range", "content"] },
    { required: ["create", "content"] },
    { required: ["create", "from"], not: { required: ["content"] } },
    { required: ["intent"] },
    {
      required: ["content"],
      not: { anyOf: [{ required: ["range"] }, { required: ["create"] }, { required: ["search"] }] },
    },
  ],
};

// ---------------------------------------------------------------------------
// DESIGN-v0.15 §8.2 (R7 Part B): the full-only classification — the SINGLE
// list naming which advertised/dispatch inputs are Office/archive-member/
// credential-only, kept next to `ALL_TOOLS` so it is visibly the one
// classification source (never a second hand-written schema per tool). Two
// per-tool tables are derived from it, not two independent classifications:
// `FULL_ONLY_PROPERTY_PATHS` names dotted paths into the ADVERTISED nested
// schema tree (e.g. "select.properties.sheet" deletes tl_read_file's advertised
// `select.sheet`); `FULL_ONLY_LEGACY_KEYS` names the SAME capabilities' flat
// top-level spellings in `LEGACY_DISPATCH_PROPERTIES` (the post-normalization
// dispatch view a v0.13.x legacy caller's field lands on, e.g. bare `sheet`
// or `archive`). `ARTIFACT_SELECT_KEYS` (defined above) is reused verbatim
// for tl_read_file.select's contribution — never re-listed by hand.
// ---------------------------------------------------------------------------
export const FULL_ONLY_PROPERTY_PATHS: Record<string, readonly string[]> = {
  tl_read_file: [
    "targets.items.properties.archive",
    "targets.items.properties.credentialRef",
    ...ARTIFACT_SELECT_KEYS.map((key) => `select.properties.${key}`),
    "budget.properties.rows",
    "budget.properties.cells",
    "scope.properties.archive",
    "scope.properties.credentialRef",
  ],
  tl_edit_file: ["artifact", "credentials"],
  tl_search_files: ["scope.properties.archive", "scope.properties.credentialRef"],
};

// FX-M8-style note: LEGACY_DISPATCH_PROPERTIES's flat keys are validated
// AFTER `normalizeCanonicalRequest` has already run, so this list must catch
// a legacy caller's OWN raw spelling of each full-only capability — not only
// the canonical field name — or `TL_LEGACY_INPUT=accept` would reopen
// exactly the Office/archive backdoor the surface exists to close (the
// report's own "concrete gap", not a hypothetical).
export const FULL_ONLY_LEGACY_KEYS: Record<string, readonly string[]> = {
  tl_read_file: ["archive", "credentialRef", "sheet", "rows", "columns", "slides", "pages", "as", "kind", "maxRows", "maxCells"],
  tl_edit_file: ["artifact", "credentialRef", "outputCredentialRef"],
  tl_search_files: ["archive", "credentialRef"],
};

/**
 * Deletes each of `dottedPaths` from a CLONE of `properties` and returns the
 * clone; `properties` itself is never mutated (every consumer below shares
 * the same ALL_TOOLS-derived objects across requests/processes). A dotted
 * path walks `properties`/`items` exactly the way the advertised JSON Schema
 * nests them — the final segment is the key actually deleted. A path whose
 * parent does not exist (e.g. a legacy-only path fed the advertised tree, or
 * vice versa) is a silent no-op: callers pass the matching table for the
 * tree they hold, so this only guards against the two tables drifting.
 */
function withoutSchemaPaths(
  properties: Record<string, SchemaNode>,
  dottedPaths: readonly string[],
): Record<string, SchemaNode> {
  const clone = structuredClone(properties) as Record<string, unknown>;
  for (const dotted of dottedPaths) {
    const segments = dotted.split(".");
    const last = segments.pop()!;
    let node: Record<string, unknown> | undefined = clone;
    for (const segment of segments) {
      if (node === undefined) break;
      node = node[segment] as Record<string, unknown> | undefined;
    }
    if (node !== undefined) delete node[last];
  }
  return clone as Record<string, SchemaNode>;
}

/**
 * DESIGN-v0.15 §8.2 (R7 Part B): the ONE pure function every surface-aware
 * consumer shares — `advertisedTools()` (the wire schema), the properties
 * views `advertisedPropertiesFor`/`dispatchPropertiesFor` hand to the
 * validator (via a minimal `{name, inputSchema:{properties}}` wrapper), and
 * `LEGACY_DISPATCH_PROPERTIES`'s own per-surface view (through
 * `dispatchPropertiesFor` again, with `FULL_ONLY_LEGACY_KEYS`). `full`
 * returns `definition` completely unchanged — no clone, no allocation —
 * so every existing full-surface caller keeps its exact prior identity and
 * behavior. `code` deletes every path in `pathsToRemove` from a clone of
 * `inputSchema.properties`, and — only when the definition still carries an
 * `anyOf` (tl_edit_file) and its `artifact` branch's requirement no longer
 * exists on the filtered properties — collapses the two-branch
 * `anyOf:[{required:["edits"]},{required:["artifact"]}]` down to plain
 * `required:["edits"]`, since `artifact` no longer exists to require.
 */
export function filterToolDefinitionForSurface<
  T extends { name: string; inputSchema: { properties: Record<string, SchemaNode>; anyOf?: unknown[]; required?: string[] } },
>(definition: T, surface: ToolSurface, pathsToRemove: readonly string[]): T {
  if (surface === "full") return definition;
  definition.inputSchema.properties = withoutSchemaPaths(definition.inputSchema.properties, pathsToRemove);
  if (
    definition.name === "tl_edit_file"
    && definition.inputSchema.anyOf !== undefined
    && definition.inputSchema.properties["artifact"] === undefined
  ) {
    delete definition.inputSchema.anyOf;
    definition.inputSchema.required = ["edits"];
  }
  return definition;
}

// WP-V1 (2026-09-20): the ADDITIONAL nested paths a "vscode" client's
// advertised schema sheds under `leanCallsEnabled()`, on top of whatever
// `FULL_ONLY_PROPERTY_PATHS` above already removed for the active tool
// surface. `targets[].purpose` STAYS advertised (orchestrator ruling,
// 2026-09-20, reversing this wave's first cut): it is the one argument that
// tells the server what a caller-named DIRECTORY is for, and the
// directory-confined clause recovery in `buildSeededTaskPack` locates with
// it first -- on the recorded GitHub Copilot sessions the purposes cost
// about 10 mAIU of output per call, while a first pack that misses the
// directory's concern costs two to four whole model requests. Its
// description is rewritten below to steer it onto directory targets, where
// it pays. `task.dependentRequired` is dropped on every tool because
// Copilot's own schema validator rejects the `dependentRequired` keyword
// outright (same reason the top-level `oneOf`/`anyOf` deletion below
// exists) — `dispatchTool` still enforces the expected_state_version-needs-
// handle rule regardless of what gets advertised. `budget.bytes`/
// `budget.tokens` are dropped from tl_read_file ONLY (replay forensics,
// 2026-09-20 P2 sessions): the model set `budget:{bytes:24000-42000}` on
// large batch reads, the server honoured it as a cap, and each capped batch
// then cost 2-3 follow-up reads — a whole model turn each. The Copilot
// notes already say "omit `budget` unless you want LESS than TL's
// default"; not advertising the byte/token knobs is the reliable way to
// get there. `budget.items` is left advertised on tl_search_files (its own,
// untouched `LEAN_SCHEMA_PROPERTY_PATHS` entry below) — `references`
// paging needs it, so it is NOT part of this tl_read_file-only cut.
// `dispatchTool` still accepts `budget.bytes`/`budget.tokens` exactly as
// today; see `leanSchemaBudgetBytesStillServed`-style coverage in
// leanVsCodeCalls.rc.spec.ts.
//
// Copilot retest r4 (2026-10-02): Copilot sends a model WITHOUT `tool_search`
// (MAI flash) every tool's full schema on every round, so these bytes are paid
// per round there, not once per load. The cut below adds the fields a Copilot
// model never authors itself — `lane` (one agent per chat; runSubagent waits
// for its child), `scope.includeScores` (diagnostics), `targets[].profile`
// (skeleton rendering), the per-item `oneOf` of `edits[]`/`targets[]`
// (dispatch enforces the same shapes and names the field it refuses) — and
// the fields only a server-issued call carries: `scope.surfaceRoles`,
// `scope.includeClosure`, `task.expected_state_version`, `task.pull`. A `next`
// or refusal that needs one of those still names it, and dispatch still
// accepts every one of them (inbound validation reads ALL_TOOLS, never this
// advertisement). No capability is hidden: artifact/select/archive/intent/
// credential fields stay advertised.
//
// 2026-10-22: `edits.items.anyOf` (every item names a `path` or a `handle`, or
// is an `intent` item; CANONICAL_EDIT_ITEM) is cut with `edits.items.oneOf`, for the same reason
// and so that these surfaces stay byte-identical: the VS Code descriptions
// already say "path or handle plus search/replace", and dispatch refuses an
// address-less item naming `edits[i].path` and the certificate's write
// targets (`candidates`), which a client-side Ajv error could not.
const LEAN_SCHEMA_PROPERTY_PATHS: Record<string, readonly string[]> = {
  tl_read_file: [
    "task.dependentRequired",
    "budget.properties.bytes",
    "budget.properties.tokens",
    "lane",
    "scope.properties.includeScores",
    "scope.properties.surfaceRoles",
    "scope.properties.includeClosure",
    "targets.items.properties.profile",
    "targets.items.oneOf",
    "task.properties.expected_state_version",
    "task.properties.pull",
  ],
  tl_edit_file: [
    "task.dependentRequired",
    "lane",
    "edits.items.oneOf",
    "edits.items.anyOf",
    "task.properties.expected_state_version",
    "task.properties.pull",
  ],
  tl_search_files: [
    "task.dependentRequired",
    "lane",
    "scope.properties.includeScores",
    "scope.properties.surfaceRoles",
    "scope.properties.includeClosure",
    "task.properties.expected_state_version",
    "task.properties.pull",
  ],
};

// Copilot retest r4 (2026-10-02): top-level properties whose one-line
// description only restates the property's name or enum ("Task/closure
// control.", "Read scope fields.", "auto/outline/full hint.") — dropped for a
// "vscode" client under `leanCallsEnabled()` for the same per-round reason as
// the paths above. The descriptions that carry a rule stay: `query`
// ("verbatim"), `qref`, `cursor`, `cwd`, `queries`, `artifact`.
const LEAN_SCHEMA_UNDESCRIBED: Record<string, readonly string[]> = {
  tl_read_file: ["targets", "content", "select", "budget", "task", "scope"],
  tl_edit_file: ["edits", "operation_id", "task", "credentials"],
  tl_search_files: ["action", "scope", "budget", "task"],
};

// WP-V1: top-level advertised properties that, once
// `LEAN_SCHEMA_PROPERTY_PATHS` has emptied out their OWN nested
// `properties`, must be dropped ENTIRELY rather than advertised as a bare,
// property-less `{additionalProperties:false, properties:{}}` shape — an
// empty container teaches a model nothing and is pure overhead. Not reached
// today (tl_read_file's `budget` above still keeps `items`/`rows`/`cells`/
// `allowFull` after losing `bytes`/`tokens`), but a later wave narrowing
// this same tool's budget further must not have to remember this rule.
const LEAN_SCHEMA_DROP_IF_EMPTY: Record<string, readonly string[]> = {
  tl_read_file: ["budget"],
};

// Copilot retest r5 (2026-10-03), TL_MINIMAL_TOOLS (util/flags.ts
// `minimalToolsEnabled`): applied on top of everything above, in the same
// vscode + `leanCallsEnabled()` case only. r5's request bodies put
// TokenLighten's share of a MAI flash first round at ~1,870 tokens (tool
// schemas ~2/3 of it), paid on every round and on every task, the ones that
// never call TokenLighten included. This tier keeps what a Copilot model
// authors in an ordinary task and stops advertising the rest: archive,
// credential, structural-intent, create-by-copy, review/scope/expected-sha,
// budget and idempotency arguments. Each is still accepted at dispatch
// (inbound validation reads ALL_TOOLS, never this advertisement), and Copilot
// lets it through too, because the vscode advertisement declares no
// `additionalProperties:false` (see `openSchemaObjects` below); a
// server-issued `next` or refusal still names whichever one it needs.
// `select`/`artifact` stay advertised as one-line opaque objects
// (MINIMAL_SCHEMA_COLLAPSED) so an Office/PDF/zip task can still find them.
//
// Copilot retest r6 (2026-10-03): the schemas were still ~900 tokens of the
// ~1,360 TokenLighten added to every MAI flash round (o200k count of the
// recorded request; guide ~630, agent entry ~55), and a GPT-6 Luna run paid
// them uncached twice after tool_search loaded them. The tier now lists what a
// model writes on its OWN: the query; known targets (path/handle/range/symbol,
// and `purpose`, which a directory target carries and the directory-confined
// recovery reads — see LEAN_SCHEMA_PROPERTY_PATHS); the task epoch, profile
// and `force_serve` (the guide's lost-context resend, which no reply names);
// search action, queries, scope.path and scope.regex; and the edit items plus
// cwd. What it stops listing is either written only after a server reply
// names it (`next` carries qref/cursor/budget/scope/cwd/task.handle verbatim,
// a refusal names its `field`), not needed here (`content`: targets already
// serve small files whole), or an option no recorded Copilot call wrote on
// its own (targets[].ranges, scope.kind/depth, task.challenge,
// edits[].allowPathFallback, the edit's task). A model can still send any of
// them: Copilot's check passes them (no `additionalProperties`, see
// `openSchemaObjects`) and dispatch reads ALL_TOOLS.
const MINIMAL_SCHEMA_PROPERTY_PATHS: Record<string, readonly string[]> = {
  tl_read_file: [
    "targets.items.properties.credentialRef",
    "targets.items.properties.lang",
    "targets.items.properties.archive",
    "targets.items.properties.ranges",
    "budget",
    "scope",
    "qref",
    "content",
    "cursor",
    "cwd",
    "task.properties.handle",
    "task.properties.challenge",
  ],
  tl_edit_file: [
    "edits.items.properties.from",
    "edits.items.properties.expectedSha",
    "edits.items.properties.scopeHandle",
    "edits.items.properties.directoryHandle",
    "edits.items.properties.review",
    "edits.items.properties.intent",
    "edits.items.properties.allowPathFallback",
    "operation_id",
    "credentials",
    "task",
  ],
  tl_search_files: [
    "scope.properties.credentialRef",
    "scope.properties.lang",
    "scope.properties.symbol",
    "scope.properties.archive",
    "scope.properties.depth",
    "scope.properties.kind",
    "budget",
    "cursor",
    "cwd",
    "task",
  ],
};

/** TL_MINIMAL_TOOLS: top-level properties advertised as a one-line opaque object instead of their nested schema. */
const MINIMAL_SCHEMA_COLLAPSED: Record<string, Readonly<Record<string, string>>> = {
  tl_read_file: {
    select: "Office/PDF part: {sheet, rows, columns}, {slides}, {pages} or {sections}.",
  },
  tl_edit_file: {
    artifact: "xlsx/docx/pptx/pdf/zip edit: {kind, cells:[{sheet, cell, value|formula}] | replacements:[{search, replace}] | form | members:[{action, member, content}]}.",
  },
};

/**
 * Copilot retest r5 review (2026-10-03): GitHub Copilot Chat VALIDATES every
 * tool call's input against the schema it was advertised before the call
 * reaches the server (Copilot extension 0.67, `validateToolInput`: Ajv with
 * `coerceTypes`; a schema Ajv cannot compile is skipped, which is why the
 * default schema's `dependentRequired` kept validation off until TL_LEAN_CALLS
 * removed it). An invalid input comes back to the model as "ERROR: Your input
 * to the tool was invalid" and costs a round. With `additionalProperties:false`
 * on every object, every argument the lean and minimal tiers stop advertising
 * — and that a server-issued `next` still carries (`task.pull`,
 * `scope.includeClosure`, `scope.surfaceRoles`, the guide's
 * `budget.bytes`, a model's own `scope.lang`) — was rejected there. So the
 * vscode advertisement declares no `additionalProperties` at all: the server's
 * own dispatch, which names the field and the nearest valid key, stays the
 * one gate for unknown arguments. Also ~290 B smaller.
 */
function openSchemaObjects(node: unknown): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) openSchemaObjects(child);
    return;
  }
  const record = node as Record<string, unknown>;
  delete record["additionalProperties"];
  const properties = record["properties"];
  if (properties !== null && typeof properties === "object" && !Array.isArray(properties)) {
    for (const child of Object.values(properties as Record<string, unknown>)) openSchemaObjects(child);
  }
  if (record["items"] !== undefined) openSchemaObjects(record["items"]);
}

/** TL_MINIMAL_TOOLS: the minimal tier of `leanToolDefinitionForClient` (see MINIMAL_SCHEMA_PROPERTY_PATHS). Mutates and returns `definition`. */
function minimalToolDefinition<
  T extends { name: string; inputSchema: { properties: Record<string, SchemaNode> } },
>(definition: T): T {
  definition.inputSchema.properties = withoutSchemaPaths(
    definition.inputSchema.properties,
    MINIMAL_SCHEMA_PROPERTY_PATHS[definition.name] ?? [],
  );
  const properties = definition.inputSchema.properties as Record<string, unknown>;
  for (const [name, description] of Object.entries(MINIMAL_SCHEMA_COLLAPSED[definition.name] ?? {})) {
    if (properties[name] !== undefined) properties[name] = { type: "object", description };
  }
  // The precondition enum's other values pair with arguments this tier no
  // longer advertises (expectedSha, scopeHandle); "unique-match" is named in
  // the description and the guide, and dispatch still checks the value.
  const editItem = (properties["edits"] as { items?: { properties?: Record<string, unknown> } } | undefined)?.items?.properties;
  if (editItem?.["precondition"] !== undefined) editItem["precondition"] = { type: "string" };
  const query = properties["query"] as { description?: string } | undefined;
  if (query !== undefined) query.description = "The user's request, verbatim.";
  // Only tl_edit_file still lists cwd here, and its own description already
  // says "pass top-level cwd"; the lean text speaks of read/search.
  const cwd = properties["cwd"] as { description?: string } | undefined;
  if (cwd !== undefined) delete cwd.description;
  return definition;
}

/** Deletes `description` from `node` and, recursively, from everything nested inside it (its own `properties`/`items`, and theirs, …). Never touches a property NAME. */
function deleteDescriptionsDeep(node: unknown): void {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return;
  const record = node as Record<string, unknown>;
  delete record["description"];
  const properties = record["properties"];
  if (properties !== null && typeof properties === "object" && !Array.isArray(properties)) {
    for (const child of Object.values(properties as Record<string, unknown>)) deleteDescriptionsDeep(child);
  }
  const items = record["items"];
  if (items !== null && typeof items === "object") deleteDescriptionsDeep(items);
}

/**
 * WP-V1: keeps the `description` on each TOP-level advertised property
 * (`topLevelProperties`'s own immediate entries — `query`, `targets`,
 * `task`, `edits`, `artifact`, …) and deletes it everywhere nested below
 * that — an array's `items`, an object's own nested `properties`, and
 * everything inside those, recursively. No property NAME is touched
 * anywhere by this function; only nested description TEXT is shed, which
 * is where most of the schemas' description bytes live (an edit item's
 * `intent`, an artifact's per-format sub-object, a target's individual
 * field list, a budget dimension, …) for fields comparatively rare next to
 * the ones VSCODE_TOOL_DESCRIPTIONS already covers in prose at the tool
 * level.
 */
export function stripNestedSchemaDescriptions(topLevelProperties: Record<string, unknown>): void {
  for (const node of Object.values(topLevelProperties)) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) continue;
    const record = node as Record<string, unknown>;
    const properties = record["properties"];
    if (properties !== null && typeof properties === "object" && !Array.isArray(properties)) {
      for (const child of Object.values(properties as Record<string, unknown>)) deleteDescriptionsDeep(child);
    }
    const items = record["items"];
    if (items !== null && typeof items === "object") deleteDescriptionsDeep(items);
  }
}

/**
 * WP-V1 (2026-09-20): the additional `leanCallsEnabled()` schema diet for
 * VS Code, and Copilot CLI when `minimalToolsEnabled()` also opts in. The
 * CLI eagerly transmits definitions; this existing open schema avoids paying
 * for rarely authored fields without weakening canonical dispatch validation.
 * Schema diet layered on top of `filterToolDefinitionForSurface` above —
 * see util/flags.ts's `leanCallsEnabled` doc block for the full rationale.
 * An unrelated client, or the applicable flags off: returns
 * `definition` unchanged, so every other client/flag combination stays
 * byte-for-byte identical to pre-WP-V1 output. `dispatchTool`'s own
 * validation is untouched by any of this — a caller that still sends a
 * leaned-away property (`purpose`, an `anyOf`-only shape,
 * `expected_state_version` without a sibling `handle`) is served/refused
 * exactly as it is today.
 */
export function leanToolDefinitionForClient<
  T extends {
    name: string;
    inputSchema: { properties: Record<string, SchemaNode>; oneOf?: unknown[]; anyOf?: unknown[]; required?: string[] };
  },
>(definition: T, clientId: string | undefined): T {
  const cliMinimal = isCopilotCliClient(clientId) && minimalToolsEnabled();
  if (!leanCallsEnabled() || (resolveClientProfile(clientId).id !== "vscode" && !cliMinimal)) return definition;
  definition.inputSchema.properties = withoutSchemaPaths(
    definition.inputSchema.properties,
    LEAN_SCHEMA_PROPERTY_PATHS[definition.name] ?? [],
  );
  // A container property (e.g. `budget`) that LEAN_SCHEMA_PROPERTY_PATHS
  // just emptied out is dropped entirely — see LEAN_SCHEMA_DROP_IF_EMPTY's
  // own doc comment for why this stays a live rule even though nothing
  // reaches it today.
  for (const name of LEAN_SCHEMA_DROP_IF_EMPTY[definition.name] ?? []) {
    const container = definition.inputSchema.properties[name] as { properties?: Record<string, unknown> } | undefined;
    if (container?.properties !== undefined && Object.keys(container.properties).length === 0) {
      delete definition.inputSchema.properties[name];
    }
  }
  delete definition.inputSchema.oneOf;
  delete definition.inputSchema.anyOf;
  stripNestedSchemaDescriptions(definition.inputSchema.properties);
  for (const name of LEAN_SCHEMA_UNDESCRIBED[definition.name] ?? []) {
    const property = definition.inputSchema.properties[name] as { description?: string } | undefined;
    if (property !== undefined) delete property.description;
  }
  const cwd = definition.inputSchema.properties["cwd"] as { description?: string } | undefined;
  if (cwd !== undefined) cwd.description = "tl_edit_file only; omit on read/search in a single-root workspace.";
  // `stripNestedSchemaDescriptions` just removed every nested description,
  // `purpose`'s included; give it back the one sentence that says where it
  // pays (see LEAN_SCHEMA_PROPERTY_PATHS's doc comment).
  const targets = definition.inputSchema.properties["targets"] as
    | { items?: { properties?: Record<string, { description?: string }> } }
    | undefined;
  const purpose = targets?.items?.properties?.["purpose"];
  if (purpose !== undefined) purpose.description = "For a directory target: what to find in it.";
  // Copilot retest r5: the minimal tier, last, so its opaque `select`/
  // `artifact` keep the description LEAN_SCHEMA_UNDESCRIBED removed above.
  if (minimalToolsEnabled()) minimalToolDefinition(definition);
  // Copilot validates call input against this advertisement — see
  // `openSchemaObjects`.
  openSchemaObjects(definition.inputSchema);
  return definition;
}

/**
 * V15-LTS (2026-09-29): the ALL-CLIENT counterpart to `leanToolDefinitionForClient`
 * above — see `leanSchemaEnabled`'s own doc block (util/flags.ts) for why this
 * is a separate, narrower flag rather than an extension of `TL_LEAN_CALLS`.
 * Applies to EVERY client (no `resolveClientProfile` check at all) and sheds
 * only the two elements proven safe for every calling convention, not just
 * vscode's:
 *
 *   - top-level `oneOf`/`anyOf` (tl_read_file's 6-branch oneOf, tl_edit_file's
 *     2-branch anyOf, tl_search_files' 2-branch oneOf). No general-purpose
 *     function-calling schema this server's clients use keeps a top-level
 *     oneOf/anyOf/allOf as advertised STRUCTURE — the Anthropic Messages API
 *     tool `input_schema` requires a plain object at the top level,
 *     OpenAI/Codex's function-parameters schema is the same restricted
 *     subset, and VS Code Copilot's own validator already rejects it
 *     outright (why `leanToolDefinitionForClient` above drops it for
 *     vscode). Observably, Claude Code's own MCP tool loader does not even
 *     attempt to pass ours through as-is: it flattens a top-level oneOf into
 *     a plain-English "Input constraint: Provide parameters for exactly one
 *     of: ..." sentence prepended to the tool description — MORE bytes over
 *     the wire than removing the source oneOf would ever cost.
 *     `dispatchTool` enforces the real constraint from the request body
 *     regardless of what got advertised (the same guarantee
 *     `leanToolDefinitionForClient` already relies on), and the tool's own
 *     top-level `description` plus AGENTS.md's protocol section already
 *     name every sanctioned shape in prose (a bare `qref`, a `task`-only
 *     call, a `cursor`-only continuation, ...).
 *   - `task.dependentRequired` (`{expected_state_version:["handle"]}`).
 *     `server.ts`'s task-handle guard refuses a bare `expected_state_version`
 *     with `field:"expected_state_version"` and an explanatory `detail`
 *     regardless of advertisement, and AGENTS.md already states the exact
 *     same rule in prose ("Pass task.expected_state_version ONLY beside a
 *     task.handle ... alone it refuses").
 *
 * Deliberately does NOT shed `budget.bytes`/`budget.tokens` (a real, usable
 * capability whose removal was motivated by a Copilot-specific replay
 * finding, not a universal no-information-loss argument) and does NOT strip
 * any nested property description (that cut needs a field-by-field audit
 * against guide coverage no wave has attempted yet) — both stay exactly
 * where `leanCallsEnabled`/vscode already shipped them.
 * `filterToolDefinitionForSurface`'s own tl_edit_file anyOf-collapse (adding
 * `required:["edits"]` once the surface filter deletes the `artifact`
 * property) does not apply here: this function never touches PROPERTIES,
 * only the top-level `oneOf`/`anyOf` KEYWORD, so `artifact` — and the actual
 * "at least one of edits/artifact" dispatch rule — survives untouched.
 * Adding a substitute `required` here would be wrong: it would advertise a
 * STRICTER contract than the server enforces.
 *
 * Order-independent with `leanToolDefinitionForClient`: this function's cuts
 * are a strict subset of that one's, so running both (a vscode client with
 * both TL_LEAN_SCHEMA and TL_LEAN_CALLS on) is idempotent — `withoutSchemaPaths`
 * and `delete` on an already-absent key/path are no-ops. ON is the default
 * since v0.15.0 (the 3-real-client gate passed 2026-09-30); OFF (explicit
 * `TL_LEAN_SCHEMA=0`, the rollback path): returns `definition` unchanged, so
 * every client's advertised schema is byte-identical to pre-V15-LTS output.
 */
export function leanSchemaForEveryClient<
  T extends {
    name: string;
    inputSchema: { properties: Record<string, SchemaNode>; oneOf?: unknown[]; anyOf?: unknown[]; required?: string[] };
  },
>(definition: T): T {
  if (!leanSchemaEnabled()) return definition;
  definition.inputSchema.properties = withoutSchemaPaths(definition.inputSchema.properties, ["task.dependentRequired"]);
  delete definition.inputSchema.oneOf;
  delete definition.inputSchema.anyOf;
  return definition;
}
