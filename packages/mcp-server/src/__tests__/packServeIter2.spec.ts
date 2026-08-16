/**
 * packServeIter2.spec.ts — iteration-2 pack-side improvements.
 *
 * W1  receipts for re-serves: the served-pack cache is now a bounded MULTI-slot
 *     window, so a verbatim duplicate that is NOT the immediately-preceding call
 *     (an intervening pack sits between them — the iter-1 verbatim-duplicate
 *     loss) still returns a compact receipt; plus the subset receipt and the
 *     changed-workspace full-serve.
 * W2  complete means stop: a complete/focused route carries an explicit stop
 *     signal (guidance only).
 * W3  metadata attach discipline: verification / served_earlier / frontier_index
 *     attach only when they carry NEW information (session-once / on-change).
 * W4  awaiting-input idempotency: a recorded awaiting-input verdict is re-emitted
 *     for an overlapping re-ask until genuinely new inputs / file changes clear it.
 * W5  functional-validation obligation for an artifact-sourced runnable target.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildTaskPack, resetRoleInventoryCache } from "../tools/readCodeTaskPack.js";
import { handleTable } from "../util/handles.js";
import {
  recordServedSurfaces,
  shouldAttachVerification,
  shouldAttachServedEarlier,
  shouldAttachFrontierIndex,
  recordAwaitingInputLatch,
  consultAwaitingInputLatch,
  clearAwaitingInputLatch,
  recordFunctionalValidationObligation,
  getFunctionalValidationObligation,
  clearFunctionalValidationObligation,
  resetPackServeLogForTest,
} from "../util/packServeLog.js";
import { resetPackDedupeCache } from "../tools/readCodeTaskPack.js";

function mkWs(tag: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `tl-iter2-${tag}-`)));
}
function write(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

// ===========================================================================
// packServeLog unit tests (deterministic — no locator).
// ===========================================================================

describe("packServeLog — W3 attach discipline (session-once / on-change)", () => {
  beforeEach(() => resetPackServeLogForTest());

  it("verification: first attaches, an identical verdict is suppressed, a changed one re-attaches", () => {
    const ws = mkWs("w3-verify");
    recordServedSurfaces(ws, ws, [{ path: "a.ts", role: "api" }], ["status"]);
    expect(shouldAttachVerification(ws, "sig-A")).toBe(true);   // first
    expect(shouldAttachVerification(ws, "sig-A")).toBe(false);  // identical → suppress
    expect(shouldAttachVerification(ws, "sig-B")).toBe(true);   // changed → re-attach
    expect(shouldAttachVerification(ws, "sig-B")).toBe(false);
  });

  it("served_earlier: attaches ONCE per epoch (the flip), never again", () => {
    const ws = mkWs("w3-served");
    recordServedSurfaces(ws, ws, [{ path: "a.ts", role: "api" }], ["status"]);
    expect(shouldAttachServedEarlier(ws)).toBe(true);
    expect(shouldAttachServedEarlier(ws)).toBe(false);
    expect(shouldAttachServedEarlier(ws)).toBe(false);
  });

  it("frontier_index: first attaches, identical inventory is suppressed, a changed one re-attaches", () => {
    const ws = mkWs("w3-frontier");
    recordServedSurfaces(ws, ws, [{ path: "a.ts", role: "api" }], ["status"]);
    expect(shouldAttachFrontierIndex(ws, "inv-1")).toBe(true);
    expect(shouldAttachFrontierIndex(ws, "inv-1")).toBe(false);
    expect(shouldAttachFrontierIndex(ws, "inv-2")).toBe(true);
  });

  it("all three flags RESET when the task epoch flips (non-overlapping tokens)", () => {
    const ws = mkWs("w3-reset");
    recordServedSurfaces(ws, ws, [{ path: "a.ts", role: "api" }], ["alpha", "auth"]);
    shouldAttachVerification(ws, "sig-A");
    shouldAttachServedEarlier(ws);
    shouldAttachFrontierIndex(ws, "inv-1");
    // A genuinely different task (zero token overlap) resets the epoch state.
    recordServedSurfaces(ws, ws, [{ path: "b.ts", role: "api" }], ["payment", "checkout"]);
    expect(shouldAttachVerification(ws, "sig-A")).toBe(true);
    expect(shouldAttachServedEarlier(ws)).toBe(true);
    expect(shouldAttachFrontierIndex(ws, "inv-1")).toBe(true);
  });
});

describe("packServeLog — W4 awaiting-input latch (persistence + clearing)", () => {
  beforeEach(() => resetPackServeLogForTest());

  const latch = () => ({
    unresolvedProof: "artifact-input",
    inputPaths: ["rate.xlsx", "engine.ts"],
    fileFingerprint: "fp-1",
    note: "awaiting input; supply the missing artifact or challenge",
  });

  it("holds for an overlapping re-ask with the SAME inputs and unchanged files", () => {
    const ws = mkWs("w4-hold");
    recordServedSurfaces(ws, ws, [{ path: "engine.ts", role: "api" }], ["rate", "engine"]);
    recordAwaitingInputLatch(ws, latch());
    const held = consultAwaitingInputLatch(ws, ["rate", "engine"], ["rate.xlsx", "engine.ts"], "fp-1");
    expect(held?.unresolvedProof).toBe("artifact-input");
  });

  it("CLEARS when the caller supplies a genuinely new input path", () => {
    const ws = mkWs("w4-newinput");
    recordServedSurfaces(ws, ws, [{ path: "engine.ts", role: "api" }], ["rate", "engine"]);
    recordAwaitingInputLatch(ws, latch());
    // A new path beyond the recorded set = new input = resolved.
    expect(consultAwaitingInputLatch(ws, ["rate", "engine"], ["rate.xlsx", "engine.ts", "codes.xlsx"], "fp-1"))
      .toBeUndefined();
    // Latch is gone — a subsequent consult with the old inputs no longer holds.
    expect(consultAwaitingInputLatch(ws, ["rate", "engine"], ["rate.xlsx", "engine.ts"], "fp-1"))
      .toBeUndefined();
  });

  it("CLEARS when the referenced files change (fingerprint mismatch)", () => {
    const ws = mkWs("w4-filechange");
    recordServedSurfaces(ws, ws, [{ path: "engine.ts", role: "api" }], ["rate", "engine"]);
    recordAwaitingInputLatch(ws, latch());
    expect(consultAwaitingInputLatch(ws, ["rate", "engine"], ["rate.xlsx", "engine.ts"], "fp-2"))
      .toBeUndefined();
  });

  it("does NOT brick a different task — a non-overlapping epoch consult is a no-op that leaves the latch intact", () => {
    const ws = mkWs("w4-othertask");
    recordServedSurfaces(ws, ws, [{ path: "engine.ts", role: "api" }], ["rate", "engine"]);
    recordAwaitingInputLatch(ws, latch());
    // A different task (zero overlap) proceeds normally without consuming the latch.
    expect(consultAwaitingInputLatch(ws, ["login", "auth"], ["login.ts"], "fp-x")).toBeUndefined();
    // The original task's latch still holds.
    expect(consultAwaitingInputLatch(ws, ["rate"], ["rate.xlsx", "engine.ts"], "fp-1")?.unresolvedProof)
      .toBe("artifact-input");
  });

  it("explicit clear drops the latch; epoch flip drops it too", () => {
    const ws = mkWs("w4-clear");
    recordServedSurfaces(ws, ws, [{ path: "engine.ts", role: "api" }], ["rate", "engine"]);
    recordAwaitingInputLatch(ws, latch());
    clearAwaitingInputLatch(ws);
    expect(consultAwaitingInputLatch(ws, ["rate"], ["rate.xlsx", "engine.ts"], "fp-1")).toBeUndefined();
    // Re-latch, then flip the epoch — the latch must not survive into a new task.
    recordAwaitingInputLatch(ws, latch());
    recordServedSurfaces(ws, ws, [{ path: "x.ts", role: "api" }], ["unrelated", "task"]);
    expect(consultAwaitingInputLatch(ws, ["unrelated"], ["rate.xlsx"], "fp-1")).toBeUndefined();
  });
});

describe("packServeLog — W5 functional-validation obligation", () => {
  beforeEach(() => resetPackServeLogForTest());

  it("records / reads / clears, scoped to the task epoch", () => {
    const ws = mkWs("w5-oblig");
    recordServedSurfaces(ws, ws, [{ path: "engine.ts", role: "api" }], ["rate", "engine"]);
    recordFunctionalValidationObligation(ws, { note: "functionally validate", targetPath: "engine.ts" });
    expect(getFunctionalValidationObligation(ws, ["rate"])?.targetPath).toBe("engine.ts");
    // A non-overlapping task does not see it.
    expect(getFunctionalValidationObligation(ws, ["login"])).toBeUndefined();
    // A verification-evidence event clears it.
    clearFunctionalValidationObligation(ws);
    expect(getFunctionalValidationObligation(ws, ["rate"])).toBeUndefined();
  });

  it("is dropped when the task epoch flips", () => {
    const ws = mkWs("w5-epoch");
    recordServedSurfaces(ws, ws, [{ path: "engine.ts", role: "api" }], ["rate", "engine"]);
    recordFunctionalValidationObligation(ws, { note: "functionally validate", targetPath: "engine.ts" });
    recordServedSurfaces(ws, ws, [{ path: "x.ts", role: "api" }], ["unrelated", "task"]);
    expect(getFunctionalValidationObligation(ws, ["unrelated"])).toBeUndefined();
  });
});

// ===========================================================================
// buildTaskPack integration tests.
// ===========================================================================

function seedDedup(ws: string): void {
  write(ws, "src/shared/status.ts", "export const Status = { OPEN: 'open', CLOSED: 'closed' } as const;\n");
  write(ws, "src/api/routes.ts", "export function listByStatus(s: string) { return []; }\n");
  write(ws, "src/ui/widget.ts", "export function widget(s: string) { return s; }\n");
}

/** Two-package fixture whose 4 roles, all seeded in one call, yield coverage:"complete". */
function seedRoles(ws: string): void {
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
const ALL_ROLES = ["contract", "api", "ui", "style"];
const ALL_PATHS = [
  { path: "packages/model/src/types/status.ts" },
  { path: "packages/model/src/services/statusService.ts" },
  { path: "packages/web/src/StatusBadge.tsx" },
  { path: "packages/web/src/status.css" },
];

describe("buildTaskPack — W1: multi-slot re-call dedup (verbatim duplicate 1 call apart)", () => {
  beforeEach(() => {
    handleTable.reset();
    resetPackDedupeCache();
    resetPackServeLogForTest();
  });

  it("a verbatim duplicate separated by an INTERVENING different pack still returns a compact receipt", async () => {
    const ws = mkWs("w1-multislot");
    seedDedup(ws);
    const argsX = { query: "add STALLED to the status enum", paths: [{ path: "src/shared/status.ts" }] };

    const a = await buildTaskPack(argsX, ws);
    expect(a.pack_unchanged).toBeUndefined();
    if (a.surfaces.length === 0) return;

    // An intervening DIFFERENT pack — under the old single-slot cache this
    // overwrote the record and made the verbatim re-call (below) miss.
    const b = await buildTaskPack(
      { query: "rename listByStatus in the routes api", paths: [{ path: "src/api/routes.ts" }] },
      ws,
    );
    expect(b.pack_unchanged).toBeUndefined();

    // The verbatim duplicate of A, now one call later. Multi-slot → receipt.
    const c = await buildTaskPack(argsX, ws);
    expect(c.pack_unchanged).toBe(true);
    // A receipt names the resident handle without re-serving any body — an order
    // of magnitude under a full multi-KB pack (the iter-1 loss re-served ~20KB).
    expect(c.surfaces.every((s) => s.code === undefined)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(c), "utf8")).toBeLessThan(1600);
  }, 30000);

  it("a full workspace change (edited surfaced file) forces a fresh full serve, not a receipt", async () => {
    const ws = mkWs("w1-changed");
    seedDedup(ws);
    const argsX = { query: "add STALLED to the status enum", paths: [{ path: "src/shared/status.ts" }] };

    const a = await buildTaskPack(argsX, ws);
    expect(a.pack_unchanged).toBeUndefined();
    if (a.surfaces.length === 0) return;

    write(ws, "src/shared/status.ts", "export const Status = { OPEN: 'open', CLOSED: 'closed', STALLED: 'stalled' } as const;\n");
    const b = await buildTaskPack(argsX, ws);
    // The surfaced file changed → recompute, not a compact receipt.
    expect(b.pack_unchanged).toBeUndefined();
    expect(b.surfaces.some((s) => s.code !== undefined)).toBe(true);
  }, 30000);
});

