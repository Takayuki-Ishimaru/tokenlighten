import * as fs from "node:fs";
import * as path from "node:path";

const IMPLEMENTATION_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cxx", ".js", ".jsx", ".mjs", ".ts", ".tsx", ".py", ".go", ".rs", ".java",
]);
const SOURCE_EXTENSIONS = new Set([
  ...IMPLEMENTATION_EXTENSIONS,
  ".h", ".hh", ".hpp", ".hxx",
]);
const CONTROL_NAMES = new Set(["if", "for", "while", "switch", "catch", "return", "sizeof"]);
const MAX_SEMANTIC_FILES = 240;
const MAX_RECEIVER_CONSTRUCTION_HUB_BYTES = 32 * 1024;
const MAX_RECEIVER_CONSTRUCTION_HUB_LINES = 600;

interface CallableDefinition {
  qualified: string;
  owner?: string;
  name: string;
  line: number;
}

interface SourceRecord {
  path: string;
  content: string;
  code: string;
  definitions: CallableDefinition[];
  pathWords: string[];
}

export interface SemanticWiringResolution {
  version: 1;
  strategy: "semantic-multihop";
  scope: string;
  connectionMode: "existing-receiver" | "construct-receiver";
  requiredAction?: string;
  receiverSearch?: {
    scope: string;
    filesScanned: number;
    producerType: string;
    scopeComplete: true;
    existingReceiverFound: false;
  };
  lifecycleSymbols?: string[];
  producer: { path: string; symbol: string; line: number };
  host: {
    path: string;
    type: string;
    callSymbol: string;
    producerEntry: string;
    producerEntryLine: number;
    producerPublishLine?: number;
  };
  carrier: { path: string; type: string };
  consumer: {
    path: string;
    symbol: string;
    owner: string;
    adapterCallMode: "existing" | "construct";
    constructionSymbol?: string;
  };
  insertion: { path: string; symbol: string; line: number; consumerCall: string };
  adapter: { path: string; symbol: string };
  editPaths: string[];
  reviewPaths: string[];
  structuralChecks?: Array<{
    id: string;
    description: string;
    path: string;
    tokens: string[];
  }>;
  certificate: string[];
}

function isImplementationPath(relPath: string): boolean {
  return IMPLEMENTATION_EXTENSIONS.has(path.extname(relPath).toLowerCase());
}

function normalizeWord(word: string): string {
  const lower = word.toLowerCase();
  if (/^[A-Z][A-Z0-9]{1,}$/.test(word)) return lower;
  if (["healthy", "unhealthy", "health"].includes(lower)) return "health";
  if (["encoder", "encoded", "encoding", "encode"].includes(lower)) return "encode";
  if (lower === "sys") return "system";
  return lower.replace(/(?:ing|ed|es|s)$/i, "");
}

function identifierWords(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/::|[_./-]+/g, " ")
    .match(/[A-Za-z][A-Za-z0-9]*/g)
    ?.map(normalizeWord)
    .filter((word) => word.length >= 3) ?? [];
}

function explicitRoleIdentifier(query: string, role: "producer" | "consumer" | "adapter"): string | undefined {
  const aliases = role === "producer"
    ? ["producer", "source", "生成元"]
    : role === "consumer"
      ? ["consumer", "destination", "送信先"]
      : ["adapter", "encoder", "変換器"];
  for (const alias of aliases) {
    const match = query.match(new RegExp(`(?:^|[\\s,;、。])${alias}\\s*(?:is|=|:|は|が|を)?\\s*([A-Za-z_][A-Za-z0-9_:]*)`, "i"));
    if (match?.[1] !== undefined) return match[1].split("::")[0]!.toLowerCase();
  }
  return undefined;
}

const QUERY_RELATION_WORDS = new Set([
  "add", "after", "before", "build", "call", "carry", "clear", "connect", "from", "into",
  "output", "reflect", "route", "send", "should", "through", "using", "where", "wire", "with",
]);

/**
 * Query-derived producer concepts near an explicitly named owner.
 *
 * The resolver may use lexical evidence, but it must be traceable to the
 * request. Keeping the window owner-local prevents a destination term later
 * in the request (for example "status") from promoting an unrelated method on
 * the producer type. Generic relation verbs are removed; no domain vocabulary
 * lives in this list.
 */
function ownerConceptWords(query: string, owner: string, wanted: ReadonlySet<string>): Set<string> {
  const lowerQuery = query.toLowerCase();
  const lowerOwner = owner.toLowerCase();
  const ownerIndex = lowerQuery.indexOf(lowerOwner);
  if (ownerIndex < 0) return new Set();
  const window = query.slice(
    Math.max(0, ownerIndex - 32),
    Math.min(query.length, ownerIndex + owner.length + 32),
  );
  const ownerWords = new Set(identifierWords(owner));
  return new Set(identifierWords(window).filter((word) =>
    wanted.has(word)
    && !ownerWords.has(word)
    && !QUERY_RELATION_WORDS.has(word)
  ));
}

function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/(^|\s)\/\/.*$/gm, "$1")
    .replace(/^\s*#(?!\s*include\b).*$/gm, " ");
}

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split(/\r?\n/).length;
}

