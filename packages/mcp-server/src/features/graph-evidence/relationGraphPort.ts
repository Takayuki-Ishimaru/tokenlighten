// ---------------------------------------------------------------------------
// graph-evidence/relationGraphPort.ts — W-RELATION-WIRE: a real,
// production-grade `RelationGraphPort` (relationPacket.ts) PLUS the handle-
// minting step that must run before a packet can ever reach a wire response.
//
// NORMATIVE SOURCE: DESIGN-v0.15-semantic-frontier-plan.md §3.7 (relation
// packets — "edge の生成は features/graph-evidence の EdgeDeriver と provider 群を
// 使う。literal scan は使わない", §3.7.2), the W-RELATION-PACKET notes (the
// `unresolved:<nodeId>` projection placeholder "must be replaced by real
// handles before anything reaches plan.wiring.evidence_graph"), and D5
// (`resolveQualifiedSymbolAnchors`, readCodeTaskPack.ts — class-scoped
// qualified-anchor resolution; imported here, never modified).
//
// WHAT THIS MODULE IS
// --------------------
//  * `createWorkspaceRelationGraphPort()` — an ASYNC factory (parsing the
//    corpus with tree-sitter is async; the `RelationGraphPort` it returns is
//    fully synchronous, matching providers.ts's "SYNCHRONOUS" contract) that
//    binds `resolveDefinition` / `resolveDeclaration` / `edgesFor` /
//    `isTestPath` to real repository machinery:
//      - qualified anchors (`Class::member`) resolve via the D5 resolver
//        (`resolveQualifiedSymbolAnchors`), which is class-scoped by
//        construction (it classifies each candidate SITE's own enclosing
//        `class <Qualifier> { ... }` body, so a same-named member on a
//        different class never satisfies the anchor).
//      - bare `symbol` anchors resolve via the real parsed symbol table
//        (`adapters.ts`'s `createParserSymbolProvider`) — UNIQUE match only;
//        two-or-more declarations of the same name is an unresolved anchor,
//        not a guess.
//      - `edgesFor` runs `EdgeDeriver` (edges.ts) over the real tl-graph
//        providers (`adapters.ts`'s `createTlGraphProviders`) plus the parsed
//        symbol provider — giving IMPORTS/IMPORTED_BY/REFERENCES and (from
//        the parser) EXTENDS/IMPLEMENTS for free. This module ADDS a
//        `callersOf`/`calleesOf` pair on top of the SAME `GraphIndex` data
//        (never a literal/grep scan) so `compileRelationPacket`'s
//        caller/callee buckets — which key off `CALLS`/`CALLED_BY` edge
//        types — actually populate; see "WHY CALLERS/CALLEES ARE
//        CONSERVATIVE" below for the honesty tradeoff this makes.
//      - FX-W1 (round 21B finding 1, HIGH, 2026-09-04, ruling (z)) adds a
//        THIRD, separate `referencedBy` capability — file+line MENTIONS,
//        never proven calls — gated on `GraphIndex.hasReferenceOccurrences()`
//        (SCIP today) rather than `hasCallEdges()`. Deliberately bypasses
//        `edgesFor`/`EdgeDeriver` entirely (see `referencedBy`'s own comment
//        below for why).
//  * `mintRelationHandles()` — a POST-compile step: given the `RelationPacket`
//    `compileRelationPacket()` produced (whose sites/edge-lines may lack a
//    `.handle`, since minting one is an I/O side effect this compiler is
//    deliberately kept pure of), read each referenced file once, mint a REAL
//    `handleTable` handle (`util/handles.ts` — the same table `read_file`
//    resolves handles against) scoped to the exact known range (or the whole
//    file when no line is known), and return an updated packet with every
//    site/edge-line's `.handle` populated. A site whose handle cannot be
//    minted (unreadable file, path escapes the workspace, stale/out-of-range
//    line) is DROPPED from its bucket and counted in `truncated` — never left
//    as a `projectRelationPacketToEvidenceGraph()`-style `unresolved:*`
//    placeholder. Call this BEFORE `projectRelationPacketToEvidenceGraph()`
//    so the projection never needs its own placeholder branch in production.
//
// WHY CALLERS/CALLEES ARE CONSERVATIVE
// -------------------------------------
// `graph/index.ts`'s `GraphIndex` exposes `definition`/`references`/
// `importsOf`/`exportsOf` — there is no symmetric "what does this symbol
// call" query, and the underlying index is keyed by whatever symbol STRING
// the indexer chose — a bare short name for every language `graphBuilder.ts`
// supports; it never emits a combined `Class::member` entry. FX-U2 (round
// 19B finding 1, 2026-09-04): `callersOf` below therefore queries
// `references()`/`.definitionCount()` by the anchor's BARE member name,
// never the qualified spelling `resolveDefinition` resolved the anchor to
// (a prior version of this module queried the qualified string directly,
// which was a guaranteed-empty lookup against a bare-name-keyed index for
// EVERY qualified anchor — see git history / round-19B report for the
// pre-fix shape). Querying the bare name reintroduces exactly the ambiguity
// the qualified spelling existed to avoid — a same-named member on a
// DIFFERENT class would merge into the same `references()` list — so this
// module trades recall for the D5 class-scoping invariant the other way
// now: `callersOf` (via `unavailableRelationsForAnchor`) only ever exposes
// that list for an anchor whose bare member name has EXACTLY ONE definition
// site in the loaded `GraphIndex` (`definitionCount(name) <= 1`); when two
// or more classes share the name and the index carries no per-reference
// class-scope to disambiguate, the anchor's callers are disclosed as
// `unavailable` instead of guessed (see `callersOf`'s and
// `unavailableRelationsForAnchor`'s own comments below for the exact
// mechanism).
//
// FX-V2 (round 20B finding 1, HIGH, 2026-09-04, ruling (y)): the above is
// necessary but was not sufficient — round-20B proved that the loaded
// `GraphIndex` itself may not be a call-edge source AT ALL, regardless of
// how unambiguous a bare name is. `tlGraphReader.ts` (the common case: TL
// never writes `scip.binpb` itself) is built from `indexStore.ts`'s
// `outgoingSymbolRefs`, a raw identifier-TOKEN count over the whole file —
// a comment mentioning the name, an unrelated same-named local, or the
// definition's own out-of-line body (containing its own name) all count
// identically to a genuine call site. `definitionCount(name) <= 1` proves
// only that a merged reference list is not SHARED across definitions; it
// proves nothing about whether any one of those references is a real call.
// `callersOf` is therefore gated FIRST on `hasCallEdgeSource`
// (`GraphIndex.hasCallEdges() === true` — see `graph/index.ts`'s doc) and
// only THEN on the bare-name ambiguity check above; a token index never
// reaches the ambiguity check at all — `callers` is unconditionally
// unavailable for it. `calleesOf` only fires when the query symbol has a UNIQUE
// declaration in the parsed corpus (so it can locate "the anchor's own
// file" without guessing) — see the FX-G-B note below for why it is not
// attached at all today regardless. Neither path performs a text/substring
// scan of the workspace — every hit is grounded in either the real
// `GraphIndex` or the real parsed symbol table, bounded to
// `budget.maxEdges * 2` raw probes/hits before any ranking, per §3.7.2's
// "cap requests... before ranking".
//
// WHAT THIS MODULE IS NOT
// -------------------------
//  * NOT wired. Nothing outside this directory's own tests imports this file
//    this wave — see `__tests__/purity.spec.ts`'s
//    `RELATION_GRAPH_PORT_ALLOWED_FOREIGN_IMPORTS` / reachers checks and
//    `relationPacketPort.spec.ts`'s own "imported only by tests" guard. The
//    pack seam — deciding WHEN a relation concern is satisfied by a packet,
//    and projecting one into `plan.wiring.evidence_graph` — is the next task
//    (W-RELATION-PACKET's own header calls it "W-SATISFACTION's job").
//  * NOT reading flags. `sfRelationPacketsEnabled()` / `graphEvidenceEnabled()`
//    (`util/flags.ts`) gate the future WIRING, not this binding.
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";

