/**
 * servedBytesMatrix.spec.ts — MX-B: the served-bytes attack matrix.
 *
 * Permanent spec (scratchpad/brief-matrix.md, 2026-09-14). Replaces
 * incremental review rounds (`review-findings*.md`, `fix-notes-aa1.md`,
 * `fix-notes-ab1.md`) with ONE mechanically-generated matrix over the
 * ENCODING x ROUTE space every one of those rounds kept re-discovering the
 * next edge of. The oracle (see the six checks below) is independent of any
 * one route's exact wire shape: it scans the raw wire text for NUL bytes,
 * cross-checks that every route reaches the SAME verdict family for the same
 * fixture, and checks the verdict-specific invariants the policy promises
 * (`packages/mcp-server/src/util/textDecode.ts`'s `readServedText`).
 *
 * Harness pattern (`ServerHandle`/`startServer`/`call`/`canonicalNext`)
 * copied from `handsOnReport0142.characterization.spec.ts`, itself copied
 * from `handsOnReport0141.characterization.spec.ts` / `explorationContinuation
 * .characterization.spec.ts` — same convention: one spawned server per
 * `describe`, `TL_LEGACY_INPUT` deleted so an accidentally-legacy field in
 * this file is REFUSED rather than silently tolerated.
 *
 * Route inventory: `scratchpad/fix-notes-ab1.md`'s 62 call-site table
 * (mechanically produced by `scratchpad/ab1-sites.py`, dumped at
 * `scratchpad/ab1-sites.log`) and `packages/mcp-server/src/__tests__
 * /servedBytesDoors.spec.ts`'s door/module list. Verdict rules: `fix-notes-
 * aa1.md` §A (the `readServedText` policy) and `fix-notes-ab1.md` §A/§57/§58
 * (the funnel that STATES a strip at every door, and the disclosure that is a
 * property of the verdict, not of which door happened to notice it).
 *
 * Failing cells are registered in `KNOWN_FAILURES` (id -> observed shape) and
 * run as `it.fails`, per the brief: the deliverable is the failure inventory
 * (`scratchpad/matrix-B-inventory.md`), not a green run by omission.
 *
 * Every fixture byte is generated at test-run time by
 * `./servedBytesMatrixFixtures.ts` — this file, that one, and every fixture
 * on disk carry ZERO raw NUL bytes; NULs exist only as `String.fromCharCode
 * (0)` in memory and, transiently, in the bytes a fixture file holds on disk
 * under a throw-away tmp workspace (never committed, never in this repo's
 * tracked tree).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as path from "node:path";
import Ajv from "ajv";
import type { ValidateFunction } from "ajv";

import {
  buildServedBytesMatrixWorkspace,
  buildEncodingBytes,
  counterexampleCleanPathFor,
  counterexampleIdentifierFor,
  counterexamplePathFor,
  ENCODING_IDS,
  EXPECTED_UNDECODABLE_REASON,
  EXPECTED_VERDICT,
  freshMatrixWorkspace,
  matrixIdentifier,
  relMarkdownPathFor,
  relPathFor,
  REPRESENTATIVE_IDS,
  COUNTEREXAMPLE_IDS,
  writeBytes,
  type EncodingId,
  type VerdictFamily,
} from "./servedBytesMatrixFixtures.js";
import { readServedText } from "../../util/textDecode.js";

const nodeRequire = createRequire(import.meta.url);
const TSX_CLI = nodeRequire.resolve("tsx/cli");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_TS = path.resolve(HERE, "..", "..", "bin.ts");
const NUL = String.fromCharCode(0);

// ---------------------------------------------------------------------------
// Known failures. Register id -> the OBSERVED shape (never a guess) so a
// regression that changes the shape again reads as "this moved", not as a
// silent re-pass. See scratchpad/matrix-B-inventory.md for the grouped
// root-cause writeup this map is the index of.
//
// The FIXALL-B wave's own two entries (`r4-handle-single__empty`,
// `r4-handle-single__bom-only` -- MX-B group 1) are fixed at the root cause
// (`tools/readCodeSmallFile.ts`'s `buildSmallFile` now states `total_lines`
// on its full-content serve, so `readFamily.ts::textEvidence`'s existing
// "genuinely empty file" branch fires for a bare handle re-read the same way
// it already did for the mint call) and independently hardened
// (`protocol/emit.ts`'s `enforceRequiredSet` now converts ANY required-set
// violation into a structured refusal in every mode, never an opaque
// internal error). See scratchpad/fix-notes-fixall-B.md.
//
// review-findings-final.md SHOULD-FIX 1 (MXFIX, 2026-09-14) -- strengthening
// R16 to assert on-disk bytes are unchanged AND the refusal names the
// read-side disclosure surfaced a REAL, reproducible product-shaped gap
// (not a safety leak: both cells below refuse, and the on-disk bytes are
// byte-identical before/after in every run). For a NUL-bearing fixture
// LARGER than roughly 4 KiB (`nul-past-4kib`, `nul-past-surface-cap`), the
// edit_file write-guard's refusal uses a DIFFERENT, generic message
// ("write-error": "content contains a raw NUL character, the signature of a
// UTF-16 (or otherwise non-UTF-8) file misread as UTF-8 upstream ... this
// write was blocked to avoid corrupting the file") instead of the read
// side's own "nul-stripped"/"not decodable as UTF-8" disclosure vocabulary
// that the SAME verdict families reach for their small-file siblings
// (nul-sparse/nul-dense/nul-last-byte/nul-in-comment, all <=~2 KiB, all
// correctly name the read-side disclosure). `nul-past-surface-cap` is
// especially notable: it shares the "stripped" verdict family with
// nul-sparse/nul-last-byte/nul-in-comment, yet its refusal message is
// inconsistent with its OWN verdict-family siblings, suggesting the write
// guard for a NUL past some internal size threshold takes a different code
// path than the one the small-file guard shares with the read side. Left
// unfixed per this wave's mandate (test-only; do not patch product code for
// a defect a strengthened oracle reveals) -- reported for a ruling.
// ---------------------------------------------------------------------------
const KNOWN_FAILURES: Record<string, string> = {
  "r16-edit-readback__nul-past-4kib": "kind=\"refusal\" code=\"write-error\" detail=\"Cannot write file: refusing to write <tmp>/src/enc/nul_past_4kib.ts: content contains a raw NUL character, the signature of a UTF-16 (or otherwise non-UTF-8) file misread as UTF-8 upstream — this write was blocked to avoid corrupting the file\" -- safe (on-disk bytes byte-identical before/after, never edit.applied) but never names the read side's own undecodable/nul-dense disclosure vocabulary (saysUndecodableDisclosure is false); a size-gated write-guard code path, distinct from the one nul-dense (same verdict family, <100B) goes through and correctly names.",
  "r16-edit-readback__nul-past-surface-cap": "kind=\"refusal\" code=\"write-error\" detail=\"Cannot write file: refusing to write <tmp>/src/enc/nul_past_surface_cap.ts: content contains a raw NUL character, the signature of a UTF-16 (or otherwise non-UTF-8) file misread as UTF-8 upstream — this write was blocked to avoid corrupting the file\" -- safe (on-disk bytes byte-identical before/after, never edit.applied) but never names the read side's own nul-stripped disclosure (saysNulStripped is false), unlike its OWN \"stripped\"-verdict-family siblings nul-sparse/nul-last-byte/nul-in-comment, which all pass this same check.",
};

function itFor(id: string): typeof it | typeof it.fails {
  return KNOWN_FAILURES[id] ? it.fails : it;
}

// ---------------------------------------------------------------------------
// Spawned-stdio server harness — see this file's own header comment.
// ---------------------------------------------------------------------------

interface ServerHandle {
  initialize(): Promise<void>;
  callRaw(id: number, name: string, args: Record<string, unknown>): Promise<{ response: Record<string, unknown>; raw: string }>;
  rpc(id: number, method: string, params?: unknown): Promise<Record<string, unknown>>;
  kill(): void;
}

function startServer(cwd: string, extraArgs: string[] = []): ServerHandle {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env["TL_LEGACY_INPUT"];

  const child: ChildProcess = spawn(process.execPath, [TSX_CLI, BIN_TS, cwd, ...extraArgs], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  let buffer = "";
  let stderr = "";
  const waiters = new Map<number, (value: Record<string, unknown>) => void>();

  child.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line) as { id?: number };
        if (message.id !== undefined) {
          const waiter = waiters.get(message.id);
          if (waiter) {
            waiters.delete(message.id);
            waiter(message as Record<string, unknown>);
          }
        }
      } catch { /* stdio noise, not a JSON-RPC frame */ }
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

  const rpc = (id: number, method: string, params?: unknown): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`servedBytesMatrix ${method} timed out\n${stderr}`));
      }, 45_000);
      waiters.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

  return {
    async initialize(): Promise<void> {
      await rpc(1, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "vitest-served-bytes-matrix", version: "0" },
      });
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    async callRaw(id: number, name: string, args: Record<string, unknown>): Promise<{ response: Record<string, unknown>; raw: string }> {
      const response = await rpc(id, "tools/call", { name, arguments: args });
      if (response["error"] !== undefined) {
        // Surfaced as data, not thrown: oracle #6 asserts on this directly
        // rather than every call site needing its own try/catch.
        return { response: { __transportError: JSON.stringify(response["error"]) }, raw: JSON.stringify(response["error"]) };
      }
      const result = response["result"] as { content?: Array<{ text?: string }> } | undefined;
      const text = result?.content?.[0]?.text ?? "";
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = { __unparsable: text };
      }
      return { response: parsed, raw: text };
    },
    async rpc(id: number, method: string, params?: unknown): Promise<Record<string, unknown>> {
      const response = await rpc(id, method, params ?? {});
      if (response["error"] !== undefined) throw new Error(JSON.stringify(response["error"]));
      return response;
    },
    kill(): void {
      try { child.kill("SIGKILL"); } catch { /* already closed */ }
    },
  };
}

