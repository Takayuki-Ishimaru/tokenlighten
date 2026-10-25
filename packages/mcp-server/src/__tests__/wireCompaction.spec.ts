// 2026-10-23, codex-copilot-proxy wire compaction (wire-overhead-audit.md §5.1
// "SAFE"): the final-reply pass of protocol/wireCompaction.ts, rule by rule,
// then through the real emit pipeline. Every rule is a deletion or a shorter
// spelling of a fact the same reply states; none may change which rows or
// decisions a call produces (the pass runs after the ladder, the ledger
// settlement and the size previews have read the full envelope).
//
// Review of 2026-10-23: the obligation rule is not in the default-ON set (it is
// the TL_EFF_EVIDENCE_PATH_GROUPS family's, `restateObligationsFromEvidence`),
// and a continuation page of a task that passed `surfaceRoles` keeps
// `role:"unknown"` (F1).
import {afterEach, describe, expect, it} from "vitest";
import {compactReplyEnvelope, callPassedSurfaceRoles, requestPassedSurfaceRoles, restateObligationsFromEvidence, genericLikelyEditKinds, resolveObligations, GENERIC_LIKELY_EDIT_KINDS, type CompactionCall} from "../protocol/wireCompaction.js";
import {emitFinalizedPayload} from "../protocol/emit.js";
import type {ProtocolCallContext} from "../protocol/envelope.js";

type Row = Record<string, unknown>;

const hint = (handle: string, a = 0.5, b = 0.4): Row[] => [
  {kind: "inspect-slice", handle, confidence: a},
  {kind: "handle-scoped-edit", handle, confidence: b},
];
const row = (handle: string, over: Row = {}): Row => ({
  handle, path: `src/${handle}.ts`, range: "1-10", body: "export const x = 1;\n", role: "unknown", ...over,
});
const pack = (evidence: Row[], over: Row = {}): Row => ({
  v: 1, kind: "read.task_pack", task: {id: "t", coverage: "complete"}, profile: "generic", evidence,
  decision: {kind: "act.edit"}, ...over,
});
/** The Part 1 pass over a reply whose call had these inbound arguments. */
const compact = (payload: Row, args?: Record<string, unknown>, kind: Parameters<typeof compactReplyEnvelope>[1] = "read.task_pack"): Row =>
  compactReplyEnvelope(payload, kind, args === undefined ? undefined : {args});
/** ...and over a reply whose call is described as the dispatch publishes it (arguments, and whether the task passed roles). */
const compactAs = (payload: Row, call: CompactionCall | undefined, kind: Parameters<typeof compactReplyEnvelope>[1] = "read.task_pack"): Row =>
  compactReplyEnvelope(payload, kind, call);
const rowsOf = (payload: Row): Row[] => payload["evidence"] as Row[];

afterEach(() => {
  delete process.env["TL_EFF_REPLY_COMPACT"];
  delete process.env["TL_EFF_EVIDENCE_PATH_GROUPS"];
});

