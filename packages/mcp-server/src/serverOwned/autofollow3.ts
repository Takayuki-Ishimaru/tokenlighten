// autofollow — extracted implementation; imports point to the owning modules.
import { EPOCH_REPEAT_ADVISORY } from "../state/session.js";
import { activeRoot } from "../runtime/config.js";
import { appendAdvisoryLine } from "../features/task-pack/structureMapElsewhere.js";
import { mergeAutofollowPlans } from "./autofollow4.js";
import { packBuilderQuery } from "./autofollow4.js";
import { readFileSafe } from "../util/safePath.js";
import { resolveCallerByteCeiling } from "../tools/readCodeModes.js";
import { resolveWorkspaceRoot } from "./read-admission2.js";
import { structureMapElsewhereLineIn } from "../features/task-pack/structureMapElsewhere.js";

/**
 * Why `autofollowDiscoverPack` leaves `firstPack` as it is, or `undefined`
 * when it follows it: only a `discover` with ONE executable tl_read_file
 * `next` that re-issues the caller's own `query` as the pack builder read it
 * (`packBuilderQuery`; the T03 shape), no `ambiguous-target` gap (a pick
 * among candidates is the agent's call), no new epoch, no `plan` on the
 * discover pack (a plan member the follow-up could contradict would leave a
 * booked follow-up nowhere to go), and no byte ceiling: neither the request's
 * own `budget` (or the legacy `maxBytes`/`maxTokens`) nor
 * `defaultByteCeiling`, the env/client-profile default the caller resolved
 * (one reply holding two packs would overrun the ceiling each was built
 * under).
 */
