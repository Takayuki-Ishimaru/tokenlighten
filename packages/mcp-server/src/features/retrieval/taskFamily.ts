/**
 * taskFamily.ts — V11-02 Task-aware Weighted RRF v2: deterministic, local
 * task-profile inference.
 *
 * Pure function of its input only: no model call, no filesystem/network I/O,
 * no clock. DESIGN-v0.10-expansion-plan-v1.3.md V11-02's own named failure
 * mode is "task classifier誤りがweight選択へ波及する" (a classifier mistake
 * propagates into weight selection) and its named mitigation is
 * "classifier confidenceが低い場合はgeneral profileを使う" (low confidence
 * -> general). Both are honored structurally here: every rule below is a
 * cheap, regex/shape-level structural check (never an LLM judgment call),
 * and inferTaskFamily() itself enforces the confidence floor — a caller
 * never sees a low-confidence non-general result.
 *
 * Misclassification safety net: even a wrong profile only reweights RRF
 * fusion contributions (features/retrieval/rrf.ts's
 * weightedReciprocalRankFusion) — the hard floor (hardFloor.ts) that
 * protects exact-path/exact-identifier/parser-proven-symbol/direct-reference
 * candidates is completely independent of profile choice (see this
 * package's floor specs for the adversarial-weight proof). A wrong profile
 * can make retrieval less SHARP; it cannot make it drop something the
 * pipeline already found.
 *
 * Rules prefer STRUCTURAL shape (identifier/path/regex patterns) over
 * English keywords per the design doc's own mitigation ("language-neutral
 * where possible"); two rules (change-propagation, read-only) fall back to a
 * small, explicit English-keyword set where no reliable structural signal
 * exists, and are deliberately among the lowest-confidence rules for exactly
 * that reason.
 */

import { normalizeQuery, type NormalizedQuery } from "./tokenize.js";
import type { TaskProfileId } from "./profiles.js";

export interface TaskFamilyInput {
  query: string;
  symbol?: string;
  /** The caller's explicit scope path, when one was given (locateTaskContext.ts's LocateInput.path / `requestedScope`). */
  explicitPath?: string;
  /** Paths already visible in the candidate pool at classification time — no extra I/O, reuses what the caller already computed (index.ts passes its own `parseFiles`). */
  candidatePaths?: readonly string[];
}

export interface TaskFamilyResult {
  profile: TaskProfileId;
  /** 0..1. Below MIN_CONFIDENCE, `profile` is already folded to "general" by this function — callers never see a low-confidence non-general result. */
  confidence: number;
  /** Every rule that fired FOR THE WINNING PROFILE, for trace/debugging (util/trace.ts payloads only — never wire). Empty when nothing matched at all. */
  signals: readonly string[];
}

/** Below this, fold to "general" — DESIGN-v0.10-expansion-plan-v1.3.md V11-02's own named mitigation. */
export const MIN_CONFIDENCE = 0.6;

const DOC_EXTENSIONS = [
  ".md", ".markdown", ".mdx", ".rst", ".txt",
  ".docx", ".doc", ".pptx", ".ppt", ".xlsx", ".xls", ".pdf", ".rtf",
] as const;

