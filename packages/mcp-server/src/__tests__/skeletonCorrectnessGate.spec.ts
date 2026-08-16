// P1.3 Skeleton Correctness Gate — MCP acceptance smoke test
//
// Verifies that after renaming a function in a source file,
// getFileSkeleton returns the new name and NOT the old name.
//
// This is a rename-visibility case: findAll → query rename must be visible in skeleton output.

import { describe, it, expect } from "vitest";
import { getFileSkeleton } from "../tools/getFileSkeleton.js";

describe("skeletonCorrectnessGate — rename smoke test", () => {
  it("skeleton reflects renamed symbol: query present, findAll absent", async () => {
    // Simulate the file content AFTER renaming findAll → query.
    const updatedContent = [
      "import type { Issue } from './types';",
      "",
      "export class IssueRepository {",
      "  private items: Issue[] = [];",
      "",
      "  async query(): Promise<Issue[]> {",
      "    return [...this.items];",
      "  }",
      "",
      "  async save(issue: Issue): Promise<void> {",
      "    this.items.push(issue);",
      "  }",
      "}",
    ].join("\n");

    const result = await getFileSkeleton(updatedContent, {
      path: "src/issueRepository.ts",
      profile: "class-map",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const sigs = result.data.signatures;

    // Renamed symbol must be present.
    expect(sigs).toContain("query");

    // Old symbol must NOT be present (stale cache check).
    // Note: "findAll" should not appear anywhere in the skeleton output.
    expect(sigs).not.toContain("findAll");
  });

  it("skeleton correctly reflects the original symbol before rename", async () => {
    // Sanity check: original content has findAll, not query.
    const originalContent = [
      "import type { Issue } from './types';",
      "",
      "export class IssueRepository {",
      "  private items: Issue[] = [];",
      "",
      "  async findAll(): Promise<Issue[]> {",
      "    return [...this.items];",
      "  }",
      "",
      "  async save(issue: Issue): Promise<void> {",
      "    this.items.push(issue);",
      "  }",
      "}",
    ].join("\n");

    const result = await getFileSkeleton(originalContent, {
      path: "src/issueRepository.ts",
      profile: "class-map",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const sigs = result.data.signatures;

    // Original symbol present.
    expect(sigs).toContain("findAll");

    // New name not yet present.
    expect(sigs).not.toContain("query");
  });
});
