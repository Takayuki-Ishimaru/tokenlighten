import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MULTILINGUAL_E5_MODEL, E5_MIT_NOTICE } from '@tokenlighten/types';
import { runEngines, runModels } from '../commands/engines.js';

const mocks = vi.hoisted(() => ({ resolvePath: vi.fn(), resolveSymbols: vi.fn(), modelStatus: vi.fn(), prepare: vi.fn() }));
// Only CLI lazy subpaths are redirected to current source; no dist build or
// model runtime is required, and normal Node package resolution stays intact.
vi.mock('node:module', async importOriginal => {
  const original = await importOriginal<typeof import('node:module')>();
  return { ...original, createRequire: (filename: Parameters<typeof original.createRequire>[0]) => {
    const actual = original.createRequire(filename);
    const resolve = ((specifier: string, options?: { paths?: string[] }) => mocks.resolvePath(specifier) ?? actual.resolve(specifier, options)) as typeof actual.resolve;
    resolve.paths = actual.resolve.paths;
    return Object.assign(actual, { resolve });
  } };
});
vi.mock('../../../mcp-server/src/features/typed-symbols/index.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('@tokenlighten/mcp-server/typed-symbols')>();
  return { default: { ...actual, resolveTypedSymbols: mocks.resolveSymbols } };
});
vi.mock('../../../mcp-server/src/features/semantic-search/index.ts', () => ({ default: {
  readSemanticModelStatus: mocks.modelStatus, prepareSemanticModel: mocks.prepare,
} }));

// Dynamic source loading keeps CLI's rootDir scoped to its package; the type
// contract comes from the published MCP subpath declarations.
const configSource = fileURLToPath(new URL('../../../mcp-server/src/features/engines/config.ts', import.meta.url));
const { readEngineConfiguration, writeEngineConfiguration, defaultEngineConfiguration } = await import(configSource) as typeof import('@tokenlighten/mcp-server/engines');

let root: string;
let settings: string;
let printed: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tl-cli-engines-'));
  settings = join(root, 'user settings', 'engines.json');
  vi.stubEnv('TOKENLIGHTEN_ENGINES_FILE', settings);
  printed = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    printed += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write);
  const paths = {
    engines: fileURLToPath(new URL('../../../mcp-server/src/features/engines/config.ts', import.meta.url)),
    'typed-symbols': fileURLToPath(new URL('../../../mcp-server/src/features/typed-symbols/index.ts', import.meta.url)),
    'semantic-search': fileURLToPath(new URL('../../../mcp-server/src/features/semantic-search/index.ts', import.meta.url)),
  };
  mocks.resolvePath.mockReset().mockImplementation((specifier: string) => {
    const entry = specifier.replace('@tokenlighten/mcp-server/', '');
    return paths[entry as keyof typeof paths];
  });
  mocks.resolveSymbols.mockReset().mockResolvedValue({ status: 'unavailable', backend: 'none', language: 'python', semantic: true, locations: [], gaps: [] });
  mocks.modelStatus.mockReset().mockResolvedValue({ status: 'missing', modelId: MULTILINGUAL_E5_MODEL.id });
  mocks.prepare.mockReset().mockResolvedValue({ status: 'ready', modelId: MULTILINGUAL_E5_MODEL.id });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

function seed(): ReturnType<typeof readEngineConfiguration> {
  const config = defaultEngineConfiguration();
  config.semanticSearch.cacheDir = join(root, 'models with spaces');
  config.typedSymbols.servers.go = { command: '/usr/bin/gopls', args: ['serve'] };
  writeEngineConfiguration(config);
  return config;
}

