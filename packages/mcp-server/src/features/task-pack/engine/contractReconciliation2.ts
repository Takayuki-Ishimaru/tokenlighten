// contractReconciliation — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { TaskPackSurface } from "../model.js";
import { FileReadCache } from "./packBasics2.js";
import { isRequiredEnumReview } from "../changeScopeContinuation.js";
import { normIdent } from "./createAndWiringEndpoints2.js";
import { readCached } from "./packBasics2.js";

/** ALL-CAPS-constant / enum-member token shape (mirrors the locator's member key regex). */
export const ENUM_MEMBER_TOKEN_RE = /\b[A-Z][A-Z0-9_]{1,}\b/g;

/**
 * Item 2 (per-site sibling checks): the enum's EXISTING sibling members, read
 * from the located contract surface(s)' own content — the same ALL-CAPS
 * key-shape the locator's extractMemberIdentifiers uses. Used to decide which
 * query token is a NOVEL member (a value being ADDED, e.g. CRITICAL/BLOCKED)
 * versus an existing one that is already present everywhere. Normalized for
 * comparison.
 */
export function existingSiblingMembers(surfaces: TaskPackSurface[], workspace: string, cache?: FileReadCache): Set<string> {
  const members = new Set<string>();
  for (const s of surfaces) {
    if (s.role !== "contract") continue;
    const raw = readCached(workspace, s.path, cache);
    if (raw === undefined) continue;
    for (const m of raw.match(ENUM_MEMBER_TOKEN_RE) ?? []) members.add(normIdent(m));
  }
  return members;
}

/**
 * Item 2: a surface that is a per-file enumeration SITE of the family — an
 * initializer / aggregation map (sibling-enumeration / exhaustive-initializer),
 * a presentation/style file, or the contract definition itself. These are the
 * files whose per-site obligation (the new member must be present in THIS file)
 * is machine-verifiable, so each gets its own single-token check scoped to its
 * exact path. Detected by role plus the summarized `why` markers those sites
 * carry (whySummary transforms the raw `why`, so match its output forms).
 */
/** Suppress a per-file literal requirement only for a proven ordinary CSS
 * file with no sibling declaration/selector. Generic resets need no enum key.
 * Unknown syntax and explicitly requested stylesheets remain conservative. */