describe("buildTaskPack — W2: complete means stop", () => {
  beforeEach(() => {
    handleTable.reset();
    resetPackDedupeCache();
    resetPackServeLogForTest();
  });

  it("a complete pack's route carries the explicit stop signal with budget 0", async () => {
    const ws = mkWs("w2-stop");
    seedRoles(ws);
    const res = await buildTaskPack(
      { query: "Status label rendering", surfaceRoles: ALL_ROLES, paths: ALL_PATHS },
      ws,
    );
    expect(res.coverage).toBe("complete");
    expect(res.route?.action).toBe("edit_from_handles");
    expect(res.route?.max_additional_tl_calls).toBe(0);
    expect(res.route?.reason).toContain("stop discovery");
    expect(res.route?.reason).toContain("resident handles");
  }, 30000);
});

describe("buildTaskPack — W3: frontier_index is never on a complete pack", () => {
  beforeEach(() => {
    handleTable.reset();
    resetPackDedupeCache();
    resetPackServeLogForTest();
  });

  it("a single-call complete pack carries no frontier_index (stop, not a re-search inventory)", async () => {
    const ws = mkWs("w3-nofrontier");
    seedRoles(ws);
    const res = await buildTaskPack(
      { query: "Status label rendering", surfaceRoles: ALL_ROLES, paths: ALL_PATHS },
      ws,
    );
    expect(res.coverage).toBe("complete");
    expect(res.frontier_index).toBeUndefined();
  }, 30000);
});

