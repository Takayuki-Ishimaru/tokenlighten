// DOCX extractor — mammoth wrapper for @tokenlighten/mcp-server.
//
// Ported from proto/src/document/extractors/docx.ts — VSCode imports stripped.
// Output is PLAIN markdown text: no meta envelope, no 'tokenlighten:meta' wrappers.
// Reason: docs/00-postmortem.md §2.2 — meta envelope dominated cache_write cost.
//
// Strategy:
//   1. Try mammoth.convertToMarkdown; fall back to convertToHtml + html→markdown.
//   2. Extract headings (## Headings section) and steps (## Steps section).
//   3. Split at H1/H2/H3 boundaries → sections.
//   4. Return: headings block + steps block + body text, concatenated.

export type DocxExtractResult =
  | { ok: true; text: string; title?: string; warnings: string[] }
  | { ok: false; error: string; warnings: string[] };

// ---------------------------------------------------------------------------
// HTML → Markdown — minimal subset for docx content.
// ---------------------------------------------------------------------------

function stripTags(html: string): string {
  const entities: Record<string, string> = { "&amp;": "&", "&lt;": "&lt;", "&gt;": "&gt;", "&quot;": "\"", "&#39;": "'", "&nbsp;": " " };
  let output = "";
  let inTag = false;
  for (let index = 0; index < html.length;) {
    const entity = !inTag && Object.keys(entities).find((candidate) => html.startsWith(candidate, index));
    if (entity) { output += entities[entity]!; index += entity.length; }
    else if (html[index] === "<") { inTag = true; index++; }
    else if (html[index] === ">" && inTag) { inTag = false; index++; }
    else { if (!inTag) output += html[index]!; index++; }
  }
  return output;
}

/** Test-only export for adversarial fallback-conversion regression coverage. */
export const __testOnlyHtmlToMarkdown = htmlToMarkdown;

function htmlToMarkdown(html: string): string {
  const markdown = html
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_m, t) => `\n# ${stripTags(t)}\n`)
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_m, t) => `\n## ${stripTags(t)}\n`)
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_m, t) => `\n### ${stripTags(t)}\n`)
    .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, (_m, t) => `\n#### ${stripTags(t)}\n`)
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, (_m, t) => `**${stripTags(t)}**`)
    .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, (_m, t) => `_${stripTags(t)}_`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, t) => `- ${stripTags(t).trim()}\n`)
    .replace(/<\/?(ul|ol)[^>]*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/?(p|div)[^>]*>/gi, "")
    .replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_m, t) => {
      const cells = [...t.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) =>
        stripTags(m[1]).trim(),
      );
      return `| ${cells.join(" | ")} |\n`;
    })
    .replace(/<\/?(table|thead|tbody|tfoot)[^>]*>/gi, "\n");
  return stripTags(markdown).replace(/\r\n/g, "\n").trim();
}

// ---------------------------------------------------------------------------
// Heading splitter
// ---------------------------------------------------------------------------

interface Section {
  level: number;
  heading: string;
  body: string;
}

