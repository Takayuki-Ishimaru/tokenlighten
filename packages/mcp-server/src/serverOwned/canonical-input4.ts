// canonical-input — extracted implementation; imports point to the owning modules.
import type { HandleEntry } from "../util/handles.js";
import { CANONICAL_ARRAY_FIELDS } from "./canonical-input.js";
import { CANONICAL_CREATE_COPY_INPUT } from "./canonical-input.js";
import { CANONICAL_LEGACY_MEMBERS } from "./canonical-input3.js";
import { CANONICAL_OBJECT_FIELDS } from "./canonical-input.js";
import { HANDLE_OVERRIDES_INPUT } from "./canonical-input.js";
import { LEGACY_PATHS_INTERNAL_HANDLE_INPUT } from "./canonical-input.js";
import { MULTI_TARGET_SELECTOR_REFUSAL_INPUT } from "./canonical-input.js";
import { RANGE_CONTENT_FULL_INPUT } from "./canonical-input.js";
import { READ_SYMBOL_CAP_BYTES } from "../tools/readCodeModes.js";
import { acceptLegacyTaskProfile } from "./canonical-input3.js";
import { advertisedPropertiesFor } from "./tool-schema.js";
import { artifactQueryWindowEnabled } from "../util/flags.js";
import { asCanonicalObject } from "./canonical-input.js";
import { canonicalToolCall } from "../protocol/envelope.js";
import { countLines } from "../util/countLines.js";
import { csvQueryWindowTarget } from "./canonical-input3.js";
import { effLenientEditEnabled } from "../util/flags.js";
import { effTolerantInputEnabled } from "../util/flags.js";
import { elideDocCommentsForDisplay } from "../util/formatCompress.js";
import { expandMultiTargetRanges } from "./canonical-input3.js";
import { findUnknownProperties } from "../validation/requestShape.js";
import { getSymbolWithContext } from "../tools/getSymbolWithContext.js";
import { handleTable } from "../util/handles.js";
import { isSupportedArchivePath } from "../tools/archive.js";
import { isWithin } from "../util/safePath.js";
import { languageForPath } from "../util/languages.js";
import { legacyPathTarget } from "./canonical-input.js";
import { lenientEditAliases } from "./canonical-input3.js";
import { mapCanonicalBudget } from "./canonical-input.js";
import { mapCanonicalScope } from "./canonical-input.js";
import { mapCanonicalSelect } from "./canonical-input.js";
import { mapCanonicalTask } from "./canonical-input.js";
import { parseLedgerRangeSpec } from "./workspace-routing.js";
import { rangeStartLine } from "./edit-anchor.js";
import { readFileSafe } from "../util/safePath.js";
import { realpathSync } from "node:fs";
import { rescueStringifiedCanonicalFields as rescueCanonicalDialectFields } from "../mcp/transport/canonicalDialectRescue.js";
import { resolvePathsBatchEntry } from "./canonical-input.js";
import { resolveReal } from "../util/safePath.js";
import { safeResolve } from "../util/safePath.js";
import { servedRangeCoverage } from "../state/session.js";
import { servedRangeReceipt } from "../state/session.js";
import { shaOfText } from "../util/handles.js";
import { shortSha } from "../util/handles.js";
import { sliceLinesToText } from "../util/countLines.js";
import { splitArchiveVirtualPath } from "../tools/archive.js";
import { statSync } from "node:fs";
import { tolerateNearMissInput } from "./canonical-input3.js";
import { unservedLineCount } from "../state/session.js";
import { wireLineCostBytes } from "../state/readRequestStore.js";

export function normalizeCanonicalRequest(canonical: string, input: Record<string, unknown>): Record<string, unknown> {
  return projectCanonicalRequest(canonical, prepareCanonicalInput(canonical, input));
}

/**
 * The input-repair half of `normalizeCanonicalRequest`: everything that turns
 * what the caller sent into the canonical shape it meant, and nothing that
 * projects it onto the legacy dispatch dialect. `callToolOnce` validates the
 * prepared input against the advertised schema (`canonicalRequestRefusal`)
 * between the two halves, so a stringified `budget` is validated as the
 * object it carries and a tolerated near-miss as the shape it was rewritten
 * to. Idempotent.
 */
export function prepareCanonicalInput(canonical: string, input: Record<string, unknown>): Record<string, unknown> {
  // FX-2: rescue JSON-stringified canonical fields BEFORE `hasCanonicalShape`
  // (below) or anything else inspects them — `hasCanonicalShape` itself is
  // one of the string-blind checks this rescues (`Array.isArray(input["edits"])`
  // is false for a stringified batch with no OTHER canonical key present,
  // which used to make this whole function a no-op for that call).
  input = rescueCanonicalDialectFields(canonical, input, {
    objectFields: CANONICAL_OBJECT_FIELDS,
    arrayFields: CANONICAL_ARRAY_FIELDS,
    advertisedPropertiesFor,
    findUnknownProperties,
    asObject: asCanonicalObject,
    legacyMembers: CANONICAL_LEGACY_MEMBERS,
  });
  // EFF (TL_EFF_TOLERANT_INPUT / TL_EFF_LENIENT_EDIT): see tolerateNearMissInput
  // and lenientEditAliases.
  if (effTolerantInputEnabled()) input = tolerateNearMissInput(canonical, input);
  else input = acceptLegacyTaskProfile(canonical, input);
  if (canonical === "tl_edit_file" && effLenientEditEnabled()) input = lenientEditAliases(input);
  return input;
}

