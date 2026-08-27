/**
 * queryContinuity.spec.ts — the three P0 continuity defects of the
 * pre-release field-eval wave (2026-08-27).
 *
 *   D1 LOSSY CONTINUATION. Five `next`-hint builders embedded
 *      `query.slice(0, 60)` / `.slice(0, 80)`. A `next` is contractually
 *      EXECUTABLE, so the truncated string BECOMES the next task query and
 *      the original intent is unrecoverable. Pinned three ways: the property
 *      (`continuationQuery` never cuts a word), the five call sites (source
 *      fence), and a real pack whose emitted hint round-trips through
 *      `nextStringToCall` back to the whole query.
 *
 *   D2 REQUIREMENT MODEL SHRINKS WITH THE QUERY. `requiredSurfacesForTask`
 *      inferred per call, and the concern-token axis had no carry-forward at
 *      all, so a NARROWED same-epoch continuation certified
 *      `coverage:"complete"` against a shrunken universe. Pinned: the
 *      requirement is monotone within the epoch, and `clearTaskContract`
 *      (the `taskEpoch:"new"` boundary) restores fresh behavior.
 *
 *   D3 THE PRIMARY CERTIFICATE FORGETS PRIOR PACKS. The certified frontier
 *      was built strictly from the current call's result/obligations. Pinned:
 *      same-epoch served evidence reaches `action_frontier`, and omitting the
 *      workspace reproduces exactly the old frontier.
 *
 * Fixtures go in os.tmpdir() (F-A1-8: outside $HOME keeps this spec honest
 * about scope). Every test that spans two calls in ONE task shares a
 * workspace on purpose — that sharing IS the scenario.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildTaskExecutionContract,
  buildTaskPack,
  clearPackDedupeForWorkspace,
  continuationQuery,
  resetPackDedupeCache,
  type TaskPackResult,
} from "../features/task-pack/readCodeTaskPack.js";
import {
  applyCanonicalTaskDecision,
  canonicalTaskDecisionInvariantViolations,
  deriveCanonicalTaskDecision,
} from "../features/task-pack/canonicalDecision.js";
import {
  clearTaskContract,
  resetTaskContractStoreForTest,
} from "../features/task-pack/taskContractStore.js";
import {
  queryPriorPackObligations,
  recordPriorPackObligations,
  resetPriorPackStoreForTest,
} from "../features/task-pack/priorPackStore.js";
import { recordServedSurfaces, resetPackServeLogForTest } from "../util/packServeLog.js";
import { nextStringToCall } from "../util/continuation.js";
import {
  rememberTaskQuery,
  resolveTaskQueryRef,
  resetAll as resetAllSessions,
  taskQueryRef,
  tokenizeForEpoch,
} from "../state/session.js";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function sourceFile(token: string, lines = 6): string {
  const out: string[] = [`export function ${token}(input: number[]): number {`, "  let total = 0;"];
  for (let i = 0; i < lines; i += 1) {
    out.push(`  total = total + (input[${i}] ?? 0) * ${i + 1}; // ${token} step ${i}`);
  }
  out.push("  return total;", "}", "");
  return out.join("\n");
}

/** No ui/style file anywhere: the roles under test are provably unservable here. */
const FIXTURE_FILES: ReadonlyArray<readonly [string, string]> = [
  ["src/types/checksumContract.ts", "computeChecksumContract"],
  ["src/protocol/checksumRoutes.ts", "computeChecksumRoutes"],
  ["src/control/parserSign.ts", "computeParserSign"],
];

const workspaces: string[] = [];

function makeWorkspace(tag: string): string {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `tl-query-continuity-${tag}-`)));
  workspaces.push(ws);
  for (const [rel, token] of FIXTURE_FILES) {
    fs.mkdirSync(path.join(ws, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), sourceFile(token));
  }
  fs.writeFileSync(
    path.join(ws, "package.json"),
    JSON.stringify({ name: "query-continuity-fixture", version: "0.0.0", type: "module" }, null, 2),
  );
  return ws;
}

beforeEach(() => {
  resetTaskContractStoreForTest();
  resetPriorPackStoreForTest();
  resetPackServeLogForTest();
  resetPackDedupeCache();
  resetAllSessions();
});

afterEach(() => {
  for (const ws of workspaces.splice(0)) {
    try {
      fs.rmSync(ws, { recursive: true, force: true });
    } catch {
      // best effort; the OS reaps tmpdir
    }
  }
});

/**
 * A deliberately long, multi-surface request whose LAST clause is the one a
 * 60/80-char slice used to amputate.
 */
