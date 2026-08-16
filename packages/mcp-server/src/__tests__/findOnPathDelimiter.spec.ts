// findOnPathDelimiter.spec.ts — util/verificationPack.ts's private findOnPath
// used to split process.env.PATH on a hardcoded ":" . That is wrong on win32,
// where the PATH delimiter is ";" (and where each entry can itself contain a
// ":" from a drive letter, e.g. "C:\\tools"): a hardcoded ":" split silently
// fails to separate PATH entries, so no compiler/python3 is ever found.
//
// This spec mocks node:path's `delimiter` to ";" (its real win32 value) so
// the assertion is meaningful on every CI platform, not just Windows — the
// fix is exercised through the exported `probeToolchain`, whose default
// lookup (`pathLookupOverride ?? findOnPath`) reaches the real, private
// findOnPath whenever no override is installed.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return { ...actual, delimiter: ";" };
});

const { probeToolchain, setToolchainPathLookupForTest } = await import("../util/verificationPack.js");

describe("findOnPath splits PATH on the platform delimiter, not a hardcoded \":\"", () => {
  const originalPath = process.env["PATH"];
  const dirs: string[] = [];

  function mkBinDir(tag: string, binName: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tl-findonpath-${tag}-`));
    fs.writeFileSync(path.join(dir, binName), "");
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    setToolchainPathLookupForTest(undefined); // never leak the override into other specs
    if (originalPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = originalPath;
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds a candidate in the second entry of a \";\"-joined (win32-style) PATH", () => {
    setToolchainPathLookupForTest(undefined); // ensure the real findOnPath runs, no test override
    const empty = mkBinDir("empty", "unrelated-tool");
    const withCxx = mkBinDir("cxx", "g++");
    // Neither temp dir contains a literal ":", so a hardcoded `.split(":")`
    // would see this whole string as ONE bogus directory name and never find
    // "g++"; splitting on path.delimiter (mocked to ";" above, exactly like
    // win32) correctly yields [empty, withCxx].
    process.env["PATH"] = `${empty};${withCxx}`;

    const probe = probeToolchain();

    expect(probe.cxx).toBe("g++");
  });

  it("negative control: without delimiter-aware splitting the same PATH would not resolve", () => {
    // Documents the bug this spec guards against: joining the same two dirs
    // with the delimiter and splitting on a hardcoded ":" (the pre-fix
    // behavior) never separates them, so nothing on the second dir is ever
    // reachable — reproduced directly here (not through product code) so the
    // failure mode stays visible even if findOnPath's internals change.
    const empty = mkBinDir("empty2", "unrelated-tool");
    const withCxx = mkBinDir("cxx2", "g++");
    const joined = `${empty};${withCxx}`;

    const legacySplit = joined.split(":");

    expect(legacySplit).toEqual([joined]); // never separated into two entries
  });
});
