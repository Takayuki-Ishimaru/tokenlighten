import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { buildVerificationManifest, resetVerificationKitDedupeForTest } from "../util/verificationPack.js";
import { TSX_NODE_ARGS } from "./helpers/tsxNode.js";

const roots: string[] = [];
function workspace(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".tl-node-verify-")));
  roots.push(root);
  return root;
}
function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}
afterEach(() => {
  resetVerificationKitDedupeForTest();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function collisionFixture(root: string): void {
  write(root, "package.json", '{"type":"module","scripts":{"test":"node --test"}}');
  write(root, "tools/run.mjs", "export function reportTokens(value) { return value; }\n");
  write(root, "other/run.mjs", "export function reportTokens(value) { return value + 1; }\n");
  write(root, "tools/run.spec.mjs", 'import { reportTokens } from "./run.mjs";\nimport {test} from "node:test";\ntest("direct",()=>reportTokens(2));\n');
  for (let i = 0; i < 8; i++) write(root, `other/test_${i}.spec.mjs`, 'import { reportTokens } from "./run.mjs";\n// value return reportTokens shared\n');
}
describe("Node verification module identity", () => {
  it("keeps the actual importer ahead of eight same-basename decoys", () => {
    const root = workspace(); collisionFixture(root);
    const manifest = buildVerificationManifest(root, ["tools/run.mjs"]);
    expect(manifest?.surfaces.map(surface => surface.path)).toEqual(["tools/run.spec.mjs"]);
    expect(manifest?.surfaces[0]?.references).toEqual(["tools/run.mjs"]);
    expect(manifest?.omitted).toBe(0);
  });
  it.each([
    ["src/index.ts", "tests/index.spec.ts", 'import { value } from "../src/index.js";'],
    ["src/run.mts", "tests/run.spec.mts", 'const { value } = await import("../src/run.mjs");'],
    ["src/run.cts", "tests/run.spec.cts", 'const { value } = require("../src/run.cjs");'],
    ["src/index.js", "tests/index.spec.js", 'import "../src";'],
    ["src/run.mjs", "tests/run.spec.mjs", 'import { value } from "../src/run";'],
  ])("resolves %s through its emitted or extensionless spelling", (source, test, reference) => {
    const root = workspace();
    write(root, source, "export const value = 1;\n");
    write(root, "decoy/" + path.posix.basename(source), "export const value = 2;\n");
    write(root, test, reference + "\n");
    const manifest = buildVerificationManifest(root, [source]);
    expect(manifest?.surfaces.map(surface => surface.path)).toEqual([test]);
  });
  it("keeps a direct side-effect import even without changed-symbol overlap", () => {
    const root = workspace();
    write(root, "src/run.mjs", "export function calculateInvoice(subtotal, taxRate) { return subtotal * taxRate; }\n");
    write(root, "other/run.mjs", "export const unrelated = 1;\n");
    write(root, "tests/direct.spec.mjs", 'import "../src/run.mjs";\n');
    expect(buildVerificationManifest(root, ["src/run.mjs"])?.surfaces.map(s => s.path)).toEqual(["tests/direct.spec.mjs"]);
  });
  it("retains explicit script paths and preserves unique-name heuristic matches", () => {
    const root = workspace(); collisionFixture(root);
    write(root, "tests/driver.spec.mjs", 'const target = "tools/run.mjs"; // reportTokens value\n');
    expect(buildVerificationManifest(root, ["tools/run.mjs"])?.surfaces.map(s => s.path).sort()).toEqual(["tests/driver.spec.mjs", "tools/run.spec.mjs"]);
    write(root, "src/unusualModule.ts", "export function reportTokens(value: number) { return value; }\n");
    write(root, "tests/unique.spec.ts", "// unusualModule reportTokens value\n");
    expect(buildVerificationManifest(root, ["src/unusualModule.ts"])?.surfaces.map(s => s.path)).toContain("tests/unique.spec.ts");
  });
  it("does not turn unrelated imports into a harness when no direct test exists", () => {
    const root = workspace(); collisionFixture(root);
    fs.unlinkSync(path.join(root, "tools/run.spec.mjs"));
    expect(buildVerificationManifest(root, ["tools/run.mjs"])).toBeUndefined();
  });
  it("replays the observed handle edit call with colliding run.mjs test mentions", async () => {
    const root = workspace(); collisionFixture(root);
    const bin = fileURLToPath(new URL("../bin.ts", import.meta.url));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [...TSX_NODE_ARGS, bin, root, "--allow-write"],
      stderr: "pipe",
    });
    const client = new Client({ name: "verification-node-collision", version: "1" }, { versionNegotiation: { mode: "legacy" } });
    const parse = (result: { content: unknown }) => JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    try {
      await client.connect(transport);
      const read = parse(await client.callTool({ name: "tl_read_file", arguments: {
        cwd: root, lane: "node-verify", targets: [{ path: "tools/run.mjs" }], content: "full",
      } }));
      const edit = parse(await client.callTool({ name: "tl_edit_file", arguments: {
        cwd: root, lane: "node-verify", edits: [{
          handle: read.evidence[0].handle, search: "return value;", replace: "return value + 2;",
          precondition: "unique-match", allowPathFallback: false,
        }],
      } }));
      expect(edit.kind).toBe("edit.applied");
      expect(fs.readFileSync(path.join(root, "tools/run.mjs"), "utf8")).toContain("return value + 2;");
      expect(edit.verification?.surfaces.map((surface: { path: string }) => surface.path)).toEqual(["tools/run.spec.mjs"]);
      expect(JSON.stringify(edit.verification)).not.toContain("other/test_");
    } finally {
      await client.close();
    }
  }, 60_000);
});
