// 2026-10-23, codex-copilot-proxy wire compaction (wire-overhead-audit.md §4.2
// rank 1; flag TL_EFF_EVIDENCE_PATH_GROUPS, default OFF): a run of two or more
// consecutive evidence rows on one `path` ships its address once, and the
// reply says so in `evidence_note`. The writer (protocol/evidencePathGroups.ts)
// is a pure pass over the final payload; this spec holds its rules, the exact
// round trip, the emit pipeline around it, and every reader of a reply's TEXT
// that has to read the rows back whole.
import {afterEach, describe, expect, it} from "vitest";
import {
  EVIDENCE_PATH_GROUP_MIN_NET_SAVING_BYTES, EVIDENCE_PATH_GROUP_NOTE, evidenceIsGrouped, expandEvidencePathGroups, groupEvidencePaths, resolveEvidenceRows,
} from "../protocol/evidencePathGroups.js";
import {emitFinalizedPayload} from "../protocol/emit.js";
import type {ProtocolCallContext} from "../protocol/envelope.js";
import {HARD_JSON_FIXED_KINDS, isEligibleKind} from "../protocol/codec/policy.js";
import {applyResponseCodec} from "../protocol/codec/pipeline.js";
import {activeExperimentFlags, effEvidencePathGroupsEnabled} from "../util/flags.js";
import {
  clearSourceCapsules, finalizeSourceCapsules, runWithSourceCapsuleCall, sourceCapsulePrior, stageSourceCapsules,
} from "../features/task-pack/sourceCapsuleCallScope.js";
import type {SourceBodyCapsule} from "../features/task-pack/sourceBodyCapsule.js";
import {createPackFingerprintBinding} from "../features/task-pack/packFingerprintBinding.js";
import {owedRowsFitOnePage} from "../features/task-pack/readCodeTaskPack.js";
import {taskPackSizePreview} from "../protocol/taskPackSizePreview.js";
import {handleTable} from "../util/handles.js";
import type {TaskPackResult} from "../features/task-pack/model.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type Row = Record<string, unknown>;

const FILE_A = "backend/src/main/java/com/shopflow/service/OrderOrchestrator.java";
const FILE_B = "backend/src/main/java/com/shopflow/model/OrderStatus.java";
const FILE_C = "backend/src/main/java/com/shopflow/service/PaymentGateway.java";
const row = (handle: string, path: string, range: string, over: Row = {}): Row =>
  ({handle, path, range, body: `// ${range}\n`, ...over});
const pack = (evidence: unknown[], over: Row = {}): Row => ({
  v: 1, kind: "read.task_pack", task: {id: "t", coverage: "partial"}, profile: "answer", evidence,
  decision: {kind: "discover", next: {tool: "tl_read_file", arguments: {cursor: "tlc_s1_aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbb"}}}, ...over,
});
const rowsOf = (payload: Row): Row[] => payload["evidence"] as Row[];
const on = (): void => { process.env["TL_EFF_EVIDENCE_PATH_GROUPS"] = "1"; };

afterEach(() => { delete process.env["TL_EFF_EVIDENCE_PATH_GROUPS"]; delete process.env["TL_EFF_REPLY_COMPACT"]; clearSourceCapsules(); });

describe("TL_EFF_EVIDENCE_PATH_GROUPS: the flag", () => {
  it("is default OFF, and the writer is the identity while it is", () => {
    expect(effEvidencePathGroupsEnabled()).toBe(false);
    expect(activeExperimentFlags()).not.toContain("TL_EFF_EVIDENCE_PATH_GROUPS");
    const input = pack([row("h1", FILE_A, "1-5"), row("h1", FILE_A, "9-12")]);
    expect(groupEvidencePaths(input)).toBe(input);
  });

  it("reports itself in flags_active when on, and accepts the usual spellings", () => {
    on();
    expect(effEvidencePathGroupsEnabled()).toBe(true);
    expect(activeExperimentFlags()).toContain("TL_EFF_EVIDENCE_PATH_GROUPS");
    for (const off of ["0", "off", "false"]) {
      process.env["TL_EFF_EVIDENCE_PATH_GROUPS"] = off;
      expect(effEvidencePathGroupsEnabled(), off).toBe(false);
    }
  });
});

