// autofollowRules.spec.ts — the two pure halves of server.ts's
// `autofollowDiscoverPack` (TL_EFF_AUTOFOLLOW), in-process.
//
// `autofollowSkipReason`: which discover packs are followed at all. Only the
// T03 shape (2026-10-19 rules): exactly one executable tl_read_file `next`
// that re-issues the caller's OWN query, no `ambiguous-target` gap (a pick
// among candidates is the agent's call), no new epoch, no `plan` on the
// discover pack (a plan member the follow-up could contradict would force a
// discard after the follow-up was booked), and, since the default flip
// (2026-10-19), no byte ceiling: two packs in one reply would overrun the
// ceiling each was built under.
//
// `mergeAutofollowReplies`: every byte the follow-up served reaches the
// client. A task-pack follow-up merges as before, with the discover pack's own
// gaps in `auto_followed.gaps` (2026-10-19: its decision replaces the
// discover's, so they had nowhere else to go); a follow-up answered as a
// plain read (read.text / read.batch) is delivered as rows after the discover
// pack's own; a follow-up that served nothing (a receipt) merges to nothing,
// and the caller returns the discover reply. The real-server proofs (T03,
// T09 rep1, T10 rep2) are in rc/autofollowDiscover.rc.spec.ts.
//
// The chain (2026-10-19, after decision run 6t-6). A follow-up that is itself
// a discover pack is followed again only when its one `next` reads more
// windows of files the reply already serves, under the same task and the
// request's own query (`autofollowContinuationSkipReason`), and only while an
// upper bound on the reply, taken before that read runs, stays within the cap
// (`autofollowContinuationEstimate`): a read that ran is booked, so it is
// delivered whatever its size. `extendAutofollowChain` names the chain in
// `auto_followed` (`hops`, and every discover pack's own gaps).
import { describe, expect, it } from "vitest";

const QUERY = "Explain how OrderOrchestrator calls payment, inventory and shipping.";
/** 6t-7 T07 rep0's After-task report (replay corpus v016qf1): util/queryFocus.ts sets it aside. */
const AFTER_TASK_REPORT = "\n\n## After-task report\n\nAfter completing your work, run `git diff --name-only` and report the list as changed_files.";

function discover(fields: Record<string, unknown> = {}, next: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    kind: "read.task_pack",
    task: { id: "tlh_task_v1_x" },
    evidence: [{ handle: "hhead", path: "src/O.java", range: "1-40", body: "head" }],
    decision: {
      kind: "discover",
      next: {
        tool: "tl_read_file",
        arguments: { query: QUERY, targets: [{ path: "src/O.java", range: "41-80" }], content: "auto", task: { handle: "tlh_task_v1_x" }, ...next },
      },
      gaps: [{ code: "missing-evidence", refs: ["request-item:facet-1:flow"] }],
    },
    ...fields,
  };
}

