import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { typedSymbolLanguage } from './languageServers.js';
import {
  ResolutionFailure, assertFresh, boundedNumber, checkCancelled, readInside, uniqueLocations, validRange,
  type LanguageServerCommand, type SourceSnapshot, type SymbolRange, type SymbolRelation,
  type TypedSymbolGap, type TypedSymbolLocation, type TypedSymbolRequest,
} from './common.js';

const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_HEADER_BYTES = 8192;
const MAX_ACTIVE_SESSIONS = 4;
let activeSessions = 0;
interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanup: () => void;
}
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

/** A fresh read-only JSON-RPC session; no process or document state crosses requests. */
class StdioSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private failure?: Error;
  private closing = false;
  private readonly exited: Promise<void>;
  constructor(command: LanguageServerCommand, private readonly root: string) {
    if (!command.command || command.command.includes('\0') || command.args?.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new ResolutionFailure('invalid-server', 'Language server command is invalid.');
    this.child = spawn(command.command, [...(command.args ?? [])], { cwd: root, shell: false, stdio: 'pipe', windowsHide: true, detached: process.platform !== 'win32' });
    this.exited = new Promise(resolve => this.child.once('close', () => resolve()));
    this.child.stdout.on('data', (data: Buffer) => this.receive(data));
    // Drain bounded-memory stderr, without exposing server logs as source evidence.
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', error => this.fail(new ResolutionFailure('server-io', error.message)));
    this.child.on('error', error => this.fail(new ResolutionFailure('server-unavailable', error.message)));
    this.child.on('exit', () => { if (!this.closing) this.fail(new ResolutionFailure('server-exited', 'Language server exited before resolution completed.')); });
    this.configuration = command.configuration;
  }
  private readonly configuration: unknown;
  private send(message: object): void {
    if (this.failure) throw this.failure;
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    if (body.length > MAX_FRAME_BYTES) throw new ResolutionFailure('protocol-limit', 'Language server message exceeds the size limit.');
    this.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  }
  notify(method: string, params: unknown): void { this.send({ jsonrpc: '2.0', method, params }); }
  request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    checkCancelled(signal);
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const cancel = (code: string, message: string): void => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.cleanup();
        try { this.notify('$/cancelRequest', { id }); } catch { /* Process may have exited. */ }
        reject(new ResolutionFailure(code, message));
      };
      const abort = (): void => cancel('cancelled', 'Typed symbol resolution was cancelled.');
      const timer = setTimeout(() => cancel('timeout', `Language server ${method} request timed out.`), timeoutMs);
      const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      this.pending.set(id, { resolve, reject, timer, cleanup });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      try { this.send({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { this.pending.delete(id); cleanup(); reject(error); }
    });
  }
  private fail(error: Error): void {
    this.failure ??= error;
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(error); }
    this.pending.clear();
    this.buffer = Buffer.alloc(0);
  }
  private receive(data: Buffer): void {
    if (this.failure) return;
    this.buffer = Buffer.concat([this.buffer, data]);
    if (this.buffer.length > MAX_FRAME_BYTES + MAX_HEADER_BYTES) { this.fail(new ResolutionFailure('protocol-limit', 'Language server frame exceeds the size limit.')); return; }
    while (this.buffer.length > 0) {
      const separator = this.buffer.indexOf('\r\n\r\n');
      if (separator < 0) {
        if (this.buffer.length > MAX_HEADER_BYTES) this.fail(new ResolutionFailure('protocol-error', 'Invalid language server frame header.'));
        return;
      }
      if (separator > MAX_HEADER_BYTES) { this.fail(new ResolutionFailure('protocol-error', 'Language server frame header is too large.')); return; }
      const headers = this.buffer.subarray(0, separator).toString('ascii').split('\r\n');
      const lengths = headers.filter(header => /^content-length:/i.test(header));
      const length = lengths.length === 1 && /^content-length:\s*\d+\s*$/i.test(lengths[0]!) ? Number(lengths[0]!.split(':')[1]) : NaN;
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_FRAME_BYTES) { this.fail(new ResolutionFailure('protocol-error', 'Invalid language server Content-Length.')); return; }
      const end = separator + 4 + length;
      if (this.buffer.length < end) return;
      let message: unknown;
      try { message = JSON.parse(this.buffer.subarray(separator + 4, end).toString('utf8')); }
      catch { this.fail(new ResolutionFailure('protocol-error', 'Language server returned invalid JSON.')); return; }
      this.buffer = this.buffer.subarray(end);
      if (!object(message) || message.jsonrpc !== '2.0') { this.fail(new ResolutionFailure('protocol-error', 'Invalid language server JSON-RPC message.')); return; }
      if (typeof message.method === 'string') {
        if (message.id !== undefined) {
          // Server-initiated requests run in a stream callback, outside the
          // awaiting resolver's exception boundary. Fail this session when a
          // response cannot be sent (for example an oversized configuration
          // result), so cleanup runs without terminating the MCP process.
          try { this.serverRequest(message); }
          catch (error) {
            this.fail(error instanceof ResolutionFailure ? error
              : new ResolutionFailure('protocol-error', 'Language server request could not be answered.'));
            return;
          }
        }
        continue;
      }
      const pending = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
      if (!pending) continue; // A cancelled response may arrive late.
      this.pending.delete(message.id as number);
      pending.cleanup();
      if (message.error !== undefined) {
        const error = object(message.error) ? message.error : {};
        pending.reject(new ResolutionFailure(error.code === -32800 ? 'cancelled' : 'server-error', typeof error.message === 'string' ? error.message.slice(0, 500) : 'Language server request failed.'));
      } else if ('result' in message) pending.resolve(message.result);
      else pending.reject(new ResolutionFailure('protocol-error', 'Language server response has no result.'));
    }
  }
  private serverRequest(message: Record<string, unknown>): void {
    let result: unknown;
    switch (message.method) {
      case 'workspace/configuration': {
        const items = object(message.params) && Array.isArray(message.params.items) ? message.params.items : [];
        result = items.map(item => {
          let value = this.configuration;
          if (object(item) && typeof item.section === 'string' && item.section) {
            for (const key of item.section.split('.')) value = object(value) ? value[key] : undefined;
          }
          return value ?? null;
        });
        break;
      }
      case 'workspace/workspaceFolders': result = [{ uri: pathToFileURL(this.root).href, name: 'workspace' }]; break;
      case 'workspace/applyEdit': result = { applied: false, failureReason: 'Typed symbol resolution is read-only.' }; break;
      case 'window/showMessageRequest': result = null; break;
      default:
        this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Client method is unsupported.' } });
        return;
    }
    this.send({ jsonrpc: '2.0', id: message.id, result });
  }
  async close(): Promise<void> {
    this.closing = true;
    if (!this.failure && this.child.exitCode === null) {
      try { await this.request('shutdown', null, 150); this.notify('exit', null); } catch { /* Kill a hung or failed server. */ }
    }
    this.fail(new ResolutionFailure('server-closed', 'Language server session closed.'));
    this.child.stdin.end();
    await Promise.race([this.exited, new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        if (process.platform === 'win32' && this.child.pid !== undefined) {
          // Keep the launcher alive until taskkill has identified its children.
          const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
          execFile(taskkill, ['/PID', String(this.child.pid), '/T', '/F'], { timeout: 300, windowsHide: true }, () => { this.child.kill('SIGKILL'); resolve(); });
        } else { this.child.kill('SIGKILL'); resolve(); }
      }, 150);
      this.exited.then(() => { clearTimeout(timer); resolve(); });
    })]);
    // Servers such as jdtls launch a runtime child. A fresh POSIX process group
    // lets cancellation/cleanup also terminate descendants of the launcher.
    if (process.platform !== 'win32' && this.child.pid !== undefined) {
      try { process.kill(-this.child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
    }
  }
}