import { loadGraphIndex, type GraphIndex } from "../../graph/index.js";
import { walkCodeFiles, type FoundFile } from "../../tools/walkRepo.js";
import { languageForPath } from "../../util/languages.js";
import { handleTable, shaOfText } from "../../util/handles.js";
import { isTestPath as skeletonIsTestPath } from "@tokenlighten/skeleton-engine";

import {
  createParserSymbolProvider,
  createTlGraphProviders,
  type SymbolSource,
} from "./adapters.js";
import { EdgeDeriver } from "./edges.js";
import { BoundTracker } from "./bounds.js";
import { fileNode, symbolNode, type GraphEdge, type GraphNode } from "./model.js";
import type { ProviderSet, ReferenceProvider, SymbolProvider, SymbolReference } from "./providers.js";
import {
  DEFAULT_RELATION_PACKET_BUDGET,
  type EdgeLine,
  type RelationAnchor,
  type RelationGraphPort,
  type RelationPacket,
  type RelationPacketBudget,
  type RelationPacketTruncation,
  type RelationReferenceLocation,
  type RelationResolvedSite,
  type RelationSite,
  type RelationUnavailableKind,
} from "./relationPacket.js";

// ---------------------------------------------------------------------------
// D5 qualified-anchor resolution — INJECTED, never imported (F7, round 11)
// ---------------------------------------------------------------------------
//
// This module used to import `resolveQualifiedSymbolAnchors` directly from
// `features/task-pack/readCodeTaskPack.ts`. That created a directory-level
// import CYCLE the moment `features/task-pack/sfRelationSeam.ts` became this
// module's sanctioned production importer: graph-evidence -> task-pack (for
// the resolver) -> task-pack's sfRelationSeam.ts -> graph-evidence (for this
// module) again. The resolver is injected by the caller instead — the ONE
// caller that matters, `sfRelationSeam.ts`, already lives in `task-pack` and
// passes the real `resolveQualifiedSymbolAnchors` straight through, so no
// cycle is created. `QualifiedSymbolAnchorResolution` is a structural mirror
// of that function's (unexported) `QualifiedAnchorResolution` return type —
// matching this directory's existing posture (see `relationPacket.ts`'s own
// `RelationEvidenceGraph` mirror) of never importing a type across the
// task-pack boundary either.
export interface QualifiedSymbolAnchorResolution {
  readonly definitions: readonly string[];
  readonly declarations: readonly string[];
  readonly counterparts: readonly string[];
  readonly lines: ReadonlyMap<string, number>;
}
export type QualifiedSymbolResolver = (query: string, workspaceRoot: string) => QualifiedSymbolAnchorResolution;

// ---------------------------------------------------------------------------
// The port factory
// ---------------------------------------------------------------------------

