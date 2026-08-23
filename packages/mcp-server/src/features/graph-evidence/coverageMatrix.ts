// ---------------------------------------------------------------------------
// graph-evidence/coverageMatrix.ts — V11-01 language / framework coverage
// matrix.
//
// Plan §V11-01: "language／framework 別 coverage matrix を telemetry へ出す",
// and 受入基準 "language coverage matrix を生成できる".
//
// WHAT IT ANSWERS
// ---------------
// For one workspace snapshot: which providers cover which languages, with
// which edge types, at what evidence strength — and therefore, per language,
// whether graph evidence may close anything at all there.
//
// WHY UNAIDED CLASS, NOT THE CAP
// ------------------------------
// A language covered only by path heuristics reports `bestEvidenceClass:
// "heuristic"` and `closureEligible: false`, even though a path proposal CAN
// reach `structural` when an import graph independently corroborates it. The
// report describes what the provider set proves on its own, because that is
// the question a telemetry consumer is actually asking.
//
// PURE. A plain report object: no I/O, no clock, no mutable module state.
// Identical inputs produce an identical object, which is what makes it safe to
// diff across runs.
// ---------------------------------------------------------------------------

import {
  canSupportClosure,
  edgeTypeOrder,
  evidenceClassRank,
  unaidedEvidenceClassFor,
  weakerCoverage,
  type Coverage,
  type EvidenceClass,
  type GraphEdgeType,
  type ProviderKind,
} from "./model.js";
import {
  providerList,
  providerIdentities,
  type PathRole,
  type ProviderIdentity,
  type ProviderSet,
} from "./providers.js";

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export interface SnapshotFile {
  readonly path: string;
  /** Language id as the providers spell it ("typescript", "python", ...). */
  readonly language: string;
  readonly sha: string;
  readonly role?: PathRole;
}

/**
 * The caller's file inventory. This module never walks a filesystem — E-1's
 * derived overlay owns no crawler, so the snapshot is always an input.
 */
export interface WorkspaceSnapshot {
  readonly label: string;
  readonly files: readonly SnapshotFile[];
}

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------

/** `unsupported` is distinct from `unknown`: the provider says it cannot, not that it does not know. */
export type CellStatus = Coverage | "unsupported";

export interface CoverageCell {
  readonly language: string;
  readonly provider: string;
  readonly providerKind: ProviderKind;
  readonly status: CellStatus;
  readonly edgeTypes: readonly GraphEdgeType[];
  /** What this provider produces here with no corroboration from another. */
  readonly unaidedEvidenceClass: EvidenceClass | "none";
  readonly reason?: string;
}

export interface LanguageCoverageSummary {
  readonly language: string;
  readonly fileCount: number;
  /** Providers with at least one supported edge type for this language. */
  readonly providers: readonly string[];
  /**
   * The subset of `providers` whose evidence could close an obligation — the
   * ones `coverage` below is computed over. Advisory (path/naming) providers
   * are listed in `providers` but excluded here and from `coverage`, exactly as
   * `aggregateProviderCoverage` excludes them: their permanent `partial` is a
   * statement about naming rules, not about what the workspace proved.
   */
  readonly closureProviders: readonly string[];
  readonly edgeTypes: readonly GraphEdgeType[];
  readonly missingEdgeTypes: readonly GraphEdgeType[];
  /** Strongest class available UNAIDED, across every covering provider. */
  readonly bestEvidenceClass: EvidenceClass | "none";
  /** Weakest coverage among `closureProviders`; `unknown` when there are none. */
  readonly coverage: Coverage;
  /** May graph evidence close an obligation for this language at all? */
  readonly closureEligible: boolean;
}

export interface CoverageMatrix {
  readonly version: 1;
  readonly snapshot: string;
  readonly providers: readonly ProviderIdentity[];
  readonly languages: readonly string[];
  readonly cells: readonly CoverageCell[];
  readonly summary: readonly LanguageCoverageSummary[];
  readonly totals: {
    readonly files: number;
    readonly languages: number;
    readonly providers: number;
    readonly languagesWithNoCoverage: number;
    readonly languagesClosureEligible: number;
  };
}

export interface CoverageMatrixOptions {
  /**
   * Edge types the report treats as the full set, for `missingEdgeTypes`.
   * Defaults to every type in the model.
   */
  readonly expectedEdgeTypes?: readonly GraphEdgeType[];
}