const BROAD_QUERY =
  "wire the checksumContract validator into the parserSign frontend badge, "
  + "add its regression tests, and update the documentation for schedulerMutex";

const NARROWED_QUERY = "checksumContract validator only";

/**
 * D1's own query: every identifier-shaped token resolves against the fixture,
 * so the pack lands on `missing-roles` (not `concerns-uncovered`, whose hint
 * carries a single token and no query at all). The long tail is deliberately
 * plain prose — a 60/80-char slice amputated it, and nothing else notices it.
 */
const ROLE_GAP_QUERY =
  "wire computeChecksumContract into computeParserSign and then refresh "
  + "the associated stylesheet plus the release documentation notes";

// ---------------------------------------------------------------------------
// D1 — lossless continuation
// ---------------------------------------------------------------------------

describe("D1 — a `next` hint carries the whole task query", () => {
  it("continuationQuery never cuts a word and never drops the tail", () => {
    const out = continuationQuery(BROAD_QUERY);
    // Every word survives, in order.
    expect(out.split(" ")).toEqual(BROAD_QUERY.split(/\s+/u));
    // The old failure mode, stated as the assertion it broke.
    expect(out.length).toBeGreaterThan(80);
    expect(out).toContain("schedulerMutex");
    expect(out.endsWith(BROAD_QUERY.split(/\s+/u).at(-1)!)).toBe(true);
  });

  it("normalizes only what the one-line `query=\"...\"` encoding cannot carry", () => {
    // Newlines would break the single-line `next`; `"` would break the
    // encoding, which `nextStringToCall` does not unescape.
    const messy = 'fix  the\n"checksumContract"\tvalidator\r\nand its tests ';
    expect(continuationQuery(messy)).toBe("fix the checksumContract validator and its tests");
  });

  it("no next-hint builder embeds a sliced query any more", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "packages/mcp-server/src/features/task-pack/readCodeTaskPack.ts"),
      "utf8",
    );
    // The exact shape of the defect: a `query="..."` / `query=<...>` template
    // interpolating a slice of the task query.
    expect(source).not.toMatch(/query=[^\n]*\$\{query\.slice\(/u);
    // And the replacement is actually in use at every one of the five sites.
    expect(source.match(/\$\{continuationQuery\(query\)\}/gu)?.length ?? 0).toBe(5);
  });

  it("a missing-roles pack emits an EXECUTABLE hint that replays the whole query", async () => {
    const ws = makeWorkspace("d1-missing-roles");
    const result = await buildTaskPack(
      { query: ROLE_GAP_QUERY, surfaceRoles: ["ui"] } as never,
      ws,
    );
    expect(result.coverage_reason).toBe("missing-roles");
    expect(result.next).toBeDefined();
    const parsed = nextStringToCall(result.next!);
    expect(parsed, `unparseable next: ${result.next}`).toBeDefined();
    const replayed = (parsed!.arguments as { query?: string }).query;
    expect(replayed).toBe(continuationQuery(ROLE_GAP_QUERY));
    // The intent-bearing tail is the whole point: a 60/80-char slice lost it.
    expect(replayed!.length).toBeGreaterThan(80);
    expect(replayed).toContain("release documentation notes");
    // Same task, not a different one: the replay's epoch still overlaps.
    expect(tokenizeForEpoch(replayed!).some((t) => tokenizeForEpoch(ROLE_GAP_QUERY).includes(t))).toBe(true);
  });

  it("a qref resolves server-side to the FULL query, so a qref replay is lossless too", () => {
    const ws = makeWorkspace("d1-qref");
    // The two halves server.ts uses: `evidenceShadowQref` is minted with
    // `taskQueryRef`, and the post-seam `rememberTaskQuery` mints the SAME ref.
    const shadow = taskQueryRef(ws, BROAD_QUERY);
    const issued = rememberTaskQuery(ws, BROAD_QUERY);
    expect(issued).toBe(shadow);
    expect(resolveTaskQueryRef(ws, issued)).toBe(BROAD_QUERY);
    // A ref minted for a TRUNCATED query is a different ref for a different
    // task — which is why a sliced query could never be recovered from one.
    expect(taskQueryRef(ws, BROAD_QUERY.slice(0, 80))).not.toBe(issued);
  });
});

// ---------------------------------------------------------------------------
// Synthetic contract inputs — the readinessSemantics.spec.ts pattern: the
// certificate branches need exact surface-flag combinations the full builder
// only produces on multi-package fixtures.
// ---------------------------------------------------------------------------

const IMPL_CODE = "export function applyOrder(order: string) {\n  return order.trim();\n}\n";

