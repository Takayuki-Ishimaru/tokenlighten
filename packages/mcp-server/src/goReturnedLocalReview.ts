import {withTreeSitterRoot, type TreeSitterNode as Node} from "./skeleton/treeSitter.js";

/**
 * Go returned-local review: a narrow safety net for ONE Go shape. It is not a
 * Go data-flow aid, and nothing here generalises it.
 *
 * The shape (2026-10-22, codex-copilot-proxy r18 T07, ledgerd `Compute`): a
 * function builds its result as a composite-literal local `x := T{…}`, calls a
 * method on it (`x.M(args)`), assigns a field of it directly at the top of the
 * function (`x.F = …`) and ends with `return x`. The write silently replaces
 * what the earlier call set, and agents fixed the call's input without seeing
 * that. Two aids state that source-order fact and nothing more (no defect named,
 * no edit prescribed): at pack time (`goReturnedLocalReview`, one line beside the
 * located function) and after an edit (`goPostEditReview`: the edit changed what
 * feeds the call, above the write, and left the write alone).
 *
 * How rare the shape is (generality audit 2026-10-24, §3.9.2, a go/ast census
 * independent of this analysis): about 1 function in 50,000 in GOROOT (1 of
 * 49,944) and 3 in about 69,000 in GOMODCACHE (3 of 69,468). Outside the T07
 * file it is a no-op in practice: a parse of the window or of the edited
 * function, and a line of at most 240 B on the day the shape appears. It
 * abstains wherever it cannot be sure (aliasing of the local, func literals,
 * defer/go/goto, a text that does not parse cleanly, several qualifying
 * functions in one window or small file).
 *
 * The unit is one whole function of at most 12 KiB, however large its file:
 * a pack surface qualifies when its window holds the function whole and parses
 * cleanly (the whole small file, the function alone, or a prefix that ends with
 * it), with or without remaining ranges; an edited file above the whole-file
 * bound is analysed per function, the ones whose text the edit changed, before
 * and after. The edit note fires only on a code change that can reach the call
 * (see `goPostEditReview`), never on a comment, a blank line or an unrelated
 * statement.
 */

/** A function's own text may not exceed this many UTF-8 bytes: the analysis is about one function, whatever size its file or window. */
const FUNCTION_TEXT_BYTES = 12 * 1024;
/** A file at most this large is analysed whole after an edit (exactly one function qualifies in it); a larger one, per function. */
const WHOLE_FILE_BYTES = 12 * 1024;
/** The largest text parsed at all: a surface window, or either side of an edited file (server.ts snapshots files up to this size). */
export const GO_REVIEW_TEXT_BYTES = 256 * 1024;

const GO_REVIEW_ORIGIN = Symbol("tl.goReviewOrigin");
type ReviewOrigin = Readonly<{path: string; body: string; range: string; text: string}>;
export function bindGoReviewOrigin(surface: object, origin: ReviewOrigin): void {
  (surface as {[GO_REVIEW_ORIGIN]?: ReviewOrigin})[GO_REVIEW_ORIGIN] = Object.freeze(origin);
}
export function goReviewOrigin(surface: object): ReviewOrigin | undefined {
  return (surface as {[GO_REVIEW_ORIGIN]?: ReviewOrigin})[GO_REVIEW_ORIGIN];
}

export type GoReturnedLocalSource = Readonly<{
  path: string; startLine: number; endLine: number; body: string;
  fresh: boolean; complete: boolean; truncated?: boolean;
}>;

/**
 * The source-order facts behind a returned-local review (2026-10-22,
 * codex-copilot-proxy r18 T07): the one function whose return reads a field the
 * function assigned last, and the receiver call that precedes that write.
 * `goPostEditReview` compares the facts of a file before and after an edit.
 * `field` is `<local>.<Field>` (`b.Net`); lines are the source's own numbering.
 * `discardSafe` is true only for a strong candidate whose right-hand side reads
 * neither `<local>.<same field>` nor a method of the local, i.e. the write
 * replaces whatever the earlier call set instead of building on it.
 */
export type GoReturnedLocalFacts = Readonly<{
  text: string;
  form: "strong" | "concrete" | "advisory";
  discardSafe: boolean;
  local: string;
  field: string;
  callText: string;
  callLine: number;
  writeText: string;
  writeLine: number;
  writeEndLine: number;
  returnLine: number;
  functionName: string;
  functionStartLine: number;
  functionEndLine: number;
}>;

/**
 * What the post-edit note needs beyond the facts, for one function of one text
 * (offsets index that text): its code `tokens` (comments, whitespace and
 * statement terminators set aside), the `watched` stretches a code change must
 * touch for the note to fire, where the final write starts, and the names it declares.
 */
