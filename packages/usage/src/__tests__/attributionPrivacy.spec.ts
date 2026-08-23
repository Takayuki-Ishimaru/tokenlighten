import { describe, expect, it } from "vitest";
import { attributionPrivacyReport } from "../attributionPrivacy.js";

describe("attributionPrivacyReport", () => {
  const report = attributionPrivacyReport();

  it("is local-only with no automatic upload, matching index.ts's privacyReport() posture", () => {
    expect(report.localOnly).toBe(true);
    expect(report.automaticUpload).toBe(false);
  });

  it("covers every new V11-08 store exactly once", () => {
    expect(report.stores.map((s) => s.store).sort()).toEqual([
      "coefficientStore",
      "featureContributions",
      "holdoutReport",
      "parsers",
      "pricingSnapshots",
      "sessionMatcher",
    ]);
  });

  it("no store claims to contain prompt text, source text, or credentials", () => {
    for (const store of report.stores) {
      expect(store.containsPromptText).toBe(false);
      expect(store.containsSourceText).toBe(false);
      expect(store.containsCredentials).toBe(false);
      expect(store.notes.length).toBeGreaterThan(0);
    }
  });

  it("honestly flags parsers as the only store holding raw paths in memory", () => {
    const parsers = report.stores.find((s) => s.store === "parsers")!;
    expect(parsers.containsRawPathsInMemoryOnly).toBe(true);
    const others = report.stores.filter((s) => s.store !== "parsers");
    for (const store of others) {
      expect(store.containsRawPathsInMemoryOnly).toBe(false);
    }
  });

  it("is deterministic (pure, no I/O) — repeated calls are deep-equal", () => {
    expect(attributionPrivacyReport()).toEqual(attributionPrivacyReport());
  });
});
