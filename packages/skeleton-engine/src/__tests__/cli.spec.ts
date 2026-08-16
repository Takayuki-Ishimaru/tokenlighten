import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../index.js", () => ({
  buildSkeleton: vi.fn(async () => ({
    skeleton: { topRanked: [] },
    markdown: "# generated skeleton\n",
    warnings: ["degenerate graph"],
  })),
  renderCompactSkeleton: vi.fn(() => "# compact skeleton\n"),
}));

import { main } from "../cli.js";

const workspaces: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(workspaces.splice(0).map((workspace) => rm(workspace, { recursive: true, force: true })));
});

describe("tl-skeleton --quiet", () => {
  it("suppresses progress and build warnings for the real CLI argument shape", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tl-skeleton-cli-"));
    workspaces.push(workspace);
    const output = join(workspace, "skeleton.md");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await main([
      "node",
      "tl-skeleton",
      "build",
      "--root",
      workspace,
      "--output",
      output,
      "--quiet",
      "--no-cache",
    ]);

    expect(stderr).not.toHaveBeenCalled();
    await expect(readFile(output, "utf8")).resolves.toBe("# generated skeleton\n");
  });
});