type WatchDetail = Readonly<{
  tokens: readonly CodeToken[];
  watched: ReadonlyArray<readonly [number, number]>;
  writeStart: number;
  /** The names the function itself declares: parameters, results, receiver and locals. */
  declared: ReadonlySet<string>;
}>;
type CodeToken = Readonly<{text: string; start: number}>;
/** The facts of one qualifying function; `detail` is computed on demand, while the tree it reads is alive. */
type FunctionAnalysis = Readonly<{facts: GoReturnedLocalFacts; detail: () => WatchDetail}>;

function children(node: Node | null | undefined): Node[] {
  const result: Node[] = [];
  if (node) for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) result.push(child);
  }
  return result;
}

function descendants(root: Node): Node[] | undefined {
  const result: Node[] = [], pending = [root];
  while (pending.length) {
    const node = pending.pop();
    if (!node || result.length >= 4096) return undefined;
    result.push(node);
    const named = children(node);
    for (let i = named.length - 1; i >= 0; i--) {
      const child = named[i];
      if (child) pending.push(child);
    }
  }
  return result;
}

const key = (node: Node): string => node.type + ":" + node.startIndex + ":" + node.endIndex;

function functionAnalysis(fn: Node, source: GoReturnedLocalSource, text: string): FunctionAnalysis | undefined {
  const body = fn.childForFieldName("body");
  if (!body || body.type !== "block") return undefined;
  const statements = children(body).flatMap(node => node.type === "statement_list" ? children(node) : [node])
    .filter(node => node.type !== "comment");
  const returned = statements.at(-1);
  if (!returned || returned.type !== "return_statement") return undefined;
  const values = children(children(returned).find(node => node.type === "expression_list"));
  const returnedLocal = values[0];
  if (!returnedLocal || returnedLocal.type !== "identifier") return undefined;
  const nodeText = (node: Node): string => text.slice(node.startIndex, node.endIndex);
  const local = nodeText(returnedLocal);
  const declarations = statements.filter(node => {
    if (node.type !== "short_var_declaration") return false;
    const left = children(node.childForFieldName("left")), right = children(node.childForFieldName("right"));
    return left.length === 1 && left[0]?.type === "identifier" && nodeText(left[0]) === local
      && right.length === 1 && right[0]?.type === "composite_literal"
      && ["type_identifier", "qualified_type"].includes(right[0].childForFieldName("type")?.type ?? "");
  });
  const declaration = declarations[0];
  if (declarations.length !== 1 || !declaration) return undefined;
  const declaredLocal = children(declaration.childForFieldName("left"))[0];
  if (!declaredLocal) return undefined;
  const nodes = descendants(fn);
  if (!nodes) return undefined;
  const excluded = new Set(["ERROR", "func_literal", "defer_statement", "go_statement", "goto_statement"]);
  if (nodes.some(node => excluded.has(node.type) || node.startIndex === node.endIndex)) return undefined;
  const isLocal = (node: Node | null | undefined): node is Node =>
    !!node && node.type === "identifier" && nodeText(node) === local;
  const isLocalSelector = (node: Node): boolean => node.type === "selector_expression"
    && isLocal(node.childForFieldName("operand"));
  const permitted = new Set([key(declaredLocal), key(returnedLocal)]);
  for (const node of nodes) if (isLocalSelector(node)) {
    const operand = node.childForFieldName("operand");
    if (operand) permitted.add(key(operand));
  }
  // Other bare uses include aliases, passing, reassignment, early returns and shadowing.
  if (nodes.some(node => isLocal(node) && !permitted.has(key(node)))) return undefined;
  for (const node of nodes) {
    if (node.type === "unary_expression" && nodeText(node).trimStart().startsWith("&")) {
      const nested = descendants(node);
      if (!nested || nested.some(isLocal)) return undefined;
    }
    if (node.type === "short_var_declaration" || node.type === "assignment_statement") {
      if (children(node.childForFieldName("right")).some(isLocalSelector)) return undefined;
    }
  }
  const calls = nodes.filter(node => {
    if (node.type !== "call_expression" || node.startIndex <= declaration.endIndex) return false;
    const callee = node.childForFieldName("function");
    return !!callee && isLocalSelector(callee);
  });
  const writes: {selector: Node; field: Node; statement: Node; operator: string}[] = [];
  for (const statement of statements) {
    if (statement.type !== "assignment_statement" || statement.startIndex <= declaration.endIndex
      || statement.endIndex >= returned.startIndex) continue;
    const operator = statement.childForFieldName("operator");
    if (!operator) continue;
    for (const left of children(statement.childForFieldName("left"))) {
      const field = left.childForFieldName("field");
      if (isLocalSelector(left) && field?.type === "field_identifier")
        writes.push({selector: left, field, statement, operator: nodeText(operator)});
    }
  }
  writes.sort((a, b) => b.selector.startIndex - a.selector.startIndex);
  const finalWrite = writes[0];
  const directReturnOnly = (statement: Node): boolean => {
    if (statement.type === "return_statement")
      return !(descendants(statement) ?? []).some(isLocal);
    if (statement.type !== "if_statement" || statement.childForFieldName("initializer")) return false;
    const condition = statement.childForFieldName("condition");
    const block = children(statement).find(node => node.type === "block");
    if (!condition || !block || statement.childForFieldName("alternative")) return false;
    const conditionNodes = descendants(condition);
    if (!conditionNodes || conditionNodes.some(node => node.type === "call_expression"
      || node.type === "unary_expression" || node.type === "assignment_statement" || isLocal(node))) return false;
    const blockStatements = children(block).flatMap(node => node.type === "statement_list" ? children(node) : [node])
      .filter(node => node.type !== "comment");
    return blockStatements.length > 0 && blockStatements.every(directReturnOnly);
  };
  const strongCandidate = (write: typeof finalWrite): boolean => {
    if (!write || write.operator !== "=" || write.statement.type !== "assignment_statement") return false;
    const localTargets = children(write.statement.childForFieldName("left")).filter(isLocalSelector);
    if (localTargets.length !== 1 || !localTargets[0] || key(localTargets[0]) !== key(write.selector)) return false;
    const laterStatements = statements.filter(statement => statement.startIndex > write.statement.startIndex
      && statement.startIndex < returned.startIndex);
    if (!laterStatements.every(directReturnOnly)) return false;
    const laterNodes = nodes.filter(node => node.startIndex >= write.statement.endIndex
      && node.startIndex < returned.startIndex);
    if (laterNodes.some(node => node.type === "inc_statement" || node.type === "dec_statement"
      || (node.type === "call_expression" && isLocalSelector(node.childForFieldName("function") ?? node)))) return false;
    // Go orders no variable read against a call inside one return statement (gc runs the call first), so a
    // call through the local in the return itself (`return out, out.Finalize()`, `return out, out.Score.Validate()`,
    // `return out, (out.Score).Validate()`) may change what `out` holds when it is read: the return can no longer
    // be said to return the assigned value. A call whose callee does not mention the local passes a copy and stays.
    const returnNodes = descendants(returned);
    if (!returnNodes || returnNodes.some(node => {
      if (node.type !== "call_expression") return false;
      const callee = node.childForFieldName("function");
      const calleeNodes = callee ? descendants(callee) : [];
      return !calleeNodes || calleeNodes.some(isLocal);
    })) return false;
    return true;
  };
  // The write replaces what the earlier call set only when its right-hand side does not read that field
  // back (`b.Net = adjust(b.Net)`) and does not ask the local for it (`b.Net = b.Recompute()`).
  const discardSafe = (write: NonNullable<typeof finalWrite>): boolean => {
    const right = write.statement.childForFieldName("right");
    const rightNodes = right ? descendants(right) : [];
    if (!rightNodes) return false;
    const written = nodeText(write.field);
    return !rightNodes.some(node => {
      if (isLocalSelector(node)) {
        const field = node.childForFieldName("field");
        return field !== null && nodeText(field) === written;
      }
      const callee = node.type === "call_expression" ? node.childForFieldName("function") : null;
      return callee !== null && isLocalSelector(callee);
    });
  };
  const functionName = ((): string | undefined => {
    const name = fn.childForFieldName("name");
    if (!name) return undefined;
    if (fn.type !== "method_declaration") return nodeText(name);
    const receiverType = children(fn.childForFieldName("receiver"))[0]?.childForFieldName("type");
    return "(" + (receiverType ? nodeText(receiverType) : "") + ")." + nodeText(name);
  })();
  const lineAt = (node: Node, edge: "startPosition" | "endPosition"): number | undefined => {
    const row = node[edge]?.row;
    if (row === undefined || !Number.isSafeInteger(row) || row < 0) return undefined;
    const result = source.startLine + row;
    return result <= source.endLine ? result : undefined;
  };
  const within200 = (review: string): boolean => Buffer.byteLength(review, "utf8") <= 200;
  for (const write of writes) {
    const call = calls.filter(node => node.endIndex <= write.selector.startIndex)
      .sort((a, b) => b.startIndex - a.startIndex)[0];
    if (!call) continue;
    const callLine = lineAt(call, "startPosition"), writeLine = lineAt(write.selector, "startPosition");
    const returnLine = lineAt(returned, "startPosition"), writeEndLine = lineAt(write.statement, "endPosition");
    const functionStartLine = lineAt(fn, "startPosition"), functionEndLine = lineAt(fn, "endPosition");
    if (callLine === undefined || writeLine === undefined || returnLine === undefined || writeEndLine === undefined
      || functionStartLine === undefined || functionEndLine === undefined || functionName === undefined) return undefined;
    const callText = nodeText(call), writeText = nodeText(write.statement);
    const fieldName = local + "." + nodeText(write.field);
    const effect = write.operator === "="
      ? "later assignment " + writeText + " L" + writeLine
      : "later compound write " + writeText + " L" + writeLine;
    const strongShape = write === finalWrite && strongCandidate(write);
    const safe = strongShape && discardSafe(write);
    const facts = (review: string, form: GoReturnedLocalFacts["form"]): FunctionAnalysis => ({
      facts: {
        text: review, form, discardSafe: safe, local, field: fieldName, callText, callLine, writeText, writeLine,
        writeEndLine, returnLine, functionName, functionStartLine, functionEndLine,
      },
      detail: () => watchDetail(fn, text, local, call, write.statement, nodes),
    });
    const flat = !/[\r\n]/u.test(callText + writeText);
    if (strongShape && flat) {
      // 2026-10-22, codex-copilot-proxy r18 T07: a write that cannot read what the earlier call set is
      // stated as the dataflow fact itself (which assignment the return reads, which call it does not),
      // with the statement while it fits and without it when it does not.
      if (safe) for (const withWrite of [true, false]) {
        const stated = source.path + ": return " + local + " L" + returnLine + " returns the " + fieldName
          + " assigned at L" + writeLine + (withWrite ? " (" + writeText + ")" : "")
          + ", not one set by " + callText + " L" + callLine + ".";
        if (within200(stated)) return facts(stated, "strong");
      }
      const strong = source.path + ": " + callText + " L" + callLine
        + " precedes the final direct assignment to " + fieldName + " L" + writeLine
        + "; return " + local + " L" + returnLine
        + " follows it. Review both sites before the first edit.";
      if (within200(strong)) return facts(strong, "strong");
    }
    const concrete = source.path + ": " + callText + " L" + callLine
      + "; " + effect + "; return " + local + " L" + returnLine
      + ". Check both sites against task intent; batch fixes.";
    if (flat && within200(concrete)) return facts(concrete, "concrete");
    const advisory = source.path + ": " + local + " receiver call L" + callLine
      + (write.operator === "="
        ? "; later assignment to " + fieldName + " L" + writeLine
        : "; later compound write to " + fieldName + " L" + writeLine)
      + "; return L" + returnLine + ". Check both sites against task intent; batch fixes.";
    return within200(advisory) ? facts(advisory, "advisory") : undefined;
  }
  return undefined;
}

