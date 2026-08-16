// ---------------------------------------------------------------------------
// protocol v1 — the `edit_file` response family, authored (C2-5).
//
// NORMATIVE SOURCE: DESIGN-v0.10-protocol-v1-contract-freeze.md §2.4 (the four
// members, discriminated by SIDE-EFFECT STATE), §4.2.1 (side-effect reports are
// refusal-conversion-FORBIDDEN — the rule, the floor, and the liveness caveat),
// and §10.3 Appendix A (Revision 4, user-approved 2026-08-13) A.5.11–A.5.14 and
// their preamble. A.9.2 rows 13 and 14 are closed here.
//
// WHY THIS MODULE IS DIFFERENT FROM ITS TWO SIBLINGS. `readFamily.ts` and
// `searchFamily.ts` reshape responses about bytes the server READ; a wrong
// projection there costs a round trip. This one reshapes responses about bytes
// the server WROTE to the caller's disk. §4.2.1 states the asymmetry: converting
// an `edit.applied` / `edit.rolled_back` / `edit.state_unknown` into a `refusal`
// does not withhold information, it ASSERTS A FALSEHOOD ABOUT THE CALLER'S DISK,
// and it is the one falsehood the caller cannot detect or recover from, because
// the only record of what happened was the response that just got replaced.
//
// So every function below is written to FAIL OPEN. A projector that throws would
// propagate to `server.ts`'s JSON-RPC catch and emit a contentless -32603 for a
// batch that already landed — the exact shearing bug §4.2.1 names. When this
// module cannot derive something it emits less, never a different kind and never
// a fabricated value.
//
// THE FOUR RULES THIS MODULE APPLIES.
//
//  RULE SE (§4.2.1(1), (3)). Three of the four members carry a `SideEffectCore`:
//  counts + affected paths + a workspace marker. It is a TYPE, not a table, so
//  "the shedder may never cut it" is checkable (§10.1(b)). `isSideEffectKind`
//  is the runtime half, read by the funnel.
//
//  RULE R (§2.4, A.5.11). `applied-normalized` is not an outcome: the three
//  normalization path lists become ONE `NormalizationReceipt` on `edit.applied`.
//  Same for the fence's reclassification, which becomes an
//  `EditReclassification` receipt on the same member (ruling 2, 2026-08-14).
//
//  RULE E-1 (A.8). `checkpoint: string | null` is OMITTED when null rather than
//  emitted as `null` (A.9.2 row 14). The omission happens HERE, at the wire
//  projection; `applyEditsMulti`'s internal `string | null` contract and the
//  function-level spec that pins it are deliberately untouched.
//
//  RULE 13 (A.9.2 row 13). `code:"rollback-failed"` + `workspace_state:
//  "workspace-state-unknown"` were two flags for three states, held apart by a
//  comment. They become two MEMBERS, and the sentinel strings are deleted.
//
// DISCLOSED DEVIATIONS are declared at the `KEPT_ON_*` table that carries them,
// per the C2-3/C2-4 precedent: keep reversibly, state the capability the
// deletion would lose, raise a Revision-5 row.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO: `ledger` (§4.2.1(4)).
//
// The appendix gives every side-effect member an optional `ledger` — a recovery
// handle that the per-file detail COMPACTS INTO under budget pressure. It is
// never emitted here, and the debt is stated rather than papered over. The shed
// it is the counterpart of does not exist: `applied[]` is capped in bytes
// (APPLIED_ENTRY_CAP_BYTES / APPLIED_TOTAL_CAP_BYTES) but the cut is a DROP, not
// a compaction — nothing moves server-side, so there is nothing for a handle to
// address — and `HandleKind` (`util/handles.ts:17-25`) has no `ledger` member,
// no mint path and no consume path. Minting one would be a capability token
// pointing at state that was never retained, which is strictly worse than its
// absence: §4.2.1(5) makes the handle SESSION-LIVED and NOT RE-DERIVABLE, so a
// caller that trusted a dangling one would have neither the ledger nor the
// floor. Building the compaction is P3a's; until then `core` is the whole
// guarantee, which is exactly what §4.2.1(5) says it must be able to be.
// ---------------------------------------------------------------------------

