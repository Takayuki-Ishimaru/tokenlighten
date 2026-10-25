import { constants, openSync, closeSync, fstatSync, readSync, realpathSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";
import type { ImpactCandidate, LocateInput, LocateOutput, EngineConfiguration } from "@tokenlighten/types";
import { activeEngineConfiguration, recordEngineDiscoveryGap } from "./config.js";
import { planCompoundRequest, mergeCompoundCandidates } from "../task-pack/compoundRequests.js";
import { resolveTypedSymbols, contentHash } from "../typed-symbols/index.js";
import { LocalSemanticSearch, type SemanticSource } from "../semantic-search/index.js";
import { walkCodeFiles, isSourceOnlyExcludedPath } from "../../tools/walkRepo.js";
import { looksLikeSecretFile } from "../../write/secretScan.js";
import { classifySurface } from "../../util/impact.js";
import { handleTable } from "../../util/handles.js";
import { trace } from "../../util/trace.js";
import { currentRequestSignal, RequestCancelledError } from "../../util/requestCancellation.js";

type Locator = (workspace: string, input: LocateInput) => Promise<LocateOutput>;
const SEMANTIC_FILE_CAP = 96;
const SEMANTIC_TOTAL_BYTES = 512 * 1024;
const SOURCE_BYTE_CAP = 64 * 1024;
const LOCATE_BYTE_CAP = 2048;
let semantic: { cacheDir: string; engine: LocalSemanticSearch; users: number; retired: boolean } | undefined;

/** not-served: these pinned snapshots feed retrieval only; materialization revalidates source. */
function sourceSnapshot(workspace: string, file: string): SemanticSource | undefined {
  if (isSourceOnlyExcludedPath(file) || looksLikeSecretFile(file)) return undefined;
  let fd: number | undefined;
  try {
    const root = realpathSync(workspace);
    const target = resolve(root, file);
    const real = realpathSync(target);
    const rel = relative(root, real);
    if (real !== target || rel === ".." || rel.startsWith(`..${sep}`)) return undefined;
    fd = openSync(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > SOURCE_BYTE_CAP) return undefined;
    const buffer = Buffer.alloc(SOURCE_BYTE_CAP + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, length);
      if (!count) break;
      length += count;
    }
    if (length > SOURCE_BYTE_CAP) return undefined;
    const bytes = buffer.subarray(0, length);
    const after = fstatSync(fd);
    const binding = statSync(real);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || binding.dev !== after.dev || binding.ino !== after.ino || realpathSync(target) !== real) return undefined;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) return undefined;
    return { path: file, text, identity: contentHash(text) };
  } catch { return undefined; } finally { if (fd !== undefined) closeSync(fd); }
}

function address(workspace: string, candidate: ImpactCandidate): ImpactCandidate {
  const handle = handleTable.upsert({ kind: candidate.symbol ? "symbol" : "range", workspaceRoot: workspace,
    path: candidate.path, range: candidate.range ?? `${candidate.line}-${candidate.line}`,
    ...(candidate.symbol ? { symbol: candidate.symbol } : {}) });
  return { ...candidate, handle: handle.id };
}

/** Retrieval bounds never certify dropped mandatory candidates as complete. */
function bound(result: LocateOutput): LocateOutput {
  if (!result.hit) return result;
  const out = { ...result, primary: [...result.primary], related: [...result.related] };
  while (Buffer.byteLength(JSON.stringify(out), "utf8") > LOCATE_BYTE_CAP && out.related.length) {
    out.related.pop(); out.completeness = "partial";
  }
  while (Buffer.byteLength(JSON.stringify(out), "utf8") > LOCATE_BYTE_CAP && out.primary.length > 1) {
    out.primary.pop(); out.completeness = "partial";
  }
  return out;
}

