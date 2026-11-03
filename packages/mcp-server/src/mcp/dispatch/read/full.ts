import type { ToolCallResult } from "../../../protocol/result.js";
import { TINY_BYTES, TINY_LINES } from "../../../util/fullGovernor.js";
import { countLines } from "../../../util/countLines.js";
import { shaOfText, handleTable, shortSha } from "../../../util/handles.js";
import { deltaContextEnabled } from "../../../util/flags.js";
import { wasFullyServed, servedRangeCoverage, recordReadPath, servedRangeReceipt } from "../../../state/session.js";
import { elideDocCommentsForDisplay } from "../../../util/formatCompress.js";
import { languageForPath } from "../../../util/languages.js";
import { toolOk } from "../../../protocol/result.js";
import { attachSupply } from "../../../util/attachSupply.js";
import { coveredByField, coverageReceiptFor } from "../../../protocol/coverageReceipt.js";
import type { ExecutionReclassification, ExecutionCreateAuthorization, ExecutionFrontierMarker } from "../../../state/session.js";
import { deltaContextDecision, buildLedgerDifferenceFullPayload, servedContentReceipt, bookFullFileExpansionServe } from "../../../serverOwned/read-receipts.js";
import { resolveFullReadForPath, fullReadRefusal } from "../../../serverOwned/read-receipts2.js";

