/**
 * readPathAdviceAgreement.spec.ts — in-process pins for four read-path
 * defects of the v0.16 decision runs (2026-10-19). The recorded call shapes
 * are pinned against a real server in rc/readPathAdviceAgreement.rc.spec.ts;
 * this file pins each rule at its own seam.
 *
 *  a. A prepared edit certificate trims every `mode:"full"` read to a
 *     `read.map` (W5b), including the zoom the pack itself advises:
 *     `{targets:[{handle}], content:"full"}` (6t-3 T13 rep1 #2). A read
 *     addressed by a handle the server minted is a zoom, not broad discovery:
 *     it reaches the ordinary full read. A path-addressed one is still trimmed.
 *  b. `concern_note` was judged per window of a ranges[] read and blind to
 *     the served-range ledger, so it named lines the same reply (and an
 *     earlier pack) served, and its remedy named `mode=symbol`, a legacy
 *     input refused by default (6t-2 T13 rep1 #6, 6t-3 T13 rep1 #3, rep2 #16).
 *  c. A small caller-named window that is mostly one comment block was served
 *     with that block elided (6t-2 T13 rep0 #14, 6t-3 T13 rep2 #20).
 *  d. The verifying fence's loop brake counted the comment windows a read's
 *     own rendering elides as owed, so the third identical `range:"full"`
 *     read of a file whose header comment was elided met the brake's
 *     refusal instead of the held receipt.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { TaskExecutionContract } from "@tokenlighten/types";

import {
  getExecutionFence,
  guardExecutionDiscovery,
  guardExecutionEdit,
  recordConcernTokens,
  recordExecutionContract,
  recordExecutionEditResult,
  recordServedRange,
  resetAll,
} from "../util/session.js";
import { buildSmallFileConcernNote, resolveSlice, resolveSliceRanges } from "../tools/readCodeModes.js";
import {
  EXPLICIT_COMMENT_WINDOW_MAX_LINES,
  elideDocCommentsForDisplay,
  elideDocCommentsForExplicitWindow,
} from "../util/formatCompress.js";
import { shaOfText } from "../util/handles.js";

/** The executionTypestate.spec.ts ready contract: one evidence file, `src/order.ts`, handle `h-ready`. */
function readyContract(action: "answer" | "edit" = "edit"): TaskExecutionContract {
  const handle = "h-ready";
  return {
    version: 1,
    state: "ready",
    readiness: action === "answer" ? "answer-ready" : "edit-ready",
    discovery_complete: true,
    next_action: action,
    max_additional_discovery_calls: 0,
    reason: "test proof",
    readiness_certificate: {
      version: 1,
      id: "ready-cert-1",
      task_fingerprint: "task-1",
      profile: action === "answer" ? "answer" : "change_propagation",
      obligations: [{
        id: "behavior-body",
        kind: "behavior-body",
        status: "proved",
        required: true,
        evidence: [{ handle, path: "src/order.ts", range: "1-20", symbol: "transition" }],
        reason: "callable body served",
      }],
      evidence_handles: [handle],
      action_frontier: action === "edit" ? [handle] : [],
      falsification: { version: 1, checked: ["callable-body"], counterexamples: [], unresolved: [] },
      risk: {
        policy: "selective-reject",
        estimated_false_ready_risk: 0.01,
        max_false_ready_risk: 0.05,
        decision: "accept",
        factors: [],
      },
    },
    typestate: {
      phase: "prepared",
      certificate_id: "ready-cert-1",
      allowed_actions: action === "answer" ? ["answer", "challenge"] : ["edit", "challenge"],
      challenge_required_for: action === "answer" ? ["read", "search", "edit"] : ["read", "search"],
    },
    call_budget: {
      version: 2,
      policy: "expected-decision-change",
      normalized_turn_cost: 0.18,
      expected_decision_change: 0.01,
      expected_value: 0.011,
      decision_threshold: 0.18,
      discovery_allowed: false,
      terminal_action: action,
      reason: "low value",
    },
  };
}

afterEach(() => resetAll());