/** The top-level function and method declarations of a parsed text, in source order. */
function declaredFunctions(root: Node): Node[] {
  return children(root).filter(node => node.type === "function_declaration" || node.type === "method_declaration");
}

/** Whether the function's own text fits `FUNCTION_TEXT_BYTES`. */
function functionFits(fn: Node, text: string): boolean {
  return Buffer.byteLength(text.slice(fn.startIndex, fn.endIndex), "utf8") <= FUNCTION_TEXT_BYTES;
}

/** The analyses of every function of the parsed text that qualifies, in source order; a function over the bound does not. */
function analysedFunctions(root: Node, source: GoReturnedLocalSource, text: string): FunctionAnalysis[] {
  return declaredFunctions(root).filter(fn => functionFits(fn, text))
    .map(fn => functionAnalysis(fn, source, text)).filter((value): value is FunctionAnalysis => value !== undefined);
}

/**
 * The facts behind the review; abstains exactly where the review does. The text is
 * a window of a file (a whole small file, one function, a prefix that ends with
 * one, …) and must parse cleanly: a window that cuts a function does not. Its own
 * size is bounded only as a parse (`GO_REVIEW_TEXT_BYTES`); the function it holds
 * is bounded by `FUNCTION_TEXT_BYTES`, and exactly one function of it may qualify.
 */
