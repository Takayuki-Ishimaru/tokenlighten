import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { shortTmpDir } from './helpers/shortTmpDir.js';
import { rmDirWithRetry } from './helpers/rmDirWithRetry.js';
import { callTool } from '../server.js';
import { resetAll } from '../util/session.js';
import { handleTable } from '../util/handles.js';
import { defaultEngineConfiguration, withEngineConfiguration } from '../features/engines/config.js';
import { resolveTypedCallee } from '../features/typed-symbols/calleeClosure.js';
import { resolveTypedSymbols } from '../features/typed-symbols/index.js';
import { qualifiedCalleePositionsIn } from '../features/task-pack/evidenceClosure.js';
import { runWithRequestSignal } from '../util/requestCancellation.js';

const roots: string[] = [];
afterAll(async () => { for (const root of roots) await rmDirWithRetry(root); });
beforeEach(() => { resetAll(); handleTable.reset(); });
function workspace(files: Record<string, string>): string {
  const root = fs.realpathSync(shortTmpDir(homedir(), '.tl-typed-integration-'));
  roots.push(root);
  for (const [file, content] of Object.entries({ 'package.json': '{"type":"module"}\n', ...files })) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return root;
}
function typedConfiguration() {
  const config = defaultEngineConfiguration();
  config.typedSymbols.enabled = true;
  return config;
}
const LEFT = 'export class PrimaryClient {\n  retry(): string {\n    return "CORRECT_RECEIVER_BODY";\n  }\n}\n';
const RIGHT = 'export class OtherClient {\n  retry(): string {\n    return "WRONG_RECEIVER_BODY";\n  }\n}\n';
const SOURCE = 'import { PrimaryClient } from "./primary.js";\nimport { OtherClient } from "./other.js";\nexport function retrySummary(client: PrimaryClient): string {\n  return client.retry();\n}\n';
const NAME_ONLY_LSP = String.raw`
const { pathToFileURL } = require('node:url');
const target = process.argv[2];
const configurationItems = Number(process.argv[3] ?? 0);
let buffer = Buffer.alloc(0);
function sendMessage(message) {
  const body = Buffer.from(JSON.stringify(message));
  process.stdout.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n'), body]));
}
function send(id, result) { sendMessage({ jsonrpc: '2.0', id, result }); }
process.stdin.on('data', data => {
  buffer = Buffer.concat([buffer, data]);
  while (true) {
    const separator = buffer.indexOf('\r\n\r\n');
    if (separator < 0) return;
    const length = Number(buffer.subarray(0, separator).toString().match(/Content-Length:\s*(\d+)/)[1]);
    if (buffer.length < separator + 4 + length) return;
    const message = JSON.parse(buffer.subarray(separator + 4, separator + 4 + length));
    buffer = buffer.subarray(separator + 4 + length);
    if (message.method === 'initialize') {
      if (configurationItems) sendMessage({ jsonrpc: '2.0', id: 'configuration', method: 'workspace/configuration', params: { items: Array.from({ length: configurationItems }, () => ({ section: 'python' })) } });
      else send(message.id, { capabilities: { definitionProvider: true, textDocumentSync: 1 } });
    }
    else if (message.method === 'textDocument/definition') send(message.id, { uri: pathToFileURL(target).href, range: { start: { line: 1, character: 8 }, end: { line: 1, character: 13 } } });
    else if (message.method === 'shutdown') send(message.id, null);
    else if (message.method === 'exit') process.exit(0);
  }
});
`;

async function readValueEvidence(root: string, target: { path: string; range: string }, config: ReturnType<typeof typedConfiguration>) {
  config.compoundRequests.enabled = false;
  let arguments_: Record<string, unknown> | undefined = { cwd: root,
    query: 'What exact value does retrySummary return and why? Cite the functions that determine the returned value.',
    targets: [target], task: { epoch: 'new', profile: 'answer' }, budget: { tokens: 8000 } };
  const hops: Array<Record<string, any>> = [];
  let delivered = '';
  for (let hop = 0; hop < 6 && arguments_; hop++) {
    const response = await withEngineConfiguration(config, () => callTool('tl_read_file', arguments_!));
    const part = response.content[0];
    if (part?.type !== 'text') throw new Error('Expected textual MCP result.');
    const result = JSON.parse(part.text);
    hops.push(result);
    delivered += '\n' + (result.evidence ?? []).map((entry: { body?: string }) => entry.body ?? '').join('\n');
    const next = result.decision?.next ?? result.next ?? result.limit?.next;
    arguments_ = next?.tool === 'tl_read_file' ? next.arguments : undefined;
  }
  expect(arguments_, JSON.stringify(hops)).toBeUndefined();
  return { hops, delivered };
}