describe("autofollowSkipReason: only the T03 shape is followed", () => {
  it("follows a discover whose one tl_read_file next re-issues the caller's own query", async () => {
    const { autofollowSkipReason } = await import("../server.js");
    expect(autofollowSkipReason(discover(), { query: QUERY, task: "{\"epoch\":\"new\"}" })).toBeUndefined();
  });

  it("follows a next that restates, as the pack builder read it, a query whose line breaks came as literal escapes (6t-7 T03 rep0 #4)", async () => {
    const { autofollowSkipReason } = await import("../server.js");
    const read = `${QUERY}\nKeep it under 50 lines.\nUse one table.`;
    const sent = read.split("\n").join(`${String.fromCharCode(92)}n`);
    expect(sent).not.toContain("\n");
    expect(autofollowSkipReason(discover({}, { query: read }), { query: sent })).toBeUndefined();
    // A query that also has a real line break is read as sent: the same next is another request.
    expect(autofollowSkipReason(discover({}, { query: read }), { query: `${sent}\nAnd the refunds.` })).toBe("next-is-not-the-request");
    // So is a lone escape (util/queryEscapes.ts: as likely a Windows path as a line break).
    const once = `${QUERY}\nKeep it under 50 lines.`;
    expect(autofollowSkipReason(discover({}, { query: once }), { query: once.split("\n").join(`${String.fromCharCode(92)}n`) })).toBe("next-is-not-the-request");
  });

  it("follows a next that restates the request without the process sections the pack builder set aside (util/queryFocus.ts; replay corpus v016fq1)", async () => {
    const { autofollowSkipReason } = await import("../server.js");
    // The pack builder reads the request alone, and its discover's next restates that.
    expect(autofollowSkipReason(discover(), { query: `${QUERY}${AFTER_TASK_REPORT}` })).toBeUndefined();
    // With its line breaks as literal escapes too: read as line breaks, then focused.
    const escaped = `${QUERY}${AFTER_TASK_REPORT}`.split("\n").join(`${String.fromCharCode(92)}n`);
    expect(autofollowSkipReason(discover(), { query: escaped })).toBeUndefined();
    // A section the pack builder keeps ("Notes" carries requests) is part of the request.
    expect(autofollowSkipReason(discover(), { query: `${QUERY}\n\n## Notes\n\nAlso list the refund calls.` })).toBe("next-is-not-the-request");
  });

  it("declines a next that is not a re-pack of the request: no query, another query, or no request query", async () => {
    const { autofollowSkipReason } = await import("../server.js");
    // T09 rep1 #3 / T10 rep2 #6 (6t-3): a plain targets read of one window.
    const plainRead = discover({}, { query: undefined });
    expect(autofollowSkipReason(plainRead, { targets: [{ path: "src/O.java" }] })).toBe("next-is-not-the-request");
    expect(autofollowSkipReason(discover(), { query: `${QUERY} (and the refunds)` })).toBe("next-is-not-the-request");
    expect(autofollowSkipReason(discover(), { targets: [{ path: "src/O.java" }] })).toBe("next-is-not-the-request");
  });

  it("declines a discover whose gaps include ambiguous-target (6t-2 T13 rep0 #9)", async () => {
    const { autofollowSkipReason } = await import("../server.js");
    const ambiguous = discover();
    (ambiguous["decision"] as Record<string, unknown>)["gaps"] = [{ code: "ambiguous-target", refs: ["identifier:IMU"] }];
    expect(autofollowSkipReason(ambiguous, { query: QUERY })).toBe("ambiguous-target");
  });

  it("declines anything but a discover pack with one executable read next", async () => {
    const { autofollowSkipReason } = await import("../server.js");
    expect(autofollowSkipReason({ ...discover(), kind: "read.text" }, { query: QUERY })).toBe("not-a-discover-pack");
    const act = discover();
    (act["decision"] as Record<string, unknown>)["kind"] = "act.answer";
    expect(autofollowSkipReason(act, { query: QUERY })).toBe("not-a-discover-pack");
    const find = discover();
    ((find["decision"] as Record<string, unknown>)["next"] as Record<string, unknown>)["tool"] = "tl_search_files";
    expect(autofollowSkipReason(find, { query: QUERY })).toBe("next-is-not-a-read");
    const many = discover();
    (many["decision"] as Record<string, unknown>)["next"] = [
      (many["decision"] as Record<string, unknown>)["next"],
      (many["decision"] as Record<string, unknown>)["next"],
    ];
    expect(autofollowSkipReason(many, { query: QUERY })).toBe("next-is-not-a-read");
  });

  it("declines a next that starts a new epoch, and a discover pack that carries a plan", async () => {
    const { autofollowSkipReason } = await import("../server.js");
    expect(autofollowSkipReason(discover({}, { task: { epoch: "new" } }), { query: QUERY })).toBe("new-epoch");
    // 6t-2 T13 rep0 #18 / #20: same-query nexts on packs carrying plan.verification.
    expect(autofollowSkipReason(discover({ plan: { verification: { status: "available" } } }), { query: QUERY })).toBe("plan");
  });

  it("declines a pack built under a byte ceiling: the request's own budget, or the default the caller resolved", async () => {
    const { autofollowSkipReason } = await import("../server.js");
    // evaluation0929.ceilingFallbackHonesty.spec.ts: merged, two packs built
    // under a 14,336 B budget came back as 17,421 B and 21,135 B.
    expect(autofollowSkipReason(discover(), { query: QUERY, budget: { bytes: 14336 } })).toBe("byte-ceiling");
    expect(autofollowSkipReason(discover(), { query: QUERY, budget: "{\"tokens\":4000}" })).toBe("byte-ceiling");
    expect(autofollowSkipReason(discover(), { query: QUERY, maxBytes: 8192 })).toBe("byte-ceiling");
    // The env/client-profile default (VS Code's 14,336 B), resolved by the caller.
    expect(autofollowSkipReason(discover(), { query: QUERY }, 14336)).toBe("byte-ceiling");
    // No ceiling anywhere (Claude Code's default), or a budget naming none: followed.
    expect(autofollowSkipReason(discover(), { query: QUERY, budget: {} }, undefined)).toBeUndefined();
    expect(autofollowSkipReason(discover(), { query: QUERY, budget: { bytes: 0 } })).toBeUndefined();
  });
});

