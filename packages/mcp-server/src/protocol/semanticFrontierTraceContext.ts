// Per-call, trace-only Semantic Frontier state.
//
// This is deliberately a leaf module.  Task-pack producers and wire
// projectors can register opaque observations without importing envelope.ts;
// that keeps tracing from creating a protocol <-> feature runtime cycle.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { SemanticFrontierTraceSeed } from "../features/task-pack/semanticFrontier.js";

export type SemanticFrontierSuppressionWitness =
  | { readonly reason: "evidence-remaining"; readonly kind: "evidence"; readonly id: string }
  | { readonly reason: string; readonly kind: "decision"; readonly id: string; readonly outcome: "next" | "await-input" };

/**
 * FX-R3d (D10, 2026-09-04) — the producer-side record of WHICH rows had a
 * body withheld, carried to the funnel exit as opaque evidence witness ids.
 *
 * `protocol/envelope.ts` can only see the serialized response text, so it
 * cannot ask a surface object anything. `projectEvidence` can: it holds both
 * the surface (carrying `sfWithholdingMarks.ts`'s marks) and the row that will
 * ship, so it publishes one witness id per marked row here, and the envelope
 * intersects that set with the FINAL wire. This is a MEASUREMENT channel, not
 * a decision input — nothing downstream of it changes a response byte.
 */
export interface SemanticFrontierWithholdingMarks {
  /** Rows `applySemanticFrontierDemotion` took a body from (W-DEMOTE). */
  readonly demoted: ReadonlySet<string>;
  /** Rows D8's caller-named frontier join minted (body or not). */
  readonly named: ReadonlySet<string>;
}

interface SemanticFrontierTraceState {
  seed?: SemanticFrontierTraceSeed;
  readonly witnesses: Map<string, SemanticFrontierSuppressionWitness>;
  readonly demotedMarks: Set<string>;
  readonly namedMarks: Set<string>;
}

/** The empty marks, for every path with no call-local trace state bound. */
const NO_WITHHOLDING_MARKS: SemanticFrontierWithholdingMarks = {
  demoted: new Set<string>(),
  named: new Set<string>(),
};

const semanticFrontierTrace = new AsyncLocalStorage<SemanticFrontierTraceState>();

/** Bind fresh, call-local trace state, including across asynchronous work. */
export function runWithSemanticFrontierTrace<T>(fn: () => T): T {
  return semanticFrontierTrace.run(
    { witnesses: new Map(), demotedMarks: new Set(), namedMarks: new Set() },
    fn,
  );
}

/** Register only the already privacy-filtered seed constructed by task-pack. */
export function noteSemanticFrontierTraceSeed(seed: SemanticFrontierTraceSeed): void {
  const state = semanticFrontierTrace.getStore();
  if (state !== undefined) state.seed = seed;
}

const opaqueId = (kind: string, value: string): string =>
  `sha256:${createHash("sha256").update(`${kind}\0${value}`).digest("hex").slice(0, 24)}`;

/** Opaque identity for a final evidence addressing triple; never retain raw fields. */
export function semanticFrontierEvidenceWitnessId(value: Record<string, unknown>): string {
  return opaqueId("evidence", JSON.stringify([
    typeof value["path"] === "string" ? value["path"] : "",
    typeof value["handle"] === "string" ? value["handle"] : "",
    typeof value["range"] === "string" ? value["range"] : "",
  ]));
}

function normalizedDecisionValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizedDecisionValue);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (record["tool"] === "read_file" && record["arguments"] !== null && typeof record["arguments"] === "object" && !Array.isArray(record["arguments"])) {
    return { tool: "read_file", arguments: normalizedReadArguments(record["arguments"] as Record<string, unknown>) };
  }
  const inferredSliceMode = record["mode"] === "slice"
    && (typeof record["handle"] === "string" || typeof record["range"] === "string");
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record).sort(([left], [right]) => left.localeCompare(right))) {
    // Funnel attribution adds these after decision selection; they must not
    // make a genuine guarded next look different at the final wire.
    if (key === "cwd" || key === "lane" || (key === "mode" && inferredSliceMode)) continue;
    if (key === "task" && item !== null && typeof item === "object" && !Array.isArray(item)) {
      const task = Object.fromEntries(Object.entries(item as Record<string, unknown>).filter(([taskKey]) => taskKey !== "handle"));
      if (Object.keys(task).length > 0) output[key] = normalizedDecisionValue(task);
      continue;
    }
    output[key] = normalizedDecisionValue(item);
  }
  return output;
}