describe("TL_EFF_REPLY_COMPACT: evidence[].role \"unknown\"", () => {
  it("leaves role off a row the server could not classify, when the call passed no surfaceRoles", () => {
    const input = pack([row("ha", {role: "unknown"}), row("hb", {role: "api"}), row("hc", {role: "unknown"})]);
    const before = structuredClone(input);
    for (const args of [undefined, {}, {surfaceRoles: []}, {scope: {surfaceRoles: []}}, {query: "q", task: {epoch: "new"}}]) {
      const out = rowsOf(compact(input, args));
      expect(out.map(r => r["role"]), JSON.stringify(args)).toEqual([undefined, "api", undefined]);
      expect(Object.keys(out[0]!), "the other members keep their order").toEqual(["handle", "path", "range", "body"]);
    }
    expect(input, "the argument is never mutated").toEqual(before);
  });

  it("keeps \"unknown\" for a call that passed surfaceRoles, in either spelling: absence is that caller's readback", () => {
    const input = pack([row("ha", {role: "unknown"}), row("hb", {role: "api"})]);
    for (const args of [{surfaceRoles: ["contract"]}, {scope: {surfaceRoles: ["contract"]}}]) {
      expect(callPassedSurfaceRoles(args)).toBe(true);
      expect(compact(input, args), JSON.stringify(args)).toBe(input);
    }
  });

  it("does not read an empty or non-array surfaceRoles as a request", () => {
    for (const args of [{surfaceRoles: []}, {surfaceRoles: "api"}, {scope: {surfaceRoles: "api"}}, {scope: {}}, {scope: "x"}]) {
      expect(callPassedSurfaceRoles(args), JSON.stringify(args)).toBe(false);
    }
  });

  it("keeps \"unknown\" on a continuation page of a task that passed surfaceRoles, though the page's own call names none (review F1)", () => {
    // The stored call behind a cursor is `{qref, targets, content}`: no scope. The dispatch publishes the task's fact.
    const input = pack([row("ha", {role: "api"}), row("hb", {role: "unknown"}), row("hc", {role: "unknown"})]);
    const pageCall = {args: {cwd: "/ws", qref: "q-0123456789abcdef", targets: [{path: "src/hb.ts", range: "1-10"}], content: "auto", task: {handle: "tlh_x"}}};
    expect(callPassedSurfaceRoles(pageCall.args), "the page's own arguments say nothing").toBe(false);
    expect(requestPassedSurfaceRoles(pageCall)).toBe(false);
    expect(rowsOf(compactAs(input, pageCall)).map(r => r["role"]), "without the task's fact the page is a plain call").toEqual(["api", undefined, undefined]);
    const continuing = {...pageCall, surfaceRolesPassed: true};
    expect(requestPassedSurfaceRoles(continuing)).toBe(true);
    expect(compactAs(input, continuing), "kept: nothing to compact in the rows").toBe(input);
    // Either source suffices, and neither is needed when both are absent.
    expect(requestPassedSurfaceRoles({args: {surfaceRoles: ["ui"]}})).toBe(true);
    expect(requestPassedSurfaceRoles({surfaceRolesPassed: true})).toBe(true);
    expect(requestPassedSurfaceRoles({surfaceRolesPassed: false, args: {}})).toBe(false);
    expect(requestPassedSurfaceRoles(undefined)).toBe(false);
  });

  it("touches no other carrier of a role: read.map surfaces, frontier_index, decision candidates, pack-unchanged addressing of a classified row", () => {
    const map: Row = {v: 1, kind: "read.map", outline: {form: "surfaces", surfaces: [{role: "unknown", handle: "ha", path: "a.ts"}]}};
    expect(compact(map, undefined, "read.map")).toBe(map);
    const input = pack([row("ha", {role: "api"})], {
      frontier_index: [{path: "src/ha.ts", handle: "ha", role: "unknown"}],
      decision: {kind: "await_input", candidates: [{kind: "unknown", handle: "ha"}]},
    });
    expect(compact(input), "nothing to compact in the rows, so the very object").toBe(input);
    const mixed = pack([row("ha", {role: "unknown"})], {frontier_index: [{path: "src/ha.ts", handle: "ha", role: "unknown"}], decision: {kind: "await_input", candidates: [{kind: "unknown", handle: "ha"}]}});
    const out = compact(mixed);
    expect(out["frontier_index"]).toBe(mixed["frontier_index"]);
    expect(out["decision"]).toBe(mixed["decision"]);
  });

  it("leaves read.text, read.batch and refusals alone", () => {
    for (const kind of ["read.text", "read.batch", "refusal", "edit.applied", "search.matches"] as const) {
      const input: Row = {v: 1, kind, evidence: [row("ha")]};
      expect(compact(input, undefined, kind), kind).toBe(input);
    }
  });

  it("is the identity with TL_EFF_REPLY_COMPACT=0", () => {
    process.env["TL_EFF_REPLY_COMPACT"] = "0";
    const input = pack([row("ha", {likely_edits: hint("ha")})], {profile_binding: {requested: "auto", selected: "generic", source: "inferred", confidence: 0.4, reason: "no high-confidence task-shape marker"}});
    expect(compact(input)).toBe(input);
  });
});