export async function goReturnedLocalFacts(source: GoReturnedLocalSource): Promise<GoReturnedLocalFacts | undefined> {
  if (!source.fresh || !source.complete || source.truncated || !source.path.endsWith(".go")
    || source.path.endsWith("_test.go") || /[\r\n\0]/u.test(source.path)
    || !Number.isSafeInteger(source.startLine) || source.startLine < 1
    || !Number.isSafeInteger(source.endLine) || source.endLine < source.startLine
    || Buffer.byteLength(source.body, "utf8") > GO_REVIEW_TEXT_BYTES) return undefined;
  const text = source.body.replace(/\r\n/g, "\n");
  if (!text || text.includes("\r") || text.replace(/\n$/u, "").split("\n").length !== source.endLine - source.startLine + 1)
    return undefined;
  return withTreeSitterRoot(text, "go", {}, root => {
    if ((root as Node & {readonly hasError?: unknown}).hasError !== false) return undefined;
    const reviews = analysedFunctions(root, source, text);
    return reviews.length === 1 ? reviews[0]!.facts : undefined;
  });
}

/** Source-order aid only; no mutation, readiness, authority or repair inference. */
export async function goReturnedLocalReview(source: GoReturnedLocalSource): Promise<string | undefined> {
  return (await goReturnedLocalFacts(source))?.text;
}

