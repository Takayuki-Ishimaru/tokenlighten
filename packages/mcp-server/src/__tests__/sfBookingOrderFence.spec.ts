/**
 * sfBookingOrderFence.spec.ts — FX-J/FX-K's STATIC ordering fence.
 *
 * WHY A PARSE TEST. The invariant "the pack that gets BOOKED is the pack that
 * SHIPS" is an ORDERING claim about `readCodeTaskPack.ts`, and it has now been
 * broken four times in four different ways, each time by a producer nobody
 * re-checked:
 *
 *   - FX-H deferred ONE producer (the served-range ledger) through a
 *     module-global queue and left three others upstream (round-13 finding 1).
 *   - FX-I-A moved the seam into `dedupeTrimAndPersist` and split the
 *     admissible union into nominate/book — but left `recordServedSurfaces`
 *     upstream AND unfiltered, so a demoted, never-served handle still reached
 *     the NEXT same-epoch certificate's `action_frontier` and the
 *     execution-typestate gate admitted a blind edit of it (round-14 finding
 *     1). Both `canonicalDecision.ts` and `decisionWire.ts` asserted in prose
 *     that the seam already preceded that log.
 *   - The same commit's nominate/book split silently narrowed the FLAG-OFF
 *     union on any cap-overflowing pack (round-14 finding 2).
 *   - FX-J kept a SECOND, flag-selected booking site on the default path, over
 *     the pre-trim surface list. One production `budget:{bytes}` call plus one
 *     `edit_file` turned that into `edit.applied` against a file whose bytes
 *     the response never sent (round-15 finding 1). FX-K collapsed the two
 *     sites into one unconditional post-trim pass.
 *
 * WHAT THIS FILE BINDS (FX-K, round-15 findings 2, 3 and 7). Round-15 showed
 * the previous version did not implement the guarantee its own header stated:
 * it asserted the ABSENCE of producers inside two named function bodies, so a
 * producer called from any THIRD function was invisible to it — and three
 * `captureServedPack` sites already were. This version inverts the check. It
 * enumerates every booking producer and every WITNESS that reads the pack
 * before the seam, finds every call site of each ACROSS THE WHOLE MODULE, and
 * requires each site to be covered by an explicit allowlist entry carrying a
 * reason. A new site anywhere in the file fails until it is classified.
 *
 * WHAT IT CANNOT BIND. It is textual: an alias (`const book =
 * recordServedSurfaces`), a call through a wrapper, or a producer added in
 * ANOTHER module is out of reach. `ALIAS_FORMS` below rejects the cheapest
 * aliasing shapes; the rest is covered by the live end-to-end cases in
 * `sfShippedBookings.spec.ts` and `sfCapOverflowBookings.spec.ts`.
 *
 * WHAT WOULD FAIL WITHOUT THE FIX. Against `ab2dab32` (FX-J) this file fails on
 * the single-pass case (`bookPreSeamPackServeState` books a second time),
 * on the unconditional-pass case (the pass is gated on `deferred !== undefined`),
 * on the one-projection case (`rememberCertifiedWorkingSet` re-projects), and
 * on the producer-coverage case (three unclassified `captureServedPack` sites).
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = path.resolve(HERE, "../features/task-pack/readCodeTaskPack.ts");
const SOURCE = fs.readFileSync(SOURCE_PATH, "utf8");

/** The seam that may still withhold a body. */
const SEAM = "applySemanticFrontierPreBookingSeam";
/** The one booking pass, in both flag states. */
const SHIPPED_PASS = "bookShippedPackServeState";
/** The pre-trim orchestration that must book NOTHING. */
const FINALIZE = "finalizePackServeState";

/**
 * Every producer that writes durable state asserting something about what a
 * task pack SERVED, plus every pre-seam pass that reads the pack as a witness.
 *
 * `sites` is the complete allowlist: `enclosing` names the top-level function
 * the call must sit in, and `reason` says why that position is honest. A call
 * site in any other function — or one site too many in an allowed function —
 * fails the coverage case below.
 */
