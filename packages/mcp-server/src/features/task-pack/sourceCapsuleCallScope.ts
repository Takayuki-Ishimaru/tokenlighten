import {AsyncLocalStorage} from "node:async_hooks";
import {currentRequestSignal} from "../../util/requestCancellation.js";
import {expandEvidencePathGroups} from "../../protocol/evidencePathGroups.js";
import type {SourceBodyCapsule} from "./sourceBodyCapsule.js";

export interface FinalSourceCapsule {
  readonly capsule: SourceBodyCapsule;
  readonly taskBinding: string;
}
export interface StagedSourceCapsule {
  readonly capsule: SourceBodyCapsule;
  readonly taskBinding?: string;
  readonly body: string;
  readonly range: string;
}
interface OuterCallScope {
  readonly owner: object;
  readonly globalGeneration: object;
  readonly keys: Map<string, {generation: object; globalGeneration: object; invalidated: boolean}>;
  readonly snapshots: Map<string, readonly FinalSourceCapsule[]>;
  readonly staged: Map<string, StagedSourceCapsule[]>;
}
const outerCall = new AsyncLocalStorage<OuterCallScope>();
const finalized = new Map<string, readonly FinalSourceCapsule[]>();
const generations = new Map<string, object>();
let globalGeneration: object = Object.freeze({});
const MAX_KEYS = 128;
const MAX_GENERATION_KEYS = 256;
const MAX_BYTES_PER_KEY = 18 * 1024;

export function runWithSourceCapsuleCall<T>(fn: () => T): T {
  return outerCall.run({owner: Object.freeze({}), globalGeneration, keys: new Map(), snapshots: new Map(), staged: new Map()}, fn);
}

function generationFor(key: string): object {
  let generation = generations.get(key);
  if (generation === undefined) {
    generation = Object.freeze({});
    generations.set(key, generation);
    while (generations.size > MAX_GENERATION_KEYS) generations.delete(generations.keys().next().value as string);
  }
  return generation;
}

function keyState(scope: OuterCallScope, key: string): {generation: object; globalGeneration: object; invalidated: boolean} {
  let state = scope.keys.get(key);
  if (state === undefined) {
    state = {generation: generationFor(key), globalGeneration, invalidated: scope.globalGeneration !== globalGeneration};
    scope.keys.set(key, state);
  } else if (state.generation !== generationFor(key) || state.globalGeneration !== globalGeneration
    || scope.globalGeneration !== globalGeneration) {
    state.invalidated = true;
  }
  return state;
}

/** Snapshot once per outer MCP call; the first use follows any epoch clear. */
export function sourceCapsulePrior(key: string): readonly FinalSourceCapsule[] {
  const scope = outerCall.getStore();
  if (!scope) return finalized.get(key) ?? [];
  const state = keyState(scope, key);
  if (state.invalidated) return [];
  let snapshot = scope.snapshots.get(key);
  if (snapshot === undefined) {
    snapshot = finalized.get(key) ?? [];
    scope.snapshots.set(key, snapshot);
  }
  return snapshot;
}

export function stageSourceCapsules(key: string, rows: readonly StagedSourceCapsule[]): void {
  const scope = outerCall.getStore();
  if (!scope || rows.length === 0) return;
  const state = keyState(scope, key);
  if (state.invalidated) return;
  const staged = scope.staged.get(key) ?? [];
  scope.staged.set(key, staged);
  let stagedBytes = staged.reduce((total, row) => total + Buffer.byteLength(row.capsule.body, "utf8"), 0);
  for (const row of rows) {
    if (staged.some(existing => existing.taskBinding === row.taskBinding
      && existing.capsule.path === row.capsule.path && existing.capsule.sha === row.capsule.sha
      && existing.capsule.handle === row.capsule.handle && existing.range === row.range
      && existing.body === row.body)) continue;
    const bodyBytes = Buffer.byteLength(row.capsule.body, "utf8");
    if (stagedBytes + bodyBytes > MAX_BYTES_PER_KEY) continue;
    stagedBytes += bodyBytes;
    staged.push(row);
  }
}