export function projectCanonicalRequest(canonical: string, input: Record<string, unknown>): Record<string, unknown> {
  // `queries` is the shared legacy/canonical find carrier. A bare legacy
  // find batch must reach the dispatcher unchanged, including its content-first
  // did_you_mean session state. Non-find canonical search actions use queries
  // as their canonical home and still need projection to legacy `query`.
  const hasCanonicalShape = ["targets", "select", "budget", "task", "scope", "credentials"]
    .some((key) => input[key] !== undefined)
    // Preserve addressed legacy reads; only a bare outline adds a new shape.
    || (canonical === "tl_read_file" && input["content"] === "outline"
      && ["mode", "query", "qref", "path", "handle", "paths", "handles", "cursor", "symbol"]
        .every((key) => input[key] === undefined))
    || (canonical === "tl_edit_file" && Array.isArray(input["edits"]))
    || (canonical === "tl_search_files" && input["action"] !== "find" && Array.isArray(input["queries"]));
  if (!hasCanonicalShape) return input;

  const args: Record<string, unknown> = { ...input };
  const task = args["task"];
  const scope = args["scope"];
  const budget = args["budget"];
  const select = args["select"];
  delete args["task"];
  delete args["scope"];
  delete args["budget"];
  delete args["select"];

  mapCanonicalTask(task, args);
  mapCanonicalBudget(budget, args);
  const scopeValue = mapCanonicalScope(scope, args);

  if (canonical === "tl_read_file") {
    const rawTargets = Array.isArray(args["targets"]) ? args["targets"] : [];
    delete args["targets"];
    let targets = rawTargets
      .map(asCanonicalObject)
      .filter((target): target is Record<string, unknown> => target !== undefined);
    // S1-A2 (2026-09-20 dispatcher dead-turn fix): `tl_search_files` documents
    // `scope.path` as "root path to search under", and tl_read_file advertises
    // the same shared `scope` object — a caller reasonably scopes a
    // task-pack `query`/`qref` to a subtree with `scope:{path:<dir>}}`
    // instead of `targets:[{path:<dir>}]`. `mapCanonicalScope` above already
    // copied `scope.path` onto the top-level `args["path"]` unconditionally
    // (every canonical tool shares that field), but with no `targets` this
    // call used to skip the `targets.length > 0` branch below entirely and
    // reach dispatch as an ordinary single-FILE path read — `is-a-directory`
    // for a directory scope, and for a file scope a silent drop of the
    // query/qref in favor of a raw single-file read. Only promote scope.path
    // into a target when there is no explicit target already, a query or
    // qref is actually present (this is a task-pack request, not a bare
    // direct read a `scope.symbol` lookup would also use), and the scope
    // does not ALSO select an archive member (`scope.archive` is its own,
    // unrelated addressing and must not be reinterpreted as a plain path).
    if (
      targets.length === 0
      && (args["query"] !== undefined || args["qref"] !== undefined)
      && typeof scopeValue?.["path"] === "string" && scopeValue["path"] !== ""
      && scopeValue["archive"] === undefined
    ) {
      targets = [{ path: scopeValue["path"] }];
      delete args["path"];
    }
    const selectsArtifact = mapCanonicalSelect(select, args);

    // I-5 fix: fail closed, before ANY legacy projection below, on a
    // multi-target call that mixes an archive selector or a call-level
    // artifact `select` with another target — see
    // MULTI_TARGET_SELECTOR_REFUSAL_INPUT's own doc comment for the exact
    // silent-drop/order-dependence this replaces. `targets` here is still
    // the RAW per-target canonical objects (path/handle/archive/...), pre-
    // legacyPathTarget, so `next` below can re-issue the caller's own first
    // target byte-for-byte.
    const targetsMixArchiveOrArtifactSelect = targets.length > 1
      && (targets.some((target) => target["archive"] !== undefined) || selectsArtifact);
    // F5 extension (opus pre-release review, 2026-08-30): see
    // MULTI_TARGET_SELECTOR_REFUSAL_INPUT's own doc comment for the
    // DIFFERENT silent-drop mechanism this closes (selectorFromArgs/
    // resolvedPath hijacking the whole call from scope.archive, independent
    // of legacyPathTarget). Deliberately allows targets.length === 1 — a
    // lone plain target riding alongside scope.archive is dropped by that
    // SAME mechanism, so it does not need a second target to be ambiguous.
    // A target that already carries its own `archive` is unaffected: the
    // `.some(... === undefined)` check is false when EVERY target is
    // self-sufficient, so a redundant scope.archive alongside only
    // self-sufficient targets is not itself grounds for refusal here.
    const scopeArchiveWithBareTarget = scopeValue?.["archive"] !== undefined
      && targets.length >= 1
      && targets.some((target) => target["archive"] === undefined);
    if (targetsMixArchiveOrArtifactSelect || scopeArchiveWithBareTarget) {
      const firstTarget = targets[0]!;
      const selectObject = asCanonicalObject(select);
      // F4 fix (same review): the recovery `next` used to drop the caller's
      // own query/qref and task (epoch/handle/profile/challenge/
      // force_serve/expected_state_version) — re-issuing only the first
      // target lost whatever task_pack discovery or re-pack context the
      // original call carried, forcing a caller to reconstruct it from
      // scratch. `task` mirrors `select`'s existing asCanonicalObject
      // convention; `query`/`qref` are read straight off `args`, which
      // nothing above this point mutates. A key absent on the original call
      // is never fabricated here.
      const taskObject = asCanonicalObject(task);
      Object.defineProperty(args, MULTI_TARGET_SELECTOR_REFUSAL_INPUT, {
        value: {
          ok: false,
          code: "invalid-input",
          field: "targets",
          error: scopeArchiveWithBareTarget && !targetsMixArchiveOrArtifactSelect
            ? "scope.archive cannot be combined with a target that has no archive selector of its own; re-issue one call per target (next re-issues the first)"
            : "multiple targets cannot mix an archive/artifact selector with another target in one call; re-issue one call per target (next re-issues the first)",
          next: canonicalToolCall("tl_read_file", {
            cwd: args["cwd"],
            targets: [firstTarget],
            ...(args["query"] !== undefined ? { query: args["query"] } : {}),
            ...(args["qref"] !== undefined ? { qref: args["qref"] } : {}),
            ...(selectObject !== undefined ? { select: selectObject } : {}),
            ...(args["content"] !== undefined ? { content: args["content"] } : {}),
            ...(taskObject !== undefined ? { task: taskObject } : {}),
          }),
        },
        enumerable: true,
        configurable: true,
      });
    }

    if (targets.length > 0) {
      // TL-05 (plan §7.1): record whether this canonical request named
      // `content:"full"`, before the `content` consultation below picks
      // `args["mode"]` and before this block's own tail deletes `content`
      // entirely. See RANGE_CONTENT_FULL_INPUT's own doc comment for why a
      // marker is needed and what it does (and does not) change.
      if (args["content"] === "full") {
        Object.defineProperty(args, RANGE_CONTENT_FULL_INPUT, { value: true, enumerable: true, configurable: true });
      }
      // A3: the one spelling that asks for rows rather than a task pack -- one csv/tsv
      // target, a query, and `select.kind` naming it. It is what the window's own
      // restart and a pack's csv `next` emit. Without the flag it stays a task pack.
      const csvWindowTarget = args["query"] !== undefined && targets.length === 1 && artifactQueryWindowEnabled()
        ? csvQueryWindowTarget(targets[0]!, select)
        : undefined;
      if (csvWindowTarget !== undefined) {
        args["path"] = csvWindowTarget.path;
        args["kind"] = csvWindowTarget.kind;
        args["mode"] = "artifact";
      } else if (args["query"] !== undefined || args["qref"] !== undefined) {
        args["paths"] = targets.map(legacyPathTarget);
        Object.defineProperty(args, LEGACY_PATHS_INTERNAL_HANDLE_INPUT, { value: true, enumerable: true, configurable: true });
        args["mode"] = "task_pack";
      } else {
        const first = targets[0]!;
        // A multi-handle continuation is a batch: do not promote the first
        // target's selector to call scope, where it would override content.
        if (targets.length === 1) {
          for (const name of ["path", "handle", "archive", "credentialRef", "range", "ranges", "symbol", "profile", "lang"]) {
            if (first[name] !== undefined) args[name] = first[name];
          }
        }
        if (targets.length > 1) {
          // One target per window: a target's own `ranges[]` reaches both
          // branches below as several single-range targets.
          const windows = expandMultiTargetRanges(targets);
          const handles = windows.map((target) => target["handle"]);
          if (handles.every((handle): handle is string => typeof handle === "string")) {
            args["handles"] = handles;
            // F-V13-1 Fix B: the A7 handles=[] batch loop used to resolve
            // every item from the handle's own STORED range/symbol only, so
            // a caller asking for two different windows of the same file via
            // targets:[{handle,range:"1-28"},{handle,range:"144-401"}] had
            // both requested ranges silently discarded in favor of whatever
            // the handle(s) were minted with (2026-08-29 forensics: two
            // already-served handle+range targets returned the SAME stale
            // stored range twice — served-content misdelivery, not a
            // refusal). Only synthesized when at least one target actually
            // carries an override, so an ordinary handles-only continuation
            // (ranges[] `remaining` chains, verification-kit reads, ...)
            // projects byte-identically to before this fix.
            if (windows.some((t) => t["range"] !== undefined || t["ranges"] !== undefined || t["symbol"] !== undefined)) {
              const overrides = windows.map((t) => {
                const ov: Record<string, unknown> = {};
                if (t["range"] !== undefined) ov["range"] = t["range"];
                // A `ranges` still here is one expandMultiTargetRanges left as
                // sent (beside a `range`, or not all non-empty strings). It is
                // carried through so the A7 loop can refuse that one target
                // explicitly rather than silently falling back to the stored
                // range — see the A7 handleOverrides read site.
                if (t["ranges"] !== undefined) ov["ranges"] = t["ranges"];
                if (t["symbol"] !== undefined) ov["symbol"] = t["symbol"];
                return ov;
              });
              Object.defineProperty(args, HANDLE_OVERRIDES_INPUT, { value: overrides, enumerable: true, configurable: true });
            }
          }
          else {
            args["paths"] = windows.map(legacyPathTarget);
            Object.defineProperty(args, LEGACY_PATHS_INTERNAL_HANDLE_INPUT, { value: true, enumerable: true, configurable: true });
          }
        }
        if (first["archive"] !== undefined) args["mode"] = "archive";
        else if (selectsArtifact) args["mode"] = "artifact";
        // F-V13-1 Fix A (DESIGN-v0.13-plan.md:167): this promotion is only
        // unambiguous for a SINGLE target. Before this gate, a multi-target
        // tl_read_file call whose FIRST entry (or any entry, via `first`) merely
        // happened to carry a range forced the WHOLE call to mode="slice" —
        // and normalizeWireArgs's own mode=slice guard refuses outright the
        // moment more than one path rides along ("mode=slice accepts one
        // path; multiple paths are discovery scope"), so a caller who sent an
        // ordinary canonical `targets:[{path},{path,range}]` discovery/serve
        // request was hit with a legacy-dialect refusal it never asked for.
        // Leaving `mode` unset for targets.length > 1 lets the request fall
        // through to the existing mode-unspecified task_pack promotion gate
        // below (`modeUnspecifiedOrAuto` / `pathlessExploratoryPaths`),
        // which already handles a paths[] batch correctly — including
        // honoring each entry's own explicit range as a zoom window
        // (buildSeededTaskPack's `explicitSeedStart`). The all-handle branch
        // above is unaffected: A7's handles=[] batch dispatch fires before
        // any mode branch regardless of what `mode` resolves to here.
        else if (targets.length === 1 && (first["ranges"] !== undefined || first["range"] !== undefined)) args["mode"] = "slice";
        else if (targets.length === 1 && first["symbol"] !== undefined) args["mode"] = "symbol";
        else if (args["content"] === "full") args["mode"] = "full";
        else if (args["content"] === "outline") args["mode"] = "skeleton";
        else if (args["content"] === "defer") args["mode"] = "small_file";
      }
    }
    // A pathless outline is the canonical repository overview operation.
    // Preserve it before deleting content, including continuations carrying
    // a task handle; restoring that handle's query would loop the redirect.
    if (targets.length === 0 && args["content"] === "outline" && args["mode"] === undefined
      && !selectsArtifact
      && ["query", "qref", "path", "handle", "paths", "handles", "cursor", "symbol", "archive"]
        .every((key) => args[key] === undefined)) {
      args["mode"] = "overview";
    }
    // scope is the single home for closure selection on every tool.
    if (scopeValue?.["includeClosure"] !== undefined) args["includeClosure"] = scopeValue["includeClosure"];
    if (scopeValue?.["surfaceRoles"] !== undefined) args["surfaceRoles"] = scopeValue["surfaceRoles"];
    // DESIGN-v0.15 §6.3 (R6): round-18A finding 3's Symbol-keyed carry-across-
    // the-delete marker is removed — `forceContentServe` (dispatchTool's
    // tl_read_file case) no longer needs to know the ORIGINAL canonical
    // `content:"full"` fact, because that fact no longer forces anything.
    // `content` selects the legacy mode above; do not leak it into the
    // legacy dispatcher, whose served-ledger accounting is mode-based.
    delete args["content"];
  } else if (canonical === "tl_edit_file") {
    const credentials = asCanonicalObject(args["credentials"]);
    delete args["credentials"];
    if (credentials?.["in"] !== undefined) args["credentialRef"] = credentials["in"];
    if (credentials?.["out"] !== undefined) args["outputCredentialRef"] = credentials["out"];
    if (Array.isArray(args["edits"])) {
      const edits = args["edits"].map((value) => {
        const item = asCanonicalObject(value);
        if (item === undefined) return value;
        const copy = { ...item };
        const intent = asCanonicalObject(copy["intent"]);
        delete copy["intent"];
        if (intent !== undefined) {
          for (const name of ["from", "to", "symbol", "lang", "includeComments"]) {
            if (intent[name] !== undefined) copy[name] = intent[name];
          }
          if (intent["kind"] === "rename") copy["mode"] = "rename";
          else if (intent["kind"] !== undefined) copy["intent"] = intent["kind"];
        }
        return copy;
      });
      if (edits.length === 1) {
        const only = asCanonicalObject(edits[0]);
        const canonicalCreateCopy = only?.["create"] === true && typeof only["from"] === "string";
        if (only?.["create"] === true || only?.["mode"] !== undefined || only?.["intent"] !== undefined) {
          delete args["edits"];
          for (const [key, value] of Object.entries(only)) args[key] = value;
          if (canonicalCreateCopy) {
            Object.defineProperty(args, CANONICAL_CREATE_COPY_INPUT, { value: true, enumerable: true });
          }
        } else {
          args["edits"] = edits;
        }
      } else {
        args["edits"] = edits;
      }
    }
  } else if (canonical === "tl_search_files") {
    // SPC (2026-09-29) fix: `queriesWasPresent` distinguishes "the caller
    // sent a real queries[] array" from "queries was absent" — the line
    // below used to default a MISSING queries to `[]` and then, for
    // action=find, unconditionally write that fabricated `[]` BACK onto
    // `args` whenever any OTHER canonical field (budget/scope/task/targets/
    // select/credentials — anything that makes hasCanonicalShape true) rode
    // alongside a perfectly valid singular `query`. The dispatcher's own
    // `hasQueries = args["queries"] !== undefined` then read that fabricated
    // `[]` as "queries WAS supplied", and — with the caller's real `query`
    // also present — refused "pass exactly one of query or queries, not
    // both" for a request that never mentioned `queries` at all (live repro:
    // `{action:"find",query:"X",budget:{bytes:900}}`; reference
    // evaluation0929.searchPageSizing.spec.ts's "caller budget" suite).
    // Only a call that GENUINELY carried `queries[]` may have it re-attached
    // below; an absent one now stays absent, matching the singular-query
    // branch dispatch already expects.
    const queriesWasPresent = Array.isArray(args["queries"]);
    const queries = queriesWasPresent ? (args["queries"] as unknown[]) : [];
    delete args["queries"];
    // Canonical search uses `queries` for every action; legacy references and
    // symbol dispatch still read the first query from their singular slot.
    if (args["action"] === "find" && scopeValue?.["kind"] !== "symbol") {
      // Legacy and canonical find both accept the batched queries carrier.
      // Keep it: dropping it turns a valid sfh6 search into a no-query
      // refusal — but only when the caller actually sent one.
      if (queriesWasPresent) args["queries"] = queries;
    } else if (args["query"] === undefined && typeof queries[0] === "string") {
      // Legacy references and symbols dispatch through their singular query.
      args["query"] = queries[0];
    }
    if (scopeValue?.["kind"] === "symbol" && args["action"] === "find") {
      args["action"] = "symbols";
      delete args["queries"];
      if (typeof queries[0] === "string") args["query"] = queries[0];
      // The symbol scope's own narrowing fields ride the legacy slots the
      // `symbols` producer reads; without this a `scope.path`/`scope.lang`
      // silently searched the whole workspace instead of the scope asked for.
      if (typeof scopeValue?.["path"] === "string" && scopeValue["path"] !== "" && args["path"] === undefined) {
        args["path"] = scopeValue["path"];
      }
      if (typeof scopeValue?.["lang"] === "string" && scopeValue["lang"] !== "" && args["lang"] === undefined) {
        args["lang"] = scopeValue["lang"];
      }
      if (typeof scopeValue?.["includeScores"] === "boolean" && args["includeScores"] === undefined) {
        args["includeScores"] = scopeValue["includeScores"];
      }
    }
    // `locate` remains accepted only as a compatibility spelling.  Its one
    // canonical execution route is closure-bearing tree discovery.
    if (args["action"] === "locate") {
      args["action"] = "tree";
      args["includeClosure"] = true;
    }
  }

  return args;
}

