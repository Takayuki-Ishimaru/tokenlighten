/**
 * listedScopeItems.ts — the places a request LISTS (2026-10-19).
 *
 * v0.16 decision 6t-4, T09 rep 1 (arm A): the request listed three places to
 * change — the shared enum, the PriorityBadge component and 「バックエンドの
 * issue create 経路 (バリデーション含む)」 — and the first pack claimed
 * `coverage:"complete"`, `discovery_complete:true` and an inventory-complete
 * certificate while serving nothing for the third. The solver grepped, found
 * `IssueCreateSchema`, called the claim wrong and did the rest natively (48
 * calls). That schema needs no edit: it validates `priority` with
 * `z.enum(Object.values(IssuePriority) ...)`, so the new member reaches it by
 * itself. The pack only had to say so.
 *
 * The text-only halves of that rule live here; readCodeTaskPack.ts
 * (`accountForListedScopeItems`) reads the workspace and builds the rows:
 *   - `listedScopeItems`: the request's own list lines ("- x", "1. x", "① x"),
 *     minus instructions — a list line that asks for an action, or forbids
 *     one, names no place to cover.
 *   - `enumNamesDeclaredWith`: the declaration in a served contract window
 *     whose member block names >= 2 of the request's value tokens — the enum
 *     the request extends.
 *   - `wholeEnumAccessor`: a line that enumerates that enum as a whole
 *     (`Object.values(E)`, `z.nativeEnum(E)`, `keyof typeof E`, `E.values()`,
 *     ...), so a new member reaches it without an edit.
 *   - `enclosingDeclaration`: the declaration such a line sits in — the name a
 *     listed item is matched against.
 */
import { isNegatedInstructionClause } from "./requestFacets.js";

/** The `why` prefix of a row that discharges a listed item; the change contract keeps it review-only. */
export const LISTED_ITEM_DERIVED_WHY = "enum-derived";

/** At least this many list lines make a list; a lone "- x" line is prose. */
const LISTED_ITEMS_MIN = 2;
/** Lines scanned for an enum declaration's member block. */
const ENUM_BLOCK_MAX_LINES = 64;
/** Lines scanned upward for the declaration that encloses a derived line. */
const ENCLOSING_SCAN_MAX_LINES = 80;

