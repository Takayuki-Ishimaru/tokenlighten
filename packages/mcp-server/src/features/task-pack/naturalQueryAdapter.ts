import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { elideDocCommentsWithWindows } from '../../util/formatCompress.js';
import { languageForPath } from '../../util/languages.js';
import type { TaskReadinessEvidence, TaskReadinessObligation } from '@tokenlighten/types';
import type { Facts, Plan, Span } from './naturalQueryPlan.js';
import { witnessOperations, type OperationWitness, unsupportedOperationSpans } from './naturalQueryWitnesses.js';
import type { EditSurfacePlan } from './naturalEditSurfaces.js';
export interface NaturalIdentity {
    workspace: string;
    taskBinding: string;
    lane: string;
    profile: string;
    queryIdentity: string;
    inventoryIdentity: string;
}
export interface NaturalEvidence {
    identity: NaturalIdentity;
    query: string;
    purpose: 'answer' | 'edit';
    plan: Plan;
    operations: OperationWitness[];
    /** Fresh call-scoped AST bodies for existing clause-proof adapters; never persisted. */
    declarations?: Facts['declarations'];
    runtimeScopeComplete?: boolean;
    syntaxErrorPaths?: readonly string[];
    roles?: EditSurfacePlan;
    required: Span[];
    ownedClauseIds: string[];
    gaps: string[];
}
export interface ServedSpan extends Span {
    handle: string;
    symbol?: string;
}
export interface NaturalProjection {
    active: boolean;
    ownedClauseIds: ReadonlySet<string>;
    ownedFacetClauses: ReadonlySet<string>;
    obligations: TaskReadinessObligation[];
    missingTargets: Array<{
        path: string;
        range: string;
    }>;
    evidence: TaskReadinessEvidence[];
    proved: boolean;
}
const activeNaturalEvidence = new AsyncLocalStorage<NaturalEvidence | undefined>();
export const exactQueryIdentity = (query: string) => createHash('sha256').update(query).digest('hex');
export function withNaturalEvidence<T>(evidence: NaturalEvidence | undefined, run: () => T): T { return activeNaturalEvidence.run(evidence, run); }
export function currentNaturalEvidence(): NaturalEvidence | undefined { return activeNaturalEvidence.getStore(); }
/** Only for a canonical natural-origin task. Caller rederives from its existing task ledger's full raw query on every continuation. */
export function createNaturalEvidence(identity: NaturalIdentity, query: string, purpose: 'answer' | 'edit', plan: Plan, facts: Facts, roles?: EditSurfacePlan): NaturalEvidence {
    if (identity.queryIdentity !== exactQueryIdentity(query))
        throw new Error('natural-query-identity-mismatch');
    const operations = witnessOperations(plan, facts);
    const ownedClauseIds: string[] = [];
    const gaps: string[] = [];
    if (purpose === 'answer') {
        gaps.push(...plan.gaps, ...unsupportedOperationSpans(plan, facts));
        if (!operations.length)
            gaps.push('unsupported-operation');
        for (const clause of plan.clauses)
            if (!gaps.length)
                ownedClauseIds.push(clause.id);
    }
    else {
        // A code-change frontier proves existing integration venues, not that the requested new behavior already exists.
        const roleOnly = /^(?:(?:including|with|and)\s+)?(?:(?:implementation|config(?:uration)?|docs?|documentation|tests?)\s*(?:and\s*)?)+[.。]?$/iu;
        const settingChange = /^\s*(?:add|introduce|create)\b[\s\S]*\b(?:configuration|config|setting)\b/iu;
        for (const clause of plan.clauses) {
            const parts = clause.text.split(/\band\b|、/iu).map(s => s.trim()).filter(Boolean);
            if (parts.every(p => roleOnly.test(p) || settingChange.test(p)))
                ownedClauseIds.push(clause.id);
            else
                gaps.push(`unsupported-edit-clause:${clause.id}`);
        }
        if (!roles)
            gaps.push('missing-edit-role-plan');
        else {
            gaps.push(...roles.missing.map(r => `missing-role:${r}`));
            if (roles.partial)
                gaps.push('partial-role-pool');
        }
        if (!plan.selections.length)
            gaps.push('missing-change-implementation');
        gaps.push(...plan.gaps.filter(g => g === 'natural-query:ambiguous-operation'));
    }
    if (plan.partial || facts.partial || facts.unavailable.length)
        gaps.push('partial-runtime-pool');
    if (operations.some(w => w.status !== 'witnessed'))
        gaps.push('missing-operation-witness');
    const required = plan.selections.flatMap(s => s.declaration.executableRanges.map(r => ({ path: s.declaration.path, sha: s.declaration.sha, ...r })));
    if (roles)
        required.push(...roles.implementationSpans, ...roles.relations.flatMap(r => r.spans));
    const unique = required.filter((s, i) => required.findIndex(x => x.path === s.path && x.start === s.start && x.end === s.end && x.sha === s.sha) === i);
    return { identity, query, purpose, plan, operations, declarations: facts.declarations, runtimeScopeComplete: facts.scopeComplete, syntaxErrorPaths: facts.syntaxErrorPaths, roles, required: unique, ownedClauseIds, gaps: [...new Set(gaps)] };
}
function sameIdentity(a: NaturalIdentity, b: NaturalIdentity): boolean { return a.workspace === b.workspace && a.taskBinding === b.taskBinding && a.lane === b.lane && a.profile === b.profile && a.queryIdentity === b.queryIdentity && a.inventoryIdentity === b.inventoryIdentity; }
function subtract(required: Span, served: readonly ServedSpan[]): Span[] {
    const ranges = served.filter(s => s.path === required.path && s.sha === required.sha && s.end >= required.start && s.start <= required.end).sort((a, b) => a.start - b.start);
    let cursor = required.start;
    const missing: Span[] = [];
    for (const s of ranges) {
        if (s.start > cursor)
            missing.push({ ...required, start: cursor, end: Math.min(required.end, s.start - 1) });
        cursor = Math.max(cursor, s.end + 1);
        if (cursor > required.end)
            break;
    }
    if (cursor <= required.end)
        missing.push({ ...required, start: cursor });
    return missing;
}
function citations(required: readonly Span[], served: readonly ServedSpan[]): TaskReadinessEvidence[] {
    const out: TaskReadinessEvidence[] = [];
    for (const need of required)
        for (const s of served) {
            if (s.path !== need.path || s.sha !== need.sha || s.end < need.start || s.start > need.end)
                continue;
            const evidence: TaskReadinessEvidence = { handle: s.handle, path: s.path, range: `${Math.max(s.start, need.start)}-${Math.min(s.end, need.end)}`, ...(s.symbol ? { symbol: s.symbol } : {}) };
            if (!out.some(x => x.handle === evidence.handle && x.range === evidence.range))
                out.push(evidence);
        }
    return out;
}
/** Call after source validation; shaOf reads only the request's authorized cache. Missing or stale current source fails closed. */
export function projectNaturalEvidence(identity: NaturalIdentity, served: readonly ServedSpan[], shaOf: (path: string) => string | undefined, evidence = currentNaturalEvidence()): NaturalProjection {
    const inactive: NaturalProjection = { active: false, ownedClauseIds: new Set(), ownedFacetClauses: new Set(), obligations: [], missingTargets: [], evidence: [], proved: false };
    if (!evidence)
        return inactive;
    // A context for another task is never allowed to rewrite this task's semantic obligations.
    if (!sameIdentity(identity, evidence.identity))
        return { ...inactive, active: true, obligations: [{ id: 'request-item:natural-query:identity', kind: 'concern', required: true, status: 'uncovered', origin: 'query', reason: 'natural evidence belongs to a different task/query/profile/inventory' }] };
    const stale = evidence.required.filter(s => shaOf(s.path) !== s.sha);
    const gaps = [...evidence.gaps, ...(stale.length ? ['source-changed'] : [])];
    const missing = evidence.required.flatMap(s => subtract(s, served));
    const allEvidence = citations(evidence.required, served);
    const obligations: TaskReadinessObligation[] = [];
    const add = (id: string, needed: readonly Span[], structural: boolean, reason: string, kind: TaskReadinessObligation['kind'] = 'behavior-body') => { const complete = structural && needed.length > 0 && needed.every(s => shaOf(s.path) === s.sha && subtract(s, served).length === 0); obligations.push({ id: `request-item:${id}`, kind, required: true, status: complete ? 'proved' : 'uncovered', origin: 'query', evidence: citations(needed, served), reason }); };
    add('natural-query:runtime-closure', evidence.required, gaps.length === 0, 'all required natural-query implementation and role spans must be current and served');
    for (const witness of evidence.operations)
        add(witness.requirement.id, witness.spans, witness.status === 'witnessed', 'requested operation is present in executable AST effects and its complete supporting body is served');
    for (const role of evidence.roles?.relations ?? [])
        add(`natural-role:${role.role}:${role.spans[0]?.path}:${role.spans[0]?.start}`, role.spans, true, role.relation, 'concern');
    for (const gap of gaps)
        obligations.push({ id: `request-item:natural-query:gap:${gap}`, kind: 'concern', required: true, status: 'uncovered', origin: 'query', reason: gap });
    const structural = gaps.length === 0;
    const owned = new Set(structural ? evidence.ownedClauseIds : []);
    const clauses = new Set(evidence.plan.clauses.filter(c => owned.has(c.id)).map(c => c.text.trim()));
    if (owned.size === evidence.plan.clauses.length && owned.size)
        clauses.add(evidence.query.trim());
    const targets = missing.flatMap(s => { const out: Array<{
        path: string;
        range: string;
    }> = []; for (let start = s.start; start <= s.end; start += 80)
        out.push({ path: s.path, range: `${start}-${Math.min(s.end, start + 79)}` }); return out; }).filter((s, i, a) => a.findIndex(x => x.path === s.path && x.range === s.range) === i).slice(0, 6);
    return { active: true, ownedClauseIds: owned, ownedFacetClauses: clauses, obligations, missingTargets: targets, evidence: allEvidence, proved: obligations.length > 0 && obligations.every(o => o.status === 'proved') };
}
interface RequestReadinessShape {
    obligations: TaskReadinessObligation[];
    gap?: {
        next_call: unknown;
        ids: string[];
    };
    absences: Array<{
        id: string;
    }>;
    undetermined: Array<{
        id: string;
    }>;
}
/** Replaces only the semantic projection owned by this exact natural plan. Authority/roles/constant dependencies are untouched. */
export function projectNaturalRequestItems<T extends RequestReadinessShape>(value: T, natural: NaturalProjection): T {
    if (!natural.active || !natural.ownedClauseIds.size)
        return value;
    const owned = (id: string) => natural.ownedClauseIds.has(id.replace(/^request-item:/, ''));
    const gap = value.gap ? { ...value.gap, ids: value.gap.ids.filter(id => !owned(id)) } : undefined;
    return { ...value, obligations: value.obligations.filter(o => !owned(o.id)), absences: value.absences.filter(a => !owned(a.id)), undetermined: value.undetermined.filter(a => !owned(a.id)), ...(gap?.ids.length ? { gap } : { gap: undefined }) };
}
interface FacetEntryShape {
    dependency?: true;
    label: string;
    requirement: {
        facet: string;
        clause: string;
    };
    facts: {
        openTargets: ReadonlyArray<{
            path: string;
            start: number;
            end: number;
        }>;
    };
}
interface FacetReadinessShape<E extends FacetEntryShape> {
    entries: readonly E[];
    openTargets: ReadonlyArray<{
        path: string;
        range: string;
    }>;
    disclosures: ReadonlyArray<{
        id: string;
    }>;
}
export function projectNaturalFacets<E extends FacetEntryShape, T extends FacetReadinessShape<E>>(value: T | undefined, natural: NaturalProjection): T | undefined {
    if (!value || !natural.active)
        return value;
    const keep = (e: E) => e.dependency === true || !['value', 'condition'].includes(e.requirement.facet) || !natural.ownedFacetClauses.has(e.requirement.clause.trim());
    const entries = value.entries.filter(keep);
    if (entries.length === value.entries.length)
        return value;
    const labels = new Set(entries.map(e => `facet-${e.label}`));
    return { ...value, entries, openTargets: entries.flatMap(e => e.facts.openTargets.map(t => ({ path: t.path, range: `${t.start}-${t.end}` }))), disclosures: value.disclosures.filter(d => labels.has(d.id)) };
}
/** Append these after the existing request/facet obligations, never before the base 12-obligation cap. */
export function appendNaturalObligations(obligations: TaskReadinessObligation[], natural: NaturalProjection): void {
    if (!natural.active)
        return;
    for (const obligation of natural.obligations) {
        const index = obligations.findIndex(o => o.id === obligation.id);
        if (index >= 0)
            obligations[index] = obligation;
        else
            obligations.push(obligation);
    }
    const analysis = obligations.find(o => o.id === 'analysis-source');
    if (analysis && natural.proved) {
        analysis.status = 'proved';
        analysis.evidence = natural.evidence;
        analysis.reason = 'analysis is grounded in the natural query operation witnesses and exact served implementation';
    }
}
/** Own reply bodies and reconstructed, sha-validated epoch evidence only. Nominal range metadata is not body residency. */
export function collectNaturalServedSpans(required: readonly Span[], surfaces: readonly {
    path: string;
    range: string;
    handle: string;
    code?: string;
    symbol?: string;
    remaining_ranges?: readonly string[];
}[], sourceText: (path: string) => string | undefined): ServedSpan[] {
    const out: ServedSpan[] = [];
    const parse = (value: string) => value.split(',').flatMap(piece => { const m = /^(\d+)-(\d+)$/.exec(piece.trim()); return m ? [{ start: Number(m[1]), end: Number(m[2]) }] : []; });
    for (const need of required) {
        const source = sourceText(need.path);
        if (source === undefined || createHash('sha256').update(source).digest('hex') !== need.sha)
            continue;
        const lines = source.split(/\r\n|\r|\n/);
        for (const surface of surfaces) {
            if (surface.path !== need.path || typeof surface.code !== 'string' || !surface.code.length)
                continue;
            const code = surface.code.replace(/\r\n|\r/g, '\n');
            const ranges = parse(surface.range), holes = (surface.remaining_ranges ?? []).flatMap(parse);
            if (!ranges.length || ranges.some(r => r.start < 1 || r.end < r.start || r.end > lines.length)) continue;
            // Build the only two recognized displays from the actual source: raw,
            // and the renderer's own comment-elided form. The renderer supplies
            // the skipped windows; marker-shaped user text cannot invent one.
            const layout = (elide: boolean): Array<{ text: string; line?: number }> => {
                const result: Array<{ text: string; line?: number }> = [];
                for (const range of ranges) {
                    const original = lines.slice(range.start - 1, range.end).join('\n');
                    const rendered = elide ? elideDocCommentsWithWindows(original, languageForPath(need.path), range.start) : { text: original, elided: [] as Array<[number, number]> };
                    const numbers: Array<number | undefined> = [];
                    for (let line = range.start; line <= range.end; line++) {
                        const window = rendered.elided.find(([start]) => start === line);
                        if (window) { numbers.push(undefined); line = window[1]; }
                        else numbers.push(line);
                    }
                    const displayLines = rendered.text.split('\n');
                    if (displayLines.length !== numbers.length) return [];
                    result.push(...displayLines.map((text, i) => ({ text, line: numbers[i] })));
                }
                return result;
            };
            const shown = code.split('\n');
            const matches = [layout(false), layout(true)].map(expected => {
                // sliceLinesToText joins selected source lines; an exact full
                // slice ending at an empty line therefore ends in a separator.
                // Only the entire expected display can establish that final
                // empty line; a clipped prefix gets no such inferred line.
                const exact = code === expected.map(line => line.text).join('\n');
                const countable = !exact && code.endsWith('\n') ? shown.length - 1 : shown.length;
                let count = 0;
                while (count < countable && count < expected.length && shown[count] === expected[count]!.text) count++;
                return { expected, count };
            });
            const best = matches[0]!.count >= matches[1]!.count ? matches[0]! : matches[1]!;
            for (let i = 0; i < best.count; i++) {
                const line = best.expected[i]!.line;
                if (line === undefined || line < need.start || line > need.end || holes.some(h => h.start <= line && h.end >= line)) continue;
                const previous = out[out.length - 1];
                if (previous && previous.path === need.path && previous.sha === need.sha && previous.handle === surface.handle && previous.symbol === surface.symbol && previous.end + 1 === line) previous.end = line;
                else out.push({ path: need.path, start: line, end: line, sha: need.sha, handle: surface.handle, ...(surface.symbol ? { symbol: surface.symbol } : {}) });
            }
        }
    }
    return out;
}
