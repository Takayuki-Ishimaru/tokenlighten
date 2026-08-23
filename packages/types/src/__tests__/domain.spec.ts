/**
 * Tests for the v0.10 internal domain model (`packages/types/src/domain/`).
 *
 * Mirrors `types.spec.ts`'s conventions: type-level `satisfies<T>()`
 * round-trips for every exported shape, plus (new to this file, per the
 * domain model's string-literal-heavy surface):
 *  - exhaustiveness checks over the closed string-literal unions, using the
 *    house idiom (`const exhaustive: never = value; throw new Error(...)`,
 *    as at `packages/mcp-server/src/protocol/budget/validate.ts`'s
 *    `resolve()` and `packages/mcp-server/src/__tests__/
 *    protocolConformance.spec.ts`'s `rawChangeToClassification`) — a
 *    compile-time fence that fails `tsc` if a union member is added or
 *    removed without updating the switch, backed by a runtime loop over
 *    every known member;
 *  - runtime guard tests (`isEvidenceRole` / `isDeliveryDisposition` /
 *    `isStateHandlePurpose`);
 *  - `parseHandlePurposeFromPrefix` prefix-parser tests;
 *  - a check that the domain barrel does not re-export anything from the
 *    frozen `../mcp/` wire contract.
 *
 * No external runtime dependencies are needed — like the rest of this
 * package, the domain model is pure TypeScript declarations plus a handful
 * of tiny pure helpers.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Primary surface under test: the PUBLIC package barrel (`../index.js`), the
// same entry point every other package in the monorepo imports. This
// exercises both `domain/index.ts` itself and `index.ts`'s re-export of it
// in one pass.
// ---------------------------------------------------------------------------
import {
  isEvidenceRole,
  isDeliveryDisposition,
  isStateHandlePurpose,
  parseHandlePurposeFromPrefix,
  EVIDENCE_ROLES,
  DELIVERY_DISPOSITIONS,
  STATE_HANDLE_PURPOSES,
  HANDLE_WIRE_PREFIXES,
  HANDLE_WIRE_SIZE_TARGET_P95,
  HANDLE_WIRE_SIZE_MAX,
} from "../index.js";

import type {
  EvidenceId,
  EvidenceRole,
  EvidenceIdentity,
  EvidenceUse,
  EmissionHistory,
  EvidenceDelivery,
  CoverageState,
  ContinuationControl,
  StateHandlePurpose,
  DecodedStateHandle,
  CommonStateInput,
  TrustedClientContextMeta,
  ClientContextAttestation,
  ContextReceipt,
  LocalTaskState,
  TaskReasoningIR,
  TermResult,
  TreeScopeReport,
  HostBudgetProfile,
  EncodingDecision,
  ContributionEstimate,
} from "../index.js";

// ---------------------------------------------------------------------------
// Secondary surface: direct imports of the same values from `../domain/
// index.js` and the wire barrel `../mcp/index.js`, used only by the
// re-export-parity and no-collision checks below.
// ---------------------------------------------------------------------------
import {
  isEvidenceRole as isEvidenceRoleDirect,
  isDeliveryDisposition as isDeliveryDispositionDirect,
  isStateHandlePurpose as isStateHandlePurposeDirect,
  HANDLE_WIRE_PREFIXES as HANDLE_WIRE_PREFIXES_DIRECT,
} from "../domain/index.js";
import * as domainBarrel from "../domain/index.js";
import * as mcpBarrel from "../mcp/index.js";

// ---------------------------------------------------------------------------
// Helper: assert a value satisfies a type without emitting to dist.
// Identical in shape to `types.spec.ts`'s helper (module-local, not shared).
// ---------------------------------------------------------------------------
function satisfies<T>(value: T): T {
  return value;
}

/**
 * Runs `classify` over every member of `members` and asserts it never
 * throws. `classify` itself must be written with the house exhaustiveness
 * idiom described in this file's module header, so that a union member
 * added or removed without updating the switch fails `tsc`, not only this
 * loop.
 */
