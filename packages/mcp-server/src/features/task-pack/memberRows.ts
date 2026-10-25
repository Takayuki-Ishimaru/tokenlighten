// memberRows.ts — the ROWS of one member body: the lines of a method that
// matter to "which collaborators does it call, under which conditions, and what
// does it leave behind", and nothing else. Pure and fs-free, like structureMap.ts, which calls it.
//
// WHY ROWS (2026-10-23, codex-copilot-proxy r18 T03). A structure map owes the
// members that call a requested concern. Serving each as its WHOLE body made a
// 1,552-line class cost 29.6 KB of owed source, so the continuation of the
// first reply took two more pages and every earlier page was re-sent with every
// later request. What the question asks for is the order of the calls, what
// decides whether they run, and what they leave the order in, so an owed member
// is served as its rows:
//
//   • its signature (the caller keeps that line anyway),
//   • every statement that invokes one of the requested concerns, or a helper
//     of the type that does (the caller's `isConcernLine`; a call whose receiver
//     and `.method(` stand on different lines is the statement's, read through
//     the caller's `isConcernText`, and the statement is served whole),
//   • every `return` / `throw` / `raise` statement that can skip what follows
//     it (the `return` that closes the member's own body decides nothing), and
//     every jump that skips part of a loop the same way: `continue`, a `break`
//     that leaves a loop (not the `break` that closes a `case`), a labelled
//     `break` / `continue`, `goto` and `yield` — the `if (labelled) { continue; }`
//     of a sweep is the line that says which items it leaves alone,
//   • every statement that decides between two values (`cond ? a : b`,
//     `a if cond else b`) — a target picked before the calls,
//   • the EFFECTS of the member, whatever the concern and WHATEVER THE LANGUAGE
//     (2026-10-24, the generality audit: the vocabulary this began with —
//     `<recv>.setX(…)`, `save` / `persist` / `update` …, `*Repository` receivers,
//     "audit" — was Java / Spring's, and found not one save in 127,916 C#
//     statements, `stream.write` and `this.emit` in none of JavaScript's, and
//     `f.write` / `session.commit` in none of Python's). A statement is an effect
//     row when it
//       (a) is an expression statement that calls something, so its value is thrown
//           away and it runs for what it does: `foo(…)`, `a.b.c(…)`, `await x.y(…)`,
//           `new Foo(…)`, `super(…)`, `this.emit(…)`, Go's `go f()`, `defer f.Close()`
//           and `_ = f()`, C's `(void) f();`, Python's bare and awaited calls,
//           `ready && start();` — also as the inline body of an `if (…) …;`, an
//           `else …;`, Python's `if x: …`, and as the body of an arm
//           (`case 2 -> work();`, Kotlin's `A -> work()`);
//       (b) writes a location that outlives the member: an assignment, a compound
//           assignment or `++` / `--` whose target has a member access or an index
//           (`x.y =`, `x->y =`, `x[i] =`, `self.cache[k] = v`, `this.count++`,
//           `++obj.n`), Python's `del x[k]` / `del x.y`, JavaScript's `delete x.y`,
//           a pointer (`*p = v`), a channel (`ch <- v`), a stream (`out << v`);
//           and, when the caller passes the type's field names (`fields`), a bare
//           identifier that is one of them (`status = OrderStatus.PAID;`, where a
//           field needs no `this.`) — unless the member declares a local or a
//           parameter of that name (`parameterNames`);
//       (c) calls, with its value used, a method named for a verb that writes
//           (its first word in camelCase, PascalCase or snake_case: save, persist,
//           merge, update, upsert, delete, remove, insert, store, flush, write,
//           append, commit, rollback, exec, execute, put, post, patch, send, publish,
//           emit, dispatch, enqueue, push, create, drop, truncate, rename, move, copy,
//           unlink, mkdir, set, add, clear, reset, register, schedule, cancel, submit,
//           notify, log, audit, record …): `Order saved = repo.save(o)`,
//           `n, err := w.Write(buf)`, `ok = await file.writeAsync(…)`; or calls on a
//           repository / dao / store receiver; or a setter in any case convention
//           (`.setX(`, `.set_x(`, `.SetX(`, `setattr(`) — except the verbs that
//           compute (`Math.log(x)`, `a.add(b)` assigned or returned, `copyOf`, `setOf`);
//     and everything the first vocabulary selected is still selected: the user's
//     rule (2026-10-23, after r16-r18) is that rows keep the state writes, saves
//     and audits, so a map that lists the calls but not the status they leave the
//     order in cannot tell `CREATED → PAID` from a table row. What a rule here
//     cannot tell apart from an effect (a log statement, `list.add(x)` on a local
//     collection) is a row too; a row that is not needed costs bytes, one that
//     is missing costs the answer, and when the rows no longer fit one continuation
//     page the map falls back to the whole bodies,
//   • the FAILURE HANDLING: every `try` of a mapped member keeps its header, the
//     calls its block makes (the failure its handlers answer, whatever they are
//     called) and every `catch` / `except` / `finally` clause with its whole handler
//     (a handler over MEMBER_ROW_HANDLER_MAX_LINES lines is its header, its first
//     lines and its closing brace) — whatever the block calls, and without the
//     type's collaborator fields, which only a constructor that injects them shows
//     (C++ 0 of 108 types, C# 10%); Go's `if err != nil { … }` is a control line and
//     an exit already,
//   • the control lines ENCLOSING any of those, in source order: the `if` /
//     `else if` / `else` headers (an `else` also brings the `if` it answers),
//     `for` / `while` / `do` headers (loop guards), `try` with its `catch` /
//     `finally` / `except` clauses, `with` (Python's context managers, Kotlin's
//     `with(x) {`), `switch` / `match` / `when` headers and the `case` / `default`
//     labels in front of the statement,
//   • the spans a caller anchors (a review note's lines, see `anchors`).
//
// It is a lexical reading of comment- and string-masked text, like the rest of
// the map (sfCodeMask.ts), not a parser. Two layouts are read: braces
// (`{ … }`: Java, TypeScript, C#, Kotlin, Go, …) and indentation with a colon
// (Python). A body whose braces do not balance cannot be read lexically, and
// `memberBodyRows` answers `undefined` so that the caller keeps the whole
// member, as it did before rows existed.
//
// Python's signature runs through the first statement of the body
// (`structureMapTypeOf`), so a member that opens with `try:` / `for …:` / `with …:` /
// `if …:` has its body begin inside that block, where the `except` / `finally` /
// `else` clauses after it have no header to continue: such a body is read once more
// from the header line (`memberBodyRows`).

import { maskCommentsAndStrings } from "./sfCodeMask.js";

export interface MemberRowSpan {
  readonly start: number;
  readonly end: number;
}

/** A statement over more lines than this is read by its first lines (from the first concern line in it), like the first page's call statements. */
export const MEMBER_ROW_STATEMENT_MAX_LINES = 6;
/**
 * A `return` / `throw` statement is read by its first lines only: they say how
 * the member ends and under which condition (`throw new BusinessException("CODE",`),
 * and the lines after them are the message built for the caller, which a row
 * costs as much to address as it is worth.
 */
export const MEMBER_ROW_EXIT_MAX_LINES = 1;
/**
 * A `catch` / `except` / `finally` handler is read whole up to this many lines
 * (header and closing brace included); a longer one is its header, its first
 * lines and its closing brace.
 */
export const MEMBER_ROW_HANDLER_MAX_LINES = 10;
/** A statement is read for a concern call split over its lines through at most this many of its first lines. */
const MEMBER_ROW_TEXT_SCAN_LINES = 64;

type Kind = "control" | "label" | "exit" | "plain";

interface Statement {
  readonly start: number;
  readonly end: number;
  readonly kind: Kind;
  /** The masked text, whitespace-collapsed. */
  readonly text: string;
  /** The control statements enclosing it, outermost first: headers, the clauses an `else` / `catch` continues, the switch labels in front of it. */
  readonly owners: readonly Statement[];
  /** True when the statement opens a block: it ends in `{`, or in `:` in the indented layout. */
  readonly opens: boolean;
  /** For an `else` / `catch` / `finally` clause: the clauses before it, the `if` / `try` that heads them first. */
  readonly chain: readonly Statement[];
  /** How many blocks are open around it: 0 for a statement of the member's own body. */
  readonly depth: number;
  /** For a statement that opens a block: the line of the brace (or the last line of the indented body) that closes it. */
  blockEnd?: number;
}

