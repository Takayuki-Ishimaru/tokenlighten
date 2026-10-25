import { activeEngineConfiguration } from '../engines/config.js';
import { currentRequestSignal } from '../../util/requestCancellation.js';
import { combinedAbortSignal } from '../../util/combinedAbortSignal.js';
import { isSourceOnlyExcludedPath } from '../../tools/walkRepo.js';
import { MAX_QUALIFIED_CALLEE_POSITIONS, calleePositionsIn, qualifiedCalleePositionsIn } from '../task-pack/evidenceClosure.js';
import { contentHash, resolveTypedCalleeSymbols } from './index.js';
import { positionOffset, readInside } from './common.js';
import { realpath } from 'node:fs/promises';

interface TypedCalleeInput {
  workspace: string;
  source: string;
  focal: { path: string; name: string; startLine: number; endLine: number };
  calleeName: string;
  hashComment: boolean;
  /** The parent pack owns this lifetime; no result cache survives it. */
  cacheToken?: object;
}
export type TypedCalleeClosure =
  | { kind: 'resolved'; path: string; contentHash: string; name: string; backend: 'typescript' | 'lsp' | 'none'; symbol: { startLine: number; endLine: number } }
  | { kind: 'external'; reason: string }
  | { kind: 'fallback'; reason: string }
  | { kind: 'unresolved'; reason: string };

interface PackResolutionBudget { results: Map<string, Promise<TypedCalleeClosure>>; attempts: number; probes: number; unavailableAttempts: number; expires: number }
const packResults = new WeakMap<object, PackResolutionBudget>();
const MAX_ATTEMPTS_PER_PACK = 4;
const MAX_PROBES_PER_PACK = 32;
const MAX_MS_PER_PACK = 4500;

