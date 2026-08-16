/**
 * packFrontierIndex.spec.ts — IMPROVEMENT A part 3: the complete-working-set
 * frontier_index.
 *
 * A pack that is NOT single-call complete carries a code-less inventory of the
 * entire known working set (current surfaces + budget-trimmed candidates +
 * resolvable depth-1 import neighbours + prior served surfaces). A single-call
 * complete pack carries none.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildTaskPack } from "../tools/readCodeTaskPack.js";
import { handleTable } from "../util/handles.js";
import { resetPackServeLogForTest } from "../util/packServeLog.js";

function mkWs(tag: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `tl-frontier-${tag}-`)));
}
function write(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function seedFixture(ws: string): void {
  write(ws, "packages/model/package.json", JSON.stringify({ name: "model" }));
  write(ws, "packages/model/src/types/status.ts",
    `export enum Status { OPEN = "OPEN", CLOSED = "CLOSED" }\n`);
  write(ws, "packages/model/src/services/statusService.ts",
    `import { Status } from "../types/status";\nexport function svc(s: Status) { return s; }\n`);
  write(ws, "packages/web/package.json", JSON.stringify({ name: "web" }));
  write(ws, "packages/web/src/StatusBadge.tsx",
    `import { Status } from "../../model/src/types/status";\n` +
    `export function StatusBadge({ s }: { s: Status }) { return <span>{s}</span>; }\n`);
  write(ws, "packages/web/src/status.css", `.badge { color: green; }\n`);
}

const ROLES = ["contract", "api", "ui", "style"];
const QUERY = "Status label rendering";

describe("buildTaskPack — IMPROVEMENT A: frontier_index", () => {
  beforeEach(() => {
    handleTable.reset();
    resetPackServeLogForTest();
  });

  it("a partial pack lists the whole known working set, code-less, incl. import neighbours", async () => {
    const ws = mkWs("partial");
    seedFixture(ws);
    const res = await buildTaskPack(
      { query: QUERY, surfaceRoles: ROLES, paths: [
        { path: "packages/web/src/StatusBadge.tsx" },
        { path: "packages/web/src/status.css" },
      ] },
      ws,
    );
    expect(res.coverage).toBe("partial");
    const fi = res.frontier_index;
    expect(fi).toBeDefined();
    const byPath = new Map((fi ?? []).map((e) => [e.path, e]));
    // Current surfaces are in the inventory.
    expect(byPath.has("packages/web/src/StatusBadge.tsx")).toBe(true);
    expect(byPath.has("packages/web/src/status.css")).toBe(true);
    // The depth-1 import neighbour of StatusBadge.tsx is discovered (no parse).
    const neighbor = byPath.get("packages/model/src/types/status.ts");
    expect(neighbor).toBeDefined();
    expect(neighbor!.role).toBe("import-neighbor");
    // Inventory is CODE-LESS (path/role/handle only — never a `code` field).
    for (const e of fi ?? []) {
      expect(Object.keys(e).every((k) => k === "path" || k === "role" || k === "handle")).toBe(true);
    }
    // Bounded.
    expect((fi ?? []).length).toBeLessThanOrEqual(200);
    expect(Buffer.byteLength(JSON.stringify(fi), "utf8")).toBeLessThanOrEqual(8192);
    // Route names the frontier_index affordance.
    expect(res.route?.reason).toContain("frontier_index");
  }, 30000);

  it("a single-call complete pack carries no frontier_index", async () => {
    const ws = mkWs("complete");
    seedFixture(ws);
    const res = await buildTaskPack(
      { query: QUERY, surfaceRoles: ROLES, paths: [
        { path: "packages/model/src/types/status.ts" },
        { path: "packages/model/src/services/statusService.ts" },
        { path: "packages/web/src/StatusBadge.tsx" },
        { path: "packages/web/src/status.css" },
      ] },
      ws,
    );
    expect(res.coverage).toBe("complete");
    expect(res.coverage_basis).toBeUndefined();
    expect(res.frontier_index).toBeUndefined();
  }, 30000);
});