import type {
  AppliedEntry,
  EditCounts,
  EditReclassification,
  Kind,
  NormalizationReceipt,
  SideEffectCore,
  WorkspaceMarker,
} from "@tokenlighten/types";

import { shaOfText, shortSha } from "../util/handles.js";

type Body = Record<string, unknown>;

function isRecord(value: unknown): value is Body {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.filter((item): item is string => typeof item === "string" && item !== "");
  return entries.length > 0 ? entries : undefined;
}

/** E-1: copy `keys` from `from` onto `onto` iff the value is present and non-empty. */
function keep(onto: Body, from: Body, keys: readonly string[]): void {
  for (const key of keys) {
    const value = from[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (isRecord(value) && Object.keys(value).length === 0) continue;
    onto[key] = value;
  }
}

// ---------------------------------------------------------------------------
// RULE SE — the three kinds §4.2.1(1) protects
// ---------------------------------------------------------------------------

/**
 * SE-STABLE's domain, as a runtime set.
 *
 * `edit.reclassified` is deliberately absent: its own §2.4 row says nothing was
 * written, so a refusal there asserts nothing false and §4.2's ordinary rule
 * governs it.
 */
const SIDE_EFFECT_KINDS: ReadonlySet<string> = new Set<Kind>([
  "edit.applied", "edit.rolled_back", "edit.state_unknown",
]);

/**
 * True iff `kind` reports a COMPLETED EFFECT on the caller's files, and is
 * therefore kind-stable under any delivery pressure (§4.2.1(1)).
 *
 * The funnel reads this to make the rule structural rather than a paragraph: no
 * shedder, validator, budget or serializer may convert one of these into a
 * `refusal`, and none may convert one into another.
 */
export function isSideEffectKind(kind: Kind): boolean {
  return SIDE_EFFECT_KINDS.has(kind);
}

/** True iff `kind` is a member this module authors. */
export function isEditFamilyKind(kind: Kind): boolean {
  return kind.startsWith("edit.");
}

// ---------------------------------------------------------------------------
// A.2.2 `WorkspaceMarker` on the WRITE path — net-new (§4.2.1(3))
// ---------------------------------------------------------------------------

/**
 * The workspace marker a side-effect report carries, minted CHEAPLY.
 *
 * §4.2.1(3) puts it in the floor for one stated purpose: it "binds the report to
 * a workspace fingerprint, so the caller can tell whether it is looking at the
 * state this report describes". That is a much smaller job than the read side's
 * marker does, and the difference is deliberate:
 *
 *  - THE READ-SIDE MARKER (`readCodeTaskPack.ts`'s `buildTaskWorkspaceState`)
 *    hashes every served surface AND a whole-workspace inventory, because a
 *    certificate has to survive comparison against a LATER call's state. It
 *    costs a directory walk and a stat per file.
 *  - THIS ONE hashes only what the report itself already knows: the resolved
 *    workspace root and the per-path identity the emitter computed BEFORE this
 *    function ran (the post-edit handle on an applied file, the restore ledger's
 *    `expected_sha`/`stuck_sha` on a rolled-back one). ZERO FILE I/O, and it
 *    cannot fail — which matters, because it runs after the write.
 *
 * CONSEQUENCE, STATED SO IT IS NOT MISREAD: a write-side fingerprint and a
 * read-side fingerprint are computed over different inputs and are NEVER
 * comparable. Neither is a version number. The question this one answers is "is
 * the tree still in the state this report describes?", asked by re-deriving it,
 * not by matching it against a pack's.
 *
 * `scope` is always `"served-evidence"`: no inventory is consulted on the write
 * path, so claiming `"evidence-plus-inventory"` would be a claim about files
 * this operation never looked at. `evidence_files` is the number of files the
 * report is ABOUT (`core.paths.length`), and the two inventory fields say
 * plainly that there was no inventory.
 */
function workspaceMarkerFor(
  root: string | undefined,
  identities: readonly string[],
  fileCount: number,
): WorkspaceMarker {
  return {
    // Short, because this rides inside the byte-floored core on every edit
    // response this server emits. The full-width read-side spelling would cost
    // ~52 bytes per response to answer a question nobody can ask across the two
    // (see the CONSEQUENCE note above).
    fingerprint: shortSha(shaOfText(JSON.stringify([root ?? "", ...identities]))),
    scope: "served-evidence",
    evidence_files: fileCount,
    inventory_files: 0,
    inventory_complete: false,
  };
}

// ---------------------------------------------------------------------------
// §4.2.1(3) counts — net-new
// ---------------------------------------------------------------------------

/**
 * The four counts, IN FILES.
 *
 * §4.2.1(3) names them "how many edits landed, were attempted, were reverted, or
 * could not be proven". The unit is the FILE, not the `edits[]` item, for two
 * reasons that agree: the restore ledger these counts have to describe is
 * per-file (`RollbackFileState`), and `core.paths` — the field §4.2.1(5) makes
 * load-bearing — is per-file too. Counting items here and paths there would give
 * a caller two numbers that never reconcile.
 *
 * A file whose WRITE FAILED is not counted as `attempted`: the write is atomic
 * (tmp + rename), so that file still holds its pre-edit bytes and nothing was
 * done to it that needs undoing. It is named in the response's own prose and, on
 * the batch path, by `path`.
 */
function countsFor(kind: Kind, ledger: readonly Body[], fileCount: number): EditCounts {
  if (kind === "edit.applied") {
    return { applied: fileCount, attempted: fileCount, reverted: 0, unproven: 0 };
  }
  const reverted = ledger.filter((row) => row["state"] === "rolled-back").length;
  const unproven = ledger.filter((row) => row["state"] === "restore-failed").length;
  return { applied: 0, attempted: ledger.length, reverted, unproven };
}

/**
 * Build the §4.2.1(3) floor, or `undefined` when no path can be derived.
 *
 * `SideEffectCore.paths` is `[string, ...string[]]` — non-empty BY TYPE — and
 * this is the one place that narrowing is performed, so it is defended here
 * rather than asserted. Returning `undefined` is the honest answer when an
 * emitter's body names no file at all: the floor is guaranteed-FIT, not
 * guaranteed-DERIVABLE, and fabricating a path to satisfy a type would put a
 * lie in the field §4.2.1(5) makes load-bearing. The caller still gets its
 * report — the kind never changes (§4.2.1(1)) — it just gets it without a core.
 */
function buildCore(
  kind: Kind,
  paths: readonly string[],
  identities: readonly string[],
  ledger: readonly Body[],
  root: string | undefined,
): SideEffectCore | undefined {
  const unique = [...new Set(paths.filter((path) => path !== ""))];
  const [first, ...rest] = unique;
  if (first === undefined) return undefined;
  return {
    counts: countsFor(kind, ledger, unique.length),
    paths: [first, ...rest],
    workspace: workspaceMarkerFor(root, identities, unique.length),
  };
}

// ---------------------------------------------------------------------------
// A.5.11 `edit.applied`
// ---------------------------------------------------------------------------

/**
 * The per-file rows an applied edit is about, in emit order.
 *
 * Four emitters produce four shapes and all four are read here, because the
 * member is one member: the batch path's `files: EditFileResult[]`, `renameSymbol`'s
 * `changed_files[]`, the single-edit / create path's top-level `path` (+ the
 * `handle`/`lines`/`delta` that ride beside it), and — last, as a fallback for
 * an intent/artifact dispatch that carries neither — the read-back's own
 * `applied[]`.
 */
function editedRows(body: Body): Body[] {
  const files = Array.isArray(body["files"]) ? body["files"].filter(isRecord) : [];
  if (files.length > 0) return files;
  const changed = Array.isArray(body["changed_files"]) ? body["changed_files"].filter(isRecord) : [];
  if (changed.length > 0) return changed;
  // readAndEdit returns its completed write as
  // { ok:true, context, edit:{path,lines,delta} }. Normalize that nested
  // single-file shape before the ordinary top-level path form so edit.applied
  // always has both an addressed applied entry and the SideEffectCore required
  // by the protocol v1 side-effect contract.
  const nestedEdit = isRecord(body["edit"]) ? body["edit"] : undefined;
  if (nestedEdit !== undefined) {
    const nestedPath = str(nestedEdit["path"]);
    if (nestedPath !== undefined) {
      const row: Body = { path: nestedPath };
      keep(row, nestedEdit, ["lines", "delta", "handle"]);
      if (row["handle"] === undefined) keep(row, body, ["handle"]);
      return [row];
    }
  }
  const path = str(body["path"]);
  if (path !== undefined) {
    const row: Body = { path };
    keep(row, body, ["lines", "delta", "handle"]);
    // A CREATE has no edited span — the whole file is new — so it carries
    // `total_lines` instead of `lines`. Spelled as the span it is, so the one
    // per-file array stays TOTAL over `core.paths` on this path too; without it
    // a create's auto-minted handle would have no address inside `applied[]`.
    if (row["lines"] === undefined && typeof body["total_lines"] === "number") {
      row["lines"] = `1-${Math.max(1, body["total_lines"])}`;
    }
    return [row];
  }
  const applied = Array.isArray(body["applied"]) ? body["applied"].filter(isRecord) : [];
  const seen = new Set<string>();
  const rows: Body[] = [];
  for (const entry of applied) {
    const entryPath = str(entry["path"]);
    if (entryPath === undefined || seen.has(entryPath)) continue;
    seen.add(entryPath);
    rows.push({ path: entryPath });
  }
  return rows;
}

/**
 * RULE R + ruling 4: ONE per-file array, seeded from the emitter's own row list
 * and enriched by the post-edit read-back.
 *
 * A.5.11 folds `files[]` into `core.paths`, which is right for the PATHS and
 * silent about the three other fields that array carries. They are not
 * droppable: `handle` is DESIGN-v0.8 B3.1's answer to a measured regression (a
 * multi-file batch used to leave every touched file handle-less until a separate
 * read minted one), and the P3a note is explicit that handle absence induces
 * follow-up round-trips. So `files[]` is DELETED from the wire and its content
 * is relocated here, joined by path — one array, no duplication, nothing lost.
 *
 * The join is BY PATH and is TOTAL over the row list: a file the read-back
 * skipped (unparseable range, unreadable bytes, or the APPLIED_TOTAL_CAP_BYTES
 * ceiling) still gets an entry carrying its handle and span. That is what makes
 * deleting `files[]` safe — the read-back is best-effort by construction, and an
 * `applied[]` that only ever mirrored it would have been a lossy replacement.
 *
 * DIVERGENCE, DISCLOSED (Revision-5 row): the read-back emits
 * `enclosing_symbol: {symbol, range}` while A.5.11 declares `string`. The object
 * is carried VERBATIM — it names a construct the caller can re-slice in one
 * call, and flattening it to the bare name would delete the range that makes it
 * actionable. `AppliedEntry.enclosing_symbol` widened to `string | {symbol,
 * range}` rather than the wire being narrowed to the type.
 */
function fullAppliedEchoRequested(body: Body, braceDelta?: number): boolean {
  // W2: compact slice proof is the default. Explicit review and safety
  // exceptions retain the complete post-edit slice.
  return body["review"] !== undefined
    || reclassificationReceipt(body) !== undefined
    || (braceDelta !== undefined && braceDelta !== 0)
    || body["warning"] !== undefined
    || body["leftoverLines"] !== undefined;
}

function addAppliedReadback(
  entry: AppliedEntry,
  code: string | undefined,
  body: Body,
  braceDelta: number | undefined,
): void {
  if (code === undefined) return;
  // The digest covers exactly the post-edit slice represented by range; the
  // first three lines provide a compact proof. Full code is retained only
  // for explicit review or the safety-triggered exceptions above.
  entry.slice_sha = shaOfText(code);
  entry.head = code.split(/\r?\n/).slice(0, 3);
  if (fullAppliedEchoRequested(body, braceDelta)) entry.code = code;
  if (braceDelta !== undefined) entry.brace_delta = braceDelta;
}

function appliedEntries(body: Body, rows: readonly Body[]): AppliedEntry[] {
  const readback = new Map<string, Body>();
  if (Array.isArray(body["applied"])) {
    for (const entry of body["applied"]) {
      if (!isRecord(entry)) continue;
      const path = str(entry["path"]);
      if (path !== undefined && !readback.has(path)) readback.set(path, entry);
    }
  }

  const entries: AppliedEntry[] = [];
  const emitted = new Set<string>();
  for (const row of rows) {
    const path = str(row["path"]);
    if (path === undefined || emitted.has(path)) continue;
    emitted.add(path);
    const served = readback.get(path);
    const lines = str(row["lines"]);
    const range = str(served?.["range"]) ?? lines;
    // `range` is REQUIRED (A.5.11) and there is no honest default for it, so an
    // entry that can name neither a read-back window nor an edited span is
    // dropped rather than defaulted. Its path is already in `core.paths`, which
    // is the field §4.2.1(5) makes load-bearing — nothing recoverable is lost.
    if (range === undefined) continue;
    const entry: AppliedEntry = { path, range };
    addAppliedReadback(
      entry,
      str(served?.["code"]),
      body,
      typeof served?.["brace_delta"] === "number" ? served["brace_delta"] : undefined,
    );
    const enclosing = served?.["enclosing_symbol"];
    if (typeof enclosing === "string" || isRecord(enclosing)) {
      entry.enclosing_symbol = enclosing as AppliedEntry["enclosing_symbol"];
    }
    const handle = str(row["handle"]);
    if (handle !== undefined) entry.handle = handle;
    if (lines !== undefined && lines !== range) entry.lines = lines;
    const delta = str(row["delta"]);
    if (delta !== undefined) entry.delta = delta;
    entries.push(entry);
  }
  // A read-back entry for a path no row named (an intent dispatch that edits a
  // file it does not list) still rides: it is served evidence about a completed
  // write, and dropping it would be the one deletion this module exists to
  // prevent.
  for (const [path, served] of readback) {
    if (emitted.has(path)) continue;
    const range = str(served["range"]);
    if (range === undefined) continue;
    const entry: AppliedEntry = { path, range };
    addAppliedReadback(
      entry,
      str(served["code"]),
      body,
      typeof served["brace_delta"] === "number" ? served["brace_delta"] : undefined,
    );
    const enclosing = served["enclosing_symbol"];
    if (typeof enclosing === "string" || isRecord(enclosing)) {
      entry.enclosing_symbol = enclosing as AppliedEntry["enclosing_symbol"];
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * RULE R: the three normalization path lists become one receipt.
 *
 * The two emitters disagree today and the disagreement is folded here rather
 * than at either producer: `applyEditsMulti` reports `normalized_escapes:
 * string[]` (WHICH paths were rewritten), while the single-edit engine reports
 * `normalized_escapes: true` (THAT this one path was). A.5.11 declares path
 * lists, and the single-edit form is promoted into one — the response knows its
 * own path, so the boolean was only ever a path list with the path left out.
 */
function normalizationReceipt(body: Body, rows: readonly Body[]): NormalizationReceipt | undefined {
  const ownPath = str(rows[0]?.["path"]) ?? str(body["path"]);
  const list = (key: string): string[] | undefined => {
    const value = body[key];
    if (value === true) return ownPath !== undefined ? [ownPath] : undefined;
    return stringArray(value);
  };
  const receipt: NormalizationReceipt = {};
  const merged = list("merged_paths");
  if (merged !== undefined) receipt.merged_paths = merged;
  const escapes = list("normalized_escapes");
  if (escapes !== undefined) receipt.normalized_escapes = escapes;
  const whitespace = list("normalized_whitespace");
  if (whitespace !== undefined) receipt.normalized_whitespace = whitespace;
  return Object.keys(receipt).length > 0 ? receipt : undefined;
}

/** The two triggers `ExecutionReclassification` emits (state/session.ts:228-233). */
const RECLASSIFICATION_TRIGGERS: ReadonlySet<string> = new Set(["create", "grounded-edit"]);

/**
 * RULE R + ruling 2: A.5.12 as a receipt on the write that actually happened.
 *
 * The in-process struct is `{from, to, trigger, certificate_id}`. `from`/`to`
 * are constants (`"answer"` -> `"edit"`) and carry no information a caller can
 * act on; `trigger` and `certificate_id` do, and `certificate_id` is the only
 * non-constant field — the correlation key back to the fence that re-typed the
 * call. Both are REQUIRED here, so a receipt that cannot name its certificate is
 * not emitted at all rather than shipped as a claim nothing can be checked
 * against.
 */
function reclassificationReceipt(body: Body): EditReclassification | undefined {
  const raw = body["reclassified"];
  if (!isRecord(raw)) return undefined;
  const trigger = str(raw["trigger"]);
  const certificateId = str(raw["certificate_id"]);
  if (trigger === undefined || !RECLASSIFICATION_TRIGGERS.has(trigger)) return undefined;
  if (certificateId === undefined) return undefined;
  return { trigger: trigger as EditReclassification["trigger"], certificate_id: certificateId };
}

/**
 * DISCLOSED DEVIATIONS on `edit.applied` (Revision-5 rows).
 *
 * A.5.11 closes the member at eight fields. Everything below is emitted by this
 * server today, is bound by the canonical agent guide or by a measured
 * regression fix, and has NO address in the appendix. The C2-3/C2-4 precedent
 * applies: keep reversibly, state what the deletion would lose, raise the row.
 * Deleting them on this server's own authority is the capability removal §0.2
 * forbids and §1.4(d) prices as breaking; carrying them is additive (§1.4(a))
 * and reversible before publication.
 *
 *   `path`, `lines`, `delta`  the SINGLE-edit response's own address. A.5.11's
 *      field list is written for the batch shape, where the same three fields
 *      live inside `files[]`. They are ALSO relocated into `applied[]` (ruling
 *      4) — kept at the top level as well because ~40 spec sites and the guide's
 *      own "Success `applied[]`+`brace_delta` is post-edit truth" idiom read the
 *      single-edit response positionally.
 *   `handle`, `sha`  the auto-minted post-edit whole-file handle and its short
 *      sha. P3a's note, verbatim: "handle absence induces follow-up round-trips
 *      = high-value field, LAST-stage shed."
 *   `bytes`, `total_lines`, `read_back`  the create path's L3/L4 affordance
 *      (2026-08-08). `read_back` is a bounded, executable `next` that replaces a
 *      whole follow-up read turn.
 *   `create_target`  L1's authorized-create disclosure: WHICH path was created
 *      and by WHICH workspace pin. The 2026-08-09 root-mismatch wave's output.
 *   `from`, `to`, `changed_files`, `total_replacements`, `skipped`
 *      `renameSymbol`'s result. A rename reports what it renamed, HOW MANY
 *      times per file, and what it deliberately did not touch; A.5.11 has a
 *      slot for none of it. `changed_files` cannot fold into `applied[]` the
 *      way `files[]` does: `RenameFileResult` is `{path, replacements}` with no
 *      line span, and `AppliedEntry.range` is required, so the per-file
 *      replacement counts would be dropped rather than relocated. The paths
 *      themselves are in `core.paths` either way.
 *   `review`, `verification`, `verify_note`, `closure`, `change_contract`,
 *   `unread_note`
 *      the verify-serving wave's attachments — the kit an agent builds its test
 *      harness from without a native read, and the closure ledger the guide
 *      binds to by name. `verify_note` is L4's top-level replica of the kit's
 *      deps-missing diagnosis, present only when `deps_installed` is false.
 *   `hint`  the one-shot `edits[]` batching hint, fired on a session's SECOND
 *      poolable single edit. Prose routing guidance; A.8 E-7 makes prose
 *      SHEDDABLE, not deletable — the same reasoning that keeps `hint` on
 *      `Refusal`'s advisory allowlist, so one field means one thing on both
 *      sides of the outcome.
 *   `changes`, `encrypted`, `warnings`, `artifact`, `members`  the
 *      artifact/ZIP edit path's result and disclosures (`ArtifactEditResult`,
 *      `write/artifactEdit.ts:22-30`). `changes` is that path's own
 *      replacement count — the CELL/mutation count, which has no line span and
 *      so cannot fold into `applied[]` — and `encrypted` states whether the
 *      rewritten container is still encrypted, which is the whole point of
 *      supplying an `outputCredentialRef`.
 *   `form`  Rule K's relocation of an edit body's OWN top-level `kind`
 *      (`"xlsx"`, `"file"`), which would otherwise shadow the D4 discriminator.
 *      Relocated by the funnel, carried here so the relocation is not
 *      immediately undone by this allowlist.
 *
 * `normalized_escapes` / `normalized_whitespace` / `merged_paths` are NOT here:
 * they are folded into `normalization` and deleted from the top level, which is
 * A.5.11's own instruction and loses nothing.
 */
const KEPT_ON_APPLIED = [
  "path", "lines", "delta", "handle", "sha",
  "bytes", "total_lines", "read_back", "create_target",
  "from", "to", "changed_files", "total_replacements", "skipped",
  "review", "verification", "verify_note", "closure", "change_contract", "unread_note",
  "changes", "encrypted", "warnings", "artifact", "members", "form", "hint",
  // `warning`, `leftoverLines` — B4.2's ORPHAN-TAIL disclosure
  // (server.ts's `attachOrphanTailWarning`). A `{handle, content}` replace on a
  // tiny file that leaves 1-3 unreplaced lines behind ships the warning plus
  // the exact leftover lines, so the model repairs inline instead of finding
  // the orphan several turns later. `warning` (singular) is NOT `warnings`
  // (plural) — that is the artifact-edit path's list, a different producer with
  // a different meaning — and `leftoverLines` is the content half of the same
  // disclosure: the warning alone says something was left, only this says
  // WHAT, and there is no other field on `edit.applied` that could.
  "warning", "leftoverLines",
] as const;

function projectApplied(body: Body, root: string | undefined): Body {
  const rows = editedRows(body);
  const applied = appliedEntries(body, rows);
  const paths = rows.map((row) => str(row["path"]) ?? "").filter((path) => path !== "");
  // Per-path identity for the workspace fingerprint: the post-edit handle when
  // one was minted (it is keyed on the post-edit sha), else the short sha the
  // single-edit path already reports, else the edited span. No file I/O.
  const identities = rows.map((row) => {
    const path = str(row["path"]) ?? "";
    const identity = str(row["handle"]) ?? str(body["sha"]) ?? str(row["lines"]) ?? "";
    return `${path}:${identity}`;
  });

  const projected: Body = {};
  const core = buildCore("edit.applied", paths, identities, [], root);
  if (core !== undefined) projected["core"] = core;
  // REQUIRED by A.5.11, so `[]` rides rather than the key being dropped. That
  // is not the absence E-1 forbids spelling `[]`: it is the value — "this
  // operation served no per-file read-back", which a `mode=rename` legitimately
  // does — and a required array a client must null-check is worse than an empty
  // one it can iterate.
  projected["applied"] = applied;
  const normalization = normalizationReceipt(body, rows);
  if (normalization !== undefined) projected["normalization"] = normalization;
  const reclassification = reclassificationReceipt(body);
  if (reclassification !== undefined) projected["reclassification"] = reclassification;
  // RULE E-1 / A.9.2 row 14: `checkpoint: string | null` at HEAD; `null` means
  // "no checkpoint was taken", and §1.3's absence convention spells that by
  // omitting the field. The producer's own `string | null` contract is
  // untouched — this is a wire projection, and `applyEditsMulti.spec.ts`'s
  // function-level pin stays exactly as it is.
  const checkpoint = str(body["checkpoint"]);
  if (checkpoint !== undefined) projected["checkpoint"] = checkpoint;
  keep(projected, body, ["applied_note"]);
  keep(projected, body, KEPT_ON_APPLIED);
  return projected;
}

// ---------------------------------------------------------------------------
// A.5.13 `edit.rolled_back` / A.5.14 `edit.state_unknown`
// ---------------------------------------------------------------------------

/**
 * The restore ledger, which BOTH failure members carry under their own name:
 * `attempted[]` on `edit.rolled_back`, `affected[]` on `edit.state_unknown`.
 * `RollbackFileState` itself carries over unchanged (A.5.13).
 */
function ledgerRows(body: Body): Body[] {
  return Array.isArray(body["rollback"]) ? body["rollback"].filter(isRecord) : [];
}

/**
 * DISCLOSED DEVIATIONS on the two failure members (Revision-5 rows).
 *
 *   `detail`  the prose the emitter wrote about WHY the write failed
 *      ("Cannot write file: EACCES …"). A.5.13/A.5.14 declare `recovery` (the
 *      repair steps) and no field for the cause. A caller told to repair
 *      without being told what broke has to guess; A.8 E-7 makes prose
 *      sheddable, not deletable.
 *   `path`  WHICH file's write failed. It is the one file NOT in the ledger —
 *      atomic writes leave it at its pre-edit bytes — so neither `attempted[]`
 *      nor `core.paths` names it, and without this the caller cannot tell which
 *      of its edits was the one that could not land.
 */
const KEPT_ON_LEDGER = ["detail", "path"] as const;

function projectLedgerMember(kind: Kind, body: Body, root: string | undefined): Body {
  const ledger = ledgerRows(body);
  const paths = ledger.map((row) => str(row["path"]) ?? "").filter((path) => path !== "");
  const identities = ledger.map((row) => {
    const path = str(row["path"]) ?? "";
    const state = str(row["state"]) ?? "";
    const sha = str(row["stuck_sha"]) ?? str(row["expected_sha"]) ?? "";
    return `${path}:${state}:${sha}`;
  });

  const projected: Body = {};
  const core = buildCore(kind, paths, identities, ledger, root);
  if (core !== undefined) projected["core"] = core;
  projected[kind === "edit.state_unknown" ? "affected" : "attempted"] = ledger;
  // A.5.14 makes `recovery` REQUIRED and A.5.13 makes it optional — §2.4's
  // normative invariant, and the emitter already satisfies it: every
  // `rollback-failed` return builds one from the ledger. Carried, never
  // synthesised: a repair instruction this module invented would be advice
  // about a disk it never looked at.
  keep(projected, body, ["recovery"]);
  // RULE 13: the two sentinel strings are DELETED. `code:"rollback-failed"` is
  // not a `RefusalCode` in v1 (A.5.13) and `workspace_state:
  // "workspace-state-unknown"` has no third home (A.2.2) — the KIND carries
  // both facts now, which is the whole point of splitting one flag pair into
  // two members. `error` goes with them: its machine half is the kind and its
  // prose half is `detail`.
  keep(projected, body, KEPT_ON_LEDGER);
  if (projected["detail"] === undefined) {
    const error = str(body["error"]);
    if (error !== undefined) projected["detail"] = error;
  }
  return projected;
}

// ---------------------------------------------------------------------------
// A.5.12 `edit.reclassified` — reserved
// ---------------------------------------------------------------------------

/**
 * RESERVED; NOT EMITTED AT HEAD (ruling 2, 2026-08-14). Every reclassification
 * this server produces rides `EditApplied.reclassification`, because every one
 * of them is attached to a write that already landed. This arm exists so a
 * future GENUINELY-no-write reclassification has a projection, and so the
 * closed fifteen-member vocabulary stays exhaustive.
 */
function projectReclassified(body: Body): Body {
  const raw = body["reclassified"];
  const action = isRecord(raw) ? str(raw["trigger"]) : str(raw);
  return { action: action ?? "" };
}

// ---------------------------------------------------------------------------
// The dispatcher
// ---------------------------------------------------------------------------

/**
 * Project one edit-family body onto its A.5.x member.
 *
 * `root` is the workspace this call resolved against, published by the edit
 * dispatcher through the protocol call context. It is an INPUT TO THE
 * FINGERPRINT ONLY: when it is absent the marker still mints (over the paths and
 * their per-file identities), because a missing root must degrade the binding,
 * never the report.
 *
 * WRAPPED, NOT TRUSTED. §4.2.1 makes a thrown exception here strictly worse than
 * a degraded projection: the response it would replace is the only record that
 * the write happened. On any failure the emitter's own body is returned
 * unchanged — less well-shaped, still true, still the right `kind`.
 */
export function projectEditBody(kind: Kind, body: Body, root: string | undefined): Body {
  try {
    if (kind === "edit.applied") return projectApplied(body, root);
    if (kind === "edit.rolled_back" || kind === "edit.state_unknown") {
      return projectLedgerMember(kind, body, root);
    }
    if (kind === "edit.reclassified") return projectReclassified(body);
    return body;
  } catch {
    return body;
  }
}
