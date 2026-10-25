// A client/model-independent projection of the canonical dispatch schemas.
// Opt-in advertisement only: dispatch continues to validate ALL_TOOLS.
// Rare fields arrive in executable next/recovery calls and remain host-valid
// because every projected object is open. Never infer workspace/task identity.
export interface PortableToolDefinition {
  name: string;
  description: string;
  inputSchema: { properties: Record<string, unknown>; [key: string]: unknown };
}
const fields: Record<string, readonly string[]> = {
  tl_read_file: ["cwd", "lane", "query", "targets", "content", "task", "budget", "qref", "cursor", "scope", "select"],
  tl_edit_file: ["cwd", "lane", "edits", "task", "operation_id", "artifact"],
  tl_search_files: ["cwd", "lane", "action", "queries", "scope", "task", "budget", "cursor"],
};
// 2026-10-18 (v016 decision 6t-1): with these descriptions alone and the
// compact guide, Sonnet left TokenLighten after the first pack in 9 of 18
// cells and re-read and grepped natively. Each description now says which
// native tool it replaces and how a follow-up read is shaped (targets, no
// query), as the 2026-10-01 lean guide did when its arm made no native call.
// 2026-10-22 (codex-copilot-proxy r16/r17): the edit description says each
// item carries its OWN address. "Use served path/search/replace" read as
// optional prose beside an item schema whose `required:["search","replace"]`
// looked complete, and 4 of 8 Codex edit trials sent address-less items; the
// schema now says it too (server.ts CANONICAL_EDIT_ITEM `anyOf`; this
// projection deletes only the TOP-level oneOf/anyOf, so the item-level one
// survives and `compact()` only strips descriptions inside it).
const descriptions: Record<string, string> = {
  tl_read_file: 'Read workspace files here. FIRST source lookup: {cwd,query:"<entire user request, verbatim>",task:{epoch:"new"}}. Same request: targets[] (path/handle, range), task.handle; no query or epoch:"new". Read-only: task.profile:"answer". act.answer/act.edit: act; discover: run next, never answer; receipt: reuse.',
  tl_edit_file: 'Edit/Write: ONE edits[] batch for all ready obligations, including style across stages. Each item: its own path (or served handle whose window covers search; multiple windows: prefer path) + search/replace + precondition:"unique-match". New: path,create:true,content. Copy top-level cwd. Requires --allow-write. Follow recovery before retrying.',
  tl_search_files: 'Replaces grep/rg/find/ls; first use tl_read_file. find: one literal identifier per queries[]; scope.path narrows. references=call sites, tree=listing, diff. Run next verbatim.',
};
function pick(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter(key => Object.hasOwn(record, key)).map(key => [key, record[key]]));
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function compact(node: unknown): void {
  if (Array.isArray(node)) { for (const child of node) compact(child); return; }
  const record = object(node);
  if (!record) return;
  delete record["description"];
  delete record["additionalProperties"];
  for (const key of ["properties", "$defs", "definitions"]) {
    for (const child of Object.values(object(record[key]) ?? {})) compact(child);
  }
  for (const key of ["items", "oneOf", "anyOf", "allOf", "not", "if", "then", "else"]) compact(record[key]);
}
/** Takes a fresh canonical definition, after tool-surface filtering. */
export function portableToolDefinition<T extends PortableToolDefinition>(definition: T, workspace?: string): T {
  if (!Object.hasOwn(fields, definition.name)) return definition;
  const schema = definition.inputSchema;
  const properties = schema.properties = pick(schema.properties, fields[definition.name]!);
  delete schema["oneOf"]; delete schema["anyOf"];
  const task = object(properties["task"]);
  if (task) delete task["dependentRequired"];
  const targets = object(properties["targets"]);
  const target = object(targets?.["items"]);
  if (target) target["properties"] = pick(object(target["properties"]) ?? {}, ["path", "handle", "range", "ranges", "symbol", "purpose"]);
  const edits = object(properties["edits"]);
  const edit = object(edits?.["items"]);
  if (edit) edit["properties"] = pick(object(edit["properties"]) ?? {}, ["path", "handle", "search", "replace", "create", "content", "precondition", "allowPathFallback", "all"]);
  // Keep first-class routing/budget/task fields; collapse only specialist
  // selectors. Their complete server-issued continuations must pass hosts.
  const scope = object(properties["scope"]);
  for (const name of ["scope", "select", "artifact"]) {
    if (properties[name] !== undefined) properties[name] = { type: "object" };
  }
  if (definition.name === "tl_search_files" && properties["scope"] !== undefined) {
    properties["scope"] = { type: "object", properties: pick(object(scope?.["properties"]) ?? {}, ["path", "regex", "kind", "depth", "lang", "symbol"]) };
  }
  compact(schema);
  const lane = object(properties["lane"]);
  if (lane) lane["description"] = 'Omit alone. Never add/change mid-task.';
  // A known connection root avoids a preparatory pwd call. This is a bounded
  // copy hint, never a schema default, a constraint or inferred authorization.
  const cwd = definition.name === "tl_read_file" ? object(properties["cwd"]) : undefined;
  if (cwd && typeof workspace === "string" && !/[\r\n\0]/u.test(workspace)
    && /^(?:\/|[A-Za-z]:[\\/])/u.test(workspace)) {
    const hint = `Workspace cwd: ${JSON.stringify(workspace)}; no pwd.`;
    if (new TextEncoder().encode(hint).length <= 100) cwd["description"] = hint;
  }
  // A closure pull overrides source selection. Keep this semantic distinction
  // visible even when portable mode removes the other field descriptions.
  const taskProperties = object(task?.["properties"]);
  if (taskProperties && definition.name !== "tl_read_file") {
    for (const key of ["epoch", "force_serve", "pull"]) delete taskProperties[key];
  }
  const closurePull = object(taskProperties?.["pull"]);
  if (closurePull) closurePull["description"] = 'Only after edit closure; verification, not source; omit when reading targets.';
  // 2026-10-17 (DESIGN-v0.14-plan §20.9): no success response carries the
  // version (D-2), so a model reading a bare `number` here guessed one and
  // was refused (Copilot CLI E1). Name the only source of a valid value.
  // 2026-10-18 (DESIGN-v0.14-plan §20.15, bench 6t-2 T13 rep0): twelve
  // follow-up reads went out as `epoch:"new"` packs, each restarting
  // discovery and re-serving held context. Say when the value applies, on
  // the read tool only (the one the bench saw misused; bytes ride every turn).
  const epoch = definition.name === "tl_read_file" ? object(taskProperties?.["epoch"]) : undefined;
  if (epoch) epoch["description"] = 'Only "new", on the first read of a new user request.';
  const casGuard = object(taskProperties?.["expected_state_version"]);
  if (casGuard) casGuard["description"] = "Only a refusal's actual version; omit otherwise.";
  definition.description = descriptions[definition.name]!;
  return definition;
}
