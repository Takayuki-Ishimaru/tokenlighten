// Range words (DESIGN-v0.14-plan.md §20.15, §20.17): the spellings of a
// `range` that name a window by word rather than by two line numbers. Pure
// string logic, shared by the slice reader (tools/readCodeModes.ts) and the
// execution fence's loop brake (state/session.ts), so both read a request's
// window the same way.

/**
 * Rewrites a whole-file word ("full", "all", "whole", "entire", "*") to
 * `1-<last>` and an open end ("120-end", "120-$", "120-eof", "120-") to
 * `<start>-<last>`, case-insensitively and with an optional `L` prefix on the
 * start line. Returns `undefined` for anything else, so callers keep their own
 * handling of digits, single lines and comma forms.
 *
 * Bench evidence (6t-2 T13 rep1 call 7): the solver sent `range:"full"` and
 * paid a refusal turn. A bare "120-" is already widened for a top-level
 * `range` by server.ts's input normalization; this also covers `ranges[]`
 * entries and the fence's own parser, which that pass does not see.
 */
export function wholeOrOpenEndedRange(raw: string, totalLines: number): string | undefined {
  const trimmed = raw.trim().toLowerCase();
  const last = Math.max(1, totalLines);
  if (/^(full|all|whole|entire|\*)$/.test(trimmed)) return `1-${last}`;
  const open = /^l?(\d+)\s*-\s*(end|\$|eof)?$/.exec(trimmed);
  if (open === null) return undefined;
  const start = Number.parseInt(open[1]!, 10);
  return Number.isNaN(start) ? undefined : `${start}-${Math.max(start, last)}`;
}
