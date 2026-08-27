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
//
// UPDATE (2026-08-27, T3 field-eval): the capture described above as future
// work now exists. server.ts's handleRequest "initialize" case populates the
// exported `capturedClientId` (with `resetCapturedClientIdForTest` for
// tests); `resolvedClientId()` there applies a TOKENLIGHTEN_CLIENT_ID env
// override on top of it; and `callToolUninstrumented` threads the result into
// `ProtocolCallContext.clientId` on every call. `clientId` is therefore NOT
// undefined on every call any more -- see clientIdCapture.spec.ts for the
// end-to-end proof. The paragraph above is kept for its still-true framing
// (why an unresolved id falls back to UNKNOWN_CLIENT_PROFILE) but its
// "nothing sets it yet" claim is historical, not current.
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
  /**
   * T3 (2026-08-27 field-eval): an optional DEFAULT response-byte ceiling for
   * this client, consulted ONLY by task_pack/batch size governance
   * (readCodeTaskPack.ts's capForResult, server.ts's handles/full batch
   * loops) as the fallback used when the CALLER passes neither maxBytes nor
   * maxTokens on the call itself -- an explicit caller argument always wins
   * over this. Deliberately NOT a codec-compatibility claim (it never touches
   * allowedCodecIds / isCodecAllowedForClient): it is a conservative,
   * evidence-grounded byte budget, safe to apply even without an E2E codec
   * replay, since shipping FEWER bytes than a generic client expects can
   * never desync its parser the way a wrong codec choice could.
   */
  readonly responseByteCeiling?: number;
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

// ---------------------------------------------------------------------------
// T3 (2026-08-27 field-eval): VS Code's built-in MCP client.
//
// Two independent field reports (2026-08-24, 2026-08-27) observed VS Code
// spilling an MCP tool result larger than ~17KB to an external tool-result
// file the agent then has to re-read as a second turn. `responseByteCeiling`
// below is a conservative backstop against that: 16 KiB minus a margin for
// the JSON-RPC envelope around the tool result's own text payload. It is NOT
// a claim that VS Code's MCP client is otherwise compatible with anything
// beyond default JSON (allowedCodecIds stays empty, same as the unknown
// profile) -- see the module header's compatibility-claim discipline.
//
// clientInfo.name VERIFIED (2026-08-27) against microsoft/vscode's own
// source: src/vs/workbench/contrib/mcp/common/mcpServerRequestHandler.ts sets
// `clientInfo: { name: productService.nameLong, version:
// productService.version }` on every MCP initialize VS Code sends as a
// client. productService.nameLong is build-specific:
//   - Microsoft's shipped builds (what the two field reports are almost
//     certainly from): "Visual Studio Code" (stable), "Visual Studio Code -
//     Insiders", "Visual Studio Code - Exploration".
//   - The unbranded OSS build (product.json in the public repo, what a
//     from-source build reports absent a downstream vendor override):
//     "Code - OSS" -- NOT matched below; no field evidence this build shares
//     the same spill behavior, and bare "code" is too broad a substring to
//     match safely (false-positives on unrelated clients).
//   - Forks (e.g. VSCodium) set their own nameLong and are NOT matched below
//     for the same no-evidence reason; add them here if a field report ever
//     names one.
// Matched case-insensitively, by substring rather than exact id, because the
// string carries a channel suffix -- this is why VS Code needs its own
// resolution step below rather than a KNOWN_CLIENT_PROFILES map entry, which
// only ever matches an id EXACTLY.
// ---------------------------------------------------------------------------
const VSCODE_CLIENT_NAME_SUBSTRINGS: readonly string[] = ["visual studio code", "vscode"];

const VSCODE_CLIENT_PROFILE: ClientProfile = {
  id: "vscode",
  profileVersion: "1",
  lastValidated: "2026-08-27",
  // No codec-eligibility claim for VS Code -- see the module header and the
  // comment above. This profile exists ONLY to carry responseByteCeiling.
  allowedCodecIds: [],
  responseByteCeiling: 14336, // 16 KiB minus envelope margin
};