describe("TL_EFF_EVIDENCE_PATH_GROUPS: writing a reply", () => {
  it("writes a run of one file and one handle once: the later rows carry neither path nor handle", () => {
    on();
    const input = pack([row("h1", FILE_A, "1-5"), row("h1", FILE_A, "9-12"), row("h1", FILE_A, "20-22")]);
    const before = structuredClone(input);
    const out = groupEvidencePaths(input);
    expect(rowsOf(out)).toEqual([row("h1", FILE_A, "1-5"), {range: "9-12", body: "// 9-12\n"}, {range: "20-22", body: "// 20-22\n"}]);
    expect(Object.keys(out), "the note sits immediately before evidence, the rest keeps its place").toEqual(["v", "kind", "task", "profile", "evidence_note", "evidence", "decision"]);
    expect(out["evidence_note"]).toBe(EVIDENCE_PATH_GROUP_NOTE);
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThan(Buffer.byteLength(JSON.stringify(input)));
    expect(input, "the argument is never mutated").toEqual(before);
    expect(out["decision"], "everything else is the same object").toBe(input["decision"]);
  });

  it("keeps a handle that differs from the row above, and drops only the path: one file, a surface per row", () => {
    on();
    const input = pack([row("h1", FILE_A, "1-5"), row("h2", FILE_A, "9-12"), row("h3", FILE_A, "20-22")]);
    expect(rowsOf(groupEvidencePaths(input))).toEqual([
      row("h1", FILE_A, "1-5"), {handle: "h2", range: "9-12", body: "// 9-12\n"}, {handle: "h3", range: "20-22", body: "// 20-22\n"},
    ]);
  });

  it("drops the handle of a row that returns to the handle above it, and keeps the one that changes it", () => {
    on();
    const input = pack([row("h1", FILE_A, "1-5"), row("h1", FILE_A, "6-7"), row("h2", FILE_A, "9-12"), row("h2", FILE_A, "13-14"), row("h1", FILE_A, "20-22")]);
    expect(rowsOf(groupEvidencePaths(input)).map(r => [r["handle"], r["path"], r["range"]])).toEqual([
      ["h1", FILE_A, "1-5"], [undefined, undefined, "6-7"], ["h2", undefined, "9-12"], [undefined, undefined, "13-14"], ["h1", undefined, "20-22"],
    ]);
  });

  it("groups each run of a file separately and leaves single-row files alone", () => {
    on();
    const input = pack([
      row("h1", FILE_A, "1-5"), row("h1", FILE_A, "9-12"),
      row("h9", FILE_B, "6-28"),
      row("h1", FILE_A, "40-44"),
      row("h5", FILE_C, "1-30"), row("h5", FILE_C, "31-60"),
    ]);
    const out = rowsOf(groupEvidencePaths(input));
    expect(out[0]).toEqual(row("h1", FILE_A, "1-5"));
    expect(out[1]).toEqual({range: "9-12", body: "// 9-12\n"});
    expect(out[2], "a single-row file is untouched, same object").toBe(rowsOf(input)[2]);
    expect(out[3], "the same file after another one starts a new run, in full").toBe(rowsOf(input)[3]);
    expect(out[4]).toBe(rowsOf(input)[4]);
    expect(out[5]).toEqual({range: "31-60", body: "// 31-60\n"});
  });

  it("is the identity (same object, no note) when no run of two exists", () => {
    on();
    const input = pack([row("h1", FILE_A, "1-5"), row("h2", FILE_B, "1-5"), row("h1", FILE_A, "9-12")]);
    expect(groupEvidencePaths(input)).toBe(input);
    const single = pack([row("h1", FILE_A, "1-5")]);
    expect(groupEvidencePaths(single)).toBe(single);
    const none = pack([]);
    expect(groupEvidencePaths(none)).toBe(none);
  });

  it("refuses to group an array with a row that has no path or no handle of its own", () => {
    on();
    for (const odd of [
      {handle: "h1", prior: "read-1"},                   // a PriorEvidence row that carries no address
      {path: FILE_A, range: "1-5", body: "x"},           // no handle
      {handle: "h1", path: "", range: "1-5", body: "x"}, // an empty path
      "not an object",
      null,
    ]) {
      const input = pack([row("h1", FILE_A, "1-5"), row("h1", FILE_A, "9-12"), odd]);
      expect(groupEvidencePaths(input), JSON.stringify(odd)).toBe(input);
    }
  });

  it("writes only a read.task_pack, and nothing that is not an array of rows", () => {
    on();
    for (const kind of ["read.text", "read.batch", "read.receipt", "search.matches", "refusal"]) {
      const input: Row = {v: 1, kind, evidence: [row("h1", FILE_A, "1-5"), row("h1", FILE_A, "9-12")]};
      expect(groupEvidencePaths(input), kind).toBe(input);
    }
    const noEvidence: Row = {v: 1, kind: "read.task_pack", evidence: "x"};
    expect(groupEvidencePaths(noEvidence)).toBe(noEvidence);
  });

  it("does not group a short run whose saving, net of the note, is under the minimum", () => {
    on();
    // Two short paths: the second row saves `"path":"a.ts",` and `"handle":"h1",`, about 38 B, against a note of about 70 B.
    const short = pack([row("h1", "a.ts", "1-5"), row("h1", "a.ts", "9-12")]);
    expect(groupEvidencePaths(short)).toBe(short);
    // Two rows of a long path on one handle save about 98 B: more than the note costs, but not by the minimum.
    const barely = pack([row("h1", FILE_A, "1-5"), row("h1", FILE_A, "9-12")]);
    const saved = (grouped: Row, whole: Row): number => Buffer.byteLength(JSON.stringify(whole)) - Buffer.byteLength(JSON.stringify(grouped));
    const barelyGrouped = groupEvidencePaths(barely);
    expect(barelyGrouped, "98 B saved - 69 B of note < " + EVIDENCE_PATH_GROUP_MIN_NET_SAVING_BYTES).toBe(barely);
    // One more row on the run: the saving passes the minimum, and the reply is grouped.
    const enough = pack([row("h1", FILE_A, "1-5"), row("h1", FILE_A, "9-12"), row("h1", FILE_A, "20-22")]);
    const enoughGrouped = groupEvidencePaths(enough);
    expect(enoughGrouped).not.toBe(enough);
    expect(saved(enoughGrouped, enough)).toBeGreaterThanOrEqual(EVIDENCE_PATH_GROUP_MIN_NET_SAVING_BYTES);
  });

  it("replaces an evidence_note a reply already carried instead of repeating it", () => {
    on();
    const input = pack([row("h1", FILE_A, "1-5"), row("h1", FILE_A, "9-12"), row("h1", FILE_A, "20-22")], {evidence_note: "stale"});
    const out = groupEvidencePaths(input);
    expect(Object.keys(out).filter(key => key === "evidence_note")).toHaveLength(1);
    expect(out["evidence_note"]).toBe(EVIDENCE_PATH_GROUP_NOTE);
  });
});

