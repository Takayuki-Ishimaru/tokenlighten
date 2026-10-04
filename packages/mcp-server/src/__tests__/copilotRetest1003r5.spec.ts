/**
 * copilotRetest1003r5.spec.ts — Copilot retest r5 (2026-10-03).
 *
 * r5's small task (MAI flash; three source files of three to five lines) cost
 * more with TokenLighten than without. The request bodies of every round said
 * why:
 *
 *  - most of the reported +51% credits was cache luck: the native repeat's
 *    first round hit a 16,000-token cached prefix while both TokenLighten runs
 *    started cold; cold against cold the gap was +12 to +15%;
 *  - TokenLighten's fixed share of every round was ~1,870 tokens (its three
 *    tool schemas about two thirds, the Copilot guide about one third), paid
 *    by a model without `tool_search` on every round of every task — the
 *    tasks that never call TokenLighten included;
 *  - the one run that did call TokenLighten searched (`find`), read the three
 *    hits, then answered: three rounds, the same as grep_search + read_file.
 *
 * So TL_MINIMAL_TOOLS advertises a vscode client only the arguments an
 * ordinary task authors, with shorter descriptions that lead with the
 * one-call query path, and TL_FIND_SMALL_BODIES lets a search whose whole
 * result is a few small files carry their text in the existing
 * `range`/`handle`/`context` fields. Both are TL_TURN_ECONOMY members (on in
 * the VS Code setup), each with its own explicit "0" so the evaluator can
 * compare them one at a time on the same build.
 */
import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { VSCODE_MINIMAL_TOOL_DESCRIPTIONS, VSCODE_TOOL_DESCRIPTIONS } from "../protocol/clientAdvertisement.js";
import { SMALL_FIND_BODY_MAX_FILES, SMALL_FIND_BODY_MAX_LINES } from "../features/search/find/findText.js";
import { startDevServer, type ServerHandle } from "./helpers/qualityFirstScenarios.js";
import { COPILOT_RETRY_FILES } from "./helpers/copilotCheckoutFixture.js";
import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";

type ToolDef = { name: string; description: string; inputSchema: Record<string, unknown> };
type Env = Readonly<Record<string, string | undefined>>;

const VSCODE = "Visual Studio Code";
/** `tl workspace setup`'s VS Code env: the umbrella alone turns TL_LEAN_CALLS and both r5 members on. */
const VSCODE_SETUP_ENV: Env = { TL_TURN_ECONOMY: "1", TL_LEAN_CALLS: undefined, TL_MINIMAL_TOOLS: undefined };
const R4_TIER_ENV: Env = { ...VSCODE_SETUP_ENV, TL_MINIMAL_TOOLS: "0" };

