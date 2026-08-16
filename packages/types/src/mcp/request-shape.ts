// ---------------------------------------------------------------------------
// protocol v1 — the request-validation contract (§1.3.1), as importable types.
//
// NORMATIVE SOURCE: DESIGN-v0.10 §10.3 Appendix A (Revision 4, approved
// 2026-08-13), A.9.3. Implements the A.9.1 `request-shape.ts` row — a file §2.2
// did not anticipate because §2.2 predates §1.3.1.
//
// WHY THESE TYPES ARE HERE. C-5 declared `SchemaNode`,
// `UnknownPropertyViolation` and `UnknownPropertyRefusal` INSIDE
// `packages/mcp-server`, and `packages/types` contained none of them. §1.3.1
// makes the request-validation contract normative and wire-visible, and a
// wire-visible contract a downstream SDK cannot import is not frozen. They are
// the VALIDATOR's contract rather than a response shape, which is why they get
// their own file rather than landing in `protocol.ts`.
//
// WHAT STAYS IN `mcp-server`. `REFUSAL_MAX_BYTES = 1024` and
// `DID_YOU_MEAN_MAX_DISTANCE = 2` are POLICY the server applies, not shapes a
// client parses. The METRIC is normative (§1.3.1(4)); the threshold constant's
// location is not.
//
// WHAT IS DELETED. `UnknownPropertyRefusal` is deleted as a distinct type: it
// becomes an ordinary `Refusal` (A.5.15) with `code: "unknown-arguments"`,
// `retry: "call"`, `field`, `fields`, `did_you_mean`, `keys`. Its `ok: false`
// and `error` fields go with D6 and A.5.15; its `next: string` prose becomes
// `detail`, because a `Refusal.next` is a `ToolCall` and "re-issue the same call
// with only advertised arguments" is not one. Its `unknown_arguments` plural is
// renamed `fields` (A.9.2 row 1).
// ---------------------------------------------------------------------------

import type { Refusal } from "./protocol.js";

/**
 * One node of an advertised JSON-Schema subtree, as the recursive validator
 * walks it. §1.3.1(2): every accepted property is advertised and there is no
 * third state, so this is the whole vocabulary the walk needs.
 *
 * Transcribed from `packages/mcp-server/src/validation/requestShape.ts:65-71`.
 */
export type SchemaNode = {
  type?: string | readonly string[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  enum?: readonly unknown[];
  description?: string;
};

/**
 * One unknown property, located. Transcribed from
 * `packages/mcp-server/src/validation/requestShape.ts:263-281`.
 *
 * The recursive walk over `edits[]` routinely finds more than one unknown key
 * in one request, which is why the refusal carries a plural slot at all:
 * ORCHESTRATOR CONDITION ② is a ONE-ROUND-TRIP recovery condition, and a
 * refusal that names one of three typos costs three round trips.
 */
export type UnknownPropertyViolation = {
  /** The offending property, path-qualified (§1.3.1(5)). */
  field: string;
  /** The wire path of the object the property was found on. */
  parentPath: string;
  /** Sorted advertised keys at `parentPath`. Excludes allowlisted names. */
  advertisedKeysAtPath: readonly string[];
  /** <= 1 candidate, or absent (§1.3.1(4), Damerau-Levenshtein <= 2). */
  didYouMean?: string;
};

/**
 * The refusal builder's public result type (A.9.1's `request-shape.ts` row,
 * resolved by A.9.3). It is an ORDINARY `Refusal` — this alias exists only to
 * name the two fields the unknown-property builder always fixes, so a caller
 * can see the contract without a second type on the wire.
 *
 * `field` carries the FIRST violation in document order; `fields` rides iff
 * more than one property offends, and then `field === fields[0]`.
 * `did_you_mean` and `keys` stay bound to `field` (A.5.15).
 */
export type RequestShapeRefusal = Refusal & {
  code: "unknown-arguments";
  retry: "call";
};
