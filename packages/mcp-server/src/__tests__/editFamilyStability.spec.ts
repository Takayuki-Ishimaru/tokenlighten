/**
 * editFamilyStability.spec.ts — PQ2 fix-wave (orchestrator-directed, 2026-08-14).
 *
 * §4.2.1(1) SE-STABLE, at the CLASSIFICATION layer. `kindForCall`'s
 * WRITE_TOOLS branch is the only place a completed side effect could be
 * re-labelled "nothing was attempted", and until this wave it carried an
 * `edit !== "edit.applied"` carve-out that let exactly one side-effect kind —
 * the most common one — fall through to the refusal test. `envelope.ts`'s
 * payload ternary used to cite this spec BEFORE IT EXISTED (work-order §2.5
 * item 2 called that out); it exists now, and pins the closed hole:
 *
 *   (a) an applied-SHAPED body (the `ok:true` signature every write-success
 *       emitter sets) classifies `edit.applied` even when refusal-ish fields
 *       (`code`, `error`) ride alongside, under EITHER transport flag;
 *   (b) the ledger members keep winning over the refusal test (existing
 *       behaviour, re-pinned here beside (a) so the whole branch is covered
 *       in one file);
 *   (c) a genuine write refusal (`ok:false`, no ledger, no applied signature)
 *       still classifies `refusal` — the fix must not swallow real refusals;
 *   (d) a signature-less, refusal-less write body keeps the `edit.applied`
 *       fallback (the pre-wave default, unchanged for reachable bodies).
 *
 * (a) is the regression this wave exists for; (c)/(d) are the byte-neutrality
 * fence — the 15 wire pins and the 237-case corpus prove the same thing at
 * scale, but these name the exact branch.
 */
import { describe, expect, it } from "vitest";

import { kindForCall } from "../protocol/envelope.js";

type Body = Record<string, unknown>;

const CTX = { tool: "edit_file" } as const;

describe("editFamilyStability — kindForCall's WRITE_TOOLS branch (PQ2)", () => {
  it("(a) an applied-shaped body with refusal-ish fields is NOT reclassified as refusal, under either transport flag", () => {
    const appliedWithNoise: Body = {
      ok: true,
      path: "src/a.ts",
      lines: "1",
      delta: "+1/-1",
      handle: "h1",
      // Refusal-ish riders: the old carve-out let these reach `isRefusalBody`.
      code: "invalid-input",
      error: "spurious prose a buggy emitter might attach",
    };
    expect(kindForCall(CTX, appliedWithNoise, false)).toBe("edit.applied");
    expect(kindForCall(CTX, appliedWithNoise, true)).toBe("edit.applied");
  });

  it("(b) the ledger members always win, under either transport flag", () => {
    const clean: Body = {
      ok: false,
      error: "Cannot write file: EACCES",
      code: "write-error",
      rollback: [{ path: "src/a.ts", state: "rolled-back" }],
    };
    const failed: Body = {
      ok: false,
      code: "rollback-failed",
      workspace_state: "workspace-state-unknown",
      rollback: [{ path: "src/a.ts", state: "restore-failed" }],
    };
    for (const isError of [false, true]) {
      expect(kindForCall(CTX, clean, isError)).toBe("edit.rolled_back");
      expect(kindForCall(CTX, failed, isError)).toBe("edit.state_unknown");
    }
  });

  it("(c) a genuine write refusal still classifies refusal — the fix swallows nothing", () => {
    const refusal: Body = {
      ok: false,
      code: "write-intent-ambiguous",
      error: "ambiguous write intent",
    };
    expect(kindForCall(CTX, refusal, true)).toBe("refusal");
    // `isError` is advisory input (§2.5): `ok:false` alone is enough.
    expect(kindForCall(CTX, refusal, false)).toBe("refusal");
  });

  it("(d) a signature-less, refusal-less write body keeps the edit.applied fallback", () => {
    expect(kindForCall(CTX, {}, false)).toBe("edit.applied");
  });
});
