// Shared per-process state: identity remains stable; reset clears the same containers.
export const operationsInFlight = new Set<string>();
export const creditedReadPathsByLane = new Map<string, Set<string>>();
export const inheritedTaskProfileArgs = new WeakSet<Record<string, unknown>>();
