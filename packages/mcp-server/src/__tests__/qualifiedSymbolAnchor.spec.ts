/**
 * D5 regression (2026-09-02): a query that anchors on `Class::method` must
 * resolve the anchor as a UNIT.
 *
 * Live forensics (SF13, semantic-frontier paid smoke-v2): the first task_pack
 * for `EKF::isHealthy` served three sibling headers that merely DECLARE a bare
 * `isHealthy()` and never the file that defines `EKF::isHealthy` — the
 * qualifier was discarded before any resolver saw it, so the definition lost a
 * same-role `path.localeCompare` tie and was shed by the seed cap in silence.
 *
 * The workspace below is synthetic and generic: a declaring header, its
 * out-of-line definition, two same-shaped sibling classes that also declare
 * `isHealthy()`, one unrelated class, and a consumer. Nothing in the product
 * path may key on these names.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getTracePath, setTraceEnabledForTest } from "../util/trace.js";

const roots: string[] = [];

function write(root: string, rel: string, text: string): void {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, "utf8");
}

/**
 * A workspace shaped like the live one: four estimator classes that each
 * declare a same-named `isHealthy()` member, each split header/implementation,
 * plus consumers and a test that mention the bare member too. More files
 * mention `isHealthy` than a pack may seed, so the cap and the tie-break both
 * have to be right for the ANCHORED class to survive.
 */
function estimatorWorkspace(tag: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), `.tl-qualified-anchor-${tag}-`)));
  roots.push(root);
  const sibling = (className: string, stem: string, flag: string): void => {
    write(root, `include/estimator/${stem}.hpp`, [
      "#pragma once",
      "namespace est {",
      `class ${className} {`,
      " public:",
      "  void update(float dt);",
      "  bool isHealthy() const;",
      " private:",
      `  bool ${flag} = false;`,
      "  int  count_ = 0;",
      "};",
      "}  // namespace est",
      "",
    ].join("\n"));
    write(root, `src/estimator/${stem}.cpp`, [
      `#include "estimator/${stem}.hpp"`,
      "namespace est {",
      `void ${className}::update(float dt) {`,
      "  count_ += 1;",
      `  ${flag} = dt > 0.0f;`,
      "}",
      `bool ${className}::isHealthy() const { return ${flag} && count_ > 5; }`,
      "}  // namespace est",
      "",
    ].join("\n"));
  };
  write(root, "include/estimator/ekf.hpp", [
    "#pragma once",
    "namespace est {",
    "class EKF {",
    " public:",
    "  void update(float dt);",
    "  bool isHealthy() const;",
    " private:",
    "  bool converged_ = false;",
    "  int  steps_ = 0;",
    "};",
    "}  // namespace est",
    "",
  ].join("\n"));
  write(root, "src/estimator/ekf.cpp", [
    "#include \"estimator/ekf.hpp\"",
    "namespace est {",
    "void EKF::update(float dt) {",
    "  steps_ += 1;",
    "  converged_ = dt > 0.0f && steps_ > 3;",
    "}",
    "bool EKF::isHealthy() const {",
    "  return converged_ && steps_ > 3;",
    "}",
    "}  // namespace est",
    "",
  ].join("\n"));
  sibling("AltitudeEstimator", "altitude_estimator", "baro_valid_");
  sibling("AttitudeEstimator", "attitude_estimator", "imu_valid_");
  // Same family, same naming, but NO member the query anchored on.
  write(root, "include/estimator/position_estimator.hpp", [
    "#pragma once",
    "namespace est {",
    "class PositionEstimator {",
    " public:",
    "  void reset();",
    "};",
    "}  // namespace est",
    "",
  ].join("\n"));
  write(root, "src/estimator/position_estimator.cpp", [
    "#include \"estimator/position_estimator.hpp\"",
    "namespace est {",
    "void PositionEstimator::reset() {}",
    "}  // namespace est",
    "",
  ].join("\n"));
  write(root, "src/app/tasks_init.cpp", [
    "#include \"estimator/altitude_estimator.hpp\"",
    "#include \"estimator/attitude_estimator.hpp\"",
    "namespace app {",
    "est::AltitudeEstimator g_altitude_est;",
    "est::AttitudeEstimator g_attitude_est;",
    "void taskEstimatorStep(float dt) {",
    "  g_altitude_est.update(dt);",
    "  g_attitude_est.update(dt);",
    "  bool imu_ok  = g_attitude_est.isHealthy();",
    "  bool baro_ok = g_altitude_est.isHealthy();",
    "  (void)imu_ok; (void)baro_ok;",
    "}",
    "}  // namespace app",
    "",
  ].join("\n"));
  write(root, "src/telemetry/telemetry_pack.cpp", [
    "#include \"estimator/altitude_estimator.hpp\"",
    "#include \"estimator/attitude_estimator.hpp\"",
    "namespace telemetry {",
    "int packHealthBits(const est::AltitudeEstimator& alt, const est::AttitudeEstimator& att) {",
    "  int status = 0;",
    "  if (alt.isHealthy()) status |= 1;",
    "  if (att.isHealthy()) status |= 2;",
    "  return status;",
    "}",
    "}  // namespace telemetry",
    "",
  ].join("\n"));
  write(root, "test/test_ekf.cpp", [
    "#include \"estimator/ekf.hpp\"",
    "// 5. isHealthy() returns true after normal operation",
    "int main() {",
    "  est::EKF ekf;",
    "  ekf.update(0.1f);",
    "  return ekf.isHealthy() ? 0 : 1;",
    "}",
    "",
  ].join("\n"));
  return root;
}

