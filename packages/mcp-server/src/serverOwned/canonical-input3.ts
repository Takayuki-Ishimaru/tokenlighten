// canonical-input — extracted implementation; imports point to the owning modules.
import type { InvalidValueViolation } from "../validation/requestShape.js";
import type { LineWindow } from "@tokenlighten/types";
import type { RequestElisionProbe } from "../state/session.js";
import type { SchemaNode } from "../validation/requestShape.js";
import type { ToolCall } from "@tokenlighten/types";
import type { UnknownPropertyViolation } from "../validation/requestShape.js";
import { ARTIFACT_EXTS } from "../tools/walkRepo.js";
import { CANONICAL_NAME_CHECKED_CARRIERS } from "./canonical-input2.js";
import { CANONICAL_READ_INPUT_KEYS } from "./canonical-input2.js";
import { CANONICAL_VALUE_OPTIONS } from "./canonical-input2.js";
import { STALE_RANGE_PROBE_MAX_BYTES } from "./read-admission.js";
import { advertisedPropertiesFor } from "./tool-schema.js";
import { asCanonicalObject } from "./canonical-input.js";
import { batchHintsEnabled } from "../util/flags.js";
import { canonicalToolCall } from "../protocol/envelope.js";
import { countLines } from "../util/countLines.js";
import { currentSessionLane } from "../util/laneKey.js";
import { cursorCall as readRequestCursorCall } from "../protocol/readRequestContinuation.js";
import { dispatchPropertiesFor } from "./tool-schema.js";
import { elideDocCommentsForDisplay } from "../util/formatCompress.js";
import { elideDocCommentsForExplicitWindow } from "../util/formatCompress.js";
import { findInvalidValues } from "../validation/requestShape.js";
import { findUnknownProperties } from "../validation/requestShape.js";
import { invalidValueRefusal } from "../validation/requestShape.js";
import { isWithin } from "../util/safePath.js";
import { languageForPath } from "../util/languages.js";
import { mintReadCursor } from "../state/readRequestStore.js";
import { nearestAllowedValue } from "../validation/requestShape.js";
import { openParentReadRequest } from "../state/readRequestStore.js";
import { protocolCallContext } from "../protocol/envelope.js";
import { publicTopLevelKeyHint } from "./edit-validation.js";
import { readFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { resolveReal } from "../util/safePath.js";
import { safeResolve } from "../util/safePath.js";
import { shaOfText } from "../util/handles.js";
import { spansExcludingWindows } from "../util/formatCompress.js";
import { stageReadRequestForServe } from "./canonical-input2.js";
import { statSync } from "node:fs";
import { unknownPropertyRefusal } from "../validation/requestShape.js";
import { withSearchObjectHint } from "./edit-validation.js";

export function canonicalRequestRefusal(
  canonical: string,
  input: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const advertised = advertisedPropertiesFor(canonical);
  const carriers = CANONICAL_NAME_CHECKED_CARRIERS[canonical] ?? [];
  // Top-level names dispatch still accepts: the legacy flat spellings (its
  // own fence and value tolerance own them), plus W-BATCH-HINT's flag-gated
  // `ledger` (added to the read fence only while the flag is on).
  const legacyAccepted = canonical === "tl_edit_file"
    ? undefined
    : new Set([
        ...Object.keys(dispatchPropertiesFor(canonical)),
        ...(canonical === "tl_read_file" && batchHintsEnabled() ? ["ledger"] : []),
      ]);

  const nameViolations: UnknownPropertyViolation[] = [];
  const advertisedOnly: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    const node = advertised[key];
    if (node !== undefined) {
      advertisedOnly[key] = input[key];
      if (carriers.includes(key)) {
        nameViolations.push(...findUnknownProperties(canonical, { [key]: node }, { [key]: input[key] }));
      }
      continue;
    }
    if (legacyAccepted === undefined || legacyAccepted.has(key)) continue;
    const hint = publicTopLevelKeyHint(canonical, key);
    nameViolations.push({
      field: key,
      parentPath: canonical,
      advertisedKeysAtPath: hint.keys,
      ...(hint.didYouMean !== undefined ? { didYouMean: hint.didYouMean } : {}),
    });
  }
  // A legacy `task.taskProfile` no policy accepted, as the call's only unknown
  // name, is named with its corrected call (see `legacyTaskProfileRefusal`).
  if (nameViolations.length === 1 && nameViolations[0]!.field === "task.taskProfile") {
    const legacy = legacyTaskProfileRefusal(canonical, input);
    if (legacy !== undefined) return legacy;
  }
  const nameRefusal = unknownPropertyRefusal(canonical, nameViolations.map((violation) => misnestedCarrierHint(advertised, violation)));
  if (nameRefusal !== null) return nameRefusal;

  const valueViolations = findInvalidValues(canonical, advertised, advertisedOnly, CANONICAL_VALUE_OPTIONS[canonical]);
  if (canonical === "tl_edit_file") valueViolations.push(...editItemTargetViolations(input));
  const valueRefusal = invalidValueRefusal(canonical, sortByEditItem(valueViolations));
  if (valueRefusal !== null) {
    return canonical === "tl_edit_file" ? withSearchObjectHint(valueRefusal, valueViolations, input) : valueRefusal;
  }

  return canonical === "tl_edit_file" ? editItemDependencyRefusal(input) : undefined;
}

