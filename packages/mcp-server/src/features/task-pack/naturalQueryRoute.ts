import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { walkCodeFiles, createWalkOmissions } from '../../tools/walkRepo.js';
import { readServedTextSafe } from '../../util/safePath.js';
import { classifySurface } from '../../util/impact.js';
import type { TaskPackArgs } from './model.js';
import { extractRuntimeFacts, planNaturalQuery, type Source } from './naturalQueryPlan.js';
import { selectNaturalEditSurfaces } from './naturalEditSurfaces.js';
import { stripDelegationActorSpans } from './requestItems.js';
import { createNaturalEvidence, exactQueryIdentity, withNaturalEvidence, type NaturalIdentity, type NaturalEvidence } from './naturalQueryAdapter.js';
export interface NaturalRoute {
    evidence: NaturalEvidence;
    targets: Array<{
        path: string;
        range: string;
        symbol?: string;
    }>;
    snapshots: ReadonlyMap<string, string>;
}
export interface NaturalRouteInput {
    workspace: string;
    query: string;
    profile: string;
    taskBinding: string;
    lane: string;
    projectNames?: readonly string[];
    readText?: (path: string) => string | undefined | Promise<string | undefined>;
}
/** Uses the same ignore/secret/realpath/decoder boundary as ordinary tool reads. No private fixture/corpus hints. */
export async function prepareNaturalQueryRoute(input: NaturalRouteInput): Promise<NaturalRoute> {
    const purpose = input.profile === 'answer' ? 'answer' : 'edit';
    const omissions = createWalkOmissions();
    const files = walkCodeFiles(input.workspace, { extraExts: purpose === 'edit' ? ['.md', '.mdx', '.rst', '.txt'] : [], respectGitignore: true, omissions });
    const inventoryIdentity = createHash('sha256').update(files.map(f => f.relPath).sort().join('\n')).digest('hex');
    const counts = { implementation: 0, configuration: 0, test: 0, documentation: 0 };
    let bytes = 0, partial = omissions.oversize > 0 || omissions.unreadable_dirs > 0 || omissions.outside_workspace > 0 || omissions.source_only_excluded > 0 || omissions.symlinks > 0;
    const sources: Source[] = [];
    const snapshots = new Map<string, string>();
    const read = input.readText ?? (async (path: string) => {
        // served-bytes: not-served (analysis snapshots; the ordinary pack builder serves selected source)
        const verdict = await readServedTextSafe(path, input.workspace);
        return verdict && verdict.kind !== 'undecodable' ? verdict.text : undefined;
    });
    for (const file of [...files].sort((a, b) => a.relPath.localeCompare(b.relPath))) {
        const doc = /\.(md|mdx|rst|txt)$/i.test(file.relPath);
        const test = classifySurface(file.relPath) === 'test';
        if (purpose === 'answer' && (doc || test))
            continue;
        if (test && !/(?:^|\/)(?:test_[^/]*\.py|conftest\.py)$|(?:\.test|\.spec|_test|_spec)\.[^/]+$/i.test(file.relPath))
            continue;
        const tooling = /^(?:docs?|documentation|tools|scripts|build)\//i.test(file.relPath) || classifySurface(file.relPath) === 'config' && !/(?:^|\/)(?:src|lib)\//i.test(file.relPath);
        const role = doc ? 'documentation' : test ? 'test' : tooling ? 'configuration' : 'implementation';
        if (++counts[role] > 96) {
            partial = true;
            continue;
        }
        const text = await read(file.relPath);
        if (text === undefined) {
            partial = true;
            continue;
        }
        bytes += Buffer.byteLength(text);
        if (bytes > 8 * 1024 * 1024) {
            partial = true;
            break;
        }
        if (Buffer.byteLength(text) > 1024 * 1024) {
            partial = true;
            continue;
        }
        snapshots.set(file.relPath, text);
        sources.push({ path: file.relPath, text, language: file.language, role });
    }
    const facts = await extractRuntimeFacts(sources);
    facts.partial ||= partial;
    if (partial) facts.scopeComplete = false;
    const names = input.projectNames ?? [basename(input.workspace)];
    // Worker assignment names are process instructions. Preserve the full raw
    // request as identity, while applying the same offset-preserving source
    // subject filter used by the ordinary locator and request-item parser.
    const semanticQuery = stripDelegationActorSpans(input.query);
    const plan = planNaturalQuery(semanticQuery, facts, names);
    const roles = purpose === 'edit' ? await selectNaturalEditSurfaces(semanticQuery, plan, sources, undefined, facts) : undefined;
    const identity: NaturalIdentity = { workspace: input.workspace, taskBinding: input.taskBinding, lane: input.lane, profile: input.profile, queryIdentity: exactQueryIdentity(input.query), inventoryIdentity };
    const evidence = createNaturalEvidence(identity, input.query, purpose, plan, facts, roles);
    const raw = [...plan.selections.map(s => ({ path: s.declaration.path, range: `${s.declaration.start}-${s.declaration.end}`, symbol: s.declaration.name })), ...(roles?.additionalTargets ?? []), ...(roles?.relations.flatMap(r => r.spans.map(s => ({ path: s.path, range: `${s.start}-${s.end}` }))) ?? [])];
    const targets = raw.filter((t, i, a) => a.findIndex(x => x.path === t.path && x.range === t.range) === i);
    return { evidence, targets, snapshots };
}
/** Core receives the original full query and inferred-target provenance. It retains write/budget/profile authority. */
export function naturalSeedArgs(args: TaskPackArgs, route: NaturalRoute): TaskPackArgs {
    // An executed next must serve its exact missing ranges first. The complete
    // natural contract remains in ALS, independently of this call's selection.
    const explicit = args.paths?.length ? args.paths : args.path ? [{ path: args.path, ...(args.symbol ? { symbol: args.symbol } : {}) }] : undefined;
    return { ...args, query: route.evidence.query, path: undefined, symbol: undefined, paths: explicit ?? route.targets,
        naturalInferredTargets: explicit === undefined ? true : undefined, autoDiscoveredLocation: true };
}
/** Wrap the entire existing core + postprocessing tail, so every contract rebuild sees the same call-scoped evidence. */
export function runNaturalQueryRoute<T>(args: TaskPackArgs, route: NaturalRoute, run: (seeded: TaskPackArgs) => T): T { return withNaturalEvidence(route.evidence, () => run(naturalSeedArgs(args, route))); }
