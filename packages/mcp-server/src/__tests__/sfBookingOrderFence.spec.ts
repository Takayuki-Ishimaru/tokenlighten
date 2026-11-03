/**
 * sfBookingOrderFence.spec.ts — FX-J/FX-K's STATIC ordering fence.
 *
 * WHY A PARSE TEST. The invariant "the pack that gets BOOKED is the pack that
 * SHIPS" is an ORDERING claim about the task-pack engine, and it has now been
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
 *     `tl_edit_file` turned that into `edit.applied` against a file whose bytes
 *     the response never sent (round-15 finding 1). FX-K collapsed the two
 *     sites into one unconditional post-trim pass.
 *
 * WHAT THIS FILE BINDS (FX-K, round-15 findings 2, 3 and 7). Round-15 showed
 * the previous version did not implement the guarantee its own header stated:
 * it asserted the ABSENCE of producers inside two named function bodies, so a
 * producer called from any THIRD function was invisible to it — and three
 * `captureServedPack` sites already were. This version inverts the check. It
 * enumerates every booking producer and every WITNESS that reads the pack
 * before the seam, finds every call site of each ACROSS EVERY ENGINE
 * IMPLEMENTATION MODULE (readCodeTaskPack.ts is now a pure re-export facade),
 * and requires each site to be covered by an explicit allowlist entry carrying
 * a reason. A new site anywhere in the engine fails until it is classified.
 *
 * HOW IT READS THE CODE (post-extraction rewrite). `readCodeTaskPack.ts` was
 * split into `features/task-pack/engine/` owner modules, so a single-file
 * textual scan no longer sees the producers. This version parses every engine
 * module with the TypeScript AST: call sites are actual `CallExpression`s
 * (comments, prose and import specifiers can never count), each site's owner is
 * the TOP-LEVEL function whose AST span contains it, and the reviewed
 * `FUNCTION_OWNERS` map below pins each function the fence reasons over to the
 * module that must define it — a producer moved into an unexpected owner, or a
 * new top-level function calling one, fails the coverage case. Module sources
 * are never concatenated: every ordering assertion compares positions inside
 * ONE owner's AST span.
 *
 * WHAT IT CANNOT BIND. A call through a dynamically computed property or
 * a re-exported alias, or a producer added in a module OUTSIDE
 * `engine/` that no engine module calls directly, is out of reach; the
 * `ALIAS_FORMS` scan rejects the cheapest aliasing shapes in every module, and
 * the rest is covered by the live end-to-end cases in `sfShippedBookings.spec.ts`
 * and `sfCapOverflowBookings.spec.ts`.
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
import ts from "typescript";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = path.resolve(HERE, "../features/task-pack/engine");

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
      {
        // repackMonotonicity.spec.ts fix (2026-09-27, eval-0927 wave): the SAME
        // post-augmenter re-booking as recordPackServedRanges@buildAnswerTaskPack
        // above, branched the SAME way bookShippedPackServeState branches
        // (cumulativeEligible = task_profile !== "answer" ||
        // profile_binding.source !== "explicit"). An INFERRED answer task
        // (cumulativeEligible) must have the augmenters' final surfaces reach
        // the SAME cumulative log the first (pre-augmenter) booking pass used
        // for it, never only the declared-answer read-only view — measured:
        // "leaves an INFERRED answer pack exactly as it was" expects
        // cumulativeLogIn(...) to carry the pack's surfaces, which the
        // unconditional recordReadOnlyServedSurfaces call used to withhold from
        // it entirely.
        enclosing: "buildAnswerTaskPack",
        count: 1,
        reason:
          "the INFERRED-answer complement of recordReadOnlyServedSurfaces@buildAnswerTaskPack "
          + "below: re-books the truly final `finalResult` into the cumulative log, off the SAME "
          + "`shippedSurfaces(finalResult)` projection, but ONLY when this task is not a DECLARED "
          + "answer (cumulativeEligible) — mirroring bookShippedPackServeState's own branch so the "
          + "re-booking can never disagree with which ledger the first booking pass chose for the "
          + "SAME task.",
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
        // 2026-11-02: the family-member seed plan (familyMemberSeeds.ts) is the
        // second re-key, same shape as the inferred-scope retry; it adds only
        // an advisory, never a surface.
        // 2026-11-03: the literal-first seed plan (literalSeeds.ts,
        // TL_LITERAL_FIRST_SEEDS) is the third, the same shape again: the
        // seeded builder already booked its internal ranged request, and the
        // re-key binds that finished pack to the caller's pathless one; it
        // adds only an advisory, never a surface.
        count: 3,
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
      {
        // FIX-FC (2026-09-27, eval-0927 review finding 3).
        enclosing: "buildAnswerTaskPack",
        count: 1,
        reason:
          "RE-CAPTURES the truly final `finalResult` after every post-trim answer augmenter "
          + "and the 1.25x named-path cap: it supersedes (replace-by-signature) the record "
          + "dedupeTrimAndPersist booked from its pre-cap draft, so a surface the cap removed "
          + "is never claimed resident on a later call.",
      },
    ],
  },
  {
    // 2026-10-04: captureServedPack's record write, split out so that a request
    // buildTaskPackCore rewrote with its own named project scope also gets the
    // record under the request as the caller sent it.
    name: "writeServedPackRecord",
    kind: "booking",
    sites: [{
      enclosing: "captureServedPack",
      count: 2,
      reason:
        "the served-pack record a receipt re-serves from, written for the request "
        + "captureServedPack was handed and, when buildTaskPackCore rewrote that request with "
        + "its own named project scope (TaskPackArgs.namedScopeRequest), once more under the "
        + "request as the caller sent it: a CACHE RE-KEY of the same pack, whose ledger "
        + "booking just above runs once for both.",
    }],
  },
  {
    name: "recordPackServedRanges",
    kind: "booking",
    sites: [
      {
        enclosing: "captureServedPack",
        count: 1,
        reason: "the per-address served-range ledger, reachable only through captureServedPack",
      },
      {
        // FIX-ORIG (2026-09-27, eval-0927 P1 hybrid-body finding): the answer-
        // profile post-trim augmenters (augmentExplicitAnswerImportSurfaces,
        // materializeExplicitAnswerAnchorEvidence, attachAnswerImportEvidenceGraph,
        // capExtraEvidenceRelativeToNamedPaths) all run AFTER dedupeTrimAndPersist
        // returns — i.e. after captureServedPack's own booking of `finalResult`
        // already happened — so an anchor line one of them widens an existing
        // surface's range to include, or admits as a brand-new one-line surface,
        // was invisible to the served-range ledger until now. (Not
        // `buildTaskPackCore`: this specific answer-profile call chain is
        // `buildAnswerTaskPack`, the WS3 answer-profile builder.)
        enclosing: "buildAnswerTaskPack",
        count: 1,
        reason:
          "RE-BOOKS the truly final `finalResult` (after every post-trim answer "
          + "augmenter, including the cap that can only ever REMOVE a surface) so a "
          + "widened/added anchor surface's bytes reach the same ledger a normal "
          + "surface does. packServedSpans re-derives spans from finalResult.surfaces' "
          + "CURRENT state on every call (no cached pre-image), so re-invoking it here "
          + "is a pure extension, never a stale re-assertion of the FIRST (pre-augmenter) "
          + "booking captureServedPack already performed inside dedupeTrimAndPersist.",
      },
    ],
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
 * The reviewed owner map: every top-level function this fence reasons over,
 * pinned to the engine module that must DEFINE it. A function moved into an
 * unexpected module fails the span-resolution case — the same way a producer
 * called from an unexpected function fails the coverage case.
 */