// Final-wire line numbering is a presentation of the same delivered bytes.
// Reconstruct that exact sequential gutter instead of stripping arbitrary
// number-like prefixes (which may themselves be source content).
function deliveredCapsuleBody(candidate: StagedSourceCapsule, body: unknown): boolean {
  if (body === candidate.body) return true;
  if (typeof body !== "string") return false;
  const lines = candidate.body.split("\n"), trailingNewline = lines.at(-1) === "";
  if (trailingNewline) lines.pop();
  if (lines.length !== candidate.capsule.endLine - candidate.capsule.startLine + 1) return false;
  const numbered = lines.map((line, index) => `${candidate.capsule.startLine + index}|${line}`).join("\n");
  return body === numbered + (trailingNewline ? "\n" : "");
}

/** Promote only capsules corroborated by the complete outer tool result. */
export function finalizeSourceCapsules(
  key: string,
  text: string,
  resolveBinding: (taskHandle: string) => string | undefined,
): void {
  const scope = outerCall.getStore();
  if (!scope || currentRequestSignal()?.aborted || scope.globalGeneration !== globalGeneration) return;
  const keyGeneration = keyState(scope, key);
  if (keyGeneration.invalidated) return;
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    // TL_EFF_EVIDENCE_PATH_GROUPS: rows are matched below by path, handle,
    // range and body, so a grouped reply is read back into whole rows first.
    payload = expandEvidencePathGroups(parsed as Record<string, unknown>);
  } catch { return; }
  if (payload.kind !== "read.task_pack" || !Array.isArray(payload.evidence)
    || !payload.task || typeof payload.task !== "object" || Array.isArray(payload.task)) return;
  const taskHandle = (payload.task as Record<string, unknown>).id;
  if (typeof taskHandle !== "string") return;
  const binding = resolveBinding(taskHandle);
  if (!binding) return;
  const delivered = payload.evidence.filter((value): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value));
  const candidates = scope.staged.get(key);
  if (!candidates) return;
  const promoted: FinalSourceCapsule[] = [];
  let bytes = 0;
  for (const candidate of candidates) {
    if ((candidate.taskBinding !== undefined && candidate.taskBinding !== binding) || candidate.body !== candidate.capsule.body
      || !delivered.some(row => row.path === candidate.capsule.path && row.handle === candidate.capsule.handle
        && row.range === candidate.range && deliveredCapsuleBody(candidate, row.body))) continue;
    const bodyBytes = Buffer.byteLength(candidate.capsule.body, "utf8");
    if (bytes + bodyBytes > MAX_BYTES_PER_KEY) break;
    bytes += bodyBytes;
    promoted.push(Object.freeze({capsule: candidate.capsule, taskBinding: binding}));
  }
  if (promoted.length === 0) return;
  const merged = [...promoted];
  let retainedBytes = promoted.reduce((total, entry) => total + Buffer.byteLength(entry.capsule.body, "utf8"), 0);
  for (const entry of finalized.get(key) ?? []) {
    if (entry.taskBinding !== binding || merged.some(candidate =>
      candidate.capsule.path === entry.capsule.path && candidate.capsule.sha === entry.capsule.sha
      && candidate.capsule.startLine === entry.capsule.startLine && candidate.capsule.endLine === entry.capsule.endLine
      && candidate.capsule.body === entry.capsule.body)) continue;
    const bodyBytes = Buffer.byteLength(entry.capsule.body, "utf8");
    if (retainedBytes + bodyBytes > MAX_BYTES_PER_KEY) continue;
    retainedBytes += bodyBytes;
    merged.push(entry);
  }
  finalized.delete(key);
  finalized.set(key, Object.freeze(merged));
  while (finalized.size > MAX_KEYS) finalized.delete(finalized.keys().next().value as string);
}

export function clearSourceCapsules(key?: string): void {
  if (key === undefined) {
    finalized.clear();
    generations.clear();
    globalGeneration = Object.freeze({});
  } else {
    finalized.delete(key);
    // A clear is an invalidation event even for a scope that already captured
    // this key. Rotate to a distinct generation and keep the tombstone current.
    generations.set(key, Object.freeze({}));
    while (generations.size > MAX_GENERATION_KEYS) generations.delete(generations.keys().next().value as string);
  }
}