describe('typed callee completeness regressions', () => {
  it('public dynamic receiver read does not substitute an unrelated imported function', async () => {
    const root = workspace({
      'src/main.ts': 'import { retry } from "./local.js";\nexport function retrySummary(client: any): string {\n  return client.retry();\n}\n',
      'src/local.ts': 'export function retry(): string {\n  return "UNRELATED_RETRY_BODY";\n}\n',
    });
    const { hops, delivered } = await readValueEvidence(root, { path: 'src/main.ts', range: '2-4' }, typedConfiguration());
    expect(delivered).not.toContain('UNRELATED_RETRY_BODY');
    for (const result of hops) {
      if (result.decision?.kind === 'act.answer') {
        expect(result.decision.certificate.gaps, JSON.stringify(hops)).toEqual(expect.arrayContaining([
          expect.stringMatching(/request-item-undetermined:value:retrySummary/),
        ]));
      }
    }
    expect(hops.some(result => result.decision?.gaps?.length || result.decision?.certificate?.gaps?.length), JSON.stringify(hops)).toBe(true);
  }, 30000);

  it.each(['retry() + client.retry()', 'client.retry() + retry()'])('public read discloses distinct bare and member callees: %s', async expression => {
    const root = workspace({
      'src/main.ts': 'import { retry } from "./local.js";\nimport { Good } from "./good.js";\nexport function retrySummary(client: Good): string {\n  return ' + expression + ';\n}\n',
      'src/local.ts': 'export function retry(): string {\n  return "GLOBAL_REQUIRED_BODY";\n}\n',
      'src/good.ts': 'export class Good {\n  retry(): string { return "MEMBER_REQUIRED_BODY"; }\n}\n',
    });
    const { hops, delivered } = await readValueEvidence(root, { path: 'src/main.ts', range: '3-5' }, typedConfiguration());
    const complete = delivered.includes('GLOBAL_REQUIRED_BODY') && delivered.includes('MEMBER_REQUIRED_BODY');
    for (const result of hops) {
      if (result.decision?.kind === 'act.answer' && !complete) {
        expect(result.decision.certificate.gaps, JSON.stringify(hops)).toEqual(expect.arrayContaining([
          expect.stringMatching(/request-item-undetermined:value:retrySummary/),
        ]));
      }
    }
    expect(complete || hops.some(result => result.decision?.gaps?.length || result.decision?.certificate?.gaps?.length), JSON.stringify(hops)).toBe(true);
  }, 30000);

  it('public read retains an unresolved gap for union receiver implementations', async () => {
    const root = workspace({
      'src/main.ts': 'import { A } from "./a.js";\nimport { B } from "./b.js";\nexport function retrySummary(client: A | B): string {\n  return client.retry();\n}\n',
      'src/a.ts': 'export class A {\n  retry(): string { return "A_UNION_BODY"; }\n}\n',
      'src/b.ts': 'export class B {\n  retry(): string { return "B_UNION_BODY"; }\n}\n',
    });
    const { hops, delivered } = await readValueEvidence(root, { path: 'src/main.ts', range: '3-5' }, typedConfiguration());
    const servedBoth = delivered.includes('A_UNION_BODY') && delivered.includes('B_UNION_BODY');
    expect(servedBoth || hops.some(result => result.decision?.gaps?.length || result.decision?.certificate?.gaps?.length), JSON.stringify(hops)).toBe(true);
    for (const result of hops) {
      if (result.decision?.kind === 'act.answer' && !servedBoth) {
        expect(result.decision.certificate.gaps, JSON.stringify(hops)).toBeDefined();
      }
    }
  }, 30000);

  it('public read resolves the same member name independently in sibling helper scopes', async () => {
    const root = workspace({
      'src/main.ts': 'import { first, second } from "./helpers.js";\nimport { A } from "./a.js";\nimport { B } from "./b.js";\nexport function retrySummary(a: A, b: B): string {\n  return first(a) + second(b);\n}\n',
      'src/helpers.ts': 'import { A } from "./a.js";\nimport { B } from "./b.js";\nexport function first(a: A): string {\n  return a.retry();\n}\nexport function second(b: B): string {\n  return b.retry();\n}\n',
      'src/a.ts': 'export class A {\n  retry(): string {\n    return "FIRST_ACTUAL_BODY";\n  }\n}\n',
      'src/b.ts': 'export class B {\n  retry(): string {\n    return "SECOND_ACTUAL_BODY";\n  }\n}\n',
    });
    const { hops, delivered } = await readValueEvidence(root, { path: 'src/main.ts', range: '4-6' }, typedConfiguration());
    expect(delivered, JSON.stringify(hops)).toContain('FIRST_ACTUAL_BODY');
    expect(delivered, JSON.stringify(hops)).toContain('SECOND_ACTUAL_BODY');
    expect(hops.at(-1)?.decision?.kind, JSON.stringify(hops)).toBe('act.answer');
    expect(hops.at(-1)?.decision?.certificate?.gaps).toBeUndefined();
  }, 30000);

  it.each([false, true])('public Java LSP read requires a callable body (bodyless: %s)', async bodyless => {
    const definition = bodyless
      ? 'public abstract class Client {\n  abstract String retry();\n}\n'
      : 'public class Client {\n  String retry() { return "JAVA_ACTUAL_BODY"; }\n}\n';
    const position = definition.split('\n')[1]!.indexOf('retry');
    const server = NAME_ONLY_LSP.replace('character: 8', `character: ${position}`).replace('character: 13', `character: ${position + 5}`);
    const root = workspace({
      'Main.java': 'public class Main {\n  public static String retrySummary(Client client) {\n    return client.retry();\n  }\n}\n',
      'Client.java': definition,
      'RealClient.java': 'public class RealClient extends Client {\n  String retry() { return "UNRESOLVED_RUNTIME_BODY"; }\n}\n',
      'name-only-server.cjs': server,
    });
    const config = typedConfiguration();
    config.typedSymbols.servers.java = { command: process.execPath, args: [path.join(root, 'name-only-server.cjs'), path.join(root, 'Client.java')] };
    const { hops, delivered } = await readValueEvidence(root, { path: 'Main.java', range: '2-4' }, config);
    if (bodyless) {
      expect(delivered).not.toContain('UNRESOLVED_RUNTIME_BODY');
      for (const result of hops) {
        if (result.decision?.kind === 'act.answer') expect(result.decision.certificate.gaps, JSON.stringify(hops)).toBeDefined();
      }
      expect(hops.some(result => result.decision?.gaps?.length || result.decision?.certificate?.gaps?.length), JSON.stringify(hops)).toBe(true);
    } else {
      expect(delivered, JSON.stringify(hops)).toContain('JAVA_ACTUAL_BODY');
      expect(hops.at(-1)?.decision?.kind, JSON.stringify(hops)).toBe('act.answer');
      expect(hops.at(-1)?.decision?.certificate?.gaps).toBeUndefined();
    }
  }, 30000);

  it.each([4, 5])('public read discloses coordinate overflow after %s external calls instead of proving local-body absence', async externalCalls => {
    const source = 'import { Own } from "./own.js";\nexport function retrySummary(formatter: number, own: Own): string {\n  return '
      + Array.from({ length: externalCalls }, (_, index) => `formatter.toFixed(${index + 1})`).join(' + ') + ' + own.toFixed(6);\n}\n';
    const root = workspace({ 'src/main.ts': source,
      'src/own.ts': 'export class Own {\n  toFixed(n: number): string {\n    return "LATER_LOCAL_BODY";\n  }\n}\n' });
    const { hops, delivered } = await readValueEvidence(root, { path: 'src/main.ts', range: '2-4' }, typedConfiguration());
    for (const result of hops) {
      if (result.decision?.kind === 'act.answer' && !delivered.includes('LATER_LOCAL_BODY')) {
        expect(result.decision.certificate.gaps, JSON.stringify(hops)).toBeDefined();
      }
    }
    expect(delivered.includes('LATER_LOCAL_BODY') || hops.some(result => result.decision?.gaps?.length || result.decision?.certificate?.gaps?.length), JSON.stringify(hops)).toBe(true);
  }, 30000);
});