/**
 * 2026-10-19 (decision run 6t-4, arm A: T07 rep0, T13 reps 1 and 2): the first
 * tl_read_file sent `task` as the JSON string
 * `{"epoch":"new","taskProfile":"generic"}` (T13: `"wiring"`). The legacy
 * member kept the FX-2 rescue from parsing it, so the call was refused
 * `invalid-input` "task must be an object" with no `next`, and each cell
 * re-sent the task as an object, while the same task sent as an object would
 * have been served. The rescue now parses such a string
 * (CANONICAL_LEGACY_MEMBERS) and the member meets what a native one meets:
 * renamed to `task.profile` where a policy accepts it (TL_EFF_TOLERANT_INPUT,
 * default ON, on every tool; TL_LEGACY_INPUT=accept on the read tools), and
 * otherwise refused here, naming it and carrying the corrected call: `profile`
 * in its place (dropped instead when the call already sends `task.profile`,
 * and on tl_edit_file, whose edits a profile does not change), every other
 * argument unchanged.
 */
export function legacyTaskProfileRefusal(canonical: string, input: Record<string, unknown>): Record<string, unknown> | undefined {
  const task = asCanonicalObject(input["task"]);
  if (task === undefined || task["taskProfile"] === undefined) return undefined;
  const { taskProfile, ...rest } = task;
  const edit = canonical === "tl_edit_file";
  const moved = !edit && rest["profile"] === undefined && typeof taskProfile === "string";
  // tl_edit_file loses its `task.profile` too: with TL_EFF_TOLERANT_INPUT off
  // its dispatcher refuses the projected name, so a `next` keeping it would be
  // refused in turn.
  const { profile: _profile, ...withoutProfile } = rest;
  const corrected = moved ? { ...rest, profile: taskProfile } : edit ? withoutProfile : rest;
  const { task: _task, ...others } = input;
  const nextArguments = Object.keys(corrected).length > 0 ? { ...others, task: corrected } : others;
  // `field` names the member; the prose does not spell it again, since
  // models copy server text into their next call (rc/noLegacySpellingOnWire).
  return {
    ok: false,
    code: "legacy-input",
    field: "task.taskProfile",
    error: moved
      ? "legacy input: the canonical member is task.profile"
      : edit
        ? "legacy input: a profile changes nothing an edit writes"
        : "legacy input: this call already sends task.profile",
    detail: moved
      ? "next is this call with task.profile in its place"
      : edit
        ? "next is this call without a task profile"
        : "next is this call without the legacy member",
    retry: "call",
    next: canonicalToolCall(canonical as Parameters<typeof canonicalToolCall>[0], nextArguments),
  };
}

/**
 * An unknown member of one carrier that is a member of ANOTHER carrier
 * (`targets[0].sections` — `sections` lives in `select`) names that home as
 * its suggestion, `select.sections`, when no same-carrier name is close.
 */
export function misnestedCarrierHint(
  advertised: Record<string, SchemaNode>,
  violation: UnknownPropertyViolation,
): UnknownPropertyViolation {
  if (violation.didYouMean !== undefined) return violation;
  const key = /\.([^.[\]]+)$/.exec(violation.field)?.[1];
  if (key === undefined) return violation;
  for (const [carrier, node] of Object.entries(advertised)) {
    if (node.properties !== undefined && key in node.properties && !violation.field.startsWith(`${carrier}.`)) {
      return { ...violation, didYouMean: `${carrier}.${key}` };
    }
  }
  return violation;
}

