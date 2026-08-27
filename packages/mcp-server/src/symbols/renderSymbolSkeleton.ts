import type { CollectedSymbol } from "./collectSymbols.js";

function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

function rtrim(s: string): string {
  return s.trimEnd();
}

function indentText(text: string, n: number): string {
  const pad = " ".repeat(n);
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? pad + line : line))
    .join("\n");
}

type RenderStyle = "brace" | "colon" | "endkw";

function styleForLanguage(language: string | undefined): RenderStyle {
  const normalized = language?.toLowerCase();
  if (normalized === "python") return "colon";
  if (normalized === "ruby") return "endkw";
  return "brace";
}

function sourceLines(lines: string[], startLine: number, endLine: number): string[] {
  return lines.slice(startLine - 1, endLine).map(rtrim);
}

function signatureLines(text: string, lines: string[], symbol: CollectedSymbol): string[] {
  if (
    Number.isFinite(symbol.signatureStartIndex) &&
    Number.isFinite(symbol.signatureEndIndex) &&
    symbol.signatureEndIndex > symbol.signatureStartIndex
  ) {
    return text
      .slice(symbol.signatureStartIndex, symbol.signatureEndIndex)
      .split(/\r\n|\r|\n/)
      .map(rtrim)
      .filter((line, index, all) => line.length > 0 || (index > 0 && index < all.length - 1));
  }
  return sourceLines(lines, symbol.signatureStartLine, symbol.signatureEndLine);
}

function colonHeaderLines(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    out.push(line);
    if (line.trimEnd().endsWith(":")) break;
  }
  return out.length ? out : lines.slice(0, 1);
}

function endKeywordHeaderLines(lines: string[]): string[] {
  return lines.slice(0, 1);
}

function withColonPlaceholder(sigLines: string[]): string {
  if (sigLines.length === 0) return "...";
  const lastIdx = sigLines.length - 1;
  const last = sigLines[lastIdx]!.trimEnd();
  sigLines[lastIdx] = last.endsWith(":") ? `${last} ...` : `${last}: ...`;
  return sigLines.join("\n");
}

function renderBodySignature(text: string, lines: string[], symbol: CollectedSymbol, style: RenderStyle): string {
  const sigLines = signatureLines(text, lines, symbol);
  if (sigLines.length === 0) return symbol.name;

  if (style === "colon") return withColonPlaceholder(colonHeaderLines(sigLines));
  if (style === "endkw") return `${endKeywordHeaderLines(sigLines).join("\n")}\n  # ...\nend`;

  const lastIdx = sigLines.length - 1;
  const last = sigLines[lastIdx]!;
  const brace = last.indexOf("{");
  if (brace >= 0) {
    sigLines[lastIdx] = `${last.slice(0, brace)}{ ... }`;
    return sigLines.join("\n");
  }

  sigLines[lastIdx] = `${last} { ... }`;
  return sigLines.join("\n");
}

function renderClassHeader(text: string, lines: string[], symbol: CollectedSymbol, style: RenderStyle): string {
  const sigLines = signatureLines(text, lines, symbol);
  if (sigLines.length === 0) {
    if (style === "colon") return `class ${symbol.name}:`;
    if (style === "endkw") return `class ${symbol.name}`;
    return `class ${symbol.name} {`;
  }

  if (style === "colon") {
    const headerLines = colonHeaderLines(sigLines);
    const lastIdx = headerLines.length - 1;
    const last = headerLines[lastIdx]!.trimEnd();
    headerLines[lastIdx] = last.endsWith(":") ? last : `${last}:`;
    return headerLines.join("\n");
  }
  if (style === "endkw") return endKeywordHeaderLines(sigLines).join("\n");

  const lastIdx = sigLines.length - 1;
  const last = sigLines[lastIdx]!;
  const brace = last.indexOf("{");
  if (brace >= 0) {
    sigLines[lastIdx] = `${last.slice(0, brace)}{`;
    return sigLines.join("\n");
  }

  sigLines[lastIdx] = `${last} {`;
  return sigLines.join("\n");
}

/**
 * DESIGN-v0.8 B4.1: uses signatureStartLine, NOT startLine. Since B4.1
 * widened startLine to include a symbol's own leading doc comment (so a
 * handle minted from the overall range never splits the doc block out),
 * `lines[startLine - 1]` for a documented const/type/interface/enum would
 * now be the DOC COMMENT line, not the actual declaration — signatureStartLine
 * is the one field makeSymbol (collectSymbols.ts) deliberately left pointed
 * at the true declaration line for exactly this "bare signature, not the
 * doc block" rendering need.
 */
function firstSourceLine(lines: string[], symbol: CollectedSymbol): string {
  return rtrim(lines[symbol.signatureStartLine - 1] ?? symbol.name).trim();
}

function renderContainerLike(lines: string[], symbol: CollectedSymbol, style: RenderStyle): string {
  const first = firstSourceLine(lines, symbol);
  if (style === "colon") return first.endsWith(":") ? `${first} ...` : `${first}: ...`;
  if (style === "endkw") return `${first}\n  # ...\nend`;
  const brace = first.indexOf("{");
  if (brace >= 0) return `${first.slice(0, brace)}{ ... }`;
  return `${first} { ... }`;
}

