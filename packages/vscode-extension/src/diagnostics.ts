// Plain data output — no meta envelope. See docs/00-postmortem.md §2.2.
//
// diagnostics.ts — pure data collection for the "TokenLighten: Diagnostics"
// view. No `vscode` import at the top level (matches cli.ts/workspaceState.ts
// convention: this module works from a workspace root path and a few
// caller-supplied settings, so it can be exercised with a plain temp
// directory in tests). The webview rendering layer (diagnosticsPanel.ts)
// is the vscode-dependent half.

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
// Subpaths, not the package root: the root index.js re-exports render.ts /
// injectForTarget.ts, whose module-load-time fileURLToPath(import.meta.url)
// throws once esbuild bundles this extension to CJS (import.meta is empty
// under CJS) — verified by probe; see version.ts's header comment. These two
// files have no such module-load-time filesystem resolution.
import { INSTRUCTIONS_VERSION } from "@tokenlighten/agents-md/version";
import { parseSentinelBlock } from "@tokenlighten/agents-md/sentinel";
import { readDiagRingFile, type DiagRingCall } from "@tokenlighten/usage/diag";
import { getMcpLaunchConfig, getTlVersion } from "./cli.js";

export type GuideSource = "AGENTS.md" | "CLAUDE.md";
export type RingStatus = "ok" | "empty" | "disabled" | "unknown";

export interface RegistrationStatus {
  /** Absolute path checked, whether or not it exists. */
  path: string;
  fileExists: boolean;
  hasTokenlighten: boolean;
  /** null when the file/entry is absent, or the entry has no `args` array to inspect. */
  allowWrite: boolean | null;
}

export interface GuideStatus {
  installedVersion: string | null;
  bundledVersion: string;
  source: GuideSource | null;
  upToDate: boolean;
}

export interface RingSummary {
  status: RingStatus;
  /** Oldest first, matching the ring file's on-disk order. */
  calls: DiagRingCall[];
  serverVersion?: string;
  serverBuild?: string;
  updatedAt?: string;
}

export interface DiagnosticsSnapshot {
  extensionVersion: string;
  tlVersion: string | undefined;
  nodeExecutable: string;
  serverLaunch: { command: string; args: string[] };
  workspaceRoot: string;
  writeEnabledSetting: boolean | null;
  registrations: {
    claudeMcpJson: RegistrationStatus;
    vscodeMcpJson: RegistrationStatus;
    codexConfigToml: RegistrationStatus;
  };
  guide: GuideStatus;
  ring: RingSummary;
}