export interface read_fullPort {
  "mode": string;
  "content": string;
  "forceContentServe": boolean;
  "workspace": string;
  "filePath": string;
  "keepComments": boolean;
  "args": Record<string, unknown>;
  "executionGuard": { allowed: true; challenged?: true; resetForNewTask?: true; postReadyTrim?: true; reclassified?: ExecutionReclassification; createAuthorization?: ExecutionCreateAuthorization; frontierMarker?: ExecutionFrontierMarker; };
  "defaultResponseByteCeiling": number | undefined;
}
export async function read_full(port: read_fullPort): Promise<ToolCallResult | undefined> {
  const { mode, content, forceContentServe, workspace, filePath, keepComments, args, executionGuard, defaultResponseByteCeiling } = port;
if (mode === "full") {
        // Routes through resolveFullReadForPath (shared with the office
        // mode=full branch above and the paths[] batch below) — byte cap,
        // governor, and success/downgrade payloads are identical to the
        // pre-extraction inline logic. Note: this re-reads the file from disk
        // (resolveFullReadForPath does its own readFileSafe) rather than
        // reusing the `content` this outer scope already loaded for the
        // shared auto/symbol/full dispatch above — one extra read for the
        // mode=full path specifically, traded for one governor/cap
        // implementation instead of two copies that could drift apart.
        // W1 served-content receipt: this session already served every line of
        // this exact sha (via an earlier full serve, or via slices that
        // cumulatively covered the file), so the caller holds these bytes
        // already. Answer with the compact receipt instead of re-charging for
        // an identical body. Only `force_serve`/`allowFull` force real bytes
        // past it (DESIGN-v0.15 §6.3, R6) — canonical `content:"full"` alone
        // no longer does.
        //
        // Deliberately does NOT fire when wasFullyServed already knows about a
        // tracked full expansion of this exact sha, nor when the full governor
        // is disabled: resolveFullReadForPath's own decideFullRead/
        // buildFullDowngradePayload pipeline already owns "repeat mode=full of
        // the same sha" — WITH the correct downgraded_from/reason, and WITH
        // TL_FULL_GOVERNOR=0's "no full-read economization at all" contract
        // (readCodeFullDowngrade spec's "repeat read"/"governor disabled"
        // cases). This standalone check exists only for what that mechanism
        // cannot see: full coverage assembled from cumulative SLICE/SYMBOL
        // serves that never went through a tracked mode=full expansion.
        //
        // DESIGN-v0.15 §6.3 (R6) EXCEPTION: a TINY file (`TINY_BYTES`/
        // `TINY_LINES`) is EXEMPT from the governor's per-path/per-task full
        // caps by design (DESIGN-v0.8 §C4's own tiny-governor carve-out;
        // `WorkspaceSession.tinyFullExpansionsTotal`'s doc comment), so a
        // REPEAT `content:"full"` of a tiny file never reaches
        // `buildFullDowngradePayload`'s own wasFullyServed receipt at all —
        // `decideFullRead` keeps answering "allow" and `resolveFullReadForPath`
        // keeps re-serving fresh bytes, forever. That is exactly the R6 defect
        // (a byte-identical repeated full read never dedups) for the one file
        // size class the governor deliberately does not gate, so a tiny file
        // is never treated as "already handled by that other pipeline" here.
        const fullBytesForDedupCheck = Buffer.byteLength(content, "utf8");
        const fullIsTinyForDedup = fullBytesForDedupCheck <= TINY_BYTES && countLines(content) <= TINY_LINES;
        const fullSha = shaOfText(content);
        // B2 / V12-02: this partial-coverage difference branch is UNFLAGGED —
        // it already serves prior+residual for coverage assembled from earlier
        // slices, and once a ledger entry survives an edit it would serve the
        // post-edit delta with no further wiring. What the delta decision adds
        // is the two rules that branch has no way to know about: the
        // base-mismatch drop (an external write after the transformation) and
        // the size guard (a projection that would cost more than the body).
        // Both answer `"full"`, which SUPPRESSES the difference; `undefined`
        // (flag off, or an entry no edit ever carried) leaves it exactly as it
        // was.
        const fullDelta = forceContentServe || !deltaContextEnabled()
          ? undefined
          : deltaContextDecision({
              workspace, filePath, content, sha: fullSha, totalLines: countLines(content),
            });
        if (
          !forceContentServe
          && (!wasFullyServed(workspace, filePath, fullSha, keepComments) || fullIsTinyForDedup)
        ) {
          const fullTotalLines = countLines(content);
          // TL-REVIEW-2 (2026-10-06): a default-policy (`comments:"elide"`)
          // whole-file read never delivers the comment blocks its own
          // rendering elides — it discloses them as `elided` — so they are not
          // part of what "already holds this file" has to prove. Without this
          // the identical repeat of such a read found those blocks unheld and
          // re-served all of them raw (each labelled "doc-only file") instead
          // of answering `read.receipt`. Empty for `comments:"keep"`, whose
          // gate below is unchanged.
          const fullPolicyElided = keepComments
            ? []
            : elideDocCommentsForDisplay(content, languageForPath(filePath), false).elided;
          const fullCoverage = servedRangeCoverage(workspace, filePath, fullSha, fullTotalLines, fullPolicyElided, keepComments);
          if (fullCoverage !== undefined && !fullCoverage.complete && fullDelta?.decision !== "full") {
            const partial = await resolveFullReadForPath(
              workspace,
              filePath,
              args["allowFull"] === true,
              keepComments,
              { postReadyTrim: executionGuard.postReadyTrim === true },
            );
            if (!partial.ok) return fullReadRefusal(partial);
            const partialHandle = partial.data["handle"];
            if (
              partial.data["fullFileExpansion"] === true
              && typeof partialHandle === "string"
            ) {
              const difference = buildLedgerDifferenceFullPayload({
                workspace,
                filePath,
                content,
                handleId: partialHandle,
                sha: fullSha,
                keepComments,
                mode: "full",
                priorCoverage: fullCoverage,
                policyElided: fullPolicyElided,
              });
              if (difference !== undefined) {
                recordReadPath(workspace, filePath);
                return toolOk(attachSupply(difference, workspace));
              }
            }
            return toolOk(attachSupply(partial.data as Record<string, unknown>, workspace));
          }

          // FX-OH F3 (2026-09-04) / DESIGN-v0.15 §6.3: the SAME "already
          // fully served -> receipt" gate `buildFullDowngradePayload` above
          // guards with `!keepComments` (its own F3 block comment) — this
          // STANDALONE dedup check (cumulative slice/symbol coverage, or the
          // tiny-file governor exemption) was missing that guard. A prior
          // `content:"full"` repeat can make `fullCoverage.complete` true by
          // shipping a comment block'S REAL bytes (elideDocCommentsForDisplay's
          // doc-only fallback fires when an internal gap-fill window happens
          // to be 100% comment), which is a genuine wire delivery and so
          // correctly booked into `spans` — but that booking carries no
          // record of WHICH representation shipped, so it must never be read
          // as proof that a LATER `comments:"keep"` request's projection was
          // already delivered. `comments:"keep"` therefore falls through to a
          // real resolveFullReadForPath/buildFullServePayload serve below
          // (which renders `content` verbatim and re-books the whole file's
          // real spans via `bookFullFileExpansionServe`) THE FIRST TIME — but
          // NOT forever.
          //
          // P2-1 follow-up (2026-09-08): the tiny-file exemption
          // (`fullIsTinyForDedup`) means this standalone check runs on EVERY
          // repeat of a tiny file, so a hardcoded `keepComments ? undefined`
          // never dedupes a `comments:"keep"` tiny-file repeat — the one
          // shape of the R6 defect P2-1's own gates left unfixed. The
          // projection-aware completeness ledger (`wasFullyServed`, the same
          // booking Gate 1 above and this function's own outer `if` already
          // consult — not a second source of truth) proves whether THIS EXACT
          // sha was already fully served under `keepComments:true` before;
          // only then is the `spans`-derived receipt below safe to read as
          // proof of THIS projection (both ledgers are written together by
          // `bookFullFileExpansionServe` at serve time). A first `keep`
          // request — nothing recorded yet, or only an `elide` serve on
          // record — still falls through to a real serve, so the F3 dead end
          // above is unchanged for that case.
          const fullLedger = keepComments && !wasFullyServed(workspace, filePath, fullSha, true)
            ? undefined
            : servedRangeReceipt(workspace, filePath, fullSha, 1, fullTotalLines, fullTotalLines, fullPolicyElided, keepComments);
          if (fullLedger !== undefined) {
            const fullHandle = handleTable.upsert({
              kind: "file",
              path: filePath,
              workspaceRoot: workspace,
              sha: fullSha,
            });
            recordReadPath(workspace, filePath);
            // W-WIRE-2A: `fullLedger` already proves the whole file resident
            // (cumulative slice/symbol coverage subsumed by `servedRangeReceipt`)
            // — `covered_by` only decorates that already-correct receipt.
            const coveredBy = coveredByField(coverageReceiptFor({
              workspace,
              path: filePath,
              sha: fullSha,
              totalLines: fullTotalLines,
              want: "full",
              forceServe: forceContentServe,
            }));
            return toolOk(attachSupply(servedContentReceipt({
              mode: "full",
              path: filePath,
              handle: fullHandle.id,
              sha: shortSha(fullSha),
              range: `1-${fullTotalLines}`,
              ledger: fullLedger,
              ...(coveredBy !== undefined ? { extra: { covered_by: coveredBy } } : {}),
              workspace,
            }), workspace));
          }
        }
        const fr = await resolveFullReadForPath(
          workspace,
          filePath,
          args["allowFull"] === true,
          keepComments,
          {
            // BCF: thread the caller's own declared budget through so the
            // FIRST chunk of a large single-target `content:"full"` read is
            // already sized to it (`buildFullServePayload`'s
            // `callerBudgetBytes`) instead of always reaching for the fixed
            // FULL_SERVE_CHUNK_BYTES and relying on the emit-time shed
            // ladder's halving to cut it back — see that function's own doc
            // comment. `chunkToCallerBudget:true` ONLY here, never in the
            // mode=full paths[] batch loop above — see that flag's own doc
            // comment (`resolveFullReadForPath`) for the batch-loop
            // regression this scoping avoids. `undefined` maxBytes/maxTokens
            // when the caller declared none.
            chunkToCallerBudget: true,
            ...(defaultResponseByteCeiling !== undefined ? { chunkCeilingBytes: defaultResponseByteCeiling } : {}),
            ...(args["maxBytes"] !== undefined ? { maxBytes: Number(args["maxBytes"]) } : {}),
            ...(args["maxTokens"] !== undefined ? { maxTokens: Number(args["maxTokens"]) } : {}),
            forceServe: args["force_serve"] === true,
            postReadyTrim: executionGuard.postReadyTrim === true,
          },
        );
        if (!fr.ok) return fullReadRefusal(fr);
        // A COMPLETE full serve makes every line resident — record it so a
        // later slice/full/symbol of the same sha qualifies for the receipt
        // above. Only `fullFileExpansion` (the untruncated whole-file success
        // shape) qualifies; a governed head or downgrade must not claim
        // coverage it did not serve.
        //
        // F1 wave 2 (2026-08-02 serve-honesty): "every line resident" was false
        // for any commented file. The payload is
        // compressFormat(elideDocCommentsForDisplay(content, ...)), so a
        // multi-line comment block reaches the caller as ONE marker while all of
        // its lines were being booked as served — a later slice into exactly
        // those lines then answered `code_unchanged` for bytes nobody ever
        // received (reproduced by external review, 2026-08-02). Re-run the same
        // elision over the file window and book only the surviving spans.
        // Counting the RESPONSE's own lines would be wrong: compressFormat
        // collapses consecutive blank lines, so its line count no longer maps to
        // file lines. Fail-safe stays record-less.
        if (fr.data["fullFileExpansion"] === true) {
          bookFullFileExpansionServe(workspace, filePath, content, keepComments);
        }
        return toolOk(attachSupply(fr.data as Record<string, unknown>, workspace));
      }
  return undefined;
}