describe("mergeAutofollowReplies: every byte the follow-up served reaches the client", () => {
  it("a task-pack follow-up: its pack, led by the discover rows it does not repeat", async () => {
    const { mergeAutofollowReplies } = await import("../server.js");
    const second = {
      v: 1,
      kind: "read.task_pack",
      evidence: [{ handle: "hnext", path: "src/O.java", range: "41-80", body: "next" }],
      decision: { kind: "act.answer", certificate: { id: "ready-x" } },
    };
    const merged = mergeAutofollowReplies(discover(), second)!;
    expect(merged["kind"]).toBe("read.task_pack");
    expect((merged["decision"] as Record<string, unknown>)["kind"]).toBe("act.answer");
    expect((merged["evidence"] as Array<Record<string, unknown>>).map((row) => row["range"])).toEqual(["1-40", "41-80"]);
    // The act.answer decision has no gaps member: the discover pack's own ride
    // auto_followed, so what it disclosed before its next ran still reaches
    // the client (requestItemCompletion.spec.ts, finding 2).
    expect(merged["auto_followed"]).toEqual({
      from: "discover",
      note: expect.stringContaining("gaps are the discover pack's own"),
      gaps: [{ code: "missing-evidence", refs: ["request-item:facet-1:flow"] }],
    });
  });

  it("a task-pack follow-up keeps the discover pack's server_build and answer_resolution unless it restates them", async () => {
    const { mergeAutofollowReplies } = await import("../server.js");
    const resolution = { strategy: "semantic-responsibility", requested_identifier: "OrderOrchestrator", resolved_handle: "hhead" };
    const first = discover({ server_build: "build-1", answer_resolution: resolution, limit: { cause: "capped" } });
    const second = { v: 1, kind: "read.task_pack", evidence: [], decision: { kind: "act.answer" }, qref: "q-2" };
    const merged = mergeAutofollowReplies(first, second)!;
    // The first reply of a session announces the build; the merged reply is it.
    expect(merged["server_build"]).toBe("build-1");
    expect(merged["answer_resolution"]).toEqual(resolution);
    // The discover's own cap is the follow-up's to state now.
    expect(merged["limit"]).toBeUndefined();
    expect(merged["qref"]).toBe("q-2");
    const restated = mergeAutofollowReplies(first, { ...second, answer_resolution: { requested_identifier: "Other" } })!;
    expect(restated["answer_resolution"]).toEqual({ requested_identifier: "Other" });
  });

  it("a task-pack follow-up of a discover pack without gaps adds none", async () => {
    const { mergeAutofollowReplies } = await import("../server.js");
    const first = discover();
    delete (first["decision"] as Record<string, unknown>)["gaps"];
    const merged = mergeAutofollowReplies(first, { v: 1, kind: "read.task_pack", evidence: [], decision: { kind: "act.answer" } })!;
    expect(merged["auto_followed"]).toEqual({
      from: "discover",
      note: "the discover pack's next ran server-side; evidence[] leads with the discover pack's own items",
    });
  });

  it("a follow-up answered as read.text: its body rows follow the discover pack's own", async () => {
    const { mergeAutofollowReplies } = await import("../server.js");
    const second = {
      v: 1,
      kind: "read.text",
      evidence: [
        { handle: "hnext", path: "src/O.java", range: "41-60", body: "a", elided: ["50-52"] },
        { handle: "hnext", path: "src/O.java", range: "61-80", prior: "hnext — already served this session" },
      ],
      limit: { cause: "capped" },
    };
    const merged = mergeAutofollowReplies(discover(), second)!;
    expect((merged["decision"] as Record<string, unknown>)["kind"]).toBe("discover");
    const rows = merged["evidence"] as Array<Record<string, unknown>>;
    expect(rows.map((row) => row["range"])).toEqual(["1-40", "41-60"]);
    expect(rows[1]).toEqual({ handle: "hnext", path: "src/O.java", range: "41-60", body: "a", elided: ["50-52"] });
    expect(merged["auto_followed"]).toBeDefined();
    // The discover decision stays, its gaps with it: nothing rides auto_followed.
    expect((merged["decision"] as Record<string, unknown>)["gaps"]).toEqual([{ code: "missing-evidence", refs: ["request-item:facet-1:flow"] }]);
    expect((merged["auto_followed"] as Record<string, unknown>)["gaps"]).toBeUndefined();
  });

  it("a follow-up answered as read.batch: each entry that carries content becomes a row", async () => {
    const { mergeAutofollowReplies } = await import("../server.js");
    const second = {
      v: 1,
      kind: "read.batch",
      entries: [
        { form: "range", path: "src/O.java", range: "41-80", handle: "hnext", content: "b", sha: "sha256:1" },
        { form: "file-downgraded", reason: "already-served", path: "src/O.java", range: "1-40", handle: "hhead", code_unchanged: true },
      ],
    };
    const merged = mergeAutofollowReplies(discover(), second)!;
    const rows = merged["evidence"] as Array<Record<string, unknown>>;
    expect(rows.map((row) => row["range"])).toEqual(["1-40", "41-80"]);
    expect(rows[1]).toEqual({ handle: "hnext", path: "src/O.java", range: "41-80", body: "b" });
  });

  it("a follow-up that served nothing (a receipt) merges to nothing: the discover reply stands", async () => {
    const { mergeAutofollowReplies } = await import("../server.js");
    expect(mergeAutofollowReplies(discover(), { v: 1, kind: "read.receipt", receipt: { receipt: "pack-unchanged" } })).toBeUndefined();
    expect(mergeAutofollowReplies(discover(), { v: 1, kind: "read.batch", entries: [{ reason: "already-served", path: "src/O.java", range: "1-40" }] })).toBeUndefined();
  });
});