export function normalizeWireArgs(
  canonical: string,
  input: Record<string, unknown>,
): { args: Record<string, unknown> } | { refusal: Record<string, unknown> } {
  const args = { ...input };
  const internalArgs = args as Record<PropertyKey, unknown>;
  const canonicalCreateCopy = internalArgs[CANONICAL_CREATE_COPY_INPUT] === true;
  delete internalArgs[CANONICAL_CREATE_COPY_INPUT];
  if (canonical === "tl_edit_file" && args["create"] === true && typeof args["from"] === "string" && args["mode"] !== "rename" && args["intent"] === undefined && !Array.isArray(args["edits"]) && !canonicalCreateCopy) {
    return { refusal: { ok: false, code: "invalid-input", field: "from", error: "top-level create-by-copy is removed; use edits:[{create:true,from,...}]", retry: "call" } };
  }
  if (canonical === "tl_read_file") {
    if (typeof args["paths"] === "string") {
      // FX-2 (2026-08-29, pre-launch canary): a schema-blind/legacy caller
      // that does not know `paths` is array-typed can serialize a structured
      // paths[] value (object entries with range/symbol, or a plain string
      // array) as ITS OWN JSON TEXT rather than a parsed array. Left
      // untreated, the whole JSON string was wrapped as ONE bogus bare path
      // (`[args["paths"]]`) — mode=pack's own per-entry coercion then
      // serialized it unchanged via `path: String(p)`, producing a
      // not-found item, an empty `read.batch` `entries:[]`, and a `next`
      // whose canonicalized `targets[].path` carried the raw JSON text
      // verbatim (mode=task_pack silently loses the seed path the same
      // way). Try JSON.parse first, accepting only an ARRAY result — a real
      // bare-path string (e.g. paths="src/foo.ts") is never valid JSON
      // array syntax, so it falls through to the unchanged single-element
      // wrap below untouched.
      const rawPathsString = args["paths"] as string;
      let parsedPathsArray: unknown[] | undefined;
      if (rawPathsString.trim().startsWith("[")) {
        try {
          const parsed: unknown = JSON.parse(rawPathsString);
          if (Array.isArray(parsed)) parsedPathsArray = parsed;
        } catch {
          // Not JSON — fall through to the bare-path wrap.
        }
      }
      args["paths"] = parsedPathsArray ?? [rawPathsString];
    }
    else if (args["paths"] !== undefined && !Array.isArray(args["paths"])) {
      return { refusal: { ok: false, code: "invalid-input", field: "paths", error: "paths must be an array (or one path string)", detail: "re-issue tl_read_file with targets:[{path:\"path/to/file\"}]" } };
    }
    if (args["mode"] === "slice" && Array.isArray(args["paths"]) && args["paths"].length > 1) {
      // F-V13-1 Fix C (DESIGN-v0.13-plan.md:167): this is a LEGACY-dialect
      // refusal site — a caller (or a stale/direct `mode=slice` call that
      // predates Fix A's promotion gating) landed here with an explicit
      // mode=slice over more than one path. It used to hand back a raw
      // STRING `next` built by hand: that skips BOTH the emitted-tool-call
      // canonicalizer (canonicalizeEmittedToolCalls only rewrites
      // OBJECT-shaped `arguments`, never a bare string) and the refusal's own
      // guidance-attachment pass (supplyRefusalGuidance's "already has a
      // next" guard treats a present-but-wrong string as done), so `cwd` —
      // required to re-issue this call against the SAME workspace — was
      // silently dropped from the recovery. Building the `next` through
      // canonicalToolCall the way every other executable recovery in this
      // file does fixes both: it is a real advertised-shape object next
      // (`{tool, arguments}`) and it carries `cwd` when the caller supplied
      // one. The prose `error` text keeps its legacy `mode=slice` vocabulary
      // on purpose — it is describing why this LEGACY spelling was refused,
      // not prescribing the recovery's own shape.
      return {
        refusal: {
          ok: false,
          code: "invalid-input",
          field: "paths",
          error: "mode=slice accepts one path; multiple paths are discovery scope",
          next: canonicalToolCall("tl_read_file", {
            mode: "task_pack",
            paths: args["paths"],
            ...(args["cwd"] !== undefined ? { cwd: args["cwd"] } : {}),
          }),
        },
      };
    }
    if (typeof args["handles"] === "string") {
      args["handles"] = args["handles"].split(",").map((value) => value.trim()).filter(Boolean);
    }
    if (args["lines"] !== undefined) {
      if (args["range"] === undefined) args["range"] = String(args["lines"]);
      delete args["lines"];
    }
    if (args["start"] !== undefined && args["end"] !== undefined) {
      if (args["range"] === undefined) args["range"] = `${args["start"]}-${args["end"]}`;
      delete args["start"];
      delete args["end"];
    }
    if (typeof args["range"] === "string") {
      const range = args["range"].trim();
      const colon = /^(\d+)\s*:\s*(\d+)$/.exec(range);
      const eof = /^(\d+)\s*-$/.exec(range);
      if (colon) args["range"] = `${colon[1]}-${colon[2]}`;
      else if (eof) args["range"] = `${eof[1]}-${Number.MAX_SAFE_INTEGER}`;
    }
  }
  if (canonical === "tl_search_files") {
    const aliases: Record<string, string> = {
      grep: "find", search: "find", list: "tree", def: "symbols",
      definitions: "symbols", usages: "references", callers: "references",
    };
    if (typeof args["action"] === "string") args["action"] = aliases[args["action"].toLowerCase()] ?? args["action"];
    if (args["action"] === undefined && (args["query"] !== undefined || args["queries"] !== undefined || args["symbol"] !== undefined)) args["action"] = "find";
    if (args["action"] === "find" && args["query"] === undefined && typeof args["symbol"] === "string") {
      args["query"] = args["symbol"];
      delete args["symbol"];
    }
    if (typeof args["queries"] === "string") args["queries"] = [args["queries"]];
    if (Array.isArray(args["query"])) {
      if (args["queries"] === undefined) args["queries"] = args["query"];
      delete args["query"];
    }
  }
  for (const field of ["limit", "maxTokens", "maxBytes", "depth"]) {
    if (typeof args[field] === "string" && /^\d+$/.test(args[field].trim())) args[field] = Number(args[field]);
  }
  if (typeof args["regex"] === "string") {
    args["regex"] = !["false", "0", "no", ""].includes(args["regex"].trim().toLowerCase());
  }
  return { args };
}

