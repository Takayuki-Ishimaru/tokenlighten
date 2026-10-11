/**
 * smallTaskLightAnswer.spec.ts — TL_EFF_LIGHT_ANSWER's applicability test
 * (readCodeTaskPack.ts `lightAnswerVerdict`) and the file-local helpers it uses
 * (features/task-pack/lightAnswer.ts), in process.
 *
 * Each condition the verdict documents gets a case that fails exactly that
 * condition and names it in `skip`; the end-to-end agreement with the full
 * pipeline is smallTaskLightAnswerDifferential.spec.ts's job.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { lightAnswerVerdictForTest } from "../features/task-pack/readCodeTaskPack.js";
import {
  LIGHT_ANSWER_MAX_BYTES,
  LIGHT_ANSWER_MAX_LINES,
  lightAnswerDependencyLine,
  lightAnswerHasWholeIdentifier,
  lightAnswerLanguage,
  lightAnswerLineCount,
} from "../features/task-pack/lightAnswer.js";
import type { TaskPackArgs } from "../features/task-pack/model.js";

const MATH = "export const SCALE = 10;\n\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n";

let ws: string;
const savedFlag = process.env["TL_EFF_LIGHT_ANSWER"];

beforeAll(() => {
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-light-unit-")));
  const files: Record<string, string> = {
    "src/math.ts": MATH,
    "src/math.test.ts": "export const CASES = 1;\n",
    "src/withImport.ts": "import { x } from \"./x\";\nexport function run() { return x; }\n",
    "src/big.ts": `export const BIG = "${"x".repeat(LIGHT_ANSWER_MAX_BYTES)}";\n`,
    "src/long.ts": Array.from({ length: LIGHT_ANSWER_MAX_LINES + 5 }, (_, i) => `export const K${i} = ${i};`).join("\n") + "\n",
    "src/notes.md": "# Notes\n",
    "src/dir/inner.ts": "export const INNER = 1;\n",
    // SCALE in another file's code; add only in a comment there.
    "src/caller.ts": "// add() lives in math.ts\nexport const DOUBLE = SCALE * 2;\n",
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), content);
  }
});

afterAll(() => {
  fs.rmSync(ws, { recursive: true, force: true });
});

afterEach(() => {
  if (savedFlag === undefined) delete process.env["TL_EFF_LIGHT_ANSWER"];
  else process.env["TL_EFF_LIGHT_ANSWER"] = savedFlag;
});

async function verdict(args: TaskPackArgs, flag = "1"): Promise<string> {
  process.env["TL_EFF_LIGHT_ANSWER"] = flag;
  const v = await lightAnswerVerdictForTest(args, args.query ?? "", ws);
  return "target" in v ? `target:${v.target.origin}:${v.target.path}` : `skip:${v.skip}`;
}

const fresh = (query: string, extra: Partial<TaskPackArgs> = {}): TaskPackArgs => ({ query, taskEpoch: "new", ...extra });

describe("lightAnswerVerdict — the light path applies", () => {
  it("to a query naming one directory-qualified small file", async () => {
    expect(await verdict(fresh("What does the add function in src/math.ts return?"))).toBe("target:query-named:src/math.ts");
  });

  it("to one targets[] entry the query does not contradict", async () => {
    expect(await verdict(fresh("What value does SCALE hold?", { paths: [{ path: "src/math.ts" }] }))).toBe("target:caller-supplied:src/math.ts");
    expect(await verdict(fresh("What does add in src/math.ts return?", { paths: [{ path: "src/math.ts" }] }))).toBe("target:caller-supplied:src/math.ts");
  });

  it("to a declared answer profile", async () => {
    expect(await verdict(fresh("What does add in src/math.ts return?", { taskProfile: "answer" }))).toBe("target:query-named:src/math.ts");
  });
});

describe("lightAnswerVerdict — every condition sends the request to the full pipeline", () => {
  it("1. flag off", async () => {
    expect(await verdict(fresh("What does add in src/math.ts return?"), "0")).toBe("skip:flag-off");
  });

  it("2. not an answer task, or mutation/defect wording", async () => {
    expect(await verdict(fresh("Change add in src/math.ts to subtract."))).toBe("skip:not-answer");
    expect(await verdict(fresh("What does add in src/math.ts return?", { taskProfile: "generic" }))).toBe("skip:not-answer");
    expect(await verdict(fresh("Why does add in src/math.ts return the wrong value?"))).toMatch(/^skip:(not-answer|defect-wording)$/);
    expect(await verdict(fresh("What does add in src/math.ts return? Then rename it to plus.", { taskProfile: "answer" }))).toBe("skip:mutation-wording");
  });

  it("3. not a fresh plain request", async () => {
    expect(await verdict({ query: "What does add in src/math.ts return?" })).toBe("skip:not-new-epoch");
    expect(await verdict(fresh("What does add in src/math.ts return?", { taskQueryRefReplay: true }))).toBe("skip:continuation");
    expect(await verdict(fresh("What does add in src/math.ts return?", { taskBinding: "task-x" }))).toBe("skip:continuation");
    expect(await verdict(fresh("What does add in src/math.ts return?", { forceServe: true }))).toBe("skip:continuation");
    expect(await verdict(fresh("What does add in src/math.ts return?", { maxBytes: 4000 }))).toBe("skip:request-option");
    expect(await verdict(fresh("What does add in src/math.ts return?", { symbol: "add" }))).toBe("skip:request-option");
  });

  it("4. not exactly one file named", async () => {
    expect(await verdict(fresh("What do add and INNER return?", { paths: [{ path: "src/math.ts" }, { path: "src/dir/inner.ts" }] }))).toBe("skip:target-count");
    expect(await verdict(fresh("What does add return?", { paths: [{ path: "src/math.ts", range: "3-5" }] }))).toBe("skip:target-window");
    expect(await verdict(fresh("Is add in src/math.ts like INNER in src/dir/inner.ts?", { paths: [{ path: "src/math.ts" }], taskProfile: "answer" }))).toBe("skip:query-names-another-path");
    expect(await verdict(fresh("What does add in math.ts return?"))).toBe("skip:bare-basename");
    expect(await verdict(fresh("What does add return?"))).toBe("skip:query-path-count");
    expect(await verdict(fresh("What is in src/math.ts and src/dir/inner.ts?"))).toBe("skip:query-path-count");
  });

  it("5. the file is out of scope", async () => {
    expect(await verdict(fresh("What does src/notes.md say?"))).toBe("skip:language");
    expect(await verdict(fresh("What is CASES in src/math.test.ts?"))).toBe("skip:test-file");
    expect(await verdict(fresh("What does run in src/withImport.ts return?"))).toBe("skip:dependency-line");
    expect(await verdict(fresh("What is BIG in src/big.ts?"))).toBe("skip:over-bytes");
    expect(await verdict(fresh("What is K3 in src/long.ts?"))).toBe("skip:over-lines");
    expect(await verdict(fresh("What does run in src/absent.ts return?"))).toBe("skip:unreadable");
  });

  it("6. more than one concern, a relation, or a name the file does not declare", async () => {
    expect(await verdict(fresh("Which functions call add in src/math.ts?"))).toMatch(/^skip:(relation-facet|structural)$/);
    expect(await verdict(fresh("What does subtract in src/math.ts return?"))).toBe("skip:undeclared:subtract");
    expect(await verdict(fresh("What is MAX_RETRIES in src/math.ts?"))).toBe("skip:undeclared:MAX_RETRIES");
  });

  it("7. a query-named file: a behaviour question, no named subject, or a subject another file's code names", async () => {
    expect(await verdict(fresh("When does add in src/math.ts return a negative number?", { taskProfile: "answer" }))).toBe("skip:behavior-question");
    expect(await verdict(fresh("src/math.ts の add に 1 と 2 を渡すと何が返る？"))).toBe("skip:no-named-subject");
    expect(await verdict(fresh("What is SCALE in src/math.ts?"))).toBe("skip:named-elsewhere:SCALE@src/caller.ts");
    // The same questions with the file as the target take the seeded builder in both arms.
    expect(await verdict(fresh("What is SCALE?", { paths: [{ path: "src/math.ts" }] }))).toBe("target:caller-supplied:src/math.ts");
  });
});

describe("lightAnswer.ts helpers", () => {
  it("maps only the six differential-spec languages", () => {
    expect(lightAnswerLanguage("a/b.ts")).toBe("typescript");
    expect(lightAnswerLanguage("a/b.mjs")).toBe("javascript");
    expect(lightAnswerLanguage("a/b.py")).toBe("python");
    expect(lightAnswerLanguage("a/b.go")).toBe("go");
    expect(lightAnswerLanguage("a/b.rs")).toBe("rust");
    expect(lightAnswerLanguage("a/b.rb")).toBe("ruby");
    expect(lightAnswerLanguage("a/b.d.ts")).toBeUndefined();
    expect(lightAnswerLanguage("a/b.tsx")).toBeUndefined();
    expect(lightAnswerLanguage("a/b.java")).toBeUndefined();
    expect(lightAnswerLanguage("a/b.ipynb")).toBeUndefined();
    expect(lightAnswerLanguage("a/b.pdf")).toBeUndefined();
  });

  it("finds any line that names another module, per language", () => {
    expect(lightAnswerDependencyLine("const a = 1;\nimport x from \"y\";\n", "typescript")).toBe(2);
    expect(lightAnswerDependencyLine("const y = require(\"y\");\n", "javascript")).toBe(1);
    expect(lightAnswerDependencyLine("const y = await import(\"y\");\n", "javascript")).toBe(1);
    expect(lightAnswerDependencyLine("export { a } from \"./a\";\n", "typescript")).toBe(1);
    expect(lightAnswerDependencyLine("export function f() { return 1; }\n", "typescript")).toBeUndefined();
    expect(lightAnswerDependencyLine("x = 1\nfrom os import path\n", "python")).toBe(2);
    expect(lightAnswerDependencyLine("import os\n", "python")).toBe(1);
    expect(lightAnswerDependencyLine("def f():\n    return 1\n", "python")).toBeUndefined();
    expect(lightAnswerDependencyLine("package m\n\nimport \"fmt\"\n", "go")).toBe(3);
    expect(lightAnswerDependencyLine("package m\n\nfunc F() int { return 1 }\n", "go")).toBeUndefined();
    expect(lightAnswerDependencyLine("use std::fmt;\n", "rust")).toBe(1);
    expect(lightAnswerDependencyLine("mod inner;\n", "rust")).toBe(1);
    expect(lightAnswerDependencyLine("pub fn f() -> u32 { crate::config::LIMIT }\n", "rust")).toBe(1);
    expect(lightAnswerDependencyLine("pub fn f() -> u32 { 1 }\n", "rust")).toBeUndefined();
    expect(lightAnswerDependencyLine("require \"json\"\n", "ruby")).toBe(1);
    expect(lightAnswerDependencyLine("class A\n  include Comparable\nend\n", "ruby")).toBe(2);
    expect(lightAnswerDependencyLine("class A\n  def f\n    1\n  end\nend\n", "ruby")).toBeUndefined();
    expect(lightAnswerDependencyLine("anything\n", "cobol")).toBe(1);
  });

  it("counts lines without a phantom final line, and matches whole identifiers only", () => {
    expect(lightAnswerLineCount("")).toBe(0);
    expect(lightAnswerLineCount("a\nb\n")).toBe(2);
    expect(lightAnswerLineCount("a\nb")).toBe(2);
    expect(lightAnswerHasWholeIdentifier("const LIMIT_V2 = 1;", "LIMIT")).toBe(false);
    expect(lightAnswerHasWholeIdentifier("const LIMIT = 1;", "LIMIT")).toBe(true);
    expect(lightAnswerHasWholeIdentifier("const limit = 1;", "LIMIT", true)).toBe(true);
    expect(lightAnswerHasWholeIdentifier("$x + 1", "$x")).toBe(true);
  });
});
