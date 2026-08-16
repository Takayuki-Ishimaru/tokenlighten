/**
 * candidateListPack.spec.ts — 2026-07-19a T13 rep0 runaway containment.
 *
 * That cell's opening task_pack came back generic + partial + candidate-list
 * with CODELESS candidates, the recursive closure broke out immediately, and
 * no stop condition survived on the wire — the model thrashed full/slice/
 * search for 109 turns ($6.145 vs $2.205 paired). Pins the three-part fix:
 *
 *   1. candidate inline pass: a candidate-list pack inlines the ranked
 *      candidates' own bodies (<= RECURSIVE_READ_CLOSURE_MAX_BRANCHES, byte
 *      capped) and emits an internalized receipt — for EVERY profile.
 *   2. choose-candidate close: with every candidate body served, the
 *      execution contract lands on awaiting-input / choose-candidate with the
 *      exact handle list, edit allowed, and NO discovery next_call that would
 *      re-serve already-served handles. With candidates still codeless (byte
 *      cap / >3 candidates), discovery stays open with a bounded next_call
 *      naming only the codeless remainder.
 *   3. deep-closure profile gate: the open-ended recursive loop runs only for
 *      structurally multi-site profiles (wiring/multi_concern) or an explicit
 *      caller-pinned taskProfile — on lean single-area packs it only inflated
 *      bulk (T09-shape cells, both arms worse).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildTaskPack,
  buildTaskExecutionContract,
  runRecursiveReadOnlyClosure,
  type TaskPackResult,
} from "../tools/readCodeTaskPack.js";
import { handleTable } from "../util/handles.js";
import { resetAll, recordCandidateListPack } from "../util/session.js";

const roots: string[] = [];

function mkWorkspace(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-candidate-")));
  roots.push(root);
  return root;
}

function writeFile(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

const DUMMY_SHA = "sha256:" + "0".repeat(64);

function candidateBody(tag: string): string {
  return [
    `// ${tag} — candidate implementation.`,
    `export function ${tag}Health(): boolean {`,
    "  const status = readStatus();",
    "  return status.healthy;",
    "}",
    "function readStatus() { return { healthy: true }; }",
  ].join("\n") + "\n";
}

interface CandidateFixture {
  ws: string;
  result: TaskPackResult;
  handles: string[];
}

/** A candidate-list pack whose N candidates are real on-disk files with real handles. */
function candidateListFixture(count: number): CandidateFixture {
  const ws = mkWorkspace();
  const handles: string[] = [];
  const surfaces: Array<Record<string, unknown>> = [];
  for (let i = 0; i < count; i++) {
    const rel = `src/health_${String.fromCharCode(97 + i)}.ts`;
    writeFile(ws, rel, candidateBody(`candidate${i}`));
    const entry = handleTable.upsert({
      kind: "range",
      path: rel,
      range: "1-6",
      workspaceRoot: ws,
      sha: DUMMY_SHA,
    });
    handles.push(entry.id);
    surfaces.push({
      role: "domain",
      handle: entry.id,
      path: rel,
      range: "1-6",
      required: true,
      why: "primary-candidate",
    });
  }
  const result = {
    mode: "task_pack",
    coverage: "partial",
    coverage_reason: "candidate-list",
    surfaces,
    missing: [],
    route: {
      action: "confirm_candidates",
      reason: "multiple candidate primaries returned; confirm the target before editing",
      max_additional_tl_calls: 1,
    },
  } as unknown as TaskPackResult;
  return { ws, result, handles };
}

const QUERY = "estimator health status not updating fix";

