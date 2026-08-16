// memberSweep.ts — call-site sweep affordance for type-like (class/interface/
// struct) symbol lookups (search_files action=references, and action=find on
// a single identifier).
//
// Evidence (2026-07-30 signal5 T11, repo-rename alignment task): a live A/B
// cell resolved a rename target via references/find, then spent 7 of its 17
// TL calls serially grepping ONE member name at a time to find call sites
// needing alignment (plus a forced whole-file re-read for 38% of the
// session's bytes). references/find already know the symbol resolved to a
// class/interface AND — via collectSymbols, the SAME tree-sitter symbol
// collector skeleton rendering already uses (see renderSymbolSkeleton.ts's
// methodsByClass) — its member names, so hand the caller a ready-to-run
// BATCHED find call instead of letting it rediscover members one grep at a
// time.
//
// Reuses collectSymbols exactly as-is (no new parser, no change to its type
// classification), so this only fires where collectSymbols already links a
// member to its container via `enclosingSymbol`: JS/TS/Python/Java/C#/
// Kotlin/C++/Ruby classes, Java/C#-style interfaces with real member
// declarations, and C++ structs with inline method bodies (verified
// empirically — see the 2026-07-30 L1 implementation notes). Go's receiver
// methods and Rust's separate `impl` blocks are NOT linked by collectSymbols
// today (their methods carry no `enclosingSymbol`), and a bare TS/JS
// `interface` made only of method SIGNATURES (no body) is not collected as a
// symbol at all — both cases simply resolve to <2 members, so the feature
// abstains rather than guessing or re-implementing a second detector.

import * as fs from "fs";
import * as path from "path";
import { collectSymbols, type CollectedSymbol } from "../../../symbols/collectSymbols.js";
import { languageForPathWithContent } from "../../../util/languages.js";
import { MAX_RESPONSE_BYTES as FIND_MAX_RESPONSE_BYTES, MAX_INVENTORY_RESPONSE_BYTES } from "./findText.js";
import type { FindResponse } from "./findText.js";

/** Bare identifier token — mirrors findReferences.ts's own IDENT_RE gate. */
const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

export function isIdentifierToken(query: string): boolean {
  return IDENT_RE.test(query);
}

export interface MemberSweepAttachment {
  symbol: string;
  /** Up to 12 member names, public/exported-looking members first. */
  members: string[];
  /** Ready-to-run BATCHED find call for the first <=5 members. */
  next: string;
}

/** One sentence, in the existing hint style, describing the affordance. */
export const MEMBER_SWEEP_HINT_TEXT =
  "call-site alignment tasks: sweep member usages in ONE batched find";

/** Soft cap on the member_sweep attachment's own JSON size. */
export const MEMBER_SWEEP_MAX_BYTES = 600;

const MAX_MEMBERS = 12;
const NEXT_BATCH_SIZE = 5;
const MIN_MEMBERS = 2;
/** Safety valve: never tree-sitter-parse more than this many candidate files for one query. */
const MAX_CANDIDATE_FILES = 20;

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Cheap textual pre-filter: does `content` plausibly DECLARE `name` as a
 * class/interface/struct/trait/record/object? This only needs to avoid
 * false NEGATIVES — false positives (e.g. a comment mentioning the name
 * near one of these keywords) are filtered out by the collectSymbols
 * confirmation step below, which only ever returns real parsed
 * declarations, never comment/string text.
 */
function looksLikeTypeDefinition(content: string, name: string): boolean {
  const re = new RegExp(
    `\\b(?:class|interface|struct|trait|record|object)\\b[^;{}=]{0,80}\\b${escapeForRegex(name)}\\b`,
  );
  return re.test(content);
}

/** Best-effort "is this member private-looking" heuristic — no visibility field exists on CollectedSymbol, so this inspects the raw signature text plus common cross-language naming conventions. */
function isPrivateLooking(member: CollectedSymbol, content: string, language: string): boolean {
  const sig = content.slice(member.signatureStartIndex, member.signatureEndIndex);
  if (/^\s*private\b/.test(sig) || /^\s*protected\b/.test(sig)) return true;
  if (member.name.startsWith("#") || member.name.startsWith("_")) return true;
  if (language === "go" && /^[a-z]/.test(member.name)) return true; // Go: unexported.
  return false;
}

function buildAttachment(symbol: string, members: string[]): MemberSweepAttachment {
  return {
    symbol,
    members,
    next: `search_files action=find queries=${JSON.stringify(members.slice(0, NEXT_BATCH_SIZE))}`,
  };
}

function attachmentBytes(attachment: MemberSweepAttachment): number {
  return Buffer.byteLength(JSON.stringify(attachment), "utf8");
}

/** One candidate file the caller already knows textually mentions the queried symbol. */
export interface MemberSweepCandidate {
  path: string;
  content: string;
  language: string;
}

