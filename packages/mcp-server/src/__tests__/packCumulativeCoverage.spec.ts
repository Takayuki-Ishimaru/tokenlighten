/**
 * packCumulativeCoverage.spec.ts — IMPROVEMENT A: cumulative (session-stateful)
 * pack coverage.
 *
 * Two layers:
 *   1. util/packServeLog.ts unit tests (record / query / revalidate-invalidate /
 *      epoch scoping) — deterministic, no locator.
 *   2. The exact forensic sequence through buildTaskPack: call 1 serves
 *      {ui,style}; call 2 serves {contract,api} and reports cumulative complete
 *      + prepared phase + served_earlier naming call 1's surfaces; then an edit
 *      to a logged file invalidates its entry and coverage degrades again.
 *
 * Roles are pinned with explicit surfaceRoles; a two-package monorepo layout
 * keeps each call's required-role fill scoped to its OWN package, so the served
 * surface set is exactly the volunteered paths (no cross-package auto-fill).
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildTaskPack } from "../tools/readCodeTaskPack.js";
import { handleTable } from "../util/handles.js";
import {
  recordServedSurfaces,
  queryServedSurfaces,
  invalidateServedPath,
  resetPackServeLogForTest,
} from "../util/packServeLog.js";

function mkWs(tag: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `tl-cumcov-${tag}-`)));
}
function write(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

/** Two-package fixture: model (contract+api) and web (ui+style). */
function seedFixture(ws: string): void {
  write(ws, "packages/model/package.json", JSON.stringify({ name: "model", version: "1.0.0" }));
  write(ws, "packages/model/src/types/status.ts",
    `export enum Status { OPEN = "OPEN", CLOSED = "CLOSED", PENDING = "PENDING" }\n`);
  write(ws, "packages/model/src/services/statusService.ts",
    `import { Status } from "../types/status";\n` +
    `export function label(s: Status): string {\n` +
    `  switch (s) { case Status.OPEN: return "open"; case Status.CLOSED: return "closed"; case Status.PENDING: return "pending"; }\n` +
    `}\n`);
  write(ws, "packages/web/package.json", JSON.stringify({ name: "web", version: "1.0.0" }));
  write(ws, "packages/web/src/StatusBadge.tsx",
    `import { Status } from "../../model/src/types/status";\n` +
    `export function StatusBadge({ s }: { s: Status }) { return <span className={"badge-" + s}>{s}</span>; }\n`);
  write(ws, "packages/web/src/status.css",
    `.badge-OPEN { color: green; }\n.badge-CLOSED { color: gray; }\n.badge-PENDING { color: orange; }\n`);
}

const ROLES = ["contract", "api", "ui", "style"];
// Single-concern query (no independent-concern list) so the concern-group
// augmenter stays a no-op and each call's served surfaces are exactly the
// volunteered package's roles. Same query across calls => same task epoch.
const QUERY = "Status label rendering";

describe("packServeLog — record / query / revalidate", () => {
  beforeEach(() => resetPackServeLogForTest());

  it("returns still-valid prior surfaces, excluding the current call's own paths", () => {
    const ws = mkWs("unit-basic");
    write(ws, "a.ts", "export const a = 1;\n");
    write(ws, "b.ts", "export const b = 2;\n");
    recordServedSurfaces(ws, ws, [
      { path: "a.ts", role: "ui", handle: "h1" },
      { path: "b.ts", role: "style", handle: "h2" },
    ], ["status", "label"]);

    const prior = queryServedSurfaces(ws, ws, {
      excludePaths: new Set(["b.ts"]),
      epochTokens: ["status", "badge"],
    });
    expect(prior.map((p) => p.path)).toEqual(["a.ts"]);
    expect(prior[0]!.role).toBe("ui");
    expect(prior[0]!.handle).toBe("h1");
  });

  it("invalidates an entry whose file content changed (fingerprint mismatch)", () => {
    const ws = mkWs("unit-invalidate");
    write(ws, "a.ts", "export const a = 1;\n");
    recordServedSurfaces(ws, ws, [{ path: "a.ts", role: "ui", handle: "h1" }], ["status"]);
    // Edit the file so its size/mtime identity changes.
    write(ws, "a.ts", "export const a = 1;\nexport const c = 3;\n");
    const prior = queryServedSurfaces(ws, ws, { epochTokens: ["status"] });
    expect(prior).toHaveLength(0);
    // And it is gone from the log for good.
    expect(queryServedSurfaces(ws, ws, { epochTokens: ["status"] })).toHaveLength(0);
  });

  it("explicit invalidateServedPath drops the entry", () => {
    const ws = mkWs("unit-explicit");
    write(ws, "a.ts", "export const a = 1;\n");
    recordServedSurfaces(ws, ws, [{ path: "a.ts", role: "ui" }], ["status"]);
    invalidateServedPath(ws, "a.ts");
    expect(queryServedSurfaces(ws, ws, { epochTokens: ["status"] })).toHaveLength(0);
  });

  it("does not leak surfaces across non-overlapping task epochs", () => {
    const ws = mkWs("unit-epoch");
    write(ws, "a.ts", "export const a = 1;\n");
    recordServedSurfaces(ws, ws, [{ path: "a.ts", role: "ui" }], ["authentication", "login"]);
    // A completely different task (zero token overlap) sees nothing.
    const prior = queryServedSurfaces(ws, ws, { epochTokens: ["payment", "checkout"] });
    expect(prior).toHaveLength(0);
  });
});