beforeEach(() => {
  resetAll();
  handleTable.reset();
});

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("candidate-list semantic identity resolution", () => {
  it("routes one parenthesized PascalCase identity past a prose-only decoy", async () => {
    const ws = mkWorkspace();
    for (let i = 0; i < 5; i++) {
      writeFile(ws, `src/accounts_handler_${i}.ts`, [
        `export const accountTypeError${i} =`,
        '  "liability equity revenue accounts use credit-normal balances";',
        "",
      ].join("\n"));
    }
    writeFile(ws, "src/compute.ts", [
      "// liability equity revenue accounts use credit-normal balances",
      "export function Compute(): number {",
      "  const normalSide = 0;",
      "  return normalSide;",
      "}",
      "",
    ].join("\n"));

    const query = "liability/equity/revenue の逆符号を balance 計算 (Compute) で修正する";
    const args = {
      query,
      path: "src",
      taskProfile: "generic",
    } as const;
    const result = await buildTaskPack(args, ws);

    expect(result.coverage).toBe("complete");
    expect(result.surfaces.map((surface) => surface.path)).toEqual(["src/compute.ts"]);
    expect(result.surfaces[0]?.code).toContain("function Compute");
    expect(result.execution_contract?.typestate.phase).toBe("prepared");
    expect(result.route).toMatchObject({ action: "edit_from_handles", max_additional_tl_calls: 0 });

    const repeated = await buildTaskPack(args, ws);
    expect(repeated.pack_unchanged).toBe(true);
    expect(repeated.surfaces.map((surface) => surface.path)).toEqual(["src/compute.ts"]);
  });
});

describe("candidate-list containment — inline pass (fix 1)", () => {
  it("inlines every candidate body (<=3) and records an internalized receipt", () => {
    const { ws, result } = candidateListFixture(3);
    const ops = runRecursiveReadOnlyClosure(result, "generic", QUERY, ws);
    expect(ops).toBe(1);
    for (const surface of result.surfaces as Array<{ code?: string }>) {
      expect(typeof surface.code).toBe("string");
      expect(surface.code).toContain("Health()");
    }
    expect(result.internalized?.length).toBeGreaterThanOrEqual(1);
    expect(result.internalized?.[0]?.op).toBe("read");
    expect(result.internalized?.[0]?.status).toBe("used");
    // All candidates served → no batch re-read `next` pointing at them.
    expect(result.next).toBeUndefined();
  });

  it("keeps the route on confirm_candidates (the choice stays the caller's)", () => {
    const { ws, result } = candidateListFixture(3);
    runRecursiveReadOnlyClosure(result, "generic", QUERY, ws);
    expect(result.route?.action).toBe("confirm_candidates");
  });

  it("never enters the deep loop from a candidate-list pack (single bounded op)", () => {
    const { ws, result } = candidateListFixture(2);
    const ops = runRecursiveReadOnlyClosure(result, "wiring", QUERY, ws);
    // Even for a deep-eligible profile the candidate path is one pass, no recursion.
    expect(ops).toBe(1);
  });
});

describe("candidate-list containment — choose-candidate close (fix 2)", () => {
  it("closes on awaiting-input with the exact handle list once every body is served", () => {
    const { ws, result, handles } = candidateListFixture(3);
    runRecursiveReadOnlyClosure(result, "generic", QUERY, ws);
    const contract = buildTaskExecutionContract(result, "generic", QUERY);
    expect(contract.state).toBe("needs-followup");
    expect(contract.readiness).toBe("choose-candidate");
    expect(contract.typestate.phase).toBe("awaiting-input");
    expect(contract.typestate.allowed_actions).toContain("edit");
    expect(contract.next_call).toBeUndefined();
    expect(contract.reason.startsWith("choose-candidate:")).toBe(true);
    for (const handle of handles) {
      expect(contract.reason).toContain(handle);
    }
  });

  it("keeps bounded discovery open while a candidate remains codeless (>3 candidates)", () => {
    const { ws, result } = candidateListFixture(4);
    const ops = runRecursiveReadOnlyClosure(result, "generic", QUERY, ws);
    expect(ops).toBe(1);
    const surfaces = result.surfaces as Array<{ handle: string; code?: string }>;
    const codeless = surfaces.filter((surface) => surface.code === undefined);
    expect(codeless.length).toBe(1);
    // The recomputed `next` names ONLY the codeless remainder, never a served handle.
    expect(result.next).toBeDefined();
    expect(result.next).toContain(codeless[0]!.handle);
    for (const surface of surfaces.filter((s) => s.code !== undefined)) {
      expect(result.next).not.toContain(surface.handle);
    }
    const contract = buildTaskExecutionContract(result, "generic", QUERY);
    expect(contract.typestate.phase).toBe("discovery");
    expect(contract.next_call).toBeDefined();
    expect(contract.next_call?.tool).toBe("read_file");
  });
});