async function readTaskPack(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { callTool } = await import("../server.js") as unknown as {
    callTool: (name: string, args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  };
  const response = await callTool("read_file", args);
  return JSON.parse(response.content[0]!.text) as Record<string, unknown>;
}

function stringsIn(value: unknown): string[] {
  const out: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === "string") out.push(node);
    else if (Array.isArray(node)) for (const item of node) visit(item);
    else if (node !== null && typeof node === "object") for (const item of Object.values(node)) visit(item);
  };
  visit(value);
  return out;
}

function pathsOf(entries: unknown): string[] {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => (entry as Record<string, unknown> | null)?.["path"])
    .filter((value): value is string => typeof value === "string");
}

/**
 * The live SF13 request shape, with the anchor corrected to a member that
 * actually exists. Reverting the product change turns this exact call back into
 * the observed failure: decision `discover`, evidence = three sibling headers
 * plus a sibling IMPLEMENTATION, and `src/estimator/ekf.cpp` nowhere on the
 * wire.
 */
const ANCHORED_QUERY =
  "まず EKF::isHealthy という明示 symbol と telemetry relation を確認し、"
  + "推測でなく実際の接続を根拠に対応して。"
  + "EKF::isHealthy と telemetry の wiring/reference を追い、outbound status までの"
  + " continuation を確認して health bit の不具合を直してほしい。";

/** The same anchor in English prose: the mechanism is the `::` shape, not a language. */
const ANCHORED_QUERY_EN =
  "Follow the wiring and references from EKF::isHealthy into telemetry and fix the"
  + " outbound health status bit, using the real connection rather than a guess.";

