#!/usr/bin/env node
// Plain data only — no meta envelope, no 'tokenlighten:meta' wrappers.
// Reason: docs/00-postmortem.md §2.2

/**
 * tl-skeleton CLI entry point.
 *
 * Usage:
 *   tl-skeleton build [--output PATH] [--config PATH] [--top-n N]
 *                     [--commit SHA] [--no-cache] [--quiet] [--strict]
 *
 * Full spec: docs/components/03-ci-skeleton.md §5.3
 */

import { promises as fs, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSkeleton, renderCompactSkeleton } from "./index.js";
import { assertSafeWriteTarget, ensureSafeWriteParent, isPathInside } from "./safeWritePath.js";

interface CliArgs {
  command: string;
  output: string;
  configPath: string | undefined;
  topN: number;
  commit: string | undefined;
  noCache: boolean;
  quiet: boolean;
  strict: boolean;
  root: string;
  compact: boolean;
  outputExplicit: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const command = args[0] ?? "help";

  const result: CliArgs = {
    command,
    output: ".tokenlighten/skeleton.md",
    configPath: undefined,
    topN: 40,
    commit: undefined,
    noCache: false,
    quiet: false,
    strict: false,
    root: process.cwd(),
    compact: false,
    outputExplicit: false,
  };

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    const next = args[i + 1];

    if (arg === "--output" || arg === "-o") {
      if (!next) die("--output requires a value");
      result.output = next;
      result.outputExplicit = true;
      i++;
    } else if (arg === "--config") {
      if (!next) die("--config requires a value");
      result.configPath = next;
      i++;
    } else if (arg === "--top-n") {
      if (!next || isNaN(Number(next))) die("--top-n requires a number");
      result.topN = Number(next);
      i++;
    } else if (arg === "--commit") {
      if (!next) die("--commit requires a value");
      result.commit = next;
      i++;
    } else if (arg === "--root") {
      if (!next) die("--root requires a value");
      result.root = next;
      i++;
    } else if (arg === "--no-cache") {
      result.noCache = true;
    } else if (arg === "--compact") {
      result.compact = true;
    } else if (arg === "--quiet" || arg === "-q") {
      result.quiet = true;
    } else if (arg === "--strict") {
      result.strict = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (!arg.startsWith("-")) {
      // Positional: treat as root after command.
      result.root = arg;
    } else {
      die(`Unknown flag: ${arg}`);
    }
  }

  return result;
}

function printHelp(): void {
  process.stdout.write(
    [
      "tl-skeleton — TokenLighten repo skeleton generator",
      "",
      "Usage:",
      "  tl-skeleton build [options]",
      "",
      "Options:",
      "  --output PATH    Output path (default: .tokenlighten/skeleton.md)",
      "  --compact        Render compact ~800-token skeleton for AGENTS.md embedding",
      "                   (default output: .tokenlighten/skeleton.compact.md)",
      "  --config PATH    Path to .tokenlighten.yaml config file",
      "  --top-n N        Number of top-ranked files to include (default: 40)",
      "  --commit SHA     Git commit SHA (default: resolved via git)",
      "  --root PATH      Repository root (default: cwd)",
      "  --no-cache       Force full rebuild, skip cache",
      "  --quiet          Suppress non-error output",
      "  --strict         Exit 1 on warnings (degenerate graph, parse failures)",
      "  --help           Show this help",
      "",
    ].join("\n"),
  );
}

function die(msg: string): never {
  process.stderr.write(`tl-skeleton: error: ${msg}\n`);
  process.exit(1);
}

function warn(msg: string, quiet = false): void {
  if (!quiet) process.stderr.write(`::warning::${msg}\n`);
}

