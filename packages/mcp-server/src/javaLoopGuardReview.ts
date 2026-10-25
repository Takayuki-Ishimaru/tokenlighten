import {withTreeSitterRoot, type TreeSitterNode as Node} from "./skeleton/treeSitter.js";

const JAVA_GUARD_ORIGIN = Symbol("tl.javaLoopGuardOrigin");
type Origin = Readonly<{path: string; body: string; range: string; text: string}>;
export function bindJavaLoopGuardOrigin(surface: object, origin: Origin): void {
  (surface as {[JAVA_GUARD_ORIGIN]?: Origin})[JAVA_GUARD_ORIGIN] = Object.freeze(origin);
}
export function javaLoopGuardOrigin(surface: object): Origin | undefined {
  return (surface as {[JAVA_GUARD_ORIGIN]?: Origin})[JAVA_GUARD_ORIGIN];
}
export type JavaLoopGuardCandidate = Readonly<{fullBody: string; firstLine: number; lastLine: number; text: string}>;
type Window = Readonly<{path: string; fullBody: string; body: string; startLine: number; endLine: number;
  fresh: boolean; complete: boolean; truncated?: boolean}>;
function children(node: Node): Node[] {
  const out: Node[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) out.push(child);
  }
  return out;
}
const contains = (outer: Node | null, inner: Node): boolean =>
  outer !== null && outer.startIndex <= inner.startIndex && outer.endIndex >= inner.endIndex;
