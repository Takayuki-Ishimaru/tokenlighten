/**
 * attachSupply.ts — DESIGN-v0.9 §4.7 shared read-side post-processor.
 *
 * There is no single response-envelope choke point (server.ts's
 * toolOk/toolError are thin JSON serializers; each read branch builds its own
 * object). attachSupply is the shared post-processor — modeled on
 * util/closureTracking.ts's attachClosure (threaded at the EDIT dispatch sites)
 * but for the READ dispatch sites (the four pack builders, resolveSlice data,
 * the artifact roster). Applied right before toolOk, it uniformly:
 *
 *   1. builds + budget-enforces the ContinuationPlan for task_pack results and
 *      DERIVES `next` from `stages[0].calls[0]` (single source of truth, §5.3);
 *   2. normalizes `inlined[]` — dedup, stable order, and DROP any entry whose
 *      named handle/path is NOT actually content-bearing in this same response
 *      (the itemization-verified half of the anti-self-serving metric, §11.4 —
 *      so a stamp can never outlive the body it names, e.g. a §4.6b surface
 *      body that trimToCap later stripped when the flag was off);
 *   3. guards the envelope FORBIDDEN_KEYS (envelope.spec.ts) at one point.
 *
 * An ok:false refusal skips (1)/(2) — there is no task_pack progress to fold,
 * nothing to itemize — but is NOT a pure short-circuit: it still gets (3),
 * and when it carries neither `next`/`next_call` nor a non-empty
 * `alternatives`, one is DERIVED here so a refusal never leaves the caller
 * with nothing to do next (the claimed-vs-verified gap, §11.4).
 *
 * Cheap by contract — NO I/O. It only inspects the already-built result. Errors
 * are swallowed (the raw result is returned) so an ordinary post-processing bug
 * can never turn a good read into a failure — except a deliberate task-pack
 * invariant violation (message prefix "task-pack invariant:"), which is
 * rethrown rather than swallowed; see the discovery-must-be-read-only check
 * below.
 */

import { canonicalToolCall } from "../protocol/envelope.js";
import {
  buildContinuation,
  deriveNextFromPlan,
  enforceContinuationBudget,
  nextStringToCall,
  type ContinuationSource,
} from "./continuation.js";

/**
 * Envelope key names banned as top-level fields in any successful response
 * (kept in lockstep with __tests__/envelope.spec.ts's FORBIDDEN_KEYS). None of
 * the v0.9 field names collide; this is a belt-and-suspenders guard so the one
 * shared exit enforces the invariant regardless of which branch built the
 * object.
 */
const FORBIDDEN_KEYS = [
  "tokenlighten",
  "tokenlighten:meta",
  "meta",
  "next_action",
  "edit_candidates",
  "native_fallback_tool",
];

/**
 * Identity of an ArtifactTaskPackSection body — the field each real emitter
 * keys its `inlined:["artifact-section:<path>#<fragment>"]` stamp on
 * (server.ts's xlsx-roster inline; readCodeTaskPack.ts's
 * extractArtifactBuildSection/buildArtifactTaskPack). xlsx sections carry
 * `sheet` directly (that union member has no `kind` tag — see
 * ArtifactTaskPackSection's own comment); docx/pptx/pdf sections carry a
 * `kind` tag and no top-level sheet/page id, so identity is the FIRST
 * extracted entry's heading/page — the same entry extractArtifactBuildSection
 * derives `sectionId` from, and the one every bounded candidate in
 * artifactSectionCandidates() keeps unchanged regardless of which size
 * variant the pack-cap fitting picked (2026-07-16a review round 2, DEFECT B).
 */
function artifactSectionIdentity(section: Record<string, unknown>): string | undefined {
  if (typeof section["sheet"] === "string") return section["sheet"];
  const kind = section["kind"];
  if (kind === "docx") {
    const sections = section["sections"];
    const first = Array.isArray(sections) ? (sections[0] as Record<string, unknown> | undefined) : undefined;
    return typeof first?.["heading"] === "string" ? (first["heading"] as string) : undefined;
  }
  if (kind === "pptx") {
    const slides = section["slides"];
    const first = Array.isArray(slides) ? (slides[0] as Record<string, unknown> | undefined) : undefined;
    return typeof first?.["heading"] === "string" ? (first["heading"] as string) : undefined;
  }
  if (kind === "pdf") {
    const pages = section["pages"];
    const first = Array.isArray(pages) ? (pages[0] as Record<string, unknown> | undefined) : undefined;
    return typeof first?.["page"] === "number" ? `page-${first["page"]}` : undefined;
  }
  return undefined;
}

