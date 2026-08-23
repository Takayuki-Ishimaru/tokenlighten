/**
 * reasoningIrV2Tombstone.spec.ts — V11-04 acceptance: hypothesis tombstones.
 *
 * Plan §7 V11-04 acceptance rows covered here:
 *   - "strong Tombstone false rejection 0件" → a strong tombstone is
 *     UNCONSTRUCTIBLE without a complete scope AND direct absence evidence;
 *   - "SHA／generation変更後のstale Tombstone 0件" → the fail-closed sweep;
 *   - "challenge／reviveを常に許可する" → revive is ungated.
 */

import { describe, it, expect } from "vitest";
import type { DirectAbsenceProof, EvidenceIdentity } from "@tokenlighten/types";
import {
  createStrongTombstone,
  createWeakTombstone,
  liveStrongTombstones,
  reviveTombstone,
  sweepStaleTombstones,
  tombstoneValidity,
} from "../task-state/tombstone.js";
import { evidence } from "./helpers/irV2Fixtures.js";

const catalog: EvidenceIdentity[] = [
  evidence("abs", "src/searched", "direct"),
  evidence("weak", "src/guessed", "heuristic"),
  evidence("struct", "src/outline", "structural"),
];

const absence: DirectAbsenceProof = {
  evidenceId: "abs",
  scopeComplete: true,
  observedMatches: 0,
  provider: "search_files/find",
};

const common = {
  id: "t1",
  claim: "no rate-limiter exists under src/api",
  reviveCondition: "a new file matching *limiter* appears under src/api",
  validityKeys: [{ type: "index-generation", value: "gen-7" }],
};

describe("V11-04 weak tombstones — deprioritization only", () => {
  it("constructs from an INCOMPLETE scope (it licenses nothing)", () => {
    const made = createWeakTombstone({
      ...common,
      scope: { kind: "query", description: "bounded search", complete: false },
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.tombstone.strength).toBe("weak");
    expect(made.tombstone.absence).toBeUndefined();
  });

  it("still requires an id, a claim, a revive condition and a validity key", () => {
    const scope = { kind: "query" as const, description: "s", complete: false };
    expect(createWeakTombstone({ ...common, id: " ", scope })).toMatchObject({ ok: false, reason: "empty-id" });
    expect(createWeakTombstone({ ...common, claim: "", scope })).toMatchObject({ ok: false, reason: "empty-claim" });
    expect(createWeakTombstone({ ...common, reviveCondition: "", scope }))
      .toMatchObject({ ok: false, reason: "empty-revive-condition" });
    expect(createWeakTombstone({ ...common, validityKeys: [], scope }))
      .toMatchObject({ ok: false, reason: "missing-validity-keys" });
  });
});

describe("V11-04 strong tombstones — complete scope + direct absence, or nothing", () => {
  const completeScope = { kind: "paths" as const, description: "src/api/**", paths: ["src/api"], complete: true };

  it("constructs from a complete scope plus grounded direct absence", () => {
    const made = createStrongTombstone({ ...common, scope: completeScope, absence, evidenceCatalog: catalog });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.tombstone.strength).toBe("strong");
    expect(made.tombstone.absence).toEqual(absence);
    // The absence evidence is always among the refs, even if the caller forgot.
    expect(made.tombstone.evidenceRefs).toContain("abs");
  });

  it("REFUSES an incomplete scope", () => {
    const result = createStrongTombstone({
      ...common,
      scope: { ...completeScope, complete: false },
      absence,
      evidenceCatalog: catalog,
    });
    expect(result).toMatchObject({ ok: false, reason: "incomplete-scope" });
  });

  it("REFUSES an absence proof that does not claim a complete scope", () => {
    const partial = { ...absence, scopeComplete: false } as unknown as DirectAbsenceProof;
    expect(createStrongTombstone({ ...common, scope: completeScope, absence: partial, evidenceCatalog: catalog }))
      .toMatchObject({ ok: false, reason: "incomplete-scope" });
  });

  it("REFUSES an absence proof that observed matches", () => {
    const sawSomething = { ...absence, observedMatches: 3 } as unknown as DirectAbsenceProof;
    expect(createStrongTombstone({ ...common, scope: completeScope, absence: sawSomething, evidenceCatalog: catalog }))
      .toMatchObject({ ok: false, reason: "absence-observed-matches" });
  });

  it("REFUSES absence evidence that is not in the catalog", () => {
    expect(createStrongTombstone({
      ...common,
      scope: completeScope,
      absence: { ...absence, evidenceId: "ghost" },
      evidenceCatalog: catalog,
    })).toMatchObject({ ok: false, reason: "absence-not-grounded" });
  });

  it("REFUSES heuristic and structural absence evidence — only direct proves an absence", () => {
    expect(createStrongTombstone({
      ...common, scope: completeScope, absence: { ...absence, evidenceId: "weak" }, evidenceCatalog: catalog,
    })).toMatchObject({ ok: false, reason: "absence-evidence-not-direct" });
    expect(createStrongTombstone({
      ...common, scope: completeScope, absence: { ...absence, evidenceId: "struct" }, evidenceCatalog: catalog,
    })).toMatchObject({ ok: false, reason: "absence-evidence-not-direct" });
  });
});

