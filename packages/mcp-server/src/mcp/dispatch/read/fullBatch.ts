import type { ToolCallResult } from "../../../protocol/result.js";
import { declareKind, canonicalToolCall } from "../../../protocol/envelope.js";
import { handleTable } from "../../../util/handles.js";
import { bindToResponseCeiling } from "../../../protocol/budget/wireBudget.js";
import { resolveCallerByteCeiling } from "../../../tools/readCodeModes.js";
import { readFileSafe, safeResolve } from "../../../util/safePath.js";
import { existsSync, statSync } from "node:fs";
import { capPendingRenderedExtent } from "../../../state/session.js";
import { toolOk } from "../../../protocol/result.js";
import type { ExecutionReclassification, ExecutionCreateAuthorization, ExecutionFrontierMarker } from "../../../state/session.js";
import { resolvePathsBatchEntry, resolveRangedPathsBatchEntry, OUTER_BATCH_RESERVE_BYTES, truncateResolvedItemToFit } from "../../../serverOwned/canonical-input.js";
import { resolveFullReadForPath } from "../../../serverOwned/read-receipts2.js";
import { bookFullFileExpansionServe } from "../../../serverOwned/read-receipts.js";

export interface read_fullBatchPort {
  "mode": string;
  "args": Record<string, unknown>;
  "workspace": string;
  "taskCredential": { credentialRef: string; credentialPassword: string; } | { credentialRef?: undefined; credentialPassword?: undefined; };
  "executionGuard": { allowed: true; challenged?: true; resetForNewTask?: true; postReadyTrim?: true; reclassified?: ExecutionReclassification; createAuthorization?: ExecutionCreateAuthorization; frontierMarker?: ExecutionFrontierMarker; };
  "defaultResponseByteCeiling": number | undefined;
  "keepComments": boolean;
}
export async function read_fullBatch(port: read_fullBatchPort): Promise<ToolCallResult | undefined> {
  const { mode, args, workspace, taskCredential, executionGuard, defaultResponseByteCeiling, keepComments } = port;
if (mode === "full" && Array.isArray(args["paths"]) && (args["paths"] as unknown[]).length >= 1) {
        // A.5.4: `ReadCodeFullBatchOutput` is `read.batch`, not `read.text` —
        // it carries a per-item ledger, which is exactly what splits the two.
        declareKind("read.batch");
        // Accepts either shape: a bare path string (the natural mode=full
        // form — no per-item range/symbol/purpose is meaningful here), or the
        // {path, ...} object form mode=pack/task_pack already advertise, so a
        // caller that reuses one paths[] value across modes still works.
        // FX-M1/E1: also resolves a `{handle}`-only entry (no `path`) via
        // `resolvePathsBatchEntry`, instead of coercing it to `""` — see that
        // helper's own doc comment for the mixed-batch defect this closes.
        const requestedEntries = (args["paths"] as unknown[]).map((p) => {
          const entry = resolvePathsBatchEntry(p, workspace);
          const held = entry.handle !== undefined ? handleTable.get(entry.handle) : undefined;
          // A bare handle asks for its own stored window under content:full.
          if (entry.range === undefined && entry.ranges === undefined && entry.symbol === undefined
            && held?.workspaceRoot === workspace && held.path === entry.path && held.range !== undefined) {
            return { ...entry, range: held.range };
          }
          return entry;
        });
        const allowFullRequested = args["allowFull"] === true;
        const officeOpts = {
          ...taskCredential,
          ...(args["maxBytes"] !== undefined ? { maxBytes: Number(args["maxBytes"]) } : {}),
          ...(args["maxTokens"] !== undefined ? { maxTokens: Number(args["maxTokens"]) } : {}),
          forceServe: args["force_serve"] === true,
          postReadyTrim: executionGuard.postReadyTrim === true,
        };

        const items: Record<string, unknown>[] = [];
        const omitted: Array<{ path: string; handle?: string; reason: string }> = [];
        // T2 (2026-08-27 field-eval): the same aggregate-byte backstop the
        // handles=[] batch just above got, applied here too -- T2 asks for it
        // "if the same plumbing reaches it", and it does, via the same
        // resolveCallerByteCeiling. `undefined` keeps this branch
        // byte-identical to today for every existing corpus/replay call (no
        // explicit maxBytes/maxTokens, no client-profile ceiling).
        const fullBatchCeiling = bindToResponseCeiling(
          resolveCallerByteCeiling(
            typeof args["maxBytes"] === "number" ? args["maxBytes"] : undefined,
            typeof args["maxTokens"] === "number" ? args["maxTokens"] : undefined,
            undefined,
          ),
          defaultResponseByteCeiling,
        );
        // TL-05: entries this loop deferred to the ceiling, in their
        // ORIGINAL selector shape (range/ranges/symbol preserved, or a bare
        // path for a whole-file entry) — never the widened `{path}`-only
        // shape `deriveNext`'s generic `omitted[].path` fallback would
        // otherwise build (readFamily.ts). Folded into this response's own
        // top-level `next` below, which `deriveNext` reads FIRST and so
        // never falls through to that generic, selector-losing fallback.
        const deferredForNext: Array<Record<string, unknown>> = [];

        // PASS 1: resolve every requested entry independently. A hard
        // failure (not found, escapes workspace, invalid range/symbol) folds
        // into `omitted` immediately — retrying the SAME call would not help.
        // Everything else is collected here so admission (pass 2) can see the
        // WHOLE picture before deciding what ships on THIS response —
        // unchanged from before this fix: r2-batch-coverage's own guarantee
        // ("no path is left unresolved because an earlier one already
        // tripped the ceiling") depends on every entry being resolved here
        // regardless of what pass 2 later decides about it.
        const resolved: Array<{
          path: string;
          originalSelector: Record<string, unknown>;
          items: Array<Record<string, unknown>>;
          bytes: number;
        }> = [];
        for (const requestedEntry of requestedEntries) {
          const p = requestedEntry.path;
          if (!p) {
            omitted.push(requestedEntry.handleReason !== undefined
              ? { path: p, handle: requestedEntry.handle, reason: requestedEntry.handleReason }
              : { path: p, reason: "path is required" });
            continue;
          }
          const hasSelector = requestedEntry.range !== undefined
            || requestedEntry.ranges !== undefined
            || requestedEntry.symbol !== undefined;
          const originalSelector: Record<string, unknown> = {
            path: p,
            ...(requestedEntry.range !== undefined ? { range: requestedEntry.range } : {}),
            ...(requestedEntry.ranges !== undefined ? { ranges: requestedEntry.ranges } : {}),
            ...(requestedEntry.symbol !== undefined ? { symbol: requestedEntry.symbol } : {}),
          };
          // TL-05 (plan §7.1): a target that named its own range/ranges/
          // symbol alongside `content:"full"` is served THAT WINDOW
          // unelided, never the whole file. `undefined` (archive member,
          // Office document, or a failed content read) falls through to the
          // ordinary whole-file route below, unchanged.
          const ranged = hasSelector
            // 2026-10-24 (read-page ceiling): and for a client with a response
            // ceiling a ranged entry joins the staged request's Q like a bare one
            // does. Without it a mixed batch (this entry ranged, its neighbours
            // bare) that the ceiling cuts is continued by the request's CURSOR,
            // which covers only the staged paths: the producer's own `next`, the
            // one place a ranged entry deferred whole is named, is replaced by it
            // and the window is owed by nothing (measured: a 200-line window of a
            // five-entry `content:"full"` batch never arrived). A client without a
            // ceiling keeps the staging it has always had.
            ? await resolveRangedPathsBatchEntry(
              workspace, p, requestedEntry,
              requestedEntries.some((entry) => entry.symbol !== undefined) || defaultResponseByteCeiling !== undefined,
            )
            : undefined;

          let resolvedItems: Array<Record<string, unknown>> | undefined;
          let failureReason: string | undefined;
          if (ranged !== undefined) {
            if (ranged.ok) {
              resolvedItems = requestedEntry.handle === undefined
                ? ranged.items
                : ranged.items.map((item) => ({ ...item, handle: requestedEntry.handle }));
            }
            else failureReason = ranged.reason;
          } else {
            // DESIGN-v0.15 §5.1/§5.3 (R2): EVERY requested path is resolved —
            // never skipped unread once an earlier oversized item trips the
            // ceiling. `resolveFullReadForPath` is what stages this path's
            // whole-file window into the batch's Q (via `buildFullServePayload`
            // -> `stageFullReadRequest` -> `appendReadRequestTarget`), so
            // skipping the call the way the old sticky "cap already hit, skip
            // every path after" gate did silently dropped every later target
            // from Q too — the exact defect `r2-batch-coverage` pins (a 3-target
            // batch whose 2nd/3rd targets, both tiny, never entered Q at all
            // because the 1st target alone already exceeded the budget).
            // 2026-10-24 (read-page ceiling): for a client with a response ceiling a
            // bare entry is governed to that ceiling HERE, at resolution -- its first
            // chunk is cut to it (less the batch wrapper) and the rest is staged for
            // the cursor, exactly as the singular `content:"full"` read does. The
            // admission below cannot do it afterwards: a whole-file item carries no
            // `range`, so the force-admitted last entry (`truncateResolvedItemToFit`)
            // ships whole -- a 22 KB file in a batch of two came back as a 25 KB reply
            // for an 18,432 B ceiling -- and fitting it there would book lines the
            // wire never carried (the served-range ledger is written in this pass).
            // A client without a ceiling keeps `officeOpts` as it was.
            const fr = await resolveFullReadForPath(
              workspace, p, allowFullRequested, keepComments,
              defaultResponseByteCeiling === undefined
                ? officeOpts
                : {
                  ...officeOpts,
                  chunkToCallerBudget: true,
                  chunkCeilingBytes: Math.max(1, defaultResponseByteCeiling - OUTER_BATCH_RESERVE_BYTES),
                },
            );
            if (fr.ok) {
              resolvedItems = [{ path: p, ...fr.data }];
              // FX-N (ruling (s), round-16 finding 2): this branch SHIPS bodies,
              // so it books them — the exact triad the single-path sibling runs,
              // through the shared helper. Only the untruncated whole-file shape
              // qualifies: `buildFullServePayload`'s governed head books its own
              // narrower spans inline, and a downgrade/artifact-redirect item
              // carries no body to book. The read is repeated (the file was just
              // read inside `resolveFullReadForPath`) rather than threaded out of
              // the resolution, so the helper sees the RAW bytes it must elide
              // and sha — `fr.data.content` is already the compressed display
              // text and would book spans that do not map to file lines.
              if (fr.data["fullFileExpansion"] === true) {
                // served-bytes: not-served (served-range ledger bookkeeping: the body was produced by resolveFullReadForPath)
                const bookable = await readFileSafe(p, workspace);
                if (bookable !== null) bookFullFileExpansionServe(workspace, p, bookable, keepComments);
              }
            } else {
              // A per-path hard failure (not found, escapes workspace, doc
              // extraction disabled) folds into omitted instead of aborting the
              // whole batch — matching the handles=[] batch precedent.
              // resolveFullReadForPath can't tell "missing" from "is a
              // directory" apart (readFileSafe's fs.readFile throws EISDIR,
              // caught the same as ENOENT, so both produce its generic "File
              // not found or outside workspace" wording) — batch-branch-only
              // re-stat to swap in an actionable reason when it really is a
              // directory, since that's a caller mistake worth naming rather
              // than reporting as a missing/escaped file.
              const dirAbs = safeResolve(p, workspace);
              const isDir = dirAbs !== undefined && existsSync(dirAbs) && statSync(dirAbs).isDirectory();
              failureReason = isDir
                ? 'is a directory — pass file paths; for discovery use tl_search_files {action:"tree", scope:{path:"<dir>"}} or tl_read_file {query:"...", targets:[{path:"<dir>"}]}'
                : fr.error;
            }
          }

          if (resolvedItems === undefined) {
            omitted.push({ path: p, reason: failureReason ?? "read failed" });
            continue;
          }
          const itemBytes = fullBatchCeiling !== undefined
            ? resolvedItems.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item), "utf8"), 0)
            : 0;
          resolved.push({ path: p, originalSelector, items: resolvedItems, bytes: itemBytes });
        }

        // PASS 2: admission. Each entry is judged INDEPENDENTLY against the
        // remaining budget (r2-batch-coverage's own contract: a small target
        // still ships even when an earlier, larger one already used or alone
        // exceeds the ceiling — readRequestContinuation.spec.ts's "delivers
        // every target of a 3-target content:full batch under one budget too
        // small for all three" pins this exactly), EXCEPT for one guarantee:
        // if NOTHING has been admitted by the LAST entry, that last entry
        // ships anyway, however large. TL-05 (plan §7.1): without that one
        // exception, a caller-declared ceiling smaller than EVERY requested
        // window (plan §7.1's C01 fixture: two ranged targets, each alone
        // over budget) omitted every entry on every hop and never made
        // progress — a worse outcome than one oversized entry shipping over
        // the caller's declared ceiling once. This is deliberately NOT "the
        // first entry always ships" (the A7 handles=[] batch's own rule,
        // upstream in this file): that rule would have re-broken
        // r2-batch-coverage's own fixture, whose first (and only oversized)
        // target must be DEFERRED while its two small siblings ship.
        //   "cap-exceeded"  — this ONE entry's own wire cost already exceeds
        //     the WHOLE declared ceiling; no admission order could have
        //     shipped it on this response.
        //   "aggregate response byte cap reached" — it would have fit a
        //     fresh ceiling, just not what THIS response has left.
        // Mirrors `readCodePack.ts`'s established two-tier vocabulary for the
        // same distinction.
        let fullBatchBytesSoFar = 0;
        for (let i = 0; i < resolved.length; i += 1) {
          const entry = resolved[i]!;
          const exceedsFresh = fullBatchCeiling !== undefined && entry.bytes > fullBatchCeiling;
          const exceedsRemaining = !exceedsFresh
            && fullBatchCeiling !== undefined
            && fullBatchBytesSoFar + entry.bytes > fullBatchCeiling;
          const overCeiling = exceedsFresh || exceedsRemaining;
          const isLastUnadmitted = overCeiling && items.length === 0 && i === resolved.length - 1;
          if (overCeiling && !isLastUnadmitted) {
            omitted.push({
              path: entry.path,
              reason: exceedsFresh ? "cap-exceeded" : "aggregate response byte cap reached",
            });
            deferredForNext.push(entry.originalSelector);
            continue;
          }
          // TL-05: the force-admitted LAST entry may still be individually
          // oversized (that is the whole point of admitting it anyway) — fit
          // it to the ceiling HERE, on a line boundary, rather than leaving a
          // second, competing truncation for the emit-time shed ladder to
          // discover. See `truncateResolvedItemToFit`'s own doc comment for
          // the dead end this avoids. A single, addressable resolved item
          // (a plain range/symbol/whole-file serve) is the reachable shape;
          // a `ranges[]` entry's several segment items are left to the
          // ladder unchanged (rare in the SAME response as a force-admit,
          // and "never split a segment" is the existing rule for it).
          //
          // BCF (eval-0929 §9): a NOTE ON SCOPE. An earlier version of this
          // fix also tried to TOP UP this last entry whenever room was left
          // over from an EARLIER admission (`items.length > 0`), not only
          // when nothing had shipped yet — spending budget that otherwise
          // sat unused. Reverted: `resolveRangedPathsBatchEntry` and
          // `resolveFullReadForPath` both book the FULL resolved span into
          // the served-range ledger in PASS 1, before PASS 2 (here) decides
          // how much of it actually reaches the wire — a truncation that
          // fires in the ORIGINAL, narrow `isLastUnadmitted` case (this
          // response's ONLY content) does not observably conflict with that,
          // but topping up a LATER entry after something else already
          // shipped measurably did (reproduced live: 10 lines silently
          // skipped, never re-served, because the ledger credited more than
          // the wire actually sent). Left for a follow-up once the ledger
          // booking itself moves to AFTER truncation — see this package's
          // final report.
          if (isLastUnadmitted && fullBatchCeiling !== undefined && entry.items.length === 1) {
            // BCF: `truncateResolvedItemToFit` fits ONE item to the budget it
            // is GIVEN (its own doc comment); `fullBatchCeiling` alone is the
            // caller's WHOLE-RESPONSE budget, not this one item's share of
            // it — the response also carries the outer wrapper
            // (`v`/`kind`/`omitted`/`completeness`/`limit`) and every OTHER
            // already-deferred target's own address riding the SAME `next`.
            // A byte-precise fit of the item ALONE (unlike the old halving
            // pass, whose coarse 50% steps left enough slack by accident to
            // absorb that overhead) can otherwise leave the FULL response
            // over budget, forcing a second, uncoordinated cut from the
            // emit-time ladder whose own per-entry `next` then disagrees
            // with this loop's stale producer-built `limit.next` (confirmed
            // live: a duplicate/overlapping continuation naming the same
            // tail range twice, one of the two entries missing
            // `budget`/`cwd`). Reserve for both — `OUTER_BATCH_RESERVE_BYTES`
            // plus the deferred siblings' selectors — deliberately generous;
            // the ladder remains a backstop for whatever this still misses.
            const siblingTargetsBytes = deferredForNext.reduce(
              (sum, selector) => sum + Buffer.byteLength(JSON.stringify(selector), "utf8"),
              0,
            );
            const itemBudget = Math.max(1, fullBatchCeiling - OUTER_BATCH_RESERVE_BYTES - siblingTargetsBytes);
            const fitted = truncateResolvedItemToFit(entry.items[0]!, itemBudget);
            if (fitted.deferredRange !== undefined) {
              // 2026-10-24 (read-page ceiling): and the settle is told where the cut
              // fell, for a client with a response ceiling -- see
              // `capPendingRenderedExtent` for the lines it would otherwise credit.
              const keptEnd = /^\d+-(\d+)$/.exec(String(fitted.item["range"] ?? ""))?.[1];
              if (defaultResponseByteCeiling !== undefined && keptEnd !== undefined) {
                capPendingRenderedExtent(workspace, entry.path, Number(keptEnd));
              }
              items.push(fitted.item);
              deferredForNext.push({ path: entry.path, range: fitted.deferredRange });
              fullBatchBytesSoFar += Buffer.byteLength(JSON.stringify(fitted.item), "utf8");
              continue;
            }
          }
          // Each item carries the same fields a single-path mode=full
          // response would (content + fullFileExpansion:true on success, or
          // a downgraded skeleton/artifact-redirect shape carrying its own
          // path/reason/handle), or — for a ranged entry — the same fields
          // the A7 handles=[] batch's own item shape carries (handle, range,
          // content, truncated, sha) — request order preserved.
          items.push(...entry.items);
          if (fullBatchCeiling !== undefined) fullBatchBytesSoFar += entry.bytes;
        }

        const completeness = omitted.length === 0 ? "complete" : items.length === 0 ? "empty" : "partial";
        return toolOk({
          mode: "full",
          items,
          omitted,
          completeness,
          // TL-05 (plan §7.1): named ONLY when this loop deferred at least
          // one entry to the ceiling above — never fabricated from an
          // `omitted[]` reason that is not recoverable by retrying
          // (not-found, is-a-directory, handle-unknown, ...).
          // `readFamily.ts`'s `deriveNext` reads this `next` FIRST, ahead of
          // its own generic `omitted[].path` fallback, so a ranged entry's
          // window survives the recovery call instead of being silently
          // widened back to the whole file.
          ...(deferredForNext.length > 0
            ? { next: canonicalToolCall("tl_read_file", { targets: deferredForNext, content: "full" }) }
            : {}),
        });
      }
  return undefined;
}
