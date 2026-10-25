import { afterEach, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import Ajv, { type AnySchema } from "ajv";
import { TSX_NODE_ARGS } from "./helpers/tsxNode.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
it("portable real stdio serves source, applies a gated handle edit and safely replays its operation", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".tl-portable-write-"))); roots.push(root);
  fs.writeFileSync(path.join(root, "limit.mjs"), "export const TOKEN_LIMIT = 10;\n");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...TSX_NODE_ARGS, fileURLToPath(new URL("../bin.ts", import.meta.url)), root, "--allow-write"],
    env: { TL_PORTABLE_TOOLS: "1", TL_TURN_ECONOMY: "0", TL_LEGACY_INPUT: "refuse" }, stderr: "pipe",
  });
  const client = new Client({ name: "unknown-portable-host", version: "1" }, { versionNegotiation: { mode: "legacy" } });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(3);
    const ajv = new Ajv({ coerceTypes: true });
    const validators = new Map(listed.tools.map(t => [t.name, ajv.compile(t.inputSchema as AnySchema)]));
    async function call(name: string, args: Record<string, unknown>) {
      const validate = validators.get(name)!;
      expect(validate(args), JSON.stringify(validate.errors)).toBe(true);
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    }
    const read = await call("tl_read_file", { cwd: root, lane: "portable-write", targets: [{ path: "limit.mjs" }], content: "full" });
    const args = { cwd: root, lane: "portable-write", operation_id: "portable-handle-edit-1", edits: [{
      handle: read.evidence[0].handle, search: "TOKEN_LIMIT = 10", replace: "TOKEN_LIMIT = 20",
      precondition: "unique-match", allowPathFallback: false,
    }] };
    const applied = await call("tl_edit_file", args);
    expect(applied.kind).toBe("edit.applied");
    expect(fs.readFileSync(path.join(root, "limit.mjs"), "utf8")).toBe("export const TOKEN_LIMIT = 20;\n");
    const replay = await call("tl_edit_file", args);
    expect(replay.kind).toBe("edit.applied");
    expect(fs.readFileSync(path.join(root, "limit.mjs"), "utf8")).toBe("export const TOKEN_LIMIT = 20;\n");
    const checkNext = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      if (typeof record["tool"] === "string" && record["arguments"] !== undefined) {
        const validate = validators.get(record["tool"]);
        if (validate) expect(validate(record["arguments"]), JSON.stringify(validate.errors)).toBe(true);
      }
      for (const child of Object.values(record)) checkNext(child);
    };
    checkNext(applied); checkNext(replay);
  } finally { await client.close(); }
}, 60000);
