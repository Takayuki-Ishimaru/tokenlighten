// relatedLookups.spec.ts — S9 (2026-08-07 native-IO-escape wave): coverage
// for the `related_lookups` decision-point steering attached to
// action=find's exact single-identifier literal hit — see
// packages/mcp-server/src/features/search/find/relatedLookups.ts for the
// implementation and its own doc comment for the full evidence/scope.
//
// Coverage:
//   - maybeAttachRelatedLookups (pure, synthetic FindResponse objects): each
//     gate in isolation — identifier query with hits attaches; absence,
//     empty files, regex, a Pass 1.5/Pass 2 non-exact-literal match
//     (literal!==true), and a non-identifier-shaped (phrase/multi-word or
//     punctuated) query all abstain; the attachment is dropped (not
//     force-fitted) when it would cross the response's own byte cap, and
//     that cap is MAX_INVENTORY_RESPONSE_BYTES rather than MAX_RESPONSE_BYTES
//     once the response itself carries an inventory[].
//   - action=find integration (real buildFindResponse()): the same
//     hit/absence/multi-word behavior through the actual Pass 1/1.5/2
//     ladder, plus a real measured byte size for the attached field.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildFindResponse,
  MAX_RESPONSE_BYTES,
  MAX_INVENTORY_RESPONSE_BYTES,
  type FindResponse,
} from "../features/search/find/findText.js";
import { maybeAttachRelatedLookups } from "../features/search/find/relatedLookups.js";
import { maybeAttachMemberSweepToFindResponse } from "../features/search/find/memberSweep.js";

const tmpDirs: string[] = [];

function mkWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-relatedlookups-test-"));
  tmpDirs.push(dir);
  return dir;
}

