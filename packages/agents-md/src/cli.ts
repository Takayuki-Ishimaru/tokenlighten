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
import type { StubTargetId } from "@tokenlighten/types";
import type { Locale } from "./render.js";

const VALID_TARGETS: StubTargetId[] = ["claude", "copilot", "cursor", "cline", "continue"];
const VALID_LOCALES: Locale[] = ["en", "jp"];

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
  --locale <locale>  Template language: en (default) or jp
  --force            Overwrite even when manual edits detected inside the block
  --check            Use fail-build drift mode (same as \`tl-agents check\`)

EXAMPLES
  tl-agents update
  tl-agents update --targets claude,cursor
  tl-agents update --locale jp
  tl-agents check
  tl-agents update --force
`);
}

function parseArgs(args: string[]): {
  command: string;
  targets?: StubTargetId[];
  locale?: Locale;
  force: boolean;
  check: boolean;
} {
  const [, , cmdRaw = "help", ...rest] = args;
  const command = cmdRaw.startsWith("--") ? "update" : cmdRaw;

  // Treat bare flags before the command as part of "update"
  const allArgs = cmdRaw.startsWith("--") ? [cmdRaw, ...rest] : rest;

  let targets: StubTargetId[] | undefined;
  let locale: Locale | undefined;
  let force = false;
  let check = false;

  for (let i = 0; i < allArgs.length; i++) {
    const arg = allArgs[i];
    if (arg === "--force") {
      force = true;
    } else if (arg === "--check") {
      check = true;
    } else if (arg === "--targets" && allArgs[i + 1]) {
      const raw = allArgs[++i]!;
      const parsed = raw.split(",").map((s) => s.trim()) as StubTargetId[];
      for (const t of parsed) {
        if (!VALID_TARGETS.includes(t)) {
          process.stderr.write(`[tl-agents] ERROR: unknown target "${t}". Valid: ${VALID_TARGETS.join(", ")}\n`);
          process.exit(1);
        }
      }
      targets = parsed;
    } else if (arg === "--locale" && allArgs[i + 1]) {
      const raw = allArgs[++i]! as Locale;
      if (!VALID_LOCALES.includes(raw)) {
        process.stderr.write(`[tl-agents] ERROR: unknown locale "${raw}". Valid: ${VALID_LOCALES.join(", ")}\n`);
        process.exit(1);
      }
      locale = raw;
    }
  }

  return { command, targets, locale, force, check };
}

async function main(): Promise<void> {
  const { command, targets, locale, force, check } = parseArgs(process.argv);

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