async function toolsFor(clientId: string | undefined, env: Env = VSCODE_SETUP_ENV): Promise<ToolDef[]> {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    const { advertisedTools } = await import("../server.js");
    return structuredClone(advertisedTools(clientId)) as unknown as ToolDef[];
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function at(node: unknown, dotted: string): unknown {
  let cursor: unknown = node;
  for (const segment of dotted.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function tool(tools: readonly ToolDef[], name: string): ToolDef {
  const found = tools.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`${name} not advertised`);
  return found;
}

describe("TL_MINIMAL_TOOLS — the vscode advertisement keeps what an ordinary task authors", () => {
  // Copilot retest r6 (2026-10-03) tightened the tier to what a model writes on
  // its own; the r6 additions are the second group of each list (server.ts
  // MINIMAL_SCHEMA_PROPERTY_PATHS says why each goes, and
  // copilotRetest1003r6.spec.ts checks that a live server still serves them).
  const REMOVED: Readonly<Record<string, readonly string[]>> = {
    tl_read_file: [
      "targets.items.properties.credentialRef",
      "targets.items.properties.lang",
      "targets.items.properties.archive",
      "budget",
      "scope.properties.credentialRef",
      "scope.properties.lang",
      "scope.properties.regex",
      "scope.properties.depth",
      "scope.properties.symbol",
      "scope.properties.archive",
      "scope.properties.kind",
      // r6
      "scope", "qref", "content", "cursor", "cwd",
      "targets.items.properties.ranges", "task.properties.handle", "task.properties.challenge",
    ],
    tl_edit_file: [
      "edits.items.properties.from",
      "edits.items.properties.expectedSha",
      "edits.items.properties.scopeHandle",
      "edits.items.properties.directoryHandle",
      "edits.items.properties.review",
      "edits.items.properties.intent",
      "operation_id",
      "credentials",
      // r6
      "edits.items.properties.allowPathFallback", "task",
    ],
    tl_search_files: [
      "scope.properties.credentialRef",
      "scope.properties.lang",
      "scope.properties.symbol",
      "scope.properties.archive",
      "budget.properties.bytes",
      "budget.properties.tokens",
      // r6
      "budget", "cursor", "cwd", "task", "scope.properties.depth", "scope.properties.kind",
    ],
  };
  const KEPT: Readonly<Record<string, readonly string[]>> = {
    tl_read_file: [
      "query", "select",
      "targets.items.properties.path", "targets.items.properties.handle", "targets.items.properties.range",
      "targets.items.properties.symbol", "task.properties.epoch", "task.properties.profile",
      // r6 review: a directory target's `purpose` (the directory-confined
      // recovery's only input) and the guide's lost-context `force_serve` are
      // written by the model itself, and no reply names either.
      "targets.items.properties.purpose", "task.properties.force_serve",
    ],
    tl_edit_file: [
      "edits.items.properties.path", "edits.items.properties.handle", "edits.items.properties.range",
      "edits.items.properties.search", "edits.items.properties.replace", "edits.items.properties.content",
      "edits.items.properties.create", "edits.items.properties.precondition", "edits.items.properties.target",
      "artifact", "cwd",
    ],
    tl_search_files: [
      "action", "queries", "scope.properties.path", "scope.properties.regex",
    ],
  };

  it("drops each listed argument from the vscode advertisement only, and keeps every argument an ordinary task authors", async () => {
    const minimal = await toolsFor(VSCODE);
    const r4Tier = await toolsFor(VSCODE, R4_TIER_ENV);
    for (const [name, paths] of Object.entries(REMOVED)) {
      for (const dotted of paths) {
        expect(at(tool(minimal, name).inputSchema, `properties.${dotted}`), `${name} minimal ${dotted}`).toBeUndefined();
        expect(at(tool(r4Tier, name).inputSchema, `properties.${dotted}`), `${name} r4 tier ${dotted}`).toBeDefined();
      }
    }
    for (const [name, paths] of Object.entries(KEPT)) {
      for (const dotted of paths) {
        expect(at(tool(minimal, name).inputSchema, `properties.${dotted}`), `${name} ${dotted}`).toBeDefined();
      }
    }
  });

  it("keeps select and artifact reachable as one-line opaque objects naming their keys", async () => {
    const minimal = await toolsFor(VSCODE);
    const read = tool(minimal, "tl_read_file").inputSchema;
    const edit = tool(minimal, "tl_edit_file").inputSchema;
    expect(at(read, "properties.select")).toEqual({ type: "object", description: expect.stringMatching(/sheet.*slides.*pages.*sections/u) });
    expect(at(edit, "properties.artifact")).toEqual({ type: "object", description: expect.stringMatching(/kind.*cells.*replacements.*members/u) });
    expect(at(edit, "properties.edits.items.properties.precondition")).toEqual({ type: "string" });
    expect(at(read, "properties.query.description")).toBe("The user's request, verbatim.");
    // r6: cursor rides limit.next only, and edit's cwd sheds the lean read/search sentence.
    expect(at(read, "properties.cursor")).toBeUndefined();
    expect(at(edit, "properties.cwd")).toEqual({ type: "string" });
  });

  it("swaps in the short descriptions that lead with the one-call path and name no argument they do not advertise", async () => {
    const minimal = await toolsFor(VSCODE);
    for (const name of ["tl_read_file", "tl_edit_file", "tl_search_files"] as const) {
      const description = tool(minimal, name).description;
      expect(description).toBe(VSCODE_MINIMAL_TOOL_DESCRIPTIONS[name]);
      expect(description).not.toMatch(/\b(?:lane|budget|archive|credentialRef|intent|operation_id|expectedSha|qref|cursor)\b/u);
      // r6: the read description names the built-ins it replaces, so it may
      // run longer than the lean one; it stays one short paragraph.
      expect(Buffer.byteLength(description, "utf8"), name).toBeLessThanOrEqual(420);
    }
    const read = VSCODE_MINIMAL_TOOL_DESCRIPTIONS.tl_read_file;
    expect(read).toContain(`{query:"<entire user request, verbatim>",task:{epoch:"new"}}`);
    expect(read).toContain(`profile:"answer"`);
    expect(read).toContain("act.answer = answer now");
    expect(read).toContain("in ONE call");
    expect(VSCODE_MINIMAL_TOOL_DESCRIPTIONS.tl_search_files).toContain("For source questions/tasks use tl_read_file {query} first.");
  });

  it("is at least 3.3 KB smaller than the r4 tier, at most 2.8 KB (the r4 tier was 6,755 B and r5's minimal tier 3,771 B)", async () => {
    const minimal = Buffer.byteLength(JSON.stringify(await toolsFor(VSCODE)), "utf8");
    const r4Tier = Buffer.byteLength(JSON.stringify(await toolsFor(VSCODE, R4_TIER_ENV)), "utf8");
    expect(minimal).toBeLessThanOrEqual(2_800);
    expect(r4Tier - minimal).toBeGreaterThanOrEqual(3_300);
  });

  it("declares no additionalProperties anywhere in the vscode advertisement, on either tier (Copilot validates call input against it)", async () => {
    for (const env of [VSCODE_SETUP_ENV, R4_TIER_ENV]) {
      expect(JSON.stringify(await toolsFor(VSCODE, env))).not.toContain("additionalProperties");
    }
    expect(JSON.stringify(await toolsFor("claude-code"))).toContain("additionalProperties");
  });

  it("changes nothing for any other client, nor for vscode without the lean advertisement it rides on", async () => {
    for (const client of ["claude-code", "codex", undefined]) {
      const forced = await toolsFor(client, { TL_TURN_ECONOMY: undefined, TL_LEAN_CALLS: undefined, TL_MINIMAL_TOOLS: "1" });
      const unset = await toolsFor(client, { TL_TURN_ECONOMY: undefined, TL_LEAN_CALLS: undefined, TL_MINIMAL_TOOLS: undefined });
      expect(JSON.stringify(forced), String(client)).toBe(JSON.stringify(unset));
    }
    const noLean = await toolsFor(VSCODE, { TL_TURN_ECONOMY: "1", TL_LEAN_CALLS: "0", TL_MINIMAL_TOOLS: "1" });
    expect(at(tool(noLean, "tl_read_file").inputSchema, "properties.scope.properties.archive")).toBeDefined();
    expect(tool(noLean, "tl_read_file").description).toBe(VSCODE_TOOL_DESCRIPTIONS.tl_read_file);
    const r4Tier = await toolsFor(VSCODE, R4_TIER_ENV);
    expect(tool(r4Tier, "tl_read_file").description).toBe(VSCODE_TOOL_DESCRIPTIONS.tl_read_file);
  });
});

const HOME = os.homedir();
const dirs: string[] = [];
const servers: ServerHandle[] = [];

afterAll(async () => {
  for (const server of servers) await server.kill();
  for (const dir of dirs) rmDirWithRetry(dir);
});

function workspace(files: Readonly<Record<string, string>>): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, ".tl-cp1003r5-"));
  dirs.push(ws);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), content, "utf8");
  }
  return ws;
}