const FUNCTION_OWNERS: Readonly<Record<string, string>> = {
  dedupeTrimAndPersist: "packSettlement.ts",
  [FINALIZE]: "contentSettlement2.ts",
  [SHIPPED_PASS]: "servedStateAndEdits.ts",
  captureServedPack: "packState4.ts",
  writeServedPackRecord: "packState4.ts",
  buildAnswerTaskPack: "answerPackBuilder.ts",
  buildTaskPackCore: "taskPackBuilder.ts",
  buildPropagationTaskPack: "literalAndConcernSeeds3.ts",
  buildPartialPack: "partialPackBuilder2.ts",
  shippedSurfaces: "wiringEvidence.ts",
  servedBodySurfaces: "wiringEvidence2.ts",
  rememberCertifiedWorkingSet: "epochContract2.ts",
};

interface ModuleAst {
  /** File name inside engine/ (never a path — failures quote the module). */
  file: string;
  source: string;
  sf: ts.SourceFile;
  /** Top-level functions: name plus the AST span of the whole declaration. */
  functions: ReadonlyArray<{ name: string; start: number; end: number }>;
}

function parseModule(file: string, source: string): ModuleAst {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const functions: Array<{ name: string; start: number; end: number }> = [];
  for (const statement of sf.statements) {
    let decl: ts.Node | undefined;
    let name: string | undefined;
    if (ts.isFunctionDeclaration(statement)) {
      decl = statement;
      name = statement.name?.text;
    } else if (ts.isVariableStatement(statement)) {
      const d = statement.declarationList.declarations[0];
      if (d !== undefined && ts.isIdentifier(d.name) && d.initializer !== undefined
        && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
        decl = d.initializer;
        name = d.name.text;
      }
    }
    if (decl !== undefined && name !== undefined) functions.push({ name, start: decl.getStart(sf), end: decl.getEnd() });
  }
  return { file, source, sf, functions };
}