/**
 * I-7 (2026-08-30 forensics attribution wave): a BOUNDED shape classifier for
 * `post_ready_followup`'s `scope_class` -- never the raw path/query itself,
 * only which addressing family this call used. Checked handle first (names
 * exact already-served material), then path/paths/targets (names a
 * location), then query/queries/qref (open text) -- the same precedence a
 * caller's own intent would resolve to when a call names more than one.
 */
export function discoveryScopeClass(args: Record<string, unknown>): "handle" | "path" | "query" | "none" {
  if (
    typeof args["handle"] === "string"
    || (Array.isArray(args["handles"]) && args["handles"].length > 0)
  ) {
    return "handle";
  }
  if (
    typeof args["path"] === "string"
    || (Array.isArray(args["paths"]) && args["paths"].length > 0)
    || (Array.isArray(args["targets"]) && args["targets"].length > 0)
  ) {
    return "path";
  }
  if (
    typeof args["query"] === "string"
    || typeof args["qref"] === "string"
    || (Array.isArray(args["queries"]) && args["queries"].length > 0)
  ) {
    return "query";
  }
  return "none";
}

/**
 * S1-A1: does at least one window this call's ORIGINAL canonical `targets`
 * addresses fall outside the served-range ledger for that target's live
 * content?
 *
 * Used ONLY to decide whether a `qref` re-pack that also names explicit
 * `targets` should be re-projected as though `qref` were absent — see the
 * `dispatchTool` tl_read_file call site's own doc comment for why.
 *
 * A target with NO served history at all (no ledger entry for this exact
 * (path, sha)) counts as unserved by definition -- the MOST unserved a
 * target can be, not a reason to abstain. This function used to `return
 * false` (abstain the WHOLE call) for exactly that case, reasoning that
 * only "zoom into a window of material this task already disclosed" should
 * reproject, and that the OTHER `{qref,targets}` shape AGENTS.md documents
 * ("a re-pack ONCE with `tl_read_file {qref:…,targets:[<candidate paths>]}`"
 * to WIDEN a task's scope with a brand-new path) must stay `task_pack` --
 * confirmed live by taskHandleRecovery.spec.ts's "declared task.profile
 * persists across re-packs" suite. That reasoning cut too wide: it also
 * abstained for a caller re-packing a qref to fetch evidence the SAME
 * pack's own `remaining` had just pointed at -- never served at all, and
 * exactly the "still served (cheap)" case AGENTS.md promises (recorded
 * live, second Copilot session, 2026-09-20: a `decision-unchanged` receipt
 * for three files that had never been served one byte of). The
 * taskHandleRecovery.spec.ts suite this gate was protecting sends
 * `task.force_serve:true` on every one of its brand-new-path re-packs --
 * checked separately at the `dispatchTool` call site below, which now
 * skips this whole reprojection for a forced re-pack regardless of what
 * this function returns. That leaves this function free to answer the
 * question its name asks, literally: is there an unserved window, full
 * stop.
 *
 * Still deliberately CONSERVATIVE for a target this function cannot
 * resolve or measure: an unknown handle, a cross-workspace handle, an
 * archive member, or an unreadable path abstains the WHOLE call (returns
 * false) rather than guessing — a false negative here just keeps today's
 * behavior for that shape (no regression, just not fixed); this function
 * never has the power to cause a wrong reroute beyond what the real
 * served-range ledger already proves, because it reads the SAME ledger the
 * real serve path consults, over the SAME live content.
 */
