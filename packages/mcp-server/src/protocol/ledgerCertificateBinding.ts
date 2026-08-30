import { ledgerDigest, type ObligationLedgerSnapshot } from "../state/obligationLedger.js";

/** Internal-only producer→emit certificate binding. Never serialized. */
export interface LedgerCertificateBinding {
  readonly certificateId: string;
  readonly ledgerDigest: string;
  readonly discharged: boolean;
  /** The producer's immutable ledger snapshot, retained only in-process. */
  readonly ledgerSnapshot?: ObligationLedgerSnapshot;
  readonly lane?: string;
  readonly taskHandle?: string;
  /** Internal workspace identity; never serialized. */
  readonly workspaceIdentity?: string;
  /** Opaque per-task replay identity; binds projections to the same task. */
  readonly taskReplay?: string;
}

/**
 * THE LEDGER-BACKED CERTIFICATE IDENTITY, defined once.
 *
 * `deterministicCertificate` mints two id shapes: the legacy single-segment
 * `ready-<proof16>` (no ledger claim) and the proof-completion
 * `ready-<ledger16>-<proof16+>`, whose FIRST segment is a claim about a durable
 * obligation ledger. Only the second shape is an A-7 ledger-backed act, and
 * only it must fail closed when the producer cannot hand over a snapshot that
 * proves the claim.
 *
 * The shape test lived inline in `ledgerCertificateBindingValid`, so the
 * producer had no way to ask "is this id making a ledger claim?" without
 * re-deriving the regex — which is how an id could acquire the claiming shape
 * on one code path while a different path decided whether it could be backed.
 */
const LEDGER_BACKED_CERTIFICATE_ID_RE = /^ready-[a-f0-9]{16}-[a-f0-9]{16,}$/;

/** Is this certificate id making a durable-ledger claim (vs. the legacy form)? */
export function isLedgerBackedCertificateId(certificateId: string): boolean {
  return LEDGER_BACKED_CERTIFICATE_ID_RE.test(certificateId);
}

/**
 * Does `ledgerDigest` actually BACK `certificateId`'s ledger claim?
 *
 * The producer's own premise, stated in the same terms the funnel verifies in
 * (`ledgerCertificateBindingValid`'s closing `startsWith`). A producer that
 * hands over a snapshot without asking this binds a ledger the id does not
 * name — which the funnel then rejects, turning a legitimately adjudicated act
 * into an unexplained dead-end refusal.
 */
export function ledgerDigestBacksCertificateId(certificateId: string, ledgerDigest: string): boolean {
  return isLedgerBackedCertificateId(certificateId)
    && certificateId.startsWith(`ready-${ledgerDigest.slice(0, 16)}-`);
}

/**
 * Drop an unbackable ledger claim, keeping the proof identity.
 *
 * The honest demotion: `ready-<ledger16>-<proof16>` -> `ready-<proof16>`, which
 * is exactly the legacy single-segment form a pack emits when it makes no
 * ledger claim at all. Deterministic (a pure function of the minted id), so a
 * replay of the same request demotes to the same identity.
 */
export function withoutLedgerClaim(certificateId: string): string {
  return isLedgerBackedCertificateId(certificateId)
    ? certificateId.replace(/^ready-[a-f0-9]{16}-/, "ready-")
    : certificateId;
}

interface IndexedBinding {
  readonly binding: LedgerCertificateBinding;
  readonly expiresAt: number;
}

const BINDING_TTL_MS = 5 * 60 * 1000;
const BINDING_CACHE_LIMIT = 512;
const bindings = new WeakMap<object, IndexedBinding>();
// A module-private symbol is deliberately used instead of Symbol.for: ladder
// projections preserve own symbols, while callers cannot manufacture the
// authenticated transfer token from JSON/wire-visible data.
const BINDING_SYMBOL = Symbol("tokenlighten.ledgerCertificateBinding");
type BoundPayload = object & { [BINDING_SYMBOL]?: IndexedBinding };
// Object projections that discard the private symbol may consult this bounded
// index only when they carry a complete, non-ambiguous identity. Scoped ledger
// bindings still fail closed because workspace/lane are not wire metadata.
const indexedBindings = new Map<string, IndexedBinding>();
type PayloadIdentity = {
  readonly certificateId?: string;
  readonly taskHandle?: string;
  readonly taskReplay?: string;
};