/** EVERY engine implementation module, parsed once. The facade is not read: it re-exports. */
const MODULES: readonly ModuleAst[] = fs.readdirSync(ENGINE_DIR)
  .filter((f) => f.endsWith(".ts"))
  .sort()
  .map((f) => parseModule(f, fs.readFileSync(path.join(ENGINE_DIR, f), "utf8")));

/** The top-level function whose AST span contains `offset` in `m`, or undefined. */
function ownerOf(m: ModuleAst, offset: number): string | undefined {
  for (const fn of m.functions) {
    if (offset >= fn.start && offset < fn.end) return fn.name;
  }
  return undefined;
}

/** One actual `name(...)` CallExpression found in the corpus. */
interface CallRecord {
  file: string;
  /** Byte offset of the callee identifier inside its own module's source. */
  offset: number;
  /** The top-level function containing the call, or undefined at module scope. */
  owner: string | undefined;
}

/**
 * Every direct or property-access call of any of `names` across `modules`, as
 * AST CallExpressions. Comments, prose and import specifiers can never
 * match; a call nested in a callback inside a top-level function still reports
 * that function as its owner, so a helper wrapper cannot hide it.
 */
function collectCalls(modules: readonly ModuleAst[], names: readonly string[]): CallRecord[] {
  const wanted = new Set(names);
  const out: CallRecord[] = [];
  for (const m of modules) {
    const walk = (n: ts.Node): void => {
      const callee = ts.isCallExpression(n) ? n.expression : undefined;
      const name = callee !== undefined && ts.isIdentifier(callee) ? callee.text
        : callee !== undefined && ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
      if (name !== undefined && wanted.has(name)) {
        out.push({ file: m.file, offset: n.getStart(m.sf), owner: ownerOf(m, n.getStart(m.sf)) });
      }
      n.forEachChild(walk);
    };
    walk(m.sf);
  }
  return out;
}

/** The module that defines the top-level function `name` (per FUNCTION_OWNERS). */
function ownerModule(name: string): ModuleAst {
  const expected = FUNCTION_OWNERS[name];
  expect(expected, `${name} must have a reviewed owner module in FUNCTION_OWNERS`).toBeDefined();
  const found = MODULES.filter((m) => m.functions.some((f) => f.name === name));
  expect(
    found.map((m) => m.file),
    `${name} must be defined in exactly one engine module`,
  ).toEqual([expected]);
  return found[0]!;
}

/** The AST span of the top-level function `name` inside its owner module. */
function functionSpan(name: string): { module: ModuleAst; start: number; end: number } {
  const module = ownerModule(name);
  const fn = module.functions.find((f) => f.name === name)!;
  return { module, start: fn.start, end: fn.end };
}

