/**
 * independentReview1010.spec.ts — the 2026-10-10 independent runtime review of
 * v0.15.1 (`TokenLighten_20261010_実行レビュー.md`), new findings.
 *
 * The reviewer drove the v0.15.1 CI VSIX's CLI over stdio. Its two new
 * findings were request-validation defects, each kept here as the reviewer's
 * own call shape plus the variants the fix had to cover:
 *
 *   P1  `tl_edit_file edits:[{path, search, replace, precondition:"expected-sha",
 *       expectedSha:"sha256:000…"}]` — `expected-sha` is not one of the four
 *       advertised preconditions — answered `edit.applied` and wrote the file.
 *       A stale `expectedSha` with the precondition omitted or `unique-match`
 *       was ignored the same way (only `expected-hash` checked it).
 *   P3  `budjet` (for `budget`) was refused `unknown-arguments`, but `keys`
 *       listed internal dispatch names (`path`, `maxRows`, `as`, …) instead of
 *       the advertised top-level fields, with no `did_you_mean`.
 *
 * Re-running the reviewer's calls on the unfixed tree showed the same class
 * more widely: a misspelled member of a canonical carrier
 * (`targets[0].rnage`, `budget.byte`, `task.epcoh`, `scope.pth`) was silently
 * dropped by the canonical→dispatch projection, and no advertised VALUE was
 * checked anywhere (`target:"every"`, `create:"true"`, `replace:20`,
 * `content:"fulll"`, `scope.kind:"symbols"`, `task.pull:"closures"`,
 * `queries:"x"`). All of them now refuse before anything runs.
 */
import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { startDevServer, type ServerHandle } from "./helpers/qualityFirstScenarios.js";
import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { findInvalidValues, nearestAllowedValue } from "../validation/requestShape.js";
import { hasArtifactBuildIntentMarker } from "../features/task-pack/readCodeTaskPack.js";
import { extractFacetRequirements } from "../features/task-pack/requestFacets.js";

const HOME = os.homedir();
const dirs: string[] = [];
const servers: ServerHandle[] = [];

afterAll(async () => {
  for (const server of servers) await server.kill();
  for (const dir of dirs) await rmDirWithRetry(dir);
});

const TINY = "export const LIMIT = 10;\n";
const OTHER = "export const OTHER = 1;\n";

function workspace(files: Readonly<Record<string, string>>): string {
  const base = fs.realpathSync(shortTmpDir(HOME, ".tl-review1010-"));
  dirs.push(base);
  const ws = path.join(base, "workspace");
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), content, "utf8");
  }
  return ws;
}

async function start(ws: string, allowWrite = false): Promise<ServerHandle> {
  const server = startDevServer(ws, "default", { toolSurface: "full", allowWrite });
  servers.push(server);
  await server.initialize();
  return server;
}

const brief = (body: unknown): string => JSON.stringify(body).slice(0, 900);

