// DESIGN-v0.15-sf-intent-layers.md §2 — the intent model, three layers deep.
//
// Word-based classification (`sfDisposition.ts`'s `detectDisposition`) used to
// be consulted ahead of, and sometimes IN PLACE OF, the caller's own
// structured declaration (`task.profile`) — a declared `answer` could be
// silently flipped to `generic`/`change_propagation` because the query also
// contained a mutation verb (V4, retired by this module; see
// `readCodeTaskPack.ts`'s `bindTaskProfile`). This module is the single place
// that orders the three sources of intent evidence so a wrong lexical guess
// can cost at most one extra read, never a wrong write:
//
//   1. DECLARED  — the caller's own `task.profile`. Wins outright.
//   2. OBSERVED  — structural/behavioral facts the server itself recorded
//      (write permission, an edit that already landed this task, a
//      `references` call already made, a qualified anchor the resolver
//      already proved, an explicit target the caller already addressed down
//      to a range or handle). §4.1 (write permission), §4.2 (editObserved
//      opens the write frontier), and §4.4 (`referencesObserved`/
//      `qualifiedAnchorResolved` OR into `relational`, vetoed by an explicit
//      read-address target per §4.3) are all wired (W1/W2/W3).
//   3. LEXICAL   — `detectDisposition`'s verb table, consulted only once
//      layers 1 and 2 leave the disposition undecided.
//
// PURE: no I/O, no LLM call, no network. Every field of `IntentEvidence` is
// data the caller already has in hand.
import { detectDisposition, type SfDisposition } from "./sfDisposition.js";
import type { SfExplicitTarget } from "./sfConcerns.js";

/**
 * One caller-declared address, in the shapes `read_file` accepts. Structural
 * duplicate of `sfConcerns.ts`'s `SfExplicitTarget` (imported as a type only,
 * so this leaf module and `sfConcerns.ts` — a consumer of this module — never
 * form a runtime import cycle, only a type-level one the compiler erases).
 */
export type SfIntentTarget = SfExplicitTarget;

/**
 * Everything `resolveIntent` is allowed to look at. Every field is either the
 * caller's own declaration or a fact the server already observed — never a
 * guess this module makes itself.
 */
export interface IntentEvidence {
  /**
   * Layer 1. The caller's `task.profile`, collapsed to the binary axis this
   * model reasons about: `"answer"` (read-only) or `"generic"` (every other
   * declared profile — `wiring`/`change_propagation`/`multi_concern`/
   * `artifact_build` are all "not answer" at this layer; which of those it is
   * gets decided elsewhere). `undefined` when the caller passed `"auto"` or
   * nothing at all — §14's existing auto-inference guardrail is untouched by
   * this module and keeps deciding that case on its own.
   */
  readonly declaredProfile?: "answer" | "generic";
  /** §4.1. `ALLOW_WRITE` (server.ts:452) — the CLI's `--allow-write` flag. */
  readonly writeAllowed: boolean;
  /**
   * §4.2 (W2). True once the same task's first `edit_file` has passed
   * `guardExecutionEdit` (state/session.ts, exported wrapper around
   * `guardExecutionEditCore`). Threaded from `WorkspaceSession.
   * intentEditObserved` via `getIntentEditObserved(workspaceRoot)`;
   * `false` for a task that has not yet had an edit land, and reset to
   * `false` by `task.epoch:"new"` in both execution guards.
   */
  readonly editObserved: boolean;
  /**
   * §4.4(a). True when this task's `executedLocates` ledger
   * (util/packServeLog.ts's `hasExecutedSearchAction`, keyed `"references"`)
   * already recorded a `references` call. One of two OR members `relational`
   * folds in ahead of vocabulary (§4.4); vetoed by an explicit read-address
   * `explicitTargets` entry (§4.3) even when true.
   */
  readonly referencesObserved: boolean;
  /**
   * §4.4(b). True when a qualified `Class::method` anchor in the query
   * resolved through the anchor resolver. The other OR member `relational`
   * folds in ahead of vocabulary (§4.4); vetoed by an explicit read-address
   * `explicitTargets` entry (§4.3) even when true.
   */
  readonly qualifiedAnchorResolved: boolean;
  /** §4.3. The caller's explicit `targets[]` — a read request, never relational on their own. */
  readonly explicitTargets: readonly SfIntentTarget[];
  /** Layer 3 input: the verbatim request text. */
  readonly query: string;
}

/** Where the returned disposition came from, in the order layers are tried. */
export type IntentSource = "declared" | "observed" | "lexical" | "undecided";

/** The settled call: what to do, whether it may write, and why. */
export interface IntentDecision {
  readonly disposition: SfDisposition;
  readonly relational: boolean;
  /** Whether a write-shaped frontier may be offered at all. */
  readonly writeFrontier: "open" | "closed";
  readonly source: IntentSource;
  readonly reason: string;
}