export interface CreateWorkspaceRelationGraphPortOptions {
  /** Absolute, fully resolved workspace root. */
  readonly workspaceRoot: string;
  /** Shared-workspace lane key, carried for callers that need it; unused internally. */
  readonly lane?: string;
  /** Sizes the `maxEdges * 2` raw fan-out cap; defaults to `DEFAULT_RELATION_PACKET_BUDGET`. */
  readonly budget?: Partial<RelationPacketBudget>;
  /** Test-only: inject a `GraphIndex` instead of loading tl-graph.json/scip.binpb from disk. */
  readonly index?: GraphIndex;
  /** Test-only, paired with `index`: the generation string to stamp on tl-graph edges. */
  readonly generation?: string;
  /** Test-only: parse exactly these workspace-relative paths instead of walking the workspace. */
  readonly files?: readonly string[];
  /** The real D5 resolver (`resolveQualifiedSymbolAnchors`, features/task-pack/readCodeTaskPack.ts), injected by the caller to avoid the import cycle described above. A qualified anchor resolves to `undefined` (never a guess) when this is omitted. */
  readonly qualifiedResolver?: QualifiedSymbolResolver;
}

/** The same `Class::member` / bare-name spelling `resolveQualifiedSymbolAnchors` and `declarationsOf` key on. */
function anchorSymbolKey(anchor: RelationAnchor): string | undefined {
  if (anchor.qualified !== undefined) return `${anchor.qualified.class}::${anchor.qualified.member}`;
  return anchor.symbol;
}

// ---------------------------------------------------------------------------
// FX-U2 (round 19B finding 1, HIGH, 2026-09-04): `callersOf` below is
// invoked with `node.symbol` — for a qualified anchor that is
// `anchorSymbolKey`'s QUALIFIED spelling (`"Sensor::isHealthy"`, minted by
// `resolveDefinition`'s `symbolNode(definitionPath, query, ...)` call below).
// `GraphIndex.references()` (`tlGraphReader.ts`) is an exact-string lookup
// keyed by the graph builder's BARE symbol name only (`graphBuilder.ts`
// never emits a combined "Class::member" entry) — so
// `graphIndex.references("Sensor::isHealthy")` was structurally guaranteed
// `[]` for EVERY qualified anchor, regardless of how many real callers
// exist, which is the root cause this wave fixes: `callersOf` now queries
// the BARE member name instead.
// ---------------------------------------------------------------------------

/** Strips a qualified `Class::member` spelling down to the bare member name `GraphIndex.references`/`.definitionCount` are keyed by; a bare `symbol` anchor's own spelling has no `::` and passes through unchanged. */
function bareMemberName(symbol: string): string {
  const idx = symbol.lastIndexOf("::");
  return idx === -1 ? symbol : symbol.slice(idx + 2);
}

/** The bare member name a caller-attribution ambiguity check keys on — `anchor.qualified.member` for a qualified anchor, `anchor.symbol` for a bare one, `undefined` for a path anchor (callers/callees never apply to those; see `edgesFor`/`edges.ts`'s `node.kind === "symbol"` guard). */
function anchorBareName(anchor: RelationAnchor): string | undefined {
  if (anchor.qualified !== undefined) return anchor.qualified.member;
  return anchor.symbol;
}

async function buildCorpus(
  options: CreateWorkspaceRelationGraphPortOptions,
): Promise<{ sources: SymbolSource[]; files: string[]; sourceShas: Map<string, string>; languages: string[] }> {
  const sources: SymbolSource[] = [];
  const sourceShas = new Map<string, string>();
  const languages = new Set<string>();
  const files: string[] = [];

  const found: readonly { relPath: string; absPath: string; language: string }[] =
    options.files !== undefined
      ? options.files.map((relPath) => ({
          relPath,
          absPath: path.join(options.workspaceRoot, relPath),
          language: languageForPath(relPath) ?? "default",
        }))
      : walkCodeFiles(options.workspaceRoot).map((f: FoundFile) => ({
          relPath: f.relPath,
          absPath: f.absPath,
          language: f.language,
        }));

  for (const file of found) {
    let text: string;
    try {
      text = fs.readFileSync(file.absPath, "utf8");
    } catch {
      continue;
    }
    files.push(file.relPath);
    sourceShas.set(file.relPath, shaOfText(text));
    if (file.language !== "default") languages.add(file.language);
    sources.push({ path: file.relPath, language: file.language, text });
  }

  return { sources, files, sourceShas, languages: [...languages].sort() };
}

