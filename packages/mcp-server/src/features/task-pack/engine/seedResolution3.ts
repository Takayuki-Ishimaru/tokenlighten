// seedResolution — extracted implementation; imports point to the owning modules.
import type { LightAnswerTarget } from "./seedResolution.js";
import type { TaskPackArgs } from "../model.js";
import type { TaskPackResult } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import { buildSeededTaskPack } from "./seededPackBuilder.js";
import { computePackFingerprint } from "./packState2.js";
import { deriveCanonicalTaskDecision } from "../canonicalDecision.js";
import { handleTable } from "../../../util/handles.js";
import { namedScopeSignature } from "./packState2.js";
import { trace } from "../../../util/trace.js";

/**
 * Build the light answer pack: the seeded builder over the one file, then the
 * wire trim. A query-named file is seeded as the full pipeline seeds a
 * query-named file (`why:"query-named-file"`, required), and the captured
 * pack is also recorded under the request as the caller sent it — the
 * `namedScopeRequest` re-key the named-project rewrite uses — so the
 * dispatcher's receipt preflight finds it.
 */
export async function buildLightAnswerPack(
  args: TaskPackArgs,
  query: string,
  workspace: string,
  target: LightAnswerTarget,
): Promise<TaskPackResult> {
  handleTable.upsert({ kind: "repo", workspaceRoot: workspace });
  const seededArgs: TaskPackArgs = {
    ...args,
    path: undefined,
    paths: [{ path: target.path }],
    lightAnswer: target.origin,
  };
  if (target.origin === "query-named") {
    seededArgs.namedScopeRequest = {
      args,
      signature: namedScopeSignature(seededArgs, computePackFingerprint(seededArgs, workspace)),
    };
  }
  const result = await buildSeededTaskPack(seededArgs, query, workspace);
  const trimmed = trimLightAnswerWire(result, target.path);
  // Diagnostic only (TL_TRACE): which requests took the light path, for the
  // differential spec and for bench attribution. No path or query text.
  trace("light_answer_pack", {
    origin: target.origin,
    surfaces: result.surfaces.length,
    trimmed,
  }, workspace);
  return result;
}

/**
 * The members a one-file answer carries nothing with: the served row's `why`
 * (the request named the file; there was no selection to explain) and its
 * `symbol` (the whole file is the body). Applied only to the clean shape — one
 * surface, the target file, its whole body served, and a certified answer —
 * after the tail has booked and recorded the pack, so nothing but the wire
 * projection reads the trimmed object.
 */
export function trimLightAnswerWire(result: TaskPackResult, relPath: string): boolean {
  if (result.surfaces.length !== 1) return false;
  const surface = result.surfaces[0] as TaskPackSurface;
  if (surface.path !== relPath || typeof surface.code !== "string") return false;
  if ((surface.remaining_ranges?.length ?? 0) > 0) return false;
  if (deriveCanonicalTaskDecision(result)?.kind !== "act-answer") return false;
  delete surface.why;
  delete surface.symbol;
  return true;
}