async function typedDefinitions(workspace: string, input: LocateInput, located: LocateOutput,
  config: EngineConfiguration): Promise<LocateOutput> {
  if (!config.typedSymbols.enabled || !located.hit) return located;
  const qualified = [...input.query.matchAll(/\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\s*(?:\(|\b)/g)]
    .map(match => match[0].replace(/\s*\($/, "").trim()).filter(name => !/\.(?:ts|js|py|go|rs|java|cpp|cs|kt|php|rb)$/.test(name));
  if (!qualified.length && !input.symbol) return located;
  const aliases: Record<string, string> = { ts: "typescript", js: "javascript", py: "python", rs: "rust", cs: "csharp", kt: "kotlin", rb: "ruby" };
  const servers = Object.fromEntries(Object.entries(config.typedSymbols.servers).map(([lang, command]) => [aliases[lang] ?? lang, command]));
  const additions: ImpactCandidate[] = [];
  for (const seed of located.primary.slice(0, 2)) {
    if (currentRequestSignal()?.aborted) break;
    const source = sourceSnapshot(workspace, seed.path);
    if (!source) continue;
    const names = qualified.length ? qualified : [input.symbol!];
    for (const name of names.slice(0, 2)) {
      if (currentRequestSignal()?.aborted) break;
      const escaped = name.split(".").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*\\.\\s*");
      const matches = [...source.text.matchAll(new RegExp(`\\b${escaped}\\b`, "g"))];
      if (matches.length !== 1) continue;
      const match = matches[0]!;
      const member = name.split(".").at(-1)!;
      const offset = match.index + match[0].lastIndexOf(member);
      const prefix = source.text.slice(0, offset);
      const line = prefix.split("\n").length - 1;
      const character = prefix.length - (prefix.lastIndexOf("\n") + 1);
      const resolved = await resolveTypedSymbols({ root: workspace, path: seed.path, position: { line, character },
        relations: ["definition"], expectedContentHash: source.identity, servers,
        signal: currentRequestSignal(),
        discoverServers: config.typedSymbols.discoverServers, timeoutMs: 3000, startupTimeoutMs: 3000 });
      if (currentRequestSignal()?.aborted) return located;
      trace("typed_symbols_resolved", { language: resolved.language, status: resolved.status, locations: resolved.locations.length,
        gaps: resolved.gaps.map(gap => gap.code) }, workspace);
      for (const location of resolved.locations.slice(0, 4)) {
        const target = sourceSnapshot(workspace, location.path);
        if (location.relation !== "definition" || target?.identity !== location.contentHash) continue;
        const start = location.range.start.line + 1;
        const end = Math.max(start, location.range.end.line + (location.range.end.character === 0 ? 0 : 1));
        if ([...located.primary, ...located.related, ...additions].some(candidate => candidate.path === location.path && candidate.line === start)) continue;
        additions.push(address(workspace, { path: location.path, line: start, range: `${start}-${end}`,
          symbol: member, surface: classifySurface(location.path, member), confidence: 0.9, required: true,
          why: `typed-definition:${resolved.backend}`, sha: `sha256:${location.contentHash}` }));
      }
    }
  }
  return additions.length ? bound({ ...located, related: [...located.related, ...additions], completeness: "partial" }) : located;
}

async function semanticFallback(workspace: string, input: LocateInput, located: LocateOutput,
  config: EngineConfiguration): Promise<LocateOutput> {
  if (!config.semanticSearch.enabled || located.hit || currentRequestSignal()?.aborted) return located;
  // Lexical ambiguity already carries source ownership and exact addresses.
  // A bounded embedding corpus must never replace those with weaker guesses.
  if (located.candidates?.length || located.candidateDetails?.length) return located;
  if (!semantic || semantic.cacheDir !== config.semanticSearch.cacheDir) {
    if (semantic) {
      semantic.retired = true;
      if (semantic.users === 0) void semantic.engine.dispose();
    }
    semantic = { cacheDir: config.semanticSearch.cacheDir,
      engine: new LocalSemanticSearch({ cacheDir: config.semanticSearch.cacheDir, allowDownload: false }), users: 0, retired: false };
  }
  const sources: SemanticSource[] = [];
  let bytes = 0;
  for (const file of walkCodeFiles(workspace, { ...(input.path ? { subPath: input.path } : {}),
    ...(input.lang ? { lang: input.lang } : {}), respectGitignore: true,
    extraExts: [".md", ".txt", ".rst", ".json", ".yaml", ".yml", ".toml"] })) {
    if (currentRequestSignal()?.aborted || sources.length >= SEMANTIC_FILE_CAP || bytes >= SEMANTIC_TOTAL_BYTES) break;
    const source = sourceSnapshot(workspace, file.relPath);
    if (!source || bytes + Buffer.byteLength(source.text) > SEMANTIC_TOTAL_BYTES) continue;
    sources.push(source); bytes += Buffer.byteLength(source.text);
  }
  const lease = semantic;
  lease.users++;
  let ranked;
  try { ranked = await lease.engine.search({ query: input.query, sources, limit: 6, signal: currentRequestSignal() }); }
  finally {
    lease.users--;
    if (lease.retired && lease.users === 0) void lease.engine.dispose();
  }
  trace("local_semantic_search", { status: ranked.status, sources: sources.length, chunks: ranked.indexedChunks, reasons: ranked.reasons }, workspace);
  if (ranked.status === "unavailable" || ranked.status === "cancelled" || !ranked.candidates.length) return located;
  const candidates = ranked.candidates.map(candidate => address(workspace, { path: candidate.path,
    line: candidate.startLine, range: `${candidate.startLine}-${candidate.endLine}`,
    surface: classifySurface(candidate.path, undefined), why: "local-multilingual-embedding",
    confidence: 0.3, required: false, sha: `sha256:${sources.find(source => source.path === candidate.path)?.identity}` }));
  // A semantic ranking is a candidate list, never unique-location/absence proof.
  return { ...located, hit: false, reason: "ambiguous", candidates: candidates.slice(0, 3).map(candidate => ({ path: candidate.path, line: candidate.line, handle: candidate.handle })),
    candidateDetails: candidates.map(candidate => ({ ...candidate, range: candidate.range!, handle: candidate.handle! })) };
}

export async function composeEngineDiscovery(workspace: string, input: LocateInput, locate: Locator): Promise<LocateOutput> {
  if (currentRequestSignal()?.aborted) throw new RequestCancelledError();
  const config = activeEngineConfiguration();
  const plan = config.compoundRequests.enabled ? planCompoundRequest(input.query, undefined, { maxClauses: 8 }) : undefined;
  let located: LocateOutput;
  if (plan?.compound) {
    const results: Array<{ clauseId: string; candidates: ImpactCandidate[]; complete: boolean; hit: boolean }> = [];
    for (const clause of plan.clauses) {
      if (currentRequestSignal()?.aborted) throw new RequestCancelledError();
      let result = await locate(workspace, { ...input, query: clause.query, symbol: undefined });
      if (currentRequestSignal()?.aborted) throw new RequestCancelledError();
      result = await semanticFallback(workspace, { ...input, query: clause.query }, result, config);
      // Some lexical abstains retain only compact addresses. Keep their recovery
      // candidates advisory even when another clause has an exact literal hit.
      const candidates = result.hit ? [...result.primary, ...result.related] : [
        ...(result.candidateDetails ?? []),
        ...(result.candidates ?? []).filter(candidate => !result.candidateDetails?.some(detail =>
          detail.path === candidate.path && detail.line === candidate.line)).map(candidate => {
          const advisory: ImpactCandidate = { ...candidate, range: `${candidate.line}-${candidate.line}`,
            surface: classifySurface(candidate.path, undefined), why: "lexical-recovery-candidate", confidence: 0.3, required: false };
          return advisory.handle ? advisory : address(workspace, advisory);
        }),
      ];
      results.push({ clauseId: clause.id, candidates,
        complete: result.hit && result.completeness === "complete", hit: result.hit });
    }
    const merged = mergeCompoundCandidates(plan, results, { maxCandidates: Math.max(8, Math.min(24, input.limit ?? 12)) });
    for (const item of merged.outstanding) recordEngineDiscoveryGap(input.query, `compound-request:${item.clauseId ?? "query"}:${item.reason}`);
    const ambiguousClause = results.some(result => !result.hit && result.candidates.length > 0);
    if (merged.candidates.length && results.some(result => result.hit) && !ambiguousClause) {
      located = bound({ hit: true, primary: merged.owners.filter(owner => owner.candidate.required).map(owner => owner.candidate),
        related: merged.owners.filter(owner => !owner.candidate.required).map(owner => owner.candidate),
        confidence: 0.6, completeness: "partial" });
      if (located.hit && !located.primary.length) located = { ...located, primary: located.related.slice(0, 1), related: located.related.slice(1) };
      if (located.hit && located.primary.length + located.related.length < merged.candidates.length) recordEngineDiscoveryGap(input.query, "compound-request:query:wire-budget");
    } else if (merged.candidates.length) {
      const candidates = merged.candidates;
      located = { hit: false, reason: "ambiguous", candidates: candidates.slice(0, 3).map(candidate => ({ path: candidate.path, line: candidate.line })),
        candidateDetails: candidates.map(candidate => ({ ...candidate, range: candidate.range ?? `${candidate.line}-${candidate.line}`, handle: candidate.handle! })) };
    } else located = await locate(workspace, input);
    trace("compound_requests_composed", { clauses: plan.clauses.length, outstanding: merged.outstanding.map(item => item.reason), candidates: merged.candidates.length }, workspace);
  } else located = await locate(workspace, input);
  located = await semanticFallback(workspace, input, located, config);
  return typedDefinitions(workspace, input, located, config);
}