describe("deep-closure profile gate (fix 3)", () => {
  /** A non-candidate partial pack with one served impl and one codeless required consumer. */
  function gateFixture(): { ws: string; result: TaskPackResult } {
    const ws = mkWorkspace();
    writeFile(ws, "src/impl.ts", candidateBody("impl"));
    writeFile(ws, "src/consumer.ts", candidateBody("consumer"));
    const implHandle = handleTable.upsert({
      kind: "range", path: "src/impl.ts", range: "1-6", workspaceRoot: ws, sha: DUMMY_SHA,
    });
    const consumerHandle = handleTable.upsert({
      kind: "range", path: "src/consumer.ts", range: "1-6", workspaceRoot: ws, sha: DUMMY_SHA,
    });
    const result = {
      mode: "task_pack",
      coverage: "partial",
      surfaces: [
        {
          role: "domain", handle: implHandle.id, path: "src/impl.ts", range: "1-6",
          required: true, why: "query-evidence", code: candidateBody("impl"),
        },
        {
          role: "domain", handle: consumerHandle.id, path: "src/consumer.ts", range: "1-6",
          required: true, why: "query-evidence",
        },
      ],
      missing: [],
      route: { action: "edit_from_handles", reason: "test", max_additional_tl_calls: 1 },
    } as unknown as TaskPackResult;
    return { ws, result };
  }

  it("skips the deep loop for an inferred lean profile (generic)", () => {
    const { ws, result } = gateFixture();
    const ops = runRecursiveReadOnlyClosure(result, "generic", QUERY, ws);
    expect(ops).toBe(0);
    expect(result.internalized).toBeUndefined();
  });

  it("runs the deep loop for a multi-site profile (wiring)", () => {
    const { ws, result } = gateFixture();
    const ops = runRecursiveReadOnlyClosure(result, "wiring", QUERY, ws);
    expect(ops).toBeGreaterThanOrEqual(1);
    const consumer = (result.surfaces as Array<{ path: string; code?: string }>)
      .find((surface) => surface.path === "src/consumer.ts");
    expect(typeof consumer?.code).toBe("string");
  });

  it("runs the deep loop for ANY profile when the caller pinned it explicitly", () => {
    const { ws, result } = gateFixture();
    (result as { profile_binding?: unknown }).profile_binding = {
      selected: "generic",
      source: "explicit",
      reason: "caller-pinned taskProfile (mechanism run)",
    };
    const ops = runRecursiveReadOnlyClosure(result, "generic", QUERY, ws);
    expect(ops).toBeGreaterThanOrEqual(1);
  });
});