describe('typed callee integration with caller-named source', () => {
  it('preserves focal-window coordinates and excludes declaration/string tokens', () => {
    expect(qualifiedCalleePositionsIn(['client.retry();', '"client.retry()";', 'client.retry();'], 3, 3, 'retry', false)).toEqual([{ line: 2, character: 7 }]);
    expect(qualifiedCalleePositionsIn(['retry() { return 1; }'], 1, 1, 'retry', false)).toEqual([]);
  });

  it('resolves the actual receiver rather than the first same-named method', async () => {
    const root = workspace({ 'src/main.ts': SOURCE, 'src/primary.ts': LEFT, 'src/other.ts': RIGHT });
    const config = typedConfiguration();
    const result = await withEngineConfiguration(config, () => resolveTypedCallee({ workspace: root, source: SOURCE,
      focal: { path: 'src/main.ts', name: 'retrySummary', startLine: 3, endLine: 5 }, calleeName: 'retry', hashComment: false }));
    expect(result).toEqual(expect.objectContaining({ kind: 'resolved', path: 'src/primary.ts', symbol: { startLine: 2, endLine: 4 } }));
  });

  it('does not choose an arbitrary declaration when one focal uses two receiver types', async () => {
    const source = SOURCE.replace('client: PrimaryClient', 'client: PrimaryClient, other: OtherClient').replace('return client.retry();', 'return client.retry() + other.retry();');
    const root = workspace({ 'src/main.ts': source, 'src/primary.ts': LEFT, 'src/other.ts': RIGHT });
    const result = await withEngineConfiguration(typedConfiguration(), () => resolveTypedCallee({ workspace: root, source,
      focal: { path: 'src/main.ts', name: 'retrySummary', startLine: 3, endLine: 5 }, calleeName: 'retry', hashComment: false }));
    expect(result).toEqual({ kind: 'unresolved', reason: 'ambiguous-typed-receivers' });
  });

  it('resolves bare and member calls when both refer to the same implementation', async () => {
    const source = 'import { retry } from "./local.js";\nconst client = { retry };\nexport function retrySummary(): string {\n  return retry() + client.retry();\n}\n';
    const root = workspace({ 'src/main.ts': source, 'src/local.ts': 'export function retry(): string { return "SHARED_BODY"; }\n' });
    const result = await withEngineConfiguration(typedConfiguration(), () => resolveTypedCallee({ workspace: root, source,
      focal: { path: 'src/main.ts', name: 'retrySummary', startLine: 3, endLine: 5 }, calleeName: 'retry', hashComment: false }));
    expect(result).toMatchObject({ kind: 'resolved', path: 'src/local.ts', name: 'retry' });
  });

  it('retains a genuine unavailable-backend fallback for installed-server languages', async () => {
    const source = 'def retry_summary(client):\n    return client.retry()\n';
    const root = workspace({ 'main.py': source });
    const config = typedConfiguration();
    config.typedSymbols.servers.py = { command: path.join(root, 'server-not-installed') };
    const result = await withEngineConfiguration(config, () => resolveTypedCallee({ workspace: root, source,
      focal: { path: 'main.py', name: 'retry_summary', startLine: 1, endLine: 2 }, calleeName: 'retry', hashComment: true }));
    expect(result).toEqual({ kind: 'fallback', reason: 'server-unavailable' });
  });

  it('public seeded read keeps a failed LSP session unfinished without serving a local homonym', async () => {
    const source = 'def retry():\n    return "WRONG_LOCAL_PROTOCOL_BODY"\ndef retry_summary(client):\n    return client.retry()\n';
    const root = workspace({ 'src/main.py': source, 'name-only-server.cjs': NAME_ONLY_LSP });
    const config = typedConfiguration();
    config.compoundRequests.enabled = false;
    config.typedSymbols.servers.py = { command: process.execPath,
      args: [path.join(root, 'name-only-server.cjs'), path.join(root, 'src/main.py'), '5000'],
      configuration: { python: { data: 'x'.repeat(1024) } } };
    const closure = await withEngineConfiguration(config, () => resolveTypedCallee({ workspace: root, source,
      focal: { path: 'src/main.py', name: 'retry_summary', startLine: 3, endLine: 4 }, calleeName: 'retry', hashComment: true }));
    let arguments_: Record<string, unknown> | undefined = { cwd: root,
      query: 'What exact value does retry_summary return and why? Cite the functions that determine the returned value.',
      targets: [{ path: 'src/main.py', range: '3-4' }], task: { epoch: 'new', profile: 'answer' }, budget: { tokens: 5000 } };
    const hops: Array<Record<string, any>> = [];
    let delivered = '';
    for (let hop = 0; hop < 5 && arguments_; hop++) {
      const response = await withEngineConfiguration(config, () => callTool('tl_read_file', arguments_!));
      const result = JSON.parse(response.content[0]!.text as string);
      hops.push(result);
      delivered += '\n' + (result.evidence ?? []).map((entry: { body?: string }) => entry.body ?? '').join('\n');
      const continuation = result.decision?.next ?? result.next ?? result.limit?.next;
      arguments_ = continuation?.tool === 'tl_read_file' ? continuation.arguments : undefined;
    }
    expect(delivered, JSON.stringify(hops)).not.toContain('WRONG_LOCAL_PROTOCOL_BODY');
    expect(closure).toEqual({ kind: 'unresolved', reason: 'protocol-limit' });
    for (const result of hops) {
      if (result.decision?.kind === 'act.answer') expect(result.decision.certificate.gaps).toBeDefined();
    }
    const next = await callTool('tl_read_file', { cwd: root, targets: [{ path: 'src/main.py', range: '1-2' }], task: { epoch: 'new' } });
    expect(next.content[0]?.type).toBe('text');
    expect(next.content[0]!.text).toContain('WRONG_LOCAL_PROTOCOL_BODY');
  }, 30000);

  it('recognizes standard-library calls without selecting a local homonym or adding a gap', async () => {
    const source = 'function push() { return "WRONG_LOCAL_PUSH"; }\nexport function collect(values: number[]) {\n  values.push(1);\n  return values;\n}\n';
    const root = workspace({ 'main.ts': source });
    const result = await withEngineConfiguration(typedConfiguration(), () => resolveTypedCallee({ workspace: root, source,
      focal: { path: 'main.ts', name: 'collect', startLine: 2, endLine: 5 }, calleeName: 'push', hashComment: false }));
    expect(result).toEqual({ kind: 'external', reason: 'external-definition' });
  });

  it('keeps an inconclusive dynamic receiver unfinished', async () => {
    const source = 'export function collect(value: any) {\n  return value.run();\n}\n';
    const root = workspace({ 'main.ts': source });
    const result = await withEngineConfiguration(typedConfiguration(), () => resolveTypedCallee({ workspace: root, source,
      focal: { path: 'main.ts', name: 'collect', startLine: 1, endLine: 3 }, calleeName: 'run', hashComment: false }));
    expect(result.kind).toBe('unresolved');
  });

  it('retains an owned method when another same-named call resolves to the standard library', async () => {
    const source = 'class Collector { push(value: number) { return value; } }\nexport function collect(values: number[], collector: Collector) {\n  values.push(1);\n  return collector.push(2);\n}\n';
    const root = workspace({ 'main.ts': source });
    const result = await withEngineConfiguration(typedConfiguration(), () => resolveTypedCallee({ workspace: root, source,
      focal: { path: 'main.ts', name: 'collect', startLine: 2, endLine: 5 }, calleeName: 'push', hashComment: false }));
    expect(result).toEqual(expect.objectContaining({ kind: 'resolved', path: 'main.ts', symbol: { startLine: 1, endLine: 1 } }));
  });

  it.each(['ts', 'js'])('public seeded %s tl_read_file closes return-value evidence with the correct typed callee', async extension => {
    const source = extension === 'ts' ? SOURCE : SOURCE.replace('export function retrySummary(client: PrimaryClient): string', '/** @param {PrimaryClient} client */\nexport function retrySummary(client)');
    const left = extension === 'ts' ? LEFT : LEFT.replace(': string', '');
    const right = extension === 'ts' ? RIGHT : RIGHT.replace(': string', '');
    const range = extension === 'ts' ? '3-5' : '4-6';
    const root = workspace({ [`src/main.${extension}`]: source, [`src/primary.${extension}`]: left, [`src/other.${extension}`]: right });
    const config = typedConfiguration();
    config.compoundRequests.enabled = false;
    const firstArguments = { cwd: root,
      query: 'What does retrySummary return and why? Cite the functions that determine the returned value.',
      targets: [{ path: `src/main.${extension}`, range }], task: { epoch: 'new', profile: 'answer' }, budget: { tokens: 5000 } };
    const hops: Array<Record<string, any>> = [];
    let arguments_: Record<string, unknown> | undefined = firstArguments;
    let delivered = '';
    for (let hop = 0; hop < 5 && arguments_; hop++) {
      const response = await withEngineConfiguration(config, () => callTool('tl_read_file', arguments_!));
      const part = response.content[0];
      if (part?.type !== 'text') throw new Error('Expected textual MCP result.');
      const result = JSON.parse(part.text);
      hops.push(result);
      delivered += '\n' + (result.evidence ?? []).map((entry: { body?: string }) => entry.body ?? '').join('\n');
      if (result.decision?.kind === 'act.answer') expect(delivered, JSON.stringify(hops)).toContain('CORRECT_RECEIVER_BODY');
      const next = result.decision?.next ?? result.next ?? result.limit?.next;
      arguments_ = next?.tool === 'tl_read_file' ? next.arguments : undefined;
    }
    expect(arguments_, JSON.stringify(hops)).toBeUndefined();
    expect(delivered, JSON.stringify(hops)).toContain('CORRECT_RECEIVER_BODY');
    expect(delivered, JSON.stringify(hops)).not.toContain('WRONG_RECEIVER_BODY');
    expect(hops.flatMap(result => result.evidence ?? []).some((entry: { path: string }) => entry.path === `src/primary.${extension}`)).toBe(true);
    const caller = hops[0]?.evidence?.find((entry: { path: string }) => entry.path === `src/main.${extension}`);
    expect(caller?.range).toBe(range);
  }, 30000);

  it('public Python seeded continuation expands a name-only LSP location to the actual full callable body', async () => {
    const root = workspace({
      'src/main.py': 'from primary import PrimaryClient\nfrom other import OtherClient\ndef retry_summary(client: PrimaryClient):\n    return client.retry()\n',
      'src/primary.py': 'class PrimaryClient:\n    def retry(self):\n        marker = "PY_CORRECT_RECEIVER_BODY"\n        return marker\n',
      'src/other.py': 'class OtherClient:\n    def retry(self):\n        return "PY_WRONG_RECEIVER_BODY"\n',
      'name-only-server.cjs': NAME_ONLY_LSP,
    });
    const config = typedConfiguration();
    config.compoundRequests.enabled = false;
    config.typedSymbols.servers.py = { command: process.execPath, args: [path.join(root, 'name-only-server.cjs'), path.join(root, 'src/primary.py')] };
    let arguments_: Record<string, unknown> | undefined = { cwd: root,
      query: 'What does retry_summary return and why? Cite the functions that determine the returned value.',
      targets: [{ path: 'src/main.py', range: '3-4' }], task: { epoch: 'new', profile: 'answer' }, budget: { tokens: 5000 } };
    const hops: Array<Record<string, any>> = [];
    let delivered = '';
    for (let hop = 0; hop < 5 && arguments_; hop++) {
      const response = await withEngineConfiguration(config, () => callTool('tl_read_file', arguments_!));
      const part = response.content[0];
      if (part?.type !== 'text') throw new Error('Expected textual MCP result.');
      const result = JSON.parse(part.text);
      hops.push(result);
      delivered += '\n' + (result.evidence ?? []).map((entry: { body?: string }) => entry.body ?? '').join('\n');
      if (result.decision?.kind === 'act.answer') expect(delivered, JSON.stringify(hops)).toContain('return marker');
      const next = result.decision?.next ?? result.next ?? result.limit?.next;
      arguments_ = next?.tool === 'tl_read_file' ? next.arguments : undefined;
    }
    expect(arguments_, JSON.stringify(hops)).toBeUndefined();
    expect(delivered, JSON.stringify(hops)).toContain('PY_CORRECT_RECEIVER_BODY');
    expect(delivered, JSON.stringify(hops)).toContain('return marker');
    expect(delivered, JSON.stringify(hops)).not.toContain('PY_WRONG_RECEIVER_BODY');
    expect(hops.flatMap(result => result.evidence ?? []).some((entry: { path: string; range: string }) => entry.path === 'src/primary.py' && entry.range === '2-4')).toBe(true);
    expect(hops[0]?.evidence?.find((entry: { path: string }) => entry.path === 'src/main.py')?.range).toBe('3-4');
  }, 30000);
});


