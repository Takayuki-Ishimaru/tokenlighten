import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTypedCalleeSymbols, resolveTypedSymbols } from '../features/typed-symbols/index.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(source: string) {
  const root = await mkdtemp(join(tmpdir(), 'tl-typed-review1012-'));
  roots.push(root);
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022' }, include: ['main.ts'] }));
  await writeFile(join(root, 'main.ts'), source);
  return root;
}

describe('typed callee candidate completeness', () => {
  it.each([
    'class A { retry() { return "A"; } }\nclass B { retry() { return "B"; } }\nfunction summary(client: A | B) { return client.retry(); }\n',
    'function a() { return "A"; }\nfunction b() { return "B"; }\nfunction summary(f: typeof a | typeof b) { return f(); }\n',
    'function a() { return "A"; }\nfunction b() { return "B"; }\nfunction summary(client: { retry: typeof a | typeof b }) { return client.retry(); }\n',
  ])('does not choose one executable body from a union callable: %s', async source => {
    const root = await fixture(source);
    const line = source.split('\n')[2]!;
    const name = line.includes('client.retry') ? 'retry' : 'f()';
    const result = await resolveTypedCalleeSymbols({ root, path: 'main.ts', position: { line: 2, character: line.lastIndexOf(name) }, relations: ['definition'] });
    expect(result.status).toBe('unresolved');
    expect(result.locations).toEqual([]);
    expect(result.gaps).toContainEqual(expect.objectContaining({ code: 'ambiguous-symbol' }));
  });

  it('normalizes overload signatures through an alias to their single implementation', async () => {
    const source = 'function actual(x: string): string;\nfunction actual(x: number): string;\nfunction actual(x: string | number): string { return String(x); }\nconst client = { retry: actual };\nclient.retry(1);\n';
    const root = await fixture(source);
    const result = await resolveTypedCalleeSymbols({ root, path: 'main.ts', position: { line: 4, character: 7 }, relations: ['definition'] });
    expect(result.status).toBe('resolved');
    expect(result.locations).toEqual([expect.objectContaining({ range: expect.objectContaining({ start: { line: 2, character: 0 } }) })]);
  });
});

describe('typed reference completeness', () => {
  it.each(['retry', '"retry"', '["retry"]'])('finds declaration, dot and bracket references for method %s from every focal position', async declaration => {
    const source = `class A { ${declaration}() {} }\nconst a = new A();\na.retry();\na["retry"]();\n`;
    const root = await fixture(source);
    for (const position of [{ line: 0, character: declaration === 'retry' ? 11 : 12 }, { line: 2, character: 3 }, { line: 3, character: 4 }]) {
      const result = await resolveTypedSymbols({ root, path: 'main.ts', position, relations: ['references'] });
      expect(result.status).toBe('resolved');
      expect(result.gaps).toEqual([]);
      expect(result.locations.map(row => row.range.start.line)).toEqual([0, 2, 3]);
    }
  });

  it('matches the same generic method across different type instantiations', async () => {
    const root = await fixture('class Box<T> { retry(value: T): T { return value; } }\nconst a = new Box<string>();\nconst b = new Box<number>();\na.retry("a");\nb.retry(1);\n');
    const result = await resolveTypedSymbols({ root, path: 'main.ts', position: { line: 3, character: 3 }, relations: ['references'] });
    expect(result.status).toBe('resolved');
    expect(result.locations.map(row => row.range.start.line)).toEqual([0, 3, 4]);
  });

  it('preserves both roles of a shorthand without merging unrelated same-named properties', async () => {
    const root = await fixture('const value = 1;\nconst obj = { value };\nvoid value;\nvoid obj.value;\nconst other = { value: 2 };\nvoid other.value;\n');
    for (const [position, lines] of [
      [{ line: 0, character: 7 }, [0, 1, 2]],
      [{ line: 1, character: 15 }, [0, 1, 2, 3]],
      [{ line: 3, character: 10 }, [1, 3]],
      [{ line: 5, character: 12 }, [4, 5]],
    ] as const) {
      const result = await resolveTypedSymbols({ root, path: 'main.ts', position, relations: ['references'] });
      expect(result.status).toBe('resolved');
      expect(result.locations.map(row => row.range.start.line)).toEqual(lines);
    }
  });
});
