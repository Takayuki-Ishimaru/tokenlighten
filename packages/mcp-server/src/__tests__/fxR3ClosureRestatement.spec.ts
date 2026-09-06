/**
 * fxR3ClosureRestatement.spec.ts — FX-R3 (2026-09-04), defects D1 and D2.
 *
 * Both were reproduced from the recorded wire of a real paid smoke cell
 * (`2026-09-04-semantic-frontier-v2-paid-ab-smoke-r3`, cell
 * `SF05-aeroctl-contract-wiring-a_tl_sf_v2-r0`, first call):
 *
 *   D1 — the DEEP recursive read closure EXECUTES the provisional contract's
 *        `next_call` itself. When the loop ended, that call was still sitting
 *        on `result.next` / `result.continuation`, so the candidate chain in
 *        `buildTaskExecutionContract` restated it as the caller's `next`. The
 *        observed wire: `decision.kind:"discover"` +
 *        `gaps:[missing-evidence surface-content]` + `next: search_files find
 *        ["contract"]` — a search the server had already run — while the
 *        obligation actually open was a CODELESS required surface that the
 *        chain's own `gapFallback` (`read_file {handle}`) would have closed.
 *
 *   D2 — the closure's merge/dedup checks compared `range` STRINGS, so a
 *        narrower window of a path the pack already served with a wider body
 *        was pushed as a NEW `required:true` surface. The observed wire
 *        carried `drv_baro.h` twice: `1-49` with a body and `1-23` without.
 *
 * Everything below drives the REAL production functions
 * (`runRecursiveReadOnlyClosure`, `buildTaskExecutionContract`,
 * `deriveCanonicalTaskDecision`) over a real temporary workspace; the pack
 * shapes follow `readinessSemantics.spec.ts`'s own `discoveryPack` pattern,
 * which is how the closure loop's mechanics have been pinned since 2026-07-16.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildTaskExecutionContract,
  deriveCanonicalTaskDecision,
  resetClosureExecutedCallsForTest,
  runRecursiveReadOnlyClosure,
  type TaskPackResult,
} from "../tools/readCodeTaskPack.js";

const roots: string[] = [];

afterEach(() => {
  resetClosureExecutedCallsForTest();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const IMPL_CODE = "export function calculateInvoiceTotal(rounding: number) {\n  return rounding + 1;\n}\n";

function closureWorkspace(extra: Record<string, string> = {}): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-fxr3-closure-")));
  roots.push(root);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/order.ts"), IMPL_CODE);
  for (const [rel, content] of Object.entries(extra)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

function packResult(overrides: Record<string, unknown>): TaskPackResult {
  return {
    mode: "task_pack",
    coverage: "partial",
    coverage_reason: "concerns-uncovered",
    surfaces: [],
    missing: [],
    route: { action: "locate_missing_surfaces", max_additional_tl_calls: 1, reason: "missing evidence" },
    // The deep loop is profile-gated (RECURSIVE_CLOSURE_DEEP_PROFILES); opt in
    // through the sanctioned explicit binding, exactly like
    // readinessSemantics.spec.ts's own closure tests.
    profile_binding: { selected: "generic", source: "explicit", reason: "closure mechanics under test" },
    ...overrides,
  } as unknown as TaskPackResult;
}

/** The search the loop will run for itself — carried as BOTH `next` and stage 0. */
const SEARCH_CALL = {
  tool: "search_files",
  arguments: { action: "find", query: "calculateInvoiceTotal rounding" },
} as const;

