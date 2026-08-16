import { describe, expect, it } from "vitest";
import {
  isProtocolSymbolSearchToken,
  selectQueryEvidence,
} from "../tools/queryEvidence.js";

describe("query evidence selection", () => {
  it("keeps MCP protocol literals out of generic symbol lookup", () => {
    expect(isProtocolSymbolSearchToken("read_file")).toBe(true);
    expect(isProtocolSymbolSearchToken("execution_contract")).toBe(false);
    expect(isProtocolSymbolSearchToken("readFile")).toBe(false);
    expect(isProtocolSymbolSearchToken("buildTaskExecutionContract")).toBe(false);
  });

  it("prefers a late regression block over a generic readFile helper", () => {
    const filler = Array.from({ length: 180 }, (_, index) => `const filler${index} = ${index};`).join("\n");
    const content = [
      "function readFile(path: string): string { return path; }",
      filler,
      "describe('task execution contract', () => {",
      "  it('keeps the structured next call answer-ready', () => {",
      "    const result = { execution_contract: { readiness: 'answer-ready', next_call: undefined } };",
      "    expect(result.execution_contract.readiness).toBe('answer-ready');",
      "  });",
      "});",
    ].join("\n");

    const evidence = selectQueryEvidence(
      content,
      "trace how read_file task_pack builds execution_contract readiness and structured next_call; identify the exact regression tests",
      { path: "src/__tests__/readCodeTaskPack.spec.ts" },
    );

    expect(evidence?.kind).toBe("test-block");
    expect(evidence?.line).toBeGreaterThan(150);
    expect(evidence?.content).toContain("result.execution_contract");
    expect(evidence?.content).not.toContain("function readFile");
  });

  it("selects a late JSON metric instead of the environment prefix", () => {
    const prefix = Array.from({ length: 220 }, (_, index) =>
      `    "environment_${index}": "value-${index}",`
    ).join("\n");
    const content = [
      "{",
      '  "environment": {',
      prefix,
      '    "done": true',
      "  },",
      '  "billing": {',
      '    "arm_breakdown": {',
      '      "comparison": {',
      '        "ratio_a_over_b": 0.86804,',
      '        "total_tokens_ratio_a_over_b": 0.773837',
      "      }",
      "    }",
      "  }",
      "}",
    ].join("\n");

    const evidence = selectQueryEvidence(
      content,
      "report the paired billing cost ratio A over B",
      { path: "result.json" },
    );

    expect(evidence?.kind).toBe("json-key");
    expect(evidence?.line).toBeGreaterThan(200);
    expect(evidence?.content).toContain('"ratio_a_over_b": 0.86804');
    expect(evidence?.content).not.toContain('"environment_0"');
  });

  it("refuses a test-focused answer when no test or assertion block matches", () => {
    const evidence = selectQueryEvidence(
      "function readFile(path: string): string { return path; }\n",
      "find the exact read_file regression test",
      { path: "helpers.ts" },
    );
    expect(evidence).toBeUndefined();
  });
});