async function start(ws: string, extraEnv: Readonly<Record<string, string>> = {}): Promise<ServerHandle> {
  const server = startDevServer(ws, "vscode", { toolSurface: "full", extraEnv });
  servers.push(server);
  await server.initialize();
  return server;
}

type FileEntry = { path: string; lines: number[]; snippets?: string[]; range?: string; handle?: string; context?: string; served_this_session?: boolean };

function filesOf(body: Record<string, any>): FileEntry[] {
  expect(body["kind"], JSON.stringify(body).slice(0, 400)).toBe("search.matches");
  return body["matches"]["files"] as FileEntry[];
}

/** The file's own text with its final newline dropped: what `context` carries. */
function wholeText(content: string): string {
  return content.replace(/\r?\n$/u, "");
}

describe("a live vscode server still accepts every argument the minimal advertisement no longer lists", () => {
  it("serves reads and searches that carry them", async () => {
    const server = await start(workspace(COPILOT_RETRY_FILES));
    const read = await server.callTool("tl_read_file", { targets: [{ path: "src/config.ts", lang: "ts" }], budget: { bytes: 6000 } });
    expect(read.body.kind, JSON.stringify(read.body)).toBe("read.text");
    const search = await server.callTool("tl_search_files", { action: "find", queries: ["RETRY_LIMIT"], scope: { path: "src", lang: "ts" }, budget: { bytes: 6000 } });
    expect(search.body.kind, JSON.stringify(search.body)).toBe("search.matches");
  }, 90_000);
});