describe("V11-04 staleness — fail-closed, stale tombstone 0", () => {
  const t = (() => {
    const made = createWeakTombstone({
      ...common,
      scope: { kind: "query", description: "s", complete: false },
      validityKeys: [
        { type: "file-sha", value: "src/api/x.ts@aaa" },
        { type: "index-generation", value: "gen-7" },
      ],
    });
    if (!made.ok) throw new Error("fixture refused");
    return made.tombstone;
  })();

  const liveNow = [
    { type: "file-sha", value: "src/api/x.ts@aaa" },
    { type: "index-generation", value: "gen-7" },
    { type: "provider-coverage", value: "complete" },
  ];

  it("stays valid while every key still matches", () => {
    expect(tombstoneValidity(t, liveNow)).toEqual({ valid: true });
    expect(sweepStaleTombstones([t], liveNow).live).toHaveLength(1);
  });

  it("dies on a SHA change", () => {
    const after = liveNow.map((k) => (k.type === "file-sha" ? { ...k, value: "src/api/x.ts@bbb" } : k));
    expect(tombstoneValidity(t, after)).toMatchObject({ valid: false, cause: "value-changed" });
    const swept = sweepStaleTombstones([t], after);
    expect(swept.live).toHaveLength(0);
    expect(swept.invalidated[0]).toMatchObject({ id: "t1", cause: "value-changed" });
  });

  it("dies on an index-GENERATION bump", () => {
    const after = liveNow.map((k) => (k.type === "index-generation" ? { ...k, value: "gen-8" } : k));
    expect(sweepStaleTombstones([t], after).live).toHaveLength(0);
  });

  it("dies when a key type is UNVERIFIABLE (fail-closed, not fail-open)", () => {
    const after = liveNow.filter((k) => k.type !== "index-generation");
    expect(tombstoneValidity(t, after)).toMatchObject({ valid: false, cause: "key-unverifiable" });
    expect(sweepStaleTombstones([t], after).live).toHaveLength(0);
  });

  it("dies against an EMPTY live key set — nothing proves it still holds", () => {
    expect(sweepStaleTombstones([t], []).live).toHaveLength(0);
  });

  it("liveStrongTombstones drops both the stale and the weak", () => {
    const strong = createStrongTombstone({
      ...common,
      id: "strong-1",
      scope: { kind: "paths", description: "src/api", paths: ["src/api"], complete: true },
      absence,
      evidenceCatalog: catalog,
      validityKeys: [{ type: "index-generation", value: "gen-7" }],
    });
    expect(strong.ok).toBe(true);
    if (!strong.ok) return;
    expect(liveStrongTombstones([t, strong.tombstone], liveNow).map((x) => x.id)).toEqual(["strong-1"]);
    expect(liveStrongTombstones([t, strong.tombstone], [{ type: "index-generation", value: "gen-9" }])).toEqual([]);
  });
});

describe("V11-04 revive is always permitted", () => {
  it("removes a STRONG tombstone with no evidence, strength or validity check", () => {
    const strong = createStrongTombstone({
      ...common,
      scope: { kind: "paths", description: "src/api", paths: ["src/api"], complete: true },
      absence,
      evidenceCatalog: catalog,
    });
    expect(strong.ok).toBe(true);
    if (!strong.ok) return;
    const outcome = reviveTombstone([strong.tombstone], "t1");
    expect(outcome.revived).toBe(true);
    expect(outcome.tombstones).toHaveLength(0);
    // The claim comes back so the caller can re-open the hypothesis by name.
    expect(outcome.claim).toBe(common.claim);
  });

  it("reviving an unknown id is a no-op, not an error", () => {
    expect(reviveTombstone([], "nope")).toMatchObject({ revived: false, tombstones: [] });
  });
});
