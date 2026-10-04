/**
 * requestCancellation.ts — which MCP request is running, and whether its
 * client has cancelled it.
 *
 * WHY THIS IS ITS OWN LEAF MODULE (imports: `node:async_hooks` ONLY).
 *
 * The stdio transport (mcp/transport/legacyStdio.ts) learns of a client's
 * `notifications/cancelled` while a handler is mid-flight, and the code that
 * has to react is a long way down the call stack: the edit tools. Threading an
 * `AbortSignal` through `handleRequest` -> `callTool` -> `dispatchTool` -> ten
 * write entry points would touch every signature in between, so the signal
 * rides an `AsyncLocalStorage` slot bound once per request instead — the same
 * mechanism util/laneKey.ts uses for the caller's session lane. Being a leaf,
 * both the transport and the tool modules can import it without an import
 * cycle.
 *
 * WHAT HONOURS A CANCEL, AND WHERE.
 *
 *  - The transport never starts a request that was cancelled while it waited
 *    its turn, aborts the signal of one that is running, and writes no
 *    response for either (MCP "Cancellation": the receiver SHOULD stop
 *    processing and SHOULD NOT answer a cancelled request).
 *  - Reads need no check of their own: they have no side effect on the
 *    workspace, so letting one finish and dropping its response is enough.
 *  - Writes call `throwIfRequestCancelled()` at their COMMIT POINT and nowhere
 *    else: after every validation and every in-memory plan is done, strictly
 *    before the first byte reaches the disk. A write that gets past it runs to
 *    the end — a batch is all-or-nothing and is never abandoned between files,
 *    and a mid-batch rollback is never interrupted. Each write entry point
 *    marks its own check with the words "COMMIT POINT" (grep for them); they
 *    are the whole list, and `editCancellationCommitPoint.spec.ts` drives
 *    every `tl_edit_file` shape through a cancelled request to prove no byte is
 *    written.
 *
 * Outside a bound request (the modern-era transports, the CLI, every unit
 * test that calls a tool directly) `currentRequestSignal()` is `undefined` and
 * every check below is a no-op, so nothing changes for a caller that never
 * binds a signal.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Thrown by `throwIfRequestCancelled()` — and used as the abort `reason` of the
 * signal the transport binds — when the request was cancelled by its client.
 * It is control flow, not a failure: the transport drops the response of a
 * cancelled request whatever its handler returned or threw.
 */
export class RequestCancelledError extends Error {
  constructor(message = "request cancelled") {
    super(message);
    this.name = "RequestCancelledError";
  }
}

const _requestSignal = new AsyncLocalStorage<AbortSignal>();

/**
 * Runs `fn` — and every continuation it starts — with `signal` as the current
 * request's cancellation signal.
 */
export function runWithRequestSignal<T>(signal: AbortSignal, fn: () => T): T {
  return _requestSignal.run(signal, fn);
}

/** The current request's signal; `undefined` outside any bound request. */
export function currentRequestSignal(): AbortSignal | undefined {
  return _requestSignal.getStore();
}

/**
 * Throws `RequestCancelledError` when the current request has been cancelled;
 * returns normally otherwise, including outside a bound request.
 *
 * Call it ONLY at a write's commit point (see the module header). It is
 * synchronous on purpose: the check and the write that follows it run in one
 * turn of the event loop, so a cancel cannot slip in between them.
 */
export function throwIfRequestCancelled(): void {
  const signal = _requestSignal.getStore();
  if (signal === undefined || !signal.aborted) return;
  throw signal.reason instanceof RequestCancelledError ? signal.reason : new RequestCancelledError();
}
