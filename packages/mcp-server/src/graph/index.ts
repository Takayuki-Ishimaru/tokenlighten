/**
 * graph/index.ts — optional static graph index consumer for v0.7.
 *
 * Reads a tl-graph.json or minimal SCIP binpb from .tokenlighten/index/.
 * When no index exists, returns undefined (fallback to tree-sitter/ripgrep).
 * When TL_GRAPH_INDEX=off, always returns undefined without reading anything.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { graphIndexMode } from "../util/flags.js";
import { trace } from "../util/trace.js";
import { parseTlGraph } from "./tlGraphReader.js";
import { parseScip } from "./scipReader.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GraphLocation {
  path: string;
  line: number;
  column: number;
}

export interface GraphIndex {
  definition(symbol: string): GraphLocation | undefined;
  references(symbol: string): GraphLocation[];
  importsOf(filePath: string): string[];
  exportsOf(filePath: string): string[];
  /**
   * FX-U2 (round 19B finding 1, 2026-09-04): how many DISTINCT definition
   * sites this index recorded under this exact BARE symbol name — never a
   * count of references, and never scoped to any one class. `references()`
   * merges reference locations across every definition that shares a bare
   * name (`graphBuilder.ts`'s `buildTlGraphFromManifest` step 3 pushes one
   * `TlGraphSymbol` entry per definition sharing a name, each carrying the
   * SAME merged reference list — there is no per-reference class/scope tag
   * anywhere in this schema), so a consumer cannot tell from
   * `references()`/`definition()` alone whether attributing that merged
   * list to one specific definition is safe: `definition()` silently
   * collapses to whichever same-named entry happened to parse/sort last.
   * `definitionCount(name) <= 1` means the merged list can only ever belong
   * to that one symbol (safe to attribute); `> 1` means at least two
   * distinct definitions share the bare name and the merged list cannot be
   * attributed to either without a guess.
   *
   * Optional and purely additive: a `GraphIndex` that does not implement it
   * (`scipReader.ts`'s SCIP-backed index today, and every hand-built test
   * double predating this fix) is queried with `?.()` and MUST be treated
   * permissively by every consumer — as if the count were `<= 1` — never as
   * "definitely ambiguous". This is a new capability layered on the
   * existing contract, never a new requirement on an existing
   * implementation.
   */
  definitionCount?(symbol: string): number;
  /**
   * FX-V2 (round 20B finding 1, HIGH, 2026-09-04, ruling (y)): whether this
   * index is backed by a REAL call-edge source — occurrences that attribute
   * a genuine CALL SITE to a definition. The bare-identifier-token-counting
   * `tlGraphReader.ts` index is NOT a call-edge source and MUST return
   * `false`: `indexStore.ts`'s `outgoingSymbolRefs` counts every raw
   * identifier token that matches a symbol's bare name ANYWHERE in a
   * file — a comment mentioning the name, an unrelated same-named local
   * variable, or the definition's own out-of-line body (which contains its
   * own name) all count identically to a genuine call site. Round-20B
   * finding 1 proved this reaches the wire as a fabricated, indistinguishable
   * `direct_calls` relation (confidence 0.9) for a file that never calls the
   * anchored method at all, including the definition's own file calling
   * itself.
   *
   * FX-W1 (round 21B finding 1, HIGH, 2026-09-04, ruling (z)): a SCIP index
   * is NOT a call-edge source either, and `parseScip`'s `GraphIndex` now
   * returns `false` here too. SCIP's `symbol_roles` bitmask (Definition/
   * Import/WriteAccess/ReadAccess/Generated/Test/ForwardDefinition — see
   * `scipReader.ts`'s field-3 comment) distinguishes a definition from every
   * other kind of occurrence, but SCIP defines no "call" role at all: a
   * plain reference occurrence (an import, a value read, a callback
   * assignment, a type reference) reaches this same "not a definition"
   * bucket a genuine call site would, and round-21B proved an import-only
   * file was admitted as a `direct_calls` caller through exactly this gate.
   * No provider in this codebase proves a call today — `hasCallEdges()`
   * is reserved for a genuine call-graph provider (a parser call-site
   * extraction, an apiGraph `CALLS` edge, or a future SCIP-adjacent format
   * that actually carries call attribution) that does not exist yet. See
   * `hasReferenceOccurrences` below for the (weaker, still useful) capability
   * SCIP's occurrence data DOES support honestly.
   *
   * `relationGraphPort.ts`'s `callersOf` MUST NOT be attached to
   * `references` (i.e., `callers` must never be computed or emitted) for a
   * `GraphIndex` this returns `false`/`undefined` for. `references()` alone
   * is never sufficient proof of a call edge — only `hasCallEdges() ===
   * true` is.
   *
   * Optional and purely additive — but the SAFE default when a `GraphIndex`
   * does not implement this method is the OPPOSITE of `definitionCount`'s:
   * every hand-built test double predating this capability, and any future
   * format nobody has taught this codebase to trust yet, MUST be treated as
   * `false` (never permissively as `true`), because treating an unknown
   * index as a call-edge source risks fabricating `direct_calls` relations
   * from mere textual co-occurrence — the exact defect this capability
   * exists to close.
   */
  hasCallEdges?(): boolean;
  /**
   * FX-W1 (round 21B finding 1, HIGH, 2026-09-04, ruling (z)): whether this
   * index is backed by a real OCCURRENCE source — every location
   * `references(symbol)` returns is a genuine attributed use site (file+line
   * where the symbol's identifier actually resolves there, per the indexer),
   * with definition and import occurrences already excluded by the reader —
   * never a whole-file identifier-TOKEN count that also matches a comment,
   * an unrelated same-named local, or the definition's own out-of-line body
   * (the exact `tlGraphReader.ts` shape `hasCallEdges`'s own doc describes).
   *
   * This is DELIBERATELY WEAKER than `hasCallEdges`: it proves "this
   * location mentions the symbol", never "this location calls it" — SCIP's
   * occurrence roles (Definition/Import/WriteAccess/ReadAccess/…) carry no
   * "call" role at all (see `hasCallEdges`'s doc above), so an index that
   * returns `true` here may still return `false`/`undefined` from
   * `hasCallEdges`. A caller MUST NOT use this capability to emit
   * `direct_calls` — only the honest, lower-confidence `"referenced_by"`
   * relation kind (`@tokenlighten/types`'s `TaskEvidenceRelationKind`,
   * additive) may be grounded on it.
   *
   * `parseScip`'s `GraphIndex` returns `true` (its `references()` already
   * excludes Definition/Import roles, per `scipReader.ts`'s
   * `buildGraphIndex`). `parseTlGraph`'s token-count index returns
   * `false`/omits this method — a raw identifier-token count is not a
   * reliable "genuine mention" signal either (the same comment-mention /
   * same-named-local problem `hasCallEdges`'s doc describes applies equally
   * to "referenced", not only to "called").
   *
   * Optional and purely additive; the safe default when a `GraphIndex` does
   * not implement this method is `false` (never permissively `true`) — the
   * same non-permissive direction as `hasCallEdges`, for the same reason: an
   * untaught format must never be trusted as a reference-occurrence source
   * by default.
   */
  hasReferenceOccurrences?(): boolean;
  /**
   * V11-09/V11-05: the index's own content-addressed root/generation
   * identity, when the backing format carries one. tl-graph.json stamps a
   * `rootHash` (skeleton-engine/graphBuilder.ts) that changes exactly when
   * the manifest it was built from changes; `parseTlGraph` surfaces it here
   * so a consumer never has to re-open and re-parse the file's head bytes
   * itself (the previous approach — see graph-evidence/adapters.ts's now-
   * deleted `readTlGraphGeneration` probe — duplicated this read outside
   * the reader that already owns the schema).
   *
   * Returns `undefined` when the backing format has no such identity (SCIP
   * today — `parseScip`'s GraphIndex always returns undefined here) or when
   * a tl-graph.json was read without one (an old/hand-built fixture). A
   * consumer MUST treat `undefined` as "cannot prove freshness" and fail
   * closed, never as "assume fresh".
   */
  rootHash(): string | undefined;
}