describe("P1 — an edit never runs past an undefined or unchecked guard", () => {
  let ws: string;
  let server: ServerHandle;
  const read = (rel: string): string => fs.readFileSync(path.join(ws, rel), "utf8");
  const reset = (): void => {
    fs.writeFileSync(path.join(ws, "tiny.ts"), TINY, "utf8");
    fs.writeFileSync(path.join(ws, "other.ts"), OTHER, "utf8");
    if (fs.existsSync(path.join(ws, "fresh.ts"))) fs.rmSync(path.join(ws, "fresh.ts"));
  };
  const edit = async (edits: unknown[]): Promise<any> => {
    reset();
    return (await server.callTool("tl_edit_file", { edits, cwd: ws })).body;
  };

  it("starts a write-enabled server", async () => {
    ws = workspace({ "tiny.ts": TINY, "other.ts": OTHER });
    server = await start(ws, true);
  }, 120000);

  it("refuses the reviewer's out-of-enum precondition before writing, and names the one it meant", async () => {
    const body = await edit([{
      path: "tiny.ts", search: "10", replace: "20",
      precondition: "expected-sha",
      expectedSha: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    }]);
    expect(body.kind, brief(body)).toBe("refusal");
    expect(body.code).toBe("invalid-input");
    expect(body.retry).toBe("call");
    expect(body.field).toBe("edits[0].precondition");
    expect(body.did_you_mean).toBe("expected-hash");
    expect(body.keys).toEqual(["unique-match", "expected-hash", "scope-handle", "references-reviewed"]);
    expect(read("tiny.ts")).toBe(TINY);
  }, 60000);

  it("checks a sent expectedSha whatever the precondition says (omitted, unique-match, expected-hash)", async () => {
    reset();
    const served = (await server.callTool("tl_read_file", { targets: [{ path: "tiny.ts" }], cwd: ws })).body;
    const sha = served?.evidence?.[0]?.sha ?? served?.sha;
    expect(typeof sha, brief(served)).toBe("string");
    for (const precondition of [undefined, "unique-match", "expected-hash"]) {
      const external = "export const LIMIT = 10; // changed outside the session\n";
      fs.writeFileSync(path.join(ws, "tiny.ts"), external, "utf8");
      const item: Record<string, unknown> = { path: "tiny.ts", search: "10", replace: "20", expectedSha: sha };
      if (precondition !== undefined) item["precondition"] = precondition;
      const body = (await server.callTool("tl_edit_file", { edits: [item], cwd: ws })).body;
      expect(body.kind, `${String(precondition)}: ${brief(body)}`).toBe("refusal");
      expect(body.code, `${String(precondition)}: ${brief(body)}`).toBe("hash-mismatch");
      expect(body.field).toBe("expectedSha");
      expect(read("tiny.ts"), String(precondition)).toBe(external);
    }
  }, 60000);

  it("a current expectedSha with no precondition still applies", async () => {
    reset();
    const served = (await server.callTool("tl_read_file", { targets: [{ path: "other.ts" }], content: "full", task: { force_serve: true }, cwd: ws })).body;
    const sha = served?.evidence?.[0]?.sha ?? served?.sha;
    expect(typeof sha, brief(served)).toBe("string");
    const body = (await server.callTool("tl_edit_file", { edits: [{ path: "other.ts", search: "= 1", replace: "= 2", expectedSha: sha }], cwd: ws })).body;
    expect(body.kind, brief(body)).toBe("edit.applied");
    expect(read("other.ts")).toBe("export const OTHER = 2;\n");
  }, 60000);

  it("an empty expectedSha is \"not sent\" unless the precondition is expected-hash", async () => {
    let body = await edit([{ path: "other.ts", search: "= 1", replace: "= 2", precondition: "unique-match", expectedSha: "" }]);
    expect(body.kind, brief(body)).toBe("edit.applied");
    expect(read("other.ts")).toBe("export const OTHER = 2;\n");
    body = await edit([{ path: "other.ts", search: "= 1", replace: "= 2", precondition: "expected-hash", expectedSha: "" }]);
    expect(body.kind, brief(body)).toBe("refusal");
    expect(body.code).toBe("hash-mismatch");
    expect(read("other.ts")).toBe(OTHER);
  }, 60000);

  it("one invalid item refuses the whole batch with nothing written", async () => {
    const body = await edit([
      { path: "other.ts", search: "= 1", replace: "= 2" },
      { path: "tiny.ts", search: "10", replace: "20", precondition: "bogus" },
    ]);
    expect(body.kind, brief(body)).toBe("refusal");
    expect(body.field).toBe("edits[1].precondition");
    expect(read("other.ts")).toBe(OTHER);
    expect(read("tiny.ts")).toBe(TINY);
  }, 60000);

  it("every invalid item of a batch is named in one refusal", async () => {
    const body = await edit([
      { path: "other.ts", search: "= 1", replace: 2 },
      { path: "tiny.ts", search: "10", replace: "20", target: "every" },
    ]);
    expect(body.kind, brief(body)).toBe("refusal");
    expect(body.field).toBe("edits[0].replace");
    expect(body.fields).toEqual(["edits[0].replace", "edits[1].target"]);
    expect(read("other.ts")).toBe(OTHER);
  }, 60000);

  it("values the schema does not allow refuse instead of being ignored or coerced", async () => {
    const cases: Array<[Record<string, unknown>, string, string | undefined]> = [
      [{ path: "tiny.ts", search: "10", replace: "20", target: "every" }, "edits[0].target", undefined],
      [{ path: "tiny.ts", search: "10", replace: 20 }, "edits[0].replace", undefined],
      [{ path: "tiny.ts", search: "10", replace: "20", allowPathFallback: "yes" }, "edits[0].allowPathFallback", undefined],
      [{ path: "fresh.ts", create: "true", content: "x\n" }, "edits[0].create", undefined],
      [{ path: "tiny.ts", intent: { kind: "rename-everything", from: "LIMIT", to: "MAX" } }, "edits[0].intent.kind", undefined],
      [{ path: "tiny.ts", search: "10", replace: "20", precondition: "Unique-Match" }, "edits[0].precondition", "unique-match"],
    ];
    for (const [item, field, suggestion] of cases) {
      const body = await edit([item]);
      expect(body.kind, `${field}: ${brief(body)}`).toBe("refusal");
      expect(body.code, `${field}: ${brief(body)}`).toBe("invalid-input");
      expect(body.field, brief(body)).toBe(field);
      expect(body.retry).toBe("call");
      if (suggestion !== undefined) expect(body.did_you_mean, brief(body)).toBe(suggestion);
      expect(read("tiny.ts"), field).toBe(TINY);
      expect(fs.existsSync(path.join(ws, "fresh.ts")), field).toBe(false);
    }
    const notAnObject = (await server.callTool("tl_edit_file", { edits: ["tiny.ts"], cwd: ws })).body;
    expect(notAnObject.kind, brief(notAnObject)).toBe("refusal");
    expect(notAnObject.field).toBe("edits[0]");
  }, 120000);

  it("a guard's dependent field is required, and a guard that cannot apply is refused", async () => {
    let body = await edit([{ path: "tiny.ts", search: "10", replace: "20", precondition: "scope-handle" }]);
    expect(body.kind, brief(body)).toBe("refusal");
    expect(body.code).toBe("invalid-input");
    expect(body.field).toBe("edits[0].scopeHandle");
    expect(body.retry).toBe("call");

    body = await edit([{ path: "fresh.ts", create: true, content: "x\n", expectedSha: "sha256:000000000000" }]);
    expect(body.kind, brief(body)).toBe("refusal");
    expect(body.field).toBe("edits[0].expectedSha");
    expect(fs.existsSync(path.join(ws, "fresh.ts"))).toBe(false);

    // A scopeHandle without precondition:"scope-handle" is enforced, not ignored.
    body = await edit([{ path: "tiny.ts", search: "10", replace: "20", scopeHandle: "hzzzzzzzzzz" }]);
    expect(body.kind, brief(body)).toBe("refusal");
    expect(body.code).toBe("scope-violation");
    expect(read("tiny.ts")).toBe(TINY);
  }, 60000);

  it("the flat top-level edit shape gets the same value checks (dispatch backstop)", async () => {
    reset();
    const body = (await server.callTool("tl_edit_file", {
      path: "tiny.ts", search: "10", replace: "20", precondition: "expected-sha", cwd: ws,
    })).body;
    expect(body.kind, brief(body)).toBe("refusal");
    expect(body.code).toBe("invalid-input");
    expect(body.field).toBe("precondition");
    expect(body.did_you_mean).toBe("expected-hash");
    expect(read("tiny.ts")).toBe(TINY);
  }, 60000);
});

