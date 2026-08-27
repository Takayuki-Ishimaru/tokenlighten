#!/usr/bin/env node
// Plain data output — no meta envelope. See docs/00-postmortem.md §2.2.
//
// tl-agents CLI
// Usage: tl-agents update [--check] [--targets claude,copilot,cursor,cline,continue]
//                          [--locale en|jp] [--force]
//        tl-agents check   (alias for: tl-agents update with fail-build drift mode)
//
// removeAll() (remove all managed blocks) is a library export (see index.ts)
// with no CLI subcommand here.
//
// Spec: docs/components/04-agents-md-generator.md §4 (trigger timing / CLI).

import { injectAll } from "./injectAll.js";
import type { DriftMode } from "./inject.js";
import { parseArgs, CliArgError, VALID_TARGETS, VALID_LOCALES, VALID_PROFILES } from "./cliArgs.js";

function printHelp(): void {
  process.stdout.write(`tl-agents — TokenLighten AGENTS.md injector

USAGE
  tl-agents update [options]    Inject/update managed blocks (default drift: diff-warn)
  tl-agents check               Check for drift, exit 1 on mismatch (fail-build mode)
  tl-agents help                Show this help

OPTIONS (for update)
  --targets <ids>    Comma-separated subset of targets to process.
                     Valid values: ${VALID_TARGETS.join(", ")}
                     Default: all 5 targets
  --locale <locale>  Template language: ${VALID_LOCALES.join(" (default) or ")}
  --profile <profile> Guide profile: ${VALID_PROFILES.join(", ")} (default: full)
  --force            Overwrite even when manual edits detected inside the block
  --check            Use fail-build drift mode (same as \`tl-agents check\`)

EXAMPLES
  tl-agents update
  tl-agents update --targets claude,cursor
  tl-agents update --locale jp
  tl-agents update --profile compact
  tl-agents check
  tl-agents update --force
`);
}

async function main(): Promise<void> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(process.argv);
  } catch (err: unknown) {
    if (err instanceof CliArgError) {
      process.stderr.write(`[tl-agents] ERROR: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
  const { command, targets, locale, profile, force, check } = parsed;

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  const repoRoot = process.cwd();

  if (command === "check") {
    // fail-build mode: exit 1 on drift
    const result = await injectAll({
      repoRoot,
      driftMode: "fail-build",
      targets,
      locale,
      profile,
      force: false,
    });
    printResult(result);
    if (result.drifted.length > 0 || process.exitCode === 1) {
      process.exit(1);
    }
    return;
  }

  if (command === "update") {
    const driftMode: DriftMode = check ? "fail-build" : "diff-warn";
    const result = await injectAll({
      repoRoot,
      driftMode,
      targets,
      locale,
      profile,
      force,
    });
    printResult(result);
    if (check && (result.drifted.length > 0 || process.exitCode === 1)) {
      process.exit(1);
    }
    return;
  }

  process.stderr.write(`[tl-agents] ERROR: unknown command "${command}". Run \`tl-agents help\`.\n`);
  process.exit(1);
}

function printResult(result: { wrote: string[]; skipped: { path: string; reason: string }[]; drifted: { path: string; expected: string; actual: string }[] }): void {
  if (result.wrote.length > 0) {
    process.stdout.write(`[tl-agents] wrote: ${result.wrote.join(", ")}\n`);
  }
  if (result.skipped.length > 0) {
    for (const s of result.skipped) {
      process.stdout.write(`[tl-agents] skipped ${s.path}: ${s.reason}\n`);
    }
  }
  if (result.drifted.length > 0) {
    for (const d of result.drifted) {
      process.stderr.write(`[tl-agents] DRIFT ${d.path}: expected sha=${d.expected.slice(0, 8)}... actual=${d.actual.slice(0, 8)}...\n`);
    }
  }
  if (result.wrote.length === 0 && result.skipped.length === 0 && result.drifted.length === 0) {
    process.stdout.write(`[tl-agents] all files up-to-date\n`);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`[tl-agents] FATAL: ${String(err)}\n`);
  process.exit(1);
});