// ---------------------------------------------------------------------------
// Code tokens, and where a change must land for the post-edit note to fire.
// ---------------------------------------------------------------------------

/**
 * The code tokens of Go source (offsets plus `base`): identifiers and numbers as
 * runs, string, raw-string and rune literals whole, every other mark alone.
 * Comments, whitespace and `;` are set aside, so a comment, a blank line, a
 * reflow or a trailing comment changes no token. A lexer of its own rather than
 * the parse tree's leaves: the grammar keeps a string literal's content out of
 * its leaves and spells a blank line as another newline token.
 */
function codeTokens(source: string, base: number): CodeToken[] {
  const tokens: CodeToken[] = [];
  const word = /[\p{L}\p{N}_]/u;
  const length = source.length;
  let at = 0;
  while (at < length) {
    const mark = source[at]!;
    if (mark === ";" || /\s/u.test(mark)) { at++; continue; }
    if (mark === "/" && source[at + 1] === "/") { while (at < length && source[at] !== "\n") at++; continue; }
    if (mark === "/" && source[at + 1] === "*") { const end = source.indexOf("*/", at + 2); at = end < 0 ? length : end + 2; continue; }
    let next = at + 1;
    if (mark === "\"" || mark === "'") {
      while (next < length && source[next] !== mark && source[next] !== "\n") next += source[next] === "\\" ? 2 : 1;
      next = Math.min(next + 1, length);
    } else if (mark === "`") {
      const end = source.indexOf("`", next);
      next = end < 0 ? length : end + 1;
    } else if (word.test(mark)) {
      while (next < length && word.test(source[next]!)) next++;
    }
    tokens.push({text: source.slice(at, next), start: base + at});
    at = next;
  }
  return tokens;
}

/** A function holds a few thousand tokens at most (12 KiB): 2,000 x 2,000 differing ones are compared, more is a rewrite and the note abstains. */
const TOKEN_DIFF_CELLS = 4_000_000;

/**
 * Which tokens of `before` and `after` the edit changed: the ones outside a
 * longest common subsequence (after trimming the common head and tail), as
 * indexes into each. `undefined` when the differing middle is too large to
 * compare, which makes the caller abstain.
 */
function changedTokens(before: readonly CodeToken[], after: readonly CodeToken[]): {removed: number[]; added: number[]} | undefined {
  let head = 0;
  while (head < before.length && head < after.length && before[head]!.text === after[head]!.text) head++;
  let tail = 0;
  while (tail < before.length - head && tail < after.length - head
    && before[before.length - 1 - tail]!.text === after[after.length - 1 - tail]!.text) tail++;
  const a = before.slice(head, before.length - tail), b = after.slice(head, after.length - tail);
  const range = (from: number, count: number): number[] => Array.from({length: count}, (_, offset) => from + offset);
  if (a.length === 0 || b.length === 0) return {removed: range(head, a.length), added: range(head, b.length)};
  if (a.length * b.length > TOKEN_DIFF_CELLS) return undefined;
  const width = b.length + 1;
  const common = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
    common[i * width + j] = a[i]!.text === b[j]!.text
      ? common[(i + 1) * width + j + 1]! + 1
      : Math.max(common[(i + 1) * width + j]!, common[i * width + j + 1]!);
  const removed: number[] = [], added: number[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i]!.text === b[j]!.text) { i++; j++; continue; }
    if (j < b.length && (i === a.length || common[i * width + j + 1]! >= common[(i + 1) * width + j]!)) added.push(head + j++);
    else removed.push(head + i++);
  }
  return {removed, added};
}

const STATEMENT_TYPES = new Set([
  "short_var_declaration", "assignment_statement", "expression_statement", "inc_statement", "dec_statement",
  "send_statement", "return_statement", "go_statement", "defer_statement", "var_declaration", "const_declaration",
  "receive_statement", "if_statement", "for_statement", "expression_switch_statement", "type_switch_statement",
  "select_statement",
]);
const COMPOUND_STATEMENT_TYPES = new Set(["if_statement", "for_statement", "expression_switch_statement", "type_switch_statement", "select_statement"]);