describe("TL_EFF_EVIDENCE_PATH_GROUPS: reading a reply back", () => {
  it("restores the whole rows exactly, byte for byte, handle first and path second", () => {
    on();
    const input = pack([
      row("h1", FILE_A, "1-5", {role: "api", why: "x"}), row("h1", FILE_A, "9-12"), row("h2", FILE_A, "13-14", {prior: "read-1"}),
      row("h9", FILE_B, "6-28"), row("h5", FILE_C, "1-30"), row("h5", FILE_C, "31-60", {remaining: ["61-90"]}),
    ]);
    const grouped = groupEvidencePaths(input);
    expect(grouped).not.toBe(input);
    expect(evidenceIsGrouped(grouped)).toBe(true);
    const expanded = expandEvidencePathGroups(grouped);
    expect(JSON.stringify(expanded)).toBe(JSON.stringify(input));
    expect(expanded).not.toHaveProperty("evidence_note");
  });

  it("passes a reply that does not state it was grouped through untouched, whatever its rows look like", () => {
    const input = pack([row("h1", FILE_A, "1-5"), {range: "9-12", body: "x"}, {handle: "h1", prior: "read-1"}]);
    expect(evidenceIsGrouped(input)).toBe(false);
    expect(expandEvidencePathGroups(input)).toBe(input);
    const wrongNote = {...input, evidence_note: "something else"};
    expect(expandEvidencePathGroups(wrongNote)).toBe(wrongNote);
  });

  it("resolves a row's own path or handle over the inherited one, and tolerates entries that are not rows", () => {
    const rows = resolveEvidenceRows([row("h1", FILE_A, "1-5"), {range: "6-7"}, {handle: "h2", range: "8-9"}, "x", {path: FILE_B, range: "1-2"}, {range: "3-4"}]);
    expect(rows).toEqual([
      row("h1", FILE_A, "1-5"),
      {handle: "h1", path: FILE_A, range: "6-7"},
      {handle: "h2", path: FILE_A, range: "8-9"},
      "x",
      {handle: "h2", path: FILE_B, range: "1-2"},
      {handle: "h2", path: FILE_B, range: "3-4"},
    ]);
  });
});