function supports(capabilities: Record<string, unknown>, relation: SymbolRelation): boolean {
  const capability = capabilities[`${relation === 'references' ? 'references' : relation}Provider`];
  return capability === true || object(capability);
}
function rawLocations(value: unknown): Array<{ uri: string; range: SymbolRange; selectionRange?: SymbolRange }> {
  if (value === null) return [];
  const items = Array.isArray(value) ? value : [value];
  return items.map(item => {
    if (!object(item)) throw new ResolutionFailure('protocol-error', 'Language server returned an invalid source location.');
    const uri = item.targetUri ?? item.uri;
    const range = item.targetRange ?? item.range;
    if (typeof uri !== 'string' || !object(range)) throw new ResolutionFailure('protocol-error', 'Language server returned an invalid source location.');
    if (item.targetUri !== undefined && !object(item.targetSelectionRange)) throw new ResolutionFailure('protocol-error', 'Language server LocationLink has no selection range.');
    return { uri, range: range as unknown as SymbolRange, ...(item.targetSelectionRange ? { selectionRange: item.targetSelectionRange as SymbolRange } : {}) };
  });
}
function uriPath(uri: string): string {
  try {
    const url = new URL(uri);
    if (url.protocol !== 'file:' || url.search || url.hash || (url.hostname && url.hostname !== 'localhost')) throw new Error();
    return fileURLToPath(url);
  } catch { throw new ResolutionFailure('outside-root', 'Language server location is not a local workspace file URI.'); }
}

