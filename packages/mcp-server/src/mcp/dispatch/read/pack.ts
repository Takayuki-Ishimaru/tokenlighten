import type { ToolCallResult } from "../../../protocol/result.js";
import { recordReadMode } from "../../../state/session.js";
import { declareKind } from "../../../protocol/envelope.js";
import { buildTaskPack } from "../../../features/task-pack/engine/taskPackEntry.js";
import { ALLOW_WRITE } from "../../../runtime/config.js";
import { inheritedTaskProfileArgs } from "../../../runtime/requestState.js";
import { attachSupply } from "../../../util/attachSupply.js";
import { toolOk, toolError } from "../../../protocol/result.js";
import { readCodePack } from "../../../tools/readCodePack.js";
import { taskPackAdmission } from "../../../serverOwned/read-admission.js";
import { parseMcpLang, parseTaskProfile, servedTextForRoute } from "../../../serverOwned/read-admission2.js";
import { canonicalTaskBindingOf, taskContractScopeOf } from "../../../serverOwned/task-binding2.js";
import { QUERY_CANDIDATE_POLICY_INPUT } from "../../../serverOwned/canonical-input2.js";
import { SMALL_WINDOW_RESERVE_FORCE } from "../../../serverOwned/canonical-input.js";
import { recordTaskPackSurfaceReads, recordTaskPackExecution } from "../../../serverOwned/task-pack-wire.js";

