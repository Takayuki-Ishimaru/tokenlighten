// verification — extracted implementation; imports point to the owning modules.
import type { BodyMarker } from "../util/verificationPack.js";
import { KIT_DELTA_NOTE_PREFIX } from "./task-pack-wire2.js";
import { KIT_NOTE_MAX_BYTES } from "../util/verificationPack.js";
import { beginServeCall } from "../state/session.js";
import { clarifyOptionalVerificationTests } from "../protocol/verificationReads.js";
import { countLines } from "../util/countLines.js";
import { handleTable } from "../util/handles.js";
import { isCliCodingHost } from "../protocol/clientAdvertisement.js";
import { isRecordLike } from "./search-support.js";
import { isVerificationSurfaceServed } from "../state/session.js";
import { kitEntryIdentity } from "./task-pack-wire2.js";
import { markVerificationKitEntriesSent } from "../state/session.js";
import { markVerificationSurfaceServed } from "../state/session.js";
import { optionalVerificationTestHandles } from "../protocol/verificationReads.js";
import { recordServedRange } from "../state/session.js";
import { resolvedClientId } from "../runtime/config.js";
import { servedRangeReceipt } from "../state/session.js";
import { shaOfText } from "../util/handles.js";
import { shortenKitWhenTestsCannotRun } from "../protocol/verificationReads.js";
import { testHandlesOverReadBudget } from "../protocol/verificationReads.js";
import { trace } from "../util/trace.js";
import { verificationBodyIdentity } from "../util/verificationPack.js";
import { verificationDependencyNote } from "../util/verificationPack.js";
import { verificationKitEntrySent } from "../state/session.js";

/**
 * TL_EFF_EDIT_DIET (B2, 2026-10-19, v016 decision 6t-3): an `edit.applied`
 * kit that repeats no entry this task's earlier edit kits already carried in
 * this lane. Measured: every follow-up edit in arm A re-sent the same
 * `compile_facts`/`link_set`/`harness` (6.9-9.6 KB each), because the
 * `kit_unchanged` receipt fires only when the WHOLE kit matches the previous
 * one, and a new edited file always changes some entry.
 *
 * The first kit of a task (its `note` not yet sent) ships whole, and so does a
 * kit whose `note` changed (a new strategy or build-entry fact restates the
 * kit) or that has nothing to leave out. Otherwise each family keeps only its
 * new or changed entries — `surfaces`/`compile_facts`/`link_set` by entry,
 * `harness` by field, `toolchain`/`recipe`/`named_paths`/`next_call` whole —
 * and `note` names what was left out. `kit_unchanged` receipts pass through.
 * Every identity this kit carries is recorded, whole or delta; `force_serve`
 * sends the whole kit (the caller said its context is gone).
 */
export function editKitDelta(workspace: string, kit: Record<string, unknown>, forceServe: boolean): Record<string, unknown> {
  if (kit["kit_unchanged"] === true) return kit;
  const carried: string[] = [];
  const sentBefore = (identity: string): boolean => {
    carried.push(identity);
    return verificationKitEntrySent(workspace, identity);
  };
  const noteSentBefore = typeof kit["note"] === "string" && sentBefore(kitEntryIdentity("note", kit["note"]));
  const delta: Record<string, unknown> = { ...kit };
  const leftOut: string[] = [];
  for (const family of ["surfaces", "compile_facts", "link_set", "named_paths"]) {
    const entries = kit[family];
    if (!Array.isArray(entries)) continue;
    const fresh = entries.filter((entry) => !sentBefore(kitEntryIdentity(family, entry)));
    if (fresh.length < entries.length) leftOut.push(`${entries.length - fresh.length} ${family}`);
    if (family === "named_paths" && fresh.length === 0) delete delta[family];
    else delta[family] = fresh;
  }
  const harness = kit["harness"];
  if (isRecordLike(harness)) {
    const freshHarness: Record<string, unknown> = {};
    const repeated: string[] = [];
    for (const [key, value] of Object.entries(harness)) {
      if (sentBefore(kitEntryIdentity(`harness.${key}`, value))) repeated.push(key);
      else freshHarness[key] = value;
    }
    if (repeated.length > 0) leftOut.push(`harness ${repeated.join("/")}`);
    if (Object.keys(freshHarness).length > 0) delta["harness"] = freshHarness;
    else delete delta["harness"];
  }
  for (const field of ["toolchain", "recipe", "next_call"]) {
    if (kit[field] === undefined) continue;
    if (sentBefore(kitEntryIdentity(field, kit[field]))) {
      leftOut.push(field);
      delete delta[field];
    }
  }
  markVerificationKitEntriesSent(workspace, carried);
  if (forceServe || !noteSentBefore || leftOut.length === 0) return kit;
  let note = `${KIT_DELTA_NOTE_PREFIX}${leftOut.join(", ")}`;
  if (Buffer.byteLength(note, "utf8") > KIT_NOTE_MAX_BYTES) {
    note = `${KIT_DELTA_NOTE_PREFIX}${leftOut.map((part) => part.split(" ")[0]!.startsWith("harness") ? "harness" : part).join(", ")}`;
  }
  if (Buffer.byteLength(note, "utf8") > KIT_NOTE_MAX_BYTES) note = `${KIT_DELTA_NOTE_PREFIX.trimEnd().replace(/:$/, "")}.`;
  delta["note"] = note;
  return delta;
}

