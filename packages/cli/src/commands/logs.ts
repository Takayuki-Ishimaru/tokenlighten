import { readFileSync } from "fs";
import { createRequire } from "module";
import {
  exportUsageBundle,
  readAiUsageLogs,
  readUsageEvents,
  resetUsageWindow,
  summarizeUsage,
  usageLogDirectory,
  usageWindowStart,
  usageWorkspaceId,
} from "@tokenlighten/usage";

// Same derivation as commands/version.ts and commands/help.ts: read the
// CLI's own version from its package.json via require.resolve (not a
// hardcoded "../.." from our own compiled location, so this also works from
// a single-file bundle — see packages/vscode-extension/scripts/bundle-cli.mjs).
// Exported so logs.spec.ts can pin it against package.json directly.
export function cliVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("@tokenlighten/cli/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

const LOGS_USAGE = `\
Usage: tl logs <summary|export|path|reset> [options]

  summary [--json] [--cost-per-million USD] [--workspace-root DIR]
  export --output FILE [--cost-per-million USD] [--workspace-root DIR]
  path [--ensure]
  reset [--json]

Logs stay on this machine. TokenLighten's own logs never contain prompts, file
paths, source text, tool arguments, or error messages. Summary reads only
structured usage counters and model ids from local AI logs. Export never uploads.
`;

export function formatReductionRange(
  interval: { low: number; high: number } | null,
): string {
  return interval === null
    ? ""
    : `Reduction range: ${interval.low.toFixed(1)}–${interval.high.toFixed(1)}% (95%)\n`;
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function priceFrom(args: readonly string[]): number | null {
  const raw =
    valueAfter(args, "--cost-per-million")
    ?? process.env["TOKENLIGHTEN_COST_PER_MILLION_USD"];
  if (raw === undefined) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("--cost-per-million must be a non-negative number");
  }
  return parsed;
}

export async function runLogs(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (!sub || sub === "--help" || sub === "-h") {
    process.stdout.write(LOGS_USAGE);
    return;
  }
  if (sub === "path") {
    process.stdout.write(
      `${usageLogDirectory({ ensure: rest.includes("--ensure") })}\n`,
    );
    return;
  }
  if (sub === "reset") {
    const result = resetUsageWindow();
    if (rest.includes("--json")) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      process.stdout.write(`Usage window reset at ${result.resetAt}\n`);
    }
    return;
  }
  const price = priceFrom(rest);
  const workspaceRoot = valueAfter(rest, "--workspace-root");
  if (sub === "summary") {
    let since: string | null = null;
    let workspaceId: string | null | undefined;
    let events: ReturnType<typeof readUsageEvents> = [];
    let measurementUnavailableReason: "log-dir-unavailable" | "scope-mismatch" | undefined;
    try {
      since = usageWindowStart();
      workspaceId = workspaceRoot === undefined
        ? undefined
        : usageWorkspaceId(workspaceRoot);
      // A null workspaceId means usage was never recorded on this machine.
      events = workspaceId === null
        ? []
        : readUsageEvents(undefined, since, workspaceId);
      if (
        workspaceRoot !== undefined
        && events.length === 0
        && readUsageEvents(undefined, since).length > 0
      ) {
        measurementUnavailableReason = "scope-mismatch";
      }
    } catch {
      measurementUnavailableReason = "log-dir-unavailable";
    }
    const aiLogs = readAiUsageLogs({
      since,
      workspaceRoot: workspaceRoot ?? null,
    });
    const scope = workspaceRoot === undefined
      ? { kind: "machine" } as const
      : { kind: "workspace", workspaceId: workspaceId ?? null } as const;
    const summary = {
      ...summarizeUsage(events, price, aiLogs, { scope }),
      ...(measurementUnavailableReason ? { measurementUnavailableReason } : {}),
    };
    if (rest.includes("--json")) {
      process.stdout.write(`${JSON.stringify(summary)}\n`);
      return;
    }
    const session = summary.sessionEstimate;
    const tokenReduction =
      session.tokenReductionPercent === null
        ? "unavailable"
        : `${session.tokenReductionPercent.toFixed(1)}%`;
    const costReduction =
      session.costReductionPercent === null
        ? "unavailable"
        : `${session.costReductionPercent.toFixed(1)}%`;
    // Pair factor and turns per client (clients with sessions only) so the
    // printed pair stays mutually consistent: mean(1+0.5t) == 1+0.5*mean(t).
    const residency = session.residencyModel;
    const pairedResidency = residency
      ? Object.entries(residency.meanTurnsByClient).flatMap(([client, turns]) => {
        const factor = residency.residualFactorByClient[
          client as keyof typeof residency.residualFactorByClient
        ];
        return turns !== undefined && factor !== undefined
          ? [{ factor, turns }]
          : [];
      })
      : [];
    const residencyLine =
      session.status === "estimated" && pairedResidency.length > 0
        ? `Residency factor: x${(
          pairedResidency.reduce((sum, pair) => sum + pair.factor, 0)
          / pairedResidency.length
        ).toFixed(1)} (mean ${(
          pairedResidency.reduce((sum, pair) => sum + pair.turns, 0)
          / pairedResidency.length
        ).toFixed(1)} turns/session)\n`
        : "";
    process.stdout.write(
      `Scope: ${summary.scope.kind}\n`
        + `MCP calls: ${summary.eventCount}\n`
        + `Matched AI sessions: ${session.matchedSessions}\n`
        + `Observed full-session tokens: ${session.actualTotalTokens ?? "unavailable"}\n`
        + `Predicted no-TL tokens: ${session.predictedWithoutTlTokens ?? "unavailable"}\n`
        + `Full-session token reduction: ${tokenReduction}\n`
        + formatReductionRange(session.tokenReductionPercent95)
        + `Full-session cost reduction: ${costReduction}\n`
        + residencyLine
        + `Confidence: ${session.confidence}\n`,
    );
    return;
  }
  if (sub === "export") {
    const workspaceId = workspaceRoot === undefined
      ? undefined
      : usageWorkspaceId(workspaceRoot);
    const outputPath = valueAfter(rest, "--output");
    if (!outputPath) throw new Error("tl logs export requires --output FILE");
    const exported = await exportUsageBundle({
      outputPath,
      costPerMillionTokensUsd: price,
      appVersion: cliVersion(),
      workspaceId,
      workspaceRoot: workspaceRoot ?? null,
    });
    if (rest.includes("--json")) {
      process.stdout.write(`${JSON.stringify(exported)}\n`);
    } else {
      process.stdout.write(`Exported local usage bundle: ${exported.outputPath}\n`);
    }
    return;
  }
  process.stderr.write(`tl logs: unknown subcommand '${sub}'\n${LOGS_USAGE}`);
  process.exitCode = 1;
}
