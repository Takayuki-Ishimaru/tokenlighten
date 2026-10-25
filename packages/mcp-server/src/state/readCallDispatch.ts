import {randomUUID} from "node:crypto";
import type {ReadCallDispatchBinding} from "@tokenlighten/types";

type Entry = {nonce: string; generation: number; active: number; exclusive: boolean; waiters: Array<() => void>};
const entries = new Map<string, Entry>();
const MAX_LANES = 1024;
export interface ReadCallDispatchScope {
  binding: ReadCallDispatchBinding;
  finish(): void;
}
const keyOf = (workspace: string, lane: string) => JSON.stringify([workspace, lane]);

/** Ordinary calls remain concurrent; an admitted semantic continuation holds a lane lease. */
export function beginReadCallDispatch(workspace: string, lane: string): ReadCallDispatchScope | undefined {
  const key = keyOf(workspace, lane);
  let entry = entries.get(key);
  if (entry?.exclusive) return undefined;
  if (!entry) {
    if (entries.size >= MAX_LANES) {
      const idle = [...entries].find(([, row]) => row.active === 0 && row.waiters.length === 0);
      if (!idle) return undefined;
      entries.delete(idle[0]);
    }
    entry = {nonce: randomUUID(), generation: 0, active: 0, exclusive: false, waiters: []};
    entries.set(key, entry);
  }
  entry.generation++; entry.active++;
  const owned = entry, binding = {nonce: owned.nonce, generation: owned.generation};
  let finished = false;
  return {binding, finish() {
    if (finished) return;
    finished = true;
    owned.active--;
    if (owned.exclusive) {
      owned.exclusive = false;
      for (const wake of owned.waiters.splice(0)) wake();
    }
  }};
}

export async function withReadCallDispatch<T>(
  workspace: string | undefined, lane: string,
  run: (binding: ReadCallDispatchBinding | undefined) => Promise<T>,
): Promise<T> {
  if (!workspace) return run(undefined);
  const key = keyOf(workspace, lane);
  for (;;) {
    const entry = entries.get(key);
    if (!entry?.exclusive) break;
    await new Promise<void>(resolve => entry.waiters.push(resolve));
  }
  const scope = beginReadCallDispatch(workspace, lane);
  try { return await run(scope?.binding); }
  finally { scope?.finish(); }
}

/** A plan may be published only by the sole, still-current lane dispatch. */
export function isReadCallDispatchCurrent(
  workspace: string, lane: string, binding: ReadCallDispatchBinding,
): boolean {
  const entry = entries.get(keyOf(workspace, lane));
  return !!entry && entry.active === 1 && entry.nonce === binding.nonce
    && entry.generation === binding.generation;
}

/** Synchronous compare-and-acquire before semantic dispatch, held through final wire projection. */
export function takeReadCallSemanticLease(
  workspace: string, lane: string, current: ReadCallDispatchBinding | undefined, minted: ReadCallDispatchBinding,
): boolean {
  const entry = entries.get(keyOf(workspace, lane));
  if (!entry || !current || entry.exclusive || entry.active !== 1 || entry.nonce !== current.nonce
    || entry.generation !== current.generation || current.nonce !== minted.nonce
    || current.generation !== minted.generation + 1) return false;
  entry.exclusive = true;
  return true;
}

export function resetReadCallDispatchForTests(): void {
  for (const entry of entries.values()) {
    entry.exclusive = false;
    for (const wake of entry.waiters.splice(0)) wake();
  }
  entries.clear();
}