afterEach(() => {
  setTraceEnabledForTest(false);
  delete process.env["TL_SEMANTIC_FRONTIER_GUARD"];
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("qualified Class::method anchors", () => {
  it("serves the file that defines the anchored member, not just same-named sibling declarations", async () => {
    const root = estimatorWorkspace("serves-definition");
    const wire = await readTaskPack({
      query: ANCHORED_QUERY,
      task: { epoch: "new", profile: "generic" },
      cwd: root,
    });
    expect(wire["kind"]).toBe("read.task_pack");
    const addressed = [
      ...pathsOf(wire["evidence"]),
      ...pathsOf(wire["inventory"]),
      ...pathsOf(wire["frontier_index"]),
    ];
    expect(addressed, JSON.stringify(addressed)).toContain("src/estimator/ekf.cpp");
  });

  it("resolves the same anchor from English prose", async () => {
    const root = estimatorWorkspace("serves-definition-en");
    const wire = await readTaskPack({
      query: ANCHORED_QUERY_EN,
      task: { epoch: "new", profile: "generic" },
      cwd: root,
    });
    const addressed = [
      ...pathsOf(wire["evidence"]),
      ...pathsOf(wire["inventory"]),
      ...pathsOf(wire["frontier_index"]),
    ];
    expect(addressed, JSON.stringify(addressed)).toContain("src/estimator/ekf.cpp");
  });

  it("binds the wiring source to the anchored definition rather than an alphabetical sibling", async () => {
    const root = estimatorWorkspace("wiring-source");
    const wire = await readTaskPack({
      query: ANCHORED_QUERY,
      task: { epoch: "new", profile: "generic" },
      cwd: root,
    });
    const wiring = ((wire["plan"] as Record<string, unknown> | undefined)?.["wiring"]
      ?? wire["wiring"]) as Record<string, unknown> | undefined;
    expect(wiring, JSON.stringify(wire["plan"])).toBeDefined();
    const connection = (wiring?.["connections"] as Array<Record<string, unknown>> | undefined)?.[0];
    const source = connection?.["source"] as Record<string, unknown> | undefined;
    expect(source?.["path"], JSON.stringify(wiring)).toBe("src/estimator/ekf.cpp");
  });

  it("never leaves the anchored definition silently unserved", async () => {
    const root = estimatorWorkspace("disclosure");
    const wire = await readTaskPack({
      query: ANCHORED_QUERY,
      task: { epoch: "new", profile: "generic" },
      cwd: root,
    });
    const addressed = [
      ...pathsOf(wire["evidence"]),
      ...pathsOf(wire["inventory"]),
      ...pathsOf(wire["frontier_index"]),
    ];
    const disclosed = stringsIn(wire["missing"]).some((item) => item.includes("src/estimator/ekf.cpp"));
    expect(addressed.includes("src/estimator/ekf.cpp") || disclosed).toBe(true);
  });

  it("does not promote an unrelated class whose qualifier the query never named", async () => {
    const root = estimatorWorkspace("qualifier-gate");
    const wire = await readTaskPack({
      query: ANCHORED_QUERY,
      task: { epoch: "new", profile: "generic" },
      cwd: root,
    });
    const addressed = new Set([
      ...pathsOf(wire["evidence"]),
      ...pathsOf(wire["inventory"]),
      ...pathsOf(wire["frontier_index"]),
    ]);
    // position_estimator declares no `isHealthy` at all: the flat-token path
    // used to bind it purely on a constructor basename match.
    expect(addressed.has("include/estimator/position_estimator.hpp")).toBe(false);
  });

  it("keeps the semantic-frontier attestation guard-gated for the anchored pack", async () => {
    const attestationFor = async (guard: "0" | "1"): Promise<Record<string, unknown>> => {
      const root = estimatorWorkspace(`guard-${guard}`);
      const tracePath = getTracePath(root);
      process.env["TL_SEMANTIC_FRONTIER_GUARD"] = guard;
      setTraceEnabledForTest(true);
      await readTaskPack({
        query: ANCHORED_QUERY,
        task: { epoch: "new", profile: "generic" },
        cwd: root,
      });
      const records = fs.readFileSync(tracePath, "utf8").trim().split("\n").filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      setTraceEnabledForTest(false);
      return records.find((record) => record["event"] === "semantic_frontier_attestation")!;
    };
    const enabled = await attestationFor("1");
    const disabled = await attestationFor("0");
    expect(enabled["guard_enabled"]).toBe(true);
    expect(disabled["guard_enabled"]).toBe(false);
    // `committed` is guard-gated by construction: it can never be true while
    // the guard is off, whatever the pack decided to serve.
    expect(disabled["committed"]).toBe(false);
    // It is deliberately NOT asserted true for guard=1 here. The frontier
    // guard commits only when a pack carries an UNBOUND, purely-lexical
    // candidate for it to demote; once the qualified anchor resolves, every
    // candidate this pack serves is bound and required, so there is nothing to
    // demote and `committed` is honestly false. Making it true would mean
    // planting an unbound decoy in the fixture — fixture-specific logic, not a
    // property of anchor resolution.
    expect(enabled["attempted"]).toBe(true);
    expect(enabled["eligible"]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SF-5 residuals (round 11): `qualifiedAnchorSiteKind` (readCodeTaskPack.ts)
// runs on the output of `maskCommentsAndStrings` (sfCodeMask.ts) — a masking
// bug is a D5 CORRECTNESS bug, on the DEFAULT (unflagged) wire path. This
// pins three decoy shapes end to end, through the real `read_file` handler:
// a commented-out fake definition, a quoted (string-literal) fake
// definition, and a regex literal on the SAME LINE as the real definition
// (a masking bug in the OTHER direction — over-masking a real definition —
// which is strictly worse, since it can make the anchor fail to resolve at
// all). `maskCommentsAndStrings`'s unit-level coverage for these shapes (plus
// nested block comments and Rust raw strings) lives in `sfCodeMask.spec.ts`;
// this file only pins that the DEFAULT wire's end-to-end behavior is correct
// for the shapes that were previously broken or previously untested here.
// ---------------------------------------------------------------------------

/** A minimal single-class EKF workspace with a caller-supplied ekf.cpp body, for planting SF-5 decoys around the real definition. */
function decoyEstimatorWorkspace(tag: string, ekfCppLines: readonly string[]): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), `.tl-qualified-anchor-decoy-${tag}-`)));
  roots.push(root);
  write(root, "include/estimator/ekf.hpp", [
    "#pragma once",
    "namespace est {",
    "class EKF {",
    " public:",
    "  void update(float dt);",
    "  bool isHealthy() const;",
    " private:",
    "  bool converged_ = false;",
    "  int  steps_ = 0;",
    "};",
    "}  // namespace est",
    "",
  ].join("\n"));
  write(root, "src/estimator/ekf.cpp", ekfCppLines.join("\n"));
  return root;
}

/** The real, unmasked definition body every decoy test below expects to still resolve. */
const REAL_EKF_CPP_LINES = [
  "#include \"estimator/ekf.hpp\"",
  "namespace est {",
  "void EKF::update(float dt) {",
  "  steps_ += 1;",
  "  converged_ = dt > 0.0f && steps_ > 3;",
  "}",
  "bool EKF::isHealthy() const {",
  "  return converged_ && steps_ > 3;",
  "}",
  "}  // namespace est",
  "",
];

function sourceOfFirstConnection(wire: Record<string, unknown>): unknown {
  const wiring = ((wire["plan"] as Record<string, unknown> | undefined)?.["wiring"]
    ?? wire["wiring"]) as Record<string, unknown> | undefined;
  const connection = (wiring?.["connections"] as Array<Record<string, unknown>> | undefined)?.[0];
  return (connection?.["source"] as Record<string, unknown> | undefined)?.["path"];
}

describe("qualified Class::method anchors — SF-5 masking decoys (default wire)", () => {
  it("does not mistake a commented-out Class::method definition in a DIFFERENT file for the real one", async () => {
    const root = decoyEstimatorWorkspace("comment-decoy", REAL_EKF_CPP_LINES);
    write(root, "src/estimator/decoy_comment.cpp", [
      "namespace est {",
      "// bool EKF::isHealthy() const { return true; }",
      "}  // namespace est",
      "",
    ].join("\n"));
    const wire = await readTaskPack({ query: ANCHORED_QUERY, task: { epoch: "new", profile: "generic" }, cwd: root });
    expect(sourceOfFirstConnection(wire), JSON.stringify(wire["plan"])).toBe("src/estimator/ekf.cpp");
    const addressed = [...pathsOf(wire["evidence"]), ...pathsOf(wire["inventory"]), ...pathsOf(wire["frontier_index"])];
    expect(addressed, JSON.stringify(addressed)).toContain("src/estimator/ekf.cpp");
  });

  it("does not mistake a quoted (string-literal) Class::method definition in a DIFFERENT file for the real one", async () => {
    const root = decoyEstimatorWorkspace("string-decoy", REAL_EKF_CPP_LINES);
    write(root, "src/estimator/decoy_string.cpp", [
      "namespace est {",
      "const char* kExample = \"bool EKF::isHealthy() const { return true; }\";",
      "}  // namespace est",
      "",
    ].join("\n"));
    const wire = await readTaskPack({ query: ANCHORED_QUERY, task: { epoch: "new", profile: "generic" }, cwd: root });
    expect(sourceOfFirstConnection(wire), JSON.stringify(wire["plan"])).toBe("src/estimator/ekf.cpp");
  });

  it("does not mistake a Rust nested-block-comment decoy in a DIFFERENT .rs file for the real definition (FX-F item 5: language wired at the default call site)", async () => {
    // Before this wire-up, `qualifiedAnchorSiteKind` never passed a
    // `language` hint at all, so EVERY extension (including .rs) got the
    // non-nesting default: a block comment closes at the FIRST `*/`. Here
    // that leaves "bool EKF::isHealthy() const { return true; } */" as
    // UNMASKED, live-looking code -- a false "definition" site. With the
    // extension-derived `language` now threaded through, a .rs file's outer
    // comment is tracked to genuine nesting depth and the WHOLE span,
    // decoy included, is masked.
    const root = decoyEstimatorWorkspace("rust-nested-comment-decoy", REAL_EKF_CPP_LINES);
    write(root, "src/estimator/decoy_nested.rs", [
      "// old attempt, kept for reference only:",
      "/* /* nested note */ bool EKF::isHealthy() const { return true; } */",
    ].join("\n"));
    const wire = await readTaskPack({ query: ANCHORED_QUERY, task: { epoch: "new", profile: "generic" }, cwd: root });
    expect(sourceOfFirstConnection(wire), JSON.stringify(wire["plan"])).toBe("src/estimator/ekf.cpp");
    const addressed = [...pathsOf(wire["evidence"]), ...pathsOf(wire["inventory"]), ...pathsOf(wire["frontier_index"])];
    expect(addressed, JSON.stringify(addressed)).toContain("src/estimator/ekf.cpp");
  });

  it("a regex-literal-shaped decoy on the SAME LINE as the real definition does not mask it away (F/SF-5 regex-literal fix)", async () => {
    // Before the fix, the embedded `//` inside `/[//]/` was misread as a
    // line comment START, blanking the rest of the line — including the
    // REAL `EKF::isHealthy` definition that follows it on the same line.
    const root = decoyEstimatorWorkspace("regex-decoy", [
      "#include \"estimator/ekf.hpp\"",
      "namespace est {",
      "void EKF::update(float dt) {",
      "  steps_ += 1;",
      "  converged_ = dt > 0.0f && steps_ > 3;",
      "}",
      "auto re = /[//]/; bool EKF::isHealthy() const { return converged_ && steps_ > 3; }",
      "}  // namespace est",
      "",
    ]);
    const wire = await readTaskPack({ query: ANCHORED_QUERY, task: { epoch: "new", profile: "generic" }, cwd: root });
    expect(sourceOfFirstConnection(wire), JSON.stringify(wire["plan"])).toBe("src/estimator/ekf.cpp");
    const addressed = [...pathsOf(wire["evidence"]), ...pathsOf(wire["inventory"]), ...pathsOf(wire["frontier_index"])];
    expect(addressed, JSON.stringify(addressed)).toContain("src/estimator/ekf.cpp");
  });
});