describe('typed callee source coordinate integrity', () => {
  it.each([false, true])('public seeded receiver evidence with a request signal (Node 20.0 compatibility: %s)', async legacy => {
    const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any')!;
    if (legacy) Object.defineProperty(AbortSignal, 'any', { ...descriptor, value: undefined });
    try {
      const controller = new AbortController();
      const source = 'import { GoodClient } from "./good.js";\n'
        + 'function retry() { return "WRONG_LOCAL_BODY"; }\n'
        + 'export function retrySummary(client: GoodClient): string { const label = "😀"; return client.retry(); }\n';
      const root = workspace({ 'src/main.ts': source,
        'src/good.ts': 'export class GoodClient {\n  retry(): string { return "ACTUAL_IMPLEMENTATION_BODY"; }\n}\n' });
      const config = typedConfiguration();
      config.compoundRequests.enabled = false;
      expect(qualifiedCalleePositionsIn(source.split(/\r?\n/), 3, 3, 'retry', false))
        .toEqual([{ line: 2, character: source.split('\n')[2]!.indexOf('retry();') }]);
      let arguments_: Record<string, unknown> | undefined = { cwd: root,
        query: 'What exact value does retrySummary return and why? Cite the functions that determine the returned value.',
        targets: [{ path: 'src/main.ts', range: '3-3' }], task: { epoch: 'new', profile: 'answer' }, budget: { tokens: 5000 } };
      const hops: Array<Record<string, any>> = [];
      let delivered = '';
      for (let hop = 0; hop < 5 && arguments_; hop++) {
        const response = await runWithRequestSignal(controller.signal,
          () => withEngineConfiguration(config, () => callTool('tl_read_file', arguments_!)));
        const part = response.content[0];
        if (part?.type !== 'text') throw new Error('Expected textual MCP result.');
        const result = JSON.parse(part.text);
        hops.push(result);
        delivered += '\n' + (result.evidence ?? []).map((entry: { body?: string }) => entry.body ?? '').join('\n');
        if (result.decision?.kind === 'act.answer') expect(delivered, JSON.stringify(hops)).toContain('ACTUAL_IMPLEMENTATION_BODY');
        const next = result.decision?.next ?? result.next ?? result.limit?.next;
        arguments_ = next?.tool === 'tl_read_file' ? next.arguments : undefined;
      }
      expect(hops.at(-1)?.decision?.kind, JSON.stringify(hops)).toBe('act.answer');
      expect(delivered).toContain('ACTUAL_IMPLEMENTATION_BODY');
      expect(delivered).not.toContain('WRONG_LOCAL_BODY');
    } finally { if (legacy) Object.defineProperty(AbortSignal, 'any', descriptor); }
  }, 30000);
});