describe("P3 — refusals name the advertised schema and suggest the field meant", () => {
  let ws: string;
  let server: ServerHandle;

  it("starts a write-enabled server", async () => {
    ws = workspace({ "tiny.ts": TINY, "src/a.ts": "export const A = 1;\n" });
    server = await start(ws, true);
  }, 120000);

  it("a misspelled top-level carrier: public keys and did_you_mean, on all three tools", async () => {
    const readBody = (await server.callTool("tl_read_file", { targets: [{ path: "tiny.ts" }], budjet: { bytes: 2000 } })).body;
    expect(readBody.kind, brief(readBody)).toBe("refusal");
    expect(readBody.code).toBe("unknown-arguments");
    expect(readBody.field).toBe("budjet");
    expect(readBody.did_you_mean).toBe("budget");
    expect(readBody.keys).toEqual(["budget", "content", "cursor", "cwd", "lane", "qref", "query", "scope", "select", "targets", "task"]);

    const searchBody = (await server.callTool("tl_search_files", { action: "find", queries: ["LIMIT"], budjet: { bytes: 2000 } })).body;
    expect(searchBody.kind, brief(searchBody)).toBe("refusal");
    expect(searchBody.did_you_mean).toBe("budget");
    expect(searchBody.keys).toEqual(["action", "budget", "cursor", "cwd", "lane", "queries", "scope", "task"]);

    const editBody = (await server.callTool("tl_edit_file", { edits: [{ path: "tiny.ts", search: "10", replace: "20" }], operationId: "op-1" })).body;
    expect(editBody.kind, brief(editBody)).toBe("refusal");
    expect(editBody.did_you_mean).toBe("operation_id");
    expect(editBody.keys).toEqual(["artifact", "credentials", "cwd", "edits", "lane", "operation_id", "task"]);
    expect(fs.readFileSync(path.join(ws, "tiny.ts"), "utf8")).toBe(TINY);
  }, 60000);

  it("a misspelled member of a carrier is refused, never dropped", async () => {
    const cases: Array<[string, Record<string, unknown>, string, string]> = [
      ["tl_read_file", { targets: [{ path: "tiny.ts", rnage: "1-1" }] }, "targets[0].rnage", "range"],
      ["tl_read_file", { targets: [{ path: "tiny.ts" }], budget: { byte: 100 } }, "budget.byte", "bytes"],
      ["tl_read_file", { targets: [{ path: "tiny.ts" }], select: { comment: "keep" } }, "select.comment", "comments"],
      ["tl_read_file", { query: "what is LIMIT in tiny.ts", task: { epcoh: "new" } }, "task.epcoh", "epoch"],
      ["tl_search_files", { action: "find", queries: ["LIMIT"], scope: { pth: "src" } }, "scope.pth", "path"],
      ["tl_edit_file", { edits: [{ path: "tiny.ts", search: "10", replace: "20" }], task: { proflie: "generic" } }, "task.proflie", "profile"],
      // a member of another carrier names its home
      ["tl_read_file", { targets: [{ path: "tiny.ts", sections: ["A"] }] }, "targets[0].sections", "select.sections"],
    ];
    for (const [tool, args, field, suggestion] of cases) {
      const body = (await server.callTool(tool, args)).body;
      expect(body.kind, `${field}: ${brief(body)}`).toBe("refusal");
      expect(body.code, `${field}: ${brief(body)}`).toBe("unknown-arguments");
      expect(body.field).toBe(field);
      expect(body.did_you_mean, `${field}: ${brief(body)}`).toBe(suggestion);
      if (!suggestion.includes(".")) expect(Array.isArray(body.keys) && body.keys.includes(suggestion), brief(body)).toBe(true);
    }
    expect(fs.readFileSync(path.join(ws, "tiny.ts"), "utf8")).toBe(TINY);
  }, 60000);

  it("an out-of-schema value on a read tool refuses with the allowed values", async () => {
    const cases: Array<[string, Record<string, unknown>, string, string | undefined]> = [
      ["tl_read_file", { targets: [{ path: "tiny.ts" }], content: "fulll" }, "content", "full"],
      ["tl_read_file", { query: "what is LIMIT", scope: { kind: "symbols" } }, "scope.kind", "symbol"],
      ["tl_read_file", { query: "what is LIMIT", task: { pull: "closures" } }, "task.pull", "closure"],
      ["tl_read_file", { targets: [{ path: "tiny.ts", range: 1 }] }, "targets[0].range", undefined],
      ["tl_read_file", { targets: [{ path: "tiny.ts" }], budget: { bytes: "lots" } }, "budget.bytes", undefined],
      ["tl_read_file", { query: "what is LIMIT", task: { force_serve: "true" } }, "task.force_serve", undefined],
      ["tl_search_files", { action: "find", queries: 5 }, "queries", undefined],
      ["tl_search_files", { action: "find", queries: ["LIMIT"], scope: { regex: "maybe" } }, "scope.regex", undefined],
    ];
    for (const [tool, args, field, suggestion] of cases) {
      const body = (await server.callTool(tool, args)).body;
      expect(body.kind, `${field}: ${brief(body)}`).toBe("refusal");
      expect(body.code, `${field}: ${brief(body)}`).toBe("invalid-input");
      expect(body.field).toBe(field);
      expect(body.retry).toBe("call");
      if (suggestion !== undefined) expect(body.did_you_mean, brief(body)).toBe(suggestion);
    }
  }, 60000);

  it("compatibility values and the tolerant wire shapes keep working", async () => {
    for (const args of [
      { action: "find", queries: "LIMIT" },
      { action: "grep", queries: ["LIMIT"] },
      { action: "find", queries: ["LIMIT"], budget: { bytes: "8000" }, scope: { regex: "false" } },
    ]) {
      const body = (await server.callTool("tl_search_files", args)).body;
      expect(body.kind, `${JSON.stringify(args)}: ${brief(body)}`).not.toBe("refusal");
    }
    const unknownAction = (await server.callTool("tl_search_files", { action: "finds", queries: ["LIMIT"] })).body;
    expect(unknownAction.kind, brief(unknownAction)).toBe("refusal");
    expect(unknownAction.field).toBe("action");
    const deferred = (await server.callTool("tl_read_file", { targets: [{ path: "src/a.ts" }], content: "defer" })).body;
    expect(deferred.kind, brief(deferred)).not.toBe("refusal");
    const locate = (await server.callTool("tl_search_files", { action: "locate", queries: ["A"], scope: { path: "src" } })).body;
    expect(locate.kind, brief(locate)).not.toBe("refusal");
    for (const select of [{ sections: ["A"] }, { sections: [3] }, { pages: [1] }, { columns: [2] }]) {
      const body = (await server.callTool("tl_read_file", { targets: [{ path: "src/a.ts" }], select })).body;
      expect(body.code, `${JSON.stringify(select)}: ${brief(body)}`).not.toBe("invalid-input");
    }
  }, 60000);
});

