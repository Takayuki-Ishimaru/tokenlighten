/**
 * trace.spec.ts — unit tests for util/trace.ts
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  computedConfigSha256,
  trace,
  traceCausalAttestation,
  getTracePath,
  isTraceEnabled,
  setTraceEnabledForTest,
} from "../util/trace.js";
import { SEMANTIC_FRONTIER_V2_FLAG_REGISTRY, traceEnabled } from "../util/flags.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpHome: string;
let origHome: string | undefined;
let origCausalEnv: Record<string, string | undefined>;

const CAUSAL_ENV_KEYS = [
  "TL_MCP_CONFIG_SHA256",
  "TL_P1_CAUSAL_RUN_NONCE",
  // v0.14 flag inventory (2026-08-31): the former digest-movement flags
  // (TL_EVIDENCE_COMPLETION/TL_EVIDENCE_SHADOW/TL_WRITE_CAPABILITY/
  // TL_ADAPTIVE_WHOLE_FILE/TL_HOP1_CLOSURE) were deleted with their
  // experiments. resolvedFlagValues() now covers exactly TL_GRAPH_INDEX,
  // TL_SEMANTIC_FRONTIER_GUARD, and TL_TRACE, so those are what the digest
  // tests below toggle. Touched only by the computed-digest tests below;
  // listed here so the beforeEach/afterEach save-restore covers them like
  // every other TL_* input (TL_SEMANTIC_FRONTIER_GUARD's own default
  // flipped to OFF 2026-09-02 — see util/flags.ts — but it still moves the
  // digest whenever it is explicitly set, which is what these tests pin).
  "TL_TRACE",
  "TL_GRAPH_INDEX",
  "TL_SEMANTIC_FRONTIER_GUARD",
  // FX-R3 D5 (2026-09-04): the arm-defining v0.15 flags. They now move the
  // digest (util/trace.ts's `resolvedFlagValues`), so the save/restore must
  // cover them like every other TL_* input.
  "TL_GRAPH_EVIDENCE",
  ...(Object.keys(SEMANTIC_FRONTIER_V2_FLAG_REGISTRY) as Array<keyof typeof SEMANTIC_FRONTIER_V2_FLAG_REGISTRY>),
] as const;

/**
 * Emit one attestation and return it. `setTraceEnabledForTest(true)` also
 * clears the per-path "already attested" set, so calling this twice in a row
 * genuinely re-runs the payload builder instead of hitting the dedupe.
 */
function emitAttestation(workspaceRoot: string): Record<string, any> {
  setTraceEnabledForTest(true);
  traceCausalAttestation(workspaceRoot);
  const lines = fs.readFileSync(getTracePath(workspaceRoot), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));
  // LAST, not first: repeated emissions append to the same file, and each
  // caller below wants the record its own env produced.
  const attestations = lines.filter((record) => record.event === "p1_causal_attestation");
  expect(attestations.length, `no attestation in ${JSON.stringify(lines)}`).toBeGreaterThan(0);
  return attestations[attestations.length - 1];
}

beforeEach(() => {
  origHome = process.env.HOME;
  origCausalEnv = {};
  for (const key of CAUSAL_ENV_KEYS) {
    origCausalEnv[key] = process.env[key];
    delete process.env[key];
  }
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tl-trace-test-"));
  process.env.HOME = tmpHome;
  // Start each test with tracing disabled so we don't leave the module in a
  // dirty state for the next test.
  setTraceEnabledForTest(false);
});

