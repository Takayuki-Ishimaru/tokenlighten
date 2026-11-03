import { expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareNaturalQueryRoute } from "../features/task-pack/naturalQueryRoute.js";
import { exactQueryIdentity } from "../features/task-pack/naturalQueryAdapter.js";

it("keeps raw task identity while excluding assigned worker names from semantic proof", async () => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "tl-natural-worker-")));
  try {
    writeFileSync(join(workspace, "cache.ts"), "export function cancelPendingRequests() { return 'cancellation'; }\n");
    const query = "Explain cancellation handling. Ask Vega subagent to run simple checks.";
    const route = await prepareNaturalQueryRoute({ workspace, query, profile: "answer", taskBinding: "task", lane: "worker" });
    expect(route.evidence.query).toBe(query);
    expect(route.evidence.identity.queryIdentity).toBe(exactQueryIdentity(query));
    expect(JSON.stringify({ plan: route.evidence.plan, gaps: route.evidence.gaps })).not.toContain("Vega");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}, 30000);