function assertExhaustive<T extends string>(
  members: readonly T[],
  classify: (value: T) => unknown,
): void {
  for (const member of members) {
    expect(() => classify(member)).not.toThrow();
  }
}

// ---------------------------------------------------------------------------
// evidence.ts
// ---------------------------------------------------------------------------

function classifyEvidenceRole(role: EvidenceRole): string {
  switch (role) {
    case "target":
      return "primary edit/answer target";
    case "definition":
      return "declares the symbol in question";
    case "consumer":
      return "calls/uses the symbol in question";
    case "test":
      return "exercises the symbol in question";
    case "config":
      return "configures behavior the task depends on";
    case "build":
      return "build/toolchain wiring the task depends on";
    case "doc":
      return "documents the symbol/behavior in question";
    default: {
      const exhaustive: never = role;
      throw new Error(`classifyEvidenceRole(): unhandled EvidenceRole ${String(exhaustive)}`);
    }
  }
}

describe("EvidenceRole", () => {
  it("is exhaustively classifiable and every member passes isEvidenceRole", () => {
    assertExhaustive(EVIDENCE_ROLES, classifyEvidenceRole);
    for (const role of EVIDENCE_ROLES) {
      expect(isEvidenceRole(role)).toBe(true);
    }
  });

  it("rejects unknown values at runtime", () => {
    expect(isEvidenceRole("bogus")).toBe(false);
    expect(isEvidenceRole(123)).toBe(false);
    expect(isEvidenceRole(undefined)).toBe(false);
    expect(isEvidenceRole(null)).toBe(false);
  });
});

const EMISSION_HISTORIES = [
  "never_emitted",
  "previously_emitted",
] as const satisfies readonly EmissionHistory[];

function classifyEmissionHistory(history: EmissionHistory): string {
  switch (history) {
    case "never_emitted":
      return "no prior serve to acknowledge";
    case "previously_emitted":
      return "history only — does not by itself license bodyless suppression";
    default: {
      const exhaustive: never = history;
      throw new Error(`classifyEmissionHistory(): unhandled EmissionHistory ${String(exhaustive)}`);
    }
  }
}

describe("DeliveryDisposition / EmissionHistory", () => {
  it("DeliveryDisposition is exhaustively classifiable and every member passes isDeliveryDisposition", () => {
    function classifyDisposition(disposition: (typeof DELIVERY_DISPOSITIONS)[number]): string {
      switch (disposition) {
        case "inline":
          return "body served in this response";
        case "client_acknowledged_prior":
          return "trusted client-host attestation covers this body";
        case "micro_restate":
          return "signature/anchor/summary restated, no full body";
        case "omitted":
          return "not served this response";
        default: {
          const exhaustive: never = disposition;
          throw new Error(`classifyDisposition(): unhandled DeliveryDisposition ${String(exhaustive)}`);
        }
      }
    }
    assertExhaustive(DELIVERY_DISPOSITIONS, classifyDisposition);
    for (const disposition of DELIVERY_DISPOSITIONS) {
      expect(isDeliveryDisposition(disposition)).toBe(true);
    }
  });

  it("rejects unknown DeliveryDisposition values at runtime", () => {
    expect(isDeliveryDisposition("bogus")).toBe(false);
    expect(isDeliveryDisposition(123)).toBe(false);
    expect(isDeliveryDisposition(undefined)).toBe(false);
  });

  it("EmissionHistory is exhaustively classifiable", () => {
    assertExhaustive(EMISSION_HISTORIES, classifyEmissionHistory);
  });
});

