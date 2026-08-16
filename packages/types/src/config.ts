/**
 * Canonical configuration schema for TokenLighten.
 * Parsed from `config.toml` (or `.tokenlighten/config.toml`) at runtime.
 * All fields are optional; omitted fields use their documented defaults.
 */
export interface TLConfig {
  /**
   * LiteLLM proxy settings.
   * See docs/components/01-litellm-proxy.md.
   */
  proxy?: {
    /** Whether the proxy is enabled. Default: true when proxy is configured. */
    enabled: boolean;
  };

  /**
   * MCP server settings.
   * See docs/components/02-mcp-server.md.
   */
  mcp?: {
    /**
     * Absolute path to the workspace root that the MCP server is allowed to
     * read (and, when --allow-write is set, write).
     * Defaults to the directory containing config.toml.
     */
    workspaceRoot?: string;
  };

  /**
   * CI skeleton generator settings.
   * See docs/components/03-ci-skeleton.md §4.1.
   */
  skeleton?: {
    /**
     * Maximum byte size of the generated .repo-skeleton.md file.
     * Default: 65536 (≈ 16k tokens).
     */
    sizeCapBytes: number;
    /**
     * Maximum number of top-ranked files to include in the skeleton.
     * Default: 40 (matches Aider repomap default).
     */
    maxRanked: number;
  };

  /**
   * AGENTS.md generator settings.
   * See docs/components/04-agents-md-generator.md §3.
   */
  agentsMd?: {
    /**
     * How to handle a managed block whose version or sha256 does not match
     * the canonical template:
     * - `diff-warn`: emit a warning to stderr but do not rewrite.
     * - `silent-overwrite`: rewrite without warning (equivalent to `auto-rewrite`).
     * - `fail-build`: exit non-zero; used in CI lint jobs.
     * Default: `diff-warn`.
     */
    driftPolicy: "diff-warn" | "silent-overwrite" | "fail-build";
  };

  /** Local, privacy-preserving usage measurement and export settings. */
  usage?: {
    /** Write numeric-only local usage events. Default: true. */
    enabled?: boolean;
    /**
     * Optional input-token price used only for a local cost estimate.
     * No provider pricing is built in because prices and models vary.
     */
    costPerMillionTokensUsd?: number;
  };
}