function payloadIdentity(payload: unknown): PayloadIdentity {
  if (typeof payload !== "object" || payload === null) return {};
  const value = payload as { decision?: { certificate?: { id?: unknown } }; task?: { id?: unknown; replay?: unknown } };
  return {
    ...(typeof value.decision?.certificate?.id === "string" ? { certificateId: value.decision.certificate.id } : {}),
    ...(typeof value.task?.id === "string" ? { taskHandle: value.task.id } : {}),
    ...(typeof value.task?.replay === "string" ? { taskReplay: value.task.replay } : {}),
  };
}

/**
 * A-F3 (2026-08-28): `discharged` IS A CLAIM; this is the check.
 *
 * Every validator here read `binding.discharged` — a boolean the producer set —
 * and then verified only that the snapshot's DIGEST recomputed. A digest proves
 * the snapshot was not tampered with; it says nothing about whether the
 * obligations inside it were discharged, so a binding could truthfully hash an
 * untouched ledger of entirely UNPROVED obligations and still validate. The
 * ledger's own discharge rule is re-applied here, against the bytes, so the
 * funnel's verdict rests on the snapshot rather than on the producer's word.
 */
function fullyProved(snapshot: ObligationLedgerSnapshot): boolean {
  return snapshot.obligations.every((obligation) => obligation.proof !== undefined);
}

function bindingKey(binding: LedgerCertificateBinding): string {
  return [
    binding.workspaceIdentity ?? "<unknown-workspace>",
    binding.lane ?? "<unknown-lane>",
    binding.taskHandle ?? "<unknown-task>",
    binding.taskReplay ?? "<unknown-replay>",
    binding.certificateId,
    binding.ledgerDigest,
  ].join("\\u0000");
}

function pruneIndexedBindings(now = Date.now()): void {
  for (const [key, entry] of indexedBindings) {
    if (entry.expiresAt <= now) indexedBindings.delete(key);
  }
  while (indexedBindings.size > BINDING_CACHE_LIMIT) {
    const oldest = indexedBindings.keys().next().value;
    if (typeof oldest !== "string") break;
    indexedBindings.delete(oldest);
  }
}

function activeRecord(record: IndexedBinding | undefined): IndexedBinding | undefined {
  if (record === undefined || record.expiresAt <= Date.now()) return undefined;
  return record;
}

/** Remove every index alias for one producer record before it is promoted. */
function removeIndexedRecord(record: IndexedBinding): void {
  for (const [key, candidate] of indexedBindings) {
    if (candidate === record) indexedBindings.delete(key);
  }
}

/**
 * A scope promotion is allowed only for an authentic producer record.  The
 * payload's certificate/task fields are wire-visible, so the record must also
 * carry the immutable snapshot and prove the full digest before it can be
 * associated with a workspace supplied by the funnel.
 */
function isAuthenticatedProducerBinding(
  binding: LedgerCertificateBinding,
  identity: PayloadIdentity,
): boolean {
  if (
    !binding.discharged
    || binding.ledgerSnapshot === undefined
    || binding.taskHandle !== identity.taskHandle
    || identity.certificateId === undefined
    || binding.certificateId !== identity.certificateId
  ) return false;
  if (
    binding.taskReplay !== undefined
    && identity.taskReplay !== undefined
    && binding.taskReplay !== identity.taskReplay
  ) return false;
  if (!fullyProved(binding.ledgerSnapshot)) return false;
  const recomputed = ledgerDigest(binding.ledgerSnapshot);
  return binding.ledgerDigest === recomputed
    && binding.certificateId.startsWith(`ready-${recomputed.slice(0, 16)}-`);
}

