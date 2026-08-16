/**
 * completionCheckDynamicConsumers.spec.ts — IMPROVEMENT C: completion checks
 * must not demand enum-member literals in files that consume the enum ONLY via
 * dynamic derivation (Object.values(E)/nativeEnum(E)/Record<E,...>).
 *
 * Layers: pure-helper unit tests (dynamicDerivationOf / dynamicEnumConsumerVerdict)
 * plus an integration check that a dynamic-consumer surface gets an
 * informational record instead of a false "member present in file" gate, while
 * a static enumerator keeps its literal obligation.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildTaskPack,
  dynamicDerivationOf,
  dynamicEnumConsumerVerdict,
  enumSubjectSymbols,
} from "../tools/readCodeTaskPack.js";
import { handleTable } from "../util/handles.js";
import { getPackChecks, resetAll } from "../util/session.js";
import { resetPackServeLogForTest } from "../util/packServeLog.js";

function mkWs(tag: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `tl-dynconsumer-${tag}-`)));
}
function write(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

describe("IMPROVEMENT C — dynamicDerivationOf (pure)", () => {
  it("matches every documented dynamic-derivation form for the subject symbol", () => {
    expect(dynamicDerivationOf(`const xs = Object.values(Status);`, "Status")).toBe(true);
    expect(dynamicDerivationOf(`Object.keys(Status).forEach(k => k);`, "Status")).toBe(true);
    expect(dynamicDerivationOf(`const s = z.nativeEnum(Status);`, "Status")).toBe(true);
    expect(dynamicDerivationOf(`type M = Record<Status, string>;`, "Status")).toBe(true);
    expect(dynamicDerivationOf(`type K = keyof typeof Status;`, "Status")).toBe(true);
    expect(dynamicDerivationOf(`const v = Status[key];`, "Status")).toBe(true);
    // Python
    expect(dynamicDerivationOf(`for member in Status:\n    print(member)`, "Status")).toBe(true);
    expect(dynamicDerivationOf(`names = Status.__members__`, "Status")).toBe(true);
    expect(dynamicDerivationOf(`n = len(Status)`, "Status")).toBe(true);
  });

  it("does NOT match an array-type annotation or an unrelated symbol", () => {
    // `Status[]` (array type) must not be read as indexed access.
    expect(dynamicDerivationOf(`function f(xs: Status[]) {}`, "Status")).toBe(false);
    // A static member access is not dynamic derivation.
    expect(dynamicDerivationOf(`return Status.OPEN;`, "Status")).toBe(false);
    // Different symbol.
    expect(dynamicDerivationOf(`Object.values(Priority);`, "Status")).toBe(false);
  });
});

describe("IMPROVEMENT C — dynamicEnumConsumerVerdict (pure)", () => {
  const members = new Set(["open", "closed", "inprogress"]);

  it("suppresses on dynamic evidence with NO static enumeration evidence", () => {
    const v = dynamicEnumConsumerVerdict(`export const all = Object.values(Status);`, ["Status"], members);
    expect(v.suppress).toBe(true);
    expect(v.symbol).toBe("Status");
  });

  it("does NOT suppress when the file statically enumerates >=2 other members", () => {
    const body = `switch (s) { case Status.OPEN: return 1; case Status.CLOSED: return 2; }\n` +
      `const map = Object.values(Status);`;
    const v = dynamicEnumConsumerVerdict(body, ["Status"], members);
    expect(v.suppress).toBe(false);
  });

  it("does NOT suppress when the enum type cannot be named", () => {
    expect(dynamicEnumConsumerVerdict(`Object.values(Status);`, [], members).suppress).toBe(false);
  });

  it("enumSubjectSymbols picks PascalCase types, not ALL-CAPS members", () => {
    const syms = enumSubjectSymbols("add ARCHIVED to the Status enum", []);
    expect(syms).toContain("Status");
    expect(syms).not.toContain("ARCHIVED");
  });
});

describe("IMPROVEMENT C — integration: dynamic consumer gets an informational record", () => {
  beforeEach(() => {
    handleTable.reset();
    resetAll();
    resetPackServeLogForTest();
  });

  it("suppresses the literal obligation for a dynamic consumer, keeps it for a static enumerator", async () => {
    const ws = mkWs("integration");
    write(ws, "package.json", JSON.stringify({ name: "app" }));
    write(ws, "src/types/status.ts",
      `export enum Status { OPEN = "OPEN", CLOSED = "CLOSED", IN_PROGRESS = "IN_PROGRESS" }\n`);
    // Static enumerator: a switch over >=2 existing members.
    write(ws, "src/services/statusService.ts",
      `import { Status } from "../types/status";\n` +
      `export function label(s: Status) {\n` +
      `  switch (s) { case Status.OPEN: return "o"; case Status.CLOSED: return "c"; case Status.IN_PROGRESS: return "p"; }\n` +
      `}\n`);
    // Dynamic consumer: derives the members via Object.values — no literal edit needed.
    write(ws, "src/services/statusRegistry.ts",
      `import { Status } from "../types/status";\n` +
      `export const allStatuses = Object.values(Status);\n` +
      `export const count = Object.keys(Status).length;\n`);

    await buildTaskPack(
      {
        query: "add ARCHIVED to the Status enum",
        surfaceRoles: ["contract", "api"],
        paths: [
          { path: "src/types/status.ts" },
          { path: "src/services/statusService.ts" },
          { path: "src/services/statusRegistry.ts" },
        ],
      },
      ws,
    );

    const records = getPackChecks(ws)?.checks ?? [];
    // The static enumerator keeps its machine-verifiable "ARCHIVED present" gate.
    const staticCheck = records.find((r) =>
      r.glob === "src/services/statusService.ts" && r.token !== undefined);
    expect(staticCheck).toBeDefined();
    expect(staticCheck!.token).toBe("ARCHIVED");

    // The dynamic consumer has NO machine-verifiable literal gate...
    const dynamicVerifiable = records.find((r) =>
      r.glob === "src/services/statusRegistry.ts" && r.token !== undefined);
    expect(dynamicVerifiable).toBeUndefined();
    // ...and instead carries an informational (advisory, token-less) record.
    const informational = records.find((r) =>
      r.desc.includes("statusRegistry.ts") && /derives from Status dynamically/.test(r.desc));
    expect(informational).toBeDefined();
    expect(informational!.token).toBeUndefined();
  }, 30000);
});