describe("EvidenceIdentity / EvidenceUse / EvidenceDelivery", () => {
  it("round-trips an EvidenceIdentity", () => {
    const v = satisfies<EvidenceIdentity>({
      evidenceId: "ev_1",
      source: {
        kind: "file",
        uri: "workspace://packages/types/src/domain/evidence.ts",
        contentHash: `sha256:${"a".repeat(64)}`,
        indexGeneration: "gen-7",
      },
      locator: {
        lineRange: { startLine: 10, endLine: 42 },
        symbol: { id: "sym_1", name: "EvidenceIdentity", kind: "type" },
      },
      evidenceClass: "direct",
      validityKeys: [{ type: "contentHash", value: `sha256:${"a".repeat(64)}` }],
    });
    expect(v.source.kind).toBe("file");
    expect(v.locator?.lineRange?.endLine).toBe(42);
  });

  it("round-trips an EvidenceUse with multiple roles", () => {
    const v = satisfies<EvidenceUse>({
      taskRef: "task_1",
      evidenceId: "ev_1",
      roles: ["target", "definition"],
      obligationIds: ["ob_1"],
      required: true,
    });
    expect(v.roles).toContain("definition");
    expect(v.roles).toHaveLength(2);
  });

  it("round-trips an EvidenceDelivery (micro_restate)", () => {
    const v = satisfies<EvidenceDelivery>({
      responseId: "resp_1",
      evidenceId: "ev_1",
      emissionHistory: "previously_emitted",
      disposition: "micro_restate",
      receiptId: "rcpt_1",
      projectionVersion: "1",
      microRestate: { signature: "sig_1", anchor: "L10-42", summary: "unchanged" },
    });
    expect(v.disposition).toBe("micro_restate");
    expect(v.microRestate?.anchor).toBe("L10-42");
  });

  it("round-trips an EvidenceDelivery (inline, never emitted before)", () => {
    const v = satisfies<EvidenceDelivery>({
      responseId: "resp_2",
      evidenceId: "ev_2",
      emissionHistory: "never_emitted",
      disposition: "inline",
      projectionVersion: "1",
      inlineBodyHash: `sha256:${"b".repeat(64)}`,
    });
    expect(v.emissionHistory).toBe("never_emitted");
    expect(v.inlineBodyHash).toHaveLength(71);
  });
});

// ---------------------------------------------------------------------------
// coverage.ts
// ---------------------------------------------------------------------------

const COMPLETENESS_FAMILY = ["complete", "partial", "unknown"] as const satisfies readonly CoverageState["status"][];

function classifyCompleteness(status: CoverageState["status"]): string {
  switch (status) {
    case "complete":
      return "every required role covered";
    case "partial":
      return "some required roles covered";
    case "unknown":
      return "coverage not determined";
    default: {
      const exhaustive: never = status;
      throw new Error(`classifyCompleteness(): unhandled status ${String(exhaustive)}`);
    }
  }
}

describe("CoverageState", () => {
  it("its status/providerCoverage family (also reused by ContinuationControl.completeness, TermResult.scope.completeness, and TreeScopeReport.completeness) is exhaustively classifiable", () => {
    assertExhaustive(COMPLETENESS_FAMILY, classifyCompleteness);
  });

  it("round-trips a partial CoverageState", () => {
    const v = satisfies<CoverageState>({
      status: "partial",
      requiredRoles: ["definition", "test"],
      coveredRoles: ["definition"],
      blockingGaps: [{ id: "gap_1", role: "test", reason: "no test file located" }],
      optionalFollowups: [{ id: "fu_1", reason: "consider a doc update" }],
      omittedRequired: [],
      providerCoverage: "complete",
    });
    expect(v.blockingGaps[0].role).toBe("test");
    expect(v.status).toBe("partial");
  });
});

// ---------------------------------------------------------------------------
// continuation.ts
// ---------------------------------------------------------------------------

const CONTINUATION_CAUSES = [
  "capped",
  "permission",
  "unsupported",
  "provider-incomplete",
] as const satisfies readonly NonNullable<ContinuationControl["cause"]>[];

function classifyContinuationCause(cause: NonNullable<ContinuationControl["cause"]>): string {
  switch (cause) {
    case "capped":
      return "a server cap cut this response, no continuation constructible";
    case "permission":
      return "permission boundary stopped delivery";
    case "unsupported":
      return "operation not supported for this source";
    case "provider-incomplete":
      return "upstream provider returned an incomplete result";
    default: {
      const exhaustive: never = cause;
      throw new Error(`classifyContinuationCause(): unhandled cause ${String(exhaustive)}`);
    }
  }
}