describe('CLI local analysis engines and model lifecycle', () => {
  it.each([['set', 'semanticSearch', 'on'], ['server', 'py', 'pyright-langserver'], ['discovery', 'on']])('refuses to overwrite malformed user settings: %j', async (...args) => {
    seed();
    const original = readFileSync(settings, 'utf8').slice(0, -3);
    writeFileSync(settings, original);
    await expect(runEngines(args)).rejects.toThrow('existing settings were preserved');
    expect(readFileSync(settings, 'utf8')).toBe(original);
  });
  it('does not activate a model after cancellation even if preparation returns ready', async () => {
    seed(); const original = readFileSync(settings, 'utf8');
    const once = vi.spyOn(process, 'once');
    mocks.prepare.mockImplementation(async () => {
      once.mock.calls.find(call => call[0] === 'SIGTERM')![1]();
      return { status: 'ready' };
    });
    await expect(runModels(['install'])).rejects.toThrow();
    expect(readFileSync(settings, 'utf8')).toBe(original);
  });
  it('rejects model installation before downloading when user settings are malformed', async () => {
    seed(); const original = readFileSync(settings, 'utf8').slice(0, -3);
    writeFileSync(settings, original);
    await expect(runModels(['install'])).rejects.toThrow('existing settings were preserved');
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(readFileSync(settings, 'utf8')).toBe(original);
  });
  it('shows user-scoped defaults and all supported languages without creating settings', async () => {
    await runEngines(['status', '--json']);
    const status = JSON.parse(printed);
    expect(status.configFile).toBe(settings);
    expect(status.config.typedSymbols).toEqual({ enabled: false, discoverServers: false, servers: {} });
    expect(status.config.semanticSearch.enabled).toBe(false);
    expect(status.languages).toEqual(expect.arrayContaining(['typescript', 'javascript', 'python', 'go', 'rust', 'java', 'c', 'cpp', 'csharp', 'kotlin', 'php', 'ruby']));
    expect(existsSync(settings)).toBe(false);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('updates only selected engines and discovery and preserves server argument arrays with spaces', async () => {
    seed();
    await runEngines(['set', 'typedSymbols', 'off']);
    await runEngines(['set', 'compoundRequests', 'off']);
    await runEngines(['set', 'semanticSearch', 'on']);
    await runEngines(['discovery', 'on']);
    await runEngines(['server', 'py', '/opt/Language Server/bin/python-server', '--stdio', '--config', '/tmp/config with spaces.json', 'value with spaces']);
    const config = readEngineConfiguration();
    expect(config.typedSymbols.enabled).toBe(false);
    expect(config.compoundRequests.enabled).toBe(false);
    expect(config.semanticSearch.enabled).toBe(true);
    expect(config.semanticSearch.cacheDir).toBe(join(root, 'models with spaces'));
    expect(config.typedSymbols.discoverServers).toBe(true);
    expect(config.typedSymbols.servers.py).toEqual({ command: '/opt/Language Server/bin/python-server', args: ['--stdio', '--config', '/tmp/config with spaces.json', 'value with spaces'] });
    expect(config.typedSymbols.servers.go).toEqual({ command: '/usr/bin/gopls', args: ['serve'] });
  });

  it.each([['ts', 'typescript'], ['js', 'javascript']])('registers and resolves a custom %s server', async (lang, language) => {
    seed();
    const server = { command: '/opt/Language Server/bin/typescript-language-server', args: ['--stdio', '--config', '/tmp/config with spaces.json'] };
    await runEngines(['server', lang, server.command, ...server.args]);
    expect(readEngineConfiguration().typedSymbols.servers[lang]).toEqual(server);
    expect(readEngineConfiguration().typedSymbols.servers.go).toEqual({ command: '/usr/bin/gopls', args: ['serve'] });
    await runEngines(['resolve', `main.${lang}`, '0', '1', '--cwd', root]);
    expect(mocks.resolveSymbols).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ servers: expect.objectContaining({ [language]: server }) }));
  });

  it.each([
    ['unknown-command'], ['set', 'unknown-engine', 'on'], ['set', 'typedSymbols', 'invalid'], ['discovery', 'invalid'],
    ['server', 'unknown', 'server'], ['server', 'py', ' '], ['server', 'py', 'x'.repeat(4097)],
    ['server', 'py', 'server', ...Array.from({ length: 65 }, () => 'argument')], ['server', 'py', 'server', 'x'.repeat(4097)],
    ['resolve', 'main.py', '-1', '0'], ['resolve', 'main.py', '0', '0', '--cwd'],
  ])('rejects malformed commands without modifying settings: %j', async (...arguments_) => {
    seed();
    const before = readFileSync(settings, 'utf8');
    await expect(runEngines(arguments_)).rejects.toThrow();
    expect(readFileSync(settings, 'utf8')).toBe(before);
    expect(mocks.resolveSymbols).not.toHaveBeenCalled();
  });

  it('provides engine/model help and complete model notices without loading runtime modules', async () => {
    await runEngines(['--help']);
    await runModels(['--help']);
    expect(printed).toContain('tl models install');
    expect(printed).toContain('server <ts|js|py|');
    expect(mocks.resolvePath).not.toHaveBeenCalled();
    printed = '';
    await runModels(['licenses', '--json']);
    expect(JSON.parse(printed)).toEqual([expect.objectContaining({ id: MULTILINGUAL_E5_MODEL.id, revision: MULTILINGUAL_E5_MODEL.revision, licenseText: E5_MIT_NOTICE })]);
    expect(mocks.resolvePath).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(existsSync(settings)).toBe(false);
  });

  it('lists offline model status from the configured user cache', async () => {
    seed();
    await runModels(['list', '--json']);
    expect(mocks.modelStatus).toHaveBeenCalledExactlyOnceWith({ cacheDir: join(root, 'models with spaces') });
    expect(JSON.parse(printed)).toEqual(expect.objectContaining({ status: 'missing', enabled: false, model: expect.objectContaining({ id: MULTILINGUAL_E5_MODEL.id }) }));
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('rejects unknown model actions without modifying user settings', async () => {
    seed();
    const before = readFileSync(settings, 'utf8');
    await expect(runModels(['unknown-action'])).rejects.toThrow('Unknown models command');
    expect(readFileSync(settings, 'utf8')).toBe(before);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('preserves settings changed while model preparation runs', async () => {
    seed();
    mocks.prepare.mockImplementation(async () => {
      const latest = readEngineConfiguration();
      latest.typedSymbols.enabled = false;
      latest.typedSymbols.discoverServers = true;
      latest.compoundRequests.enabled = false;
      latest.typedSymbols.servers.py = { command: '/new/server with spaces', args: ['--stdio'], configuration: { python: { analysis: { extraPaths: ['new path'] } } } };
      writeEngineConfiguration(latest);
      return { status: 'ready' };
    });
    await runModels(['install', '--json']);
    const config = readEngineConfiguration();
    expect(config.semanticSearch.enabled).toBe(true);
    expect(config.typedSymbols.enabled).toBe(false);
    expect(config.typedSymbols.discoverServers).toBe(true);
    expect(config.compoundRequests.enabled).toBe(false);
    expect(config.typedSymbols.servers.py).toEqual(expect.objectContaining({ command: '/new/server with spaces', configuration: { python: { analysis: { extraPaths: ['new path'] } } } }));
    expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cacheDir: join(root, 'models with spaces'), allowDownload: true, signal: expect.any(AbortSignal) }));
  });

  it('refuses to enable a different cache selected during preparation', async () => {
    seed();
    let concurrentSettings = '';
    mocks.prepare.mockImplementation(async () => {
      const latest = readEngineConfiguration();
      latest.semanticSearch.cacheDir = join(root, 'different model cache');
      latest.compoundRequests.enabled = false;
      writeEngineConfiguration(latest);
      concurrentSettings = readFileSync(settings, 'utf8');
      return { status: 'ready' };
    });
    await expect(runModels(['install'])).rejects.toThrow(/Model cache changed during installation/);
    expect(readFileSync(settings, 'utf8')).toBe(concurrentSettings);
    expect(readEngineConfiguration().semanticSearch.enabled).toBe(false);
  });

  it('leaves settings unchanged when preparation is incomplete or fails', async () => {
    seed();
    const before = readFileSync(settings, 'utf8');
    mocks.prepare.mockResolvedValueOnce({ status: 'missing' });
    await expect(runModels(['install'])).rejects.toThrow(/complete local model/);
    mocks.prepare.mockRejectedValueOnce(new Error('offline download failure'));
    await expect(runModels(['install'])).rejects.toThrow('offline download failure');
    expect(readFileSync(settings, 'utf8')).toBe(before);
  });

  it.each(['SIGINT', 'SIGTERM'])('cancels model preparation on %s and removes its process signal listeners', async signalName => {
    seed();
    const before = readFileSync(settings, 'utf8');
    const baseline = { SIGINT: process.listenerCount('SIGINT'), SIGTERM: process.listenerCount('SIGTERM') };
    const once = vi.spyOn(process, 'once');
    mocks.prepare.mockImplementation(({ signal }: { signal: AbortSignal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('preparation cancelled')), { once: true });
    }));
    const pending = runModels(['install']);
    const rejected = expect(pending).rejects.toThrow('preparation cancelled');
    await vi.waitFor(() => expect(mocks.prepare).toHaveBeenCalledOnce());
    const interrupt = once.mock.calls.find(call => call[0] === signalName)?.[1];
    expect(interrupt).toBeTypeOf('function');
    interrupt!();
    await rejected;
    expect(mocks.prepare.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(process.listenerCount('SIGINT')).toBe(baseline.SIGINT);
    expect(process.listenerCount('SIGTERM')).toBe(baseline.SIGTERM);
    expect(readFileSync(settings, 'utf8')).toBe(before);
  });

  it('forwards configured aliases, UTF-16 coordinates and cancellation to the typed resolver', async () => {
    const config = seed();
    config.typedSymbols.servers.py = { command: '/pyright', args: ['--stdio'] };
    config.typedSymbols.servers.ts = { command: '/typescript-server', args: ['--stdio'] };
    writeEngineConfiguration(config);
    const baseline = { SIGINT: process.listenerCount('SIGINT'), SIGTERM: process.listenerCount('SIGTERM') };
    await runEngines(['resolve', 'main.ts', '3', '12', '--cwd', root]);
    expect(mocks.resolveSymbols).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ root, path: 'main.ts', position: { line: 3, character: 12 }, signal: expect.any(AbortSignal), servers: expect.objectContaining({ python: config.typedSymbols.servers.py, typescript: config.typedSymbols.servers.ts }) }));
    expect(process.listenerCount('SIGINT')).toBe(baseline.SIGINT);
    expect(process.listenerCount('SIGTERM')).toBe(baseline.SIGTERM);
  });

  it('cancels typed resolution on SIGTERM without changing settings or retaining listeners', async () => {
    seed();
    const before = readFileSync(settings, 'utf8');
    const baseline = { SIGINT: process.listenerCount('SIGINT'), SIGTERM: process.listenerCount('SIGTERM') };
    const once = vi.spyOn(process, 'once');
    mocks.resolveSymbols.mockImplementation(({ signal }: { signal: AbortSignal }) => new Promise(resolve => {
      signal.addEventListener('abort', () => resolve({ status: 'cancelled', locations: [], gaps: [] }), { once: true });
    }));
    const pending = runEngines(['resolve', 'main.py', '0', '0']);
    await vi.waitFor(() => expect(mocks.resolveSymbols).toHaveBeenCalledOnce());
    const terminate = once.mock.calls.find(call => call[0] === 'SIGTERM')?.[1];
    expect(terminate).toBeTypeOf('function');
    terminate!();
    await pending;
    expect(JSON.parse(printed).status).toBe('cancelled');
    expect(process.listenerCount('SIGINT')).toBe(baseline.SIGINT);
    expect(process.listenerCount('SIGTERM')).toBe(baseline.SIGTERM);
    expect(readFileSync(settings, 'utf8')).toBe(before);
  });
});
