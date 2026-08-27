/**
 * flags.spec.ts — unit tests for the feature flag reader.
 *
 * D10 (2026-08-14): the fifteen wire-affecting flags were made permanent-on and
 * their readers deleted. The tests that exercised their off-branches are GONE
 * with the branches — a test for `taskPackEnabled(false)` cannot pass and must
 * not be resurrected. In their place, `describe("D10 permanent-on freeze")`
 * pins the thing that now matters: the module must not export those readers
 * again, and the env vars must be inert. Everything still tested here is
 * out-of-contract (B)/(C) by that same adjudication.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as flags from "../util/flags.js";
import {
  graphIndexMode,
  traceEnabled,
  verificationRecipeEnabled,
  hop1ClosureEnabled,
  interfaceAuthorityEnabled,
  adaptiveWholeFileEnabled,
  evidenceCompletionShadowEnabled,
  evidenceCompletionEnabled,
  writeCapabilityEnabled,
  decisionInvariantStrictEnabled,
  bm25fCandidateEnabled,
  rrfFusionEnabled,
  rrfProfilesEnabled,
  coveragePackerEnabled,
  coveragePackerV2Enabled,
  graphEvidenceEnabled,
  responseFormatMode,
  wireShadowEnabled,
  wireBreakevenEnabled,
  reasoningIrV2Enabled,
  fastPathV2Enabled,
  postReadyTrimEnabled,
  postReadyTrimThreshold,
  overlapTrimEnabled,
  deltaContextEnabled,
  compoundRetrievalEnabled,
} from "../util/flags.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let savedEnv: Record<string, string | undefined>;

/** The (B)/(C) flags this module still reads. */
const FLAG_KEYS = [
  "TL_GRAPH_INDEX",
  "TL_TRACE",
  "TL_VERIFICATION_RECIPE",
  "TL_HOP1_CLOSURE",
  "TL_INTERFACE_AUTHORITY",
  "TL_ADAPTIVE_WHOLE_FILE",
  "TL_EVIDENCE_SHADOW",
  "TL_EVIDENCE_COMPLETION",
  "TL_WRITE_CAPABILITY",
  "TL_DECISION_INVARIANT_STRICT",
  "TL_BM25F_CANDIDATE",
  "TL_RRF_FUSION",
  "TL_RRF_PROFILES",
  "TL_COVERAGE_PACKER",
  "TL_COVERAGE_PACKER_V2",
  "TL_GRAPH_EVIDENCE",
  "TOKENLIGHTEN_RESPONSE_FORMAT",
  "TL_WIRE_SHADOW",
  "TL_WIRE_BREAKEVEN",
  "TL_REASONING_IR_V2",
  "TL_FAST_PATH_V2",
  "TL_POST_READY_TRIM",
  "TL_POST_READY_TRIM_N",
  "TL_OVERLAP_TRIM",
  "TL_DELTA_CONTEXT",
  "TL_COMPOUND_RETRIEVAL",
] as const;

/**
 * D10 (A): permanent-on, reader deleted. Named here so a reintroduction is a
 * test failure rather than a silent unfreezing of the protocol.
 */
const D10_PERMANENT_ON = [
  ["TL_TASK_PACK", "taskPackEnabled"],
  ["TL_FULL_GOVERNOR", "fullGovernorEnabled"],
  ["TL_SMALL_FILE_ONE_CALL", "smallFileOneCallEnabled"],
  ["TL_EDIT_INTENTS", "editIntentsEnabled"],
  ["TL_SESSION_CONTROL", "sessionControlEnabled"],
  ["TL_LEAN_CONTRACT", "leanContractEnabled"],
  ["TL_RECURSIVE_READ_CLOSURE", "recursiveReadClosureEnabled"],
  ["TL_EVIDENCE_RELATIONS", "evidenceRelationsEnabled"],
  ["TL_SEMANTIC_WIRING", "semanticWiringEnabled"],
  ["TL_REFUSAL_PROGRESS", "refusalProgressEnabled"],
  ["TL_CONSTRUCT_RECEIVER", "constructReceiverEnabled"],
  ["TL_QUERY_BEHAVIOR_PROOF", "queryBehaviorProofEnabled"],
  ["TL_HUB_PUBLISH_ANCHOR", "hubPublishAnchorEnabled"],
  ["TL_SERVED_RANGE_LEDGER", "servedRangeLedgerEnabled"],
  ["TL_CREATE_REQUIRES_CWD", "createRequiresCwdEnabled"],
] as const;

