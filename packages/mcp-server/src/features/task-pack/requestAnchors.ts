// The anchors a request names explicitly (2026-10-29 first-hop field report):
// dotted members such as `res.redirect`, quoted or bracketed literals such as
// `[default: (unlimited)]`, and code-shaped identifiers. The first hop
// searches these before anything else. Contract: __tests__/requestAnchors.spec.ts.
export interface RequestAnchorChain {
  /** The chain as written, e.g. `res.redirect`, `Foo.prototype.bar`. */
  raw: string;
  /** Everything before the last dot, e.g. `res`, `Foo.prototype`. */
  owner: string;
  /** The last segment, e.g. `redirect`, `bar`. */
  member: string;
}

export interface RequestAnchors {
  chains: RequestAnchorChain[];
  literals: string[];
  identifiers: string[];
}

const FILE_EXT = new Set([
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java",
  "kt", "c", "h", "cc", "cpp", "hpp", "cs", "php", "md", "txt", "json",
  "yml", "yaml", "toml", "cfg", "ini", "xml", "html", "css", "lock",
  "sh", "ps1",
]);

const TLD = new Set([
  "com", "org", "net", "io", "dev", "app", "co", "jp", "uk", "de",
  "test", "local",
]);

const ABBREVIATIONS = new Set(["e.g", "i.e", "etc"]);

const IDENT_SHAPE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const CHAIN_SHAPE = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/;

const isIdentChar = (ch: string): boolean => /[A-Za-z0-9_$]/.test(ch);

function isAcceptableChain(raw: string, query: string, start: number): boolean {
  if (ABBREVIATIONS.has(raw.toLowerCase())) return false;
  const before = start > 0 ? query[start - 1] : "";
  const end = start + raw.length;
  const after = end < query.length ? query[end] : "";
  if (before === "/" || before === "\\" || after === "/" || after === "\\") return false;
  if (before === ":" && query.slice(Math.max(0, start - 8), start).toLowerCase().endsWith("http:")) return false;
  if (before === ":" && query.slice(Math.max(0, start - 9), start).toLowerCase().endsWith("https:")) return false;
  const segments = raw.split(".");
  const last = (segments[segments.length - 1] ?? "").toLowerCase();
  if (FILE_EXT.has(last) || TLD.has(last)) return false;
  if (raw.toLowerCase().startsWith("www.")) return false;
  return true;
}

/** Ranges [start, end) of spans already reported or otherwise claimed. */
interface Range {
  start: number;
  end: number;
}

/**
 * Every leftmost match of a dotted chain (`a.b`, `Foo.prototype.bar`) in
 * `query`, in order. Within one run of identifier characters only the run's
 * first letter can start a chain (from any later start the same run ends at the
 * same place), so each run is tried once: a global search would retry every
 * start of a long dot-less run (`a1a1…`).
 */
