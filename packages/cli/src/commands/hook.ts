/**
 * tl hook <event> [--client claude-code|codex|copilot] — the process an
 * agent host runs on its hook events (2026-11-03). Reads the host's JSON on
 * stdin, hands it to the matching adapter (hookAdapters.ts) and prints the
 * adapter's reply, if any. Always exits 0: a hook failure would deny the
 * agent's command on Copilot and be logged as an error elsewhere, for a
 * command TokenLighten was only going to shorten. Claude Code and Copilot
 * are served by `post-tool-use` (output compression after the run);
 * `pre-tool-use` prints nothing (2026-11-03), so a hook file from an earlier
 * install can never deny, prompt or rewrite.
 *
 * Output policy: plain data — exactly the host's documented reply shape.
 */

import { readFileSync } from "node:fs";
import { HOOK_CLIENTS, HOOK_EVENTS, handleHookEvent, isHookEvent, normalizeHookClient } from "../hookAdapters.js";
import { DEFAULT_RUN_OUTPUT_LIMIT_BYTES } from "../runOutput.js";
import { wantsHelp } from "../util/helpFlag.js";

const HOOK_USAGE = `\
Usage: tl hook <event> [--client claude-code|codex|copilot]

Events: ${HOOK_EVENTS.join(", ")}
Reads the host's hook JSON on stdin and prints the host's reply on stdout:
  post-tool-use   After a recognised test/build command ran exactly as the
                  agent wrote it, an output over the ${DEFAULT_RUN_OUTPUT_LIMIT_BYTES}-byte budget is saved
                  to .tokenlighten/.runtime/run/ and replaced, for the model
                  only, by the 'tl run' compression (failure lines, summary,
                  the full-log path). Permissions and prompts are untouched.
                  Claude Code (Bash): hookSpecificOutput.updatedToolOutput; a
                  command that exits non-zero reaches its PostToolUseFailure
                  instead, which cannot replace output, so a failing run is
                  shown whole. Copilot (bash, powershell, VS Code
                  run_in_terminal): modifiedResult; a non-zero exit arrives as
                  a successful result, so failing runs are compressed too and
                  the exit-code line stays. Codex: nothing
  pre-tool-use    Prints nothing for every client (no command is rewritten)
  pre-compact, post-compact, session-start (source clear|compact|new)
                  write the compaction marker .tokenlighten/.runtime/compaction-epoch.json
                  so the MCP server stops treating served content as held
Without --client the payload shape selects the adapter. Always exits 0.
Environment: TL_HOOK_DEBUG=1 reports on stderr why nothing was done.
`;

/** All of stdin, or "" on a TTY / after `timeoutMs` without EOF. */
export function readStdin(timeoutMs = 3000): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("");
  try {
    return Promise.resolve(readFileSync(0, "utf8"));
  } catch {
    // A non-blocking pipe (EAGAIN) or a closed descriptor: fall back to the stream.
  }
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = [];
    const finish = (): void => { clearTimeout(timer); resolvePromise(Buffer.concat(chunks).toString("utf8")); };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

export async function runHook(args: string[]): Promise<void> {
  if (args.length === 0 || wantsHelp(args)) {
    process.stdout.write(HOOK_USAGE);
    return;
  }
  const [event, ...rest] = args;
  let client: ReturnType<typeof normalizeHookClient>;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--client") {
      const value = rest[++i];
      client = value !== undefined ? normalizeHookClient(value) : undefined;
      if (client === undefined) {
        process.stderr.write(`tl hook: unknown --client ${value ?? "(none)"} (expected ${HOOK_CLIENTS.join(" | ")})\n`);
        return;
      }
    }
  }
  if (event === undefined || !isHookEvent(event)) {
    process.stderr.write(`tl hook: unknown event ${event ?? "(none)"} (expected ${HOOK_EVENTS.join(" | ")})\n`);
    return;
  }
  try {
    const payload = await readStdin();
    const result = handleHookEvent(event, client, payload);
    if (result.stdout !== "") process.stdout.write(result.stdout);
    if (process.env["TL_HOOK_DEBUG"] && result.action === "none") process.stderr.write(`tl hook: ${result.detail ?? "nothing to do"}\n`);
  } catch (error) {
    if (process.env["TL_HOOK_DEBUG"]) process.stderr.write(`tl hook: ${String((error as Error).message ?? error)}\n`);
  }
  process.exitCode = 0;
}