describe("TL_FIND_SMALL_BODIES — a search whose whole result is a few small files carries their text", () => {
  // r5's exact first TokenLighten call (paired-updated-repeat-small, round 1).
  const r5Call = (ws: string): Record<string, unknown> => ({
    action: "find",
    queries: ["retrySchedule|RETRY"],
    scope: { path: ws, lang: "ts", regex: true },
    task: { epoch: "new", profile: "answer" },
    cwd: ws,
  });

  it("r5's exact search returns all three files whole, with a range handle that reads the same bytes back (not a receipt)", async () => {
    const ws = workspace(COPILOT_RETRY_FILES);
    const server = await start(ws);
    const files = filesOf((await server.callTool("tl_search_files", r5Call(ws))).body);
    expect(files.map((file) => file.path).sort()).toEqual(["src/backoff.ts", "src/config.ts", "src/worker.ts"]);
    for (const file of files) {
      const text = wholeText(COPILOT_RETRY_FILES[file.path]!);
      expect(file.context, file.path).toBe(text);
      expect(file.range, file.path).toBe(`1-${text.split("\n").length}`);
      expect(typeof file.handle, file.path).toBe("string");
      expect(file.lines.length, file.path).toBeGreaterThan(0);
      // r6: the whole text replaces the snippets that would only repeat it.
      expect(file.snippets, file.path).toBeUndefined();
    }
    // Not enrolled in the served-range ledger (like the dominant-edit
    // context): a read of the same file serves its bytes, never a receipt.
    const config = files.find((file) => file.path === "src/config.ts")!;
    const reread = await server.callTool("tl_read_file", { targets: [{ handle: config.handle }] });
    expect(reread.body.kind).not.toBe("read.receipt");
    expect(JSON.stringify(reread.body)).toContain("RETRY_BASE_MS = 125");
  }, 90_000);

  it("the single-query form attaches the same way; TL_FIND_SMALL_BODIES=0 returns the bare locations", async () => {
    const ws = workspace(COPILOT_RETRY_FILES);
    const on = await start(ws);
    // One matched line per file, so no file is a dominant-edit candidate (that
    // older mechanism attaches its own window and is left alone).
    const single = filesOf((await on.callTool("tl_search_files", { action: "find", query: "number" })).body);
    expect(single.map((file) => file.path).sort()).toEqual(["src/backoff.ts", "src/worker.ts"]);
    for (const file of single) expect(file.context, file.path).toBe(wholeText(COPILOT_RETRY_FILES[file.path]!));
    const off = await start(ws, { TL_FIND_SMALL_BODIES: "0" });
    for (const file of filesOf((await off.callTool("tl_search_files", r5Call(ws))).body)) {
      expect(file.context, file.path).toBeUndefined();
      expect(file.handle, file.path).toBeUndefined();
      expect(file.range, file.path).toBeUndefined();
    }
  }, 90_000);

  it(`leaves a bigger result as it was: more than ${SMALL_FIND_BODY_MAX_FILES} files, or a file past ${SMALL_FIND_BODY_MAX_LINES} lines`, async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i <= SMALL_FIND_BODY_MAX_FILES; i += 1) many[`src/m${i}.ts`] = `export const MARKER_${i} = "needleToken";\n`;
    const wide = await start(workspace(many));
    const wideFiles = filesOf((await wide.callTool("tl_search_files", { action: "find", queries: ["needleToken"] })).body);
    expect(wideFiles).toHaveLength(SMALL_FIND_BODY_MAX_FILES + 1);
    for (const file of wideFiles) expect(file.context, file.path).toBeUndefined();

    const long = ["export const RETRY_NOTE = 1;", ...Array.from({ length: SMALL_FIND_BODY_MAX_LINES }, (_, i) => `// filler ${i}`)].join("\n") + "\n";
    const mixed = await start(workspace({ ...COPILOT_RETRY_FILES, "src/long.ts": long }));
    const byPath = new Map(filesOf((await mixed.callTool("tl_search_files", { action: "find", queries: ["RETRY_"] })).body).map((file) => [file.path, file]));
    expect(byPath.get("src/long.ts")?.context).toBeUndefined();
    expect(byPath.get("src/config.ts")?.context).toBe(wholeText(COPILOT_RETRY_FILES["src/config.ts"]!));
  }, 90_000);

  it("re-sends nothing the session already holds, and nothing when the caller declared a budget", async () => {
    const server = await start(workspace(COPILOT_RETRY_FILES));
    await server.callTool("tl_read_file", { targets: [{ path: "src/config.ts" }] });
    const byPath = new Map(filesOf((await server.callTool("tl_search_files", { action: "find", queries: ["RETRY_LIMIT"] })).body).map((file) => [file.path, file]));
    expect(byPath.get("src/config.ts")?.served_this_session).toBe(true);
    expect(byPath.get("src/config.ts")?.context).toBeUndefined();
    expect(byPath.get("src/worker.ts")?.context).toBe(wholeText(COPILOT_RETRY_FILES["src/worker.ts"]!));
    for (const file of filesOf((await server.callTool("tl_search_files", { action: "find", queries: ["attempt"], budget: { bytes: 8000 } })).body)) {
      expect(file.context, file.path).toBeUndefined();
    }
  }, 90_000);
});

