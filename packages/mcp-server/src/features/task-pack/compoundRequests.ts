/** Bounded, fs-free composition over the existing request-item and facet parsers. */
import type { ImpactCandidate } from "@tokenlighten/types";
import {
  clauseNamesOwnFacetSubject,
  extractRequestItems,
  requestItemLeads,
  type RequestItem,
  type RequestItemIndexView,
} from "./requestItems.js";
import {
  conceptTermsIn,
  explicitIdentifiersIn,
  extractFacetRequirements,
  isNegatedInstructionClause,
  qualifiedMemberPairsIn,
  callShapedNamesIn,
  type FacetRequirement,
  type QualifiedMemberPair,
} from "./requestFacets.js";

export interface CompoundRequestClause {
  readonly id: string;
  /** An unchanged span of the request, with only an outer list marker removed. */
  readonly text: string;
  /** A locator query; a subject-only prefix supplies unambiguous local inheritance. */
  readonly query: string;
  readonly subjects: readonly string[];
  readonly paths: readonly string[];
  readonly inheritedSubjects: boolean;
  readonly items: readonly RequestItem[];
  readonly facets: readonly FacetRequirement[];
}

export interface CompoundRequestOutstanding {
  readonly clauseId?: string;
  readonly reason: "query-budget" | "clause-budget" | "not-located" | "discovery-incomplete" | "candidate-budget";
  /** Uses the existing concern-status policy: discovery never proves completion. */
  readonly status: "open" | "could-not-determine";
}

export interface CompoundRequestPlan {
  readonly originalQuery: string;
  readonly clauses: readonly CompoundRequestClause[];
  /** Verbatim global instructions, retained separately from lookup subjects. */
  readonly constraints: readonly string[];
  readonly outstanding: readonly CompoundRequestOutstanding[];
  readonly compound: boolean;
}

export interface CompoundRequestOptions {
  readonly enabled?: boolean;
  readonly maxClauses?: number;
  readonly maxQueryChars?: number;
}

const MAX_CLAUSES = 32;
const MAX_QUERY_CHARS = 32_768;
const PATH_RE = /(?<![\w/\\])(?:[\p{L}\p{N}_.@-]+[/\\])*[\p{L}\p{N}_@-][\p{L}\p{N}_.@-]*\.[A-Za-z][A-Za-z0-9]{0,9}(?![\w/\\])/gu;
const LIST_MARKER_RE = /^\s*(?:[-*•・]|\(?\d{1,3}[.)]|[①-⑳])\s*/u;
const REQUEST_HEAD_RE = /^(?:(?:and|also|then)\s+)?(?:please\s+)?(?:what|who|where|when|why|which|how|explain|describe|show|tell|find|locate|trace|compare|change|add|remove|update|implement)\b/iu;
const RELATION_FRAME_RE = /\b(?:between|through|from|compare|difference|relationship|connect|flows?|passes?)\b|(?:間の|との違い|関係|を通じ|から.*へ)/iu;
const GLOBAL_CONSTRAINT_RE = /^(?:(?:please|and|also)\s+)*(?:(?:cite|include|give|provide|show|use)\b[^.!?]*\b(?:citations?|sources?|evidence|line\s+numbers?|code\s+snippets?|file\s+and\s+line)|(?:keep|make)\s+(?:the\s+)?(?:answer|response)\b|(?:answer|respond)\s+(?:in|with)\b)|^(?:出典|引用|行番号|ファイル名と行番号|回答|返答)[^。]*(?:示|付|含|して|してください)/iu;
const CONTEXT_HEAD_RE = /^(?:for|about|regarding|in)\b|(?:について|に関して|の説明)\s*[:：]$/iu;
const EDIT_HEAD_RE = /^(?:(?:and|also|then)\s+)?(?:please\s+)?(?:change|set|update|replace|rename|remove|delete|add|create|implement|fix|modify|rewrite)\b|(?:新規作成|作成して|変更して|更新して|追加して|削除して)/iu;

function bounded(value: number | undefined, fallback: number, maximum: number): number {
  return value !== undefined && Number.isFinite(value)
    ? Math.max(1, Math.min(maximum, Math.floor(value)))
    : fallback;
}