export function styleHasLiteralEnumSite(s: Pick<TaskPackSurface, "path">, query: string, existing: ReadonlySet<string>, workspace: string): boolean {
  if (!s.path.endsWith(".css") || existing.size === 0
    || query.includes(s.path) || query.includes(path.basename(s.path))) return true;
  const raw = readCached(workspace, s.path);
  if (raw === undefined || /[\\@$]|#\{/.test(raw)) return true;
  const code = raw.replace(/\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, "");
  const names = [...code.matchAll(/--([A-Za-z_][\w-]*)\s*:|\.([A-Za-z_][\w-]*)/g)];
  return names.some(match => {
    const parts = (match[1] ?? match[2]!).split("-");
    return parts.some((_, index) => existing.has(normIdent(parts.slice(index).join("_"))));
  });
}

export function isPerSiteCheckSurface(s: Pick<TaskPackSurface, "role" | "required" | "why">): boolean {
  // A row that discharges a listed item takes the value from the enum itself.
  // Seeded required-role context can be required for delivery while remaining
  // a canonical review obligation; it does not create a literal edit site.
  if (isRequiredEnumReview(s.why)) return false;
  if (s.role === "style" || s.role === "contract") return true;
  // A propagation-discovered seed is intentionally re-routed through the
  // caller-supplied seeded builder, whose generic `why` no longer says
  // "initializer". Required API/data/config surfaces are nevertheless exact
  // propagation obligations and need the same per-file novel-member check.
  if (s.required && ["api", "data", "config"].includes(s.role)) return true;
  const why = (s.why ?? "").toLowerCase();
  return /sibling|initializer|aggregation|enumerat|family/.test(why);
}

/** Escape a literal for embedding in a RegExp (matches the file's inline convention). */
export function escapeForRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * IMPROVEMENT C: candidate enum/union TYPE symbol names for the dynamic-consumer
 * check — PascalCase identifiers named in the query (TicketPriority, Status,
 * OrderState, ...) plus the symbol of any contract-role surface. These are the
 * symbols a dynamic consumer derives from (Object.values(TicketPriority),
 * z.nativeEnum(TicketPriority), Record<TicketPriority, ...>). Empty when the
 * type cannot be named — the per-site check is then always kept (conservative).
 */
export function enumSubjectSymbols(query: string, surfaces: TaskPackSurface[]): string[] {
  const out = new Set<string>();
  // PascalCase-ish: starts uppercase AND contains a lowercase (so an ALL-CAPS
  // member token like ONHOLD is NOT mistaken for the enum TYPE).
  for (const m of query.match(/\b[A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*\b/g) ?? []) out.add(m);
  for (const s of surfaces) {
    if (s.role === "contract" && s.symbol) out.add(s.symbol);
  }
  return [...out];
}

/** IMPROVEMENT C: true when `body` derives from enum `sym` via a DYNAMIC form. */
export function dynamicDerivationOf(body: string, sym: string): boolean {
  const S = escapeForRegExp(sym);
  const patterns: RegExp[] = [
    // TS/JS
    new RegExp(`Object\\.(?:values|keys|entries)\\s*\\(\\s*${S}\\b`),
    new RegExp(`\\bnativeEnum\\s*\\(\\s*${S}\\b`),          // z.nativeEnum(S)
    new RegExp(`\\bRecord\\s*<\\s*${S}\\b`),                 // Record<S, ...>
    new RegExp(`\\bkeyof\\s+typeof\\s+${S}\\b`),             // keyof typeof S
    new RegExp(`\\b${S}\\s*\\[\\s*[^\\]\\s]`),               // indexed access S[expr] (not S[] array type)
    // Python
    new RegExp(`\\bfor\\s+\\w+\\s+in\\s+${S}\\b`),           // for x in S
    new RegExp(`\\bin\\s+${S}\\s*:`),                        // comprehension `... in S:`
    new RegExp(`\\b${S}\\.__members__\\b`),                  // S.__members__
    new RegExp(`\\blen\\s*\\(\\s*${S}\\s*\\)`),              // len(S)
  ];
  return patterns.some((re) => re.test(body));
}

/**
 * IMPROVEMENT C: decide whether a per-site "member present in <file>" obligation
 * should be SUPPRESSED for a file that consumes the enum ONLY via dynamic
 * derivation (no literal member edit needed).
 *
 *  - dynamic evidence: `body` references some subject symbol via a derivation
 *    form (see dynamicDerivationOf).
 *  - static-enumeration evidence (BLOCKS suppression): `body` contains >=2 OTHER
 *    member literals of the same enum — a positive sign it enumerates members
 *    statically (switch cases / literal maps), so the new member DOES belong here.
 *
 * Suppress ONLY on positive dynamic evidence AND absence of static evidence.
 * Returns the matched subject symbol so the informational entry can name it.
 */
export function dynamicEnumConsumerVerdict(
  body: string,
  subjectSymbols: readonly string[],
  siblingMembers: ReadonlySet<string>,
): { suppress: boolean; symbol?: string } {
  if (subjectSymbols.length === 0) return { suppress: false };
  // Static evidence: how many DISTINCT existing sibling members appear as
  // literal ALL-CAPS member tokens in the body (same extraction the contract
  // uses, normalized for comparison).
  const bodyMembers = new Set((body.match(ENUM_MEMBER_TOKEN_RE) ?? []).map(normIdent));
  let staticHits = 0;
  for (const m of siblingMembers) if (bodyMembers.has(m)) staticHits++;
  const hasStatic = staticHits >= 2;
  let matched: string | undefined;
  for (const sym of subjectSymbols) {
    if (dynamicDerivationOf(body, sym)) { matched = sym; break; }
  }
  if (matched === undefined) return { suppress: false };
  return { suppress: !hasStatic, symbol: matched };
}

/**
 * Names that mark a directory as a self-contained project/toolchain root.
 * Used to stop the upward package.json walk at the surface's OWN project
 * boundary instead of crediting a distant ancestor's package.json (e.g. a
 * monorepo host root, or — inside a benchmark fixture tree — the outer
 * repo that happens to have its own unrelated `npm test`).
 */
export const PROJECT_BOUNDARY_MARKERS = ["Makefile", "makefile", "CMakeLists.txt", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "pyproject.toml", "setup.py"];
