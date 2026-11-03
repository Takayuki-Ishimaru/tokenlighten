// servedStateAndEdits — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { TaskPackResult } from "../model.js";
import { explicitCodeIdentifiers } from "./anchorFocus2.js";
import { findBuildEntry } from "../../../util/verificationPack.js";
import { normIdent } from "./createAndWiringEndpoints2.js";
import { probeToolchain } from "../../../util/verificationPack.js";

export type ExactReplacement =
  | { search: string; replace: string }
  | { identifierOldValue: string; replace: string };

// T1 (2026-08-27, v0.12 wave D2): a code-shaped identifier token adjacent to
// the literal(s) IN THE SAME MATCH, verified against explicitCodeIdentifiers'
// own "looks like code, not prose" heuristic (has `_`, camelCase, PascalCase,
// or ALL_CAPS) — never a plain English word. Values are restricted to
// numeric/boolean/sentinel literals (never a bare word), so an actual rename
// request ("X from oldName to newName") cannot be mistaken for a value edit.
// Every parse still dies safely downstream: attachSingleSiteUniqueMatchFastPath
// re-verifies the resolved search text against the served file and requires a
// single unique occurrence before ever proposing an edit.
export const EXACT_REPLACEMENT_IDENT_SRC = "[A-Za-z_$][A-Za-z0-9_$]*";

export const EXACT_REPLACEMENT_VALUE_SRC =
  "(?:[+-]?(?:\\d+\\.\\d+|\\d+)%?|true|false|null|undefined|on|off|enabled|disabled)";

/**
 * T1: resolve IDENT's current literal value from an "IDENT: value" / "IDENT =
 * value" assignment-shaped span inside already-served surface code, for a
 * query that named only the NEW value ("set PACKET_LOSS_FAILURE to 0.15").
 * Requires the identifier to be assigned in EXACTLY one place in the served
 * text — assigned more than once, or not found at all, is not a safe
 * single-site rewrite, so this returns undefined rather than guess.
 */
export function resolveOldValueReplacement(
  code: string,
  identifier: string,
  newValue: string,
): { search: string; replace: string } | undefined {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `\\b${escaped}\\b(\\s*[:=]\\s*)(${EXACT_REPLACEMENT_VALUE_SRC})\\b`,
    "g",
  );
  const matches = [...code.matchAll(re)];
  if (matches.length !== 1) return undefined;
  const [wholeMatch, separator, oldValue] = matches[0]!;
  if (oldValue === newValue) return undefined;
  return { search: wholeMatch!, replace: `${identifier}${separator}${newValue}` };
}