describe("buildTaskPack — W5: functional-validation obligation for an artifact-sourced runnable target", () => {
  beforeEach(() => {
    handleTable.reset();
    resetPackDedupeCache();
    resetRoleInventoryCache();
    resetPackServeLogForTest();
  });

  async function workbookBytes(sheetName: string): Promise<Buffer> {
    type Worksheet = { addRow(values: unknown[]): void };
    type Workbook = { addWorksheet(name: string): Worksheet; xlsx: { writeBuffer(): Promise<Buffer> } };
    const ExcelJSMod = (await import("exceljs")) as unknown as { Workbook: new () => Workbook };
    const workbook = new ExcelJSMod.Workbook();
    const data = workbook.addWorksheet(sheetName);
    data.addRow(["key", "rate"]);
    for (let i = 0; i < 3; i++) data.addRow([`item-${i}`, i + 0.25]);
    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  it("names a functional-validation verify obligation and records it in the session", async () => {
    const ws = mkWs("w5-artifact");
    write(ws, "src/ratingEngine.ts",
      "export function calculateRate(key: string): number {\n  void key;\n  return 0;\n}\n");
    fs.mkdirSync(path.join(ws, "docs"), { recursive: true });
    fs.writeFileSync(path.join(ws, "docs/rate-table.xlsx"), await workbookBytes("BaseRates"));

    const res = await buildTaskPack({
      query: "Implement calculateRate from the rate table XLSX using BaseRates.",
      paths: ["docs/rate-table.xlsx", "src/ratingEngine.ts"],
    }, ws);

    // Structural detection only: artifact_requirements present + a runnable
    // (.ts) edit target — no sheet/filename matching.
    expect(res.artifact_requirements).toContain("docs/rate-table.xlsx");
    // iter-3 F5b: softened wording names the cheapest sufficient proof.
    expect((res.verify ?? []).some((v) =>
      v.startsWith("validate the produced module the cheap way"))).toBe(true);
    // The obligation is recorded for the epoch so a self-check can list it OPEN.
    const query = "Implement calculateRate from the rate table XLSX using BaseRates.";
    const { getFunctionalValidationObligation: getOblig } = await import("../util/packServeLog.js");
    const { tokenizeForEpoch } = await import("../util/session.js");
    expect(getOblig(ws, tokenizeForEpoch(query))?.targetPath).toBe("src/ratingEngine.ts");
  }, 30000);
});
