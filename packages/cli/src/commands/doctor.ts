/**
 * tl doctor — health checks for the TokenLighten environment
 *
 * Checks:
 *   1. Node.js version (>=20)
 *   2. Write access to config dir
 *   3. tree-sitter WASM importable (@tree-sitter/web)
 *   4. exceljs importable
 *   5. license-checker-rseidelsohn presence
 *   6. MCP dist build freshness (source newer than dist/bin.js)
 *   7. Public MCP artifact excludes Core 2 entry surfaces
 *   8. Per-client MCP registration status (evaluateDoctorAsync/runDoctor only)
 *
 * Flags:
 *   --json   Emit a JSON object instead of human-readable text
 *
 * Exit 0 if all checks pass; exit 1 if any check fails.
 *
 * Exports:
 *   evaluateDoctor(opts?)      — pure, sync subset; returns DoctorResult, no side effects, no process.exit
 *   evaluateDoctorAsync(opts?) — pure; adds prereq detection + client registration checks
 *   runDoctor(args)            — prints result, calls process.exit if !ok
 *
 * Output policy: plain data — no meta envelope.
 * See docs/00-postmortem.md §2.2 for rationale.
 */

import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { createRequire } from "module";
import { resolvePath } from "../paths.js";
import { detectPrereqs, type PrereqStatus, type PrereqId } from "../prereqs.js";
import { resolveRepoRoot } from "../repoRoot.js";
import { currentCliVersion, getClientStatuses } from "./clients.js";
import type { TokenLightenClientRegistrationStatus } from "@tokenlighten/types";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  warning?: boolean;
  detail?: string;
}

export interface DoctorResult {
  ok: boolean;
  checks: DoctorCheck[];
  prereqs: PrereqStatus[];
  missing: PrereqId[];
  clientRegistrations: TokenLightenClientRegistrationStatus[];
}

export interface DoctorOptions {
  /** If true, skip the config_dir_write probe (useful in unit tests that don't want FS side effects). */
  skipFsChecks?: boolean;
  /** Override development paths when testing MCP artifact checks. */
  mcpSourceDir?: string;
  /** Public MCP entry point; its containing dist directory is inspected recursively. */
  mcpDistBin?: string;
}

function checkNodeVersion(): DoctorCheck {
  const [major] = process.versions.node.split(".").map(Number);
  const ok = typeof major === "number" && major >= 20;
  return {
    name: "node_version",
    ok,
    detail: `${process.versions.node} (need >=20)`,
  };
}

function checkConfigDirWrite(): DoctorCheck {
  try {
    const configDir = resolvePath("config", undefined, { ensureDir: true });
    const probe = join(configDir, `.tl-write-probe-${Date.now()}`);
    writeFileSync(probe, "");
    unlinkSync(probe);
    return { name: "config_dir_write", ok: true, detail: configDir };
  } catch (err) {
    return {
      name: "config_dir_write",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function checkImportable(pkg: string, displayName: string): DoctorCheck {
  const require = createRequire(import.meta.url);
  try {
    require.resolve(pkg);
    return { name: displayName, ok: true };
  } catch {
    return { name: displayName, ok: false, detail: `'${pkg}' not found in node_modules` };
  }
}

function checkLicenseChecker(): DoctorCheck {
  return checkImportable("license-checker-rseidelsohn", "license_checker");
}

function checkTreeSitter(): DoctorCheck {
  // web-tree-sitter is the WASM runtime; also accept @tree-sitter/web
  const require = createRequire(import.meta.url);
  for (const pkg of ["web-tree-sitter", "@tree-sitter/web"]) {
    try {
      require.resolve(pkg);
      return { name: "tree_sitter_wasm", ok: true, detail: pkg };
    } catch {
      // try next
    }
  }
  return {
    name: "tree_sitter_wasm",
    ok: false,
    detail: "Neither web-tree-sitter nor @tree-sitter/web found",
  };
}

function checkExcelJs(): DoctorCheck {
  return checkImportable("exceljs", "exceljs");
}

function newestRuntimeSourceMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestRuntimeSourceMtime(abs));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".spec.ts")) {
      newest = Math.max(newest, statSync(abs).mtimeMs);
    }
  }
  return newest;
}

