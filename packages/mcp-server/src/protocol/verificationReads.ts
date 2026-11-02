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
/**
 * How many bytes of OPTIONAL test source the kit's one batched `next_call` may
 * ask to read. 16 KiB is the budget the kit itself spends inline on bodies
 * (verificationPack KIT_INLINE_TOTAL_CAP_BYTES), i.e. what a single response is
 * already allowed to carry. Past it the kit lists test paths and handles and
 * names `toolchain.test_entry` only: the 2026-10-29 click report had a one-line
 * edit propose full reads of six test files (~95 KB, ~24k tokens), none of
 * which checked the changed output, when running the suite or one targeted
 * slice answers the question.
 */
export const VERIFICATION_TEST_READ_BUDGET_BYTES = 16 * 1024;

/**
 * Handles of body-less test surfaces that do not fit the read budget. The kit's
 * `surfaces` are in relevance order, so the budget is spent in that order and
 * stops at the first test that does not fit: a weakly related small test must
 * not be read while the strongest one is not. A test the recipe names
 * (`requiredPaths`) always rides, and spends the budget first.
 * `skip` holds handles that are already optional or ride for another reason.
 */
export function testHandlesOverReadBudget(
  kit: Row, requiredPaths: ReadonlySet<string>, skip: ReadonlySet<string>,
  budget: number = VERIFICATION_TEST_READ_BUDGET_BYTES,
): Set<string> {
  const over = new Set<string>();
  const candidates = surfaces(kit).filter(entry => entry["role"] === "test" && entry["body"] === "omitted"
    && typeof entry["handle"] === "string" && !skip.has(entry["handle"]));
  const sizeOf = (entry: Row): number => typeof entry["bytes"] === "number" && Number.isFinite(entry["bytes"]) ? entry["bytes"] : budget + 1;
  const isRequired = (entry: Row): boolean => typeof entry["path"] === "string" && requiredPaths.has(entry["path"].replace(/\\/g, "/"));
  let spent = 0;
  for (const entry of candidates) if (isRequired(entry)) spent += sizeOf(entry);
  let full = false;
  for (const entry of candidates) {
    if (isRequired(entry)) continue;
    const size = sizeOf(entry);
    if (!full && spent + size <= budget) spent += size;
    else {
      full = true;
      over.add(entry["handle"] as string);
    }
  }
  return over;
}

/** Test files a kit that cannot run them still names. */
const CANNOT_RUN_LISTED_TESTS = 3;

/**
 * A kit whose tests cannot run here has nothing to verify with, and its list of
 * test files was the bulk of the edit reply (code-fix probe, 2026-11-01: 2 KB of
 * 3 KB, carried by every later request). It keeps the few most relevant, in case
 * the change must update one. A kit with a harness, compile facts or a link set
 * is left whole: those build without the missing dependencies.
 */
export function shortenKitWhenTestsCannotRun(kit: Row, optional: ReadonlySet<string>): Row {
  const buildable = kit["harness"] !== undefined || kit["next_call"] !== undefined
    || (Array.isArray(kit["compile_facts"]) && kit["compile_facts"].length > 0)
    || (Array.isArray(kit["link_set"]) && kit["link_set"].length > 0);
  if (buildable || surfaces(kit).length === 0) return kit;
  let listed = 0;
  let dropped = 0;
  const shortened = surfaces(kit).flatMap((entry) => {
    if (typeof entry["handle"] !== "string" || !optional.has(entry["handle"])) return [entry];
    listed += 1;
    if (listed > CANNOT_RUN_LISTED_TESTS) { dropped += 1; return []; }
    return [{ path: entry["path"], role: entry["role"], handle: entry["handle"], body: entry["body"] }];
  });
  if (listed === 0) return kit;
  return {
    ...kit,
    surfaces: shortened,
    omitted: (typeof kit["omitted"] === "number" ? kit["omitted"] : 0) + dropped,
    note: "these tests cannot run here; read one only if this change must update it",
  };
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