/**
 * `edits[].target` is advertised as `"all": replace every match.`; any other
 * value used to be ignored, leaving a single-site replace. An intent item's
 * `target` is the flat intent dialect's member text (intents/index.ts), not
 * this flag, so intent items are left alone.
 */
export function editItemTargetViolations(input: Record<string, unknown>): InvalidValueViolation[] {
  const edits = input["edits"];
  if (!Array.isArray(edits)) return [];
  const violations: InvalidValueViolation[] = [];
  edits.forEach((raw, index) => {
    const item = asCanonicalObject(raw);
    const target = item?.["target"];
    if (item === undefined || item["intent"] !== undefined || typeof target !== "string" || target === "all") return;
    const suggestion = nearestAllowedValue(target, ["all"]);
    violations.push({
      field: `edits[${index}].target`,
      structPath: "tl_edit_file.edits[].target",
      expected: "one of \"all\" (or omit it to replace exactly the one match)",
      allowed: ["all"],
      ...(suggestion !== undefined ? { didYouMean: suggestion } : {}),
    });
  });
  return violations;
}

/** Stable order by `edits[N]` item index, so a batch's refusal names its first bad item first. */
export function sortByEditItem(violations: InvalidValueViolation[]): InvalidValueViolation[] {
  const indexOf = (violation: InvalidValueViolation): number => {
    const match = /^edits\[(\d+)\]/.exec(violation.field);
    return match === null ? -1 : Number(match[1]);
  };
  return violations
    .map((violation, order) => ({ violation, order }))
    .sort((a, b) => indexOf(a.violation) - indexOf(b.violation) || a.order - b.order)
    .map(({ violation }) => violation);
}

/**
 * The dependent fields of a canonical `edits[]` item (P1, 2026-10-10 review).
 * Value-level checks the schema cannot state:
 *  - `precondition:"scope-handle"` names its scope in `scopeHandle`; without
 *    one this used to refuse `scope-violation` with `retry:"new-task"`, a
 *    task reset for a missing argument;
 *  - `expectedSha` guards an EXISTING file's bytes, so on a `create:true`
 *    item it guarded nothing and was ignored while the file was created;
 *  - `target:"all"` (every match) contradicts `precondition:"unique-match"`
 *    (exactly one) — the batch path refused this already; the shared check
 *    now covers every item shape the same way.
 */
export function editItemDependencyRefusal(input: Record<string, unknown>): Record<string, unknown> | undefined {
  const edits = input["edits"];
  if (!Array.isArray(edits)) return undefined;
  const refuse = (index: number, field: string, error: string): Record<string, unknown> => ({
    ok: false,
    code: "invalid-input",
    field: `edits[${index}].${field}`,
    retry: "call",
    failed_item: { index },
    error,
  });
  for (const [index, raw] of edits.entries()) {
    const item = asCanonicalObject(raw);
    if (item === undefined) continue;
    const scopeHandle = item["scopeHandle"];
    if (item["precondition"] === "scope-handle" && (typeof scopeHandle !== "string" || scopeHandle === "")) {
      return refuse(index, "scopeHandle", `edits[${index}] precondition:"scope-handle" needs scopeHandle=<a handle id this session already holds> naming the scope the edit must stay inside`);
    }
    if (item["create"] === true && item["expectedSha"] !== undefined && item["expectedSha"] !== null) {
      return refuse(index, "expectedSha", `edits[${index}] expectedSha guards an existing file's current content, and a create:true item names a new file — drop expectedSha, or drop create to edit the existing file under that guard`);
    }
    if (item["target"] === "all" && item["precondition"] === "unique-match") {
      return refuse(index, "precondition", `edits[${index}] carries both target:"all" (replace every occurrence) and precondition:"unique-match" (require exactly one) — these are contradictory; drop one and retry`);
    }
  }
  return undefined;
}

/** Canonical-only projection of the caller's own input, minus call scoping. */
export function canonicalOriginalReadInput(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of CANONICAL_READ_INPUT_KEYS) {
    if (key === "budget") continue;
    if (raw[key] !== undefined) out[key] = raw[key];
  }
  return out;
}

