// ---------------------------------------------------------------------------
// B6 -- pre-counts candidate texts against the HOST's own countTokens API.
//
// The host API is asynchronous while selection is synchronous, so every
// candidate is counted up front and the returned TokenCounter only ever
// answers from those collected numbers. A value here is whatever the host's
// API reported for that model -- `method` records how sure that is
// (host-exact vs host-estimate vs unknown). No estimates, no fallbacks: an
// uncounted text throws, and any failure is an explicit `unavailable`.
// ---------------------------------------------------------------------------

import type { TokenCounter } from "./tokenCounter.js";

/** The host's async counting API, as exposed to us for the current model. */
export interface HostCounterBridge {
  readonly id: string;
  readonly method: "host-exact" | "host-estimate" | "unknown";
  countTokens(text: string, signal: AbortSignal): Promise<number>;
}

/** A synchronous counter backed entirely by a completed host precount. */
export interface HostTokenCounter extends TokenCounter {
  readonly unit: "tokens";
  readonly encoding: "host";
  readonly method: HostCounterBridge["method"];
}

export type HostPrecount =
  | { status: "ready"; counter: HostTokenCounter }
  | {
      status: "unavailable";
      reason:
        | "no-bridge"
        | "bridge-error"
        | "invalid-count"
        | "timeout"
        | "cancelled"
        | "model-changed"
        | "too-many-texts"
        | "input-too-large";
    };

const MAX_DISTINCT_TEXTS = 8;
const MAX_TOTAL_BYTES = 512 * 1024;

const utf8 = new TextEncoder();

const unavailable = (reason: Exclude<HostPrecount, { status: "ready" }>["reason"]): HostPrecount => ({
  status: "unavailable",
  reason,
});

const isValidCount = (value: number, text: string): boolean =>
  Number.isSafeInteger(value) && value >= 0 && (value > 0 || text.length === 0);

type Race = "settled" | "timeout" | "cancelled";

/**
 * Counts every distinct text once against the host bridge, concurrently, and
 * hands back a synchronous counter over the results. Never rejects.
 */
export async function precountForHost(
  getBridge: () => HostCounterBridge | undefined,
  texts: readonly string[],
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<HostPrecount> {
  const { timeoutMs, signal } = options;

  // A caller who cancelled already wins before the bridge is touched.
  if (signal?.aborted) return unavailable("cancelled");

  // Bound what we will ever send, counting distinct texts only.
  const distinct = [...new Set(texts)];
  if (distinct.length > MAX_DISTINCT_TEXTS) return unavailable("too-many-texts");
  let totalBytes = 0;
  for (const text of distinct) totalBytes += utf8.encode(text).length;
  if (totalBytes > MAX_TOTAL_BYTES) return unavailable("input-too-large");

  let bridge: HostCounterBridge | undefined;
  try {
    bridge = getBridge();
  } catch {
    return unavailable("bridge-error");
  }
  if (bridge === undefined) return unavailable("no-bridge");
  const startId = bridge.id;

  // One internal controller fans the abort out to every host call; rejections
  // it causes are swallowed by the per-text wrapper so they can never surface
  // as bridge-error or as unhandled rejections, and a late settle is inert.
  const internal = new AbortController();
  const counts = new Map<string, number>();
  let bridgeFailed = false;
  const started = bridge;
  const counted = distinct.map(async (text) => {
    try {
      counts.set(text, await started.countTokens(text, internal.signal));
    } catch {
      bridgeFailed = true;
    }
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const race = await Promise.race<Race>([
      Promise.allSettled(counted).then(() => "settled"),
      new Promise<Race>((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
      ...(signal
        ? [
            new Promise<Race>((resolve) => {
              onAbort = () => resolve("cancelled");
              signal.addEventListener("abort", onAbort, { once: true });
            }),
          ]
        : []),
    ]);

    if (timer !== undefined) clearTimeout(timer);
    if (signal !== undefined && onAbort !== undefined) signal.removeEventListener("abort", onAbort);

    // Whatever ended the race owns the status; a late bridge answer is a
    // settled promise nobody reads anymore, so it changes nothing.
    if (race === "timeout") {
      internal.abort();
      return unavailable("timeout");
    }
    if (race === "cancelled") {
      internal.abort();
      return unavailable("cancelled");
    }

    if (bridgeFailed) return unavailable("bridge-error");
    for (const [text, value] of counts) {
      if (!isValidCount(value, text)) return unavailable("invalid-count");
    }

    // The model may have switched mid-count: keep only an all-or-nothing set.
    let current: HostCounterBridge | undefined;
    try {
      current = getBridge();
    } catch {
      return unavailable("model-changed");
    }
    if (current === undefined || current.id !== startId) return unavailable("model-changed");

    const countedTexts = new Map(counts);
    const counter: HostTokenCounter = {
      id: current.id,
      unit: "tokens",
      encoding: "host",
      method: current.method,
      count(text: string): number {
        const value = countedTexts.get(text);
        if (value === undefined) throw new Error("host-count-missing");
        return value;
      },
    };
    return { status: "ready", counter };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (signal !== undefined && onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}
