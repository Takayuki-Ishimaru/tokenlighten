/**
 * continuation.ts — DESIGN-v0.9 §5 (WS2) ContinuationPlan.
 *
 * A model-agnostic structured plan for the residual work a read response
 * leaves: what to do next, in a server-verified order, in a shape any client
 * can execute. The legacy `next` string is PRESERVED and DERIVED from
 * `stages[0].calls[0]` (single source of truth, §5.3), so a client that reads
 * only `next` gets the first step and a client that reads `continuation` gets
 * the whole plan — they can never diverge.
 *
 * Wave-1 emits a plan ONLY when it adds information beyond the single `next`
 * (>=2 total calls or >=2 stages, §5.4); a single-step residual ships as `next`
 * alone. The canonical runtime types live here (functionally required); an
 * additive CONTRACT mirror lives in packages/types/src/mcp.ts.
 */

// ---------------------------------------------------------------------------
// Types (§5.1) — mirrored additively in packages/types/src/mcp.ts.
// ---------------------------------------------------------------------------

/** One of the 3 advertised tools. */
export type ContinuationTool = "read_file" | "edit_file" | "search_files";

export interface ContinuationCall {
  /** The tool to call — one of the 3 advertised tools. */
  tool: ContinuationTool;
  /** Schema-valid arguments for `tool` (validated against the advertised JSON schema). */
  arguments: Record<string, unknown>;
  /** Optional human-readable purpose (<=60 chars); decorative — first to shed under the byte budget. */
  purpose?: string;
}

export interface ContinuationStage {
  /**
   * "parallel": a capable client MAY batch these calls in one message.
   * "sequential": run in order. Because a stage has NO intra-stage data
   * dependency by construction, a client that ignores `execution` and runs
   * everything sequentially still produces correct results (§5.2).
   */
  execution: "parallel" | "sequential";
  /** 1..3 calls, no intra-stage data dependency. */
  calls: ContinuationCall[];
}

export interface ContinuationPlan {
  version: 1;
  /** Ordered stages; emitted only when non-empty. Later stages may depend on earlier ones. */
  stages: ContinuationStage[];
}

// ---------------------------------------------------------------------------
// Budgets (§5.4)
// ---------------------------------------------------------------------------

/** Typical serialized-plan target (guidance, not enforced). */
export const CONTINUATION_TYPICAL_BYTES = 800;

/** Hard serialized-plan cap (§5.4) — the trim ladder enforces this. */
export const CONTINUATION_HARD_CAP_BYTES = 1200;

/** Max calls per stage (§5.1). */
export const MAX_STAGE_CALLS = 3;

const MAX_BATCH_HANDLES = 6;

// ---------------------------------------------------------------------------
// Legacy `next` <-> structured call (exact inverses on the emitted forms).
//
// nextHintForCoverage / buildTaskPack / buildDiffTaskPack / resolveSlice emit a
// small, fixed set of `next` string shapes. callToNextString reproduces them
// EXACTLY and nextStringToCall parses them back, so deriveNextFromPlan is
// identity with the pre-existing `next`. Any shape not in this set
// (styleNextForMissingRole, wiringConsumerNext, the re-scope string) parses to
// `undefined`, which makes buildContinuation bail rather than perturb it.
// ---------------------------------------------------------------------------

// 2026-07-31: JSON string escaping, not bare interpolation. An item carrying a
// double quote used to be embedded raw, and parseQuotedList's `"([^"]*)"` then
// stopped at it — `paths=["packages/a"b"]` parsed back as `["packages/a"]`. That
// is worse than dropping the hint: the truncation can name a DIFFERENT path that
// exists, so the follow-up reads the wrong file and reports success. Handles and
// surface roles cannot contain a quote, but caller-supplied paths can.
// JSON.stringify/parse is byte-identical to the old encoding for every item
// without a quote or backslash, so no emitted form changes in practice.
function quoteList(items: string[]): string {
  return items.map((item) => JSON.stringify(item)).join(",");
}