describe("ContinuationControl", () => {
  it("cause is exhaustively classifiable", () => {
    assertExhaustive(CONTINUATION_CAUSES, classifyContinuationCause);
  });

  it("round-trips a capped, continuable ContinuationControl", () => {
    const v = satisfies<ContinuationControl>({
      responseId: "resp_1",
      completeness: "partial",
      cause: "capped",
      limit: { requested: 4096, effectiveBytes: 2048, hostSafeBytes: 2048 },
      next: {
        tool: "read_file",
        arguments: { continuation_token: "tlh_cont_v1_abc", path: "src/x.ts" },
        idempotent: true,
      },
      remaining: { items: 3, ranges: ["43-90"] },
    });
    expect(v.next?.tool).toBe("read_file");
    expect(v.next?.arguments.continuation_token).toBe("tlh_cont_v1_abc");
  });
});

// ---------------------------------------------------------------------------
// state-handle.ts
// ---------------------------------------------------------------------------

function classifyStateHandlePurpose(purpose: StateHandlePurpose): string {
  switch (purpose) {
    case "task":
      return "Task IR / obligation / decision / workspace-generation state";
    case "context":
      return "acknowledged receipt set / client context generation";
    case "continuation":
      return "immutable response snapshot or reconstruction condition";
    default: {
      const exhaustive: never = purpose;
      throw new Error(`classifyStateHandlePurpose(): unhandled StateHandlePurpose ${String(exhaustive)}`);
    }
  }
}

describe("StateHandlePurpose", () => {
  it("is exhaustively classifiable and every member passes isStateHandlePurpose", () => {
    assertExhaustive(STATE_HANDLE_PURPOSES, classifyStateHandlePurpose);
    for (const purpose of STATE_HANDLE_PURPOSES) {
      expect(isStateHandlePurpose(purpose)).toBe(true);
    }
  });

  it("rejects unknown values at runtime", () => {
    expect(isStateHandlePurpose("bogus")).toBe(false);
    expect(isStateHandlePurpose(123)).toBe(false);
    expect(isStateHandlePurpose(undefined)).toBe(false);
  });
});

describe("parseHandlePurposeFromPrefix", () => {
  it("recovers the purpose from each known wire prefix", () => {
    for (const purpose of STATE_HANDLE_PURPOSES) {
      const token = `${HANDLE_WIRE_PREFIXES[purpose]}${"x".repeat(16)}`;
      expect(parseHandlePurposeFromPrefix(token)).toBe(purpose);
    }
  });

  it("returns undefined for an unrecognized or empty prefix", () => {
    expect(parseHandlePurposeFromPrefix("not_a_handle_at_all")).toBeUndefined();
    expect(parseHandlePurposeFromPrefix("")).toBeUndefined();
    // a bare prefix substring in the middle of a string does not count as a match
    expect(parseHandlePurposeFromPrefix(`x_${HANDLE_WIRE_PREFIXES.task}`)).toBeUndefined();
  });

  it("is diagnostic only: a forged prefix with no valid MAC still 'parses'", () => {
    // Documents the file header's warning: this function proves nothing
    // about authenticity. A token that merely starts with the task prefix
    // parses as "task" even though it carries no valid signature at all.
    expect(parseHandlePurposeFromPrefix(`${HANDLE_WIRE_PREFIXES.task}forged-no-mac`)).toBe("task");
  });
});

describe("HANDLE_WIRE_PREFIXES / HANDLE_WIRE_SIZE constants", () => {
  it("has exactly one prefix per StateHandlePurpose, each distinct", () => {
    const prefixes = STATE_HANDLE_PURPOSES.map((p) => HANDLE_WIRE_PREFIXES[p]);
    expect(new Set(prefixes).size).toBe(STATE_HANDLE_PURPOSES.length);
  });

  it("matches the PI-09 acceptance-criteria wire-size targets", () => {
    expect(HANDLE_WIRE_SIZE_TARGET_P95).toBe(256);
    expect(HANDLE_WIRE_SIZE_MAX).toBe(512);
    expect(HANDLE_WIRE_SIZE_TARGET_P95).toBeLessThan(HANDLE_WIRE_SIZE_MAX);
  });
});