/** Advisory callee evidence only; this never extends caller ranges or edit authority. */
export async function resolveTypedCallee(input: TypedCalleeInput): Promise<TypedCalleeClosure> {
  const configuration = activeEngineConfiguration();
  if (!configuration.typedSymbols.enabled) return { kind: 'fallback', reason: 'typed-disabled' };
  const signal = currentRequestSignal();
  if (signal?.aborted) return { kind: 'unresolved', reason: 'cancelled' };
  const lines = input.source.split(/\r?\n/);
  if (!qualifiedCalleePositionsIn(lines, input.focal.startLine, input.focal.endLine, input.calleeName, input.hashComment).length) return { kind: 'fallback', reason: 'no-qualified-call' };
  // A bare call and a member call can name different implementations. Probe
  // both before allowing the single-body closure to certify this callee name.
  const positions = calleePositionsIn(lines, input.focal.startLine, input.focal.endLine, input.calleeName, input.hashComment);
  // The final coordinate is an overflow sentinel, not a complete call list.
  // An external-only prefix cannot prove that a later receiver is external.
  if (positions.length > MAX_QUALIFIED_CALLEE_POSITIONS) return { kind: 'unresolved', reason: 'typed-pack-budget' };
  const aliases: Record<string, string> = { ts: 'typescript', js: 'javascript', py: 'python', rs: 'rust', cs: 'csharp', kt: 'kotlin', rb: 'ruby' };
  const servers = Object.fromEntries(Object.entries(configuration.typedSymbols.servers).map(([language, command]) => [aliases[language] ?? language, command]));
  const sourceHash = contentHash(input.source);
  const key = JSON.stringify([input.workspace, input.focal, input.calleeName, sourceHash, configuration.typedSymbols]);
  let budget = input.cacheToken ? packResults.get(input.cacheToken) : undefined;
  if (!budget) {
    budget = { results: new Map(), attempts: 0, probes: 0, unavailableAttempts: 0, expires: Date.now() + MAX_MS_PER_PACK };
    if (input.cacheToken) packResults.set(input.cacheToken, budget);
  }
  const cached = budget.results.get(key);
  if (cached) return cached;
  const pending = (async (): Promise<TypedCalleeClosure> => {
    let selected: TypedCalleeClosure & { kind: 'resolved' } | undefined;
    let external = false;
    for (const position of positions) {
      if (budget.probes >= MAX_PROBES_PER_PACK || budget.unavailableAttempts >= MAX_ATTEMPTS_PER_PACK || Date.now() >= budget.expires) return { kind: 'unresolved', reason: 'typed-pack-budget' };
      budget.probes++;
      // Cold compiler/server startup may exceed 1.5s on a busy machine. Let
      // each probe use the remaining shared deadline without extending it.
      const timeoutMs = Math.max(1, budget.expires - Date.now());
      const deadlineSignal = AbortSignal.timeout(Math.max(1, budget.expires - Date.now()));
      const combined = combinedAbortSignal(signal ? [signal, deadlineSignal] : [deadlineSignal]);
      const callSignal = combined.signal;
      let resolved: Awaited<ReturnType<typeof resolveTypedCalleeSymbols>>;
      try {
        resolved = await resolveTypedCalleeSymbols({ root: input.workspace, path: input.focal.path, position,
          relations: ['definition'], expectedContentHash: sourceHash, servers, signal: callSignal,
          discoverServers: configuration.typedSymbols.discoverServers, timeoutMs, startupTimeoutMs: timeoutMs });
      } finally { combined.dispose(); }
      if (resolved.status === 'cancelled' && callSignal.aborted && !signal?.aborted) return { kind: 'unresolved', reason: 'typed-pack-budget' };
      const boundedFailure = resolved.gaps.find(gap => ['timeout', 'compiler-limit', 'source-limit', 'location-limit'].includes(gap.code));
      if (boundedFailure) return { kind: 'unresolved', reason: boundedFailure.code };
      if (resolved.status === 'unavailable') {
        budget.unavailableAttempts++;
        return { kind: selected ? 'unresolved' : 'fallback', reason: resolved.gaps[0]?.code ?? 'typed-unavailable' };
      }
      if (resolved.status === 'cancelled') return { kind: 'unresolved', reason: 'cancelled' };
      // A failed semantic lookup cannot prove that a local homonym is the callee.
      const failedResolution = resolved.gaps.find(gap => !['project-diagnostics', 'symbol-unresolved', 'external-definition', 'outside-root'].includes(gap.code));
      if (failedResolution) return { kind: 'unresolved', reason: failedResolution.code };
      // Diagnostics elsewhere in the source do not invalidate this symbol;
      // every other gap remains explicit and cannot become a lexical guess.
      const allDefinitions = resolved.locations.filter(location => location.relation === 'definition');
      const definitions = allDefinitions.filter(location => !isSourceOnlyExcludedPath(location.path));
      if (allDefinitions.length && !definitions.length) { external = true; continue; }
      if (!definitions.length && resolved.gaps.some(gap => gap.code === 'external-definition' || gap.code === 'outside-root') && resolved.gaps.every(gap => gap.code === 'external-definition' || gap.code === 'outside-root' || gap.code === 'project-diagnostics')) { external = true; continue; }
      if (definitions.length > 1) return { kind: 'unresolved', reason: 'ambiguous-symbol' };
      // An inconclusive receiver cannot prove a same-named lexical function.
      // Keep the unfinished hop explicit, as for external definitions.
      const incompleteResolution = resolved.gaps.find(gap => gap.code !== 'project-diagnostics' && gap.code !== 'symbol-unresolved');
      if (incompleteResolution) return { kind: 'unresolved', reason: incompleteResolution.code };
      if (!definitions.length) return { kind: 'unresolved', reason: resolved.gaps[0]?.code ?? 'typed-symbol-unresolved' };
      // External and inconclusive probes do not consume the workspace-body
      // budget. Classify even after four local resolutions so an external call
      // cannot invent an unfinished local hop, but withhold a fifth local body.
      if (budget.attempts >= MAX_ATTEMPTS_PER_PACK) return { kind: 'unresolved', reason: 'typed-pack-budget' };
      budget.attempts++;
      const definition = definitions[0]!;
      const startLine = definition.range.start.line + 1;
      const endLine = Math.max(startLine, definition.range.end.line + (definition.range.end.character === 0 ? 0 : 1));
      let name = input.calleeName;
      if (resolved.backend === 'typescript' && definition.selectionRange) {
        try {
          const target = await readInside(await realpath(input.workspace), definition.path);
          if (target.hash !== definition.contentHash) return { kind: 'unresolved', reason: 'stale-source' };
          const from = positionOffset(target.text, definition.selectionRange.start);
          const to = positionOffset(target.text, definition.selectionRange.end);
          const selectedName = from !== undefined && to !== undefined ? target.text.slice(from, to) : '';
          if (/^[A-Za-z_$][\w$]*$/.test(selectedName)) name = selectedName;
        } catch { return { kind: 'unresolved', reason: 'stale-source' }; }
        if (signal?.aborted) return { kind: 'unresolved', reason: 'cancelled' };
      }
      const candidate = { kind: 'resolved' as const, path: definition.path, contentHash: definition.contentHash, name, backend: resolved.backend, symbol: { startLine, endLine } };
      if (selected && (selected.path !== candidate.path || selected.contentHash !== candidate.contentHash || selected.symbol.startLine !== candidate.symbol.startLine || selected.symbol.endLine !== candidate.symbol.endLine)) return { kind: 'unresolved', reason: 'ambiguous-typed-receivers' };
      selected = candidate;
    }
    return selected ?? (external ? { kind: 'external', reason: 'external-definition' } : { kind: 'unresolved', reason: 'typed-symbol-unresolved' });
  })();
  if (budget.results.size < 64) budget.results.set(key, pending);
  return pending;
}
