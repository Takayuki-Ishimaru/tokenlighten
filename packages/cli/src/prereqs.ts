/**
 * prereqs.ts — prerequisite detection and install-command resolution.
 *
 * Detects Node.js, Python, and Git versions; resolves the appropriate
 * package-manager install command for the current platform.
 *
 * ALL spawn calls use shell:false, args array form — no string concat.
 *
 * Output policy: plain data — no meta envelope.
 * See docs/00-postmortem.md §2.2 for rationale.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PrereqId = "node" | "python" | "git";
export type PmName = "winget" | "brew" | "apt" | "dnf" | "pacman" | "zypper";

export interface PrereqStatus {
  id: PrereqId;
  label: string;
  required: string;
  found: boolean;
  version: string | null;
  meetsMin: boolean;
  installCommand: InstallCommand | null;
}

export interface InstallCommand {
  manager: PmName | "unknown";
  args: string[];
  docUrl: string;
}

export interface PrereqContext {
  isTTY: boolean;
  platform: NodeJS.Platform;
  pmAvailable: {
    winget: boolean;
    brew: boolean;
    apt: boolean;
    dnf: boolean;
    pacman: boolean;
    zypper: boolean;
  };
}

// ---------------------------------------------------------------------------
// Version parsing helpers
// ---------------------------------------------------------------------------

/** Parse a semver-like string and return [major, minor, patch] or null. */
function parseSemver(raw: string): [number, number, number] | null {
  const m = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

// ---------------------------------------------------------------------------
// Package-manager probe
// ---------------------------------------------------------------------------

function isPmAvailable(pm: string): boolean {
  if (process.platform === "win32") {
    // Use 'where' on Windows — shell:false, array args
    const r = spawnSync("where", [pm], { shell: false, encoding: "utf-8" });
    return r.status === 0;
  }
  // POSIX: use 'which' (POSIX standard, available on macOS/Linux)
  const r = spawnSync("which", [pm], { shell: false, encoding: "utf-8" });
  return r.status === 0;
}

// ---------------------------------------------------------------------------
// buildPrereqContext
// ---------------------------------------------------------------------------

export async function buildPrereqContext(): Promise<PrereqContext> {
  const isTTY = process.stdin.isTTY ?? false;
  const platform = process.platform;

  const pmAvailable = {
    winget: isPmAvailable("winget"),
    brew: isPmAvailable("brew"),
    apt: isPmAvailable("apt"),
    dnf: isPmAvailable("dnf"),
    pacman: isPmAvailable("pacman"),
    zypper: isPmAvailable("zypper"),
  };

  return { isTTY, platform, pmAvailable };
}

// ---------------------------------------------------------------------------
// readOsRelease — parse /etc/os-release to detect native Linux PM
// ---------------------------------------------------------------------------

/** Read /etc/os-release and return the best matching PmName, or null. */
export function readOsRelease(): PmName | null {
  let content: string;
  try {
    content = fs.readFileSync("/etc/os-release", "utf8");
  } catch {
    return null;
  }

  function extractField(field: string): string | null {
    const m = content.match(new RegExp(`^${field}=["']?([^"'\\n]+)["']?`, "m"));
    return m ? m[1].trim().toLowerCase() : null;
  }

  function mapDistro(id: string): PmName | null {
    if (/ubuntu|debian|linuxmint|pop|kali/.test(id)) return "apt";
    if (/fedora|rhel|centos|rocky|almalinux/.test(id)) return "dnf";
    if (/arch|manjaro|endeavouros|cachyos/.test(id)) return "pacman";
    if (/opensuse|sles|suse/.test(id)) return "zypper";
    return null;
  }

  const id = extractField("ID");
  if (id) {
    const pm = mapDistro(id);
    if (pm) return pm;
  }

  const idLike = extractField("ID_LIKE");
  if (idLike) {
    // ID_LIKE can be a space-separated list
    for (const part of idLike.split(/\s+/)) {
      const pm = mapDistro(part);
      if (pm) return pm;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// platformPmPriority
// ---------------------------------------------------------------------------

export function platformPmPriority(ctx: PrereqContext): PmName[] {
  if (ctx.platform === "win32") return ["winget"];
  if (ctx.platform === "darwin") return ["brew"];
  // Linux:
  const nativeFromOsRelease = readOsRelease();
  const fallback: PmName[] = ["apt", "dnf", "pacman", "zypper"];
  if (nativeFromOsRelease) {
    return [nativeFromOsRelease, ...fallback.filter((p) => p !== nativeFromOsRelease)];
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// pickInstallCommand
// ---------------------------------------------------------------------------

const DOC_URLS: Record<PrereqId, string> = {
  node: "https://nodejs.org",
  python: "https://www.python.org",
  git: "https://git-scm.com",
};

export function pickInstallCommand(
  id: PrereqId,
  ctx: PrereqContext
): InstallCommand | null {
  const priority = platformPmPriority(ctx);

  let manager: PmName | "unknown" = "unknown";
  for (const pm of priority) {
    if (ctx.pmAvailable[pm]) {
      manager = pm;
      break;
    }
  }

  // Fallback: if no platform-priority PM is available, try any available PM.
  // This handles cross-platform environments (e.g., apt installed on macOS)
  // and ensures install commands can be resolved for testing/CI scenarios.
  if (manager === "unknown") {
    const ALL_PMS: PmName[] = ["winget", "brew", "apt", "dnf", "pacman", "zypper"];
    for (const pm of ALL_PMS) {
      if (ctx.pmAvailable[pm]) {
        manager = pm;
        break;
      }
    }
  }

  const docUrl = DOC_URLS[id];

  if (manager === "unknown") {
    return { manager: "unknown", args: [], docUrl };
  }

  const TABLE: Record<PrereqId, Record<PmName, string[]>> = {
    node: {
      winget: ["install", "OpenJS.NodeJS.LTS", "--accept-source-agreements", "--accept-package-agreements", "--silent"],
      brew:   ["install", "node@20"],
      apt:    ["install", "-y", "nodejs", "npm"],
      dnf:    ["install", "-y", "nodejs"],
      pacman: ["-S", "--noconfirm", "nodejs", "npm"],
      zypper: ["install", "-y", "nodejs20"],
    },
    python: {
      winget: ["install", "Python.Python.3.12", "--accept-source-agreements", "--accept-package-agreements", "--silent"],
      brew:   ["install", "python@3.12"],
      apt:    ["install", "-y", "python3.12", "python3.12-venv"],
      dnf:    ["install", "-y", "python3.12"],
      pacman: ["-S", "--noconfirm", "python"],
      zypper: ["install", "-y", "python312"],
    },
    git: {
      winget: ["install", "Git.Git", "--accept-source-agreements", "--accept-package-agreements", "--silent"],
      brew:   ["install", "git"],
      apt:    ["install", "-y", "git"],
      dnf:    ["install", "-y", "git"],
      pacman: ["-S", "--noconfirm", "git"],
      zypper: ["install", "-y", "git"],
    },
  };

  return {
    manager,
    args: TABLE[id][manager],
    docUrl,
  };
}

// ---------------------------------------------------------------------------
// Individual detectors
// ---------------------------------------------------------------------------

function detectNode(): { found: boolean; version: string | null; meetsMin: boolean } {
  const r = spawnSync("node", ["-v"], { shell: false, encoding: "utf-8" });
  if (r.error || r.status !== 0) {
    return { found: false, version: null, meetsMin: false };
  }
  const raw = (r.stdout ?? "").trim();
  const parsed = parseSemver(raw);
  if (!parsed) {
    return { found: true, version: raw, meetsMin: false };
  }
  const [major] = parsed;
  return { found: true, version: raw, meetsMin: major >= 20 };
}

export interface PythonCommand {
  command: string;
  argsPrefix: string[];
  version: string;
  meetsMin: boolean;
}

export function resolvePythonCommand(): PythonCommand | null {
  // Try candidates in order. On Windows 'py -3' is the official launcher.
  const candidates: [string, string[]][] =
    process.platform === "win32"
      ? [["python3", ["-V"]], ["python", ["-V"]], ["py", ["-3", "-V"]]]
      : [["python3.12", ["-V"]], ["python3.11", ["-V"]], ["python3", ["-V"]], ["python", ["-V"]]];

  for (const [bin, args] of candidates) {
    const r = spawnSync(bin, args, { shell: false, encoding: "utf-8" });
    if (r.error || r.status !== 0) continue;
    // Python prints to both stdout (newer) and stderr (older)
    const raw = ((r.stdout ?? "") + (r.stderr ?? "")).trim();
    const m = raw.match(/Python (\d+)\.(\d+)\.(\d+)/i);
    if (!m) continue;
    const major = parseInt(m[1], 10);
    const minor = parseInt(m[2], 10);
    const version = `Python ${m[1]}.${m[2]}.${m[3]}`;
    return {
      command: bin,
      argsPrefix: args.slice(0, -1),
      version,
      meetsMin: major > 3 || major === 3 && minor >= 11,
    };
  }
  return null;
}

function detectPython(): { found: boolean; version: string | null; meetsMin: boolean } {
  const python = resolvePythonCommand();
  if (python) {
    return {
      found: true,
      version: python.version,
      meetsMin: python.meetsMin,
    };
  }
  return { found: false, version: null, meetsMin: false };
}

function detectGit(): { found: boolean; version: string | null; meetsMin: boolean } {
  const r = spawnSync("git", ["--version"], { shell: false, encoding: "utf-8" });
  if (r.error || r.status !== 0) {
    return { found: false, version: null, meetsMin: false };
  }
  const raw = (r.stdout ?? "").trim();
  const parsed = parseSemver(raw);
  if (!parsed) {
    return { found: true, version: raw, meetsMin: false };
  }
  const [major] = parsed;
  return { found: true, version: raw, meetsMin: major >= 2 };
}

// ---------------------------------------------------------------------------
// detectPrereqs
// ---------------------------------------------------------------------------

export async function detectPrereqs(required: PrereqId[]): Promise<PrereqStatus[]> {
  const ctx = await buildPrereqContext();

  const META: Record<PrereqId, { label: string; required: string }> = {
    node:   { label: "Node.js", required: ">=20" },
    python: { label: "Python",  required: ">=3.11" },
    git:    { label: "Git",     required: ">=2" },
  };

  return required.map((id) => {
    let found: boolean;
    let version: string | null;
    let meetsMin: boolean;

    switch (id) {
      case "node":
        ({ found, version, meetsMin } = detectNode());
        break;
      case "python":
        ({ found, version, meetsMin } = detectPython());
        break;
      case "git":
        ({ found, version, meetsMin } = detectGit());
        break;
    }

    const installCommand = (!found || !meetsMin) ? pickInstallCommand(id, ctx) : null;

    return {
      id,
      label: META[id].label,
      required: META[id].required,
      found,
      version,
      meetsMin,
      installCommand,
    };
  });
}

// ---------------------------------------------------------------------------
// printManualCommands — shared helper used by ensurePrereqs + setup.ts
// ---------------------------------------------------------------------------

export function printManualCommands(
  missing: PrereqStatus[],
  stream: NodeJS.WritableStream = process.stderr
): void {
  stream.write("Install commands (run manually):\n");
  for (const prereq of missing) {
    const ic = prereq.installCommand;
    if (!ic || ic.manager === "unknown") {
      stream.write(`  ${prereq.label}: see ${ic?.docUrl ?? DOC_URLS[prereq.id]}\n`);
    } else {
      stream.write(`  ${ic.manager} ${ic.args.join(" ")}\n`);
    }
  }
}

// ---------------------------------------------------------------------------
// ensurePrereqs — pre-flight helper used by proxy / mcp / bench
// ---------------------------------------------------------------------------

/**
 * Checks that required prereqs are present and meet minimum versions.
 * If any are missing:
 *   - isTTY=true: prompts to install; if user says yes, installs and re-checks.
 *   - isTTY=false: prints details + manual commands, then calls process.exit(1).
 *
 * Pass noPrereqCheck=true (from --no-prereq-check flag or TL_NO_PREREQ_CHECK env)
 * to skip entirely.
 *
 * Three-way result after install:
 *   A. stillMissing empty                        → return (continue original command)
 *   B. stillMissing non-empty + !anyInstallFailed → exit 0 (PATH-not-refreshed, tell user to restart)
 *   C. stillMissing non-empty + anyInstallFailed  → exit 1 (failure report)
 */
export async function ensurePrereqs(
  required: PrereqId[],
  noPrereqCheck?: boolean
): Promise<void> {
  // Honor --no-prereq-check
  const skip =
    noPrereqCheck === true || process.env["TL_NO_PREREQ_CHECK"] === "1";
  if (skip) return;

  const statuses = await detectPrereqs(required);
  const missing = statuses.filter((s) => !s.found || !s.meetsMin);

  if (missing.length === 0) return;

  const ctx = await buildPrereqContext();

  // Format missing list for display
  const missingLabels = missing.map((s) => `${s.label} ${s.required}`).join(", ");

  if (!ctx.isTTY) {
    // Adjacent UX hole A: print details + manual commands in non-TTY context
    process.stderr.write(
      `tl: Required prerequisites missing for this command:\n`
    );
    for (const prereq of missing) {
      process.stderr.write(
        `  - ${prereq.label} (required: ${prereq.required}, found: ${prereq.found ? prereq.version : "NOT FOUND"})\n`
      );
    }
    printManualCommands(missing, process.stderr);
    process.stderr.write(`Or run \`tl setup\` from an interactive terminal.\n`);
    process.exit(1);
  }

  // Interactive: find a detected manager
  const ic = missing[0]?.installCommand;
  const managerLabel =
    ic && ic.manager !== "unknown" ? ic.manager : "your package manager";

  // Inline readline to avoid circular import of setup.ts
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  let ans: string;
  try {
    ans = (
      await rl.question(
        `Required: ${missingLabels}. Install via ${managerLabel}? [Y/n] `
      )
    )
      .trim()
      .toLowerCase();
  } finally {
    rl.close();
  }

  if (ans !== "" && ans !== "y") {
    process.stderr.write(
      `tl: Skipping install. Run \`tl setup\` to install prerequisites.\n`
    );
    process.exit(1);
  }

  // Run installs — collect exit codes, do NOT exit during loop
  const { spawn } = await import("node:child_process");
  const installResults: Array<{ prereq: PrereqStatus; code: number }> = [];

  for (let i = 0; i < missing.length; i++) {
    const prereq = missing[i]!;
    const prereqIc = prereq.installCommand;

    // Nit 5: progress counter
    process.stderr.write(`[${i + 1}/${missing.length}] Installing ${prereq.label}...\n`);

    if (!prereqIc || prereqIc.manager === "unknown") {
      process.stderr.write(
        `tl: No package manager for ${prereq.label}. Install from ${prereqIc?.docUrl ?? DOC_URLS[prereq.id]}\n`
      );
      installResults.push({ prereq, code: 1 });
      continue;
    }

    process.stderr.write(`Running: ${prereqIc.manager} ${prereqIc.args.join(" ")}\n`);
    const code = await new Promise<number>((resolve) => {
      const child = spawn(prereqIc.manager, prereqIc.args, {
        shell: false,
        stdio: "inherit",
      });
      child.on("exit", (c) => resolve(c ?? 1));
      child.on("error", () => resolve(1));
    });

    installResults.push({ prereq, code });
  }

  // Re-check after ALL installs finish
  const recheck = await detectPrereqs(required);
  const stillMissing = recheck.filter((s) => !s.found || !s.meetsMin);
  const anyInstallFailed = installResults.some((r) => r.code !== 0);

  if (stillMissing.length === 0) {
    // Result A: all good — continue with original command
    return;
  }

  if (!anyInstallFailed) {
    // Result B: install succeeded but PATH not yet refreshed
    process.stderr.write(
      `tl: Install completed but PATH not yet updated in this shell.\n` +
        `Restart your terminal and rerun tl <command>.\n`
    );
    process.exit(0);
  }

  // Result C: some install failed and prereqs still missing
  process.stderr.write(`tl: Some prerequisites are still missing after install:\n`);
  for (const r of installResults) {
    if (r.code !== 0) {
      process.stderr.write(
        `  - ${r.prereq.label}: install exited with code ${r.code}\n`
      );
    }
  }
  process.stderr.write(`Run \`tl setup\` for detailed troubleshooting.\n`);
  process.exit(1);
}