describe("value validation unit (validation/requestShape.ts)", () => {
  it("suggests an allowed value within a length-scaled distance, case-insensitively", () => {
    const preconditions = ["unique-match", "expected-hash", "scope-handle", "references-reviewed"];
    expect(nearestAllowedValue("expected-sha", preconditions)).toBe("expected-hash");
    expect(nearestAllowedValue("UNIQUE-MATCH", preconditions)).toBe("unique-match");
    expect(nearestAllowedValue("whatever", preconditions)).toBeUndefined();
    expect(nearestAllowedValue(3, preconditions)).toBeUndefined();
  });

  it("walks declared shapes only, skips absent/null, honours extra enums and compatibility values", () => {
    const properties = {
      mode: { enum: ["a", "b"] },
      flag: { type: "boolean" },
      items: {
        type: "array",
        items: { properties: { target: { type: "string" }, n: { type: "number" } } },
      },
    };
    expect(findInvalidValues("t", properties, { mode: "a", flag: true, extra: 5, items: [{ target: "all" }] }, {
      extraEnums: { "t.items[].target": ["all"] },
    })).toEqual([]);
    expect(findInvalidValues("t", properties, { mode: null, flag: undefined, items: [{ n: null }] })).toEqual([]);
    expect(findInvalidValues("t", properties, { mode: "legacy" }, { compatibilityValues: { "t.mode": ["legacy"] } })).toEqual([]);
    const violations = findInvalidValues("t", properties, { mode: "c", flag: "true", items: [{ target: "every", n: "1" }, "x"] }, {
      extraEnums: { "t.items[].target": ["all"] },
    });
    expect(violations.map((violation) => violation.field)).toEqual(["mode", "flag", "items[0].target", "items[0].n", "items[1]"]);
  });

  it("accepts the tolerated alternative shapes only where declared", () => {
    const properties = { n: { type: "number" }, b: { type: "boolean" }, q: { type: "array", items: { type: "string" } } };
    const options = {
      alternativeTypes: { "t.n": ["numeric-string"], "t.b": ["boolean-string"], "t.q": ["string"] } as const,
    };
    expect(findInvalidValues("t", properties, { n: " 80 ", b: "False", q: "needle" }, options)).toEqual([]);
    expect(findInvalidValues("t", properties, { n: "8k", b: "maybe", q: 5 }, options).map((v) => v.field)).toEqual(["n", "b", "q"]);
    expect(findInvalidValues("t", properties, { n: "80" }).map((v) => v.field)).toEqual(["n"]);
  });
});

