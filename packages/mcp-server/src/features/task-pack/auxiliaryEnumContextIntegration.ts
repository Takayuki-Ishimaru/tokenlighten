/** Optional exact source context. No inferred change obligation or readiness proof. */
import {createHash} from "node:crypto";
import {analyzeEnumConsumerContext, boundEnumConsumerContexts, type EnumConsumerContext} from "./auxiliaryEnumContexts.js";

const CANDIDATES = Symbol("auxiliary enum candidates");
const CONTEXT = Symbol("auxiliary enum context row");
export interface AuxiliaryEnumPool {
  readonly workspace: string;
  readonly query: string;
  readonly candidates: readonly {path: string; rank: number}[];
  readonly subjects: readonly string[];
  readonly primaryPaths: readonly string[];
  /** Original explicit union or inferred project scope; empty means workspace scope. */
  readonly scopes?: readonly string[];
}
interface ActiveQuery {ref: string; query: string; taskBinding?: string; taskHandle?: string}
interface BoundPool {pool: AuxiliaryEnumPool; ref: string; binding: string; handle: string}
type Carrier = {[CANDIDATES]?: AuxiliaryEnumPool | BoundPool};
export interface AuxiliaryContextSurface {
  role: "unknown";
  handle: string;
  path: string;
  range: string;
  required: false;
  why?: string;
  code: string;
}
const hash = (body: string): string => createHash("sha256").update(body, "utf8").digest("hex");
const WHY_MAX_BYTES = 200;
const GENERIC_VALUE_WHY = "Read-only import/use context; not a whole-file no-change proof.";

function runtimeAccessorWhy(plan: EnumConsumerContext): string {
  if (plan.binding === "type-only")
    return "Read-only context: type-only import used at runtime; not a no-change proof.";
  const pair = plan.pairs.find(candidate => candidate.binding === "value");
  if (!pair) return GENERIC_VALUE_WHY;
  const subject = pair.local === pair.subject ? "" : ` for ${pair.subject}`;
  const why = `L${pair.accessorRange.start}-${pair.accessorRange.end}: Object.${pair.accessor}(${pair.local}) reads current runtime enum members${subject} here; inspect this use context for filtering.`;
  return Buffer.byteLength(why, "utf8") <= WHY_MAX_BYTES ? why : GENERIC_VALUE_WHY;
}
const safePath = (value: string): boolean => value.length > 0 && !value.includes("\\")
  && !value.includes("\0") && !value.startsWith("/") && !/^[A-Za-z]:/.test(value)
  && value.split("/").every(part => part !== "" && part !== "." && part !== "..");

function withinScope(path: string, scopes: readonly string[] | undefined): boolean {
  return scopes === undefined || scopes.length === 0
    || scopes.some(scope => safePath(scope) && (path === scope || path.startsWith(scope + "/")));
}

/** The private key survives object spread, but never JSON serialization. */
export function carryAuxiliaryEnumPool(target: object, pool: AuxiliaryEnumPool): void {
  const seen = new Set<string>();
  const candidates = pool.candidates.filter(item => safePath(item.path) && Number.isFinite(item.rank)
    && withinScope(item.path, pool.scopes) && !seen.has(item.path) && Boolean(seen.add(item.path))).slice(0, 24);
  const clean: AuxiliaryEnumPool = Object.freeze({workspace: pool.workspace, query: pool.query,
    candidates: Object.freeze(candidates.map(item => Object.freeze({...item}))),
    subjects: Object.freeze([...new Set(pool.subjects)].filter(name => /^[A-Za-z_$][\w$]*$/.test(name)).slice(0, 32)),
    primaryPaths: Object.freeze([...new Set(pool.primaryPaths)].filter(safePath)),
    ...(pool.scopes !== undefined ? {scopes: Object.freeze([...new Set(pool.scopes)])} : {}),
  });
  Object.defineProperty(target, CANDIDATES, {value: clean, enumerable: true, configurable: true});
}
export function auxiliaryEnumPool(source: object | undefined): AuxiliaryEnumPool | undefined {
  const value = (source as Carrier | undefined)?.[CANDIDATES];
  return value !== undefined && "candidates" in value ? value : undefined;
}
/** Reuse a file the existing listed-item scan has ALREADY read. No walk/read here. */
export function captureAuxiliaryEnumCandidate(cache: object, workspace: string, query: string,
  path: string, enumNames: readonly string[]): void {
  const pool = auxiliaryEnumPool(cache);
  if (!pool || pool.workspace !== workspace || pool.query !== query
    || !safePath(path) || !withinScope(path, pool.scopes)) return;
  const candidates = [...pool.candidates];
  if (!candidates.some(candidate => candidate.path === path) && candidates.length < 24) {
    candidates.push({path, rank: Math.max(-1, ...candidates.map(candidate => candidate.rank)) + 1});
  }
  carryAuxiliaryEnumPool(cache, {...pool, candidates, subjects: [...pool.subjects, ...enumNames]});
}