/**
 * Stage the read request THIS call is serving, so `emit.ts`'s tail can settle
 * D and mint the continuation cursor.
 *
 * Called from the SERVE sites, which are the only places that know the file's
 * sha, its real line count and the window the caller actually asked for. A
 * no-op when there is no protocol call context (direct unit-test use) or when
 * the request is unaddressable. When a request is ALREADY staged — a RESUMED
 * cursor call staged its own on the way in, or an EARLIER target in the SAME
 * multi-target `paths[]`/`targets[]` batch already opened one — this appends
 * the new target to it (`appendReadRequestTarget`, idempotent per path)
 * instead of no-op'ing, so a multi-target request's Q spans every target the
 * batch loop visits, not just the first (DESIGN-v0.15 §5.1).
 */
/**
 * `stageReadRequestForServe` for a whole-file (`content:"full"`) serve.
 *
 * A thin wrapper so `buildFullServePayload` — which has no `args` of its own —
 * stays a payload builder. Reads the inbound arguments off the per-call
 * protocol context, which is the same source every family projector uses to
 * synthesise a continuation from what the caller actually asked for.
 */
export function stageFullReadRequest(
  workspace: string,
  filePath: string,
  content: string,
  fileSha: string,
  keepComments: boolean,
  /**
   * TL-REVIEW-2 (2026-10-06): the comment windows THIS serve's representation
   * elides (the renderer's own `elided`), excluded from Q — disclosed as
   * `elided`, never owed. Only a serve that actually elides passes it
   * (`buildFullServePayload`); the governed W1 head ships raw lines and keeps
   * the whole file as its Q.
   */
  policyElided: ReadonlyArray<readonly [number, number]> = [],
): void {
  const context = protocolCallContext();
  if (context === undefined || context.args === undefined) return;
  const totalLines = countLines(content);
  if (totalLines <= 0) return;
  const elided = keepComments ? [] : policyElided.map(([start, end]) => ({ start, end }));
  const requested = (keepComments ? [[1, totalLines] as [number, number]] : spansExcludingWindows(1, totalLines, policyElided))
    .map(([start, end]) => ({ start, end }));
  if (requested.length === 0) return;
  stageReadRequestForServe({
    workspace,
    relPath: filePath,
    fileSha,
    totalLines,
    requested,
    content: "full",
    keepComments,
    args: context.args as Record<string, unknown>,
    elided,
  });
}

/**
 * mode=auto's small-file threshold: a whole-file `auto` read of a file under
 * it is served as content (the tiny-file and small-file branches), anything
 * larger as an outline or a query-ranked window.
 */
export const AUTO_SMALL_FILE_BYTES = 8192;

/**
 * 2026-10-20 (decision run 6t-7, T07 rep1 #5): does a whole-file `auto` read
 * of `relPath` come back as the file's content (state/session.ts
 * `FenceReadView.servesWholeFileContent`)? A text file under
 * `AUTO_SMALL_FILE_BYTES`; an artifact (csv, office, pdf) has its own route.
 * Read-only: one stat.
 */
export function autoReadServesFileContent(workspace: string, relPath: string): boolean {
  if ((ARTIFACT_EXTS as readonly string[]).some((ext) => relPath.toLowerCase().endsWith(ext))) return false;
  try {
    const abs = safeResolve(relPath, workspace);
    if (abs === undefined) return false;
    const real = realpathSync(abs);
    if (!isWithin(real, resolveReal(workspace))) return false;
    const stat = statSync(real);
    return stat.isFile() && stat.size < AUTO_SMALL_FILE_BYTES;
  } catch {
    return false;
  }
}

/**
 * 2026-10-19 (the loop brake's elision gap): the probe `guardExecutionDiscovery`
 * hands its held check (state/session.ts `RequestElisionProbe`). It answers
 * which comment windows THIS request's own rendering elides inside a requested
 * window — the same rendering the slice door gives it (`namedWindows`: the
 * caller named the window, so `elideDocCommentsForExplicitWindow`) — reading
 * the file from disk and only while the file still has the ledger's sha.
 * `undefined` for a request that keeps comments (nothing is elided), an
 * unreadable or oversized file, or moved content.
 */
export function requestElisionProbe(
  workspace: string,
  keepComments: boolean,
  namedWindows: boolean,
): RequestElisionProbe | undefined {
  if (keepComments) return undefined;
  return (relPath, sha, start, end) => {
    let text: string;
    try {
      const abs = safeResolve(relPath, workspace);
      if (abs === undefined) return undefined;
      const real = realpathSync(abs);
      if (!isWithin(real, resolveReal(workspace))) return undefined;
      if (statSync(real).size > STALE_RANGE_PROBE_MAX_BYTES) return undefined;
      // served-bytes: not-served (loop-brake held check: which comment windows the request's own rendering elides; nothing read is sent)
      text = readFileSync(real, "utf8");
    } catch {
      return undefined;
    }
    if (shaOfText(text) !== sha) return undefined;
    const totalLines = countLines(text);
    const first = Math.max(1, start);
    const last = Math.min(totalLines, end);
    if (first > last) return undefined;
    const windowText = text.split(/\r?\n/).slice(first - 1, last).join("\n");
    return namedWindows
      ? elideDocCommentsForExplicitWindow(windowText, languageForPath(relPath), first, totalLines).elided
      : elideDocCommentsForDisplay(windowText, languageForPath(relPath), false, first).elided;
  };
}