// ---------------------------------------------------------------------------
// Workspace-scoped one-time trace guard
// ---------------------------------------------------------------------------

const _missingLogged = new Set<string>();

// ---------------------------------------------------------------------------
// Parsed-graph memo
// ---------------------------------------------------------------------------
//
// Locate probes the graph on every call; a repo-scale tl-graph.json or
// scip.binpb must not be re-read and re-parsed each time. Entries are keyed
// by graph path and revalidated by size+mtime. `index: undefined` memoizes
// an over-cap (or non-regular-file) skip so a stat is the only recurring
// cost. Above GRAPH_INDEX_MAX_BYTES the graph is skipped in auto mode — a
// synchronous parse that large makes every locate slower than having no
// graph at all; TL_GRAPH_INDEX=on overrides the size cap only — a directory
// is never a valid target regardless of override.
export const GRAPH_INDEX_MAX_BYTES = 64 * 1024 * 1024;
const GRAPH_MEMO_MAX_ENTRIES = 4;
const _graphMemo = new Map<string, { sizeBytes: number; mtimeMs: number; index: GraphIndex | undefined }>();
const _oversizeLogged = new Set<string>();

function rememberGraph(graphPath: string, stat: fs.Stats, index: GraphIndex | undefined): void {
  _graphMemo.delete(graphPath);
  if (_graphMemo.size >= GRAPH_MEMO_MAX_ENTRIES) {
    const oldest = _graphMemo.keys().next().value;
    if (oldest !== undefined) _graphMemo.delete(oldest);
  }
  _graphMemo.set(graphPath, { sizeBytes: stat.size, mtimeMs: stat.mtimeMs, index });
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Load a graph index from the workspace's .tokenlighten/index/ directory.
 * Returns undefined if the index is missing, off, or unsupported format.
 */
export function loadGraphIndex(
  workspace: string,
  _options?: { trace?: boolean },
): GraphIndex | undefined {
  const mode = graphIndexMode();
  if (mode === "off") {
    return undefined;
  }

  const indexDir = path.join(workspace, ".tokenlighten", "index");

  // Priority a: scip.binpb (round-22B finding 1, HIGH, 2026-09-04, ruling
  // (bb)/(z)-adjacent). A real, externally-authored SCIP index is a richer,
  // more honest evidence source than TokenLighten's own auto-generated
  // bare-identifier-token-count tl-graph.json (see GraphIndex.hasCallEdges's
  // doc) — it must never be silently shadowed by that fallback, including
  // when a STALE tl-graph.json was already on disk before scip.binpb was
  // ever introduced to this workspace (loadOrBuildSourceIndex's step 10
  // writes/refreshes tl-graph.json unconditionally on every ordinary read,
  // with no scip-awareness — see graphBuilder.ts's writeGraphIfStale). This
  // is a pure read-time preference: it requires no coordination with WHEN
  // either file was written, so a pre-existing stale tl-graph.json is
  // shadowed by a valid scip.binpb exactly the same as a freshly-written one.
  // A missing, oversized, non-file, or unparseable scip.binpb falls through
  // to tl-graph.json below — same "invalid means try the next source" shape
  // this function already had for lsif.json falling through to "no index".
  const scipPath = path.join(indexDir, "scip.binpb");
  if (fs.existsSync(scipPath)) {
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(scipPath);
    } catch {
      stat = undefined;
    }
    let scipInvalid = false;
    if (stat !== undefined) {
      const memo = _graphMemo.get(scipPath);
      if (memo !== undefined && memo.sizeBytes === stat.size && memo.mtimeMs === stat.mtimeMs) {
        if (memo.index !== undefined) return memo.index;
        scipInvalid = true;
      } else if (!stat.isFile()) {
        if (!_oversizeLogged.has(scipPath)) {
          _oversizeLogged.add(scipPath);
          trace("graph-index-not-a-file", { file: "scip.binpb" }, workspace);
        }
        rememberGraph(scipPath, stat, undefined);
        scipInvalid = true;
      } else if (stat.size > GRAPH_INDEX_MAX_BYTES && mode !== "on") {
        if (!_oversizeLogged.has(scipPath)) {
          _oversizeLogged.add(scipPath);
          trace(
            "graph-index-too-large",
            { file: "scip.binpb", sizeBytes: stat.size, maxBytes: GRAPH_INDEX_MAX_BYTES },
            workspace,
          );
        }
        rememberGraph(scipPath, stat, undefined);
        scipInvalid = true;
      }
    }
    if (!scipInvalid) {
      try {
        const buf = fs.readFileSync(scipPath);
        const index = parseScip(buf);
        if (stat !== undefined) rememberGraph(scipPath, stat, index);
        return index;
      } catch (err) {
        trace("graph-index-parse-error", { file: "scip.binpb", error: String(err) }, workspace);
        // Fall through to tl-graph.json — an invalid scip.binpb must not
        // black out an otherwise-usable index the way it would have if this
        // returned undefined outright.
      }
    }
  }

  // Priority b: tl-graph.json — used when scip.binpb is absent or invalid.
  const tlGraphPath = path.join(indexDir, "tl-graph.json");
  if (fs.existsSync(tlGraphPath)) {
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(tlGraphPath);
    } catch {
      stat = undefined;
    }
    if (stat !== undefined) {
      const memo = _graphMemo.get(tlGraphPath);
      if (memo !== undefined && memo.sizeBytes === stat.size && memo.mtimeMs === stat.mtimeMs) {
        return memo.index;
      }
      if (stat.size > GRAPH_INDEX_MAX_BYTES && mode !== "on") {
        if (!_oversizeLogged.has(tlGraphPath)) {
          _oversizeLogged.add(tlGraphPath);
          trace(
            "graph-index-too-large",
            { file: "tl-graph.json", sizeBytes: stat.size, maxBytes: GRAPH_INDEX_MAX_BYTES },
            workspace,
          );
        }
        rememberGraph(tlGraphPath, stat, undefined);
        return undefined;
      }
    }
    try {
      const text = fs.readFileSync(tlGraphPath, "utf8");
      const index = parseTlGraph(text);
      if (stat !== undefined) rememberGraph(tlGraphPath, stat, index);
      return index;
    } catch (err) {
      // On parse error treat as missing — don't crash the server.
      trace("graph-index-parse-error", { file: "tl-graph.json", error: String(err) }, workspace);
      return undefined;
    }
  }

  // Priority c: lsif.json — unsupported, trace and return undefined.
  const lsifPath = path.join(indexDir, "lsif.json");
  if (fs.existsSync(lsifPath)) {
    trace("lsif-unimplemented", { file: "lsif.json" }, workspace);
    return undefined;
  }

  // No index found.
  if (mode === "auto" && !_missingLogged.has(workspace)) {
    _missingLogged.add(workspace);
    trace("graph-index-missing", { workspace }, workspace);
  }
  return undefined;
}

/** Reset the one-time trace guards and the parsed-graph memo (for tests). */
export function resetMissingLoggedForTest(): void {
  _missingLogged.clear();
  _oversizeLogged.clear();
  _graphMemo.clear();
}