/** The full declaration text of `name`, from its own module only. */
function functionBody(name: string): string {
  const span = functionSpan(name);
  return span.module.source.slice(span.start, span.end);
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

/** The actual AST call records of `name` inside the span of function `fn`. */
function callsOfIn(name: string, fn: string): CallRecord[] {
  const span = functionSpan(fn);
  return collectCalls([span.module], [name]).filter((c) => c.offset >= span.start && c.offset < span.end);
}

describe("FX-K static ordering fence: every booking producer is classified, and the one pass books what ships", () => {
  it("resolves the spans this fence reasons over (guards the parse itself)", () => {
    const names = new Set<string>([
      "dedupeTrimAndPersist", FINALIZE, SHIPPED_PASS, "captureServedPack", "shippedSurfaces",
      ...PRODUCERS.flatMap((producer) => producer.sites.map((site) => site.enclosing)),
    ]);
    for (const name of names) {
      const span = functionSpan(name);
      const body = span.module.source.slice(span.start, span.end);
      expect(body.length, `${name}'s span in ${span.module.file} must be non-trivial`).toBeGreaterThan(200);
      // A runaway span (a broken parse) would swallow the rest of the module
      // and make every classification below meaningless.
      expect(body.length, `${name}'s span must not run away`).toBeLessThan(120_000);
    }
    // The corpus itself is guarded: the engine directory must be the real one.
    expect(MODULES.length, "the engine directory must hold the extracted modules").toBeGreaterThan(50);
  });

  it("THE FENCE: every call site of every booking producer is covered by an allowlist entry with a reason", () => {
    for (const producer of PRODUCERS) {
      const records = collectCalls(MODULES, [producer.name]);
      const expected = producer.sites.reduce((sum, site) => sum + site.count, 0);
      expect(
        records.length,
        `${producer.name}: ${records.length} call sites across the engine modules, `
        + `${expected} allowlisted. A new booking site must be added to PRODUCERS with a reason `
        + `(FX-K: no producer may assert what a pack served from an unclassified position).`,
      ).toBe(expected);
      const byFunction = new Map<string, number>();
      for (const record of records) {
        expect(
          record.owner,
          `${producer.name} at ${record.file}:${record.offset} is called at module scope, `
          + "outside every top-level function this fence classifies",
        ).toBeDefined();
        expect(
          producer.sites.some((site) => site.enclosing === record.owner),
          `${producer.name} at ${record.file}:${record.offset} is called from ${record.owner}, `
          + "a function this fence does not classify — add it to PRODUCERS with a justification",
        ).toBe(true);
        expect(record.file, `${producer.name}'s classified owner must be in its reviewed module`)
          .toBe(FUNCTION_OWNERS[record.owner!]);
        byFunction.set(record.owner!, (byFunction.get(record.owner!) ?? 0) + 1);
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
    const body = functionBody(FINALIZE);
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
    const body = functionBody("dedupeTrimAndPersist");
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
    const body = withoutComments(functionBody(SHIPPED_PASS));
    // FX-J gated the whole pass on `deferred === undefined ? undefined : ...`.
    expect(body, "the projection must not be flag-selected").toMatch(
      /const shipped = shippedSurfaces\(returned\);/,
    );
    expect(body, "no producer may be gated on a deferral sentinel")
      .not.toMatch(/shipped !== undefined/);
    // The pass's own caller must build the bookings object unconditionally.
    const caller = withoutComments(functionBody("dedupeTrimAndPersist"));
    expect(caller).toMatch(/const pendingBookings: PendingPackBookings = \{/);
    expect(caller, "FX-K: the booking position must not depend on sfDemoteEnabled()")
      .not.toMatch(/sfDemoteEnabled\(\)\s*$/m);
    // And the retired pre-seam booking site must stay retired, in every module.
    for (const m of MODULES) {
      expect(
        m.source.includes("bookPreSeamPackServeState"),
        `bookPreSeamPackServeState was collapsed into the single pass (FX-K) but reappears in ${m.file}`,
      ).toBe(false);
    }
  });

  it("the shipped pass derives every booking from ONE `shippedSurfaces` projection", () => {
    const body = functionBody(SHIPPED_PASS);
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
    // byte-budget fallback exit, both asserted above) — across ALL modules.
    const allPassCalls = collectCalls(MODULES, [SHIPPED_PASS]);
    const dedupeSpan = functionSpan("dedupeTrimAndPersist");
    const inDedupe = allPassCalls.filter(
      (c) => c.file === dedupeSpan.module.file && c.offset >= dedupeSpan.start && c.offset < dedupeSpan.end,
    );
    expect(allPassCalls.length, "bookShippedPackServeState may only be called from dedupeTrimAndPersist")
      .toBe(inDedupe.length);
    expect(inDedupe.length).toBeGreaterThan(0);
  });

  it("`shippedSurfaces` is the only definition of 'what this response shipped', reused rather than re-derived by every consumer", () => {
    const definitions = MODULES.flatMap((m) => m.functions.filter((f) => f.name === "shippedSurfaces"));
    expect(definitions.length, "exactly one shippedSurfaces definition across the engine").toBe(1);
    expect(functionBody("shippedSurfaces")).toMatch(/return primaryEnumContextRows\(servedBodySurfaces\(result\)\);/);
    expect(functionBody("servedBodySurfaces")).toMatch(/return codeTaskPackSurfaces\(result\.surfaces\)\.filter\(hasServedCode\);/);
    expect(collectCalls(MODULES, ["servedBodySurfaces"])).toHaveLength(1);
    expect(callsOfIn("servedBodySurfaces", "shippedSurfaces")).toHaveLength(1);
    // FX-K (round-15 finding 3): the certified-working-set writer used to take
    // its OWN projection, over `trimmed` rather than over the pack that ships.
    // It now receives the one list, so `rememberCertifiedWorkingSet` itself has
    // zero call sites of `shippedSurfaces` (asserted below) — that invariant is
    // unchanged.
    //
    // FIX-ORIG (2026-09-27): a SECOND call site was added deliberately —
    // buildAnswerTaskPack's post-answer-augmenter re-booking (see
    // sfBookingOrderFence's recordPackServedRanges/recordReadOnlyServedSurfaces
    // entries for the full reason) — over `finalResult`, the SAME final pack
    // bookShippedPackServeState's own call already projects. Two call sites of
    // the ONE canonical definition, both consuming — never re-deriving — "what
    // shipped", is exactly what this test's own name asks for; a call site
    // duplicating the FILTER LOGIC instead (the anti-pattern round-15 finding 3
    // fixed) would still be caught by the single-definition assertion above.
    expect(collectCalls(MODULES, ["shippedSurfaces"]).length).toBe(2);
    expect(callsOfIn("shippedSurfaces", "rememberCertifiedWorkingSet").length).toBe(0);
    expect(
      withoutComments(functionBody("rememberCertifiedWorkingSet")),
      "the certified working set must consume the list it is handed",
    ).toMatch(/const surfaces = shipped;/);
    expect(
      callsOfIn("shippedSurfaces", "buildAnswerTaskPack").length,
      "the second call site is buildAnswerTaskPack's post-augmenter re-booking",
    ).toBe(1);
  });

  it("rejects the cheapest ways to smuggle a producer past the textual check", () => {
    for (const m of MODULES) {
      const stripped = withoutComments(m.source);
      for (const producer of PRODUCERS) {
        // `const book = recordServedSurfaces;` / `= recordServedSurfaces,`
        const ALIAS_FORMS = new RegExp(`=\\s*${producer.name}\\s*[;,\\)\\]}]`);
        expect(
          ALIAS_FORMS.test(stripped),
          `${producer.name} must not be aliased in ${m.file} — this fence counts call sites`,
        ).toBe(false);
      }
    }
  });

  it("regression: a new unclassified producer call in ANOTHER engine module is detected", () => {
    // A synthetic module — nothing is written to disk — shaped like a real
    // engine owner module, with one allowlisted call and one NEW call from an
    // unclassified function. The audit must report exactly the new site.
    const legitimate = parseModule("servedStateAndEdits.ts", [
      "export function bookShippedPackServeState(ws: string) {",
      "  recordServedSurfaces(ws, ws, [], 0);",
      "}",
    ].join("\n"));
    const synthetic = parseModule("syntheticForeign.ts", [
      "export function someNewHelper(ws: string) {",
      "  namespace.recordServedSurfaces(ws, ws, [{ path: 'a' }], 0);",
      "}",
    ].join("\n"));
    const records = collectCalls([legitimate, synthetic], ["recordServedSurfaces"]);
    expect(records.length).toBe(2);
    const classified = records.filter((r) =>
      PRODUCERS.find((p) => p.name === "recordServedSurfaces")!
        .sites.some((s) => s.enclosing === r.owner));
    expect(classified.length).toBe(1);
    expect(classified[0]!.owner).toBe(SHIPPED_PASS);
    const smuggled = records.find((r) => r.owner === "someNewHelper");
    expect(smuggled, "the new call must be found").toBeDefined();
    expect(
      PRODUCERS.find((p) => p.name === "recordServedSurfaces")!.sites
        .some((s) => s.enclosing === smuggled!.owner),
      "and it must be REJECTED as unclassified by the fence's own predicate",
    ).toBe(false);
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
        /immediately\s+\*?\s*\/?\s*\/?\s*before `finalizePackServeState`/.test(text.replace(/\n\s*(?:\/\/|\*)\s*/g, " ")),
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