// ---------------------------------------------------------------------------
// r5 review (2026-10-03), findings 2-4: the r4 citation-clause test ran only
// in the all-topic pass, its cue words were counted as subjects, and the
// citation words sat in the GLOBAL generic vocabulary. Now the mixed-kind loop
// runs it too, the words a citation clause may spend live in
// CITATION_CLAUSE_WORDS (read only inside a recognized citation clause), and
// a citation clause that also names something unserved is judged on that.
// ---------------------------------------------------------------------------

function requestItemGaps(disclosures: readonly string[]): string[] {
  return disclosures.filter((text) => /request-item-(?:absent|undetermined)/u.test(text));
}

function absentTermsIn(disclosures: readonly string[]): string[] {
  const out = new Set<string>();
  for (const text of disclosures) for (const m of text.matchAll(/request-item-absent:([^\s(]+)/gu)) out.add(m[1]!);
  return [...out];
}

async function askRetry(query: string): Promise<string[]> {
  const ws = workspace(COPILOT_RETRY_FILES);
  const server = await start(ws);
  const { followNextToEnd, collectDisclosureTexts } = await import("./helpers/qualityFirstScenarios.js");
  const chain = await followNextToEnd(server, { tool: "tl_read_file", arguments: { query, task: { epoch: "new", profile: "answer" }, cwd: ws } }, { cwd: ws, hopCap: 6 });
  return collectDisclosureTexts(chain);
}

describe("r5 review — a citation clause beside a real question names no gap, in every pass", () => {
  const CLEAN: readonly string[] = [
    // mixed-kind (an identifier clause + a citation clause)
    "How does backoff() consume RETRY_BASE_MS from config.ts? Cite file names and give code snippets.",
    "How does retrySchedule() use RETRY_LIMIT? Read the relevant files.",
    // coordinated citation verbs in one clause
    "Explain retrySchedule(); cite file names and give code snippets.",
    "Explain retrySchedule(); read the relevant files and include line numbers.",
    // answer-form and reference phrasings
    "Explain retrySchedule(); answer in bullet points.",
    "Explain retrySchedule(); give a concise summary.",
    "Explain retrySchedule(); add line refs.",
    "Explain retrySchedule(); name the files involved.",
    "Explain retrySchedule(); point out the relevant lines.",
    "Explain retrySchedule(); a citation is required.",
  ];
  for (const query of CLEAN) {
    it(query, async () => {
      const disclosures = await askRetry(query);
      expect(requestItemGaps(disclosures), JSON.stringify(disclosures)).toEqual([]);
    }, 90_000);
  }
});

describe("r5 review — recall: a feature named by a citation word is still disclosed absent, and a citation clause is judged on what it names", () => {
  const CASES: ReadonlyArray<readonly [string, string, readonly string[]]> = [
    ["Explain retrySchedule(), and how citations are formatted.", "citations", []],
    ["Explain retrySchedule(), and how evidence is stored.", "evidence", []],
    ["Explain retrySchedule(); list the sources of jitter.", "jitter", ["sources"]],
    ["Explain retrySchedule(); give a brief summary of the refund ledger.", "refund", ["brief", "summary"]],
  ];
  for (const [query, absent, notAbsent] of CASES) {
    it(query, async () => {
      const terms = absentTermsIn(await askRetry(query));
      expect(terms, JSON.stringify(terms)).toContain(absent);
      for (const word of notAbsent) expect(terms, JSON.stringify(terms)).not.toContain(word);
    }, 90_000);
  }
});

// ---------------------------------------------------------------------------
// r5 review (2026-10-03), finding 5: the r4 rename skipped the current
// user-facing docs (the Japanese README, CONTRIBUTING, the MCP tools guide,
// the VS Code extension guide). Release records — past checklist sections,
// past changelog sections, github-release-v*.md — keep the names they shipped
// with and are not listed here.
// ---------------------------------------------------------------------------

describe("r5 review — the current docs name the tools by their tl_ names", () => {
  const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
  const CURRENT_DOCS = [
    "README.md",
    "README.ja.md",
    "CONTRIBUTING.md",
    "release-docs/mcp-tools.md",
    "release-docs/vscode-extension.md",
    "release-docs/vscode-extension.ja.md",
  ];
  for (const rel of CURRENT_DOCS) {
    it(rel, () => {
      const lines = fs.readFileSync(path.join(REPO, rel), "utf8").split("\n");
      const stale = lines
        .map((line, index) => [index + 1, line] as const)
        .filter(([, line]) => /(?<![\w$])(?:read_file|search_files|edit_file)(?![\w$])/u.test(line))
        // A host's OWN tool of that name (Copilot's built-in read_file) keeps it.
        .filter(([, line]) => !/built-in\s+[`'"]?read_file/u.test(line));
      expect(stale.map(([n, line]) => `${rel}:${n}: ${line.slice(0, 120)}`)).toEqual([]);
    });
  }
});