export async function createWorkspaceRelationGraphPort(
  options: CreateWorkspaceRelationGraphPortOptions,
): Promise<RelationGraphPort> {
  const { workspaceRoot } = options;
  const maxEdges = options.budget?.maxEdges ?? DEFAULT_RELATION_PACKET_BUDGET.maxEdges;
  const rawFanoutCap = Math.max(1, maxEdges * 2);

  const corpus = await buildCorpus(options);
  const symbolProvider: SymbolProvider = await createParserSymbolProvider({ sources: corpus.sources });

  const graphIndex: GraphIndex | undefined = options.index ?? loadGraphIndex(workspaceRoot);
  // FX-V2 (round 20B finding 1, HIGH, 2026-09-04, ruling (y)): the ONLY
  // question that may gate attaching `callersOf` to `references` — never
  // "does a `GraphIndex` exist at all" (that was FX-R2's gate, and it is
  // what let a bare-identifier-token-counting index fabricate `direct_calls`
  // relations from mere textual co-occurrence; see `GraphIndex
  // .hasCallEdges`'s doc in `graph/index.ts`). Absent capability (an
  // index/test-double predating FX-V2) is treated as `false` — never
  // permissively — because an unproven index must never be trusted as a
  // call-edge source.
  const hasCallEdgeSource = graphIndex !== undefined && graphIndex.hasCallEdges?.() === true;
  // FX-W1 (round 21B finding 1, HIGH, 2026-09-04, ruling (z)): the weaker,
  // SEPARATE capability `referencedBy` below is gated on — proof of a real
  // OCCURRENCE (file+line mention), never proof of a call. Absent capability
  // (an index/test-double predating FX-W1, or `tlGraphReader.ts`'s token
  // count, which never implements it) is treated as `false` — never
  // permissively — mirroring `hasCallEdgeSource`'s own non-permissive
  // default, for the same reason: an unproven index must never be trusted as
  // a reference-occurrence source either.
  const hasReferenceSource = graphIndex !== undefined && graphIndex.hasReferenceOccurrences?.() === true;
  const tlProviders = createTlGraphProviders({
    workspace: workspaceRoot,
    files: corpus.files,
    sourceShas: corpus.sourceShas,
    languages: corpus.languages,
    ...(graphIndex !== undefined ? { index: graphIndex } : {}),
    ...(options.generation !== undefined ? { generation: options.generation } : {}),
  });

  function callersOf(symbol: string): readonly SymbolReference[] {
    // Unreachable defense-in-depth: this function is only ever attached to
    // `references` below when `hasCallEdgeSource` is true (FX-V2) — the real
    // disclosure boundary is that conditional attachment, not this guard.
    if (!hasCallEdgeSource) return [];
    const nonUndefinedIndex = graphIndex!;
    // FX-U2: `symbol` is `node.symbol` from `resolveDefinition`'s minted
    // node — the QUALIFIED spelling for a qualified anchor, the bare name
    // for a bare one (see the module-level comment above `bareMemberName`).
    // `GraphIndex.references`/`.definitionCount` are always keyed by the
    // bare name, so translate before querying either.
    const bareName = bareMemberName(symbol);
    // Defense-in-depth, mirroring the `hasCallEdgeSource` guard above: the
    // REAL disclosure boundary for an ambiguous bare name is
    // `unavailableRelationsForAnchor` below (compileRelationPacket never
    // admits an edge this function returns once that hook names "callers"
    // for the anchor being compiled) — but this function never emits a
    // merged, unattributable reference list either, in case a future
    // caller ever invokes `edgesFor` (hence this function) directly without
    // going through `compileRelationPacket`'s admission gate. Permissive
    // when the index does not implement `definitionCount` at all (never a
    // new requirement on an existing `GraphIndex`) — this ambiguity check
    // only ever runs now for a PROVEN call-edge source (FX-V2), never for
    // the bare-identifier-token-counting index (see `hasCallEdgeSource`'s
    // doc above): a token index's `definitionCount` could never make its
    // `references()` trustworthy no matter what it reports.
    const definitionCount = nonUndefinedIndex.definitionCount?.(bareName);
    if (definitionCount !== undefined && definitionCount > 1) return [];
    const raw = nonUndefinedIndex.references(bareName).slice(0, rawFanoutCap);
    const ranked = [...raw].sort((a, b) => (a.path === b.path ? a.line - b.line : a.path.localeCompare(b.path)));
    const seen = new Set<string>();
    const out: SymbolReference[] = [];
    for (const location of ranked) {
      if (seen.has(location.path)) continue;
      seen.add(location.path);
      out.push({ node: fileNode(location.path, "reference-index") });
    }
    return out;
  }

  // FX-W1 (round 21B finding 1, HIGH, 2026-09-04, ruling (z)): a SEPARATE,
  // weaker capability from `callersOf` above — file+line MENTIONS, never
  // proven calls. Gated FIRST on `hasReferenceSource`
  // (`GraphIndex.hasReferenceOccurrences() === true`), then on the SAME
  // bare-name ambiguity check `callersOf` applies (FX-U2's reasoning: a
  // merged reference list shared by two same-named definitions cannot be
  // attributed to either one without a guess — that is just as true for a
  // mention as it is for a call). This is a TOP-LEVEL `RelationGraphPort`
  // method (`compileRelationPacket` calls it directly, never through
  // `edgesFor`/`EdgeDeriver`) — see `RelationGraphPort.referencedBy`'s doc
  // (relationPacket.ts) for why: `edges.ts`/`providers.ts`/`adapters.ts`
  // already derive an unconditional `REFERENCES` `GraphEdge` from ANY
  // `references` provider (including `tlGraphReader.ts`'s bare-identifier-
  // token count), with no capability gate available to this module without
  // editing those files — bypassing that shared pipeline entirely is the
  // only way to keep the token-index format from also fabricating
  // `referenced_by` relations from mere textual co-occurrence, the same
  // class of defect ruling (y) already closed for `callers`.
  function referencedBy(anchor: RelationAnchor): readonly RelationReferenceLocation[] {
    if (!hasReferenceSource) return [];
    const bareName = anchorBareName(anchor);
    if (bareName === undefined) return []; // path anchors carry no member to look up
    const nonUndefinedIndex = graphIndex!;
    const definitionCount = nonUndefinedIndex.definitionCount?.(bareName);
    if (definitionCount !== undefined && definitionCount > 1) return [];
    const raw = nonUndefinedIndex.references(bareName).slice(0, rawFanoutCap);
    // Unlike `callersOf` above, every distinct (path, line) survives here —
    // never collapsed to one per file — because `referenced_by`'s whole
    // point is an honest file+LINE disclosure (ruling (z)); `relationPacket
    // .ts`'s `dedupeAndSortReferenceLocations` handles ordering/dedup at
    // packet-compile time.
    //
    // `+1`: `GraphLocation.line` for a SCIP-sourced entry is 0-based —
    // `scipReader.ts`'s `parseRangeField` reads the raw protobuf value
    // unconverted, matching SCIP's own 0-based line convention (LSP-style;
    // `graphIndex.spec.ts`'s own `parseScip` fixtures assert this literally,
    // e.g. an occurrence encoded at line 10 reports `.line === 10`). Every
    // OTHER site this packet carries (`resolveDefinition`/`resolveDeclaration`
    // via the parser, `RelationResolvedSite.range`'s own doc) is already
    // 1-based, so this is the one place a raw SCIP line reaches an `EdgeLine
    // .range` — converting here, once, keeps that promise honest instead of
    // silently emitting an off-by-one line to a caller reading the wire.
    // Safe unconditionally: `referencedBy` only ever runs against a
    // `GraphIndex` that reported `hasReferenceOccurrences()===true`, and the
    // only such index today is SCIP.
    return raw.map((location) => ({ path: location.path, line: location.line + 1 }));
  }

  // round-22B finding 3 (MEDIUM, 2026-09-04): `referencedBy` above slices its
  // raw candidate list to `rawFanoutCap` (`maxEdges * 2`, 96 at the default
  // budget) BEFORE `compileRelationPacket`'s own byte/edge-count admission
  // loop ever sees the surplus — so a raw fan-out beyond the cap was neither
  // admitted NOR counted in `RelationPacketTruncation.referencedBy` NOR
  // disclosed via `over_budget` (this class carries no `RelationUnavailable
  // Kind` to fall back on), contradicting that field's own doc: "Never
  // silently dropped — always counted." Unlike `callersOf`, which collapses
  // every raw reference to ONE entry per FILE and so rarely nears the raw cap
  // in practice, `referencedBy` deliberately keeps every distinct (path,
  // line) pair (ruling (z)'s whole point), making this gap materially likelier
  // to bite for exactly the evidence class FX-W1 shipped. This SEPARATE,
  // optional capability reports how many raw candidates were cut by that
  // pre-admission slice, applying the IDENTICAL ambiguity/availability gates
  // `referencedBy` itself applies, so `compileRelationPacket` can fold the
  // excess into `truncated.referencedBy` and keep the wire's own admitted+
  // truncated arithmetic honest. Absent capability (an index/test-double
  // predating this fix) is treated as `0` — never a fabricated count.
  function referencedByOverflowCount(anchor: RelationAnchor): number {
    if (!hasReferenceSource) return 0;
    const bareName = anchorBareName(anchor);
    if (bareName === undefined) return 0;
    const nonUndefinedIndex = graphIndex!;
    const definitionCount = nonUndefinedIndex.definitionCount?.(bareName);
    if (definitionCount !== undefined && definitionCount > 1) return 0;
    const total = nonUndefinedIndex.references(bareName).length;
    return Math.max(0, total - rawFanoutCap);
  }

  // F3 (round 11): the previous implementation treated "does `name` appear
  // ANYWHERE in the anchor's own file" as proof of a call — a file-level
  // co-occurrence, not a call edge (a comment mentioning a name, or an
  // unrelated same-named member on a different class declared in the same
  // file, would have fabricated a `calls` edge that never existed; see
  // `relationPacketPort.spec.ts`'s "calleesOf never fabricates..." tests).
  // Neither `GraphIndex` (`references`/`definition`/`importsOf`/`exportsOf`
  // — no call-site concept at all) nor the parsed symbol table
  // (`DeclaredSymbolAt` — declarations and heritage only, no call sites)
  // exposes a REAL call edge anywhere in this codebase today.
  //
  // FX-G-B (round 12, 2026-09-03): per the finding, an always-`[]`
  // `calleesOf` is worse than no `calleesOf` at all — `providers.ts`'s own
  // "OPTIONAL METHODS ARE A FEATURE" contract says an adapter that cannot
  // prove a call OMITS the method (and `edges.ts`'s `references.calleesOf
  // !== undefined` guard exists precisely so it can), so this adapter no
  // longer attaches a `calleesOf` at all — never a function that always
  // returns nothing. `edges.ts` then never emits a `CALLS` edge for this
  // provider (identical runtime effect to the old always-empty function),
  // but the ABSENCE is now visible to anything that inspects capability
  // (`edgeTypeSupport`, `unavailableRelations` below) instead of only being
  // visible by calling the method and noticing the array is empty. This
  // stays until a real call-edge source (an apiGraph `CALLS` edge, or a
  // parser call-site extraction) exists to ground `calleesOf` honestly.
  // FX-R2 (round 18B finding 2, 2026-09-03): the SAME "OPTIONAL METHODS ARE A
  // FEATURE" posture the `calleesOf` removal note above already documents
  // applies symmetrically to `callersOf` — `graph/index.ts`'s `loadGraphIndex`
  // returns `undefined` for every workspace TL has not indexed (TL never
  // writes `tl-graph.json`/`scip.binpb` itself), and an always-`[]`
  // `callersOf` in that case reads as "computed, no callers" under this
  // codebase's absence-is-meaning convention, which is false — it was never
  // attempted.
  //
  // FX-V2 (round 20B finding 1, HIGH, 2026-09-04, ruling (y)): FX-R2's own
  // gate — "a `graphIndex` is present" — was not narrow enough: round-20B
  // proved that `graphIndex` alone (the common case, tl-graph.json's
  // bare-identifier-token count) is NOT proof of a call edge, and attaching
  // `callersOf` to it fabricates `direct_calls` relations from mere textual
  // co-occurrence (a comment, an unrelated same-named local, the
  // definition's own out-of-line body). `callersOf` is now attached to
  // `references` ONLY when `hasCallEdgeSource` is true — i.e., the loaded
  // index is a PROVEN call-edge source (see `GraphIndex.hasCallEdges`'s doc
  // in `graph/index.ts`), never merely "an index of some kind exists".
  // `edges.ts`'s `references.callersOf !== undefined` guard then never runs
  // it otherwise, so `compileRelationPacket` never queues a caller edge, and
  // the absence surfaces via `unavailableRelations` below instead. When a
  // real call-edge source IS present, `callersOf` runs a real computation —
  // a genuine (possibly empty) result for an anchor whose bare member name
  // is unambiguous, or `[]` (backed by `unavailableRelationsForAnchor`
  // naming "callers" for that anchor, FX-U2) when it collides with another
  // class's same-named member; see `callersOf`'s own comment for the
  // mechanism.
  const references: ReferenceProvider | undefined =
    tlProviders.references === undefined
      ? undefined
      : !hasCallEdgeSource
        ? tlProviders.references
        : { ...tlProviders.references, callersOf };

  const providerSet: ProviderSet = {
    ...(tlProviders.imports !== undefined ? { imports: tlProviders.imports } : {}),
    ...(references !== undefined ? { references } : {}),
    symbols: symbolProvider,
  };

  const edgeDeriver = new EdgeDeriver({
    providers: providerSet,
    tracker: new BoundTracker({
      bounds: { maxNodes: 1_000_000, maxDepth: 1, maxFanout: 1_000_000, maxBytes: 1_000_000_000, maxDurationMs: 60_000 },
    }),
  });

  // Memoized per raw `Class::member` query — `compileRelationPacket` calls
  // `resolveDefinition` then immediately `resolveDeclaration` on the SAME
  // anchor, and both need the same file-scan result.
  const qualifiedMemo = new Map<string, QualifiedSymbolAnchorResolution>();
  function qualifiedResolution(query: string): QualifiedSymbolAnchorResolution | undefined {
    if (options.qualifiedResolver === undefined) return undefined;
    const cached = qualifiedMemo.get(query);
    if (cached !== undefined) return cached;
    const resolution = options.qualifiedResolver(query, workspaceRoot);
    qualifiedMemo.set(query, resolution);
    return resolution;
  }

  function resolveDefinition(anchor: RelationAnchor): RelationResolvedSite | undefined {
    if (anchor.qualified !== undefined) {
      const query = anchorSymbolKey(anchor)!;
      const resolution = qualifiedResolution(query);
      if (resolution === undefined) return undefined;
      const definitionPath = resolution.definitions[0];
      if (definitionPath === undefined) return undefined;
      const line = resolution.lines.get(definitionPath);
      return { node: symbolNode(definitionPath, query, "parser", { line }) };
    }
    if (anchor.symbol !== undefined) {
      const matches = symbolProvider.declarationsOf(anchor.symbol);
      if (matches.length !== 1) return undefined; // none, or ambiguous — never guess
      const declaration = matches[0]!;
      return {
        node: symbolNode(declaration.path, declaration.name, declaration.proof, {
          line: declaration.line,
          symbolKind: declaration.kind,
        }),
      };
    }
    if (anchor.path !== undefined) {
      if (!corpus.files.includes(anchor.path)) return undefined;
      return { node: fileNode(anchor.path, "path") };
    }
    return undefined;
  }

  function resolveDeclaration(
    anchor: RelationAnchor,
    _definition: RelationResolvedSite,
  ): RelationResolvedSite | undefined {
    if (anchor.qualified === undefined) return undefined;
    const query = anchorSymbolKey(anchor)!;
    const resolution = qualifiedResolution(query);
    if (resolution === undefined) return undefined;
    const declarationPath = resolution.declarations[0];
    if (declarationPath === undefined) return undefined;
    const line = resolution.lines.get(declarationPath);
    return { node: symbolNode(declarationPath, query, "parser", { line }) };
  }

  function edgesFor(node: GraphNode): readonly GraphEdge[] {
    return edgeDeriver.edgesFor(node);
  }

  // FX-U2 (round 19B finding 1): the port-WIDE `unavailableRelations` list
  // below answers "does this port have any caller source at all" — it
  // cannot answer "can THIS anchor's callers be attributed safely", which
  // depends on whether the anchor's bare member name collides with another
  // class's same-named member in the loaded `GraphIndex` (see
  // `callersOf`'s own FX-U2 comment). This function answers that narrower,
  // per-anchor question; `compileRelationPacket` unions its result with the
  // list below rather than replacing it (`RelationGraphPort
  // .unavailableRelationsForAnchor`'s doc, relationPacket.ts).
  function unavailableRelationsForAnchor(anchor: RelationAnchor): readonly RelationUnavailableKind[] {
    // FX-V2 (round 20B finding 1, ruling (y)): without a PROVEN call-edge
    // source, "callers" is already named unconditionally by the port-wide
    // `unavailableRelations` list below — this per-anchor refinement exists
    // only to CATCH an additional gap on TOP of a real source (a bare-name
    // collision), never to relax the port-wide disclosure. Never consult
    // `definitionCount` against a token index: no count it reports could
    // ever make that index's `references()` a trustworthy call edge.
    if (!hasCallEdgeSource) return [];
    const bareName = anchorBareName(anchor);
    if (bareName === undefined) return []; // path anchors never reach callersOf at all
    const definitionCount = graphIndex!.definitionCount?.(bareName);
    if (definitionCount !== undefined && definitionCount > 1) return ["callers"];
    return [];
  }

  return {
    resolveDefinition,
    resolveDeclaration,
    edgesFor,
    isTestPath: skeletonIsTestPath,
    // FX-G-B: this adapter has no real call-edge source for ANY anchor (see
    // the `calleesOf` removal note above) — disclose it structurally rather
    // than let `compileRelationPacket` read "always []" as "computed, no
    // callees". Never conditional on the query: the absence is a property
    // of this adapter, not of any one symbol.
    //
    // FX-R2 (round 18B finding 2): `"callers"` is added to the SAME list,
    // conditionally, exactly when this workspace has no real `GraphIndex` at
    // all yet, so `callersOf` above was never attached to `references`.
    //
    // FX-V2 (round 20B finding 1, HIGH, 2026-09-04, ruling (y)): superseding
    // FX-R2's gate — `"callers"` is unavailable whenever `hasCallEdgeSource`
    // is false, which now includes a workspace WITH a real `GraphIndex` that
    // is merely a bare-identifier-token count (`tlGraphReader.ts`, the
    // common case: TL never writes `scip.binpb` itself). Only a PROVEN
    // call-edge source (`GraphIndex.hasCallEdges() === true`) makes
    // `callersOf` a genuine (possibly empty) computation, at which point
    // `"callers"` is correctly absent from this PORT-WIDE list.
    //
    // FX-U2 (round 19B finding 1): a real call-edge source being present
    // does NOT mean every anchor's callers are attributable — see
    // `unavailableRelationsForAnchor` above for the per-anchor refinement
    // that catches the remaining, bare-name-collision gap.
    unavailableRelations: hasCallEdgeSource ? ["callees"] : ["callees", "callers"],
    unavailableRelationsForAnchor,
    // FX-W1 (round 21B finding 1, HIGH, 2026-09-04, ruling (z)): OMITTED
    // entirely (never a permissive always-`[]` function) unless this
    // workspace's loaded `GraphIndex` is a PROVEN reference-occurrence
    // source — the same "optional methods are a feature" discipline
    // `calleesOf`'s removal and `callersOf`'s conditional attachment above
    // both apply, so `compileRelationPacket`'s `graph.referencedBy?.(anchor)`
    // sees an absent method (never an empty array) for a token-index-backed
    // or ungrounded workspace, and the resulting packet simply omits
    // `referencedBy` (no `RelationUnavailableKind` disclosure exists for
    // this class — see `RelationGraphPort.referencedBy`'s doc for why).
    ...(hasReferenceSource ? { referencedBy, referencedByOverflowCount } : {}),
  };
}