/** True when `clientId` (a raw clientInfo.name) identifies VS Code's built-in MCP client -- see VSCODE_CLIENT_NAME_SUBSTRINGS' doc comment above for exactly which builds match and why. */
function isVsCodeClientId(clientId: string): boolean {
  const lower = clientId.toLowerCase();
  return VSCODE_CLIENT_NAME_SUBSTRINGS.some((substring) => lower.includes(substring));
}

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
  // T3: an EXACT registry match still wins outright; the substring match
  // below is a fallback for a real product's clientInfo.name (which carries
  // a channel suffix an exact map key can never match), not a replacement
  // for it.
  const profile = KNOWN_CLIENT_PROFILES.get(clientId)
    ?? (isVsCodeClientId(clientId) ? VSCODE_CLIENT_PROFILE : undefined);
  if (profile === undefined) return UNKNOWN_CLIENT_PROFILE;
  if (isProfileStale(profile, now)) return UNKNOWN_CLIENT_PROFILE;
  return profile;
}

/** True when `profile` explicitly allows `codecIdAndVersion` (e.g. "tl-raw-1/1") for a widened, outside-the-default-allowlist kind. Always false for the unknown profile, by construction. */
export function isCodecAllowedForClient(profile: ClientProfile, codecIdAndVersion: string): boolean {
  if (profile.id === UNKNOWN_CLIENT_PROFILE.id) return false;
  return profile.allowedCodecIds.includes(codecIdAndVersion);
}

/**
 * T4 (2026-08-27 field-eval): TOKENLIGHTEN_TASK_PACK_MAX_BYTES env override,
 * resolved against `profile.responseByteCeiling`.
 *
 * Precedence (documented once, here, since every size-governance consumer
 * defers to this function rather than re-deriving it): an EXPLICIT per-call
 * maxBytes/maxTokens argument always wins over both of these and is
 * therefore resolved by the CALLER of this function, never here (see
 * readCodeModes.ts's resolveCallerByteCeiling). Between what remains:
 *
 *   1. `envRaw` (TOKENLIGHTEN_TASK_PACK_MAX_BYTES), when it parses as a
 *      non-negative integer, REPLACES the profile ceiling outright -- it
 *      does not combine with it. 0 is a dedicated disable sentinel: it means
 *      "ignore the client-profile ceiling, fall back to the type-specific
 *      default", not "cap at zero bytes" (a zero-byte pack would violate the
 *      "never refuse" contract every other cap in this server already
 *      honors).
 *   2. A malformed envRaw (present but not a parseable non-negative integer)
 *      is treated as ABSENT -- fails open to the profile ceiling, the same
 *      "a typo in an opt-in override must not break the default path"
 *      discipline mcp/transport/modernHttp.ts's port parsing already
 *      documents -- with one stderr warning so the typo is discoverable.
 *   3. Absent both, `profile.responseByteCeiling` (possibly itself
 *      undefined, meaning no default ceiling at all for this client).
 */
export function resolveDefaultResponseByteCeiling(
  profile: ClientProfile,
  envRaw: string | undefined,
): number | undefined {
  if (envRaw !== undefined) {
    const trimmed = envRaw.trim();
    // Strict digits-only match rather than bare Number(trimmed): the latter
    // coerces "" to 0 (silently mapping an accidentally-empty env value to
    // the disable sentinel), and also accepts "0x10"/"5e2"/"Infinity"/
    // leading-plus forms no operator setting this env var by hand would
    // intend as "a byte count".
    if (/^[0-9]+$/.test(trimmed)) {
      const parsed = Number(trimmed);
      return parsed === 0 ? undefined : parsed;
    }
    console.error(
      `[tl-mcp] TOKENLIGHTEN_TASK_PACK_MAX_BYTES=${JSON.stringify(envRaw)} is not a non-negative integer; ignoring it (falling back to the client-profile ceiling)`,
    );
  }
  return profile.responseByteCeiling;
}