/** A statement's stretch: the whole of a simple one, only the header (up to its body or first case) of a compound one. */
function statementSpan(statement: Node): readonly [number, number] {
  if (!COMPOUND_STATEMENT_TYPES.has(statement.type)) return [statement.startIndex, statement.endIndex];
  const body = children(statement).find(node => node.type === "block" || node.type.endsWith("_case"));
  return [statement.startIndex, body?.startIndex ?? statement.endIndex];
}

/**
 * What a change above the final write must touch, for the post-edit note to be
 * about it (2026-10-24, generality audit §3.9.5: the note had fired on a
 * comment, a blank line, a rename or a string elsewhere in the function):
 *   - the function's signature;
 *   - the call statement `x.M(args)` itself (a compound statement counts by its
 *     header: `if err := x.M(args); err != nil`, not the body under it);
 *   - a statement that declares or assigns an identifier the call's arguments use,
 *     one level (`normalSide := …` for `x.M(p, normalSide)`, the `for` header that
 *     declares `p`), not what those statements read in turn;
 *   - a statement that declares or assigns the returned local (`x := T{…}`, `x.G = …`).
 */
function watchDetail(fn: Node, text: string, local: string, call: Node, write: Node, nodes: readonly Node[]): WatchDetail {
  const nodeText = (node: Node): string => text.slice(node.startIndex, node.endIndex);
  const body = fn.childForFieldName("body");
  const watched: Array<readonly [number, number]> = [[fn.startIndex, body?.startIndex ?? fn.startIndex]];
  const innermostStatement = (inner: Node): Node | undefined => nodes
    .filter(node => STATEMENT_TYPES.has(node.type) && node.startIndex <= inner.startIndex && node.endIndex >= inner.endIndex)
    .sort((x, y) => y.startIndex - x.startIndex || x.endIndex - y.endIndex)[0];
  const callStatement = innermostStatement(call);
  if (callStatement) watched.push(statementSpan(callStatement));
  // A call in an if initializer is evaluated under the whole header, not just
  // the short declaration: its condition decides whether the body and its
  // returned error branch run. Keep the compound headers that contain it too.
  for (const node of nodes) {
    if (COMPOUND_STATEMENT_TYPES.has(node.type) && node.startIndex <= call.startIndex && node.endIndex >= call.endIndex)
      watched.push(statementSpan(node));
  }
  // A return/continue/break/goto before the call can decide whether the call is
  // reached. Include that jump and its governing compound headers, so adding a
  // guard or changing its condition is visible while unrelated statements stay
  // outside the watched set.
  const exits = new Set(["return_statement", "continue_statement", "break_statement", "goto_statement"]);
  for (const exit of nodes) {
    if (!exits.has(exit.type) || exit.startIndex >= call.startIndex) continue;
    watched.push([exit.startIndex, exit.endIndex]);
    for (const owner of nodes) {
      if (COMPOUND_STATEMENT_TYPES.has(owner.type) && owner.startIndex <= exit.startIndex && owner.endIndex >= exit.endIndex)
        watched.push(statementSpan(owner));
    }
  }
  const argumentNames = new Set((descendants(call.childForFieldName("arguments") ?? call) ?? [])
    .filter(node => node.type === "identifier").map(nodeText));
  argumentNames.add(local);
  // The root identifier of an assigned expression: `out.Score`, `items[i]`, `*p` and `(x)` all assign through `out`, `items`, `p`, `x`.
  const rootName = (node: Node | null | undefined): string | undefined => {
    for (let current = node, hops = 0; current && hops < 64; hops++) {
      if (current.type === "identifier") return nodeText(current);
      current = current.type === "parenthesized_expression" ? children(current)[0] : current.childForFieldName("operand");
    }
    return undefined;
  };
  const namesOf = (node: Node): string[] => {
    const listed = (list: Node | null): string[] => children(list).map(rootName).filter((name): name is string => name !== undefined);
    switch (node.type) {
      case "short_var_declaration": case "assignment_statement": case "range_clause": case "receive_statement":
        return listed(node.childForFieldName("left"));
      case "inc_statement": case "dec_statement": {
        const name = rootName(children(node)[0]);
        return name === undefined ? [] : [name];
      }
      case "var_spec": case "const_spec":
        return children(node).filter(child => child.type === "identifier").map(nodeText);
      default: return [];
    }
  };
  for (const node of nodes) {
    if (node.startIndex >= write.startIndex || !namesOf(node).some(name => argumentNames.has(name))) continue;
    const statement = innermostStatement(node);
    if (statement) watched.push(statementSpan(statement));
  }
  // Declarations only (an assignment names an existing variable): parameters, `:=`, var and const specs, `range … :=`.
  const declared = new Set<string>();
  for (const node of nodes) {
    if (node.type === "parameter_declaration" || node.type === "variadic_parameter_declaration" || node.type === "var_spec" || node.type === "const_spec") {
      for (const child of children(node)) if (child.type === "identifier") declared.add(nodeText(child));
    } else if (node.type === "short_var_declaration" || (node.type === "range_clause" && nodeText(node).includes(":="))) {
      for (const name of namesOf(node)) declared.add(name);
    }
  }
  return {tokens: codeTokens(nodeText(fn), fn.startIndex), watched, writeStart: write.startIndex, declared};
}

