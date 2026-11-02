// ---------------------------------------------------------------------------
// B5 -- one spelling per semantic payload, through the real pipeline.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyResponseCodec, resetV2CacheForTest } from "../protocol/codec/pipeline.js";
import { canonicalKeyOrder, noteReplyRepeat, resetReplyRepeatsForTest } from "../protocol/codec/stableSerialization.js";
import { getTracePath, setTraceEnabledForTest } from "../util/trace.js";
import type { ProtocolCallContext } from "../protocol/envelope.js";

const WS = "/workspace/wire-stable-test";
const CONTEXT: ProtocolCallContext = { tool: "tl_search_files", workspace: WS };
const KEYS = ["TL_WIRE_STABLE", "TOKENLIGHTEN_RESPONSE_FORMAT", "TL_WIRE_BREAKEVEN", "TL_WIRE_SHADOW"] as const;
let saved: Record<string, string | undefined>;
let home: string;
let priorHome: string | undefined;

beforeEach(() => {
  saved = {};
  for (const key of KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
  priorHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "tl-wire-stable-"));
  process.env.HOME = home;
  resetReplyRepeatsForTest();
  resetV2CacheForTest();
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (priorHome !== undefined) process.env.HOME = priorHome;
  else delete process.env.HOME;
  setTraceEnabledForTest(false);
  fs.rmSync(home, { recursive: true, force: true });
});

const A = { kind: "search.matches", v: 1, matches: { total: 2, form: "symbols", locations: [{ z: 1, a: 2 }, { a: 3, z: 4 }] } };
const B = { v: 1, matches: { locations: [{ a: 2, z: 1 }, { z: 4, a: 3 }], form: "symbols", total: 2 }, kind: "search.matches" };

describe("canonicalKeyOrder", () => {
  it("spells v and kind first, then sorted keys, at every depth, and keeps array order", () => {
    expect(JSON.stringify(canonicalKeyOrder(A))).toBe(
      '{"v":1,"kind":"search.matches","matches":{"form":"symbols","kind":undefined,"locations":[{"a":2,"z":1},{"a":3,"z":4}],"total":2}}'.replace('"kind":undefined,', ""),
    );
    expect(canonicalKeyOrder([3, 1, 2])).toEqual([3, 1, 2]);
  });

  it("leaves values alone: 0, null, false, empty, numbers and bodies", () => {
    const value = { b: 0, a: null, d: false, c: "", e: 1.5, f: "  body\n\twith \"quotes\"  " };
    const out = canonicalKeyOrder(value);
    expect(out).toEqual(value);
    expect(Buffer.byteLength(JSON.stringify(out))).toBe(Buffer.byteLength(JSON.stringify(value)));
  });
});

describe("canonicalKeyOrder and odd keys", () => {
  it("keeps an own __proto__ key as the ordinary key it is", () => {
    const parsed = JSON.parse('{"v":1,"kind":"x","b":1,"__proto__":{"p":1},"a":2}') as Record<string, unknown>;
    expect(JSON.stringify(canonicalKeyOrder(parsed))).toBe('{"v":1,"kind":"x","__proto__":{"p":1},"a":2,"b":1}');
  });
});

describe("the pipeline under TL_WIRE_STABLE", () => {
  it("off: the text is returned untouched", () => {
    const text = JSON.stringify(A);
    expect(applyResponseCodec(text, A, "search.matches", CONTEXT, 999_999)).toBe(text);
  });

  it("on: two spellings of one payload become one, at the same size", () => {
    process.env["TL_WIRE_STABLE"] = "1";
    const a = applyResponseCodec(JSON.stringify(A), A, "search.matches", CONTEXT, 999_999);
    const b = applyResponseCodec(JSON.stringify(B), B, "search.matches", CONTEXT, 999_999);
    expect(a).toBe(b);
    expect(a.length).toBe(JSON.stringify(A).length);
    expect(JSON.parse(a)).toEqual(A);
    expect(a.startsWith('{"v":1,"kind":"search.matches"')).toBe(true);
  });

  it("a real change to the payload still shows", () => {
    process.env["TL_WIRE_STABLE"] = "1";
    const changed = { ...B, matches: { ...B.matches, total: 3 } };
    expect(applyResponseCodec(JSON.stringify(A), A, "search.matches", CONTEXT, 999_999))
      .not.toBe(applyResponseCodec(JSON.stringify(changed), changed, "search.matches", CONTEXT, 999_999));
  });

  it("a codec's text is stable too, because the codec sees the same order", () => {
    process.env["TL_WIRE_STABLE"] = "1";
    process.env["TOKENLIGHTEN_RESPONSE_FORMAT"] = "compact";
    const rows = Array.from({ length: 20 }, (_, i) => ({ path: `src/f${i}.ts`, line: i, symbol: `s${i}` }));
    const first = { v: 1, kind: "search.matches", matches: { form: "symbols", locations: rows, total: 20 } };
    const second = { matches: { total: 20, locations: rows.map((r) => ({ symbol: r.symbol, line: r.line, path: r.path })), form: "symbols" }, kind: "search.matches", v: 1 };
    expect(applyResponseCodec(JSON.stringify(first), first, "search.matches", CONTEXT, 999_999))
      .toBe(applyResponseCodec(JSON.stringify(second), second, "search.matches", CONTEXT, 999_999));
  });

  it("records repeats as numbers and flags, never text or a digest", () => {
    process.env["TL_WIRE_STABLE"] = "1";
    setTraceEnabledForTest(true);
    applyResponseCodec(JSON.stringify(A), A, "search.matches", CONTEXT, 999_999);
    applyResponseCodec(JSON.stringify(B), B, "search.matches", CONTEXT, 999_999);
    const records = fs.readFileSync(getTracePath(WS), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record["event"] === "wire_stability");
    expect(records.map((record) => record["repeat_of_prior"])).toEqual([false, true]);
    expect(records.map((record) => record["key_order_changed"])).toEqual([true, true]);
    const flat = JSON.stringify(records);
    expect(flat).not.toContain("symbols");
    expect(Object.keys(records[0]!)).not.toContain("digest");
  });
});

describe("noteReplyRepeat", () => {
  it("remembers within a bound, and forgets beyond it", () => {
    expect(noteReplyRepeat("x")).toBe(false);
    expect(noteReplyRepeat("x")).toBe(true);
    for (let i = 0; i < 80; i += 1) noteReplyRepeat(`other ${i}`);
    expect(noteReplyRepeat("x")).toBe(false);
  });
});
