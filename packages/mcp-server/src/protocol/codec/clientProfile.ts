// ---------------------------------------------------------------------------
// protocol v1 -- V11-07 (Adaptive Wire Encoding v2): client compatibility
// profiles.
//
// GROUND TRUTH (verified 2026-08-21 against this tree's server.ts). The MCP
// `initialize` handshake's `clientInfo` (name/version) IS read by the
// hand-rolled JSON-RPC dispatcher (server.ts `handleRequest`, the
// `"initialize"` case) but is used ONLY to write a startup log line to
// stderr -- it is never stored anywhere a later `tools/call` can reach
// (confirmed: `search_files find query:"clientInfo"` over server.ts shows
// exactly that one read site, and no module holds a "last seen client"
// anywhere; `TOKENLIGHTEN_CLIENT_ID` is confirmed absent from the whole
// tree). `ProtocolCallContext.clientId` (protocol/envelope.ts) is therefore
// the seam this module resolves against, and it is `undefined` on every
// call today -- nothing sets it yet.
//
// That is the EXPECTED, CORRECT state, not a bug this workstream needs to
// fix: resolving an undefined clientId to `UNKNOWN_CLIENT_PROFILE` is
// exactly the conservative fallback the design calls for ("unknown or
// stale profile => json-conservative behaviour"). Wiring an actual
// clientInfo capture into server.ts's hand-rolled dispatcher (or the SDK
// transport's own handshake) is cross-cutting, shared-file surgery this
// isolated workstream deliberately leaves to a later revisit -- see this
// workstream's final report.
// ---------------------------------------------------------------------------

/** A versioned, compatibility-scoped view of one MCP client. */
export interface ClientProfile {
  /** Stable client identifier -- "unknown" for every unrecognised/unresolved id. */
  readonly id: string;
  /** Version of THIS PROFILE ENTRY (bumped when its allowedCodecIds change) -- not the client program's own version. */
  readonly profileVersion: string;
  /** ISO-8601 date this profile was last validated against a real client (the design doc's "client E2E replay"). */
  readonly lastValidated: string;
  /** `${codec.id}/${codec.version}` strings this client is known to decode correctly for kinds OUTSIDE the default allowlist (policy.ts's NON_JSON_ALLOWLIST always applies regardless of profile). */
  readonly allowedCodecIds: readonly string[];
}

/** The universal conservative fallback -- see the module header. Carries no codec allowance, so every v2-only widening (E-3's read.text/tl-raw-1 staging) stays closed for it. */
export const UNKNOWN_CLIENT_PROFILE: ClientProfile = {
  id: "unknown",
  profileVersion: "0",
  lastValidated: "1970-01-01T00:00:00.000Z",
  allowedCodecIds: [],
};

/**
 * A profile older than this (relative to the resolution time) is treated as
 * STALE -- "client update after which a stale profile can be detected" is a
 * V11-07 acceptance row. No client E2E replay pipeline exists yet to
 * auto-refresh `lastValidated` (that is the design doc's own "client E2E
 * replay" item; DESIGN-v0.11 reconciliation E-4/E-6 defer paired replay
 * runs as user-adjudicated spend), so every entry below is validated by
 * static code reading, not a live replay run. The window is deliberately
 * generous so a profile is not flagged stale purely from replay-pipeline
 * absence, while still being short enough that a genuinely abandoned entry
 * eventually falls back to conservative behaviour on its own.
 */
export const PROFILE_STALE_AFTER_MS = 180 * 24 * 60 * 60 * 1000; // 180 days

// ---------------------------------------------------------------------------
// The registry. ONE demonstration entry, named after the same placeholder
// client id __tests__/helpers/contextAttestation.ts already uses
// ("tl-reference-client") -- deliberately NOT a guess at a real product's
// client id (this workstream has no E2E replay evidence for any specific
// real client, and fabricating a named entry for one would misrepresent a
// compatibility claim nothing has verified). The entry exists so the
// resolution mechanism, the staleness check, and the E-3 widening gate all
// have one non-degenerate path to prove against ahead of a real replay
// corpus.
// ---------------------------------------------------------------------------
const KNOWN_CLIENT_PROFILES: ReadonlyMap<string, ClientProfile> = new Map([
  [
    "tl-reference-client",
    {
      id: "tl-reference-client",
      profileVersion: "1",
      lastValidated: "2026-08-21",
      // tl-raw-1 round-trips deterministically for any client that reads
      // `TextContent.text` as an opaque UTF-8 string and lets THIS SAME
      // server's `read_file`/`edit_file` continuation decode it -- already
      // round-trip-proven by policy.ts's evaluateCandidates before
      // selection ever runs, independent of which client is asking.
      allowedCodecIds: ["tl-raw-1/1"],
    },
  ],
]);

/** True when `profile.lastValidated` is further than `PROFILE_STALE_AFTER_MS` in the past, or is not a parseable date at all (never trust an unparseable date). */
export function isProfileStale(profile: ClientProfile, now: number = Date.now()): boolean {
  const validated = Date.parse(profile.lastValidated);
  if (Number.isNaN(validated)) return true;
  return now - validated > PROFILE_STALE_AFTER_MS;
}

/**
 * Resolves `clientId` to its profile. `undefined` (not reachable at codec
 * time today -- see the module header), unrecognised, and stale all
 * resolve to `UNKNOWN_CLIENT_PROFILE` -- the single conservative fallback,
 * never a partially-trusted intermediate state.
 */
export function resolveClientProfile(clientId: string | undefined, now: number = Date.now()): ClientProfile {
  if (clientId === undefined) return UNKNOWN_CLIENT_PROFILE;
  const profile = KNOWN_CLIENT_PROFILES.get(clientId);
  if (profile === undefined) return UNKNOWN_CLIENT_PROFILE;
  if (isProfileStale(profile, now)) return UNKNOWN_CLIENT_PROFILE;
  return profile;
}

/** True when `profile` explicitly allows `codecIdAndVersion` (e.g. "tl-raw-1/1") for a widened, outside-the-default-allowlist kind. Always false for the unknown profile, by construction. */
export function isCodecAllowedForClient(profile: ClientProfile, codecIdAndVersion: string): boolean {
  if (profile.id === UNKNOWN_CLIENT_PROFILE.id) return false;
  return profile.allowedCodecIds.includes(codecIdAndVersion);
}
