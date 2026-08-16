/**
 * guardedWorkspace.ts — make an UNGUARDED write structurally unrepresentable.
 *
 * Why this module exists (2026-08-09 root-mismatch forensics): the write path's
 * safety rests on two dispatch-time checks — `checkCwdOrRefuse` (is the cwd the
 * caller named usable at all?) and `workspaceRoutingRefusal` (is "the
 * workspace" even determined, and does the target cross into a nested one?).
 * Six deprecated alias cases in `dispatchTool` had drifted for months without
 * ever running the first of those. Nothing caught it, because
 * `resolveWorkspaceRoot`'s documented contract is SILENT FALLBACK ("a fallback,
 * never an error") — an unguarded case does not crash, it quietly resolves
 * against the server's pinned root and reports plain success. The drift is
 * invisible by construction.
 *
 * The fix is to stop relying on every future case author remembering. Three
 * type-level tokens encode the guard stack as a state machine that TypeScript
 * checks:
 *
 *   guardCwd(args, root)                    -> CwdGuardPass
 *   guardWriteRouting(tool, args, cwdPass)  -> WriteRoutingPass   (needs the above)
 *   resolveGuardedWorkspaceRoot(..., pass)  -> GuardedWorkspaceRoot (needs the above)
 *
 * and every write-capable entry point — `createFile`, `applyEditsMulti`,
 * `searchReplaceEdit`, `readAndEdit`, `renameSymbol`, `editArtifact`, the
 * pathless edits, `applyIntent` and its four intents, plus
 * `safeResolveForWrite` — takes `GuardedWorkspaceRoot` rather than `string`.
 * A new dispatch case that resolves a root without running the guards has
 * nothing of that type to hand them, so it does not compile.
 *
 * Costs, deliberately: `GuardedWorkspaceRoot` IS the string at runtime (a
 * type-level brand — no wrapper object, no unwrapping, nothing to allocate per
 * call), and both pass tokens are module-level frozen singletons, so the
 * happy path allocates nothing at all. Only a refusal allocates, and a refusal
 * is already the cold path.
 *
 * Limits, stated honestly: a brand is a compile-time construct, so a
 * deliberate `as GuardedWorkspaceRoot` cast still bypasses it. That is exactly
 * what `__tests__/dispatchGuardConformance.spec.ts` is for — it enumerates the
 * real `dispatchTool` cases from source, forces every one of them to be
 * classified, and fails loudly on an unclassified case, an unguarded case, or
 * a write entry point whose signature was widened back to `string`.
 *
 * Pure module: no MCP/transport coupling. The two guards themselves stay in
 * server.ts (they need the handle table, the active root and the CLI config);
 * they are handed to this module ONCE, at server module-init, through
 * `installWorkspaceGuardStack`. A second install throws, so no dispatch case
 * can swap in a permissive stack of its own.
 */

/**
 * Type-only brands. `declare const` has no runtime representation at all, and
 * the symbols are not exported, so the branded types are unforgeable by
 * ordinary code: outside this module the only way to produce one is a cast
 * that names the type, which greps and reviews.
 */
declare const CWD_GUARD_PASS: unique symbol;
declare const WRITE_ROUTING_PASS: unique symbol;
declare const GUARDED_WORKSPACE_ROOT: unique symbol;

/** Proof that `checkCwdOrRefuse` ran for THIS call and did not refuse. */
export interface CwdGuardPass {
  readonly [CWD_GUARD_PASS]: "checkCwdOrRefuse";
}

/**
 * Proof that the routing/boundary guard also ran — or is inert because the
 * server was started without `--allow-write`, in which case the write tools
 * refuse on their own write gate and there is no routing decision to make.
 * Obtainable only from a `CwdGuardPass`, so the two guards cannot be run out
 * of order or in isolation.
 */
export interface WriteRoutingPass {
  readonly [WRITE_ROUTING_PASS]: "workspaceRoutingRefusal";
}

/**
 * An absolute workspace root that provably came out of the full guard stack.
 * Assignable TO `string` everywhere (it is one), never assignable FROM a plain
 * `string` — which is the whole point.
 */
export type GuardedWorkspaceRoot = string & {
  readonly [GUARDED_WORKSPACE_ROOT]: "workspace-guard";
};

/** A refusal payload, exactly as the guards already build it. */
export type GuardRefusal = Record<string, unknown>;

export type CwdGuardOutcome =
  | { readonly ok: false; readonly refusal: GuardRefusal }
  | { readonly ok: true; readonly pass: CwdGuardPass };

export type WriteRoutingOutcome =
  | { readonly ok: false; readonly refusal: GuardRefusal }
  | { readonly ok: true; readonly pass: WriteRoutingPass };

/**
 * The real guards, injected once. Signatures mirror server.ts's own
 * `checkCwdOrRefuse` / `workspaceRoutingRefusal` / `resolveWorkspaceRoot`
 * exactly, so installing them is a pass-through with no adapter logic that
 * could drift from what dispatch used to call directly.
 */
