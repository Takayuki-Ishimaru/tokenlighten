/** Scoped signal composition compatible with the supported Node 20.0 floor. */
export function combinedAbortSignal(signals: readonly AbortSignal[]): { signal: AbortSignal; dispose(): void } {
  if (typeof AbortSignal.any === "function") {
    return { signal: AbortSignal.any([...signals]), dispose() {} };
  }
  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; abort(): void }> = [];
  const dispose = (): void => {
    for (const entry of listeners.splice(0)) entry.signal.removeEventListener("abort", entry.abort);
  };
  const alreadyAborted = signals.find(signal => signal.aborted);
  if (alreadyAborted) controller.abort(alreadyAborted.reason);
  else for (const signal of new Set(signals)) {
    const abort = (): void => {
      try { controller.abort(signal.reason); } finally { dispose(); }
    };
    listeners.push({ signal, abort });
    signal.addEventListener("abort", abort, { once: true });
  }
  return { signal: controller.signal, dispose };
}
