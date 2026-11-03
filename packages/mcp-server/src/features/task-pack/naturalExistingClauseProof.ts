import type { TaskReadinessEvidence, TaskReadinessObligation } from '@tokenlighten/types';
import { createHash } from 'node:crypto';
import type { TaskPackResult, TaskPackSurface } from './model.js';
import { collectNaturalServedSpans, type NaturalEvidence, type NaturalProjection } from './naturalQueryAdapter.js';
import type { Span } from './naturalQueryPlan.js';
import { facetClauseMatchesItem, facetClausesJointlyOwnItem, facetPlanFor, itemConjunctionParts, type FacetPlanEntry } from './facetGate.js';
import { facetPlanWorkspaceKey } from './engine/facetClosure.js';
import { parseCitedSpans } from './certificateWireInvariant.js';
import { shaOfText } from '../../util/handles.js';
import { buildReadinessObligations } from './engine/readinessObligations.js';
import { buildRequestItemReadiness } from './engine/requestItemReadiness.js';
import { buildFacetReadiness } from './engine/facetReadiness.js';
import { contentPredicateWords } from './engine/requestItemAbsence.js';
import { GENERIC_PROCESS_VERB_WORDS } from './engine/concernProof3.js';
import { textHasWordVariant } from './salientWordMatch.js';
import { isImplementationPath } from './engine/changeAndReadinessEvidence2.js';

export const NATURAL_EXISTING_CLAUSE_PROOF = 'request-item:natural-existing-clause-proof';