describe("DecodedStateHandle / CommonStateInput / TrustedClientContextMeta / ClientContextAttestation / ContextReceipt / LocalTaskState", () => {
  it("round-trips a DecodedStateHandle", () => {
    const v = satisfies<DecodedStateHandle>({
      tokenVersion: 1,
      purpose: "task",
      keyId: "key_1",
      payloadRef: "task_1",
      workspaceRef: "ws_1",
      subjectRef: "subj_1",
      stateVersion: 3,
      issuerId: "server_1",
      stateStoreEpoch: "epoch_1",
      issuedAtMs: 1_000,
      expiresAtMs: 2_000,
      nonce: "nonce_1",
      mac: "mac_1",
    });
    expect(v.purpose).toBe("task");
  });

  it("round-trips an empty and a full CommonStateInput", () => {
    const empty = satisfies<CommonStateInput>({});
    expect(empty.task_handle).toBeUndefined();

    const full = satisfies<CommonStateInput>({
      task_handle: "tlh_task_v1_abc",
      continuation_token: "tlh_cont_v1_def",
      expected_state_version: 3,
      operation_id: "op_1",
      force_serve: false,
    });
    expect(full.task_handle).toBe("tlh_task_v1_abc");
  });

  it("round-trips a TrustedClientContextMeta with a ClientContextAttestation", () => {
    const attestation = satisfies<ClientContextAttestation>({
      attestationVersion: 1,
      source: "trusted-client-host",
      clientId: "client_1",
      clientContextGeneration: "gen_1",
      retainedReceiptIds: ["rcpt_1", "rcpt_2"],
      issuedAtMs: 1_000,
      expiresAtMs: 2_000,
      signature: "sig_1",
    });
    const v = satisfies<TrustedClientContextMeta>({
      context_handle: "tlh_ctx_v1_abc",
      context_attestation: attestation,
    });
    expect(v.context_attestation?.retainedReceiptIds).toHaveLength(2);
  });

  it("round-trips a ContextReceipt", () => {
    const v = satisfies<ContextReceipt>({
      receiptId: "rcpt_1",
      evidenceId: "ev_1" satisfies EvidenceId,
      contentHash: `sha256:${"c".repeat(64)}`,
      servedRange: { startLine: 1, endLine: 20 },
      projectionVersion: "1",
      responseId: "resp_1",
      callId: "call_1",
    });
    expect(v.servedRange?.startLine).toBe(1);
  });

  const LOCAL_TASK_STATE_PHASES = [
    "prepared",
    "acting",
    "verifying",
    "done",
  ] as const satisfies readonly LocalTaskState["phase"][];

  function classifyLocalTaskPhase(phase: LocalTaskState["phase"]): string {
    switch (phase) {
      case "prepared":
        return "certificate issued, no edit applied yet";
      case "acting":
        return "edit in flight";
      case "verifying":
        return "edit applied, verification running";
      case "done":
        return "verification closed";
      default: {
        const exhaustive: never = phase;
        throw new Error(`classifyLocalTaskPhase(): unhandled phase ${String(exhaustive)}`);
      }
    }
  }

  it("LocalTaskState.phase is exhaustively classifiable", () => {
    assertExhaustive(LOCAL_TASK_STATE_PHASES, classifyLocalTaskPhase);
  });

  it("round-trips a LocalTaskState", () => {
    const v = satisfies<LocalTaskState>({
      taskRef: "task_1",
      taskHandle: "tlh_task_v1_abc",
      targetHandle: "handle_1",
      baseSha: `sha256:${"d".repeat(64)}`,
      targetFingerprint: "fp_1",
      stateVersion: 2,
      phase: "acting",
    });
    expect(v.phase).toBe("acting");
  });
});

// ---------------------------------------------------------------------------
// reasoning.ts
// ---------------------------------------------------------------------------

