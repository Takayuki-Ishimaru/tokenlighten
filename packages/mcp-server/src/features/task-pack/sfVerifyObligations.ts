// W-VERIFY-GEN (2026-09-02): pure obligation-set derivation for
// DESIGN-v0.15-sf-verification-first.md §3.1/§3.2/§3.4 and
// DESIGN-v0.15-semantic-frontier-plan.md Wave 4's W-VERIFY-GEN row.
//
// WHAT THIS FILE DOES. `deriveVerifyObligations` turns the OUTPUT of the
// existing `buildVerificationManifest` (packages/mcp-server/src/util/
// verificationPack.ts) plus a `TaskChangeContract`'s own edit obligations
// into `TaskVerifyObligation[]` (packages/types/src/mcp/task-pack.ts
// ~L190-213, landed by W-VERIFY-TYPES). The caller (readCodeTaskPack.ts's
// `buildTaskChangeContract`) attaches the result to
// `TaskChangeContract.verify_obligations` ONLY when `TL_SF_VERIFY_FIRST` is
// on; this module itself is unconditional and pure so every rule below is
// unit-testable without a flag, a workspace, or a running server.
//
// NO NEW DISCOVERY (Wave 4 acceptance criterion for W-VERIFY-GEN: "adding no
// new discovery logic is grep-auditable"). Every fact this module reads was
// already computed by `buildVerificationManifest`:
//   - `VerificationSurface.role`/`.references`/`.code` (referencing tests —
//     `references` is already the basename/stem match verificationPack.ts
//     performs; this file does not re-derive it).
//   - `CompileFact.missing_includes` (compile-fact integrity).
//   - (RETIRED by FX-OH F6, 2026-09-04) `ToolchainInfo.test_entry` /
//     `HarnessInfo.build_command.text`. These fed the `workspace-command`
//     obligation and are no longer read at all; verificationPack.ts still
//     produces them for its own consumers.
//   - `VerificationManifest.verify_strategy` (already "syntax_only+diff"
//     exactly when no referencing test was found for ANY edited path).
//
// `workspaceDeclaredCommands` is the one input NOT read off a
// `VerificationManifest`. FX-OH F6 (2026-09-04) retired its only consumer —
// the `kind:"workspace-command"` obligation — so the field is now INERT: it is
// kept on the input type as a caller injection seam (and to keep every
// existing call site compiling), and `ToolchainInfo.test_entry` /
// `HarnessInfo.build_command.text` are likewise no longer read by this module.
// See the F6 block comment beside `unprovenObligation` for why.
//
// NON-GOALS (design §2, restated as an implementation constraint): this file
// must never encode a fixture-specific string (a planted bench assertion
// name, a specific test file's identifier, a repository-specific path). The
// companion spec greps for exactly that. It also never executes anything,
// never treats a solver's self-reported exit code as evidence, never adds a
// 16th `decision.kind`, and never adds a new execution-typestate reason.
//
// SATISFACTION STATES THIS FILE DOES NOT ATTEMPT. Design §3.3 describes a
// `"served"` -> `"served-untested"` transition that depends on whether any
// TL call touching the same evidence was observed AFTER an earlier serve —
// i.e. cross-call session history. `deriveVerifyObligations` is pure and
// sees exactly one `VerificationManifest` snapshot, so it can only tell
// "bytes are inline THIS call" (-> `"served"`) from "bytes are not inline
// this call" (-> `"unproven"`, pending a later call to reclassify). The
// `"served-untested"` half of that state machine is intentionally left to
// whichever wave carries session-served-history (W-VERIFY-CLOSURE per the
// Wave 4 table); this file cannot honestly report it without inventing state
// it does not have.

import { createHash } from "node:crypto";
import type { TaskChangeObligation, TaskVerifyObligation } from "@tokenlighten/types";
import type {
  CompileFact,
  VerificationManifest,
  VerificationSurface,
} from "../../util/verificationPack.js";
import type { SfConcernAnchor, SfStructuralConcern } from "./sfConcerns.js";
import { sfConcernId } from "./sfConcerns.js";

/** Design §6 risk / plan.md §4.3: keeps the array small and wire-cheap. */
export const MAX_VERIFY_OBLIGATIONS = 8;

/** A single obligation this derivation reasons about; a narrow `Pick` so a test needs no full contract. */
export type VerifyObligationParent = Pick<TaskChangeObligation, "id" | "path" | "action">;

/**
 * Test-friendly override for the (FX-OH F6-retired) workspace-command evidence
 * class. Accepted and ignored — see the file doc above.
 */
export interface WorkspaceDeclaredCommand {
  /** The command text itself (e.g. "npm test", "pytest", "ctest"). */
  readonly command: string;
  /** Free-text provenance folded into the obligation's evidence note; defaults to `command`. */
  readonly note?: string;
}

