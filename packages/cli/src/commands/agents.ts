/**
 * tl agents update — delegate to @tokenlighten/agents-md
 *
 * Lazy-requires agents-md at runtime so that the CLI remains installable
 * without it. If the package is absent, prints an install hint.
 *
 * Output policy: plain data — no meta envelope.
 * See docs/00-postmortem.md §2.2 for rationale.
 */

import { createRequire } from "module";

const AGENTS_USAGE = `\
Usage: tl agents <subcommand>
       tl agents-md write [--targets <id,...>] [--for-target] [--guide full|compact]

Subcommands:
  update [--for-target]         Write / update AGENTS.md stubs for AI tools
                                 --for-target: write v0.4 stable-prefix
                                 AGENTS.md + .github/copilot-instructions.md
                                 into the target repo (refuses if cwd is the
                                 TokenLighten repo itself).
                                 --guide full|compact (with --for-target):
                                 full stable-prefix guide (default) or the
                                 V10-07 compact bootstrap block.
  update [--targets <id,...>]   Alias: tl agents-md write
         [--root <dir>]         Targets: claude, copilot, cursor, cline, continue
         [--locale en|jp]       (windsurf and roo read AGENTS.md natively — no stub needed)
         [--profile full|medium] Guide profile (default: full)
         [--force] [--check]    --root: repo root to inject into (default: cwd)
                                 --locale: template language (default: en)
                                 --force: overwrite even if manual edits detected
                                 --check: exit 1 on drift instead of warning (CI gate)
`;

/**
 * Extract the value following a flag, e.g. valueAfter(["--root", "/tmp"], "--root") -> "/tmp".
 * Mirrors the identical helper in commands/workspace.ts, commands/clients.ts, commands/logs.ts.
 */