export async function resolveWithLsp(request: TypedSymbolRequest, root: string, source: SourceSnapshot, language: string, command: LanguageServerCommand): Promise<{ locations: TypedSymbolLocation[]; gaps: TypedSymbolGap[] }> {
  if (activeSessions >= MAX_ACTIVE_SESSIONS) throw new ResolutionFailure('server-busy', 'The bounded language server session pool is full.');
  activeSessions++;
  let session: StdioSession | undefined;
  try {
    session = new StdioSession(command, root);
    const startup = boundedNumber(request.startupTimeoutMs, 5000, 30000);
    const timeout = boundedNumber(request.timeoutMs, 5000, 30000);
    const expires = Date.now() + startup + timeout;
    const remaining = (): number => {
      checkCancelled(request.signal);
      if (Date.now() >= expires) throw new ResolutionFailure('timeout', 'Typed symbol resolution exceeded its time budget.');
      return Math.max(1, Math.min(timeout, expires - Date.now()));
    };
    const initialized = await session.request('initialize', {
      processId: process.pid, clientInfo: { name: 'TokenLighten', version: '0.16' },
      rootUri: pathToFileURL(root).href, workspaceFolders: [{ uri: pathToFileURL(root).href, name: 'workspace' }],
      capabilities: {
        general: { positionEncodings: ['utf-16'] },
        workspace: { configuration: true, workspaceFolders: true, applyEdit: false },
        textDocument: { synchronization: { dynamicRegistration: false }, definition: { linkSupport: true }, typeDefinition: { linkSupport: true }, references: { dynamicRegistration: false } },
      }, initializationOptions: command.initializationOptions ?? null,
    }, startup, request.signal);
    if (!object(initialized) || !object(initialized.capabilities)) throw new ResolutionFailure('protocol-error', 'Language server initialize response has no capabilities.');
    const capabilities = initialized.capabilities;
    if (capabilities.positionEncoding !== undefined && capabilities.positionEncoding !== 'utf-16') throw new ResolutionFailure('unsupported-encoding', 'Language server does not use UTF-16 source positions.');
    session.notify('initialized', {});
    const sync = capabilities.textDocumentSync;
    const openClose = typeof sync === 'number' ? sync > 0 : object(sync) && sync.openClose === true;
    if (!openClose) throw new ResolutionFailure('sync-unavailable', 'Language server cannot synchronize source content for verified resolution.');
    if (command.configuration !== undefined) session.notify('workspace/didChangeConfiguration', { settings: command.configuration });
    const snapshots = new Map<string, SourceSnapshot>([[source.absolute, source]]);
    const openDocument = (snapshot: SourceSnapshot): void => session!.notify('textDocument/didOpen', {
      textDocument: { uri: pathToFileURL(snapshot.absolute).href, languageId: typedSymbolLanguage(snapshot.relative) === 'unsupported' ? language : typedSymbolLanguage(snapshot.relative), version: 1, text: snapshot.text },
    });
    openDocument(source);
    const gaps: TypedSymbolGap[] = [];
    const relations = request.relations ?? ['definition', 'typeDefinition'];
    const supported = relations.filter(relation => {
      if (supports(capabilities, relation)) return true;
      gaps.push({ code: 'relation-unavailable', relation, message: `Language server does not support ${relation}.` });
      return false;
    });
    const maxLocations = boundedNumber(request.maxLocations, 64, 256);
    // Synchronize discovered targets, then repeat queries so final coordinates
    // refer to those exact bytes rather than an old server-side disk snapshot.
    let locations: TypedSymbolLocation[] = [];
    for (let pass = 0; pass < 2; pass++) {
      const collected: TypedSymbolLocation[] = [];
      for (const relation of supported) {
        const params = { textDocument: { uri: pathToFileURL(source.absolute).href }, position: request.position, ...(relation === 'references' ? { context: { includeDeclaration: true } } : {}) };
        const response = rawLocations(await session.request(`textDocument/${relation}`, params, remaining(), request.signal));
        if (response.length > maxLocations) gaps.push({ code: 'location-limit', relation, message: 'Language server result exceeded the location budget.' });
        for (const item of response.slice(0, maxLocations)) {
          if (collected.length >= maxLocations) { gaps.push({ code: 'location-limit', relation, message: 'Language server results exceeded the total location budget.' }); break; }
          try {
            const snapshot = await readInside(root, uriPath(item.uri));
            if (pass === 1 && !snapshots.has(snapshot.absolute)) {
              gaps.push({ code: 'unstable-target', relation, message: 'Language server returned a new unsynchronized target on its verification pass.' });
              continue;
            }
            const previous = snapshots.get(snapshot.absolute);
            if (previous && previous.hash !== snapshot.hash) throw new ResolutionFailure('stale-source', 'Source changed during typed symbol resolution.');
            if (!validRange(snapshot.text, item.range)) throw new ResolutionFailure('invalid-range', 'Language server source range is invalid for current content.');
            if (item.selectionRange && !validRange(snapshot.text, item.selectionRange)) throw new ResolutionFailure('invalid-range', 'Language server symbol selection range is invalid for current content.');
            if (!previous) { snapshots.set(snapshot.absolute, snapshot); openDocument(snapshot); }
            collected.push({ path: snapshot.relative, range: item.range, ...(item.selectionRange ? { selectionRange: item.selectionRange } : {}), relation, contentHash: snapshot.hash });
          } catch (error) {
            if (error instanceof ResolutionFailure && error.code === 'stale-source') throw error;
            gaps.push({ code: error instanceof ResolutionFailure ? error.code : 'source-unavailable', relation, message: error instanceof Error ? error.message : 'Source location could not be verified.' });
          }
        }
      }
      locations = uniqueLocations(collected);
    }
    remaining();
    await assertFresh(root, [...snapshots.values()]);
    checkCancelled(request.signal);
    for (const snapshot of snapshots.values()) session.notify('textDocument/didClose', { textDocument: { uri: pathToFileURL(snapshot.absolute).href } });
    return { locations, gaps };
  } finally {
    try { await session?.close(); } finally { activeSessions--; }
  }
}