describe('callee implementations are distinct from definition bindings', () => {
  const ALIAS_SOURCE = 'import { actualRetry } from "./good.js";\nconst client = { retry: actualRetry };\nexport function retrySummary(): string {\n  return client.retry();\n}\n';
  const ACTUAL_BODY = 'export function actualRetry(): string {\n  return "ACTUAL_ALIAS_BODY";\n}\n';
  it.each([
    '(): string =>',
    'function (): string',
    'function implementationName(): string',
  ])('public alias call serves a callable variable implementation: %s', async initializer => {
    const root = workspace({ 'src/main.ts': ALIAS_SOURCE,
      'src/good.ts': 'export const actualRetry = ' + initializer + ' {\n  return "CALLABLE_VARIABLE_BODY";\n};\n' });
    const { hops, delivered } = await readValueEvidence(root, { path: 'src/main.ts', range: '3-5' }, typedConfiguration());
    expect(delivered, JSON.stringify(hops)).toContain('CALLABLE_VARIABLE_BODY');
    expect(hops.at(-1)?.decision?.kind, JSON.stringify(hops)).toBe('act.answer');
    expect(hops.at(-1)?.decision?.certificate?.gaps).toBeUndefined();
  }, 30000);

  it('preserves the generic property-definition API while callee closure follows its call signature', async () => {
    const root = workspace({ 'src/main.ts': ALIAS_SOURCE, 'src/good.ts': ACTUAL_BODY });
    const ordinary = await resolveTypedSymbols({ root, path: 'src/main.ts', position: { line: 3, character: 16 }, relations: ['definition'] });
    expect(ordinary.status).toBe('resolved');
    expect(ordinary.locations[0]).toMatchObject({ path: 'src/main.ts', range: { start: { line: 1, character: 17 } } });
    const call = await withEngineConfiguration(typedConfiguration(), () => resolveTypedCallee({ workspace: root, source: ALIAS_SOURCE,
      focal: { path: 'src/main.ts', name: 'retrySummary', startLine: 3, endLine: 5 }, calleeName: 'retry', hashComment: false }));
    expect(call).toMatchObject({ kind: 'resolved', path: 'src/good.ts', name: 'actualRetry', symbol: { startLine: 1, endLine: 3 } });
  });
  it('keeps an own interface signature unresolved as executable callee evidence', async () => {
    const source = 'interface Client { retry(): string; }\nexport function retrySummary(client: Client): string { return client.retry(); }\n';
    const root = workspace({ 'main.ts': source });
    const result = await withEngineConfiguration(typedConfiguration(), () => resolveTypedCallee({ workspace: root, source,
      focal: { path: 'main.ts', name: 'retrySummary', startLine: 2, endLine: 2 }, calleeName: 'retry', hashComment: false }));
    expect(result).toEqual({ kind: 'unresolved', reason: 'callable-body-unresolved' });
  });
  it('public seeded alias call serves the actual returned-value body before act.answer', async () => {
    const root = workspace({ 'src/main.ts': ALIAS_SOURCE, 'src/good.ts': ACTUAL_BODY });
    const config = typedConfiguration(); config.compoundRequests.enabled = false;
    let arguments_: Record<string, unknown> | undefined = { cwd: root,
      query: 'What exact value does retrySummary return and why? Cite the functions that determine the returned value.',
      targets: [{ path: 'src/main.ts', range: '3-5' }], task: { epoch: 'new', profile: 'answer' }, budget: { tokens: 5000 } };
    const hops: Array<Record<string, any>> = []; let delivered = '';
    for (let hop = 0; hop < 5 && arguments_; hop++) {
      const response = await withEngineConfiguration(config, () => callTool('tl_read_file', arguments_!));
      const part = response.content[0]; if (part?.type !== 'text') throw new Error('Expected textual MCP result.');
      const result = JSON.parse(part.text); hops.push(result);
      delivered += '\n' + (result.evidence ?? []).map((entry: { body?: string }) => entry.body ?? '').join('\n');
      if (result.decision?.kind === 'act.answer') expect(delivered, JSON.stringify(hops)).toContain('ACTUAL_ALIAS_BODY');
      const next = result.decision?.next ?? result.next ?? result.limit?.next;
      arguments_ = next?.tool === 'tl_read_file' ? next.arguments : undefined;
    }
    expect(hops.at(-1)?.decision?.kind, JSON.stringify(hops)).toBe('act.answer');
    expect(delivered).toContain('ACTUAL_ALIAS_BODY');
  }, 30000);
});


