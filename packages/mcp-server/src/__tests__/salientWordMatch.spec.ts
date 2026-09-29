// salientWordMatch.spec.ts — Agent H, 2026-09-19.
// Unit coverage for the whole-word, variant-aware matcher used ONLY as an
// absence veto by readCodeTaskPack.ts's `distinctiveSalientAbsence` and
// `proveUnbindableRequestItem` (see completionHonesty.spec.ts for the
// end-to-end contract this feeds). Pure functions, no workspace/corpus
// needed.

import { describe, it, expect } from "vitest";
import { inflectionVariants, textHasWordVariant } from "../features/task-pack/salientWordMatch.js";

describe("inflectionVariants", () => {
  it("always includes the lowercased original word", () => {
    expect(inflectionVariants("Validated")).toContain("validated");
    expect(inflectionVariants("cache")).toContain("cache");
  });

  it("does not derive anything for a word shorter than 3 letters, but still returns itself", () => {
    for (const word of ["is", "a", ""]) {
      expect(inflectionVariants(word)).toEqual([word.toLowerCase()]);
    }
  });

  it("never returns a DERIVED variant below 3 letters (the original always passes through regardless)", () => {
    for (const word of ["ids", "aid", "run", "box"]) {
      const variants = inflectionVariants(word);
      expect(variants).toContain(word.toLowerCase());
      for (const v of variants) {
        if (v === word.toLowerCase()) continue;
        expect(v.length).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("a CJK/katakana word passes through untouched (no rule applies, no crash)", () => {
    expect(inflectionVariants("レディスキャッシュ")).toEqual(["レディスキャッシュ"]);
    expect(inflectionVariants("キャッシュ")).toEqual(["キャッシュ"]);
  });

  it("a word with no applicable suffix rule still round-trips to plausible forward forms only", () => {
    const variants = inflectionVariants("gizmo");
    expect(variants).toContain("gizmo");
    expect(variants).toContain("gizmos");
  });

  describe("bidirectional family membership — the exact pairs this fix targets", () => {
    const families: Array<{ members: string[] }> = [
      { members: ["validate", "validated", "validating", "validates", "validation"] },
      { members: ["retry", "retried", "retries", "retrying"] },
      { members: ["notify", "notified", "notifies", "notifying", "notification", "notifications"] },
      { members: ["verify", "verified", "verifies", "verifying", "verification"] },
      { members: ["calculate", "calculated", "calculating", "calculation"] },
      { members: ["authenticate", "authenticated", "authenticating", "authentication"] },
      { members: ["invoice", "invoices"] },
      { members: ["box", "boxes"] },
      { members: ["stop", "stopped", "stopping"] },
      { members: ["run", "running"] },
    ];
    for (const { members } of families) {
      for (const start of members) {
        it(`inflectionVariants(${JSON.stringify(start)}) contains every family member ${JSON.stringify(members)}`, () => {
          const variants = new Set(inflectionVariants(start));
          for (const other of members) {
            expect(variants, `variants(${start})=${JSON.stringify([...variants])} missing ${other}`).toContain(other);
          }
        });
      }
    }
  });

  it("the const/constant pair stays a DIFFERENT family (the false-positive this fix exists to remove)", () => {
    expect(inflectionVariants("const")).not.toContain("constant");
    expect(inflectionVariants("constant")).not.toContain("const");
  });

  // -------------------------------------------------------------------------
  // held item 5 (r-b2, 2026-09-21, adversarial review) — a small derivational
  // layer beyond plain inflection, so a request naming the ABSTRACT/NOUN form
  // of a concept ("expiration", "deployment", "validator") is recognized
  // against code that implements it as the CONCRETE verb ("expire", "deploy",
  // "validate"). The reviewer's own false-completion repro
  // (`Explain how token expiration is implemented` against a file declaring
  // `expire()`) is the `textHasWordVariant` case at the end of this describe
  // block.
  // -------------------------------------------------------------------------
  describe("held item 5: derivational variants (suffix rules, not a word list)", () => {
    it("-ation/-ition/-tion/-sion families reach their verb stem (noun -> verb)", () => {
      const pairs: ReadonlyArray<[string, string]> = [
        ["validation", "validate"],
        ["expiration", "expire"],
        ["resolution", "resolve"],
        ["configuration", "configure"],
        ["migration", "migrate"],
        ["authentication", "authenticate"],
        ["invalidation", "invalidate"],
      ];
      for (const [noun, verb] of pairs) {
        expect(inflectionVariants(noun), noun).toContain(verb);
      }
    });

    it("-ation/-olution families are BIDIRECTIONAL (verb -> noun too, matching this file's own documented contract)", () => {
      // Not every new family achieves this (see the KNOWN, ACCEPTED
      // asymmetry test below) — these two specifically do, because their
      // forward partner rule is narrow enough to add without the
      // compounding risk the accepted-asymmetry test documents.
      const pairs: ReadonlyArray<[string, string]> = [
        ["validate", "validation"],
        ["expire", "expiration"],
        ["configure", "configuration"],
        ["resolve", "resolution"],
        ["revolve", "revolution"],
        ["solve", "solution"],
      ];
      for (const [verb, noun] of pairs) {
        expect(inflectionVariants(verb), verb).toContain(noun);
      }
    });

    it("-al, -ment, -ance/-ence, -er/-or agent nouns, -ity all reach their verb/adjective stem (noun -> verb)", () => {
      const pairs: ReadonlyArray<[string, string]> = [
        ["renewal", "renew"],
        ["removal", "remove"],
        ["deployment", "deploy"],
        ["acceptance", "accept"],
        ["validator", "validate"],
        ["scheduler", "schedule"],
        ["validity", "valid"],
      ];
      for (const [noun, verb] of pairs) {
        expect(inflectionVariants(noun), noun).toContain(verb);
      }
    });

    it("KNOWN, ACCEPTED asymmetry: -al/-ment/-ance-ence/-er-or/-ity are noun->verb only, same doctrine as this file's own 'built'/'build' irregular-verb gap", () => {
      // These 5 families are deliberately TERMINAL (see salientWordMatch.ts's
      // own TERMINAL_DERIVATION_RULES doc comment): generating their forward
      // (verb->noun) partner broadly enough to matter would feed a
      // manufactured "+e" candidate (e.g. "general"'s own "genere") back
      // through forward nominalisation and coincidentally spell a real,
      // unrelated word ("generation") -- confirmed live and closed by NOT
      // forward-expanding this family at all, accepting one-directional
      // coverage instead. A future dictionary-free rule that closes this
      // without reopening that collision would be a welcome improvement, not
      // a requirement of this fix.
      expect(inflectionVariants("renew")).not.toContain("renewal");
      expect(inflectionVariants("deploy")).not.toContain("deployment");
      expect(inflectionVariants("accept")).not.toContain("acceptance");
    });

    it("recall control: unrelated words do not collide with an unintended real word (station/nation named collisions)", () => {
      // CONFIRMED regression on the pre-fix tree: the pre-existing
      // nominalisation backward rule stripped "ion" unconditionally and
      // added "+e", so "station" (stem "stat") produced "state" and "nation"
      // (stem "nat") produced "nate" -- neither word is a nominalisation of
      // a verb "state"/"nate" at all. Fixed by gating that rule's stem
      // length (see NOMINALISATION_MIN_STEM_LENGTH), not by naming these two
      // words.
      expect(inflectionVariants("station")).not.toContain("state");
      expect(inflectionVariants("nation")).not.toContain("nate");
    });

    it("recall control: unrelated words do not gain a coincidentally-real, unrelated derived form (international/general/moment/element)", () => {
      // CONFIRMED regression found while building this fix: "general"'s own
      // "-al" strip ("gener"/"genere") is harmless as a non-word candidate
      // on its own, but "genere" (ending in "e") used to re-enter forward
      // nominalisation and coincidentally spell "generation" -- a REAL,
      // unrelated word. Fixed by making this whole rule family TERMINAL
      // (never forward-expanded) -- see the "KNOWN, ACCEPTED asymmetry"
      // test above and TERMINAL_DERIVATION_RULES's own doc comment.
      expect(inflectionVariants("general")).not.toContain("generation");
      expect(inflectionVariants("international")).not.toContain("internationation");
      expect(inflectionVariants("international")).not.toContain("internationition");
      // "moment"/"element" strip to "mo"/"ele" under a naive "-ment" rule --
      // both below this file's own >= 4 letter stem gate, so NEITHER
      // contributes anything beyond the plain plural/tense forms every word
      // gets.
      expect(inflectionVariants("moment")).toEqual(["moment", "moments", "momented", "momenting"]);
      expect(inflectionVariants("element")).toEqual(["element", "elements", "elemented", "elementing"]);
    });

    it("every pinned family from this file's OWN earlier describe block is unaffected (no regression)", () => {
      const families: ReadonlyArray<string[]> = [
        ["validate", "validated", "validating", "validates", "validation"],
        ["retry", "retried", "retries", "retrying"],
        ["notify", "notified", "notifies", "notifying", "notification", "notifications"],
        ["verify", "verified", "verifies", "verifying", "verification"],
        ["calculate", "calculated", "calculating", "calculation"],
        ["authenticate", "authenticated", "authenticating", "authentication"],
      ];
      for (const members of families) {
        for (const start of members) {
          const variants = new Set(inflectionVariants(start));
          for (const other of members) expect(variants, `${start} -> ${other}`).toContain(other);
        }
      }
    });

    it("stays bounded: no single word's variant set explodes toward MAX_VARIANTS", () => {
      for (const w of ["expiration", "configuration", "validator", "acceptance", "renewal", "deployment"]) {
        expect(inflectionVariants(w).length, w).toBeLessThan(24);
      }
    });
  });
});

describe("textHasWordVariant — held item 5 end-to-end repro", () => {
  it("reviewer's exact false-completion repro: 'expiration' now matches a file declaring expire()", () => {
    const src = "export function expire(token) { return Date.now() > token.exp; }";
    expect(textHasWordVariant(src, "expiration")).toBe(true);
  });

  it("recall control: 'expiration' still does not match a file with neither expire() nor any expiration-related content", () => {
    const src = "export function doThing() { return 1; }";
    expect(textHasWordVariant(src, "expiration")).toBe(false);
  });

  it("recall control: station/nation collision does not leak into whole-word matching either", () => {
    expect(textHasWordVariant("export const STATE = {};", "station")).toBe(false);
    expect(textHasWordVariant("export function nate() {}", "nation")).toBe(false);
  });
});

describe("textHasWordVariant", () => {
  it("matches the literal word (case-insensitive) as a whole word", () => {
    expect(textHasWordVariant("export function VALIDATE(x) {}", "validate")).toBe(true);
  });

  it("false-absence repro (D1): validated / validateCouponCode", () => {
    expect(textHasWordVariant("export function validateCouponCode(code) {}", "validated")).toBe(true);
    expect(textHasWordVariant("/** Validates a coupon code shape. */", "validated")).toBe(true);
  });

  it("false-absence repro (D1): retried / retryFailedNotifications", () => {
    expect(textHasWordVariant("export function retryFailedNotifications() {}", "retried")).toBe(true);
    expect(textHasWordVariant("/** Retries every queued notification. */", "retried")).toBe(true);
  });

  it("false-absence repro (D1): invoices / buildInvoice", () => {
    expect(textHasWordVariant("export function buildInvoice(orderId) {}", "invoices")).toBe(true);
  });

  it("false-absence repro (D1): notifications / retryFailedNotifications", () => {
    expect(textHasWordVariant("export function retryFailedNotifications() {}", "notifications")).toBe(true);
  });

  it("FORBIDDEN false positive: the keyword const never evidences the word constant", () => {
    expect(textHasWordVariant("const MAX_RETRIES = 5;", "constant")).toBe(false);
    expect(textHasWordVariant("export const cache = new Map();", "constant")).toBe(false);
  });

  it("FORBIDDEN false positive, reverse direction: constant never evidences const", () => {
    expect(textHasWordVariant("this value never changes; it is a constant", "const")).toBe(false);
  });

  it("does not match an unrelated word", () => {
    expect(textHasWordVariant("export function doThing() { return 42; }", "quantum")).toBe(false);
    expect(textHasWordVariant("export function doThing() { return 42; }", "teleportation")).toBe(false);
  });

  it("never a raw substring match — a whole different, longer identifier containing the word as a fragment stays unmatched", () => {
    // "cat" is a substring of "category" but not a whole decomposed word of it.
    expect(textHasWordVariant("export function category() {}", "cat")).toBe(false);
    // "art" is a substring of "start" but "start" is a whole word of its own.
    expect(textHasWordVariant("function start() {}", "art")).toBe(false);
  });

  it("matches inside a camelCase identifier by whole subword, not by substring position", () => {
    expect(textHasWordVariant("const notificationQueue = [];", "notifications")).toBe(true);
    expect(textHasWordVariant("class OrderStateMachine {}", "order")).toBe(true);
  });

  it("irregular forms stay unmatched (documented, accepted gap — no dictionary)", () => {
    // "built" has no safe suffix-rule path back to "build"/"buildInvoice";
    // an irregular verb is out of scope for a dependency-free suffix
    // matcher and must not be silently "fixed" by a dictionary here.
    expect(textHasWordVariant("export function buildInvoice(orderId) {}", "built")).toBe(false);
  });

  it("a CJK haystack does not crash the EN-only tokenizer and correctly finds no identifier-shaped word", () => {
    // This matcher decomposes camelCase/snake/kebab/digit-bounded ASCII
    // identifiers only (see the module doc comment — CJK has no reliable,
    // dependency-free word-boundary rule the way camelCase/snake_case do).
    // A CJK `word` still passes through `inflectionVariants` untouched
    // (tested above); a CJK haystack simply has no ASCII identifier run to
    // test membership against, so this is an honest `false`, never a crash.
    expect(textHasWordVariant("在庫の補充発注を確認する", "補充発注")).toBe(false);
    expect(() => textHasWordVariant("在庫の補充発注を確認する", "validate")).not.toThrow();
  });
});