describe("TL_EFF_REPLY_COMPACT: the generic likely_edits pair", () => {
  it.each([[0.5, 0.4], [0.85, 0.75]])("rides as its kinds when it is the pair on the row's own handle at %s/%s", (a, b) => {
    const input = pack([row("ha", {role: "api", likely_edits: hint("ha", a, b)}), row("hb", {role: "api"})]);
    const out = rowsOf(compact(input));
    expect(out[0]!["likely_edits"]).toEqual(["inspect-slice", "handle-scoped-edit"]);
    expect(out[0]!["likely_edits"]).toEqual([...GENERIC_LIKELY_EDIT_KINDS]);
    expect(Object.keys(out[0]!), "the member keeps its place").toEqual(["handle", "path", "range", "body", "role", "likely_edits"]);
    expect(out[1], "a row without hints is the same object").toBe(rowsOf(input)[1]);
    expect(genericLikelyEditKinds(rowsOf(input)[0]!)).toEqual(["inspect-slice", "handle-scoped-edit"]);
  });

  it("keeps any other value as it is", () => {
    const own = "ha";
    const variants: Array<[string, unknown]> = [
      ["another confidence", hint(own, 0.6, 0.5)],
      ["a mixed confidence", hint(own, 0.5, 0.75)],
      ["another handle", hint("hz")],
      ["an extra key", [{...hint(own)[0], path: "x"}, hint(own)[1]]],
      ["a missing confidence", [{kind: "inspect-slice", handle: own}, hint(own)[1]]],
      ["one entry", hint(own).slice(0, 1)],
      ["three entries", [...hint(own), {kind: "inspect-slice", handle: own, confidence: 0.5}]],
      ["reversed", [...hint(own)].reverse()],
      ["other kinds", [{kind: "inspect-slice", handle: own, confidence: 0.5}, {kind: "rename", handle: own, confidence: 0.4}]],
      ["already kinds", ["inspect-slice", "handle-scoped-edit"]],
      ["not an array", {kind: "inspect-slice"}],
    ];
    for (const [name, value] of variants) {
      const input = pack([row(own, {role: "api", likely_edits: value})]);
      expect(compact(input), name).toBe(input);
      expect(genericLikelyEditKinds(rowsOf(input)[0]!), name).toBeUndefined();
    }
  });

  it("returns a fresh kinds array per row (rows never share a mutable array)", () => {
    const out = rowsOf(compact(pack([row("ha", {likely_edits: hint("ha")}), row("hb", {likely_edits: hint("hb")})])));
    expect(out[0]!["likely_edits"]).not.toBe(out[1]!["likely_edits"]);
  });
});

describe("TL_EFF_REPLY_COMPACT: profile_binding.reason", () => {
  const binding = (reason: string, over: Row = {}): Row => ({requested: "auto", selected: "generic", source: "inferred", confidence: 0.4, reason, ...over});

  it.each([
    "no high-confidence task-shape marker",
    "query matched wiring",
    "query matched change_propagation",
    "request-shaped operation evidence refines generic to change_propagation",
    "caller supplied validated generic task shape",
  ])("drops the explanation %j and keeps what was chosen", (reason) => {
    const input = pack([row("ha")], {profile_binding: binding(reason)});
    const out = compact(input)["profile_binding"] as Row;
    expect(out).toEqual({requested: "auto", selected: "generic", source: "inferred", confidence: 0.4});
    expect(Object.keys(out)).toEqual(["requested", "selected", "source", "confidence"]);
  });

  it.each([
    "answer-shaped query served as generic per §14 misfire guardrail; declare task.profile:\"answer\" for a read-only pack",
    "answer-shaped read-only query; task.profile overrides",
    "caller supplied validated answer task shape; declared when this task was opened and kept for this continuation — send task.profile to change it",
    "explicit create of src/new.ts needs task.profile generic (declared: answer)",
    "a reason this list has never seen",
    "",
  ])("keeps advice and anything unknown: %j", (reason) => {
    const input = pack([row("ha")], {profile_binding: binding(reason)});
    expect(compact(input)["profile_binding"]).toBe(input["profile_binding"]);
  });

  it("leaves a binding with no reason and a pack with no binding as they are", () => {
    const bare = pack([row("ha", {role: "api"})], {profile_binding: {requested: "auto", selected: "generic", source: "inferred", confidence: 0.4}});
    expect(compact(bare)).toBe(bare);
    const none = pack([row("ha", {role: "api"})]);
    expect(compact(none)).toBe(none);
  });
});