/** Parse only user-authored, unambiguous replacement notation; never infer an edit from prose. */
export function exactReplacementFromQuery(query: string): ExactReplacement | undefined {
  const found: Array<{ search?: string; replace: string; identifierOldValue?: string; selfEvidentMutation?: boolean }> = [];
  const add = (search: string | undefined, replace: string | undefined, selfEvidentMutation?: boolean): void => {
    if (search === undefined || replace === undefined || search.length === 0 || search === replace) return;
    if (Buffer.byteLength(search, "utf8") > 8192 || Buffer.byteLength(replace, "utf8") > 8192) return;
    found.push({ search, replace, selfEvidentMutation });
  };
  const addUnresolved = (identifierOldValue: string, replace: string): void => {
    if (identifierOldValue.length === 0 || replace.length === 0) return;
    if (Buffer.byteLength(replace, "utf8") > 8192) return;
    found.push({ identifierOldValue, replace, selfEvidentMutation: true });
  };
  for (const match of query.matchAll(/\breplace\s+`([^`\n]+)`\s+with\s+`([^`\n]+)`/giu)) add(match[1], match[2]);
  for (const match of query.matchAll(/\breplace\s+"([^"\n]+)"\s+with\s+"([^"\n]+)"/giu)) add(match[1], match[2]);
  for (const match of query.matchAll(/\breplace\s+'([^'\n]+)'\s+with\s+'([^'\n]+)'/giu)) add(match[1], match[2]);
  for (const match of query.matchAll(/「([^」\n]+)」(?:を)?「([^」\n]+)」(?:に)?(?:置換|変更|修正)/gu)) add(match[1], match[2]);
  for (const match of query.matchAll(/^(?!-{3})-([^\n]+)\n^(?!\+{3})\+([^\n]+)$/gmu)) add(match[1], match[2]);

  const codeShapedTokens = new Set(explicitCodeIdentifiers(query).map((token) => normIdent(token)));
  const isBoundIdentifier = (token: string): boolean => codeShapedTokens.has(normIdent(token));
  const IDENT = EXACT_REPLACEMENT_IDENT_SRC;
  const VALUE = EXACT_REPLACEMENT_VALUE_SRC;

  // Arrow form: `IDENT[:=|を] OLD (→|->|=>) NEW` — e.g. "PACKET_LOSS_FAILURE
  // を 0.12→0.15" or "TIMEOUT_MS: 30 -> 60".
  for (const match of query.matchAll(new RegExp(`\\b(${IDENT})\\s*(?:[:=]|を)?\\s*(${VALUE})\\s*(?:→|->|=>)\\s*(${VALUE})\\b`, "gu"))) {
    if (isBoundIdentifier(match[1]!)) add(match[2], match[3], true);
  }
  // "change|set|update IDENT from OLD to NEW" / bare "IDENT from OLD to NEW".
  // Excluded outright when the query separately reads as a rename request —
  // "from X to Y" is also how a caller phrases renaming an identifier, and a
  // rename is a multi-site concern this fast path must never approximate.
  if (!/\b(?:rename|renamed|renaming)\b/iu.test(query) && !/(?:改名|リネーム)/u.test(query)) {
    for (const match of query.matchAll(new RegExp(`\\b(?:change|set|update)?\\s*(${IDENT})\\s+from\\s+(${VALUE})\\s+to\\s+(${VALUE})\\b`, "giu"))) {
      if (isBoundIdentifier(match[1]!)) add(match[2], match[3], true);
    }
  }
  // JA "IDENTをOLDからNEWに/へ".
  for (const match of query.matchAll(new RegExp(`(${IDENT})を(${VALUE})から(${VALUE})(?:に|へ)`, "gu"))) {
    if (isBoundIdentifier(match[1]!)) add(match[2], match[3], true);
  }
  // "set IDENT to NEW" / JA "IDENTをNEWに" — old value is not stated in the
  // query; resolved later against the actually-served file.
  for (const match of query.matchAll(new RegExp(`\\bset\\s+(${IDENT})\\s+to\\s+(${VALUE})\\b`, "giu"))) {
    if (isBoundIdentifier(match[1]!)) addUnresolved(match[1]!, match[2]!);
  }
  for (const match of query.matchAll(new RegExp(`(${IDENT})を(${VALUE})に`, "gu"))) {
    if (isBoundIdentifier(match[1]!)) addUnresolved(match[1]!, match[2]!);
  }

  if (found.length !== 1) return undefined;
  const replacement = found[0]!;
  const explicitMutation = replacement.selfEvidentMutation === true
    || /\b(?:apply|replace|change|update|fix)\b/iu.test(query)
    || /(?:適用|置換|変更|修正)/u.test(query);
  if (!explicitMutation) return undefined;
  return replacement.identifierOldValue !== undefined
    ? { identifierOldValue: replacement.identifierOldValue, replace: replacement.replace }
    : { search: replacement.search!, replace: replacement.replace };
}

/** No-install verification guidance shared by every "not runnable" verdict. */
export const VERIFY_NO_INSTALL_SUGGESTION =
  "tests cannot run here: say so when you report; do not install dependencies unless the task explicitly requires running tests";

/**
 * A C/C++ surface set's verdict comes from the SAME host probe the edit-time
 * verification manifest uses (util/verificationPack.ts `probeToolchain`), never
 * from an npm script: the 2026-07-30 forensics caught a firmware fix task being
 * told verification was unavailable while clang++ sat on PATH, and another being
 * handed `npm test` because an ancestor directory held an unrelated
 * package.json. A native `command` names the compiler plus whichever build
 * system (if any) actually exists — it is a starting point for a standalone
 * harness, not a canned one-liner, and says so.
 */
export function nativeVerificationVerdict(
  workspace: string,
  paths: string[],
): NonNullable<TaskPackResult["verification"]> {
  const { cxx, cc } = probeToolchain();
  const compiler = cxx ?? cc;
  if (compiler === undefined) {
    return { available: false, reason: "no C/C++ toolchain found", suggestion: VERIFY_NO_INSTALL_SUGGESTION };
  }
  let buildEntry: string | undefined;
  for (const rel of paths) {
    const dir = path.posix.dirname(rel);
    buildEntry = findBuildEntry(workspace, dir === "." ? "" : dir);
    if (buildEntry !== undefined) break;
  }
  return {
    available: true,
    command: buildEntry === undefined
      ? `${compiler} (standalone harness; no project build system detected)`
      : `${compiler} (project build system at ${buildEntry})`,
  };
}