function hasDocExtension(p: string): boolean {
  const lower = p.toLowerCase();
  return DOC_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

const STACK_FRAME_RE = /\bat\s+[\w.\/\\-]+:\d+(?::\d+)?\b|\btraceback\b|\bstack trace\b/i;

const CHANGE_PROPAGATION_KEYWORDS_RE =
  /\b(rename|renaming|renamed|callers?|call sites?|usages?|consumers?|dependents?|everywhere|references? to|impact of)\b/i;

const READ_ONLY_KEYWORDS_RE = /^(what|how|why|explain|describe|understand)\b/i;

/** First two path segments (e.g. "pkg/account", "packages/foo") — a language-neutral stand-in for "top-level package/module boundary" that works for both Go-style multi-package repos and Node monorepo `packages/*` layouts. */
function packageKeyOf(p: string): string | undefined {
  const parts = p.split("/");
  // Require a real subdirectory nesting (top-dir/package-dir/file...) before
  // treating the first two segments as a package boundary. A flat 2-segment
  // path ("src/util.ts") has NO package subdirectory — its second segment is
  // just the filename, and counting each distinct filename as its own
  // "package" would make any multi-file candidate set in a flat directory
  // spuriously look cross-package.
  if (parts.length < 3) return undefined;
  return `${parts[0]}/${parts[1]}`;
}

function topLevelPackageCount(paths: readonly string[]): number {
  const keys = new Set<string>();
  for (const p of paths) {
    const key = packageKeyOf(p);
    if (key) keys.add(key);
  }
  return keys.size;
}

interface Rule {
  signal: string;
  profile: TaskProfileId;
  confidence: number;
  matches(input: TaskFamilyInput, norm: NormalizedQuery): boolean;
}

const RULES: readonly Rule[] = [
  {
    signal: "explicit-path-scope",
    profile: "known-local",
    confidence: 0.9,
    matches: (input) => Boolean(input.explicitPath && input.explicitPath.length > 0),
  },
  {
    signal: "query-is-path-shaped",
    profile: "known-local",
    confidence: 0.8,
    matches: (input, norm) => norm.pathTokens.includes(input.query.trim()),
  },
  {
    signal: "error-code-token",
    profile: "failure-diagnosis",
    confidence: 0.85,
    matches: (_input, norm) => norm.errorCodeTokens.length > 0,
  },
  {
    signal: "stack-frame-shape",
    profile: "failure-diagnosis",
    confidence: 0.75,
    matches: (input) => STACK_FRAME_RE.test(input.query),
  },
  {
    signal: "doc-extension-candidates",
    profile: "cross-document",
    confidence: 0.75,
    matches: (input) => {
      const paths = input.candidatePaths ?? [];
      if (paths.length === 0) return false;
      const docCount = paths.filter(hasDocExtension).length;
      return docCount / paths.length >= 0.5;
    },
  },
  {
    signal: "doc-extension-query-token",
    profile: "cross-document",
    confidence: 0.65,
    matches: (_input, norm) => norm.pathTokens.some(hasDocExtension),
  },
  {
    signal: "rename-impact-keyword-with-symbol",
    profile: "change-propagation",
    confidence: 0.78,
    matches: (input) => Boolean(input.symbol) && CHANGE_PROPAGATION_KEYWORDS_RE.test(input.query),
  },
  {
    signal: "rename-impact-keyword",
    profile: "change-propagation",
    confidence: 0.65,
    matches: (input) => CHANGE_PROPAGATION_KEYWORDS_RE.test(input.query),
  },
  {
    signal: "multi-package-candidates",
    profile: "cross-package",
    confidence: 0.7,
    matches: (input) => topLevelPackageCount(input.candidatePaths ?? []) >= 2,
  },
  {
    signal: "exact-symbol-known",
    profile: "navigation",
    confidence: 0.65,
    matches: (input) => Boolean(input.symbol && input.symbol.trim().length > 0),
  },
  {
    signal: "explanation-phrasing",
    profile: "read-only",
    confidence: 0.6,
    matches: (input) => READ_ONLY_KEYWORDS_RE.test(input.query.trim()) && !input.symbol,
  },
];

/**
 * Infer a task profile from local, deterministic query/args signals only.
 * Every rule in RULES is checked; the rule with the HIGHEST confidence wins
 * (ties broken by RULES's own declaration order). A result under
 * MIN_CONFIDENCE — including "nothing matched at all" (confidence 0) — folds
 * to "general".
 */
export function inferTaskFamily(input: TaskFamilyInput): TaskFamilyResult {
  const norm = normalizeQuery(input.query);
  const fired: Array<{ profile: TaskProfileId; confidence: number; signal: string }> = [];
  for (const rule of RULES) {
    if (rule.matches(input, norm)) fired.push({ profile: rule.profile, confidence: rule.confidence, signal: rule.signal });
  }
  if (fired.length === 0) return { profile: "general", confidence: 0, signals: [] };
  const best = fired.reduce((a, b) => (b.confidence > a.confidence ? b : a));
  if (best.confidence < MIN_CONFIDENCE) {
    return { profile: "general", confidence: best.confidence, signals: [best.signal] };
  }
  const signals = fired.filter((f) => f.profile === best.profile).map((f) => f.signal);
  return { profile: best.profile, confidence: best.confidence, signals };
}
