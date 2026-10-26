import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { defaultEngineConfiguration, withEngineConfiguration } from '../features/engines/config.js';
import { resolveTypedCallee } from '../features/typed-symbols/calleeClosure.js';
import type { TypedSymbolResolution } from '../features/typed-symbols/common.js';
import { runWithRequestSignal } from '../util/requestCancellation.js';

const backend = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('../features/typed-symbols/index.js', () => ({
  resolveTypedCalleeSymbols: backend.resolve,
  contentHash: (text: string) => createHash('sha256').update(text).digest('hex'),
}));
beforeEach(() => { backend.resolve.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });
function result(status: TypedSymbolResolution['status'], code: string): TypedSymbolResolution {
  return { status, backend: 'lsp', language: 'python', semantic: true, locations: [], gaps: [{ code, message: code }] };
}
async function call(name = 'run', cacheToken = {}) {
  const config = defaultEngineConfiguration(); config.typedSymbols.enabled = true;
  return withEngineConfiguration(config, () => resolveTypedCallee({
    workspace: '/fixture', source: 'client.' + name + '();', calleeName: name, hashComment: false, cacheToken,
    focal: { path: 'main.py', name: 'summary', startLine: 1, endLine: 1 },
  }));
}
describe('typed callee budgets remain unknown rather than unavailable', () => {
  it('discloses the qualified-call coordinate overflow before accepting an external-only prefix', async () => {
    backend.resolve.mockResolvedValue(result('unresolved', 'external-definition'));
    const config = defaultEngineConfiguration(); config.typedSymbols.enabled = true;
    const closure = await withEngineConfiguration(config, () => resolveTypedCallee({
      workspace: '/fixture', source: 'number.toFixed(); '.repeat(5) + 'own.toFixed();',
      calleeName: 'toFixed', hashComment: false,
      focal: { path: 'main.ts', name: 'summary', startLine: 1, endLine: 1 },
    }));
    expect(closure).toEqual({ kind: 'unresolved', reason: 'typed-pack-budget' });
    expect(backend.resolve).not.toHaveBeenCalled();
  });

  it.each(['success', 'failure', 'cancelled'])('supports Node 20.0 without AbortSignal.any during %s', async outcome => {
    const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any')!;
    Object.defineProperty(AbortSignal, 'any', { ...descriptor, value: undefined });
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, 'addEventListener');
    const removed = vi.spyOn(controller.signal, 'removeEventListener');
    backend.resolve.mockImplementation(async request => {
      if (outcome === 'failure') throw new Error('backend failed');
      if (outcome === 'cancelled') {
        controller.abort();
        expect(request.signal.aborted).toBe(true);
        return result('cancelled', 'cancelled');
      }
      expect(request.signal.aborted).toBe(false);
      return result('unresolved', 'external-definition');
    });
    try {
      const pending = runWithRequestSignal(controller.signal, () => call());
      if (outcome === 'failure') await expect(pending).rejects.toThrow('backend failed');
      else await expect(pending).resolves.toEqual(outcome === 'cancelled'
        ? { kind: 'unresolved', reason: 'cancelled' } : { kind: 'external', reason: 'external-definition' });
      expect(added).toHaveBeenCalledTimes(1);
      expect(removed).toHaveBeenCalledTimes(1);
    } finally { Object.defineProperty(AbortSignal, 'any', descriptor); }
  });

  it('propagates a deadline cancellation as unresolved before any target is selected', async () => {
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => AbortSignal.abort());
    backend.resolve.mockResolvedValue(result('cancelled', 'cancelled'));
    expect(await call()).toEqual({ kind: 'unresolved', reason: 'typed-pack-budget' });
  });
  it('keeps genuine backend unavailability as fallback, then reports the finite attempt limit', async () => {
    backend.resolve.mockResolvedValue(result('unavailable', 'server-unavailable'));
    const cacheToken = {};
    for (const name of ['first', 'second', 'third', 'fourth']) {
      expect(await call(name, cacheToken)).toEqual({ kind: 'fallback', reason: 'server-unavailable' });
    }
    expect(await call('fifth', cacheToken)).toEqual({ kind: 'unresolved', reason: 'typed-pack-budget' });
    expect(backend.resolve).toHaveBeenCalledTimes(4);
  });
  it('keeps an inconclusive dynamic receiver unresolved instead of selecting a lexical homonym', async () => {
    backend.resolve.mockResolvedValue(result('unresolved', 'symbol-unresolved'));
    expect(await call()).toEqual({ kind: 'unresolved', reason: 'symbol-unresolved' });
  });
});

