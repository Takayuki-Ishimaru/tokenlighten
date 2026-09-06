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
// M2 (2026-09-05 R28 remediation): the shared recovery `resolveTaskPackQueryArg`
// already uses for a task_pack refusal whose OWN working set (qref/task_handle)
// did not resolve — see that function's doc comment in server.ts. Reused here,
// not reimplemented, so the two last-resort exits (a task_pack-specific one and
// this generic one) can never drift on the ONE rule that matters: never invent
// request text. Importing FROM server.ts INTO this leaf util is a real reverse
// edge (server.ts already imports `attachSupply` above), but it is safe: both
// bindings are consumed only inside function bodies executed at request time,
// never at module-evaluation time, so Node's live-binding ESM semantics
// resolve the cycle the same way `laneKey.ts`'s `runWithSessionLane` already
// does for `state/session.ts`.
import { taskPackRecoveryFor } from "../server.js";

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
/**
 * M2: `invalid-input` producers across server.ts spell the missing-argument
 * message several ways (`error`, `detail`, or a bare `reason`), and most of
 * them already set an explicit `field` at the call site — this only fills the
 * gap for the ones that do not (measured: `read_file {}` / `edit_file {}`'s
 * shared "path is required" refusal, which carries neither). Deliberately
 * NARROW: each pattern requires the OTHER two candidate field names to be
 * ABSENT from the same text, so an ambiguous message naming two fields at
 * once (e.g. "Either paths[] or query is required for mode=pack") infers
 * nothing rather than guessing — the same "never invent" discipline as the
 * `next` derivation below. Never overwrites a `field` a call site already set.
 */
function inferMissingField(refused: Record<string, unknown>): "path" | "targets" | "query" | undefined {
  if (refused["code"] !== "invalid-input") return undefined;
  const text = [refused["error"], refused["detail"], refused["reason"]]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  if (text === "") return undefined;
  const mentionsPath = /\bpaths?\b/iu.test(text);
  const mentionsTargets = /\btargets\b/iu.test(text);
  const mentionsQuery = /\bquery\b/iu.test(text);
  if (/\bpath\b[^.]*\bis required\b/iu.test(text) && !mentionsTargets && !mentionsQuery) return "path";
  if (/\bquery\b[^.]*\bis required\b/iu.test(text) && !mentionsPath && !mentionsTargets) return "query";
  if (/\btargets\b[^.]*\b(is required|must be)\b/iu.test(text) && !mentionsPath && !mentionsQuery) return "targets";
  return undefined;
}

// The five sanctioned `retry` transitions (`protocol/refusal.ts`'s
// RETRY_VALUES / `normalizeRetry`, which is module-private there): only one of
// these — kebab- or underscore-spelled — counts as a DECLARED retry below,
// exactly as `retryOf`'s step 0 treats it; any other string is not a signal.
const RETRY_TRANSITIONS: ReadonlySet<string> = new Set(["call", "challenge", "user-input", "new-task", "none"]);

/**
 * R28-FIX M2 (2026-09-05, narrowed): true iff `refused` carries any of the
 * SAME classification signals `protocol/refusal.ts`'s `retryOf` reads at its
 * §2.6 steps 1-6 (everything before the step-7 `"call"` default) — an
 * explicit `retry`, `required_action`, `query_mismatch`, `terminal`,
 * `awaiting_input`, `phase`, `discovery_closed`, `challenge_required`, or a
 * challenge affordance (`challenge`, or `unlock.challenge` /
 * `unlock.accepted_transitions` containing `"challenge"` — mirrors
 * `hasChallengeAffordance`). Deliberately NOT an import of `retryOf` itself:
 * `retryOf` first calls `routeUnlockAlternatives`, which MUTATES
 * `body["alternatives"]` as a side effect — reintroducing exactly the legacy
 * `alternatives[]` menu IL-W5b removed from this exit (see the comment on
 * the last-resort branch below) — so it cannot be called here merely to read
 * a verdict. A local mirror keeps the check side-effect-free.
 */