describe("TL_EFF_EVIDENCE_PATH_GROUPS: the emit pipeline", () => {
  const context = (over: Partial<ProtocolCallContext> = {}): ProtocolCallContext => ({tool: "tl_read_file", ...over}) as ProtocolCallContext;
  const evidence = (): Row[] => [row("h1", FILE_A, "1-5"), row("h1", FILE_A, "9-12"), row("h9", FILE_B, "6-28"), row("h9", FILE_B, "30-31")];

  it("ships the grouped reply, measures the bytes that ship, and decides nothing differently", () => {
    const offCtx = context(), onCtx = context();
    const offText = emitFinalizedPayload(pack(evidence()), "read.task_pack", offCtx).content[0]!.text;
    on();
    const onText = emitFinalizedPayload(pack(evidence()), "read.task_pack", onCtx).content[0]!.text;
    const off = JSON.parse(offText) as Row, onReply = JSON.parse(onText) as Row;
    expect(evidenceIsGrouped(onReply)).toBe(true);
    expect(JSON.stringify(expandEvidencePathGroups(onReply))).toBe(JSON.stringify(off));
    expect(onCtx.emittedBytes, "the recorded size is the shipped size").toBe(Buffer.byteLength(onText, "utf8"));
    expect(onCtx.emittedBytes).toBeLessThan(offCtx.emittedBytes!);
    expect(onReply["decision"]).toEqual(off["decision"]);
  });

  it("budgets the bytes that ship: a cap the grouped reply fits but the whole payload does not is met with the flag on", () => {
    const rows = Array.from({length: 14}, (_, index) => row("h1", FILE_A, `${1 + index * 10}-${5 + index * 10}`, {body: `line ${index}\n`.repeat(12)}));
    const build = (): Row => pack(structuredClone(rows), {decision: {kind: "discover", next: {tool: "tl_read_file", arguments: {cursor: "tlc_s1_aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbb"}}}});
    const whole = Buffer.byteLength(JSON.stringify(build()));
    on();
    const grouped = Buffer.byteLength(JSON.stringify(groupEvidencePaths(build())));
    expect(grouped).toBeLessThan(whole - 500);
    const cap = Math.floor((grouped + whole) / 2);
    const emit = (): {ctx: ProtocolCallContext; reply: Row} => {
      const ctx = context();
      const reply = JSON.parse(emitFinalizedPayload(build(), "read.task_pack", ctx, {budgetOverrideBytes: cap}).content[0]!.text) as Row;
      return {ctx, reply};
    };
    const withFlag = emit();
    expect(withFlag.ctx.shedRecords, "nothing is cut to fit a cap the shipped bytes meet").toEqual([]);
    expect(evidenceIsGrouped(withFlag.reply)).toBe(true);
    expect(rowsOf(expandEvidencePathGroups(withFlag.reply)).map(r => r["range"])).toEqual(rows.map(r => r["range"]));
    expect(withFlag.ctx.emittedBytes).toBeLessThanOrEqual(cap);
    delete process.env["TL_EFF_EVIDENCE_PATH_GROUPS"];
    const without = emit();
    // Nothing of this pack can be cut within its required set, so the whole payload (3.2 KB against a 2.7 KB cap) is refused.
    expect([without.reply["kind"], without.reply["code"]], "the same cap refuses the whole payload").toEqual(["refusal", "cap-exceeded"]);
  });

  it("hands the pack-fingerprint binding the text whose rows still carry their own path and handle", () => {
    on();
    let seen = "";
    const ctx = context({finalizePackFingerprintBinding: (text: string) => { seen = text; }} as Partial<ProtocolCallContext>);
    const shipped = emitFinalizedPayload(pack(evidence()), "read.task_pack", ctx).content[0]!.text;
    expect(shipped).toContain("evidence_note");
    expect(seen).not.toContain("evidence_note");
    expect((JSON.parse(seen) as Row & {evidence: Row[]}).evidence.every(r => typeof r["path"] === "string" && typeof r["handle"] === "string")).toBe(true);
  });

  it("binds a delivered pack fingerprint through the real binding, grouped or not", () => {
    on();
    const bodyA = "export const a = 1;\n", bodyB = "export const b = 2;\n", bodyC = "export const c = 3;\n";
    const binding = createPackFingerprintBinding(() => entries, text => `hash:${text}`);
    const entries = [
      {handle: "h1", range: "1-1", hash: `hash:${bodyA}`, taskBinding: undefined as string | undefined},
      {handle: "h1", range: "2-2", hash: `hash:${bodyB}`, taskBinding: undefined as string | undefined},
      {handle: "h1", range: "3-3", hash: `hash:${bodyC}`, taskBinding: undefined as string | undefined},
    ];
    const owner = {}, source = {};
    binding.capture(source, "k", owner, entries, [
      {path: FILE_A, handle: "h1", range: "1-1", code: bodyA}, {path: FILE_A, handle: "h1", range: "2-2", code: bodyB},
      {path: FILE_A, handle: "h1", range: "3-3", code: bodyC},
    ]);
    const finalize = binding.stage(source, "k", owner, "binding", "t")!;
    expect(finalize).toBeTypeOf("function");
    const ctx = context({finalizePackFingerprintBinding: (text: string) => finalize(text, owner) as void} as Partial<ProtocolCallContext>);
    const payload = pack([row("h1", FILE_A, "1-1", {body: bodyA}), row("h1", FILE_A, "2-2", {body: bodyB}), row("h1", FILE_A, "3-3", {body: bodyC})]);
    const shipped = emitFinalizedPayload(payload, "read.task_pack", ctx).content[0]!.text;
    expect(shipped, "the reply that shipped is grouped").toContain("evidence_note");
    expect(entries.map(entry => entry.taskBinding), "all three rows are proven delivered").toEqual(["binding", "binding", "binding"]);
  });
});

