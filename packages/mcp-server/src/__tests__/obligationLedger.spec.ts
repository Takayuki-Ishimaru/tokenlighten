import { describe, expect, it } from "vitest";
import {
  CAPACITY_OBLIGATION,
  MAX_LEDGER_OBLIGATIONS,
  ObligationLedger,
  dischargeCertificate,
  ledgerDigest,
} from "../state/obligationLedger.js";

describe("ObligationLedger", () => {
  it("only grows and only permits a single immutable proof transition", () => {
    const ledger = new ObligationLedger();
    const obligation = {
      kind: "dependency-definition",
      target: "src/tax.ts#applyTax",
      polarity: "evidence" as const,
      origin: "query" as const,
    };

    expect(ledger.add(obligation)).toBe("added");
    expect(ledger.add(obligation)).toBe("duplicate");
    expect(ledger.prove(obligation, { type: "served", witness: "h-tax" })).toBe("proved");
    expect(ledger.prove(obligation, { type: "served", witness: "h-tax" })).toBe("kept-first");

    expect(ledger.snapshot().obligations).toEqual([{ ...obligation, proof: { type: "served", witness: "h-tax" } }]);
    // RE-PIN (A-F4, 2026-08-28): these two were `.toThrow(...)`. Both throws sat
    // on the read_file / search_files hot path, and the conflicting re-prove is
    // reached by the P0-2 repair flow itself — taskContractStore proves the
    // open-universe obligation with an `explicit-gap` capability witness and a
    // later prescribed absence re-proves it as `authoritative-absent`. The
    // GUARANTEE is unchanged and is asserted below the calls: the first proof
    // still stands and is never replaced. Only the failure MODE moved, from an
    // exception a live agent would receive as an RPC error to a return value.
    expect(ledger.prove(obligation, { type: "explicit-gap", witness: "other" })).toBe("kept-first");
    expect(ledger.prove({ ...obligation, target: "src/unknown.ts" }, { type: "served", witness: "h" })).toBe("not-recorded");
    expect(ledger.snapshot().obligations).toEqual([{ ...obligation, proof: { type: "served", witness: "h-tax" } }]);
  });

  it("has a stable restart-safe digest and rejects unbounded obligation growth", () => {
    const ledger = new ObligationLedger();
    for (let index = 0; index < MAX_LEDGER_OBLIGATIONS; index += 1) {
      ledger.add({
        kind: "all-references",
        target: `symbol-${index}`,
        polarity: "evidence",
        origin: "evidence-expansion",
      });
    }

    const snapshot = ledger.snapshot();
    expect(ObligationLedger.fromSnapshot(snapshot).snapshot()).toEqual(snapshot);
    expect(ledgerDigest(snapshot)).toBe(snapshot.digest);
    // RE-PIN (A-F4, 2026-08-28): was `.toThrow(/limit/)`. `recordEvidenceExpansion`
    // calls `add` unconditionally over a caller-sized target list, so the limit
    // was an uncaught exception on the read/search path. The bound is still
    // enforced — the overflowing obligation is NOT tracked — but the ledger now
    // DISCLOSES that it stopped tracking, via a self-proving capacity marker,
    // instead of failing the call. Silent truncation would be the worse of the
    // three options; A-5(2) makes any cap's residue disclosable.
    expect(ledger.add({
      kind: "all-references",
      target: "overflow",
      polarity: "evidence",
      origin: "query",
    })).toBe("capacity-exhausted");
    const after = ledger.snapshot();
    expect(after.obligations.some((entry) => entry.target === "overflow")).toBe(false);
    expect(after.obligations).toContainEqual(expect.objectContaining({
      ...CAPACITY_OBLIGATION,
      proof: expect.objectContaining({ type: "explicit-gap" }),
    }));
    // The marker is the ONE entry allowed above the cap, and it survives a
    // restart byte-for-byte.
    expect(after.obligations.length).toBe(MAX_LEDGER_OBLIGATIONS + 1);
    expect(ObligationLedger.fromSnapshot(after).snapshot()).toEqual(after);
    // An explicit-gap IS a discharge, so a truncated ledger stays certifiable
    // rather than being permanently blocked by its own bound.
    expect(dischargeCertificate(ledger)).toBeUndefined();
  });

  /**
   * A-F4 hot-path totality. Both throws were reachable from read_file /
   * search_files dispatch; a thrown ledger error there becomes an RPC error
   * handed to a live agent. This drives the exact P0-2 repair sequence — cap
   * exhaustion, then a conflicting re-prove of an already-gapped obligation —
   * and asserts the API is total.
   */
  it("never throws on the read/search hot path, whatever the caller does", () => {
    const ledger = new ObligationLedger();
    const openUniverse = {
      kind: "dependency-definitions",
      target: "open-universe",
      polarity: "evidence" as const,
      origin: "evidence-expansion" as const,
    };
    expect(() => {
      ledger.add(openUniverse);
      // taskContractStore.recordExplicitGap: a capability limit is a proof.
      ledger.prove(openUniverse, { type: "explicit-gap", witness: "1-hop expansion cap" });
      // taskContractStore.recordAuthoritativeAbsentConcerns, same task, later
      // call: the prescribed absence proves the SAME obligation differently.
      ledger.prove(openUniverse, { type: "authoritative-absent", witness: "authoritative-absent" });
      for (let index = 0; index < MAX_LEDGER_OBLIGATIONS * 2; index += 1) {
        ledger.add({ kind: "all-references", target: `t-${index}`, polarity: "evidence", origin: "evidence-expansion" });
      }
      ledger.prove({ kind: "never", target: "recorded", polarity: "edit" }, { type: "served", witness: "x" });
    }).not.toThrow();
    const proof = ledger.snapshot().obligations
      .find((entry) => entry.kind === "dependency-definitions" && entry.target === "open-universe")?.proof;
    expect(proof).toEqual({ type: "explicit-gap", witness: "1-hop expansion cap" });
  });

  /**
   * A-F3 (2026-08-28): an EMPTY ledger certified, because `[].every(...)` is
   * vacuously true. Its digest then flowed into the certificate id, so the wire
   * carried the ledger-bound `ready-<ledger16>-<proof16>` form — a claim that a
   * requirement set had been discharged, over zero requirements, which
   * `ledgerCertificateBindingValid` then accepted as self-consistent. An accept
   * with no ledger is still allowed (it is v0.12's non-exhaustive behavior); it
   * just may not be dressed as a discharge.
   */
  it("mints nothing at all for a ledger that recorded no obligation", () => {
    expect(dischargeCertificate(new ObligationLedger())).toBeUndefined();
  });

  it("mints a branded discharge certificate only after every obligation has a proof", () => {
    const ledger = new ObligationLedger();
    const first = { kind: "dependency-definitions", target: "applyTax", polarity: "evidence" as const, origin: "query" as const };
    const second = { kind: "all-references", target: "invoice", polarity: "evidence" as const, origin: "query" as const };
    ledger.add(first);
    ledger.add(second);
    expect(dischargeCertificate(ledger)).toBeUndefined();

    ledger.prove(first, { type: "served", witness: "applyTax" });
    expect(dischargeCertificate(ledger)).toBeUndefined();

    ledger.prove(second, { type: "explicit-gap", witness: "references require user scope" });
    expect(dischargeCertificate(ledger)).toEqual({ digest: ledger.snapshot().digest, [Object.getOwnPropertySymbols(dischargeCertificate(ledger)!)[0]!]: true });
  });
});