function selfExecutingPack(overrides: Record<string, unknown> = {}): TaskPackResult {
  return packResult({
    next: { ...SEARCH_CALL, arguments: { ...SEARCH_CALL.arguments } },
    continuation: {
      version: 1,
      stages: [{ execution: "parallel", calls: [{ ...SEARCH_CALL, arguments: { ...SEARCH_CALL.arguments } }] }],
    },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// D1 — a call the server ran itself is never restated as the caller's `next`.
// ---------------------------------------------------------------------------

describe("FX-R3 D1 — a self-executed closure call is never restated as `next`", () => {
  const QUERY = "update calculateInvoiceTotal rounding across the audit trail";

  it("FIX-PROVING: with `surface-content` still open, `next` is the codeless surface's read_file — never the executed search", () => {
    const workspace = closureWorkspace();
    // A REQUIRED, CODELESS surface: exactly the obligation the recorded wire
    // left open (`gaps:[missing-evidence surface-content]`). Its handle is what
    // the chain's `gapFallback` names.
    const result = selfExecutingPack({
      surfaces: [
        {
          role: "domain",
          handle: "h-gap",
          path: "src/audit_trail.ts",
          range: "1-40",
          required: true,
          why: "query-identifier",
        },
      ],
    });

    const operations = runRecursiveReadOnlyClosure(result, "generic", QUERY, workspace);
    expect(operations, "the loop ran the search itself").toBeGreaterThanOrEqual(1);
    expect(result.internalized).toEqual([{ op: "find", status: "used", evidence: 1 }]);

    const contract = buildTaskExecutionContract(result, "generic", QUERY, undefined, workspace);
    // PRE-FIX: `search_files` — the very call the loop above had just run.
    expect(contract.next_call?.tool).toBe("read_file");
    expect(contract.next_call?.arguments).toMatchObject({ handle: "h-gap" });
    // And the same through the canonical decision the wire is projected from
    // (which reads the pack's own `execution_contract`).
    (result as unknown as Record<string, unknown>)["execution_contract"] = contract;
    const decision = deriveCanonicalTaskDecision(result);
    expect(decision?.kind).toBe("discover");
    expect(decision?.next_call?.tool).toBe("read_file");
  });

  it("the executed search is dropped from BOTH stale slots (`continuation` stage 0 and `next`)", () => {
    const workspace = closureWorkspace();
    // No codeless surface, no fallback: with the executed call suppressed there
    // is nothing left for the chain to name, which is the honest answer — the
    // pack must not invent a call it already ran.
    const result = selfExecutingPack({ surfaces: [] });
    expect(runRecursiveReadOnlyClosure(result, "generic", QUERY, workspace)).toBe(1);
    const contract = buildTaskExecutionContract(result, "generic", QUERY, undefined, workspace);
    expect(contract.next_call?.tool).not.toBe("search_files");
  });

  it("CONTROL: a pack whose closure ran NOTHING keeps its `next` exactly as before", () => {
    const workspace = closureWorkspace();
    const result = selfExecutingPack({
      surfaces: [
        {
          role: "domain",
          handle: "h-gap",
          path: "src/audit_trail.ts",
          range: "1-40",
          required: true,
          why: "query-identifier",
        },
      ],
      // An INFERRED lean binding never enters the deep loop, so nothing is
      // executed and no fingerprint is recorded.
      profile_binding: {
        requested: "auto",
        selected: "generic",
        source: "inferred",
        confidence: 0.8,
        reason: "query matched generic",
      },
    });
    expect(runRecursiveReadOnlyClosure(result, "generic", QUERY, workspace)).toBe(0);
    const contract = buildTaskExecutionContract(result, "generic", QUERY, undefined, workspace);
    expect(contract.next_call?.tool).toBe("search_files");
  });

  it("CONTROL: with nothing open, the decision is untouched — the loop executes nothing and the fingerprint set stays empty", () => {
    const workspace = closureWorkspace();
    // A pack that is already closed: the loop's own entry gate
    // (`contract.typestate.phase === "discovery"`) refuses it, so no call is
    // executed and no fingerprint is recorded. The decision is whatever it was
    // before this fix, by construction.
    const result = selfExecutingPack({
      coverage: "focused",
      coverage_reason: "single-site",
      route: { action: "edit_from_handles", max_additional_tl_calls: 0 },
      surfaces: [
        {
          role: "domain",
          handle: "h-served",
          path: "src/order.ts",
          range: "1-3",
          required: true,
          why: "query-identifier",
          code: IMPL_CODE,
        },
      ],
    });
    expect(runRecursiveReadOnlyClosure(result, "generic", QUERY, workspace)).toBe(0);
    expect(result.internalized).toBeUndefined();
    const contract = buildTaskExecutionContract(result, "generic", QUERY, undefined, workspace);
    expect(contract.typestate.phase).toBe("prepared");
    expect(contract.next_call).toBeUndefined();
    (result as unknown as Record<string, unknown>)["execution_contract"] = contract;
    expect(deriveCanonicalTaskDecision(result)?.kind).toBe("act-edit");
  });
});

// ---------------------------------------------------------------------------
// D2 — one row per served window; never a duplicate for bytes already sent.
// ---------------------------------------------------------------------------

describe("FX-R3 D2 — a closure hit inside an already-served window merges into that row", () => {
  const QUERY = "explain calculateInvoiceTotal rounding";

  it("FIX-PROVING (read): a narrower range of an already-served path mints no second row", () => {
    const workspace = closureWorkspace();
    const served = fs.readFileSync(path.join(workspace, "src/order.ts"), "utf8");
    const result = packResult({
      surfaces: [
        {
          role: "domain",
          handle: "h-wide",
          path: "src/order.ts",
          range: "1-3",
          required: true,
          why: "query-identifier",
          code: served,
        },
      ],
      continuation: {
        version: 1,
        stages: [{
          execution: "parallel",
          // A NARROWER window of the very path the row above already serves.
          calls: [{ tool: "read_file", arguments: { path: "src/order.ts", range: "1-2" } }],
        }],
      },
    });

    runRecursiveReadOnlyClosure(result, "generic", QUERY, workspace);

    // PRE-FIX: 2 surfaces — `1-3` with a body plus a new `1-2` row.
    expect(result.surfaces).toHaveLength(1);
    expect(result.surfaces[0]?.range).toBe("1-3");
    expect(result.surfaces[0]?.code).toBe(served);
    const contract = buildTaskExecutionContract(result, "generic", QUERY, undefined, workspace);
    const surfaceContent = contract.evidence_model?.claims
      .find((claim) => claim.id === "surface-content");
    // PRE-FIX the duplicate bodyless row made this claim unsupported (a
    // required surface with no served content), which is what re-opened
    // `missing-evidence: surface-content` on the recorded wire.
    expect(surfaceContent?.status, "no bodyless duplicate to re-open the claim").toBe("supported");
    expect(surfaceContent?.evidence_handles).toEqual(["h-wide"]);
  });

  it("FIX-PROVING (search): a search hit inside an already-served window mints no second row", () => {
    const workspace = closureWorkspace();
    const served = fs.readFileSync(path.join(workspace, "src/order.ts"), "utf8");
    const result = packResult({
      surfaces: [
        {
          role: "domain",
          handle: "h-wide",
          path: "src/order.ts",
          range: "1-3",
          required: true,
          why: "query-identifier",
          code: served,
        },
      ],
      continuation: {
        version: 1,
        stages: [{ execution: "parallel", calls: [{ ...SEARCH_CALL, arguments: { ...SEARCH_CALL.arguments } }] }],
      },
    });

    runRecursiveReadOnlyClosure(result, "generic", QUERY, workspace);

    // PRE-FIX: the search's own window (`1-3`, a different string than the
    // ranked hit's) landed as a second `src/order.ts` row.
    const orderRows = result.surfaces.filter((surface) => surface.path === "src/order.ts");
    expect(orderRows).toHaveLength(1);
    expect(orderRows[0]?.code).toBe(served);
  });

  it("CONTROL: a hit in a file the pack does NOT serve is still internalized", () => {
    const workspace = closureWorkspace({
      "src/audit_trail.ts": "export function auditInvoiceTotal(rounding: number) {\n  return rounding;\n}\n",
    });
    const result = packResult({
      surfaces: [],
      continuation: {
        version: 1,
        stages: [{
          execution: "parallel",
          calls: [{ tool: "search_files", arguments: { action: "find", query: "auditInvoiceTotal" } }],
        }],
      },
    });
    runRecursiveReadOnlyClosure(result, "generic", "explain auditInvoiceTotal", workspace);
    expect(result.surfaces.map((surface) => surface.path)).toContain("src/audit_trail.ts");
  });
});
