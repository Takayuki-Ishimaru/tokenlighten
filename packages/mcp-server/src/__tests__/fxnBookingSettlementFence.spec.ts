/**
 * fxnBookingSettlementFence.spec.ts — FX-N's STATIC fence for the READ family.
 *
 * `sfBookingOrderFence.spec.ts` binds the same invariant for the TASK-PACK
 * module: every producer that asserts "this pack served these bytes" is
 * classified, and the one booking pass runs after the demotion seam. It reasons
 * only over `features/task-pack/readCodeTaskPack.ts`, which is precisely why
 * round-16's two Highs were invisible to it — both live in the RAW read family
 * (`state/session.ts`'s `recordServedRange` and `server.ts`'s batch branch),
 * where no fence existed at all.
 *
 * THE CLAIM THIS FILE BINDS (ruling (s)): for a read/search response, no
 * producer of durable write authority runs before the emission funnel. The
 * admissible union and per-address byte residency are written in ONE place,
 * `_promoteStagedServeBookings`, reachable only from the funnel's settlement.
 *
 * WHAT IT CANNOT BIND. It is textual, like its sibling: an alias or a call
 * through a wrapper is out of reach, and a producer added in another module is
 * only caught by the module-wide sweep below. The live end-to-end cases in
 * `fxnServeBookingSettlement.spec.ts` cover the behaviour.
 *
 * WHAT WOULD FAIL WITHOUT THE FIX. At `b7e2102a` the first case fails outright
 * (`recordServedRange` contains both writes), and the `noteReadServeWorkspace`
 * cases fail because neither the setter nor its `emit.ts` consumer exists.
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..");
const SESSION = fs.readFileSync(path.join(SRC, "state/session.ts"), "utf8");
const EMIT = fs.readFileSync(path.join(SRC, "protocol/emit.ts"), "utf8");
const ENVELOPE = fs.readFileSync(path.join(SRC, "protocol/envelope.ts"), "utf8");
const SERVER = fs.readFileSync(path.join(SRC, "server.ts"), "utf8");
const READ_SMALL_FILE = fs.readFileSync(path.join(SRC, "tools/readCodeSmallFile.ts"), "utf8");
const READ_TASK_PACK = fs.readFileSync(path.join(SRC, "features/task-pack/readCodeTaskPack.ts"), "utf8");

/** `text` with comment lines blanked, so prose that NAMES a producer is not a call site. */
function withoutComments(text: string): string {
  return text
    .split("\n")
    .map((line) => (/^\s*(?:\/\/|\*|\/\*)/.test(line) ? "" : line.replace(/\s\/\/.*$/, "")))
    .join("\n");
}

/**
 * Source span of a top-level function in `text`: its declaration through the
 * next column-0 construct. Same technique (and same limits) as
 * `sfBookingOrderFence.spec.ts`'s span reader — every nested statement in these
 * modules is indented, so a column-0 anchor is always the next top-level thing.
 */
function topLevelFunctionSpan(text: string, name: string): { start: number; end: number } {
  const start = text.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, "m"));
  expect(start, `top-level function ${name} must exist`).toBeGreaterThan(-1);
  const rest = text.slice(start + 1);
  const nextAnchor = rest.search(
    /^(?:export )?(?:async |declare )?(?:function |const |let |class |interface |type |\/\*\*|\/\/ ---)/m,
  );
  return { start: start + 1, end: nextAnchor === -1 ? text.length : start + 1 + nextAnchor };
}

function body(text: string, name: string): string {
  const span = topLevelFunctionSpan(text, name);
  return text.slice(span.start, span.end);
}

function callSiteOffsets(text: string, name: string): number[] {
  const lines = text.split("\n").map((line) =>
    (/^\s*(?:\/\/|\*|\/\*)/.test(line) ? "" : line.replace(/\s\/\/.*$/, "")),
  );
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  const re = new RegExp(`(?<!function )\\b${name}\\(`, "g");
  const out: number[] = [];
  for (let ln = 0; ln < lines.length; ln++) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(lines[ln]!)) !== null) out.push((lineStarts[ln] ?? 0) + m.index);
  }
  return out;
}

function enclosingOf(text: string, offset: number, names: readonly string[]): string | undefined {
  for (const name of names) {
    const span = topLevelFunctionSpan(text, name);
    if (offset >= span.start && offset < span.end) return name;
  }
  return undefined;
}

/**
 * The two writers of durable EDIT AUTHORITY in `state/session.ts`, and every
 * function allowed to call them. `reason` says why that position is honest.
 */
const AUTHORITY_WRITERS: ReadonlyArray<{
  name: string;
  sites: ReadonlyArray<{ enclosing: string; count: number; reason: string }>;
}> = [
  {
    name: "_appendAdmissible",
    sites: [
      {
        enclosing: "recordServedEditAdmissibility",
        count: 2,
        reason:
          "the task-pack booking pass's shipped projection (and, through "
          + "recordCreatedEditAdmissibility, a file this server itself wrote) — post-trim, "
          + "post-seam, from the pack that ships (FX-K).",
      },
      {
        enclosing: "recordExecutionContract",
        count: 4,
        reason:
          "the certificate lift, already intersected with per-address residency by FX-L "
          + "(ruling (r)) — two sites in the answer-sub-read branch, two in the install tail.",
      },
      {
        enclosing: "_promoteStagedServeBookings",
        count: 1,
        reason:
          "FX-N (ruling (s)): the ONE promotion of a raw read's staged booking, reachable "
          + "only from the funnel's settlement, keyed on the finalized wire.",
      },
    ],
  },
  {
    name: "_markEditResidency",
    sites: [
      {
        enclosing: "recordWithheldEditAddresses",
        count: 2,
        reason: "FX-L's `withheld` complement of the same post-trim booking pass.",
      },
      {
        enclosing: "recordServedEditAdmissibility",
        count: 2,
        reason: "the `shipped` half of the same pass, run before the withheld complement.",
      },
      {
        enclosing: "_promoteStagedServeBookings",
        count: 1,
        reason: "FX-N: see above — the single promotion point for the raw read family.",
      },
    ],
  },
];