describe("buildTaskPack — IMPROVEMENT A: cumulative coverage (forensic sequence)", () => {
  beforeEach(() => {
    handleTable.reset();
    resetPackServeLogForTest();
  });

  it("call 2 completes cumulatively from call 1's surfaces, then degrades after an edit", async () => {
    const ws = mkWs("forensic");
    seedFixture(ws);

    // --- Call 1: serves {ui, style} (web package). Missing {contract, api}. ---
    const call1 = await buildTaskPack(
      { query: QUERY, surfaceRoles: ROLES, paths: [
        { path: "packages/web/src/StatusBadge.tsx" },
        { path: "packages/web/src/status.css" },
      ] },
      ws,
    );
    const call1Roles = new Set(call1.surfaces.map((s) => s.role));
    expect(call1Roles.has("ui")).toBe(true);
    expect(call1Roles.has("style")).toBe(true);
    // Call 1 does NOT cumulatively complete (nothing served earlier).
    expect(call1.coverage_basis).toBeUndefined();
    expect(call1.coverage).toBe("partial");
    expect(call1.missing_required_surfaces ?? []).toEqual(expect.arrayContaining(["contract", "api"]));

    // --- Call 2: serves {contract, api} (model package). Missing {ui, style}. ---
    const call2 = await buildTaskPack(
      { query: QUERY, surfaceRoles: ROLES, paths: [
        { path: "packages/model/src/types/status.ts" },
        { path: "packages/model/src/services/statusService.ts" },
      ] },
      ws,
    );
    const call2Roles = new Set(call2.surfaces.map((s) => s.role));
    expect(call2Roles.has("contract")).toBe(true);
    expect(call2Roles.has("api")).toBe(true);
    // ui/style were NOT re-served this call (auto-fill is scoped to the model package).
    expect(call2Roles.has("ui")).toBe(false);
    expect(call2Roles.has("style")).toBe(false);

    // Cumulative complete: union of call-2 surfaces + still-valid call-1 surfaces
    // covers every required role.
    expect(call2.coverage).toBe("complete");
    expect(call2.coverage_basis).toBe("cumulative");
    // served_earlier names call-1's surfaces (so the model does not re-fetch).
    const earlierRoles = new Set((call2.served_earlier ?? []).map((e) => e.role));
    expect(earlierRoles.has("ui")).toBe(true);
    expect(earlierRoles.has("style")).toBe(true);
    for (const e of call2.served_earlier ?? []) {
      expect(e.path.startsWith("packages/web/")).toBe(true);
      expect(typeof e.path).toBe("string");
    }
    // Route no longer says locate_missing_surfaces.
    expect(call2.route?.action).not.toBe("locate_missing_surfaces");
    expect(call2.route?.action).toBe("edit_from_handles");
    expect(call2.missing_required_surfaces).toBeUndefined();
    // Execution contract flips to prepared / discovery-closed, exactly like a
    // single-call complete pack.
    expect(call2.execution_contract?.typestate.phase).toBe("prepared");
    expect(call2.execution_contract?.discovery_complete).toBe(true);

    // --- Degradation: edit a logged file (the ui surface) then re-run call 2. ---
    write(ws, "packages/web/src/StatusBadge.tsx",
      `import { Status } from "../../model/src/types/status";\n` +
      `// edited\nexport function StatusBadge({ s }: { s: Status }) { return <b>{s}</b>; }\n`);
    const call3 = await buildTaskPack(
      { query: QUERY, surfaceRoles: ROLES, paths: [
        { path: "packages/model/src/types/status.ts" },
        { path: "packages/model/src/services/statusService.ts" },
      ] },
      ws,
    );
    // The ui entry is invalidated, so the union no longer covers {ui}.
    expect(call3.coverage_basis).toBeUndefined();
    expect(call3.coverage).toBe("partial");
    expect(call3.missing_required_surfaces ?? []).toContain("ui");
  }, 60000);
});