export const BATCH_WHOLE_FILE_MAX_BYTES = 8192;

/**
 * 2026-10-19 (v016 decision 6t-3): the ceiling of the ONE `read.batch` reply a
 * query-less multi-target read may become (`windowedBatchBytes` bounds the
 * reply, not the raw windows). 32 KiB is the transport-safe ceiling the
 * task_pack route these reads otherwise take already serves up to
 * (readCodeTaskPack.ts `MAX_TASK_PACK_BYTES_HIGH_CONFIDENCE`; Claude Code
 * moves larger MCP replies out of band). The 2026-10-18 value, 16 KiB of raw
 * window bytes, had no rationale of its own beyond "fits one response"; 6t-3
 * then sent T03 rep2's four OrderOrchestrator.java windows (19,954 B) and T10
 * rep2's two whole files plus CONTRACT.md 100-230 (26,245 B) to the pack
 * route, which answered with 17,675 B and 21,273 B packs — the second one
 * without CONTRACT.md 191-230, which the solver then read separately
 * (5,843 B). A client's own smaller default ceiling (VS Code's 14,336 B) and
 * `TOKENLIGHTEN_TASK_PACK_MAX_BYTES` still apply on top of this.
 */
export const BATCH_SINGLE_RESPONSE_MAX_BYTES = 32768;

/**
 * What one `read.batch` entry carries besides its `content` and `path`
 * (`form`, `handle`, `range`, `truncated`, `sha`, `synthesized_range`):
 * 119-259 B, median 145 B, over the 196 such entries of 6t-3's replies. A
 * window's `note` and `elided` list ride on its first entry; with the
 * envelope they fit BATCH_ENVELOPE_RESERVE_BYTES (6t-3: at most 356 B past
 * the per-entry allowance in any reply that carried content).
 */
export const BATCH_ENTRY_HEADER_BYTES = 192;

/** The `read.batch` envelope and any reply-level advisory or normalization note. */
export const BATCH_ENVELOPE_RESERVE_BYTES = 1024;

/**
 * 2026-10-18 (v016 decision 6t-2): the size of `rel` when it names a regular
 * file inside the workspace no larger than mode=auto's own whole-file
 * threshold, else `undefined`. That is the size at which a single bare-path
 * read already serves the whole file rather than a map (`SMALL_FILE_BYTES` in
 * the auto branch of `dispatchTool`, aligned with readCodeSmallFile.ts's
 * AUTO_FULL_THRESHOLD_BYTES). A stat only: no byte of the file is loaded and
 * nothing is traced.
 */
export function smallBatchFileBytes(workspace: string, rel: string): number | undefined {
  const abs = safeResolve(rel, workspace);
  if (abs === undefined) return undefined;
  try {
    const real = realpathSync(abs);
    if (!isWithin(real, resolveReal(workspace))) return undefined;
    const st = statSync(real);
    return st.isFile() && st.size <= BATCH_WHOLE_FILE_MAX_BYTES ? st.size : undefined;
  } catch {
    return undefined;
  }
}

/** The `read.batch` item `heldBatchWindowEntry` answers a held window with (projected as `file-downgraded`). */
export type HeldBatchWindowEntry = {
  path: string;
  range: string;
  handle: string;
  sha: string;
  downgraded_from: "range";
  reason: "already-served";
  code_unchanged: true;
  summary: { served: string[]; unserved?: string[]; complete: boolean };
  note: string;
};

/**
 * 2026-10-18 (DESIGN-v0.14-plan.md §20.17): the short already-served entry a
 * batch answers one window with when this session already served all of it at
 * the file's current content — the batch counterpart of the single-target
 * `code-unchanged` receipt, judged the same way (`servedRangeReceipt`, against
 * the request's own comment elision; a request that keeps comments is owed
 * every line as bytes, so a line a reply only disclosed as `elided` is not
 * held for it). `undefined` serves the window: nothing held at the file's
 * current sha (a changed file is served again), a window held only in part
 * (served whole, as the task_pack route served it), a symbol slice
 * (`assembled`), or a truncated window (its `next` names the rest).
 *
 * 2026-10-20 (v016 decision 6t-7, T13 rep1 #9): shared by the windowed paths
 * batch and the A7 handles batch, whose verbatim re-ask resent every body.
 */
