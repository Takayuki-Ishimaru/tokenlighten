/**
 * devServerTsconfigPin.spec.ts — a dev server spawned through TSX_NODE_ARGS
 * compiles and resolves its source the same way whatever its cwd.
 *
 * Regression (2026-10-20): with vitest started from packages/mcp-server, every
 * spec that spawned a stdio server without a cwd of its own (portableWrite,
 * verificationNodeCollision, ...) failed with "SdkError: Connection closed".
 * The server inherited that cwd, tsx picked up packages/mcp-server/tsconfig.json
 * and followed its type-checking map of `@tokenlighten/usage` to
 * ../usage/dist/index.d.ts, which it loads as an empty module, so the server
 * died on src/protocol/codec/pipeline.ts's import of estimateTokensFromBytes.
 * From the repository root the same specs passed. helpers/tsxNode.ts now pins
 * tsx to helpers/devServer.tsconfig.json (its header has the details).
 */
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { DEV_SERVER_TSCONFIG, TSX_NODE_ARGS } from "./helpers/tsxNode.js";

const PACKAGE_DIR = fileURLToPath(new URL("../..", import.meta.url));
const BIN_TS = fileURLToPath(new URL("../bin.ts", import.meta.url));

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function tempDir(prefix: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), prefix)));
  roots.push(root);
  return root;
}

/** Starts a dev server in `cwd` the way specs do and reads one file through it. */
async function readThroughServer(cwd: string): Promise<{ kind: string; body: string }> {
  const workspace = tempDir(".tl-tsconfig-pin-ws-");
  fs.writeFileSync(path.join(workspace, "limit.mjs"), "export const TOKEN_LIMIT = 10;\n");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...TSX_NODE_ARGS, BIN_TS, workspace],
    cwd,
    env: { TL_LEGACY_INPUT: "refuse" },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => { stderr += String(chunk); });
  const client = new Client({ name: "tsconfig-pin", version: "1" }, { versionNegotiation: { mode: "legacy" } });
  try {
    try {
      await client.connect(transport);
    } catch (error) {
      throw new Error(`dev server in ${cwd} did not start: ${String(error)}\n${stderr.slice(0, 2000)}`);
    }
    const result = await client.callTool({ name: "tl_read_file", arguments: {
      cwd: workspace, lane: "tsconfig-pin", targets: [{ path: "limit.mjs" }], content: "full",
    } });
    const reply = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as { kind: string; evidence?: Array<{ body?: string }> };
    return { kind: reply.kind, body: reply.evidence?.[0]?.body ?? "" };
  } finally {
    await client.close();
  }
}

describe("spawned dev servers ignore the tsconfig of their cwd", () => {
  it("serves a read from packages/mcp-server, whose tsconfig maps @tokenlighten/usage to its declaration file", async () => {
    // The precondition that made this cwd fail: the package's build config maps
    // the workspace package to a .d.ts for tsc.
    const packageConfig = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, "tsconfig.json"), "utf8"));
    expect(packageConfig.compilerOptions.paths["@tokenlighten/usage"]).toEqual(["../usage/dist/index.d.ts"]);
    const read = await readThroughServer(PACKAGE_DIR);
    expect(read.kind).toBe("read.text");
    expect(read.body).toContain("TOKEN_LIMIT = 10");
  }, 60_000);

  it("serves a read from a directory whose own tsconfig.json maps @tokenlighten/usage to a declaration stub", async () => {
    const cwd = tempDir(".tl-tsconfig-pin-cwd-");
    fs.writeFileSync(path.join(cwd, "usage.d.ts"), "export declare function estimateTokensFromBytes(bytes: number): number;\n");
    fs.writeFileSync(path.join(cwd, "tsconfig.json"), JSON.stringify({
      compilerOptions: { paths: { "@tokenlighten/usage": ["./usage.d.ts"], "@tokenlighten/types": ["./usage.d.ts"] } },
    }));
    const read = await readThroughServer(cwd);
    expect(read.kind).toBe("read.text");
    expect(read.body).toContain("TOKEN_LIMIT = 10");
  }, 60_000);

  it("the pin is the first preload of the shared vector and names the package config without paths", () => {
    const pin = TSX_NODE_ARGS.indexOf(fileURLToPath(new URL("./helpers/pinTsxTsconfig.cjs", import.meta.url)));
    const tsxPreflight = TSX_NODE_ARGS.findIndex(arg => /[\\/]tsx[\\/]dist[\\/]preflight\.cjs$/.test(arg));
    expect(pin).toBe(1);
    expect(TSX_NODE_ARGS[0]).toBe("--require");
    expect(tsxPreflight).toBeGreaterThan(pin);
    const config = JSON.parse(fs.readFileSync(DEV_SERVER_TSCONFIG, "utf8"));
    expect(path.resolve(path.dirname(DEV_SERVER_TSCONFIG), config.extends)).toBe(path.join(PACKAGE_DIR, "tsconfig.json"));
    expect(config.compilerOptions.paths).toEqual({});
  });

  it("the server's own sources never start tsx, so the pinned variable reaches no other tsx", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "__tests__") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.[cm]?ts$/.test(entry.name) && /TSX_TSCONFIG_PATH|["']tsx\/(?:cli|esm|cjs|preflight)|--import["'`,\s]+tsx\b/.test(fs.readFileSync(full, "utf8"))) {
          offenders.push(path.relative(PACKAGE_DIR, full));
        }
      }
    };
    walk(path.join(PACKAGE_DIR, "src"));
    expect(offenders).toEqual([]);
  });
});
