/**
 * boundedTextMemo.ts — remembers what a pure function derived from a text.
 *
 * One pack asks "does this served file contain a variant of this word?" once per
 * surface, term and variant, and each question used to split the whole text into
 * words again: on 2026-11-01 about a fifth of a pack's CPU went there, with most
 * of those splits repeating one a moment earlier.
 *
 * The derivation must be pure and its result must not be changed by a caller, so
 * a hit can only ever return what a fresh call would. Short texts are derived
 * every time, because they are cheap and would only churn the memo. Long ones are
 * kept up to the two limits and the oldest go first.
 */
const MIN_TEXT_CHARS = 256;
const MAX_ENTRIES = 64;
const MAX_TOTAL_CHARS = 8 * 1024 * 1024;

export function boundedTextMemo<T>(derive: (text: string) => T): (text: string) => T {
  const held = new Map<string, T>();
  let totalChars = 0;
  return (text) => {
    if (text.length < MIN_TEXT_CHARS || text.length > MAX_TOTAL_CHARS) return derive(text);
    const hit = held.get(text);
    if (hit !== undefined) return hit;
    const value = derive(text);
    held.set(text, value);
    totalChars += text.length;
    for (const oldest of held.keys()) {
      if (held.size <= MAX_ENTRIES && totalChars <= MAX_TOTAL_CHARS) break;
      held.delete(oldest);
      totalChars -= oldest.length;
    }
    return value;
  };
}