function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function runAgents(args: string[]): Promise<void> {
  const [sub, ...rest] = args;

  if (!sub || sub === "--help" || sub === "-h") {
    process.stdout.write(AGENTS_USAGE);
    return;
  }

  // Accept both "update" and the canonical alias "write" (via tl agents-md write)
  if (sub === "update" || sub === "write") {
    const forTarget = rest.includes("--for-target");

    if (forTarget) {
      // --for-target mode: build compact skeleton then inject into target repo
      // Guide variant (V10-07 rc.1 wiring): full stable-prefix (default) or compact.
      let guide: "full" | "compact" = "full";
      const guideIdx = rest.indexOf("--guide");
      if (guideIdx !== -1) {
        const value = rest[guideIdx + 1];
        if (value !== "full" && value !== "compact") {
          process.stderr.write(`tl agents: --guide expects "full" or "compact", got "${value ?? ""}".\n`);
          process.exit(1);
        }
        guide = value;
      }
      const require = createRequire(import.meta.url);

      // 1. Lazy-import skeleton-engine
      let skeletonMod: {
        buildSkeleton?: (root: string) => Promise<{ skeleton: unknown }>;
        renderCompactSkeleton?: (skeleton: unknown, opts: { maxTokens: number }) => string;
      };
      try {
        const skeletonPath = require.resolve("@tokenlighten/skeleton-engine");
        skeletonMod = (await import(skeletonPath)) as typeof skeletonMod;
      } catch {
        process.stderr.write(
          "tl agents --for-target: @tokenlighten/skeleton-engine not found.\n" +
            "Run: npm install -w @tokenlighten/skeleton-engine\n"
        );
        process.exit(1);
      }

      if (typeof skeletonMod.buildSkeleton !== "function") {
        process.stderr.write(
          "tl agents --for-target: @tokenlighten/skeleton-engine has no exported 'buildSkeleton' function.\n"
        );
        process.exit(1);
      }

      if (typeof skeletonMod.renderCompactSkeleton !== "function") {
        process.stderr.write(
          "tl agents --for-target: @tokenlighten/skeleton-engine has no exported 'renderCompactSkeleton' function.\n"
        );
        process.exit(1);
      }

      // 2. Build skeleton for cwd
      const { skeleton } = await skeletonMod.buildSkeleton!(process.cwd());

      // 3. Render compact skeleton (~800 tokens)
      const repoSkeletonText = skeletonMod.renderCompactSkeleton!(skeleton, { maxTokens: 800 });

      // 4. Lazy-import agents-md
      let agentsForTargetMod: {
        injectForTarget?: (opts: Record<string, unknown>) => Promise<{
          wrote: string[];
          skipped: { path: string; reason: string }[];
          refusedAsTlRepo: boolean;
        }>;
      };
      try {
        const agentsPath = require.resolve("@tokenlighten/agents-md");
        agentsForTargetMod = (await import(agentsPath)) as typeof agentsForTargetMod;
      } catch {
        process.stderr.write(
          "tl agents --for-target: @tokenlighten/agents-md not found.\n" +
            "Run: npm install -w @tokenlighten/agents-md\n"
        );
        process.exit(1);
      }

      if (typeof agentsForTargetMod.injectForTarget !== "function") {
        process.stderr.write(
          "tl agents --for-target: @tokenlighten/agents-md has no exported 'injectForTarget' function.\n"
        );
        process.exit(1);
      }

      // 5. Inject into target repo
      const result = await agentsForTargetMod.injectForTarget!({
        repoRoot: process.cwd(),
        repoSkeleton: repoSkeletonText,
        guide,
      });

      // 6. Print result
      if (result.refusedAsTlRepo) {
        process.stderr.write(
          "tl agents --for-target: refused — cwd looks like the TokenLighten repo itself.\n" +
            "Use --for-target only when cwd is a TARGET repo, not the TokenLighten monorepo.\n"
        );
        process.exit(1);
      }

      for (const f of result.wrote) {
        process.stdout.write(`wrote  ${String(f)}\n`);
      }
      for (const s of result.skipped) {
        process.stdout.write(`skipped ${String(s.path)}: ${String(s.reason)}\n`);
      }
      return;
    }

    // NOTE: @tokenlighten/agents-md has never exported a `generate` function
    // (not even at the commit that introduced this file — see git history);
    // the real injector API is `injectAll` (packages/agents-md/src/injectAll.ts),
    // the same function the working `tl-agents` bin (packages/agents-md/src/cli.ts)
    // and `--for-target` path below call. Wire the bare `update` path to it too.
    let agentsMod: { injectAll?: (opts: Record<string, unknown>) => Promise<unknown> };
    try {
      const require = createRequire(import.meta.url);
      const modPath = require.resolve("@tokenlighten/agents-md");
      agentsMod = (await import(modPath)) as typeof agentsMod;
    } catch {
      process.stderr.write(
        "tl agents: @tokenlighten/agents-md not found.\n" +
          "Run: npm install -w @tokenlighten/agents-md\n"
      );
      process.exit(1);
    }

    if (typeof agentsMod.injectAll !== "function") {
      process.stderr.write(
        "tl agents: @tokenlighten/agents-md has no exported 'injectAll' function.\n"
      );
      process.exit(1);
    }

    // Parse --targets flag
    const profileIdx = rest.indexOf("--profile");
    let profile: "full" | "medium" | undefined;
    if (profileIdx !== -1) {
      const value = rest[profileIdx + 1];
      if (value !== "full" && value !== "medium") {
        process.stderr.write(`tl agents: --profile expects "full" or "medium", got "${value ?? ""}".\n`);
        process.exit(1);
      }
      profile = value;
    }

    const targetsIdx = rest.indexOf("--targets");
    const targets =
      targetsIdx !== -1 && rest[targetsIdx + 1]
        ? rest[targetsIdx + 1]!.split(",").map((t) => t.trim())
        : undefined;

    // Parse --root, --locale (value flags) and --force, --check (boolean flags).
    // Mirrors the tl-agents bin (packages/agents-md/src/cli.ts) 1:1 so the two
    // routes packages/agents-md/README.md documents as equivalent actually are.
    const root = valueAfter(rest, "--root") ?? process.cwd();
    let locale: "en" | "jp" | undefined;
    const localeIdx = rest.indexOf("--locale");
    if (localeIdx !== -1) {
      const value = rest[localeIdx + 1];
      if (value !== "en" && value !== "jp") {
        process.stderr.write(`tl agents: --locale expects "en" or "jp", got "${value ?? ""}".\n`);
        process.exit(1);
      }
      locale = value;
    }
    const force = rest.includes("--force");
    const check = rest.includes("--check");

    const result = await agentsMod.injectAll({
      repoRoot: root,
      driftMode: check ? "fail-build" : "diff-warn",
      force,
      ...(targets ? { targets } : {}),
      ...(locale ? { locale } : {}),
      ...(profile ? { profile } : {}),
    });

    // Print a summary if the module returns one
    if (result && typeof result === "object") {
      const r = result as { wrote?: string[]; skipped?: unknown[]; drifted?: unknown[] };
      if (Array.isArray(r.wrote)) {
        for (const f of r.wrote) process.stdout.write(`wrote  ${String(f)}\n`);
      }
      if (Array.isArray(r.skipped) && r.skipped.length > 0) {
        process.stdout.write(`skipped ${r.skipped.length} file(s)\n`);
      }
      if (Array.isArray(r.drifted) && r.drifted.length > 0) {
        process.stdout.write(`drifted ${r.drifted.length} block(s) — re-check\n`);
        if (check) process.exit(1);
      }
    }
    return;
  }

  process.stderr.write(`tl agents: unknown subcommand '${sub}'\n${AGENTS_USAGE}`);
  process.exit(1);
}