export function autofollowSkipReason(
  firstPack: Record<string, unknown>,
  requestArgs: Record<string, unknown>,
  defaultByteCeiling?: number,
): string | undefined {
  const asRecord = (value: unknown): Record<string, unknown> | undefined => {
    if (typeof value === "string") {
      try { value = JSON.parse(value); } catch { return undefined; }
    }
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  };
  const decision = asRecord(firstPack["decision"]);
  if (firstPack["kind"] !== "read.task_pack" || decision?.["kind"] !== "discover") return "not-a-discover-pack";
  const gaps = Array.isArray(decision["gaps"]) ? (decision["gaps"] as unknown[]) : [];
  if (gaps.some((gap) => asRecord(gap)?.["code"] === "ambiguous-target")) return "ambiguous-target";
  const next = Array.isArray(decision["next"]) ? undefined : asRecord(decision["next"]);
  const nextArgs = Array.isArray(next?.["arguments"]) ? undefined : asRecord(next?.["arguments"]);
  if (next === undefined || next["tool"] !== "tl_read_file" || nextArgs === undefined) return "next-is-not-a-read";
  // The caller's query as the pack builder read it (`packBuilderQuery`), as
  // the pack's next restates it: its literal `\n` escapes read as line breaks
  // (6t-7 T03 rep0 #4), its process sections set aside (replay corpus
  // v016fq1).
  const requestQuery = requestArgs["query"];
  if (typeof requestQuery !== "string" || requestQuery === "" || nextArgs["query"] !== packBuilderQuery(requestQuery)) return "next-is-not-the-request";
  if (asRecord(nextArgs["task"])?.["epoch"] !== undefined) return "new-epoch";
  if (firstPack["plan"] !== undefined) return "plan";
  const positive = (value: unknown): number | undefined => {
    const n = typeof value === "string" && /^[0-9]+$/.test(value.trim()) ? Number(value) : value;
    return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const budget = asRecord(requestArgs["budget"]);
  const ceiling = resolveCallerByteCeiling(
    positive(budget?.["bytes"] ?? requestArgs["maxBytes"]),
    positive(budget?.["tokens"] ?? requestArgs["maxTokens"]),
    defaultByteCeiling,
  );
  if (ceiling !== undefined) return "byte-ceiling";
  return undefined;
}

/**
 * The ONE reply that carries every byte the discover pack and its follow-up
 * served, or `undefined` when the follow-up served none (a receipt, a
 * refusal, an already-served batch) and the discover reply stands as it was.
 * A task-pack follow-up is the reply, led by the discover pack's rows it does
 * not repeat, with the discover pack's own `decision.gaps` in
 * `auto_followed.gaps` (the follow-up's decision replaces the discover's, and
 * an `act.*` decision has no member to carry them) and the discover pack's
 * AUTOFOLLOW_CARRIED_MEMBERS the follow-up does not restate. Any other
 * follow-up (a plain read: `read.text` evidence with a
 * `body`, `read.batch` entries with `content`) rides as rows after the
 * discover pack's own, the decision and its `next` unchanged: run again, that
 * `next` is answered as already served, which is now true.
 */
export function mergeAutofollowReplies(firstPack: Record<string, unknown>, second: Record<string, unknown>): Record<string, unknown> | undefined {
  const rowsOf = (value: unknown): Array<Record<string, unknown>> =>
    (Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => row !== null && typeof row === "object" && !Array.isArray(row)) : []);
  const firstRows = rowsOf(firstPack["evidence"]);
  if (second["kind"] === "read.task_pack") {
    const addressOf = (row: Record<string, unknown>): string =>
      `${String(row["handle"] ?? row["path"] ?? "")}#${String(row["range"] ?? "")}`;
    const secondRows = rowsOf(second["evidence"]);
    const repeated = new Set(secondRows.filter((row) => row["body"] !== undefined).map(addressOf));
    // `autofollowSkipReason` follows no discover pack that carries a plan,
    // so the two plans cannot disagree; the follow-up's stands.
    const plan = mergeAutofollowPlans(firstPack["plan"], second["plan"]) ?? second["plan"];
    const firstDecision = firstPack["decision"];
    const firstGaps = firstDecision !== null && typeof firstDecision === "object" && !Array.isArray(firstDecision)
      ? rowsOf((firstDecision as Record<string, unknown>)["gaps"])
      : [];
    const carried: Record<string, unknown> = {};
    for (const key of AUTOFOLLOW_CARRIED_MEMBERS) {
      if (firstPack[key] !== undefined && second[key] === undefined) carried[key] = firstPack[key];
    }
    // Two lines of the discover pack's `advisory` are kept: the structure map's note on a type's
    // members in other files (structureMapElsewhere.ts), which belongs to the pack that served the
    // map and would go with it, and the epoch-repeat advisory (state/session.ts), which is about
    // the CALL: the discover pack took it when it was built, and the follow-up has none to take
    // (replay corpus v016t5). Any other advisory goes with its pack, as it always has.
    const firstAdvisory = typeof firstPack["advisory"] === "string" ? firstPack["advisory"] : undefined;
    const ownAdvisory = typeof second["advisory"] === "string" ? second["advisory"] : undefined;
    let advisory = ownAdvisory;
    const mapNote = firstAdvisory !== undefined ? structureMapElsewhereLineIn(firstAdvisory) : undefined;
    if (mapNote !== undefined && (advisory === undefined || structureMapElsewhereLineIn(advisory) === undefined)) advisory = appendAdvisoryLine(advisory, mapNote);
    if (firstAdvisory?.includes(EPOCH_REPEAT_ADVISORY) === true && advisory?.includes(EPOCH_REPEAT_ADVISORY) !== true) advisory = appendAdvisoryLine(advisory, EPOCH_REPEAT_ADVISORY);
    if (advisory !== ownAdvisory) carried["advisory"] = advisory;
    return {
      ...second,
      ...(plan !== undefined ? { plan } : {}),
      ...carried,
      evidence: [...firstRows.filter((row) => !repeated.has(addressOf(row))), ...secondRows],
      auto_followed: {
        from: "discover",
        note: firstGaps.length > 0
          ? "the discover pack's next ran server-side; evidence[] leads with the discover pack's own items; gaps are the discover pack's own, from before its next ran"
          : "the discover pack's next ran server-side; evidence[] leads with the discover pack's own items",
        ...(firstGaps.length > 0 ? { gaps: firstGaps } : {}),
      },
    };
  }
  const served = [
    ...rowsOf(second["evidence"]).filter((row) => typeof row["body"] === "string" && row["body"] !== ""),
    ...rowsOf(second["entries"])
      .filter((entry) => typeof entry["content"] === "string" && entry["content"] !== "")
      .map((entry) => ({
        ...(typeof entry["handle"] === "string" ? { handle: entry["handle"] } : {}),
        ...(typeof entry["path"] === "string" ? { path: entry["path"] } : {}),
        ...(typeof entry["range"] === "string" ? { range: entry["range"] } : {}),
        body: entry["content"],
        ...(Array.isArray(entry["elided"]) ? { elided: entry["elided"] } : {}),
      })),
  ];
  if (served.length === 0) return undefined;
  return {
    ...firstPack,
    evidence: [...firstRows, ...served],
    auto_followed: {
      from: "discover",
      note: "the discover pack's next ran server-side as a read; its served rows follow the discover pack's own items",
    },
  };
}