/**
 * True when the inlined entry `"<kind>:<target>"` names content actually
 * present in this response. Keeps the `inlined[]` promise honest: the bench
 * verifies each named handle/path appears content-bearing here (§3.1/§11.4).
 */
function inlinedEntryIsContentBearing(entry: string, result: Record<string, unknown>): boolean {
  const colon = entry.indexOf(":");
  if (colon < 0) return false;
  const kind = entry.slice(0, colon);
  const target = entry.slice(colon + 1);
  if (target.length === 0) return false;

  if (kind === "surface-body") {
    const surfaces = result["surfaces"];
    if (!Array.isArray(surfaces)) return false;
    return surfaces.some((s) => {
      const sv = s as Record<string, unknown>;
      return sv["handle"] === target && typeof sv["code"] === "string" && (sv["code"] as string).length > 0;
    });
  }
  if (kind === "slice-cont") {
    // The continuation window rides on the SAME handle; the head handle must be
    // this response's handle and a `continued` body must be present.
    const cont = result["continued"] as Record<string, unknown> | undefined;
    const hasBody = !!cont && typeof cont["content"] === "string" && (cont["content"] as string).length > 0;
    return hasBody && result["handle"] === target;
  }
  if (kind === "artifact-section") {
    // target is "<path>#<fragment>" (fragment may be empty). Path sanity:
    // never a re-served path that escapes the workspace. 2026-07-16a review
    // round 2, DEFECT B: existence of ANY `section` used to be enough — a
    // stamp for data/a.xlsx#Meta survived a response that actually served
    // data/b.xlsx#Other. Verify IDENTITY, not just presence.
    //
    // Two real emitters, two response shapes for where the stamped path
    // lives (round-2 correction: the first cut only checked top-level
    // `path` and dropped every legitimate task_pack-shaped stamp, since
    // TaskPackResult carries no top-level `path` at all — replayCorpus's
    // ws3 case caught this):
    //  - server.ts's mode=artifact xlsx-roster inline: top-level `path` IS
    //    the artifact path.
    //  - readCodeTaskPack.ts's buildArtifactTaskPack (mode=task_pack): NO
    //    top-level `path` — the artifact lives in `surfaces[]` as a
    //    `{kind:"artifact", path, ...}` entry (ArtifactTaskPackSurface).
    const hashIdx = target.indexOf("#");
    const path = hashIdx < 0 ? target : target.slice(0, hashIdx);
    const fragment = hashIdx < 0 ? "" : target.slice(hashIdx + 1);
    if (path.length === 0 || path.includes("..") || path.startsWith("/")) return false;
    let pathMatches = result["path"] === path;
    if (!pathMatches) {
      const surfaces = result["surfaces"];
      pathMatches = Array.isArray(surfaces) && surfaces.some((s) => {
        const sv = s as Record<string, unknown>;
        return sv["kind"] === "artifact" && sv["path"] === path;
      });
    }
    if (!pathMatches) return false;
    let section = result["section"];
    if (section === undefined) {
      const artifactSections = result["artifact_sections"];
      if (Array.isArray(artifactSections)) {
        const matching = artifactSections.find((item) => {
          if (item === null || typeof item !== "object") return false;
          return (item as Record<string, unknown>)["path"] === path;
        }) as Record<string, unknown> | undefined;
        section = matching?.["section"];
      }
    }
    if (section === undefined || section === null || typeof section !== "object") return false;
    if (fragment === "") return true;
    const identity = artifactSectionIdentity(section as Record<string, unknown>);
    // extractArtifactBuildSection truncates the stamped fragment to 120
    // chars (readCodeTaskPack.ts) — mirror that truncation before comparing
    // so a long real heading still matches its (necessarily shortened) stamp.
    return identity !== undefined && identity.slice(0, 120) === fragment;
  }
  return false;
}