/** A merged first reply as the T03 chain leaves it: a discover whose one next reads more windows of src/O.java. */
function merged(fields: Record<string, unknown> = {}, next: Record<string, unknown> = {}): Record<string, unknown> {
  return discover({
    auto_followed: {
      from: "discover",
      note: "the discover pack's next ran server-side; evidence[] leads with the discover pack's own items; gaps are the discover pack's own, from before its next ran",
      gaps: [{ code: "request-item-undetermined", refs: ["ri-6"] }],
    },
    ...fields,
  }, { cwd: "/ws", ...next });
}

/** T03's first call as 6t-6 rep0 sent it (the workspace aside). */
const REQUEST = { query: QUERY, task: "{\"epoch\":\"new\",\"profile\":\"answer\"}", cwd: "/ws" };

describe("autofollowContinuationSkipReason: a later follow-up only reads more windows of the files the reply serves", () => {
  it("follows the T03 continuation: the request's own query, the same task, windows of a file the reply serves", async () => {
    const { autofollowContinuationSkipReason } = await import("../server.js");
    expect(autofollowContinuationSkipReason(merged(), REQUEST)).toBeUndefined();
  });

  it("follows the continuation of a request whose process sections the pack builder set aside", async () => {
    const { autofollowContinuationSkipReason } = await import("../server.js");
    expect(autofollowContinuationSkipReason(merged(), { ...REQUEST, query: `${QUERY}${AFTER_TASK_REPORT}` })).toBeUndefined();
  });

  it("keeps every rule of the first follow-up", async () => {
    const { autofollowContinuationSkipReason } = await import("../server.js");
    expect(autofollowContinuationSkipReason(merged({ plan: { verification: { status: "available" } } }), REQUEST)).toBe("plan");
    expect(autofollowContinuationSkipReason(merged({}, { query: `${QUERY} (and the refunds)` }), REQUEST)).toBe("next-is-not-the-request");
    expect(autofollowContinuationSkipReason(merged({}, { task: { handle: "tlh_task_v1_x", epoch: "new" } }), REQUEST)).toBe("new-epoch");
    expect(autofollowContinuationSkipReason(merged(), { ...REQUEST, budget: { bytes: 14336 } })).toBe("byte-ceiling");
    expect(autofollowContinuationSkipReason(merged(), REQUEST, 14336)).toBe("byte-ceiling");
    const ambiguous = merged();
    (ambiguous["decision"] as Record<string, unknown>)["gaps"] = [{ code: "ambiguous-target", refs: ["identifier:Order"] }];
    expect(autofollowContinuationSkipReason(ambiguous, REQUEST)).toBe("ambiguous-target");
    const act = merged();
    (act["decision"] as Record<string, unknown>)["kind"] = "act.answer";
    expect(autofollowContinuationSkipReason(act, REQUEST)).toBe("not-a-discover-pack");
  });

  it("declines a next that is not a read of windows: a re-pack, a target by handle or symbol or without a range, another content mode, any other argument", async () => {
    const { autofollowContinuationSkipReason } = await import("../server.js");
    expect(autofollowContinuationSkipReason(merged({}, { targets: undefined }), REQUEST)).toBe("not-a-window-read");
    expect(autofollowContinuationSkipReason(merged({}, { targets: [] }), REQUEST)).toBe("not-a-window-read");
    expect(autofollowContinuationSkipReason(merged({}, { targets: [{ handle: "hhead" }] }), REQUEST)).toBe("not-a-window-read");
    expect(autofollowContinuationSkipReason(merged({}, { targets: [{ path: "src/O.java", symbol: "place" }] }), REQUEST)).toBe("not-a-window-read");
    expect(autofollowContinuationSkipReason(merged({}, { targets: [{ path: "src/O.java" }] }), REQUEST)).toBe("not-a-window-read");
    expect(autofollowContinuationSkipReason(merged({}, { targets: [{ path: "src/O.java", range: "41-80", handle: "hhead" }] }), REQUEST)).toBe("not-a-window-read");
    expect(autofollowContinuationSkipReason(merged({}, { targets: [{ path: "src/O.java", range: "80-41" }] }), REQUEST)).toBe("not-a-window-read");
    expect(autofollowContinuationSkipReason(merged({}, { content: "full" }), REQUEST)).toBe("not-a-window-read");
    expect(autofollowContinuationSkipReason(merged({}, { budget: { bytes: 99999 } }), REQUEST)).toBe("not-a-window-read");
    expect(autofollowContinuationSkipReason(merged({}, { select: { comments: "keep" } }), REQUEST)).toBe("not-a-window-read");
  });

  it("declines windows of a file the reply does not serve, and a next under another task", async () => {
    const { autofollowContinuationSkipReason } = await import("../server.js");
    expect(autofollowContinuationSkipReason(merged({}, { targets: [{ path: "src/Other.java", range: "1-40" }] }), REQUEST)).toBe("file-not-in-pack");
    // A bodyless row names a file without serving it.
    const named = merged({ evidence: [{ handle: "hhead", path: "src/O.java", range: "1-40" }] });
    expect(autofollowContinuationSkipReason(named, REQUEST)).toBe("file-not-in-pack");
    expect(autofollowContinuationSkipReason(merged({}, { task: { handle: "tlh_task_v1_other" } }), REQUEST)).toBe("another-task");
    expect(autofollowContinuationSkipReason(merged({ task: {} }), REQUEST)).toBe("another-task");
  });
});