const TASK_DECISION_STATES = [
  "pending",
  "prepared",
  "acting",
  "verifying",
  "done",
] as const satisfies readonly TaskReasoningIR["decision"]["state"][];

function classifyTaskDecisionState(state: TaskReasoningIR["decision"]["state"]): string {
  switch (state) {
    case "pending":
      return "not yet started";
    case "prepared":
      return "certificate issued";
    case "acting":
      return "edit in flight";
    case "verifying":
      return "verification running";
    case "done":
      return "closed";
    default: {
      const exhaustive: never = state;
      throw new Error(`classifyTaskDecisionState(): unhandled state ${String(exhaustive)}`);
    }
  }
}

describe("TaskReasoningIR", () => {
  it("decision.state is exhaustively classifiable", () => {
    assertExhaustive(TASK_DECISION_STATES, classifyTaskDecisionState);
  });

  it("round-trips a TaskReasoningIR", () => {
    const v = satisfies<TaskReasoningIR>({
      taskRef: "task_1",
      stateVersion: 1,
      stateHash: `sha256:${"e".repeat(64)}`,
      goal: "add v0.10 domain types",
      constraints: [{ id: "c1", text: "never touch mcp/**", source: "user" }],
      evidenceCatalog: [],
      evidenceUses: [],
      obligations: [
        { id: "ob_1", claim: "domain.spec.ts is green", state: "satisfied", evidenceRefs: [] },
      ],
      decision: { state: "verifying", evidenceRefs: [] },
      allowedNext: [{ tool: "read_file", reason: "confirm build output" }],
      invalidationKeys: [{ type: "workspace-sha", value: "abc123" }],
    });
    expect(v.decision.state).toBe("verifying");
    expect(v.obligations[0].state).toBe("satisfied");
  });
});

// ---------------------------------------------------------------------------
// search.ts
// ---------------------------------------------------------------------------

const TERM_RESULT_STATUSES = ["matched", "absent", "unknown"] as const satisfies readonly TermResult["status"][];

function classifyTermStatus(status: TermResult["status"]): string {
  switch (status) {
    case "matched":
      return "at least one occurrence found";
    case "absent":
      return "certified not present in scope";
    case "unknown":
      return "not determined (e.g. partial scope)";
    default: {
      const exhaustive: never = status;
      throw new Error(`classifyTermStatus(): unhandled status ${String(exhaustive)}`);
    }
  }
}

describe("TermResult", () => {
  it("status is exhaustively classifiable", () => {
    assertExhaustive(TERM_RESULT_STATUSES, classifyTermStatus);
  });

  it("round-trips a matched TermResult", () => {
    const v = satisfies<TermResult>({
      original: "EvidenceIdentity",
      normalized: ["evidenceidentity"],
      status: "matched",
      matchCount: 3,
      scope: { root: "packages/types/src/domain", completeness: "complete", indexGeneration: "gen_1" },
      evidenceRefs: ["ev_1"],
    });
    expect(v.status).toBe("matched");
  });

  it("round-trips an absent TermResult carrying an absence certificate", () => {
    const v = satisfies<TermResult>({
      original: "NoSuchSymbol",
      normalized: ["nosuchsymbol"],
      status: "absent",
      matchCount: 0,
      scope: { root: "packages/types/src", completeness: "complete", indexGeneration: "gen_1" },
      evidenceRefs: [],
      absenceRef: "abs_1",
    });
    expect(v.absenceRef).toBe("abs_1");
  });
});