function callableDefinitions(content: string): CallableDefinition[] {
  const code = stripComments(content);
  const definitions: CallableDefinition[] = [];
  const pattern = /\b((?:[A-Za-z_][A-Za-z0-9_]*::)*[A-Za-z_][A-Za-z0-9_]*)\s*\([^;{}]{0,768}\)\s*(?:const\s*)?(?:noexcept\s*)?\{/g;
  for (const match of code.matchAll(pattern)) {
    const qualified = match[1]!;
    const parts = qualified.split("::");
    const name = parts.at(-1)!;
    if (CONTROL_NAMES.has(name)) continue;
    definitions.push({
      qualified,
      ...(parts.length > 1 ? { owner: parts.at(-2)! } : {}),
      name,
      line: lineOf(code, match.index ?? 0),
    });
  }
  return definitions;
}

function overlapScore(words: readonly string[], wanted: ReadonlySet<string>): number {
  return words.reduce((score, word) => score + (wanted.has(word) ? 1 : 0), 0);
}

function snakeCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** A behavioral relation explicitly stated by the request, never a domain prior. */
function queryRequiresNegativeBitClear(query: string): boolean {
  const clear = /\bclear(?:s|ed|ing)?\b|クリア|解除|落と/i.test(query);
  const bit = /\bbits?\b|ビット/i.test(query);
  const negative = /\bunhealthy\b|\bnot\s+healthy\b|\bfalse\b|異常|不健全|壊れ/i.test(query);
  return clear && bit && negative;
}

function projectedSiblingCallableName(
  consumerName: string,
  peerAdapterName: string,
  targetAdapterName: string,
): string | undefined {
  let sharedSuffix = 0;
  while (
    sharedSuffix < consumerName.length
    && sharedSuffix < peerAdapterName.length
    && consumerName[consumerName.length - sharedSuffix - 1]
      === peerAdapterName[peerAdapterName.length - sharedSuffix - 1]
  ) {
    sharedSuffix += 1;
  }
  if (sharedSuffix === 0) return undefined;
  const consumerPrefix = consumerName.slice(0, consumerName.length - sharedSuffix);
  const adapterPrefix = peerAdapterName.slice(0, peerAdapterName.length - sharedSuffix);
  if (consumerPrefix.length === 0 || adapterPrefix.length === 0 || !targetAdapterName.startsWith(adapterPrefix)) {
    return undefined;
  }
  const projected = consumerPrefix + targetAdapterName.slice(adapterPrefix.length);
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(projected) ? projected : undefined;
}

function includesOf(content: string): string[] {
  return [...content.matchAll(/^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm)].map((match) => match[1]!);
}

function companionPaths(files: readonly string[], selected: string): string[] {
  const stem = path.basename(selected).replace(/\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/i, "");
  return files.filter((candidate) =>
    candidate !== selected
    && path.basename(candidate).replace(/\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/i, "") === stem
  );
}

function resolveInclude(files: readonly string[], specifier: string): string | undefined {
  const normalized = specifier.replace(/\\/g, "/");
  const direct = files.find((candidate) => candidate.endsWith("/" + normalized) || candidate === normalized);
  if (direct !== undefined) return direct;
  const stem = normalized.replace(/\.[^.]+$/, "");
  return files.find((candidate) => candidate.replace(/\.[^.]+$/, "").endsWith("/" + stem));
}

function sameModule(left: string, right: string): boolean {
  const moduleKey = (value: string): string => value
    .replace(/\\/g, "/")
    .replace(/\.[^.]+$/, "")
    .replace(/(^|\/)(?:src|include)\//, "$1");
  return moduleKey(left) === moduleKey(right);
}

function bestByScore<T>(candidates: readonly T[], score: (candidate: T) => number, key: (candidate: T) => string): { candidate: T; score: number } | undefined {
  return candidates
    .map((candidate) => ({ candidate, score: score(candidate) }))
    .sort((left, right) => right.score - left.score || key(left.candidate).localeCompare(key(right.candidate)))[0];
}

function definitionSlice(record: SourceRecord, definition: CallableDefinition): string {
  const lines = record.code.split(/\r?\n/);
  const nextLine = record.definitions
    .filter((candidate) => candidate.line > definition.line)
    .map((candidate) => candidate.line)
    .sort((left, right) => left - right)[0] ?? lines.length + 1;
  return lines.slice(definition.line - 1, nextLine - 1).join("\n");
}

function scopedFiles(relFiles: readonly string[], scope: string): string[] {
  const normalized = scope === "." ? "" : scope.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  return relFiles
    .filter((relPath) => SOURCE_EXTENSIONS.has(path.extname(relPath).toLowerCase()))
    .filter((relPath) => normalized === "" || relPath === normalized || relPath.startsWith(normalized + "/"))
    .map((relPath) => normalized === "" ? relPath : relPath.slice(normalized.length + 1));
}

function structuralScopeCandidates(
  relFiles: readonly string[],
  query: string,
  requestedScope: string,
): Array<{ scope: string; score: number }> {
  const wanted = new Set(identifierWords(query));
  const roots = new Map<string, number>();
  for (const relPath of relFiles) {
    if (!SOURCE_EXTENSIONS.has(path.extname(relPath).toLowerCase())) continue;
    const parts = relPath.replace(/\\/g, "/").split("/");
    const boundary = parts.findIndex((part) => part === "src" || part === "include" || part === "source");
    if (boundary <= 0) continue;
    const root = parts.slice(0, boundary).join("/");
    roots.set(root, (roots.get(root) ?? 0) + 1);
  }
  return [...roots]
    .filter(([scope, count]) => scope !== requestedScope && count <= MAX_SEMANTIC_FILES)
    .map(([scope]) => {
      const parts = scope.split("/");
      const authorityPenalty = parts.includes("proto") ? 100 : 0;
      return {
        scope,
        score: overlapScore(identifierWords(scope), wanted) * 1_000 - parts.length - authorityPenalty,
      };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.scope.localeCompare(right.scope))
    .slice(0, 8);
}

function safeRead(workspace: string, scope: string, relPath: string): string | undefined {
  const root = path.resolve(workspace, scope);
  const absolute = path.resolve(root, relPath);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) return undefined;
  try {
    return fs.readFileSync(absolute, "utf8");
  } catch {
    return undefined;
  }
}

function resolveSemanticWiringInScope(
  workspace: string,
  query: string,
  allFiles: readonly string[],
  scope: string,
): SemanticWiringResolution | undefined {
  const relFiles = scopedFiles(allFiles, scope);
  if (relFiles.length === 0 || relFiles.length > MAX_SEMANTIC_FILES) return undefined;
  const wanted = new Set(identifierWords(query));
  // D10 (2026-08-14): unconditional — `TL_QUERY_BEHAVIOR_PROOF` is deleted.
  const negativeBitClearProof = queryRequiresNegativeBitClear(query);
  const rawQueryIdentifiers = query.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? [];
  const explicitTypes = new Set(rawQueryIdentifiers.map((token) => token.toLowerCase()));
  const explicitProducer = explicitRoleIdentifier(query, "producer");
  const explicitProducerSymbol = [...query.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)::([A-Za-z_][A-Za-z0-9_]*)\b/g)]
    .map((match) => ({ owner: match[1]!.toLowerCase(), name: match[2]!.toLowerCase() }))
    .find((candidate) => !candidate.name.startsWith("encode"));
  const records: SourceRecord[] = relFiles.flatMap((relPath) => {
    const content = safeRead(workspace, scope, relPath);
    return content === undefined ? [] : [{
      path: relPath,
      content,
      code: stripComments(content),
      definitions: callableDefinitions(content),
      pathWords: identifierWords(relPath),
    }];
  });
  const callables = records.flatMap((record) => record.definitions.map((definition) => ({ ...definition, record })));
  const callableOwners = new Set(callables
    .map((candidate) => candidate.owner?.toLowerCase())
    .filter((owner): owner is string => owner !== undefined));
  const queryOwnerOrder = rawQueryIdentifiers
    .map((identifier) => identifier.toLowerCase())
    .filter((identifier, index, all) =>
      callableOwners.has(identifier) && all.indexOf(identifier) === index
    );
  if (
    explicitProducer === undefined
    && explicitProducerSymbol === undefined
    && queryOwnerOrder.length === 0
  ) return undefined;
  const explicitOwners = callables.filter((candidate) =>
    candidate.owner !== undefined && explicitTypes.has(candidate.owner.toLowerCase())
  );
  const exactProducerPool = explicitProducerSymbol === undefined
    ? []
    : callables.filter((candidate) =>
      candidate.owner?.toLowerCase() === explicitProducerSymbol.owner
      && candidate.name.toLowerCase() === explicitProducerSymbol.name
    );
  const roleProducerPool = exactProducerPool.length > 0
    ? exactProducerPool
    : explicitProducer === undefined
      ? []
      : callables.filter((candidate) =>
        candidate.owner?.toLowerCase() === explicitProducer || candidate.name.toLowerCase() === explicitProducer
      );
  const isProducerCallable = (candidate: typeof callables[number]): boolean =>
    !candidate.name.toLowerCase().startsWith("encode");
  const queryOwnerPool = queryOwnerOrder.length === 0
    ? explicitOwners
    : callables.filter((candidate) =>
      candidate.owner !== undefined && queryOwnerOrder.includes(candidate.owner.toLowerCase())
    );
  const conceptBackedProducerPool = queryOwnerPool.filter((candidate) => {
    if (!isProducerCallable(candidate) || candidate.owner === undefined) return false;
    const concepts = ownerConceptWords(query, candidate.owner, wanted);
    return overlapScore(identifierWords(candidate.name), concepts) > 0;
  });
  // Producer selection is admitted only by an exact query role/symbol or by
  // owner-local query concepts plus callable ownership. There is deliberately
  // no built-in domain prior: renaming the domain while preserving the request
  // and repository structure must preserve the selected graph.
  const producerPool = roleProducerPool.length > 0
    ? roleProducerPool.filter(isProducerCallable)
    : conceptBackedProducerPool;
  const producerRanked = bestByScore(producerPool, (candidate) =>
    overlapScore(
      identifierWords(candidate.name),
      candidate.owner === undefined ? wanted : ownerConceptWords(query, candidate.owner, wanted),
    ) * 24
      + overlapScore(identifierWords(candidate.name), wanted) * 12
      + overlapScore(identifierWords(candidate.owner ?? ""), wanted) * 16
      + (explicitProducerSymbol !== undefined
        && candidate.owner?.toLowerCase() === explicitProducerSymbol.owner
        && candidate.name.toLowerCase() === explicitProducerSymbol.name ? 120 : 0)
      + (explicitProducer !== undefined
        && (candidate.owner?.toLowerCase() === explicitProducer || candidate.name.toLowerCase() === explicitProducer) ? 80 : 0)
      + (candidate.owner !== undefined && explicitTypes.has(candidate.owner.toLowerCase()) ? 40 : 0)
      + overlapScore(candidate.record.pathWords, wanted) * 3,
  (candidate) => candidate.record.path);

  const namedAdapters = callables.filter((candidate) =>
    rawQueryIdentifiers.some((identifier) =>
      (/[_-]/.test(identifier) || /[a-z][A-Z]/.test(identifier))
      && identifier.toLowerCase() === candidate.name.toLowerCase()
    )
    && candidate.record.path !== producerRanked?.candidate.record.path
  );
  const adapterPool = namedAdapters.length > 0
    ? namedAdapters
    : callables.filter((candidate) => candidate.name.toLowerCase().startsWith("encode"));
  const adapterRanked = bestByScore(adapterPool, (candidate) => {
    const familyNames = candidate.record.definitions.map((definition) => definition.name);
    const externalFamilyCalls = records
      .filter((record) => record.path !== candidate.record.path && isImplementationPath(record.path))
      .reduce((sum, record) => sum + familyNames.filter((name) => new RegExp(`\\b${name}\\s*\\(`).test(record.code)).length, 0);
    const inboundImports = records.reduce((sum, record) => sum + includesOf(record.content)
      .map((specifier) => resolveInclude(relFiles, specifier))
      .filter((target) => target !== undefined && sameModule(target, candidate.record.path)).length, 0);
    return overlapScore(identifierWords(candidate.name), wanted) * 14
      + overlapScore(candidate.record.pathWords, wanted) * 2
      + Math.min(4, inboundImports) * 20
      + Math.min(8, externalFamilyCalls) * 10;
  }, (candidate) => candidate.record.path);
  if (producerRanked === undefined || adapterRanked === undefined || producerRanked.score < 12 || adapterRanked.score < 20) return undefined;
  const producer = producerRanked.candidate;
  const adapter = adapterRanked.candidate;

  const adapterFamily = adapter.record.definitions.map((definition) => definition.name);
  const adapterPeers = adapterFamily.filter((name) => name !== adapter.name);
  const exactAdapterCall = new RegExp(`\\b${adapter.name}\\s*\\(`);
  const consumerRecords = records
    .filter((record) => record.path !== adapter.record.path && isImplementationPath(record.path))
    .filter((record) => includesOf(record.content)
      .map((specifier) => resolveInclude(relFiles, specifier))
      .some((target) => target !== undefined && sameModule(target, adapter.record.path)));
  const exactConsumerRanked = bestByScore(
    consumerRecords.filter((record) => exactAdapterCall.test(record.code)),
    (record) => 20 + overlapScore(record.pathWords, wanted),
    (record) => record.path,
  );
  const peerConsumerRanked = bestByScore(
    consumerRecords,
    (record) => adapterPeers.filter((name) => new RegExp(`\\b${name}\\s*\\(`).test(record.code)).length * 20
      + overlapScore(record.pathWords, wanted),
    (record) => record.path,
  );
  const consumerSelection = exactConsumerRanked !== undefined
    ? { ...exactConsumerRanked, adapterCallMode: "existing" as const }
    : peerConsumerRanked !== undefined && peerConsumerRanked.score >= 20
      ? { ...peerConsumerRanked, adapterCallMode: "construct" as const }
      : undefined;
  if (consumerSelection === undefined) return undefined;
  const consumerRecord = consumerSelection.candidate;
  const adapterCallMode = consumerSelection.adapterCallMode;
  const consumerSurfacePaths = new Set([consumerRecord.path, ...companionPaths(relFiles, consumerRecord.path)]);

  const consumerCalls = consumerRecord.definitions.map((definition) => definition.name);
  const hubRanked = bestByScore(
    records.filter((record) => record.path !== consumerRecord.path && record.path !== adapter.record.path && isImplementationPath(record.path)),
    (record) => consumerCalls.filter((name) => new RegExp(`(?:\\.|\\b)${name}\\s*\\(`).test(record.code)).length * 12
      + overlapScore(record.pathWords, wanted),
    (record) => record.path,
  );
  if (hubRanked === undefined || hubRanked.score < 20) return undefined;
  const hub = hubRanked.candidate;
  const consumerUseSite = hub.definitions
    .map((definition) => ({
      definition,
      body: definitionSlice(hub, definition),
      calls: consumerCalls.filter((name) => new RegExp(`(?:\\.|\\b)${name}\\s*\\(`).test(definitionSlice(hub, definition))).length,
    }))
    .sort((left, right) => right.calls - left.calls || left.definition.line - right.definition.line)[0];
  if (consumerUseSite === undefined || consumerUseSite.calls < 2) return undefined;
  const consumerDefinitionRanked = bestByScore(consumerRecord.definitions, (definition) => {
    const body = definitionSlice(consumerRecord, definition);
    const adapterCalls = adapterCallMode === "existing"
      ? (exactAdapterCall.test(body) ? 1 : 0)
      : adapterPeers.filter((name) => new RegExp(`\\b${name}\\s*\\(`).test(body)).length;
    const calledAtInsertion = new RegExp(`(?:\\.|\\b)${definition.name}\\s*\\(`).test(consumerUseSite.body);
    return adapterCalls * 20
      + (calledAtInsertion ? 20 : 0)
      + overlapScore(identifierWords(definition.name), wanted) * 8;
  }, (definition) => definition.qualified);
  if (consumerDefinitionRanked === undefined || consumerDefinitionRanked.score < 40) return undefined;
  const consumerDefinition = consumerDefinitionRanked.candidate;
  const consumerOwner = consumerDefinition.owner;
  if (consumerOwner === undefined) return undefined;
  const consumerCall = consumerDefinition.name;
  const consumerBody = definitionSlice(consumerRecord, consumerDefinition);
  const peerAdapterName = adapterPeers.find((name) =>
    new RegExp(`\\b${name}\\s*\\(`).test(consumerBody)
  );
  const constructionSymbol = adapterCallMode === "construct" && peerAdapterName !== undefined
    ? projectedSiblingCallableName(consumerCall, peerAdapterName, adapter.name)
    : undefined;
  // A new consumer callable is admitted only when the repository's existing
  // consumer/adapter family projects one exact sibling name. This turns the
  // insertion from an unconstrained naming guess into structural evidence.
  if (adapterCallMode === "construct" && constructionSymbol === undefined) return undefined;

  const ownedTypes = [...hub.code.matchAll(/\b(?:[A-Za-z_][A-Za-z0-9_]*::)?([A-Z][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*[;({]/g)]
    .map((match) => ({ type: match[1]!, object: match[2]! }));
  const hostCandidates = ownedTypes.flatMap((owned) => {
    const stem = snakeCase(owned.type);
    return records
      .filter((record) => owned.type !== consumerOwner
        && !consumerSurfacePaths.has(record.path)
        && isImplementationPath(record.path)
        && path.basename(record.path).replace(/\.[^.]+$/, "").toLowerCase() === stem)
      .map((record) => {
        const useSites = hub.definitions
          .filter((definition) => new RegExp(`\\b${owned.object}\\b`).test(definitionSlice(hub, definition)))
          .map((definition) => {
            const body = definitionSlice(hub, definition);
            const callSymbol = [...body.matchAll(new RegExp(`\\b${owned.object}\\s*\\.\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*\\(`, "g"))]
              .map((match) => match[1]!)[0];
            return {
              name: definition.name,
              line: definition.line,
              callSymbol,
              affinity: overlapScore(identifierWords(definition.name), new Set([
                ...producer.record.pathWords,
                ...identifierWords(producer.owner ?? ""),
                ...wanted,
              ])),
            };
          })
          .filter((site) => site.callSymbol !== undefined)
          .sort((left, right) => right.affinity - left.affinity || left.name.localeCompare(right.name));
        return { ...owned, record, useSite: useSites[0] };
      })
      .filter((candidate) => candidate.useSite !== undefined);
  });
  const producerBackedHosts = hostCandidates.filter((candidate) => {
    if (producer.owner === undefined || candidate.type === producer.owner) return true;
    const relatedPaths = new Set([
      candidate.record.path,
      ...companionPaths(relFiles, candidate.record.path),
    ]);
    const ownerPattern = new RegExp(`\\b${producer.owner!}\\b`, "i");
    return records.some((record) =>
      relatedPaths.has(record.path) && ownerPattern.test(record.code)
    );
  });
  const producerReceiverRecords = producer.owner === undefined
    ? []
    : records.filter((record) => {
      if (sameModule(record.path, producer.record.path)) return false;
      if (/(^|\/)(?:test|tests|__tests__)(?:\/|$)|(?:^|\/)[^/]+\.(?:spec|test)\.[^/]+$/i.test(record.path)) return false;
      const owner = producer.owner!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(
        `\\b(?:[A-Za-z_][A-Za-z0-9_]*::)?${owner}\\s*(?:[*&]\\s*)?[A-Za-z_][A-Za-z0-9_]*\\s*(?:[;={([])`,
      ).test(record.code);
    });
  // Construction readiness includes a complete negative receiver proof over
  // the admitted scope. A producer instance elsewhere cannot be treated as
  // absent merely because it is not one of the runtime-hub-owned candidates.
  // In that ambiguous case, fall back to discovery instead of constructing a
  // duplicate same-purpose receiver.
  if (producerBackedHosts.length === 0 && producerReceiverRecords.length > 0) return undefined;
  // Existing receiver evidence permits the ordinary propagation frontier.
  // Without it, preserve the selected member producer and switch to a bounded
  // construction frontier rooted at the runtime hub. This is safe only when
  // the hub can be served whole; otherwise imports/globals and call sites
  // cannot all be certified and the resolver fails closed.
  const connectionMode = producerBackedHosts.length > 0
    ? "existing-receiver" as const
    : "construct-receiver" as const;
  // D10 (2026-08-14): receiver construction is unconditional — `TL_CONSTRUCT_RECEIVER`
  // and its resolve-to-undefined off-branch are deleted. The byte/line ceiling
  // below is the only remaining fail-closed guard.
  if (
    connectionMode === "construct-receiver"
    && (
      Buffer.byteLength(hub.content, "utf8") > MAX_RECEIVER_CONSTRUCTION_HUB_BYTES
      || hub.content.split(/\r?\n/).length > MAX_RECEIVER_CONSTRUCTION_HUB_LINES
    )
  ) return undefined;
  const hostPool = producerBackedHosts.length > 0 ? producerBackedHosts : hostCandidates;
  const explicitHosts = hostPool.filter((candidate) => explicitTypes.has(candidate.type.toLowerCase()));
  // Host candidacy is already structural: the runtime hub owns the object,
  // calls it from a callable insertion site, and (for existing receivers) its
  // module proves ownership of the producer type. Query-derived words may
  // break structural ties only when they distinguish a strict subset of the
  // admitted hosts. Producer-local concepts are excluded because they already
  // proved the selected callable and would otherwise promote a same-word
  // decoy host; there is no built-in domain-word prior.
  const producerConceptEvidence = producer.owner === undefined
    ? new Set<string>()
    : ownerConceptWords(query, producer.owner, wanted);
  const producerOwnerWords = new Set(identifierWords(producer.owner ?? ""));
  const claimedEndpointWords = new Set([
    ...producerConceptEvidence,
    ...identifierWords(producer.qualified),
    ...identifierWords(producer.record.path),
    ...identifierWords(adapter.qualified),
    ...identifierWords(adapter.record.path),
    ...identifierWords(consumerDefinition.qualified),
    ...identifierWords(consumerRecord.path),
  ]);
  const queryAcronymEvidence = new Set(rawQueryIdentifiers
    .filter((identifier) => /^[A-Z][A-Z0-9]{1,}$/.test(identifier))
    .flatMap(identifierWords)
    .filter((word) => !producerOwnerWords.has(word)));
  const hostDistinctive = new Set([...wanted].filter((word) => {
    if (claimedEndpointWords.has(word)) return false;
    const matchingHosts = hostPool.filter((candidate) =>
      identifierWords(candidate.type).includes(word)
      || identifierWords(candidate.record.code.slice(0, 32768)).includes(word)
    ).length;
    return matchingHosts > 0 && matchingHosts < hostPool.length;
  }));
  const hostScore = (candidate: typeof hostPool[number]): number =>
    (candidate.useSite?.affinity ?? 0) * 12
      + (path.posix.dirname(candidate.record.path) === path.posix.dirname(producer.record.path) ? 1_000 : 0)
      + overlapScore(identifierWords(candidate.record.code.slice(0, 32768)), queryAcronymEvidence) * 100
      + overlapScore(identifierWords(candidate.type), hostDistinctive) * 8
      + overlapScore(identifierWords(candidate.record.code.slice(0, 32768)), hostDistinctive) * 3
      + (explicitTypes.has(candidate.type.toLowerCase()) ? 80 : 0);
  const hostRanked = bestByScore(explicitHosts.length > 0 ? explicitHosts : hostPool, hostScore,
    (candidate) => candidate.record.path);
  if (hostRanked === undefined || hostRanked.candidate.useSite === undefined) return undefined;
  const host = hostRanked.candidate;

  const commonIncludes = includesOf(consumerRecord.content).filter((specifier) => includesOf(hub.content).includes(specifier));
  const carrierCandidates = commonIncludes
    .map((specifier) => resolveInclude(relFiles, specifier))
    .filter((candidate): candidate is string => candidate !== undefined)
    .map((relPath) => records.find((record) => record.path === relPath))
    .filter((record): record is SourceRecord => record !== undefined && !consumerSurfacePaths.has(record.path));
  const carrierRanked = bestByScore(carrierCandidates, (record) => {
    const types = [...record.code.matchAll(/\b(?:struct|class)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/g)].map((match) => match[1]!);
    return types.reduce((score, typeName) => {
      const consumerRefs = consumerRecord.code.match(new RegExp(`\\b${typeName}\\b`, "g"))?.length ?? 0;
      const hubRefs = hub.code.match(new RegExp(`\\b${typeName}\\b`, "g"))?.length ?? 0;
      return score + Math.min(4, consumerRefs) * 4 + Math.min(4, hubRefs) * 4;
    }, 0) + overlapScore(identifierWords(record.code.slice(0, 32768)), wanted) * 3;
  }, (record) => record.path);
  if (carrierRanked === undefined || carrierRanked.score < 8) return undefined;
  const carrier = carrierRanked.candidate;
  const carrierType = [...carrier.code.matchAll(/\b(?:struct|class)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/g)].map((match) => match[1]!)[0];
  if (carrierType === undefined) return undefined;

  const qualify = (relPath: string): string => scope === "." || scope === ""
    ? relPath
    : path.posix.join(scope.replace(/\\/g, "/"), relPath);
  const constructionHostPath = companionPaths(relFiles, host.record.path)
    .find((candidate) => !isImplementationPath(candidate)) ?? host.record.path;
  const editPathCandidates = connectionMode === "existing-receiver"
    ? [
      host.record.path,
      ...companionPaths(relFiles, host.record.path),
      carrier.path,
      ...companionPaths(relFiles, carrier.path),
      consumerRecord.path,
      ...companionPaths(relFiles, consumerRecord.path),
      hub.path,
    ]
    : [
      carrier.path,
      ...companionPaths(relFiles, carrier.path),
      consumerRecord.path,
      ...companionPaths(relFiles, consumerRecord.path),
      hub.path,
      ...companionPaths(relFiles, hub.path),
    ];
  const reviewPathCandidates = connectionMode === "existing-receiver"
    ? [producer.record.path, adapter.record.path]
    : [
      producer.record.path,
      ...companionPaths(relFiles, producer.record.path),
      adapter.record.path,
      constructionHostPath,
    ];
  const editPaths = editPathCandidates
    .filter((value, index, all) => all.indexOf(value) === index)
    .map(qualify);
  const reviewPaths = reviewPathCandidates
    .filter((value, index, all) => all.indexOf(value) === index && !editPathCandidates.includes(value))
    .map(qualify);
  const producerEntry = host.useSite.name;
  const producerEntryDefinition = hub.definitions.find((definition) =>
    definition.line === host.useSite.line && definition.name === producerEntry
  );
  const producerEntryBody = producerEntryDefinition === undefined
    ? undefined
    : definitionSlice(hub, producerEntryDefinition);
  const carrierOwnerTypes = [...carrier.code.matchAll(
    /\b(?:struct|class)\s+([A-Za-z_][A-Za-z0-9_]*)\b/g,
  )].map((match) => match[1]!);
  const carrierOwnerObject = producerEntryBody === undefined
    ? undefined
    : carrierOwnerTypes.flatMap((typeName) => {
      const match = producerEntryBody.match(new RegExp(
        `\\b(?:[A-Za-z_][A-Za-z0-9_]*::)*${typeName}\\s*[*&]?\\s*([A-Za-z_][A-Za-z0-9_]*)\\b`,
      ));
      return match?.[1] === undefined ? [] : [match[1]];
    })[0];
  const producerPublishMatch = carrierOwnerObject === undefined || producerEntryBody === undefined
    ? undefined
    : [...producerEntryBody.matchAll(new RegExp(
      `\\b${carrierOwnerObject}\\s*\\.\\s*[A-Za-z_][A-Za-z0-9_]*\\s*\\(`,
      "g",
    ))].at(-1);
  // D10 (2026-08-14): unconditional — `TL_HUB_PUBLISH_ANCHOR` is deleted.
  const producerPublishLine = producerEntryDefinition !== undefined
    && producerEntryBody !== undefined
    && producerPublishMatch?.index !== undefined
      ? producerEntryDefinition.line + lineOf(producerEntryBody, producerPublishMatch.index) - 1
      : undefined;
  const lifecycleVerbs = new Set([
    "configure", "correct", "feed", "ingest", "init", "initialize", "observe",
    "predict", "process", "reset", "start", "step", "tick", "update",
  ]);
  const lifecycleSymbols = producer.record.definitions
    .filter((definition) => definition.owner === producer.owner && definition.qualified !== producer.qualified)
    .filter((definition) => identifierWords(definition.name).some((word) => lifecycleVerbs.has(word)))
    .map((definition) => definition.qualified)
    .filter((value, index, all) => all.indexOf(value) === index);
  if (connectionMode === "construct-receiver" && lifecycleSymbols.length === 0) return undefined;
  const lifecycleDriver = lifecycleSymbols.find((symbol) => {
    const name = symbol.split("::").at(-1) ?? symbol;
    return !identifierWords(name).some((word) =>
      word === "reset" || word === "init" || word === "initialize"
    );
  }) ?? lifecycleSymbols[0];
  const lifecycleDriverName = lifecycleDriver?.split("::").at(-1);
  const outboundConsumerSymbol = constructionSymbol ?? consumerDefinition.name;
  const producerStateMember = `${snakeCase(producer.owner ?? "producer")}_${snakeCase(
    producer.name.replace(/^is(?=[A-Z])/, ""),
  )}`;
  const receiverSearch = connectionMode === "construct-receiver"
    ? {
      scope: scope === "" ? "." : scope,
      filesScanned: records.length,
      producerType: producer.owner ?? producer.qualified,
      scopeComplete: true as const,
      existingReceiverFound: false as const,
    }
    : undefined;
  const requiredActions = [
    ...(connectionMode === "construct-receiver"
      ? [
        `Complete ${records.length}-file scope has no ${producer.owner ?? producer.qualified} receiver; do not re-search for one. At ${qualify(hub.path)}, establish its runtime-input update lifecycle using only values/accessors visible there${lifecycleSymbols.length > 0 ? ` (${lifecycleSymbols.join(", ")})` : ""} before calling ${producer.qualified}${adapterCallMode === "existing" ? ` and carry that result to ${consumerDefinition.qualified}` : ""}; do not replace the selected producer or use an un-driven instance.`,
      ]
      : []),
    ...(adapterCallMode === "construct"
      ? [`Add projected peer callable ${consumerOwner}::${constructionSymbol!} in ${qualify(consumerRecord.path)}; directly call ${adapter.qualified}, then invoke it from ${qualify(hub.path)} at ${consumerUseSite.definition.qualified} with the carried result. ${consumerDefinition.qualified} is insertion-style evidence only.`]
      : []),
    ...(negativeBitClearProof
      ? [`Query proof: carry ${carrierType}::${producerStateMember}; when false, ${consumerOwner}::${outboundConsumerSymbol} must preserve other mask bits and apply mask &= ~flag before ${adapter.qualified}, never flag-or-zero. Ground the flag identity in a workspace declaration or the user-named external protocol; do not assume an arbitrary bit position.`]
      : []),
    ...(connectionMode === "construct-receiver"
      ? ["Do not declare completion from a diff alone: satisfy every completion_proof.structural_checks entry, then execute completion_proof.verification.entry when present; any listed gap remains an explicit unverified behavior gap."]
      : []),
  ];
  const requiredAction = requiredActions.length > 0 ? requiredActions.join(" ") : undefined;
  const structuralChecks = connectionMode === "construct-receiver"
    ? [
      {
        id: "receiver-callable",
        description: `receiver calls ${producer.name}`,
        path: qualify(hub.path),
        tokens: [producer.owner ?? producer.qualified, producer.name],
      },
      ...(lifecycleDriverName === undefined ? [] : [{
        id: "receiver-driven",
        description: `lifecycle drives ${producer.name}`,
        path: qualify(hub.path),
        tokens: [producer.name, lifecycleDriverName],
      }]),
      ...(negativeBitClearProof ? [{
        id: "carrier-member",
        description: `${carrierType} declares ${producerStateMember}`,
        path: qualify(carrier.path),
        tokens: [carrierType, producerStateMember],
      }] : []),
      {
        id: "producer-to-outbound",
        description: `${producer.name} -> ${carrierType} -> ${outboundConsumerSymbol}`,
        path: qualify(hub.path),
        tokens: [producer.name, carrierType, outboundConsumerSymbol],
      },
      {
        id: "outbound-to-adapter",
        description: `${outboundConsumerSymbol} -> ${adapter.name}`,
        path: qualify(consumerRecord.path),
        tokens: [
          outboundConsumerSymbol,
          ...(negativeBitClearProof ? [producerStateMember, "&=", "~"] : []),
          adapter.name,
        ],
      },
    ]
    : undefined;
  return {
    version: 1,
    strategy: "semantic-multihop",
    scope,
    connectionMode,
    ...(requiredAction !== undefined ? { requiredAction } : {}),
    ...(receiverSearch !== undefined ? { receiverSearch } : {}),
    ...(connectionMode === "construct-receiver" && lifecycleSymbols.length > 0 ? { lifecycleSymbols } : {}),
    producer: { path: qualify(producer.record.path), symbol: producer.qualified, line: producer.line },
    host: {
      path: qualify(connectionMode === "construct-receiver" ? constructionHostPath : host.record.path),
      type: host.type,
      callSymbol: host.useSite.callSymbol!,
      producerEntry,
      producerEntryLine: host.useSite.line,
      ...(producerPublishLine !== undefined ? { producerPublishLine } : {}),
    },
    carrier: { path: qualify(carrier.path), type: carrierType },
    consumer: {
      path: qualify(consumerRecord.path),
      symbol: consumerDefinition.qualified,
      owner: consumerOwner,
      adapterCallMode,
      ...(constructionSymbol !== undefined ? { constructionSymbol } : {}),
    },
    insertion: {
      path: qualify(hub.path),
      symbol: consumerUseSite.definition.qualified,
      line: consumerUseSite.definition.line,
      consumerCall,
    },
    adapter: { path: qualify(adapter.record.path), symbol: adapter.qualified },
    editPaths,
    reviewPaths,
    ...(structuralChecks !== undefined ? { structuralChecks } : {}),
    certificate: [
      producer.qualified,
      connectionMode === "existing-receiver"
        ? `${host.type} owns/forwards the producer value`
        : `${hub.path} is a bounded receiver construction site for ${producer.owner ?? producer.qualified}`,
      `${producerEntry} publishes it`,
      `${carrierType} carries it`,
      `${consumerUseSite.definition.qualified} consumes it`,
      adapterCallMode === "existing"
        ? `${consumerOwner} builds the outbound value`
        : `${consumerOwner} provides a bounded outbound callable insertion site`,
      adapter.qualified,
    ],
  };
}

export function resolveSemanticWiring(
  workspace: string,
  query: string,
  allFiles: readonly string[],
  scope: string,
): SemanticWiringResolution | undefined {
  const direct = resolveSemanticWiringInScope(workspace, query, allFiles, scope);
  if (direct !== undefined) return direct;

  // Query-only task packs can be initially contaminated by an unrelated
  // artifact surface. Recover only through structural source roots whose path
  // is named by the request, and require a unique best semantic resolution.
  const fallback = structuralScopeCandidates(allFiles, query, scope)
    .map((candidate) => ({
      ...candidate,
      resolution: resolveSemanticWiringInScope(workspace, query, allFiles, candidate.scope),
    }))
    .filter((candidate): candidate is typeof candidate & { resolution: SemanticWiringResolution } =>
      candidate.resolution !== undefined
    );
  if (fallback.length === 0) return undefined;
  if (fallback.length > 1 && fallback[0]!.score === fallback[1]!.score) return undefined;
  return fallback[0]!.resolution;
}
