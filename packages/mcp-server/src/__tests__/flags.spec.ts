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
  adaptiveWholeFileEnabled,
  evidenceCompletionShadowEnabled,
  evidenceCompletionEnabled,
  writeCapabilityEnabled,
  decisionInvariantStrictEnabled,
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
  "TL_ADAPTIVE_WHOLE_FILE",
  "TL_EVIDENCE_SHADOW",
  "TL_EVIDENCE_COMPLETION",
  "TL_WRITE_CAPABILITY",
  "TL_DECISION_INVARIANT_STRICT",
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
    expect(Object.keys(flags).sort()).toEqual([
      "adaptiveWholeFileEnabled",
      "decisionInvariantStrictEnabled",
      "evidenceCompletionEnabled",
      "evidenceCompletionShadowEnabled",
      "graphIndexMode",
      "hop1ClosureEnabled",
      "traceEnabled",
      "verificationRecipeEnabled",
      "writeCapabilityEnabled",
    ]);
  });

  it("reads no env var belonging to a permanent-on flag", () => {
    // The module is the single reader of these names. Setting them to their
    // former rollback value must not resolve to anything at all — there is no
    // accessor left to consult, which is what "the off-branch is deleted" means.
    for (const [env] of D10_PERMANENT_ON) process.env[env] = "0";
    expect(Object.keys(flags)).toHaveLength(9);
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
    expect(adaptiveWholeFileEnabled()).toBe(false);
    expect(evidenceCompletionShadowEnabled()).toBe(false);
    expect(evidenceCompletionEnabled()).toBe(false);
    expect(writeCapabilityEnabled()).toBe(false);
  });

  it("decisionInvariantStrictEnabled defaults to false", () => {
    expect(decisionInvariantStrictEnabled()).toBe(false);
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
      process.env["TL_ADAPTIVE_WHOLE_FILE"] = val;
      process.env["TL_EVIDENCE_SHADOW"] = val;
      process.env["TL_WRITE_CAPABILITY"] = val;
      expect(verificationRecipeEnabled()).toBe(true);
      expect(hop1ClosureEnabled()).toBe(true);
      expect(adaptiveWholeFileEnabled()).toBe(true);
      expect(evidenceCompletionShadowEnabled()).toBe(true);
      expect(writeCapabilityEnabled()).toBe(true);
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