/** Normalize legacy/canonical read address spellings to one opaque shape. */
function normalizedReadArguments(argumentsValue: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const source = { ...argumentsValue };
  delete source["cwd"];
  delete source["lane"];
  delete source["task"];
  delete source["mode"];
  if (source["content"] === "auto") delete source["content"];
  const inherited = {
    ...(typeof source["range"] === "string" ? { range: source["range"] } : {}),
    ...(Array.isArray(source["ranges"]) ? { ranges: source["ranges"] } : {}),
    ...(typeof source["symbol"] === "string" ? { symbol: source["symbol"] } : {}),
  };
  const addresses: Record<string, unknown>[] = [];
  const addAddress = (value: unknown): void => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return;
    const entry = value as Record<string, unknown>;
    const address = {
      ...(typeof entry["path"] === "string" ? { path: entry["path"] } : {}),
      ...(typeof entry["handle"] === "string" ? { handle: entry["handle"] } : {}),
      ...inherited,
      ...(typeof entry["range"] === "string" ? { range: entry["range"] } : {}),
      ...(Array.isArray(entry["ranges"]) ? { ranges: entry["ranges"] } : {}),
      ...(typeof entry["symbol"] === "string" ? { symbol: entry["symbol"] } : {}),
    };
    if (address.path !== undefined || address.handle !== undefined) addresses.push(address);
  };
  for (const target of Array.isArray(source["targets"]) ? source["targets"] : []) addAddress(target);
  for (const path of Array.isArray(source["paths"]) ? source["paths"] : []) addAddress(typeof path === "string" ? { path } : path);
  for (const handle of Array.isArray(source["handles"]) ? source["handles"] : []) addAddress(typeof handle === "string" ? { handle } : handle);
  addAddress({ path: source["path"], handle: source["handle"] });
  for (const key of ["targets", "paths", "handles", "path", "handle", "range", "ranges", "symbol"]) delete source[key];
  if (addresses.length > 0) output["targets"] = addresses.map(normalizedDecisionValue);
  for (const [key, item] of Object.entries(source).sort(([left], [right]) => left.localeCompare(right))) {
    output[key] = normalizedDecisionValue(item);
  }
  return output;
}

/** Opaque fingerprint for a final decision.next, ignoring funnel attribution. */
export function semanticFrontierDecisionWitnessId(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return opaqueId("decision-next", JSON.stringify(normalizedDecisionValue(value)));
}

function noteWitness(witness: SemanticFrontierSuppressionWitness): void {
  const state = semanticFrontierTrace.getStore();
  if (state !== undefined) state.witnesses.set(`${witness.kind}:${witness.id}:${witness.reason}`, witness);
}

/** Record a projected remaining-range removal against its final evidence row. */
export function noteSemanticFrontierEvidenceSuppression(value: Record<string, unknown>): void {
  noteWitness({ reason: "evidence-remaining", kind: "evidence", id: semanticFrontierEvidenceWitnessId(value) });
}

/**
 * Record that a row THIS response ships had its body withheld by `kind`.
 *
 * Called from `projectEvidence` for every marked surface, regardless of what
 * the projected row ended up carrying — the envelope, not this note, decides
 * whether the row actually shipped bodyless. Idempotent (a set), so a
 * projection run more than once for one response cannot inflate a count.
 */
export function noteSemanticFrontierWithholding(
  kind: "demoted" | "named",
  value: Record<string, unknown>,
): void {
  const state = semanticFrontierTrace.getStore();
  if (state === undefined) return;
  const id = semanticFrontierEvidenceWitnessId(value);
  (kind === "demoted" ? state.demotedMarks : state.namedMarks).add(id);
}

/** Read the call-local withholding marks without consuming the trace state. */
export function semanticFrontierWithholdingMarks(): SemanticFrontierWithholdingMarks {
  const state = semanticFrontierTrace.getStore();
  if (state === undefined) return NO_WITHHOLDING_MARKS;
  return { demoted: state.demotedMarks, named: state.namedMarks };
}

/** Record a decision effect only after ranked selection picked its final outcome. */
export function noteSemanticFrontierDecisionSuppression(reason: string, next: unknown): void {
  if (reason === "") return;
  const id = semanticFrontierDecisionWitnessId(next);
  if (id !== undefined) noteWitness({ reason, kind: "decision", id, outcome: "next" });
  else noteWitness({ reason, kind: "decision", id: opaqueId("decision-await", "await-input"), outcome: "await-input" });
}

/** Consume state exactly once at the protocol funnel exit. */
export function takeSemanticFrontierTraceState(): {
  seed: SemanticFrontierTraceSeed;
  witnesses: SemanticFrontierSuppressionWitness[];
  marks: SemanticFrontierWithholdingMarks;
} | undefined {
  const state = semanticFrontierTrace.getStore();
  if (state?.seed === undefined) return undefined;
  const seed = state.seed;
  delete state.seed;
  const witnesses = [...state.witnesses.values()];
  state.witnesses.clear();
  const marks: SemanticFrontierWithholdingMarks = {
    demoted: new Set(state.demotedMarks),
    named: new Set(state.namedMarks),
  };
  state.demotedMarks.clear();
  state.namedMarks.clear();
  return { seed, witnesses, marks };
}