describe("FX-N static fence: no read-family booking producer runs before the funnel", () => {
  it("`recordServedRange` writes NO edit authority — the two statements round-16 finding 1 rode are gone", () => {
    const producer = withoutComments(body(SESSION, "recordServedRange"));
    expect(
      producer,
      "FX-N: the admissible-union enrolment must be STAGED, not written, at booking time "
      + "(round-16 finding 1b: a byte-free refusal granted write authority)",
    ).not.toMatch(/_appendAdmissible\(/);
    expect(
      producer,
      "FX-N: the `shipped` residency mark must be STAGED, not written, at booking time "
      + "(round-16 finding 1c: a byte-free read laundered an FX-L `withheld` address)",
    ).not.toMatch(/_markEditResidency\(/);
    // What it DOES do: register the session for settlement, and book the span
    // provisionally. Both are what the promotion is derived from.
    expect(producer).toMatch(/_pendingServeSessionKeys\.add\(sessionKeyFor\(workspaceRoot\)\)/);
    expect(producer).toMatch(/session\.pendingServeSpans\.push\(/);
  });

  it("every call site of every edit-authority writer sits in an allowlisted function", () => {
    const enclosingNames = [
      ...new Set(AUTHORITY_WRITERS.flatMap((writer) => writer.sites.map((site) => site.enclosing))),
    ];
    for (const writer of AUTHORITY_WRITERS) {
      const offsets = callSiteOffsets(SESSION, writer.name);
      const expected = writer.sites.reduce((sum, site) => sum + site.count, 0);
      expect(
        offsets.length,
        `${writer.name}: ${offsets.length} call sites in state/session.ts, ${expected} allowlisted. `
        + "A new write-authority site must be added here with a reason (ruling (s): authority is "
        + "written once per call, after the wire is final).",
      ).toBe(expected);
      const byFunction = new Map<string, number>();
      for (const offset of offsets) {
        const enclosing = enclosingOf(SESSION, offset, enclosingNames);
        expect(
          enclosing,
          `${writer.name} at offset ${offset} is called from a function this fence does not classify`,
        ).toBeDefined();
        byFunction.set(enclosing!, (byFunction.get(enclosing!) ?? 0) + 1);
      }
      for (const site of writer.sites) {
        expect(site.reason.length, `${writer.name}@${site.enclosing} needs a real reason`).toBeGreaterThan(40);
        expect(
          byFunction.get(site.enclosing) ?? 0,
          `${writer.name} must be called exactly ${site.count}x in ${site.enclosing}`,
        ).toBe(site.count);
      }
    }
  });

  it("the promotion is reachable only from the settlement, and the settlement only from the funnel", () => {
    const promotionSites = callSiteOffsets(SESSION, "_promoteStagedServeBookings");
    // FX-O1 (ruling (t)): ONE exit. The fail-open arm — which promoted every
    // pending staged path whenever the projector could not attribute a body —
    // is deleted; an unattributable response now corroborates an empty window
    // list and falls through the normal tail, promoting nothing.
    expect(promotionSites.length, "one settlement exit: the corroborated tail").toBe(1);
    for (const offset of promotionSites) {
      expect(
        enclosingOf(SESSION, offset, ["_settleSessionServeBookings"]),
        "the promotion may only run inside the settlement",
      ).toBe("_settleSessionServeBookings");
    }

    // Module sweep: the funnel tail is the ONLY non-test caller of the settlement.
    const callers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "__tests__" || entry.name === "node_modules" || entry.name === ".tokenlighten") continue;
          walk(abs);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        const text = withoutComments(fs.readFileSync(abs, "utf8"));
        // Windows: path.relative returns native backslashes; both the
        // exclusion literal below and the final "protocol/emit.ts" assertion
        // are forward-slash, so normalize once here for both.
        const rel = path.relative(SRC, abs).split(path.sep).join("/");
        if (rel === "state/session.ts") continue;
        if (/\bsettleServedCallBookings\(/.test(text) || /\bsettleServedRanges\(/.test(text)) callers.push(rel);
      }
    };
    walk(SRC);
    expect(
      callers.sort(),
      "ruling (s): the settlement runs at the ONE emission point and nowhere else",
    ).toEqual(["protocol/emit.ts"]);
  });

  it("`emit.ts` settles for reads as well as edits, and only after the wire is final", () => {
    const funnel = withoutComments(body(EMIT, "emitFinalizedPayload"));
    const ladderAt = funnel.indexOf("runLadder({");
    const requiredSetAt = funnel.indexOf("enforceRequiredSet(");
    const settleAt = funnel.indexOf("settleServedCallBookings(");
    expect(ladderAt, "the ladder must run in the funnel").toBeGreaterThan(-1);
    expect(requiredSetAt).toBeGreaterThan(-1);
    expect(settleAt, "the funnel must settle").toBeGreaterThan(-1);
    expect(settleAt, "settlement runs against the POST-shed payload").toBeGreaterThan(ladderAt);
    expect(settleAt, "and after the required-set judgment that can replace the payload")
      .toBeGreaterThan(requiredSetAt);
    expect(
      funnel,
      "FX-N: the read-scoped slot must feed the settlement — gating on `context.workspace` alone "
      + "is the dead guard round-16 finding 1 rode (its only writer is the edit dispatch)",
    ).toMatch(/context\.readServeWorkspace/);
    expect(funnel, "the corroboration is the finalized payload's own windows")
      .toMatch(/settleServedCallBookings\(\s*servedWindowsOf\(current,/);
    expect(
      funnel,
      "FX-O1 (ruling (t)): the funnel must pass the staged attribution, or the two pathless "
      + "serve shapes (mode=symbol's scope view, mode=auto's small-content serve) project "
      + "`unattributed` and the now fail-closed settlement retracts their honest bookings",
    ).toMatch(/servedWindowsOf\(current, serveAttribution\)/);
    expect(
      funnel,
      "an ambiguous attribution (two different paths staged in one call) is a NON-answer",
    ).toMatch(/context\.serveAttributionPath !== ""/);
    // FX-W3 (ruling (aa)): the settlement's THIRD input — whether ANY
    // wire-level shedding touched this response at all — must be derived from
    // the ladder's OWN shed record, never from the wire text, so a shed
    // response can never widen a staged claim (round-21A finding 1) while an
    // unshed one may still be widened downstream, in `state/session.ts`,
    // using a fact recorded at STAGING time.
    expect(
      funnel,
      "ruling (aa): a shed response must never be allowed to widen a staged claim",
    ).toMatch(/const wasShed = ladder\.records\.length > 0;/);
    expect(
      funnel,
      "the shed signal must actually reach the settlement, as its own explicit argument",
    ).toMatch(/settleServedCallBookings\(\s*servedWindowsOf\(current, serveAttribution\),\s*[\s\S]{0,200}?wasShed,\s*\)/);
  });

  it("FX-O1: settlement reads FILE coordinates — the display-range widening rule is gone", () => {
    const projector = withoutComments(body(ENVELOPE, "servedWindowsOf"));
    expect(
      projector,
      "ruling (t): the `synthesizedWholeServe` rule widened a wire-trimmed line-1 slice to the "
      + "WHOLE file, so the settlement confirmed exactly the span it was written to retract "
      + "(round-17 finding 1). It must not come back.",
    ).not.toMatch(/synthesizedWholeServe/);
    expect(
      ENVELOPE,
      "and neither may the line-count helper it was built on",
    ).not.toMatch(/_bodyLineCount/);
    // FX-W3 (ruling (aa), round-21A finding 1): round-17's fix — re-deriving
    // the reach by re-parsing the served BODY for marker-shaped lines
    // (`servedSpansOfDisplayedText(range[0], carried as string)`, with no
    // ceiling) — is ITSELF the defect round-21A broke: a caller's own file
    // content that merely LOOKS like a TL elision marker is indistinguishable
    // from a genuine one by that walk, and combined with an ordinary
    // `budget.bytes` shed it inflated the corroborated window past what the
    // wire actually carried. Neither the walk nor its trust-multiplier
    // band-aid may return here.
    expect(
      projector,
      "the corroboration walk must never re-parse the served body for marker-shaped lines",
    ).not.toMatch(/servedSpansOfDisplayedText/);
    expect(
      ENVELOPE,
      "and the import must be gone too — nothing in this module may reach for it",
    ).not.toMatch(/from "\.\.\/util\/formatCompress\.js"/);
    expect(
      projector,
      "ruling (aa): this projector NEVER widens — both the synthetic and ordinary cases take the "
      + "declared window VERBATIM; the `seh6` widening need moved downstream, to "
      + "`state/session.ts`'s `_settleSessionServeBookings`, which alone may widen a window this "
      + "function already produced, using a fact recorded at STAGING time",
    ).toMatch(/windows\.push\(\{ path: scopePath, start: range\[0\], end: range\[1\] \}\);/);
    expect(
      projector,
      "a TokenLighten synthetic rendering (skeleton/scope) is not a body window (ruling (s))",
    ).toMatch(/_isSyntheticRendering\(carried as string\)/);
  });

  it("FX-W3 (ruling (aa)): the seh6 widening lives in the settlement, keyed to a fact recorded at STAGING time, and only when nothing was shed", () => {
    const settle = withoutComments(body(SESSION, "_settleSessionServeBookings"));
    expect(
      settle,
      "the shed signal defaults CONSERVATIVELY (narrow-only) so every pre-existing direct caller "
      + "of this function (the unit specs) keeps its exact prior behavior",
    ).toMatch(/wasShed: boolean = true/);
    expect(
      settle,
      "a window is widened only from THIS response's own recorded true extent for the SAME path — "
      + "never manufactured for a path the wire's own corroboration did not already mention",
    ).toMatch(/const extentEnd = renderedExtent\.get\(window\.path\);/);
    expect(
      settle,
      "and only outward — a window already reaching further than the recorded extent is untouched",
    ).toMatch(/extentEnd !== undefined && extentEnd > window\.end/);
    expect(
      settle,
      "a shed response (or one with nothing recorded) settles against the corroboration's OWN "
      + "windows, unmodified",
    ).toMatch(/const windows = wasShed \|\| renderedExtent\.size === 0\s*\n\s*\? corroboration\.windows/);

    const recorder = withoutComments(body(SESSION, "recordServedRange"));
    expect(
      recorder,
      "the true extent is recorded from the caller's OWN declared provenance window, never from "
      + "wire text, so a narrow slice's own extent never widens past its own request",
    ).toMatch(/const declaredWindow = _parseHandleLineRange\(provenance\.range\);/);
    expect(recorder).toMatch(
      /session\.pendingRenderedExtent\.set\(filePath, Math\.max\(priorExtent \?\? 0, declaredWindow\.end\)\);/,
    );
  });

  it("FX-O1: every server.ts staging site is attributable — by its own wire `path`, or on the context", () => {
    // Every `recordServedRange` site in `server.ts` is classified one of two
    // ways. `wire`: the payload the branch returns carries a `path` the
    // projector's walk finds in scope — the governed full head, the whole-file
    // expansion, the ledger-difference segments, the handles batch, the slice
    // and slice-continuation doors, and (FX-O2's, added alongside this wave)
    // the artifact and verification-kit sites. `context`: it does NOT, and the
    // branch must publish `noteServeAttribution` — measured live (FX-O1 probe
    // sweep over 27 production shapes, and `fxoServeCoordinateSettlement`'s own
    // sweep case): exactly `mode=symbol`, which returns `{...symbolData, code,
    // handle, sha}`, and `mode=auto`'s small-content branch, which returns
    // `{content, language, handle, sha}`.
    //
    // Counted as a floor, not an equality: this wave lands beside FX-O2, whose
    // own booking sites are additions to the same file. The BEHAVIOURAL fence
    // for "a new site is attributable" is the live sweep in
    // `fxoServeCoordinateSettlement.spec.ts`, which drives real dispatches and
    // asserts that every shape which stages also ends with its ledger intact.
    const sites = callSiteOffsets(SERVER, "recordServedRange");
    expect(sites.length, "the raw-read family's booking sites").toBeGreaterThanOrEqual(9);
    const attributions = callSiteOffsets(SERVER, "noteServeAttribution");
    expect(
      attributions.length,
      "exactly the two pathless serve shapes publish an attribution",
    ).toBe(2);
    const stripped = withoutComments(SERVER);
    expect(
      stripped,
      "the symbol branch attributes before staging the symbol's file spans",
    ).toMatch(/noteServeAttribution\(filePath\);\s*const symCall = beginServeCall\(workspace\);/);
    expect(
      stripped,
      "the auto small-content branch attributes before staging its whole-file spans",
    ).toMatch(/noteServeAttribution\(filePath\);\s*const autoSmallServeCall = beginServeCall\(workspace\);/);
  });

  it("`readServeWorkspace` is a dedicated slot: set for both read tools, read by one consumer", () => {
    // Declared and written only in the envelope; never merged into `workspace`.
    expect(ENVELOPE).toMatch(/readServeWorkspace\?: string;/);
    expect(withoutComments(ENVELOPE)).toMatch(
      /export function noteReadServeWorkspace\(root: string\): void \{[\s\S]*?context\.readServeWorkspace = root;/,
    );
    expect(
      withoutComments(ENVELOPE),
      "the read slot must never be aliased onto the edit-only `workspace` field",
    ).not.toMatch(/context\.workspace = .*readServeWorkspace/);

    const serverCalls = callSiteOffsets(SERVER, "noteReadServeWorkspace");
    expect(serverCalls.length, "exactly one dispatch-entry call site").toBe(1);
    // Offsets from `callSiteOffsets` address the UNTOUCHED source (comment
    // lines are blanked in place, so line indices survive), so slice `SERVER`.
    const around = SERVER.slice(Math.max(0, serverCalls[0]! - 400), serverCalls[0]! + 120);
    expect(around, "both read-family tools must publish it").toMatch(
      /canonical === "read_file" \|\| canonical === "search_files"/,
    );
  });

  it("FX-P1: the edit-admissibility predicate has ONE implementation, and the gate is one of its callers", () => {
    // INV-I-1's root cause was not a missing rule but a missing CONSULTATION:
    // per-address residency had exactly one reader (`recordExecutionContract`'s
    // certificate lift), so a pack that installs no certificate — a `discover`
    // decision under a byte cap — left every write form ungated. The three
    // consumers must keep reading the same function, or the gate refuses what
    // the recovery cannot restore (round-16 finding 3 was that disagreement in
    // the path-resolution half).
    //
    // round-18A finding 6 / ruling (r)-(u-2) had briefly added a FOURTH
    // consumer here: `guardExecutionEdit`'s foreign-lane exception asked this
    // SAME predicate, file-granularly (`_editAddressResidency(session, "",
    // path) === "shipped"`), whether the redeeming lane held ANY authority
    // over the handle's file. Ruling (w) (round-19A, 2026-09-04) REVOKES that
    // consumer: file-granular admission let a lane that read 10 of 700 lines
    // redeem a foreign handle naming a disjoint 10-line range it never saw
    // (`fxq2RangeGranularForeignHandle.spec.ts`). The foreign-lane exception
    // now asks a DIFFERENT, range-precise question — `_foreignHandleRangeCovered`
    // (checked separately below) — not "did this session ship these bytes" at
    // all, so `guardExecutionEdit` is deliberately no longer in this
    // allowlist and the call-site floor drops back to the pre-round-18A 4.
    const stripped = withoutComments(SESSION);
    const readers = callSiteOffsets(SESSION, "_editAddressResidency");
    expect(
      readers.length,
      "ruling (r): one predicate for 'did this session ship these bytes'. A new consumer must be "
      + "added here with a reason.",
    ).toBeGreaterThanOrEqual(4);
    for (const offset of readers) {
      expect(
        enclosingOf(SESSION, offset, [
          "_withheldEditAddresses",   // the gate's own request-side question
          "executionRefusal",         // FX-N's capped-recovery match
          "recordExecutionContract",  // FX-L's certificate lift
        ]),
        `_editAddressResidency at offset ${offset} is read from a function this fence does not classify`,
      ).toBeDefined();
    }
    // ruling (w) (round-19A, 2026-09-04): the foreign-lane exception's OWN
    // predicate, `_foreignHandleRangeCovered`, must have exactly the ONE
    // caller the gate itself provides — no ad-hoc second consumer asking the
    // same range-coverage question a different way.
    const rangeReaders = callSiteOffsets(SESSION, "_foreignHandleRangeCovered");
    expect(
      rangeReaders.length,
      "ruling (w): one predicate for 'does the redeeming lane's own ledger cover this exact "
      + "range'. A new consumer must be added here with a reason.",
    ).toBe(1);
    for (const offset of rangeReaders) {
      expect(
        // IL-W2 renamed the gate's predicate-calling body to
        // `guardExecutionEditCore` and left `guardExecutionEdit` as a thin
        // wrapper (asserted separately below) that only delegates and
        // records `intentEditObserved` — the predicate call itself now
        // lives in the core, so that is the function this fence classifies.
        enclosingOf(SESSION, offset, ["guardExecutionEditCore"]),
        `_foreignHandleRangeCovered at offset ${offset} is read from a function this fence does not classify`,
      ).toBeDefined();
    }
    // The residency MAPS themselves must not gain a fourth ad-hoc reader that
    // bypasses the predicate. `_markEditResidency`/`_editAddressResidency` are
    // the only functions allowed to touch them directly.
    for (const map of ["editHandleResidency", "editPathResidency"]) {
      const direct = callSiteOffsets(SESSION, `session\\.${map}\\.get`);
      for (const offset of direct) {
        expect(
          enclosingOf(SESSION, offset, ["_editAddressResidency"]),
          `session.${map}.get at offset ${offset} bypasses the one predicate`,
        ).toBe("_editAddressResidency");
      }
    }
    // And the gate must actually ask it, on the exit INV-I-1 rode. IL-W2
    // (commit 13d83fbc) renamed this body to `guardExecutionEditCore` and
    // left `guardExecutionEdit` as a thin wrapper around it — the predicate
    // calls this fence binds now live in the core, so that is what must be
    // read here.
    const gate = withoutComments(body(SESSION, "guardExecutionEditCore"));
    expect(
      gate,
      "INV-I-1: `if (fence === undefined || … revoked || … done) return { allowed: true }` was the "
      + "blind exit — a capped DISCOVERY pack installs no fence at all",
    ).toMatch(/_withheldEditAddresses\(session, args, resolveHandlePath\)/);
    expect(
      gate,
      "INV-I-2: and the same exit must reject a handle minted in another agent lane",
    ).toMatch(/resolveHandleLane\?\.\(handle\)/);
    expect(
      gate,
      "ruling (w): the same exit must ask the RANGE-precise predicate, not merely the file-granular "
      + "`_editAddressResidency`, before admitting a foreign-lane handle",
    ).toMatch(/_foreignHandleRangeCovered\(/);
    expect(
      stripped,
      "the request-side question reads BOTH vocabularies, so no write form can dodge it",
    ).toMatch(/requestedEditHandles\(args\)[\s\S]{0,400}?requestedEditPaths\(args\)/);

    // IL-W2's split must stay a split: `guardExecutionEdit` may delegate to
    // `guardExecutionEditCore` exactly once and record the post-decision
    // `intentEditObserved` fact, but it must never grow back into a second
    // gate that calls the predicate itself or manufactures its own admit —
    // that would let a future edit re-decide admissibility outside the one
    // place this whole fence binds.
    const wrapper = withoutComments(body(SESSION, "guardExecutionEdit"));
    expect(
      wrapper,
      "guardExecutionEdit must not call the withheld-addresses predicate directly — only "
      + "guardExecutionEditCore may",
    ).not.toMatch(/_withheldEditAddresses\(/);
    expect(
      wrapper,
      "guardExecutionEdit must not call the range-precise foreign-lane predicate directly — only "
      + "guardExecutionEditCore may",
    ).not.toMatch(/_foreignHandleRangeCovered\(/);
    expect(
      wrapper,
      "guardExecutionEdit must not construct its own admit — it forwards guardExecutionEditCore's decision",
    ).not.toMatch(/return\s*\{\s*allowed:\s*true/);
    const wrapperCoreCalls = wrapper.match(/\bguardExecutionEditCore\(/g) ?? [];
    expect(
      wrapperCoreCalls.length,
      "guardExecutionEdit must delegate to guardExecutionEditCore exactly once",
    ).toBe(1);
  });

  it("round-18A finding 2 / ruling (v): no early `return {allowed:true}` in `guardExecutionEdit` precedes its FIRST predicate call", () => {
    // `fxnBookingSettlementFence`'s OWN prior test above proves the predicate
    // is CALLED from an allowlisted function; it never proved WHERE, relative
    // to every OTHER exit, the gate's own call sits. That gap is exactly what
    // round-18A finding 2 rode: `taskEpoch === "new"` returned
    // `{ allowed: true, resetForNewTask: true }` several statements before
    // `_withheldEditAddresses` ever ran — a call-site enumeration (the
    // previous test) is blind to that, because the predicate WAS called
    // later in the same function; it just came too late to matter.
    //
    // IL-W2 (commit 13d83fbc) renamed this body to `guardExecutionEditCore`
    // and left `guardExecutionEdit` as a thin wrapper — every exit and
    // predicate call this test orders (the grounded-create admit, the
    // predicate call, the epoch-reset admit) lives in the core now, and the
    // wrapper-shape assertions in the FX-P1 test above prove the wrapper
    // itself introduces no exit of its own for this ordering to miss.
    const gate = withoutComments(body(SESSION, "guardExecutionEditCore"));
    const firstPredicateCall = gate.indexOf("_withheldEditAddresses(session, args, resolveHandlePath)");
    expect(firstPredicateCall, "the predicate must be called somewhere in the gate").toBeGreaterThan(-1);
    const before = gate.slice(0, firstPredicateCall);

    // Every `allowed: true` textually BEFORE the first predicate call must be
    // part of the ONE exit finding 2 itself carves out as legitimately
    // out-of-scope: the grounded-create reclassification (D5/W4) — a create
    // target names a file that does not exist yet, so it has no withheld
    // bytes to hold back, and it is distinguishable on the wire by its own
    // `reclassified` key. Any OTHER pre-predicate `allowed: true` is exactly
    // the shape of the fixed defect: an admit the predicate never saw.
    const admitRe = /allowed:\s*true/g;
    let match: RegExpExecArray | null;
    let sawGroundedCreateAdmit = false;
    while ((match = admitRe.exec(before)) !== null) {
      // The grounded-create return spans several lines (`allowed: true,` then
      // a nested `reclassified: {…}` object) — a generous forward window
      // catches the whole statement without needing a brace-matching parser.
      const window = before.slice(match.index, match.index + 400);
      expect(
        window,
        "a `return {allowed:true}` before the predicate's first call must be the grounded-create "
        + "reclassification (the only exit finding 2 excuses from asking `_withheldEditAddresses`) — "
        + "any other pre-predicate admit is round-18A finding 2's exact shape",
      ).toMatch(/reclassified/);
      sawGroundedCreateAdmit = true;
    }
    expect(
      sawGroundedCreateAdmit,
      "precondition: the grounded-create exit must actually exist before the predicate, or this "
      + "fence is vacuously passing",
    ).toBe(true);

    // And the FIX's own admit — the epoch actually turning over — must be
    // textually AFTER the predicate call it now guards, not before it.
    const resetAdmitIndex = gate.indexOf("allowed: true, resetForNewTask: true");
    expect(resetAdmitIndex, "the epoch-reset admit must exist").toBeGreaterThan(-1);
    expect(
      resetAdmitIndex,
      "round-18A finding 2: the epoch-reset admit must come AFTER the predicate call that now "
      + "gates it, not before — this is the exact ordering the pre-fix code got backwards",
    ).toBeGreaterThan(firstPredicateCall);
  });

  it("FX-P1 (ruling (u)/(v)): the csv text-artifact clause corroborates its literal FILE line span, and binary containers stay excluded", () => {
    // 2026-09-03 (FX-S #1): FX-Q2 moved the csv clause's coordinate system from
    // the logical row `range` to the physical `file_range` (ruling (v)) —
    // `range`'s row numbers diverge from file lines across a blank line
    // (skipped when numbering rows) or an RFC4180 quoted multi-line field, so
    // reading `range` here could confirm a file span the producer never
    // shipped. This fence now binds the NEW shape.
    const projector = withoutComments(body(ENVELOPE, "servedWindowsOf"));
    expect(
      projector,
      "round-17 finding 3: a csv artifact's evidence is the structured `rows` table, which the "
      + "string-body walk never saw — every `read.artifact` projected `windows: []`",
    ).toMatch(/record\["form"\] === "csv"/);
    expect(
      projector,
      "ruling (v): the coordinate MUST be `file_range` (the physical file-line span), never the "
      + "logical row `range` — reading `range` as a file window confirms lines the producer never "
      + "shipped whenever the file has a blank line or a quoted multi-line field",
    ).toMatch(/parseServedRange\(record\["file_range"\]\)/);
    expect(
      projector,
      "ruling (u): EXACTLY the literal `file_range` — no reach extension, no widening",
    ).toMatch(/windows\.push\(\{ path: scopePath, start: fileRange\[0\], end: fileRange\[1\] \}\)/);
    expect(
      projector,
      "a missing/unparseable `file_range` must corroborate NOTHING (fail-closed) — it must never "
      + "fall back to the logical `range`",
    ).not.toMatch(/rowRange/);
    expect(
      projector,
      "binary containers must be excluded by NAMING the text form, not by testing for `rows` — "
      + "`form:\"xlsx.table\"` carries `rows` + `range` in SHEET coordinates",
    ).not.toMatch(/xlsx/);
  });

  it("the `mode=full` whole-file booking is shared by the single-path and batch call sites", () => {
    const helperSites = callSiteOffsets(SERVER, "bookFullFileExpansionServe");
    expect(
      helperSites.length,
      "round-16 finding 2: the paths[] batch shipped full bodies and booked nothing. Both "
      + "call sites must route through the one helper.",
    ).toBe(2);
    const stripped = withoutComments(SERVER);
    expect(
      stripped,
      "the batch branch books only the untruncated whole-file shape (a governed head books "
      + "its own narrower spans inside buildFullServePayload)",
    ).toMatch(/if \(fr\.data\["fullFileExpansion"\] === true\) \{[\s\S]{0,400}?bookFullFileExpansionServe\(workspace, p,/);
  });

  /**
   * FX-W3 (ruling (aa), 2026-09-04, round-21A finding 2): a PROPERTY-ACCESS
   * twin of `callSiteOffsets` — `state.elided`/`session.pendingElidedSpans`
   * are fields, not function calls, so the call-site finder above cannot see
   * them. Matches a bare `propName` occurrence (catches both a `receiver.prop`
   * access and an object-literal key `prop: …`), on the same
   * comment-blanked-in-place basis `callSiteOffsets` uses so offsets still
   * address the UNTOUCHED source.
   */
  function propertyReferenceOffsets(text: string, propName: string): number[] {
    const lines = text.split("\n").map((line) =>
      (/^\s*(?:\/\/|\*|\/\*)/.test(line) ? "" : line.replace(/\s\/\/.*$/, "")),
    );
    const lineStarts: number[] = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
    const re = new RegExp(`\\b${propName}\\b`, "g");
    const out: number[] = [];
    for (let ln = 0; ln < lines.length; ln++) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(lines[ln]!)) !== null) out.push((lineStarts[ln] ?? 0) + m.index);
    }
    return out;
  }

  /**
   * Source span of a top-level `interface NAME { … }` declaration, same
   * technique (and same limits) as `topLevelFunctionSpan` above — used to
   * exclude a TYPE field's own declaration (`elided: ElidedRangeEntry[];`
   * inside `ServedRangeLedgerState`, `pendingElidedSpans: Array<…>;` inside
   * `WorkspaceSession`) from the reader/writer fence below: a type
   * declaration is not a value reference, and neither interface is nested in
   * any function, so a LINE-TEXT heuristic (`name: …`) cannot tell it apart
   * from an object-literal initializer of the very same shape
   * (`_emptySession`'s `pendingElidedSpans: [],`) — only the ENCLOSING
   * DECLARATION can.
   */
  function interfaceSpan(text: string, name: string): { start: number; end: number } {
    const start = text.search(new RegExp(`^(?:export )?interface ${name} \\{`, "m"));
    expect(start, `interface ${name} must exist`).toBeGreaterThan(-1);
    const rest = text.slice(start + 1);
    const nextAnchor = rest.search(
      /^(?:export )?(?:async |declare )?(?:function |const |let |class |interface |type |\/\*\*|\/\/ ---)/m,
    );
    return { start: start + 1, end: nextAnchor === -1 ? text.length : start + 1 + nextAnchor };
  }

  it("FX-W3 (ruling (aa)), round-21A finding 2: every reader/writer of the elided-window ledger sits in the allowlisted set, and no other reader (receipts/prior/covered_by) ever touches it", () => {
    // The COMPLETE set of functions permitted to reference `state.elided` /
    // `session.pendingElidedSpans` — a writer (`_stageElisionGap`, the
    // record-time optimistic write; `transformServedRangesAcrossServerEdit`,
    // the server-edit discard), a reader (`_foreignHandleRangeCovered`, the
    // ONLY write-authority consumer), the settlement's own confirm/retract
    // pass (`_settleSessionServeBookings`), and the two initializers
    // (`_emptySession`, the whole-session constructor; `recordServedRange`,
    // which seeds a brand-new PER-FILE ledger entry's `elided: []` the same
    // way `_emptySession` seeds the session's `pendingElidedSpans: []`). A new
    // consumer must be added HERE, with a reason, or this fence fails.
    const ELIDED_ALLOWLIST = [
      "_stageElisionGap",
      "_settleSessionServeBookings",
      "_foreignHandleRangeCovered",
      "transformServedRangesAcrossServerEdit",
      "_emptySession",
      "recordServedRange",
    ] as const;

    const typeDeclarationSpans = {
      elided: interfaceSpan(SESSION, "ServedRangeLedgerState"),
      pendingElidedSpans: interfaceSpan(SESSION, "WorkspaceSession"),
    } as const;

    for (const propName of ["elided", "pendingElidedSpans"] as const) {
      const offsets = propertyReferenceOffsets(SESSION, propName);
      expect(
        offsets.length,
        `${propName}: at least the known reader/writer sites must still exist`,
      ).toBeGreaterThanOrEqual(propName === "elided" ? 6 : 4);
      const typeSpan = typeDeclarationSpans[propName];
      for (const offset of offsets) {
        // The INTERFACE's own field declaration (`elided: ElidedRangeEntry[];`
        // / `pendingElidedSpans: Array<…>;`) is a TYPE, not a value reference —
        // excluded explicitly rather than producing a false failure. An
        // object-literal initializer of the SAME textual shape
        // (`_emptySession`'s `pendingElidedSpans: [],`) is a DIFFERENT
        // declaration entirely and stays subject to the allowlist below.
        if (offset >= typeSpan.start && offset < typeSpan.end) continue;
        expect(
          enclosingOf(SESSION, offset, ELIDED_ALLOWLIST as unknown as string[]),
          `session.ts ${propName} reference at offset ${offset} is outside the allowlisted set — ruling `
          + "(aa)/(x) require every reader/writer of the elided-window ledger to be named here, and "
          + "FORBID `servedRangeReceipt`/`_coveredPiecesOfSpan`/any other receipt-shaped reader from "
          + "ever consulting it",
        ).toBeDefined();
      }
    }

    // The forbidden direction, checked by NAME rather than by absence-of-match
    // alone: the three respect-shaped functions ruling (x) explicitly excludes
    // must never mention `elided` at all, so the fence guards against a
    // synonym or destructured alias just as much as a fresh direct reference.
    for (const forbidden of ["servedRangeReceipt", "_coveredPiecesOfSpan", "materializeServedRanges"]) {
      const fnBody = withoutComments(body(SESSION, forbidden));
      expect(
        fnBody,
        `${forbidden} must stay elision-blind (ruling (x): "never use elided for receipt/prior/covered_by claims")`,
      ).not.toMatch(/\belided\b/);
    }
  });
});

/**
 * FX-W3 accounting-source fence (round-22A finding 1, LOW, ruling (aa)).
 *
 * The tests above pin the SETTLEMENT half of ruling (aa) — the wire-side
 * corroboration in `envelope.ts` never re-parses displayed text for
 * marker-shaped lines. They do NOT pin the STAGING half: that every
 * `recordServedRange` call site's OWN pushed `[start, end]` span is drawn
 * from the RENDERER's own elision accounting rather than a flat, un-excluded
 * `[requestedStart, requestedEnd]` — which would silently re-admit round-20A's
 * original defect (booking a marker's own line, or a comment block's lines, as
 * "served"). This describe block closes that gap by enumerating every
 * production call site.
 *
 * Every call site is one of:
 *   (a1) `spansExcludingWindows(start, end, X)` where `X` is an `elided` list
 *        produced by `elideDocCommentsForDisplay`/`elideDocCommentsWithWindows`
 *        (the renderer) — never a re-parse of displayed text.
 *   (a2) one of five documented "never elided" producers, each pinned by its
 *        own structural shape below: markdown sections (one literal span per
 *        section — markdown is never a C-comment/Python elision target), CSV
 *        `file_range` (`bookCsvArtifactServe` books `table.fileLineRange`, the
 *        physical span `csvTable` itself computed — ruling (v)), task_pack
 *        post-trim booking (`packServedSpans` books the surface's full `range`
 *        minus `remaining_ranges`, deliberately INCLUDING marker-covered
 *        source lines the marker still addresses), verification-kit
 *        whole-file body (`dropServedBody` books `1..totalLines` of the
 *        ALREADY-ASSEMBLED kit body verbatim), and `create` (a brand-new file
 *        has no prior content to elide, and never calls `recordServedRange`
 *        at all — see `recordCreatedEditAdmissibility`, a different producer
 *        entirely), and — FX-OH F3 (2026-09-04) — `buildFullDowngradePayload`'s
 *        comments-keep head, whose `content` is rendered VERBATIM on that
 *        branch (the W1 downgrade path applies no elision at all), so there is
 *        no renderer accounting to exclude: every line in `1..servedLines`
 *        genuinely reached the caller.
 *   (b)  an explicit allowlist entry below, each with a one-line reason.
 *
 * WHAT IT CANNOT BIND. Textual, like every other fence in this file: a call
 * routed through a same-shaped wrapper, or a new file added outside the three
 * this block reads, is out of reach beyond the whole-tree sweep at the end.
 */
describe("FX-W3 static fence: every recordServedRange call site books renderer-accounted spans", () => {
  /**
   * The full enumeration, in file order. `ALLOWLIST` entries are the ONLY
   * sites permitted to deviate from (a1)/(a2) — each carries the one-line
   * reason ruling (aa) requires. Adding a new `recordServedRange` call site
   * anywhere in the tree without adding a row here (and, if it is not a
   * plain `spansExcludingWindows`-over-`elided` site, an allowlist reason)
   * fails the enumeration-completeness check below.
   */
  const SITES: ReadonlyArray<{ id: string; category: "a1-elided" | "a2-markdown" | "a2-csv" | "a2-task-pack" | "a2-verification-kit" | "a2-comments-keep-head" | "allowlist"; reason?: string }> = [
    { id: "server.ts: bookCsvArtifactServe (mode=artifact)", category: "a2-csv" },
    { id: "server.ts: resolveFullReadForPath governed head chunk (mode=full-head)", category: "a1-elided" },
    { id: "server.ts: buildFullDowngradePayload's comments-keep head (mode=full-comments-keep)", category: "a2-comments-keep-head" },
    { id: "server.ts: bookFullFileExpansionServe (mode=full)", category: "a1-elided" },
    { id: "server.ts: buildLedgerDifferenceFullPayload's appendFresh (mode=full/auto/symbol/slice)", category: "a1-elided" },
    { id: "server.ts: dropServedBody (mode=verification-kit)", category: "a2-verification-kit" },
    { id: "server.ts: handles-batch item (mode=handles)", category: "a1-elided" },
    { id: "server.ts: multi-target paths-batch item (mode=paths)", category: "a1-elided" },
    { id: "server.ts: markdown section (mode=markdown-section)", category: "a2-markdown" },
    {
      id: "server.ts: ranges-batch segment, already-held sub-branch (mode=slice)",
      category: "allowlist",
      reason:
        "the fresh sub-branch is a1 (spansExcludingWindows over display.elided); the "
        + "already-held sub-branch re-affirms the SAME [segStart, segEnd] the ledger already "
        + "proved covered by an earlier, independently renderer-accounted booking (the probe "
        + "above this loop only sets `alreadyHeld` from a genuine `servedRangeReceipt` hit) — "
        + "it manufactures no new claim over a marker-covered line.",
    },
    { id: "server.ts: range/slice door (mode=slice)", category: "a1-elided" },
    { id: "server.ts: slice-continuation (mode=slice-cont)", category: "a1-elided" },
    { id: "server.ts: symbol scope view (mode=symbol)", category: "a1-elided" },
    { id: "server.ts: mode=auto small-content serve (mode=auto)", category: "a1-elided" },
    { id: "tools/readCodeSmallFile.ts: small_file whole-file serve (mode=small_file)", category: "a1-elided" },
    { id: "features/task-pack/readCodeTaskPack.ts: recordPackServedRanges (mode=task_pack)", category: "a2-task-pack" },
  ];

  it("enumeration is complete: exactly the known call sites exist, in exactly the known files", () => {
    // `callSiteOffsets` already excludes the definition (`function NAME(`) via
    // its negative lookbehind, so this counts CALLS only.
    const serverSites = callSiteOffsets(SERVER, "recordServedRange");
    const smallFileSites = callSiteOffsets(READ_SMALL_FILE, "recordServedRange");
    const taskPackSites = callSiteOffsets(READ_TASK_PACK, "recordServedRange");
    expect(
      serverSites.length,
      "server.ts's recordServedRange call-site count must match this file's enumeration "
      + "exactly — a new site (or a deleted one) must update SITES above, not pass silently",
    ).toBe(14);
    expect(smallFileSites.length, "readCodeSmallFile.ts's one known site").toBe(1);
    expect(taskPackSites.length, "readCodeTaskPack.ts's one known site").toBe(1);
    expect(
      SITES.length,
      "the enumeration table itself must carry exactly one row per counted call site",
    ).toBe(serverSites.length + smallFileSites.length + taskPackSites.length);

    // Whole-tree sweep (round-22A finding 1's own caveat: a producer added in
    // ANOTHER module is only caught here): no file outside the three known
    // ones may contain a `recordServedRange` call at all.
    function collectSourceFiles(dir: string, out: string[] = []): string[] {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "__tests__") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) collectSourceFiles(full, out);
        else if (entry.name.endsWith(".ts")) out.push(full);
      }
      return out;
    }
    const KNOWN_FILES = new Set([
      path.join(SRC, "server.ts"),
      path.join(SRC, "tools/readCodeSmallFile.ts"),
      path.join(SRC, "features/task-pack/readCodeTaskPack.ts"),
      path.join(SRC, "state/session.ts"), // the definition itself, excluded by callSiteOffsets's lookbehind
    ]);
    let strayTotal = 0;
    const strayFiles: string[] = [];
    for (const file of collectSourceFiles(SRC)) {
      if (KNOWN_FILES.has(file)) continue;
      const text = fs.readFileSync(file, "utf8");
      const count = callSiteOffsets(text, "recordServedRange").length;
      if (count > 0) {
        strayTotal += count;
        strayFiles.push(`${path.relative(SRC, file)} (${count})`);
      }
    }
    expect(
      strayTotal,
      "a recordServedRange call site outside the three enumerated files is unfenced by "
      + `every check below — found in: ${strayFiles.join(", ") || "none"}`,
    ).toBe(0);
  });

  // ---- a1: spansExcludingWindows over a renderer-produced `elided` list ----

  it("bookCsvArtifactServe books the CSV renderer's own physical file_range, never a re-parse", () => {
    expect(
      SERVER,
      "ruling (v): books table.fileLineRange (csvTable's own physical-line accounting), "
      + "never table.range's logical row numbers",
    ).toMatch(
      /table\.fileLineRange === undefined\) return;[\s\S]{0,400}?recordServedRange\(workspace, filePath, fileSha, start, end, Math\.max\(totalLines, end\), \{\s*mode: "artifact",\s*range: table\.fileLineRange,/,
    );
  });

  it("resolveFullReadForPath's governed head chunk books spansExcludingWindows over the renderer's chunk.elided", () => {
    expect(SERVER).toMatch(
      /const chunk = elideDocCommentsForDisplay\(head, language, keepComments\);[\s\S]{0,1100}?spansExcludingWindows\(1, servedLines, chunk\.elided\)\)\s*\{\s*recordServedRange\(workspace, filePath, sha, spanStart, spanEnd, totalLines, \{\s*mode: "full-head",/,
    );
  });

  it("bookFullFileExpansionServe books spansExcludingWindows over the renderer's display.elided", () => {
    expect(SERVER).toMatch(
      /const display = elideDocCommentsForDisplay\(content, languageForPath\(filePath\), keepComments\);[\s\S]{0,600}?spansExcludingWindows\(1, servedTotal, display\.elided\)\)\s*\{\s*recordServedRange\(\s*workspace, filePath, shaOfText\(content\), spanStart, spanEnd, servedTotal,\s*\{ mode: "full",/,
    );
  });

  it("buildLedgerDifferenceFullPayload's appendFresh books spansExcludingWindows over its own display.elided", () => {
    expect(SERVER).toMatch(
      /elideDocCommentsForDisplay\(raw, languageForPath\(args\.filePath\), false, start\);[\s\S]{0,600}?spansExcludingWindows\(start, end, display\.elided\)\)\s*\{\s*recordServedRange\(\s*args\.workspace,\s*args\.filePath,\s*args\.sha,\s*spanStart,\s*spanEnd,\s*totalLines,\s*\{ mode: args\.mode,/,
    );
  });

  it("the handles-batch item books spansExcludingWindows over the renderer's itemDisplay.elided", () => {
    expect(SERVER).toMatch(
      /elideDocCommentsForDisplay\(\s*sliceResult\.data\.content,[\s\S]{0,2000}?spansExcludingWindows\(itemStart, itemEnd, itemDisplay\.elided\)\)\s*\{\s*recordServedRange\(\s*workspace, hPath, shaOfText\(hContent\), spanStart, spanEnd, itemTotalLines,\s*\{ mode: "handles",/,
    );
  });

  it("the range/slice door books spansExcludingWindows over the renderer's sliceDisplay.elided", () => {
    expect(SERVER).toMatch(
      /const sliceDisplay = keepComments\s*\?[\s\S]{0,7500}?: elideDocCommentsForDisplay\([\s\S]{0,7500}?const servedSpans = spansExcludingWindows\(\s*actualStart,\s*actualEnd,\s*sliceDisplay\.elided,\s*\);[\s\S]{0,900}?rangeLedger = recordServedRange\(\s*workspace,\s*slicePath,\s*rawFileSha,\s*spanStart,\s*spanEnd,\s*countLines\(content\),\s*\{ mode: "slice", range: String\(sliceData\.range\),/,
    );
  });

  it("slice-continuation books spansExcludingWindows over computeSliceContinuation's own renderer-accounted elided list", () => {
    // Two facts, checked separately since the function definition and its
    // single production call site sit ~350K characters apart in this file:
    // (1) the function's OWN `elided` comes from the renderer, and (2) the
    // call site derives its booked span from THAT field via spansExcludingWindows.
    expect(
      body(SERVER, "computeSliceContinuation"),
      "computeSliceContinuation's own elided window must come from elideDocCommentsWithWindows, "
      + "never from re-parsing its own displayed text",
    ).toMatch(/elideDocCommentsWithWindows\(windowText, language, contStart\)/);
    expect(SERVER).toMatch(
      /spansExcludingWindows\(\s*continuedStart, continuedEnd, cont\.continued\.elided,\s*\)\)\s*\{\s*rangeLedger = recordServedRange\(/,
    );
  });

  it("the symbol scope view books spansExcludingWindows over an elideDocCommentsWithWindows scan of the modeled symbol body", () => {
    expect(SERVER).toMatch(
      // 2026-09-14 (v0.14.2 evaluation follow-up): window {0,1600} -> {0,2600}. The
      // symbol path gained the Trim A / `path` provenance comments (report §5,
      // review BLOCKER 5), growing the gap to 1815 chars; the booking call is
      // unchanged, so the fence widens instead of the comments being cut.
      /elideDocCommentsWithWindows\(symBodyRaw, languageForPath\(filePath\), symStart\)\.elided;\s*const symSpans = spansExcludingWindows\(symStart, symEnd, symBodyElided\);[\s\S]{0,2600}?recordServedRange\(\s*workspace,\s*filePath,\s*shaOfText\(content\),\s*spanStart,\s*spanEnd,\s*symTotalLines,\s*\{\s*mode: "symbol",/,
    );
  });

  it("mode=auto's small-content serve books spansExcludingWindows over the renderer's autoElided", () => {
    expect(SERVER).toMatch(
      /elided: autoElided \} = elideDocCommentsForDisplay\([\s\S]{0,3500}?spansExcludingWindows\(1, autoLineCount, autoElided\)\)\s*\{\s*recordServedRange\(\s*workspace, filePath, sha, spanStart, spanEnd, autoLineCount,\s*\{ mode: "auto",/,
    );
  });

  it("FX-X3: readCodeSmallFile.ts's small_file serve books spansExcludingWindows over elideDocCommentsForDisplay's own elided list (migrated off servedSpansOfDisplayedText)", () => {
    expect(
      READ_SMALL_FILE,
      "small_file must derive its booked span from the renderer's OWN elided-window "
      + "accounting, never by re-parsing displayContent for marker-shaped lines",
    ).toMatch(
      /const \{ content: displayContent, note: elisionNote, elided \} = elideDocCommentsForDisplay\([\s\S]{0,4000}?spansExcludingWindows\(1, lineCount, elided\)\)\s*\{\s*recordServedRange\(\s*workspace, resolvedPath, sha, spanStart, spanEnd, lineCount,\s*\{ mode: "small_file",/,
    );
  });

  // ---- a2: documented "never elided" producers ----

  it("the markdown section serve books ONE literal span per section — markdown is never a comment-elision target", () => {
    expect(SERVER).toMatch(
      /sectionLedger = recordServedRange\(\s*workspace, resolvedPath, rawFileSha, segStart, segEnd, fileTotalLines,\s*\{ mode: "markdown-section",/,
    );
  });

  it("FX-OH F3: the comments-keep head books 1..servedLines verbatim — that branch renders `content` with NO elision, so there is nothing to exclude", () => {
    // Two facts, checked together because they are the whole justification for
    // this site being an a2 rather than an a1: (1) the head comes from
    // `serveGovernedFullHead(content, ...)` — the RAW file text, not an elided
    // display — and (2) the booking is gated on `keepComments`, so it books
    // only the branch FX-OH F3 newly reaches.
    expect(
      SERVER,
      "the comments-keep head must book the verbatim span it shipped, gated on keepComments",
    ).toMatch(
      /const \{ head, servedLines, totalLines \} = serveGovernedFullHead\(content, GOVERNED_FULL_SERVE_BYTES\);[\s\S]{0,1200}?if \(keepComments && servedLines > 0\) \{\s*recordServedRange\(\s*workspace, filePath, sha, 1, servedLines, totalLines,\s*\{ mode: "full-comments-keep",/,
    );
    expect(
      SERVER,
      "and that branch must not elide: an elided head would need a1 accounting instead",
    ).not.toMatch(
      /serveGovernedFullHead\(elideDocComments/,
    );
  });

  it("dropServedBody books the verification kit's ALREADY-ASSEMBLED whole-file body verbatim (1..totalLines)", () => {
    expect(SERVER).toMatch(
      /markVerificationSurfaceServed\(workspace, entry\.path, shaOfText\(entry\.code\)\);[\s\S]{0,1200}?recordServedRange\(workspace, entry\.path, shaOfText\(entry\.code\), 1, totalLines, totalLines, \{\s*mode: "verification-kit",/,
    );
  });

  it("recordPackServedRanges books the task-pack's post-trim surface range (surface.range minus remaining_ranges), by design not marker-excluded", () => {
    expect(
      body(READ_TASK_PACK, "packServedSpans"),
      "packServedSpans derives its served spans from the surface's own declared range and "
      + "remaining_ranges — the surface's OWN post-trim accounting, not a fresh elision scan",
    ).toMatch(/parseSurfaceSpan\(String\(surface\.range/);
    expect(
      body(READ_TASK_PACK, "recordPackServedRanges"),
      "and recordPackServedRanges is the one place those spans reach the ledger, tagged mode=task_pack",
    ).toMatch(/recordServedRange\(workspace, relPath, sha, start, servedEnd, totalLines, \{\s*mode: "task_pack",/);
  });

  // ---- (b): explicit allowlist, one-line reasons carried in SITES above ----

  it("the one allowlisted deviation from a1/a2 is exactly, and only, the one SITES documents", () => {
    // FX-X3 (round-22B review, ruling (aa)): readCodeSmallFile.ts's small_file
    // site migrated off servedSpansOfDisplayedText onto spansExcludingWindows
    // (now pinned as an ordinary a1-elided row above) — the ranges-batch
    // already-held sub-branch is the ONLY remaining documented deviation.
    const allowlisted = SITES.filter((site) => site.category === "allowlist");
    expect(allowlisted.length, "exactly one documented deviation at HEAD").toBe(1);
    for (const site of allowlisted) {
      expect(site.reason, `allowlist entry "${site.id}" must carry a reason`).toBeTruthy();
      expect(site.reason!.length, `allowlist entry "${site.id}" reason must be non-trivial`).toBeGreaterThan(20);
    }
    // Pin the exact shape of the allowlisted deviation so a change to it
    // (tightening OR loosening) is a deliberate, reviewed edit to this fence.
    expect(
      SERVER,
      "ranges-batch already-held sub-branch: re-affirms [segStart, segEnd] verbatim, never a "
      + "fresh re-parse of displayed text",
    ).toMatch(
      /const spans = display === undefined\s*\?\s*\[\[segStart, segEnd\] as \[number, number\]\]\s*:\s*spansExcludingWindows\(segStart, segEnd, display\.elided\);/,
    );
  });

  it("servedSpansOfDisplayedText has NO remaining non-test caller — FX-X3 migrated the last one (readCodeSmallFile.ts) off it", () => {
    // `callSiteOffsets` excludes the definition (`export function
    // servedSpansOfDisplayedText(`) via its negative lookbehind, so this
    // counts CALLS only, tree-wide, comments blanked.
    function collectSourceFiles(dir: string, out: string[] = []): string[] {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "__tests__") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) collectSourceFiles(full, out);
        else if (entry.name.endsWith(".ts")) out.push(full);
      }
      return out;
    }
    const callers: string[] = [];
    for (const file of collectSourceFiles(SRC)) {
      const text = fs.readFileSync(file, "utf8");
      const count = callSiteOffsets(text, "servedSpansOfDisplayedText").length;
      for (let i = 0; i < count; i++) callers.push(path.relative(SRC, file));
    }
    expect(
      callers,
      "the marker-reparsing producer ruling (aa) forbids for fresh booking must now have ZERO "
      + "non-test, non-definition callers — a new or reintroduced caller fails here",
    ).toEqual([]);
  });
});
