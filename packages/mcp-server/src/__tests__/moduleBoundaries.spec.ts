import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  toolError as serverToolError,
  toolOk as serverToolOk,
  toolStructuredError as serverToolStructuredError,
} from "../server.js";
import {
  toolError,
  toolOk,
  toolStructuredError,
} from "../protocol/result.js";
import { PER_TASK_FULL_CAP as governorPerTaskFullCap } from "../util/fullGovernor.js";
import { PER_TASK_FULL_CAP } from "../shared/readLimits.js";
import { findText as legacyFindText } from "../tools/findText.js";
import { findText } from "../features/search/find/findText.js";
import { locateTaskContext as legacyLocateTaskContext } from "../tools/locateTaskContext.js";
import { locateTaskContext } from "../features/locator/locateTaskContext.js";
import { buildTaskPack as legacyBuildTaskPack } from "../tools/readCodeTaskPack.js";
import { buildTaskPack } from "../features/task-pack/readCodeTaskPack.js";
import { resetAll as legacyResetAll } from "../util/session.js";
import { resetAll } from "../state/session.js";
import * as legacyFindTextModule from "../tools/findText.js";
import * as findTextModule from "../features/search/find/findText.js";
import * as legacyLocatorModule from "../tools/locateTaskContext.js";
import * as locatorModule from "../features/locator/locateTaskContext.js";
import * as legacyTaskPackModule from "../tools/readCodeTaskPack.js";
import * as taskPackModule from "../features/task-pack/readCodeTaskPack.js";
import * as legacySessionModule from "../util/session.js";
import * as sessionModule from "../state/session.js";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));

function productionSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "__tests__") return [];
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) return productionSources(absolute);
    return entry.isFile() && entry.name.endsWith(".ts") ? [absolute] : [];
  });
}

function expectSameModuleFacade(
  legacy: Record<string, unknown>,
  canonical: Record<string, unknown>,
): void {
  expect(Object.keys(legacy).sort()).toEqual(Object.keys(canonical).sort());
  for (const key of Object.keys(canonical)) {
    expect(legacy[key], key).toBe(canonical[key]);
  }
}

describe("module boundary compatibility", () => {
  it("keeps the historical server result-helper exports as the same bindings", () => {
    expect(serverToolError).toBe(toolError);
    expect(serverToolOk).toBe(toolOk);
    expect(serverToolStructuredError).toBe(toolStructuredError);
  });

  it("keeps exact success and simple-error wire shapes", () => {
    expect(toolOk({ value: 1 })).toEqual({
      content: [{ type: "text", text: "{\"value\":1}" }],
    });
    // 2026-07-30 refusal-economy pass: a bare toolError with no path/handle
    // recovery hint still must not reach the wire as a zero-content dead end
    // (W2) — toolStructuredError routes every ok:false payload through
    // supplyRefusalGuidance, which derives the generic task_pack fallback.
    expect(toolError("boom")).toEqual({
      content: [{
        type: "text",
        text: "{\"ok\":false,\"error\":\"boom\",\"alternatives\":[{\"mode\":\"task_pack\"}],\"next\":\"read_file mode=task_pack query=\\\"<restate the request verbatim>\\\"\"}",
      }],
      isError: true,
    });
    expect(toolStructuredError({ code: "structured" })).toEqual({
      content: [{ type: "text", text: "{\"code\":\"structured\"}" }],
      isError: true,
    });
  });

  it("keeps the historical governor limit export and value", () => {
    expect(governorPerTaskFullCap).toBe(PER_TASK_FULL_CAP);
    expect(PER_TASK_FULL_CAP).toBe(6);
  });

  it("keeps relocated feature and state modules available through compatibility facades", () => {
    expect(legacyFindText).toBe(findText);
    expect(legacyLocateTaskContext).toBe(locateTaskContext);
    expect(legacyBuildTaskPack).toBe(buildTaskPack);
    expect(legacyResetAll).toBe(resetAll);
  });

  it("keeps every runtime export on each compatibility facade", () => {
    expectSameModuleFacade(legacyFindTextModule, findTextModule);
    expectSameModuleFacade(legacyLocatorModule, locatorModule);
    expectSameModuleFacade(legacyTaskPackModule, taskPackModule);
    expectSameModuleFacade(legacySessionModule, sessionModule);
  });

  it("keeps production imports on canonical feature and state paths", () => {
    const forbidden = [
      "tools/findText.js",
      "tools/locateTaskContext.js",
      "tools/readCodeTaskPack.js",
      "util/session.js",
    ];
    const violations = productionSources(sourceRoot).flatMap((file) => {
      const source = readFileSync(file, "utf8");
      const matches = forbidden.filter((token) => source.includes(token));
      if (relative(sourceRoot, file).startsWith("util/") && source.includes('from "./session.js"')) {
        matches.push('from "./session.js"');
      }
      return matches.map((token) => `${relative(sourceRoot, file)} -> ${token}`);
    });

    expect(violations).toEqual([]);
  });
});