interface ProducerSpec {
  /** Identifier as it appears at the call site. */
  name: string;
  /** Durable-state writer (must be honest about bytes) vs. in-pack witness. */
  kind: "booking" | "witness";
  sites: ReadonlyArray<{ enclosing: string; count: number; reason: string }>;
}

const PRODUCERS: readonly ProducerSpec[] = [
  {
    name: "recordServedEditAdmissibility",
    kind: "booking",
    sites: [{
      enclosing: SHIPPED_PASS,
      count: 1,
      reason: "the edit gate's admissible union — the single pass, off `shipped`",
    }],
  },
  {
    // FX-M4 (round-16): FX-L's "withheld" complement of the shipped booking
    // above was itself an unclassified site until now — this fence enumerates
    // producers by NAME, so a durable write-authority producer added anywhere
    // in the module is invisible to "THE FENCE" test until it is listed here.
    name: "recordWithheldEditAddresses",
    kind: "booking",
    sites: [{
      enclosing: SHIPPED_PASS,
      count: 1,
      reason:
        "FX-L's residency complement of recordServedEditAdmissibility, in the same pass and "
        + "off the SAME `shipped` projection (via `withheldSurfaces`, its filtered inverse) — "
        + "so a path/handle this response emitted but did not ship a body for is marked "
        + "`withheld` in the same post-trim, post-seam position the shipped booking runs, "
        + "never pre-seam where the pack could still be re-demoted underneath it.",
    }],
  },
  {
    name: "recordServedSurfaces",
    kind: "booking",
    sites: [
      {
        enclosing: SHIPPED_PASS,
        count: 1,
        reason: "the cumulative served-surface log — the single pass, off `shipped`",
      },
      {
        enclosing: FINALIZE,
        count: 1,
        reason:
          "epoch bookkeeping ONLY: called with an EMPTY entry list, so it performs the "
          + "reset-on-new-task + token-union half that attachFrontierIndex's attach latch and "
          + "every same-call queryServedSurfaces epoch gate read. Books no entry. The empty "
          + "list is asserted literally by the 'books nothing' case below.",
      },
    ],
  },
  {
    name: "rememberCertifiedWorkingSet",
    kind: "booking",
    sites: [{
      enclosing: SHIPPED_PASS,
      count: 1,
      reason: "the certified working set — the single pass, handed the SAME `shipped` list",
    }],
  },
  {
    name: "captureServedPack",
    kind: "booking",
    sites: [
      {
        enclosing: SHIPPED_PASS,
        count: 1,
        reason: "the served-pack record and (through it) the served-range ledger, off `returned`",
      },
      {
        enclosing: "buildTaskPackCore",
        count: 1,
        reason:
          "CACHE RE-KEY, not a serve: rebinds a pack that ALREADY completed "
          + "dedupeTrimAndPersist (and therefore its own booking pass) from the internal "
          + "seeded request to the caller's original pathless one. It books no new surface — "
          + "recordPackServedRanges' packServedSpans takes no line from a bodyless surface.",
      },
      {
        enclosing: "buildPropagationTaskPack",
        count: 1,
        reason: "CACHE RE-KEY of an already-booked seeded pack — see buildTaskPackCore",
      },
      {
        enclosing: "buildPartialPack",
        count: 1,
        reason: "CACHE RE-KEY of an already-booked seeded pack — see buildTaskPackCore",
      },
    ],
  },
  {
    name: "recordPackServedRanges",
    kind: "booking",
    sites: [{
      enclosing: "captureServedPack",
      count: 1,
      reason: "the per-address served-range ledger, reachable only through captureServedPack",
    }],
  },
  {
    name: "recordEpochTaskContract",
    kind: "booking",
    sites: [
      {
        enclosing: "dedupeTrimAndPersist",
        count: 2,
        reason:
          "durable epoch task contract whose `servedRoles` proof type is \"served\". Both sites "
          + "take `trimmed` — POST-`trimToCap`, so a Phase-E-stripped or Phase-F-spliced "
          + "surface is already excluded by its own `hasServedCode` filter, which is the "
          + "default-path hazard round-15 finding 1 was about. It necessarily precedes the SF "
          + "seam (its output is rebuilt into the contract and the wire), and a seam-demoted "
          + "surface can never be a role's sole evidence: demotion requires the surface NOT to "
          + "be `semanticPrimary`, i.e. its handle is in neither `action_frontier` nor "
          + "`evidence_handles`. Recorded as round-15 finding 4 (LOW, no outcome exhibited).",
      },
    ],
  },
  {
    name: "reconcileEpochTaskContract",
    kind: "booking",
    sites: [{
      enclosing: "dedupeTrimAndPersist",
      count: 1,
      reason:
        "coverage-disclosure reconciliation over `trimmed` (POST-trim). Feeds "
        + "recordServedRoleEvidence/recordServedConcernEvidence, which re-read the body from "
        + "DISK rather than asserting wire delivery; pre-seam for the same structural reason "
        + "as recordEpochTaskContract.",
    }],
  },
  {
    name: "recordPriorPackObligations",
    kind: "booking",
    sites: [{
      enclosing: "dedupeTrimAndPersist",
      count: 1,
      reason:
        "obligation ledger built from `trimmed.change_contract.obligations` (POST-trim), gated "
        + "on TL_COVERAGE_PACKER=v2 (default off). Its paths reach the NEXT certificate's "
        + "action_frontier via priorEpochActionFrontier, so it is a write-authority producer: "
        + "an obligation is a published requirement to edit a path, not a claim that this "
        + "response sent its bytes.",
    }],
  },
  {
    name: "markServedZoomCandidates",
    kind: "witness",
    sites: [{
      enclosing: "dedupeTrimAndPersist",
      count: 1,
      reason:
        "round-15 finding 7: NOT read-only, as round-14's producer table claimed. It writes "
        + "`result.served_zoom_suppressed` and can delete `result.next`/`result.continuation`, "
        + "computing packServedSpans over the PRE-demotion pack. It writes no session state, "
        + "and canonicalDecision.ts's reapplySemanticFrontierDecision re-derives the decision "
        + "after the seam, so no stale zoom verdict survives to the wire.",
    }],
  },
];

