/**
 * evaluation0929.digitSuffixedLiteral.spec.ts — WP-I (eval-0929 §4/§8).
 *
 * `evidenceClosure.ts`'s `lineHasLiteralText` and its documented twin
 * `facetGate.ts`'s `lineHasLiteral` (kept in sync on purpose — same fix,
 * same shape, applied to both) used a ONE-CHARACTER lookbehind/lookahead to
 * tell a numeric literal from surrounding identifier text. That is enough
 * to reject the FIRST digit of a suffix immediately after a letter (`u` in
 * `u64`), but a 2+ digit suffix could then retry-match on its OWN trailing
 * digit — preceded by another digit, not a letter, so the one-character
 * lookbehind passed — and, when the type sat at a token boundary (the
 * common case: `: u64 =`, `int64 {`), the one-character lookahead passed
 * too. So a digit-SUFFIXED type/const name (`u64`/`i32` Rust, `int8_t`/
 * `uint16_t` C/C++, `int64`/`uint32` Go, `Float64`/`Int32` Julia, an
 * `Int32`-shaped interop alias in Kotlin) was misread as carrying a numeric
 * literal:
 *   `isPureReferenceInitializer(["pub const A_MS: u64 = crate::limits::RAW;"], false)`
 *   used to return `false` (nothing but a name on the value side — should
 *   be `true`), and a focal whose only "value-shaped" text was a
 *   digit-suffixed return type used to be denied the `empty` disclosure
 *   (facetGate.ts) it deserves.
 *
 * The fix (both copies): strip every maximal identifier-shaped run
 * (`[A-Za-z_$][A-Za-z0-9_$]*` — `IDENTIFIER_RE`/`IDENTIFIER_TOKEN_RE`) from
 * the line first; a REAL numeric literal (`64`, `0x40`, `1_000`, `1e3`,
 * `64u64` — a literal with a language type/unit suffix) always leaves its
 * own LEADING digit behind, because no mainstream language lets an
 * identifier start with a digit, while a digit-suffixed type/const name is
 * consumed whole (it starts with a letter) and leaves nothing.
 *
 * This spec exercises the six languages the brief names — Rust, C, C++, Go,
 * Julia, Kotlin — plus the explicit literal-shape controls (`= 64`,
 * `= 0x40`, `= 1_000`, `= 1e3`, `= 64u64`) that must keep working.
 */
import { describe, expect, it } from "vitest";

import { constructionOnlyInitializer, isPureReferenceInitializer } from "../features/task-pack/evidenceClosure.js";
import { evaluateFacetRequirement, type FacetEvaluationContext, type FacetLineSpan, type FacetPlanEntry } from "../features/task-pack/facetGate.js";
import type { FacetRequirement } from "../features/task-pack/requestFacets.js";

// ===========================================================================
// evidenceClosure.ts: isPureReferenceInitializer / constructionOnlyInitializer
// (both gated by `lineHasLiteralText`, both already exported for unit tests)
// ===========================================================================
describe("isPureReferenceInitializer: a digit-suffixed TYPE name is never mistaken for a literal", () => {
  it("Rust: `u64` type annotation, `::`-qualified pure reference", () => {
    expect(isPureReferenceInitializer(["pub const A_MS: u64 = crate::limits::RAW;"], false)).toBe(true);
  });
  it("Rust: `i32` type annotation, bare-name pure reference", () => {
    expect(isPureReferenceInitializer(["pub const A_MS: i32 = RAW_VALUE;"], false)).toBe(true);
  });
  it("C: `int8_t` type, pure reference", () => {
    expect(isPureReferenceInitializer(["const int8_t kAMs = raw_value;"], false)).toBe(true);
  });
  it("C++: `uint16_t` type, qualified pure reference", () => {
    expect(isPureReferenceInitializer(["static const uint16_t kAMs = Raw::value;"], false)).toBe(true);
  });
  it("Go: `int64` type, pure reference (no `:` before the type at all)", () => {
    expect(isPureReferenceInitializer(["var stepRefMs int64 = otherValue"], false)).toBe(true);
  });
  it("Go: `uint32` type, pure reference", () => {
    expect(isPureReferenceInitializer(["var stepRefMs uint32 = otherValue"], false)).toBe(true);
  });
  it("Julia: `Float64` type annotation, pure reference (Julia line comments use `#`)", () => {
    expect(isPureReferenceInitializer(["const rawMs::Float64 = otherValue"], true)).toBe(true);
  });
  it("Kotlin: `Int32`-shaped (interop-style) type annotation, pure reference", () => {
    expect(isPureReferenceInitializer(["val stepRefMs: Int32 = otherValue"], false)).toBe(true);
  });
  it("C#: `Int32` alongside a bare-name pure reference on the SAME declaration line (digits elsewhere on the line never block detection)", () => {
    expect(isPureReferenceInitializer(["private const Int32 A_MS = OTHER_NAME_MS;"], false)).toBe(true);
  });
});

describe("constructionOnlyInitializer: a digit-suffixed TYPE/FUNCTION name never blocks the construction-only shape", () => {
  it("Rust-shaped: `u64` type, call-only initializer", () => {
    expect(constructionOnlyInitializer(["let x: u64 = compute();"], false)).toBe("compute()");
  });
  it("Go: `int64` type, call-only initializer", () => {
    expect(constructionOnlyInitializer(["var stepRefMs int64 = computeValue()"], false)).toBe("computeValue()");
  });
  it("Go: a digit-suffixed CONVERSION function name (`uint32(rawValue)`) is itself construction-only, never misread as holding a literal", () => {
    expect(constructionOnlyInitializer(["var stepRefMs = uint32(rawValue)"], false)).toBe("uint32(rawValue)");
  });
});