describe("TL_EFF_EVIDENCE_PATH_GROUPS: emit measures the bytes that ship after every rewrite (review F8)", () => {
  // `used > limit` is decided after the request continuations, the post-rewrite shrink and the refusal conversions, each
  // of which installs a payload and measures it. Today only a read.task_pack groups and none is a staged read or search
  // request, so those sites measure plain JSON; the wire serializer they all go through makes that true by construction
  // (a task pack that ever stages a request is measured grouped, as the ladder measured it) rather than by which kinds the
  // tools happen to emit. The sites are not reachable with a grouped payload, so the fence reads the source.
  it("re-serializes the payload between the ladder and the final compaction block only through the wire serializer", () => {
    const source = fs.readFileSync(new URL("../protocol/emit.ts", import.meta.url), "utf8");
    const from = source.indexOf("const wireText = (candidate: ShedPayload)");
    const to = source.indexOf("if (context.clientId?.toLowerCase() === \"copilot-cli\") {\n    const compact = omitCoveredFrontierIndex(current);");
    expect(from, "the wire serializer is defined").toBeGreaterThan(0);
    expect(to, "the final compaction block follows").toBeGreaterThan(from);
    const region = source.slice(from, to);
    const plain = [...region.matchAll(/JSON\.stringify\(([^)]*\)?)\)/g)].map(match => match[1]!)
      .filter(argument => argument !== "refusal" && !argument.startsWith("groupEvidencePaths("));
    expect(plain, "no payload is measured by plain JSON.stringify there").toEqual([]);
    expect((region.match(/wireText\(/g) ?? []).length, "the continuations, the shrink and the refusals measure through it").toBeGreaterThanOrEqual(10);
  });

  it("measures a grouped task pack as the wire carries it when a continuation hands it back", () => {
    // The serializer itself: the bytes of the grouped reply, not of the whole payload.
    on();
    const build = (): Row => pack(Array.from({length: 8}, (_, index) => row("h1", FILE_A, `${1 + index * 10}-${5 + index * 10}`, {body: `line ${index}\n`.repeat(8)})));
    const whole = Buffer.byteLength(JSON.stringify(build()));
    const ctx = {tool: "tl_read_file"} as ProtocolCallContext;
    const text = emitFinalizedPayload(build(), "read.task_pack", ctx).content[0]!.text;
    expect(ctx.emittedBytes).toBe(Buffer.byteLength(text));
    expect(ctx.emittedBytes!, "smaller than the whole payload by the repeated addresses").toBeLessThan(whole - 300);
  });
});