function parseQuotedList(inner: string): string[] {
  const out: string[] = [];
  const re = /"(?:[^"\\]|\\.)*"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    try {
      const parsed: unknown = JSON.parse(m[0]);
      if (typeof parsed === "string") out.push(parsed);
    } catch {
      // A malformed item is dropped rather than guessed at — a wrong-but-real
      // path is the failure mode this whole change exists to prevent.
    }
  }
  return out;
}

/**
 * Serialize a ContinuationCall to the legacy `next` string, reproducing
 * nextHintForCoverage's exact forms. Returns undefined for a call shape that
 * has no legacy-string form (so callers keep whatever `next` they held).
 */
export function callToNextString(call: ContinuationCall): string | undefined {
  const a = call.arguments;
  if (call.tool === "read_file") {
    if (Array.isArray(a["handles"])) {
      return `read_file handles=[${quoteList((a["handles"] as unknown[]).map(String))}]`;
    }
    if (a["mode"] === "task_pack" && typeof a["query"] === "string" && Array.isArray(a["surfaceRoles"])) {
      return `read_file mode=task_pack query="${a["query"]}" surfaceRoles=[${quoteList((a["surfaceRoles"] as unknown[]).map(String))}]`;
    }
    if (a["mode"] === "task_pack" && typeof a["query"] === "string" && Array.isArray(a["paths"])) {
      // paths[] also accepts {path,symbol} objects; only the plain-string form
      // round-trips through this line-oriented encoding, so bail out rather
      // than emitting "[object Object]".
      const entries = a["paths"] as unknown[];
      const plain = entries.filter((item): item is string => typeof item === "string");
      if (plain.length === entries.length && plain.length > 0) {
        return `read_file mode=task_pack query="${a["query"]}" paths=[${quoteList(plain)}]`;
      }
    }
    if (a["mode"] === "slice" && typeof a["handle"] === "string") {
      let s = `read_file mode=slice handle=${a["handle"]}`;
      if (typeof a["range"] === "string") s += ` range=${a["range"]}`;
      if (a["comments"] === "keep") s += ` comments=keep`;
      return s;
    }
    return undefined;
  }
  if (call.tool === "edit_file") {
    if (typeof a["handle"] === "string") return `edit_file handle=${a["handle"]}`;
    return undefined;
  }
  // search_files
  if (a["action"] === "find" && typeof a["query"] === "string") {
    return `search_files action=find query=${a["query"]}`;
  }
  if (a["action"] === "locate" && typeof a["query"] === "string") {
    return `search_files action=locate query="${a["query"]}"`;
  }
  if (a["action"] === "references" && typeof a["query"] === "string") {
    return `search_files action=references query=${a["query"]}`;
  }
  if (a["action"] === "tree") {
    return typeof a["path"] === "string"
      ? `search_files action=tree path=${a["path"]}`
      : "search_files action=tree";
  }
  if (Array.isArray(a["queries"])) {
    return `search_files queries=[${quoteList((a["queries"] as unknown[]).map(String))}]`;
  }
  return undefined;
}

/**
 * Parse a legacy `next` string into a structured ContinuationCall, the exact
 * inverse of callToNextString on the emitted forms. Returns undefined for any
 * shape outside that set (free-text re-scope hints, wiring/style nexts).
 */
