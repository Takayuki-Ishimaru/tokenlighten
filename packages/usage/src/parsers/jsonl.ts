/**
 * parsers/jsonl.ts — tiny, dependency-free JSONL line splitter shared by
 * claudeCode.ts and codex.ts.
 *
 * A deliberate small duplication of aiLogs.ts's private `jsonLines()`
 * helper rather than a reach into that module's internals: parsers/ stays
 * pure, self-contained, and independently testable, with no import
 * relationship to aiLogs.ts. The two are siblings producing DIFFERENT
 * shapes for different consumers (aiLogs.ts's coarse per-model totals feed
 * index.ts's existing summarizeUsage(); this directory's richer per-turn,
 * per-category shape feeds sessionMatcher.ts / coefficientStore.ts), not a
 * layering of one on the other.
 */
export function splitJsonLines(text: string): unknown[] {
  const values: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      values.push(JSON.parse(line) as unknown);
    } catch {
      // A partial final line is expected when a client is still writing.
    }
  }
  return values;
}