export interface DeriveVerifyObligationsInput {
  /** Only `.obligations` is read. */
  readonly changeContract: { readonly obligations: readonly VerifyObligationParent[] };
  /**
   * `buildVerificationManifest`'s own, unmodified output. `undefined` means
   * the toolchain domain is unsupported or nothing was walkable — per design
   * §6 this derives NOTHING (never "unproven" spam for a language TL cannot
   * verify at all). FX-OH F6: `workspaceDeclaredCommands` no longer rescues
   * that branch, because the only obligation it fed has been retired.
   */
  readonly verificationManifest: VerificationManifest | undefined;
  readonly workspaceDeclaredCommands?: readonly WorkspaceDeclaredCommand[];
  /**
   * Ruling F8 (FX-OH2, 2026-09-04): `verify_obligations` may only ride a pack
   * whose `decision.kind` will project to `act.edit` (readCodeTaskPack.ts's
   * `phase:"prepared"` reads exactly `change_contract.status === "ready"`) or,
   * transitively, a `read.closure` response built from one -- never a
   * `discover`/`await_input` pack. Measured on the sealed SF13 replay: a
   * `referencing-test`/`diff-review` obligation pair rode the pack's FIRST,
   * still-discovering response and cost 1,816 B the caller could not yet act
   * on (ruling (mm)). Defaults to `true` — every EXISTING call site (and this
   * module's own pre-F8 tests) constructs one obligation set per already-ready
   * contract, so an omitted field changes nothing for them. `false` short-
   * circuits to `[]` before any manifest field is even read, so a discovering
   * caller pays no cost for what it cannot use yet.
   */
  readonly ready?: boolean;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * Deterministic id: a hash of `kind` + `targets`, namespaced by the parent
 * `TaskChangeObligation.id` so the id stays 1:1 traceable to the obligation
 * it covers (design §3.1: "id は対応する親 TaskChangeObligation.id と1:1対応
 * させる"). The `sfv:<parentId>:` prefix is also how
 * `verifyObligationsToSfConcerns` below finds which obligations belong to
 * which parent — treat the prefix as a stable format, not an implementation
 * detail, if this function's output shape changes.
 */
function obligationId(
  parentId: string,
  kind: TaskVerifyObligation["kind"],
  targets: readonly string[],
): string {
  return `sfv:${parentId}:${kind}:${shortHash(targets.join("|"))}`;
}

function matchingTestSurfaces(
  manifest: VerificationManifest,
  editPath: string,
): VerificationSurface[] {
  return manifest.surfaces.filter((s) => s.role === "test" && s.references.includes(editPath));
}

function referencingTestObligation(
  parent: VerifyObligationParent,
  surfaces: readonly VerificationSurface[],
): TaskVerifyObligation {
  const targets = [...new Set(surfaces.map((s) => s.path))];
  // Design §3.2: only bytes actually inline on THIS manifest count as
  // "served" — a handle-only reference (`body:"omitted"`/`"served-earlier"`)
  // is discovery, not proof the solver received the test body.
  const served = surfaces.some((s) => typeof s.code === "string");
  return {
    id: obligationId(parent.id, "referencing-test", targets),
    kind: "referencing-test",
    targets,
    satisfied_by: served ? "served" : "unproven",
    evidence: surfaces.map((s) => ({ handle: s.handle, path: s.path })),
    source: "verification-manifest",
  };
}

// Round-11 (2026-09-03) correction: a SINGLE compile_facts snapshot is not a
// before/after comparison — design §3.2/§3.4's `satisfied_by:"observed"` is
// reserved for a fact TL itself observed changing (or a TL-produced
// verification receipt). No before/after compile-fact comparison exists in
// this codebase today (grep for `compileFactsBefore`/"before/after compile":
// absent), so this is honestly `"unproven"` — a single resolved snapshot is
// still evidence worth citing (the note already said so), just not proof of
// anything TL watched happen.
function compileFactsObligation(
  parent: VerifyObligationParent,
  fact: CompileFact,
): TaskVerifyObligation {
  return {
    id: obligationId(parent.id, "compile-facts", [fact.path]),
    kind: "compile-facts",
    targets: [fact.path],
    satisfied_by: "unproven",
    evidence: [{ path: fact.path, note: "compile-fact-only; execution unproven; no before/after comparison observed" }],
    source: "verification-manifest",
  };
}

// ---------------------------------------------------------------------------
// FX-OH F6 (2026-09-04) — `kind:"workspace-command"` IS NOT AN OBLIGATION.
//
// WHAT WAS HERE. `workspaceCommandFromDeclared` / `workspaceCommandFromManifest`
// minted a `kind:"workspace-command"`, `satisfied_by:"unproven"` obligation
// whose `targets` were a ready-to-paste command line (a clang++ compile+link
// invocation naming nine .cpp files, on the measured SF13 first wire).
//
// WHY THEY ARE GONE. TL cannot observe a workspace command: it never runs one,
// and `satisfied_by` can therefore never leave `"unproven"`. What shipped was
// not a verification fact but a WORK ORDER, and the r4 SF13 replay shows a
// solver reading it as one — four tail turns spent on syntax-only, compile,
// run and unlink, 757 B of new content for 17.9 % of that cell's whole
// resident-byte-turn cost, and directly against the shipped guide's own "a
// passing relevant test or diff ends the task". The three kinds that remain
// (`referencing-test`, `compile-facts`, `diff-review`) are all TL-observable:
// each names workspace EVIDENCE this server itself resolved.
//
// NOT A DEAD END (ruling (cc)). Dropping the branch does not remove the
// obligation — the same edited path now falls through to `unprovenObligation`
// below (`referencing-test`, `unproven`, no evidence, because none exists), so
// the verify-first closure gate still WITHHOLDS `closure-complete` and
// discloses the gap. Closure by disclosure, never by silence.
//
// `workspaceDeclaredCommands` survives on `DeriveVerifyObligationsInput` as a
// caller injection seam (see the file header); with no consumer left it is
// simply inert, and a manifest-less call derives nothing at all.
// ---------------------------------------------------------------------------

/** Design §3.1 rule 4: nothing TL-observable was found for this obligation at all. No `evidence` — none exists. */
function unprovenObligation(parent: VerifyObligationParent): TaskVerifyObligation {
  return {
    id: obligationId(parent.id, "referencing-test", [parent.path]),
    kind: "referencing-test",
    targets: [parent.path],
    satisfied_by: "unproven",
    source: "change-contract",
  };
}

/**
 * Design §3.1/§3.3 `diff-review`: made explicit whenever the manifest's own
 * `verify_strategy` already degraded to `"syntax_only+diff"` — i.e. no
 * referencing test was found for ANY edited path, not per-obligation. One
 * entry per change_contract, not per obligation (there is nothing more
 * specific than "diff review" to attach to a single file in this case).
 */
function diffReviewObligation(editObligations: readonly VerifyObligationParent[]): TaskVerifyObligation {
  const targets = editObligations.map((o) => o.path);
  return {
    id: `sfv:diff-review:${shortHash(targets.join("|"))}`,
    kind: "diff-review",
    targets,
    satisfied_by: "unproven",
    source: "change-contract",
  };
}

/**
 * FX-OH F5 (2026-09-04) — an `evidence[].note` that merely REPEATS one of the
 * obligation's own `targets[]` is pure duplication on the wire.
 *
 * Measured: 731 of the 1,816 B `TL_SF_VERIFY_FIRST` added to SF13's sealed
 * first wire were one command string sent twice — once as `targets[0]` and
 * once, byte for byte, as `evidence[0].note`. 40 % of the whole flag delta,
 * carrying zero information the row did not already state.
 *
 * The rule is GENERAL and applies to every producer in this file, present and
 * future: drop a `note` string-equal to one of the same obligation's targets;
 * keep the entry when it still carries a `path`/`handle` (the addressing is
 * the evidence), drop the entry entirely when `note` was all it had. `evidence`
 * itself is removed when nothing survives — absent evidence is honest, an
 * empty array is noise.
 */
export function stripSelfDuplicateEvidenceNotes(
  obligation: TaskVerifyObligation,
): TaskVerifyObligation {
  const evidence = obligation.evidence;
  if (evidence === undefined || evidence.length === 0) return obligation;
  const targets = new Set(obligation.targets);
  let changed = false;
  const kept: NonNullable<TaskVerifyObligation["evidence"]> = [];
  for (const entry of evidence) {
    if (entry.note === undefined || !targets.has(entry.note)) {
      kept.push(entry);
      continue;
    }
    changed = true;
    const { note: _dropped, ...rest } = entry;
    if (Object.keys(rest).length > 0) kept.push(rest);
  }
  if (!changed) return obligation;
  const { evidence: _old, ...base } = obligation;
  return kept.length > 0 ? { ...base, evidence: kept } : base;
}

export function deriveVerifyObligations(input: DeriveVerifyObligationsInput): TaskVerifyObligation[] {
  // Ruling F8: `ready:false` means this pack is still discovering (its
  // `decision.kind` will project to `discover`/`await_input`, never
  // `act.edit`) -- nothing here is actionable yet, so derive nothing.
  if (input.ready === false) return [];
  const editObligations = (input?.changeContract?.obligations ?? []).filter((o) => o.action === "edit");
  if (editObligations.length === 0) return [];

  const manifest = input.verificationManifest;
  // §6 risk: no manifest at all (unsupported toolchain domain, or nothing
  // walkable) means nothing is knowable — emit nothing rather than
  // "unproven" noise for every obligation. FX-OH F6: a caller-supplied
  // `workspaceDeclaredCommands` no longer rescues this branch, because the
  // only obligation it could have produced was the `workspace-command` kind
  // this wave retired.
  if (manifest === undefined) {
    return [];
  }

  const out: TaskVerifyObligation[] = [];
  for (const parent of editObligations) {
    const surfaces = matchingTestSurfaces(manifest, parent.path);
    if (surfaces.length > 0) {
      out.push(referencingTestObligation(parent, surfaces));
      continue;
    }
    const fact = manifest.compile_facts.find(
      (f) => f.path === parent.path && f.missing_includes.length === 0,
    );
    if (fact !== undefined) {
      out.push(compileFactsObligation(parent, fact));
      continue;
    }
    // FX-OH F6: the `workspace-command` branch stood here. See the block
    // comment above — an unrunnable command line is a work order, not an
    // obligation, so this path now falls through to the honest `unproven`.
    out.push(unprovenObligation(parent));
  }

  if (manifest.verify_strategy === "syntax_only+diff") {
    out.push(diffReviewObligation(editObligations));
  }

  // Deterministic truncation: generation order above is itself deterministic
  // (obligation order in, then the one diff-review entry last), so a plain
  // slice is a stable, reproducible bound rather than an arbitrary drop.
  // FX-OH F5: the self-duplicate scrub is the LAST pass, so it covers every
  // producer above without any of them having to remember it.
  return out.slice(0, MAX_VERIFY_OBLIGATIONS).map(stripSelfDuplicateEvidenceNotes);
}

// ---------------------------------------------------------------------------
// SF-state hook (best-effort; see readCodeTaskPack.ts's call site doc)
// ---------------------------------------------------------------------------
//
// `sfConcerns.ts` already reserves `kind:"verify"` in `SfConcernKind`, and
// `sfSatisfaction.ts`'s `applyResponseToConcerns` already special-cases it
// (the `edit.applied` branch pushes a verify concern's id onto `openVerify`
// instead of nominating it satisfied; the `read.closure` branch nominates it
// satisfied when covering evidence is present). Both of those files are
// W-SATISFACTION's, and out of W-VERIFY-GEN's file scope — this function
// only PRODUCES `SfStructuralConcern`-shaped seeds from the obligations
// above; it never calls `openSfTask`/`markConcernSatisfied` itself. The
// caller (readCodeTaskPack.ts) threads the result into
// `applySemanticFrontierState` via a new, purely data-passing parameter.
//
// Binding choice: `bindings:[<the edited path>]` (single element), matching
// the exact shape `sfSatisfaction.spec.ts`'s own "edit.applied: a verify
// concern on the edited path is OPENED, never satisfied" case already
// exercises. `editCovers` requires EVERY binding to be an applied path
// (`bindings.every(...)`); a single-element binding is what lets the
// ORDINARY edit of the source file (which never also touches a test file in
// the same call) correctly flip this concern into `openVerify`, matching
// design §3.3's "the edit CREATED this obligation; it did not discharge it."
// `evidenceCovers` (the `read.closure` nomination path) also reads
// `bindings`, so the same path additionally gates the future closure-side
// discharge once served evidence names it.
export function verifyObligationsToSfConcerns(
  editObligations: readonly VerifyObligationParent[],
  verifyObligations: readonly TaskVerifyObligation[],
): SfStructuralConcern[] {
  const out: SfStructuralConcern[] = [];
  for (const parent of editObligations) {
    const prefix = `sfv:${parent.id}:`;
    const owned = verifyObligations.some((o) => o.id.startsWith(prefix));
    if (!owned) continue;
    const anchor: SfConcernAnchor = { kind: "path", path: parent.path };
    out.push({
      id: sfConcernId("verify", anchor),
      claim: `verification for ${parent.path}`,
      origin: "source-requirement",
      blockedBy: [],
      predicate: { kind: "any-grounded-evidence" },
      kind: "verify",
      anchor,
      disposition: "verify",
      // Conservative: `required:false` keeps this concern out of any
      // existing required-obligation gating this file has not audited
      // (obligationDag.ts / reasoningIrV2.ts are out of W-VERIFY-GEN's file
      // scope). The `openVerify`/closure-disclosure behavior above already
      // does not depend on `required`.
      required: false,
      advisory: false,
      bindings: [parent.path],
      source: "explicit-target",
    });
  }
  return out;
}
