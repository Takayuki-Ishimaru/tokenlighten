/**
 * evaluation0927.smallFileScopeViewLabel.spec.ts — §6.1 (source vs derived)
 * residual found by the orchestrator in round 4 (2026-09-28): Trim A
 * (getSymbolWithContext.ts, files under 2 KiB) dropped the
 * `// tokenlighten:scope …` header on the premise that "the body stands
 * alone", but a METHOD's view still carried the enclosing-scope line and the
 * sibling signatures. A `tl_read_file {targets:[{path, symbol}]}` batch entry then
 * shipped `form:"handle"`, `range:"25-30"` over ~20 assembled lines with no
 * label at all — neither verbatim source of the range nor marked as derived.
 *
 * Trim A now applies only when the view IS the body alone; any assembled view
 * keeps the header that labels it (envelope.ts `_isSyntheticRendering`).
 */
import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { getSymbolWithContext } from "../tools/getSymbolWithContext.js";
import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { startDevServer, type ServerHandle } from "./helpers/qualityFirstScenarios.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const tmpDirs: string[] = [];
const servers: ServerHandle[] = [];

afterAll(async () => {
  for (const server of servers.splice(0)) await server.kill();
  for (const dir of tmpDirs.splice(0)) {
    try {
      await rmDirWithRetry(dir);
    } catch {
      /* best-effort cleanup */
    }
  }
});

const SMALL_CLASS = [
  "export class OrderFlow {",
  "  private readonly log: string[] = [];",
  "",
  "  paymentStep0(orderId: string): void {",
  "    this.log.push(\"pay0:\" + orderId);",
  "  }",
  "",
  "  paymentStep1(orderId: string): void {",
  "    this.log.push(\"pay1:\" + orderId);",
  "  }",
  "}",
  "",
].join("\n");

describe("Trim A keeps the label on an assembled view", () => {
  it("a method in a small file: the view starts with the scope header and marks the target", async () => {
    expect(Buffer.byteLength(SMALL_CLASS, "utf8")).toBeLessThan(2048);
    const result = await getSymbolWithContext(SMALL_CLASS, { path: "src/OrderFlow.ts", symbol: "paymentStep1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.code.split("\n")[0]).toBe("// tokenlighten:scope path=src/OrderFlow.ts symbol=paymentStep1 lang=typescript");
    expect(result.data.code).toContain("// target:");
    expect(result.data.code).toContain("this.log.push(\"pay1:\" + orderId);");
  });

  it("a function that uses an import in a small file: labelled too", async () => {
    const src = "import { join } from \"path\";\n\nexport function where(dir: string): string {\n  return join(dir, \"x\");\n}\n";
    const result = await getSymbolWithContext(src, { path: "src/where.ts", symbol: "where" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.code.split("\n")[0]).toContain("tokenlighten:scope");
  });

  it("a bare function in a small file: still the body alone (Trim A unchanged)", async () => {
    const src = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";
    const result = await getSymbolWithContext(src, { path: "src/add.ts", symbol: "add" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.code).toBe("export function add(a: number, b: number): number {\n  return a + b;\n}");
  });
});

describe("a symbol batch entry over a small file is labelled on the wire", () => {
  it("tl_read_file {targets:[{path, symbol}]}: the entry content opens with the scope sentinel", async () => {
    const ws = fs.realpathSync(shortTmpDir(HOME, ".tl-scopelabel-"));
    tmpDirs.push(ws);
    fs.mkdirSync(path.join(ws, "src"), { recursive: true });
    fs.writeFileSync(path.join(ws, "package.json"), "{\"name\":\"sl\",\"private\":true,\"type\":\"module\"}\n");
    fs.writeFileSync(path.join(ws, "src/OrderFlow.ts"), SMALL_CLASS);
    const s = startDevServer(ws, "default");
    servers.push(s);
    await s.initialize();
    const body = (await s.callTool("tl_read_file", {
      targets: [{ path: "src/OrderFlow.ts", symbol: "paymentStep0" }, { path: "src/OrderFlow.ts", symbol: "paymentStep1" }],
      cwd: ws,
    })).body;
    expect(body.kind).toBe("read.batch");
    for (const entry of body.entries) {
      expect(typeof entry.content).toBe("string");
      expect(entry.content.split("\n")[0], JSON.stringify(entry)).toContain("tokenlighten:scope");
    }
  });
});