async function runBuild(args: CliArgs): Promise<void> {
  const configuredRoot = resolve(args.root);
  const root = realpathSync(configuredRoot);

  // When --compact is set and --output was not explicitly specified,
  // default to skeleton.compact.md instead of skeleton.md.
  const defaultOutput = args.compact && !args.outputExplicit
    ? ".tokenlighten/skeleton.compact.md"
    : args.output;
  const configuredOutput = resolve(configuredRoot, defaultOutput);
  if (!isPathInside(configuredRoot, configuredOutput) || configuredOutput === configuredRoot) {
    die("--output must resolve to a file inside --root");
  }
  // Preserve the caller's lexical path relationship, then re-anchor it to the
  // canonical root (for example macOS /var -> /private/var aliases).
  const outputPath = resolve(root, relative(configuredRoot, configuredOutput));

  if (!args.quiet) {
    const mode = args.compact ? " (compact)" : "";
    process.stderr.write(`tl-skeleton: building skeleton${mode} for ${root}\n`);
  }

  const { skeleton, markdown: fullMarkdown, warnings } = await buildSkeleton(root, {
    commit: args.commit,
    topN: args.topN,
    noCache: args.noCache,
  });

  // Emit warnings.
  for (const w of warnings) {
    warn(w, args.quiet);
  }

  // Choose which markdown to write.
  const markdown = args.compact
    ? renderCompactSkeleton(skeleton, { fileSignatures: undefined })
    : fullMarkdown;

  // Ensure output directory exists.
  ensureSafeWriteParent(root, outputPath, true);
  assertSafeWriteTarget(root, outputPath);

  // Atomic write: write to tmp, then rename.
  const tmpPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmpPath, markdown, { encoding: "utf8", flag: "wx", mode: 0o600 });
    ensureSafeWriteParent(root, outputPath, false);
    assertSafeWriteTarget(root, outputPath);
    await fs.rename(tmpPath, outputPath);
  } catch (err) {
    // Clean up tmp file, preserve existing output.
    try { await fs.unlink(tmpPath); } catch { /* ignore */ }
    die(`Failed to write skeleton: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!args.quiet) {
    const kib = Math.ceil(Buffer.byteLength(markdown, "utf8") / 1024);
    process.stderr.write(`tl-skeleton: wrote ${outputPath} (${kib} KiB, ${skeleton.topRanked.length} files ranked)\n`);
  }

  if (args.strict && warnings.length > 0) {
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Exported build() shim — called by packages/cli/src/commands/skeleton.ts
// ---------------------------------------------------------------------------

export interface BuildOptions {
  repoRoot?: string;
  outputPath?: string;
  compact?: boolean;
}

/**
 * Programmatic entry point for `tl skeleton build`.
 * Accepts the same options as the CLI flags; called by the top-level tl CLI.
 */
export async function build(opts: BuildOptions = {}): Promise<void> {
  const fakeArgs: CliArgs = {
    command: "build",
    root: opts.repoRoot ?? process.cwd(),
    output: opts.outputPath ?? (opts.compact ? ".tokenlighten/skeleton.compact.md" : ".tokenlighten/skeleton.md"),
    outputExplicit: opts.outputPath != null,
    configPath: undefined,
    topN: 40,
    commit: undefined,
    noCache: false,
    quiet: false,
    strict: false,
    compact: opts.compact ?? false,
  };
  await runBuild(fakeArgs);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export async function main(argv: string[] = process.argv): Promise<void> {
  const args = parseArgs(argv);

  if (args.command === "build") {
    await runBuild(args);
  } else if (args.command === "help" || args.command === "--help" || args.command === "-h") {
    printHelp();
    process.exit(0);
  } else if (args.command === "--version" || args.command === "-v") {
    // Hardcoded literal — bump by hand alongside package.json's "version".
    process.stdout.write("tl-skeleton 0.12.1\n");
  } else {
    die(`Unknown command '${args.command}'. Run 'tl-skeleton --help' for usage.`);
  }
}

if (
  process.argv[1] !== undefined
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  main().catch((err) => {
    process.stderr.write(`tl-skeleton: fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