function writeFile(workspace: string, rel: string, content: string): void {
  const abs = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

/** Minimal, valid single-hit FindResponse — every test below starts from this and overrides just what it's testing. */
function baseHitResponse(query: string): FindResponse {
  return {
    query,
    files: [{ path: "src/Widget.ts", lines: [1] }],
    total_files: 1,
    total_matches: 1,
    truncated: false,
    literal: true,
  };
}

// ---------------------------------------------------------------------------
// maybeAttachRelatedLookups — pure gate behavior (synthetic responses)
// ---------------------------------------------------------------------------

describe("maybeAttachRelatedLookups — gate behavior", () => {
  it("attaches definition+callers for an identifier query with literal:true and >=1 file", () => {
    const raw = baseHitResponse("computeWidgetPriceRl");

    const result = maybeAttachRelatedLookups(raw, { query: "computeWidgetPriceRl", isRegex: false });

    expect(result.related_lookups).toBeDefined();
    expect(result.related_lookups?.definition).toEqual({
      tool: "search_files",
      arguments: { action: "symbols", query: "computeWidgetPriceRl" },
    });
    expect(result.related_lookups?.callers).toEqual({
      tool: "search_files",
      arguments: { action: "references", query: "computeWidgetPriceRl" },
    });
  });

  it("does not attach when the response carries an absence certificate (0-match)", () => {
    const raw: FindResponse = {
      ...baseHitResponse("totallyAbsentToken"),
      files: [],
      total_files: 0,
      total_matches: 0,
      absence: { scanned_files: 3, tokens: ["totallyAbsentToken"], conclusion: "no scanned file references this token" },
    };

    const result = maybeAttachRelatedLookups(raw, { query: "totallyAbsentToken", isRegex: false });

    expect(result.related_lookups).toBeUndefined();
    expect(result).toBe(raw); // unchanged — same object, not force-attached.
  });

  it("does not attach when the response has no matched files (and no absence certificate either)", () => {
    const raw: FindResponse = { ...baseHitResponse("x"), files: [], total_files: 0, total_matches: 0 };

    const result = maybeAttachRelatedLookups(raw, { query: "x", isRegex: false });

    expect(result.related_lookups).toBeUndefined();
  });

  it("does not attach for a regex query, even one that happens to spell a bare identifier", () => {
    const raw = baseHitResponse("computeWidgetPriceRl");

    const result = maybeAttachRelatedLookups(raw, { query: "computeWidgetPriceRl", isRegex: true });

    expect(result.related_lookups).toBeUndefined();
  });

  it("does not attach on a Pass 1.5 naming-variant match (literal:false, matched_variant set)", () => {
    // findViaIdentifierVariants' shape: the ORIGINAL query missed literally,
    // a naming variant hit instead — the matched bytes are no longer the
    // caller's own query string, so a definition/callers lookup FOR that
    // exact string would not be the precise call this feature promises.
    const raw: FindResponse = { ...baseHitResponse("badgePriorityUrgent"), literal: false, matched_variant: "badge--priority-urgent" };

    const result = maybeAttachRelatedLookups(raw, { query: "badgePriorityUrgent", isRegex: false });

    expect(result.related_lookups).toBeUndefined();
  });

  it("does not attach on a Pass 2 tokenized AND/OR fallback (literal:false, matched_terms set)", () => {
    const raw: FindResponse = { ...baseHitResponse("alpha beta"), literal: false, matched_terms: ["alpha", "beta"] };

    const result = maybeAttachRelatedLookups(raw, { query: "alpha beta", isRegex: false });

    expect(result.related_lookups).toBeUndefined();
  });

  it("does not attach for a phrase/multi-word query, even with literal:true and files present", () => {
    // Isolates the identifier-shape gate specifically: a query with a space
    // is never "one identifier" regardless of which pass produced the hit.
    const raw = baseHitResponse("alpha beta");

    const result = maybeAttachRelatedLookups(raw, { query: "alpha beta", isRegex: false });

    expect(result.related_lookups).toBeUndefined();
  });

  it("does not attach for a punctuated, non-identifier query (e.g. a CSS custom property)", () => {
    const raw = baseHitResponse("--color-priority-urgent");

    const result = maybeAttachRelatedLookups(raw, { query: "--color-priority-urgent", isRegex: false });

    expect(result.related_lookups).toBeUndefined();
  });

  it("drops the attachment when it would push an already-near-cap response over MAX_RESPONSE_BYTES", () => {
    const base = baseHitResponse("computeWidgetPriceRl");
    const baseBytes = Buffer.byteLength(JSON.stringify(base), "utf8");
    // Pad to leave less headroom than related_lookups needs (~150-220B for
    // this query length) — 20B of slack is not enough room.
    const filler = "x".repeat(Math.max(0, MAX_RESPONSE_BYTES - baseBytes - 20));
    const padded: FindResponse = { ...base, note: filler };
    expect(Buffer.byteLength(JSON.stringify(padded), "utf8")).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);

    const result = maybeAttachRelatedLookups(padded, { query: "computeWidgetPriceRl", isRegex: false });

    expect(result.related_lookups).toBeUndefined();
    expect(result).toBe(padded); // dropped, not force-fitted — same object back, diet stays intact.
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
  });

  it("keeps the attachment when the response has ordinary headroom under MAX_RESPONSE_BYTES", () => {
    const raw = baseHitResponse("computeWidgetPriceRl");

    const result = maybeAttachRelatedLookups(raw, { query: "computeWidgetPriceRl", isRegex: false });

    expect(result.related_lookups).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
  });

  it("judges the byte cap against MAX_INVENTORY_RESPONSE_BYTES, not MAX_RESPONSE_BYTES, once the response carries an inventory[]", () => {
    const base: FindResponse = {
      ...baseHitResponse("computeWidgetPriceRl"),
      truncated: true,
      inventory: [{ path: "src/Widget.ts", matches: 1 }],
      inventory_complete: true,
    };
    const baseBytes = Buffer.byteLength(JSON.stringify(base), "utf8");
    // Pad past the TIGHT cap but stay comfortably under the inventory cap.
    const filler = "x".repeat(MAX_RESPONSE_BYTES - baseBytes + 500);
    const padded: FindResponse = { ...base, note: filler };
    const paddedBytes = Buffer.byteLength(JSON.stringify(padded), "utf8");
    expect(paddedBytes).toBeGreaterThan(MAX_RESPONSE_BYTES);
    expect(paddedBytes).toBeLessThan(MAX_INVENTORY_RESPONSE_BYTES);

    const result = maybeAttachRelatedLookups(padded, { query: "computeWidgetPriceRl", isRegex: false });

    expect(result.related_lookups).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(MAX_INVENTORY_RESPONSE_BYTES);
  });

  it("measures a representative related_lookups payload at roughly 100-200B per entry", () => {
    const raw = baseHitResponse("parseConfigOptions");

    const result = maybeAttachRelatedLookups(raw, { query: "parseConfigOptions", isRegex: false });

    const rl = result.related_lookups!;
    const definitionBytes = Buffer.byteLength(JSON.stringify(rl.definition), "utf8");
    const callersBytes = Buffer.byteLength(JSON.stringify(rl.callers), "utf8");
    expect(definitionBytes).toBeGreaterThanOrEqual(60);
    expect(definitionBytes).toBeLessThanOrEqual(220);
    expect(callersBytes).toBeGreaterThanOrEqual(60);
    expect(callersBytes).toBeLessThanOrEqual(220);
  });
});

