/**
 * Monotone task obligation state.
 *
 * This is intentionally independent from task-pack inference.  A caller may
 * add obligations and transition an existing obligation to a proof, but cannot
 * remove, narrow, or re-derive the required universe.  Projection consumers
 * must derive frontier/gaps/missing from this ledger rather than retaining a
 * last-pack-only copy.
 *
 * A-F4 (2026-08-28): THE API IS TOTAL. Every mutator lives on the read_file /
 * search_files hot path, so a rejected mutation is reported by RETURN VALUE and
 * never by an exception — a thrown ledger error there is an RPC error handed to
 * a live agent, which is what `TL_DECISION_INVARIANT_STRICT` exists to keep out
 * of production. Two throws had already become reachable:
 *
 *   - the capacity limit, from `recordEvidenceExpansion`'s unconditional
 *     `add()` over a caller-sized target list; and
 *   - the immutable-proof check, from the P0-2 repair flow itself
 *     (taskContractStore proves the open-universe obligation with an
 *     `explicit-gap` capability witness, then a prescribed absence re-proves
 *     the same obligation with `authoritative-absent`).
 *
 * The monotone guarantees are unchanged, and are exactly what makes totality
 * safe: an obligation is never removed or narrowed, and a proof is never
 * REPLACED — a second proof is dropped (keep-first) rather than accepted, so
 * the observable state after a conflicting re-prove is identical to the state a
 * throw would have left, minus the crash.
 */
import { createHash } from "node:crypto";

export const MAX_LEDGER_OBLIGATIONS = 64;
export const MAX_LEDGER_WITNESS_BYTES = 256;

/** Outcome of `add`. `capacity-exhausted` also records the disclosure below. */
export type ObligationAddResult = "added" | "duplicate" | "capacity-exhausted";

/**
 * Outcome of `prove`. `kept-first` covers BOTH an identical re-prove and a
 * conflicting one: the first proof stands either way, and the caller can tell
 * the two apart by reading the snapshot if it ever needs to.
 */
export type ObligationProofResult = "proved" | "kept-first" | "not-recorded";

export type ObligationPolarity = "evidence" | "edit";
export type ObligationOrigin = "query" | "evidence-expansion" | "prescribed-next";
export type ObligationProofType = "served" | "authoritative-absent" | "explicit-gap";

export interface ObligationProof {
  readonly type: ObligationProofType;
  readonly witness: string;
}

export interface Obligation {
  readonly kind: string;
  readonly target: string;
  readonly polarity: ObligationPolarity;
  readonly origin: ObligationOrigin;
  readonly proof?: ObligationProof;
}

export interface ObligationLedgerSnapshot {
  readonly obligations: readonly Obligation[];
  readonly digest: string;
}

const dischargeCertificateBrand: unique symbol = Symbol("dischargeCertificate");

/** Opaque proof that every obligation in one immutable ledger snapshot discharged. */
export interface DischargeCertificate {
  readonly digest: string;
  readonly [dischargeCertificateBrand]: true;
}

/** The self-proving marker `add` records when the capacity limit is reached. */
export const CAPACITY_OBLIGATION: Pick<Obligation, "kind" | "target" | "polarity"> = Object.freeze({
  kind: "ledger-capacity",
  target: "obligation-limit",
  polarity: "evidence",
});

function keyOf(obligation: Pick<Obligation, "kind" | "target" | "polarity">): string {
  return JSON.stringify([obligation.kind, obligation.target, obligation.polarity]);
}

function normalizeWitness(witness: string): string {
  return witness.slice(0, MAX_LEDGER_WITNESS_BYTES);
}

function digestOf(obligations: readonly Obligation[]): string {
  return createHash("sha256").update(JSON.stringify(obligations)).digest("hex");
}

/** The only mutable implementation detail is private to this module. */
export class ObligationLedger {
  private readonly entries = new Map<string, Obligation>();

  has(obligation: Pick<Obligation, "kind" | "target" | "polarity">): boolean {
    return this.entries.has(keyOf(obligation));
  }

  add(obligation: Omit<Obligation, "proof">): ObligationAddResult {
    const key = keyOf(obligation);
    if (this.entries.has(key)) return "duplicate";
    if (this.entries.size >= MAX_LEDGER_OBLIGATIONS) {
      this.noteCapacityExhausted();
      return "capacity-exhausted";
    }
    this.entries.set(key, { ...obligation });
    return "added";
  }

