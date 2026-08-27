/**
 * commands/setup.ts — 'tl setup'
 *
 * Interactive prerequisite installer for TokenLighten.
 *
 * Detects Node.js, Python, and Git; prompts the user to install
 * any that are missing or below the minimum version.
 *
 * Invocation: tl setup [--check]
 *   (no subcommands)
 *
 * Rules:
 *   - ALL print to stderr (preserves --json mode of doctor).
 *   - shell:false on every spawn.
 *   - No string-concat command construction.
 *   - No new package dependencies (node:* stdlib only).
 *   - TTY detection: process.stdin.isTTY ?? false.
 *   - TL does NOT prepend sudo — POSIX package managers will fail
 *     with EACCES if user is not root. The message instructs the user
 *     to re-run with sudo or from a root shell.
 *
 * Output policy: plain data — no meta envelope.
 * See docs/00-postmortem.md §2.2 for rationale.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import {
  detectPrereqs,
  buildPrereqContext,
  type PrereqId,
  type PrereqStatus,
} from "../prereqs.js";
import { wantsHelp } from "../util/helpFlag.js";

const SETUP_USAGE = `\
Usage: tl setup [--check]

Detects the OS, shell, and package manager, then reports whether node,
python, and git meet the minimum version requirements. In an interactive
terminal, offers to install any missing prerequisites via the detected
package manager (prompts before running anything). In a non-interactive
shell, prints the install commands instead of running them.

  --check   Report prerequisite status as JSON and exit (alias for
            'tl doctor --json'); never prompts or installs anything.
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function err(msg: string): void {
  process.stderr.write(msg + "\n");
}

function printTable(statuses: PrereqStatus[]): void {
  err("");
  err("  Prerequisite   Required   Found       Status");
  err("  -------------  ---------  ----------  --------");
  for (const s of statuses) {
    const found = s.version ?? "(not found)";
    const status = !s.found
      ? "MISSING"
      : !s.meetsMin
        ? "TOO OLD"
        : "OK";
    err(
      `  ${s.label.padEnd(13)}  ${s.required.padEnd(9)}  ${found.padEnd(10)}  ${status}`
    );
  }
  err("");
}

/** Print manual install commands. Shared with prereqs.ts non-TTY path. */
function _printManualCommands(missing: PrereqStatus[]): void {
  err("Commands to run manually:");
  for (const s of missing) {
    if (!s.installCommand || s.installCommand.manager === "unknown") {
      err(`  ${s.label}: see ${s.installCommand?.docUrl ?? DOC_URLS[s.id]}`);
    } else {
      err(`  ${s.installCommand.manager} ${s.installCommand.args.join(" ")}`);
    }
    if (
      s.installCommand &&
      ["apt", "dnf", "pacman", "zypper"].includes(s.installCommand.manager)
    ) {
      err(
        `    (if you see EACCES, rerun with sudo, or rerun \`tl setup\` from a root shell)`
      );
    }
  }
}

const DOC_URLS: Record<PrereqId, string> = {
  node: "https://nodejs.org",
  python: "https://www.python.org",
  git: "https://git-scm.com",
};

// ---------------------------------------------------------------------------
// runInstall
// ---------------------------------------------------------------------------