describe("found while replaying — 「表」 inside 表示/表現/代表 is not a table", () => {
  it("a Japanese fix request mentioning the display is no artifact build; a named table still is", () => {
    for (const query of [
      "ログイン画面の表示が崩れる不具合を修正してください。",
      "エラーメッセージの表現を修正してください。",
      "代表ケースのテストを追加してください。",
      "コメント省略後の表示用の行番号を修正してください。",
    ]) {
      expect(hasArtifactBuildIntentMarker(query), query).toBe(false);
    }
    for (const query of [
      "料率表に新しい商品の行を追加してください。",
      "一覧表を作成してください。",
      "スプレッドシートの集計を修正してください。",
    ]) {
      expect(hasArtifactBuildIntentMarker(query), query).toBe(true);
    }
  });

  it("the classification reaches the wire: profile_binding is not artifact_build for the 表示 fix request", async () => {
    const ws = workspace({ "src/login.ts": "export function renderLogin() {\n  return \"<form>\";\n}\n", "docs/rates.md": "# rates\n" });
    const server = await start(ws);
    const body = (await server.callTool("tl_read_file", { query: "ログイン画面の表示が崩れる不具合を修正してください。", task: { epoch: "new" } })).body;
    expect(body.profile_binding?.selected, brief(body)).not.toBe("artifact_build");
  }, 120000);
});