beforeEach(() => {
  savedEnv = {};
  for (const key of [...FLAG_KEYS, ...D10_PERMANENT_ON.map(([env]) => env)]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

// ---------------------------------------------------------------------------
// D10 freeze
// ---------------------------------------------------------------------------

describe("D10 permanent-on freeze", () => {
  it.each(D10_PERMANENT_ON)(
    "%s is permanent-on: no reader named %s survives",
    (_env, reader) => {
      expect(Object.keys(flags)).not.toContain(reader);
    },
  );

  it("exports ONLY the out-of-contract (B)/(C) readers", () => {
    // V10-11 added responseFormatMode/wireShadowEnabled -- see util/flags.ts's
    // "V10-11 addendum" doc block for why they belong in this same bucket:
    // they select wire SERIALIZATION, never protocol v1's canonical shape.
    // V10-02 added activeExperimentFlags -- an AGGREGATOR over the (B) flags
    // (feeds util/trace.ts's envelope `flags_active`), not a new env reader:
    // it introduces no new FLAG_KEYS entry, only a new name in this list.
    //
    // The v0.10 close-out added contextAttestationEnabled (PI-03). It is a
    // class-(B) reader: default OFF, and both OFF and "ON but nothing
    // verifies" are byte-identical to pre-PI-03 output -- see util/flags.ts's
    // "PI-03 addendum".
    //
    // v0.11 wave B added coveragePackerV2Enabled (V11-03) -- see util/
    // flags.ts's "V11-03 addendum": composes with coveragePackerEnabled, off
    // by itself is a no-op (the seam it gates only runs when
    // coveragePackerEnabled() is also true).
    // V11-06 added fastPathV2Enabled (TL_FAST_PATH_V2). Class (B): default
    // OFF, and — like graphEvidenceEnabled before it — an out-of-contract
    // capability addition rather than a wire-shape change.
    expect(Object.keys(flags).sort()).toEqual([
      "activeExperimentFlags",
      "adaptiveWholeFileEnabled",
      "bm25fCandidateEnabled",
      "compoundRetrievalEnabled",
      "contextAttestationEnabled",
      "coveragePackerEnabled",
      "coveragePackerV2Enabled",
      "decisionInvariantStrictEnabled",
      "deltaContextEnabled",
      "evidenceCompletionEnabled",
      "evidenceCompletionShadowEnabled",
      "fastPathV2Enabled",
      "graphEvidenceEnabled",
      "graphIndexMode",
      "hop1ClosureEnabled",
      "interfaceAuthorityEnabled",
      "overlapTrimEnabled",
      "postReadyTrimEnabled",
      "postReadyTrimThreshold",
      "reasoningIrV2Enabled",
      "responseFormatMode",
      "rrfFusionEnabled",
      "rrfProfilesEnabled",
      "traceEnabled",
      "verificationRecipeEnabled",
      "wireBreakevenEnabled",
      "wireShadowEnabled",
      "writeCapabilityEnabled",
    ]);
  });

  it("reads no env var belonging to a permanent-on flag", () => {
    // The module is the single reader of these names. Setting them to their
    // former rollback value must not resolve to anything at all — there is no
    // accessor left to consult, which is what "the off-branch is deleted" means.
    for (const [env] of D10_PERMANENT_ON) process.env[env] = "0";
    // 21 env-backed readers + activeExperimentFlags (V10-02's aggregator,
    // which reads no env var of its own — see the export-list test above).
    // V11-01 added graphEvidenceEnabled (TL_GRAPH_EVIDENCE), class (B).
    // V11-07 added wireBreakevenEnabled (TL_WIRE_BREAKEVEN), class (B).
    // V11-02 added rrfProfilesEnabled (TL_RRF_PROFILES), class (B).
    // V11-04 added reasoningIrV2Enabled (TL_REASONING_IR_V2), class (B): its
    // one dispatch seam is advisory and trace-only, so OFF is byte-identical.
    // V11-03 added coveragePackerV2Enabled (TL_COVERAGE_PACKER_V2), class (B).
    // V11-06 added fastPathV2Enabled (TL_FAST_PATH_V2), class (B).
    // V11-05 added compoundRetrievalEnabled (TL_COMPOUND_RETRIEVAL), class (B).
    // V12-02/B2 added deltaContextEnabled (TL_DELTA_CONTEXT), class (B): the
    // ONLY writer of a carried ledger entry's `deltaFromSha`, which every
    // delta-serving branch then gates on — so OFF leaves those branches
    // unreachable and the wire unchanged (deltaContextDispatch.spec.ts cell a).
    expect(Object.keys(flags)).toHaveLength(28);
  });
});

// ---------------------------------------------------------------------------
// Defaults when env is unset
// ---------------------------------------------------------------------------

describe("defaults when env is unset", () => {
  it("graphIndexMode defaults to 'auto'", () => {
    expect(graphIndexMode()).toBe("auto");
  });

  it("traceEnabled defaults to false", () => {
    expect(traceEnabled()).toBe(false);
  });

  it("D10 (B) out-of-contract experiments all default to false", () => {
    expect(verificationRecipeEnabled()).toBe(false);
    expect(hop1ClosureEnabled()).toBe(false);
    expect(interfaceAuthorityEnabled()).toBe(false);
    expect(adaptiveWholeFileEnabled()).toBe(false);
    expect(evidenceCompletionShadowEnabled()).toBe(false);
    expect(evidenceCompletionEnabled()).toBe(false);
    expect(writeCapabilityEnabled()).toBe(false);
    expect(bm25fCandidateEnabled()).toBe(false);
    expect(rrfFusionEnabled()).toBe(false);
    expect(rrfProfilesEnabled()).toBe(false);
    expect(coveragePackerEnabled()).toBe(false);
    expect(coveragePackerV2Enabled()).toBe(false);
    expect(graphEvidenceEnabled()).toBe(false);
    expect(fastPathV2Enabled()).toBe(false);
    expect(compoundRetrievalEnabled()).toBe(false);
  });

  it("decisionInvariantStrictEnabled defaults to false", () => {
    expect(decisionInvariantStrictEnabled()).toBe(false);
  });

  it("responseFormatMode defaults to 'json'", () => {
    expect(responseFormatMode()).toBe("json");
  });

  it("wireShadowEnabled defaults to false", () => {
    expect(wireShadowEnabled()).toBe(false);
  });

  it("wireBreakevenEnabled defaults to false", () => {
    expect(wireBreakevenEnabled()).toBe(false);
  });

  it("reasoningIrV2Enabled defaults to false", () => {
    expect(reasoningIrV2Enabled()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Explicit values
// ---------------------------------------------------------------------------

describe("enabling with truthy values", () => {
  it.each(["1", "true", "yes", "on"])("traceEnabled('%s') => true", (val) => {
    process.env["TL_TRACE"] = val;
    expect(traceEnabled()).toBe(true);
  });

  it.each(["1", "true", "yes", "on"])(
    "out-of-contract experiments accept explicit opt-in '%s'",
    (val) => {
      process.env["TL_VERIFICATION_RECIPE"] = val;
      process.env["TL_HOP1_CLOSURE"] = val;
      process.env["TL_INTERFACE_AUTHORITY"] = val;
      process.env["TL_ADAPTIVE_WHOLE_FILE"] = val;
      process.env["TL_EVIDENCE_SHADOW"] = val;
      process.env["TL_WRITE_CAPABILITY"] = val;
      process.env["TL_BM25F_CANDIDATE"] = val;
      process.env["TL_RRF_FUSION"] = val;
      process.env["TL_RRF_PROFILES"] = val;
      process.env["TL_COVERAGE_PACKER"] = val;
      process.env["TL_COVERAGE_PACKER_V2"] = val;
      process.env["TL_GRAPH_EVIDENCE"] = val;
      process.env["TL_REASONING_IR_V2"] = val;
      process.env["TL_FAST_PATH_V2"] = val;
      process.env["TL_COMPOUND_RETRIEVAL"] = val;
      expect(verificationRecipeEnabled()).toBe(true);
      expect(hop1ClosureEnabled()).toBe(true);
      expect(interfaceAuthorityEnabled()).toBe(true);
      expect(adaptiveWholeFileEnabled()).toBe(true);
      expect(evidenceCompletionShadowEnabled()).toBe(true);
      expect(writeCapabilityEnabled()).toBe(true);
      expect(bm25fCandidateEnabled()).toBe(true);
      expect(rrfFusionEnabled()).toBe(true);
      expect(rrfProfilesEnabled()).toBe(true);
      expect(coveragePackerEnabled()).toBe(true);
      expect(coveragePackerV2Enabled()).toBe(true);
      expect(graphEvidenceEnabled()).toBe(true);
      expect(reasoningIrV2Enabled()).toBe(true);
      expect(fastPathV2Enabled()).toBe(true);
      expect(compoundRetrievalEnabled()).toBe(true);
    },
  );

  it.each(["0", "false", "no", "off", ""])("traceEnabled('%s') => false", (val) => {
    process.env["TL_TRACE"] = val;
    expect(traceEnabled()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TL_GRAPH_INDEX
// ---------------------------------------------------------------------------

describe("graphIndexMode", () => {
  it.each(["1", "true", "yes", "on"])("graphIndexMode('%s') => 'on'", (val) => {
    process.env["TL_GRAPH_INDEX"] = val;
    expect(graphIndexMode()).toBe("on");
  });

  it.each(["0", "false", "no", "off"])("graphIndexMode('%s') => 'off'", (val) => {
    process.env["TL_GRAPH_INDEX"] = val;
    expect(graphIndexMode()).toBe("off");
  });

  it("graphIndexMode('auto') => 'auto'", () => {
    process.env["TL_GRAPH_INDEX"] = "auto";
    expect(graphIndexMode()).toBe("auto");
  });

  it("graphIndexMode with unknown value falls back to 'auto'", () => {
    process.env["TL_GRAPH_INDEX"] = "maybe";
    expect(graphIndexMode()).toBe("auto");
  });
});

// ---------------------------------------------------------------------------
// Case insensitivity
// ---------------------------------------------------------------------------

describe("case insensitivity", () => {
  it.each(["True", "TRUE", "FALSE", "False", "YES", "NO", "ON", "OFF"])(
    "parses '%s' case-insensitively",
    (val) => {
      process.env["TL_VERIFICATION_RECIPE"] = val;
      const result = verificationRecipeEnabled();
      const lower = val.toLowerCase();
      if (["true", "yes", "on"].includes(lower)) {
        expect(result).toBe(true);
      } else {
        expect(result).toBe(false);
      }
    },
  );

  it("an unrecognised value falls back to the documented default", () => {
    process.env["TL_VERIFICATION_RECIPE"] = "perhaps";
    expect(verificationRecipeEnabled()).toBe(false);
  });

  it("graphIndexMode is case-insensitive for 'AUTO'", () => {
    process.env["TL_GRAPH_INDEX"] = "AUTO";
    // "auto" does not match any truthy/falsy — falls back to "auto"
    expect(graphIndexMode()).toBe("auto");
  });

  it("graphIndexMode is case-insensitive for 'ON'", () => {
    process.env["TL_GRAPH_INDEX"] = "ON";
    expect(graphIndexMode()).toBe("on");
  });

  it("graphIndexMode is case-insensitive for 'OFF'", () => {
    process.env["TL_GRAPH_INDEX"] = "OFF";
    expect(graphIndexMode()).toBe("off");
  });
});

// ---------------------------------------------------------------------------
// V10-11: TOKENLIGHTEN_RESPONSE_FORMAT / TL_WIRE_SHADOW
// ---------------------------------------------------------------------------

describe("responseFormatMode", () => {
  it.each(["auto", "compact", "debug"] as const)("responseFormatMode('%s') => '%s'", (val) => {
    process.env["TOKENLIGHTEN_RESPONSE_FORMAT"] = val;
    expect(responseFormatMode()).toBe(val);
  });

  it("responseFormatMode('json') => 'json'", () => {
    process.env["TOKENLIGHTEN_RESPONSE_FORMAT"] = "json";
    expect(responseFormatMode()).toBe("json");
  });

  it.each(["AUTO", "Compact", "bogus", ""])(
    "an unrecognized or wrongly-cased value '%s' falls back to 'json' (never throws, never silently picks a compact mode)",
    (val) => {
      process.env["TOKENLIGHTEN_RESPONSE_FORMAT"] = val;
      expect(responseFormatMode()).toBe("json");
    },
  );
});

describe("wireShadowEnabled", () => {
  it.each(["1", "true", "yes", "on"])("wireShadowEnabled('%s') => true", (val) => {
    process.env["TL_WIRE_SHADOW"] = val;
    expect(wireShadowEnabled()).toBe(true);
  });

  it.each(["0", "false", "no", "off", ""])("wireShadowEnabled('%s') => false", (val) => {
    process.env["TL_WIRE_SHADOW"] = val;
    expect(wireShadowEnabled()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// V11-07: TL_WIRE_BREAKEVEN
// ---------------------------------------------------------------------------

describe("wireBreakevenEnabled", () => {
  it.each(["1", "true", "yes", "on"])("wireBreakevenEnabled('%s') => true", (val) => {
    process.env["TL_WIRE_BREAKEVEN"] = val;
    expect(wireBreakevenEnabled()).toBe(true);
  });

  it.each(["0", "false", "no", "off", ""])("wireBreakevenEnabled('%s') => false", (val) => {
    process.env["TL_WIRE_BREAKEVEN"] = val;
    expect(wireBreakevenEnabled()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// V11-03: TL_COVERAGE_PACKER_V2
// ---------------------------------------------------------------------------

describe("coveragePackerV2Enabled", () => {
  it.each(["1", "true", "yes", "on"])("coveragePackerV2Enabled('%s') => true", (val) => {
    process.env["TL_COVERAGE_PACKER_V2"] = val;
    expect(coveragePackerV2Enabled()).toBe(true);
  });

  it.each(["0", "false", "no", "off", ""])("coveragePackerV2Enabled('%s') => false", (val) => {
    process.env["TL_COVERAGE_PACKER_V2"] = val;
    expect(coveragePackerV2Enabled()).toBe(false);
  });

  it("reads its own env var independently of TL_COVERAGE_PACKER (the seam enforces composition, not this reader)", () => {
    delete process.env["TL_COVERAGE_PACKER"];
    process.env["TL_COVERAGE_PACKER_V2"] = "1";
    expect(coveragePackerEnabled()).toBe(false);
    expect(coveragePackerV2Enabled()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// V11-06: TL_FAST_PATH_V2
// ---------------------------------------------------------------------------

describe("fastPathV2Enabled", () => {
  it.each(["1", "true", "yes", "on"])("fastPathV2Enabled('%s') => true", (val) => {
    process.env["TL_FAST_PATH_V2"] = val;
    expect(fastPathV2Enabled()).toBe(true);
  });

  it.each(["0", "false", "no", "off", ""])("fastPathV2Enabled('%s') => false", (val) => {
    process.env["TL_FAST_PATH_V2"] = val;
    expect(fastPathV2Enabled()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// W5: TL_POST_READY_TRIM
// ---------------------------------------------------------------------------

describe("overlapTrimEnabled", () => {
  it.each(["1", "true", "yes", "on"])("overlapTrimEnabled(\'%s\') => true", (val) => {
    process.env["TL_OVERLAP_TRIM"] = val;
    expect(overlapTrimEnabled()).toBe(true);
  });

  it.each(["0", "false", "no", "off", ""])("overlapTrimEnabled(\'%s\') => false", (val) => {
    process.env["TL_OVERLAP_TRIM"] = val;
    expect(overlapTrimEnabled()).toBe(false);
  });

  it("defaults to false", () => {
    expect(overlapTrimEnabled()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B2 / V12-02: TL_DELTA_CONTEXT
// ---------------------------------------------------------------------------

describe("deltaContextEnabled", () => {
  it.each(["1", "true", "yes", "on"])("deltaContextEnabled('%s') => true", (val) => {
    process.env["TL_DELTA_CONTEXT"] = val;
    expect(deltaContextEnabled()).toBe(true);
  });

  it.each(["0", "false", "no", "off", ""])("deltaContextEnabled('%s') => false", (val) => {
    process.env["TL_DELTA_CONTEXT"] = val;
    expect(deltaContextEnabled()).toBe(false);
  });

  it("defaults to false", () => {
    expect(deltaContextEnabled()).toBe(false);
  });

  it("is INDEPENDENT of TL_OVERLAP_TRIM in both directions", () => {
    // The two levers reuse the same `segments[]` projection but answer
    // different questions (a partially overlapping read of an UNCHANGED file
    // vs. a ledger carried ACROSS a change). Neither may imply the other, or
    // the retired W7 lever would come back on with this one.
    process.env["TL_OVERLAP_TRIM"] = "1";
    expect(deltaContextEnabled()).toBe(false);
    delete process.env["TL_OVERLAP_TRIM"];
    process.env["TL_DELTA_CONTEXT"] = "1";
    expect(overlapTrimEnabled()).toBe(false);
  });

  it("names itself in activeExperimentFlags only while it is on", () => {
    expect(flags.activeExperimentFlags()).not.toContain("TL_DELTA_CONTEXT");
    process.env["TL_DELTA_CONTEXT"] = "1";
    expect(flags.activeExperimentFlags()).toContain("TL_DELTA_CONTEXT");
  });
});

describe("postReadyTrim", () => {
  it.each(["1", "true", "yes", "on"])("postReadyTrimEnabled('%s') => true", (val) => {
    process.env["TL_POST_READY_TRIM"] = val;
    expect(postReadyTrimEnabled()).toBe(true);
  });

  it.each(["0", "false", "no", "off", ""])("postReadyTrimEnabled('%s') => false", (val) => {
    process.env["TL_POST_READY_TRIM"] = val;
    expect(postReadyTrimEnabled()).toBe(false);
  });

  it("uses N=6 by default and fails closed for invalid bounds", () => {
    expect(postReadyTrimThreshold()).toBe(6);
    for (const value of ["0", "-1", "33", "bogus"]) {
      process.env["TL_POST_READY_TRIM_N"] = value;
      expect(postReadyTrimThreshold()).toBe(6);
    }
  });

  it("accepts a bounded configurable N", () => {
    process.env["TL_POST_READY_TRIM_N"] = "7";
    expect(postReadyTrimThreshold()).toBe(7);
  });
});
