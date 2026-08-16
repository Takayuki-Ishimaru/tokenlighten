/**
 * next_call progress guarantees (2026-07-31 defect wave).
 *
 * Every follow-up a pack names must be able to CHANGE what the caller knows.
 * Two families of violation were found live and are pinned here:
 *
 *   1. Type confusion — `TaskPackResult.missing` is consumed downstream as a
 *      list of surface ROLE names, but the seeded path also files unresolvable
 *      caller inputs (nonexistent paths, unexpanded directories) into it. Those
 *      strings reached `nextHintForCoverage`'s missing-roles branch and came
 *      back out as `surfaceRoles=["packages/cli/ (directory — pass cwd=…)"]`:
 *      a filter no pack can ever satisfy, so `missing` never shrank and the
 *      caller re-issued the identical call forever.
 *
 *   2. No-op reads — a follow-up that re-reads bytes the SAME response already
 *      served. The complete/focused and candidate-list branches each grew their
 *      own guard against this; the catch-all had not.
 *
 * The first test is the verbatim call shape that produced the live self-loop.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { callTool } from "../server.js";
import { buildTaskPack } from "../tools/readCodeTaskPack.js";
import { resetRootResolverCache, setActiveRootWorkspace } from "../tools/locateTaskContext.js";
import { nextStringToCall, callToNextString, type ContinuationCall } from "../util/continuation.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const tmpDirs: string[] = [];

function mkDir(tag: string): string {
  const dir = fs.mkdtempSync(path.join(HOME, `.tl-nextcall-${tag}-`));
  tmpDirs.push(dir);
  return dir;
}
function writeFile(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

/** Pull every surfaceRoles entry out of whatever follow-up the pack named. */
function surfaceRolesNamed(next: string | undefined): string[] {
  if (next === undefined) return [];
  const call = nextStringToCall(next);
  const roles = call?.arguments["surfaceRoles"];
  return Array.isArray(roles) ? roles.map(String) : [];
}

// ---------------------------------------------------------------------------
// Family 1 — a path never becomes a role
// ---------------------------------------------------------------------------