function pathsIn(text: string): string[] {
  return [...new Set([...text.matchAll(PATH_RE)].map((m) => m[0]))];
}

interface SubjectContext {
  readonly identifiers: readonly string[];
  readonly callables: readonly string[];
  readonly paths: readonly string[];
  readonly members: readonly QualifiedMemberPair[];
  readonly text: string;
  readonly header?: boolean;
}

function subjectContext(text: string): SubjectContext {
  const identifiers = explicitIdentifiersIn(text);
  // Speculative names from prose frames ("how MAX_RETRIES works") may be
  // useful to focal resolution, but cannot establish an independent subject.
  const callables = callShapedNamesIn(text);
  const paths = pathsIn(text);
  const members = qualifiedMemberPairsIn(text);
  // Code quoting keeps a plain lowercase callable searchable when inherited.
  const subjectText = [...paths, ...members.map(({ owner, member }) => `${owner}::${member}`), ...identifiers.map((name) => `\`${name}\``), ...callables.map((name) => `${name}()`)].join(" ");
  return { identifiers, callables, paths, members, text: subjectText };
}

function hasSubjects(context: SubjectContext): boolean {
  return context.identifiers.length + context.callables.length + context.paths.length > 0;
}

function inheritsSubject(text: string, facets: readonly FacetRequirement[], context: SubjectContext): boolean {
  if (clauseNamesOwnFacetSubject(text)) return false;
  if (context.header) return true;
  if (/\b(?:it|its|itself|them|their|this|that)\b|(?:それ|その|これ|この)/iu.test(text)) return true;
  // A noun-only facet continuation can inherit; an unrelated prose question cannot.
  return facets.length > 0 && !REQUEST_HEAD_RE.test(text)
    && /^(?:(?:the|all|its|their)\s+)?(?:callers?|return(?:ed)?\s+values?|defaults?|conditions?|criteria|rules?|limits?|constants?|retry\s+(?:conditions?|rules?|statuses)|flow)\b|^(?:戻り値|返り値|既定値|条件|呼び出し元|呼び出し箇所|処理の流れ)/iu.test(text);
}