describe("query-named files are requirements, not candidates (B1c, 2026-08-01)", () => {
  // Live defect (run 2026-07-31-semantic-signal5-2, T05c rep0): follow-up
  // task_packs whose query LITERALLY named `control/mixer.cpp`, `mixer.hpp`
  // and `CONTRACT.md` came back as candidate lists containing none of those
  // files (or six-line slivers of them), and the only recovery offered was
  // prose inside route.reason. A caller that has already named the file has
  // done the locating — the pack must serve it.
  function namedFileWs(): string {
    const ws = mkWorkspace();
    // Several same-shaped modules so the locator genuinely cannot pick one.
    for (let i = 0; i < 5; i++) {
      writeFile(ws, `src/handler_${String.fromCharCode(97 + i)}.ts`, candidateBody(`handler${i}`));
    }
    writeFile(ws, "src/control/mixer.cpp", [
      "#include \"control/mixer.hpp\"",
      "namespace control {",
      "float Mixer::apply(float throttle, float roll) {",
      "  return throttle + roll;",
      "}",
      "float Mixer::limit(float value) {",
      "  return value > 1.0f ? 1.0f : value;",
      "}",
      "}",
    ].join("\n") + "\n");
    writeFile(ws, "include/control/mixer.hpp", [
      "#pragma once",
      "namespace control {",
      "struct Mixer {",
      "  float apply(float throttle, float roll);",
      "  float limit(float value);",
      "};",
      "}",
    ].join("\n") + "\n");
    return ws;
  }

  it("force-includes a query-named file as a content-bearing surface", async () => {
    const ws = namedFileWs();
    const result = await buildTaskPack(
      { query: "control/mixer.cpp と mixer.hpp の Mixer::limit の飽和処理を直す" },
      ws,
    );
    const paths = result.surfaces.map((s) => s.path);
    expect(paths, JSON.stringify(paths)).toContain("src/control/mixer.cpp");
    expect(paths, JSON.stringify(paths)).toContain("include/control/mixer.hpp");
    const named = result.surfaces.filter((s) =>
      s.path === "src/control/mixer.cpp" || s.path === "include/control/mixer.hpp");
    for (const surface of named) {
      expect(
        surface.code !== undefined || surface.code_unchanged !== undefined,
        `${surface.path} was named by the query but shipped codeless`,
      ).toBe(true);
    }
  }, 30000);

  it("queryNamedWorkspaceFiles resolves bare basenames and never invents files", async () => {
    const ws = namedFileWs();
    const { queryNamedWorkspaceFiles } = await import("../tools/readCodeTaskPack.js");
    expect(queryNamedWorkspaceFiles("fix mixer.hpp", ws)).toEqual(["include/control/mixer.hpp"]);
    expect(queryNamedWorkspaceFiles("fix src/control/mixer.cpp", ws)).toEqual(["src/control/mixer.cpp"]);
    // Not a file: never resolves, and a version-shaped token is not a filename.
    expect(queryNamedWorkspaceFiles("fix nothing.cpp", ws)).toEqual([]);
    expect(queryNamedWorkspaceFiles("bump to v0.9", ws)).toEqual([]);
  }, 30000);

  it("a candidate list whose query named an unserved file carries an EXECUTABLE recovery", async () => {
    const fixture = candidateListFixture(3);
    writeFile(fixture.ws, "docs/CONTRACT.md", "# Contract\n\nThe mixer must saturate.\n");
    const { attachCandidateListRecovery } = await import("../tools/readCodeTaskPack.js");
    attachCandidateListRecovery(fixture.result, "CONTRACT.md の規定どおり health を直す", fixture.ws);
    expect(fixture.result.next, JSON.stringify(fixture.result)).toBeDefined();
    expect(fixture.result.next).toMatch(/^read_file mode=task_pack /);
    expect(fixture.result.next).toContain("docs/CONTRACT.md");
  });

  it("a query-only re-pack while a candidate choice is pending converges instead of degrading", async () => {
    const ws = namedFileWs();
    const first = await buildTaskPack({ query: QUERY }, ws);
    // Arm the brake exactly as the server dispatch does for a candidate pack.
    if (first.route?.action === "confirm_candidates" || first.coverage_reason === "candidate-list") {
      recordCandidateListPack(ws);
      const second = await buildTaskPack({ query: QUERY }, ws);
      // The re-pack binds the pending candidates as paths, so it CONVERGES on
      // them (a receipt for already-resident bodies counts — what must not
      // happen is a second undecided list over the same ambiguity).
      const secondPaths = new Set(second.surfaces.map((s) => s.path));
      const firstPaths = first.surfaces.map((s) => s.path);
      expect(firstPaths.some((p) => secondPaths.has(p)), JSON.stringify({ firstPaths, secondPaths: [...secondPaths] })).toBe(true);
      expect(second.coverage_reason).not.toBe("candidate-list");
      expect(second.route?.action).not.toBe("confirm_candidates");
    }
  }, 30000);
});
