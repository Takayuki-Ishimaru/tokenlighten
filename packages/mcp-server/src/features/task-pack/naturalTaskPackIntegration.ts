import { existingNaturalClauseProjection, NATURAL_EXISTING_CLAUSE_PROOF } from './naturalExistingClauseProof.js';
import type { TaskProfile, ToolCall } from '@tokenlighten/types';
import type { TaskPackResult } from './model.js';
import { epochServedEvidence } from './engine/epochContract2.js';
import { buildReadinessObligations } from './engine/readinessObligations.js';
import { readCached } from './engine/packBasics2.js';
import { currentSessionLane } from '../../util/laneKey.js';
import { createHash } from 'node:crypto';
import { tokenizeForEpoch } from '../../state/session.js';
import { collectNaturalServedSpans, currentNaturalEvidence, exactQueryIdentity, projectNaturalEvidence, type NaturalProjection } from './naturalQueryAdapter.js';
const WIRING_OBLIGATION_IDS = ['wiring-source', 'wiring-consumer', 'wiring-link', 'wiring-insertion'];
/** Qualifies a fresh specialized rebuild; this is never permission to return a cached act. */
export function hasNaturalWiringCertificate(result: Pick<TaskPackResult, 'execution_contract'>): boolean {
    const certified = result.execution_contract?.readiness_certificate?.obligations ?? [];
    return WIRING_OBLIGATION_IDS.every(id => certified.some(o => o.id === `request-item:natural-${id}` && o.status === 'proved'));
}
/** A specialized certificate qualifies only a fresh rebuild, never a direct cached act. */
export function hasNaturalSpecializedCertificate(result: Pick<TaskPackResult, 'execution_contract'>): boolean {
    return hasNaturalWiringCertificate(result) || (result.execution_contract?.readiness_certificate?.obligations ?? [])
        .some(o => o.id === NATURAL_EXISTING_CLAUSE_PROOF && o.status === 'proved');
}
/** A saved certificate must contain this call's complete, freshly proved plan. */
export function naturalCertificateMatches(result: TaskPackResult, projection: NaturalProjection | undefined): boolean {
    if (!projection?.active || !projection.proved || projection.obligations.length === 0) return false;
    const certified = result.execution_contract?.readiness_certificate?.obligations ?? [];
    return projection.obligations.every(required => required.status === 'proved'
        && certified.some(row => row.id === required.id && row.status === 'proved'));
}
export function naturalProjectionForPack(result: TaskPackResult, workspace: string | undefined, query: string, profile: TaskProfile): NaturalProjection | undefined {
    const natural = currentNaturalEvidence();
    if (!natural || workspace === undefined)
        return undefined;
    const source = (path: string) => readCached(workspace, path);
    const actual = epochServedEvidence(workspace, result, tokenizeForEpoch(natural.query), profile);
    const served = collectNaturalServedSpans(natural.required, actual, source);
    const projected = projectNaturalEvidence({ ...natural.identity, workspace, queryIdentity: exactQueryIdentity(query), profile, lane: currentSessionLane() }, served, path => { const text = source(path); return text === undefined ? undefined : createHash('sha256').update(text).digest('hex'); }, natural);
    // A selected wiring task has a specialized structural prover. Its edit
    // substrate need not satisfy the generic configuration-edit planner, but
    // every producer/consumer/link/insertion duty must still be proved and
    // carried onto the actual final certificate. No query clause is waived.
    if (natural.purpose === 'edit' && natural.gaps.length > 0
        && !projected.obligations.some(o => o.id === 'request-item:natural-query:identity')
        && result.wiring?.strategy === 'semantic-multihop'
        && result.wiring.status === 'ready'
        && result.wiring.connections.length === 1
        && result.wiring.connections[0]?.status === 'ready') {
        const existing = buildReadinessObligations(result, 'wiring', natural.query, false, workspace);
        const obligations = WIRING_OBLIGATION_IDS.map(id => existing.find(o => o.id === id));
        if (obligations.every(o => o !== undefined && o.status === 'proved')) {
            const required = obligations.map(o => ({ ...o!, id: `request-item:natural-${o!.id}` }));
            return { active: true, ownedClauseIds: new Set(), ownedFacetClauses: new Set(),
                obligations: required, missingTargets: [], evidence: required.flatMap(o => o.evidence ?? []), proved: true };
        }
    }
    return existingNaturalClauseProjection(result, workspace, natural, projected, actual, source) ?? projected;
}
export function mergeNaturalContinuation(current: {
    next_call: ToolCall;
    ids: string[];
} | undefined, natural: NaturalProjection | undefined, query: string): {
    next_call: ToolCall;
    ids: string[];
} | undefined {
    if (!natural?.active || !natural.missingTargets.length)
        return current;
    const old = current?.next_call.tool === 'tl_read_file' && Array.isArray(current.next_call.arguments.targets) ? current.next_call.arguments.targets as Array<{
        path: string;
        range?: string;
    }> : [];
    const targets = [...natural.missingTargets, ...old].filter((t, i, a) => a.findIndex(x => x.path === t.path && x.range === t.range) === i).slice(0, 6);
    return { next_call: { tool: 'tl_read_file', arguments: { query, targets, content: 'auto' } }, ids: [...new Set([...(current?.ids ?? []), ...natural.obligations.filter(o => o.status === 'uncovered').map(o => o.id.replace(/^request-item:/, ''))])] };
}
export function removeOwnedNaturalDisclosures(result: TaskPackResult, natural: NaturalProjection | undefined): void {
    if (!natural?.active || !natural.ownedClauseIds.size || !result.request_item_absences)
        return;
    result.request_item_absences = result.request_item_absences.filter(a => !natural.ownedClauseIds.has(a.id.replace(/^request-item:/, '')));
}
