// Optional test source must not be confused with a prerequisite for running tests.
type Row = Record<string, unknown>;
const record = (value: unknown): Row | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined;
const recipeGaps = (kit: Row): {valid: boolean; gaps: unknown[]} => {
  const value = kit["recipe"];
  if (value === undefined) return {valid: true, gaps: []};
  const recipe = record(value), gaps = recipe?.["gaps"];
  return Array.isArray(gaps) ? {valid: true, gaps} : {valid: false, gaps: []};
};
const validNextCall = (kit: Row): boolean => {
  const value = kit["next_call"];
  if (value === undefined) return true;
  const call = record(value), args = record(call?.["arguments"]);
  return (call?.["tool"] === "tl_read_file" || call?.["tool"] === "tl_edit_file"
    || call?.["tool"] === "tl_search_files") && args !== undefined;
};
const surfaces = (kit: Row): Row[] =>
  (Array.isArray(kit["surfaces"]) ? kit["surfaces"] : []).flatMap(value => {
    const row = record(value);
    return row === undefined ? [] : [row];
  });
export function optionalVerificationTestHandles(
  kit: Row, runnableCli: boolean, requiredPaths: ReadonlySet<string>, requiredHandles: ReadonlySet<string>,
): Set<string> {
  const optional = new Set<string>();
  const toolchain = record(kit["toolchain"]);
  if (!runnableCli || typeof toolchain?.["test_entry"] !== "string" || toolchain["test_entry"].trim().length === 0
    || typeof toolchain["test_entry_dir"] !== "string" || toolchain["test_entry_dir"].trim().length === 0) return optional;
  const recipe = recipeGaps(kit);
  if (!recipe.valid || recipe.gaps.length > 0 || !validNextCall(kit)) return optional;
  for (const entry of surfaces(kit)) {
    const handle = entry["handle"], path = entry["path"];
    if (entry["role"] === "test" && entry["body"] === "omitted"
      && typeof handle === "string" && typeof path === "string"
      && !requiredHandles.has(handle) && !requiredPaths.has(path.replace(/\\/g, "/"))) optional.add(handle);
  }
  return optional;
}
/** Change guidance only; never claim an unserved body was delivered. */
export function clarifyOptionalVerificationTests(kit: Row, optional: ReadonlySet<string>, batched: readonly string[]): void {
  const omitted = surfaces(kit).filter(entry => entry["role"] === "test" && entry["body"] === "omitted");
  if (omitted.length === 0 || omitted.some(entry => typeof entry["handle"] !== "string"
    || !optional.has(entry["handle"] as string) || batched.includes(entry["handle"] as string))) return;
  const nextCallValue = kit["next_call"];
  const hasNextCall = nextCallValue !== undefined;
  const recipe = recipeGaps(kit);
  if (!recipe.valid || !validNextCall(kit)) return;
  const hasRecipeGaps = recipe.gaps.length > 0;
  const toolchain = record(kit["toolchain"]);
  if (typeof toolchain?.["test_entry"] !== "string" || toolchain["test_entry"].trim().length === 0
    || typeof toolchain["test_entry_dir"] !== "string" || toolchain["test_entry_dir"].trim().length === 0) return;
  const command = JSON.stringify(toolchain["test_entry"]);
  const directory = JSON.stringify(toolchain["test_entry_dir"]);
  const readGuidance = hasNextCall || hasRecipeGaps
    ? `follow verification.next_call when present and nonempty recipe.gaps before the run; run ${command} from ${directory}; other listed test source is optional`
    : `verification instructions are already included; run ${command} from ${directory}; other listed test source is optional`;
  if (typeof kit["note"] === "string") kit["note"] = kit["note"].replace(
    "run toolchain.test_entry from toolchain.test_entry_dir; use served test context; read only omitted bodies via next",
    `${readGuidance}; do not pull closure just to retrieve this kit again; follow a closure next only when explicitly returned`,
  );
}
