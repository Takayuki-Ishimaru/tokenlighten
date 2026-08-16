import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildTaskPack } from "../tools/readCodeTaskPack.js";

const workspaces: string[] = [];
const ORIGINAL_GENERIC_TEXT_DISCOVERY = process.env["TL_GENERIC_TEXT_DISCOVERY"];

function workspace(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tl-generic-task-pack-${tag}-`));
  workspaces.push(dir);
  return dir;
}

function writeText(root: string, relPath: string, body: string): void {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, "utf8");
}

beforeEach(() => {
  process.env["TL_GENERIC_TEXT_DISCOVERY"] = "1";
});

afterEach(() => {
  if (ORIGINAL_GENERIC_TEXT_DISCOVERY === undefined) {
    delete process.env["TL_GENERIC_TEXT_DISCOVERY"];
  } else {
    process.env["TL_GENERIC_TEXT_DISCOVERY"] = ORIGINAL_GENERIC_TEXT_DISCOVERY;
  }
  for (const dir of workspaces.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("task_pack generic-text fallback", () => {
  it("serves an unknown-extension hit with body and handle in the original call", async () => {
    const ws = workspace("unknown");
    writeText(
      ws,
      "config/runtime.policyx",
      "opaqueGenericNeedle = enabled\nThis line explains the runtime policy.\n",
    );

    const result = await buildTaskPack(
      {
        query: "opaqueGenericNeedle",
        taskProfile: "generic",
      },
      ws,
    );

    const surface = result.surfaces.find((candidate) => candidate.path === "config/runtime.policyx");
    expect(surface, JSON.stringify(result, null, 2)).toBeDefined();
    expect(surface?.handle).toEqual(expect.any(String));
    expect(String(surface?.code ?? "")).toContain("opaqueGenericNeedle");

    const nextCall = result.execution_contract?.next_call;
    expect(
      nextCall?.tool === "read_file"
        && nextCall.arguments?.["mode"] === "task_pack"
        && nextCall.arguments?.["query"] === "opaqueGenericNeedle",
    ).toBe(false);
  }, 30000);

  it("serves an explicitly scoped extensionless text file without requiring a body token", async () => {
    const ws = workspace("extensionless");
    writeText(ws, "config/runtimepolicy", "policy_mode = cautious\n");

    const result = await buildTaskPack(
      {
        path: "config/runtimepolicy",
        query: "inspect the requested runtime policy file",
        taskProfile: "generic",
      },
      ws,
    );

    const surface = result.surfaces.find((candidate) => candidate.path === "config/runtimepolicy");
    expect(surface, JSON.stringify(result, null, 2)).toBeDefined();
    expect(String(surface?.code ?? "")).toContain("policy_mode");
    expect(surface?.handle).toEqual(expect.any(String));
  }, 30000);

  it("does not run the generic lane when the semantic locator already resolved a supported file", async () => {
    const ws = workspace("known-with-decoy");
    writeText(ws, "src/owner.ts", "export const knownSemanticNeedle = 1;\n");
    writeText(ws, "notes.decoyext", "knownSemanticNeedle appears only as decoy prose\n");

    const result = await buildTaskPack(
      {
        query: "Trace the knownSemanticNeedle implementation",
        taskProfile: "generic",
      },
      ws,
    );

    expect(result.surfaces.some((surface) => surface.path === "src/owner.ts")).toBe(true);
    expect(result.surfaces.some((surface) => surface.path === "notes.decoyext")).toBe(false);
  }, 30000);

  it("preserves the legacy no-surface route when the feature flag is disabled", async () => {
    process.env["TL_GENERIC_TEXT_DISCOVERY"] = "0";
    const ws = workspace("disabled");
    writeText(ws, "notes.disabledext", "opaqueDisabledNeedle = true\n");

    const result = await buildTaskPack(
      {
        query: "Trace opaqueDisabledNeedle",
        taskProfile: "generic",
      },
      ws,
    );

    expect(result.surfaces.some((surface) => surface.path === "notes.disabledext")).toBe(false);
    expect(result.next ?? "").toContain("search_files action=locate");
  }, 30000);
});
