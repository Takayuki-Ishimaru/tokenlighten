import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { attachSearchHop1 } from "../util/searchHopClosure.js";

const workspaces: string[] = [];

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tl-hop1-"));
  workspaces.push(root);
  return root;
}

beforeEach(() => {
  process.env["TL_HOP1_CLOSURE"] = "1";
});

afterEach(() => {
  delete process.env["TL_HOP1_CLOSURE"];
  for (const root of workspaces.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("search hop-1 closure", () => {
  it("attaches bounded definition and call-site bodies with edit handles", () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, "a.ts"), [
      "export function target(value: number) {",
      "  return value + 1;",
      "}",
      "",
      "export function caller() {",
      "  return target(1);",
      "}",
      "",
    ].join("\n"));
    const result = attachSearchHop1({
      files: [{ path: "a.ts", lines: [1, 6], in_comment: [false, false] }],
    }, root, "target", "references");

    expect(result["hop1"]).toEqual([
      expect.objectContaining({
        path: "a.ts",
        line: 1,
        relation: "definition",
        handle: expect.stringMatching(/^h[0-9a-z]+$/),
        code: expect.stringContaining("target"),
      }),
    ]);
    expect(Buffer.byteLength(JSON.stringify(result["hop1"]), "utf8")).toBeLessThanOrEqual(6 * 1024);
  });

  it("is independently disabled for ablation", () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, "a.ts"), "target();\n");
    process.env["TL_HOP1_CLOSURE"] = "0";
    const response = { files: [{ path: "a.ts", lines: [1], in_comment: [false] }] };
    expect(attachSearchHop1(response, root, "target", "references")).toEqual(response);
  });
});
