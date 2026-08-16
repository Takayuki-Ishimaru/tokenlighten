export type TokenLightenRegistrationClient = "claude-code" | "codex";

export type TokenLightenClientRegistrationState =
  | "client-absent"
  | "not-registered"
  | "registered-managed"
  | "registered-foreign";

export type TokenLightenLauncherState =
  | "launcher-ok"
  | "dangling"
  | "unknown";

export interface TokenLightenClientRegistrationStatus {
  client: TokenLightenRegistrationClient;
  state: TokenLightenClientRegistrationState;
  launcherState: TokenLightenLauncherState;
  clientVersion?: string;
  tokenLightenVersion?: string;
  recordedCommand?: string;
  /** Copyable vendor-CLI command shown when the client executable is absent. */
  manualCommand?: string;
  /**
   * True when a local configuration for this client exists on disk
   * (`~/.codex/config.toml` or `~/.codex/` for Codex, `~/.claude.json` or
   * `~/.claude/` for Claude Code). A client can be
   * installed as an editor extension or desktop app while its CLI never lands
   * on PATH, so this is a second, weaker presence signal than `state`.
   */
  vendorConfigPresent?: boolean;
  detail?: string;
}

export interface TokenLightenClientsResult {
  schemaVersion: 1;
  action: "status" | "register" | "unregister";
  ok: boolean;
  clients: readonly TokenLightenClientRegistrationStatus[];
  changedClients: readonly TokenLightenRegistrationClient[];
  warnings: readonly string[];
}

export type TokenLightenHostProfile = "tl" | "native";

export type TokenLightenHostProfileReason =
  | "explicit"
  | "host-capability"
  | "ambiguous-request"
  | "path-unknown"
  | "cross-file-or-discovery"
  | "artifact-or-wiring"
  | "multi-concern"
  | "known-local-single-site";

export interface TokenLightenHostProfileSelection {
  profile: TokenLightenHostProfile;
  reason: TokenLightenHostProfileReason;
}

export interface TokenLightenHostActivationInput {
  request?: string;
  paths?: readonly string[];
  fileProbe?: (path: string) => { isFile: boolean; size: number } | undefined;
}

export interface TokenLightenClientProfileResult {
  schemaVersion: 1;
  action: "activate" | "select" | "profile";
  requestedProfile?: TokenLightenHostProfile;
  selectedProfile: TokenLightenHostProfile;
  selectionReason: TokenLightenHostProfileReason;
  applied: boolean;
  ok: boolean;
  clients: readonly TokenLightenClientRegistrationStatus[];
  changedClients: readonly TokenLightenRegistrationClient[];
  warnings: readonly string[];
  guideRoot?: string;
  guideAction?: "inject" | "remove";
  guideChanged?: readonly string[];
  guidePlanned?: readonly string[];
  guideErrors?: readonly string[];
  profileReady?: boolean;
}