/**
 * Session-once body inlining for one kit entry: an already-served body loses
 * its `code` here (labelKitBodies re-labels the now-body-less entry).
 *
 * S1 (2026-08-07 kit-entry-dedupe) made the ledger CONTENT-keyed. Two things
 * follow. A file whose bytes changed since its serve is served again — the
 * path-only ledger used to label it "served-earlier" for bytes that had never
 * gone out. And a PARTIAL body (the harness-entry head) never enters the
 * ledger at all: a 50-line head is not the file, so it can never license a
 * whole-file "already in your context" claim on a later response.
 *
 * FX-O2 (ruling (s), 2026-09-03, round-17 finding 7b / INV-G row 52): this
 * function used to write ONLY `verificationSurfacesServed` (ledger 5) here,
 * mid-assembly — a namespace `tl_edit_file`'s admissible union / byte residency
 * never consult, so a file a kit had JUST shipped whole (a real, non-partial
 * `code` body) still refused `tl_edit_file` `execution-typestate` unless some
 * OTHER call had separately read it — union/residency never heard about a
 * kit-inlined body at all.
 *
 * FIX IS ADDITIVE, NOT A REPLACEMENT (measured the hard way: dropping ledger
 * 5 in favor of ledger 1 alone regressed `replayCorpus.spec.ts`'s vkit2 wire
 * pin — a `servedRangeReceipt`-sourced "served-earlier" always carries a
 * `served_by` provenance string, ledger 5's own empty-object answer never
 * did, so every dedup'd entry grew by that string's bytes). `markVerification
 * SurfaceServed` stays exactly as it was — the first-checked, byte-cheapest
 * dedup source `verificationBodyHeld` tries before ever falling to the range
 * ledger — so the wire shape for the ORDINARY case (a repeat within one
 * session) is unchanged, byte for byte. ADDED alongside it:
 * `recordServedRange` books this SAME whole-file body PROVISIONALLY
 * (`pendingServeSpans`), and `protocol/emit.ts`'s `settleServedCallBookings`
 * promotes it once the finalized wire actually corroborates a `code` body at
 * this `path` — no envelope.ts change needed, unlike finding 3's csv
 * artifact case: the generic `servedWindowsOf` walk ALREADY recognizes a
 * bare `{path, code}` sibling pair as evidence (`code` is one of its three
 * recognized carrier fields), and a kit entry with no sibling `range` is
 * read as "whole file" — exactly right, since this function only ever
 * reaches a non-partial (whole-file) body. This is what closes the actual
 * gap: `admissibleEditPaths`/`editPathResidency` now gain the fact ledger 5
 * could never have told them, with zero change to any field `dropServedBody`
 * returns.
 */
