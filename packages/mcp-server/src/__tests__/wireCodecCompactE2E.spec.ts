// ---------------------------------------------------------------------------
// V10-11 env=compact end-to-end -- the in-process callTool idiom
// (server.ts's exported `callTool`, the same one every __tests__/*.spec.ts
// E2E case uses) against a REAL search_files action=find call over a >=10
// matched-file fixture, comparing the default (json) response to the
// TOKENLIGHTEN_RESPONSE_FORMAT=compact response: decode-equality against the
// json baseline, plus the measured byte reduction.
// ---------------------------------------------------------------------------

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { callTool } from "../server.js";
import { handleTable } from "../util/handles.js";
import { resetAll as resetAllSessions } from "../util/session.js";
import { resetPackDedupeCache, resetRoleInventoryCache } from "../tools/readCodeTaskPack.js";
import { resetRootResolverCache, setActiveRootWorkspace } from "../tools/locateTaskContext.js";
import { NON_JSON_CANDIDATES } from "../protocol/codec/registry.js";
import { canonicalEqual } from "../protocol/codec/types.js";

const NEEDLE = "TlWireCodecCompactE2eNeedle";
const FILE_COUNT = 12;

const created: string[] = [];
function tempWorkspace(prefix: string): string {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), prefix)));
  created.push(ws);
  return ws;
}

let workspace = "";

beforeAll(() => {
  workspace = tempWorkspace(".tl-wire-codec-e2e-");
  for (let i = 0; i < FILE_COUNT; i++) {
    const content = [
      `// fixture file ${i}`,
      `export function handler${i}(): number {`,
      `  const ${NEEDLE}_${i} = ${i}; // ${NEEDLE} marker`,
      `  return ${NEEDLE}_${i};`,
      `}`,
      "",
    ].join("\n");
    fs.writeFileSync(path.join(workspace, `fixture${i}.ts`), content, "utf8");
  }
});

afterAll(() => {
  for (const ws of created) fs.rmSync(ws, { recursive: true, force: true });
});

function resetServerState(): void {
  handleTable.reset();
  resetAllSessions();
  resetPackDedupeCache();
  resetRoleInventoryCache();
  resetRootResolverCache();
  setActiveRootWorkspace(workspace);
}

beforeEach(() => {
  resetServerState();
  delete process.env["TOKENLIGHTEN_RESPONSE_FORMAT"];
});

afterEach(() => {
  delete process.env["TOKENLIGHTEN_RESPONSE_FORMAT"];
});

/** Decode compact wire text back to a payload, trying json first (the
 *  identity codec) and then every registered non-json candidate -- exactly
 *  the "try each codec's own decode" a real diagnostic tool would do; the
 *  wire formats' magic prefixes make this unambiguous in practice. */
function decodeWireText(text: string): { payload: Record<string, unknown>; codecId: string } {
  try {
    return { payload: JSON.parse(text) as Record<string, unknown>, codecId: "json" };
  } catch {
    // not json -- fall through
  }
  for (const codec of NON_JSON_CANDIDATES) {
    try {
      return { payload: codec.decode(text), codecId: `${codec.id}/${codec.version}` };
    } catch {
      continue;
    }
  }
  throw new Error(`decodeWireText: no registered codec could decode this text (first 40 chars: ${JSON.stringify(text.slice(0, 40))})`);
}

describe("V10-11 env=compact -- E2E via callTool", () => {
  it("decodes back to the json baseline and measurably reduces wire bytes for a >=10-row search.matches result", async () => {
    delete process.env["TOKENLIGHTEN_RESPONSE_FORMAT"];
    const baseline = await callTool("search_files", { action: "find", query: NEEDLE, cwd: workspace });
    const baselineFirst = baseline.content[0];
    expect(baselineFirst?.type).toBe("text");
    const baselineText = baselineFirst!.text;
    const baselinePayload = JSON.parse(baselineText) as Record<string, unknown>;

    expect(baselinePayload["kind"]).toBe("search.matches");
    const matches = baselinePayload["matches"] as { files?: unknown[] } | undefined;
    expect(Array.isArray(matches?.files)).toBe(true);
    expect((matches!.files as unknown[]).length).toBeGreaterThanOrEqual(10);

    resetServerState(); // an independent call must not carry the first call's "repeated single-token find" session memory
    process.env["TOKENLIGHTEN_RESPONSE_FORMAT"] = "compact";
    const compact = await callTool("search_files", { action: "find", query: NEEDLE, cwd: workspace });
    const compactFirst = compact.content[0];
    expect(compactFirst?.type).toBe("text");
    const compactText = compactFirst!.text;

    const { payload: decoded, codecId } = decodeWireText(compactText);
    expect(canonicalEqual(decoded, baselinePayload)).toBe(true);

    const baselineBytes = Buffer.byteLength(baselineText, "utf8");
    const compactBytes = Buffer.byteLength(compactText, "utf8");
    const absoluteGain = baselineBytes - compactBytes;
    const relativeGainPct = (absoluteGain / baselineBytes) * 100;

    // eslint-disable-next-line no-console -- deliberately surfaced for the workstream report.
    console.log(
      `[V10-11 env=compact E2E] rows=${(matches!.files as unknown[]).length} codec=${codecId} `
      + `json_bytes=${baselineBytes} compact_bytes=${compactBytes} `
      + `absolute_gain=${absoluteGain} relative_gain=${relativeGainPct.toFixed(1)}%`,
    );

    expect(codecId).not.toBe("json"); // this fixture must actually exercise a non-json codec
    expect(compactBytes).toBeLessThan(baselineBytes);
    expect(absoluteGain).toBeGreaterThan(0);
  });

  it("default (no env set) is byte-identical to explicit TOKENLIGHTEN_RESPONSE_FORMAT=json", async () => {
    delete process.env["TOKENLIGHTEN_RESPONSE_FORMAT"];
    const implicitDefault = await callTool("search_files", { action: "find", query: NEEDLE, cwd: workspace });

    resetServerState();
    process.env["TOKENLIGHTEN_RESPONSE_FORMAT"] = "json";
    const explicitJson = await callTool("search_files", { action: "find", query: NEEDLE, cwd: workspace });

    expect(explicitJson.content[0]!.text).toBe(implicitDefault.content[0]!.text);
  });
});