/** The csv/tsv path and kind this canonical target and `select` ask for, when `select.kind` agrees with the file's extension. */
export function csvQueryWindowTarget(target: Record<string, unknown>, select: unknown): { path: string; kind: "csv" | "tsv" } | undefined {
  const path = target["path"];
  const kind = select !== null && typeof select === "object" ? (select as Record<string, unknown>)["kind"] : undefined;
  if (typeof path !== "string" || (kind !== "csv" && kind !== "tsv")) return undefined;
  if (!path.toLowerCase().endsWith(`.${kind}`)) return undefined;
  for (const selector of ["range", "ranges", "symbol", "handle"]) if (target[selector] !== undefined) return undefined;
  return { path, kind };
}

/**
 * DESIGN-v0.15 §6.2 (R4) — the parent-full-request exception, for every
 * `servedContentReceipt` call site.
 *
 * A `code-unchanged` receipt normally ends the request it answers with no
 * `next` at all (§3.3's "既読通知の終端": the caller's OWN window is
 * satisfied, and "the rest of the FILE is unread" is `summary.unserved`'s
 * business, never a reason for a `next`). The one exception is a page — by
 * cursor, or by an ordinary explicit range/symbol read that happens to land
 * on it — of a still-open full/range/batch read request for the SAME path:
 * that request's own continuation duty survives this call, so the receipt
 * must still carry it forward while D ≠ ∅.
 *
 * `relPath`/`fileSha` name what THIS call just confirmed held; `servedWindows`
 * is the EXACT window(s) (1-based, file line coordinates) this call confirmed
 * for that path — finding 8: without it, `openParentReadRequest` had nothing
 * to test the confirmed window against, so ANY read of the same (path, sha)
 * attached the parent's cursor, including one that never asked about the
 * parent's own pages (e.g. an unrelated symbol elsewhere in the file). `args`
 * is the inbound request this call arrived with, the same source
 * `stageReadRequestForServe` reads lane/task/cwd binding from. Returns
 * `undefined` when no open parent claims this exact window — the ordinary,
 * independent-read case — never a fabricated continuation.
 */
export function openParentReceiptContinuation(
  workspace: string,
  relPath: string,
  fileSha: string,
  args: Record<string, unknown>,
  servedWindows: readonly LineWindow[],
): ToolCall | undefined {
  const lane = currentSessionLane();
  const taskHandle = typeof args["task_handle"] === "string" ? args["task_handle"] : undefined;
  const cwd = typeof args["cwd"] === "string" ? args["cwd"] : undefined;
  const binding = { ...(lane !== "" ? { lane } : {}), ...(taskHandle !== undefined ? { taskHandle } : {}) };
  const staged = openParentReadRequest(workspace, relPath, fileSha, binding, {
    ...(cwd !== undefined ? { cwd } : {}),
    ...(lane !== "" ? { lane } : {}),
    ...(taskHandle !== undefined ? { taskHandle } : {}),
  }, servedWindows);
  if (staged === undefined) return undefined;
  const cursor = mintReadCursor(staged);
  return cursor === undefined ? undefined : readRequestCursorCall(staged, cursor);
}

/**
 * EFF (TL_EFF_LENIENT_EDIT, default OFF). The paths of this edit call whose
 * every item is a plain path-addressed `search`/`replace` whose exact `search`
 * text occurs exactly once on disk right now. The execution gate admits such
 * a path even when this session was never served its bytes: one verbatim
 * match of the caller's own text is proof it holds the current text it
 * rewrites (the precedent is the `single-site-unique-match` fast path). An
 * address this session emitted and WITHHELD still refuses — see
 * guardExecutionEditCore.
 */