function hasRetryClassificationSignal(refused: Record<string, unknown>): boolean {
  const retryRaw = refused["retry"];
  if (typeof retryRaw === "string" && RETRY_TRANSITIONS.has(retryRaw.replace(/_/gu, "-"))) return true;
  // `retryOf` special-cases exactly these two `required_action` values
  // (steps 1 and 3); any other value falls through its ladder, so it is not
  // a classification signal here either.
  const requiredAction = refused["required_action"];
  if (requiredAction === "re-pack-new-epoch" || requiredAction === "unlock-or-rescope") return true;
  if (refused["query_mismatch"] === true) return true;
  if (refused["terminal"] === true) return true;
  if (refused["awaiting_input"] === true) return true;
  if (refused["phase"] === "awaiting-input") return true;
  if (refused["discovery_closed"] === true) return true;
  if (refused["challenge_required"] === true) return true;
  if (refused["challenge"] !== undefined && refused["challenge"] !== null) return true;
  const unlock = refused["unlock"];
  if (unlock !== null && typeof unlock === "object" && !Array.isArray(unlock)) {
    const record = unlock as Record<string, unknown>;
    if (record["challenge"] !== undefined && record["challenge"] !== null) return true;
    const transitions = record["accepted_transitions"];
    if (
      Array.isArray(transitions)
      && transitions.some((entry) => typeof entry === "string" && entry.includes("challenge"))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * R28-FIX M2 (2026-09-05, narrowed): true iff `refused` is "genuinely bare,
 * unclassifiable" — the ONLY case (beside a task_pack-shaped refusal,
 * checked separately by the caller) that still gets the task-pack
 * `retry:"new-task"` + `remaining` recovery built below. A refusal counts as
 * classified — and is left for `retryOf`'s own §2.6 ladder to type, which
 * defaults an otherwise-unclassified body to `"call"` (step 7: "fix the
 * named argument and re-issue" — the ~70 bare `toolError` sites' own
 * meaning) — the moment it carries EITHER:
 *   - a named `field` (checked by the caller, after `inferMissingField` has
 *     already run), or
 *   - `hasRetryClassificationSignal` above (the producer's own
 *     `awaiting_input`/`phase`/etc. still win), or
 *   - a producer-assigned `code` (A.7.1's canonical classification field,
 *     e.g. `mode=map`'s locate-abstain `{code:"ambiguous", detail:"ambiguous"}`
 *     — no `field`, no ladder signal, yet the caller already has a concrete,
 *     actionable classification to react to via `code`; measured:
 *     readCodeModes.spec.ts's mode=map abstain test). This THIRD condition is
 *     deliberately NOT a `retryOf` signal (retryOf never reads `code`) — it
 *     is what distinguishes a producer-classified refusal from a truly bare
 *     one like `toolError("boom")` (`{ok:false,error:"boom"}`, no `code` at
 *     all) or `{ok:false,reason:"handle-unknown"}` (a legacy `reason` alias,
 *     not the canonical `code` field), both of which stay eligible for
 *     recovery here (moduleBoundaries.spec.ts / attachSupply.spec.ts's
 *     original M2 pins).
 */
function isGenuinelyBareRefusal(refused: Record<string, unknown>): boolean {
  if (typeof refused["field"] === "string") return false;
  if (typeof refused["code"] === "string" && refused["code"] !== "") return false;
  return !hasRetryClassificationSignal(refused);
}

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
    // M2: fill in `field` before any of the branches below run, so a caller
    // gets the mechanical recovery hint even on the paths that return early
    // (the archive branch already sets `field` itself and is left untouched
    // — this never overwrites it).
    if (typeof refused["field"] !== "string") {
      const inferred = inferMissingField(refused);
      if (inferred !== undefined) refused["field"] = inferred;
    }
    const candidatesRaw = refused["candidates"];
    const pathRaw = refused["path"];
    const codeRaw = refused["code"];
    const reasonRaw = refused["reason"];
    const handleRaw = refused["handle"];
    const memberRaw = refused["member"];
    const isArchiveRefusal = typeof codeRaw === "string" && codeRaw.startsWith("archive-");
    const isCredentialArchiveRefusal =
      codeRaw === "archive-encrypted"
      || codeRaw === "archive-password-required"
      || codeRaw === "archive-password-invalid";
    const isClosedWorkspaceHandleRefusal =
      codeRaw === "handle-workspace-mismatch"
      || codeRaw === "handle-workspace-missing"
      || reasonRaw === "handle-workspace-mismatch"
      || reasonRaw === "handle-workspace-missing";
    // A blast-radius refusal deliberately moved its recovery recipe from the
    // executable `next` field to prose `detail` (P2 #4). Deriving a path read
    // here would silently put the forbidden/prose continuation back on the
    // wire, so preserve the producer's no-next contract.
    const isBlastRadiusRefusal = codeRaw === "blast-radius-precondition-required"
      || reasonRaw === "blast-radius-precondition-required";
    // Replaying a workspace-bound handle against the request cwd is not a
    // recovery: it deterministically reaches this refusal again. The refusal's
    // detail names the only safe transition (use the minting cwd, omit cwd, or
    // re-read by path), so keep the executable continuation absent here.
    if (isClosedWorkspaceHandleRefusal || isBlastRadiusRefusal) return refused;
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
      refused["next"] = canonicalToolCall("read_file", {
        mode: "symbol",
        path: pathRaw,
        symbol: firstCandidate,
      });
    } else if (hasPath) {
      // A refusal that names a known file but no candidates still gets one
      // executable default read of that exact path.
      refused["next"] = canonicalToolCall("read_file", { path: pathRaw });
    } else if (typeof handleRaw === "string" && handleRaw.length > 0) {
      refused["next"] = canonicalToolCall("read_file", { mode: "slice", handle: handleRaw });
    } else {
      // Last resort: nothing in the refusal names a file or a handle. IL-W5b
      // (DESIGN-v0.15-sf-intent-layers.md §11.4): `next` is the only
      // sanctioned alternative-transition carrier (AGENTS.md — `refusal` ->
      // `retry` is the ONLY sanctioned transition) — no legacy
      // `alternatives:[{mode:…}]` menu rides alongside it. This still rides
      // here (2026-07-30 refusal-economy pass) so no refusal — from ANY of
      // the ~70 toolError sites — can reach the wire without at least one
      // concrete next step.
      //
      // M2 (2026-09-05 R28 remediation): the placeholder this branch used to
      // build (`query: "<restate the request verbatim>"`) is not executable —
      // it is exactly what `containsPlaceholder` (protocol/refusal.ts, §2.6)
      // exists to catch, and a caught `next` is DELETED, not degraded
      // (`emittableToolCall` returns `undefined`). Every refusal that fell
      // through to this branch therefore shipped with NO `next` at all — the
      // measured `read_file {}` / `edit_file {}` "path is required" refusal
      // among them. `taskPackRecoveryFor` (server.ts) already fixed the exact
      // same defect for task_pack's own qref/task_handle refusals (G2); reuse
      // it here rather than re-deriving a second placeholder-avoidance rule.
      //
      // R28-FIX M2 (2026-09-05, NARROWED — this fixes the regression M2
      // itself introduced): M2's first cut ran this recovery unconditionally
      // for every refusal reaching this branch, which OVERWRITES the §2.6
      // ladder for every refusal whose sanctioned transition is something
      // other than `"new-task"` — `protocol/refusal.ts`'s `retryOf` honors an
      // explicit `retry` before its own ladder (step 1), so once this branch
      // wrote `retry:"new-task"` here, a refusal that should have classified
      // as `"call"` (a named `field` — the ladder's own step-7 default, "fix
      // the named argument and re-issue", is what the ~70 bare `toolError`
      // sites mean) or `"user-input"` (a producer-signalled ambiguity, e.g.
      // `awaiting_input:true`) reached the wire as `"new-task"` instead. Four
      // pre-existing pins broke this way (editCodeOperationIdPayloadBinding,
      // rangesBatch x2, readCodeModes).
      //
      // The recovery built here now applies ONLY when:
      //   (a) the refusal is itself task_pack-shaped (`mode:"task_pack"`) —
      //       unchanged from the original M2 cut: it echoes the caller's own
      //       `query` back verbatim ONLY here, never fabricated, since the
      //       caller supplied it in the very call being refused; or
      //   (b) `isGenuinelyBareRefusal` above says the body is genuinely bare
      //       and unclassifiable — no named `field`, no producer-assigned
      //       `code`, and none of the signals `retryOf`'s own ladder (steps
      //       1-6) reads. Retrying THAT shape with `"call"` would mean "fix
      //       the named argument" when there is no named argument, so the
      //       more honest transition is still `retry:"new-task"` +
      //       `remaining` prose (never a placeholder `next`) — the shape the
      //       original M2 fix was for, e.g. `toolError("boom")`'s bare
      //       `{ok:false,error:"boom"}` or `{ok:false,reason:"handle-unknown"}`
      //       (a legacy `reason` alias, not `code`). NOTE: `read_file {}` /
      //       `edit_file {}`'s "path is required" refusal is NOT bare — M2's
      //       `inferMissingField` names `field:"path"` first, so it classifies
      //       as `call` with no `remaining` (corpus ilw5brf2/ilw5brf3).
      //
      // Every OTHER non-task_pack refusal reaching this branch (a named
      // `field`, or a producer-classified `code`, or a `retryOf` ladder
      // signal) gets NO `retry`, NO `remaining`, NO `next` written here at
      // all — `retryOf` (§2.6, invoked downstream by the wire's refusal
      // projector) classifies it fresh from the body as it actually stands,
      // landing on `"call"` for a named field/code (step 7's default) or
      // honoring whatever the producer's own signal already sanctions
      // (steps 1-6) — never the task-pack-specific "start over" transition
      // this branch used to force onto every shape indiscriminately.
      const isTaskPackShapedRefusal = refused["mode"] === "task_pack";
      if (isTaskPackShapedRefusal || isGenuinelyBareRefusal(refused)) {
        const recovery = taskPackRecoveryFor(refused, isTaskPackShapedRefusal);
        if (recovery.next !== undefined) refused["next"] = recovery.next;
        if (refused["retry"] === undefined) refused["retry"] = recovery.retry;
        if (recovery.remaining !== undefined && refused["remaining"] === undefined) {
          refused["remaining"] = recovery.remaining;
        }
      }
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
    // round-22B finding 2 (fifth production-inertness layer, DESIGN-v0.15
    // §0.3(j)): this shallow copy USED TO silently break the SF closure-gate
    // arbiter, because `features/task-pack/sfSatisfaction.ts`'s SF pack
    // context was originally keyed ONLY by the exact object identity of
    // `result` (a `WeakMap`) — a copy is a different object, so every real
    // dispatch call lost the context here and `deriveCanonicalTaskDecision`
    // silently fell back to its SF-blind verdict on every call, regardless of
    // query or concern kind. Fixed at the root in `sfSatisfaction.ts`: the SF
    // context is now ALSO reachable via a stable token carried as an own,
    // enumerable, Symbol-keyed property on `result`, which `{...result}`
    // below copies onto `out` (verified: object spread copies own enumerable
    // symbol-keyed properties, not just string-keyed ones) — so this copy no
    // longer needs to special-case SF at all. Do not "fix" this by switching
    // to a deep clone or a JSON round-trip: both drop symbol-keyed properties
    // and would silently reopen this exact defect.
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
    // Fold its executable next call into the contract, then shed duplicates.
    if (isPack && out["execution_contract"] && typeof out["execution_contract"] === "object") {
      const contract = { ...(out["execution_contract"] as Record<string, unknown>) };
      const continuation = out["continuation"] as { stages?: Array<{ calls?: unknown[] }> } | undefined;
      const planned = continuation?.stages?.[0]?.calls?.[0];
      const rawNext = out["next"];
      const structuredNext = rawNext !== null && typeof rawNext === "object" && !Array.isArray(rawNext)
        ? rawNext
        : typeof rawNext === "string" ? nextStringToCall(rawNext) : undefined;
      const nextCall = planned && typeof planned === "object" ? planned : structuredNext;
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