export function dropServedBody<T extends { path: string; code?: string; body?: BodyMarker; content_completeness?: "partial" }>(
  workspace: string,
  entry: T,
): T | Omit<T, "code"> {
  if (entry.code === undefined) return entry;
  if (entry.content_completeness === "partial") return entry;
  // The UNION check, not just this kit's own ledger: a link-set source the
  // caller already read in full is held just as surely as one a kit inlined,
  // and link_set was 34.5% of measured verification bytes precisely because
  // its members are the paired sources the change's own reads already served.
  if (verificationBodyHeld(workspace, entry.path, entry.code) !== undefined) {
    const { code: _code, ...rest } = entry;
    return rest;
  }
  // Unchanged: ledger 5 stays the FIRST-checked, byte-cheapest dedup source
  // (`verificationBodyHeld` tries it before ever falling to the range
  // ledger's own provenance string) — removing it regressed the wire shape
  // measurably (`replayCorpus.spec.ts`'s vkit2 pin): a `servedRangeReceipt`-
  // only "served-earlier" always carries a `served_by` provenance string
  // ledger 5's own empty-object answer never did, so every dedup'd entry
  // grew by that string's bytes. Keeping this call preserves that byte shape
  // exactly for the ordinary case.
  markVerificationSurfaceServed(workspace, entry.path, shaOfText(entry.code));
  // ADDITIVE (ruling (s) row 52): stage the SAME whole-file body through the
  // funnel-exit ledger every other honest text serve uses, so the admissible
  // union / byte residency — which ledger 5 was never wired to and cannot
  // express — also reflect it. `recordServedRange` books this PROVISIONALLY;
  // `protocol/emit.ts`'s `settleServedCallBookings` promotes it once the
  // finalized wire actually corroborates a `code` body at this `path` (the
  // generic `servedWindowsOf` walk already recognizes a bare `{path, code}`
  // sibling pair — no `range` sibling on a kit entry means "whole file",
  // exactly right here, since this function only ever reaches a non-partial
  // whole-file body). Purely additive: it changes no field on `entry`, and
  // ledger 5 above still decides — byte-for-byte, unchanged — whether a
  // LATER kit-attach call labels this path "served-earlier".
  const totalLines = countLines(entry.code);
  if (totalLines >= 1) {
    const serveCall = beginServeCall(workspace);
    recordServedRange(workspace, entry.path, shaOfText(entry.code), 1, totalLines, totalLines, {
      mode: "verification-kit",
      range: `1-${totalLines}`,
      call: serveCall,
    });
  }
  return entry;
}

/**
 * S1: does the caller ALREADY hold this path's current whole-file bytes, and
 * which call put them there? One question, two ledgers, each recording only
 * bytes that genuinely left this server:
 *   - `verificationSurfacesServed` — what a verification kit inlined, and
 *   - `servedRangeLedger` — what a task_pack / slice / full / batched-handles
 *     read served (including the kit's own `verification.next_call`).
 * The range ledger is content-sha bound and books only the spans actually
 * displayed (elided comment blocks land in `unserved`), so full coverage of
 * [1..lines] means every byte is really held. An unhashable file (missing,
 * or past the scan cap) answers `undefined`: serve it, never claim it.
 */
export function verificationBodyHeld(
  workspace: string,
  rel: string,
  knownContent?: string,
): { by?: string } | undefined {
  // `knownContent` is the exact body this kit would serve — identity taken from
  // it rather than from a re-read, so the question asked is always "do you
  // already hold THESE bytes?".
  const identity = knownContent !== undefined
    ? { sha: shaOfText(knownContent), lines: countLines(knownContent) }
    : verificationBodyIdentity(workspace, rel);
  if (identity === undefined) return undefined;
  if (isVerificationSurfaceServed(workspace, rel, identity.sha)) return {};
  if (identity.lines < 1) return undefined;
  const receipt = servedRangeReceipt(workspace, rel, identity.sha, 1, identity.lines, identity.lines);
  if (receipt === undefined) return undefined;
  // V10-02: repeated_range — a served-range ledger hit suppressed this
  // verification-kit body. Distinct seam from servedContentReceipt (a
  // different response shape) but the SAME underlying ledger-hit concept.
  trace("repeated_range", { mode: "verification", path: rel, complete: receipt.complete }, workspace);
  return receipt.served_by !== undefined ? { by: receipt.served_by } : {};
}

/**
 * One batched follow-up carries at most this many handles. The kit's own family
 * caps are 6 surfaces / 8 link_set / 6 mock headers, so a fully-omitted kit is
 * bounded well above this — the cap keeps the ONE call cheap and, because the
 * handles are emitted in kit spend priority, a truncated batch still fetches
 * the most expensive misses first.
 */
export const VERIFICATION_NEXT_CALL_MAX_HANDLES = 8;

/**
 * S8: how many named-but-unserved paths may earn a handle on one kit. Small on
 * purpose — this list exists to close an escape, not to become a second kit.
 * The need order in `namedKitPaths` puts the build system first, so a truncated
 * list still carries the path an agent would otherwise shell out to find.
 */
export const VERIFICATION_NAMED_PATHS_MAX = 4;

