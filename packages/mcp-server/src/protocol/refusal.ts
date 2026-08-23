// ---------------------------------------------------------------------------
// protocol v1 — the ONE refusal shape (C2-2).
//
// NORMATIVE SOURCE: DESIGN-v0.10 §2.6 (the refusal family, the
// `unlock`/`terminal`/`terminal_reason` -> `retry` + `code` collapse, and the
// abolition of placeholder-bearing `next` calls), §2.5 (D6), and §10.3
// Appendix A (Revision 4) A.5.15, A.7.1, A.9.2 rows 1/4/6/23.
//
// `Refusal` HAS NO `error` FIELD (A.5.15). Machine tokens that ride `error`
// today split into `code` (the token) and `detail` (the prose) — A.9.2 row 6.
//
// PROGRESSIVITY IS PRESERVED AND IS NOW TYPED. §2.6's table maps today's four
// co-varying fields onto one enum:
//
//   retry:"call"       fix the named argument and re-issue
//   retry:"challenge"  attach a `challenge` and re-issue the same call
//   retry:"new-task"   different task; re-pack a new epoch
//   retry:"user-input" the server cannot proceed without a human choice
//   retry:"none"       no transition on THIS call shape is sanctioned
//
// `retry:"none"` is NOT "there is nothing you can do": §2.6 makes the fresh
// `taskEpoch` re-pack a STANDING rule that needs no per-refusal sanction, which
// is exactly what lets `unlock` + `terminal` + `terminal_reason` collapse
// without losing the escape hatch.
// ---------------------------------------------------------------------------

import type { Refusal, RefusalCode, RetryTransition, ToolCall, ToolName } from "@tokenlighten/types";

import {
  carryDisclosures,
  REFUSAL_DISCLOSURE_POLICY,
  WORKSPACE_DISCLOSURE_KEYS,
} from "./disclosure.js";
import { PROTOCOL_VERSION } from "./envelope.js";

// ---------------------------------------------------------------------------
// The emitted-`ToolCall` gate (A.9.4 / TC-2)
// ---------------------------------------------------------------------------

export type ToolCallValidator = (call: ToolCall) => boolean;

let _validator: ToolCallValidator | undefined;

/**
 * `server.ts` injects the SAME request-shape validator inbound requests get.
 * Injected rather than imported so `protocol/*` never imports `server.ts` (the
 * advertised schema lives there, and the cycle would be real).
 *
 * A.9.4: `ToolCall.arguments` is open at the type level and closed by TC-2.
 * This registry is the runtime half of that closure — a call this server cannot
 * validate is never emitted.
 */
export function setEmittedToolCallValidator(validator: ToolCallValidator): void {
  _validator = validator;
}

/** True iff `call` passes the server's own inbound request-shape validator. */
export function emittedToolCallIsValid(call: ToolCall): boolean {
  return _validator === undefined ? true : _validator(call);
}

/**
 * §2.6: "A `next` is either fully executable or it is not emitted." A
 * placeholder-bearing call is not executable — a caller that runs it verbatim
 * sends `<exact text to replace>` as real bytes, the exact defect
 * `next_call_is_template` used to MARK rather than remove.
 */
export function containsPlaceholder(value: unknown): boolean {
  if (typeof value === "string") return /<[^<>]{3,}>/u.test(value);
  if (Array.isArray(value)) return value.some(containsPlaceholder);
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(containsPlaceholder);
  }
  return false;
}

const TOOL_NAMES: ReadonlySet<string> = new Set(["read_file", "edit_file", "search_files"]);

/**
 * Coerce a value that claims to be a call into an EMITTABLE `ToolCall`, or
 * `undefined`. Three gates, all of which must pass: structural shape, no
 * placeholder (§2.6), and the server's own request-shape validator (TC-2).
 */
export function emittableToolCall(value: unknown): ToolCall | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as { tool?: unknown; arguments?: unknown };
  if (typeof record.tool !== "string" || !TOOL_NAMES.has(record.tool)) return undefined;
  if (record.arguments === null || typeof record.arguments !== "object" || Array.isArray(record.arguments)) {
    return undefined;
  }
  const call = { tool: record.tool as ToolName, arguments: record.arguments as ToolCall["arguments"] };
  if (containsPlaceholder(call.arguments)) return undefined;
  return emittedToolCallIsValid(call) ? call : undefined;
}

/**
 * Parse the prose call form this tree emits today (`read_file mode=slice
 * handle=h1 range=1-40`) into a `ToolCall`. STRICT and fail-closed: anything
 * this cannot parse exactly returns `undefined` and the prose is kept as
 * `detail` instead, so a refusal never trades a readable sentence for an
 * unexecutable call.
 *
 * Why parse at all: ~70 `toolError()` sites carry a prose `next` that is the
 * only thing standing between a refusal and the dead-end class the 2026-07-16a
 * forensics named (`refusal_without_next`). §2.6 requires `next` to be a
 * `ToolCall`; dropping every prose call instead of parsing the well-formed ones
 * would re-open that class on the day v1 ships.
 */
export function parseProseToolCall(text: string): ToolCall | undefined {
  const trimmed = text.trim();
  const space = trimmed.indexOf(" ");
  const tool = space === -1 ? trimmed : trimmed.slice(0, space);
  if (!TOOL_NAMES.has(tool)) return undefined;
  const rest = space === -1 ? "" : trimmed.slice(space + 1).trim();

  const args: Record<string, unknown> = {};
  let cursor = 0;
  while (cursor < rest.length) {
    while (cursor < rest.length && rest[cursor] === " ") cursor++;
    if (cursor >= rest.length) break;
    const equals = rest.indexOf("=", cursor);
    if (equals === -1) return undefined;
    const key = rest.slice(cursor, equals);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) return undefined;
    cursor = equals + 1;
    if (cursor >= rest.length) return undefined;

    const first = rest[cursor];
    let raw: string;
    if (first === "\"" || first === "[" || first === "{") {
      const end = scanJsonToken(rest, cursor);
      if (end === -1) return undefined;
      raw = rest.slice(cursor, end);
      cursor = end;
      try {
        args[key] = JSON.parse(raw) as unknown;
      } catch {
        return undefined;
      }
    } else {
      let end = cursor;
      while (end < rest.length && rest[end] !== " ") end++;
      raw = rest.slice(cursor, end);
      cursor = end;
      if (raw === "") return undefined;
      args[key] = raw === "true" ? true : raw === "false" ? false : raw;
    }
  }
  if (Object.keys(args).length === 0) return undefined;
  return emittableToolCall({ tool, arguments: args });
}

