// Labeled example records are input values for one computation, not code
// subjects. Preserve offsets and leave subsequent requests/constraints intact.
const INTRO = /\b(?:calculate|compute|evaluate)\b[^.!?\n]*\b(?:results?|outputs?|values?)\b[^.!?\n]*\b(?:for|with|given|using)\b[^.!?\n]*\b(?:cases?|inputs?|examples?|records?|carts?|attempts?)\b[^.!?\n]*[.:：]/giu;
const CALL = /[A-Za-z_$][A-Za-z0-9_.$]*\s*\(/u;
const LABEL = /(?:^|[.!?;\n]\s*)[A-Z](?:\d+)?\s*:/gu;
const NEXT_INSTRUCTION = /(?:^|[.!?;\n]\s*)(?:(?:what|who|where|when|why|which|how|explain|describe|show|find|locate|trace|compare|change|add|remove|update|implement|fix|create|calculate|compute|evaluate|inspect|cite|include|return|output|report)\b|do\s+not\b)/giu;

export function maskEvaluationInputRecords(query: string): string {
  const chars = query.split("");
  for (const intro of query.matchAll(INTRO)) {
    if (!CALL.test(intro[0])) continue;
    const from = (intro.index ?? 0) + intro[0].length;
    const label = [...query.slice(from).matchAll(LABEL)][0];
    if (!label) continue;
    const labelOffset = label[0].search(/[A-Z](?:\d+)?\s*:/u);
    const start = from + (label.index ?? 0) + labelOffset;
    const tail = query.slice(start);
    const stop = [...tail.matchAll(NEXT_INSTRUCTION)][0];
    const end = start + (stop?.index ?? tail.length);
    const data = query.slice(start, end);
    // An example naming another callable/source may carry a real request.
    // Keep it rather than silently suppressing an independent requirement.
    if (/\x60[A-Za-z_$][\w$]*\x60|\b[A-Za-z][A-Za-z0-9]*_[\w]+\b/u.test(data) || CALL.test(data) || /\b[\w.-]+\.(?:ts|tsx|js|py|java|go|rs|md)\b/u.test(data) || /[?？]/u.test(data)) continue;
    for (let i = start; i < end; i++) if (chars[i] !== "\n" && chars[i] !== "\r") chars[i] = " ";
  }
  return chars.join("");
}