// ---------------------------------------------------------------------------
// action=find path — maybeAttachRelatedLookups layered on buildFindResponse()
// (see server.ts's find dispatch)
// ---------------------------------------------------------------------------

describe("maybeAttachRelatedLookups — action=find integration", () => {
  it("attaches related_lookups to a real buildFindResponse() literal single-identifier hit", () => {
    const ws = mkWorkspace();
    writeFile(ws, "src/orderCalc.ts", "export function computeOrderTotalRl(items) {\n  return items.length;\n}\n");

    const raw = buildFindResponse({ query: "computeOrderTotalRl" }, ws);
    expect(raw.literal).toBe(true);
    expect(raw.files.length).toBeGreaterThan(0);

    const result = maybeAttachRelatedLookups(raw, { query: "computeOrderTotalRl", isRegex: false });

    expect(result.related_lookups?.definition.arguments).toEqual({ action: "symbols", query: "computeOrderTotalRl" });
    expect(result.related_lookups?.callers.arguments).toEqual({ action: "references", query: "computeOrderTotalRl" });
    // Real end-to-end response still fits the same cap buildFindResponse itself enforces.
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
  });

  it("does not attach to a real buildFindResponse() 0-match/absence result", () => {
    const ws = mkWorkspace();
    writeFile(ws, "src/other.ts", "export const other = 1;\n");

    const raw = buildFindResponse({ query: "TotallyAbsentSymbolRlXYZ" }, ws);
    expect(raw.files.length).toBe(0);
    expect(raw.absence).toBeDefined();

    const result = maybeAttachRelatedLookups(raw, { query: "TotallyAbsentSymbolRlXYZ", isRegex: false });

    expect(result.related_lookups).toBeUndefined();
    expect(result).toBe(raw);
  });

  it("does not attach to a real buildFindResponse() multi-word query result (Pass 2 tokenized fallback)", () => {
    const ws = mkWorkspace();
    writeFile(ws, "src/multi.ts", "const alphaValueRl = 1;\nconst betaValueRl = 2;\n");

    const raw = buildFindResponse({ query: "alphaValueRl betaValueRl" }, ws);
    expect(raw.literal).toBe(false); // confirms this actually exercised Pass 2, not Pass 1.
    expect(raw.files.length).toBeGreaterThan(0);

    const result = maybeAttachRelatedLookups(raw, { query: "alphaValueRl betaValueRl", isRegex: false });

    expect(result.related_lookups).toBeUndefined();
  });

  it("coexists with member_sweep — server.ts chains related_lookups AFTER member_sweep on the SAME response", async () => {
    // Mirrors server.ts's find dispatch ordering exactly: member_sweep (the
    // rarer, more specific class/interface signal) attaches first and keeps
    // first claim on the shared byte budget; related_lookups is layered on
    // top of THAT result, not the raw buildFindResponse() output.
    const ws = mkWorkspace();
    writeFile(ws, "src/Widget.ts", "export class Widget {\n  render() { return 1; }\n  destroy() { return 2; }\n}\n");
    writeFile(ws, "src/app.ts", "import { Widget } from \"./Widget\";\n");

    const raw = buildFindResponse({ query: "Widget" }, ws);
    const withMemberSweep = await maybeAttachMemberSweepToFindResponse(raw, {
      query: "Widget",
      isRegex: false,
      workspace: ws,
      candidatePaths: raw.files.map((f) => f.path),
    });
    expect(withMemberSweep.member_sweep).toBeDefined();

    const result = maybeAttachRelatedLookups(withMemberSweep, { query: "Widget", isRegex: false });

    expect(result.member_sweep).toBeDefined(); // still present — not clobbered.
    expect(result.related_lookups).toBeDefined();
    expect(result.related_lookups?.definition.arguments).toEqual({ action: "symbols", query: "Widget" });
    expect(result.related_lookups?.callers.arguments).toEqual({ action: "references", query: "Widget" });
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
  });
});