export function checkMcpDistFresh(opts: DoctorOptions = {}): DoctorCheck {
  let sourceDir = opts.mcpSourceDir;
  let distBin = opts.mcpDistBin;
  if (sourceDir === undefined || distBin === undefined) {
    try {
      const repoRoot = resolveRepoRoot();
      sourceDir ??= join(repoRoot, "packages", "mcp-server", "src");
      distBin ??= join(repoRoot, "packages", "mcp-server", "dist", "bin.js");
    } catch {
      const cwdRoot = process.cwd();
      const cwdSource = join(cwdRoot, "packages", "mcp-server", "src");
      if (!existsSync(cwdSource)) {
        return { name: "mcp_dist_fresh", ok: true, detail: "source checkout not present" };
      }
      sourceDir ??= cwdSource;
      distBin ??= join(cwdRoot, "packages", "mcp-server", "dist", "bin.js");
    }
  }

  if (!existsSync(sourceDir)) {
    return { name: "mcp_dist_fresh", ok: true, detail: "source checkout not present" };
  }
  if (!existsSync(distBin)) {
    return { name: "mcp_dist_fresh", ok: false, detail: `${distBin} is missing; run npm run build` };
  }

  try {
    const sourceMtime = newestRuntimeSourceMtime(sourceDir);
    const distMtime = statSync(distBin).mtimeMs;
    const ok = sourceMtime <= distMtime;
    return {
      name: "mcp_dist_fresh",
      ok,
      detail: ok ? distBin : `MCP source is newer than ${distBin}; run npm run build`,
    };
  } catch (err) {
    return {
      name: "mcp_dist_fresh",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Pure evaluation — runs all health checks and returns the result.
 * No stdout/stderr output. No process.exit. Safe to call from tests.
 *
 * Note: prereq detection is async; this sync overload returns empty prereqs
 * for backward compat. Use evaluateDoctorAsync for the full result.
 */
function publicMcpDistBin(opts: DoctorOptions): string {
  if (opts.mcpDistBin !== undefined) return opts.mcpDistBin;
  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve("@tokenlighten/mcp-server");
    return join(dirname(entry), "bin.js");
  } catch {
    try {
      return join(resolveRepoRoot(), "packages", "mcp-server", "dist", "bin.js");
    } catch {
      return join(process.cwd(), "packages", "mcp-server", "dist", "bin.js");
    }
  }
}

function runtimeJavaScriptFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...runtimeJavaScriptFiles(absolute));
    } else if (
      entry.isFile()
      && (entry.name.endsWith(".js")
        || entry.name.endsWith(".cjs")
        || entry.name.endsWith(".mjs"))
    ) {
      files.push(absolute);
    }
  }
  return files;
}

/**
 * Proves that a public MCP artifact has no Core 2 entry surface. The three
 * forbidden surfaces are a packaged core2 module tree, --core2 flag
 * acceptance, and the alternate C2_TOOLS schema.
 */
