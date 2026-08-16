/**
 * install-hooks.spec.ts — unit tests for `tl install-hooks`.
 *
 * Uses mkdtemp-style sandbox directories to isolate FS side-effects.
 * No network access required.
 *
 * Output policy: plain data — no meta envelope.
 * See docs/00-postmortem.md §2.2 for rationale.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeSandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "tl-install-hooks-test-"));
  // Simulate a minimal git repo structure
  mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
  return dir;
}

function readHook(dir: string, rel: string): string {
  return readFileSync(join(dir, rel), "utf-8");
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

// ─── tests ────────────────────────────────────────────────────────────────────

describe("install-hooks — husky mode", () => {
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
    // Create .husky directory
    mkdirSync(join(sandbox, ".husky"), { recursive: true });
    process.chdir(sandbox);
  });

  afterEach(() => {
    process.exit = origExit;
    process.chdir(origCwd);
    rmSync(sandbox, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("creates .husky/pre-commit and appends tl skeleton check when file is absent", async () => {
    const { runInstallHooks } = await import("../commands/install-hooks.js");
    const cap = captureStdout();
    try {
      await runInstallHooks([]);
    } catch {
      /* swallow process.exit stub throw */
    } finally {
      cap.restore();
    }

    const hookPath = join(sandbox, ".husky", "pre-commit");
    expect(existsSync(hookPath)).toBe(true);
    const content = readHook(sandbox, ".husky/pre-commit");
    expect(content).toContain("tl skeleton check");
    expect(exitCode).toBe(0);
  });

  it("does not duplicate the line when hook already contains it", async () => {
    const hookPath = join(sandbox, ".husky", "pre-commit");
    writeFileSync(hookPath, "#!/bin/sh\ntl skeleton check\n", { mode: 0o755 });

    const { runInstallHooks } = await import("../commands/install-hooks.js");
    const cap = captureStdout();
    try {
      await runInstallHooks([]);
    } catch {
      /* swallow */
    } finally {
      cap.restore();
    }

    const content = readHook(sandbox, ".husky/pre-commit");
    const occurrences = content.split("tl skeleton check").length - 1;
    expect(occurrences).toBe(1);
    expect(cap.lines.join("")).toContain("nothing to do");
  });
});

describe("install-hooks — plain mode (.git/hooks)", () => {
  let sandbox: string;
  let origCwd: string;
  let origExit: typeof process.exit;
  let exitCode: number | undefined;

  beforeEach(() => {
    sandbox = makeSandbox();
    origCwd = process.cwd();
    origExit = process.exit;
    exitCode = undefined;
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;
    // No .husky or lefthook.yml — plain mode
    process.chdir(sandbox);
  });

  afterEach(() => {
    process.exit = origExit;
    process.chdir(origCwd);
    rmSync(sandbox, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("creates .git/hooks/pre-commit with shebang and tl skeleton check", async () => {
    vi.resetModules();
    const { runInstallHooks } = await import("../commands/install-hooks.js");
    const cap = captureStdout();
    try {
      await runInstallHooks([]);
    } catch {
      /* swallow */
    } finally {
      cap.restore();
    }

    const hookPath = join(sandbox, ".git", "hooks", "pre-commit");
    expect(existsSync(hookPath)).toBe(true);
    const content = readHook(sandbox, ".git/hooks/pre-commit");
    expect(content).toContain("#!/");
    expect(content).toContain("tl skeleton check");
    expect(exitCode).toBe(0);
  });

  it("--uninstall removes tl skeleton check from existing hook", async () => {
    const hookPath = join(sandbox, ".git", "hooks", "pre-commit");
    writeFileSync(hookPath, "#!/bin/sh\ntl skeleton check\n", { mode: 0o755 });

    vi.resetModules();
    const { runInstallHooks } = await import("../commands/install-hooks.js");
    const cap = captureStdout();
    try {
      await runInstallHooks(["--uninstall"]);
    } catch {
      /* swallow */
    } finally {
      cap.restore();
    }

    const content = readHook(sandbox, ".git/hooks/pre-commit");
    expect(content).not.toContain("tl skeleton check");
    // Shebang should remain
    expect(content).toContain("#!/bin/sh");
    expect(exitCode).toBe(0);
  });
});

describe("install-hooks — lefthook mode", () => {
  let sandbox: string;
  let origCwd: string;
  let origExit: typeof process.exit;
  let exitCode: number | undefined;

  beforeEach(() => {
    sandbox = makeSandbox();
    origCwd = process.cwd();
    origExit = process.exit;
    exitCode = undefined;
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;
    // Create lefthook.yml
    writeFileSync(join(sandbox, "lefthook.yml"), "pre-commit:\n  commands: {}\n");
    process.chdir(sandbox);
  });

  afterEach(() => {
    process.exit = origExit;
    process.chdir(origCwd);
    rmSync(sandbox, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("prints a one-liner instruction and does NOT mutate lefthook.yml", async () => {
    vi.resetModules();
    const { runInstallHooks } = await import("../commands/install-hooks.js");
    const cap = captureStdout();
    try {
      await runInstallHooks([]);
    } catch {
      /* swallow */
    } finally {
      cap.restore();
    }

    // Output should mention lefthook
    const out = cap.lines.join("");
    expect(out).toContain("lefthook");
    expect(out).toContain("tl skeleton check");

    // lefthook.yml must be untouched
    const yml = readFileSync(join(sandbox, "lefthook.yml"), "utf-8");
    expect(yml).toBe("pre-commit:\n  commands: {}\n");

    expect(exitCode).toBe(0);
  });
});