export function uniqueExactMatchPaths(workspace: string, args: Record<string, unknown>): Set<string> {
  const items: Array<Record<string, unknown>> = Array.isArray(args["edits"])
    ? (args["edits"] as unknown[]).filter(
      (edit): edit is Record<string, unknown> => edit !== null && typeof edit === "object" && !Array.isArray(edit),
    )
    : [args];
  const verdict = new Map<string, boolean>();
  for (const item of items) {
    const rel = item["path"];
    if (typeof rel !== "string" || rel === "") continue;
    const search = item["search"];
    const plain = typeof search === "string" && search.length > 0 && typeof item["replace"] === "string"
      && item["create"] === undefined && item["range"] === undefined && item["target"] === undefined
      && item["handle"] === undefined;
    if (!plain) {
      verdict.set(rel, false);
      continue;
    }
    if (verdict.get(rel) === false) continue;
    const abs = safeResolve(rel, workspace);
    let text: string | undefined;
    try {
      // served-bytes: not-served (TL_EFF_LENIENT_EDIT only counts the caller's search text here; nothing read is sent)
      text = abs !== undefined ? readFileSync(abs, "utf8") : undefined;
    } catch {
      text = undefined;
    }
    const first = text === undefined ? -1 : text.indexOf(search);
    verdict.set(rel, first !== -1 && text!.indexOf(search, first + 1) === -1);
  }
  return new Set([...verdict].filter(([, unique]) => unique).map(([rel]) => rel));
}

/**
 * EFF (TL_EFF_LENIENT_EDIT, default OFF). The native Edit tool's argument
 * names map to the canonical edit item when the mapping is total and
 * unambiguous: a top-level `{file_path, old_string, new_string[, replace_all]}`
 * becomes `edits:[{path, search, replace, precondition:"unique-match"}]`
 * (`target:"all"` in place of the precondition for `replace_all:true`), and
 * inside `edits[]` `file_path`/`old_string`/`new_string` and Codex's
 * `oldText`/`newText` become `path`/`search`/`replace`. A name whose canonical
 * twin is also present is left as is, so the unknown-argument refusal still
 * names it.
 */
export function lenientEditAliases(input: Record<string, unknown>): Record<string, unknown> {
  const aliases: ReadonlyArray<readonly [string, string]> = [
    ["file_path", "path"], ["old_string", "search"], ["new_string", "replace"],
    ["oldText", "search"], ["newText", "replace"],
  ];
  const renameItem = (item: Record<string, unknown>): Record<string, unknown> => {
    const out = { ...item };
    for (const [from, to] of aliases) {
      if (out[from] !== undefined && out[to] === undefined) {
        out[to] = out[from];
        delete out[from];
      }
    }
    if (out["replace_all"] === true && out["target"] === undefined && out["precondition"] === undefined) {
      delete out["replace_all"];
      out["target"] = "all";
    } else if (out["replace_all"] === false) {
      delete out["replace_all"];
    }
    return out;
  };
  if (Array.isArray(input["edits"])) {
    return {
      ...input,
      edits: input["edits"].map((value) => {
        const item = asCanonicalObject(value);
        return item === undefined ? value : renameItem(item);
      }),
    };
  }
  const replaceAll = input["replace_all"];
  if (
    typeof input["file_path"] === "string" && typeof input["old_string"] === "string"
    && typeof input["new_string"] === "string" && input["edits"] === undefined
    && (replaceAll === undefined || typeof replaceAll === "boolean")
  ) {
    const { file_path: path, old_string: search, new_string: replace, replace_all: _replaceAll, ...rest } = input;
    const item: Record<string, unknown> = replaceAll === true
      ? { path, search, replace, target: "all" }
      : { path, search, replace, precondition: "unique-match" };
    return { ...rest, edits: [item] };
  }
  return input;
}

/**
 * EFF (TL_EFF_TOLERANT_INPUT, default OFF). Near-miss shapes the h2 windows
 * saw refused are rewritten to the call the solver then sent:
 *   - a one-element `ranges` on a target of a multi-target tl_read_file batch
 *     (refused "ranges[] on one target of a multi-handle batch") becomes that
 *     target's `range`; the batch reads exactly the same windows. Since
 *     2026-10-20 the projection splits any per-target `ranges[]` of a
 *     query-less multi-target read with or without this flag
 *     (`expandMultiTargetRanges`); this rewrite still gives the query
 *     branch the same one-window shape;
 *   - a legacy `task.taskProfile` (no `task.profile` beside it) becomes
 *     `task.profile`;
 *   - tl_edit_file's `task.profile` is dropped (see below);
 *   - 2026-10-17 (Copilot CLI simple bench, DESIGN-v0.14-plan §20.10): a key
 *     padded with whitespace (`"\treplace"`) is the key it pads, and a task
 *     handle sent as `task.epoch` is `task.handle` (the evidence handle the
 *     model put in `task.handle` beside it rides the call's own items).
 */