function splitAtHeadings(md: string): Section[] {
  const HEADING_RE = /^(#{1,3})\s+(.+)$/m;
  const lines = md.split("\n");
  const sections: Section[] = [];
  let currentLevel = 0;
  let currentHeading = "";
  let bodyLines: string[] = [];

  function flush() {
    const body = bodyLines.join("\n").trim();
    sections.push({ level: currentLevel, heading: currentHeading, body });
    bodyLines = [];
  }

  for (const line of lines) {
    const m = HEADING_RE.exec(line);
    if (m) {
      if (currentHeading || bodyLines.some((l) => l.trim())) {
        flush();
      } else {
        bodyLines = [];
      }
      currentLevel = m[1]!.length;
      currentHeading = m[2]!.trim();
    } else {
      bodyLines.push(line);
    }
  }

  if (currentHeading || bodyLines.some((l) => l.trim())) {
    flush();
  }

  return sections;
}

// ---------------------------------------------------------------------------
// Headings extractor
// ---------------------------------------------------------------------------

interface HeadingEntry {
  level: number;
  text: string;
}

/**
 * Extract heading entries from markdown text.
 * Detects lines matching ^#{1,6} text.
 */
function extractHeadings(md: string): HeadingEntry[] {
  const headings: HeadingEntry[] = [];
  for (const line of md.split("\n")) {
    const m = /^(#{1,6})\s+(.+)$/.exec(line.trim());
    if (m) {
      headings.push({ level: m[1]!.length, text: m[2]!.trim() });
    }
  }
  return headings;
}

/**
 * Render a ## Headings section from heading entries.
 * Format: "- [level] text" (e.g., "- H1: Introduction")
 */
function renderHeadingsSection(headings: HeadingEntry[]): string {
  if (headings.length === 0) return "";
  const lines = headings.map((h) => `- H${h.level}: ${h.text}`);
  return `## Headings\n\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Steps extractor
// ---------------------------------------------------------------------------

/**
 * Extract numbered/bullet steps from markdown text.
 * Detects lines matching:
 *   - "1. ..." or "1\. ..." (numbered list items; mammoth may escape the dot)
 *   - "- ..." or "* ..." (bullet items — only when short enough to be a step)
 *   - "Step N: ..." or "Step N." patterns
 *   - Lines starting with "Procedure:" followed by content
 */
function extractSteps(md: string): string[] {
  const steps: string[] = [];
  // Match "1. " or "1\. " (mammoth convertToMarkdown escapes the dot as "\.")
  const NUMBERED_RE = /^\s*(\d+)\\?\.\s+(.+)$/;
  const BULLET_RE = /^\s*[-*]\s+(.+)$/;
  const STEP_KEYWORD_RE = /^\s*(?:Step\s+\d+[:.]\s*|Procedure:\s*)(.+)$/i;

  for (const line of md.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const numM = NUMBERED_RE.exec(trimmed);
    if (numM) {
      // Unescape any backslash-escaped punctuation from mammoth's markdown output
      const text = numM[2]!.trim().replace(/\\(.)/g, "$1");
      steps.push(`${numM[1]}. ${text}`);
      continue;
    }

    const stepM = STEP_KEYWORD_RE.exec(trimmed);
    if (stepM) {
      steps.push(stepM[1]!.trim().replace(/\\(.)/g, "$1"));
      continue;
    }

    // Bullet items that look like steps (not too long — prose sentences aren't steps)
    const bulletM = BULLET_RE.exec(trimmed);
    if (bulletM && bulletM[1]!.length <= 200) {
      steps.push(`- ${bulletM[1]!.trim().replace(/\\(.)/g, "$1")}`);
      continue;
    }
  }

  return steps;
}

/**
 * Render a ## Steps section from collected steps.
 */
function renderStepsSection(steps: string[]): string {
  if (steps.length === 0) return "";
  return `## Steps\n\n${steps.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Public extractor
// ---------------------------------------------------------------------------

type MammothModule = {
  convertToMarkdown?: (input: { buffer: Buffer }) => Promise<{
    value: string;
    messages: Array<{ type: string; message: string }>;
  }>;
  convertToHtml: (input: { buffer: Buffer }) => Promise<{
    value: string;
    messages: Array<{ type: string; message: string }>;
  }>;
};

let mammothCache: MammothModule | undefined;

async function getMammoth(): Promise<MammothModule> {
  if (mammothCache) return mammothCache;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  mammothCache = (await import("mammoth")).default as unknown as MammothModule;
  return mammothCache;
}

/**
 * Extract text from a .docx file as markdown.
 * Prepends a ## Headings section (document heading outline) and
 * a ## Steps section (numbered/bullet steps) before the body text.
 * Lazy-loads mammoth on first call.
 */
export async function extractDocx(bytes: Uint8Array): Promise<DocxExtractResult> {
  const mammoth = await getMammoth();
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let md: string;
  const rawWarnings: Array<{ type: string; message: string }> = [];

  try {
    if (typeof mammoth.convertToMarkdown === "function") {
      const result = await mammoth.convertToMarkdown({ buffer: buf });
      md = result.value;
      rawWarnings.push(...result.messages);
    } else {
      const result = await mammoth.convertToHtml({ buffer: buf });
      md = htmlToMarkdown(result.value);
      rawWarnings.push(...result.messages);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg.slice(0, 200), warnings: [] };
  }

  const warnings = rawWarnings.slice(0, 10).map((m) => m.message);

  // Extract structured sections
  const headings = extractHeadings(md);
  const steps = extractSteps(md);
  const headingsSection = renderHeadingsSection(headings);
  const stepsSection = renderStepsSection(steps);

  // Build body from heading-split sections
  const sections = splitAtHeadings(md);
  let title: string | undefined;
  const bodyParts: string[] = [];

  if (sections.length === 0 || (sections.length === 1 && !sections[0]!.heading)) {
    bodyParts.push(sections[0]?.body ?? md.trim());
  } else {
    for (const [idx, sec] of sections.entries()) {
      if (idx === 0 && sec.level === 1) title = sec.heading;
      const prefix = sec.heading ? "#".repeat(sec.level) + " " + sec.heading : "";
      if (prefix) bodyParts.push(prefix);
      if (sec.body.trim()) bodyParts.push(sec.body.trim());
    }
    if (!title && sections[0]?.heading) title = sections[0].heading;
  }

  // Assemble: structured sections first, then body
  const outputParts: string[] = [];
  if (headingsSection) outputParts.push(headingsSection);
  if (stepsSection) outputParts.push(stepsSection);
  if (bodyParts.length > 0) outputParts.push(bodyParts.join("\n\n"));

  const text = outputParts.join("\n\n");

  return { ok: true, text, title, warnings };
}

// ---------------------------------------------------------------------------
// Artifact-mode DOCX section extraction (v0.7)
// ---------------------------------------------------------------------------

export interface DocxSection {
  heading: string;
  text: string;
}

export interface DocxSectionResult {
  ok: true;
  sections: DocxSection[];
  truncated: boolean;
  warnings: string[];
}

/**
 * Extract sections from a .docx file, optionally filtered by heading names
 * or a text query. Uses the cached mammoth instance.
 */
export async function docxSections(
  bytes: Uint8Array,
  opts: {
    sections?: string[];
    query?: string;
    maxChars?: number;
  } = {},
): Promise<DocxSectionResult | { ok: false; error: string; warnings: string[] }> {
  const maxChars = opts.maxChars ?? 16_000;

  let mammoth: MammothModule;
  try {
    mammoth = await getMammoth();
  } catch {
    return { ok: false, error: "mammoth package not available for DOCX extraction.", warnings: [] };
  }

  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let rawText: string;
  try {
    if (typeof mammoth.convertToMarkdown === "function") {
      const result = await mammoth.convertToMarkdown({ buffer: buf });
      rawText = result.value;
    } else {
      const result = await mammoth.convertToHtml({ buffer: buf });
      rawText = htmlToMarkdown(result.value);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg.slice(0, 200), warnings: [] };
  }

  const warnings: string[] = [];

  // Split into sections by headings
  const lines = rawText.split(/\r?\n/);
  const allSections: DocxSection[] = [];
  let currentHeading = "(Preamble)";
  let currentText: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") {
      currentText.push("");
      continue;
    }
    // Detect heading-like lines: markdown headings or short title-cased/all-caps lines
    if (
      trimmed.length < 120 &&
      trimmed.length > 2 &&
      (
        /^#{1,6}\s/.test(trimmed) ||
        /^[A-Z][A-Z\s:–—-]{2,}$/.test(trimmed) ||
        /^\d+\.?\s+[A-Z]/.test(trimmed)
      )
    ) {
      // Save previous section
      if (currentText.some((t) => t.trim() !== "")) {
        allSections.push({ heading: currentHeading, text: currentText.join("\n").trim() });
      }
      currentHeading = trimmed.replace(/^#+\s*/, "");
      currentText = [];
    } else {
      currentText.push(trimmed);
    }
  }
  // Save last section
  if (currentText.some((t) => t.trim() !== "")) {
    allSections.push({ heading: currentHeading, text: currentText.join("\n").trim() });
  }

  // Filter sections
  let filtered = allSections;

  if (opts.sections && opts.sections.length > 0) {
    const sectionNames = opts.sections.map((s) => s.toLowerCase());
    filtered = allSections.filter((s) =>
      sectionNames.some((name) => s.heading.toLowerCase().includes(name))
    );
  }

  if (opts.query) {
    const queryLower = opts.query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter((t) => t.length > 2);
    filtered = filtered.filter((s) => {
      const combined = (s.heading + " " + s.text).toLowerCase();
      return queryTerms.some((term) => combined.includes(term));
    });
  }

  // Apply maxChars truncation
  let totalChars = 0;
  let truncated = false;
  const result: DocxSection[] = [];
  for (const section of filtered) {
    if (totalChars + section.text.length > maxChars) {
      const remaining = maxChars - totalChars;
      if (remaining > 100) {
        result.push({ heading: section.heading, text: section.text.slice(0, remaining) + "..." });
      }
      truncated = true;
      break;
    }
    result.push(section);
    totalChars += section.text.length;
  }

  return { ok: true, sections: result, truncated, warnings };
}