export function heldBatchWindowEntry(
  workspace: string,
  filePath: string,
  fileText: string,
  slice: { path: string; range: string; content: string; truncated: boolean; assembled?: true },
  elided: ReadonlyArray<readonly [number, number]>,
  keepComments: boolean,
  handle: string,
): HeldBatchWindowEntry | undefined {
  if (slice.assembled === true || slice.truncated) return undefined;
  const start = rangeStartLine(slice.range);
  const totalLines = countLines(fileText);
  const end = Math.min(totalLines, start + countLines(slice.content) - 1);
  const fileSha = shaOfText(fileText);
  // A rendering that elides nothing shows every line, so it is owed each as bytes:
  // a block an earlier pack only disclosed is not held for it (code-fix probe, 2026-11-01).
  const held = servedRangeReceipt(workspace, filePath, fileSha, start, end, totalLines, elided, keepComments || elided.length === 0);
  if (held === undefined) return undefined;
  // What was elided was disclosed, not served, so the sentence below must not cover it.
  const elidedNote = elided.length === 0 ? "" : `; comment lines ${elided.map(([first, last]) => `${first}-${last}`).join(",")} stay elided, select.comments:"keep" serves them`;
  return {
    path: slice.path,
    // The window this entry answers, as the read normalized it (`full` and
    // `N-end` arrive as line numbers): two windows of one file in the same
    // batch differ here, not only in `note`.
    range: slice.range,
    handle,
    sha: shortSha(fileSha),
    downgraded_from: "range",
    reason: "already-served",
    code_unchanged: true,
    summary: {
      served: held.served,
      ...(held.unserved.length > 0 ? { unserved: held.unserved } : {}),
      complete: held.complete,
    },
    note: `lines ${slice.range} were served earlier this session and are unchanged`
      + `${held.served_by !== undefined ? ` (${held.served_by})` : ""}; task.force_serve:true resends them${elidedNote}`,
  };
}

/**
 * 2026-10-20 (v016 decision 6t-7, T13 rep1): the window a `{handle}` batch
 * entry reads, as the `{path, range}` entry `windowedBatchBytes` bounds: the
 * handle's path in this workspace with the entry's own `range`, else the
 * handle's stored range (none for a bare file handle: the whole file) — the
 * resolution the S6 loop performs. An entry that names no such window is
 * returned as sent, which keeps the task_pack route: an unknown handle, one
 * minted in another workspace or for an archive member, a `ranges[]` the
 * projection left as sent, and a symbol read (the entry's own `symbol`, or a
 * symbol handle whose entry names no range outside `content:"full"`).
 */
export function handleBatchEntryWindow(entry: unknown, workspace: string, contentFull: boolean): unknown {
  if (typeof entry !== "object" || entry === null) return entry;
  const fields = entry as Record<string, unknown>;
  if (typeof fields["handle"] !== "string" || fields["path"] !== undefined) return entry;
  if (fields["symbol"] !== undefined || fields["ranges"] !== undefined) return entry;
  const resolved = resolvePathsBatchEntry(entry, workspace);
  const hEntry = handleTable.get(fields["handle"]);
  if (resolved.path === "" || hEntry === undefined || splitArchiveVirtualPath(resolved.path) !== undefined) return entry;
  if (resolved.range === undefined && !contentFull && hEntry.symbol !== undefined) return entry;
  const range = resolved.range ?? hEntry.range;
  return { path: resolved.path, ...(range !== undefined ? { range } : {}) };
}

/**
 * 2026-10-18 (v016 decision 6t-2): an upper bound on the `read.batch` reply a
 * query-less multi-target read becomes when EVERY entry is an explicit window
 * -- a path with its own `range`, or a bare path to a file
 * `smallBatchFileBytes` accepts, or a handle entry that resolves to one of
 * those (`handleBatchEntryWindow`, 2026-10-20) -- and `undefined` for
 * anything else (a `ranges[]` or `symbol` entry, a handle that names no
 * window, a bigger file, a directory, a missing path, an unparseable range).
 * The S6 batch loop takes such a read only when this bound fits one response:
 * that loop has no continuation chain of its own, so every read that needs
 * one (cursor staleness across hops, exact-range delivery under a budget)
 * keeps the task_pack route that guarantees it. The bound counts every
 * window, including ones the batch will answer as already served.
 *
 * 2026-10-19 (v016 decision 6t-3): the bound is the reply's bytes, not the
 * windows' raw bytes, because the 16 KiB limit moved up to the reply ceiling
 * (`BATCH_SINGLE_RESPONSE_MAX_BYTES`), where the difference matters. Per
 * window: its JSON-escaped text, plus one entry header and path for every run
 * the default comment elision could split it into — the batch ships one entry
 * per run between elided doc-comment blocks, and on a file dense with small
 * JSDoc blocks those headers outweigh the comments they replace (up to 1.6x
 * the raw size across the bench fixtures). Eliding or not, the reply is no
 * larger than this; an answer-lane line gutter (`protocol/lineGutter.ts`,
 * applied after the producers) rides on top, as it does on the task_pack
 * route's own caps. A window larger than `READ_SYMBOL_CAP_BYTES` is refused
 * here: `resolveSlice` would cut it and hand back a continuation, the chain
 * this loop does not have. Markdown windows ride like any other text, as a
 * single-target `.md` read returns `read.text`.
 */
export async function windowedBatchBytes(workspace: string, entries: readonly unknown[], contentFull = false): Promise<number | undefined> {
  let total = BATCH_ENVELOPE_RESERVE_BYTES;
  for (const raw of entries) {
    const entry = handleBatchEntryWindow(raw, workspace, contentFull);
    const fields = typeof entry === "object" && entry !== null ? entry as Record<string, unknown> : undefined;
    const rel = typeof entry === "string" ? entry : fields?.["path"];
    if (typeof rel !== "string" || rel === "") return undefined;
    if (fields !== undefined && (fields["ranges"] !== undefined || fields["symbol"] !== undefined || fields["handle"] !== undefined)) {
      return undefined;
    }
    // Documents, tables and archives have their own single-target routes
    // (artifact extraction, the CSV table view, archive members); a text
    // batch would only report them undecodable.
    if (/\.(docx|xlsx|pptx|pdf|csv|zip)$/i.test(rel) || isSupportedArchivePath(rel)) return undefined;
    const range = fields?.["range"];
    let window: [number, number] | undefined;
    if (range === undefined) {
      if (smallBatchFileBytes(workspace, rel) === undefined) return undefined;
    } else {
      window = typeof range === "string" ? parseLedgerRangeSpec(range) : undefined;
      if (window === undefined) return undefined;
    }
    // served-bytes: not-served (size probe: the requested window's byte length picks the batch route; no byte of `content` reaches the wire)
    const content = await readFileSafe(rel, workspace);
    if (content === null) return undefined;
    const totalLines = countLines(content);
    const [start, end] = window ?? [1, totalLines];
    if (start > totalLines) return undefined;
    const last = Math.min(end, totalLines);
    // Served lines no longer decide the route (DESIGN-v0.14-plan.md §20.16-
    // §20.17). A window held only in part is served whole by the batch loop,
    // as the task_pack route served it (bench 6t-2 T07's #4 pack resent
    // balance.go 1-80 whole after the first pack had served 40-80); a window
    // held in full gets the loop's short already-served entry, where that
    // route's `prior` rows knew only windows an earlier PACK had served.
    const windowText = content.split("\n").slice(start - 1, last).join("\n");
    // +1: `resolveSlice` gives a window that reaches EOF the file's final newline back.
    if (Buffer.byteLength(windowText, "utf8") + 1 > READ_SYMBOL_CAP_BYTES) return undefined;
    const runs = elideDocCommentsForDisplay(windowText, languageForPath(rel), false, start).elided.length + 1;
    total += wireLineCostBytes(windowText) + runs * (BATCH_ENTRY_HEADER_BYTES + wireLineCostBytes(rel));
  }
  return total;
}

