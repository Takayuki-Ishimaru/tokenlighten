/**
 * requestShape — strict, RECURSIVE request-shape validation (P1 / D2 /
 * ORCHESTRATOR CONDITION ②).
 *
 * DESIGN-v0.10-protocol-v1-contract-freeze.md §1.3 adjudicated D2 = (c):
 * responses are must-ignore, **requests are strict**. §1.3.1 is the normative
 * mechanics, and this module implements items (1), (4), (5) and (6) of it:
 *
 *   (1) validation is recursive over DECLARED shapes — not a top-level key
 *       sweep. Every declared object property is checked against its declared
 *       shape at every depth, and an unknown key at any depth refuses.
 *   (4) `did_you_mean` uses a defined metric — Damerau-Levenshtein <= 2 over
 *       the advertised key set AT THE OFFENDING PATH, at most one candidate,
 *       omitted entirely when nothing qualifies; `retry:"call"` is present
 *       whether or not a suggestion is; the advertised key list rides only
 *       when it fits the refusal's own budget.
 *   (5) the offending property is named by its FULL PATH (`edits[2].serch`)
 *       in a typed slot, not buried in prose.
 *   (6) VALUE validation is untouched. This module validates property NAMES
 *       only. `lang` stays a bare string validated by dispatch
 *       (`server.ts` parseMcpLang, pinned by `schemaSize.spec.ts:249-260`).
 *
 * Why strict at all: must-ignore turns `{"preconditon":"unique-match"}` into an
 * edit executed WITHOUT its precondition — the protocol silently discards the
 * one argument whose entire purpose is to prevent a wrong-site write. That is
 * not hypothetical here: the 2026-08-01 incident (findReferences.ts, 788 -> 57
 * lines) was a dropped top-level `range`, and it is why `edit_file` already
 * failed closed before this module existed (server.ts EDIT_FILE_KNOWN_ARGS).
 * This module generalises that guard to all three tools and gives it the
 * ergonomics CONDITION ② requires.
 *
 * WHAT "RECURSIVE" REACHES — §1.3.1(2) (C-6, 2026-08-13) made rule (1) total:
 *
 *  - An object that declares `type:"object"` and NO `properties` is OPAQUE and
 *    is passed through untouched, because rule (1) is vacuous over a shape
 *    that declares no keys. C-5 shipped with four such shapes (`archive`,
 *    `challenge`, `artifact`, the object form of `paths.items`); C-6 gave all
 *    four their declared keys in ALL_TOOLS, so the recursion now reaches every
 *    request property the three tools accept.
 *  - Exactly ONE key-less map survives, on purpose and permanently:
 *    `artifact.form`. A PDF form is a map from the DOCUMENT's own field names
 *    to values — caller data, not protocol — so there is no key set to declare.
 *    That is §1.3.1(2)'s "re-typed so that it does not need to" escape, not
 *    residual debt.
 *  - PENDING_C6_ADJUDICATION below is now EMPTY and pinned empty. There is no
 *    accepted-but-hidden property left on the three advertised tools.
 *
 * The module is pure: it takes the advertised `properties` object and the raw
 * args record and returns data. It does not import server.ts (that would be a
 * cycle — server.ts imports this), so the caller passes the schema in. The
 * single source of truth therefore stays ALL_TOOLS, exactly as
 * `editFileAdvertisedProperties()` already arranged for edit_file.
 */

// ---------------------------------------------------------------------------
// Schema shape
// ---------------------------------------------------------------------------

/**
 * The JSON-Schema subset ALL_TOOLS actually uses. `oneOf` is deliberately
 * absent: it is policy not to use it (server.ts:625-633 explains why
 * `paths.items` spells "string OR object" as `type:["string","object"]`), and
 * §1.3.1's C-6 successor keeps that rule.
 */