describe('finite typed callee discovery does not become a lexical proof', () => {
  it('public five-call receiver evidence discloses its budget instead of certifying a fifth local homonym', async () => {
    const names = ['first', 'second', 'third', 'fourth', 'fifth'];
    const source = 'import { GoodClient } from "./good.js";\n'
      + names.map(name => 'function ' + name + '() { return "WRONG_' + name + '"; }').join('\n')
      + '\nexport function retrySummary(client: GoodClient): string {\n return '
      + names.map(name => 'client.' + name + '()').join(' + ') + ';\n}\n';
    const good = 'export class GoodClient {\n'
      + names.map(name => ' ' + name + '(): string { return "ACTUAL_' + name + '"; }').join('\n') + '\n}\n';
    const root = workspace({ 'src/main.ts': source, 'src/good.ts': good });
    const config = typedConfiguration(); config.compoundRequests.enabled = false;
    let arguments_: Record<string, unknown> | undefined = { cwd: root,
      query: 'What exact value does retrySummary return and why? Cite the functions that determine the returned value.',
      targets: [{ path: 'src/main.ts', range: '7-9' }], task: { epoch: 'new', profile: 'answer' }, budget: { tokens: 8000 } };
    const hops: Array<Record<string, any>> = []; let delivered = '';
    for (let hop = 0; hop < 5 && arguments_; hop++) {
      const response = await withEngineConfiguration(config, () => callTool('tl_read_file', arguments_!));
      const part = response.content[0]; if (part?.type !== 'text') throw new Error('Expected textual MCP result.');
      const result = JSON.parse(part.text); hops.push(result);
      delivered += '\n' + (result.evidence ?? []).map((entry: { body?: string }) => entry.body ?? '').join('\n');
      if (result.decision?.kind === 'act.answer' && !names.every(name => delivered.includes('ACTUAL_' + name))) {
        expect(result.decision.certificate.gaps, JSON.stringify(hops)).toEqual(expect.arrayContaining([
          expect.stringMatching(/request-item-undetermined:value:retrySummary/),
        ]));
      }
      const next = result.decision?.next ?? result.next ?? result.limit?.next;
      arguments_ = next?.tool === 'tl_read_file' ? next.arguments : undefined;
    }
    expect(arguments_, JSON.stringify(hops)).toBeUndefined();
    expect(delivered).not.toContain('WRONG_fifth');
    expect(JSON.stringify(hops)).not.toContain('request-item-absent:typed-pack-budget');
  }, 30000);
});


