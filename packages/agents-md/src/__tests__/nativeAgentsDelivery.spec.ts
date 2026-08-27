import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { injectAll } from "../injectAll.js";
import { renderCanonicalBlock } from "../render.js";

const repos: string[] = [];

function makeTempRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "tl-agents-natural-delivery-"));
  repos.push(repo);
  return repo;
}

afterEach(() => {
  for (const repo of repos.splice(0)) {
    rmSync(repo, { recursive: true, force: true });
  }
});

describe("native AGENTS.md delivery", () => {
  it("writes the full canonical guide to the autoloaded primary file without stubs", async () => {
    const repo = makeTempRepo();

    const result = await injectAll({
      repoRoot: repo,
      driftMode: "auto-rewrite",
      targets: [],
    });

    expect(result.wrote).toEqual(["AGENTS.md"]);
    expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).toBe(renderCanonicalBlock());
  });
});