/**
 * Resolve `symbolName` to a UNIQUE class/interface definition among
 * `candidates` and, when found with >=2 members, return a bounded
 * member_sweep attachment (<=~600 bytes; `members[]` is trimmed — never the
 * reverse — if the natural list would exceed the budget).
 *
 * Abstains (returns undefined) when: `symbolName` isn't identifier-shaped;
 * no candidate defines a matching class/interface; MORE THAN ONE does
 * (ambiguous definition — abstain rather than guess which one is "the"
 * definition); or the resolved definition has fewer than 2 members.
 */
export async function computeMemberSweep(
  symbolName: string,
  candidates: readonly MemberSweepCandidate[],
): Promise<MemberSweepAttachment | undefined> {
  if (!isIdentifierToken(symbolName)) return undefined;

  const seenPaths = new Set<string>();
  let resolvedMembers: string[] | undefined;
  let resolvedCount = 0;

  for (const candidate of candidates) {
    if (seenPaths.has(candidate.path)) continue;
    seenPaths.add(candidate.path);
    if (!looksLikeTypeDefinition(candidate.content, symbolName)) continue;

    let symbols: CollectedSymbol[];
    try {
      symbols = await collectSymbols(candidate.content, candidate.language);
    } catch {
      continue;
    }
    const definition = symbols.find(
      (s) => (s.kind === "class" || s.kind === "interface") && s.name === symbolName,
    );
    if (!definition) continue;

    resolvedCount++;
    if (resolvedCount > 1) return undefined; // Ambiguous — more than one file defines it.

    const seenNames = new Set<string>();
    const pub: string[] = [];
    const priv: string[] = [];
    for (const s of symbols) {
      if (s.kind !== "method" || !s.enclosingSymbol) continue;
      if (s.enclosingSymbol.name !== definition.name || s.enclosingSymbol.startLine !== definition.startLine) continue;
      if (seenNames.has(s.name)) continue;
      seenNames.add(s.name);
      (isPrivateLooking(s, candidate.content, candidate.language) ? priv : pub).push(s.name);
    }
    resolvedMembers = [...pub, ...priv];
  }

  if (resolvedCount !== 1 || !resolvedMembers || resolvedMembers.length < MIN_MEMBERS) return undefined;

  let members = resolvedMembers.slice(0, MAX_MEMBERS);
  let attachment = buildAttachment(symbolName, members);
  while (attachmentBytes(attachment) > MEMBER_SWEEP_MAX_BYTES && members.length > MIN_MEMBERS) {
    members = members.slice(0, -1);
    attachment = buildAttachment(symbolName, members);
  }
  return attachmentBytes(attachment) <= MEMBER_SWEEP_MAX_BYTES ? attachment : undefined;
}

async function computeMemberSweepForPaths(
  symbolName: string,
  workspace: string,
  relPaths: readonly string[],
): Promise<MemberSweepAttachment | undefined> {
  const candidates: MemberSweepCandidate[] = [];
  for (const relPath of relPaths.slice(0, MAX_CANDIDATE_FILES)) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(workspace, relPath), "utf8");
    } catch {
      continue;
    }
    candidates.push({ path: relPath, content, language: languageForPathWithContent(relPath, content) ?? "default" });
  }
  return computeMemberSweep(symbolName, candidates);
}

export interface FindMemberSweepOptions {
  query: string;
  isRegex: boolean;
  workspace: string;
  /** Candidate paths to check — reuse the response's own (already fitted) files list. */
  candidatePaths: readonly string[];
}

/**
 * Post-process hook for search_files action=find (single-`query`; see
 * server.ts's find dispatch): attaches member_sweep to an ALREADY-BUILT
 * buildFindResponse() result when it resolves to a type definition.
 *
 * buildFindResponse() itself stays synchronous (collectSymbols is async, and
 * making buildFindResponse async would ripple into 70+ existing synchronous
 * call sites across findText.spec.ts/responseCap.spec.ts/etc. for no
 * benefit), so this reads candidate files fresh rather than reusing
 * buildFindResponse's internal content cache, which is not exposed outside
 * its own call — bounded to a handful of files by MAX_CANDIDATE_FILES.
 *
 * Never force-fits: if attaching would push the response over its OWN
 * governing byte cap (MAX_INVENTORY_RESPONSE_BYTES when the response
 * already carries a truncation inventory, else MAX_RESPONSE_BYTES), the
 * attachment is skipped rather than trimming the caller's files/matches to
 * make room.
 */
export async function maybeAttachMemberSweepToFindResponse(
  response: FindResponse,
  opts: FindMemberSweepOptions,
): Promise<FindResponse> {
  if (opts.isRegex) return response;
  if (response.absence) return response;
  if (!response.files || response.files.length === 0) return response;
  if (!isIdentifierToken(opts.query)) return response;

  const attachment = await computeMemberSweepForPaths(opts.query, opts.workspace, opts.candidatePaths);
  if (!attachment) return response;

  const withSweep: FindResponse = {
    ...response,
    member_sweep: attachment,
    ...(response.hint ? {} : { hint: MEMBER_SWEEP_HINT_TEXT }),
  };
  const cap = response.inventory ? MAX_INVENTORY_RESPONSE_BYTES : FIND_MAX_RESPONSE_BYTES;
  return Buffer.byteLength(JSON.stringify(withSweep), "utf8") <= cap ? withSweep : response;
}