describe("TL_EFF_EVIDENCE_PATH_GROUPS: plan.change_contract.obligations[] restated from the evidence rows (moved out of the default-ON pass, review 2026-10-23)", () => {
  const obligation = (id: string, handle: string, over: Row = {}): Row => ({
    id, kind: "definition", action: "edit", status: "ready", required: true, handle,
    path: `src/${handle}.ts`, range: "1-10", role: "contract", reason: "r", confidence: 0.85, depends_on: [], ...over,
  });
  const planOf = (obligations: Row[]): Row => ({change_contract: {version: 1, status: "ready", discovery_complete: true, obligations, stages: [obligations.map(o => o["id"])], missing: [], max_additional_tl_calls: 0}, evidence_model: {x: 1}});
  const obligationsOf = (payload: Row): Row[] => ((payload["plan"] as Row)["change_contract"] as Row)["obligations"] as Row[];
  /** What the emit pipeline does to the payload, in its order: the restatement first (against whole rows), then the Part 1 pass. */
  const restated = (payload: Row): Row => restateObligationsFromEvidence(payload, "read.task_pack");
  const shipped = (payload: Row, args?: Record<string, unknown>): Row => compact(restated(payload), args);

  it("ships every obligation whole by default: neither the Part 1 pass nor the restatement touches it", () => {
    const input = pack([row("ha", {role: "contract"}), row("hb", {role: "api", range: "20-30"})], {
      plan: planOf([obligation("o1", "ha"), obligation("o2", "hb", {role: "api", range: "20-30"})]),
    });
    expect(compact(input), "the default-ON pass leaves the plan alone").toBe(input);
    expect(restated(input), "...and so does the restatement while TL_EFF_EVIDENCE_PATH_GROUPS is unset").toBe(input);
    process.env["TL_EFF_EVIDENCE_PATH_GROUPS"] = "0";
    expect(restated(input)).toBe(input);
    process.env["TL_EFF_EVIDENCE_PATH_GROUPS"] = "1";
    expect(restated(input), "...and restates with it on").not.toBe(input);
    // Independent of the Part 1 kill switch: a family member of the grouped rows, not of the compaction.
    process.env["TL_EFF_REPLY_COMPACT"] = "0";
    expect(obligationsOf(restated(input))[0]).not.toHaveProperty("path");
  });

  it("drops the path, range and role the first evidence row of the handle carries, and nothing else", () => {
    process.env["TL_EFF_EVIDENCE_PATH_GROUPS"] = "1";
    const input = pack([row("ha", {role: "contract"}), row("hb", {role: "api", range: "20-30"})], {
      plan: planOf([obligation("o1", "ha"), obligation("o2", "hb", {role: "api", range: "20-30"})]),
    });
    const before = structuredClone(input);
    const out = restated(input);
    expect(obligationsOf(out)).toEqual([
      {id: "o1", kind: "definition", action: "edit", status: "ready", required: true, handle: "ha", reason: "r", confidence: 0.85, depends_on: []},
      {id: "o2", kind: "definition", action: "edit", status: "ready", required: true, handle: "hb", reason: "r", confidence: 0.85, depends_on: []},
    ]);
    expect(Object.keys(obligationsOf(out)[0]!), "key order of what stays").toEqual(["id", "kind", "action", "status", "required", "handle", "reason", "confidence", "depends_on"]);
    const plan = out["plan"] as Row, contract = plan["change_contract"] as Row;
    expect(plan["evidence_model"], "other plan members are the same objects").toBe((input["plan"] as Row)["evidence_model"]);
    expect(contract["stages"]).toBe(((input["plan"] as Row)["change_contract"] as Row)["stages"]);
    expect(Object.keys(plan)).toEqual(["change_contract", "evidence_model"]);
    expect(out["evidence"], "the rows are not touched").toBe(input["evidence"]);
    expect(input, "the argument is never mutated").toEqual(before);
  });

  it("is read back exactly: resolveObligations restores what the pass left off, in the producer's key order", () => {
    process.env["TL_EFF_EVIDENCE_PATH_GROUPS"] = "1";
    const input = pack([row("ha", {role: "contract"}), row("hb", {role: "api", range: "20-30"}), row("hc", {role: "api", range: "5-9"})], {
      plan: planOf([obligation("o1", "ha"), obligation("o2", "hb", {role: "api", range: "1-50"}), obligation("o3", "hshed")]),
    });
    const compacted = restated(input);
    const resolved = resolveObligations(obligationsOf(compacted), rowsOf(compacted));
    expect(JSON.stringify(resolved)).toBe(JSON.stringify(obligationsOf(input)));
    const unchanged = obligationsOf(input);
    expect(resolveObligations(unchanged, rowsOf(input)).every((entry, index) => entry === unchanged[index]), "a complete obligation is returned as it is").toBe(true);
    expect(resolveObligations(["x", null], rowsOf(input))).toEqual(["x", null]);
  });

  it("keeps a member whose value differs from the row's: range is the surface's whole scope window", () => {
    process.env["TL_EFF_EVIDENCE_PATH_GROUPS"] = "1";
    const input = pack([row("ha", {role: "contract", range: "8-28"})], {plan: planOf([obligation("o1", "ha", {range: "1-50"})])});
    const [kept] = obligationsOf(restated(input));
    expect(kept).toMatchObject({handle: "ha", range: "1-50"});
    expect(kept).not.toHaveProperty("path");
    expect(kept).not.toHaveProperty("role");
    const other = pack([row("ha", {role: "api"})], {plan: planOf([obligation("o1", "ha", {role: "contract"})])});
    expect(obligationsOf(restated(other))[0]).toMatchObject({role: "contract"});
    const elsewhere = pack([row("ha", {role: "contract", path: "src/other.ts"})], {plan: planOf([obligation("o1", "ha")])});
    expect(obligationsOf(restated(elsewhere))[0]).toMatchObject({path: "src/ha.ts"});
  });

  it("keeps every member of an obligation whose handle no emitted row carries", () => {
    process.env["TL_EFF_EVIDENCE_PATH_GROUPS"] = "1";
    const input = pack([row("ha", {role: "contract"})], {plan: planOf([obligation("o1", "ha"), obligation("o2", "hshed")])});
    const out = obligationsOf(restated(input));
    expect(out[0]).not.toHaveProperty("path");
    expect(out[1]).toBe(obligationsOf(input)[1]);
    const noHandle = pack([row("ha", {role: "contract"})], {plan: planOf([obligation("o1", "")])});
    expect(restated(noHandle)).toBe(noHandle);
  });

  it("compares with the FIRST row of a handle, whatever follows it", () => {
    process.env["TL_EFF_EVIDENCE_PATH_GROUPS"] = "1";
    const input = pack([
      row("ha", {role: "contract", range: "1-10"}),
      {handle: "ha", path: "src/ha.ts", range: "20-30", body: "x"},
      row("hb", {role: "api"}),
    ], {plan: planOf([obligation("o1", "ha", {range: "20-30"})])});
    expect(obligationsOf(restated(input))[0]).toMatchObject({range: "20-30"});
    const equalToFirst = pack([row("ha", {role: "contract", range: "1-10"}), {handle: "ha", path: "src/ha.ts", range: "20-30", body: "x"}], {plan: planOf([obligation("o1", "ha", {range: "1-10"})])});
    expect(obligationsOf(restated(equalToFirst))[0]).not.toHaveProperty("range");
  });

  it("compares a role before the Part 1 pass drops the row's own \"unknown\": equal values go, an absent role never equals a present one", () => {
    process.env["TL_EFF_EVIDENCE_PATH_GROUPS"] = "1";
    const unknown = pack([row("ha", {role: "unknown"})], {plan: planOf([obligation("o1", "ha", {role: "unknown"})])});
    const out = shipped(unknown);
    expect(obligationsOf(out)[0]).not.toHaveProperty("role");
    expect(rowsOf(out)[0]).not.toHaveProperty("role");
    // The call passed roles: the row keeps its "unknown", and the obligation's equal value still goes.
    const kept = shipped(unknown, {surfaceRoles: ["api"]});
    expect(rowsOf(kept)[0]).toMatchObject({role: "unknown"});
    expect(obligationsOf(kept)[0]).not.toHaveProperty("role");
    const absent = pack([{handle: "ha", path: "src/ha.ts", range: "1-10", body: "x"}], {plan: planOf([obligation("o1", "ha", {role: "unknown"})])});
    expect(obligationsOf(shipped(absent))[0]).toMatchObject({role: "unknown"});
  });

  it("leaves a pack with no change contract, or no obligations, and any other kind alone", () => {
    process.env["TL_EFF_EVIDENCE_PATH_GROUPS"] = "1";
    const none = pack([row("ha", {role: "api"})], {plan: {verification: {x: 1}}});
    expect(restated(none)).toBe(none);
    const empty = pack([row("ha", {role: "api"})], {plan: planOf([])});
    expect(restated(empty)).toBe(empty);
    const text: Row = {v: 1, kind: "read.text", evidence: [row("ha")], plan: planOf([obligation("o1", "ha")])};
    expect(restateObligationsFromEvidence(text, "read.text")).toBe(text);
  });
});

