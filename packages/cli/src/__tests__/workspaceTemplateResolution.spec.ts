import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { setupWorkspace } from "../commands/workspace.js";

describe("unbundled workspace setup template resolution", () => {
  it("renders both rule files from the workspace agents-md package", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "tl-unbundled-setup-"));
    const workspace = join(sandbox, "workspace");
    mkdirSync(workspace);
    try {
      const result = await setupWorkspace({
        root: workspace,
        rulesOnly: true,
      });

      expect(result.rulesWritten.length).toBeGreaterThan(0);
      for (const relativePath of [
        "AGENTS.md",
        join(".github", "copilot-instructions.md"),
      ]) {
        const target = join(workspace, relativePath);
        expect(existsSync(target), relativePath).toBe(true);
        expect(
          readFileSync(target, "utf8").length,
          relativePath,
        ).toBeGreaterThan(0);
      }
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
