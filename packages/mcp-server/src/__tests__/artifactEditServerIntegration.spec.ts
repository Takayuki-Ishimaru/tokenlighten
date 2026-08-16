import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { prepareOfficeDocument, protectOfficeDocument } from "../office/decrypt.js";

async function excelModule() {
  type Workbook = {
    xlsx: {
      load(data: Buffer): Promise<void>;
      writeBuffer(): Promise<ArrayBuffer | Uint8Array>;
    };
    addWorksheet(name: string): { getCell(ref: string): { value: unknown } };
    getWorksheet(name: string): { getCell(ref: string): { value: unknown } } | undefined;
  };
  type Module = { Workbook: new () => Workbook };
  const imported = await import("exceljs");
  const candidate = imported as unknown as Module & { default?: Module };
  return candidate.Workbook ? candidate : candidate.default!;
}

describe("edit_file encrypted artifact integration", () => {
  let workspace: string;
  let originalArgv: string[];
  let originalRoot: string | undefined;

  beforeAll(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tl-artifact-server-"));
    const ExcelJs = await excelModule();
    const workbook = new ExcelJs.Workbook();
    workbook.addWorksheet("Data").getCell("A1").value = "before";
    const encrypted = await protectOfficeDocument(
      new Uint8Array(await workbook.xlsx.writeBuffer()),
      "input-secret",
    );
    if (!encrypted.ok) throw new Error(encrypted.error);
    fs.writeFileSync(path.join(workspace, "locked.xlsx"), encrypted.bytes);

    originalArgv = [...process.argv];
    originalRoot = process.env["TOKENLIGHTEN_ROOT"];
    process.argv = [...process.argv, "--allow-write"];
    process.env["TOKENLIGHTEN_ROOT"] = workspace;
    process.env["TOKENLIGHTEN_PASSWORD_INPUT_DOCS"] = "input-secret";
    process.env["TOKENLIGHTEN_PASSWORD_OUTPUT_DOCS"] = "output-secret";
    vi.resetModules();
  });

  afterAll(() => {
    process.argv = originalArgv;
    if (originalRoot === undefined) delete process.env["TOKENLIGHTEN_ROOT"];
    else process.env["TOKENLIGHTEN_ROOT"] = originalRoot;
    delete process.env["TOKENLIGHTEN_PASSWORD_INPUT_DOCS"];
    delete process.env["TOKENLIGHTEN_PASSWORD_OUTPUT_DOCS"];
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("resolves both credential refs, edits, verifies, and rotates encryption", async () => {
    const { callTool } = await import("../server.js");
    const result = await callTool("edit_file", {
      path: "locked.xlsx",
      credentialRef: "input-docs",
      outputCredentialRef: "output-docs",
      artifact: {
        kind: "xlsx",
        cells: [{ sheet: "Data", cell: "A1", value: "after" }],
      },
    });
    const body = JSON.parse(result.content[0]!.text) as Record<string, unknown>;

    expect(body).toMatchObject({
      path: "locked.xlsx",
      kind: "edit.applied",
      form: "xlsx",
      changes: 1,
      encrypted: true,
    });
    expect(JSON.stringify(body)).not.toContain("input-secret");
    expect(JSON.stringify(body)).not.toContain("output-secret");

    const prepared = await prepareOfficeDocument(
      fs.readFileSync(path.join(workspace, "locked.xlsx")),
      "output-secret",
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const ExcelJs = await excelModule();
    const verified = new ExcelJs.Workbook();
    await verified.xlsx.load(Buffer.from(prepared.bytes));
    expect(verified.getWorksheet("Data")?.getCell("A1").value).toBe("after");
  });
});