// ---------------------------------------------------------------------------
// mintRelationHandles — replace absent handles with real ones, honestly
// ---------------------------------------------------------------------------

export type RelationHandleCategory =
  | "definition"
  | "declaration"
  | "callers"
  | "callees"
  | "implementations"
  | "referencedBy";

export interface RelationHandleDrop {
  readonly category: RelationHandleCategory;
  readonly path: string;
  readonly reason: string;
}

export interface MintRelationHandlesResult {
  readonly packet: RelationPacket;
  /** Sites/edge-lines dropped instead of receiving an `unresolved:*` placeholder, and why. */
  readonly dropped: readonly RelationHandleDrop[];
}

/** Resolves `relPath` against `workspaceRoot`, refusing to leave it (symlink-aware). */
function safeAbsolutePath(workspaceRoot: string, relPath: string): string | undefined {
  if (path.isAbsolute(relPath)) return undefined;
  const candidate = path.join(workspaceRoot, relPath);
  let real: string;
  let realRoot: string;
  try {
    real = fs.realpathSync(candidate);
    realRoot = fs.realpathSync(workspaceRoot);
  } catch {
    return undefined;
  }
  const relFromRoot = path.relative(realRoot, real);
  if (relFromRoot === "" || relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot)) return undefined;
  return real;
}