/** Transfer unsupported answer clauses to their existing structural owners, never to a generic ready bit. */
export function existingNaturalClauseProjection(
  result: TaskPackResult, workspace: string, natural: NaturalEvidence, projected: NaturalProjection,
  actual: readonly TaskPackSurface[], source: (path: string) => string | undefined,
): NaturalProjection | undefined {
  const syntaxOnlyPartial = natural.runtimeScopeComplete === true && (natural.syntaxErrorPaths?.length ?? 0) > 0 && natural.operations.length === 0;
  if (natural.purpose !== 'answer' || natural.gaps.length === 0 || natural.plan.partial && !syntaxOnlyPartial
    || natural.plan.ambiguities?.length || !natural.declarations?.length
    || projected.obligations.some(o => o.id === 'request-item:natural-query:identity' || o.id.endsWith(':source-changed'))
    || natural.gaps.some(g => /ambiguous|source-changed/.test(g) || g.includes('partial') && !syntaxOnlyPartial)) return undefined;
  const base = buildReadinessObligations(result, 'answer', natural.query, false, workspace);
  const requests = buildRequestItemReadiness(workspace, natural.query, 'answer', result, base);
  const facets = buildFacetReadiness(workspace, natural.query, 'answer', result);
  const plan = facetPlanFor(facetPlanWorkspaceKey(workspace), natural.query, path => {
    const text = source(path);
    return text === undefined ? undefined : shaOfText(text);
  });
  const owners: TaskReadinessObligation[] = [];
  const provedEvidence: TaskReadinessEvidence[] = [];
  const resident = (spans: Span[], evidence: readonly TaskReadinessEvidence[]): boolean => {
    if (!spans.length || !evidence.length || spans.some(s => natural.syntaxErrorPaths?.includes(s.path))) return false;
    const rows = actual.filter(s => evidence.some(e => e.path === s.path && e.handle === s.handle));
    const held = collectNaturalServedSpans(spans, rows, source);
    return spans.every(s => {
      let next = s.start;
      for (const h of held.filter(h => h.path === s.path && h.sha === s.sha).sort((a,b) => a.start-b.start)) {
        if (h.start > next) break;
        next = Math.max(next,h.end+1);
      }
      return next > s.end;
    });
  };
  const completeBodyEvidence = (evidence: readonly TaskReadinessEvidence[], clauseText: string, focal?: NonNullable<FacetPlanEntry['focal']>): TaskReadinessEvidence[] => evidence.flatMap(e => {
    const spans = parseCitedSpans(e.range);
    if (!spans.length || !e.path) return [];
    const predicates = [...contentPredicateWords(clauseText)].filter(word => !GENERIC_PROCESS_VERB_WORDS.has(word));
    const declarations = natural.declarations!.filter(d => d.path === e.path
      && spans.some(([start,end]) => d.start >= start && d.end <= end)
      && (focal === undefined || d.path === focal.path && d.start >= focal.start && d.end <= focal.end
        && (d.name.replace(/::|#/g, '.') === focal.name.replace(/::|#/g, '.')
          || d.container !== undefined && focal.name.replace(/::|#/g, '.') === `${d.container}.${d.name}`.replace(/::|#/g, '.'))));
    // A line shared by several same-named declarations cannot identify one
    // owner. Never choose whichever happens to contain a computed return.
    if (focal !== undefined && declarations.length !== 1) return [];
    return declarations.filter(d => d.operations.some(op => op.kind === 'branch' && predicates.length === 0 || op.kind === 'delete'
      || op.kind === 'write' && (op.targetShape === 'member' || op.targetShape === 'subscript')
      || op.kind === 'return' && (op.computedResult === true || op.controls.length > 0))
      && predicates.every(word => textHasWordVariant([d.name, ...d.operations.map(op => op.callee ?? '')].join(' '), word))
      && resident(d.executableRanges.map(r => ({...r,path:d.path,sha:d.sha})),[e]))
      .map(d => ({...e,range:`${d.start}-${d.end}`}));
  }).slice(0,6);
  const currentFacetEvidence = (evidence: readonly TaskReadinessEvidence[]): boolean => evidence.length > 0 && evidence.every(e => {
    if (!e.path || !isImplementationPath(e.path)) return false;
    const spans = parseCitedSpans(e.range);
    const text = source(e.path);
    return spans.length > 0 && text !== undefined && resident(spans.map(([start,end]) => ({path:e.path!,start,end,sha:createHash('sha256').update(text).digest('hex')})),[e]);
  });
  for (const clause of natural.plan.clauses) {
    const candidates = facets?.entries.filter(e => e.dependency !== true && e.facts.focalResolved) ?? [];
    let matching = candidates.filter(e => facetClauseMatchesItem(e.requirement.clause, clause.text));
    if (!matching.length && facetClausesJointlyOwnItem(candidates.map(e => e.requirement.clause),clause.text))
      matching = candidates.filter(e => itemConjunctionParts(clause.text).some(part => facetClauseMatchesItem(e.requirement.clause,part)));
    if (!matching.length) {
      // A colon lead can introduce several inherited facets. Their shared
      // callable body is a separate duty; suffix facets cannot silently own it.
      const colon = clause.text.indexOf(':');
      const lead = colon > 0 ? clause.text.slice(0,colon).trim() : '';
      const detail = colon > 0 ? clause.text.slice(colon+1).trim() : '';
      const inherited = candidates.filter(e => e.requirement.inheritedFromLead);
      if (lead && detail && facetClausesJointlyOwnItem(inherited.map(e => e.requirement.clause),detail)) {
        const behavior = base.find(o => o.id === 'behavior-body' && o.status === 'proved');
        const focals = plan?.entries.filter(entry => entry.dependency !== true
          && inherited.some(e => e.requirement.facet === entry.facet && e.requirement.clause === entry.clause))
          .flatMap(entry => entry.focal !== undefined && entry.focal.callable !== false ? [entry.focal] : []) ?? [];
        const bodyEvidence = behavior?.status === 'proved'
          ? focals.flatMap(focal => completeBodyEvidence(behavior.evidence ?? [],lead,focal)) : [];
        if (!behavior || !bodyEvidence.length) return undefined;
        const uniqueBodyEvidence = bodyEvidence.filter((entry,index,all) => all.findIndex(other => other.path === entry.path && other.range === entry.range && other.handle === entry.handle) === index).slice(0,6);
        owners.push({...behavior,id:'request-item:natural-facet-lead-body',origin:'query',evidence:uniqueBodyEvidence});
        provedEvidence.push(...uniqueBodyEvidence);
        matching = inherited.filter(e => itemConjunctionParts(detail).some(part => facetClauseMatchesItem(e.requirement.clause,part)));
      }
    }
    if (matching.length) {
      for (const entry of matching) {
        if (entry.facts.kind === 'covered' && entry.obligation.status === 'proved' && currentFacetEvidence(entry.obligation.evidence ?? [])) {
          owners.push(entry.obligation); provedEvidence.push(...(entry.obligation.evidence ?? []));
        } else if (entry.facts.kind === 'open' && entry.obligation.status === 'uncovered' && entry.facts.openTargets.length) owners.push(entry.obligation);
        else return undefined;
      }
      continue;
    }
    const owner = requests.obligations.find(o => o.id === `request-item:${clause.id}`);
    if (!owner) return undefined;
    if (owner.status === 'proved' && completeBodyEvidence(owner.evidence ?? [],clause.text).length > 0) {
      owners.push(owner); provedEvidence.push(...(owner.evidence ?? []));
    } else if (owner.status === 'uncovered' && requests.gap?.ids.includes(clause.id)) owners.push(owner);
    else return undefined;
  }
  if (!owners.length || !provedEvidence.length) return undefined;
  // Specialized clause proof replaces only generic unknown-operation closure.
  // Known effect duties remain independent: a read body never proves deletion.
  const effects = projected.obligations.filter(o => o.id.startsWith('request-item:natural-operation:'));
  const marker: TaskReadinessObligation = {id:NATURAL_EXISTING_CLAUSE_PROOF,kind:'concern',required:true,status:'proved',origin:'query',evidence:provedEvidence,
    reason:'every original clause retains an executable-body or resolved facet owner; natural operation effects remain independent'};
  const obligations = [...new Map([...owners,...effects,marker].map(o => [o.id,o])).values()];
  return {active:true,ownedClauseIds:new Set(),ownedFacetClauses:new Set(),obligations,missingTargets:[],evidence:provedEvidence,
    proved:obligations.every(o => o.status === 'proved')};
}
