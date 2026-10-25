import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import {
  ResolutionFailure, assertFresh, boundedNumber, checkCancelled, readInside, uniqueLocations, validRange,
  type SourceSnapshot, type SymbolRange, type SymbolRelation, type TypedSymbolGap,
  type TypedSymbolLocation, type TypedSymbolRequest,
} from './common.js';

interface CompilerOutput {
  locations: Array<{ file: string; range: SymbolRange; selectionRange?: SymbolRange; relation: SymbolRelation }>;
  files: Array<{ file: string; hash: string }>;
  gaps: TypedSymbolGap[];
  error?: { code: string; message: string };
}
let activeCompilerWorkers = 0;
const MAX_COMPILER_WORKERS = 4;

// A self-contained worker survives single-file esbuild distributions. The
// TypeScript runtime and its lib declarations remain an external dependency.
const COMPILER_WORKER = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
try {
  const ts = require(workerData.compilerPath);
  const root = workerData.root;
  const libRoot = path.dirname(workerData.compilerPath);
  const reads = new Map();
  const gaps = [];
  const MAX_FILES = 512;
  const MAX_BYTES = 16 * 1024 * 1024;
  let bytes = 0;
  const within = (base, file) => {
    const rel = path.relative(base, file);
    return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
  };
  const allowed = file => {
    try {
      const real = fs.realpathSync(file);
      return (within(root, real) || within(libRoot, real)) ? real : undefined;
    } catch { return undefined; }
  };
  const read = file => {
    const real = allowed(file);
    if (!real) return undefined;
    if (reads.has(real)) return reads.get(real).text;
    if (reads.size >= MAX_FILES) throw Object.assign(new Error('Compiler source file budget was exceeded.'), { code: 'compiler-limit' });
    const descriptor = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let text;
    try {
      const before = fs.fstatSync(descriptor);
      if (!before.isFile() || before.size > 4 * 1024 * 1024 || bytes + before.size > MAX_BYTES) throw Object.assign(new Error('Compiler source byte budget was exceeded.'), { code: 'compiler-limit' });
      // Match the server's strict UTF-8/BOM-normalized source snapshots.
      const capacity = Math.min(4 * 1024 * 1024, MAX_BYTES - bytes) + 1;
      const buffer = Buffer.alloc(capacity);
      let length = 0;
      while (length < capacity) {
        const count = fs.readSync(descriptor, buffer, length, capacity - length, length);
        if (count === 0) break;
        length += count;
      }
      if (length > 4 * 1024 * 1024 || bytes + length > MAX_BYTES) throw Object.assign(new Error('Compiler source byte budget was exceeded.'), { code: 'compiler-limit' });
      // Count raw bytes, including BOMs removed by decoding.
      bytes += length;
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
      const after = fs.fstatSync(descriptor);
      const bound = fs.statSync(real);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bound.ino !== after.ino || bound.dev !== after.dev || fs.realpathSync(file) !== real) throw Object.assign(new Error('Compiler source changed during the read.'), { code: 'stale-source' });
    } finally { fs.closeSync(descriptor); }
    reads.set(real, { text, hash: crypto.createHash('sha256').update(text).digest('hex') });
    return text;
  };
  const safeExists = file => !!allowed(file) && ts.sys.fileExists(file);
  let options = { allowJs: true, checkJs: true, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
  let roots = [workerData.source];
  const projectReferencesRequested = workerData.relations.includes('references');
  const configPath = ts.findConfigFile(path.dirname(workerData.source), file => within(root, file) && safeExists(file), 'tsconfig.json') || ts.findConfigFile(path.dirname(workerData.source), file => within(root, file) && safeExists(file), 'jsconfig.json');
  if (configPath) {
    const config = ts.readConfigFile(configPath, read);
    if (config.error) throw Object.assign(new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n')), { code: 'config-error' });
    const parsed = ts.parseJsonConfigFileContent(config.config, {
      useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
      readDirectory: (directory, extensions, excludes, includes, depth) => {
        if (!within(root, directory)) return [];
        // Definitions need the focal import graph; indexing every unrelated
        // project source would prevent bounded use in large repositories.
        if (!projectReferencesRequested) return [workerData.source];
        const files = ts.sys.readDirectory(directory, extensions, excludes, includes, depth).filter(file => within(root, file) && !!allowed(file));
        if (files.length > MAX_FILES) throw Object.assign(new Error('Compiler project exceeds the source file budget.'), { code: 'compiler-limit' });
        return files;
      }, fileExists: safeExists, readFile: read,
    }, path.dirname(configPath), { noEmit: true, skipLibCheck: true }, configPath);
    if (parsed.errors.length) throw Object.assign(new Error(ts.flattenDiagnosticMessageText(parsed.errors[0].messageText, '\n')), { code: 'config-error' });
    options = { ...parsed.options, noEmit: true, skipLibCheck: true };
    roots = projectReferencesRequested ? [...new Set([...parsed.fileNames, workerData.source])] : [workerData.source];
  }
  const host = ts.createCompilerHost(options, true);
  host.getCurrentDirectory = () => root;
  host.readFile = read;
  host.fileExists = safeExists;
  host.realpath = file => allowed(file) || file;
  host.directoryExists = directory => {
    const real = allowed(directory);
    return !!real && fs.statSync(real).isDirectory();
  };
  host.getDirectories = directory => {
    if (!allowed(directory)) return [];
    return ts.sys.getDirectories(directory).filter(child => !!allowed(path.resolve(directory, child)));
  };
  host.getSourceFile = (file, version) => {
    const text = read(file);
    return text === undefined ? undefined : ts.createSourceFile(file, text, version, true);
  };
  const program = ts.createProgram(roots, options, host);
  const source = program.getSourceFile(workerData.source);
  if (!source) throw Object.assign(new Error('Compiler cannot load the focal source.'), { code: 'source-unavailable' });
  const focalRead = reads.get(fs.realpathSync(workerData.source));
  if (!focalRead || focalRead.hash !== workerData.sourceHash) throw Object.assign(new Error('Focal source changed before compiler analysis.'), { code: 'stale-source' });
  const checker = program.getTypeChecker();
  let focal;
  const symbolToken = node => ts.isIdentifier(node) || ts.isPrivateIdentifier(node)
    || (ts.isStringLiteralLike(node) && (ts.isElementAccessExpression(node.parent) || node.parent.name === node
      || (ts.isComputedPropertyName(node.parent) && node.parent.expression === node)));
  const seek = node => {
    if (workerData.offset < node.getStart(source) || workerData.offset >= node.getEnd()) return;
    if (symbolToken(node)) focal = node;
    ts.forEachChild(node, seek);
  };
  seek(source);
  if (!focal) throw Object.assign(new Error('The focal position is not a semantic symbol token.'), { code: 'symbol-unresolved' });
  const unalias = symbol => symbol && (symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : symbol;
  const symbol = unalias(checker.getSymbolAtLocation(focal));
  if (!symbol || symbol.getName() === 'unknown') {
    // An unresolved member of an imported external namespace is still an
    // external API. Inspect the receiver's actual binding so a parameter or
    // local variable shadowing that import remains an unfinished local hop.
    if (workerData.callImplementation && ts.isPropertyAccessExpression(focal.parent) && focal.parent.name === focal) {
      const receiver = checker.getSymbolAtLocation(focal.parent.expression);
      for (const binding of receiver?.getDeclarations() || []) {
        if (!ts.isNamespaceImport(binding)) continue;
        let owner = binding.parent;
        while (owner && !ts.isImportDeclaration(owner)) owner = owner.parent;
        const specifier = owner?.moduleSpecifier;
        if (!specifier || !ts.isStringLiteralLike(specifier) || specifier.text.startsWith('.') || path.isAbsolute(specifier.text)) continue;
        const resolved = ts.resolveModuleName(specifier.text, source.fileName, options, host).resolvedModule;
        if (!resolved || !within(root, resolved.resolvedFileName) || resolved.resolvedFileName.includes(path.sep + 'node_modules' + path.sep)) {
          throw Object.assign(new Error('The member belongs to an external module namespace.'), { code: 'external-definition' });
        }
      }
    }
    throw Object.assign(new Error('The compiler cannot resolve this symbol.'), { code: 'symbol-unresolved' });
  }
  // Instantiated/generic members have transient symbols. Shorthand tokens
  // refer to both a property and its source value; preserve both identities.
  const rootsOf = current => current ? checker.getRootSymbols(unalias(current)).map(unalias) : [];
  const referenceSymbols = node => {
    const value = ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
      ? checker.getShorthandAssignmentValueSymbol(node.parent) : undefined;
    return [...rootsOf(checker.getSymbolAtLocation(node)), ...rootsOf(value)];
  };
  const referenceRoots = new Set(referenceSymbols(focal));
  const diagnostics = [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)];
  if (diagnostics.some(item => item.start !== undefined && workerData.offset >= item.start && workerData.offset < item.start + (item.length || 1))) {
    throw Object.assign(new Error('Compiler diagnostics invalidate the focal symbol.'), { code: 'semantic-error' });
  }
  if (diagnostics.length) gaps.push({ code: 'project-diagnostics', message: 'The compiler reports diagnostics elsewhere in the focal source.' });
  const locations = [];
  const add = (declaration, relation) => {
    const file = declaration.getSourceFile();
    const real = allowed(file.fileName);
    if (!real || !within(root, real) || program.isSourceFileDefaultLibrary(file)) {
      gaps.push({ code: 'external-definition', relation, message: 'A typed source location belongs to a compiler library or leaves the workspace.' });
      return;
    }
    let node = declaration.name || declaration;
    let scope = declaration;
    if (workerData.callImplementation && (ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration))) {
      let value = declaration;
      while (value.parent && (ts.isParenthesizedExpression(value.parent) || ts.isAsExpression(value.parent)
        || ts.isTypeAssertionExpression(value.parent) || ts.isSatisfiesExpression(value.parent)) && value.parent.expression === value) value = value.parent;
      const owner = value.parent;
      if (owner?.initializer === value && (ts.isVariableDeclaration(owner) || ts.isPropertyAssignment(owner) || ts.isPropertyDeclaration(owner))) {
        node = owner.name;
        scope = owner;
      }
    }
    const start = file.getLineAndCharacterOfPosition(scope.getStart(file));
    const end = file.getLineAndCharacterOfPosition(scope.getEnd());
    const selectionRange = { start: file.getLineAndCharacterOfPosition(node.getStart(file)), end: file.getLineAndCharacterOfPosition(node.getEnd()) };
    locations.push({ file: real, relation, range: { start, end }, selectionRange });
  };
  for (const relation of workerData.relations) {
    if (relation === 'definition') {
      if (workerData.callImplementation) {
        let call = focal.parent;
        while (call && !ts.isCallExpression(call)) call = call.parent;
        const signatureDeclaration = call ? checker.getResolvedSignature(call)?.declaration : undefined;
        const normalizeImplementation = declaration => {
          if (!declaration || declaration.body) return declaration;
          const owner = declaration.name && unalias(checker.getSymbolAtLocation(declaration.name));
          const bodies = (owner?.getDeclarations() || []).filter(candidate => candidate.body);
          if (bodies.length > 1) throw Object.assign(new Error('The call has multiple implementation declarations.'), { code: 'ambiguous-symbol' });
          return bodies[0] || declaration;
        };
        const bodies = (symbol.getDeclarations() || []).filter(declaration => declaration.body);
        if (bodies.length > 1) throw Object.assign(new Error('The call has multiple implementation declarations.'), { code: 'ambiguous-symbol' });
        let implementation = normalizeImplementation(signatureDeclaration);
        if (!implementation?.body) {
          if (bodies.length === 1) implementation = bodies[0];
        }
        // A synthesized union signature can select the first declaration even
        // though multiple bodies remain possible. Inspect every callable branch,
        // including unresolved/external branches, before asserting uniqueness.
        const callableType = call && checker.getTypeAtLocation(call.expression);
        if (callableType && (callableType.isUnion() || callableType.isIntersection())) {
          const candidates = new Set();
          for (const part of callableType.types) {
            const signatures = checker.getSignaturesOfType(part, ts.SignatureKind.Call);
            if (!signatures.length) throw Object.assign(new Error('A callable type branch has no verified implementation.'), { code: 'callable-body-unresolved' });
            for (const signature of signatures) {
              const candidate = normalizeImplementation(signature.declaration);
              if (!candidate) throw Object.assign(new Error('A callable type branch has no verified implementation.'), { code: 'callable-body-unresolved' });
              candidates.add(candidate);
            }
          }
          if (candidates.size > 1) throw Object.assign(new Error('The call has multiple implementation declarations.'), { code: 'ambiguous-symbol' });
          implementation = [...candidates][0];
        }
        const declarationFile = implementation?.getSourceFile();
        const real = declarationFile && allowed(declarationFile.fileName);
        // Standard-library signatures remain external, never a local homonym.
        if (implementation && (!real || !within(root, real) || program.isSourceFileDefaultLibrary(declarationFile))) {
          add(implementation, relation);
        } else {
          if (!implementation?.body) throw Object.assign(new Error('The call has no verified executable implementation body.'), { code: 'callable-body-unresolved' });
          add(implementation, relation);
        }
      } else {
        const declarations = symbol.getDeclarations() || [];
        for (const declaration of declarations) add(declaration, relation);
      }
    } else if (relation === 'typeDefinition') {
      const type = checker.getTypeAtLocation(focal);
      const types = type.isUnion() || type.isIntersection() ? type.types : [type];
      const seen = new Set();
      for (const part of types) {
        const typed = unalias(part.aliasSymbol || part.getSymbol());
        for (const declaration of typed?.getDeclarations() || []) if (!seen.has(declaration)) { seen.add(declaration); add(declaration, relation); }
      }
      if (!seen.size) gaps.push({ code: 'type-definition-unresolved', relation, message: 'This compiler type has no source declaration (for example a primitive or anonymous type).' });
    } else if (relation === 'references') {
      let visited = 0;
      const visit = node => {
        if (++visited > 200000) throw Object.assign(new Error('Compiler reference traversal exceeded its node budget.'), { code: 'compiler-limit' });
        if (symbolToken(node) && referenceSymbols(node).some(root => referenceRoots.has(root))) add(node, relation);
        if (locations.length > workerData.maxLocations) return;
        ts.forEachChild(node, visit);
      };
      for (const file of program.getSourceFiles()) {
        if (within(root, file.fileName) && !file.fileName.includes(path.sep + 'node_modules' + path.sep)) visit(file);
        if (locations.length > workerData.maxLocations) break;
      }
      if (!configPath) gaps.push({ code: 'reference-scope', relation, message: 'Without tsconfig/jsconfig, references cover the focal file and imported source graph only.' });
    }
  }
  if (locations.length > workerData.maxLocations) gaps.push({ code: 'location-limit', message: 'Compiler result exceeded the location budget.' });
  parentPort.postMessage({ locations: locations.slice(0, workerData.maxLocations), files: [...reads].filter(([file]) => within(root, file)).map(([file, value]) => ({ file, hash: value.hash })), gaps });
} catch (error) {
  parentPort.postMessage({ locations: [], files: [], gaps: [], error: { code: error.code || 'compiler-error', message: String(error.message || error).slice(0, 500) } });
}
`;

async function runCompiler(request: TypedSymbolRequest, root: string, source: SourceSnapshot, offset: number, callImplementation = false): Promise<CompilerOutput> {
  checkCancelled(request.signal);
  if (activeCompilerWorkers >= MAX_COMPILER_WORKERS) throw new ResolutionFailure('compiler-busy', 'The bounded compiler worker pool is full.');
  let compilerPath: string;
  try {
    // __filename exists in the distributed CJS bundle; import.meta.url is used in ESM source/dist.
    compilerPath = createRequire(typeof __filename === 'string' ? __filename : import.meta.url).resolve('typescript');
  } catch { throw new ResolutionFailure('compiler-unavailable', 'The TypeScript runtime is not installed.'); }
  // Parent --input-type/loader/debug flags must not change this CJS bootstrap.
  const worker = new Worker(COMPILER_WORKER, { eval: true, execArgv: [], workerData: {
    compilerPath, root, source: source.absolute, sourceHash: source.hash, offset, callImplementation,
    relations: request.relations ?? ['definition', 'typeDefinition'], maxLocations: boundedNumber(request.maxLocations, 64, 256),
  }, resourceLimits: { maxOldGenerationSizeMb: 192 } });
  activeCompilerWorkers++;
  try {
    return await new Promise<CompilerOutput>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new ResolutionFailure('timeout', 'TypeScript compiler resolution timed out.')), boundedNumber(request.timeoutMs, 5000, 30000));
      const abort = (): void => reject(new ResolutionFailure('cancelled', 'Typed symbol resolution was cancelled.'));
      request.signal?.addEventListener('abort', abort, { once: true });
      const cleanup = (): void => { clearTimeout(timeout); request.signal?.removeEventListener('abort', abort); };
      worker.once('message', (result: CompilerOutput) => { cleanup(); resolve(result); });
      worker.once('error', error => { cleanup(); reject(error); });
      worker.once('exit', code => { cleanup(); if (code !== 0) reject(new ResolutionFailure('compiler-exited', 'TypeScript compiler worker exited early.')); });
      if (request.signal?.aborted) { cleanup(); abort(); }
    });
  } finally { try { await worker.terminate(); } finally { activeCompilerWorkers--; } }
}

export async function resolveWithTypeScript(request: TypedSymbolRequest, root: string, source: SourceSnapshot, offset: number, callImplementation = false): Promise<{ locations: TypedSymbolLocation[]; gaps: TypedSymbolGap[] }> {
  const result = await runCompiler(request, root, source, offset, callImplementation);
  if (result.error) throw new ResolutionFailure(result.error.code, result.error.message);
  const snapshots = new Map<string, SourceSnapshot>();
  for (const previous of result.files) {
    checkCancelled(request.signal);
    const current = await readInside(root, previous.file);
    if (current.hash !== previous.hash) throw new ResolutionFailure('stale-source', 'Compiler input changed during typed symbol resolution.');
    snapshots.set(current.absolute, current);
  }
  const locations: TypedSymbolLocation[] = [];
  for (const location of result.locations) {
    const snapshot = snapshots.get(location.file);
    if (!snapshot || !validRange(snapshot.text, location.range)) throw new ResolutionFailure('invalid-range', 'Compiler source location could not be verified.');
    locations.push({ path: snapshot.relative, range: location.range, ...(location.selectionRange ? { selectionRange: location.selectionRange } : {}), relation: location.relation, contentHash: snapshot.hash });
  }
  await assertFresh(root, [...snapshots.values(), source]);
  checkCancelled(request.signal);
  return { locations: uniqueLocations(locations), gaps: result.gaps };
}