const SYNTHETIC_SURFACE = {
  role: "domain",
  handle: "h-impl",
  path: "src/control/parserSign.ts",
  range: "1-40",
  required: true,
  code: IMPL_CODE,
} as const;

function packResult(overrides: Record<string, unknown>): TaskPackResult {
  return {
    mode: "task_pack",
    coverage: "focused",
    coverage_reason: "single-site",
    surfaces: [],
    missing: [],
    route: { action: "edit_from_handles", max_additional_tl_calls: 0 },
    ...overrides,
  } as unknown as TaskPackResult;
}

// ---------------------------------------------------------------------------
// D2 — the requirement model is monotone within a task epoch
// ---------------------------------------------------------------------------

describe("D2 — a narrowed continuation cannot certify against a shrunken universe", () => {
  it("carries the earlier pack's required roles into the narrowed pack", async () => {
    const ws = makeWorkspace("d2-carry");
    const broad = await buildTaskPack(
      { query: BROAD_QUERY, surfaceRoles: ["ui", "style"] } as never,
      ws,
    );
    expect(broad.required_surfaces).toEqual(expect.arrayContaining(["ui", "style"]));

    const narrowed = await buildTaskPack({ query: NARROWED_QUERY } as never, ws);
    // The requirement survived the narrowing...
    expect(narrowed.required_surfaces).toEqual(expect.arrayContaining(["ui", "style"]));
    // ...so this pack cannot claim it covered everything.
    expect(narrowed.coverage).not.toBe("complete");
    const missingText = narrowed.missing.join("\n");
    expect(missingText).toMatch(/\bui\b/u);
    expect(missingText).toMatch(/\bstyle\b/u);
    // And the terminal act is not certifiable on it.
    expect(deriveCanonicalTaskDecision(narrowed)?.kind).not.toBe("act-answer");
    expect(deriveCanonicalTaskDecision(narrowed)?.kind).not.toBe("act-edit");
  });

  // The exit backstop only fires where the ordinary vocabulary was WIPED (the
  // wiring branch's `missing = []`), which no organic fixture reaches reliably.
  // Pin its contract directly instead: the disclosure it writes must demote a
  // certificate, and the call it names must replay the SOURCE query.
  it("an unserved-epoch-requirement disclosure demotes a certificate and replays the SOURCE query", () => {
    const certified = packResult({
      surfaces: [{ ...SYNTHETIC_SURFACE }],
    });
    certified.execution_contract = buildTaskExecutionContract(certified, "generic", NARROWED_QUERY);
    expect(certified.execution_contract.typestate.phase).toBe("prepared");
    expect(deriveCanonicalTaskDecision(certified)?.kind).toBe("act-edit");

    certified.missing = [
      `unserved-required-role:ui (required by an earlier pack in this task;`
      + ` re-request via read_file mode=task_pack query="${continuationQuery(BROAD_QUERY)}" surfaceRoles=["ui"])`,
    ];
    const decision = deriveCanonicalTaskDecision(certified);
    expect(decision?.kind).toBe("discover");
    expect(decision?.next_call).toEqual({
      tool: "read_file",
      arguments: {
        mode: "task_pack",
        query: continuationQuery(BROAD_QUERY),
        surfaceRoles: ["ui"],
      },
    });
    // The oracle sees the contradiction, so the shared exit actually repairs it.
    expect(canonicalTaskDecisionInvariantViolations(certified))
      .toContain("certificate-forbids-unserved-epoch-contract");
    applyCanonicalTaskDecision(certified);
    expect(certified.execution_contract?.typestate.phase).toBe("discovery");
    expect(certified.coverage).not.toBe("complete");
  });

  it("an uncovered-concern disclosure demotes a certificate to a bounded find", () => {
    const certified = packResult({
      surfaces: [{ ...SYNTHETIC_SURFACE }],
    });
    certified.execution_contract = buildTaskExecutionContract(certified, "generic", NARROWED_QUERY);
    certified.missing = [
      "uncovered-concern:schedulerMutex (named by an earlier pack in this task;"
      + " re-request via search_files action=find query=schedulerMutex)",
    ];
    const decision = deriveCanonicalTaskDecision(certified);
    expect(decision?.kind).toBe("discover");
    expect(decision?.next_call).toEqual({
      tool: "search_files",
      arguments: { action: "find", query: "schedulerMutex" },
    });
  });

  it("an ordinary missing[] entry is NOT mistaken for an epoch-contract disclosure", () => {
    const certified = packResult({
      surfaces: [{ ...SYNTHETIC_SURFACE }],
    });
    certified.execution_contract = buildTaskExecutionContract(certified, "generic", NARROWED_QUERY);
    // Bare role names and the sibling byte-budget note keep today's behavior.
    certified.missing = ["ui", "dropped-by-byte-budget: src/other.ts"];
    expect(canonicalTaskDecisionInvariantViolations(certified))
      .not.toContain("certificate-forbids-unserved-epoch-contract");
  });

  it("a concern token naming a value to be ADDED never becomes a standing requirement", async () => {
    // "STALLED" is identifier-shaped and matches nothing in the workspace by
    // design — it is what the edit will CREATE. A pack that ships `complete`
    // has declared it is not an evidence gap; the epoch must respect that, or
    // every later pack of the task is permanently uncertifiable.
    // The exact enum-addition shape readCodeTaskPack.spec.ts's own dedup
    // fixture uses, which reaches `complete` on the first pack.
    const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-query-continuity-added-")));
    workspaces.push(ws);
    for (const [rel, body] of [
      ["src/shared/status.ts", "export const Status = { OPEN: 'open', CLOSED: 'closed' } as const;\n"],
      ["src/api/routes.ts", "export function listByStatus(s: string) { return []; }\n"],
    ] as const) {
      fs.mkdirSync(path.join(ws, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(ws, rel), body);
    }
    const args = {
      query: "add STALLED status to the status enum",
      paths: [{ path: "src/shared/status.ts" }, { path: "src/api/routes.ts" }],
    };
    const first = await buildTaskPack(args as never, ws);
    expect(first.coverage).toBe("complete");
    const second = await buildTaskPack({ ...args, limit: 3 } as never, ws);
    expect(second.missing.join("\n")).not.toContain("uncovered-concern:");
    expect(second.coverage).toBe("complete");
  });

  it("clearTaskContract (the taskEpoch:\"new\" boundary) restores fresh behavior", async () => {
    const ws = makeWorkspace("d2-reset");
    await buildTaskPack({ query: BROAD_QUERY, surfaceRoles: ["ui", "style"] } as never, ws);
    clearTaskContract(ws);
    const fresh = await buildTaskPack({ query: NARROWED_QUERY } as never, ws);
    expect(fresh.required_surfaces ?? []).not.toEqual(expect.arrayContaining(["ui", "style"]));
    expect(fresh.missing.join("\n")).not.toContain("unserved-required-role:");
  });

  it("a DIFFERENT task in the same workspace inherits nothing", async () => {
    const ws = makeWorkspace("d2-cross-task");
    await buildTaskPack({ query: BROAD_QUERY, surfaceRoles: ["ui", "style"] } as never, ws);
    // No token overlap with BROAD_QUERY: a different task by the same
    // predicate priorPackStore / packServeLog already use.
    const other = await buildTaskPack({ query: "list the package manifest fields" } as never, ws);
    expect(other.missing.join("\n")).not.toContain("unserved-required-role:");
  });
});

// ---------------------------------------------------------------------------
// D2b — `taskEpoch:"new"` clears priorPackStore too
//
// `clearPriorPackObligations` shipped as priorPackStore's declared epoch
// boundary and had ZERO production call sites, so an explicit
// `taskEpoch:"new"` left a prior task's open edit obligations standing on a
// workspace path a later task reuses — the same incident class
// `clearPackDedupeForWorkspace`'s own doc comment describes for the dedupe
// maps. Both arms run so the clear is proven to be what changes the outcome,
// not the fixture.
// ---------------------------------------------------------------------------

describe("D2b — taskEpoch:\"new\" clears the prior-pack obligation store", () => {
  const EPOCH1 = "wire computeChecksumContract into computeChecksumRoutes";
  /** A required, open, action:"edit" obligation on a path the later pack will not serve. */
  const STALE = {
    id: "o-stale",
    path: "src/protocol/checksumTransport.ts",
    role: "api",
    kind: "call-site",
    action: "edit",
    required: true,
    open: true,
  } as const;

  let savedV1: string | undefined;
  let savedV2: string | undefined;

  beforeEach(() => {
    // The V11-03 seam that both READS the store and writes F-B3's
    // `unserved-obligation:` disclosure is flag-gated; without it the store is
    // never consulted and this test would pass vacuously.
    savedV1 = process.env["TL_COVERAGE_PACKER"];
    savedV2 = process.env["TL_COVERAGE_PACKER_V2"];
    process.env["TL_COVERAGE_PACKER"] = "1";
    process.env["TL_COVERAGE_PACKER_V2"] = "1";
  });

  afterEach(() => {
    if (savedV1 === undefined) delete process.env["TL_COVERAGE_PACKER"]; else process.env["TL_COVERAGE_PACKER"] = savedV1;
    if (savedV2 === undefined) delete process.env["TL_COVERAGE_PACKER_V2"]; else process.env["TL_COVERAGE_PACKER_V2"] = savedV2;
  });

  it("WITHOUT the epoch clear, a stale obligation still reaches the next pack (control)", async () => {
    const ws = makeWorkspace("d2b-control");
    recordPriorPackObligations(ws, tokenizeForEpoch(EPOCH1), [STALE]);
    expect(queryPriorPackObligations(ws, tokenizeForEpoch(EPOCH1))).toHaveLength(1);

    const next = await buildTaskPack(
      { query: EPOCH1, paths: [{ path: "src/types/checksumContract.ts" }] } as never,
      ws,
    );
    expect(next.missing.join("\n")).toContain("unserved-obligation:");
  });

  it("clearPackDedupeForWorkspace (the taskEpoch:\"new\" path) drops the obligations", async () => {
    const ws = makeWorkspace("d2b-cleared");
    recordPriorPackObligations(ws, tokenizeForEpoch(EPOCH1), [STALE]);
    expect(queryPriorPackObligations(ws, tokenizeForEpoch(EPOCH1))).toHaveLength(1);

    // Exactly what server.ts's `taskEpoch === "new"` branch calls.
    clearPackDedupeForWorkspace(ws);
    expect(queryPriorPackObligations(ws, tokenizeForEpoch(EPOCH1))).toEqual([]);

    const fresh = await buildTaskPack(
      { query: EPOCH1, paths: [{ path: "src/types/checksumContract.ts" }] } as never,
      ws,
    );
    // Neither F-B3's same-call detector nor the epoch reconciliation fires.
    expect(fresh.missing.join("\n")).not.toContain("unserved-obligation:");
    expect(fresh.missing.join("\n")).not.toContain("unserved-required-role:");
    expect(canonicalTaskDecisionInvariantViolations(fresh)).toEqual([]);
  });

  it("the clear is per-workspace: another workspace's obligations survive", () => {
    const kept = makeWorkspace("d2b-kept");
    const cleared = makeWorkspace("d2b-other");
    recordPriorPackObligations(kept, tokenizeForEpoch(EPOCH1), [STALE]);
    recordPriorPackObligations(cleared, tokenizeForEpoch(EPOCH1), [STALE]);

    clearPackDedupeForWorkspace(cleared);

    expect(queryPriorPackObligations(cleared, tokenizeForEpoch(EPOCH1))).toEqual([]);
    expect(queryPriorPackObligations(kept, tokenizeForEpoch(EPOCH1))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// D3 — the certified frontier remembers the epoch
// ---------------------------------------------------------------------------

describe("D3 — same-epoch served evidence reaches the certified frontier", () => {
  const CURRENT = "src/control/parserSign.ts";
  const PRIOR = "src/types/checksumContract.ts";

  function certifiedFrontier(ws: string | undefined): string[] {
    const result = packResult({
      surfaces: [{ ...SYNTHETIC_SURFACE, path: CURRENT }],
    });
    const contract = buildTaskExecutionContract(result, "generic", BROAD_QUERY, undefined, ws);
    expect(contract.readiness_certificate, "fixture must certify").toBeDefined();
    return contract.readiness_certificate!.action_frontier;
  }

  it("a handle pack 1 served is in pack 2's action_frontier", () => {
    const ws = makeWorkspace("d3-frontier");
    recordServedSurfaces(
      ws,
      ws,
      [{ path: PRIOR, role: "contract", handle: "h-prior" }],
      tokenizeForEpoch(BROAD_QUERY),
    );
    const frontier = certifiedFrontier(ws);
    expect(frontier).toContain("h-impl");
    expect(frontier).toContain("h-prior");
    // Current-call evidence keeps priority under the 12-entry cap.
    expect(frontier.indexOf("h-impl")).toBeLessThan(frontier.indexOf("h-prior"));
  });

  it("omitting the workspace reproduces exactly the pre-fix frontier", () => {
    const ws = makeWorkspace("d3-no-workspace");
    recordServedSurfaces(
      ws,
      ws,
      [{ path: PRIOR, role: "contract", handle: "h-prior" }],
      tokenizeForEpoch(BROAD_QUERY),
    );
    expect(certifiedFrontier(undefined)).not.toContain("h-prior");
  });

  it("a different task's served evidence never reaches the frontier", () => {
    const ws = makeWorkspace("d3-cross-task");
    recordServedSurfaces(
      ws,
      ws,
      [{ path: PRIOR, role: "contract", handle: "h-prior" }],
      tokenizeForEpoch("list the package manifest fields"),
    );
    expect(certifiedFrontier(ws)).not.toContain("h-prior");
  });
});
