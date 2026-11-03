import { phoneticObjectGroups } from './naturalQueryPhonetics.js';
import { conceptTermsIn } from './requestFacets.js';
import { bridgeJaQuery, buildJaBridgeVocabulary } from '../retrieval/jaQueryBridge.js';
import type { Facts, Plan, Span, Operation } from './naturalQueryPlan.js';
export interface OperationRequirement {
    id: string;
    clauseId: string;
    text: string;
    kind: 'select' | 'write' | 'delete';
    objectGroups: string[][];
}
export interface OperationWitness {
    requirement: OperationRequirement;
    status: 'witnessed' | 'unsupported' | 'missing';
    spans: Span[];
    operations: Array<{
        path: string;
        line: number;
        kind: Operation['kind'];
    }>;
}
/** Operation vocabulary is query-only and independent of which code words happen to exist. No repository/domain nouns occur here. */
const DELETE = /\b(?:remove|delete|strip|erase|drop)\b|取り除[くき]|削除|除去|消去/iu;
const WRITE = /\b(?:change|update|rewrite|replace|convert)\b|変更|更新|書き換|置き換/iu;
const SELECT = /\b(?:choose|select|which)\b|どの|選[ぶ択]/iu;
const equivalent = (a: string, b: string, vocab: readonly string[]) => a === b || Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)) || vocab.some(v => v.length >= 4 && v.length < Math.min(a.length, b.length) && a.startsWith(v) && b.startsWith(v));
/** Japanese bridge alternatives stay alternatives, not three independently demanded concepts. */
function groups(text: string, facts: Facts): string[][] {
    const vocabulary = [...new Set(facts.declarations.flatMap(d => [...d.nameTerms, ...d.terms]))];
    const bridge = bridgeJaQuery(text, buildJaBridgeVocabulary(vocabulary)).expansions;
    // Uppercase acronyms qualify the operation's surrounding context (e.g. transport/protocol), not a target member's spelling.
    const ascii = text.replace(/\b[A-Z][A-Z0-9]+\b/g, '').match(/[a-zA-Z][a-zA-Z_]+/g)?.join(' ') ?? '';
    return [...conceptTermsIn(ascii).map(t => [t]), ...bridge.flatMap(e => e.via === 'katakana' ? phoneticObjectGroups(e.source, e.tokens) : [[...e.tokens]])];
}
export function operationRequirements(plan: Plan, facts: Facts): OperationRequirement[] {
    const out: OperationRequirement[] = [];
    for (const clause of plan.clauses)
        for (const text of clause.text.split(/\band\b|、/iu)) {
            let kind: OperationRequirement['kind'] | undefined, match: RegExpMatchArray | null = null;
            if ((match = text.match(DELETE)))
                kind = 'delete';
            else if ((match = text.match(WRITE)))
                kind = 'write';
            else if ((match = text.match(SELECT)))
                kind = 'select';
            if (!kind || !match)
                continue;
            const japanese = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(match[0]);
            let object = japanese ? text.split(/[をが]/u)[0]! : text.slice((match.index ?? 0) + match[0].length);
            if (kind === 'select')
                object = text.match(/\bwhich\s+(.+?)\s+(?:to|when|for|is)\b/iu)?.[1] ?? text.match(/どの(.+?)[をが]/u)?.[1] ?? object;
            out.push({ id: `natural-operation:${out.length + 1}`, clauseId: clause.id, text, kind, objectGroups: groups(object, facts) });
        }
    return out;
}
/** Structural operation witnesses are separate from serving. Does not mint a ready decision. */
export function witnessOperations(plan: Plan, facts: Facts): OperationWitness[] {
    const vocabulary = [...new Set(facts.declarations.flatMap(d => [...d.nameTerms, ...d.terms]))];
    return operationRequirements(plan, facts).map(requirement => {
        const spans: Span[] = [], operations: OperationWitness['operations'] = [];
        if (!requirement.objectGroups.length || requirement.objectGroups.some(g => g.length === 0))
            return { requirement, status: 'unsupported', spans, operations };
        const some = (terms: readonly string[]) => requirement.objectGroups.some(group => group.some(q => terms.some(t => equivalent(q, t, vocabulary))));
        const all = (terms: readonly string[]) => requirement.objectGroups.every(group => group.some(q => terms.some(t => equivalent(q, t, vocabulary))));
        for (const row of plan.selections) {
            const d = row.declaration;
            for (const op of d.operations) {
                const valid = d.unresolvedGuardCalls.length === 0 && (requirement.kind === 'select'
                    ? op.kind === 'return' && op.controls.length > 0 && some(op.terms) && all(d.terms)
                    : op.kind === requirement.kind && (op.kind !== 'write' || op.targetShape === 'member' || op.targetShape === 'subscript') && all(op.targetTerms ?? []));
                if (!valid)
                    continue;
                for (const r of d.executableRanges)
                    if (!spans.some(s => s.path === d.path && s.start === r.start && s.end === r.end))
                        spans.push({ path: d.path, ...r, sha: d.sha });
                operations.push({ path: d.path, line: op.line, kind: op.kind });
            }
        }
        return { requirement, status: spans.length ? 'witnessed' : 'missing', spans, operations };
    });
}
/** Only after existing sha-bound source/epoch ledger checks. Both halves are mandatory. */
export function servedOperationProof(witness: OperationWitness, served: readonly Span[]): boolean {
    return witness.status === 'witnessed' && witness.spans.length > 0 && witness.spans.every(w => served.some(s => s.path === w.path && s.sha === w.sha && s.start <= w.start && s.end >= w.end));
}
/** A conjunction we did not interpret is not an optional request. Role clauses are handled by the separate edit contract. */
export function unsupportedOperationSpans(plan: Plan, facts: Facts): string[] {
    const covered = new Set(operationRequirements(plan, facts).map(r => r.text.trim()));
    const out: string[] = [];
    for (const clause of plan.clauses)
        for (const part of clause.text.split(/\band\b|\u3001/iu)) {
            const text = part.trim();
            if (!text || covered.has(text))
                continue;
            const contextual = /^(?:when|while|during|after|before)\b/iu.test(text) || /\u3068\u304d|\u5834\u5408|\u969b/u.test(text);
            if (contextual && clause.terms.length > 0 && clause.terms.every(t => plan.selections.some(s => s.terms.includes(t))))
                continue;
            out.push(text);
        }
    return out;
}
