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
//      wire-prefix vocabulary these projections mint sits in the audited
//      producer/consumer set — the extracted engine owners that call
//      `taskContractGapProjection` or parse its markers, each named by exact
//      path — so no second module independently constructs or consumes that
//      vocabulary from a different source.

import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
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

/** The wire-prefix vocabulary the ledger projection mints. */
const LEDGER_VOCABULARY = "unresolved-ledger:";

/**
 * Text of every string/template token that is real code. The parser treats
 * comments as trivia, so a marker quoted inside a comment never counts, while
 * `/* comment *\/ const marker = "unresolved-ledger:"` does — a line-based
 * comment filter would let that executable consumer hide.
 */
function runtimeStringLiterals(source: string): string[] {
  const sourceFile = ts.createSourceFile("audit.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const literals: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) literals.push(node.text);
    else if (ts.isTemplateExpression(node)) {
      literals.push(node.head.text);
      for (const span of node.templateSpans) literals.push(span.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return literals;
}

/** Production files whose CODE (not prose) carries the ledger vocabulary. */
function vocabularySites(): string[] {
  return ALL_SOURCES
    .filter((file) => runtimeStringLiterals(readFileSync(file, "utf8"))
      .some((text) => text.includes(LEDGER_VOCABULARY)))
    .map((file) => relative(sourceRoot, file).replace(/\\/g, "/"));
}

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

  it("keeps the unresolved-ledger:/explicit-gap: ledger-projection vocabulary to the audited consumers", () => {
    // The task-pack extraction moved this vocabulary out of readCodeTaskPack.ts
    // into the engine owners below. The producer (engine/executionContract.ts)
    // both calls taskContractGapProjection AND is the place that turns its
    // `open`/`explicitGaps` arrays into the `unresolved-ledger:`/`explicit-gap:`
    // wire prefixes. canonicalDecision.ts PARSES the already-minted marker back
    // out of `result.missing` (a read-only consumer of the same vocabulary, not
    // an alternative source of truth). The remaining entries are the exact
    // current runtime consumers/re-minters of those projection-derived rows —
    // named file by file, never as a blanket `engine/` allow, so a NEW module
    // touching the vocabulary from a different source of truth still fails.
    const PRODUCER = "features/task-pack/engine/executionContract.ts";
    const PARSER_CONSUMER = "features/task-pack/canonicalDecision.ts";
    const ALLOWED = [
      PRODUCER,
      PARSER_CONSUMER,
      "features/task-pack/engine/epochContract.ts",
      "features/task-pack/engine/packSettlement.ts",
      "features/task-pack/engine/contentSettlement2.ts",
      "features/task-pack/engine/readinessObligations.ts",
      "features/task-pack/engine/unresolvedCalls3.ts",
    ];
    // Doc comments quote the vocabulary (engine/receiptProgress3.ts,
    // engine/receiptRestoration.ts); only runtime code is a producer/consumer,
    // so the scan reads string/template tokens out of the parsed AST.
    const sites = vocabularySites();
    for (const relPath of sites) {
      expect(
        ALLOWED.includes(relPath),
        `${relPath} references the unresolved-ledger: vocabulary from outside the audited producer/consumer set`,
      ).toBe(true);
    }
    // The producer itself must be present — proves this check is not
    // vacuously true because the vocabulary moved somewhere unaudited.
    expect(sites).toContain(PRODUCER);
    expect(sites).toContain(PARSER_CONSUMER);
    // And the producer must still be the ledger projection's caller: the
    // vocabulary stays derived, never locally re-derived (A-1(e)).
    const producerSource = readFileSync(resolve(sourceRoot, PRODUCER), "utf8");
    expect(producerSource).toMatch(/\btaskContractGapProjection\s*\(/);
  });

  it("reads the vocabulary from parsed tokens, so a comment cannot hide an executable consumer", () => {
    // The allow-list is only as good as the scan: a line-based comment filter
    // would miss code that follows a block comment on the same line, and would
    // count prose that merely quotes the marker.
    expect(runtimeStringLiterals('/* note */ const marker = "unresolved-ledger:required-role:api";\n'))
      .toContain("unresolved-ledger:required-role:api");
    expect(runtimeStringLiterals('const prefix = `unresolved-ledger:${entry}`;\n'))
      .toContain("unresolved-ledger:");
    expect(runtimeStringLiterals("// an `unresolved-ledger:` row was dropped\n/* \"unresolved-ledger:\" */\n"))
      .toEqual([]);
    // The two comment-only engine files prove the real scan is not counting
    // prose: they mention the marker in docs and stay out of the audited set.
    const sites = vocabularySites();
    expect(sites).not.toContain("features/task-pack/engine/receiptProgress3.ts");
    expect(sites).not.toContain("features/task-pack/engine/receiptRestoration.ts");
  });
});