const GO_NAME = /^[\p{L}_][\p{L}\p{N}_]*$/u;

/**
 * Whether the edit is nothing but a consistent renaming of names the function
 * declares (a parameter, a local): the same tokens in the same order, every
 * differing token a name, each old name replaced everywhere by one new name that
 * the function did not use. Such an edit moves no value into the call, and
 * touches the signature and every statement that mentions the name. A
 * package-level name (`account.DebitNormal` for `account.CreditNormal`) is no
 * such rename: it picks another value.
 */
function isRenameOnly(was: WatchDetail, now: WatchDetail): boolean {
  const before = was.tokens, after = now.tokens;
  if (before.length !== after.length) return false;
  const renamed = new Map<string, string>();
  for (let index = 0; index < before.length; index++) {
    const from = before[index]!.text, to = after[index]!.text;
    if (from === to) continue;
    if (!GO_NAME.test(from) || !GO_NAME.test(to) || (renamed.get(from) ?? to) !== to) return false;
    renamed.set(from, to);
  }
  if (renamed.size === 0) return false;
  const used = new Set(before.map(token => token.text)), targets = new Set(renamed.values());
  if (targets.size !== renamed.size) return false;
  for (const [from, to] of renamed) if (!was.declared.has(from) || used.has(to)) return false;
  return before.every((token, index) => !renamed.has(token.text) || after[index]!.text === renamed.get(token.text));
}

/** Whether a changed code token above the final write lies in a watched stretch, in the function as it was or as it is. */
function reachesTheCall(was: WatchDetail, now: WatchDetail): boolean {
  if (isRenameOnly(was, now)) return false;
  const changed = changedTokens(was.tokens, now.tokens);
  if (changed === undefined) return false;
  const lands = (detail: WatchDetail, token: CodeToken): boolean => token.start < detail.writeStart
    && detail.watched.some(([from, to]) => token.start >= from && token.start < to);
  return changed.removed.some(index => lands(was, was.tokens[index]!)) || changed.added.some(index => lands(now, now.tokens[index]!));
}

/** At most this many changed functions of a large file are analysed in one edit. */
const POST_EDIT_FUNCTIONS_MAX = 8;

const lineCountOf = (text: string): number => text.replace(/\n$/u, "").split("\n").length;

/**
 * A function's identity across an edit: its receiver type (without spaces) and its name. A name the text
 * declares twice (`init`) names no function, so it pairs with none.
 */
function functionKey(fn: Node, text: string): string {
  const name = fn.childForFieldName("name");
  const receiver = fn.type === "method_declaration" ? children(fn.childForFieldName("receiver"))[0]?.childForFieldName("type") : undefined;
  return (receiver ? text.slice(receiver.startIndex, receiver.endIndex).replace(/\s+/gu, "") : "") + "." + (name ? text.slice(name.startIndex, name.endIndex) : "");
}

/**
 * After an edit that changed what feeds the call above a final `<local>.<Field>`
 * write and left that write alone, one fact in the shape of the pack-time
 * returned-local review: the return still reads the write (2026-10-22,
 * codex-copilot-proxy r18 T07, where a one-site edit of the earlier line left
 * the unconditional `b.Net, err = b.Debit.Sub(b.Credit)` in place until a
 * second edit cycle). `before` and `after` are the whole file's texts; line
 * numbers in the note are post-edit. Abstains unless the function is strong and
 * discard-safe in both texts, the same one, with the same write.
 *
 * It fires only when the edit changed CODE above the write in a place that can
 * reach the call (2026-10-24, generality audit §3.9.5: it had fired on a
 * comment, a blank line, an unrelated rename or string, a trailing comment on
 * the call line): a code token of the function's signature, of the call
 * statement itself, of a statement that declares or assigns an identifier the
 * call's arguments use (one level: T07's `normalSide :=` line) or of one that
 * declares or assigns the returned local. Comment-only and whitespace-only
 * changes, and changes to any other statement, stay silent (`watchDetail`).
 *
 * Which function: in a file of at most 12 KiB (both texts) the one that qualifies
 * in each, exactly one per text; in a larger file, each function whose text the
 * edit changed (at most eight, each of at most 12 KiB), before and after, paired
 * by receiver and name, the first note in source order wins. Source-order fact
 * only: it names no defect and prescribes no edit.
 */