/**
 * Source span of a TOP-LEVEL function: from its own declaration to the next
 * column-0 declaration/comment anchor. Every nested statement in this module
 * is indented, so a column-0 anchor is always the next top-level construct —
 * which makes this a stable span without needing a brace matcher that would
 * have to understand template literals and regex literals.
 */
function topLevelFunctionSpan(name: string): { start: number; end: number } {
  const start = SOURCE.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, "m"));
  expect(start, `top-level function ${name} must exist in readCodeTaskPack.ts`).toBeGreaterThan(-1);
  const rest = SOURCE.slice(start + 1);
  const nextAnchor = rest.search(
    /^(?:export )?(?:async |declare )?(?:function |const |let |class |interface |type |\/\*\*|\/\/ ---)/m,
  );
  return { start: start + 1, end: nextAnchor === -1 ? SOURCE.length : start + 1 + nextAnchor };
}

function topLevelFunctionBody(name: string): string {
  const span = topLevelFunctionSpan(name);
  return SOURCE.slice(span.start, span.end);
}

/** `text` with every line-comment and block-comment line removed, so a doc that NAMES a producer is not counted as a call site. */
function withoutComments(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
    .map((line) => line.replace(/\s\/\/.*$/, ""))
    .join("\n");
}

/** Call-site count of `name(` in `text`, ignoring its own declaration and any prose. */
function callSites(text: string, name: string): number {
  const matches = withoutComments(text).match(new RegExp(`(?<!function )\\b${name}\\(`, "g"));
  return matches === null ? 0 : matches.length;
}

/**
 * Byte offsets of every call site of `name` in the WHOLE module.
 *
 * Comment lines are BLANKED, not deleted, so every line keeps its index and an
 * offset computed here addresses the same position in the untouched source.
 */