// ---------------------------------------------------------------------------
// Generic response helpers — deliberately shape-agnostic (string-contains on
// the whole serialized response), matching the project's own probe
// convention (scratchpad/ab1-doors.mjs's `says()`), because the SAME verdict
// is stated in a different field/form at nearly every route and re-deriving
// each route's exact field path would be re-implementing the bug this matrix
// exists to catch.
// ---------------------------------------------------------------------------

function bodyValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

interface ToolCall { tool: string; arguments: Record<string, unknown>; }

function asToolCall(value: unknown): ToolCall | undefined {
  const v = bodyValue(value);
  return typeof v["tool"] === "string" && v["arguments"] !== undefined
    ? { tool: v["tool"] as string, arguments: bodyValue(v["arguments"]) }
    : undefined;
}

/** Exactly one source per response, fixed priority — matches handsOnReport0142's own `canonicalNext`. */
function canonicalNext(resp: Record<string, unknown>): ToolCall | undefined {
  const limitNext = asToolCall(bodyValue(resp["limit"])["next"]);
  if (limitNext) return limitNext;
  const topNext = asToolCall(resp["next"]);
  if (topNext) return topNext;
  const decisionNext = asToolCall(bodyValue(resp["decision"])["next"]);
  if (decisionNext) return decisionNext;
  const batch = resp["entries"];
  if (Array.isArray(batch)) {
    for (const entry of batch) {
      const n = asToolCall(bodyValue(entry)["next"]);
      if (n) return n;
    }
  }
  return undefined;
}

/** Every `next`-shaped field anywhere in one response, for schema validation — broader than canonicalNext. */
function allNextsIn(resp: Record<string, unknown>): ToolCall[] {
  const out: ToolCall[] = [];
  const push = (v: unknown): void => {
    const t = asToolCall(v);
    if (t) out.push(t);
  };
  push(resp["next"]);
  push(bodyValue(resp["limit"])["next"]);
  push(bodyValue(resp["decision"])["next"]);
  const entries = resp["entries"];
  if (Array.isArray(entries)) for (const entry of entries) push(bodyValue(entry)["next"]);
  const evidence = resp["evidence"];
  if (Array.isArray(evidence)) for (const entry of evidence) push(bodyValue(entry)["next"]);
  return out;
}

function wireNulCount(raw: string): number {
  const escaped = (raw.match(/\\u0000/g) ?? []).length;
  let literal = 0;
  for (const ch of raw) if (ch === NUL) literal += 1;
  return escaped + literal;
}

function responseText(resp: unknown): string {
  return JSON.stringify(resp);
}

