type Row = Record<string, unknown>;
const row = (value: unknown): Row | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined;

/** Optional lookup metadata can disappear only after the final evidence set is
 * known. Never use this on the pre-budget pack: a later shed may need its index.
 */
export function omitCoveredFrontierIndex(payload: Row): Row {
  const kind = row(payload["decision"])?.["kind"];
  if (payload["kind"] !== "read.task_pack" || (kind !== "act.answer" && kind !== "act.edit")) return payload;
  const index = payload["frontier_index"], evidence = payload["evidence"];
  if (!Array.isArray(index) || index.length === 0 || !Array.isArray(evidence)) return payload;
  const covered = index.every(value => {
    const entry = row(value);
    if (!entry || Object.keys(entry).length !== 3
      || !["path", "handle", "role"].every(key => typeof entry[key] === "string" && entry[key] !== "")) return false;
    return evidence.some(value => {
      const source = row(value);
      return source !== undefined && source["path"] === entry["path"] && source["handle"] === entry["handle"]
        && source["role"] === entry["role"] && source["partial"] !== true && source["truncated"] !== true
        && source["remaining"] === undefined
        && (typeof source["body"] === "string" || (typeof source["prior"] === "string" && source["prior"] !== ""));
    });
  });
  if (!covered) return payload;
  const result = {...payload}; delete result["frontier_index"]; return result;
}
