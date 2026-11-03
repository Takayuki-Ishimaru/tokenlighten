import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { witnessOperations, unsupportedOperationSpans } from './naturalQueryWitnesses.js';
import { withTreeSitterRoot, type TreeSitterNode as Node } from '../../skeleton/treeSitter.js';
import { conceptTermsIn } from './requestFacets.js';
import { extractRequestItems } from './requestItems.js';
import { bridgeJaQuery, buildJaBridgeVocabulary } from '../retrieval/jaQueryBridge.js';
/** Caller supplies authorized current source snapshots; this module does no I/O. */
export interface Source {
    path: string;
    text: string;
    language: string;
    role: 'implementation' | 'test' | 'documentation' | 'configuration';
}
export interface Span {
    path: string;
    start: number;
    end: number;
    sha: string;
}
export interface Operation {
    kind: 'write' | 'delete' | 'return' | 'branch' | 'call';
    line: number;
    terms: string[];
    controls: number[];
    callee?: string;
    receiver?: string;
    guard?: true;
    resultTerms?: string[];
    targetTerms?: string[];
    targetShape?: 'local' | 'member' | 'subscript';
    /** Return computes a result; a bare input/literal/name is not an implementation effect. */
    computedResult?: true;
}
export interface Declaration extends Span {
    id: string;
    name: string;
    container?: string;
    nameTerms: string[];
    terms: string[];
    operations: Operation[];
    calls: string[];
    guardCalls: string[];
    valueCalls: Array<{
        id: string;
        terms: string[];
    }>;
    executableRanges: Array<{
        start: number;
        end: number;
    }>;
    unresolvedGuardCalls: Array<{
        line: number;
        callee?: string;
    }>;
}
export interface Facts {
    declarations: Declaration[];
    partial: boolean;
    unavailable: string[];
    /** False for any unexamined source/budget/parser capability; syntax errors are tracked separately. */
    scopeComplete?: boolean;
    syntaxErrorPaths?: string[];
}
export interface Clause {
    id: string;
    text: string;
    terms: string[];
    unknown: string[];
}
export interface Selection {
    declaration: Declaration;
    score: number;
    terms: string[];
    clauses: string[];
}
export interface Plan {
    clauses: Clause[];
    selections: Selection[];
    gaps: string[];
    partial: boolean;
    ambiguities?: string[];
}
const MAX_SOURCES = 96, MAX_BYTES = 4 * 1024 * 1024, MAX_NODES = 200000, MAX_DECLARATIONS = 2048, MAX_SELECTED = 12;
const callable = new Set(['function_definition', 'function_declaration', 'generator_function_declaration', 'method_definition', 'method_declaration', 'function_item', 'method', 'singleton_method']);
const container = new Set(['class_definition', 'class_declaration', 'struct_specifier', 'impl_item']);
const ignored = /^(?:comment|line_comment|block_comment|import_statement|import_from_statement|import_declaration|future_import_statement|use_declaration)$/;
const kinds: Record<string, Operation['kind']> = { assignment: 'write', augmented_assignment: 'write', assignment_expression: 'write', augmented_assignment_expression: 'write', variable_declarator: 'write', delete_statement: 'delete', return_statement: 'return', if_statement: 'branch', conditional_expression: 'branch', for_statement: 'branch', for_in_statement: 'branch', while_statement: 'branch', match_statement: 'branch', switch_statement: 'branch', call: 'call', call_expression: 'call' };
function children(n: Node): Node[] { return Array.from({ length: n.namedChildCount }, (_, i) => n.namedChild(i)).filter((x): x is Node => x !== null); }
function raw(s: Source, n: Node): string { return s.text.slice(n.startIndex, n.endIndex); }
function words(text: string): string[] { return [...new Set(conceptTermsIn(text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').replace(/_/g, ' ')))]; }
function docstring(n: Node): boolean { return n.type === 'expression_statement' && ['string', 'concatenated_string'].includes(n.namedChild(0)?.type ?? ''); }
function tokenLeaf(n: Node): boolean { return /(?:^|_)(?:identifier|property_identifier|field_identifier|string|string_content|string_fragment)$/.test(n.type); }
interface TermBudget {
    visits: number;
    exhausted: boolean;
}
function termsOf(s: Source, n: Node, budget?: TermBudget): string[] { const out = new Set<string>(); const walk = (p: Node): void => { if (budget && (budget.exhausted || ++budget.visits > 1000000)) {
    budget.exhausted = true;
    return;
} if (ignored.test(p.type) || docstring(p) || callable.has(p.type))
    return; if (tokenLeaf(p)) {
    const value = raw(s, p).replace(/^[rubf]*[\"']+|[\"']+$/gi, '');
    if (p.type.includes('string') && !/^[A-Za-z_$][A-Za-z0-9_.$-]{0,63}$/.test(value))
        return;
    for (const t of words(value))
        out.add(t);
    return;
} for (const c of children(p))
    walk(c); }; walk(n); return [...out]; }
function atLine(s: Source, n: Node, end = false): number { const pos = end ? n.endPosition : n.startPosition; return pos ? pos.row + 1 : s.text.slice(0, end ? n.endIndex : n.startIndex).split('\n').length; }
/** Language grammar nodes, never regex body extraction. Unsupported/parse-error trees disclose an incomplete pool. */
export async function extractRuntimeFacts(sources: readonly Source[]): Promise<Facts> {
    const result: Facts = { declarations: [], partial: false, unavailable: [], scopeComplete: true, syntaxErrorPaths: [] };
    const termBudget: TermBudget = { visits: 0, exhausted: false };
    let bytes = 0, nodes = 0, implementationSources = 0, examinedSources = 0;
    const classes = new Map<string, {
        path: string;
        name: string;
        bases: string[];
    }>();
    const imports = new Map<string, Map<string, {
        path: string;
        name: string;
    }>>();
    for (const s of sources) {
        if (++examinedSources > 2048) {
            result.partial = true;
            result.scopeComplete = false;
            break;
        }
        if (s.role !== 'implementation')
            continue;
        if (++implementationSources > MAX_SOURCES) {
            result.partial = true;
            result.scopeComplete = false;
            break;
        }
        bytes += Buffer.byteLength(s.text);
        if (bytes > MAX_BYTES || result.declarations.length >= MAX_DECLARATIONS) {
            result.partial = true;
            result.scopeComplete = false;
            break;
        }
        if (s.text.length > 1024 * 1024) {
            result.partial = true;
            result.scopeComplete = false;
            continue;
        }
        const sha = createHash('sha256').update(s.text).digest('hex');
        const parsed = await withTreeSitterRoot(s.text, s.language, {}, root => {
            const imps = new Map<string, {
                path: string;
                name: string;
            }>();
            imports.set(s.path, imps);
            for (const n of children(root))
                if (n.type === 'import_from_statement') {
                    const cs = children(n), mod = cs[0];
                    if (!mod || mod.type !== 'relative_import')
                        continue;
                    const prefix = children(mod).find(c => c.type === 'import_prefix'), module = children(mod).find(c => c.type === 'dotted_name');
                    if (!prefix)
                        continue;
                    const dots = raw(s, prefix).length;
                    let dir = posix.dirname(s.path);
                    for (let i = 1; i < dots; i++)
                        dir = posix.dirname(dir);
                    const stem = posix.join(dir, module ? raw(s, module).replaceAll('.', '/') : '');
                    const targets = sources.filter(src => src.path === stem + '.py' || src.path === posix.join(stem, '__init__.py'));
                    if (targets.length !== 1)
                        continue;
                    for (const c of cs.slice(1)) {
                        const alias = c.childForFieldName('alias'), original = c.childForFieldName('name');
                        const name = original ? raw(s, original) : raw(s, c);
                        imps.set(alias ? raw(s, alias) : name, { path: targets[0]!.path, name });
                    }
                }
            const walk = (n: Node, owner?: string): void => {
                if (++nodes > MAX_NODES) {
                    result.partial = true;
                    result.scopeComplete = false;
                    return;
                }
                if (n.type === 'ERROR' || n.type === 'MISSING') {
                    result.partial = true;
                    if (!result.syntaxErrorPaths!.includes(s.path)) result.syntaxErrorPaths!.push(s.path);
                    return;
                }
                if (ignored.test(n.type))
                    return;
                if (container.has(n.type)) {
                    const name = n.childForFieldName('name');
                    if (name) {
                        const bases = n.childForFieldName('superclasses');
                        classes.set(`${s.path}:${raw(s, name)}`, { path: s.path, name: raw(s, name), bases: bases ? children(bases).filter(b => b.type === 'identifier').map(b => raw(s, b)) : [] });
                    }
                    for (const c of children(n))
                        walk(c, name ? raw(s, name) : owner);
                    return;
                }
                if (callable.has(n.type)) {
                    const named = n.childForFieldName('name'), body = n.childForFieldName('body');
                    if (!named || !body)
                        return;
                    const name = raw(s, named), start = atLine(s, n), end = atLine(s, n, true), id = `${s.path}:${start}-${end}`;
                    const operations: Operation[] = [];
                    const runtimeLines = new Set<number>([start]);
                    for (let line = start; line < atLine(s, body); line++)
                        runtimeLines.add(line);
                    let invalid = false;
                    const visit = (p: Node, controls: number[], guard = false, resultTerms: string[] = []): void => {
                        if (++nodes > MAX_NODES) {
                            result.partial = true;
                            result.scopeComplete = false;
                            invalid = true;
                            return;
                        }
                        if (p.type === 'ERROR' || p.type === 'MISSING') {
                            result.partial = true;
                            if (!result.syntaxErrorPaths!.includes(s.path)) result.syntaxErrorPaths!.push(s.path);
                            invalid = true;
                            return;
                        }
                        if (ignored.test(p.type) || docstring(p) || callable.has(p.type))
                            return;
                        const kind = kinds[p.type];
                        const line = atLine(s, p);
                        if (kind || p.namedChildCount === 0) {
                            const end = p.namedChildCount === 0 ? atLine(s, p, true) : line;
                            for (let i = line; i <= end; i++)
                                runtimeLines.add(i);
                        }
                        if (kind) {
                            const left = p.childForFieldName('left') ?? p.childForFieldName('name');
                            const op: Operation = { kind, line, terms: termsOf(s, p, termBudget), controls, ...(guard ? { guard: true as const } : {}), ...(resultTerms.length ? { resultTerms } : {}), ...(kind === 'write' && left ? { targetTerms: termsOf(s, left, termBudget), targetShape: (['attribute', 'member_expression'].includes(left.type) ? 'member' : ['subscript', 'subscript_expression'].includes(left.type) ? 'subscript' : 'local') as 'local' | 'member' | 'subscript' } : kind === 'delete' ? { targetTerms: termsOf(s, p, termBudget) } : {}) };
                            if (kind === 'return' && children(p).some(c => ['binary_expression', 'comparison_operator', 'boolean_operator', 'conditional_expression', 'ternary_expression', 'unary_expression', 'unary_operator'].includes(c.type))) op.computedResult = true;
                            if (kind === 'call') {
                                const f = p.childForFieldName('function');
                                if (f) {
                                    const attribute = f.childForFieldName('attribute') ?? f.childForFieldName('property');
                                    const object = f.childForFieldName('object');
                                    op.callee = attribute ? raw(s, attribute) : f.type === 'identifier' ? raw(s, f) : undefined;
                                    op.receiver = object ? raw(s, object) : undefined;
                                }
                            }
                            operations.push(op);
                        }
                        for (const c of children(p)) {
                            const condition = p.childForFieldName('condition');
                            const lhs = p.childForFieldName('left') ?? p.childForFieldName('name');
                            visit(c, kind === 'branch' ? [...controls, line] : controls, guard || condition?.startIndex === c.startIndex && condition.endIndex === c.endIndex, kind === 'write' && lhs ? termsOf(s, lhs, termBudget) : resultTerms);
                        }
                    };
                    visit(body, []);
                    const executableRanges: Array<{
                        start: number;
                        end: number;
                    }> = [];
                    for (const line of [...runtimeLines].sort((a, b) => a - b)) {
                        const last = executableRanges.at(-1);
                        if (last && last.end + 1 === line)
                            last.end = line;
                        else
                            executableRanges.push({ start: line, end: line });
                    }
                    const runtimeTerms = termsOf(s, body, termBudget);
                    if (!invalid && !termBudget.exhausted && result.declarations.length < MAX_DECLARATIONS)
                        result.declarations.push({ path: s.path, start, end, sha, id, name, container: owner, nameTerms: words(name), terms: runtimeTerms, operations, calls: [], guardCalls: [], valueCalls: [], executableRanges, unresolvedGuardCalls: [] });
                    else if (result.declarations.length >= MAX_DECLARATIONS) {
                        result.partial = true;
                        result.scopeComplete = false;
                    }
                    // Nested declarations are independent candidates, never part of their parent's runtime terms.
                    for (const c of children(body))
                        if (callable.has(c.type))
                            walk(c, owner);
                    return;
                }
                for (const c of children(n))
                    walk(c, owner);
            };
            walk(root);
            return true;
        });
        if (!parsed) {
            result.unavailable.push(s.path);
            result.scopeComplete = false;
        }
        if (termBudget.exhausted) {
            result.partial = true;
            result.scopeComplete = false;
            break;
        }
    }
    for (const d of result.declarations)
        for (const op of d.operations.filter(x => x.kind === 'call' && x.callee)) {
            let matches = result.declarations.filter(other => other.path === d.path && other.name === op.callee && (op.receiver === 'self' || op.receiver === 'this' ? other.container === d.container && d.container !== undefined : op.receiver === undefined && other.container === undefined));
            if (matches.length === 0 && (op.receiver === 'self' || op.receiver === 'this') && d.container) {
                // A single statically imported base only. Multiple inheritance/dynamic bases stay unresolved.
                let cls = classes.get(`${d.path}:${d.container}`);
                const seen = new Set<string>();
                for (let depth = 0; cls && depth < 4 && matches.length === 0; depth++) {
                    if (cls.bases.length !== 1)
                        break;
                    const base = cls.bases[0]!;
                    const imported = imports.get(cls.path)?.get(base);
                    const key = imported ? `${imported.path}:${imported.name}` : `${cls.path}:${base}`;
                    if (seen.has(key))
                        break;
                    seen.add(key);
                    cls = classes.get(key);
                    if (cls)
                        matches = result.declarations.filter(other => other.path === cls!.path && other.container === cls!.name && other.name === op.callee);
                }
            }
            if (matches.length === 1 && (op.receiver === 'self' || op.receiver === 'this') && d.container) {
                // Receiver is dynamically dispatched. A known subtype override is not the base method's identity.
                const possibleOverrides = result.declarations.filter(other => other.name === op.callee && other.container && other.id !== matches[0]!.id).filter(other => {
                    let cls = classes.get(`${other.path}:${other.container}`);
                    const seen = new Set<string>();
                    for (let depth = 0; cls && depth < 4; depth++) {
                        if (cls.bases.length !== 1)
                            return false;
                        const base = cls.bases[0]!;
                        const imported = imports.get(cls.path)?.get(base);
                        const key = imported ? `${imported.path}:${imported.name}` : `${cls.path}:${base}`;
                        if (key === `${d.path}:${d.container}`)
                            return true;
                        if (seen.has(key))
                            return false;
                        seen.add(key);
                        cls = classes.get(key);
                    }
                    return false;
                });
                if (possibleOverrides.length)
                    matches = [...matches, ...possibleOverrides];
            }
            if (op.guard && matches.length !== 1)
                d.unresolvedGuardCalls.push({ line: op.line, callee: op.callee });
            if (matches.length === 1) {
                d.calls.push(matches[0]!.id);
                if (op.guard)
                    d.guardCalls.push(matches[0]!.id);
                if (op.resultTerms?.length)
                    d.valueCalls.push({ id: matches[0]!.id, terms: op.resultTerms });
            }
        }
    return result;
}
function matches(a: string, b: string): boolean { return a === b || Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)); }
/** Uses the existing request-item splitter and repository-grounded Japanese bridge. Unknown terms stay visible, never become absence proof. */
export function normalizeNaturalQuery(query: string, facts: Facts, projectNames: readonly string[] = []): Clause[] {
    const vocabulary = [...new Set(facts.declarations.flatMap(d => [...d.nameTerms, ...d.terms]))];
    const vocab = buildJaBridgeVocabulary(vocabulary, { partial: facts.partial });
    const project = new Set(projectNames.flatMap(words));
    const items = extractRequestItems(query);
    const spans = items.length ? items.map(i => ({ id: i.id, text: i.text })) : [{ id: 'ri-1', text: query }];
    return spans.slice(0, 8).map(item => { const expansions = bridgeJaQuery(item.text, vocab).expansions.flatMap(x => x.tokens); const all = [...new Set([...words(item.text), ...expansions])].filter(t => !project.has(t)); return { ...item, terms: all.filter(t => vocabulary.some(w => matches(t, w))), unknown: all.filter(t => !vocabulary.some(w => matches(t, w))) }; });
}
/** Bounded diverse retrieval, NOT readiness certification. Rank cannot prove semantics. */
export function planNaturalQuery(query: string, facts: Facts, projectNames: readonly string[] = []): Plan {
    const clauses = normalizeNaturalQuery(query, facts, projectNames);
    const counts = new Map<string, number>();
    for (const c of clauses)
        for (const t of c.terms)
            counts.set(t, facts.declarations.filter(d => d.terms.some(w => matches(t, w))).length);
    const all = facts.declarations.map(d => {
        const terms = [...new Set(clauses.flatMap(c => c.terms))].filter(t => d.terms.some(w => matches(t, w)));
        const clauseIds = clauses.filter(c => c.terms.filter(t => terms.includes(t)).length >= Math.min(2, c.terms.length) && c.terms.length > 0).map(c => c.id);
        const effect = d.operations.some(op => ['return', 'write', 'delete'].includes(op.kind) && op.terms.some(w => terms.some(t => matches(t, w))));
        const weights = terms.reduce((n, t) => n + Math.log(1 + facts.declarations.length / (1 + (counts.get(t) ?? 0))), 0);
        const score = effect ? weights + Math.min(2, d.operations.filter(op => op.kind === 'branch').length) * 0.15 : 0;
        return { declaration: d, score, terms, clauses: clauseIds };
    }).filter(x => x.score > 0 && x.terms.length >= 1).sort((a, b) => b.score - a.score || a.declaration.id.localeCompare(b.declaration.id));
    const wanted = [...new Set(clauses.flatMap(c => c.terms))];
    const selecting = /\b(?:which|choose|select)\b|\u3069\u306e|\u9078[\u3076\u629e]/iu.test(query);
    const selectedObject = query.match(/\bwhich\s+(.+?)\s+(?:to|when|for|is)\b/iu)?.[1] ?? query.match(/\u3069\u306e(.+?)[\u3092\u304c]/u)?.[1];
    const selectedTerms = selectedObject ? normalizeNaturalQuery(selectedObject, facts, projectNames).flatMap(c => c.terms) : wanted;
    const closure = (root: Selection): Selection[] => {
        const selected = new Map<string, Selection>([[root.declaration.id, root]]);
        for (let depth = 0; depth < 2; depth++)
            for (const row of [...selected.values()])
                for (const id of row.declaration.calls) {
                    let dep = all.find(x => x.declaration.id === id && x.terms.length >= 2);
                    const influential = row.declaration.guardCalls.includes(id) || row.declaration.valueCalls.some(v => v.id === id && v.terms.some(w => wanted.some(t => matches(t, w))));
                    if (!dep && influential) {
                        const d = facts.declarations.find(x => x.id === id);
                        if (d)
                            dep = all.find(x => x.declaration.id === id) ?? { declaration: d, score: 0, terms: [], clauses: row.clauses };
                    }
                    if (dep && selected.size < MAX_SELECTED)
                        selected.set(id, dep);
                }
        return [...selected.values()];
    };
    const alternatives = all.slice(0, 24).map(root => { const selections = closure(root); const covered = new Set(selections.flatMap(s => s.terms)); const witnesses = witnessOperations({ clauses, selections, gaps: [], partial: facts.partial }, facts); return { selections, witnesses, coverage: clauses.reduce((n, c) => n + (c.terms.length ? c.terms.filter(t => covered.has(t)).length / c.terms.length : 0), 0) }; })
        .filter(a => a.witnesses.length === 0 || a.witnesses.every(w => w.status === 'witnessed'))
        .filter(a => a.selections.some(s => s.declaration.operations.some(op => (selecting ? op.kind === 'return' : ['return', 'write', 'delete'].includes(op.kind)) && op.controls.length > 0 && op.terms.some(w => (selecting ? selectedTerms : wanted).some(t => matches(t, w))))))
        .sort((a, b) => b.coverage - a.coverage || a.selections.length - b.selections.length || b.selections[0]!.score - a.selections[0]!.score);
    const best = alternatives[0];
    const selections = best?.selections ?? [];
    const identities = (a: typeof best) => new Set(a?.witnesses.flatMap(w => w.spans.map(s => `${s.path}:${s.start}-${s.end}`)) ?? []);
    const bestWitnesses = identities(best);
    const ambiguities = best ? alternatives.slice(1).filter(a => a.coverage >= best.coverage && a.witnesses.length > 0 && ![...identities(a)].some(id => bestWitnesses.has(id))).map(a => a.selections[0]!.declaration.id) : [];
    const unsupported = unsupportedOperationSpans({ clauses, selections, gaps: [], partial: facts.partial }, facts);
    const gaps = clauses.filter(c => c.terms.length < 1 || !selections.some(s => s.clauses.includes(c.id))).map(c => c.id);
    return { clauses, selections, gaps: [...gaps, ...unsupported.map((_, i) => `natural-query:unsupported-span:${i + 1}`), ...(ambiguities.length ? ['natural-query:ambiguous-operation'] : [])], partial: facts.partial || facts.unavailable.length > 0, ...(ambiguities.length ? { ambiguities } : {}) };
}
/** The integration must invoke this on ledger-backed exact source spans, not proposed selections. It only proves span residency. */
export function requiredSpanCoverage(plan: Plan, served: readonly Span[]): {
    id: string;
    covered: boolean;
    missing: Span[];
}[] {
    return plan.clauses.map(c => { const required = plan.selections.filter(s => s.clauses.includes(c.id)).flatMap(s => s.declaration.executableRanges.map(r => ({ path: s.declaration.path, sha: s.declaration.sha, ...r }))); const missing = required.filter(w => !served.some(s => s.path === w.path && s.sha === w.sha && s.start <= w.start && s.end >= w.end)); return { id: c.id, covered: required.length > 0 && missing.length === 0 && !plan.gaps.includes(c.id), missing }; });
}