describe("TL_EFF_EVIDENCE_PATH_GROUPS: the codec pipeline", () => {
  it("never re-encodes a task pack, so no codec ever meets grouped rows", () => {
    expect(HARD_JSON_FIXED_KINDS.has("read.task_pack")).toBe(true);
    expect(isEligibleKind("read.task_pack")).toBe(false);
    on();
    process.env["TOKENLIGHTEN_RESPONSE_FORMAT"] = "compact";
    try {
      const grouped = groupEvidencePaths(pack([row("h1", FILE_A, "1-5"), row("h1", FILE_A, "9-12"), row("h1", FILE_A, "20-22")]));
      expect(evidenceIsGrouped(grouped)).toBe(true);
      const text = JSON.stringify(grouped);
      expect(applyResponseCodec(text, grouped as never, "read.task_pack", {tool: "tl_read_file"} as ProtocolCallContext, 1_000_000)).toBe(text);
    } finally { delete process.env["TOKENLIGHTEN_RESPONSE_FORMAT"]; }
  });
});

describe("TL_EFF_EVIDENCE_PATH_GROUPS: readers of a reply's text", () => {
  const capsule = (start: number, handle = "h-a"): SourceBodyCapsule => Object.freeze({
    path: FILE_A, sha: "sha256:current", handle, startLine: start, endLine: start, body: `line ${start}\n`,
  });
  const staged = (c: SourceBodyCapsule) => ({capsule: c, taskBinding: "binding-a", body: c.body, range: `${c.startLine}-${c.endLine}`});

  it("finalizes source capsules from a grouped reply as it does from a whole one", () => {
    on();
    const key = "/workspace\0lane:grouped";
    const first = capsule(1), second = capsule(2), third = capsule(3);
    const text = JSON.stringify(groupEvidencePaths(pack([
      row("h-a", FILE_A, "1-1", {body: first.body}), row("h-a", FILE_A, "2-2", {body: second.body}), row("h-a", FILE_A, "3-3", {body: third.body}),
    ], {task: {id: "authenticated", coverage: "partial"}})));
    expect(text).toContain("evidence_note");
    runWithSourceCapsuleCall(() => {
      stageSourceCapsules(key, [staged(first), staged(second), staged(third)]);
      finalizeSourceCapsules(key, text, handle => handle === "authenticated" ? "binding-a" : undefined);
    });
    runWithSourceCapsuleCall(() => {
      expect(sourceCapsulePrior(key).map(entry => entry.capsule.startLine).sort()).toEqual([1, 2, 3]);
    });
  });

  it("merges autofollow replies by whole rows: a grouped row is neither dropped as a repeat nor kept as a twin", async () => {
    const {mergeAutofollowReplies} = await import("../server.js");
    on();
    const firstRows = [row("h-a", FILE_A, "1-5"), row("h-a", FILE_A, "9-12"), row("h-a", FILE_A, "13-14"), row("h-b", FILE_B, "1-3")];
    const secondRows = [row("h-a", FILE_A, "9-12"), row("h-a", FILE_A, "20-22"), row("h-a", FILE_A, "30-31")];
    const whole = (rows: Row[], extra: Row = {}) => pack(rows, extra);
    const expectedMerge = mergeAutofollowReplies(whole(firstRows), whole(secondRows));
    const first = expandEvidencePathGroups(groupEvidencePaths(whole(firstRows)));
    const second = expandEvidencePathGroups(groupEvidencePaths(whole(secondRows)));
    const merged = mergeAutofollowReplies(first, second);
    expect(merged).toEqual(expectedMerge);
    expect(rowsOf(merged!).map(r => `${r["path"]}#${r["range"]}`)).toEqual([
      `${FILE_A}#1-5`, `${FILE_A}#13-14`, `${FILE_B}#1-3`, `${FILE_A}#9-12`, `${FILE_A}#20-22`, `${FILE_A}#30-31`,
    ]);
    // Merging the grouped texts' rows WITHOUT reading them back is the bug this guards: a grouped row's key would be "#9-12".
    const groupedFirst = groupEvidencePaths(whole(firstRows)), groupedSecond = groupEvidencePaths(whole(secondRows));
    expect(evidenceIsGrouped(groupedFirst) && evidenceIsGrouped(groupedSecond), "both replies are grouped").toBe(true);
    const careless = mergeAutofollowReplies(groupedFirst, groupedSecond);
    expect(careless !== undefined && rowsOf(careless).length === 6 && rowsOf(careless).every(r => r["path"] !== undefined)).toBe(false);
  });
});