/**
 * S8 (2026-08-07): every kit field that NAMES a repo path but carries neither
 * a body nor a handle, in need order. Named-but-unserved was 20 of 31 measured
 * arm-A native-IO escapes (2026-07-31): a file the kit says matters, with no
 * served way to open it, is a `cat`. compile_facts.missing_includes got handles
 * in that wave; these are the remaining path-naming fields.
 */
export function namedKitPaths(kit: Record<string, unknown>): Array<{ path: string; named_by: string }> {
  const out: Array<{ path: string; named_by: string }> = [];
  const push = (value: unknown, named_by: string): void => {
    if (typeof value !== "string") return;
    // recipe refs are spelled `path:line` and `path:line#SYMBOL`.
    const rel = value.replace(/\\/g, "/").split("#")[0]!.replace(/:\d+$/, "").trim();
    // A command ("npm test", "clang++ -std=c++17 ...") is not a path. Anything
    // that survives still has to resolve to a readable file before it earns a
    // handle — the caller checks that against the workspace.
    if (rel.length === 0 || /\s/.test(rel)) return;
    out.push({ path: rel, named_by });
  };
  const toolchain = kit["toolchain"];
  if (toolchain !== null && typeof toolchain === "object") {
    push((toolchain as Record<string, unknown>)["build_entry"], "toolchain.build_entry");
  }
  const harness = kit["harness"];
  if (harness !== null && typeof harness === "object") {
    const command = (harness as Record<string, unknown>)["build_command"];
    if (command !== null && typeof command === "object") {
      push((command as Record<string, unknown>)["source"], "harness.build_command.source");
    }
  }
  const recipe = kit["recipe"];
  if (recipe !== null && typeof recipe === "object") {
    const fields = recipe as Record<string, unknown>;
    for (const field of ["compile_targets", "assertion_refs", "contract_refs", "mock_controls"] as const) {
      for (const value of Array.isArray(fields[field]) ? (fields[field] as unknown[]) : []) {
        push(value, `recipe.${field}`);
      }
    }
  }
  return out;
}

/**
 * Label one body-less kit entry from the served ledger, collecting the handles
 * of the never-served ones.
 */
export function labelKitEntry(
  workspace: string,
  raw: unknown,
  collect: (handle: string) => void,
): unknown {
  if (raw === null || typeof raw !== "object") return raw;
  const entry = raw as Record<string, unknown>;
  if (typeof entry["code"] === "string") return entry;
  const rel = entry["path"];
  if (typeof rel !== "string") return entry;
  // Served earlier: the body IS in the agent's context. Saying "omitted" here
  // (the pre-2026-07-31 behavior) meant the exact OPPOSITE of the truth.
  const held = verificationBodyHeld(workspace, rel);
  if (held !== undefined) {
    return {
      ...entry,
      body: "served-earlier" satisfies BodyMarker,
      // Provenance, not a new read: name the call that put the bytes on the
      // wire so "already in your context" is checkable rather than asserted.
      ...(held.by !== undefined ? { served_by: held.by } : {}),
    };
  }
  const handle = entry["handle"];
  if (typeof handle === "string") collect(handle);
  return { ...entry, body: "omitted" satisfies BodyMarker };
}

/**
 * State WHY each body-less kit entry has no body, and — the 2026-07-31
 * verify-kit-gap fix — attach the machine-executable call that closes the gap.
 *
 * 20 of 31 arm-A native-IO escapes in the 2026-07-31 run were post-edit harness
 * building: the kit rode 6 times, and every file the solver then `cat`ed was
 * one whose body was `"omitted"` (hal_mock.h 9848 B, test_mavlink.cpp 11784 B,
 * os_mutex.c 7223 B, quat.cpp 6108 B). The note ALREADY said "slice it via its
 * handle" and not one solver did — passive prose does not convert, while every
 * response that carried a concrete `next_call` kept solvers on rails. So the
 * fetch is emitted as a call, not as advice, and batched into ONE turn.
 */
/** The kit names a test command and reports its dependencies installed. */
export function kitTestEntryRunnable(kit: Record<string, unknown>): boolean {
  const toolchain = kit["toolchain"];
  if (toolchain === null || typeof toolchain !== "object") return false;
  const record = toolchain as Record<string, unknown>;
  return record["deps_installed"] === true && typeof record["test_entry"] === "string" && record["test_entry"].length > 0;
}