const LIST_LINE_RE = /^\s*(?:[-*+]\s+|[•・●◦▪]\s*|\d{1,2}[.)]\s+|[(（]\d{1,2}[)）]\s*|[①-⑳]\s*)(.*\S)\s*$/u;
const FENCE_RE = /^\s*(?:```|~~~)/u;
const PARENTHETICAL_RE = /[(（][^()（）]*[)）]/gu;
const TRAILING_PUNCTUATION_RE = /[\s。.!！?？、,，:：]+$/u;
// "報告して", "テストも追加", "Report what changed", "Keep the API stable".
const JA_INSTRUCTION_END_RE = /(?:て|で|ください|下さい|ほしい|こと|ように|せよ|しなさい|する|します|修正|変更|追加|削除|対応|報告|確認|実装|更新|作成)$/u;
const EN_INSTRUCTION_LEAD_RE = /^(?:please\s+)?(?:add|update|change|modify|fix|remove|delete|rename|refactor|implement|create|write|report|list|explain|describe|summari[sz]e|document|run|test|verify|ensure|make|keep|do|don't|never|avoid|use|check|confirm|move|replace)\b/iu;

const ENUM_DECLARATION_RE = /\b(?:enum(?:\s+class)?|const|class|object)\s+([A-Za-z_$][\w$]*)/u;
const VALUE_TOKEN_RE = /\b[A-Z][A-Z0-9_]*\b/gu;
const COMMENT_LINE_RE = /^\s*(?:\/\/|\/\*|\*|#|--)/u;

const DECLARATION_RE = /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|interface|type|enum|def|fun|func)\s+([A-Za-z_$][\w$]*)/u;
const CALLABLE_DECLARATION_RE = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|def|fun|func)\s+([A-Za-z_$][\w$]*)/u;
const METHOD_RE = /^\s*(?:(?:public|private|protected|internal|static|readonly|async|override|final)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::[^={;]+)?\{\s*$/u;
const CONTROL_WORDS: ReadonlySet<string> = new Set(["if", "for", "while", "switch", "catch", "with", "return", "else", "do", "try", "function"]);

/** The scope items a request lists, verbatim (marker stripped); empty when it lists none. */
export function listedScopeItems(query: string): string[] {
  let listLines = 0;
  let fenced = false;
  const items: string[] = [];
  for (const line of query.split(/\r?\n/u)) {
    if (FENCE_RE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = LIST_LINE_RE.exec(line);
    if (match === null || !/\p{L}/u.test(match[1]!)) continue;
    listLines += 1;
    const text = match[1]!.trim();
    if (!readsAsInstruction(text)) items.push(text);
  }
  return listLines >= LISTED_ITEMS_MIN ? items : [];
}

function readsAsInstruction(text: string): boolean {
  if (isNegatedInstructionClause(text)) return true;
  const bare = text.replace(PARENTHETICAL_RE, " ").replace(TRAILING_PUNCTUATION_RE, "").trim();
  return bare.length === 0 || JA_INSTRUCTION_END_RE.test(bare) || EN_INSTRUCTION_LEAD_RE.test(bare);
}

/** Names declared in `code` whose member block names >= 2 of `values` (the enum a value-addition request extends). */
export function enumNamesDeclaredWith(code: string, values: ReadonlySet<string>): string[] {
  if (values.size < 2) return [];
  const lines = code.split(/\r?\n/u);
  const names = new Set<string>();
  for (let index = 0; index < lines.length; index++) {
    const declaration = ENUM_DECLARATION_RE.exec(lines[index]!);
    if (declaration === null) continue;
    const indent = indentOf(lines[index]!);
    const members = new Set<string>();
    for (let at = index; at < Math.min(lines.length, index + ENUM_BLOCK_MAX_LINES); at++) {
      const line = lines[at]!;
      if (at > index && line.trim().length > 0 && (/^\s*[}\])]/u.test(line) || indentOf(line) <= indent)) break;
      for (const token of line.match(VALUE_TOKEN_RE) ?? []) if (values.has(token)) members.add(token);
    }
    if (members.size >= 2) names.add(declaration[1]!);
  }
  return [...names];
}

/** The accessor text when `line` enumerates enum `name` as a whole, so a new member reaches it without an edit. */
export function wholeEnumAccessor(line: string, name: string): string | undefined {
  if (!line.includes(name) || COMMENT_LINE_RE.test(line)) return undefined;
  const enumName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  for (const pattern of [
    `\\bObject\\.(?:values|keys|entries)\\(\\s*${enumName}\\s*\\)`,
    `\\bnativeEnum\\(\\s*${enumName}\\s*\\)`,
    `\\bkeyof\\s+typeof\\s+${enumName}\\b`,
    `\\bIsEnum\\(\\s*${enumName}\\s*\\)`,
    `(?<![\\w$.])${enumName}\\.(?:values|entries)\\(\\s*\\)`,
    `\\bEnum\\.GetValues\\(\\s*typeof\\(\\s*${enumName}\\s*\\)\\s*\\)`,
    `\\b(?:list|tuple|set)\\(\\s*${enumName}\\s*\\)`,
  ]) {
    const match = new RegExp(pattern, "u").exec(line);
    if (match !== null) return match[0];
  }
  return undefined;
}

/** The declaration enclosing line `index` (0-based): a callable declared on that line, else the nearest less-indented one above. */
export function enclosingDeclaration(lines: readonly string[], index: number): { name: string; line: number } | undefined {
  const own = declaredName(lines[index] ?? "", CALLABLE_DECLARATION_RE);
  if (own !== undefined) return { name: own, line: index + 1 };
  let limit = indentOf(lines[index] ?? "");
  for (let at = index - 1; at >= Math.max(0, index - ENCLOSING_SCAN_MAX_LINES); at--) {
    const line = lines[at]!;
    if (line.trim().length === 0 || COMMENT_LINE_RE.test(line)) continue;
    const indent = indentOf(line);
    if (indent >= limit) continue;
    const name = declaredName(line, DECLARATION_RE);
    if (name !== undefined) return { name, line: at + 1 };
    if (indent === 0) return undefined;
    limit = indent;
  }
  return undefined;
}

function declaredName(line: string, declaration: RegExp): string | undefined {
  const name = declaration.exec(line)?.[1] ?? METHOD_RE.exec(line)?.[1];
  return name !== undefined && !CONTROL_WORDS.has(name) ? name : undefined;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}