afterEach(() => {
  if (origHome !== undefined) {
    process.env.HOME = origHome;
  } else {
    delete process.env.HOME;
  }
  for (const key of CAUSAL_ENV_KEYS) {
    if (origCausalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = origCausalEnv[key];
  }
  setTraceEnabledForTest(false);
  // Clean up temp home
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const WS_ROOT = "/workspace/my-project";

// ---------------------------------------------------------------------------
// getTracePath
// ---------------------------------------------------------------------------

describe("getTracePath", () => {
  it("returns a .jsonl path under HOME/.tokenlighten/trace/", () => {
    const p = getTracePath(WS_ROOT);
    expect(p).toContain(path.join(tmpHome, ".tokenlighten", "trace"));
    expect(p).toMatch(/\.jsonl$/);
  });

  it("encodes the pid in the filename", () => {
    const p = getTracePath(WS_ROOT);
    expect(path.basename(p)).toContain(String(process.pid));
  });

  it("uses sha8 of workspaceRoot — different roots yield different paths", () => {
    const p1 = getTracePath("/workspace/a");
    const p2 = getTracePath("/workspace/b");
    expect(p1).not.toBe(p2);
  });

  it("is stable across repeated calls for the same root", () => {
    expect(getTracePath(WS_ROOT)).toBe(getTracePath(WS_ROOT));
  });

  it("returns the expected path regardless of enabled state", () => {
    setTraceEnabledForTest(false);
    const disabled = getTracePath(WS_ROOT);
    setTraceEnabledForTest(true);
    const enabled = getTracePath(WS_ROOT);
    expect(disabled).toBe(enabled);
  });
});

// ---------------------------------------------------------------------------
// trace() — disabled state
// ---------------------------------------------------------------------------

describe("trace() when disabled", () => {
  it("does not create any files", () => {
    setTraceEnabledForTest(false);
    trace("test.event", { foo: "bar" }, WS_ROOT);

    const traceDir = path.join(tmpHome, ".tokenlighten", "trace");
    expect(fs.existsSync(traceDir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// trace() — enabled state
// ---------------------------------------------------------------------------

describe("trace() when enabled", () => {
  beforeEach(() => {
    setTraceEnabledForTest(true);
  });

  it("creates the trace directory lazily", () => {
    trace("init", {}, WS_ROOT);
    const traceDir = path.join(tmpHome, ".tokenlighten", "trace");
    expect(fs.existsSync(traceDir)).toBe(true);
  });

  it("appends a parseable JSONL line", () => {
    trace("read_code", { mode: "pack" }, WS_ROOT);

    const p = getTracePath(WS_ROOT);
    const raw = fs.readFileSync(p, "utf8").trim();
    const parsed = JSON.parse(raw);

    expect(parsed.event).toBe("read_code");
    expect(parsed.mode).toBe("pack");
    expect(typeof parsed.ts).toBe("number");
  });

  it("includes all payload keys at the top level", () => {
    trace("edit_code", { handle: "h1", lines: 42 }, WS_ROOT);

    const p = getTracePath(WS_ROOT);
    const raw = fs.readFileSync(p, "utf8").trim();
    const parsed = JSON.parse(raw);

    expect(parsed.handle).toBe("h1");
    expect(parsed.lines).toBe(42);
  });

  it("repeated calls append without truncating", () => {
    trace("event_a", { n: 1 }, WS_ROOT);
    trace("event_b", { n: 2 }, WS_ROOT);
    trace("event_c", { n: 3 }, WS_ROOT);

    const p = getTracePath(WS_ROOT);
    const lines = fs.readFileSync(p, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);

    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0].event).toBe("event_a");
    expect(parsed[1].event).toBe("event_b");
    expect(parsed[2].event).toBe("event_c");
  });

  it("ts counter is monotonically increasing across calls", () => {
    trace("first", {}, WS_ROOT);
    trace("second", {}, WS_ROOT);

    const p = getTracePath(WS_ROOT);
    const lines = fs.readFileSync(p, "utf8").trim().split("\n");
    const [a, b] = lines.map((l) => JSON.parse(l));

    expect(b.ts).toBeGreaterThan(a.ts);
  });

  it("separate workspaceRoot values go to separate files", () => {
    const rootA = "/workspace/proj-a";
    const rootB = "/workspace/proj-b";

    trace("e", { x: 1 }, rootA);
    trace("e", { x: 2 }, rootB);

    const pA = getTracePath(rootA);
    const pB = getTracePath(rootB);
    expect(pA).not.toBe(pB);
    expect(fs.existsSync(pA)).toBe(true);
    expect(fs.existsSync(pB)).toBe(true);
  });

  it("emits causal launch identity without requiring an ordinary trace event", () => {
    process.env["TL_MCP_CONFIG_SHA256"] = "f".repeat(64);
    process.env["TL_P1_CAUSAL_RUN_NONCE"] = "n10-v07-natural-unit";

    traceCausalAttestation(WS_ROOT);

    const parsed = fs.readFileSync(getTracePath(WS_ROOT), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      event: "p1_causal_attestation",
      source: "tokenlighten-mcp-server",
      config_sha256: "f".repeat(64),
      workspace_root: WS_ROOT,
      trace_file: path.basename(getTracePath(WS_ROOT)),
      run_nonce: "n10-v07-natural-unit",
    });
  });

  // -------------------------------------------------------------------------
  // computed_config_sha256 — the server's OWN digest of its resolved config.
  //
  // `config_sha256` is a verbatim echo of an injected env var: whoever sets
  // TL_MCP_CONFIG_SHA256 is the attester, so it proves nothing on its own.
  // `computed_config_sha256` is the server's independent statement about what
  // it actually resolved, and the analyzer can compare the two.
  // -------------------------------------------------------------------------
  it("carries a computed config digest that is NOT the injected value", () => {
    const bogus = "b".repeat(64);
    process.env["TL_MCP_CONFIG_SHA256"] = bogus;
    process.env["TL_P1_CAUSAL_RUN_NONCE"] = "n10-v07-computed-noecho";

    const attestation = emitAttestation(WS_ROOT);

    expect(attestation["config_sha256"]).toBe(bogus);
    expect(attestation["computed_config_sha256"]).toMatch(/^[0-9a-f]{64}$/);
    // The whole point: an injected digest cannot forge the computed one.
    expect(attestation["computed_config_sha256"]).not.toBe(bogus);
  });

  it("computes the same digest twice under identical configuration", () => {
    process.env["TL_MCP_CONFIG_SHA256"] = "c".repeat(64);
    process.env["TL_P1_CAUSAL_RUN_NONCE"] = "n10-v07-computed-stable";

    const first = emitAttestation(WS_ROOT);
    const second = emitAttestation(WS_ROOT);

    expect(first["computed_config_sha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(second["computed_config_sha256"]).toBe(first["computed_config_sha256"]);
  });

  it("changes the digest when any effective TL flag changes", () => {
    process.env["TL_MCP_CONFIG_SHA256"] = "d".repeat(64);
    process.env["TL_P1_CAUSAL_RUN_NONCE"] = "n10-v07-computed-flagshift";

    const baseline = emitAttestation(WS_ROOT)["computed_config_sha256"];

    // v0.14 flag inventory (2026-08-31): resolvedFlagValues() now covers
    // exactly TL_GRAPH_INDEX and TL_TRACE (util/trace.ts), so those are the
    // two flags left that can move this digest. The arm-defining flag.
    process.env["TL_TRACE"] = "1";
    const withTrace = emitAttestation(WS_ROOT)["computed_config_sha256"];
    expect(withTrace).not.toBe(baseline);

    // A flag with nothing to do with TL_TRACE: the digest covers the WHOLE
    // resolved flag set, not just one entry.
    delete process.env["TL_TRACE"];
    process.env["TL_GRAPH_INDEX"] = "on";
    const withUnrelated = emitAttestation(WS_ROOT)["computed_config_sha256"];
    expect(withUnrelated).not.toBe(baseline);
    expect(withUnrelated).not.toBe(withTrace);

    // Equivalent spellings resolve to the same effective value, so the digest
    // is over RESOLVED config, not over raw env strings.
    process.env["TL_GRAPH_INDEX"] = "TRUE";
    expect(emitAttestation(WS_ROOT)["computed_config_sha256"]).toBe(withUnrelated);
  });

  // -------------------------------------------------------------------------
  // FX-R3 D5 (2026-09-04) — THE PAID A/B ARMS MUST BE DISTINGUISHABLE.
  //
  // `resolvedFlagValues()` listed only TL_GRAPH_INDEX /
  // TL_SEMANTIC_FRONTIER_GUARD / TL_TRACE, so a v2 TREATMENT server (the ten
  // Semantic Frontier v2 flags plus TL_GRAPH_EVIDENCE, all on) and a CONTROL
  // server (all off) computed the SAME `computed_config_sha256` — measured by
  // the deterministic-bench agent under arm-set v2, and exactly the claim the
  // causal attestation exists to make.
  // -------------------------------------------------------------------------
  const V2_TREATMENT_KEYS = [
    "TL_GRAPH_EVIDENCE",
    ...(Object.keys(SEMANTIC_FRONTIER_V2_FLAG_REGISTRY) as string[]),
  ];

  function clearV2Flags(): void {
    for (const key of V2_TREATMENT_KEYS) delete process.env[key];
  }

  it("FX-R3 D5: the v2 treatment env and the all-off control env compute DIFFERENT digests", () => {
    process.env["TL_MCP_CONFIG_SHA256"] = "a".repeat(64);
    process.env["TL_P1_CAUSAL_RUN_NONCE"] = "fxr3-d5-arms";

    clearV2Flags();
    const control = emitAttestation(WS_ROOT)["computed_config_sha256"];
    // The all-off digest is stable call to call.
    expect(emitAttestation(WS_ROOT)["computed_config_sha256"]).toBe(control);

    for (const key of V2_TREATMENT_KEYS) process.env[key] = "1";
    const treatment = emitAttestation(WS_ROOT)["computed_config_sha256"];

    expect(treatment).toMatch(/^[0-9a-f]{64}$/);
    // PRE-FIX these were EQUAL: none of the eleven flags entered the digest.
    expect(treatment).not.toBe(control);
  });

  it("FX-R3 D5: EVERY v0.15 registry flag (and TL_GRAPH_EVIDENCE) moves the digest on its own", () => {
    process.env["TL_MCP_CONFIG_SHA256"] = "a".repeat(64);
    process.env["TL_P1_CAUSAL_RUN_NONCE"] = "fxr3-d5-each";

    for (const key of V2_TREATMENT_KEYS) {
      clearV2Flags();
      const baseline = emitAttestation(WS_ROOT)["computed_config_sha256"];
      // TL_SF_VERIFY_FIRST's accessor degrades to `false` without
      // TL_SF_STATEFUL (flags.ts documents that as the EFFECTIVE value the
      // trace must report), so its own effect is asserted with its dependency
      // met — the digest is over effective configuration, not raw env.
      if (key === "TL_SF_VERIFY_FIRST") process.env["TL_SF_STATEFUL"] = "1";
      const withDependency = emitAttestation(WS_ROOT)["computed_config_sha256"];
      process.env[key] = "1";
      const moved = emitAttestation(WS_ROOT)["computed_config_sha256"];
      expect(moved, `${key} must move the config digest`).not.toBe(
        key === "TL_SF_VERIFY_FIRST" ? withDependency : baseline,
      );
    }
    clearV2Flags();
  });

  it("excludes the per-run nonce and the injected digest from its input", () => {
    process.env["TL_MCP_CONFIG_SHA256"] = "e".repeat(64);
    process.env["TL_P1_CAUSAL_RUN_NONCE"] = "n10-v07-nonce-one";
    const first = emitAttestation(WS_ROOT);

    // Same configuration, different run: the digest must not drift run to run.
    process.env["TL_P1_CAUSAL_RUN_NONCE"] = "n10-v07-nonce-two-different";
    const second = emitAttestation(WS_ROOT);
    expect(second["run_nonce"]).not.toBe(first["run_nonce"]);
    expect(second["computed_config_sha256"]).toBe(first["computed_config_sha256"]);

    // And a different injected digest must not move it either (no self-reference).
    process.env["TL_MCP_CONFIG_SHA256"] = "1".repeat(64);
    const third = emitAttestation(WS_ROOT);
    expect(third["config_sha256"]).not.toBe(first["config_sha256"]);
    expect(third["computed_config_sha256"]).toBe(first["computed_config_sha256"]);
  });

  // -------------------------------------------------------------------------
  // Workspace canonicalization. record_run.mjs joins a trace to a cell by
  // hashing the solver's workspace root, so the server and the harness must
  // agree on ONE spelling. On macOS a bench worktree under /var resolves to
  // /private/var, which is exactly the asymmetry that would silently drop
  // every attestation.
  // -------------------------------------------------------------------------
  it("uses the realpath-canonical workspace for BOTH the filename and the payload", () => {
    const real = fs.mkdtempSync(path.join(tmpHome, "real-ws-"));
    const link = path.join(tmpHome, "linked-ws");
    fs.symlinkSync(real, link);
    const canonical = fs.realpathSync(real);
    expect(link).not.toBe(canonical);

    process.env["TL_MCP_CONFIG_SHA256"] = "9".repeat(64);
    process.env["TL_P1_CAUSAL_RUN_NONCE"] = "n10-v07-canonical";

    // Addressed through the symlink AND with a trailing separator — neither
    // spelling may produce a different identity.
    const attestation = emitAttestation(link + path.sep);

    expect(attestation["workspace_root"]).toBe(canonical);
    expect(getTracePath(link + path.sep)).toBe(getTracePath(canonical));
    expect(attestation["trace_file"]).toBe(path.basename(getTracePath(canonical)));
    // The record really is discoverable at the canonical file.
    expect(fs.existsSync(getTracePath(canonical))).toBe(true);
  });

  it("falls back to the resolved raw path when realpath fails", () => {
    const missing = path.join(tmpHome, "does-not-exist", "ws");
    process.env["TL_MCP_CONFIG_SHA256"] = "8".repeat(64);
    process.env["TL_P1_CAUSAL_RUN_NONCE"] = "n10-v07-canonical-missing";

    const attestation = emitAttestation(missing);

    expect(attestation["workspace_root"]).toBe(path.resolve(missing));
    expect(attestation["trace_file"]).toBe(path.basename(getTracePath(missing)));
  });

  it("prepends one server-observed P1 causal attestation per trace path", () => {
    process.env["TL_MCP_CONFIG_SHA256"] = "a".repeat(64);
    process.env["TL_P1_CAUSAL_RUN_NONCE"] = "n10-v07-natural-normalize";

    trace("event_a", { n: 1 }, WS_ROOT);
    trace("event_b", { n: 2 }, WS_ROOT);

    const lines = fs.readFileSync(getTracePath(WS_ROOT), "utf8").trim().split("\n");
    const parsed = lines.map((line) => JSON.parse(line));
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toMatchObject({
      event: "p1_causal_attestation",
      source: "tokenlighten-mcp-server",
      config_sha256: "a".repeat(64),
      workspace_root: WS_ROOT,
      trace_file: path.basename(getTracePath(WS_ROOT)),
      run_nonce: "n10-v07-natural-normalize",
      // v0.14 flag inventory (2026-08-31): the P1 evidence-completion lever
      // and its two siblings were deleted with their experiment, so a live
      // server has no ablation flags left to attest — effective_flags is now
      // ALWAYS an empty object (util/trace.ts's p1CausalAttestationPayload).
      effective_flags: {},
    });
    expect(parsed.map((record) => record.event)).toEqual([
      "p1_causal_attestation",
      "event_a",
      "event_b",
    ]);
    expect(parsed[0].ts).toBeLessThan(parsed[1].ts);
  });

  it.each([undefined, "ABC", "A".repeat(64), "a".repeat(63)])(
    "does not emit a valid attestation for missing or malformed config SHA %s",
    (configSha) => {
      if (configSha === undefined) delete process.env["TL_MCP_CONFIG_SHA256"];
      else process.env["TL_MCP_CONFIG_SHA256"] = configSha;
      process.env["TL_P1_CAUSAL_RUN_NONCE"] = "n10-v07-natural-invalid-sha";

      trace("ordinary", {}, WS_ROOT);

      const parsed = fs.readFileSync(getTracePath(WS_ROOT), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(parsed).toHaveLength(1);
      expect(parsed[0].event).toBe("ordinary");
    },
  );

  it.each([undefined, "bad/nonce", "", "x".repeat(201)])(
    "does not emit a valid attestation for missing or malformed run nonce %s",
    (runNonce) => {
      process.env["TL_MCP_CONFIG_SHA256"] = "a".repeat(64);
      if (runNonce === undefined) delete process.env["TL_P1_CAUSAL_RUN_NONCE"];
      else process.env["TL_P1_CAUSAL_RUN_NONCE"] = runNonce;

      trace("ordinary", {}, WS_ROOT);

      const parsed = fs.readFileSync(getTracePath(WS_ROOT), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(parsed).toHaveLength(1);
      expect(parsed[0].event).toBe("ordinary");
    },
  );
});

// ---------------------------------------------------------------------------
// TL_TRACE — the real env var, not the setTraceEnabledForTest() override.
//
// Rescued from evidenceShadow.spec.ts (deleted in the v0.14 flag-inventory
// surgery — these two pinned util/trace.ts's OWN TL_TRACE handling, nothing
// evidence-shadow-specific).
// ---------------------------------------------------------------------------

describe("TL_TRACE — real env-var reads", () => {
  it("is read at CALL time, not at module load", () => {
    // trace.ts once cached process.env.TL_TRACE in a module-level binding,
    // which contradicts flags.ts's documented "reads process.env at call
    // time so tests can manipulate env per-test" contract and made the
    // channel untestable without setTraceEnabledForTest.
    setTraceEnabledForTest(undefined); // clear the outer beforeEach's override
    try {
      delete process.env["TL_TRACE"];
      trace("unit_probe", { a: 1 }, WS_ROOT);
      const traceDir = path.join(tmpHome, ".tokenlighten", "trace");
      expect(fs.existsSync(traceDir), "wrote while TL_TRACE was unset").toBe(false);

      process.env["TL_TRACE"] = "1";
      trace("unit_probe", { a: 2 }, WS_ROOT);
      expect(fs.existsSync(getTracePath(WS_ROOT)), "did not write after TL_TRACE was set").toBe(true);
    } finally {
      delete process.env["TL_TRACE"];
      setTraceEnabledForTest(false);
    }
  });

  it("agrees with flags.ts's traceEnabled() on every TL_TRACE spelling (one predicate, not two)", () => {
    setTraceEnabledForTest(undefined); // clear the outer beforeEach's override
    try {
      for (const value of ["1", "true", "on", "yes", "0", "false", "off", ""]) {
        process.env["TL_TRACE"] = value;
        expect(isTraceEnabled(), `disagreement on TL_TRACE=${JSON.stringify(value)}`)
          .toBe(traceEnabled());
      }
    } finally {
      delete process.env["TL_TRACE"];
      setTraceEnabledForTest(false);
    }
  });
});

// ---------------------------------------------------------------------------
// computedConfigSha256 (exported) — P1 causal window launch wiring (2026-08-06).
// Exported so a CLI (bin.ts --print-config-digest) and the bench runner
// (run_oneshot_ab.mjs computeP1ConfigDigests) can ask the server what
// it would compute for a given env WITHOUT going through the trace file /
// attestation machinery at all.
// ---------------------------------------------------------------------------

describe("computedConfigSha256 (exported)", () => {
  it("is deterministic under identical env, called directly with no trace file involved", () => {
    const first = computedConfigSha256();
    const second = computedConfigSha256();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
  });

  it("changes when TL_TRACE toggles 1 <-> 0", () => {
    process.env["TL_TRACE"] = "0";
    const off = computedConfigSha256();
    process.env["TL_TRACE"] = "1";
    const on = computedConfigSha256();
    expect(on).toMatch(/^[0-9a-f]{64}$/);
    expect(off).toMatch(/^[0-9a-f]{64}$/);
    expect(on).not.toBe(off);
  });

  it("changes when the semantic-frontier guard rolls back", () => {
    process.env["TL_SEMANTIC_FRONTIER_GUARD"] = "0";
    const off = computedConfigSha256();
    process.env["TL_SEMANTIC_FRONTIER_GUARD"] = "1";
    const on = computedConfigSha256();
    expect(on).toMatch(/^[0-9a-f]{64}$/);
    expect(off).toMatch(/^[0-9a-f]{64}$/);
    expect(on).not.toBe(off);
  });

  it("agrees with p1_causal_attestation.computed_config_sha256 for the SAME process env (parity)", () => {
    process.env["TL_MCP_CONFIG_SHA256"] = "7".repeat(64);
    process.env["TL_P1_CAUSAL_RUN_NONCE"] = "n-parity-export-vs-attestation";

    const direct = computedConfigSha256();
    const attestation = emitAttestation(WS_ROOT);

    expect(attestation["computed_config_sha256"]).toBe(direct);
  });
});
