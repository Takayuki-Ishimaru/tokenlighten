import {afterEach, describe, expect, it} from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {estimateAnswerBody, isExactContiguousBody, preferExactAnswerBody} from "../protocol/answerBodyPolicy.js";
import {applyAnswerLineGutter} from "../protocol/lineGutter.js";
import {protocolCallContext, runWithProtocolCall} from "../protocol/envelope.js";

const previous = process.env["TL_ANSWER_LINE_GUTTER"];
afterEach(() => {if (previous === undefined) delete process.env["TL_ANSWER_LINE_GUTTER"]; else process.env["TL_ANSWER_LINE_GUTTER"] = previous;});
describe("exact answer bodies", () => {
  it("proves literal contiguous lines without treating source text as a gutter", () => {
    const source = "first\r\n123|日本語\r\n  third  \r\n\r\n";
    expect(isExactContiguousBody("123|日本語\n  third  ", source, 2, 3)).toBe(true);
    expect(isExactContiguousBody("\n", source, 4, 4)).toBe(true);
    for (const [body, start, end] of [
      ["first", 1, 3], ["first\n  third  ", 1, 3], ["123|日本語\nthird", 2, 3],
      ["日本語", 2, 2], ["first", 0, 1], ["", 5, 5], ["first", 1.5, 2],
    ] as const) expect(isExactContiguousBody(body, source, start, end)).toBe(false);
  });
  it("keeps explicit overrides and other hosts, and estimates the actual gutter byte difference", () => {
    delete process.env["TL_ANSWER_LINE_GUTTER"];
    const lines = ["public void 実行() {", "  payment();", "}"];
    const plain = estimateAnswerBody(lines, 200, "copilot-cli");
    expect(plain).toBe(lines.join("\n"));
    const numbered = estimateAnswerBody(lines, 200, "claude-code");
    expect(Buffer.byteLength(JSON.stringify(numbered)) - Buffer.byteLength(JSON.stringify(plain))).toBe(12);
    for (const value of ["1", "0"]) {
      process.env["TL_ANSWER_LINE_GUTTER"] = value;
      expect(preferExactAnswerBody("copilot-cli")).toBe(false);
    }
  });
  it("leaves only a proven exact range plain in the actual renderer", () => {
    delete process.env["TL_ANSWER_LINE_GUTTER"];
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tl-exact-body-"));
    try {
      fs.writeFileSync(path.join(root, "a.ts"), "const a = 1;\nconst b = 2;\n");
      const render = (body: string, range = "1-2") => {
        const row = {path: "a.ts", range, body};
        const payload = {profile: "answer", evidence: [row]};
        expect(applyAnswerLineGutter(payload, "read.task_pack", {workspace: root, clientId: "copilot-cli"})).toBe(payload);
        return row.body;
      };
      expect(render("const a = 1;\nconst b = 2;")).toBe("const a = 1;\nconst b = 2;");
      expect(render("const a = 1;")).toBe("1|const a = 1;");
      process.env["TL_ANSWER_LINE_GUTTER"] = "1";
      expect(render("const a = 1;\nconst b = 2;")).toBe("1|const a = 1;\n2|const b = 2;");
    } finally {fs.rmSync(root, {recursive: true, force: true});}
  });
  it("keeps concurrent client policy isolated through async dispatch", async () => {
    delete process.env["TL_ANSWER_LINE_GUTTER"];
    const values = await Promise.all(["copilot-cli", "claude-code"].map(clientId =>
      runWithProtocolCall({tool: "tl_read_file", clientId}, async () => {
        await Promise.resolve();
        return estimateAnswerBody(["return 1;"], 10, protocolCallContext()?.clientId);
      })));
    expect(values).toEqual(["return 1;", "10|return 1;"]);
  });
});
