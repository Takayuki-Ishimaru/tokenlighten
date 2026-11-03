import { readFileSync } from "fs";
import { createRequire } from "module";
import {
  exportUsageBundle,
  readAiUsageLogs,
  readUsageEvents,
  resetUsageWindow,
  summarizeUsage,
  buildMeasurementDisplay,
  computeMeasurementDecomposition,
  usageLogDirectory,
  usageWindowStart,
  usageWorkspaceId,
} from "@tokenlighten/usage";
import { wantsHelp } from "../util/helpFlag.js";

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

/**
 * What every per-call baseline (and so every "context avoided" figure) is:
 * the bytes a native, non-TL read of the same files/ranges would have returned,
 * bounded to what one native read returns (2,000 lines / 25,000 tokens per file;
 * see `@tokenlighten/usage`'s nativeReadBaseline.ts). Shown beside the savings
 * numbers so an estimate is never read as billing.
 */
export const BASELINE_NOTE =
  "estimate of what native reads of the same files/ranges would have returned "
  + "(whole-file reads at file size, ranged and symbol reads at their range, "
  + "each capped at one native read of 2,000 lines / 25,000 tokens), "
  + "an estimated upper bound, not billed cost";

/**
 * The `Context avoided:` line of the text summary. The figure is signed: a log
 * where TL returned more than the estimated native reads prints a negative
 * number and says so, never a positive one. Short caveat on purpose, because
 * the basis text that follows is long.
 */
export function formatContextAvoidedLine(tier: {
  tokens: number | null;
  status: string;
  basis: string;
}): string {
  if (tier.tokens === null) {
    return `Context avoided: unavailable (${tier.status}; basis: ${tier.basis})\n`;
  }
  const caveat = tier.tokens < 0
    ? "net negative: TL returned more than the estimated native reads; not billing"
    : "estimated upper bound, not billing";
  return `Context avoided: ${tier.tokens} tokens [${caveat}] (${tier.status}; basis: ${tier.basis})\n`;
}

/** The `Baseline:` line of the text summary; counts are optional (older producers omit them). */
export function formatBaselineLine(
  byMethod: { "file-bytes": number; "range-bytes": number } | undefined,
): string {
  const counts = byMethod === undefined
    ? ""
    : ` [${byMethod["file-bytes"]} whole-file and ${byMethod["range-bytes"]} ranged/symbol baseline call(s)]`;
  return `Baseline: ${BASELINE_NOTE}${counts}\n`;
}

export function formatReductionRange(
  interval: { low: number; high: number } | null,
): string {
  return interval === null
    ? ""
    : `Reduction range: ${interval.low.toFixed(1)}–${interval.high.toFixed(1)}% (95%)\n`;
}

/**
 * Why `tl logs summary` never prints a session-level net figure: local usage
 * logs count TL's own calls and bytes, but cannot measure the extra
 * exploration a client does around them nor the task outcome, so a number
 * here would be fabricated from per-call telemetry with no paired verified
 * control.
 */
export const SESSION_NET_UNAVAILABLE_BASIS =
  "local usage logs cannot measure extra exploration or task outcome; "
  + "a paired verified control (the same task run with and without TL, outcome-checked) is required";

/**
 * Labels a printed full-session reduction as a model estimate when it came
 * from the analytic fallback calibration (no paired observed/predicted data),
 * so it never reads as a verified measurement. Paired-derived estimates and
 * unavailable figures print unchanged.
 */