function chainMatches(query: string): Array<{ raw: string; start: number }> {
  const runRe = /[A-Za-z0-9_$]+/g;
  const chainAt = /[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+/y;
  const out: Array<{ raw: string; start: number }> = [];
  let run: RegExpExecArray | null;
  while ((run = runRe.exec(query)) !== null) {
    const offset = run[0].search(/[A-Za-z_$]/);
    if (offset < 0) continue;
    chainAt.lastIndex = run.index + offset;
    const chain = chainAt.exec(query);
    if (chain === null) continue;
    runRe.lastIndex = chainAt.lastIndex;
    out.push({ raw: chain[0], start: chain.index });
  }
  return out;
}

export function extractRequestAnchors(query: string): RequestAnchors {
  const chains: RequestAnchorChain[] = [];
  const literals: string[] = [];
  const identifiers: string[] = [];

  if (query.trim() === "") return { chains, literals, identifiers };

  // Pass 1: quoted/bracketed spans, left to right. Inner spans of a claimed
  // span are skipped, so a bracketed span inside backticks is reported once.
  // Spans are claimed in order and never overlap, so the end of the last one is
  // all a later position needs to be checked against.
  let claimedEnd = 0;
  const literalRanges: Range[] = [];
  const backtickNames: Array<{ start: number; name: string }> = [];
  const seenLiterals = new Set<string>();
  const claim = (start: number, end: number, content: string, withDelimiters: boolean): void => {
    claimedEnd = end;
    literalRanges.push({ start, end });
    const trimmed = (withDelimiters ? query.slice(start, end) : content).trim();
    if (trimmed.length >= 1 && trimmed.length <= 120 && !seenLiterals.has(trimmed)) {
      seenLiterals.add(trimmed);
      literals.push(trimmed);
    }
  };
  const skipSpan = (_start: number, end: number): void => {
    claimedEnd = end;
  };

  for (let i = 0; i < query.length; i++) {
    if (i < claimedEnd) continue;
    const ch = query[i];

    if (ch === "`") {
      const close = query.indexOf("`", i + 1);
      if (close > i) {
        const inner = query.slice(i + 1, close);
        if (IDENT_SHAPE.test(inner)) backtickNames.push({ start: i, name: inner });
        if (IDENT_SHAPE.test(inner) || CHAIN_SHAPE.test(inner)) skipSpan(i, close + 1);
        else claim(i, close + 1, inner, false);
        i = close;
        continue;
      }
      continue;
    }

    if (ch === '"' || ch === "「" || ch === "『") {
      const closeCh = ch === '"' ? '"' : ch === "「" ? "」" : "』";
      const close = query.indexOf(closeCh, i + 1);
      if (close > i) {
        claim(i, close + 1, query.slice(i + 1, close), false);
        i = close;
      }
      continue;
    }

    if (ch === "'") {
      const prev = i > 0 ? (query[i - 1] as string) : "";
      if (prev !== "" && /[A-Za-z0-9]/.test(prev)) continue; // apostrophe
      const close = query.indexOf("'", i + 1);
      if (close > i) {
        const after = close + 1 < query.length ? (query[close + 1] as string) : "";
        if (after !== "" && /[A-Za-z0-9]/.test(after)) continue; // apostrophe, not a quote
        claim(i, close + 1, query.slice(i + 1, close), false);
        i = close;
      }
      continue;
    }

    if (ch === "[") {
      const close = query.indexOf("]", i + 1);
      if (close > i && close - i - 1 >= 3 && close - i - 1 <= 80) {
        const after = close + 1 < query.length ? (query[close + 1] as string) : "";
        if (after !== "(") {
          const inner = query.slice(i + 1, close);
          if (/[:=<>()|/]/.test(inner)) {
            claim(i, close + 1, inner, true);
            i = close;
          }
        }
      }
      continue;
    }
  }

  // Pass 2: chains, skipping any dotted run that lives inside a literal span.
  // Both come in position order, so one cursor walks the literal spans.
  const seenChains = new Set<string>();
  const chainStarts: number[] = [];
  let literalAt = 0;
  for (const { raw, start } of chainMatches(query)) {
    while (literalAt < literalRanges.length && literalRanges[literalAt]!.end <= start) literalAt++;
    if (literalAt < literalRanges.length && literalRanges[literalAt]!.start <= start) continue;
    if (!isAcceptableChain(raw, query, start)) continue;
    if (seenChains.has(raw)) continue;
    seenChains.add(raw);
    const dot = raw.lastIndexOf(".");
    chains.push({ raw, owner: raw.slice(0, dot), member: raw.slice(dot + 1) });
    chainStarts.push(start);
  }

  // Pass 3: identifiers — chain raws, code-shaped single names and backticked
  // names, in order of first appearance.
  const seenIdentifiers = new Set<string>();
  const pushIdentifier = (name: string): void => {
    if (seenIdentifiers.has(name)) return;
    seenIdentifiers.add(name);
    identifiers.push(name);
  };

  type Candidate = { start: number; name: string };
  const candidates: Candidate[] = [];
  chains.forEach((chain, index) => candidates.push({ start: chainStarts[index]!, name: chain.raw }));
  const singleRe = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  let m: RegExpExecArray | null;
  while ((m = singleRe.exec(query)) !== null) {
    const name = m[0];
    const start = m.index;
    const before = start > 0 ? (query[start - 1] as string) : "";
    const after = start + name.length < query.length ? (query[start + name.length] as string) : "";
    if (before !== "" && isIdentChar(before)) continue;
    const afterNext = query[start + name.length + 1] ?? "";
    // A `.` continues a chain only when an identifier follows it; a sentence
    // period does not (`… rendered by show_default.`).
    if (after === "." && afterNext !== "" && /[A-Za-z_$]/.test(afterNext)) continue;
    if (after === "/" || after === "\\" || (after !== "" && isIdentChar(after))) continue;
    if (name.startsWith("$")) candidates.push({ start, name });
    else if (/[a-z]/.test(name[0] as string) && /[A-Z]/.test(name)) candidates.push({ start, name });
    else if (/[A-Za-z0-9]_+[A-Za-z0-9]|^_+[A-Za-z0-9]/.test(name)) candidates.push({ start, name });
  }
  for (const bt of backtickNames) candidates.push(bt);
  candidates.sort((a, b) => a.start - b.start);
  for (const c of candidates) pushIdentifier(c.name);

  return { chains, literals, identifiers };
}