export interface read_packPort {
  "mode": string;
  "args": Record<string, unknown>;
  "defaultResponseByteCeiling": number | undefined;
  "workspace": string;
  "taskCredential": { credentialRef: string; credentialPassword: string; } | { credentialRef?: undefined; credentialPassword?: undefined; };
  "resolvedPath": string | undefined;
  "resolvedSymbol": string | undefined;
}
export async function read_pack(port: read_packPort): Promise<ToolCallResult | undefined> {
  const { mode, args, defaultResponseByteCeiling, workspace, taskCredential, resolvedPath, resolvedSymbol } = port;
if (mode === "pack") {
        const hasPaths = Array.isArray(args["paths"]) && (args["paths"] as unknown[]).length > 0;
        const hasQuery = typeof args["query"] === "string" && (args["query"] as string).length > 0;
        const includeClosureArg = args["includeClosure"];
        const shouldPromote =
          !hasPaths &&
          hasQuery &&
          includeClosureArg !== false;

        if (shouldPromote) {
          const admission = taskPackAdmission(args, defaultResponseByteCeiling);
          if (admission !== undefined) return admission;
          recordReadMode(workspace, "task_pack");
          // A.5.1: see the sibling mode-less promotion above. `mode=pack` maps
          // to `read.batch` by A.5.4, but a PROMOTED pack is a task pack and
          // must say so.
          declareKind("read.task_pack");
          const promoteLang = parseMcpLang(args["lang"]);
          const taskBinding = canonicalTaskBindingOf(args, workspace);
          const result = await buildTaskPack(
            {
              ...taskCredential,
              // DESIGN-v0.15-sf-intent-layers.md §4.1: see the sibling
              // promotion branches above.
              writeAllowed: ALLOW_WRITE,
              ...((args as Record<PropertyKey, unknown>)[QUERY_CANDIDATE_POLICY_INPUT] === true
                ? { queryCandidatePolicy: "unanchored" as const } : {}),
              ...(taskBinding !== undefined ? { taskBinding } : {}),
              // PI-09 close-out: the explicit "I lost my context" switch.
              ...(args["force_serve"] === true ? { forceServe: true as const } : {}),
              ...((args as Record<PropertyKey, unknown>)[SMALL_WINDOW_RESERVE_FORCE] === true ? { forceServeCallerTargetsOnly: true as const } : {}),
              query: String(args["query"]),
              ...(parseTaskProfile(args["taskProfile"]) ? { taskProfile: parseTaskProfile(args["taskProfile"]), ...(inheritedTaskProfileArgs.has(args) ? { taskProfileInherited: true as const } : {}) } : {}),
              ...(resolvedPath ? { path: resolvedPath } : {}),
              ...(resolvedSymbol ? { symbol: resolvedSymbol } : {}),
              ...(promoteLang ? { lang: promoteLang } : {}),
              ...(typeof args["maxBytes"] === "number" ? { maxBytes: args["maxBytes"] } : {}),
              ...(typeof args["maxTokens"] === "number" ? { maxTokens: args["maxTokens"] } : {}),
              ...(defaultResponseByteCeiling !== undefined ? { clientDefaultByteCeilingHint: defaultResponseByteCeiling } : {}),
            },
            workspace,
          );
          // Feature 1 (2026-07-12b2): task_pack surfaces with embedded code count as read.
          recordTaskPackSurfaceReads(workspace, result);
          // DESIGN-v0.9 §4.7: shared read-side post-processor stamps
          // continuation (derives next), normalizes/verifies inlined[], guards
          // FORBIDDEN_KEYS. content_completeness/inlined were already set inside
          // dedupeTrimAndPersist; this is the uniform read-side exit.
          const supplied = attachSupply(result as unknown as Record<string, unknown>, workspace);
          recordTaskPackExecution(
            workspace,
            typeof args["query"] === "string" ? args["query"] : "",
            supplied,
            taskContractScopeOf(args),
          );
          return toolOk(supplied);
        }

        if (hasPaths && hasQuery) {
          return toolError("paths[] and query are mutually exclusive for mode=pack", { code: "invalid-input" });
        }
        if (!hasPaths && !hasQuery) {
          return toolError("Either paths[] or query is required for mode=pack", { code: "invalid-input" });
        }

        recordReadMode(workspace, "pack");

        const lang = parseMcpLang(args["lang"]);

        const packInput = {
          mode: "pack" as const,
          ...(hasPaths ? {
            // Same bare-string coercion as mode=task_pack's paths[] mapping
            // above (and mode=full's batch, ~:6871) — a bare string entry has
            // no .path and used to collapse to path:"", so readCodePack
            // silently read an empty path instead of the caller's file.
            paths: (args["paths"] as unknown[]).map((p) => {
              if (typeof p !== "object" || p === null) return { path: String(p) };
              const e = p as Record<string, unknown>;
              return {
                path: String(e["path"] ?? ""),
                ...(e["range"] !== undefined ? { range: String(e["range"]) } : {}),
                ...(e["symbol"] !== undefined ? { symbol: String(e["symbol"]) } : {}),
                ...(e["purpose"] !== undefined ? { purpose: String(e["purpose"]) } : {}),
              };
            }),
          } : {}),
          ...(hasQuery ? { query: String(args["query"]) } : {}),
          ...(resolvedPath !== undefined && !hasPaths ? { path: resolvedPath } : {}),
          ...(resolvedSymbol !== undefined && !hasPaths ? { symbol: resolvedSymbol } : {}),
          ...(lang ? { lang } : {}),
          ...(args["maxTokens"] !== undefined ? { maxTokens: Number(args["maxTokens"]) } : {}),
        };
        // served-bytes: readServedText
        // Residual R79 (AA1) / AB1 round 11: `readCodePack` slices the text this
        // callback hands it and SERVES the slice, at four sites its own module
        // never gated. Rather than convert four internal sites, the reader
        // itself is the served-bytes policy: `readCodePack` reads `null` as
        // "unreadable" and already turns that into an `omitted` entry. Reachable
        // only through the legacy `mode:"pack"` dialect today (the canonical
        // `content:*` spellings never resolve to it), which is exactly why it
        // went unmeasured for five rounds.
        const result = await readCodePack(packInput, workspace, async (rel) => {
          // served-bytes: readServedText
          const verdict = await servedTextForRoute(rel, workspace);
          return verdict === null || verdict.kind === "undecodable" ? null : verdict.text;
        });
        return toolOk(result);
      }
  return undefined;
}