function mintOneHandle(
  workspaceRoot: string,
  category: RelationHandleCategory,
  relPath: string,
  range: string | undefined,
  symbol: string | undefined,
  dropped: RelationHandleDrop[],
): string | undefined {
  const absolute = safeAbsolutePath(workspaceRoot, relPath);
  if (absolute === undefined) {
    dropped.push({ category, path: relPath, reason: "path is absolute or escapes the workspace" });
    return undefined;
  }
  let text: string;
  try {
    text = fs.readFileSync(absolute, "utf8");
  } catch (err) {
    // F12 (round 11): `String(err)` on a Node fs error embeds the ABSOLUTE
    // host filesystem path (e.g. "ENOENT: ... open '/Users/.../file.ts'") —
    // a leak of the reader's own disk layout into a wire-adjacent `reason`
    // string. Only the error CODE and the already-workspace-relative
    // `relPath` are reported.
    const code =
      err !== null && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "unknown";
    dropped.push({ category, path: relPath, reason: `unreadable (${code}): ${relPath}` });
    return undefined;
  }
  const sha = shaOfText(text);

  if (range === undefined) {
    return handleTable.upsert({
      kind: "file",
      path: relPath,
      workspaceRoot,
      sha,
      ...(symbol !== undefined ? { symbol } : {}),
    }).id;
  }

  const totalLines = Math.max(1, text.length === 0 ? 1 : text.split("\n").length);
  const [startRaw, endRaw] = range.split("-", 2);
  const start = Number(startRaw);
  if (!Number.isInteger(start) || start < 1 || start > totalLines) {
    dropped.push({ category, path: relPath, reason: `range "${range}" out of bounds for ${totalLines} line(s)` });
    return undefined;
  }
  const endCandidate = endRaw === undefined ? start : Number(endRaw);
  const end = Number.isInteger(endCandidate) ? Math.min(Math.max(endCandidate, start), totalLines) : start;
  return handleTable.upsert({
    kind: "range",
    path: relPath,
    range: `${start}-${end}`,
    workspaceRoot,
    sha,
    ...(symbol !== undefined ? { symbol } : {}),
  }).id;
}