function markCarrier(value: unknown, record: IndexedBinding): void {
  if (typeof value !== "object" || value === null) return;
  try {
    Object.defineProperty(value, BINDING_SYMBOL, {
      configurable: true,
      enumerable: true,
      value: record,
      writable: false,
    });
  } catch {
    // A frozen projection cannot receive the transfer marker; validation will
    // fail closed unless its root/another carrier retained the marker.
  }
}

export function bindLedgerCertificate(payload: object, binding: LedgerCertificateBinding): void {
  const record: IndexedBinding = {
    binding,
    expiresAt: Date.now() + BINDING_TTL_MS,
  };
  bindings.set(payload, record);
  // The envelope can receive a producer marker before it knows the resolved
  // workspace. When it then binds the final projected payload with that
  // authenticated workspace, retire the matching unscoped alias atomically.
  // Keep every scoped foreign record: it must remain visible so a collision
  // cannot be silently lent to this workspace.
  if (binding.workspaceIdentity !== undefined) {
    for (const [existingKey, existing] of indexedBindings) {
      const candidate = existing.binding;
      if (
        candidate.workspaceIdentity === undefined
        && candidate.certificateId === binding.certificateId
        && candidate.ledgerDigest === binding.ledgerDigest
        && candidate.taskHandle === binding.taskHandle
        && (candidate.taskReplay === undefined || candidate.taskReplay === binding.taskReplay)
        && (candidate.lane === undefined || candidate.lane === binding.lane)
      ) {
        indexedBindings.delete(existingKey);
      }
    }
  }
  const key = bindingKey(binding);
  indexedBindings.delete(key);
  indexedBindings.set(key, record);
  pruneIndexedBindings();
  markCarrier(payload, record);
  const body = payload as { decision?: unknown; task?: unknown };
  // Ladder rungs rebuild only the top-level record; carrying the same private
  // marker on stable act/task nodes survives those projections without any
  // wire-visible workspace/lane escape hatch.
  markCarrier(body.decision, record);
  markCarrier(body.task, record);
}

export function ledgerCertificateBinding(payload: unknown): LedgerCertificateBinding | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const body = payload as { decision?: unknown; task?: unknown };
  const direct = activeRecord(bindings.get(payload))
    ?? activeRecord((payload as BoundPayload)[BINDING_SYMBOL])
    ?? activeRecord((body.decision as BoundPayload | undefined)?.[BINDING_SYMBOL])
    ?? activeRecord((body.task as BoundPayload | undefined)?.[BINDING_SYMBOL]);
  if (direct !== undefined) return direct.binding;
  pruneIndexedBindings();
  const identity = payloadIdentity(payload);
  if (identity.certificateId === undefined || identity.taskHandle === undefined || identity.taskReplay === undefined) return undefined;
  const candidates = [...indexedBindings.values()]
    .map((entry) => activeRecord(entry))
    .filter((entry): entry is IndexedBinding => entry !== undefined)
    .map((entry) => entry.binding)
    .filter((binding) => binding.certificateId === identity.certificateId
      && binding.taskHandle === identity.taskHandle
      && binding.taskReplay === identity.taskReplay);
  // A reconstructed JSON/string-key projection has no authenticated
  // workspace/lane metadata. Never lend a scoped binding to it, even when one
  // visible candidate happens to exist; ambiguity (including digest-prefix
  // collisions) also fails closed.
  if (candidates.length !== 1) return undefined;
  const candidate = candidates[0];
  if (candidate.workspaceIdentity !== undefined || candidate.lane !== undefined) {
    return undefined;
  }
  return candidate;
}

/** Recover a producer binding after a body was JSON-stringified by toolOk.
 * The caller supplies the authenticated resolved workspace/lane from the
 * protocol funnel; ambiguous or foreign candidates are never selected. */
