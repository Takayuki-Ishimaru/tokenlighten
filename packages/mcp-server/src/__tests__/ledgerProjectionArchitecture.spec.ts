// ledgerProjectionArchitecture.spec.ts — P1-h(ii) (2026-08-28 review-fix wave,
// spec A-1(e) acceptance).
//
// Source-inspection spec, same convention as moduleBoundaries.spec.ts
// (walk production .ts files under src/, excluding __tests__, and grep for a
// named forbidden/required pattern). A-1(e) requires that frontier/gaps/
// missing are derived by REFERENCING the ledger's own projection — never by
// an independent, locally re-derived alternative — because "frontier =
// last-pack-only" (the current pack's own locally-computed state, with no
// reference to the cross-pack persisted ledger) is the exact defect class
// that recurred three times (08-01 -> 08-27, per the project's own incident
// history) before A-1's ObligationLedger existed at all. This spec makes a
// FOURTH recurrence fail a build rather than wait for a bench regression.
//
// Three mechanically-checkable invariants:
//   1. Only taskContractStore.ts may import the ObligationLedger CLASS or
//      dischargeCertificate (the mutation/certificate-minting surface) from
//      state/obligationLedger.ts. protocol/ledgerCertificateBinding.ts is a
//      legitimate second consumer of the module, but only of the plain
//      ObligationLedgerSnapshot TYPE (identity/digest verification, a
//      different concern from deriving what is open/covered) — never of the
//      class or the certificate minter, which stay gatekept to one module.
//   2. `taskContractGapProjection` — the ledger's sole open/gaps projector —
//      is defined exactly once in production source.
//   3. Every production consumer of the `unresolved-ledger:`/`explicit-gap:`
//      wire-prefix vocabulary these projections mint sits in the same,
//      already-audited file (readCodeTaskPack.ts) that calls
//      `taskContractGapProjection` — no second module independently
//      constructs or consumes that vocabulary from a different source.

import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));

function productionSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "__tests__") return [];
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) return productionSources(absolute);
    return entry.isFile() && entry.name.endsWith(".ts") ? [absolute] : [];
  });
}

const ALL_SOURCES = productionSources(sourceRoot);

/** The one file allowed to import the ledger's mutation/certificate surface. */
const LEDGER_GATEWAY = "features/task-pack/taskContractStore.ts";
/** A second, legitimate consumer of the module — but only its plain snapshot TYPE. */
const CERTIFICATE_IDENTITY_CONSUMER = "protocol/ledgerCertificateBinding.ts";

describe("frontier/gaps/missing derive from the ledger projection, with no last-pack-only alternative (P1-h(ii), A-1(e))", () => {
  it("gatekeeps ObligationLedger (the class) and dischargeCertificate to the one store module", () => {
    const violations: string[] = [];
    for (const file of ALL_SOURCES) {
      const relPath = relative(sourceRoot, file).replace(/\\/g, "/");
      if (relPath === LEDGER_GATEWAY || relPath === "state/obligationLedger.ts") continue;
      const source = readFileSync(file, "utf8");
      if (!source.includes("obligationLedger.js")) continue;
      // The certificate-identity consumer may import ONLY the plain snapshot
      // type (no mutation surface, no certificate minting) for digest
      // recomputation/comparison — a different concern (identity proof) from
      // deriving what is open/covered.
      if (relPath === CERTIFICATE_IDENTITY_CONSUMER) {
        const importLine = source.split("\n").find((line) => line.includes("obligationLedger.js"));
        if (importLine !== undefined && /\bObligationLedgerSnapshot\b/.test(importLine)
          && !/\bObligationLedger\b(?!Snapshot)/.test(importLine)
          && !/\bdischargeCertificate\b/.test(importLine)) {
          continue;
        }
      }
      violations.push(`${relPath} imports from state/obligationLedger.js outside the ledger gateway`);
    }
    expect(violations).toEqual([]);
  });

  it("defines taskContractGapProjection exactly once in production source", () => {
    const definitionSites = ALL_SOURCES.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return /\bfunction\s+taskContractGapProjection\b/.test(source)
        ? [relative(sourceRoot, file).replace(/\\/g, "/")]
        : [];
    });
    expect(definitionSites).toEqual([LEDGER_GATEWAY]);
  });

  it("keeps the unresolved-ledger:/explicit-gap: ledger-projection vocabulary to the audited consumer", () => {
    // The producer (readCodeTaskPack.ts) both calls taskContractGapProjection
    // AND is the sole place that turns its `open`/`explicitGaps` arrays into
    // the `unresolved-ledger:`/`explicit-gap:` wire prefixes. canonicalDecision.ts
    // PARSES the already-minted marker back out of `result.missing` (a
    // read-only consumer of the same vocabulary, not an alternative source of
    // truth) — named here explicitly so it is not mistaken for a violation.
    const PRODUCER = "features/task-pack/readCodeTaskPack.ts";
    const PARSER_CONSUMER = "features/task-pack/canonicalDecision.ts";
    const ALLOWED = [PRODUCER, PARSER_CONSUMER];
    const sites = ALL_SOURCES.flatMap((file) => {
      const relPath = relative(sourceRoot, file).replace(/\\/g, "/");
      const source = readFileSync(file, "utf8");
      return source.includes("unresolved-ledger:") ? [relPath] : [];
    });
    for (const relPath of sites) {
      expect(
        ALLOWED.includes(relPath),
        `${relPath} references the unresolved-ledger: vocabulary from outside the audited producer/parser pair`,
      ).toBe(true);
    }
    // The producer itself must be present — proves this check is not
    // vacuously true because the vocabulary moved somewhere unaudited.
    expect(sites).toContain("features/task-pack/readCodeTaskPack.ts");
  });
});