function unwrap(node: Node | null): Node | null {
  while (node?.type === "parenthesized_expression" || node?.type === "condition") {
    const named = children(node);
    if (named.length !== 1) return null;
    node = named[0]!;
  }
  return node;
}
/** Narrow binding proof for the stronger equality-at-bound aid; never evaluate delays. */
function stableLoopOperands(root: Node, method: Node | undefined, loop: Node, call: Node,
  counter: string, bound: string, exact: (node: Node) => string): boolean {
  if (!method) return false;
  const collect = (start: Node): Node[] => {
    const result: Node[] = [], pending = [start];
    while (pending.length) {
      const node = pending.pop()!;
      if (result.length >= 16384) return [];
      result.push(node); pending.push(...children(node));
    }
    return result;
  };
  const all = collect(root), local = collect(method), body = loop.childForFieldName("body");
  const init = loop.childForFieldName("init"), update = loop.childForFieldName("update");
  if (!all.length || !local.length || !body || init?.type !== "local_variable_declaration"
    || exact(init.childForFieldName("type") ?? init) !== "int"
    || !update || ![counter + "++", "++" + counter].includes(exact(update).replace(/\s/g, ""))) return false;
  const names = (nodes: Node[], name: string) => nodes.filter(node =>
    ["variable_declarator", "formal_parameter", "catch_formal_parameter", "inferred_parameters"].includes(node.type)
    && (exact(node.childForFieldName("name") ?? node) === name));
  const counterDecl = names(local, counter);
  if (counterDecl.length !== 1 || !contains(init, counterDecl[0]!)) return false;
  // An unqualified immutable class field is accepted only when its binding is
  // unique throughout the file and no local/parameter declaration can shadow it.
  const bounds = names(all, bound);
  if (bounds.length !== 1 || names(local, bound).length !== 0) return false;
  const fields = all.filter(node => node.type === "field_declaration" && contains(node, bounds[0]!));
  if (fields.length !== 1) return false;
  const field = fields[0]!, modifiers = children(field).find(node => node.type === "modifiers");
  if (!modifiers || !/\bstatic\b/.test(exact(modifiers)) || !/\bfinal\b/.test(exact(modifiers))
    || !["int", "long"].includes(exact(field.childForFieldName("type") ?? field))) return false;
  const owner = all.filter(node => node.type === "class_body" && contains(node, field) && contains(node, method));
  if (owner.length !== 1 || names(all, "Thread").length !== 0) return false;
  const args = call.childForFieldName("arguments"), argv = args ? children(args) : [];
  if (argv.length !== 1 || argv[0]!.type !== "identifier") return false;
  const delay = exact(argv[0]!), delays = names(local, delay);
  if (delays.length !== 1 || !contains(body, delays[0]!) || delays[0]!.endIndex > call.startIndex) return false;
  const protectedNames = new Set([counter, bound, delay]);
  for (const node of collect(body)) {
    if (["lambda_expression", "class_declaration", "class_body", "for_statement", "enhanced_for_statement",
      "while_statement", "do_statement"].includes(node.type)) return false;
    if (node.type === "assignment_expression" || node.type === "update_expression") {
      if (collect(node).some(child => child.type === "identifier" && protectedNames.has(exact(child)))) return false;
    }
  }
  return true;
}
/** Structural source aid only. No count, delay evaluation or guaranteed execution. */
export async function analyzeJavaLoopGuards(path: string, fullBody: string): Promise<readonly JavaLoopGuardCandidate[] | undefined> {
  if (!path.endsWith(".java") || /[\r\n\0]/u.test(path) || Buffer.byteLength(fullBody, "utf8") > 96 * 1024) return undefined;
  const text = fullBody.replace(/\r\n/g, "\n");
  if (!text || text.includes("\r")) return undefined;
  return withTreeSitterRoot(text, "java", {}, root => {
    if ((root as Node & {readonly hasError?: unknown}).hasError !== false) return undefined;
    const found: JavaLoopGuardCandidate[] = [];
    const pending: Array<{node: Node; ancestors: Node[]}> = [{node: root, ancestors: []}];
    let visited = 0;
    const exact = (node: Node): string => text.slice(node.startIndex, node.endIndex);
    const binary = (raw: Node | null, operator: string): {node: Node; left: Node; right: Node} | undefined => {
      const node = unwrap(raw);
      if (node?.type !== "binary_expression") return undefined;
      const left = node.childForFieldName("left"), right = node.childForFieldName("right");
      if (!left || !right || left.type !== "identifier" || !["identifier", "decimal_integer_literal"].includes(right.type)
        || text.slice(left.endIndex, right.startIndex).trim() !== operator) return undefined;
      return {node, left, right};
    };
    while (pending.length) {
      const {node, ancestors} = pending.pop()!;
      if (++visited > 16384 || found.length > 4) return undefined;
      if (node.type === "method_invocation"
        && exact(node.childForFieldName("name") ?? node) === "sleep"
        && node.childForFieldName("object")?.type === "identifier"
        && exact(node.childForFieldName("object")!) === "Thread") {
        let loopIndex = -1, branchIndex = -1;
        for (let i = ancestors.length - 1; i >= 0; i--) {
          if (loopIndex < 0 && ancestors[i]!.type === "for_statement") loopIndex = i;
          if (branchIndex < 0 && ancestors[i]!.type === "if_statement") branchIndex = i;
        }
        if (loopIndex >= 0 && branchIndex > loopIndex) {
          const loop = ancestors[loopIndex]!, branch = ancestors[branchIndex]!;
          const boundary = ancestors.slice(loopIndex + 1).some(parent =>
            ["lambda_expression", "class_declaration", "class_body", "method_declaration", "constructor_declaration"].includes(parent.type));
          const loopCondition = binary(loop.childForFieldName("condition"), "<=");
          const guard = binary(branch.childForFieldName("condition"), "<");
          if (!boundary && contains(loop.childForFieldName("body"), branch)
            && contains(branch.childForFieldName("consequence"), node) && loopCondition && guard
            && exact(loopCondition.left) === exact(guard.left) && exact(loopCondition.right) === exact(guard.right)
            && stableLoopOperands(root, [...ancestors].reverse().find(parent => parent.type === "method_declaration"),
              loop, node, exact(loopCondition.left), exact(loopCondition.right), exact)) {
            const call = exact(node), condition = exact(guard.node), loopText = exact(loopCondition.node);
            const callLine = (node.startPosition?.row ?? -2) + 1;
            const guardLine = (guard.node.startPosition?.row ?? -2) + 1;
            const loopLine = (loopCondition.node.startPosition?.row ?? -2) + 1;
            const aid = "L" + callLine + " " + call + " requires L" + guardLine + " (" + condition
              + "); loop L" + loopLine + ": " + loopText + ". At loop bound: guard false, no sleep. Logged delay is not a wait.";
            if (loopLine > 0 && guardLine > 0 && callLine > 0 && !/[\r\n]/u.test(call + condition + loopText)
              && Buffer.byteLength(aid, "utf8") <= 200) {
              found.push(Object.freeze({fullBody: text, firstLine: Math.min(loopLine, guardLine, callLine),
                lastLine: Math.max(loopLine, guardLine, (node.endPosition?.row ?? node.startPosition?.row ?? -2) + 1), text: aid}));
            }
          }
        }
      }
      const next = children(node);
      for (let i = next.length - 1; i >= 0; i--) pending.push({node: next[i]!, ancestors: [...ancestors, node]});
    }
    return found;
  });
}
export function javaLoopGuardReview(source: Window, candidates: readonly JavaLoopGuardCandidate[] | undefined): string | undefined {
  if (!source.fresh || !source.complete || source.truncated || !source.path.endsWith(".java")
    || !Number.isSafeInteger(source.startLine) || !Number.isSafeInteger(source.endLine)
    || source.startLine < 1 || source.endLine < source.startLine) return undefined;
  const full = source.fullBody.replace(/\r\n/g, "\n"), body = source.body.replace(/\r\n/g, "\n");
  if (body.includes("\r") || full.includes("\r")) return undefined;
  const lines = full.split("\n");
  if (source.endLine > lines.length) return undefined;
  const expected = lines.slice(source.startLine - 1, source.endLine).join("\n");
  if (body.replace(/\n$/u, "") !== expected.replace(/\n$/u, "")) return undefined;
  const held = candidates?.filter(row => row.fullBody === full && row.firstLine >= source.startLine && row.lastLine <= source.endLine);
  return held?.length === 1 ? held[0]!.text : undefined;
}