/**
 * 2026-10-18 (v016 decision 6t-2): can every explicit target of a same-task
 * `{query, targets}` call be read as named — a regular file inside the
 * workspace, by path or by an in-workspace handle, no archive member? Only
 * then is the call re-projected onto a plain targets read when its windows
 * are already served (`dispatchTool`'s S1-A1 block); anything this cannot
 * vouch for keeps the task_pack route, as `qrefRepackTargetsHaveUnservedWindow`
 * abstains. A stat only: no byte of a file is loaded.
 */
export function explicitTargetsReadable(workspace: string, targets: readonly unknown[]): boolean {
  for (const raw of targets) {
    if (typeof raw !== "object" || raw === null) return false;
    const target = raw as Record<string, unknown>;
    if (target["archive"] !== undefined) return false;
    const handle = typeof target["handle"] === "string" ? target["handle"] : undefined;
    const hEntry = handle !== undefined ? handleTable.get(handle) : undefined;
    if (handle !== undefined && (hEntry === undefined || hEntry.workspaceRoot !== workspace)) return false;
    const rel = typeof target["path"] === "string" ? target["path"] : hEntry?.path;
    if (rel === undefined || rel === "") return false;
    const abs = safeResolve(rel, workspace);
    if (abs === undefined) return false;
    try {
      const real = realpathSync(abs);
      if (!isWithin(real, resolveReal(workspace)) || !statSync(real).isFile()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export async function qrefRepackTargetsHaveUnservedWindow(
  workspace: string,
  targets: readonly unknown[],
): Promise<boolean> {
  let sawUnservedWindow = false;
  for (const raw of targets) {
    if (typeof raw !== "object" || raw === null) return false;
    const target = raw as Record<string, unknown>;
    // Archive members have their own credential/selector plumbing this probe
    // does not replicate; leaving them out of this fix's scope is strictly
    // conservative (never triggers a reroute this function cannot vouch for).
    if (target["archive"] !== undefined) return false;
    const handle = typeof target["handle"] === "string" ? target["handle"] : undefined;
    const hEntry = handle !== undefined ? handleTable.get(handle) : undefined;
    if (handle !== undefined && (hEntry === undefined || hEntry.workspaceRoot !== workspace)) return false;
    const path = typeof target["path"] === "string" ? target["path"] : hEntry?.path;
    if (path === undefined || path === "") return false;
    // served-bytes: not-served (ledger probe only: sha + line count decide whether a window is unserved; no byte of `content` reaches the wire)
    const content = await readFileSafe(path, workspace);
    // A path that does not exist (a caller's wrong guess among otherwise good
    // targets — recorded live: 4 real files + 1 mistyped path) says nothing
    // about whether the OTHER targets are unserved. Skip it instead of
    // abstaining for the whole call: the qref-less projection then reports
    // that one entry as not-found exactly as a plain multi-target read does,
    // and the real files are served instead of a body-less receipt. A call
    // whose EVERY target is unreadable still returns false below (nothing
    // proved unserved), so it keeps today's receipt.
    if (content === null) continue;
    const sha = shaOfText(content);
    const totalLines = countLines(content);
    const coverage = servedRangeCoverage(workspace, path, sha, totalLines);
    // S1-A1 addendum (2026-09-20, second Copilot session): no ledger entry
    // at all for this exact (path, sha) means this session never served one
    // byte of it -- the MOST unserved a target can be, not a reason to
    // abstain. This used to `return false` here, aborting the WHOLE probe
    // (so the caller's re-pack answered from the body-less task_pack
    // receipt instead of serving the brand-new evidence it named) -- see
    // this function's own doc comment above for why that scope cut existed
    // and why it was wrong. `task.force_serve:true` is the one shape that
    // must still take the OLD (task_pack) path unchanged -- checked at the
    // call site, not here (taskHandleRecovery.spec.ts).
    if (coverage === undefined) {
      sawUnservedWindow = true;
      continue;
    }
    const rangesField = target["ranges"];
    const rangeField = target["range"];
    const windows: Array<[number, number]> = [];
    if (Array.isArray(rangesField)) {
      for (const spec of rangesField) {
        const parsed = typeof spec === "string" ? parseLedgerRangeSpec(spec) : undefined;
        if (parsed !== undefined) windows.push(parsed);
      }
    } else if (typeof rangeField === "string") {
      const parsed = parseLedgerRangeSpec(rangeField);
      if (parsed !== undefined) windows.push(parsed);
    } else if (typeof target["symbol"] === "string") {
      // A named selector denotes lines this probe cannot name directly; the
      // claim is well-formed only when this file's OWN coverage is COMPLETE
      // at this sha (mirrors state/session.ts's heldSelfMaterialReceipt for
      // the same named-selector shape).
      if (!coverage.complete) sawUnservedWindow = true;
      continue;
    } else {
      // A bare path/handle target with no window selector addresses the
      // whole file.
      windows.push([1, totalLines]);
    }
    for (const [start, end] of windows) {
      if (unservedLineCount(workspace, path, sha, start, end, totalLines) > 0) sawUnservedWindow = true;
    }
  }
  return sawUnservedWindow;
}

/**
 * WP-S10 (2026-09-20), turn-economy: one target this call addresses, either
 * as one or more explicit line windows or as a symbol name to resolve. Built
 * by `collectSmallWindowTargets` below -- see its own doc comment.
 */
export interface SmallWindowTarget {
  path: string;
  windows?: Array<[number, number]>;
  symbol?: string;
}

/**
 * WP-S10 (2026-09-20), turn-economy: pulls the explicit range/ranges/symbol
 * off ONE target's own fields, falling back to a resolved handle's OWN
 * stored range/symbol when the fields carry none of their own -- a bare
 * `handles:[...]` continuation with no per-item override still addresses the
 * exact window the handle was minted with. Returns `undefined` when NEITHER
 * the fields nor the handle name any window at all -- a whole-file/whole-
 * target reference, which `collectSmallWindowTargets` treats as "this call
 * is not eligible".
 */
export function smallWindowFromFields(
  fields: Record<string, unknown>,
  fallbackEntry: HandleEntry | undefined,
): { windows?: Array<[number, number]>; symbol?: string } | undefined {
  const rangesField = fields["ranges"];
  if (Array.isArray(rangesField) && rangesField.length > 0) {
    const windows: Array<[number, number]> = [];
    for (const spec of rangesField) {
      const parsed = typeof spec === "string" ? parseLedgerRangeSpec(spec) : undefined;
      if (parsed === undefined) return undefined;
      windows.push(parsed);
    }
    return { windows };
  }
  const rangeField = fields["range"];
  if (typeof rangeField === "string") {
    const parsed = parseLedgerRangeSpec(rangeField);
    return parsed === undefined ? undefined : { windows: [parsed] };
  }
  const symbolField = fields["symbol"];
  if (typeof symbolField === "string" && symbolField !== "") return { symbol: symbolField };
  if (fallbackEntry?.range !== undefined) {
    const parsed = parseLedgerRangeSpec(fallbackEntry.range);
    if (parsed !== undefined) return { windows: [parsed] };
  }
  if (fallbackEntry?.symbol !== undefined && fallbackEntry.symbol !== "") return { symbol: fallbackEntry.symbol };
  return undefined;
}

/**
 * WP-S10 (2026-09-20), turn-economy (`reserveSmallWindowsEnabled`, util/
 * flags.ts): reads every explicit line window THIS `tl_read_file` call
 * addresses off whichever post-normalization shape survived -- `handles:[...]`
 * (+ this call's own `HANDLE_OVERRIDES_INPUT`, the A7 batch's own per-item
 * carrier), `paths:[...]` (the `targets` -> legacy-paths projection every
 * qref/query re-pack and multi-path batch shares), or a single top-level
 * `path`/`handle` with its own `range`/`ranges`/`symbol`.
 *
 * Returns `undefined` -- "this call is not eligible" -- for anything that is
 * not, in full, an explicit-window request: a bare path/handle continuation
 * with no window of its own AND no stored handle window either (a whole-file
 * reference), a `paths[]` entry that is a bare string (the caller-named-file
 * task-pack seed shape, `legacyPathTarget`'s own whole-file encoding), an
 * archive-member entry, or an unparsable range. Conservative BY TARGET, not
 * only by call: any single target this function cannot resolve into a window
 * aborts the WHOLE call (returns `undefined`) rather than sizing a partial
 * view of it -- mirroring `qrefRepackTargetsHaveUnservedWindow`'s own posture
 * a few lines above, a false negative here just keeps today's behaviour (no
 * regression, only a missed optimization), never a wrong reroute.
 */
export function collectSmallWindowTargets(
  args: Record<string, unknown>,
  workspace: string,
): SmallWindowTarget[] | undefined {
  const handleOverrides = (args as Record<PropertyKey, unknown>)[HANDLE_OVERRIDES_INPUT] as
    | Array<Record<string, unknown>>
    | undefined;

  if (Array.isArray(args["handles"]) && (args["handles"] as unknown[]).length > 0) {
    const ids = (args["handles"] as unknown[]).map(String);
    const out: SmallWindowTarget[] = [];
    for (let i = 0; i < ids.length; i++) {
      const entry = handleTable.get(ids[i]!);
      if (entry === undefined || entry.workspaceRoot !== workspace || entry.path === undefined || entry.path === "") {
        return undefined;
      }
      const win = smallWindowFromFields(handleOverrides?.[i] ?? {}, entry);
      if (win === undefined) return undefined;
      out.push({ path: entry.path, ...win });
    }
    return out;
  }

  if (Array.isArray(args["paths"]) && (args["paths"] as unknown[]).length > 0) {
    const raw = args["paths"] as unknown[];
    const out: SmallWindowTarget[] = [];
    for (const item of raw) {
      if (typeof item !== "object" || item === null) return undefined;
      const obj = item as Record<string, unknown>;
      if (obj["archive"] !== undefined) return undefined;
      const handleId = typeof obj["handle"] === "string" ? obj["handle"] : undefined;
      const handleEntry = handleId !== undefined ? handleTable.get(handleId) : undefined;
      if (handleId !== undefined && (handleEntry === undefined || handleEntry.workspaceRoot !== workspace)) {
        return undefined;
      }
      const path = typeof obj["path"] === "string" ? obj["path"] : handleEntry?.path;
      if (path === undefined || path === "") return undefined;
      const win = smallWindowFromFields(obj, handleEntry);
      if (win === undefined) return undefined;
      out.push({ path, ...win });
    }
    return out;
  }

  const handleId = typeof args["handle"] === "string" ? args["handle"] : undefined;
  const handleEntry = handleId !== undefined ? handleTable.get(handleId) : undefined;
  if (handleId !== undefined && (handleEntry === undefined || handleEntry.workspaceRoot !== workspace)) return undefined;
  const path = typeof args["path"] === "string" ? args["path"] : handleEntry?.path;
  if (path === undefined || path === "") return undefined;
  const win = smallWindowFromFields(args, handleEntry);
  if (win === undefined) return undefined;
  return [{ path, ...win }];
}

/** WP-S10 (2026-09-20): the size gate `reserveSmallWindowsEnabled` applies. */
export const RESERVE_SMALL_WINDOWS_MAX_LINES = 120;

export const RESERVE_SMALL_WINDOWS_MAX_BYTES = 4096;

/**
 * WP-S10 (2026-09-20), turn-economy: sums the LIVE size (lines + raw UTF-8
 * bytes) of every window `collectSmallWindowTargets` found, short-circuiting
 * the moment either cap is exceeded (the exact final tally does not matter
 * once the call is already disqualified). A `symbol` target is resolved
 * through the SAME `getSymbolWithContext` the single-target `mode=symbol`
 * path uses (tools/readCodeModes.ts's `resolveSlice`); an unresolvable
 * symbol or an unreadable path aborts the whole measurement (`undefined`),
 * and a range that starts past end-of-file measures as zero -- the same
 * "served nothing" leniency `resolveSlice` itself applies, never a refusal.
 */
export async function measureSmallWindowTotal(
  workspace: string,
  targets: readonly SmallWindowTarget[],
): Promise<{ lines: number; bytes: number } | undefined> {
  let totalLines = 0;
  let totalBytes = 0;
  const contentByPath = new Map<string, string | null>();
  for (const target of targets) {
    let content = contentByPath.get(target.path);
    if (content === undefined) {
      // served-bytes: not-served (sizing probe only, to decide force_serve eligibility; the real serve re-reads through its own annotated door)
      content = await readFileSafe(target.path, workspace);
      contentByPath.set(target.path, content);
    }
    if (content === null) return undefined;
    if (target.symbol !== undefined) {
      const symResult = await getSymbolWithContext(content, { path: target.path, symbol: target.symbol });
      if (!symResult.ok) return undefined;
      totalLines += symResult.data.range.end - symResult.data.range.start + 1;
      totalBytes += Buffer.byteLength(symResult.data.code, "utf8");
    } else if (target.windows !== undefined) {
      const fileLines = countLines(content);
      for (const [start, end] of target.windows) {
        if (start > fileLines) continue;
        const clampedEnd = Math.min(end, fileLines);
        totalLines += clampedEnd - start + 1;
        totalBytes += Buffer.byteLength(sliceLinesToText(content, start, clampedEnd), "utf8");
      }
    } else {
      return undefined;
    }
    if (totalLines > RESERVE_SMALL_WINDOWS_MAX_LINES || totalBytes > RESERVE_SMALL_WINDOWS_MAX_BYTES) {
      return { lines: totalLines, bytes: totalBytes };
    }
  }
  return { lines: totalLines, bytes: totalBytes };
}

/**
 * S1-A1: every `args` field `normalizeCanonicalRequest`'s tl_read_file
 * `targets`-with-no-`select` handling can set for a single- or multi-target
 * call, so the reprojection at the `dispatchTool` call site can sync exactly
 * these and nothing else (leaving whatever `select` already produced on the
 * live call untouched).
 */
export const TARGET_PROJECTION_SYNC_KEYS = [
  "mode", "path", "handle", "handles", "paths", "archive", "credentialRef",
  "range", "ranges", "symbol", "profile", "lang", "includeClosure", "surfaceRoles",
] as const;