export function tolerateNearMissInput(canonical: string, input: Record<string, unknown>): Record<string, unknown> {
  let out = trimPaddedKeys(input);
  for (const field of ["targets", "edits"]) {
    const items = out[field];
    if (!Array.isArray(items)) continue;
    const trimmed = items.map((value) => {
      const item = asCanonicalObject(value);
      if (item === undefined) return value;
      const normalized = trimPaddedKeys(item);
      return canonical === "tl_edit_file" && field === "edits"
        ? canonicalEditReplacementAlias(item, normalized)
        : normalized;
    });
    if (trimmed.some((item, i) => item !== items[i])) out = { ...out, [field]: trimmed };
  }
  const padded = asCanonicalObject(out["task"]);
  if (padded !== undefined) {
    const trimmedTask = trimPaddedKeys(padded);
    if (trimmedTask !== padded) out = { ...out, task: trimmedTask };
  }
  input = out;
  const targets = input["targets"];
  if (canonical === "tl_read_file" && Array.isArray(targets) && targets.length > 1) {
    let changed = false;
    const mapped = targets.map((value) => {
      const target = asCanonicalObject(value);
      if (target === undefined || target["range"] !== undefined) return value;
      const ranges = target["ranges"];
      if (!Array.isArray(ranges) || ranges.length !== 1 || typeof ranges[0] !== "string") return value;
      changed = true;
      const { ranges: _ranges, ...rest } = target;
      return { ...rest, range: ranges[0] };
    });
    if (changed) out = { ...out, targets: mapped };
  }
  const task = asCanonicalObject(input["task"]);
  if (task !== undefined) {
    let next = withLegacyTaskProfileRenamed(task);
    // `task: {epoch: "tlh_task_v1_…", handle: "h…"}` (Copilot CLI E1): the
    // only value `epoch` takes is "new", so a task handle there names the task
    // to continue. Swapped back only when `handle` is absent or is an item
    // handle this same call already sends, so no value is lost.
    const epoch = next["epoch"];
    if (typeof epoch === "string" && epoch.startsWith("tlh_task_")) {
      const misplaced = next["handle"];
      const itemHandles = new Set(["targets", "edits"].flatMap((field) => {
        const items = input[field];
        return Array.isArray(items) ? items.map((value) => asCanonicalObject(value)?.["handle"]).filter((h): h is string => typeof h === "string") : [];
      }));
      if (misplaced === undefined || (typeof misplaced === "string" && !misplaced.startsWith("tlh_task_") && itemHandles.has(misplaced))) {
        const { epoch: taskHandle, handle: _misplaced, ...rest } = next;
        next = { ...rest, handle: taskHandle };
      }
    }
    // tl_edit_file advertises task.profile, but its legacy dispatcher has no
    // `taskProfile` argument and refuses the projected name as unknown (h2
    // T07 rep2, sent as the JSON string '{"profile":"generic"}'). The profile
    // is a read-side discovery hint that changes nothing an edit writes, so
    // under the flag it is dropped rather than refused.
    if (canonical === "tl_edit_file" && next["profile"] !== undefined) {
      const { profile: _profile, ...rest } = next;
      next = rest;
    }
    if (next !== task) out = { ...out, task: next };
  }
  if (canonical === "tl_edit_file" && Array.isArray(out["edits"])) {
    let changed = false;
    const edits = out["edits"].map((value) => {
      const item = asCanonicalObject(value);
      if (item === undefined || item["match"] !== "unique-match" || Object.hasOwn(item, "precondition")
        || Object.keys(item).some(key => key !== "match" && key.trim() === "match")) return value;
      const {match: _match, ...rest} = item;
      changed = true;
      return {...rest, precondition: "unique-match"};
    });
    if (changed) out = {...out, edits};
  }
  return out;
}

/** `record` with each whitespace-padded key renamed to its trimmed spelling, unless that key is already present. */
export function trimPaddedKeys(record: Record<string, unknown>): Record<string, unknown> {
  let out: Record<string, unknown> | undefined;
  for (const key of Object.keys(record)) {
    const trimmed = key.trim();
    if (trimmed === key || trimmed.length === 0 || Object.hasOwn(record, trimmed)) continue;
    out ??= { ...record };
    out[trimmed] = out[key];
    delete out[key];
  }
  return out ?? record;
}