async function runInstall(
  prereq: PrereqStatus
): Promise<{ success: boolean; message: string }> {
  const ic = prereq.installCommand;
  if (!ic || ic.manager === "unknown") {
    return {
      success: false,
      message: `No package manager detected for ${prereq.label}. Install from ${ic?.docUrl ?? DOC_URLS[prereq.id]}`,
    };
  }

  err(`\nRunning: ${ic.manager} ${ic.args.join(" ")}`);
  if (["apt", "dnf", "pacman", "zypper"].includes(ic.manager)) {
    err(
      `  (if this fails with EACCES, rerun the install command yourself with sudo,\n` +
        `   or rerun \`tl setup\` from a root shell)`
    );
  }

  const code = await new Promise<number>((resolve) => {
    const child = spawn(ic.manager, ic.args, {
      shell: false,
      stdio: "inherit",
    });
    child.on("exit", (c) => resolve(c ?? 1));
    child.on("error", (e) => {
      err(`tl setup: spawn error for ${ic.manager}: ${e.message}`);
      resolve(1);
    });
  });

  if (code === 0) {
    return { success: true, message: `${prereq.label} installed successfully.` };
  }
  return {
    success: false,
    message:
      `${prereq.label} install command exited with code ${code}.\n` +
      `  If EACCES: rerun the install command yourself with sudo, or rerun \`tl setup\` from a root shell.`,
  };
}

// ---------------------------------------------------------------------------
// runSetupNonInteractive
// ---------------------------------------------------------------------------

export async function runSetupNonInteractive(
  missing: PrereqStatus[]
): Promise<{ installed: PrereqId[]; failed: PrereqId[] }> {
  const installed: PrereqId[] = [];
  const failed: PrereqId[] = [];

  for (const s of missing) {
    const result = await runInstall(s);
    if (result.success) {
      installed.push(s.id);
    } else {
      err(`tl setup: ${result.message}`);
      failed.push(s.id);
    }
  }

  return { installed, failed };
}

// ---------------------------------------------------------------------------
// runSetup
// ---------------------------------------------------------------------------