export function nextStringToCall(next: string): ContinuationCall | undefined {
  const s = next.trim();
  let m: RegExpMatchArray | null;

  if ((m = s.match(/^read_file handles=\[(.*)\]$/)) !== null) {
    return { tool: "read_file", arguments: { handles: parseQuotedList(m[1]!) } };
  }
  if ((m = s.match(/^read_file mode=task_pack query="(.*)" surfaceRoles=\[(.*)\]$/)) !== null) {
    return { tool: "read_file", arguments: { mode: "task_pack", query: m[1]!, surfaceRoles: parseQuotedList(m[2]!) } };
  }
  // Path-scoped re-seed. A caller-supplied directory that yielded no surface is
  // a PATH gap; the surfaceRoles form above cannot express it, and leaving this
  // form unparsed would drop the one follow-up that actually closes the gap.
  if ((m = s.match(/^read_file mode=task_pack query="(.*)" paths=\[(.*)\]$/)) !== null) {
    return { tool: "read_file", arguments: { mode: "task_pack", query: m[1]!, paths: parseQuotedList(m[2]!) } };
  }
  if ((m = s.match(/^read_file mode=slice handle=(\S+?)(?: range=(\S+))?(?: comments=keep)?$/)) !== null) {
    const args: Record<string, unknown> = { mode: "slice", handle: m[1]! };
    if (m[2]) args["range"] = m[2];
    if (s.endsWith(" comments=keep")) args["comments"] = "keep";
    return { tool: "read_file", arguments: args };
  }
  if ((m = s.match(/^edit_file handle=(\S+)$/)) !== null) {
    return { tool: "edit_file", arguments: { handle: m[1]! } };
  }
  if ((m = s.match(/^search_files action=find query=(\S+)$/)) !== null) {
    return { tool: "search_files", arguments: { action: "find", query: m[1]! } };
  }
  if ((m = s.match(/^search_files action=locate query="(.*)"$/)) !== null) {
    return { tool: "search_files", arguments: { action: "locate", query: m[1]! } };
  }
  if ((m = s.match(/^search_files action=references query=(\S+)$/)) !== null) {
    return { tool: "search_files", arguments: { action: "references", query: m[1]! } };
  }
  if ((m = s.match(/^search_files action=tree(?: path=(\S+))?$/)) !== null) {
    return {
      tool: "search_files",
      arguments: { action: "tree", ...(m[1] ? { path: m[1] } : {}) },
    };
  }
  if ((m = s.match(/^search_files queries=\[(.*)\]$/)) !== null) {
    return { tool: "search_files", arguments: { queries: parseQuotedList(m[1]!) } };
  }
  return undefined;
}

/**
 * §5.3 legacy-next derivation: the `next` string is ALWAYS the serialization of
 * the plan's first call. Single source of truth — used everywhere a plan is
 * emitted so `next` and `continuation` can never diverge. Returns undefined
 * only for an empty plan or a first call with no legacy-string form (the caller
 * then keeps its prior `next`).
 */
export function deriveNextFromPlan(plan: ContinuationPlan): string | undefined {
  const first = plan.stages[0]?.calls[0];
  if (!first) return undefined;
  return callToNextString(first);
}

// ---------------------------------------------------------------------------
// Byte budget + trim ladder (§5.4)
// ---------------------------------------------------------------------------

function serializedBytes(plan: ContinuationPlan): number {
  return Buffer.byteLength(JSON.stringify(plan), "utf8");
}

/** Trim-ladder rung 1 (exported for direct unit coverage): drop all `purpose` strings. */
export function dropPurposes(plan: ContinuationPlan): ContinuationPlan {
  return {
    version: 1,
    stages: plan.stages.map((st) => ({
      execution: st.execution,
      calls: st.calls.map((c) => ({ tool: c.tool, arguments: c.arguments })),
    })),
  };
}

/** Trim-ladder rung 2 (exported for direct unit coverage): merge adjacent same-`execution` stages. */
export function mergeAdjacentSameExecution(plan: ContinuationPlan): ContinuationPlan {
  const merged: ContinuationStage[] = [];
  for (const st of plan.stages) {
    const last = merged[merged.length - 1];
    if (last && last.execution === st.execution && last.calls.length + st.calls.length <= MAX_STAGE_CALLS) {
      last.calls = [...last.calls, ...st.calls];
    } else {
      merged.push({ execution: st.execution, calls: [...st.calls] });
    }
  }
  return { version: 1, stages: merged };
}

/**
 * §5.4 trim ladder. Return the plan trimmed to fit CONTINUATION_HARD_CAP_BYTES,
 * or undefined when even the fully-trimmed plan is over cap (rung 3: collapse
 * to the legacy `next` string only — the caller drops `continuation` and keeps
 * `next`, which was already derived from the same first call). Trim order:
 *   1. drop `purpose` strings (decorative),
 *   2. merge adjacent same-`execution` stages,
 *   3. collapse (return undefined).
 */