describe('finite backend failure outcomes never supply a lexical proof', () => {
  it.each(['timeout', 'compiler-limit', 'source-limit', 'location-limit',
    'protocol-limit', 'protocol-error', 'server-error', 'server-io', 'server-exited',
    'invalid-range', 'unsupported-encoding', 'sync-unavailable', 'unstable-target',
    'source-unavailable', 'source-encoding', 'backend-error', 'relation-unavailable'])('keeps %s unresolved', async code => {
    backend.resolve.mockResolvedValue(result('unresolved', code));
    expect(await call()).toEqual({ kind: 'unresolved', reason: code });
  });
});


describe('workspace resolution and advisory probe budgets are independent', () => {
  function localResult(): TypedSymbolResolution {
    return { status: 'resolved', backend: 'lsp', language: 'python', semantic: true,
      locations: [{ relation: 'definition', path: 'good.py', contentHash: 'verified',
        range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } } }], gaps: [] };
  }
  it('external and inconclusive calls leave four local resolutions but withhold a fifth local body', async () => {
    const cacheToken = {};
    for (const name of ['externalOne', 'externalTwo', 'externalThree', 'externalFour', 'externalFive']) {
      backend.resolve.mockResolvedValueOnce(result('unresolved', 'external-definition'));
      expect(await call(name, cacheToken)).toEqual({ kind: 'external', reason: 'external-definition' });
    }
    for (const name of ['dynamicOne', 'dynamicTwo', 'dynamicThree', 'dynamicFour', 'dynamicFive']) {
      backend.resolve.mockResolvedValueOnce(result('unresolved', 'symbol-unresolved'));
      expect(await call(name, cacheToken)).toEqual({ kind: 'unresolved', reason: 'symbol-unresolved' });
    }
    for (const name of ['first', 'second', 'third', 'fourth']) {
      backend.resolve.mockResolvedValueOnce(localResult());
      expect(await call(name, cacheToken)).toMatchObject({ kind: 'resolved', path: 'good.py' });
    }
    backend.resolve.mockResolvedValueOnce(result('unresolved', 'external-definition'));
    expect(await call('laterExternal', cacheToken)).toEqual({ kind: 'external', reason: 'external-definition' });
    backend.resolve.mockResolvedValueOnce(localResult());
    expect(await call('fifth', cacheToken)).toEqual({ kind: 'unresolved', reason: 'typed-pack-budget' });
    expect(backend.resolve).toHaveBeenCalledTimes(16);
  });
  it('keeps the shared time bound for external calls that consume no local-body attempts', async () => {
    let now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    backend.resolve.mockImplementation(async () => {
      now += 4500;
      return result('unresolved', 'external-definition');
    });
    const cacheToken = {};
    expect(await call('firstExternal', cacheToken)).toEqual({ kind: 'external', reason: 'external-definition' });
    expect(await call('laterExternal', cacheToken)).toEqual({ kind: 'unresolved', reason: 'typed-pack-budget' });
    expect(backend.resolve).toHaveBeenCalledTimes(1);
  });
  it('retains a finite advisory probe limit without converting it to absence or lexical fallback', async () => {
    backend.resolve.mockResolvedValue(result('unresolved', 'symbol-unresolved'));
    const cacheToken = {};
    for (let index = 0; index < 32; index++) expect(await call('dynamic' + index, cacheToken)).toEqual({ kind: 'unresolved', reason: 'symbol-unresolved' });
    expect(await call('dynamic32', cacheToken)).toEqual({ kind: 'unresolved', reason: 'typed-pack-budget' });
    expect(backend.resolve).toHaveBeenCalledTimes(32);
  });
});