describe("autofollowContinuationEstimate: an upper bound on the reply, taken before the read runs", () => {
  const LINES = ["class O {", "  String s = \"a\";", "  int n;", "}"];

  it("is the reply as it stands, each window's JSON-escaped source lines with a row allowance, and an envelope allowance", async () => {
    const { autofollowContinuationEstimate, AUTOFOLLOW_ROW_ALLOWANCE_BYTES, AUTOFOLLOW_ENVELOPE_ALLOWANCE_BYTES } = await import("../server.js");
    const reply = merged();
    const replyBytes = Buffer.byteLength(JSON.stringify(reply), "utf8");
    // Lines 2-3 as one JSON string: 26 characters, 2 quotes around them, and
    // three escapes (two quotes and the newline): 31 bytes.
    const one = autofollowContinuationEstimate(reply, [{ path: "src/O.java", range: "2-3" }], () => LINES);
    expect(one).toBe(replyBytes + AUTOFOLLOW_ENVELOPE_ALLOWANCE_BYTES + 31 + AUTOFOLLOW_ROW_ALLOWANCE_BYTES);
    // A second window adds its own lines ("}" as a JSON string: 3 bytes) and one row allowance.
    const two = autofollowContinuationEstimate(reply, [{ path: "src/O.java", range: "2-3" }, { path: "src/O.java", range: "4-4" }], () => LINES);
    expect(two! - one!).toBe(3 + AUTOFOLLOW_ROW_ALLOWANCE_BYTES);
    // Multi-byte text counts as the bytes it is on the wire.
    const wide = autofollowContinuationEstimate(reply, [{ path: "src/O.java", range: "1-1" }], () => ["注文"]);
    expect(wide).toBe(replyBytes + AUTOFOLLOW_ENVELOPE_ALLOWANCE_BYTES + 8 + AUTOFOLLOW_ROW_ALLOWANCE_BYTES);
  });

  it("estimates nothing, so nothing is followed, for a file it cannot read or a window outside it", async () => {
    const { autofollowContinuationEstimate } = await import("../server.js");
    expect(autofollowContinuationEstimate(merged(), [{ path: "src/O.java", range: "2-3" }], () => undefined)).toBeUndefined();
    for (const range of ["3-9", "0-2", "3-2", "2"]) {
      expect(autofollowContinuationEstimate(merged(), [{ path: "src/O.java", range }], () => LINES), range).toBeUndefined();
    }
  });
});