/** End index (exclusive) of the JSON token starting at `start`, or -1. */
function scanJsonToken(text: string, start: number): number {
  const open = text[start];
  if (open === "\"") {
    let index = start + 1;
    while (index < text.length) {
      if (text[index] === "\\") { index += 2; continue; }
      if (text[index] === "\"") return index + 1;
      index++;
    }
    return -1;
  }
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (char === "\\") { index++; continue; }
      if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") { inString = true; continue; }
    if (char === open) depth++;
    else if (char === close) {
      depth--;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Is this body a refusal?
// ---------------------------------------------------------------------------

/**
 * D6: the outcome is `kind`, so "was this refused?" is answered ONCE. Until
 * C2-3/C2-4/C2-5 reshape the bodies, the two legacy signals still have to be
 * read — and they are read TOGETHER, which is precisely the §2.5 disagreement
 * being closed: `{ok:false}` returned through `toolOk` (no `isError`) and
 * `{ok:false}` returned through `toolStructuredError` (`isError:true`) are the
 * same outcome and become the same `kind`.
 */
export function isRefusalBody(body: Record<string, unknown>, isError: boolean): boolean {
  return isError || body["ok"] === false;
}

// ---------------------------------------------------------------------------
// A.7.1 `RefusalCode` assignment
// ---------------------------------------------------------------------------

/**
 * Every value of A.7.1's ten sub-unions, as a runtime set. A code that is not a
 * member is never emitted: `Refusal.code` is a CLOSED enum and a made-up value
 * would defeat the exhaustive-switch guarantee A.7.1 exists to give.
 *
 * Kept as a literal set rather than derived from the type because TypeScript
 * unions do not survive to runtime, and TC-2 needs to check membership.
 *
 * MIRROR DUTY. This set and `protocol.ts`'s ten sub-unions are the same enum
 * written twice; the `Set<RefusalCode>` annotation makes `tsc` reject a value
 * that is NOT in the type, but nothing makes it reject a value MISSING from
 * here. A missing member is silently coerced to `invalid-input` by
 * `refusalCodeOf`'s documented fallback below — which is exactly what happened
 * to both [R5-29] mints until they were added here. `refusalCodeParity.spec.ts`
 * closes the direction `tsc` cannot see.
 */
const REFUSAL_CODES: ReadonlySet<string> = new Set<RefusalCode>([
  // RequestShapeCode
  "unknown-arguments", "invalid-input", "invalid-cwd", "invalid-lane",
  "cwd-required-for-edit", "cwd-required-for-create", "workspace-boundary",
  "mixed-batch-workspace-ambiguous", "elided-content",
  // HandleCode
  "handle-unknown", "handle-workspace-missing", "handle-workspace-mismatch",
  "handle-required", "handle-required-lockdown", "directory-handle-unknown",
  "directory-handle-workspace-mismatch", "directory-handle-wrong-kind",
  // TypestateCode
  "execution-typestate", "prepared-discovery-closed", "discovery-loop-brake",
  "prescribed-step-executed-target-still-inadmissible", "create-target-not-servable",
  "create-target-exists", "repeated-all-served-find",
  // WriteCode
  "write-not-enabled", "hash-mismatch", "scope-violation", "out-of-scope",
  "blast-radius-precondition-required", "range-out-of-bounds", "range-invalid",
  "served-content-stale", "write-intent-ambiguous", "search-not-unique", "empty-search", "ambiguous",
  "not-found", "overlapping-ranges", "edits-item-missing-target", "edits-item-shape",
  "precondition-unsupported-for-batch", "write-error", "read-error", "index-error",
  "secret-file", "path-escape", "file-too-large", "path-outside-workspace",
  // IntentCode
  "intent-unknown", "intent-unsupported", "intent-lang-unsupported", "intent-ambiguous",
  "intent-no-duplicate-in-scope", "intent-incompatible-with-batch",
  "intent-requires-handle",
  // ReadLimitCode
  "symbol-cap-reached", "cap-exceeded", "per-task-cap-reached", "per-path-cap-reached",
  "candidate-pack-full-repeat", "tiny-task-cap-reached", "allowfull-task-cap-reached",
  "artifact-full-downgraded", "not-tiny", "broad-overview-query",
  "not-a-directory", "is-a-directory", "markdown-section-read-failed",
  "markdown-section-ambiguous", "markdown-section-not-found",
  // DocumentCode
  "not-a-document", "too-large", "corrupt", "not-a-zip", "part-too-large",
  "too-many-entries", "zip-bomb", "office-encryption-unsupported",
  "office-password-required", "office-password-invalid", "office-decrypted-too-large",
  "office-encrypted-too-large", "office-verification-failed", "pdf-encrypted",
  "pdf-password-invalid", "pdf-no-text-layer", "pdf-parse-failed", "pdf-edit-failed",
  "pdf-encryption-not-preserved", "pdf-form-not-found", "pdf-verification-failed",
  // ArchiveCode
  "archive-not-found", "archive-unsupported", "archive-corrupt", "archive-encrypted",
  "archive-password-invalid", "archive-encryption-unsupported", "archive-too-large",
  "archive-too-many-entries", "archive-bomb", "archive-unsafe-path",
  "archive-entry-not-found", "archive-entry-binary", "archive-read-only-container",
  "archive-member-read-only", "archive-duplicate-member", "archive-entry-limit",
  "archive-expanded-too-large", "archive-member-exists", "archive-member-not-found",
  "archive-member-path-invalid", "archive-member-too-large", "archive-password-required",
  "archive-read-error", "archive-verification-failed", "archive-write-failed",
  // ArtifactCode
  "artifact-edit-required", "artifact-edit-incompatible-arguments",
  "artifact-precondition-unsupported", "artifact-edit-invalid",
  "artifact-edit-too-many-mutations", "artifact-kind-mismatch",
  "artifact-output-too-large", "artifact-search-not-found", "artifact-search-not-unique",
  "artifact-too-large", "xlsx-edit-failed", "xlsx-edit-unavailable", "xlsx-sheet-not-found",
  // CredentialCode
  "credential-ref-invalid", "credential-not-found", "credential-invalid",
]);

/** True iff `value` is a member of the closed A.7.1 enum. */
export function isRefusalCode(value: unknown): value is RefusalCode {
  return typeof value === "string" && REFUSAL_CODES.has(value);
}

/**
 * C2-6: MESSAGE_CODES / codeFromMessage (the prose -> code regex derivation)
 * is RETIRED. Every one of the 73 sites A.9.2 row 4 named now carries its
 * own explicit `code`/`reason`; the one remaining fallback (a genuinely
 * code-less body) is folded directly into `refusalCodeOf` below and
 * documented there — the single DOCUMENTED fallback the C2-6 work item's
 * own instructions call for, not a second derivation layer beside it.
 */

/**
 * A.7.1 `code`, resolved in the order the body itself makes authoritative:
 * `reason`, then `code`, then `terminal_reason` (§2.6: "`terminal_reason`
 * becomes `code`"), then the prose.
 *
 * `reason` BEFORE `code`, FIXED IN C2-5. The two are not competing spellings of
 * the same value; the emitters state the relationship outright:
 *
 *   "Machine-readable refusal tag for the shapes an agent is expected to BRANCH
 *    on… Additive alongside `code`, which keeps its HISTORICAL value for every
 *    pre-existing refusal (e.g. an out-of-bounds range stays
 *    `code:"invalid-input"` while gaining `reason:"range-out-of-bounds"`)"
 *    — `applyEditsMulti.ts`'s own union doc.
 *
 * So `code` is the COARSE, back-compatible tag and `reason` is the specific one,
 * and reading `code` first discarded the specific value whenever both were valid
 * A.7.1 members — a caller that branches on `range-out-of-bounds` got
 * `invalid-input` and had to parse prose to recover the difference. Both are
 * checked against the closed enum, so a `reason` that is prose (or an
 * out-of-enum token like `find-all-served-repeat`) still falls through to
 * `code`, and nothing that was resolvable before becomes unresolvable.
 */
export function refusalCodeOf(body: Record<string, unknown>): RefusalCode {
  if (isRefusalCode(body["reason"])) return body["reason"];
  if (isRefusalCode(body["code"])) return body["code"];
  if (isRefusalCode(body["terminal_reason"])) return body["terminal_reason"];
  // C2-6: the SINGLE documented fallback for a genuinely code-less body —
  // every real refusal site now names its own code (A.9.2 row 4), so this
  // is reached only by a site this sweep missed (a bug, not a class) or a
  // deliberately minimal test double. `detailOf` below still carries
  // whatever prose the body supplied (`error`/`detail`), so no information
  // is lost — only the derived code, which was never more than a guess
  // from wording.
  return "invalid-input";
}

// ---------------------------------------------------------------------------
// §2.6 `retry`
// ---------------------------------------------------------------------------

const RETRY_VALUES: ReadonlySet<string> = new Set<RetryTransition>([
  "call", "challenge", "new-task", "user-input", "none",
]);

/**
 * [R4-6] kebab normalisation, A.9.2 row 23: `new_task` -> `new-task`,
 * `user_input` -> `user-input`. It lands in THIS commit, with `Refusal`'s
 * `kind`/`v`, because a mixed-casing `retry` on a v1-announcing response is the
 * frozen inconsistency the rename exists to prevent.
 */
function normalizeRetry(value: unknown): RetryTransition | undefined {
  if (typeof value !== "string") return undefined;
  const kebab = value.replace(/_/gu, "-");
  return RETRY_VALUES.has(kebab) ? kebab as RetryTransition : undefined;
}

function routeUnlockAlternatives(body: Record<string, unknown>): void {
  const unlock = body["unlock"];
  if (unlock === null || typeof unlock !== "object" || Array.isArray(unlock)) return;
  const record = unlock as Record<string, unknown>;
  const transitions = record["accepted_transitions"];
  if (!Array.isArray(transitions) || transitions.length === 0) return;

  const existing = Array.isArray(body["alternatives"]) ? body["alternatives"] : [];
  const routed: unknown[] = [...existing];
  const seen = new Set(existing.map((entry) => JSON.stringify(entry)));
  const nextCall = body["next_call"];
  const nextArguments = nextCall !== null && typeof nextCall === "object"
    ? (nextCall as Record<string, unknown>)["arguments"]
    : undefined;
  const cwd = nextArguments !== null && typeof nextArguments === "object"
    && typeof (nextArguments as Record<string, unknown>)["cwd"] === "string"
    ? (nextArguments as Record<string, unknown>)["cwd"] as string
    : undefined;

  for (const transition of transitions) {
    let alternative: unknown = transition;
    if (transition === "taskEpoch:new") {
      alternative = {
        tool: "read_file",
        arguments: { mode: "task_pack", taskEpoch: "new", ...(cwd !== undefined ? { cwd } : {}) },
      };
    } else if (transition === "challenge" && record["challenge"] !== undefined) {
      alternative = { transition: "challenge", challenge: record["challenge"] };
    } else if (typeof transition === "string") {
      alternative = parseProseToolCall(transition) ?? transition;
    }
    const key = JSON.stringify(alternative);
    if (seen.has(key)) continue;
    seen.add(key);
    routed.push(alternative);
  }
  body["alternatives"] = routed;
}

function hasChallengeAffordance(body: Record<string, unknown>): boolean {
  if (body["challenge"] !== undefined && body["challenge"] !== null) return true;
  const unlock = body["unlock"];
  if (unlock === null || typeof unlock !== "object") return false;
  const record = unlock as Record<string, unknown>;
  if (record["challenge"] !== undefined && record["challenge"] !== null) return true;
  const transitions = record["accepted_transitions"];
  return Array.isArray(transitions)
    && transitions.some((entry) => typeof entry === "string" && entry.includes("challenge"));
}

/**
 * §2.6's exhaustive mapping, as an ordered ladder. The order encodes the
 * §2.6 rule that a SANCTIONED transition on THIS call shape outranks the
 * standing re-pack rule — `retry:"none"` is reserved for "no transition on this
 * call shape", not for "this refusal was final in some general sense".
 */
export function retryOf(body: Record<string, unknown>): RetryTransition {
  // §A.13 [R5-20]: `unlock` is deleted by the response projector. Preserve
  // every sanctioned transition through the existing advisory surface before
  // retry classification, turning executable spellings into ToolCalls.
  routeUnlockAlternatives(body);
  const declared = normalizeRetry(body["retry"]);
  if (declared !== undefined) return declared;

  // 1. `re-pack-new-epoch` / `query_mismatch` -> a different task. FIRST,
  //    because §2.6's table maps this `required_action` value directly and
  //    unconditionally: the caller asked a different question, so a challenge
  //    against THIS certificate is not a transition that helps, even when the
  //    payload also advertises one.
  if (body["required_action"] === "re-pack-new-epoch" || body["query_mismatch"] === true) {
    return "new-task";
  }

  // 2. A challenge the server will actually accept is a sanctioned transition.
  //    (`unlock.accepted_transitions` contains "challenge" -> "challenge".)
  if (hasChallengeAffordance(body)) return "challenge";

  // 3. `unlock-or-rescope` with no sanctioned challenge -> the re-pack half.
  //    §2.6's ONE genuine narrowing, flagged there rather than hidden: the
  //    value names two transitions and `retry` is single-valued, so the server
  //    names the one it sanctions NOW and the standing re-pack rule carries the
  //    other half.
  if (body["required_action"] === "unlock-or-rescope") return "new-task";

  // 4. `terminal:true` -> "none" (§2.6's table). Reached only after 1-3, so a
  //    terminal refusal that still sanctions a challenge keeps its challenge.
  if (body["terminal"] === true) return "none";

  // 5. The awaiting-input path.
  if (body["awaiting_input"] === true || body["phase"] === "awaiting-input") return "user-input";

  // 6. The prepared fence: discovery is closed and the caller must ACT, not
  //    call again. No transition on this call shape is sanctioned.
  if (body["discovery_closed"] === true || body["challenge_required"] === true) return "none";

  // 7. Default: fix the named argument and re-issue. This is what the ~70 bare
  //    `toolError` sites ("path is required", "edits must be an array") mean.
  return "call";
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

/** Longest `detail` a refusal carries; prose is shed first under budget (A.8 E-7). */
const DETAIL_MAX_CHARS = 400;

/**
 * A.9.2 row 6's test: is this string a MACHINE TOKEN rather than prose?
 *
 * Two disjoint recognisers, both needed:
 *  - a member of the closed A.7.1 enum — it has already become `code`;
 *  - a kebab/snake single word with no whitespace. `find-all-served-repeat`
 *    (`servedFindEscalation.ts:396`) is the measured case: it is the SECOND
 *    machine spelling of a fact the response also carries as
 *    `reason:"repeated-all-served-find"`, which is the value that becomes
 *    `code`. It is not in the enum, so the first recogniser alone would ship it
 *    as `detail` — a raw token presented to the caller as a sentence, which is
 *    exactly the split row 6 exists to complete.
 *
 * The `[-_]` is REQUIRED, so a genuine one-word sentence is never mistaken for
 * a token, and prose (which always contains whitespace) never matches either.
 */
function isMachineToken(value: string): boolean {
  return isRefusalCode(value) || /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/u.test(value);
}

function detailOf(body: Record<string, unknown>, nextEmitted: boolean): string | undefined {
  const detail = typeof body["detail"] === "string" ? body["detail"].trim() : "";
  const error = typeof body["error"] === "string" ? body["error"].trim() : "";
  const terminalReason = typeof body["terminal_reason"] === "string"
    ? body["terminal_reason"].trim()
    : "";
  const parts: string[] = [];
  if (detail !== "") parts.push(detail);
  // A.9.2 row 5: `terminal_reason` carries the PROSE half of a progressivity
  // refusal — "every file this query matches was already served to you this
  // session, and this is the 3rd such find under certificate …". §2.6 collapses
  // the field into `retry` + `code`, and `refusalCodeOf` already lifts the
  // value when it IS a code; when it is a sentence there is no `RefusalCode`
  // spelling of it, and dropping it (which is what this function did before
  // C2-4, because `terminal_reason` is deleted and was never read here) throws
  // away the entire explanation of a terminal stop.
  if (terminalReason !== "" && terminalReason !== detail && !isRefusalCode(terminalReason)) {
    parts.push(terminalReason);
  }
  // A.9.2 row 6: a machine token riding `error` has already become `code` (or
  // is a second spelling of the same verdict), so it must not be repeated as
  // prose.
  if (error !== "" && error !== detail && !isMachineToken(error)) parts.push(error);
  // …unless it is the ONLY signal the body carries. An out-of-enum token beats
  // an empty `detail`; an in-enum one is already `code` and stays deleted.
  if (parts.length === 0 && error !== "" && !isRefusalCode(error)) parts.push(error);
  // §2.3: when a prepared stop is reclassified to a refusal because the caller
  // asked a DIFFERENT question, "its `certified_query` disclosure survives on
  // the refusal". `Refusal` has no `certified_query` field, so the disclosure
  // rides `detail` — which is what the field is for, and it keeps the honesty
  // fix (defect C, 2026-08-13: the receipt knew its task and disclosed none of
  // it) from being silently undone by the reclassification.
  const certified = body["certified_query"];
  if (typeof certified === "string" && certified !== "") {
    parts.push(`certified query: ${certified}`);
  }
  // §2.6 requires `next` to be an executable `ToolCall`, so a prose `next` that
  // is NOT a parseable call cannot ride there. It must not simply vanish
  // either: those sentences are the recovery guidance the 2026-07-16a
  // `refusal_without_next` forensics added, and dropping them would re-open the
  // dead-end class under the freeze. They become `detail`, which is what a
  // prose field is for.
  const prose = body["next"];
  if (!nextEmitted && typeof prose === "string" && prose.trim() !== "") {
    parts.push(prose.trim());
  }
  const joined = parts.join(" — ");
  if (joined === "" || isRefusalCode(joined)) return undefined;
  return joined.length <= DETAIL_MAX_CHARS ? joined : `${joined.slice(0, DETAIL_MAX_CHARS - 1)}…`;
}

/** `Refusal.remaining` is a STRING (A.5.15); today's producers use several shapes. */
function remainingOf(body: Record<string, unknown>): string | undefined {
  const value = body["remaining"];
  if (typeof value === "string") return value.trim() === "" ? undefined : value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as { paths?: unknown; handles?: unknown };
  const parts: string[] = [];
  if (Array.isArray(record.paths) && record.paths.length > 0) {
    parts.push(`paths: ${record.paths.filter((entry) => typeof entry === "string").join(", ")}`);
  }
  if (Array.isArray(record.handles) && record.handles.length > 0) {
    parts.push(`handles: ${record.handles.filter((entry) => typeof entry === "string").join(", ")}`);
  }
  return parts.length > 0 ? parts.join("; ") : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.filter((item): item is string => typeof item === "string");
  return entries.length > 0 ? entries : undefined;
}

/**
 * Row 18 (C2-6): a producer that sets ONLY `unknown_edits_item_arguments`
 * (no top-level `fields`) still gets every violation named — flattened to
 * the same `edits[N].xxx` path-qualified spelling
 * `editFileUnknownArgumentRefusal` emits directly on its own `fields`.
 */
function flattenEditsItemArguments(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const index = (entry as { index?: unknown }).index;
    const args = (entry as { arguments?: unknown }).arguments;
    if (typeof index !== "number" || !Array.isArray(args)) continue;
    for (const arg of args) {
      if (typeof arg === "string") out.push(`edits[${index}].${arg}`);
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * The `next` a refusal may carry. §2.6: fully executable or absent. Three
 * sources in priority order, all three gated by `emittableToolCall`:
 * a structured `next_call`, a structured `next`, then the prose `next`.
 */
function nextOf(body: Record<string, unknown>): ToolCall | undefined {
  const structured = emittableToolCall(body["next_call"]) ?? emittableToolCall(body["next"]);
  if (structured !== undefined) return structured;
  const prose = body["next"];
  return typeof prose === "string" ? parseProseToolCall(prose) : undefined;
}

/**
 * DEVIATION FROM A.5.15, DECLARED — **Revision-5 candidate row.**
 *
 * A.5.15 closes `Refusal` at twelve fields and states it is "§2.6 with every
 * leaf now defined", but it has NO ADDRESS for the per-site recovery advisories
 * this tree already ships and the canonical guide already binds agents to.
 * Deleting them would be a silent capability removal on this server's own
 * authority (§0.2 forbids it; §1.4(d) prices it as breaking); carrying them is
 * additive and free (§1.4(a)) and reversible before publication.
 *
 * **THIS IS A CLOSED ALLOWLIST, NOT A DENYLIST — USER-ADJUDICATED 2026-08-13.**
 * Until this commit the passthrough was subtractive: every key not on a deleted
 * list rode the wire, so any field any emitter ever added to any refusal body
 * became part of the v1 contract by default. That is the opposite of the
 * closure §1.3.1 requires of the REQUEST side, and it makes "what does a
 * refusal carry?" unanswerable from the type. The enumeration below is the
 * whole set; a key not on it does not reach the wire, and adding one is a
 * deliberate edit here rather than a side effect somewhere else.
 *
 * **ADVISORY: NO CONSUMER DEPENDENCE; REMOVABLE IN A FUTURE MINOR.** Every
 * entry below is diagnostic or recovery guidance. A client MUST NOT branch on
 * one: the authoritative recovery contract is `code` + `retry` + `next`, and
 * these exist to make a human-or-agent recovery cheaper, not to be parsed.
 * They may be removed in a future minor version under §1.5's deprecation
 * procedure without that being a breaking change to the contract.
 *
 * Why each rides:
 *   `candidates`, `nearest_match`, `actual`, `expected_shapes` — the 2026-07-26
 *      verify-serving wave's per-item edit-recovery ledger. The guide's own
 *      rule: "Recovery is advisory and keeps `applied:false`;
 *      `candidate`=top-handle path; `expected_shapes`=accepted forms; if
 *      `nearest_match.out_of_range`, re-issue against a covering handle."
 *   `alternatives` — the read-side near-miss list (the office/full downgrade).
 *   `frontier` — the execution fence's bounded effect area; without it a
 *      frontier-membership refusal cannot say what IS admissible.
 *   `allowed_verification_calls` — the verifying-phase escape; every entry is a
 *      `ToolCall` TC-2 validates like any other.
 *   `cwd_candidates` — the `cwd-required-for-create` recovery the guide names
 *      by field ("choose from served `cwd_candidates` and resend").
 *   `failed_item` — WHICH entry of a batch refused, when `field` addresses the
 *      property but not the item.
 *   `hint`, `note` — prose routing guidance; A.8 E-7 makes prose sheddable, not
 *      deletable.
 *   `file_lines`, `replaced_lines`, `replacement_lines`, `resulting_lines`,
 *      `shrink_percent`, `replaced_percent` — the blast-radius measurement the
 *      caller is being asked to acknowledge (see the array below).
 *   `failed_items` — the batch pre-pass's per-item ledger; `failed_item` above
 *      is the single-item producer, not this one's rename.
 *   `candidate` — the inferred-but-deliberately-unapplied target; guide-bound.
 *   `current_sha`, `served_sha` — the two hashes a `hash-mismatch` /
 *      `served-content-stale` refusal is ABOUT. `detail` can say they differ;
 *      only these say what they are, and `precondition:"expected-hash"` takes
 *      one of them as an argument.
 *   `file_line_count` — the bound a `range-out-of-bounds` refusal was measured
 *      against; the corrected range is unauthorable without it.
 *   `path` — WHICH file, on refusals whose `field` names a property rather than
 *      a target.
 *   `headings`, `headings_truncated`, `headings_total`, `headings_note`,
 *      `sections_hint`, `missing` — the R1 markdown-navigation recovery index,
 *      merged into this allowlist 2026-08-14 (previously its own
 *      `REFUSAL_NAVIGATION_KEYS`; see the array below for the full rationale).
 *
 * `certificate_id` LEFT THIS CLASS in the same adjudication: it is now a
 * declared, CONDITIONALLY REQUIRED field of `Refusal` (see `buildRefusal`),
 * because `retry:"challenge"` is unauthorable without it — that is consumer
 * dependence, which is exactly what an advisory field must not have.
 *
 * Everything §2.6 adjudicates away is absent by construction: `error`, `ok`,
 * `unlock`, `terminal`, `terminal_reason`, `reason`, `required_action`,
 * `retry_same_call`, `next_call_is_template` and the challenge TEMPLATE are all
 * absorbed into `code` + `retry` + `next` + `detail`.
 */
/**
 * PER-CODE advisory keys — S3 (C2-9), adjudicated 2026-08-14.
 *
 * WHY A SECOND, NARROWER LIST EXISTS. The flat allowlist above is cross-tool:
 * a key added there rides EVERY refusal. That is right for keys whose meaning
 * is code-independent (`path`, `hint`, `current_sha`), and wrong for `handle`,
 * whose meaning is not. On most refusals a top-level `handle` is the CALLER'S
 * OWN argument echoed back (`server.ts:9100` returns `handle: args["from"]`) —
 * caller-recoverable noise, and exactly what the earlier `requested_handle` /
 * `directoryHandle` drop removed. On `create-target-exists` it is the
 * opposite: a handle the SERVER MINTED for a file the caller has never seen,
 * which the caller cannot reconstruct from anything it holds.
 *
 * So the four keys below ride that ONE code. The affordance they carry is
 * guide-bound ("file exists -> edit through the served handle") and is proved
 * end-to-end by the replay corpus's cfl5 -> cfl6 chain: cfl6 edits the existing
 * file using nothing but the handle cfl5's refusal served. Dropping them made
 * that chain unresolvable, which is how the loss was found.
 *
 * Why each rides:
 *   `handle` — the server-minted `kind:"file"` handle for the EXISTING file;
 *      the recovery's only address. `next` names it, and A.5.15 has no other
 *      slot that could.
 *   `bytes`, `sha` — the existing file's identity. A caller deciding whether to
 *      overwrite is deciding about a file it has not read; without these the
 *      refusal asks for a decision about a quantity it does not state (the same
 *      argument the blast-radius numbers ride on).
 *   `content_identical` — the no-op discriminator. It is the ONLY field that
 *      separates "this create would have changed the file" from "this create
 *      was a no-op", and the two have different recoveries (`next` is an edit
 *      in the first case and a closure call in the second). Without it the two
 *      refusals differ only by their `next`, which is advisory to reconstruct.
 *
 * Same removability contract as the flat list: advisory, no consumer branch
 * required, removable under §1.5.
 */
const REFUSAL_ADVISORY_KEYS_BY_CODE: Readonly<Record<string, readonly string[]>> = {
  "create-target-exists": ["handle", "bytes", "sha", "content_identical"],

  /**
   * S5 (C2-9, 2026-08-14) — RAISED FOR ADJUDICATION, NOT PRE-APPROVED. This
   * entry applies S3's adjudicated principle to a second code; it is scoped,
   * annotated and independently revertible so a reviewer can accept or drop it
   * without touching anything else.
   *
   * THE PRINCIPLE, RESTATED: an advisory field rides when it is SERVER-MINTED
   * and NOT caller-recoverable. `repeated-all-served-find` refuses a find
   * because every matching file was already served this session — and it
   * refuses it while HOLDING the complete match receipt. The emitter's own
   * `receipt_note` states the contract: "locations are complete (path +
   * matched lines + exact counts); only snippets are omitted". Dropping the
   * receipt converts a refusal that SUBSTITUTES for the search into one that
   * merely denies it, and the only way for a caller to recover the locations
   * is to re-run the find this refusal exists to stop. That is the dead-end
   * class F5/[R5-10] remove, arrived at from the data side instead of the
   * continuation side.
   *
   * Why each rides:
   *   `files`, `total_files`, `total_matches` — the receipt itself: which
   *      files matched, at which lines, how many times. Complete by
   *      construction; only the snippets (bytes the caller already holds) are
   *      withheld, which is the whole economy of the escalation.
   *   `all_served`, `all_served_occurrence` — WHY this is a refusal and how
   *      many times it has now happened. `code` says the class; only the
   *      occurrence count distinguishes a first escalation from a loop.
   *   `duplicate_of_query`, `duplicate_call` — which EARLIER query this one
   *      duplicates. `detail` names it in prose; this names it as data.
   *   `query`, `receipt_note` — the query the receipt is about, and the
   *      completeness statement above.
   *   `did_you_mean_ranked`, `basis` — the served-file ranking the escalation
   *      offers in place of the search (`content_matched` is its evidence).
   */
  "repeated-all-served-find": [
    "files", "total_files", "total_matches",
    "all_served", "all_served_occurrence",
    "duplicate_of_query", "duplicate_call",
    "query", "receipt_note",
    "did_you_mean_ranked", "basis",
  ],
};

/**
 * THE RECOVERY-INDEX CLASS — A.13 ruling 8 ([R5-22]), split out of the flat
 * advisory list 2026-08-14 (P3a S3).
 *
 * CONSUMER-DEPENDENT, THEREFORE NOT ADVISORY. The advisory class's own contract
 * is "no consumer branch required, removable under §1.5", and these three fail
 * it: the R1 markdown-navigation recovery is a `sections:[…]` re-issue, and
 * `headings` is THE ONLY WIRE SOURCE of a valid section name for it. A refusal
 * whose `next` names that call while withholding the index is a transition the
 * caller cannot take — the dead-end class F5 removes. `headings_truncated` and
 * `headings_total` ride with it because an index presented without its own
 * truncation disclosure reads as complete, and a caller that picks from a
 * silently-capped index gets a second refusal for the same reason.
 *
 * SHED RULE: **never shed while the refusal's `next` references them.** The
 * boundary shedder (`budget/shedders/refusal.ts`) enforces exactly that
 * predicate; this constant is what it enforces it over.
 *
 * ZERO WIRE EFFECT. The three keys are spliced back into
 * `REFUSAL_ADVISORY_KEYS` below AT THEIR ORIGINAL POSITIONS — insertion order
 * there is JSON key order on the wire and the §6.1(b) refusal pins are
 * byte-exact about it — so this split reclassifies without moving a byte.
 * `markdownNavigation.spec.ts` is the regression fence.
 */
export const REFUSAL_RECOVERY_INDEX_KEYS: readonly string[] = [
  "headings", "headings_truncated", "headings_total",
];

/**
 * CALLER-RECOVERABLE — ruling 8's third class, same 2026-08-14 adjudication.
 *
 * `missing` echoes the caller's OWN unmatched `sections` argument back at it.
 * That makes it the same class as the `requested_handle` / `directoryHandle`
 * drops: the caller can reconstruct it from the request it just sent, so
 * withholding it under budget pressure costs a comparison, not a round trip.
 * Cheapest structured loss on a refusal, and the shedder cuts it first.
 *
 * Spliced back in place below; zero wire effect, as above.
 */
export const REFUSAL_CALLER_RECOVERABLE_KEYS: readonly string[] = ["missing"];

// Wave 9 workspace-boundary recovery. `workspace` is an A.8.3 disclosure and
// `did_you_mean` is typed core; only `cwd_candidates` belongs to the plain
// advisory class and therefore joins the rung-3 shed ladder.
export const REFUSAL_WORKSPACE_RECOVERY_ADVISORY_KEYS: readonly string[] = ["cwd_candidates"];

export const REFUSAL_ADVISORY_KEYS: readonly string[] = [
  "candidates", "nearest_match", "actual", "expected_shapes", "alternatives",
  "frontier", "allowed_verification_calls", ...REFUSAL_WORKSPACE_RECOVERY_ADVISORY_KEYS, "failed_item",
  "hint", "current_sha", "served_sha", "file_line_count", "path",
  // The R1 markdown-navigation recovery index (2026-07-25), merged in here
  // 2026-08-14 — the one-round-trip navigation-recovery standard pinned by
  // `markdownNavigation.spec.ts`: the heading index of the document the
  // caller missed, its own truncation disclosure, and the `sections:[...]`
  // pointer, riding a `markdown-section-not-found` /
  // `markdown-section-ambiguous` refusal.
  //
  // RULING 8 SPLIT THIS RUN OF SIX INTO THREE CLASSES, and the split is
  // POSITIONAL-PRESERVING by construction — the two extracted constants are
  // spread back exactly where their literals used to sit, so the emitted key
  // order is unchanged. `headings_note` stays plain advisory (prose about the
  // index, not the index) and `sections_hint` stays plain advisory too: on a
  // REFUSAL the `next` already names the `sections:[…]` call, so the hint is
  // decorative here in a way it is not on a `read.text` success.
  ...REFUSAL_RECOVERY_INDEX_KEYS, "headings_note",
  "sections_hint", ...REFUSAL_CALLER_RECOVERABLE_KEYS,
  // The BLAST-RADIUS measurement (write/blastRadius.ts:115-130), added
  // 2026-08-14. A `blast-radius-precondition-required` refusal exists to make a
  // whole-file-scale replacement DELIBERATE; the five numbers are what the
  // caller acknowledges. `detail` can say the hunk is large, and `next` can say
  // to re-issue with `expected-hash`, but neither can say WHICH 300 of 300
  // lines, so without them the refusal asks for an acknowledgement of a
  // quantity it does not state. `resulting_lines` rides for the same reason —
  // it is the post-edit line count the shrink percentage is computed from.
  "file_lines", "replaced_lines", "replacement_lines", "resulting_lines",
  "shrink_percent", "replaced_percent",
  // `failed_items` — the PLURAL per-item ledger the `edits[]` targetless
  // pre-pass emits (server.ts's P4.1). `failed_item` (singular, already above)
  // names one entry; the batch pre-pass classifies EVERY item and names all of
  // them, and a batch refusal that reports only the first leaves the caller to
  // re-discover the rest one round trip at a time. Both spellings ride: they
  // are different producers, and neither is the other's rename.
  "failed_items",
  // `candidate` — GUIDE-BOUND vocabulary, named verbatim in the agent guide's
  // recovery rule ("`candidate`=top-handle path (items do NOT inherit it)").
  // It is the one field that says which path the server INFERRED but refused
  // to write to; dropping it deletes the distinction between "no target could
  // be inferred" and "a target was inferred and deliberately not applied",
  // which is the entire subject of the P4.1 refusal.
  "candidate",
  // `note` — prose, on the same footing as `hint` above (A.8 E-7 makes prose
  // sheddable, not deletable). It carries the rules a recovering caller needs
  // that no structured field states, e.g. that `edits[]` items do NOT inherit
  // the top-level handle's path.
  "note",
];

// The call-scoped WORKSPACE DISCLOSURES are a DIFFERENT CLASS from the advisory
// allowlist above, and since [R5-21] (ruling 4, 2026-08-14) they have their own
// home: `protocol/disclosure.ts`, implementing A.8.3. They answer "WHICH TREE
// ANSWERED?", not "how do I recover?", so the advisory class's "no consumer
// dependence, removable in a future minor" never described them — the write
// path stamps `root_note` on its structured REFUSALS precisely because a
// refusal minted against a root the caller never named is when that question is
// load-bearing (2026-08-09 root-mismatch wave; `writeSessionGuards.spec.ts:327`
// and `:344` pin it).

/**
 * Build the one `Refusal` (A.5.15) from whatever shape the emitter produced.
 *
 * ALL refusal guidance is built HERE, inside the funnel. Nothing appends to a
 * refusal after `finalizeProtocolResponse` returns (P3a), which is what makes
 * the allowlist above a closure rather than a filter something downstream can
 * route around.
 */
export function buildRefusal(forTool: ToolName, body: Record<string, unknown>): Refusal {
  const code = refusalCodeOf(body);
  const declaredRetry = retryOf(body);
  const next = nextOf(body);
  const detail = detailOf(body, next !== undefined);
  const remaining = remainingOf(body);
  // A.9.2 row 1: `unknown_arguments` -> `fields`. Row 18 (C2-6): a producer
  // that only set `unknown_edits_item_arguments` (no top-level `fields`)
  // still gets its violations named via the same flattening.
  const fields = stringArray(body["fields"])
    ?? stringArray(body["unknown_arguments"])
    ?? flattenEditsItemArguments(body["unknown_edits_item_arguments"]);
  const keys = stringArray(body["keys"]);
  const certificateId = typeof body["certificate_id"] === "string" && body["certificate_id"] !== ""
    ? body["certificate_id"]
    : undefined;

  const advisory: Record<string, unknown> = {};
  for (const key of [
    ...REFUSAL_ADVISORY_KEYS,
    ...(REFUSAL_ADVISORY_KEYS_BY_CODE[code] ?? []),
  ]) {
    // `slice` / `task_pack` modes cannot repair a workspace boundary. Wave 9
    // makes this a code-level guarantee so no producer can reintroduce that
    // misleading recovery through the otherwise-valid advisory field.
    if (code === "path-outside-workspace" && key === "alternatives") continue;
    const value = body[key];
    if (value === undefined || value === null) continue;
    // A.8 rule E-1: never emit `[]`/`{}`/`""` in place of absence.
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === "string" && value === "") continue;
    if (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) continue;
    advisory[key] = value;
  }
  // A.8.3 / [R5-21] ruling 4: the envelope-level disclosure class, applied by
  // the ONE mechanism the success path also uses. It runs immediately after the
  // allowlist loop — the position the disclosure keys occupied when they were
  // spread INTO that loop — because insertion order here is JSON key order on
  // the wire, and the §6.1(b) refusal pins are byte-exact about it. The two
  // paths keep separate POLICIES (this one E-1-filters and omits the
  // success-only `cwd_corrected`); `disclosure.ts` states why that is a
  // difference in the contract and not a duplication.
  carryDisclosures(advisory, body, WORKSPACE_DISCLOSURE_KEYS, REFUSAL_DISCLOSURE_POLICY);
  // §1.3.1(4)'s `did_you_mean` is a STRING and is rebuilt into its typed slot
  // below. `tools/exploreTree.ts` emits a richer OBJECT form
  // (`{path, children}`) for a mistyped directory, which A.5.15's string slot
  // cannot hold — so the object form rides the advisory class instead of being
  // dropped. Same Revision-5 row as the fields above.
  const didYouMean = body["did_you_mean"];
  if (didYouMean !== undefined && didYouMean !== null && typeof didYouMean !== "string") {
    advisory["did_you_mean"] = didYouMean;
  }
  // C2-4 deferred this mapping to the edit-side work and C2-5 lands it:
  // `checkCwdOrRefuse`'s `nearest_existing` IS a `did_you_mean`. It is the
  // nearest EXISTING ancestor of a cwd that does not resolve — the recovery for
  // the `.claire`/`.claude` typo class, where the caller is usually one segment
  // away from a real directory — and the closed allowlist dropped it, which
  // C2-4 recorded as a measured capability loss with "no successor". It has
  // one: §1.3.1(4)'s `did_you_mean` is a declared, allowlisted STRING slot and
  // this value is a string. Never overwrites an emitter's own suggestion.
  //
  // PI-07 / F-A1-5 (2026-08-20): this used to be a VERBATIM, unrevalidated
  // passthrough — `nearest_existing` was a raw filesystem ancestor walk that
  // FOLLOWS symlinks, so a symlink whose realpath escaped every allowed
  // parent could reach the wire as a write-path (edit_file) `did_you_mean`
  // and draw the same refusal again on verbatim retry. The fix lives at the
  // SOURCE, not here: `checkCwdOrRefuse` (server.ts) now computes
  // `nearest_existing` via `workspace/candidates.ts`'s
  // `nearestValidWorkspaceAncestor`, which validates every candidate ancestor
  // through the same resolver policy a live call applies before returning
  // it — so by the time this mapping runs, the value is already safe, on
  // every tool's refusal, not just the read-path tools
  // (`checkCwdWithCorrection`) that independently re-validate before
  // silently adopting it.
  const nearestExisting = body["nearest_existing"];
  if (typeof nearestExisting === "string" && nearestExisting !== ""
    && typeof body["did_you_mean"] !== "string") {
    advisory["did_you_mean"] = nearestExisting;
  }
  // Rule K (A.9.2 row 7): D4 gives the envelope `kind`, and several refusal
  // bodies ship a top-level `kind` of their own (`"xlsx"`, `"pdf"`, `"file"`)
  // which would SHADOW the discriminator. Relocated, not dropped — this is a
  // deliberate construction, not passthrough, which is why it sits outside the
  // allowlist loop.
  if (typeof body["kind"] === "string" && advisory["form"] === undefined) {
    advisory["form"] = body["kind"];
  }

  const core = {
    v: PROTOCOL_VERSION,
    kind: "refusal" as const,
    for: forTool,
    code,
    ...(next !== undefined ? { next } : {}),
    ...(typeof body["field"] === "string" ? { field: body["field"] } : {}),
    ...(typeof body["did_you_mean"] === "string" ? { did_you_mean: body["did_you_mean"] } : {}),
    ...(keys !== undefined ? { keys } : {}),
    ...(fields !== undefined ? { fields } : {}),
    ...(detail !== undefined ? { detail } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...advisory,
  };

  // §2.6 + A.5.15's conditional requirement, USER-ADJUDICATED 2026-08-13.
  //
  // §2.6 makes the agent AUTHOR the challenge — "from the advertised
  // `edit_file`/`read_file` request schema plus the refusal's
  // `retry:\"challenge\"`" — and `challenge.certificate_id` is a REQUIRED
  // argument of that call (`server.ts:460`, and `state/session.ts:2150` refuses
  // a challenge whose id does not match the active task). A `retry:"challenge"`
  // that names no certificate is therefore not a transition at all: it is a
  // dead end wearing a transition's label, which is the class §2.1.2 (F5) and
  // the 2026-07-16a `refusal_without_next` forensics both exist to remove.
  //
  // So the invariant is enforced in BOTH directions and by BOTH mechanisms: the
  // type makes `certificate_id` required on the `challenge` arm (`tsc` proves
  // no construction site can omit it), and this degrades a would-be challenge
  // with no id to `"new-task"` — always available, needs no sanction (§2.6's
  // standing re-pack rule), and honest about what the caller can actually do.
  if (declaredRetry === "challenge" && certificateId !== undefined) {
    return { ...core, retry: "challenge", certificate_id: certificateId };
  }
  const retry: Exclude<RetryTransition, "challenge"> =
    declaredRetry === "challenge" ? "new-task" : declaredRetry;
  return {
    ...core,
    retry,
    ...(certificateId !== undefined ? { certificate_id: certificateId } : {}),
  };
}