/** The kit names a test command and reports its dependencies missing. */
export function kitTestsCannotRun(kit: Record<string, unknown>): boolean {
  const toolchain = kit["toolchain"];
  return toolchain !== null && typeof toolchain === "object" && (toolchain as Record<string, unknown>)["deps_installed"] === false;
}

export function labelKitBodies(
  workspace: string,
  kit: Record<string, unknown>,
  opts: { omitBatchedReadWithBuildCommand?: boolean } = {},
): Record<string, unknown> {
  const mockHandles: string[] = [];
  const linkHandles: string[] = [];
  const surfaceHandles: string[] = [];
  const mapFamily = (raw: unknown, sink: string[]): unknown[] =>
    (Array.isArray(raw) ? raw : []).map((entry) => labelKitEntry(workspace, entry, (h) => sink.push(h)));

  const out: Record<string, unknown> = { ...kit };
  out["surfaces"] = mapFamily(kit["surfaces"], surfaceHandles);
  out["link_set"] = mapFamily(kit["link_set"], linkHandles);
  // compile_facts.missing_includes were plain path strings — named but
  // unreachable by any single call, so solvers spliced exactly those headers
  // natively (2026-07-31 escapefix-3, T05c). Mint a handle per never-served
  // path and let the SAME batched next_call serve them.
  const includeHandles: string[] = [];
  if (Array.isArray(kit["compile_facts"])) {
    out["compile_facts"] = (kit["compile_facts"] as unknown[]).map((raw) => {
      if (raw === null || typeof raw !== "object") return raw;
      const fact = raw as Record<string, unknown>;
      const missing = Array.isArray(fact["missing_includes"]) ? fact["missing_includes"] : [];
      const decorated: Array<{ path: string; handle: string }> = [];
      for (const rel of missing) {
        if (typeof rel !== "string" || rel.length === 0) continue;
        // S1: the union check — a header whose bytes the caller already holds
        // (kit inline OR an earlier read) needs no handle and no next_call slot.
        if (verificationBodyHeld(workspace, rel) !== undefined) continue;
        const handle = handleTable.upsert({ kind: "file", path: rel, workspaceRoot: workspace }).id;
        decorated.push({ path: rel, handle });
        includeHandles.push(handle);
      }
      return decorated.length > 0 ? { ...fact, missing_include_handles: decorated } : fact;
    });
  }
  const harness = kit["harness"];
  if (harness !== null && typeof harness === "object") {
    const withMocks = { ...(harness as Record<string, unknown>) };
    if (Array.isArray(withMocks["mock_headers"])) {
      withMocks["mock_headers"] = mapFamily(withMocks["mock_headers"], mockHandles);
    }
    out["harness"] = withMocks;
  }

  // S8: mint a handle for every path this kit merely NAMES, and route it into
  // the SAME batched next_call. Runs after every body-bearing family so a path
  // that already rides one is never duplicated here.
  const namedHandles: string[] = [];
  const reachable = new Set<string>();
  for (const family of [out["surfaces"], out["link_set"], out["compile_facts"], (out["harness"] as Record<string, unknown> | undefined)?.["mock_headers"]]) {
    for (const raw of Array.isArray(family) ? family : []) {
      const named = (raw as Record<string, unknown> | null)?.["path"];
      if (typeof named === "string") reachable.add(named);
    }
  }
  const namedPaths: Array<{ path: string; handle: string; named_by: string }> = [];
  for (const candidate of namedKitPaths(kit)) {
    if (namedPaths.length >= VERIFICATION_NAMED_PATHS_MAX) break;
    if (reachable.has(candidate.path)) continue;
    reachable.add(candidate.path);
    // Not a readable workspace file ("synthesized", a directory, a stale ref)
    // => no handle: a handle that resolves to nothing is worse than silence.
    if (verificationBodyIdentity(workspace, candidate.path) === undefined) continue;
    // Already in the caller's context => naming it is enough; do not spend a
    // next_call slot re-serving bytes it holds.
    if (verificationBodyHeld(workspace, candidate.path) !== undefined) continue;
    const handle = handleTable.upsert({ kind: "file", path: candidate.path, workspaceRoot: workspace }).id;
    namedPaths.push({ path: candidate.path, handle, named_by: candidate.named_by });
    namedHandles.push(handle);
  }
  if (namedPaths.length > 0) out["named_paths"] = namedPaths;

  // 2026-10-17 simple paired bench (DESIGN-v0.14-plan §20.8): a CLI coding
  // host (Claude Code, Copilot CLI, Codex CLI) runs the kit's own `test_entry` itself, so
  // when the toolchain is installed that run is the verification and the
  // referencing TEST files' bodies are not fetched first (Copilot F1 read
  // 4.6-10.8 KB of tests after every edit, one extra turn each). Their
  // handles stay listed; mock headers, link sets and missing includes, which
  // a standalone compile needs, still ride the batched call.
  const testHandles = optionalVerificationTestHandles(
    // A test that cannot run here is not read to verify anything, on any host.
    out, (kitTestEntryRunnable(kit) && isCliCodingHost(resolvedClientId())) || kitTestsCannotRun(kit),
    new Set(namedKitPaths(kit).map(candidate => candidate.path)),
    new Set([...mockHandles, ...linkHandles, ...includeHandles, ...namedHandles]),
  );
  // 2026-10-29 (click/core.py report): whatever test source remains to read is
  // bounded too. The surfaces are in relevance order and the budget is spent in
  // it; a test past VERIFICATION_TEST_READ_BUDGET_BYTES keeps its path and handle
  // in the kit but is not asked for, and the kit's test_entry is the check.
  const overBudgetTests = testHandlesOverReadBudget(
    out,
    new Set(namedKitPaths(kit).map(candidate => candidate.path)),
    new Set([...testHandles, ...mockHandles, ...linkHandles, ...includeHandles, ...namedHandles]),
  );
  const unbatchedTests = new Set([...testHandles, ...overBudgetTests]);
  // Kit SPEND priority is the batch order: mock headers (no cheaper source),
  // then link_set (already sources-before-paired-headers), then the
  // missing-include headers a standalone compile needs, then surfaces.
  // Dedup keeps the highest-priority occurrence of a shared handle.
  const batched: string[] = [];
  for (const handle of [...mockHandles, ...linkHandles, ...includeHandles, ...namedHandles, ...surfaceHandles.filter((h) => !unbatchedTests.has(h))]) {
    if (batched.includes(handle)) continue;
    batched.push(handle);
    if (batched.length >= VERIFICATION_NEXT_CALL_MAX_HANDLES) break;
  }
  // TL_EFF_EDIT_DIET (B3, 2026-10-19, v016 decision 6t-3): a CLI coding host
  // compiles with the kit's own harness build command, so the batched read of
  // every body-less entry is not handed to it as the next step (measured: T05c
  // rep0 followed it into a 36.5 KB read and then compiled against the real
  // headers). The entries keep their handles; one can still be read by handle.
  const harnessCommand = isRecordLike(out["harness"]) ? (out["harness"] as Record<string, unknown>)["build_command"] : undefined;
  const omitBatchedRead = opts.omitBatchedReadWithBuildCommand === true && harnessCommand !== undefined;
  if (batched.length > 0 && !omitBatchedRead) {
    out["next_call"] = {
      tool: "tl_read_file",
      arguments: { handles: batched },
      note: "one call serves every required body-less entry below",
    };
  }
  clarifyOptionalVerificationTests(out, unbatchedTests, batched);
  return kitTestsCannotRun(kit) ? shortenKitWhenTestsCannotRun(out, testHandles) : out;
}