/**
 * Top-level members only the discover pack carries, which the merged reply
 * keeps when the follow-up does not restate them (2026-10-19, with the
 * default flip): the session's first-response build stamp (`server_build`;
 * the follow-up is not the session's first pack, and the merge had shipped
 * the first reply without it: the `read.task_pack.prepared` wire pin), and
 * `answer_resolution`, which names the identifier the caller asked about
 * beside the one the evidence owns (T03's first pack: OrderOrchestrator,
 * resolved by its payment / inventory / shipping facets). The rest describe
 * the discover's own decision or continuation (`limit`, `frontier_index`,
 * `checks`, ...), which the follow-up's supersede.
 */
export const AUTOFOLLOW_CARRIED_MEMBERS = ["answer_resolution", "server_build"] as const;

/**
 * The largest reply a chain of follow-ups grows to, by the estimate taken
 * before each follow-up after the first (2026-10-19). Claude Code keeps a
 * tool result out of the conversation, saved to a file the model has to read
 * back, once it passes 50,000 characters (for a tool that declares no
 * `anthropic/maxResultSizeChars`, as none of these does) or
 * MAX_MCP_OUTPUT_TOKENS (25,000 by default), so a chain has to stop short of
 * both. A byte is at most one character, so 45,056 B leaves 4,944 characters
 * for an estimate that misses; at the 2.3-2.6 bytes per token the 6t-6 T03
 * replies came to (their cache-write deltas) it is under 20,000 tokens. The
 * first follow-up is not held to it, as before.
 */
export const AUTOFOLLOW_CHAIN_REPLY_CAP_BYTES = 45_056;

/** Follow-ups per call: the first and two more. Each is a complete pack build; T03's chain uses two under the cap. */
export const AUTOFOLLOW_MAX_FOLLOW_UPS = 3;

/** A served row's members besides its body (handle, path, range, elided, role): about 200 B on T03's rows. */
export const AUTOFOLLOW_ROW_ALLOWANCE_BYTES = 320;

/** A follow-up's decision, `next` and gaps outgrowing the ones they replace: 372 B from T03's second pack to its third. */
export const AUTOFOLLOW_ENVELOPE_ALLOWANCE_BYTES = 2_048;

/** The `next` arguments a later follow-up may carry: the server's own window-read continuation, nothing else. */
export const AUTOFOLLOW_CONTINUATION_ARGUMENTS: ReadonlySet<string> = new Set(["cwd", "lane", "task", "query", "targets", "content"]);

/**
 * Why `autofollowContinuations` stops before running `reply`'s `next`, or
 * `undefined` when that next is a deterministic continuation of the same task:
 * every rule of the first follow-up (`autofollowSkipReason`), and a read of
 * line windows only (`targets` of `{path, range}`, besides them only the
 * request's query, the task, the workspace and `content:"auto"`), of files
 * the reply already serves a body of, under the reply's own task.
 */
export function autofollowContinuationSkipReason(
  reply: Record<string, unknown>,
  requestArgs: Record<string, unknown>,
  defaultByteCeiling?: number,
): string | undefined {
  const reason = autofollowSkipReason(reply, requestArgs, defaultByteCeiling);
  if (reason !== undefined) return reason;
  const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
  const nextArgs = asRecord(asRecord(asRecord(reply["decision"])?.["next"])?.["arguments"]);
  if (nextArgs === undefined || Object.keys(nextArgs).some((key) => !AUTOFOLLOW_CONTINUATION_ARGUMENTS.has(key))) return "not-a-window-read";
  if (nextArgs["content"] !== undefined && nextArgs["content"] !== "auto") return "not-a-window-read";
  const targets = Array.isArray(nextArgs["targets"]) ? (nextArgs["targets"] as unknown[]) : [];
  const windows = targets.map(asRecord).filter((target): target is Record<string, unknown> => {
    if (target === undefined || Object.keys(target).length !== 2 || typeof target["path"] !== "string") return false;
    const span = /^([1-9][0-9]*)-([1-9][0-9]*)$/.exec(typeof target["range"] === "string" ? target["range"] : "");
    return span !== null && Number(span[1]) <= Number(span[2]);
  });
  if (windows.length === 0 || windows.length !== targets.length) return "not-a-window-read";
  const taskId = asRecord(reply["task"])?.["id"];
  if (typeof taskId !== "string" || asRecord(nextArgs["task"])?.["handle"] !== taskId) return "another-task";
  const served = new Set<string>();
  for (const row of Array.isArray(reply["evidence"]) ? (reply["evidence"] as unknown[]) : []) {
    const record = asRecord(row);
    if (typeof record?.["body"] === "string" && typeof record["path"] === "string") served.add(record["path"]);
  }
  if (windows.some((target) => !served.has(target["path"] as string))) return "file-not-in-pack";
  return undefined;
}