export interface WorkspaceGuardStack {
  readonly checkCwd: (rawCwd: unknown, fallbackRoot: string) => GuardRefusal | null;
  readonly routing: (
    toolName: string,
    args: Record<string, unknown>,
  ) => GuardRefusal | null;
  readonly resolve: (cwd: string | undefined, fallbackRoot: string) => string;
  /** `--allow-write`. Read lazily so install order never matters. */
  readonly writesEnabled: () => boolean;
}

let installed: WorkspaceGuardStack | undefined;

/**
 * Install the process's one guard stack. Called exactly once, from server
 * module-init. A second call throws rather than replacing: a dispatch case
 * that could re-install its own permissive guards would defeat the entire
 * point of routing through this module.
 */
export function installWorkspaceGuardStack(stack: WorkspaceGuardStack): void {
  if (installed !== undefined) {
    throw new Error("workspace guard stack is already installed");
  }
  installed = stack;
}

/** Test hook: drop the installed stack so a spec can install its own. */
export function __resetWorkspaceGuardStackForTests(): void {
  installed = undefined;
}

function requireStack(): WorkspaceGuardStack {
  if (installed === undefined) {
    throw new Error(
      "workspace guard stack is not installed — call installWorkspaceGuardStack() before dispatching",
    );
  }
  return installed;
}

// Frozen singletons: the pass path must not allocate. The empty object is the
// entire runtime footprint of both tokens, created once at module load.
const CWD_PASS_OUTCOME: CwdGuardOutcome = Object.freeze({
  ok: true as const,
  pass: Object.freeze({}) as unknown as CwdGuardPass,
});
const ROUTING_PASS_OUTCOME: WriteRoutingOutcome = Object.freeze({
  ok: true as const,
  pass: Object.freeze({}) as unknown as WriteRoutingPass,
});

/**
 * Stage 1 — run `checkCwdOrRefuse` against this call's `cwd`.
 *
 * Byte-identical to the direct call it replaces: the refusal object is the one
 * the guard built, handed straight to `toolStructuredError` by the caller.
 */
export function guardCwd(
  args: Record<string, unknown>,
  fallbackRoot: string,
): CwdGuardOutcome {
  const refusal = requireStack().checkCwd(args["cwd"], fallbackRoot);
  return refusal === null ? CWD_PASS_OUTCOME : { ok: false, refusal };
}

/**
 * Stage 2 — run the routing/boundary guard for a WRITE-capable call.
 *
 * Mirrors the dispatch's own `if (ALLOW_WRITE) { … }` gate: on a read-only
 * server edit_file must keep reporting that writes are disabled rather than a
 * routing refusal for a write it would never perform, so the guard is skipped
 * and the pass is still issued.
 */
export function guardWriteRouting(
  toolName: string,
  args: Record<string, unknown>,
  _cwdPass: CwdGuardPass,
): WriteRoutingOutcome {
  const stack = requireStack();
  if (!stack.writesEnabled()) return ROUTING_PASS_OUTCOME;
  const refusal = stack.routing(toolName, args);
  return refusal === null ? ROUTING_PASS_OUTCOME : { ok: false, refusal };
}

/**
 * Stage 3 — the ONLY production site of `GuardedWorkspaceRoot`.
 *
 * Identical resolution to the `resolveWorkspaceRoot(args["cwd"], activeRoot)`
 * call it replaces; the brand is a compile-time annotation on the same string.
 */
export function resolveGuardedWorkspaceRoot(
  args: Record<string, unknown>,
  fallbackRoot: string,
  _pass: WriteRoutingPass,
): GuardedWorkspaceRoot {
  return requireStack().resolve(
    args["cwd"] as string | undefined,
    fallbackRoot,
  ) as GuardedWorkspaceRoot;
}

/**
 * Re-brand a root ADOPTED mid-call from a handle's own mint root.
 *
 * The dispatch legitimately swaps the workspace after the guards have run —
 * a handle carries the root it was minted in, and a cwd-less call adopts it
 * (see resolveHandleWorkspace). Requiring an existing `GuardedWorkspaceRoot`
 * as the proof argument keeps that reachable only from a call whose guard
 * stack already ran to completion, so adoption cannot become a side door.
 */
export function adoptGuardedWorkspaceRoot(
  adopted: string,
  _guardedForThisCall: GuardedWorkspaceRoot,
): GuardedWorkspaceRoot {
  return adopted as GuardedWorkspaceRoot;
}

/**
 * TESTS ONLY — mint a guarded root for a unit test that drives a write tool
 * directly, with no dispatch and therefore no `args`/`activeRoot` to guard.
 *
 * Named to be greppable, and enforced: `dispatchGuardConformance.spec.ts`
 * fails if any file outside `__tests__/` references it.
 */
export function unsafeGuardedWorkspaceRootForTests(root: string): GuardedWorkspaceRoot {
  return root as GuardedWorkspaceRoot;
}