export async function runSetup(args: string[]): Promise<void> {
  if (wantsHelp(args)) {
    process.stdout.write(SETUP_USAGE);
    return;
  }

  // --check is handled in index.ts as alias for doctor --json prereq subset
  // but if somehow passed here, just fall through to detection.

  err("TokenLighten prerequisite setup");
  err("================================");

  // Detect OS / shell / package manager
  const ctx = await buildPrereqContext();
  const shellName = process.env["SHELL"] ?? "(unknown)";
  const activePm = Object.entries(ctx.pmAvailable)
    .filter(([, ok]) => ok)
    .map(([pm]) => pm)
    .join(", ") || "none detected";

  err(`\nOS:               ${ctx.platform}`);
  err(`Shell:            ${shellName}`);
  err(`Package manager:  ${activePm}`);

  // Detect prereqs
  const statuses = await detectPrereqs(["node", "python", "git"]);
  printTable(statuses);

  const missing = statuses.filter((s) => !s.found || !s.meetsMin);

  if (missing.length === 0) {
    err("All prerequisites ready.");
    return;
  }

  // Non-interactive fallback
  if (!ctx.isTTY) {
    err(
      `Non-interactive mode. Cannot prompt.\n` +
        `Run \`tl setup\` from a terminal, OR run these commands manually:`
    );
    _printManualCommands(missing);
    process.exit(1);
  }

  // Adjacent UX hole B: check for items with no PM before computing label.
  // If any missing item has manager='unknown', bail with explicit guidance.
  const unknownPmItems = missing.filter(
    (s) => !s.installCommand || s.installCommand.manager === "unknown"
  );
  if (unknownPmItems.length > 0) {
    const names = unknownPmItems.map((s) => s.label).join(", ");
    err(
      `No package manager detected for: ${names}.\n` +
        `Install the following manually:`
    );
    for (const s of unknownPmItems) {
      const url = s.installCommand?.docUrl ?? DOC_URLS[s.id];
      err(`  ${s.label}: ${url}`);
    }
    process.exit(1);
  }

  // Determine manager label across ALL missing items
  const managers = new Set(
    missing
      .map((s) => s.installCommand?.manager)
      .filter((m): m is "winget" | "brew" | "apt" | "dnf" | "pacman" | "zypper" => !!m && m !== "unknown")
  );
  const managerLabel =
    managers.size === 1 ? [...managers][0]! : activePm || "your package manager";

  // Interactive prompt — accept 's' as alias for 'select', 'a' as alias for Y
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  let ans: string;
  try {
    ans = (
      await rl.question(
        `Install all ${missing.length} missing prerequisite(s) now via ${managerLabel}? [Y/n/select (s)] `
      )
    )
      .trim()
      .toLowerCase();
  } finally {
    rl.close();
  }

  // Default (empty enter) = Y; 'a' = Y alias
  if (ans === "" || ans === "y" || ans === "a") {
    await _installAndVerify(missing);
    return;
  }

  if (ans === "n") {
    err("OK, skipping. Run these commands manually:");
    _printManualCommands(missing);
    process.exit(1);
  }

  if (ans === "select" || ans === "s") {
    await _selectiveInstall(missing);
    return;
  }

  // Unrecognised input — treat as 'n'
  err(`Unrecognised input '${ans}'. Skipping. Run these commands manually:`);
  _printManualCommands(missing);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// _installAndVerify
// ---------------------------------------------------------------------------

async function _installAndVerify(missing: PrereqStatus[]): Promise<void> {
  let anyFailed = false;

  for (let i = 0; i < missing.length; i++) {
    const prereq = missing[i]!;
    // Nit 5: progress counter
    process.stderr.write(`[${i + 1}/${missing.length}] Installing ${prereq.label}...\n`);
    const result = await runInstall(prereq);
    err(result.message);
    if (!result.success) anyFailed = true;
  }

  // Re-detect
  err("\nRe-checking prerequisites...");
  const recheck = await detectPrereqs(["node", "python", "git"]);
  printTable(recheck);

  const stillMissing = recheck.filter((s) => !s.found || !s.meetsMin);

  if (stillMissing.length === 0) {
    // Result A: all good
    err("All prerequisites are now ready.");
    return;
  }

  if (!anyFailed) {
    // Result B: install succeeded but PATH not yet refreshed
    err(
      "Install completed but PATH not yet updated in this shell.\n" +
        "Restart your terminal and rerun tl <command>."
    );
    process.exit(0);
  }

  // Result C: install failed and prereqs still missing
  err(
    "Some prerequisites are still missing — the install may have failed.\n" +
      "Check the output above for errors, or rerun `tl setup`."
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// _selectiveInstall
// ---------------------------------------------------------------------------

async function _selectiveInstall(missing: PrereqStatus[]): Promise<void> {
  err("Select which to install:");
  missing.forEach((s, i) => {
    err(`  ${i + 1}. ${s.label} (${s.required})`);
  });

  const rl2 = createInterface({ input: process.stdin, output: process.stderr });
  let sel: string;
  try {
    sel = (
      await rl2.question(
        `Which to install? (e.g. "1,3" or "1 3" or "all"; empty = cancel) `
      )
    ).trim().toLowerCase();
  } finally {
    rl2.close();
  }

  // Empty = cancel
  if (sel === "") {
    err("Cancelled. No installations performed.");
    _printManualCommands(missing);
    process.exit(1);
  }

  if (sel === "all") {
    await _installAndVerify(missing);
    return;
  }

  // Nit 4: split on commas, spaces, or both; validate range
  const tokens = sel.split(/[,\s]+/).map((t) => t.trim()).filter((t) => t.length > 0);
  const invalidTokens: string[] = [];
  const chosen: PrereqStatus[] = [];

  for (const token of tokens) {
    const n = parseInt(token, 10);
    if (isNaN(n) || n < 1 || n > missing.length) {
      invalidTokens.push(token);
    } else {
      const item = missing[n - 1];
      if (item) chosen.push(item);
    }
  }

  if (invalidTokens.length > 0) {
    process.stderr.write(
      `Ignoring invalid selections: ${invalidTokens.join(", ")}. Valid range is 1..${missing.length}.\n`
    );
  }

  if (chosen.length === 0) {
    err("No valid selection. Skipping.");
    _printManualCommands(missing);
    process.exit(1);
  }

  await _installAndVerify(chosen);
}