describe("TreeScopeReport", () => {
  it("round-trips a report satisfying the visited=returned+excluded+errors invariant", () => {
    const v = satisfies<TreeScopeReport>({
      requestedRoot: "packages/types",
      resolvedRoot: "packages/types",
      completeness: "complete",
      counts: { visited: 10, returned: 8, excluded: 2, errors: 0 },
      excludedByReason: {
        ignored: 1,
        hiddenPolicy: 0,
        generatedPolicy: 0,
        vendorPolicy: 0,
        binary: 0,
        unsupportedType: 0,
        tooLarge: 0,
        permissionDenied: 0,
        symlinkPolicy: 0,
        outsideWorkspace: 0,
        budget: 1,
      },
    });
    expect(v.counts.visited).toBe(v.counts.returned + v.counts.excluded + v.counts.errors);
    expect(v.continuation).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// budget.ts
// ---------------------------------------------------------------------------

const HOST_BUDGET_SOURCES = [
  "client-capability",
  "client-profile",
  "server-default",
] as const satisfies readonly HostBudgetProfile["source"][];

function classifyBudgetSource(source: HostBudgetProfile["source"]): string {
  switch (source) {
    case "client-capability":
      return "negotiated from the client's advertised capability";
    case "client-profile":
      return "looked up from a known client profile";
    case "server-default":
      return "server fallback, no client signal";
    default: {
      const exhaustive: never = source;
      throw new Error(`classifyBudgetSource(): unhandled source ${String(exhaustive)}`);
    }
  }
}

describe("HostBudgetProfile", () => {
  it("source is exhaustively classifiable", () => {
    assertExhaustive(HOST_BUDGET_SOURCES, classifyBudgetSource);
  });

  it("round-trips a HostBudgetProfile", () => {
    const v = satisfies<HostBudgetProfile>({
      maxToolResultBytes: 65536,
      safetyReserveBytes: 4096,
      source: "client-capability",
    });
    expect(v.source).toBe("client-capability");
  });
});

// ---------------------------------------------------------------------------
// measurement.ts
// ---------------------------------------------------------------------------

const ENCODING_CODECS = [
  "json",
  "tl-table-1",
  "toon-4.1",
  "tl-raw-1",
] as const satisfies readonly EncodingDecision["codec"][];

function classifyCodec(codec: EncodingDecision["codec"]): string {
  switch (codec) {
    case "json":
      return "no TL codec applied";
    case "tl-table-1":
      return "tabular TL codec v1";
    case "toon-4.1":
      return "TOON codec 4.1";
    case "tl-raw-1":
      return "raw TL codec v1";
    default: {
      const exhaustive: never = codec;
      throw new Error(`classifyCodec(): unhandled codec ${String(exhaustive)}`);
    }
  }
}

const CONTRIBUTION_LAYERS = [
  "wire",
  "context",
  "session",
  "billing",
  "verified-task",
] as const satisfies readonly ContributionEstimate["layer"][];

function classifyContributionLayer(layer: ContributionEstimate["layer"]): string {
  switch (layer) {
    case "wire":
      return "bytes on the wire";
    case "context":
      return "bytes retained in the client's context window";
    case "session":
      return "whole-session token accounting";
    case "billing":
      return "billed cost";
    case "verified-task":
      return "paired, verified task-level cost";
    default: {
      const exhaustive: never = layer;
      throw new Error(`classifyContributionLayer(): unhandled layer ${String(exhaustive)}`);
    }
  }
}

describe("EncodingDecision", () => {
  it("codec is exhaustively classifiable", () => {
    assertExhaustive(ENCODING_CODECS, classifyCodec);
  });

  it("round-trips an EncodingDecision", () => {
    const v = satisfies<EncodingDecision>({
      codec: "tl-table-1",
      semanticPayloadHash: `sha256:${"f".repeat(64)}`,
      jsonBytes: 4096,
      encodedBytes: 2048,
      jsonTokens: 1200,
      encodedTokens: 640,
    });
    expect(v.encodedBytes).toBeLessThan(v.jsonBytes);
  });
});

describe("ContributionEstimate", () => {
  it("layer is exhaustively classifiable", () => {
    assertExhaustive(CONTRIBUTION_LAYERS, classifyContributionLayer);
  });

  it("round-trips a measured estimate", () => {
    const v = satisfies<ContributionEstimate>({
      layer: "session",
      status: "measured",
      confidence: "high",
      method: "paired-bootstrap",
      observed: 120_000,
      counterfactual: 200_000,
      saved: 80_000,
      reductionPercent: 40,
      interval95: { low: 32, high: 48 },
      sampleCount: 30,
      warnings: [],
    });
    expect(v.saved).toBe(80_000);
  });

  it("round-trips an unavailable estimate: null, not 0, and never rounded", () => {
    const v = satisfies<ContributionEstimate>({
      layer: "billing",
      status: "unavailable",
      confidence: "unavailable",
      method: "no-baseline",
      observed: null,
      counterfactual: null,
      saved: null,
      reductionPercent: null,
      warnings: ["missing-log"],
    });
    expect(v.saved).toBeNull();
    expect(v.saved).not.toBe(0);
  });

  it("does not round a negative saving to zero", () => {
    const v = satisfies<ContributionEstimate>({
      layer: "wire",
      status: "measured",
      confidence: "medium",
      method: "direct-byte-diff",
      observed: 5000,
      counterfactual: 4000,
      saved: -1000,
      reductionPercent: -25,
      warnings: [],
    });
    expect(v.saved).toBe(-1000);
  });
});

// ---------------------------------------------------------------------------
// Re-export parity: the top-level barrel (`../index.js`) must forward the
// exact same runtime bindings `../domain/index.js` exports — same identity,
// not a re-implementation. Mirrors `types.spec.ts`'s
// `MCP_LANGS_FROM_MODULES` `.toBe()` pattern.
// ---------------------------------------------------------------------------

describe("top-level barrel re-export parity", () => {
  it("forwards the exact same function/const bindings as the domain barrel", () => {
    expect(isEvidenceRole).toBe(isEvidenceRoleDirect);
    expect(isDeliveryDisposition).toBe(isDeliveryDispositionDirect);
    expect(isStateHandlePurpose).toBe(isStateHandlePurposeDirect);
    expect(HANDLE_WIRE_PREFIXES).toBe(HANDLE_WIRE_PREFIXES_DIRECT);
  });
});

// ---------------------------------------------------------------------------
// D-1 boundary check: the domain barrel must never re-export the frozen wire
// contract. Type-only exports erase at runtime, so the two checks below
// cover what is actually checkable:
//  (a) STATIC — no `domain/*.ts` source file imports from `../mcp` at all
//      (catches a `export type * from "../mcp/..."` re-export, which would
//      vanish from any runtime introspection);
//  (b) RUNTIME — the two barrels' actual runtime namespaces (their value
//      exports: guards/consts on the domain side, `MCP_LANGS`/
//      `MCP_LANG_EXTS` on the wire side) share no key.
// ---------------------------------------------------------------------------

describe("the domain barrel does not re-export the wire protocol", () => {
  const DOMAIN_DIR = fileURLToPath(new URL("../domain/", import.meta.url));

  it("no domain/*.ts source file imports from ../mcp", () => {
    const files = readdirSync(DOMAIN_DIR).filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    const importsFromMcp = /from\s+["'](?:\.\.\/)+mcp(?:\.js|\/|["'])/;
    for (const file of files) {
      const text = readFileSync(join(DOMAIN_DIR, file), "utf8");
      expect(text).not.toMatch(importsFromMcp);
    }
  });

  it("the domain barrel's runtime namespace shares no key with the mcp barrel's", () => {
    const domainKeys = new Set(Object.keys(domainBarrel));
    const mcpKeys = new Set(Object.keys(mcpBarrel));

    // Sanity: both namespaces actually export something at runtime, so an
    // empty-set false pass is not silently accepted.
    expect(domainKeys.size).toBeGreaterThan(0);
    expect(mcpKeys.size).toBeGreaterThan(0);

    // The two known wire runtime exports must not appear on the domain side.
    expect(domainKeys.has("MCP_LANGS")).toBe(false);
    expect(domainKeys.has("MCP_LANG_EXTS")).toBe(false);

    for (const key of domainKeys) {
      expect(mcpKeys.has(key)).toBe(false);
    }
    for (const key of mcpKeys) {
      expect(domainKeys.has(key)).toBe(false);
    }
  });
});
