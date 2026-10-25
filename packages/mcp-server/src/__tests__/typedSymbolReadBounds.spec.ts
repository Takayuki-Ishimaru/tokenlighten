import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_SOURCE_BYTES, readInside } from '../features/typed-symbols/common.js';
import { resolveTypedSymbols } from '../features/typed-symbols/index.js';

const probe = vi.hoisted(() => ({ growSource: '', growWorker: false,
  reads: [] as number[], unboundedReads: [] as number[], workerMessages: [] as Array<Record<string, any>> }));
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    let grew = false;
    return new Proxy(handle, { get(target, property) {
      if (property === 'stat') return async () => {
        const before = await target.stat();
        if (!grew && String(args[0]) === probe.growSource) {
          grew = true; fs.appendFileSync(probe.growSource, 'x'.repeat(8 * 1024 * 1024));
        }
        return before;
      };
      if (property === 'read') return async (...readArgs: any[]) => {
        probe.reads.push(readArgs[0].byteLength);
        return (target.read as any)(...readArgs);
      };
      if (property === 'readFile') return async (...readArgs: any[]) => {
        const bytes = await (target.readFile as any)(...readArgs);
        probe.unboundedReads.push(bytes.byteLength); return bytes;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
});
vi.mock('node:worker_threads', async () => {
  const actual = await vi.importActual<typeof import('node:worker_threads')>('node:worker_threads');
  return { ...actual, Worker: class extends actual.Worker {
    constructor(code: string | URL, options?: import('node:worker_threads').WorkerOptions) {
      if (typeof code === 'string' && options?.eval && code.includes('const MAX_BYTES =')) {
        // Instrument only this isolated compiler; production modules stay untouched.
        const prefix = [
          "const reviewFs = require('node:fs');",
          "const reviewWorker = require('node:worker_threads');",
          "const reviewSettings = reviewWorker.workerData.review;",
          "const reviewStats = { bytes: 0, maxBuffer: 0, unbounded: 0 };",
          "let reviewGrew = false;",
          "const reviewStat = reviewFs.fstatSync;",
          "reviewFs.fstatSync = function(fd) {",
          "  const before = reviewStat(fd);",
          "  if (reviewSettings.grow && !reviewGrew) {",
          "    const target = reviewFs.statSync(reviewWorker.workerData.source);",
          "    if (before.dev === target.dev && before.ino === target.ino) {",
          "      reviewGrew = true; reviewFs.appendFileSync(reviewWorker.workerData.source, 'x'.repeat(8 * 1024 * 1024));",
          "    }",
          "  }",
          "  return before;",
          "};",
          "const reviewRead = reviewFs.readSync;",
          "reviewFs.readSync = function(fd, buffer, offset, length, position) {",
          "  reviewStats.maxBuffer = Math.max(reviewStats.maxBuffer, buffer.byteLength);",
          "  const count = reviewRead(fd, buffer, offset, length, position); reviewStats.bytes += count; return count;",
          "};",
          "const reviewReadFile = reviewFs.readFileSync;",
          "reviewFs.readFileSync = function(file, ...args) {",
          "  const value = reviewReadFile(file, ...args);",
          "  if (typeof file === 'number') { reviewStats.unbounded++; reviewStats.bytes += value.byteLength; }",
          "  return value;",
          "};",
          "const reviewPost = reviewWorker.parentPort.postMessage.bind(reviewWorker.parentPort);",
          "reviewWorker.parentPort.postMessage = value => reviewPost({ ...value, reviewStats });",
          "",
        ].join('\n');
        code = prefix + code.replace(')), gaps });', ')), gaps, reviewAccountedBytes: bytes });');
        options = { ...options, workerData: { ...options.workerData, review: { grow: probe.growWorker } } };
      }
      super(code, options);
      this.on('message', value => probe.workerMessages.push(value));
    }
  } };
});
const roots: string[] = [];
async function fixture() {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'tl-typed-read-bounds-'))); roots.push(root);
  return root;
}
beforeEach(() => { probe.growSource = ''; probe.growWorker = false; probe.reads.length = 0; probe.unboundedReads.length = 0; probe.workerMessages.length = 0; });
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('typed source byte ceilings apply to actual held-FD reads', () => {
  it('bounds a source that grows after its initial stat without readFile allocation', async () => {
    const root = await fixture(); const file = join(root, 'main.ts');
    await writeFile(file, 'let value=1;\n'); probe.growSource = file;
    await expect(readInside(root, 'main.ts')).rejects.toMatchObject({ code: 'source-limit' });
    expect(probe.unboundedReads).toEqual([]);
    expect(probe.reads.length).toBeGreaterThan(0);
    expect(probe.reads.every(size => size <= MAX_SOURCE_BYTES + 1)).toBe(true);
  });
  it('bounds a compiler input grown after its held-FD stat', async () => {
    const root = await fixture(); await writeFile(join(root, 'main.ts'), 'class A { run() {} }\nnew A().run();\n');
    probe.growWorker = true;
    const result = await resolveTypedSymbols({ root, path: 'main.ts', position: { line: 1, character: 9 }, relations: ['definition'] });
    expect(result.locations).toEqual([]);
    expect(result.gaps[0]?.code).toBe('compiler-limit');
    const stats = probe.workerMessages[0]?.reviewStats;
    expect(stats?.unbounded).toBe(0);
    expect(stats?.maxBuffer).toBeGreaterThan(0);
    expect(stats?.maxBuffer).toBeLessThanOrEqual(MAX_SOURCE_BYTES + 1);
  });
  it('accounts for actual compiler bytes including a decoded UTF-8 BOM', async () => {
    const root = await fixture(); await writeFile(join(root, 'main.ts'), '\uFEFFclass A { run() {} }\nnew A().run();\n');
    const result = await resolveTypedSymbols({ root, path: 'main.ts', position: { line: 1, character: 9 }, relations: ['definition'] });
    expect(result.status, JSON.stringify(result)).toBe('resolved');
    const message = probe.workerMessages[0];
    expect(message?.reviewAccountedBytes).toBeGreaterThan(0);
    expect(message?.reviewAccountedBytes).toBe(message?.reviewStats.bytes);
  });
});
