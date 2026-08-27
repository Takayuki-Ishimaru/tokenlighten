/**
 * tl doctor — health checks for the TokenLighten environment
 *
 * Runs in one of two modes (see DoctorResult.mode):
 *   - "runtime" (default): what an ordinary installed CLI needs to work,
 *     including a packaged install with no adjacent repo checkout and no
 *     dev tooling (e.g. the VS Code extension's zero-install copy — see
 *     packages/vscode-extension/scripts/bundle-cli.mjs). license_checker
 *     and the python prereq are dev-only and never gate `ok` here; git
 *     absence and an unresolvable MCP dist artifact degrade to warnings.
 *   - "development" (--development): today's full contributor/CI
 *     strictness — license_checker, the python prereq (used only by
 *     `tl bench`), and the MCP dist checks all hard-fail as before.
 *
 * Checks:
 *   1. Node.js version (>=20)
 *   2. Write access to config dir
 *   3. tree-sitter WASM real capability probe: resolves web-tree-sitter's
 *      package.json and confirms its .wasm asset is present, mirroring
 *      treeSitter.ts's own resolution — NOT plain
 *      require.resolve("web-tree-sitter"), which fails by design in the
 *      packaged layout (see checkTreeSitter)
 *   4. exceljs real capability probe: the same dynamic import the runtime
 *      performs (see checkExcelJs)
 *   5. license-checker-rseidelsohn presence (dev-tooling only; warns
 *      instead of failing outside --development)
 *   6. MCP dist build freshness (source newer than dist/bin.js; staleness
 *      only hard-fails in --development, see checkMcpDistFresh)
 *   7. Public MCP artifact excludes Core 2 entry surfaces (an unresolvable
 *      artifact warns instead of failing outside --development)
 *   8. Per-client MCP registration status (evaluateDoctorAsync/runDoctor only)
 *   + node/python/git prereq detection (evaluateDoctorAsync/runDoctor
 *     only): python never gates `ok` outside --development; git never
 *     gates `ok` in either mode (see isGatingPrereq)
 *
 * Flags:
 *   --json          Emit a JSON object instead of human-readable text
 *   --development   Run today's full contributor/CI strictness (see above)
 *
 * DoctorOptions.mcpSourceDir / mcpDistBin — or the TL_MCP_SOURCE_DIR /
 * TL_MCP_DIST_BIN env vars — override where the MCP dist artifact is
 * looked for, for non-standard layouts auto-detection can't find.
 *
 * Exit 0 if all checks pass; exit 1 if any check fails.
 *
 * Exports:
 *   evaluateDoctor(opts?)      — checks-only subset (no prereq detection,
 *                                no client registration I/O); async
 *                                because the real capability probes are;
 *                                returns DoctorResult, no process.exit
 *   evaluateDoctorAsync(opts?) — adds prereq detection + client
 *                                registration checks
 *   runDoctor(args)            — prints result, calls process.exit if !ok
 *
 * Output policy: plain data — no meta envelope.
 * See docs/00-postmortem.md §2.2 for rationale.
 */

import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { createRequire } from "module";
import { resolvePath } from "../paths.js";
import { detectPrereqs, PREREQ_DOCTOR_MODE, type PrereqStatus, type PrereqId } from "../prereqs.js";
import { resolveRepoRoot } from "../repoRoot.js";
import { currentCliVersion, getClientStatuses } from "./clients.js";
import type { TokenLightenClientRegistrationStatus } from "@tokenlighten/types";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  warning?: boolean;
  detail?: string;
}

export type DoctorMode = "runtime" | "development";

export interface DoctorResult {
  ok: boolean;
  /** Which strictness level produced this result — see DoctorOptions.development. */
  mode: DoctorMode;
  checks: DoctorCheck[];
  prereqs: PrereqStatus[];
  missing: PrereqId[];
  clientRegistrations: TokenLightenClientRegistrationStatus[];
}

export interface DoctorOptions {
  /** If true, skip the config_dir_write probe (useful in unit tests that don't want FS side effects). */
  skipFsChecks?: boolean;
  /** Override development paths when testing MCP artifact checks. Falls back to the TL_MCP_SOURCE_DIR env var. */
  mcpSourceDir?: string;
  /** Public MCP entry point; its containing dist directory is inspected recursively. Falls back to the TL_MCP_DIST_BIN env var. */
  mcpDistBin?: string;
  /**
   * Run today's full contributor/CI strictness: license_checker and the
   * python prereq gate `ok`, and an unresolvable MCP dist artifact
   * (mcp_dist_fresh staleness, mcp_core2_excluded's missing bin) hard-fails
   * instead of warning. Defaults to false ("runtime" mode): checks only
   * what an ordinary installed CLI needs to work, including a packaged
   * install with no adjacent repo checkout and no dev tooling.
   */
  development?: boolean;
}

