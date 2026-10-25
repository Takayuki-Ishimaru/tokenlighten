import { realpath } from 'node:fs/promises';
import {
  ResolutionFailure, checkCancelled, positionOffset, readInside,
  type TypedSymbolRequest, type TypedSymbolResolution,
} from './common.js';
import { discoverLanguageServer, typedSymbolLanguage } from './languageServers.js';
import { resolveWithLsp } from './lsp.js';
import { resolveWithTypeScript } from './typescript.js';

export type { LanguageServerCommand, SymbolPosition, SymbolRange, SymbolRelation, TypedSymbolGap, TypedSymbolLocation, TypedSymbolRequest, TypedSymbolResolution } from './common.js';
export { contentHash } from './common.js';
export { LANGUAGE_SERVER_CANDIDATES, TYPED_SYMBOL_LANGUAGES, typedSymbolLanguage } from './languageServers.js';

/** Resolve a focal token semantically and return only verified workspace source locations. */
export async function resolveTypedSymbols(request: TypedSymbolRequest): Promise<TypedSymbolResolution> {
  return resolveTypedSymbolsWithPurpose(request, false);
}

/** Internal callee closure: a call implementation is distinct from an editor definition. */
export async function resolveTypedCalleeSymbols(request: TypedSymbolRequest): Promise<TypedSymbolResolution> {
  return resolveTypedSymbolsWithPurpose(request, true);
}

async function resolveTypedSymbolsWithPurpose(request: TypedSymbolRequest, callImplementation: boolean): Promise<TypedSymbolResolution> {
  const language = typedSymbolLanguage(request.path);
  const output: TypedSymbolResolution = { status: 'unresolved', backend: 'none', language, semantic: true, locations: [], gaps: [] };
  try {
    checkCancelled(request.signal);
    const relations = request.relations ?? ['definition', 'typeDefinition'];
    if (!relations.length || relations.some(relation => !['definition', 'typeDefinition', 'references'].includes(relation))) throw new ResolutionFailure('invalid-relation', 'Typed symbol relation is invalid.');
    if (language === 'unsupported') throw new ResolutionFailure('unsupported-language', 'No typed symbol backend supports this source language.');
    const root = await realpath(request.root);
    const source = await readInside(root, request.path);
    output.sourceContentHash = source.hash;
    if (request.expectedContentHash !== undefined && request.expectedContentHash !== source.hash) throw new ResolutionFailure('stale-source', 'Focal source no longer matches the supplied content hash.');
    const offset = positionOffset(source.text, request.position);
    if (offset === undefined) throw new ResolutionFailure('invalid-position', 'Focal UTF-16 source position is invalid.');
    checkCancelled(request.signal);
    const configured = request.servers?.[language];
    let result;
    if ((language === 'typescript' || language === 'javascript') && configured === undefined) {
      output.backend = 'typescript';
      result = await resolveWithTypeScript(request, root, source, offset, callImplementation);
    } else {
      if (configured === false) throw new ResolutionFailure('server-disabled', 'This language server is disabled in user configuration.');
      const command = configured ?? (request.discoverServers ? await discoverLanguageServer(language) : undefined);
      if (!command) throw new ResolutionFailure('server-unavailable', `Configure an installed language server for ${language}, or opt into PATH discovery.`);
      output.backend = 'lsp';
      result = await resolveWithLsp({ ...request, relations: [...new Set(relations)] }, root, source, language, command);
    }
    output.locations = result.locations;
    const seen = new Set<string>();
    output.gaps = result.gaps.filter(gap => {
      const key = JSON.stringify([gap.code, gap.relation, gap.message]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 32);
    if (seen.size > 32) output.gaps.push({ code: 'gap-limit', message: 'Additional semantic gaps were omitted by the response budget.' });
    for (const relation of [...new Set(relations)]) {
      const matches = output.locations.filter(location => location.relation === relation);
      if (!matches.length && !output.gaps.some(gap => gap.relation === relation)) output.gaps.push({ code: 'symbol-unresolved', relation, message: `The semantic backend returned no ${relation} source location.` });
      if (relation !== 'references' && matches.length > 1) output.gaps.push({ code: 'ambiguous-symbol', relation, message: 'The semantic backend returned multiple declarations; no unique target is asserted.' });
    }
    output.status = output.locations.length ? (output.gaps.length ? 'partial' : 'resolved') : 'unresolved';
  } catch (error) {
    const code = error instanceof ResolutionFailure ? error.code : 'backend-error';
    output.status = code === 'cancelled' ? 'cancelled' : ['unsupported-language', 'server-unavailable', 'server-disabled', 'compiler-unavailable', 'server-busy', 'compiler-busy'].includes(code) ? 'unavailable' : 'unresolved';
    output.locations = [];
    output.gaps = [{ code, message: error instanceof Error ? error.message.slice(0, 500) : 'Typed symbol resolution failed.' }];
  }
  return output;
}