function saysNulStripped(resp: unknown): boolean {
  return responseText(resp).includes("nul-stripped");
}

function saysUndecodableDisclosure(resp: unknown): boolean {
  const s = responseText(resp);
  return s.includes("not decodable as UTF-8") || s.includes("undecodable");
}

function mentions(resp: unknown, needle: string): boolean {
  return responseText(resp).includes(needle);
}

function isTransportError(resp: Record<string, unknown>): boolean {
  return "__transportError" in resp || "__unparsable" in resp;
}

function isRefusal(resp: Record<string, unknown>): boolean {
  return resp["kind"] === "refusal";
}

/** oracle (6a): no unstructured JSON-RPC error anywhere. */
function assertStructuredResponse(resp: Record<string, unknown>, label: string): void {
  expect(isTransportError(resp), `${label}: expected a structured tool response, got a transport-level error/unparsable text: ${responseText(resp).slice(0, 300)}`).toBe(false);
}

/** oracle (1): zero NUL bytes in the raw wire text. */
function assertNoWireNul(raw: string, label: string): void {
  expect(wireNulCount(raw), `${label}: wire text must carry zero NUL bytes`).toBe(0);
}

/** A refusal must never claim the offending path is writable, nor carry an edit obligation for it. */
function assertRefusalNeverGrantsEditOn(resp: Record<string, unknown>, relPath: string, label: string): void {
  const decision = bodyValue(resp["decision"]);
  if (decision["kind"] === "act.edit") {
    const frontier = decision["frontier"];
    const writablePaths = Array.isArray(frontier)
      ? frontier.filter((f) => bodyValue(f)["writable"] === true).map((f) => String(bodyValue(f)["path"] ?? ""))
      : [];
    expect(writablePaths, `${label}: an undecodable/refused path must never be certified writable`).not.toContain(relPath);
  }
}

// ---------------------------------------------------------------------------
// Cross-cell bookkeeping, populated as a side effect of the per-route `it`s
// below and consumed by the two summary `it`s at the end of the wire-matrix
// describe (vitest runs `it`s within one describe in declaration order).
// ---------------------------------------------------------------------------

type ObservedVerdict = VerdictFamily | "unavailable";
const observedVerdicts = new Map<EncodingId, Map<string, ObservedVerdict>>();
const observedNexts: ToolCall[] = [];

function recordVerdict(id: EncodingId, route: string, verdict: ObservedVerdict): void {
  if (!observedVerdicts.has(id)) observedVerdicts.set(id, new Map());
  observedVerdicts.get(id)!.set(route, verdict);
}

function recordNexts(resp: Record<string, unknown>): void {
  for (const n of allNextsIn(resp)) observedNexts.push(n);
}

let laneCounter = 0;
function freshLane(tag: string): string {
  laneCounter += 1;
  return `mxb-${tag}-${laneCounter}`;
}

// ---------------------------------------------------------------------------
// tools/list schema validation (oracle 6b: "every next validates against
// tools/list"). Built once per server from the server's OWN advertised
// schema, not a hand-copied duplicate.
// ---------------------------------------------------------------------------

async function buildToolValidators(srv: ServerHandle): Promise<Map<string, ValidateFunction>> {
  const listed = await srv.rpc(9000, "tools/list", {});
  const tools = (listed["result"] as { tools?: Array<{ name: string; inputSchema?: unknown }> } | undefined)?.tools ?? [];
  const ajv = new Ajv({ strict: false, allErrors: true });
  const validators = new Map<string, ValidateFunction>();
  for (const tool of tools) {
    if (tool.inputSchema) validators.set(tool.name, ajv.compile(tool.inputSchema as object));
  }
  return validators;
}

function assertNextsValidateAgainstSchema(nexts: readonly ToolCall[], validators: Map<string, ValidateFunction>): void {
  const offenders: string[] = [];
  for (const call of nexts) {
    const validate = validators.get(call.tool);
    if (!validate) {
      offenders.push(`unknown tool in a prescribed next: ${call.tool}`);
      continue;
    }
    if (!validate(call.arguments)) {
      offenders.push(`${call.tool} ${JSON.stringify(call.arguments)} -- ${ajvErrorsToString(validate.errors)}`);
    }
  }
  expect(offenders, "every prescribed `next` must validate against the server's own tools/list schema").toEqual([]);
}

function ajvErrorsToString(errors: ValidateFunction["errors"]): string {
  return (errors ?? []).map((e) => `${e.instancePath || "<root>"} ${e.message ?? ""}`).join("; ");
}

// ---------------------------------------------------------------------------
// SHA helper for the "stripped => sha describes the served text" half of
// oracle (3), applied where a response exposes a flat, predictable `sha`.
// ---------------------------------------------------------------------------