/**
 * The three-layer decision (§2-§6). Deterministic, LLM-free.
 *
 * Layers 1 (§3, declared) and 2/§4.1 (observed write permission) are, for
 * this call's purposes, the SAME veto: either one forbids "edit" outright,
 * downgrading to "review" — never guessing the disposition forward into some
 * OTHER lexical value, and never (this is the V4 fix) letting the query's own
 * mutation wording flip a declared "answer" into a different profile just
 * because the words are there. When neither veto applies, the lexical verb
 * table (`detectDisposition`) decides the disposition — layer 3 filling in
 * ONLY what layers 1 and 2 left undecided, per §6's ordering rule.
 */
export function resolveIntent(evidence: IntentEvidence): IntentDecision {
  const verb = detectDisposition(evidence.query);
  // §4.3: an explicit target the caller already addressed down to a range or
  // a handle is a READ REQUEST, full stop — the caller told the server
  // exactly what to read, so it vetoes `relational` outright, ahead of every
  // other signal below (vocabulary included; there is nothing left to
  // relate).
  const hasReadAddressTarget = evidence.explicitTargets.some(
    (target) => target.range !== undefined || target.handle !== undefined,
  );
  // §4.4: `relational` is an OR of three members, vocabulary demoted to the
  // last: (a) `referencesObserved` — this task's `executedLocates` already
  // recorded a `references` call; (b) `qualifiedAnchorResolved` — the
  // query's qualified anchor resolved through the injected resolver; (c) the
  // lexical verb table's own `.relational` bit (an OR over every matched
  // vocabulary term, not just the winning disposition; see
  // `sfDisposition.ts`'s `SfVerbMatch.relational`). §4.3's veto above beats
  // all three.
  const relational =
    !hasReadAddressTarget &&
    (evidence.referencesObserved || evidence.qualifiedAnchorResolved || verb?.relational === true);
  const lexicalDisposition = verb?.disposition;

  // §4.2 (W2) — OBSERVED layer: an edit_file call already passed
  // `guardExecutionEdit` THIS task epoch (`editObserved`, threaded from
  // `state/session.ts`'s `WorkspaceSession.intentEditObserved` /
  // `getIntentEditObserved`). This is a structural fact the server recorded
  // itself, not a guess from words, so it outranks both the lexical table
  // (layer 2 > layer 3) and the declared-"answer" veto immediately below —
  // §3 says so explicitly for exactly this shape (a declared "answer" query
  // that also carries mutation wording, the case V4 used to mishandle):
  // 「edit が本当に来るなら層2(§4.2)で開く」. §4.1's write permission is the
  // only thing that can still veto it — an edit that somehow landed with
  // `writeAllowed=false` must not itself become licence to open every later
  // pack of this task as an edit.
  if (evidence.editObserved && evidence.writeAllowed) {
    return {
      disposition: "edit",
      relational,
      writeFrontier: "open",
      source: "observed",
      reason: "an edit_file call already passed guardExecutionEdit this task epoch (§4.2); the write frontier stays open and an edit disposition is admissible for the rest of the task",
    };
  }

  // Layers 1 + 2/§4.1 collapsed: a declared "answer", or write being
  // disallowed, both forbid "edit" — but ONLY when the lexical layer would
  // actually have produced "edit". A declared "answer" paired with e.g. a
  // "verify"/"explain" marker is untouched here; the verb table's own
  // classification (below) still applies to it, exactly as before this
  // module existed — layer 1's whole job is vetoing a WRITE, not
  // relabelling every other operation as "answer".
  const editForbidden = evidence.declaredProfile === "answer" || !evidence.writeAllowed;
  if (lexicalDisposition === "edit" && editForbidden) {
    return {
      disposition: "review",
      relational,
      writeFrontier: "closed",
      source: evidence.declaredProfile === "answer" ? "declared" : "observed",
      reason: evidence.declaredProfile === "answer"
        ? `task.profile declares "answer"; lexical marker "${verb!.term}" would suggest edit, but the declaration is authoritative — downgraded to review, not overridden into a different profile (DESIGN-v0.15 §3, retiring V4)`
        : `write is not allowed (--allow-write absent); disposition downgraded from edit (lexical marker "${verb!.term}")`,
    };
  }

  if (lexicalDisposition !== undefined) {
    return {
      disposition: lexicalDisposition,
      relational,
      writeFrontier: lexicalDisposition === "edit" ? "open" : "closed",
      source: "lexical",
      reason: `lexical marker "${verb!.term}" resolved to ${lexicalDisposition}`,
    };
  }

  if (evidence.declaredProfile !== undefined) {
    return {
      disposition: "review",
      // §4.4 still applies with no lexical marker at all — a structural
      // observation (referencesObserved/qualifiedAnchorResolved) does not
      // depend on the verb table having matched anything.
      relational,
      writeFrontier: "closed",
      source: "declared",
      reason: `task.profile declares "${evidence.declaredProfile}"; no lexical marker, defaulting to review`,
    };
  }

  return {
    disposition: "review",
    // Same as immediately above: §4.4's structural OR members are
    // independent of whether the disposition itself ended up "undecided".
    relational,
    writeFrontier: "closed",
    source: "undecided",
    reason: "no declaration, observation, or lexical marker; defaulting to review with a closed write frontier",
  };
}
