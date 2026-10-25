/**
 * Process sections in a task query (decision window 6t-7, 2026-10-20,
 * bench/workflows/runs/2026-10-20-v016-decision-6t-7-disclosure.md §6).
 *
 * The guide asks for "the entire user request, verbatim" as the first query,
 * and since harness generation 5 the bench's solvers send it. Two of the three
 * T07 cells and one T05c cell sent the task's "Fix protocol" section after the
 * request (T07 rep 0 its "## After-task report" too). The section's words
 * became request items and concern tokens ("protocol", `tsc --noEmit`, NOT,
 * ROOT), its build-command examples matched unrelated files, and the pack the
 * request alone certifies as `act.edit` came back `await_input` (T07, 11,678 B
 * and 8,198 B) or `discover` (T05c, 29,443 B where the request alone gets the
 * 31,105 B `act.edit`). Window 6t-4's T10 rep 2 pasted a whole prompt — the
 * repository guide, STEP 0, TASK, After-task report — and got `await_input`.
 *
 * A process section says how to work and how to report, never what to change,
 * so the pack builder reads the query without it. Three conditions keep this
 * narrow:
 *  - the section is titled as one: `protocol`, `workflow`, an after-task or
 *    completion report, a report format. "Steps", "Rules", "Requirements",
 *    "Context", "Notes" and "Output format" carry requests (what to list, what
 *    to answer) and never match. Japanese titles are not matched either: none
 *    was observed, and a Japanese imperative (してください) reads the same in a
 *    request as in a procedure;
 *  - only a leading run of its paragraphs is set aside, each of which reads as
 *    instructions to the agent (PROCESS_LINE_SHARE of its lines);
 *  - a paragraph that names code (a file with an extension, a backticked
 *    identifier) is never set aside, and ends the run.
 * A pasted prompt that carries repository guidance AND a "TASK" section is read
 * as its TASK section. Anything else comes back unchanged, as the same string.
 *
 * server.ts applies this after util/queryEscapes.ts, in one projection
 * (packBuilderQuery): the pack builder reads it, a pack's `next` restates it,
 * and TL_EFF_AUTOFOLLOW compares that next with the caller's query projected
 * the same way, so a request sent with its process sections is followed like
 * the request alone (replay corpus v016fq1).
 */

export interface QueryFocus {
  /** The text the pack builder reads: the request without its process sections, or the input itself. */
  readonly query: string;
  /** Titles of the sections set aside, in order; empty exactly when `query` is the input. */
  readonly setAside: readonly string[];
}