describe('explicit own receiver aliases stay unfinished without typed resolution', () => {
  it('public OFF alias call retains an unknown disclosure instead of an unsupported value certificate', async () => {
    const source = 'import { actualRetry } from "./good.js";\nconst client = { retry: actualRetry };\nexport function retrySummary(): string {\n  return client.retry();\n}\n';
    const root = workspace({ 'src/main.ts': source, 'src/good.ts': 'export function actualRetry(): string { return "OFF_ACTUAL_BODY"; }\n' });
    const config = typedConfiguration(); config.compoundRequests.enabled = false; config.typedSymbols.enabled = false;
    let arguments_: Record<string, unknown> | undefined = { cwd: root,
      query: 'What exact value does retrySummary return and why? Cite the functions that determine the returned value.',
      targets: [{ path: 'src/main.ts', range: '3-5' }], task: { epoch: 'new', profile: 'answer' }, budget: { tokens: 5000 } };
    const hops: Array<Record<string, any>> = []; let delivered = '';
    for (let hop = 0; hop < 5 && arguments_; hop++) {
      const response = await withEngineConfiguration(config, () => callTool('tl_read_file', arguments_!));
      const part = response.content[0]; if (part?.type !== 'text') throw new Error('Expected textual MCP result.');
      const result = JSON.parse(part.text); hops.push(result);
      delivered += '\n' + (result.evidence ?? []).map((entry: { body?: string }) => entry.body ?? '').join('\n');
      if (result.decision?.kind === 'act.answer' && !delivered.includes('OFF_ACTUAL_BODY')) {
        expect(result.decision.certificate.gaps, JSON.stringify(hops)).toEqual(expect.arrayContaining([
          expect.stringMatching(/request-item-undetermined:value:retrySummary/),
        ]));
      }
      const next = result.decision?.next ?? result.next ?? result.limit?.next;
      arguments_ = next?.tool === 'tl_read_file' ? next.arguments : undefined;
    }
    expect(arguments_, JSON.stringify(hops)).toBeUndefined();
    expect(JSON.stringify(hops)).not.toContain('request-item-absent:actualRetry');
  }, 30000);
});


