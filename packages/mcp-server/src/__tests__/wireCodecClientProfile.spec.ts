// ---------------------------------------------------------------------------
// V11-07 client compatibility profiles -- undefined/unrecognised/stale all
// resolve to UNKNOWN_CLIENT_PROFILE, the single conservative fallback.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  PROFILE_STALE_AFTER_MS,
  UNKNOWN_CLIENT_PROFILE,
  isCodecAllowedForClient,
  isProfileStale,
  resolveClientProfile,
} from "../protocol/codec/clientProfile.js";

const KNOWN_VALIDATED_MS = Date.parse("2026-08-21");

describe("resolveClientProfile -- conservative fallback", () => {
  it("undefined clientId resolves to UNKNOWN_CLIENT_PROFILE (the not-reachable-at-codec-time case today)", () => {
    expect(resolveClientProfile(undefined)).toEqual(UNKNOWN_CLIENT_PROFILE);
  });

  it("an unrecognised clientId resolves to UNKNOWN_CLIENT_PROFILE", () => {
    expect(resolveClientProfile("some-client-nobody-registered")).toEqual(UNKNOWN_CLIENT_PROFILE);
  });

  it("UNKNOWN_CLIENT_PROFILE carries no codec allowance at all", () => {
    expect(UNKNOWN_CLIENT_PROFILE.allowedCodecIds).toEqual([]);
    expect(UNKNOWN_CLIENT_PROFILE.id).toBe("unknown");
  });

  it("a known, freshly-validated client resolves to its real profile", () => {
    const now = KNOWN_VALIDATED_MS + 1000; // one second after validation -- well within the window
    const profile = resolveClientProfile("tl-reference-client", now);
    expect(profile.id).toBe("tl-reference-client");
    expect(profile.allowedCodecIds).toContain("tl-raw-1/1");
  });

  it("a known client resolved far past its staleness window falls back to UNKNOWN_CLIENT_PROFILE", () => {
    const now = KNOWN_VALIDATED_MS + PROFILE_STALE_AFTER_MS + 1;
    expect(resolveClientProfile("tl-reference-client", now)).toEqual(UNKNOWN_CLIENT_PROFILE);
  });

  it("a known client resolved exactly at the staleness boundary is still fresh (strict greater-than, not >=)", () => {
    const now = KNOWN_VALIDATED_MS + PROFILE_STALE_AFTER_MS;
    const profile = resolveClientProfile("tl-reference-client", now);
    expect(profile.id).toBe("tl-reference-client");
  });
});

describe("isProfileStale", () => {
  it("false immediately after validation", () => {
    const profile = { id: "x", profileVersion: "1", lastValidated: "2026-08-21", allowedCodecIds: [] };
    expect(isProfileStale(profile, KNOWN_VALIDATED_MS)).toBe(false);
  });

  it("true well past the staleness window", () => {
    const profile = { id: "x", profileVersion: "1", lastValidated: "2026-08-21", allowedCodecIds: [] };
    expect(isProfileStale(profile, KNOWN_VALIDATED_MS + PROFILE_STALE_AFTER_MS * 2)).toBe(true);
  });

  it("an unparseable lastValidated date is always treated as stale -- never trusted", () => {
    const profile = { id: "x", profileVersion: "1", lastValidated: "not-a-date", allowedCodecIds: [] };
    expect(isProfileStale(profile, Date.now())).toBe(true);
  });

  it("UNKNOWN_CLIENT_PROFILE's own epoch lastValidated is always stale", () => {
    expect(isProfileStale(UNKNOWN_CLIENT_PROFILE, Date.now())).toBe(true);
  });
});

describe("isCodecAllowedForClient", () => {
  it("always false for the unknown profile, regardless of the codec asked about", () => {
    expect(isCodecAllowedForClient(UNKNOWN_CLIENT_PROFILE, "tl-raw-1/1")).toBe(false);
    expect(isCodecAllowedForClient(UNKNOWN_CLIENT_PROFILE, "anything/1")).toBe(false);
  });

  it("true for a known profile's listed codec id, false for one it never listed", () => {
    const profile = { id: "known", profileVersion: "1", lastValidated: "2026-08-21", allowedCodecIds: ["tl-raw-1/1"] };
    expect(isCodecAllowedForClient(profile, "tl-raw-1/1")).toBe(true);
    expect(isCodecAllowedForClient(profile, "tl-table-1/1")).toBe(false);
  });

  it("a version mismatch on an otherwise-allowed codec id is NOT allowed (exact id+version match only)", () => {
    const profile = { id: "known", profileVersion: "1", lastValidated: "2026-08-21", allowedCodecIds: ["tl-raw-1/1"] };
    expect(isCodecAllowedForClient(profile, "tl-raw-1/2")).toBe(false);
  });
});
