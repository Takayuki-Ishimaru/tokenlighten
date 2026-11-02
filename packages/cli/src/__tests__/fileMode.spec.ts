import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readConfig, writeConfig } from "../config.js";
import { writeJsonAtomic } from "../commands/workspace.js";
import { createDirectoryMode, createFileMode, existingFileMode, keepExistingFileMode } from "../fileMode.js";

// Shared project files use the process default mode; per-user state and files
// that can hold secrets stay owner-only. POSIX modes are not meaningful on
// Windows, where only the content assertions run.
const posixOnly = process.platform === "win32";
const mode = (path: string): number => statSync(path).mode & 0o777;

describe("fileMode policy", () => {
  it("shared files take the process default (0666 before the umask), private ones 0600/0700", () => {
    expect(createFileMode("shared")).toBe(0o666);
    expect(createDirectoryMode("shared")).toBe(0o777);
    expect(createFileMode("private")).toBe(0o600);
    expect(createDirectoryMode("private")).toBe(0o700);
  });

  it("existingFileMode is undefined for a missing path or a directory, and never throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "tl-filemode-"));
    try {
      expect(existingFileMode(join(dir, "missing"))).toBeUndefined();
      expect(existingFileMode(dir)).toBeUndefined();
      keepExistingFileMode(join(dir, "also-missing"), 0o644); // chmod failure is swallowed
      keepExistingFileMode(join(dir, "also-missing"), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("writeJsonAtomic / writeConfig modes", () => {
  let dir: string;
  let previousUmask = 0;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tl-filemode-write-"));
    if (!posixOnly) return;
    previousUmask = process.umask(0o022);
  });
  afterEach(() => {
    if (posixOnly) process.umask(previousUmask);
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the same JSON whichever visibility is requested", () => {
    writeJsonAtomic(dir, join(dir, "shared.json"), { a: 1 }, { visibility: "shared" });
    writeJsonAtomic(dir, join(dir, "private.json"), { a: 1 });
    expect(readFileSync(join(dir, "shared.json"), "utf8")).toBe(readFileSync(join(dir, "private.json"), "utf8"));
    expect(readFileSync(join(dir, "shared.json"), "utf8")).toBe('{\n  "a": 1\n}\n');
  });

  it.skipIf(posixOnly)("shared is 0644 in a 0755 directory; private (the default, as for ~/.claude.json) is 0600 in a 0700 directory", () => {
    writeJsonAtomic(dir, join(dir, "s", "shared.json"), { a: 1 }, { visibility: "shared" });
    writeJsonAtomic(dir, join(dir, "p", "private.json"), { a: 1 });
    expect(mode(join(dir, "s", "shared.json"))).toBe(0o644);
    expect(mode(join(dir, "s"))).toBe(0o755);
    expect(mode(join(dir, "p", "private.json"))).toBe(0o600);
    expect(mode(join(dir, "p"))).toBe(0o700);
  });

  it.skipIf(posixOnly)("an existing file keeps its mode whichever visibility rewrites it", () => {
    const wide = join(dir, "wide.json");
    const narrow = join(dir, "narrow.json");
    writeFileSync(wide, "{}");
    writeFileSync(narrow, "{}");
    chmodSync(wide, 0o664);
    chmodSync(narrow, 0o600);

    writeJsonAtomic(dir, wide, { a: 1 }); // private default must not narrow the user's file
    writeJsonAtomic(dir, narrow, { a: 1 }, { visibility: "shared" }); // shared must not widen a locked-down one

    expect(mode(wide)).toBe(0o664);
    expect(mode(narrow)).toBe(0o600);
    expect(existsSync(`${wide}.tmp`)).toBe(false);
  });

  it.skipIf(posixOnly)("writeConfig: private by default (registry), shared on request (.codex/config.toml), existing mode kept", () => {
    writeConfig(join(dir, "cfg", "registry.toml"), { version: 1 });
    writeConfig(join(dir, "proj", ".codex", "config.toml"), { version: 1 }, "shared");
    expect(mode(join(dir, "cfg", "registry.toml"))).toBe(0o600);
    expect(mode(join(dir, "cfg"))).toBe(0o700);
    expect(mode(join(dir, "proj", ".codex", "config.toml"))).toBe(0o644);
    expect(mode(join(dir, "proj", ".codex"))).toBe(0o755);

    const existing = join(dir, "existing.toml");
    mkdirSync(dir, { recursive: true });
    writeFileSync(existing, "version = 1\n");
    chmodSync(existing, 0o640);
    writeConfig(existing, { version: 2 }, "shared");
    expect(mode(existing)).toBe(0o640);
    expect(readConfig(existing)).toEqual({ version: 2 });
  });
});