/** Prereqs whose absence is surfaced but never fails doctor, in either mode. */
const NEVER_GATING_PREREQS: ReadonlySet<PrereqId> = new Set(["git"]);

/**
 * Whether a missing/too-old prereq should fail `ok` (vs. only warn). git
 * backs the write path's shadow-checkpoint safety net (see
 * packages/mcp-server/src/write/shadowGit.ts) but writes still work
 * without it — checkpoints are just skipped — so it never gates. Prereqs
 * classified "development" in prereqs.ts (currently just python, used only
 * by `tl bench`) gate only in --development.
 */
function isGatingPrereq(id: PrereqId, development: boolean): boolean {
  if (NEVER_GATING_PREREQS.has(id)) return false;
  if (!development && PREREQ_DOCTOR_MODE[id] === "development") return false;
  return true;
}

function envOverride(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
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

function checkLicenseChecker(development: boolean): DoctorCheck {
  const check = checkImportable("license-checker-rseidelsohn", "license_checker");
  if (check.ok || development) return check;
  // Dev-tooling only: a monorepo-root devDependency used solely by
  // `npm run licenses` CI. A packaged install (no repo checkout, no dev
  // dependencies) never carries this — an expected, non-actionable absence
  // outside --development, so warn instead of failing `ok`.
  return {
    ...check,
    ok: true,
    warning: true,
    detail: `${check.detail ?? "not resolvable"} (dev-tooling only — used by \`npm run licenses\`; ignored outside --development)`,
  };
}

// Module-scoped and deliberately NOT named `require`: mirrors
// packages/mcp-server/src/skeleton/treeSitter.ts's own `_require` pattern.
// packages/vscode-extension/scripts/bundle-cli.mjs esbuild-bundles this
// very file into dist/tl-cli.js; esbuild inlines/resolves the LITERAL
// forms `require("x")` and `import("x")` at build time (this is how
// mcp-server's own tree-sitter/exceljs imports end up inlined into ITS
// bundle), but a method call on an arbitrarily-named local variable is
// invisible to that analysis and stays a genuine runtime lookup even
// after bundling. That's what checkTreeSitter below needs: proof that
// THIS process, right now, can find the WASM asset on disk — not that it
// existed on whatever machine built the bundle.
const _require = createRequire(import.meta.url);

/**
 * Real capability probe for the tree-sitter WASM runtime.
 *
 * Does NOT use require.resolve("web-tree-sitter") (the old approach,
 * equivalent to checkImportable): in the VS Code extension's zero-install
 * layout, only web-tree-sitter's package.json and .wasm files are ever
 * copied to disk — its JS entry point is inlined into mcp-server's own
 * bundle and deliberately never copied (see bundle-cli.mjs) — so bare-name
 * resolution fails BY DESIGN on every packaged install, regardless of
 * whether tree-sitter actually works there. Instead this mirrors
 * treeSitter.ts's OWN resolution exactly: resolve web-tree-sitter's
 * package.json, then confirm the adjacent tree-sitter.wasm binary is
 * actually present next to it — the precise precondition the real runtime
 * depends on (see resolveRuntimeWasmDefault in treeSitter.ts).
 *
 * Deliberately does NOT add a fresh `import("web-tree-sitter")` call site
 * to probe module shape: per getParserCtor()'s doc comment in
 * treeSitter.ts, this codebase already hit a real, empirically-verified
 * bug where a second independent `import("web-tree-sitter")` call site,
 * once bundled, observed a corrupted pre-init module shape instead of the
 * real Parser class. A doctor check isn't worth risking that again for.
 */
function checkTreeSitter(): DoctorCheck {
  let pkgJson: string;
  try {
    pkgJson = _require.resolve("web-tree-sitter/package.json");
  } catch (err) {
    return {
      name: "tree_sitter_wasm",
      ok: false,
      detail: `'web-tree-sitter/package.json' did not resolve: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const wasmPath = join(dirname(pkgJson), "tree-sitter.wasm");
  if (!existsSync(wasmPath)) {
    return {
      name: "tree_sitter_wasm",
      ok: false,
      detail: `web-tree-sitter resolved but its runtime WASM asset is missing at ${wasmPath}`,
    };
  }
  return { name: "tree_sitter_wasm", ok: true, detail: wasmPath };
}

/**
 * Real capability probe for exceljs: attempts the same dynamic
 * `import("exceljs")` the runtime performs (see mcp-server's office/*
 * wrappers) instead of require.resolve("exceljs"). exceljs is pure JS with
 * no separate asset to verify, and in the VS Code extension's zero-install
 * layout it is inlined directly into mcp-server's bundle with no on-disk
 * package of its own — so unlike tree-sitter there is no filesystem asset
 * doctor could check independently of a build-time signal. A literal
 * dynamic import here is bundled/inlined into tl-cli.js the same way
 * mcp-server's own copy is, so this correctly reports "ok" for that
 * channel (exceljs really is unconditionally available there once the
 * extension built successfully); in an unbundled run — a dev checkout, or
 * a plain `npm install` of @tokenlighten/cli — it remains a genuine
 * resolution check against real node_modules.
 */
async function checkExcelJs(): Promise<DoctorCheck> {
  try {
    await import("exceljs");
    return { name: "exceljs", ok: true };
  } catch (err) {
    return {
      name: "exceljs",
      ok: false,
      detail: `dynamic import("exceljs") failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
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
  const development = opts.development === true;
  let sourceDir = opts.mcpSourceDir ?? envOverride("TL_MCP_SOURCE_DIR");
  let distBin = opts.mcpDistBin ?? envOverride("TL_MCP_DIST_BIN");
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

  // A source checkout IS present from here on (dev/monorepo context; never
  // true in a packaged install — see the packaged-safe branch above).
  // Freshness strictness is dev-tooling behavior: only --development
  // hard-fails a stale/missing dist build. Runtime mode still runs the
  // check and surfaces the same detail, just as a warning.
  const soften = (check: DoctorCheck): DoctorCheck =>
    development || check.ok ? check : { ...check, ok: true, warning: true };

  if (!existsSync(distBin)) {
    return soften({ name: "mcp_dist_fresh", ok: false, detail: `${distBin} is missing; run npm run build` });
  }

  try {
    const sourceMtime = newestRuntimeSourceMtime(sourceDir);
    const distMtime = statSync(distBin).mtimeMs;
    const ok = sourceMtime <= distMtime;
    return soften({
      name: "mcp_dist_fresh",
      ok,
      detail: ok ? distBin : `MCP source is newer than ${distBin}; run npm run build`,
    });
  } catch (err) {
    return soften({
      name: "mcp_dist_fresh",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

function publicMcpDistBin(opts: DoctorOptions): string {
  if (opts.mcpDistBin !== undefined) return opts.mcpDistBin;
  const envBin = envOverride("TL_MCP_DIST_BIN");
  if (envBin !== undefined) return envBin;
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
    const detail = `${distBin} is missing; build the public MCP artifact before checking Core 2 exclusion (set mcpDistBin, or the TL_MCP_DIST_BIN env var, if this is a non-standard layout)`;
    if (opts.development === true) {
      return { name: "mcp_core2_excluded", ok: false, detail };
    }
    // Unresolvable in runtime mode is expected for a packaged install with
    // no adjacent MCP dist build (see checkMcpDistFresh's packaged-safe
    // branch) — warn instead of failing `ok`; --development keeps this a
    // hard requirement since a contributor checkout should always resolve.
    return { name: "mcp_core2_excluded", ok: true, warning: true, detail };
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

export async function evaluateDoctor(opts: DoctorOptions = {}): Promise<DoctorResult> {
  const development = opts.development === true;
  const checks: DoctorCheck[] = [
    checkNodeVersion(),
    ...(opts.skipFsChecks ? [] : [checkConfigDirWrite()]),
    checkTreeSitter(),
    await checkExcelJs(),
    checkLicenseChecker(development),
    checkMcpDistFresh(opts),
    checkMcpCore2Excluded(opts),
  ];

  const ok = checks.every((c) => c.ok);
  return {
    ok,
    mode: development ? "development" : "runtime",
    checks,
    prereqs: [],
    missing: [],
    clientRegistrations: [],
  };
}

/**
 * Async variant that also runs prereq detection + client registration
 * checks, and applies opts.development to gate ok/warning severity across
 * license_checker, the python prereq, git, and the MCP dist checks (see
 * isGatingPrereq, checkMcpDistFresh, checkMcpCore2Excluded).
 */
export async function evaluateDoctorAsync(opts: DoctorOptions = {}): Promise<DoctorResult> {
  const development = opts.development === true;
  const checks: DoctorCheck[] = [
    checkNodeVersion(),
    ...(opts.skipFsChecks ? [] : [checkConfigDirWrite()]),
    checkTreeSitter(),
    await checkExcelJs(),
    checkLicenseChecker(development),
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
  const gatingMissing = missing.filter((id) => isGatingPrereq(id, development));
  const prereqsOk = gatingMissing.length === 0;
  const ok = checksOk && prereqsOk;

  return {
    ok,
    mode: development ? "development" : "runtime",
    checks,
    prereqs,
    missing,
    clientRegistrations,
  };
}

/**
 * CLI entrypoint — evaluates, prints result, and calls process.exit(1) if any check fails.
 */
export async function runDoctor(args: string[]): Promise<void> {
  const jsonMode = args.includes("--json");
  const development = args.includes("--development");
  const result = await evaluateDoctorAsync({ development });

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
        const gating = isGatingPrereq(p.id, development);
        const icon = status === "OK" ? "ok  " : gating ? "FAIL" : "WARN";
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