export function enforceContinuationBudget(plan: ContinuationPlan): ContinuationPlan | undefined {
  if (serializedBytes(plan) <= CONTINUATION_HARD_CAP_BYTES) return plan;
  const rung1 = dropPurposes(plan);
  if (serializedBytes(rung1) <= CONTINUATION_HARD_CAP_BYTES) return rung1;
  const rung2 = mergeAdjacentSameExecution(rung1);
  if (serializedBytes(rung2) <= CONTINUATION_HARD_CAP_BYTES) return rung2;
  return undefined;
}

// ---------------------------------------------------------------------------
// buildContinuation — the Wave-1 emission (§5, §4.6-adjacent).
// ---------------------------------------------------------------------------

/** The minimal pack-shaped view buildContinuation reads (avoids a hard dep on TaskPackResult). */
export interface ContinuationSource {
  coverage?: "complete" | "focused" | "partial";
  next?: string;
  surfaces?: Array<{ handle: string; code?: string; code_unchanged?: string }>;
}

function codelessHandles(src: ContinuationSource): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of src.surfaces ?? []) {
    if (s.code === undefined && s.code_unchanged === undefined && s.handle && !seen.has(s.handle)) {
      seen.add(s.handle);
      out.push(s.handle);
    }
  }
  return out.slice(0, MAX_BATCH_HANDLES);
}

/**
 * Build a ContinuationPlan from a task_pack result, or undefined when `next`
 * alone suffices. Emission (Wave-1 site (i)): a PARTIAL pack whose residual
 * genuinely implies >=2 independent follow-up reads — a concern search that
 * did NOT cover everything (the existing `search_files action=find` next) AND
 * a batch read of the surfaces the pack DID identify but left code-less. Both
 * are known at emission time with no intra-stage dependency, so they ship as
 * ONE parallel stage. `stages[0].calls[0]` reproduces the existing `next`
 * exactly (nextStringToCall round-trip), so deriveNextFromPlan is identity and
 * no `next`-pinned test is perturbed.
 *
 * Returns undefined when: no `next`; `next` is not a recognized tool-call shape
 * (re-scope/wiring/style free text); or fewer than 2 independent calls exist
 * (single-step residual — `next` alone, per §5.4). The byte-budget trim ladder
 * is applied by attachSupply at the dispatch boundary, not here.
 */
export function buildContinuation(src: ContinuationSource): ContinuationPlan | undefined {
  if (typeof src.next !== "string" || src.next.length === 0) return undefined;
  const first = nextStringToCall(src.next);
  if (!first) return undefined;

  const calls: ContinuationCall[] = [first];

  // Second deterministic, independent call: read the already-identified but
  // code-less surfaces. Only meaningful when the FIRST step is a concern
  // search (not already a handles read / edit / re-pack) — a search finds the
  // uncovered concern while the batch read fetches what we already located,
  // two independent reads the agent would otherwise serialize. A re-pack
  // (surfaceRoles) first step is excluded: it re-fetches everything, so a
  // parallel current-handles read would be redundant.
  const firstIsSearch = first.tool === "search_files" && first.arguments["action"] === "find";
  if (firstIsSearch) {
    const handles = codelessHandles(src);
    if (handles.length >= 1) {
      const readCall: ContinuationCall = { tool: "read_file", arguments: { handles } };
      const readStr = callToNextString(readCall);
      // Never duplicate the first call (defensive — a find and a handles read
      // can't collide, but the dedup keeps the >=2-distinct-calls invariant honest).
      if (readStr !== undefined && readStr !== callToNextString(first)) {
        calls.push(readCall);
      }
    }
  }

  // §5.4 emission gate: only when the plan adds information beyond the single
  // `next` (>=2 total calls here; the >=2-stages case is not produced in Wave-1).
  if (calls.length < 2) return undefined;

  return {
    version: 1,
    stages: [{ execution: "parallel", calls: calls.slice(0, MAX_STAGE_CALLS) }],
  };
}