/** After key trimming, rename only a sole original `replacement` key with no `replace` spelling. */
export function canonicalEditReplacementAlias(original: Record<string, unknown>, item: Record<string, unknown>): Record<string, unknown> {
  const originalKeys = Object.keys(original);
  const aliasKeys = originalKeys.filter((key) => key.trim() === "replacement");
  if (aliasKeys.length === 0) return item;
  if (aliasKeys.length !== 1 || originalKeys.some((key) => key.trim() === "replace") ||
      (aliasKeys[0] !== "replacement" && !/^[\t\n\v\f\r ]*replacement[\t\n\v\f\r ]*$/.test(aliasKeys[0]!))) return original;
  if (!Object.hasOwn(item, "replacement") || Object.hasOwn(item, "replace")) return item;
  const { replacement, ...rest } = item;
  return { ...rest, replace: replacement };
}

/**
 * Legacy members a canonical object field may carry, parsed out of a
 * stringified carrier like any other member (canonicalDialectRescue.ts) and
 * then normalized or refused by the code that handles a native one:
 * `task.taskProfile` is the legacy spelling of `task.profile` (see
 * `legacyTaskProfileRefusal`).
 */
export const CANONICAL_LEGACY_MEMBERS: Readonly<Record<string, readonly string[]>> = { task: ["taskProfile"] };

/** `task` with a legacy `taskProfile` (no `profile` beside it) renamed to `profile`; `task` itself otherwise. */
export function withLegacyTaskProfileRenamed(task: Record<string, unknown>): Record<string, unknown> {
  if (task["taskProfile"] === undefined || task["profile"] !== undefined) return task;
  const { taskProfile, ...rest } = task;
  return { ...rest, profile: taskProfile };
}

/**
 * `TL_LEGACY_INPUT=accept` takes the legacy flat `taskProfile` on the read
 * tools, so the same name inside `task` is renamed to the `task.profile` it
 * stands for there too (TL_EFF_TOLERANT_INPUT, when on, already renamed it in
 * `tolerateNearMissInput`). tl_edit_file has no legacy `taskProfile`, so its
 * `task.taskProfile` is left to `legacyTaskProfileRefusal`.
 */
export function acceptLegacyTaskProfile(canonical: string, input: Record<string, unknown>): Record<string, unknown> {
  if (canonical === "tl_edit_file" || process.env["TL_LEGACY_INPUT"] !== "accept") return input;
  const task = asCanonicalObject(input["task"]);
  if (task === undefined) return input;
  const renamed = withLegacyTaskProfileRenamed(task);
  return renamed === task ? input : { ...input, task: renamed };
}

/**
 * 2026-10-20 (v016 decision 6t-7, T13 rep1 arm A #9): `ranges` is advertised
 * per target, but a query-less multi-target read had no slot for several
 * windows of ONE target. The all-handle batch refused the whole call
 * ("ranges[] on one target of a multi-handle batch is not supported"), and a
 * path batch carrying one took the task_pack route (`windowedBatchBytes`
 * takes one `range` per entry), so the refusal's own `next` came back as a
 * pack under a new task. The solver re-sent the same windows as four
 * single-range targets and got the `read.batch` it had asked for.
 *
 * Each target with a non-empty `ranges` of non-empty strings becomes one
 * target per window, in order, with the same handle/path and every other
 * field — the split `mapTaskPackPaths` already makes for the task_pack route.
 * Only a call of two or more targets: a single target's `ranges[]` stays the
 * one mode=slice read it is today. A target that also names `range`, or whose
 * `ranges` holds anything else, is left as sent (the A7 loop still refuses it
 * there rather than serve a stored range in its place). Returns `targets`
 * itself when nothing was expanded.
 */
export function expandMultiTargetRanges(targets: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  if (targets.length < 2) return targets;
  let expanded = false;
  const windows = targets.flatMap((target) => {
    const ranges = target["ranges"];
    if (target["range"] !== undefined || !Array.isArray(ranges) || ranges.length === 0) return [target];
    if (!ranges.every((range): range is string => typeof range === "string" && range !== "")) return [target];
    expanded = true;
    const { ranges: _ranges, ...rest } = target;
    return ranges.map((range) => ({ ...rest, range }));
  });
  return expanded ? windows : targets;
}
