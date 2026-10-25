import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { LanguageServerCommand } from '@tokenlighten/types';
export type { LanguageServerCommand } from '@tokenlighten/types';

// Internal engine coordinates use the LSP's zero-based UTF-16 convention.
export interface SymbolPosition { line: number; character: number }
export interface SymbolRange { start: SymbolPosition; end: SymbolPosition }
export type SymbolRelation = 'definition' | 'typeDefinition' | 'references';
export interface TypedSymbolRequest {
  root: string;
  path: string;
  position: SymbolPosition;
  relations?: readonly SymbolRelation[];
  expectedContentHash?: string;
  signal?: AbortSignal;
  /** Commands come from trusted user settings, never repository contents. */
  servers?: Readonly<Record<string, LanguageServerCommand | false>>;
  /** Opt-in PATH discovery; no installation or downloading occurs. */
  discoverServers?: boolean;
  timeoutMs?: number;
  startupTimeoutMs?: number;
  maxLocations?: number;
}
export interface TypedSymbolLocation {
  path: string;
  range: SymbolRange;
  selectionRange?: SymbolRange;
  relation: SymbolRelation;
  contentHash: string;
}
export interface TypedSymbolGap {
  code: string;
  message: string;
  relation?: SymbolRelation;
}
export interface TypedSymbolResolution {
  status: 'resolved' | 'partial' | 'unresolved' | 'unavailable' | 'cancelled';
  backend: 'typescript' | 'lsp' | 'none';
  language: string;
  locations: TypedSymbolLocation[];
  gaps: TypedSymbolGap[];
  /** This engine never upgrades textual matches into typed evidence. */
  semantic: true;
  sourceContentHash?: string;
}
export interface SourceSnapshot {
  absolute: string;
  relative: string;
  text: string;
  hash: string;
}
export const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
export const MAX_LOCATIONS = 256;

export class ResolutionFailure extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export function within(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
export function contentHash(text: string): string { return createHash('sha256').update(text).digest('hex'); }
export function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ResolutionFailure('cancelled', 'Typed symbol resolution was cancelled.');
}
export function boundedNumber(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.floor(value!))) : fallback;
}

/** not-served: analysis-only snapshot; pin source and detect escapes/replacement. */
export async function readInside(root: string, requested: string): Promise<SourceSnapshot> {
  const lexical = path.resolve(root, requested);
  // Absolute LSP URIs can use an ancestor alias (macOS /var -> /private/var).
  // Canonicalize those before checking the root, but reject relative traversal.
  if (!path.isAbsolute(requested) && !within(root, lexical)) throw new ResolutionFailure('outside-root', 'Source location leaves the workspace.');
  let absolute: string;
  try { absolute = await realpath(lexical); }
  catch { throw new ResolutionFailure('source-unavailable', 'Source file cannot be read.'); }
  if (!within(root, absolute)) throw new ResolutionFailure('outside-root', 'Source realpath leaves the workspace.');
  const file = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > MAX_SOURCE_BYTES) throw new ResolutionFailure('source-limit', 'Source is not a regular bounded file.');
    // A stat is advisory: bound the held-FD read even if the file grows.
    const buffer = Buffer.alloc(MAX_SOURCE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_SOURCE_BYTES) throw new ResolutionFailure('source-limit', 'Source grew beyond the byte budget.');
    const bytes = buffer.subarray(0, length);
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new ResolutionFailure('source-encoding', 'Source file is not valid UTF-8.'); }
    if (text.includes('\0')) throw new ResolutionFailure('source-encoding', 'Source file contains binary data.');
    const after = await file.stat();
    const binding = await stat(absolute);
    if (Buffer.byteLength(text) > MAX_SOURCE_BYTES || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || binding.dev !== after.dev || binding.ino !== after.ino || await realpath(lexical) !== absolute) {
      throw new ResolutionFailure('stale-source', 'Source changed while it was being read.');
    }
    return { absolute, relative: path.relative(root, absolute).split(path.sep).join('/'), text, hash: contentHash(text) };
  } finally { await file.close(); }
}

export function positionOffset(text: string, position: SymbolPosition): number | undefined {
  if (!Number.isSafeInteger(position?.line) || position.line < 0 || !Number.isSafeInteger(position?.character) || position.character < 0) return undefined;
  let offset = 0;
  for (let line = 0; line < position.line; line++) {
    const newline = text.indexOf('\n', offset);
    if (newline < 0) return undefined;
    offset = newline + 1;
  }
  const newline = text.indexOf('\n', offset);
  let end = newline < 0 ? text.length : newline;
  if (end > offset && text[end - 1] === '\r') end--;
  if (position.character > end - offset) return undefined;
  return offset + position.character;
}
export function validRange(text: string, range: SymbolRange): boolean {
  if (!range || !range.start || !range.end) return false;
  const start = positionOffset(text, range.start);
  const end = positionOffset(text, range.end);
  return start !== undefined && end !== undefined && end >= start;
}
export async function assertFresh(root: string, snapshots: readonly SourceSnapshot[]): Promise<void> {
  for (const previous of snapshots) {
    const current = await readInside(root, previous.relative);
    if (current.absolute !== previous.absolute || current.hash !== previous.hash) throw new ResolutionFailure('stale-source', 'Source changed during typed symbol resolution.');
  }
}
export function uniqueLocations(locations: TypedSymbolLocation[]): TypedSymbolLocation[] {
  const seen = new Set<string>();
  return locations.filter(location => {
    const key = JSON.stringify([location.path, location.range, location.relation]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