export function mintRelationHandles(packet: RelationPacket, workspaceRoot: string): MintRelationHandlesResult {
  const dropped: RelationHandleDrop[] = [];
  const anchorSymbol = anchorSymbolKey(packet.anchor);

  function mintSite(category: RelationHandleCategory, site: RelationSite | undefined): RelationSite | undefined {
    if (site === undefined) return undefined;
    if (site.handle !== undefined) return site;
    const handle = mintOneHandle(workspaceRoot, category, site.path, site.range, anchorSymbol, dropped);
    if (handle === undefined) return undefined;
    return { ...site, handle };
  }

  function mintLines(
    category: RelationHandleCategory,
    lines: readonly EdgeLine[],
  ): { kept: EdgeLine[]; droppedCount: number } {
    const kept: EdgeLine[] = [];
    let droppedCount = 0;
    for (const line of lines) {
      if (line.handle !== undefined) {
        kept.push(line);
        continue;
      }
      const handle = mintOneHandle(workspaceRoot, category, line.path, line.range, line.symbol, dropped);
      if (handle === undefined) droppedCount += 1;
      else kept.push({ ...line, handle });
    }
    return { kept, droppedCount };
  }

  const hadDefinition = packet.definition !== undefined;
  const definition = mintSite("definition", packet.definition);
  const hadDeclaration = packet.declaration !== undefined;
  const declaration = mintSite("declaration", packet.declaration);
  // FX-R2: `packet.callers` is absent (never `[]`) exactly when the
  // compiling port disclosed no caller source (`packet.unavailable` includes
  // `"callers"`) — mirrors the `callees` handling immediately below.
  const callers = packet.callers === undefined ? undefined : mintLines("callers", packet.callers);
  // FX-G-B: `packet.callees` is absent (never `[]`) exactly when the
  // compiling port disclosed no callee source (`packet.unavailable`
  // includes `"callees"`) — mint nothing for it and carry the absence
  // straight through, rather than defaulting to `[]` and minting zero
  // handles for it, which would silently manufacture a present-but-empty
  // `callees` key this packet never actually computed.
  const callees = packet.callees === undefined ? undefined : mintLines("callees", packet.callees);
  const implementations = packet.implementations === undefined ? undefined : mintLines("implementations", packet.implementations);
  // FX-W1 (round 21B finding 1, HIGH, 2026-09-04, ruling (z)): mirrors
  // `implementations` immediately above, not `callers`/`callees` —
  // `packet.referencedBy` is absent exactly when the compiling port never
  // implemented `referencedBy` at all OR found nothing (see `RelationPacket
  // .referencedBy`'s doc: this class has no `unavailable` disclosure to
  // carry through separately).
  const referencedBy = packet.referencedBy === undefined ? undefined : mintLines("referencedBy", packet.referencedBy);

  const truncated: RelationPacketTruncation = {
    definition: packet.truncated.definition + (hadDefinition && definition === undefined ? 1 : 0),
    declaration: packet.truncated.declaration + (hadDeclaration && declaration === undefined ? 1 : 0),
    ...(callers !== undefined ? { callers: (packet.truncated.callers ?? 0) + callers.droppedCount } : {}),
    ...(callees !== undefined ? { callees: (packet.truncated.callees ?? 0) + callees.droppedCount } : {}),
    implementations: packet.truncated.implementations + (implementations?.droppedCount ?? 0),
    referencedBy: packet.truncated.referencedBy + (referencedBy?.droppedCount ?? 0),
  };

  // G8: no response-level whole-packet byte re-measurement (the pattern
  // this fence forbids outside protocol/budget/measure.ts) happens here.
  // `packet.bytes` is `compileRelationPacket`'s own admission-time
  // measurement (the ONE sanctioned Class-C pre-shed count for this packet,
  // taken while every site/edge-line still lacked a `.handle`). Minting
  // handles only ADDS a `.handle` string to already-admitted sites/edge-lines
  // — it never admits new content past the compiler's budget decision — so
  // the honest move is to carry that measurement forward unchanged and flag
  // the packet as handle-minted, rather than re-measuring the whole packet
  // at this seam (which is exactly the regression G8 exists to catch).
  const core = {
    anchor: packet.anchor,
    ...(definition !== undefined ? { definition } : {}),
    ...(declaration !== undefined ? { declaration } : {}),
    ...(callers !== undefined ? { callers: callers.kept } : {}),
    ...(callees !== undefined ? { callees: callees.kept } : {}),
    ...(implementations !== undefined ? { implementations: implementations.kept } : {}),
    ...(referencedBy !== undefined ? { referencedBy: referencedBy.kept } : {}),
    ...(packet.unavailable !== undefined ? { unavailable: packet.unavailable } : {}),
    truncated,
    bytes: packet.bytes,
    resolved: packet.resolved,
    // FX-R2 (round 18B finding 4): carried straight through — an over-budget
    // packet stays over-budget after minting (minting only adds `.handle`
    // strings to already-admitted sites/edge-lines; it never re-opens the
    // admission decision, per the `bytes` doc comment above). Without this,
    // `compileSfRelationPackets` (the one production caller, which always
    // mints before projecting) silently dropped the disclosure here, before
    // `projectRelationPacketToEvidenceGraph` ever saw it.
    ...(packet.over_budget === true ? { over_budget: true as const } : {}),
    handles_minted: true as const,
  };

  return { packet: core, dropped };
}