describe("TL_EFF_REPLY_COMPACT: search.tree scope_report", () => {
  const reasons = {ignored: 0, gitignored: 0, tokenlighten_ignored: 0, oversize: 0, symlinks: 0, non_text: 0, secrets: 0, source_only_excluded: 0};
  const tree = (report: Row): Row => ({v: 1, kind: "search.tree", root: "pkg/account", tree: "account.go\ntype.go", depth: 3, scope_report: report});
  const report = (over: Row = {}, counts: Row = {}): Row => ({completeness: "complete", counts: {visited: 2, returned: 2, excluded: 0, errors: 0, ...counts}, excluded_by_reason: {...reasons}, ...over});

  it("drops the all-zero reason table of a complete walk that excluded nothing, and keeps completeness and counts", () => {
    const input = tree(report());
    const out = compact(input, undefined, "search.tree");
    expect(out["scope_report"]).toEqual({completeness: "complete", counts: {visited: 2, returned: 2, excluded: 0, errors: 0}});
    expect(Object.keys(out)).toEqual(["v", "kind", "root", "tree", "depth", "scope_report"]);
    expect((input["scope_report"] as Row)["excluded_by_reason"], "the argument is never mutated").toEqual(reasons);
  });

  it.each([
    ["a partial walk", report({completeness: "partial"})],
    ["an exclusion", report({excluded_by_reason: {...reasons, gitignored: 1}}, {visited: 3, excluded: 1})],
    ["an error", report({}, {visited: 3, errors: 1})],
    ["a reason count that disagrees with the totals", report({excluded_by_reason: {...reasons, oversize: 2}})],
    ["no reason table", {completeness: "complete", counts: {visited: 2, returned: 2, excluded: 0, errors: 0}}],
    ["no counts", {completeness: "complete", excluded_by_reason: {...reasons}}],
  ])("leaves %s as it is", (_name, value) => {
    const input = tree(value as Row);
    expect(compact(input, undefined, "search.tree")).toBe(input);
  });

  it("leaves a tree with no scope_report alone", () => {
    const input: Row = {v: 1, kind: "search.tree", root: ".", tree: "a"};
    expect(compact(input, undefined, "search.tree")).toBe(input);
  });
});