describe("isPureReferenceInitializer: explicit literal-shape controls are NEVER a pure reference (a real value already reached this window)", () => {
  it("plain integer literal", () => {
    expect(isPureReferenceInitializer(["export const A_MS = 64;"], false)).toBe(false);
  });
  it("hex literal", () => {
    expect(isPureReferenceInitializer(["export const A_MS = 0x40;"], false)).toBe(false);
  });
  it("underscore-grouped literal", () => {
    expect(isPureReferenceInitializer(["export const A_MS = 1_000;"], false)).toBe(false);
  });
  it("exponent literal", () => {
    expect(isPureReferenceInitializer(["export const A_MS = 1e3;"], false)).toBe(false);
  });
  it("a literal carrying a language type/unit suffix (Rust) is still a literal, never confused with a bare digit-suffixed TYPE name", () => {
    expect(isPureReferenceInitializer(["pub const A_MS: u64 = 64u64;"], false)).toBe(false);
  });
});

// ===========================================================================
// facetGate.ts: evaluateFacetRequirement — a focal whose only value-shaped
// text is a digit-suffixed return/param TYPE (no literal, no module
// constant anywhere) must be the verified-EMPTY disclosure, in every
// language the brief names — never denied that disclosure by misreading
// the type's own trailing digits as a literal.
// ===========================================================================
function requirement(facet: FacetRequirement["facet"], clause: string): FacetRequirement {
  return { facet, clause, subjectIdentifiers: ["subject"], subjectTerms: [], inheritedFromLead: false };
}

function ctx(files: Record<string, string[]>, served: Record<string, FacetLineSpan[]>): FacetEvaluationContext {
  return {
    servedSpans: (p) => served[p] ?? [],
    fileLines: (p) => files[p],
  };
}

function entryFor(path: string, name: string, lines: number): FacetPlanEntry {
  return { facet: "value", clause: `the default value of ${name}`, resolution: "resolved", focal: { path, name, start: 1, end: lines }, windows: [] };
}

describe("evaluateFacetRequirement: a digit-suffixed return/param TYPE is never misread as the value itself", () => {
  it("Rust: `-> u64` return type, body is a pure reference, no literal anywhere -> verified empty", () => {
    const files = { "src/r.rs": ["pub fn step() -> u64 {", "    raw_value", "}"] };
    const facts = evaluateFacetRequirement(requirement("value", "the value step returns"), entryFor("src/r.rs", "step", 3), ctx(files, { "src/r.rs": [{ start: 1, end: 3 }] }));
    expect(facts.kind).toBe("empty");
    expect(facts.disclosure?.word).toBe("request-item-empty");
  });

  it("C: `int8_t` return type, no literal anywhere -> verified empty", () => {
    const files = { "src/c.c": ["int8_t step(void) {", "    return raw_value;", "}"] };
    const facts = evaluateFacetRequirement(requirement("value", "the value step returns"), entryFor("src/c.c", "step", 3), ctx(files, { "src/c.c": [{ start: 1, end: 3 }] }));
    expect(facts.kind).toBe("empty");
  });

  it("C++: `uint16_t` return type, no literal anywhere -> verified empty", () => {
    const files = { "src/cpp.cpp": ["uint16_t Service::step() {", "    return rawValue;", "}"] };
    const facts = evaluateFacetRequirement(requirement("value", "the value step returns"), entryFor("src/cpp.cpp", "step", 3), ctx(files, { "src/cpp.cpp": [{ start: 1, end: 3 }] }));
    expect(facts.kind).toBe("empty");
  });

  it("Go: `int64` return type, no literal anywhere -> verified empty", () => {
    const files = { "src/g.go": ["func Step() int64 {", "    return stepRefMs", "}"] };
    const facts = evaluateFacetRequirement(requirement("value", "the value Step returns"), entryFor("src/g.go", "Step", 3), ctx(files, { "src/g.go": [{ start: 1, end: 3 }] }));
    expect(facts.kind).toBe("empty");
  });

  it("Julia: `::Float64` return annotation, no literal anywhere -> verified empty", () => {
    const files = { "src/j.jl": ["function step()::Float64", "    return raw_value", "end"] };
    const facts = evaluateFacetRequirement(requirement("value", "the value step returns"), entryFor("src/j.jl", "step", 3), ctx(files, { "src/j.jl": [{ start: 1, end: 3 }] }));
    expect(facts.kind).toBe("empty");
  });

  it("Kotlin: `Int32`-shaped return type, no literal anywhere -> verified empty", () => {
    const files = { "src/k.kt": ["fun step(): Int32 {", "    return rawValue", "}"] };
    const facts = evaluateFacetRequirement(requirement("value", "the value step returns"), entryFor("src/k.kt", "step", 3), ctx(files, { "src/k.kt": [{ start: 1, end: 3 }] }));
    expect(facts.kind).toBe("empty");
  });

  it("control: a REAL literal alongside an unrelated digit-suffixed type elsewhere is still covered, never empty", () => {
    const files = { "src/g2.go": ["func Step() int64 {", "    return 7310", "}"] };
    const facts = evaluateFacetRequirement(requirement("value", "the value Step returns"), entryFor("src/g2.go", "Step", 3), ctx(files, { "src/g2.go": [{ start: 1, end: 3 }] }));
    expect(facts.kind).toBe("covered");
    expect(facts.disclosure).toBeUndefined();
  });
});