export function bindLedgerCertificateFromScope(
  payload: object,
  workspaceIdentity: string,
  lane?: string,
): boolean {
  const identity = payloadIdentity(payload);
  if (
    workspaceIdentity === ""
    || identity.certificateId === undefined
    || identity.taskHandle === undefined
  ) return false;
  pruneIndexedBindings();
  const candidates = [...indexedBindings.values()]
    .map((entry) => activeRecord(entry))
    .filter((entry): entry is IndexedBinding => entry !== undefined)
    .filter((entry) => {
      const binding = entry.binding;
      // Keep foreign scoped candidates in the set so they make a mixed or
      // mismatched scope fail closed instead of being hidden before promotion.
      return binding.certificateId === identity.certificateId
        && binding.taskHandle === identity.taskHandle
        && (binding.taskReplay === undefined
          || identity.taskReplay === undefined
          || binding.taskReplay === identity.taskReplay);
    });

  // Prefer one exact scoped candidate.  An unscoped stale producer record must
  // not shadow it; a scoped candidate for another workspace/lane must never be
  // borrowed merely because its wire-visible certificate fields match.
  const scoped = candidates.filter((entry) => entry.binding.workspaceIdentity !== undefined);
  const exact = scoped.filter((entry) => {
    const binding = entry.binding;
    return binding.workspaceIdentity === workspaceIdentity
      && (lane === undefined || binding.lane === lane);
  });
  if (exact.length > 1) return false;
  if (exact.length === 1) {
    bindLedgerCertificate(payload, exact[0].binding);
    return true;
  }
  if (scoped.length > 0) return false;

  // No scoped record exists: promote exactly one authenticated producer record.
  // Promotion is atomic with respect to the bounded index: remove the old
  // unknown-scope key before inserting the fully scoped replacement, otherwise
  // the next projection observes both records and fails as ambiguous.
  const producers = candidates.filter((entry) => {
    const binding = entry.binding;
    return (lane === undefined || binding.lane === undefined || binding.lane === lane)
      && isAuthenticatedProducerBinding(binding, identity);
  });
  if (producers.length !== 1) return false;
  const source = producers[0];
  const binding = source.binding;
  removeIndexedRecord(source);
  bindLedgerCertificate(payload, {
    ...binding,
    workspaceIdentity,
    ...(lane !== undefined ? { lane } : {}),
    ...(identity.taskReplay !== undefined ? { taskReplay: identity.taskReplay } : {}),
  });
  return true;
}

export function ledgerCertificateBindingValid(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const binding = ledgerCertificateBinding(payload);
  const decision = (payload as { decision?: { kind?: unknown; certificate?: { id?: unknown } } }).decision;
  const isAct = decision?.kind === "act.answer" || decision?.kind === "act.edit";
  const certificateId = typeof decision?.certificate?.id === "string" ? decision.certificate.id : undefined;
  // Legacy/no-contract acts have no ledger digest to bind and retain their
  // pre-A7 envelope behavior. Only the digest-bearing certificate shape is an
  // A7 ledger-backed act, and that shape must fail closed when unregistered.
  // deterministicCertificate's proof-completion form has BOTH the ledger
  // digest prefix and the proof hash.  Legacy certificates carry one opaque
  // suffix only and must retain their historical envelope behavior.
  const ledgerBacked = certificateId !== undefined && isLedgerBackedCertificateId(certificateId);
  if (binding === undefined) return !isAct || !ledgerBacked;
  if (!isAct) return true;
  if (!ledgerBacked) return true;
  if (
    !binding.discharged
    || binding.ledgerSnapshot === undefined
    || binding.workspaceIdentity === undefined
    || binding.lane === undefined
    || binding.taskHandle === undefined
  ) return false;
  if (!fullyProved(binding.ledgerSnapshot)) return false;
  const recomputed = ledgerDigest(binding.ledgerSnapshot);
  const task = (payload as { task?: { id?: unknown; replay?: unknown } }).task;
  if (task?.id !== binding.taskHandle) return false;
  if (binding.taskReplay !== undefined && task?.replay !== binding.taskReplay) return false;
  return recomputed === binding.ledgerDigest
    && decision?.certificate?.id === binding.certificateId
    && binding.certificateId.startsWith(`ready-${recomputed.slice(0, 16)}-`);
}