export interface CollectDiagnosticsInput {
  extensionVersion: string;
  workspaceRoot: string;
  /** workspaceMcpSettingsCached()?.writeEnabled ?? null when not configured/unknown. */
  writeEnabledSetting: boolean | null;
  /** workspaceMcpSettingsCached()?.usageLoggingEnabled ?? null — used only to label an absent ring file. */
  usageLoggingEnabledSetting: boolean | null;
  /** Test-only override; production always resolves defaultDiagDir() (~/.tokenlighten/diag). */
  ringDirectory?: string;
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function readTomlObject(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    const parsed = parseToml(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function nestedObject(
  parent: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null {
  if (!parent) return null;
  const value = parent[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function entryAllowWrite(entry: Record<string, unknown> | null): boolean | null {
  if (!entry) return null;
  const args = entry["args"];
  return Array.isArray(args) ? args.includes("--allow-write") : null;
}

function registrationStatus(
  root: string,
  relativePath: string,
  read: (path: string) => Record<string, unknown> | null,
  serversKey: string,
): RegistrationStatus {
  const path = join(root, relativePath);
  const fileExists = existsSync(path);
  const document = read(path);
  const servers = nestedObject(document, serversKey);
  const entry = nestedObject(servers, "tokenlighten");
  return {
    path,
    fileExists,
    hasTokenlighten: entry !== null,
    allowWrite: entryAllowWrite(entry),
  };
}

function readGuideStatus(root: string): GuideStatus {
  const candidates: ReadonlyArray<readonly [string, GuideSource]> = [
    [join(root, "AGENTS.md"), "AGENTS.md"],
    [join(root, "CLAUDE.md"), "CLAUDE.md"],
  ];
  for (const [path, source] of candidates) {
    try {
      if (!existsSync(path)) continue;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      const { block } = parseSentinelBlock(readFileSync(path, "utf8"));
      if (block?.version) {
        return {
          installedVersion: block.version,
          bundledVersion: INSTRUCTIONS_VERSION,
          source,
          upToDate: block.version === INSTRUCTIONS_VERSION,
        };
      }
    } catch {
      // Malformed sentinel pair or unreadable file — try the next candidate.
    }
  }
  return {
    installedVersion: null,
    bundledVersion: INSTRUCTIONS_VERSION,
    source: null,
    upToDate: false,
  };
}

function readRingSummary(
  workspaceRoot: string,
  usageLoggingEnabledSetting: boolean | null,
  ringDirectory?: string,
): RingSummary {
  const ring = readDiagRingFile(workspaceRoot, ringDirectory);
  if (ring) {
    return {
      status: "ok",
      calls: ring.calls,
      serverVersion: ring.server_version,
      serverBuild: ring.server_build,
      updatedAt: ring.updated_at,
    };
  }
  // No file on disk: only INFER why. usageLoggingEnabledSetting mirrors the
  // exact TOKENLIGHTEN_USAGE_LOG value mcpProvider.ts launches the server
  // with, so a known-false setting is a reasonably confident "disabled" —
  // never asserted when the setting itself is unknown.
  if (usageLoggingEnabledSetting === false) return { status: "disabled", calls: [] };
  if (usageLoggingEnabledSetting === true) return { status: "empty", calls: [] };
  return { status: "unknown", calls: [] };
}

export function collectDiagnostics(input: CollectDiagnosticsInput): DiagnosticsSnapshot {
  const writeEnabled = input.writeEnabledSetting === true;
  const serverLaunch = getMcpLaunchConfig([
    "mcp",
    "start",
    "--stdio",
    ...(writeEnabled ? ["--allow-write"] : []),
  ]);
  return {
    extensionVersion: input.extensionVersion,
    tlVersion: getTlVersion(),
    nodeExecutable: process.execPath,
    // Executable + args only, as the task asks for — never the resolved env
    // (e.g. ELECTRON_RUN_AS_NODE), which nobody asked to display.
    serverLaunch: { command: serverLaunch.command, args: serverLaunch.args },
    workspaceRoot: input.workspaceRoot,
    writeEnabledSetting: input.writeEnabledSetting,
    registrations: {
      claudeMcpJson: registrationStatus(input.workspaceRoot, ".mcp.json", readJsonObject, "mcpServers"),
      vscodeMcpJson: registrationStatus(
        input.workspaceRoot,
        join(".vscode", "mcp.json"),
        readJsonObject,
        "servers",
      ),
      codexConfigToml: registrationStatus(
        input.workspaceRoot,
        join(".codex", "config.toml"),
        readTomlObject,
        "mcp_servers",
      ),
    },
    guide: readGuideStatus(input.workspaceRoot),
    ring: readRingSummary(input.workspaceRoot, input.usageLoggingEnabledSetting, input.ringDirectory),
  };
}

interface DiagnosticsTextCopy {
  title: string;
  extensionVersion: string;
  tlVersion: string;
  serverBuild: string;
  nodeExecutable: string;
  serverLaunch: string;
  workspaceRoot: string;
  writeEnabled: string;
  unknown: string;
  yes: string;
  no: string;
  registered: string;
  notRegistered: string;
  notFound: string;
  allowWrite: string;
  guideVersion: string;
  notInstalled: string;
  upToDate: string;
  outOfDate: string;
  bundled: string;
  lastCalls: string;
  noCalls: string;
  disabledCalls: string;
  at: string;
  ok: string;
  error: string;
}

const TEXT_COPY: Record<"en" | "ja", DiagnosticsTextCopy> = {
  en: {
    title: "TokenLighten Diagnostics",
    extensionVersion: "Extension version",
    tlVersion: "TL CLI/server version",
    serverBuild: "Server build",
    nodeExecutable: "Node executable",
    serverLaunch: "Server launch",
    workspaceRoot: "Workspace root",
    writeEnabled: "Write enabled (workspace setting)",
    unknown: "unknown",
    yes: "yes",
    no: "no",
    registered: "registered",
    notRegistered: "no tokenlighten entry",
    notFound: "not found",
    allowWrite: "--allow-write",
    guideVersion: "Guide version",
    notInstalled: "not installed",
    upToDate: "up to date",
    outOfDate: "out of date",
    bundled: "bundled",
    lastCalls: "Last call(s)",
    noCalls: "no calls recorded yet",
    disabledCalls: "recording disabled",
    at: "at",
    ok: "ok",
    error: "error",
  },
  ja: {
    title: "TokenLighten 診断",
    extensionVersion: "拡張機能バージョン",
    tlVersion: "TL CLI/サーバーバージョン",
    serverBuild: "サーバービルド",
    nodeExecutable: "Node実行ファイル",
    serverLaunch: "サーバー起動コマンド",
    workspaceRoot: "ワークスペースルート",
    writeEnabled: "書き込み許可（ワークスペース設定）",
    unknown: "不明",
    yes: "はい",
    no: "いいえ",
    registered: "登録済み",
    notRegistered: "tokenlightenエントリなし",
    notFound: "見つかりません",
    allowWrite: "--allow-write",
    guideVersion: "ガイドバージョン",
    notInstalled: "未インストール",
    upToDate: "最新",
    outOfDate: "更新が必要",
    bundled: "同梱版",
    lastCalls: "最終呼び出し",
    noCalls: "呼び出し記録はまだありません",
    disabledCalls: "記録は無効です",
    at: "日時",
    ok: "成功",
    error: "エラー",
  },
};

function formatBoolean(copy: DiagnosticsTextCopy, value: boolean | null): string {
  return value === null ? copy.unknown : value ? copy.yes : copy.no;
}

function formatRegistration(
  copy: DiagnosticsTextCopy,
  label: string,
  status: RegistrationStatus,
): string {
  const state = !status.fileExists
    ? copy.notFound
    : status.hasTokenlighten
      ? copy.registered
      : copy.notRegistered;
  const allowWrite = status.allowWrite === null
    ? ""
    : ` (${copy.allowWrite}: ${formatBoolean(copy, status.allowWrite)})`;
  return `${label}: ${status.path} — ${state}${allowWrite}`;
}

function formatCall(copy: DiagnosticsTextCopy, call: DiagRingCall): string {
  const outcome = call.ok ? copy.ok : `${copy.error}${call.error_code ? ` (${call.error_code})` : ""}`;
  const modeOrKind = [call.mode, call.kind].filter(Boolean).join(" -> ");
  return `  ${call.at} — ${call.tool}${modeOrKind ? ` [${modeOrKind}]` : ""}, ${call.ms}ms, ${outcome}`;
}

/** Plain-text block for the "Copy diagnostics" button — no HTML, safe to paste anywhere. */
export function formatDiagnosticsText(
  snapshot: DiagnosticsSnapshot,
  locale: "en" | "ja" = "en",
): string {
  const copy = TEXT_COPY[locale];
  const lines: string[] = [
    copy.title,
    `${copy.extensionVersion}: ${snapshot.extensionVersion}`,
    `${copy.tlVersion}: ${snapshot.tlVersion ?? copy.unknown}`,
    `${copy.serverBuild}: ${snapshot.ring.serverBuild ?? copy.unknown}`,
    `${copy.nodeExecutable}: ${snapshot.nodeExecutable}`,
    `${copy.serverLaunch}: ${snapshot.serverLaunch.command} ${snapshot.serverLaunch.args.join(" ")}`,
    `${copy.workspaceRoot}: ${snapshot.workspaceRoot}`,
    `${copy.writeEnabled}: ${formatBoolean(copy, snapshot.writeEnabledSetting)}`,
    formatRegistration(copy, ".mcp.json", snapshot.registrations.claudeMcpJson),
    formatRegistration(copy, ".vscode/mcp.json", snapshot.registrations.vscodeMcpJson),
    formatRegistration(copy, ".codex/config.toml", snapshot.registrations.codexConfigToml),
    snapshot.guide.installedVersion === null
      ? `${copy.guideVersion}: ${copy.notInstalled} (${copy.bundled}: ${snapshot.guide.bundledVersion})`
      : `${copy.guideVersion}: ${snapshot.guide.installedVersion} [${snapshot.guide.source}] (${
        snapshot.guide.upToDate ? copy.upToDate : copy.outOfDate
      }, ${copy.bundled}: ${snapshot.guide.bundledVersion})`,
  ];
  if (snapshot.ring.status === "ok" && snapshot.ring.calls.length > 0) {
    lines.push(`${copy.lastCalls}:`);
    for (const call of snapshot.ring.calls) lines.push(formatCall(copy, call));
  } else if (snapshot.ring.status === "disabled") {
    lines.push(`${copy.lastCalls}: ${copy.disabledCalls}`);
  } else {
    lines.push(`${copy.lastCalls}: ${copy.noCalls}`);
  }
  return lines.join("\n");
}
