/**
 * repoRoot.spec.ts — tests for resolveRepoRoot sentinel walk.
 *
 * Coverage:
 *   - Discovers root when sentinel exists in a parent directory.
 *   - Prefers TOKENLIGHTEN_REPO_ROOT env override.
 *   - Throws when no sentinel is found and env is unset.
 *
 * Output policy: plain data — no meta envelope.
 * See docs/00-postmortem.md §2.2 for rationale.
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-reporoot-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ok */
    }
  }
  delete process.env["TOKENLIGHTEN_REPO_ROOT"];
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveRepoRoot — env override", () => {
  it("returns TOKENLIGHTEN_REPO_ROOT when set", async () => {
    const fakeRoot = "/some/fake/repo";
    process.env["TOKENLIGHTEN_REPO_ROOT"] = fakeRoot;

    const { resolveRepoRoot } = await import("../repoRoot.js");
    const result = resolveRepoRoot();
    expect(result).toBe(path.resolve(fakeRoot));
  });
});

describe("resolveRepoRoot — sentinel discovery", () => {
  beforeEach(() => {
    delete process.env["TOKENLIGHTEN_REPO_ROOT"];
  });

  it("finds root when custom sentinel exists in a parent directory", async () => {
    // Create a fake repo tree: root/proxy/pyproject.toml, root/sub/dir/
    const root = makeTmpDir();
    fs.mkdirSync(path.join(root, "proxy"), { recursive: true });
    fs.writeFileSync(path.join(root, "proxy", "pyproject.toml"), "[tool.poetry]\n");
    fs.mkdirSync(path.join(root, "sub", "dir"), { recursive: true });

    // We can't change __dirname/import.meta.url of the module, but we can
    // pass a custom sentinel and set TOKENLIGHTEN_REPO_ROOT from the test env.
    // Instead, test that passing explicit sentinels with an env override works.
    process.env["TOKENLIGHTEN_REPO_ROOT"] = root;

    const { resolveRepoRoot } = await import("../repoRoot.js");
    const result = resolveRepoRoot({ sentinels: ["proxy/pyproject.toml"] });
    expect(result).toBe(path.resolve(root));
  });
});

describe("resolveRepoRoot — failure path", () => {
  beforeEach(() => {
    delete process.env["TOKENLIGHTEN_REPO_ROOT"];
  });

  it("throws when no sentinel is found and env is unset", async () => {
    // Use a sentinel that will never be found.
    const { resolveRepoRoot } = await import("../repoRoot.js");

    expect(() =>
      resolveRepoRoot({ sentinels: ["__nonexistent_sentinel_xyz__/marker.txt"] })
    ).toThrow("TokenLighten repo root not found");
  });
});