  prove(
    obligation: Pick<Obligation, "kind" | "target" | "polarity">,
    proof: ObligationProof,
  ): ObligationProofResult {
    const key = keyOf(obligation);
    const existing = this.entries.get(key);
    if (existing === undefined) return "not-recorded";
    // KEEP-FIRST. Proof immutability is preserved by DROPPING the second proof,
    // not by throwing: the first witness is the one that was true when it was
    // recorded, and the caller reaching here is the repair flow, not a bug.
    if (existing.proof !== undefined) return "kept-first";
    this.entries.set(key, {
      ...existing,
      proof: { type: proof.type, witness: normalizeWitness(proof.witness) },
    });
    return "proved";
  }

  /**
   * The capacity limit as a DISCLOSURE rather than a failure. The marker is
   * self-proving (`explicit-gap` is a discharge, A-6(2)), so a truncated ledger
   * can still certify — while the caller can see, in the ledger's own
   * projection, that tracking stopped. It is the one entry permitted to sit
   * above `MAX_LEDGER_OBLIGATIONS`, bounding the map at MAX + 1.
   */
  private noteCapacityExhausted(): void {
    const key = keyOf(CAPACITY_OBLIGATION);
    if (this.entries.has(key)) return;
    this.entries.set(key, {
      ...CAPACITY_OBLIGATION,
      origin: "evidence-expansion",
      proof: {
        type: "explicit-gap",
        witness: normalizeWitness(
          `obligation ledger capacity ${MAX_LEDGER_OBLIGATIONS} reached; further obligations are not tracked`,
        ),
      },
    });
  }

  snapshot(): ObligationLedgerSnapshot {
    const obligations = [...this.entries.values()].sort((left, right) =>
      keyOf(left).localeCompare(keyOf(right)),
    );
    return { obligations, digest: digestOf(obligations) };
  }

  static fromSnapshot(snapshot: Pick<ObligationLedgerSnapshot, "obligations">): ObligationLedger {
    const ledger = new ObligationLedger();
    // Restore directly. A snapshot is an ALREADY-BOUNDED ledger, so replaying
    // it through `add` would re-run the capacity rule against its own full set
    // and silently drop the last entry — which would change the digest and
    // break the restart round-trip the persistence layer verifies.
    for (const obligation of snapshot.obligations.slice(0, MAX_LEDGER_OBLIGATIONS + 1)) {
      ledger.entries.set(keyOf(obligation), { ...obligation });
    }
    return ledger;
  }
}

/**
 * The sole constructor for a terminal proof. Risk and coverage are deliberately
 * absent: they may advise serving policy but cannot certify a task as complete.
 */
export function dischargeCertificate(ledger: ObligationLedger): DischargeCertificate | undefined {
  const snapshot = ledger.snapshot();
  // A-F3 (2026-08-28): AN EMPTY LEDGER CERTIFIES NOTHING.
  //
  // `[].every(...)` is vacuously true, so a ledger that had never recorded a
  // single obligation minted a full discharge certificate — and that
  // certificate's digest then flowed into the certificate id, producing the
  // ledger-bound `ready-<ledger16>-<proof16>` form. The wire therefore CLAIMED
  // a discharged requirement set over zero requirements, and
  // `ledgerCertificateBindingValid` accepted it because the claim is
  // self-consistent. An accept over an empty ledger is still permitted (it is
  // v0.12's behavior for a non-exhaustive task), but it must not be dressed as
  // a ledger discharge: with no certificate here, the caller falls back to the
  // legacy single-segment id, which is the honest, verifiable shape for
  // "no ledger was involved in this decision".
  if (snapshot.obligations.length === 0) return undefined;
  if (!snapshot.obligations.every((obligation) => obligation.proof !== undefined)) return undefined;
  return Object.freeze({ digest: snapshot.digest, [dischargeCertificateBrand]: true as const });
}

export function ledgerDigest(snapshot: Pick<ObligationLedgerSnapshot, "obligations">): string {
  return digestOf([...snapshot.obligations].sort((left, right) => keyOf(left).localeCompare(keyOf(right))));
}