function callSiteOffsets(name: string): number[] {
  const lines = SOURCE.split("\n").map((line) =>
    /^\s*(?:\/\/|\*|\/\*)/.test(line) ? "" : line.replace(/\s\/\/.*$/, ""),
  );
  const sourceLineStarts: number[] = [0];
  for (let i = 0; i < SOURCE.length; i++) if (SOURCE[i] === "\n") sourceLineStarts.push(i + 1);
  const re = new RegExp(`(?<!function )\\b${name}\\(`, "g");
  const out: number[] = [];
  for (let ln = 0; ln < lines.length; ln++) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(lines[ln]!)) !== null) out.push((sourceLineStarts[ln] ?? 0) + m.index);
  }
  return out;
}

/** The top-level function whose span contains `offset`, or `undefined`. */
function enclosingFunctionOf(offset: number, names: readonly string[]): string | undefined {
  for (const name of names) {
    const span = topLevelFunctionSpan(name);
    if (offset >= span.start && offset < span.end) return name;
  }
  return undefined;
}

describe("FX-K static ordering fence: every booking producer is classified, and the one pass books what ships", () => {
  it("resolves the spans this fence reasons over (guards the parse itself)", () => {
    const names = new Set<string>([
      "dedupeTrimAndPersist", FINALIZE, SHIPPED_PASS, "captureServedPack",
      ...PRODUCERS.flatMap((producer) => producer.sites.map((site) => site.enclosing)),
    ]);
    for (const name of names) {
      const body = topLevelFunctionBody(name);
      expect(body.length, `${name}'s span must be non-trivial`).toBeGreaterThan(200);
      // A runaway span (the anchor regex failing) would swallow the rest of the
      // file and make every classification below meaningless.
      expect(body.length, `${name}'s span must not run away`).toBeLessThan(120_000);
    }
  });

  it("THE FENCE: every call site of every booking producer is covered by an allowlist entry with a reason", () => {
    const enclosingNames = [...new Set(PRODUCERS.flatMap((p) => p.sites.map((s) => s.enclosing)))];
    for (const producer of PRODUCERS) {
      const offsets = callSiteOffsets(producer.name);
      const expected = producer.sites.reduce((sum, site) => sum + site.count, 0);
      expect(
        offsets.length,
        `${producer.name}: ${offsets.length} call sites in readCodeTaskPack.ts, `
        + `${expected} allowlisted. A new booking site must be added to PRODUCERS with a reason `
        + `(FX-K: no producer may assert what a pack served from an unclassified position).`,
      ).toBe(expected);
      const byFunction = new Map<string, number>();
      for (const offset of offsets) {
        const enclosing = enclosingFunctionOf(offset, enclosingNames);
        expect(
          enclosing,
          `${producer.name} at offset ${offset} is called from a function this fence does not `
          + `classify — add it to PRODUCERS with a justification`,
        ).toBeDefined();
        byFunction.set(enclosing!, (byFunction.get(enclosing!) ?? 0) + 1);
      }
      for (const site of producer.sites) {
        expect(site.reason.length, `${producer.name}@${site.enclosing} needs a real reason`)
          .toBeGreaterThan(40);
        expect(
          byFunction.get(site.enclosing) ?? 0,
          `${producer.name} must be called exactly ${site.count}× in ${site.enclosing}`,
        ).toBe(site.count);
      }
    }
  });

  it("`finalizePackServeState` books nothing: its only producer call is the empty-list epoch bookkeeping", () => {
    const body = topLevelFunctionBody(FINALIZE);
    for (const producer of PRODUCERS.filter((p) => p.kind === "booking")) {
      const allowed = producer.sites.find((site) => site.enclosing === FINALIZE)?.count ?? 0;
      expect(
        callSites(body, producer.name),
        `${FINALIZE} must not call ${producer.name} beyond its allowlisted ${allowed} site(s)`,
      ).toBe(allowed);
    }
    // The ONE allowed call is literally `[]` — that is what makes it bookkeeping
    // rather than a booking. FX-J passed `defer ? [] : surfaces.map(...)`; FX-K
    // removed the branch, so an entry list here can only be a regression.
    expect(withoutComments(body)).toMatch(/recordServedSurfaces\(\s*workspace,\s*workspace,\s*\[\],\s*epochTokens,?\s*\)/);
    // No log-entry projection may be built here at all — an entry has the
    // `{ path, role, handle }` shape, which is what FX-J's
    // `defer ? [] : surfaces.map((s) => ({ path: s.path, role: ... }))` produced.
    expect(withoutComments(body), "no log-entry list may be projected here")
      .not.toMatch(/\.map\(\([^)]*\) => \(\{ path:/);
    expect(withoutComments(body), "no deferral branch may select an entry list")
      .not.toMatch(/defer/);
  });

  it("`dedupeTrimAndPersist` books nothing directly, and its booking pass runs AFTER the seam", () => {
    const body = topLevelFunctionBody("dedupeTrimAndPersist");
    for (const producer of PRODUCERS.filter((p) => p.kind === "booking")) {
      const allowed = producer.sites
        .find((site) => site.enclosing === "dedupeTrimAndPersist")?.count ?? 0;
      expect(
        callSites(body, producer.name),
        `dedupeTrimAndPersist must not call ${producer.name} beyond its allowlisted ${allowed} `
        + `site(s) (FX-K: ${SHIPPED_PASS} owns every booking downstream of the seam)`,
      ).toBe(allowed);
    }
    const seamAt = body.indexOf(`${SEAM}(`);
    expect(seamAt, "the seam must be called in dedupeTrimAndPersist").toBeGreaterThan(-1);
    const passSites: number[] = [];
    for (let at = body.indexOf(`${SHIPPED_PASS}(`); at >= 0; at = body.indexOf(`${SHIPPED_PASS}(`, at + 1)) {
      passSites.push(at);
    }
    expect(passSites.length, "the booking pass must be called in dedupeTrimAndPersist").toBeGreaterThan(0);
    expect(
      passSites[passSites.length - 1]! > seamAt,
      "THE FENCE: the normal exit's booking pass must be textually after the demotion seam",
    ).toBe(true);
    for (const at of passSites) {
      if (at > seamAt) continue;
      // The only sanctioned pre-seam booking site is an exit that RETURNS
      // before the seam can run — the byte-budget fallback. Prove it returns.
      expect(
        body.slice(at, seamAt),
        "a booking pass before the seam is only allowed on an exit that returns before the seam",
      ).toContain("return fallback;");
    }
    // FX-I-A's other constraint, kept explicit: the seam cannot precede the
    // serve-state finalizer, because the classifier needs the finalized
    // execution_contract that runs between them.
    const finalizeAt = body.indexOf(`${FINALIZE}(`);
    expect(finalizeAt).toBeGreaterThan(-1);
    expect(seamAt > finalizeAt, "the seam runs after finalizePackServeState (FX-I-A)").toBe(true);
    // FX-K: every pre-seam WITNESS that reads the pack is classified too, so
    // "which passes see the un-demoted pack" is a list, not a memory.
    for (const witness of PRODUCERS.filter((p) => p.kind === "witness")) {
      expect(callSites(body, witness.name)).toBe(
        witness.sites.find((site) => site.enclosing === "dedupeTrimAndPersist")?.count ?? 0,
      );
    }
  });

  it("the booking pass is UNCONDITIONAL — no flag selects a second booking position", () => {
    const body = withoutComments(topLevelFunctionBody(SHIPPED_PASS));
    // FX-J gated the whole pass on `deferred === undefined ? undefined : ...`.
    expect(body, "the projection must not be flag-selected").toMatch(
      /const shipped = shippedSurfaces\(returned\);/,
    );
    expect(body, "no producer may be gated on a deferral sentinel")
      .not.toMatch(/shipped !== undefined/);
    // The pass's own caller must build the bookings object unconditionally.
    const caller = withoutComments(topLevelFunctionBody("dedupeTrimAndPersist"));
    expect(caller).toMatch(/const pendingBookings: PendingPackBookings = \{/);
    expect(caller, "FX-K: the booking position must not depend on sfDemoteEnabled()")
      .not.toMatch(/sfDemoteEnabled\(\)\s*$/m);
    // And the retired pre-seam booking site must stay retired.
    expect(SOURCE, "bookPreSeamPackServeState was collapsed into the single pass (FX-K)")
      .not.toContain("bookPreSeamPackServeState");
  });

  it("the shipped pass derives every booking from ONE `shippedSurfaces` projection", () => {
    const body = topLevelFunctionBody(SHIPPED_PASS);
    const projectionAt = body.indexOf("shippedSurfaces(returned)");
    expect(projectionAt, "the pass must compute shippedSurfaces(returned)").toBeGreaterThan(-1);
    expect(
      (withoutComments(body).match(/shippedSurfaces\(/g) ?? []).length,
      "exactly one projection — a second would be a second answer to 'what shipped'",
    ).toBe(1);
    for (const producer of ["recordServedSurfaces", "rememberCertifiedWorkingSet", "recordServedEditAdmissibility", "captureServedPack"]) {
      const at = body.indexOf(`${producer}(`);
      expect(at, `${producer} must be booked by the single pass`).toBeGreaterThan(-1);
      expect(at, `${producer} must be booked AFTER the projection`).toBeGreaterThan(projectionAt);
    }
    // Every call site is dedupeTrimAndPersist's (the normal exit and the
    // byte-budget fallback exit, both asserted above).
    expect(callSites(SOURCE, SHIPPED_PASS))
      .toBe(callSites(topLevelFunctionBody("dedupeTrimAndPersist"), SHIPPED_PASS));
  });

  it("`shippedSurfaces` is the only definition of 'what this response shipped', with ONE consumer", () => {
    expect((SOURCE.match(/^function shippedSurfaces\(/m) ?? []).length).toBe(1);
    expect(SOURCE).toMatch(/return codeTaskPackSurfaces\(result\.surfaces\)\.filter\(hasServedCode\);/);
    // FX-K (round-15 finding 3): the certified-working-set writer used to take
    // its OWN projection, over `trimmed` rather than over the pack that ships.
    // It now receives the one list, so the module has exactly one call site.
    expect(callSites(SOURCE, "shippedSurfaces")).toBe(1);
    expect(callSites(topLevelFunctionBody("rememberCertifiedWorkingSet"), "shippedSurfaces")).toBe(0);
    expect(
      withoutComments(topLevelFunctionBody("rememberCertifiedWorkingSet")),
      "the certified working set must consume the list it is handed",
    ).toMatch(/const surfaces = shipped;/);
  });

  it("rejects the cheapest ways to smuggle a producer past the textual check", () => {
    const stripped = withoutComments(SOURCE);
    for (const producer of PRODUCERS) {
      // `const book = recordServedSurfaces;` / `= recordServedSurfaces,`
      const ALIAS_FORMS = new RegExp(`=\\s*${producer.name}\\s*[;,)\\]}]`);
      expect(
        ALIAS_FORMS.test(stripped),
        `${producer.name} must not be aliased — this fence counts call sites textually`,
      ).toBe(false);
    }
  });

  it("the ordering prose in the sibling modules names the real position", () => {
    const canonical = fs.readFileSync(
      path.resolve(HERE, "../features/task-pack/canonicalDecision.ts"), "utf8",
    );
    const wire = fs.readFileSync(path.resolve(HERE, "../protocol/decisionWire.ts"), "utf8");
    for (const [label, text] of [["canonicalDecision.ts", canonical], ["decisionWire.ts", wire]] as const) {
      // Round-14 finding 1's second half: both files claimed the seam ran
      // "immediately before `finalizePackServeState`". It runs AFTER it.
      expect(
        /immediately\s+\*?\s*\/?\/?\s*before `finalizePackServeState`/.test(text.replace(/\n\s*(?:\/\/|\*)\s*/g, " ")),
        `${label} must not claim the seam runs immediately before finalizePackServeState`,
      ).toBe(false);
      expect(text, `${label} must name the pass that actually books`).toContain(SHIPPED_PASS);
      // Round-15 finding 4: both files enumerate the producers. The enumeration
      // must not read as complete while the pre-seam ledger writers exist.
      expect(
        text,
        `${label} must name the pre-seam ledger producers rather than imply the list is complete`,
      ).toContain("recordEpochTaskContract");
    }
  });
});
