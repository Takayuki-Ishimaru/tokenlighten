import type { ToolCallResult } from "../../../protocol/result.js";
import { recordReadMode, markClosureSatisfied, clearClosureSatisfied, recordClosureReport } from "../../../state/session.js";
import { computeClosureStateSafe, CLOSURE_SATISFIED_NOTE } from "../../../util/closureTracking.js";
import { getFunctionalValidationObligation } from "../../../util/packServeLog.js";
import { toolOk } from "../../../protocol/result.js";
import { verifyWithholdsCompletion } from "../../../protocol/readFamily.js";
import { withVerificationSection } from "../../../serverOwned/verification2.js";
import { closureSessionSummary } from "../../../serverOwned/search-support.js";

export interface read_closurePort {
  "mode": string;
  "workspace": string;
}
export async function read_closure(port: read_closurePort): Promise<ToolCallResult | undefined> {
  const { mode, workspace } = port;
if (mode === "closure") {
        recordReadMode(workspace, "closure");
        const computed = computeClosureStateSafe(workspace);
        // W5 (2026-07-25 T10 verify-fail forensics): an artifact-backed
        // executable create/edit carries a functional-validation obligation.
        // It is DISCLOSED here as an open item — never a refusal — and is
        // discharged by a diff review (tl_search_files action=diff), the only
        // verification-evidence event this server can observe directly.
        const w5Obligation = getFunctionalValidationObligation(workspace, []);
        const w5OpenItem = w5Obligation === undefined
          ? undefined
          : `${w5Obligation.targetPath}: ${w5Obligation.note}`.slice(0, 140);
        if (computed === undefined || computed.total === 0) {
          return toolOk(withVerificationSection({
            mode: "closure", open: w5OpenItem === undefined ? [] : [w5OpenItem], done: 0, total: 0, complete: false,
            // 2026-08-01: names the gate's applicability instead of leaving
            // "complete:false" to read as "task incomplete" on read-only
            // sessions. Deliberately NOT an affirmative completion signal —
            // FIX-1's hollow-completion fence (complete:false) stays.
            applicability: "no-registered-checks",
            note: "no closure checks were registered for this session — completeness NOT verified; verify with git diff / tests (this call is only needed after an edit response carried a closure field)",
            summary: closureSessionSummary(workspace, 0),
          }, workspace));
        }
        const open = computed.open
          .slice(0, 8)
          .map((c) => (c.desc.length > 140 ? c.desc.slice(0, 140) : c.desc));
        if (w5OpenItem !== undefined && open.length < 8) open.push(w5OpenItem);
        const closureIsComplete = computed.open.length === 0 && w5Obligation === undefined;
        // ---------------------------------------------------------------
        // FX-G-A (round-12 finding 2): the VF-7 gate is decided ONCE, on the
        // body this call actually returns (`emitClosure` below). The separate
        // probe body it replaces was wrong twice over:
        //
        //  (a) UNCONDITIONAL. It was not gated on the lever, so every
        //      `mode=closure` call on DEFAULT flags paid an extra
        //      `buildVerificationManifest` walk AND consumed the
        //      once-per-session "unserved" ledger
        //      (`buildVerificationBodyDetailed` -> `markVerificationPathsServed`,
        //      `dropServedBody` -> `markVerificationSurfaceServed`/
        //      `recordServedRange`, the latter added by FX-O2). The REAL
        //      body then took the body-stripped re-serve branch and minted
        //      extra kit handles through `labelKitBodies` -> `handleTable.upsert`
        //      — unconditional cost, and accelerated handle eviction, for a
        //      lever that is off. `withVerificationSection` is NOT side-effect
        //      free; calling it twice per closure call IS the defect.
        //  (b) NOT THE RESPONSE BODY. The probe was a bare `{mode:"closure"}`
        //      with no `summary`, and `derivedVerifyObligations` builds its
        //      edited set from `summary.files` plus `compile_facts[].path` plus
        //      `surfaces[].references`. So the SESSION decision
        //      (`markClosureSatisfied`) and the WIRE decision (`receiptOf`
        //      withholding `closure-complete`) were computed from two
        //      different obligation sets, with the session side biased
        //      permissive. VF-7's whole point is that the two agree.
        //
        // With `TL_SF_VERIFY_FIRST` off this is byte-identical AND
        // session-state-identical to the pre-wave code: exactly one
        // `withVerificationSection` call, and `verifyClosureGate` returns
        // `undefined` on its first line so `closureVerified === closureIsComplete`.
        // ---------------------------------------------------------------
        const emitClosure = (raw: Record<string, unknown>): ReturnType<typeof toolOk> => {
          const body = withVerificationSection(raw, workspace);
          const closureVerified = closureIsComplete && !verifyWithholdsCompletion(body, workspace);
          // 2026-07-16a re-read-loop forensics: sibling of attachClosure's own flag-sync (see
          // closureTracking.ts) — this read path recomputes the SAME
          // closureSatisfied flag on every mode=closure call so a stale
          // edit-path evaluation can never leave the flag out of sync with
          // what the agent was just told here.
          if (closureVerified) {
            markClosureSatisfied(workspace);
          } else {
            clearClosureSatisfied(workspace);
          }
          return toolOk(body);
        };

        // A closure evaluation that reaches the same open set adds no evidence
        // and must not re-emit the same descriptions.  `attachClosure` records
        // the edit response's open/closed state through this same ledger, so a
        // ceremonial closure immediately after that response also converges to
        // a receipt.  The functional-validation item is part of the identity:
        // its presence is an open capability gap even though it is not a pack
        // check record.
        const closureIds = [
          ...computed.open.map((check) => check.id),
          ...(w5Obligation === undefined ? [] : [`functional:${w5Obligation.targetPath}`]),
        ];
        const previousClosureIds = recordClosureReport(workspace, closureIds);
        const unchangedClosure = previousClosureIds.length === closureIds.length
          && previousClosureIds.every((id, index) => id === closureIds[index]);
        if (unchangedClosure) {
          // D3(a) (C2-3): `closure-unchanged` IS NOT A RECEIPT FORM in v1 and
          // its name is not even reserved — "a freeze must not invent wire
          // vocabulary". The two real cases it conflated separate:
          //
          //  - everything closed  -> the A.4 `closure-complete` receipt, which
          //    is exactly "all registered checks closed" with its counts;
          //  - still open, same set -> a plain `read.closure` (A.5.7). The
          //    economy this branch exists for is preserved by reporting the
          //    OBLIGATION IDS rather than re-sending the descriptions — and
          //    A.5.7's `open` is documented as "obligation ids still open", so
          //    the ids are the field's own semantics, not a downgrade. Emitting
          //    `open: []` here (the old shape carried no `open` at all) would
          //    have asserted completeness under A.5.7's `open.length === 0`
          //    rule, which is precisely the false claim §4.4 forbids.
          return emitClosure(closureIsComplete
            ? {
                mode: "closure",
                receipt: "closure-complete",
                done: computed.done,
                total: computed.total,
                closure_complete: true,
              }
            : {
                mode: "closure",
                open: closureIds.slice(0, 8),
                done: computed.done,
                total: computed.total,
                note: "same open set as the last closure report — ids only, descriptions were served earlier",
              });
        }

        return emitClosure(closureIsComplete
          ? {
              // A.5.7 is explicit: "the `closure_complete: true` case is NOT
              // this member — it is the `closure-complete` receipt (A.4)".
              mode: "closure",
              receipt: "closure-complete",
              done: computed.done,
              total: computed.total,
              closure_complete: true,
              summary: closureSessionSummary(workspace, computed.done),
              note: CLOSURE_SATISFIED_NOTE,
            }
          : {
              mode: "closure",
              open,
              done: computed.done,
              total: computed.total,
            });
      }
  return undefined;
}
