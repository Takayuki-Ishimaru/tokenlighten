/**
 * evidenceConflict.ts — P1 evidence completion (DESIGN-v0.10 D7), conflict rule.
 *
 * When two evidence CLASSES disagree about a concern, D7 says the pack holds
 * `prepared` and SERVES the disagreement (affordance-bearing per D2), rather
 * than silently picking a side. This module is the detector for that.
 *
 * ITS SCOPE IS DELIBERATELY NARROW, AND THAT IS THE DESIGN, NOT A LIMITATION.
 * The server cannot decide semantic agreement and must not pretend to: a false
 * conflict HOLDS a pack and therefore COSTS turns, which is strictly worse than
 * no detector at all. Only contradictions the resolver itself surfaced count —
 * where both the KEY and the VALUES were extracted mechanically:
 *
 *   C1 literal-disagreement      two slices in DIFFERENT classes bind the same
 *                                key to different literals
 *   C2 declaration-contradiction the same, where one side is
 *                                normative.declaration and the key is one of
 *                                its own declared parameters
 *
 * Both use ONE extractor. The two labels exist because a caller weighs "the
 * header says otherwise" differently from "the contract table says otherwise",
 * not because the detection differs.
 *
 * evidenceConflict.spec.ts test 16 pins the boundary: prose a human would call
 * contradictory, sharing no extracted key, must produce NO conflict. If that
 * test ever fails, this module has grown a semantics engine — revert it.
 */

import type { EvidenceClass, EvidenceSlice, EvidenceSubclass } from "./evidenceResolution.js";

export interface ConflictPosition {
  class: EvidenceClass;
  subclass?: EvidenceSubclass;
  path: string;
  range: string;
  value: string;
}

export interface ConcernConflict {
  /** The concern whose authority is in dispute. */
  id: string;
  kind: "literal-disagreement" | "declaration-contradiction";
  /** The identifier (or table row key) both sides bind. */
  key: string;
  positions: ConflictPosition[];
}

/** Bounds the report; a pack that trips more than this has a bigger problem. */
const MAX_CONFLICTS_PER_CONCERN = 3;
/** Keys must be identifier-shaped; values must be short and literal-ish. */
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_VALUE_CHARS = 24;

/**
 * `key -> value` bindings a slice states mechanically. Three neutral shapes:
 *
 *   | FR | -yaw |        markdown table row (2 data cells)
 *   FR = -yaw            assignment
 *   FR: -yaw             mapping / field
 *
 * Nothing here is language- or domain-specific, and prose that merely mentions
 * a name produces no binding — which is exactly why test 16 passes.
 */
export function extractBindings(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    // Markdown table row: | KEY | VALUE |
    if (line.startsWith("|")) {
      const cells = line.split("|").map((c) => c.trim()).filter((c) => c.length > 0);
      if (cells.length === 2 && KEY_RE.test(cells[0]!) && cells[1]!.length <= MAX_VALUE_CHARS) {
        if (!/^-+$/.test(cells[1]!)) out.set(cells[0]!, normalizeValue(cells[1]!));
      }
      continue;
    }

    // A COMMENT line is where declared semantics live ("HAL_ERR_BUSY if
    // timeout_ms == 0 and mutex is held"), so the binding is mid-sentence
    // rather than line-initial. Strip the comment leader and scan anywhere for
    // `IDENT == LITERAL` / `IDENT = LITERAL`. Prose with no such pair yields
    // nothing, which is what keeps the detector out of semantics (test 16).
    const commentLeader = /^(?:\/\/+|\/?\*+|#+)\s?/.exec(line);
    if (commentLeader !== null) {
      const body = line.slice(commentLeader[0].length);
      const cm = /\b([A-Za-z_][A-Za-z0-9_]*)\s*==?\s*([A-Za-z0-9_+\-."']+)/.exec(body);
      if (cm !== null) {
        const key = cm[1]!;
        const value = normalizeValue(cm[2]!);
        if (KEY_RE.test(key) && value.length > 0 && value.length <= MAX_VALUE_CHARS && !out.has(key)) {
          out.set(key, value);
        }
      }
      continue;
    }

    // CODE line: KEY = VALUE / KEY: VALUE, line-initial only. Anchoring here is
    // deliberate — a mid-line `==` in code is a comparison inside a condition,
    // not a statement of what the value must be.
    const m = /^(?:const|let|var|final|auto)?\s*([A-Za-z_][A-Za-z0-9_]*)\s*(=|:)\s*([^;,)]+)/.exec(line);
    if (m === null) continue;
    const key = m[1]!;
    const value = normalizeValue(m[3]!);
    if (!KEY_RE.test(key) || value.length === 0 || value.length > MAX_VALUE_CHARS) continue;
    if (!out.has(key)) out.set(key, value);
  }
  return out;
}

function normalizeValue(raw: string): string {
  return raw
    .replace(/^=+/, "")
    .replace(/[`"']/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.;]+$/, "")
    .trim();
}

/** Parameter names a declaration slice declares, from its own signature. */
function declaredParameters(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\(([^)]*)\)/g)) {
    for (const part of m[1]!.split(",")) {
      const token = part.trim().split(/\s+/).pop();
      if (token !== undefined && KEY_RE.test(token)) out.add(token);
    }
  }
  return out;
}

/**
 * Cross-class literal disagreements among the slices that would actually be
 * SERVED. Unselected candidates are ignored: a conflict must rest on evidence
 * the caller would receive, or the affordance is a lie.
 */
export function detectConflicts(
  concernId: string,
  slices: readonly EvidenceSlice[],
): ConcernConflict[] {
  const served = slices.filter((s) => s.selected);
  if (served.length < 2) return [];

  const parsed = served.map((slice) => ({
    slice,
    bindings: extractBindings(slice.text),
    params: slice.subclass === "declaration" ? declaredParameters(slice.text) : undefined,
  }));

  const conflicts: ConcernConflict[] = [];
  const reported = new Set<string>();

  for (let i = 0; i < parsed.length; i++) {
    for (let j = i + 1; j < parsed.length; j++) {
      const left = parsed[i]!;
      const right = parsed[j]!;
      // CROSS-class only. Two tests disagreeing with each other is a test
      // problem, not an authority conflict, and the server has no standing to
      // adjudicate it.
      if (left.slice.class === right.slice.class) continue;

      for (const [key, leftValue] of left.bindings) {
        const rightValue = right.bindings.get(key);
        if (rightValue === undefined) continue;          // no shared key => nothing
        if (rightValue === leftValue) continue;          // they agree
        if (reported.has(key)) continue;

        const declarationSide = left.params !== undefined
          ? left
          : right.params !== undefined ? right : undefined;
        const kind = declarationSide?.params?.has(key) === true
          ? "declaration-contradiction" as const
          : "literal-disagreement" as const;

        reported.add(key);
        conflicts.push({
          id: concernId,
          kind,
          key,
          positions: [left, right].map(({ slice }) => ({
            class: slice.class,
            ...(slice.subclass !== undefined ? { subclass: slice.subclass } : {}),
            path: slice.path,
            range: slice.range,
            value: (slice === left.slice ? leftValue : rightValue),
          })),
        });
        if (conflicts.length >= MAX_CONFLICTS_PER_CONCERN) return conflicts;
      }
    }
  }
  return conflicts;
}
