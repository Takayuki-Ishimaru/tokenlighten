import { countLines } from "../../util/countLines.js";
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { withTreeSitterRoot, type TreeSitterNode as Node } from '../../skeleton/treeSitter.js';
import { conceptTermsIn } from './requestFacets.js';
import type { Source, Span, Plan, Facts, Declaration } from './naturalQueryPlan.js';
export type EditRole = 'configuration' | 'documentation' | 'test' | 'behavior-test';
export interface RoleRelation {
    role: EditRole;
    spans: Span[];
    owner: {
        path: string;
        name: string;
    };
    member: string;
    key?: string;
    relation: 'runtime-key-definition' | 'key-document-section' | 'typed-owner-member-assertion' | 'shared-member-behavior-regression';
}
export interface EditSurfacePlan {
    relations: RoleRelation[];
    missing: EditRole[];
    partial: boolean;
    implementationSpans: Span[];
    additionalTargets: Array<{
        path: string;
        range: string;
        symbol: string;
    }>;
}
interface Access {
    receiver: string;
    member: string;
    key?: string;
    line: number;
    assertion: boolean;
    write?: boolean;
}
interface Call {
    callee: string;
    args: string[];
    line: number;
}
interface Fn {
    name: string;
    owner?: string;
    fixture: boolean;
    returns: string[];
    localTypes: Array<{
        name: string;
        bases: string[];
    }>;
    returnedCalls: Call[];
    start: number;
    end: number;
    params: string[];
    assignments: Array<{
        target: string;
        callee: string;
        args: string[];
    }>;
    accesses: Access[];
    calls: Call[];
}
interface Module {
    source: Source;
    sha: string;
    classes: Map<string, {
        start: number;
        end: number;
        bases: string[];
    }>;
    imports: Map<string, {
        module: string;
        name?: string;
    }>;
    functions: Fn[];
    definitions: Array<{
        owner: string;
        member: string;
        keys: string[];
        start: number;
        end: number;
    }>;
}
const children = (n: Node): Node[] => Array.from({ length: n.namedChildCount }, (_, i) => n.namedChild(i)).filter((x): x is Node => x !== null);
const literal = (text: string) => /^(['"])([A-Za-z_][A-Za-z0-9_.-]{0,127})\1$/.exec(text)?.[2];
const terms = (text: string) => conceptTermsIn(text.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' '));
const sameTerm = (a: string, b: string) => a === b || Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a));
/** Self-contained metadata only: Tree-sitter nodes never escape their lifetime. */
async function parseSource(source: Source): Promise<Module | undefined> {
    if (source.language !== 'python' || Buffer.byteLength(source.text) > 1024 * 1024)
        return undefined;
    const sha = createHash('sha256').update(source.text).digest('hex');
    return withTreeSitterRoot(source.text, source.language, {}, root => {
        const mod: Module = { source, sha, classes: new Map(), imports: new Map(), functions: [], definitions: [] };
        let count = 0;
        const text = (n: Node) => source.text.slice(n.startIndex, n.endIndex);
        const line = (n: Node, end = false) => (end ? n.endPosition : n.startPosition)!.row + 1;
        for (const n of children(root)) {
            if (n.type === 'import_statement')
                for (const c of children(n)) {
                    const name = c.childForFieldName('name'), alias = c.childForFieldName('alias');
                    const module = name ? text(name) : text(c);
                    mod.imports.set(alias ? text(alias) : module.split('.')[0]!, { module });
                }
            if (n.type === 'import_from_statement') {
                const cs = children(n), module = cs[0] ? text(cs[0]) : '';
                for (const c of cs.slice(1)) {
                    const name = c.childForFieldName('name'), alias = c.childForFieldName('alias');
                    const original = name ? text(name) : text(c);
                    if (/^[A-Za-z_]\w*$/.test(original))
                        mod.imports.set(alias ? text(alias) : original, { module, name: original });
                }
            }
        }
        const ignored = (n: Node) => n.type === 'comment' || n.type.startsWith('import_') || n.type === 'expression_statement' && ['string', 'concatenated_string'].includes(n.namedChild(0)?.type ?? '');
        const call = (n: Node): Call | undefined => { if (n.type !== 'call')
            return; const f = n.childForFieldName('function'), args = n.childForFieldName('arguments'); if (!f)
            return; const callee = text(f); if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(callee))
            return; return { callee, args: args ? children(args).map(text) : [], line: line(n) }; };
        const visit = (n: Node, owner?: string, fixture = false): void => {
            if (++count > 200000)
                throw new Error('role-node-budget');
            if (ignored(n))
                return;
            if (n.type === 'ERROR')
                throw new Error('role-parse-error');
            if (n.type === 'decorated_definition') {
                const isFixture = children(n).some(c => c.type === 'decorator' && /\bfixture(?:\(|$)/.test(text(c)));
                for (const c of children(n))
                    visit(c, owner, isFixture);
                return;
            }
            if (n.type === 'class_definition') {
                const name = n.childForFieldName('name');
                if (!name)
                    return;
                owner = text(name);
                mod.classes.set(owner, { start: line(n), end: line(n, true), bases: n.childForFieldName('superclasses') ? children(n.childForFieldName('superclasses')!).map(text) : [] });
                for (const c of children(n))
                    visit(c, owner);
                return;
            }
            if (n.type === 'function_definition') {
                const name = n.childForFieldName('name'), body = n.childForFieldName('body'), params = n.childForFieldName('parameters');
                if (!name || !body)
                    return;
                const fn: Fn = { name: text(name), owner, fixture, returns: [], localTypes: [], returnedCalls: [], start: line(n), end: line(n, true), params: params ? children(params).map(p => p.type === 'identifier' ? text(p) : p.childForFieldName('name') ? text(p.childForFieldName('name')!) : '').filter(Boolean) : [], assignments: [], accesses: [], calls: [] };
                const walk = (p: Node, assertion = false): void => {
                    if (++count > 200000)
                        throw new Error('role-node-budget');
                    if (ignored(p))
                        return;
                    if (p.type === 'function_definition') {
                        const nestedName = p.childForFieldName('name');
                        const returned = children(body).some(c => c.type === 'return_statement' && children(c).some(v => v.type === 'identifier' && nestedName && text(v) === text(nestedName)));
                        if (returned) {
                            const walkReturned = (c: Node): void => { if (ignored(c))
                                return; const called = call(c); if (called)
                                fn.returnedCalls.push(called); for (const x of children(c))
                                walkReturned(x); };
                            const nestedBody = p.childForFieldName('body');
                            if (nestedBody)
                                walkReturned(nestedBody);
                        }
                        return;
                    }
                    if (p.type === 'ERROR')
                        throw new Error('role-parse-error');
                    if (p.type === 'class_definition') {
                        const name = p.childForFieldName('name'), bases = p.childForFieldName('superclasses');
                        if (name)
                            fn.localTypes.push({ name: text(name), bases: bases ? children(bases).map(text) : [] });
                    }
                    if (p.type === 'return_statement' || p.type === 'yield') {
                        for (const c of children(p))
                            fn.returns.push(text(c));
                    }
                    assertion = assertion || p.type === 'assert_statement';
                    const called = call(p);
                    if (called)
                        fn.calls.push(called);
                    if (p.type === 'assignment') {
                        const left = p.childForFieldName('left'), right = p.childForFieldName('right');
                        const value = right ? call(right) : undefined;
                        if (left?.type === 'identifier' && value)
                            fn.assignments.push({ target: text(left), callee: value.callee, args: value.args });
                        if (left) {
                            let base = left;
                            while (base.type === 'subscript' && base.childForFieldName('value'))
                                base = base.childForFieldName('value')!;
                            if (base.type === 'attribute') {
                                const object = base.childForFieldName('object'), member = base.childForFieldName('attribute');
                                if (object && member)
                                    fn.accesses.push({ receiver: text(object), member: text(member), line: line(p), assertion, write: true });
                            }
                        }
                    }
                    if (p.type === 'subscript') {
                        const value = p.childForFieldName('value'), index = p.childForFieldName('subscript');
                        if (value?.type === 'attribute') {
                            const object = value.childForFieldName('object'), attribute = value.childForFieldName('attribute');
                            if (object && attribute)
                                fn.accesses.push({ receiver: text(object), member: text(attribute), ...(index && literal(text(index)) ? { key: literal(text(index)) } : {}), line: line(p), assertion });
                        }
                    }
                    if (p.type === 'attribute') {
                        const object = p.childForFieldName('object'), attribute = p.childForFieldName('attribute');
                        if (object && attribute)
                            fn.accesses.push({ receiver: text(object), member: text(attribute), line: line(p), assertion });
                    }
                    for (const c of children(p))
                        walk(c, assertion);
                };
                walk(body);
                mod.functions.push(fn);
                return;
            }
            if (n.type === 'assignment' && owner) {
                const left = n.childForFieldName('left'), right = n.childForFieldName('right');
                if (left && right) {
                    const keys = new Set<string>();
                    const readKeys = (p: Node): void => { if (++count > 200000)
                        throw new Error('role-node-budget'); if (p.type === 'keyword_argument') {
                        const name = p.childForFieldName('name');
                        if (name)
                            keys.add(text(name));
                    } if (p.type === 'pair') {
                        const key = p.childForFieldName('key');
                        const val = key ? literal(text(key)) : undefined;
                        if (val)
                            keys.add(val);
                    } for (const c of children(p))
                        readKeys(c); };
                    readKeys(right);
                    if (keys.size)
                        mod.definitions.push({ owner, member: text(left), keys: [...keys], start: line(n), end: line(n, true) });
                }
            }
            for (const c of children(n))
                visit(c, owner);
        };
        visit(root);
        return mod;
    });
}
function resolveModule(from: string, name: string, sources: readonly Source[]): Source | undefined {
    let candidates: Source[];
    if (name.startsWith('.')) {
        const dots = /^\.+/.exec(name)![0].length;
        let dir = posix.dirname(from);
        for (let n = 1; n < dots; n++)
            dir = posix.dirname(dir);
        const base = posix.join(dir, name.slice(dots).replaceAll('.', '/'));
        candidates = sources.filter(s => s.path === base + '.py' || s.path === posix.join(base, '__init__.py'));
    }
    else {
        const base = name.replaceAll('.', '/');
        candidates = sources.filter(s => s.path === base + '.py' || s.path.endsWith('/' + base + '.py') || s.path === base + '/__init__.py' || s.path.endsWith('/' + base + '/__init__.py'));
    }
    return candidates.length === 1 ? candidates[0] : undefined;
}
/** Role routing consumes established runtime accesses. A filename or the word docs cannot prove a role. */
export async function selectNaturalEditSurfaces(query: string, plan: Plan, sources: readonly Source[], required: readonly EditRole[] = ['configuration', 'documentation', 'test', 'behavior-test'], facts?: Facts): Promise<EditSurfacePlan> {
    let partial = false;
    let bytes = 0;
    const admitted: Source[] = [];
    const counts = { implementation: 0, configuration: 0, test: 0, documentation: 0 };
    for (const source of sources.slice(0, 512)) {
        if (++counts[source.role] > (source.role === 'documentation' ? 96 : 96)) {
            partial = true;
            continue;
        }
        bytes += Buffer.byteLength(source.text);
        if (bytes > 8 * 1024 * 1024) {
            partial = true;
            break;
        }
        admitted.push(source);
    }
    if (sources.length > 512)
        partial = true;
    const cache = new Map<string, Promise<Module | undefined>>();
    const get = (path: string) => { let pending = cache.get(path); if (!pending) {
        const source = admitted.find(s => s.path === path);
        pending = source ? parseSource(source) : Promise.resolve(undefined);
        cache.set(path, pending);
    } return pending; };
    const resolveType = async (path: string, expression: string, depth = 0): Promise<{
        path: string;
        name: string;
    } | undefined> => {
        if (depth >= 5)
            return;
        const mod = await get(path);
        if (!mod)
            return;
        const [head, ...tail] = expression.split('.');
        if (!head)
            return;
        if (tail.length === 0 && mod.classes.has(head))
            return { path, name: head };
        const imported = mod.imports.get(head);
        if (!imported)
            return;
        const target = resolveModule(path, imported.module, admitted);
        if (!target)
            return;
        const member = imported.name ? [imported.name, ...tail].join('.') : tail.join('.');
        if (!member)
            return;
        return resolveType(target.path, member, depth + 1);
    };
    const resolveMethod = async (type: {
        path: string;
        name: string;
    }, name: string, depth = 0): Promise<{
        mod: Module;
        fn: Fn;
    } | undefined> => { if (depth >= 5)
        return; const mod = await get(type.path); if (!mod)
        return; const own = mod.functions.filter(f => f.owner === type.name && f.name === name); if (own.length === 1)
        return { mod, fn: own[0]! }; if (own.length > 1)
        return; const cls = mod.classes.get(type.name); if (cls?.bases.length !== 1)
        return; const base = await resolveType(type.path, cls.bases[0]!); return base ? resolveMethod(base, name, depth + 1) : undefined; };
    const fixtureType = async (testPath: string, param: string): Promise<{
        type: {
            path: string;
            name: string;
        };
        span: Span;
    } | undefined> => {
        const candidates = admitted.filter(s => posix.basename(s.path) === 'conftest.py' && (testPath.startsWith(posix.dirname(s.path) + '/'))).sort((a, b) => b.path.length - a.path.length);
        for (const source of candidates) {
            const mod = await get(source.path);
            if (!mod)
                continue;
            const matches = mod.functions.filter(f => f.name === param && f.fixture);
            if (matches.length !== 1)
                continue;
            const fn = matches[0]!;
            const values = [];
            for (const assignment of fn.assignments.filter(a => fn.returns.includes(a.target))) {
                const type = await resolveType(source.path, assignment.callee);
                if (type)
                    values.push(type);
            }
            if (values.length === 1)
                return { type: values[0]!, span: { path: source.path, start: fn.start, end: fn.end, sha: mod.sha } };
            return;
        }
        return undefined;
    };
    const expanded: Array<{
        declaration: Declaration;
        owner: {
            path: string;
            name: string;
        };
    }> = plan.selections.filter(s => s.declaration.container).map(s => ({ declaration: s.declaration, owner: { path: s.declaration.path, name: s.declaration.container! } }));
    const additionalTargets: Array<{
        path: string;
        range: string;
        symbol: string;
    }> = [], implementationSpans: Span[] = [];
    if (facts) {
        const focals = new Set(plan.selections.filter(s => s.declaration.operations.some(o => o.kind === 'return' && o.controls.length > 0)).map(s => s.declaration.id));
        const callers = facts.declarations.filter(d => d.container && d.calls.some(id => focals.has(id))).slice(0, 6);
        for (const caller of callers) {
            const owner = { path: caller.path, name: caller.container! };
            for (const d of [caller, ...caller.guardCalls.map(id => facts.declarations.find(d => d.id === id)).filter((d): d is Declaration => d !== undefined)]) {
                if (expanded.some(x => x.declaration.id === d.id))
                    continue;
                expanded.push({ declaration: d, owner });
                additionalTargets.push({ path: d.path, range: `${d.start}-${d.end}`, symbol: d.name });
                implementationSpans.push(...d.executableRanges.map(r => ({ path: d.path, sha: d.sha, ...r })));
            }
        }
    }
    const queryTerms = terms(query);
    const anchors: Array<{
        owner: {
            path: string;
            name: string;
        };
        member: string;
        key: string;
    }> = [];
    for (const selected of expanded) {
        const d = selected.declaration;
        if (!d.container)
            continue;
        const mod = await get(d.path);
        if (!mod) {
            partial = true;
            continue;
        }
        for (const fn of mod.functions.filter(f => f.start === d.start && f.end === d.end))
            for (const access of fn.accesses) {
                if (access.receiver !== 'self' || !access.key || !terms(access.member).some(t => queryTerms.some(q => sameTerm(t, q))))
                    continue;
                const anchor = { owner: selected.owner, member: access.member, key: access.key };
                if (!anchors.some(a => a.owner.path === anchor.owner.path && a.owner.name === anchor.owner.name && a.member === anchor.member && a.key === anchor.key))
                    anchors.push(anchor);
            }
    }
    const relations: RoleRelation[] = [];
    const span = (mod: Module, start: number, end: number): Span => ({ path: mod.source.path, start, end, sha: mod.sha });
    for (const anchor of anchors.slice(0, 8)) {
        const owner = await get(anchor.owner.path);
        if (!owner)
            continue;
        for (const definition of owner.definitions.filter(d => d.owner === anchor.owner.name && d.keys.includes(anchor.key) && terms(d.member).some(t => sameTerm(t, anchor.member))))
            relations.push({ role: 'configuration', spans: [span(owner, definition.start, definition.end)], owner: anchor.owner, member: anchor.member, key: anchor.key, relation: 'runtime-key-definition' });
        const documents: Array<{
            source: Source;
            start: number;
            end: number;
            score: number;
        }> = [];
        for (const source of admitted.filter(s => s.role === 'documentation' && /\.(?:md|mdx|rst|txt)$/i.test(s.path))) {
            const lines = source.text.split(/\r\n|\r|\n/).slice(0, countLines(source.text));
            for (let i = 0; i < lines.length; i++) {
                if (!new RegExp(`(?<![A-Za-z0-9_])${anchor.key}(?![A-Za-z0-9_])`).test(lines[i]!))
                    continue;
                let start = i, end = i;
                const directive = /^\s*\.\.\s+[\w:]+::\s*\S+/.test(lines[i]!);
                if (directive) {
                    while (end + 1 < lines.length && end - i < 80 && !/^\S/.test(lines[end + 1]!))
                        end++;
                }
                else {
                    while (start > 0 && i - start < 12 && lines[start - 1]!.trim())
                        start--;
                    while (end + 1 < lines.length && end - i < 20 && lines[end + 1]!.trim())
                        end++;
                }
                documents.push({ source, start: start + 1, end: end + 1, score: directive ? 10 : 1 });
            }
        }
        documents.sort((a, b) => b.score - a.score || a.source.path.localeCompare(b.source.path) || a.start - b.start);
        const document = documents[0];
        if (document)
            relations.push({ role: 'documentation', spans: [{ path: document.source.path, start: document.start, end: document.end, sha: createHash('sha256').update(document.source.text).digest('hex') }], owner: anchor.owner, member: anchor.member, key: anchor.key, relation: 'key-document-section' });
        const tests: Array<{
            mod: Module;
            fn: Fn;
            spans: Span[];
            score: number;
        }> = [];
        for (const source of admitted.filter(s => s.role === 'test' && s.language === 'python')) {
            const mod = await get(source.path);
            if (!mod) {
                partial = true;
                continue;
            }
            for (const fn of mod.functions.filter(f => /^test_/.test(f.name))) {
                const bindings = new Map<string, {
                    path: string;
                    name: string;
                }>();
                for (const assignment of fn.assignments) {
                    const type = await resolveType(source.path, assignment.callee);
                    if (type)
                        bindings.set(assignment.target, type);
                }
                const owned = (access: Access, vars: Map<string, {
                    path: string;
                    name: string;
                }>) => { const type = vars.get(access.receiver); return access.assertion && access.member === anchor.member && type?.path === anchor.owner.path && type.name === anchor.owner.name; };
                let asserted = fn.accesses.filter(a => owned(a, bindings));
                const spans = [span(mod, fn.start, fn.end)];
                for (const called of fn.calls) {
                    const helpers = mod.functions.filter(f => f.name === called.callee);
                    if (helpers.length !== 1)
                        continue;
                    const helper = helpers[0]!;
                    const passed = new Map<string, {
                        path: string;
                        name: string;
                    }>();
                    helper.params.forEach((p, i) => { const type = bindings.get(called.args[i] ?? ''); if (type)
                        passed.set(p, type); });
                    const hits = helper.accesses.filter(a => owned(a, passed));
                    if (hits.length) {
                        asserted.push(...hits);
                        spans.push(span(mod, helper.start, helper.end));
                    }
                }
                if (asserted.length) {
                    const exact = asserted.some(a => a.key === anchor.key);
                    const named = terms(fn.name).some(t => sameTerm(t, anchor.member));
                    tests.push({ mod, fn, spans, score: (exact ? 10 : 0) + (named ? 3 : 0) + Math.min(asserted.length, 2) });
                }
            }
        }
        tests.sort((a, b) => b.score - a.score || a.mod.source.path.localeCompare(b.mod.source.path) || a.fn.start - b.fn.start);
        const test = tests[0];
        if (test)
            relations.push({ role: 'test', spans: test.spans, owner: anchor.owner, member: anchor.member, key: anchor.key, relation: 'typed-owner-member-assertion' });
    }
    // Behavior-regression lane: test decorator/call -> returned decorator -> registry write;
    // the selected implementation reads that exact instance member. Test assertions must
    // observe an object constructed from the same concrete owner (including a real fixture).
    const concreteOwners = anchors.map(a => a.owner).filter((a, i, aAll) => aAll.findIndex(b => b.path === a.path && b.name === a.name) === i);
    const readers: Array<{
        member: string;
        owner: {
            path: string;
            name: string;
        };
    }> = [];
    for (const selection of plan.selections) {
        const mod = await get(selection.declaration.path);
        if (!mod)
            continue;
        for (const fn of mod.functions.filter(f => f.start === selection.declaration.start))
            for (const a of fn.accesses) {
                if (a.receiver !== 'self' || a.write || !terms(a.member).some(t => queryTerms.some(q => sameTerm(t, q))))
                    continue;
                for (const owner of concreteOwners)
                    if (!readers.some(r => r.member === a.member && r.owner.path === owner.path && r.owner.name === owner.name))
                        readers.push({ member: a.member, owner });
            }
    }
    const reachesWriter = async (type: {
        path: string;
        name: string;
    }, name: string, member: string, depth = 0): Promise<Span[] | undefined> => { if (depth > 2)
        return; const method = await resolveMethod(type, name); if (!method)
        return; const { mod, fn } = method; if (fn.accesses.some(a => a.receiver === 'self' && a.member === member && a.write))
        return [span(mod, fn.start, fn.end)]; for (const c of [...fn.calls, ...fn.returnedCalls]) {
        if (!c.callee.startsWith('self.'))
            continue;
        const suffix = c.callee.slice(5);
        if (suffix.includes('.'))
            continue;
        const found = await reachesWriter(type, suffix, member, depth + 1);
        if (found)
            return [span(mod, fn.start, fn.end), ...found];
    } return; };
    const behavior: Array<{
        relation: RoleRelation;
        score: number;
    }> = [];
    for (const source of admitted.filter(s => s.role === 'test' && s.language === 'python')) {
        const mod = await get(source.path);
        if (!mod)
            continue;
        for (const fn of mod.functions.filter(f => /^test_/.test(f.name))) {
            const bindings = new Map<string, {
                path: string;
                name: string;
            }>();
            const fixtureSpans: Span[] = [];
            for (const param of fn.params) {
                const fixture = await fixtureType(source.path, param);
                if (fixture) {
                    bindings.set(param, fixture.type);
                    fixtureSpans.push(fixture.span);
                }
            }
            for (const a of fn.assignments) {
                const type = await resolveType(source.path, a.callee);
                if (type)
                    bindings.set(a.target, type);
            }
            const observed = new Map(bindings);
            for (const a of fn.assignments) {
                const [receiver, method, ...rest] = a.callee.split('.');
                const type = receiver ? bindings.get(receiver) : undefined;
                if (type && method && !rest.length && await resolveMethod(type, method))
                    observed.set(a.target, type);
            }
            for (const reader of readers) {
                const registrations: Call[] = [];
                const links: Span[] = [];
                for (const c of fn.calls) {
                    const [receiver, method, ...rest] = c.callee.split('.');
                    const type = receiver ? bindings.get(receiver) : undefined;
                    if (!type || !method || rest.length || type.path !== reader.owner.path || type.name !== reader.owner.name)
                        continue;
                    const found = await reachesWriter(type, method, reader.member);
                    if (found) {
                        registrations.push(c);
                        links.push(...found);
                    }
                }
                const assertions = fn.accesses.filter(a => a.assertion && observed.get(a.receiver)?.path === reader.owner.path && observed.get(a.receiver)?.name === reader.owner.name);
                if (!registrations.length || !assertions.length)
                    continue;
                const registered = new Set(registrations.map(c => c.args[0]).filter(Boolean));
                const hierarchy = fn.localTypes.filter(t => registered.has(t.name) && t.bases.some(b => registered.has(b))).length;
                const spans = [span(mod, fn.start, fn.end), ...fixtureSpans, ...links].filter((s, i, a) => a.findIndex(x => x.path === s.path && x.start === s.start && x.end === s.end) === i);
                behavior.push({ relation: { role: 'behavior-test', spans, owner: reader.owner, member: reader.member, relation: 'shared-member-behavior-regression' }, score: hierarchy * 20 + Math.min(registered.size, 4) + Math.min(assertions.length, 4) });
            }
        }
    }
    behavior.sort((a, b) => b.score - a.score || a.relation.spans[0]!.path.localeCompare(b.relation.spans[0]!.path) || a.relation.spans[0]!.start - b.relation.spans[0]!.start);
    if (behavior[0])
        relations.push(behavior[0].relation);
    // Runtime relation edges require executable lines, not elided documentation.
    // Keep document/config/test proof ranges exact; only known implementation
    // declarations can supply this AST-backed projection.
    for (const relation of relations) {
        relation.spans = relation.spans.flatMap(requiredSpan => {
            const declaration = facts?.declarations.find(d => d.path === requiredSpan.path && d.start === requiredSpan.start && d.end >= requiredSpan.end);
            if (declaration === undefined) return [requiredSpan];
            // A returned nested function supplies its own executable effects.
            // Keep those bodies while excluding only actual comments/docstrings.
            return facts!.declarations.filter(child => child.path === declaration.path
                && child.start >= declaration.start && child.end <= declaration.end)
                .flatMap(child => child.executableRanges.map(range => ({ path: child.path, sha: child.sha, ...range })));
        });
    }
    const unique = relations.filter((r, i) => relations.findIndex(x => x.role === r.role && JSON.stringify(x.spans) === JSON.stringify(r.spans)) === i);
    return { relations: unique, missing: required.filter(role => !unique.some(r => r.role === role)), partial, implementationSpans, additionalTargets };
}