const CONTROL_RE = /^(?:else\s+if|else|elif|if|for|foreach|while|do|switch|match|try|catch|except|finally|when|with|async\s+with)\b/u;
const LABEL_RE = /^(?:case\b|default\s*(?::|->|$))/u;
const EXIT_RE = /^(?:return|throw|raise)\b/u;
const EXIT_INSIDE_RE = /\b(?:return|throw|raise)\b/u;
/** A statement that is a jump: `continue`, `break`, `goto`, `yield`, with the label or value that follows (`break outer;`, Kotlin's `break@outer`). */
const JUMP_RE = /^(continue|break|goto|yield)\b(?:\s*@?\s*([A-Za-z_$][\w$]*))?/u;
/** The same word inside a control statement that has no block (`if (done) break;`, `else continue outer;`), never behind a `.` (`Thread.yield()`). */
const INLINE_JUMP_RE = /(?<![\w$.@])(continue|break|goto|yield)\b(?:\s*@?\s*([A-Za-z_$][\w$]*))?/u;
const LOOP_HEADER_RE = /^(?:for|foreach|while|do)\b/u;
/** What an unlabelled `break` leaves: a loop, or the `switch` / `select` it ends a case of. (Kotlin's `when` and Python's `match` have no `break` of their own.) */
const BREAKABLE_RE = /^(?:for|foreach|while|do|switch|select)\b/u;
/** A clause that continues the chain of the block closed just before it. */
const CHAIN_RE = /^(?:else|elif|catch|except|finally)\b/u;
const SWITCH_RE = /^(?:switch|match|when)\b/u;
const ARROW_RE = /->|=>/u;
/** `cond ? a : b` with spaces around both operators, so `?.`, `??`, `?:`, `x?: T`, `<?>` and `::` do not read as one. */
const TERNARY_RE = /\s\?\s[^?]*\s:\s/u;
/** Python's `x = a if cond else b`, behind an assignment, a call or a return. */
const INLINE_IF_RE = /(?:[=(,]|\breturn\b)[^=(,]*\sif\s+[^=]+\selse\b/u;

const isBlank = (text: string): boolean => text.trim() === "";
const collapse = (text: string): string => text.replace(/\s+/gu, " ").trim();

/** `outer: for (…) {` (Java, C#, TypeScript) and `outer@ for (…) {` (Kotlin): a labelled loop is the loop. */
const LOOP_LABEL_RE = /^[A-Za-z_$][\w$]*\s*[:@]\s*(?=(?:for|foreach|while|do)\b)/u;
const unlabelled = (text: string): string => text.replace(LOOP_LABEL_RE, "");

function kindOf(text: string): Kind {
  if (LABEL_RE.test(text)) return "label";
  if (CONTROL_RE.test(unlabelled(text))) return "control";
  return EXIT_RE.test(text) ? "exit" : "plain";
}

/**
 * True when the jump `word` (`continue`, `break`, `goto`, `yield`, with its
 * `label` when it names one) skips part of what encloses it, the way a `return`
 * does: any `goto` and `yield`, any labelled `break` / `continue`, a `continue`
 * in a loop, and a `break` whose nearest enclosing `for` / `while` / `do` /
 * `switch` / `select` is a loop — the `break` that closes a `case` leaves
 * nothing out. `own` is the statement's own header when it has no block
 * (`for (…) if (done) break;`), which the jump then belongs to.
 */
function jumpsOut(word: string, label: string | undefined, owners: readonly Statement[], own?: string): boolean {
  if (word === "goto" || word === "yield" || label !== undefined) return true;
  const headers = owners.filter(owner => owner.kind === "control").map(owner => unlabelled(owner.text));
  if (own !== undefined && BREAKABLE_RE.test(unlabelled(own))) headers.push(unlabelled(own));
  if (word === "continue") return headers.some(text => LOOP_HEADER_RE.test(text));
  const nearest = [...headers].reverse().find(text => BREAKABLE_RE.test(text));
  return nearest !== undefined && LOOP_HEADER_RE.test(nearest);
}

/** One open block. */
interface Frame {
  /** The statement that opened it, when that statement is control (it then encloses everything inside). */
  readonly header: Statement | undefined;
  /** The clauses this block continues (`else` ← `if`, `catch` ← `try`), outermost first. */
  readonly chain: readonly Statement[];
  readonly isSwitch: boolean;
  /** `case` / `default` labels in front of the current statement group. */
  labels: Statement[];
  /** True once a statement followed the current labels: the next label starts a new group. */
  grouped: boolean;
  /** Indentation of the header (indented layout only). */
  readonly indent: number;
  /** An object / lambda literal inside an argument list: it encloses no control line and does not end the statement. */
  readonly inline: boolean;
}

interface Scanner {
  readonly statements: Statement[];
  /** Frames currently open, outermost first. */
  readonly stack: Frame[];
  /** The block closed last, while no statement has followed it yet. */
  closed: Frame | undefined;
}

const newScanner = (): Scanner => ({ statements: [], stack: [], closed: undefined });

function ownersOf(stack: readonly Frame[], exceptLabelsOf?: Frame): Statement[] {
  const out: Statement[] = [];
  for (const frame of stack) {
    out.push(...frame.chain);
    if (frame.header !== undefined) out.push(frame.header);
    if (frame !== exceptLabelsOf) out.push(...frame.labels);
  }
  return out;
}

/** Records one finished statement against the block state of `scan`. */
function emit(scan: Scanner, start: number, end: number, rawText: string, opens: boolean, indent = 0): Statement {
  const text = collapse(rawText);
  const base = kindOf(text);
  const continues = base === "control" && CHAIN_RE.test(text) && scan.closed !== undefined && scan.closed.indent === indent;
  const chain = continues ? [...scan.closed!.chain, ...(scan.closed!.header !== undefined ? [scan.closed!.header] : [])] : [];
  const holder = [...scan.stack].reverse().find(frame => frame.isSwitch);
  // A label is enclosed by its switch, not by the labels beside it.
  const owners = ownersOf(scan.stack, base === "label" ? holder : undefined);
  // A jump that skips part of its loop is an exit like `return` (which loop it leaves is read from the statements around it).
  const jump = base === "plain" ? JUMP_RE.exec(text) : null;
  const kind: Kind = jump !== null && jumpsOut(jump[1]!, jump[2], owners) ? "exit" : base;
  const statement: Statement = { start, end, kind, text, owners, opens, chain, depth: scan.stack.length };
  scan.statements.push(statement);
  if (holder !== undefined) {
    if (kind === "label") {
      if (holder.grouped) { holder.labels = []; holder.grouped = false; }
      holder.labels.push(statement);
      // `case 2 -> work();` and `default -> {` carry their body: the next label starts a new group.
      if (ARROW_RE.test(text)) holder.grouped = true;
    } else {
      holder.grouped = true;
    }
  }
  scan.closed = undefined;
  if (opens) {
    const encloses = kind === "control" || (kind === "label" && text.endsWith("{")) || (kind === "plain" && /(?:->|=>)\s*\{$/u.test(text));
    scan.stack.push({ header: encloses ? statement : undefined, chain, isSwitch: kind === "control" && SWITCH_RE.test(text), labels: [], grouped: false, indent, inline: false });
  }
  return statement;
}

/**
 * True when the statement that ends at `lines[index]` goes on in a language that ends statements at line ends
 * (Kotlin, Swift, Go, JavaScript without semicolons): the line ends in a `.`, or the next line that holds code
 * starts with `.` / `?.` / `!!.` — a call chain broken before its next `.method(`.
 */
function chainContinues(lines: readonly string[], index: number): boolean {
  if (/(?:^|[^.])\.\s*$/u.test(lines[index]!)) return true;
  for (let next = index + 1; next < lines.length; next += 1) {
    if (isBlank(lines[next]!)) continue;
    return /^\s*(?:\?\.|!!\.|\.(?!\.))/u.test(lines[next]!);
  }
  return false;
}

/** The statements of a brace-delimited body; `undefined` when its braces do not balance. */
function scanBraces(lines: readonly string[], firstLine: number): Statement[] | undefined {
  const scan = newScanner();
  const semicolons = lines.some(line => line.includes(";"));
  const hasBraces = lines.some(line => /[{}]/u.test(line));
  let sawMemberClose = false;
  let text = "";
  let startLine = -1;
  let parens = 0;
  /** `?` of a `cond ? a : b` still waiting for its `:` — in a `case` label that colon is not the label's. */
  let questions = 0;
  const flush = (end: number, opens: boolean): void => {
    if (!isBlank(text)) emit(scan, startLine, end, text, opens);
    text = "";
    startLine = -1;
    questions = 0;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const lineNo = firstLine + index;
    const line = lines[index]!;
    for (let column = 0; column < line.length; column += 1) {
      const ch = line[column]!;
      if (isBlank(text) && !/\s/u.test(ch) && ch !== "}") startLine = lineNo;
      if (ch === "(" || ch === "[") { parens += 1; text += ch; continue; }
      if (ch === ")" || ch === "]") { parens = Math.max(0, parens - 1); text += ch; continue; }
      if (ch === ";" && parens === 0) {
        // Go's `if err := f(); err != nil {` and `for i := 0; i < n; i++ {`: a `;` inside a header that has no parentheses.
        if (/^(?:if|for|switch)\b(?!\s*\()/u.test(collapse(text))) { text += ch; continue; }
        text += ch;
        flush(lineNo, false);
        continue;
      }
      if (ch === "?" && line[column + 1] !== "." && line[column + 1] !== "?" && line[column + 1] !== ":" && line[column - 1] !== "?") {
        questions += 1;
        text += ch;
        continue;
      }
      if (ch === "{") {
        const lambda = /(?:->|=>)\s*$/u.test(text);
        // An object literal in a `case` label (`case { key: value }:`) is part of the label.
        const literalLabel = !lambda && /^case\b/u.test(collapse(text));
        if (parens === 0 && !lambda && literalLabel) {
          text += ch;
          scan.stack.push({ header: undefined, chain: [], isSwitch: false, labels: [], grouped: false, indent: 0, inline: true });
        } else if (parens === 0 || lambda) {
          text += ch;
          flush(lineNo, true);
          if (lambda) parens = 0;
        } else {
          // An object / lambda literal inside an argument list stays part of its statement.
          text += ch;
          scan.stack.push({ header: undefined, chain: [], isSwitch: false, labels: [], grouped: false, indent: 0, inline: true });
        }
        continue;
      }
      if (ch === "}") {
        if (scan.stack[scan.stack.length - 1]?.inline === true) { scan.stack.pop(); text += ch; continue; }
        flush(lineNo, false);
        const frame = scan.stack.pop();
        if (frame?.header !== undefined) frame.header.blockEnd = lineNo;
        if (frame === undefined) {
          // The member's own closing brace is the last one of its body.
          if (/^[\s;,)]*$/u.test(`${line.slice(column + 1)}\n${lines.slice(index + 1).join("\n")}`)) { sawMemberClose = true; continue; }
          return undefined;
        }
        scan.closed = frame.header !== undefined ? frame : undefined;
        continue;
      }
      if (ch === ":" && parens === 0 && line[column + 1] !== ":" && line[column - 1] !== ":"
        && scan.stack[scan.stack.length - 1]?.inline !== true && /^(?:case\b|default\s*$)/u.test(collapse(text))) {
        text += ch;
        if (questions > 0) { questions -= 1; continue; }
        flush(lineNo, false);
        continue;
      }
      text += ch;
    }
    if (!semicolons && parens === 0 && !isBlank(text) && !chainContinues(lines, index)) flush(lineNo, false);
    else text += " ";
  }
  flush(firstLine + lines.length - 1, false);
  // A body with braces ends with the member's own closing brace: when an inner block took it, one is missing.
  return scan.stack.length === 0 && (!hasBraces || sawMemberClose) ? scan.statements : undefined;
}

const indentOf = (line: string): number => {
  let width = 0;
  for (const ch of line) {
    if (ch === " ") width += 1;
    else if (ch === "\t") width += 4;
    else break;
  }
  return width;
};

/** The statements of an indentation-delimited body (Python): a header ends in `:` and a deeper indent is its body. */
function scanIndented(lines: readonly string[], firstLine: number): Statement[] {
  const scan = newScanner();
  let index = 0;
  while (index < lines.length) {
    const first = lines[index]!;
    if (isBlank(first)) { index += 1; continue; }
    const indent = indentOf(first);
    let text = first;
    let last = index;
    let depth = 0;
    const count = (value: string): void => {
      for (const ch of value) {
        if ("([{".includes(ch)) depth += 1;
        else if (")]}".includes(ch)) depth = Math.max(0, depth - 1);
      }
    };
    count(first);
    while ((depth > 0 || /\\\s*$/u.test(text)) && last + 1 < lines.length && last - index < 16) {
      last += 1;
      text += ` ${lines[last]!}`;
      count(lines[last]!);
    }
    while (scan.stack.length > 0 && scan.stack[scan.stack.length - 1]!.indent >= indent) {
      const frame = scan.stack.pop()!;
      if (frame.header !== undefined) frame.header.blockEnd = scan.statements[scan.statements.length - 1]?.end;
      scan.closed = frame.header !== undefined ? frame : undefined;
    }
    const collapsed = collapse(text);
    const opens = /:\s*$/u.test(collapsed) && (CONTROL_RE.test(collapsed) || LABEL_RE.test(collapsed));
    emit(scan, firstLine + index, firstLine + last, text, opens, indent);
    index = last + 1;
  }
  // Blocks still open at the end of the body end with its last statement.
  for (const frame of scan.stack) {
    if (frame.header !== undefined) frame.header.blockEnd = scan.statements[scan.statements.length - 1]?.end;
  }
  return scan.statements;
}

// ---------------------------------------------------------------------------
// EFFECTS. What a statement does to the world besides calling a concern. The
// first block is the vocabulary rows were born with (Java / Spring: setters,
// repositories, audit calls); every statement it selects is still selected. The
// rest is the language-agnostic reading that replaced it as the rule (see the
// module doc): a statement whose value is discarded, a write to a non-local
// location, and a call named for a verb that writes.
// ---------------------------------------------------------------------------

/** `<recv>.setX(…)`, `.SetX(…)`, `.set_x(…)`, Python's `setattr(…)`: a setter call in any case convention (`order.setStatus(…)`, `this.setState(…)`, Go's `o.SetStatus(…)`). */
const SETTER_CALL_RE = /(?:(?:\.|->|::)\s*[sS]et[A-Z_][A-Za-z0-9_$]*|(?<![\w$.])setattr)\s*\(/u;
/** `x.f = …`, `this.f = …`, `self.f += …`: a field assigned through a receiver, at the start of the statement (never `==`, `=>` or a declaration). */
const FIELD_ASSIGN_RE = /^[A-Za-z_$][\w$]*(?:\s*(?:\.|->)\s*[A-Za-z_$][\w$]*)+\s*(?:\*\*|<<|>>>|>>|\?\?|&&|\|\||[-+*/%&|^])?=(?![=>])/u;
/** A call to a method that persists: `repo.save(…)`, `em.persist(…)`, a bare `save(…)`; never `saveOrder(` or `autosave(` (those are read by their first word, `EFFECT_VERBS`). */
const PERSIST_CALL_RE = /(?<![\w$])(?:save|saveAll|saveAndFlush|persist|merge|update|delete|remove|insert|store|flush)\s*\(/u;
/** A call on a repository, dao or store, whatever the method (`orderRepository.findById(…)`, `this.userDao.load(…)`, `store.dispatch(…)`). */
const PERSIST_RECEIVER_RE = /(?<![\w$])(?:[\w$]*(?:Repository|Repo|Dao|DAO|Store)|repository|repo|dao|store)\s*(?:\.|->)\s*[A-Za-z_$][\w$]*\s*\(/u;
/** A call whose name contains "audit" (`auditTransition(…)`, `this.writeAuditRecord(…)`). */
const AUDIT_CALL_RE = /(?<![\w$])[\w$]*audit[\w$]*\s*\(/iu;

/**
 * What a statement does to the world besides calling a concern (see the module
 * doc): an `audit` call, a `save` (a persistence call or any other write that
 * leaves the process: a file, a socket, a queue), a `state` write (a setter, a
 * field, an index, a registry), or — with no vocabulary at all — a `call`
 * whose value is thrown away, which runs for what it does.
 */
export type MemberEffect = "audit" | "save" | "state" | "call";

/** The first words of method names that write, by what they write (`saveOrder` → save, `WriteAllText` → write, `put_item` → put). */
const SAVE_VERBS = ["save", "persist", "merge", "update", "upsert", "delete", "remove", "insert", "store", "flush", "write", "writeln", "append", "commit", "rollback",
  "exec", "execute", "put", "post", "patch", "send", "publish", "emit", "dispatch", "enqueue", "offer", "push", "create", "drop", "truncate", "rename", "move", "copy",
  "unlink", "mkdir", "mkdirs", "makedirs", "rmdir", "rmtree", "touch", "upload", "broadcast"];
const STATE_VERBS = ["set", "add", "clear", "reset", "register", "unregister", "deregister", "schedule", "cancel", "submit", "notify"];
const AUDIT_VERBS = ["audit", "log", "record"];
const EFFECT_VERBS: ReadonlyMap<string, MemberEffect> = new Map<string, MemberEffect>([
  ...SAVE_VERBS.map((verb): [string, MemberEffect] => [verb, "save"]),
  ...STATE_VERBS.map((verb): [string, MemberEffect] => [verb, "state"]),
  ...AUDIT_VERBS.map((verb): [string, MemberEffect] => [verb, "audit"]),
]);

/**
 * The words of an identifier, lower-cased, whatever its case convention:
 * `saveAndFlush` → save, and, flush; `WriteAllTextAsync` → write, all, text,
 * async; `set_status` → set, status; `UPDATE_ORDER` → update, order; `HTTPPost`
 * → http, post. The first word says what a method does (`savedOrder` and
 * `autosave` are their own first words and write nothing by their names).
 */
function wordsOf(identifier: string): string[] {
  return (identifier.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z0-9]+/gu) ?? []).map(word => word.toLowerCase());
}

/** Words after which a name followed by `(` is still a call (`return save(x)`, `await save(x)`, `else save(x)`), where any other word before it makes it a declaration (`void save(Order o)`, `def save(self)`). */
const CALL_PREFIX_WORDS = new Set(["return", "throw", "raise", "await", "yield", "else", "do", "case", "in", "is", "not", "and", "or", "typeof", "delete", "new", "go", "defer", "then", "when", "elif", "of"]);
/** Words that are followed by `(` without calling anything. */
const NOT_CALL_WORDS = new Set(["if", "for", "foreach", "while", "switch", "catch", "except", "synchronized", "lock", "using", "fixed", "with", "when", "match", "elif", "return",
  "throw", "raise", "typeof", "sizeof", "alignof", "nameof", "decltype", "instanceof", "await", "yield", "assert", "not", "and", "or", "in", "is", "else", "do", "try", "finally",
  "function", "def", "fun", "func", "lambda", "class", "defined", "unless", "until", "new"]);
/** How much of a statement in front of a name is read to tell what the name is (a receiver, a constructor, a declaration). */
const CALL_CONTEXT_CHARS = 200;
/** A name followed by `(`, with the generic arguments a call may carry (`Foo<T>(x)`). */
const CALL_SITE_RE = /(?<![\w$])([A-Za-z_$][\w$]*)\s*(?:<[^<>()]*>)?\s*(?:\?\.)?\(/gu;

interface CallSite {
  readonly name: string;
  readonly index: number;
  /** Called through a receiver or a qualifier (`a.save(`, `a->save(`, `A::save(`). */
  readonly receiver: boolean;
  /** The identifier the receiver ends in (`repo` in `this.repo.save(`, `Math` in `Math.log(`). */
  readonly owner: string | undefined;
  /** `new Foo(…)`: a constructor, which writes nothing by its name. */
  readonly constructed: boolean;
  /** `void save(…)`, `def save(…)`, `Order save(…)`: a declaration that happens to look like a call. */
  readonly declared: boolean;
}

/** `text` without its generic argument lists (`Map<String, List<X>> m` → `Map m`). */
function withoutGenerics(text: string): string {
  let out = text;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = out.replace(/<[^<>()]*>/gu, "");
    if (next === out) break;
    out = next;
  }
  return out;
}

/** The calls in `text`, in order (masked, whitespace-collapsed statement text). */
function callSitesOf(text: string): CallSite[] {
  const out: CallSite[] = [];
  for (const match of text.matchAll(CALL_SITE_RE)) {
    const name = match[1]!;
    // What stands in front of the name decides what it is, and only the last few words of it: a bounded window, not the statement so far.
    const before = text.slice(Math.max(0, match.index - CALL_CONTEXT_CHARS), match.index);
    const receiver = /(?:\.|->|::)\s*$/u.test(before);
    // `if (` is no call; `promise.catch(` and `mock.when(` are.
    if (NOT_CALL_WORDS.has(name) && !receiver) continue;
    const owner = receiver ? /([A-Za-z_$][\w$]*)\s*(?:\?\.|\.|->|::)\s*$/u.exec(before)?.[1] : undefined;
    const constructed = /(?:^|[^\w$.])new\s+(?:[\w$]+\s*(?:\.|::)\s*)*$/u.test(before);
    // The word in front of a bare name, generic arguments aside: `void save(`, `Future<Void> publish(`.
    const previous = receiver || constructed ? undefined : /([A-Za-z_$][\w$]*)\s+$/u.exec(withoutGenerics(before))?.[1];
    out.push({ name, index: match.index, receiver, owner, constructed, declared: previous !== undefined && !CALL_PREFIX_WORDS.has(previous) });
  }
  return out;
}

/** True when `text` calls something (a declaration that looks like a call is none). */
function callsSomething(text: string): boolean {
  return callSitesOf(text).some(site => !site.declared);
}

/** Receivers whose methods compute (`Math.log(x)` is no audit). */
const PURE_OWNER_RE = /^(?:Math|StrictMath|math|cmath|numpy|np)$/u;
/** C#'s `date.AddDays(1)` and `BigDecimal.add(x)` compute a new value from the old one. */
const ARITHMETIC_ADD_RE = /^(?:add|Add(?:Days|Hours|Minutes|Seconds|Milliseconds|Ticks|Weeks|Months|Years)?)$/u;

/**
 * A call, anywhere in `text`, named for a verb that writes (`EFFECT_VERBS`):
 * `Order saved = repo.save(o)`, `n, err := w.Write(buf)`, `ok = await
 * file.writeAsync(…)`, `if (!queue.offer(job))`. The value is used, so these are
 * not statements that run for their effect alone; the name says they write.
 * Not a constructor of a collection (`setOf(1, 2)`, `List.copyOf(xs)`, Python's
 * `set(items)`), not arithmetic (`Math.log(x)`, and the `add` whose result is
 * assigned or returned: `BigDecimal total = a.add(b)`, `return a.add(b)`).
 */
function verbEffectOf(text: string): MemberEffect | undefined {
  let valueKept: boolean | undefined;
  for (const site of callSitesOf(text)) {
    if (site.declared || site.constructed) continue;
    const [verb, second] = wordsOf(site.name);
    const effect = verb === undefined ? undefined : EFFECT_VERBS.get(verb);
    if (effect === undefined || second === "of") continue;
    if (verb === "set" && !site.receiver && site.name === "set") continue;
    if (site.owner !== undefined && PURE_OWNER_RE.test(site.owner)) continue;
    if (ARITHMETIC_ADD_RE.test(site.name)) {
      valueKept ??= EXIT_RE.test(text) || assignmentOperators(text).length > 0;
      if (valueKept) continue;
    }
    return effect;
  }
  return undefined;
}

/** The index of the bracket that closes the one opening at `open`, or -1. */
function closeOf(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const ch = text[index]!;
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** `text` with every bracket group emptied and every generic argument list removed: `foo(a.b)[i + 1].c` → `foo()[].c`, `Map<K, V> m` → `Map m`. */
function skeletonOf(text: string): string {
  let out = text;
  for (let pass = 0; pass < 8; pass += 1) {
    const next = out.replace(/<[^<>()[\]]*>/gu, "").replace(/\([^()[\]]*\)/gu, "()").replace(/\[[^()[\]]*\]/gu, "[]");
    if (next === out) break;
    out = next;
  }
  return out;
}

/** The assignment operators of `text` outside any bracket (`=`, `+=`, `:=`, `??=`, `>>=` …), as `[start, end)`; never `==`, `!=`, `<=`, `>=`, `=>`. */
function assignmentOperators(text: string): Array<{ readonly start: number; readonly end: number }> {
  const out: Array<{ readonly start: number; readonly end: number }> = [];
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index]!;
    if (ch === "(" || ch === "[" || ch === "{") { depth += 1; continue; }
    if (ch === ")" || ch === "]" || ch === "}") { depth = Math.max(0, depth - 1); continue; }
    if (ch !== "=" || depth > 0) continue;
    const next = text[index + 1];
    const previous = text[index - 1];
    if (next === "=") { index += 1; continue; }
    if (next === ">" || next === "~" || previous === "!") continue;
    if ((previous === "<" || previous === ">") && text[index - 2] !== previous) continue;
    let start = index;
    while (start > 0 && "+-*/%&|^?@:<>".includes(text[start - 1]!)) start -= 1;
    out.push({ start, end: index + 1 });
  }
  return out;
}

/** The value of `_ = f()`, `_, _ = f()`, `let _ = f()`: a target that throws the value away on purpose. */
const DISCARD_TARGET_RE = /^(?:(?:let|var|val|const)\s+)?_(?:\s*,\s*_)*$/u;
/** The words that start a declaration: what is assigned after them is a new local. */
const DECLARATION_WORD_RE = /^(?:var|let|const|val|final|auto|static|register|volatile|mutable|public|private|protected|internal|readonly|lateinit|local|global|nonlocal|my|our)\b/u;

/**
 * True when assigning to `target` writes a location that outlives the member:
 * a field or property reached through a receiver (`x.y`, `x->y`, `X::y`), an
 * element (`x[i]`, `self.cache[k]`), a pointer (`*p`), or — when the caller
 * knows the type's `fields` — a bare identifier that is one of them (`status`
 * in Java, C#, Kotlin and C++, where a field needs no `this.`). A declaration
 * (`final Order o`, `List<String> names`, `int[] parts`) writes a new local.
 */
function writesNonLocal(target: string, fields: ReadonlySet<string> | undefined): boolean {
  let name = target.trim();
  if (name === "" || DECLARATION_WORD_RE.test(name)) return false;
  // `self.count: int = 0`, `x: Foo = …`: the annotation is no part of the target.
  const colon = name.search(/(?<!:):(?!:)/u);
  if (colon > 0) name = name.slice(0, colon).trim();
  if (name === "" || name.startsWith("[") || name.startsWith("{")) return false;
  const skeleton = skeletonOf(name);
  if (/[\w$\]>]\s+[*&]*[A-Za-z_$]/u.test(skeleton)) return false;
  if (/^\*+\s*[A-Za-z_$(]/u.test(name) && !name.includes(",")) return true;
  if (/(?:\.|->|::)/u.test(skeleton) || name.includes("[")) return true;
  return fields !== undefined && fields.size > 0 && skeleton.split(/\s*,\s*/u).some(part => fields.has(part.trim()));
}

const INC_DEC_TARGET = String.raw`(?<![\w$])(?<!(?:\.|->|::)\s*)([A-Za-z_$][\w$]*(?:\s*(?:\.|->|::)\s*[A-Za-z_$][\w$]*|\s*\[[^\]]*\])*)`;
const POSTFIX_RE = new RegExp(`${INC_DEC_TARGET}\\s*(?:\\+\\+|--)`, "gu");
const PREFIX_RE = new RegExp(`(?:\\+\\+|--)\\s*${INC_DEC_TARGET}`, "gu");

/** `this.count++`, `++obj.n`, `x->hits--`, `counts[k]++`, and — with the type's `fields` — a bare `count++`: an increment or decrement of a non-local location, anywhere in the text (a condition too). */
function incDecEffectOf(text: string, fields: ReadonlySet<string> | undefined): MemberEffect | undefined {
  for (const re of [POSTFIX_RE, PREFIX_RE]) {
    for (const match of text.matchAll(re)) {
      const target = match[1]!;
      if (/(?:\.|->|::|\[)/u.test(target) || fields?.has(target) === true) return "state";
    }
  }
  return undefined;
}

/**
 * A statement that starts with one of these is no expression statement: it is a
 * declaration, a jump or a directive, whatever it holds — or a label, or the
 * property of an object literal (`save: makeHandler("save"),`).
 */
const NOT_EXPRESSION_START_RE = /^(?:@|(?:return|throw|raise|yield|assert|import|from|package|namespace|class|interface|struct|enum|typedef|template|goto|break|continue|pass)\b|[A-Za-z_$][\w$]*\s*:(?!:))/u;

/**
 * The inline body of a control statement that has none of its own block
 * (`if (done) save(x);`, `else cache.clear();`, Python's `if x: f.write(y)`,
 * `else: self.n += 1`), `""` for a control header that opens a block, and
 * `undefined` for a statement that is not control.
 */
function inlineBodyOf(text: string): string | undefined {
  const t = unlabelled(text);
  const keyword = CONTROL_RE.exec(t);
  if (keyword === null) return undefined;
  // `switch`, `match` and `when` carry no inline body: one that does not open a block is a name (`match.group(1)`, `match = re.search(p, s)`).
  if (/^(?:switch|match|when)$/u.test(keyword[0])) return /[:{]\s*$/u.test(t) ? "" : undefined;
  let rest = t.slice(keyword[0].length).trimStart();
  if (rest.startsWith("(")) {
    const close = closeOf(rest, 0);
    rest = close < 0 ? "" : rest.slice(close + 1).trimStart();
  } else if (!/^(?:else|try|finally|do)$/u.test(keyword[0])) {
    // Python: `for x in xs: out.append(x)`; a header without parentheses and without a colon opens a block (Go).
    let depth = 0;
    let colon = -1;
    for (let index = 0; index < rest.length && colon < 0; index += 1) {
      const ch = rest[index]!;
      if ("([{".includes(ch)) depth += 1;
      else if (")]}".includes(ch)) depth = Math.max(0, depth - 1);
      else if (ch === ":" && depth === 0 && rest[index + 1] !== ":" && rest[index + 1] !== "=" && rest[index - 1] !== ":") colon = index;
    }
    rest = colon < 0 ? "" : rest.slice(colon);
  }
  rest = rest.replace(/^(?::|->|=>)\s*/u, "").trim();
  return rest === "{" ? "" : rest;
}

/** `case 2 -> work();`, `default -> stock.release();`, Kotlin's `A -> repo.save(x)` and `else -> log(x)`: an arm that carries its body. Group 1: the body. */
const ARM_RE = /^(?:case\b[^;{}]*?|default|else|[^=;{}()<>]+?)\s+(?:->|=>)\s+(\S.*)$/u;
/** `go f()` and `defer f.Close()`: Go runs the call for its effect, whatever the call is. */
const GO_DEFER_RE = /^(?:go|defer)\s+[A-Za-z_$(*]/u;
/** JS `delete x.y`, C++ `delete p`; Python's `del x[k]`, `del x.y` (a plain `del x` drops a local). */
const DELETE_RE = /^(?:delete\b\s*(?:\[\s*\]\s*)?[A-Za-z_$(*]|del\s+[^=]*[.[])/u;
/** Go's `ch <- value`. */
const CHANNEL_SEND_RE = /^[A-Za-z_$][\w$.]*\s*<-\s*\S/u;
/** C++'s `out << value << std::endl;`: a stream write. */
const STREAM_WRITE_RE = /^[A-Za-z_$][\w$]*(?:\s*(?:\.|->|::)\s*[A-Za-z_$][\w$]*)*\s*<<\s*\S/u;
/** A bare chain of members (`order.save`, `Rails.logger.flush!`): a call without parentheses, as Ruby writes it. */
const BARE_MEMBER_CHAIN_RE = /^[A-Za-z_$@][\w$]*(?:\s*(?:\.|::)\s*[A-Za-z_$][\w$]*[!?]?)+$/u;

/**
 * True when `statement` (no assignment in it) is an expression statement that
 * calls something: its value is discarded, so it runs for what it does.
 * `foo(…)`, `a.b.c(…)`, `await x.y(…)`, `new Foo(…)`, `super(…)`, `this.emit(…)`,
 * `(void) f();`, `(await x).y()`. A declaration that holds calls in its
 * arguments (`Foo f(compute(x));`) is none: nothing in front of the callee may
 * be anything but a chain of receivers.
 */
function isCallStatement(statement: string): boolean {
  // `void this.save();` throws the value away (JavaScript); `void save(Order o) {` declares a method.
  const t = statement.replace(/^\(\s*void\s*\)\s*/u, "").replace(/^void\s+(?=[A-Za-z_$][\w$]*\s*(?:\?\.|\.|->)|\(|new\b|await\b)/u, "").replace(/^(?:await\s+)+/u, "");
  if (NOT_EXPRESSION_START_RE.test(t)) return false;
  if (BARE_MEMBER_CHAIN_RE.test(t)) return true;
  if (t.startsWith("(")) {
    // `(function () { … })()`, `(await x).y()`; a cast (`(Foo) obj`) is none.
    const close = closeOf(t, 0);
    const rest = close < 0 ? "" : t.slice(close + 1).trimStart();
    return rest.startsWith("(") || (/^(?:\.|->|\?\.|!\.)/u.test(rest) && callsSomething(rest));
  }
  const site = callSitesOf(t)[0];
  if (site === undefined || site.declared) return false;
  const prefix = skeletonOf(t.slice(0, site.index)).replace(/^new\s+/u, "");
  // `Foo f(x);` and `std::vector<int> v(n);` declare a local; `ready && start();` and `a.b ? c() : d();` do not.
  return !/[\w$\]]\s+$/u.test(prefix) && !/[\w$\]>]\s+[A-Za-z_$]/u.test(prefix);
}

/** The effects that need the shape of the statement: what it assigns, deletes or sends, and whether it is a call whose value is discarded. */
function shapeEffectOf(text: string, fields: ReadonlySet<string> | undefined, depth = 0): MemberEffect | undefined {
  const t = text.trim().replace(/;+$/u, "").trim().replace(/^(?:@[\w$.]+(?:\([^)]*\))?\s+)+/u, "");
  if (t === "" || depth > 3 || EXIT_RE.test(t)) return undefined;
  const inline = inlineBodyOf(t);
  if (inline !== undefined) return inline === "" ? undefined : shapeEffectOf(inline, fields, depth + 1);
  const arm = ARM_RE.exec(t);
  if (arm !== null) return shapeEffectOf(arm[1]!, fields, depth + 1);
  if (GO_DEFER_RE.test(t)) return "call";
  if (DELETE_RE.test(t) || CHANNEL_SEND_RE.test(t)) return "state";
  const operators = assignmentOperators(t);
  if (operators.length > 0) {
    const targets: string[] = [];
    let from = 0;
    for (const operator of operators) {
      targets.push(t.slice(from, operator.start));
      from = operator.end;
    }
    // `_ = f()`: the value is thrown away on purpose, which is an expression statement.
    if (targets.every(target => DISCARD_TARGET_RE.test(target.trim()))) return callsSomething(t.slice(from)) ? "call" : undefined;
    return targets.some(target => writesNonLocal(target, fields)) ? "state" : undefined;
  }
  if (STREAM_WRITE_RE.test(t)) return "state";
  return isCallStatement(t) ? "call" : undefined;
}

/**
 * The effect `text` (a statement, comment- and string-masked, whitespace
 * collapsed) has, or `undefined` (see the module doc): an audit call; a
 * persistence call, a repository / dao / store receiver or a call named for a
 * verb that writes; a state write (a setter in any case convention, a field,
 * an element, an increment, a `delete`); or an expression statement that calls
 * something. Lexical, like the rest of the file. `fields` are the type's field
 * names, when the caller knows them: a bare assignment to one is a state write.
 */
export function memberEffectOf(text: string, fields?: ReadonlySet<string>): MemberEffect | undefined {
  if (AUDIT_CALL_RE.test(text)) return "audit";
  if (PERSIST_CALL_RE.test(text) || PERSIST_RECEIVER_RE.test(text)) return "save";
  if (SETTER_CALL_RE.test(text) || FIELD_ASSIGN_RE.test(text)) return "state";
  return verbEffectOf(text) ?? incDecEffectOf(text, fields) ?? shapeEffectOf(text, fields);
}

/** True when `text` (masked, whitespace collapsed) calls a method on one of `collaborators`, bare or through `this` / `self`. */
export function callsCollaborator(text: string, collaborators: ReadonlySet<string>): boolean {
  if (collaborators.size === 0) return false;
  for (const match of text.matchAll(/(?<![\w$.])(?:(?:this|self)\s*(?:\.|->)\s*)?([A-Za-z_$][\w$]*)\s*(?:\.|->)\s*[A-Za-z_$][\w$]*\s*\(/gu)) {
    if (collaborators.has(match[1]!)) return true;
  }
  return false;
}

/**
 * The lines of `statement`: all of them, or — when it is longer than
 * MEMBER_ROW_STATEMENT_MAX_LINES — that many from (just before) its first
 * concern line. A `return` / `throw` that holds no concern line is read by its
 * first MEMBER_ROW_EXIT_MAX_LINES lines, unless `full` (it is also an effect:
 * `return repository.save(order)`).
 */
function statementLines(statement: Statement, firstConcern: number, full = false): MemberRowSpan {
  const limit = statement.kind === "exit" && firstConcern < 0 && !full ? MEMBER_ROW_EXIT_MAX_LINES : MEMBER_ROW_STATEMENT_MAX_LINES;
  if (statement.end - statement.start + 1 <= limit) return { start: statement.start, end: statement.end };
  const start = firstConcern < 0 ? statement.start : Math.max(statement.start, firstConcern - 1);
  return { start, end: Math.min(statement.end, start + limit - 1) };
}

/** A clause that handles the failure of the block before it. */
const FAILURE_CLAUSE_RE = /^(?:catch|except|finally)\b/u;

/** True when `statement` is in the block `head` opens, not in one of the clauses (`catch`, `finally`) that follow it. */
function inTryBlock(statement: Statement, head: Statement): boolean {
  return statement.owners.includes(head) && !statement.owners.some(owner => owner !== head && owner.chain.includes(head));
}

/**
 * The names `statements` declare as locals: `int count = 0;`, `var total`,
 * `Order saved;`, `for (Order o : orders)`, `catch (Exception e)`, and the
 * member's own `parameters`. A bare name that is both a field of the type and
 * one of these is the local.
 */
function declaredLocals(statements: readonly Statement[], parameters: ReadonlySet<string> = new Set()): Set<string> {
  const out = new Set<string>(parameters);
  const nameOf = (declaration: string): string | undefined => {
    const skeleton = skeletonOf(declaration.trim());
    if (!DECLARATION_WORD_RE.test(skeleton) && !/[\w$\]>]\s+[*&]*[A-Za-z_$]/u.test(skeleton)) return undefined;
    return /([A-Za-z_$][\w$]*)\s*(?:\[\])*\s*$/u.exec(skeleton)?.[1];
  };
  for (const statement of statements) {
    if (statement.kind === "label" || statement.kind === "exit") continue;
    const text = unlabelled(statement.text).replace(/;+$/u, "");
    if (statement.kind === "control") {
      const header = /^(?:for|foreach|catch|except|using)\b\s*\(?/u.exec(text);
      if (header === null) continue;
      const inside = text.slice(header[0].length).split(/[:=;)]|\bin\b/u)[0] ?? "";
      const name = nameOf(inside);
      if (name !== undefined) out.add(name);
      continue;
    }
    if (/^(?:throw|break|continue|goto|import|else|case|default|new|await|delete|del)\b/u.test(text)) continue;
    const operators = assignmentOperators(text);
    const name = nameOf(operators.length > 0 ? text.slice(0, operators[0]!.start) : text.split(/\s*[({]/u)[0] ?? "");
    if (name !== undefined) out.add(name);
  }
  return out;
}

export interface ParameterNamesInput {
  /** Every line of the file; line N is `lines[N - 1]`. */
  readonly lines: readonly string[];
  /** The first and the last line of the member's signature, and the member's name. */
  readonly start: number;
  readonly end: number;
  readonly name: string;
}

/** The `(` that opens the parameter list of the signature `text`: the one after `name` (generic parameters between them allowed), else the first one no annotation owns; -1 when there is none. */
function parameterListStart(text: string, name: string): number {
  if (name !== "") {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const named = new RegExp(String.raw`(?<![\w$])${escaped}\s*(?:<[^()]*>)?\s*\(`, "u").exec(text);
    if (named !== null) return named.index + named[0].length - 1;
  }
  for (const match of text.matchAll(/\(/gu)) {
    if (!/@[\w$.]+\s*$/u.test(text.slice(0, match.index))) return match.index;
  }
  return -1;
}

/** The name one parameter declares (`final Order order`, `String... names`, `int[] values = {}`, `order: Order = null`, `_ order: Order`, `const std::string& name`), or `undefined` for a lone type or an unnamed parameter. */
function parameterNameOf(segment: string): string | undefined {
  let text = segment.trim().replace(/^(?:@[\w$.]+(?:\s*\([^()]*\))?\s*)+/u, "");
  const assign = text.search(/=(?![=>])/u);
  if (assign >= 0) text = text.slice(0, assign);
  text = skeletonOf(text.trim());
  // `name: Type` (Kotlin, Scala, Swift): the name stands in front of the first single colon.
  const colon = text.search(/(?<!:):(?!:)/u);
  if (colon >= 0) return /([A-Za-z_$][\w$]*)\s*\??\s*$/u.exec(text.slice(0, colon))?.[1];
  // `Type name` (Java, C#, C, C++): a type and a name at least; a lone word is a type, and a function pointer ends in `()`.
  const words = text.replace(/\.\.\.|\[\]/gu, " ").match(/[A-Za-z_$][\w$]*/gu) ?? [];
  return words.length >= 2 && !/\)\s*$/u.test(text) ? words[words.length - 1] : undefined;
}

/**
 * The names a member's signature declares as parameters, for the languages in
 * which a type's own members name its fields bare (`typeFieldNames`):
 * `(final Order order, int count)`, `(Map<K, V> m, String... names)`,
 * `(order: Order, vararg names: String)`, `(_ order: Order)`, `(const
 * std::string& name)`. A parameter is a local, so `order = normalize(order);`
 * writes the parameter, not the field of the same name (`MemberRowsInput.parameters`).
 * Lexical, over the masked signature; a lone type is no name.
 */
export function parameterNames(input: ParameterNamesInput): Set<string> {
  const out = new Set<string>();
  const text = maskCommentsAndStrings(input.lines.slice(input.start - 1, input.end).join("\n")).replace(/\s+/gu, " ");
  const open = parameterListStart(text, input.name);
  if (open < 0) return out;
  let depth = 0;
  let from = open + 1;
  const take = (to: number): void => {
    const name = parameterNameOf(text.slice(from, to));
    if (name !== undefined) out.add(name);
  };
  for (let index = open + 1; index < text.length; index += 1) {
    const ch = text[index]!;
    if (ch === ">" && (text[index - 1] === "-" || text[index - 1] === "=")) continue;
    if ("([{<".includes(ch)) depth += 1;
    else if (")]}>".includes(ch)) {
      if (depth > 0) depth -= 1;
      else if (ch === ")") { take(index); return out; }
    } else if (ch === "," && depth === 0) {
      take(index);
      from = index + 1;
    }
  }
  return out;
}

/** The paths of the languages in which a type's own members name its fields bare (`status = PAID;`); in the others (`this.`, `self.`) a bare name is never a field. */
const BARE_FIELD_PATH_RE = /\.(?:java|kt|kts|scala|groovy|cs|c|cc|cpp|cxx|h|hh|hpp|hxx|swift|dart)$/iu;
/** A line that opens a scope of the type itself (Kotlin's `companion object {`, a nested type the symbols do not list): the declarations inside it are read as the type's. */
const SCOPE_OPENER_RE = /\b(?:class|interface|enum|struct|union|object|namespace|record|trait)\b/u;
/** A line of a type's body that is no field declaration. */
const NOT_FIELD_RE = /^(?:class|interface|enum|struct|union|namespace|using|import|package|typedef|template|return|case|default|if|for|while|switch|try|catch|else|do|break|continue|goto|throw|static_assert|friend|extern|public\s*:|private\s*:|protected\s*:)\b/u;

export interface TypeFieldsInput {
  /** Every line of the file; line N is `lines[N - 1]`. */
  readonly lines: readonly string[];
  readonly path: string;
  /** The first line after the type's signature and its last line. */
  readonly start: number;
  readonly end: number;
  /** The type's signature, for the properties a Kotlin primary constructor declares (`class Desk(var total: Long)`). */
  readonly signature?: { readonly start: number; readonly end: number };
  /** The type's direct members, constructors and nested types included: the lines between them are the fields. */
  readonly members: ReadonlyArray<{ readonly start: number; readonly end: number }>;
}

/**
 * The names of the fields a type declares between its members, for the
 * languages in which a member names a field bare (Java, Kotlin, C#, C++ …):
 * `private int count;`, `private String status = "NEW";`, `std::map<K, V>
 * cache_;`, `public OrderStatus Status { get; set; }`, `var total: Long = 0`.
 * Lexical and single-line, like the rest of the file: the caller passes the
 * result as `fields` (`MemberRowsInput`). Empty for any other language.
 */
export function typeFieldNames(input: TypeFieldsInput): Set<string> {
  const out = new Set<string>();
  if (!BARE_FIELD_PATH_RE.test(input.path)) return out;
  if (input.signature !== undefined && /\.kts?$/iu.test(input.path)) {
    const head = maskCommentsAndStrings(input.lines.slice(input.signature.start - 1, input.signature.end).join("\n"));
    for (const property of head.matchAll(/\b(?:val|var)\s+([A-Za-z_$][\w$]*)\s*:/gu)) out.add(property[1]!);
  }
  const inMember = new Set<number>();
  for (const member of input.members) for (let line = member.start; line <= member.end; line += 1) inMember.add(line);
  const masked = maskCommentsAndStrings(input.lines.slice(input.start - 1, input.end).join("\n")).split("\n");
  // A line declares a field only where the type's own scope stands: not inside a
  // block that is no scope of the type (a static or instance initializer, an
  // anonymous class or a lambda in an initializer: `static { Map<…> t = …; }`
  // declares no field `t`), and not on the continuation line of an argument list
  // (`Map.of(⏎    A, B)`). One entry per open `{`: true when it hides its lines.
  const blocks: boolean[] = [];
  let parens = 0;
  // …and the brace of the type itself, when its signature ends before it (C#'s and C++'s own-line brace) is the type's.
  let ownOpener = /^\s*\{\s*$/u.test(masked.find(line => line.trim() !== "") ?? "");
  let previous = "";
  masked.forEach((raw, offset) => {
    // The line a brace on its own line belongs to is the one before it (`class Sheet(…)⏎{`).
    const before = previous;
    if (raw.trim() !== "") previous = raw;
    if (inMember.has(input.start + offset)) return;
    const hidden = parens > 0 || blocks.includes(true);
    for (const ch of raw) {
      if (ch === "{") {
        if (ownOpener) ownOpener = false;
        else blocks.push(!(SCOPE_OPENER_RE.test(raw) || (/^\s*\{/u.test(raw) && SCOPE_OPENER_RE.test(before))));
      } else if (ch === "}") blocks.pop();
      else if (ch === "(" || ch === "[") parens += 1;
      else if (ch === ")" || ch === "]") parens = Math.max(0, parens - 1);
    }
    if (hidden) return;
    let text = collapse(raw).replace(/^(?:@[\w$.]+(?:\([^)]*\))?\s*)+/u, "").replace(/\{[^{}]*\}/gu, "");
    // The declaration is what stands before an initializer or a Kotlin / Swift type annotation.
    const cut = text.search(/=|(?<!:):(?!:)/u);
    if (cut >= 0) text = text.slice(0, cut);
    text = text.replace(/[;,]+\s*$/u, "").trim();
    if (text === "" || /[(){}]/u.test(text) || NOT_FIELD_RE.test(text)) return;
    skeletonOf(text).split(",").forEach((declarator, index) => {
      const words = declarator.match(/[A-Za-z_$][\w$]*/gu) ?? [];
      // `int a, b;` declares b with one word; the first declarator is a type and a name.
      if (words.length >= 2 || (index > 0 && words.length === 1)) out.add(words[words.length - 1]!);
    });
  });
  return out;
}

export interface MemberRowsInput {
  /** Every line of the file; line N is `lines[N - 1]`. */
  readonly lines: readonly string[];
  /** First line after the member's signature. */
  readonly bodyStart: number;
  /** The member's last line. */
  readonly bodyEnd: number;
  /** True for a comment- and string-masked line that invokes a requested concern or one of its helpers. */
  readonly isConcernLine: (maskedLine: string) => boolean;
  /**
   * The same test for the text of a statement that spans lines (masked, whitespace
   * collapsed), for a call whose receiver and `.method(` are on different lines
   * (`shippingService⏎    .labelFor(order)`): no single line of it is a concern
   * line, the statement is. Applied to the statements of a body that has a concern
   * line (a body without one is not mapped). Absent: lines only.
   */
  readonly isConcernText?: (collapsedStatement: string) => boolean;
  /** Spans a caller needs served whole (a review note's lines); only the part inside the body counts. */
  readonly anchors?: readonly MemberRowSpan[];
  /**
   * The names of the type's collaborator fields (`paymentService`, `orderRepository`):
   * a call on one of them is a row wherever it stands in a `try` block, in a control
   * header too. A `try` has its handlers read whatever its block calls; this only
   * widens which statements of the block are served beside them. Empty when absent.
   */
  readonly collaborators?: ReadonlySet<string>;
  /**
   * The names of the type's fields (`status`, `total`): a bare assignment,
   * increment or decrement of one is a state write (`status = OrderStatus.PAID;`,
   * `count++;`), as in Java, C#, Kotlin and C++, where a field needs no `this.`.
   * A statement that writes through a receiver, an index or a pointer is a state
   * write without it, and a name the body declares as a local (`int count = 0;`) is
   * that local, not the field. Absent or empty: no bare identifier is read as a field.
   */
  readonly fields?: ReadonlySet<string>;
  /**
   * The names of the member's parameters (`parameterNames`): a parameter is a
   * local, so `order = normalize(order);` writes it and not the field `order`.
   * Read with `fields` only.
   */
  readonly parameters?: ReadonlySet<string>;
}

/** Sorted, with overlapping or touching spans merged. */
function mergeRowSpans(spans: readonly MemberRowSpan[]): MemberRowSpan[] {
  const sorted = [...spans].filter(span => span.end >= span.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const out: MemberRowSpan[] = [];
  for (const span of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && span.start <= last.end + 1) out[out.length - 1] = { start: last.start, end: Math.max(last.end, span.end) };
    else out.push({ ...span });
  }
  return out;
}

/** A line that begins a control statement in the indented layout: the first statement of a Python body (`try:`, `for x in xs:`, `with lock:`, `if ready:`). */
const BODY_OPENING_HEADER_RE = /^\s*(?:if|for|while|try|with|match|async\s+(?:with|for))\b/u;

/**
 * The rows of the body `[bodyStart, bodyEnd]` (see the module doc), merged and
 * in source order: `[]` when the body has no concern line (nothing to map),
 * `undefined` when it cannot be read lexically (the caller keeps the whole
 * member).
 *
 * Python's signature runs through the first statement of the body
 * (`structureMapTypeOf`), so when that statement is a control header (`try:`,
 * `for …:`, `with …:`, `if …:` — 275 of 1,724 members in the corpora) the body
 * begins INSIDE its block: the clauses that follow it (`except`, `finally`,
 * `else`, `elif`) continue no header and are read as statements of their own,
 * a handler whose block calls nothing is lost, and the `continue` of a loop
 * that is the first statement leaves nothing out. Such a body is read once more
 * from its header, and the rows of both readings are kept.
 */
export function memberBodyRows(input: MemberRowsInput): MemberRowSpan[] | undefined {
  const { lines, bodyStart, bodyEnd } = input;
  if (bodyEnd < bodyStart) return undefined;
  const rows = bodyRowsFrom(input, bodyStart);
  if (rows === undefined || rows.length === 0 || bodyStart < 2 || !BODY_OPENING_HEADER_RE.test(lines[bodyStart - 2] ?? "")) return rows;
  const fromHeader = bodyRowsFrom(input, bodyStart - 1);
  return fromHeader === undefined ? rows : mergeRowSpans([...rows, ...fromHeader]);
}

/**
 * The rows of the body read from line `first`: `input.bodyStart`, or the line
 * before it when that line is the header of the body's first statement
 * (`memberBodyRows`). Nothing before `bodyStart` counts as a concern line, and no
 * row starts before it.
 */
function bodyRowsFrom(input: MemberRowsInput, first: number): MemberRowSpan[] | undefined {
  const { lines, bodyStart, bodyEnd } = input;
  const masked = maskCommentsAndStrings(lines.slice(first - 1, bodyEnd).join("\n")).split("\n");
  const skew = bodyStart - first;
  const concernLines = new Set<number>();
  masked.forEach((line, offset) => { if (offset >= skew && input.isConcernLine(line)) concernLines.add(first + offset); });
  if (concernLines.size === 0) return [];
  const body = masked.slice(skew);
  const indented = !body.some(line => /\{\s*$/u.test(line))
    && body.some(line => /^\s*(?:if|elif|else|for|while|try|except|finally|match|case|with|async\s+(?:with|for))\b.*:\s*$/u.test(line));
  // A header is read only where the body is indented: the other layouts have no clause to repair.
  if (skew > 0 && !indented) return [];
  const statements = indented ? scanIndented(masked, first) : scanBraces(masked, first);
  if (statements === undefined) return undefined;
  const spans: MemberRowSpan[] = [];
  const picked = new Set<Statement>();
  const collaborators = input.collaborators ?? new Set<string>();
  // A field the member declares a local or a parameter of the same name for (`int count = 0;`) is that local, not the field, wherever the body names it bare.
  const locals = input.fields !== undefined && input.fields.size > 0 ? declaredLocals(statements, input.parameters) : undefined;
  const fields = locals === undefined ? undefined : new Set([...input.fields!].filter(name => !locals.has(name)));
  // A statement that spans lines and has no concern line of its own may still hold a
  // concern call split over lines: the line where its text first reads as one.
  const textConcern = new Map<Statement, number>();
  const textConcernOf = (statement: Statement): number => {
    const known = textConcern.get(statement);
    if (known !== undefined) return known;
    let found = -1;
    // One reading of the whole statement first: only a statement that is a concern is read line by line for where.
    if (input.isConcernText?.(statement.text) === true && statement.kind !== "label" && statement.end > statement.start) {
      let text = "";
      const last = Math.min(statement.end, statement.start + MEMBER_ROW_TEXT_SCAN_LINES - 1);
      for (let line = statement.start; line <= last && found < 0; line += 1) {
        text = collapse(`${text} ${masked[line - first] ?? ""}`);
        if (input.isConcernText(text)) found = line;
      }
      // The header of the first statement stands in the signature: a concern it holds on its own line is not the body's.
      if (found < bodyStart) found = -1;
    }
    textConcern.set(statement, found);
    return found;
  };
  const firstConcernOf = (statement: Statement): number => {
    for (let line = statement.start; line <= statement.end; line += 1) if (concernLines.has(line)) return line;
    return textConcernOf(statement);
  };
  /** A control statement with no block that ends the iteration or the member (`if (done) break;`, `if (x) return;`, `else continue outer;`). */
  const inlineExit = (statement: Statement): boolean => {
    if (EXIT_INSIDE_RE.test(statement.text)) return true;
    const jump = INLINE_JUMP_RE.exec(statement.text);
    return jump !== null && jumpsOut(jump[1]!, jump[2], statement.owners, statement.text);
  };
  const isExit = (statement: Statement): boolean =>
    statement.kind === "exit" || (statement.kind === "control" && !statement.opens && inlineExit(statement));
  const pick = (statement: Statement, full = false): void => {
    if (picked.has(statement)) return;
    picked.add(statement);
    spans.push(statementLines(statement, firstConcernOf(statement), full));
  };
  const pickWithOwners = (statement: Statement, full = false): void => {
    pick(statement, full);
    for (const owner of statement.owners) pick(owner);
  };
  // The `return` that ends the member's own body skips nothing after it, and so
  // decides nothing: it is a row only when it also invokes a concern or picks a value.
  // …whatever block the first statement opens around it, when it was read from its header.
  const header = skew > 0 ? statements.find(statement => statement.start === first && statement.kind === "control" && statement.opens) : undefined;
  const closing = [...statements].reverse().find(statement => statement !== header
    && (statement.depth === 0 || (header !== undefined && statement.depth === 1 && statement.owners[0] === header)));
  const held = new Set<number>();
  for (const statement of statements) {
    for (let line = statement.start; line <= statement.end; line += 1) held.add(line);
    const concern = firstConcernOf(statement) >= 0;
    const decision = statement.kind !== "label" && (TERNARY_RE.test(statement.text) || (indented && INLINE_IF_RE.test(statement.text)));
    const exit = isExit(statement) && !(statement === closing && statement.kind === "exit" && !concern && !decision);
    // A `case 2 -> work();` arm carries its body, so a label can be an effect too.
    const effect = memberEffectOf(statement.text, fields) !== undefined;
    if (!concern && !exit && !decision && !effect) continue;
    pickWithOwners(statement, effect);
  }
  // The failure handling: every `try` keeps its header, the calls its block makes
  // (the failure the handlers answer) and every `catch` / `except` / `finally`
  // clause with its handler, whatever the block calls.
  const handlersOf = new Map<Statement, Statement[]>();
  for (const statement of statements) {
    if (statement.kind !== "control" || !FAILURE_CLAUSE_RE.test(statement.text) || statement.chain.length === 0) continue;
    const head = statement.chain[0]!;
    handlersOf.set(head, [...(handlersOf.get(head) ?? []), statement]);
  }
  if (handlersOf.size > 0) {
    for (const statement of statements) {
      if (statement.kind === "label" || !statement.owners.some(owner => handlersOf.has(owner) && inTryBlock(statement, owner))) continue;
      // A header that opens a block is a row through what it holds (unless it calls a concern or a collaborator itself); every other statement of the block that calls something is the failure being handled.
      if (firstConcernOf(statement) >= 0 || callsCollaborator(statement.text, collaborators) || (!(statement.kind === "control" && statement.opens) && callsSomething(statement.text))) pickWithOwners(statement);
    }
  }
  for (const [head, handlers] of handlersOf) {
    pickWithOwners(head);
    for (const handler of handlers) {
      picked.add(handler);
      const last = handler.blockEnd ?? handler.end;
      if (last - handler.start + 1 <= MEMBER_ROW_HANDLER_MAX_LINES) spans.push({ start: handler.start, end: last });
      else {
        spans.push({ start: handler.start, end: handler.start + MEMBER_ROW_HANDLER_MAX_LINES - 2 });
        spans.push({ start: last, end: last });
      }
    }
  }
  // A concern line that no statement holds (it cannot happen on a balanced body) still counts.
  for (const line of concernLines) if (!held.has(line)) spans.push({ start: line, end: line });
  for (const anchor of input.anchors ?? []) {
    const start = Math.max(anchor.start, bodyStart);
    const end = Math.min(anchor.end, bodyEnd);
    if (end >= start) spans.push({ start, end });
  }
  // No row starts in the signature, which the caller keeps anyway.
  return mergeRowSpans(spans.map(span => ({ start: Math.max(span.start, bodyStart), end: span.end })));
}
