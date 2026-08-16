/**
 * refusalCodeParity.spec.ts — A.7.1 `RefusalCode` is written TWICE, and only
 * one direction of the mirror is checked by the compiler.
 *
 * THE DEFECT CLASS, MEASURED. `packages/types/src/mcp/protocol.ts` declares the
 * enum as ten sub-unions; `protocol/refusal.ts` re-declares every value as a
 * runtime `Set<RefusalCode>` (TypeScript unions do not survive to runtime, and
 * `isRefusalCode` needs membership at runtime). The `Set<RefusalCode>`
 * annotation makes `tsc` reject a value that is not in the TYPE. Nothing makes
 * it reject a value MISSING FROM THE SET — and a missing member is not a loud
 * failure: `refusalCodeOf` falls through to its documented `invalid-input`
 * fallback, so the code silently reverts to the coarse value it was minted to
 * replace.
 *
 * That is not hypothetical. Both [R5-29] mints (`is-a-directory`,
 * `write-intent-ambiguous`, ratified 2026-08-14) type-checked, built, and
 * emitted `invalid-input` on the wire until they were added to the runtime set.
 * The emit sites were correct the whole time; the enum was not closed.
 *
 * WHY PARSE THE TYPE FILE. The union has no runtime reflection, so the only
 * honest source for "what A.7.1 declares" is the declaration itself. The parse
 * is deliberately narrow — a `| "value"` line inside one of the ten named
 * sub-unions — and the spec asserts the parse found a plausible number of
 * values, so a parser that silently matches nothing cannot pass vacuously.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { isRefusalCode } from "../protocol/refusal.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTOCOL_TYPES = path.resolve(
  HERE, "..", "..", "..", "types", "src", "mcp", "protocol.ts",
);

/** The ten sub-unions A.7.1 composes `RefusalCode` from, in declaration order. */
const SUB_UNIONS = [
  "RequestShapeCode", "HandleCode", "TypestateCode", "WriteCode", "IntentCode",
  "ReadLimitCode", "DocumentCode", "ArchiveCode", "ArtifactCode", "CredentialCode",
] as const;

/**
 * Declared members, per sub-union. Scans from each `export type X =` line until
 * the next `export type` (or EOF), taking only `| "value"` lines. Comment lines
 * are skipped explicitly so a doc comment quoting a retired value — the removed
 * `task-pack-disabled` / `small-file-disabled` / `edit-intents-disabled` notes
 * are exactly that — is never mistaken for a declaration.
 */
function declaredCodes(): Map<string, string[]> {
  const lines = readFileSync(PROTOCOL_TYPES, "utf8").split("\n");
  const out = new Map<string, string[]>();
  for (const name of SUB_UNIONS) {
    const start = lines.findIndex((l) => l.startsWith(`export type ${name} =`));
    expect(start, `${name} is not declared in ${path.basename(PROTOCOL_TYPES)}`).toBeGreaterThan(-1);
    const values: string[] = [];
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.startsWith("export type ")) break;
      const trimmed = line.trim();
      if (trimmed.startsWith("*") || trimmed.startsWith("/*") || trimmed.startsWith("//")) continue;
      const m = /^\|\s*"([^"]+)"/.exec(trimmed);
      if (m) values.push(m[1]!);
    }
    out.set(name, values);
  }
  return out;
}

describe("A.7.1 RefusalCode — the type declaration and the runtime enum agree", () => {
  it("parses a plausible enum out of the type file (no vacuous pass)", () => {
    const declared = declaredCodes();
    for (const [name, values] of declared) {
      expect(values.length, `${name} parsed as empty — the parser, not the enum, is broken`)
        .toBeGreaterThan(0);
    }
    const all = [...declared.values()].flat();
    // A floor, not a pin: minting is additive and free pre-publish (§1.4(a)),
    // so this must not become a number someone has to bump for every mint.
    expect(all.length, "A.7.1 harvested well over a hundred values; a small count means a bad parse")
      .toBeGreaterThan(100);
    expect(new Set(all).size, `duplicate RefusalCode value(s) declared: ${
      [...new Set(all.filter((v, i) => all.indexOf(v) !== i))].join(", ")
    }`).toBe(all.length);
  });

  it("every DECLARED code is recognised at runtime — a missing one silently becomes invalid-input", () => {
    const missing: Array<{ subUnion: string; code: string }> = [];
    for (const [subUnion, values] of declaredCodes()) {
      for (const code of values) {
        if (!isRefusalCode(code)) missing.push({ subUnion, code });
      }
    }
    expect(
      missing,
      missing.length > 0
        ? `RefusalCode value(s) declared in packages/types/src/mcp/protocol.ts but absent from `
          + `REFUSAL_CODES in packages/mcp-server/src/protocol/refusal.ts: ${JSON.stringify(missing)}. `
          + "tsc cannot see this direction. Every emitter of these codes is currently coerced to "
          + "`invalid-input` by refusalCodeOf's fallback — the mint has no effect on the wire until "
          + "the value is added to the runtime set."
        : undefined,
    ).toEqual([]);
  });

  it("a non-member is still rejected (the enum is closed, not a denylist)", () => {
    expect(isRefusalCode("not-a-real-refusal-code")).toBe(false);
    expect(isRefusalCode("")).toBe(false);
    expect(isRefusalCode(undefined)).toBe(false);
    // [R5-29] regression anchors: these two were declared-but-unrecognised.
    expect(isRefusalCode("is-a-directory")).toBe(true);
    expect(isRefusalCode("write-intent-ambiguous")).toBe(true);
  });
});