function sessionEstimateCaveat(
  session: { calibration?: { source?: string } | undefined },
  available: boolean,
): string {
  return available && session.calibration?.source === "analytic-fallback"
    ? " (model estimate from the analytic fallback; not a verified measurement)"
    : "";
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
  if (!sub || wantsHelp(args)) {
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
    // Always-derivable measured side (call count, response bytes, a bytes/4
    // token estimate, per-tool breakdown): computed straight from the local
    // usage events, independent of whether a native-baseline comparison is
    // available. Kept separate from summarizeUsage()'s baseline/savings
    // fields so the fail-closed "unavailable" wording there never changes.
    const totalResponseBytes = events.reduce(
      (sum, entry) => sum + entry.responseBytes,
      0,
    );
    const canonicalSummary = summarizeUsage(events, price, aiLogs, { scope });
    const savingEventIndex = canonicalSummary.measuredBaselineCalls > 0
      ? events.findIndex((event) => event.outcome === "ok")
      : -1;
    const measurementEvents = events.map((_event, callIndex) => ({
      event: "usage_call",
      call_id: callIndex + 1,
      ...(callIndex === savingEventIndex
        ? { estimatedSavedTokens: canonicalSummary.estimatedSavedTokens }
        : {}),
    }));
    const decomposition = computeMeasurementDecomposition(measurementEvents);
    if (savingEventIndex >= 0) {
      const cap = canonicalSummary.baselineCap;
      const clampNote = cap !== undefined && cap.clampedCalls > 0
        ? `; ${cap.clampedCalls} call(s) bounded to ${cap.maxTokensPerCall} baseline tokens each (${cap.clampedTokens} tokens removed)`
        : "";
      decomposition.direct_context_saving.provenance.basis =
        "canonical task-grouped baseline minus successful responses in "
        + "baseline-anchored task groups; errors and unanchored task groups "
        + `excluded (${canonicalSummary.measuredBaselineCalls} baseline-bearing call(s)); `
        + "the baseline is an estimate of native reads of the same files/ranges, not billed cost, "
        + `capped at one native read per call (2,000 lines / 25,000 tokens): an estimated upper bound${clampNote}`;
    }
    // A per-call usage log records what TL returned, never what the agent
    // would have done without TL: extra exploration and the task outcome are
    // unobservable here, so no session-level net saving is derivable without
    // a paired verified control (the same task run with and without TL,
    // outcome-checked). The engine's `net` is built from this fabricated
    // per-call shape, so the CLI reports it unavailable instead.
    const display = buildMeasurementDisplay(decomposition);
    const measurementDisplay = {
      ...display,
      session: {
        ...display.session,
        net: {
          status: "unavailable" as const,
          basis: SESSION_NET_UNAVAILABLE_BASIS,
          tokens: null,
          cashUsd: null,
        },
      },
    };
    const summary = {
      ...canonicalSummary,
      totalResponseBytes,
      method: "file-bytes" as const,
      baselineNote: BASELINE_NOTE,
      measurementDisplay,
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
        + `TL response bytes: ${summary.totalResponseBytes}\n`
        + `TL response tokens: ~${summary.estimatedResponseTokens} (est.)\n`
        + `TL response measurement method: ${summary.method}\n`
        + formatBaselineLine(summary.measuredBaselineCallsByMethod)
        + formatContextAvoidedLine(summary.measurementDisplay.contextAvoided)
        + `Session net: ${measurementDisplay.session.net.tokens === null ? "unavailable" : `${measurementDisplay.session.net.tokens} tokens`} (${measurementDisplay.session.net.status}; basis: ${measurementDisplay.session.net.basis})\n`
        + `By tool: tl_read_file ${summary.byTool.tl_read_file}, `
        + `tl_search_files ${summary.byTool.tl_search_files}, `
        + `tl_edit_file ${summary.byTool.tl_edit_file}\n`
        + `Matched AI sessions: ${session.matchedSessions}\n`
        + `Observed full-session tokens: ${session.actualTotalTokens ?? "unavailable"}\n`
        + `Predicted no-TL tokens: ${session.predictedWithoutTlTokens ?? "unavailable"}${sessionEstimateCaveat(session, session.predictedWithoutTlTokens !== null)}\n`
        + `Model-estimated full-session token reduction: ${tokenReduction}${sessionEstimateCaveat(session, tokenReduction !== "unavailable")}\n`
        + formatReductionRange(session.tokenReductionPercent95)
        + `Model-estimated full-session cost reduction: ${costReduction}${sessionEstimateCaveat(session, costReduction !== "unavailable")}\n`
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
