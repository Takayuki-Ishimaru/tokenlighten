/**
 * True when `args` contains a `--help` or `-h` token anywhere, not only as
 * the first positional token.
 *
 * TokenLighten's CLI is a hand-rolled argv parser: every command's
 * dispatcher checked only its first token against "--help"/"-h", so
 * `tl <command> <subcommand> --help` (or `-h`) fell through as an
 * unrecognized trailing flag and the real subcommand ran instead of
 * printing usage -- e.g. `tl workspace setup --help` used to run the full
 * setup (rewriting AGENTS.md/CLAUDE.md, writing MCP client config, and
 * recording the global workspace registry) rather than showing help.
 *
 * Every command entry point should call this immediately -- before any
 * dispatch or side effect -- and print usage + return when it is true.
 */
export function wantsHelp(args: readonly string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}
