/**
 * requiredSetViolationRefusal.spec.ts — MX-B group 1 (FIXALL-B, 2026-09-14).
 *
 * `protocol/emit.ts`'s `enforceRequiredSet` used to diverge by accident of
 * configuration when the payload it was about to ship violated its own A.4.3
 * required set: under `TL_DECISION_INVARIANT_STRICT` (this package's own
 * `vitest.config.ts` test env — see that file's own comment) it threw an
 * unhandled `Error`, which reaches a real MCP client as an opaque JSON-RPC
 * -32603 internal error; without the flag the malformed payload shipped
 * silently (an empty `evidence:[]` on a `read.text` response, in the
 * concretely observed case: `scratchpad/matrix-B-inventory.md` group 1, a
 * bare `targets:[{handle}]` re-read of a handle minted against a 0-line
 * file). Neither is what `emitSideEffectViolationRefusal` already modeled
 * for the side-effect kinds (`edit.applied`/`edit.rolled_back`/
 * `edit.state_unknown`): a structured, well-formed refusal, in every mode.
 *
 * These two tests pin the fix directly against `emitFinalizedPayload` — the
 * same harness `ledgerCertificateBinding.spec.ts` already uses for the
 * sibling violation class (an unverifiable act certificate) — so a
 * regression back to either old behaviour (a thrown `Error`, or a payload
 * that ships with fewer than the one required `FreshEvidence` entry) fails
 * loudly here rather than only inside a spawned-server matrix run.
 */
import { describe, expect, it } from "vitest";
import { emitFinalizedPayload } from "../protocol/emit.js";

/** A `read.text` payload that violates A.5.2's non-empty `evidence` tuple. */
function violatingReadTextPayload(): Record<string, unknown> {
  return { v: 1, kind: "read.text", evidence: [] };
}

describe("required-set violation refusal (MX-B group 1)", () => {
  it("converts a read.text required-set violation into a structured refusal under TL_DECISION_INVARIANT_STRICT (this suite's own default)", () => {
    // No env manipulation: packages/mcp-server/vitest.config.ts's own test
    // env already sets TL_DECISION_INVARIANT_STRICT=1 for every test in this
    // package (the same flag every spawned child server in the matrix
    // inherits) — this call therefore exercises exactly the branch that used
    // to `throw new Error(...)` and crash the whole tool call.
    expect(process.env["TL_DECISION_INVARIANT_STRICT"]).toBeTruthy();
    let emitted: ReturnType<typeof emitFinalizedPayload> | undefined;
    expect(() => {
      emitted = emitFinalizedPayload(violatingReadTextPayload(), "read.text", { tool: "read_file" });
    }).not.toThrow();
    expect(emitted).toBeDefined();
    expect(emitted!.isError).toBe(true);
    const body = JSON.parse((emitted!.content as Array<{ text: string }>)[0]!.text) as Record<string, unknown>;
    expect(body["kind"]).toBe("refusal");
    expect(body["retry"]).toBe("none");
    // The violated set is named in the detail, not swallowed into an opaque
    // "internal error" — the same honesty `describeVerdict` already gives
    // the side-effect refusal class.
    expect(String(body["detail"])).toContain("read.text/evidence-fresh-addressed");
  });

  it("converts the SAME violation into the SAME structured refusal shape with the flag off (the production default)", () => {
    const previous = process.env["TL_DECISION_INVARIANT_STRICT"];
    process.env["TL_DECISION_INVARIANT_STRICT"] = "off";
    try {
      // Before this fix, THIS branch (non-strict) returned `undefined` from
      // `enforceRequiredSet`, so the caller's original, required-set-
      // violating payload shipped unmodified — `evidence:[]` and all,
      // exactly the shape `scratchpad/matrix-B-inventory.md` group 1
      // measured reaching a real client silently.
      const emitted = emitFinalizedPayload(violatingReadTextPayload(), "read.text", { tool: "read_file" });
      expect(emitted.isError).toBe(true);
      const body = JSON.parse((emitted.content as Array<{ text: string }>)[0]!.text) as Record<string, unknown>;
      expect(body["kind"]).toBe("refusal");
      expect(body["retry"]).toBe("none");
      expect(String(body["detail"])).toContain("read.text/evidence-fresh-addressed");
      // Never the old malformed shape: an empty-evidence read.text response
      // shipping as though nothing were wrong with it.
      expect(body["kind"]).not.toBe("read.text");
    } finally {
      if (previous === undefined) delete process.env["TL_DECISION_INVARIANT_STRICT"];
      else process.env["TL_DECISION_INVARIANT_STRICT"] = previous;
    }
  });

  it("still routes a side-effect kind's required-set violation through the pre-existing disk-state warning, unchanged", () => {
    // `emitSideEffectViolationRefusal` (the sibling this fix's function is
    // modeled on) already handled edit.* kinds correctly in every mode; this
    // pins that the new general branch did not accidentally swallow it.
    const emitted = emitFinalizedPayload({ v: 1, kind: "edit.applied" }, "edit.applied", { tool: "edit_file" });
    expect(emitted.isError).toBe(true);
    const body = JSON.parse((emitted.content as Array<{ text: string }>)[0]!.text) as Record<string, unknown>;
    expect(body["kind"]).toBe("refusal");
    expect(String(body["detail"])).toContain("fail-closed side-effect");
    expect(String(body["detail"])).toContain("The write may have reached disk");
  });
});
