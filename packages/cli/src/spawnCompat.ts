/**
 * spawnCompat.ts — Windows `.cmd`/`.bat` spawn compatibility.
 *
 * Node's `child_process.spawn`/`spawnSync` refuse to exec a Windows batch
 * file directly without `shell:true` (`spawn EINVAL` — Node's 2024 CVE
 * hardening around CVE-2024-27980). This repo never sets `shell:true` with
 * unescaped/user-influenced strings, so every call site that might resolve
 * to a `.cmd`/`.bat` (vendor CLIs like `claude`/`gemini`/`copilot`/`codex`,
 * or a version-manager Python shim such as pyenv-win's `python.bat`) must
 * instead be rerouted through `cmd.exe /d /s /c "<quoted line>"` — but ONLY
 * when the target actually is a batch file; every other command, and every
 * non-Windows platform, passes through unchanged.
 *
 * Output policy: plain data — no meta envelope.
 * See docs/00-postmortem.md §2.2 for rationale.
 */

import { spawnSync } from "node:child_process";

export interface SpawnTarget {
  /** The executable to actually spawn — either the original `command`
   * unchanged, or `cmd.exe` when `command` resolves to a batch file. */
  file: string;
  /** Full argv for `file` (already includes `/d /s /c <line>` when
   * rerouted through cmd.exe). */
  args: string[];
  /** Set to `true` only when rerouted — tells `spawn`/`spawnSync` not to
   * add its own (incompatible) quoting on top of ours. Omitted (not
   * `false`) on the passthrough path, so callers can simply spread this
   * object into their existing options without clobbering anything. */
  windowsVerbatimArguments?: boolean;
}

const BATCH_EXTENSIONS = new Set([".cmd", ".bat"]);

function lastPathSegmentExtension(p: string): string {
  const dot = p.lastIndexOf(".");
  const sep = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (dot <= sep) return "";
  return p.slice(dot).toLowerCase();
}

function isBatchExtension(p: string): boolean {
  return BATCH_EXTENSIONS.has(lastPathSegmentExtension(p));
}

/**
 * Resolve a bare command name (no path separators) the same way Windows
 * would when actually launching it, so we can tell whether the result is a
 * batch file. Returns `null` on any failure (not found, `where` itself
 * unavailable, mocked away in a test, …) — callers fall back to spawning
 * `command` as given, exactly like today, and let the normal ENOENT path
 * report a genuine "not found".
 */
function resolveOnWindowsPath(command: string): string | null {
  try {
    const result = spawnSync("where", [command], {
      shell: false,
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status !== 0 || typeof result.stdout !== "string") return null;
    const first = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return first ?? null;
  } catch {
    return null;
  }
}

/**
 * Escape one token for the standard Windows argv parser (the same
 * backslash/quote rules `node.exe`'s own CRT — and every other normal
 * Windows executable — uses to split its command line back into argv;
 * it is what Node itself applies automatically when
 * `windowsVerbatimArguments` is NOT set, which we replicate by hand here
 * because we need full control of the outer cmd.exe framing too):
 *   - a run of N backslashes immediately before a `"` becomes 2N+1
 *     backslashes followed by an escaped `"`;
 *   - a run of N backslashes at the very end (immediately before the
 *     closing quote we are about to append) becomes 2N backslashes;
 *   - the result is always wrapped in `"…"` (safe even when unnecessary).
 */
function escapeArgvToken(value: string): string {
  let result = "";
  let backslashes = 0;
  for (const ch of value) {
    if (ch === "\\") {
      backslashes += 1;
      continue;
    }
    if (ch === "\"") {
      result += "\\".repeat(backslashes * 2 + 1) + "\"";
      backslashes = 0;
      continue;
    }
    result += "\\".repeat(backslashes) + ch;
    backslashes = 0;
  }
  result += "\\".repeat(backslashes * 2);
  return `"${result}"`;
}

/**
 * Build the single argv element that goes after `cmd.exe /d /s /c`. Each of
 * `command`/`args` is individually quoted (`escapeArgvToken`), then the
 * WHOLE joined line gets one more outer quote pair — that outer pair is
 * what cmd.exe's `/s` strips (see `cmd /?`'s documented quote-handling rule
 * for `/c`: "the first and last quote characters ... are stripped"),
 * leaving the individually-quoted tokens intact for cmd.exe to re-parse.
 *
 * Deliberately NOT caret-escaping `&`/`%`/etc. here: those are already
 * neutralized by each token's OWN quotes (a metacharacter loses its special
 * meaning to cmd.exe while inside a quoted span), both for this first
 * cmd.exe pass and for a `.cmd` target's own `%*`-forwarded re-parse of the
 * same already-quoted text. Caret-escaping content that is already safely
 * quoted would not add protection — cmd.exe does not interpret caret
 * specially inside quotes, so the caret would just become a literal
 * character baked into the value. (An argument that combines an embedded
 * quote directly adjacent to a metacharacter is a narrower, general cmd.exe
 * hazard this does not attempt to solve — see spawnCompat.spec.ts.)
 */
function buildBatchCommandLine(command: string, args: readonly string[]): string {
  const tokens = [command, ...args].map((token) => escapeArgvToken(token));
  return `"${tokens.join(" ")}"`;
}

/**
 * Route a spawn through cmd.exe when (and only when) `command` resolves to
 * a Windows batch file. A no-op passthrough on every other platform, and
 * for any command that is not a `.cmd`/`.bat` file.
 */
export function resolveSpawnTarget(command: string, args: readonly string[]): SpawnTarget {
  const passthrough: SpawnTarget = { file: command, args: [...args] };
  if (process.platform !== "win32") return passthrough;

  const hasPathSeparator = command.includes("/") || command.includes("\\");
  const isBatch = hasPathSeparator
    ? isBatchExtension(command)
    : isBatchExtension(resolveOnWindowsPath(command) ?? "");
  if (!isBatch) return passthrough;

  const comspec = process.env["ComSpec"] ?? process.env["COMSPEC"] ?? "cmd.exe";
  return {
    file: comspec,
    args: ["/d", "/s", "/c", buildBatchCommandLine(command, args)],
    windowsVerbatimArguments: true,
  };
}