describe("a. the post-ready trim leaves a handle-addressed full read to the ordinary full read", () => {
  const resolveHandlePath = (handle: string): string | undefined => (handle === "h-pack" ? "src/order.ts" : undefined);

  it("{mode:\"full\", handle, path} (6t-3 T13 rep1 #2, the pack's own advice) is allowed untrimmed", () => {
    const root = "/workspace/advice-full-handle";
    recordExecutionContract(root, "change QuoteOrchestrator transition", readyContract("edit"));
    expect(getExecutionFence(root)?.phase).toBe("prepared");
    expect(guardExecutionDiscovery(root, "tl_read_file", {
      mode: "full",
      handle: "h-pack",
      path: "src/order.ts",
    }, resolveHandlePath)).toEqual({ allowed: true });
    // The handle alone, too.
    expect(guardExecutionDiscovery(root, "tl_read_file", { mode: "full", handle: "h-pack" }, resolveHandlePath))
      .toEqual({ allowed: true });
  });

  it("control: a path-addressed full read, and a handle the server cannot resolve, keep the post-ready trim", () => {
    const root = "/workspace/advice-full-path";
    recordExecutionContract(root, "change QuoteOrchestrator transition", readyContract("edit"));
    expect(guardExecutionDiscovery(root, "tl_read_file", { mode: "full", path: "src/order.ts" }, resolveHandlePath))
      .toEqual({ allowed: true, postReadyTrim: true });
    expect(guardExecutionDiscovery(root, "tl_read_file", { mode: "full", handle: "h-unknown", path: "src/broad.ts" }, resolveHandlePath))
      .toEqual({ allowed: true, postReadyTrim: true });
    // Without a resolver nothing proves the handle is the server's own.
    expect(guardExecutionDiscovery(root, "tl_read_file", { mode: "full", handle: "h-pack" }))
      .toEqual({ allowed: true, postReadyTrim: true });
    // force_serve stays the unconditional recovery it was.
    expect(guardExecutionDiscovery(root, "tl_read_file", { mode: "full", path: "src/order.ts", force_serve: true }, resolveHandlePath))
      .toEqual({ allowed: true });
  });
});

/** A file whose concern token sits at L3 and L50, everything else inert. */
function concernFile(): string {
  const lines: string[] = [];
  for (let line = 1; line <= 60; line++) {
    lines.push(line === 3 || line === 50 ? `  const estimator_${line} = ${line};` : `  const filler_${line} = ${line};`);
  }
  return `${lines.join("\n")}\n`;
}