function renderVariable(lines: string[], symbol: CollectedSymbol): string {
  const first = firstSourceLine(lines, symbol);
  // DESIGN-v0.8 B4.1: compares against signatureStartLine (the bare
  // declaration's own start), not startLine (which may now be earlier —
  // widened to include a leading doc comment) — this check means "is the
  // BARE declaration itself single-line," a question startLine can no
  // longer answer correctly on its own once it may point at a doc comment.
  if (symbol.endLine <= symbol.signatureStartLine) return first;
  if (first.includes("[")) return `${first} ... ];`;
  const brace = first.indexOf("{");
  if (brace >= 0) return `${first.slice(0, brace)}{ ... };`;
  if (/=\s*$/.test(first)) return `${first} ...;`;
  return `${first} ...;`;
}

function renderTypeAlias(lines: string[], symbol: CollectedSymbol): string {
  const first = firstSourceLine(lines, symbol);
  if (symbol.endLine <= symbol.signatureStartLine) return first;
  if (/=\s*$/.test(first)) return `${first} ...;`;
  return `${first} ...;`;
}

function renderStandalone(text: string, lines: string[], symbol: CollectedSymbol, style: RenderStyle): string {
  switch (symbol.kind) {
    case "function":
    case "method":
      return renderBodySignature(text, lines, symbol, style);
    case "class":
      if (style === "colon") return `${renderClassHeader(text, lines, symbol, style)}\n  ...`;
      if (style === "endkw") return `${renderClassHeader(text, lines, symbol, style)}\n  # ...\nend`;
      return `${renderClassHeader(text, lines, symbol, style)}\n  ...\n}`;
    case "interface":
    case "enum":
      return renderContainerLike(lines, symbol, style);
    case "type":
      return renderTypeAlias(lines, symbol);
    case "const":
    case "let":
    case "var":
      return renderVariable(lines, symbol);
  }
}

function docLines(symbol: CollectedSymbol): string[] {
  return symbol.docComment?.lines ?? [];
}

/**
 * D2 part 1 — per-declaration line-range annotation appended to a rendered
 * declaration's LAST line, e.g. `assign(id: string, ...): IssueDto { ... }
 * // L359-410`. Uses `signatureStartLine` (the bare declaration line, doc
 * comment excluded — doc lines are already rendered separately above the
 * code by docLines()/renderDocEntry()) through `endLine` (the symbol's true
 * closing line from collectSymbols' tree-sitter bounds), so the range names
 * exactly the code span an agent would need for `range=<n>-<m>` or that
 * `symbol=<name>` resolves to. Kept out of the individual render* helpers
 * (which are internal-only — no other module imports them) so it applies
 * uniformly to every declaration kind in one place, and is trivially
 * skippable for the doc-map renderer (renderSymbolDocMap does not call
 * this).
 */
function withRangeSuffix(rendered: string, symbol: CollectedSymbol): string {
  const linesOut = rendered.split("\n");
  const lastIdx = linesOut.length - 1;
  linesOut[lastIdx] = `${linesOut[lastIdx]} // L${symbol.signatureStartLine}-${symbol.endLine}`;
  return linesOut.join("\n");
}

function renderDocEntry(text: string, lines: string[], symbol: CollectedSymbol, style: RenderStyle): string | null {
  const docs = docLines(symbol);
  if (docs.length === 0) return null;
  return [
    ...docs,
    renderStandalone(text, lines, symbol, style),
  ].join("\n");
}

export function renderSymbolSkeleton(text: string, symbols: CollectedSymbol[], language?: string): string {
  const lines = splitLines(text);
  const style = styleForLanguage(language);
  const methodsByClass = new Map<string, CollectedSymbol[]>();
  for (const symbol of symbols) {
    if (symbol.kind !== "method" || !symbol.enclosingSymbol) continue;
    const key = `${symbol.enclosingSymbol.name}:${symbol.enclosingSymbol.startLine}`;
    const existing = methodsByClass.get(key) ?? [];
    existing.push(symbol);
    methodsByClass.set(key, existing);
  }

  const blocks: string[] = [];
  for (const symbol of symbols) {
    if (symbol.kind === "method" && symbol.enclosingSymbol) continue;

    if (symbol.kind === "class") {
      const key = `${symbol.name}:${symbol.startLine}`;
      const methods = (methodsByClass.get(key) ?? []).sort((a, b) => a.startLine - b.startLine);
      const classLines = [
        ...docLines(symbol),
        withRangeSuffix(renderClassHeader(text, lines, symbol, style), symbol),
      ];
      if (methods.length === 0) {
        classLines.push(style === "endkw" ? "  # ..." : "  ...");
      } else {
        for (const method of methods) {
          const methodDocs = docLines(method);
          if (methodDocs.length > 0) classLines.push(indentText(methodDocs.join("\n"), 2));
          classLines.push(indentText(withRangeSuffix(renderBodySignature(text, lines, method, style), method), 2));
        }
      }
      if (style === "brace") classLines.push("}");
      if (style === "endkw") classLines.push("end");
      blocks.push(classLines.join("\n"));
      continue;
    }

    blocks.push([
      ...docLines(symbol),
      withRangeSuffix(renderStandalone(text, lines, symbol, style), symbol),
    ].join("\n"));
  }

  return blocks.join("\n\n");
}

export function renderSymbolDocMap(text: string, symbols: CollectedSymbol[], language?: string): string {
  const lines = splitLines(text);
  const style = styleForLanguage(language);
  const blocks: string[] = [];
  for (const symbol of symbols) {
    const entry = renderDocEntry(text, lines, symbol, style);
    if (entry) blocks.push(entry);
  }
  return blocks.join("\n\n") || "(no documented symbols found)";
}