/**
 * An upper bound on the reply once `reply`'s next has read `targets`, taken
 * before that read runs: the reply as it stands, each window's source lines
 * as one JSON string plus AUTOFOLLOW_ROW_ALLOWANCE_BYTES for its row's other
 * members, and AUTOFOLLOW_ENVELOPE_ALLOWANCE_BYTES once. A task-pack row
 * carries at most its window's lines (fewer when it elides a doc block), and
 * the follow-up's decision replaces the reply's. `undefined`, so nothing is
 * followed, when a file has no lines to give (`linesOf`) or a window falls
 * outside it. It bounds rows inside the windows only: the server-written
 * continuations in the recorded runs (T03's) served nothing outside them,
 * but a solver-written query + windows read once did (6t-2 T09 rep2 #21,
 * four rows); such rows could take a reply past the cap, and the chain then
 * stops, since the next estimate starts from the reply as it is.
 */
export function autofollowContinuationEstimate(
  reply: Record<string, unknown>,
  targets: ReadonlyArray<Record<string, unknown>>,
  linesOf: (path: string) => readonly string[] | undefined,
): number | undefined {
  let bytes = Buffer.byteLength(JSON.stringify(reply), "utf8") + AUTOFOLLOW_ENVELOPE_ALLOWANCE_BYTES;
  for (const target of targets) {
    const lines = typeof target["path"] === "string" ? linesOf(target["path"]) : undefined;
    const span = /^([0-9]+)-([0-9]+)$/.exec(typeof target["range"] === "string" ? target["range"] : "");
    if (lines === undefined || span === null) return undefined;
    const start = Number(span[1]);
    const end = Number(span[2]);
    if (start < 1 || end < start || end > lines.length) return undefined;
    bytes += Buffer.byteLength(JSON.stringify(lines.slice(start - 1, end).join("\n")), "utf8") + AUTOFOLLOW_ROW_ALLOWANCE_BYTES;
  }
  return bytes;
}

/** `autofollowContinuationEstimate` over the files `step` reads, in the workspace it names. */
export async function autofollowContinuationBytes(reply: Record<string, unknown>, step: Record<string, unknown>): Promise<number | undefined> {
  const targets = step["targets"] as Array<Record<string, unknown>>;
  let root: string;
  try {
    root = resolveWorkspaceRoot(typeof step["cwd"] === "string" ? step["cwd"] : undefined, activeRoot);
  } catch {
    return undefined;
  }
  const files = new Map<string, readonly string[]>();
  for (const target of targets) {
    const file = target["path"] as string;
    if (files.has(file)) continue;
    // served-bytes: not-served (a size estimate: only the windows' byte counts leave autofollowContinuationBytes)
    const text = await readFileSafe(file, root);
    if (text === null) return undefined;
    files.set(file, text.split("\n"));
  }
  return autofollowContinuationEstimate(reply, targets, (file) => files.get(file));
}

export const AUTOFOLLOW_CHAIN_NOTE = "the discover packs' nexts ran server-side, each a read of more windows of the files the reply serves, under the same task; evidence[] holds what each pack served, in order; gaps are the discover packs' own, from before their next ran";

/**
 * `mergeAutofollowReplies` for a follow-up after the first: the same merge,
 * with `auto_followed` naming the chain. `hops` counts the follow-ups run for
 * this reply, and `gaps` keeps what every discover pack disclosed before its
 * next ran, in order, each once (the merge alone keeps only the last pack's).
 */
export function extendAutofollowChain(
  reply: Record<string, unknown>,
  next: Record<string, unknown>,
  hops: number,
): Record<string, unknown> | undefined {
  const merged = mergeAutofollowReplies(reply, next);
  if (merged === undefined) return undefined;
  const gapsOf = (followed: unknown): unknown[] => {
    const gaps = followed !== null && typeof followed === "object" && !Array.isArray(followed)
      ? (followed as Record<string, unknown>)["gaps"]
      : undefined;
    return Array.isArray(gaps) ? gaps.filter((gap) => gap !== null && typeof gap === "object" && !Array.isArray(gap)) : [];
  };
  const seen = new Set<string>();
  const gaps = [...gapsOf(reply["auto_followed"]), ...gapsOf(merged["auto_followed"])].filter((gap) => {
    const key = JSON.stringify(gap);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    ...merged,
    auto_followed: { from: "discover", hops, note: AUTOFOLLOW_CHAIN_NOTE, ...(gaps.length > 0 ? { gaps } : {}) },
  };
}