export function attachVerificationAdvisory(
  result: Record<string, unknown>,
  manifest: { toolchain?: { deps_installed?: boolean; verify_note?: string } },
): Record<string, unknown> {
  const verifyNote = verificationDependencyNote(manifest);
  if (verifyNote === undefined) return { ...result, verification: manifest };
  // The reply's own `verify_note` says it; the kit need not say it again.
  const { verify_note: _promoted, ...toolchain } = manifest.toolchain ?? {};
  return { ...result, verification: { ...manifest, toolchain }, verify_note: verifyNote };
}

/**
 * W9 (2026-08-22 create-terminal-proof): true only for a successful CREATE
 * dispatch response — `read_back` and numeric `total_lines` are set
 * unconditionally together, exactly once, by server.ts's create branch
 * (createFile dispatch) and nowhere else. Used only to word the
 * not-applicable reason below; attachAppliedReadback's own total_lines
 * fallback does not depend on this helper.
 */
export function isCreateDispatchResult(result: Record<string, unknown>): boolean {
  return result["read_back"] !== undefined && typeof result["total_lines"] === "number";
}

export function verificationNotApplicableReason(result: Record<string, unknown>): string {
  return isCreateDispatchResult(result)
    ? "new file — no test/mock references it"
    : "no referencing test, mock, or compile fact";
}