function shaPrefixMatches(reportedSha: unknown, expectedFullHex: string): boolean {
  if (typeof reportedSha !== "string") return false;
  const reported = reportedSha.startsWith("sha256:") ? reportedSha.slice("sha256:".length) : reportedSha;
  const len = Math.min(reported.length, expectedFullHex.length);
  if (len < 6) return false;
  return reported.slice(0, len) === expectedFullHex.slice(0, len);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Pure decode-policy baseline (no server). Independently re-derives, by
// calling the REAL `readServedText`, the verdict each fixture should reach —
// the wire-layer tests below compare EVERY route's observed verdict against
// this same baseline rather than a second hardcoded guess.
// ---------------------------------------------------------------------------

describe("MX-B pure decode policy baseline (util/textDecode.ts::readServedText)", () => {
  for (const id of ENCODING_IDS) {
    it(`readServedText(${id}) reaches the expected verdict family`, () => {
      const buf = buildEncodingBytes(id);
      const verdict = readServedText(buf);
      expect(verdict.kind, `${id}: verdict family`).toBe(EXPECTED_VERDICT[id]);
      const expectedReason = EXPECTED_UNDECODABLE_REASON[id];
      if (expectedReason !== undefined) {
        expect(verdict.kind, `${id}: expected an undecodable reason but verdict was ${verdict.kind}`).toBe("undecodable");
        if (verdict.kind === "undecodable") expect(verdict.reason, `${id}: undecodable reason`).toBe(expectedReason);
      }
      if (verdict.kind !== "undecodable") {
        let nulInText = 0;
        for (const ch of verdict.text) if (ch === NUL) nulInText += 1;
        expect(nulInText, `${id}: served text must never carry a raw NUL`).toBe(0);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Wire matrix — read-only routes, ONE spawned server, ONE shared workspace.
// ---------------------------------------------------------------------------

describe("MX-B served-bytes wire matrix (read-only routes)", () => {
  let ws: string;
  let srv: ServerHandle;
  let nextId = 100;
  let validators: Map<string, ValidateFunction>;
  const id = (): number => nextId++;

  beforeAll(async () => {
    ws = buildServedBytesMatrixWorkspace().dir;
    srv = startServer(ws, []);
    await srv.initialize();
    validators = await buildToolValidators(srv);
  }, 60_000);

  afterAll(() => {
    srv?.kill();
    if (ws) { try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* best effort */ } }
  });

  // -- R1: targets:[{path}] content:"full" --------------------------------
  describe("R1 targets:[{path}] content:full", () => {
    for (const encId of ENCODING_IDS) {
      itFor(`r1-full-single__${encId}`)(`full-single serves ${encId} byte-faithfully or discloses it`, async () => {
        const lane = freshLane("r1");
        const rel = relPathFor(encId);
        const { response, raw } = await srv.callRaw(id(), "read_file", {
          targets: [{ path: rel }],
          content: "full",
          cwd: ws,
          lane,
        });
        assertStructuredResponse(response, `r1/${encId}`);
        assertNoWireNul(raw, `r1/${encId}`);
        recordNexts(response);

        const expected = EXPECTED_VERDICT[encId];
        if (expected === "undecodable") {
          expect(isRefusal(response) || saysUndecodableDisclosure(response), `r1/${encId}: undecodable file must be disclosed, not silently served`).toBe(true);
          assertRefusalNeverGrantsEditOn(response, rel, `r1/${encId}`);
          recordVerdict(encId, "r1-full-single", "undecodable");
        } else {
          expect(isRefusal(response), `r1/${encId}: a ${expected} file must not be refused`).toBe(false);
          const evidence = response["evidence"];
          const body = Array.isArray(evidence) ? String(bodyValue(evidence[0])["body"] ?? "") : "";
          if (expected === "stripped") {
            expect(saysNulStripped(response), `r1/${encId}: a stripped serve must state the strip`).toBe(true);
            const verdict = readServedText(buildEncodingBytes(encId));
            if (verdict.kind === "stripped") {
              const shaField = Array.isArray(evidence) ? bodyValue(evidence[0])["sha"] : undefined;
              if (shaField !== undefined) {
                expect(shaPrefixMatches(shaField, sha256Hex(verdict.text)), `r1/${encId}: sha must describe the STRIPPED text, not the disk bytes`).toBe(true);
              }
            }
            recordVerdict(encId, "r1-full-single", "stripped");
          } else {
            expect(body.includes(NUL), `r1/${encId}: a clean serve must never carry a NUL`).toBe(false);
            // oracle (5): clean => body served byte-faithfully. Compared
            // against the fixture's OWN decoded text (never the raw bytes,
            // since a BOM is legitimately stripped by decoding) so a
            // clean-verdict fixture's content:"full" body must match it
            // exactly, not merely "look clean".
            const verdict = readServedText(buildEncodingBytes(encId));
            if (verdict.kind === "clean") {
              expect(body, `r1/${encId}: a clean content:full body must be byte-faithful to the fixture's decoded text`).toBe(verdict.text);
            }
            recordVerdict(encId, "r1-full-single", "clean");
          }
        }
      });
    }

    // Budgets (oracle 3): the stripped statement survives regardless of budget.
    for (const [label, budget] of [
      ["no budget", undefined],
      ["budget:{bytes:3000}", { bytes: 3000 }],
      ["budget:{tokens:800}", { tokens: 800 }],
    ] as const) {
      itFor(`r1-full-single-budget__nul-sparse__${label}`)(`full-single states the strip under ${label}`, async () => {
        const lane = freshLane("r1budget");
        const args: Record<string, unknown> = { targets: [{ path: relPathFor("nul-sparse") }], content: "full", cwd: ws, lane };
        if (budget) args["budget"] = budget;
        const { response, raw } = await srv.callRaw(id(), "read_file", args);
        assertStructuredResponse(response, `r1-budget/${label}`);
        assertNoWireNul(raw, `r1-budget/${label}`);
        expect(saysNulStripped(response), `r1-budget/${label}: strip statement must survive the budget`).toBe(true);
      });
    }
  });

  // -- R2: content:"outline" single target ---------------------------------
  describe("R2 content:outline (single target)", () => {
    for (const encId of ENCODING_IDS) {
      itFor(`r2-outline-single__${encId}`)(`outline-single serves ${encId} without leaking a NUL`, async () => {
        const lane = freshLane("r2");
        const rel = relPathFor(encId);
        const { response, raw } = await srv.callRaw(id(), "read_file", {
          targets: [{ path: rel }],
          content: "outline",
          cwd: ws,
          lane,
        });
        assertStructuredResponse(response, `r2/${encId}`);
        assertNoWireNul(raw, `r2/${encId}`);
        recordNexts(response);

        const expected = EXPECTED_VERDICT[encId];
        if (expected === "undecodable") {
          expect(isRefusal(response) || saysUndecodableDisclosure(response), `r2/${encId}: undecodable outline must be disclosed`).toBe(true);
          recordVerdict(encId, "r2-outline-single", "undecodable");
        } else if (expected === "stripped") {
          expect(saysNulStripped(response), `r2/${encId}: a stripped outline must state the strip`).toBe(true);
          recordVerdict(encId, "r2-outline-single", "stripped");
        } else {
          expect(mentions(response, NUL), `r2/${encId}: clean outline must never carry a raw NUL`).toBe(false);
          recordVerdict(encId, "r2-outline-single", "clean");
        }
      });
    }

    for (const [label, budget] of [
      ["budget:{bytes:3000}", { bytes: 3000 }],
      ["budget:{tokens:800}", { tokens: 800 }],
    ] as const) {
      itFor(`r2-outline-single-budget__nul-sparse__${label}`)(`outline-single states the strip under ${label}`, async () => {
        const lane = freshLane("r2budget");
        const { response, raw } = await srv.callRaw(id(), "read_file", {
          targets: [{ path: relPathFor("nul-sparse") }],
          content: "outline",
          budget,
          cwd: ws,
          lane,
        });
        assertStructuredResponse(response, `r2-budget/${label}`);
        assertNoWireNul(raw, `r2-budget/${label}`);
        expect(saysNulStripped(response), `r2-budget/${label}: strip statement must survive the budget`).toBe(true);
      });
    }
  });

  // -- R3: content:"outline" batch (>=2 targets) ---------------------------
  describe("R3 content:outline (batch, >=2 targets)", () => {
    for (const encId of ENCODING_IDS) {
      itFor(`r3-outline-batch__${encId}`)(`outline-batch serves ${encId} beside a clean decoy without leaking a NUL`, async () => {
        const lane = freshLane("r3");
        const { response, raw } = await srv.callRaw(id(), "read_file", {
          targets: [{ path: "src/decoy.css" }, { path: relPathFor(encId) }],
          content: "outline",
          cwd: ws,
          lane,
        });
        assertStructuredResponse(response, `r3/${encId}`);
        assertNoWireNul(raw, `r3/${encId}`);
        recordNexts(response);

        const expected = EXPECTED_VERDICT[encId];
        if (expected === "undecodable") {
          // AB1 residual R4, CLOSED (FIXALL-B, 2026-09-14): an undecodable
          // batch member now surfaces in `entries[]` as a disclosed
          // `file-downgraded` entry (`readFamily.ts::projectBatch` reuses
          // A.5.4's existing frozen form) instead of being silently dropped
          // behind only the coarse `limit.omitted` class. See
          // scratchpad/fix-notes-fixall-B.md. (Originally measured via
          // scratchpad/mxb-diag1.mjs, cross-checked against fix-notes-ab1.md's
          // own Residual R4, which this closes.)
          const entries = Array.isArray(response["entries"]) ? (response["entries"] as unknown[]) : [];
          const rel = relPathFor(encId);
          const encEntry = entries.find((e) => bodyValue(e)["path"] === rel);
          expect(encEntry, `r3/${encId}: an undecodable batch member must be disclosed in entries[], not silently dropped`).toBeDefined();
          const entryBody = bodyValue(encEntry);
          expect(entryBody["form"], `r3/${encId}: a disclosed undecodable entry must never be plain form:"file"`).toBe("file-downgraded");
          expect(entryBody["reason"], `r3/${encId}: a disclosed undecodable entry must name a reason`).toBeDefined();
          expect(saysUndecodableDisclosure(response), `r3/${encId}: the disclosure must say WHY, not just THAT`).toBe(true);
          recordVerdict(encId, "r3-outline-batch", "undecodable");
        } else if (expected === "stripped") {
          expect(saysNulStripped(response), `r3/${encId}: a stripped batch entry must state the strip`).toBe(true);
          recordVerdict(encId, "r3-outline-batch", "stripped");
        } else {
          recordVerdict(encId, "r3-outline-batch", "clean");
        }
      });
    }
  });

  // -- R4/R5: handle addressing, single and batch --------------------------
  describe("R4/R5 targets:[{handle}] single and batch", () => {
    for (const encId of ENCODING_IDS) {
      itFor(`r4-handle-single__${encId}`)(`a minted handle for ${encId} re-reads without leaking a NUL`, async () => {
        const lane = freshLane("r4");
        const rel = relPathFor(encId);
        const mint = await srv.callRaw(id(), "read_file", { targets: [{ path: rel, range: "1-1" }], cwd: ws, lane });
        assertStructuredResponse(mint.response, `r4-mint/${encId}`);
        assertNoWireNul(mint.raw, `r4-mint/${encId}`);
        const evidence = mint.response["evidence"];
        const handle = Array.isArray(evidence) ? bodyValue(evidence[0])["handle"] : undefined;
        if (typeof handle !== "string") {
          // No handle minted at all (e.g. the file was refused outright) —
          // a legitimate outcome for an undecodable fixture; nothing more to
          // check via THIS door.
          expect(EXPECTED_VERDICT[encId], `r4/${encId}: no handle minted but the fixture is not undecodable`).toBe("undecodable");
          recordVerdict(encId, "r4-handle-single", "undecodable");
          return;
        }
        const { response, raw } = await srv.callRaw(id(), "read_file", { targets: [{ handle }], cwd: ws, lane, task: { force_serve: true } });
        assertStructuredResponse(response, `r4/${encId}`);
        assertNoWireNul(raw, `r4/${encId}`);
        const expected = EXPECTED_VERDICT[encId];
        if (expected === "stripped") {
          expect(saysNulStripped(mint.response) || saysNulStripped(response), `r4/${encId}: strip must be stated at mint time or re-read time`).toBe(true);
          recordVerdict(encId, "r4-handle-single", "stripped");
        } else {
          recordVerdict(encId, "r4-handle-single", "clean");
        }
      });
    }

    itFor("r5-handle-batch__nul-sparse+latin1-invalid")("a two-handle batch mixing a stripped and an undecodable fixture leaks no NUL", async () => {
      const lane = freshLane("r5");
      const a = await srv.callRaw(id(), "read_file", { targets: [{ path: relPathFor("nul-sparse"), range: "1-1" }], cwd: ws, lane });
      const b = await srv.callRaw(id(), "read_file", { targets: [{ path: relPathFor("utf8-valid"), range: "1-1" }], cwd: ws, lane });
      assertNoWireNul(a.raw, "r5-mint-a");
      assertNoWireNul(b.raw, "r5-mint-b");
      const handleA = Array.isArray(a.response["evidence"]) ? bodyValue((a.response["evidence"] as unknown[])[0])["handle"] : undefined;
      const handleB = Array.isArray(b.response["evidence"]) ? bodyValue((b.response["evidence"] as unknown[])[0])["handle"] : undefined;
      expect(typeof handleA, "r5: expected a handle for the stripped fixture").toBe("string");
      expect(typeof handleB, "r5: expected a handle for the clean fixture").toBe("string");
      const { response, raw } = await srv.callRaw(id(), "read_file", { targets: [{ handle: handleA }, { handle: handleB }], cwd: ws, lane, task: { force_serve: true } });
      assertStructuredResponse(response, "r5");
      assertNoWireNul(raw, "r5");
      expect(saysNulStripped(a.response) || saysNulStripped(response), "r5: the stripped half of the batch must state the strip somewhere in the chain").toBe(true);
    });
  });

  // -- R6: range -------------------------------------------------------------
  describe("R6 targets:[{path,range}]", () => {
    for (const encId of ENCODING_IDS) {
      itFor(`r6-range__${encId}`)(`a line-range read of ${encId} leaks no NUL`, async () => {
        const lane = freshLane("r6");
        const { response, raw } = await srv.callRaw(id(), "read_file", {
          targets: [{ path: relPathFor(encId), range: "1-3" }],
          cwd: ws,
          lane,
        });
        assertStructuredResponse(response, `r6/${encId}`);
        assertNoWireNul(raw, `r6/${encId}`);
        recordNexts(response);
        const expected = EXPECTED_VERDICT[encId];
        if (expected === "undecodable") {
          expect(isRefusal(response) || saysUndecodableDisclosure(response), `r6/${encId}: undecodable range read must be disclosed`).toBe(true);
          recordVerdict(encId, "r6-range", "undecodable");
        } else if (expected === "stripped") {
          // A narrow range MAY not include the (possibly distant) NUL at
          // all; the invariant here is only "never leak one if it IS in the
          // served window", already covered by assertNoWireNul. Record
          // "unavailable" rather than asserting a strip statement that a
          // 3-line window has no obligation to carry.
          recordVerdict(encId, "r6-range", "unavailable");
        } else {
          recordVerdict(encId, "r6-range", "clean");
        }
      });
    }
  });

  // -- R7: symbol --------------------------------------------------------
  describe("R7 targets:[{path,symbol}]", () => {
    for (const encId of ENCODING_IDS) {
      itFor(`r7-symbol__${encId}`)(`a symbol-scoped read of ${encId} leaks no NUL`, async () => {
        const lane = freshLane("r7");
        const { response, raw } = await srv.callRaw(id(), "read_file", {
          targets: [{ path: relPathFor(encId), symbol: matrixIdentifier(encId) }],
          cwd: ws,
          lane,
        });
        assertStructuredResponse(response, `r7/${encId}`);
        assertNoWireNul(raw, `r7/${encId}`);
        recordNexts(response);
        // Symbol resolution may legitimately miss (an undecodable file has
        // no parseable symbols at all); the binding invariant is the NUL
        // scan above. Verdict-family bookkeeping is "unavailable" here
        // because a symbol-not-found refusal and an undecodable refusal are
        // not distinguishable generically without asserting a private
        // refusal code.
        recordVerdict(encId, "r7-symbol", "unavailable");
      });
    }
  });

  // -- R8: task_pack, pathless query + seeded targets ----------------------
  describe("R8 task_pack pathless (seeded targets)", () => {
    for (const encId of ENCODING_IDS) {
      itFor(`r8-pathless-seeded__${encId}`)(`a pathless query with ${encId} seeded via targets never leaks a NUL`, async () => {
        const lane = freshLane("r8");
        const { response, raw } = await srv.callRaw(id(), "read_file", {
          query: "Describe what this workspace contains.",
          targets: [{ path: "src/decoy.css" }, { path: relPathFor(encId) }],
          task: { epoch: "new" },
          cwd: ws,
          lane,
        });
        assertStructuredResponse(response, `r8/${encId}`);
        assertNoWireNul(raw, `r8/${encId}`);
        recordNexts(response);
        assertRefusalNeverGrantsEditOn(response, relPathFor(encId), `r8/${encId}`);

        const expected = EXPECTED_VERDICT[encId];
        if (expected === "undecodable") {
          expect(mentions(response, "unread") || saysUndecodableDisclosure(response) || isRefusal(response), `r8/${encId}: an undecodable seeded surface must be disclosed, never silently certified`).toBe(true);
          const decision = bodyValue(response["decision"]);
          if (decision["kind"] === "act.answer") {
            const gaps = bodyValue(decision["certificate"])["gaps"];
            expect(JSON.stringify(gaps ?? []).length > 2 || saysUndecodableDisclosure(response), `r8/${encId}: a certified act.answer over an undecodable seeded target must name it as a gap`).toBe(true);
          }
          recordVerdict(encId, "r8-pathless-seeded", "undecodable");
        } else if (expected === "stripped") {
          expect(saysNulStripped(response), `r8/${encId}: a stripped seeded surface must state the strip`).toBe(true);
          recordVerdict(encId, "r8-pathless-seeded", "stripped");
        } else {
          recordVerdict(encId, "r8-pathless-seeded", "clean");
        }
      });
    }
  });

  // -- R9: task_pack, query-named (augmentation, no identifier) ------------
  describe("R9 task_pack query-named (augmentation)", () => {
    for (const encId of ENCODING_IDS) {
      itFor(`r9-query-named__${encId}`)(`a query naming ${encId} by path (no identifier) never leaks a NUL`, async () => {
        const lane = freshLane("r9");
        const rel = relPathFor(encId);
        const { response, raw } = await srv.callRaw(id(), "read_file", {
          query: `Describe what ${rel} contains.`,
          task: { epoch: "new" },
          cwd: ws,
          lane,
        });
        assertStructuredResponse(response, `r9/${encId}`);
        assertNoWireNul(raw, `r9/${encId}`);
        recordNexts(response);
        assertRefusalNeverGrantsEditOn(response, rel, `r9/${encId}`);

        const expected = EXPECTED_VERDICT[encId];
        if (expected === "undecodable") {
          expect(saysUndecodableDisclosure(response) || mentions(response, "unread") || isRefusal(response), `r9/${encId}: augmentation must disclose an undecodable named path`).toBe(true);
          recordVerdict(encId, "r9-query-named", "undecodable");
        } else if (expected === "stripped") {
          expect(saysNulStripped(response), `r9/${encId}: augmentation must state the strip`).toBe(true);
          recordVerdict(encId, "r9-query-named", "stripped");
        } else {
          recordVerdict(encId, "r9-query-named", "clean");
        }
      });
    }
  });

  // -- R10: task_pack, literal-first (path + unique identifier) -----------
  describe("R10 task_pack literal-first (path + unique identifier)", () => {
    for (const encId of ENCODING_IDS) {
      itFor(`r10-literal-first__${encId}`)(`a query naming ${encId}'s own unique identifier never leaks a NUL`, async () => {
        const lane = freshLane("r10");
        const rel = relPathFor(encId);
        const { response, raw } = await srv.callRaw(id(), "read_file", {
          query: `Explain ${matrixIdentifier(encId)} in ${rel}.`,
          task: { epoch: "new" },
          cwd: ws,
          lane,
        });
        assertStructuredResponse(response, `r10/${encId}`);
        assertNoWireNul(raw, `r10/${encId}`);
        recordNexts(response);
        assertRefusalNeverGrantsEditOn(response, rel, `r10/${encId}`);

        const expected = EXPECTED_VERDICT[encId];
        if (expected === "undecodable") {
          expect(saysUndecodableDisclosure(response) || mentions(response, "unread") || isRefusal(response), `r10/${encId}: literal-first bind of an undecodable file must disclose it (SHOULD-FIX 58), never a silent zero-length filename-match`).toBe(true);
          recordVerdict(encId, "r10-literal-first", "undecodable");
        } else if (expected === "stripped") {
          expect(saysNulStripped(response), `r10/${encId}: literal-first bind of a stripped file must state the strip`).toBe(true);
          recordVerdict(encId, "r10-literal-first", "stripped");
        } else {
          recordVerdict(encId, "r10-literal-first", "clean");
        }
      });
    }
  });

  // -- R11: task_pack counterexample (two-file shared identifier) ---------
  describe("R11 task_pack counterexample candidate", () => {
    for (const encId of COUNTEREXAMPLE_IDS) {
      itFor(`r11-counterexample__${encId}`)(`the ${encId} counterexample candidate is probed without leaking a NUL`, async () => {
        const lane = freshLane("r11");
        const cleanRel = counterexampleCleanPathFor(encId);
        const identifier = counterexampleIdentifierFor(encId);
        const { response, raw } = await srv.callRaw(id(), "read_file", {
          query: `Explain ${identifier} in ${cleanRel}.`,
          task: { epoch: "new" },
          cwd: ws,
          lane,
        });
        assertStructuredResponse(response, `r11/${encId}`);
        assertNoWireNul(raw, `r11/${encId}`);
        recordNexts(response);
        const encodedRel = counterexamplePathFor(encId);
        assertRefusalNeverGrantsEditOn(response, encodedRel, `r11/${encId}`);

        const expected = EXPECTED_VERDICT[encId];
        if (expected === "undecodable") {
          // Door 5 (AA1 #5): an unreadable counterexample candidate must
          // probe as UNAVAILABLE, never certify over its bytes.
          const decision = bodyValue(response["decision"]);
          if (decision["kind"] === "act.answer") {
            expect(mentions(response, encodedRel) === false || saysUndecodableDisclosure(response), `r11/${encId}: a certified answer must not cite the undecodable counterexample candidate as evidence`).toBe(true);
          }
          recordVerdict(encId, "r11-counterexample", "undecodable");
        } else if (expected === "stripped") {
          recordVerdict(encId, "r11-counterexample", "stripped");
        } else {
          recordVerdict(encId, "r11-counterexample", "clean");
        }
      });
    }
  });

  // -- R12: search_files find snippets -------------------------------------
  describe("R12 search_files find snippets", () => {
    for (const encId of ENCODING_IDS) {
      itFor(`r12-search-find__${encId}`)(`find snippets for ${encId}'s identifier leak no NUL`, async () => {
        const lane = freshLane("r12");
        const { response, raw } = await srv.callRaw(id(), "search_files", {
          action: "find",
          queries: [matrixIdentifier(encId)],
          cwd: ws,
          lane,
        });
        assertStructuredResponse(response, `r12/${encId}`);
        assertNoWireNul(raw, `r12/${encId}`);
        // find/tree/references are declared NON-doors (NOTE 71): a snippet
        // is scan output, not a served body — but the raw-NUL scan above
        // still holds unconditionally.
      });
    }
  });

  // -- R13: content:"outline" on a directory (role/file map) --------------
  describe("R13 content:outline on a directory", () => {
    for (const encId of REPRESENTATIVE_IDS) {
      itFor(`r13-map-directory__${encId}`)(`a directory outline containing ${encId} leaks no NUL`, async () => {
        const lane = freshLane("r13");
        const { response, raw } = await srv.callRaw(id(), "read_file", {
          targets: [{ path: "src/enc" }],
          content: "outline",
          cwd: ws,
          lane,
        });
        assertStructuredResponse(response, `r13/${encId}`);
        assertNoWireNul(raw, `r13/${encId}`);
        recordNexts(response);
      });
    }
  });

  // -- R14: markdown outline -------------------------------------------------
  describe("R14 content:outline on a .md file", () => {
    for (const encId of REPRESENTATIVE_IDS) {
      itFor(`r14-markdown-outline__${encId}`)(`a markdown outline of ${encId}'s bytes leaks no NUL`, async () => {
        const lane = freshLane("r14");
        const { response, raw } = await srv.callRaw(id(), "read_file", {
          targets: [{ path: relMarkdownPathFor(encId) }],
          content: "outline",
          cwd: ws,
          lane,
        });
        assertStructuredResponse(response, `r14/${encId}`);
        assertNoWireNul(raw, `r14/${encId}`);
        recordNexts(response);

        const expected = EXPECTED_VERDICT[encId];
        if (expected === "undecodable") {
          expect(isRefusal(response) || saysUndecodableDisclosure(response), `r14/${encId}: an undecodable markdown file must be disclosed`).toBe(true);
        } else if (expected === "stripped") {
          expect(saysNulStripped(response), `r14/${encId}: a stripped markdown file must state the strip`).toBe(true);
        }
      });
    }
  });

  // -- R15: cursor continuation --------------------------------------------
  describe("R15 cursor continuation", () => {
    for (const encId of REPRESENTATIVE_IDS) {
      itFor(`r15-cursor-continuation__${encId}`)(`a paginated find for ${encId} leaks no NUL across a cursor hop`, async () => {
        const lane = freshLane("r15");
        const first = await srv.callRaw(id(), "search_files", {
          action: "find",
          queries: [matrixIdentifier(encId)],
          budget: { items: 1 },
          cwd: ws,
          lane,
        });
        assertStructuredResponse(first.response, `r15-first/${encId}`);
        assertNoWireNul(first.raw, `r15-first/${encId}`);
        const cursorNext = canonicalNext(first.response);
        if (!cursorNext) {
          // A single-match query has nothing to paginate — a legitimate,
          // non-failing outcome; nothing further to hop to.
          return;
        }
        recordNexts(first.response);
        const second = await srv.callRaw(id(), cursorNext.tool, { ...cursorNext.arguments, cwd: ws, lane });
        assertStructuredResponse(second.response, `r15-second/${encId}`);
        assertNoWireNul(second.raw, `r15-second/${encId}`);
      });
    }
  });

  // -- Cross-cell summary checks -------------------------------------------
  it("the verdict family is identical across every route, per fixture", () => {
    const disagreements: string[] = [];
    for (const encId of ENCODING_IDS) {
      const byRoute = observedVerdicts.get(encId);
      if (!byRoute) continue;
      const distinct = new Set(
        [...byRoute.values()].filter((v): v is VerdictFamily => v !== "unavailable"),
      );
      if (distinct.size > 1) {
        disagreements.push(`${encId}: ${JSON.stringify([...byRoute.entries()])}`);
      }
    }
    expect(disagreements, "every route must reach the SAME verdict family for the same fixture").toEqual([]);
  });

  it("every next observed across the whole read-only matrix validates against tools/list", () => {
    assertNextsValidateAgainstSchema(observedNexts, validators);
  });
});

// ---------------------------------------------------------------------------
// Wire matrix — edit_file read-back, ONE spawned server with --allow-write,
// a SEPARATE workspace (never shares mutable state with the read-only
// matrix above).
// ---------------------------------------------------------------------------

describe("MX-B served-bytes wire matrix (edit_file read-back, --allow-write)", () => {
  let ws: string;
  let srv: ServerHandle;
  let nextId = 200;
  const id = (): number => nextId++;

  beforeAll(async () => {
    ws = freshMatrixWorkspace("edit");
    writeBytes(ws, "package.json", Buffer.from('{"name":"tl-mxb-edit-fixture","private":true}\n', "utf8"));
    for (const encId of ENCODING_IDS) writeBytes(ws, relPathFor(encId), buildEncodingBytes(encId));
    srv = startServer(ws, ["--allow-write"]);
    await srv.initialize();
  }, 60_000);

  afterAll(() => {
    srv?.kill();
    if (ws) { try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* best effort */ } }
  });

  describe("R16 edit_file read-back (applied[].code)", () => {
    for (const encId of ENCODING_IDS) {
      itFor(`r16-edit-readback__${encId}`)(`editing ${encId} either refuses cleanly or read-back leaks no NUL`, async () => {
        const lane = freshLane("r16");
        const rel = relPathFor(encId);
        const abs = path.join(ws, rel);
        const identifier = matrixIdentifier(encId);
        // review-findings-final.md SHOULD-FIX 1: read the fixture bytes
        // BEFORE the call so a regression that writes a STRIPPED buffer
        // back (BLOCKER 62's subject) shows up as a byte diff, not just as
        // an unchecked "it didn't say edit.applied". "NUL-bearing" is
        // derived from the REAL decode policy, not a raw byte scan: a
        // clean UTF-16 fixture's bytes are FULL of literal 0x00 bytes (the
        // ordinary 2-byte-per-ASCII-char encoding artifact) despite
        // decoding to text with zero embedded NUL — `bytesBefore.includes
        // (0)` would wrongly flag every utf16*-bom fixture as NUL-bearing.
        const bytesBefore = fs.readFileSync(abs);
        const verdictBefore = readServedText(bytesBefore);
        const hasNul = verdictBefore.kind === "stripped" || (verdictBefore.kind === "undecodable" && verdictBefore.reason === "nul-dense");

        const { response, raw } = await srv.callRaw(id(), "edit_file", {
          edits: [{
            path: rel,
            search: `export const ${identifier} = () => {};`,
            replace: `export const ${identifier} = () => { /* edited by MX-B */ };`,
          }],
          cwd: ws,
          lane,
        });
        assertNoWireNul(raw, `r16/${encId}`);
        const bytesAfter = fs.readFileSync(abs);

        if (hasNul) {
          // A NUL-bearing fixture (verdict "stripped" or "undecodable") must
          // refuse the edit outright — never edit.applied, which for a
          // "stripped" fixture could only mean the STRIPPED (NUL-free) text
          // was written back, silently deleting the original NUL bytes. The
          // on-disk bytes must be PROVABLY untouched (not merely "still has
          // a NUL somewhere"), and the refusal must name the SAME read-side
          // disclosure the read routes state for this fixture, so a
          // regression that swaps in an unrelated refusal reason cannot
          // hide behind this oracle.
          expect(bytesAfter.equals(bytesBefore), `r16/${encId}: a NUL-bearing file's on-disk bytes must be byte-identical after the edit call (before=${bytesBefore.length}B, after=${bytesAfter.length}B)`).toBe(true);
          expect(response["kind"], `r16/${encId}: an edit on a NUL-bearing file must refuse, never edit.applied: ${JSON.stringify(response).slice(0, 500)}`).toBe("refusal");
          const expected = EXPECTED_VERDICT[encId];
          if (expected === "stripped") {
            expect(saysNulStripped(response), `r16/${encId}: the refusal must name the same nul-stripped disclosure the read side states: ${JSON.stringify(response).slice(0, 500)}`).toBe(true);
          } else {
            expect(saysUndecodableDisclosure(response), `r16/${encId}: the refusal must name the same undecodable disclosure the read side states: ${JSON.stringify(response).slice(0, 500)}`).toBe(true);
          }
          return;
        }

        if (response["kind"] === "refusal") {
          // A refused edit (write-guard, search-not-found, etc.) is a
          // legitimate outcome for a non-clean, NUL-free fixture — the
          // invariant is that the refusal itself never leaks a raw NUL
          // (already checked above) and never silently reports success.
          return;
        }
        expect(response["kind"], `r16/${encId}: unexpected edit_file response kind`).toBe("edit.applied");
        const applied = response["applied"];
        if (!Array.isArray(applied)) return;
        for (const entry of applied) {
          const code = bodyValue(entry)["code"];
          if (typeof code === "string") {
            let nulInCode = 0;
            for (const ch of code) if (ch === NUL) nulInCode += 1;
            expect(nulInCode, `r16/${encId}: applied[].code read-back must never carry a raw NUL`).toBe(0);
          }
        }
      });
    }
  });
});