/** Publish only into the exact, already authenticated lane-local active query. */
export function publishAuxiliaryEnumPool(source: object, active: ActiveQuery | undefined,
  workspace: string, ref: string, binding: string, handle: string): void {
  const pool = auxiliaryEnumPool(source);
  if (!pool || !active || pool.workspace !== workspace || pool.query !== active.query
    || !ref || !binding || !handle || active.ref !== ref || active.taskBinding !== binding
    || active.taskHandle !== handle) return;
  const bound: BoundPool = Object.freeze({pool, ref, binding, handle});
  Object.defineProperty(active, CANDIDATES, {value: bound, enumerable: true, configurable: true});
}
/** Caller must pass the current lane's active query after qref authentication. */
export function restoreAuxiliaryEnumPool(active: ActiveQuery | undefined, workspace: string,
  query: string, taskBinding: string | undefined, authenticatedReplay: boolean): AuxiliaryEnumPool | undefined {
  const value = (active as (ActiveQuery & Carrier) | undefined)?.[CANDIDATES];
  if (!authenticatedReplay || !active || !value || !("pool" in value) || !taskBinding
    || value.pool.workspace !== workspace || value.pool.query !== query || active.query !== query
    || active.ref !== value.ref || active.taskBinding !== value.binding || taskBinding !== value.binding
    || active.taskHandle !== value.handle) return undefined;
  return value.pool;
}
export function isAuxiliaryEnumSurface(value: unknown): boolean {
  return value !== null && typeof value === "object" && (value as {[CONTEXT]?: true})[CONTEXT] === true;
}
export function primaryEnumContextRows<T>(rows: readonly T[]): T[] {
  return rows.filter(row => !isAuxiliaryEnumSurface(row));
}

/**
 * Append only complete per-file bundles that fit the caller's completed pack.
 * The host's measure callback must include its unchanged final-envelope reserve.
 * Kept bytes are checked again after parsing; no handles are minted for a nonfit
 * or stale plan. Existing primary rows and all semantic fields are untouched.
 */
export async function attachAuxiliaryEnumContexts<T extends object>(options: {
  pool: AuxiliaryEnumPool;
  primary: readonly T[];
  read(path: string): string | undefined;
  held(plan: EnumConsumerContext, start: number, end: number, totalLines: number): boolean;
  fits(rows: readonly (T | AuxiliaryContextSurface)[]): boolean;
  mint(path: string, range: string): string;
  forceServe?: boolean;
}): Promise<AuxiliaryContextSurface[]> {
  const sources = new Map<string, string>();
  const plans: EnumConsumerContext[] = [];
  for (const candidate of options.pool.candidates.slice(0, 24)) {
    if (options.pool.primaryPaths.includes(candidate.path)) continue;
    const body = options.read(candidate.path);
    if (body === undefined || Buffer.byteLength(body, "utf8") > 96 * 1024) continue;
    const plan = await analyzeEnumConsumerContext(candidate.path, body, [...options.pool.subjects], candidate.rank);
    if (plan) {sources.set(candidate.path, body); plans.push(plan);}
  }
  // Choose the bounded set BEFORE omitting held bundles. A second page cannot
  // expand four chosen paths into eight by filtering the first four out early.
  const bounded = boundEnumConsumerContexts(plans, sources, new Set(options.pool.primaryPaths));
  const out: AuxiliaryContextSurface[] = [];
  for (const plan of bounded) {
    const body = options.read(plan.path);
    if (body === undefined || hash(body) !== plan.sourceSha) continue;
    const totalLines = body.split("\n").length;
    if (!options.forceServe && plan.windows.every(window => options.held(plan, window.start, window.end, totalLines))) continue;
    const why = runtimeAccessorWhy(plan);
    // Whole bundle per response; a partially held import is harmlessly repeated
    // rather than silently omitting the binding context of an unread use.
    const drafts: AuxiliaryContextSurface[] = plan.windows.map((window, index) => ({
      role: "unknown", handle: "h0000000000", path: plan.path,
      range: `${window.start}-${window.end}`, required: false, code: window.text,
      ...(index === 0 ? {why} : {}),
    }));
    for (const row of drafts) Object.defineProperty(row, CONTEXT, {value: true, enumerable: true});
    const fallback = plan.binding === "value" && drafts[0]!.why !== GENERIC_VALUE_WHY;
    if (!options.fits([...options.primary, ...out, ...drafts])) {
      if (!fallback) continue;
      drafts[0]!.why = GENERIC_VALUE_WHY;
      if (!options.fits([...options.primary, ...out, ...drafts])) continue;
    }
    for (const row of drafts) {
      row.handle = options.mint(row.path, row.range);
    }
    // A host returning larger-than-placeholder handles cannot spend primary bytes.
    if (!options.fits([...options.primary, ...out, ...drafts])) {
      if (!fallback || drafts[0]!.why === GENERIC_VALUE_WHY) continue;
      drafts[0]!.why = GENERIC_VALUE_WHY;
      if (!options.fits([...options.primary, ...out, ...drafts])) continue;
    }
    out.push(...drafts);
  }
  return out;
}

/** Shed complete auxiliary path bundles before touching any primary content. */
export function shedAuxiliaryEnumContexts<T extends {path: string}>(rows: T[], fits: () => boolean): void {
  const paths = [...new Set(rows.filter(isAuxiliaryEnumSurface).map(row => row.path))].reverse();
  for (const path of paths) {
    if (fits()) return;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i]!.path === path && isAuxiliaryEnumSurface(rows[i])) rows.splice(i, 1);
    }
  }
}
