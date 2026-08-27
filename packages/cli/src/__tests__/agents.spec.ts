/**
 * agents.spec.ts — tests for `tl agents update` (the bare, non-`--for-target`
 * path in commands/agents.ts).
 *
 * Regression coverage for the defect where this path called a `generate()`
 * export that @tokenlighten/agents-md has never had (it exports `injectAll` /
 * `removeAll` / `injectForTarget`, never `generate` — confirmed all the way
 * back to the commit that introduced this file). Every call used to fail
 * with "has no exported 'generate' function". These tests exercise the real
 * injectAll() wiring end-to-end against a sandbox directory: a --check run
 * that reports drift without writing anything, a real run that writes
 * AGENTS.md + the 5 stub files, an idempotent second run, and the new
 * --root/--locale option plumbing.
 *
 * Uses mkdtemp-style sandbox directories to isolate FS side-effects, and the
 * same process.exit-stub + stdout-capture pattern as install-hooks.spec.ts.
 * No network access required.
 *
 * Output policy: plain data — no meta envelope.
 * See docs/00-postmortem.md §2.2 for rationale.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeSandbox(): string {
  return mkdtempSync(join(tmpdir(), "tl-agents-test-"));
}

// Capture process.stdout.write calls without actually writing
function captureStdout(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    lines.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  return { lines, restore: () => { process.stdout.write = orig; } };
}

// Capture process.stderr.write calls without actually writing
function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    lines.push(chunk);
    return true;
  }) as typeof process.stderr.write;
  return { lines, restore: () => { process.stderr.write = orig; } };
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("tl agents update (bare path -> injectAll)", () => {
  let sandbox: string;
  let origCwd: string;
  let origExit: typeof process.exit;
  let exitCode: number | undefined;

  beforeEach(() => {
    sandbox = makeSandbox();
    origCwd = process.cwd();
    origExit = process.exit;
    exitCode = undefined;
    // Stub process.exit so tests don't terminate the runner
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;
    process.chdir(sandbox);
  });

  afterEach(() => {
    process.exit = origExit;
    process.chdir(origCwd);
    rmSync(sandbox, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("--check reports drift and writes nothing when no AGENTS.md exists yet (dry-run)", async () => {
    const { runAgents } = await import("../commands/agents.js");
    const cap = captureStdout();
    try {
      await runAgents(["update", "--check"]);
    } catch {
      /* swallow process.exit stub throw */
    } finally {
      cap.restore();
    }

    // A missing generated file under fail-build drift mode is reported as
    // drift, never written (injectAll.ts processFile: "A check is
    // observational: missing generated files are drift, never writes.").
    expect(existsSync(join(sandbox, "AGENTS.md"))).toBe(false);
    expect(cap.lines.join("")).not.toContain("wrote");
    expect(cap.lines.join("")).toContain("drifted");
    expect(exitCode).toBe(1);
  });

  it("real run writes AGENTS.md + the 5 stub files through the real injectAll API", async () => {
    const { runAgents } = await import("../commands/agents.js");
    const cap = captureStdout();
    try {
      await runAgents(["update"]);
    } catch {
      /* should not throw -- the success path never calls process.exit */
    } finally {
      cap.restore();
    }

    expect(exitCode).toBeUndefined();

    const expectedFiles = [
      "AGENTS.md",
      "CLAUDE.md",
      ".github/copilot-instructions.md",
      ".cursor/rules/tokenlighten.mdc",
      ".clinerules/tokenlighten.md",
      ".continue/rules/tokenlighten.md",
    ];
    for (const f of expectedFiles) {
      expect(existsSync(join(sandbox, f))).toBe(true);
    }

    const agentsMd = readFileSync(join(sandbox, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("tokenlighten:mcp-instructions:start");

    const out = cap.lines.join("");
    expect(out).toContain("wrote  AGENTS.md");
    expect(out).toContain("wrote  CLAUDE.md");
  });

  it("second run is idempotent -- no rewrite, no drift, no exit code set", async () => {
    const { runAgents } = await import("../commands/agents.js");

    let cap = captureStdout();
    try {
      await runAgents(["update"]);
    } finally {
      cap.restore();
    }
    expect(exitCode).toBeUndefined();

    cap = captureStdout();
    try {
      await runAgents(["update"]);
    } finally {
      cap.restore();
    }

    const out = cap.lines.join("");
    expect(out).not.toContain("wrote");
    expect(out).not.toContain("drifted");
    expect(out).toContain("skipped 6 file(s)");
    expect(exitCode).toBeUndefined();
  });

  it("--targets limits injection to the requested stub(s)", async () => {
    const { runAgents } = await import("../commands/agents.js");
    const cap = captureStdout();
    try {
      await runAgents(["update", "--targets", "claude"]);
    } finally {
      cap.restore();
    }

    expect(existsSync(join(sandbox, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(sandbox, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(sandbox, ".github", "copilot-instructions.md"))).toBe(false);
  });

  it("--root targets a directory other than cwd", async () => {
    const other = makeSandbox();
    process.chdir(origCwd); // leave the default sandbox to prove --root, not cwd, wins
    try {
      const { runAgents } = await import("../commands/agents.js");
      const cap = captureStdout();
      try {
        await runAgents(["update", "--root", other, "--targets", "claude"]);
      } finally {
        cap.restore();
      }
      expect(existsSync(join(other, "AGENTS.md"))).toBe(true);
      expect(existsSync(join(sandbox, "AGENTS.md"))).toBe(false);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("--locale jp renders the Japanese template", async () => {
    const { runAgents } = await import("../commands/agents.js");
    const cap = captureStdout();
    try {
      await runAgents(["update", "--locale", "jp", "--targets", "claude"]);
    } finally {
      cap.restore();
    }
    expect(exitCode).toBeUndefined();
    expect(existsSync(join(sandbox, "AGENTS.md"))).toBe(true);
  });

  it("--profile medium injects the medium managed block and --profile full restores it", async () => {
    const { runAgents } = await import("../commands/agents.js");
    let cap = captureStdout();
    try {
      await runAgents(["update", "--profile", "medium", "--targets", "claude"]);
    } finally {
      cap.restore();
    }
    const medium = readFileSync(join(sandbox, "AGENTS.md"), "utf8");
    expect(medium).toContain("TokenLighten MCP (medium)");

    cap = captureStdout();
    try {
      await runAgents(["update", "--profile", "full", "--targets", "claude"]);
    } finally {
      cap.restore();
    }
    const full = readFileSync(join(sandbox, "AGENTS.md"), "utf8");
    expect(full).not.toContain("TokenLighten MCP (medium)");
    expect(full).toContain("TokenLighten (TL) returns exact slices");
  });

  it("--profile compact is accepted (widened alongside agents-md's compact GuideProfile)", async () => {
    const { runAgents } = await import("../commands/agents.js");
    const cap = captureStdout();
    try {
      await runAgents(["update", "--profile", "compact", "--targets", "claude"]);
    } finally {
      cap.restore();
    }
    // Ownership boundary: agents.ts's own --profile parser accepting "compact"
    // and forwarding it to injectAll is what this fix covers; the resulting
    // template content is @tokenlighten/agents-md's (sibling-owned) concern.
    expect(exitCode).toBeUndefined();
    expect(existsSync(join(sandbox, "AGENTS.md"))).toBe(true);
  });

  it("rejects an unknown --profile value, listing all three valid options", async () => {
    const { runAgents } = await import("../commands/agents.js");
    const stderr = captureStderr();
    try {
      await runAgents(["update", "--profile", "bogus"]);
    } catch {
      /* swallow process.exit stub throw */
    } finally {
      stderr.restore();
    }
    expect(exitCode).toBe(1);
    expect(existsSync(join(sandbox, "AGENTS.md"))).toBe(false);
    const message = stderr.lines.join("");
    expect(message).toContain('"full"');
    expect(message).toContain('"medium"');
    expect(message).toContain('"compact"');
  });

  it("rejects an unknown --locale value", async () => {
    const { runAgents } = await import("../commands/agents.js");
    const cap = captureStdout();
    try {
      await runAgents(["update", "--locale", "fr"]);
    } catch {
      /* swallow process.exit stub throw */
    } finally {
      cap.restore();
    }
    expect(exitCode).toBe(1);
    expect(existsSync(join(sandbox, "AGENTS.md"))).toBe(false);
  });
});
