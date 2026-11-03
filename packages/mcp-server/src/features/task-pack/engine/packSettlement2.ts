// packSettlement — extracted implementation; imports point to the owning modules.


// ---------------------------------------------------------------------------
// Lexical callee extraction (relocated from evidenceShadow.ts when the P1
// evidence-completion experiment was deleted, v0.14 flag inventory 2026-08-31;
// the one-hop proof expansion below was always its non-experimental consumer).
// ---------------------------------------------------------------------------

export const CALL_RE = /\b([A-Za-z_][A-Za-z0-9_]{2,})\s*\(/g;

export const CALL_STOPWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "sizeof", "typeof",
  "function", "constructor", "super", "await", "throw", "new", "delete",
  "print", "assert", "expect", "require",
]);

export const MAX_CALLEES_SCANNED = 8;