describe("found while integrating — Japanese request words the facet and profile tables misread", () => {
  it("「関数を教えて」 names a function, not a count; a real count question still asks for a value", () => {
    const facets = (query: string): string[] => extractFacetRequirements(query).map((requirement) => requirement.facet);
    expect(facets("http.ts の retry 関数を教えて")).not.toContain("value");
    expect(facets("parseArgs の引数を教えて")).not.toContain("value");
    expect(facets("retry の再試行回数を教えて")).toContain("value");
    expect(facets("登録ユーザー数を教えて")).toContain("value");
  });

  it("「…を示してください」「…を見せてください」 are read-only asks: profile answer, act.answer", async () => {
    const ws = workspace({
      "src/watcher.ts": "const DEBOUNCE_MS = 5000;\nexport class Watcher {\n  delay(): number {\n    return DEBOUNCE_MS;\n  }\n}\n",
    });
    const server = await start(ws);
    for (const query of ["src/watcher.ts の Watcher の待ち時間を示してください。", "src/watcher.ts の Watcher の実装を見せてください。"]) {
      const body = (await server.callTool("tl_read_file", { query, task: { epoch: "new" } })).body;
      expect(body.profile_binding?.selected, `${query}: ${brief(body)}`).toBe("answer");
      expect(body.decision?.kind, `${query}: ${brief(body)}`).toBe("act.answer");
    }
  }, 120000);
});