export function checkMcpCore2Excluded(opts: DoctorOptions = {}): DoctorCheck {
  const distBin = publicMcpDistBin(opts);
  if (!existsSync(distBin)) {
    return {
      name: "mcp_core2_excluded",
      ok: false,
      detail: `${distBin} is missing; build the public MCP artifact before checking Core 2 exclusion`,
    };
  }

  const distRoot = dirname(distBin);
  const adjacentSource = join(dirname(distRoot), "src");
  if (existsSync(adjacentSource)) {
    return {
      name: "mcp_core2_excluded",
      ok: true,
      detail: `${distRoot}: adjacent development source tree detected at ${adjacentSource}; Core 2 exclusion applies to shipped dist artifacts, so inspect the packaged artifact instead of the development build`,
    };
  }

  const findings: string[] = [];
  if (existsSync(join(distRoot, "core2"))) {
    findings.push("packaged core2 module directory");
  }
  try {
    for (const file of runtimeJavaScriptFiles(distRoot)) {
      const source = readFileSync(file, "utf8");
      if (source.includes("--core2")) findings.push("--core2 flag acceptance marker");
      if (
        source.includes("C2_TOOLS")
        || source.includes("Read known paths. <=64KB returns full text")
      ) {
        findings.push("C2_TOOLS alternate schema marker");
      }
    }
  } catch (error) {
    return {
      name: "mcp_core2_excluded",
      ok: false,
      detail: `could not inspect ${distRoot}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const uniqueFindings = [...new Set(findings)];
  return {
    name: "mcp_core2_excluded",
    ok: uniqueFindings.length === 0,
    detail: uniqueFindings.length === 0
      ? `${distRoot}: no --core2 flag, C2_TOOLS schema, or core2 module entry surface`
      : `Public MCP artifact still exposes Core 2 via ${uniqueFindings.join(", ")}; remove the flag, alternate schema, and prototype modules from the public build while retaining the experiment outside the published artifact`,
  };
}

export function checkClientRegistration(
  registration: TokenLightenClientRegistrationStatus,
  localTokenLightenVersion: string,
): DoctorCheck {
  const versionSkew = registration.tokenLightenVersion !== undefined
    && localTokenLightenVersion !== "unknown"
    && !registration.tokenLightenVersion.includes(localTokenLightenVersion);
  const warning = registration.state === "not-registered"
    || registration.state === "registered-foreign";
  const ok = registration.state === "client-absent"
    || warning
    || (
      registration.state === "registered-managed"
      && registration.launcherState !== "dangling"
      && !versionSkew
    );
  return {
    name: `client_registration_${registration.client}`,
    ok,
    ...(warning ? { warning: true } : {}),
    detail: registration.state === "client-absent"
      ? "client not installed"
      : [
        registration.state,
        registration.launcherState,
        registration.clientVersion,
        registration.tokenLightenVersion
          ? `registered TokenLighten ${registration.tokenLightenVersion}`
          : undefined,
        versionSkew ? `current TokenLighten ${localTokenLightenVersion} (version skew)` : undefined,
      ].filter(Boolean).join(", "),
  };
}

export function evaluateDoctor(opts: DoctorOptions = {}): DoctorResult {
  const checks: DoctorCheck[] = [
    checkNodeVersion(),
    ...(opts.skipFsChecks ? [] : [checkConfigDirWrite()]),
    checkTreeSitter(),
    checkExcelJs(),
    checkLicenseChecker(),
    checkMcpDistFresh(opts),
    checkMcpCore2Excluded(opts),
  ];

  const ok = checks.every((c) => c.ok);
  return { ok, checks, prereqs: [], missing: [], clientRegistrations: [] };
}

/**
 * Async variant that also runs prereq detection.
 */
export async function evaluateDoctorAsync(opts: DoctorOptions = {}): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [
    checkNodeVersion(),
    ...(opts.skipFsChecks ? [] : [checkConfigDirWrite()]),
    checkTreeSitter(),
    checkExcelJs(),
    checkLicenseChecker(),
    checkMcpDistFresh(opts),
    checkMcpCore2Excluded(opts),
  ];

  const prereqs = await detectPrereqs(["node", "python", "git"]);
  const missing: PrereqId[] = prereqs
    .filter((p) => !p.found || !p.meetsMin)
    .map((p) => p.id);

  const registrationResult = await getClientStatuses();
  const clientRegistrations = [...registrationResult.clients];
  const localTokenLightenVersion = currentCliVersion();
  for (const registration of clientRegistrations) {
    checks.push(checkClientRegistration(registration, localTokenLightenVersion));
  }

  const checksOk = checks.every((c) => c.ok);
  const prereqsOk = missing.length === 0;
  const ok = checksOk && prereqsOk;

  return { ok, checks, prereqs, missing, clientRegistrations };
}

/**
 * CLI entrypoint — evaluates, prints result, and calls process.exit(1) if any check fails.
 */
export async function runDoctor(args: string[]): Promise<void> {
  const jsonMode = args.includes("--json");
  const result = await evaluateDoctorAsync();

  if (jsonMode) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    for (const c of result.checks) {
      const icon = c.warning ? "WARN" : c.ok ? "ok  " : "FAIL";
      const detail = c.detail ? `  (${c.detail})` : "";
      process.stdout.write(`${icon}  ${c.name}${detail}\n`);
    }

    // Prerequisites block
    if (result.prereqs.length > 0) {
      process.stderr.write("\nPrerequisites:\n");
      for (const p of result.prereqs) {
        const status = !p.found ? "MISSING" : !p.meetsMin ? "TOO OLD" : "OK";
        const icon = status === "OK" ? "ok  " : "FAIL";
        const ver = p.version ? ` (${p.version})` : "";
        process.stderr.write(`${icon}  ${p.label}${ver}  [required: ${p.required}]\n`);
        if (status !== "OK" && p.installCommand && p.installCommand.manager !== "unknown") {
          process.stderr.write(
            `      Install hint: ${p.installCommand.manager} ${p.installCommand.args.join(" ")}\n`
          );
        } else if (status !== "OK" && p.installCommand?.manager === "unknown") {
          process.stderr.write(`      Install hint: see ${p.installCommand.docUrl}\n`);
        }
      }
    }

    if (!result.ok) {
      process.stderr.write("\ntl doctor: one or more checks failed.\n");
    }
  }

  if (!result.ok) {
    process.exit(1);
  }
}
