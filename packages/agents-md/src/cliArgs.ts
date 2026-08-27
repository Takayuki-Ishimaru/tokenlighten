// Plain data output — no meta envelope. See docs/00-postmortem.md §2.2.
//
// Pure argument-parsing for the tl-agents CLI, split out of cli.ts so it can
// be unit-tested without importing cli.ts's top-level `main().catch(...)`
// entrypoint invocation: cli.ts calls main() unconditionally at module load
// (it is the package's `bin` script, invoked as `node dist/cli.js ...`), so
// importing cli.ts directly from a test would run main() against the TEST
// RUNNER's own process.argv and could call process.exit mid-suite. This
// module has no top-level side effects and is safe to import anywhere.
//
// cli.ts is the sole runtime consumer; it translates a thrown CliArgError
// into the historic `[tl-agents] ERROR: ...` stderr message + exit(1).

import type { StubTargetId } from "@tokenlighten/types";
import type { GuideProfile, Locale } from "./render.js";

export const VALID_TARGETS: StubTargetId[] = ["claude", "copilot", "cursor", "cline", "continue"];
export const VALID_LOCALES: Locale[] = ["en", "jp"];
export const VALID_PROFILES: GuideProfile[] = ["full", "medium", "compact"];

/** Thrown by parseArgs on an invalid flag value; message matches the historic CLI wording. */
export class CliArgError extends Error {}

export interface ParsedCliArgs {
  command: string;
  targets?: StubTargetId[];
  locale?: Locale;
  profile?: GuideProfile;
  force: boolean;
  check: boolean;
}

export function parseArgs(args: string[]): ParsedCliArgs {
  const [, , cmdRaw = "help", ...rest] = args;
  const command = cmdRaw.startsWith("--") ? "update" : cmdRaw;

  // Treat bare flags before the command as part of "update"
  const allArgs = cmdRaw.startsWith("--") ? [cmdRaw, ...rest] : rest;

  let targets: StubTargetId[] | undefined;
  let locale: Locale | undefined;
  let profile: GuideProfile | undefined;
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
          throw new CliArgError(`unknown target "${t}". Valid: ${VALID_TARGETS.join(", ")}`);
        }
      }
      targets = parsed;
    } else if (arg === "--profile" && allArgs[i + 1]) {
      const raw = allArgs[++i] as GuideProfile;
      if (!VALID_PROFILES.includes(raw)) {
        throw new CliArgError(`unknown profile "${raw}". Valid: ${VALID_PROFILES.join(", ")}`);
      }
      profile = raw;
    } else if (arg === "--locale" && allArgs[i + 1]) {
      const raw = allArgs[++i]! as Locale;
      if (!VALID_LOCALES.includes(raw)) {
        throw new CliArgError(`unknown locale "${raw}". Valid: ${VALID_LOCALES.join(", ")}`);
      }
      locale = raw;
    }
  }

  return { command, targets, locale, profile, force, check };
}
