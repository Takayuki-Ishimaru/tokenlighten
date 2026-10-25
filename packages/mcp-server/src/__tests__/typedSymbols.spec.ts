import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { resolveTypedSymbols, contentHash, typedSymbolLanguage, TYPED_SYMBOL_LANGUAGES, type TypedSymbolRequest } from '../features/typed-symbols/index.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'tl-typed-symbols-'));
  directories.push(root);
  return root;
}
const MOCK_SERVER = String.raw`
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const config = JSON.parse(process.argv[2]);
fs.writeFileSync(config.pid, String(process.pid));
if (config.mode === 'child-process') {
  const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  fs.writeFileSync(config.pid + '.child', String(child.pid));
}
let input = Buffer.alloc(0);
let calls = 0;
const log = message => fs.appendFileSync(config.log, JSON.stringify(message) + '\n');
const send = message => {
  const body = Buffer.from(JSON.stringify(message));
  const frame = Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n'), body]);
  process.stdout.write(frame.subarray(0, 8));
  process.stdout.write(frame.subarray(8));
};
const reply = (message, result) => send({ jsonrpc: '2.0', id: message.id, result });
process.stdin.on('data', data => {
  input = Buffer.concat([input, data]);
  while (true) {
    const sep = input.indexOf('\r\n\r\n');
    if (sep < 0) return;
    const length = Number(input.subarray(0, sep).toString().match(/Content-Length: (\d+)/)[1]);
    if (input.length < sep + 4 + length) return;
    const message = JSON.parse(input.subarray(sep + 4, sep + 4 + length));
    input = input.subarray(sep + 4 + length);
    log(message);
    if (message.method === 'initialize') {
      if (config.mode === 'exit') { process.exit(1); return; }
      if (config.mode === 'bad-header') { process.stdout.write('Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}'); return; }
      if (config.mode === 'hang-startup') continue;
      if (config.mode === 'oversized-config-request') {
        send({ jsonrpc: '2.0', id: 'server-config', method: 'workspace/configuration', params: { items: Array.from({ length: 5000 }, () => ({ section: 'python' })) } });
        continue;
      }
      reply(message, { capabilities: { definitionProvider: true, typeDefinitionProvider: config.mode !== 'no-type', referencesProvider: true, textDocumentSync: config.mode === 'no-sync' ? 0 : 1, positionEncoding: config.mode === 'wrong-encoding' ? 'utf-8' : 'utf-16' } });
      continue;
    }
    if (message.method === 'shutdown') {
      if (config.mode === 'hang-shutdown') continue;
      reply(message, null);
      continue;
    }
    if (message.method === 'exit') { process.exit(0); return; }
    if (message.method && ['textDocument/definition', 'textDocument/typeDefinition', 'textDocument/references'].includes(message.method)) {
      calls++;
      if (config.mode === 'hang') continue;
      if (config.mode === 'error') { send({ jsonrpc: '2.0', id: message.id, error: { code: -32001, message: 'Index failed' } }); continue; }
      if (config.mode === 'stale' && calls === 1) fs.writeFileSync(config.source, 'service.other()\n');
      if (config.mode === 'target-stale' && calls === 2) fs.writeFileSync(config.target, 'class Other:\n    pass\n');
      const location = { targetUri: config.mode === 'outside-uri' ? 'https://example.com/source.py' : pathToFileURL(config.target).href, targetRange: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } }, targetSelectionRange: { start: { line: 1, character: 8 }, end: { line: 1, character: config.mode === 'bad-range' ? 999 : 13 } } };
      const locations = config.mode === 'ambiguous' ? [location, { ...location, targetRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 14 } }, targetSelectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } } }] : [location];
      if (config.mode === 'delayed') setTimeout(() => reply(message, locations), 120); else reply(message, locations);
    }
  }
});
`;
async function lspFixture(mode = '', externalTarget?: string): Promise<{ root: string; request: TypedSymbolRequest; log: string; pid: string }> {
  const root = await fixture();
  const source = path.join(root, 'main.py');
  const target = externalTarget ?? path.join(root, 'service.py');
  const script = path.join(root, 'mock-server.cjs');
  const log = path.join(root, 'messages.jsonl');
  const pid = path.join(root, 'server.pid');
  await Promise.all([writeFile(source, 'service.retry()\n'), writeFile(target, 'class Service:\n    def retry(self):\n        pass\n'), writeFile(script, MOCK_SERVER)]);
  return { root, log, pid, request: { root, path: 'main.py', position: { line: 0, character: 9 }, relations: ['definition'], timeoutMs: 1000, startupTimeoutMs: 1000, servers: { python: { command: process.execPath, args: [script, JSON.stringify({ mode, source, target, log, pid })] } } } };
}
async function messages(log: string): Promise<Array<{ method?: string; params?: unknown }>> {
  return (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}
async function assertExited(pidPath: string): Promise<void> {
  const pid = Number(await readFile(pidPath, 'utf8'));
  for (let tries = 0; tries < 30; tries++) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Language server process ${pid} survived cleanup.`);
}

describe('multilingual typed symbol resolution', () => {
  it('resolves a typed TS receiver, inheritance and re-export aliases to its actual method', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'base.ts'), 'export class Base { retry(): number { return 1; } }\n');
    await writeFile(path.join(root, 'exports.ts'), "export { Base as Client } from './base.js';\n");
    await writeFile(path.join(root, 'main.ts'), "import { Client } from './exports.js';\nclass Derived extends Client {}\nconst value = new Derived();\nvalue.retry();\n");
    const result = await resolveTypedSymbols({ root, path: 'main.ts', position: { line: 3, character: 7 }, relations: ['definition'] });
    expect(result.status).toBe('resolved');
    expect(result.backend).toBe('typescript');
    expect(result.locations).toEqual([expect.objectContaining({ path: 'base.ts', relation: 'definition', selectionRange: { start: { line: 0, character: 20 }, end: { line: 0, character: 25 } } })]);
    expect(result.locations[0]?.range.end.character).toBeGreaterThan(25);
  });

  it.skipIf(!existsSync('/usr/bin/clangd')).each(['c', 'cpp', 'hxx'])('verifies real clangd receiver resolution for %s', async extension => {
    const root = await fixture();
    const text = extension === 'cpp'
      ? 'struct Base { int retry() { return 1; } };\nstruct Other { int retry() { return 2; } };\nstruct Client : Base {};\nint run() { Client client; return client.retry(); }\n'
      : 'typedef struct Service { int value; } Service;\nstruct Other { int value; };\nService client;\nint run(void) { return client.value; }\n';
    const symbol = extension === 'cpp' ? 'retry' : 'value';
    await writeFile(path.join(root, `main.${extension}`), text);
    const result = await resolveTypedSymbols({ root, path: `main.${extension}`, position: { line: 3, character: text.split('\n')[3]!.indexOf(symbol) + 1 }, relations: ['definition'], servers: { [typedSymbolLanguage(`main.${extension}`)]: { command: '/usr/bin/clangd', args: ['--background-index=false', '--log=error'] } }, timeoutMs: 5000, startupTimeoutMs: 15000 });
    expect(result.status, JSON.stringify(result)).toBe('resolved');
    expect(result.locations[0]?.range.start.line).toBe(0);
  });

  it('uses JSDoc receiver types for JavaScript instead of matching method names', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'main.js'), 'class A { retry() { return 1; } }\nclass B { retry() { return 2; } }\n/** @type {A} */\nconst a = new A();\na.retry();\n');
    const result = await resolveTypedSymbols({ root, path: 'main.js', position: { line: 4, character: 4 }, relations: ['definition'] });
    expect(result.status).toBe('resolved');
    expect(result.locations[0]?.range.start.line).toBe(0);
  });

  it('keeps UTF-8 BOM source snapshots consistent with compiler inputs', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'main.ts'), '\uFEFFclass A { run() {} }\nnew A().run();\n');
    const result = await resolveTypedSymbols({ root, path: 'main.ts', position: { line: 1, character: 9 }, relations: ['definition'] });
    expect(result.status).toBe('resolved');
  });

  it('returns compiler-backed type definitions and project references', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022' }, include: ['*.ts'] }));
    await writeFile(path.join(root, 'service.ts'), 'export class Service { run() {} }\n');
    await writeFile(path.join(root, 'main.ts'), "import { Service } from './service';\nconst item = new Service();\nitem.run();\n");
    const result = await resolveTypedSymbols({ root, path: 'main.ts', position: { line: 1, character: 7 }, relations: ['typeDefinition', 'references'] });
    expect(result.status).toBe('resolved');
    expect(result.locations).toEqual(expect.arrayContaining([expect.objectContaining({ relation: 'typeDefinition', path: 'service.ts' }), expect.objectContaining({ relation: 'references', path: 'main.ts' })]));
  });

  it('rejects focal compiler errors and never substitutes lexical same-name matches', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'main.ts'), 'class A { retry() {} }\nconst a = new A();\na.missing();\n');
    const result = await resolveTypedSymbols({ root, path: 'main.ts', position: { line: 2, character: 4 }, relations: ['definition'] });
    expect(result.status).toBe('unresolved');
    expect(result.locations).toEqual([]);
  });

  it('synchronizes current LSP source and target, handles split byte frames and closes the process', async () => {
    const f = await lspFixture();
    const result = await resolveTypedSymbols(f.request);
    expect(result.status).toBe('resolved');
    expect(result.locations).toEqual([expect.objectContaining({ path: 'service.py', contentHash: contentHash('class Service:\n    def retry(self):\n        pass\n') })]);
    const calls = await messages(f.log);
    expect(calls.filter(call => call.method === 'textDocument/definition')).toHaveLength(2);
    expect(calls.filter(call => call.method === 'textDocument/didOpen')).toHaveLength(2);
    expect(calls.at(-2)?.method).toBe('shutdown');
    expect(calls.at(-1)?.method).toBe('exit');
    await assertExited(f.pid);
  });

  it('contains oversized server-request responses, cleans up and preserves concurrent and later resolutions', async () => {
    const failed = await lspFixture('oversized-config-request');
    const normal = await lspFixture();
    const command = failed.request.servers!.python;
    if (!command) throw new Error('Missing fixture server.');
    failed.request.servers = { python: { ...command, configuration: { python: { data: 'x'.repeat(1024) } } } };
    const [failure, success] = await Promise.all([resolveTypedSymbols(failed.request), resolveTypedSymbols(normal.request)]);
    expect(failure.status).toBe('unresolved');
    expect(failure.locations).toEqual([]);
    expect(failure.gaps).toEqual([expect.objectContaining({ code: 'protocol-limit' })]);
    expect(success.status).toBe('resolved');
    await Promise.all([assertExited(failed.pid), assertExited(normal.pid)]);
    const later = await lspFixture();
    expect((await resolveTypedSymbols(later.request)).status).toBe('resolved');
    await assertExited(later.pid);
  });

  it('keeps available definition evidence when optional typeDefinition is unsupported', async () => {
    const f = await lspFixture('no-type');
    const result = await resolveTypedSymbols({ ...f.request, relations: ['definition', 'typeDefinition', 'references'] });
    expect(result.status).toBe('partial');
    expect(result.locations.some(location => location.relation === 'definition')).toBe(true);
    expect(result.locations.some(location => location.relation === 'references')).toBe(true);
    expect(result.gaps).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'relation-unavailable', relation: 'typeDefinition' })]));
  });

  it.each(['go', 'rust', 'java', 'cpp', 'c', 'csharp', 'kotlin', 'php', 'ruby'])('runs configured stdio semantics for %s', async language => {
    const extension: Record<string, string> = { go: 'go', rust: 'rs', java: 'java', cpp: 'cpp', c: 'c', csharp: 'cs', kotlin: 'kt', php: 'php', ruby: 'rb' };
    const f = await lspFixture();
    const file = `main.${extension[language]}`;
    await writeFile(path.join(f.root, file), 'service.retry()\n');
    const result = await resolveTypedSymbols({ ...f.request, path: file, servers: { [language]: f.request.servers!.python } });
    expect(result.status).toBe('resolved');
    expect(result.language).toBe(language);
    expect(result.backend).toBe('lsp');
  });

  it('reports ambiguous declarations without asserting unique resolution', async () => {
    const f = await lspFixture('ambiguous');
    const result = await resolveTypedSymbols(f.request);
    expect(result.status).toBe('partial');
    expect(result.gaps).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'ambiguous-symbol' })]));
  });

  it.each(['outside-uri', 'bad-range'])('rejects unverified LSP locations: %s', async mode => {
    const f = await lspFixture(mode);
    const result = await resolveTypedSymbols(f.request);
    expect(result.status).toBe('unresolved');
    expect(result.locations).toEqual([]);
    expect(result.gaps.some(gap => gap.code === (mode === 'outside-uri' ? 'outside-root' : 'invalid-range'))).toBe(true);
  });

  it('rejects symlink targets outside the workspace', async () => {
    const external = await fixture();
    const f = await lspFixture('', path.join(external, 'foreign.py'));
    await symlink(path.join(external, 'foreign.py'), path.join(f.root, 'link.py'));
    const configured = f.request.servers!.python;
    if (!configured) throw new Error('Missing fixture server.');
    const settings = JSON.parse(configured.args![1]!);
    settings.target = path.join(f.root, 'link.py');
    f.request.servers = { python: { ...configured, args: [configured.args![0]!, JSON.stringify(settings)] } };
    const result = await resolveTypedSymbols(f.request);
    expect(result.locations).toEqual([]);
    expect(result.gaps.some(gap => gap.code === 'outside-root')).toBe(true);
  });

  it.each(['stale', 'target-stale'])('fails closed on source freshness loss: %s', async mode => {
    const f = await lspFixture(mode);
    const result = await resolveTypedSymbols(f.request);
    expect(result.status).toBe('unresolved');
    expect(result.locations).toEqual([]);
    expect(result.gaps[0]?.code).toBe('stale-source');
  });

  it.each(['error', 'exit', 'bad-header', 'no-sync', 'wrong-encoding'])('cleans up server failures: %s', async mode => {
    const f = await lspFixture(mode);
    const result = await resolveTypedSymbols(f.request);
    expect(result.status).toBe('unresolved');
    expect(result.locations).toEqual([]);
    await assertExited(f.pid);
  });

  it('cancels an outstanding request, notifies the server and kills a hung process', async () => {
    const f = await lspFixture('hang');
    const controller = new AbortController();
    const promise = resolveTypedSymbols({ ...f.request, signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    const result = await promise;
    expect(result.status).toBe('cancelled');
    expect((await messages(f.log)).some(message => message.method === '$/cancelRequest')).toBe(true);
    await assertExited(f.pid);
  });

  it('bounds startup, request and shutdown waits', async () => {
    for (const mode of ['hang-startup', 'hang', 'hang-shutdown']) {
      const f = await lspFixture(mode);
      const start = Date.now();
      const result = await resolveTypedSymbols({ ...f.request, timeoutMs: 250, startupTimeoutMs: 500 });
      expect(Date.now() - start).toBeLessThan(2000);
      expect(result.status).toBe(mode === 'hang-shutdown' ? 'resolved' : 'unresolved');
      await assertExited(f.pid);
    }
  });

  it('isolates concurrent document sessions', async () => {
    const first = await lspFixture('delayed');
    const second = await lspFixture('delayed');
    const results = await Promise.all([resolveTypedSymbols(first.request), resolveTypedSymbols(second.request)]);
    expect(results.map(result => result.status)).toEqual(['resolved', 'resolved']);
    expect(await readFile(first.pid, 'utf8')).not.toBe(await readFile(second.pid, 'utf8'));
    await Promise.all([assertExited(first.pid), assertExited(second.pid)]);
  });

  it.skipIf(process.platform === 'win32')('cleans runtime children launched by a language server', async () => {
    const f = await lspFixture('child-process');
    const result = await resolveTypedSymbols(f.request);
    expect(result.status).toBe('resolved');
    await assertExited(f.pid);
    await assertExited(`${f.pid}.child`);
  });

  it('bounds compiler work and supports compiler cancellation', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'main.ts'), 'class A { run() {} }\nnew A().run();\n');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 15);
    const cancelled = await resolveTypedSymbols({ root, path: 'main.ts', position: { line: 1, character: 9 }, signal: controller.signal });
    expect(cancelled.status).toBe('cancelled');
    const timedOut = await resolveTypedSymbols({ root, path: 'main.ts', position: { line: 1, character: 9 }, timeoutMs: 1 });
    expect(timedOut.gaps[0]?.code).toBe('timeout');
  });

  it('does not index unrelated large project files for focused definitions', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ include: ['*.ts'] }));
    await writeFile(path.join(root, 'main.ts'), 'class A { run() {} }\nnew A().run();\n');
    await writeFile(path.join(root, 'unrelated.ts'), ' '.repeat(4 * 1024 * 1024 + 1));
    const result = await resolveTypedSymbols({ root, path: 'main.ts', position: { line: 1, character: 9 }, relations: ['definition'] });
    expect(result.status).toBe('resolved');
  });

  it('runs its compiler worker from a single-file CJS distribution with an external TypeScript runtime', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'main.ts'), 'class A { run() {} }\nnew A().run();\n');
    await mkdir(path.join(root, 'node_modules'));
    const compilerRoot = path.dirname(createRequire(import.meta.url).resolve('typescript/package.json'));
    await symlink(compilerRoot, path.join(root, 'node_modules', 'typescript'), process.platform === 'win32' ? 'junction' : 'dir');
    await build({ entryPoints: [fileURLToPath(new URL('../features/typed-symbols/index.ts', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(root, 'engine.cjs'), logLevel: 'silent', external: ['typescript'] });
    const script = "const { resolveTypedSymbols } = require('./engine.cjs'); resolveTypedSymbols({ root: process.cwd(), path: 'main.ts', position: { line: 1, character: 9 }, relations: ['definition'] }).then(result => console.log(JSON.stringify(result)));";
    for (const esm of [false, true]) {
      const invocation = esm ? "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); " + script : script;
      const result = await promisify(execFile)(process.execPath, [...(esm ? ['--input-type=module'] : []), '-e', invocation], { cwd: root, timeout: 8000 });
      expect(JSON.parse(result.stdout).status).toBe('resolved');
    }
  });

  it('isolates concurrent compiler programs', async () => {
    const roots = await Promise.all([fixture(), fixture()]);
    await Promise.all(roots.map((root, index) => writeFile(path.join(root, 'main.ts'), `class A { run() { return ${index}; } }\nnew A().run();\n`)));
    const results = await Promise.all(roots.map(root => resolveTypedSymbols({ root, path: 'main.ts', position: { line: 1, character: 9 }, relations: ['definition'] })));
    expect(results.map(result => result.status)).toEqual(['resolved', 'resolved']);
    expect(results[0]?.locations[0]?.contentHash).not.toBe(results[1]?.locations[0]?.contentHash);
  });

  it('rejects invalid UTF-8 source before backend startup', async () => {
    const f = await lspFixture();
    await writeFile(path.join(f.root, 'main.py'), Buffer.from([0xc3, 0x28]));
    const result = await resolveTypedSymbols(f.request);
    expect(result.gaps[0]?.code).toBe('source-encoding');
    await expect(readFile(f.pid)).rejects.toThrow();
  });

  it('reports unavailable and unsupported backends explicitly', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'main.py'), 'value()\n');
    const unavailable = await resolveTypedSymbols({ root, path: 'main.py', position: { line: 0, character: 0 } });
    expect(unavailable.status).toBe('unavailable');
    expect(unavailable.gaps[0]?.code).toBe('server-unavailable');
    const unsupported = await resolveTypedSymbols({ root, path: 'main.unknown', position: { line: 0, character: 0 } });
    expect(unsupported.gaps[0]?.code).toBe('unsupported-language');
    expect(TYPED_SYMBOL_LANGUAGES).toHaveLength(12);
    expect(typedSymbolLanguage('View.tsx')).toBe('typescript');
  });

  it('checks supplied hashes and UTF-16 positions before starting a backend', async () => {
    const f = await lspFixture();
    const stale = await resolveTypedSymbols({ ...f.request, expectedContentHash: 'outdated' });
    expect(stale.gaps[0]?.code).toBe('stale-source');
    const invalid = await resolveTypedSymbols({ ...f.request, position: { line: 100, character: 0 } });
    expect(invalid.gaps[0]?.code).toBe('invalid-position');
    await expect(readFile(f.pid)).rejects.toThrow();
  });
});