describe('external namespaces preserve bounded typed discovery', () => {
  it.each(['node:https', 'platform-sdk'])('public constants behind five external %s calls retain closure', async specifier => {
    const source = 'import * as platform from "' + specifier + '";\n'
      + 'const REPORT_LIMIT = 7;\nexport function reportSummary(): number {\n'
      + ['first', 'second', 'third', 'fourth', 'fifth'].map(name => '  platform.' + name + '();').join('\n')
      + '\n  return REPORT_LIMIT;\n}\n';
    const root = workspace({ 'src/main.ts': source });
    const config = typedConfiguration(); config.compoundRequests.enabled = false;
    // This checks the workspace-body count, using real compiler probes.
    // Keep that count assertion independent of cold compiler speed on CI;
    // typedCalleeBudget.spec.ts separately verifies the shared time bound.
    // AbortSignal deadlines and the per-test timeout still use real timers.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      let arguments_: Record<string, unknown> | undefined = { cwd: root,
        query: 'What is the value of REPORT_LIMIT used by reportSummary?',
        targets: [{ path: 'src/main.ts', range: '3-10' }], task: { epoch: 'new', profile: 'answer' }, budget: { tokens: 5000 } };
      const hops: Array<Record<string, any>> = []; let delivered = '';
      for (let hop = 0; hop < 5 && arguments_; hop++) {
        const response = await withEngineConfiguration(config, () => callTool('tl_read_file', arguments_!));
        const part = response.content[0]; if (part?.type !== 'text') throw new Error('Expected textual MCP result.');
        const result = JSON.parse(part.text); hops.push(result);
        delivered += '\n' + (result.evidence ?? []).map((entry: { body?: string }) => entry.body ?? '').join('\n');
        if (result.decision?.kind === 'act.answer') expect(result.decision.certificate.gaps, JSON.stringify(hops)).toBeUndefined();
        const next = result.decision?.next ?? result.next ?? result.limit?.next;
        arguments_ = next?.tool === 'tl_read_file' ? next.arguments : undefined;
      }
      expect(hops.at(-1)?.decision?.kind, JSON.stringify(hops)).toBe('act.answer');
      expect(delivered).toContain('const REPORT_LIMIT = 7');
    } finally { clock.mockRestore(); }
  }, 30000);
  it('does not treat a parameter shadowing an imported namespace as external', async () => {
    const source = 'import * as platform from "platform-sdk";\nimport { GoodClient } from "./good.js";\n'
      + 'export function retrySummary(platform: GoodClient): string { return platform.retry(); }\n';
    const root = workspace({ 'src/main.ts': source, 'src/good.ts': 'export class GoodClient { retry(): string { return "SHADOWED_RECEIVER_BODY"; } }\n' });
    const config = typedConfiguration(); config.compoundRequests.enabled = false;
    const response = await withEngineConfiguration(config, () => callTool('tl_read_file', { cwd: root,
      query: 'What exact value does retrySummary return?', targets: [{ path: 'src/main.ts', range: '3-3' }],
      task: { epoch: 'new', profile: 'answer' }, budget: { tokens: 5000 } }));
    const result = JSON.parse(response.content[0]!.text as string);
    const next = result.decision?.next;
    let delivered = (result.evidence ?? []).map((entry: { body?: string }) => entry.body ?? '').join('\n');
    if (next?.tool === 'tl_read_file') {
      const follow = await withEngineConfiguration(config, () => callTool(next.tool, next.arguments));
      delivered += '\n' + (JSON.parse(follow.content[0]!.text as string).evidence ?? []).map((entry: { body?: string }) => entry.body ?? '').join('\n');
    }
    expect(delivered).toContain('SHADOWED_RECEIVER_BODY');
  }, 30000);
});


describe('external namespace shortcuts preserve destructured receiver ownership', () => {
  it.each(['local', 'parameter'])('resolves a %s destructured shadow to its actual callable body', async binding => {
    const source = 'import * as platform from "platform-sdk";\nimport { GoodClient } from "./good.js";\n'
      + (binding === 'local'
        ? 'export function retrySummary(holder: { platform: GoodClient }): string {\n  const { platform } = holder;\n  return platform.retry();\n}\n'
        : 'export function retrySummary({ platform }: { platform: GoodClient }): string {\n  return platform.retry();\n}\n');
    const root = workspace({ 'src/main.ts': source,
      'src/good.ts': 'export class GoodClient {\n  retry(): string { return "DESTRUCTURED_RECEIVER_BODY"; }\n}\n' });
    const config = typedConfiguration(); config.compoundRequests.enabled = false;
    let arguments_: Record<string, unknown> | undefined = { cwd: root,
      query: 'What exact value does retrySummary return?', targets: [{ path: 'src/main.ts', range: '3-6' }],
      task: { epoch: 'new', profile: 'answer' }, budget: { tokens: 5000 } };
    const hops: Array<Record<string, any>> = []; let delivered = '';
    for (let hop = 0; hop < 5 && arguments_; hop++) {
      const response = await withEngineConfiguration(config, () => callTool('tl_read_file', arguments_!));
      const part = response.content[0]; if (part?.type !== 'text') throw new Error('Expected textual MCP result.');
      const result = JSON.parse(part.text); hops.push(result);
      delivered += '\n' + (result.evidence ?? []).map((entry: { body?: string }) => entry.body ?? '').join('\n');
      const next = result.decision?.next ?? result.next ?? result.limit?.next;
      arguments_ = next?.tool === 'tl_read_file' ? next.arguments : undefined;
    }
    expect(hops.at(-1)?.decision?.kind, JSON.stringify(hops)).toBe('act.answer');
    expect(delivered).toContain('DESTRUCTURED_RECEIVER_BODY');
  }, 30000);
});
