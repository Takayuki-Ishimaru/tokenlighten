import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { OPERATION_CAP, resetStateStoresForTests, stateStoreFor } from "../state/stateStore.js";

const workspaces: string[] = [];

afterEach(() => {
  resetStateStoresForTests();
  for (const workspace of workspaces.splice(0)) {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

describe("operation replay table capacity", () => {
  it("keeps a 256-operation effective window across v2 dual-write entries", () => {
    expect(OPERATION_CAP).toBe(512);
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tl-operation-cap-"));
    workspaces.push(workspace);
    const store = stateStoreFor(workspace);
    expect(store?.available).toBe(true);
    // These are the exact legacy/v2 key families used by the edit
    // operation_id wrapper; one logical operation consumes two bounded entries.
    for (let i = 0; i < 256; i += 1) {
      store?.rememberOperation(`op:logical-${i}`, `value-${i}`);
      store?.rememberOperation(`opv2:logical-${i}`, `value-${i}`);
    }
    expect(store?.lookupOperation("op:logical-0")).toBeDefined();
    store?.rememberOperation("op:logical-overflow", "value-overflow");
    expect(store?.lookupOperation("op:logical-0")).toBeUndefined();
    expect(store?.lookupOperation("opv2:logical-255")).toBeDefined();
  });
});