describe("b. concern_note counts every window of the reply and the lines the session holds", () => {
  it("a ranges[] read whose first window shows the token carries no note (6t-3 T13 rep1 #3 named L26-28 its own first window served)", async () => {
    const root = "/workspace/concern-union";
    recordConcernTokens(root, ["estimator"]);
    const content = concernFile();
    const result = await resolveSliceRanges(root, "src/estimator.ts", content, ["1-10", "20-30"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.concern_note).toBeUndefined();
  });

  it("a line the served-range ledger holds is not named (6t-3 T13 rep2 #16 named L26-28 and L81, both held)", async () => {
    const root = "/workspace/concern-ledger";
    recordConcernTokens(root, ["estimator"]);
    const content = concernFile();
    recordServedRange(root, "src/estimator.ts", shaOfText(content), 45, 55, 60);
    const result = await resolveSlice(root, "src/estimator.ts", content, undefined, "20-30");
    expect(result.ok).toBe(true);
    const note = result.ok ? result.data.concern_note : undefined;
    expect(note).toBe(
      "session-query tokens (estimator) hit lines not served yet: L3 — read them with targets:[{path, range}] or targets:[{path, symbol}]",
    );
  });

  it("the remedy names the canonical read forms, never the refused mode=symbol, and survives the length cap", async () => {
    const root = "/workspace/concern-wording";
    const longTokens = ["netresourcemountpointalpha", "netresourcemountpointbravo", "netresourcemountpointcharlie"];
    recordConcernTokens(root, longTokens);
    const lines = Array.from({ length: 40 }, (_, index) => `  const filler_${index + 1} = 0;`);
    lines[34] = `  ${longTokens.join(" + ")};`;
    const content = `${lines.join("\n")}\n`;
    const result = await resolveSlice(root, "src/mount.ts", content, undefined, "1-10");
    expect(result.ok).toBe(true);
    const note = String(result.ok ? result.data.concern_note : "");
    expect(note.length).toBeLessThanOrEqual(180);
    expect(note).not.toContain("mode=symbol");
    expect(note.endsWith(" — read them with targets:[{path, range}] or targets:[{path, symbol}]")).toBe(true);
    expect(note).toContain("L35");
  });

  it("the outline sibling names the canonical forms too (it said \"read mode=slice or mode=full\")", () => {
    const root = "/workspace/concern-outline";
    recordConcernTokens(root, ["estimator"]);
    expect(buildSmallFileConcernNote(root, "src/estimator.ts", concernFile(), "1: const filler_1 = 1;")).toBe(
      "session-query tokens (estimator) hit lines not shown in this outline: L3, L50 — read them with targets:[{path, range}] or targets:[{path, symbol}]",
    );
  });

  it("control: a partial window missing the token still fires once, naming the unserved hit", async () => {
    const root = "/workspace/concern-control";
    recordConcernTokens(root, ["estimator"]);
    const content = concernFile();
    const first = await resolveSlice(root, "src/estimator.ts", content, undefined, "10-20");
    expect(first.ok && first.data.concern_note).toContain("L3, L50");
    const second = await resolveSlice(root, "src/estimator.ts", content, undefined, "30-40");
    expect(second.ok && second.data.concern_note).toBeUndefined();
  });
});

/** `count` comment lines inside a C block comment, then `code` code lines. */
function commentThenCode(comment: number, code: number): string {
  const lines = ["/*", ...Array.from({ length: Math.max(0, comment - 2) }, (_, index) => ` * note line ${index + 1}`), " */"];
  for (let index = 0; index < code; index++) lines.push(`int value_${index} = ${index};`);
  return lines.join("\n");
}

describe("c. a small caller-named window that is mostly comment keeps its comment", () => {
  it("6t-3 T13 rep2 #20's shape: a 30-line window with a 19-line header is served raw", () => {
    const text = commentThenCode(19, 11);
    expect(elideDocCommentsForDisplay(text, "cpp", false, 1).elided).toEqual([[1, 19]]);
    const display = elideDocCommentsForExplicitWindow(text, "cpp", 1, 262);
    expect(display.content).toBe(text);
    expect(display.elided).toEqual([]);
    expect(display.note).toBe("comment window kept (one comment block fills most of the lines you named)");
  });

  it("6t-2 T13 rep0 #14's shape: 209-222, a blank line, a 9-line comment and 4 code lines, is served raw", () => {
    const text = ["", ...commentThenCode(9, 4).split("\n")].join("\n");
    const display = elideDocCommentsForExplicitWindow(text, "cpp", 209, 503);
    expect(elideDocCommentsForDisplay(text, "cpp", false, 209).elided).toEqual([[210, 218]]);
    expect(display.content).toBe(text);
    expect(display.elided).toEqual([]);
  });

  it("control: under half comment (6t-2 T13 rep0 #13, 206-240 at 40%) keeps the default elision", () => {
    const text = commentThenCode(14, 21);
    const display = elideDocCommentsForExplicitWindow(text, "cpp", 206, 503);
    expect(display).toEqual(elideDocCommentsForDisplay(text, "cpp", false, 206));
    expect(display.elided).toEqual([[206, 219]]);
  });

  it("control: short doc blocks interleaved with code keep the default elision, however much of the window they add up to", () => {
    // evaluation0929.sliceWireModel.spec.ts's fixture: a 4-line block before every code line (80% comment).
    const text = Array.from({ length: 6 }, (_, i) => `/**\n * Doc for item ${i}.\n * More text here.\n */\nexport const D${i} = ${i};`).join("\n");
    const display = elideDocCommentsForExplicitWindow(text, "typescript", 1, 60);
    expect(display).toEqual(elideDocCommentsForDisplay(text, "typescript", false, 1));
    expect(display.elided).toHaveLength(6);
  });

  it("control: a window longer than the limit keeps the default elision however much of it is comment", () => {
    const text = commentThenCode(EXPLICIT_COMMENT_WINDOW_MAX_LINES, 1);
    const display = elideDocCommentsForExplicitWindow(text, "cpp", 1, 500);
    expect(display.elided).toEqual([[1, EXPLICIT_COMMENT_WINDOW_MAX_LINES]]);
    expect(display.content).not.toBe(text);
    // At the limit itself, the rule applies.
    const atLimit = commentThenCode(EXPLICIT_COMMENT_WINDOW_MAX_LINES - 1, 1);
    expect(elideDocCommentsForExplicitWindow(atLimit, "cpp", 1, 500).content).toBe(atLimit);
  });

  it("control: a window that is the whole file (1-N, range:\"full\") keeps the whole-file rendering", () => {
    const text = commentThenCode(19, 11);
    expect(elideDocCommentsForExplicitWindow(text, "cpp", 1, 30)).toEqual(elideDocCommentsForDisplay(text, "cpp", false, 1));
    // One line short of the end is a window again.
    expect(elideDocCommentsForExplicitWindow(text, "cpp", 1, 31).content).toBe(text);
  });

  it("control: a window with no comment, or all comment, renders exactly as elideDocCommentsForDisplay does", () => {
    const code = "int a = 1;\nint b = 2;";
    expect(elideDocCommentsForExplicitWindow(code, "cpp", 5, 100)).toEqual(elideDocCommentsForDisplay(code, "cpp", false, 5));
    const comment = commentThenCode(6, 0);
    expect(elideDocCommentsForExplicitWindow(comment, "cpp", 5, 100)).toEqual(elideDocCommentsForDisplay(comment, "cpp", false, 5));
  });
});

describe("d. the loop brake leaves the request's own elided comment windows out of its held check", () => {
  /** The ready contract, its edit, and the file the edit's verifying fence watches: `src/order.ts`, 51 lines, header 1-7. */
  function verifyingFence(root: string): { sha: string } {
    recordExecutionContract(root, "change QuoteOrchestrator transition", readyContract("edit"));
    expect(guardExecutionEdit(root, { handle: "h-ready", search: "a", replace: "b" })).toEqual({ allowed: true });
    recordExecutionEditResult(root, true);
    expect(getExecutionFence(root)?.phase).toBe("verifying");
    const sha = shaOfText("post-edit order.ts");
    // What a default-policy range:"full" read of the post-edit file put on
    // the wire: everything but the doc-comment header 1-7.
    recordServedRange(root, "src/order.ts", sha, 8, 51, 51, { mode: "slice", range: "1-51", call: 3 });
    return { sha };
  }
  const readFull = { mode: "slice", path: "src/order.ts", range: "full" };

  it("the third identical range:\"full\" read is the receipt for the held lines 8-51, never claiming the header", () => {
    const root = "/workspace/brake-elision";
    const { sha } = verifyingFence(root);
    const probe = (path: string, probedSha: string, start: number, end: number) =>
      (path === "src/order.ts" && probedSha === sha && start === 1 && end === 51 ? [[1, 7] as const] : undefined);
    expect(guardExecutionDiscovery(root, "tl_read_file", { ...readFull }, undefined, false, probe)).toEqual({ allowed: true });
    expect(guardExecutionDiscovery(root, "tl_read_file", { ...readFull }, undefined, false, probe)).toEqual({ allowed: true });
    const third = guardExecutionDiscovery(root, "tl_read_file", { ...readFull }, undefined, false, probe);
    expect(third.allowed).toBe(false);
    expect("servedReceipt" in third).toBe(true);
    if (third.allowed === false && "servedReceipt" in third) {
      expect(third.servedReceipt).toMatchObject({
        reason: "already-served",
        code_unchanged: true,
        path: "src/order.ts",
        windows: [{ range: "8-51", code_unchanged: true, served_by: "slice 1-51 (call #3)" }],
      });
      expect(third.servedReceipt["remaining_ranges"]).toBeUndefined();
    }
  });

  it("control: without the probe (a comments:\"keep\" request), or with a held gap outside the comment, the brake still refuses", () => {
    const root = "/workspace/brake-elision-control";
    const { sha } = verifyingFence(root);
    for (let call = 1; call <= 2; call++) guardExecutionDiscovery(root, "tl_read_file", { ...readFull });
    const noProbe = guardExecutionDiscovery(root, "tl_read_file", { ...readFull });
    expect(noProbe.allowed === false && "refusal" in noProbe && noProbe.refusal["reason"]).toBe("execution-typestate");

    // The probe elides only 1-5: lines 6-7 are owed and unheld.
    const narrow = (_path: string, probedSha: string) => (probedSha === sha ? [[1, 5] as const] : undefined);
    const other = { mode: "slice", path: "src/order.ts", range: "1-51" };
    for (let call = 1; call <= 2; call++) guardExecutionDiscovery(root, "tl_read_file", { ...other }, undefined, false, narrow);
    const gap = guardExecutionDiscovery(root, "tl_read_file", { ...other }, undefined, false, narrow);
    expect(gap.allowed === false && "refusal" in gap && gap.refusal["reason"]).toBe("execution-typestate");
  });
});