export async function goPostEditReview(input: {path: string; before: string; after: string}): Promise<string | undefined> {
  const {path, before, after} = input;
  if (!path.endsWith(".go") || path.endsWith("_test.go") || /[\r\n\0]/u.test(path) || before === after
    || Buffer.byteLength(before, "utf8") > GO_REVIEW_TEXT_BYTES
    || Buffer.byteLength(after, "utf8") > GO_REVIEW_TEXT_BYTES) return undefined;
  const wasText = before.replace(/\r\n/g, "\n"), nowText = after.replace(/\r\n/g, "\n");
  if (wasText.includes("\r") || nowText.includes("\r")) return undefined;
  const whole = Buffer.byteLength(before, "utf8") <= WHOLE_FILE_BYTES && Buffer.byteLength(after, "utf8") <= WHOLE_FILE_BYTES;
  const sourceOf = (body: string): GoReturnedLocalSource => ({path, startLine: 1, endLine: lineCountOf(body), body, fresh: true, complete: true});
  const noteFor = (was: FunctionAnalysis | undefined, now: FunctionAnalysis | undefined): string | undefined => {
    if (!was || !now) return undefined;
    const old = was.facts, current = now.facts;
    if (old.form !== "strong" || current.form !== "strong" || !old.discardSafe || !current.discardSafe
      || old.functionName !== current.functionName || old.local !== current.local || old.field !== current.field
      || old.writeText !== current.writeText) return undefined;
    if (!reachesTheCall(was.detail(), now.detail())) return undefined;
    for (const withWrite of [true, false]) {
      const note = path + ": after this edit, return " + current.local + " L" + current.returnLine + " still returns the "
        + current.field + " assigned at L" + current.writeLine + (withWrite ? " (" + current.writeText + ")" : "")
        + ", not one set by " + current.callText + " L" + current.callLine + ".";
      if (Buffer.byteLength(note, "utf8") <= 240) return note;
    }
    return undefined;
  };
  return withTreeSitterRoot(wasText, "go", {}, rootBefore => withTreeSitterRoot(nowText, "go", {}, rootAfter => {
    const clean = (root: Node): boolean => (root as Node & {readonly hasError?: unknown}).hasError === false;
    if (!clean(rootBefore) || !clean(rootAfter)) return undefined;
    const wasSource = sourceOf(wasText), nowSource = sourceOf(nowText);
    if (whole) {
      const was = analysedFunctions(rootBefore, wasSource, wasText), now = analysedFunctions(rootAfter, nowSource, nowText);
      return was.length === 1 && now.length === 1 ? noteFor(was[0], now[0]) : undefined;
    }
    const keyed = (root: Node, text: string): Map<string, Node[]> => {
      const groups = new Map<string, Node[]>();
      for (const fn of declaredFunctions(root)) {
        const key = functionKey(fn, text);
        groups.set(key, [...(groups.get(key) ?? []), fn]);
      }
      return groups;
    };
    const wasFunctions = keyed(rootBefore, wasText), nowFunctions = keyed(rootAfter, nowText);
    let analysed = 0;
    for (const fn of declaredFunctions(rootAfter)) {
      const key = functionKey(fn, nowText), old = wasFunctions.get(key)?.[0];
      if (old === undefined || wasFunctions.get(key)?.length !== 1 || nowFunctions.get(key)?.length !== 1) continue;
      if (wasText.slice(old.startIndex, old.endIndex) === nowText.slice(fn.startIndex, fn.endIndex)
        || !functionFits(old, wasText) || !functionFits(fn, nowText)) continue;
      if (++analysed > POST_EDIT_FUNCTIONS_MAX) break;
      const note = noteFor(functionAnalysis(old, wasSource, wasText), functionAnalysis(fn, nowSource, nowText));
      if (note !== undefined) return note;
    }
    return undefined;
  }));
}

const POST_EDIT_NOTES_MAX = 2;
const POST_EDIT_NOTES_BYTES = 480;

/**
 * The `review_note` of one edit call: the notes of up to two edited files, in
 * edit order, one per line, within 480 bytes (a second note that would not fit
 * is dropped; one note is at most 240 bytes). `undefined` when no file has one.
 */
export function joinPostEditNotes(notes: readonly string[]): string | undefined {
  const kept = notes.slice(0, POST_EDIT_NOTES_MAX);
  if (kept.length === 0) return undefined;
  const joined = kept.join("\n");
  return kept.length > 1 && Buffer.byteLength(joined, "utf8") > POST_EDIT_NOTES_BYTES ? kept[0] : joined;
}
