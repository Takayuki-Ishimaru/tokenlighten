/**
 * Compatibility facade for the historical util/session module path.
 *
 * Session state is domain state, not a generic utility. Keep this facade while
 * package-internal callers migrate to state/session.
 */
export * from "../state/session.js";
