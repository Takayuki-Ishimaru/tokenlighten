// ---------------------------------------------------------------------------
// V10-11 shadow mode -- TL_WIRE_SHADOW=1 measures every eligible codec
// candidate and logs {kind, json_bytes, codec_bytes, est_tokens, chosen} to
// the TL_TRACE channel, and NEVER alters emitted bytes. See
// protocol/codec/pipeline.ts's emitShadowTrace.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyResponseCodec } from "../protocol/codec/pipeline.js";
import { evaluateCandidates } from "../protocol/codec/policy.js";
import { getTracePath, setTraceEnabledForTest } from "../util/trace.js";
import type { ProtocolCallContext } from "../protocol/envelope.js";

const WS_ROOT = "/workspace/wire-codec-shadow-test";

let tmpHome: string;
let origHome: string | undefined;
const ENV_KEYS = ["TOKENLIGHTEN_RESPONSE_FORMAT", "TL_WIRE_SHADOW"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tl-wire-codec-shadow-test-"));
  process.env.HOME = tmpHome;
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  setTraceEnabledForTest(true);
});

afterEach(() => {
  if (origHome !== undefined) process.env.HOME = origHome;
  else delete process.env.HOME;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  setTraceEnabledForTest(false);
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function readTraceRecords(): Array<Record<string, unknown>> {
  const p = getTracePath(WS_ROOT);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function eligiblePayload(rows: number): Record<string, unknown> {
  const items = Array.from({ length: rows }, (_, i) => ({ path: `f${i}.ts`, line: i, symbol: `s${i}` }));
  return { v: 1, kind: "search.matches", matches: { form: "symbols", locations: items, total: rows } };
}

const CONTEXT: ProtocolCallContext = { tool: "search_files", workspace: WS_ROOT };

// ---------------------------------------------------------------------------
// Trace shape
// ---------------------------------------------------------------------------

describe("shadow mode -- trace record shape", () => {
  it("logs one wire_codec_shadow record per candidate, with exactly the documented fields", () => {
    process.env["TL_WIRE_SHADOW"] = "1";
    const payload = eligiblePayload(12);
    const jsonText = JSON.stringify(payload);

    applyResponseCodec(jsonText, payload, "search.matches", CONTEXT, 999999);

    const shadowRecords = readTraceRecords().filter((r) => r["event"] === "wire_codec_shadow");
    const candidates = evaluateCandidates("search.matches", payload);
    expect(shadowRecords.length).toBe(candidates.length);
    expect(candidates.length).toBeGreaterThan(0);

    for (const record of shadowRecords) {
      expect(typeof record["kind"]).toBe("string");
      expect(record["kind"]).toBe("search.matches");
      expect(typeof record["codec"]).toBe("string");
      expect(typeof record["json_bytes"]).toBe("number");
      expect(record["json_bytes"]).toBe(Buffer.byteLength(jsonText, "utf8"));
      expect(typeof record["codec_bytes"]).toBe("number");
      expect(typeof record["est_tokens"]).toBe("number");
      expect(typeof record["chosen"]).toBe("boolean");
      // No stray fields beyond {event, ts} + the five documented ones + the
      // V10-02 common envelope (util/trace.ts): trace_id/flags_active/
      // workspaceRef/protocol_era are always present; call_id/task_ref/route
      // are absent here because applyResponseCodec is invoked directly, not
      // through server.ts's callTool dispatch (no runWithTraceCall scope).
      expect(new Set(Object.keys(record))).toEqual(
        new Set([
          "event", "ts", "kind", "codec", "json_bytes", "codec_bytes", "est_tokens", "chosen",
          "trace_id", "flags_active", "workspaceRef", "protocol_era",
        ]),
      );
    }
  });

  it("marks exactly the selected codec chosen:true under mode=compact, all others chosen:false", () => {
    process.env["TOKENLIGHTEN_RESPONSE_FORMAT"] = "compact";
    process.env["TL_WIRE_SHADOW"] = "1";
    const payload = eligiblePayload(12);
    const jsonText = JSON.stringify(payload);

    const result = applyResponseCodec(jsonText, payload, "search.matches", CONTEXT, 999999);
    expect(result).not.toBe(jsonText); // compact mode with real gain actually swapped the wire text

    const shadowRecords = readTraceRecords().filter((r) => r["event"] === "wire_codec_shadow");
    const chosenRecords = shadowRecords.filter((r) => r["chosen"] === true);
    expect(chosenRecords.length).toBe(1);
    expect(shadowRecords.filter((r) => r["chosen"] === false).length).toBe(shadowRecords.length - 1);
  });

  it("marks every candidate chosen:false under mode=json (shadow observes but never wins)", () => {
    process.env["TL_WIRE_SHADOW"] = "1"; // TOKENLIGHTEN_RESPONSE_FORMAT left unset -> "json"
    const payload = eligiblePayload(12);
    const jsonText = JSON.stringify(payload);

    const result = applyResponseCodec(jsonText, payload, "search.matches", CONTEXT, 999999);
    expect(result).toBe(jsonText);

    const shadowRecords = readTraceRecords().filter((r) => r["event"] === "wire_codec_shadow");
    expect(shadowRecords.length).toBeGreaterThan(0);
    expect(shadowRecords.every((r) => r["chosen"] === false)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Shadow NEVER alters emitted bytes
// ---------------------------------------------------------------------------

describe("shadow mode -- never alters emitted bytes", () => {
  it("returns the input text byte-for-byte when format is unset (default json) and shadow is on", () => {
    process.env["TL_WIRE_SHADOW"] = "1";
    const payload = eligiblePayload(12);
    const jsonText = JSON.stringify(payload);
    const result = applyResponseCodec(jsonText, payload, "search.matches", CONTEXT, 999999);
    expect(result).toBe(jsonText);
  });

  it("returns the input text byte-for-byte under mode=debug regardless of gain", () => {
    process.env["TOKENLIGHTEN_RESPONSE_FORMAT"] = "debug";
    const payload = eligiblePayload(12);
    const jsonText = JSON.stringify(payload);
    const result = applyResponseCodec(jsonText, payload, "search.matches", CONTEXT, 999999);
    expect(result).toBe(jsonText);
    // debug still gathers the full comparison, independent of TL_WIRE_SHADOW.
    const shadowRecords = readTraceRecords().filter((r) => r["event"] === "wire_codec_shadow");
    expect(shadowRecords.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// TL_WIRE_SHADOW=0 (default) -- no side effects at all
// ---------------------------------------------------------------------------

describe("shadow mode -- off by default", () => {
  it("writes no trace file when TL_WIRE_SHADOW is unset and format is json", () => {
    const payload = eligiblePayload(12);
    const jsonText = JSON.stringify(payload);
    applyResponseCodec(jsonText, payload, "search.matches", CONTEXT, 999999);
    expect(fs.existsSync(getTracePath(WS_ROOT))).toBe(false);
  });
});