describe("extendAutofollowChain: auto_followed names the chain", () => {
  const followUp = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({
    v: 1,
    kind: "read.task_pack",
    task: { id: "tlh_task_v1_x" },
    evidence: [{ handle: "hnext", path: "src/O.java", range: "41-80", body: "next" }],
    decision: { kind: "act.answer" },
    ...fields,
  });

  it("counts the follow-ups in hops and keeps each discover pack's own gaps, in order, once", async () => {
    const { extendAutofollowChain } = await import("../server.js");
    const chained = extendAutofollowChain(merged(), followUp(), 2)!;
    expect((chained["decision"] as Record<string, unknown>)["kind"]).toBe("act.answer");
    expect((chained["evidence"] as Array<Record<string, unknown>>).map((row) => row["range"])).toEqual(["1-40", "41-80"]);
    // The first discover pack's gaps (already on auto_followed), then the
    // gaps of the discover pack whose next this follow-up was.
    expect(chained["auto_followed"]).toEqual({
      from: "discover",
      hops: 2,
      note: expect.stringContaining("nexts ran server-side"),
      gaps: [
        { code: "request-item-undetermined", refs: ["ri-6"] },
        { code: "missing-evidence", refs: ["request-item:facet-1:flow"] },
      ],
    });
    // A gap both packs disclosed is listed once.
    const repeated = merged({
      auto_followed: { from: "discover", hops: 2, note: "chain", gaps: [{ code: "missing-evidence", refs: ["request-item:facet-1:flow"] }] },
    });
    const again = extendAutofollowChain(repeated, followUp(), 3)!;
    expect(again["auto_followed"]).toMatchObject({ hops: 3, gaps: [{ code: "missing-evidence", refs: ["request-item:facet-1:flow"] }] });
  });

  it("keeps the reply's carried members, and a follow-up that served nothing extends nothing", async () => {
    const { extendAutofollowChain } = await import("../server.js");
    const reply = merged({ server_build: "build-1", answer_resolution: { requested_identifier: "OrderOrchestrator" } });
    const chained = extendAutofollowChain(reply, followUp(), 2)!;
    expect(chained["server_build"]).toBe("build-1");
    expect(chained["answer_resolution"]).toEqual({ requested_identifier: "OrderOrchestrator" });
    expect(extendAutofollowChain(reply, { v: 1, kind: "read.receipt", receipt: { receipt: "pack-unchanged" } }, 2)).toBeUndefined();
  });
});