export interface SchemaNode {
  type?: string | readonly string[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  enum?: readonly unknown[];
  description?: string;
}

// ---------------------------------------------------------------------------
// PENDING_C6_ADJUDICATION — accepted-but-unadvertised names, passed through
// ---------------------------------------------------------------------------

/**
 * C-6 CLOSED THIS RECORD (2026-08-13). It is intentionally EMPTY and must stay
 * empty: §1.3.1(2) says v1 has no third state between advertised and deleted,
 * so an entry here is, by construction, an accepted-but-hidden property that
 * has not been adjudicated. The map is kept (rather than deleted along with its
 * last entry) because it is the mechanism a future accepted-but-hidden property
 * would have to pass through, and because requestShapeValidation.spec.ts pins
 * its emptiness — a re-populated record fails that pin loudly instead of
 * quietly re-opening the hole D2 closed.
 *
 * What C-6 did with the 20 names C-5 recorded here:
 *  - 19 ADVERTISED. Each was reachable by a caller through something other than
 *    its own memory: a server-emitted recovery string (`expectedSha`,
 *    `scopeHandle`, `regex`, `as`, `kind`), an end-to-end regression pin
 *    (`profile`, `columns`, `symbol`, `includeScores`, `directoryHandle`), the
 *    guide (`taskProfile`), or membership in an option bag whose siblings are
 *    advertised (`maxBytes`, `maxTokens`, `limit`, `rows`, `maxRows`,
 *    `maxCells`, `includeComments`). Hiding any of them reproduced the
 *    2026-08-01 surfaceRoles defect: a schema-validating client drops the
 *    argument and silently gets a different result than it asked for.
 *  - 1 DELETED: `allow_create` on edit_file, a silent synonym for the
 *    advertised `create`. Advertising a second spelling of one capability would
 *    freeze duplicate authority into v1; the engine option and the deprecated
 *    search_replace_edit alias (which advertises it on its own schema) both
 *    survive, so no capability is lost.
 *
 * The four previously key-less objects — `archive`, `challenge`, `artifact`,
 * and the object form of `paths.items` — now declare their keys in ALL_TOOLS,
 * so rule (1) is no longer vacuous over them. One nested map stays key-less on
 * purpose and is NOT debt: `artifact.form`, whose keys are the PDF document's
 * own field names (caller data, not protocol). That is §1.3.1(2)'s "re-typed so
 * that it does not need to" escape, and it is documented at the schema site.
 *
 * Rules any future entry would have to obey:
 *  - Every entry must be a LIVE read of that name in dispatch, cited by
 *    file:line. Nothing speculative.
 *  - Entries are never offered as a `did_you_mean` candidate (§1.3.1(4): "the
 *    candidate set is the ADVERTISED keys ... an accepted-but-unadvertised
 *    property can therefore never be suggested"), and never appear in the
 *    refusal's `keys` list. They are invisible on the wire.
 *  - Attribute every dispatch read to its OWN switch-case arm. A union over the
 *    three tools hides cross-tool leaks: C-5's first pass missed `symbol`,
 *    `taskProfile`, `maxTokens` and `limit` exactly that way, because each is
 *    advertised on a DIFFERENT tool than the one that was hiding it.
 */
export const PENDING_C6_ADJUDICATION: Readonly<Record<string, readonly string[]>> = {};

// ---------------------------------------------------------------------------
// Refusal budget
// ---------------------------------------------------------------------------

/**
 * The refusal's own byte budget, used for the one decision §1.3.1(4) makes
 * budget-dependent: whether the advertised key list rides along.
 *
 * There is no refusal budget mechanism at HEAD to inherit. §4.2 of the design
 * (WireBudget, per-kind shedder, guaranteed-fit core) is P3a and does not
 * exist yet, and the `MAX_RESPONSE_BYTES` constants in this package are
 * per-tool RESPONSE caps for real payloads (searchSymbols 2048,
 * getFileSkeleton 8192, extractOfficeText 12288), not refusal caps. So this is
 * a deliberately conservative constant, chosen as follows:
 *
 *  - 1024 B = half the smallest real response cap in the package (2048). A
 *    refusal buys the caller nothing but a corrected retry, so it should cost
 *    at most half of the cheapest thing the server considers a real answer.
 *  - Measured (A.9.2 row 17, corrected 2026-08-14): the base refusal is ~293 B
 *    and the largest advertised key list is `read_file`'s — 37 properties
 *    after C-6's advertise-or-delete closure raised it from the 28 this comment
 *    used to claim (`server.ts:615-716`) — which serialises to ~400 B. The
 *    normal case still fits, with ~330 B to spare rather than ~440 B, and the
 *    list is dropped only when the offending key names are themselves
 *    pathological. That is the intended behaviour — §1.3.1(4)'s worry is a
 *    refusal that "blows its budget enumerating property names", and the
 *    measurement says 37 names is not, today, what blows it. The arithmetic is
 *    stated so it stays verifiable: a stale operand made it unverifiable, which
 *    is why the row exists.
 *  - The decision is DETERMINISTIC: the candidate refusal is serialised and
 *    measured. Same input plus same schema always yields the same verdict.
 *
 * When the list does not fit, the refusal says so (§1.3.1(4): "the refusal
 * says so and the caller reads tools/list, which it already has") by pointing
 * `next` at tools/list rather than by going quiet.
 */
export const REFUSAL_MAX_BYTES = 1024;

/** Damerau-Levenshtein threshold for `did_you_mean` (§1.3.1(4)). */
export const DID_YOU_MEAN_MAX_DISTANCE = 2;

// ---------------------------------------------------------------------------
// Damerau-Levenshtein
// ---------------------------------------------------------------------------

/**
 * Unrestricted Damerau-Levenshtein distance (Lowrance-Wagner), i.e. insertion,
 * deletion, substitution AND transposition each cost 1.
 *
 * §1.3.1(4) picks Damerau over plain Levenshtein on purpose: plain edit
 * distance charges a transposition 2, so `hadnle` / `raneg` / `qeury` fall
 * outside a threshold-2 window under plain Levenshtein and inside it under
 * Damerau — and a transposition is precisely the error an LLM emitting JSON
 * from a schema it read once actually makes. Pinning the metric matters
 * because the refusal is snapshot-pinned by §6.1(a)/(b): an undefined
 * "nearest known property" is not implementable twice the same way.
 */
export function damerauLevenshtein(a: string, b: string): number {
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;

  const maxDist = al + bl;
  // (al+2) x (bl+2) so the transposition rule can index row/col 0 sentinels.
  const d: number[][] = Array.from({ length: al + 2 }, () => new Array<number>(bl + 2).fill(0));
  d[0]![0] = maxDist;
  for (let i = 0; i <= al; i++) {
    d[i + 1]![0] = maxDist;
    d[i + 1]![1] = i;
  }
  for (let j = 0; j <= bl; j++) {
    d[0]![j + 1] = maxDist;
    d[1]![j + 1] = j;
  }

  // lastRowWithChar: for each character, the last row of `a` that held it.
  const lastRowWithChar = new Map<string, number>();
  for (let i = 1; i <= al; i++) {
    let lastColMatch = 0;
    for (let j = 1; j <= bl; j++) {
      const k = lastRowWithChar.get(b[j - 1]!) ?? 0;
      const l = lastColMatch;
      let cost = 1;
      if (a[i - 1] === b[j - 1]) {
        cost = 0;
        lastColMatch = j;
      }
      d[i + 1]![j + 1] = Math.min(
        d[i]![j]! + cost,                              // substitution
        d[i + 1]![j]! + 1,                             // insertion
        d[i]![j + 1]! + 1,                             // deletion
        d[k]![l]! + (i - k - 1) + 1 + (j - l - 1),     // transposition
      );
    }
    lastRowWithChar.set(a[i - 1]!, i);
  }
  return d[al + 1]![bl + 1]!;
}

/**
 * At most one candidate, per §1.3.1(4): the minimum-distance advertised key
 * within DID_YOU_MEAN_MAX_DISTANCE, ties broken by the shorter key and then
 * lexicographically. Returns undefined when nothing qualifies — "a suggestion
 * at distance 5 is noise that costs bytes and misleads a caller into a second
 * wrong call".
 *
 * `candidates` must be the ADVERTISED keys at the offending path. Drawing from
 * another nesting level is worse than saying nothing, because it sends the
 * caller to edit a key that is valid somewhere else.
 */
export function nearestAdvertisedKey(
  unknownKey: string,
  candidates: readonly string[],
): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = damerauLevenshtein(unknownKey, candidate);
    if (distance > DID_YOU_MEAN_MAX_DISTANCE) continue;
    if (
      distance < bestDistance
      || (distance === bestDistance && best !== undefined && (
        candidate.length < best.length
        || (candidate.length === best.length && candidate < best)
      ))
    ) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Recursive walk
// ---------------------------------------------------------------------------

/** One unknown property, located. */
export interface UnknownPropertyViolation {
  /**
   * Full WIRE path of the offending property, as §1.3.1(5) requires:
   * `preconditon` at the top level, `edits[2].serch` inside an array item.
   * The key is echoed verbatim — HEAD's edit_file guard does the same, and a
   * normalised name would not be the thing the caller has to delete.
   */
  field: string;
  /**
   * STRUCTURAL path of the containing shape, indices stripped: `edit_file`,
   * `edit_file.edits[]`. This is the PENDING_C6_ADJUDICATION key and the
   * identity of the advertised key set the suggestion came from.
   */
  parentPath: string;
  /** Sorted advertised keys at `parentPath`. Excludes allowlisted names. */
  advertisedKeysAtPath: readonly string[];
  /** <= 1 candidate, or absent. */
  didYouMean?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursive name validation. Descends only into shapes that DECLARE keys —
 * an object property with no `properties` is opaque and is skipped (see the
 * module header: closing those four is C-6). Array item shapes are descended
 * per element so the path carries the index.
 *
 * Order is DOCUMENT order (depth-first, insertion order within each object),
 * which is what makes `violations[0]` a stable "first offending property" for
 * an identical request. This matches HEAD's edit_file guard, which filters
 * `Object.keys(args)` directly.
 */
export function findUnknownProperties(
  tool: string,
  properties: Record<string, SchemaNode>,
  args: Record<string, unknown>,
): UnknownPropertyViolation[] {
  const violations: UnknownPropertyViolation[] = [];

  const walk = (
    node: SchemaNode,
    value: unknown,
    wirePath: string,
    structPath: string,
  ): void => {
    if (Array.isArray(value)) {
      const items = node.items;
      if (!items) return;
      value.forEach((entry, index) => {
        walk(items, entry, `${wirePath}[${index}]`, `${structPath}[]`);
      });
      return;
    }
    if (!isPlainObject(value)) return;

    const declared = node.properties;
    // No declared keys => opaque => rule (1) is vacuous here. C-6.
    if (!declared) return;

    const advertised = Object.keys(declared).sort();
    const allowlisted = PENDING_C6_ADJUDICATION[structPath] ?? [];
    for (const key of Object.keys(value)) {
      if (key in declared) {
        const child = declared[key]!;
        const childWire = wirePath.length > 0 ? `${wirePath}.${key}` : key;
        walk(child, value[key], childWire, `${structPath}.${key}`);
        continue;
      }
      if (allowlisted.includes(key)) continue;
      const suggestion = nearestAdvertisedKey(key, advertised);
      violations.push({
        field: wirePath.length > 0 ? `${wirePath}.${key}` : key,
        parentPath: structPath,
        advertisedKeysAtPath: advertised,
        ...(suggestion !== undefined ? { didYouMean: suggestion } : {}),
      });
    }
  };

  walk({ type: "object", properties }, args, "", tool);
  return violations;
}

// ---------------------------------------------------------------------------
// Refusal
// ---------------------------------------------------------------------------

/**
 * The wire shape of the unknown-property refusal.
 *
 * This is HEAD's structured-refusal skeleton (`ok:false` + `reason`/`code` +
 * `error` + a concrete `next`, the convention every toolError site already
 * follows) plus the four things §1.3.1 and CONDITION ② add: the typed
 * path-qualified `field`, the bounded `did_you_mean`, the budgeted `keys`, and
 * `retry`.
 *
 * `v` and `kind:"refusal"` are deliberately ABSENT: D1 and D4 are adjudicated
 * but their emission is P2, and this wave does not put protocol version or a
 * discriminator on the wire. §2.6's full `Refusal` type is where these fields
 * finally live; this is the forward-compatible subset of it.
 *
 * Absence semantics, per §1.3's "absence has meaning and is documented per
 * field" rule:
 *  - `did_you_mean` absent  => no advertised key at that path is within
 *                              Damerau-Levenshtein 2. Not "we did not look".
 *  - `keys` absent          => the list did not fit REFUSAL_MAX_BYTES; `next`
 *                              points at tools/list.
 *  - `unknown_arguments` absent => `field` is the COMPLETE list of offenders
 *                              (there was exactly one). It rides only when
 *                              there are two or more, so the single-offender
 *                              case does not pay for the same string twice.
 */
export type UnknownPropertyRefusal = {
  ok: false;
  reason: "unknown-arguments";
  code: "unknown-arguments";
  field: string;
  unknown_arguments?: string[];
  did_you_mean?: string;
  keys?: string[];
  /**
   * §2.6's `retry` enum, introduced here in its minimal form for this one new
   * refusal member. CONDITION ② is about ONE-ROUND-TRIP RECOVERY, not about
   * the suggestion, so it is present whether or not `did_you_mean` is. Other
   * refusals keep the HEAD `terminal`/`terminal_reason`/`unlock` vocabulary
   * until P2 migrates the whole family; nothing is retro-fitted here.
   */
  retry: "call";
  error: string;
  next: string;
};

/**
 * Does a candidate refusal fit REFUSAL_MAX_BYTES? Exported because `edit_file`
 * renders its own payload (it carries the 2026-08-01 incident fields that
 * editDispatchHardening.spec.ts pins) and must therefore weigh the key list
 * against the bytes it will ACTUALLY emit, not against this module's shorter
 * generic body. Note that `edit_file`'s incident branch carries `next_call`
 * rather than `next`, so in the (measured-unreachable) case where its key list
 * does not fit, the omission is silent there and the caller falls back on
 * `tools/list` unprompted.
 */
export function withinRefusalBudget(candidate: unknown): boolean {
  return Buffer.byteLength(JSON.stringify(candidate), "utf8") <= REFUSAL_MAX_BYTES;
}

const NEXT_WITH_KEYS = (tool: string) =>
  `re-issue the same call with only advertised ${tool} arguments`;

const NEXT_WITHOUT_KEYS = (tool: string) =>
  `re-issue the same call with only advertised ${tool} arguments; the advertised set did not fit this refusal — read it from tools/list`;

/**
 * Render the refusal for a non-empty violation list, or null when the request
 * is clean. Returns a plain record so it can go straight to
 * `toolStructuredError`.
 */
export function unknownPropertyRefusal(
  tool: string,
  violations: readonly UnknownPropertyViolation[],
): UnknownPropertyRefusal | null {
  if (violations.length === 0) return null;
  const first = violations[0]!;

  const base = {
    ok: false as const,
    reason: "unknown-arguments" as const,
    code: "unknown-arguments" as const,
    field: first.field,
    ...(violations.length > 1 ? { unknown_arguments: violations.map((v) => v.field) } : {}),
    ...(first.didYouMean !== undefined ? { did_you_mean: first.didYouMean } : {}),
    retry: "call" as const,
    error:
      `${tool} refuses request properties outside its advertised schema instead of silently dropping them — a dropped argument changes what the call does`,
  };

  const withKeys: UnknownPropertyRefusal = {
    ...base,
    keys: [...first.advertisedKeysAtPath],
    next: NEXT_WITH_KEYS(tool),
  };
  if (withinRefusalBudget(withKeys)) return withKeys;
  return { ...base, next: NEXT_WITHOUT_KEYS(tool) };
}

/**
 * One-call convenience for the read-only tools: validate and render.
 * `edit_file` does not use this — it keeps its own renderer so the fields the
 * 2026-08-01 incident specs pin (`unknown_arguments`,
 * `unknown_edits_item_arguments`, the corrective `next_call`) stay exactly
 * where they were, and takes only the detection from `findUnknownProperties`.
 */
export function requestShapeRefusal(
  tool: string,
  properties: Record<string, SchemaNode>,
  args: Record<string, unknown>,
): UnknownPropertyRefusal | null {
  return unknownPropertyRefusal(tool, findUnknownProperties(tool, properties, args));
}