/** Dedup preserving first-occurrence order, dropping non-content-bearing entries. */
function normalizeInlined(raw: unknown, result: Record<string, unknown>): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    if (seen.has(item)) continue;
    if (!inlinedEntryIsContentBearing(item, result)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * Scrub FORBIDDEN_KEYS from a refusal (`ok:false`) payload and, when it
 * carries neither `next`/`next_call` nor a non-empty `alternatives`, derive
 * ONE concrete follow-up from whatever recovery hints it already carries —
 * never overwriting a field that already exists — so the caller always has
 * something concrete to do next. Exported as the single shared refusal exit:
 * attachSupply's ok:false branch (below) delegates here, and so does
 * server.ts's toolStructuredError, which is how MOST refusals actually leave
 * the server — they return `toolStructuredError(...)` directly and never
 * reach attachSupply at all (2026-07-16a review round 2, DEFECT A; live
 * repro pre-fix: `read_file mode=slice path=package.json` with no
 * range/symbol refused with a bare path, no next, no alternatives).
 */
export function supplyRefusalGuidance(result: Record<string, unknown>): Record<string, unknown> {
  const refused: Record<string, unknown> = { ...result };
  for (const k of FORBIDDEN_KEYS) {
    if (k in refused) delete refused[k];
  }
  const hasNext = refused["next"] !== undefined;
  const hasNextCall = refused["next_call"] !== undefined;
  const alternatives = refused["alternatives"];
  const hasAlternatives = Array.isArray(alternatives) && alternatives.length > 0;
  if (!hasNext && !hasNextCall && !hasAlternatives) {
    const candidatesRaw = refused["candidates"];
    const pathRaw = refused["path"];
    const codeRaw = refused["code"];
    const handleRaw = refused["handle"];
    const memberRaw = refused["member"];
    const isArchiveRefusal = typeof codeRaw === "string" && codeRaw.startsWith("archive-");
    const isCredentialArchiveRefusal =
      codeRaw === "archive-encrypted"
      || codeRaw === "archive-password-required"
      || codeRaw === "archive-password-invalid";
    const candidates = Array.isArray(candidatesRaw) ? (candidatesRaw as unknown[]) : undefined;
    const firstCandidate = candidates && typeof candidates[0] === "string" ? (candidates[0] as string) : undefined;
    const hasPath = typeof pathRaw === "string" && pathRaw.length > 0;
    const hasMember = typeof memberRaw === "string" && memberRaw.length > 0;
    const hasArchiveTarget = isArchiveRefusal && hasPath;
    if (hasArchiveTarget) {
      if (typeof refused["field"] !== "string") {
        if (isCredentialArchiveRefusal) {
          refused["field"] = "credentialRef";
        } else if (hasMember) {
          refused["field"] = "archive.member";
        } else {
          refused["field"] = "archive.path";
        }
      }
      return refused;
    }
    if (firstCandidate !== undefined && hasPath) {
      // Mirrors the not-found-symbol refusal's own recovery shape
      // (server.ts mode=slice/mode=symbol) — the same "read_file
      // mode=symbol path=... symbol=..." next producers use elsewhere.
      refused["next"] = `read_file mode=symbol path=${pathRaw} symbol=${firstCandidate}`;
    } else if (hasPath) {
      // 2026-07-16a review round 2, DEFECT A: a refusal that names a known
      // file but no recovery candidates (e.g. mode=slice's own "symbol or
      // range is required" refusal) still gets a concrete next — re-read
      // the same path at the routing default (mode=auto), the same
      // "read_file path=<path>" shape known-file recovery already uses
      // elsewhere (server.ts ~:2358).
      refused["next"] = `read_file path=${pathRaw}`;
    } else if (typeof handleRaw === "string" && handleRaw.length > 0) {
      refused["alternatives"] = [{ mode: "slice", handle: handleRaw }];
      refused["next"] = `read_file mode=slice handle=${handleRaw}`;
    } else {
      // Last resort: nothing in the refusal names a file or a handle. An
      // `alternatives` menu alone is a shape the caller has to interpret; a
      // literal call string is one it can issue. Both ride here (2026-07-30
      // refusal-economy pass) so no refusal — from ANY of the ~70 toolError
      // sites — can reach the wire without at least one concrete next step.
      refused["alternatives"] = [{ mode: "task_pack" }];
      refused["next"] = canonicalToolCall("read_file", { mode: "task_pack", query: "<restate the request verbatim>" });
    }
  }
  return refused;
}

/**
 * Post-process one read response. `result` is mutated on a shallow copy and
 * returned (attachClosure's convention). `workspace` is accepted for signature
 * parity with attachClosure and future path-scoping; the Wave-1 body needs no
 * I/O and no session/cache, so they are intentionally omitted.
 */
export function attachSupply(result: Record<string, unknown>, _workspace?: string): Record<string, unknown> {
  try {
    // A refusal skips the ContinuationPlan/inlined[] handling below (no
    // task_pack progress to fold, nothing to itemize), but it is NOT a pure
    // short-circuit: FORBIDDEN_KEYS still applies via supplyRefusalGuidance,
    // the shared derivation this function also feeds toolStructuredError's
    // OWN refusal exit (server.ts — 2026-07-16a review round 2, DEFECT A).
    if ((result as { ok?: boolean }).ok === false) {
      return supplyRefusalGuidance(result);
    }
    const out: Record<string, unknown> = { ...result };

    // (1) ContinuationPlan for task_pack results (skip the compact re-serve and
    // the answer pack — neither wants a residual-read plan). buildContinuation
    // returns undefined unless >=2 independent deterministic calls exist, so a
    // single-step residual keeps its `next` alone (§5.4).
    const isPack = out["mode"] === "task_pack";
    const isCompact = out["pack_unchanged"] === true;
    const route = out["route"] as { action?: string } | undefined;
    const isAnswer = route?.action === "answer_from_handles";
    if (isPack && !isCompact && !isAnswer && out["continuation"] === undefined) {
      const plan = buildContinuation(out as ContinuationSource);
      if (plan) {
        const trimmed = enforceContinuationBudget(plan);
        if (trimmed) {
          out["continuation"] = trimmed;
          const derived = deriveNextFromPlan(trimmed);
          if (derived !== undefined) out["next"] = derived; // §5.3 single source of truth
        }
        // rung-3 collapse (trimmed === undefined): drop the plan, keep `next`.
      }
    }

    // `execution_contract` is the machine-readable stop/continue authority.
    // Fold the legacy next string into it, then shed duplicated wire fields.
    if (isPack && out["execution_contract"] && typeof out["execution_contract"] === "object") {
      const contract = { ...(out["execution_contract"] as Record<string, unknown>) };
      const continuation = out["continuation"] as { stages?: Array<{ calls?: unknown[] }> } | undefined;
      const planned = continuation?.stages?.[0]?.calls?.[0];
      const parsedNext = typeof out["next"] === "string" ? nextStringToCall(out["next"] as string) : undefined;
      const nextCall = planned && typeof planned === "object" ? planned : parsedNext;
      if (
        contract["state"] !== "ready"
        && contract["next_call"] === undefined
        && nextCall !== undefined
      ) {
        const tool = (nextCall as { tool?: unknown }).tool;
        if (tool !== "read_file" && tool !== "search_files") {
          throw new Error(`task-pack invariant: discovery continuation must be read-only, got ${String(tool)}`);
        }
        contract["next_call"] = nextCall;
      }
      out["execution_contract"] = contract;
      if (contract["next_call"] !== undefined) delete out["next"];
      if (contract["readiness"] !== undefined) delete out["content_sufficiency"];
      const legacyRoute = out["route"];
      if (legacyRoute && typeof legacyRoute === "object" && !Array.isArray(legacyRoute)) {
        const compactRoute = { ...(legacyRoute as Record<string, unknown>) };
        if (compactRoute["reason"] === contract["reason"]) delete compactRoute["reason"];
        out["route"] = compactRoute;
      }
    }

    // (2) Normalize inlined[] — dedup + content-bearing verification.
    if ("inlined" in out) {
      const norm = normalizeInlined(out["inlined"], out);
      if (norm.length > 0) out["inlined"] = norm;
      else delete out["inlined"];
    }

    // (3) FORBIDDEN_KEYS guard at the one shared exit.
    for (const k of FORBIDDEN_KEYS) {
      if (k in out) delete out[k];
    }

    return out;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("task-pack invariant:")) throw error;
    return result;
  }
}