/** `## Fix protocol (bug-fix task — …)`. A `#include` has no space after `#` and never matches. */
const ATX_HEADING_RE = /^ {0,3}#{1,6}[ \t]+(\S.*?)[ \t]*#*[ \t]*$/u;
/** `**After-task report**` alone on its line. */
const BOLD_TITLE_RE = /^ {0,3}\*\*([^*\r\n]{1,100})\*\*[:：]?[ \t]*$/u;
/** A thematic break ends a section without opening a titled one. */
const RULE_RE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/u;
const FENCE_RE = /^ {0,3}(?:`{3,}|~{3,})/u;
/**
 * An unmarked title: T07 rep 2 sent "Fix protocol (bug-fix task — work it like
 * real on-call dev work)" with no `##`. Only these nouns, within the line's
 * first four words, on a short line after a blank one that ends no sentence.
 */
const PLAIN_PROCESS_TITLE_RE = /^ {0,3}(?:[A-Za-z][\w-]*[ \t]+){0,3}(?:protocol|workflow|(?:after[- ]task|post[- ]task|completion)[ \t]+report|report(?:ing)?[ \t]+format)\b[^.!?。！？]*$/iu;
const PLAIN_TITLE_MAX_CHARS = 100;

/** Titles that name how to work or how to report. */
const PROCESS_TITLE_RE = /\b(?:protocol|workflow)\b|\b(?:after[- ]task|post[- ]task|completion)\s+report\b|\breport(?:ing)?\s+(?:format|template|instructions?)\b/iu;
/** The request's own section in a pasted prompt. */
const TASK_TITLE_RE = /^(?:(?:the|your)\s+)?(?:task|request|user request)$|^(?:依頼|依頼内容|タスク)$/iu;
/** Repository guidance pasted ahead of the request; it matters only beside a TASK section. */
const GUIDANCE_TITLE_RE = /^(?:repository\s+)?(?:CLAUDE|AGENTS)\.md\b|^TokenLighten MCP\b|\bproject instructions\b|\bsystem prompt\b/iu;

const CODE_EXTENSIONS = "c|cc|cpp|cxx|h|hh|hpp|hxx|cs|go|rs|java|kt|kts|scala|swift|m|mm|py|pyi|rb|php|js|jsx|mjs|cjs|ts|tsx|vue|svelte|css|scss|sass|less|html?|json|jsonc|ya?ml|toml|ini|cfg|conf|xml|sql|sh|bash|zsh|ps1|md|mdx|rst|txt|csv|tsv|xlsx|xls|docx|pdf|pptx|proto|gradle|cmake|mk|lock|env|dart|lua|jl|ex|exs|erl|hs|clj|groovy|tf";
/** A file named with an extension, alone or under directories. */
const FILE_REF_RE = new RegExp(
  String.raw`(?:^|[\s\x60'"(\[<])(?:\.{1,2}/)?(?:[\w.-]+/)*[\w-]+\.(?:${CODE_EXTENSIONS})(?=$|[\s\x60'"),.:;!?\]>])`,
  "iu",
);
const BACKTICK_RE = /`([^`\r\n]{1,160})`/gu;

/** List markers an instruction line opens with. */
const LIST_MARKER_RE = /^\s*(?:[-*+•]|\d{1,2}[.)]|\([a-z0-9]{1,2}\)|[a-z][.)]|[①-⑳])\s+/u;
/**
 * An instruction to the agent anywhere on the line. Not "report", "list" or
 * "include": "also list the affected types in the report" is a request.
 */
const PROCESS_PHRASE_RE = /\b(?:do not|don't|never|always|make sure|fall back|go back|iterat\w*|verif(?:y|ied|ies|ication)|reproduc\w*|root cause|toolchain|regressions?|symptoms?|cycles?|re-?fix|changed_files|git diff|worktree|install\w*|edge cases?|stop|apply|run)\b/iu;
/** An imperative or a condition opening the line. */
const PROCESS_OPENING_RE = /^(?:use|keep|check|confirm|ensure|note|then|first|finally|after|before|when|if|otherwise|e\.g\.)\b/iu;
/** Share of a paragraph's lines that must read as instructions for it to be set aside. */
const PROCESS_LINE_SHARE = 0.6;

interface Section {
  /** The heading line as written; absent for the text before the first heading. */
  readonly heading?: string;
  /** The heading's title; absent for the lead and after a thematic break. */
  readonly title?: string;
  /** True for an unmarked title line (PLAIN_PROCESS_TITLE_RE). */
  readonly plain?: boolean;
  readonly lines: string[];
}

/** A backticked token that names code: not a command line, not a bare tool or English word. */
function isCodeIdentifier(token: string): boolean {
  const text = token.trim();
  if (text === "" || /\s/u.test(text) || /^[a-z][a-z0-9-]*$/u.test(text)) return false;
  return /[a-z][A-Z]/u.test(text)
    || /[A-Za-z0-9]_[A-Za-z0-9]/u.test(text)
    || /(?:\.|::|->|#)[A-Za-z_]/u.test(text)
    || /\(\)$/u.test(text);
}

function namesCode(lines: readonly string[]): boolean {
  return lines.some((line) => FILE_REF_RE.test(line)
    || [...line.matchAll(BACKTICK_RE)].some((match) => isCodeIdentifier(match[1]!)));
}

function isProcessLine(line: string): boolean {
  const text = line.replace(LIST_MARKER_RE, "").trim().replace(/^\(/u, "");
  return PROCESS_OPENING_RE.test(text) || PROCESS_PHRASE_RE.test(text);
}

function isProcessParagraph(lines: readonly string[]): boolean {
  const content = lines.filter((line) => line.trim() !== "");
  if (content.length === 0 || namesCode(content)) return false;
  return content.filter(isProcessLine).length >= PROCESS_LINE_SHARE * content.length;
}

function splitSections(lines: readonly string[]): Section[] {
  const sections: Section[] = [{ lines: [] }];
  let inFence = false;
  lines.forEach((line, index) => {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
    } else if (!inFence) {
      const marked = ATX_HEADING_RE.exec(line) ?? BOLD_TITLE_RE.exec(line);
      if (marked !== null) {
        sections.push({ heading: line, title: marked[1]!.trim(), lines: [] });
        return;
      }
      if (RULE_RE.test(line)) {
        sections.push({ heading: line, lines: [] });
        return;
      }
      if (
        index > 0
        && lines[index - 1]!.trim() === ""
        && (lines[index + 1] ?? "").trim() !== ""
        && line.length <= PLAIN_TITLE_MAX_CHARS
        && PLAIN_PROCESS_TITLE_RE.test(line)
      ) {
        sections.push({ heading: line, title: line.trim(), plain: true, lines: [] });
        return;
      }
    }
    sections[sections.length - 1]!.lines.push(line);
  });
  return sections;
}

/** Blank-line-separated paragraphs; a fenced block stays inside its paragraph. */
function paragraphs(lines: readonly string[]): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (FENCE_RE.test(line)) inFence = !inFence;
    if (!inFence && line.trim() === "") {
      if (current.length > 0) out.push(current);
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) out.push(current);
  return out;
}

export function focusTaskQuery(raw: string): QueryFocus {
  const unchanged: QueryFocus = { query: raw, setAside: [] };
  if (!/[\r\n]/u.test(raw)) return unchanged;
  const sections = splitSections(raw.replace(/<!--[\s\S]*?-->/gu, "").split(/\r?\n/u));
  if (sections.length === 1) return unchanged;

  // A pasted prompt: repository guidance plus a TASK section, which is the request.
  const tasks = sections.filter((section) => section.title !== undefined
    && section.plain !== true
    && TASK_TITLE_RE.test(section.title.replace(/[:：]\s*$/u, ""))
    && section.lines.some((line) => line.trim() !== ""));
  if (tasks.length > 0 && sections.some((section) => section.title !== undefined && GUIDANCE_TITLE_RE.test(section.title))) {
    const query = tasks.map((section) => section.lines.join("\n").trim()).join("\n\n");
    const setAside = sections
      .filter((section) => !tasks.includes(section) && section.title !== undefined)
      .map((section) => section.title!);
    return query === "" || setAside.length === 0 ? unchanged : { query, setAside };
  }

  const kept: string[] = [];
  const setAside: string[] = [];
  for (const section of sections) {
    if (section.title === undefined || !PROCESS_TITLE_RE.test(section.title)) {
      if (section.heading !== undefined) kept.push(section.heading);
      kept.push(...section.lines);
      continue;
    }
    // The leading run of instruction paragraphs is set aside; the first
    // paragraph that is not one, or that names code, stays with everything
    // after it.
    const parts = paragraphs(section.lines);
    let cut = 0;
    while (cut < parts.length && isProcessParagraph(parts[cut]!)) cut += 1;
    if (cut === 0 && parts.length > 0) {
      kept.push(section.heading!, ...section.lines);
      continue;
    }
    setAside.push(section.title);
    for (const part of parts.slice(cut)) kept.push("", ...part);
  }
  if (setAside.length === 0) return unchanged;
  const query = kept.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
  return query === "" ? unchanged : { query, setAside };
}