describe("next_call progress — unresolvable caller inputs stay out of role filters", () => {
  it("an unexpanded directory is never re-served as a surfaceRoles filter", async () => {
    const ws = mkDir("dir-not-a-role");
    // Two directories that exist but contribute nothing, plus one real file so
    // the pack still has a surface to headline.
    fs.mkdirSync(path.join(ws, "packages/cli"), { recursive: true });
    fs.mkdirSync(path.join(ws, "packages/agents-md"), { recursive: true });
    writeFile(ws, "package.json", JSON.stringify({ name: "fixture" }, null, 2));

    const result = await buildTaskPack(
      {
        query: "add a retry option to the cli and expose it from the agents guide",
        paths: ["packages/cli", "packages/agents-md", "package.json"],
      },
      ws,
    );

    // The scenario is live: both directories were unusable.
    const dirMarkers = result.missing.filter((m) => m.endsWith("(directory)"));
    expect(dirMarkers).toHaveLength(2);

    // ...and none of them leaked into a role-shaped follow-up. A role is a
    // short taxonomy word (contract/api/domain/test/...), never a path.
    for (const role of surfaceRolesNamed(result.next)) {
      expect(role).not.toContain("/");
      expect(role).not.toContain("(directory");
    }
    // The route must not claim a PATH is a missing required SURFACE either.
    expect(result.route?.reason ?? "").not.toMatch(/missing required surface\(s\):[^;]*\//);
  }, 30000);

  it("names the path-scoped re-seed that actually closes a directory gap", async () => {
    const ws = mkDir("dir-remedy");
    fs.mkdirSync(path.join(ws, "packages/desktop-app"), { recursive: true });
    writeFile(ws, "package.json", JSON.stringify({ name: "fixture" }, null, 2));

    const result = await buildTaskPack(
      { query: "add a settings pane to the desktop app", paths: ["packages/desktop-app", "package.json"] },
      ws,
    );

    expect(result.missing.some((m) => m.startsWith("packages/desktop-app/ (directory"))).toBe(true);
    // A role filter cannot close a PATH gap. 2026-08-01 (D1): the remedy is an
    // INVENTORY step on the unusable dir — the old path-scoped re-seed
    // degenerated into an identity re-call whenever the invocation WAS
    // query+that dir, and an obedient caller looped on it.
    expect(result.next).toBe("search_files action=tree path=packages/desktop-app");
    // And it must survive the string<->call encoding, or the execution contract
    // silently drops the one follow-up that would have worked.
    const call = nextStringToCall(result.next!);
    expect(call?.tool).toBe("search_files");
    expect(call?.arguments["action"]).toBe("tree");
    expect(call?.arguments["path"]).toBe("packages/desktop-app");
  }, 30000);

  it("round-trips the path-scoped re-seed form through the continuation encoding", () => {
    const next = 'read_file mode=task_pack query="add retry" paths=["packages/cli","packages/usage"]';
    const call = nextStringToCall(next);
    expect(call).toEqual({
      tool: "read_file",
      arguments: { mode: "task_pack", query: "add retry", paths: ["packages/cli", "packages/usage"] },
    });
    expect(callToNextString(call!)).toBe(next);
  });
});

// ---------------------------------------------------------------------------
// Family 3 — the legacy `next` encoding never hands back a DIFFERENT target
// ---------------------------------------------------------------------------

describe("next_call progress — list-item escaping in the legacy next encoding", () => {
  it("escapes a double quote inside a path instead of silently truncating it", () => {
    const call: ContinuationCall = {
      tool: "read_file",
      arguments: { mode: "task_pack", query: "q", paths: ['packages/a"b'] },
    };
    const next = callToNextString(call);
    expect(next).toBeDefined();
    // The old encoding emitted paths=["packages/a"b"], which parsed back as
    // ["packages/a"] — a shorter path that may itself exist. The follow-up then
    // reads the wrong file and reports success, which is strictly worse than
    // dropping the hint.
    expect(nextStringToCall(next!)).toEqual(call);
  });

  it("round-trips a path containing a comma or a backslash", () => {
    for (const p of ["packages/a,b", "packages\\a"]) {
      const call: ContinuationCall = {
        tool: "read_file",
        arguments: { mode: "task_pack", query: "q", paths: [p] },
      };
      expect(nextStringToCall(callToNextString(call)!)).toEqual(call);
    }
  });

  it("leaves the emitted form byte-identical for ordinary items", () => {
    // The escaping change must be invisible on every shape the packs actually
    // emit today, or it silently rewrites the agent-facing `next` wording.
    expect(callToNextString({ tool: "read_file", arguments: { handles: ["h1", "h2"] } }))
      .toBe('read_file handles=["h1","h2"]');
    expect(callToNextString({
      tool: "read_file",
      arguments: { mode: "task_pack", query: "add retry", surfaceRoles: ["api", "domain"] },
    })).toBe('read_file mode=task_pack query="add retry" surfaceRoles=["api","domain"]');
  });

  it("a double quote inside the QUERY already round-trips — the greedy match covers it", () => {
    // Documented so the next reader does not "fix" the query encoding too: the
    // capture is greedy and anchored on the trailing form, so quotes inside the
    // query survive. Only list ITEMS needed escaping.
    for (const call of [
      { tool: "search_files", arguments: { action: "locate", query: 'why is "foo" null' } },
      { tool: "read_file", arguments: { mode: "task_pack", query: 'add "retry"', surfaceRoles: ["api"] } },
    ] as ContinuationCall[]) {
      expect(nextStringToCall(callToNextString(call)!)).toEqual(call);
    }
  });
});

// ---------------------------------------------------------------------------
// Family 2 — no follow-up re-reads what the response already served
// ---------------------------------------------------------------------------

describe("next_call progress — no follow-up re-reads served bytes", () => {
  it("does not tell the caller to re-slice a surface whose whole body is embedded", async () => {
    const ws = mkDir("no-reread");
    // One small, fully-embeddable file: the pack serves all of it inline.
    writeFile(ws, "package.json", JSON.stringify({ name: "fixture", version: "0.1.0" }, null, 2));

    const result = await buildTaskPack(
      { query: "bump the package version", paths: ["package.json"] },
      ws,
    );

    const served = new Map(result.surfaces.map((s) => [s.handle, s]));
    const call = result.next ? nextStringToCall(result.next) : undefined;
    const handle = call?.arguments["handle"];
    if (typeof handle === "string" && call?.arguments["range"] === undefined) {
      // A rangeless re-slice of an already-embedded handle returns the identical
      // window — the caller learns nothing and the turn is pure waste.
      const target = served.get(handle);
      expect(target?.code, `next re-slices already-served handle ${handle}`).toBeUndefined();
    }
  }, 30000);
});

// ---------------------------------------------------------------------------
// The verbatim live regression — exact call shape from 2026-07-31
// ---------------------------------------------------------------------------

describe("next_call progress — 2026-07-31 self-loop regression (exact call shape)", () => {
  it("a multi-directory seeded pack over this repo emits no path-shaped or route-contradicting follow-up", async () => {
    resetRootResolverCache();
    const workspace = path.resolve(__dirname, "../../../../");
    setActiveRootWorkspace(workspace);

    const response = await callTool("read_file", {
      cwd: workspace,
      mode: "task_pack",
      taskEpoch: "new",
      taskProfile: "generic",
      query: "実装を開始します。まず現行のVS Code拡張、CLI、ルール生成、MCP起動、共有型を一つの"
        + "タスクパックで確認し、既存構造に沿った最小の縦切り（セットアップ、全機能有効、"
        + "プライバシー安全ログ、VS Code／デスクトップ共通export）から組み上げます。",
      paths: [
        "packages/vscode-extension",
        "packages/cli",
        "packages/agents-md",
        "packages/types/src",
        "packages/mcp-server",
        "package.json",
      ],
    });
    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    const result = JSON.parse(text) as Record<string, any>;

    // 1. No role filter may name a path (the self-loop).
    const nextCall = result["execution_contract"]?.["next_call"];
    const roles = nextCall?.["arguments"]?.["surfaceRoles"];
    if (Array.isArray(roles)) {
      for (const role of roles) {
        expect(String(role)).not.toContain("/");
        expect(String(role)).not.toContain("(directory");
      }
    }
    expect(String(result["route"]?.["reason"] ?? ""))
      .not.toMatch(/missing required surface\(s\):[^;]*\//);

    // 2. A route that closed discovery must not ship a discovery next_call.
    if (result["route"]?.["action"] === "answer_from_handles"
      && (result["route"]?.["max_additional_tl_calls"] ?? 0) === 0) {
      expect(nextCall).toBeUndefined();
    }

    // 3. A locate follow-up keeps a usable query — never a single CJK function
    //    word. The live defect emitted `search_files action=locate query="こんな"`
    //    because the term list was consumed positionally and hiragana runs sort
    //    first in a Japanese sentence.
    if (nextCall?.["tool"] === "search_files" && nextCall?.["arguments"]?.["action"] === "locate") {
      const q = String(nextCall["arguments"]["query"] ?? "");
      expect(q.length).toBeGreaterThan(4);
      expect(q).not.toMatch(/^[\p{Script=Hiragana}ー]+$/u);
    }

    // 4. Whatever it named, a rangeless re-slice must not target served bytes.
    const surfaces = (result["surfaces"] ?? []) as Array<Record<string, unknown>>;
    const servedHandles = new Set(
      surfaces.filter((s) => s["code"] !== undefined).map((s) => String(s["handle"])),
    );
    if (nextCall?.["tool"] === "read_file"
      && typeof nextCall["arguments"]?.["handle"] === "string"
      && nextCall["arguments"]["range"] === undefined
      && nextCall["arguments"]["mode"] === "slice") {
      expect(servedHandles.has(String(nextCall["arguments"]["handle"]))).toBe(false);
    }
  }, 60000);
});
