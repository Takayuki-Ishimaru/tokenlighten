// coverageReceiptWiring.spec.ts — W-WIRE-2A
//
// `coverageReceipt.spec.ts` proves `coverageReceiptFor`'s decision table in
// isolation, driven through the ledger's own public recording API.
// `servedReceiptElisionHonesty.spec.ts`'s W-LEDGER(A)/(B) sections pin the
// flag-off wire identity and the pure `receiptOf` projector.
//
// THIS FILE is the missing middle: the PRODUCTION emit sites in `server.ts`
// that must actually call `coverageReceiptFor` and shape a response from its
// verdict, exercised end-to-end through `callTool` (in-process, no child
// server — mirrors `turnEconomyServe.spec.ts`'s harness).
//
// Scope, per the honesty contract `coverageReceipt.ts` documents:
//   - full coverage   => `read.receipt` (`code-unchanged`) carrying `covered_by`.
//   - partial coverage (mode=slice, single range) => the uncovered remainder
//     only, via the SAME segments/prior builder mode=full/symbol already ship
//     (`buildLedgerDifferenceFullPayload`) — a covered span rides `prior` on
//     its `Evidence` entry (readFamily.ts's existing, unmodified projection),
//     never a second copy of the caller's own bytes.
//   - flag off, force_serve, a different workspace, or a sha the ledger does
//     not recognise (an edit) all fall through to an ordinary full serve.
//
// `covered_by` on the WIRE is confined to `code-unchanged` receipts — the
// single door `servedReceiptElisionHonesty.spec.ts`'s W-LEDGER(B) documents
// (`readFamily.ts`'s `receiptOf`). A partial/segments response never carries a
// top-level `covered_by` field; its honesty is the segments themselves.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { callTool } from "../server.js";
import { resetAll } from "../state/session.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const dirs: string[] = [];

function mkWs(tag: string): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(HOME, `.tl-covwire-${tag}-`)));
  dirs.push(d);
  return d;
}
function write(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}
function parse(res: { content: Array<{ text: string }>; isError?: boolean }): {
  body: Record<string, unknown>;
  isError: boolean;
} {
  const text = res.content[0]?.text ?? "";
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* plain-string error text */
  }
  return { body, isError: res.isError === true };
}

/** 60 lines, each independently greppable — L1..L60. */
function plainFile(n = 60): string {
  const lines: string[] = [];
  for (let i = 1; i <= n; i++) lines.push(`export const L${i} = ${i};`);
  return lines.join("\n") + "\n";
}

/**
 * R11 A-4 fixture: `n` lines, each padded to a FIXED byte width so a
 * requested line range maps predictably onto the mode=slice byte cap
 * (readCodeModes.ts's `READ_SYMBOL_CAP_BYTES`, 24576) without hardcoding
 * that constant here — `n` just needs to be large enough that the whole
 * range is well past it, which 2000 lines at ~49 B/line (~98 KB) is.
 */
function wideLinesFile(n: number): string {
  const lines: string[] = [];
  for (let i = 1; i <= n; i++) {
    lines.push(`export const L${String(i).padStart(5, "0")} = ${i}; // pad pad pad`);
  }
  return lines.join("\n") + "\n";
}

beforeEach(() => {
  resetAll();
  process.env["TL_RECEIPT_COVERAGE"] = "1";
});