/** Names in a payload or a noun refinement do not establish a new request. */
function independentlyRequested(text: string, subject: SubjectContext, facets: readonly FacetRequirement[]): boolean {
  if (!hasSubjects(subject)) return false;
  if (/^(?:content(?:s)?\s*(?:is|are|:)|内容(?:は|を)|export\b|const\b)/iu.test(text)) return false;
  if (REQUEST_HEAD_RE.test(text) || /(?:説明|教えて|示して|調べて|確認して|新規作成|作成して|変更して|更新して)/u.test(text)) return true;
  if (facets.length > 0 || (CONTEXT_HEAD_RE.test(text) && /[:：]\s*$/u.test(text))) return true;
  // A coordinated list may omit its shared imperative: "Explain a() and
  // b()" / "Explain a.ts and b.py". Adjectival references such as
  // "structured next_call" or "the config key in package.json" are refinements.
  let rest = text.trim().replace(/^(?:and|also)\s+/iu, "");
  for (const path of subject.paths) rest = rest.replace(path, "");
  for (const name of [...subject.identifiers, ...subject.callables]) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    rest = rest.replace(new RegExp(`\\b${escaped}\\b(?:\\s*\\(\\))?`, "gu"), "");
  }
  // An omitted shared imperative may still qualify its callable by file.
  // Removing only these prepositions leaves prose refinements non-independent.
  if (subject.paths.length > 0) rest = rest.replace(/\b(?:in|from|of|at)\b/giu, "");
  return /^[\s`'".?!;:：、。と]*$/u.test(rest);
}

/** Sentence/list boundaries and independent conjunctions outside quotes/calls. */
function splitRequest(query: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote: string | undefined;
  const closing: Record<string, string> = { '"': '"', "'": "'", "`": "`", "「": "」", "『": "』", "“": "”", "‘": "’" };
  const stack: string[] = [];
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}", "（": "）", "【": "】" };
  const push = (end: number, next: number): void => {
    const text = query.slice(start, end).trim().replace(LIST_MARKER_RE, "").trim();
    if (text.length > 0) parts.push(text);
    start = next;
  };
  for (let i = 0; i < query.length; i += 1) {
    const ch = query[i]!;
    if (quote !== undefined) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = undefined;
      continue;
    }
    // An apostrophe in English prose is not a quotation boundary.
    if (closing[ch] && !(ch === "'" && /[\p{L}\p{N}]/u.test(query[i - 1] ?? ""))) {
      quote = closing[ch];
      continue;
    }
    if (pairs[ch]) { stack.push(pairs[ch]!); continue; }
    if (stack.length > 0) {
      if (ch === stack[stack.length - 1]) stack.pop();
      continue;
    }
    if (ch === "\n" || ch === ";" || ch === "；" || ch === "。" || ch === "？" || ch === "！"
      || (/[.?!]/u.test(ch) && (i + 1 === query.length || /\s/u.test(query[i + 1]!)))) {
      push(ch === "\n" ? i : i + 1, i + 1);
      continue;
    }
    if (ch === "、" || ch === "，") { push(i, i + 1); continue; }
    if (ch !== " " && ch !== ",") continue;
    const join = /^(?:,\s*|\s+)(?:and(?:\s+(?:also|then))?|as\s+well\s+as|plus|along\s+with|together\s+with)\s+/iu.exec(query.slice(i));
    if (!join) continue;
    const right = query.slice(i + join[0].length).trimStart();
    const left = query.slice(start, i);
    // A following input/header's identifiers do not belong to the noun just
    // after the joiner: "for cases A, B, and C: mode FAST; ..." keeps C local.
    const ownRightSubject = hasSubjects(subjectContext(right.split(/[;\n。]|(?<!:):(?!:)/u, 1)[0]!));
    const independent = REQUEST_HEAD_RE.test(right)
      || (ownRightSubject && hasSubjects(subjectContext(left)) && !RELATION_FRAME_RE.test(left))
      || (/^(?:its?|their|the)\s+(?:callers?|return(?:ed)?\s+values?|defaults?|conditions?|limits?|flow)\b/iu.test(right)
        && hasSubjects(subjectContext(left)));
    if (independent) {
      push(i, i + join[0].length);
      i += join[0].length - 1;
    }
  }
  push(query.length, query.length);
  return parts;
}

/** Input records refine one evaluation; semicolons inside them name no new task. */
function groupEvaluationData(query: string, parts: readonly string[]): string[] {
  const grouped: string[] = [];
  let inputBlock: { start: number; end: number } | undefined;
  let offset = 0;
  const flush = (): void => {
    if (inputBlock !== undefined) grouped.push(query.slice(inputBlock.start, inputBlock.end));
    inputBlock = undefined;
  };
  for (const text of parts) {
    const start = query.indexOf(text, offset);
    const end = start + text.length;
    offset = end;
    const subject = subjectContext(text);
    const question = /^(?:what|who|where|when|why|which|how)\b|(?:どこ|どの|何|なぜ|いつ|誰).*[?？]$/iu.test(text);
    const independent = question || ((REQUEST_HEAD_RE.test(text) || /^(?:calculate|compute|evaluate|inspect)\b/iu.test(text)) && hasSubjects(subject));
    if (inputBlock !== undefined && !independent) {
      inputBlock.end = end;
      continue;
    }
    flush();
    const introducesInputs = subject.callables.length > 0
      && (/\b(?:calculate|compute|evaluate)\b[^:\n]*\b(?:results?|outputs?|values?)\b[^:\n]*\b(?:for|with|given|using)\b[^:\n]*[:：]/iu.test(text)
        || /\b(?:calculate|compute|evaluate)\b[^.!?\n]*\b(?:results?|outputs?|values?)\b[^.!?\n]*\b(?:for|with|given|using)\b[^.!?\n]*\b(?:cases?|inputs?|examples?|records?|carts?|attempts?)\s*[.!?]?\s*$/iu.test(text));
    if (introducesInputs && start >= 0) inputBlock = { start, end };
    else grouped.push(text);
  }
  flush();
  return grouped;
}

/** A second action about the same named source is still one semantic concern. */
function independentSubjectCount(scopes: readonly SubjectContext[]): number {
  const groups: Array<{ symbols: Set<string>; paths: Set<string> }> = [];
  for (const scope of scopes) {
    const symbols = scope.callables.length > 0 ? scope.callables
      : scope.members.length > 0 ? scope.members.map(({ owner, member }) => `${owner}::${member}`)
        : scope.identifiers;
    if (symbols.length === 0) continue;
    const existing = groups.find((group) => symbols.some((symbol) => group.symbols.has(symbol))
      && (scope.paths.length === 0 || group.paths.size === 0 || scope.paths.some((path) => group.paths.has(path))));
    if (existing) {
      for (const symbol of symbols) existing.symbols.add(symbol);
      for (const path of scope.paths) existing.paths.add(path);
    } else groups.push({ symbols: new Set(symbols), paths: new Set(scope.paths) });
  }
  // A path-only request can refine a symbol already named in that file. An
  // independently named file with no such binding keeps its own group.
  for (const scope of scopes) {
    if (scope.callables.length + scope.identifiers.length + scope.members.length > 0 || scope.paths.length === 0) continue;
    if (!groups.some((group) => scope.paths.some((path) => group.paths.has(path)))) {
      groups.push({ symbols: new Set(), paths: new Set(scope.paths) });
    }
  }
  return groups.length;
}

export function planCompoundRequest(
  query: string,
  index?: RequestItemIndexView,
  options?: CompoundRequestOptions,
): CompoundRequestPlan {
  const charCap = bounded(options?.maxQueryChars, MAX_QUERY_CHARS, MAX_QUERY_CHARS);
  const clauseCap = bounded(options?.maxClauses, 16, MAX_CLAUSES);
  const outstanding: CompoundRequestOutstanding[] = [];
  if (query.length > charCap) outstanding.push({ reason: "query-budget", status: "could-not-determine" });
  const source = query.slice(0, charCap);
  const clauses: CompoundRequestClause[] = [];
  const constraints: string[] = [];
  const namedScopes: SubjectContext[] = [];
  const editScopes: SubjectContext[] = [];
  let context: SubjectContext | undefined;
  for (const text of groupEvaluationData(source, splitRequest(source))) {
    const own = subjectContext(text);
    const parsedFacets = extractFacetRequirements(text);
    if (EDIT_HEAD_RE.test(text)) editScopes.push(own);
    const citationNamesSubject = /\b(?:of|about|for|from)\s+(?!the\s+(?:answer|response)\b)[\p{L}\p{N}]/iu.test(text);
    // A parenthetical/tail edit constraint cannot erase its positive question.
    // The existing facet parser already removes negated parentheticals; keep
    // the original mixed clause so its text and constraint remain verbatim.
    const onlyNegatedInstruction = isNegatedInstructionClause(text)
      && !REQUEST_HEAD_RE.test(text) && parsedFacets.length === 0;
    if (onlyNegatedInstruction || (GLOBAL_CONSTRAINT_RE.test(text) && !hasSubjects(own) && !citationNamesSubject)) {
      constraints.push(text);
      continue;
    }
    if (independentlyRequested(text, own, parsedFacets)) namedScopes.push(own);
    if (hasSubjects(own) && /[:：]\s*$/u.test(text) && CONTEXT_HEAD_RE.test(text)) {
      context = { ...own, header: true };
      continue;
    }
    if (clauses.length >= clauseCap) {
      if (!outstanding.some((entry) => entry.reason === "clause-budget")) outstanding.push({ reason: "clause-budget", status: "could-not-determine" });
      continue;
    }
    const inherited = !hasSubjects(own) && context !== undefined && inheritsSubject(text, parsedFacets, context);
    const subject = inherited ? context! : own;
    const localFacets = parsedFacets.map((requirement): FacetRequirement => {
      if (!inherited) return hasSubjects(own) ? { ...requirement, inheritedFromLead: false } : requirement;
      return {
        ...requirement,
        subjectIdentifiers: subject.identifiers,
        subjectTerms: [...new Set([...requirement.subjectTerms, ...conceptTermsIn(subject.text)])],
        subjectCallables: subject.callables,
        qualifiedMembers: subject.members,
        inheritedFromLead: true,
      };
    });
    const locatorQuery = inherited ? `${subject.text}:\n${text}` : text;
    clauses.push({
      id: `cr-${clauses.length + 1}`, text, query: locatorQuery,
      subjects: [...new Set([...subject.identifiers, ...subject.callables])], paths: subject.paths,
      inheritedSubjects: inherited,
      items: extractRequestItems(text, index), facets: localFacets,
    });
    if (hasSubjects(own)) context = own;
  }
  const leads = requestItemLeads(source);
  const editLeads = leads.filter((lead) => lead.lead !== "read");
  const mutation = editLeads.length > 0 || editScopes.length > 0;
  const subjectCount = mutation
    // Read context for one edit is not an alternative editable target. Keep
    // the legacy lead binding intact unless independently requested edits name
    // multiple files; quoted/bare continuation targets may need that context.
    ? new Set([...editLeads.map((lead) => lead.path), ...editScopes.flatMap((scope) => scope.paths)]).size
    : independentSubjectCount(namedScopes);
  const compound = subjectCount > 1 && clauses.length > 1;
  if (!compound && query.length <= charCap) {
    // No omitted independent subject exists: the legacy parser sees the entire
    // original request, including all its actions/refinements and unknowns.
    const clauseBudget = outstanding.findIndex((entry) => entry.reason === "clause-budget");
    if (clauseBudget >= 0) {
      outstanding.splice(clauseBudget, 1);
      const subject = subjectContext(query);
      clauses.splice(0, clauses.length, {
        id: "cr-1", text: query, query, subjects: [...new Set([...subject.identifiers, ...subject.callables])],
        paths: subject.paths, inheritedSubjects: false,
        items: extractRequestItems(query, index), facets: extractFacetRequirements(query),
      });
    }
  }
  return { originalQuery: query, clauses, constraints, outstanding, compound };
}

/** Drop-in facet extraction; single requests retain the original parser's behavior. */
export function extractCompoundFacetRequirements(query: string, options?: CompoundRequestOptions): FacetRequirement[] {
  if (options?.enabled === false) return extractFacetRequirements(query);
  const plan = planCompoundRequest(query, undefined, options);
  if (!plan.compound && plan.outstanding.length === 0) return extractFacetRequirements(query);
  return plan.clauses.flatMap((clause) => [...clause.facets]);
}

/** Drop-in request items, with one identity per clause-local point and honest tails. */
export function extractCompoundRequestItems(query: string, index?: RequestItemIndexView, options?: CompoundRequestOptions): RequestItem[] {
  if (options?.enabled === false) return extractRequestItems(query, index);
  const plan = planCompoundRequest(query, index, options);
  if (!plan.compound && plan.outstanding.length === 0) return extractRequestItems(query, index);
  const items: RequestItem[] = [];
  for (const clause of plan.clauses) {
    const rows = clause.items.length > 0 ? clause.items : [{ id: "", text: clause.text, kind: "topic" as const, terms: [], aliases: [], bindable: false }];
    for (const item of rows) {
      items.push({ ...item, id: `ri-${items.length + 1}`, ...(clause.inheritedSubjects && clause.subjects.length > 0 ? { facetSubject: clause.subjects } : {}) });
    }
  }
  if (plan.outstanding.length > 0) {
    // The entire original request remains named: a budget cap must never erase
    // a point before the parent can apply its could-not-determine concern gate.
    items.push({ id: `ri-${items.length + 1}`, text: query, kind: "topic", terms: [], aliases: [], bindable: false });
  }
  return items;
}

export interface CompoundCandidateInput {
  readonly clauseId: string;
  readonly candidates: readonly ImpactCandidate[];
  readonly complete: boolean;
}

export interface CompoundCandidateMerge {
  readonly candidates: readonly ImpactCandidate[];
  /** Clause ownership survives candidate deduplication. It is never coverage proof. */
  readonly owners: readonly { readonly candidate: ImpactCandidate; readonly clauseIds: readonly string[] }[];
  readonly outstanding: readonly CompoundRequestOutstanding[];
}

export function mergeCompoundCandidates(
  plan: CompoundRequestPlan,
  inputs: readonly CompoundCandidateInput[],
  options?: { readonly maxCandidates?: number },
): CompoundCandidateMerge {
  const maxCandidates = bounded(options?.maxCandidates, 48, 128);
  const outstanding: CompoundRequestOutstanding[] = [...plan.outstanding];
  const owners: Array<{ candidate: ImpactCandidate; clauseIds: string[] }> = [];
  const selected = new Map<string, number>();
  const inputByClause = new Map<string, CompoundCandidateInput>();
  for (const input of inputs.slice(0, MAX_CLAUSES)) {
    if (!inputByClause.has(input.clauseId)) inputByClause.set(input.clauseId, input);
  }
  const queues = plan.clauses.map((clause) => {
    const input = inputByClause.get(clause.id);
    if (!input || !input.complete) outstanding.push({ clauseId: clause.id, reason: "discovery-incomplete", status: "could-not-determine" });
    if (input?.complete && input.candidates.length === 0) outstanding.push({ clauseId: clause.id, reason: "not-located", status: "could-not-determine" });
    if (input?.candidates.slice(128).some((candidate) => candidate.required === true)) outstanding.push({ clauseId: clause.id, reason: "candidate-budget", status: "open" });
    return { id: clause.id, candidates: (input?.candidates ?? []).slice(0, 128), omitted: false };
  });
  // Round-robin selection prevents the first subject consuming the whole pack.
  for (let depth = 0; depth < 128; depth += 1) {
    for (const queue of queues) {
      const candidate = queue.candidates[depth];
      if (!candidate) continue;
      const key = JSON.stringify([candidate.path, candidate.symbol ?? "", candidate.range ?? candidate.line, candidate.callerRange === true, candidate.sha ?? ""]);
      const existing = selected.get(key);
      if (existing !== undefined) {
        const row = owners[existing]!;
        if (!row.clauseIds.includes(queue.id)) row.clauseIds.push(queue.id);
        if (candidate.confidence > row.candidate.confidence || candidate.required) {
          row.candidate = { ...row.candidate, confidence: Math.max(row.candidate.confidence, candidate.confidence), required: row.candidate.required || candidate.required };
        }
      } else if (owners.length < maxCandidates) {
        selected.set(key, owners.length);
        owners.push({ candidate: { ...candidate }, clauseIds: [queue.id] });
      } else if (candidate.required === true) queue.omitted = true;
    }
  }
  for (const queue of queues) {
    const noCandidateRetained = queue.candidates.length > 0 && !owners.some((owner) => owner.clauseIds.includes(queue.id));
    if ((queue.omitted || noCandidateRetained) && !outstanding.some((entry) => entry.clauseId === queue.id && entry.reason === "candidate-budget")) {
      outstanding.push({ clauseId: queue.id, reason: "candidate-budget", status: "open" });
    }
  }
  return { candidates: owners.map((row) => row.candidate), owners, outstanding };
}

export interface CompoundEvidenceWindow {
  readonly path: string;
  readonly start: number;
  readonly end: number;
  readonly clauseIds: readonly string[];
  /** Different snapshots of one file must never merge. */
  readonly sha?: string;
}

/** Coalesces line windows only; a merged owner still needs its own facet proof. */
export function coalesceCompoundEvidenceWindows(windows: readonly CompoundEvidenceWindow[]): CompoundEvidenceWindow[] {
  const sorted = windows.filter((window) => Number.isSafeInteger(window.start) && Number.isSafeInteger(window.end) && window.start > 0 && window.end >= window.start)
    .map((window) => ({ ...window, clauseIds: [...new Set(window.clauseIds)] }))
    .sort((a, b) => a.path.localeCompare(b.path) || (a.sha ?? "").localeCompare(b.sha ?? "") || a.start - b.start || a.end - b.end);
  const result: CompoundEvidenceWindow[] = [];
  for (const window of sorted) {
    const previous = result[result.length - 1];
    if (previous && previous.path === window.path && previous.sha === window.sha && window.start <= previous.end + 1) {
      result[result.length - 1] = { ...previous, end: Math.max(previous.end, window.end), clauseIds: [...new Set([...previous.clauseIds, ...window.clauseIds])] };
    } else result.push(window);
  }
  return result;
}