describe("TL_EFF_EVIDENCE_PATH_GROUPS: the pack builder prices the rows as they ship", () => {
  // Sixty-character lines, as owedRowsFit.spec.ts: the estimate is a function of the rows' bodies, paths and addresses.
  const lines = Array.from({length: 4000}, (_, i) => `        total += compute${i}(order) + ${"x".repeat(26)};`);
  const window = (start: number, count: number): {start: number; end: number} => ({start, end: start + count - 1});
  const owedOf = (count: number): Array<{start: number; end: number}> => Array.from({length: count}, (_, i) => window(1 + i * 60, 6));
  const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
  const FILE = "src/Big.java";
  /** The smallest cap `owedRowsFitOnePage` answers true for: the estimate plus its headroom, to the byte. */
  const minCap = (owed: Array<{start: number; end: number}>): number => {
    let low = 0, high = 4_000_000;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (owedRowsFitOnePage(FILE, lines, owed, middle)) high = middle; else low = middle;
    }
    return high;
  };

  it("an owed row after the first no longer pays its path: the cap that holds n rows falls by (n - 1) quoted paths with their key", () => {
    for (const count of [2, 3, 12]) {
      delete process.env["TL_EFF_EVIDENCE_PATH_GROUPS"];
      const off = minCap(owedOf(count));
      on();
      const grouped = minCap(owedOf(count));
      // `"path":` and its comma are 8 B beside the quoted path.
      expect(off - grouped, `${count} rows`).toBe((count - 1) * (jsonBytes(FILE) + 8));
    }
  });

  it("prices one row, and no rows, exactly as it did", () => {
    delete process.env["TL_EFF_EVIDENCE_PATH_GROUPS"];
    const off = minCap(owedOf(1));
    on();
    expect(minCap(owedOf(1))).toBe(off);
    expect(owedRowsFitOnePage(FILE, lines, [], 4096)).toBe(true);
  });

  it("is the identity with the flag off: the cap is the one the rows always had", () => {
    delete process.env["TL_EFF_EVIDENCE_PATH_GROUPS"];
    expect(minCap(owedOf(12))).toBeGreaterThan(0);
    process.env["TL_EFF_EVIDENCE_PATH_GROUPS"] = "0";
    expect(minCap(owedOf(12))).toBe(minCap(owedOf(12)));
  });

  describe("the task-pack size preview", () => {
    const dirs: string[] = [];
    afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, {recursive: true, force: true}); });

    /** An answer pack whose three surfaces are three windows of one long-named file, a handle each. */
    function pack(): TaskPackResult {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-path-groups-preview-")));
      dirs.push(root);
      const file = "backend/src/main/java/com/shopflow/service/OrderOrchestrator.java";
      fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
      const source = Array.from({length: 40}, (_, i) => `const x${i} = ${i};`).join("\n") + "\n";
      fs.writeFileSync(path.join(root, file), source);
      const surface = (range: string, start: number, end: number) => ({
        handle: handleTable.upsert({kind: "range", path: file, range, workspaceRoot: root}).id,
        path: file, range, role: "unknown", code: source.split("\n").slice(start - 1, end).join("\n"), required: true,
      });
      return {task_profile: "answer", coverage: "complete", missing: [], surfaces: [surface("1-3", 1, 3), surface("10-12", 10, 12), surface("20-22", 20, 22)]} as unknown as TaskPackResult;
    }

    it("counts the grouped rows: smaller than the whole rows by what they leave off, net of the note", () => {
      const result = pack();
      delete process.env["TL_EFF_EVIDENCE_PATH_GROUPS"];
      const off = taskPackSizePreview(result, "copilot-cli");
      on();
      const grouped = taskPackSizePreview(result, "copilot-cli");
      expect(off).toBeGreaterThan(0);
      expect(grouped).toBeGreaterThan(0);
      const file = "backend/src/main/java/com/shopflow/service/OrderOrchestrator.java";
      // The second and third rows leave off their path (quoted, with `"path":` and a comma) and keep their own handles; the note is added once.
      const saved = 2 * (jsonBytes(file) + 8);
      const note = jsonBytes(EVIDENCE_PATH_GROUP_NOTE) + `"evidence_note":,`.length;
      expect(off! - grouped!).toBe(saved - note);
      expect(off! - grouped!).toBeGreaterThanOrEqual(EVIDENCE_PATH_GROUP_MIN_NET_SAVING_BYTES);
    });

    it("leaves the preview as it was with the flag off", () => {
      const result = pack();
      delete process.env["TL_EFF_EVIDENCE_PATH_GROUPS"];
      const off = taskPackSizePreview(result, "copilot-cli");
      process.env["TL_EFF_EVIDENCE_PATH_GROUPS"] = "0";
      expect(taskPackSizePreview(result, "copilot-cli")).toBe(off);
    });
  });
});