afterEach(() => {
  delete process.env["TL_RECEIPT_COVERAGE"];
  resetAll();
  for (const d of dirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

describe("W-WIRE-2A: coverageReceiptFor wired into mode=slice (flag ON)", () => {
  it("slice A then an overlapping slice B => the remainder only, the overlap marked prior-held", async () => {
    const ws = mkWs("overlap");
    write(ws, "src/plain.ts", plainFile());

    const first = parse(await callTool("read_file", {
      mode: "slice", path: "src/plain.ts", range: "1-40", cwd: ws,
    }));
    expect(first.isError).toBe(false);
    expect(first.body["kind"]).toBe("read.text");

    // Overlaps 1-40 on 30-40; 41-55 is genuinely new. A different task epoch
    // so P0's same-task fence cannot answer this from a certificate instead of
    // the served-range ledger this test is about.
    const second = parse(await callTool("read_file", {
      mode: "slice", path: "src/plain.ts", range: "30-55", cwd: ws, taskEpoch: "new",
    }));
    expect(second.isError).toBe(false);
    expect(second.body["kind"]).toBe("read.text");

    const evidence = (second.body["evidence"] ?? []) as Array<Record<string, unknown>>;
    expect(evidence.length).toBeGreaterThanOrEqual(2);

    const fresh = evidence.find((e) => e["range"] === "41-55");
    expect(fresh, JSON.stringify(second.body)).toBeDefined();
    expect(String(fresh?.["body"] ?? "")).toContain("L55 = 55");
    expect(fresh?.["prior"]).toBeUndefined();

    const held = evidence.find((e) => e["range"] === "30-40");
    expect(held, JSON.stringify(second.body)).toBeDefined();
    expect(held?.["prior"]).toBeDefined();
    // The remainder is ONLY the fresh bytes — the already-held window's own
    // content is never re-sent alongside it.
    expect(held?.["body"]).toBeUndefined();

    // No segment re-derives lines the caller never asked for in this window
    // (28-29 stayed out of both requests).
    expect(JSON.stringify(second.body)).not.toContain("L28 = 28");
  });

  it("whole file after slices => the remainder only (mode=full's existing difference projection)", async () => {
    const ws = mkWs("full-after-slices");
    write(ws, "src/plain.ts", plainFile());

    await callTool("read_file", { mode: "slice", path: "src/plain.ts", range: "1-30", cwd: ws });

    const full = parse(await callTool("read_file", {
      mode: "full", path: "src/plain.ts", cwd: ws, taskEpoch: "new",
    }));
    expect(full.isError).toBe(false);
    const segments = (full.body["segments"] ?? full.body["evidence"]) as
      | Array<Record<string, unknown>>
      | undefined;
    expect(segments, JSON.stringify(full.body)).toBeDefined();
    const heldSegment = segments!.find((s) => s["range"] === "1-30" || s["prior"] !== undefined);
    expect(heldSegment, JSON.stringify(full.body)).toBeDefined();
    const freshText = JSON.stringify(full.body);
    expect(freshText).toContain("L60 = 60");
  });

  it("identical re-read => a receipt, carrying covered_by", async () => {
    const ws = mkWs("identical");
    write(ws, "src/plain.ts", plainFile());

    await callTool("read_file", { mode: "slice", path: "src/plain.ts", range: "1-20", cwd: ws });
    const repeat = parse(await callTool("read_file", {
      mode: "slice", path: "src/plain.ts", range: "1-20", cwd: ws, taskEpoch: "new",
    }));

    expect(repeat.isError).toBe(false);
    expect(repeat.body["kind"], JSON.stringify(repeat.body)).toBe("read.receipt");
    const receipt = repeat.body["receipt"] as Record<string, unknown>;
    expect(receipt["receipt"]).toBe("code-unchanged");
    expect(Array.isArray(receipt["covered_by"]), JSON.stringify(repeat.body)).toBe(true);
    const coveredBy = receipt["covered_by"] as Array<Record<string, unknown>>;
    expect(coveredBy.some((span) => span["range"] === "1-20")).toBe(true);
    expect(repeat.body["evidence"]).toBeUndefined();
  });

  it("an edit on the path then re-read => a full serve (the sha moved, so nothing is covered)", async () => {
    // In-process `callTool` always runs write-disabled (only a spawned child
    // with --allow-write can exercise edit_file — see canonicalSurface.spec.ts
    // /closureSatisfiedEditGate.spec.ts). What this test is actually about —
    // coverageReceiptFor's honesty rule (1), "the sha the caller computed from
    // the bytes on disk RIGHT NOW" — does not care WHO changed the bytes, only
    // that they changed, so writing the file directly (an external edit) is
    // the same fact the ledger must react to as a TL-mediated edit_file would.
    const ws = mkWs("edited");
    write(ws, "src/plain.ts", plainFile());

    const first = parse(await callTool("read_file", {
      mode: "slice", path: "src/plain.ts", range: "1-20", cwd: ws,
    }));
    const handle = String(
      (first.body["evidence"] as Array<Record<string, unknown>> | undefined)?.[0]?.["handle"],
    );
    expect(handle).toMatch(/^h[0-9a-z]+$/);

    write(ws, "src/plain.ts", plainFile().replace("export const L1 = 1;", "export const L1 = 999;"));

    const reread = parse(await callTool("read_file", {
      mode: "slice", path: "src/plain.ts", range: "1-20", cwd: ws, taskEpoch: "new",
    }));
    expect(reread.isError).toBe(false);
    // Not a receipt, and not a partial/segments narrowing — a plain fresh
    // serve of the post-edit bytes, which is what a sha mismatch must fall
    // through to.
    expect(reread.body["kind"]).toBe("read.text");
    expect(reread.body["segments"]).toBeUndefined();
    const evidence = (reread.body["evidence"] ?? []) as Array<Record<string, unknown>>;
    expect(String(evidence[0]?.["body"] ?? "")).toContain("L1 = 999");
    expect(JSON.stringify(reread.body)).not.toContain("\"prior\"");
  });

  it("a different worktree, same relative path => a full serve (no cross-workspace residency)", async () => {
    const wsA = mkWs("wsA");
    const wsB = mkWs("wsB");
    write(wsA, "src/plain.ts", plainFile());
    write(wsB, "src/plain.ts", plainFile()); // byte-identical content/sha

    await callTool("read_file", { mode: "slice", path: "src/plain.ts", range: "1-40", cwd: wsA });

    const inOther = parse(await callTool("read_file", {
      mode: "slice", path: "src/plain.ts", range: "30-55", cwd: wsB,
    }));
    expect(inOther.isError).toBe(false);
    expect(inOther.body["kind"]).toBe("read.text");
    expect(inOther.body["segments"]).toBeUndefined();
    const evidence = (inOther.body["evidence"] ?? []) as Array<Record<string, unknown>>;
    // The WHOLE requested window came back fresh, including the part that
    // overlaps what wsA (a different workspace) holds.
    expect(String(evidence[0]?.["body"] ?? "")).toContain("L30 = 30");
    expect(String(evidence[0]?.["body"] ?? "")).toContain("L55 = 55");
    expect(evidence[0]?.["prior"]).toBeUndefined();
  });

  it("force_serve => a full serve of the whole requested window, never narrowed", async () => {
    const ws = mkWs("force-serve");
    write(ws, "src/plain.ts", plainFile());

    await callTool("read_file", { mode: "slice", path: "src/plain.ts", range: "1-40", cwd: ws });

    const forced = parse(await callTool("read_file", {
      mode: "slice", path: "src/plain.ts", range: "30-55", cwd: ws,
      taskEpoch: "new", force_serve: true,
    }));
    expect(forced.isError).toBe(false);
    expect(forced.body["kind"]).toBe("read.text");
    expect(forced.body["segments"]).toBeUndefined();
    const evidence = (forced.body["evidence"] ?? []) as Array<Record<string, unknown>>;
    const body = String(evidence[0]?.["body"] ?? "");
    expect(body).toContain("L30 = 30");
    expect(body).toContain("L55 = 55");
    expect(JSON.stringify(forced.body)).not.toContain("covered_by");
  });

  it("ranges[] batch: one entry already covered, one entry genuinely new — decided independently", async () => {
    const ws = mkWs("batch-mixed");
    write(ws, "src/plain.ts", plainFile());

    await callTool("read_file", { mode: "slice", path: "src/plain.ts", range: "1-20", cwd: ws });

    const batch = parse(await callTool("read_file", {
      mode: "slice", path: "src/plain.ts", ranges: ["1-20", "40-60"], cwd: ws, taskEpoch: "new",
    }));
    expect(batch.isError, JSON.stringify(batch.body)).toBe(false);

    const segments = (batch.body["segments"] ?? batch.body["evidence"]) as Array<Record<string, unknown>>;
    expect(segments).toBeDefined();
    const text = JSON.stringify(segments);
    // The already-covered window must not resend its own bytes...
    const coveredEntry = segments.find(
      (s) => s["range"] === "1-20" || (s["code_unchanged"] === true),
    );
    expect(coveredEntry, text).toBeDefined();
    // ...while the genuinely new window ships real content.
    expect(text).toContain("L60 = 60");
  });

  it("R11 A-4: a CAPPED slice with partial coverage still discloses remaining_ranges + next", async () => {
    // The sibling `addedLines === 0` receipt guards this exact shape (W2A-1,
    // `sliceData.remaining_ranges === undefined`) ~90 lines below the partial-
    // coverage branch this pins — this branch used to lack the same guard, so
    // a capped slice's uncovered TAIL (never served or even examined) could be
    // silently dropped from the response the caller has to plan its next call
    // from.
    const ws = mkWs("capped-partial");
    write(ws, "src/wide.ts", wideLinesFile(2000));

    // Seed: a small head range, fully served and well under the byte cap.
    const seed = parse(await callTool("read_file", {
      mode: "slice", path: "src/wide.ts", range: "1-50", cwd: ws,
    }));
    expect(seed.isError, JSON.stringify(seed.body).slice(0, 400)).toBe(false);

    // Re-ask a range that (a) OVERLAPS the already-served head — partial
    // coverage — and (b) is itself far too large for one serve's byte cap, so
    // the RESOLVED window sliceData describes is only a prefix of this ask.
    const second = parse(await callTool("read_file", {
      mode: "slice", path: "src/wide.ts", range: "1-2000", cwd: ws, taskEpoch: "new",
    }));
    expect(second.isError, JSON.stringify(second.body).slice(0, 400)).toBe(false);

    // The caller's original 1-2000 ask was NOT fully answered (the byte cap
    // trimmed it to a 1-587 head) — that must be disclosed, not silently
    // absorbed by the already-covered 1-50 head looking like the whole story.
    // readFamily.ts's canonical projection carries the resolveSlice-level
    // `remaining_ranges`/`next` this way: `Evidence.remaining` on the served
    // entry, and the follow-up call under the response's `limit.next` (a
    // truncated wire always names ITS OWN continuation there, never a bare
    // top-level `next` — see readFamily.ts's zoom-cause contract).
    expect(second.body["kind"], JSON.stringify(second.body).slice(0, 500)).toBe("read.text");
    const evidence = second.body["evidence"] as Array<Record<string, unknown>>;
    expect(evidence, JSON.stringify(second.body).slice(0, 500)).toBeDefined();
    const remaining = evidence[0]?.["remaining"] as string[] | undefined;
    expect(remaining, JSON.stringify(second.body).slice(0, 800)).toBeDefined();
    expect(remaining!.length).toBeGreaterThan(0);
    expect(remaining).toContain("588-2000");
    const limit = second.body["limit"] as Record<string, unknown> | undefined;
    expect(limit?.["next"], JSON.stringify(second.body).slice(0, 800)).toBeDefined();
  });
});

describe("W-WIRE-2A: flag OFF stays byte-identical to pre-2A behavior", () => {
  it("the overlap scenario above serves the whole window with no covered_by/prior, exactly as before", async () => {
    delete process.env["TL_RECEIPT_COVERAGE"];
    const ws = mkWs("flag-off");
    write(ws, "src/plain.ts", plainFile());

    await callTool("read_file", { mode: "slice", path: "src/plain.ts", range: "1-40", cwd: ws });
    const overlap = parse(await callTool("read_file", {
      mode: "slice", path: "src/plain.ts", range: "30-55", cwd: ws, taskEpoch: "new",
    }));

    expect(overlap.body["kind"]).toBe("read.text");
    expect(overlap.body["segments"]).toBeUndefined();
    const evidence = (overlap.body["evidence"] ?? []) as Array<Record<string, unknown>>;
    const body = String(evidence[0]?.["body"] ?? "");
    expect(body).toContain("L30 = 30");
    expect(body).toContain("L55 = 55");
    expect(JSON.stringify(overlap.body)).not.toContain("covered_by");
  });
});