describe("TL_EFF_REPLY_COMPACT through emitFinalizedPayload", () => {
  const context = (args?: Record<string, unknown>, extra: Partial<ProtocolCallContext> = {}): ProtocolCallContext =>
    ({tool: "tl_read_file", ...(args !== undefined ? {args} : {}), ...extra}) as ProtocolCallContext;
  const emitted = (payload: Row, ctx: ProtocolCallContext): Row =>
    JSON.parse(emitFinalizedPayload(payload, payload["kind"] as never, ctx).content[0]!.text) as Row;

  it("ships the compact reply, with the same decision and the same rows, and fewer bytes", () => {
    const evidence = [row("ha", {role: "unknown", likely_edits: hint("ha")}), row("hb", {role: "api"})];
    const build = (): Row => pack(structuredClone(evidence), {
      decision: {kind: "act.edit", certificate: {id: "ready-1", obligations: ["surface-content"], workspace: {fingerprint: "sha256:0"}}, frontier: [{handle: "ha", path: "src/ha.ts", writable: true}]},
      profile_binding: {requested: "auto", selected: "generic", source: "inferred", confidence: 0.4, reason: "no high-confidence task-shape marker"},
    });
    process.env["TL_EFF_REPLY_COMPACT"] = "0";
    const offText = emitFinalizedPayload(build(), "read.task_pack", context()).content[0]!.text;
    delete process.env["TL_EFF_REPLY_COMPACT"];
    const onText = emitFinalizedPayload(build(), "read.task_pack", context()).content[0]!.text;
    const off = JSON.parse(offText) as Row, on = JSON.parse(onText) as Row;
    expect(Buffer.byteLength(onText)).toBeLessThan(Buffer.byteLength(offText));
    expect(on["decision"]).toEqual(off["decision"]);
    expect(rowsOf(on).map(r => [r["handle"], r["path"], r["range"], r["body"]])).toEqual(rowsOf(off).map(r => [r["handle"], r["path"], r["range"], r["body"]]));
    expect(rowsOf(on)[0]).not.toHaveProperty("role");
    expect(rowsOf(on)[0]!["likely_edits"]).toEqual(["inspect-slice", "handle-scoped-edit"]);
    expect(rowsOf(on)[1]!["role"]).toBe("api");
    expect(on["profile_binding"]).not.toHaveProperty("reason");
  });

  it("keeps \"unknown\" for a call whose inbound arguments name surfaceRoles", () => {
    const payload = pack([row("ha", {role: "unknown"})], {decision: {kind: "discover", next: {tool: "tl_read_file", arguments: {cursor: "tlc_s1_aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbb"}}}});
    expect(rowsOf(emitted(structuredClone(payload), context({surfaceRoles: ["api"]})))[0]!["role"]).toBe("unknown");
    expect(rowsOf(emitted(structuredClone(payload), context({scope: {surfaceRoles: ["api"]}})))[0]!["role"]).toBe("unknown");
    expect(rowsOf(emitted(structuredClone(payload), context({surfaceRoles: []})))[0]).not.toHaveProperty("role");
  });

  it("keeps \"unknown\" on the page of a task that passed surfaceRoles: the context the dispatch published, not the page's own call (review F1)", () => {
    const payload = pack([row("ha", {role: "api"}), row("hb", {role: "unknown"})], {decision: {kind: "act.edit", certificate: {id: "ready-1", obligations: ["surface-content"], workspace: {fingerprint: "sha256:0"}}, frontier: [{handle: "ha", path: "src/ha.ts", writable: true}]}});
    const pageArgs = {cwd: "/ws", qref: "q-0123456789abcdef", targets: [{path: "src/hb.ts", range: "1-10"}], content: "auto", task: {handle: "tlh_x"}};
    expect(rowsOf(emitted(structuredClone(payload), context(pageArgs, {surfaceRolesPassed: true}))).map(r => r["role"]), "the task passed roles").toEqual(["api", "unknown"]);
    expect(rowsOf(emitted(structuredClone(payload), context(pageArgs))).map(r => r["role"]), "a plain task's page").toEqual(["api", undefined]);
    process.env["TL_EFF_REPLY_COMPACT"] = "0";
    expect(rowsOf(emitted(structuredClone(payload), context(pageArgs))).map(r => r["role"]), "the rolled-back control").toEqual(["api", "unknown"]);
  });

  it("ships the obligations whole by default, and restated from the rows only with TL_EFF_EVIDENCE_PATH_GROUPS", () => {
    const obligation = (id: string, handle: string, over: Row = {}): Row => ({
      id, kind: "definition", action: "edit", status: "ready", required: true, handle,
      path: `src/${handle}.ts`, range: "1-10", role: "contract", reason: "r", confidence: 0.85, depends_on: [], ...over,
    });
    const build = (): Row => pack([row("ha", {role: "contract"}), row("hb", {role: "unknown"})], {
      decision: {kind: "act.edit", certificate: {id: "ready-1", obligations: ["surface-content"], workspace: {fingerprint: "sha256:0"}}, frontier: [{handle: "ha", path: "src/ha.ts", writable: true}]},
      plan: {change_contract: {version: 1, status: "ready", discovery_complete: true, obligations: [obligation("o1", "ha"), obligation("o2", "hb", {role: "unknown"})], stages: [["o1", "o2"]], missing: [], max_additional_tl_calls: 0}},
    });
    const obligationsOf = (payload: Row): Row[] => ((payload["plan"] as Row)["change_contract"] as Row)["obligations"] as Row[];
    const offText = emitFinalizedPayload(build(), "read.task_pack", context()).content[0]!.text;
    process.env["TL_EFF_REPLY_COMPACT"] = "0";
    const rolledBack = emitFinalizedPayload(build(), "read.task_pack", context()).content[0]!.text;
    delete process.env["TL_EFF_REPLY_COMPACT"];
    const byDefault = JSON.parse(offText) as Row;
    expect(obligationsOf(byDefault), "the default-ON compaction leaves the obligations as they were").toEqual(obligationsOf(JSON.parse(rolledBack) as Row));
    expect(obligationsOf(byDefault)[0]).toMatchObject({path: "src/ha.ts", range: "1-10", role: "contract"});
    process.env["TL_EFF_EVIDENCE_PATH_GROUPS"] = "1";
    const onText = emitFinalizedPayload(build(), "read.task_pack", context()).content[0]!.text;
    const restatedPayload = JSON.parse(onText) as Row;
    expect(Buffer.byteLength(onText), "restating the obligations is smaller").toBeLessThan(Buffer.byteLength(offText));
    expect(obligationsOf(restatedPayload)[0]).not.toHaveProperty("path");
    expect(obligationsOf(restatedPayload)[0]).not.toHaveProperty("role");
    expect(obligationsOf(restatedPayload)[1], "the role the row also dropped (a call with no roles) goes from both").not.toHaveProperty("role");
    // ...and a reader restores them from the whole rows.
    expect(JSON.stringify(resolveObligations(obligationsOf(restatedPayload), rowsOf(restatedPayload)))).toBe(JSON.stringify(obligationsOf(JSON.parse(offText) as Row).map((entry, index) => index === 1 ? {...entry, role: undefined} : entry)));
  });
});
