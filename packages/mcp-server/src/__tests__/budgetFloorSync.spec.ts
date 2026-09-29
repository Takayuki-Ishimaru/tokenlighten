// budgetFloorSync.spec.ts — the read.batch refusal floor and the task-pack
// admission floor are declared in two modules (emit.ts cannot import from
// readCodeTaskPack.ts without inverting the dependency). A `read.batch`
// refusal's `next` is promoted to a task pack on resubmission, so a lower
// read.batch floor would advertise a `required_min_bytes` the task-pack gate
// then refuses again, with no `next` (the FX-U3 dead end fixed on 2026-09-22).
import { describe, expect, it } from "vitest";
import { READ_BATCH_TASK_PACK_PROMOTION_FLOOR_BYTES } from "../protocol/emit.js";
import { REQUIRED_MIN_TASK_PACK_BYTES } from "../features/task-pack/readCodeTaskPack.js";

describe("budget floors stay in sync", () => {
  it("the read.batch promotion floor equals the task-pack admission floor", () => {
    expect(READ_BATCH_TASK_PACK_PROMOTION_FLOOR_BYTES).toBe(REQUIRED_MIN_TASK_PACK_BYTES);
  });
});