const ALL_EDGE_TYPES: readonly GraphEdgeType[] = [
  "CALLS",
  "CALLED_BY",
  "IMPORTS",
  "IMPORTED_BY",
  "REFERENCES",
  "IMPLEMENTS",
  "EXTENDS",
  "TESTED_BY",
  "CONFIGURES",
  "GENERATED_FROM",
];

function sortEdgeTypes(types: Iterable<GraphEdgeType>): readonly GraphEdgeType[] {
  return [...new Set(types)].sort((a, b) => edgeTypeOrder(a) - edgeTypeOrder(b));
}

/**
 * Build the matrix for one snapshot and one provider set.
 */
export function buildCoverageMatrix(
  snapshot: WorkspaceSnapshot,
  providers: ProviderSet,
  options: CoverageMatrixOptions = {},
): CoverageMatrix {
  const expected = sortEdgeTypes(options.expectedEdgeTypes ?? ALL_EDGE_TYPES);
  const present = providerList(providers);

  const fileCounts = new Map<string, number>();
  for (const file of snapshot.files) {
    fileCounts.set(file.language, (fileCounts.get(file.language) ?? 0) + 1);
  }
  const languages = [...fileCounts.keys()].sort();

  const cells: CoverageCell[] = [];
  const summary: LanguageCoverageSummary[] = [];

  for (const language of languages) {
    const covering: string[] = [];
    const closing: string[] = [];
    const edgeTypes = new Set<GraphEdgeType>();
    let coverage: Coverage | undefined;
    let best: EvidenceClass | "none" = "none";

    for (const provider of present) {
      const identity = provider.identity;
      const supported = sortEdgeTypes(provider.edgeTypeSupport(language));

      if (supported.length === 0) {
        cells.push({
          language,
          provider: identity.id,
          providerKind: identity.kind,
          status: "unsupported",
          edgeTypes: [],
          unaidedEvidenceClass: "none",
          reason: "provider declares no edge type for this language",
        });
        continue;
      }

      // Supported, but the provider did not report having processed the
      // language: it can produce these edges in principle, and cannot vouch for
      // what it actually saw. That is `unknown`, and `unknown` forbids
      // `complete` downstream.
      const processed = identity.coverage.languages.includes(language);
      const status: Coverage = processed ? identity.coverage.status : "unknown";
      const unaided = unaidedEvidenceClassFor(identity.kind);

      const cell: CoverageCell = {
        language,
        provider: identity.id,
        providerKind: identity.kind,
        status,
        edgeTypes: supported,
        unaidedEvidenceClass: unaided,
        ...(status === "complete"
          ? {}
          : {
              reason: processed
                ? (identity.coverage.reason ?? `provider coverage is ${status}`)
                : "language absent from the provider's processed set",
            }),
      };
      cells.push(cell);

      covering.push(identity.id);
      for (const type of supported) edgeTypes.add(type);
      if (canSupportClosure(unaided)) {
        closing.push(identity.id);
        coverage = coverage === undefined ? status : weakerCoverage(coverage, status);
      }
      if (best === "none" || evidenceClassRank(unaided) > evidenceClassRank(best)) best = unaided;
    }

    const resolvedCoverage: Coverage = coverage ?? "unknown";
    const supportedTypes = sortEdgeTypes(edgeTypes);
    summary.push({
      language,
      fileCount: fileCounts.get(language) ?? 0,
      providers: covering,
      closureProviders: closing,
      edgeTypes: supportedTypes,
      missingEdgeTypes: expected.filter((type) => !edgeTypes.has(type)),
      bestEvidenceClass: best,
      coverage: resolvedCoverage,
      closureEligible:
        resolvedCoverage === "complete" && best !== "none" && canSupportClosure(best),
    });
  }

  return {
    version: 1,
    snapshot: snapshot.label,
    providers: providerIdentities(providers),
    languages,
    cells,
    summary,
    totals: {
      files: snapshot.files.length,
      languages: languages.length,
      providers: present.length,
      languagesWithNoCoverage: summary.filter((entry) => entry.providers.length === 0).length,
      languagesClosureEligible: summary.filter((entry) => entry.closureEligible).length,
    },
  };
}

/** The summary row for one language, when the snapshot had any file in it. */
export function languageSummary(
  matrix: CoverageMatrix,
  language: string,
): LanguageCoverageSummary | undefined {
  return matrix.summary.find((entry) => entry.language === language);
}
