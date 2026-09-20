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
